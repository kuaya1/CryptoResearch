'use strict';
// The online pilot worker (core/pilot-worker.js, cr-pilot-worker@1) and the
// daily session ceiling (core/pilot-claims.js, cr-pilot-session@1).
// Corrective PR 2026-10-31, finding D. A real desk server on 127.0.0.1 with a
// FICTIONAL workspace; the only stand-ins are the claude -p session (a
// function that writes the Prosecutor's answer) and the network beyond the
// desk (any request off 127.0.0.1 is refused). The claims, the ledger, the
// ticket, the receipt and the locks are the desk's own.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const P = require('../scripts/pilot');
const PC = require('../core/pilot-claims');
const PW = require('../core/pilot-worker');
const T = require('../core/tickets');
const { mandateDesk } = require('./mandate-fixture');
const { answer } = require('./trader-fixture');

const POLL = 'FICTIONAL-poll-token-0123456789abcdef';
const WORKER = 'FICTIONAL-worker-token-0123456789abcd';
const digest = (t) => crypto.createHash('sha256').update(t).digest('hex');
const DESK = 'https://desk.fictional.example';

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

// Nothing leaves 127.0.0.1: the desk's own exit-quote step meets a refusal.
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

async function startDesk(t, ws) {
  const { start } = require('../server');
  const srv = await start(ws, { port: 48200 + Math.floor(Math.random() * 600), quiet: true });
  let stopped = false;
  const stop = () => { if (!stopped) { stopped = true; try { srv.shutdown(); } catch (_) { /* stopped */ } } };
  t.after(stop);
  return { ...srv, stop };
}

// The runner's fetch: the desk's https origin is this test server.
const toDesk = (port, real, { hold = null } = {}) => async (url, init) => {
  const local = String(url).replace(DESK, `http://127.0.0.1:${port}`);
  if (hold) await hold(String(url));
  return real(local, { ...init, headers: { ...init.headers, host: `127.0.0.1:${port}` } });
};

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

function desk(t, settings = {}) {
  const s = mandateDesk(t, { mandate: false, settings });
  pilotOn(s.ws, s.pid);
  envFor(t, { CR_PILOT_POLL_TOKEN_SHA256: digest(POLL), CR_PILOT_WORKER_TOKEN_SHA256: digest(WORKER) });
  return s;
}

// The Prosecutor's session stand-in: the answer to the ticket the claim was
// bound to, from the prompt it was given (the prompt names that ticket).
function prosecutor(s, seen) {
  return (prompt, opts) => {
    seen.push({ prompt, tools: opts.tools });
    const tid = (PC.read(s.ws, s.pid) || {}).ticket_id;
    assert.ok(tid && prompt.includes(tid), 'the session got the bound ticket\'s frozen prompt');
    return answer(T.loadTicket(s.ws, s.pid, tid));
  };
}

const ledger = (ws) => (fs.existsSync(ws.abs(PC.SESSIONS_REL)) ? fs.readFileSync(ws.abs(PC.SESSIONS_REL), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

function lockDirs(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pilot-worker-test-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return { a: { lockFile: path.join(d, 'a.lock'), logFile: path.join(d, 'a.jsonl') }, b: { lockFile: path.join(d, 'b.lock'), logFile: path.join(d, 'b.jsonl') } };
}

test('two workers with their own lock files against one desk: one claim, one session, one receipt; again after a restart, nothing', async (t) => {
  const s = desk(t);
  const real = noNetwork(t);
  const d = lockDirs(t);
  let srv = await startDesk(t, s.ws);
  // Both runners finish their pre-poll before either claims, so the desk's
  // claim is what decides.
  let polled = 0;
  let release;
  const bothPolled = new Promise((r) => { release = r; });
  const hold = async (url) => { if (url.endsWith('/api/pilot/queue') && polled < 2) { polled += 1; if (polled === 2) release(); await bothPolled; } };
  const seen = [];
  const quiet = () => {};
  const o = { desk: 'online', maxAgents: 2, deskUrl: DESK };
  const run = (dir) => P.runAll(o, { ...dir, token: POLL, workerToken: WORKER, fetchImpl: toDesk(srv.port, real, { hold }), agent: prosecutor(s, seen), out: quiet });
  const codes = await Promise.all([run(d.a), run(d.b)]);
  assert.deepEqual(codes, [0, 0]);
  assert.equal(seen.length, 1, 'exactly one claude -p session between the two workers');
  assert.deepEqual(seen[0].tools, P.WEB_TOOLS, 'web tools only');
  const logs = [d.a.logFile, d.b.logFile].map((f) => JSON.parse(fs.readFileSync(f, 'utf8').trim()));
  const outcomes = logs.map((l) => l.dispatches[0].outcome).sort();
  assert.deepEqual(outcomes, ['done', 'not_dispatched'], 'one dispatched, the other refused by the claim');
  assert.equal(logs.find((l) => l.dispatches[0].outcome === 'not_dispatched').dispatches[0].stop, 'claimed');
  const receipts = T.listReceipts(s.ws, s.pid).filter((r) => !r.broken && !r.desk_gate);
  assert.equal(receipts.length, 1, 'one Prosecutor receipt');
  assert.equal(ledger(s.ws).length, 1, 'one session reserved');
  const c = PC.read(s.ws, s.pid);
  assert.equal(c.released, true);
  assert.equal(c.outcome, 'saved');
  assert.equal(T.pilotQueue(s.ws, { project: s.pid })[0].step, 'pm_review');
  // Restart the desk; both workers run again: nothing is dispatched twice.
  srv.stop();
  srv = await startDesk(t, s.ws);
  polled = 2;
  const again = await Promise.all([run(d.a), run(d.b)]);
  assert.deepEqual(again, [0, 0]);
  assert.equal(seen.length, 1, 'no second session');
  assert.equal(T.listReceipts(s.ws, s.pid).filter((r) => !r.broken && !r.desk_gate).length, 1);
  assert.equal(ledger(s.ws).length, 1);
  srv.stop();
});

test('five claims at once through the desk\'s lock: exactly one holds the step; only it gets a token', async (t) => {
  const s = desk(t);
  noNetwork(t);
  const srv = await startDesk(t, s.ws);
  const all = await Promise.all([1, 2, 3, 4, 5].map((i) => post(srv.port, '/api/pilot/worker/claim', { project_id: s.pid, owner: `racer-${i}` })));
  assert.ok(all.every((r) => r.status === 200));
  const won = all.filter((r) => r.json.status === 'claimed_now');
  assert.equal(won.length, 1);
  assert.match(won[0].json.token, /^[0-9a-f]{20}$/);
  for (const r of all.filter((x) => x.json.status !== 'claimed_now')) {
    assert.equal(r.json.status, 'claimed');
    assert.equal(r.json.token, null, 'another runner\'s token is never given out');
  }
  // A loser cannot prepare with a guessed token; the winner prepares once.
  assert.equal((await post(srv.port, '/api/pilot/worker/prepare', { project_id: s.pid, token: '0'.repeat(20) })).status, 409);
  const p = await post(srv.port, '/api/pilot/worker/prepare', { project_id: s.pid, token: won[0].json.token });
  assert.equal(p.json.status, 'prepared');
  assert.equal(p.json.role, 'prosecutor');
  assert.equal(digest(p.json.prompt), p.json.prompt_sha256);
  const again = await post(srv.port, '/api/pilot/worker/prepare', { project_id: s.pid, token: won[0].json.token });
  assert.equal(again.json.status, 'already_prepared', 'a prepared attempt is never handed out twice');
  assert.equal(ledger(s.ws).length, 1);
  srv.stop();
});

test('the worker token reaches only its four routes; the poll token is not a worker token; neither signs in', async (t) => {
  const s = desk(t);
  noNetwork(t);
  const srv = await startDesk(t, s.ws);
  assert.equal((await post(srv.port, '/api/pilot/worker/claim', { project_id: s.pid, owner: 'x' }, POLL)).status, 401, 'the read-only poll token cannot claim');
  const asWorker = (p, body = {}) => post(srv.port, p, body, WORKER);
  for (const p of ['/api/settings', `/api/projects/${s.pid}/tickets/decide`, `/api/projects/${s.pid}/autonomy`, `/api/projects/${s.pid}/pilot-claim/release`]) {
    assert.equal((await asWorker(p, { action: 'approve', reconciled: true })).status, 401, `${p} needs the sign-in, not the worker token`);
  }
  assert.equal((await asWorker('/api/pilot/worker/decide', {})).status, 404);
  const rel = await asWorker('/api/pilot/worker/release', { project_id: s.pid, token: 'a'.repeat(20), outcome: 'reconciled' });
  assert.equal(rel.status, 400, 'the worker cannot release as reconciled');
  delete process.env.CR_PILOT_WORKER_TOKEN_SHA256;
  assert.equal((await asWorker('/api/pilot/worker/claim', { project_id: s.pid, owner: 'x' })).status, 404, 'unset, the routes are not there');
  srv.stop();
});

test('a complete that is refused for another prompt saves nothing and keeps the claim; a lost one is reconciled by Eric only after expiry', async (t) => {
  const s = desk(t);
  noNetwork(t);
  const c = PW.claimStep(s.ws, s.pid, { owner: 'unit' });
  const p = await PW.prepare(s.ws, s.pid, c.token, { fetchImpl: async () => { throw new Error('FICTIONAL: no network'); } });
  assert.equal(p.status, 'prepared');
  const text = answer(T.loadTicket(s.ws, s.pid, p.ticket_id));
  assert.throws(() => PW.complete(s.ws, s.pid, c.token, { text, prompt_sha256: 'f'.repeat(64) }), (e) => e.code === 'REFUSED');
  assert.equal(T.listReceipts(s.ws, s.pid).filter((r) => !r.broken && !r.desk_gate).length, 0);
  assert.equal(PC.read(s.ws, s.pid).state, 'dispatched');
  // The answer never arrived (the runner lost it): the claim stays
  // dispatched; once expired it is "reconcile" and is never claimed again.
  const later = Date.parse(PC.read(s.ws, s.pid).expires_at) + 1000;
  assert.equal(PC.peek(s.ws, s.pid, T.pilotQueue(s.ws, { project: s.pid })[0], later), 'reconcile');
  assert.equal(PC.claim(s.ws, s.pid, { owner: 'next', now: later }).status, 'reconcile');
  assert.throws(() => PW.releaseByWorker(s.ws, s.pid, c.token, { outcome: 'stopped' }), /prepared/);
  // Completed with its own prompt: saved, verified, released.
  const done = PW.complete(s.ws, s.pid, c.token, { text, prompt_sha256: p.prompt_sha256 });
  assert.equal(done.status, 'saved');
  assert.equal(done.verified, true);
  assert.equal(PC.read(s.ws, s.pid).released, true);
});

test('the daily session ceiling: reserved at bind before any session, failures counted, never reset by another run; a new day has its own', (t) => {
  const s = desk(t, { automation: { pilot_daily_sessions: 1 } });
  const now = Date.parse('2026-10-31T15:00:00.000Z');
  const a = PC.claim(s.ws, s.pid, { owner: 'one', now });
  assert.equal(a.status, 'claimed_now');
  const b = PC.bind(s.ws, s.pid, a.token, { ticket_id: 'tk_FICTIONAL', now });
  assert.deepEqual(b.sessions, { day: '2026-10-31', used: 1, ceiling: 1 });
  // That session failed; the runner let it go. It still counts.
  PC.release(s.ws, s.pid, { token: a.token, outcome: 'agent_failed', now });
  const c = PC.claim(s.ws, s.pid, { owner: 'two', now: now + 60000 });
  assert.equal(c.status, 'session_ceiling');
  assert.match(c.words, /1 agent session is used .*failed ones included/);
  // A fresh runner with a new lock file reads the same ledger.
  assert.equal(PC.claim(s.ws, s.pid, { owner: 'three', now: now + 120000 }).status, 'session_ceiling');
  // Bind refuses too, should a claim have been taken before the ceiling.
  // The next New York day has its own ceiling.
  const tomorrow = Date.parse('2026-11-01T15:00:00.000Z');
  const d = PC.claim(s.ws, s.pid, { owner: 'four', now: tomorrow });
  assert.equal(d.status, 'claimed_now');
  // A ledger line that does not read stops every new session.
  fs.appendFileSync(s.ws.abs(PC.SESSIONS_REL), 'not json\n');
  assert.throws(() => PC.bind(s.ws, s.pid, d.token, { ticket_id: 'tk_FICTIONAL', now: tomorrow }), (e) => e.code === 'UNREADABLE');
  PC.release(s.ws, s.pid, { token: d.token, outcome: 'stopped', now: tomorrow });
  assert.equal(PC.claim(s.ws, s.pid, { owner: 'five', now: tomorrow + 1000 }).status, 'sessions_unknown');
  assert.equal(PC.sessionsView(s.ws, tomorrow).unreadable, true);
});

test('the worker token is read from secrets.json (pilot_worker_token), apart from the poll token', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-secrets-test-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const f = path.join(d, 'secrets.json');
  fs.writeFileSync(f, JSON.stringify({ pilot_poll_token: POLL }));
  assert.throws(() => P.readWorkerToken(f), /holds no pilot_worker_token/);
  fs.writeFileSync(f, JSON.stringify({ pilot_poll_token: POLL, pilot_worker_token: WORKER }));
  assert.equal(P.readWorkerToken(f), WORKER);
});
