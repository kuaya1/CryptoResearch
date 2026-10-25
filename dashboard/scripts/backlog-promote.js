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
  { re: /^dashboard\/scripts\/(backlog-promote|backlog-intake|merge-train)\.js$/, why: 'promotion controls' },
  { re: /^dashboard\/(oauth|mcp|hosted)\.js$/, why: 'authorization (sign-in and connector grants)' },
  { re: /^server\.js$/, why: 'the hosted entry point' },
  { re: /^dashboard\/core\/(portfolio|wallets|walletsync|alchemy)\.js$/, why: 'financial records (the ledger and wallets)' },
  { re: /^(package(-lock)?\.json|dashboard\/web\/package(-lock)?\.json)$/, why: 'dependencies and scripts' },
  { re: /^render\.ya?ml$/, why: 'deployment' },
  { re: /^(portfolio|paper|projects|config|secrets)\//, why: 'records, never committed' },
];

function run(cwd, cmd, args, { allowFail = false, env = {} } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY, ...env }, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim().slice(0, 600)}`);
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
const git = (cwd, args, opts) => run(cwd, 'git', args, opts);
const revParse = (cwd, ref) => { const r = git(cwd, ['rev-parse', '--verify', '-q', `${ref}^{commit}`], { allowFail: true }); return r.status === 0 ? r.out : null; };

// The items main's backlog holds: number -> { ticked, eric }.
function backlogItems(text) {
  const out = new Map();
  for (const m of String(text || '').matchAll(/^\s*- \[([ x])\] (\*\(Eric\)\* )?\*\*(\d+)\./gm)) out.set(Number(m[3]), { ticked: m[1] === 'x', eric: Boolean(m[2]) });
  return out;
}

// Whether the branch stays inside the authorized scope; reasons in words.
function scopeCheck(cwd, { base, head }) {
  const reasons = [];
  const changed = git(cwd, ['diff', '--no-renames', '--name-status', `${base}...${head}`]).out.split('\n').filter(Boolean).map((l) => { const [st, ...p] = l.split('\t'); return { status: st[0], path: p.join('\t') }; });
  for (const c of changed) {
    const hit = PROTECTED.find((x) => x.re.test(c.path));
    if (hit) reasons.push(`${c.path}: ${hit.why}`);
    else if (/^templates\//.test(c.path) && c.status !== 'A') reasons.push(`${c.path}: a published template is ${c.status === 'D' ? 'removed' : 'edited'} (publish a new version instead)`);
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

// One plain summary per result; only a confirmed merge says merged.
function summaryOf(kind, r) {
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

function main(argv) {
  const [kind, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) flags[rest[i].replace(/^--/, '')] = rest[i + 1];
  const cwd = process.cwd();
  if (kind === 'scope') {
    const r = scopeCheck(cwd, { base: flags.base, head: flags.head });
    emit(kind, r, { scope_ok: r.ok, items: r.items.join(' ') });
    return 0;
  }
  if (kind === 'compose') {
    const r = compose(cwd, { base: flags.base, head: flags.head, message: flags.message });
    emit(kind, r, { composed: r.status === 'composed', tree: r.tree, contains_base: r.contains_base });
    return r.status === 'composed' ? 0 : 1;
  }
  if (kind === 'promote') {
    const gh = (args) => run(cwd, 'gh', args).out;
    const r = promote(cwd, { base: flags.base, head: flags.head, branch: flags.branch, tree: flags.tree, message: flags.message, repo: flags.repo, number: flags.number, gh, prWaitMs: 30000 });
    emit(kind, r, { status: r.status, merge: r.merge, branch_deleted: r.branch_deleted });
    return r.status === 'merged' ? 0 : 1;
  }
  process.stderr.write('Usage: backlog-promote.js scope|compose|promote --base <sha> --head <sha> [--branch b --tree t --repo o/r --number n --message m]\n');
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { PROTECTED, backlogItems, scopeCheck, compose, promote, summaryOf };
