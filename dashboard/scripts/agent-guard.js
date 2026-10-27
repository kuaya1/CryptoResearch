'use strict';
// The agent lane's trusted guard (Eric, 2026-10-26;
// audits/2026-10-26-engineering-simplification). It runs only from main's
// own checkout and reads everything the builder produced as data.
//
//   reserve   an issue labeled agent:build by Eric (the event's sender is the
//             repository owner, a user): the task in the issue form is read
//             and checked against its template, and one paid build is
//             reserved in the ledger for this run before anything is sent
//   prompt    the builder's task text, from the issue as Eric labeled it
//   apply     the build artifact's patch, applied to main in a scratch index:
//             the resulting tree is what is checked and what is committed;
//             a patch or a builder's report that holds a key-shaped string
//             (agent-secrets.js) is refused, naming where, never the value
//   publish   that tree as one commit by the builder App, with the task's
//             trailers, pushed to agent/issue-<n>
//   record    the build attempt's outcome in the ledger
//   pr        the agent-guard check on a pull request: an agent candidate's
//             commits, its task (still labeled, unchanged since the build)
//             and its change against the template; an owner change passes
//   task-of   the task an agent candidate builds, for agent-verify
//
// The checks are defense in depth: the tests, the behavioral verification,
// the model review and Eric's merge still decide.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('../engineering/policy');
const BP = require('./backlog-promote');
const L = require('./agent-ledger');
const S = require('./agent-secrets');

const POLICY_FILE = path.join(__dirname, '..', '..', '.github', 'agent-policy.json');
const loadPolicy = (file = POLICY_FILE) => JSON.parse(fs.readFileSync(file, 'utf8'));
const SHA_RE = /^[0-9a-f]{40}$/;
const LINK_MODES = { 120000: 'a symbolic link', 160000: 'a submodule' };
const FIELDS = { template: 'Template', outcome: 'Outcome', acceptance: 'Acceptance checks', negative: 'Negative cases', tests: 'Regression tests', paths: 'Files to change', notes: 'Notes' };
const TEST_PATH_RE = /dashboard\/tests\/[A-Za-z0-9._/-]+\.test\.js/g;
const TRAILERS = { 'Agent-Task': 'issue', 'Agent-Task-SHA256': 'task_sha256', 'Agent-Template': 'template', 'Agent-Run': 'run' };

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
function git(cwd, args, { input, env = {} } = {}) {
  const r = spawnSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } });
  if (r.error) throw r.error;
  return { status: r.status, out: String(r.stdout || '').trim(), raw: String(r.stdout || ''), err: String(r.stderr || '').trim() };
}
const oneLine = (s, n = 100) => String(s || '').replace(/[\u0000-\u001f\u007f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// GitHub issue forms arrive as "### Label" sections; an empty answer is
// "_No response_".
function parseIssueForm(body) {
  const out = {};
  for (const part of String(body || '').replace(/\r\n?/g, '\n').split(/^### +/m).slice(1)) {
    const nl = part.indexOf('\n');
    const head = (nl < 0 ? part : part.slice(0, nl)).trim();
    let value = nl < 0 ? '' : part.slice(nl + 1).trim();
    if (value === '_No response_') value = '';
    out[head] = value;
  }
  return out;
}
const listOf = (text) => String(text || '').split('\n').map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/`/g, '').trim()).filter(Boolean);

// The task as the issue states it, checked against its template. Problems
// are reasons a build is refused; the issue is never edited by the lane.
function taskOf(issue, { policy = loadPolicy() } = {}) {
  const f = parseIssueForm(issue.body);
  const problems = [];
  const template = oneLine(f[FIELDS.template], 40);
  const tpl = P.TEMPLATES[template];
  if (!tpl || P.RETIRED[template] || !policy.templates[template]) problems.push(`the template "${template || 'none'}" is not one the agent lane builds (${Object.keys(policy.templates).join(', ')})`);
  for (const k of ['outcome', 'acceptance', 'negative', 'tests', 'paths']) if (!String(f[FIELDS[k]] || '').trim()) problems.push(`"${FIELDS[k]}" is empty`);
  const paths = listOf(f[FIELDS.paths]).map((l) => l.split(/\s+/)[0]);
  const tests = [...new Set(String(f[FIELDS.tests] || '').match(TEST_PATH_RE) || [])];
  if (tpl) {
    if (paths.length > tpl.limits.max_files) problems.push(`${paths.length} files to change; ${template} takes at most ${tpl.limits.max_files}`);
    for (const p of paths) {
      if (!P.PATH_RE.test(p)) { problems.push(`"${oneLine(p, 80)}" is not a repository path or glob`); continue; }
      if (!tpl.allowed_paths.some((a) => P.within(p, a))) problems.push(`${p} is outside ${template} (${tpl.allowed_paths.join(', ')})`);
      const fb = P.forbiddenHit(p, { template });
      if (fb) problems.push(`${p} reaches ${fb}, which ${template} never changes`);
      const prot = P.globTouchesProtected(p);
      if (prot) problems.push(`${p} can reach a protected path (${prot}); that is Eric's own change, not an agent build`);
      const r = P.restrictedWhy(p, template);
      if (r) problems.push(`${p} reaches ${r}, which ${template} does not reach`);
    }
    const testGlob = tpl.requires_tests || P.TEST_FILES;
    if (tpl.requires_tests && !tests.length) problems.push(`"${FIELDS.tests}" names no test file under dashboard/tests/ (${template} needs one)`);
    for (const t of tests) {
      if (!P.globRe(testGlob).test(t)) problems.push(`${t} is not a test file ${template} runs (${testGlob})`);
      if (BP.protectedHit(t) || BP.restrictedFor(t, template)) problems.push(`${t} is a guarded test the lane never changes; name a test of the outcome`);
    }
  }
  for (const w of P.screen(`${issue.title || ''}\n${f[FIELDS.outcome] || ''}`).filter((x) => !/web address|e-mail/.test(x))) problems.push(`the title or outcome holds ${w}; keep it out of the public repository`);
  return {
    number: issue.number,
    title: oneLine(issue.title),
    body_sha256: sha256(String(issue.body || '')),
    template,
    outcome: String(f[FIELDS.outcome] || '').trim(),
    acceptance: String(f[FIELDS.acceptance] || '').trim(),
    negative: String(f[FIELDS.negative] || '').trim(),
    tests,
    paths,
    notes: String(f[FIELDS.notes] || '').trim(),
    implementation: tpl && policy.templates[template] ? policy.templates[template].implementation : [],
    problems: [...new Set(problems)],
  };
}

// Only Eric's own label authorizes a build: an App or a workflow token that
// adds it is the event's sender, and is refused.
function authorize(event, { policy = loadPolicy() } = {}) {
  const reasons = [];
  const owner = event.repository && event.repository.owner && event.repository.owner.login;
  const sender = event.sender || {};
  if (event.action !== 'labeled' || !event.label || event.label.name !== policy.label) reasons.push(`not the ${policy.label} label being added`);
  if (!owner || sender.login !== owner || sender.type !== 'User') reasons.push(`the label was added by ${sender.login || 'unknown'} (${sender.type || 'unknown'}), not by the repository owner: only Eric's own label authorizes a build`);
  if (!event.issue || event.issue.pull_request) reasons.push('not an issue');
  else if (event.issue.state !== 'open') reasons.push('the issue is closed');
  return reasons;
}
const buildBinding = (task, base) => ({ kind: 'build', issue: task.number, task_sha256: task.body_sha256, base });

// Every changed path between `base` and `rev` (a commit or a tree), with modes.
function changesOf(cwd, base, rev) {
  const raw = git(cwd, ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', base, rev]).raw.split('\0');
  const out = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])/.exec(raw[i]);
    if (m) out.push({ path: raw[i + 1], oldMode: m[1], newMode: m[2], status: m[3], binary: false });
  }
  const num = git(cwd, ['diff', '--numstat', '-z', '--no-renames', base, rev]).raw.split('\0');
  for (const rec of num) {
    const m = /^-\t-\t(.+)$/.exec(rec);
    const c = m && out.find((x) => x.path === m[1]);
    if (c) c.binary = true;
  }
  return out;
}
const existsAt = (cwd, rev, p) => git(cwd, ['cat-file', '-e', `${rev}:${p}`]).status === 0;

// The change against its task and template: the same rules at the build
// artifact (a tree) and at the pull request (a commit).
function checkChange({ cwd, base, rev, task }) {
  const reasons = [];
  const tpl = P.TEMPLATES[task.template];
  if (!tpl) return { ok: false, reasons: [`no template ${task.template}`], files: [] };
  const ch = changesOf(cwd, base, rev);
  if (!ch.length) reasons.push('the change is empty');
  if (ch.length > tpl.limits.max_files) reasons.push(`${ch.length} files changed; ${task.template} takes at most ${tpl.limits.max_files}`);
  const folded = new Map();
  for (const c of ch) {
    const p = c.path;
    const f = BP.foldPath(p);
    if (folded.has(f) && folded.get(f) !== p) reasons.push(`${p} and ${folded.get(f)} are one file on Windows`);
    folded.set(f, p);
    const w = BP.windowsProblem(p);
    if (w) reasons.push(`${p}: ${w}`);
    const link = LINK_MODES[c.newMode] || LINK_MODES[c.oldMode];
    if (link) reasons.push(`${p} is ${link}`);
    if (c.newMode === '100755' && c.oldMode !== '100755') reasons.push(`${p} becomes executable`);
    if (c.binary) reasons.push(`${p} is a binary change`);
    const prot = BP.protectedHit(p);
    if (prot) reasons.push(`${p}: ${prot.why} (protected; Eric's own change)`);
    const r = BP.restrictedFor(p, task.template);
    if (r) reasons.push(`${p}: ${r.why}; ${task.template} does not reach it`);
    if (!P.matches(p, tpl.allowed_paths)) reasons.push(`${p} is outside ${task.template}`);
    const fb = (tpl.forbidden_paths || []).find((g) => P.globRe(g).test(p));
    if (fb) reasons.push(`${p} is forbidden for ${task.template} (${fb})`);
    if (!task.paths.some((g) => P.globRe(g).test(p)) && !task.tests.includes(p)) reasons.push(`${p} is not among the task's files to change`);
  }
  const diff = git(cwd, ['diff', '--binary', '--full-index', '--no-renames', base, rev]).raw;
  const sections = P.diffSections(diff);
  for (const c of ch) { const why = P.protectedLineWhy(c.path, diff, sections); if (why) reasons.push(`${c.path} changes ${why}`); }
  if (tpl.requires_tests && !ch.some((c) => c.status !== 'D' && P.globRe(tpl.requires_tests).test(c.path))) reasons.push(`${task.template} needs every candidate to add or change a test (${tpl.requires_tests})`);
  for (const t of task.tests) if (!existsAt(cwd, rev, t)) reasons.push(`the task's regression test ${t} is not in the candidate`);
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], files: ch.map((c) => c.path) };
}

// The build artifact's patch on main, in a scratch index: never a checkout of
// the builder's files, never its hooks. Returns the tree it makes.
function applyPatch({ cwd, base, patchFile, maxBytes }) {
  const buf = fs.readFileSync(patchFile);
  if (buf.length > maxBytes) return { error: `the patch is ${buf.length} bytes, over ${maxBytes}` };
  const text = buf.toString('utf8');
  if (/^GIT binary patch$/m.test(text) || /^Binary files .* differ$/m.test(text)) return { error: 'the patch carries a binary change' };
  const keys = S.patchHits(text);
  if (keys.length) return { error: `the patch holds a key-shaped string at ${keys.map(S.describe).join(', ')}; nothing is published, and the value is not shown` };
  const index = path.join(os.tmpdir(), `agent-index-${crypto.randomBytes(6).toString('hex')}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    const rt = git(cwd, ['read-tree', base], { env });
    if (rt.status !== 0) return { error: `main ${String(base).slice(0, 12)} could not be read: ${rt.err.slice(0, 160)}` };
    if (buf.length) {
      const ap = git(cwd, ['apply', '--cached', '--whitespace=nowarn', patchFile], { env });
      if (ap.status !== 0) return { error: `the patch does not apply to main ${String(base).slice(0, 12)}: ${ap.err.slice(0, 300)}` };
    }
    const tree = git(cwd, ['write-tree'], { env }).out;
    return { tree };
  } finally {
    fs.rmSync(index, { force: true });
  }
}

const botIdentity = (name, email) => ({ GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email });
function commitMessage(task, { run, policy }) {
  return [
    `agent: ${task.title} (#${task.number})`,
    '',
    `Built by the agent lane from issue #${task.number} (${task.template}). Eric merges it; no agent merges or approves.`,
    '',
    `Agent-Task: #${task.number}`,
    `Agent-Task-SHA256: ${task.body_sha256}`,
    `Agent-Template: ${task.template}`,
    `Agent-Run: ${run}`,
    `Generated-By: Claude Code ${policy.build.claude_code} (${policy.build.model})`,
  ].join('\n');
}
// One commit of `tree` on `base` by the builder App, pushed to its branch.
// The push is by lease on what the branch held, read back from the remote.
function publish({ cwd, base, tree, task, run, botName, botEmail, branch, remote = 'origin', policy = loadPolicy() }) {
  const c = git(cwd, ['commit-tree', tree, '-p', base, '-m', commitMessage(task, { run, policy })], { env: botIdentity(botName, botEmail) });
  if (c.status !== 0 || !SHA_RE.test(c.out)) return { error: `the commit could not be made: ${c.err.slice(0, 200)}` };
  const ref = `refs/heads/${branch}`;
  const before = git(cwd, ['ls-remote', remote, ref]).out.split(/\s+/)[0] || '';
  const p = git(cwd, ['push', '--porcelain', `--force-with-lease=${ref}:${before}`, remote, `${c.out}:${ref}`]);
  const after = git(cwd, ['ls-remote', remote, ref]).out.split(/\s+/)[0] || '';
  if (after !== c.out) return { error: `the branch reads ${after.slice(0, 12) || 'nothing'} after the push (${p.err.slice(0, 200)})`, commit: c.out };
  return { commit: c.out, branch, replaced: before || null };
}

// The commits of a pull request on its merge base.
function commitsOf(cwd, base, head) {
  const r = git(cwd, ['log', '--format=%H%x00%P%x00%an <%ae>%x00%cn <%ce>%x00%T%x00%B%x1e', `${base}..${head}`]);
  if (r.status !== 0) return null;
  return r.raw.split('\x1e').map((x) => x.replace(/^\n/, '')).filter((x) => x.trim()).map((rec) => {
    const [sha, parents, author, committer, tree, body = ''] = rec.split('\x00');
    return { sha, parents: parents.split(' ').filter(Boolean), author, committer, tree, body };
  });
}
const botEmailOf = (login) => (login ? `+${login}@users.noreply.github.com>` : null);
// An agent candidate: its branch, its author or any of its commits is the
// builder's. Anything else is an owner change, which the agent checks pass.
function isAgentPr({ branch, author, botLogin, commits, policy = loadPolicy() }) {
  if (String(branch || '').startsWith(policy.branch_prefix.split('/')[0] + '/')) return true;
  if (botLogin && author === botLogin) return true;
  const e = botEmailOf(botLogin);
  return Boolean(e && (commits || []).some((c) => c.author.endsWith(e) || c.committer.endsWith(e)));
}
function trailersOf(body) {
  const out = {};
  for (const line of String(body || '').split('\n')) {
    const m = /^([A-Za-z0-9-]+):\s*(.+)$/.exec(line.trim());
    if (m && TRAILERS[m[1]]) out[TRAILERS[m[1]]] = m[2].trim();
  }
  if (out.issue) out.issue = Number(String(out.issue).replace(/^#/, '')) || null;
  return out;
}
// A merge commit that adds nothing of its own (GitHub's "Update branch").
function pureMerge(cwd, c) {
  if (c.parents.length !== 2) return false;
  const m = git(cwd, ['merge-tree', '--write-tree', c.parents[0], c.parents[1]]);
  return m.status === 0 && m.out.split('\n')[0] === c.tree;
}

// The agent-guard check of a pull request.
async function prCheck({ cwd, base, head, branch, author, botLogin, issueOf, policy = loadPolicy() }) {
  const mb = git(cwd, ['merge-base', base, head]).out;
  if (!SHA_RE.test(mb)) return { agent: null, ok: false, reasons: ['the pull request\'s merge base with main could not be read'] };
  const commits = commitsOf(cwd, mb, head) || [];
  if (!isAgentPr({ branch, author, botLogin, commits, policy })) return { agent: false, ok: true, reasons: [], says: 'Owner change: not an agent candidate, so the agent checks do not apply. The required tests still do.' };
  const reasons = [];
  const e = botEmailOf(botLogin);
  let trailers = null;
  for (const c of commits) {
    if (c.parents.length > 1) { if (!pureMerge(cwd, c)) reasons.push(`merge commit ${c.sha.slice(0, 12)} adds changes of its own`); continue; }
    if (!e || !c.author.endsWith(e) || !c.committer.endsWith(e)) reasons.push(`commit ${c.sha.slice(0, 12)} is not the builder App's (${oneLine(c.author, 80)})`);
    const t = trailersOf(c.body);
    if (!trailers) trailers = t;
    else if (JSON.stringify(t) !== JSON.stringify(trailers)) reasons.push(`commit ${c.sha.slice(0, 12)} names another task or run`);
  }
  if (!trailers || !trailers.issue || !/^[0-9a-f]{64}$/.test(trailers.task_sha256 || '')) return { agent: true, ok: false, reasons: [...reasons, 'no Agent-Task and Agent-Task-SHA256 trailers'] };
  const issue = await issueOf(trailers.issue);
  if (!issue) return { agent: true, ok: false, reasons: [...reasons, `issue #${trailers.issue} could not be read`], trailers };
  if (issue.state !== 'open') reasons.push(`issue #${trailers.issue} is closed`);
  if (!(issue.labels || []).some((l) => (l.name || l) === policy.label)) reasons.push(`issue #${trailers.issue} no longer has the ${policy.label} label`);
  const task = taskOf(issue, { policy });
  if (task.body_sha256 !== trailers.task_sha256) reasons.push(`issue #${trailers.issue} was edited after this build (the build was of version ${trailers.task_sha256.slice(0, 12)}); add the label again to build the new version`);
  if (task.template !== trailers.template) reasons.push(`the task's template is ${task.template}, the build says ${trailers.template}`);
  reasons.push(...task.problems);
  const ch = checkChange({ cwd, base: mb, rev: head, task });
  reasons.push(...ch.reasons);
  return { agent: true, ok: reasons.length === 0, reasons: [...new Set(reasons)], trailers, task, merge_base: mb, files: ch.files };
}

// The builder's task text. The issue is Eric's; it is still marked as task
// data, and the standing rules come from builder-rules.md.
function builderPrompt(task) {
  return [
    `Build issue #${task.number} of kuaya1/CryptoResearch in this checkout (template ${task.template}). Work only in the files the task names; when the change is done, stop. Do not commit, push or open anything: the lane commits your working tree after you finish.`,
    '',
    '<task>',
    `Title: ${task.title}`,
    '',
    `Outcome:\n${task.outcome}`,
    '',
    `Acceptance checks:\n${task.acceptance}`,
    '',
    `Negative cases (each one needs a test that fails when it is not handled):\n${task.negative}`,
    '',
    `Regression tests to add or change: ${task.tests.join(', ') || 'none named'}`,
    `Files you may change: ${task.paths.join(', ')}`,
    ...(task.notes ? ['', `Notes:\n${task.notes}`] : []),
    '</task>',
  ].join('\n');
}

function prBody(task, { build = {}, commit, runUrl }) {
  const fence = (s) => String(s || '').replace(/```/g, "'''").slice(0, 3000);
  return [
    `Agent build of #${task.number} (${task.template}), commit \`${commit}\`${runUrl ? ` ([the build run](${runUrl}))` : ''}.`,
    '',
    `**Outcome:** ${oneLine(task.outcome, 600)}`,
    '',
    `Required before Eric merges: \`test\`, \`agent-guard\`, \`agent-verify\` and \`agent-review\`. No agent merges or approves this pull request.`,
    '',
    '<details><summary>What the builder reported (unverified)</summary>',
    '',
    '```text',
    fence(`turns ${build.num_turns ?? '?'}, reported cost $${build.total_cost_usd ?? '?'}, ${build.is_error ? 'ended with an error' : 'finished'}\n\n${build.result || ''}`),
    '```',
    '</details>',
    '',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  ].join('\n');
}

// --- GitHub reads (GH_TOKEN) ----------------------------------------------
function githubApi({ token, repo, fetchImpl = globalThis.fetch }) {
  const call = async (method, p, body) => {
    const res = await fetchImpl(`https://api.github.com${p}`, { method, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { json = null; }
    return { status: res.status, json };
  };
  return {
    issue: async (n) => { const r = await call('GET', `/repos/${repo}/issues/${n}`); return r.status === 200 ? r.json : null; },
    pull: async (n) => { const r = await call('GET', `/repos/${repo}/pulls/${n}`); return r.status === 200 ? r.json : null; },
    pullsForSha: async (sha) => { const r = await call('GET', `/repos/${repo}/commits/${sha}/pulls`); return r.status === 200 && Array.isArray(r.json) ? r.json : []; },
    createCheck: async (o) => { const r = await call('POST', `/repos/${repo}/check-runs`, o); return { ok: r.status === 201, status: r.status, id: r.json && r.json.id }; },
  };
}

// --- CLI ---------------------------------------------------------------------
function out(flat, text) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(flat).map(([k, v]) => `${k}=${String(v === null || v === undefined ? '' : v).replace(/[\r\n]+/g, ' ')}\n`).join(''));
  if (text && process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n\n`);
  if (text) process.stdout.write(`${text}\n`);
}
const eventOf = (flags) => JSON.parse(fs.readFileSync(flags.event || process.env.GITHUB_EVENT_PATH, 'utf8'));

async function main(argv, { now = () => Date.now(), cwd = process.cwd() } = {}) {
  const [cmd, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) flags[rest[i].replace(/^--/, '')] = rest[i + 1];
  const policy = loadPolicy();
  if (cmd === 'reserve') {
    const ev = eventOf(flags);
    const reasons = authorize(ev, { policy });
    const task = ev.issue ? taskOf(ev.issue, { policy }) : null;
    if (task) reasons.push(...task.problems);
    if (reasons.length) { out({ ok: false }, `### Not built\n\n${reasons.map((r) => `- ${r}`).join('\n')}`); return 0; }
    const base = flags.base;
    const bind = buildBinding(task, base);
    const run = `${process.env.GITHUB_RUN_ID}/${process.env.GITHUB_RUN_ATTEMPT}`;
    const d = L.transact(cwd, { decide: (entries) => L.decideBuild(entries, { binding: L.bindingOf(bind), bind, ceilings: policy.ceilings, now: now(), usd: policy.build.max_budget_usd, run }), message: `build reserve #${task.number}` });
    if (d.error || d.action !== 'build') { out({ ok: false }, `### Not built\n\n- ${d.error || d.why}`); return 0; }
    out({ ok: true, reservation: d.id, attempt: process.env.GITHUB_RUN_ATTEMPT, number: task.number, template: task.template, task_sha256: task.body_sha256 }, `Build of #${task.number} (${task.template}) reserved as ${d.id}: at most $${policy.build.max_budget_usd}.`);
    return 0;
  }
  if (cmd === 'prompt') {
    const task = taskOf(eventOf(flags).issue, { policy });
    fs.writeFileSync(flags.out, builderPrompt(task));
    return 0;
  }
  if (cmd === 'apply') {
    const task = taskOf(eventOf(flags).issue, { policy });
    const report = flags.build && fs.existsSync(flags.build) ? S.secretHits(fs.readFileSync(flags.build, 'utf8')) : [];
    if (report.length) { out({ ok: false }, `### Not published\n\n- the builder's report holds a key-shaped string at ${report.map((h) => S.describe({ path: path.basename(flags.build), ...h })).join(', ')}; the value is not shown`); return 1; }
    const a = applyPatch({ cwd, base: flags.base, patchFile: flags.patch, maxBytes: policy.build.max_patch_bytes });
    if (a.error) { out({ ok: false }, `### Not published\n\n- ${a.error}`); return 1; }
    const ch = checkChange({ cwd, base: flags.base, rev: a.tree, task });
    if (!ch.ok) { out({ ok: false }, `### Not published: the build's change is outside its task\n\n${ch.reasons.map((r) => `- ${r}`).join('\n')}`); return 1; }
    out({ ok: true, tree: a.tree }, `The build's change applies to main and stays inside #${task.number} (${ch.files.length} ${ch.files.length === 1 ? 'file' : 'files'}).`);
    return 0;
  }
  if (cmd === 'publish') {
    const task = taskOf(eventOf(flags).issue, { policy });
    const p = publish({ cwd, base: flags.base, tree: flags.tree, task, run: flags.run, botName: flags['bot-name'], botEmail: flags['bot-email'], branch: `${policy.branch_prefix}${task.number}`, policy });
    if (p.error) { out({ ok: false }, `### Not published\n\n- ${p.error}`); return 1; }
    out({ ok: true, commit: p.commit, branch: p.branch }, `Published ${p.commit.slice(0, 12)} to ${p.branch}${p.replaced ? ` (replacing ${p.replaced.slice(0, 12)})` : ''}.`);
    fs.writeFileSync(flags['body-out'], prBody(task, { build: flags.build && fs.existsSync(flags.build) ? JSON.parse(fs.readFileSync(flags.build, 'utf8')) : {}, commit: p.commit, runUrl: flags['run-url'] }));
    return 0;
  }
  if (cmd === 'record') {
    let build = {};
    try { build = flags.build && fs.existsSync(flags.build) ? JSON.parse(fs.readFileSync(flags.build, 'utf8')) : {}; } catch (_) { build = {}; }
    const reported = Number(build.total_cost_usd);
    const rec = { t: 'outcome', id: flags.id, state: flags.outcome === 'success' ? 'response' : 'unknown', job: oneLine(flags.outcome, 20), reported_usd: Number.isFinite(reported) ? reported : undefined, at: new Date(now()).toISOString() };
    const r = L.transact(cwd, { decide: () => ({ append: [rec] }), message: `build outcome ${flags.id}` });
    out({}, r.error ? `### The build's outcome was not recorded\n\n- ${r.error}\n\nIts reservation still counts in full.` : `Build ${flags.id}: ${rec.job}${rec.reported_usd !== undefined ? `, reported $${rec.reported_usd}` : ''}.`);
    return r.error ? 1 : 0;
  }
  if (cmd === 'pr' || cmd === 'task-of') {
    const gh = githubApi({ token: process.env.GH_TOKEN, repo: process.env.GITHUB_REPOSITORY });
    const r = await prCheck({ cwd, base: flags.base, head: flags.head, branch: flags.branch, author: flags.author, botLogin: process.env.BUILDER_APP_SLUG ? `${process.env.BUILDER_APP_SLUG}[bot]` : null, issueOf: gh.issue, policy });
    if (cmd === 'task-of') {
      fs.writeFileSync(flags.out, JSON.stringify(r.agent ? { agent: true, ok: r.ok, template: r.task && r.task.template, tests: r.task ? r.task.tests : [], implementation: r.task ? r.task.implementation : [], merge_base: r.merge_base } : { agent: r.agent }, null, 2));
      return 0;
    }
    out({ agent: r.agent, ok: r.ok }, r.agent === false ? r.says : r.ok ? `Agent candidate for #${r.trailers.issue} (${r.task.template}): its commits, its task and its change hold.` : `### Agent candidate refused\n\n${r.reasons.map((x) => `- ${x}`).join('\n')}`);
    return r.ok ? 0 : 1;
  }
  process.stderr.write('Usage: agent-guard.js reserve|prompt|apply|publish|record|pr|task-of …\n');
  return 2;
}

if (require.main === module) main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (err) => { process.stderr.write(`agent-guard: ${String((err && err.message) || err).slice(0, 400)}\n`); process.exitCode = 1; });

module.exports = { FIELDS, loadPolicy, parseIssueForm, taskOf, authorize, buildBinding, changesOf, checkChange, applyPatch, commitMessage, publish, commitsOf, isAgentPr, trailersOf, pureMerge, prCheck, builderPrompt, prBody, githubApi, main };
