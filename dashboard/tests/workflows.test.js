'use strict';
// The repository's workflows after the agent lane was retired (Eric,
// 2026-10-27; docs/CONSTITUTION.md, audits/2026-10-27-de-escalation): test is
// the one required check, it runs main's suite on every pull request with a
// read-only token and no secret, and no workflow writes to the repository or
// holds a model key but the Scout's own. Read as text.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, '.github', 'workflows');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const WORKFLOWS = fs.readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);
const secretsIn = (text) => [...new Set(text.match(/secrets\.[A-Z_]+/g) || [])].sort();

test('two workflows: the suite and the Scout', () => {
  assert.deepEqual(WORKFLOWS.map(([f]) => f), ['scout-cron.yml', 'test.yml']);
});

test('test runs the full suite on main and on every pull request to main, reads the repository only, holds no secret, and pins its actions', () => {
  const t = read('.github/workflows/test.yml');
  assert.match(t, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n {4}branches: \[main\]\n\n/m);
  assert.match(t, /^permissions:\n {2}contents: read\n\n/m);
  assert.match(t, /^jobs:\n {2}test:\n/m);
  assert.match(t, /run: node dashboard\/cli\.js test/);
  assert.deepEqual(secretsIn(t), []);
  for (const u of t.match(/uses:\s*\S+/g)) assert.match(u, /@[0-9a-f]{40}$/, u);
});

test('the ruleset requires test alone, from GitHub Actions, with no bypass', () => {
  const rules = JSON.parse(read('.github/rulesets/main-merge-requirements.json'));
  assert.deepEqual(rules.bypass_actors, []);
  const checks = rules.rules.find((r) => r.type === 'required_status_checks').parameters;
  assert.deepEqual(checks.required_status_checks, [{ context: 'test', integration_id: 15368 }]);
  assert.equal(checks.strict_required_status_checks_policy, true);
  assert.deepEqual(rules.rules.find((r) => r.type === 'pull_request').parameters.allowed_merge_methods, ['merge']);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, '.github', 'rulesets')).sort(), ['README.md', 'agent-ledger.json', 'main-merge-authority.json', 'main-merge-requirements.json']);
});

test('no workflow writes to the repository, caches, or holds a model or builder key; the Scout holds only its own', () => {
  for (const [f, text] of WORKFLOWS) {
    assert.doesNotMatch(text, /^\s+[a-z-]+: write\s*$/m, `${f} writes nothing`);
    assert.doesNotMatch(text, /^\s*cache(-dependency-path)?:/m, f);
    assert.doesNotMatch(text, /uses:\s*actions\/cache[@/]/, f);
    assert.doesNotMatch(text, /ANTHROPIC|OPENAI|BUILDER_APP|AGENT_LEDGER|GATE_APP|CR_ENG_REVIEWER/, f);
  }
  assert.deepEqual(secretsIn(WORKFLOWS.find(([f]) => f === 'scout-cron.yml')[1]), ['secrets.DESK_INGEST_KEY', 'secrets.DESK_INGEST_URL', 'secrets.XAI_API_KEY']);
});
