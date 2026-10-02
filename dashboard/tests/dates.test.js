'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDue, ymdInTz } = require('../core/dates');

// 2026-10-01 is a Thursday.
test('"next friday" on Thursday Oct 1 2026 means Oct 9, and mentions Oct 2 as the other reading', () => {
  const r = parseDue('next friday', '2026-10-01');
  assert.equal(r.date, '2026-10-09');
  assert.equal(r.alternative, '2026-10-02');
});

test('plain weekday means the next occurrence', () => {
  assert.equal(parseDue('friday', '2026-10-01').date, '2026-10-02');
  assert.equal(parseDue('this friday', '2026-10-01').date, '2026-10-02');
  assert.equal(parseDue('thursday', '2026-10-01').date, '2026-10-08');
});

test('explicit and relative dates', () => {
  assert.equal(parseDue('2026-10-09', '2026-10-01').date, '2026-10-09');
  assert.equal(parseDue('tomorrow', '2026-10-01').date, '2026-10-02');
  assert.equal(parseDue('in 2 weeks', '2026-10-01').date, '2026-10-15');
  assert.throws(() => parseDue('someday', '2026-10-01'));
});

test('calendar day is computed in America/New_York', () => {
  // 03:30 UTC on Oct 2 is still Oct 1 in New York (EDT, UTC-4).
  assert.equal(ymdInTz(new Date('2026-10-02T03:30:00Z')), '2026-10-01');
  assert.equal(ymdInTz(new Date('2026-10-02T04:30:00Z')), '2026-10-02');
});
