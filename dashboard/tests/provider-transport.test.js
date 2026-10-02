'use strict';
// Transport timeouts for paid calls (audit F2, 2026-10-02 review). These run
// the real Node fetch (Undici) against a local stub that delays its answer.
// Node's default limits are 300 s for headers and between body chunks; the
// tests below use the same mechanism with short limits so they finish in
// seconds. The 300 s default itself is shown by a separate long check
// (audit evidence f2-long-*.json), not in this suite.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const providers = require('../core/providers');

async function slowStub(delayMs) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const t = setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_stub', model: 'claude-test-model', stop_reason: 'end_turn', content: [{ type: 'text', text: 'FICTIONAL stub answer' }], usage: { input_tokens: 10, output_tokens: 10 } }));
      }, delayMs);
      res.on('close', () => clearTimeout(t));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); server.close(); } };
}

// Sends what callProvider would send for Claude, to the stub.
const toStub = (stub, override) => (url, init) => fetch(`${stub.url}/v1/messages`, override ? { ...init, ...override(init) } : init);
const call = (stub, { timeoutMs, override }) => providers.callProvider('claude', { model: 'claude-test-model', prompt: 'x', maxOutputTokens: 100, maxSearches: 0, key: 'test-key-not-real', signal: AbortSignal.timeout(timeoutMs), timeoutMs, fetchImpl: toStub(stub, override) });

test('F2 the transport limit is real: a shorter Undici headersTimeout ends the call before the caller\'s own timeout, as an outcome that may have been billed', async (t) => {
  const stub = await slowStub(1500);
  t.after(stub.close);
  const Agent = providers.transportFor(1000).constructor;
  const short = new Agent({ headersTimeout: 300, bodyTimeout: 300 });
  t.after(() => short.close());
  const t0 = Date.now();
  // The caller allows 10 s; the transport gives up at 0.3 s (like 300 s vs 600 s).
  const err = await call(stub, { timeoutMs: 10000, override: () => ({ dispatcher: short }) }).then(() => null, (e) => e);
  const ms = Date.now() - t0;
  assert.ok(err, 'the call failed');
  assert.equal(err.kind, 'network');
  assert.equal(err.code, 'UND_ERR_HEADERS_TIMEOUT');
  assert.notEqual(err.notSent, true, 'the request had been sent: this is not a "not sent" outcome');
  assert.ok(ms < 1400, `ended by the transport after ${ms} ms, before the stub answered and long before the caller's limit`);
});

test('F2 every paid call goes through a dispatcher whose header and body limits are above the research timeout', async (t) => {
  const stub = await slowStub(10);
  t.after(stub.close);
  let seen = null;
  const out = await call(stub, { timeoutMs: 600000, override: (init) => { seen = init.dispatcher; return {}; } });
  assert.equal(out.text, 'FICTIONAL stub answer');
  assert.ok(seen, 'a dispatcher was passed to fetch');
  assert.equal(seen, providers.transportFor(600000));
  const info = providers.transportInfo(600000);
  assert.equal(info.dispatcher, 'bundled Undici Agent');
  assert.equal(info.headers_timeout_ms, 600000 + providers.TRANSPORT_MARGIN_MS);
  assert.equal(info.body_timeout_ms, 600000 + providers.TRANSPORT_MARGIN_MS);
});

test('F2 with the repair, the research timeout is what ends a slow call (a "timeout", not a transport error)', async (t) => {
  const stub = await slowStub(3000);
  t.after(stub.close);
  const t0 = Date.now();
  const err = await call(stub, { timeoutMs: 800 }).then(() => null, (e) => e);
  const ms = Date.now() - t0;
  assert.ok(err);
  assert.equal(err.kind, 'timeout', err.message);
  assert.ok(ms >= 700 && ms < 2500, `ended at the research timeout (${ms} ms)`);
});

test('F2 a call is not sent without a usable research timeout', async () => {
  let sent = false;
  const err = await providers.callProvider('claude', { model: 'm', prompt: 'x', maxOutputTokens: 1, maxSearches: 0, key: 'k', signal: AbortSignal.timeout(1000), fetchImpl: () => { sent = true; } }).then(() => null, (e) => e);
  assert.equal(err.kind, 'config');
  assert.equal(sent, false);
});
