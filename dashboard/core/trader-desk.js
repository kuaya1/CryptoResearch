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
//     at most Eric's approved amount (@2: the largest every limit allows,
//     fit below); life: his longest life of an intent; pair: the
//     project's ticker against USDC, refused while another unarchived project
//     shares the ticker. A missing field opens nothing, said in words; a stop
//     is never invented, so a metric-only invalidation opens nothing;
//   - one attempt per decision: its intent ID is derived from the decision,
//     so the book's answer, an order or a refusal with its reasons, is final.
//     The book is asked only once it can answer (funded, Eric's rules and fee
//     set, a fresh hour and a 14-hour ATR for the pair, no unresolved order,
//     the book's record settled, the ticket flat, a whole hour in the order's
//     life) and only with an intent it would take (@2, fit); until then the
//     request waits, with the reason in words. Past the research horizon, or
//     on a ticket invalidated since, it never opens. Once the
//     ticket's exit readings give no size (D11: past their 72 hours, or none
//     within the limit), it never opens.
// What closes: the undo of that decision, the end of the ticket's research
// horizon, or the ticket's metric invalidation as the desk reads it
// (tickets.js invalidationOf). What has not filled is cancelled; an open
// position gets a sell limit SLIPPAGE_BPS under the book's price, asked again
// as a new intent when one ends unfilled, at most CLOSE_ATTEMPTS_MAX times.
// The stop and the target stay the book's own.
//
// Missing hours (cr-trader-gap@1, the cohesion audit's M1, 2026-10-29): see
// GAPS_REL below. While the book's record of a pair it is exposed in is
// unsettled, no new order is asked anywhere in the book, the unfilled part
// of a buy in that pair is not cancelled over its missing hour, and the
// book's figures are read as recorded balances, never as settled ones. Since
// cr-paper@3 the book holds the same gate itself and its reading of each
// pair is the one used here; the adapter adds the missing hour it recorded.
//
// Everything else is re-derived on each call from Eric's decisions and the
// book's journal: its one record of its own is the missing hours the book
// refused, and nothing is kept in memory. A step that failed
// half way completes on the next one, and the same step twice asks nothing
// twice. Reads (requests, wanted, view) write nothing.

const PT = require('./paper-trader');
const { validateTradeIntent, exact: { dec, str, mulCeil, isoMs }, INTENT_VERSION, SLIPPAGE_BPS_MAX, RESOLVED } = require('./trade-risk');
const TR = require('./trader-rules');
const { OpError, withLock } = require('./ops');
const { sha256, appendLine } = require('./fsx');

// @2 (2026-10-29, the cohesion audit's M1, M2, M4 and M7): missing hours
// hold openings; an opening is checked and sized before its one ID is spent;
// a grant past its horizon or invalidated opens nothing. Intent IDs keep the
// @1 derivation, so a decision made under @1 keeps its ID.
const VERSION = 'cr-trader-desk@2';
const ID_VERSION = 'cr-trader-desk@1';
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
const HOUR = 3600000;
const BPS = 10000n;

// The hours the book refused because one before them is missing (GAP), one
// line per pair and missing hour, create-only: the pair, the missing hour,
// the last hour on record, the later hour that showed it missing, and when it
// was first seen. GeckoTerminal leaves out an hour in which the pool had no
// trade, so a missing hour may never arrive; it is never filled in, and a
// pair stays unsettled until the book holds it. A line that does not read
// leaves the whole book unsettled, in words.
const GAPS_REL = 'paper/candles/gaps.jsonl';
const GAP_VERSION = 'cr.trader-gap.v1';

const iso = (ms) => new Date(ms).toISOString();
function nowOf(now) {
  const s = now === undefined ? new Date().toISOString() : now;
  const ms = isoMs(s);
  if (ms === null) throw new OpError('INVALID', 'now is not an ISO-8601 UTC time.');
  return { now: s, t: Number(ms) };
}
const usd = (s) => `$${Number(s).toLocaleString('en-US', { maximumFractionDigits: 6 })}`;
// A result in words, to the cent with its sign (words only; the book keeps
// the exact decimal).
const pnl = (s) => { const n = Number(s); return `${n < 0 ? '−' : n > 0 ? '+' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; };
// How a position left the book (paper-trader.js exit reasons), in words.
const EXIT_WORDS = { close: 'Sold', stop: 'Stopped out', stop_gap: 'Stopped out through a gap', take_profit: 'Target reached and sold' };
const exitWords = (e) => (e ? `${EXIT_WORDS[e.reason] || `Exited (${String(e.reason).replace(/_/g, ' ')})`} at ${usd(e.price)}` : 'Exited');

// A ULID made from the decision: its time part the decision's, its random
// part the SHA-256 of the decision ID and the step's purpose ('open',
// 'close-1', ...). The same decision and purpose give the same ID, so the
// book is never asked twice for the same thing.
function intentIdOf(d, purpose) {
  const ms = Date.parse(d.decided_at);
  let t = BigInt(Number.isFinite(ms) && ms >= 0 ? ms : 0);
  let r = BigInt(`0x${sha256(`${ID_VERSION}|${d.decision_id}|${purpose}`).slice(0, 20)}`);
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

// The limits that bound an opening from above as its risk grows, the book's
// cash among them (paper-trader.js reserveIntent: the order's cash and fee at
// its limit, committed when it is reserved), in words.
const UPPER = ['risk_cap', 'drawdown', 'gate_cap', 'pm_cap', 'notional_cap', 'exit_cap', 'cash'];
const BINDING_WORDS = { risk_cap: 'the risk per trade', drawdown: 'the 24-hour drawdown ceiling', gate_cap: 'the gate\'s suggested risk', pm_cap: 'your approved risk', notional_cap: 'the notional cap', exit_cap: 'the exit measurement\'s size', cash: 'the free cash' };

// An opening intent checked as the book will check it (cr-trade-risk@2 over
// the same book, and the book's cash), with its risk ceiling the largest at
// or under the one it was written with that every limit allows (M4). Each
// limit above grows with the risk, so the largest risk is found by halving
// between 0 and the approved amount at the book's 18 places; the order it
// sizes is floored to the lot by the engine itself, so one lot more breaks
// the binding limit. Never above the approved risk; an order the book would
// refuse at every size, or for any other reason, is { ok: false } with the
// refusals in words. Pure: it reads no file and writes nothing.
function fit(intent, bk, rules, venue) {
  const fee = dec(venue && venue.taker_rate);
  const check = (risk) => {
    const it = { ...intent, risk_ceiling_usd: str(risk) };
    const v = validateTradeIntent(it, bk, rules);
    const refusals = [...v.refusals];
    if (v.ok && v.sizing && fee !== null && dec(bk.available_cash_usd) !== null) {
      const n = mulCeil(dec(v.sizing.quantity), dec(it.entry_price));
      const need = n + mulCeil(n, fee);
      if (dec(bk.available_cash_usd) < need) refusals.push({ field: 'book.cash_usd', rule: 'cash', words: `The order needs ${str(need)} with its fee; ${bk.available_cash_usd} is free.` });
    }
    return { it, refusals, sizing: v.sizing };
  };
  const want = dec(intent.risk_ceiling_usd);
  const first = want === null ? check(0n) : check(want);
  if (!first.refusals.length) return { ok: true, intent: first.it, sizing: first.sizing, binding: [], refusals: [] };
  if (want === null || !first.refusals.every((x) => UPPER.includes(x.rule))) return { ok: false, refusals: first.refusals };
  const upperOk = (r) => !check(r).refusals.some((x) => UPPER.includes(x.rule));
  let lo = 0n;
  let hi = want;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (upperOk(mid)) lo = mid; else hi = mid;
  }
  const best = check(lo);
  if (lo === 0n || best.refusals.length) return { ok: false, refusals: lo === 0n ? first.refusals : best.refusals };
  // What binds: the limits the next step of risk breaks.
  const binding = [...new Set(check(lo + 1n).refusals.filter((x) => UPPER.includes(x.rule)).map((x) => x.rule))];
  return { ok: true, intent: best.it, sizing: best.sizing, binding, refusals: [] };
}

// The recorded missing hours, and why they cannot be read when they cannot.
function readGaps(ws) {
  let text = '';
  try { text = require('fs').readFileSync(ws.abs(GAPS_REL), 'utf8'); } catch (err) {
    if (!err || err.code !== 'ENOENT') return { gaps: [], why: `${GAPS_REL} could not be read (${(err && err.code) || 'error'}), so whether an hour is missing is unknown.` };
  }
  const gaps = [];
  for (const [i, l] of text.split(/\r?\n/).entries()) {
    if (!l.trim()) continue;
    let g = null;
    try { g = JSON.parse(l); } catch (_) { /* said below */ }
    if (!g || g.schema_version !== GAP_VERSION || typeof g.pair !== 'string' || isoMs(g.missing_hour) === null || isoMs(g.detected_at) === null) return { gaps, why: `${GAPS_REL} line ${i + 1} does not read, so whether an hour is missing is unknown.` };
    if (!gaps.some((x) => x.pair === g.pair && x.missing_hour === g.missing_hour)) gaps.push(g);
  }
  return { gaps, why: null };
}

// Records a missing hour once; the same one again keeps its first sighting.
function noteGap(ws, rec) {
  return withLock(ws, 'trader_gaps', () => {
    const cur = readGaps(ws);
    if (cur.why) throw new OpError('INTEGRITY', `${cur.why} The missing hour ${rec.missing_hour} of ${rec.pair} was not recorded.`);
    if (cur.gaps.some((g) => g.pair === rec.pair && g.missing_hour === rec.missing_hour)) return 'unchanged';
    appendLine(ws.abs(GAPS_REL), { schema_version: GAP_VERSION, ...rec });
    return 'saved';
  });
}

// Whether the book's record is settled now: the engine's own reading
// (paper-trader.js settlementAt, cr-paper@3: each pair the book is exposed
// in, an open position or an order that may still fill or sell, and whether
// its last hour on record is within the book's NAV freshness), with any
// recorded missing hour after a pair's last hour named in its words. A
// missing hour is stale by the time it is seen, so the engine's reading
// already holds the book; a gaps record that does not read holds it here
// too. Pure, over a snapshot.
function settlementOf(snap) {
  const eng = snap.results.settlement;
  const exposed = new Set(eng.pairs.map((p) => p.pair));
  const lastMs = (pair) => (snap.last.has(pair) ? Date.parse(snap.last.get(pair)) : null);
  const pairs = eng.pairs.map((p) => {
    const last = lastMs(p.pair);
    const gap = snap.gaps.gaps.find((g) => g.pair === p.pair && (last === null || Date.parse(g.missing_hour) > last)) || null;
    const words = gap
      ? `${p.pair} is missing the hour ${gap.missing_hour} (first seen ${gap.detected_at}; the hour ${gap.later_hour} after it has come), so a fill, stop or target in it is not on record for ${p.exposure.join(' and ')}. It settles when that hour arrives; GeckoTerminal leaves out an hour in which the pool had no trade, so it may never arrive, and nothing is filled in.`
      : p.words;
    return { pair: p.pair, exposure: p.exposure, settled_through: p.settled_through, state: words ? 'unsettled' : 'settled', gap: gap ? { missing_hour: gap.missing_hour, detected_at: gap.detected_at, later_hour: gap.later_hour } : null, words };
  });
  const gaps = snap.gaps.gaps.map((g) => {
    const last = lastMs(g.pair);
    return { pair: g.pair, missing_hour: g.missing_hour, detected_at: g.detected_at, later_hour: g.later_hour, state: last !== null && last >= Date.parse(g.missing_hour) ? 'settled' : exposed.has(g.pair) ? 'open' : 'not_exposed' };
  });
  const said = [snap.gaps.why, ...pairs.filter((p) => p.words).map((p) => p.words)].filter(Boolean);
  return {
    version: 'cr-trader-gap@1',
    state: said.length ? 'unsettled' : 'settled',
    settled_through: eng.settled_through,
    pairs,
    gaps,
    words: said.join(' ') || null,
  };
}

// Eric's settings: the engine's rules (trader.rules and the desk's price
// freshness), and the book's funding and venue fee (trader.book).
function settingsOf(ws) {
  const r = TR.rulesOf(ws);
  const b = TR.bookOf(ws);
  const waits = [];
  if (r.unset.length) waits.push(`Your trader rules are not all set (${r.unset.join(', ')}); set them in Preferences > Screening.`);
  if (b.unset.includes('cash_usd')) waits.push('The trader\'s Paper Book is not funded; set its funding in Preferences > Screening.');
  if (b.unset.includes('fee_rate')) waits.push('The venue fee is not set, and an unknown fee is never read as 0; set it in Preferences > Screening.');
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
// The hours each pair holds and the recorded missing hours come with it, and
// whether the book's record is settled now (settlementOf). One snapshot
// serves a whole read phase (the cohesion audit's brief 5): the view, the
// requests and a step's assessments read it rather than the journal again,
// and a step takes a new one after each thing it records, never reusing the
// book from before a change. Nothing is kept between calls.
function snapshotOf(ws, now) {
  const r = PT.results(ws, { now });
  const list = PT.intents(ws);
  const hours = PT.hours(ws);
  const snap = {
    results: r,
    list,
    hours,
    intents: new Map(list.map((i) => [i.intent_id, i])),
    open: new Map(r.open_positions.map((p) => [p.position_id, p])),
    closed: new Map(r.closed_positions.map((p) => [p.position_id, p])),
    orders: r.orders,
    funded: r.funded_usd !== null,
    last: new Map(hours.map((h) => [h.pair, h.last_hour])),
    gaps: readGaps(ws),
  };
  snap.settlement = settlementOf(snap);
  return snap;
}
// The missing hour after a pair's last hour on record, if one is recorded.
const openGapOf = (snap, pair) => ((snap.settlement.pairs.find((p) => p.pair === pair) || {}).gap || null);
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
    // A grant that waited past its horizon, or a ticket invalidated since,
    // opens nothing: checked before every opening, not only after one.
    const h = horizonOf(ws, pid, rc.receipt);
    if (h.ms !== null && h.ms <= ctx.t) return out('not_opened', `The research horizon ended on ${h.day} before the book was asked: no order is made from this decision.`, null, { pair: pr.pair });
    const ticket = { project_id: pid, receipt_id: d.receipt_id, decision_id: d.decision_id };
    const bk = PT.book(ws, pr.pair, { now: ctx.now, venue: ctx.s.venue, ticket });
    if (bk.exit_why) return out('not_opened', `${bk.exit_why} The order is never made from this decision.`, null, { pair: pr.pair });
    if (bk.grant_why) return out('not_opened', `${bk.grant_why} No order is made.`, null, { pair: pr.pair });
    let inv = null;
    try { inv = require('./tickets').invalidationOf(ws, g.project, rc.receipt, { now: ctx.t }); } catch (_) { inv = null; }
    if (inv && inv.invalidated) return out('not_opened', `The ticket is invalidated (${inv.words}) before the book was asked: no order is made from this decision.`, null, { pair: pr.pair });
    const stale = ctx.s.rules.price_stale_minutes;
    // An earlier decision's order or position on the same ticket (an undo's
    // close still in flight): this one waits until the ticket is flat, then
    // opens once at its full grant, never sized around the one closing (M2).
    const earlier = [...snap.intents.values()].filter((i) => i.thesis_id === d.receipt_id && i.intent_id !== openId && (LIVE.includes(i.state) || snap.open.has(`pos-${i.intent_id}`) || snap.open.has(i.position_id)));
    const waits = [
      ...ctx.s.waits,
      earlier.length && `An earlier order or position on this ticket is still open (${[...new Set(earlier.map((i) => `${i.side === 'CLOSE_LONG' ? 'a sell' : 'a buy'} ${i.state}`))].join(', ')}); this order waits until the ticket is flat.`,
      snap.settlement.state === 'unsettled' && `No new order while the book's record is unsettled: ${snap.settlement.words} Its cash and drawdown are recorded balances, so they do not show how much can be risked.`,
      !snap.funded && ctx.s.book.cash_usd && 'The trader\'s Paper Book is not funded yet.',
      unresolved(snap).length && `${unresolved(snap).length} order${unresolved(snap).length === 1 ? ' is' : 's are'} not yet resolved; nothing new is asked until the venue's answer is on record.`,
      bk.price === null && `${pr.pair} has no recent closed hour in the book.`,
      bk.price !== null && Number.isSafeInteger(stale) && ctx.t - Date.parse(bk.price_at) > stale * MIN && `${pr.pair}'s latest hour in the book ended at ${bk.price_at}, more than ${stale} minutes ago.`,
      bk.price !== null && bk.atr_14h === null && `${pr.pair} has fewer than 15 consecutive closed hours in the book, so its 14-hour ATR is unknown.`,
      snap.funded && bk.nav_usd === null && 'The book\'s NAV is unknown (an open position has no recent hour).',
      bk.nav_usd !== null && (bk.drawdown_24h_usd === null || bk.open_risk_usd === null || bk.thesis_risk_usd === null) && 'The book\'s 24-hour drawdown or the risk already at its stops is unknown.',
    ].filter(Boolean);
    if (waits.length) return out('waiting', waits.join(' '), null, { pair: pr.pair, exit_as_of: bk.exit ? bk.exit.as_of : null });
    // The order's life must hold a whole hour that starts after it is sent,
    // or no hour can fill it (M7): it waits for one rather than expiring.
    const life = ctx.s.rules.max_validity_minutes;
    const firstHour = Math.ceil(ctx.t / HOUR) * HOUR;
    if (firstHour + HOUR > ctx.t + life * MIN) return out('waiting', `Your longest life of an intent (${life} minutes) would end before the first whole hour after now (${iso(firstHour)} to ${iso(firstHour + HOUR)}) closes, and an order fills only from a whole hour that starts after it is sent, so it would expire unfilled.${life < 60 ? ' A life under 60 minutes never holds a whole hour; lengthen it in Preferences > Screening.' : ` It is asked when the next hour is no more than ${life - 60} minutes away.`}`, null, { pair: pr.pair, exit_as_of: bk.exit ? bk.exit.as_of : null });
    const plan = planOf(rc.receipt, d, bk.price);
    const intent = {
      version: INTENT_VERSION, intent_id: openId, thesis_id: d.receipt_id, ...ticket, pair: pr.pair, side: 'OPEN_LONG', order_type: 'LIMIT',
      created_at: ctx.now, reference_price: bk.price, reference_at: bk.price_at,
      entry_price: plan.entry, stop_loss_price: plan.stop, take_profit_price: plan.target, risk_ceiling_usd: plan.risk,
      max_slippage_bps: SLIPPAGE_BPS, valid_until: iso(ctx.t + life * MIN), evidence: plan.evidence,
    };
    // Checked as the book will check it, before its one ID is spent (M2), and
    // sized to the largest order every limit allows, never above Eric's
    // approved risk (M4). Anything the book would refuse waits, in words.
    const f = fit(intent, bk, ctx.s.rules, ctx.s.venue);
    if (!f.ok) return out('waiting', `The book would refuse the order now, so it is not asked yet (its one attempt is kept): ${f.refusals.map((x) => x.words).join(' ')}`, null, { pair: pr.pair, refusals: f.refusals, exit_as_of: bk.exit ? bk.exit.as_of : null });
    const sz = f.sizing;
    // The contract gate, when Eric enforces it (tickets.js contractOpenGuard):
    // the same contract, current evidence, and the exit at this fitted
    // notional (CG-14), not only at the reference tranche. Openings only.
    let guard = null;
    try { guard = require('./tickets').contractOpenGuard(ws, g.project, rc.receipt, { now: ctx.t, notionalUsd: sz.notional_usd, priceUsd: plan.entry }); } catch (err) { guard = { hold: true, final: false, words: `The contract gate could not be read (${String(err && err.message || err).slice(0, 160)}); the order waits.` }; }
    if (guard && guard.hold) return out(guard.final ? 'not_opened' : 'waiting', guard.words, null, { pair: pr.pair, contract: { rule_id: guard.rule_id || null, ...(guard.fitted ? { fitted: guard.fitted } : {}) }, exit_as_of: bk.exit ? bk.exit.as_of : null });
    const less = f.binding.length ? ` Sized down from your ${usd(plan.risk)} to fit ${f.binding.map((r) => BINDING_WORDS[r] || r).join(' and ')}.` : '';
    return out('ready', `Ready to ask the book: buy ${sz.quantity} ${pr.pair} at ${usd(plan.entry)} (${usd(sz.notional_usd)}), stop ${usd(plan.stop)}, target ${usd(plan.target)}, ${usd(sz.loss_at_stop_usd)} at the stop.${less}`, { kind: 'open', intent: f.intent }, { pair: pr.pair, sizing: { ...sz, risk_ceiling_usd: f.intent.risk_ceiling_usd, approved_risk_usd: plan.risk, binding: f.binding } });
  }

  // A refused intent has no order, so its pair is named from the project.
  if (asked.state === 'REFUSED') return out('refused', `The book refused the order: ${asked.refusals.map((x) => x.words).join(' ')}`, null, { refusals: asked.refusals, pair: pairOf(g.project, ctx.projects).pair });
  const posId = `pos-${openId}`;
  const pos = snap.open.get(posId) || null;
  const done = snap.closed.get(posId) || null;
  const buyLive = LIVE.includes(asked.state);
  const more = { client_order_id: asked.client_order_id, order_state: asked.state, position: pos ? { state: 'open', ...pos } : done ? { state: 'closed', ...done } : null };
  if (!pos && !buyLive) {
    if (done) {
      const last = done.exits[done.exits.length - 1];
      return out('closed', `${exitWords(last)}: ${pnl(done.realized_pnl_usd)} realized.`, null, more);
    }
    return out('ended', `The buy ended with nothing filled (${stateWords(asked)}); it is never asked again.`, null, more);
  }

  const reason = closeReasonOf(ws, g, (receiptOf(ws, pid, d.receipt_id).receipt) || {}, ctx.t);
  if (!reason) return out(pos ? 'open' : 'order', pos ? `Open: ${pos.quantity} ${asked.pair} at ${usd(pos.entry_price)}, stop ${usd(pos.stop_loss_price)}, target ${usd(pos.take_profit_price)}${buyLive ? `; the buy is still ${stateWords(asked)}` : ''}.` : `The buy is ${stateWords(asked)}.`, null, more);
  const closing = { ...more, close: { reason: reason.kind, words: reason.words } };
  // What has not filled is cancelled first: a close waits for the buy. Not
  // over a missing hour: the buy may have filled in it, and a cancel recorded
  // now would leave that fill off the record when the hour arrives.
  const gap = openGapOf(snap, asked.pair);
  if ((asked.state === 'ACKED' || asked.state === 'PARTIAL') && gap) return out('closing', `${reason.words} The unfilled part of the buy is cancelled once ${asked.pair}'s missing hour ${gap.missing_hour} is on record, so a fill in it is not lost.`, null, closing);
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
  return requestsOf(ws, ctx, snapshotOf(ws, ctx.now));
}
function requestsOf(ws, ctx, snap) {
  return { version: VERSION, now: ctx.now, waits: ctx.s.waits, settlement: snap.settlement, requests: ctx.grants.map((g) => { const a = assess(ws, ctx, g, snap); delete a.next; return a; }) };
}

// The book as Outcomes > Paper Book reads it (slot 12c): Eric's settings and
// what they leave waiting, the book's results (NAV by the hour, positions,
// orders, realized results and fees, what is unknown), every request his
// decisions make with its phase in words, and each order, position and
// refusal with the project and decision it belongs to. Reads only.
function view(ws, { now } = {}) {
  const ctx = contextOf(ws, now, null);
  const snap = snapshotOf(ws, ctx.now);
  const res = snap.results;
  const reqs = ctx.grants.map((g) => { const a = assess(ws, ctx, g, snap); delete a.next; return a; });
  // Every intent a decision makes, its buy and each sell attempt, to its request.
  const owner = new Map();
  for (const r of reqs) {
    const d = { decision_id: r.decision_id, decided_at: r.decided_at };
    owner.set(intentIdOf(d, 'open'), { r, purpose: 'open' });
    for (let n = 1; n <= CLOSE_ATTEMPTS_MAX; n++) owner.set(intentIdOf(d, `close-${n}`), { r, purpose: 'close' });
  }
  const whose = (intentId) => {
    const o = owner.get(intentId);
    return o ? { project_id: o.r.project_id, project: o.r.project, decision_id: o.r.decision_id, action: o.r.action, purpose: o.purpose, request_pair: o.r.pair } : { project_id: null, project: null, decision_id: null, action: null, purpose: null, request_pair: null };
  };
  const intents = snap.list;
  const byOrder = new Map(intents.filter((i) => i.client_order_id).map((i) => [i.client_order_id, i]));
  const ofPosition = (p) => ({ ...p, ...whose(String(p.position_id).replace(/^pos-/, '')), exit_words: p.exits && p.exits.length ? exitWords(p.exits[p.exits.length - 1]) : null });
  // While an hour is missing, the book's figures are what it has recorded,
  // never a settled account (a fill or a stop may be in the missing hour).
  const st = snap.settlement;
  const unknown = st.state === 'unsettled' ? [...res.unknown, `NAV, cash, the results and the drawdowns are recorded balances, not settled${st.settled_through ? ` (settled through ${st.settled_through})` : ''}: ${st.words}`] : res.unknown;
  return {
    version: VERSION,
    now: ctx.now,
    waits: ctx.s.waits,
    settlement: st,
    book: { cash_usd: ctx.s.book.cash_usd || null, fee_rate: ctx.s.book.fee_rate || null },
    venue: { lot: LOT, min_notional_usd: MIN_NOTIONAL_USD },
    results: { ...res, open_positions: res.open_positions.map(ofPosition), closed_positions: res.closed_positions.map(ofPosition), unknown },
    requests: reqs,
    orders: res.orders.map((o) => {
      const i = byOrder.get(o.client_order_id) || {};
      return { ...o, intent_id: i.intent_id || null, side: i.side || null, pair: i.pair || null, position_id: i.position_id || null, ...whose(i.intent_id) };
    }),
    refusals: intents.filter((i) => i.state === 'REFUSED').map((i) => ({ intent_id: i.intent_id, refusals: i.refusals || [], ...whose(i.intent_id) })),
    hours: snap.hours,
  };
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
  const last = snap.last;
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
// recorded in it; NAV by the hour starts at the funding (paper-trader.js
// navSeries). A different amount later is never applied over the first;
// that is said, not thrown.
function fundOnce(ws, ctx, done, problems, snap = null) {
  const cash = ctx.s.book.cash_usd;
  if (!cash) return false;
  const funded = (snap ? snap.results : PT.results(ws, { now: ctx.now })).funded_usd;
  if (funded !== null) {
    if (dec(funded) !== dec(cash)) problems.push({ kind: 'fund', code: 'CONFLICT', words: `The book was funded with ${usd(funded)}; your setting of ${usd(cash)} is never applied over it.` });
    return false;
  }
  try {
    const f = PT.fund(ws, { cash_usd: cash, now: ctx.now });
    if (f.status === 'saved') done.push({ kind: 'fund', status: 'saved', words: `Funded with ${usd(f.cash_usd)}.` });
    return f.status === 'saved';
  } catch (err) {
    problems.push({ kind: 'fund', code: err.code || null, words: String(err && err.message || err).slice(0, 300) });
    return false;
  }
}

function step(ws, { now, project = null } = {}) {
  const ctx = contextOf(ws, now, project);
  const done = [];
  const problems = [];
  const attempt = (what, fn) => { try { const r = fn(); done.push({ ...what, status: r.status, state: r.state || null, words: r.words || null, refusals: r.refusals || null }); return r; } catch (err) { problems.push({ ...what, code: err.code || null, words: String(err && err.message || err).slice(0, 300) }); return null; } };
  let snap = snapshotOf(ws, ctx.now);
  if (fundOnce(ws, ctx, done, problems, snap)) snap = snapshotOf(ws, ctx.now);
  // Read again only when recovery or a reconcile was attempted.
  const before = done.length + problems.length;
  if (snap.orders.some((o) => o.state === 'RESERVED' || o.state === 'SENT')) attempt({ kind: 'recover' }, () => PT.recover(ws, { now: ctx.now }));
  else for (const o of snap.orders.filter((x) => x.state === 'UNKNOWN')) attempt({ kind: 'reconcile', client_order_id: o.client_order_id }, () => PT.reconcile(ws, o.client_order_id, { now: ctx.now }));
  if (done.length + problems.length !== before) snap = snapshotOf(ws, ctx.now);
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
  // The requests as the book stands after the last thing recorded: snap was
  // read after it.
  return { version: VERSION, now: ctx.now, done, problems, ...requestsOf(ws, ctx, snap) };
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
      const row = { pair, hour: b && b.hour, status: 'refused', code: err.code || null, words: String(err && err.message || err).slice(0, 300) };
      if (err.code === 'GAP') row.gap = gapOf(ws, pair, b.hour, n.now);
      out.push(row);
      if (['GAP', 'INTEGRITY', 'TIME', 'ORDER'].includes(err.code)) stoppedPairs.add(pair);
    }
  }
  return out;
}

// The hour missing before `hour`, recorded once (GAPS_REL): the hour after
// the pair's last on record. A failure to record it is said, never thrown.
function gapOf(ws, pair, hour, now) {
  try {
    const last = (PT.hours(ws).find((h) => h.pair === pair) || {}).last_hour || null;
    if (!last) return { pair, missing_hour: null, detected_at: now, status: 'failed', words: `${pair} has no hour on record, so the missing hour cannot be named.` };
    const missing = iso(Date.parse(last) + HOUR);
    const status = noteGap(ws, { pair, missing_hour: missing, last_hour: last, later_hour: hour, detected_at: now });
    return { pair, missing_hour: missing, detected_at: status === 'saved' ? now : (readGaps(ws).gaps.find((g) => g.pair === pair && g.missing_hour === missing) || {}).detected_at || null, status };
  } catch (err) {
    return { pair, missing_hour: null, detected_at: now, status: 'failed', words: String(err && err.message || err).slice(0, 300) };
  }
}

module.exports = { VERSION, OPENS, QUOTE, LOT, MIN_NOTIONAL_USD, SLIPPAGE_BPS, CLOSE_ATTEMPTS_MAX, GAPS_REL, GAP_VERSION, intentIdOf, plain, closeLimit, fit, settingsOf, pairOf, planOf, horizonOf, settlementOf, requests, view, wanted, step, applyHours };
