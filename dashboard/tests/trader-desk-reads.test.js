'use strict';
// Phase-local snapshot reuse (the cohesion audit's brief 5, 2026-10-29): one
// read of the trader's journal serves a whole read phase of the adapter, and
// a step reads the book again only after something was recorded. Counted as
// reads of paper/trader/journal.jsonl; the answers are compared whole with
// what separate reads give. Temporary workspaces and fictional records only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const T = require('../core/tickets');
const TD = require('../core/trader-desk');
const { H, M, iso, deskWith, settle, bar } = require('./trader-fixture');

// Counts the journal reads `fn` makes (fs.readFileSync of the journal).
function journalReads(t, fn) {
  const real = fs.readFileSync;
  let n = 0;
  fs.readFileSync = function (p, ...rest) {
    if (/paper[\\/]trader[\\/]journal\.jsonl$/.test(String(p))) n += 1;
    return real.call(this, p, ...rest);
  };
  try {
    const out = fn();
    return { out, n };
  } finally {
    fs.readFileSync = real;
  }
}

// A funded book with hours, one grant opened and filled, and one waiting.
function bookWith(t) {
  const s = deskWith(t);
  const { ws, pid, rid } = s;
  settle(ws);
  const now0 = Date.now();
  const top = Math.floor(now0 / H) * H;
  TD.applyHours(ws, Array.from({ length: 16 }, (_, i) => bar(top - (16 - i) * H)), { now: iso(now0) });
  T.decide(ws, pid, { receipt_id: rid, action: 'halve', request_id: 'req_reads_halve01' });
  const fill = Math.ceil(Date.now() / H) * H;
  const pre = Array.from({ length: Math.round((fill - top) / H) }, (_, i) => bar(top + i * H));
  TD.applyHours(ws, [...pre, bar(fill, { volume: '100000' })], { now: iso(fill + H + 15 * M) });
  return { ...s, at: iso(fill + H + 20 * M) };
}

test('brief 5: the Paper Book view reads the journal once per phase, with the same answer', (t) => {
  const { ws, at } = bookWith(t);
  const { out, n } = journalReads(t, () => TD.view(ws, { now: at }));
  // One snapshot: the engine's results, intents and hours, one read each (6
  // before; one read for all three needs an engine API, a [P] follow-up).
  assert.equal(n, 3, `view read the journal ${n} times`);
  // The same answer as its parts read on their own.
  const PT = require('../core/paper-trader');
  assert.deepEqual(out.results.orders.map((o) => o.client_order_id), PT.results(ws, { now: at }).orders.map((o) => o.client_order_id));
  assert.deepEqual(out.hours, PT.hours(ws));
  assert.deepEqual(out.refusals.map((r) => r.intent_id), PT.intents(ws).filter((i) => i.state === 'REFUSED').map((i) => i.intent_id));
  assert.deepEqual(out.requests, TD.requests(ws, { now: at }).requests);
  const again = TD.view(ws, { now: at });
  assert.deepEqual(again, out, 'a second read gives the same view');
});

test('brief 5: a step with nothing to do reads the book once, and reads it again after each thing it records', (t) => {
  const { ws, at } = bookWith(t);
  TD.step(ws, { now: at });
  const idle = journalReads(t, () => TD.step(ws, { now: at }));
  assert.equal(idle.out.done.length, 0);
  assert.equal(idle.n, 3, `an idle step read the journal ${idle.n} times (10 before)`);
  assert.deepEqual(idle.out.requests, TD.requests(ws, { now: at }).requests, 'its requests are the book as it stands');
  // Undo: the step records a sell; the requests it returns are read after it.
  const pid = idle.out.requests[0].project_id;
  const rid = idle.out.requests[0].receipt_id;
  T.decide(ws, pid, { receipt_id: rid, action: 'undo', request_id: 'req_reads_undo001' });
  const later = iso(Date.parse(at) + M);
  const busy = TD.step(ws, { now: later });
  assert.ok(busy.done.some((d) => d.kind === 'close' && d.status === 'saved'));
  assert.deepEqual(busy.requests, TD.requests(ws, { now: later }).requests, 'never the book from before the sell');
  assert.deepEqual(busy.settlement, TD.requests(ws, { now: later }).settlement);
});
