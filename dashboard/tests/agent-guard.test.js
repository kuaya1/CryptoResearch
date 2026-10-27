'use strict';
// The agent lane's trusted guard (Eric, 2026-10-26;
// audits/2026-10-26-engineering-simplification): only Eric's own label
// authorizes a build, the issue's task stays inside its template, the build's
// patch is applied to main as data and checked again, the publisher commits
// it as the builder App with the task's trailers, and a pull request's
// agent-guard check holds its commits, its task and its change. FICTIONAL
// records in temporary repositories; no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const G = require('../scripts/agent-guard');
const L = require('../scripts/agent-ledger');

const POLICY = G.loadPolicy();
const BOT = { name: 'cr-builder[bot]', email: '1+cr-builder[bot]@users.noreply.github.com' };
const ERIC = { name: 'Eric FICTIONAL', email: 'eric@example.invalid' };
const git = (cwd, args, who = ERIC) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return String(r.stdout).trim();
};
const form = (o) => Object.entries(o).map(([k, v]) => `### ${k}\n\n${v}`).join('\n\n');
const FORM = { Template: 'eng-backend@1', Outcome: 'The widget size helper ignores surrounding spaces.', 'Acceptance checks': '- size of " ab " is 2', 'Negative cases': '- size of null throws', 'Regression tests': 'dashboard/tests/widget.test.js', 'Files to change': '- dashboard/core/widget.js\n- dashboard/tests/widget.test.js', Notes: '_No response_' };
const issueOf = (fields = {}, extra = {}) => ({ number: 7, title: 'Widget size ignores spaces', body: form({ ...FORM, ...fields }), state: 'open', labels: [{ name: 'agent:build' }], ...extra });

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote.git');
  git(dir, ['init', '-q', '--bare', remote]);
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  git(work, ['init', '-q']);
  git(work, ['config', 'core.autocrlf', 'false']);
  git(work, ['remote', 'add', 'origin', remote]);
  fs.mkdirSync(path.join(work, 'dashboard', 'core'), { recursive: true });
  fs.writeFileSync(path.join(work, 'dashboard/core/widget.js'), 'module.exports = { size: (s) => s.length };\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'main']);
  const base = git(work, ['rev-parse', 'HEAD']);
  git(work, ['push', '-q', 'origin', `${base}:refs/heads/main`]);
  // A patch as the build job would hand it over: the working tree's diff.
  const patch = (files) => {
    for (const [p, text] of Object.entries(files)) {
      const abs = path.join(work, p);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (text === null) fs.rmSync(abs); else fs.writeFileSync(abs, text);
    }
    git(work, ['add', '-A']);
    const out = path.join(dir, `patch-${Math.random().toString(16).slice(2)}.diff`);
    fs.writeFileSync(out, spawnSync('git', ['diff', '--cached', '--binary', '--full-index', base], { cwd: work, encoding: 'buffer' }).stdout);
    git(work, ['reset', '-q', '--hard', base]);
    git(work, ['clean', '-qfd']);
    return out;
  };
  return { dir, remote, work, base, patch };
}
// A build reservation in the ledger, as reserve writes it, so publish has a
// head to lease on and a tip to fence.
let RES_N = 0;
function reserveBuild(r, task, run, predecessor, at = '2026-10-26T12:00:00Z') {
  RES_N += 1;
  const id = `bd-${String(RES_N).padStart(16, '0')}`;
  const bind = G.buildBinding(task, r.base, predecessor);
  const w = L.transact(r.work, { decide: () => ({ append: [{ t: 'reserve', kind: 'build', id, binding: L.bindingOf(bind), bind, day: '2026-10-26', usd: 8, run, at }] }) });
  assert.ok(w.committed, w.error);
  return id;
}
const ledgerTip = (r) => git(r.work, ['ls-remote', 'origin', 'refs/heads/agent-ledger']).split(/\s+/)[0];
const branchHead = (r) => git(r.work, ['ls-remote', 'origin', 'refs/heads/agent/issue-7']).split(/\s+/)[0] || 'absent';

const GOOD = { 'dashboard/core/widget.js': 'module.exports = { size: (s) => s.trim().length };\n', 'dashboard/tests/widget.test.js': "require('node:assert').equal(require('../core/widget').size(' ab '), 2);\n" };

test('only Eric\'s own label on an open issue authorizes a build', () => {
  const ev = (o = {}) => ({ action: 'labeled', label: { name: 'agent:build' }, repository: { owner: { login: 'kuaya1' } }, sender: { login: 'kuaya1', type: 'User' }, issue: { number: 7, state: 'open' }, ...o });
  assert.deepEqual(G.authorize(ev(), { policy: POLICY }), []);
  assert.match(G.authorize(ev({ sender: { login: 'cr-builder[bot]', type: 'Bot' } }), { policy: POLICY })[0], /not by the repository owner/);
  assert.match(G.authorize(ev({ sender: { login: 'someone', type: 'User' } }), { policy: POLICY })[0], /not by the repository owner/);
  assert.match(G.authorize(ev({ label: { name: 'bug' } }), { policy: POLICY })[0], /not the agent:build label/);
  assert.match(G.authorize(ev({ issue: { number: 7, state: 'closed' } }), { policy: POLICY })[0], /closed/);
  assert.match(G.authorize(ev({ issue: { number: 7, state: 'open', pull_request: {} } }), { policy: POLICY })[0], /not an issue/);
});

test('the issue\'s task stays inside its template: protected, forbidden and guarded paths are refused at the task', () => {
  const ok = G.taskOf(issueOf(), { policy: POLICY });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.paths, ['dashboard/core/widget.js', 'dashboard/tests/widget.test.js']);
  assert.deepEqual(ok.tests, ['dashboard/tests/widget.test.js']);
  assert.deepEqual(ok.implementation, ['dashboard/server.js', 'dashboard/core/**']);
  const bad = (fields) => G.taskOf(issueOf(fields), { policy: POLICY }).problems.join('\n');
  assert.match(bad({ Template: 'eng-app@4' }), /not one the agent lane builds/);
  assert.match(bad({ 'Files to change': '- .github/workflows/x.yml' }), /outside eng-backend@1/);
  assert.match(bad({ 'Files to change': '- dashboard/core/portfolio.js' }), /never changes|protected path/);
  assert.match(bad({ 'Files to change': '- dashboard/core/**' }), /can reach a protected path/);
  assert.match(bad({ 'Regression tests': 'dashboard/tests/engineering-guard.test.js' }), /guarded test/);
  assert.match(bad({ 'Negative cases': '_No response_' }), /"Negative cases" is empty/);
  assert.match(bad({ Outcome: '_No response_' }), /"Outcome" is empty/);
  // Files and tests are hints (cr.agent-task.v2): none named is no problem.
  const open = G.taskOf(issueOf({ 'Regression tests': 'none', 'Files to change': '_No response_' }), { policy: POLICY });
  assert.deepEqual(open.problems, []);
  assert.deepEqual(open.paths, []);
  assert.deepEqual(open.tests, []);
});

test('a task that names no files or tests is scoped by its template: any file inside it, never a protected or forbidden one, and still a test', (t) => {
  const r = repo(t);
  const open = G.taskOf(issueOf({ 'Files to change': '_No response_', 'Regression tests': '_No response_' }), { policy: POLICY });
  assert.deepEqual(open.problems, []);
  const prompt = G.builderPrompt(open);
  assert.match(prompt, /Files you may change: any file under dashboard\/server\.js, dashboard\/core\/\*\*, dashboard\/tests\/\*\*; never dashboard\/engineering\/\*\*, [^\n]*and never a protected path; at most 20 files, only what the outcome needs/);
  assert.match(prompt, /Regression tests to add or change: none named: add or change at least one test file under dashboard\/tests\//);
  assert.match(prompt, /Work only in the files the task lets you change/);
  const reasonsFor = (task, files) => { const a = G.applyPatch({ cwd: r.work, base: r.base, patchFile: r.patch(files), maxBytes: 600000 }); return a.error ? [a.error] : G.checkChange({ cwd: r.work, base: r.base, rev: a.tree, task }).reasons; };
  assert.deepEqual(reasonsFor(open, GOOD), []);
  assert.deepEqual(reasonsFor(open, { ...GOOD, 'dashboard/core/other.js': 'module.exports = 1;\n' }), [], 'inside the template, no paths named: allowed');
  assert.match(reasonsFor(open, { ...GOOD, 'dashboard/core/portfolio.js': 'module.exports = 1;\n' }).join('\n'), /protected; Eric's own change/);
  assert.match(reasonsFor(open, { ...GOOD, 'dashboard/engineering/x.js': 'module.exports = 1;\n' }).join('\n'), /outside eng-backend@1|forbidden for eng-backend@1/);
  assert.match(reasonsFor(open, { ...GOOD, '.github/workflows/x.yml': 'on: push\n' }).join('\n'), /protected; Eric's own change/);
  assert.match(reasonsFor(open, { 'dashboard/core/widget.js': GOOD['dashboard/core/widget.js'] }).join('\n'), /needs every candidate to add or change a test/);
  // Named paths narrow the scope; a test file the template requires is inside it unnamed.
  const narrow = G.taskOf(issueOf({ 'Files to change': '- dashboard/core/widget.js', 'Regression tests': '_No response_' }), { policy: POLICY });
  assert.deepEqual(narrow.problems, []);
  assert.match(G.builderPrompt(narrow), /Files you may change: dashboard\/core\/widget\.js\n/);
  assert.deepEqual(reasonsFor(narrow, GOOD), []);
  assert.match(reasonsFor(narrow, { ...GOOD, 'dashboard/core/other.js': 'module.exports = 1;\n' }).join('\n'), /other\.js is not among the task's files to change/);
  // The named task keeps its words.
  const named = G.taskOf(issueOf(), { policy: POLICY });
  assert.match(G.builderPrompt(named), /Regression tests to add or change: dashboard\/tests\/widget\.test\.js\nFiles you may change: dashboard\/core\/widget\.js, dashboard\/tests\/widget\.test\.js\n/);
});

test('the build\'s patch is applied to main as data and checked again as a tree', (t) => {
  const r = repo(t);
  const task = G.taskOf(issueOf(), { policy: POLICY });
  const good = G.applyPatch({ cwd: r.work, base: r.base, patchFile: r.patch(GOOD), maxBytes: 600000 });
  assert.match(good.tree, /^[0-9a-f]{40}$/);
  const ch = G.checkChange({ cwd: r.work, base: r.base, rev: good.tree, task });
  assert.deepEqual(ch.reasons, []);
  assert.deepEqual(ch.files.sort(), ['dashboard/core/widget.js', 'dashboard/tests/widget.test.js']);
  const reasonsFor = (files) => { const a = G.applyPatch({ cwd: r.work, base: r.base, patchFile: r.patch(files), maxBytes: 600000 }); return a.error || G.checkChange({ cwd: r.work, base: r.base, rev: a.tree, task }).reasons.join('\n'); };
  assert.match(reasonsFor({ ...GOOD, '.github/workflows/x.yml': 'on: push\n' }), /protected; Eric's own change/);
  assert.match(reasonsFor({ ...GOOD, 'dashboard/core/other.js': 'module.exports = 1;\n' }), /not among the task's files to change/);
  assert.match(reasonsFor({ 'dashboard/core/widget.js': GOOD['dashboard/core/widget.js'] }), /needs every candidate to add or change a test/);
  assert.match(reasonsFor({ ...GOOD, 'dashboard/core/blob.bin': Buffer.from([0, 1, 2, 255, 0, 3]) }), /binary change/);
  const stale = path.join(r.dir, 'stale.diff');
  fs.writeFileSync(stale, fs.readFileSync(r.patch(GOOD), 'utf8').replace('s.length', 's.size'));
  assert.match(G.applyPatch({ cwd: r.work, base: r.base, patchFile: stale, maxBytes: 600000 }).error, /does not apply to main/);
  assert.match(G.applyPatch({ cwd: r.work, base: r.base, patchFile: r.patch(GOOD), maxBytes: 10 }).error, /over 10/);
});

test('the publisher commits the tree as the builder with the task\'s trailers, and the pull request\'s check holds it', async (t) => {
  const r = repo(t);
  const issue = issueOf();
  const task = G.taskOf(issue, { policy: POLICY });
  const { tree } = G.applyPatch({ cwd: r.work, base: r.base, patchFile: r.patch(GOOD), maxBytes: 600000 });
  const pub = (run, predecessor) => G.publish({ cwd: r.work, base: r.base, tree, task, run, botName: BOT.name, botEmail: BOT.email, branch: 'agent/issue-7', reservation: reserveBuild(r, task, run, predecessor), policy: POLICY });
  const p = pub('42/1', 'absent');
  assert.equal(p.error, undefined);
  assert.equal(p.replaced, null);
  assert.equal(branchHead(r), p.commit);
  // The branch and its publishing line went up in one push.
  const line = L.read(r.work).entries.at(-1);
  assert.deepEqual([line.t, line.commit, line.branch, line.predecessor, line.run], ['publishing', p.commit, 'agent/issue-7', 'absent', '42/1']);
  const [c] = G.commitsOf(r.work, r.base, p.commit);
  assert.equal(c.author, `${BOT.name} <${BOT.email}>`);
  assert.deepEqual(G.trailersOf(c.body), { issue: 7, task_sha256: task.body_sha256, template: 'eng-backend@1', run: '42/1' });
  const check = (o = {}) => G.prCheck({ cwd: r.work, base: r.base, head: p.commit, branch: 'agent/issue-7', author: 'cr-builder[bot]', botLogin: 'cr-builder[bot]', issueOf: async () => issue, policy: POLICY, ...o });
  const held = await check();
  assert.deepEqual(held.reasons, []);
  assert.equal(held.agent, true);
  // A rebuild replaces the branch by lease on the head its reservation
  // recorded; a second build from that same head finds it moved: stale.
  const again = pub('43/1', p.commit);
  assert.equal(again.replaced, p.commit);
  const late = pub('44/1', p.commit);
  assert.equal(late.stale, true);
  assert.match(late.error, new RegExp(`agent/issue-7 moved after this build was reserved: it was ${p.commit.slice(0, 12)} and is now ${again.commit.slice(0, 12)}; this build is not published and is not retried`));
  assert.match(pub('45/1', 'absent').error, new RegExp(`it was absent and is now ${again.commit.slice(0, 12)}`));
  assert.match(pub('46/1', undefined).error, /no recorded head of agent\/issue-7 to lease on/);
  assert.equal(branchHead(r), again.commit, 'the first build from that head stands');
  // Without a reservation in the ledger nothing is pushed.
  assert.match(G.publish({ cwd: r.work, base: r.base, tree, task, run: '47/1', botName: BOT.name, botEmail: BOT.email, branch: 'agent/issue-7', reservation: 'bd-ffffffffffffffff', policy: POLICY }).error, /reservation bd-ffffffffffffffff is not in the ledger/);
  assert.equal(branchHead(r), again.commit);

  assert.match((await check({ issueOf: async () => ({ ...issue, labels: [] }) })).reasons.join('\n'), /no longer has the agent:build label/);
  assert.match((await check({ issueOf: async () => ({ ...issue, body: `${issue.body}\nFICTIONAL edit` }) })).reasons.join('\n'), /was edited after this build/);
  // Someone else's commit on the agent branch.
  fs.writeFileSync(path.join(r.work, 'x.txt'), 'x\n');
  git(r.work, ['checkout', '-q', p.commit]);
  fs.writeFileSync(path.join(r.work, 'dashboard/core/widget.js'), 'module.exports = { size: () => 0 };\n');
  git(r.work, ['commit', '-q', '-am', 'tweak']);
  const foreign = git(r.work, ['rev-parse', 'HEAD']);
  assert.match((await check({ head: foreign })).reasons.join('\n'), /is not the builder App's/);
  // GitHub's "Update branch": a merge of main that adds nothing of its own.
  git(r.work, ['checkout', '-q', r.base]);
  fs.writeFileSync(path.join(r.work, 'README.md'), 'main moved\n');
  git(r.work, ['add', 'README.md']);
  git(r.work, ['commit', '-q', '-m', 'main moves']);
  const main2 = git(r.work, ['rev-parse', 'HEAD']);
  git(r.work, ['checkout', '-q', p.commit]);
  git(r.work, ['merge', '-q', '--no-ff', '--no-edit', main2]);
  const merged = git(r.work, ['rev-parse', 'HEAD']);
  assert.deepEqual((await check({ base: main2, head: merged })).reasons, []);
});

test('an owner change is not an agent candidate; any builder trace makes it one', async (t) => {
  const r = repo(t);
  fs.writeFileSync(path.join(r.work, 'dashboard/core/widget.js'), 'module.exports = { size: (s) => s.length + 0 };\n');
  git(r.work, ['commit', '-q', '-am', 'Eric\'s change']);
  const head = git(r.work, ['rev-parse', 'HEAD']);
  const owner = await G.prCheck({ cwd: r.work, base: r.base, head, branch: 'eric/widget', author: 'kuaya1', botLogin: 'cr-builder[bot]', issueOf: async () => null, policy: POLICY });
  assert.equal(owner.agent, false);
  assert.equal(owner.ok, true);
  for (const o of [{ branch: 'agent/whatever' }, { author: 'cr-builder[bot]' }]) {
    const r2 = await G.prCheck({ cwd: r.work, base: r.base, head, branch: 'eric/widget', author: 'kuaya1', botLogin: 'cr-builder[bot]', issueOf: async () => null, policy: POLICY, ...o });
    assert.equal(r2.agent, true);
    assert.equal(r2.ok, false);
  }
});

test('a patch or a builder report that holds a key-shaped string is refused, naming the file and line, never the value', async (t) => {
  const r = repo(t);
  // FICTIONAL, assembled at run time so this file holds no key.
  const key = ['sk', 'ant', `api03-${'Q7x'.repeat(30)}`].join('-');
  const leaky = { ...GOOD, 'dashboard/core/widget.js': `module.exports = { size: (s) => s.trim().length };\nconst k = '${key}';\n` };
  const a = G.applyPatch({ cwd: r.work, base: r.base, patchFile: r.patch(leaky), maxBytes: 600000 });
  assert.match(a.error, /key-shaped string at dashboard\/core\/widget\.js:2 \(an Anthropic key\)/);
  assert.ok(!a.error.includes(key));
  assert.equal(a.tree, undefined, 'no tree is made');
  // The apply command reads the builder's report too.
  const outFile = path.join(r.dir, 'gh-output');
  const event = path.join(r.dir, 'event.json');
  fs.writeFileSync(event, JSON.stringify({ issue: issueOf() }));
  const report = path.join(r.dir, 'result.json');
  fs.writeFileSync(report, JSON.stringify({ result: `Done. The key was ${key}.` }));
  const before = { out: process.env.GITHUB_OUTPUT, sum: process.env.GITHUB_STEP_SUMMARY };
  process.env.GITHUB_OUTPUT = outFile;
  delete process.env.GITHUB_STEP_SUMMARY;
  t.after(() => { if (before.out === undefined) delete process.env.GITHUB_OUTPUT; else process.env.GITHUB_OUTPUT = before.out; if (before.sum !== undefined) process.env.GITHUB_STEP_SUMMARY = before.sum; });
  const said = [];
  t.mock.method(process.stdout, 'write', (s) => { said.push(String(s)); return true; });
  const patch = r.patch(GOOD);
  assert.equal(await G.main(['apply', '--event', event, '--base', r.base, '--patch', patch, '--build', report], { cwd: r.work }), 1);
  assert.match(said.join(''), /report holds a key-shaped string at result\.json:1 \(an Anthropic key\)/);
  assert.ok(!said.join('').includes(key) && !fs.readFileSync(outFile, 'utf8').includes(key));
  fs.writeFileSync(report, JSON.stringify({ result: 'Done.', total_cost_usd: 1.5 }));
  fs.writeFileSync(outFile, '');
  assert.equal(await G.main(['apply', '--event', event, '--base', r.base, '--patch', patch, '--build', report], { cwd: r.work }), 0);
  assert.match(fs.readFileSync(outFile, 'utf8'), /^ok=true\ntree=[0-9a-f]{40}\n$/);
});

// The reserve command against a FICTIONAL GitHub (the issue as the fake holds
// it now) and the ledger on the local bare remote.
const flatOf = (file) => Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
function reserver(t, r) {
  const outFile = path.join(r.dir, 'gh-output-reserve');
  const before = { out: process.env.GITHUB_OUTPUT, sum: process.env.GITHUB_STEP_SUMMARY };
  process.env.GITHUB_OUTPUT = outFile;
  delete process.env.GITHUB_STEP_SUMMARY;
  t.after(() => { if (before.out === undefined) delete process.env.GITHUB_OUTPUT; else process.env.GITHUB_OUTPUT = before.out; if (before.sum !== undefined) process.env.GITHUB_STEP_SUMMARY = before.sum; });
  const said = [];
  t.mock.method(process.stdout, 'write', (s) => { said.push(String(s)); return true; });
  const event = path.join(r.dir, 'event-labeled.json');
  const asked = [];
  return async ({ live, run, base = r.base, at = '2026-10-26T12:00:00Z', issue = issueOf(), runs = {} }) => {
    fs.writeFileSync(event, JSON.stringify({ action: 'labeled', label: { name: 'agent:build' }, repository: { owner: { login: 'kuaya1' } }, sender: { login: 'kuaya1', type: 'User' }, issue }));
    fs.writeFileSync(outFile, '');
    said.length = 0;
    const fetchImpl = async (url, o) => {
      asked.push(url);
      assert.equal(o.headers.authorization, 'Bearer FICTIONAL-token');
      const m = /^https:\/\/api\.github\.com\/repos\/kuaya1\/CryptoResearch\/actions\/runs\/(\d+)\/attempts\/(\d+)$/.exec(url);
      if (m) { const st = runs[`${m[1]}/${m[2]}`]; return { status: st ? 200 : 404, text: async () => JSON.stringify(st || { message: 'Not Found' }) }; }
      assert.equal(url, 'https://api.github.com/repos/kuaya1/CryptoResearch/issues/7');
      assert.equal(o.headers.authorization, 'Bearer FICTIONAL-token');
      return { status: live ? 200 : 404, text: async () => JSON.stringify(live || { message: 'Not Found' }) };
    };
    const [id, attempt] = run.split('/');
    const code = await G.main(['reserve', '--event', event, '--base', base], { cwd: r.work, fetchImpl, env: { GH_TOKEN: 'FICTIONAL-token', GITHUB_REPOSITORY: 'kuaya1/CryptoResearch', GITHUB_RUN_ID: id, GITHUB_RUN_ATTEMPT: attempt }, now: () => Date.parse(at) });
    return { code, flat: flatOf(outFile), said: said.join(''), asked };
  };
}
// The record job: the build's outcome, as the workflow reports it.
const record = (r, id, outcome, publish) => G.main(['record', '--id', id, '--outcome', outcome, ...(publish ? ['--publish', publish] : [])], { cwd: r.work, now: () => Date.parse('2026-10-26T12:30:00Z') });

test('reserve reads the issue again: an edit, a removed label or a closed issue since the event builds nothing', async (t) => {
  const r = repo(t);
  const reserve = reserver(t, r);
  const issue = issueOf();
  const version = G.taskOf(issue, { policy: POLICY }).body_sha256;
  const edited = { ...issue, body: `${issue.body}\n\nFICTIONAL edit after the label` };
  const e = await reserve({ live: edited, run: '10/1' });
  assert.equal(e.code, 0);
  assert.equal(e.flat.ok, 'false');
  assert.match(e.said, new RegExp(`event carries version ${version.slice(0, 12)}, the issue now reads ${G.taskOf(edited, { policy: POLICY }).body_sha256.slice(0, 12)}`));
  assert.match((await reserve({ live: { ...issue, labels: [] }, run: '11/1' })).said, /issue #7 no longer has the agent:build label/);
  assert.match((await reserve({ live: { ...issue, state: 'closed' }, run: '12/1' })).said, /issue #7 is closed now/);
  assert.match((await reserve({ live: null, run: '13/1' })).said, /issue #7 could not be read from GitHub now; nothing is built/);
  assert.equal(L.read(r.work).entries.length, 0, 'nothing reserved, nothing spent');
});

test('an unchanged rerun is reserved and counts toward the two builds of that version, whichever main it starts from', async (t) => {
  const r = repo(t);
  const reserve = reserver(t, r);
  const issue = issueOf();
  const first = await reserve({ live: issue, run: '20/1' });
  assert.equal(first.flat.ok, 'true');
  assert.match(first.flat.reservation, /^bd-[0-9a-f]{16}$/);
  assert.equal(first.asked.length, 1, 'the issue was read from GitHub');
  // GitHub's "Re-run all jobs" after the first attempt failed and its record
  // job wrote the outcome: the same event, a new attempt.
  assert.equal(await record(r, first.flat.reservation, 'failure'), 0);
  const rerun = await reserve({ live: issue, run: '20/2' });
  assert.equal(rerun.flat.ok, 'true');
  assert.notEqual(rerun.flat.reservation, first.flat.reservation);
  assert.equal(await record(r, rerun.flat.reservation, 'success'), 0);
  // Main moves; the third build of the same version is still refused.
  fs.writeFileSync(path.join(r.work, 'README.md'), 'main moved\n');
  git(r.work, ['add', 'README.md']);
  git(r.work, ['commit', '-q', '-m', 'main moves']);
  const third = await reserve({ live: issue, run: '21/1', base: git(r.work, ['rev-parse', 'HEAD']) });
  assert.equal(third.flat.ok, 'false');
  assert.match(third.said, /2 paid builds for this version of the task already \(ceiling 2\)/);
  const reserves = L.read(r.work).entries.filter((x) => x.t === 'reserve');
  assert.deepEqual(reserves.map((x) => [x.run, x.bind.issue, x.bind.task_sha256]), [['20/1', 7, first.flat.task_sha256], ['20/2', 7, first.flat.task_sha256]]);
});

test('one build per issue at a time: GitHub\'s run status decides first, age only when it cannot say; a lost build still counts', async (t) => {
  const r = repo(t);
  const reserve = reserver(t, r);
  const issue = issueOf();
  const first = await reserve({ live: issue, run: '30/1' });
  assert.equal(first.flat.ok, 'true');
  assert.equal(first.flat.predecessor, 'absent');
  const running = { status: 'in_progress', conclusion: null, created_at: '2026-10-26T11:59:30Z', run_started_at: '2026-10-26T12:00:00Z' };
  // Still running past the 65 minutes: GitHub's word holds the issue.
  const held = await reserve({ live: issue, run: '31/1', at: '2026-10-26T13:30:00Z', runs: { '30/1': running } });
  assert.equal(held.flat.ok, 'false');
  assert.match(held.said, new RegExp(`build ${first.flat.reservation} of issue #7 \\(run 30/1\\) has no outcome yet: its run is in_progress \\(90 min\\); one build or revision per issue at a time`));
  assert.ok(held.asked.includes('https://api.github.com/repos/kuaya1/CryptoResearch/actions/runs/30/attempts/1'), 'the run attempt itself was read');
  // Running past GitHub's six-hour limit for a hosted job: closed as lost.
  const stuck = await reserve({ live: issue, run: '31/2', at: '2026-10-26T18:00:00Z', runs: { '30/1': running } });
  assert.equal(stuck.flat.ok, 'true');
  assert.match(stuck.said, new RegExp(`Settled first: ${first.flat.reservation} recorded lost \\(its run 30/1 was still in_progress 360 min after it started, past GitHub's 360-minute limit for a hosted job\\)`));
  assert.equal(await record(r, stuck.flat.reservation, 'failure'), 0);
  assert.equal(L.read(r.work).entries.filter((e) => e.t === 'reserve').length, 2, 'the lost build still counts');
  assert.match((await reserve({ live: issue, run: '33/1', at: '2026-10-26T18:10:00Z' })).said, /2 paid builds for this version of the task already/);
});

test('a run that ended without an outcome frees its issue at once; with its publishing line it is recorded published, never lost; unreadable, the 65-minute age decides', async (t) => {
  const r = repo(t);
  const reserve = reserver(t, r);
  const issue = issueOf();
  const v2 = issueOf({ Outcome: 'FICTIONAL: the widget size helper ignores tabs too.' });
  const a = await reserve({ live: issue, run: '40/1' });
  // The run failed in minute 2 and its record job never ran: no 63-minute wait.
  const done = await reserve({ live: issue, run: '41/1', at: '2026-10-26T12:03:00Z', runs: { '40/1': { status: 'completed', conclusion: 'failure', created_at: '2026-10-26T12:00:00Z' } } });
  assert.equal(done.flat.ok, 'true');
  assert.match(done.said, new RegExp(`Settled first: ${a.flat.reservation} recorded lost \\(its run 40/1 completed \\(failure\\) with no outcome recorded\\)`));
  const lost = L.read(r.work).entries.find((e) => e.t === 'outcome' && e.id === a.flat.reservation);
  assert.deepEqual([lost.state, lost.via], ['lost', 'run-status']);
  // That build published (its line went up with its branch) and then its
  // record job failed: it is recorded as published.
  const { tree } = G.applyPatch({ cwd: r.work, base: r.base, patchFile: r.patch(GOOD), maxBytes: 600000 });
  const p = G.publish({ cwd: r.work, base: r.base, tree, task: G.taskOf(issue, { policy: POLICY }), run: '41/1', botName: BOT.name, botEmail: BOT.email, branch: 'agent/issue-7', reservation: done.flat.reservation, policy: POLICY });
  assert.equal(p.error, undefined);
  const next = await reserve({ live: v2, issue: v2, run: '42/1', at: '2026-10-26T12:50:00Z', runs: { '41/1': { status: 'completed', conclusion: 'cancelled', created_at: '2026-10-26T12:03:00Z' } } });
  assert.equal(next.flat.ok, 'true');
  assert.equal(next.flat.predecessor, p.commit);
  assert.match(next.said, new RegExp(`${done.flat.reservation} recorded as published`));
  const settled = L.read(r.work).entries.find((e) => e.t === 'outcome' && e.id === done.flat.reservation);
  assert.deepEqual([settled.state, settled.publish, settled.commit], ['response', 'published', p.commit]);
  // GitHub cannot say (404): the age decides, 64 minutes held and 65 free.
  const young = await reserve({ live: v2, issue: v2, run: '43/1', at: '2026-10-26T13:54:00Z' });
  assert.match(young.said, new RegExp(`build ${next.flat.reservation} of issue #7 \\(run 42/1\\) has no outcome yet: its run's status could not be read and it is 64 min old, so it is held up to 65 min`));
  const old = await reserve({ live: v2, issue: v2, run: '44/1', at: '2026-10-26T13:55:00Z' });
  assert.equal(old.flat.ok, 'true');
  assert.match(old.said, /recorded lost \(no outcome 65 min after it was reserved, and its run's status could not be read\)/);
});

test('publish leases on the head its reservation recorded: a branch made, moved or handed to a later build since is stale, never overwritten', async (t) => {
  const r = repo(t);
  const reserve = reserver(t, r);
  const outFile = process.env.GITHUB_OUTPUT;
  const { tree } = G.applyPatch({ cwd: r.work, base: r.base, patchFile: r.patch(GOOD), maxBytes: 600000 });
  const event = path.join(r.dir, 'event-publish.json');
  const publish = async (reservation, run, issue = issueOf()) => {
    fs.writeFileSync(event, JSON.stringify({ issue }));
    fs.writeFileSync(outFile, '');
    const code = await G.main(['publish', '--event', event, '--base', r.base, '--tree', tree, '--reservation', reservation, '--run', run, '--bot-name', BOT.name, '--bot-email', BOT.email, '--body-out', path.join(r.dir, 'body.md'), '--run-url', 'https://example.invalid/run'], { cwd: r.work });
    return { code, flat: flatOf(outFile) };
  };
  const head = () => branchHead(r);
  const a = await reserve({ live: issueOf(), run: '50/1' });
  assert.equal(a.flat.predecessor, 'absent');
  // Eric pushes the branch himself while the build runs.
  git(r.work, ['push', '-q', 'origin', `${r.base}:refs/heads/agent/issue-7`]);
  const s = await publish(a.flat.reservation, '50/1');
  assert.equal(s.code, 0);
  assert.equal(s.flat.state, 'stale');
  assert.equal(s.flat.ok, 'false');
  assert.match(s.flat.note, new RegExp(`agent/issue-7 moved after this build was reserved: it was absent and is now ${r.base.slice(0, 12)}`));
  assert.equal(head(), r.base, 'his branch is untouched');
  assert.ok(!L.read(r.work).entries.some((e) => e.t === 'publishing'), 'a refused push wrote no publishing line either');
  assert.equal(await record(r, a.flat.reservation, 'success', s.flat.state), 0);
  assert.equal(L.read(r.work).entries.at(-1).publish, 'stale');
  // The next build records his head and replaces it by lease.
  const b = await reserve({ live: issueOf(), run: '51/1' });
  assert.equal(b.flat.predecessor, r.base);
  const ok = await publish(b.flat.reservation, '51/1');
  assert.equal(ok.flat.state, 'published');
  assert.equal(head(), ok.flat.commit);
  await record(r, b.flat.reservation, 'success', 'published');
  // A reservation of another issue version, or none, publishes nothing.
  const edited = issueOf({ Outcome: 'FICTIONAL: the widget size helper ignores tabs too.' });
  const wrong = await publish(b.flat.reservation, '51/1', edited);
  assert.equal(wrong.code, 1);
  assert.match(fs.readFileSync(outFile, 'utf8'), /state=failed/);
  assert.equal((await publish('bd-0000000000000000', '52/1')).code, 1);
  // A build recorded lost while it still ran is stale even when its lease would hold.
  const c = await reserve({ live: edited, issue: edited, run: '60/1' });
  const d = await reserve({ live: edited, issue: edited, run: '61/1', at: '2026-10-26T13:10:00Z' });
  assert.equal(c.flat.predecessor, ok.flat.commit);
  assert.equal(d.flat.predecessor, ok.flat.commit);
  const gone = await publish(c.flat.reservation, '60/1', edited);
  assert.equal(gone.flat.state, 'stale');
  assert.match(gone.flat.note, /was recorded lost \(no outcome 70 min after it was reserved, and its run's status could not be read\) and the issue went to a later build/);
  assert.equal(head(), ok.flat.commit);
  assert.equal((await publish(d.flat.reservation, '61/1', edited)).flat.state, 'published');
});

// Pipeline review, 2026-10-27, step 2: publish moves the candidate branch and
// the ledger in one atomic push, each by lease, so a reserve that lands
// between publish's read and its push is never overtaken.
test('publish is one atomic push of the branch and its ledger line: a ledger that moved is read again, a build recorded lost meanwhile is stale, and nothing goes up by halves', (t) => {
  const r = repo(t);
  // Every commit made in one second (CI on Linux, 2026-10-27: PR #56's first
  // run): a later build of the same tree, base and message is the very
  // commit the branch already holds, so "the branch holds my commit" is no
  // proof that this push landed. Pinned here so the case runs on every PC.
  const dates = { GIT_AUTHOR_DATE: process.env.GIT_AUTHOR_DATE, GIT_COMMITTER_DATE: process.env.GIT_COMMITTER_DATE };
  process.env.GIT_AUTHOR_DATE = process.env.GIT_COMMITTER_DATE = '2026-10-26T12:00:00Z';
  t.after(() => { for (const [k, v] of Object.entries(dates)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const task = G.taskOf(issueOf(), { policy: POLICY });
  const { tree } = G.applyPatch({ cwd: r.work, base: r.base, patchFile: r.patch(GOOD), maxBytes: 600000 });
  const pub = (reservation, beforePush = null) => G.publish({ cwd: r.work, base: r.base, tree, task, run: '90/1', botName: BOT.name, botEmail: BOT.email, branch: 'agent/issue-7', reservation, policy: POLICY, beforePush });
  // Another line lands on the ledger after publish read it (a review's
  // reservation): the whole push is refused, neither ref moves, and the
  // second try publishes.
  const a = reserveBuild(r, task, '90/1', 'absent');
  const tips = [];
  const once = pub(a, (i) => {
    tips.push([i, branchHead(r)]);
    if (i === 0) assert.ok(L.transact(r.work, { decide: () => ({ append: [{ t: 'reserve', kind: 'review', id: 'rv-00000000000000aa', binding: 'r'.repeat(64), day: '2026-10-26', tokens: 1, run: 'rv/1', at: '2026-10-26T12:01:00Z' }] }) }).committed);
  });
  assert.equal(once.error, undefined);
  assert.deepEqual(tips, [[0, 'absent'], [1, 'absent']], 'the first push wrote nothing');
  assert.equal(branchHead(r), once.commit);
  assert.deepEqual(L.read(r.work).entries.slice(-2).map((e) => [e.t, e.id]), [['reserve', 'rv-00000000000000aa'], ['publishing', a]]);
  // The same reservation published again (a re-run of the job): the same commit, no new line.
  const lines = L.read(r.work).entries.length;
  const again = pub(a);
  assert.deepEqual([again.commit, again.again], [once.commit, true]);
  assert.equal(L.read(r.work).entries.length, lines);
  // A reserve records this build lost between publish's read and its push:
  // the ledger's lease fails the push, the read again finds it lost, stale.
  const b = reserveBuild(r, task, '91/1', once.commit);
  const tipBefore = ledgerTip(r);
  const late = pub(b, (i) => {
    if (i === 0) assert.ok(L.transact(r.work, { decide: () => ({ append: [{ t: 'outcome', id: b, state: 'lost', error: 'FICTIONAL: freed for a later build', at: '2026-10-26T13:10:00Z' }] }) }).committed);
  });
  assert.equal(late.stale, true);
  assert.match(late.error, new RegExp(`build ${b} was recorded lost \\(FICTIONAL: freed for a later build\\)`));
  assert.equal(branchHead(r), once.commit, 'the candidate branch did not move');
  assert.notEqual(ledgerTip(r), tipBefore);
  assert.ok(!L.read(r.work).entries.some((e) => e.t === 'publishing' && e.id === b), 'and no publishing line went up');
  // The branch moved after reserve (Eric's push): the ledger's half is
  // refused with it.
  const c = reserveBuild(r, task, '92/1', once.commit);
  git(r.work, ['push', '-q', '-f', 'origin', `${r.base}:refs/heads/agent/issue-7`]);
  const tip = ledgerTip(r);
  const moved = pub(c);
  assert.equal(moved.stale, true);
  assert.equal(ledgerTip(r), tip, 'the ledger did not move either');
  assert.equal(branchHead(r), r.base);
});
