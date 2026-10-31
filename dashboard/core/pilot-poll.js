'use strict';
// The pilot runner's zero-token pre-poll of the online desk (autonomous paper
// playbook, Stage 11): GET /api/pilot/queue with "Authorization: Bearer
// <token>". The desk holds only the token's SHA-256 (hex), in its environment
// as CR_PILOT_POLL_TOKEN_SHA256, read per request; without it the route is
// not there (404). The bearer's SHA-256 is compared in constant time. Every
// request, a refused one included, counts against 60 an hour, held in memory.
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
  const steps = require('./tickets').pilotQueue(ws, { now }).map((s) => ({
    project_id: s.project_id,
    step: s.step,
    ticket_id: s.ticket_id || null,
    run_id: s.run_id || null,
    receipt_id: s.receipt_id || null,
    claim: claims.peek(ws, s.project_id, s, now),
  }));
  return { format: FORMAT, paused: require('./workspace').automationPaused(ws), steps };
}

function makePilotPollRoute(ws, { env = process.env, log = () => {}, now = () => Date.now() } = {}) {
  const hits = [];
  const send = (res, status, body, extra = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify(body));
  };
  return function handle(req, res) {
    const want = expectedDigest(env);
    if (!want) return send(res, 404, { error: 'Unknown API route' });
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
    const t = now();
    while (hits.length && t - hits[0] >= HOUR) hits.shift();
    if (hits.length >= LIMIT_PER_HOUR) {
      const wait = Math.max(1, Math.ceil((hits[0] + HOUR - t) / 1000));
      return send(res, 429, { error: `At most ${LIMIT_PER_HOUR} polls an hour; try again in ${wait} s.`, code: 'RATE_LIMITED' }, { 'Retry-After': String(wait) });
    }
    hits.push(t);
    const m = String(req.headers.authorization || '').match(/^Bearer (\S{16,512})$/);
    const got = m ? crypto.createHash('sha256').update(m[1], 'utf8').digest() : null;
    if (!got || !crypto.timingSafeEqual(got, want)) {
      log('Pilot poll refused: wrong or missing bearer.');
      return send(res, 401, { error: 'The poll token was refused.', code: 'REFUSED' });
    }
    try {
      return send(res, 200, pollBody(ws, t));
    } catch (err) {
      log(`Pilot poll could not read the queue: ${String(err && err.message || err).slice(0, 200)}`);
      return send(res, 503, { error: 'The queue could not be read now.', code: 'UNAVAILABLE' });
    }
  };
}

module.exports = { FORMAT, LIMIT_PER_HOUR, expectedDigest, pollBody, makePilotPollRoute };
