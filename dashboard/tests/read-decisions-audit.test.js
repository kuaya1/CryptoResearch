'use strict';

// Eric's ruling of 2026-11-03: readDecisions keeps skipping a line it cannot
// read and warns for the audit; it never crashes on a historical log. All
// records here are fictional, in temporary folders.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const T = require('../core/tickets');

const PID = 'fictional-project';
const REL = `projects/${PID}/tickets/decisions.jsonl`;
const GOOD = (n) => JSON.stringify({ decision_id: `td_${n}`, decision: 'pass' });

function desk(t, text) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-read-decisions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const ws = { root, abs: (rel) => path.join(root, rel) };
  if (text !== undefined) write(ws, text);
  return ws;
}
function write(ws, text) {
  fs.mkdirSync(path.dirname(ws.abs(REL)), { recursive: true });
  fs.writeFileSync(ws.abs(REL), text);
}
const warnings = (t) => t.mock.method(console, 'warn', () => {});
const said = (mock) => mock.mock.calls.map((c) => c.arguments.join(' '));

test('a damaged line in the middle is skipped, the rest read, and it warns for the audit', (t) => {
  const ws = desk(t, `${GOOD(1)}\n{"torn\n${GOOD(2)}\n`);
  const warn = warnings(t);
  assert.deepEqual(T.readDecisions(ws, PID).map((d) => d.decision_id), ['td_1', 'td_2']);
  assert.equal(warn.mock.callCount(), 1);
  const [line] = said(warn);
  assert.match(line, /^\[audit\] /);
  assert.ok(line.includes(REL), 'it names the log');
  assert.match(line, /1 unreadable line/);
  assert.match(line, /line 2\b/);
});

test('a torn last line warns too, and a log with nothing readable returns empty without throwing', (t) => {
  const warn = warnings(t);
  assert.deepEqual(T.readDecisions(desk(t, `${GOOD(1)}\n{"torn`), PID).map((d) => d.decision_id), ['td_1']);
  assert.deepEqual(T.readDecisions(desk(t, '{"torn\nnot json\n'), PID), []);
  assert.equal(warn.mock.callCount(), 2);
  assert.match(said(warn)[1], /2 unreadable lines/);
});

test('the warning never repeats a line or the folder it sits in', (t) => {
  const marker = 'FICTIONAL-LINE-CONTENT';
  const ws = desk(t, `${GOOD(1)}\n{"note":"${marker}\n`);
  const warn = warnings(t);
  T.readDecisions(ws, PID);
  const [line] = said(warn);
  assert.ok(!line.includes(marker), 'a line can hold anything, so its words stay out of the log');
  assert.ok(!line.includes(ws.root), 'the machine\'s folders stay out of the log');
});

test('a read writes nothing: the warning goes to the log, not the records', (t) => {
  const text = `${GOOD(1)}\n{"torn\n`;
  const ws = desk(t, text);
  warnings(t);
  const listing = () => fs.readdirSync(ws.root, { recursive: true }).sort();
  const before = listing();
  T.readDecisions(ws, PID);
  assert.deepEqual(listing(), before);
  assert.equal(fs.readFileSync(ws.abs(REL), 'utf8'), text);
});

test('a clean log and a missing log are silent', (t) => {
  const warn = warnings(t);
  assert.equal(T.readDecisions(desk(t, `${GOOD(1)}\n\n${GOOD(2)}\n`), PID).length, 2);
  assert.deepEqual(T.readDecisions(desk(t), PID), []);
  assert.equal(warn.mock.callCount(), 0);
});

test('the same damage warns once, a new damaged line warns again, and a repair resets it', (t) => {
  const ws = desk(t, `{"torn\n${GOOD(1)}\n`);
  const warn = warnings(t);
  T.readDecisions(ws, PID);
  T.readDecisions(ws, PID);
  assert.equal(warn.mock.callCount(), 1, 'the log is read on every page, so one damaged line must not flood it');
  write(ws, `{"torn\n${GOOD(1)}\n{"torn again\n`);
  T.readDecisions(ws, PID);
  assert.equal(warn.mock.callCount(), 2);
  assert.match(said(warn)[1], /line 1, 3\b/);
  write(ws, `${GOOD(1)}\n`);
  T.readDecisions(ws, PID);
  assert.equal(warn.mock.callCount(), 2);
  write(ws, `{"torn\n${GOOD(1)}\n{"torn again\n`);
  T.readDecisions(ws, PID);
  assert.equal(warn.mock.callCount(), 3, 'damage that returns after a repair is new damage');
});

test('two desks with the same project warn separately', (t) => {
  const text = '{"torn\n';
  const warn = warnings(t);
  T.readDecisions(desk(t, text), PID);
  T.readDecisions(desk(t, text), PID);
  assert.equal(warn.mock.callCount(), 2);
});

test('line numbers are the file\'s own, blank lines counted, and a long list is cut but the count is not', (t) => {
  const warn = warnings(t);
  T.readDecisions(desk(t, `${GOOD(1)}\n\n{"torn\n`), PID);
  assert.match(said(warn)[0], /line 3\b/);
  T.readDecisions(desk(t, `${'{"torn\n'.repeat(30)}`), PID);
  const long = said(warn)[1];
  assert.match(long, /30 unreadable lines/);
  assert.match(long, /line 1, 2, /);
  assert.ok(!/\b21\b/.test(long), 'the list stops at twenty');
  assert.match(long, /and 10 more/);
});

test('what it returns is what it always returned', (t) => {
  warnings(t);
  const text = [GOOD(1), '', '{"torn', 'null', '0', 'false', '""', '5', '"text"', '[1]', GOOD(2), ''].join('\n');
  const before = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  assert.deepEqual(T.readDecisions(desk(t, text), PID), before);
});

test('a line read but dropped is reported as skipped, since it does not count either', (t) => {
  const warn = warnings(t);
  T.readDecisions(desk(t, `${GOOD(1)}\nnull\n`), PID);
  assert.match(said(warn)[0], /1 unreadable line.*line 2\b/);
});

test('the warning says what skipping means, and that the log was not changed', (t) => {
  const warn = warnings(t);
  T.readDecisions(desk(t, '{"torn\n'), PID);
  const [line] = said(warn);
  assert.match(line, /veto or Undo/);
  assert.match(line, /not changed/);
  assert.doesNotMatch(line, /\bsafe\b/i);
});

test('the warning goes to stderr, so a command\'s JSON on stdout stays clean', (t) => {
  const ws = desk(t, `${GOOD(1)}\n{"torn\n`);
  const script = `
    const T = require(${JSON.stringify(path.join(__dirname, '..', 'core', 'tickets.js'))});
    const path = require('path');
    const root = ${JSON.stringify(ws.root)};
    process.stdout.write(JSON.stringify(T.readDecisions({ root, abs: (r) => path.join(root, r) }, ${JSON.stringify(PID)})));`;
  const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 0);
  assert.deepEqual(JSON.parse(run.stdout).map((d) => d.decision_id), ['td_1']);
  assert.match(run.stderr, /^\[audit\] /m);
});
