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
    rulesets_read: { http: 200, message: null },
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

// What GitHub Free answers a private repository's rulesets read (the probe
// repository, 2026-10-26).
const FREE_403 = { http: 403, message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.' };

test('the checker refuses every weakening: a widened bypass, evaluate mode, a missing check, a private repository on GitHub Free, another admin, write tokens', () => {
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
    ['private on GitHub Free', (l) => { l.repo.visibility = 'private'; l.rulesets_read = { ...FREE_403 }; }, /the repository is private: GitHub Free enforces rulesets on public repositories only/],
    ['private with the rulesets read not confirmed', (l) => { l.repo.visibility = 'private'; delete l.rulesets_read; }, /answered the rulesets read with no HTTP status/],
    ['the rulesets read refused on a public repository', (l) => { l.rulesets_read = { http: 500, message: null }; }, /answered the rulesets read with HTTP 500: the live rulesets could not be compared/],
    ['the visibility unread', (l) => { l.repo.visibility = null; }, /visibility could not be read \(null\)/],
    ['the visibility missing', (l) => { delete l.repo.visibility; }, /visibility could not be read \(null\)/],
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

test('a private repository on GitHub Pro holds once GitHub answers the rulesets read with HTTP 200, and says so; the 200 alone is not enough', () => {
  const live = liveOf();
  live.repo.visibility = 'private';
  const r = MB.check({ files: FILES, live });
  assert.equal(r.ok, true, r.problems.join('\n'));
  assert.ok(r.notes.some((n) => /^the repository is private: GitHub answered the rulesets read with HTTP 200, so the account's plan \(GitHub Pro or above\) enforces them/.test(n)), r.notes.join('\n'));
  // The same repository answered 403 (a lapse to GitHub Free): one reason for
  // the read, in GitHub's words, one for the plan, never each file "missing".
  const free = liveOf();
  free.repo.visibility = 'private';
  free.rulesets_read = { ...FREE_403 };
  const f = MB.check({ files: FILES, live: free });
  assert.equal(f.ok, false);
  assert.ok(f.problems.includes('GitHub answered the rulesets read with HTTP 403 ("Upgrade to GitHub Pro or make this repository public to enable this feature."): the live rulesets could not be compared with the files'), f.problems.join('\n'));
  assert.ok(f.problems.some((p) => /holds the boundary only on GitHub Pro or above/.test(p)));
  assert.doesNotMatch(f.problems.join('\n'), /is not on the repository/);
  assert.equal(f.notes.length, 0);
  // A 200 with nothing applied to main, or a weakened file, still fails.
  const bare = liveOf();
  bare.repo.visibility = 'private';
  bare.effective = [];
  assert.match(MB.check({ files: FILES, live: bare }).problems.join('\n'), /GitHub does not apply a update rule to main/);
  const loose = liveOf();
  loose.repo.visibility = 'private';
  loose.rulesets.find((x) => x.name === 'main-merge-authority').enforcement = 'evaluate';
  assert.equal(MB.check({ files: FILES, live: loose }).ok, false);
});

// gh as the checker calls it: --include prints the status line, the headers,
// a blank line and the body, on success and on a refusal alike (as gh 2.96
// does, 2026-10-27); without it, the body on success only.
function fakeGh(routes) {
  const calls = [];
  const gh = (args) => {
    calls.push(args.join(' '));
    const include = args.includes('--include');
    const [http, body] = routes[args[args.length - 1]] || [404, { message: 'Not Found' }];
    const ok = http >= 200 && http < 300;
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { status: ok ? 0 : 1, out: include ? `HTTP/2.0 ${http} Status\nContent-Type: application/json; charset=utf-8\r\nX-Github-Api-Version-Selected: 2022-11-28\r\n\r\n${text}` : ok ? text : '' };
  };
  gh.calls = calls;
  return gh;
}
const REPO = 'eric-fictional/desk-fictional';
function routesOf(live, meta) {
  const routes = {
    [`repos/${REPO}`]: [200, meta],
    [`repos/${REPO}/rulesets`]: [200, live.rulesets.map((r) => ({ id: r.id, name: r.name }))],
    [`repos/${REPO}/collaborators?affiliation=all&per_page=100`]: [200, live.collaborators],
    [`repos/${REPO}/actions/permissions/workflow`]: [200, live.workflow],
    [`repos/${REPO}/rules/branches/main`]: [200, live.effective],
  };
  for (const r of live.rulesets) routes[`repos/${REPO}/rulesets/${r.id}`] = [200, r];
  return routes;
}

test('readLive takes the rulesets read\'s HTTP status from GitHub: a private repository on GitHub Pro holds end to end, the same on GitHub Free does not', () => {
  const meta = { visibility: 'private', private: true, owner: { login: 'eric-fictional' }, default_branch: 'main' };
  const gh = fakeGh(routesOf(liveOf(), meta));
  const live = MB.readLive(gh, REPO);
  assert.ok(gh.calls.includes(`api --include repos/${REPO}/rulesets`), gh.calls.join('\n'));
  assert.deepEqual(live.repo, { visibility: 'private', owner: 'eric-fictional' });
  assert.deepEqual(live.rulesets_read, { http: 200, message: null });
  assert.equal(live.classic_protection, false);
  assert.deepEqual(live.rulesets.map((r) => r.name), liveOf().rulesets.map((r) => r.name));
  const pro = MB.check({ files: FILES, live });
  assert.equal(pro.ok, true, pro.problems.join('\n'));
  assert.ok(pro.notes.some((n) => /private: GitHub answered the rulesets read with HTTP 200/.test(n)));

  const freeRoutes = routesOf(liveOf(), meta);
  freeRoutes[`repos/${REPO}/rulesets`] = [403, { message: FREE_403.message, documentation_url: 'https://docs.github.com/rest/repos/rules#get-all-repository-rulesets', status: '403' }];
  freeRoutes[`repos/${REPO}/rules/branches/main`] = [403, { message: FREE_403.message }];
  const freeGh = fakeGh(freeRoutes);
  const freeLive = MB.readLive(freeGh, REPO);
  assert.deepEqual(freeLive.rulesets_read, FREE_403);
  assert.deepEqual(freeLive.rulesets, []);
  assert.ok(!freeGh.calls.some((c) => /rulesets\/\d/.test(c)), 'no ruleset is read after a refusal');
  const free = MB.check({ files: FILES, live: freeLive });
  assert.equal(free.ok, false);
  assert.match(free.problems.join('\n'), /HTTP 403 \("Upgrade to GitHub Pro/);
});

test('readLive never assumes public, and a 200 that is not a list is not a reading', () => {
  const routes = routesOf(liveOf(), { private: false, owner: { login: 'eric-fictional' } });
  assert.equal(MB.readLive(fakeGh(routes), REPO).repo.visibility, 'public', 'the private flag alone is read');
  delete routes[`repos/${REPO}`];
  const unread = MB.readLive(fakeGh(routes), REPO);
  assert.equal(unread.repo.visibility, null, 'a failed repository read has no visibility');
  assert.match(MB.check({ files: FILES, live: unread }).problems.join('\n'), /visibility could not be read/);
  routes[`repos/${REPO}`] = [200, { visibility: 'public', owner: { login: 'eric-fictional' } }];
  routes[`repos/${REPO}/rulesets`] = [200, { unexpected: true }];
  const odd = MB.readLive(fakeGh(routes), REPO);
  assert.deepEqual(odd.rulesets_read, { http: null, message: null });
  assert.equal(MB.check({ files: FILES, live: odd }).ok, false);
  // The status line, the headers and the body, as gh prints them.
  assert.deepEqual(MB.readWithStatus(() => ({ status: 1, out: 'HTTP/2.0 404 Not Found\nServer: github.com\r\n\r\n{"message":"Branch not protected","status":"404"}' }), 'x'), { http: 404, body: { message: 'Branch not protected', status: '404' } });
  assert.deepEqual(MB.readWithStatus(() => ({ status: 1, out: '' }), 'x'), { http: null, body: null });
});

test('a GitHub default the files leave out is not a difference, a different value is', () => {
  assert.equal(MB.paramsMatch({ update_allows_fetch_and_merge: false }, {}), true);
  assert.equal(MB.paramsMatch({ update_allows_fetch_and_merge: false }, { update_allows_fetch_and_merge: true }), false);
  assert.equal(MB.paramsMatch({ required_approving_review_count: 0 }, { required_approving_review_count: 0, required_reviewers: [] }), true);
  assert.equal(MB.paramsMatch({ allowed_merge_methods: ['merge'] }, {}), false, 'a stated non-default must be there');
});
