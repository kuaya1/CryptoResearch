'use strict';
// The guard of the front door and the engineering gate (review N1, N2, N3,
// 2026-10-26). This file is protected (backlog-promote.js PROTECTED) and run
// by name in backlog-pr.yml's compose job, so a branch cannot weaken it on
// its way in. It checks behaviour, not spelling: a handler whose route is
// built at run time ('/eng' + 'ineering') is caught by the front door's audit
// and stops the online desk from starting, every module the engineering gate
// loads is protected, and a link is never served. A FICTIONAL temporary desk;
// no model, market or network is called.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { readJson } = require('../core/fsx');
const F = require('../frontdoor');
const { PROTECTED, protectedHit, DELEGATION_RESTRICTED, foldPath } = require('../scripts/backlog-promote');
const P = require('../engineering/policy');

const PASS = 'test-passphrase-not-real';
const HOST = 'desk.test';
const DASH = path.join(__dirname, '..');
const REPO = path.join(DASH, '..');
const rel = (abs) => path.relative(REPO, abs).split(path.sep).join('/');
const REQUEST_EVENTS = ['request', 'checkContinue', 'checkExpectation', 'upgrade', 'connect'];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}
function req(port, { method = 'GET', path: p = '/', host = HOST } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host } }, (res) => {
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
    r.end();
  });
}

// The hosted environment of a FICTIONAL desk, its workspace prepared with
// market data off. The temp folder stands for the persistent disk: a mount of
// its own in the table the config reads, written as the disk check reads
// paths (POSIX), so the desk starts the same on Linux and on Windows
// (hosted.test.js does the same).
function hostedEnv(t, label, port) {
  const hosted = require('../hosted');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `cr-guard-${label}-`));
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
  return { env, opts, cfg, ws };
}

// The real hosted server, bound to this PC only.
async function desk(t, label) {
  const { start } = require('../server');
  const port = await freePort();
  const { cfg, ws } = hostedEnv(t, label, port);
  const srv = await start(ws, { quiet: true, hosted: { port, hosts: cfg.hosts, password: cfg.password, bind: '127.0.0.1', failDelayMs: 0 } });
  t.after(() => srv.shutdown());
  return { ws, port, srv };
}

test('nothing answers a request beside the front door on the hosted desk', async (t) => {
  const d = await desk(t, 'door');
  assert.deepEqual(F.audit(d.srv.server), []);
  for (const ev of REQUEST_EVENTS) assert.equal(d.srv.server.listeners(ev).length, ev === 'request' ? 1 : 0, `listeners for '${ev}'`);
  // The public engineering reads answer as dashboard/engineering/routes.js
  // does: an unknown admission or attestation is 404 with nothing else.
  for (const p of [`/engineering/attestations/${'0'.repeat(40)}`, '/engineering/admissions/eng-20261026-0a0a0a']) {
    const r = await req(d.port, { path: p });
    assert.equal(r.status, 404, p);
    assert.deepEqual(r.json, { error: 'Not found' }, p);
    assert.equal(r.headers['cache-control'], 'no-store', p);
  }
  assert.equal((await req(d.port, { method: 'POST', path: `/engineering/attestations/${'0'.repeat(40)}` })).status, 405);
  // Everything else waits for the sign-in, except the files its page needs.
  assert.equal((await req(d.port, { path: '/api/engineering' })).status, 401);
  assert.equal((await req(d.port, { path: '/' })).status, 303);
  for (const f of F.LOGIN_ASSETS) assert.equal((await req(d.port, { path: f })).status, 200, f);
  assert.equal((await req(d.port, { path: '/healthz' })).status, 200);
  assert.equal((await req(d.port, { path: '/api/engineering', host: 'elsewhere.test' })).status, 403);
  // One front door per server.
  assert.throws(() => F.openFrontDoor(d.srv.server, { ws: d.ws, port: d.port, state: { stats: { requests: {} } }, signedIn: () => {} }), /already open/);
});

test('a handler beside the front door is reported, however its route is spelled', async (t) => {
  const d = await desk(t, 'shadow');
  const server = d.srv.server;
  const route = ['/eng', 'ineering'].join('');
  const shadow = (rq, res) => {
    if (String(rq.url).startsWith(route)) { res.writeHead(204); res.end(); }
  };
  server.prependListener('request', shadow);
  const reasons = F.audit(server);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /1 other handler listens for 'request' beside the front door/);
  server.removeListener('request', shadow);
  assert.deepEqual(F.audit(server), []);
  for (const ev of ['upgrade', 'checkContinue', 'connect']) {
    const h = () => {};
    server.on(ev, h);
    assert.match(F.audit(server).join('; '), new RegExp(`'${ev}'`), ev);
    server.removeListener(ev, h);
  }
  assert.deepEqual(F.audit(server), []);
  // A server whose front door was taken off, or never opened.
  server.removeAllListeners('request');
  assert.match(F.audit(server).join('; '), /the front door no longer listens for requests/);
  assert.deepEqual(F.audit(http.createServer()), ['the front door is not open on this server']);
});

test('the online desk does not start when anything answers beside the front door', async (t) => {
  const hosted = require('../hosted');
  const S = require('../server');
  const original = S.start;
  const quiet = { log: console.log, error: console.error };
  t.after(() => { S.start = original; console.log = quiet.log; console.error = quiet.error; });
  const { env, opts, ws } = hostedEnv(t, 'main', 1);
  // server.js's start, as hosted.main calls it, without binding a port: its
  // server has the real front door, and on the first run a handler of its own.
  let shutdowns = 0;
  let starts = 0;
  const fake = (extra) => async () => {
    starts += 1;
    const server = http.createServer();
    F.openFrontDoor(server, { ws, port: 1, quiet: true, state: { stats: { requests: {} } }, signedIn: () => {} });
    if (extra) server.prependListener('request', extra);
    return { server, shutdown: () => { shutdowns += 1; } };
  };
  console.log = () => {};
  console.error = () => {};
  S.start = fake((rq, res) => { if (String(rq.url).startsWith(['/eng', 'ineering'].join(''))) { res.writeHead(204); res.end(); } });
  await assert.rejects(hosted.main(env, opts), /The front door was bypassed: 1 other handler listens for 'request' beside the front door/);
  assert.equal(starts, 1, 'the desk was started, not the setup page');
  assert.equal(shutdowns, 1, 'the bypassed server is shut down');
  S.start = fake(null);
  const srv = await hosted.main(env, opts);
  assert.equal(starts, 2);
  assert.ok(srv && srv.server, 'the desk itself answers');
  assert.equal(srv.setup, undefined, 'no setup page was served');
  assert.equal(shutdowns, 1);
});

// Static relative requires, followed through every file they reach.
function requireWalk(roots) {
  const seen = new Set();
  const computed = [];
  const visit = (abs) => {
    if (seen.has(abs)) return;
    seen.add(abs);
    if (abs.endsWith('.json')) return;
    // Comments are words about a require, not one.
    const src = fs.readFileSync(abs, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
    // A require or import whose target is computed cannot be followed.
    for (const m of src.matchAll(/\brequire\s*\(\s*([^)]*)\)|\bimport\s*\(/g)) {
      if (!m[1] || !/^['"][^'"]+['"]\s*$/.test(m[1].trim())) computed.push(`${rel(abs)}: ${m[0].slice(0, 60)}`);
    }
    for (const m of src.matchAll(/\brequire\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      let target = path.resolve(path.dirname(abs), m[1]);
      if (!/\.(js|json)$/.test(target)) target = fs.existsSync(`${target}.js`) ? `${target}.js` : path.join(target, 'index.js');
      visit(target);
    }
  };
  for (const r of roots) visit(r);
  return { files: [...seen].map(rel), computed };
}

test('every module the engineering gate loads is protected', () => {
  const engDir = path.join(DASH, 'engineering');
  const roots = [
    ...fs.readdirSync(engDir).filter((f) => f.endsWith('.js')).map((f) => path.join(engDir, f)),
    path.join(DASH, 'scripts', 'backlog-promote.js'),
    path.join(DASH, 'scripts', 'engineering-worker.js'),
  ];
  const { files, computed } = requireWalk(roots);
  assert.deepEqual(computed, [], 'every require in the gate names its module');
  // The walk reaches the core modules the gate is computed with.
  for (const f of ['dashboard/core/ops.js', 'dashboard/core/workspace.js', 'dashboard/core/netguard.js', 'dashboard/mcp-wire.js']) assert.ok(files.includes(f), `the walk reaches ${f}`);
  for (const f of files) assert.ok(protectedHit(f), `${f} is loaded by the engineering gate and must be protected`);
});

test('the front door loads only protected modules and is protected itself', () => {
  const file = path.join(DASH, 'frontdoor.js');
  assert.ok(protectedHit('dashboard/frontdoor.js'));
  assert.ok(protectedHit('dashboard/tests/engineering-guard.test.js'), 'this test is protected');
  const src = fs.readFileSync(file, 'utf8');
  const mods = [...src.matchAll(/\brequire\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)].map((m) => rel(`${path.resolve(DASH, m[1])}.js`));
  assert.ok(mods.length >= 5);
  for (const m of mods) assert.ok(protectedHit(m), `the front door loads ${m}, which must be protected`);
  for (const m of src.matchAll(/\brequire\s*\(\s*([^)]*)\)/g)) assert.match(m[1].trim(), /^['"][^'"]+['"]$/, 'every require in the front door names its module');
  // dashboard/server.js never listens for a request itself.
  const server = fs.readFileSync(path.join(DASH, 'server.js'), 'utf8');
  assert.doesNotMatch(server, /\.(on|once|addListener|prependListener|prependOnceListener)\(\s*['"`](request|checkContinue|checkExpectation|upgrade|connect)['"`]/);
  assert.match(server, /openFrontDoor\(server, /);
  // Every rule protects something that exists or could: none is empty.
  assert.ok(PROTECTED.length > 10);
});

test('a static file is served only as a regular file inside its folder, never through a link', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-guard-public-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-guard-outside-'));
  t.after(() => { for (const d of [root, outside]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }); });
  fs.writeFileSync(path.join(root, 'real.css'), 'body{}');
  fs.mkdirSync(path.join(root, 'folder'));
  fs.writeFileSync(path.join(outside, 'outside.css'), 'not in the folder');
  assert.ok(F.publicFile(path.join(root, 'real.css'), root));
  assert.equal(F.publicFile(path.join(root, 'folder'), root), null, 'a folder');
  assert.equal(F.publicFile(path.join(root, 'missing.css'), root), null, 'nothing there');
  // A linked folder (a junction needs no privilege on Windows).
  fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
  assert.equal(F.publicFile(path.join(root, 'linked', 'outside.css'), root), null, 'a file through a linked folder');
  // A file link, to a file outside or inside the folder.
  let made = 0;
  for (const [name, target] of [['out.css', path.join(outside, 'outside.css')], ['in.css', path.join(root, 'real.css')]]) {
    try { fs.symlinkSync(target, path.join(root, name), 'file'); made += 1; } catch (err) { if (err.code !== 'EPERM') throw err; continue; }
    assert.equal(F.publicFile(path.join(root, name), root), null, `a link (${name})`);
  }
  if (!made) t.diagnostic('file links need a privilege on this PC; the folder link was checked');
  // The desk's own public folder serves its regular files.
  for (const f of F.LOGIN_ASSETS) assert.ok(F.publicFile(path.join(F.PUBLIC_DIR, f.slice(1))), f);
});

test('no delegation reaches the files served before sign-in, the bundle, the browser app or the guard tests', () => {
  const restricted = (p) => DELEGATION_RESTRICTED.some((x) => x.re.test(foldPath(p)));
  const paths = [
    ...[...F.LOGIN_ASSETS].map((f) => `dashboard/public${f}`),
    'Dashboard/Public/Tokens.CSS',
    'dashboard/public/app/index.html', 'dashboard/public/app/assets/index-0a0a0a.js',
    'dashboard/web/src/views/engineering/Engineering.jsx', 'dashboard/web/vite.config.js',
    'dashboard/tests/engineering-guard.test.js', 'dashboard/tests/engineering-inbox.test.js', 'dashboard/tests/backlog-promote.test.js',
    'dashboard/tests/guardrails.test.js', 'dashboard/tests/web-app.test.js', 'dashboard/tests/helpers.js',
    'dashboard/core/projects.js',
  ];
  for (const p of paths) {
    assert.ok(restricted(p), `${p} is restricted`);
    assert.ok(P.restrictedHit(p), `${p} is restricted for a task scope`);
  }
  for (const p of ['dashboard/public/views/brief.js', 'dashboard/public/ui.js', 'dashboard/tests/watchlist-model.test.js', 'docs/engineering/x.md']) assert.equal(P.restrictedHit(p), null, `${p} stays open to a delegation`);
  // The offered application template leaves them out, and its predecessors match nothing.
  assert.deepEqual(Object.keys(P.TEMPLATES).filter((k) => !P.RETIRED[k]).sort(), ['eng-app@3', 'eng-app@4', 'eng-docs@1']);
  assert.ok(!P.TEMPLATES['eng-app@3'].allowed_paths.some((g) => g.startsWith('dashboard/web/') || g.startsWith('dashboard/core/')));
  for (const old of ['eng-app@1', 'eng-app@2']) assert.match(P.fits({ template: old, policy_id: 'pol-20261026-0a0a0a' }, {}, { now: Date.now() })[0], /matches nothing/);
});
