#!/usr/bin/env node
'use strict';
// Backlog status (backlog item 42): what the scheduled build routine decides
// in its first step, computed instead of read from an instruction.
//
//   node dashboard/scripts/backlog-status.js [--json]
//
// Reads git (after `git fetch origin --prune`, which the caller runs) and
// DESK_STATE.md on origin/main only; writes nothing. It gives the waiting items
// (Backlog-Item trailers on origin/claude/backlog-* branches not merged into
// origin/main, each counted once), the cap and batch size in force, the
// headroom (how many items may start now: the cap less what waits, at most one
// batch), the next buildable items and the base to build on.

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const STATE_FILE = 'DESK_STATE.md';
const SURGE_ENDS = '2026-10-28T03:00:00Z'; // 2026-10-27 23:00 New York time
const SURGE = { cap: 9, batch: 3 };
const AFTER = { cap: 4, batch: 2 };

function git(cwd, args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim().slice(0, 400)}`);
  return { status: r.status, out: (r.stdout || '').trim() };
}

const limitsAt = (now) => (now.getTime() < Date.parse(SURGE_ENDS) ? { ...SURGE, surge: true } : { ...AFTER, surge: false });
const trailers = (body) => [...body.matchAll(/^Backlog-Item:\s*(\d+)\s*$/gm)].map((m) => Number(m[1]));

// The backlog's checkbox lines: { n, checked, eric, text }.
function parseBacklog(state) {
  const section = (/^## Autonomous Build Backlog[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(state) || [])[1] || '';
  const items = [];
  for (const line of section.split('\n')) {
    const m = /^\s*- \[([ xX])\] (\*\([^)]*\)\* )?\*\*(\d+)\.\s*([^*]*)/.exec(line);
    if (m) items.push({ n: Number(m[3]), checked: m[1] !== ' ', eric: !!m[2] && /Eric/i.test(m[2]), text: m[4].trim() });
  }
  return items;
}

// The newest waiting branch (committer date), but never one that another
// waiting branch is stacked on (same-second commits tie on the date); else main.
function baseOf(cwd, branches) {
  const isAncestor = (a, b) => git(cwd, ['merge-base', '--is-ancestor', a, b], { allowFail: true }).status === 0;
  const ref = (b) => `origin/${b.branch}`;
  const tips = branches.filter((c) => !branches.some((o) => o !== c && isAncestor(ref(c), ref(o)) && !isAncestor(ref(o), ref(c))));
  return tips.length ? ref(tips[0]) : 'origin/main';
}

function status(cwd = ROOT, { now = new Date() } = {}) {
  const mergedSet = new Set(git(cwd, ['branch', '-r', '--merged', 'origin/main', '--list', 'origin/claude/backlog-*']).out.split('\n').map((s) => s.trim()).filter(Boolean));
  const all = git(cwd, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/remotes/origin/claude/backlog-*']).out.split('\n').map((s) => s.trim()).filter(Boolean);
  const branches = all.filter((b) => !mergedSet.has(b)).map((ref) => ({
    branch: ref.replace(/^origin\//, ''),
    items: [...new Set(trailers(git(cwd, ['log', `origin/main..${ref}`, '--format=%B']).out))].sort((a, b) => a - b),
  }));
  const waitingItems = [...new Set(branches.flatMap((b) => b.items))].sort((a, b) => a - b);
  const onMain = new Set(trailers(git(cwd, ['log', 'origin/main', '--format=%B']).out));
  const stateRead = git(cwd, ['show', `origin/main:${STATE_FILE}`]).out;
  const backlog = parseBacklog(stateRead);

  const lim = limitsAt(now);
  const headroom = Math.max(0, Math.min(lim.batch, lim.cap - waitingItems.length));
  const taken = (it) => it.checked || onMain.has(it.n) || waitingItems.includes(it.n);
  const buildable = backlog.filter((it) => !it.eric && !taken(it));
  return {
    at: now.toISOString(),
    cap: lim.cap,
    batch: lim.batch,
    surge: lim.surge,
    surge_ends: SURGE_ENDS,
    waiting: waitingItems.map((n) => ({ item: n, branches: branches.filter((b) => b.items.includes(n)).map((b) => b.branch) })),
    waiting_count: waitingItems.length,
    at_cap: waitingItems.length >= lim.cap,
    headroom,
    next: buildable.slice(0, headroom).map((it) => ({ item: it.n, text: it.text })),
    buildable_after: buildable.slice(headroom, headroom + 3).map((it) => it.n),
    base: baseOf(cwd, branches),
  };
}

function words(s) {
  const lines = [
    `Cap ${s.cap}, batch ${s.batch}${s.surge ? ` (surge until ${s.surge_ends})` : ''}.`,
    s.waiting_count ? `Waiting for merge: ${s.waiting_count} (${s.waiting.map((w) => `${w.item}`).join(', ')}).` : 'Nothing waiting for merge.',
    s.at_cap ? `WIP cap: ${s.waiting_count} items waiting for merge. Build nothing.` : `Headroom: ${s.headroom}.`,
  ];
  if (!s.at_cap) lines.push(s.next.length ? `Next: ${s.next.map((x) => `${x.item}`).join(', ')}.` : 'Backlog empty or all items waiting for merge.');
  lines.push(`Base: ${s.base}.`);
  return lines.join('\n');
}

if (require.main === module) {
  try {
    const s = status();
    process.stdout.write(process.argv.includes('--json') ? `${JSON.stringify(s, null, 2)}\n` : `${words(s)}\n`);
  } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1); }
}

module.exports = { status, words, parseBacklog, limitsAt, SURGE_ENDS };
