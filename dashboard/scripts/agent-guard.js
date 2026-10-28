'use strict';
// The agent lane's trusted guard (Eric, 2026-10-26;
// audits/2026-10-26-engineering-simplification). It runs only from main's
// own checkout and reads everything the builder produced as data.
//
//   reserve   an issue labeled agent:build by Eric (the event's sender is the
//             repository owner, a user): the task in the issue form is read
//             and checked against its template, the issue is read again from
//             GitHub (still open, still labeled, the same text the event
//             carries), and one paid build is reserved in the ledger for this
//             run before anything is sent, with the head the issue's branch
//             holds then (or "absent"); one build per issue at a time, an
//             earlier one settled from its run's status on GitHub first
//   prompt    the builder's task text, from the issue as Eric labeled it
//   apply     the build artifact's patch, applied to main in a scratch index:
//             the resulting tree is what is checked and what is committed;
//             a patch or a builder's report that holds a key-shaped string
//             (agent-secrets.js) is refused, naming where, never the value
//   publish   that tree as one commit by the builder App, with the task's
//             trailers, pushed to agent/issue-<n> by lease on the head the
//             reservation recorded, in one atomic push with its "publishing"
//             line on the ledger (by lease on the tip read); a branch that
//             moved since is "stale": recorded so and never retried
//   record    the build attempt's outcome in the ledger (a revision's too)
//   pr        the agent-guard check on a pull request: an agent candidate's
//             commits, its task (still labeled, unchanged since the build)
//             and its change against the template; a change that is not
//             an agent candidate passes, and only Eric's own gets the
//             neutral agent-review (agent-checks.yml)
//   task-of   the task an agent candidate builds, for agent-verify
//   status    a backlog task's status line on its candidate branch, one
//             commit by the builder App pushed by lease (agent-backlog.js
//             statusTransform)
//
// A revision (/revise, agent-revise.js) is reserved there and applied,
// published and recorded here like a build, from the issue as its reserve
// read it (--issue) on the candidate's merge base.
//
// A backlog task (TASK-001 in DESK_STATE.md's Active Backlog on main;
// audits/2026-10-27-pm-builder) is a task like an issue: its block is read as
// the issue form would hold it (agent-backlog.js toIssue), its builds and the
// PM's remediations are reserved by agent-pm.js and applied, published and
// recorded here, on agent/task-001. Its row on main is the authorization, as
// Eric's label is for an issue; the only DESK_STATE.md change its candidate
// may carry is its status (agent-backlog.js statusOnly).
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
const B = require('./agent-backlog');
const LOG = require('./agent-log');
const S = require('./agent-secrets');

const POLICY_FILE = path.join(__dirname, '..', '..', '.github', 'agent-policy.json');
const loadPolicy = (file = POLICY_FILE) => JSON.parse(fs.readFileSync(file, 'utf8'));
const SHA_RE = /^[0-9a-f]{40}$/;
const LINK_MODES = { 120000: 'a symbolic link', 160000: 'a submodule' };
const FIELDS = { template: 'Template', outcome: 'Outcome', acceptance: 'Acceptance checks', negative: 'Negative cases', tests: 'Regression tests', paths: 'Files to change', notes: 'Notes' };
const TEST_PATH_RE = /dashboard\/tests\/[A-Za-z0-9._/-]+\.test\.js/g;
const TRAILERS = { 'Agent-Task': 'issue', 'Agent-Task-SHA256': 'task_sha256', 'Agent-Template': 'template', 'Agent-Run': 'run' };

// The committed browser bundle (eng-app@4): built from its source, so its
// files count as one toward a template's file limit.
const BUNDLE = 'dashboard/public/app/';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
// A task in words and its branch: issue #12 on agent/issue-12, TASK-001 on
// agent/task-001.
const isBacklog = (task) => Boolean(task) && typeof task.number === 'string' && B.ID_RE.test(task.number);
const refOf = (n) => (typeof n === 'string' ? n : `#${n}`);
const branchOf = (task, policy) => (isBacklog(task) ? B.branchOf(task.number, policy.task_branch_prefix) : `${policy.branch_prefix}${task.number}`);
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
  // The outcome, the acceptance checks and the negative cases are the task:
  // the verifier and the review judge the change against them. Files to
  // change and Regression tests are hints (cr.agent-task.v2, 2026-10-27):
  // named, they narrow the build; empty, the template's own paths are the
  // scope and the build names its tests. Every candidate still adds or
  // changes a test (checkChange, requires_tests), and the guard, the
  // verifier, the review and Eric's merge are unchanged.
  for (const k of ['outcome', 'acceptance', 'negative']) if (!String(f[FIELDS[k]] || '').trim()) problems.push(`"${FIELDS[k]}" is empty`);
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
    // The lane asks a test of every candidate (eng-app@4 too, from the policy).
    requires_tests: (tpl && tpl.requires_tests) || (policy.templates[template] && policy.templates[template].requires_tests) || null,
    backlog: isBacklog(issue),
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
// The issue as GitHub holds it now, against the version the event carries:
// a rerun of an old event after an edit, a removed label or a closed issue
// builds nothing (Engineering v3, change 2).
function liveCheck(task, live, { policy = loadPolicy() } = {}) {
  if (!live) return [`issue #${task.number} could not be read from GitHub now; nothing is built`];
  const reasons = [];
  if (live.pull_request) reasons.push(`#${task.number} is now a pull request, not an issue`);
  if (live.state !== 'open') reasons.push(`issue #${task.number} is closed now`);
  if (!(live.labels || []).some((l) => (l.name || l) === policy.label)) reasons.push(`issue #${task.number} no longer has the ${policy.label} label`);
  const now = sha256(String(live.body || ''));
  if (now !== task.body_sha256) reasons.push(`issue #${task.number} was edited after the label was added: the event carries version ${task.body_sha256.slice(0, 12)}, the issue now reads ${now.slice(0, 12)}; add the label again to build the new version`);
  return reasons;
}

// What a build is bound to: the task version, main's commit it starts from
// and the head its branch held when it was reserved (a commit, or "absent").
const buildBinding = (task, base, predecessor) => ({ kind: 'build', issue: task.number, task_sha256: task.body_sha256, base, predecessor });

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
const textAt = (cwd, rev, p) => { const r = git(cwd, ['cat-file', '-p', `${rev}:${p}`]); return r.status === 0 ? r.raw : null; };

// The change against its task and template: the same rules at the build
// artifact (a tree) and at the pull request (a commit). A backlog task's
// candidate may carry its status in DESK_STATE.md and nothing else there:
// `pr` is its pull request (none for a build not yet published, so no
// status change at all), and agent-backlog.js statusOnly decides.
function checkChange({ cwd, base, rev, task, pr = null }) {
  const reasons = [];
  const tpl = P.TEMPLATES[task.template];
  if (!tpl) return { ok: false, reasons: [`no template ${task.template}`], files: [] };
  const ch = changesOf(cwd, base, rev);
  const status = task.backlog ? ch.find((c) => c.path === B.FILE) : null;
  const units = new Set(ch.filter((c) => c !== status).map((c) => (c.path.startsWith(BUNDLE) ? BUNDLE : c.path)));
  if (!units.size) reasons.push(status ? 'the change is only the task\'s status' : 'the change is empty');
  if (units.size > tpl.limits.max_files) reasons.push(`${units.size} files changed${units.has(BUNDLE) ? ' (the bundle counted once)' : ''}; ${task.template} takes at most ${tpl.limits.max_files}`);
  const reqTests = task.requires_tests === undefined ? tpl.requires_tests : task.requires_tests;
  // Every name in the resulting tree, and each of its folders, by its
  // Windows form (letter case ignored, trailing dots and spaces dropped): a
  // changed name that is one file or folder there with any other name in the
  // tree, changed or not, is refused, as backlog-promote.js scopeCheck
  // refuses it. Git on Eric's PC writes only one of the two (red-team
  // review, 2026-10-27).
  const forms = new Map();
  for (const f of git(cwd, ['ls-tree', '-r', '-z', '--name-only', rev]).raw.split('\0').filter(Boolean)) {
    const parts = f.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const pre = parts.slice(0, i).join('/');
      const k = BP.foldPath(pre);
      if (!forms.has(k)) forms.set(k, new Set());
      forms.get(k).add(pre);
    }
  }
  for (const c of ch) {
    const p = c.path;
    const parts = p.split('/');
    const clash = c.status === 'D' ? null : parts.map((_, i) => parts.slice(0, i + 1).join('/')).map((pre) => [pre, [...(forms.get(BP.foldPath(pre)) || [])].find((x) => x !== pre)]).find(([, other]) => other);
    if (clash) reasons.push(`${clash[0]} and ${clash[1]} are one ${clash[0] === p ? 'file' : 'folder'} on Windows`);
    const w = BP.windowsProblem(p);
    if (w) reasons.push(`${p}: ${w}`);
    const link = LINK_MODES[c.newMode] || LINK_MODES[c.oldMode];
    if (link) reasons.push(`${p} is ${link}`);
    if (c.newMode === '100755' && c.oldMode !== '100755') reasons.push(`${p} becomes executable`);
    if (c.binary) reasons.push(`${p} is a binary change`);
    if (c === status) {
      const before = textAt(cwd, base, p);
      const after = textAt(cwd, rev, p);
      const s = before === null || after === null ? { ok: false, reasons: [`${p} is added or removed; a candidate changes only its task's status line`] } : B.statusOnly(before, after, { id: task.number, pr: Number.isInteger(pr) ? pr : null });
      reasons.push(...s.reasons.map((r) => `${p}: ${r} (protected; Eric's own change)`));
      continue;
    }
    const prot = BP.protectedHit(p);
    if (prot) reasons.push(`${p}: ${prot.why} (protected; Eric's own change)`);
    const r = BP.restrictedFor(p, task.template);
    if (r) reasons.push(`${p}: ${r.why}; ${task.template} does not reach it`);
    if (!P.matches(p, tpl.allowed_paths)) reasons.push(`${p} is outside ${task.template}`);
    const fb = (tpl.forbidden_paths || []).find((g) => P.globRe(g).test(p));
    if (fb) reasons.push(`${p} is forbidden for ${task.template} (${fb})`);
    // The task's paths narrow the template; a task that names none leaves
    // the template's own paths as the scope. A test file the template
    // requires (dashboard/tests/*.test.js, less the guarded ones refused
    // above) is inside the scope named or not.
    const testFile = Boolean(reqTests) && P.globRe(reqTests).test(p);
    if (task.paths.length && !task.paths.some((g) => P.globRe(g).test(p)) && !task.tests.includes(p) && !testFile) reasons.push(`${p} is not among the task's files to change`);
  }
  const diff = git(cwd, ['diff', '--binary', '--full-index', '--no-renames', base, rev]).raw;
  const sections = P.diffSections(diff);
  for (const c of ch) { if (c === status) continue; const why = P.protectedLineWhy(c.path, diff, sections); if (why) reasons.push(`${c.path} changes ${why}`); }
  if (reqTests && !ch.some((c) => c.status !== 'D' && P.globRe(reqTests).test(c.path))) reasons.push(`${task.template} needs every candidate to add or change a test (${reqTests})`);
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

// The open attempts a reserve closed before its own, in words.
const settledWords = (closed) => (closed && closed.length ? ` Settled first: ${closed.map((o) => `${o.id} ${L.EXPIRED.has(o.state) ? `recorded ${o.state}` : 'recorded as published'} (${oneLine(o.error || o.note, 160)})`).join('; ')}.` : '');

const botIdentity = (name, email) => ({ GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email });
// How a revision or a remediation came about, in one sentence.
function revisionWords(revision) {
  if (revision.kind === 'remediate') return `Remediated from ${revision.predecessor} at the PM's diagnosis ${revision.diagnosis} (remediation ${revision.round}; feedback SHA-256 ${revision.feedback_sha256}).`;
  return `Revised from ${revision.predecessor} at Eric's /revise (${revision.comments.length === 1 ? 'comment' : 'comments'} ${revision.comments.join(', ')}; feedback SHA-256 ${revision.feedback_sha256}).`;
}
function commitMessage(task, { run, policy, revision = null }) {
  return [
    `agent: ${task.title} (${refOf(task.number)})`,
    '',
    `Built by the agent lane from ${isBacklog(task) ? `backlog task ${task.number} (DESK_STATE.md)` : `issue #${task.number}`} (${task.template}). Eric merges it; no agent merges or approves.`,
    ...(revision ? ['', revisionWords(revision)] : []),
    '',
    `Agent-Task: ${refOf(task.number)}`,
    `Agent-Task-SHA256: ${task.body_sha256}`,
    `Agent-Template: ${task.template}`,
    `Agent-Run: ${run}`,
    `Generated-By: Claude Code ${policy.build.claude_code} (${policy.build.model})`,
  ].join('\n');
}
// What a reservation in the ledger lets publish do for this task, or why not.
function reservationFor(l, { reservation, task, base }) {
  const res = L.attempts(l.entries).find((a) => a.id === reservation);
  const bind = res && res.reserve.bind;
  const why = !res ? `reservation ${oneLine(reservation, 40) || '(none)'} is not in the ledger` : !L.PAID[res.reserve.kind] ? `reservation ${res.id} is not a build, a revision or a remediation` : !bind || bind.issue !== task.number || bind.task_sha256 !== task.body_sha256 || bind.base !== base ? `reservation ${res.id} is not a build of this version of ${refOf(task.number)} on ${String(base).slice(0, 12)}` : null;
  return why ? { why } : { res, bind };
}

// One commit of `tree` on `base` by the builder App, published by one atomic
// push that moves two refs or neither (pipeline review, 2026-10-27):
//   - its branch, by lease on the head the ledger recorded when this build
//     was reserved ("absent": no branch then), never on what the branch holds
//     when the build ends (Engineering v3, change 3);
//   - agent-ledger, by lease on the tip just read, with this attempt's
//     "publishing" line.
// A reserve that lands between the read and the push moves the ledger, so
// the whole push is refused; the ledger is read again and the decision made
// again, and a build recorded orphaned (or lost) meanwhile is stale. A branch
// that moved is another build's or Eric's: this build is stale, and is not
// retried.
function publish({ cwd, base, tree, task, run, botName, botEmail, branch, reservation, remote = 'origin', policy = loadPolicy(), tries = 4, beforePush = null }) {
  const ref = `refs/heads/${branch}`;
  let commit = null;
  let revision = null;
  for (let i = 0; i < tries; i += 1) {
    const l = L.read(cwd, { remote });
    if (l.error) return { error: l.error };
    const r = reservationFor(l, { reservation, task, base });
    if (r.why) return { error: r.why };
    const { res, bind } = r;
    // Recorded orphaned (or lost, before 2026-10-27): the task was freed for
    // a later build, so this one stays out.
    const gone = res.outcomes.find((o) => L.EXPIRED.has(o.state));
    if (gone) return { stale: true, error: `build ${res.id} was recorded ${gone.state} (${oneLine(gone.error, 160)}) and the task went to a later build; this build is not published and is not retried` };
    if (res.outcomes.length) return { stale: true, error: `build ${res.id} already has an outcome (${oneLine(res.outcomes[res.outcomes.length - 1].state, 20)}); this build is not published again` };
    const predecessor = bind.predecessor;
    if (predecessor !== 'absent' && !SHA_RE.test(String(predecessor || ''))) return { error: `no recorded head of ${branch} to lease on (${oneLine(predecessor, 60) || 'none'}); nothing is pushed` };
    const expected = predecessor === 'absent' ? '' : predecessor;
    const heads = () => {
      const ls = git(cwd, ['ls-remote', remote, ref, L.REF]);
      const at = (name) => ((ls.out.split('\n').find((x) => x.endsWith(`\t${name}`)) || '').split('\t')[0] || '');
      return ls.status === 0 ? { branch: at(ref), ledger: at(L.REF) } : null;
    };
    // Its publishing line is in the ledger already (a re-run of this job):
    // published when the branch still holds that commit.
    const held = res.publishing[res.publishing.length - 1];
    if (held) {
      const h = heads();
      if (h && h.branch === held.commit) return { commit: held.commit, branch, replaced: expected || null, revision: revisionOf(res, bind), again: true };
      return { stale: true, error: `build ${res.id} was published as ${String(held.commit).slice(0, 12)} and ${branch} reads ${h ? h.branch.slice(0, 12) || 'absent' : 'unknown'} now; this build is not published again` };
    }
    if (!commit) {
      revision = revisionOf(res, bind);
      const c = git(cwd, ['commit-tree', tree, '-p', base, '-m', commitMessage(task, { run, policy, revision })], { env: botIdentity(botName, botEmail) });
      if (c.status !== 0 || !SHA_RE.test(c.out)) return { error: `the commit could not be made: ${c.err.slice(0, 200)}` };
      commit = c.out;
    }
    const line = L.stage(cwd, { ...l, recs: [{ t: 'publishing', id: res.id, commit, branch, predecessor, run, at: new Date().toISOString() }], message: `publishing ${res.id}` });
    if (beforePush) beforePush(i);
    const p = git(cwd, ['push', '--atomic', '--porcelain', `--force-with-lease=${ref}:${expected}`, `--force-with-lease=${L.REF}:${l.tip}`, remote, `${commit}:${ref}`, `${line.commit}:${L.REF}`]);
    const h = heads();
    // Published only on the ledger's word: this attempt's publishing line for
    // this commit, which went up with the branch in the one atomic push (the
    // ledger may have moved on since). The branch holding the commit is not
    // enough: a later build of the same tree, base and message made in the
    // same second is the very commit the branch already holds (CI, PR #56).
    if (h && h.branch === commit) {
      const after = L.read(cwd, { remote });
      if (after.error) return { error: `${branch} holds ${commit.slice(0, 12)}, but the ledger could not be read to confirm this push carried it (${oneLine(after.error, 160)}); nothing is retried until the ledger reads`, commit, uncertain: true };
      const mine = L.attempts(after.entries).find((a) => a.id === res.id);
      if (mine && mine.publishing.some((x) => x.commit === commit)) return { commit, branch, replaced: expected || null, revision };
    }
    if (h && h.branch !== expected) return { stale: true, commit, error: `${branch} moved after this build was reserved: it was ${expected ? expected.slice(0, 12) : 'absent'} and is now ${h.branch ? h.branch.slice(0, 12) : 'absent'}; this build is not published and is not retried` };
    // Only the ledger moved (another reserve, review or record): neither ref
    // was written, so read it again and decide again.
    if (h && h.ledger !== l.tip) continue;
    return { error: `the push to ${branch} and the ledger failed and ${branch} reads ${h ? h.branch.slice(0, 12) || 'absent' : 'unknown'} (${p.err.slice(0, 200)})`, commit };
  }
  return { error: `the ledger kept moving while ${branch} was being published; nothing was pushed`, commit };
}
const revisionOf = (res, bind) => (res.reserve.kind === 'revise' ? { id: res.id, predecessor: bind.predecessor, comments: Array.isArray(bind.comments) ? bind.comments : [], feedback_sha256: bind.feedback_sha256 }
  // A remediation of an open pull request names its head; one of a build
  // that published nothing names that attempt (attempt:<id>).
  : res.reserve.kind === 'remediate' ? { kind: 'remediate', id: res.id, predecessor: bind.pr ? bind.predecessor : bind.subject, diagnosis: bind.diagnosis, round: bind.round, feedback_sha256: bind.feedback_sha256 } : null);
// A backlog task's status line set to `to` at `head` (every other
// [IN_PROGRESS: PR #m] read as [DONE]), as one more commit by the builder App
// with the head's own trailers, pushed by lease on `head`. A head that is not
// a build of this version of the task is refused; nothing to change is
// "unchanged".
const STATUS_TRAILER_RE = /^(Agent-Task|Agent-Task-SHA256|Agent-Template|Agent-Run|Generated-By):/;
function setStatus({ cwd, head, task, to, branch, botName, botEmail, remote = 'origin' }) {
  const text = textAt(cwd, head, B.FILE);
  if (text === null) return { error: `${B.FILE} could not be read at ${head.slice(0, 12)}` };
  const next = B.statusTransform(text, { id: task.number, to });
  if (next === null) return { error: `${task.number} is not in ${B.FILE} at ${head.slice(0, 12)}` };
  if (next === text) return { state: 'unchanged', commit: head };
  const body = git(cwd, ['log', '-1', '--format=%B', head]).raw;
  const t = trailersOf(body);
  if (t.issue !== task.number || t.task_sha256 !== task.body_sha256) return { error: `${head.slice(0, 12)} is not a build of this version of ${task.number}` };
  const mode = (git(cwd, ['ls-tree', head, '--', B.FILE]).out.split(/\s+/)[0]) || '100644';
  const index = path.join(os.tmpdir(), `agent-index-${crypto.randomBytes(6).toString('hex')}`);
  const env = { GIT_INDEX_FILE: index };
  let tree = null;
  try {
    if (git(cwd, ['read-tree', head], { env }).status !== 0) return { error: `${head.slice(0, 12)} could not be read` };
    const blob = git(cwd, ['hash-object', '-w', '--stdin'], { input: next }).out;
    if (git(cwd, ['update-index', '--cacheinfo', `${mode},${blob},${B.FILE}`], { env }).status !== 0) return { error: `${B.FILE} could not be staged` };
    tree = git(cwd, ['write-tree'], { env }).out;
  } finally {
    fs.rmSync(index, { force: true });
  }
  const message = [`agent: ${task.number} ${B.statusText(to)}`, '', `The lane's status line for ${task.number} in ${B.FILE}; nothing else changes.`, '', ...body.split('\n').map((l) => l.trim()).filter((l) => STATUS_TRAILER_RE.test(l))].join('\n');
  const c = git(cwd, ['commit-tree', tree, '-p', head, '-m', message], { env: botIdentity(botName, botEmail) });
  if (c.status !== 0 || !SHA_RE.test(c.out)) return { error: `the status commit could not be made: ${c.err.slice(0, 200)}` };
  const ref = `refs/heads/${branch}`;
  const p = git(cwd, ['push', '--porcelain', `--force-with-lease=${ref}:${head}`, remote, `${c.out}:${ref}`]);
  const after = git(cwd, ['ls-remote', remote, ref]).out.split(/\s+/)[0] || '';
  if (after === c.out) return { state: 'set', commit: c.out };
  return { error: `${branch} reads ${after ? after.slice(0, 12) : 'absent'}, not ${head.slice(0, 12)}: the status was not pushed (${p.err.slice(0, 160)})` };
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
// builder's. Anything else is not, and the agent checks pass it; its
// agent-review waits for Eric's own review of its exact head
// (agent-review.js, agent-owner-review.js).
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
  if (out.issue) out.issue = B.ID_RE.test(out.issue) ? out.issue : Number(String(out.issue).replace(/^#/, '')) || null;
  return out;
}
// A merge commit that adds nothing of its own (GitHub's "Update branch").
function pureMerge(cwd, c) {
  if (c.parents.length !== 2) return false;
  const m = git(cwd, ['merge-tree', '--write-tree', c.parents[0], c.parents[1]]);
  return m.status === 0 && m.out.split('\n')[0] === c.tree;
}

// A backlog task's block as DESK_STATE.md holds it at `rev` (main, or the
// merge base of a candidate).
function backlogTask(cwd, rev, id) {
  const text = textAt(cwd, rev, B.FILE);
  if (text === null) return { error: `${B.FILE} could not be read at ${String(rev).slice(0, 12)}` };
  const p = B.parse(text);
  if (!p.found) return { error: p.problems.join('; ') };
  const block = p.tasks.find((t) => t.id === id);
  if (!block) return { error: `${id} is not in ${B.FILE}'s ${B.SECTION} at ${String(rev).slice(0, 12)}` };
  return { block, backlog: p };
}
// The task a backlog block is, checked as an issue would be, with the
// block's own problems.
function backlogTaskOf(block, { policy = loadPolicy() } = {}) {
  const task = taskOf(B.toIssue(block), { policy });
  task.problems = [...new Set([...block.problems, ...task.problems])];
  return task;
}

// The agent-guard check of a pull request. `pr` is its number (a backlog
// task's candidate carries its status, which names it).
async function prCheck({ cwd, base, head, branch, author, botLogin, issueOf, pr = null, policy = loadPolicy() }) {
  const mb = git(cwd, ['merge-base', base, head]).out;
  if (!SHA_RE.test(mb)) return { agent: null, ok: false, reasons: ['the pull request\'s merge base with main could not be read'] };
  const commits = commitsOf(cwd, mb, head) || [];
  // Who opened it, its branch and its commits' authors decide nothing more:
  // its agent-review waits for Eric's own review of this exact head
  // (hardening, 2026-10-27; a commit's metadata is not a review).
  if (!isAgentPr({ branch, author, botLogin, commits, policy })) return { agent: false, ok: true, reasons: [], says: 'Not an agent candidate, so the agent checks do not apply; no model reviews it, and its agent-review waits for Eric\'s own review of this exact head. The required tests still apply.' };
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
  let task = null;
  if (typeof trailers.issue === 'string') {
    // A backlog task: its row on the merge base (main), still [TODO], at the
    // version built. Main's row is the authorization; the candidate's own
    // copy of DESK_STATE.md never is.
    const row = backlogTask(cwd, mb, trailers.issue);
    if (row.error) return { agent: true, ok: false, reasons: [...reasons, row.error], trailers };
    task = backlogTaskOf(row.block, { policy });
    if (!row.block.status || row.block.status.kind !== 'todo') reasons.push(`${trailers.issue} reads ${row.block.status ? row.block.status.text : 'no valid status'} on main; only a [TODO] row authorizes a build`);
    if (task.body_sha256 !== trailers.task_sha256) reasons.push(`${trailers.issue} was edited on main after this build (the build was of version ${trailers.task_sha256.slice(0, 12)}); the PM builds the new version`);
    const want = B.branchOf(trailers.issue, policy.task_branch_prefix);
    if (branch && branch !== want) reasons.push(`the candidate's branch is ${oneLine(branch, 80)}, not ${want}`);
  } else {
    const issue = await issueOf(trailers.issue);
    if (!issue) return { agent: true, ok: false, reasons: [...reasons, `issue #${trailers.issue} could not be read`], trailers };
    if (issue.state !== 'open') reasons.push(`issue #${trailers.issue} is closed`);
    if (!(issue.labels || []).some((l) => (l.name || l) === policy.label)) reasons.push(`issue #${trailers.issue} no longer has the ${policy.label} label`);
    task = taskOf(issue, { policy });
    if (task.body_sha256 !== trailers.task_sha256) reasons.push(`issue #${trailers.issue} was edited after this build (the build was of version ${trailers.task_sha256.slice(0, 12)}); add the label again to build the new version`);
  }
  if (task.template !== trailers.template) reasons.push(`the task's template is ${task.template}, the build says ${trailers.template}`);
  reasons.push(...task.problems);
  const ch = checkChange({ cwd, base: mb, rev: head, task, pr });
  reasons.push(...ch.reasons);
  return { agent: true, ok: reasons.length === 0, reasons: [...new Set(reasons)], trailers, task, merge_base: mb, files: ch.files };
}

// What the builder may change, in words: the task's paths, or, when it names
// none, the template's own paths less what it forbids (a protected path is
// never inside either).
function scopeWords(task) {
  const tpl = P.TEMPLATES[task.template];
  if (task.paths.length) return task.paths.join(', ');
  if (!tpl) return 'none';
  const forbidden = tpl.forbidden_paths && tpl.forbidden_paths.length ? `; never ${tpl.forbidden_paths.join(', ')}` : '';
  return `any file under ${tpl.allowed_paths.join(', ')}${forbidden}, and never a protected path; at most ${tpl.limits.max_files} files, only what the outcome needs`;
}
const NO_TESTS_NAMED = 'none named: add or change at least one test file under dashboard/tests/ (<name>.test.js) that shows the outcome and each negative case';

// The builder's task text. The issue is Eric's; it is still marked as task
// data, and the standing rules come from builder-rules.md.
function builderPrompt(task) {
  return [
    `Build ${isBacklog(task) ? `backlog task ${task.number} (DESK_STATE.md, Active Backlog)` : `issue #${task.number}`} of kuaya1/CryptoResearch in this checkout (template ${task.template}). Work only in the files the task lets you change; when the change is done, stop. Do not commit, push or open anything: the lane commits your working tree after you finish.`,
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
    `Regression tests to add or change: ${task.tests.join(', ') || NO_TESTS_NAMED}`,
    `Files you may change: ${scopeWords(task)}`,
    ...(task.notes ? ['', `Notes:\n${task.notes}`] : []),
    '</task>',
  ].join('\n');
}

function prBody(task, { build = {}, commit, runUrl, revision = null }) {
  const fence = (s) => String(s || '').replace(/```/g, "'''").slice(0, 3000);
  return [
    `Agent build of ${isBacklog(task) ? `backlog task ${task.number}` : `#${task.number}`} (${task.template}), commit \`${commit}\`${runUrl ? ` ([the build run](${runUrl}))` : ''}.`,
    '',
    ...(revision && revision.kind === 'remediate' ? [`Remediation \`${revision.id}\` of \`${revision.predecessor}\`, at the PM's diagnosis \`${revision.diagnosis}\` (remediation ${revision.round}; feedback SHA-256 \`${revision.feedback_sha256}\`).`, ''] : []),
    ...(revision && revision.kind !== 'remediate' ? [`Revision \`${revision.id}\` of \`${revision.predecessor}\`, at Eric's /revise (${revision.comments.length === 1 ? 'comment' : 'comments'} ${revision.comments.join(', ')}; feedback SHA-256 \`${revision.feedback_sha256}\`).`, ''] : []),
    `**Outcome:** ${oneLine(task.outcome, 600)}`,
    '',
    `Required before Eric merges: \`test\`, \`agent-guard\`, \`agent-verify\` and \`agent-review\`. No agent merges or approves this pull request.`,
    ...(isBacklog(task) ? ['', `The lane sets this task's status line in DESK_STATE.md on this branch; that line is the only change to DESK_STATE.md agent-guard lets through.`] : []),
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
  const pages = async (p, key = null, max = 10) => {
    const all = [];
    for (let page = 1; page <= max; page += 1) {
      const r = await call('GET', `${p}${p.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const list = r.status === 200 ? (key ? r.json && r.json[key] : r.json) : null;
      if (!Array.isArray(list)) return null;
      all.push(...list);
      if (list.length < 100) return all;
    }
    return null;
  };
  return {
    issue: async (n) => { const r = await call('GET', `/repos/${repo}/issues/${n}`); return r.status === 200 ? r.json : null; },
    // One attempt of a workflow run, as GitHub reports it now (its status,
    // conclusion and times), or null.
    // A workflow run as GitHub holds it (its latest attempt), { missing: true }
    // when GitHub answers 404, null when it cannot be read.
    run: async (id) => { if (!Number.isSafeInteger(id)) return null; const r = await call('GET', `/repos/${repo}/actions/runs/${id}`); return r.status === 200 ? r.json : r.status === 404 ? { missing: true } : null; },
    pull: async (n) => { const r = await call('GET', `/repos/${repo}/pulls/${n}`); return r.status === 200 ? r.json : null; },
    pullsForSha: async (sha) => { const r = await call('GET', `/repos/${repo}/commits/${sha}/pulls`); return r.status === 200 && Array.isArray(r.json) ? r.json : []; },
    createCheck: async (o) => { const r = await call('POST', `/repos/${repo}/check-runs`, o); return { ok: r.status === 201, status: r.status, id: r.json && r.json.id }; },
    // For /revise (agent-revise.js). A list read in part is null, never a
    // shorter list.
    comment: async (id) => { if (!Number.isSafeInteger(id)) return null; const r = await call('GET', `/repos/${repo}/issues/comments/${id}`); return r.status === 200 ? r.json : null; },
    comments: (n) => pages(`/repos/${repo}/issues/${Number(n)}/comments`),
    checkRuns: (sha, name) => (SHA_RE.test(String(sha)) ? pages(`/repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}&filter=all`, 'check_runs') : null),
    runsForSuite: (id) => (Number.isSafeInteger(id) ? pages(`/repos/${repo}/actions/runs?check_suite_id=${id}`, 'workflow_runs') : null),
    annotations: (id) => (Number.isSafeInteger(id) ? pages(`/repos/${repo}/check-runs/${id}/annotations`) : null),
    // For the PM (agent-pm.js) and the briefing (agent-status.js). Open pull
    // requests in full; closed ones, the latest hundred.
    pulls: (state) => (state === 'open' ? pages(`/repos/${repo}/pulls?state=open&base=main`) : pages(`/repos/${repo}/pulls?state=closed&base=main&sort=updated&direction=desc`, null, 1)),
    checksAt: (sha) => (SHA_RE.test(String(sha)) ? pages(`/repos/${repo}/commits/${sha}/check-runs?filter=latest`, 'check_runs', 3) : null),
    workflowRuns: async (file) => { const r = await call('GET', `/repos/${repo}/actions/workflows/${encodeURIComponent(file)}/runs?per_page=30`); return r.status === 200 && r.json && Array.isArray(r.json.workflow_runs) ? r.json.workflow_runs : null; },
    runJobs: (id) => (Number.isSafeInteger(id) ? pages(`/repos/${repo}/actions/runs/${id}/jobs?filter=latest`, 'jobs', 2) : null),
    // A job's log: GitHub answers with a redirect to a signed address, which
    // is read without the token. The last `tail` characters only.
    jobLog: async (id, tail = 60000) => {
      if (!Number.isSafeInteger(id)) return null;
      const res = await fetchImpl(`https://api.github.com/repos/${repo}/actions/jobs/${id}/logs`, { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }, redirect: 'manual', signal: AbortSignal.timeout(30000) });
      const to = res.status >= 300 && res.status < 400 && res.headers && res.headers.get ? res.headers.get('location') : null;
      if (!to || !/^https:\/\//.test(to)) return null;
      const log = await fetchImpl(to, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000) });
      if (log.status !== 200) return null;
      const text = await log.text();
      return text.length > tail ? text.slice(-tail) : text;
    },
    postComment: async (n, body) => { const r = await call('POST', `/repos/${repo}/issues/${Number(n)}/comments`, { body }); return { ok: r.status === 201, status: r.status }; },
    dispatch: async (file, ref, inputs) => { const r = await call('POST', `/repos/${repo}/actions/workflows/${encodeURIComponent(file)}/dispatches`, { ref, inputs }); return { ok: r.status === 204, status: r.status }; },
  };
}

// --- CLI ---------------------------------------------------------------------
// `errors` (a check's title and reasons) become the step's error
// annotations; the text is data in the log (agent-log.js).
function out(flat, text, errors = null) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(flat).map(([k, v]) => `${k}=${String(v === null || v === undefined ? '' : v).replace(/[\r\n]+/g, ' ')}\n`).join(''));
  if (text && process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n\n`);
  LOG.write(text, errors || {});
}
const eventOf = (flags) => JSON.parse(fs.readFileSync(flags.event || process.env.GITHUB_EVENT_PATH, 'utf8'));
// The task's issue: the event's, or for a revision the one its reserve read
// (--issue; the event there is a comment on the pull request).
const issueOfFlags = (flags) => (flags.issue ? JSON.parse(fs.readFileSync(flags.issue, 'utf8')) : eventOf(flags).issue);

async function main(argv, { now = () => Date.now(), cwd = process.cwd(), env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const [cmd, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) flags[rest[i].replace(/^--/, '')] = rest[i + 1];
  const policy = loadPolicy();
  if (cmd === 'reserve') {
    const ev = eventOf(flags);
    const reasons = authorize(ev, { policy });
    const task = ev.issue ? taskOf(ev.issue, { policy }) : null;
    if (task) reasons.push(...task.problems);
    const gh = githubApi({ token: env.GH_TOKEN, repo: env.GITHUB_REPOSITORY, fetchImpl });
    if (!reasons.length) {
      let live = null;
      try { live = await gh.issue(task.number); } catch (_) { live = null; }
      reasons.push(...liveCheck(task, live, { policy }));
    }
    // A build that does not start is said on the issue by the refused job
    // (the note, as data), so Eric reads why where he added the label.
    const refused = (why) => out({ ok: false, kind: 'build', note: oneLine(why.join('; '), 1500) }, `### Not built\n\n${why.map((r) => `- ${r}`).join('\n')}`);
    if (reasons.length) { refused(reasons); return 0; }
    const base = flags.base;
    const branch = `${policy.branch_prefix}${task.number}`;
    const head = git(cwd, ['ls-remote', 'origin', `refs/heads/${branch}`]);
    if (head.status !== 0) { refused([`the head of ${branch} could not be read (${oneLine(head.err, 160)}); nothing is reserved`]); return 0; }
    const predecessor = head.out.split(/\s+/)[0] || 'absent';
    const bind = buildBinding(task, base, predecessor);
    const run = `${env.GITHUB_RUN_ID}/${env.GITHUB_RUN_ATTEMPT}`;
    // GitHub's word on the runs of the attempts holding this issue, read
    // before deciding: no clock settles one (red-team review, 2026-10-27).
    const l0 = L.read(cwd);
    if (l0.error) { refused([l0.error]); return 0; }
    const runs = await L.runStatuses(l0.entries, { issue: task.number, readRun: gh.run, control: run });
    const d = L.transact(cwd, { decide: (entries) => L.decideBuild(entries, { binding: L.bindingOf(bind), bind, ceilings: policy.ceilings, now: now(), usd: policy.build.max_budget_usd, run, runs }), message: `build reserve #${task.number}` });
    if (d.error || d.action !== 'build') { refused([d.error || d.why]); return 0; }
    out({ ok: true, kind: 'build', reservation: d.id, attempt: env.GITHUB_RUN_ATTEMPT, number: task.number, issue: task.number, notify: task.number, title: task.title, pr_title: `agent: ${task.title} (#${task.number})`, template: task.template, task_sha256: task.body_sha256, predecessor, base, checkout: base }, `Build of #${task.number} (${task.template}) reserved as ${d.id}: at most $${policy.build.max_budget_usd}, on ${branch} at ${predecessor === 'absent' ? 'no branch yet' : predecessor.slice(0, 12)}.${settledWords(d.closed)}`);
    return 0;
  }
  if (cmd === 'prompt') {
    const task = taskOf(eventOf(flags).issue, { policy });
    fs.writeFileSync(flags.out, builderPrompt(task));
    return 0;
  }
  if (cmd === 'apply') {
    const task = taskOf(issueOfFlags(flags), { policy });
    // Why nothing is published, as the step's note (the PM reads it from the
    // ledger's outcome) and its error annotations.
    const notPublished = (title, reasons) => out({ ok: false, note: oneLine(reasons.join('; '), 1500) }, `### ${title}\n\n${reasons.map((r) => `- ${r}`).join('\n')}`, { title: 'agent-guard', reasons });
    const report = flags.build && fs.existsSync(flags.build) ? S.secretHits(fs.readFileSync(flags.build, 'utf8')) : [];
    if (report.length) { notPublished('Not published', [`the builder's report holds a key-shaped string at ${report.map((h) => S.describe({ path: path.basename(flags.build), ...h })).join(', ')}; the value is not shown`]); return 1; }
    const tplPolicy = policy.templates[task.template] || {};
    const a = applyPatch({ cwd, base: flags.base, patchFile: flags.patch, maxBytes: tplPolicy.max_patch_bytes || policy.build.max_patch_bytes });
    if (a.error) { notPublished('Not published', [a.error]); return 1; }
    // A remediation of a backlog task's open pull request starts from its
    // head, which carries the task's status for that pull request.
    const pr = /^[1-9][0-9]{0,9}$/.test(String(flags.pr || '')) ? Number(flags.pr) : null;
    const ch = checkChange({ cwd, base: flags.base, rev: a.tree, task, pr });
    if (!ch.ok) { notPublished('Not published: the build\'s change is outside its task', ch.reasons); return 1; }
    out({ ok: true, tree: a.tree }, `The build's change applies to ${String(flags.base).slice(0, 12)} and stays inside ${refOf(task.number)} (${ch.files.length} ${ch.files.length === 1 ? 'file' : 'files'}).`);
    return 0;
  }
  if (cmd === 'publish') {
    const task = taskOf(issueOfFlags(flags), { policy });
    // The head to lease on, and the ledger tip the push fences, are read from
    // the ledger inside publish.
    const p = publish({ cwd, base: flags.base, tree: flags.tree, task, run: flags.run, botName: flags['bot-name'], botEmail: flags['bot-email'], branch: branchOf(task, policy), reservation: flags.reservation, policy });
    if (p.stale) { out({ ok: false, state: 'stale', note: p.error }, `### Not published: stale

- ${p.error}`); return 0; }
    if (p.error) { out({ ok: false, state: p.uncertain ? 'uncertain' : 'failed' }, `### ${p.uncertain ? 'Publish not confirmed' : 'Not published'}

- ${p.error}`); return 1; }
    out({ ok: true, state: 'published', commit: p.commit, branch: p.branch }, `Published ${p.commit.slice(0, 12)} to ${p.branch}${p.replaced ? ` (replacing ${p.replaced.slice(0, 12)})` : ''}, with its publishing line in the ledger in the same push.`);
    fs.writeFileSync(flags['body-out'], prBody(task, { build: flags.build && fs.existsSync(flags.build) ? JSON.parse(fs.readFileSync(flags.build, 'utf8')) : {}, commit: p.commit, runUrl: flags['run-url'], revision: p.revision }));
    return 0;
  }
  if (cmd === 'record') {
    let build = {};
    try { build = flags.build && fs.existsSync(flags.build) ? JSON.parse(fs.readFileSync(flags.build, 'utf8')) : {}; } catch (_) { build = {}; }
    const reported = Number(build.total_cost_usd);
    // The note is the guard's own words on why nothing was published (apply
    // or publish); the PM reads it as the evidence of a build that published
    // nothing.
    const rec = { t: 'outcome', id: flags.id, state: flags.outcome === 'success' ? 'response' : 'unknown', job: oneLine(flags.outcome, 20), publish: flags.publish ? oneLine(flags.publish, 20) : undefined, note: flags.note ? oneLine(flags.note, 1500) : undefined, reported_usd: Number.isFinite(reported) ? reported : undefined, at: new Date(now()).toISOString() };
    const r = L.transact(cwd, { decide: () => ({ append: [rec] }), message: `build outcome ${flags.id}` });
    out({}, r.error ? `### The build's outcome was not recorded\n\n- ${r.error}\n\nIts reservation still counts in full.` : `Build ${flags.id}: ${rec.job}${rec.publish ? `, publish ${rec.publish}` : ''}${rec.reported_usd !== undefined ? `, reported $${rec.reported_usd}` : ''}.`);
    return r.error ? 1 : 0;
  }
  if (cmd === 'pr' || cmd === 'task-of') {
    const gh = githubApi({ token: process.env.GH_TOKEN, repo: process.env.GITHUB_REPOSITORY });
    const pr = /^[1-9][0-9]{0,9}$/.test(String(flags.pr || '')) ? Number(flags.pr) : null;
    const r = await prCheck({ cwd, base: flags.base, head: flags.head, branch: flags.branch, author: flags.author, botLogin: process.env.BUILDER_APP_SLUG ? `${process.env.BUILDER_APP_SLUG}[bot]` : null, issueOf: gh.issue, pr, policy });
    if (cmd === 'task-of') {
      fs.writeFileSync(flags.out, JSON.stringify(r.agent ? { agent: true, ok: r.ok, template: r.task && r.task.template, tests: r.task ? r.task.tests : [], implementation: r.task ? r.task.implementation : [], merge_base: r.merge_base } : { agent: r.agent }, null, 2));
      return 0;
    }
    out({ agent: r.agent, ok: r.ok }, r.agent === false ? r.says : r.ok ? `Agent candidate for ${refOf(r.trailers.issue)} (${r.task.template}): its commits, its task and its change hold.` : `### Agent candidate refused\n\n${r.reasons.map((x) => `- ${x}`).join('\n')}`, r.ok ? null : { title: 'agent-guard', reasons: r.reasons });
    return r.ok ? 0 : 1;
  }
  if (cmd === 'status') {
    // A backlog task's status on its candidate branch (--to in_progress
    // after its pull request opens, or blocked when the PM stops), one
    // commit by the builder App on the head named, pushed by lease on it.
    const task = taskOf(issueOfFlags(flags), { policy });
    const pr = /^[1-9][0-9]{0,9}$/.test(String(flags.pr || '')) ? Number(flags.pr) : null;
    const to = flags.to === 'in_progress' && pr ? { kind: 'in_progress', pr } : flags.to === 'blocked' ? { kind: 'blocked', reason: B.PM_BLOCK } : null;
    const r = task.backlog && to && SHA_RE.test(String(flags.head || '')) ? setStatus({ cwd, head: flags.head, task, to, branch: branchOf(task, policy), botName: flags['bot-name'], botEmail: flags['bot-email'] }) : { error: 'a backlog task, --to in_progress with --pr, or --to blocked, and --head <commit> are needed' };
    out({ ok: !r.error, commit: r.commit || '', state: r.state || 'failed' }, r.error ? `### Status not set\n\n- ${r.error}` : r.state === 'unchanged' ? `${task.number} already reads ${B.statusText(to)} at ${flags.head.slice(0, 12)}.` : `${task.number} reads ${B.statusText(to)} on ${branchOf(task, policy)} at ${r.commit.slice(0, 12)}.`);
    return r.error ? 1 : 0;
  }
  process.stderr.write('Usage: agent-guard.js reserve|prompt|apply|publish|record|pr|task-of|status …\n');
  return 2;
}

if (require.main === module) main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (err) => { process.stderr.write(`agent-guard: ${String((err && err.message) || err).slice(0, 400)}\n`); process.exitCode = 1; });

module.exports = { FIELDS, SHA_RE, BUNDLE, NO_TESTS_NAMED, loadPolicy, oneLine, isBacklog, refOf, branchOf, textAt, parseIssueForm, taskOf, authorize, liveCheck, buildBinding, changesOf, checkChange, applyPatch, commitMessage, reservationFor, publish, settledWords, setStatus, commitsOf, botEmailOf, isAgentPr, trailersOf, pureMerge, backlogTask, backlogTaskOf, prCheck, scopeWords, builderPrompt, prBody, githubApi, main };
