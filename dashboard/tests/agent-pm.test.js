'use strict';
// The PM builder (Eric, 2026-10-27; audits/2026-10-27-pm-builder): the Active
// Backlog's blocks and statuses (agent-backlog.js), the PM's one action per
// state (agent-pm.js decide), the 60-minute lease and the orphan release
// (hardening rule 1), the corrective prompt, the block after three
// remediations, and the briefing (agent-status.js). Fictional tasks, a
// temporary git remote, a fake GitHub and no OpenAI: nothing is sent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const B = require('../scripts/agent-backlog');
const G = require('../scripts/agent-guard');
const L = require('../scripts/agent-ledger');
const PM = require('../scripts/agent-pm');
const S = require('../scripts/agent-status');

const POLICY = G.loadPolicy();
const REPO = 'kuaya1/CryptoResearch';
const T0 = Date.parse('2026-10-27T12:00:00Z');
const MIN = 60000;
const HEAD = 'c'.repeat(40);

const block = (id, title, status, { template = 'eng-backend@1', outcome = 'FICTIONAL: the widget size helper ignores tabs.', files = ['dashboard/core/fictional-widget.js', 'dashboard/tests/fictional-widget.test.js'] } = {}) => [
  `### ${id} · ${title}`,
  `- **Status:** ${status}`,
  `- **Template:** ${template}`,
  `- **Outcome:** ${outcome}`,
  '- **Acceptance checks:**',
  '  - FICTIONAL: sizeOf("a\\tb") is 2.',
  '- **Negative cases:**',
  '  - FICTIONAL: never counts a tab as a character.',
  '- **Files to change:**',
  ...files.map((f) => `  - ${f}`),
  '- **Regression tests:**',
  '  - dashboard/tests/fictional-widget.test.js',
].join('\n');
const desk = (...blocks) => ['# FICTIONAL desk', '', '## Active Backlog', '', 'FICTIONAL queue, in order.', '', ...blocks.flatMap((b) => [b, '']), '## What it does', '', 'FICTIONAL.', ''].join('\n');
const TWO = desk(block('TASK-001', 'Widget size', '[TODO]'), block('TASK-002', 'Widget tabs', '[TODO]'));

// A state as agent-pm.js gather reads it.
const state = (text = TWO, extra = {}) => ({ repo: REPO, main: 'a'.repeat(40), backlog: B.parse(text), entries: [], candidates: [], runs: [], pr: null, errors: [], ...extra });
const v1 = () => B.parse(TWO).tasks[0].version;
const reserve = (kind, id, at, { task = 'TASK-001', version = v1(), run = `${id}/1`, extra = {} } = {}) => ({ t: 'reserve', kind, id, binding: `b-${id}`, bind: { issue: task, task_sha256: version, ...extra }, day: new Date(at).toISOString().slice(0, 10), usd: kind === 'diagnose' ? undefined : 8, tokens: kind === 'diagnose' ? 1000 : undefined, run, at: new Date(at).toISOString() });
const outcome = (id, state, more = {}) => ({ t: 'outcome', id, state, ...more });
const diagnosis = (id, subject, round, at = T0) => [
  reserve('diagnose', id, at, { extra: { subject, round } }),
  outcome(id, 'response', { verdict: { error: 'FICTIONAL: test widget-size failed', files: ['dashboard/core/fictional-widget.js'], case: 'a tab', instructions: 'Skip tabs.', confidence: 'medium', root_cause: null } }),
];
const candidate = (checks, more = {}) => ({ number: 5, branch: 'agent/task-001', head: HEAD, task: 'TASK-001', title: 'TASK-001: Widget size', url: null, checks, ...more });
const ALL = (r = 'success') => ({ test: 'success', 'agent-guard': 'success', 'agent-verify': 'success', 'agent-review': r });

test('the Active Backlog: blocks parse in order; a bad status, a duplicate or an empty field is a problem, never guessed', () => {
  const p = B.parse(TWO);
  assert.equal(p.found, true);
  assert.deepEqual(p.tasks.map((t) => [t.id, t.title, t.status.kind, t.problems]), [['TASK-001', 'Widget size', 'todo', []], ['TASK-002', 'Widget tabs', 'todo', []]]);
  assert.equal(p.tasks[0].fields.template, 'eng-backend@1');
  assert.equal(p.tasks[0].fields.acceptance, '- FICTIONAL: sizeOf("a\\tb") is 2.');
  assert.deepEqual(B.parseStatus('[IN_PROGRESS: PR #12]'), { kind: 'in_progress', pr: 12, text: '[IN_PROGRESS: PR #12]' });
  assert.deepEqual(B.parseStatus('[BLOCKED: Needs Human Architect]'), { kind: 'blocked', reason: 'Needs Human Architect', text: '[BLOCKED: Needs Human Architect]' });
  for (const bad of ['[WIP]', 'TODO', '[todo]', '[IN_PROGRESS: PR #0]', '[IN_PROGRESS]', '[BLOCKED: ]', '[DONE] ']) {
    const t = B.parse(desk(block('TASK-001', 'Widget size', bad))).tasks[0];
    if (bad === '[DONE] ') { assert.equal(t.status.kind, 'done', 'a trailing space is trimmed'); continue; }
    assert.equal(t.status, null, bad);
    assert.ok(t.problems.some((x) => /is not \[TODO\], \[IN_PROGRESS: PR #<n>\], \[DONE\] or \[BLOCKED: <reason>\]/.test(x)), bad);
  }
  const dup = B.parse(desk(block('TASK-001', 'A', '[TODO]'), block('TASK-001', 'B', '[TODO]')));
  assert.ok(dup.tasks[1].problems.includes('TASK-001 appears twice'));
  const empty = B.parse(desk(block('TASK-001', 'A', '[TODO]', { outcome: '' })));
  assert.ok(empty.tasks[0].problems.includes('"Outcome" is empty'));
  const none = B.parse('# FICTIONAL\n\n## Something else\n');
  assert.equal(none.found, false);
  assert.match(none.problems[0], /has no "## Active Backlog" section/);
});

test('a task\'s version is its fields without the status; an edit makes a new one', () => {
  const at = (status, outcome) => B.parse(desk(block('TASK-001', 'Widget size', status, outcome ? { outcome } : {}))).tasks[0].version;
  assert.match(at('[TODO]'), /^[0-9a-f]{64}$/);
  assert.equal(at('[TODO]'), at('[IN_PROGRESS: PR #5]'));
  assert.equal(at('[TODO]'), at('[BLOCKED: Needs Human Architect]'));
  assert.notEqual(at('[TODO]'), at('[TODO]', 'FICTIONAL: the widget size helper ignores tabs and spaces.'));
  // As an issue, the block reads back through the issue form's own check.
  const t = B.parse(TWO).tasks[0];
  const task = G.backlogTaskOf(t, { policy: POLICY });
  assert.deepEqual(task.problems, []);
  assert.equal(task.number, 'TASK-001');
  assert.equal(B.branchOf('TASK-001', POLICY.task_branch_prefix), 'agent/task-001');
  assert.equal(B.idOfBranch('agent/task-001', POLICY.task_branch_prefix), 'TASK-001');
  assert.equal(B.idOfBranch('agent/issue-7', POLICY.task_branch_prefix), null);
  // A template reaches only its own paths: eng-app@4 never reaches core logic.
  const app = G.backlogTaskOf(B.parse(desk(block('TASK-001', 'Widget size', '[TODO]', { template: 'eng-app@4' }))).tasks[0], { policy: POLICY });
  assert.ok(app.problems.some((x) => /dashboard\/core\/fictional-widget\.js is outside eng-app@4/.test(x)));
});

test('strictly in order: the first [TODO] is the next task, and one with problems stops the lane rather than being skipped', () => {
  const tasks = B.parse(desk(block('TASK-001', 'Done', '[DONE]'), block('TASK-002', 'Next', '[TODO]', { outcome: '' }), block('TASK-003', 'Later', '[TODO]'))).tasks;
  assert.equal(B.firstTodo(tasks).id, 'TASK-002');
  const d = PM.decide(state(desk(block('TASK-001', 'Done', '[DONE]'), block('TASK-002', 'Next', '[TODO]', { outcome: '' }), block('TASK-003', 'Later', '[TODO]'))), { policy: POLICY, now: T0 });
  assert.equal(d.action, 'stop');
  assert.equal(d.task, 'TASK-002');
  assert.match(d.why, /TASK-002 is the next task and cannot be built: .*later tasks wait for Eric's edit/);
  assert.equal(PM.decide(state(desk(block('TASK-001', 'Done', '[DONE]'))), { policy: POLICY, now: T0 }).action, 'idle');
});

test('the lock: an open agent/ candidate, a running agent-build or an attempt inside its lease holds the lane; a claude/ branch does not', () => {
  const pr = (ref, repo = REPO) => ({ number: 9, title: 't', head: { ref, sha: HEAD, repo: { full_name: repo } }, html_url: 'https://github.invalid/pr/9' });
  assert.equal(PM.candidateOf(pr('claude/backlog-x'), { repo: REPO, policy: POLICY }), null, 'the routines\' and Eric\'s own branches are not the lane\'s');
  assert.equal(PM.candidateOf(pr('agent/task-001', 'someone/fork'), { repo: REPO, policy: POLICY }), null, 'a fork is never a candidate');
  assert.equal(PM.candidateOf(pr('agent/task-001'), { repo: REPO, policy: POLICY }).task, 'TASK-001');
  assert.equal(PM.candidateOf(pr('agent/issue-7'), { repo: REPO, policy: POLICY }).task, null);
  const go = PM.decide(state(), { policy: POLICY, now: T0 });
  assert.equal(go.action, 'build');
  assert.equal(go.task, 'TASK-001');
  assert.equal(go.version, v1());
  const running = PM.decide(state(TWO, { runs: [{ id: 77, status: 'in_progress' }] }), { policy: POLICY, now: T0 });
  assert.deepEqual([running.action, running.why], ['wait', 'Build in flight (agent-build run 77 is in_progress); skipping run']);
  const open = PM.decide(state(TWO, { entries: [reserve('build', 'bd-1', T0 - 30 * MIN)] }), { policy: POLICY, now: T0 });
  assert.deepEqual([open.action, open.why], ['wait', 'Build in flight (bd-1 of TASK-001 has no outcome yet); skipping run']);
  const issue = PM.decide(state(TWO, { candidates: [{ ...candidate(null), task: null, branch: 'agent/issue-7' }] }), { policy: POLICY, now: T0 });
  assert.equal(issue.action, 'wait');
  assert.equal(issue.eric, true);
  const two = PM.decide(state(TWO, { candidates: [candidate(null), { ...candidate(null), number: 6 }] }), { policy: POLICY, now: T0 });
  assert.match(two.why, /2 agent candidates are open \(#5, #6\)/);
  assert.equal(PM.decide(state(TWO, { errors: ['the open pull requests'] }), { policy: POLICY, now: T0 }).action, 'stop', 'nothing on a partial reading');
});

test('a candidate: wait while checks run, sign off once all four pass, wait for Eric after; checks are GitHub Actions\' only', () => {
  const at = (checks, more) => PM.decide(state(TWO, { candidates: [candidate(checks, more)], pr: candidate(checks, more) }), { policy: POLICY, now: T0 });
  assert.match(at({ ...ALL(), test: 'pending' }).why, /waiting for test \(pending\)/);
  assert.match(at(ALL('missing')).why, /waiting for agent-review \(missing\)/);
  const s = at(ALL());
  assert.deepEqual([s.action, s.pr, s.head], ['signoff', 5, HEAD]);
  assert.equal(at(ALL(), { signedOff: true }).eric, true);
  assert.equal(at({ ...ALL(), 'agent-guard': 'cancelled' }).action, 'stop', 'a cancelled check is Eric\'s');
  const runs = [{ id: 1, name: 'test', status: 'completed', conclusion: 'success', app: { id: 15368 } }, { id: 2, name: 'agent-guard', status: 'completed', conclusion: 'success', app: { id: 999 } }, { id: 3, name: 'agent-verify', status: 'in_progress', app: { id: 15368 } }];
  assert.deepEqual(PM.checkStates(runs), { test: 'success', 'agent-guard': 'missing', 'agent-verify': 'pending', 'agent-review': 'missing' }, 'a check run from another app is not the check');
  assert.equal(PM.signoffMark(HEAD), `<!-- cr-pm-signoff:${HEAD} -->`);
  const body = PM.signoffBody(G.backlogTaskOf(B.parse(TWO).tasks[0], { policy: POLICY }), { pr: 5, head: HEAD, review: null });
  assert.ok(body.startsWith(`${PM.signoffMark(HEAD)}\n## PM Site Inspection: PASSED\n`));
});

test('a failed candidate is diagnosed, then remediated; the third failed remediation blocks it (Needs Human Architect)', () => {
  const failed = { ...ALL(), test: 'failure' };
  const at = (entries) => PM.decide(state(TWO, { entries, candidates: [candidate(failed)], pr: candidate(failed) }), { policy: POLICY, now: T0 });
  const d1 = at([]);
  assert.deepEqual([d1.action, d1.round, d1.subject, d1.pr], ['diagnose', 1, HEAD, 5]);
  assert.match(d1.why, /#5 at c{12}: test failure; diagnose it for remediation 1 of 3/);
  const withDiag = at(diagnosis('dg-1', HEAD, 1));
  assert.deepEqual([withDiag.action, withDiag.round, withDiag.diagnosis], ['remediate', 1, 'dg-1']);
  const rem = (n, state = 'unknown') => [reserve('remediate', `rm-${n}`, T0 - (100 - n) * MIN), outcome(`rm-${n}`, state, { job: 'failure' })];
  const three = [...rem(1), ...rem(2), ...rem(3)];
  const b = at(three);
  assert.equal(b.action, 'block');
  assert.match(b.why, /after 3 remediations of TASK-001 at this version \(ceiling 3\): it needs a human architect/);
  // A block in the ledger stops the version for good; Eric decides.
  const blocked = at([...three, { t: 'blocked', issue: 'TASK-001', task_sha256: v1(), at: new Date(T0).toISOString() }]);
  assert.deepEqual([blocked.action, blocked.eric, blocked.blocked], ['wait', true, true]);
  const noPr = PM.decide(state(TWO, { entries: [{ t: 'blocked', issue: 'TASK-001', task_sha256: v1(), at: new Date(T0).toISOString() }] }), { policy: POLICY, now: T0 });
  assert.deepEqual([noPr.action, noPr.blocked], ['stop', true]);
  assert.match(noPr.why, /TASK-001 is blocked at this version \(Needs Human Architect/);
  // A new version (Eric edits the task) starts clean.
  const edited = desk(block('TASK-001', 'Widget size', '[TODO]', { outcome: 'FICTIONAL: the widget size helper ignores tabs and spaces.' }));
  assert.equal(PM.decide(state(edited, { entries: [...three, { t: 'blocked', issue: 'TASK-001', task_sha256: v1() }] }), { policy: POLICY, now: T0 }).action, 'build');
});

test('a build that published nothing is diagnosed and remediated from its own record', () => {
  const entries = [reserve('build', 'bd-1', T0 - 90 * MIN), outcome('bd-1', 'unknown', { job: 'failure', note: 'FICTIONAL: the named test failed' })];
  const d = PM.decide(state(TWO, { entries }), { policy: POLICY, now: T0 });
  assert.deepEqual([d.action, d.subject, d.round, d.pr], ['diagnose', 'attempt:bd-1', 1, null]);
  assert.match(d.why, /build bd-1 of TASK-001 published nothing \(job failure\)/);
  const published = [reserve('build', 'bd-1', T0 - 90 * MIN), outcome('bd-1', 'response', { job: 'success', publish: 'published' })];
  assert.equal(PM.decide(state(TWO, { entries: published }), { policy: POLICY, now: T0 }).action, 'stop', 'a candidate it published and no pull request open: Eric decides');
});

test('the 60-minute lease: an attempt with no outcome holds the lane 60 minutes, then is orphaned, frees it, and consumes no attempt', () => {
  assert.equal(L.LEASE_TTL_MS, 3600000);
  const open = [reserve('build', 'bd-1', T0)];
  const at = (now, entries = open) => PM.decide(state(TWO, { entries }), { policy: POLICY, now });
  assert.match(at(T0 + 59 * MIN).why, /^Build in flight \(bd-1 of TASK-001 has no outcome yet\)/);
  assert.match(at(T0 + 60 * MIN).why, /^Build in flight/, 'exactly 60 minutes still holds: it expires after');
  const free = at(T0 + 61 * MIN);
  assert.equal(free.action, 'build', 'the queue is unlocked');
  assert.match(free.why, /\(bd-1 orphaned, no outcome within 60 min; no attempt consumed\)/);
  // A failed remediation counts; an orphaned one does not: two that failed
  // and one orphaned leave the third round, never the block.
  const failed = { ...ALL(), test: 'failure' };
  const cand = (entries, now) => PM.decide(state(TWO, { entries, candidates: [candidate(failed)], pr: candidate(failed) }), { policy: POLICY, now });
  const rem = (n, st) => [reserve('remediate', `rm-${n}`, T0 - (200 - n) * MIN), ...(st ? [outcome(`rm-${n}`, st, { job: 'failure' })] : [])];
  const twoFailedOneLost = [...rem(1, 'unknown'), ...rem(2, 'unknown'), ...rem(3, 'orphaned'), ...diagnosis('dg-3', HEAD, 3)];
  const d = cand(twoFailedOneLost, T0);
  assert.deepEqual([d.action, d.round], ['remediate', 3], 'the orphan consumed nothing');
  // Recorded or not: one with no outcome past the lease counts the same.
  assert.deepEqual([cand([...rem(1, 'unknown'), ...rem(2, 'unknown'), ...rem(3, null), ...diagnosis('dg-3', HEAD, 3)], T0).round], [3]);
  // An attempt recorded 'lost' before 2026-10-27 is an orphan too.
  assert.equal(cand([...rem(1, 'unknown'), ...rem(2, 'unknown'), ...rem(3, 'lost'), ...diagnosis('dg-3', HEAD, 3)], T0).round, 3);
  // A real outcome that arrives after it (the runner came back) counts again.
  assert.equal(cand([...rem(1, 'unknown'), ...rem(2, 'unknown'), ...rem(3, 'orphaned'), outcome('rm-3', 'unknown', { job: 'failure' })], T0).action, 'block');
  // Today's builds and dollars still count it, so a runner that keeps dying is bounded.
  const day = Array.from({ length: 6 }, (_, i) => reserve('build', `bd-${i}`, T0 - (90 + i) * MIN)).flatMap((r) => [r, outcome(r.id, 'orphaned')]);
  const capped = PM.decide(state(TWO, { entries: day }), { policy: POLICY, now: T0 });
  assert.equal(capped.action, 'wait');
  assert.match(capped.why, /6 paid builds today/);
});

// A git remote holding the ledger, a checkout of a fictional main, and a fake
// GitHub: the PM's run() records the orphan itself, with the audit line.
const ID = { GIT_AUTHOR_NAME: 'FICTIONAL', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'FICTIONAL', GIT_COMMITTER_EMAIL: 'f@example.invalid' };
const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ID } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return String(r.stdout).trim();
};
function lane(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '-q', '--bare', 'remote.git']);
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  git(work, ['init', '-q']);
  git(work, ['remote', 'add', 'origin', path.join(dir, 'remote.git')]);
  fs.writeFileSync(path.join(work, 'DESK_STATE.md'), TWO);
  git(work, ['add', 'DESK_STATE.md']);
  git(work, ['commit', '-q', '-m', 'FICTIONAL main']);
  const dispatched = [];
  const runs = [{ id: 7, status: 'completed' }];
  const gh = {
    pulls: async () => [],
    workflowRuns: async () => runs,
    dispatch: async (file, ref, inputs) => { dispatched.push({ file, ref, inputs }); return { ok: true, status: 204 }; },
    postComment: async () => { throw new Error('no comment expected'); },
  };
  const ctx = (now, more = {}) => ({ gh, cwd: work, remote: 'origin', env: { GITHUB_REPOSITORY: REPO, AGENT_PM_ENABLED: 'true' }, policy: POLICY, now: () => now, fetchImpl: async () => { throw new Error('no network'); }, ...more });
  return { work, gh, runs, dispatched, ctx };
}

test('run(): past the lease the PM records the attempt orphaned with its audit line, unlocks the queue and dispatches the next build', async (t) => {
  const l = lane(t);
  assert.ok(L.transact(l.work, { decide: () => ({ append: [reserve('build', 'bd-1', T0, { run: '7/1' })] }) }).committed);
  const lines = () => L.read(l.work).entries.map((e) => [e.t, e.id, e.state, e.note]);
  // Inside the lease: in flight, nothing written, nothing dispatched.
  const held = await PM.run(l.ctx(T0 + 59 * MIN));
  assert.equal(held.decision.action, 'wait');
  assert.match(held.says, /^Build in flight \(bd-1 of TASK-001 has no outcome yet\); skipping run$/);
  assert.equal(L.read(l.work).entries.length, 1);
  // Past it, but a dry run, or the PM off: said, never written.
  const dry = await PM.run(l.ctx(T0 + 61 * MIN, { dryRun: true }));
  assert.equal(dry.orphans.recorded, false);
  assert.match(dry.says, /^Would record: Orphaned attempt expired after 60m; unlocking queue: bd-1 \(no outcome 61 min after it was reserved\)\./);
  assert.equal(dry.decision.action, 'build');
  assert.equal(dry.done, 'nothing (dry run)');
  const off = await PM.run(l.ctx(T0 + 61 * MIN, { env: { GITHUB_REPOSITORY: REPO } }));
  assert.equal(off.done, 'off');
  assert.match(off.says, /^Would record: Orphaned attempt expired after 60m; unlocking queue: bd-1/);
  assert.equal(L.read(l.work).entries.length, 1);
  assert.deepEqual(l.dispatched, []);
  // A live agent-build run may still record its own outcome: not orphaned yet.
  l.runs.push({ id: 8, status: 'in_progress' });
  const live = await PM.run(l.ctx(T0 + 61 * MIN));
  assert.equal(live.orphans.recorded, false);
  assert.match(live.says, /not recorded while agent-build run 8 is running/);
  assert.equal(live.decision.action, 'wait');
  assert.equal(L.read(l.work).entries.length, 1);
  l.runs.pop();
  // On: recorded with the audit line, then the queue moves on.
  const on = await PM.run(l.ctx(T0 + 61 * MIN));
  assert.equal(on.orphans.recorded, true);
  assert.deepEqual(lines(), [['reserve', 'bd-1', undefined, undefined], ['outcome', 'bd-1', 'orphaned', 'Orphaned attempt expired after 60m; unlocking queue']]);
  assert.match(on.says, /^Orphaned attempt expired after 60m; unlocking queue: bd-1 \(no outcome 61 min after it was reserved\)\. Dispatched the build of TASK-001: TASK-001 is the first \[TODO\] and has not been built at this version \(bd-1 orphaned, no outcome within 60 min; no attempt consumed\)\.$/);
  assert.deepEqual(l.dispatched, [{ file: 'agent-build.yml', ref: 'main', inputs: { mode: 'task', task: 'TASK-001', pr: '' } }]);
  // Once recorded, never again.
  const again = await PM.run(l.ctx(T0 + 62 * MIN));
  assert.deepEqual(again.orphans.lines, []);
  assert.equal(L.read(l.work).entries.length, 2);
});

test('the corrective prompt and the diagnosis: the PM\'s words, and only the answer\'s safe parts', () => {
  const g = { error: 'FICTIONAL: widget-size › tabs (expected 2, got 3)', files: ['dashboard/core/fictional-widget.js'], case: 'a string with a tab', instructions: 'Skip \\t in sizeOf.\nAdd the tab case to the test.', confidence: 'high', root_cause: 'FICTIONAL: tabs are counted.' };
  const p = PM.correctivePrompt(g, { round: 2 });
  assert.equal(p.split('\n')[0], 'Attempt 2 failed with FICTIONAL: widget-size › tabs (expected 2, got 3). Fix dashboard/core/fictional-widget.js to handle a string with a tab and re-run tests.');
  assert.match(p, /\nWhat to change:\n- Skip \\t in sizeOf\.\n- Add the tab case to the test\.$/);
  assert.equal(PM.normalizeDiagnosis('not json'), null);
  assert.equal(PM.normalizeDiagnosis(JSON.stringify({ error: 'x' })), null, 'no instructions, no diagnosis');
  const n = PM.normalizeDiagnosis(JSON.stringify({ error: 'e', instructions: '1. one\n- two', files: ['dashboard/core/a.js', '../../etc/passwd', 'dashboard/../x', 'ok/b.js'], confidence: 'certain' }));
  assert.deepEqual(n.files, ['dashboard/core/a.js', 'ok/b.js']);
  assert.equal(n.instructions, 'one\ntwo');
  assert.equal(n.confidence, 'low');
});

test('statuses: written only on the candidate\'s branch, and a candidate may change DESK_STATE.md only by those lines', () => {
  const base = desk(block('TASK-001', 'Widget size', '[IN_PROGRESS: PR #4]'), block('TASK-002', 'Widget tabs', '[TODO]'));
  const head = B.statusTransform(base, { id: 'TASK-002', to: { kind: 'in_progress', pr: 6 } });
  assert.deepEqual(B.parse(head).tasks.map((x) => x.status.text), ['[DONE]', '[IN_PROGRESS: PR #6]']);
  assert.deepEqual(B.statusOnly(base, head, { id: 'TASK-002', pr: 6 }), { ok: true, reasons: [] });
  const blocked = B.statusTransform(base, { id: 'TASK-002', to: { kind: 'blocked', reason: B.PM_BLOCK } });
  assert.equal(B.statusOnly(base, blocked, { id: 'TASK-002', pr: 6 }).ok, true);
  assert.equal(B.statusTransform(base, { id: 'TASK-009', to: { kind: 'done' } }), null);
  const refused = (text, why) => {
    const r = B.statusOnly(base, text, { id: 'TASK-002', pr: 6 });
    assert.equal(r.ok, false, why);
    return r.reasons.join('; ');
  };
  assert.match(refused(B.statusTransform(base, { id: 'TASK-002', to: { kind: 'in_progress', pr: 7 } }), 'wrong pull request'), /may only set \[IN_PROGRESS: PR #6\]/);
  assert.match(refused(head.replace('[DONE]', '[TODO]'), 'another task reopened'), /TASK-001 goes from \[IN_PROGRESS: PR #4\] to \[TODO\]/);
  assert.match(refused(head.replace('FICTIONAL: never counts', 'FICTIONAL: sometimes counts'), 'an edited check'), /line \d+ changes, and it is not a task's status line/);
  assert.match(refused(`${head}\n### TASK-003 · More\n- **Status:** [TODO]\n`, 'a new task row'), /gains or loses lines/);
  assert.match(refused(head.replace('FICTIONAL queue, in order.', 'FICTIONAL queue.'), 'any other line'), /line 5 changes/);
  assert.match(refused(B.statusTransform(base, { id: 'TASK-002', to: { kind: 'blocked', reason: 'tired' } }), 'a reason of its own'), /\[BLOCKED: Needs Human Architect\]/);
  assert.equal(B.statusOnly(base, head, { id: 'TASK-002', pr: null }).ok, false, 'before its pull request exists, nothing');
});

// The briefing (agent-status.js) over a state as readLane builds it.
const pull = (n, ref, mergedAt) => ({ number: n, title: `FICTIONAL #${n}`, head: { ref }, merged_at: mergedAt, html_url: `https://github.invalid/pull/${n}` });
test('briefing: completed_today counts agent pull requests merged in the last 24 hours, by merge time; [DONE] rows never count', () => {
  const now = T0;
  const done = desk(block('TASK-001', 'A', '[DONE]'), block('TASK-002', 'B', '[DONE]'), block('TASK-003', 'C', '[DONE]'), block('TASK-004', 'Next', '[TODO]'));
  const closed = [
    pull(10, 'agent/task-003', new Date(now - 23 * 3600000).toISOString()),
    pull(11, 'agent/task-002', new Date(now - 24 * 3600000).toISOString()),
    pull(12, 'agent/task-001', new Date(now - 24 * 3600000 - 1).toISOString()),
    pull(13, 'claude/backlog-x', new Date(now - 3600000).toISOString()),
    pull(14, 'agent/task-004', null),
  ];
  const b = S.briefing({ ...state(done), closed }, { policy: POLICY, now });
  assert.equal(b.format, 'cr-lane-briefing@1');
  assert.deepEqual(b.completed_today.prs.map((p) => [p.number, p.task]), [[10, 'TASK-003'], [11, 'TASK-002']], '24 hours ago exactly counts, a millisecond more does not');
  assert.equal(b.completed_today.count, 2, 'three [DONE] rows, two merges today');
  assert.equal(b.status, 'working');
  assert.deepEqual(b.next_in_queue, { id: 'TASK-004', title: 'Next', template: 'eng-backend@1' });
  assert.equal(b.bullets.length, 3);
  assert.equal(b.bullets[1], 'Done in the last 24 h: #10 TASK-003, #11 TASK-002.');
  assert.equal(S.briefing({ ...state(done), closed: [] }, { policy: POLICY, now }).bullets[1], 'Done in the last 24 h: nothing merged.');
});

test('briefing: a source it cannot read is unknown, never none', () => {
  const b = S.briefing({ ...state(TWO, { errors: ['the open pull requests (HTTP 502)'], backlog: null }), closed: null }, { policy: POLICY, now: T0 });
  assert.equal(b.status, 'unknown');
  assert.equal(b.needs_eric, null);
  assert.equal(b.current_pr, 'unknown');
  assert.equal(b.next_in_queue, 'unknown');
  assert.equal(b.completed_today, null);
  assert.deepEqual(b.unknown, ['the open pull requests (HTTP 502)', 'the pull requests closed lately']);
  assert.match(b.bullets[0], /^Now: unknown \(the open pull requests \(HTTP 502\)\)\.$/);
  assert.equal(b.bullets[1], 'Done in the last 24 h: unknown (the closed pull requests could not be read).');
  assert.equal(b.bullets[2], 'Next: unknown (DESK_STATE.md could not be read).');
  const waiting = S.briefing({ ...state(TWO, { candidates: [candidate(ALL(), { signedOff: true })], pr: candidate(ALL(), { signedOff: true }) }), closed: [] }, { policy: POLICY, now: T0 });
  assert.deepEqual([waiting.status, waiting.needs_eric, waiting.current_pr.number, waiting.current_pr.signed_off], ['waiting_on_eric', true, 5, true]);
  assert.equal(waiting.next_in_queue.id, 'TASK-002', 'the candidate\'s own task is not next');
});
