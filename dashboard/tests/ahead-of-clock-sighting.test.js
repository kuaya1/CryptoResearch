'use strict';
// Audit F9 (2026-11-02): a production poll record ahead of the desk's clock.
// It used to read fresh when it stood up to 5 minutes ahead (its age clamped
// to 0), and a poll at the earlier clock overwrote one further ahead, moving
// last_polled_at backward. Now a record ahead by any amount reads unknown,
// and a poll at a clock behind it keeps it byte for byte; once the clock has
// passed it, the next poll writes again on the desk's clock. Covered through
// the module, the worker's POST poll, the signed-in read and the desk's
// controls; the read-only GET still writes nothing, and the thresholds
// (120 min, max_agents × 95 + 15) are untouched. FICTIONAL workspace on
// 127.0.0.1, paused so no agent is dispatched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const S = require('../core/pilot-sighting');
const DC = require('../core/desk-controls');
const { hashTree } = require('./helpers');
const { mandateDesk } = require('./mandate-fixture');

const POLL = 'FICTIONAL-poll-token-0123456789abcdef';
const WORKER = 'FICTIONAL-worker-token-0123456789abcd';
const digest = (t) => crypto.createHash('sha256').update(t).digest('hex');
const SEC = 1000;
const MIN = 60 * SEC;
const DAY = 24 * 60 * MIN;
const INV = 'inv-0000-fictional';
const fields = (extra = {}) => ({ runner_id: 'render-cron', invocation_id: INV, max_agents: 1, ...extra });

function envFor(t, vars) {
  for (const [k, v] of Object.entries(vars)) {
    const before = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
    t.after(() => { if (before === undefined) delete process.env[k]; else process.env[k] = before; });
  }
}

function desk(t) {
  const s = mandateDesk(t, { mandate: false, settings: { automation: { paused: true } } });
  envFor(t, { CR_PILOT_POLL_TOKEN_SHA256: digest(POLL), CR_PILOT_WORKER_TOKEN_SHA256: digest(WORKER), CR_PILOT_RUNNER_ID: undefined });
  return s;
}

const file = (ws) => ws.abs(S.REL);
const stored = (ws) => (fs.existsSync(file(ws)) ? fs.readFileSync(file(ws), 'utf8') : null);
function plant(ws, atMs) {
  const text = `${JSON.stringify({ format: S.FORMAT, last_polled_at: new Date(atMs).toISOString(), runner_id: 'render-cron', invocation_id: 'inv-ahead-fictional', max_agents: 1 }, null, 2)}\n`;
  fs.mkdirSync(require('path').dirname(file(ws)), { recursive: true });
  fs.writeFileSync(file(ws), text);
  return text;
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

test('a record ahead of the desk\'s clock by any amount reads unknown, and a poll behind it never moves it back', (t) => {
  const s = desk(t);
  const t0 = Date.parse('2026-11-02T12:00:00.000Z');
  // Small and large offsets, both sides of the old 5-minute allowance.
  for (const [label, offset] of [['1 s', SEC], ['1 min', MIN], ['5 min', 5 * MIN], ['5 min 1 s', 5 * MIN + SEC], ['1 day', DAY], ['73 years', Date.parse('2099-01-01T00:00:00.000Z') - t0]]) {
    const text = plant(s.ws, t0 + offset);
    const v = S.view(s.ws, { now: t0 });
    assert.equal(v.state, 'unknown', `${label} ahead reads unknown, never fresh`);
    assert.equal(v.age_min, null, `${label}: no age is made up`);
    assert.equal(v.ahead_ms, offset);
    assert.match(v.words, /is ahead of the desk's clock by .+; whether the runner is polling is unknown\. A later poll does not move it back\./, label);
    assert.equal(v.last_polled_at, new Date(t0 + offset).toISOString(), 'the record is said as it is');

    // A poll at the earlier clock keeps the record byte for byte.
    const kept = S.record(s.ws, fields(), { now: t0 });
    assert.equal(kept.last_polled_at, new Date(t0 + offset).toISOString(), `${label}: the poll answers with the record kept`);
    assert.equal(stored(s.ws), text, `${label}: last_polled_at did not move backward`);
    // One millisecond short of the record is still ahead, still unknown, still kept.
    S.record(s.ws, fields(), { now: t0 + offset - 1 });
    assert.equal(stored(s.ws), text);
    assert.equal(S.view(s.ws, { now: t0 + offset - 1 }).state, 'unknown');

    // At the record's own time it is fresh at age 0, and once the clock has
    // passed it the next poll writes again on the desk's clock.
    assert.equal(S.view(s.ws, { now: t0 + offset }).state, 'fresh');
    assert.equal(S.view(s.ws, { now: t0 + offset }).age_min, 0);
    const later = t0 + offset + 30 * SEC;
    assert.equal(S.record(s.ws, fields({ invocation_id: 'inv-later-fictional' }), { now: later }).last_polled_at, new Date(later).toISOString());
    const v2 = S.view(s.ws, { now: later + MIN });
    assert.equal(v2.state, 'fresh');
    assert.equal(v2.invocation_id, 'inv-later-fictional');
    assert.equal(v2.ahead_ms, undefined);
  }
  // The threshold is the desk's 120 min whatever the runner declares (Q2,
  // blueprint 2026-11-03 §4 PR 1; no 95 × N sessions past the desk's cap).
  assert.deepEqual([S.staleAfterMin(1), S.staleAfterMin(2), S.staleAfterMin(4)], [120, 120, 120]);
  assert.equal(S.SKEW_MS, undefined, 'no allowance in which a future record reads fresh');
});

test('through the worker\'s poll, the signed-in read and the desk\'s controls: ahead is unknown, kept, and the GET writes nothing', async (t) => {
  const s = desk(t);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (new URL(String(url)).hostname === '127.0.0.1') return realFetch(url, init);
    throw new Error('FICTIONAL: no network');
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const { start } = require('../server');
  const srv = await start(s.ws, { port: 49400 + Math.floor(Math.random() * 500), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } });

  for (const [label, offset] of [['1 min', MIN], ['1 day', DAY]]) {
    const text = plant(s.ws, Date.now() + offset);
    // The read-only GET answers and writes nothing.
    const got = await request(srv.port, '/api/pilot/queue', { headers: bearer(POLL) });
    assert.equal(got.status, 200);
    assert.equal(stored(s.ws), text, `${label}: the GET wrote nothing`);

    // The worker's poll answers its snapshot and keeps the record ahead.
    const r = await request(srv.port, '/api/pilot/worker/poll', { method: 'POST', body: fields({ invocation_id: 'inv-behind-fictional' }), headers: bearer(WORKER) });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'polled');
    assert.equal(r.json.poll.format, 'cr-pilot-poll@1', 'the snapshot is still answered');
    assert.equal(r.json.sighting.invocation_id, 'inv-ahead-fictional', `${label}: the record ahead is what the desk holds`);
    assert.equal(stored(s.ws), text, `${label}: the poll did not move last_polled_at backward`);

    // The signed-in read and the desk's controls say unknown, never fresh.
    const v = await request(srv.port, '/api/pilot/sighting', { headers: { 'x-cr-token': srv.token } });
    assert.equal(v.status, 200);
    assert.equal(v.json.state, 'unknown', `${label}: the signed-in read`);
    assert.equal(v.json.age_min, null);
    const before = hashTree(s.root);
    const dc = DC.view(s.ws, {});
    assert.deepEqual(hashTree(s.root), before, 'the controls read writes nothing');
    assert.equal(dc.poll.state, 'unknown', `${label}: the desk's controls`);
    assert.match(dc.poll.words, /ahead of the desk's clock/);
  }

  // A record behind the clock is replaced by the next real poll, on the desk's clock.
  plant(s.ws, Date.now() - 10 * MIN);
  const beforePoll = Date.now();
  const r = await request(srv.port, '/api/pilot/worker/poll', { method: 'POST', body: fields({ invocation_id: 'inv-real-fictional' }), headers: bearer(WORKER) });
  assert.equal(r.status, 200);
  assert.equal(r.json.sighting.invocation_id, 'inv-real-fictional');
  assert.ok(Date.parse(r.json.sighting.last_polled_at) >= beforePoll - SEC);
  assert.equal((await request(srv.port, '/api/pilot/sighting', { headers: { 'x-cr-token': srv.token } })).json.state, 'fresh');
});
