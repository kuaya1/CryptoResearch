'use strict';
// Bounded live updates (audit V2-006), server side. Pages ask GET /api/version
// while visible instead of holding an event stream open. This checks what
// that endpoint promises: a small answer, a sequence that moves only when the
// served index changes, the projects that changed, a fresh start after a gap
// or a restart, and that many pollers hold no stream open. Browser behavior
// (hidden pages, back/forward cache, seven windows) is checked in a browser.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { tempWorkspace, addFixtureProject } = require('./helpers');
const { start } = require('../server');
const { ymdInTz } = require('../core/dates');
const { atomicWrite, jsonText } = require('../core/fsx');

const PORT = 48600 + Math.floor(Math.random() * 300);

function request(port, { method = 'GET', path = '/', token, body = null, agent = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host: `127.0.0.1:${port}`, 'x-cr-token': token };
    if (method === 'POST') Object.assign(headers, { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' });
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, bytes: Buffer.byteLength(text), body: JSON.parse(text) });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('V2-006 /api/version: small answers, a sequence that moves with the index, the projects that changed', async (t) => {
  const { ws, cleanup } = tempWorkspace('v2006');
  const pid = addFixtureProject(ws).project_id;
  const today = ymdInTz(new Date());
  atomicWrite(ws.abs('logs/jobs-state.json'), jsonText({ schema_version: 'cr.jobs-state.v1', jobs: { snapshot: { last_success_day: today }, reviews: { last_success_day: today }, backup: { last_success_day: today } }, runner: {} }));
  let srv = await start(ws, { port: PORT, quiet: true });
  t.after(() => {
    try { srv.shutdown(); } catch (_) { /* stopped */ }
    cleanup();
  });
  const idx = await request(srv.port, { path: '/api/index', token: srv.token });
  assert.equal(idx.status, 200);
  const { seq, instance } = idx.body.live;
  assert.equal(typeof seq, 'number');
  const v0 = await request(srv.port, { path: `/api/version?since=${seq}`, token: srv.token });
  assert.equal(v0.status, 200);
  assert.equal(v0.body.instance, instance);
  assert.ok(v0.bytes < 2000, `a poll answer is small (${v0.bytes} bytes)`);
  // Without the token: refused like every other API route.
  const noToken = await request(srv.port, { path: '/api/version', token: 'wrong' });
  assert.equal(noToken.status, 401);
  // A write moves the sequence and names the project that changed.
  const w = await request(srv.port, { method: 'POST', path: `/api/projects/${pid}/watchlist`, token: srv.token, body: { on: false } });
  assert.equal(w.status, 200);
  const v1 = await request(srv.port, { path: `/api/version?since=${seq}`, token: srv.token });
  assert.ok(v1.body.seq > seq, 'the sequence moved');
  assert.ok(v1.body.changes.some((c) => Array.isArray(c.projects) && c.projects.includes(pid)), JSON.stringify(v1.body.changes));
  // Nothing changed since: an empty list, not a refetch.
  const v2 = await request(srv.port, { path: `/api/version?since=${v1.body.seq}`, token: srv.token });
  assert.deepEqual(v2.body.changes, []);
  // A position the server does not know (a gap, or another server's): refetch everything.
  const v3 = await request(srv.port, { path: `/api/version?since=${v1.body.seq + 1000}`, token: srv.token });
  assert.equal(v3.body.changes, null);
  // Twelve windows polling at once: every poll is answered and no stream stays open.
  const agents = Array.from({ length: 12 }, () => new http.Agent({ keepAlive: true, maxSockets: 6 }));
  for (let round = 0; round < 3; round++) {
    const answers = await Promise.all(agents.map((agent) => request(srv.port, { path: `/api/version?since=${v1.body.seq}`, token: srv.token, agent })));
    assert.ok(answers.every((a) => a.status === 200));
  }
  const stats = await request(srv.port, { path: '/api/server-stats', token: srv.token });
  assert.equal(stats.body.event_streams_open, 0);
  assert.ok(stats.body.requests['/api/version'] >= 36);
  agents.forEach((a) => a.destroy());
  // A restart is a new instance: pages refetch instead of trusting old positions.
  srv.shutdown();
  srv = await start(ws, { port: PORT + 20, quiet: true });
  const v4 = await request(srv.port, { path: `/api/version?since=${v1.body.seq}`, token: srv.token });
  assert.notEqual(v4.body.instance, instance);
});
