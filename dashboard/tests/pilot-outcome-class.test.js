'use strict';
// The runner's outcome classes (cr-pilot-health@1, blueprint 2026-11-02 §6.1,
// build-plan row 3): every way a run can end gets a class from the row's stop,
// so a refused save or a failed session is never reported as success, and the
// exit codes (0, 3, 1) keep their meaning. Stubs only: no claude -p, no desk.
// FICTIONAL projects and tokens.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../scripts/pilot');

function dirs(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pilot-class-test-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return { lockFile: path.join(d, 'pilot-all.lock'), logFile: path.join(d, 'pilot-all.jsonl') };
}
const lastLog = (f) => JSON.parse(fs.readFileSync(f, 'utf8').trim().split('\n').pop());
const quiet = () => {};
const POLL = 'FICTIONAL-poll-token-0123456789';

// The online pre-poll, answered by a stub desk.
function pollDesk({ steps = [{ project_id: 'a-fictional', step: 'ticket', claim: null }], paused = false, sessions = null, fail = false } = {}) {
  return async () => {
    if (fail) return { status: 503, json: async () => ({}) };
    return { status: 200, json: async () => ({ format: 'cr-pilot-poll@1', paused, sessions, steps }) };
  };
}
// One dispatch whose result is given (runOnline stubbed).
async function runWith(t, result, opts = {}) {
  const d = dirs(t);
  const said = [];
  const impl = typeof result === 'function' ? result : async () => result;
  const code = await P.runAll({ desk: 'online', maxAgents: opts.maxAgents ?? 1, deskUrl: 'https://desk.example.org', dryRun: opts.dryRun },
    { ...d, token: POLL, workerToken: 'FICTIONAL-worker', fetchImpl: opts.fetchImpl || pollDesk(opts.poll), agent: () => '', runOnlineImpl: impl, out: (s) => said.push(s) });
  return { code, log: lastLog(d.logFile), said, d };
}

test('a verified save is ok, exit 0', async (t) => {
  const { code, log, said } = await runWith(t, { sessions: [{ role: 'prosecutor' }], stop: null, claims: [] });
  assert.equal(code, 0);
  assert.equal(log.dispatches[0].health, 'ok');
  assert.equal(log.health, 'ok');
  assert.equal(log.health_format, P.HEALTH_FORMAT);
  assert.ok(said.includes('Health: ok (exit 0).'));
});

test('no work at all is idle, exit 0', async (t) => {
  const { code, log } = await runWith(t, null, { poll: { steps: [{ project_id: 'a-fictional', step: 'pm_review', claim: null }] } });
  assert.equal(code, 0);
  assert.equal(log.dispatches.length, 0);
  assert.equal(log.health, 'idle');
});

test('a closed desk gate saved with no session is idle (§6.1), never ok', async (t) => {
  const { code, log } = await runWith(t, { sessions: [], stop: null, claims: [] }, { poll: { steps: [{ project_id: 'a-fictional', step: 'gate_closed', claim: null }] } });
  assert.equal(code, 0);
  assert.equal(log.dispatches[0].health, 'idle');
  assert.equal(log.health, 'idle');
});

test('automation paused is idle, exit 0', async (t) => {
  const { code, log } = await runWith(t, async () => { throw new Error('nothing is dispatched while paused'); }, { poll: { paused: true } });
  assert.equal(code, 0);
  assert.equal(log.health, 'idle');
});

test('a paused or ceiling claim answer is idle', async (t) => {
  for (const stop of ['paused', 'session_ceiling', 'cap']) {
    const { code, log } = await runWith(t, { sessions: [], stop, claims: [] });
    assert.equal(code, 0, stop);
    assert.equal(log.dispatches[0].health, 'idle', stop);
  }
});

test('the session ceiling and the agent cap, decided by the runner, are idle', async (t) => {
  const ceiling = await runWith(t, async () => { throw new Error('no dispatch past the ceiling'); }, { poll: { sessions: { day: '2026-11-02', used: 4, ceiling: 4, left: 0 } } });
  assert.equal(ceiling.code, 0);
  assert.equal(ceiling.log.dispatches[0].outcome, 'session_ceiling');
  assert.equal(ceiling.log.health, 'idle');
  const two = [{ project_id: 'a-fictional', step: 'ticket', claim: null }, { project_id: 'b-fictional', step: 'ticket', claim: null }];
  const cap = await runWith(t, async (o) => { o.budget.left -= 1; return { sessions: [{ role: 'prosecutor' }], stop: null, claims: [] }; }, { poll: { steps: two } });
  assert.equal(cap.code, 0);
  assert.deepEqual(cap.log.dispatches.map((x) => x.health), ['ok', 'idle']);
  assert.equal(cap.log.health, 'ok', 'a cap after a save is still an ok run');
});

test('another runner holding the claim is attention, exit 0 unchanged', async (t) => {
  const { code, log } = await runWith(t, { sessions: [], stop: 'claimed', words: 'FICTIONAL another runner', claims: [] });
  assert.equal(code, 0);
  assert.equal(log.dispatches[0].outcome, 'not_dispatched');
  assert.equal(log.dispatches[0].health, 'attention');
  assert.equal(log.health, 'attention');
});

test('the correction used or a step that changed under the claim is attention', async (t) => {
  for (const stop of ['correction_limit', 'changed']) {
    const { log } = await runWith(t, { sessions: [], stop, claims: [] });
    assert.equal(log.dispatches[0].health, 'attention', stop);
  }
});

test('the local lock held is attention, exit 0 unchanged', async (t) => {
  const d = dirs(t);
  fs.writeFileSync(d.lockFile, JSON.stringify({ pid: 999999, started_at: new Date().toISOString() }));
  const code = await P.runAll({ desk: 'online', maxAgents: 1, deskUrl: 'https://desk.example.org' }, { ...d, token: POLL, fetchImpl: pollDesk(), agent: () => '', runOnlineImpl: async () => { throw new Error('locked'); }, out: quiet });
  assert.equal(code, 0);
  const log = lastLog(d.logFile);
  assert.equal(log.skipped, 'locked');
  assert.equal(log.health, 'attention');
});

test('an agent failure, a prompt integrity failure, a refused prepare or a refused save is failure, never ok', async (t) => {
  for (const stop of ['agent_failed', 'integrity', 'refused', 'sessions_unknown', 'INTEGRITY', 'BASIS_CHANGED', 'stale_attempt']) {
    const { code, log } = await runWith(t, { sessions: stop === 'agent_failed' ? [{ role: 'researcher' }] : [], stop, claims: [] });
    assert.equal(code, 0, `${stop}: the exit code keeps its meaning`);
    assert.equal(log.dispatches[0].outcome, 'not_dispatched', stop);
    assert.equal(log.dispatches[0].health, 'failure', stop);
    assert.equal(log.health, 'failure', stop);
  }
});

test('an unverified save or any uncertain step is reconcile, exit 3', async (t) => {
  const { code, log } = await runWith(t, { sessions: [{ role: 'prosecutor' }], stop: 'reconcile', claims: [] });
  assert.equal(code, 3);
  assert.equal(log.dispatches[0].health, 'reconcile');
  assert.equal(log.health, 'reconcile');
});

test('a project already waiting to be reconciled at the pre-poll is reconcile, exit 3', async (t) => {
  const { code, log } = await runWith(t, async () => { throw new Error('a reconcile claim is never dispatched'); }, { poll: { steps: [{ project_id: 'a-fictional', step: 'ticket', claim: 'reconcile' }] } });
  assert.equal(code, 3);
  assert.equal(log.dispatches.length, 0);
  assert.equal(log.health, 'reconcile');
});

test('a project Eric stopped is idle', async (t) => {
  const { code, log } = await runWith(t, { sessions: [{ role: 'researcher' }], stop: 'stopped', session_stopped: true, claims: [] });
  assert.equal(code, 0);
  assert.equal(log.dispatches[0].outcome, 'stopped');
  assert.equal(log.dispatches[0].health, 'idle');
});

test('session isolation not established is failure, exit 1', async (t) => {
  const d = dirs(t);
  const agent = Object.assign(() => '', { preflight: async () => { throw new Error('FICTIONAL: the session would be offered Bash'); } });
  const code = await P.runAll({ desk: 'online', maxAgents: 1, deskUrl: 'https://desk.example.org' }, { ...d, token: POLL, fetchImpl: pollDesk(), agent, runOnlineImpl: async () => { throw new Error('nothing is claimed'); }, out: quiet });
  assert.equal(code, 1);
  assert.equal(lastLog(d.logFile).health, 'failure');
});

test('a dispatch exception or a failed poll is failure, exit 1', async (t) => {
  const thrown = await runWith(t, async () => { throw new Error('FICTIONAL socket hang up'); });
  assert.equal(thrown.code, 1);
  assert.equal(thrown.log.dispatches[0].health, 'failure');
  assert.equal(thrown.log.health, 'failure');
  const poll = await runWith(t, null, { fetchImpl: pollDesk({ fail: true }) });
  assert.equal(poll.code, 1);
  assert.equal(poll.log.health, 'failure');
});

test('a dry run is idle', async (t) => {
  const { code, log } = await runWith(t, async () => { throw new Error('no dispatch in a dry run'); }, { dryRun: true });
  assert.equal(code, 0);
  assert.equal(log.dispatches[0].health, 'idle');
  assert.equal(log.health, 'idle');
});

test('the run takes its worst row: failure over reconcile over attention over ok over idle', async (t) => {
  const two = [{ project_id: 'a-fictional', step: 'ticket', claim: null }, { project_id: 'b-fictional', step: 'research', claim: null }];
  const answers = { 'a-fictional': { sessions: [{ role: 'prosecutor' }], stop: null, claims: [] }, 'b-fictional': { sessions: [{ role: 'researcher' }], stop: 'agent_failed', claims: [] } };
  const { code, log } = await runWith(t, async (o) => answers[o.project], { poll: { steps: two }, maxAgents: 2 });
  assert.equal(code, 0);
  assert.deepEqual(log.dispatches.map((x) => x.health), ['ok', 'failure']);
  assert.equal(log.health, 'failure', 'one save does not hide a failed session');
  assert.equal(P.runHealth({ dispatches: [{ outcome: 'done', health: 'ok' }, { stop: 'claimed', outcome: 'not_dispatched' }] }), 'attention');
  assert.equal(P.runHealth({ dispatches: [{ stop: 'claimed', outcome: 'not_dispatched' }], needs_eric: [{ project_id: 'x' }] }), 'reconcile');
  assert.equal(P.runHealth({ dispatches: [] }), 'idle');
  assert.deepEqual(P.HEALTH_ORDER, ['idle', 'ok', 'attention', 'reconcile', 'failure']);
});

test('an answer the runner does not know is failure, never success', () => {
  assert.equal(P.rowHealth({ outcome: 'not_dispatched', stop: 'FICTIONAL_new_code' }), 'failure');
  assert.equal(P.rowHealth({ outcome: 'FICTIONAL' }), 'failure');
  assert.equal(P.rowHealth(null), 'failure');
  assert.equal(P.rowHealth({ outcome: 'done', repoll_error: 'FICTIONAL' }), 'attention');
  // A failed re-poll is never hidden by an idle stop (audit F10).
  for (const stop of ['paused', 'stopped', 'cap', 'session_ceiling']) assert.equal(P.rowHealth({ outcome: 'not_dispatched', stop, repoll_error: 'FICTIONAL' }), 'attention', stop);
  assert.equal(P.rowHealth({ outcome: 'done', sessions: [{ role: 'researcher' }], repoll_error: 'FICTIONAL' }), 'attention');
  // A worse class stays worse.
  assert.equal(P.rowHealth({ outcome: 'not_dispatched', stop: 'refused', repoll_error: 'FICTIONAL' }), 'failure');
  assert.equal(P.rowHealth({ outcome: 'not_dispatched', stop: 'reconcile', repoll_error: 'FICTIONAL' }), 'reconcile');
});
