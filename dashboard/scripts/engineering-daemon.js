#!/usr/bin/env node
'use strict';
// The engineering worker daemon (Eric, 2026-10-26,
// audits/2026-10-26-worker-daemon): builds the tasks admitted inside his
// delegations without anyone pasting a prompt. It is a worker connection like
// any other (engineering-daemon-desk.js): it polls the desk, claims one task
// at a time and runs the lane's steps itself, deterministically, through
// engineering-worker.js; headless Claude only edits files, sealed
// (engineering-daemon-claude.js). It never authorizes, reviews, merges,
// deploys or opens a pull request: candidate-review.yml opens one on a pass
// and Eric merges.
//
//   login           Eric approves the daemon once on the desk (Claude, Worker)
//   run             the loop: a pass every 30 s, backing off when the desk or
//                   Git fails (doubling to 15 minutes, back on a success)
//   once            one pass
//   status          the daemon's state, budget and recent receipts
//   reset           clears the hourly budget and the waits between tries
//   print-command   the exact claude command, without running it
//
// One pass: the oldest task the desk shows needing a worker step, admitted
// under a delegation the daemon builds for (CR_DAEMON_TEMPLATES, default
// eng-backend@1 and eng-app@4), with no live claim, is claimed (the desk's
// lease is the lock between runners) and taken one phase on:
//   admission  number from Git, bind, commit the entry, push
//              claude/admission-<task> (the admission workflow adds it)
//   confirm    read main back, admission_confirmed, then the build
//   build      Claude edits a fresh checkout; the daemon checks every changed
//              path (Rule N4: protected, restricted, forbidden or out of scope
//              is discarded and recorded blocked), commits, runs the sealed
//              verify (one correction round on a failure), records the
//              candidate, pushes claude/candidate-eng-<n> and records the
//              verification
//   finish     a candidate recorded but not verified: verify and record
//   release    a promote template after an attended review: push
//              claude/backlog-eng-<n>
// A watchdog stops Claude after 15 minutes (CR_DAEMON_CLAUDE_TIMEOUT_MS);
// a timeout or a failure records a note with the diagnostics and stopped
// (the claim is released, nothing is pushed). At most three builds start in
// any hour (Claude runs; the other phases are free). Every pass that claims
// leaves a receipt. The daemon's home (CR_DAEMON_HOME, default
// ~/.cryptoresearch/engineering-daemon) holds its sign-in, state, lock,
// receipts and its own clone; nothing of it is in the repository.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const P = require('../engineering/policy');
const { makeDesk, DeskError, DEFAULT_DESK } = require('./engineering-daemon-desk');
const C = require('./engineering-daemon-claude');

const WORKER = path.join(__dirname, 'engineering-worker.js');
const HOUR = 3600 * 1000;
const MIN = 60 * 1000;
const MAX_BUDGET = 3;
const DEFAULTS = { pollMs: 30000, maxBackoffMs: 15 * MIN, claudeTimeoutMs: 15 * MIN, heartbeatMs: 5 * MIN, budget: MAX_BUDGET, templates: ['eng-backend@1', 'eng-app@4'], waitMs: 5 * MIN, admissionGraceMs: 15 * MIN, admissionLimitMs: HOUR, fixupMinMs: 2 * MIN };
const WORKER_STATUSES = 'admitted,queued,claimed,implementing,verifying,ready_for_promotion';
const RECEIPT = 'cr.worker-daemon-receipt.v1';
const PROTECTED_RULE = 'the workflows, CLAUDE.md and agent settings, DESK_STATE.md, package files, dashboard/engineering/, the front door, sign-in and the connectors, the ledger and wallets, the backlog and promotion scripts, the guard tests, this worker daemon, and every other path dashboard/scripts/backlog-promote.js lists as PROTECTED.';
const iso = (ms) => new Date(ms).toISOString();
const defaultHome = () => process.env.CR_DAEMON_HOME || path.join(os.homedir(), '.cryptoresearch', 'engineering-daemon');
const tail = (s, n = 6000) => String(s || '').slice(-n);

// A step that ends the phase: what the daemon records then (settle below).
//   stale    the claim is not current: record nothing more, push nothing
//   paused   engineering is paused: record stopped, as the desk asks
//   wait     not yet (the admission workflow, the budget): stopped, retried later
//   stopped  a failed try: a note with the diagnostics, then stopped
//   blocked  Rule N4 or a refusal only Eric can lift: a note, then blocked
//   lost     the desk's answer was lost: nothing more; the next pass reads back
class Halt extends Error {
  constructor(kind, message, extra = {}) { super(message); this.kind = kind; Object.assign(this, extra); }
}

function git(cwd, args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  return { status: r.status, out: (r.stdout || '').replace(/\n$/, ''), err: (r.stderr || '').trim() };
}
// What git status shows changed or untracked (ignored files aside), by path.
function changedPaths(cwd) {
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

// engineering-worker.js as a child (main's own copy, never the candidate's),
// its one JSON answer parsed; a failure is a Halt with its words.
function runWorker(cwd, args, { timeoutMs = 45 * MIN } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, ...args], { cwd, env: process.env, windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => C.killTree(child), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err = (err + d).slice(-8000); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(out); } catch (_) { /* no answer */ }
      resolve({ code, json, err: err.trim() });
    });
  });
}

function stateStore(home) {
  const file = path.join(home, 'state.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; } };
  const write = (s) => {
    fs.mkdirSync(home, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
    fs.renameSync(tmp, file);
  };
  return { file, read, update: (fn) => { const s = read(); fn(s); write(s); return s; } };
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function readLock(home) { try { return JSON.parse(fs.readFileSync(path.join(home, 'daemon.lock'), 'utf8')); } catch (_) { return null; } }
// One daemon per home: created exclusively; a lock whose process is gone is
// taken over. Returns the release.
function takeLock(home) {
  const file = path.join(home, 'daemon.lock');
  fs.mkdirSync(home, { recursive: true });
  for (let i = 0; i < 2; i += 1) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), host: os.hostname() }), { flag: 'wx' });
      return () => { const l = readLock(home); if (l && l.pid === process.pid) { try { fs.unlinkSync(file); } catch (_) { /* gone */ } } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const held = readLock(home);
      if (held && pidAlive(held.pid)) throw new DeskError(`Another worker daemon runs on this home (pid ${held.pid}, since ${held.started_at}). Nothing was started.`, { code: 'LOCKED' });
      try { fs.unlinkSync(file); } catch (_) { /* taken meanwhile */ }
    }
  }
  throw new DeskError('The daemon lock could not be taken.', { code: 'LOCKED' });
}

function makeDaemon({ home = defaultHome(), desk, claude = null, clock = Date.now, sleep = null, say = (line) => process.stdout.write(`${line}\n`), remoteUrl = null, config = {} } = {}) {
  const cfg = { ...DEFAULTS, ...config };
  cfg.budget = Math.max(0, Math.min(MAX_BUDGET, Number(cfg.budget)));
  const state = stateStore(home);
  const repo = path.join(home, 'repo');
  const askImpl = claude || ((o) => C.runClaude({ ...o, home }));
  const wait = sleep || ((ms, signal) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  }));
  let roleChecked = false;

  function log(line) {
    const at = iso(clock());
    try { fs.mkdirSync(home, { recursive: true }); fs.appendFileSync(path.join(home, 'daemon.log'), `${at} ${line}\n`); } catch (_) { /* the line is said anyway */ }
    say(line);
  }

  // --- budget and waits ----------------------------------------------------------------
  const recent = (s, now) => (s.attempts || []).filter((a) => now - Date.parse(a) < HOUR);
  function budget() {
    const now = clock();
    const used = recent(state.read(), now);
    return { limit: cfg.budget, used: used.length, left: Math.max(0, cfg.budget - used.length), next_free_at: used.length >= cfg.budget ? iso(Date.parse(used[0]) + HOUR) : null };
  }
  const spend = () => state.update((s) => { const now = clock(); s.attempts = [...recent(s, now), iso(now)]; });
  const holdOff = (taskId, ms) => state.update((s) => { s.cooldown = { ...(s.cooldown || {}), [taskId]: iso(clock() + ms) }; });
  function reset() { state.update((s) => { s.attempts = []; s.cooldown = {}; s.backoff_ms = 0; }); return budget(); }

  // --- desk ------------------------------------------------------------------------------
  async function checkRole() {
    if (roleChecked) return;
    const caps = await desk.call('engineering_capabilities', {});
    if (caps.role !== 'worker') throw new DeskError(`This sign-in has the ${caps.role || 'unknown'} role; run npm run worker:login again and choose Worker.`, { code: 'LOGIN_NEEDED' });
    roleChecked = true;
  }
  function step(ctx, name, ok, detail = null) {
    ctx.r.steps.push({ at: iso(clock()), step: name, ok, ...(detail ? { detail: String(detail).slice(0, 600) } : {}) });
  }
  async function record(ctx, type, fields = {}) {
    try {
      const out = await desk.call('engineering_record_event', { task_id: ctx.t.task_id, claim_token: ctx.token, type, ...fields });
      step(ctx, `event ${type}${fields.phase ? ` ${fields.phase}` : ''}`, true, out && out.unchanged ? 'unchanged' : null);
      return out || {};
    } catch (e) {
      step(ctx, `event ${type}`, false, e.message);
      if (!(e instanceof DeskError)) throw e;
      if (e.code === 'STALE_CLAIM' || e.code === 'HELD') throw new Halt('stale', e.message);
      if (e.code === 'PAUSED') throw new Halt('paused', e.message);
      if (e.code === 'SCOPE' || e.code === 'TOO_LARGE') throw new Halt('blocked', e.message);
      if (e.code === 'NO_ANSWER' || e.code === 'LOGIN_NEEDED' || (e.code === 'HTTP' && e.transient)) throw new Halt('lost', e.message, { cause: e });
      throw new Halt('stopped', `the desk refused ${type}: ${e.message}`);
    }
  }
  function startHeartbeat(ctx) {
    const timer = setInterval(() => {
      desk.call('engineering_record_event', { task_id: ctx.t.task_id, claim_token: ctx.token, type: 'heartbeat' }).catch((e) => {
        if (e instanceof DeskError && ['STALE_CLAIM', 'PAUSED', 'HELD'].includes(e.code)) { ctx.lost = e.code; ctx.abort.abort(); }
      });
    }, cfg.heartbeatMs);
    if (timer.unref) timer.unref();
    ctx.stopHeartbeat = () => clearInterval(timer);
  }
  function stillOurs(ctx) {
    if (ctx.lost === 'PAUSED') throw new Halt('paused', 'engineering was paused while the daemon worked');
    if (ctx.lost) throw new Halt('stale', `the claim was lost while the daemon worked (${ctx.lost})`);
  }

  // --- Git -------------------------------------------------------------------------------
  function remote() {
    if (remoteUrl) return remoteUrl;
    if (process.env.CR_DAEMON_REMOTE) return process.env.CR_DAEMON_REMOTE;
    return git(path.resolve(__dirname, '..', '..'), ['remote', 'get-url', 'origin']).out;
  }
  // The daemon's own clone (LF as committed, never Eric's checkout).
  function ensureRepo() {
    if (!fs.existsSync(path.join(repo, '.git'))) {
      fs.mkdirSync(home, { recursive: true });
      git(home, ['clone', '-q', '-c', 'core.autocrlf=false', remote(), repo]);
    }
    return repo;
  }
  function fetchRefs(refs) {
    git(repo, ['-c', 'http.lowSpeedLimit=1', '-c', 'http.lowSpeedTime=30', 'fetch', '-q', 'origin', ...refs], { allowFail: false });
  }
  async function worker(ctx, ...args) {
    const r = await runWorker(repo, args);
    if (r.code !== 0 || !r.json) {
      step(ctx, `worker ${args[0]}`, false, r.err);
      throw new Halt('stopped', `engineering-worker.js ${args[0]} failed: ${String(r.err || 'no answer').slice(0, 400)}`);
    }
    step(ctx, `worker ${args[0]}`, true, args[0] === 'verify' ? `${r.json.status || (r.json.ok ? 'ok' : 'failed')}: ${r.json.passed}/${r.json.total}, exit ${r.json.exit_code}` : null);
    return r.json;
  }
  function checkout(ctx, branch, start) {
    git(repo, ['checkout', '-q', '-f', '-B', branch, start]);
    git(repo, ['reset', '-q', '--hard', start]);
    git(repo, ['clean', '-q', '-fd']);
    ctx.start = start;
    ctx.checkout = repo;
  }
  function discard(ctx) {
    if (!ctx.checkout || !ctx.start) return;
    try { git(repo, ['reset', '-q', '--hard', ctx.start]); git(repo, ['clean', '-q', '-fd']); } catch (_) { /* the next checkout cleans */ }
  }
  const hasCommit = (sha) => git(repo, ['cat-file', '-e', `${sha}^{commit}`], { allowFail: true }).status === 0;

  // A push recorded before and after (intent, then observed or failed).
  async function pushRecorded(ctx, action, ref, sha) {
    const now = await worker(ctx, 'remote-sha', '--ref', ref);
    await record(ctx, 'remote_action', { action, phase: 'intent', ref, sha });
    // Already there (a push whose record was lost): recorded as it is.
    const p = now.sha === sha ? { landed: true, observed_sha: sha } : await worker(ctx, 'push', '--ref', ref, '--sha', sha, ...(now.sha ? ['--expect', now.sha] : ['--expect-absent']));
    await record(ctx, 'remote_action', { action, phase: p.landed ? 'observed' : 'failed', ref, observed_sha: p.observed_sha || null, ...(p.landed ? {} : { note: String(p.refusal || 'not landed').slice(0, 300) }) });
    if (!p.landed) throw new Halt('stopped', `the push of ${ref} did not land: ${p.refusal || 'the remote holds another commit'}`);
    return true;
  }
  // An intent recorded before a push whose outcome never reached the desk:
  // read the ref back and record what Git shows, before anything else.
  async function reconcile(ctx) {
    if (!(ctx.t.dispatch_unknown || []).length) return;
    ensureRepo();
    for (const d of ctx.t.dispatch_unknown) {
      const seen = await worker(ctx, 'remote-sha', '--ref', d.ref);
      await record(ctx, 'remote_action', { action: d.action, phase: seen.sha === d.sha ? 'observed' : 'failed', ref: d.ref, observed_sha: seen.sha || null, note: 'reconciled from Git by the worker daemon' });
      if (seen.sha === d.sha && ['push_admission', 'push_release'].includes(d.action)) { throw new Halt('done', `${d.action} had landed; recorded`); }
    }
    ctx.t = await desk.call('engineering_get_task', { task_id: ctx.t.task_id });
  }

  // --- Rule N4: the change stays inside what was approved --------------------------------
  function outOfBounds(t, files) {
    const template = t.authorization && t.authorization.template;
    const pol = { template };
    const scope = (t.content && t.content.scope && t.content.scope.paths) || [];
    const out = [];
    for (const f of files) {
      const why = P.protectedWhy(f);
      if (why) { out.push(`${f} is protected (${why})`); continue; }
      const hit = P.restrictedHit(f, template);
      if (hit) { out.push(`${f} is in ${P.restrictedWhere(hit)} (${hit.why})`); continue; }
      const g = P.forbiddenHit(f, pol);
      if (g) { out.push(`${f} is forbidden under ${template} (${g})`); continue; }
      if (!P.matches(f, scope)) out.push(`${f} is outside the task's scope (${scope.join(', ')})`);
    }
    return out;
  }
  function guard(ctx, files) {
    const bad = outOfBounds(ctx.t, files);
    step(ctx, 'boundary', !bad.length, bad.join('; ') || `${files.length} files inside the scope`);
    if (bad.length) throw new Halt('blocked', `the change reaches past the approved scope, so it was discarded: ${bad.join('; ')}`);
  }
  const testsRule = (t) => P.rulesOf({ template: t.authorization && t.authorization.template }).tests;
  const missingTest = (t, files) => { const rule = testsRule(t) || 'dashboard/tests/**'; return !files.some((f) => P.matches(f, [rule])); };

  // --- Claude ----------------------------------------------------------------------------
  async function ask(ctx, { findings = [], failure = null, changed = [] } = {}) {
    const left = ctx.deadline - Date.now();
    if (left < 1000) throw new Halt('stopped', 'watchdog: no time was left for Claude in this try');
    const { prompt, nonce } = C.buildPrompt({ task: ctx.t, protectedRule: PROTECTED_RULE, testsRule: testsRule(ctx.t), findings, failure, changed });
    const run = await askImpl({ cwd: repo, prompt, timeoutMs: left, signal: ctx.abort.signal });
    ctx.r.claude.push({ duration_ms: run.duration_ms, exit_code: run.exit_code, timed_out: Boolean(run.timed_out), stopped: run.stopped || null, num_turns: run.num_turns || null });
    stillOurs(ctx);
    if (run.timed_out) throw new Halt('stopped', `watchdog: Claude gave no answer within ${Math.round(cfg.claudeTimeoutMs / MIN)} minutes and was stopped`, { output: run.stderr_tail });
    if (!run.ok) throw new Halt('stopped', `Claude stopped without an answer (exit ${run.exit_code}${run.error ? `, ${run.error}` : ''})`, { output: run.stderr_tail || tail(run.text, 2000) });
    const answer = C.parseAnswer(run.text, nonce);
    if (!answer) throw new Halt('stopped', 'Claude gave no answer in the agreed form', { output: tail(run.text, 2000) });
    if (answer.blocker) throw new Halt('blocked', `Claude could not build it inside the approved scope: ${answer.blocker}`);
    return answer;
  }
  async function findingsOf(t) {
    const out = [];
    if (!t.candidate) return out;
    const ev = await desk.call('engineering_get_evidence', { task_id: t.task_id, max_chars: 1000 });
    for (const r of ev.reviews || []) if (r.result !== 'pass') out.push({ review: r.result, summary: r.summary, findings: r.findings });
    if (ev.verification && !ev.verification.ok) out.push({ verification: 'failed', output_tail: tail(ev.verification.output_tail, 4000) });
    return out;
  }
  function commit(ctx, message) {
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', message]);
    return git(repo, ['rev-parse', 'HEAD']).out;
  }
  const messageOf = (t, answer, extra = '') => `engineering: ${String(t.content.title || t.title).slice(0, 90)} (item ${t.admission.number})\n\n${answer.summary || 'Built by the worker daemon.'}${extra}\n\nBuilt unattended by the worker daemon (claude -p, restricted) for ${t.task_id} v${t.version}.\n\nEngineering-Task: ${t.task_id} v${t.version}\nCo-Authored-By: Claude <noreply@anthropic.com>\n`;
  // The bundle is rebuilt and committed when the app's source changed (or
  // verify asks for it); its files are checked like any other.
  async function bundleIfNeeded(ctx, files, force = false) {
    if (!force && !files.some((f) => f.startsWith('dashboard/web/src/'))) return;
    const b = await worker(ctx, 'bundle');
    if (b.status === 'build_failed') throw new Halt('stopped', `the bundle build failed (${b.step})`, { output: b.output_tail });
    if (b.status === 'rebuilt') { guard(ctx, changedPaths(repo)); commit(ctx, `bundle: rebuild for item ${ctx.t.admission.number}\n\nEngineering-Task: ${ctx.t.task_id} v${ctx.t.version}\n`); }
  }
  async function verified(ctx, files) {
    await bundleIfNeeded(ctx, files);
    let v = await worker(ctx, 'verify');
    if (v.status === 'commit_bundle_first') { await bundleIfNeeded(ctx, files, true); v = await worker(ctx, 'verify'); }
    ctx.r.verify = { head_sha: v.head_sha, tree_sha: v.tree_sha || null, status: v.status || (v.ok ? 'ok' : 'failed'), exit_code: v.exit_code, total: v.total, passed: v.passed, failed: v.failed, output_sha256: v.output_sha256 || null };
    return v;
  }
  // Every file the candidate changes against main (a correction keeps the
  // earlier candidate's files).
  const committedFiles = () => git(repo, ['diff', '--name-only', '--no-renames', git(repo, ['merge-base', 'refs/remotes/origin/main', 'HEAD']).out, 'HEAD']).out.split('\n').filter(Boolean);

  // --- phases ----------------------------------------------------------------------------
  async function admission(ctx) {
    const t = ctx.t;
    ensureRepo();
    let entry;
    if (t.admission && t.admission.state === 'bound' && t.public_entry && t.public_entry.bound) entry = t.public_entry.text;
    else {
      const nums = await worker(ctx, 'numbers');
      if (nums.complete === false) throw new Halt('wait', 'an open intake or admission branch could not be read, so no number is chosen yet');
      entry = (await record(ctx, 'admission_number', { number: nums.next, observed_max: nums.observed_max, observed_main_sha: nums.main_sha })).entry;
    }
    const file = path.join(home, 'tmp', `${t.task_id}.entry`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entry);
    const c = await worker(ctx, 'admission-commit', '--task', t.task_id, '--entry-file', file);
    if (c.status === 'number_on_main') {
      await record(ctx, 'admission_refused', { number: c.number, reason: `item ${c.number} is already on main; the next pass numbers it again` });
      ctx.r.outcome = 'number_taken';
      return;
    }
    // The desk releases the claim once the push is observed.
    await pushRecorded(ctx, 'push_admission', c.ref, c.head_sha);
    holdOff(t.task_id, cfg.waitMs);
    ctx.r.outcome = 'admission_pushed';
  }

  async function confirm(ctx) {
    const t = ctx.t;
    ensureRepo();
    const st = await worker(ctx, 'admission-status', '--task', t.task_id);
    if (st.on_main) {
      await record(ctx, 'admission_confirmed', { main_sha: st.main_sha, entry_sha256: st.entry_sha256 });
      ctx.t = await desk.call('engineering_get_task', { task_id: t.task_id });
      if (budget().left <= 0) throw new Halt('wait', `item ${t.admission.number} is on main; its build waits for the hourly budget (next at ${budget().next_free_at})`);
      return build(ctx);
    }
    const pushed = [...(t.events || [])].reverse().find((e) => e.type === 'remote_observed');
    const since = pushed ? clock() - Date.parse(pushed.at) : 0;
    if (st.admission_branch && since > cfg.admissionLimitMs) throw new Halt('blocked', `the admission workflow has not added item ${t.admission.number} to main within ${Math.round(cfg.admissionLimitMs / MIN)} minutes and its branch is still there; see its run on GitHub`);
    if (st.admission_branch || !pushed || since < cfg.admissionGraceMs) throw new Halt('wait', `the admission workflow has not added item ${t.admission.number} to main yet`);
    await record(ctx, 'admission_refused', { number: t.admission.number, reason: 'the engineering-admission workflow did not add it: its branch is gone and main does not hold the entry' });
    ctx.r.outcome = 'admission_refused';
  }

  async function build(ctx) {
    const t = ctx.t;
    if (budget().left <= 0) throw new Halt('wait', `the hourly budget of ${cfg.budget} builds is used (next at ${budget().next_free_at})`);
    const n = t.admission.number;
    const branch = `claude/candidate-eng-${n}`;
    ensureRepo();
    fetchRefs([`+refs/heads/main:refs/remotes/origin/main`]);
    git(repo, ['fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { allowFail: true });
    const base = git(repo, ['rev-parse', 'refs/remotes/origin/main']).out;
    const correcting = Boolean(t.candidate) && (((t.corrections || []).some((c) => !c.resolved_by_head)) || (t.verification && !t.verification.ok));
    const start = correcting && hasCommit(t.candidate.head_sha) ? t.candidate.head_sha : base;
    checkout(ctx, branch, start);
    await record(ctx, 'started', { branch, base_sha: base });
    startHeartbeat(ctx);
    const findings = correcting ? await findingsOf(t) : [];
    // The budget counts builds that reach Claude; the watchdog covers both
    // of a build's runs.
    spend();
    ctx.deadline = Date.now() + cfg.claudeTimeoutMs;

    let answer = await ask(ctx, { findings });
    let now = changedPaths(repo);
    if (!now.length) throw new Halt('stopped', 'Claude made no change');
    guard(ctx, now);
    commit(ctx, messageOf(ctx.t, answer));
    let files = committedFiles();
    let v = await verified(ctx, files);
    stillOurs(ctx);
    let why = !v.ok ? `the suite did not pass (${v.status || `${v.failed} failed of ${v.total}, exit ${v.exit_code}`})` : missingTest(ctx.t, files) ? `it changes no test (${testsRule(ctx.t) || 'dashboard/tests/**'})` : null;
    if (why) {
      // One correction round, inside the same watchdog.
      if (ctx.deadline - Date.now() < cfg.fixupMinMs) throw new Halt('stopped', `${why}, and too little time was left for a correction`, { output: v.output_tail });
      answer = await ask(ctx, { findings, failure: { why, output: tail(v.output_tail || v.says, 8000) }, changed: files });
      now = changedPaths(repo);
      if (now.length) { guard(ctx, now); commit(ctx, messageOf(ctx.t, answer, '\n\nA correction after the first try was refused.')); }
      files = committedFiles();
      v = await verified(ctx, files);
      stillOurs(ctx);
      why = !v.ok ? `the suite did not pass after one correction (${v.status || `${v.failed} failed of ${v.total}, exit ${v.exit_code}`})` : missingTest(ctx.t, files) ? 'it still changes no test' : null;
      if (why) throw new Halt('stopped', why, { output: v.output_tail });
    }
    const acc = (ctx.t.content.acceptance || []).map((_, i) => answer.acceptance.find((a) => a.index === i) || { index: i, met: false, evidence: null });
    const unmet = acc.filter((a) => !a.met).map((a) => a.index + 1);
    if (unmet.length) throw new Halt('stopped', `Claude did not report acceptance ${unmet.join(', ')} as met`);

    const ev = await worker(ctx, 'evidence', '--head', 'HEAD', '--base', 'refs/remotes/origin/main');
    guard(ctx, ev.files);
    const notes = `${answer.summary}\n\nBuilt unattended by the worker daemon: claude -p --restricted (file tools only, no shell, network or MCP), ${ctx.r.claude.length} run(s); the daemon committed, ran the sealed verify and pushed.`;
    const cand = await record(ctx, 'candidate', { branch, head_sha: ev.head_sha, base_sha: ev.base_sha, merge_base_sha: ev.merge_base_sha, files: ev.files, diff: ev.diff, notes });
    if (cand.blocked) { ctx.r.outcome = 'blocked_by_ceiling'; return; }
    state.update((s) => { s.pending = { ...(s.pending || {}), [t.task_id]: { head_sha: ev.head_sha, acceptance: acc } }; });
    await pushRecorded(ctx, 'push_candidate', `refs/heads/${branch}`, ev.head_sha);
    ctx.stopHeartbeat();
    await recordVerification(ctx, ev.head_sha, v, acc);
    ctx.r.head_sha = ev.head_sha;
    ctx.r.outcome = 'candidate_pushed';
  }

  async function recordVerification(ctx, head, v, acc) {
    const out = await record(ctx, 'verification', { head_sha: head, command: v.command, exit_code: v.exit_code, total: v.total, passed: v.passed, failed: v.failed, output_tail: v.output_tail, output_sha256: v.output_sha256, acceptance: acc });
    state.update((s) => { if (s.pending) delete s.pending[ctx.t.task_id]; });
    return out;
  }

  // A candidate the desk recorded but never saw verified (a pass that ended
  // between the two): its head is verified as it is and recorded, with the
  // acceptance answer kept when it was built. No Claude.
  async function finish(ctx) {
    const t = ctx.t;
    const kept = (state.read().pending || {})[t.task_id];
    if (!kept || kept.head_sha !== t.candidate.head_sha) throw new Halt('blocked', `candidate ${t.candidate.head_sha.slice(0, 12)} is recorded without a verification, and this daemon kept no acceptance answer for it; Eric decides`);
    ensureRepo();
    git(repo, ['fetch', '-q', 'origin', `+refs/heads/${t.candidate.branch}:refs/remotes/origin/${t.candidate.branch}`], { allowFail: true });
    if (!hasCommit(t.candidate.head_sha)) throw new Halt('stopped', `the recorded candidate ${t.candidate.head_sha.slice(0, 12)} is not in Git here`);
    checkout(ctx, t.candidate.branch, t.candidate.head_sha);
    startHeartbeat(ctx);
    await pushRecorded(ctx, 'push_candidate', `refs/heads/${t.candidate.branch}`, t.candidate.head_sha);
    // Verified exactly as recorded: a stale bundle stops it, never a rebuild.
    const v = await worker(ctx, 'verify');
    stillOurs(ctx);
    if (!v.ok) throw new Halt('stopped', `the recorded candidate does not pass (${v.status || `${v.failed} failed of ${v.total}`})`, { output: v.output_tail || v.says });
    ctx.stopHeartbeat();
    await recordVerification(ctx, t.candidate.head_sha, v, kept.acceptance);
    ctx.r.head_sha = t.candidate.head_sha;
    ctx.r.outcome = 'verification_recorded';
  }

  async function release(ctx) {
    const t = ctx.t;
    ensureRepo();
    git(repo, ['fetch', '-q', 'origin', `+refs/heads/${t.candidate.branch}:refs/remotes/origin/${t.candidate.branch}`], { allowFail: true });
    if (!hasCommit(t.candidate.head_sha)) throw new Halt('stopped', `the recorded candidate ${t.candidate.head_sha.slice(0, 12)} is not in Git here`);
    await pushRecorded(ctx, 'push_release', `refs/heads/claude/backlog-eng-${t.admission.number}`, t.candidate.head_sha);
    ctx.r.outcome = 'release_pushed';
  }

  // What happens when a phase ends early (Halt above).
  async function settle(ctx, e) {
    const h = e instanceof Halt ? e : e instanceof DeskError && (e.code === 'NO_ANSWER' || e.code === 'LOGIN_NEEDED' || (e.code === 'HTTP' && e.transient)) ? new Halt('lost', e.message, { cause: e }) : new Halt('stopped', `unexpected: ${String(e && e.message).slice(0, 400)}`);
    ctx.r.reason = h.message.slice(0, 600);
    discard(ctx);
    const quietly = async (type, fields) => { try { await record(ctx, type, fields); } catch (err) { step(ctx, `event ${type}`, false, err.message); } };
    const notes = `Worker daemon, ${ctx.r.phase}: ${h.message}${h.output ? `\n\nLast output:\n${tail(h.output, 3000)}` : ''}`;
    switch (h.kind) {
      case 'done': ctx.r.outcome = 'reconciled'; return null;
      case 'stale': ctx.r.outcome = 'stale_claim'; return null;
      case 'lost': ctx.r.outcome = 'desk_unreachable'; return h.cause || new DeskError(h.message, { code: 'NO_ANSWER', transient: true });
      case 'paused': await quietly('stopped', { reason: `paused: ${h.message}`.slice(0, 300) }); ctx.r.outcome = 'paused'; return null;
      case 'wait': await quietly('stopped', { reason: h.message.slice(0, 300) }); holdOff(ctx.t.task_id, cfg.waitMs); ctx.r.outcome = 'waiting'; return null;
      case 'blocked': await quietly('note', { text: notes }); await quietly('blocked', { reason: h.message.slice(0, 300) }); ctx.r.outcome = 'blocked'; return null;
      default: await quietly('note', { text: notes }); await quietly('stopped', { reason: h.message.slice(0, 300) }); holdOff(ctx.t.task_id, cfg.waitMs); ctx.r.outcome = 'stopped'; return null;
    }
  }

  function writeReceipt(r) {
    const dir = path.join(home, 'receipts');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${r.started_at.replace(/[:.]/g, '-')}-${r.task_id}-${r.phase}.json`);
    fs.writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`);
    return file;
  }

  async function runPhase(phase, t, claim) {
    const r = { schema: RECEIPT, task_id: t.task_id, number: t.admission ? t.admission.number : null, version: t.version, template: t.authorization.template, phase, generation: claim.generation, started_at: iso(clock()), steps: [], claude: [], verify: null, outcome: null };
    const ctx = { t, token: claim.claim_token, r, abort: new AbortController(), stopHeartbeat: () => {} };
    state.update((s) => { s.current = { task_id: t.task_id, phase, since: r.started_at }; });
    let rethrow = null;
    try {
      await reconcile(ctx);
      await ({ admission, confirm, build, finish, release })[phase](ctx);
      r.outcome = r.outcome || 'done';
    } catch (e) {
      rethrow = await settle(ctx, e);
    } finally {
      ctx.stopHeartbeat();
      r.ended_at = iso(clock());
      r.budget = budget();
      state.update((s) => { s.current = null; s.last_outcome = { task_id: t.task_id, phase, outcome: r.outcome, at: r.ended_at }; });
      r.file = writeReceipt(r);
      log(`${t.task_id} (item ${r.number || '-'}) ${phase}: ${r.outcome}${r.reason ? `: ${r.reason}` : ''}`);
    }
    if (rethrow) throw rethrow;
    return r;
  }

  // --- selection -------------------------------------------------------------------------
  function phaseOf(t) {
    const a = t.authorization;
    if (!a || a.kind !== 'policy' || !a.holds || !cfg.templates.includes(a.template) || t.lease || t.executable === false || t.unsupported) return null;
    switch (t.status) {
      case 'admitted': return !t.admission || ['unbound', 'bound'].includes(t.admission.state) ? 'admission' : t.admission.state === 'pushed' ? 'confirm' : null;
      case 'queued': case 'claimed': case 'implementing': return t.admission && t.admission.number ? 'build' : null;
      case 'verifying': return t.candidate ? 'finish' : null;
      case 'ready_for_promotion': {
        const latest = t.review && t.review.latest;
        return a.release_mode === 'promote' && !t.release && t.candidate && !(latest && latest.reviewer && latest.reviewer.automated) ? 'release' : null;
      }
      default: return null;
    }
  }

  async function once() {
    await checkRole();
    state.update((s) => { s.last_poll_at = iso(clock()); s.desk = desk.origin; });
    const list = await desk.call('engineering_list_tasks', { status: WORKER_STATUSES, limit: 200 });
    if (list.paused) { log(`Engineering is paused on the desk${list.paused_reason ? ` (${list.paused_reason})` : ''}; nothing claimed.`); return { worked: false, paused: true }; }
    const now = clock();
    const cool = state.read().cooldown || {};
    const rows = (list.tasks || []).filter((x) => !x.unsupported && !x.lease_live && !(cool[x.task_id] && Date.parse(cool[x.task_id]) > now)).reverse();
    const left = budget().left;
    let waited = false;
    for (const row of rows) {
      const t = await desk.call('engineering_get_task', { task_id: row.task_id });
      const phase = phaseOf(t);
      if (!phase) continue;
      if ((phase === 'build' && left <= 0)) { waited = true; continue; }
      let claim;
      try {
        claim = await desk.call('engineering_claim_task', { task_id: t.task_id });
      } catch (e) {
        if (e instanceof DeskError && ['CLAIMED', 'NOT_CLAIMABLE', 'DEPENDENCY', 'NOT_AUTHORIZED'].includes(e.code)) { log(`${t.task_id}: not claimed (${e.code})`); continue; }
        throw e;
      }
      // The task as the claim shows it: another runner may have moved it on
      // between the read and the claim.
      const fresh = claim.task || t;
      const step = phaseOf({ ...fresh, lease: null });
      if (!step) {
        await desk.call('engineering_record_event', { task_id: t.task_id, claim_token: claim.claim_token, type: 'stopped', reason: `${fresh.status}: nothing for the worker daemon to do now` }).catch(() => {});
        continue;
      }
      const r = await runPhase(step, fresh, claim);
      return { worked: true, task_id: t.task_id, phase: step, outcome: r.outcome, receipt: r.file };
    }
    if (waited) log(`A build waits for the hourly budget (${cfg.budget} an hour; next at ${budget().next_free_at}).`);
    return { worked: false, budget_waits: waited };
  }

  async function run({ signal = null } = {}) {
    const unlock = takeLock(home);
    log(`Worker daemon started (pid ${process.pid}) for ${desk.origin}; a pass every ${Math.round(cfg.pollMs / 1000)} s.`);
    try {
      while (!(signal && signal.aborted)) {
        let next = cfg.pollMs;
        try {
          const r = await once();
          state.update((s) => { s.backoff_ms = 0; s.last_error = null; });
          if (r.worked) next = Math.min(cfg.pollMs, 1000);
        } catch (e) {
          if (e instanceof DeskError && ['LOGIN_NEEDED', 'LOCKED'].includes(e.code)) throw e;
          const prev = state.read().backoff_ms || 0;
          next = Math.min(cfg.maxBackoffMs, prev ? prev * 2 : cfg.pollMs * 2);
          state.update((s) => { s.backoff_ms = next; s.last_error = { at: iso(clock()), message: String(e.message).slice(0, 300) }; });
          log(`The pass failed (${String(e.message).slice(0, 200)}); next try in ${Math.round(next / 1000)} s.`);
        }
        await wait(next, signal);
      }
    } finally {
      unlock();
      log('Worker daemon stopped.');
    }
  }

  function status() {
    const s = state.read();
    const lock = readLock(home);
    const dir = path.join(home, 'receipts');
    const receipts = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().slice(-10).reverse().map((f) => {
      try { const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return { task_id: r.task_id, number: r.number, phase: r.phase, outcome: r.outcome, reason: r.reason || null, head_sha: r.head_sha || null, started_at: r.started_at, ended_at: r.ended_at, file: path.join(dir, f) }; } catch (_) { return { file: path.join(dir, f), unreadable: true }; }
    }) : [];
    return { home, running: Boolean(lock && pidAlive(lock.pid)), pid: lock && pidAlive(lock.pid) ? lock.pid : null, since: lock && pidAlive(lock.pid) ? lock.started_at : null, sign_in: desk.signIn(), templates: cfg.templates, budget: budget(), last_poll_at: s.last_poll_at || null, backoff_ms: s.backoff_ms || 0, last_error: s.last_error || null, current: s.current || null, last_outcome: s.last_outcome || null, waits: s.cooldown || {}, receipts };
  }

  return { once, run, status, reset, budget, phaseOf, outOfBounds, ensureRepo, home, repo, config: cfg };
}

// --- the command line --------------------------------------------------------------------

const arg = (argv, name, fallback = undefined) => { const i = argv.indexOf(`--${name}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback; };
function configFromEnv(env = process.env) {
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
  const c = { pollMs: n(env.CR_DAEMON_POLL_MS), claudeTimeoutMs: n(env.CR_DAEMON_CLAUDE_TIMEOUT_MS), budget: n(env.CR_DAEMON_BUDGET), templates: env.CR_DAEMON_TEMPLATES ? env.CR_DAEMON_TEMPLATES.split(',').map((s) => s.trim()).filter(Boolean) : undefined };
  return Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined));
}
// What the daemon's children (the suite on a candidate, Git) never inherit:
// only its own settings and the lane's Git timings stay.
function scrubEnv(env = process.env) {
  for (const k of Object.keys(env)) if (C.DROPPED_ENV.test(k) && !/^CR_(DAEMON_|DESK_URL$|ENG_(RETRY_DELAYS_MS|GIT_TIMEOUT_MS)$)/.test(k)) delete env[k];
  return env;
}

async function main(argv) {
  const cmd = argv[0] || 'run';
  const home = arg(argv, 'home') || defaultHome();
  const desk = makeDesk({ desk: arg(argv, 'desk') || process.env.CR_DESK_URL || DEFAULT_DESK, home });
  const d = makeDaemon({ home, desk, config: configFromEnv() });
  const print = (o) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);
  switch (cmd) {
    case 'login': {
      await desk.login({ say: (l) => process.stdout.write(`${l}\n`) });
      const caps = await desk.call('engineering_capabilities', {});
      print({ signed_in: true, desk: desk.origin, role: caps.role, token_file: desk.tokenFile, says: caps.role === 'worker' ? 'The worker daemon is connected. Start it with npm run worker:daemon.' : `This connection has the ${caps.role} role; run npm run worker:login again and choose Worker.` });
      return caps.role === 'worker' ? 0 : 1;
    }
    case 'run': {
      scrubEnv();
      const ctl = new AbortController();
      for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => ctl.abort());
      await d.run({ signal: ctl.signal });
      return 0;
    }
    case 'once': {
      scrubEnv();
      const unlock = takeLock(home);
      try { print(await d.once()); } finally { unlock(); }
      return 0;
    }
    case 'status': print(d.status()); return 0;
    case 'reset': print({ reset: true, budget: d.reset() }); return 0;
    case 'print-command': {
      const c = C.claudeCommand({ home });
      print({ bin: c.bin, args: c.args, prompt: 'on stdin: the task as data between nonce lines, the rules and the answer format (engineering-daemon-claude.js buildPrompt)', cwd: d.repo, env_dropped: String(C.DROPPED_ENV), timeout_ms: d.config.claudeTimeoutMs });
      return 0;
    }
    default:
      process.stderr.write('Commands: login, run, once, status, reset, print-command.\n');
      return 2;
  }
}

if (require.main === module) {
  // 3: it needs Eric (a sign-in, or another daemon on this home), so a
  // service manager does not restart it.
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { process.stderr.write(`${e.message}\n`); process.exit(e && ['LOGIN_NEEDED', 'LOCKED'].includes(e.code) ? 3 : 1); });
}

module.exports = { makeDaemon, takeLock, readLock, configFromEnv, scrubEnv, runWorker, changedPaths, Halt, main, PROTECTED_RULE, DEFAULTS, MAX_BUDGET };
