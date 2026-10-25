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
//       the highest backlog number on main and on open intake and admission
//       branches, and the next free one
//   admission-commit --task <id> --entry-file <file> [--remote origin]
//       a local commit on top of main that adds the bound entry (no push)
//   admission-status --task <id> --entry-sha256 <hex> [--remote origin]
//       whether main holds the task's entry, byte for byte
//   remote-sha --ref <refs/heads/...> [--remote origin]
//       the remote ref's commit now (to reconcile an unconfirmed push)
//   push --ref <refs/heads/...> --sha <sha> [--expect <sha>|--expect-absent] [--remote origin]
//       a compare-and-swap push, then the ref read back
//   evidence --head <sha> [--base <ref>]
//       head, base, merge base, changed files and the exact diff
//   verify
//       runs node dashboard/cli.js test and reports totals, exit code,
//       the output's SHA-256 and its last 20 KB

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { insertEntry, backlogItems, candidateDiff, ENG_MARK_RE } = require('./backlog-promote');

const STATE_FILE = 'DESK_STATE.md';
const SHA_RE = /^[0-9a-f]{40}$/;
const TASK_RE = /^eng-\d{8}-[0-9a-f]{6}$/;
const REF_RE = /^refs\/heads\/claude\/(admission-eng-\d{8}-[0-9a-f]{6}|candidate-eng-\d+|backlog-eng-\d+)$/;
const MAX_TAIL = 20 * 1024;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function git(cwd, args, { allowFail = false, input = undefined, env = undefined } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, input, env: env ? { ...process.env, ...env } : process.env });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim().slice(0, 400)}`);
  return { status: r.status, out: (r.stdout || '').replace(/\n$/, ''), err: (r.stderr || '').trim() };
}
const remoteRef = (cwd, remote, ref) => {
  const line = git(cwd, ['ls-remote', remote, ref]).out.split('\n').find((l) => l.endsWith(`\t${ref}`));
  return line ? line.split('\t')[0] : null;
};
const fetchMain = (cwd, remote) => {
  git(cwd, ['fetch', '-q', remote, `+refs/heads/main:refs/remotes/${remote}/main`]);
  return git(cwd, ['rev-parse', `refs/remotes/${remote}/main`]).out;
};

function numbers(cwd, { remote = 'origin' } = {}) {
  const mainSha = fetchMain(cwd, remote);
  const fromText = (text) => [...backlogItems(text).keys()];
  const main = fromText(git(cwd, ['show', `${mainSha}:${STATE_FILE}`]).out);
  const branches = git(cwd, ['ls-remote', '--heads', remote, 'refs/heads/claude/intake-issue-*', 'refs/heads/claude/admission-*']).out.split('\n').filter(Boolean).map((l) => l.split('\t')[1]);
  const waiting = [];
  for (const ref of branches) {
    const local = `refs/remotes/${remote}/${ref.replace('refs/heads/', '')}`;
    if (git(cwd, ['fetch', '-q', remote, `+${ref}:${local}`], { allowFail: true }).status !== 0) { waiting.push({ branch: ref.replace('refs/heads/', ''), unreadable: true, numbers: [] }); continue; }
    const t = git(cwd, ['show', `${local}:${STATE_FILE}`], { allowFail: true });
    waiting.push({ branch: ref.replace('refs/heads/', ''), numbers: t.status === 0 ? fromText(t.out).filter((n) => !main.includes(n)) : [] });
  }
  const all = [...main, ...waiting.flatMap((w) => w.numbers)];
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
  const text = git(cwd, ['show', `${mainSha}:${STATE_FILE}`]).out;
  const lines = text.split('\n');
  const at = lines.findIndex((l) => { const m = ENG_MARK_RE.exec(l); return m && m[1] === task; });
  if (at < 0) return { confirmed: false, main_sha: mainSha, on_main: false, admission_branch: remoteRef(cwd, remote, `refs/heads/claude/admission-${task}`) };
  let end = at + 1;
  while (end < lines.length && lines[end].startsWith('  ')) end += 1;
  const entry = `${lines.slice(at, end).join('\n')}\n`;
  const n = Number((/^- \[[ x]\] \*\*(\d+)\./.exec(lines[at]) || [])[1]);
  return { confirmed: !entrySha256 || sha256(entry) === entrySha256, main_sha: mainSha, on_main: true, number: n, entry_sha256: sha256(entry), matches_bound: entrySha256 ? sha256(entry) === entrySha256 : null };
}

function checkRef(ref) { if (!REF_RE.test(String(ref || ''))) throw new Error('--ref is refs/heads/claude/admission-<task>, candidate-eng-<n> or backlog-eng-<n>'); }

function remoteSha(cwd, { ref, remote = 'origin' }) {
  checkRef(ref);
  return { ref, sha: remoteRef(cwd, remote, ref) };
}

function push(cwd, { ref, sha, expect = undefined, remote = 'origin' }) {
  checkRef(ref);
  if (!SHA_RE.test(String(sha || ''))) throw new Error('--sha is a full commit SHA');
  const lease = expect === null ? `--force-with-lease=${ref}:` : expect ? `--force-with-lease=${ref}:${expect}` : `--force-with-lease=${ref}`;
  const r = git(cwd, ['push', '--porcelain', lease, remote, `${sha}:${ref}`], { allowFail: true });
  const observed = remoteRef(cwd, remote, ref);
  return { ref, sha, pushed: r.status === 0, observed_sha: observed, landed: observed === sha, refusal: r.status === 0 ? null : (r.err || r.out).split('\n').slice(-3).join(' ').slice(0, 300) };
}

function evidence(cwd, { head, base = 'origin/main' }) {
  if (!SHA_RE.test(String(head || ''))) throw new Error('--head is a full commit SHA');
  const baseSha = git(cwd, ['rev-parse', `${base}^{commit}`]).out;
  const mb = git(cwd, ['merge-base', baseSha, head]).out;
  // The same bytes the promotion workflow recomputes before it merges.
  const d = candidateDiff(cwd, mb, head);
  if (!d) throw new Error(`git diff ${mb.slice(0, 12)} ${head.slice(0, 12)} failed`);
  return { head_sha: head, base_sha: baseSha, merge_base_sha: mb, files: d.files, diff: d.diff, diff_sha256: d.diff_sha256 };
}

function verify(cwd) {
  const r = spawnSync(process.execPath, [path.join(cwd, 'dashboard', 'cli.js'), 'test'], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  const num = (label) => { const m = new RegExp(`^\\S*\\s*${label}\\s+(\\d+)\\s*$`, 'm').exec(output); return m ? Number(m[1]) : null; };
  const total = num('tests');
  const passed = num('pass');
  const failed = num('fail');
  const head = git(cwd, ['rev-parse', 'HEAD']).out;
  return { head_sha: head, command: 'node dashboard/cli.js test', exit_code: r.status, total, passed, failed, output_sha256: sha256(output), output_tail: output.slice(-MAX_TAIL), ok: r.status === 0 && failed === 0 && total !== null && passed === total };
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
    case 'verify': return verify(cwd);
    default: throw new Error('Commands: numbers, admission-commit, admission-status, remote-sha, push, evidence, verify.');
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

module.exports = { numbers, admissionCommit, admissionStatus, remoteSha, push, evidence, verify, main };
