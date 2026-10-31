'use strict';
// One execution claim per project for the pilot runner (cr-pilot-claim@1,
// subtraction stage 5.4). Two runners started together dispatch at most one
// agent for the same step:
//
//   claim    inside the workspace lock: automation not paused, the project's
//            next step read again from the desk (pilotQueue), and no live
//            claim on it. The claim names a stable transition key (the step
//            and the run, ticket or report it acts on).
//   bind     before the agent runs, the run or ticket it works on is written
//            durably to the claim (state "dispatched").
//   release  after the agent's save (or when it stopped), the claim is let go.
//
// An expired claim that was dispatched on the same step is never dispatched
// again by itself: its outcome is unknown (the agent may still be running, or
// saved nothing), so it waits for the desk to move on to another step or for
// Eric to release it as reconciled. The step is compared, not the key: binding
// the run or ticket changes the desk's key (research:- becomes research:run_…),
// and that is the same attempt, so it keeps its attempt ID and its first key. A refused Prosecutor save (ticket_failed) gets at most one
// correction run per ticket; after that the step stays ticket_failed for Eric.
// The records live under .cr/pilot-claims/ (runner state, not research
// records); nothing here asks a provider or writes a ticket.
//
// The daily session ceiling (cr-pilot-session@1, corrective PR 2026-10-31):
// every agent session is reserved in .cr/pilot-sessions.jsonl when its claim
// is bound, before the session starts, so a session that fails, times out or
// never answers is counted all the same. The day is New York's; the ceiling
// is settings automation.pilot_daily_sessions (default 6). No run, restart or
// new lock file resets it: the count is read from the ledger each time, and a
// ledger that does not read stops every new session (unknown is never zero).
// claim() refuses a step that needs a session when none is left today;
// bind() is what reserves one.

const crypto = require('crypto');
const fs = require('fs');
const { withLock, OpError } = require('./ops');
const { readJson, atomicWrite, mkdirp } = require('./fsx');
const { ymdInTz } = require('./dates');
const path = require('path');

const VERSION = 'cr-pilot-claim@1';
const TTL_MS = 90 * 60000;
const MAX_CORRECTIONS = 1;
const DISPATCH = new Set(['research', 'ticket', 'ticket_failed', 'gate_closed']);
// The steps whose dispatch starts an agent session (gate_closed starts none).
const SESSION_STEPS = new Set(['research', 'ticket', 'ticket_failed', 'pm_review']);
const SESSION_FORMAT = 'cr-pilot-session@1';
const SESSIONS_REL = '.cr/pilot-sessions.jsonl';
const DAILY_SESSIONS_DEFAULT = 6;
const DAILY_SESSIONS_MAX = 50;

function dailyCeiling(ws) {
  const v = ws.settings && ws.settings.automation ? ws.settings.automation.pilot_daily_sessions : undefined;
  return Number.isInteger(v) && v >= 0 && v <= DAILY_SESSIONS_MAX ? v : DAILY_SESSIONS_DEFAULT;
}

// Today's reserved sessions, read strictly: a line that is not a session
// record makes the count unknown and throws UNREADABLE.
function sessionsToday(ws, now = Date.now()) {
  const day = ymdInTz(new Date(now));
  let text = '';
  try { text = fs.readFileSync(ws.abs(SESSIONS_REL), 'utf8'); } catch (err) {
    if (!err || err.code !== 'ENOENT') throw new OpError('UNREADABLE', `The pilot's session ledger (${SESSIONS_REL}) could not be read (${(err && err.code) || 'error'}), so how many sessions ran today is unknown; no session is started until it is repaired.`);
  }
  const lines = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    let r = null;
    try { r = JSON.parse(line); } catch (_) { r = null; }
    if (!r || typeof r !== 'object' || r.format !== SESSION_FORMAT || typeof r.day !== 'string' || typeof r.attempt_id !== 'string') {
      throw new OpError('UNREADABLE', `Line ${i + 1} of the pilot's session ledger (${SESSIONS_REL}) is not a session record, so how many sessions ran today is unknown; no session is started until it is repaired (the file is kept as it is).`);
    }
    lines.push(r);
  });
  const mine = lines.filter((r) => r.day === day);
  const ceiling = dailyCeiling(ws);
  return { day, used: mine.length, ceiling, left: Math.max(0, ceiling - mine.length), attempts: new Set(mine.map((r) => r.attempt_id)), all_attempts: new Set(lines.map((r) => r.attempt_id)) };
}
const ceilingWords = (s) => `Today's ${s.ceiling} agent session${s.ceiling === 1 ? ' is' : 's are'} used (${s.used} reserved on ${s.day}, New York, failed ones included); no session is started until tomorrow or until you raise automation.pilot_daily_sessions.`;

// Read-only, for the poll and the queue: today's count, or why it is unknown.
function sessionsView(ws, now = Date.now()) {
  try {
    const s = sessionsToday(ws, now);
    return { day: s.day, used: s.used, ceiling: s.ceiling, left: s.left, unreadable: false };
  } catch (err) {
    return { day: ymdInTz(new Date(now)), used: null, ceiling: dailyCeiling(ws), left: 0, unreadable: true };
  }
}

const claimAbs = (ws, pid) => {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(pid))) throw new OpError('BAD_ID', `"${pid}" is not a project ID.`);
  return ws.abs(`.cr/pilot-claims/${pid}.json`);
};
const read = (ws, pid) => readJson(claimAbs(ws, pid), null);
const write = (ws, pid, rec) => {
  const abs = claimAbs(ws, pid);
  mkdirp(path.dirname(abs));
  atomicWrite(abs, `${JSON.stringify(rec, null, 2)}\n`);
};

// The stable key of one transition: the step and the record it acts on.
function transitionKey(step) {
  return `${step.step}:${step.run_id || step.ticket_id || step.report_id || step.receipt_id || '-'}`;
}

// The desk still shows the step an expired dispatch acted on: the same key, the
// key it was bound under, or the same step whatever record the key now names.
// A forced prosecution claimed on pm_review dispatches a Prosecutor: its ticket
// waiting on the desk is the same attempt.
const dispatchedAs = (s) => (s === 'pm_review' ? 'ticket' : s);
function sameAttempt(cur, step, key) {
  return cur.key === key || cur.bound_key === key || dispatchedAs(cur.step) === dispatchedAs(step.step);
}

function claim(ws, pid, { owner = null, now = Date.now(), ttlMs = TTL_MS, expect = null, force = false } = {}) {
  return withLock(ws, `pilot claim ${pid}`, () => {
    if (require('./workspace').automationPaused(ws)) return { status: 'paused', words: 'Automation is paused: no agent is dispatched until you resume it.' };
    const step = require('./tickets').pilotQueue(ws, { project: pid, now })[0];
    if (!step) throw new OpError('NOT_FOUND', `No project ${pid} on this desk.`);
    const key = transitionKey(step);
    if (expect && expect !== key) return { status: 'changed', key, step, words: `The desk's next step is now ${key}, not ${expect}.` };
    // Eric's override (--force-prosecution) may turn a desk gate waiting for him into a Prosecutor.
    if (!DISPATCH.has(step.step) && !(force && step.step === 'pm_review')) return { status: 'nothing', key, step, words: step.why || 'Nothing for an agent to do.' };
    const cur = read(ws, pid);
    const corrections = (cur && cur.corrections) || {};
    if (cur && !cur.released) {
      if (Date.parse(cur.expires_at) > now) return { status: 'claimed', key, step, claim: cur, words: `Another runner holds this project (${cur.key}) until ${cur.expires_at}.` };
      if (cur.state === 'dispatched' && sameAttempt(cur, step, key)) return { status: 'reconcile', key, step, claim: cur, words: `An earlier dispatch of ${cur.key} (${cur.run_id || cur.ticket_id || 'no record'}) expired with no known outcome. It is not dispatched again; check the desk, then release it as reconciled.` };
    }
    if (step.step === 'ticket_failed' && step.ticket_id && (corrections[step.ticket_id] || 0) >= MAX_CORRECTIONS) {
      return { status: 'correction_limit', key, step, words: `The Prosecutor's save on ${step.ticket_id} was refused again after ${MAX_CORRECTIONS} correction. It waits for you.` };
    }
    if (SESSION_STEPS.has(step.step)) {
      let s;
      try { s = sessionsToday(ws, now); } catch (err) { return { status: 'sessions_unknown', key, step, words: err.message }; }
      if (s.left <= 0) return { status: 'session_ceiling', key, step, words: ceilingWords(s) };
    }
    const at = new Date(now).toISOString();
    const rec = {
      schema_version: VERSION,
      project_id: pid,
      key,
      step: step.step,
      attempt_id: `pa_${crypto.randomBytes(8).toString('hex')}`,
      token: crypto.randomBytes(10).toString('hex'),
      owner,
      claimed_at: at,
      expires_at: new Date(now + ttlMs).toISOString(),
      state: 'claimed',
      run_id: step.run_id || null,
      ticket_id: step.ticket_id || null,
      released: false,
      // A correction is counted when it is claimed, before it runs, so a crash
      // in the middle never earns a second one.
      corrections: step.step === 'ticket_failed' && step.ticket_id ? { ...corrections, [step.ticket_id]: (corrections[step.ticket_id] || 0) + 1 } : corrections,
    };
    write(ws, pid, rec);
    return { status: 'claimed_now', key, step, token: rec.token, claim: rec };
  });
}

// Read-only: what the claim alone would stop now, without taking it. A live
// claim is 'claimed', an expired dispatch of this step 'reconcile', a used
// correction 'correction_limit'; null when nothing stops a claim. For the
// pre-poll (core/pilot-poll.js, tickets queue); claim() still decides.
function peek(ws, pid, step, now = Date.now()) {
  let cur = null;
  try { cur = read(ws, pid); } catch (_) { return null; }
  if (cur && !cur.released) {
    if (Date.parse(cur.expires_at) > now) return 'claimed';
    if (cur.state === 'dispatched' && sameAttempt(cur, step, transitionKey(step))) return 'reconcile';
  }
  if (step && step.step === 'ticket_failed' && step.ticket_id && cur && ((cur.corrections || {})[step.ticket_id] || 0) >= MAX_CORRECTIONS) return 'correction_limit';
  return null;
}

function held(ws, pid, token) {
  const cur = read(ws, pid);
  if (!cur || cur.released || cur.token !== token) throw new OpError('CHANGED', 'This runner no longer holds the claim; nothing was dispatched.');
  return cur;
}

// The run or ticket the agent will work on, written before it runs. Refused
// when the claim has expired (another runner may take it over) or automation
// was paused since the claim; nothing is dispatched then. The claim keeps its
// first key and attempt ID; the key under the bound record is kept beside it.
// Binding reserves the attempt's agent session in the ledger first (once per
// attempt): refused when today's ceiling is used or the ledger does not read.
// `extra` (role, prompt_sha256) is kept on the claim for the worker's
// complete step (pilot-worker.js).
function bind(ws, pid, token, { run_id = null, ticket_id = null, now = Date.now(), extra = null } = {}) {
  return withLock(ws, `pilot bind ${pid}`, () => {
    const cur = held(ws, pid, token);
    if (!(Date.parse(cur.expires_at) > now)) throw new OpError('CHANGED', `The claim expired at ${cur.expires_at}; nothing was dispatched.`);
    if (require('./workspace').automationPaused(ws)) throw new OpError('PAUSED', 'Automation was paused after the claim; nothing was dispatched.');
    const bound = { run_id: run_id || cur.run_id, ticket_id: ticket_id || cur.ticket_id };
    const s = sessionsToday(ws, now);
    if (!s.all_attempts.has(cur.attempt_id)) {
      if (s.left <= 0) throw new OpError('SESSION_CEILING', ceilingWords(s));
      const abs = ws.abs(SESSIONS_REL);
      mkdirp(path.dirname(abs));
      fs.appendFileSync(abs, `${JSON.stringify({ format: SESSION_FORMAT, day: s.day, at: new Date(now).toISOString(), project_id: pid, attempt_id: cur.attempt_id, step: cur.step, ...bound, owner: cur.owner || null })}\n`);
    }
    const rec = { ...cur, ...(extra || {}), state: 'dispatched', dispatched_at: new Date(now).toISOString(), ...bound, bound_key: transitionKey({ step: cur.step, ...bound }) };
    write(ws, pid, rec);
    return { status: 'bound', claim: rec, sessions: { day: s.day, used: s.all_attempts.has(cur.attempt_id) ? s.used : s.used + 1, ceiling: s.ceiling } };
  });
}

// Let the claim go: by its token after the agent's save, or by Eric as
// reconciled after an expired dispatch he checked.
function release(ws, pid, { token = null, reconciled = false, outcome = null, now = Date.now() } = {}) {
  return withLock(ws, `pilot release ${pid}`, () => {
    const cur = read(ws, pid);
    if (!cur || cur.released) return { status: 'unchanged', claim: cur };
    if (!reconciled) held(ws, pid, token);
    else if (Date.parse(cur.expires_at) > now) throw new OpError('INVALID', 'The claim is still live; a runner may be working. Release it as reconciled only after it expires.');
    const rec = { ...cur, released: true, released_at: new Date(now).toISOString(), outcome: reconciled ? 'reconciled' : outcome || 'done' };
    write(ws, pid, rec);
    return { status: 'released', claim: rec };
  });
}

module.exports = { VERSION, TTL_MS, MAX_CORRECTIONS, SESSION_FORMAT, SESSIONS_REL, DAILY_SESSIONS_DEFAULT, DAILY_SESSIONS_MAX, transitionKey, claim, bind, release, read, peek, held, dailyCeiling, sessionsToday, sessionsView };
