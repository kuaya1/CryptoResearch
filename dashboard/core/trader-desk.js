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
const fs = require('fs');
const { OpError, withLock, recoverLocked, assertNotBlocked, OPLOG_REL } = require('./ops');
const RESTORED_REL = 'config/restored-copy.json';
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
// A grant the paper mandate recorded (tickets.js MANDATE_BY): its authority is
// read again at every opening and before every hour (mandate-authority.js).
const byMandate = (d) => Boolean(d && typeof d.decided_by === 'string' && d.decided_by.startsWith('mandate:'));
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
const BINDING_WORDS = { risk_cap: 'the risk per trade', drawdown: 'the 24-hour drawdown ceiling', gate_cap: 'the gate\'s suggested risk', pm_cap: 'your approved risk', notional_cap: 'the notional cap', exit_cap: 'the exit measurement\'s size', cash: 'the free cash', quote: 'the largest saved exit quote the contract gate can prove' };

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

// CG-14 holds the risk-sized order (enforce): the largest quantity, at or
// under it, that a saved concentrated-pool quote was asked for exactly and
// whose exit the guard proves, re-fitted by the engine at the risk that buys
// exactly that many (so every limit, fee, minimum and the cash are checked
// again), or why none can be (audit 2026-11-08). Reads records; no network.
function snapToQuote(ws, project, { f, plan, bk, s, now, guardAt }) {
  let sizes;
  try { sizes = require('./tickets').contractQuotedSizes(ws, project, { now, lot: LOT }); } catch (err) {
    return { ok: false, words: `The saved exit quotes could not be read (${String(err && err.message || err).slice(0, 160)}).` };
  }
  const want = dec(f.sizing.quantity);
  const entry = dec(plan.entry);
  const under = sizes.filter((x) => dec(x.quantity) !== null && dec(x.quantity) <= want);
  if (!under.length) return { ok: false, words: sizes.length ? `Every saved exit quote is for more than the ${f.sizing.quantity} the risk allows, so the order is not sized to one.` : 'No saved exit quote is proven for a whole number of lots, so the order is not sized down to one.' };
  let first = null;
  for (const c of under) {
    const q = dec(c.quantity);
    const h = guardAt({ quantity: str(q), notional_usd: str(mulCeil(q, entry)) });
    if (h) { first = first || { c, h }; continue; }
    const risk = mulCeil(q, dec(f.sizing.per_unit_loss_usd));
    const f2 = fit({ ...f.intent, risk_ceiling_usd: str(risk) }, bk, s.rules, s.venue);
    const at = `${q < want ? 'Sized down to' : 'At'} ${str(q)}, the quantity of the $${c.reference_usd} reference quote`;
    if (!f2.ok) return { ok: false, words: `${at}, the book would refuse it: ${f2.refusals.map((x) => x.words).join(' ')}` };
    if (f2.sizing.quantity !== str(q)) return { ok: false, words: `${at}, the book sizes ${f2.sizing.quantity} instead, so it is not asked.` };
    return { ok: true, fit: { ...f2, binding: [...new Set([...f.binding, 'quote'])] }, snapped: { from_quantity: f.sizing.quantity, quantity: str(q), reference_usd: c.reference_usd, pool: c.pool, quote_input: c.recorded ? 'recorded' : 'rebuilt', observation_id: c.observation_id || null } };
  }
  return { ok: false, words: `${dec(first.c.quantity) < want ? 'Sized down to' : 'At'} ${first.c.quantity}, the quantity of the $${first.c.reference_usd} reference quote, the exit is still not proven: ${first.h.words}` };
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

// The allowlist the engine is handed (autonomous paper playbook, Stage 9):
// the sorted union of Eric's saved list, the pair of every grant in force
// that pairOf resolves (a ticker twin or a pair bound to another token never
// enters), and every pair the book holds exposure in (an open position or a
// live order), so an undone grant's close is never stranded. Derived on every
// call; nothing writes trader.rules.allowlist.
function allowlistOf(saved, { grants = [], projects = [], snap = null } = {}) {
  const settings = Array.isArray(saved) ? [...saved] : [];
  const fromGrants = [];
  for (const g of grants) {
    const d = g.decision || {};
    if (!g.in_force || !(d.action === 'approve' || d.action === 'halve') || !d.effects || d.effects.trader !== 'open') continue;
    const pr = pairOf(g.project, projects, { sources: snap ? snap.sources : null });
    if (pr.pair) fromGrants.push({ pair: pr.pair, decision_id: d.decision_id, by: d.decided_by || null });
  }
  const exposure = new Set();
  if (snap) {
    for (const p of snap.open.values()) if (p && typeof p.pair === 'string') exposure.add(p.pair);
    for (const i of snap.list) if (i && typeof i.pair === 'string' && LIVE.includes(i.state)) exposure.add(i.pair);
  }
  const list = [...new Set([...settings, ...fromGrants.map((x) => x.pair), ...exposure])].sort();
  return { list, basis: { settings, grants: fromGrants, exposure: [...exposure].sort() } };
}

// Eric's settings: the engine's rules (trader.rules and the desk's price
// freshness), and the book's funding and venue fee (trader.book). With the
// grants and a snapshot, the allowlist is the effective one (allowlistOf).
function settingsOf(ws, { grants = [], projects = [], snap = null } = {}) {
  const r = TR.rulesOf(ws);
  const b = TR.bookOf(ws);
  const waits = [];
  const al = allowlistOf(r.rules.allowlist, { grants, projects, snap });
  const rules = { ...r.rules };
  let unset = r.unset;
  if (al.list.length) {
    rules.allowlist = al.list;
    unset = unset.filter((k) => k !== 'allowlist');
  }
  if (unset.length) waits.push(`Your trader rules are not all set (${unset.join(', ')}); set them in Preferences > Screening.`);
  if (b.unset.includes('cash_usd')) waits.push('The trader\'s Paper Book is not funded; set its funding in Preferences > Screening.');
  if (b.unset.includes('fee_rate')) waits.push('The venue fee is not set, and an unknown fee is never read as 0; set it in Preferences > Screening.');
  const venue = { lot: LOT, min_notional_usd: MIN_NOTIONAL_USD, maker_rate: b.book.fee_rate, taker_rate: b.book.fee_rate };
  return { rules, book: b.book, venue, waits, allowlist_basis: al.basis };
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

// The pool each pair's hourly candles are bound to for good
// (paper/candles/sources.jsonl, create-only): the first line per pair wins,
// the rule trader-candles.js readSources reads it by. Read here, since that
// module requires this one. A file that is there but does not read is
// `unreadable`, and no pair is then taken as unbound. So is one with a line
// that is not a supported binding (not JSON, another version, no pair, no
// project or no contract): a malformed record might be the binding that
// refuses a pair, so the history cannot be established and new bindings and
// exposure wait (corrective PR, 2026-10-31). `problems` names the lines.
const SOURCES_REL = 'paper/candles/sources.jsonl';
const SOURCE_VERSION = 'cr.trader-candle-source.v1';
function sourceBindings(ws) {
  const out = new Map();
  let text = '';
  try { text = require('fs').readFileSync(ws.abs(SOURCES_REL), 'utf8'); } catch (err) {
    if (!err || err.code !== 'ENOENT') out.unreadable = true;
    return out;
  }
  const problems = [];
  // A pair whose binding comes before every malformed line keeps it: first
  // line wins, and nothing before it could have been an earlier one.
  const established = new Set();
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    let s = null;
    try { s = JSON.parse(line); } catch (_) { s = null; }
    const ok = s && typeof s === 'object' && !Array.isArray(s) && s.schema_version === SOURCE_VERSION && typeof s.pair === 'string' && /^[A-Z0-9.]{1,24}\/[A-Z0-9.]{1,24}$/.test(s.pair) && typeof s.project_id === 'string' && s.project_id && typeof s.contract_address === 'string' && s.contract_address && (typeof s.chain_id === 'string' || typeof s.chain_id === 'number');
    if (!ok) { problems.push(i + 1); return; }
    if (!out.has(s.pair)) {
      out.set(s.pair, s);
      if (!problems.length) established.add(s.pair);
    }
  });
  out.established = established;
  if (problems.length) {
    out.unreadable = true;
    out.problems = problems;
  }
  return out;
}
const sourceBindingOf = (ws, pair) => sourceBindings(ws).get(pair) || null;

// Whether a binding prices this project's own token: the same project and a
// contract among its verified identity's on that chain.
function boundToOwn(project, b) {
  if (!b.project_id || b.project_id !== project.project_id) return false;
  return require('./tickets').ownsContract(project, b.chain_id, b.contract_address);
}

// The pair a project trades as in the book: its ticker against USDC. With
// `sources` (sourceBindings), a pair whose candles are bound to another
// project or another contract is refused: its hours would not price this token.
function pairOf(project, projects, { sources = null } = {}) {
  const sym = typeof project.symbol === 'string' ? project.symbol.trim().toUpperCase() : '';
  const name = project.name || project.project_id;
  if (!/^[A-Z0-9.]{1,24}$/.test(sym)) return { pair: null, why: `${name} has no ticker the book can name a pair with.` };
  const twin = projects.find((q) => q.project_id !== project.project_id && q.status !== 'archived' && typeof q.symbol === 'string' && q.symbol.trim().toUpperCase() === sym);
  if (twin) return { pair: null, why: `Another project on the desk, ${twin.name || twin.project_id}, also trades as ${sym}, so ${sym}/${QUOTE} would not name one token.` };
  const pair = `${sym}/${QUOTE}`;
  if (sources && sources.unreadable) return { pair: null, why: `The candle bindings (${SOURCES_REL}) could not be read${sources.problems ? ` (line${sources.problems.length === 1 ? '' : 's'} ${sources.problems.slice(0, 5).join(', ')} ${sources.problems.length === 1 ? 'is' : 'are'} not a supported binding)` : ''}, so whether ${pair} prices this token is unknown.` };
  const b = sources ? sources.get(pair) : null;
  if (b && !boundToOwn(project, b)) return { pair: null, why: `${pair}'s hourly candles are bound to ${b.project_id || 'another project'} (${b.contract_address || 'no contract'}) for good, so ${pair} would not price this token.` };
  return { pair, why: null };
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
// A book that once existed is never a new one. With its journal and head both
// gone, paper-trader.js reads what a book reads before its first funding, so
// the positions and orders would vanish, the brief would say nothing is wrong
// and the next step would fund again. The operation log is the record outside
// the book: ops.js logs a commit only after the files are written, and only
// PT.fund writes this type. So a committed funding with no funding in the book
// is a lost book. A funding that began and never committed is no evidence. The
// log is read only while the book reads as unfunded, and the book is read again
// after it, so a funding committing between the two reads is not called lost.
// A log that is also gone cannot show this; the backups are the answer to that.
const FUND_COMMITTED = new Set(['commit', 'commit_unverified', 'recovered_forward']);
function fundCommittedAt(ws) {
  let text;
  try { text = fs.readFileSync(ws.abs(OPLOG_REL), 'utf8'); } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw new OpError('INTEGRITY', `${OPLOG_REL} could not be read (${(err && err.code) || 'error'}), so whether the unfunded book once existed is unknown. Nothing is read or written until it is repaired.`);
  }
  for (const line of text.split('\n')) {
    if (!line.includes('"paper_trader.fund.')) continue;
    let e = null;
    try { e = JSON.parse(line); } catch (_) { continue; }
    if (e && String(e.type).startsWith('paper_trader.fund.') && FUND_COMMITTED.has(e.phase)) return e.at || 'an unknown time';
  }
  return null;
}
function lostBook(ws, now) {
  const at = fundCommittedAt(ws);
  if (at === null || PT.results(ws, { now }).funded_usd !== null) return null;
  return `The operation log records this book funded at ${at}, but ${PT.JOURNAL} holds no funding: its records are lost, not new. Nothing is read or written until it is repaired.`;
}

// The book-identity anchor (trader-rules.js bookAnchorOf) is the record off the
// disk: the operation log above shares a disk with the book and can go with it. An
// anchored book must begin with the line the anchor names, so its loss or its
// replacement is refused, however little else is left on the disk. A restore keeps
// that line, so a restored book reads again. It names the book, not its progress: an
// older copy of the same book passes here.
// Only the first line is read, so the check costs the same however long the book is.
function firstLineOf(ws) {
  let fd = null;
  try {
    fd = fs.openSync(ws.abs(PT.JOURNAL), 'r');
    const parts = [];
    const chunk = Buffer.alloc(4096);
    for (;;) {
      const got = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!got) break;
      const part = Buffer.from(chunk.subarray(0, got));
      const nl = part.indexOf(0x0a);
      parts.push(nl < 0 ? part : part.subarray(0, nl));
      if (nl >= 0) break;
    }
    return Buffer.concat(parts).toString('utf8') || null;
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw new OpError('INTEGRITY', `${PT.JOURNAL} could not be read (${(err && err.code) || 'error'}). Nothing is read or written until it is repaired.`);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
function assertAnchor(ws, journalBytes) {
  const a = TR.bookAnchorOf(ws);
  if (a.state === 'invalid') throw new OpError('INTEGRITY', `${TR.BOOK_ANCHOR_ENV} is not a book's hash, so which book this desk holds is unknown. Nothing is read or written until it is repaired.`);
  if (a.state !== 'established') return a;
  // Given bytes are the exact copy being used; otherwise the file as it stands.
  const line = journalBytes === undefined ? firstLineOf(ws) : (journalBytes === null ? null : journalBytes.toString('utf8').split('\n')[0] || null);
  if (line === null) throw new OpError('INTEGRITY', `${TR.BOOK_ANCHOR_ENV} names an established book, but ${PT.JOURNAL} holds no records: they are lost, not new. Nothing is read or written until it is repaired.`);
  if (TR.genesisOf(line) !== a.genesis_sha256) throw new OpError('INTEGRITY', `${PT.JOURNAL} does not begin with the line ${TR.BOOK_ANCHOR_ENV} names: it is not the established book. Nothing is read or written until it is repaired.`);
  return a;
}
// What identifies the journal file as it stands: a rewrite gives a new file (atomic
// rename), so its stamp differs even at the same size.
function journalStamp(ws) {
  try {
    const st = fs.statSync(ws.abs(PT.JOURNAL), { bigint: true });
    return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}`;
  } catch (err) {
    if (err && err.code === 'ENOENT') return 'absent';
    throw new OpError('INTEGRITY', `${PT.JOURNAL} could not be read (${(err && err.code) || 'error'}). Nothing is read or written until it is repaired.`);
  }
}
// A read of the book takes the journal several times, and the engine's reads take no
// bytes from here. So an anchored read is bracketed: the same file before and after,
// and the anchor holding on it after. A commit in between reads again; a book that
// was replaced refuses. A file moved by hand and moved back within one read is not seen.
function readAnchored(ws, read) {
  const a = assertAnchor(ws);
  if (a.state !== 'established') return read();
  for (let tries = 0; tries < 3; tries++) {
    const before = journalStamp(ws);
    const value = read();
    const after = journalStamp(ws);
    assertAnchor(ws);
    if (before === after) return value;
  }
  throw new OpError('INTEGRITY', `${PT.JOURNAL} kept changing while it was read, so the book is not shown from a mix of two. Nothing is read or written until it reads steadily.`);
}
// A restored copy on hold (config/restored-copy.json, research.js restoredHold): the
// book funds nothing, sends no order and applies no hour until Eric rules on what would
// run and releases it. Its reads stay open so he can. Unreadable is held. The hold does
// not name its own restore: a disk put back with no marker cannot be told from this one
// (docs/engineering/PAPER_BOOK_RESTORE.md).
const HOLD_WORDS = 'This is a restored copy on hold: the book funds nothing, sends no order and applies no hour until Eric rules on what would run and releases it (restored-copy status, then restored-copy release --confirm).';
function restoreHoldOf(ws) {
  try { return require('./research').restoredHold(ws); } catch (_) { return { unreadable: true }; }
}
// The marker as this read found it. A write made from that read refuses if the marker
// has changed since, so a decision read before a hold or a release is never carried
// across it. Taken before anything else is read.
function holdFenceOf(ws) {
  try { return fs.readFileSync(ws.abs(RESTORED_REL), 'utf8'); } catch (err) { return err.code === 'ENOENT' ? '' : `unreadable:${err.code}`; }
}
// A released copy's marker names its timeline. A sell is a new order made now, so a sell
// after a release takes an ID from that release: the same number in the timeline the
// restore lost may have gone with another body, and one ID is one order. It is read from
// the fence's own bytes, so the ID and the check of the marker come from one read. A
// workspace that was never restored has none, and keeps the plain numbering.
function releaseEpochOf(fence) {
  let m = null;
  try { m = JSON.parse(fence); } catch (_) { return null; }
  return m && typeof m === 'object' && m.research_held === false ? sha256(fence).slice(0, 16) : null;
}
const closePurpose = (n, epoch) => `close-${n}${epoch ? `@${epoch}` : ''}`;
function assertNotRestoreHeld(ws, fence) {
  if (restoreHoldOf(ws)) throw new OpError('RESTORE_HELD', HOLD_WORDS);
  if (holdFenceOf(ws) !== fence) throw new OpError('RESTORE_HELD', 'The restored-copy hold changed after this read, so nothing is written from it. The next read decides again.');
}
// Every write goes through here: under the workspace's lock, after any recovery, the
// hold and the anchor are checked on the book the engine is about to read in that same
// lock. A write through the desk's own operations waits for the lock, so it cannot come
// between. The hold is read after recovery, because recovery can complete a hold.
function underAnchor(ws, write, fence) {
  return withLock(ws, 'trader_anchor', () => {
    assertNotBlocked(ws);
    recoverLocked(ws);
    assertNotBlocked(ws);
    assertNotRestoreHeld(ws, fence);
    assertAnchor(ws);
    return write();
  });
}
const INIT_WORDS = `This desk does not start a book by itself. A first funding is Eric's own command (node dashboard/cli.js trader bootstrap); if a book existed, restore it and set ${TR.BOOK_ANCHOR_ENV} to its hash.`;

// The one way a real book starts: Eric's command, naming the amount his settings
// hold, with the words typed out. Nothing routine calls it: it is on the command line
// only, on no route and in no job. It takes nothing from the anchor, and it refuses if
// the anchor names a book, if any record of a book is on the disk, or if the log
// remembers one.
const bootstrapWords = (cash) => `FUND NEW PAPER BOOK ${cash}`;
function bootstrapBook(ws, { cash_usd, confirm, now } = {}) {
  const n = nowOf(now);
  const set = TR.bookOf(ws).book.cash_usd;
  if (!set) throw new OpError('INVALID', 'The Paper Book has no funding in its settings (Preferences > Screening), so there is nothing to start it with.');
  if (typeof cash_usd !== 'string' || dec(cash_usd) === null || dec(cash_usd) !== dec(set)) throw new OpError('INVALID', `The amount named is not the ${usd(set)} in the book's settings. Nothing was funded.`);
  if (confirm !== bootstrapWords(cash_usd)) throw new OpError('INVALID', `A first funding is confirmed in words: "${bootstrapWords(cash_usd)}". Nothing was funded.`);
  return withLock(ws, 'trader_bootstrap', () => {
    assertNotBlocked(ws);
    recoverLocked(ws);
    assertNotBlocked(ws);
    assertNotRestoreHeld(ws, holdFenceOf(ws));
    assertAnchor(ws);
    if (fs.existsSync(ws.abs(PT.JOURNAL)) || fs.existsSync(ws.abs(PT.HEAD))) throw new OpError('INIT_REFUSED', `${PT.JOURNAL} or its head is already on the disk, so this is not a new book. Nothing was funded.`);
    const lost = lostBook(ws, n.now);
    if (lost) throw new OpError('INTEGRITY', lost);
    const f = PT.fund(ws, { cash_usd, now: n.now });
    const genesis = TR.genesisOf(firstLineOf(ws));
    return { status: f.status, cash_usd: f.cash_usd, genesis_sha256: genesis, next: `Set ${TR.BOOK_ANCHOR_ENV} to this hash in the host's environment.` };
  });
}

function snapshotOf(ws, now) {
  const { r, list, hours } = readAnchored(ws, () => {
    const results = PT.results(ws, { now });
    if (results.funded_usd === null) {
      const lost = lostBook(ws, now);
      if (lost) throw new OpError('INTEGRITY', lost);
    }
    return { r: results, list: PT.intents(ws), hours: PT.hours(ws) };
  });
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
    sources: sourceBindings(ws),
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
    // final: whether the reason can never pass. A not_opened that may pass
    // still holds the paper mandate's capacity (mandate-authority.js).
    if (!g.in_force) return out('not_opened', `${g.undo ? 'Undone' : 'Replaced'} before the book was asked: no order was made.`, null, { final: true });
    // A mandate grant's authority, read again before anything is asked
    // (corrective PR, defect C): the same arming, unrevoked and unexpired,
    // Eric not intervening since, the Prosecutor's ticket consistent.
    if (byMandate(d)) {
      const auth = require('./tickets').grantAuthority(ws, d, { now: ctx.t, project: g.project });
      if (!auth.ok) return out('not_opened', `The paper mandate's grant opens nothing: ${auth.words}`, null, { final: auth.final, authority: { code: auth.code, words: auth.words } });
    }
    const rc = receiptOf(ws, pid, d.receipt_id);
    if (rc.why) return out('not_opened', `${rc.why} No order is made from it.`, null, { final: false });
    const pr = pairOf(g.project, ctx.projects, { sources: snap.sources });
    if (!pr.pair) return out('not_opened', `${pr.why} No order is made.`, null, { final: false });
    const plan0 = planOf(rc.receipt, d, null);
    if (plan0.why) return out('not_opened', plan0.why, null, { pair: pr.pair, final: true });
    // A grant that waited past its horizon, or a ticket invalidated since,
    // opens nothing: checked before every opening, not only after one.
    const h = horizonOf(ws, pid, rc.receipt);
    if (h.ms !== null && h.ms <= ctx.t) return out('not_opened', `The research horizon ended on ${h.day} before the book was asked: no order is made from this decision.`, null, { pair: pr.pair, final: true });
    const ticket = { project_id: pid, receipt_id: d.receipt_id, decision_id: d.decision_id };
    const bk = PT.book(ws, pr.pair, { now: ctx.now, venue: ctx.s.venue, ticket });
    if (bk.exit_why) return out('not_opened', `${bk.exit_why} The order is never made from this decision.`, null, { pair: pr.pair, final: true });
    if (bk.grant_why) return out('not_opened', `${bk.grant_why} No order is made.`, null, { pair: pr.pair, final: false });
    let inv = null;
    try { inv = require('./tickets').invalidationOf(ws, g.project, rc.receipt, { now: ctx.t }); } catch (_) { inv = null; }
    if (inv && inv.invalidated) return out('not_opened', `The ticket is invalidated (${inv.words}) before the book was asked: no order is made from this decision.`, null, { pair: pr.pair, final: true });
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
    let f = fit(intent, bk, ctx.s.rules, ctx.s.venue);
    if (!f.ok) return out('waiting', `The book would refuse the order now, so it is not asked yet (its one attempt is kept): ${f.refusals.map((x) => x.words).join(' ')}`, null, { pair: pr.pair, refusals: f.refusals, exit_as_of: bk.exit ? bk.exit.as_of : null });
    let sz = f.sizing;
    // A paper mandate grant (decided_by mandate:…) reads the contract again
    // at opening, in every gate mode: a verdict that is gone or blocks, or an
    // identity changed or a sell tax spiked since the save, opens nothing; a
    // hold (a stale observation, CG-20) waits for the next one. Eric's own
    // grants keep the enforce-only guard below.
    if (typeof d.decided_by === 'string' && d.decided_by.startsWith('mandate:')) {
      const T = require('./tickets');
      let v = null;
      let chk = null;
      try {
        v = T.contractVerdictNow(ws, g.project, T.sizingOf(ws), ctx.t);
        chk = T.contractCheckOf(ws, g.project, rc.receipt, ctx.t);
      } catch (err) {
        return out('waiting', `The contract could not be read again for the paper mandate's grant (${String(err && err.message || err).slice(0, 160)}); the order waits.`, null, { pair: pr.pair, contract: { rule_id: 'MANDATE_RECHECK' } });
      }
      if (!v || v.tier === 'block') return out('not_opened', `The paper mandate's grant opens nothing: ${v ? `the contract gate now blocks (${v.words})` : 'the contract has no observation the desk can read now'}.`, null, { pair: pr.pair, final: false, contract: { rule_id: 'MANDATE_RECHECK', tier: v ? v.tier : null } });
      if (chk && chk.status === 'triggered') return out('not_opened', `The paper mandate's grant opens nothing: ${chk.words}`, null, { pair: pr.pair, final: false, contract: { rule_id: 'MANDATE_RECHECK', status: chk.status } });
      if (v.tier === 'hold') return out('waiting', `The paper mandate's grant waits: the contract gate holds (${v.words}).`, null, { pair: pr.pair, contract: { rule_id: 'MANDATE_RECHECK', tier: v.tier } });
    }
    // The contract gate, when Eric enforces it (tickets.js contractOpenGuard):
    // the same contract, current evidence, and the exit at this fitted
    // notional (CG-14), not only at the reference tranche. Openings only.
    // When CG-14 alone holds the risk-sized order, it is sized down to the
    // largest quantity a saved quote proves an exit for (snapToQuote), then
    // the whole guard is read again for that final quantity.
    // The guard's last reading is kept (tickets.js contractOpenReading): the
    // last call is always for the quantity the book is then asked for, so
    // `reading` is the decision the order goes out on, and what it evaluated
    // goes with the intent as the order's opening receipt.
    let reading = null;
    const riskSized = sz.quantity;
    const guardAt = (s) => {
      reading = null;
      try { reading = require('./tickets').contractOpenReading(ws, g.project, rc.receipt, { now: ctx.t, notionalUsd: s.notional_usd, priceUsd: plan.entry, quantity: s.quantity }); return reading.hold; } catch (err) { return { hold: true, final: false, words: `The contract gate could not be read (${String(err && err.message || err).slice(0, 160)}); the order waits.` }; }
    };
    let guard = guardAt(sz);
    let snapped = null;
    if (guard && guard.hold && guard.rule_id === 'CG-14') {
      const sn = snapToQuote(ws, g.project, { f, plan, bk, s: ctx.s, now: ctx.t, guardAt });
      if (sn.ok) {
        f = sn.fit;
        sz = f.sizing;
        snapped = sn.snapped;
        guard = guardAt(sz);
      } else guard = { ...guard, words: `${guard.words} ${sn.words}` };
    }
    if (guard && guard.hold) return out(guard.final ? 'not_opened' : 'waiting', guard.words, null, { pair: pr.pair, final: Boolean(guard.final), contract: { rule_id: guard.rule_id || null, ...(guard.fitted ? { fitted: guard.fitted } : {}) }, exit_as_of: bk.exit ? bk.exit.as_of : null });
    // The opening receipt (core/opening-receipt.js, cr.opening-guard.v1): what
    // that final reading evaluated, with the quantity the risk sized, the
    // quantity asked for, and the saved quote the order was sized down to. It
    // rides on the intent as one more of the metrics evaluated, which the
    // published intent schema allows, so the book copies it, hashes it
    // (intent_sha256) and writes it on the reservation's own journal line. The
    // book never reads it for its decision. Under enforce an order whose
    // receipt cannot be made is not asked: it waits, in words. With the gate
    // observed only, the receipt says the guard did not run, and an order is
    // never held back over it.
    const OR = require('./tickets').openingReceipt;
    const enforced = Boolean(reading && reading.guard && reading.guard.gate_mode === 'enforce');
    let toAsk = f.intent;
    try {
      toAsk = OR.attach(f.intent, OR.build(reading && reading.guard, { riskSized, final: sz.quantity, snapped }));
    } catch (err) {
      if (enforced || !reading) return out('waiting', `The order's opening receipt could not be made (${String(err && err.message || err).slice(0, 200)}), and no order is asked without it while the contract gate is enforced; the order waits.`, null, { pair: pr.pair, contract: { rule_id: 'OPENING_RECEIPT' }, exit_as_of: bk.exit ? bk.exit.as_of : null });
      toAsk = f.intent;
    }
    const less = f.binding.length ? ` Sized down from your ${usd(plan.risk)} to fit ${f.binding.map((r) => BINDING_WORDS[r] || r).join(' and ')}.` : '';
    return out('ready', `Ready to ask the book: buy ${sz.quantity} ${pr.pair} at ${usd(plan.entry)} (${usd(sz.notional_usd)}), stop ${usd(plan.stop)}, target ${usd(plan.target)}, ${usd(sz.loss_at_stop_usd)} at the stop.${less}`, { kind: 'open', intent: toAsk }, { pair: pr.pair, sizing: { ...sz, risk_ceiling_usd: f.intent.risk_ceiling_usd, approved_risk_usd: plan.risk, binding: f.binding, ...(snapped ? { snapped } : {}) } });
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

  // A mandate grant's buy the mandate no longer covers (revoked, expired,
  // paused, Eric's intervention): what has not filled is cancelled through
  // the book's own cancel; what filled stays, managed as before (corrective
  // PR, defect C). Not over a missing hour, as for a close below.
  if (byMandate(d) && (asked.state === 'ACKED' || asked.state === 'PARTIAL')) {
    const auth = require('./tickets').grantAuthority(ws, d, { now: ctx.t, project: g.project });
    if (!auth.ok) {
      const gap0 = openGapOf(snap, asked.pair);
      const authority = { code: auth.code, words: auth.words };
      if (gap0) return out(pos ? 'open' : 'order', `The paper mandate no longer covers this buy (${auth.words}) Its unfilled part is cancelled once ${asked.pair}'s missing hour ${gap0.missing_hour} is on record, so a fill in it is not lost.`, null, { ...more, authority });
      return out(pos ? 'open' : 'order', `The paper mandate no longer covers this buy: ${auth.words} Its unfilled part is cancelled; what filled stays and is managed as before.`, { kind: 'cancel', client_order_id: asked.client_order_id }, { ...more, authority });
    }
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
  while (n < CLOSE_ATTEMPTS_MAX && snap.intents.has(intentIdOf(d, closePurpose(n + 1, ctx.epoch)))) { n += 1; last = snap.intents.get(intentIdOf(d, closePurpose(n, ctx.epoch))); }
  // A sell from before this release is still this position's sell.
  if (!last || !LIVE.includes(last.state)) last = snap.list.find((i) => i.side === 'CLOSE_LONG' && i.position_id === posId && LIVE.includes(i.state)) || last;
  if (last && LIVE.includes(last.state)) return out('closing', `${reason.words} A sell order is ${stateWords(last)}.`, null, { ...closing, close: { ...closing.close, intent_id: last.intent_id, state: last.state } });
  if (n >= CLOSE_ATTEMPTS_MAX) return out('closing', `${reason.words} ${CLOSE_ATTEMPTS_MAX} sell orders ended unfilled or were refused; the position stays open under its stop and target.`, null, closing);
  const bk = PT.book(ws, asked.pair, { now: ctx.now, venue: ctx.s.venue });
  const stale = ctx.s.rules.price_stale_minutes;
  const waits = [
    ...ctx.s.waits.filter((w) => !/not funded/.test(w) && !/rules are not all set \(allowlist\)/.test(w)),
    unresolved(snap).length && `${unresolved(snap).length} order${unresolved(snap).length === 1 ? ' is' : 's are'} not yet resolved.`,
    bk.price === null && `${asked.pair} has no recent closed hour in the book.`,
    bk.price !== null && Number.isSafeInteger(stale) && ctx.t - Date.parse(bk.price_at) > stale * MIN && `${asked.pair}'s latest hour in the book ended more than ${stale} minutes ago.`,
  ].filter(Boolean);
  if (waits.length) return out('closing', `${reason.words} The sell waits: ${waits.join(' ')}`, null, closing);
  const intent = {
    version: INTENT_VERSION, intent_id: intentIdOf(d, closePurpose(n + 1, ctx.epoch)), thesis_id: d.receipt_id, project_id: pid, receipt_id: d.receipt_id, decision_id: reason.decision_id,
    pair: asked.pair, side: 'CLOSE_LONG', position_id: posId, order_type: 'LIMIT',
    created_at: ctx.now, reference_price: bk.price, reference_at: bk.price_at,
    entry_price: closeLimit(bk.price), stop_loss_price: pos.stop_loss_price, take_profit_price: pos.take_profit_price, risk_ceiling_usd: '0',
    max_slippage_bps: SLIPPAGE_BPS, valid_until: iso(ctx.t + ctx.s.rules.max_validity_minutes * MIN),
    evidence: { catalyst: reason.words, metrics_evaluated: [`close.${reason.kind}`], negative_invalidation: `A close only reduces risk; the position's stop stays at ${usd(pos.stop_loss_price)}.` },
  };
  return out('closing', `${reason.words} Ready to sell ${pos.quantity} ${asked.pair} at ${usd(intent.entry_price)}.`, { kind: 'close', intent }, closing);
}

// The grants, the book as it stands (snap) and the settings they make: the
// effective allowlist reads both.
function contextOf(ws, now, project) {
  const n = nowOf(now);
  const fence = holdFenceOf(ws);
  const hold = restoreHoldOf(ws);
  const { projects, grants } = grantsOf(ws, project);
  const snap = snapshotOf(ws, n.now);
  return { ...n, fence, epoch: releaseEpochOf(fence), hold, s: settingsOf(ws, { grants, projects, snap }), projects, grants, snap };
}

// A request as a read shows it while the copy is held: nothing it says is about to
// happen is happening.
const heldRead = (ctx, a) => (ctx.hold && a.next ? { ...a, phase: a.phase === 'ready' ? 'waiting' : a.phase, words: `On hold, nothing is sent: ${a.words}` } : a);
const waitsOf = (ctx) => (ctx.hold ? [HOLD_WORDS, ...ctx.s.waits] : ctx.s.waits);

// Every request Eric's decisions make of the trader, as the book stands now.
// Reads only.
function requests(ws, { now, project = null } = {}) {
  const ctx = contextOf(ws, now, project);
  return requestsOf(ws, ctx, ctx.snap);
}
function requestsOf(ws, ctx, snap) {
  return { version: VERSION, now: ctx.now, waits: waitsOf(ctx), settlement: snap.settlement, requests: ctx.grants.map((g) => { const a = { ...heldRead(ctx, assess(ws, ctx, g, snap)) }; delete a.next; return a; }) };
}

// What a release would set going, for Eric to rule on first. Reads only. Throws when a
// history or the book does not read: unknown is not none.
// - opening: a grant in force whose opening order this book does not hold, unless it can
//   never pass. It may never have gone, or may have gone after the cutoff and been lost;
//   the records cannot say which. An order made from it would carry the old ID with a new
//   life, so it cannot be accepted: Undo it, then decide again after the release.
// - order, position, cancel, close: work the book already holds under a decision. It can
//   be accepted, which writes nothing into the book and gives no new authority.
// - mandate: an armed paper mandate would grant again at once. Turn it off; arming it
//   again after the release is Eric's own arm-desk.
// - unmatched_order, broken_project: the records do not match. Put back a matched set.
// - pm_cohort: a grant in force with nothing else waiting, whose PM Cohort position is not
//   on record. The hold kept it from opening, or the copy lost it, and the repair would
//   open it after the release. It can be accepted, or undone.
// reduces_only says the work can no longer add to a position, which is what a ruling on
// a basis that cannot be verified needs (research.js).
function rulingsOf(ws, ctx) {
  const T = require('./tickets');
  const items = [];
  const owned = new Set();
  const pmOpened = T.paperOpenedIds(ws);
  for (const g of ctx.grants) {
    const a = assess(ws, ctx, g, ctx.snap);
    const opening = intentIdOf(g.decision, 'open');
    owned.add(opening);
    const base = { id: a.decision_id, project_id: a.project_id, decision_id: a.decision_id, decided_at: a.decided_at, phase: a.phase, opening_intent: opening };
    const asked = ctx.snap.intents.get(opening);
    const pmMissing = g.in_force && T.paperWanted(g.decision) && Number(g.decision.pm_approved_risk_usd) > 0 && !pmOpened.has(g.decision.decision_id);
    const pmItem = { ...base, kind: 'pm_cohort', may_accept: true, reduces_only: false, disposition: 'Its PM Cohort position is not on record, and the repair would open it after the release, priced at the decision. Accept it, or Undo it.' };
    if (!asked) {
      if (!(a.phase === 'not_opened' && a.final === true)) items.push({ ...base, kind: 'opening', may_accept: false, reduces_only: false, disposition: 'Undo it. To trade it, decide again after the release: a new decision, a new basis and a new intent ID.' });
      else if (pmMissing) items.push(pmItem);
      continue;
    }
    const kind = a.next ? a.next.kind : a.position && a.position.state === 'open' ? 'position' : LIVE.includes(asked.state) ? 'order' : null;
    if (kind) items.push({ ...base, kind, may_accept: true, reduces_only: !pmMissing && (a.phase === 'closing' || kind === 'cancel' || !LIVE.includes(asked.state)), ...(pmMissing ? { pm_cohort_missing: true } : {}), disposition: `Accept it by ID, after checking it. The ${kind} carries on under its own decision; nothing in the book is rewritten.${pmMissing ? ' Its PM Cohort position is not on record either, and the repair would open it after the release.' : ''}` });
    else if (pmMissing) items.push(pmItem);
  }
  for (const i of ctx.snap.list) {
    if (owned.has(i.intent_id) || (i.side === 'CLOSE_LONG' && owned.has(String(i.position_id).replace(/^pos-/, '')))) continue;
    if (LIVE.includes(i.state) || ctx.snap.open.has(`pos-${i.intent_id}`)) items.push({ id: i.intent_id, kind: 'unmatched_order', may_accept: false, opening_intent: i.intent_id, disposition: 'The book holds an order no decision here names, so these records are not a matched set. Put back a matched set.' });
  }
  for (const p of require('./projects').listProjects(ws)) {
    const lines = T.readDecisionsStrict(ws, p.project_id);
    if (p.broken && lines.some((d) => (d.action === 'approve' || d.action === 'halve') && d.effects && d.effects.trader === 'open')) items.push({ id: p.project_id, kind: 'broken_project', may_accept: false, project_id: p.project_id, disposition: 'This project does not read, and it holds a grant. Repair it or put back a matched set.' });
  }
  const m = T.mandateOf(ws, ctx.t);
  if (m.on || m.held) items.push({ id: `mandate-${m.generation}`, kind: 'mandate', may_accept: false, generation: m.generation, expires_at: m.expires_at, disposition: 'Turn it off (arm-desk off-only, or the desk control). Arm it again after the release if you want it.' });
  return items;
}
const closeNumbers = () => Array.from({ length: CLOSE_ATTEMPTS_MAX }, (_, i) => i + 1);
function rulingsNeeded(ws, { now } = {}) {
  return rulingsOf(ws, contextOf(ws, now, null));
}
function holdView(ws, ctx) {
  const base = { held: true, words: HOLD_WORDS, restored_at: ctx.hold.restored_at || null, from: ctx.hold.from || null, unreadable: ctx.hold.unreadable === true };
  try { return { ...base, rulings_needed: rulingsOf(ws, ctx) }; } catch (err) { return { ...base, rulings_needed: null, rulings_unreadable: String(err && err.message || err).slice(0, 300) }; }
}

// The book as Outcomes > Paper Book reads it (slot 12c): Eric's settings and
// what they leave waiting, the book's results (NAV by the hour, positions,
// orders, realized results and fees, what is unknown), every request his
// decisions make with its phase in words, and each order, position and
// refusal with the project and decision it belongs to. Reads only.
function view(ws, { now } = {}) {
  const ctx = contextOf(ws, now, null);
  const snap = ctx.snap;
  const res = snap.results;
  const reqs = ctx.grants.map((g) => { const a = { ...heldRead(ctx, assess(ws, ctx, g, snap)) }; delete a.next; return a; });
  // Every intent a decision makes, its buy and each sell attempt, to its request.
  const owner = new Map();
  for (const r of reqs) {
    const d = { decision_id: r.decision_id, decided_at: r.decided_at };
    owner.set(intentIdOf(d, 'open'), { r, purpose: 'open' });
    for (const n of closeNumbers()) for (const epoch of [null, ctx.epoch]) owner.set(intentIdOf(d, closePurpose(n, epoch)), { r, purpose: 'close' });
  }
  for (const i of snap.list) {
    const o = i.side === 'CLOSE_LONG' ? owner.get(String(i.position_id).replace(/^pos-/, '')) : null;
    if (o && !owner.has(i.intent_id)) owner.set(i.intent_id, { r: o.r, purpose: 'close' });
  }
  const whose = (intentId) => {
    const o = owner.get(intentId);
    return o ? { project_id: o.r.project_id, project: o.r.project, decision_id: o.r.decision_id, action: o.r.action, purpose: o.purpose, request_pair: o.r.pair } : { project_id: null, project: null, decision_id: null, action: null, purpose: null, request_pair: null };
  };
  const intents = snap.list;
  const byOrder = new Map(intents.filter((i) => i.client_order_id).map((i) => [i.client_order_id, i]));
  const OR = require('./tickets').openingReceipt;
  const openings = openingLines(ws);
  const ofPosition = (p) => ({ ...p, ...whose(String(p.position_id).replace(/^pos-/, '')), exit_words: p.exits && p.exits.length ? exitWords(p.exits[p.exits.length - 1]) : null });
  // While an hour is missing, the book's figures are what it has recorded,
  // never a settled account (a fill or a stop may be in the missing hour).
  const st = snap.settlement;
  // What Eric reads to anchor the book: the anchor's state, and this book's own hash.
  const anchor = TR.bookAnchorOf(ws);
  const first = firstLineOf(ws);
  const initWait = res.funded_usd === null && !anchor.may_auto_fund ? [INIT_WORDS] : [];
  const unknown = st.state === 'unsettled' ? [...res.unknown, `NAV, cash, the results and the drawdowns are recorded balances, not settled${st.settled_through ? ` (settled through ${st.settled_through})` : ''}: ${st.words}`] : res.unknown;
  return {
    version: VERSION,
    now: ctx.now,
    waits: [...waitsOf(ctx), ...initWait],
    ...(ctx.hold ? { restore_hold: holdView(ws, ctx) } : {}),
    book_identity: { anchor: anchor.state, genesis_sha256: first === null ? null : TR.genesisOf(first) },
    allowlist_basis: ctx.s.allowlist_basis,
    settlement: st,
    book: { cash_usd: ctx.s.book.cash_usd || null, fee_rate: ctx.s.book.fee_rate || null },
    venue: { lot: LOT, min_notional_usd: MIN_NOTIONAL_USD },
    results: { ...res, open_positions: res.open_positions.map(ofPosition), closed_positions: res.closed_positions.map(ofPosition), unknown },
    requests: reqs,
    orders: res.orders.map((o) => {
      const i = byOrder.get(o.client_order_id) || {};
      // An opening's receipt, checked against its reservation line and the
      // observation it names (core/opening-receipt.js): null for a close.
      const line = i.side === 'OPEN_LONG' ? openings.get(o.client_order_id) || null : null;
      const opening = i.side !== 'OPEN_LONG' ? null : line ? OR.summaryOf(openingCheck(ws, line)) : { version: OR.CHECK_VERSION, status: 'unverifiable', words: 'This order\'s reservation line was not read with the book; read the view again.', differences: [] };
      return { ...o, intent_id: i.intent_id || null, side: i.side || null, pair: i.pair || null, position_id: i.position_id || null, ...whose(i.intent_id), opening_receipt: opening };
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
  const snap = ctx.snap;
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

// Whether a step has something to do now without new hours (the trader job's
// due check, jobs.js; corrective PR, defect A): an order to recover or
// reconcile, or a request whose next thing (an opening, a cancel, a close)
// is ready. Reads only.
function pending(ws, { now } = {}) {
  const ctx = contextOf(ws, now, null);
  if (ctx.snap.orders.some((o) => ['RESERVED', 'SENT', 'UNKNOWN'].includes(o.state))) return true;
  return ctx.grants.some((g) => Boolean(assess(ws, ctx, g, ctx.snap).next));
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
  if (!TR.bookAnchorOf(ws).may_auto_fund) {
    problems.push({ kind: 'fund', code: 'INIT_REQUIRED', words: INIT_WORDS });
    return false;
  }
  try {
    const f = underAnchor(ws, () => PT.fund(ws, { cash_usd: cash, now: ctx.now }), ctx.fence);
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
  // Held when this read began: nothing is attempted, so nothing read now can be
  // carried past a release.
  if (ctx.hold) {
    problems.push({ kind: 'hold', code: 'RESTORE_HELD', words: HOLD_WORDS });
    return { version: VERSION, now: ctx.now, done, problems, ...requestsOf(ws, ctx, ctx.snap) };
  }
  const attempt = (what, fn) => { try { const r = fn(); done.push({ ...what, status: r.status, state: r.state || null, words: r.words || null, refusals: r.refusals || null }); return r; } catch (err) { problems.push({ ...what, code: err.code || null, words: String(err && err.message || err).slice(0, 300) }); return null; } };
  let snap = ctx.snap;
  if (fundOnce(ws, ctx, done, problems, snap)) snap = snapshotOf(ws, ctx.now);
  // Read again only when recovery or a reconcile was attempted.
  const before = done.length + problems.length;
  if (snap.orders.some((o) => o.state === 'RESERVED' || o.state === 'SENT')) attempt({ kind: 'recover' }, () => underAnchor(ws, () => PT.recover(ws, { now: ctx.now }), ctx.fence));
  else for (const o of snap.orders.filter((x) => x.state === 'UNKNOWN')) attempt({ kind: 'reconcile', client_order_id: o.client_order_id }, () => underAnchor(ws, () => PT.reconcile(ws, o.client_order_id, { now: ctx.now }), ctx.fence));
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
    if (a.next.kind === 'cancel') attempt(what, () => underAnchor(ws, () => PT.cancelOrder(ws, a.next.client_order_id, { now: ctx.now }), ctx.fence));
    else {
      const r = attempt(what, () => underAnchor(ws, () => PT.submitIntent(ws, a.next.intent, { now: ctx.now, rules: ctx.s.rules, venue: ctx.s.venue }), ctx.fence));
      // The book sizes the order itself. Should it reserve another quantity
      // than the one the guard proved (the book moved between the reading and
      // the reservation), the receipt on that reservation is for a different
      // order: said at once, and read as `mismatch` wherever the receipt is
      // checked (core/opening-receipt.js verify). Nothing is cancelled here.
      const rec = a.next.kind === 'open' && r && r.sizing ? require('./tickets').openingReceipt.readFrom(a.next.intent) : null;
      if (rec && !rec.unreadable && r.sizing.quantity !== rec.quantity.final) problems.push({ ...what, code: 'RECEIPT_MISMATCH', words: `The book reserved ${r.sizing.quantity}; this order's opening receipt is for ${rec.quantity.final}. The reservation stands as the book wrote it, and its receipt does not prove it.` });
    }
    snap = snapshotOf(ws, ctx.now);
  }
  // The requests as the book stands after the last thing recorded: snap was
  // read after it. Those reads went beyond the snapshot, so the anchor has the last word.
  const answer = { version: VERSION, now: ctx.now, done, problems, ...requestsOf(ws, ctx, snap) };
  assertAnchor(ws);
  return answer;
}

// Closed hours for the book, one after another (12b hands them in), after
// funding it from Eric's setting if it is not yet funded. The book refuses a
// gap, a changed hour or one before the last; the first refusal of a gap,
// an order or the book's integrity stops the rest of that pair's hours.
function applyHours(ws, bars, { now } = {}) {
  const n = { ...nowOf(now), fence: holdFenceOf(ws) };
  // A held copy applies no hour, so a stop or a target in these hours is not settled
  // until the release, when they apply in order. The hours are not lost to the book.
  if (restoreHoldOf(ws)) return [{ pair: null, hour: null, status: 'refused', code: 'RESTORE_HELD', words: HOLD_WORDS }];
  let anchor;
  try { anchor = assertAnchor(ws); } catch (err) { return [{ pair: null, hour: null, status: 'refused', code: 'INTEGRITY', words: String(err.message) }]; }
  // Before anything is written: hours applied to a lost book would start a new
  // journal in its place. A book that does not read keeps its own refusal below.
  let unfunded = false;
  try { unfunded = PT.results(ws, { now: n.now }).funded_usd === null; } catch (_) { /* said below */ }
  let lost = null;
  if (unfunded) { try { lost = lostBook(ws, n.now); } catch (err) { lost = String(err.message); } }
  if (lost) return [{ pair: null, hour: null, status: 'refused', code: 'INTEGRITY', words: lost }];
  if (unfunded && !anchor.may_auto_fund) return [{ pair: null, hour: null, status: 'refused', code: 'INIT_REQUIRED', words: INIT_WORDS }];
  const problems = [];
  fundOnce(ws, { ...n, s: settingsOf(ws) }, [], problems);
  const out = problems.map((p) => ({ pair: null, hour: null, status: 'refused', code: p.code, words: p.words }));
  const stoppedPairs = new Set();
  for (const b of Array.isArray(bars) ? bars : []) {
    const pair = b && b.pair;
    if (stoppedPairs.has(pair)) { out.push({ pair, hour: b && b.hour, status: 'skipped', words: 'An earlier hour of this pair was refused.' }); continue; }
    // A buy the paper mandate no longer covers for this hour is cancelled
    // before the hour is applied, so the hour cannot fill it; when that
    // cannot be established, the hour waits (corrective PR, defect C).
    const held = revokeBefore(ws, pair, b && b.hour, n, out);
    if (held) { out.push({ pair, hour: b && b.hour, status: 'refused', code: 'AUTHORITY_UNKNOWN', words: held }); stoppedPairs.add(pair); continue; }
    try {
      const r = underAnchor(ws, () => PT.applyBar(ws, b, { now: n.now }), n.fence);
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

// Before an hour of `pair` is applied: each live buy (ACKED or PARTIAL) a
// paper mandate grant made, whose authority does not cover that hour, is
// cancelled now through the book's own cancel (recorded at now, never
// backdated). Expiry covers an hour that ends at or before expires_at; any
// other revocation covers no hour still to apply, since when it began between
// hours is not on record. Returns words when the hour must wait: a decision
// that does not read, or a cancel that fails.
function revokeBefore(ws, pair, hour, n, out) {
  const end = Date.parse(hour) + HOUR;
  if (!Number.isFinite(end)) return null;
  let list;
  try { list = PT.intents(ws); } catch (err) { return `The book's orders could not be read to check the paper mandate's authority (${String(err && err.message || err).slice(0, 160)}); the hour waits.`; }
  const live = list.filter((i) => i && i.pair === pair && i.side === 'OPEN_LONG' && (i.state === 'ACKED' || i.state === 'PARTIAL'));
  if (!live.length) return null;
  const T = require('./tickets');
  // The book's orders name no project or decision, only the intent (made from
  // the decision, intentIdOf) and the ticket (thesis_id): each live buy is
  // matched to the mandate grant whose opening it is, across every project's
  // decisions. Any history that does not read makes it unknown: the hour
  // waits (corrective PR 2026-10-31; this read the book's orders for fields
  // they do not carry, so no grant's buy was ever matched).
  let grantOf;
  try { grantOf = mandateOpenings(ws, T); } catch (err) {
    return `The decisions behind ${pair}'s live buys could not be read (${String(err && err.message || err).slice(0, 160)}), so whether the paper mandate covers them is unknown; the hour waits.`;
  }
  for (const i of live) {
    const d = grantOf.get(i.intent_id) || null;
    if (!d || d.receipt_id !== i.thesis_id) continue;
    const auth = T.grantAuthority(ws, d, { now: n.t, asOfMs: end });
    if (auth.ok) continue;
    try {
      const r = underAnchor(ws, () => PT.cancelOrder(ws, i.client_order_id, { now: n.now }), n.fence);
      out.push({ pair, hour, status: 'cancelled', client_order_id: i.client_order_id, decision_id: d.decision_id, code: auth.code, words: `Before the hour ${hour}: the paper mandate no longer covers ${i.client_order_id} (${auth.words}); its unfilled part is cancelled (${r.status}).` });
    } catch (err) {
      return `${i.client_order_id} could not be cancelled after the paper mandate's authority ended (${String(err && err.message || err).slice(0, 160)}); the hour waits so it cannot fill.`;
    }
  }
  return null;
}

// Each paper mandate grant's opening intent ID (intentIdOf(d, 'open')) to its
// decision, over every project on the desk, a broken one included (its
// decisions are read by its folder's ID). Throws when a history does not read.
function mandateOpenings(ws, T) {
  const out = new Map();
  for (const p of require('./projects').listProjects(ws)) {
    for (const l of T.readDecisionsStrict(ws, p.project_id)) if (byMandate(l) && (l.action === 'approve' || l.action === 'halve')) out.set(intentIdOf(l, 'open'), l);
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

const JOURNAL = PT.JOURNAL;

// One reservation line's opening receipt, checked against the records it
// names (tickets.js openingReceipt.check, over core/opening-receipt.js
// verify). The receipt's own module is reached through tickets.js, the one
// contract module this adapter requires (tests/trader-boundary.test.js).
const openingCheck = (ws, line) => require('./tickets').openingReceipt.check(ws, line);

// Every opening's reservation line in the journal, by client order ID, for
// the trader view's order rows. The journal is append-only and is read here
// after the book's own validated read of it in the same bracketed read
// (anchoredRead), so every order that read lists has its line here.
function openingLines(ws) {
  let text;
  try { text = fs.readFileSync(ws.abs(PT.JOURNAL), 'utf8'); } catch (_) { return new Map(); }
  const out = new Map();
  for (const l of text.split('\n')) {
    if (!l.includes('"reserved"')) continue;
    let e;
    try { e = JSON.parse(l); } catch (_) { continue; }
    if (e && e.type === 'reserved' && e.intent && e.intent.side === 'OPEN_LONG' && e.client_order_id) out.set(e.client_order_id, e);
  }
  return out;
}

// One decision's execution as the book recorded it, for the read-only
// decision basis view (core/decision-basis.js), read only through the book's
// own integrity checks (audit F5). In one consistent read: the venue's
// records, the head and the journal as bytes, in the book's own read order
// (paper-trader.js load); then the book's validated read (PT.intents: the
// hash chain line by line, the head record, every venue order sent) over
// exactly those bytes, through a view of the workspace whose three files are
// that snapshot (N4: the files read again after the book's read could match
// the snapshot while the book had read another version, A then B then A, so
// the values shown would be ones the book never checked); then the three
// files again, which must still be the snapshot. Every value shown comes from
// the snapshot the book validated. A damaged journal is the book's own
// INTEGRITY refusal, thrown, never a partial or empty reading. Each
// reservation shown must be one the book holds with the same order, position
// and quantity. Nothing in the workspace is written (the snapshot is a
// temporary copy outside it, fsx withSnapshot, removed at once), and the book
// is unchanged.
function executionFor(ws, decisionId) {
  const fs = require('fs');
  const { readConsistent } = require('./ops');
  const { withSnapshot } = require('./fsx');
  const RELS = [PT.VENUE, PT.HEAD, PT.JOURNAL];
  // The book's validated read of exactly these bytes (null: the file is missing).
  const validatedRead = (snap) => withSnapshot(ws, RELS.map((rel, i) => [rel, snap[i]]), (view) => PT.intents(view));
  const bytes = () => RELS.map((rel) => {
    try { return fs.readFileSync(ws.abs(rel)); } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      throw new OpError('INTEGRITY', `${rel} could not be read (${(err && err.code) || 'error'}). Nothing is read or written until it is repaired.`);
    }
  });
  const same = (a, b) => (a === null ? b === null : b !== null && a.equals(b));
  return readConsistent(ws, () => {
    const snap = bytes();
    assertAnchor(ws, snap[RELS.indexOf(PT.JOURNAL)]);
    const book = validatedRead(snap);
    const after = bytes();
    if (!snap.every((b, i) => same(b, after[i]))) throw new OpError('INTEGRITY', `${PT.JOURNAL} changed while it was read, so its execution is not shown from a mix of two versions. Read it again.`);
    const journal = snap[RELS.indexOf(PT.JOURNAL)];
    if (journal === null) {
      const lost = lostBook(ws, new Date().toISOString());
      if (lost) throw new OpError('INTEGRITY', lost);
      return { state: 'no_book', reserved: [], fills: [], exits: [] };
    }
    const events = journal.toString('utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    const held = new Map(book.map((i) => [i.intent_id, i]));
    const out = { reserved: [], fills: [], exits: [] };
    const coids = new Set();
    const positions = new Set();
    for (const e of events) {
      if (e.type !== 'reserved' || !e.intent || e.intent.decision_id !== decisionId) continue;
      const b = held.get(e.intent_id);
      if (!b || b.client_order_id !== e.client_order_id || (b.position_id || null) !== (e.position_id || null) || b.quantity !== e.quantity) throw new OpError('INTEGRITY', `${PT.JOURNAL} reserves ${e.client_order_id} for ${decisionId}, but the book does not hold that order as recorded. Nothing is shown until it is repaired.`);
      coids.add(e.client_order_id);
      if (e.position_id) positions.add(e.position_id);
      // An opening's receipt as its reservation line carries it, and that
      // receipt checked against the line (core/opening-receipt.js): null for a
      // close. Both come from the bytes the book validated above.
      const opening = e.intent.side === 'OPEN_LONG' ? openingCheck(ws, e) : null;
      out.reserved.push({ at: e.at, intent_id: e.intent_id, intent_sha256: e.intent_sha256 || null, side: e.intent.side || null, entry_price: e.intent.entry_price || null, client_order_id: e.client_order_id, position_id: e.position_id || null, quantity: e.quantity, notional_usd: e.notional_usd || null, loss_at_stop_usd: e.loss_at_stop_usd || null, valid_until_effective: e.valid_until_effective || null, venue: e.venue || null, grant: e.grant || null, contract_guard: opening ? opening.record : null, opening_receipt: opening ? { version: opening.version, status: opening.status, words: opening.words, differences: opening.differences } : null });
    }
    for (const e of events) {
      if (e.type === 'fill' && coids.has(e.client_order_id)) out.fills.push({ at: e.at, hour: e.hour, client_order_id: e.client_order_id, quantity: e.quantity, price: e.price, notional_usd: e.notional_usd, fee_usd: e.fee_usd, fee_kind: e.fee_kind });
      if (e.type === 'exit' && positions.has(e.position_id)) out.exits.push({ at: e.at, hour: e.hour, position_id: e.position_id, reason: e.reason, quantity: e.quantity, price: e.price, proceeds_usd: e.proceeds_usd, fee_usd: e.fee_usd });
    }
    return { state: out.reserved.length ? 'recorded' : 'none', ...out };
  });
}

// The desk's reads of the book as the rest of the code calls them: each whole read,
// beyond its snapshot (the engine's book for each request), is bracketed.
const anchoredRead = (read) => (ws, ...rest) => readAnchored(ws, () => read(ws, ...rest));

module.exports = { rulingsNeeded: anchoredRead(rulingsNeeded), holdFenceOf, restoreHoldOf, closePurpose, releaseEpochOf, HOLD_WORDS, bootstrapBook, bootstrapWords, VERSION, JOURNAL, OPENS, QUOTE, LOT, MIN_NOTIONAL_USD, SLIPPAGE_BPS, CLOSE_ATTEMPTS_MAX, GAPS_REL, GAP_VERSION, SOURCES_REL, intentIdOf, plain, closeLimit, fit, settingsOf, allowlistOf, sourceBindings, sourceBindingOf, pairOf, planOf, horizonOf, settlementOf, requests: anchoredRead(requests), view: anchoredRead(view), wanted: anchoredRead(wanted), pending: anchoredRead(pending), step, applyHours, executionFor };
