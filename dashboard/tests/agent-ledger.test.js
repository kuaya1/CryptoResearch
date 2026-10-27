'use strict';
// The agent lane's paid-attempt ledger (Eric, 2026-10-26;
// audits/2026-10-26-engineering-simplification): an append-only hash chain on
// a branch, written by compare-and-swap, that reserves every paid request
// before it is sent. A local bare repository stands in for GitHub; FICTIONAL
// records only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('../scripts/agent-ledger');

const ID = { GIT_AUTHOR_NAME: 'FICTIONAL', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'FICTIONAL', GIT_COMMITTER_EMAIL: 'f@example.invalid' };
const git = (cwd, args, input) => {
  const r = spawnSync('git', args, { cwd, input, encoding: 'utf8', env: { ...process.env, ...ID } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return String(r.stdout).trim();
};
function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ledger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '-q', '--bare', 'remote.git']);
  fs.mkdirSync(path.join(dir, 'a'));
  fs.mkdirSync(path.join(dir, 'b'));
  for (const w of ['a', 'b']) { git(path.join(dir, w), ['init', '-q']); git(path.join(dir, w), ['remote', 'add', 'origin', path.join(dir, 'remote.git')]); }
  return { a: path.join(dir, 'a'), b: path.join(dir, 'b'), remote: path.join(dir, 'remote.git') };
}
const CEIL = { review_attempts_per_binding: 2, reviews_per_day: 3, review_tokens_per_day: 100000, builds_per_task_version: 2, builds_per_day: 2, build_usd_per_day: 20 };
const NOW = Date.parse('2026-10-26T12:00:00Z');
const KEY = L.macKey('sk-FICTIONAL');

test('appends form a hash chain read back whole; an edited line makes the ledger unreadable', (t) => {
  const s = sandbox(t);
  for (const n of [1, 2]) assert.ok(L.transact(s.a, { decide: () => ({ append: [{ t: 'note', n }] }) }).committed);
  const l = L.read(s.b);
  assert.deepEqual(l.entries.map((e) => [e.seq, e.n]), [[1, 1], [2, 2]]);
  assert.equal(l.entries[0].prev, L.ZERO);
  assert.equal(l.entries[1].prev, L.sha256(l.text.split('\n')[0]));
  // Someone rewrites line 1 in a new commit on the tip (an append-only
  // branch cannot stop a new commit, so the chain must).
  const edited = l.text.replace('"n":1', '"n":9');
  const blob = git(s.b, ['hash-object', '-w', '--stdin'], edited);
  const tree = git(s.b, ['mktree'], `100644 blob ${blob}\tledger.jsonl\n`);
  const c = git(s.b, ['commit-tree', tree, '-p', l.tip, '-m', 'edit']);
  git(s.b, ['push', '-q', 'origin', `${c}:refs/heads/agent-ledger`]);
  const broken = L.read(s.a);
  assert.match(broken.error, /broken: line 2 does not follow line 1/);
  const d = L.transact(s.a, { decide: (e) => L.decideReview(e, { binding: 'x', bind: {}, ceilings: CEIL, now: NOW, key: KEY, tokens: 1, run: '1/1' }) });
  assert.match(d.error, /nothing paid is sent until Eric looks/);
});

test('two writers on one tip: the second push is refused and its decision is made again on the new tip', (t) => {
  const s = sandbox(t);
  L.transact(s.a, { decide: () => ({ append: [{ t: 'note', n: 0 }] }) });
  let decisions = 0;
  const r = L.transact(s.a, {
    decide: (entries) => { decisions += 1; return { saw: entries.length, append: [{ t: 'note', n: 'a' }] }; },
    // Writer b lands between a's read and a's push.
    beforePush: () => assert.ok(L.transact(s.b, { decide: () => ({ append: [{ t: 'note', n: 'b' }] }) }).committed),
  });
  assert.ok(r.committed);
  assert.equal(decisions, 2);
  assert.equal(r.saw, 2, 'the second decision saw b\'s line');
  assert.deepEqual(L.read(s.a).entries.map((e) => `${e.seq}:${e.n}`), ['1:0', '2:b', '3:a']);
});

test('two reviews of one binding at once reserve one attempt: the loser finds it open and sends nothing', (t) => {
  const s = sandbox(t);
  const args = { binding: 'bind-1', bind: { head: 'h' }, ceilings: CEIL, now: NOW, key: KEY, tokens: 100, run: '1/1' };
  let inner = null;
  const outer = L.transact(s.a, {
    decide: (e) => L.decideReview(e, args),
    beforePush: () => { inner = L.transact(s.b, { decide: (e) => L.decideReview(e, { ...args, run: '2/1' }) }); },
  });
  assert.equal(inner.action, 'send');
  assert.equal(outer.action, 'reconcile', 'the outer run re-read the tip and found the inner reservation');
  assert.equal(outer.attempt.id, inner.id);
  assert.equal(L.read(s.a).entries.filter((e) => e.t === 'reserve').length, 1);
});

test('reviews: an open attempt is reconciled first; ceilings count attempts, not saved reviews', () => {
  const base = { binding: 'b1', bind: {}, ceilings: CEIL, now: NOW, key: KEY, tokens: 1000, run: '1/1' };
  const reserve = (id, binding = 'b1', day = '2026-10-26', tokens = 1000) => ({ t: 'reserve', kind: 'review', id, binding, day, tokens, at: new Date(NOW).toISOString() });
  const out = (id, state) => ({ t: 'outcome', id, state });
  assert.equal(L.decideReview([], base).action, 'send');
  for (const state of [null, 'unknown']) {
    const e = [reserve('rv-1'), ...(state ? [out('rv-1', state)] : [])];
    const d = L.decideReview(e, base);
    assert.equal(d.action, 'reconcile', `${state || 'pending'} is open`);
    assert.equal(d.attempt.id, 'rv-1');
  }
  // Two settled attempts without a verdict (failed, lost) use up the binding.
  const two = [reserve('rv-1'), out('rv-1', 'failed'), reserve('rv-2'), out('rv-2', 'lost')];
  assert.match(L.decideReview(two, base).why, /2 paid attempts for this exact head/);
  assert.equal(L.decideReview(two, { ...base, binding: 'b2' }).action, 'send', 'another head is another binding');
  // Per day: attempts of every binding count, and tokens.
  const day = [reserve('x1', 'o1'), reserve('x2', 'o2'), reserve('x3', 'o3')].flatMap((r) => [r, out(r.id, 'failed')]);
  assert.match(L.decideReview(day, base).why, /3 paid review attempts today/);
  assert.equal(L.decideReview(day, { ...base, now: NOW + 86400000 }).action, 'send', 'a new UTC day');
  assert.match(L.decideReview([reserve('t1', 'o1', '2026-10-26', 99500), out('t1', 'failed')], base).why, /would reserve 1000 tokens on top of 99500/);
});

test('a held verdict is posted only with its MAC; a forged one is refused, not sent around', () => {
  const base = { binding: 'b1', bind: {}, ceilings: CEIL, now: NOW, key: KEY, tokens: 1, run: '1/1' };
  const verdict = { result: 'pass', findings: [], summary: 'FICTIONAL' };
  const rec = { t: 'outcome', id: 'rv-1', state: 'response', response_id: 'chatcmpl-1', verdict };
  const good = [{ t: 'reserve', kind: 'review', id: 'rv-1', binding: 'b1', day: '2026-10-26' }, { ...rec, mac: L.macOf(KEY, { ...rec, binding: 'b1' }) }];
  const d = L.decideReview(good, base);
  assert.equal(d.action, 'post');
  assert.deepEqual(d.verdict, verdict);
  const forged = [good[0], { ...rec, mac: L.macOf(L.macKey('another key'), { ...rec, binding: 'b1' }) }];
  assert.match(L.decideReview(forged, base).why, /fails its check/);
  assert.match(L.decideReview([good[0], { ...rec }], base).why, /fails its check/, 'no MAC at all');
  assert.equal(L.decideReview(good, { ...base, binding: 'b2' }).action, 'send', 'a verdict is never moved to another binding');
});

test('builds: one reservation per run, per task version and per day, dollars included', () => {
  const base = { binding: 't1', bind: {}, ceilings: CEIL, now: NOW, usd: 8, run: '10/1' };
  const reserve = (id, run, binding = 't1', usd = 8) => ({ t: 'reserve', kind: 'build', id, binding, run, usd, day: '2026-10-26' });
  assert.equal(L.decideBuild([], base).action, 'build');
  assert.match(L.decideBuild([reserve('bd-1', '10/1')], base).why, /run 10\/1 already holds/);
  assert.equal(L.decideBuild([reserve('bd-1', '10/1')], { ...base, run: '10/2' }).action, 'build', 'a re-run of the whole workflow is a new attempt');
  assert.match(L.decideBuild([reserve('bd-1', '9/1'), reserve('bd-2', '10/1')], { ...base, run: '11/1' }).why, /2 paid builds for this version/);
  assert.match(L.decideBuild([reserve('bd-1', '9/1', 'o1'), reserve('bd-2', '10/1', 'o2')], { ...base, run: '11/1' }).why, /2 paid builds today/);
  assert.match(L.decideBuild([reserve('bd-1', '9/1', 'o1', 15)], { ...base, run: '11/1' }).why, /would reserve \$8 on top of \$15/);
});

test('builds of one task version count together whichever commit of main each started from', () => {
  const bind = (base, task = 'a'.repeat(64)) => ({ kind: 'build', issue: 7, task_sha256: task, base });
  const reserve = (id, run, b) => ({ t: 'reserve', kind: 'build', id, binding: L.bindingOf(b), bind: b, run, usd: 8, day: '2026-10-26' });
  const args = (b, run) => ({ binding: L.bindingOf(b), bind: b, ceilings: { ...CEIL, builds_per_day: 9, build_usd_per_day: 99 }, now: NOW, usd: 8, run });
  const done = (id, state) => ({ t: 'outcome', id, state });
  const two = [reserve('bd-1', '1/1', bind('m1')), done('bd-1', 'failed'), reserve('bd-2', '2/1', bind('m2')), done('bd-2', 'response')];
  assert.match(L.decideBuild(two, args(bind('m3'), '3/1')).why, /2 paid builds for this version/);
  assert.equal(L.decideBuild(two, args(bind('m3', 'b'.repeat(64)), '3/1')).action, 'build', 'an edited task is another version');
  assert.equal(L.decideBuild(two, args({ ...bind('m3'), issue: 8 }, '3/1')).action, 'build', 'another issue');
});

test('builds: one per issue at a time; an open one is recorded lost after the hold, frees the issue and still counts', () => {
  const bind = (issue = 7) => ({ kind: 'build', issue, task_sha256: 'a'.repeat(64), base: 'm1', predecessor: 'absent' });
  const reserve = (id, run, b, at) => ({ t: 'reserve', kind: 'build', id, binding: L.bindingOf(b), bind: b, run, usd: 8, day: '2026-10-26', at });
  const args = (b, run, now = NOW) => ({ binding: L.bindingOf(b), bind: b, ceilings: { ...CEIL, builds_per_day: 9, build_usd_per_day: 99 }, now, usd: 8, run });
  const open = [reserve('bd-1', '1/1', bind(), new Date(NOW - 64 * 60000).toISOString())];
  assert.match(L.decideBuild(open, args(bind(), '2/1')).why, /build bd-1 of issue #7 \(run 1\/1\) has no outcome yet and is 64 min old; one build per issue at a time, each held up to 65 min/);
  assert.equal(L.decideBuild(open, args(bind(8), '2/1')).action, 'build', 'another issue is not held');
  assert.equal(L.decideBuild([...open, { t: 'outcome', id: 'bd-1', state: 'unknown' }], args(bind(), '2/1')).action, 'build', 'an outcome, even unknown, frees the issue');
  assert.match(L.decideBuild([reserve('bd-1', '1/1', bind(), 'not a time')], args(bind(), '2/1')).why, /has no outcome yet; one build per issue/, 'an unreadable time holds the issue');
  const later = L.decideBuild(open, args(bind(), '2/1', NOW + 60000));
  assert.equal(later.action, 'build');
  assert.deepEqual(later.lost, ['bd-1']);
  assert.deepEqual(later.append.map((e) => [e.t, e.id, e.state]), [['outcome', 'bd-1', 'lost'], ['reserve', later.id, undefined]]);
  assert.match(later.append[0].error, /no outcome 65 min after it was reserved/);
  const after = [...open, ...later.append, { t: 'outcome', id: later.id, state: 'response' }];
  assert.match(L.decideBuild(after, args(bind(), '3/1', NOW + 120000)).why, /2 paid builds for this version/, 'the lost build still counts');
  assert.equal(L.BUILD_GRACE_MINUTES, 20, 'a 45-minute build is held 65 minutes');
});
