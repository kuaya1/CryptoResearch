'use strict';
// The online pilot worker's control surface (cr-pilot-worker@1, corrective
// PR 2026-10-31). The runner on Eric's PC (scripts/pilot.js --desk=online)
// takes the online desk's own claim on a project's next step, has the desk
// open the run or ticket and hand back its frozen prompt, runs that prompt in
// a `claude -p` session with web tools only, and gives the session's answer
// back to the desk to save and verify. Every route here is POST with
// "Authorization: Bearer <worker token>"; the desk holds only the token's
// SHA-256 (hex), in its environment as CR_PILOT_WORKER_TOKEN_SHA256, read per
// request; without it the routes are not there (404). It is a separate token
// from the poll's (pilot-poll.js), which stays read-only.
//
//   claim     cr-pilot-claim@1 on the desk's next step (pilot-claims.js):
//             automation not paused, no live claim, no expired dispatch of
//             the same step, the daily session ceiling not reached. The
//             claim's token is returned to the claimant only.
//   prepare   under the claim: the step is read again; the desk opens the
//             research run (Claude, assistant mode: no paid API is asked) or
//             the Prosecutor's ticket, binds it to the claim (which reserves
//             the day's session first) and returns the exact frozen prompt
//             with its SHA-256. A gate_closed step saves the desk's own gate
//             receipt and starts no session. A claim already prepared is
//             never prepared again: its outcome is unknown. One locked
//             transition (claimed → preparing, pilot-claims.js
//             beginPreparation) picks the one request that prepares an
//             attempt; an overlapping or later one gets already_prepared, no
//             prompt, and changes nothing. After the exit quote's network
//             wait, the claim is read again and the bind checks the token,
//             the state, the expiry, the pause and the day's ceiling at the
//             time of the bind (the route's clock), not of the request.
//   complete  the session's answer, for the prompt it answered (SHA-256): the
//             desk saves it through the same paths a local import uses
//             (inbox.importContent, tickets.saveTicket), verifies that the
//             report completed the run's job or that the receipt reads back,
//             and only then releases the claim. A save the desk refused is a
//             known outcome (the text is kept: the inbox file, or the
//             ticket's draft) and releases it; anything else leaves the
//             claim dispatched for Eric to reconcile. Eric's stop on the
//             project (mandate-authority.js automationGate) since the
//             dispatch saves nothing: the claim is let go as
//             autonomy_stopped and the answer is "stopped", never "saved".
//             A stop before the bind hands out no prompt (prepare answers
//             "stopped").
//   release   by the claim's token, before a session started ("stopped") or
//             after one that failed and could save nothing ("agent_failed").
//             Releasing as reconciled is Eric's, signed in (server.js).
//   poll      the unattended runner's production poll (blueprint 2026-11-02
//             row 6): the same snapshot GET /api/pilot/queue answers, and,
//             only after it was computed, the sighting record
//             (pilot-sighting.js: the desk's clock, the runner's ID, the
//             invocation's ID and its declared agent cap). A snapshot that
//             fails writes nothing; a time in the body is never read.
//
// What the worker token can never do: decide a ticket, arm or change the
// mandate or any setting, force a Prosecutor, release as reconciled, or reach
// any route but these five. The Researcher's and the Prosecutor's sessions
// never hold it (scripts/pilot.js keeps it in the runner).

const crypto = require('crypto');
const { OpError } = require('./ops');
const claims = require('./pilot-claims');
const { hourBucket, bearerMatches, pollBody } = require('./pilot-poll');
const sighting = require('./pilot-sighting');

const FORMAT = 'cr-pilot-worker@1';
const LIMIT_PER_HOUR = 240;
const REFUSED_PER_HOUR = 60;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const PID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OWNER_RE = /^[A-Za-z0-9 ._:@-]{1,80}$/;
const WORKER_OUTCOMES = new Set(['stopped', 'agent_failed']);
// A save the desk refused (inbox statuses that are not a saved report).
const SAVED_IMPORT = new Set(['ingested', 'duplicate']);

const sha256 = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');

function expectedDigest(env = process.env) {
  const h = String(env.CR_PILOT_WORKER_TOKEN_SHA256 || '').trim().toLowerCase();
  return HEX64.test(h) ? Buffer.from(h, 'hex') : null;
}

const idsOf = (c) => ({ attempt_id: c ? c.attempt_id : null, key: c ? c.key : null, run_id: c ? c.run_id || null : null, ticket_id: c ? c.ticket_id || null : null });

function pidOf(v) {
  if (typeof v !== 'string' || !PID_RE.test(v)) throw new OpError('BAD_ID', 'project_id is not a project ID.');
  return v;
}

// claim: the token goes to the claimant only; another runner's claim is
// named by its key and expiry, never its token.
function claimStep(ws, pid, { owner, expect = null, now = Date.now() } = {}) {
  if (typeof owner !== 'string' || !OWNER_RE.test(owner)) throw new OpError('INVALID', 'owner names the runner (letters, digits, space, . _ : @ -; at most 80).');
  const r = claims.claim(ws, pid, { owner: `worker ${owner}`, expect, now, force: false });
  const mine = r.status === 'claimed_now';
  return {
    format: FORMAT,
    status: r.status,
    project_id: pid,
    step: r.step ? r.step.step : null,
    key: r.key || null,
    token: mine ? r.token : null,
    attempt_id: mine ? r.claim.attempt_id : null,
    expires_at: mine ? r.claim.expires_at : r.claim ? r.claim.expires_at : null,
    words: r.words || null,
  };
}

// Let a claim go with the token, recording why; quietly when it is gone.
function letGo(ws, pid, token, outcome, now) {
  try { return claims.release(ws, pid, { token, outcome, now }); } catch (_) { return null; }
}

// A prepare that does not authorize a session: the attempt is being, or was,
// prepared by another request. Nothing is written; no prompt is given.
function alreadyPrepared(pid, cur) {
  const words = cur.state === 'preparing'
    ? `Attempt ${cur.attempt_id} is being prepared by another request (since ${cur.preparing_at}). This request authorizes no session and changed nothing.`
    : `Attempt ${cur.attempt_id} was already prepared (${cur.run_id || cur.ticket_id || 'no record'}). Its session's outcome is unknown, so nothing is handed out twice: complete it, or after it expires Eric reconciles it.`;
  return { format: FORMAT, status: 'already_prepared', state: cur.state, project_id: pid, ...idsOf(cur), words };
}

// The locked bind that authorizes the one session, at the time it happens.
// A claim another request bound in the meantime is not handed out again.
function finalize(ws, pid, token, args) {
  try {
    return claims.bind(ws, pid, token, { ...args, from: 'preparing' });
  } catch (err) {
    if (err && err.code === 'ALREADY_BOUND') return { already: alreadyPrepared(pid, claims.held(ws, pid, token)) };
    // Eric stopped the project before the bind: bind let the claim go.
    if (err && err.code === 'STOPPED') return { stopped: stoppedAnswer(pid, (err.details && err.details.claim) || null, err.message) };
    throw err;
  }
}

// A prepare or complete the desk's gate stopped (mandate-authority.js
// automationGate): no prompt is handed out, nothing is saved.
function stoppedAnswer(pid, c, words) {
  return { format: FORMAT, status: 'stopped', project_id: pid, ...idsOf(c), session: Boolean(c && c.stopped && c.stopped.session_dispatched), saved: false, outcome: claims.STOPPED, words };
}

// Before a preparation opens anything: the claim is read again
// (assertPreparing). Eric's stop since the claim lets it go as stopped and
// answers stopped (nothing opened, no prompt); null when it may go on. The
// bind still decides.
function stillPreparing(ws, pid, token, t) {
  try {
    claims.assertPreparing(ws, pid, token, { now: t });
    return null;
  } catch (err) {
    if (!err || err.code !== 'STOPPED') throw err;
    const s = claims.stopIfHalted(ws, pid, token, { now: t });
    if (s.status === 'stopped') return stoppedAnswer(pid, s.claim, s.words);
    throw err;
  }
}

// `clock` gives the time of each step (the route passes its own); a fixed
// `now` is used for every step when no clock is given.
async function prepare(ws, pid, token, { now, clock = null, fetchImpl } = {}) {
  const tk = require('./tickets');
  const at = typeof clock === 'function' ? clock : now !== undefined ? () => now : () => Date.now();
  // One locked transition decides which request prepares this attempt.
  const begun = claims.beginPreparation(ws, pid, token, { now: at() });
  if (begun.status === 'already') return alreadyPrepared(pid, begun.claim);
  if (begun.status === 'stopped') return stoppedAnswer(pid, begun.claim, begun.words);
  const cur = begun.claim;
  const step = begun.step;
  if (begun.status === 'changed') {
    return { format: FORMAT, status: 'changed', project_id: pid, ...idsOf(cur), words: `The desk's next step is now ${step ? claims.transitionKey(step) : 'none'}, not ${cur.key}; the claim was let go and nothing was prepared.` };
  }
  const utterance = 'autonomous pilot (online worker)';
  if (step.step === 'gate_closed') {
    const g = tk.createTicket(ws, { project_id: pid, channel: 'pilot worker', assistant: false, mode: 'worker', utterance });
    letGo(ws, pid, token, g.status === 'gate_closed' ? 'done' : 'not_started', at());
    return { format: FORMAT, status: g.status === 'gate_closed' ? 'gate_closed' : 'not_started', project_id: pid, ...idsOf(cur), receipt_id: g.receipt_id || null, session: false, words: g.message || null };
  }
  if (step.step === 'research') {
    const research = require('./research');
    let runId = step.run_id || null;
    const halted = stillPreparing(ws, pid, token, at());
    if (halted) return halted;
    if (!runId) {
      const r = research.createRun(ws, { project_id: pid, providers: 'claude', channel: 'pilot worker (cowork)', assistant: 'claude', utterance });
      runId = r.run_id || null;
      if (!runId) {
        letGo(ws, pid, token, 'not_started', at());
        return { format: FORMAT, status: 'not_started', project_id: pid, ...idsOf(cur), words: r.message || 'No research run was opened.' };
      }
    }
    const run = research.loadRun(ws, pid, runId);
    if (!run || !run.prompt || !run.prompt.path) {
      letGo(ws, pid, token, 'not_started', at());
      throw new OpError('INTEGRITY', `Research run ${runId} has no frozen prompt on the desk; nothing was prepared.`);
    }
    const text = require('fs').readFileSync(ws.abs(run.prompt.path), 'utf8');
    if (sha256(text) !== run.prompt.sha256) {
      letGo(ws, pid, token, 'not_started', at());
      throw new OpError('INTEGRITY', `Research run ${runId}'s frozen prompt no longer matches its SHA-256; nothing was prepared.`);
    }
    const b = finalize(ws, pid, token, { run_id: runId, now: at(), extra: { role: 'researcher', prompt_sha256: run.prompt.sha256 } });
    if (b.already) return b.already;
    if (b.stopped) return b.stopped;
    return { format: FORMAT, status: 'prepared', role: 'researcher', project_id: pid, ...idsOf(b.claim), prompt: text, prompt_sha256: run.prompt.sha256, prompt_version: run.prompt.version || null, sessions: b.sessions };
  }
  if (step.step === 'ticket' || step.step === 'ticket_failed') {
    // A quote that throws is kept as the reason (the packet's
    // exit_quote_attempt), never dropped as "no attempt".
    const exit_quote = await tk.prepareExitQuote(ws, pid, { fetchImpl }).catch((err) => ({ size_usd: null, status: 'error', reason: `The exit quote could not be asked: ${String((err && err.message) || err).slice(0, 200)}`, asked_at: new Date(at()).toISOString() }));
    // The quote took time: the claim is read again, at the time now, before
    // anything is opened. The bind below is what decides.
    const halted = stillPreparing(ws, pid, token, at());
    if (halted) return halted;
    const t = tk.createTicket(ws, { exit_quote, project_id: pid, channel: 'pilot worker', assistant: true, mode: 'worker', utterance, reopen: Boolean(step.refresh) });
    if (!t.ticket_id) {
      letGo(ws, pid, token, t.status === 'gate_closed' ? 'done' : 'not_started', at());
      return { format: FORMAT, status: t.status === 'gate_closed' ? 'gate_closed' : 'not_started', project_id: pid, ...idsOf(cur), receipt_id: t.receipt_id || null, session: false, words: t.message || null };
    }
    const ticket = tk.loadTicket(ws, pid, t.ticket_id);
    const p = ticket ? tk.promptFor(ws, ticket) : { text: null, error: `No ticket ${t.ticket_id}.` };
    if (!p.text) {
      letGo(ws, pid, token, 'not_started', at());
      throw new OpError('INTEGRITY', `${p.error} Nothing was prepared.`);
    }
    const b = finalize(ws, pid, token, { ticket_id: t.ticket_id, now: at(), extra: { role: 'prosecutor', prompt_sha256: p.sha256 } });
    if (b.already) return b.already;
    if (b.stopped) return b.stopped;
    return { format: FORMAT, status: 'prepared', role: 'prosecutor', project_id: pid, ...idsOf(b.claim), prompt: p.text, prompt_sha256: p.sha256, prompt_version: p.version || null, sessions: b.sessions };
  }
  letGo(ws, pid, token, 'nothing', at());
  return { format: FORMAT, status: 'nothing', project_id: pid, ...idsOf(cur), words: step.why || 'Nothing for an agent to do.' };
}

// The words for a dispatch whose outcome the desk cannot settle by itself.
const reconcileWords = (pid) => `Its outcome is not settled, so the claim stays dispatched and nothing is run again. After it expires, check ${pid} on the online desk, then release it there as reconciled (signed in: POST /api/projects/${pid}/pilot-claim/release with {"reconciled":true}).`;

function complete(ws, pid, token, { text, prompt_sha256, now = Date.now() } = {}) {
  const cur = claims.held(ws, pid, token);
  if (cur.state !== 'dispatched' || !cur.role) throw new OpError('INVALID', `Attempt ${cur.attempt_id} was not prepared; there is nothing to complete.`);
  if (typeof prompt_sha256 !== 'string' || prompt_sha256 !== cur.prompt_sha256) throw new OpError('REFUSED', `The answer is for another prompt (${String(prompt_sha256).slice(0, 16)}…), not attempt ${cur.attempt_id}'s (${String(cur.prompt_sha256).slice(0, 16)}…); nothing was saved.`);
  if (typeof text !== 'string' || !text.trim()) throw new OpError('INVALID', 'The session gave no text; nothing was saved.');
  // Eric stopped the project while the session ran: its answer is not saved
  // and the attempt is let go as stopped, never as saved.
  const chk = claims.stopIfHalted(ws, pid, token, { now });
  if (chk.status === 'stopped') return { ...stoppedAnswer(pid, chk.claim, chk.words), role: cur.role };
  const base = { format: FORMAT, project_id: pid, ...idsOf(cur), role: cur.role };
  if (cur.role === 'researcher') {
    const research = require('./research');
    const r = (require('./inbox').importContent(ws, 'claude', { content: text, filename: `${pid}__${cur.run_id}_claude_worker.md`, projectId: pid, runId: cur.run_id, channel: 'pilot worker' }) || {}).result || {};
    if (!SAVED_IMPORT.has(r.status)) {
      letGo(ws, pid, token, 'save_refused', now);
      return { ...base, status: 'refused', inbox_key: r.key || null, words: `The desk refused the report (${r.status}): ${r.message || 'no reason given'}. The text is kept in the inbox${r.key ? ` (${r.key})` : ''}; the claim was let go.` };
    }
    const run = research.loadRun(ws, pid, cur.run_id);
    const job = run && run.jobs ? run.jobs.claude : null;
    if (r.verified === false || !job || job.state !== 'completed' || job.report_id !== r.report_id) {
      return { ...base, status: 'unverified', report_id: r.report_id || null, words: `Report ${r.report_id || '?'} was saved but did not ${r.verified === false ? 'read back as written' : `complete research run ${cur.run_id}'s Claude job`}. ${reconcileWords(pid)}` };
    }
    claims.release(ws, pid, { token, outcome: 'saved', now });
    return { ...base, status: 'saved', report_id: r.report_id, verified: true };
  }
  const tk = require('./tickets');
  let r;
  try {
    r = tk.saveTicket(ws, { project_id: pid, ticket_id: cur.ticket_id, text, channel: 'pilot worker' });
  } catch (err) {
    if (['INVALID', 'CONFLICT'].includes(err.code)) {
      letGo(ws, pid, token, 'save_refused', now);
      return { ...base, status: 'refused', words: `The desk refused the ticket: ${String(err.message).slice(0, 400)} The text is kept as the ticket's draft; the claim was let go.` };
    }
    throw err;
  }
  const back = r && r.receipt_id ? tk.listReceipts(ws, pid).find((x) => x.receipt_id === r.receipt_id && !x.broken) : null;
  if (!r || r.status !== 'saved' || r.verified === false || !back) {
    return { ...base, status: 'unverified', receipt_id: (r && r.receipt_id) || null, words: `The ticket's receipt ${(r && r.receipt_id) || '?'} did not read back as saved. ${reconcileWords(pid)}` };
  }
  claims.release(ws, pid, { token, outcome: 'saved', now });
  // A Prosecutor's as_of the desk clamped to the save (tickets.js
  // AS_OF_AHEAD_MS) is said back, so the runner's log shows it.
  const clamped = r.receipt && r.receipt.as_of_clamped;
  return { ...base, status: 'saved', receipt_id: r.receipt_id, verified: true, ...(clamped ? { words: `as_of ${clamped.written} was after the save; recorded as ${clamped.recorded}.` } : {}) };
}

// The production poll: the snapshot first, then the sighting. Invalid fields
// are refused before anything is read or written.
function pollStep(ws, body, { now = Date.now() } = {}) {
  const f = sighting.fieldsOf(body);
  if (!f.runner_id || !f.invocation_id || f.max_agents === null) throw new OpError('INVALID', 'poll names runner_id (letters, digits, space, . _ : @ -; at most 80), invocation_id (8 to 64 letters, digits or -) and max_agents (0 to 10).');
  const poll = pollBody(ws, now);
  const rec = sighting.record(ws, f, { now });
  return { format: FORMAT, status: 'polled', poll, sighting: rec };
}

function releaseByWorker(ws, pid, token, { outcome, now = Date.now() } = {}) {
  if (!WORKER_OUTCOMES.has(outcome)) throw new OpError('INVALID', `outcome is ${[...WORKER_OUTCOMES].join(' or ')}.`);
  const cur = claims.held(ws, pid, token);
  if (outcome === 'stopped' && cur.state === 'dispatched') throw new OpError('INVALID', 'A session was prepared on this claim; "stopped" applies only before one starts.');
  const r = claims.release(ws, pid, { token, outcome, now });
  return { format: FORMAT, status: r.status, project_id: pid, ...idsOf(r.claim), outcome };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new OpError('INVALID', `The request is larger than ${MAX_BODY_BYTES} bytes.`), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (_) { reject(new OpError('INVALID', 'The body is not JSON.')); }
    });
    req.on('error', reject);
  });
}

const STATUS_OF_CODE = { NOT_FOUND: 404, BAD_ID: 400, INVALID: 400, REFUSED: 409, CHANGED: 409, PAUSED: 409, STOPPED: 409, SESSION_CEILING: 409, ALREADY_BOUND: 409, UNREADABLE: 503, INTEGRITY: 409, WORKSPACE_BUSY: 503, WRITES_BLOCKED: 503 };

function makePilotWorkerRoute(ws, { env = process.env, log = () => {}, now = () => Date.now(), fetchImpl, onWrite = () => {} } = {}) {
  const calls = hourBucket(LIMIT_PER_HOUR);
  const refusals = hourBucket(REFUSED_PER_HOUR);
  const send = (res, status, body, extra = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify(body));
  };
  return async function handle(req, res, url) {
    const want = expectedDigest(env);
    if (!want) return send(res, 404, { error: 'Unknown API route' });
    const op = url.pathname.slice('/api/pilot/worker/'.length);
    if (!['claim', 'prepare', 'complete', 'release', 'poll'].includes(op)) return send(res, 404, { error: 'Unknown API route' });
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    const t = now();
    if (!bearerMatches(req, want)) {
      const wait = refusals.take(t);
      if (wait) return send(res, 429, { error: `Too many refused requests; try again in ${wait} s.`, code: 'RATE_LIMITED' }, { 'Retry-After': String(wait) });
      log('Pilot worker refused: wrong or missing bearer.');
      return send(res, 401, { error: 'The worker token was refused.', code: 'REFUSED' });
    }
    const wait = calls.take(t);
    if (wait) return send(res, 429, { error: `At most ${LIMIT_PER_HOUR} worker requests an hour; try again in ${wait} s.`, code: 'RATE_LIMITED' }, { 'Retry-After': String(wait) });
    try {
      const body = await readBody(req);
      if (op === 'poll') return send(res, 200, pollStep(ws, body, { now: t }));
      const pid = pidOf(body.project_id);
      let out;
      if (op === 'claim') out = claimStep(ws, pid, { owner: body.owner, expect: typeof body.expect === 'string' ? body.expect : null, now: t });
      else {
        const token = typeof body.token === 'string' && /^[0-9a-f]{20}$/.test(body.token) ? body.token : null;
        if (!token) throw new OpError('INVALID', 'token is the claim\'s token.');
        if (op === 'prepare') out = await prepare(ws, pid, token, { clock: now, fetchImpl });
        else if (op === 'complete') out = complete(ws, pid, token, { text: body.text, prompt_sha256: body.prompt_sha256, now: t });
        else out = releaseByWorker(ws, pid, token, { outcome: body.outcome, now: t });
      }
      if (op !== 'claim') { try { onWrite(pid); } catch (_) { /* the index catches up */ } }
      return send(res, 200, out);
    } catch (err) {
      const status = err.status || STATUS_OF_CODE[err.code] || 500;
      if (status >= 500) log(`Pilot worker ${op} failed: ${String(err && err.message || err).slice(0, 200)}`);
      return send(res, status, { format: FORMAT, error: status >= 500 && !STATUS_OF_CODE[err.code] ? 'The desk could not do that now; the claim is as it was.' : err.message, code: err.code || null });
    }
  };
}

module.exports = { FORMAT, LIMIT_PER_HOUR, REFUSED_PER_HOUR, expectedDigest, claimStep, prepare, complete, releaseByWorker, pollStep, makePilotWorkerRoute };
