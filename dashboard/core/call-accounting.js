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
//               2026-10-22 .. 2026-10-31: runs recorded, nothing sent). It is
//               accepted only in the exact shape the monitor writes then
//               (exitQuoteInitial: its eight fields, `last_result` in one of
//               its three historical field sets, every request counter 0).
//   candles     cr.trader-candles-status.v1, the same counters and the same
//               kind of no-`calls` initial state (candleInitial: a pool
//               choice that failed before asking, and the run's end with
//               every request counter 0). No such file was ever found.
// Anything else without `calls` is unknown, never zero: a counter that is
// merely not a positive number (PR #125 audit: "7", -7, true) is no proof
// that nothing was sent.
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
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
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

// A status without `calls` is accepted only as the exact state its writers
// leave before their first reserved request: the fields those writers put
// there and no other, each of its own type, every request counter exactly 0,
// nothing that only a request writes. The absence of a positive number is not
// proof that nothing was sent: a counter that is a string, a boolean, null, a
// negative or a fraction, a container of another kind, or a field that
// contradicts "nothing sent" is unknown. Each returns why, or null.
const isTrigger = (v) => typeof v === 'string' && v.length > 0 && v.length <= 100;
const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v === 'object' ? 'an object' : `${typeof v} ${show(v)}`);
const sameKeys = (o, keys) => Object.keys(o).length === keys.length && keys.every((k) => has(o, k));
const strayOf = (o, allowed) => Object.keys(o).filter((k) => !allowed.includes(k));

// forensic-monitor.js refresh() writes the run's end in one update; a
// request is reserved (and `calls` written) before every product check,
// GitHub read, decimals lookup and quote. Its `counts`, as written at 3640e23,
// cde3637 and a64e21a (2026-10-16, the current fields); `state` is the
// reader's default, never set by the monitor.
const EXIT_TOP = ['schema_version', 'state', 'last_run_at', 'last_trigger', 'last_result', 'last_resolutions_day', 'consecutive_failures', 'next_allowed_at'];
const EXIT_RESULTS = [
  ['checks', 'reads', 'failed', 'not_checkable', 'budget', 'rate_limited', 'resolutions'],
  ['checks', 'reads', 'failed', 'not_checkable', 'quotes', 'quotes_answered', 'no_route', 'quote_errors', 'quote_waits', 'budget', 'rate_limited', 'resolutions'],
  ['checks', 'reads', 'failed', 'not_checkable', 'incomplete', 'quotes', 'quotes_answered', 'no_route', 'quote_errors', 'quote_waits', 'budget', 'rate_limited', 'resolutions', 'corrections'],
];
// Each of these follows a reserved request; none can be other than 0 before one.
const EXIT_SENT = ['checks', 'reads', 'failed', 'not_checkable', 'incomplete', 'quotes', 'quotes_answered', 'no_route', 'quote_errors'];
function exitQuoteInitial(s) {
  const stray = strayOf(s, EXIT_TOP);
  if (stray.length) return `it carries ${stray.slice(0, 3).join(', ')}, which the monitor never writes before its first request`;
  const missing = EXIT_TOP.filter((k) => !has(s, k));
  if (missing.length) return `it lacks ${missing.slice(0, 3).join(', ')}, which the monitor writes with every run`;
  if (s.state !== 'never_run') return `its state is ${show(s.state)}, not never_run`;
  if (!isTime(s.last_run_at)) return `its last_run_at is ${show(s.last_run_at)}, not a time`;
  if (!isTrigger(s.last_trigger)) return `its last_trigger is ${show(s.last_trigger)}`;
  if (!realDay(s.last_resolutions_day)) return `its last_resolutions_day is ${show(s.last_resolutions_day)}, not a real day`;
  if (s.consecutive_failures !== 0) return `its consecutive_failures is ${show(s.consecutive_failures)}; a failure follows only a request`;
  if (s.next_allowed_at !== null) return `its next_allowed_at is ${show(s.next_allowed_at)}; a backoff follows only a failed request`;
  const r = s.last_result;
  if (!isObj(r)) return `its last_result is ${kind(r)}, not the monitor's counts`;
  if (!EXIT_RESULTS.some((keys) => sameKeys(r, keys))) return `its last_result's fields (${Object.keys(r).slice(0, 4).join(', ') || 'none'}${Object.keys(r).length > 4 ? ', …' : ''}) are not a set the monitor ever wrote`;
  for (const k of EXIT_SENT) if (has(r, k) && r[k] !== 0) return `its last run recorded ${k} ${show(r[k])}, where nothing sent is 0`;
  if (has(r, 'quote_waits') && !(isObj(r.quote_waits) && Object.keys(r.quote_waits).length === 0)) return `its last run recorded quote waits ${show(r.quote_waits)}, which follow only a request`;
  if (r.budget !== false) return `its last run recorded budget ${show(r.budget)}`;
  if (r.rate_limited !== null) return `its last run recorded a GitHub rate limit ${show(r.rate_limited)}, which follows only a request`;
  for (const k of ['resolutions', 'corrections']) if (has(r, k) && !isCount(r[k])) return `its last run recorded ${k} ${show(r[k])}, not a whole number of 0 or more`;
  return null;
}

// trader-candles.js: reserve() writes `calls` before every ask; pairs and
// gate follow an answer. Before one, notePoolAttempt (a pool choice that
// failed before asking) and the run's end (last_run_at, last_trigger and
// last_result, together) are all that is written. Its `counts`, as written at
// 1739acf (2026-10-28) and cdcab9c (2026-11-01, the current fields).
const CANDLE_TOP = ['schema_version', 'state', 'pool_attempts', 'last_run_at', 'last_trigger', 'last_result'];
const CANDLE_RESULTS = [
  ['pairs', 'requests', 'sources', 'hours', 'unchanged', 'refused', 'budget', 'wait_until', 'waits', 'problems', 'step'],
  ['pairs', 'requests', 'sources', 'hours', 'unchanged', 'refused', 'budget', 'accounting_unknown', 'wait_until', 'waits', 'problems', 'step'],
];
const CANDLE_SENT = ['requests', 'sources', 'hours', 'unchanged', 'refused'];
const listOfObjects = (v) => Array.isArray(v) && v.length <= 20 && v.every(isObj);
function candleInitial(s) {
  const stray = strayOf(s, CANDLE_TOP);
  if (stray.length) return `it carries ${stray.slice(0, 3).join(', ')}, which the candle read never writes before its first request`;
  if (s.state !== 'never_run') return `its state is ${show(s.state)}, not never_run`;
  if (has(s, 'pool_attempts')) {
    const p = s.pool_attempts;
    if (!isObj(p) || !Object.values(p).every((a) => isObj(a) && sameKeys(a, ['at', 'why']) && isTime(a.at) && typeof a.why === 'string')) return `its pool_attempts are ${show(p)}, not the pool choices it records`;
  }
  const run = ['last_run_at', 'last_trigger', 'last_result'].filter((k) => has(s, k));
  if (run.length === 0) return null;
  if (run.length !== 3) return `it records ${run.join(' and ')} without the rest of a run's end, which is written in one update`;
  if (!isTime(s.last_run_at)) return `its last_run_at is ${show(s.last_run_at)}, not a time`;
  if (!isTrigger(s.last_trigger)) return `its last_trigger is ${show(s.last_trigger)}`;
  const r = s.last_result;
  if (!isObj(r)) return `its last_result is ${kind(r)}, not the read's counts`;
  if (!CANDLE_RESULTS.some((keys) => sameKeys(r, keys))) return `its last_result's fields (${Object.keys(r).slice(0, 4).join(', ') || 'none'}${Object.keys(r).length > 4 ? ', …' : ''}) are not a set the candle read ever wrote`;
  for (const k of CANDLE_SENT) if (r[k] !== 0) return `its last run recorded ${k} ${show(r[k])}, where nothing sent is 0`;
  if (!isCount(r.pairs)) return `its last run recorded pairs ${show(r.pairs)}, not a whole number of 0 or more`;
  if (r.budget !== false) return `its last run recorded budget ${show(r.budget)}`;
  if (r.wait_until !== null) return `its last run recorded GeckoTerminal's wait ${show(r.wait_until)}, which follows only a request`;
  if (has(r, 'accounting_unknown') && r.accounting_unknown !== null) return `its last run recorded an unusable count, which is never written`;
  if (!listOfObjects(r.waits)) return `its last run's waits are ${kind(r.waits)}, not a list of at most 20 waits`;
  if (!listOfObjects(r.problems)) return `its last run's problems are ${kind(r.problems)}, not a list of at most 20 problems`;
  if (r.step !== null && !(isObj(r.step) && sameKeys(r.step, ['done', 'problems']) && isCount(r.step.done) && isCount(r.step.problems))) return `its last run's step is ${show(r.step)}, not the book's step counts`;
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
    answered: 'none', extra: Object.freeze({}), initial: exitQuoteInitial,
  }),
  candles: Object.freeze({
    id: 'candles', label: 'GeckoTerminal\'s candle read', provider: 'GeckoTerminal', file: 'market-data/trader/candles-status.json', schema: 'cr.trader-candles-status.v1',
    answered: 'none', extra: Object.freeze({}), initial: candleInitial,
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
    const why = m.initial(s);
    return why ? `it has no request counts (calls) and is not a state its writers leave before a first request: ${why}` : null;
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
