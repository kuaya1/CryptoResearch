'use strict';
// The provider-meter matrix shared by call-accounting.test.js and
// trader-candles.test.js (bounded paper readiness, A2): every stored state a
// meter's reader must refuse, and the legitimate ones it must keep reading,
// as the bytes written into the meter's own status file. Built at a given
// clock, so a case is "today", "ended" or "after today" at that clock in New
// York. FICTIONAL counts only.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const A = require('../core/call-accounting');
const { ymdInTz } = require('../core/dates');

const DAY = 86400000;
const nyDay = (ms) => ymdInTz(new Date(ms));

// A status as the meter's writers leave it, with the counts given.
function valid(id, now, { month_count = 3, day_count = 1, extra = {} } = {}) {
  const m = A.METERS[id];
  const day = nyDay(now);
  const calls = { month: day.slice(0, 7), month_count, day, day_count };
  if (m.answered !== 'none') Object.assign(calls, { month_answered: month_count, day_answered: day_count });
  return { schema_version: m.schema, state: 'ok', calls, ...extra };
}

// The state a meter's writers leave before its first reserved request, for the
// two meters that have one (no `calls`; call-accounting.js). Exit quotes:
// forensic-monitor.js refresh()'s one end-of-run write, every request counter
// 0, `last_result` in the current writer's fields (a64e21a). Candles:
// trader-candles.js, a pool choice that failed before asking (pool_attempts)
// and the end-of-run write (cdcab9c's fields).
function initialShape(id) {
  const m = A.METERS[id];
  if (id === 'exit_quotes') {
    return {
      schema_version: m.schema,
      state: 'never_run',
      last_run_at: '2026-10-22T12:00:00.000Z',
      last_trigger: 'server',
      last_result: { checks: 0, reads: 0, failed: 0, not_checkable: 0, incomplete: 0, quotes: 0, quotes_answered: 0, no_route: 0, quote_errors: 0, quote_waits: {}, budget: false, rate_limited: null, resolutions: 0, corrections: 0 },
      last_resolutions_day: '2026-10-22',
      consecutive_failures: 0,
      next_allowed_at: null,
    };
  }
  if (id === 'candles') {
    return {
      schema_version: m.schema,
      state: 'never_run',
      pool_attempts: { 'FICT/USDC': { at: '2026-10-29T12:00:00.000Z', why: 'No CoinGecko price stored for FICTIONAL in the last 24 hours.' } },
      last_run_at: '2026-10-29T12:00:00.000Z',
      last_trigger: 'server',
      last_result: { pairs: 1, requests: 0, sources: 0, hours: 0, unchanged: 0, refused: 0, budget: false, accounting_unknown: null, wait_until: null, waits: [], problems: [{ pair: 'FICT/USDC', words: 'No CoinGecko price stored for FICTIONAL in the last 24 hours.' }], step: { done: 0, problems: 0 } },
    };
  }
  return null;
}
// The initial shape with `last_result` (or the top level) patched.
const result = (id, patch) => { const s = initialShape(id); s.last_result = { ...s.last_result, ...patch }; return s; };
const top = (id, patch) => ({ ...initialShape(id), ...patch });

const text = (v) => `${JSON.stringify(v, null, 2)}\n`;
// A counter JSON can carry that JSON.stringify cannot write.
const raw = (id, now, key, literal) => text(valid(id, now)).replace(`"${key}": ${valid(id, now).calls[key]}`, `"${key}": ${literal}`);
const withCalls = (id, now, patch) => { const s = valid(id, now); s.calls = { ...s.calls, ...patch }; return text(s); };
const without = (o, ...keys) => { const c = { ...o }; for (const k of keys) delete c[k]; return c; };

// Every state that must hold the meter: { name, text } or { name, dir: true }
// (a directory where the file should be: a read error that is not ENOENT).
function invalidCases(id, now) {
  const m = A.METERS[id];
  const v = valid(id, now);
  const later = nyDay(now + 2 * DAY);
  const nextMonth = nyDay(now + 40 * DAY).slice(0, 7);
  const cases = [
    { name: 'invalid JSON', text: '{"schema_version": "x", "calls": {' },
    { name: 'an empty file', text: '' },
    { name: 'a read error (a directory at the path)', dir: true },
    { name: 'a string', text: '"ok"' },
    { name: 'a boolean', text: 'true' },
    { name: 'null', text: 'null' },
    { name: 'a list', text: '[]' },
    { name: 'no schema', text: text(without(v, 'schema_version')) },
    { name: 'another schema', text: text({ ...v, schema_version: 'cr.other-status.v9' }) },
    { name: 'calls null', text: text({ ...v, calls: null }) },
    { name: 'calls a list', text: text({ ...v, calls: [1, 2] }) },
    { name: 'calls a string', text: text({ ...v, calls: '3' }) },
    { name: 'month_count a string', text: withCalls(id, now, { month_count: '3' }) },
    { name: 'month_count a boolean', text: withCalls(id, now, { month_count: true }) },
    { name: 'month_count null', text: withCalls(id, now, { month_count: null }) },
    { name: 'month_count a list', text: withCalls(id, now, { month_count: [3] }) },
    { name: 'month_count missing', text: text({ ...v, calls: without(v.calls, 'month_count') }) },
    { name: 'month_count negative', text: withCalls(id, now, { month_count: -1, day_count: 0, ...(m.answered === 'none' ? {} : { month_answered: 0, day_answered: 0 }) }) },
    { name: 'day_count fractional', text: withCalls(id, now, { day_count: 0.5 }) },
    { name: 'month_count 1e999 (Infinity)', text: raw(id, now, 'month_count', '1e999') },
    { name: 'month_count unsafe (9007199254740993)', text: raw(id, now, 'month_count', '9007199254740993') },
    { name: 'an impossible day (2026-02-30)', text: withCalls(id, now, { month: '2026-02', day: '2026-02-30' }) },
    { name: 'month 13', text: withCalls(id, now, { month: '2026-13', day: '2026-13-01' }) },
    { name: 'a day of another month', text: withCalls(id, now, { day: '1999-12-31' }) },
    { name: 'a day count above the month count', text: withCalls(id, now, { month_count: 4, day_count: 5, ...(m.answered === 'none' ? {} : { month_answered: 4, day_answered: 4 }) }) },
    { name: 'a key no writer records', text: withCalls(id, now, { sent_total: 3 }) },
    { name: 'a day after today (New York)', text: withCalls(id, now, { month: later.slice(0, 7), day: later }) },
    { name: 'a month after this one', text: withCalls(id, now, { month: nextMonth, day: `${nextMonth}-01` }) },
  ];
  if (m.answered === 'required') {
    cases.push({ name: 'answered counts missing', text: text({ ...v, calls: without(v.calls, 'month_answered', 'day_answered') }) });
    cases.push({ name: 'day answered above month answered', text: withCalls(id, now, { month_answered: 1, day_answered: 2 }) });
  }
  if (m.answered === 'optional') {
    cases.push({ name: 'only one answered count', text: text({ ...v, calls: without(v.calls, 'day_answered') }) });
    cases.push({ name: 'month_answered a string', text: withCalls(id, now, { month_answered: '3' }) });
    cases.push({ name: 'budget_monthly a string', text: withCalls(id, now, { budget_monthly: 'lots' }) });
  }
  if (m.answered === 'none') cases.push({ name: 'answered counts this writer never records', text: withCalls(id, now, { month_answered: 1, day_answered: 1 }) });
  if (id === 'exit_quotes') cases.push({ name: 'no calls, yet quotes recorded', text: text({ schema_version: m.schema, state: 'ok', last_result: { quotes: 2 } }) });
  if (id === 'candles') cases.push({ name: 'no calls, yet requests recorded', text: text({ schema_version: m.schema, state: 'ok', last_result: { requests: 3 } }) });
  if (!m.initial) cases.push({ name: 'no calls at all', text: text(without(v, 'calls')) });
  // No `calls`: anything but the writer's own initial shape is unknown. The
  // first three of each are the audit's reproduced cases (a request counter
  // that is not a positive number was taken for zero).
  if (id === 'exit_quotes') {
    const s = initialShape(id);
    cases.push(
      { name: 'no calls, quotes "7"', text: text(result(id, { quotes: '7' })) },
      { name: 'no calls, quotes -7', text: text(result(id, { quotes: -7 })) },
      { name: 'no calls, quotes true', text: text(result(id, { quotes: true })) },
      { name: 'no calls, checks "1"', text: text(result(id, { checks: '1' })) },
      { name: 'no calls, quotes_answered null', text: text(result(id, { quotes_answered: null })) },
      { name: 'no calls, reads 0.5', text: text(result(id, { reads: 0.5 })) },
      { name: 'no calls, quote_errors 1', text: text(result(id, { quote_errors: 1 })) },
      { name: 'no calls, resolutions "2"', text: text(result(id, { resolutions: '2' })) },
      { name: 'no calls, a quote wait recorded', text: text(result(id, { quote_waits: { kyberswap: '2026-10-22T12:10:00.000Z' } })) },
      { name: 'no calls, quote_waits a list', text: text(result(id, { quote_waits: [] })) },
      { name: 'no calls, budget true', text: text(result(id, { budget: true })) },
      { name: 'no calls, budget "false"', text: text(result(id, { budget: 'false' })) },
      { name: 'no calls, a GitHub rate limit recorded', text: text(result(id, { rate_limited: '2026-10-22T12:10:00.000Z' })) },
      { name: 'no calls, last_result missing a writer field', text: text({ ...s, last_result: without(s.last_result, 'quotes') }) },
      { name: 'no calls, last_result with a field no writer records', text: text(result(id, { requests: 0 })) },
      { name: 'no calls, last_result a list', text: text(top(id, { last_result: [0, 0] })) },
      { name: 'no calls, last_result a string', text: text(top(id, { last_result: '0' })) },
      { name: 'no calls, last_result null', text: text(top(id, { last_result: null })) },
      { name: 'no calls, state ok', text: text(top(id, { state: 'ok' })) },
      { name: 'no calls, a failure counted', text: text(top(id, { consecutive_failures: 1 })) },
      { name: 'no calls, a backoff set', text: text(top(id, { next_allowed_at: '2026-10-22T13:00:00.000Z' })) },
      { name: 'no calls, a quote provider\'s gate', text: text(top(id, { quote_gates: {} })) },
      { name: 'no calls, a GitHub wait', text: text(top(id, { github_retry_after_until: '2026-10-22T13:00:00.000Z' })) },
      { name: 'no calls, a key no writer records', text: text(top(id, { note: 'x' })) },
      { name: 'no calls, no last_run_at', text: text(without(s, 'last_run_at')) },
      { name: 'no calls, last_run_at not a time', text: text(top(id, { last_run_at: 'yesterday' })) },
      { name: 'no calls, an impossible resolutions day', text: text(top(id, { last_resolutions_day: '2026-02-30' })) },
      { name: 'no calls, last_trigger a number', text: text(top(id, { last_trigger: 1 })) },
    );
  }
  if (id === 'candles') {
    const s = initialShape(id);
    cases.push(
      { name: 'no calls, requests "7"', text: text(result(id, { requests: '7' })) },
      { name: 'no calls, requests -7', text: text(result(id, { requests: -7 })) },
      { name: 'no calls, requests true', text: text(result(id, { requests: true })) },
      { name: 'no calls, requests null', text: text(result(id, { requests: null })) },
      { name: 'no calls, a pool chosen', text: text(result(id, { sources: 1 })) },
      { name: 'no calls, hours applied', text: text(result(id, { hours: 2 })) },
      { name: 'no calls, unchanged "0"', text: text(result(id, { unchanged: '0' })) },
      { name: 'no calls, budget true', text: text(result(id, { budget: true })) },
      { name: 'no calls, a GeckoTerminal wait recorded', text: text(result(id, { wait_until: '2026-10-29T12:10:00.000Z' })) },
      { name: 'no calls, an unknown count recorded', text: text(result(id, { accounting_unknown: 'it could not be read' })) },
      { name: 'no calls, pairs "1"', text: text(result(id, { pairs: '1' })) },
      { name: 'no calls, waits an object', text: text(result(id, { waits: {} })) },
      { name: 'no calls, problems a string', text: text(result(id, { problems: 'none' })) },
      { name: 'no calls, a problem that is not an object', text: text(result(id, { problems: ['none'] })) },
      { name: 'no calls, step counts as strings', text: text(result(id, { step: { done: '1', problems: 0 } })) },
      { name: 'no calls, step a list', text: text(result(id, { step: [] })) },
      { name: 'no calls, last_result missing a writer field', text: text({ ...s, last_result: without(s.last_result, 'step') }) },
      { name: 'no calls, last_result a list', text: text(top(id, { last_result: [] })) },
      { name: 'no calls, a run without its result', text: text(without(s, 'last_result')) },
      { name: 'no calls, state ok', text: text(top(id, { state: 'ok' })) },
      { name: 'no calls, a GeckoTerminal gate', text: text(top(id, { gate: { failures: 0 } })) },
      { name: 'no calls, a pair recorded as asked', text: text(top(id, { pairs: { 'FICT/USDC': { last_hour_received: '2026-10-29T10:00:00.000Z' } } })) },
      { name: 'no calls, pool_attempts a list', text: text(top(id, { pool_attempts: [] })) },
      { name: 'no calls, a pool attempt without its time', text: text(top(id, { pool_attempts: { 'FICT/USDC': { why: 'x' } } })) },
      { name: 'no calls, a key no writer records', text: text(top(id, { note: 'x' })) },
    );
  }
  return cases;
}

// Legitimate states: each reads, and a reservation is counted on top of it.
// `month`/`day` say what the reader must count after the read at `now`.
function validCases(id, now) {
  const m = A.METERS[id];
  const v = valid(id, now, { month_count: 3, day_count: 1 });
  const earlier = nyDay(now - 2 * DAY);
  const sameMonthEarlier = earlier.slice(0, 7) === nyDay(now).slice(0, 7);
  const cases = [
    { name: 'never run (no file)', absent: true, month: 0, day: 0 },
    { name: 'today\'s counts', text: text(v), month: 3, day: 1 },
    { name: 'with a byte-order mark', text: `﻿${text(v)}`, month: 3, day: 1 },
    { name: 'an ended month', text: withCalls(id, now, { month: '2026-09', day: '2026-09-30', month_count: 900, day_count: 40, ...(m.answered === 'none' ? {} : { month_answered: 900, day_answered: 40 }) }), month: 0, day: 0 },
    { name: 'an ended day', text: withCalls(id, now, { month: earlier.slice(0, 7), day: earlier }), month: sameMonthEarlier ? 3 : 0, day: 0 },
  ];
  if (m.answered === 'optional') cases.push({ name: 'legacy: no answered counts', text: text({ ...v, calls: without(v.calls, 'month_answered', 'day_answered') }), month: 3, day: 1 });
  // No `calls`: the writers' own initial shapes, each read as zero.
  if (id === 'exit_quotes') {
    const s = initialShape(id);
    const v1 = { checks: 0, reads: 0, failed: 0, not_checkable: 0, budget: false, rate_limited: null, resolutions: 0 };
    const v2 = { ...v1, quotes: 0, quotes_answered: 0, no_route: 0, quote_errors: 0, quote_waits: {} };
    cases.push(
      { name: 'initial: no calls, a run that sent nothing (the current writer, as on the online desk 2026-10-22..31)', text: text(s), month: 0, day: 0 },
      { name: 'initial: no calls, local resolutions and corrections only', text: text(result(id, { resolutions: 2, corrections: 1 })), month: 0, day: 0 },
      { name: 'initial: no calls, the first writer\'s fields (3640e23)', text: text(top(id, { last_result: v1 })), month: 0, day: 0 },
      { name: 'initial: no calls, the exit-quote writer\'s fields (cde3637)', text: text(top(id, { last_result: v2 })), month: 0, day: 0 },
    );
  }
  if (id === 'candles') {
    const s = initialShape(id);
    cases.push(
      { name: 'initial: no calls, a pool choice that failed before asking', text: text({ schema_version: s.schema_version, state: 'never_run', pool_attempts: s.pool_attempts }), month: 0, day: 0 },
      { name: 'initial: no calls, a run that sent nothing (the current writer)', text: text(s), month: 0, day: 0 },
      { name: 'initial: no calls, a run that sent nothing (1739acf, before accounting_unknown)', text: text(without(top(id, { last_result: without(s.last_result, 'accounting_unknown') }), 'pool_attempts')), month: 0, day: 0 },
      { name: 'initial: no calls, the book\'s step problems and no step', text: text(result(id, { problems: [{ step: 'open', code: null, words: 'Waiting for an hour.' }], waits: [{ pair: 'FICT/USDC', words: 'Waiting.' }], step: null })), month: 0, day: 0 },
    );
  }
  return cases;
}

// Writes a case into the meter's file (removing what was there).
function put(ws, rel, c) {
  const file = ws.abs(rel);
  fs.rmSync(file, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (c.absent) return;
  if (c.dir) fs.mkdirSync(file);
  else fs.writeFileSync(file, c.text);
}

// What is at the path now, to compare before and after: the bytes' SHA-256,
// "directory" or "absent".
function stored(ws, rel) {
  const file = ws.abs(rel);
  if (!fs.existsSync(file)) return 'absent';
  if (fs.statSync(file).isDirectory()) return `directory:${fs.readdirSync(file).join(',')}`;
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

module.exports = { DAY, nyDay, valid, invalidCases, validCases, put, stored };
