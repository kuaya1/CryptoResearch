'use strict';
// The worker daemon's way to the desk (Eric, 2026-10-26,
// audits/2026-10-26-worker-daemon). The daemon is a worker connection like
// any other: it reaches the engineering inbox only through /mcp/engineering,
// with an OAuth grant Eric approves once on the desk's consent page (a
// program on this computer: Claude, role Worker). The grant's tokens are
// kept in the daemon's home (token.json, never in the repository, a log or a
// message); the access token lasts an hour and the refresh token rotates.
//
// Calls that only read are asked again after a passing failure (no answer,
// a refused or reset connection, HTTP 502, 503 or 504), after 1 s, 2 s and
// 4 s, as the worker's guide says. A write is asked again only when it
// cannot have reached the desk (the connection was refused or the host not
// found) or the desk's proxy answered 502 or 503; otherwise its answer is
// lost and the daemon reads the task back on its next pass instead.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_DESK = 'https://cryptoresearch.onrender.com';
const SCOPE = 'engineering offline_access';
const CLIENT_NAME = 'CryptoResearch worker daemon';
const READ_TOOLS = ['engineering_capabilities', 'engineering_list_tasks', 'engineering_get_task', 'engineering_get_evidence', 'engineering_github_status'];
const NOT_SENT = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH/;
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

class DeskError extends Error {
  // code: the desk's refusal code (STALE_CLAIM, CLAIMED, PAUSED, …) or the
  // daemon's own (LOGIN_NEEDED, NO_ANSWER, HTTP); transient: worth a later
  // try; sent: whether a write may have reached the desk.
  constructor(message, { code = null, status = null, transient = false, sent = true } = {}) {
    super(message);
    Object.assign(this, { code, status, transient, sent });
  }
}

// Node's own fetch, with a deadline; redirects are never followed.
async function fetchTransport(method, url, { headers = {}, body = null, timeoutMs = 60000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method, headers, body, redirect: 'manual', signal: ctl.signal });
    return { status: r.status, headers: Object.fromEntries(r.headers), text: await r.text() };
  } catch (e) {
    const why = String((e.cause && (e.cause.code || e.cause.message)) || e.message || e);
    throw new DeskError(`The desk did not answer (${why.slice(0, 120)}).`, { code: 'NO_ANSWER', transient: true, sent: !NOT_SENT.test(why) });
  } finally {
    clearTimeout(timer);
  }
}

// The system's browser, given the address as one argument (no shell).
function openInBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch (_) { /* the address is printed too */ }
}

function tokenStore(home) {
  const file = path.join(home, 'token.json');
  return {
    file,
    read() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } },
    write(tok) {
      fs.mkdirSync(home, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(tok, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}
const codeOf = (text) => { const all = [...String(text).matchAll(/\(([A-Z][A-Z_]{2,})\)/g)]; return all.length ? all[all.length - 1][1] : null; };

function makeDesk({ desk = DEFAULT_DESK, home, transport = fetchTransport, clock = Date.now, sleep = sleepMs, retryDelays = [1000, 2000, 4000] } = {}) {
  const origin = String(desk).replace(/\/+$/, '');
  const resource = `${origin}/mcp/engineering`;
  const store = tokenStore(home);
  let rpcId = 0;

  async function form(url, fields) {
    return transport('POST', url, { headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(fields).toString() });
  }
  function saveTokens(answer, base) {
    const j = JSON.parse(answer.text);
    if (!j.access_token || !j.refresh_token) throw new DeskError('The desk gave no tokens.', { code: 'LOGIN_NEEDED' });
    const tok = { desk: origin, resource, client_id: base.client_id, redirect_uri: base.redirect_uri, scope: j.scope || SCOPE, access_token: j.access_token, expires_at: new Date(clock() + Number(j.expires_in || 3600) * 1000).toISOString(), refresh_token: j.refresh_token, saved_at: new Date(clock()).toISOString() };
    store.write(tok);
    return tok;
  }

  // One approval by Eric: register this program, open the consent page,
  // take the code on a loopback address and trade it for tokens (PKCE).
  async function login({ openBrowser = openInBrowser, say = () => {}, timeoutMs = 10 * 60000 } = {}) {
    const server = http.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const redirect = `http://127.0.0.1:${server.address().port}/callback`;
    try {
      const reg = await transport('POST', `${origin}/oauth/register`, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: CLIENT_NAME, redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
      if (reg.status !== 201) throw new DeskError(`The desk refused to register the daemon (HTTP ${reg.status}).`, { code: 'HTTP', status: reg.status });
      const clientId = JSON.parse(reg.text).client_id;
      const verifier = b64url(crypto.randomBytes(40));
      const state = b64url(crypto.randomBytes(16));
      const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', state, scope: SCOPE, resource });
      const url = `${origin}/oauth/authorize?${q}`;
      const code = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new DeskError('No answer from the approval page within the time allowed; run npm run worker:login again.', { code: 'LOGIN_NEEDED' })), timeoutMs);
        server.on('request', (req, res) => {
          const u = new URL(req.url, redirect);
          const page = (status, text) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(`<!doctype html><meta charset="utf-8"><title>Worker daemon</title><p>${text}</p>`); };
          if (u.pathname !== '/callback') return page(404, 'Not found.');
          if (u.searchParams.get('state') !== state) return page(400, 'This answer is not for this sign-in.');
          clearTimeout(timer);
          if (u.searchParams.get('error')) { page(200, 'The worker daemon was not connected. You can close this window.'); return reject(new DeskError(`The desk answered ${String(u.searchParams.get('error')).slice(0, 60)}.`, { code: 'LOGIN_NEEDED' })); }
          page(200, 'The worker daemon is connected. You can close this window.');
          return resolve(u.searchParams.get('code'));
        });
      });
      say(`Approve the worker daemon on the desk (choose Claude, role Worker): ${url}`);
      await openBrowser(url);
      const got = await code;
      const tok = await form(`${origin}/oauth/token`, { grant_type: 'authorization_code', code: got, redirect_uri: redirect, code_verifier: verifier, client_id: clientId, resource });
      if (tok.status !== 200) throw new DeskError(`The desk refused the code (HTTP ${tok.status}).`, { code: 'LOGIN_NEEDED', status: tok.status });
      return saveTokens(tok, { client_id: clientId, redirect_uri: redirect });
    } finally {
      server.close();
    }
  }

  async function refresh() {
    const t = store.read();
    if (!t || !t.refresh_token) throw new DeskError('The daemon is not signed in; run npm run worker:login.', { code: 'LOGIN_NEEDED' });
    const r = await form(`${origin}/oauth/token`, { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.client_id, resource });
    if (r.status >= 500) throw new DeskError(`The desk could not renew the sign-in now (HTTP ${r.status}).`, { code: 'HTTP', status: r.status, transient: true, sent: false });
    if (r.status !== 200) throw new DeskError('The desk no longer accepts this sign-in; run npm run worker:login again.', { code: 'LOGIN_NEEDED', status: r.status });
    return saveTokens(r, t);
  }

  async function accessToken() {
    const t = store.read();
    if (!t || !t.access_token) throw new DeskError('The daemon is not signed in; run npm run worker:login.', { code: 'LOGIN_NEEDED' });
    if (t.desk && t.desk !== origin) throw new DeskError(`The saved sign-in is for ${t.desk}, not ${origin}; run npm run worker:login.`, { code: 'LOGIN_NEEDED' });
    return Date.parse(t.expires_at) - 60000 > clock() ? t.access_token : (await refresh()).access_token;
  }

  async function post(name, args, access) {
    const r = await transport('POST', resource, { headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${access}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
    if (r.status === 401) throw new DeskError('The desk refused the access token.', { code: 'UNAUTHORIZED', status: 401, sent: false });
    if (r.status !== 200) throw new DeskError(`The desk answered HTTP ${r.status}.`, { code: 'HTTP', status: r.status, transient: [502, 503, 504].includes(r.status), sent: r.status === 504 });
    let j;
    try { j = JSON.parse(r.text); } catch (_) { throw new DeskError('The desk\'s answer was not JSON.', { code: 'HTTP', status: r.status, transient: true }); }
    if (j.error) throw new DeskError(`The desk refused the call: ${String(j.error.message || '').slice(0, 200)}`, { code: 'RPC' });
    const res = j.result || {};
    const text = (res.content || []).map((c) => c.text || '').join('\n');
    if (res.isError) throw new DeskError(text.slice(0, 1200) || 'The desk refused the call.', { code: codeOf(text) || 'REFUSED' });
    return res.structuredContent || {};
  }

  // One tool call: a refused token is renewed once; a passing failure is
  // asked again where that is safe (above).
  async function call(name, args = {}) {
    const read = READ_TOOLS.includes(name);
    let renewed = false;
    for (let i = 0; ; i += 1) {
      try {
        return await post(name, args, await accessToken());
      } catch (e) {
        if (!(e instanceof DeskError)) throw e;
        if (e.code === 'UNAUTHORIZED' && !renewed) { renewed = true; await refresh(); i -= 1; continue; }
        if (e.code === 'UNAUTHORIZED') throw new DeskError('The desk refuses the renewed token; run npm run worker:login again.', { code: 'LOGIN_NEEDED', status: 401 });
        const again = e.transient && (read || !e.sent || [502, 503].includes(e.status));
        if (!again || i >= retryDelays.length) throw e;
        await sleep(retryDelays[i]);
      }
    }
  }

  // What Eric may see about the sign-in: never a token.
  function signIn() {
    const t = store.read();
    return t ? { signed_in: true, desk: t.desk, client_id: t.client_id, access_expires_at: t.expires_at, saved_at: t.saved_at } : { signed_in: false, desk: origin };
  }

  return { origin, resource, login, refresh, call, signIn, tokenFile: store.file };
}

module.exports = { makeDesk, DeskError, fetchTransport, openInBrowser, codeOf, DEFAULT_DESK, READ_TOOLS };
