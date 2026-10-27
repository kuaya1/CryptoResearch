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
//
// One intent, one order: the client order ID is derived from intent_id; the
// same intent again is `unchanged`, a different body under its ID refused.
// Orders move RESERVED -> SENT -> ACKED | REJECTED | UNKNOWN, then ACKED ->
// PARTIAL -> FILLED | CANCELLED | EXPIRED (invariant 4). After a crash,
// `recover` cancels an order reserved but never sent (nothing went out, and a
// stale intent is not sent late) and makes one sent with no answer UNKNOWN;
// an answer that does not read is UNKNOWN too. UNKNOWN never times out: only
// `reconcile`, asking the venue for that client order ID, resolves it, to the
// venue's answer when it has one, to NOT_FOUND only when it has none and its
// duplicate-order window has passed. Nothing is resent under a new ID, and
// while an order is unresolved the risk engine refuses every new intent.
//
// The simulation (the cr-paper@2 blueprint):
//   - cash NAV: the book starts from the cash Eric funds it with (unfunded,
//     NAV is unknown and every intent is refused); NAV is cash plus each open
//     quantity at its pair's latest hourly close no older than
//     NAV_PRICE_FRESH_MINUTES, else unknown, never valued at 0 or at entry;
//   - sizes from cr-trade-risk@1 (floored to the lot, every cost in); an
//     order's cash and fee are committed when it is reserved, so cash never
//     goes negative;
//   - a limit buy fills at its limit only when an hour's low trades below it,
//     at most FILL_SHARE_MAX of the hour's volume; the rest stays open as a
//     partial fill until it fills, is cancelled or expires;
//   - fees from the venue's schedule frozen with the order: POST_ONLY pays
//     the maker fee, everything else the taker fee, exits the taker fee; an
//     unknown fee refuses; the venue rejects a POST_ONLY that would cross;
//   - stops and targets against each hour's high and low: a stop fills
//     STOP_SLIPPAGE_BPS below the stop, or at the open when the hour opened
//     through it, never better; when one hour reaches both, the stop is taken;
//     an hour that fills a buy checks its stop, never its target (the order
//     of events within the hour is unknown, so the worse outcome);
//   - exits and closes fill whole (a stated simplification); long only.
// Fees and losses round against the trader; sizes never round up.

const fs = require('fs');
const { runOp, OpError } = require('./ops');
const { sha256 } = require('./fsx');
const risk = require('./trade-risk');

const { dec, str, mulFloor, mulCeil } = risk.exact;
const VERSION = 'cr-paper@2';
const JOURNAL = 'paper/trader/journal.jsonl';
const VENUE = 'paper/trader/venue.jsonl';
const FILL_SHARE_MAX = '0.1';
const STOP_SLIPPAGE_BPS = 25;
const VENUE_DUPLICATE_WINDOW_MINUTES = 60;
const NAV_PRICE_FRESH_MINUTES = 120;
const HOUR = 3600000;
const MIN = 60000;
const BPS = 10000n;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
// Orders that still hold their committed cash: they may yet fill.
const LIVE = ['RESERVED', 'SENT', 'ACKED', 'PARTIAL', 'UNKNOWN'];
const BAR_FIELDS = ['open', 'high', 'low', 'close', 'volume'];

function msOf(s, what = 'now') {
  if (typeof s !== 'string' || !ISO_RE.test(s) || !Number.isFinite(Date.parse(s))) throw new OpError('INVALID', `${what} is not an ISO-8601 UTC time.`);
  return Date.parse(s);
}
const iso = (ms) => new Date(ms).toISOString();
const orNull = (v) => (v === null ? null : str(v));
const commitOf = (q, price, rate) => { const n = mulCeil(q, price); return n + mulCeil(n, rate); };
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

function readText(ws, rel) {
  try { return fs.readFileSync(ws.abs(rel), 'utf8'); } catch (_) { return ''; }
}
const venueRecords = (text) => lines(text).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);

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
        client_order_id: e.client_order_id, intent_id: e.intent_id, side: i.side, pair: i.pair, order_type: i.order_type, position_id: e.position_id,
        limit: dec(i.entry_price), stop: dec(i.stop_loss_price), take_profit: dec(i.take_profit_price), quantity: dec(e.quantity), filled: 0n,
        per_unit_loss: dec(e.per_unit_loss_usd), fee_rate: dec(e.venue.fee_rate), venue: e.venue, valid_until: Date.parse(e.valid_until_effective),
        state: 'RESERVED', reserved_at: e.at, sent_at: null, words: null,
      });
      st.intents.set(e.intent_id, { intent_sha256: e.intent_sha256, refusals: null });
      break;
    }
    case 'sent': o.state = 'SENT'; o.sent_at = e.at; break;
    case 'answer': o.state = e.answer === 'accepted' ? 'ACKED' : 'REJECTED'; o.words = e.words; break;
    case 'unknown': o.state = 'UNKNOWN'; o.words = e.words; break;
    case 'reconciled': o.state = e.state; o.words = e.words; break;
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
      const p = st.positions.get(e.position_id) || { position_id: e.position_id, intent_id: o.intent_id, pair: o.pair, entry_price: o.limit, stop: o.stop, take_profit: o.take_profit, per_unit_loss: o.per_unit_loss, exit_fee_rate: dec(o.venue.taker_rate), quantity: 0n, cost: 0n, realized: 0n, exits: [], opened_at: e.at };
      p.quantity += q; p.cost += cost; p.state = 'open';
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
      p.quantity = 0n; p.cost = 0n; p.state = 'closed'; p.closed_at = e.at;
      if (o) { o.filled = o.quantity; o.state = 'FILLED'; }
      break;
    }
    case 'mark': st.marks.push({ t: Date.parse(e.hour_end), nav: dec(e.nav_usd) }); break;
    default: throw new OpError('INTEGRITY', `${JOURNAL} holds an event ${VERSION} does not know: ${e.type}.`);
  }
  st.last_at = e.at;
}

const committed = (st) => [...st.orders.values()].filter((o) => o.side === 'OPEN_LONG' && LIVE.includes(o.state)).reduce((s, o) => s + commitOf(o.quantity - o.filled, o.limit, o.fee_rate), 0n);

// A pair's latest close from an hour ended by t and within the freshness
// window, else null.
function freshClose(st, pair, t) {
  const list = st.bars.get(pair) || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const end = list[i].t + HOUR;
    if (end > t) continue;
    return t - end <= NAV_PRICE_FRESH_MINUTES * MIN ? list[i].close : null;
  }
  return null;
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

// The book cr-trade-risk@1 reads, for one pair, with each unknown in words.
function bookFor(st, pair, ctx) {
  const t = msOf(ctx.now);
  const v = ctx.venue && typeof ctx.venue === 'object' ? ctx.venue : {};
  const book = {
    now: ctx.now,
    nav_usd: orNull(navAt(st, t)),
    cash_usd: st.funded === null ? null : str(st.cash),
    available_cash_usd: st.funded === null ? null : str(st.cash - committed(st)),
    drawdown_24h_usd: orNull(drawdown24(st, t)),
    price: orNull(freshClose(st, pair, t)),
    atr_14h: orNull(atr14(st, pair, t)),
    lot: v.lot,
    min_notional_usd: v.min_notional_usd,
    fees: { maker_rate: v.maker_rate, taker_rate: v.taker_rate },
    stop_slippage_bps: STOP_SLIPPAGE_BPS,
    exit_max_usd: ctx.exit_max_usd,
    grant: ctx.grant,
    positions: [...st.positions.values()].filter((p) => p.state === 'open').map((p) => ({ position_id: p.position_id, pair: p.pair, state: 'open', quantity: str(p.quantity) })),
    orders: [...st.orders.values()].map((o) => ({ client_order_id: o.client_order_id, state: o.state })),
  };
  const fresh = `${NAV_PRICE_FRESH_MINUTES} minutes`;
  book.unknown = [
    st.funded === null && 'The book is not funded, so its NAV is unknown.',
    st.funded !== null && book.nav_usd === null && `An open position has no hourly price within ${fresh}, so NAV is unknown.`,
    book.nav_usd !== null && book.drawdown_24h_usd === null && `An hour of the last 24 has no NAV, so the 24-hour drawdown is unknown.`,
    book.price === null && `${pair} has no hourly price within ${fresh}.`,
    book.atr_14h === null && `${pair} has no 15 consecutive hours ending within ${fresh}, so its 14-hour ATR is unknown.`,
  ].filter(Boolean);
  return book;
}

// --- Writes: one journal operation each, under the workspace lock.

function journal(ws, summary, now, build) {
  const t = msOf(now);
  return runOp(ws, { type: 'paper_trader', summary }, (op) => {
    const text = op.readText(JOURNAL, '');
    const parsed = parseJournal(text);
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
    if (out.length) op.write(JOURNAL, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${out.join('\n')}\n`);
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
  return journal(ws, 'Fund the trader\'s Paper Book', now, ({ st, append }) => {
    if (st.funded !== null) {
      if (st.funded === cash) return { status: 'unchanged', cash_usd: str(cash) };
      throw new OpError('CONFLICT', `The book was funded with ${str(st.funded)}; a different amount is never applied over it.`);
    }
    append('funded', { cash_usd: str(cash) });
    return { status: 'saved', cash_usd: str(cash) };
  });
}

// Validates the intent against the book and reserves its order (RESERVED is
// recorded before anything is sent), or records the refusal.
//   ctx: { now, rules, venue: { lot, min_notional_usd, maker_rate, taker_rate },
//          exit_max_usd, grant }
function reserveIntent(ws, intent, ctx = {}) {
  const id = intent && typeof intent === 'object' && typeof intent.intent_id === 'string' && intent.intent_id ? intent.intent_id : null;
  const digest = sha256(canonical(intent));
  return journal(ws, `Trader intent ${id || '(no ID)'}`, ctx.now, ({ st, append }) => {
    const prior = id ? st.intents.get(id) : null;
    if (prior) {
      if (prior.intent_sha256 !== digest) throw new OpError('CONFLICT', `Intent ${id} is on record with a different body: one intent_id is one intent. Nothing new was written.`);
      const o = [...st.orders.values()].find((x) => x.intent_id === id);
      return o ? { status: 'unchanged', intent_id: id, ...stateOf(o) } : { status: 'unchanged', intent_id: id, state: 'REFUSED', refusals: prior.refusals };
    }
    const book = bookFor(st, intent && intent.pair, ctx);
    const v = risk.validateTradeIntent(intent, book, ctx.rules);
    const refusals = [...v.refusals];
    const venue = ctx.venue && typeof ctx.venue === 'object' ? ctx.venue : {};
    const feeRate = intent && intent.order_type === 'POST_ONLY' ? venue.maker_rate : venue.taker_rate;
    if (v.ok && (dec(feeRate) === null || dec(venue.taker_rate) === null || dec(venue.lot) === null)) refusals.push({ field: 'book.fees', rule: 'unknown', words: 'The venue\'s fee or lot is unknown, so the order cannot be costed (never read as 0).' });
    else if (v.ok && intent.side === 'OPEN_LONG') {
      const need = commitOf(dec(v.sizing.quantity), dec(intent.entry_price), dec(feeRate));
      if (dec(book.available_cash_usd) < need) refusals.push({ field: 'book.cash_usd', rule: 'cash', words: `The order needs ${str(need)} with its fee; ${book.available_cash_usd} is free.` });
    } else if (v.ok && [...st.orders.values()].some((o) => o.side === 'CLOSE_LONG' && o.position_id === intent.position_id && LIVE.includes(o.state))) {
      refusals.push({ field: 'position_id', rule: 'position', words: 'A close order for this position is already live.' });
    }
    if (!id) return { status: 'refused', intent_id: null, refusals };
    if (refusals.length) {
      append('refused', { intent_id: id, intent_sha256: digest, refusals });
      return { status: 'refused', intent_id: id, refusals };
    }
    const until = Math.min(Date.parse(intent.valid_until), Date.parse(intent.created_at) + ctx.rules.max_validity_minutes * MIN);
    const coid = `cr2-${id}`;
    append('reserved', {
      intent_id: id, intent_sha256: digest, intent, client_order_id: coid,
      position_id: intent.side === 'CLOSE_LONG' ? intent.position_id : `pos-${id}`,
      quantity: v.sizing.quantity, notional_usd: v.sizing.notional_usd || null, loss_at_stop_usd: v.sizing.loss_at_stop_usd || null, per_unit_loss_usd: v.sizing.per_unit_loss_usd || null,
      valid_until_effective: iso(until),
      venue: { lot: venue.lot, min_notional_usd: venue.min_notional_usd, maker_rate: venue.maker_rate, taker_rate: venue.taker_rate, fee_rate: feeRate, stop_slippage_bps: STOP_SLIPPAGE_BPS },
    });
    return { status: 'reserved', intent_id: id, client_order_id: coid, sizing: v.sizing };
  });
}

// SENT is recorded before the order goes to the venue.
function markSent(ws, coid, { now } = {}) {
  return journal(ws, `Trader order ${coid} sent`, now, ({ st, append }) => {
    const o = orderOf(st, coid);
    if (o.state !== 'RESERVED') return { status: 'unchanged', ...stateOf(o) };
    append('sent', { client_order_id: coid });
    return { status: 'saved', ...stateOf(o) };
  });
}

// The simulated venue: it takes an order once by its client order ID (the
// same ID again is a duplicate, never a second order) and rejects a POST_ONLY
// that would cross its current price. Its record is what reconcile asks.
function venueSend(ws, coid, { now } = {}) {
  const t = msOf(now);
  const st = replay(parseJournal(readText(ws, JOURNAL)).events);
  const o = orderOf(st, coid);
  return runOp(ws, { type: 'paper_trader_venue', summary: `Simulated venue: ${coid}` }, (op) => {
    const text = op.readText(VENUE, '');
    const prior = venueRecords(text).find((r) => r.client_order_id === coid);
    if (prior) return { answer: prior.answer, duplicate: true, client_order_id: coid, words: 'The venue already has this client order ID; nothing new was placed.' };
    const price = freshClose(st, o.pair, t);
    let answer = 'accepted';
    let words = null;
    if (o.order_type === 'POST_ONLY' && (price === null || (o.side === 'OPEN_LONG' ? o.limit >= price : o.limit <= price))) {
      answer = 'rejected';
      words = price === null ? 'The venue has no current price to place a post-only order against.' : 'A post-only order at this price would take liquidity.';
    }
    const rec = { client_order_id: coid, pair: o.pair, side: o.side, order_type: o.order_type, limit: str(o.limit), quantity: str(o.quantity), answer, words, at: iso(t) };
    op.write(VENUE, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${JSON.stringify(rec)}\n`);
    return { answer, duplicate: false, client_order_id: coid, words };
  }).result;
}

// The venue's answer to a SENT order; one that does not read is UNKNOWN.
function recordAnswer(ws, coid, reply, { now } = {}) {
  return journal(ws, `Trader order ${coid} answered`, now, ({ st, append }) => {
    const o = orderOf(st, coid);
    if (o.state !== 'SENT') return { status: 'unchanged', ...stateOf(o) };
    const a = reply && reply.answer;
    if (a === 'accepted' || a === 'rejected') append('answer', { client_order_id: coid, answer: a, words: (reply && reply.words) || null });
    else append('unknown', { client_order_id: coid, words: 'The venue\'s answer did not read; the order stays UNKNOWN until the venue is asked for it.' });
    return { status: 'saved', ...stateOf(o) };
  });
}

// Reserve, mark sent, send, record the answer. A send that fails leaves the
// order UNKNOWN, never resent.
function submitIntent(ws, intent, ctx = {}) {
  const r = reserveIntent(ws, intent, ctx);
  if (r.status !== 'reserved') return r;
  markSent(ws, r.client_order_id, ctx);
  let reply;
  try { reply = venueSend(ws, r.client_order_id, ctx); } catch (_) { reply = null; }
  const a = recordAnswer(ws, r.client_order_id, reply, ctx);
  return { status: 'saved', intent_id: r.intent_id, sizing: r.sizing, ...a, words: (reply && reply.words) || a.words };
}

// After a restart: an order reserved but never sent is cancelled (it is not
// sent late); one sent with no answer becomes UNKNOWN.
function recover(ws, { now } = {}) {
  return journal(ws, 'Trader Paper Book restart', now, ({ st, append }) => {
    const changed = [];
    for (const o of st.orders.values()) {
      if (o.state === 'RESERVED') append('cancelled', { client_order_id: o.client_order_id, words: 'Reserved but never sent before a restart; it is not sent late.' });
      else if (o.state === 'SENT') append('unknown', { client_order_id: o.client_order_id, words: 'Sent with no answer on record before a restart; it stays UNKNOWN until the venue is asked for it.' });
      else continue;
      changed.push(stateOf(o));
    }
    return { status: changed.length ? 'saved' : 'unchanged', orders: changed };
  });
}

// Asks the venue for an UNKNOWN order by its client order ID.
function reconcile(ws, coid, { now } = {}) {
  return journal(ws, `Trader order ${coid} reconciled`, now, ({ st, append, op, t }) => {
    const o = orderOf(st, coid);
    if (o.state !== 'UNKNOWN') return { status: 'unchanged', ...stateOf(o) };
    const rec = venueRecords(op.readText(VENUE, '')).find((r) => r.client_order_id === coid);
    if (rec) {
      append('reconciled', { client_order_id: coid, state: rec.answer === 'accepted' ? 'ACKED' : 'REJECTED', venue_answer: rec.answer, words: `The venue has this order (${rec.answer} at ${rec.at}); it fills only from later hours.` });
      return { status: 'saved', ...stateOf(o) };
    }
    const closes = Date.parse(o.sent_at || o.reserved_at) + VENUE_DUPLICATE_WINDOW_MINUTES * MIN;
    if (t < closes) return { status: 'unchanged', ...stateOf(o), words: `The venue has no record of it, but its duplicate-order window is open until ${iso(closes)}; the order stays UNKNOWN.` };
    append('reconciled', { client_order_id: coid, state: 'NOT_FOUND', venue_answer: 'not_found', words: `The venue has no order with this ID, and its duplicate-order window closed at ${iso(closes)}.` });
    return { status: 'saved', ...stateOf(o) };
  });
}

function cancelOrder(ws, coid, { now } = {}) {
  return journal(ws, `Trader order ${coid} cancelled`, now, ({ st, append }) => {
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
// different prices for a recorded hour, or an hour before the last, refused.
function applyBar(ws, bar, { now } = {}) {
  const b = readBar(bar);
  return journal(ws, `Trader hour ${b.pair} ${iso(b.t)}`, now, ({ st, append, t }) => {
    if (b.t + HOUR > t) throw new OpError('INVALID', 'That hour has not closed yet.');
    const list = st.bars.get(b.pair) || [];
    const same = list.find((x) => x.t === b.t);
    if (same) {
      if (same.key === b.key) return { status: 'unchanged', events: [] };
      throw new OpError('CONFLICT', `${b.pair} ${iso(b.t)} is on record with different prices; a recorded hour is never replaced.`);
    }
    if (list.length && b.t < list[list.length - 1].t) throw new OpError('ORDER', `${b.pair}'s hours apply in order; ${iso(list[list.length - 1].t)} is already on record.`);
    const hour = iso(b.t);
    const events = [];
    const add = (type, data) => events.push(append(type, data));
    add('bar', { pair: b.pair, hour, ...Object.fromEntries(BAR_FIELDS.map((f) => [f, str(b[f])])) });
    const orders = () => [...st.orders.values()].filter((o) => o.pair === b.pair);
    const stopFill = (p) => (p.stop * (BPS - BigInt(STOP_SLIPPAGE_BPS))) / BPS;
    const exit = (p, price, reason, o = null) => {
      const proceeds = mulFloor(p.quantity, price);
      const fee = mulCeil(proceeds, o ? o.fee_rate : p.exit_fee_rate);
      add('exit', { position_id: p.position_id, client_order_id: o ? o.client_order_id : undefined, hour, reason, quantity: str(p.quantity), price: str(price), proceeds_usd: str(proceeds), fee_usd: str(fee) });
      // What is left of the buy that opened it is cancelled: its position is closed.
      const opener = st.orders.get(`cr2-${p.intent_id}`);
      if (opener && (opener.state === 'ACKED' || opener.state === 'PARTIAL')) add('cancelled', { client_order_id: opener.client_order_id, words: `Its position closed (${reason}).` });
    };
    for (const o of orders()) {
      if ((o.state === 'ACKED' || o.state === 'PARTIAL') && o.valid_until <= b.t) add('expired', { client_order_id: o.client_order_id, hour, words: `Its life ended at ${iso(o.valid_until)}.` });
    }
    for (const p of [...st.positions.values()].filter((x) => x.pair === b.pair && x.state === 'open')) {
      if (b.open <= p.stop) exit(p, b.open < stopFill(p) ? b.open : stopFill(p), 'stop_gap');
      else if (b.low <= p.stop) exit(p, stopFill(p), 'stop');
      else if (b.high > p.take_profit) exit(p, p.take_profit, 'take_profit');
    }
    for (const o of orders()) {
      if (o.side !== 'CLOSE_LONG' || o.state !== 'ACKED') continue;
      const p = st.positions.get(o.position_id);
      if (!p || p.state !== 'open') add('cancelled', { client_order_id: o.client_order_id, words: 'Its position closed first.' });
      else if (b.high > o.limit) exit(p, o.limit, 'close', o);
    }
    const share = dec(FILL_SHARE_MAX);
    for (const o of orders()) {
      if (o.side !== 'OPEN_LONG' || (o.state !== 'ACKED' && o.state !== 'PARTIAL') || !(b.low < o.limit)) continue;
      const lot = dec(o.venue.lot);
      const cap = (mulFloor(b.volume, share) / lot) * lot;
      const left = o.quantity - o.filled;
      const q = left < cap ? left : cap;
      if (q === 0n) continue;
      const notional = mulCeil(q, o.limit);
      const fee = mulCeil(notional, o.fee_rate);
      if (st.cash < notional + fee) continue;
      add('fill', { client_order_id: o.client_order_id, position_id: o.position_id, hour, quantity: str(q), price: str(o.limit), notional_usd: str(notional), fee_usd: str(fee), fee_kind: o.order_type === 'POST_ONLY' ? 'maker' : 'taker' });
      const p = st.positions.get(o.position_id);
      if (b.low <= p.stop) exit(p, stopFill(p), 'stop');
    }
    add('mark', { hour_end: iso(b.t + HOUR), nav_usd: orNull(navAt(st, b.t + HOUR)) });
    return { status: 'saved', events: events.map((e) => ({ type: e.type, client_order_id: e.client_order_id, position_id: e.position_id, reason: e.reason, quantity: e.quantity, price: e.price })) };
  });
}

// --- Reads: they write nothing.

// The book handed to cr-trade-risk@1 for an intent in `pair`.
function book(ws, pair, ctx = {}) {
  return bookFor(replay(parseJournal(readText(ws, JOURNAL)).events), pair, ctx);
}

// The book's results now. NAV, cash, each position's quantity, notional,
// planned loss at its stop, and the realized and unrealized results are kept
// apart; anything unknown is null with its reason, never 0. Against BTC only
// when the caller gives BTC's price at the funding and now (`btc`).
function results(ws, { now, btc } = {}) {
  const t = msOf(now);
  const st = replay(parseJournal(readText(ws, JOURNAL)).events);
  const nav = navAt(st, t);
  const unknown = [];
  let unrealized = 0n;
  const open = [...st.positions.values()].filter((p) => p.state === 'open').map((p) => {
    const c = freshClose(st, p.pair, t);
    const value = c === null ? null : mulFloor(p.quantity, c);
    if (value === null) { unrealized = null; unknown.push(`${p.pair} has no hourly price within ${NAV_PRICE_FRESH_MINUTES} minutes: ${p.position_id}'s value is unknown.`); } else if (unrealized !== null) unrealized += value - p.cost;
    return {
      position_id: p.position_id, pair: p.pair, quantity: str(p.quantity), entry_price: str(p.entry_price), stop_loss_price: str(p.stop), take_profit_price: str(p.take_profit),
      notional_usd: str(mulCeil(p.quantity, p.entry_price)), cost_usd: str(p.cost), planned_loss_at_stop_usd: p.per_unit_loss === null ? null : str(mulCeil(p.quantity, p.per_unit_loss)),
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
    const ONE = 10n ** 18n;
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
  VERSION, JOURNAL, VENUE, FILL_SHARE_MAX, STOP_SLIPPAGE_BPS, VENUE_DUPLICATE_WINDOW_MINUTES, NAV_PRICE_FRESH_MINUTES,
  fund, submitIntent, reserveIntent, markSent, venueSend, recordAnswer, recover, reconcile, cancelOrder, applyBar, book, results,
};
