'use strict';
// Reads GitHub's live merge boundary for the repository and compares it with
// the ruleset files in .github/rulesets (exclusive merge authority, Eric,
// 2026-10-26; audits/2026-10-26-engineering-simplification). Read-only: it
// changes no setting and attempts no push or merge; the destructive probes
// ran on a separate test repository.
//
//   node dashboard/scripts/merge-boundary-check.js [--repo kuaya1/CryptoResearch]
//
// It holds when every file's ruleset is active and identical, main's update
// rule is bypassed by the repository admin role only and only through a pull
// request, the merge requirements have no bypass, the repository is public
// (GitHub Free enforces rulesets on public repositories only), Eric is the
// only admin, and workflow tokens default to read.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const OWNER_BYPASS = { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' };
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
const same = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
const bypassKey = (b) => `${b.actor_type}:${b.actor_id}:${b.bypass_mode}`;
// GitHub returns parameters the files leave out (newer options at their
// defaults) and drops some it treats as default: a file's parameter matches
// when GitHub holds the same value, or holds none and the file's is a default.
const isDefault = (v) => v === false || v === 0 || v === null || (Array.isArray(v) && !v.length);
function paramsMatch(want = {}, got = {}) {
  return Object.keys(want).every((k) => (k in got ? same(want[k], got[k]) : isDefault(want[k])));
}
function rulesDiffer(want = [], got = []) {
  const out = [];
  const types = (rs) => rs.map((r) => r.type).sort();
  if (!same(types(want), types(got))) out.push(`rule types are ${JSON.stringify(types(got))}, the file says ${JSON.stringify(types(want))}`);
  for (const w of want) {
    const g = got.find((r) => r.type === w.type);
    if (g && !paramsMatch(w.parameters, g.parameters)) out.push(`${w.type} parameters are ${JSON.stringify(sortKeys(g.parameters || {}))}, the file says ${JSON.stringify(sortKeys(w.parameters || {}))}`);
  }
  return out;
}

function loadFiles(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

// What GitHub returns for a ruleset, reduced to the fields the files state.
function shapeOf(r) {
  return {
    enforcement: r.enforcement,
    target: r.target,
    include: [...((r.conditions && r.conditions.ref_name && r.conditions.ref_name.include) || [])].sort(),
    exclude: [...((r.conditions && r.conditions.ref_name && r.conditions.ref_name.exclude) || [])].sort(),
    bypass: (r.bypass_actors || []).map(bypassKey).sort(),
  };
}

function check({ files, live }) {
  const problems = [];
  const notes = [];
  const byName = new Map((live.rulesets || []).map((r) => [r.name, r]));
  for (const want of files) {
    const got = byName.get(want.name);
    if (!got) { problems.push(`ruleset ${want.name} is not on the repository`); continue; }
    const a = shapeOf(want);
    const b = shapeOf(got);
    for (const k of Object.keys(a)) if (!same(a[k], b[k])) problems.push(`ruleset ${want.name}: ${k} is ${JSON.stringify(b[k])}, the file says ${JSON.stringify(a[k])}`);
    for (const d of rulesDiffer(want.rules, got.rules)) problems.push(`ruleset ${want.name}: ${d}`);
  }
  const authority = byName.get('main-merge-authority');
  if (authority) {
    if (!(authority.rules || []).some((r) => r.type === 'update')) problems.push('main-merge-authority has no update rule: any writer can update main');
    for (const b of authority.bypass_actors || []) if (bypassKey(b) !== bypassKey(OWNER_BYPASS)) problems.push(`main-merge-authority lets ${bypassKey(b)} update main; only the admin role, through a pull request, may`);
  }
  // Any other active ruleset on the default branch that someone could bypass
  // is reported: it exempts from its own rules only, never from the update rule.
  for (const r of live.rulesets || []) {
    if (files.some((f) => f.name === r.name) || r.enforcement !== 'active') continue;
    if ((r.bypass_actors || []).length) notes.push(`another active ruleset, ${r.name}, has bypass actors ${r.bypass_actors.map(bypassKey).join(', ')}`);
  }
  if (live.repo.visibility !== 'public' && !live.repo.plan_supports_private_rulesets) problems.push(`the repository is ${live.repo.visibility}: GitHub Free enforces rulesets on public repositories only, so the boundary would not hold`);
  const admins = (live.collaborators || []).filter((c) => c.permissions && c.permissions.admin).map((c) => c.login);
  const others = admins.filter((l) => l !== live.repo.owner);
  if (others.length) problems.push(`other admins can merge into main through the admin bypass: ${others.join(', ')}`);
  if (live.workflow && live.workflow.default_workflow_permissions !== 'read') problems.push(`workflow tokens default to ${live.workflow.default_workflow_permissions}; set Read repository contents`);
  if (live.workflow && live.workflow.can_approve_pull_request_reviews) notes.push('GitHub Actions may approve pull requests; approval is not merge authority here, but turning it off is tidier');
  if (live.classic_protection) notes.push('classic branch protection is also set on main; the rulesets are the boundary');
  const effective = (live.effective || []).map((r) => r.type);
  for (const t of ['update', 'pull_request', 'required_status_checks', 'non_fast_forward', 'deletion']) if (!effective.includes(t)) problems.push(`GitHub does not apply a ${t} rule to main`);
  return { ok: problems.length === 0, problems, notes, admins };
}

function readLive(gh, repo) {
  const j = (args, fallback) => { const r = gh(args); if (r.status !== 0) return fallback; try { return JSON.parse(r.out); } catch (_) { return fallback; } };
  const meta = j(['api', `repos/${repo}`], {});
  const list = j(['api', `repos/${repo}/rulesets`], []);
  return {
    repo: { visibility: meta.visibility || (meta.private ? 'private' : 'public'), owner: meta.owner && meta.owner.login },
    rulesets: list.map((r) => j(['api', `repos/${repo}/rulesets/${r.id}`], r)),
    collaborators: j(['api', `repos/${repo}/collaborators?affiliation=all&per_page=100`], []),
    workflow: j(['api', `repos/${repo}/actions/permissions/workflow`], null),
    classic_protection: gh(['api', `repos/${repo}/branches/${meta.default_branch || 'main'}/protection`]).status === 0,
    effective: j(['api', `repos/${repo}/rules/branches/${meta.default_branch || 'main'}`], []),
  };
}

function main(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) flags[argv[i].replace(/^--/, '')] = argv[i + 1];
  const repo = flags.repo || 'kuaya1/CryptoResearch';
  const dir = flags.dir || path.join(__dirname, '..', '..', '.github', 'rulesets');
  const gh = (args) => { const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }); return { status: r.status, out: String(r.stdout || '') }; };
  const r = check({ files: loadFiles(dir), live: readLive(gh, repo) });
  const lines = [r.ok ? `Merge boundary holds on ${repo}: only ${r.admins.join(', ') || 'the owner'} can update main, through a pull request with the required checks.` : `Merge boundary does NOT hold on ${repo}:`, ...r.problems.map((p) => `- ${p}`), ...r.notes.map((n) => `  note: ${n}`)];
  process.stdout.write(`${lines.join('\n')}\n`);
  return r.ok ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { OWNER_BYPASS, loadFiles, shapeOf, paramsMatch, check, readLive };
