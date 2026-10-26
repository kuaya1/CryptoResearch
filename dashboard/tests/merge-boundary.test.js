'use strict';
// The merge boundary as files (exclusive merge authority, Eric, 2026-10-26;
// audits/2026-10-26-engineering-simplification): the ruleset files say that
// only the repository admin role updates main, only through a pull request,
// with the required checks and no bypass of them; the read-only checker finds
// every way the live settings could differ. FICTIONAL live data; no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const MB = require('../scripts/merge-boundary-check');

const FILES = MB.loadFiles(path.join(__dirname, '..', '..', '.github', 'rulesets'));
const byName = (n) => FILES.find((f) => f.name === n);
const clone = (v) => JSON.parse(JSON.stringify(v));

// What GitHub returns once the files are applied: ids, extra default
// parameters, and the update rule's default dropped (as observed on the probe
// repository, 2026-10-26).
function liveOf(files = FILES) {
  const rulesets = files.map((f, i) => {
    const r = clone(f);
    r.id = 1000 + i;
    for (const rule of r.rules) {
      if (rule.type === 'update') delete rule.parameters;
      if (rule.type === 'pull_request') Object.assign(rule.parameters, { require_extra_approval_for_unattributed_changes: true, required_reviewers: [] });
    }
    return r;
  });
  return {
    repo: { visibility: 'public', owner: 'eric-fictional' },
    rulesets,
    collaborators: [{ login: 'eric-fictional', permissions: { admin: true } }],
    workflow: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false },
    classic_protection: false,
    effective: ['update', 'deletion', 'non_fast_forward', 'pull_request', 'required_status_checks'].map((type) => ({ type })),
  };
}

test('the files: only the admin role updates main, through a pull request; the requirements and the ledger have no bypass', () => {
  const authority = byName('main-merge-authority');
  assert.deepEqual(authority.rules.map((r) => r.type), ['update']);
  assert.deepEqual(authority.bypass_actors, [MB.OWNER_BYPASS]);
  assert.deepEqual(authority.conditions.ref_name.include, ['~DEFAULT_BRANCH']);
  const req = byName('main-merge-requirements');
  assert.deepEqual(req.bypass_actors, []);
  const pr = req.rules.find((r) => r.type === 'pull_request').parameters;
  assert.equal(pr.required_approving_review_count, 0, 'approval is not the boundary; merge authority is');
  assert.deepEqual(pr.allowed_merge_methods, ['merge'], 'a merge commit keeps the tested tree');
  const checks = req.rules.find((r) => r.type === 'required_status_checks').parameters;
  assert.equal(checks.strict_required_status_checks_policy, true, 'the head contains main, so the merge is the tested tree');
  assert.deepEqual(checks.required_status_checks.map((c) => c.context).sort(), ['agent-guard', 'agent-review', 'agent-verify', 'test']);
  for (const c of checks.required_status_checks) assert.equal(c.integration_id, 15368, `${c.context} counts only from GitHub Actions`);
  const ledger = byName('agent-ledger');
  assert.deepEqual(ledger.rules.map((r) => r.type).sort(), ['deletion', 'non_fast_forward']);
  assert.deepEqual(ledger.bypass_actors, []);
  const confine = byName('automation-branches');
  assert.ok(confine.conditions.ref_name.exclude.includes('refs/heads/agent/**'));
  assert.deepEqual(confine.bypass_actors, [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }]);
});

test('the checker holds for the files as GitHub returns them', () => {
  const r = MB.check({ files: FILES, live: liveOf() });
  assert.equal(r.ok, true, r.problems.join('\n'));
  assert.deepEqual(r.admins, ['eric-fictional']);
});

test('the checker refuses every weakening: a widened bypass, evaluate mode, a missing check, a private repository, another admin, write tokens', () => {
  const cases = [
    ['bypass widened to the write role', (l) => { l.rulesets.find((r) => r.name === 'main-merge-authority').bypass_actors.push({ actor_id: 4, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' }); }, /lets RepositoryRole:4:pull_request update main/],
    ['admin bypass on direct pushes', (l) => { l.rulesets.find((r) => r.name === 'main-merge-authority').bypass_actors[0].bypass_mode = 'always'; }, /bypass is/],
    ['an App as bypass actor', (l) => { l.rulesets.find((r) => r.name === 'main-merge-authority').bypass_actors.push({ actor_id: 999, actor_type: 'Integration', bypass_mode: 'pull_request' }); }, /Integration:999/],
    ['evaluate only', (l) => { l.rulesets.find((r) => r.name === 'main-merge-authority').enforcement = 'evaluate'; }, /enforcement is "evaluate"/],
    ['the update rule removed', (l) => { l.rulesets.find((r) => r.name === 'main-merge-authority').rules = []; }, /has no update rule/],
    ['a required check dropped', (l) => { const p = l.rulesets.find((r) => r.name === 'main-merge-requirements').rules.find((r) => r.type === 'required_status_checks').parameters; p.required_status_checks = p.required_status_checks.filter((c) => c.context !== 'agent-review'); }, /required_status_checks parameters/],
    ['a check from any app', (l) => { const p = l.rulesets.find((r) => r.name === 'main-merge-requirements').rules.find((r) => r.type === 'required_status_checks').parameters; delete p.required_status_checks[0].integration_id; }, /required_status_checks parameters/],
    ['squash allowed', (l) => { l.rulesets.find((r) => r.name === 'main-merge-requirements').rules.find((r) => r.type === 'pull_request').parameters.allowed_merge_methods = ['merge', 'squash']; }, /pull_request parameters/],
    ['the ledger rewritable', (l) => { l.rulesets.find((r) => r.name === 'agent-ledger').rules = [{ type: 'deletion' }]; }, /agent-ledger: rule types/],
    ['a ruleset missing', (l) => { l.rulesets = l.rulesets.filter((r) => r.name !== 'main-merge-requirements'); }, /main-merge-requirements is not on the repository/],
    ['private on GitHub Free', (l) => { l.repo.visibility = 'private'; }, /enforces rulesets on public repositories only/],
    ['another admin', (l) => { l.collaborators.push({ login: 'helper-fictional', permissions: { admin: true } }); }, /other admins can merge into main/],
    ['write tokens by default', (l) => { l.workflow.default_workflow_permissions = 'write'; }, /workflow tokens default to write/],
    ['no rule applied to main', (l) => { l.effective = []; }, /does not apply a update rule/],
  ];
  for (const [name, mutate, want] of cases) {
    const live = liveOf();
    mutate(live);
    const r = MB.check({ files: FILES, live });
    assert.equal(r.ok, false, name);
    assert.match(r.problems.join('\n'), want, name);
  }
});

test('a GitHub default the files leave out is not a difference, a different value is', () => {
  assert.equal(MB.paramsMatch({ update_allows_fetch_and_merge: false }, {}), true);
  assert.equal(MB.paramsMatch({ update_allows_fetch_and_merge: false }, { update_allows_fetch_and_merge: true }), false);
  assert.equal(MB.paramsMatch({ required_approving_review_count: 0 }, { required_approving_review_count: 0, required_reviewers: [] }), true);
  assert.equal(MB.paramsMatch({ allowed_merge_methods: ['merge'] }, {}), false, 'a stated non-default must be there');
});
