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
