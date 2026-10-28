'use strict';
// The desk's adapter to the trader, cr-trader-desk@1 (blueprint slot 12a,
// Eric 2026-10-28; audits/2026-10-28-approve-wiring/PLAN.md, approved). The
// one module that calls the trader's Paper Book (core/paper-trader.js,
// cr-paper@2); trader-boundary.test.js holds it to that.
//
// Eric's Approve or Halve on a ticket becomes one cr.trade-intent.v3 order in
// that book, and his Undo cancels what has not filled and closes what has.
// The book's venue is simulated: nothing here places a real order, moves
// money, connects an account or an exchange, holds a key or reaches a
// network, and nothing enters Portfolio or the PM Paper Book (cr-paper@1, which keeps
// running beside it unchanged). The model never picks an amount: the risk is
// Eric's decision, and the engine's hard limits (cr-trade-risk@2) bound it.
//
// What opens (the plan's Decision 2):
//   - only a decision recorded with effects.trader 'open' (an approve or a
//     halve recorded since slot 12a; earlier decisions open nothing), while
//     it is the decision in force, on a ticket whose desk proposal is
//     ACCUMULATE or LIMIT_TRAP and whose receipt checks out;
//   - entry: the lower of the book's price and the entry zone's high
//     (ACCUMULATE) or low (LIMIT_TRAP), so a buy never goes through the
//     market; stop: the invalidation price; target: the upside target; risk:
//     Eric's approved amount; life: his longest life of an intent; pair: the
//     project's ticker against USDC, refused while another unarchived project
//     shares the ticker. A missing field opens nothing, said in words; a stop
//     is never invented, so a metric-only invalidation opens nothing;
//   - one attempt per decision: its intent ID is derived from the decision,
//     so the book's answer, an order or a refusal with its reasons, is final.
//     The book is asked only once it can answer (funded, Eric's rules and fee
//     set, a fresh hour and a 14-hour ATR for the pair, no unresolved order);
//     until then the request waits, with the reason in words. Once the
//     ticket's exit readings give no size (D11: past their 72 hours, or none
//     within the limit), it never opens.
// What closes: the undo of that decision, the end of the ticket's research
// horizon, or the ticket's metric invalidation as the desk reads it
// (tickets.js invalidationOf). What has not filled is cancelled; an open
// position gets a sell limit SLIPPAGE_BPS under the book's price, asked again
// as a new intent when one ends unfilled, at most CLOSE_ATTEMPTS_MAX times.
// The stop and the target stay the book's own.
//
// Everything is re-derived on each call from Eric's decisions and the book's
// journal: no record of its own, nothing kept in memory. A step that failed
// half way completes on the next one, and the same step twice asks nothing
// twice. Reads (requests, wanted) write nothing.

const PT = require('./paper-trader');
const { exact: { dec, str, isoMs }, INTENT_VERSION, SLIPPAGE_BPS_MAX, RESOLVED } = require('./trade-risk');
const TR = require('./trader-rules');
const { OpError } = require('./ops');
const { sha256 } = require('./fsx');

const VERSION = 'cr-trader-desk@1';
const OPENS = Object.freeze(['ACCUMULATE', 'LIMIT_TRAP']);
const QUOTE = 'USDC';
// The simulated venue's lot and minimum order (the plan's smaller choices),
// fixed here and frozen with every order; its fee is Eric's (trader.book).
const LOT = '0.000001';
const MIN_NOTIONAL_USD = '10';
// A close is a sell limit this far under the book's price: the engine's own
// limit, so it is never refused as through the market.
const SLIPPAGE_BPS = SLIPPAGE_BPS_MAX;
const CLOSE_ATTEMPTS_MAX = 24;
const LIVE = Object.freeze(['RESERVED', 'SENT', 'ACKED', 'PARTIAL', 'UNKNOWN']);
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MIN = 60000;
const BPS = 10000n;

const iso = (ms) => new Date(ms).toISOString();
function nowOf(now) {
  const s = now === undefined ? new Date().toISOString() : now;
  const ms = isoMs(s);
  if (ms === null) throw new OpError('INVALID', 'now is not an ISO-8601 UTC time.');
  return { now: s, t: Number(ms) };
}
const usd = (s) => `$${Number(s).toLocaleString('en-US', { maximumFractionDigits: 6 })}`;

// A ULID made from the decision: its time part the decision's, its random
// part the SHA-256 of the decision ID and the step's purpose ('open',
// 'close-1', ...). The same decision and purpose give the same ID, so the
// book is never asked twice for the same thing.
function intentIdOf(d, purpose) {
  const ms = Date.parse(d.decided_at);
  let t = BigInt(Number.isFinite(ms) && ms >= 0 ? ms : 0);
  let r = BigInt(`0x${sha256(`${VERSION}|${d.decision_id}|${purpose}`).slice(0, 20)}`);
  let out = '';
  for (let i = 0; i < 16; i++) { out = CROCKFORD[Number(r % 32n)] + out; r /= 32n; }
  for (let i = 0; i < 10; i++) { out = CROCKFORD[Number(t % 32n)] + out; t /= 32n; }
  return out;
}

// A stored number (the ticket's prices, the decision's amount) as a plain
// decimal string above 0, else null: never through an exponent or a float's
// tail (0.1 stays 0.1).
function plain(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  let s = String(n);
  const m = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (m) {
    const digits = `${m[1]}${m[2] || ''}`;
    const point = m[1].length + Number(m[3]);
    s = point <= 0 ? `0.${'0'.repeat(-point)}${digits}` : point >= digits.length ? `${digits}${'0'.repeat(point - digits.length)}` : `${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  const v = dec(s);
  return v === null || v === 0n ? null : str(v);
}
const lowerOf = (a, b) => (dec(a) < dec(b) ? a : b);
// A sell limit SLIPPAGE_BPS under `price`, raised to the 18th place, so it is
// never further under the price than the engine allows.
const closeLimit = (price) => str((dec(price) * (BPS - BigInt(SLIPPAGE_BPS)) + BPS - 1n) / BPS);

// Eric's settings: the engine's rules (trader.rules and the desk's price
// freshness), and the book's funding and venue fee (trader.book).
function settingsOf(ws) {
  const r = TR.rulesOf(ws);
  const b = TR.bookOf(ws);
  const waits = [];
  if (r.unset.length) waits.push(`Your trader rules are not all set (${r.unset.join(', ')}); set them in Preferences > Screening.`);
  if (b.unset.includes('cash_usd')) waits.push('The trader\'s Paper Book is not funded; set its funding in Preferences.');
  if (b.unset.includes('fee_rate')) waits.push('The venue fee is not set, and an unknown fee is never read as 0; set it in Preferences.');
  const venue = { lot: LOT, min_notional_usd: MIN_NOTIONAL_USD, maker_rate: b.book.fee_rate, taker_rate: b.book.fee_rate };
  return { rules: r.rules, book: b.book, venue, waits };
}

// The ticket receipt a decision is on, or the reason it cannot be used.
function receiptOf(ws, pid, rid) {
  const rel = `projects/${pid}/tickets/receipts/${rid}.json`;
  let r = null;
  try { r = JSON.parse(require('fs').readFileSync(ws.abs(rel), 'utf8')); } catch (_) { return { why: `Ticket receipt ${rid} could not be read.` }; }
  if (!r || r.receipt_id !== rid || r.project_id !== pid) return { why: `Ticket receipt ${rid} is not a receipt on ${pid}.` };
  let integ = null;
  try { integ = require('./tickets').integrityOf(ws, r); } catch (err) { integ = { status: 'unverified', words: String(err && err.message || err).slice(0, 200) }; }
  if (integ && integ.status !== 'ok') return { why: `Ticket receipt ${rid} does not check out against its frozen packet: ${integ.words}` };
  return { receipt: r };
}

// The pair a project trades as in the book: its ticker against USDC.
function pairOf(project, projects) {
  const sym = typeof project.symbol === 'string' ? project.symbol.trim().toUpperCase() : '';
  const name = project.name || project.project_id;
  if (!/^[A-Z0-9.]{1,24}$/.test(sym)) return { pair: null, why: `${name} has no ticker the book can name a pair with.` };
  const twin = projects.find((q) => q.project_id !== project.project_id && q.status !== 'archived' && typeof q.symbol === 'string' && q.symbol.trim().toUpperCase() === sym);
  if (twin) return { pair: null, why: `Another project on the desk, ${twin.name || twin.project_id}, also trades as ${sym}, so ${sym}/${QUOTE} would not name one token.` };
  return { pair: `${sym}/${QUOTE}`, why: null };
}

// The order a ticket's proposal makes at the book's price, or why it makes
// none. The prices are the ticket's own, never invented.
function planOf(receipt, decision, price) {
  const type = (receipt.desk && receipt.desk.proposal_type) || decision.proposal_type || null;
  if (!OPENS.includes(type)) return { why: `The ticket proposes ${type || 'nothing'}; only an ACCUMULATE or a LIMIT_TRAP opens an order.` };
  const p = receipt.proposal || {};
  const zone = p.entry_zone || {};
  const edge = plain(type === 'ACCUMULATE' ? zone.high_usd : zone.low_usd);
  const stop = plain(p.invalidation_trigger && p.invalidation_trigger.price_usd);
  const target = plain(p.upside_target && p.upside_target.price_usd);
  const risk = plain(decision.pm_approved_risk_usd);
  const missing = [
    edge === null && `the entry zone's ${type === 'ACCUMULATE' ? 'high' : 'low'}`,
    stop === null && 'an invalidation price for the stop (a stop is never invented)',
    target === null && 'an upside target',
    risk === null && 'an approved risk above $0',
    !(typeof p.non_consensus_thesis === 'string' && p.non_consensus_thesis.trim()) && 'its thesis',
  ].filter(Boolean);
  if (missing.length) return { why: `The ticket gives no ${missing.join(', no ')}, so no order is made from it.` };
  const inv = p.invalidation_trigger;
  return {
    type,
    entry: price === null ? null : lowerOf(price, edge),
    edge,
    stop,
    target,
    risk,
    evidence: {
      catalyst: p.non_consensus_thesis.trim(),
      metrics_evaluated: [`entry_zone.${type === 'ACCUMULATE' ? 'high_usd' : 'low_usd'}`, 'upside_target.price_usd', 'invalidation_trigger.price_usd', ...(inv.metric && inv.metric.key ? [`invalidation_trigger.metric.${inv.metric.key}`] : [])],
      negative_invalidation: (typeof inv.statement === 'string' && inv.statement.trim()) || `The price trades at or below ${usd(stop)}.`,
    },
  };
}

// The end of the ticket's research horizon (the day it ends, at 00:00 UTC):
// the horizon the receipt froze, else the run it names. Never a default.
function horizonOf(ws, pid, receipt) {
  const day = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : null);
  const r = receipt.researcher || {};
  let end = r.horizon ? day(r.horizon.end_date) : null;
  if (!end && r.run_id) {
    try { const run = require('./research').loadRun(ws, pid, r.run_id); end = day(run && run.horizon && run.horizon.end_date); } catch (_) { end = null; }
  }
  return end ? { day: end, ms: Date.parse(`${end}T00:00:00Z`) } : { day: null, ms: null };
}

// Why a grant's exposure should close now, or null: the undo of the
// decision, the horizon's end, or the ticket's metric invalidation.
function closeReasonOf(ws, g, receipt, t) {
  const d = g.decision;
  if (!g.in_force) return { kind: 'undo', decision_id: g.undo ? g.undo.decision_id : d.decision_id, words: g.undo ? `You undid the ${d.action} (${g.undo.decision_id}).` : `The ${d.action} is no longer the decision in force.` };
  const h = horizonOf(ws, g.project.project_id, receipt);
  if (h.ms !== null && h.ms <= t) return { kind: 'horizon', decision_id: d.decision_id, words: `The research horizon ended on ${h.day}.` };
  try {
    const inv = require('./tickets').invalidationOf(ws, g.project, receipt, { now: t });
    if (inv && inv.invalidated && inv.by === 'metric') return { kind: 'metric', decision_id: d.decision_id, words: `The ticket's metric invalidation fired: ${inv.words}` };
  } catch (_) { /* unread: no close on it */ }
  return null;
}

// Every decision of Eric's that asks the trader for something: each approve
// or halve recorded with effects.trader 'open', whether it is still in force
// and the undo that took it back.
function grantsOf(ws, only = null) {
  const tickets = require('./tickets');
  const projects = require('./projects').listProjects(ws).filter((p) => !p.broken);
  const grants = [];
  for (const p of projects) {
    if (only && p.project_id !== only) continue;
    const lines = tickets.readDecisions(ws, p.project_id);
    for (const d of lines) {
      if (!(d.action === 'approve' || d.action === 'halve') || !d.effects || d.effects.trader !== 'open') continue;
      const now = tickets.decisionFor(lines, d.receipt_id);
      grants.push({ project: p, decision: d, in_force: Boolean(now && now.decision_id === d.decision_id), undo: lines.find((l) => l.action === 'undo' && l.undoes === d.decision_id) || null });
    }
  }
  return { projects, grants };
}

// The book as it stands: every intent by ID, the positions and the orders.
function snapshotOf(ws, now) {
  const r = PT.results(ws, { now });
  return {
    intents: new Map(PT.intents(ws).map((i) => [i.intent_id, i])),
    open: new Map(r.open_positions.map((p) => [p.position_id, p])),
    closed: new Map(r.closed_positions.map((p) => [p.position_id, p])),
    orders: r.orders,
    funded: r.funded_usd !== null,
  };
}
const unresolved = (snap) => snap.orders.filter((o) => !RESOLVED.includes(o.state));
const stateWords = (o) => `${o.state}${o.filled && o.filled !== '0' ? `, ${o.filled} of ${o.quantity} filled` : ''}${o.words ? `: ${o.words}` : ''}`;

// One grant, as the book stands: its phase in words, and the one thing a step
// would do next (null when there is nothing to do, or nothing yet).
function assess(ws, ctx, g, snap) {
  const d = g.decision;
  const pid = g.project.project_id;
  const base = { project_id: pid, project: g.project.name || pid, receipt_id: d.receipt_id, decision_id: d.decision_id, action: d.action, decided_at: d.decided_at, risk_usd: plain(d.pm_approved_risk_usd), proposal_type: d.proposal_type || null, in_force: g.in_force };
  const openId = intentIdOf(d, 'open');
  const asked = snap.intents.get(openId) || null;
  const out = (phase, words, next = null, more = {}) => ({ ...base, open_intent_id: openId, pair: asked ? asked.pair : more.pair || null, phase, words, next, ...more });

  if (!asked) {
    if (!g.in_force) return out('not_opened', `${g.undo ? 'Undone' : 'Replaced'} before the book was asked: no order was made.`);
    const rc = receiptOf(ws, pid, d.receipt_id);
    if (rc.why) return out('not_opened', `${rc.why} No order is made from it.`);
    const pr = pairOf(g.project, ctx.projects);
    if (!pr.pair) return out('not_opened', `${pr.why} No order is made.`);
    const plan0 = planOf(rc.receipt, d, null);
    if (plan0.why) return out('not_opened', plan0.why, null, { pair: pr.pair });
    const ticket = { project_id: pid, receipt_id: d.receipt_id, decision_id: d.decision_id };
    const bk = PT.book(ws, pr.pair, { now: ctx.now, venue: ctx.s.venue, ticket });
    if (bk.exit_why) return out('not_opened', `${bk.exit_why} The order is never made from this decision.`, null, { pair: pr.pair });
    if (bk.grant_why) return out('not_opened', `${bk.grant_why} No order is made.`, null, { pair: pr.pair });
    const stale = ctx.s.rules.price_stale_minutes;
    const waits = [
      ...ctx.s.waits,
      !snap.funded && ctx.s.book.cash_usd && 'The trader\'s Paper Book is not funded yet.',
      unresolved(snap).length && `${unresolved(snap).length} order${unresolved(snap).length === 1 ? ' is' : 's are'} not yet resolved; nothing new is asked until the venue's answer is on record.`,
      bk.price === null && `${pr.pair} has no recent closed hour in the book.`,
      bk.price !== null && Number.isSafeInteger(stale) && ctx.t - Date.parse(bk.price_at) > stale * MIN && `${pr.pair}'s latest hour in the book ended at ${bk.price_at}, more than ${stale} minutes ago.`,
      bk.price !== null && bk.atr_14h === null && `${pr.pair} has fewer than 15 consecutive closed hours in the book, so its 14-hour ATR is unknown.`,
      snap.funded && bk.nav_usd === null && 'The book\'s NAV is unknown (an open position has no recent hour).',
      bk.nav_usd !== null && (bk.drawdown_24h_usd === null || bk.open_risk_usd === null || bk.thesis_risk_usd === null) && 'The book\'s 24-hour drawdown or the risk already at its stops is unknown.',
    ].filter(Boolean);
    if (waits.length) return out('waiting', waits.join(' '), null, { pair: pr.pair });
    const plan = planOf(rc.receipt, d, bk.price);
    const intent = {
      version: INTENT_VERSION, intent_id: openId, thesis_id: d.receipt_id, ...ticket, pair: pr.pair, side: 'OPEN_LONG', order_type: 'LIMIT',
      created_at: ctx.now, reference_price: bk.price, reference_at: bk.price_at,
      entry_price: plan.entry, stop_loss_price: plan.stop, take_profit_price: plan.target, risk_ceiling_usd: plan.risk,
      max_slippage_bps: SLIPPAGE_BPS, valid_until: iso(ctx.t + ctx.s.rules.max_validity_minutes * MIN), evidence: plan.evidence,
    };
    return out('ready', `Ready to ask the book: buy ${pr.pair} at ${usd(plan.entry)}, stop ${usd(plan.stop)}, target ${usd(plan.target)}, risk ${usd(plan.risk)}.`, { kind: 'open', intent }, { pair: pr.pair });
  }

  if (asked.state === 'REFUSED') return out('refused', `The book refused the order: ${asked.refusals.map((x) => x.words).join(' ')}`, null, { refusals: asked.refusals });
  const posId = `pos-${openId}`;
  const pos = snap.open.get(posId) || null;
  const done = snap.closed.get(posId) || null;
  const buyLive = LIVE.includes(asked.state);
  const more = { client_order_id: asked.client_order_id, order_state: asked.state, position: pos ? { state: 'open', ...pos } : done ? { state: 'closed', ...done } : null };
  if (!pos && !buyLive) {
    if (done) {
      const last = done.exits[done.exits.length - 1];
      return out('closed', `Closed (${last ? last.reason.replace('_', ' ') : 'exit'}) at ${last ? usd(last.price) : 'its exit'}: ${done.realized_pnl_usd} realized.`, null, more);
    }
    return out('ended', `The buy ended with nothing filled (${stateWords(asked)}); it is never asked again.`, null, more);
  }

  const reason = closeReasonOf(ws, g, (receiptOf(ws, pid, d.receipt_id).receipt) || {}, ctx.t);
  if (!reason) return out(pos ? 'open' : 'order', pos ? `Open: ${pos.quantity} ${asked.pair} at ${usd(pos.entry_price)}, stop ${usd(pos.stop_loss_price)}, target ${usd(pos.take_profit_price)}${buyLive ? `; the buy is still ${stateWords(asked)}` : ''}.` : `The buy is ${stateWords(asked)}.`, null, more);
  const closing = { ...more, close: { reason: reason.kind, words: reason.words } };
  // What has not filled is cancelled first: a close waits for the buy.
  if (asked.state === 'ACKED' || asked.state === 'PARTIAL') return out('closing', `${reason.words} The unfilled part of the buy is cancelled.`, { kind: 'cancel', client_order_id: asked.client_order_id }, closing);
  if (buyLive) return out('closing', `${reason.words} The buy is ${asked.state}; it is resolved with the venue before anything else.`, null, closing);
  // A sell for the position: the latest attempt, or the next one.
  let n = 0;
  let last = null;
  while (n < CLOSE_ATTEMPTS_MAX && snap.intents.has(intentIdOf(d, `close-${n + 1}`))) { n += 1; last = snap.intents.get(intentIdOf(d, `close-${n}`)); }
  if (last && LIVE.includes(last.state)) return out('closing', `${reason.words} A sell order is ${stateWords(last)}.`, null, { ...closing, close: { ...closing.close, intent_id: last.intent_id, state: last.state } });
  if (n >= CLOSE_ATTEMPTS_MAX) return out('closing', `${reason.words} ${CLOSE_ATTEMPTS_MAX} sell orders ended unfilled or were refused; the position stays open under its stop and target.`, null, closing);
  const bk = PT.book(ws, asked.pair, { now: ctx.now, venue: ctx.s.venue });
  const stale = ctx.s.rules.price_stale_minutes;
  const waits = [
    ...ctx.s.waits.filter((w) => !/not funded/.test(w)),
    unresolved(snap).length && `${unresolved(snap).length} order${unresolved(snap).length === 1 ? ' is' : 's are'} not yet resolved.`,
    bk.price === null && `${asked.pair} has no recent closed hour in the book.`,
    bk.price !== null && Number.isSafeInteger(stale) && ctx.t - Date.parse(bk.price_at) > stale * MIN && `${asked.pair}'s latest hour in the book ended more than ${stale} minutes ago.`,
  ].filter(Boolean);
  if (waits.length) return out('closing', `${reason.words} The sell waits: ${waits.join(' ')}`, null, closing);
  const intent = {
    version: INTENT_VERSION, intent_id: intentIdOf(d, `close-${n + 1}`), thesis_id: d.receipt_id, project_id: pid, receipt_id: d.receipt_id, decision_id: reason.decision_id,
    pair: asked.pair, side: 'CLOSE_LONG', position_id: posId, order_type: 'LIMIT',
    created_at: ctx.now, reference_price: bk.price, reference_at: bk.price_at,
    entry_price: closeLimit(bk.price), stop_loss_price: pos.stop_loss_price, take_profit_price: pos.take_profit_price, risk_ceiling_usd: '0',
    max_slippage_bps: SLIPPAGE_BPS, valid_until: iso(ctx.t + ctx.s.rules.max_validity_minutes * MIN),
    evidence: { catalyst: reason.words, metrics_evaluated: [`close.${reason.kind}`], negative_invalidation: `A close only reduces risk; the position's stop stays at ${usd(pos.stop_loss_price)}.` },
  };
  return out('closing', `${reason.words} Ready to sell ${pos.quantity} ${asked.pair} at ${usd(intent.entry_price)}.`, { kind: 'close', intent }, closing);
}

function contextOf(ws, now, project) {
  const n = nowOf(now);
  const { projects, grants } = grantsOf(ws, project);
  return { ...n, s: settingsOf(ws), projects, grants };
}

// Every request Eric's decisions make of the trader, as the book stands now.
// Reads only.
function requests(ws, { now, project = null } = {}) {
  const ctx = contextOf(ws, now, project);
  const snap = snapshotOf(ws, ctx.now);
  return { version: VERSION, now: ctx.now, waits: ctx.s.waits, requests: ctx.grants.map((g) => { const a = assess(ws, ctx, g, snap); delete a.next; return a; }) };
}

// What the book needs hours for: each pair a request is waiting on, and each
// pair with an open position or a live order, with the last hour the book
// holds for it (null for none); none while Eric has set no funding. Reads
// only; the hourly read (core/trader-candles.js, slot 12b) fetches the hours
// after the last and hands them to applyHours.
function wanted(ws, { now } = {}) {
  const ctx = contextOf(ws, now, null);
  if (!ctx.s.book.cash_usd) return [];
  const snap = snapshotOf(ws, ctx.now);
  const last = new Map(PT.hours(ws).map((h) => [h.pair, h.last_hour]));
  const out = new Map();
  const add = (pair, pid, why) => { if (pair && !out.has(pair)) out.set(pair, { pair, project_id: pid, why, last_hour: last.get(pair) || null }); };
  for (const g of ctx.grants) {
    const a = assess(ws, ctx, g, snap);
    if (['waiting', 'ready', 'order', 'open', 'closing'].includes(a.phase)) add(a.pair, a.project_id, a.phase);
  }
  for (const p of snap.open.values()) add(p.pair, null, 'open');
  return [...out.values()];
}

// One step: fund the book once from Eric's setting, resolve what is
// unresolved, then do the next thing for each request (closes and cancels
// before new orders). Idempotent; each failure is said and never stops the
// other requests.
// The book is funded once, from Eric's setting, before anything else is
// recorded in it: the first hour it holds then has a NAV. A different amount
// later is never applied over the first; that is said, not thrown.
function fundOnce(ws, ctx, done, problems) {
  const cash = ctx.s.book.cash_usd;
  if (!cash) return;
  const funded = PT.results(ws, { now: ctx.now }).funded_usd;
  if (funded !== null) {
    if (dec(funded) !== dec(cash)) problems.push({ kind: 'fund', code: 'CONFLICT', words: `The book was funded with ${usd(funded)}; your setting of ${usd(cash)} is never applied over it.` });
    return;
  }
  try {
    const f = PT.fund(ws, { cash_usd: cash, now: ctx.now });
    if (f.status === 'saved') done.push({ kind: 'fund', status: 'saved', words: `Funded with ${usd(f.cash_usd)}.` });
  } catch (err) {
    problems.push({ kind: 'fund', code: err.code || null, words: String(err && err.message || err).slice(0, 300) });
  }
}

function step(ws, { now, project = null } = {}) {
  const ctx = contextOf(ws, now, project);
  const done = [];
  const problems = [];
  const attempt = (what, fn) => { try { const r = fn(); done.push({ ...what, status: r.status, state: r.state || null, words: r.words || null, refusals: r.refusals || null }); return r; } catch (err) { problems.push({ ...what, code: err.code || null, words: String(err && err.message || err).slice(0, 300) }); return null; } };
  fundOnce(ws, ctx, done, problems);
  let snap = snapshotOf(ws, ctx.now);
  if (snap.orders.some((o) => o.state === 'RESERVED' || o.state === 'SENT')) attempt({ kind: 'recover' }, () => PT.recover(ws, { now: ctx.now }));
  else for (const o of snap.orders.filter((x) => x.state === 'UNKNOWN')) attempt({ kind: 'reconcile', client_order_id: o.client_order_id }, () => PT.reconcile(ws, o.client_order_id, { now: ctx.now }));
  snap = snapshotOf(ws, ctx.now);
  // Closes and cancels first: they only reduce risk. Then new orders, the
  // oldest decision first. Each pass does one thing not yet tried and reads
  // the book again, so a cancel frees the sell after it in the same step.
  const first = (a) => (a.next.kind === 'open' ? 1 : 0);
  const key = (a) => `${a.decision_id}|${a.next.kind}|${a.next.intent ? a.next.intent.intent_id : a.next.client_order_id}`;
  const tried = new Set();
  for (let pass = 0; pass < 64; pass++) {
    const todo = ctx.grants.map((g) => assess(ws, ctx, g, snap)).filter((a) => a.next && !tried.has(key(a)));
    if (!todo.length) break;
    const a = todo.sort((x, y) => first(x) - first(y) || String(x.decided_at).localeCompare(String(y.decided_at)))[0];
    tried.add(key(a));
    const what = { kind: a.next.kind, project_id: a.project_id, decision_id: a.decision_id, receipt_id: a.receipt_id, intent_id: a.next.intent ? a.next.intent.intent_id : null, client_order_id: a.next.client_order_id || null };
    if (a.next.kind === 'cancel') attempt(what, () => PT.cancelOrder(ws, a.next.client_order_id, { now: ctx.now }));
    else attempt(what, () => PT.submitIntent(ws, a.next.intent, { now: ctx.now, rules: ctx.s.rules, venue: ctx.s.venue }));
    snap = snapshotOf(ws, ctx.now);
  }
  return { version: VERSION, now: ctx.now, done, problems, ...requests(ws, { now: ctx.now, project }) };
}

// Closed hours for the book, one after another (12b hands them in), after
// funding it from Eric's setting if it is not yet funded. The book refuses a
// gap, a changed hour or one before the last; the first refusal of a gap,
// an order or the book's integrity stops the rest of that pair's hours.
function applyHours(ws, bars, { now } = {}) {
  const n = nowOf(now);
  const problems = [];
  fundOnce(ws, { ...n, s: settingsOf(ws) }, [], problems);
  const out = problems.map((p) => ({ pair: null, hour: null, status: 'refused', code: p.code, words: p.words }));
  const stoppedPairs = new Set();
  for (const b of Array.isArray(bars) ? bars : []) {
    const pair = b && b.pair;
    if (stoppedPairs.has(pair)) { out.push({ pair, hour: b && b.hour, status: 'skipped', words: 'An earlier hour of this pair was refused.' }); continue; }
    try {
      const r = PT.applyBar(ws, b, { now: n.now });
      out.push({ pair, hour: b.hour, status: r.status, events: r.events });
    } catch (err) {
      out.push({ pair, hour: b && b.hour, status: 'refused', code: err.code || null, words: String(err && err.message || err).slice(0, 300) });
      if (['GAP', 'INTEGRITY', 'TIME', 'ORDER'].includes(err.code)) stoppedPairs.add(pair);
    }
  }
  return out;
}

module.exports = { VERSION, OPENS, QUOTE, LOT, MIN_NOTIONAL_USD, SLIPPAGE_BPS, CLOSE_ATTEMPTS_MAX, intentIdOf, plain, closeLimit, settingsOf, pairOf, planOf, horizonOf, requests, wanted, step, applyHours };
