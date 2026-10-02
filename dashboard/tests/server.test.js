'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { tempWorkspace } = require('./helpers');
const { start } = require('../server');
const projects = require('../core/projects');
const { openWorkspace } = require('../core/workspace');

function request(port, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function waitForEvent(port, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error('no matching change event'));
    }, timeoutMs);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/events', headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c.toString('utf8');
        for (const block of buf.split('\n\n')) {
          const m = block.match(/^event: changed\ndata: (.*)$/m);
          if (m) {
            const ev = JSON.parse(m[1]);
            if (predicate(ev)) {
              clearTimeout(timer);
              req.destroy();
              resolve(ev);
              return;
            }
          }
        }
      });
    });
    req.on('error', () => {});
    req.end();
  });
}

const PORT = 47000 + Math.floor(Math.random() * 500);

test('local server: loopback only, host and origin checks, token, traversal, live refresh and restart', async (t) => {
  const { ws, root, cleanup } = tempWorkspace('srv');
  const srv = await start(ws, { port: PORT, quiet: true });
  t.after(() => {
    try { srv.shutdown(); } catch (_) { /* already stopped */ }
    cleanup();
  });
  const port = srv.port;

  await t.test('binds to 127.0.0.1 only', () => {
    assert.equal(srv.server.address().address, '127.0.0.1');
  });

  await t.test('serves the page with a strict content security policy', async () => {
    const r = await request(port, { path: '/' });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-security-policy'], /default-src 'self'/);
    assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['access-control-allow-origin'], undefined);
  });

  await t.test('rejects foreign Host headers (DNS rebinding)', async () => {
    const r = await request(port, { path: '/api/session', headers: { host: 'evil.example:80' } });
    assert.equal(r.status, 403);
  });

  await t.test('API needs the per-launch token', async () => {
    assert.equal((await request(port, { path: '/api/index' })).status, 401);
  });

  const session = JSON.parse((await request(port, { path: '/api/session' })).body);
  const token = session.token;
  const good = { 'x-cr-token': token, 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` };

  await t.test('writes from another origin, without an origin, or cross-site are refused', async () => {
    const body = { name: 'Should Not Exist', identity_status: 'pending' };
    assert.equal((await request(port, { method: 'POST', path: '/api/projects', headers: { ...good, origin: 'https://evil.example' }, body })).status, 403);
    const noOrigin = { ...good };
    delete noOrigin.origin;
    assert.equal((await request(port, { method: 'POST', path: '/api/projects', headers: noOrigin, body })).status, 403);
    assert.equal((await request(port, { method: 'POST', path: '/api/projects', headers: { ...good, 'sec-fetch-site': 'cross-site' }, body })).status, 403);
    assert.equal((await request(port, { method: 'POST', path: '/api/projects', headers: { ...good, 'content-type': 'text/plain' }, body })).status, 415);
    assert.deepEqual(projects.listProjects(ws), []);
  });

  await t.test('no file access outside dashboard/public and no paths through the API', async () => {
    for (const p of ['/../workspace.json', '/..%2f..%2fworkspace.json', '/%2e%2e/%2e%2e/config/settings.json', '/..\\..\\workspace.json', '/server.js', '/%2e%2e%5cworkspace.json']) {
      const r = await request(port, { path: p });
      assert.ok([400, 403, 404].includes(r.status), `${p} -> ${r.status}`);
      assert.ok(!r.body.includes('workspace_id'), `${p} leaked a file`);
    }
    const r = await request(port, { path: '/api/projects/..%2F..%2Fportfolio', headers: { 'x-cr-token': token } });
    assert.equal(r.status, 400);
  });

  await t.test('a valid same-origin write works', async () => {
    const r = await request(port, { method: 'POST', path: '/api/projects', headers: good, body: { name: 'Server Test Project', identity_status: 'pending' } });
    assert.equal(r.status, 200, r.body);
    assert.equal(JSON.parse(r.body).status, 'created');
  });

  await t.test('a change made outside the server (as Cowork or the CLI would) reaches open pages', async () => {
    const waiting = waitForEvent(port, (ev) => (ev.projects || []).includes('outside-change'));
    await new Promise((r) => setTimeout(r, 300));
    const other = openWorkspace({ root, actor: 'cli' });
    projects.addProject(other, { name: 'Outside Change', identity_status: 'pending' });
    const ev = await waiting;
    assert.ok(ev.projects.includes('outside-change'));
    const idx = JSON.parse((await request(port, { path: '/api/index', headers: { 'x-cr-token': token } })).body);
    assert.ok(idx.projects.some((p) => p.project_id === 'outside-change'));
    const health = JSON.parse((await request(port, { path: '/api/health?project=outside-change' })).body);
    assert.equal(health.project_present, true);
  });

  await t.test('records survive a restart', async () => {
    srv.shutdown();
    const ws2 = openWorkspace({ root, actor: 'dashboard' });
    const again = await start(ws2, { port: PORT + 600, quiet: true });
    try {
      const s2 = JSON.parse((await request(again.port, { path: '/api/session' })).body);
      assert.notEqual(s2.token, token, 'new token per launch');
      const idx = JSON.parse((await request(again.port, { path: '/api/index', headers: { 'x-cr-token': s2.token } })).body);
      const ids = idx.projects.map((p) => p.project_id).sort();
      assert.deepEqual(ids, ['outside-change', 'server-test-project']);
    } finally {
      again.shutdown();
    }
  });
});
