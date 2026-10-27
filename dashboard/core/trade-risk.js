'use strict';
// The pre-trade risk engine, cr-trade-risk@1 (backlog item 73; Junior Trader
// Desk invariants 3 and 4, Eric 2026-10-27; the architecture recovery's PR D).
//
//   validateTradeIntent(intent, book, rules) -> { ok, version, refusals, sizing }
//
// A pure check of one cr.trade-intent.v2 against the hard limits. It reads no
// file, clock or network (the time is book.now) and changes none of its
// inputs. Every failed check is listed as { field, rule, words }, never only
// the first; ok only with none. Nothing is trimmed or adjusted: an intent
// passes as written or is refused. Evidence is never read for the decision.
//
// The limits are the constants below. `rules` may tighten them; a looser
// value is a refusal, never applied. Eric's own figures (minimum stop
// distance, notional cap, freshness, validity, the allowlist) come in
// `rules`, and an unset one refuses every intent: unknown is never 0. So does
// an unknown NAV, drawdown, price, ATR, lot, fee or exit size in `book`.
//
// Beyond item 73's text, from the review of PR #56 (2026-10-27):
//   - risk is checked against the desk's grant for this thesis (the gate's
//     suggested risk and Eric's PM decision), as the cr.trade-intent.v2
//     contract says, and never adopted from the model;
//   - the quantity counts the stop's slippage and both fees, so the loss at
//     the stop, every cost in, is within the risk ceiling (never rounded up);
//   - a created_at or reference_at later than now is refused, so a future
//     stamp cannot stretch freshness or validity;
//   - an order that may be live and unresolved (RESERVED, SENT or UNKNOWN)
//     halts every new intent, not only UNKNOWN;
//   - a CLOSE_LONG takes none of the opening checks (risk, drawdown, stop
//     distance, size): a close only reduces risk. It closes the whole open
//     quantity of its position.

const { ONE } = require('./decimal');

const VERSION = 'cr-trade-risk@1';
const INTENT_VERSION = 'cr.trade-intent.v2';
const RISK_PER_TRADE_MAX = '0.02';
const DAILY_DRAWDOWN_MAX = '0.04';
const SLIPPAGE_BPS_MAX = 20;
// Orders that may be live with no answer on record: none of them lets a new
// intent through (invariant 4).
const UNRESOLVED = ['RESERVED', 'SENT', 'UNKNOWN'];
const SIDES = ['OPEN_LONG', 'CLOSE_LONG'];
const ORDER_TYPES = ['LIMIT', 'POST_ONLY'];

const DEC_RE = /^\d+(\.\d{1,18})?$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const MINUTE = 60000n;
const BPS = 10000n;

const INTENT_FIELDS = ['version', 'intent_id', 'thesis_id', 'pair', 'side', 'position_id', 'order_type', 'created_at', 'reference_price', 'reference_at', 'entry_price', 'stop_loss_price', 'take_profit_price', 'risk_ceiling_usd', 'max_slippage_bps', 'valid_until', 'evidence'];
const RULE_FIELDS = ['stop_min_pct', 'stop_min_atr', 'notional_max_pct', 'price_stale_minutes', 'max_validity_minutes', 'allowlist', 'risk_per_trade_max', 'daily_drawdown_max', 'slippage_bps_max'];

// A plain decimal string (no sign, exponent, NaN or Infinity; at most 18
// places) as a BigInt scaled by ONE, else null. Never through a float.
function dec(s) {
  if (typeof s !== 'string' || !DEC_RE.test(s)) return null;
  const [i, f = ''] = s.split('.');
  return BigInt(i) * ONE + BigInt(f.padEnd(18, '0'));
}
const str = (v) => {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const f = (a % ONE).toString().padStart(18, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${a / ONE}${f ? `.${f}` : ''}`;
};
// Products of two scaled values: floored for sizes, raised for losses, so
// neither rounding ever favours more risk.
const mulFloor = (a, b) => (a * b) / ONE;
const mulCeil = (a, b) => (a * b + ONE - 1n) / ONE;
const isoMs = (s) => (typeof s === 'string' && ISO_RE.test(s) && Number.isFinite(Date.parse(s)) ? BigInt(Date.parse(s)) : null);
const posInt = (n) => Number.isSafeInteger(n) && n > 0;
const text = (s) => typeof s === 'string' && s.trim() !== '';

function validateTradeIntent(intent, book, rules) {
  const refusals = [];
  const refuse = (field, rule, words) => refusals.push({ field, rule, words });
  const it = intent && typeof intent === 'object' && !Array.isArray(intent) ? intent : null;
  const bk = book && typeof book === 'object' && !Array.isArray(book) ? book : null;
  const rl = rules && typeof rules === 'object' && !Array.isArray(rules) ? rules : null;
  if (!it) refuse('intent', 'shape', 'The intent is not an object.');
  if (!bk) refuse('book', 'unknown', 'The Paper Book was not given, so nothing about it is known.');
  if (!rl) refuse('rules', 'unknown', 'No rules were given, so the minimum stop, notional cap, freshness and allowlist are unset.');
  if (!it || !bk || !rl) return result(refusals, null);

  // --- The rules: Eric's figures, and the limits they may only tighten.
  for (const k of Object.keys(rl)) if (!RULE_FIELDS.includes(k)) refuse(`rules.${k}`, 'rule_error', `"${k}" is not a rule this engine knows, so it would tighten nothing.`);
  const tighten = (field, limit, words) => {
    if (rl[field] === undefined) return dec(limit);
    const v = dec(rl[field]);
    if (v === null) { refuse(`rules.${field}`, 'rule_error', `${words} is not a plain decimal string.`); return dec(limit); }
    if (v > dec(limit)) { refuse(`rules.${field}`, 'rule_error', `${words} ${rl[field]} is looser than the hard limit ${limit}; it is never applied.`); return dec(limit); }
    return v;
  };
  const riskMax = tighten('risk_per_trade_max', RISK_PER_TRADE_MAX, 'The risk per trade');
  const ddMax = tighten('daily_drawdown_max', DAILY_DRAWDOWN_MAX, 'The 24-hour drawdown ceiling');
  let slipMax = SLIPPAGE_BPS_MAX;
  if (rl.slippage_bps_max !== undefined) {
    if (!Number.isSafeInteger(rl.slippage_bps_max) || rl.slippage_bps_max < 0) refuse('rules.slippage_bps_max', 'rule_error', 'The slippage limit is not a whole number of basis points.');
    else if (rl.slippage_bps_max > SLIPPAGE_BPS_MAX) refuse('rules.slippage_bps_max', 'rule_error', `The slippage limit ${rl.slippage_bps_max} bps is looser than the hard limit ${SLIPPAGE_BPS_MAX}; it is never applied.`);
    else slipMax = rl.slippage_bps_max;
  }
  const ruleDec = (field, words) => {
    const v = dec(rl[field]);
    if (v === null) refuse(`rules.${field}`, 'rule_unset', `${words} is not set${rl[field] === undefined ? '' : ' as a plain decimal string'}, so every intent is refused.`);
    return v;
  };
  const ruleMinutes = (field, words) => {
    if (!posInt(rl[field])) { refuse(`rules.${field}`, 'rule_unset', `${words} is not set as whole minutes, so every intent is refused.`); return null; }
    return BigInt(rl[field]);
  };
  const staleMin = ruleMinutes('price_stale_minutes', 'The price freshness limit');
  const validMin = ruleMinutes('max_validity_minutes', 'The longest life of an intent');

  // --- Shape.
  for (const k of Object.keys(it)) if (!INTENT_FIELDS.includes(k)) refuse(k, 'shape', k === 'client_order_id' ? 'The agent never sets the client order ID; the engine derives it from intent_id.' : `"${k}" is not a field of ${INTENT_VERSION}.`);
  if (it.version !== INTENT_VERSION) refuse('version', 'shape', `The version is not ${INTENT_VERSION}.`);
  if (typeof it.intent_id !== 'string' || !ULID_RE.test(it.intent_id)) refuse('intent_id', 'shape', 'The intent ID is missing or not a ULID.');
  if (!text(it.thesis_id)) refuse('thesis_id', 'shape', 'The thesis ID is missing.');
  if (!text(it.pair)) refuse('pair', 'shape', 'The pair is missing.');
  const side = SIDES.includes(it.side) ? it.side : null;
  if (!side) refuse('side', 'shape', 'The side is not OPEN_LONG or CLOSE_LONG.');
  if (!ORDER_TYPES.includes(it.order_type)) refuse('order_type', 'shape', 'The order type is not LIMIT or POST_ONLY.');
  if (side === 'OPEN_LONG' && it.position_id !== undefined) refuse('position_id', 'shape', 'An OPEN_LONG names no position.');
  if (side === 'CLOSE_LONG' && !text(it.position_id)) refuse('position_id', 'shape', 'A CLOSE_LONG names the position it closes.');
  const d = {};
  for (const f of ['reference_price', 'entry_price', 'stop_loss_price', 'take_profit_price', 'risk_ceiling_usd']) {
    d[f] = dec(it[f]);
    if (d[f] === null) refuse(f, 'decimal', `${f} is not a plain decimal string${typeof it[f] === 'number' ? ' (a number was given; prices are never read through a float)' : ''}.`);
    else if (d[f] === 0n && f !== 'risk_ceiling_usd') { refuse(f, 'decimal', `${f} is zero.`); d[f] = null; }
  }
  const t = {};
  for (const f of ['created_at', 'reference_at', 'valid_until']) {
    t[f] = isoMs(it[f]);
    if (t[f] === null) refuse(f, 'timestamp', `${f} is not an ISO-8601 UTC time.`);
  }
  if (!Number.isSafeInteger(it.max_slippage_bps) || it.max_slippage_bps < 0) refuse('max_slippage_bps', 'shape', 'max_slippage_bps is not a whole number of basis points.');
  else if (it.max_slippage_bps > slipMax) refuse('max_slippage_bps', 'slippage_limit', `max_slippage_bps ${it.max_slippage_bps} is above the limit of ${slipMax}.`);
  const ev = it.evidence && typeof it.evidence === 'object' && !Array.isArray(it.evidence) ? it.evidence : null;
  if (!ev || !text(ev.catalyst) || !text(ev.negative_invalidation) || !Array.isArray(ev.metrics_evaluated) || !ev.metrics_evaluated.length || !ev.metrics_evaluated.every(text)) refuse('evidence', 'shape', 'The evidence needs a catalyst, the metrics evaluated and the negative invalidation (kept for the record, never read for the decision).');

  // --- The book: what the engine knows now. Unknown is never 0.
  const now = isoMs(bk.now);
  if (now === null) refuse('book.now', 'unknown', 'The engine\'s time is unknown.');
  const bookDec = (f, words) => {
    const v = dec(bk[f]);
    if (v === null) refuse(`book.${f}`, 'unknown', `${words} is unknown, so the intent is refused (never read as 0).`);
    return v;
  };
  const price = bookDec('price', 'The current price');

  // --- Halt: an order that may be live and unresolved stops every new intent.
  if (!Array.isArray(bk.orders)) refuse('book.orders', 'unknown', 'The book\'s orders are unknown, so an unresolved order cannot be ruled out.');
  else {
    const open = bk.orders.filter((o) => !o || typeof o !== 'object' || UNRESOLVED.includes(o.state));
    if (open.length) refuse('book.orders', 'halt_unresolved', `${open.length} order${open.length === 1 ? ' is' : 's are'} unresolved (${[...new Set(open.map((o) => (o && o.state) || 'unreadable'))].join(', ')}): no new intent until the venue's answer is on record.`);
  }

  // --- Time: no future stamps, a fresh reference, a life still running.
  if (now !== null) {
    if (t.created_at !== null && t.created_at > now) refuse('created_at', 'future_time', 'created_at is later than now.');
    if (t.reference_at !== null && t.reference_at > now) refuse('reference_at', 'future_time', 'reference_at is later than now.');
    else if (t.reference_at !== null && staleMin !== null && now - t.reference_at > staleMin * MINUTE) refuse('reference_at', 'stale_price', `The reference price is older than ${staleMin} minutes.`);
    if (t.valid_until !== null && t.created_at !== null && validMin !== null) {
      const until = t.valid_until < t.created_at + validMin * MINUTE ? t.valid_until : t.created_at + validMin * MINUTE;
      if (until <= now) refuse('valid_until', 'expired', `The intent's life ended${until < t.valid_until ? `, at most ${validMin} minutes after it was written` : ''}.`);
    }
  }
  if (price !== null && d.reference_price !== null && Number.isSafeInteger(it.max_slippage_bps)) {
    const gap = price > d.reference_price ? price - d.reference_price : d.reference_price - price;
    if (gap * BPS > BigInt(it.max_slippage_bps) * d.reference_price) refuse('reference_price', 'slippage', `The current price ${str(price)} is more than ${it.max_slippage_bps} bps from the reference price.`);
  }

  if (side === 'CLOSE_LONG') {
    let quantity = null;
    if (!Array.isArray(bk.positions)) refuse('book.positions', 'unknown', 'The book\'s positions are unknown.');
    else if (text(it.position_id)) {
      const p = bk.positions.find((x) => x && x.position_id === it.position_id);
      if (!p || p.state !== 'open') refuse('position_id', 'position', 'No open position of the Paper Book has this ID.');
      else {
        if (p.pair !== it.pair) refuse('pair', 'position', `The position is in ${p.pair}, not ${it.pair}.`);
        quantity = dec(p.quantity);
        if (quantity === null || quantity === 0n) { refuse('book.positions', 'unknown', 'The position\'s open quantity is unknown.'); quantity = null; }
      }
    }
    return result(refusals, quantity === null ? null : { quantity: str(quantity) });
  }
  if (side !== 'OPEN_LONG') return result(refusals, null);

  // --- Opening checks.
  if (!Array.isArray(rl.allowlist) || !rl.allowlist.length) refuse('rules.allowlist', 'rule_unset', 'The allowlist is empty or unset, so every pair is refused.');
  else if (!rl.allowlist.includes(it.pair)) refuse('pair', 'allowlist', `${it.pair} is not on the allowlist (compared exactly).`);
  const { entry_price: entry, stop_loss_price: stop, take_profit_price: tp, risk_ceiling_usd: risk } = d;
  if (entry !== null && stop !== null && tp !== null && !(stop < entry && entry < tp)) refuse('stop_loss_price', 'price_order', 'An OPEN_LONG needs stop below entry below take profit.');
  if (risk === 0n) refuse('risk_ceiling_usd', 'size_zero', 'A risk ceiling of 0 sizes no order.');

  const nav = bookDec('nav_usd', 'The NAV');
  const dd = bookDec('drawdown_24h_usd', 'The 24-hour drawdown');
  const atr = bookDec('atr_14h', 'The 14-hour ATR');
  const lot = bookDec('lot', 'The lot size');
  const minNotional = bookDec('min_notional_usd', 'The venue\'s minimum notional');
  const exitMax = bookDec('exit_max_usd', 'The exit measurement\'s size');
  const stopMinPct = ruleDec('stop_min_pct', 'The minimum stop distance (share of entry)');
  const stopMinAtr = ruleDec('stop_min_atr', 'The minimum stop distance (multiple of ATR)');
  const notionalMaxPct = ruleDec('notional_max_pct', 'The notional cap (share of NAV)');
  const fees = bk.fees && typeof bk.fees === 'object' ? bk.fees : {};
  const feeRate = it.order_type === 'POST_ONLY' ? dec(fees.maker_rate) : dec(fees.taker_rate);
  const exitFee = dec(fees.taker_rate);
  if (feeRate === null || exitFee === null) refuse('book.fees', 'unknown', 'The venue\'s fee is unknown, so the loss at the stop cannot be bounded (never read as 0).');
  const slipBps = Number.isSafeInteger(bk.stop_slippage_bps) && bk.stop_slippage_bps >= 0 && bk.stop_slippage_bps < 10000 ? BigInt(bk.stop_slippage_bps) : null;
  if (slipBps === null) refuse('book.stop_slippage_bps', 'unknown', 'The stop\'s slippage is unknown.');
  if (lot === 0n) refuse('book.lot', 'unknown', 'The lot size is 0.');

  if (risk !== null && nav !== null) {
    if (risk > mulFloor(nav, riskMax)) refuse('risk_ceiling_usd', 'risk_cap', `${str(risk)} is above ${str(riskMax * 100n)}% of NAV (${str(mulFloor(nav, riskMax))}).`);
    if (dd !== null && dd + risk > mulFloor(nav, ddMax)) refuse('risk_ceiling_usd', 'drawdown', `The 24-hour drawdown ${str(dd)} plus this risk is above ${str(ddMax * 100n)}% of NAV (${str(mulFloor(nav, ddMax))}), the hard ceiling.`);
  }
  // The desk's grant: the gate sizes, Eric decides, the model never chooses.
  const g = bk.grant && typeof bk.grant === 'object' ? bk.grant : null;
  if (!g || g.thesis_id !== it.thesis_id) refuse('book.grant', 'unknown', 'No grant from the desk\'s gate and Eric\'s decision is on record for this thesis, so no risk is allowed.');
  else if (risk !== null) {
    const suggested = dec(g.suggested_risk_usd);
    const approved = dec(g.pm_approved_risk_usd);
    if (suggested === null) refuse('book.grant.suggested_risk_usd', 'unknown', 'The gate\'s suggested risk is unknown.');
    else if (risk > suggested) refuse('risk_ceiling_usd', 'gate_cap', `${str(risk)} is above the gate's suggested risk ${str(suggested)}.`);
    if (approved === null) refuse('book.grant.pm_approved_risk_usd', 'unknown', 'Eric\'s approved risk is unknown.');
    else if (risk > approved) refuse('risk_ceiling_usd', 'pm_cap', `${str(risk)} is above Eric's approved risk ${str(approved)}.`);
  }

  let sizing = null;
  if (entry !== null && stop !== null && stop < entry) {
    if (stopMinPct !== null && stopMinAtr !== null && atr !== null) {
      const floor = mulCeil(entry, stopMinPct) > mulCeil(atr, stopMinAtr) ? mulCeil(entry, stopMinPct) : mulCeil(atr, stopMinAtr);
      if (entry - stop < floor) refuse('stop_loss_price', 'stop_distance', `The stop is ${str(entry - stop)} from the entry, nearer than the minimum ${str(floor)}.`);
    }
    if (risk !== null && risk > 0n && lot !== null && lot > 0n && feeRate !== null && exitFee !== null && slipBps !== null) {
      // The loss per unit at the stop, every cost in: the fill below the stop
      // by its slippage, the entry fee and the exit fee.
      const stopFill = (stop * (BPS - slipBps)) / BPS;
      const perUnit = entry - stopFill + mulCeil(entry, feeRate) + mulCeil(stopFill, exitFee);
      const raw = (risk * ONE) / perUnit;
      const quantity = (raw / lot) * lot;
      const notional = mulCeil(quantity, entry);
      const lossAtStop = mulCeil(quantity, perUnit);
      sizing = { quantity: str(quantity), notional_usd: str(notional), loss_at_stop_usd: str(lossAtStop), per_unit_loss_usd: str(perUnit) };
      if (quantity === 0n) refuse('risk_ceiling_usd', 'size_zero', `The risk ceiling buys less than one lot of ${str(lot)} at this stop.`);
      else {
        if (minNotional !== null && notional < minNotional) refuse('risk_ceiling_usd', 'min_notional', `The order's notional ${str(notional)} is below the venue's minimum ${str(minNotional)}.`);
        if (nav !== null && notionalMaxPct !== null && notional > mulFloor(nav, notionalMaxPct)) refuse('risk_ceiling_usd', 'notional_cap', `The notional ${str(notional)} is above ${str(notionalMaxPct * 100n)}% of NAV.`);
        if (exitMax !== null && notional > exitMax) refuse('risk_ceiling_usd', 'exit_cap', `The notional ${str(notional)} is above the ${str(exitMax)} the exit measurement shows can be sold within the slippage limit.`);
      }
    }
  }
  return result(refusals, sizing);
}

function result(refusals, sizing) {
  return { ok: refusals.length === 0, version: VERSION, refusals, sizing };
}

// The exact reading and rounding the Paper Book (core/paper-trader.js) shares.
const exact = { dec, str, mulFloor, mulCeil, isoMs };

module.exports = { validateTradeIntent, VERSION, INTENT_VERSION, INTENT_FIELDS, RULE_FIELDS, RISK_PER_TRADE_MAX, DAILY_DRAWDOWN_MAX, SLIPPAGE_BPS_MAX, UNRESOLVED, exact };
