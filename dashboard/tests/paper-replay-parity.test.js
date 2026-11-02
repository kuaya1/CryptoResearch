'use strict';
// Same-engine continuous, restart and replay equivalence (blueprint
// 2026-11-02 §9 row 10, option B: no execution stamp, the engine as it is).
// One fictional decision is made; then the same closed hours, controls and
// clock are run three ways: continuously in one process, with a restart
// (a fresh module graph and the workspace reopened from disk) before every
// call and each call repeated once after its restart, and replayed from the
// copied journal in a separate Node process. Events and results must be
// identical. Changed input is refused; history missing from the journal's
// end, an edited line or a missing hour is refused, never read as complete.
// Temporary FICTIONAL workspaces only; no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const T = require('../core/tickets');
const TD = require('../core/trader-desk');
const PT = require('../core/paper-trader');
const { openWorkspace } = require('../core/workspace');
const { H, M, iso, settle, bar, deskWith } = require('./trader-fixture');

const CORE = path.join(__dirname, '..', 'core');
const TRADER_FILES = [PT.JOURNAL, PT.HEAD, PT.VENUE];

// A restart: every core module loaded again, the workspace opened from disk.
function restarted(root) {
  for (const k of Object.keys(require.cache)) if (k.startsWith(CORE + path.sep)) delete require.cache[k];
  const td = require(path.join(CORE, 'trader-desk'));
  const ws = require(path.join(CORE, 'workspace')).openWorkspace({ root, actor: 'test' });
  return { td, ws };
}
const fileOf = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch (_) { return null; } };
const copy = (from, t) => {
  const to = `${from}-copy-${Math.random().toString(36).slice(2, 8)}`;
  fs.cpSync(from, to, { recursive: true });
  t.after(() => fs.rmSync(to, { recursive: true, force: true, maxRetries: 5 }));
  return to;
};
// The parts of a step's answer that are the book's: what was done and what
// failed, without words that may name the time they were read.
const outcome = (r) => (Array.isArray(r) ? r.map((x) => ({ pair: x.pair, hour: x.hour, status: x.status, code: x.code || null, events: x.events || null })) : { done: r.done.map((d) => ({ kind: d.kind, status: d.status, state: d.state })), problems: r.problems.map((p) => ({ kind: p.kind, code: p.code })) });

// One fictional decision with a live order in the book, saved to disk with
// Eric's trader settings, so a reopened workspace reads the same desk.
function decided(t) {
  const s = deskWith(t);
  settle(s.ws);
  const f = path.join(s.root, 'config', 'settings.json');
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), trader: s.ws.settings.trader }, null, 2));
  const now0 = Date.now();
  const top = Math.floor(now0 / H) * H;
  TD.applyHours(s.ws, Array.from({ length: 16 }, (_, i) => bar(top - (16 - i) * H)), { now: iso(now0) });
  const ap = T.decide(s.ws, s.pid, { receipt_id: s.rid, action: 'approve', by: 'eric' });
  assert.equal(ap.result.trader.status, 'order', 'the decision reserved a Trader Sim order');
  return { ...s, top, decision: ap.result.decision };
}

// The same closed hours, controls and clock, in order: a fill, a step, the
// target reached, a step, a quiet hour, a step.
const schedule = (top) => [
  { call: 'applyHours', bars: [bar(top), bar(top + H, { low: '0.80', volume: '1000000' })], now: iso(top + 2 * H + 11 * M) },
  { call: 'step', now: iso(top + 2 * H + 12 * M) },
  { call: 'applyHours', bars: [bar(top + 2 * H, { high: '1.45' })], now: iso(top + 3 * H + 11 * M) },
  { call: 'step', now: iso(top + 3 * H + 12 * M) },
  { call: 'applyHours', bars: [bar(top + 3 * H)], now: iso(top + 4 * H + 11 * M) },
  { call: 'step', now: iso(top + 4 * H + 12 * M) },
];
const run = (td, ws, c) => (c.call === 'applyHours' ? td.applyHours(ws, c.bars, { now: c.now }) : td.step(ws, { now: c.now }));

// The book's reads in a separate Node process, from the files alone.
function replayElsewhere(root, now) {
  const code = `
    const [core, root, now] = process.argv.slice(1);
    const PT = require(require('path').join(core, 'paper-trader'));
    const ws = require(require('path').join(core, 'workspace')).openWorkspace({ root, actor: 'test' });
    process.stdout.write(JSON.stringify({ results: PT.results(ws, { now }), intents: PT.intents(ws), hours: PT.hours(ws) }));
  `;
  const r = spawnSync(process.execPath, ['-e', code, CORE, root, now], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(r.status, 0, `the replay process failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('continuous, restarted and replayed runs of the same inputs give identical events and results', (t) => {
  const d = decided(t);
  const rootA = d.root;
  const rootB = copy(rootA, t);
  const plan = schedule(d.top);
  const end = iso(d.top + 4 * H + 30 * M);

  // A: one process, one workspace, start to end.
  const a = { td: TD, ws: openWorkspace({ root: rootA, actor: 'test' }) };
  const outA = plan.map((c) => outcome(run(a.td, a.ws, c)));

  // B: restarted before every call, and every call repeated after a second
  // restart, as a runner killed after its work and started again would.
  const outB = [];
  const repeats = [];
  for (const c of plan) {
    const b1 = restarted(rootB);
    outB.push(outcome(run(b1.td, b1.ws, c)));
    const b2 = restarted(rootB);
    repeats.push(outcome(run(b2.td, b2.ws, c)));
  }
  const fresh = restarted(rootB); // B's book read after one more restart

  // The scenario did what it says: a fill, then the target's exit.
  const events = fileOf(rootA, PT.JOURNAL).trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.type === 'fill'), 'an hour filled the order');
  assert.ok(events.some((e) => e.type === 'exit' && e.reason === 'take_profit'), 'the target closed the position');

  // Identical events: the journal, its head and the venue, byte for byte.
  for (const rel of TRADER_FILES) assert.equal(fileOf(rootB, rel), fileOf(rootA, rel), `${rel} differs between the continuous and the restarted run`);
  assert.deepEqual(outB, outA, 'each call answered the same');
  // A call repeated after a restart records nothing new.
  for (const [i, r] of repeats.entries()) {
    if (Array.isArray(r)) for (const row of r) assert.ok(['unchanged', 'skipped'].includes(row.status) || row.pair === null, `call ${i + 1} repeated: ${JSON.stringify(row)}`);
    else assert.deepEqual(r.done.filter((x) => x.status === 'saved'), [], `call ${i + 1} repeated saved something: ${JSON.stringify(r.done)}`);
  }

  // Identical results: in process, after the restarts, and replayed in a
  // separate process from a copy of the files.
  const wsA = openWorkspace({ root: rootA, actor: 'test' });
  const wsB = fresh.ws;
  const PTB = require(path.join(CORE, 'paper-trader'));
  const here = { results: PT.results(wsA, { now: end }), intents: PT.intents(wsA), hours: PT.hours(wsA) };
  assert.deepEqual({ results: PTB.results(wsB, { now: end }), intents: PTB.intents(wsB), hours: PTB.hours(wsB) }, here);
  assert.deepEqual(replayElsewhere(copy(rootA, t), end), JSON.parse(JSON.stringify(here)));
  assert.deepEqual(fresh.td.view(wsB, { now: end }), TD.view(wsA, { now: end }), 'the desk\'s view of the book is the same');
  assert.equal(here.results.closed_positions.length, 1);
  assert.equal(here.results.open_positions.length, 0);
});

test('changed input is refused and records nothing', (t) => {
  const d = decided(t);
  const ws = openWorkspace({ root: d.root, actor: 'test' });
  const [first] = schedule(d.top);
  TD.applyHours(ws, first.bars, { now: first.now });
  const before = TRADER_FILES.map((rel) => fileOf(d.root, rel));
  // The same hour with a different close.
  const r = TD.applyHours(ws, [bar(d.top + H, { low: '0.80', volume: '1000000', close: '0.86' })], { now: first.now });
  assert.equal(r.find((x) => x.hour === iso(d.top + H)).code, 'CONFLICT');
  // An hour before the last on record.
  const r2 = TD.applyHours(ws, [bar(d.top - 20 * H)], { now: first.now });
  assert.ok(['ORDER', 'CONFLICT'].includes(r2.find((x) => x.pair).code));
  assert.deepEqual(TRADER_FILES.map((rel) => fileOf(d.root, rel)), before, 'nothing was written');
});

test('history missing from the journal\'s end, an edited line or a missing hour is refused, never read as complete', (t) => {
  const d = decided(t);
  const ws = openWorkspace({ root: d.root, actor: 'test' });
  for (const c of schedule(d.top).slice(0, 2)) run(TD, ws, c);
  const now = iso(d.top + 3 * H);

  // Lines lost from the journal's end: its head names a later line.
  const cut = copy(d.root, t);
  const lines = fileOf(cut, PT.JOURNAL).trim().split('\n');
  fs.writeFileSync(path.join(cut, PT.JOURNAL), `${lines.slice(0, -1).join('\n')}\n`);
  const wsCut = openWorkspace({ root: cut, actor: 'test' });
  assert.throws(() => PT.results(wsCut, { now }), (err) => err.code === 'INTEGRITY' && /lines were lost from its end/.test(err.message));
  assert.throws(() => TD.step(wsCut, { now }), (err) => err.code === 'INTEGRITY' || /INTEGRITY|lost/.test(err.message));

  // A line edited in place: the chain of hashes breaks.
  const edit = copy(d.root, t);
  const el = fileOf(edit, PT.JOURNAL).trim().split('\n');
  const k = el.findIndex((l) => JSON.parse(l).type === 'reserved');
  assert.ok(k > 0 && k < el.length - 1, 'the reservation is a line in the middle');
  const e = JSON.parse(el[k]);
  e.quantity = '1';
  el[k] = JSON.stringify(e);
  fs.writeFileSync(path.join(edit, PT.JOURNAL), `${el.join('\n')}\n`);
  assert.throws(() => PT.results(openWorkspace({ root: edit, actor: 'test' }), { now }), (err) => err.code === 'INTEGRITY' && /does not follow the line before it/.test(err.message));

  // The head record gone while the journal has lines.
  const headless = copy(d.root, t);
  fs.rmSync(path.join(headless, PT.HEAD));
  assert.throws(() => PT.results(openWorkspace({ root: headless, actor: 'test' }), { now }), (err) => err.code === 'INTEGRITY' && /head record/.test(err.message));

  // A missing hour while a position is open: refused as a gap and recorded
  // as missing, never filled in or stepped over.
  const before = fileOf(d.root, PT.JOURNAL);
  const r = TD.applyHours(ws, [bar(d.top + 3 * H)], { now: iso(d.top + 4 * H + 11 * M) });
  const row = r.find((x) => x.pair);
  assert.equal(row.code, 'GAP');
  assert.equal(row.gap.missing_hour, iso(d.top + 2 * H));
  assert.equal(fileOf(d.root, PT.JOURNAL), before, 'the book recorded nothing');
  assert.equal(PT.hours(ws)[0].last_hour, iso(d.top + H));
});
