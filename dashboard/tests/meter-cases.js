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
  if (m.initial) cases.push({ name: 'legacy: no calls and nothing sent', text: text({ schema_version: m.schema, state: 'ok', last_run_at: '2026-10-22T12:00:00.000Z', last_result: {} }), month: 0, day: 0 });
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
