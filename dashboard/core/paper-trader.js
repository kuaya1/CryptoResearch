'use strict';
// The trader's Paper Book, cr-paper@2 (backlog item 74; Junior Trader Desk
// invariants 2, 4 and 5, Eric 2026-10-27; the architecture recovery's PR E).
//
// What the trader agent's intents would have done, in a simulated book that
// never touches a real venue, an account or money. It lives beside the PM Paper Book
// (cr-paper@1, core/paper.js), which keeps measuring Eric's ticket decisions
// exactly as before: paper.js is not edited, and nothing here enters
// paper/positions.jsonl, its counts or Portfolio. No route, CLI, connector
// tool or UI calls it yet.
//
// Records, append-only, written through runOp and re-derived from disk on
// every call (no state is kept in memory between calls):
//   paper/trader/journal.jsonl  the engine's record: the funding, every
//       intent and its verdict, each order's states, the hours applied and
//       the fills and exits they made, and NAV at each hour's end. Each line
//       carries the SHA-256 of the line before it; a broken chain refuses
//       every read and write (INTEGRITY).
//   paper/trader/venue.jsonl    the simulated venue's own record of what it
//       accepted or rejected, by client order ID: what a reconciliation asks.
//       It is created with the first reservation; once the book holds an
//       order, a missing file or a line that does not read is INTEGRITY, and
//       no order is resolved from it.
//   paper/trader/journal.head.json  the journal's head (D7, Eric 2026-10-28):
//       the number and SHA-256 of its last line, written after it in the same
//       commit. A chain that lost its last lines is still a valid chain, so
//       a journal shorter than its head, a line that does not hash to it, or
//       lines with no head is INTEGRITY: nothing is read or written. A
//       journal longer than its head, the chain intact, is read, and the head
//       moves forward with the next write. Only a missing file reads as
//       empty; any other read error stops. Every client order ID the venue
//       holds must be one the journal reserved and sent; a venue order the
//       journal does not know is INTEGRITY. No key is held: this catches a
//       crash, a full disk, a one-file restore or a hand edit, not someone
//       who rewrites the files consistently. Made before any record exists
//       under this version, as the red team's corrections were.
//
// One intent, one order: the client order ID is derived from intent_id; the
// same intent again is `unchanged`, a different body under its ID refused,
// and the venue refuses a client order ID it already holds with another
// body. Orders move RESERVED -> SENT -> ACKED | REJECTED | UNKNOWN, then ACKED
// -> PARTIAL -> FILLED | CANCELLED | EXPIRED (invariant 4). Only an order
// recorded as SENT, read under the workspace lock, goes to the venue. After a
// crash, `recover` makes an order reserved or sent with no outcome on record
// UNKNOWN (another process may have sent it: it is never cancelled blind and
// never sent late) and asks the venue for every UNKNOWN order. UNKNOWN never
// times out: only a reconciliation, asking the venue for that client order
// ID, resolves it, to the venue's answer when it has one, to NOT_FOUND only
// when it has none and its duplicate-order window has passed. Nothing is
// resent under a new ID, and while an order is unresolved the risk engine
// refuses every new intent.
//
// The simulation (the cr-paper@2 blueprint):
//   - cash NAV: the book starts from the cash Eric funds it with (unfunded,
//     NAV is unknown and every intent is refused); NAV is cash plus each open
//     quantity at its pair's latest hourly close no older than
//     NAV_PRICE_FRESH_MINUTES, else unknown, never valued at 0 or at entry;
//   - sizes from cr-trade-risk@2 (floored to the lot, every cost in), with
//     the planned loss already at the stops counted against the 24-hour
//     ceiling and the thesis's grant; an order's cash and fee are committed
//     at its limit when it is reserved, so cash never goes negative;
//   - an order fills only from hours that start at or after it was sent; a
//     limit buy fills only when an hour's low trades below its limit, at the
//     limit or at the hour's open when that is lower, at most FILL_SHARE_MAX
//     of the hour's volume; the rest stays open as a partial fill until it
//     fills, is cancelled or expires. An order whose life ends before an
//     hour's end expires before that hour can fill it;
//   - fees from the venue's schedule frozen with the order: POST_ONLY pays
//     the maker fee, everything else the taker fee, exits the taker fee; an
//     unknown fee refuses; the venue rejects a POST_ONLY that would cross;
//   - stops and targets against each hour's high and low: a stop fills
//     STOP_SLIPPAGE_BPS below the stop, or at the open when the hour opened
//     through it, never better; a target or a close at its price, or at the
//     open when the hour opened above it, so no fill is outside the hour's
//     range; when one hour reaches both, the stop is taken; an hour that
//     fills a buy checks its stop, never its target (the order of events
//     within the hour is unknown, so the worse outcome);
//   - for a pair with exposure, hours apply one after another with none
//     missing, so no stop, target or fill is skipped;
//   - exits and closes fill whole (a stated simplification); a close is
//     refused while the buy that opened its position is still live, and
//     never sells more than its order; long only.
// Fees and losses round against the trader; sizes never round up.
//
// The grant (D8, Eric 2026-10-28). A cr.trade-intent.v3 names its ticket: the
// desk project, the ticket receipt (its thesis) and Eric's PM decision. The
// book reads that decision from the desk's own record of them,
// projects/<project_id>/tickets/decisions.jsonl, under the same lock as the
// reservation, and never takes a grant from its caller (a ctx.grant is
// refused, nothing written). The decision is a grant only while it is the one
// in force for its receipt (the desk's rule, core/tickets.js decisionFor) and
// an approve or a halve above $0; the grant is then exactly its
// pm_approved_risk_usd and suggested_risk_usd. A veto, pass or watch, an
// undone or replaced decision, a missing record or a line that does not read
// is no grant, with its reason. A close reads none: it only reduces risk.

const fs = require('fs');
const { runOp, readConsistent, OpError } = require('./ops');
const { sha256 } = require('./fsx');
const { isProjectId } = require('./ids');
// Taken once, at load (red team P2-13): the engine's exports are frozen, and
// nothing that changes them later reaches this book.
const { validateTradeIntent, exact: { dec, str, mulFloor, mulCeil, isoMs, own } } = require('./trade-risk');

const VERSION = 'cr-paper@2';
const JOURNAL = 'paper/trader/journal.jsonl';
const VENUE = 'paper/trader/venue.jsonl';
const HEAD = 'paper/trader/journal.head.json';
const FILL_SHARE_MAX = '0.1';
const STOP_SLIPPAGE_BPS = 25;
const VENUE_DUPLICATE_WINDOW_MINUTES = 60;
const NAV_PRICE_FRESH_MINUTES = 120;
const HOUR = 3600000;
const MIN = 60000;
const BPS = 10000n;
const ONE = 10n ** 18n;
// Orders that still hold their committed cash: they may yet fill.
const LIVE = ['RESERVED', 'SENT', 'ACKED', 'PARTIAL', 'UNKNOWN'];
const BAR_FIELDS = ['open', 'high', 'low', 'close', 'volume'];
// What the venue holds for a client order ID: one ID is one order.
const BODY_FIELDS = ['pair', 'side', 'order_type', 'limit', 'quantity'];
// Eric's PM decisions as the desk records them (core/tickets.js decide).
const DECISION_VERSION = 'cr.ticket-decision.v1';
const GRANTS = ['approve', 'halve'];
const decisionsOf = (pid) => `projects/${pid}/tickets/decisions.jsonl`;

function msOf(s, what = 'now') {
  const v = isoMs(s);
  if (v === null) throw new OpError('INVALID', `${what} is not an ISO-8601 UTC time.`);
  return Number(v);
}
const iso = (ms) => new Date(ms).toISOString();
const orNull = (v) => (v === null ? null : str(v));
const commitOf = (q, price, rate) => { const n = mulCeil(q, price); return n + mulCeil(n, rate); };
const lower = (a, b) => (a < b ? a : b);
const higher = (a, b) => (a > b ? a : b);
// Keys sorted, so the same intent hashes the same however its keys were ordered.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
const lines = (text) => String(text).split('\n').filter((l) => l.trim());

function parseJournal(text) {
  const events = [];
  let head = null;
  for (const line of lines(text)) {
    let e = null;
    try { e = JSON.parse(line); } catch (_) { /* refused below */ }
    if (!e || e.seq !== events.length + 1 || e.prev_sha256 !== head) throw new OpError('INTEGRITY', `${JOURNAL} line ${events.length + 1} does not follow the line before it. Nothing is read or written until it is repaired.`);
    head = sha256(line);
    events.push(e);
  }
  return { events, head };
}

// Only a missing file reads as `missing`; any other read error stops, so an
// unreadable journal is never a fresh, unfunded book (D7).
function readText(ws, rel, missing = '') {
  try { return fs.readFileSync(ws.abs(rel), 'utf8'); } catch (err) {
    if (err && err.code === 'ENOENT') return missing;
    throw new OpError('INTEGRITY', `${rel} could not be read (${(err && err.code) || 'error'}). Nothing is read or written until it is repaired.`);
  }
}

const stopped = (why) => new OpError('INTEGRITY', `${why} Nothing is read or written until it is repaired.`);

// The journal against its head; `headText` is null when there is none.
function checkHead(text, headText, parsed) {
  const n = parsed.events.length;
  if (headText === null) {
    if (n) throw stopped(`${JOURNAL} has ${n} lines but its head record (${HEAD}) is missing, so lines lost from its end could not be detected.`);
    return;
  }
  let h = null;
  try { h = JSON.parse(headText); } catch (_) { /* refused below */ }
  if (!h || typeof h !== 'object' || !Number.isSafeInteger(h.seq) || h.seq < 1 || typeof h.head_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(h.head_sha256)) throw stopped(`${HEAD} does not read, so the end of ${JOURNAL} cannot be checked.`);
  if (n < h.seq) throw stopped(`${JOURNAL} ends at line ${n}, but its head record names line ${h.seq}: lines were lost from its end.`);
  if (sha256(lines(text)[h.seq - 1]) !== h.head_sha256) throw stopped(`${JOURNAL} line ${h.seq} is not the line its head record names.`);
}

// Every order the venue holds is one the journal reserved and sent. A venue
// line that does not read is left to venueRecords, where the venue is asked:
// the order it would answer for stays UNKNOWN.
function checkVenue(events, venueText) {
  if (venueText === null) return;
  const seen = (type) => new Set(events.filter((e) => e.type === type).map((e) => e.client_order_id));
  const reserved = seen('reserved');
  const sent = seen('sent');
  for (const l of lines(venueText)) {
    let r = null;
    try { r = JSON.parse(l); } catch (_) { continue; }
    if (!r || typeof r.client_order_id !== 'string') continue;
    if (!sent.has(r.client_order_id)) throw stopped(`The venue holds ${r.client_order_id}, which ${JOURNAL} never ${reserved.has(r.client_order_id) ? 'sent' : 'reserved'}: the journal has lost lines.`);
  }
}

// The journal, checked against its head and the venue's record. The venue is
// read first and the journal last, so a commit landing between the reads can
// only leave the journal newer than what it is checked against.
function load(read) {
  const venue = read(VENUE, null);
  const head = read(HEAD, null);
  const text = read(JOURNAL, '');
  const parsed = parseJournal(text);
  checkHead(text, head, parsed);
  checkVenue(parsed.events, venue);
  return { text, parsed };
}
const loadOp = (op) => load((rel, missing) => op.readText(rel, missing));
const loadWs = (ws) => readConsistent(ws, () => load((rel, missing) => readText(ws, rel, missing)));
// The venue's records, every line of them: a line that does not read is
// INTEGRITY, never skipped, so a lost answer is never read as no answer.
function venueRecords(text) {
  if (text === null) throw new OpError('INTEGRITY', `${VENUE} is missing though the book holds orders, so the venue's answers are unknown. No order is sent or resolved from it until it is repaired.`);
  return lines(text).map((l, i) => {
    let r = null;
    try { r = JSON.parse(l); } catch (_) { /* refused below */ }
    if (!r || typeof r !== 'object' || typeof r.client_order_id !== 'string') throw new OpError('INTEGRITY', `${VENUE} record ${i + 1} does not read, so the venue's answers are unknown. No order is sent or resolved from it until it is repaired.`);
    return r;
  });
}
const bodyOf = (o) => ({ pair: o.pair, side: o.side, order_type: o.order_type, limit: str(o.limit), quantity: str(o.quantity) });
const sameBody = (rec, o) => { const b = bodyOf(o); return BODY_FIELDS.every((k) => rec[k] === b[k]); };

// --- The grant, from Eric's stored decision (D8).

// The decision in force for a receipt: the last of its lines that no undo
// takes back. The desk's own rule (core/tickets.js decisionFor), kept here
// because the trader requires nothing of the desk; trader-boundary checks
// that the two agree.
function decisionInForce(ls, rid) {
  const mine = ls.filter((l) => l.receipt_id === rid);
  const undone = new Set(mine.filter((l) => l.action === 'undo').map((l) => l.undoes));
  return mine.filter((l) => l.action !== 'undo' && !undone.has(l.decision_id)).pop() || null;
}
// A stored amount (the desk writes numbers) as its exact decimal text, else null.
const amountOf = (n) => (typeof n === 'number' && dec(String(n)) !== null ? String(n) : null);

// The grant of the decision an intent names, read with `read` (a file's text,
// or null when it is missing): { grant, why }, the grant null with its reason
// whenever it is not one.
function grantOf(read, ids) {
  const { project_id: pid, receipt_id: rid, decision_id: did } = ids && typeof ids === 'object' ? ids : {};
  const none = (why) => ({ grant: null, why });
  if (!isProjectId(pid)) return none('The intent names no desk project, so no decision of Eric\'s can be read for it.');
  if (typeof rid !== 'string' || !rid || typeof did !== 'string' || !did) return none('The intent names no ticket receipt or no decision, so no decision of Eric\'s can be read for it.');
  const rel = decisionsOf(pid);
  let text;
  try { text = read(rel); } catch (_) { return none(`${rel} could not be read, so the decision in force is unknown.`); }
  if (text === null) return none(`No decision of Eric's is on record for ${pid}.`);
  const ls = [];
  for (const [i, l] of lines(text).entries()) {
    let d = null;
    try { d = JSON.parse(l); } catch (_) { /* refused below */ }
    // The desk skips such a line; here it refuses, since an undo it held
    // could leave a grant standing.
    if (!d || typeof d !== 'object' || Array.isArray(d)) return none(`${rel} line ${i + 1} does not read, so the decision in force is unknown.`);
    ls.push(d);
  }
  const named = ls.find((l) => l.receipt_id === rid && l.decision_id === did && l.action !== 'undo');
  if (!named) return none(`Decision ${did} is not on record for ticket ${rid}.`);
  const now = decisionInForce(ls, rid);
  if (!now || now.decision_id !== did) {
    const undone = ls.some((l) => l.receipt_id === rid && l.action === 'undo' && l.undoes === did);
    return none(`Decision ${did} is not in force for ticket ${rid}: ${undone ? 'it was undone' : `${now.action} ${now.decision_id} replaced it`}.`);
  }
  if (now.schema_version !== DECISION_VERSION || now.project_id !== pid) return none(`Decision ${did} is not a ${DECISION_VERSION} decision on ${pid}.`);
  if (!GRANTS.includes(now.action)) return none(`Decision ${did} is a ${now.action}: only an approve or a halve grants risk.`);
  const approved = amountOf(now.pm_approved_risk_usd);
  const suggested = amountOf(now.suggested_risk_usd);
  if (approved === null || suggested === null) return none(`Decision ${did} does not state its approved and suggested risk as amounts.`);
  if (dec(approved) === 0n) return none(`Decision ${did} approves $0, so no risk is allowed.`);
  return { grant: { thesis_id: rid, project_id: pid, receipt_id: rid, decision_id: did, action: now.action, suggested_risk_usd: suggested, pm_approved_risk_usd: approved }, why: null };
}

// What an intent's ticket gives the book: its thesis, and for an OPEN_LONG
// the grant. A close reads no grant: it only reduces risk.
function ticketOf(read, it) {
  const thesis = it && typeof it.thesis_id === 'string' ? it.thesis_id : null;
  if (!it || it.side !== 'OPEN_LONG') return { thesis, grant: null, why: null };
  return { thesis, ...grantOf(read, it) };
}

function noCallerGrant(ctx) {
  if (ctx && ctx.grant !== undefined) throw new OpError('INVALID', 'A grant is never taken from the caller: the Paper Book reads it from Eric\'s stored PM decision (cr-trade-risk@2). Nothing was read or written.');
}

// --- The state, replayed from the journal.

function replay(events) {
  const st = { funded: null, funded_at: null, cash: 0n, intents: new Map(), orders: new Map(), positions: new Map(), bars: new Map(), marks: [], realized: 0n, fees: 0n, last_at: null };
  for (const e of events) applyEvent(st, e);
  return st;
}

function applyEvent(st, e) {
  const o = e.client_order_id ? st.orders.get(e.client_order_id) : null;
  switch (e.type) {
    case 'funded':
      st.funded = dec(e.cash_usd); st.cash = st.funded; st.funded_at = e.at;
      break;
    case 'refused':
      st.intents.set(e.intent_id, { intent_sha256: e.intent_sha256, refusals: e.refusals });
      break;
    case 'reserved': {
      const i = e.intent;
      st.orders.set(e.client_order_id, {
        client_order_id: e.client_order_id, intent_id: e.intent_id, thesis_id: i.thesis_id, side: i.side, pair: i.pair, order_type: i.order_type, position_id: e.position_id,
        limit: dec(i.entry_price), stop: dec(i.stop_loss_price), take_profit: dec(i.take_profit_price), quantity: dec(e.quantity), filled: 0n,
        per_unit_loss: dec(e.per_unit_loss_usd), fee_rate: dec(e.venue.fee_rate), venue: e.venue, valid_until: Date.parse(e.valid_until_effective),
        state: 'RESERVED', reserved_at: e.at, sent_at: null, live_from: null, words: null,
      });
      st.intents.set(e.intent_id, { intent_sha256: e.intent_sha256, refusals: null });
      break;
    }
    // An order fills only from hours that start at or after it was sent.
    case 'sent': o.state = 'SENT'; o.sent_at = e.at; o.live_from = Date.parse(e.at); break;
    case 'answer': o.state = e.answer === 'accepted' ? 'ACKED' : 'REJECTED'; o.words = e.words; break;
    case 'unknown': o.state = 'UNKNOWN'; o.words = e.words; break;
    case 'reconciled':
      o.state = e.state; o.words = e.words;
      if (e.state === 'ACKED' && o.live_from === null) o.live_from = Date.parse(e.venue_at || e.at);
      break;
    case 'cancelled': o.state = 'CANCELLED'; o.words = e.words; break;
    case 'expired': o.state = 'EXPIRED'; o.words = e.words; break;
    case 'bar': {
      const list = st.bars.get(e.pair) || [];
      const b = { t: Date.parse(e.hour) };
      for (const f of BAR_FIELDS) b[f] = dec(e[f]);
      b.key = [e.pair, b.t, ...BAR_FIELDS.map((f) => e[f])].join('|');
      list.push(b);
      st.bars.set(e.pair, list);
      break;
    }
    case 'fill': {
      const q = dec(e.quantity);
      const cost = dec(e.notional_usd) + dec(e.fee_usd);
      o.filled += q;
      o.state = o.filled === o.quantity ? 'FILLED' : 'PARTIAL';
      st.cash -= cost;
      st.fees += dec(e.fee_usd);
      const p = st.positions.get(e.position_id) || { position_id: e.position_id, intent_id: o.intent_id, thesis_id: o.thesis_id, pair: o.pair, stop: o.stop, take_profit: o.take_profit, per_unit_loss: o.per_unit_loss, exit_fee_rate: dec(o.venue.taker_rate), quantity: 0n, notional: 0n, cost: 0n, realized: 0n, exits: [], opened_at: e.at };
      p.quantity += q; p.notional += dec(e.notional_usd); p.cost += cost; p.state = 'open';
      st.positions.set(e.position_id, p);
      break;
    }
    case 'exit': {
      const p = st.positions.get(e.position_id);
      const fee = dec(e.fee_usd);
      const pnl = dec(e.proceeds_usd) - fee - p.cost;
      st.cash += dec(e.proceeds_usd) - fee;
      st.fees += fee;
      st.realized += pnl;
      p.realized += pnl;
      p.exits.push({ hour: e.hour, reason: e.reason, quantity: e.quantity, price: e.price, realized_pnl_usd: str(pnl) });
      p.quantity = 0n; p.notional = 0n; p.cost = 0n; p.state = 'closed'; p.closed_at = e.at;
      if (o) { o.filled = o.quantity; o.state = 'FILLED'; }
      break;
    }
    case 'mark': st.marks.push({ t: Date.parse(e.hour_end), nav: dec(e.nav_usd) }); break;
    default: throw new OpError('INTEGRITY', `${JOURNAL} holds an event ${VERSION} does not know: ${e.type}.`);
  }
  st.last_at = e.at;
}

const committed = (st) => [...st.orders.values()].filter((o) => o.side === 'OPEN_LONG' && LIVE.includes(o.state)).reduce((s, o) => s + commitOf(o.quantity - o.filled, o.limit, o.fee_rate), 0n);

// The planned loss at the stops of what is open, every cost in: each open
// position, and the unfilled part of each live buy; for one thesis, or the
// whole book. Unknown when any of them is.
function openRisk(st, thesis = null) {
  let sum = 0n;
  for (const p of st.positions.values()) {
    if (p.state !== 'open' || (thesis !== null && p.thesis_id !== thesis)) continue;
    if (p.per_unit_loss === null) return null;
    sum += mulCeil(p.quantity, p.per_unit_loss);
  }
  for (const o of st.orders.values()) {
    if (o.side !== 'OPEN_LONG' || !LIVE.includes(o.state) || (thesis !== null && o.thesis_id !== thesis)) continue;
    if (o.per_unit_loss === null) return null;
    sum += mulCeil(o.quantity - o.filled, o.per_unit_loss);
  }
  return sum;
}

// A pair's latest hour ended by t and within the freshness window, else null.
function freshBar(st, pair, t) {
  const list = st.bars.get(pair) || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const end = list[i].t + HOUR;
    if (end > t) continue;
    return t - end <= NAV_PRICE_FRESH_MINUTES * MIN ? list[i] : null;
  }
  return null;
}
function freshClose(st, pair, t) {
  const b = freshBar(st, pair, t);
  return b === null ? null : b.close;
}

function navAt(st, t) {
  if (st.funded === null) return null;
  let nav = st.cash;
  for (const p of st.positions.values()) {
    if (p.state !== 'open') continue;
    const c = freshClose(st, p.pair, t);
    if (c === null) return null;
    nav += mulFloor(p.quantity, c);
  }
  return nav;
}

// From the highest NAV of the last 24 hours (each hour's end, and now) to
// NAV now; unknown when any of them is.
function drawdown24(st, t) {
  const now = navAt(st, t);
  if (now === null) return null;
  let high = now;
  for (const m of st.marks) {
    if (m.t <= t - 24 * HOUR || m.t > t) continue;
    if (m.nav === null) return null;
    if (m.nav > high) high = m.nav;
  }
  return high - now;
}

// The 14-hour ATR from 15 consecutive hours, the last of them fresh; rounded up.
function atr14(st, pair, t) {
  const done = (st.bars.get(pair) || []).filter((b) => b.t + HOUR <= t);
  if (done.length < 15) return null;
  const w = done.slice(-15);
  if (t - (w[14].t + HOUR) > NAV_PRICE_FRESH_MINUTES * MIN) return null;
  let sum = 0n;
  for (let i = 1; i < 15; i++) {
    if (w[i].t - w[i - 1].t !== HOUR) return null;
    const pc = w[i - 1].close;
    const ranges = [w[i].high - w[i].low, w[i].high - pc, pc - w[i].low];
    sum += ranges.reduce((a, x) => (x > a ? x : a), 0n);
  }
  return (sum + 13n) / 14n;
}

// The book cr-trade-risk@2 reads, for one pair, with each unknown in words.
// The thesis whose open risk it carries, and its grant, are the ticket's
// (ticketOf), never the caller's.
function bookFor(st, pair, ctx, ticket) {
  const t = msOf(ctx.now);
  const v = ctx.venue && typeof ctx.venue === 'object' ? ctx.venue : {};
  const thesis = ticket.thesis;
  const fresh = freshBar(st, pair, t);
  const book = {
    now: ctx.now,
    nav_usd: orNull(navAt(st, t)),
    cash_usd: st.funded === null ? null : str(st.cash),
    available_cash_usd: st.funded === null ? null : str(st.cash - committed(st)),
    drawdown_24h_usd: orNull(drawdown24(st, t)),
    open_risk_usd: orNull(openRisk(st)),
    thesis_risk_usd: thesis === null ? null : orNull(openRisk(st, thesis)),
    price: fresh === null ? null : str(fresh.close),
    price_at: fresh === null ? null : iso(fresh.t + HOUR),
    atr_14h: orNull(atr14(st, pair, t)),
    lot: v.lot,
    min_notional_usd: v.min_notional_usd,
    fees: { maker_rate: v.maker_rate, taker_rate: v.taker_rate },
    stop_slippage_bps: STOP_SLIPPAGE_BPS,
    exit_max_usd: ctx.exit_max_usd,
    grant: ticket.grant,
    positions: [...st.positions.values()].filter((p) => p.state === 'open').map((p) => ({ position_id: p.position_id, pair: p.pair, state: 'open', quantity: str(p.quantity) })),
    orders: [...st.orders.values()].map((o) => ({ client_order_id: o.client_order_id, state: o.state })),
  };
  const fr = `${NAV_PRICE_FRESH_MINUTES} minutes`;
  book.unknown = [
    st.funded === null && 'The book is not funded, so its NAV is unknown.',
    st.funded !== null && book.nav_usd === null && `An open position has no hourly price within ${fr}, so NAV is unknown.`,
    book.nav_usd !== null && book.drawdown_24h_usd === null && `An hour of the last 24 has no NAV, so the 24-hour drawdown is unknown.`,
    book.open_risk_usd === null && 'An open position or live order has no planned loss at its stop, so the risk already open is unknown.',
    thesis !== null && book.open_risk_usd !== null && book.thesis_risk_usd === null && 'The risk this thesis already holds at its stops is unknown.',
    book.price === null && `${pair} has no hourly price within ${fr}.`,
    book.atr_14h === null && `${pair} has no 15 consecutive hours ending within ${fr}, so its 14-hour ATR is unknown.`,
    ticket.why,
  ].filter(Boolean);
  return book;
}

// --- Writes: one journal operation each, under the workspace lock.

// Each operation's own identity (red team P1-6). Inside a queued request,
// runOp keys an operation by the request ID and its type, so one type for
// every write made every later write of the request a replay of the first.
// The type names the step, its subject, the time and the journal's head as
// it stood, so only a true replay of the same write matches.
function opType(ws, step, subject, now) {
  const ls = lines(readText(ws, JOURNAL));
  const head = ls.length ? sha256(ls[ls.length - 1]) : 'empty';
  return `paper_trader.${step}.${sha256(`${step}|${subject}|${now}|${head}`).slice(0, 16)}`;
}

function journal(ws, step, subject, summary, now, build) {
  const t = msOf(now);
  return runOp(ws, { type: opType(ws, step, subject, now), summary }, (op) => {
    const { text, parsed } = loadOp(op);
    let head = parsed.head;
    const st = replay(parsed.events);
    if (st.last_at && t < Date.parse(st.last_at)) throw new OpError('TIME', `${now} is earlier than the book's last record (${st.last_at}); the book never goes back in time.`);
    const out = [];
    const append = (type, data) => {
      const e = { seq: parsed.events.length + out.length + 1, at: iso(t), type, ...data, prev_sha256: head };
      const line = JSON.stringify(e);
      applyEvent(st, e);
      head = sha256(line);
      out.push(line);
      return e;
    };
    const result = build({ st, append, op, t });
    if (st.cash < 0n) throw new OpError('INTEGRITY', 'This change would leave cash below 0; nothing was written.');
    if (out.length) {
      op.write(JOURNAL, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${out.join('\n')}\n`);
      // Its head, after it, in the same commit.
      op.write(HEAD, `${JSON.stringify({ seq: parsed.events.length + out.length, head_sha256: head, at: iso(t) })}\n`);
    }
    return result;
  }).result;
}

function orderOf(st, coid) {
  const o = st.orders.get(coid);
  if (!o) throw new OpError('NOT_FOUND', `No order ${coid} in the trader's Paper Book.`);
  return o;
}
const stateOf = (o) => ({ client_order_id: o.client_order_id, state: o.state, filled: str(o.filled), quantity: str(o.quantity), words: o.words });

// Eric's starting cash; once. The same amount again is unchanged.
function fund(ws, { cash_usd, now } = {}) {
  const cash = dec(cash_usd);
  if (cash === null || cash === 0n) throw new OpError('INVALID', 'The starting cash is not a plain decimal string above 0.');
  return journal(ws, 'fund', str(cash), 'Fund the trader\'s Paper Book', now, ({ st, append }) => {
    if (st.funded !== null) {
      if (st.funded === cash) return { status: 'unchanged', cash_usd: str(cash) };
      throw new OpError('CONFLICT', `The book was funded with ${str(st.funded)}; a different amount is never applied over it.`);
    }
    append('funded', { cash_usd: str(cash) });
    return { status: 'saved', cash_usd: str(cash) };
  });
}

// Validates the intent against the book and reserves its order (RESERVED is
// recorded before anything is sent), or records the refusal. What is checked,
// hashed and recorded is one copy of the intent's own data properties, read
// once (red team P2-11). The grant is read from Eric's stored decision inside
// the same operation, never taken from ctx.
//   ctx: { now, rules, venue: { lot, min_notional_usd, maker_rate, taker_rate },
//          exit_max_usd }
function reserveIntent(ws, intent, ctx = {}) {
  noCallerGrant(ctx);
  const snap = own(intent);
  const it = snap && typeof snap === 'object' && !Array.isArray(snap) ? snap : null;
  const id = it && typeof it.intent_id === 'string' && it.intent_id ? it.intent_id : null;
  const digest = sha256(canonical(snap));
  return journal(ws, 'reserve', digest, `Trader intent ${id || '(no ID)'}`, ctx.now, ({ st, append, op }) => {
    const prior = id ? st.intents.get(id) : null;
    if (prior) {
      if (prior.intent_sha256 !== digest) throw new OpError('CONFLICT', `Intent ${id} is on record with a different body: one intent_id is one intent. Nothing new was written.`);
      const o = [...st.orders.values()].find((x) => x.intent_id === id);
      return o ? { status: 'unchanged', intent_id: id, ...stateOf(o) } : { status: 'unchanged', intent_id: id, state: 'REFUSED', refusals: prior.refusals };
    }
    const ticket = ticketOf((rel) => op.readText(rel, null), it);
    const book = bookFor(st, it && it.pair, ctx, ticket);
    const v = validateTradeIntent(snap, book, ctx.rules);
    const refusals = [...v.refusals];
    if (ticket.why) refusals.push({ field: 'decision_id', rule: 'grant', words: ticket.why });
    const venue = ctx.venue && typeof ctx.venue === 'object' ? ctx.venue : {};
    const feeRate = it && it.order_type === 'POST_ONLY' ? venue.maker_rate : venue.taker_rate;
    if (v.ok && (dec(feeRate) === null || dec(venue.taker_rate) === null || dec(venue.lot) === null)) refusals.push({ field: 'book.fees', rule: 'unknown', words: 'The venue\'s fee or lot is unknown, so the order cannot be costed (never read as 0).' });
    else if (v.ok && it.side === 'OPEN_LONG') {
      const need = commitOf(dec(v.sizing.quantity), dec(it.entry_price), dec(feeRate));
      if (dec(book.available_cash_usd) < need) refusals.push({ field: 'book.cash_usd', rule: 'cash', words: `The order needs ${str(need)} with its fee; ${book.available_cash_usd} is free.` });
    } else if (v.ok && it.side === 'CLOSE_LONG') {
      const p = st.positions.get(it.position_id);
      const opener = p ? st.orders.get(`cr2-${p.intent_id}`) : null;
      if ([...st.orders.values()].some((o) => o.side === 'CLOSE_LONG' && o.position_id === it.position_id && LIVE.includes(o.state))) {
        refusals.push({ field: 'position_id', rule: 'position', words: 'A close order for this position is already live.' });
      } else if (opener && LIVE.includes(opener.state)) {
        // The position could still grow after the close is sized (red team P2-12).
        refusals.push({ field: 'position_id', rule: 'opener_live', words: `The buy that opened this position (${opener.client_order_id}) is still ${opener.state}; cancel it or let it finish before closing.` });
      }
    }
    if (!id) return { status: 'refused', intent_id: null, refusals };
    if (refusals.length) {
      append('refused', { intent_id: id, intent_sha256: digest, refusals });
      return { status: 'refused', intent_id: id, refusals };
    }
    const until = Math.min(Date.parse(it.valid_until), Date.parse(it.created_at) + ctx.rules.max_validity_minutes * MIN);
    const coid = `cr2-${id}`;
    // The venue's record starts with the book's first order, so from then on
    // a missing record is a lost one, never an empty one.
    if (st.orders.size === 0 && op.readText(VENUE, null) === null) op.write(VENUE, '');
    append('reserved', {
      intent_id: id, intent_sha256: digest, intent: snap, client_order_id: coid,
      position_id: it.side === 'CLOSE_LONG' ? it.position_id : `pos-${id}`,
      quantity: v.sizing.quantity, notional_usd: v.sizing.notional_usd || null, loss_at_stop_usd: v.sizing.loss_at_stop_usd || null, per_unit_loss_usd: v.sizing.per_unit_loss_usd || null,
      valid_until_effective: iso(until),
      // The decision that granted it, as read under this lock (null for a close).
      grant: ticket.grant,
      venue: { lot: venue.lot, min_notional_usd: venue.min_notional_usd, maker_rate: venue.maker_rate, taker_rate: venue.taker_rate, fee_rate: feeRate, stop_slippage_bps: STOP_SLIPPAGE_BPS },
    });
    return { status: 'reserved', intent_id: id, client_order_id: coid, sizing: v.sizing };
  });
}

// SENT is recorded before the order goes to the venue.
function markSent(ws, coid, { now } = {}) {
  return journal(ws, 'sent', coid, `Trader order ${coid} sent`, now, ({ st, append }) => {
    const o = orderOf(st, coid);
    if (o.state !== 'RESERVED') return { status: 'unchanged', ...stateOf(o) };
    append('sent', { client_order_id: coid });
    return { status: 'saved', ...stateOf(o) };
  });
}

// The simulated venue: it takes an order once by its client order ID (the
// same ID with the same order again is a duplicate, never a second order;
// with another order, refused) and rejects a POST_ONLY that would cross its
// current price. It reads the book under the lock and takes only an order
// recorded as SENT (red team P1-3). Its record is what reconcile asks.
function venueSend(ws, coid, { now } = {}) {
  const t = msOf(now);
  return runOp(ws, { type: `paper_trader_venue.${opType(ws, 'venue', coid, now).split('.').pop()}`, summary: `Simulated venue: ${coid}` }, (op) => {
    const st = replay(loadOp(op).parsed.events);
    const o = orderOf(st, coid);
    const text = op.readText(VENUE, null);
    const prior = venueRecords(text).find((r) => r.client_order_id === coid);
    if (prior) {
      if (!sameBody(prior, o)) throw new OpError('CONFLICT', `The venue already holds ${coid} as a different order; one client order ID is one order, and nothing new was placed.`);
      return { answer: prior.answer, duplicate: true, client_order_id: coid, words: 'The venue already has this client order ID; nothing new was placed.' };
    }
    if (o.state !== 'SENT') throw new OpError('STATE', `Order ${coid} is ${o.state}; only an order recorded as SENT goes to the venue.`);
    const price = freshClose(st, o.pair, t);
    let answer = 'accepted';
    let words = null;
    if (o.order_type === 'POST_ONLY' && (price === null || (o.side === 'OPEN_LONG' ? o.limit >= price : o.limit <= price))) {
      answer = 'rejected';
      words = price === null ? 'The venue has no current price to place a post-only order against.' : 'A post-only order at this price would take liquidity.';
    }
    const rec = { client_order_id: coid, ...bodyOf(o), answer, words, at: iso(t) };
    op.write(VENUE, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${JSON.stringify(rec)}\n`);
    return { answer, duplicate: false, client_order_id: coid, words };
  }).result;
}

// The venue's answer to a SENT order; one that does not read is UNKNOWN.
function recordAnswer(ws, coid, reply, { now } = {}) {
  return journal(ws, 'answer', coid, `Trader order ${coid} answered`, now, ({ st, append }) => {
    const o = orderOf(st, coid);
    if (o.state !== 'SENT') return { status: 'unchanged', ...stateOf(o) };
    const a = reply && reply.answer;
    if (a === 'accepted' || a === 'rejected') append('answer', { client_order_id: coid, answer: a, words: (reply && reply.words) || null });
    else append('unknown', { client_order_id: coid, words: 'The venue\'s answer did not read; the order stays UNKNOWN until the venue is asked for it.' });
    return { status: 'saved', ...stateOf(o) };
  });
}

// Reserve, mark sent, send, record the answer. A send that fails leaves the
// order UNKNOWN, never resent; an order this call did not mark SENT is never
// sent by it (red team P1-3).
function submitIntent(ws, intent, ctx = {}) {
  const r = reserveIntent(ws, intent, ctx);
  if (r.status !== 'reserved') return r;
  const s = markSent(ws, r.client_order_id, ctx);
  if (s.status !== 'saved') return { ...s, status: 'not_sent', intent_id: r.intent_id, sizing: r.sizing, words: `The order was not marked SENT by this call (it is ${s.state}); nothing went to the venue.` };
  let reply;
  try { reply = venueSend(ws, r.client_order_id, ctx); } catch (_) { reply = null; }
  const a = recordAnswer(ws, r.client_order_id, reply, ctx);
  return { status: 'saved', intent_id: r.intent_id, sizing: r.sizing, ...a, words: (reply && reply.words) || a.words };
}

// Asks the venue's record for one UNKNOWN order inside a journal operation.
// A record that does not read, or that holds this ID as another order, is
// INTEGRITY: the order stays UNKNOWN, never NOT_FOUND (red team P1-4, P1-5).
function reconcileStep({ append, op, t }, o) {
  const coid = o.client_order_id;
  const rec = venueRecords(op.readText(VENUE, null)).find((r) => r.client_order_id === coid);
  if (rec) {
    if (!sameBody(rec, o)) throw new OpError('INTEGRITY', `The venue holds ${coid} as a different order than the book's; it stays UNKNOWN until this is resolved.`);
    if (rec.answer !== 'accepted' && rec.answer !== 'rejected') throw new OpError('INTEGRITY', `The venue's answer for ${coid} does not read; it stays UNKNOWN until this is resolved.`);
    append('reconciled', { client_order_id: coid, state: rec.answer === 'accepted' ? 'ACKED' : 'REJECTED', venue_answer: rec.answer, venue_at: rec.at, words: `The venue has this order (${rec.answer} at ${rec.at}); it fills only from later hours.` });
    return { status: 'saved', ...stateOf(o) };
  }
  const closes = Date.parse(o.sent_at || o.reserved_at) + VENUE_DUPLICATE_WINDOW_MINUTES * MIN;
  if (t < closes) return { status: 'unchanged', ...stateOf(o), words: `The venue has no record of it, but its duplicate-order window is open until ${iso(closes)}; the order stays UNKNOWN.` };
  append('reconciled', { client_order_id: coid, state: 'NOT_FOUND', venue_answer: 'not_found', words: `The venue has no order with this ID, and its duplicate-order window closed at ${iso(closes)}.` });
  return { status: 'saved', ...stateOf(o) };
}

// After a restart: an order reserved or sent with no outcome on record
// becomes UNKNOWN (another process may have sent it, so it is never cancelled
// blind and never sent late), and the venue is asked for every UNKNOWN order.
// A venue record that does not read is said in words; those orders stay
// UNKNOWN.
function recover(ws, { now } = {}) {
  return journal(ws, 'recover', '', 'Trader Paper Book restart', now, (ctx) => {
    const { st, append } = ctx;
    const changed = new Map();
    for (const o of st.orders.values()) {
      if (o.state !== 'RESERVED' && o.state !== 'SENT') continue;
      append('unknown', { client_order_id: o.client_order_id, words: o.state === 'RESERVED' ? 'Reserved with no outcome on record before a restart; it may have been sent, so it stays UNKNOWN until the venue is asked for it.' : 'Sent with no answer on record before a restart; it stays UNKNOWN until the venue is asked for it.' });
      changed.set(o.client_order_id, o);
    }
    const problems = [];
    for (const o of st.orders.values()) {
      if (o.state !== 'UNKNOWN') continue;
      try {
        if (reconcileStep(ctx, o).status === 'saved') changed.set(o.client_order_id, o);
      } catch (err) {
        if (err.code !== 'INTEGRITY') throw err;
        problems.push(`${o.client_order_id}: ${err.message}`);
      }
    }
    const out = { status: changed.size ? 'saved' : 'unchanged', orders: [...changed.values()].map(stateOf) };
    if (problems.length) out.words = problems.join(' ');
    return out;
  });
}

// Asks the venue for an UNKNOWN order by its client order ID.
function reconcile(ws, coid, { now } = {}) {
  return journal(ws, 'reconcile', coid, `Trader order ${coid} reconciled`, now, (ctx) => {
    const o = orderOf(ctx.st, coid);
    if (o.state !== 'UNKNOWN') return { status: 'unchanged', ...stateOf(o) };
    return reconcileStep(ctx, o);
  });
}

function cancelOrder(ws, coid, { now } = {}) {
  return journal(ws, 'cancel', coid, `Trader order ${coid} cancelled`, now, ({ st, append }) => {
    const o = orderOf(st, coid);
    if (o.state === 'CANCELLED') return { status: 'unchanged', ...stateOf(o) };
    if (o.state !== 'ACKED' && o.state !== 'PARTIAL') throw new OpError('STATE', `Order ${coid} is ${o.state}; only an order the venue acknowledged can be cancelled${o.state === 'UNKNOWN' ? ' (an UNKNOWN order is reconciled first)' : ''}.`);
    append('cancelled', { client_order_id: coid, words: 'Cancelled by the engine.' });
    return { status: 'saved', ...stateOf(o) };
  });
}

function readBar(bar) {
  const b = bar && typeof bar === 'object' ? bar : {};
  if (typeof b.pair !== 'string' || !b.pair.trim()) throw new OpError('INVALID', 'The hour names no pair.');
  const t = msOf(b.hour, 'The hour');
  if (t % HOUR !== 0) throw new OpError('INVALID', 'The hour does not start on the hour.');
  const v = { pair: b.pair, t };
  for (const f of BAR_FIELDS) {
    v[f] = dec(b[f]);
    if (v[f] === null) throw new OpError('INVALID', `The hour's ${f} is not a plain decimal string (unknown is never read as 0).`);
  }
  if (v.low === 0n || v.low > v.open || v.low > v.close || v.high < v.open || v.high < v.close) throw new OpError('INVALID', 'The hour\'s low and high do not hold its open and close.');
  v.key = [b.pair, t, ...BAR_FIELDS.map((f) => str(v[f]))].join('|');
  return v;
}

// One closed hour of a pair: expiries, then the stops and targets of what was
// held at its open, then close orders, then buys (and the stop of what they
// filled), then NAV at the hour's end. The same hour again is unchanged;
// different prices for a recorded hour, or an hour before the last, refused;
// for a pair with exposure, an hour that is not the next one is refused (GAP).
function applyBar(ws, bar, { now } = {}) {
  const b = readBar(bar);
  return journal(ws, 'hour', b.key, `Trader hour ${b.pair} ${iso(b.t)}`, now, ({ st, append, t }) => {
    if (b.t + HOUR > t) throw new OpError('INVALID', 'That hour has not closed yet.');
    const list = st.bars.get(b.pair) || [];
    const same = list.find((x) => x.t === b.t);
    if (same) {
      if (same.key === b.key) return { status: 'unchanged', events: [] };
      throw new OpError('CONFLICT', `${b.pair} ${iso(b.t)} is on record with different prices; a recorded hour is never replaced.`);
    }
    const last = list.length ? list[list.length - 1].t : null;
    if (last !== null && b.t < last) throw new OpError('ORDER', `${b.pair}'s hours apply in order; ${iso(last)} is already on record.`);
    const exposed = [...st.positions.values()].some((p) => p.pair === b.pair && p.state === 'open') || [...st.orders.values()].some((o) => o.pair === b.pair && LIVE.includes(o.state));
    if (exposed && last !== null && b.t !== last + HOUR) throw new OpError('GAP', `${b.pair} has an open position or a live order and its last hour on record is ${iso(last)}; the next hour applied is ${iso(last + HOUR)}, so no stop, target or fill is skipped.`);
    const hour = iso(b.t);
    const end = b.t + HOUR;
    const events = [];
    const add = (type, data) => events.push(append(type, data));
    add('bar', { pair: b.pair, hour, ...Object.fromEntries(BAR_FIELDS.map((f) => [f, str(b[f])])) });
    const orders = () => [...st.orders.values()].filter((o) => o.pair === b.pair);
    // An order fills only from an hour that starts at or after it was sent.
    const live = (o) => o.live_from !== null && b.t >= o.live_from;
    const stopFill = (p) => (p.stop * (BPS - BigInt(STOP_SLIPPAGE_BPS))) / BPS;
    const exit = (p, price, reason, o = null) => {
      const proceeds = mulFloor(p.quantity, price);
      const fee = mulCeil(proceeds, o ? o.fee_rate : p.exit_fee_rate);
      add('exit', { position_id: p.position_id, client_order_id: o ? o.client_order_id : undefined, hour, reason, quantity: str(p.quantity), price: str(price), proceeds_usd: str(proceeds), fee_usd: str(fee) });
      // What is left of the buy that opened it is cancelled: its position is closed.
      const opener = st.orders.get(`cr2-${p.intent_id}`);
      if (opener && (opener.state === 'ACKED' || opener.state === 'PARTIAL')) add('cancelled', { client_order_id: opener.client_order_id, words: `Its position closed (${reason}).` });
    };
    // An order whose life ends before this hour's end expires first: the hour
    // cannot tell whether it traded before or after (red team P2-14).
    for (const o of orders()) {
      if ((o.state === 'ACKED' || o.state === 'PARTIAL') && o.valid_until < end) add('expired', { client_order_id: o.client_order_id, hour, words: `Its life ended at ${iso(o.valid_until)}, before ${iso(end)}.` });
    }
    for (const p of [...st.positions.values()].filter((x) => x.pair === b.pair && x.state === 'open')) {
      if (b.open <= p.stop) exit(p, lower(b.open, stopFill(p)), 'stop_gap');
      else if (b.low <= p.stop) exit(p, stopFill(p), 'stop');
      else if (b.high > p.take_profit) exit(p, higher(b.open, p.take_profit), 'take_profit');
    }
    for (const o of orders()) {
      if (o.side !== 'CLOSE_LONG' || o.state !== 'ACKED') continue;
      const p = st.positions.get(o.position_id);
      if (!p || p.state !== 'open') add('cancelled', { client_order_id: o.client_order_id, words: 'Its position closed first.' });
      else if (p.quantity > o.quantity) add('cancelled', { client_order_id: o.client_order_id, words: `Its position (${str(p.quantity)}) is larger than the order (${str(o.quantity)}); a close never sells more than its order.` });
      else if (live(o) && b.high > o.limit) exit(p, higher(b.open, o.limit), 'close', o);
    }
    const share = dec(FILL_SHARE_MAX);
    for (const o of orders()) {
      if (o.side !== 'OPEN_LONG' || (o.state !== 'ACKED' && o.state !== 'PARTIAL') || !live(o) || !(b.low < o.limit)) continue;
      const lot = dec(o.venue.lot);
      const cap = (mulFloor(b.volume, share) / lot) * lot;
      const left = o.quantity - o.filled;
      const q = left < cap ? left : cap;
      if (q === 0n) continue;
      // At the limit, or at the open when the hour opened below it: never
      // outside the hour's range (red team P0-2).
      const price = lower(b.open, o.limit);
      const notional = mulCeil(q, price);
      const fee = mulCeil(notional, o.fee_rate);
      if (st.cash < notional + fee) continue;
      add('fill', { client_order_id: o.client_order_id, position_id: o.position_id, hour, quantity: str(q), price: str(price), notional_usd: str(notional), fee_usd: str(fee), fee_kind: o.order_type === 'POST_ONLY' ? 'maker' : 'taker' });
      const p = st.positions.get(o.position_id);
      if (b.low <= p.stop) exit(p, lower(price, stopFill(p)), price <= p.stop ? 'stop_gap' : 'stop');
    }
    add('mark', { hour_end: iso(end), nav_usd: orNull(navAt(st, end)) });
    return { status: 'saved', events: events.map((e) => ({ type: e.type, client_order_id: e.client_order_id, position_id: e.position_id, reason: e.reason, quantity: e.quantity, price: e.price })) };
  });
}

// --- Reads: they write nothing.

// The book handed to cr-trade-risk@2 for an intent in `pair`. ctx.ticket
// names the intent's project_id, receipt_id and decision_id; its grant is
// read from Eric's stored decision as a reservation reads it.
function book(ws, pair, ctx = {}) {
  noCallerGrant(ctx);
  const tk = ctx.ticket && typeof ctx.ticket === 'object' ? ctx.ticket : null;
  const ticket = tk ? { thesis: typeof tk.receipt_id === 'string' ? tk.receipt_id : null, ...grantOf((rel) => readText(ws, rel, null), tk) } : { thesis: null, grant: null, why: null };
  return bookFor(replay(loadWs(ws).parsed.events), pair, ctx, ticket);
}

// The book's results now. NAV, cash, each position's quantity, notional,
// planned loss at its stop, and the realized and unrealized results are kept
// apart; anything unknown is null with its reason, never 0. Against BTC only
// when the caller gives BTC's price at the funding and now (`btc`).
function results(ws, { now, btc } = {}) {
  const t = msOf(now);
  const st = replay(loadWs(ws).parsed.events);
  const nav = navAt(st, t);
  const unknown = [];
  let unrealized = 0n;
  const open = [...st.positions.values()].filter((p) => p.state === 'open').map((p) => {
    const c = freshClose(st, p.pair, t);
    const value = c === null ? null : mulFloor(p.quantity, c);
    if (value === null) { unrealized = null; unknown.push(`${p.pair} has no hourly price within ${NAV_PRICE_FRESH_MINUTES} minutes: ${p.position_id}'s value is unknown.`); } else if (unrealized !== null) unrealized += value - p.cost;
    return {
      // The entry is the average of the fills, floored at 18 places.
      position_id: p.position_id, pair: p.pair, quantity: str(p.quantity), entry_price: str((p.notional * ONE) / p.quantity), stop_loss_price: str(p.stop), take_profit_price: str(p.take_profit),
      notional_usd: str(p.notional), cost_usd: str(p.cost), planned_loss_at_stop_usd: p.per_unit_loss === null ? null : str(mulCeil(p.quantity, p.per_unit_loss)),
      price: orNull(c), value_usd: orNull(value), unrealized_pnl_usd: value === null ? null : str(value - p.cost),
    };
  });
  if (st.funded === null) unknown.push('The book is not funded.');
  let high = st.funded;
  let maxDd = st.funded === null ? null : 0n;
  for (const m of st.marks) {
    if (m.nav === null) { maxDd = null; unknown.push(`NAV is unknown at ${iso(m.t)}, so the largest drawdown is unknown.`); break; }
    if (m.nav > high) high = m.nav;
    if (maxDd !== null && high - m.nav > maxDd) maxDd = high - m.nav;
  }
  let vsBtc = null;
  const start = btc && dec(btc.start_price);
  const end = btc && dec(btc.end_price);
  if (nav !== null && start && end) {
    vsBtc = { book_return: str((nav * ONE) / st.funded - ONE), btc_return: str((end * ONE) / start - ONE), relative: str((nav * start * ONE) / (st.funded * end) - ONE) };
  } else unknown.push('No BTC price at the funding and now was given, or NAV is unknown, so the book is not set against BTC.');
  return {
    version: VERSION,
    funded_usd: orNull(st.funded),
    funded_at: st.funded_at,
    cash_usd: st.funded === null ? null : str(st.cash),
    nav_usd: orNull(nav),
    realized_pnl_usd: str(st.realized),
    unrealized_pnl_usd: orNull(unrealized),
    fees_usd: str(st.fees),
    max_drawdown_usd: orNull(maxDd),
    drawdown_24h_usd: orNull(drawdown24(st, t)),
    vs_btc: vsBtc,
    open_positions: open,
    closed_positions: [...st.positions.values()].filter((p) => p.state === 'closed').map((p) => ({ position_id: p.position_id, pair: p.pair, realized_pnl_usd: str(p.realized), exits: p.exits })),
    orders: [...st.orders.values()].map(stateOf),
    nav_by_hour: st.marks.map((m) => ({ hour_end: iso(m.t), nav_usd: orNull(m.nav) })),
    unknown,
  };
}

module.exports = {
  VERSION, JOURNAL, VENUE, HEAD, FILL_SHARE_MAX, STOP_SLIPPAGE_BPS, VENUE_DUPLICATE_WINDOW_MINUTES, NAV_PRICE_FRESH_MINUTES, DECISION_VERSION,
  decisionInForce, fund, submitIntent, reserveIntent, markSent, venueSend, recordAnswer, recover, reconcile, cancelOrder, applyBar, book, results,
};
