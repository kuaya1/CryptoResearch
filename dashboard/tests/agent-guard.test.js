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
  assert.match(bad({ 'Regression tests': 'none' }), /names no test file/);
  assert.match(bad({ 'Regression tests': 'dashboard/tests/engineering-guard.test.js' }), /guarded test/);
  assert.match(bad({ 'Negative cases': '_No response_' }), /"Negative cases" is empty/);
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
  const p = G.publish({ cwd: r.work, base: r.base, tree, task, run: '42/1', botName: BOT.name, botEmail: BOT.email, branch: 'agent/issue-7', policy: POLICY });
  assert.equal(p.error, undefined);
  assert.equal(p.replaced, null);
  assert.equal(git(r.work, ['ls-remote', 'origin', 'refs/heads/agent/issue-7']).split(/\s+/)[0], p.commit);
  const [c] = G.commitsOf(r.work, r.base, p.commit);
  assert.equal(c.author, `${BOT.name} <${BOT.email}>`);
  assert.deepEqual(G.trailersOf(c.body), { issue: 7, task_sha256: task.body_sha256, template: 'eng-backend@1', run: '42/1' });
  const check = (o = {}) => G.prCheck({ cwd: r.work, base: r.base, head: p.commit, branch: 'agent/issue-7', author: 'cr-builder[bot]', botLogin: 'cr-builder[bot]', issueOf: async () => issue, policy: POLICY, ...o });
  const held = await check();
  assert.deepEqual(held.reasons, []);
  assert.equal(held.agent, true);
  // A rebuild replaces the branch by lease.
  const again = G.publish({ cwd: r.work, base: r.base, tree, task, run: '43/1', botName: BOT.name, botEmail: BOT.email, branch: 'agent/issue-7', policy: POLICY });
  assert.equal(again.replaced, p.commit);

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
