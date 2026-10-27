#!/usr/bin/env node
'use strict';
// The backlog builders' scheduler, `cr-backlog-schedule@1` (Eric, 2026-10-27:
// "up to 10 eligible backlog items per hour across all builders combined",
// until 2026-10-27 23:00 New York, then the limits before it).
//
// Deprecated (Eric, 2026-10-27; audits/2026-10-27-pm-builder): the agent
// lane's PM (agent-pm.js, agent-builder-lane.yml) is the only builder on a
// schedule. This scheduler stays for the record and for a run by hand; the
// cloud routines that called it hourly are paused, and no workflow runs it on
// a schedule (tests/agent-workflows.test.js).
//
//   node dashboard/scripts/backlog-schedule.js plan      --builder a [--json]
//   node dashboard/scripts/backlog-schedule.js claim     --builder a --run <id> [--json]
//   node dashboard/scripts/backlog-schedule.js heartbeat --run <id>
//   node dashboard/scripts/backlog-schedule.js done      --run <id> --item <n> --branch <name>
//   node dashboard/scripts/backlog-schedule.js fail      --run <id> --item <n> --reason "<words>"
//   node dashboard/scripts/backlog-schedule.js release   --run <id> --item <n>
//   node dashboard/scripts/backlog-schedule.js claims    [--json]
//
// A claim is a branch `claude/claims/item-<n>` whose tip is a commit with an
// empty tree and a JSON message (`cr.backlog-claim.v1`). Git's own
// compare-and-swap makes it atomic: a claim is created only where none exists
// and replaced only from the commit the builder read (`--force-with-lease`),
// so two builders never hold one item. Each new record is a child of the one
// it replaces, so the attempts stay on GitHub across runs and restarts.
//
// `plan` reads and writes nothing but the local git cache; `claim` fetches
// and plans again on every try. What a run may take is the smallest of: its
// window's batch, the items all builders may still start this hour (claims
// made in the last 60 minutes and engineering candidates pushed in it count),
// and the cap less what waits for merge or is in flight. Items are taken in
// backlog order, skipping one that waits for an unbuilt or in-flight item
// (`after`), or that changes a file or folder an in-flight item, or a waiting
// item not on the base, changes (`touches`).
//
// A run that dies holds its items only until its lease ends (90 minutes from
// the claim or the last heartbeat); the next plan reclaims them as a lost
// attempt. A failed item waits 30 minutes before another try. Two failures,
// three lost runs, or a branch that is gone without its commit, block the
// item for Eric.

const path = require('path');
const { spawnSync } = require('child_process');
const S = require('./backlog-status');

const ROOT = path.join(__dirname, '..', '..');
const SCHEMA = 'cr.backlog-claim.v1';
const PLAN_SCHEMA = 'cr.backlog-schedule.v1';
const CLAIM_PREFIX = 'claude/claims/item-';
const LEASE_MS = 90 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MAX_FAILURES = 2;
const MAX_LOST = 3;
const CLAIM_TRIES = 3;
const IDENTITY = { GIT_AUTHOR_NAME: 'backlog-scheduler', GIT_AUTHOR_EMAIL: 'backlog-scheduler@users.noreply.github.com', GIT_COMMITTER_NAME: 'backlog-scheduler', GIT_COMMITTER_EMAIL: 'backlog-scheduler@users.noreply.github.com' };

function git(cwd, args, { allowFail = false, input } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY }, input, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim().slice(0, 400)}`);
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

const iso = (ms) => new Date(ms).toISOString();
const refOf = (n) => `refs/heads/${CLAIM_PREFIX}${n}`;

// Every claim on the remote, as the last fetch saw it: item -> { sha, record }.
// A tip that does not read as a claim is kept as unreadable and blocks its item.
function readClaims(cwd) {
  const out = git(cwd, ['for-each-ref', '--format=%(objectname) %(refname)', `refs/remotes/origin/${CLAIM_PREFIX}*`]).out;
  const claims = new Map();
  for (const line of out.split('\n').filter(Boolean)) {
    const [sha, ref] = line.split(' ');
    const n = Number(ref.slice(`refs/remotes/origin/${CLAIM_PREFIX}`.length));
    if (!Number.isInteger(n)) continue;
    let record = null;
    try {
      const r = JSON.parse(git(cwd, ['log', '-1', '--format=%B', sha]).out);
      if (r && r.schema === SCHEMA && r.item === n) record = r;
    } catch { record = null; }
    claims.set(n, { sha, record });
  }
  return claims;
}

// Where one item's claim stands at `now`.
//   free       no claim, or released: anyone may claim it
//   active     building under a lease that has not ended
//   lost       building, the lease ended with no word: reclaimable, a lost try
//   retry      failed, its retry time not reached
//   reclaim    failed, its retry time passed
//   built      its branch was pushed (its commit makes it taken)
//   blocked    failed twice, lost three times, unreadable, or built and gone
function claimState(claim, now, taken) {
  if (!claim) return { state: 'free' };
  const r = claim.record;
  if (!r) return { state: 'blocked', why: 'its claim does not read as a claim' };
  const failures = r.failures || 0;
  const lost = r.lost || 0;
  if (r.state === 'blocked') return { state: 'blocked', why: r.reason || 'blocked' };
  if (r.state === 'released') return { state: 'free', reclaim: true };
  if (r.state === 'built') return taken ? { state: 'built' } : { state: 'blocked', why: `built on ${r.branch || 'a branch'} but no commit for it is on any branch now: Eric decides` };
  if (r.state === 'failed') {
    if (failures >= MAX_FAILURES) return { state: 'blocked', why: `failed ${failures} times (last: ${r.reason || 'no reason given'})` };
    return now < Date.parse(r.retry_after) ? { state: 'retry', why: `failed once, retry after ${r.retry_after}` } : { state: 'reclaim', reclaim: true };
  }
  if (r.state === 'building') {
    if (now < Date.parse(r.lease_until)) return { state: 'active' };
    if (lost + 1 >= MAX_LOST) return { state: 'blocked', why: `its run was lost ${lost + 1} times (lease ended ${r.lease_until})` };
    return { state: 'lost', reclaim: true, lostNow: true };
  }
  return { state: 'blocked', why: `unknown claim state ${r.state}` };
}

const overlaps = (a, b) => a === b || (a.endsWith('/') && b.startsWith(a)) || (b.endsWith('/') && a.startsWith(b));
const ALL = ['*'];
const touchesOf = (it) => (it && it.schedule ? it.schedule.touches : ALL);
const conflicts = (x, y) => x.includes('*') || y.includes('*') || x.some((a) => y.some((b) => overlaps(a, b)));

// The decision, from what git says (pure; every input is data).
//   input: { now (ms), builder, limits, backlog, onMain (Set), waiting (Map
//            item -> branches), baseItems (Set), base, claims (Map), otherLane }
function plan(input) {
  const { now, builder, limits, backlog, onMain, waiting, baseItems, base, claims, otherLane = 0 } = input;
  const byN = new Map(backlog.map((it) => [it.n, it]));
  const merged = (n) => onMain.has(n) || (byN.get(n) && byN.get(n).checked);
  const taken = (n) => merged(n) || waiting.has(n);
  const states = new Map();
  for (const it of backlog) states.set(it.n, claimState(claims.get(it.n), now, taken(it.n)));
  // A claim for an item no longer on the backlog still counts toward the hour.
  const inFlight = [...claims.keys()].filter((n) => !taken(n) && (states.get(n) || claimState(claims.get(n), now, false)).state === 'active');
  const started = [...claims.values()].filter((c) => c.record && ['building', 'built', 'failed', 'blocked'].includes(c.record.state) && now - Date.parse(c.record.claimed_at) < HOUR_MS).length + otherLane;
  const allowed = limits.builders.includes(builder);
  const budget = Math.max(0, limits.per_hour - started);
  const wip = waiting.size + inFlight.length;
  const room = Math.max(0, limits.cap - wip);
  const runMax = allowed ? Math.min(limits.batch, budget, room) : 0;

  const picks = [];
  const skipped = [];
  const blocked = [];
  const later = [];
  const pickedSet = new Set();
  // An engineering candidate is reviewed and merged on its own; Eric settles
  // any overlap with a batch at merge, so it holds no file here.
  const engineering = (n) => !!(byN.get(n) && byN.get(n).engineering);
  for (const it of backlog) {
    if (it.checked || it.eric || it.engineering || taken(it.n)) continue;
    const st = states.get(it.n);
    if (st.state === 'blocked') { blocked.push({ item: it.n, why: st.why }); continue; }
    if (st.state === 'active') continue; // listed under in_flight
    if (st.state === 'retry') { skipped.push({ item: it.n, why: st.why }); continue; }
    if (picks.length >= runMax) { later.push(it.n); continue; }
    const after = it.schedule ? it.schedule.after : [];
    const waitsFor = after.find((d) => !(merged(d) || (waiting.has(d) && baseItems.has(d)) || pickedSet.has(d)));
    if (waitsFor !== undefined) {
      const why = inFlight.includes(waitsFor) ? `waits for item ${waitsFor}, in flight`
        : waiting.has(waitsFor) ? `waits for item ${waitsFor}, waiting on ${(waiting.get(waitsFor) || []).join(', ')}, not on the base`
          : `waits for item ${waitsFor}, not built yet`;
      skipped.push({ item: it.n, why });
      continue;
    }
    const mine = touchesOf(it);
    const clash = inFlight.find((n) => conflicts(mine, touchesOf(byN.get(n))))
      ?? [...waiting.keys()].find((n) => !baseItems.has(n) && !engineering(n) && conflicts(mine, touchesOf(byN.get(n))));
    if (clash !== undefined) {
      skipped.push({ item: it.n, why: inFlight.includes(clash) ? `changes what item ${clash} changes, in flight` : `changes what item ${clash} changes, waiting on another branch` });
      continue;
    }
    const c = claims.get(it.n);
    picks.push({ item: it.n, text: it.text, old: st.state === 'free' && !st.reclaim ? null : c.sha, record: c && c.record, lostNow: !!st.lostNow });
    pickedSet.add(it.n);
  }
  const why = !allowed ? `builder ${builder} does not run in the ${limits.window} window`
    : room === 0 ? `cap: ${wip} waiting for merge or in flight (cap ${limits.cap})`
      : budget === 0 ? `hour budget used: ${started} started in the last 60 minutes (limit ${limits.per_hour})`
        : picks.length ? null : 'nothing buildable now';
  return {
    schema: PLAN_SCHEMA,
    at: iso(now),
    builder,
    window: limits.window,
    window_ends: limits.window_ends,
    per_run: limits.batch,
    per_hour: limits.per_hour,
    cap: limits.cap,
    builders: limits.builders,
    started_last_hour: started,
    waiting_count: waiting.size,
    in_flight: inFlight.sort((a, b) => a - b),
    run_max: runMax,
    base,
    picks: picks.map((p) => ({ item: p.item, text: p.text })),
    branch: branchName(picks.map((p) => p.item)),
    skipped,
    blocked,
    later: later.slice(0, 10),
    why,
    _picks: picks,
  };
}

function branchName(items) {
  if (!items.length) return null;
  if (items.length === 1) return `claude/backlog-item-${items[0]}`;
  if (items.length === 2) return `claude/backlog-batch-items-${items[0]}-and-${items[1]}`;
  return `claude/backlog-batch-items-${items.join('-')}`;
}

function fetch(cwd) { git(cwd, ['fetch', '-q', 'origin', '--prune']); }

// Engineering candidates pushed in the last hour are builds too.
function otherLaneLastHour(cwd, now) {
  const out = git(cwd, ['for-each-ref', '--format=%(committerdate:unix) %(refname:short)', 'refs/remotes/origin/claude/candidate-eng-*']).out;
  return out.split('\n').filter(Boolean).filter((l) => now - Number(l.split(' ')[0]) * 1000 < HOUR_MS).length;
}

function inputs(cwd, { now, builder }) {
  const g = S.gather(cwd);
  const waiting = new Map();
  for (const b of g.branches) for (const n of b.items) waiting.set(n, [...(waiting.get(n) || []), b.branch]);
  return { now, builder, limits: S.limitsAt(new Date(now)), backlog: g.backlog, onMain: g.onMain, waiting, baseItems: g.baseItems, base: g.base, claims: readClaims(cwd), otherLane: otherLaneLastHour(cwd, now) };
}

function commitRecord(cwd, record, parent) {
  const tree = git(cwd, ['mktree'], { input: '' }).out;
  const args = ['commit-tree', tree, '-m', JSON.stringify(record)];
  if (parent) args.push('-p', parent);
  return git(cwd, args).out;
}

// Push claim updates: [{ item, sha (new), old (expected remote sha or null) }].
// Atomic when the remote allows it; otherwise one at a time, undoing the ones
// that landed when a later one is refused. Returns { ok, refused }.
function pushClaims(cwd, updates) {
  const leases = updates.map((u) => `--force-with-lease=${refOf(u.item)}:${u.old || ''}`);
  const specs = updates.map((u) => `${u.sha}:${refOf(u.item)}`);
  const r = git(cwd, ['push', '--atomic', '--porcelain', ...leases, 'origin', ...specs], { allowFail: true });
  if (r.status === 0) return { ok: true };
  if (!/atomic/i.test(r.err + r.out) || /rejected|stale|fetch first/i.test(r.out)) return { ok: false, refused: (r.out + '\n' + r.err).trim().slice(0, 400) };
  const landed = [];
  for (const u of updates) {
    const one = git(cwd, ['push', '--porcelain', `--force-with-lease=${refOf(u.item)}:${u.old || ''}`, 'origin', `${u.sha}:${refOf(u.item)}`], { allowFail: true });
    if (one.status === 0) { landed.push(u); continue; }
    for (const l of landed) git(cwd, ['push', '--porcelain', `--force-with-lease=${refOf(l.item)}:${l.sha}`, 'origin', l.old ? `${l.old}:${refOf(l.item)}` : `:${refOf(l.item)}`], { allowFail: true });
    return { ok: false, refused: (one.out + '\n' + one.err).trim().slice(0, 400) };
  }
  return { ok: true };
}

function claim(cwd = ROOT, { builder, run, now = Date.now(), tries = CLAIM_TRIES } = {}) {
  if (!builder || !run) throw new Error('claim needs --builder and --run');
  let last = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    fetch(cwd);
    const p = plan(inputs(cwd, { now, builder }));
    if (!p._picks.length) { delete p._picks; return { ...p, claimed: [] }; }
    const updates = p._picks.map((pick) => {
      const prev = pick.record || {};
      const record = {
        schema: SCHEMA, item: pick.item, builder, run, state: 'building', window: p.window,
        claimed_at: iso(now), lease_until: iso(now + LEASE_MS), base: p.base, branch: p.branch,
        failures: prev.failures || 0, lost: (prev.lost || 0) + (pick.lostNow ? 1 : 0),
        previous: pick.record ? { run: prev.run, state: prev.state, reason: prev.reason || null } : null,
      };
      return { item: pick.item, sha: commitRecord(cwd, record, pick.old), old: pick.old };
    });
    const r = pushClaims(cwd, updates);
    if (r.ok) { fetch(cwd); delete p._picks; return { ...p, claimed: p.picks.map((x) => x.item) }; }
    last = r.refused;
  }
  return { schema: PLAN_SCHEMA, builder, claimed: [], why: `another builder claimed first ${tries} times; nothing claimed`, refused: last };
}

// Change one claim this run holds. A claim another run took over is refused.
function update(cwd, { run, item, now = Date.now(), change }) {
  if (!run || !Number.isInteger(item)) throw new Error('needs --run and --item');
  for (let attempt = 1; attempt <= 2; attempt++) {
    fetch(cwd);
    const c = readClaims(cwd).get(item);
    if (!c || !c.record) throw new Error(`item ${item} has no claim`);
    if (c.record.run !== run) throw new Error(`item ${item} is claimed by run ${c.record.run}, not ${run}`);
    const record = { ...c.record, ...change(c.record), updated_at: iso(now) };
    const sha = commitRecord(cwd, record, c.sha);
    const r = pushClaims(cwd, [{ item, sha, old: c.sha }]);
    if (r.ok) { fetch(cwd); return record; }
  }
  throw new Error(`item ${item}: the claim changed while it was being updated`);
}

// Extends this run's leases and says which items it still holds; an item
// missing from `held` was taken over after its lease ended.
const heartbeat = (cwd, { run, now = Date.now() }) => {
  fetch(cwd);
  const mine = [...readClaims(cwd).entries()].filter(([, c]) => c.record && c.record.run === run && c.record.state === 'building').map(([n]) => n);
  for (const item of mine) update(cwd, { run, item, now, change: () => ({ lease_until: iso(now + LEASE_MS) }) });
  return { run, held: mine.sort((a, b) => a - b), lease_until: iso(now + LEASE_MS) };
};
const done = (cwd, { run, item, branch, now = Date.now() }) => update(cwd, { run, item, now, change: () => ({ state: 'built', branch: branch || null }) });
const release = (cwd, { run, item, now = Date.now() }) => update(cwd, { run, item, now, change: () => ({ state: 'released' }) });
const fail = (cwd, { run, item, reason, now = Date.now() }) => update(cwd, {
  run, item, now,
  change: (r) => {
    const failures = (r.failures || 0) + 1;
    return failures >= MAX_FAILURES
      ? { state: 'blocked', failures, reason: `failed ${failures} times (last: ${reason || 'no reason given'})` }
      : { state: 'failed', failures, reason: reason || 'no reason given', retry_after: iso(now + RETRY_MS) };
  },
});

function words(p) {
  const lines = [`${p.window} window${p.window_ends ? ` until ${p.window_ends}` : ''}: ${p.per_run} a run, ${p.per_hour} an hour across builders ${p.builders.join(', ')}, cap ${p.cap}.`,
    `Started in the last hour: ${p.started_last_hour}. Waiting for merge: ${p.waiting_count}. In flight: ${p.in_flight.length ? p.in_flight.join(', ') : 'none'}.`];
  if (p.claimed) lines.push(p.claimed.length ? `Claimed for builder ${p.builder}: ${p.claimed.join(', ')} on ${p.branch}, base ${p.base}.` : `Nothing claimed: ${p.why}.`);
  else lines.push(p.picks.length ? `Builder ${p.builder} would take: ${p.picks.map((x) => x.item).join(', ')} on ${p.branch}, base ${p.base}.` : `Nothing to take: ${p.why}.`);
  for (const s of p.skipped || []) lines.push(`Skipped ${s.item}: ${s.why}.`);
  for (const b of p.blocked || []) lines.push(`Blocked ${b.item}: ${b.why}.`);
  if (p.later && p.later.length) lines.push(`Next after this run: ${p.later.join(', ')}.`);
  return lines.join('\n');
}

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2);
    if (k === 'json') { o.json = true; continue; }
    o[k] = argv[++i];
  }
  return o;
}

function main(argv = process.argv.slice(2), cwd = ROOT) {
  const o = args(argv);
  const cmd = o._[0];
  const now = Date.now();
  const item = o.item !== undefined ? Number(o.item) : undefined;
  let out;
  if (cmd === 'plan') { fetch(cwd); out = plan(inputs(cwd, { now, builder: o.builder || 'a' })); delete out._picks; }
  else if (cmd === 'claim') out = claim(cwd, { builder: o.builder, run: o.run, now });
  else if (cmd === 'heartbeat') out = heartbeat(cwd, { run: o.run, now });
  else if (cmd === 'done') out = done(cwd, { run: o.run, item, branch: o.branch, now });
  else if (cmd === 'fail') out = fail(cwd, { run: o.run, item, reason: o.reason, now });
  else if (cmd === 'release') out = release(cwd, { run: o.run, item, now });
  else if (cmd === 'claims') { fetch(cwd); out = Object.fromEntries([...readClaims(cwd)].map(([n, c]) => [n, c.record])); }
  else throw new Error('usage: backlog-schedule.js plan|claim|heartbeat|done|fail|release|claims [--builder a|b] [--run <id>] [--item <n>] [--json]');
  const text = o.json || !['plan', 'claim'].includes(cmd) ? JSON.stringify(out, null, 2) : words(out);
  process.stdout.write(`${text}\n`);
}

if (require.main === module) {
  try { main(); } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1); }
}

module.exports = { plan, claim, heartbeat, done, fail, release, readClaims, claimState, inputs, branchName, pushClaims, words, main, SCHEMA, PLAN_SCHEMA, CLAIM_PREFIX, LEASE_MS, RETRY_MS, MAX_FAILURES, MAX_LOST };
