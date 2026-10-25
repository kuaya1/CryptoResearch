#!/usr/bin/env node
'use strict';
// Backlog promotion (review A01/A02, 2026-10-25; .github/workflows/backlog-pr.yml).
// A green push run tests a branch's head alone; main may have moved since. A
// backlog branch reaches main only as the exact tree that passed the suite on
// top of main as it was, and only while main is still there:
//
//   scope    from main's checkout, read the branch as data: every change is
//            in the scope Eric authorized (commits name buildable backlog
//            items from main's DESK_STATE.md; no protected path is touched).
//            Anything else waits for Eric, the PR left open.
//   compose  merge the tested head onto main's current commit and print its
//            tree; the workflow then runs the suite on that tree in a job
//            with a read-only token.
//   promote  in a job that runs no branch code: re-create the merge, check
//            it is the tree that passed, and push it to main only if main is
//            still the commit it was tested on (a compare-and-swap; a moved
//            main is refused and nothing lands). The result is read back from
//            the remote, never taken from a command's exit alone; the branch
//            is deleted only after a confirmed merge and only at the tested
//            commit.
//
// Each subcommand prints its JSON result, adds key=value lines to
// $GITHUB_OUTPUT and its words to $GITHUB_STEP_SUMMARY when those are set.
// A Backlog-Item trailer is the builder's claim, metadata only: the approval
// is the item on main's backlog, which only Eric edits.

const fs = require('fs');
const { spawnSync } = require('child_process');

const IDENTITY = { GIT_AUTHOR_NAME: 'github-actions[bot]', GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com', GIT_COMMITTER_NAME: 'github-actions[bot]', GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com' };
const SHA_RE = /^[0-9a-f]{40}$/;
const BRANCH_RE = /^claude\/backlog-[A-Za-z0-9._/-]+$/;

// Paths a backlog branch may not change without Eric: authorization, the
// ledger, promotion and CI controls, the backlog itself, agent instructions,
// dependencies and deployment. A published template may be added to, never
// edited or removed.
const PROTECTED = [
  { re: /^\.github\//, why: 'CI and promotion workflows' },
  { re: /^\.claude\//, why: 'agent definitions and permissions' },
  { re: /^(CLAUDE|COWORK-INSTRUCTIONS)\.md$/, why: 'agent instructions' },
  { re: /^DESK_STATE\.md$/, why: 'the backlog (a branch never edits it; Eric adds and ticks items)' },
  { re: /^dashboard\/scripts\/(backlog-promote|backlog-intake|merge-train|engineering-worker)\.js$/, why: 'promotion controls' },
  { re: /^dashboard\/engineering\//, why: 'engineering authorization (the inbox, delegations and their connector)' },
  { re: /^dashboard\/(oauth|mcp|hosted)\.js$/, why: 'authorization (sign-in and connector grants)' },
  { re: /^server\.js$/, why: 'the hosted entry point' },
  { re: /^dashboard\/core\/(portfolio|wallets|walletsync|alchemy)\.js$/, why: 'financial records (the ledger and wallets)' },
  { re: /^(package(-lock)?\.json|dashboard\/web\/package(-lock)?\.json)$/, why: 'dependencies and scripts' },
  { re: /^render\.ya?ml$/, why: 'deployment' },
  { re: /^(portfolio|paper|projects|config|secrets)\//, why: 'records, never committed' },
];
// Lines of an unprotected file that mount a protected part (Eric's decision
// on review finding 2, 2026-10-25): a branch that adds, changes or removes one
// waits for him as a protected path does; the rest of the file still merges.
const PROTECTED_LINES = [
  { path: 'dashboard/server.js', re: /engineering/i, why: 'the mount of the engineering routes (dashboard/engineering/routes.js)' },
];
// Paths no delegation reaches (Eric's decision on review finding 6): an
// engineering item a delegation admitted is held when its diff touches one;
// only a version Eric authorized himself may.
const DELEGATION_RESTRICTED = [
  { re: /^dashboard\/core\//, prefix: 'dashboard/core/', why: 'core financial and investment logic, which no delegation changes' },
];

function run(cwd, cmd, args, { allowFail = false, env = {} } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY, ...env }, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim().slice(0, 600)}`);
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
const git = (cwd, args, opts) => run(cwd, 'git', args, opts);
const revParse = (cwd, ref) => { const r = git(cwd, ['rev-parse', '--verify', '-q', `${ref}^{commit}`], { allowFail: true }); return r.status === 0 ? r.out : null; };

// An item the desk's engineering inbox admitted (Connected Engineering v1,
// 2026-10-25): its line names the private task, its version and a hash prefix.
const ENG_MARK_RE = /\*\(engineering task (eng-\d{8}-[0-9a-f]{6}) v(\d+), sha256 ([0-9a-f]{16})/;

// The items main's backlog holds: number -> { ticked, eric, engineering }.
function backlogItems(text) {
  const out = new Map();
  const s = String(text || '');
  for (const m of s.matchAll(/^\s*- \[([ x])\] (\*\(Eric\)\* )?\*\*(\d+)\./gm)) {
    const end = s.indexOf('\n', m.index);
    const eng = ENG_MARK_RE.exec(s.slice(m.index, end < 0 ? s.length : end));
    out.set(Number(m[3]), { ticked: m[1] === 'x', eric: Boolean(m[2]), engineering: eng ? { task_id: eng[1], version: Number(eng[2]), sha256_prefix: eng[3] } : null });
  }
  return out;
}

// Whether the branch stays inside the authorized scope; reasons in words.
function scopeCheck(cwd, { base, head }) {
  const reasons = [];
  const changed = git(cwd, ['diff', '--no-renames', '--name-status', `${base}...${head}`]).out.split('\n').filter(Boolean).map((l) => { const [st, ...p] = l.split('\t'); return { status: st[0], path: p.join('\t') }; });
  for (const c of changed) {
    const hit = PROTECTED.find((x) => x.re.test(c.path));
    const lines = PROTECTED_LINES.find((x) => x.path === c.path);
    if (hit) reasons.push(`${c.path}: ${hit.why}`);
    else if (/^templates\//.test(c.path) && c.status !== 'A') reasons.push(`${c.path}: a published template is ${c.status === 'D' ? 'removed' : 'edited'} (publish a new version instead)`);
    else if (lines) {
      // Only the hunks' own lines (after the first @@), never the file header.
      const d = git(cwd, ['diff', '--no-renames', '--no-color', '-U0', `${base}...${head}`, '--', c.path]).out.split('\n');
      const body = d.slice(Math.max(0, d.findIndex((l) => l.startsWith('@@'))));
      const touched = c.status === 'D' || body.some((l) => /^[+-]/.test(l) && lines.re.test(l));
      if (touched) reasons.push(`${c.path}: ${lines.why}`);
    }
  }
  const desk = git(cwd, ['show', `${base}:DESK_STATE.md`], { allowFail: true });
  const backlog = backlogItems(desk.status === 0 ? desk.out : '');
  const commits = git(cwd, ['rev-list', '--no-merges', '--reverse', `${base}..${head}`]).out.split('\n').filter(Boolean);
  const items = new Set();
  for (const c of commits) {
    const body = git(cwd, ['log', '-1', '--format=%B', c]).out;
    const named = [...body.matchAll(/^Backlog-Item:\s*(\d+)\s*$/gm)].map((m) => Number(m[1]));
    if (!named.length) reasons.push(`commit ${c.slice(0, 7)} names no Backlog-Item`);
    for (const n of named) {
      items.add(n);
      const it = backlog.get(n);
      if (!it) reasons.push(`commit ${c.slice(0, 7)}: item ${n} is not on main's backlog`);
      else if (it.eric) reasons.push(`commit ${c.slice(0, 7)}: item ${n} is marked (Eric) and needs his decision`);
      else if (it.ticked) reasons.push(`commit ${c.slice(0, 7)}: item ${n} is already ticked on main`);
    }
  }
  if (!commits.length) reasons.push('the branch has no commit that main does not already have');
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], items: [...items].sort((a, b) => a - b), commits: commits.length, changed: changed.map((c) => c.path) };
}

// Merge `head` onto `base` in a detached checkout; the tree is what is tested.
function compose(cwd, { base, head, message = 'Merge the tested backlog branch' }) {
  if (!SHA_RE.test(base) || !SHA_RE.test(head)) throw new Error('base and head must be full commit SHAs');
  git(cwd, ['checkout', '-q', '--detach', '-f', base]);
  const r = git(cwd, ['merge', '--no-ff', '--no-edit', '-m', message, head], { allowFail: true });
  if (r.status !== 0) {
    const files = git(cwd, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true }).out.split('\n').filter(Boolean);
    git(cwd, ['merge', '--abort'], { allowFail: true });
    return { status: 'conflict', base, head, files };
  }
  const merge = revParse(cwd, 'HEAD');
  return { status: 'composed', base, head, merge, tree: git(cwd, ['rev-parse', 'HEAD^{tree}']).out, contains_base: git(cwd, ['merge-base', '--is-ancestor', base, head], { allowFail: true }).status === 0 };
}

const defaultPush = (cwd, remote, merge, base) => git(cwd, ['push', '--porcelain', `--force-with-lease=refs/heads/main:${base}`, remote, `${merge}:refs/heads/main`]);
const remoteRef = (cwd, remote, ref) => { const r = git(cwd, ['ls-remote', remote, ref], { allowFail: true }); return r.status === 0 && r.out ? r.out.split(/\s+/)[0] : null; };

// The PR's own state, read back; null when it cannot be read (said so).
function prState(gh, repo, number) {
  if (!gh || !repo || !number) return null;
  try {
    const out = gh(['api', `repos/${repo}/pulls/${number}`, '--jq', '{merged: .merged, state: .state, merge_commit_sha: .merge_commit_sha}']);
    return JSON.parse(out);
  } catch (err) {
    return { error: String(err && err.message || err).slice(0, 300) };
  }
}

function promote(cwd, { base, head, branch, tree, message, remote = 'origin', repo = null, number = null, gh = null, push = defaultPush, prWaitMs = 0, sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } }) {
  if (!SHA_RE.test(base) || !SHA_RE.test(head) || !/^[0-9a-f]{40}$/.test(String(tree))) throw new Error('base, head and tree must be full SHAs');
  if (!BRANCH_RE.test(String(branch))) throw new Error(`${branch} is not a backlog branch`);
  const out = { status: null, base, head, branch, tree, merge: null, number, branch_deleted: false, branch_note: null, pr: null, error: null };
  const mainNow = remoteRef(cwd, remote, 'refs/heads/main');
  if (mainNow !== base) return { ...out, status: 'base_moved', main: mainNow };
  const tip = remoteRef(cwd, remote, `refs/heads/${branch}`);
  if (tip !== head) return { ...out, status: 'head_moved', branch_tip: tip };
  git(cwd, ['fetch', '-q', remote, `+refs/heads/main:refs/remotes/${remote}/main`, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`], { allowFail: true });
  if (!revParse(cwd, base)) return { ...out, status: 'base_moved', main: remoteRef(cwd, remote, 'refs/heads/main') };
  if (!revParse(cwd, head)) return { ...out, status: 'head_moved', branch_tip: remoteRef(cwd, remote, `refs/heads/${branch}`) };
  const c = compose(cwd, { base, head, message });
  if (c.status !== 'composed') return { ...out, status: 'conflict', files: c.files };
  if (c.tree !== tree) return { ...out, status: 'tree_mismatch', composed_tree: c.tree };
  out.merge = c.merge;
  try {
    push(cwd, remote, c.merge, base);
  } catch (err) {
    out.error = String(err && err.message || err).slice(0, 600);
  }
  // The remote's main decides, not the push's exit: a reply lost after the
  // push landed is still a merge, and a refused push changed nothing.
  const after = remoteRef(cwd, remote, 'refs/heads/main');
  if (after !== c.merge) return { ...out, status: after === base ? 'push_failed' : 'base_moved', main: after };
  out.status = 'merged';
  // Delete only the tested commit: a branch that moved since is kept.
  const del = git(cwd, ['push', '--porcelain', `--force-with-lease=refs/heads/${branch}:${head}`, remote, '--delete', branch], { allowFail: true });
  const left = remoteRef(cwd, remote, `refs/heads/${branch}`);
  out.branch_deleted = left === null;
  if (!out.branch_deleted) out.branch_note = left === head ? `the branch could not be deleted: ${(del.err || del.out || 'unknown error').slice(0, 300)}` : 'the branch moved past the tested commit after the merge, so it was kept';
  for (let i = 0; ; i++) {
    out.pr = prState(gh, repo, number);
    if (!out.pr || out.pr.merged === true || i * 3000 >= prWaitMs) break;
    sleep(3000);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Engineering lane (Connected Engineering v1, Eric 2026-10-25;
// audits/2026-10-25-connected-engineering). The desk's private inbox decides
// what is authorized; this script only reads its public, sanitized answers:
//   /engineering/admissions/<task>  whether a bound entry may join the backlog
//   /engineering/attestations/<sha> whether that exact head may be promoted
// An unreadable desk is a refusal, never a pass.

const ADMISSION_BRANCH_RE = /^claude\/admission-(eng-\d{8}-[0-9a-f]{6})$/;
const ENG_BRANCH_RE = /^claude\/backlog-eng-(\d+)$/;
const sha256hex = (s) => require('crypto').createHash('sha256').update(s).digest('hex');
function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { i += 1; if (glob[i + 1] === '/') { i += 1; re += '(?:.*/)?'; } else re += '.*'; } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// The desk's public JSON: { status, json } (null json when not JSON). Only
// https, or http to this machine for tests.
async function defaultFetchJson(url) {
  const u = new URL(url);
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)))) throw new Error(`refusing to read ${u.protocol}//${u.host}`);
  const res = await fetch(u, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: res.status, json };
}
async function deskRead(fetchJson, desk, path) {
  if (!desk) return { error: 'no desk address is set (DESK_URL)' };
  try {
    const r = await fetchJson(`${String(desk).replace(/\/+$/, '')}${path}`);
    if (r.status === 404) return { missing: true };
    if (r.status !== 200 || !r.json) return { error: `the desk answered ${r.status}` };
    return { json: r.json };
  } catch (err) {
    return { error: `the desk could not be read (${String(err && err.message || err).slice(0, 160)})` };
  }
}

// Where an admission adds its entry: after the backlog's last numbered item
// and its indented lines, before anything else in the section.
function insertEntry(text, entry) {
  const lines = String(text).split('\n');
  const s = lines.findIndex((l) => /^## Autonomous Build Backlog/.test(l));
  if (s < 0) throw new Error('DESK_STATE.md has no "## Autonomous Build Backlog" section');
  let e = lines.findIndex((l, i) => i > s && /^## /.test(l));
  if (e < 0) e = lines.length;
  let last = -1;
  for (let i = s + 1; i < e; i++) if (/^\s*- \[[ xX]\] (\*\([^)]*\)\* )?\*\*\d+\./.test(lines[i])) last = i;
  let at = e;
  if (last >= 0) {
    at = last + 1;
    while (at < e && (lines[at].startsWith('  ') || (lines[at] === '' && at + 1 < e && lines[at + 1].startsWith('  ')))) at += 1;
  }
  const add = String(entry).replace(/\n$/, '').split('\n');
  lines.splice(at, 0, ...add);
  return lines.join('\n');
}

// The shape of one admitted entry (blueprint §6): its unticked engineering
// item line, then only its own detail lines, so nothing in it reads as
// another item, a heading or another section. The task's text is quoted
// (escaped) inside those lines by the desk.
const ENTRY_ITEM_RE = /^- \[ \] \*\*\d+\. .*\*\(engineering task eng-\d{8}-[0-9a-f]{6} v\d+, sha256 [0-9a-f]{16}, [^)\n]*\)\*$/;
const ENTRY_DETAIL_RE = /^ {2}- (?:Outcome|Acceptance|Scope|Not in scope): \S/;
function entryProblems(entry) {
  const text = String(entry);
  const out = [];
  if (!text.endsWith('\n') || text.endsWith('\n\n') || /\r/.test(text)) out.push('it is LF lines ending in one newline');
  const lines = text.replace(/\n$/, '').split('\n');
  if (!ENTRY_ITEM_RE.test(lines[0] || '')) out.push('its first line is not one unticked engineering item');
  const bad = lines.slice(1).findIndex((l) => !ENTRY_DETAIL_RE.test(l));
  if (bad >= 0) out.push(`its line ${bad + 2} is not one of the item's own detail lines (Outcome, Acceptance, Scope, Not in scope)`);
  const items = backlogItems(text).size;
  if (items !== 1) out.push(`it reads as ${items} backlog items`);
  return out.length ? [`an admission adds one engineering item and its own detail lines only: ${out.join('; ')}`] : [];
}

// The desk's public reads say codes (no free text, finding 7 of the review of
// PR #16); the workflow says them in words.
const DESK_REASONS = {
  paused: 'engineering is paused',
  unsupported_schema: 'the task record is in a schema this desk does not read',
  number_unbound: 'no number is bound',
  not_authorized: 'the task is not authorized',
  authorization_stale: 'the authorization is for another version than the current one',
  delegation_missing: 'its delegation is missing',
  delegation_revoked: 'its delegation was revoked',
  delegation_expired: 'its delegation expired',
  not_current_candidate: 'this head is not the task\'s current candidate',
  admission_unconfirmed: 'its admission is not confirmed on main',
  verification_missing: 'no passing verification with every acceptance check met is recorded for this head',
  ci_failed: 'GitHub\'s check runs on this head failed, as the desk read them',
  release_by_owner: 'this task is released by Eric (release mode owner)',
};
function deskReason(code) {
  const [k, ...p] = String(code).split(':');
  if (k === 'task_status' && p[0]) return `the task is ${p[0]}`;
  if (k === 'review_not_passed' && p[0]) return `the required ${p[0]} review has not passed on this head (${p[1] || 'pending'})`;
  return DESK_REASONS[k] || `desk code ${String(code).slice(0, 60)}`;
}

// The exact diff of a candidate on its base, as engineering-worker evidence
// sends it and the desk hashes it: Git's own bytes, nothing trimmed.
function candidateDiff(cwd, base, head) {
  const opts = { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 };
  const d = spawnSync('git', ['diff', '--binary', '--no-color', '--no-ext-diff', '--full-index', '--no-renames', base, head], opts);
  const n = spawnSync('git', ['diff', '--no-renames', '--name-only', base, head], opts);
  if (d.status !== 0 || n.status !== 0) return null;
  return { diff: d.stdout, diff_sha256: sha256hex(d.stdout), files: n.stdout.split('\n').filter(Boolean) };
}

// The added text of an admission branch, read as data: it may change only
// DESK_STATE.md, by exactly one entry inserted where insertEntry puts it.
function admissionDiff(cwd, { base, head }) {
  const reasons = [];
  const names = git(cwd, ['diff', '--no-renames', '--name-only', base, head]).out.split('\n').filter(Boolean);
  if (names.length !== 1 || names[0] !== 'DESK_STATE.md') reasons.push(`an admission changes only DESK_STATE.md, not ${names.join(', ') || 'nothing'}`);
  const diff = git(cwd, ['diff', '--no-renames', '--no-color', '-U0', base, head, '--', 'DESK_STATE.md']).out.split('\n');
  const hunks = diff.filter((l) => l.startsWith('@@')).length;
  const removed = diff.filter((l) => l.startsWith('-') && !l.startsWith('---'));
  const added = diff.filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
  if (removed.length) reasons.push('an admission removes or changes no line');
  if (hunks !== 1) reasons.push(`an admission adds one block, not ${hunks}`);
  const entry = added.length ? `${added.join('\n')}\n` : '';
  const before = git(cwd, ['show', `${base}:DESK_STATE.md`], { allowFail: true });
  const after = git(cwd, ['show', `${head}:DESK_STATE.md`], { allowFail: true });
  if (!reasons.length && before.status === 0 && after.status === 0) {
    let want = null;
    try { want = insertEntry(rawShow(cwd, base, 'DESK_STATE.md'), entry); } catch (err) { reasons.push(err.message); }
    if (want !== null && want !== rawShow(cwd, head, 'DESK_STATE.md')) reasons.push('the entry is not where an admission adds it (after the backlog\'s last item)');
  }
  const first = added[0] || '';
  const num = /^- \[ \] \*\*(\d+)\. /.exec(first);
  const mark = ENG_MARK_RE.exec(first);
  if (!num || !mark) reasons.push('the added block does not start with an unticked engineering item line');
  if (entry) reasons.push(...entryProblems(entry));
  return { reasons, entry, number: num ? Number(num[1]) : null, task_id: mark ? mark[1] : null, version: mark ? Number(mark[2]) : null, sha256_prefix: mark ? mark[3] : null };
}
// File content exactly as stored (git show trims nothing when read raw).
function rawShow(cwd, rev, file) {
  const r = spawnSync('git', ['show', `${rev}:${file}`], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${file} is not in ${String(rev).slice(0, 12)}`);
  return r.stdout;
}

// Numbers an open intake branch adds (Eric's ready-label flow), so an
// admission never takes one of them.
function intakeNumbers(cwd, remote) {
  const refs = git(cwd, ['ls-remote', remote, 'refs/heads/claude/intake-issue-*'], { allowFail: true }).out.split('\n').filter(Boolean).map((l) => l.split(/\s+/)[1]);
  const nums = new Set();
  for (const ref of refs) {
    const local = `refs/remotes/${remote}/${ref.replace('refs/heads/', '')}`;
    if (git(cwd, ['fetch', '-q', remote, `+${ref}:${local}`], { allowFail: true }).status !== 0) continue;
    const t = git(cwd, ['show', `${local}:DESK_STATE.md`], { allowFail: true });
    if (t.status === 0) for (const n of backlogItems(t.out).keys()) nums.add(n);
  }
  return nums;
}

// Adds a bound entry to main by compare-and-swap. The desk's admission record
// decides; the branch only carries the entry. The entry is re-applied onto
// main as it is (never a merge), so two admissions never conflict.
async function admit(cwd, { branch, head, desk, remote = 'origin', fetchJson = defaultFetchJson, push = defaultPush, tries = 3 }) {
  const m = ADMISSION_BRANCH_RE.exec(String(branch));
  if (!m) throw new Error(`${branch} is not an admission branch`);
  if (!SHA_RE.test(String(head))) throw new Error('head must be a full commit SHA');
  const taskId = m[1];
  const out = { status: null, task_id: taskId, branch, head, number: null, merge: null, base: null, reasons: [], branch_deleted: false };
  const tip = remoteRef(cwd, remote, `refs/heads/${branch}`);
  if (tip !== head) return { ...out, status: 'head_moved', branch_tip: tip };
  git(cwd, ['fetch', '-q', remote, `+refs/heads/main:refs/remotes/${remote}/main`, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
  const mb = git(cwd, ['merge-base', `refs/remotes/${remote}/main`, head]).out;
  const d = admissionDiff(cwd, { base: mb, head });
  out.number = d.number;
  if (d.task_id && d.task_id !== taskId) d.reasons.push(`the entry names ${d.task_id}, not ${taskId}`);
  if (d.reasons.length) return { ...out, status: 'refused', reasons: d.reasons };
  const a = await deskRead(fetchJson, desk, `/engineering/admissions/${taskId}`);
  if (a.error || a.missing) return { ...out, status: 'refused', reasons: [a.error || `the desk has no admission for ${taskId}`] };
  const rec = a.json;
  const want = [];
  if (rec.admissible !== true) want.push(...(rec.reasons || ['not admissible']).map((x) => `desk: ${deskReason(x)}`));
  if (rec.task_id !== taskId) want.push('desk: another task');
  if (rec.number !== d.number) want.push(`desk: the bound number is ${rec.number}, not ${d.number}`);
  if (rec.version !== d.version) want.push(`desk: the current version is ${rec.version}, not ${d.version}`);
  if (rec.entry_sha256 !== sha256hex(d.entry)) want.push('desk: the entry is not the bound entry (hash differs)');
  if (!String(rec.content_sha256 || '').startsWith(d.sha256_prefix || '-')) want.push('desk: the content hash differs');
  if (want.length) return { ...out, status: 'refused', reasons: want };
  for (let i = 0; i < tries; i++) {
    git(cwd, ['fetch', '-q', remote, `+refs/heads/main:refs/remotes/${remote}/main`]);
    const base = revParse(cwd, `refs/remotes/${remote}/main`);
    out.base = base;
    const text = rawShow(cwd, base, 'DESK_STATE.md');
    if (text.includes(d.entry)) { out.status = 'already_on_main'; out.merge = base; break; }
    const items = backlogItems(text);
    // One task holds one backlog number, whatever a worker recorded since.
    const held = [...items].find(([, it]) => it.engineering && it.engineering.task_id === taskId);
    if (held) return { ...out, status: 'refused', reasons: [`${taskId} is already on main as item ${held[0]} (task_on_main): one task holds one backlog number; the worker confirms item ${held[0]} from main instead`], task_on_main: held[0] };
    if (items.has(d.number)) return { ...out, status: 'refused', reasons: [`number ${d.number} is already on main's backlog (number_taken)`], number_taken: true };
    if (intakeNumbers(cwd, remote).has(d.number)) return { ...out, status: 'refused', reasons: [`number ${d.number} is on an open intake branch (number_taken)`], number_taken: true };
    const next = insertEntry(text, d.entry);
    // Main's backlog after the change is the one before plus exactly this one
    // engineering item, every other item as it was, and no section added.
    const nextItems = backlogItems(next);
    const kept = [...items].every(([n, it]) => nextItems.has(n) && JSON.stringify(nextItems.get(n)) === JSON.stringify(it));
    const mine = nextItems.get(d.number);
    const sections = (s) => (s.match(/^## /gm) || []).length;
    if (!kept || nextItems.size !== items.size + 1 || !mine || !mine.engineering || mine.engineering.task_id !== taskId || mine.ticked || mine.eric || sections(next) !== sections(text) || next.length !== text.length + d.entry.length) {
      return { ...out, status: 'refused', reasons: ['an admission adds one engineering item and its own detail lines only: main\'s backlog would change by more than this one item'] };
    }
    git(cwd, ['checkout', '-q', '--detach', '-f', base]);
    fs.writeFileSync(require('path').join(cwd, 'DESK_STATE.md'), next);
    const added = [...next.matchAll(new RegExp(`^\\s*- \\[[ xX]\\] (\\*\\([^)]*\\)\\* )?\\*\\*${d.number}\\.`, 'gm'))].length;
    if (added !== 1) return { ...out, status: 'refused', reasons: [`number ${d.number} would appear ${added} times`] };
    git(cwd, ['add', 'DESK_STATE.md']);
    git(cwd, ['commit', '-q', '-m', `admission: backlog item ${d.number} for ${taskId} v${d.version}\n\nAdded by engineering-admission from the desk's bound entry; built only through the engineering lane.\n\nEngineering-Admission: ${taskId} v${d.version}\nEntry-SHA256: ${rec.entry_sha256}`]);
    const merge = revParse(cwd, 'HEAD');
    try { push(cwd, remote, merge, base); } catch (err) { out.error = String(err && err.message || err).slice(0, 300); }
    const after = remoteRef(cwd, remote, 'refs/heads/main');
    if (after === merge) { out.status = 'merged'; out.merge = merge; break; }
    if (after === base) return { ...out, status: 'push_failed', main: after };
    out.status = 'base_moved';
  }
  if (out.status === 'merged' || out.status === 'already_on_main') {
    git(cwd, ['push', '--porcelain', `--force-with-lease=refs/heads/${branch}:${head}`, remote, '--delete', branch], { allowFail: true });
    out.branch_deleted = remoteRef(cwd, remote, `refs/heads/${branch}`) === null;
  }
  return out;
}

// For a branch whose commits name an engineering item: promoted alone, from
// its own branch, only while the desk attests this exact head (verified,
// reviewed as required, not paused, inside its approved paths). The desk has
// no Git: the diff and files it attests are what the review read, and they
// are recomputed here from Git on the reviewed base and must match byte for
// byte. A review covers one head on one base: once main has moved past that
// base, the candidate is rebuilt and reviewed again (blueprint §8).
async function engineeringCheck(cwd, { base, head, branch, scope, desk, fetchJson = defaultFetchJson }) {
  const desk0 = git(cwd, ['show', `${base}:DESK_STATE.md`], { allowFail: true });
  const items = backlogItems(desk0.status === 0 ? desk0.out : '');
  const eng = scope.items.filter((n) => items.get(n) && items.get(n).engineering);
  if (!eng.length) return { engineering: false, ok: true, reasons: [] };
  const n = eng[0];
  const it = items.get(n).engineering;
  const reasons = [];
  if (scope.items.length !== 1) reasons.push(`engineering item ${n} is promoted alone, never with items ${scope.items.filter((x) => x !== n).join(', ')}`);
  const m = ENG_BRANCH_RE.exec(String(branch || ''));
  if (!m || Number(m[1]) !== n) reasons.push(`engineering item ${n} is promoted only from claude/backlog-eng-${n}`);
  const a = await deskRead(fetchJson, desk, `/engineering/attestations/${head}`);
  let att = null;
  if (a.error) reasons.push(a.error);
  else if (a.missing) reasons.push(`the desk has no record of head ${head.slice(0, 12)} for ${it.task_id}`);
  else {
    att = a.json;
    if (att.promotable !== true) reasons.push(...(att.reasons || ['not promotable']).map((x) => `desk: ${deskReason(x)}`));
    if (att.task_id !== it.task_id) reasons.push(`desk: the head belongs to ${att.task_id}, not ${it.task_id}`);
    if (att.number !== n) reasons.push(`desk: the task holds item ${att.number}, not ${n}`);
    if (att.version !== it.version) reasons.push(`desk: the task is at version ${att.version}, item ${n} names version ${it.version}`);
    const mb = git(cwd, ['merge-base', base, head], { allowFail: true }).out;
    if (mb !== att.merge_base_sha) reasons.push(`the merge base ${String(mb).slice(0, 12)} is not the one verified and reviewed (${String(att.merge_base_sha).slice(0, 12)}); the candidate needs rebuilding`);
    const main = revParse(cwd, base);
    if (att.required_review !== 'none' && main !== att.merge_base_sha) reasons.push(`main has moved since the review: the ${att.required_review} review is of head ${head.slice(0, 12)} on ${String(att.merge_base_sha).slice(0, 12)}, and main is ${String(main).slice(0, 12)}. A review covers one head on one base: rebuild the candidate on current main, verify it and have it reviewed again`);
    const real = SHA_RE.test(String(att.merge_base_sha || '')) ? candidateDiff(cwd, att.merge_base_sha, head) : null;
    if (!real) reasons.push('the diff of this head on its reviewed base could not be computed from Git');
    else {
      if (real.diff_sha256 !== att.diff_sha256) reasons.push(`the diff the review read is not the Git diff of this head on its base (SHA-256 ${String(att.diff_sha256).slice(0, 12)} on the desk, ${real.diff_sha256.slice(0, 12)} from Git)`);
      const listed = Array.isArray(att.files) ? att.files : [];
      for (const f of real.files) if (!listed.includes(f)) reasons.push(`${f} is changed but was not in the reviewed diff`);
      for (const f of listed) if (!real.files.includes(f)) reasons.push(`${f} is in the reviewed diff but this head does not change it`);
    }
    const allowed = Array.isArray(att.allowed_paths) ? att.allowed_paths : [];
    for (const f of scope.changed) if (!allowed.some((g) => globRe(g).test(f))) reasons.push(`${f} is outside the task's approved scope`);
    // Whatever the task record says: a delegation never changes these.
    if (att.delegation) for (const f of scope.changed) { const r = DELEGATION_RESTRICTED.find((x) => x.re.test(f)); if (r) reasons.push(`${f}: ${r.why}; this item was admitted by delegation ${att.delegation.policy_id} (${att.delegation.template}), so it waits for Eric`); }
  }
  return { engineering: true, ok: reasons.length === 0, reasons, item: n, task_id: it.task_id, attestation: att ? { promotable: att.promotable, review_state: att.review_state, required_review: att.required_review, merge_base_sha: att.merge_base_sha, diff_sha256: att.diff_sha256 } : null };
}

// One plain summary per result; only a confirmed merge says merged.
function summaryOf(kind, r) {
  if (kind === 'admission') {
    if (r.status === 'merged') return `### Admitted: backlog item ${r.number} for ${r.task_id} is on main as ${String(r.merge).slice(0, 7)}\n\nThe desk's bound entry, added by compare-and-swap. ${r.branch_deleted ? `Branch ${r.branch} deleted.` : `Branch ${r.branch} kept.`}`;
    if (r.status === 'already_on_main') return `Backlog item ${r.number} for ${r.task_id} was already on main; nothing added.`;
    return `### Not admitted (${r.status})\n\n${(r.reasons || []).map((x) => `- ${x}`).join('\n') || r.error || 'No reason was given.'}\n\nMain is unchanged. The builder reads this back and, for a taken number, binds the next one.`;
  }
  if (kind === 'engineering') return r.ok ? `Engineering item ${r.item} (${r.task_id}): the desk attests this head.` : `### Engineering item ${r.item} (${r.task_id}) is not promoted\n\n${r.reasons.map((x) => `- ${x}`).join('\n')}`;
  const short = (s) => (s ? String(s).slice(0, 7) : 'unknown');
  if (kind === 'scope') return r.ok ? `Scope: items ${r.items.join(', ') || 'none'}, ${r.commits} ${r.commits === 1 ? 'commit' : 'commits'}, no protected path.` : `### Needs Eric: not promoted\n\n${r.reasons.map((x) => `- ${x}`).join('\n')}\n\nThe PR stays open for his review.`;
  if (kind === 'compose') return r.status === 'composed' ? `Composed ${short(r.head)} onto main ${short(r.base)} (tree ${short(r.tree)}${r.contains_base ? ', the branch already contains main' : ''}).` : `### Not promoted: the branch does not merge cleanly onto main ${short(r.base)}\n\nConflicts: ${(r.files || []).join(', ') || 'unknown'}. Resolve it with \`npm run train\`.`;
  const pr = r.pr ? (r.pr.error ? ` The PR's state could not be read (${r.pr.error}).` : r.pr.merged ? ` PR #${r.number} reads merged.` : ` PR #${r.number} does not read merged yet (state ${r.pr.state}); main holds the merge.`) : '';
  switch (r.status) {
    case 'merged': return `### Merged into main as ${short(r.merge)}\n\nThe tree that passed the suite on main ${short(r.base)} (tree ${short(r.tree)}).${pr} ${r.branch_deleted ? `Branch ${r.branch} deleted.` : `Branch ${r.branch} kept: ${r.branch_note}.`}\n\nThis is the merge only. Deployment is reported on its own.`;
    case 'base_moved': return `### Not merged: main moved\n\nMain is ${short(r.main)}, not ${short(r.base)} where the composition was tested${r.error ? ` (${r.error})` : ''}. Nothing landed. Re-run this workflow to test against the new main, or use \`npm run train\`.`;
    case 'head_moved': return `### Not merged: the branch moved\n\nThe branch is at ${short(r.branch_tip)}, not the tested ${short(r.head)}; its own run handles the newer commit.`;
    case 'tree_mismatch': return `### Not merged: the re-created merge is not the tree that was tested\n\nTested ${short(r.tree)}, re-created ${short(r.composed_tree)}. Nothing landed.`;
    case 'conflict': return `### Not merged: the merge no longer applies cleanly\n\n${(r.files || []).join(', ')}`;
    default: return `### Not merged: the push was refused\n\n${r.error || 'No reason was given.'} Main is unchanged at ${short(r.main)}.`;
  }
}

function emit(kind, result, flat) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(flat).map(([k, v]) => `${k}=${String(v === null || v === undefined ? '' : v).replace(/[\r\n]+/g, ' ')}\n`).join(''));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summaryOf(kind, result)}\n\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function main(argv, { fetchJson = defaultFetchJson } = {}) {
  const [kind, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) flags[rest[i].replace(/^--/, '')] = rest[i + 1];
  const cwd = process.cwd();
  const desk = flags.desk || process.env.DESK_URL || null;
  if (kind === 'scope') {
    const r = scopeCheck(cwd, { base: flags.base, head: flags.head });
    if (r.ok) {
      const e = await engineeringCheck(cwd, { base: flags.base, head: flags.head, branch: flags.branch, scope: r, desk, fetchJson });
      if (e.engineering) {
        r.engineering = e;
        if (!e.ok) { r.ok = false; r.reasons.push(...e.reasons); }
      }
    }
    emit(kind, r, { scope_ok: r.ok, items: r.items.join(' ') });
    return 0;
  }
  if (kind === 'compose') {
    const r = compose(cwd, { base: flags.base, head: flags.head, message: flags.message });
    emit(kind, r, { composed: r.status === 'composed', tree: r.tree, contains_base: r.contains_base });
    return r.status === 'composed' ? 0 : 1;
  }
  if (kind === 'promote') {
    // The desk is asked again just before the push: a pause, a revoked
    // delegation or a newer candidate since the scope check stops it here.
    git(cwd, ['fetch', '-q', 'origin', `+refs/heads/${flags.branch}:refs/remotes/origin/${flags.branch}`], { allowFail: true });
    if (revParse(cwd, flags.head)) {
      const sc = scopeCheck(cwd, { base: flags.base, head: flags.head });
      const e = await engineeringCheck(cwd, { base: flags.base, head: flags.head, branch: flags.branch, scope: sc, desk, fetchJson });
      if (e.engineering && !e.ok) {
        emit('engineering', e, { status: 'engineering_refused', merge: '', branch_deleted: false });
        return 1;
      }
    }
    const gh = (args) => run(cwd, 'gh', args).out;
    const r = promote(cwd, { base: flags.base, head: flags.head, branch: flags.branch, tree: flags.tree, message: flags.message, repo: flags.repo, number: flags.number, gh, prWaitMs: 30000 });
    emit(kind, r, { status: r.status, merge: r.merge, branch_deleted: r.branch_deleted });
    return r.status === 'merged' ? 0 : 1;
  }
  if (kind === 'admission') {
    const r = await admit(cwd, { branch: flags.branch, head: flags.head, desk, fetchJson });
    emit(kind, r, { status: r.status, merge: r.merge, number: r.number });
    return r.status === 'merged' || r.status === 'already_on_main' ? 0 : 1;
  }
  process.stderr.write('Usage: backlog-promote.js scope|compose|promote|admission --base <sha> --head <sha> [--branch b --tree t --repo o/r --number n --message m --desk https://…]\n');
  return 2;
}

if (require.main === module) main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (err) => { process.stderr.write(`${err && err.message || err}\n`); process.exitCode = 1; });

module.exports = { PROTECTED, PROTECTED_LINES, DELEGATION_RESTRICTED, ENG_MARK_RE, backlogItems, scopeCheck, compose, promote, summaryOf, insertEntry, entryProblems, deskReason, candidateDiff, admissionDiff, admit, engineeringCheck, main };
