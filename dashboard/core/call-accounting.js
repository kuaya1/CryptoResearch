'use strict';
// Shared, fail-closed validation of the desk's provider request meters
// (cr-call-accounting@1, bounded paper readiness, 2026-10-31). Pure: no file,
// network or clock of its own; the caller passes what it read and `now`.
// It is not an accounting service or a storage format: each provider keeps its
// own status file, its own writers and its own reserve-before-send boundary
// (market.reserveCall, screening/forensic-monitor reserveRequest,
// trader-candles reserve). This module only says whether what is stored is
// accounting the desk can reserve against, after contract-rpc.js
// stateProblem() and countsOf().
//
// The rules (implementation.md A2):
//   - a file confirmed absent (ENOENT) is a meter never run: zero usage;
//   - any other read failure, invalid JSON, another schema, an unexpected
//     structure, a counter that is not a whole number of 0 or more (string,
//     boolean, null, array, negative, fractional, non-finite, unsafe), an
//     impossible or mismatched day/month, or a day count above its month
//     count is UNKNOWN, never zero; nothing is reset, repaired or rewritten;
//   - a valid period older than now's New York day/month rolls over in the
//     view (the durable record is unchanged until its writer next writes);
//   - a stored day or month after now's is UNKNOWN (the clock went back, or
//     the record is not this desk's).
//
// Compatibility whitelist, from the writers in this repository and every
// historical status file in backups/offsite (2026-10-06 .. 2026-10-31) and the
// local workspace (2026-10-31); see docs/engineering/BOUNDED_PAPER_READINESS.md:
//   coingecko   cr.market-status.v2 with calls {month, month_count, day,
//               day_count}; month_answered/day_answered both or neither (they
//               began 2026-10-03, answered_counted_since says when; demo.js
//               and older files carry neither), plus the derived budget_monthly
//               and remaining the writers copy in. `calls` is required: every
//               writer records it before or with the first request.
//   goplus      cr.screening-status.v1 with all six counters, answered
//               included (eee076d onward); `calls` required.
//   exit_quotes cr.forensic-monitor-status.v1 with {month, month_count, day,
//               day_count}. A file without `calls` is the monitor's state
//               before its first reserved request (the online desk's file
//               2026-10-22 .. 2026-10-31: runs recorded, nothing sent), and is
//               accepted only while nothing in it says a request was made.
//   candles     cr.trader-candles-status.v1, the same counters and the same
//               no-`calls` initial state, under the same condition.
// `calls: null` is accepted for none of them: no writer of these four emits it.
// Answered counts are not compared with sent counts: the existing writers add
// an answer in the period it arrives, while its request was counted in the
// period it was reserved, so across midnight answered can exceed sent.

const { ymdInTz } = require('./dates');

const VERSION = 'cr-call-accounting@1';
// Marks a reader's in-memory default for a file confirmed absent. A symbol:
// it survives a spread ({ ...status }) but is never serialized, so it cannot
// be written into a file or forged by one.
const ABSENT = Symbol('cr-call-accounting.absent');
const initial = (defaults = {}) => ({ ...defaults, [ABSENT]: true });

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const show = (v) => (v === undefined ? 'missing' : JSON.stringify(v).slice(0, 40));
const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isTime = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v));
const nullOrNumber = (v) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);

function realMonth(s) {
  const m = typeof s === 'string' && /^(\d{4})-(\d{2})$/.exec(s);
  return Boolean(m) && Number(m[2]) >= 1 && Number(m[2]) <= 12;
}
function realDay(s) {
  const m = typeof s === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m || !realMonth(`${m[1]}-${m[2]}`)) return false;
  const days = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  return Number(m[3]) >= 1 && Number(m[3]) <= days;
}

// What in a status without `calls` says a request was sent anyway.
function exitQuoteEvidence(s) {
  const r = isObj(s.last_result) ? s.last_result : {};
  for (const k of ['checks', 'reads', 'quotes', 'quotes_answered', 'quote_errors', 'no_route']) if (positive(r[k])) return `its last run recorded ${k} ${r[k]}`;
  if (isObj(s.quote_gates) && Object.keys(s.quote_gates).length) return 'it holds a quote provider\'s answer or wait';
  if (s.github_retry_after_until) return 'it holds a GitHub wait';
  return null;
}
function candleEvidence(s) {
  const r = isObj(s.last_result) ? s.last_result : {};
  if (positive(r.requests)) return `its last run recorded ${r.requests} requests`;
  if (isObj(s.pairs) && Object.values(s.pairs).some((p) => isObj(p) && (p.asked_at || p.http_status))) return 'it records a pair as asked';
  const g = isObj(s.gate) ? s.gate : {};
  if (g.retry_after_until || g.backoff_until || g.last_answer_at || g.last_failure_at) return 'it holds GeckoTerminal\'s answer or wait';
  return null;
}

const METERS = Object.freeze({
  coingecko: Object.freeze({
    id: 'coingecko', label: 'CoinGecko', provider: 'CoinGecko', file: 'market-data/status.json', schema: 'cr.market-status.v2',
    answered: 'optional', extra: Object.freeze({ budget_monthly: nullOrNumber, remaining: nullOrNumber, answered_counted_since: isTime }), initial: null,
  }),
  goplus: Object.freeze({
    id: 'goplus', label: 'GoPlus', provider: 'GoPlus', file: 'market-data/screening/status.json', schema: 'cr.screening-status.v1',
    answered: 'required', extra: Object.freeze({}), initial: null,
  }),
  exit_quotes: Object.freeze({
    id: 'exit_quotes', label: 'The exit-quote monitor', provider: 'the exit-quote and forensic sources', file: 'market-data/forensics/status.json', schema: 'cr.forensic-monitor-status.v1',
    answered: 'none', extra: Object.freeze({}), initial: exitQuoteEvidence,
  }),
  candles: Object.freeze({
    id: 'candles', label: 'GeckoTerminal\'s candle read', provider: 'GeckoTerminal', file: 'market-data/trader/candles-status.json', schema: 'cr.trader-candles-status.v1',
    answered: 'none', extra: Object.freeze({}), initial: candleEvidence,
  }),
});

function meterOf(id) {
  const m = METERS[id];
  if (!m) throw new Error(`No provider meter "${id}".`);
  return m;
}

const tracksAnswered = (m, c) => m.answered === 'required' || (m.answered === 'optional' && isObj(c) && ('month_answered' in c || 'day_answered' in c));

// Why a stored status is not accounting the desk can reserve against, or null.
// Structure only; the period's place against the clock is countsOf's.
function problemOf(id, s) {
  const m = meterOf(id);
  if (!isObj(s)) return 'it is not an object';
  if (s.schema_version !== m.schema) return `its schema is ${show(s.schema_version)}, not ${m.schema}`;
  if (!Object.prototype.hasOwnProperty.call(s, 'calls') || s.calls === undefined) {
    if (!m.initial) return 'it has no request counts (calls)';
    const ev = m.initial(s);
    return ev ? `it has no request counts (calls), yet ${ev}` : null;
  }
  const c = s.calls;
  if (!isObj(c)) return `its request counts are ${c === null ? 'null' : Array.isArray(c) ? 'a list' : show(c)}, not counts`;
  const answered = tracksAnswered(m, c);
  const allowed = new Set(['month', 'month_count', 'day', 'day_count', ...(m.answered === 'none' ? [] : ['month_answered', 'day_answered']), ...Object.keys(m.extra)]);
  const stray = Object.keys(c).filter((k) => !allowed.has(k));
  if (stray.length) return `its request counts carry ${stray.slice(0, 3).join(', ')}, which ${m.label}'s writers never record`;
  if (!realMonth(c.month)) return `its counted month is ${show(c.month)}, not a real YYYY-MM`;
  if (!realDay(c.day) || !c.day.startsWith(`${c.month}-`)) return `its counted day ${show(c.day)} is not a real day of ${c.month}`;
  const counters = ['month_count', 'day_count', ...(answered ? ['month_answered', 'day_answered'] : [])];
  for (const k of counters) if (!isCount(c[k])) return `its ${k} is ${show(c[k])}, not a whole number of 0 or more`;
  if (c.day_count > c.month_count) return `its day count (${c.day_count}) is larger than its month count (${c.month_count})`;
  if (answered && c.day_answered > c.month_answered) return `its day's answered count (${c.day_answered}) is larger than its month's (${c.month_answered})`;
  for (const [k, ok] of Object.entries(m.extra)) if (Object.prototype.hasOwnProperty.call(c, k) && !ok(c[k])) return `its ${k} is ${show(c[k])}`;
  return null;
}

// What one read of a status file says: { status, unknown, absent }. `read` is
// the caller's own read (it returns the text or throws); only ENOENT is a
// meter never run. `status` is the parsed object when it is one, kept so a
// view can still show its other fields; `unknown` is why its accounting
// cannot be used, or null.
function classify(id, read) {
  meterOf(id);
  let text;
  try { text = read(); } catch (err) {
    if (err && err.code === 'ENOENT') return { status: null, unknown: null, absent: true };
    return { status: null, unknown: `it could not be read (${(err && err.code) || 'error'})`, absent: false };
  }
  let s;
  try { s = JSON.parse(String(text).replace(/^﻿/, '')); } catch (_) { return { status: null, unknown: 'it is not JSON', absent: false }; }
  return { status: isObj(s) ? s : null, unknown: problemOf(id, s), absent: false };
}

// The counts for `now`'s New York day and month, or { unknown }. A file
// absent or still in its initial state counts zero; an ended period starts
// again at 0 in the view; a period after now is unknown.
function countsOf(id, status, now) {
  const m = meterOf(id);
  if (!Number.isFinite(now)) return { unknown: 'no valid clock was given to read it against' };
  const day = ymdInTz(new Date(now));
  const month = day.slice(0, 7);
  const zero = { month, month_count: 0, day, day_count: 0, ...(m.answered === 'none' ? {} : { month_answered: 0, day_answered: 0 }) };
  if (status === null || status === undefined) return zero;
  if (status[ABSENT] === true && status.schema_version === undefined && status.calls === undefined) return zero;
  const why = problemOf(id, status);
  if (why) return { unknown: why };
  const c = status.calls;
  if (!c) return zero;
  if (c.month > month || (c.month === month && c.day > day)) return { unknown: `it counts ${c.day}, after today (${day}) in New York, so what was spent is unknown (the clock went back, or the record is not this desk's)` };
  if (c.month < month) return zero;
  const out = { ...c };
  if (c.day < day) {
    out.day = day;
    out.day_count = 0;
    if (tracksAnswered(m, c)) out.day_answered = 0;
  }
  return out;
}

// The words every caller shows for an unknown meter.
function words(id, why) {
  const m = meterOf(id);
  return `${m.label}'s request count (${m.file}) cannot be used: ${why}. Nothing more is sent to ${m.provider} until it is inspected and repaired; the file is kept as it is.`;
}

module.exports = { VERSION, METERS, initial, problemOf, classify, countsOf, words, realDay, realMonth };
