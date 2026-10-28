'use strict';
// The release gate (hardening P1, 2026-10-27; agent-gate.js): the required
// jobs read from the Actions API by main's workflow files, Eric's receipts
// and the ledger's signed verdicts; never a check by its name, never a run of
// a workflow file the pull request added or changed. Fake GitHub API, a local
// bare repository for GitHub's Git, FICTIONAL records only; no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('../scripts/agent-ledger');
const GATE = require('../scripts/agent-gate');

const ROOT = path.join(__dirname, '..', '..');
const REPO = 'kuaya1/CryptoResearch';
const GATE_APP = 424242;
const ENV = { GITHUB_REPOSITORY: REPO, GITHUB_REPOSITORY_OWNER: 'kuaya1', GITHUB_TOKEN: 'ghs_FICTIONAL_read', GATE_TOKEN: 'ghs_FICTIONAL_gate', GATE_APP_ID: String(GATE_APP), AGENT_LEDGER_KEY: `FICTIONAL-ledger-key-${'k'.repeat(24)}` };
const ERIC = { name: 'Eric FICTIONAL', email: 'eric@example.invalid' };

function git(cwd, args, who = ERIC) {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return String(r.stdout).trim();
}

// main with a widget, and pull request #3 changing it (and `edits`, files of
// its own such as a workflow definition).
function fixture(t, { edits = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote.git');
  git(dir, ['init', '-q', '--bare', remote]);
  const src = path.join(dir, 'src');
  fs.mkdirSync(src);
  git(src, ['init', '-q']);
  const put = (p, text) => { fs.mkdirSync(path.dirname(path.join(src, p)), { recursive: true }); fs.writeFileSync(path.join(src, p), text); };
  put('dashboard/core/widget.js', "'use strict';\nmodule.exports = { size: (s) => s.length };\n");
  put('.github/workflows/agent-checks.yml', 'name: agent-checks\n');
  git(src, ['add', '-A']);
  git(src, ['commit', '-q', '-m', 'main']);
  const fx = { main: git(src, ['rev-parse', 'HEAD']) };
  put('dashboard/core/widget.js', "'use strict';\nmodule.exports = { size: (s) => (s === '' ? 0 : s.length) };\n");
  for (const [p, text] of edits) put(p, text);
  git(src, ['add', '-A']);
  git(src, ['commit', '-q', '-m', 'the change']);
  fx.head = git(src, ['rev-parse', 'HEAD']);
  git(src, ['push', '-q', remote, `${fx.main}:refs/heads/main`, `${fx.head}:refs/heads/change`, `${fx.head}:refs/pull/3/head`]);
  let n = 0;
  fx.runner = () => { const w = path.join(dir, `runner-${n += 1}`); fs.mkdirSync(w); git(w, ['init', '-q']); git(w, ['remote', 'add', 'origin', remote]); return w; };
  fx.pull = { number: 3, state: 'open', head: { sha: fx.head, ref: 'change' }, base: { ref: 'main' }, user: { login: 'kuaya1' } };
  const moveTo = (sha) => { git(src, ['push', '-q', '-f', remote, `${sha}:refs/heads/change`, `${sha}:refs/pull/3/head`]); fx.head = sha; fx.pull.head.sha = sha; return sha; };
  fx.onMain = () => {
    git(src, ['checkout', '-q', fx.main]);
    put('dashboard/core/other.js', `module.exports = ${n};\n`);
    git(src, ['add', '-A']);
    git(src, ['commit', '-q', '-m', 'main moves on']);
    fx.main = git(src, ['rev-parse', 'HEAD']);
    git(src, ['push', '-q', remote, `${fx.main}:refs/heads/main`]);
  };
  // GitHub's "Update branch".
  fx.updateBranch = () => {
    git(src, ['checkout', '-q', '--detach', fx.head]);
    git(src, ['merge', '-q', '--no-ff', '--no-edit', fx.main]);
    return moveTo(git(src, ['rev-parse', 'HEAD']));
  };
  fx.commitOwn = (p, text) => {
    git(src, ['checkout', '-q', '--detach', fx.head]);
    put(p, text);
    git(src, ['add', '-A']);
    git(src, ['commit', '-q', '-m', 'another change']);
    return moveTo(git(src, ['rev-parse', 'HEAD']));
  };
  return fx;
}

const resp = (status, body) => ({ status, text: async () => JSON.stringify(body) });
const page1 = (u, list) => (u.searchParams.get('page') === '1' ? list : []);
const OWNER_USER = { login: 'kuaya1', type: 'User' };
const comment = (id, body) => ({ id, body, user: OWNER_USER, author_association: 'OWNER', created_at: '2026-10-27T10:00:00Z', updated_at: '2026-10-27T10:00:00Z' });

// GitHub as the gate reads it. Reads must use the job's own token; the one
// write, the check, the gate App's.
function world(fx) {
  const w = { checks: [], foreign: [], comments: [], reviews: [], runs: [], jobs: new Map(), next: 1 };
  const run = (o) => ({ id: w.next += 1, event: 'pull_request', repository: { full_name: REPO }, head_repository: { full_name: REPO }, pull_requests: [{ number: 3 }], ...o });
  // A run of `file` for `sha` with these jobs ({ name: conclusion or a status }).
  w.run = (sha, file, jobs, o = {}) => {
    const r = run({ head_sha: sha, path: file, ...o });
    w.runs.push(r);
    w.jobs.set(r.id, Object.entries(jobs).map(([name, s], i) => ({ id: r.id * 10 + i, name, head_sha: sha, status: ['queued', 'in_progress'].includes(s) ? s : 'completed', conclusion: ['queued', 'in_progress'].includes(s) ? null : s })));
    return r;
  };
  // The genuine runs: main's test.yml and agent-checks.yml.
  w.genuine = (sha, o = {}) => {
    w.run(sha, '.github/workflows/test.yml', { test: o.test || 'success' });
    w.run(sha, '.github/workflows/agent-checks.yml', { 'agent-guard': o['agent-guard'] || 'success', 'agent-verify': o['agent-verify'] || 'success' });
  };
  w.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || 'GET';
    const auth = opts.headers && opts.headers.authorization;
    if (method === 'POST' && u.pathname === `/repos/${REPO}/check-runs`) {
      assert.equal(auth, `Bearer ${ENV.GATE_TOKEN}`, 'the check is posted with the gate App\'s token');
      w.checks.push(JSON.parse(opts.body));
      return resp(201, { id: w.checks.length });
    }
    assert.equal(method, 'GET', url);
    assert.equal(auth, `Bearer ${ENV.GITHUB_TOKEN}`, `a read uses the job's own token: ${url}`);
    if (u.pathname === `/repos/${REPO}/pulls/3`) return resp(200, fx.pull);
    if (u.pathname === `/repos/${REPO}/pulls`) return resp(200, page1(u, fx.pull.state === 'open' ? [fx.pull] : []));
    if (u.pathname === `/repos/${REPO}/issues/3/comments`) return w.comments === null ? resp(502, {}) : resp(200, page1(u, w.comments));
    if (u.pathname === `/repos/${REPO}/pulls/3/reviews`) return resp(200, page1(u, w.reviews));
    // Every run for the head, whatever its event: the gate filters too.
    if (u.pathname === `/repos/${REPO}/actions/runs`) return resp(200, { workflow_runs: page1(u, w.runs.filter((r) => r.head_sha === u.searchParams.get('head_sha'))) });
    const jobs = new RegExp(`^/repos/${REPO}/actions/runs/(\\d+)/jobs$`).exec(u.pathname);
    if (jobs) return resp(200, { jobs: page1(u, w.jobs.get(Number(jobs[1])) || []) });
    const cr = new RegExp(`^/repos/${REPO}/commits/([0-9a-f]{40})/check-runs$`).exec(u.pathname);
    if (cr) {
      const mine = w.checks.map((c, i) => ({ ...c, id: 1000 + i, app: { id: GATE_APP } }));
      return resp(200, { check_runs: page1(u, [...w.foreign, ...mine].filter((c) => c.head_sha === cr[1] && c.name === u.searchParams.get('check_name'))) });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  };
  return w;
}
const gate = (fx, w, env = {}) => GATE.gateHead({ pr: 3, env: { ...ENV, ...env }, cwd: fx.runner(), fetchImpl: w.fetch, runUrl: 'https://github.com/kuaya1/CryptoResearch/actions/runs/9' });
const last = (w) => w.checks[w.checks.length - 1];

// A review the ledger holds for `head`, as agent-review.js records it.
let seq = 0;
function signed(fx, { head, result = 'pass', key = L.ledgerKey(ENV), posted = true }) {
  const id = `rv-${String(seq += 1).padStart(16, '0')}`;
  const bind = { kind: 'review', repo: REPO, pr: 3, head, merge_base: fx.main, issue: 7, task_sha256: 'f'.repeat(64), prompt: 'cr-agent-review@1', model: 'gpt-fictional' };
  const binding = L.bindingOf(bind);
  const rec = { t: 'outcome', id, state: 'response', via: 'send', response_id: `chatcmpl-${seq}`, model: 'gpt-fictional', verdict: { result, summary: 'FICTIONAL.', findings: [] } };
  rec.mac = L.macOf(key, { ...rec, binding });
  const append = [{ t: 'reserve', kind: 'review', id, binding, bind, day: '2026-10-27', tokens: 1, run: '1/1', at: '2026-10-27T09:00:00Z' }, rec];
  if (posted) append.push({ t: 'posted', id, conclusion: result, at: '2026-10-27T09:01:00Z' });
  const r = L.transact(fx.runner(), { decide: () => ({ append }), message: 'FICTIONAL review' });
  assert.ok(!r.error, r.error);
  return id;
}

test('the required jobs of main\'s workflow files and Eric\'s review of this head clear it; posted once, with the gate App\'s token only', async (t) => {
  const fx = fixture(t);
  const w = world(fx);
  w.genuine(fx.head);
  const h12 = fx.head.slice(0, 12);
  const r = await gate(fx, w);
  assert.equal(r.status, 'held');
  assert.equal(last(w).name, 'release-gate');
  assert.equal(last(w).head_sha, fx.head);
  assert.equal(last(w).conclusion, 'action_required');
  assert.equal(last(w).output.title, `Missing: no review of ${h12}`);
  assert.ok(last(w).output.summary.includes(`\`\`\`\n/reviewed ${fx.head}\n\`\`\``));
  assert.match(last(w).output.summary, /- test success \(run \d+ of \.github\/workflows\/test\.yml\)\n- agent-guard success \(run \d+ of \.github\/workflows\/agent-checks\.yml\)\n- agent-verify success/);
  w.comments.push(comment(9, `/reviewed ${fx.head}`));
  assert.equal((await gate(fx, w)).status, 'cleared');
  assert.equal(last(w).conclusion, 'success');
  assert.equal(last(w).output.title, `Cleared: the required jobs passed from main's workflow files; kuaya1 reviewed ${h12}`);
  const n = w.checks.length;
  assert.equal((await gate(fx, w)).status, 'unchanged');
  assert.equal(w.checks.length, n);
  // The sweep gates every open pull request the same way.
  assert.deepEqual((await GATE.sweep({ env: ENV, cwd: fx.runner(), fetchImpl: w.fetch })).map((x) => [x.pr, x.status]), [[3, 'unchanged']]);
});

test('a run or a check by the right name proves nothing: another workflow file, another pull request, a fork, a push, or a check any workflow posted', async (t) => {
  const fx = fixture(t);
  const w = world(fx);
  w.comments.push(comment(9, `/reviewed ${fx.head}`));
  // agent-checks is genuine; every "test" is not.
  w.run(fx.head, '.github/workflows/agent-checks.yml', { 'agent-guard': 'success', 'agent-verify': 'success' });
  w.run(fx.head, '.github/workflows/evil.yml', { test: 'success' });
  w.run(fx.head, '.github/workflows/test.yml', { test: 'success' }, { pull_requests: [{ number: 4 }] });
  w.run(fx.head, '.github/workflows/test.yml', { test: 'success' }, { head_repository: { full_name: 'someone/CryptoResearch' } });
  w.run(fx.head, '.github/workflows/test.yml', { test: 'success' }, { event: 'push' });
  // A release-gate success that a workflow posted (GitHub Actions, 15368).
  w.foreign.push({ id: 5, name: 'release-gate', head_sha: fx.head, status: 'completed', conclusion: 'success', app: { id: 15368 }, output: { title: 'x', summary: 'y' } });
  assert.equal((await gate(fx, w)).status, 'held');
  assert.equal(last(w).conclusion, 'action_required');
  assert.equal(last(w).output.title, 'Waiting: test missing');
  assert.match(last(w).output.summary, /no pull_request run of \.github\/workflows\/test\.yml for this head/);
  // A test.yml run whose job is named otherwise, or whose job ran another head.
  const odd = w.run(fx.head, '.github/workflows/test.yml', { tests: 'success' });
  assert.equal((await gate(fx, w)).status, 'held');
  assert.match(last(w).output.summary, new RegExp(`run ${odd.id} of \\.github/workflows/test\\.yml has no job test`));
  w.genuine(fx.head);
  assert.equal((await gate(fx, w)).status, 'cleared');
});

test('a change to a workflow definition makes its jobs its own: a signed model pass does not stand in; only Eric\'s review of this exact head clears it', async (t) => {
  const fx = fixture(t, { edits: [['.github/workflows/agent-checks.yml', 'name: agent-checks\non: pull_request\n']] });
  const w = world(fx);
  w.genuine(fx.head);
  signed(fx, { head: fx.head });
  const h12 = fx.head.slice(0, 12);
  assert.equal((await gate(fx, w)).status, 'held');
  assert.equal(last(w).output.title, `Missing: this change edits workflow definitions, so only kuaya1's review of ${h12} clears it`);
  assert.match(last(w).output.summary, /changes `\.github\/workflows\/agent-checks\.yml`: the jobs above ran from its own definitions and prove nothing by themselves\. A model's review does not stand in here\./);
  w.comments.push(comment(9, `/reviewed ${fx.head}`));
  assert.equal((await gate(fx, w)).status, 'cleared');
  assert.equal(last(w).output.title, 'Cleared by kuaya1\'s review: this change edits workflow definitions');
  // A commit of its own after Eric's review: invalidated, whatever its jobs say.
  const h1 = fx.commitOwn('dashboard/core/widget.js', "'use strict';\nmodule.exports = { size: () => 0 };\n");
  w.genuine(h1);
  assert.equal((await gate(fx, w)).status, 'held');
  assert.equal(last(w).output.title, `Invalidated by a new commit: kuaya1 reviewed ${h12}, the head is ${h1.slice(0, 12)}`);
  // An action definition counts the same.
  assert.ok(GATE.DEFINITION_RE.test('.github/actions/setup/action.yml'));
  assert.ok(!GATE.DEFINITION_RE.test('.github/agent-policy.json'));
});

test('the model\'s signed, posted pass clears a head; a forged or unposted one does not; a signed verdict asking for changes fails it until Eric reviews the head', async (t) => {
  const fx = fixture(t);
  const w = world(fx);
  w.genuine(fx.head);
  const h12 = fx.head.slice(0, 12);
  signed(fx, { head: fx.head, key: L.macKey('not the key') });
  signed(fx, { head: fx.head, posted: false });
  assert.equal((await gate(fx, w)).status, 'held');
  assert.equal(last(w).output.title, `Missing: no review of ${h12}`);
  // Without the ledger key nothing the ledger holds is read, and it says so.
  assert.equal((await gate(fx, w, { AGENT_LEDGER_KEY: '' })).status, 'held');
  assert.match(last(w).output.summary, /AGENT_LEDGER_KEY is not set in the environment, so no model pass can be read/);
  const id = signed(fx, { head: fx.head });
  assert.equal((await gate(fx, w)).status, 'cleared');
  assert.equal(last(w).output.title, `Cleared: the required jobs passed from main's workflow files; the model passed ${h12}`);
  assert.ok(last(w).output.summary.includes(`attempt \`${id}\``));
  // A later signed verdict on the same head asking for changes decides.
  signed(fx, { head: fx.head, result: 'changes_required' });
  assert.equal((await gate(fx, w)).status, 'failed');
  assert.equal(last(w).conclusion, 'failure');
  assert.equal(last(w).output.title, `Failed: the model's review of ${h12} is changes required`);
  w.comments.push(comment(9, `/reviewed ${fx.head}`));
  assert.equal((await gate(fx, w)).status, 'cleared');
  assert.equal(last(w).output.title, `Cleared: the required jobs passed from main's workflow files; kuaya1 reviewed ${h12}`);
});

test('a pass carries over "Update branch" and a commit of its own does not; a job that failed fails the gate and one still running holds it', async (t) => {
  const fx = fixture(t);
  const w = world(fx);
  const h0 = fx.head;
  signed(fx, { head: h0 });
  fx.onMain();
  const h1 = fx.updateBranch();
  w.genuine(h1, { 'agent-verify': 'in_progress' });
  assert.equal((await gate(fx, w)).status, 'held');
  assert.equal(last(w).output.title, 'Waiting: agent-verify pending');
  w.genuine(h1);
  assert.equal((await gate(fx, w)).status, 'cleared');
  assert.equal(last(w).output.title, `Cleared: the required jobs passed from main's workflow files; the model passed ${h0.slice(0, 12)}, carried over`);
  assert.match(last(w).output.summary, /given for [0-9a-f]{12} and covering this head \(the one commit since merges main and adds nothing of its own/);
  w.genuine(h1, { test: 'failure' });
  assert.equal((await gate(fx, w)).status, 'failed');
  assert.equal(last(w).output.title, 'Failed: test did not pass');
  const h2 = fx.commitOwn('dashboard/core/widget.js', "'use strict';\nmodule.exports = { size: () => 2 };\n");
  w.genuine(h2);
  assert.equal((await gate(fx, w)).status, 'held');
  assert.equal(last(w).output.title, `Missing: no review of ${h2.slice(0, 12)}`);
});

test('nothing is posted when the gate cannot know: no App token, a moved head, unreadable comments; a closed pull request is skipped', async (t) => {
  const fx = fixture(t);
  const w = world(fx);
  w.genuine(fx.head);
  assert.equal((await gate(fx, w, { GATE_TOKEN: '' })).status, 'not_configured');
  assert.equal((await GATE.gateHead({ pr: 3, head: 'b'.repeat(40), env: ENV, cwd: fx.runner(), fetchImpl: w.fetch })).status, 'skipped');
  w.comments = null;
  assert.equal((await gate(fx, w)).status, 'unreadable');
  fx.pull.state = 'closed';
  assert.equal((await gate(fx, w)).status, 'skipped');
  assert.equal(w.checks.length, 0);
});

test('the ruleset Eric applies requires release-gate from the gate App alone; the repository\'s file stays the rollback', () => {
  const before = JSON.parse(fs.readFileSync(path.join(ROOT, '.github', 'rulesets', 'main-merge-requirements.json'), 'utf8'));
  const after = GATE.rulesetAfter(before, GATE_APP);
  const list = (rs) => rs.rules.find((r) => r.type === 'required_status_checks').parameters.required_status_checks;
  assert.deepEqual(list(after), [...list(before), { context: 'release-gate', integration_id: GATE_APP }]);
  assert.deepEqual({ ...after, rules: after.rules.filter((r) => r.type !== 'required_status_checks') }, { ...before, rules: before.rules.filter((r) => r.type !== 'required_status_checks') });
  assert.equal(list(before).length, 4, 'the file is untouched');
  for (const bad of [15368, 0, -1, 'x', 1.5, undefined]) assert.throws(() => GATE.rulesetAfter(before, bad), /positive integer, never GitHub Actions/);
  assert.throws(() => GATE.rulesetAfter(after, GATE_APP), /already required/);
});

// The workflow as a contract, and its shell run by bash with a fake node.
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const BASH = process.platform === 'win32' ? (fs.existsSync(GIT_BASH) ? GIT_BASH : null) : 'bash';
test('release-gate.yml runs main\'s code in the release-gate environment, off until Eric turns it on, its App token able to write checks only', { skip: !BASH && 'no bash here; CI runs it' }, (t) => {
  const text = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release-gate.yml'), 'utf8');
  assert.match(text, /^on:\n {2}workflow_run:\n {4}workflows: \[test, agent-checks, agent-review\]\n {4}types: \[completed\]\n {2}issue_comment:\n {4}types: \[created\]\n {2}schedule:\n/m);
  assert.doesNotMatch(text, /pull_request_target|^\s+pull_request:/m);
  assert.match(text, /^permissions: \{\}$/m);
  assert.match(text, /\n {4}if: >-\n {6}vars\.RELEASE_GATE_ENABLED == 'true' && \(\n/);
  assert.match(text, /\n {4}environment: release-gate\n/);
  const perms = text.slice(text.indexOf('    permissions:'), text.indexOf('    steps:'));
  assert.doesNotMatch(perms, /write/);
  assert.deepEqual([...new Set(text.match(/secrets\.[A-Z_]+/g))].sort(), ['secrets.AGENT_LEDGER_KEY', 'secrets.GATE_APP_KEY']);
  assert.deepEqual(text.match(/permission-[a-z-]+: \w+/g), ['permission-checks: write']);
  for (const u of text.match(/uses:\s*\S+/g)) assert.match(u, /@[0-9a-f]{40}$/, u);
  assert.match(text, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.doesNotMatch(text, /workflow_run\.head_branch|pull_request\.head\.(ref|sha) \}\}|github\.event\.comment\.body \}\}/);
  // The workflows whose jobs the gate trusts pin every action too.
  for (const f of ['test.yml', 'agent-checks.yml']) {
    for (const u of fs.readFileSync(path.join(ROOT, '.github', 'workflows', f), 'utf8').match(/uses:\s*\S+/g)) assert.match(u, /@[0-9a-f]{40}$/, `${f}: ${u}`);
  }
  const from = text.indexOf('          set -euo pipefail\n');
  const to = text.indexOf('          esac\n', from) + '          esac\n'.length;
  const shell = text.slice(from, to).split('\n').map((l) => l.slice(10)).join('\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-gate-step-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'step.sh'), shell);
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'node'), '#!/bin/sh\nprintf \'%s\n\' "$*" >> "$FAKE_LOG"\n', { mode: 0o755 });
  const log = path.join(dir, 'node.log');
  const run = (o) => {
    fs.rmSync(log, { force: true });
    const r = spawnSync(BASH, [path.join(dir, 'step.sh')], { encoding: 'utf8', env: { ...process.env, PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH}`, FAKE_LOG: log, WR_EVENT: '', WR_PR: '', WR_HEAD: '', COMMENT_PR: '', PR_INPUT: '', ...o } });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim() : '';
  };
  const H = 'a'.repeat(40);
  assert.equal(run({ EVENT: 'workflow_run', WR_EVENT: 'pull_request', WR_PR: '5', WR_HEAD: H }), `dashboard/scripts/agent-gate.js run --pr 5 --head ${H}`);
  assert.equal(run({ EVENT: 'workflow_run', WR_EVENT: 'workflow_run' }), 'dashboard/scripts/agent-gate.js sweep');
  assert.equal(run({ EVENT: 'issue_comment', COMMENT_PR: '5' }), 'dashboard/scripts/agent-gate.js run --pr 5');
  assert.equal(run({ EVENT: 'workflow_dispatch', PR_INPUT: '5' }), 'dashboard/scripts/agent-gate.js run --pr 5');
  assert.equal(run({ EVENT: 'workflow_dispatch' }), 'dashboard/scripts/agent-gate.js sweep');
  assert.equal(run({ EVENT: 'schedule' }), 'dashboard/scripts/agent-gate.js sweep');
});
