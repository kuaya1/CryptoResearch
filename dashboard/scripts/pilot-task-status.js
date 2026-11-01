'use strict';
// What the pilot-all task's last scheduled start did, read only (bounded
// paper readiness A4, cr-pilot-task-status@1). `pilot-task.ps1 -Status`
// gathers Task Scheduler's facts about its own task (state, last start, last
// result, time limit, launcher kind, a running instance's process and its
// children; never the action's arguments) and pipes them here as JSON; this
// reads the runner's log (%USERPROFILE%\.cryptoresearch\pilot-all.jsonl) and
// lock (os.tmpdir()\cr-pilot\pilot-all.lock) at the paths pilot.js itself
// uses, and says one of:
//   not_registered, never_run, running, completed, failed, interrupted,
//   unknown (always with the reason).
// It writes nothing, starts nothing, takes over no lock and releases no claim.
// It prints no log text and no arguments: times, exit codes, counts.
//
// Correlation: the runner logs one line when it finishes, its started_at the
// moment it began. A scheduled start's own line is the one that began within
// GRACE_MS after Task Scheduler's last start (SKEW_MS before it for clock
// granularity). Measured under Task Scheduler on 2026-11-01 (27 + the
// launcher's own runs, docs/engineering/BOUNDED_PAPER_READINESS.md): start to
// the child's first line took at most about 1 s; 120 s covers a loaded PC,
// the launcher's job helper compiling and a virus scan, and stays far inside
// the 30-minute interval, so two starts' windows never overlap. A line from
// any other start (a manual run, a later skipped one) never stands for it.
//
// A start refused while a run is going (IgnoreNew; a run longer than the
// 30-minute interval) moves Task Scheduler's last start to the refused
// trigger's time and starts nothing (measured the same day: LastRunTime took
// the refused start's time, 6 s after the real one, and kept it after the run
// ended with its own exit code). So while a run is going, its own start is
// the running instance's process start time (engine_started_at), and the
// lock is matched to that; after it ends, a line that began before the last
// start and finished after it, with the same exit code Task Scheduler
// recorded, is the run that start was refused for.

const fs = require('fs');
const P = require('./pilot');

const VERSION = 'cr-pilot-task-status@1';
const FACTS_FORMAT = 'cr-pilot-task-facts@1';
const GRACE_MS = 120000;
const SKEW_MS = 5000;
const TAIL_BYTES = 512 * 1024;
// Task Scheduler's own results (winerror.h, SCHED_S_* / SCHED_E_*).
const SCHED = Object.freeze({
  0x41300: 'ready', 0x41301: 'running', 0x41302: 'disabled', 0x41303: 'has not run', 0x41306: 'terminated (its time limit or a Stop)',
  0x800710e0: 'a start refused (another instance was running: IgnoreNew)', 0x8004131f: 'an instance was already running',
});
// The launcher's own codes (pilot-task-run.ps1).
const LAUNCHER = Object.freeze({
  90: 'the launcher could not start node (the binary or pilot.js is missing)',
  91: 'the launcher got no exit code from node',
  92: 'the launcher was started without node\'s path',
  93: 'the launcher\'s job helper did not load, so nothing was started',
  94: 'the launcher could not make its job, so nothing was started',
});

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const ms = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : NaN);
const isoOf = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : null);
const resultOf = (v) => (Number.isInteger(v) ? (v < 0 ? v + 0x100000000 : v) : null);
const hex = (v) => (v === null ? null : `0x${v.toString(16).toUpperCase()}`);

// ISO 8601 durations as Task Scheduler writes them (PT3H, PT15S, P1DT2H...).
function durationMs(s) {
  const m = typeof s === 'string' && /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(s);
  if (!m || s === 'P' || s === 'PT') return null;
  const [d, h, mi, se] = m.slice(1).map((x) => Number(x || 0));
  return (((d * 24 + h) * 60 + mi) * 60 + se) * 1000;
}

// The log's last TAIL_BYTES as lines: { status: absent | ok | unreadable,
// code, lines: [{ ok, rec }] } (a line cut by the tail is dropped).
function readLog(file = P.pilotLogPath()) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    const lines = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => {
      try { const rec = JSON.parse(l); return isObj(rec) && rec.format === 'cr-pilot-all@1' ? { ok: true, rec } : { ok: false }; } catch (_) { return { ok: false }; }
    });
    return { status: 'ok', code: null, lines };
  } catch (err) {
    return err && err.code === 'ENOENT' ? { status: 'absent', code: null, lines: [] } : { status: 'unreadable', code: (err && err.code) || 'error', lines: [] };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

// The runner's lock: { status: absent | ok | unreadable | malformed, pid, started_at }.
function readLock(file = P.lockPath()) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    return err && err.code === 'ENOENT' ? { status: 'absent' } : { status: 'unreadable', code: (err && err.code) || 'error' };
  }
  let rec = null;
  try { rec = JSON.parse(text); } catch (_) { rec = null; }
  if (!isObj(rec) || !Number.isSafeInteger(rec.pid) || rec.pid <= 0 || !Number.isFinite(ms(rec.started_at))) return { status: 'malformed' };
  return { status: 'ok', pid: rec.pid, started_at: rec.started_at };
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return Boolean(err && err.code === 'EPERM'); }
}

// facts: what pilot-task.ps1 read from Task Scheduler. log, lock: readLog(),
// readLock(). alive(pid): whether a process with that ID exists. Pure.
function classify(facts, { now = Date.now(), log = { status: 'absent', lines: [] }, lock = { status: 'absent' }, alive = () => false } = {}) {
  const out = { format: VERSION, state: 'unknown', reason: null, gap: false, grace_seconds: GRACE_MS / 1000, task: null, runner: null, lock: null };
  const unknown = (reason, extra = {}) => Object.assign(out, { state: 'unknown', reason }, extra);
  if (!isObj(facts) || facts.format !== FACTS_FORMAT) return unknown('Task Scheduler\'s facts about the task did not read.');
  if (facts.registered !== true) return Object.assign(out, { state: 'not_registered', reason: 'The pilot-all task is not registered.' });
  const lastRaw = ms(facts.last_run_time);
  // Task Scheduler reports 1999-11-30 for a task never run.
  const lastRun = Number.isFinite(lastRaw) && new Date(lastRaw).getUTCFullYear() >= 2000 ? lastRaw : null;
  const result = resultOf(facts.last_task_result);
  const limit = durationMs(facts.time_limit);
  const running = Array.isArray(facts.running) ? facts.running.filter(isObj) : [];
  out.task = {
    state: typeof facts.state === 'string' ? facts.state : null,
    enabled: typeof facts.enabled === 'boolean' ? facts.enabled : null,
    launcher: ['job_wrapper', 'conhost'].includes(facts.launcher) ? facts.launcher : 'other',
    max_agents: Number.isInteger(facts.max_agents) ? facts.max_agents : null,
    last_start: isoOf(lastRun),
    last_result: result,
    last_result_hex: hex(result),
    last_result_means: result === null ? null : SCHED[result] || LAUNCHER[result] || (facts.launcher === 'job_wrapper' && result <= 255 ? `the runner's exit code ${result}` : null),
    next_start: isoOf(ms(facts.next_run_time)),
    time_limit: typeof facts.time_limit === 'string' ? facts.time_limit : null,
    deadline: lastRun !== null && limit ? isoOf(lastRun + limit) : null,
    running_instances: running.length,
  };
  if (facts.ours !== true) return unknown('A task of that name exists that pilot-task.ps1 did not register; it is not read.');
  if (facts.running_error) return unknown(`Task Scheduler's running instances could not be read (${String(facts.running_error).slice(0, 40)}).`);

  // Evidence after this clock: the clock went back, or it is not this PC's.
  const later = (t) => Number.isFinite(t) && t > now + SKEW_MS;
  if (lastRun !== null && later(lastRun)) return unknown(`Task Scheduler's last start (${isoOf(lastRun)}) is after this clock (${isoOf(now)}): the clock went back, so what ran is unknown.`);
  if (log.status === 'unreadable') return unknown(`The runner's log (pilot-all.jsonl) could not be read (${log.code}).`);
  const valid = log.lines.filter((l) => l.ok).map((l) => l.rec);
  const malformed = log.lines.length - valid.length;
  if (valid.some((r) => later(ms(r.started_at)) || later(ms(r.finished_at)))) return unknown(`A line in the runner's log is dated after this clock (${isoOf(now)}): the clock went back, so which line is this start's is unknown.`);
  if (lock.status === 'unreadable') return unknown(`The runner's lock could not be read (${lock.code}).`);
  if (lock.status === 'malformed') return unknown('The runner\'s lock does not read as a lock (pid and start time).');
  const lockAt = lock.status === 'ok' ? ms(lock.started_at) : NaN;
  if (later(lockAt)) return unknown(`The runner's lock is dated after this clock (${isoOf(now)}): the clock went back.`);
  const inWindow = (t) => lastRun !== null && Number.isFinite(t) && t >= lastRun - SKEW_MS && t <= lastRun + GRACE_MS;
  const lockAlive = lock.status === 'ok' ? alive(lock.pid) : false;
  out.lock = lock.status === 'ok'
    ? { held: true, pid: lock.pid, since: isoOf(lockAt), owner_alive: lockAlive, this_start: inWindow(lockAt) }
    : { held: false };
  const matches = valid.filter((r) => inWindow(ms(r.started_at)));
  const latest = valid.length ? valid.reduce((a, b) => (ms(b.started_at) > ms(a.started_at) ? b : a)) : null;
  const runnerOf = (r) => ({
    started_at: r.started_at || null,
    finished_at: r.finished_at || null,
    exit: Number.isInteger(r.exit) ? r.exit : null,
    skipped: r.skipped || null,
    paused: r.paused === true,
    dispatches: Array.isArray(r.dispatches) ? r.dispatches.length : 0,
    errors: Array.isArray(r.dispatches) ? r.dispatches.filter((d) => isObj(d) && d.outcome === 'error').length : 0,
    needs_eric: Array.isArray(r.needs_eric) ? r.needs_eric.length : 0,
  });
  if (matches.length > 1) return unknown(`${matches.length} runner lines began within ${GRACE_MS / 1000} s of this start (a manual run beside it?), so which is this start's is ambiguous.`);
  const line = matches[0] || null;
  if (line) out.runner = runnerOf(line);

  // Never started by Task Scheduler.
  if (lastRun === null && !running.length && facts.state !== 'Running') {
    const other = latest ? ` The runner's latest line (began ${latest.started_at}) is another start's, not this task's.` : '';
    return Object.assign(out, { state: 'never_run', reason: `Task Scheduler has not started it since it was registered${facts.enabled === false ? ' (it is disabled)' : ''}.${other}` });
  }
  if (lastRun === null) return unknown('Task Scheduler says it is running but gives no start time.');

  // Running now. Its own start is the running instance's process start; a
  // later last start is a trigger refused while it runs (IgnoreNew).
  if (running.length || facts.state === 'Running') {
    if (limit === null) return unknown('The task\'s time limit does not read, so whether this run is within it is unknown.');
    if (running.length > 1) return unknown(`Task Scheduler lists ${running.length} running instances of a task that allows one (IgnoreNew).`);
    const engineAt = running.length ? ms(running[0].engine_started_at) : NaN;
    if (Number.isFinite(engineAt) && engineAt > lastRun + GRACE_MS) return unknown(`The running instance began ${isoOf(engineAt)}, after Task Scheduler's last start (${isoOf(lastRun)}).`);
    const runStart = Number.isFinite(engineAt) ? engineAt : lastRun;
    const refused = runStart < lastRun - GRACE_MS;
    const ofRun = (t) => Number.isFinite(t) && t >= runStart - SKEW_MS && t <= runStart + GRACE_MS;
    const deadline = runStart + limit;
    out.task.deadline = isoOf(deadline);
    out.task.run_started = isoOf(runStart);
    if (out.lock.held) out.lock.this_start = ofRun(lockAt);
    const also = refused ? ` The last start Task Scheduler shows (${isoOf(lastRun)}) was a later trigger it refused while this run goes on (IgnoreNew).` : '';
    if (now > deadline + 60000) return Object.assign(out, { state: 'interrupted', reason: `Task Scheduler still shows it running ${Math.round((now - deadline) / 60000)} min past its time limit (${isoOf(deadline)}), when it should have been ended: stale.` });
    const minutes = Math.max(0, Math.round((deadline - now) / 60000));
    const children = running.flatMap((r) => (Array.isArray(r.children) ? r.children.filter(isObj).map((c) => c.pid) : []));
    if (lock.status === 'ok') {
      const owned = !children.length || children.includes(lock.pid);
      if (!lockAlive) return unknown(`The task is running, but the runner lock's owner (pid ${lock.pid}, since ${isoOf(lockAt)}) is gone.`);
      if (!owned) return unknown(`The task is running, but the runner lock is held by pid ${lock.pid}, which is not this task's process (a manual run?).`);
      if (ofRun(lockAt)) {
        return Object.assign(out, { state: 'running', reason: `Running since ${isoOf(runStart)}; the runner (pid ${lock.pid}) holds its lock; ${minutes} min left before the time limit. Its result line is written when it finishes, so an old last line is expected.${also}`, runner: { started_at: isoOf(lockAt), pid: lock.pid } });
      }
      return unknown(`The task is running, but the runner lock began ${isoOf(lockAt)}, not within ${GRACE_MS / 1000} s of this run's start (${isoOf(runStart)}).`);
    }
    if (line && !refused) return Object.assign(out, { state: 'running', reason: `The runner wrote this start's result (exit ${out.runner.exit}); the task is ending.` });
    if (now - runStart <= GRACE_MS) return Object.assign(out, { state: 'running', reason: `Started ${isoOf(runStart)}; within the ${GRACE_MS / 1000} s start-up grace, before the runner takes its lock.` });
    return unknown(`The task has run since ${isoOf(runStart)} with no runner lock and no result line: the runner did not start, or it ended without one.${also}`, { gap: true });
  }

  // Ended: this start's own line decides; Task Scheduler's result is checked against it.
  const plainCode = result !== null && result <= 255;
  const byLine = (r, note = '') => {
    if (r.skipped === 'locked') return Object.assign(out, { state: 'completed', reason: `This start found another run holding the lock and dispatched nothing.${note}` });
    if (r.exit === 0) return Object.assign(out, { state: 'completed', reason: `Completed: ${r.paused ? 'automation was paused, nothing dispatched' : `${r.dispatches} dispatch${r.dispatches === 1 ? '' : 'es'}`}.${note}` });
    if (r.exit === 3) return Object.assign(out, { state: 'completed', reason: `Completed; ${r.needs_eric} project${r.needs_eric === 1 ? ' needs' : 's need'} Eric (exit 3).${note}` });
    if (r.exit === 1) return Object.assign(out, { state: 'failed', reason: `The runner reported an error (exit 1${r.errors ? `, ${r.errors} dispatch error${r.errors === 1 ? '' : 's'}` : ''}); its words are in pilot-all.jsonl.${note}` });
    return unknown(`This start's runner line has no exit code it knows (${r.exit}).`);
  };
  if (line) {
    const r = out.runner;
    if (out.task.launcher === 'job_wrapper' && plainCode && r.exit !== null && result !== r.exit) {
      return unknown(`Task Scheduler recorded ${result} for this start and the runner ${r.exit}; they should agree.`);
    }
    return byLine(r);
  }
  // No line began at the last start: was it a trigger refused while an
  // earlier run went on? That run's line spans it, and Task Scheduler's
  // result is that run's exit code.
  const spanning = valid.filter((r) => ms(r.started_at) < lastRun - SKEW_MS && Number.isFinite(ms(r.finished_at)) && ms(r.finished_at) >= lastRun);
  if (spanning.length === 1 && !malformed) {
    const r = runnerOf(spanning[0]);
    const agrees = out.task.launcher === 'job_wrapper' && plainCode && r.exit !== null && result === r.exit && r.skipped === null;
    if (agrees) {
      out.runner = r;
      return byLine(r, ` The last start Task Scheduler shows (${isoOf(lastRun)}) was refused while this run, begun ${r.started_at}, went on (IgnoreNew), and Task Scheduler's result is that run's.`);
    }
    return unknown(`No runner line began at the last start (${isoOf(lastRun)}); a run begun ${r.started_at} was still going then (a refused start, IgnoreNew, or a manual run beside it), but Task Scheduler's result ${result === null ? '(none)' : `${result} (${hex(result)})`} is not that run's exit${r.exit === null ? '' : ` (${r.exit})`}, so which run it was is unknown.`, { gap: true });
  }
  if (spanning.length > 1) return unknown(`No runner line began at the last start (${isoOf(lastRun)}), and ${spanning.length} runs were going then, so which one it was is ambiguous.`);
  if (result !== null && LAUNCHER[result] && out.task.launcher === 'job_wrapper') return Object.assign(out, { state: 'failed', reason: `The start failed: ${LAUNCHER[result]} (${result}).` });
  // The runner's lock left by this start, its owner gone: killed before its line.
  if (lock.status === 'ok' && inWindow(lockAt) && !lockAlive) {
    return Object.assign(out, { state: 'interrupted', reason: `This start's runner (pid ${lock.pid}) ended without its result line${result === 0x41306 ? '; Task Scheduler ended it (its time limit or a Stop)' : ''}. Its lock is left as it is (the next run takes it over after 3 hours), and an uncertain dispatch stays for Eric to reconcile.` });
  }
  if (result === 0x41306) return Object.assign(out, { state: 'interrupted', reason: 'Task Scheduler ended it (its time limit or a Stop) before the runner wrote its result line; an uncertain dispatch stays for Eric to reconcile.' });
  if (lock.status === 'ok' && inWindow(lockAt) && lockAlive) return unknown(`The task has ended, but this start's runner lock is still held by pid ${lock.pid}, which exists (the same process, or its ID reused).`);
  if (malformed) return unknown(`No runner line for this start, and ${malformed} line${malformed === 1 ? '' : 's'} of the log do not read; one may be this start's.`);
  const said = result === null ? 'no result' : `${result} (${hex(result)})`;
  return unknown(
    `Task Scheduler recorded ${said} for the start at ${isoOf(lastRun)}, but the runner wrote no line for it: a supervision gap; the runner's own result is not known${out.task.launcher === 'conhost' ? ' (and conhost\'s result is not the runner\'s: measured 0 for every exit)' : ''}.`,
    { gap: true },
  );
}

async function main() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  let facts = null;
  try { facts = JSON.parse(text.replace(/^﻿/, '')); } catch (_) { facts = null; }
  const r = classify(facts, { now: Date.now(), log: readLog(), lock: readLock(), alive: processAlive });
  process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
}

module.exports = { VERSION, FACTS_FORMAT, GRACE_MS, SKEW_MS, SCHED, LAUNCHER, durationMs, readLog, readLock, classify };

if (require.main === module) {
  main().catch((err) => {
    process.stdout.write(`${JSON.stringify({ format: VERSION, state: 'unknown', reason: `The status could not be read (${String(err && err.message || err).slice(0, 120)}).` }, null, 2)}\n`);
  });
}
