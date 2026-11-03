'use strict';
// Audit F10 (2026-11-02): the runner's health classes (cr-pilot-health@1,
// blueprint 2026-11-02 §6.1) through the runner's own control flow: runAll,
// then the real runOnline or runLocal, the real worker calls, the real lock
// and the real heartbeat. Only the far side is a stub: an online desk that
// answers cr-pilot-poll@1 and cr-pilot-worker@1, a local CLI, the agent and
// the ping endpoint. Nothing is stubbed between the dispatch and its class.
//
// Covered: a closed desk gate is idle, never ok (online and local); paused
// and stopped are idle with the labels §6.1 names (idle-paused,
// idle-stopped); a failed re-poll is attention however the row ended (an idle
// stop, a save), never hidden; a save is ok; the local lock held by a
// normal overlapping run is attention-overlap and pings /fail as §6.1's
// rev-3 lock row says (whether a normal overlap should alarm is Eric's
// decision, see the PR); exit codes 0, 3 and 1 unchanged. FICTIONAL desk,
// tokens, projects and ping URL; no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const P = require('../scripts/pilot');

const DESK = 'https://desk.fictional.example';
const HC = 'https://hc.fictional.example/ping/0f0f0f0f-FICTIONAL';
const RID = '11111111-2222-4333-8444-555555555555';
const POLL = 'FICTIONAL-poll-token-0123456789';
const WORKER = 'FICTIONAL-worker-token-0123456789';
const W = 'cr-pilot-worker@1';
const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const PROMPT = 'FICTIONAL frozen research prompt';

const TMP_ROOT = os.tmpdir();
const TMP_ENV = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
function sandbox(t) {
  const d = fs.mkdtempSync(path.join(TMP_ROOT, 'cr-pilot-flow-test-'));
  // The runner's scratch goes under os.tmpdir(); keep it in this sandbox.
  for (const k of Object.keys(TMP_ENV)) process.env[k] = d;
  t.after(() => {
    for (const [k, v] of Object.entries(TMP_ENV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(d, { recursive: true, force: true });
  });
  return { lockFile: path.join(d, 'pilot-all.lock'), logFile: path.join(d, 'pilot-all.jsonl') };
}
const lastLog = (f) => JSON.parse(fs.readFileSync(f, 'utf8').trim().split('\n').pop());
function pinger() {
  const urls = [];
  return { urls, fn: async (url) => { urls.push(url); return { status: 200, ok: true }; } };
}
const reply = (status, body) => ({ status, ok: status < 400, json: async () => body });

// An online desk: each route answers from its own queue, in order. A poll
// answer of 'fail' is a 503 (the re-poll did not answer).
function onlineDesk(script) {
  const seen = [];
  const q = { poll: [...(script.poll || [])], claim: [...(script.claim || [])], prepare: [...(script.prepare || [])], complete: [...(script.complete || [])] };
  const fn = async (url, init = {}) => {
    const u = new URL(String(url));
    assert.equal(u.origin, DESK, 'only the FICTIONAL desk is asked');
    if (u.pathname === '/api/pilot/queue') {
      seen.push('poll');
      const a = q.poll.length > 1 ? q.poll.shift() : q.poll[0];
      return a === 'fail' ? reply(503, {}) : reply(200, { format: 'cr-pilot-poll@1', paused: false, sessions: null, ...a });
    }
    const op = u.pathname.replace('/api/pilot/worker/', '');
    seen.push(op);
    if (op === 'release') return reply(200, { format: W, status: 'released' });
    const a = q[op] && q[op].shift();
    if (!a) throw new Error(`FICTIONAL desk: no answer scripted for ${op}`);
    return reply(200, { format: W, ...a });
  };
  return { fn, seen };
}
const claimed = (step) => ({ status: 'claimed_now', token: 'FICTIONAL-claim-token', attempt_id: 'pa_fictional01', key: 'k-fictional', step, expires_at: new Date(Date.now() + 3600000).toISOString() });
const prepared = { status: 'prepared', role: 'researcher', attempt_id: 'pa_fictional01', run_id: 'run_fictional01', prompt: PROMPT, prompt_sha256: sha(PROMPT), sessions: { used: 1, ceiling: 4 } };
const steps = (step) => ({ steps: [{ project_id: 'a-fictional', step, claim: null }] });

async function online(t, script, { paused = false } = {}) {
  const f = sandbox(t);
  const desk = onlineDesk(script);
  const ping = pinger();
  const said = [];
  const agent = (prompt) => { assert.equal(prompt, PROMPT, 'the session gets the frozen prompt'); return 'FICTIONAL report text'; };
  const code = await P.runAll({ desk: 'online', deskUrl: DESK, maxAgents: 1, pilotAll: true }, { fetchImpl: desk.fn, token: POLL, workerToken: WORKER, agent, env: { CR_HEALTHCHECK_URL: HC }, pingFetch: ping.fn, newRid: () => RID, out: (s) => said.push(s), ...f });
  void paused;
  return { code, log: lastLog(f.logFile), pings: ping.urls, said, seen: desk.seen };
}
const finalPing = (r) => r.pings[1];

test('a closed desk gate, through the real online flow, is idle with ping /0, never ok', async (t) => {
  const r = await online(t, { poll: [steps('gate_closed'), steps('pm_review')], claim: [claimed('gate_closed'), { status: 'nothing', step: 'pm_review' }], prepare: [{ status: 'gate_closed', receipt_id: 'tr_fictional01', words: 'FICTIONAL risk hold, $0' }] });
  assert.equal(r.code, 0);
  assert.deepEqual(r.seen, ['poll', 'claim', 'prepare', 'claim', 'poll']);
  const row = r.log.dispatches[0];
  assert.equal(row.outcome, 'done');
  assert.equal(row.agents, 0, 'no session ran');
  assert.equal(row.health, 'idle');
  assert.equal(r.log.health, 'idle');
  assert.equal(finalPing(r), `${HC}/0?rid=${RID}`);
});

test('a closed desk gate, through the real local flow, is idle, never ok', async (t) => {
  const f = sandbox(t);
  let gateSaved = false;
  const calls = [];
  const call = (args) => {
    calls.push(args.slice(0, 2).join(' '));
    if (args[1] === 'queue') {
      const step = gateSaved ? 'pm_review' : 'gate_closed';
      return { steps: [{ project_id: 'a-fictional', name: 'a-fictional', step, why: 'FICTIONAL' }], pending: [], paused: false, claims: {} };
    }
    if (args[1] === 'claim') return { status: 'claimed_now', token: 'FICTIONAL-local-token' };
    if (args[1] === 'start') { gateSaved = true; return { status: 'saved', receipt_id: 'tr_fictional02', verified: true, message: 'FICTIONAL desk gate' }; }
    return {};
  };
  const ping = pinger();
  const code = await P.runAll({ desk: 'local', maxAgents: 1 }, { call, agent: () => { throw new Error('no session for a closed gate'); }, env: { CR_HEALTHCHECK_URL: HC }, pingFetch: ping.fn, newRid: () => RID, out: () => {}, ...f });
  assert.equal(code, 0);
  assert.ok(calls.includes('tickets start'), 'the desk gate receipt was saved through the real local step');
  const log = lastLog(f.logFile);
  assert.equal(log.dispatches[0].health, 'idle');
  assert.equal(log.health, 'idle');
  assert.equal(ping.urls[1], `${HC}/0?rid=${RID}`);
});

test('a save through the real online flow is ok with ping /0, also when the one-agent cap then ends the loop', async (t) => {
  // --max-agents=1 (the production default): after the save, the next pass
  // meets the cap, so the row's stop is 'cap'. The session ran and saved: ok.
  const r = await online(t, { poll: [steps('research'), steps('pm_review')], claim: [claimed('research')], prepare: [prepared], complete: [{ status: 'saved', report_id: 'rep_fictional01' }] });
  assert.equal(r.code, 0);
  assert.deepEqual(r.seen, ['poll', 'claim', 'prepare', 'complete', 'poll']);
  assert.equal(r.log.dispatches[0].stop, 'cap');
  assert.equal(r.log.dispatches[0].agents, 1);
  assert.equal(r.log.dispatches[0].health, 'ok');
  assert.equal(r.log.health, 'ok');
  assert.equal(r.log.health_label, 'ok');
  assert.equal(finalPing(r), `${HC}/0?rid=${RID}`);
});

test('paused and stopped are idle, labeled idle-paused and idle-stopped, ping /0', async (t) => {
  // Paused at the pre-poll: nothing is claimed.
  const pre = await online(t, { poll: [{ ...steps('research'), paused: true }] });
  assert.equal(pre.code, 0);
  assert.deepEqual(pre.seen, ['poll']);
  assert.equal(pre.log.health, 'idle');
  assert.equal(pre.log.health_label, 'idle-paused');
  assert.ok(pre.said.includes('Health: idle-paused (exit 0).'));
  assert.equal(finalPing(pre), `${HC}/0?rid=${RID}`);
  // Paused by the claim's own answer.
  const claim = await online(t, { poll: [steps('research'), steps('research')], claim: [{ status: 'paused', words: 'FICTIONAL automation is paused' }] });
  assert.equal(claim.log.dispatches[0].health, 'idle');
  assert.equal(claim.log.dispatches[0].health_label, 'idle-paused');
  assert.equal(claim.log.health_label, 'idle-paused');
  assert.equal(finalPing(claim), `${HC}/0?rid=${RID}`);
  // Stopped by Eric (the claim's answer).
  const stopped = await online(t, { poll: [steps('research'), steps('research')], claim: [{ status: 'stopped', words: 'FICTIONAL Eric stopped this project' }] });
  assert.equal(stopped.code, 0);
  assert.equal(stopped.log.dispatches[0].stop, 'stopped');
  assert.equal(stopped.log.dispatches[0].health, 'idle');
  assert.equal(stopped.log.dispatches[0].health_label, 'idle-stopped');
  assert.equal(stopped.log.health_label, 'idle-stopped');
  assert.equal(finalPing(stopped), `${HC}/0?rid=${RID}`);
});

test('a failed re-poll is attention, ping /fail, whether the row was a stop or a save; the exit code is unchanged', async (t) => {
  for (const [name, script] of [
    ['stopped', { poll: [steps('research'), 'fail'], claim: [{ status: 'stopped', words: 'FICTIONAL Eric stopped this project' }] }],
    ['paused', { poll: [steps('research'), 'fail'], claim: [{ status: 'paused', words: 'FICTIONAL automation is paused' }] }],
    ['closed gate', { poll: [steps('gate_closed'), 'fail'], claim: [claimed('gate_closed'), { status: 'nothing', step: 'pm_review' }], prepare: [{ status: 'gate_closed', receipt_id: 'tr_fictional03', words: 'FICTIONAL' }] }],
    ['saved', { poll: [steps('research'), 'fail'], claim: [claimed('research')], prepare: [prepared], complete: [{ status: 'saved', report_id: 'rep_fictional02' }] }],
  ]) {
    const r = await online(t, script);
    assert.equal(r.code, 0, `${name}: exit 0 as before`);
    const row = r.log.dispatches[0];
    assert.ok(row.repoll_error, `${name}: the failed re-poll is recorded`);
    assert.equal(row.health, 'attention', `${name}: never hidden by the row's own end`);
    assert.equal(r.log.health, 'attention', name);
    assert.equal(finalPing(r), `${HC}/fail?rid=${RID}`, name);
  }
  // A worse class stays worse: a refused prepare with a failed re-poll is failure.
  const refused = await online(t, { poll: [steps('research'), 'fail'], claim: [claimed('research')], prepare: [{ status: 'refused', words: 'FICTIONAL refused' }] });
  assert.equal(refused.log.dispatches[0].health, 'failure');
  assert.equal(finalPing(refused), `${HC}/1?rid=${RID}`);
});

test('a normal overlap (another run holds the local lock, well under 3 hours) is attention-overlap and pings /fail per §6.1 rev-3; nothing is dispatched and the holder\'s lock is kept', async (t) => {
  const f = sandbox(t);
  const holder = JSON.stringify({ pid: 424242, started_at: new Date(Date.now() - 20 * 60000).toISOString() });
  fs.writeFileSync(f.lockFile, holder);
  const desk = onlineDesk({ poll: [steps('research')] });
  const ping = pinger();
  const said = [];
  const code = await P.runAll({ desk: 'online', deskUrl: DESK, maxAgents: 1, pilotAll: true }, { fetchImpl: desk.fn, token: POLL, workerToken: WORKER, agent: () => { throw new Error('no session while another run holds the lock'); }, env: { CR_HEALTHCHECK_URL: HC }, pingFetch: ping.fn, newRid: () => RID, out: (s) => said.push(s), ...f });
  assert.equal(code, 0, 'exit 0 as before');
  assert.deepEqual(desk.seen, [], 'the overlapping run asks the desk nothing');
  assert.equal(fs.readFileSync(f.lockFile, 'utf8'), holder, 'the holder\'s lock is untouched');
  const log = lastLog(f.logFile);
  assert.equal(log.skipped, 'locked');
  assert.equal(log.health, 'attention');
  assert.equal(log.health_label, 'attention-overlap');
  assert.ok(said.includes('Health: attention-overlap (exit 0).'));
  assert.deepEqual(ping.urls, [`${HC}/start?rid=${RID}`, `${HC}/fail?rid=${RID}`], 'its own start and /fail, under its own rid');
});

test('the labels never change the class or the ping; an unknown stop is still failure', () => {
  assert.equal(P.rowLabel({ outcome: 'not_dispatched', stop: 'paused' }), 'idle-paused');
  assert.equal(P.rowLabel({ outcome: 'not_dispatched', stop: 'stopped' }), 'idle-stopped');
  assert.equal(P.rowLabel({ outcome: 'not_dispatched', stop: 'stopped', repoll_error: 'x' }), 'attention');
  assert.equal(P.rowLabel({ outcome: 'done' }), 'idle');
  assert.equal(P.rowHealth({ outcome: 'not_dispatched', stop: 'FICTIONAL_new_code' }), 'failure');
  assert.equal(P.runLabel({ dispatches: [], paused: true }), 'idle-paused');
  assert.equal(P.runLabel({ dispatches: [], skipped: 'locked' }), 'attention-overlap');
  assert.equal(P.runLabel({ dispatches: [{ outcome: 'not_dispatched', stop: 'stopped' }, { outcome: 'done', sessions: [{}] }] }), 'ok');
  assert.deepEqual(P.HEARTBEAT_FINAL, { ok: '0', idle: '0', attention: 'fail', failure: '1', reconcile: '3' });
  assert.deepEqual(P.HEALTH_ORDER, ['idle', 'ok', 'attention', 'reconcile', 'failure']);
});
