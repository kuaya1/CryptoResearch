'use strict';
// GoPlus credentials (core/screening.js): keyless by default; with
// GOPLUS_APP_KEY and GOPLUS_APP_SECRET, an access token from POST
// /api/v1/token sent as "Authorization: Bearer <token>", held in memory only;
// every failure falls back to keyless without throwing. Also each request,
// retries and the token request included, reserved against the monthly budget
// before it is sent, and a gate per credential. FICTIONAL keys, contracts and
// answers; global fetch fails, so nothing is ever sent anywhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tempWorkspace } = require('./helpers');
const screening = require('../core/screening');
const projects = require('../core/projects');

const NOW = Date.parse('2026-10-04T15:00:00Z');
const HOUR = 3600000;
const FAST = { retryDelayMs: 0, pauseMs: 0 };
const EVM_A = '0x00000000000000000000000000000000000fc001';
const EVM_B = '0x00000000000000000000000000000000000fc002';
const TOKEN_URL = 'https://api.gopluslabs.io/api/v1/token';
const CLEAN = { is_mintable: '0', is_proxy: '0', is_blacklisted: '0', is_honeypot: '0', buy_tax: '0', sell_tax: '0', is_open_source: '1' };

// The environment for one test: a key and secret, a key alone, or none.
function env(t, { key = null, secret = null } = {}) {
  const prev = { key: process.env.GOPLUS_APP_KEY, secret: process.env.GOPLUS_APP_SECRET };
  if (key === null) delete process.env.GOPLUS_APP_KEY; else process.env.GOPLUS_APP_KEY = key;
  if (secret === null) delete process.env.GOPLUS_APP_SECRET; else process.env.GOPLUS_APP_SECRET = secret;
  t.after(() => {
    if (prev.key === undefined) delete process.env.GOPLUS_APP_KEY; else process.env.GOPLUS_APP_KEY = prev.key;
    if (prev.secret === undefined) delete process.env.GOPLUS_APP_SECRET; else process.env.GOPLUS_APP_SECRET = prev.secret;
  });
}

function workspace(t, label, settings = {}) {
  const { ws, root, cleanup } = tempWorkspace(label, settings);
  t.after(cleanup);
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network access is not allowed in tests');
  });
  const out = projects.addProject(ws, {
    name: 'Example Token (FICTIONAL)',
    symbol: 'XTKN',
    official_website: 'https://xtkn.example/',
    coingecko_id: 'xtkn-fictional',
    assets: [{ chain: 'ethereum', contract_address: EVM_A }, { chain: 'bsc', contract_address: EVM_B }],
    evidence: [{ url: 'https://xtkn.example/docs', note: 'fictional test evidence' }],
    sector: 'defi',
  });
  assert.equal(out.status, 'created', out.message);
  return { ws, root, id: out.project_id };
}

const reply = (status, payload, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => (headers[String(k).toLowerCase()] === undefined ? null : headers[String(k).toLowerCase()]) },
  text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
});
const screenOf = (url) => {
  const addr = new URL(url).searchParams.get('contract_addresses');
  return reply(200, { code: 1, message: 'OK', result: { [addr.toLowerCase()]: CLEAN } });
};
const tokenReply = (token, expiresIn = 7200) => reply(200, { code: 1, message: 'OK', result: { access_token: token, expires_in: expiresIn } });

// A stub GoPlus: token requests to onToken, screens to onScreen; keeps every
// call with its method, headers and body.
function goplus({ onToken = () => tokenReply('FICTIONAL-TOKEN'), onScreen = screenOf } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    const call = { url, method: init.method || 'GET', authorization: (init.headers && init.headers.authorization) || null, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const a = url === TOKEN_URL ? await onToken(call, calls) : await onScreen(url, call, calls);
    if (a instanceof Error) throw a;
    return a;
  };
  f.calls = calls;
  f.screens = () => calls.filter((c) => c.url !== TOKEN_URL);
  f.tokens = () => calls.filter((c) => c.url === TOKEN_URL);
  return f;
}

const refresh = (ws, f, extra = {}) => screening.refresh(ws, { fetchImpl: f, now: NOW, ...FAST, ...extra });

// Every file under the workspace, as text.
function filesUnder(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push({ p, text: fs.readFileSync(p, 'latin1') });
  }
  return out;
}

test('keyless by default: no token request, no Authorization header, and the status says keyless', async (t) => {
  env(t);
  const { ws } = workspace(t, 'gp-keyless');
  const f = goplus();
  const r = await refresh(ws, f);
  assert.equal(r.status, 'ok', r.message);
  assert.equal(f.tokens().length, 0);
  assert.equal(f.screens().length, 2);
  assert.ok(f.screens().every((c) => c.authorization === null));
  const st = screening.readStatus(ws);
  assert.deepEqual([st.credential, st.last_run.auth, st.last_run.auth_note], ['keyless', 'keyless', null]);
  assert.equal(st.calls.month_count, 2);
  assert.deepEqual([screening.overview(ws, NOW).credential, screening.overview(ws, NOW).credential_note], ['keyless', null]);
});

test('with a key and its secret: one signed token request to the fixed URL, then "Authorization: Bearer <token>", reused while valid; the key, secret and token are in no file', async (t) => {
  const KEY = 'FICTIONAL-APP-KEY-bearer';
  const SECRET = 'FICTIONAL-APP-SECRET-bearer';
  env(t, { key: KEY, secret: SECRET });
  const { ws, root } = workspace(t, 'gp-bearer');
  const f = goplus({ onToken: () => tokenReply('FICTIONAL-TOKEN-bearer') });
  const r = await refresh(ws, f);
  assert.equal(r.status, 'ok', r.message);
  const [tok] = f.tokens();
  assert.equal(f.calls[0].url, TOKEN_URL, 'the token comes first');
  assert.equal(tok.method, 'POST');
  const time = Math.floor(NOW / 1000);
  assert.deepEqual(tok.body, { app_key: KEY, sign: crypto.createHash('sha1').update(`${KEY}${time}${SECRET}`).digest('hex'), time });
  assert.equal(f.screens().length, 2);
  assert.ok(f.screens().every((c) => c.authorization === 'Bearer FICTIONAL-TOKEN-bearer'));
  // An hour later the token is still valid: no second token request.
  const again = await refresh(ws, f, { now: NOW + HOUR, force: true });
  assert.equal(again.status, 'ok', again.message);
  assert.equal(f.tokens().length, 1);
  assert.equal(f.screens().length, 4);
  const st = screening.readStatus(ws);
  assert.deepEqual([st.credential, st.last_run.auth], ['app_key', 'access token']);
  assert.equal(st.calls.month_count, f.calls.length, 'the token request is counted like any other');
  assert.equal(screening.overview(ws, NOW).credential, 'app_key');
  for (const file of filesUnder(root)) {
    for (const secret of [KEY, SECRET, 'FICTIONAL-TOKEN-bearer']) assert.ok(!file.text.includes(secret), `${secret} written to ${path.relative(root, file.p)}`);
  }
});

test('a key without its secret runs keyless and says why; nothing throws', async (t) => {
  env(t, { key: 'FICTIONAL-APP-KEY-alone' });
  const { ws } = workspace(t, 'gp-key-alone');
  const f = goplus();
  const r = await refresh(ws, f);
  assert.equal(r.status, 'ok', r.message);
  assert.equal(f.tokens().length, 0);
  assert.ok(f.screens().every((c) => c.authorization === null));
  const st = screening.readStatus(ws);
  assert.equal(st.credential, 'keyless');
  assert.match(st.last_run.auth_note, /GOPLUS_APP_KEY is set without GOPLUS_APP_SECRET/);
  assert.match(screening.overview(ws, NOW).credential_note, /without GOPLUS_APP_SECRET/);
  assert.ok(!JSON.stringify(st).includes('FICTIONAL-APP-KEY-alone'));
});

test('a token request that fails (HTTP 500, a refusal code, no connection) falls back to keyless for the run; it is not a screening failure', async (t) => {
  const cases = [
    ['HTTP 500', () => reply(500, 'busy'), /GoPlus issued no access token \(HTTP 500\)/],
    ['code 4012', () => reply(200, { code: 4012, message: 'signature verification failure' }), /GoPlus issued no access token \(HTTP 200, code 4012\)/],
    ['no connection', () => new TypeError('fetch failed'), /the token request failed/],
  ];
  for (const [what, onToken, why] of cases) {
    env(t, { key: `FICTIONAL-APP-KEY-${what}`, secret: 'FICTIONAL-APP-SECRET' });
    const { ws } = workspace(t, `gp-tokfail-${what.replace(/\W+/g, '')}`);
    const f = goplus({ onToken });
    const r = await refresh(ws, f);
    assert.equal(r.status, 'ok', `${what}: ${r.message}`);
    assert.equal(f.tokens().length, 1, what);
    assert.equal(f.screens().length, 2, what);
    assert.ok(f.screens().every((c) => c.authorization === null), `${what}: keyless`);
    const st = screening.readStatus(ws);
    assert.equal(st.last_run.auth, 'keyless', what);
    assert.match(st.last_run.auth_note, why, what);
    assert.match(st.last_run.auth_note, /this run went keyless$/, what);
    assert.equal(st.consecutive_failures, 0, `${what}: not a screening failure`);
    assert.equal(st.calls.month_count, 3, `${what}: the token request counted once`);
  }
});

test('a token GoPlus refuses (401) is dropped: the retry and the rest of the run go keyless, and the next run asks for a new token', async (t) => {
  env(t, { key: 'FICTIONAL-APP-KEY-401', secret: 'FICTIONAL-APP-SECRET-401' });
  const { ws } = workspace(t, 'gp-401');
  const f = goplus({
    onToken: (call, calls) => tokenReply(`FICTIONAL-TOKEN-${calls.filter((c) => c.url === TOKEN_URL).length}`),
    onScreen: (url, call) => (call.authorization ? reply(401, 'unauthorized') : screenOf(url)),
  });
  const r = await refresh(ws, f);
  assert.equal(r.status, 'ok', r.message);
  const screens = f.screens();
  assert.deepEqual(screens.map((c) => c.authorization), ['Bearer FICTIONAL-TOKEN-1', null, null], 'refused once, then keyless');
  const st = screening.readStatus(ws);
  assert.equal(st.last_run.auth, 'access token, then keyless');
  assert.match(st.last_run.auth_note, /GoPlus refused the access token \(HTTP 401\)/);
  await refresh(ws, f, { now: NOW + HOUR, force: true });
  assert.equal(f.tokens().length, 2, 'a new token is asked for');
});

test('every attempt, retries included, is reserved before it is sent: a budget of 3 is never overshot and a half-screened project publishes nothing', async (t) => {
  env(t);
  const { ws, id } = workspace(t, 'gp-budget', { screening: { monthly_request_budget: 3 } });
  const seen = new Map();
  const f = goplus({
    onScreen: (url) => {
      const n = (seen.get(url) || 0) + 1;
      seen.set(url, n);
      return n === 1 ? reply(500, 'busy') : screenOf(url);
    },
  });
  const r = await refresh(ws, f);
  assert.equal(f.calls.length, 3, 'stops at the cap');
  assert.equal(screening.readStatus(ws).calls.month_count, 3);
  assert.equal(r.status, 'budget_paused', r.message);
  assert.match(r.message, /Monthly GoPlus request budget reached \(3\)/);
  const s = screening.stateFor(ws, projects.getProject(ws, id), NOW);
  assert.equal(s.snapshot, undefined, 'nothing from the unfinished run is published');
  assert.equal(screening.readStatus(ws).consecutive_failures, 0, 'a budget stop is not a GoPlus failure');
  const again = await refresh(ws, f, { now: NOW + 60000, force: true });
  assert.equal(again.status, 'budget_paused');
  assert.equal(f.calls.length, 3, 'nothing more is sent');
});

test('a rate limit belongs to the credential it was met with: a keyless 24-hour wait does not hold back the first run with a key', async (t) => {
  env(t);
  const { ws } = workspace(t, 'gp-gate');
  const limited = goplus({ onScreen: () => reply(429, 'slow down', { 'retry-after': String(24 * 3600) }) });
  const r = await refresh(ws, limited);
  assert.equal(r.rate_limited, true);
  assert.equal(r.retry_at, new Date(NOW + 24 * HOUR).toISOString());
  assert.equal((await refresh(ws, limited, { now: NOW + HOUR, force: true })).status, 'backoff', 'keyless waits');
  // The key is added: its first run is not held back by the keyless wait.
  env(t, { key: 'FICTIONAL-APP-KEY-gate', secret: 'FICTIONAL-APP-SECRET-gate' });
  const f = goplus({ onToken: () => tokenReply('FICTIONAL-TOKEN-gate') });
  const keyed = await refresh(ws, f, { now: NOW + HOUR, force: true });
  assert.equal(keyed.status, 'ok', keyed.message);
  const st = screening.readStatus(ws);
  assert.equal(st.credential, 'app_key');
  assert.equal(st.rate_limit_superseded.credential, 'keyless', 'the keyless wait is kept for the record');
  assert.equal(st.rate_limit_superseded.until, new Date(NOW + 24 * HOUR).toISOString());
});
