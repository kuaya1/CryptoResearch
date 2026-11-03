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

// (5) RENDER_GIT_COMMIT and git (Eric's correction 1, 2026-11-03): with a
// .git, git is always asked and RENDER_GIT_COMMIT never excuses a dirty tree
// or a different HEAD; only with no .git is it taken alone, clean unknown.
// A fake git: answers in order, every call recorded.
function fakeGit(answers) {
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, ...args]); if (!answers.length) throw new Error('FICTIONAL: unexpected git call'); return answers.shift(); };
  return { calls, run };
}
const headIs = (rev) => ({ status: 0, stdout: `${rev}\n` });
const porcelain = (text) => ({ status: 0, stdout: text });
const revisionOf = (env, git, hasGit) => ({ runnerRevisionImpl: () => P.runnerRevision({ env, root: 'C:\\FICTIONAL\\runner', run: git.run, hasGit: () => hasGit }) });

test('(5a) .git present, RENDER_GIT_COMMIT matching /healthz, but the tree is dirty: refused, nothing claimed, no lock', async (t) => {
  const git = fakeGit([headIs(DESK_REV), porcelain(' M dashboard/scripts/pilot.js\n')]);
  const r = await run(t, { deps: revisionOf({ RENDER_GIT_COMMIT: DESK_REV }, git, true) });
  assertRefused(r, /This checkout has uncommitted changes \(git status --porcelain is not empty\) at aaaaaaa\./);
  assert.equal(git.calls.length, 2, 'git was asked although RENDER_GIT_COMMIT was set');
  assert.deepEqual(r.log.revision, { runner: DESK_REV, desk: DESK_REV, source: 'render|git', clean: false });
});

test('(5b) .git present and RENDER_GIT_COMMIT not its HEAD: refused, even when RENDER_GIT_COMMIT matches /healthz', async (t) => {
  const git = fakeGit([headIs(OTHER_REV), porcelain('')]);
  const r = await run(t, { deps: revisionOf({ RENDER_GIT_COMMIT: DESK_REV }, git, true) });
  assertRefused(r, /RENDER_GIT_COMMIT \(aaaaaaa\) is not this checkout's HEAD \(bbbbbbb\)\./);
  assert.equal(r.log.revision.runner, OTHER_REV, 'the commit recorded is HEAD, never the variable');
  // Set but not a commit, beside a .git: refused as well.
  const bad = await run(t, { deps: revisionOf({ RENDER_GIT_COMMIT: 'main' }, fakeGit([headIs(DESK_REV), porcelain('')]), true) });
  assertRefused(bad, /RENDER_GIT_COMMIT is set but is not a 40-character commit ID\./);
  // Agreeing and clean: it proceeds, source render|git.
  const agree = await run(t, { deps: revisionOf({ RENDER_GIT_COMMIT: DESK_REV.toUpperCase() }, fakeGit([headIs(DESK_REV), porcelain('')]), true) });
  assert.equal(agree.code, 0);
  assert.deepEqual(agree.log.revision, { runner: DESK_REV, desk: DESK_REV, source: 'render|git', clean: true });
  assert.deepEqual(agree.seen, ['GET /healthz', 'POST /api/pilot/worker/poll']);
});

test('(5c) no .git and a valid RENDER_GIT_COMMIT matching /healthz: proceeds to the poll, render_env_no_git, clean null, git never called', async (t) => {
  const git = fakeGit([]);
  const r = await run(t, { deps: revisionOf({ RENDER_GIT_COMMIT: ` ${DESK_REV.toUpperCase()} ` }, git, false) });
  assert.equal(r.code, 0);
  assert.deepEqual(git.calls, [], 'git was never called');
  assert.deepEqual(r.log.revision, { runner: DESK_REV, desk: DESK_REV, source: 'render_env_no_git', clean: null });
  assert.deepEqual(r.seen, ['GET /healthz', 'POST /api/pilot/worker/poll']);
  assert.ok(r.said.includes('Revision: aaaaaaa (render_env_no_git, no .git: cleanliness not checked) matches the desk.'));
  // Still the full 40 characters against /healthz.
  const other = await run(t, { deps: revisionOf({ RENDER_GIT_COMMIT: OTHER_REV }, fakeGit([]), false) });
  assertRefused(other, /This runner is at bbbbbbb but the desk runs aaaaaaa\./);
});

test('(5d) no .git and no valid RENDER_GIT_COMMIT: refused; clean null is accepted from no other source', async (t) => {
  const none = await run(t, { deps: revisionOf({}, fakeGit([]), false) });
  assertRefused(none, /no \.git and RENDER_GIT_COMMIT is not set; its commit is unknown\./);
  const bad = await run(t, { deps: revisionOf({ RENDER_GIT_COMMIT: 'abc1234' }, fakeGit([]), false) });
  assertRefused(bad, /no \.git, and RENDER_GIT_COMMIT is not a 40-character commit ID\./);
  // clean null from git (status failed) or a stub with another source: refused.
  for (const source of ['git', 'render|git', 'render']) {
    const r = await run(t, { runner: { commit: DESK_REV, source, clean: null } });
    assertRefused(r, /Whether this checkout is clean is unknown\./);
  }
  // render_env_no_git claiming clean true is not what it reads: refused.
  const odd = await run(t, { runner: { commit: DESK_REV, source: 'render_env_no_git', clean: true } });
  assertRefused(odd, /Whether this checkout is clean is unknown\./);
});

test('runnerRevision with a .git: git rev-parse HEAD and git status --porcelain in the repository root; hasGitAt reads a worktree .git file', () => {
  const ok = fakeGit([headIs(DESK_REV), porcelain('')]);
  assert.deepEqual(P.runnerRevision({ env: {}, root: 'C:\\FICTIONAL\\runner', run: ok.run, hasGit: () => true }), { commit: DESK_REV, source: 'git', clean: true });
  assert.deepEqual(ok.calls, [['git', '-C', 'C:\\FICTIONAL\\runner', 'rev-parse', 'HEAD'], ['git', '-C', 'C:\\FICTIONAL\\runner', 'status', '--porcelain']]);
  const dirty = P.runnerRevision({ env: {}, run: fakeGit([headIs(DESK_REV), porcelain(' M dashboard/scripts/pilot.js\n')]).run, hasGit: () => true });
  assert.equal(dirty.clean, false);
  const statusFailed = P.runnerRevision({ env: {}, run: fakeGit([headIs(DESK_REV), { status: 128, stdout: '' }]).run, hasGit: () => true });
  assert.equal(statusFailed.clean, null);
  assert.match(statusFailed.words, /git status failed/);
  const missing = P.runnerRevision({ env: {}, run: fakeGit([{ error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }), status: null }]).run, hasGit: () => true });
  assert.equal(missing.commit, null);
  assert.match(missing.words, /ENOENT/);
  const notRepo = P.runnerRevision({ env: {}, run: fakeGit([{ status: 128, stdout: '' }]).run, hasGit: () => true });
  assert.match(notRepo.words, /git exited 128/);
  // hasGitAt: a .git directory or a worktree's .git file; nothing else.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pilot-hasgit-'));
  try {
    assert.equal(P.hasGitAt(d), false);
    fs.writeFileSync(path.join(d, '.git'), 'gitdir: C:/FICTIONAL/.git/worktrees/runner\n');
    assert.equal(P.hasGitAt(d), true, 'a worktree file');
    fs.rmSync(path.join(d, '.git'));
    fs.mkdirSync(path.join(d, '.git'));
    assert.equal(P.hasGitAt(d), true, 'a directory');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
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
