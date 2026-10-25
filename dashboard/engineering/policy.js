'use strict';
// Engineering delegation rules (Connected Engineering v1, Eric 2026-10-25;
// audits/2026-10-25-connected-engineering). Pure: no file, clock or network.
//
// A delegation is a template in this file that Eric activates on the desk
// (engineering/policies/). A task is inside it only when every check here
// places it there; anything else waits for Eric's authorization of that exact
// version. The checks are defense in depth, not proof that a change is safe:
// review and tests still decide.

const crypto = require('crypto');
const { PROTECTED } = require('../scripts/backlog-promote');

const REPO = 'kuaya1/CryptoResearch';
const INTENTS = ['explore', 'design', 'implement'];
const REVIEWS = ['none', 'claude', 'chatgpt', 'owner'];
const RELEASE_MODES = ['promote', 'owner'];
// Design work produces documents only.
const DESIGN_PATHS = ['docs/engineering/**'];
const MAX_ATTEMPTS = 3;
const LEASE_MS = 20 * 60 * 1000;

// Versioned and immutable once published: a changed rule is a new template.
const TEMPLATES = {
  'eng-docs@1': {
    template: 'eng-docs@1',
    title: 'Engineering documents',
    says: 'Small documentation tasks under docs/engineering/, merged with no click once the suite passes.',
    repo_full_name: REPO,
    intents: ['design', 'implement'],
    allowed_paths: ['docs/engineering/**'],
    required_review: 'none',
    release_mode: 'promote',
    limits: { max_open_tasks: 2, max_admissions_per_day: 3, max_files: 5 },
    max_days: 30,
    requires_goal: false,
  },
  'eng-app@1': {
    template: 'eng-app@1',
    title: 'Ordinary application work for one goal',
    says: 'Application code, tests and the browser app for the goal Eric names, each candidate reviewed by ChatGPT before it merges. The server\'s routes (Eric\'s own engineering controls among them) and protected paths always wait for Eric.',
    repo_full_name: REPO,
    intents: ['design', 'implement'],
    allowed_paths: ['dashboard/web/src/**', 'dashboard/public/**', 'dashboard/core/**', 'dashboard/views/**', 'dashboard/tests/**', 'dashboard/cli.js', 'docs/engineering/**'],
    required_review: 'chatgpt',
    release_mode: 'promote',
    limits: { max_open_tasks: 3, max_admissions_per_day: 5, max_files: 30 },
    max_days: 30,
    requires_goal: true,
  },
};

const sha256 = (s) => crypto.createHash('sha256').update(typeof s === 'string' ? s : JSON.stringify(s)).digest('hex');

// Canonical JSON: keys sorted, so the same content always hashes the same.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
const contentHash = (content) => sha256(canonical(content));

// Repository paths and globs: `*` within one segment, `**` across segments.
const PATH_RE = /^(?!\/)(?!.*\/\/)(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9._*\-/@]{1,160}$/;
function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i += 1;
      if (glob[i + 1] === '/') { i += 1; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
const matches = (p, globs) => globs.some((g) => globRe(g).test(p));
// Whether every path a task glob can name is inside a policy glob. Literal
// paths are tested; a glob is inside only a `dir/**` whose directory holds it.
function within(taskGlob, policyGlob) {
  if (!taskGlob.includes('*')) return globRe(policyGlob).test(taskGlob);
  if (policyGlob.endsWith('/**')) return taskGlob.startsWith(policyGlob.slice(0, -2));
  return taskGlob === policyGlob;
}
const protectedWhy = (p) => { const hit = PROTECTED.find((x) => x.re.test(p)); return hit ? hit.why : null; };
// One concrete path for every PROTECTED rule (a test keeps the two in step):
// a scope glob that matches any of them could reach a protected path.
const PROTECTED_SAMPLES = [
  '.github/workflows/x.yml', '.claude/agents/x.md', 'CLAUDE.md', 'COWORK-INSTRUCTIONS.md', 'DESK_STATE.md',
  'dashboard/scripts/backlog-promote.js', 'dashboard/scripts/backlog-intake.js', 'dashboard/scripts/merge-train.js', 'dashboard/scripts/engineering-worker.js',
  'dashboard/oauth.js', 'dashboard/mcp.js', 'dashboard/hosted.js', 'server.js',
  'dashboard/core/portfolio.js', 'dashboard/core/wallets.js', 'dashboard/core/walletsync.js', 'dashboard/core/alchemy.js',
  'package.json', 'package-lock.json', 'dashboard/web/package.json', 'dashboard/web/package-lock.json', 'render.yaml', 'render.yml',
  'portfolio/x.json', 'paper/x.jsonl', 'projects/x/project.json', 'config/settings.json', 'secrets/x.json',
  'dashboard/engineering/inbox.js', 'dashboard/engineering/x.js',
];
function globTouchesProtected(glob) {
  if (!glob.includes('*')) return protectedWhy(glob);
  const re = globRe(glob);
  const hit = PROTECTED_SAMPLES.find((p) => re.test(p));
  return hit ? protectedWhy(hit) : null;
}

// Private or sensitive content never reaches the public backlog. Matches are
// said in words, never echoed.
const SCREENS = [
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, why: 'an e-mail address' },
  { re: /\b0x[0-9a-fA-F]{16,}\b/, why: 'a chain address or hash' },
  { re: /\b[0-9a-fA-F]{32,}\b/, why: 'a long hexadecimal string (a key, hash or address)' },
  { re: /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}|\bghp_|\bgithub_pat_|\bxox[abpr]-|\bAKIA[0-9A-Z]{12,}|-----BEGIN/, why: 'something shaped like a credential' },
  // A token: 32 or more characters with upper case, lower case and digits
  // (as mcp.js redactLog reads them), so a long path is not one.
  { test: (t) => (t.match(/[A-Za-z0-9+_-]{32,}={0,2}/g) || []).some((m) => /[A-Z]/.test(m) && /[a-z]/.test(m) && /\d/.test(m)), why: 'a long token-like string' },
  { re: /\bhttps?:\/\/|\bwww\./i, why: 'a web address (keep links in the private instruction)' },
  { re: /(?:\+\d{1,3}[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/, why: 'a phone number' },
  { re: /[$\u20ac\u00a3]\s?\d|\b\d[\d,.]*\s?(?:USD|USDC|USDT|BTC|ETH|SOL)\b/i, why: 'an amount of money (holdings and client figures stay private)' },
  { re: /\b(?:password|passphrase|api[ _-]?key|secret[ _-]?key|seed phrase|private key)\b/i, why: 'a credential word' },
  // eslint-disable-next-line no-control-regex
  { re: /[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/, why: 'a control character' },
];
function screen(text) {
  const out = [];
  for (const s of SCREENS) if (s.test ? s.test(String(text)) : s.re.test(String(text))) out.push(s.why);
  return out;
}

// Normalized content of one task version (what is hashed and approved).
const LIMITS = { title: 120, outcome: 600, item: 300, items: 8, paths: 12, goal: 80, instruction: 20000 };
function cleanLine(s) {
  return String(s === undefined || s === null ? '' : s).replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
}
function contentOf(a) {
  const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]).map(cleanLine).filter(Boolean);
  const scope = a.scope && typeof a.scope === 'object' && !Array.isArray(a.scope) ? a.scope : { paths: a.scope };
  return {
    repo_full_name: cleanLine(a.repo_full_name || REPO),
    goal_id: a.goal_id ? cleanLine(a.goal_id) : null,
    parent_backlog_id: a.parent_backlog_id === undefined || a.parent_backlog_id === null || a.parent_backlog_id === '' ? null : Number(a.parent_backlog_id),
    intent: cleanLine(a.intent).toLowerCase(),
    title: cleanLine(a.title).replace(/[*`]/g, ''),
    outcome: cleanLine(a.outcome),
    scope: { paths: list(scope.paths).map((p) => p.replace(/^\.\//, '')) },
    non_goals: list(a.non_goals),
    acceptance: list(a.acceptance),
    dependencies: list(a.dependencies),
    required_review: cleanLine(a.required_review || 'none').toLowerCase(),
    release_mode: cleanLine(a.release_mode || 'promote').toLowerCase(),
    reviews_requested: list(a.reviews_requested).map((x) => x.toLowerCase()),
  };
}

// Problems that make a version unusable at all (said in words).
function validateContent(c) {
  const bad = [];
  if (c.repo_full_name !== REPO) bad.push(`repository ${c.repo_full_name || '(none)'} is not one this desk builds (only ${REPO})`);
  if (!INTENTS.includes(c.intent)) bad.push(`intent must be one of ${INTENTS.join(', ')}`);
  if (!c.title) bad.push('a title is needed');
  if (c.title.length > LIMITS.title) bad.push(`the title is over ${LIMITS.title} characters`);
  if (c.intent !== 'explore') {
    if (!c.outcome) bad.push('an outcome is needed');
    if (!c.acceptance.length) bad.push('at least one acceptance check is needed');
    if (!c.scope.paths.length) bad.push('scope.paths is needed: the repository paths the work may change');
  }
  if (c.outcome.length > LIMITS.outcome) bad.push(`the outcome is over ${LIMITS.outcome} characters`);
  for (const [k, v] of [['acceptance', c.acceptance], ['non_goals', c.non_goals], ['dependencies', c.dependencies], ['reviews_requested', c.reviews_requested]]) {
    if (v.length > LIMITS.items) bad.push(`${k} has more than ${LIMITS.items} entries`);
    if (v.some((x) => x.length > LIMITS.item)) bad.push(`an entry of ${k} is over ${LIMITS.item} characters`);
  }
  if (c.scope.paths.length > LIMITS.paths) bad.push(`scope.paths has more than ${LIMITS.paths} entries`);
  for (const p of c.scope.paths) if (!PATH_RE.test(p)) bad.push(`scope path ${JSON.stringify(p.slice(0, 80))} is not a repository path`);
  if (!REVIEWS.includes(c.required_review)) bad.push(`required_review must be one of ${REVIEWS.join(', ')}`);
  if (!RELEASE_MODES.includes(c.release_mode)) bad.push(`release_mode must be one of ${RELEASE_MODES.join(', ')}`);
  for (const r of c.reviews_requested) if (!['claude', 'chatgpt', 'gemini'].includes(r)) bad.push(`reviews_requested may name claude, chatgpt or gemini, not ${r.slice(0, 20)}`);
  if (c.goal_id && !/^[a-z0-9][a-z0-9-]{1,78}$/.test(c.goal_id)) bad.push('goal_id is lower-case letters, digits and hyphens');
  if (c.parent_backlog_id !== null && !(Number.isInteger(c.parent_backlog_id) && c.parent_backlog_id > 0)) bad.push('parent_backlog_id is a backlog number');
  for (const d of c.dependencies) if (!/^(eng-\d{8}-[0-9a-f]{6}|\d{1,5})$/.test(d)) bad.push(`dependency ${JSON.stringify(d.slice(0, 40))} is neither a task ID nor a backlog number`);
  const text = [c.title, c.outcome, ...c.acceptance, ...c.non_goals, ...c.scope.paths, c.goal_id || ''].join('\n');
  for (const why of screen(text)) bad.push(`the public part holds ${why}`);
  return [...new Set(bad)];
}

// Whether a valid version sits inside an active delegation; reasons in words.
function fits(policy, c, { now, openUnderPolicy = 0, admittedLastDay = 0 } = {}) {
  const r = [];
  if (!policy) return ['no delegation is active'];
  if (policy.revoked_at) r.push(`delegation ${policy.policy_id} was revoked`);
  if (Date.parse(policy.expires_at) <= now) r.push(`delegation ${policy.policy_id} expired ${policy.expires_at}`);
  if (c.repo_full_name !== policy.repo_full_name) r.push('another repository');
  if (!policy.intents.includes(c.intent)) r.push(`intent ${c.intent} is not delegated`);
  if (policy.goal_id && c.goal_id !== policy.goal_id) r.push(`the delegation covers goal ${policy.goal_id}${c.goal_id ? `, not ${c.goal_id}` : ''}`);
  const allowed = c.intent === 'design' ? DESIGN_PATHS.filter((d) => policy.allowed_paths.some((p) => within(d, p))) : policy.allowed_paths;
  for (const p of c.scope.paths) {
    const why = globTouchesProtected(p);
    if (why) r.push(`${p} can reach a protected path (${why})`);
    else if (!allowed.some((g) => within(p, g))) r.push(`${p} is outside the delegated paths`);
  }
  // A lighter declared review or release is no miss: the delegation's own
  // applies (boundaries below).
  if (openUnderPolicy >= policy.limits.max_open_tasks) r.push(`the delegation already has ${openUnderPolicy} open ${openUnderPolicy === 1 ? 'task' : 'tasks'} (limit ${policy.limits.max_open_tasks})`);
  if (admittedLastDay >= policy.limits.max_admissions_per_day) r.push(`the delegation admitted ${admittedLastDay} in the last day (limit ${policy.limits.max_admissions_per_day})`);
  return r;
}

// Reviews in REVIEWS order of strength (owner is Eric's own and counts for
// any); release by Eric is stricter than promotion. An unknown value counts
// as the strictest, a missing one has no say.
function stricterReview(...rs) {
  let out = 'none';
  for (const r of rs) {
    if (r === null || r === undefined) continue;
    const k = REVIEWS.includes(r) ? r : 'owner';
    if (REVIEWS.indexOf(k) > REVIEWS.indexOf(out)) out = k;
  }
  return out;
}
const stricterRelease = (...ms) => (ms.some((m) => m !== null && m !== undefined && m !== 'promote') ? 'owner' : 'promote');

// What a version is held to inside a delegation it fits: the stricter of its
// declared review and release and the delegation's, and the delegation's
// limits (max_files is checked on each candidate).
function boundaries(policy, c) {
  return {
    required_review: stricterReview(c.required_review, policy.required_review),
    review_basis: { declared: c.required_review, delegation: policy.required_review },
    release_mode: stricterRelease(c.release_mode, policy.release_mode),
    limits: policy.limits,
  };
}

// Which of the delegations a version fits it is admitted under (MATCH_RULE):
// the narrowest, then the lightest. In order: (1) the fewest other fitting
// delegations whose paths lie inside its own, so one inside another always
// comes first; (2) the lighter review it requires; (3) release by promotion
// before release by Eric; (4) fewer path rules; (5) the template name;
// (6) the delegation ID. Each key is the delegation's own, so the order the
// delegations were activated or listed in never decides.
const MATCH_RULE = 'cr-eng-match@1';
const MATCH_KEYS = ['paths', 'review', 'release', 'path_rules', 'template', 'policy_id'];
const pathsInside = (a, b) => a.allowed_paths.every((g) => b.allowed_paths.some((h) => within(g, h)));
const reviewRank = (r) => (REVIEWS.includes(r) ? REVIEWS.indexOf(r) : REVIEWS.length);
function choose(fitting) {
  if (!fitting.length) return null;
  const inside = (p) => fitting.filter((q) => q !== p && pathsInside(q, p) && !pathsInside(p, q)).length;
  const ranked = fitting.map((p) => ({ p, k: [inside(p), reviewRank(p.required_review), p.release_mode === 'promote' ? 0 : 1, p.allowed_paths.length, p.template, p.policy_id] }));
  ranked.sort((a, b) => { const i = a.k.findIndex((x, j) => x !== b.k[j]); return i < 0 ? 0 : a.k[i] < b.k[i] ? -1 : 1; });
  const [{ p }, next] = ranked;
  if (!next) return { policy: p, ranked: [p], decided_by: 'only', why: 'the only active delegation it fits' };
  const q = next.p;
  const by = MATCH_KEYS[ranked[0].k.findIndex((x, j) => x !== next.k[j])];
  const why = {
    paths: pathsInside(p, q) ? `its paths lie inside those of ${q.template} (${q.policy_id}), which it also fits` : `its paths hold fewer of the delegations it fits than ${q.template}'s (${q.policy_id})`,
    review: `it requires the lighter review (${p.required_review}; ${q.template} requires ${q.required_review})`,
    release: `it releases by promotion; ${q.template} releases only by Eric`,
    path_rules: `it has fewer path rules than ${q.template} (${p.allowed_paths.length} against ${q.allowed_paths.length})`,
    template: `as narrow and as light as ${q.template}; the template name decides`,
    policy_id: `the same template as ${q.policy_id}; the delegation ID decides`,
  }[by];
  return { policy: p, ranked: ranked.map((x) => x.p), decided_by: by, why: `first of the ${ranked.length} active delegations it fits: ${why}` };
}

// The exact backlog entry an admission adds to DESK_STATE.md (LF endings,
// trailing newline). Public: sanitized scope, acceptance and the binding.
function entryText({ number, task_id, version, content_sha256, policy_id, content }) {
  const auth = policy_id ? `delegation ${policy_id}` : 'authorized by Eric';
  const lines = [
    `- [ ] **${number}. ${content.title}** *(engineering task ${task_id} v${version}, sha256 ${content_sha256.slice(0, 16)}, ${auth}; built only through the engineering lane)*`,
    `  - Outcome: ${content.outcome}`,
    ...content.acceptance.map((a) => `  - Acceptance: ${a}`),
    `  - Scope: ${content.scope.paths.map((p) => `\`${p}\``).join(', ')}`,
  ];
  if (content.non_goals.length) lines.push(...content.non_goals.map((n) => `  - Not in scope: ${n}`));
  return `${lines.join('\n')}\n`;
}
const ENTRY_MARK_RE = /\*\(engineering task (eng-\d{8}-[0-9a-f]{6}) v(\d+), sha256 ([0-9a-f]{16})/;

module.exports = {
  REPO, INTENTS, REVIEWS, RELEASE_MODES, TEMPLATES, DESIGN_PATHS, MAX_ATTEMPTS, LEASE_MS, LIMITS,
  sha256, canonical, contentHash, globRe, matches, within, protectedWhy, globTouchesProtected, PROTECTED_SAMPLES,
  screen, contentOf, validateContent, fits, entryText, ENTRY_MARK_RE, PATH_RE,
  stricterReview, stricterRelease, boundaries, choose, MATCH_RULE, MATCH_KEYS,
};
