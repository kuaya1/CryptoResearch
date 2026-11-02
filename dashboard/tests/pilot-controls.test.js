'use strict';
// Desk controls (core/desk-controls.js, cr-desk-controls@1; blueprint
// 2026-11-02 row 2, §6.2). FICTIONAL temporary workspaces; a real desk server
// on 127.0.0.1; no request leaves this machine. Covers: the five facts kept
// apart (a STALE poll beside a freshly saved report, neither read from the
// other); the read writes nothing and is signed in only; the off-only
// controls read back through the same view; reconcile only for an expired
// claim, only as {"reconciled":true}, and never a retry.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const DC = require('../core/desk-controls');
const S = require('../core/pilot-sighting');
const PC = require('../core/pilot-claims');
const T = require('../core/tickets');
const { hashTree } = require('./helpers');
const { mandateDesk, inDays } = require('./mandate-fixture');

const POLL = 'FICTIONAL-poll-token-0123456789abcdef';
const WORKER = 'FICTIONAL-worker-token-0123456789abcd';
const digest = (x) => crypto.createHash('sha256').update(x).digest('hex');
const MIN = 60000;

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
}

// A pilot project at the Prosecutor's step, with the paper mandate armed and
// automatic admission switched on (its values only).
function desk(t) {
  const s = mandateDesk(t, { mandate: true, settings: { automation: { autonomous_paper_loop: true, mandate: { expires_at: inDays(7), authority: { version: 'cr-mandate-authority@1', generation: 1, armed_at: new Date(Date.now() - MIN).toISOString(), armed_by: 'eric' } }, lead_admission: { enabled: true, daily_limit: 1, expires_at: inDays(7) } } } });
  T.setPilot(s.ws, s.pid, true);
  envFor(t, { CR_PILOT_POLL_TOKEN_SHA256: digest(POLL), CR_PILOT_WORKER_TOKEN_SHA256: digest(WORKER) });
  return s;
}

async function startDesk(t, ws) {
  const { start } = require('../server');
  const srv = await start(ws, { port: 49400 + Math.floor(Math.random() * 500), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } });
  return srv;
}

function request(port, p, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === null ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), origin: `http://127.0.0.1:${port}` } : {}), ...headers } }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(c).toString() || 'null') }); } catch (err) { reject(err); } });
    });
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data || undefined);
  });
}

test('the five facts stay apart: a STALE poll and a freshly saved report show together, and the read writes nothing', (t) => {
  const s = desk(t);
  const now = Date.now();
  // The production poll was last seen 200 minutes ago (stale after 120).
  S.record(s.ws, { runner_id: 'render-cron', invocation_id: 'inv-0000-fictional', max_agents: 1 }, { now: now - 200 * MIN });
  const before = hashTree(s.root);
  const v = DC.view(s.ws, { now });
  assert.deepEqual(hashTree(s.root), before, 'the view writes nothing');
  assert.equal(v.format, 'cr-desk-controls@1');
  assert.equal(v.writes_nothing, true);

  // Fact 1: the poll, STALE in words, with the note that it proves nothing else.
  assert.equal(v.poll.state, 'stale');
  assert.match(v.poll.words, /^STALE/);
  assert.equal(v.poll.note, DC.STALE_NOTE);
  assert.match(v.poll.note, /not proof that no grade exists or that no session is running/);

  // Fact 3: the report's own dates, beside the stale poll and untouched by it.
  assert.equal(v.projects.length, 1);
  const p = v.projects[0];
  assert.equal(p.project_id, s.pid);
  assert.ok(p.reports.claude, 'Claude\'s report is shown while the poll is stale');
  assert.ok(p.reports.claude.report_id);
  assert.ok(Number.isFinite(Date.parse(p.reports.claude.imported_at)), 'its save time');
  assert.ok(p.reports.claude.analysis_at, 'its analysis date');

  // Fact 2: no claim yet, said in words; the session ledger rides along.
  assert.equal(p.dispatch.state, 'none');
  assert.equal(p.controls.reconcile.available, false);
  assert.ok(v.dispatch.sessions && v.dispatch.sessions.unreadable === false);

  // Fact 4: what the book waits on, in its own words (no funding is set here).
  assert.ok(Array.isArray(v.freshness.book_waits));
  assert.ok(v.freshness.book_waits.some((w) => /not funded|not all set/.test(w)), JSON.stringify(v.freshness.book_waits));

  // Fact 5: authority, each part on its own.
  assert.equal(v.authority.paused, false);
  assert.equal(v.authority.mandate.loop_on, true);
  assert.equal(v.authority.admission.enabled, true);
  assert.equal(p.stop.stopped, false);

  // A fresh poll changes the poll fact only.
  S.record(s.ws, { runner_id: 'render-cron', invocation_id: 'inv-0001-fictional', max_agents: 1 }, { now });
  const w = DC.view(s.ws, { now });
  assert.equal(w.poll.state, 'fresh');
  assert.deepEqual(w.projects[0].reports, p.reports);
  assert.deepEqual(w.authority, v.authority);
});

test('signed-in only; each off-only control reads back through the same view', async (t) => {
  const s = desk(t);
  noNetwork(t);
  const srv = await startDesk(t, s.ws);
  const signed = { 'x-cr-token': srv.token };
  const read = async () => {
    const r = await request(srv.port, '/api/desk/controls', { headers: signed });
    assert.equal(r.status, 200);
    return r.json;
  };
  // The poll and worker bearers do not read it, and nobody unsigned does.
  for (const h of [{ authorization: `Bearer ${POLL}` }, { authorization: `Bearer ${WORKER}` }, {}]) {
    assert.equal((await request(srv.port, '/api/desk/controls', { headers: h })).status, 401);
  }

  let v = await read();
  // Only off actions are offered; each names the route it uses.
  for (const k of ['pause', 'mandate_off', 'admission_off']) {
    assert.equal(v.controls[k].available, true, k);
    assert.equal(v.controls[k].done, false, k);
    assert.equal(v.controls[k].path, '/api/settings');
  }
  assert.deepEqual(v.controls.pause.body, { automation: { paused: true } });
  assert.deepEqual(v.controls.mandate_off.body, { automation: { autonomous_paper_loop: false } });
  assert.deepEqual(v.controls.admission_off.body, { automation: { lead_admission: { enabled: false } } });
  assert.deepEqual(v.projects[0].controls.stop.body, { action: 'stop' });
  assert.ok(!JSON.stringify(v.controls).includes('rearm'), 'no control turns anything on');

  for (const k of ['mandate_off', 'admission_off', 'pause']) {
    const c = v.controls[k];
    const r = await request(srv.port, c.path, { method: c.method, body: c.body, headers: signed });
    assert.equal(r.status, 200, `${k}: ${JSON.stringify(r.json)}`);
    v = await read();
    assert.equal(v.controls[k].done, true, `${k} reads back`);
    assert.equal(v.controls[k].available, false, `${k} is not offered again`);
  }
  assert.equal(v.authority.paused, true);
  assert.equal(v.authority.mandate.loop_on, false);
  assert.equal(v.authority.mandate.on, false);
  assert.equal(v.authority.admission.enabled, false);
  assert.equal(v.authority.admission.on, false);

  const stop = v.projects[0].controls.stop;
  const r = await request(srv.port, stop.path, { method: stop.method, body: stop.body, headers: signed });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  v = await read();
  assert.equal(v.projects[0].stop.stopped, true);
  assert.match(v.projects[0].stop.words, /suspended/);
  assert.equal(v.projects[0].controls.stop.done, true);
  assert.equal(v.projects[0].controls.stop.available, false);
});

test('reconcile: offered only for an expired claim, only as reconciled, through the release route; never a retry', async (t) => {
  const s = desk(t);
  noNetwork(t);
  const srv = await startDesk(t, s.ws);
  const signed = { 'x-cr-token': srv.token };
  const read = async () => (await request(srv.port, '/api/desk/controls', { headers: signed })).json;

  // A live claim: a runner may be working, so nothing is offered and the route refuses.
  const live = PC.claim(s.ws, s.pid, { owner: 'FICTIONAL-runner' });
  assert.equal(live.status, 'claimed_now', JSON.stringify(live));
  let v = await read();
  assert.equal(v.projects[0].dispatch.state, 'claimed');
  assert.equal(v.projects[0].controls.reconcile.available, false);
  const early = await request(srv.port, `/api/projects/${s.pid}/pilot-claim/release`, { method: 'POST', body: { reconciled: true }, headers: signed });
  assert.notEqual(early.status, 200, 'a live claim is never released as reconciled');
  assert.equal(PC.read(s.ws, s.pid).released, false);
  PC.release(s.ws, s.pid, { token: live.token, outcome: 'done' });

  // A dispatch that expired with no known outcome.
  const past = Date.now() - 3 * PC.TTL_MS;
  const c = PC.claim(s.ws, s.pid, { owner: 'FICTIONAL-runner', now: past });
  assert.equal(c.status, 'claimed_now', JSON.stringify(c));
  PC.bind(s.ws, s.pid, c.token, { now: past + 1000 });
  v = await read();
  const d = v.projects[0].dispatch;
  assert.equal(d.state, 'reconcile');
  assert.equal(d.attempt_id, c.claim.attempt_id);
  assert.match(d.words, /release it as reconciled/);
  assert.match(d.words, /Nothing retries it/);
  const rc = v.projects[0].controls.reconcile;
  assert.equal(rc.available, true);
  assert.equal(rc.path, `/api/projects/${s.pid}/pilot-claim/release`);
  assert.deepEqual(rc.body, { reconciled: true });
  assert.equal(rc.attempt_id, c.claim.attempt_id);

  // Without {"reconciled":true} the route refuses and nothing changes.
  const bare = await request(srv.port, rc.path, { method: 'POST', body: {}, headers: signed });
  assert.equal(bare.status, 400);
  assert.equal(PC.read(s.ws, s.pid).released, false);
  // Unsigned, nothing at all.
  assert.equal((await request(srv.port, rc.path, { method: 'POST', body: rc.body })).status, 401);

  const r = await request(srv.port, rc.path, { method: rc.method, body: rc.body, headers: signed });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  v = await read();
  assert.equal(v.projects[0].dispatch.state, 'released');
  assert.equal(v.projects[0].dispatch.outcome, 'reconciled');
  assert.equal(v.projects[0].dispatch.attempt_id, c.claim.attempt_id, 'the same attempt, not a new one');
  assert.equal(v.projects[0].controls.reconcile.available, false);
  assert.equal(PC.read(s.ws, s.pid).attempt_id, c.claim.attempt_id, 'reconciling claimed nothing new');
});

test('the panel\'s words: the STALE poll and the fresh report are separate rows; the bodies it posts are the off switches the view names', async (t) => {
  const M = await import('../public/desk-controls-model.js');
  const s = desk(t);
  const now = Date.now();
  S.record(s.ws, { runner_id: 'render-cron', invocation_id: 'inv-0000-fictional', max_agents: 1 }, { now: now - 200 * MIN });
  const v = DC.view(s.ws, { now });

  const desk0 = M.deskRows(v);
  const poll = desk0.find((r) => r.key === 'poll');
  assert.equal(poll.state, 'STALE');
  assert.equal(poll.tone, 'warn');
  assert.match(poll.words, /not proof that no grade exists/);
  assert.equal(poll.title, DC.STALE_NOTE);
  const rows = M.projectRows(v.projects[0]);
  const rep = rows.find((r) => r.key === 'report-claude');
  assert.ok(rep, 'Claude\'s report has its own row while the poll is stale');
  assert.equal(rep.state, `Saved ${v.projects[0].reports.claude.imported_at}`);
  assert.match(rep.words, /^Analysis date /);
  assert.ok(rows.some((r) => r.key === 'dispatch' && r.state === 'No claim'));
  assert.ok(rows.some((r) => r.key === 'stop' && r.state === 'Not stopped'));
  // Every row says its state in a word.
  for (const r of [...desk0, ...rows]) assert.ok(typeof r.state === 'string' && r.state.length > 0, r.key);

  // The bodies the panel posts are exactly the view's off switches.
  for (const k of Object.keys(M.OFF_BODIES)) assert.deepEqual(M.OFF_BODIES[k], v.controls[k].body, k);
  assert.deepEqual(M.offActions(v).map((a) => a.id), ['pause', 'mandate_off', 'admission_off']);
  assert.equal(M.readback(v, 'pause').ok, false);
  assert.match(M.readback(v, 'pause').words, /does not read back that automation is paused/);
  const paused = { ...v, controls: { ...v.controls, pause: { ...v.controls.pause, done: true } } };
  assert.deepEqual(M.readback(paused, 'pause'), { ok: true, words: 'Read back: automation is paused.' });
  assert.equal(M.readback(v, 'reconcile', s.pid).ok, false);
});
