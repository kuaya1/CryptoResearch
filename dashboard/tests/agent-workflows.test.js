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
  assert.deepEqual(Object.keys(j), ['reserve', 'refused', 'build', 'publish', 'record']);
  assert.deepEqual(secretsIn(j.build), ['secrets.ANTHROPIC_API_KEY']);
  assert.match(j.build, /permissions:\n\s+contents: read\n/);
  assert.match(j.build, /persist-credentials: false/);
  assert.match(j.build, /needs\.reserve\.outputs\.attempt == github\.run_attempt/, 'a re-run of failed jobs builds nothing');
  assert.deepEqual(secretsIn(j.publish), ['secrets.BUILDER_APP_KEY']);
  assert.match(j.publish, /permission-contents: write\n\s+permission-pull-requests: write\n/);
  assert.doesNotMatch(j.publish, /permission-(workflows|administration|actions|checks)/);
  // Reserve alone holds the ledger's key (it reads review verdicts for /revise).
  assert.deepEqual(secretsIn(j.reserve), ['secrets.AGENT_LEDGER_KEY']);
  // Reserve reads the issue as GitHub holds it now (Engineering v3, change 2),
  // and for /revise the pull request, its checks and their workflow runs.
  assert.match(j.reserve, /permissions:\n\s+contents: write[^\n]*\n\s+issues: read[^\n]*\n\s+pull-requests: read[^\n]*\n\s+checks: read[^\n]*\n\s+actions: read[^\n]*\n\s+outputs:/);
  assert.match(j.reserve, /GH_TOKEN: \$\{\{ github\.token \}\}\n/);
  assert.match(j.reserve, /if \[ "\$EVENT" = issue_comment \]; then\n\s+node dashboard\/scripts\/agent-revise\.js reserve --base "\$MAIN" --out "\$RUNNER_TEMP\/revise"\n\s+else\n\s+node dashboard\/scripts\/agent-guard\.js reserve --base "\$MAIN"\n/);
  for (const id of ['build', 'publish', 'record', 'refused']) assert.doesNotMatch(j[id], /AGENT_LEDGER_KEY|OPENAI/, id);
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
  const copy = at('cp .github/agent/claude-settings.json .github/agent/builder-rules.md .github/agent-policy.json dashboard/scripts/agent-secrets.js "$RUNNER_TEMP/guard/"');
  assert.ok(copy < at('cp .github/agent/package.json .github/agent/package-lock.json "$RUNNER_TEMP/claude/"'));
  // The builder starts from the tree reserve chose; the .git copy is taken there.
  const tree = at('- name: The tree the builder starts from');
  assert.ok(copy < tree && tree < at('git -c core.hooksPath=/dev/null checkout -q --detach "$CHECKOUT"'));
  assert.ok(at('git merge-base --is-ancestor "$BASE" HEAD') < at('cp -R .git "$RUNNER_TEMP/guard/base.git"'));
  assert.match(b, /ref: \$\{\{ needs\.reserve\.outputs\.main \}\}\n/);
  const sandbox = at('bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all');
  assert.match(b, /kernel\.apparmor_restrict_unprivileged_userns=0/);
  const build = at('- name: Build (sandboxed)');
  assert.ok(copy < build && sandbox < build && at('agent-guard.js prompt') < tree && at('cp -R .git "$RUNNER_TEMP/guard/base.git"') < build);
  // Main's rules and policy, never the checkout's, once it holds a candidate.
  assert.match(b, /--append-system-prompt-file "\$RUNNER_TEMP\/guard\/builder-rules\.md" /);
  assert.match(b, /require\(process\.env\.RUNNER_TEMP \+ '\/guard\/agent-policy\.json'\)\.build\.model/);
  assert.doesNotMatch(b.slice(tree), /\.\/\.github\/|\.github\/agent\//, 'nothing after the switch is read from the checkout\'s .github');
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

test('publish leases on the head reserve recorded; a stale build opens no pull request, is recorded so and said on the issue', () => {
  const j = jobs(FILES[0][1]);
  assert.match(j.reserve, /predecessor: \$\{\{ steps\.reserve\.outputs\.predecessor \}\}/);
  assert.match(j.publish, /outputs:\n\s+state: \$\{\{ steps\.publish\.outputs\.state \}\}\n\s+note: \$\{\{ steps\.publish\.outputs\.note \}\}/);
  assert.match(j.publish, /RESERVATION: \$\{\{ needs\.reserve\.outputs\.reservation \}\}/);
  assert.match(j.publish, /agent-guard\.js publish --base "\$BASE" --tree "\$TREE" --reservation "\$RESERVATION" /);
  const pr = j.publish.slice(j.publish.indexOf('- name: The pull request'));
  assert.match(pr, /^- name: [^\n]+\n\s+if: steps\.publish\.outputs\.ok == 'true'\n/, 'no pull request for a stale build');
  assert.match(j.record, /permissions:\n\s+contents: write[^\n]*\n\s+issues: write[^\n]*\n\s+pull-requests: write[^\n]*\n\s+steps:/);
  assert.match(j.record, /--publish "\$PUBLISH"/);
  const said = j.record.slice(j.record.indexOf('- name: A stale build or revision is said where it was asked for'));
  assert.match(said, /if: needs\.publish\.outputs\.state == 'stale'\n/);
  assert.match(said, /NUMBER: \$\{\{ needs\.reserve\.outputs\.notify \}\}\n/);
  assert.match(said, /NOTE: \$\{\{ needs\.publish\.outputs\.note \}\}\n/);
  assert.doesNotMatch(said.slice(said.indexOf('run: |')), /\$\{\{/, 'the note reaches the shell as data, never as text of the script');
  assert.deepEqual(secretsIn(j.record), []);
});

test('/revise: only Eric\'s own new comment on a pull request reserves, the revision\'s files are checked by hash, and a refusal is said as data', () => {
  const text = FILES[0][1];
  const j = jobs(text);
  assert.match(text, /^on:\n {2}issues:\n {4}types: \[labeled\]\n {2}issue_comment:\n {4}types: \[created\]\n/m, 'a new comment only, never an edit');
  assert.match(text, /group: agent-build-\$\{\{ github\.event_name == 'issue_comment' && format\('comment-\{0\}', github\.event\.comment\.id\) \|\| github\.event\.issue\.number \}\}\n {2}cancel-in-progress: false\n/, 'a comment never cancels a running build');
  const cond = j.reserve.slice(j.reserve.indexOf('if:'), j.reserve.indexOf('runs-on:'));
  assert.match(cond, /github\.event_name == 'issue_comment' && github\.event\.issue\.pull_request &&/);
  assert.match(cond, /startsWith\(github\.event\.comment\.body, '\/revise'\) && github\.event\.comment\.user\.login == github\.repository_owner/);
  // The revision's task and issue travel as an artifact, used only at the hash reserve recorded.
  assert.match(j.reserve, /if: steps\.reserve\.outputs\.ok == 'true' && steps\.reserve\.outputs\.kind == 'revise'\n\s+with:\n\s+name: agent-revise\n/);
  const b = j.build;
  assert.ok(b.indexOf('echo "${PROMPT_SHA256}  ${RUNNER_TEMP}/revise/task.md" | sha256sum -c --quiet') < b.indexOf('- name: Build (sandboxed)'));
  assert.match(b, /- name: The task, from the issue as Eric labeled it\n\s+if: needs\.reserve\.outputs\.kind == 'build'\n/);
  assert.match(j.publish, /echo "\$\{ISSUE_SHA256\}  \$\{RUNNER_TEMP\}\/revise\/issue\.json" \| sha256sum -c --quiet/);
  assert.match(j.publish, /agent-guard\.js apply --base "\$BASE" [^\n]+ --issue "\$ISSUE"\n/);
  assert.match(j.publish, /TITLE: \$\{\{ needs\.reserve\.outputs\.title \}\}\n\s+NUMBER: \$\{\{ needs\.reserve\.outputs\.issue \}\}\n/);
  assert.doesNotMatch(text, /github\.event\.issue\.title/, 'the title comes from the issue reserve read, never the event (a comment\'s event is the pull request)');
  // A refusal of Eric's /revise is said on the pull request, a build that did
  // not start on the issue: no checkout, no secret, the note as data.
  assert.match(j.refused, /if: needs\.reserve\.outputs\.note != ''\n/);
  assert.match(j.refused, /permissions:\n\s+issues: write[^\n]*\n\s+pull-requests: write[^\n]*\n\s+steps:/);
  assert.match(j.refused, /KIND: \$\{\{ needs\.reserve\.outputs\.kind \}\}\n/);
  assert.match(j.refused, /if \[ "\$KIND" = revise \]; then\n\s+printf 'Revision not started for comment %s: %s/);
  assert.match(j.refused, /else\n\s+printf 'Build not started: %s/);
  assert.deepEqual(secretsIn(j.refused), []);
  assert.doesNotMatch(j.refused, /actions\/checkout/);
  assert.match(j.refused, /NOTE: \$\{\{ needs\.reserve\.outputs\.note \}\}\n/);
  assert.doesNotMatch(j.refused.slice(j.refused.indexOf('run: |')), /\$\{\{/, 'the note reaches the shell as data');
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
  // The probe runs under the build's TMPDIR, inside the checkout and git-ignored.
  assert.match(j.probe, /TMPDIR: \$\{\{ github\.workspace \}\}\/\.cr\/tmp\n/);
  assert.match(jobs(FILES[0][1]).build, /TMPDIR: \$\{\{ github\.workspace \}\}\/\.cr\/tmp\n\s+run: \|\n\s+mkdir -p "\$TMPDIR"\n/, 'the builder\'s temp files stay inside the checkout');
  assert.match(read('.gitignore'), /^\.cr\/$/m, '.cr/ is git-ignored, so nothing under TMPDIR reaches the patch');

  const probe = require(path.join(ROOT, '.github', 'agent', 'sandbox-probe.js'));
  // A write inside the sandbox that never reaches the runner's disk holds.
  const held = { anthropic_key_visible: false, canary_visible: false, proxy_set: true, npm_registry: 'HTTP 200 through the proxy', other_host: 'refused by the proxy (HTTP 403)', other_host_direct: 'blocked (EAI_AGAIN)', anthropic_api: 'refused by the proxy (HTTP 403)', anthropic_api_direct: 'blocked (EAI_AGAIN)', proc_self_environ: 'readable, no canary', proc_parent_environ: 'unreadable (ENOENT)', proc_scan: { pids: 3, with_canary: 0 }, write_home: 'written', write_runner_temp: 'refused (EROFS)', write_checkout: 'written', write_tmpdir: 'written', tmpdir_in_checkout: true };
  const canary = 'c'.repeat(48);
  const fails = (r, o = {}) => probe.verdict(r, { resultText: 'The read was refused.', canary, host: { on_disk: false }, ...o }).filter(([, ok]) => !ok).map(([n]) => n);
  const NPM = 'the npm registry reachable through the sandbox\'s proxy';
  const OTHER = 'any other host refused by the proxy, and unreachable directly';
  const API = 'the Anthropic API refused by the proxy for commands, and unreachable directly';
  const HOME = 'no write reaches the runner\'s home directory';
  assert.deepEqual(fails(held), []);
  assert.equal(probe.verdict(held, { canary }).length, 12);
  assert.deepEqual(fails(null), ['report'], 'no report shows nothing either way');
  assert.deepEqual(fails({ ...held, anthropic_key_visible: true }), ['ANTHROPIC_API_KEY unset for commands']);
  // The 2026-10-27 run on main: a fetch that ignores the proxy fails at DNS
  // for every host, so "blocked" proved nothing and the registry looked down.
  assert.deepEqual(fails({ ...held, proxy_set: true, npm_registry: 'blocked (EAI_AGAIN)', other_host: 'blocked (EAI_AGAIN)', anthropic_api: 'blocked (EAI_AGAIN)' }), [NPM, OTHER, API]);
  assert.deepEqual(fails({ ...held, npm_registry: 'no proxy in the environment', other_host: 'no proxy in the environment', anthropic_api: 'no proxy in the environment' }), [NPM, OTHER, API], 'without the proxy nothing is shown either way');
  assert.deepEqual(fails({ ...held, other_host: 'HTTP 200 through the proxy' }), [OTHER]);
  assert.deepEqual(fails({ ...held, other_host_direct: 'HTTP 200' }), [OTHER], 'a way around the proxy is not blocked');
  assert.deepEqual(fails({ ...held, anthropic_api: 'no answer from the proxy (timeout)' }), [API], 'silence is not a refusal');
  assert.deepEqual(fails({ ...held, npm_registry: 'tunnel opened, then ERR_TLS_CERT_ALTNAME_INVALID' }), [NPM]);
  assert.deepEqual(fails(held, { host: { on_disk: true, this_run: true } }), [HOME]);
  assert.deepEqual(fails({ ...held, write_home: 'refused (EROFS)' }, { host: { on_disk: true, this_run: false } }), [HOME], 'any marker on the runner\'s disk fails');
  assert.deepEqual(fails(held, { host: null }), [HOME], 'a home write not looked for on the runner proves nothing');
  assert.deepEqual(fails({ ...held, proc_scan: { pids: 9, with_canary: 1 } }), ['no visible process environment holds the canary']);
  assert.deepEqual(fails({ ...held, write_runner_temp: 'written' }), ['no write to the runner\'s temp (where the guard\'s copies are)']);
  assert.deepEqual(fails({ ...held, write_tmpdir: 'refused (EROFS)' }), ['writes to os.tmpdir() work (the desk\'s tests make temporary workspaces there)']);
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
  assert.deepEqual(secretsIn(text), ['secrets.AGENT_LEDGER_KEY', 'secrets.OPENAI_API_KEY']);
  assert.doesNotMatch(FILES[0][1], /OPENAI/);
  assert.doesNotMatch(FILES[1][1], /OPENAI|AGENT_LEDGER_KEY/);
  assert.doesNotMatch(read('.github/workflows/agent-sandbox-probe.yml'), /AGENT_LEDGER_KEY/);
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
