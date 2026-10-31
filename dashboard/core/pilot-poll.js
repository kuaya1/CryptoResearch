'use strict';
// The pilot runner's zero-token pre-poll of the online desk (autonomous paper
// playbook, Stage 11): GET /api/pilot/queue with "Authorization: Bearer
// <token>". The desk holds only the token's SHA-256 (hex), in its environment
// as CR_PILOT_POLL_TOKEN_SHA256, read per request; without it the route is
// not there (404). The bearer's SHA-256 is compared in constant time. Two
// allowances, held in memory: an accepted poll counts against 60 an hour, a
// refused bearer against its own 60 an hour, so a stranger's refused requests
// never use up the runner's polls (corrective PR, 2026-10-31).
// The front door answers it before, and apart from, the sign-in and the
// session token (frontdoor.js).
//
// Read-only. It says whether automation is paused and, for each pilot
// project, the next step by name with the IDs it acts on and the claim state
// that would stop a dispatch: no prompt, report text, settings or reasons.

const crypto = require('crypto');

const FORMAT = 'cr-pilot-poll@1';
const LIMIT_PER_HOUR = 60;
const HOUR = 3600000;
const HEX64 = /^[0-9a-f]{64}$/;

// The digest the desk expects, or null when the route is off.
function expectedDigest(env = process.env) {
  const h = String(env.CR_PILOT_POLL_TOKEN_SHA256 || '').trim().toLowerCase();
  return HEX64.test(h) ? Buffer.from(h, 'hex') : null;
}

// The body: names and IDs only.
function pollBody(ws, now = Date.now()) {
  const claims = require('./pilot-claims');
  const queue = require('./tickets').pilotQueue(ws, { now });
  const steps = queue.map((s) => ({
    project_id: s.project_id,
    step: s.step,
    ticket_id: s.ticket_id || null,
    run_id: s.run_id || null,
    receipt_id: s.receipt_id || null,
    claim: claims.peek(ws, s.project_id, s, now),
  }));
  const sessions = claims.sessionsView(ws, now);
  // Each project's next action, who takes it, whether it is blocked, the
  // mandate's authority, the claim and the IDs: codes and IDs, no words (the
  // signed-in desk and `tickets queue` give the words).
  const status = require('./mandate-authority').statusRows(ws, queue, { now, sessions }).map((r) => ({
    project_id: r.project_id,
    next_action: r.next_action,
    actor: r.actor,
    blocked: r.blocker !== null,
    authority: {
      mandate: { on: r.authority.mandate.on, generation: r.authority.mandate.generation },
      suspended: r.authority.autonomy.suspended,
      grant: r.authority.grant ? { decision_id: r.authority.grant.decision_id, generation: r.authority.grant.generation, authority: r.authority.grant.authority, phase: r.authority.grant.phase, order_state: r.authority.grant.order_state } : null,
    },
    claim: r.claim ? { state: r.claim.state, attempt_id: r.claim.attempt_id || null, role: r.claim.role || null, expires_at: r.claim.expires_at || null } : null,
    ids: r.ids,
  }));
  return { format: FORMAT, paused: require('./workspace').automationPaused(ws), sessions, steps, status };
}

// A sliding hour of hits: take() is false when the hour is full.
function hourBucket(limit) {
  const hits = [];
  return {
    take(t) {
      while (hits.length && t - hits[0] >= HOUR) hits.shift();
      if (hits.length >= limit) return Math.max(1, Math.ceil((hits[0] + HOUR - t) / 1000));
      hits.push(t);
      return 0;
    },
  };
}

// Whether a request's bearer hashes to `want` (constant time).
function bearerMatches(req, want) {
  const m = String(req.headers.authorization || '').match(/^Bearer (\S{16,512})$/);
  const got = m ? crypto.createHash('sha256').update(m[1], 'utf8').digest() : null;
  return Boolean(got && want && got.length === want.length && crypto.timingSafeEqual(got, want));
}

function makePilotPollRoute(ws, { env = process.env, log = () => {}, now = () => Date.now() } = {}) {
  const polls = hourBucket(LIMIT_PER_HOUR);
  const refusals = hourBucket(LIMIT_PER_HOUR);
  const send = (res, status, body, extra = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify(body));
  };
  return function handle(req, res) {
    const want = expectedDigest(env);
    if (!want) return send(res, 404, { error: 'Unknown API route' });
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
    const t = now();
    if (!bearerMatches(req, want)) {
      const wait = refusals.take(t);
      if (wait) return send(res, 429, { error: `Too many refused requests; try again in ${wait} s.`, code: 'RATE_LIMITED' }, { 'Retry-After': String(wait) });
      log('Pilot poll refused: wrong or missing bearer.');
      return send(res, 401, { error: 'The poll token was refused.', code: 'REFUSED' });
    }
    const wait = polls.take(t);
    if (wait) return send(res, 429, { error: `At most ${LIMIT_PER_HOUR} polls an hour; try again in ${wait} s.`, code: 'RATE_LIMITED' }, { 'Retry-After': String(wait) });
    try {
      return send(res, 200, pollBody(ws, t));
    } catch (err) {
      log(`Pilot poll could not read the queue: ${String(err && err.message || err).slice(0, 200)}`);
      return send(res, 503, { error: 'The queue could not be read now.', code: 'UNAVAILABLE' });
    }
  };
}

module.exports = { FORMAT, LIMIT_PER_HOUR, HOUR, expectedDigest, pollBody, hourBucket, bearerMatches, makePilotPollRoute };
