'use strict';
// The optional heartbeat (blueprint 2026-11-02 §6.1, build plan row 7): with
// CR_HEALTHCHECK_URL set, a --pilot-all run sends at most two bare GETs,
// /start?rid= and one final ping by its health class; a failed ping never
// changes the exit code; the URL is never printed, logged or given to a
// session. Stubbed fetch only: no network. FICTIONAL URL.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../scripts/pilot');

const HC = 'https://hc.fictional.example/ping/0f0f0f0f-FICTIONAL';
const RID = '11111111-2222-4333-8444-555555555555';

function files(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pilot-hc-test-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return { lockFile: path.join(d, 'pilot-all.lock'), logFile: path.join(d, 'pilot-all.jsonl') };
}
const lastLog = (f) => JSON.parse(fs.readFileSync(f, 'utf8').trim().split('\n').pop());

// A local desk whose queue holds the given steps; nothing is dispatched
// unless a step needs an agent, and the stub agent and runLocal decide how
// the dispatch ends.
function desk(steps = [], { paused = false } = {}) {
  return (args) => (args[1] === 'queue' ? { steps: steps.map(([project_id, step]) => ({ project_id, name: project_id, step, why: 'FICTIONAL' })), pending: [], paused, claims: {} } : {});
}
function pinger({ fail = false, hang = false, status = 200 } = {}) {
  const urls = [];
  const fn = async (url, init) => {
    urls.push({ url, init });
    if (hang) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))));
    if (fail) throw new TypeError('fetch failed');
    return { status, ok: status >= 200 && status < 300 };
  };
  return { urls, fn };
}
async function run(t, { steps = [], stop = undefined, error = null, env = { CR_HEALTHCHECK_URL: HC }, ping = pinger(), o = {}, paused = false } = {}) {
  const f = files(t);
  const said = [];
  const runLocalImpl = () => { if (error) throw new Error(error); return { stop: stop === undefined ? null : stop }; };
  const code = await P.runAll({ desk: 'local', maxAgents: 2, ...o }, { call: desk(steps, { paused }), agent: () => '', runLocalImpl, env, pingFetch: ping.fn, newRid: () => RID, out: (s) => said.push(s), ...f });
  return { code, said, log: lastLog(f.logFile), ping, f };
}

test('the URL: https only, no credentials, query or fragment; trailing slash dropped; unset means no heartbeat', () => {
  assert.equal(P.HEARTBEAT_ENV, 'CR_HEALTHCHECK_URL');
  assert.equal(P.HEARTBEAT_TIMEOUT_MS, 5000);
  assert.deepEqual(P.heartbeatBase({}), { base: null, words: null });
  assert.deepEqual(P.heartbeatBase({ CR_HEALTHCHECK_URL: '  ' }), { base: null, words: null });
  assert.equal(P.heartbeatBase({ CR_HEALTHCHECK_URL: `${HC}/` }).base, HC);
  for (const bad of ['http://hc.fictional.example/ping/x', 'https://u:p@hc.fictional.example/ping/x', `${HC}?a=1`, `${HC}#x`, 'https://hc.fictional.example/', 'not a url']) {
    const r = P.heartbeatBase({ CR_HEALTHCHECK_URL: bad });
    assert.equal(r.base, null, bad);
    assert.match(r.words, /not an https ping URL/);
    assert.ok(!r.words.includes('fictional'), 'the value is never repeated');
  }
});

test('each health class has one final ping: ok and idle /0, attention /fail, failure /1, reconcile /3', () => {
  assert.deepEqual(P.HEARTBEAT_FINAL, { ok: '0', idle: '0', attention: 'fail', failure: '1', reconcile: '3' });
  for (const c of P.HEALTH_ORDER) assert.ok(P.HEARTBEAT_FINAL[c], c);
  assert.equal(P.heartbeatFinal('something new'), '1', 'an unknown class is a failure');
});

test('a run with nothing to do sends /start then /0, both with the same rid, as bare GETs', async (t) => {
  const r = await run(t);
  assert.equal(r.code, 0);
  assert.deepEqual(r.ping.urls.map((u) => u.url), [`${HC}/start?rid=${RID}`, `${HC}/0?rid=${RID}`]);
  for (const u of r.ping.urls) {
    assert.equal(u.init.method, 'GET');
    assert.ok(!('body' in u.init) && !('headers' in u.init), 'no body, no headers');
    assert.ok(u.init.signal, 'bounded by a timeout');
  }
  assert.deepEqual(r.log.heartbeat, { rid: RID, start: 'sent', final: '0', final_sent: 'sent' });
});

test('the final ping follows the run\'s class, and the exit code stays as it was', async (t) => {
  const cases = [
    { name: 'idle (a dispatch that ran no session; a save is ok, also /0: pilot-health-flow.test.js)', steps: [['olas', 'research']], stop: null, final: '0', code: 0 },
    { name: 'idle (paused)', paused: true, final: '0', code: 0 },
    { name: 'attention (claimed)', steps: [['olas', 'research']], stop: 'claimed', final: 'fail', code: 0 },
    { name: 'failure (refused)', steps: [['olas', 'research']], stop: 'refused', final: '1', code: 0 },
    { name: 'reconcile', steps: [['olas', 'research']], stop: 'reconcile', final: '3', code: 3 },
    { name: 'failure (dispatch error)', steps: [['olas', 'research']], error: 'FICTIONAL boom', final: '1', code: 1 },
  ];
  for (const c of cases) {
    const r = await run(t, c);
    assert.equal(r.code, c.code, c.name);
    assert.equal(r.ping.urls.length, 2, `${c.name}: at most two pings`);
    assert.equal(r.ping.urls[1].url, `${HC}/${c.final}?rid=${RID}`, c.name);
  }
});

test('a locked run pings /fail; a bad --desk pings /1', async (t) => {
  const f = files(t);
  fs.mkdirSync(path.dirname(f.lockFile), { recursive: true });
  fs.writeFileSync(f.lockFile, JSON.stringify({ pid: 999999, started_at: new Date().toISOString() }));
  const ping = pinger();
  const code = await P.runAll({ desk: 'local', maxAgents: 2 }, { call: desk(), agent: () => '', env: { CR_HEALTHCHECK_URL: HC }, pingFetch: ping.fn, newRid: () => RID, out: () => {}, ...f });
  assert.equal(code, 0);
  assert.deepEqual(ping.urls.map((u) => u.url), [`${HC}/start?rid=${RID}`, `${HC}/fail?rid=${RID}`]);
  const bad = await run(t, { o: { desk: 'paper' } });
  assert.equal(bad.code, 1);
  assert.equal(bad.ping.urls[1].url, `${HC}/1?rid=${RID}`);
});

test('a ping that fails or hangs never changes the exit code or the run', async (t) => {
  const failed = await run(t, { steps: [['olas', 'research']], stop: 'reconcile', ping: pinger({ fail: true }) });
  assert.equal(failed.code, 3);
  assert.equal(failed.log.heartbeat.start, 'unreachable');
  assert.equal(failed.log.heartbeat.final_sent, 'unreachable');
  assert.equal(failed.log.dispatches.length, 1, 'the dispatch ran despite the failed start ping');
  assert.ok(failed.said.some((s) => /final ping was not delivered \(unreachable\); the run's result is unchanged/.test(s)));
  const ok = await run(t, { ping: pinger({ fail: true }) });
  assert.equal(ok.code, 0);
  // A hang is cut at the timeout (stubbed through the signal).
  const r = await P.sendPing(pinger({ hang: true }).fn, `${HC}/0`, 20);
  assert.deepEqual(r, { sent: false, ok: false, status: null, reason: 'timeout' });
});

// Audit A4 (blueprint 2026-11-03 §4 PR 1): before it, a 503 from the service
// was logged start "sent", final_sent "sent". A refusal is now its status.
test('an HTTP refusal (503) is recorded as http_503, never "sent", and the exit code and the run stay as they were', async (t) => {
  const refused = await run(t, { steps: [['olas', 'research']], stop: 'reconcile', ping: pinger({ status: 503 }) });
  assert.equal(refused.code, 3, 'the exit code is the run own');
  assert.equal(refused.ping.urls.length, 2, 'never retried');
  assert.equal(refused.log.heartbeat.start, 'http_503');
  assert.equal(refused.log.heartbeat.final, '3');
  assert.equal(refused.log.heartbeat.final_sent, 'http_503');
  assert.equal(refused.log.dispatches.length, 1, 'the dispatch ran despite the refused start ping');
  assert.equal(refused.log.health, 'reconcile', 'the health class is unchanged');
  assert.ok(refused.said.some((s) => /start ping was refused \(HTTP 503\); the run's result is unchanged/.test(s)));
  assert.ok(refused.said.some((s) => /final ping was refused \(HTTP 503\); the run's result is unchanged/.test(s)));
  const idle = await run(t, { ping: pinger({ status: 503 }) });
  assert.equal(idle.code, 0);
  assert.equal(idle.log.heartbeat.final_sent, 'http_503');
  // sendPing itself: delivered only on 2xx.
  assert.deepEqual(await P.sendPing(pinger({ status: 503 }).fn, `${HC}/0`), { sent: true, ok: false, status: 503 });
  assert.deepEqual(await P.sendPing(pinger({ status: 204 }).fn, `${HC}/0`), { sent: true, ok: true, status: 204 });
  assert.equal(P.pingWord({ sent: true, ok: false, status: 429 }), 'http_429');
  assert.equal(P.pingWord({ sent: true, ok: true, status: 200 }), 'sent');
  assert.equal(P.pingWord({ sent: false, ok: false, status: null, reason: 'timeout' }), 'timeout');
});

test('no heartbeat without the URL, in a dry run, or with a URL that does not read', async (t) => {
  const none = await run(t, { env: {} });
  assert.equal(none.ping.urls.length, 0);
  assert.ok(!('heartbeat' in none.log));
  const dry = await run(t, { o: { dryRun: true }, steps: [['olas', 'research']] });
  assert.equal(dry.ping.urls.length, 0);
  const bad = await run(t, { env: { CR_HEALTHCHECK_URL: 'http://hc.fictional.example/ping/x' } });
  assert.equal(bad.ping.urls.length, 0);
  assert.equal(bad.code, 0);
  assert.ok(bad.said.some((s) => /not an https ping URL/.test(s)));
});

test('the ping URL is never printed, logged or given to a session', async (t) => {
  const r = await run(t, { steps: [['olas', 'research']], stop: 'refused' });
  const raw = fs.readFileSync(r.f.logFile, 'utf8');
  for (const s of [raw, r.said.join('\n')]) assert.ok(!s.includes('hc.fictional.example') && !s.includes('0f0f0f0f'), 'the URL leaked');
  assert.ok(!('CR_HEALTHCHECK_URL' in P.launchEnv({ CR_HEALTHCHECK_URL: HC, PATH: '/bin' })));
});
