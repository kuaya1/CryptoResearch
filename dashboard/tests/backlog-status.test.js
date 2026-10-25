'use strict';
// Backlog status (backlog item 42): a temporary git repo with a bare origin.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { status, words, parseBacklog } = require('../scripts/backlog-status');

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
const g = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const put = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };

function fixture(t, count = 14) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-bstatus-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  g(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const work = path.join(root, 'work');
  g(root, 'clone', '-q', origin, work);
  g(work, 'config', 'core.autocrlf', 'false');
  g(work, 'checkout', '-q', '-b', 'main');
  let state = '## Status\n- [ ] **99. Outside.** not in the backlog\n\n## Autonomous Build Backlog\n- [x] **1. Done.** a\n- [ ] *(Eric)* **2. Eric.** b\n';
  for (let n = 3; n <= count; n++) state += `- [ ] **${n}. Item ${n}.** x\n`;
  state += '\n## Later\n- [ ] **100. After.** y\n';
  put(work, STATE, state);
  put(work, 'a.txt', 'a\n');
  g(work, 'add', '-A'); g(work, 'commit', '-qm', 'base'); g(work, 'push', '-q', '-u', 'origin', 'main');
  const branch = (name, items, from = 'main') => {
    g(work, 'checkout', '-q', '-B', name, from === 'main' ? 'origin/main' : from);
    put(work, `f-${name.replace(/\W/g, '_')}.txt`, `${name}\n`);
    g(work, 'add', '-A');
    g(work, 'commit', '-qm', `backlog: ${name}\n\n${items.map((n) => `Backlog-Item: ${n}`).join('\n')}`);
    g(work, 'push', '-q', 'origin', name);
    g(work, 'checkout', '-q', 'main');
  };
  g(work, 'fetch', '-q', 'origin');
  return { work, branch, fetch: () => g(work, 'fetch', '-q', 'origin', '--prune') };
}
const STATE = 'DESK_STATE.md';
const SURGE = new Date('2026-10-26T12:00:00Z');
const AFTER = new Date('2026-10-28T03:00:00Z');

test('the backlog section only: checked, Eric and numbered lines', () => {
  const items = parseBacklog('## Autonomous Build Backlog\n- [x] **1. A.** t\n- [ ] *(Eric)* **2. B.** t\n- [ ] **3. C.** t\n## Other\n- [ ] **4. D.** t\n');
  assert.deepEqual(items.map((i) => [i.n, i.checked, i.eric]), [[1, true, false], [2, false, true], [3, false, false]]);
});

test('nothing waiting: surge batch of three, Eric and ticked items skipped, base is main', (t) => {
  const { work } = fixture(t);
  const s = status(work, { now: SURGE });
  assert.equal(s.cap, 9); assert.equal(s.batch, 3); assert.equal(s.surge, true);
  assert.equal(s.waiting_count, 0);
  assert.equal(s.headroom, 3);
  assert.deepEqual(s.next.map((x) => x.item), [3, 4, 5]);
  assert.equal(s.base, 'origin/main');
});

test('the cap switches at 2026-10-28T03:00Z', (t) => {
  const { work } = fixture(t);
  const before = status(work, { now: new Date('2026-10-28T02:59:59Z') });
  const after = status(work, { now: AFTER });
  assert.deepEqual([before.cap, before.batch], [9, 3]);
  assert.deepEqual([after.cap, after.batch, after.surge], [4, 2, false]);
  assert.deepEqual(after.next.map((x) => x.item), [3, 4]);
});

test('waiting items count once, are taken, and the newest branch is the base', (t) => {
  const { work, branch, fetch } = fixture(t);
  branch('claude/backlog-batch-items-3-4-5', [3, 4, 5]);
  branch('claude/backlog-batch-items-6-and-7', [6, 7], 'claude/backlog-batch-items-3-4-5');
  fetch();
  const s = status(work, { now: SURGE });
  assert.deepEqual(s.waiting.map((w) => w.item), [3, 4, 5, 6, 7]);
  assert.deepEqual(s.waiting.find((w) => w.item === 3).branches.sort(), ['claude/backlog-batch-items-3-4-5', 'claude/backlog-batch-items-6-and-7']);
  assert.equal(s.waiting_count, 5);
  assert.deepEqual(s.next.map((x) => x.item), [8, 9, 10]);
  assert.equal(s.base, 'origin/claude/backlog-batch-items-6-and-7');
  assert.match(words(s), /Base: origin\/claude\/backlog-batch-items-6-and-7/);
});

test('8 waiting under a cap of 9 starts one; 9 waiting is at the cap', (t) => {
  const { work, branch, fetch } = fixture(t);
  branch('claude/backlog-a', [3, 4, 5, 6]);
  branch('claude/backlog-b', [7, 8, 9, 10], 'claude/backlog-a');
  fetch();
  let s = status(work, { now: SURGE });
  assert.equal(s.waiting_count, 8);
  assert.equal(s.headroom, 1);
  assert.deepEqual(s.next.map((x) => x.item), [11]);
  branch('claude/backlog-c', [11], 'claude/backlog-b');
  fetch();
  s = status(work, { now: SURGE });
  assert.equal(s.at_cap, true);
  assert.equal(s.headroom, 0);
  assert.deepEqual(s.next, []);
  assert.match(words(s), /WIP cap: 9 items waiting for merge/);
});

test('a merged branch is not waiting, and an item on main by trailer is taken though unticked', (t) => {
  const { work, branch, fetch } = fixture(t);
  branch('claude/backlog-merged', [3]);
  g(work, 'merge', '-q', '--no-ff', '-m', 'merge', 'claude/backlog-merged');
  g(work, 'push', '-q', 'origin', 'main');
  fetch();
  const s = status(work, { now: SURGE });
  assert.equal(s.waiting_count, 0);
  assert.deepEqual(s.next.map((x) => x.item), [4, 5, 6]);
  assert.equal(s.base, 'origin/main');
});

test('nothing buildable says so', (t) => {
  const { work } = fixture(t, 2);
  const s = status(work, { now: SURGE });
  assert.deepEqual(s.next, []);
  assert.match(words(s), /Backlog empty or all items waiting for merge/);
});
