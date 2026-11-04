// The daily brief's read of the trader book. The brief's clock is a number;
// trader-desk.view takes an ISO-8601 time. Handed the number, view refused
// before opening a record, and the brief said every book, healthy or not,
// could not be read.
//
// Two groups, kept apart on purpose:
// - "reproduces" fails on the code before this fix: a book that reads must
//   not be called unreadable, and what the book says must reach the brief.
// - "guard" also passes on the code before this fix, where every read was
//   refused anyway, so there it proves nothing about the record. Each one
//   therefore first asks the book directly, with a valid time, and requires
//   the book itself to refuse. Temporary fictional workspaces only.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tempWorkspace, hashTree } = require('./helpers');
const B = require('../core/brief-daily');
const D = require('../core/trader-desk');
const PT = require('../core/paper-trader');

const NOW = Date.parse('2026-10-05T00:00:00Z');
const ISO = '2026-10-05T00:00:00.000Z';
const FUNDED_AT = '2026-10-01T00:00:00.000Z';
const JOURNAL = 'paper/trader/journal.jsonl';
const HEAD = 'paper/trader/journal.head.json';
const VENUE = 'paper/trader/venue.jsonl';

const reasons = (att) => att.exceptions.items.map((e) => e.reason);
const exceptionsSection = (ws) => B.brief(ws, { now: NOW }).sections.find((s) => s.id === 'exceptions');
const fund = (ws) => PT.fund(ws, { cash_usd: '1000', now: FUNDED_AT });

test('reproduces: a book that reads is no exception, fresh or funded, and the count is a number', (t) => {
  const { ws, cleanup } = tempWorkspace('brief-trader-reads');
  t.after(cleanup);
  for (const stage of ['fresh', 'funded']) {
    if (stage === 'funded') fund(ws);
    const att = B.attention(ws, { now: NOW });
    assert.ok(!reasons(att).includes('trader_unreadable'), `${stage}: ${reasons(att).join()}`);
    assert.equal(typeof att.exceptions.count, 'number', stage);
    const sec = exceptionsSection(ws);
    assert.equal(sec.state, 'ok', stage);
    assert.equal(typeof sec.count, 'number', stage);
  }
});

test('reproduces: the brief hands the book an ISO-8601 time, and what the book says reaches the brief', (t) => {
  const { ws, cleanup } = tempWorkspace('brief-trader-signal');
  t.after(cleanup);
  let seen = null;
  t.mock.method(D, 'view', (_ws, { now }) => {
    seen = now;
    return { settlement: { state: 'unsettled', words: 'FICTIONAL hour missing.' }, requests: [{ phase: 'waiting', project_id: 'fictional', project: 'Fictional', decision_id: 'd1', exit_as_of: '2026-10-02T12:00:00Z' }] };
  });
  const att = B.attention(ws, { now: NOW });
  assert.equal(seen, ISO);
  assert.ok(reasons(att).includes('book_unsettled'), reasons(att).join());
  assert.ok(reasons(att).includes('exit_expiring'), reasons(att).join());
});

test('the brief now opens the book on every read, and that read writes nothing', (t) => {
  const { root, ws, cleanup } = tempWorkspace('brief-trader-nowrite');
  t.after(cleanup);
  fund(ws);
  const before = hashTree(root);
  B.attention(ws, { now: NOW });
  B.brief(ws, { now: NOW });
  assert.deepEqual(hashTree(root), before);
});

const STATES = [
  ['a journal line that is not JSON', (ws) => {
    fs.mkdirSync(path.dirname(ws.abs(JOURNAL)), { recursive: true });
    fs.writeFileSync(ws.abs(JOURNAL), 'FICTIONAL not json\n');
  }],
  ['a journal line that does not follow the one before it', (ws) => {
    fund(ws);
    fs.appendFileSync(ws.abs(JOURNAL), `${JSON.stringify({ seq: 5, prev_sha256: 'FICTIONAL', type: 'fund' })}\n`);
  }],
  ['a journal with lines whose head record is missing', (ws) => {
    fund(ws);
    fs.rmSync(ws.abs(HEAD));
  }],
  ['a head record that does not read', (ws) => {
    fund(ws);
    fs.writeFileSync(ws.abs(HEAD), 'FICTIONAL not json');
  }],
  ['a missing journal whose head record names its lines', (ws) => {
    fund(ws);
    fs.rmSync(ws.abs(JOURNAL));
  }],
  ['a journal emptied under its head record', (ws) => {
    fund(ws);
    fs.writeFileSync(ws.abs(JOURNAL), '');
  }],
  ['a venue record of an order the journal never sent', (ws) => {
    fund(ws);
    fs.writeFileSync(ws.abs(VENUE), `${JSON.stringify({ client_order_id: 'cr2-fictional' })}\n`);
  }],
  ['a read error other than a missing file', (ws) => {
    fs.mkdirSync(ws.abs(JOURNAL), { recursive: true });
  }],
];

for (const [name, damage] of STATES) {
  test(`guard: ${name} is said as unreadable, its count unknown, never zero`, (t) => {
    const { ws, cleanup } = tempWorkspace('brief-trader-damaged');
    t.after(cleanup);
    damage(ws);
    assert.throws(() => D.view(ws, { now: ISO }), (e) => e.code === 'INTEGRITY', 'the book itself refuses, at a valid time');
    const att = B.attention(ws, { now: NOW });
    assert.ok(reasons(att).includes('trader_unreadable'), reasons(att).join());
    assert.equal(att.exceptions.count, null);
    const sec = exceptionsSection(ws);
    assert.equal(sec.state, 'partial');
    assert.equal(sec.count, null);
    assert.ok(sec.lines.some((l) => l.unreadable === true && /trader record could not be read/.test(l.text)), 'visible in the brief');
  });
}
