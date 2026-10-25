'use strict';
// The merge train (backlog item 12): a temporary git repo with a bare origin;
// a clean train, a bundle-only conflict taken from main with one rebuild, and
// a code conflict that stops the train. No network, no npm, no real suite.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { train, waiting, tick, counts } = require('../scripts/merge-train');

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
const g = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const put = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-train-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  g(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const work = path.join(root, 'work');
  g(root, 'clone', '-q', origin, work);
  g(work, 'checkout', '-q', '-b', 'main');
  put(work, 'DESK_STATE.md', '## Autonomous Build Backlog\n- [ ] **1. One.** a\n- [ ] **2. Two.** b\n- [ ] **3. Three.** c\n');
  put(work, 'dashboard/public/app/bundle.js', 'bundle v0\n');
  put(work, 'dashboard/core/a.js', 'line a\n');
  put(work, 'dashboard/core/b.js', 'line b\n');
  g(work, 'add', '-A'); g(work, 'commit', '-qm', 'base'); g(work, 'push', '-q', '-u', 'origin', 'main');
  const branch = (name, item, files, from = 'main') => {
    g(work, 'checkout', '-q', '-B', name, from === 'main' ? 'origin/main' : from);
    for (const [f, c] of Object.entries(files)) put(work, f, c);
    g(work, 'add', '-A'); g(work, 'commit', '-qm', `backlog: item ${item}\n\nBacklog-Item: ${item}`);
    g(work, 'push', '-q', 'origin', name);
  };
  return { work, branch };
}
const stubs = () => { const calls = { build: 0, test: 0 }; return { calls, build: () => { calls.build += 1; }, test: () => { calls.test += 1; return { ok: true, tests: 5, pass: 5, fail: 0 }; } }; };

test('a clean train merges the waiting branches in item order, stacked ones after their base, and ticks the items', (t) => {
  const { work, branch } = fixture(t);
  branch('claude/backlog-batch-items-3-and-1', 3, { 'dashboard/core/b.js': 'line b3\n' });
  // Item 2 stands on the first branch: it comes after it although 2 < 3.
  branch('claude/backlog-two', 2, { 'dashboard/core/c.js': 'c\n' }, 'claude/backlog-batch-items-3-and-1');
  g(work, 'checkout', '-q', 'main');
  const list = waiting(work);
  assert.deepEqual(list.map((x) => x.items), [[3], [2, 3]], 'a stacked branch also carries its base\'s item');
  const s = stubs();
  const r = train(work, { date: '2026-10-25', build: s.build, test: s.test });
  assert.equal(r.branch, 'claude/train-2026-10-25');
  assert.deepEqual(r.merged.map((m) => m.items), [[3], [2, 3]]);
  assert.equal(r.stopped, null);
  assert.deepEqual(r.items_ticked, [3, 2]);
  assert.match(fs.readFileSync(path.join(work, 'DESK_STATE.md'), 'utf8'), /- \[x\] \*\*3\./);
  assert.match(fs.readFileSync(path.join(work, 'DESK_STATE.md'), 'utf8'), /- \[ \] \*\*1\./);
  assert.equal(s.calls.build, 0, 'no UI change, no rebuild');
  assert.equal(s.calls.test, 1);
  assert.equal(r.pushed, false, 'no push without --push');
  assert.equal(g(work, 'rev-parse', 'origin/main'), g(work, 'rev-parse', 'main'), 'main is untouched');
});

test('a conflict only in the bundle takes main\'s side and rebuilds once; --push sends only the train branch', (t) => {
  const { work, branch } = fixture(t);
  branch('claude/backlog-one', 1, { 'dashboard/public/app/bundle.js': 'bundle from one\n', 'dashboard/core/a.js': 'line a1\n' });
  branch('claude/backlog-two', 2, { 'dashboard/public/app/bundle.js': 'bundle from two\n', 'dashboard/core/b.js': 'line b2\n' });
  g(work, 'checkout', '-q', 'main');
  const s = stubs();
  const r = train(work, { date: '2026-10-25', build: s.build, test: s.test, push: true });
  assert.equal(r.stopped, null);
  assert.equal(r.resolved_bundle.length, 1);
  assert.equal(r.resolved_bundle[0].branch, 'claude/backlog-two');
  assert.equal(s.calls.build, 1, 'rebuilt once');
  assert.equal(r.rebuilt, true);
  assert.equal(fs.readFileSync(path.join(work, 'dashboard/core/b.js'), 'utf8'), 'line b2\n');
  assert.equal(r.pushed, true);
  assert.match(g(work, 'ls-remote', '--heads', 'origin', 'claude/train-2026-10-25'), /claude\/train-2026-10-25/);
  assert.equal(g(work, 'ls-remote', '--heads', 'origin', 'main').split('\t')[0], g(work, 'rev-parse', 'origin/main'));
});

test('a conflict in code stops the train, names the branch and files, and pushes nothing', (t) => {
  const { work, branch } = fixture(t);
  branch('claude/backlog-one', 1, { 'dashboard/core/a.js': 'line a1\n' });
  branch('claude/backlog-two', 2, { 'dashboard/core/a.js': 'line a2\n' });
  branch('claude/backlog-three', 3, { 'dashboard/core/b.js': 'line b3\n' });
  g(work, 'checkout', '-q', 'main');
  const s = stubs();
  const r = train(work, { date: '2026-10-25', build: s.build, test: s.test, push: true });
  assert.equal(r.stopped.branch, 'claude/backlog-two');
  assert.deepEqual(r.stopped.files, ['dashboard/core/a.js']);
  assert.deepEqual(r.merged.map((m) => m.items), [[1]], 'earlier merges are kept');
  assert.deepEqual(r.skipped.map((x) => x.branch), ['claude/backlog-two', 'claude/backlog-three']);
  assert.equal(r.pushed, false);
  assert.equal(g(work, 'ls-remote', '--heads', 'origin', 'claude/train-2026-10-25'), '');
  assert.equal(g(work, 'status', '--porcelain'), '', 'the merge was aborted');
});

test('ticking and count parsing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-tick-'));
  fs.writeFileSync(path.join(dir, 'DESK_STATE.md'), '- [ ] **4. X.**\n- [x] **5. Y.**\n- [ ] **6. Z.**\n');
  assert.deepEqual(tick(dir, [4, 5, 9]), [4]);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(counts('# tests 797\n# pass 797\n# fail 0\n'), { tests: 797, pass: 797, fail: 0 });
});
