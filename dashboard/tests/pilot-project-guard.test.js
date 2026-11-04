'use strict';
// The revision guard on the single-project path (audit 2026-11-04, R03). The
// registered runner goes through --pilot-all, which has always been guarded.
// `--project=<id> --desk=online --unattended` reached the worker's claim and a
// session with no guard at all: a checkout of any age, dirty or not, could act
// on the desk. These tests drive the real command line, so they read the same
// on the code before the fix. FICTIONAL commits and desk; children/
// pilot-cli-stubs.js stands in for git, claude and the desk; no request leaves
// the test and no real session runs.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PILOT = path.join(__dirname, '..', 'scripts', 'pilot.js');
const STUBS = path.join(__dirname, 'children', 'pilot-cli-stubs.js');
const REV = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const DESK = '--desk-url=https://desk.fictional.example';
const UNATTENDED = ['--project=fictional-project', '--desk=online', '--unattended', '--model=claude-fictional', DESK];
const HEALTHY = { status: 200, body: `ok\nrevision ${REV} (main)\n` };

// Anything that spends, claims or starts work. `git` and /healthz are the guard.
const EFFECTS = /worker\/(claim|prepare|complete|release)|^claude |^SESSION$/;

function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pilot-project-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const home = path.join(dir, 'home');
  const temp = path.join(dir, 'temp');
  const standIn = path.join(dir, 'stand-in');
  for (const d of [home, temp, standIn]) fs.mkdirSync(d);
  fs.copyFileSync(path.join(__dirname, 'claude-stand-in.js'), path.join(standIn, 'claude-stand-in.js'));
  fs.writeFileSync(path.join(standIn, 'config.json'), '{}');
  return { dir, home, temp, standIn };
}

// The real command line, in its own process with its own home and temp folder.
function pilot(f, args, { head = REV, porcelain = '', healthz = HEALTHY } = {}) {
  const record = path.join(f.dir, 'record.txt');
  fs.rmSync(record, { force: true });
  const stubs = path.join(f.dir, 'stubs.json');
  fs.writeFileSync(stubs, JSON.stringify({ head, porcelain, healthz, record, standIn: path.join(f.standIn, 'claude-stand-in.js') }));
  const keep = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'ProgramData', 'ProgramFiles', 'ProgramW6432', 'ALLUSERSPROFILE'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  const env = { ...keep, HOME: f.home, USERPROFILE: f.home, TEMP: f.temp, TMP: f.temp, TMPDIR: f.temp, CLAUDE_CONFIG_DIR: path.join(f.home, '.claude'), CR_PILOT_WORKER_TOKEN: 'FICTIONAL-worker-token-0001', CR_PILOT_POLL_TOKEN: 'FICTIONAL-poll-token-00001', CR_TEST_PILOT_STUBS: stubs };
  const r = spawnSync(process.execPath, ['-r', STUBS, PILOT, ...args], { env, encoding: 'utf8', timeout: 90000 });
  const seen = fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { code: r.status, out: r.stdout, err: r.stderr, seen, effects: seen.filter((l) => EFFECTS.test(l)), lock: fs.existsSync(path.join(f.temp, 'cr-pilot', 'pilot-all.lock')) };
}

function assertRefused(r, words) {
  assert.equal(r.code, 1, `exit 1\n${r.err}`);
  assert.match(r.err, /Revision guard:/);
  assert.match(r.err, words);
  assert.match(r.err, /Nothing was claimed or dispatched/);
  assert.deepEqual(r.effects, [], 'no claim, no launch check, no session');
  assert.equal(r.lock, false, 'no lock made or left');
}

test('(1) the desk runs a different commit: refused, no claim and no session', (t) => {
  const r = pilot(folder(t), UNATTENDED, { head: OTHER });
  assertRefused(r, /runner is at bbbbbbb but the desk runs aaaaaaa/);
});

test('(2) a dirty checkout: refused, even with the right commit', (t) => {
  const r = pilot(folder(t), UNATTENDED, { porcelain: ' M dashboard/core/jobs.js\n' });
  assertRefused(r, /uncommitted changes/);
});

test('(3) /healthz does not answer: refused', (t) => {
  const r = pilot(folder(t), UNATTENDED, { healthz: { throws: true } });
  assertRefused(r, /healthz did not answer/);
});

test('(4) /healthz answers 503: refused', (t) => {
  const r = pilot(folder(t), UNATTENDED, { healthz: { status: 503, body: 'unavailable' } });
  assertRefused(r, /healthz answered 503/);
});

test('(5) a /healthz with no revision, or a checkout whose commit will not read: refused', (t) => {
  assertRefused(pilot(folder(t), UNATTENDED, { healthz: { status: 200, body: 'ok\n' } }), /names no 40-character revision/);
  assertRefused(pilot(folder(t), UNATTENDED, { head: null }), /commit could not be read/);
});

test('(6) a desk address the guard cannot use is a refusal, never a pass', (t) => {
  const r = pilot(folder(t), ['--project=fictional-project', '--desk=online', '--unattended', '--model=claude-fictional', '--desk-url=http://desk.fictional.example']);
  assertRefused(r, /https origin/);
});

test('(7) the same commit and a clean checkout: the guard comes first, then the launch check, the claim and the session', (t) => {
  const r = pilot(folder(t), UNATTENDED);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Revision: aaaaaaa \(git, clean\) matches the desk/);
  const at = (what) => r.seen.indexOf(what);
  for (const step of ['git rev-parse', 'git status', 'GET /healthz', 'claude probe', 'POST /api/pilot/worker/claim', 'SESSION', 'POST /api/pilot/worker/complete']) assert.ok(at(step) >= 0, `${step} ran:\n${r.seen.join('\n')}`);
  assert.ok(at('GET /healthz') < at('claude probe'), 'the guard is before the launch check');
  assert.ok(at('claude probe') < at('POST /api/pilot/worker/claim'), 'the launch check is before the claim');
  assert.ok(at('POST /api/pilot/worker/claim') < at('SESSION'), 'the claim is before the session');
  assert.equal(r.lock, false, 'this path has never taken the --pilot-all lock; the desk\'s claim is what keeps two runs apart');
});

test('(8) a retry after a refusal: refused again while it is wrong, and it goes through once it is right', (t) => {
  const f = folder(t);
  assertRefused(pilot(f, UNATTENDED, { head: OTHER }), /runner is at/);
  assertRefused(pilot(f, UNATTENDED, { head: OTHER }), /runner is at/);
  const r = pilot(f, UNATTENDED);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.seen.includes('POST /api/pilot/worker/claim'));
});

test('unchanged: an attended online run is not guarded, and never asks /healthz', (t) => {
  const r = pilot(folder(t), ['--project=fictional-project', '--desk=online', '--model=claude-fictional', DESK], { head: OTHER, porcelain: ' M x\n' });
  assert.equal(r.code, 0, r.err);
  assert.ok(!r.seen.includes('GET /healthz'), r.seen.join('\n'));
  assert.ok(r.seen.includes('POST /api/pilot/worker/claim'));
});

test('unchanged: an unattended online dry run has no effect to guard, so it asks nothing and needs no network', (t) => {
  const r = pilot(folder(t), [...UNATTENDED, '--dry-run'], { head: OTHER });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Would claim fictional-project's next step/);
  assert.deepEqual(r.seen, []);
});

test('unchanged: --unattended with no model and a desk that is not online are refused for their own reasons, before any request', (t) => {
  const f = folder(t);
  const noModel = pilot(f, ['--project=fictional-project', '--desk=online', '--unattended', DESK]);
  assert.equal(noModel.code, 1);
  assert.match(noModel.err, /names its model/);
  assert.deepEqual(noModel.seen, []);
  const notOnline = pilot(f, ['--project=fictional-project', '--desk=elsewhere', '--unattended', '--model=claude-fictional', DESK]);
  assert.equal(notOnline.code, 1);
  assert.match(notOnline.err, /--desk is local or online/);
  assert.deepEqual(notOnline.seen, []);
});

test('unchanged: the registered --pilot-all path refuses as before, in its own words and its own log', (t) => {
  const f = folder(t);
  const r = pilot(f, ['--pilot-all', '--desk=online', '--unattended', '--max-agents=1', '--model=claude-fictional', DESK], { head: OTHER });
  assert.equal(r.code, 1);
  assert.match(r.out, /pilot-all: Revision guard: This runner is at bbbbbbb but the desk runs aaaaaaa/);
  assert.deepEqual(r.effects, []);
  assert.equal(r.lock, false);
  const log = JSON.parse(fs.readFileSync(path.join(f.home, '.cryptoresearch', 'pilot-all.jsonl'), 'utf8').trim());
  assert.equal(log.exit, 1);
  assert.equal(log.health, 'failure');
});
