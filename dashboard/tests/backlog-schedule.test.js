'use strict';
// The builders' scheduler (backlog-schedule.js, Eric's burst of 2026-10-27):
// temporary git repos with a bare origin and two clones, one per builder.
// Fictional backlog items only; no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const S = require('../scripts/backlog-status');
const B = require('../scripts/backlog-schedule');

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
const g = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const put = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-27T12:00:00Z'); // inside the burst window

// 10 and 12 change a.js; 11 needs 10; 13 is on its own; 14 has no schedule
// line, so it is read as touching everything; 15 and 16 are UI items.
const BACKLOG = [
  '## Autonomous Build Backlog',
  '- [x] **1. Done.** a',
  '- [ ] *(Eric)* **2. Eric.** b',
  '- [ ] **10. Ten.** x',
  '  - **Schedule:** after none; touches `dashboard/core/a.js`, dashboard/tests/a.test.js',
  '- [ ] **11. Eleven.** x',
  '  - Some words first.',
  '  - **Schedule:** after 10; touches dashboard/core/b.js',
  '- [ ] **12. Twelve.** x',
  '  - **Schedule:** touches dashboard/core/a.js',
  '- [ ] **13. Thirteen.** x',
  '  - **Schedule:** touches dashboard/core/c.js',
  '- [ ] **14. Fourteen.** x',
  '- [ ] **15. Fifteen.** x',
  '  - **Schedule:** touches web, dashboard/core/d.js',
  '- [ ] **16. Sixteen.** x',
  '  - **Schedule:** touches dashboard/web/src/views/X.jsx',
  '',
  'A paragraph after the list.',
  '  - **Schedule:** touches nothing/that/counts.js',
  '',
  '## Later',
  '- [ ] **100. After.** y',
  '',
].join('\n');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-bsched-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  g(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const clone = (name) => {
    const dir = path.join(root, name);
    g(root, 'clone', '-q', origin, dir);
    g(dir, 'config', 'core.autocrlf', 'false');
    return dir;
  };
  const a = clone('a');
  g(a, 'checkout', '-q', '-b', 'main');
  put(a, 'DESK_STATE.md', BACKLOG);
  put(a, 'x.txt', 'x\n');
  g(a, 'add', '-A'); g(a, 'commit', '-qm', 'base'); g(a, 'push', '-q', '-u', 'origin', 'main');
  const b = clone('b');
  // A backlog branch with commits for `items`, pushed from clone a.
  const branch = (name, items, from = 'origin/main') => {
    g(a, 'fetch', '-q', 'origin');
    g(a, 'checkout', '-q', '-B', name, from);
    put(a, `f-${name.replace(/\W/g, '_')}.txt`, `${name}\n`);
    g(a, 'add', '-A');
    g(a, 'commit', '-qm', `backlog: ${name}\n\n${items.map((n) => `Backlog-Item: ${n}`).join('\n')}`);
    g(a, 'push', '-q', 'origin', name);
    g(a, 'checkout', '-q', 'main');
  };
  return { origin, a, b, branch };
}
const remoteClaims = (dir) => { g(dir, 'fetch', '-q', 'origin', '--prune'); return B.readClaims(dir); };
// What a builder would decide at `now`, after fetching as the routine does.
const planAt = (dir, now, builder = 'a') => { g(dir, 'fetch', '-q', 'origin', '--prune'); return B.plan(B.inputs(dir, { now, builder })); };

test('capacity windows: the burst runs to 2026-10-28T03:00Z, then the limits before it come back on their own', () => {
  const at = (s) => S.limitsAt(new Date(s));
  assert.deepEqual(pick(at('2026-10-27T02:59:59Z')), ['surge', 5, 5, 15, 'a']);
  assert.deepEqual(pick(at('2026-10-27T03:00:00Z')), ['burst', 5, 10, 20, 'a,b']);
  assert.deepEqual(pick(at('2026-10-28T02:59:59Z')), ['burst', 5, 10, 20, 'a,b']);
  assert.deepEqual(pick(at('2026-10-28T03:00:00Z')), ['surge', 5, 5, 15, 'a']);
  assert.deepEqual(pick(at('2026-10-29T03:00:00Z')), ['standard', 3, 3, 6, 'a']);
  assert.deepEqual(pick(at('2027-06-01T00:00:00Z')), ['standard', 3, 3, 6, 'a']);
  function pick(l) { return [l.window, l.batch, l.per_hour, l.cap, l.builders.join(',')]; }
});

test('schedule lines: after and touches, web is the app and its bundle, a paragraph ends the item, no line means everything', () => {
  const items = S.parseBacklog(BACKLOG);
  const by = Object.fromEntries(items.map((i) => [i.n, i]));
  assert.deepEqual(items.map((i) => i.n), [1, 2, 10, 11, 12, 13, 14, 15, 16]);
  assert.deepEqual(by[10].schedule, { after: [], touches: ['dashboard/core/a.js', 'dashboard/tests/a.test.js'] });
  assert.deepEqual(by[11].schedule.after, [10]);
  assert.equal(by[14].schedule, null);
  assert.deepEqual(by[15].schedule.touches.sort(), ['dashboard/core/d.js', 'dashboard/public/app/', 'dashboard/web/'].sort());
  assert.ok(by[16].schedule.touches.includes('dashboard/public/app/'), 'a web file is the bundle too');
  assert.ok(!JSON.stringify(items).includes('nothing/that/counts'), 'a schedule line after a paragraph belongs to no item');
});

// The pure plan, with the inputs written out.
function input(over = {}) {
  return {
    now: T0, builder: 'a', limits: S.limitsAt(new Date(T0)), backlog: S.parseBacklog(BACKLOG),
    onMain: new Set([1]), waiting: new Map(), baseItems: new Set(), base: 'origin/main', claims: new Map(), otherLane: 0, ...over,
  };
}
const active = (item, run, claimedAt = T0 - 10 * MIN, builder = 'a') => [item, { sha: `s${item}`, record: { schema: B.SCHEMA, item, run, builder, state: 'building', claimed_at: new Date(claimedAt).toISOString(), lease_until: new Date(claimedAt + B.LEASE_MS).toISOString(), failures: 0, lost: 0 } }];

test('one builder takes the first five in order; a run builds them one after another, so its own items may share files', () => {
  const p = B.plan(input());
  assert.equal(p.run_max, 5);
  assert.deepEqual(p.picks.map((x) => x.item), [10, 11, 12, 13, 14]);
  assert.equal(p.branch, 'claude/backlog-batch-items-10-11-12-13-14');
  assert.deepEqual(p.later, [15, 16]);
});

test('overlapping runs: the second builder skips what waits for, or changes what, the first is building, and continues to independent work', () => {
  const p = B.plan(input({ builder: 'b', claims: new Map([active(10, 'a-1')]) }));
  assert.deepEqual(p.in_flight, [10]);
  assert.deepEqual(p.picks.map((x) => x.item), [13, 15, 16]);
  const why = Object.fromEntries(p.skipped.map((s) => [s.item, s.why]));
  assert.match(why[11], /waits for item 10, in flight/);
  assert.match(why[12], /changes what item 10 changes, in flight/);
  assert.match(why[14], /changes what item 10 changes/, 'an item with no schedule line is built alone');
  // Two UI items never build at once in two runs: they share one bundle.
  const q = B.plan(input({ builder: 'b', claims: new Map([active(10, 'a-1'), active(15, 'a-1')]) }));
  assert.deepEqual(q.picks.map((x) => x.item), [13]);
  assert.match(q.skipped.find((x) => x.item === 16).why, /changes what item 15 changes, in flight/);
});

test('a dependency waiting on another branch, or a file changed on another branch, waits until that branch is the base or merged', () => {
  const waiting = new Map([[10, ['claude/backlog-item-10']]]);
  const off = B.plan(input({ waiting, baseItems: new Set(), base: 'origin/claude/backlog-other' }));
  const why = Object.fromEntries(off.skipped.map((s) => [s.item, s.why]));
  assert.match(why[11], /waits for item 10, waiting on claude\/backlog-item-10, not on the base/);
  assert.match(why[12], /changes what item 10 changes, waiting on another branch/);
  const on = B.plan(input({ waiting, baseItems: new Set([10]), base: 'origin/claude/backlog-item-10' }));
  assert.deepEqual(on.picks.map((x) => x.item).slice(0, 3), [11, 12, 13]);
});

test('the hour budget counts every builder\'s claims and the engineering lane; the cap counts waiting and in flight', () => {
  const claims = new Map(Array.from({ length: 8 }, (_, i) => active(200 + i, `r${i % 2}`, T0 - 30 * MIN)));
  assert.equal(B.plan(input({ claims })).run_max, 2);
  assert.equal(B.plan(input({ claims, otherLane: 2 })).run_max, 0);
  assert.match(B.plan(input({ claims, otherLane: 2 })).why, /hour budget used: 10 started in the last 60 minutes \(limit 10\)/);
  const old = new Map(Array.from({ length: 8 }, (_, i) => active(200 + i, 'r', T0 - 61 * MIN)));
  assert.equal(B.plan(input({ claims: old })).started_last_hour, 0, 'claims older than an hour do not count');
  const waiting = new Map(Array.from({ length: 18 }, (_, i) => [300 + i, ['claude/backlog-x']]));
  const two = new Map([active(400, 'r'), active(401, 'r')]);
  const capped = B.plan(input({ waiting, baseItems: new Set(waiting.keys()), claims: two }));
  assert.equal(capped.run_max, 0);
  assert.match(capped.why, /cap: 20 waiting for merge or in flight \(cap 20\)/);
});

test('at the window\'s end: builder b stops, builder a keeps the surge\'s limits, and work already in flight keeps its lease', () => {
  const end = Date.parse('2026-10-28T03:00:00Z');
  const claims = new Map(Array.from({ length: 10 }, (_, i) => active(200 + i, i < 5 ? 'a-1' : 'b-1', end - 20 * MIN, i < 5 ? 'a' : 'b')));
  const b = B.plan(input({ now: end, limits: S.limitsAt(new Date(end)), builder: 'b', claims }));
  assert.equal(b.run_max, 0);
  assert.match(b.why, /builder b does not run in the surge window/);
  const a = B.plan(input({ now: end, limits: S.limitsAt(new Date(end)), claims }));
  assert.equal(a.per_hour, 5);
  assert.equal(a.run_max, 0, 'ten started in the last hour is over the surge\'s five');
  assert.equal(a.in_flight.length, 10, 'the burst\'s in-flight work keeps its lease');
  const later = end + 41 * MIN; // the claims are 61 minutes old; their leases run to end + 70
  const a2 = B.plan(input({ now: later, limits: S.limitsAt(new Date(later)), claims }));
  assert.equal(a2.started_last_hour, 0);
  assert.equal(a2.run_max, 5, 'cap 15 less 10 in flight');
});

test('duplicate claims: two builders racing for the same items never both hold one (real git, two processes)', async (t) => {
  const { a, b } = fixture(t);
  const script = path.join(__dirname, '..', 'scripts', 'backlog-schedule.js');
  const run = (dir, builder, id) => new Promise((resolve) => {
    const code = `const B=require(${JSON.stringify(script)});process.stdout.write(JSON.stringify(B.claim(${JSON.stringify(dir)},{builder:${JSON.stringify(builder)},run:${JSON.stringify(id)},now:${T0}})))`;
    const child = spawn(process.execPath, ['-e', code], { env: ENV });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (status) => resolve({ status, out, err }));
  });
  const [ra, rb] = await Promise.all([run(a, 'a', 'a-1'), run(b, 'b', 'b-1')]);
  assert.equal(ra.status, 0, ra.err); assert.equal(rb.status, 0, rb.err);
  const ca = JSON.parse(ra.out).claimed; const cb = JSON.parse(rb.out).claimed;
  assert.deepEqual(ca.filter((n) => cb.includes(n)), [], 'no item is claimed twice');
  assert.ok(ca.length + cb.length >= 5 && ca.length + cb.length <= 10);
  const claims = remoteClaims(a);
  for (const n of [...ca, ...cb]) assert.equal(claims.get(n).record.run, ca.includes(n) ? 'a-1' : 'b-1');
  // The loser of a race on one item is refused by the remote, not by politeness.
  const [won, winner, loser] = ca.length ? [ca[0], 'a-1', b] : [cb[0], 'b-1', a];
  const stale = B.pushClaims(loser, [{ item: won, sha: g(loser, 'commit-tree', g(loser, 'mktree'), '-m', '{}'), old: null }]);
  assert.equal(stale.ok, false);
  assert.equal(remoteClaims(a).get(won).record.run, winner);
});

test('an atomic claim of several items lands whole or not at all', (t) => {
  const { a, b } = fixture(t);
  const first = B.claim(a, { builder: 'a', run: 'a-1', now: T0 });
  assert.deepEqual(first.claimed, [10, 11, 12, 13, 14]);
  const tree = g(b, 'mktree');
  const mk = (item) => ({ item, sha: g(b, 'commit-tree', tree, '-m', JSON.stringify({ schema: B.SCHEMA, item })), old: null });
  const r = B.pushClaims(b, [mk(15), mk(10)]); // 10 is held
  assert.equal(r.ok, false);
  assert.equal(remoteClaims(b).has(15), false, '15 did not land without 10');
  const second = B.claim(b, { builder: 'b', run: 'b-1', now: T0 + MIN });
  assert.deepEqual(second.claimed, [], '15 and 16 conflict with 14, in flight, which touches everything');
  assert.match(B.words(second), /Nothing claimed/);
});

// A lease that ended with no word used to free its items for the next run, so
// a run still building past it pushed its branch beside a second builder's.
// No clock frees one now (red-team review, 2026-10-27).
test('restart recovery: a lease that ends with no word holds its items, reconcile required, never reclaimed by the clock; the run\'s own word or Eric\'s release settles them', (t) => {
  const { a, b } = fixture(t);
  B.claim(a, { builder: 'a', run: 'a-1', now: T0 });
  for (const at of [T0 + 91 * MIN, T0 + 30 * 24 * 60 * MIN]) {
    const r = B.claim(b, { builder: 'b', run: 'b-1', now: at });
    assert.deepEqual(r.claimed, [], 'no clock frees a claim, a minute or a month on');
    assert.deepEqual(r.in_flight, [10, 11, 12, 13, 14], 'its items stay in flight: the cap and their files hold');
    assert.deepEqual(r.reconcile.map((x) => x.item), [10, 11, 12, 13, 14]);
    assert.match(r.reconcile[0].why, /^reconcile required: run a-1's lease ended 2026-10-27T13:30:00\.000Z with no word, and whether it is still building cannot be read; it holds until that run speaks again or Eric releases it \(`backlog-schedule\.js release --run a-1 --item 10`\)$/);
    assert.match(B.words(r), /^Held 10: reconcile required/m);
  }
  assert.deepEqual([...remoteClaims(a).values()].map((c) => [c.record.run, c.record.state]), Array(5).fill(['a-1', 'building']), 'nothing was written');
  // The run was alive after all: its word still counts, and its heartbeat
  // makes the lease current again.
  assert.deepEqual(B.heartbeat(a, { run: 'a-1', now: T0 + 200 * MIN }).held, [10, 11, 12, 13, 14]);
  assert.deepEqual(planAt(b, T0 + 201 * MIN, 'b').reconcile, []);
  // Eric releases what a run will never finish; only then is it taken, and
  // the old run's late word is refused.
  for (const n of [10, 11, 12, 13, 14]) B.release(a, { run: 'a-1', item: n, now: T0 + 400 * MIN });
  assert.deepEqual(B.claim(b, { builder: 'b', run: 'b-1', now: T0 + 401 * MIN }).claimed, [10, 11, 12, 13, 14]);
  const c10 = remoteClaims(a).get(10).record;
  assert.deepEqual([c10.run, c10.lost, c10.previous], ['b-1', 0, { run: 'a-1', state: 'released', reason: null }]);
  assert.throws(() => B.done(a, { run: 'a-1', item: 10, branch: 'x', now: T0 + 402 * MIN }), /claimed by run b-1, not a-1/);
  assert.deepEqual(B.heartbeat(a, { run: 'a-1', now: T0 + 402 * MIN }).held, [], 'the released run holds nothing, so it pushes nothing');
});

test('a heartbeat keeps a long run\'s items; a release frees an item at once and is not counted in the hour', (t) => {
  const { a, b } = fixture(t);
  B.claim(a, { builder: 'a', run: 'a-1', now: T0 });
  assert.deepEqual(B.heartbeat(a, { run: 'a-1', now: T0 + 80 * MIN }).held, [10, 11, 12, 13, 14]);
  assert.deepEqual(planAt(b, T0 + 100 * MIN, 'b').in_flight, [10, 11, 12, 13, 14]);
  B.release(a, { run: 'a-1', item: 13, now: T0 + 101 * MIN });
  const p = planAt(b, T0 + 102 * MIN, 'b');
  assert.deepEqual(p.in_flight, [10, 11, 12, 14]);
  assert.equal(p.started_last_hour, 0);
});

test('failures: a failed item waits 30 minutes, then is tried again; a second failure blocks it for Eric, and the next independent item is taken', (t) => {
  const { a, b } = fixture(t);
  B.claim(a, { builder: 'a', run: 'a-1', now: T0 });
  for (const n of [11, 12, 13, 14]) B.release(a, { run: 'a-1', item: n, now: T0 + MIN });
  B.fail(a, { run: 'a-1', item: 10, reason: 'suite red: tickets.test.js', now: T0 + 2 * MIN });
  const soon = planAt(b, T0 + 10 * MIN, 'b');
  assert.match(soon.skipped.find((s) => s.item === 10).why, /retry after/);
  assert.ok(!soon.picks.some((x) => x.item === 10));
  const again = B.claim(b, { builder: 'b', run: 'b-1', now: T0 + 33 * MIN });
  assert.equal(again.claimed[0], 10);
  // b-1 gives back what it will not build: a lease that lapses would hold
  // them in flight (reconcile required), never free them.
  for (const n of again.claimed.filter((x) => x !== 10)) B.release(b, { run: 'b-1', item: n, now: T0 + 34 * MIN });
  assert.equal(remoteClaims(b).get(10).record.failures, 1);
  B.fail(b, { run: 'b-1', item: 10, reason: 'suite red again', now: T0 + 40 * MIN });
  const after = planAt(a, T0 + 200 * MIN, 'a');
  assert.match(after.blocked.find((x) => x.item === 10).why, /failed 2 times \(last: suite red again\)/);
  assert.match(after.skipped.find((s) => s.item === 11).why, /waits for item 10, not built yet/);
  assert.ok(after.picks.some((x) => x.item === 12), 'independent work continues');
});

test('built: the pushed branch makes the item taken; a branch gone without merge blocks the item for Eric', (t) => {
  const { a, branch } = fixture(t);
  B.claim(a, { builder: 'a', run: 'a-1', now: T0 });
  for (const n of [11, 12, 13, 14]) B.release(a, { run: 'a-1', item: n, now: T0 + MIN });
  branch('claude/backlog-item-10', [10]);
  B.done(a, { run: 'a-1', item: 10, branch: 'claude/backlog-item-10', now: T0 + 2 * MIN });
  const p = planAt(a, T0 + 3 * MIN, 'a');
  assert.equal(p.waiting_count, 1);
  assert.ok(!p.picks.some((x) => x.item === 10));
  assert.equal(p.base, 'origin/claude/backlog-item-10');
  assert.equal(p.picks[0].item, 11, 'the dependent item stacks on its dependency\'s branch');
  g(a, 'push', '-q', 'origin', ':claude/backlog-item-10');
  const gone = planAt(a, T0 + 4 * MIN, 'a');
  assert.match(gone.blocked.find((x) => x.item === 10).why, /no commit for it is on any branch now: Eric decides/);
});

test('plan writes nothing to the remote; an unreadable claim blocks its item', (t) => {
  const { a } = fixture(t);
  const before = g(a, 'ls-remote', 'origin');
  planAt(a, T0, 'a');
  assert.equal(g(a, 'ls-remote', 'origin'), before);
  const junk = g(a, 'commit-tree', g(a, 'mktree'), '-m', 'not json');
  g(a, 'push', '-q', 'origin', `${junk}:refs/heads/${B.CLAIM_PREFIX}10`);
  const q = planAt(a, T0, 'a');
  assert.match(q.blocked.find((x) => x.item === 10).why, /does not read as a claim/);
});
