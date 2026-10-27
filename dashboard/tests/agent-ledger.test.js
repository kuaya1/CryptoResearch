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

test('builds: one per task at a time; an open one is settled only by its run\'s status, never by its age; an orphan frees the task and consumes no attempt', () => {
  const bind = (issue = 7) => ({ kind: 'build', issue, task_sha256: 'a'.repeat(64), base: 'm1', predecessor: 'absent' });
  const reserve = (id, run, b, at) => ({ t: 'reserve', kind: 'build', id, binding: L.bindingOf(b), bind: b, run, usd: 8, day: '2026-10-26', at });
  const args = (b, run, now = NOW, runs = null) => ({ binding: L.bindingOf(b), bind: b, ceilings: { ...CEIL, builds_per_day: 9, build_usd_per_day: 99 }, now, usd: 8, run, runs });
  const st = (status, conclusion = null) => new Map([['1/1', { status, conclusion }]]);
  // Reserved ten hours ago: its age decides nothing.
  const open = [reserve('bd-1', '1/1', bind(), new Date(NOW - 600 * 60000).toISOString())];
  // GitHub cannot say: held as reconcile required, however old it is (red-team review, 2026-10-27).
  const unknown = L.decideBuild(open, args(bind(), '2/1', NOW + 30 * 86400000));
  assert.equal(unknown.action, 'refuse');
  assert.equal(unknown.reconcile, true);
  assert.match(unknown.why, /build bd-1 of issue #7 \(run 1\/1\) has no outcome yet: whether its run 1\/1 is still running could not be read from GitHub \(reconcile required: nothing new starts until GitHub answers; cancel the run to free the task\); one build, revision or remediation per task at a time/);
  assert.match(L.decideBuild([reserve('bd-1', '1/1', bind(), 'not a time')], args(bind(), '2/1')).why, /reconcile required/, 'an unreadable time is held the same way');
  assert.equal(L.decideBuild(open, args(bind(8), '2/1')).action, 'build', 'another issue is not held');
  assert.equal(L.decideBuild([...open, { t: 'outcome', id: 'bd-1', state: 'unknown' }], args(bind(), '2/1')).action, 'build', 'an outcome, even unknown, frees the issue');
  // GitHub says it is queued or running: held, however long.
  assert.match(L.decideBuild(open, args(bind(), '2/1', NOW, st('in_progress'))).why, /has no outcome yet: its run 1\/1 is in_progress;/);
  assert.match(L.decideBuild(open, args(bind(), '2/1', NOW + 30 * 86400000, st('queued'))).why, /its run 1\/1 is queued;/);
  assert.equal(L.decideBuild(open, args(bind(), '2/1', NOW, st('in_progress'))).reconcile, false);
  // GitHub says it ended: settled at once, whatever its age.
  const ended = L.decideBuild(open, args(bind(), '2/1', NOW - 599 * 60000, st('completed', 'failure')));
  assert.equal(ended.action, 'build');
  assert.deepEqual(ended.orphaned, ['bd-1']);
  assert.deepEqual(ended.append.map((e) => [e.t, e.id, e.state, e.via]), [['outcome', 'bd-1', 'orphaned', 'run-status'], ['reserve', ended.id, undefined, undefined]]);
  assert.match(ended.append[0].error, /its run 1\/1 completed \(failure\) with no outcome recorded/);
  assert.equal(ended.append[0].note, L.ORPHAN_NOTE);
  assert.equal(L.ORPHAN_NOTE, 'Orphaned attempt: its run ended with no outcome recorded; unlocking queue');
  const cancelled = L.decideBuild(open, args(bind(), '2/1', NOW, st('completed', 'cancelled')));
  assert.match(cancelled.append[0].error, /completed \(cancelled\)/, 'cancelling the run is how a stuck one is freed');
  const missing = L.decideBuild(open, args(bind(), '2/1', NOW, new Map([['1/1', { status: 'missing' }]])));
  assert.deepEqual([missing.action, missing.append[0].state], ['build', 'orphaned']);
  assert.match(missing.append[0].error, /its run 1\/1 does not exist on GitHub and no outcome was recorded/);
  assert.equal(L.LEASE_TTL_MINUTES, undefined, 'no lease clock is exported');
  // The orphan consumes none of the version's two builds: a second may run.
  const after = [...open, ...ended.append, { t: 'outcome', id: ended.id, state: 'response' }];
  assert.equal(L.decideBuild(after, args(bind(), '3/1', NOW + 120000)).action, 'build', 'the orphaned build does not count');
  const third = [...after, reserve('bd-3', '3/1', bind(), new Date(NOW + 120000).toISOString()), { t: 'outcome', id: 'bd-3', state: 'failed' }];
  assert.match(L.decideBuild(third, args(bind(), '4/1', NOW + 180000)).why, /2 paid builds for this version/, 'two that ran to an outcome use the version up');
  // Today's count and dollars still count it: a runner that keeps dying is bounded.
  const daily = { ...args(bind(), '3/1', NOW + 120000), ceilings: { ...CEIL, builds_per_day: 2, build_usd_per_day: 99 } };
  assert.match(L.decideBuild(after, daily).why, /2 paid builds today/);
  // One recorded before 2026-10-27 as 'lost' is the same; a real outcome that
  // arrives later (the runner came back) makes it count again.
  assert.equal(L.orphaned({ outcomes: [{ state: 'lost' }], publishing: [] }), true);
  assert.equal(L.orphaned({ outcomes: [{ state: 'orphaned' }, { state: 'response' }], publishing: [] }), false);
  const late = [...after, { t: 'outcome', id: 'bd-1', state: 'response' }];
  assert.match(L.decideBuild(late, args(bind(), '3/1', NOW + 120000)).why, /2 paid builds for this version/, 'the runner came back: it counts');
  // An open attempt is orphaned only on its run's word, never on a clock.
  const [a] = L.attempts(open);
  assert.equal(L.orphaned(a, null), false);
  assert.equal(L.orphaned(a, st('in_progress')), false);
  assert.equal(L.orphaned(a, st('completed', 'success')), true);
  // orphanLines: only paid attempts with no outcome, only when their run ended.
  assert.deepEqual(L.orphanLines(open, NOW + 30 * 86400000, null), [], 'no clock makes an orphan');
  assert.deepEqual(L.orphanLines(open, NOW, st('in_progress')), []);
  assert.deepEqual(L.orphanLines(open, NOW, st('completed', 'failure')).map((e) => [e.id, e.state, e.note]), [['bd-1', 'orphaned', L.ORPHAN_NOTE]]);
  assert.deepEqual(L.orphanLines([...open, { t: 'outcome', id: 'bd-1', state: 'unknown' }], NOW, st('completed')), [], 'an outcome, even unknown, is not an orphan');
  assert.deepEqual(L.orphanLines([{ t: 'reserve', kind: 'review', id: 'rv-1', run: '1/1', at: new Date(NOW - 99 * 60000).toISOString() }], NOW, st('completed')), [], 'a review is reconciled, never orphaned');
});

test('a build whose publishing line is in the ledger is never orphaned: its run ended, it is recorded as published with its commit', () => {
  const b = { kind: 'build', issue: 7, task_sha256: 'a'.repeat(64), base: 'm1', predecessor: 'absent' };
  const entries = [
    { t: 'reserve', kind: 'build', id: 'bd-1', binding: L.bindingOf(b), bind: b, run: '1/1', usd: 8, day: '2026-10-26', at: new Date(NOW - 90 * 60000).toISOString() },
    { t: 'publishing', id: 'bd-1', commit: 'c'.repeat(40), branch: 'agent/issue-7', predecessor: 'absent', run: '1/1', at: new Date(NOW - 80 * 60000).toISOString() },
  ];
  const a = L.attempts(entries)[0];
  assert.deepEqual([a.outcomes.length, a.publishing.length], [0, 1], 'a publishing line is not an outcome');
  const runs = new Map([['1/1', { status: 'completed', conclusion: 'failure' }]]);
  assert.equal(L.orphaned(a, runs), false);
  const d = L.decideBuild(entries, { binding: 'x', bind: { ...b, task_sha256: 'b'.repeat(64) }, ceilings: { ...CEIL, builds_per_day: 9, build_usd_per_day: 99 }, now: NOW, usd: 8, run: '2/1', runs });
  assert.equal(d.action, 'build');
  assert.deepEqual(d.orphaned, []);
  assert.deepEqual(d.published, ['bd-1']);
  assert.deepEqual([d.append[0].t, d.append[0].state, d.append[0].publish, d.append[0].commit, d.append[0].job], ['outcome', 'response', 'published', 'c'.repeat(40), 'unrecorded']);
  // Its run not read: held, publishing line or not.
  assert.equal(L.decideBuild(entries, { binding: 'x', bind: { ...b, task_sha256: 'b'.repeat(64) }, ceilings: { ...CEIL, builds_per_day: 9, build_usd_per_day: 99 }, now: NOW, usd: 8, run: '2/1' }).reconcile, true);
});

test('run statuses: read for open paid attempts (of the task when named); a run not read is left out; a 404 counts as missing only when the run asking reads', async () => {
  const b = (issue) => ({ kind: 'build', issue, task_sha256: 'a'.repeat(64), base: 'm1', predecessor: 'absent' });
  const r = (id, run, issue, kind = 'build') => ({ t: 'reserve', kind, id, binding: 'x', bind: b(issue), run, usd: 8, day: '2026-10-26' });
  const entries = [r('bd-1', '11/1', 7), r('bd-2', '12/2', 7), r('bd-3', '13/1', 8), r('bd-4', '14/1', 7), { t: 'outcome', id: 'bd-4', state: 'response' }, r('bd-5', 'not-a-run', 7), r('rv-6', '16/1', 7, 'review'), r('bd-7', '17/1', 'TASK-001')];
  const asked = [];
  const runs = await L.runStatuses(entries, { issue: 7, readRun: async (id) => { asked.push(id); if (id === 12) throw new Error('FICTIONAL network'); return { status: 'in_progress', conclusion: null, html_url: 'ignored' }; } });
  assert.deepEqual(asked, [11, 12]);
  assert.deepEqual([...runs.entries()], [['11/1', { status: 'in_progress', conclusion: null }]]);
  // Every open paid attempt when no task is named (the PM).
  const all = await L.runStatuses(entries, { readRun: async (id) => ({ status: 'completed', conclusion: id === 13 ? 'success' : 'failure' }) });
  assert.deepEqual([...all.keys()], ['11/1', '12/2', '13/1', '17/1']);
  // A 404 is missing only when the run asking reads (a token without access is answered 404 too).
  const gone = (control) => L.runStatuses([r('bd-1', '11/1', 7)], { issue: 7, control, readRun: async (id) => (id === 99 ? { status: 'in_progress' } : { missing: true }) });
  assert.deepEqual([...(await gone('99/1')).entries()], [['11/1', { status: 'missing', conclusion: null }]]);
  assert.deepEqual([...(await gone('98/1')).entries()], [], 'the control is answered 404 too: nothing is known');
  assert.deepEqual([...(await gone(null)).entries()], [], 'no control: nothing is known');
  assert.deepEqual(L.runIdOf('40/2'), { id: 40, attempt: 2 });
  assert.equal(L.runIdOf('40'), null);
  assert.equal(L.runIdOf('rv/1'), null);
});
