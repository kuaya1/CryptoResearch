'use strict';
// Eric's own review of a pull request head (hardening, 2026-10-27;
// agent-owner-review.js): only records GitHub authenticates count, each names
// one exact head, and a review covers a later head only across GitHub's
// "Update branch". A local repository, FICTIONAL commits; no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const OR = require('../scripts/agent-owner-review');

const ERIC = { name: 'Eric FICTIONAL', email: 'eric@example.invalid' };
function git(cwd, args) {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: ERIC.name, GIT_AUTHOR_EMAIL: ERIC.email, GIT_COMMITTER_NAME: ERIC.name, GIT_COMMITTER_EMAIL: ERIC.email } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return String(r.stdout).trim();
}
const LINES = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-owner-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '-q', '-b', 'main']);
  const write = (lines) => fs.writeFileSync(path.join(dir, 'f.txt'), `${lines.join('\n')}\n`);
  const commit = (msg) => { git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', msg]); return git(dir, ['rev-parse', 'HEAD']); };
  write(LINES);
  const base = commit('main');
  git(dir, ['checkout', '-q', '-b', 'pr']);
  write(LINES.map((l, i) => (i === 9 ? 'line ten, changed' : l)));
  const head = commit('the change');
  // main changes line `n` (1-based); the pull request merges it.
  const mainChanges = (n, text) => {
    git(dir, ['checkout', '-q', 'main']);
    const cur = fs.readFileSync(path.join(dir, 'f.txt'), 'utf8').trimEnd().split('\n');
    cur[n - 1] = text;
    write(cur);
    const m = commit(`main: line ${n}`);
    git(dir, ['checkout', '-q', 'pr']);
    git(dir, ['merge', '-q', '--no-ff', '--no-edit', 'main']);
    return { main: m, merged: git(dir, ['rev-parse', 'HEAD']) };
  };
  return { dir, base, head, mainChanges };
}

test('receipts: the owner\'s unedited "/reviewed <full head>" comments and approving reviews, newest first', () => {
  const H = 'a'.repeat(40);
  const G = 'b'.repeat(40);
  const user = { login: 'kuaya1', type: 'User' };
  const c = (id, body, at, o = {}) => ({ id, body, user, author_association: 'OWNER', created_at: at, updated_at: at, ...o });
  const { receipts, ignored } = OR.receiptsOf({
    owner: 'kuaya1',
    comments: [c(1, `/reviewed ${H}`, '2026-10-27T01:00:00Z'), c(2, `/reviewed ${G}  \r\nfine`, '2026-10-27T03:00:00Z'), c(3, `/reviewed  ${H.slice(0, 39)}`, '2026-10-27T04:00:00Z'), c(4, 'no command here', '2026-10-27T05:00:00Z')],
    reviews: [{ id: 9, state: 'APPROVED', commit_id: H, user, author_association: 'OWNER', submitted_at: '2026-10-27T02:00:00Z' }, { id: 10, state: 'APPROVED', commit_id: 'short', user, author_association: 'OWNER', submitted_at: '2026-10-27T06:00:00Z' }],
  });
  assert.deepEqual(receipts.map((r) => [r.kind, r.id, r.head]), [['comment', 2, G], ['approve', 9, H], ['comment', 1, H]]);
  assert.deepEqual(ignored.map((i) => i.id), [3]);
  // No owner known: nothing is a receipt.
  assert.deepEqual(OR.receiptsOf({ owner: null, comments: [c(1, `/reviewed ${H}`, '2026-10-27T01:00:00Z')] }).receipts, []);
});

test('a review carries over a merge of main, but not when main changed the lines next to the change, nor across a merge of another branch', (t) => {
  const r = repo(t);
  // main changes line 2, far from the change at line 10: the same patch.
  const far = r.mainChanges(2, 'line two, on main');
  const ok = OR.carriesOver(r.dir, { from: r.head, to: far.merged, base: far.main });
  assert.equal(ok.ok, true, ok.why);
  assert.equal(ok.merges, 1);
  assert.equal(OR.patchId(r.dir, far.main, far.merged), OR.patchId(r.dir, far.main, r.head));
  // main changes line 8, inside the change's context (not next to it, so it merges cleanly): a different patch.
  const near = r.mainChanges(8, 'line eight, on main');
  const no = OR.carriesOver(r.dir, { from: r.head, to: near.merged, base: near.main });
  assert.equal(no.ok, false);
  assert.match(no.why, /the pull request's own change differs \(patch [0-9a-f]{12} at [0-9a-f]{12}, [0-9a-f]{12} at [0-9a-f]{12}\)/);
  // A merge whose second parent is not on main.
  git(r.dir, ['checkout', '-q', '-b', 'side', r.base]);
  fs.writeFileSync(path.join(r.dir, 'side.txt'), 'side\n');
  git(r.dir, ['add', '-A']);
  git(r.dir, ['commit', '-q', '-m', 'side']);
  const side = git(r.dir, ['rev-parse', 'HEAD']);
  git(r.dir, ['checkout', '-q', 'pr']);
  git(r.dir, ['merge', '-q', '--no-ff', '--no-edit', 'side']);
  const odd = git(r.dir, ['rev-parse', 'HEAD']);
  const s = OR.carriesOver(r.dir, { from: far.merged, to: odd, base: near.main });
  assert.equal(s.ok, false);
  assert.match(s.why, new RegExp(`merges ${side.slice(0, 12)}, which is not on main`));
  // A head that is not a commit, or not in the history.
  assert.equal(OR.carriesOver(r.dir, { from: 'x', to: odd, base: near.main }).ok, false);
  assert.match(OR.carriesOver(r.dir, { from: 'c'.repeat(40), to: odd, base: near.main }).why, /is not in this pull request's history any more/);
});

test('the state of a head: an exact receipt, one that carries over, one that does not (invalidated), or none (missing)', (t) => {
  const r = repo(t);
  const far = r.mainChanges(2, 'line two, on main');
  const at = (head) => ({ kind: 'comment', id: 1, head, at: '2026-10-27T01:00:00Z' });
  assert.equal(OR.ownerState({ cwd: r.dir, base: far.main, head: r.head, receipts: [at(r.head)] }).state, 'owner_override');
  const carried = OR.ownerState({ cwd: r.dir, base: far.main, head: far.merged, receipts: [at(r.head)] });
  assert.deepEqual([carried.state, carried.carried.from, carried.carried.merges], ['owner_override', r.head, 1]);
  const near = r.mainChanges(8, 'line eight, on main');
  const inv = OR.ownerState({ cwd: r.dir, base: near.main, head: near.merged, receipts: [at(r.head)] });
  assert.equal(inv.state, 'invalidated');
  assert.equal(inv.reviewed, r.head);
  assert.equal(OR.ownerState({ cwd: r.dir, base: near.main, head: near.merged, receipts: [] }).state, 'missing');
  const c = OR.stateCheck({ head: near.merged, st: inv, owner: 'kuaya1' });
  assert.equal(c.conclusion, 'action_required');
  assert.ok(c.summary.includes(`\n/reviewed ${near.merged}\n`));
});
