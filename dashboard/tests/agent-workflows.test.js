'use strict';
// The agent lane's workflows as a contract (Eric, 2026-10-26;
// audits/2026-10-26-engineering-simplification): every action pinned to a
// commit, each credential only in the job that needs it, the jobs that run a
// candidate's code holding no write permission and no secret, the reviewer
// never checking out a candidate, and the required checks the ruleset names
// all produced. Read as text; nothing runs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../engineering/policy');
const AR = require('../scripts/agent-review');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const FILES = ['agent-build.yml', 'agent-checks.yml', 'agent-review.yml'].map((f) => [f, read(`.github/workflows/${f}`)]);
// The jobs of a workflow by id: the text from "  id:" to the next job.
function jobs(text) {
  const body = text.slice(text.indexOf('\njobs:\n') + 7);
  const out = {};
  const parts = body.split(/^ {2}(?=[A-Za-z][\w-]*:\s*$)/m).filter((x) => x.trim());
  for (const p of parts) out[p.slice(0, p.indexOf(':'))] = p;
  return out;
}
const secretsIn = (text) => [...new Set(text.match(/secrets\.[A-Z_]+/g) || [])].sort();

test('every action in the agent workflows is pinned to a full commit', () => {
  for (const [f, text] of FILES) {
    const uses = text.match(/uses:\s*\S+/g) || [];
    assert.ok(uses.length, f);
    for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, `${f}: ${u}`);
  }
  const lock = JSON.parse(read('.github/agent/package-lock.json'));
  const pkg = JSON.parse(read('.github/agent/package.json'));
  const version = JSON.parse(read('.github/agent-policy.json')).build.claude_code;
  assert.equal(pkg.dependencies['@anthropic-ai/claude-code'], version);
  assert.equal(lock.packages['node_modules/@anthropic-ai/claude-code'].version, version);
  assert.match(lock.packages['node_modules/@anthropic-ai/claude-code'].integrity, /^sha512-/);
});

test('the build job holds only the Anthropic key and reads the repository; the App key is only where it publishes', () => {
  const j = jobs(FILES[0][1]);
  assert.deepEqual(Object.keys(j), ['reserve', 'build', 'publish', 'record']);
  assert.deepEqual(secretsIn(j.build), ['secrets.ANTHROPIC_API_KEY']);
  assert.match(j.build, /permissions:\n\s+contents: read\n/);
  assert.match(j.build, /persist-credentials: false/);
  assert.match(j.build, /needs\.reserve\.outputs\.attempt == github\.run_attempt/, 'a re-run of failed jobs builds nothing');
  assert.deepEqual(secretsIn(j.publish), ['secrets.BUILDER_APP_KEY']);
  assert.match(j.publish, /permission-contents: write\n\s+permission-pull-requests: write\n/);
  assert.doesNotMatch(j.publish, /permission-(workflows|administration|actions|checks)/);
  assert.deepEqual(secretsIn(j.reserve), []);
  assert.deepEqual(secretsIn(j.record), []);
  assert.match(FILES[0][1], /^permissions: \{\}$/m);
});

test('the builder runs in Claude Code\'s sandbox: the key unset for commands, npm only, no hooks, no unsandboxed retry', () => {
  const s = JSON.parse(read('.github/agent/claude-settings.json'));
  assert.equal(s.disableAllHooks, true);
  assert.equal(s.sandbox.enabled, true);
  assert.equal(s.sandbox.failIfUnavailable, true);
  assert.equal(s.sandbox.allowUnsandboxedCommands, false);
  assert.equal(s.sandbox.autoAllowBashIfSandboxed, false, 'the allowed tools, not the sandbox, decide which commands run');
  assert.deepEqual(s.sandbox.network, { allowedDomains: ['registry.npmjs.org'], strictAllowlist: true });
  assert.deepEqual(s.sandbox.credentials.envVars, [{ name: 'ANTHROPIC_API_KEY', mode: 'deny' }]);
  assert.equal(s.permissions.blockReadsOutsideWorkingDirectories, true);
  assert.equal(s.permissions.disableBypassPermissionsMode, 'disable');
  for (const d of ['WebFetch', 'WebSearch', 'Read(//proc/**)', 'Read(//sys/**)', 'Edit(./.claude/**)', 'Write(./.claude/**)', 'Edit(./.git/**)', 'Write(./.git/**)']) assert.ok(s.permissions.deny.includes(d), d);
  assert.equal(s.permissions.allow, undefined);

  const b = jobs(FILES[0][1]).build;
  const at = (needle) => { const i = b.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  // The copies are taken before the builder starts, and used after it.
  const copy = at('cp .github/agent/claude-settings.json dashboard/scripts/agent-secrets.js "$RUNNER_TEMP/guard/"');
  assert.ok(copy < at('cp -R .git "$RUNNER_TEMP/guard/base.git"'));
  const sandbox = at('bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all');
  assert.match(b, /kernel\.apparmor_restrict_unprivileged_userns=0/);
  const build = at('- name: Build (sandboxed)');
  assert.ok(copy < build && sandbox < build && at('agent-guard.js prompt') < build);
  assert.match(b, /--settings "\$RUNNER_TEMP\/guard\/claude-settings\.json" --setting-sources user /);
  assert.equal((b.match(/secrets\.ANTHROPIC_API_KEY/g) || []).length, 1);
  assert.ok(at('secrets.ANTHROPIC_API_KEY') > build && at('secrets.ANTHROPIC_API_KEY') < at('- name: The change, as data'));
  assert.match(b, /--allowedTools Read Glob Grep "Edit\(\.\/\*\*\)" "Write\(\.\/\*\*\)" /, 'file tools only inside the checkout');
  // The change is read with the .git copy, never the one the builder could write.
  const change = b.slice(at('- name: The change, as data'), at('- name: No key-shaped string'));
  assert.match(change, /GIT_DIR: \$\{\{ runner\.temp \}\}\/guard\/base\.git\n/);
  assert.equal((change.match(/git -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false /g) || []).length, 3);
  // Scanned before anything is uploaded, by the copy.
  const scan = at('node "$RUNNER_TEMP/guard/agent-secrets.js" --dir "$RUNNER_TEMP/out"');
  assert.ok(scan < at('actions/upload-artifact@'));
  assert.match(b.slice(at('- name: No key-shaped string'), scan), /if: always\(\)/);
  assert.match(jobs(FILES[0][1]).publish, /agent-guard\.js apply --base "\$BASE" --patch "\$RUNNER_TEMP\/build\/patch\.diff" --build "\$RUNNER_TEMP\/build\/result\.json"/);
});

test('the sandbox probe is Eric\'s own run from main, under the build\'s settings, at most $0.50, and its check fails unless everything holds', () => {
  const text = read('.github/workflows/agent-sandbox-probe.yml');
  assert.match(text, /^on:\n {2}workflow_dispatch:\n\npermissions: \{\}$/m, 'dispatch only');
  for (const u of text.match(/uses:\s*\S+/g)) assert.match(u, /@[0-9a-f]{40}$/, u);
  const j = jobs(text);
  assert.deepEqual(Object.keys(j), ['probe']);
  assert.match(j.probe, /if: github\.ref == 'refs\/heads\/main' && github\.triggering_actor == github\.repository_owner\n/);
  assert.match(j.probe, /permissions:\n\s+contents: read\n\s+steps:/);
  assert.deepEqual(secretsIn(text), ['secrets.ANTHROPIC_API_KEY']);
  assert.match(j.probe, /--max-budget-usd 0\.5 \\\n\s+--settings "\$RUNNER_TEMP\/guard\/claude-settings\.json" --setting-sources user /);
  assert.ok(j.probe.indexOf('cp .github/agent/claude-settings.json .github/agent/sandbox-probe.js "$RUNNER_TEMP/guard/"') < j.probe.indexOf('- name: Probe'));
  assert.match(j.probe, /node "\$RUNNER_TEMP\/guard\/sandbox-probe\.js" --check probe\/report\.json/);
  assert.doesNotMatch(text, /upload-artifact|contents: write|git push/);

  const probe = require(path.join(ROOT, '.github', 'agent', 'sandbox-probe.js'));
  const held = { anthropic_key_visible: false, canary_visible: false, npm_registry: 'HTTP 200', other_host: 'blocked (ECONNREFUSED)', anthropic_api: 'blocked (ECONNREFUSED)', proc_self_environ: 'readable, no canary', proc_parent_environ: 'unreadable (ENOENT)', proc_scan: { pids: 3, with_canary: 0 }, write_home: 'refused (EROFS)', write_runner_temp: 'refused (EROFS)', write_checkout: 'written' };
  const canary = 'c'.repeat(48);
  const fails = (r, o = {}) => probe.verdict(r, { resultText: 'The read was refused.', canary, ...o }).filter(([, ok]) => !ok).map(([n]) => n);
  assert.deepEqual(fails(held), []);
  assert.deepEqual(fails(null), ['report'], 'no report shows nothing either way');
  assert.deepEqual(fails({ ...held, anthropic_key_visible: true }), ['ANTHROPIC_API_KEY unset for commands']);
  assert.deepEqual(fails({ ...held, other_host: 'HTTP 200' }), ['any other host blocked']);
  assert.deepEqual(fails({ ...held, proc_scan: { pids: 9, with_canary: 1 } }), ['no visible process environment holds the canary']);
  assert.deepEqual(fails({ ...held, write_runner_temp: 'written' }), ['no write to the runner\'s temp (where the guard\'s copies are)']);
  assert.deepEqual(fails(held, { resultText: `it says ${canary}` }), ['the builder\'s answer does not carry the canary']);
  assert.deepEqual(fails(held, { canary: '' }), ['the builder\'s answer does not carry the canary'], 'a check without the canary proves nothing');
});

test('no workflow caches anything (a cache is shared across runs and branches)', () => {
  const dir = path.join(ROOT, '.github', 'workflows');
  for (const f of fs.readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(text, /^\s*cache(-dependency-path)?:/m, f);
    assert.doesNotMatch(text, /uses:\s*actions\/cache[@/]/, f);
  }
});

test('the jobs that run a candidate hold no write permission and no secret, and are never skipped', () => {
  const text = FILES[1][1];
  const j = jobs(text);
  assert.deepEqual(Object.keys(j), ['agent-guard', 'agent-verify']);
  assert.deepEqual(secretsIn(text), []);
  assert.match(j['agent-guard'], /name: agent-guard\n/);
  assert.match(j['agent-verify'], /name: agent-verify\n/);
  for (const id of Object.keys(j)) assert.doesNotMatch(j[id].split('steps:')[0], /\n {4}if:/, `${id} has a job-level condition`);
  const perms = j['agent-verify'].slice(j['agent-verify'].indexOf('permissions:'), j['agent-verify'].indexOf('steps:'));
  assert.doesNotMatch(perms, /write/);
  assert.equal((j['agent-verify'].match(/persist-credentials: false/g) || []).length, 2);
  // The verifier comes from main's commit; the merge tree is only data to it.
  assert.match(j['agent-verify'], /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}\n\s+path: trusted/);
  assert.match(j['agent-verify'], /node trusted\/dashboard\/scripts\/agent-verify\.js --tree candidate/);
});

test('the reviewer runs main\'s code with the OpenAI key, never checks out a candidate, and posts agent-review by name', () => {
  const text = FILES[2][1];
  const j = jobs(text);
  assert.deepEqual(Object.keys(j), ['post-review']);
  assert.match(j['post-review'], /name: post-review\n/);
  assert.deepEqual(secretsIn(text), ['secrets.OPENAI_API_KEY']);
  for (const [f, t] of FILES.slice(0, 2)) assert.doesNotMatch(t, /OPENAI/, f);
  assert.match(j['post-review'], /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.doesNotMatch(text, /ref: \$\{\{ github\.event\.(workflow_run\.head|pull_request\.head)/);
  assert.match(text, /workflows: \[test, agent-checks\]/);
  assert.equal(AR.CHECK, 'agent-review');
});

test('the checks the ruleset requires are the ones these workflows produce', () => {
  const rules = JSON.parse(read('.github/rulesets/main-merge-requirements.json'));
  const required = rules.rules.find((r) => r.type === 'required_status_checks').parameters.required_status_checks.map((c) => c.context).sort();
  assert.deepEqual(required, ['agent-guard', 'agent-review', 'agent-verify', 'test']);
  assert.match(read('.github/workflows/test.yml'), /^jobs:\n {2}test:\n/m);
  assert.match(FILES[1][1], /-f name=agent-review /, 'agent-checks posts the owner change\'s agent-review');
  assert.deepEqual(AR.REQUIRED, ['test', 'agent-guard', 'agent-verify']);
});

test('the agent policy names only live templates, and its implementation globs stay inside them', () => {
  const policy = JSON.parse(read('.github/agent-policy.json'));
  for (const [name, t] of Object.entries(policy.templates)) {
    assert.ok(P.TEMPLATES[name] && !P.RETIRED[name], name);
    for (const g of t.implementation) assert.ok(P.TEMPLATES[name].allowed_paths.some((a) => P.within(g, a)), `${name}: ${g}`);
  }
  assert.ok(policy.ceilings.review_attempts_per_binding >= 1 && policy.ceilings.review_attempts_per_binding <= 3);
  assert.ok(policy.build.max_budget_usd <= policy.ceilings.build_usd_per_day);
});
