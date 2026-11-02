'use strict';
// The production poll sighting (core/pilot-sighting.js, cr-pilot-sighting@1;
// blueprint 2026-11-02 §6.2, row 6). A real desk server on 127.0.0.1 with a
// FICTIONAL workspace, paused so no agent is ever dispatched; any request
// off 127.0.0.1 is refused. Covers: the record written only by the worker's
// POST poll, after the snapshot and on the desk's clock; GET unchanged and
// writing nothing; a forged clock or a failed snapshot never freshening the
// record; STALE at 120 min (and max_agents × 95 + 15 above one agent);
// unknown when the record does not read; the runner sighting only when it
// runs unattended, online and not dry.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const P = require('../scripts/pilot');
const S = require('../core/pilot-sighting');
const T = require('../core/tickets');
const { mandateDesk } = require('./mandate-fixture');

const POLL = 'FICTIONAL-poll-token-0123456789abcdef';
const WORKER = 'FICTIONAL-worker-token-0123456789abcd';
const digest = (t) => crypto.createHash('sha256').update(t).digest('hex');
const DESK = 'https://desk.fictional.example';
const MIN = 60000;
const INV = 'inv-0000-fictional';

function envFor(t, vars) {
  for (const [k, v] of Object.entries(vars)) {
    const before = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
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

function pilotOn(ws, pid) {
  const file = ws.abs(`projects/${pid}/tickets/profile.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema_version: 'cr.ticket-profile.v1', project_id: pid, pilot: true }));
}

// Paused: the poll answers, nothing is dispatched.
function desk(t) {
  const s = mandateDesk(t, { mandate: false, settings: { automation: { paused: true } } });
  pilotOn(s.ws, s.pid);
  envFor(t, { CR_PILOT_POLL_TOKEN_SHA256: digest(POLL), CR_PILOT_WORKER_TOKEN_SHA256: digest(WORKER), CR_PILOT_RUNNER_ID: undefined });
  return s;
}

async function startDesk(t, ws) {
  const { start } = require('../server');
  const srv = await start(ws, { port: 48800 + Math.floor(Math.random() * 600), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } });
  return srv;
}

function request(port, p, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === null ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(c).toString() || 'null') }); } catch (err) { reject(err); } });
    });
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data || undefined);
  });
}
const bearer = (tok) => ({ authorization: `Bearer ${tok}` });
const sightingFile = (ws) => ws.abs(S.REL);
const stored = (ws) => (fs.existsSync(sightingFile(ws)) ? fs.readFileSync(sightingFile(ws), 'utf8') : null);
const fields = (extra = {}) => ({ runner_id: 'render-cron', invocation_id: INV, max_agents: 1, ...extra });

test('only the worker POST poll records a sighting, after the same snapshot the GET answers, on the desk\'s clock', async (t) => {
  const s = desk(t);
  noNetwork(t);
  const srv = await startDesk(t, s.ws);

  // GET is unchanged and writes nothing.
  const got = await request(srv.port, '/api/pilot/queue', { headers: bearer(POLL) });
  assert.equal(got.status, 200);
  assert.equal(got.json.format, 'cr-pilot-poll@1');
  assert.equal(got.json.paused, true);
  assert.equal(stored(s.ws), null, 'the GET wrote no sighting');
  assert.equal(S.view(s.ws).state, 'never');

  // The poll token is not a worker token; a wrong bearer writes nothing.
  assert.equal((await request(srv.port, '/api/pilot/worker/poll', { method: 'POST', body: fields(), headers: bearer(POLL) })).status, 401);
  assert.equal((await request(srv.port, '/api/pilot/worker/poll', { method: 'GET', headers: bearer(WORKER) })).status, 405);
  // Fields that do not hold are refused before anything is read or written.
  for (const bad of [{ runner_id: '' }, { runner_id: 'a/b' }, { invocation_id: 'short' }, { max_agents: 11 }, { max_agents: '1' }]) {
    const r = await request(srv.port, '/api/pilot/worker/poll', { method: 'POST', body: fields(bad), headers: bearer(WORKER) });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.json.code, 'INVALID');
  }
  assert.equal(stored(s.ws), null, 'nothing was recorded by a refused poll');

  // A forged clock in the body is never read: the desk's own time is.
  const before = Date.now();
  const r = await request(srv.port, '/api/pilot/worker/poll', { method: 'POST', body: fields({ last_polled_at: '2099-01-01T00:00:00.000Z', now: Date.parse('2099-01-01'), polled_at: '2099-01-01' }), headers: bearer(WORKER) });
  const after = Date.now();
  assert.equal(r.status, 200);
  assert.equal(r.json.format, 'cr-pilot-worker@1');
  assert.equal(r.json.status, 'polled');
  assert.equal(r.json.poll.format, 'cr-pilot-poll@1');
  assert.deepEqual(r.json.poll.steps, got.json.steps, 'the same snapshot the GET answers');
  assert.equal(r.json.poll.paused, got.json.paused);
  const at = Date.parse(r.json.sighting.last_polled_at);
  assert.ok(at >= before - 1000 && at <= after + 1000, `the desk's clock, not the body's: ${r.json.sighting.last_polled_at}`);
  const rec = JSON.parse(stored(s.ws));
  assert.deepEqual(Object.keys(rec).sort(), ['format', 'invocation_id', 'last_polled_at', 'max_agents', 'runner_id']);
  assert.deepEqual(rec, { format: S.FORMAT, last_polled_at: r.json.sighting.last_polled_at, runner_id: 'render-cron', invocation_id: INV, max_agents: 1 });

  // The signed-in read says it, and reading it writes nothing.
  const v = await request(srv.port, '/api/pilot/sighting', { headers: { 'x-cr-token': srv.token } });
  assert.equal(v.status, 200);
  assert.equal(v.json.state, 'fresh');
  assert.equal(v.json.stale_after_min, 120);
  assert.equal(v.json.runner_id, 'render-cron');
  assert.equal(stored(s.ws), `${JSON.stringify(rec, null, 2)}\n`);
  // The worker and poll bearers do not read it.
  assert.equal((await request(srv.port, '/api/pilot/sighting', { headers: bearer(WORKER) })).status, 401);
  assert.equal((await request(srv.port, '/api/pilot/sighting', { headers: bearer(POLL) })).status, 401);
});

test('a snapshot that fails writes nothing and leaves the earlier sighting as it was', async (t) => {
  const s = desk(t);
  noNetwork(t);
  const srv = await startDesk(t, s.ws);
  const first = await request(srv.port, '/api/pilot/worker/poll', { method: 'POST', body: fields(), headers: bearer(WORKER) });
  assert.equal(first.status, 200);
  const was = stored(s.ws);
  const real = T.pilotQueue;
  T.pilotQueue = () => { throw new Error('FICTIONAL: the queue does not read'); };
  t.after(() => { T.pilotQueue = real; });
  const r = await request(srv.port, '/api/pilot/worker/poll', { method: 'POST', body: fields({ invocation_id: 'inv-1111-fictional' }), headers: bearer(WORKER) });
  assert.ok(r.status >= 500, `the failed snapshot is not an answer: ${r.status}`);
  assert.equal(r.json.poll, undefined);
  assert.equal(stored(s.ws), was, 'the record was not freshened');
  // The GET fails the same way and writes nothing either.
  assert.equal((await request(srv.port, '/api/pilot/queue', { headers: bearer(POLL) })).status, 503);
  assert.equal(stored(s.ws), was);
  T.pilotQueue = real;
});

test('STALE at 120 min for one agent and max_agents × 95 + 15 above it; a record that does not read is unknown, never fresh', (t) => {
  const s = desk(t);
  const t0 = Date.parse('2026-11-02T12:00:00.000Z');
  assert.equal(S.view(s.ws, { now: t0 }).state, 'never');
  assert.deepEqual(S.record(s.ws, fields(), { now: t0 }), { format: S.FORMAT, last_polled_at: '2026-11-02T12:00:00.000Z', runner_id: 'render-cron', invocation_id: INV, max_agents: 1 });
  assert.equal(S.view(s.ws, { now: t0 + 120 * MIN }).state, 'fresh');
  const stale = S.view(s.ws, { now: t0 + 121 * MIN });
  assert.equal(stale.state, 'stale');
  assert.equal(stale.age_min, 121);
  assert.match(stale.words, /^STALE: the production poll is overdue\./);
  assert.match(stale.words, /not proof that no grade exists or that no session is running/);
  // A larger declared cap raises the threshold, never lowers it.
  assert.equal(S.staleAfterMin(0), 120);
  assert.equal(S.staleAfterMin(1), 120);
  assert.equal(S.staleAfterMin(2), 205);
  assert.equal(S.staleAfterMin(4), 395);
  S.record(s.ws, fields({ max_agents: 2 }), { now: t0 });
  assert.equal(S.view(s.ws, { now: t0 + 200 * MIN }).state, 'fresh');
  assert.equal(S.view(s.ws, { now: t0 + 206 * MIN }).state, 'stale');

  // Never backward: an older sighting does not replace a newer one.
  S.record(s.ws, fields({ invocation_id: 'inv-late-fictional' }), { now: t0 + 10 * MIN });
  S.record(s.ws, fields({ invocation_id: 'inv-early-fictional' }), { now: t0 + 5 * MIN });
  assert.equal(S.view(s.ws, { now: t0 + 11 * MIN }).invocation_id, 'inv-late-fictional');
  // Fields that do not hold record nothing.
  const kept = stored(s.ws);
  assert.equal(S.record(s.ws, fields({ max_agents: null }), { now: t0 + 20 * MIN }), null);
  assert.equal(stored(s.ws), kept);

  // A record ahead of the desk's clock is unknown, and a real sighting replaces it.
  fs.writeFileSync(sightingFile(s.ws), JSON.stringify({ ...JSON.parse(kept), last_polled_at: '2099-01-01T00:00:00.000Z' }));
  const ahead = S.view(s.ws, { now: t0 + 20 * MIN });
  assert.equal(ahead.state, 'unknown');
  assert.equal(ahead.age_min, null);
  S.record(s.ws, fields(), { now: t0 + 20 * MIN });
  assert.equal(S.view(s.ws, { now: t0 + 21 * MIN }).state, 'fresh');

  // Corrupt, or not its shape: unknown, never fresh and never "never".
  for (const text of ['{ not json', JSON.stringify({ format: S.FORMAT, last_polled_at: 'yesterday', runner_id: 'x', invocation_id: INV, max_agents: 1 }), JSON.stringify({ format: 'other@1' }), JSON.stringify({ format: S.FORMAT, last_polled_at: '2026-11-02T12:00:00.000Z', runner_id: 'x', invocation_id: INV })]) {
    fs.writeFileSync(sightingFile(s.ws), text);
    const v = S.view(s.ws, { now: t0 });
    assert.equal(v.state, 'unknown', text);
    assert.equal(v.last_polled_at === null || typeof v.last_polled_at === 'string', true);
    assert.match(v.words, /unknown/);
  }
});

test('the runner sights only unattended, online and not dry; attended and dry runs keep the read-only GET', async (t) => {
  const s = desk(t);
  const real = noNetwork(t);
  const srv = await startDesk(t, s.ws);
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push(`${init.method || 'GET'} ${new URL(String(url)).pathname}`);
    const local = String(url).replace(DESK, `http://127.0.0.1:${srv.port}`);
    return real(local, { ...init, headers: { ...init.headers, host: `127.0.0.1:${srv.port}` } });
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pilot-liveness-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = (n) => ({ lockFile: path.join(dir, `${n}.lock`), logFile: path.join(dir, `${n}.jsonl`) });
  const lastLog = (n) => JSON.parse(fs.readFileSync(files(n).logFile, 'utf8').trim().split('\n').pop());
  const agent = () => { throw new Error('FICTIONAL: no session is started while paused'); };
  const base = { desk: 'online', deskUrl: DESK, maxAgents: 1, pilotAll: true };
  const quiet = () => {};

  // Attended: GET under the poll token; no sighting.
  seen.length = 0;
  assert.equal(await P.runAll({ ...base }, { fetchImpl, token: POLL, workerToken: WORKER, agent, out: quiet, ...files('attended') }), 0);
  assert.deepEqual(seen, ['GET /api/pilot/queue']);
  assert.equal(stored(s.ws), null);
  assert.equal(lastLog('attended').sighting, undefined);

  // Unattended but dry: still the GET; no sighting.
  seen.length = 0;
  assert.equal(await P.runAll({ ...base, unattended: true, model: 'claude-fictional', dryRun: true }, { fetchImpl, token: POLL, workerToken: WORKER, agent, out: quiet, ...files('dry') }), 0);
  assert.deepEqual(seen, ['GET /api/pilot/queue']);
  assert.equal(stored(s.ws), null);

  // Unattended, online, not dry: the worker poll, the runner's own ID and one
  // invocation ID; the poll token is not needed.
  envFor(t, { CR_PILOT_RUNNER_ID: 'render-cron' });
  seen.length = 0;
  const before = Date.now();
  assert.equal(await P.runAll({ ...base, unattended: true, model: 'claude-fictional' }, { fetchImpl, token: null, workerToken: WORKER, agent, out: quiet, newInvocationId: () => INV, ...files('prod') }), 0);
  assert.deepEqual(seen, ['POST /api/pilot/worker/poll']);
  const rec = JSON.parse(stored(s.ws));
  assert.equal(rec.runner_id, 'render-cron');
  assert.equal(rec.invocation_id, INV);
  assert.equal(rec.max_agents, 1);
  assert.ok(Date.parse(rec.last_polled_at) >= before - 1000);
  const log = lastLog('prod');
  assert.equal(log.paused, true);
  assert.deepEqual(log.sighting, { runner_id: 'render-cron', invocation_id: INV, last_polled_at: rec.last_polled_at });
  assert.equal(log.health, 'idle');
  assert.equal(S.view(s.ws).state, 'fresh');

  // A desk that refuses the worker poll fails the run (exit 1), never idle.
  delete process.env.CR_PILOT_WORKER_TOKEN_SHA256;
  assert.equal(await P.runAll({ ...base, unattended: true, model: 'claude-fictional' }, { fetchImpl, workerToken: WORKER, agent, out: quiet, ...files('refused') }), 1);
  assert.equal(lastLog('refused').health, 'failure');
});

test('the runner\'s ID: CR_PILOT_RUNNER_ID when set and valid, else the host name made safe; it never reaches a session', () => {
  assert.equal(P.runnerIdOf({ CR_PILOT_RUNNER_ID: ' render-cron ' }), 'render-cron');
  assert.throws(() => P.runnerIdOf({ CR_PILOT_RUNNER_ID: 'a/b' }), /CR_PILOT_RUNNER_ID/);
  assert.equal(P.runnerIdOf({}, 'srv-abc123'), 'srv-abc123');
  assert.equal(P.runnerIdOf({}, 'host name/with#odd'), 'host-name-with-odd');
  assert.equal(P.runnerIdOf({}, ''), 'pilot');
  assert.equal(P.runnerIdOf({}, 'x'.repeat(200)).length, 80);
  assert.equal(P.launchEnv({ CR_PILOT_RUNNER_ID: 'render-cron', PATH: '/bin' }).CR_PILOT_RUNNER_ID, undefined);
});
