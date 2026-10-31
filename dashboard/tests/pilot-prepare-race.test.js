'use strict';
// At most one launch authorization per claim attempt (worker boundary PR,
// 2026-10-31; core/pilot-worker.js prepare, core/pilot-claims.js
// beginPreparation and bind). The audit's reproduction: two prepare requests
// on one claim, overlapping while the desk waits on the exit quote, were both
// answered "prepared" with the same prompt (one attempt, one reservation, two
// launch authorizations). Here a real desk server on 127.0.0.1 with a
// FICTIONAL workspace takes the requests; the claims, the session ledger, the
// tickets and the workspace lock are the desk's own. The only stand-ins are
// the exit quote's network step (forensic-monitor quoteSizeUsd, held at a
// barrier the test opens), the claude -p session (a function) and the network
// beyond the desk (refused).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const P = require('../scripts/pilot');
const PC = require('../core/pilot-claims');
const T = require('../core/tickets');
const { applySettings } = require('../server');
const { mandateDesk } = require('./mandate-fixture');
const { answer } = require('./trader-fixture');

const POLL = 'FICTIONAL-poll-token-race-0123456789ab';
const WORKER = 'FICTIONAL-worker-token-race-0123456789';
const digest = (x) => crypto.createHash('sha256').update(x).digest('hex');
const DESK = 'https://desk.fictional.example';
const quiet = () => {};

function pilotOn(ws, pid) {
  const file = ws.abs(`projects/${pid}/tickets/profile.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema_version: 'cr.ticket-profile.v1', project_id: pid, pilot: true }));
}

function envFor(t, vars) {
  for (const [k, v] of Object.entries(vars)) {
    const before = process.env[k];
    process.env[k] = v;
    t.after(() => { if (before === undefined) delete process.env[k]; else process.env[k] = before; });
  }
}

function noNetwork(t) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.hostname === '127.0.0.1') return real(url, init);
    throw new Error(`FICTIONAL: no network to ${u.hostname}`);
  };
  t.after(() => { globalThis.fetch = real; });
  return real;
}

function desk(t, settings = {}) {
  const s = mandateDesk(t, { mandate: false, settings });
  pilotOn(s.ws, s.pid);
  envFor(t, { CR_PILOT_POLL_TOKEN_SHA256: digest(POLL), CR_PILOT_WORKER_TOKEN_SHA256: digest(WORKER) });
  return s;
}

async function startDesk(t, ws) {
  const { start } = require('../server');
  const srv = await start(ws, { port: 48800 + Math.floor(Math.random() * 600), quiet: true });
  let stopped = false;
  const stop = () => { if (!stopped) { stopped = true; try { srv.shutdown(); } catch (_) { /* stopped */ } } };
  t.after(stop);
  return { ...srv, stop };
}

function post(port, p, body, token = WORKER) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(c).toString()) }); } catch (err) { reject(err); } });
    });
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

// The exit quote's network step, held at a barrier: every prepare that
// reaches it waits until the test opens it, or until a second one arrives.
function quoteBarrier(t) {
  const FM = require('../core/forensic-monitor');
  const real = FM.quoteSizeUsd;
  const arrivals = [];
  let waiters = [];
  let open;
  const gate = new Promise((r) => { open = r; });
  FM.quoteSizeUsd = async (ws, pid) => {
    arrivals.push(pid);
    const w = waiters;
    waiters = [];
    w.forEach((f) => f());
    if (arrivals.length >= 2) open();
    await gate;
    return { status: 'no_answer', reason: 'FICTIONAL: the stand-in exit quote found no route.' };
  };
  t.after(() => { FM.quoteSizeUsd = real; open(); });
  const arrived = (n) => new Promise((resolve) => { const check = () => (arrivals.length >= n ? resolve() : waiters.push(check)); check(); });
  return { arrivals, arrived, open: () => open() };
}

const ledger = (ws) => (fs.existsSync(ws.abs(PC.SESSIONS_REL)) ? fs.readFileSync(ws.abs(PC.SESSIONS_REL), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const claimOver = async (port, pid, owner = 'runner') => {
  const c = await post(port, '/api/pilot/worker/claim', { project_id: pid, owner });
  assert.equal(c.json.status, 'claimed_now', `claimed: ${c.json.words || ''}`);
  return c.json;
};

test('two prepares of one claim overlap at the exit quote: one prepared with the prompt, one session reserved, the loser changes nothing, a retry gets nothing', async (t) => {
  const s = desk(t);
  noNetwork(t);
  const q = quoteBarrier(t);
  const srv = await startDesk(t, s.ws);
  const c = await claimOver(srv.port, s.pid);
  assert.equal(c.step, 'ticket');
  const prepare = () => post(srv.port, '/api/pilot/worker/prepare', { project_id: s.pid, token: c.token });
  const pA = prepare();
  await q.arrived(1);
  const before = PC.read(s.ws, s.pid);
  const pB = prepare();
  // The second request either answers while the first waits on the quote, or
  // (as before this PR) reaches the quote itself, which opens the barrier.
  const first = await Promise.race([pB.then((r) => ({ b: r })), q.arrived(2).then(() => ({ b: null }))]);
  if (first.b) assert.deepEqual(PC.read(s.ws, s.pid), before, 'the losing request did not write to the winning claim');
  q.open();
  const [ra, rb] = await Promise.all([pA, pB]);
  assert.deepEqual([ra.status, rb.status], [200, 200]);
  const all = [ra.json, rb.json];
  const won = all.filter((r) => r.status === 'prepared');
  const lost = all.filter((r) => r.status !== 'prepared');
  assert.equal(won.length, 1, `exactly one launch authorization, got ${all.map((r) => r.status).join(', ')}`);
  assert.equal(q.arrivals.length, 1, 'one exit quote asked');
  assert.equal(won[0].prompt_sha256, digest(won[0].prompt));
  assert.equal(lost[0].status, 'already_prepared');
  assert.equal(lost[0].prompt, undefined, 'the loser carries no prompt');
  assert.equal(lost[0].prompt_sha256, undefined);
  assert.equal(won[0].attempt_id, c.attempt_id);
  assert.equal(lost[0].attempt_id, c.attempt_id, 'one stable attempt');
  assert.ok(lost[0].ticket_id === null || lost[0].ticket_id === won[0].ticket_id);
  assert.equal(ledger(s.ws).length, 1, 'one session reserved');
  assert.equal(T.listTickets(s.ws, s.pid).filter((x) => !x.broken).length, 1, 'one ticket opened');
  const cur = PC.read(s.ws, s.pid);
  assert.equal(cur.state, 'dispatched');
  assert.equal(cur.released, false, 'the winning claim is intact');
  assert.equal(cur.token, before.token);
  assert.equal(cur.attempt_id, c.attempt_id);
  assert.equal(cur.ticket_id, won[0].ticket_id);
  // A later retry on the same claim authorizes nothing.
  const again = await prepare();
  assert.equal(again.json.status, 'already_prepared');
  assert.equal(again.json.prompt, undefined);
  assert.equal(ledger(s.ws).length, 1);
  // The one session's answer completes the attempt.
  const done = await post(srv.port, '/api/pilot/worker/complete', { project_id: s.pid, token: c.token, prompt_sha256: won[0].prompt_sha256, text: answer(T.loadTicket(s.ws, s.pid, won[0].ticket_id)) });
  assert.equal(done.json.status, 'saved');
  assert.equal(T.listReceipts(s.ws, s.pid).filter((r) => !r.broken && !r.desk_gate).length, 1);
  srv.stop();
});

test('a claim is bound at most once: a second bind of a dispatched attempt is refused and reserves nothing', (t) => {
  const s = desk(t);
  const now = Date.now();
  const a = PC.claim(s.ws, s.pid, { owner: 'local', now });
  assert.equal(a.status, 'claimed_now');
  PC.bind(s.ws, s.pid, a.token, { ticket_id: 'tk_FICTIONAL', now });
  const before = PC.read(s.ws, s.pid);
  assert.throws(() => PC.bind(s.ws, s.pid, a.token, { ticket_id: 'tk_FICTIONAL', now: now + 1000 }), (e) => e.code === 'ALREADY_BOUND', 'the second transition from the same attempt is refused');
  assert.deepEqual(PC.read(s.ws, s.pid), before, 'and leaves the claim as it was');
  assert.equal(ledger(s.ws).length, 1);
});

test('a lost "prepared" answer, then a desk restart: no second launch authorization; after expiry the attempt waits for Eric', async (t) => {
  const s = desk(t);
  const real = noNetwork(t);
  let srv = await startDesk(t, s.ws);
  let sessions = 0;
  const run = () => { sessions += 1; return 'FICTIONAL'; };
  const o = { project: s.pid, desk: 'online', deskUrl: DESK, timeoutMin: 1 };
  // The desk prepares; its answer never reaches the runner.
  const losing = async (url, init) => {
    const r = await real(String(url).replace(DESK, `http://127.0.0.1:${srv.port}`), { ...init, headers: { ...init.headers, host: `127.0.0.1:${srv.port}` } });
    if (String(url).endsWith('/prepare')) { await r.text(); throw new Error('FICTIONAL: socket hang up'); }
    return r;
  };
  const r1 = await P.runOnline(o, { run, out: quiet, fetchImpl: losing, token: WORKER });
  assert.equal(r1.stop, 'reconcile');
  assert.equal(sessions, 0, 'no session without the prompt');
  const c = PC.read(s.ws, s.pid);
  assert.equal(c.state, 'dispatched');
  assert.equal(ledger(s.ws).length, 1, 'the session was reserved once, before the answer was lost');
  srv.stop();
  srv = await startDesk(t, s.ws);
  const again = await post(srv.port, '/api/pilot/worker/prepare', { project_id: s.pid, token: c.token });
  assert.equal(again.json.status, 'already_prepared');
  assert.equal(again.json.prompt, undefined, 'the restarted desk hands out no prompt for that attempt');
  const toDesk = async (url, init) => real(String(url).replace(DESK, `http://127.0.0.1:${srv.port}`), { ...init, headers: { ...init.headers, host: `127.0.0.1:${srv.port}` } });
  const r2 = await P.runOnline(o, { run, out: quiet, fetchImpl: toDesk, token: WORKER });
  assert.equal(r2.stop, 'claimed', 'another run while the claim is live dispatches nothing');
  assert.equal(sessions, 0);
  const later = Date.parse(c.expires_at) + 1000;
  assert.equal(PC.claim(s.ws, s.pid, { owner: 'later', now: later }).status, 'reconcile', 'after expiry it waits for Eric, never dispatched again by itself');
  assert.equal(ledger(s.ws).length, 1);
  srv.stop();
});

test('Eric pauses while the quote is out: the bind refuses, no prompt, no session reserved; the runner can let the claim go', async (t) => {
  const s = desk(t);
  noNetwork(t);
  const q = quoteBarrier(t);
  const srv = await startDesk(t, s.ws);
  const c = await claimOver(srv.port, s.pid);
  const pA = post(srv.port, '/api/pilot/worker/prepare', { project_id: s.pid, token: c.token });
  await q.arrived(1);
  applySettings(s.ws, { automation: { paused: true } });
  q.open();
  const ra = await pA;
  assert.equal(ra.status, 409);
  assert.equal(ra.json.code, 'PAUSED');
  assert.equal(ra.json.prompt, undefined);
  assert.equal(ledger(s.ws).length, 0, 'no session reserved');
  assert.notEqual(PC.read(s.ws, s.pid).state, 'dispatched');
  const rel = await post(srv.port, '/api/pilot/worker/release', { project_id: s.pid, token: c.token, outcome: 'stopped' });
  assert.equal(rel.json.status, 'released');
  srv.stop();
});

test('the claim expires while the quote is out: the bind is judged at its own time and refuses; no prompt, no session reserved', async (t) => {
  const s = desk(t);
  noNetwork(t);
  const q = quoteBarrier(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const srv = await startDesk(t, s.ws);
  const c = await claimOver(srv.port, s.pid);
  const pA = post(srv.port, '/api/pilot/worker/prepare', { project_id: s.pid, token: c.token });
  await q.arrived(1);
  t.mock.timers.setTime(Date.parse(c.expires_at) + 60000);
  q.open();
  const ra = await pA;
  assert.equal(ra.status, 409, `refused: ${ra.json.status || ''} ${ra.json.error || ''}`);
  assert.match(ra.json.error, /expired/);
  assert.equal(ra.json.prompt, undefined);
  assert.equal(ledger(s.ws).length, 0, 'no session reserved for an expired claim');
  assert.notEqual(PC.read(s.ws, s.pid).state, 'dispatched');
  srv.stop();
});

test('a preparation interrupted by a crash: live, it holds the project; expired, it is no dispatch to reconcile and a new attempt takes the step; the old one can never bind', (t) => {
  const s = desk(t);
  const now = Date.now();
  const a = PC.claim(s.ws, s.pid, { owner: 'one', now });
  const b = PC.beginPreparation(s.ws, s.pid, a.token, { now });
  assert.equal(b.status, 'preparing');
  assert.equal(PC.read(s.ws, s.pid).state, 'preparing');
  // A second preparation of the same claim changes nothing.
  const rec = PC.read(s.ws, s.pid);
  assert.equal(PC.beginPreparation(s.ws, s.pid, a.token, { now: now + 1 }).status, 'already');
  assert.deepEqual(PC.read(s.ws, s.pid), rec);
  // The desk restarted here. While the claim is live another runner is refused.
  const step = T.pilotQueue(s.ws, { project: s.pid, now })[0];
  assert.equal(PC.claim(s.ws, s.pid, { owner: 'two', now: now + 60000 }).status, 'claimed');
  assert.equal(PC.peek(s.ws, s.pid, step, now + 60000), 'claimed');
  // Expired: no prompt was handed out (only a bind does that), so it is not a
  // dispatch whose outcome is unknown.
  const later = Date.parse(rec.expires_at) + 1000;
  assert.equal(PC.peek(s.ws, s.pid, step, later), null);
  const c = PC.claim(s.ws, s.pid, { owner: 'three', now: later });
  assert.equal(c.status, 'claimed_now');
  assert.notEqual(c.claim.attempt_id, a.claim.attempt_id, 'a new attempt');
  assert.throws(() => PC.bind(s.ws, s.pid, a.token, { ticket_id: 'tk_FICTIONAL', now: later, from: 'preparing' }), (e) => e.code === 'CHANGED', 'the old preparation cannot bind');
  assert.throws(() => PC.assertPreparing(s.ws, s.pid, a.token, { now: later }), (e) => e.code === 'CHANGED');
  // An expired preparation cannot bind either, even with its own token.
  const d = PC.beginPreparation(s.ws, s.pid, c.token, { now: later });
  assert.equal(d.status, 'preparing');
  const after = Date.parse(d.claim.expires_at) + 1;
  assert.throws(() => PC.bind(s.ws, s.pid, c.token, { ticket_id: 'tk_FICTIONAL', now: after, from: 'preparing' }), (e) => e.code === 'CHANGED');
  assert.equal(ledger(s.ws).length, 0, 'nothing reserved');
});

test('competing claims: one winner per project; two claims for the day\'s last session: one prepared, the other refused at its bind', async (t) => {
  const s = desk(t, { automation: { pilot_daily_sessions: 1 } });
  noNetwork(t);
  // A second pilot project with no Claude report: its step is research.
  const pidB = require('../core/projects').addProject(s.ws, { name: 'Second Example (FICTIONAL)', symbol: 'XSEC', official_website: 'https://second.example', coingecko_id: 'second-example-fictional', assets: [{ chain: 'example-chain', contract_address: 'FICTIONAL-CONTRACT-XSEC' }], evidence: [{ url: 'https://second.example', note: 'fictional' }] }).project_id;
  pilotOn(s.ws, pidB);
  assert.equal(T.pilotQueue(s.ws, { project: pidB })[0].step, 'research');
  const q = quoteBarrier(t);
  const srv = await startDesk(t, s.ws);
  const race = async (pid) => (await Promise.all([1, 2, 3].map((i) => post(srv.port, '/api/pilot/worker/claim', { project_id: pid, owner: `racer-${i}` })))).map((r) => r.json);
  const ra = await race(s.pid);
  const rb = await race(pidB);
  for (const r of [ra, rb]) assert.equal(r.filter((x) => x.status === 'claimed_now').length, 1, 'one winner');
  const ca = ra.find((x) => x.status === 'claimed_now');
  const cb = rb.find((x) => x.status === 'claimed_now');
  // Project A waits on its quote; project B's research takes the last session.
  const pA = post(srv.port, '/api/pilot/worker/prepare', { project_id: s.pid, token: ca.token });
  await q.arrived(1);
  const pb = await post(srv.port, '/api/pilot/worker/prepare', { project_id: pidB, token: cb.token });
  assert.equal(pb.json.status, 'prepared', `B: ${pb.json.words || pb.json.error || ''}`);
  q.open();
  const pa = await pA;
  assert.equal(pa.status, 409);
  assert.equal(pa.json.code, 'SESSION_CEILING');
  assert.equal(pa.json.prompt, undefined);
  assert.equal(ledger(s.ws).length, 1, 'never past the ceiling');
  srv.stop();
});
