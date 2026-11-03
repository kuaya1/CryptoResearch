'use strict';
// The runner's revision guard (audit E1, blueprint 2026-11-03 §4 PR 1): an
// unattended online run, dry runs included, compares the runner's commit with
// the one the desk's /healthz names, and refuses (exit 1, health failure,
// nothing polled, locked, claimed or dispatched) unless the runner's commit
// is known, its checkout is clean, the desk's commit is known and the two are
// the same 40 characters. Before it, a runner ran whatever checkout it sat
// in. Fake fetch and fake git only: no network, no real repository read.
// FICTIONAL commits and desk.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../scripts/pilot');

const DESK = 'https://desk.fictional.example';
const DESK_REV = 'a'.repeat(40);
const OTHER_REV = 'b'.repeat(40);
const WORKER = 'FICTIONAL-worker-token';
const base = { desk: 'online', deskUrl: DESK, maxAgents: 1, pilotAll: true, unattended: true, model: 'claude-fictional' };

function files(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pilot-revguard-test-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return { lockFile: path.join(d, 'pilot-all.lock'), logFile: path.join(d, 'pilot-all.jsonl') };
}
const lastLog = (f) => JSON.parse(fs.readFileSync(f, 'utf8').trim().split('\n').pop());

// A fictional desk: /healthz answers as given; the worker poll answers paused
// with nothing to do, so a run the guard lets through ends idle at the poll.
function desk({ healthz = { status: 200, body: `ok\nrevision ${DESK_REV}\n` } } = {}) {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    seen.push(`${init.method || 'GET'} ${u.pathname}`);
    if (u.pathname === '/healthz') {
      if (healthz.throws) throw healthz.throws;
      return { status: healthz.status, ok: healthz.status >= 200 && healthz.status < 300, text: async () => healthz.body };
    }
    if (u.pathname === '/api/pilot/worker/poll') {
      return { status: 200, ok: true, json: async () => ({ format: 'cr-pilot-worker@1', poll: { format: 'cr-pilot-poll@1', paused: true, steps: [] }, sighting: null }) };
    }
    return { status: 404, ok: false, json: async () => ({ error: 'FICTIONAL: not on this desk' }) };
  };
  return { seen, fetchImpl };
}

async function run(t, { runner, d = desk(), o = {}, deps = {} } = {}) {
  const f = files(t);
  const said = [];
  let sessions = 0;
  const agent = () => { sessions += 1; throw new Error('FICTIONAL: no session in this test'); };
  const runOnlineImpl = async () => { sessions += 1; throw new Error('FICTIONAL: no dispatch in this test'); };
  const code = await P.runAll({ ...base, ...o }, {
    fetchImpl: d.fetchImpl, workerToken: WORKER, env: {}, agent, runOnlineImpl, out: (s) => said.push(s),
    runnerRevisionImpl: runner ? () => runner : undefined, newInvocationId: () => 'FICTIONAL-inv-0001', ...deps, ...f,
  });
  return { code, said, log: lastLog(f.logFile), seen: d.seen, sessions, lockLeft: fs.existsSync(f.lockFile) };
}

function assertRefused(r, why) {
  assert.equal(r.code, 1, 'exit 1');
  assert.equal(r.log.health, 'failure', 'health failure');
  assert.match(r.log.error, /^Revision guard: /);
  assert.match(r.log.error, why);
  assert.match(r.log.error, /Nothing was polled, claimed or dispatched\.$/);
  assert.ok(!r.seen.some((s) => s.startsWith('POST /api/pilot/')), `no poll or claim: ${r.seen.join(', ')}`);
  assert.equal(r.sessions, 0, 'no session or dispatch');
  assert.equal(r.lockLeft, false, 'no lock file');
  assert.deepEqual(r.log.dispatches, []);
  assert.ok(r.said.some((s) => s.startsWith('pilot-all: Revision guard: ')), 'the refusal is printed');
}

test('(1) a desk that runs a different commit: refused before the poll, the lock or any claim', async (t) => {
  const r = await run(t, { runner: { commit: OTHER_REV, source: 'git', clean: true } });
  assertRefused(r, /This runner is at bbbbbbb but the desk runs aaaaaaa\./);
  assert.deepEqual(r.seen, ['GET /healthz']);
  assert.deepEqual(r.log.revision, { runner: OTHER_REV, desk: DESK_REV, source: 'git', clean: true });
  // A prefix is not a match: all 40 characters.
  const near = await run(t, { runner: { commit: `${'a'.repeat(39)}b`, source: 'git', clean: true } });
  assertRefused(near, /This runner is at aaaaaaa but the desk runs aaaaaaa\./);
});

test('(1b) a dry run is guarded too, so B0 rehearses the refusal with nothing claimed', async (t) => {
  const r = await run(t, { runner: { commit: OTHER_REV, source: 'git', clean: true }, o: { dryRun: true } });
  assertRefused(r, /desk runs aaaaaaa/);
});

test('(2) a dirty checkout, or one whose state or commit is unknown: refused the same way', async (t) => {
  const r = await run(t, { runner: { commit: DESK_REV, source: 'git', clean: false } });
  assertRefused(r, /This checkout has uncommitted changes \(git status --porcelain is not empty\) at aaaaaaa\./);
  assert.deepEqual(r.log.revision, { runner: DESK_REV, desk: DESK_REV, source: 'git', clean: false });
  const unknownClean = await run(t, { runner: { commit: DESK_REV, source: 'git', clean: null, words: 'Whether this checkout has uncommitted changes could not be read (git status failed).' } });
  assertRefused(unknownClean, /could not be read \(git status failed\)/);
  const noCommit = await run(t, { runner: { commit: null, source: 'git', clean: null, words: 'This checkout\'s commit could not be read (ENOENT).' } });
  assertRefused(noCommit, /commit could not be read \(ENOENT\)/);
});

test('(3) a /healthz that answers 503, names no revision, or does not answer: the desk revision is unknown, refused', async (t) => {
  const clean = { commit: DESK_REV, source: 'git', clean: true };
  const cases = [
    [{ status: 503, body: 'FICTIONAL: starting' }, /The desk's \/healthz answered 503\./],
    [{ status: 200, body: 'ok\n' }, /names no 40-character revision/],
    [{ status: 200, body: 'ok\nrevision unknown\nstarted 2026-11-03T00:00:00.000Z\n' }, /names no 40-character revision/],
    [{ status: 200, body: 'setup required' }, /names no 40-character revision/],
    [{ status: 200, body: `ok\nrevision ${DESK_REV.slice(0, 7)}\n` }, /names no 40-character revision/],
    [{ status: 200, body: `ok\nthe revision ${DESK_REV}\n` }, /names no 40-character revision/],
    [{ throws: new TypeError('fetch failed') }, /did not answer \(unreachable\)/],
    [{ throws: Object.assign(new Error('aborted'), { name: 'TimeoutError' }) }, /did not answer \(timeout\)/],
  ];
  for (const [healthz, why] of cases) {
    const r = await run(t, { runner: clean, d: desk({ healthz }) });
    assertRefused(r, why);
    assert.equal(r.log.revision.desk, null);
  }
});

test('(4) the same commit and a clean checkout: the run proceeds to the production poll', async (t) => {
  const r = await run(t, { runner: { commit: DESK_REV, source: 'git', clean: true } });
  assert.equal(r.code, 0);
  assert.deepEqual(r.seen, ['GET /healthz', 'POST /api/pilot/worker/poll']);
  assert.deepEqual(r.log.revision, { runner: DESK_REV, desk: DESK_REV, source: 'git', clean: true });
  assert.equal(r.log.error, null);
  assert.equal(r.log.health, 'idle');
  assert.ok(r.said.includes('Revision: aaaaaaa (git, clean) matches the desk.'));
  assert.equal(r.lockLeft, false, 'the lock is released');
});

test('(5) RENDER_GIT_COMMIT set and matching: it proceeds without calling git', async (t) => {
  const calls = [];
  const spy = (...a) => { calls.push(a); throw new Error('FICTIONAL: git must not run on Render'); };
  const env = { RENDER_GIT_COMMIT: ` ${DESK_REV.toUpperCase()} ` };
  const r = await run(t, { deps: { runnerRevisionImpl: () => P.runnerRevision({ env, run: spy }) } });
  assert.equal(r.code, 0);
  assert.deepEqual(calls, [], 'git was never called');
  assert.deepEqual(r.log.revision, { runner: DESK_REV, desk: DESK_REV, source: 'render', clean: true });
  assert.deepEqual(r.seen, ['GET /healthz', 'POST /api/pilot/worker/poll']);
  // A RENDER_GIT_COMMIT that is not a commit refuses; git still never runs.
  const bad = await run(t, { deps: { runnerRevisionImpl: () => P.runnerRevision({ env: { RENDER_GIT_COMMIT: 'main' }, run: spy }) } });
  assertRefused(bad, /RENDER_GIT_COMMIT is set but is not a 40-character commit ID\./);
  assert.deepEqual(calls, []);
});

test('runnerRevision off Render: git rev-parse HEAD and git status --porcelain in the repository root', () => {
  const calls = [];
  const fakeGit = (answers) => (cmd, args) => { calls.push([cmd, ...args]); return answers.shift(); };
  const ok = P.runnerRevision({ env: {}, root: 'C:\\FICTIONAL\\runner', run: fakeGit([{ status: 0, stdout: `${DESK_REV}\n` }, { status: 0, stdout: '' }]) });
  assert.deepEqual(ok, { commit: DESK_REV, source: 'git', clean: true });
  assert.deepEqual(calls, [['git', '-C', 'C:\\FICTIONAL\\runner', 'rev-parse', 'HEAD'], ['git', '-C', 'C:\\FICTIONAL\\runner', 'status', '--porcelain']]);
  const dirty = P.runnerRevision({ env: {}, run: fakeGit([{ status: 0, stdout: `${DESK_REV}\n` }, { status: 0, stdout: ' M dashboard/scripts/pilot.js\n' }]) });
  assert.equal(dirty.clean, false);
  const missing = P.runnerRevision({ env: {}, run: fakeGit([{ error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }), status: null }]) });
  assert.equal(missing.commit, null);
  assert.match(missing.words, /ENOENT/);
  const notRepo = P.runnerRevision({ env: {}, run: fakeGit([{ status: 128, stdout: '' }]) });
  assert.match(notRepo.words, /git exited 128/);
});

test('deskRevision reads only GET /healthz, bounded by a 10 s timeout', async () => {
  assert.equal(P.HEALTHZ_TIMEOUT_MS, 10000);
  const seen = [];
  // The desk's own answer (frontdoor.js): the branch may follow the commit.
  const r = await P.deskRevision(async (url, init) => { seen.push({ url, init }); return { status: 200, text: async () => `ok\nrevision ${DESK_REV} (main)\nstarted 2026-11-03T00:00:00.000Z\n` }; }, DESK);
  assert.deepEqual(r, { commit: DESK_REV });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `${DESK}/healthz`);
  assert.equal(seen[0].init.method, 'GET');
  assert.ok(seen[0].init.signal, 'bounded');
  assert.ok(!('headers' in seen[0].init), 'no token is sent to /healthz');
});

test('unchanged: a local desk with --unattended is never guarded, and an attended online run is not either', async (t) => {
  let asked = 0;
  const f = files(t);
  const call = (args) => (args[1] === 'queue' ? { steps: [], pending: [], paused: true, claims: {} } : {});
  const code = await P.runAll({ desk: 'local', maxAgents: 1, unattended: true, model: 'claude-fictional' }, { call, agent: () => '', env: {}, out: () => {}, runnerRevisionImpl: () => { asked += 1; return {}; }, deskRevisionImpl: async () => { asked += 1; return {}; }, ...f });
  assert.equal(code, 0);
  assert.equal(asked, 0);
  assert.equal(lastLog(f.logFile).revision, undefined);
  // Attended online: the read-only queue GET, never /healthz.
  const d = desk();
  const g = files(t);
  await P.runAll({ desk: 'online', deskUrl: DESK, maxAgents: 1, pilotAll: true }, { fetchImpl: d.fetchImpl, token: 'FICTIONAL-poll-token', env: {}, agent: () => '', out: () => {}, runnerRevisionImpl: () => { asked += 1; return {}; }, deskRevisionImpl: async () => { asked += 1; return {}; }, ...g });
  assert.equal(asked, 0);
  assert.deepEqual(d.seen, ['GET /api/pilot/queue']);
  assert.equal(lastLog(g.logFile).revision, undefined);
});
