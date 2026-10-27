'use strict';
// The builder sandbox's live probe, offline (2026-10-27): its network rows ask
// through the sandbox's proxy, and its home row is judged on the runner's own
// disk. Fake proxies on 127.0.0.1 stand in for the sandbox's; nothing here
// leaves this machine.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const P = require(path.join(__dirname, '..', '..', '.github', 'agent', 'sandbox-probe.js'));

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
function closing(t, server) {
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  t.after(() => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }));
  return server;
}

test('the proxy is read from the variables the sandbox sets for commands, http:// only', () => {
  assert.equal(P.proxyOf({}), null);
  assert.equal(P.proxyOf({ HTTPS_PROXY: 'http://localhost:3128' }).port, '3128');
  assert.equal(P.proxyOf({ https_proxy: 'http://u:p@localhost:9' }).username, 'u');
  assert.equal(P.proxyOf({ HTTP_PROXY: 'http://localhost:8080' }).hostname, 'localhost');
  assert.equal(P.proxyOf({ HTTPS_PROXY: 'http://a:1', HTTP_PROXY: 'http://b:2' }).hostname, 'a', 'HTTPS_PROXY first');
  assert.equal(P.proxyOf({ HTTPS_PROXY: 'socks5h://localhost:1080' }), null);
  assert.equal(P.proxyOf({ HTTPS_PROXY: 'not a url' }), null);
});

test('a host is asked through the proxy: an opened tunnel answers, a refusal is the proxy\'s own, credentials go as Proxy-Authorization', async (t) => {
  const target = closing(t, http.createServer((q, s) => { s.writeHead(204); s.end(); }));
  await listen(target);
  const seen = [];
  const proxy = closing(t, http.createServer());
  proxy.on('connect', (req, sock) => {
    seen.push({ path: req.url, auth: req.headers['proxy-authorization'] || null });
    if (req.url.startsWith('allowed.test:')) {
      const up = net.connect(target.address().port, '127.0.0.1', () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.pipe(sock); sock.pipe(up); });
      sock.on('error', () => up.destroy());
      up.on('error', () => sock.destroy());
    } else if (req.url.startsWith('closed.test:')) sock.destroy();
    else sock.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
  });
  await listen(proxy);
  const url = new URL(`http://user:p%40ss@127.0.0.1:${proxy.address().port}`);

  assert.equal(await P.viaProxy(url, 'allowed.test', { port: 80, secure: false }), 'HTTP 204 through the proxy');
  assert.deepEqual(seen[0], { path: 'allowed.test:80', auth: `Basic ${Buffer.from('user:p@ss').toString('base64')}` });
  assert.equal(await P.viaProxy(url, 'example.com', { secure: false }), 'refused by the proxy (HTTP 403)');
  assert.equal(seen[1].path, 'example.com:443');
  assert.match(await P.viaProxy(url, 'closed.test', { secure: false }), /^refused by the proxy \(closed the connection, /);
  const anonymous = new URL(`http://127.0.0.1:${proxy.address().port}`);
  assert.equal(await P.viaProxy(anonymous, 'example.com', { secure: false }), 'refused by the proxy (HTTP 403)');
  assert.equal(seen[3].auth, null, 'no credentials, no header');
});

test('a proxy that is not there, or never answers, is not a refusal', async (t) => {
  const spare = net.createServer();
  await listen(spare);
  const port = spare.address().port;
  await new Promise((resolve) => spare.close(resolve));
  assert.match(await P.viaProxy(new URL(`http://127.0.0.1:${port}`), 'example.com', { secure: false }), /^proxy unreachable \(/);

  const silent = closing(t, net.createServer(() => {}));
  await listen(silent);
  assert.equal(await P.viaProxy(new URL(`http://127.0.0.1:${silent.address().port}`), 'example.com', { secure: false, timeout: 300 }), 'no answer from the proxy (timeout)');
});

test('the home marker is looked for on the runner\'s own disk: absent holds, present fails whoever wrote it', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-probe-home-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-probe-other-'));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }); });
  const r = { home_path: home, home_marker_nonce: 'n'.repeat(24), write_home: 'written' };
  assert.deepEqual(P.hostHome(r, home), { on_disk: false });
  fs.writeFileSync(path.join(home, P.HOME_MARKER), `cr-sandbox-canary ${'n'.repeat(24)}\n`);
  assert.deepEqual(P.hostHome(r, home), { on_disk: true, this_run: true });
  assert.deepEqual(P.hostHome({ ...r, home_marker_nonce: 'm'.repeat(24) }, home), { on_disk: true, this_run: false });
  // The report names a different home: the runner's is looked at, and that one too.
  assert.deepEqual(P.hostHome({ ...r, home_path: home }, other), { on_disk: true, this_run: true });
  assert.deepEqual(P.hostHome({ ...r, home_path: 42 }, other), { on_disk: false });
});
