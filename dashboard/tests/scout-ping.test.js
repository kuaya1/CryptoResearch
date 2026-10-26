'use strict';
// GET /api/ingest/ping, the Scout ingestion service's health ping (backlog
// item 66): on the hosted desk the front door refuses it without sign-in, and
// signed in with the session token it answers status, service and the time,
// nothing else. A FICTIONAL temporary desk on this PC only; no model, market
// or network is called. Test passphrases only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const hosted = require('../hosted');
const { start } = require('../server');
const { readJson } = require('../core/fsx');

const PASS = 'test-passphrase-not-real';
const HOST = 'desk.test';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function req(port, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: HOST, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

// The real hosted server on a FICTIONAL desk, prices off. The temp folder
// stands for the persistent disk: a mount of its own in the table the config
// reads, written as the disk check reads paths (POSIX), so the desk starts
// the same on Linux and on Windows (as engineering-guard.test.js does).
async function desk(t) {
  const port = await freePort();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-scout-ping-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 }));
  const env = { CR_DATA_DIR: path.join(base, 'data'), CR_ACCESS_PASSWORD: PASS, PORT: String(port), RENDER_EXTERNAL_HOSTNAME: HOST };
  const opts = { platform: 'linux', mountsText: `/dev/vda / ext4 rw 0 0\n/dev/vdb ${path.posix.resolve(base.replace(/\\/g, '/'))} ext4 rw 0 0\n` };
  const cfg = hosted.hostedConfig(env, opts);
  assert.deepEqual(cfg.problems, [], 'the fictional desk is fully configured');
  const ws = hosted.prepareWorkspace(cfg);
  const file = path.join(ws.root, 'config', 'settings.json');
  const s = readJson(file);
  s.market_data = { ...(s.market_data || {}), enabled: false };
  fs.writeFileSync(file, JSON.stringify(s));
  ws.reloadSettings();
  const srv = await start(ws, { quiet: true, hosted: { port, hosts: cfg.hosts, password: cfg.password, bind: '127.0.0.1', failDelayMs: 0 } });
  t.after(() => srv.shutdown());
  return { port };
}

// Signs in with the passphrase form and reads the page's session token.
async function signIn(port) {
  const ok = await req(port, { method: 'POST', path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: `https://${HOST}` }, body: `password=${encodeURIComponent(PASS)}` });
  assert.equal(ok.status, 303);
  const cookie = ok.headers['set-cookie'][0].split(';')[0];
  const sess = await req(port, { path: '/api/session', headers: { cookie } });
  assert.equal(sess.status, 200);
  return { cookie, token: sess.json.token };
}

test('scout ping: the front door refuses it without sign-in, as every other /api route', async (t) => {
  const { port } = await desk(t);
  const r = await req(port, { path: '/api/ingest/ping' });
  assert.equal(r.status, 401);
  assert.match(r.headers['content-type'], /^application\/json/);
  assert.match(r.json.error, /Signed out/);
  assert.equal(r.json.status, undefined, 'nothing of the ping is answered');
  // Other routes keep the same refusal.
  assert.equal((await req(port, { path: '/api/version' })).status, 401);
});

test('scout ping: signed in, it answers 200 with exactly status, service and an ISO timestamp', async (t) => {
  const { port } = await desk(t);
  const { cookie, token } = await signIn(port);
  // Signed in but without the page's session token: refused as every route is.
  assert.equal((await req(port, { path: '/api/ingest/ping', headers: { cookie } })).status, 401);
  const before = Date.now();
  const r = await req(port, { path: '/api/ingest/ping', headers: { cookie, 'x-cr-token': token } });
  const after = Date.now();
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^application\/json/);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(r.json).sort(), ['service', 'status', 'timestamp']);
  assert.equal(r.json.status, 'ok');
  assert.equal(r.json.service, 'scout-ingest');
  assert.equal(typeof r.json.timestamp, 'string');
  assert.match(r.json.timestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  const at = Date.parse(r.json.timestamp);
  assert.equal(new Date(at).toISOString(), r.json.timestamp, 'a valid ISO date, read back unchanged');
  assert.ok(at >= before - 1000 && at <= after + 1000, 'the time of the answer');
  // Only GET answers it.
  assert.equal((await req(port, { method: 'POST', path: '/api/ingest/ping', headers: { cookie, 'x-cr-token': token, origin: `https://${HOST}`, 'content-type': 'application/json' }, body: '{}' })).status, 404);
});
