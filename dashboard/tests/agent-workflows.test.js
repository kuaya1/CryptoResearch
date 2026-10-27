'use strict';
// The agent lane's workflows as a contract (Eric, 2026-10-26;
// audits/2026-10-26-engineering-simplification): every action pinned to a
// commit, each credential only in the job that needs it, the jobs that run a
// candidate's code holding no write permission and no secret, the reviewer
// never checking out a candidate, and the required checks the ruleset names
// all produced. Read as text; only eric-reviewed's shell runs, with a fake gh.

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
  assert.match(j.reserve, /if \[ "\$EVENT" = issue_comment \]; then\n\s+node dashboard\/scripts\/agent-revise\.js reserve --base "\$MAIN" --out "\$RUNNER_TEMP\/reserved"\n\s+elif \[ "\$EVENT" = workflow_dispatch \]; then\n\s+node dashboard\/scripts\/agent-pm\.js reserve --mode "\$MODE" --task "\$TASK" --pr "\$PR" --base "\$MAIN" --out "\$RUNNER_TEMP\/reserved"\n\s+else\n\s+node dashboard\/scripts\/agent-guard\.js reserve --base "\$MAIN"\n/);
  // The PM's dispatch inputs reach the shell as data, and only from main.
  assert.match(j.reserve, /MODE: \$\{\{ inputs\.mode \}\}\n\s+TASK: \$\{\{ inputs\.task \}\}\n\s+PR: \$\{\{ inputs\.pr \}\}\n/);
  assert.doesNotMatch(j.reserve.slice(j.reserve.indexOf('run: |')), /\$\{\{ inputs\./);
  assert.match(j.reserve, /\(github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'\)/);
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
  assert.match(j.publish, /outputs:\n\s+state: \$\{\{ steps\.publish\.outputs\.state \}\}\n\s+note: \$\{\{ steps\.publish\.outputs\.note \|\| steps\.apply\.outputs\.note \}\}/);
  assert.match(j.publish, /RESERVATION: \$\{\{ needs\.reserve\.outputs\.reservation \}\}/);
  assert.match(j.publish, /agent-guard\.js publish --base "\$BASE" --tree "\$TREE" --reservation "\$RESERVATION" /);
  const pr = j.publish.slice(j.publish.indexOf('- name: The pull request'));
  assert.match(pr, /^- name: [^\n]+\n\s+id: pr\n\s+if: steps\.publish\.outputs\.ok == 'true'\n/, 'no pull request for a stale build');
  assert.match(j.record, /permissions:\n\s+contents: write[^\n]*\n\s+issues: write[^\n]*\n\s+pull-requests: write[^\n]*\n\s+steps:/);
  assert.match(j.record, /--publish "\$PUBLISH"/);
  const said = j.record.slice(j.record.indexOf('- name: A stale build or revision is said where it was asked for'));
  // A backlog task's first build has no issue or pull request to tell; the
  // PM reads the stale outcome from the ledger and stops for Eric.
  assert.match(said, /if: needs\.publish\.outputs\.state == 'stale' && needs\.reserve\.outputs\.notify != ''\n/);
  assert.match(said, /NUMBER: \$\{\{ needs\.reserve\.outputs\.notify \}\}\n/);
  assert.match(said, /NOTE: \$\{\{ needs\.publish\.outputs\.note \}\}\n/);
  assert.doesNotMatch(said.slice(said.indexOf('run: |')), /\$\{\{/, 'the note reaches the shell as data, never as text of the script');
  assert.deepEqual(secretsIn(j.record), []);
});

test('/revise: only Eric\'s own new comment on a pull request reserves, the revision\'s files are checked by hash, and a refusal is said as data', () => {
  const text = FILES[0][1];
  const j = jobs(text);
  assert.match(text, /^on:\n {2}issues:\n {4}types: \[labeled\]\n {2}issue_comment:\n {4}types: \[created\]\n/m, 'a new comment only, never an edit');
  assert.match(text, /group: agent-build-\$\{\{ github\.event_name == 'workflow_dispatch' && 'backlog' \|\| github\.event_name == 'issue_comment' && format\('comment-\{0\}', github\.event\.comment\.id\) \|\| github\.event\.issue\.number \}\}\n {2}cancel-in-progress: false\n/, 'a comment never cancels a running build');
  const cond = j.reserve.slice(j.reserve.indexOf('if:'), j.reserve.indexOf('runs-on:'));
  assert.match(cond, /github\.event_name == 'issue_comment' && github\.event\.issue\.pull_request &&/);
  assert.match(cond, /startsWith\(github\.event\.comment\.body, '\/revise'\) && github\.event\.comment\.user\.login == github\.repository_owner/);
  // The revision's task and issue travel as an artifact, used only at the hash reserve recorded.
  assert.match(j.reserve, /if: steps\.reserve\.outputs\.ok == 'true' && github\.event_name != 'issues'\n\s+with:\n\s+name: agent-reserve\n/);
  const b = j.build;
  assert.ok(b.indexOf('echo "${PROMPT_SHA256}  ${RUNNER_TEMP}/reserved/task.md" | sha256sum -c --quiet') < b.indexOf('- name: Build (sandboxed)'));
  assert.match(b, /- name: The task, from the issue as Eric labeled it\n\s+if: github\.event_name == 'issues'\n/);
  assert.match(j.publish, /echo "\$\{ISSUE_SHA256\}  \$\{RUNNER_TEMP\}\/reserved\/issue\.json" \| sha256sum -c --quiet/);
  assert.match(j.publish, /agent-guard\.js apply --base "\$BASE" [^\n]+ --issue "\$ISSUE" --pr "\$PR"\n/);
  // The title is the one reserve composed from the task it read.
  assert.match(j.publish, /TITLE: \$\{\{ needs\.reserve\.outputs\.pr_title \}\}\n/);
  assert.match(j.publish, /--title "\$TITLE"/);
  assert.doesNotMatch(text, /github\.event\.issue\.title/, 'the title comes from the issue reserve read, never the event (a comment\'s event is the pull request)');
  // A refusal of Eric's /revise is said on the pull request, a build that did
  // not start on the issue: no checkout, no secret, the note as data.
  assert.match(j.refused, /if: needs\.reserve\.outputs\.note != '' && github\.event_name != 'workflow_dispatch'\n/, 'a dispatch has no issue to answer');
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

// The repository went private on GitHub Pro (2026-10-27): a checkout made
// with persist-credentials: false leaves git no way in, and the agent checks'
// first fetch failed "could not read Username" on every pull request.
test('the repository is private: every git fetch from a checkout without credentials carries its job\'s token as a header, never in the git config', () => {
  const dir = path.join(ROOT, '.github', 'workflows');
  const AUTH = 'git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $(printf \'x-access-token:%s\' "$GH_TOKEN" | base64 -w0)" ';
  let seen = 0;
  for (const f of fs.readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const [id, job] of Object.entries(jobs(text))) {
      if (!/persist-credentials: false/.test(job) || /x-access-token:\$\{TOKEN\}@/.test(job)) continue;
      for (const step of job.split(/\n {6}- /)) {
        const lines = step.split('\n').filter((l) => /\bgit\b.*\b(fetch|ls-remote|push|pull)\b/.test(l) && !/^\s*#/.test(l));
        for (const l of lines) {
          seen += 1;
          assert.ok(l.trim().startsWith(AUTH), `${f} ${id}: ${l.trim()}`);
          assert.match(step, /\n\s+GH_TOKEN: \$\{\{ github\.token \}\}\n/, `${f} ${id}: the step holds the job's own token`);
        }
      }
      assert.doesNotMatch(job, /git config[^\n]*extraheader|git remote set-url[^\n]*GH_TOKEN/, `${f} ${id}: the token is never written to the git config`);
    }
  }
  assert.equal(seen, 4, 'agent-guard, agent-verify, and backlog-pr\'s pr and compose jobs');
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

test('agent-checks gives the neutral agent-review only to Eric\'s own change; any other change that is not a candidate waits as action_required (red-team review, 2026-10-27)', () => {
  const j = jobs(FILES[1][1])['agent-guard'];
  const steps = j.split(/\n {6}- /);
  const owner = steps.find((s) => s.startsWith('name: An owner change needs no model review'));
  const other = steps.find((s) => s.startsWith('name: Any other change waits for a review of its head'));
  assert.ok(owner && other);
  assert.match(owner, /if: steps\.guard\.outputs\.agent == 'false' && steps\.guard\.outputs\.owner == 'true'\n/);
  assert.match(owner, /-f conclusion=neutral /);
  assert.match(other, /if: steps\.guard\.outputs\.agent == 'false' && steps\.guard\.outputs\.owner != 'true'\n/);
  assert.match(other, /-f conclusion=action_required /);
  // The guard's words reach the shell as data, never inline.
  assert.match(other, /WHY: \$\{\{ steps\.guard\.outputs\.why \}\}\n/);
  assert.doesNotMatch(other.slice(other.indexOf('run: |')), /\$\{\{/);
});

// The post-review step's shell, as agent-review.yml holds it, run by bash with
// a fake gh on PATH: only the eric-reviewed branch, nothing sent anywhere.
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const BASH = process.platform === 'win32' ? (fs.existsSync(GIT_BASH) ? GIT_BASH : null) : 'bash';
test('eric-reviewed marks only the head Eric names, and only while the pull request is still at it (red-team review, 2026-10-27)', { skip: !BASH && 'no bash here; CI runs it' }, (t) => {
  const os = require('os');
  const { spawnSync } = require('child_process');
  const text = FILES[2][1];
  assert.match(text, /\n {6}head:\n {8}description: The head commit you reviewed[^\n]*\n {8}type: string\n/);
  const from = text.indexOf('          set -euo pipefail\n');
  const to = text.indexOf('          esac\n', from) + '          esac\n'.length;
  assert.ok(from > 0 && to > from);
  const shell = text.slice(from, to).split('\n').map((l) => l.slice(10)).join('\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-eric-reviewed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'step.sh'), shell);
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'gh'), '#!/bin/sh\nif [ "$1" = pr ] && [ "$2" = view ]; then printf \'%s\\n\' "$FAKE_LIVE_HEAD"; exit 0; fi\nif [ "$1" = api ]; then printf \'%s\\n\' "$*" >> "$FAKE_LOG"; exit 0; fi\nexit 9\n', { mode: 0o755 });
  const READ = 'a'.repeat(40);
  const log = path.join(dir, 'gh.log');
  const run = (o) => {
    fs.rmSync(log, { force: true });
    const r = spawnSync(BASH, [path.join(dir, 'step.sh')], { encoding: 'utf8', env: { ...process.env, PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH}`, EVENT: 'workflow_dispatch', MODE: 'eric-reviewed', PR_INPUT: '5', HEAD_INPUT: READ, TRIGGERING_ACTOR: 'kuaya1', OWNER: 'kuaya1', RUN_URL: 'https://example.invalid/run', GITHUB_REPOSITORY: 'kuaya1/FICTIONAL', FAKE_LIVE_HEAD: READ, FAKE_LOG: log, ...o } });
    return { status: r.status, out: `${r.stdout}${r.stderr}`, posted: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
  };
  const ok = run({});
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.posted, new RegExp(`-f head_sha=${READ} -f status=completed -f conclusion=neutral `));
  // Pushed to between Eric's reading and the dispatch: nothing marked.
  const moved = run({ FAKE_LIVE_HEAD: 'b'.repeat(40) });
  assert.equal(moved.status, 1);
  assert.match(moved.out, /#5 is at b{40} now, not the head you reviewed \(a{40}\); nothing marked/);
  assert.equal(moved.posted, '');
  for (const HEAD_INPUT of ['', 'a'.repeat(12), 'A'.repeat(40), `${READ}\n`]) {
    const bad = run({ HEAD_INPUT });
    assert.equal(bad.status, 1, JSON.stringify(HEAD_INPUT));
    assert.match(bad.out, /Name the full head commit you reviewed/);
    assert.equal(bad.posted, '');
  }
  const someone = run({ TRIGGERING_ACTOR: 'someone-else' });
  assert.equal(someone.status, 1);
  assert.equal(someone.posted, '');
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

// The PM builder (Eric, 2026-10-27; audits/2026-10-27-pm-builder).
test('the PM runs main\'s code only, one run at a time, with the OpenAI and ledger keys; the App key only sets a block on the branch', () => {
  const text = read('.github/workflows/agent-builder-lane.yml');
  for (const u of text.match(/uses:\s*\S+/g)) assert.match(u, /@[0-9a-f]{40}$/, u);
  assert.match(text, /^on:\n {2}schedule:\n {4}- cron: '0 \*\/6 \* \* \*'\n {2}workflow_dispatch:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_run:\n {4}workflows: \[test, agent-checks, agent-review\]\n {4}types: \[completed\]\n/m);
  assert.match(text, /^permissions: \{\}$/m);
  assert.match(text, /concurrency:\n {2}group: agent-pm\n {2}cancel-in-progress: false\n/);
  const j = jobs(text);
  assert.deepEqual(Object.keys(j), ['pm', 'status']);
  assert.deepEqual(secretsIn(j.pm), ['secrets.AGENT_LEDGER_KEY', 'secrets.OPENAI_API_KEY']);
  assert.match(j.pm, /permissions:\n\s+contents: write[^\n]*\n\s+actions: write[^\n]*\n\s+pull-requests: write[^\n]*\n\s+checks: read[^\n]*\n\s+outputs:/);
  assert.match(j.pm, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}\n/);
  assert.doesNotMatch(text, /ref: \$\{\{ github\.event\.(workflow_run\.head|pull_request\.head)/, 'never a candidate\'s code');
  assert.match(j.pm, /AGENT_PM_ENABLED: \$\{\{ vars\.AGENT_PM_ENABLED \}\}\n/);
  assert.match(j.pm, /run: node dashboard\/scripts\/agent-pm\.js run\n/);
  assert.match(j.status, /if: needs\.pm\.outputs\.block_head != ''\n/);
  assert.match(j.status, /permissions:\n\s+contents: read\n/);
  assert.match(j.status, /persist-credentials: false/);
  assert.deepEqual(secretsIn(j.status), ['secrets.BUILDER_APP_KEY']);
  assert.match(j.status, /permission-contents: write\n/);
  assert.doesNotMatch(j.status, /permission-(pull-requests|workflows|administration|actions|checks)/);
  assert.match(j.status, /agent-guard\.js status --issue "\$RUNNER_TEMP\/issue\.json" --to blocked --head "\$HEAD"/);
  for (const id of Object.keys(j)) assert.doesNotMatch(j[id].slice(j[id].indexOf('steps:')).split('run: ').slice(1).join('\n').split('\n').filter((l) => !/^\s+[A-Z_]+: \$\{\{/.test(l)).join('\n'), /\$\{\{ needs\.|\$\{\{ inputs\./, `${id}: outputs reach the shell as data`);
  assert.doesNotMatch(text, /gh pr (merge|review)|\/merge\b|auto-?merge|--approve/i, 'nothing here merges or approves');
  assert.doesNotMatch(read('.github/workflows/agent-build.yml'), /OPENAI/);
});

test('an eng-app@4 bundle is built by the lane in a sandbox with no network, and agent-verify requires it to be its source\'s build', () => {
  const b = jobs(FILES[0][1]).build;
  const step = b.slice(b.indexOf('- name: The browser bundle, built from the builder\'s source (eng-app@4)'), b.indexOf('- name: The change, as data'));
  assert.ok(b.indexOf('- name: Build (sandboxed)') < b.indexOf('- name: The browser bundle, built from'));
  assert.match(step, /if: needs\.reserve\.outputs\.template == 'eng-app@4'\n/);
  assert.match(step, /checkout "\$BASE" -- dashboard\/web\/package\.json dashboard\/web\/package-lock\.json dashboard\/web\/vite\.config\.js/, 'main\'s build files and lockfile');
  assert.match(step, /npm ci --prefix dashboard\/web --no-audit --no-fund --ignore-scripts\n/);
  assert.match(step, /bwrap --ro-bind \/ \/ --bind "\$GITHUB_WORKSPACE" "\$GITHUB_WORKSPACE" --tmpfs \/tmp --dev \/dev --proc \/proc \\\n\s+--unshare-all --die-with-parent /);
  assert.deepEqual(secretsIn(step), []);
  const v = jobs(FILES[1][1])['agent-verify'];
  const check = v.slice(v.indexOf('- name: The browser bundle is its source\'s build (eng-app@4)'));
  assert.ok(v.indexOf('- name: Verify on the merge tree') < v.indexOf('- name: The browser bundle is its source\'s build'));
  assert.match(check, /if: steps\.task\.outputs\.template == 'eng-app@4'\n/);
  assert.match(check, /cp "trusted\/dashboard\/web\/\$f" "candidate\/dashboard\/web\/\$f"/, 'main\'s build files, never the candidate\'s');
  assert.match(check, /git -C candidate status --porcelain -- dashboard\/public\/app/);
  assert.match(check, /::error title=agent-verify::/);
});

// GitHub starts no workflow for an event the default GITHUB_TOKEN makes, save
// workflow_dispatch and repository_dispatch (Eric, 2026-10-27, hardening rule
// 2). Every push and pull request the builder makes is the App's, so test,
// agent-checks, agent-review and the rulesets run on them: the job's checkout
// keeps no credential (git would send that header first and push as
// github.token), and the remote is the App's before anything is pushed.
// github.token writes only the ledger branch, which starts nothing, comments,
// and the PM's dispatch of agent-build.yml.
test('the builder pushes and opens pull requests with its App token only; github.token writes the ledger, comments and dispatches', () => {
  const stepsOf = (job) => job.split(/^ {6}- /m).slice(1);
  const lane = read('.github/workflows/agent-builder-lane.yml');
  for (const [f, job] of [['agent-build.yml publish', jobs(FILES[0][1]).publish], ['agent-builder-lane.yml status', jobs(lane).status]]) {
    const steps = stepsOf(job);
    const checkouts = steps.filter((s) => /actions\/checkout@/.test(s));
    assert.ok(checkouts.length, f);
    for (const s of checkouts) assert.match(s, /persist-credentials: false/, `${f}: git keeps no job token to fall back on`);
    assert.doesNotMatch(job, /github\.token|secrets\.GITHUB_TOKEN/, `${f}: never the default token`);
    assert.match(job, /private-key: \$\{\{ secrets\.BUILDER_APP_KEY \}\}/, f);
    const remote = steps.findIndex((s) => /git remote set-url origin/.test(s));
    assert.ok(remote >= 0, f);
    assert.match(steps[remote], /TOKEN: \$\{\{ steps\.app\.outputs\.token \}\}\n/, f);
    assert.match(steps[remote], /git remote set-url origin "https:\/\/x-access-token:\$\{TOKEN\}@github\.com\/\$\{GITHUB_REPOSITORY\}\.git"/, f);
    for (const re of [/agent-guard\.js publish/, /gh pr create/, /agent-guard\.js status/]) {
      const i = steps.findIndex((s) => re.test(s));
      if (i >= 0) assert.ok(i >= remote, `${f}: ${re} runs after the remote is the App's`);
    }
    for (const s of steps.filter((x) => /\bgh (pr|api)\b/.test(x))) assert.match(s, /GH_TOKEN: \$\{\{ steps\.app\.outputs\.token \}\}\n/, `${f}: gh as the App`);
  }
  assert.match(jobs(FILES[0][1]).publish, /gh pr create --repo "\$GITHUB_REPOSITORY" --head "\$BRANCH" --base main/);
  // What github.token pushes is the ledger branch, which no workflow listens to.
  assert.match(read('dashboard/scripts/agent-ledger.js'), /^const REF = 'refs\/heads\/agent-ledger';$/m);
  const dir = path.join(ROOT, '.github/workflows');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.yml'))) {
    const t = fs.readFileSync(path.join(dir, f), 'utf8');
    const on = t.slice(t.search(/^on:/m)).split(/\n(?=[a-z])/)[0];
    assert.doesNotMatch(on, /agent-ledger/, `${f} starts on nothing the ledger push makes`);
    for (const [id, job] of Object.entries(jobs(t))) {
      if (!/github\.token/.test(job)) continue;
      assert.doesNotMatch(job, /gh pr create|git push [^\n]*(agent\/|main)|x-access-token:\$\{\{ github\.token/, `${f} ${id}: github.token opens no pull request and pushes no candidate`);
    }
  }
  // The PM's one github.token event that starts a workflow: the dispatch.
  const pm = read('dashboard/scripts/agent-pm.js');
  assert.match(pm, /gh\.dispatch\(BUILD_WORKFLOW, 'main', inputs\)/);
  assert.match(pm, /^const BUILD_WORKFLOW = 'agent-build\.yml';$/m);
});

// Only the PM builds on a schedule (Eric, 2026-10-27, hardening rule 3). The
// other scheduled workflows build nothing: agent-review's sweep reviews, the
// Grok Scout reads the web. The old hourly builders (backlog-schedule.js) are
// Claude Code cloud routines in claude.ai, outside this repository.
test('only agent-builder-lane builds on a schedule; no workflow runs the old backlog scheduler', () => {
  const dir = path.join(ROOT, '.github/workflows');
  const all = fs.readdirSync(dir).filter((x) => x.endsWith('.yml')).sort().map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
  const onOf = (t) => t.slice(t.search(/^on:/m)).split(/\n(?=[a-z])/)[0];
  const scheduled = all.filter(([, t]) => /^ {2}schedule:/m.test(onOf(t))).map(([f]) => f);
  assert.deepEqual(scheduled, ['agent-builder-lane.yml', 'agent-review.yml', 'scout-cron.yml']);
  for (const [f, t] of all) {
    const code = t.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.doesNotMatch(code, /backlog-schedule\.js/, `${f} never runs the old scheduler (a comment may name it)`);
  }
  for (const f of ['agent-review.yml', 'scout-cron.yml']) {
    const t = all.find(([x]) => x === f)[1];
    assert.doesNotMatch(t, /agent-build\.yml|agent-pm\.js|claude-code|anthropic|dispatches|gh workflow run/i, `${f} builds and dispatches nothing`);
  }
  assert.match(read('dashboard/scripts/backlog-schedule.js'), /Deprecated \(Eric, 2026-10-27/);
});
