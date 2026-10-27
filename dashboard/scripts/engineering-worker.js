#!/usr/bin/env node
'use strict';
// The Git side of the engineering lane (Connected Engineering v1, 2026-10-25;
// audits/2026-10-25-connected-engineering): what the builder routine runs
// between its engineering connector calls. Each command prints one JSON
// answer. It reads Git and makes local commits; it pushes only with `push`,
// which the routine runs after recording the intent with the desk, and it
// never decides what the desk decides (authorization, numbers bound, review).
//
//   numbers [--remote origin]
//       the highest backlog number on main, in the issue queue and on open admission
//       branches, and the next free one
//   admission-commit --task <id> --entry-file <file> [--remote origin]
//       a local commit on top of main that adds the bound entry (no push)
//   admission-status --task <id> --entry-sha256 <hex> [--remote origin]
//       whether main holds the task's entry, byte for byte
//   remote-sha --ref <refs/heads/...> [--remote origin]
//       the remote ref's commit now (to reconcile an unconfirmed push)
//   push --ref <refs/heads/...> --sha <rev> [--expect <sha>|--expect-absent] [--remote origin]
//       a compare-and-swap push, then the ref read back
//   evidence --head <rev> [--base <ref>]
//       head, base, merge base, changed files and the exact diff
//   resolve --rev <rev>
//       the full commit SHA a revision names (a SHA or a prefix of one, a
//       branch, a tag): what to send the desk, never a padded one
//   bundle
//       rebuilds the browser app's bundle when it is stale (below)
//   verify
//       runs node dashboard/cli.js test and reports totals, exit code,
//       the output's SHA-256 and its last 20 KB; a stale bundle is rebuilt
//       first, and a rebuild that changes files stops it (commit, then verify)
//
// Calls to the remote are retried on a passing network failure only (a host
// or connection failure, an early EOF, HTTP 502, 503 or 504), after 1 s, 2 s
// and 4 s; anything else fails at once (2026-10-26). CR_ENG_RETRY_DELAYS_MS
// (milliseconds, comma-separated; empty for none) replaces the delays.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');
const { insertEntry, backlogItems, candidateDiff, ENG_MARK_RE, engEntryOf, queueNumbers } = require('./backlog-promote');

const STATE_FILE = 'DESK_STATE.md';
const SHA_RE = /^[0-9a-f]{40}$/;
const TASK_RE = /^eng-\d{8}-[0-9a-f]{6}$/;
const REF_RE = /^refs\/heads\/claude\/(admission-eng-\d{8}-[0-9a-f]{6}|candidate-eng-\d+|backlog-eng-\d+)$/;
const MAX_TAIL = 20 * 1024;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const TRANSIENT_RE = /Could not resolve host|Connection (?:reset|refused|timed out)|Operation timed out|Operation too slow|Failed to connect|early EOF|RPC failed|remote end hung up|returned error: 50[234]|HTTP\/?[\d.]* 50[234]|\b50[234] (?:Bad Gateway|Service Unavailable|Gateway Time-?out)|no answer within \d+ ms/i;
// Every call to the remote has a deadline (2026-10-26, the Cortex audit: a
// hung socket blocked the worker with none), and a call that misses it counts
// as a passing failure, asked again after the waits below. Two layers: git
// stops a transfer itself once it has moved under a byte a second for half
// the deadline (http.lowSpeedLimit and lowSpeedTime; it exits cleanly, its
// helpers with it), and the process is stopped at the deadline whatever it
// is waiting for. On Windows that stop reaches git's launcher only, so the
// first layer is the one that leaves nothing behind. CR_ENG_GIT_TIMEOUT_MS
// overrides the 30 s, for tests.
const remoteDeadline = () => {
  const v = Number(process.env.CR_ENG_GIT_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 30000;
};

function git(cwd, args, { allowFail = false, input = undefined, env = undefined, deadline = undefined } = {}) {
  const argv = deadline ? ['-c', 'http.lowSpeedLimit=1', '-c', `http.lowSpeedTime=${Math.max(1, Math.floor(deadline / 2000))}`, ...args] : args;
  const r = spawnSync('git', argv, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, input, env: env ? { ...process.env, ...env } : process.env, timeout: deadline });
  if (r.error && r.error.code === 'ETIMEDOUT') {
    const err = `git ${args[0]}: no answer within ${deadline} ms; stopped`;
    if (!allowFail) throw new Error(`git ${args.join(' ')} failed: ${err}`);
    return { status: null, out: '', err, timed_out: true };
  }
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim().slice(0, 400)}`);
  return { status: r.status, out: (r.stdout || '').replace(/\n$/, ''), err: (r.stderr || '').trim() };
}
const retryDelays = () => {
  const v = process.env.CR_ENG_RETRY_DELAYS_MS;
  return v === undefined ? [1000, 2000, 4000] : v.split(',').filter((x) => x.trim() !== '').map(Number).filter((x) => Number.isFinite(x) && x >= 0);
};
const pause = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
// A git call to the remote, asked again after a passing network failure.
function gitRemote(cwd, args, opts = {}) {
  const waits = retryDelays();
  for (let i = 0; ; i += 1) {
    const r = git(cwd, args, { ...opts, allowFail: true, deadline: remoteDeadline() });
    if (r.status === 0 || i >= waits.length || !TRANSIENT_RE.test(r.err)) {
      if (r.status !== 0 && !opts.allowFail) throw new Error(`git ${args.join(' ')} failed: ${(r.err || r.out).slice(0, 400)}`);
      return { ...r, attempts: i + 1 };
    }
    pause(waits[i]);
  }
}
const remoteRef = (cwd, remote, ref) => {
  const line = gitRemote(cwd, ['ls-remote', remote, ref]).out.split('\n').find((l) => l.endsWith(`\t${ref}`));
  return line ? line.split('\t')[0] : null;
};
const fetchMain = (cwd, remote) => {
  gitRemote(cwd, ['fetch', '-q', remote, `+refs/heads/main:refs/remotes/${remote}/main`]);
  return git(cwd, ['rev-parse', `refs/remotes/${remote}/main`]).out;
};
// The full commit SHA a revision names here, by git rev-parse --verify; an
// error when it names none.
function resolveRev(cwd, rev, flag = '--rev') {
  const s = String(rev || '');
  if (!/^[A-Za-z0-9][\w./~^@{}-]*$/.test(s)) throw new Error(`${flag} is a revision (a SHA or a prefix of one, a branch or a tag)`);
  const r = git(cwd, ['rev-parse', '--verify', '-q', `${s}^{commit}`], { allowFail: true });
  if (r.status !== 0 || !SHA_RE.test(r.out)) throw new Error(`${flag} ${s.slice(0, 80)} names no commit here (git rev-parse --verify)`);
  return r.out;
}

function numbers(cwd, { remote = 'origin' } = {}) {
  const mainSha = fetchMain(cwd, remote);
  const fromText = (text) => [...backlogItems(text).keys()];
  const main = fromText(git(cwd, ['show', `${mainSha}:${STATE_FILE}`]).out);
  const branches = gitRemote(cwd, ['ls-remote', '--heads', remote, 'refs/heads/claude/admission-*']).out.split('\n').filter(Boolean).map((l) => l.split('\t')[1]);
  const waiting = [];
  for (const ref of branches) {
    const local = `refs/remotes/${remote}/${ref.replace('refs/heads/', '')}`;
    if (gitRemote(cwd, ['fetch', '-q', remote, `+${ref}:${local}`], { allowFail: true }).status !== 0) { waiting.push({ branch: ref.replace('refs/heads/', ''), unreadable: true, numbers: [] }); continue; }
    const t = git(cwd, ['show', `${local}:${STATE_FILE}`], { allowFail: true });
    waiting.push({ branch: ref.replace('refs/heads/', ''), numbers: t.status === 0 ? fromText(t.out).filter((n) => !main.includes(n)) : [] });
  }
  // Every number the issue queue gave (backlog-queue.js), withdrawn ones too.
  const queue = queueNumbers(cwd, remote);
  waiting.push(queue === null ? { branch: 'agent-ledger (the issue queue)', unreadable: true, numbers: [] } : { branch: 'agent-ledger (the issue queue)', numbers: [...queue].filter((n) => !main.includes(n)).sort((a, b) => a - b) });
  const all =[...main, ...waiting.flatMap((w) => w.numbers)];
  const max = Math.max(0, ...all);
  return { main_sha: mainSha, observed_max: max, next: max + 1, main_max: Math.max(0, ...main), waiting, complete: !waiting.some((w) => w.unreadable) };
}

// A commit on top of main whose only change is the bound entry, made without
// touching the working tree (a temporary index).
function admissionCommit(cwd, { task, entryFile, remote = 'origin' }) {
  if (!TASK_RE.test(String(task || ''))) throw new Error('--task is an engineering task ID');
  const entry = fs.readFileSync(entryFile, 'utf8');
  const mark = ENG_MARK_RE.exec(entry);
  if (!mark || mark[1] !== task) throw new Error('the entry file is not this task\'s bound entry');
  const n = Number((/^- \[ \] \*\*(\d+)\./.exec(entry) || [])[1]);
  const mainSha = fetchMain(cwd, remote);
  const text = git(cwd, ['show', `${mainSha}:${STATE_FILE}`]).out;
  if (backlogItems(text).has(n)) return { status: 'number_on_main', number: n, main_sha: mainSha };
  const next = insertEntry(text, entry);
  const blob = git(cwd, ['hash-object', '-w', '--stdin'], { input: next.endsWith('\n') ? next : `${next}\n` }).out;
  const index = path.join(os.tmpdir(), `cr-admission-${process.pid}-${Date.now()}.idx`);
  try {
    const env = { GIT_INDEX_FILE: index };
    git(cwd, ['read-tree', mainSha], { env });
    const mode = git(cwd, ['ls-tree', mainSha, STATE_FILE]).out.split(/\s+/)[0] || '100644';
    git(cwd, ['update-index', '--cacheinfo', `${mode},${blob},${STATE_FILE}`], { env });
    const tree = git(cwd, ['write-tree'], { env }).out;
    const head = git(cwd, ['commit-tree', tree, '-p', mainSha, '-m', `admission: backlog item ${n} for ${task} v${mark[2]}`]).out;
    return { status: 'committed', task_id: task, number: n, head_sha: head, main_sha: mainSha, ref: `refs/heads/claude/admission-${task}`, entry_sha256: sha256(entry) };
  } finally {
    try { fs.unlinkSync(index); } catch (_) { /* not made */ }
  }
}

function admissionStatus(cwd, { task, entrySha256, remote = 'origin' }) {
  if (!TASK_RE.test(String(task || ''))) throw new Error('--task is an engineering task ID');
  const mainSha = fetchMain(cwd, remote);
  const found = engEntryOf(git(cwd, ['show', `${mainSha}:${STATE_FILE}`]).out, task);
  if (!found) return { confirmed: false, main_sha: mainSha, on_main: false, admission_branch: remoteRef(cwd, remote, `refs/heads/claude/admission-${task}`) };
  const h = sha256(found.entry);
  return { confirmed: !entrySha256 || h === entrySha256, main_sha: mainSha, on_main: true, number: found.number, entry_sha256: h, matches_bound: entrySha256 ? h === entrySha256 : null };
}

function checkRef(ref) { if (!REF_RE.test(String(ref || ''))) throw new Error('--ref is refs/heads/claude/admission-<task>, candidate-eng-<n> or backlog-eng-<n>'); }

function remoteSha(cwd, { ref, remote = 'origin' }) {
  checkRef(ref);
  return { ref, sha: remoteRef(cwd, remote, ref) };
}

function push(cwd, { ref, sha, expect = undefined, remote = 'origin' }) {
  checkRef(ref);
  const target = resolveRev(cwd, sha, '--sha');
  const lease = expect === null ? `--force-with-lease=${ref}:` : expect ? `--force-with-lease=${ref}:${expect}` : `--force-with-lease=${ref}`;
  const waits = retryDelays();
  let r;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    r = git(cwd, ['push', '--porcelain', lease, remote, `${target}:${ref}`], { allowFail: true, deadline: remoteDeadline() });
    if (r.status === 0 || attempts > waits.length || !TRANSIENT_RE.test(r.err)) break;
    // A push whose answer was lost may have landed: read the ref back
    // before pushing again.
    let seen = null;
    try { seen = remoteRef(cwd, remote, ref); } catch (_) { seen = null; }
    if (seen === target) { r = { status: 0, out: '', err: '' }; break; }
    pause(waits[attempts - 1]);
  }
  const observed = remoteRef(cwd, remote, ref);
  return { ref, sha: target, pushed: r.status === 0, observed_sha: observed, landed: observed === target, attempts, refusal: r.status === 0 ? null : (r.err || r.out).split('\n').slice(-3).join(' ').slice(0, 300) };
}

function evidence(cwd, { head: rev, base = 'origin/main' }) {
  const head = resolveRev(cwd, rev, '--head');
  const baseSha = git(cwd, ['rev-parse', `${base}^{commit}`]).out;
  const mb = git(cwd, ['merge-base', baseSha, head]).out;
  // The same bytes the promotion workflow recomputes before it merges.
  const d = candidateDiff(cwd, mb, head);
  if (!d) throw new Error(`git diff ${mb.slice(0, 12)} ${head.slice(0, 12)} failed`);
  return { head_sha: head, base_sha: baseSha, merge_base_sha: mb, files: d.files, diff: d.diff, diff_sha256: d.diff_sha256 };
}

// The browser app's bundle (dashboard/public/app) is built from its sources
// and committed with them; build.json holds the SHA-256 of what it was built
// from (dashboard/web/scripts/source-hash.mjs, which the suite checks). When
// that differs from the sources here, the bundle is rebuilt in dashboard/web
// (npm ci first when it has no node_modules). The tracked files the rebuild
// changed are listed, for the worker to commit with its change; the suite
// itself never builds, so CI still fails on a stale committed bundle.
function npm(cwd, command) {
  const r = spawnSync(`npm ${command}`, { cwd, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, tail: `${r.stdout || ''}${r.stderr || ''}`.slice(-4000) };
}
function bundle(cwd) {
  const web = path.join(cwd, 'dashboard', 'web');
  const stampFile = path.join(cwd, 'dashboard', 'public', 'app', 'build.json');
  const hasher = path.join(web, 'scripts', 'source-hash.mjs');
  if (!fs.existsSync(stampFile) || !fs.existsSync(hasher)) return { status: 'no_bundle' };
  const stamped = JSON.parse(fs.readFileSync(stampFile, 'utf8')).source_sha256;
  const code = `import { sourceHash } from ${JSON.stringify(pathToFileURL(hasher).href)}; process.stdout.write(sourceHash(${JSON.stringify(web)}));`;
  const h = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  if (h.status !== 0 || !/^[0-9a-f]{64}$/.test(h.stdout)) return { status: 'unreadable', says: `The bundle's source hash could not be computed: ${(h.stderr || '').trim().slice(0, 300)}` };
  if (h.stdout === stamped) return { status: 'current', source_sha256: stamped };
  if (!fs.existsSync(path.join(web, 'node_modules'))) {
    const i = npm(web, 'ci');
    if (!i.ok) return { status: 'build_failed', step: 'npm ci', output_tail: i.tail };
  }
  const b = npm(web, 'run build');
  if (!b.ok) return { status: 'build_failed', step: 'npm run build', output_tail: b.tail };
  const files = git(cwd, ['status', '--porcelain', '--untracked-files=all', '--', 'dashboard/public/app']).out.split('\n').filter(Boolean).map((l) => l.slice(3));
  return { status: files.length ? 'rebuilt' : 'current', files, source_sha256: h.stdout, stamped_was: stamped };
}

// What git status shows changed or untracked here (ignored files aside), by
// path; -z, so no path is quoted or misread.
function dirtyPaths(cwd) {
  const parts = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).out.split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    if (p.length < 4) continue;
    out.push(p.slice(3));
    if (p[0] === 'R' || p[0] === 'C') i += 1;
  }
  return out;
}
const BUNDLE_DIR = 'dashboard/public/app/';

// A sealed worktree (2026-10-26, the Cortex audit): a verification is of
// one committed head and nothing else. Changed or untracked files stop it
// before anything runs (dirty_worktree_detected), except the bundle's own
// files, which the bundle step rebuilds and asks to have committed. HEAD and
// its tree are read before the tests and again after: a head that moved or
// a worktree the run changed is not a verification of that head.
function verify(cwd) {
  const headNow = () => git(cwd, ['rev-parse', 'HEAD']).out;
  const stop = (status, says, extra = {}) => ({ head_sha: headNow(), command: 'node dashboard/cli.js test', status, ...extra, exit_code: null, total: null, passed: null, failed: null, ok: false, says });
  const dirt = dirtyPaths(cwd).filter((p) => !p.startsWith(BUNDLE_DIR));
  if (dirt.length) return stop('dirty_worktree_detected', `The worktree has ${dirt.length} uncommitted or untracked ${dirt.length === 1 ? 'file' : 'files'}: commit or remove them, then run verify again. Nothing was tested; a verification is always of a clean, committed head.`, { files: dirt.slice(0, 50) });
  const b = bundle(cwd);
  if (b.status === 'rebuilt' || b.status === 'build_failed') {
    const says = b.status === 'rebuilt'
      ? 'The bundle was stale and has been rebuilt: commit these files with the change, then run verify again. Nothing was tested; a verification is always of a committed head.'
      : `The bundle was stale and ${b.step} failed; nothing was tested.`;
    return stop(b.status === 'rebuilt' ? 'commit_bundle_first' : 'bundle_build_failed', says, { bundle: b });
  }
  const left = dirtyPaths(cwd);
  if (left.length) {
    const outside = left.filter((p) => !p.startsWith(BUNDLE_DIR));
    if (outside.length) return stop('dirty_worktree_detected', `The bundle step left ${outside.length} uncommitted or untracked ${outside.length === 1 ? 'file' : 'files'} outside the bundle; nothing was tested.`, { files: outside.slice(0, 50) });
    return stop('commit_bundle_first', 'The bundle\'s files differ from the commit: commit them with the change, then run verify again. Nothing was tested; a verification is always of a committed head.', { bundle: { ...b, files: left } });
  }
  const head = headNow();
  const tree = git(cwd, ['rev-parse', 'HEAD^{tree}']).out;
  const r = spawnSync(process.execPath, [path.join(cwd, 'dashboard', 'cli.js'), 'test'], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  const num = (label) => { const m = new RegExp(`^\\S*\\s*${label}\\s+(\\d+)\\s*$`, 'm').exec(output); return m ? Number(m[1]) : null; };
  const total = num('tests');
  const passed = num('pass');
  const failed = num('fail');
  const result = { head_sha: head, tree_sha: tree, worktree: 'clean', command: 'node dashboard/cli.js test', bundle: b.status, exit_code: r.status, total, passed, failed, output_sha256: sha256(output), output_tail: output.slice(-MAX_TAIL) };
  const after = headNow();
  const changed = dirtyPaths(cwd);
  if (after !== head || changed.length) {
    return { ...result, status: after !== head ? 'head_moved' : 'worktree_changed', head_after: after, files: changed.slice(0, 50), ok: false, says: after !== head ? `HEAD moved from ${head.slice(0, 12)} to ${after.slice(0, 12)} while the tests ran; this is no verification of either. Run verify again.` : `The tests left ${changed.length} changed or untracked ${changed.length === 1 ? 'file' : 'files'}; this is no verification of ${head.slice(0, 12)}. Restore them, then run verify again.` };
  }
  return { ...result, ok: r.status === 0 && failed === 0 && total !== null && passed === total };
}

function arg(argv, name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

function main(argv, cwd = process.cwd()) {
  const [cmd] = argv;
  const remote = arg(argv, 'remote', 'origin');
  switch (cmd) {
    case 'numbers': return numbers(cwd, { remote });
    case 'admission-commit': return admissionCommit(cwd, { task: arg(argv, 'task'), entryFile: arg(argv, 'entry-file'), remote });
    case 'admission-status': return admissionStatus(cwd, { task: arg(argv, 'task'), entrySha256: arg(argv, 'entry-sha256', null), remote });
    case 'remote-sha': return remoteSha(cwd, { ref: arg(argv, 'ref'), remote });
    case 'push': return push(cwd, { ref: arg(argv, 'ref'), sha: arg(argv, 'sha'), expect: argv.includes('--expect-absent') ? null : arg(argv, 'expect'), remote });
    case 'evidence': return evidence(cwd, { head: arg(argv, 'head'), base: arg(argv, 'base', `${remote}/main`) });
    case 'resolve': return { rev: arg(argv, 'rev'), sha: resolveRev(cwd, arg(argv, 'rev')) };
    case 'bundle': return bundle(cwd);
    case 'verify': return verify(cwd);
    default: throw new Error('Commands: numbers, admission-commit, admission-status, remote-sha, push, evidence, resolve, bundle, verify.');
  }
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)), null, 2)}\n`);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}

module.exports = { numbers, admissionCommit, admissionStatus, remoteSha, push, evidence, resolveRev, bundle, verify, main, TRANSIENT_RE };
