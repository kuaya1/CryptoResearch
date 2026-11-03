'use strict';
// Honest job status (blueprint 2026-11-03 §4 PR 2; audit A3/S3, S4/S4b,
// S5/E3; Eric's correction 2): a run whose own work partly failed is
// `impaired`, which is not a success, so job state records last_failure_at
// and last_error and never advances last_success_at. Before this PR a mandate
// sweep that threw, a book step that threw (in the jobs tick or inside the
// candle refresh), unknown accounting and a housekeeping throw all read as
// success. FICTIONAL temporary workspaces; stand-ins only for the throws;
// no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const jobs = require('../core/jobs');
const research = require('../core/research');
const T = require('../core/tickets');
const C = require('../core/trader-candles');
const REAL_REFRESH = C.refresh;
const TD = require('../core/trader-desk');
const PW = require('../core/pilot-worker');
const DC = require('../core/desk-controls');
const { mockReport } = require('../core/demo');
const { tempWorkspace } = require('./helpers');
const { mandateDesk } = require('./mandate-fixture');

const HOUR = 3600000;

function noNetwork(t) {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => { asked.push(String(url)); throw new Error(`FICTIONAL: no network to ${url}`); };
  t.after(() => { globalThis.fetch = real; });
  return asked;
}
// Replace one export for this test only.
function stub(t, mod, name, fn) {
  const real = mod[name];
  mod[name] = fn;
  t.after(() => { mod[name] = real; });
}
const boom = (what) => () => { throw new Error(`FICTIONAL ${what} failure`); };
const traderState = (ws) => jobs.readJobState(ws).jobs.trader || {};

function desk(t) {
  const w = tempWorkspace('honest-jobs');
  t.after(w.cleanup);
  return w;
}

// One clean trader run first, so last_success_at has a value the failing run
// must leave alone.
async function primed(t) {
  const w = desk(t);
  stub(t, T, 'mandateSweep', () => ({ status: 'ok', message: 'FICTIONAL sweep: nothing to grant.' }));
  stub(t, C, 'refresh', async () => ({ status: 'ok', message: 'FICTIONAL hours applied.', counts: { problems: [], step: { done: 1, problems: 0 } } }));
  await jobs.runJobs(w.ws, ['trader'], { trigger: 'dashboard' });
  const before = traderState(w.ws);
  assert.equal(before.last_status, 'ok');
  assert.ok(before.last_success_at);
  await new Promise((r) => setTimeout(r, 5));
  return { ...w, before };
}
function assertImpaired(ws, before, reasons) {
  const s = traderState(ws);
  assert.equal(s.last_status, 'impaired');
  assert.equal(s.last_success_at, before.last_success_at, 'last_success_at is not advanced');
  assert.ok(s.last_failure_at && s.last_failure_at > before.last_success_at, 'last_failure_at is set');
  assert.match(s.last_error, new RegExp(`^Impaired \\(${reasons.join(', ')}\\): `));
  assert.ok(s.last_error.length <= 500);
}

test('impaired is a job status that is not a success', () => {
  assert.equal(jobs.OK_STATUSES.has('impaired'), false);
  assert.equal(jobs.OK_STATUSES.has('attention'), true, 'attention stays a success (unchanged)');
});

test('S3: the mandate sweep throws and the candles are ok: impaired, mandate_sweep_failed, last_success_at kept', async (t) => {
  noNetwork(t);
  const s = await primed(t);
  stub(t, T, 'mandateSweep', boom('sweep'));
  await jobs.runJobs(s.ws, ['trader'], { trigger: 'dashboard' });
  assertImpaired(s.ws, s.before, ['mandate_sweep_failed']);
  assert.match(traderState(s.ws).last_error, /Paper mandate sweep failed: FICTIONAL sweep failure/);
});

test('A3: the sweep throws, the refresh is noop and the jobs tick\'s book step throws: impaired, both reasons; the step still ran after the sweep failure', async (t) => {
  noNetwork(t);
  const s = await primed(t);
  stub(t, T, 'mandateSweep', boom('sweep'));
  stub(t, C, 'refresh', async () => ({ status: 'noop', message: 'FICTIONAL: no hours needed.', counts: { problems: [], step: null } }));
  let stepped = 0;
  stub(t, TD, 'step', () => { stepped += 1; throw new Error('FICTIONAL step failure'); });
  await jobs.runJobs(s.ws, ['trader'], { trigger: 'dashboard' });
  assert.equal(stepped, 1, 'the risk-reducing step still ran');
  assertImpaired(s.ws, s.before, ['mandate_sweep_failed', 'book_step_problems']);
  assert.match(traderState(s.ws).last_error, /The book's step failed: FICTIONAL step failure/);
});

test('correction 2: the sweep and the candle read succeed and only TD.step() inside trader-candles.refresh throws: impaired, book_step_problems', async (t) => {
  const asked = noNetwork(t);
  const s = await primed(t);
  stub(t, T, 'mandateSweep', () => ({ status: 'ok', message: 'FICTIONAL sweep: nothing to grant.' }));
  // The real refresh: one wanted pair whose hours are already current, so no
  // candle request is needed and none fails; then its own step throws.
  stub(t, C, 'refresh', REAL_REFRESH);
  stub(t, TD, 'wanted', () => [{ pair: 'FICT/USDC', project_id: 'fictional-project', last_hour: new Date(Date.now() + HOUR).toISOString() }]);
  let stepped = 0;
  stub(t, TD, 'step', () => { stepped += 1; throw new Error('FICTIONAL inner step failure'); });
  const r = await C.refresh(s.ws, { trigger: 'test' });
  assert.equal(r.status, 'attention', 'the refresh itself reads attention');
  assert.equal(r.counts.step, null, 'counts.step stays absent when the step throws');
  assert.deepEqual(r.counts.problems.map((p) => p.step), ['step']);
  assert.equal(stepped, 1);
  await jobs.runJobs(s.ws, ['trader'], { trigger: 'dashboard' });
  assert.equal(stepped, 2, 'the job ran the refresh, whose step threw');
  assert.deepEqual(asked, [], 'no candle request was sent');
  assertImpaired(s.ws, s.before, ['book_step_problems']);
  assert.match(traderState(s.ws).last_error, /FICTIONAL inner step failure/);
});

test('S4: accounting unknown (the refresh is held with accounting_unknown): impaired, accounting_unknown, never skipped', async (t) => {
  noNetwork(t);
  const s = await primed(t);
  stub(t, C, 'refresh', async () => ({ status: 'held', accounting_unknown: true, message: 'Candle collection stopped: FICTIONAL accounting unknown.', counts: { problems: [], step: { done: 0, problems: 0 } } }));
  await jobs.runJobs(s.ws, ['trader'], { trigger: 'dashboard' });
  assertImpaired(s.ws, s.before, ['accounting_unknown']);
});

test('S4b control: a restored copy\'s held stays skipped, a success', async (t) => {
  noNetwork(t);
  const s = await primed(t);
  stub(t, C, 'refresh', async () => ({ status: 'held', message: 'A restored copy: FICTIONAL.' }));
  await jobs.runJobs(s.ws, ['trader'], { trigger: 'dashboard' });
  const st = traderState(s.ws);
  assert.equal(st.last_status, 'skipped');
  assert.ok(st.last_success_at > s.before.last_success_at);
});

test('S4c control: a candle failure stays failed', async (t) => {
  noNetwork(t);
  const s = await primed(t);
  stub(t, C, 'refresh', async () => ({ status: 'failed', message: 'FICTIONAL GeckoTerminal failure.' }));
  await jobs.runJobs(s.ws, ['trader'], { trigger: 'dashboard' });
  const st = traderState(s.ws);
  assert.equal(st.last_status, 'failed');
  assert.equal(st.last_error, 'FICTIONAL GeckoTerminal failure.');
  assert.equal(st.last_success_at, s.before.last_success_at);
});

test('the daily brief flags an impaired trader job as failing', async (t) => {
  noNetwork(t);
  const s = await primed(t);
  stub(t, T, 'mandateSweep', boom('sweep'));
  await jobs.runJobs(s.ws, ['trader'], { trigger: 'dashboard' });
  const ex = JSON.stringify(require('../core/brief-daily').attention(s.ws).exceptions);
  assert.match(ex, /trader/);
  assert.match(ex, /Impaired \(mandate_sweep_failed\)/);
});

test('housekeeping: a throw in sweepCaptures or releaseStaleAssistantJobs makes the research job impaired with the step named, and the research after it still runs', async (t) => {
  noNetwork(t);
  for (const [name, step] of [['sweepCaptures', 'sweep_captures'], ['releaseStaleAssistantJobs', 'release_stale']]) {
    const w = desk(t);
    await jobs.runJobs(w.ws, ['research'], { trigger: 'dashboard' });
    const before = jobs.readJobState(w.ws).jobs.research;
    assert.ok(before && before.last_success_at, `${name}: a clean run first`);
    await new Promise((r) => setTimeout(r, 5));
    const real = research[name];
    research[name] = boom(name);
    let r;
    try {
      r = await research.runDueJobs(w.ws, { trigger: 'test' });
      await jobs.runJobs(w.ws, ['research'], { trigger: 'dashboard' });
    } finally { research[name] = real; }
    assert.equal(r.status, 'impaired', name);
    assert.deepEqual(r.housekeeping, [{ step, error: `FICTIONAL ${name} failure` }]);
    assert.match(r.summary, /^Housekeeping failed: /);
    assert.match(r.summary, /No research jobs waiting/, 'the research pass still ran');
    const st = jobs.readJobState(w.ws).jobs.research;
    assert.equal(st.last_status, 'impaired', name);
    assert.match(st.last_error, new RegExp(`Housekeeping failed: ${step} \\(FICTIONAL ${name} failure\\)`));
    assert.equal(st.last_success_at, before.last_success_at, `${name}: last_success_at not advanced`);
  }
});
