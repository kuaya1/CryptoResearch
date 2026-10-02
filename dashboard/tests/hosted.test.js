'use strict';
// Hosted mode (the private desk on Render), run locally against temporary
// folders: it refuses to start without a passphrase and a data folder outside
// the code, serves only a setup page until configured, and in front of
// everything puts a passphrase sign-in (session cookie, failed sign-ins
// limited, sessions kept across restarts). Test passphrases only.

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
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const form = (password) => ({ method: 'POST', path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: `https://${HOST}` }, body: `password=${encodeURIComponent(password)}` });

// Test desks make no network calls: price refreshes are switched off.
function offline(ws) {
  const file = path.join(ws.root, 'config', 'settings.json');
  const s = readJson(file);
  s.market_data = { ...(s.market_data || {}), enabled: false };
  fs.writeFileSync(file, JSON.stringify(s));
  ws.reloadSettings();
  return ws;
}

function tempDataDir(label) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `cr-hosted-${label}-`));
  return { base, dataDir: path.join(base, 'data'), cleanup: () => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 }) };
}

test('hosted: refuses to start without a passphrase, a data folder outside the code, a port and a host name', () => {
  const none = hosted.hostedConfig({});
  assert.equal(none.problems.length, 4);
  assert.match(none.problems.join(' '), /CR_DATA_DIR is not set/);
  assert.match(none.problems.join(' '), /CR_ACCESS_PASSWORD is missing or shorter than 12/);
  const inside = hosted.hostedConfig({ CR_DATA_DIR: path.join(__dirname, 'data'), CR_ACCESS_PASSWORD: 'short', PORT: '10000', RENDER_EXTERNAL_HOSTNAME: HOST });
  assert.match(inside.problems.join(' '), /inside the code folder/);
  assert.match(inside.problems.join(' '), /shorter than 12/);
  const unmounted = hosted.hostedConfig({ CR_DATA_DIR: path.join(os.tmpdir(), 'cr-no-such-mount', 'data'), CR_ACCESS_PASSWORD: PASS, PORT: '10000', RENDER_EXTERNAL_HOSTNAME: HOST });
  assert.match(unmounted.problems.join(' '), /persistent disk is not mounted/);
});

test('hosted: records start only on a mounted persistent disk, never on a folder that merely exists (Render free instances have /var/data too)', () => {
  const free = 'overlay / overlay rw,relatime 0 0\nproc /proc proc rw 0 0\ntmpfs /dev tmpfs rw 0 0\n/dev/nvme0n1p1 /opt/render/project ext4 rw 0 0\n';
  const withDisk = `${free}/dev/nvme1n1 /var/data ext4 rw,relatime 0 0\n`;
  const ramDisk = `${free}tmpfs /var/data tmpfs rw 0 0\n`;
  const code = '/opt/render/project/src';
  const opts = (mountsText) => ({ platform: 'linux', mountsText, codeDir: code });
  assert.deepEqual(hosted.containingMount('/var/data/cryptoresearch', withDisk), { point: '/var/data', type: 'ext4', source: '/dev/nvme1n1' });
  assert.equal(hosted.containingMount('/var/data/cryptoresearch', free).point, '/');
  assert.match(hosted.persistentDiskProblem('/var/data/cryptoresearch', opts(free)), /not on a persistent disk \(it is on \/, overlay\)/);
  assert.match(hosted.persistentDiskProblem('/var/data/cryptoresearch', opts(ramDisk)), /not on a persistent disk/);
  assert.match(hosted.persistentDiskProblem('/opt/render/project/data', opts(withDisk)), /not on a persistent disk/, 'the code\'s own disk is replaced on deploy');
  assert.equal(hosted.persistentDiskProblem('/var/data/cryptoresearch', opts(withDisk)), null);
  assert.match(hosted.persistentDiskProblem('/var/data/cryptoresearch', { platform: 'linux', mountsText: '', codeDir: code }), /not on a persistent disk|could not be read/);
  assert.equal(hosted.persistentDiskProblem('C:\\data', { platform: 'win32' }), null, 'only checked where the desk runs (Linux)');
});

test('hosted: until configured, only a setup page is served; nothing else answers', async (t) => {
  const port = await freePort();
  const out = await hosted.main({ PORT: String(port) });
  t.after(() => out.setup.close());
  assert.ok(out.setup, 'setup page instead of the desk');
  const page = await req(port);
  assert.equal(page.status, 503);
  assert.match(page.text, /setup required/);
  assert.match(page.text, /CR_ACCESS_PASSWORD is missing/);
  assert.doesNotMatch(page.text, /<form|<script/);
  const api = await req(port, { path: '/api/session' });
  assert.equal(api.status, 503, 'no API either');
  const hz = await req(port, { path: '/healthz' });
  assert.equal(hz.status, 200);
});

test('hosted: first boot creates the real workspace with the proposed limits; templates follow the code; settings are kept', (t) => {
  const { dataDir, cleanup } = tempDataDir('boot');
  t.after(cleanup);
  const cfg = hosted.hostedConfig({ CR_DATA_DIR: dataDir, CR_ACCESS_PASSWORD: PASS, PORT: '10000', RENDER_EXTERNAL_HOSTNAME: HOST });
  assert.deepEqual(cfg.problems, []);
  const ws = hosted.prepareWorkspace(cfg);
  assert.equal(ws.kind, 'real');
  assert.equal(ws.root, dataDir);
  assert.deepEqual(ws.settings.research.default_providers, ['claude']);
  assert.deepEqual(ws.settings.research.budget, { per_run_usd: 4, daily_usd: 8, monthly_usd: 30 });
  assert.equal(ws.settings.research.providers.claude.model, 'claude-opus-5-5');
  assert.equal(ws.settings.research.max_continuations, 2);
  const code = path.join(__dirname, '..', '..', 'templates', 'research-prompt.v3.md');
  assert.deepEqual(fs.readFileSync(path.join(dataDir, 'templates', 'research-prompt.v3.md')), fs.readFileSync(code));
  // Eric's own change survives the next boot (defaults are applied once).
  const file = path.join(dataDir, 'config', 'settings.json');
  const s = readJson(file);
  s.research.budget.per_run_usd = 1.5;
  fs.writeFileSync(file, JSON.stringify(s));
  fs.writeFileSync(path.join(dataDir, 'templates', 'research-prompt.v3.md'), 'stale copy');
  const again = hosted.prepareWorkspace(cfg);
  assert.equal(again.settings.research.budget.per_run_usd, 1.5);
  assert.deepEqual(fs.readFileSync(path.join(dataDir, 'templates', 'research-prompt.v3.md')), fs.readFileSync(code), 'templates come from the deployed code');
  // The passphrase is never written into the data folder.
  const all = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : all.push(path.join(d, e.name))));
  walk(dataDir);
  assert.ok(!all.some((f) => fs.readFileSync(f, 'utf8').includes(PASS)), 'the passphrase is never stored');
});

test('hosted: everything needs sign-in; the session cookie is HttpOnly, Secure and SameSite=Strict; sessions survive a restart; sign-out ends one', async (t) => {
  const { dataDir, cleanup } = tempDataDir('auth');
  t.after(cleanup);
  const port = await freePort();
  const cfg = hosted.hostedConfig({ CR_DATA_DIR: dataDir, CR_ACCESS_PASSWORD: PASS, PORT: String(port), RENDER_EXTERNAL_HOSTNAME: HOST });
  const ws = offline(hosted.prepareWorkspace(cfg));
  const srv = await start(ws, { quiet: true, hosted: { port, hosts: cfg.hosts, password: cfg.password, bind: '127.0.0.1', failDelayMs: 0 } });
  t.after(() => srv.shutdown());

  const root = await req(port);
  assert.equal(root.status, 303);
  assert.equal(root.headers.location, '/login');
  assert.equal((await req(port, { path: '/api/index' })).status, 401);
  assert.equal((await req(port, { path: '/api/session' })).status, 401);
  assert.equal((await req(port, { path: '/app.js' })).status, 303, 'the app itself is behind sign-in');
  assert.equal((await req(port, { path: '/styles.css' })).status, 200, 'the sign-in page can load its styles');
  const login = await req(port, { path: '/login' });
  assert.equal(login.status, 200);
  assert.match(login.text, /type="password"/);
  assert.match(login.headers['strict-transport-security'], /max-age=/);
  assert.equal((await req(port, { path: '/', headers: { host: 'evil.test' } })).status, 403, 'other host names are refused');
  assert.equal((await req(port, { path: '/healthz', headers: { host: 'internal' } })).status, 200);

  const wrong = await req(port, form('not the passphrase'));
  assert.equal(wrong.status, 303);
  assert.equal(wrong.headers.location, '/login?e=1');
  assert.equal(wrong.headers['set-cookie'], undefined);
  const cross = await req(port, { ...form(PASS), headers: { ...form(PASS).headers, origin: 'https://evil.test' } });
  assert.equal(cross.status, 403, 'a sign-in posted from another site is refused');

  const ok = await req(port, form(PASS));
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.location, '/');
  const set = ok.headers['set-cookie'][0];
  assert.match(set, /^cr_session=[a-f0-9]{64};/);
  assert.match(set, /HttpOnly/);
  assert.match(set, /Secure/);
  assert.match(set, /SameSite=Strict/);
  const cookie = set.split(';')[0];
  const sess = await req(port, { path: '/api/session', headers: { cookie } });
  assert.equal(sess.status, 200);
  const s = JSON.parse(sess.text);
  assert.equal(s.hosted, true);
  assert.equal(s.workspace.root, null, 'the server path is not shown');
  const idx = await req(port, { path: '/api/index', headers: { cookie, 'x-cr-token': s.token } });
  assert.equal(idx.status, 200);
  const intake = await req(port, { path: '/api/intake', headers: { cookie, 'x-cr-token': s.token } });
  assert.equal(intake.status, 200);
  assert.equal(JSON.parse(intake.text).desk.claude.model, 'claude-opus-5-5');
  // Writes still need the page token and a same-origin https Origin.
  const write = (headers) => req(port, { method: 'POST', path: '/api/intake', headers: { cookie, 'x-cr-token': s.token, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ link: 'https://coinmarketcap.com/currencies/examplecoin-fictional/' }) });
  assert.equal((await write({ origin: 'http://desk.test' })).status, 403);
  // Stored sessions hold only hashes, never the cookie itself.
  const stored = readJson(path.join(dataDir, '.cr', 'sessions.json'));
  assert.ok(!JSON.stringify(stored).includes(cookie.split('=')[1]));

  // A restart (a deploy) keeps the session.
  srv.shutdown();
  const port2 = await freePort();
  const srv2 = await start(ws, { quiet: true, hosted: { port: port2, hosts: cfg.hosts, password: cfg.password, bind: '127.0.0.1', failDelayMs: 0 } });
  t.after(() => srv2.shutdown());
  assert.equal((await req(port2, { path: '/api/session', headers: { cookie } })).status, 200);
  const out = await req(port2, { method: 'POST', path: '/logout', headers: { cookie, origin: `https://${HOST}` } });
  assert.equal(out.status, 303);
  assert.match(out.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await req(port2, { path: '/api/session', headers: { cookie } })).status, 401, 'signed out');
});

test('hosted: repeated wrong passphrases lock sign-in for a while, even with the right one', async (t) => {
  const { dataDir, cleanup } = tempDataDir('limit');
  t.after(cleanup);
  const port = await freePort();
  const cfg = hosted.hostedConfig({ CR_DATA_DIR: dataDir, CR_ACCESS_PASSWORD: PASS, PORT: String(port), RENDER_EXTERNAL_HOSTNAME: HOST });
  const ws = offline(hosted.prepareWorkspace(cfg));
  const srv = await start(ws, { quiet: true, hosted: { port, hosts: cfg.hosts, password: cfg.password, bind: '127.0.0.1', failDelayMs: 0 } });
  t.after(() => srv.shutdown());
  for (let i = 0; i < 8; i++) assert.equal((await req(port, form(`wrong-${i}`))).headers.location, '/login?e=1');
  const locked = await req(port, form(PASS));
  assert.equal(locked.headers.location, '/login?e=locked');
  assert.equal(locked.headers['set-cookie'], undefined);
});
