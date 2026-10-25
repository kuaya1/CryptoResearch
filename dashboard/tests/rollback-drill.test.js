'use strict';
// The rollback drill (dashboard/scripts/rollback-drill.js, backlog item 44):
// a temporary git repo, an injected reader for the previous release, and one
// real run of this checkout's own code as the "previous release". Fictional
// workspaces only; no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { drill, evaluate, assertDrillWorkspace, SCHEMA } = require('../scripts/rollback-drill');
const { buildDrillWorkspace } = require('./drill-fixture');

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
const g = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-drill-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  g(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'release 1\n');
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'release 1');
  g(dir, 'tag', 'prev');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'release 2\n');
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'release 2');
  return dir;
}

const okRead = (stamped) => ({ checks: [{ name: 'tickets.view p', ok: true }], notes: { p: { newer_receipts: stamped ? ['tr_x'] : [], view_note: stamped ? 'Made under a newer rule (x@99): shown as saved, not re-read.' : null, summary_note: stamped ? 'Made under a newer rule (x@99)' : null, index_note: stamped ? 'Made under a newer rule (x@99)' : null } } });

test('a passing drill: the reader sees a worktree at the previous release, a record in item 43\'s shape is written only with --record, and the worktree is removed', (t) => {
  const dir = repo(t);
  const seen = [];
  const read = (tree, wsRoot) => { seen.push({ tree, text: fs.readFileSync(path.join(tree, 'a.txt'), 'utf8'), ws: fs.existsSync(path.join(wsRoot, 'cryptoresearch.workspace.json')) || fs.existsSync(wsRoot) }); return okRead(seen.length === 2); };
  const before = g(dir, 'status', '--porcelain');
  const r = drill({ cwd: dir, from: 'prev', read });
  assert.equal(r.result, 'passed');
  assert.equal(r.schema_version, SCHEMA);
  assert.deepEqual(r.problems, []);
  assert.equal(r.from, g(dir, 'rev-parse', '--short', 'prev'));
  assert.equal(r.to, g(dir, 'rev-parse', '--short', 'HEAD'));
  assert.ok(r.checked.length);
  assert.equal(seen.length, 2, 'once as built, once stamped with a newer rule');
  assert.equal(seen[0].text, 'release 1\n', 'the previous release\'s code, not this checkout\'s');
  assert.ok(seen[0].ws);
  assert.ok(!fs.existsSync(seen[0].tree), 'the worktree is gone');
  assert.ok(!g(dir, 'worktree', 'list').includes('release'), 'and unregistered');
  assert.equal(g(dir, 'status', '--porcelain'), before, 'nothing written without --record');
  assert.equal(g(dir, 'rev-parse', 'HEAD'), g(dir, 'rev-parse', 'main'));

  const rec = drill({ cwd: dir, from: 'prev', read: (tree) => okRead(!!(read.n = (read.n || 0) + 1) && read.n % 2 === 0), record: 'audits/2026-11-02-drill' });
  const file = path.join(dir, 'audits/2026-11-02-drill/rollback-drill.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.schema_version, 'cr.rollback-drill.v1');
  assert.equal(saved.result, 'passed');
  assert.deepEqual(Object.keys(saved).filter((k) => ['from', 'to', 'checked'].includes(k)).sort(), ['checked', 'from', 'to']);
  assert.equal(rec.result, 'passed');
});

test('a failing drill: a check that throws, or a newer-rule record not recognized, fails and is named; the worktree is still removed', (t) => {
  const dir = repo(t);
  const threw = drill({ cwd: dir, from: 'prev', read: () => ({ checks: [{ name: 'tickets.view p', ok: false, error: 'Cannot read properties of undefined' }], notes: {} }), record: 'audits/x' });
  assert.equal(threw.result, 'failed');
  assert.match(threw.problems.join('\n'), /tickets\.view p threw: Cannot read/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'audits/x/rollback-drill.json'), 'utf8')).result, 'failed');
  assert.ok(!g(dir, 'worktree', 'list').includes('release'));
  // The previous release does not say "made under a newer rule".
  const silent = evaluate({ checks: [], notes: { p: { newer_receipts: ['tr_x'], view_note: null, summary_note: null, index_note: null } } });
  assert.equal(silent.passed, false);
  assert.equal(silent.problems.length, 3);
  assert.equal(evaluate({ checks: [], notes: { p: { newer_receipts: [] } } }, { requireNewer: true }).passed, false, 'the stamped record must read as newer');
  assert.equal(evaluate({ fatal: 'Refused' }).passed, false);
});

test('a workspace that is not a fictional test one is refused, and nothing is checked out', (t) => {
  const dir = repo(t);
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-drill-real-'));
  t.after(() => fs.rmSync(real, { recursive: true, force: true }));
  assert.throws(() => assertDrillWorkspace(real, 'real'), /not a fictional test workspace/);
  assert.throws(() => assertDrillWorkspace(path.join(__dirname, '..'), 'test'), /not a fictional test workspace/);
  assert.doesNotThrow(() => assertDrillWorkspace(real, 'test'));
  let read = 0;
  assert.throws(() => drill({ cwd: dir, from: 'prev', read: () => { read += 1; return okRead(false); }, build: () => ({ root: real, ws: { kind: 'real' }, stampNewer() {}, cleanup() {} }) }), /not a fictional test workspace/);
  assert.equal(read, 0);
  assert.ok(!g(dir, 'worktree', 'list').includes('release'));
  assert.throws(() => drill({ cwd: dir, from: 'no-such-ref', read: () => okRead(false) }));
});

test('end to end: this checkout\'s own code as the previous release reads the fictional workspace, including a record stamped with a newer rule', (t) => {
  const ROOT = path.join(__dirname, '..', '..');
  const r = drill({ cwd: ROOT, from: 'HEAD' });
  assert.deepEqual(r.problems, []);
  assert.equal(r.result, 'passed');
  for (const name of ['indexer.buildIndex', 'paper.book', 'brief-daily']) assert.ok(r.checked.includes(name), name);
  assert.ok(!g(ROOT, 'worktree', 'list').includes('cr-rollback-drill'));
  // The fixture itself builds under the test helpers.
  const w = buildDrillWorkspace();
  t.after(w.cleanup);
  assert.equal(w.ws.kind, 'test');
});
