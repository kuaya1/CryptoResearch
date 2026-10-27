#!/usr/bin/env node
'use strict';
// Backlog status (backlog item 42): what the scheduled build routine decides
// in its first step, computed instead of read from an instruction.
//
//   node dashboard/scripts/backlog-status.js [--json]
//
// Reads git (after `git fetch origin --prune`, which the caller runs),
// DESK_STATE.md on origin/main and the issue queue on origin/agent-ledger
// (backlog-queue.js) only; writes nothing. It gives the waiting items
// (Backlog-Item trailers on origin/claude/backlog-* branches not merged into
// origin/main, each counted once), the cap and batch size in force, the
// headroom (how many items may start now: the cap less what waits, at most one
// batch), the next buildable items and the base to build on. The builders'
// claims, the hourly budget and the order of independent work are
// backlog-schedule.js's, which reads what this file gathers.

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const STATE_FILE = 'DESK_STATE.md';
// The builders' capacity by time, `cr-backlog-capacity@1`: each window holds
// until its `until` (UTC), the last one with no end. `per_run` is the batch one
// builder run takes, `per_hour` the items all builders together may start in
// any 60 minutes, `cap` the items waiting for merge or in flight.
//   - surge (Eric, 2026-10-25): builder a, five a run, a cap of 15, until
//     2026-10-28 23:00 New York; item 42 was written with 9/3, then 4/2.
//   - burst (Eric, 2026-10-27): up to ten items an hour across all builders
//     until 2026-10-27 23:00 New York, then the surge's limits again. Builders
//     a (:55) and b (:25), five a run each, a cap of 20.
//   - standard: three a run, a cap of 6.
const CAPACITY = [
  { name: 'surge', until: '2026-10-27T03:00:00Z', builders: ['a'], per_run: 5, per_hour: 5, cap: 15 },
  { name: 'burst', until: '2026-10-28T03:00:00Z', builders: ['a', 'b'], per_run: 5, per_hour: 10, cap: 20 },
  { name: 'surge', until: '2026-10-29T03:00:00Z', builders: ['a'], per_run: 5, per_hour: 5, cap: 15 },
  { name: 'standard', until: null, builders: ['a'], per_run: 3, per_hour: 3, cap: 6 },
];
const SURGE_ENDS = '2026-10-29T03:00:00Z'; // the last raised window ends: 2026-10-28 23:00 New York time
// An item the engineering inbox admitted (Connected Engineering v1): built
// alone, only through the engineering lane, never in a batch.
const ENGINEERING_RE = /\*\(engineering task (eng-\d{8}-[0-9a-f]{6}) v(\d+), sha256 ([0-9a-f]{16})/;

function git(cwd, args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim().slice(0, 400)}`);
  return { status: r.status, out: (r.stdout || '').trim() };
}

function limitsAt(now) {
  const w = CAPACITY.find((x) => x.until === null || now.getTime() < Date.parse(x.until));
  return { cap: w.cap, batch: w.per_run, per_hour: w.per_hour, builders: w.builders, window: w.name, window_ends: w.until, surge: w.name !== 'standard' };
}
const trailers = (body) => [...body.matchAll(/^Backlog-Item:\s*(\d+)\s*$/gm)].map((m) => Number(m[1]));

// An item's `- **Schedule:** after 67, 68; touches dashboard/core/tickets.js, web`
// sub-bullet: what must be built before it, and the files or folders (ending
// in /) it changes, so two builders never change the same one at once. `web`
// is the app's source and its committed bundle. An item with no such line is
// read as touching everything, so it is never built beside other work.
const WEB = ['dashboard/web/', 'dashboard/public/app/'];
function scheduleOf(text) {
  const after = [];
  const touches = new Set();
  for (const part of String(text).split(';')) {
    const m = /^\s*(after|touches)\s+(.*)$/i.exec(part.trim());
    if (!m) continue;
    for (const raw of m[2].split(',')) {
      const v = raw.replace(/[`*]/g, '').trim().replace(/\.$/, '');
      if (!v || /^none$/i.test(v)) continue;
      if (m[1].toLowerCase() === 'after') { if (/^\d+$/.test(v)) after.push(Number(v)); continue; }
      const key = v.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
      if (key === 'web' || WEB.some((w) => key.startsWith(w))) WEB.forEach((w) => touches.add(w));
      if (key !== 'web') touches.add(key);
    }
  }
  return { after: [...new Set(after)], touches: [...touches] };
}

// The backlog's checkbox lines: { n, checked, eric, text, engineering, schedule }.
function parseBacklog(state) {
  const section = (/^## Autonomous Build Backlog[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(state) || [])[1] || '';
  const items = [];
  let current = null;
  for (const line of section.split('\n')) {
    const m = /^\s*- \[([ xX])\] (\*\([^)]*\)\* )?\*\*(\d+)\.\s*([^*]*)/.exec(line);
    if (!m) {
      const sch = /^\s+- \*\*Schedule:\*\*\s*(.*)$/.exec(line);
      if (current && sch && !current.schedule) current.schedule = scheduleOf(sch[1]);
      else if (/^\S/.test(line)) current = null; // a paragraph or another list ends the item
      continue;
    }
    const eng = ENGINEERING_RE.exec(line);
    current = { n: Number(m[3]), checked: m[1] !== ' ', eric: !!m[2] && /Eric/i.test(m[2]), text: m[4].trim(), engineering: eng ? { task_id: eng[1], version: Number(eng[2]), sha256_prefix: eng[3] } : null, schedule: null };
    items.push(current);
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

// Main's backlog followed by the issue queue's authorized items
// (backlog-queue.js, from the agent ledger's local ref as the fetch left it):
// { backlog, queue_problems }. A queue item whose number main also holds is
// left out and said; an unreadable ledger leaves the whole queue out, said,
// and main's backlog stands.
function withQueue(cwd, backlog) {
  const q = require('./backlog-queue').readLocal(cwd);
  if (q.error) return { backlog, queue_problems: [`the issue queue was not read: ${q.error}`] };
  const onMain = new Set(backlog.map((it) => it.n));
  const problems = [...q.problems];
  const twice = new Set(q.items.map((it) => it.item).filter((n, i, all) => all.indexOf(n) !== i));
  const items = [];
  for (const it of q.items) {
    if (it.state !== 'authorized' || twice.has(it.item)) continue;
    if (onMain.has(it.item)) { problems.push(`item ${it.item} is both on main's backlog and in the issue queue (issue #${it.issue}); neither is read as the other`); continue; }
    const touches = it.schedule.touches.includes('*') ? ['*'] : scheduleOf(`touches ${it.schedule.touches.join(', ')}`).touches;
    items.push({ n: it.item, checked: false, eric: false, text: it.title, engineering: null, schedule: { after: it.schedule.after, touches }, issue: it.issue });
  }
  return { backlog: [...backlog, ...items], queue_problems: problems };
}

// What git says now: the waiting branches and their items, the items merged
// on main, main's backlog with the issue queue's items, and the base a batch
// builds on (with the items already on it).
function gather(cwd = ROOT) {
  // Engineering candidates waiting for review are work in progress too.
  const mergedSet = new Set(git(cwd, ['branch', '-r', '--merged', 'origin/main', '--list', 'origin/claude/backlog-*', 'origin/claude/candidate-eng-*']).out.split('\n').map((s) => s.trim()).filter(Boolean));
  const all = git(cwd, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/remotes/origin/claude/backlog-*', 'refs/remotes/origin/claude/candidate-eng-*']).out.split('\n').map((s) => s.trim()).filter(Boolean);
  const branches = all.filter((b) => !mergedSet.has(b)).map((ref) => ({
    branch: ref.replace(/^origin\//, ''),
    items: [...new Set(trailers(git(cwd, ['log', `origin/main..${ref}`, '--format=%B']).out))].sort((a, b) => a - b),
  }));
  const waitingItems = [...new Set(branches.flatMap((b) => b.items))].sort((a, b) => a - b);
  const onMain = new Set(trailers(git(cwd, ['log', 'origin/main', '--format=%B']).out));
  const { backlog, queue_problems } = withQueue(cwd, parseBacklog(git(cwd, ['show', `origin/main:${STATE_FILE}`]).out));
  // An engineering branch is never a base: a batch never waits on its review.
  const base = baseOf(cwd, branches.filter((b) => /^claude\/backlog-(?!eng-)/.test(b.branch)));
  const baseItems = new Set(base === 'origin/main' ? [] : trailers(git(cwd, ['log', `origin/main..${base}`, '--format=%B']).out));
  return { branches, waitingItems, onMain, backlog, base, baseItems, queue_problems };
}

function status(cwd = ROOT, { now = new Date() } = {}) {
  const { branches, waitingItems, onMain, backlog, base, queue_problems } = gather(cwd);
  const lim = limitsAt(now);
  const headroom = Math.max(0, Math.min(lim.batch, lim.cap - waitingItems.length));
  const taken = (it) => it.checked || onMain.has(it.n) || waitingItems.includes(it.n);
  const buildable = backlog.filter((it) => !it.eric && !it.engineering && !taken(it));
  const engineering = backlog.filter((it) => it.engineering && !it.checked).map((it) => ({ item: it.n, task_id: it.engineering.task_id, version: it.engineering.version, taken: taken(it) }));
  return {
    at: now.toISOString(),
    cap: lim.cap,
    batch: lim.batch,
    per_hour: lim.per_hour,
    window: lim.window,
    window_ends: lim.window_ends,
    surge: lim.surge,
    surge_ends: SURGE_ENDS,
    waiting: waitingItems.map((n) => ({ item: n, branches: branches.filter((b) => b.items.includes(n)).map((b) => b.branch) })),
    waiting_count: waitingItems.length,
    at_cap: waitingItems.length >= lim.cap,
    headroom,
    next: buildable.slice(0, headroom).map((it) => ({ item: it.n, text: it.text, ...(it.issue ? { issue: it.issue } : {}) })),
    buildable_after: buildable.slice(headroom, headroom + 3).map((it) => it.n),
    base,
    engineering,
    queue_problems,
  };
}

function words(s) {
  const lines = [
    `Cap ${s.cap}, batch ${s.batch}, ${s.per_hour} an hour (${s.window}${s.window_ends ? ` until ${s.window_ends}` : ''}).`,
    s.waiting_count ? `Waiting for merge: ${s.waiting_count} (${s.waiting.map((w) => `${w.item}`).join(', ')}).` : 'Nothing waiting for merge.',
    s.at_cap ? `WIP cap: ${s.waiting_count} items waiting for merge. Build nothing.` : `Headroom: ${s.headroom}.`,
  ];
  if (!s.at_cap) lines.push(s.next.length ? `Next: ${s.next.map((x) => `${x.item}${x.issue ? ` (issue #${x.issue})` : ''}`).join(', ')}.` : 'Backlog empty or all items waiting for merge.');
  lines.push(`Base: ${s.base}.`);
  for (const p of s.queue_problems || []) lines.push(`Queue: ${p}.`);
  return lines.join('\n');
}

if (require.main === module) {
  try {
    const s = status();
    process.stdout.write(process.argv.includes('--json') ? `${JSON.stringify(s, null, 2)}\n` : `${words(s)}\n`);
  } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1); }
}

module.exports = { status, gather, withQueue, words, parseBacklog, scheduleOf, limitsAt, git, trailers, CAPACITY, SURGE_ENDS, ENGINEERING_RE, WEB };
