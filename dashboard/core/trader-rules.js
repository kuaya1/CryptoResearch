'use strict';
// Eric's own trader rules (D10, Eric 2026-10-28): the figures cr-trade-risk
// reads in `rules` beside its hard limits (core/trade-risk.js RULE_FIELDS).
// They live in settings `trader.rules`, entered in Preferences > Screening and
// checked by the server with the bounds below; the price freshness is the
// desk's own `freshness.price_stale_minutes`. Each starts unset, and an unset
// one refuses every intent (unknown is never 0). A saved value outside the
// bounds reads as unset, never applied. The desk's adapter
// (core/trader-desk.js, blueprint slot 12a) hands them to the trader when an
// Approve or Halve becomes an order. Reads only.
//
// Beside them, in settings `trader.book` (slot 12a): the cash Eric funds the
// trader's Paper Book with, once, and the venue's fee per trade as a share
// of the notional. Neither has a default: unset, the adapter waits and
// opens nothing, and an unknown fee is never read as 0.

const { OpError } = require('./ops');

const VERSION = 'cr-trader-rules@1';
const FIELDS = Object.freeze(['stop_min_pct', 'stop_min_atr', 'notional_max_pct', 'max_validity_minutes', 'allowlist']);
const DEC_RE = /^\d+(\.\d{1,18})?$/;
const PAIR_RE = /^[A-Za-z0-9.]{1,24}\/[A-Za-z0-9.]{1,24}$/;
const ALLOWLIST_MAX = 100;
const ONE = 10n ** 18n;
const scaled = (s) => { const [i, f = ''] = s.split('.'); return BigInt(i) * ONE + BigInt(f.padEnd(18, '0')); };

// Each rule as the engine reads it: a share or multiple as a plain decimal
// string, minutes as a whole number, pairs exactly as the venue names them.
// read(v) gives { value } or { error }.
const decimal = (label, hi, hiWords = hi) => ({
  label,
  read(v) {
    const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : v;
    if (typeof s !== 'string' || !DEC_RE.test(s)) return { error: `${label} must be a plain decimal (such as 0.01)` };
    const n = scaled(s);
    if (n === 0n || n > scaled(hi)) return { error: `${label} must be more than 0 and at most ${hiWords}` };
    return { value: s };
  },
});
const RULES = Object.freeze({
  stop_min_pct: decimal('Minimum stop distance (share of entry)', '0.5'),
  stop_min_atr: decimal('Minimum stop distance (multiple of the 14-hour ATR)', '20'),
  notional_max_pct: decimal('Notional cap (share of NAV)', '1', '1 (all of NAV)'),
  max_validity_minutes: {
    label: 'Longest life of an intent (minutes)',
    read: (v) => (Number.isSafeInteger(v) && v >= 1 && v <= 10080 ? { value: v } : { error: 'Longest life of an intent (minutes) must be a whole number from 1 to 10080' }),
  },
  allowlist: {
    label: 'Allowlist',
    read(v) {
      if (!Array.isArray(v) || !v.length || v.length > ALLOWLIST_MAX) return { error: `Allowlist must list 1 to ${ALLOWLIST_MAX} pairs` };
      const pairs = v.map((p) => (typeof p === 'string' ? p.trim() : p));
      const bad = pairs.find((p) => typeof p !== 'string' || !PAIR_RE.test(p));
      if (bad !== undefined) return { error: `Allowlist: ${JSON.stringify(bad)} is not a pair such as BTC/USDC` };
      if (new Set(pairs).size !== pairs.length) return { error: 'Allowlist names a pair twice' };
      return { value: pairs };
    },
  },
});

// The server's check of a `trader.rules` patch; null unsets a rule.
function validatePatch(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new OpError('INVALID', 'Trader rules must be an object');
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (!RULES[k]) throw new OpError('INVALID', `"${k}" is not a trader rule (${FIELDS.join(', ')})`);
    if (v === null) { out[k] = null; continue; }
    const r = RULES[k].read(v);
    if (r.error) throw new OpError('INVALID', r.error);
    out[k] = r.value;
  }
  return out;
}

// The Paper Book's settings (`trader.book`): its funding and the venue fee.
const BOOK_FIELDS = Object.freeze(['cash_usd', 'fee_rate']);
const BOOK = Object.freeze({
  cash_usd: decimal('Paper Book funding (USD)', '10000000', '$10,000,000'),
  fee_rate: decimal('Venue fee (share of the notional)', '0.1', '0.1 (10%)'),
});

// The server's check of a `trader.book` patch; null unsets one.
function validateBookPatch(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new OpError('INVALID', 'The Paper Book settings must be an object');
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (!BOOK[k]) throw new OpError('INVALID', `"${k}" is not a Paper Book setting (${BOOK_FIELDS.join(', ')})`);
    if (v === null) { out[k] = null; continue; }
    const r = BOOK[k].read(v);
    if (r.error) throw new OpError('INVALID', r.error);
    out[k] = r.value;
  }
  return out;
}

// The Paper Book's settings in force, and the names of those unset.
function bookOf(ws) {
  const saved = (ws.settings && ws.settings.trader && ws.settings.trader.book) || {};
  const book = {};
  const unset = [];
  for (const k of BOOK_FIELDS) {
    const r = saved[k] === null || saved[k] === undefined ? null : BOOK[k].read(saved[k]);
    if (r && !r.error) book[k] = r.value;
    else unset.push(k);
  }
  return { from: 'trader.book', book, unset };
}

// The rules in force for cr-trade-risk, and the names of those unset.
function rulesOf(ws) {
  const saved = (ws.settings && ws.settings.trader && ws.settings.trader.rules) || {};
  const rules = {};
  const unset = [];
  for (const k of FIELDS) {
    const r = saved[k] === null || saved[k] === undefined ? null : RULES[k].read(saved[k]);
    if (r && !r.error) rules[k] = r.value;
    else unset.push(k);
  }
  const stale = ws.settings && ws.settings.freshness ? ws.settings.freshness.price_stale_minutes : undefined;
  if (Number.isSafeInteger(stale) && stale > 0) rules.price_stale_minutes = stale;
  else unset.push('price_stale_minutes');
  return { version: VERSION, from: 'trader.rules', rules, unset };
}

module.exports = { VERSION, FIELDS, RULES, validatePatch, rulesOf, BOOK_FIELDS, BOOK, validateBookPatch, bookOf };
