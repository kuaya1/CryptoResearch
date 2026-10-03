'use strict';
// The desk's Claude connector, end to end over HTTP against a temporary
// hosted desk: OAuth exactly as Claude's connector client runs it (discovery,
// dynamic registration, PKCE, consent with the passphrase, token exchange,
// rotating refresh, revocation), then the Cowork workflow through the MCP
// endpoint. Network access is switched off while the tools run, which shows
// that neither CoinGecko nor a paid model API is needed. Test passphrase and
// fictional project only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const hosted = require('../hosted');
const { start } = require('../server');
const { redirectAllowed, redirectKind, redirectMatches, guessLocal, CLAUDE_CALLBACK, CHATGPT_CALLBACK } = require('../oauth');
const research = require('../core/research');
const { runOp } = require('../core/ops');
const { mockReport } = require('../core/demo');
const { readJson } = require('../core/fsx');

const PASS = 'test-passphrase-not-real';
const HOST = 'desk.test';
const ORIGIN = `https://${HOST}`;
const RESOURCE = `${ORIGIN}/mcp`;

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
        try {
          json = JSON.parse(text);
        } catch (_) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const form = (o) => new URLSearchParams(o).toString();
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function desk(t, label) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `cr-connector-${label}-`));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 }));
  const dataDir = path.join(base, 'data');
  const port = await freePort();
  const cfg = hosted.hostedConfig({ CR_DATA_DIR: dataDir, CR_ACCESS_PASSWORD: PASS, PORT: String(port), RENDER_EXTERNAL_HOSTNAME: HOST });
  const ws = hosted.prepareWorkspace(cfg);
  const file = path.join(ws.root, 'config', 'settings.json');
  const s = readJson(file);
  s.market_data = { ...(s.market_data || {}), enabled: false };
  fs.writeFileSync(file, JSON.stringify(s));
  ws.reloadSettings();
  const opts = { quiet: true, hosted: { port, hosts: cfg.hosts, password: cfg.password, bind: '127.0.0.1', failDelayMs: 0 } };
  let srv = await start(ws, opts);
  t.after(() => srv && srv.shutdown());
  return {
    ws,
    get port() { return opts.hosted.port; },
    async restart() {
      srv.shutdown();
      opts.hosted.port = await freePort();
      srv = await start(ws, opts);
    },
  };
}

// ChatGPT's and Gemini's documented return addresses (fictional IDs).
const CHATGPT_APP_CALLBACK = 'https://chatgpt.com/connector/oauth/cb_fictional123';
const GEMINI_CALLBACK = `https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-1234567890-${HOST}`;

// A connection as an assistant's connector client makes it, step by step.
// assistant: what Eric picks on the consent page for a program on this computer.
async function connect(d, { redirect = CLAUDE_CALLBACK, presented = redirect, clientName = 'Claude', redirects = [redirect], authMethod = 'none', assistant = null, basicAuth = false, resource = RESOURCE } = {}) {
  const reg = await req(d.port, { method: 'POST', path: '/oauth/register', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: clientName, redirect_uris: redirects, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: authMethod }) });
  assert.equal(reg.status, 201, reg.text);
  assert.equal(reg.json.token_endpoint_auth_method, 'none', 'a public client, whatever it asked for');
  assert.equal(reg.json.client_secret, undefined, 'no secret is ever issued');
  const clientId = reg.json.client_id;
  const verifier = b64url(crypto.randomBytes(40));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const q = form({ response_type: 'code', client_id: clientId, redirect_uri: presented, code_challenge: challenge, code_challenge_method: 'S256', state: 'state-123', scope: 'desk offline_access', ...(resource ? { resource } : {}) });
  const consent = await req(d.port, { path: `/oauth/authorize?${q}` });
  assert.equal(consent.status, 200, consent.text);
  const requestId = consent.text.match(/name="request" value="([^"]+)"/)[1];
  const approve = await req(d.port, { method: 'POST', path: '/oauth/authorize', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN }, body: form({ request: requestId, password: PASS, decision: 'allow', ...(assistant ? { assistant } : {}) }) });
  assert.equal(approve.status, 303, approve.text);
  const back = new URL(approve.headers.location);
  assert.equal(back.searchParams.get('state'), 'state-123');
  assert.equal(back.searchParams.get('iss'), ORIGIN, 'issuer identification (RFC 9207)');
  const tokenForm = { grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: presented, code_verifier: verifier, ...(resource ? { resource } : {}) };
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (basicAuth) headers.authorization = `Basic ${Buffer.from(`${clientId}:`).toString('base64')}`;
  else tokenForm.client_id = clientId;
  const tok = await req(d.port, { method: 'POST', path: '/oauth/token', headers, body: form(tokenForm) });
  assert.equal(tok.status, 200, tok.text);
  return { clientId, access: tok.json.access_token, refresh: tok.json.refresh_token, tokenResponse: tok.json, consent, approve };
}

const connectChatgpt = (d) => connect(d, { redirect: CHATGPT_APP_CALLBACK, clientName: 'ChatGPT' });
const connectGemini = (d) => connect(d, { redirect: GEMINI_CALLBACK, clientName: 'Gemini', authMethod: 'client_secret_basic', basicAuth: true });

let nextId = 1;
async function rpc(d, access, method, params) {
  const r = await req(d.port, { method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${access}` }, body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }) });
  return r;
}
async function tool(d, access, name, args) {
  const r = await rpc(d, access, 'tools/call', { name, arguments: args });
  assert.equal(r.status, 200, r.text);
  const res = r.json.result;
  return { ...res, data: res.structuredContent || null, text: res.content.map((c) => c.text).join('\n') };
}

test('connector: redirect URIs are the assistants\' own only (Claude, ChatGPT, Gemini custom apps), loopback on any port', () => {
  assert.equal(redirectAllowed(CLAUDE_CALLBACK), true);
  assert.equal(redirectAllowed('http://localhost:3118/callback'), true);
  assert.equal(redirectAllowed('http://127.0.0.1/callback'), true);
  assert.equal(redirectAllowed('https://claude.ai/api/mcp/auth_callback?x=1'), false);
  assert.equal(redirectAllowed('https://evil.example/callback'), false);
  assert.equal(redirectAllowed('http://localhost:3118/other'), false);
  assert.equal(redirectMatches('http://localhost/callback', 'http://localhost:51234/callback'), true);
  assert.equal(redirectMatches('http://localhost/callback', 'http://127.0.0.1:51234/callback'), false);
  assert.equal(redirectMatches(CLAUDE_CALLBACK, 'https://claude.ai/api/mcp/auth_callback/'), false);
  // Each return address belongs to one assistant.
  assert.equal(redirectKind(CLAUDE_CALLBACK), 'claude');
  assert.equal(redirectKind(CHATGPT_CALLBACK), 'chatgpt');
  assert.equal(redirectKind(CHATGPT_APP_CALLBACK), 'chatgpt');
  assert.equal(redirectKind(GEMINI_CALLBACK), 'gemini');
  assert.equal(redirectKind(GEMINI_CALLBACK.replace('/r/', '/a/')), 'gemini', 'Gemini registers the /a/ form too');
  assert.equal(redirectKind(GEMINI_CALLBACK.replace('oauth-redirect.', 'oauth-redirect-sandbox.')), null, 'Google\'s sandbox relay is not accepted');
  assert.equal(redirectKind('http://127.0.0.1:7777/oauth/callback'), 'local', 'Gemini CLI');
  // Look-alikes are refused.
  for (const bad of [
    'https://chatgpt.com/connector_platform_oauth_redirect/',
    'https://chatgpt.com/connector/oauth/a/b',
    'https://chatgpt.com/aip/g-123/oauth/callback',
    'https://chatgpt.com.evil.example/connector_platform_oauth_redirect',
    'http://chatgpt.com/connector_platform_oauth_redirect',
    'https://oauth-redirect.googleusercontent.com/r/some-cloud-project',
    'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-1/../x',
    `https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-1?next=https://evil.example`,
    'https://evil.example/r/user_bound_custom-mcp-1',
    'https://user@chatgpt.com/connector/oauth/abc',
  ]) assert.equal(redirectKind(bad), null, bad);
  assert.equal(guessLocal('Gemini CLI MCP Client'), 'gemini');
  assert.equal(guessLocal('Codex'), 'chatgpt');
  assert.equal(guessLocal('Claude Code (cryptoresearch)'), 'claude');
  assert.equal(guessLocal('some tool'), null);
});

test('connector: Claude discovers the sign-in, registers, gets the passphrase consent, and receives rotating tokens', async (t) => {
  const d = await desk(t, 'oauth');
  // An unauthenticated MCP call starts sign-in with a 401 that points at the metadata.
  const first = await req(d.port, { method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
  assert.equal(first.status, 401);
  assert.match(first.headers['www-authenticate'], /^Bearer resource_metadata="https:\/\/desk\.test\/\.well-known\/oauth-protected-resource"/);
  const prm = await req(d.port, { path: '/.well-known/oauth-protected-resource' });
  assert.equal(prm.json.resource, RESOURCE);
  assert.deepEqual(prm.json.authorization_servers, [ORIGIN]);
  const asm = await req(d.port, { path: '/.well-known/oauth-authorization-server' });
  assert.equal(asm.json.issuer, ORIGIN);
  assert.deepEqual(asm.json.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(asm.json.token_endpoint_auth_methods_supported, ['none']);
  assert.equal(asm.json.registration_endpoint, `${ORIGIN}/oauth/register`);
  assert.equal(asm.json.client_id_metadata_document_supported, false, 'registration, not CIMD');
  assert.equal(asm.json.authorization_response_iss_parameter_supported, true, 'so ChatGPT uses its stable callback');

  // Only Claude's callbacks can register.
  const evil = await req(d.port, { method: 'POST', path: '/oauth/register', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }) });
  assert.equal(evil.status, 400);
  assert.equal(evil.json.error, 'invalid_redirect_uri');

  const c = await connect(d);
  assert.match(c.consent.headers['content-security-policy'], /form-action 'self' https:\/\/claude\.ai/);
  assert.match(c.consent.text, /Desk passphrase/);
  assert.match(c.consent.text, /claude\.ai/, 'the consent page names where it returns to');
  assert.equal(new URL(c.approve.headers.location).origin + new URL(c.approve.headers.location).pathname, CLAUDE_CALLBACK);
  assert.equal(c.tokenResponse.token_type, 'Bearer');
  assert.equal(c.tokenResponse.expires_in, 3600);
  assert.ok(c.refresh);

  // The token opens the MCP endpoint.
  const init = await rpc(d, c.access, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.status, 200);
  assert.equal(init.json.result.protocolVersion, '2025-06-18');
  assert.equal(init.json.result.serverInfo.name, 'cryptoresearch-desk');
  assert.match(init.json.result.instructions, /never records a holding/);
  const note = await req(d.port, { method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json', authorization: `Bearer ${c.access}` }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(note.status, 202);
  const list = await rpc(d, c.access, 'tools/list', {});
  assert.deepEqual(list.json.result.tools.map((x) => x.name).sort(), ['add_account', 'add_project', 'cancel_research', 'compare_reports', 'find_projects', 'get_report', 'get_research', 'list_accounts', 'pending_research', 'portfolio_overview', 'record_transaction', 'save_report', 'save_research_draft', 'start_research', 'update_project_identity']);
  // ChatGPT asks to confirm every tool without readOnlyHint: reads are marked read-only.
  const readOnly = list.json.result.tools.filter((x) => x.annotations && x.annotations.readOnlyHint).map((x) => x.name).sort();
  assert.deepEqual(readOnly, ['compare_reports', 'find_projects', 'get_report', 'get_research', 'list_accounts', 'pending_research', 'portfolio_overview']);
  assert.equal((await req(d.port, { method: 'GET', path: '/mcp', headers: { authorization: `Bearer ${c.access}` } })).status, 405);
  // A forged or stale token is refused with invalid_token.
  const bad = await req(d.port, { method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json', authorization: 'Bearer forged-token-forged-token-forged' }, body: '{}' });
  assert.equal(bad.status, 401);
  assert.match(bad.headers['www-authenticate'], /error="invalid_token"/);

  // Refresh tokens rotate: the old one stops working.
  const r1 = await req(d.port, { method: 'POST', path: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.clientId }) });
  assert.equal(r1.status, 200);
  assert.notEqual(r1.json.refresh_token, c.refresh);
  const again = await req(d.port, { method: 'POST', path: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.clientId }) });
  assert.equal(again.status, 400);
  assert.equal(again.json.error, 'invalid_grant');

  // Only hashes are stored; the connection survives a restart.
  const stored = fs.readFileSync(path.join(d.ws.root, '.cr', 'oauth.json'), 'utf8');
  assert.ok(!stored.includes(r1.json.access_token) && !stored.includes(r1.json.refresh_token));
  await d.restart();
  assert.equal((await rpc(d, r1.json.access_token, 'ping', {})).status, 200);

  // Disconnecting from Settings ends it.
  const login = await req(d.port, { method: 'POST', path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN }, body: form({ password: PASS }) });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const session = JSON.parse((await req(d.port, { path: '/api/session', headers: { cookie } })).text);
  const conns = await req(d.port, { path: '/api/connections', headers: { cookie, 'x-cr-token': session.token } });
  assert.equal(conns.json.mcp_url, RESOURCE);
  assert.equal(conns.json.connections.length, 1);
  const rev = await req(d.port, { method: 'POST', path: `/api/connections/${conns.json.connections[0].grant_id}/revoke`, headers: { cookie, 'x-cr-token': session.token, origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(rev.status, 200);
  assert.equal((await rpc(d, r1.json.access_token, 'ping', {})).status, 401, 'disconnected');
});

test('connector: sign-in refuses a wrong passphrase, a denial, a missing PKCE challenge, a reused code and a wrong verifier', async (t) => {
  const d = await desk(t, 'oauth-neg');
  const reg = await req(d.port, { method: 'POST', path: '/oauth/register', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK] }) });
  const clientId = reg.json.client_id;
  const verifier = b64url(crypto.randomBytes(40));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const authz = (extra = {}) => req(d.port, { path: `/oauth/authorize?${form({ response_type: 'code', client_id: clientId, redirect_uri: CLAUDE_CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', state: 's1', ...extra })}` });
  assert.equal((await req(d.port, { path: `/oauth/authorize?${form({ response_type: 'code', client_id: 'crc_unknown', redirect_uri: CLAUDE_CALLBACK, code_challenge: challenge, code_challenge_method: 'S256' })}` })).status, 400, 'unknown client: an error page, no redirect');
  const noPkce = await req(d.port, { path: `/oauth/authorize?${form({ response_type: 'code', client_id: clientId, redirect_uri: CLAUDE_CALLBACK, state: 's1' })}` });
  assert.equal(noPkce.status, 303);
  assert.equal(new URL(noPkce.headers.location).searchParams.get('error'), 'invalid_request');
  const page = await authz();
  const rid = page.text.match(/name="request" value="([^"]+)"/)[1];
  const post = (body, headers = {}) => req(d.port, { method: 'POST', path: '/oauth/authorize', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, ...headers }, body: form(body) });
  const wrong = await post({ request: rid, password: 'not the passphrase', decision: 'allow' });
  assert.equal(wrong.status, 200);
  assert.match(wrong.text, /not right/);
  assert.equal((await post({ request: rid, password: PASS, decision: 'allow' }, { origin: 'https://evil.example' })).status, 403, 'approval only from this site');
  const deny = await post({ request: rid, decision: 'deny' });
  assert.equal(new URL(deny.headers.location).searchParams.get('error'), 'access_denied');
  // A fresh approval, then a bad exchange and a reuse.
  const rid2 = (await authz()).text.match(/name="request" value="([^"]+)"/)[1];
  const ok = await post({ request: rid2, password: PASS, decision: 'allow' }, { origin: 'null', 'sec-fetch-site': 'same-origin' });
  assert.equal(ok.status, 303, 'Origin null from the browser is accepted with Sec-Fetch-Site same-origin');
  const code = new URL(ok.headers.location).searchParams.get('code');
  const tokenWith = (v) => req(d.port, { method: 'POST', path: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'authorization_code', code, redirect_uri: CLAUDE_CALLBACK, client_id: clientId, code_verifier: v }) });
  const badVerifier = await tokenWith(b64url(crypto.randomBytes(40)));
  assert.equal(badVerifier.json.error, 'invalid_grant');
  assert.equal((await tokenWith(verifier)).json.error, 'invalid_grant', 'a code works once, even after a failed exchange');
  // Claude Code's loopback redirect, on a port other than the registered one.
  // Eric says which model a program on this computer is.
  const cc = await connect(d, { redirect: 'http://localhost:3118/callback', presented: 'http://localhost:54321/callback', clientName: 'Claude Code (cryptoresearch)', assistant: 'claude' });
  assert.ok(cc.access);
  assert.match(cc.consent.text, /a program on this computer/);
  assert.match(cc.consent.text, /<option value="claude" selected>/, 'guessed from its name');
  assert.match(cc.consent.headers['content-security-policy'], /form-action 'self' http:\/\/localhost:54321(;|$)/, 'the form may return only to that program');
  // Without the model chosen, nothing is approved.
  const reg2 = await req(d.port, { method: 'POST', path: '/oauth/register', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'some tool', redirect_uris: ['http://127.0.0.1:7777/oauth/callback'] }) });
  const page2 = await req(d.port, { path: `/oauth/authorize?${form({ response_type: 'code', client_id: reg2.json.client_id, redirect_uri: 'http://127.0.0.1:7777/oauth/callback', code_challenge: challenge, code_challenge_method: 'S256', state: 's2' })}` });
  assert.match(page2.text, /<option value="" selected>Choose/);
  const rid3 = page2.text.match(/name="request" value="([^"]+)"/)[1];
  const unchosen = await post({ request: rid3, password: PASS, decision: 'allow' });
  assert.equal(unchosen.status, 200);
  assert.match(unchosen.text, /Choose which model this program is/);
  assert.equal((await post({ request: rid3, password: PASS, decision: 'allow', assistant: 'grok' })).status, 200, 'only claude, chatgpt or gemini');
  const chosen = await post({ request: rid3, password: PASS, decision: 'allow', assistant: 'gemini' });
  assert.equal(chosen.status, 303);
  // The same page submitted again (the back button) explains that the approval already went out.
  const twice = await post({ request: rid3, password: PASS, decision: 'allow', assistant: 'gemini' });
  assert.equal(twice.status, 400);
  assert.match(twice.text, /already given \(\d\d:\d\d UTC\) and sent back to the program on this computer \(Gemini\)\. If Gemini did not finish connecting/);
  // A registration mixing two assistants' callbacks is refused; a stranger's
  // address among an assistant's is dropped.
  const mixed = await req(d.port, { method: 'POST', path: '/oauth/register', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK, CHATGPT_CALLBACK] }) });
  assert.equal(mixed.status, 400);
  const extra = await req(d.port, { method: 'POST', path: '/oauth/register', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [GEMINI_CALLBACK, 'https://evil.example/cb'], token_endpoint_auth_method: 'client_secret_basic' }) });
  assert.equal(extra.status, 201);
  assert.deepEqual(extra.json.redirect_uris, [GEMINI_CALLBACK]);
  assert.equal(extra.json.token_endpoint_auth_method, 'none');
});

test('connector: ChatGPT and Gemini connect with their own sign-in flows, and each connection is filed under its model', async (t) => {
  const d = await desk(t, 'assistants');
  // ChatGPT: dynamic registration, its per-app callback, resource as the bare origin.
  const g = await connect(d, { redirect: CHATGPT_APP_CALLBACK, clientName: 'ChatGPT', resource: ORIGIN });
  assert.match(g.consent.text, /Connect ChatGPT to your desk/);
  assert.match(g.consent.text, /as ChatGPT/);
  assert.match(g.consent.headers['content-security-policy'], /form-action 'self' https:\/\/chatgpt\.com(;|$)/);
  assert.equal(new URL(g.approve.headers.location).href.split('?')[0], CHATGPT_APP_CALLBACK);
  // The stable callback works too (the server sends iss).
  const g2 = await connect(d, { redirect: CHATGPT_CALLBACK, clientName: 'ChatGPT' });
  assert.ok(g2.access);
  // Gemini, as it registered on the live desk: six return addresses (the relay's
  // /r/ and /a/ forms on Google's production, sandbox and test relays) and
  // client_secret_basic. It gets a public client with the two production
  // addresses, and sends its client ID in a Basic header.
  const relays = ['oauth-redirect', 'oauth-redirect-sandbox', 'oauth-redirect-test'].flatMap((h) => ['r', 'a'].map((p) => `https://${h}.googleusercontent.com/${p}/user_bound_custom-mcp-100000000000001-desk_test`));
  const gm = await connect(d, { redirect: relays[0], redirects: relays, clientName: 'Google', authMethod: 'client_secret_basic', basicAuth: true, resource: null });
  assert.match(gm.consent.text, /Connect Gemini to your desk/);
  assert.match(gm.consent.headers['content-security-policy'], /form-action 'self' https:\/\/oauth-redirect\.googleusercontent\.com(;|$)/);
  // The sign-in window stays linked to the Gemini page that opened it, so
  // Google's relay can hand the code back (every other desk page keeps same-origin).
  assert.equal(gm.consent.headers['cross-origin-opener-policy'], 'unsafe-none');
  assert.equal(gm.approve.headers['cross-origin-opener-policy'], 'unsafe-none');
  assert.equal((await req(d.port, { path: '/login' })).headers['cross-origin-opener-policy'], 'same-origin');
  const reg = JSON.parse(fs.readFileSync(path.join(d.ws.root, '.cr', 'oauth.json'), 'utf8')).clients[gm.clientId];
  assert.deepEqual(reg.redirect_uris, relays.slice(0, 2));
  // A Gemini refresh with the client ID in a Basic header.
  const ref = await req(d.port, { method: 'POST', path: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${gm.clientId}:`).toString('base64')}` }, body: form({ grant_type: 'refresh_token', refresh_token: gm.refresh }) });
  assert.equal(ref.status, 200, ref.text);
  // Each connection knows its model; the server tells it so.
  const initG = await rpc(d, g.access, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'openai-mcp', version: '1' } });
  assert.match(initG.json.result.instructions, /This connection belongs to ChatGPT/);
  const initGm = await rpc(d, ref.json.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gemini', version: '1' } });
  assert.match(initGm.json.result.instructions, /This connection belongs to Gemini/);
  const c = await connect(d);
  assert.match((await rpc(d, c.access, 'initialize', { protocolVersion: '2025-06-18' })).json.result.instructions, /This connection belongs to Claude/);
  // The address with a trailing slash, and a call carrying the assistant's own origin, work; another site's origin does not.
  const slash = await req(d.port, { method: 'POST', path: '/mcp/', headers: { 'content-type': 'application/json', authorization: `Bearer ${g.access}`, origin: 'https://chatgpt.com' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
  assert.equal(slash.status, 200, slash.text);
  const foreign = await req(d.port, { method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json', authorization: `Bearer ${g.access}`, origin: 'https://evil.example' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
  assert.equal(foreign.status, 403);
  // Settings > Connected apps shows the model of each connection.
  const login = await req(d.port, { method: 'POST', path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN }, body: form({ password: PASS }) });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const session = JSON.parse((await req(d.port, { path: '/api/session', headers: { cookie } })).text);
  const conns = await req(d.port, { path: '/api/connections', headers: { cookie, 'x-cr-token': session.token } });
  assert.deepEqual(conns.json.connections.map((x) => x.assistant).sort(), ['chatgpt', 'chatgpt', 'claude', 'gemini']);
  // A connection made before ChatGPT and Gemini could connect is Claude's.
  const file = path.join(d.ws.root, '.cr', 'oauth.json');
  const store = readJson(file);
  for (const gr of Object.values(store.grants)) if (gr.client_name === 'Claude') delete gr.assistant;
  fs.writeFileSync(file, JSON.stringify(store));
  await d.restart();
  assert.match((await rpc(d, c.access, 'initialize', { protocolVersion: '2025-06-18' })).json.result.instructions, /This connection belongs to Claude/);
});

test('connector: the Cowork workflow (find, add once, research, draft, resume, save the full report, restart) with no network, and the report survives a restart', async (t) => {
  const d = await desk(t, 'mcp');
  const { access } = await connect(d);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { throw new Error(`network call attempted: ${url}`); };
  t.after(() => { globalThis.fetch = realFetch; });

  assert.equal((await tool(d, access, 'find_projects', { query: '' })).data.total_projects, 0);
  const addArgs = { name: 'Examplecoin (FICTIONAL)', symbol: 'XMC', official_website: 'https://examplecoin.example/', contracts: [{ chain: 'base', address: '0x2222222222222222222222222222222222222222' }], evidence: [{ url: 'https://examplecoin.example/docs/token', note: 'fictional official token page' }], sector: 'payments', owner_request: 'Research Examplecoin for me (FICTIONAL)' };
  const added = await tool(d, access, 'add_project', addArgs);
  assert.equal(added.isError, false, added.text);
  assert.equal(added.data.status, 'created');
  const pid = added.data.project.project_id;
  assert.equal(added.data.project.identity.status, 'verified', 'website + contract + evidence, no CoinGecko needed');
  assert.equal((await tool(d, access, 'add_project', addArgs)).data.status, 'exists', 'repeating the instruction adds nothing');
  const twin = await tool(d, access, 'add_project', { ...addArgs, name: 'Other Examplecoin (FICTIONAL)', official_website: 'https://other.example/', contracts: [], evidence: [{ url: 'https://other.example/' }] });
  assert.equal(twin.data.status, 'possible_duplicate', 'a shared ticker is never merged silently');
  assert.equal((await tool(d, access, 'find_projects', { query: '0x2222222222222222222222222222222222222222' })).data.matches[0].project_id, pid, 'found by contract');

  const started = await tool(d, access, 'start_research', { project_id: pid, owner_request: 'Research Examplecoin for me (FICTIONAL)', instructions: 'Is the March unlock a risk inside four months?' });
  assert.equal(started.data.status, 'created', started.text);
  const runId = started.data.run.run_id;
  assert.match(started.text, /--- Research prompt for run_/);
  assert.match(started.text, /## The owner's questions for this run/);
  assert.match(started.text, /Examplecoin \(FICTIONAL\)/);
  assert.equal(started.data.run.claude.mode, 'cowork');
  assert.equal(started.data.run.claude.state, 'running');
  const resumed = await tool(d, access, 'start_research', { project_id: pid, owner_request: 'research it again please' });
  assert.equal(resumed.data.status, 'resumed');
  assert.equal(resumed.data.run.run_id, runId, 'the same run, not a second one');
  assert.equal(research.listRuns(d.ws, pid).length, 1);

  const draft = await tool(d, access, 'save_research_draft', { project_id: pid, run_id: runId, draft_markdown: '## 1. Legitimacy\nFICTIONAL draft so far, with sources.\n', note: 'section 1 drafted' });
  assert.equal(draft.data.status, 'saved');
  // An interruption: two hours with no sign of life.
  runOp(d.ws, { type: 'test_idle', summary: 'simulate an interrupted session' }, (op) => {
    const rel = `projects/${pid}/research/${runId}/run.json`;
    const run = op.readJson(rel);
    run.jobs.claude.progress_at = new Date(Date.now() - 2 * 3600000).toISOString();
    run.jobs.claude.updated_at = run.jobs.claude.progress_at;
    op.writeJson(rel, run);
  });
  const view = await tool(d, access, 'get_research', { project_id: pid });
  assert.equal(view.data.run.cowork.interrupted, true);
  assert.match(view.text, /--- Your saved draft for/);
  assert.match(view.text, /FICTIONAL draft so far/);
  assert.equal((await tool(d, access, 'find_projects', { query: 'examplecoin' })).data.matches[0].open_research.cowork.interrupted, true);

  // Resume and finish: the complete report.
  const run = research.loadRun(d.ws, pid, runId);
  const text = mockReport(d.ws, 'claude', run);
  assert.ok(text.length > 2000);
  const short = await tool(d, access, 'save_report', { project_id: pid, run_id: runId, report_markdown: 'Too short to be a report.' });
  assert.equal(short.isError, true);
  const saved = await tool(d, access, 'save_report', { project_id: pid, run_id: runId, report_markdown: text });
  assert.equal(saved.isError, false, saved.text);
  assert.equal(saved.data.status, 'saved');
  assert.equal(saved.data.run.claude_state, 'completed');
  const reportId = saved.data.report.report_id;
  assert.ok(saved.data.report.verdict);
  assert.equal((await tool(d, access, 'save_report', { project_id: pid, run_id: runId, report_markdown: text })).data.status, 'unchanged', 'saving the same report again changes nothing');
  assert.ok(fs.existsSync(path.join(d.ws.root, 'projects', pid, 'reports', reportId, 'original.md')));
  const meta = readJson(path.join(d.ws.root, 'projects', pid, 'reports', reportId, 'meta.json'));
  assert.equal(meta.provider, 'claude');
  assert.match(meta.provenance.channel, /Cowork/);
  assert.equal(meta.imported_by, 'cowork');

  // Asking again the same day starts nothing; refresh and restart do, once each.
  assert.equal((await tool(d, access, 'start_research', { project_id: pid, owner_request: 'research Examplecoin' })).data.status, 'recent_report');
  const fresh = await tool(d, access, 'start_research', { project_id: pid, owner_request: 'yes, research it again', refresh: true });
  assert.equal(fresh.data.status, 'created');
  const restarted = await tool(d, access, 'start_research', { project_id: pid, owner_request: 'start over', restart: true });
  assert.equal(restarted.data.status, 'restarted');
  assert.notEqual(restarted.data.run.run_id, fresh.data.run.run_id);
  assert.equal(research.loadRun(d.ws, pid, fresh.data.run.run_id).jobs.claude.state, 'canceled');
  assert.equal(research.openCoworkJobs(d.ws, pid).length, 1);

  // Research never recorded a holding.
  assert.equal(readJson(path.join(d.ws.root, 'portfolio', 'transactions.json')).transactions.length, 0);

  // The start log's record count, which is how a restart on Render is checked.
  const before = hosted.recordsSummary(d.ws);
  assert.match(before, /^Records: 1 project \(1 on the watchlist: examplecoin-fictional\), 1 report, newest examplecoin-fictional\/\S+ \(saved [^)]+\), 0 transactions; 1 connected app\.$/);
  // The saved report is still there after a restart (a deploy).
  await d.restart();
  assert.equal(hosted.recordsSummary(d.ws), before);
  const after = await tool(d, access, 'get_report', { project_id: pid, include_text: true });
  assert.equal(after.data.report.report_id, reportId);
  assert.equal(after.data.text, text);
});

test('connector: a run already waiting for a Claude answer (started from the dashboard) is taken over, not duplicated', async (t) => {
  const d = await desk(t, 'mcp-adopt');
  const { access } = await connect(d);
  const pid = (await tool(d, access, 'add_project', { name: 'Examplecoin (FICTIONAL)', symbol: 'XMC', official_website: 'https://examplecoin.example/', contracts: [{ chain: 'base', address: '0x2222222222222222222222222222222222222222' }], evidence: [{ url: 'https://examplecoin.example/' }], owner_request: 'add it' })).data.project.project_id;
  // New research on the phone without an API key: the Claude job waits for a pasted answer.
  const prev = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  t.after(() => { if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev; });
  const waiting = research.createRun(d.ws, { project_id: pid, providers: ['claude'], channel: 'intake' });
  assert.equal(research.loadRun(d.ws, pid, waiting.run_id).jobs.claude.state, 'unconfigured');
  const took = await tool(d, access, 'start_research', { project_id: pid, owner_request: 'Research Examplecoin (FICTIONAL)' });
  assert.equal(took.data.status, 'resumed');
  assert.equal(took.data.run.run_id, waiting.run_id, 'the waiting run, not a new one');
  assert.match(took.text, /--- Research prompt for/);
  const job = research.loadRun(d.ws, pid, waiting.run_id).jobs.claude;
  assert.equal(job.mode, 'cowork');
  assert.equal(job.state, 'running');
  assert.equal(research.listRuns(d.ws, pid).length, 1);
});

const EXAMPLECOIN = { name: 'Examplecoin (FICTIONAL)', symbol: 'XMC', official_website: 'https://examplecoin.example/', contracts: [{ chain: 'base', address: '0x2222222222222222222222222222222222222222' }], evidence: [{ url: 'https://examplecoin.example/docs/token' }], sector: 'payments', owner_request: 'add it (FICTIONAL)' };
const KEY_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];

// Sets (or clears, with null) research API keys for one test and restores them after.
function withKeys(t, values) {
  const saved = Object.fromEntries(KEY_VARS.map((k) => [k, process.env[k]]));
  for (const k of KEY_VARS) {
    if (values[k]) process.env[k] = values[k];
    else delete process.env[k];
  }
  t.after(() => {
    for (const k of KEY_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

function idle(ws, pid, runId, provider, hours) {
  runOp(ws, { type: 'test_idle', summary: 'simulate an interrupted session' }, (op) => {
    const rel = `projects/${pid}/research/${runId}/run.json`;
    const run = op.readJson(rel);
    run.jobs[provider].progress_at = new Date(Date.now() - hours * 3600000).toISOString();
    run.jobs[provider].updated_at = run.jobs[provider].progress_at;
    op.writeJson(rel, run);
  });
}

async function waitFor(check, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting');
}

test('connector: one Cowork request for all three models; ChatGPT and Gemini do their part through their own connections with the same prompt, independently; three separate graded reports, compared; no network, no paid API', async (t) => {
  const d = await desk(t, 'three');
  withKeys(t, {});
  const claude = await connect(d);
  const chatgpt = await connectChatgpt(d);
  const gemini = await connectGemini(d);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { throw new Error(`network call attempted: ${url}`); };
  t.after(() => { globalThis.fetch = realFetch; });

  const pid = (await tool(d, claude.access, 'add_project', EXAMPLECOIN)).data.project.project_id;
  const all = await tool(d, claude.access, 'start_research', { project_id: pid, owner_request: 'Research Examplecoin with all three models (FICTIONAL)', models: 'all' });
  assert.equal(all.data.status, 'created', all.text);
  const runId = all.data.run.run_id;
  assert.deepEqual(all.data.run.models, ['claude', 'chatgpt', 'gemini']);
  assert.equal(all.data.run.jobs.claude.state, 'running');
  assert.equal(all.data.run.jobs.chatgpt.state, 'unconfigured');
  assert.equal(all.data.run.jobs.gemini.state, 'unconfigured');
  assert.match(all.data.message, /ChatGPT: waiting for ChatGPT: Eric asks ChatGPT "Do my waiting CryptoResearch research"/);
  const promptFile = fs.readFileSync(path.join(d.ws.root, 'projects', pid, 'research', runId, 'prompt.md'), 'utf8');
  assert.ok(all.text.includes(promptFile), 'Claude gets the run prompt');
  // Saying it again changes nothing: the same run, no second job for anyone.
  const again = await tool(d, claude.access, 'start_research', { project_id: pid, owner_request: 'all three again', models: 'all' });
  assert.equal(again.data.status, 'resumed');
  assert.equal(again.data.run.run_id, runId);
  assert.equal(research.listRuns(d.ws, pid).length, 1);

  // ChatGPT: what is waiting for it, and no other model's conclusions.
  const pend = await tool(d, chatgpt.access, 'pending_research', {});
  assert.deepEqual(pend.data.pending.map((x) => [x.project_id, x.run_id, x.state]), [[pid, runId, 'waiting']]);
  assert.equal((await tool(d, gemini.access, 'pending_research', {})).data.pending.length, 1);
  assert.equal((await tool(d, claude.access, 'pending_research', {})).data.pending[0].state, 'started');
  const took = await tool(d, chatgpt.access, 'start_research', { project_id: pid, owner_request: 'Do my waiting CryptoResearch research' });
  assert.equal(took.data.status, 'resumed', took.text);
  assert.equal(took.data.run.run_id, runId);
  assert.equal(took.data.run.yours.mode, 'connector');
  assert.ok(took.text.includes(promptFile), 'ChatGPT gets exactly the same prompt');
  assert.equal(took.data.run.claude, undefined, 'no Claude-only fields for ChatGPT');

  // Claude saves first.
  const run0 = research.loadRun(d.ws, pid, runId);
  const claudeText = mockReport(d.ws, 'claude', run0);
  const cs = await tool(d, claude.access, 'save_report', { project_id: pid, run_id: runId, report_markdown: claudeText });
  assert.equal(cs.data.status, 'saved', cs.text);
  assert.match(cs.data.message, /Still open in this run: ChatGPT and Gemini/);
  // While its own research is open, ChatGPT sees no other model's conclusions.
  const fp = await tool(d, chatgpt.access, 'find_projects', { query: 'examplecoin' });
  assert.equal(fp.data.matches[0].your_latest_report, null);
  assert.deepEqual(Object.keys(fp.data.matches[0].reports_by_model), ['claude'], 'only that a Claude report exists');
  assert.ok(!JSON.stringify(fp.data).includes('"verdict"'), 'no verdict of another model');
  for (const peek of [
    await tool(d, chatgpt.access, 'get_report', { project_id: pid, model: 'claude' }),
    await tool(d, chatgpt.access, 'get_report', { project_id: pid, report_id: cs.data.report.report_id }),
    await tool(d, chatgpt.access, 'compare_reports', { project_id: pid }),
  ]) {
    assert.equal(peek.isError, true);
    assert.match(peek.text, /withheld while your own research on it is open/);
  }
  // A ChatGPT connection cannot file Claude's text, or a report that names another model, as ChatGPT's.
  const copied = await tool(d, chatgpt.access, 'save_report', { project_id: pid, run_id: runId, report_markdown: claudeText });
  assert.equal(copied.isError, true);
  assert.match(copied.text, /not ChatGPT's report/);
  const gptText = mockReport(d.ws, 'chatgpt', run0);
  const gs = await tool(d, chatgpt.access, 'save_report', { project_id: pid, run_id: runId, report_markdown: gptText });
  assert.equal(gs.data.status, 'saved', gs.text);
  assert.equal(gs.data.run.state, 'completed');
  const gptMeta = readJson(path.join(d.ws.root, 'projects', pid, 'reports', gs.data.report.report_id, 'meta.json'));
  assert.equal(gptMeta.provider, 'chatgpt');
  assert.equal(gptMeta.provenance.channel, 'ChatGPT (desk connector)');
  assert.equal(gptMeta.provenance.research_run_id, runId);
  assert.equal(gptMeta.imported_by, 'chatgpt-connector');
  // Claude, done, compares the two it has; Gemini is still waiting.
  const cmp2 = await tool(d, claude.access, 'compare_reports', { project_id: pid });
  assert.equal(cmp2.data.status, 'ok', cmp2.text);
  assert.deepEqual(Object.keys(cmp2.data.reports).sort(), ['chatgpt', 'claude']);
  assert.deepEqual(cmp2.data.missing_models.map((m) => m.model), ['gemini']);
  assert.match(cmp2.data.missing_models[0].progress, /waiting for Gemini/);
  assert.ok(cmp2.data.scores.length > 0);
  assert.equal(research.runStatus(research.loadRun(d.ws, pid, runId)), 'partially_completed');

  // Gemini takes its job, is interrupted, resumes the same run and finishes.
  const gm = await tool(d, gemini.access, 'start_research', { project_id: pid, owner_request: 'Do my waiting CryptoResearch research' });
  assert.equal(gm.data.status, 'resumed');
  const mislabeled = await tool(d, gemini.access, 'save_report', { project_id: pid, run_id: runId, report_markdown: gptText.replace('FICTIONAL', 'FICTIONAL variant') });
  assert.equal(mislabeled.isError, true);
  assert.match(mislabeled.text, /identifies it as ChatGPT/);
  assert.equal((await tool(d, gemini.access, 'save_research_draft', { project_id: pid, run_id: runId, draft_markdown: '## 1. Legitimacy\nFICTIONAL Gemini draft.\n', note: 'section 1' })).data.status, 'saved');
  idle(d.ws, pid, runId, 'gemini', 2);
  const gv = await tool(d, gemini.access, 'get_research', { project_id: pid });
  assert.equal(gv.data.run.yours.activity.interrupted, true);
  assert.match(gv.text, /FICTIONAL Gemini draft/);
  assert.equal((await tool(d, gemini.access, 'start_research', { project_id: pid, owner_request: 'resume it' })).data.run.run_id, runId);
  const gms = await tool(d, gemini.access, 'save_report', { project_id: pid, run_id: runId, report_markdown: mockReport(d.ws, 'gemini', run0) });
  assert.equal(gms.data.status, 'saved', gms.text);
  assert.match(gms.data.message, /Every model in this run is done/);
  assert.equal(research.runStatus(research.loadRun(d.ws, pid, runId)), 'completed');
  const cmp3 = await tool(d, gemini.access, 'compare_reports', { project_id: pid });
  assert.deepEqual(Object.keys(cmp3.data.reports).sort(), ['chatgpt', 'claude', 'gemini']);
  assert.equal(cmp3.data.comparable, true, cmp3.text);
  // Three reports, each graded on its own, each under its own model.
  const detail = require('../core/indexer').projectDetail(d.ws, pid);
  for (const m of ['claude', 'chatgpt', 'gemini']) {
    assert.equal(detail.history[m].length, 1, m);
    assert.ok(detail.history[m][0].grade, `${m} graded`);
  }
  // The same request again today starts nothing; research never recorded a holding.
  assert.equal((await tool(d, claude.access, 'start_research', { project_id: pid, owner_request: 'all three once more', models: 'all' })).data.status, 'recent_report');
  assert.equal(readJson(path.join(d.ws.root, 'portfolio', 'transactions.json')).transactions.length, 0);
  // Claude-only research is still the default.
  const solo = (await tool(d, claude.access, 'add_project', { ...EXAMPLECOIN, name: 'Solocoin (FICTIONAL)', symbol: 'SOLO', official_website: 'https://solocoin.example/', contracts: [{ chain: 'base', address: '0x3333333333333333333333333333333333333333' }], evidence: [{ url: 'https://solocoin.example/' }] })).data.project.project_id;
  const one = await tool(d, claude.access, 'start_research', { project_id: solo, owner_request: 'research Solocoin' });
  assert.deepEqual(one.data.run.models, ['claude']);
});

test('connector: with paid APIs set up, "all three models" runs ChatGPT and Gemini in the background within the limits; one failing never touches the others, and a repeat sends nothing twice', async (t) => {
  const d = await desk(t, 'three-api');
  // FICTIONAL test keys: every request is answered by the stub below and never leaves this computer.
  withKeys(t, { OPENAI_API_KEY: 'test-openai-key-fictional', GEMINI_API_KEY: 'test-gemini-key-fictional' });
  const file = path.join(d.ws.root, 'config', 'settings.json');
  const s = readJson(file);
  s.research.providers.chatgpt = { model: 'gpt-fictional-test', input_usd_per_mtok: 2, output_usd_per_mtok: 10, search_usd_per_call: 0.01, max_searches: 5 };
  s.research.providers.gemini = { model: 'gemini-fictional-test', input_usd_per_mtok: 1.25, output_usd_per_mtok: 10, max_searches: 0 };
  fs.writeFileSync(file, JSON.stringify(s));
  d.ws.reloadSettings();
  const claude = await connect(d);
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    const body = JSON.parse(init.body);
    const runId = (String(body.input || (body.contents && body.contents[0].parts[0].text) || '').match(/run_[A-Za-z0-9_-]+/) || [])[0];
    const run = research.loadRun(d.ws, 'examplecoin-fictional', runId);
    if (u === 'https://api.openai.com/v1/responses') {
      assert.equal(body.store, false);
      assert.equal(body.max_tool_calls, 5, 'the search limit is sent');
      assert.equal(init.headers.authorization, 'Bearer test-openai-key-fictional');
      return new Response(JSON.stringify({ id: 'resp_fictional_1', model: 'gpt-fictional-test', status: 'completed', output: [{ type: 'web_search_call', action: { type: 'search' } }, { type: 'message', content: [{ type: 'output_text', text: mockReport(d.ws, 'chatgpt', run) }] }], usage: { input_tokens: 12000, output_tokens: 9000 } }), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'req_fictional_1' } });
    }
    if (u.startsWith('https://generativelanguage.googleapis.com/')) {
      return new Response(JSON.stringify({ error: { code: 400, message: 'FICTIONAL: API key not valid.' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected network call: ${u}`);
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const pid = (await tool(d, claude.access, 'add_project', EXAMPLECOIN)).data.project.project_id;
  assert.equal(pid, 'examplecoin-fictional');
  const all = await tool(d, claude.access, 'start_research', { project_id: pid, owner_request: 'Research Examplecoin with all three models (FICTIONAL)', models: 'all' });
  assert.equal(all.data.status, 'created', all.text);
  const runId = all.data.run.run_id;
  assert.equal(all.data.run.jobs.claude.state, 'running', 'Claude stays in Cowork');
  assert.equal(all.data.run.jobs.chatgpt.mode, 'api');
  assert.match(all.data.message, /ChatGPT: queued for the ChatGPT API in the background/);
  await waitFor(() => {
    const r = research.loadRun(d.ws, pid, runId);
    return ['completed', 'failed'].includes(r.jobs.chatgpt.state) && ['completed', 'failed'].includes(r.jobs.gemini.state);
  });
  const run = research.loadRun(d.ws, pid, runId);
  assert.equal(run.jobs.chatgpt.state, 'completed', JSON.stringify(run.jobs.chatgpt));
  assert.equal(run.jobs.gemini.state, 'failed', 'a bad key fails Gemini only');
  assert.match(run.jobs.gemini.error, /HTTP 400/);
  const a = run.jobs.chatgpt.attempts[0];
  assert.equal(a.cost_actual_usd, 0.124, '12,000 in + 9,000 out tokens + 1 search at the configured prices');
  assert.ok(a.reserved_usd > 0 && a.reserved_usd <= 5, 'reserved within the per-run limit before it was sent');
  const meta = readJson(path.join(d.ws.root, 'projects', pid, 'reports', run.jobs.chatgpt.report_id, 'meta.json'));
  assert.equal(meta.provider, 'chatgpt');
  assert.equal(meta.provenance.attested.response_id, 'resp_fictional_1');
  // Progress, as Cowork sees it.
  const view = await tool(d, claude.access, 'get_research', { project_id: pid });
  assert.match(view.data.run.jobs.chatgpt.progress, /^saved/);
  assert.match(view.data.run.jobs.gemini.progress, /^failed: HTTP 400/);
  assert.equal(view.data.run.jobs.chatgpt.cost_counted_usd, 0.124);
  // Asking again sends nothing twice.
  const sent = calls.length;
  assert.equal((await tool(d, claude.access, 'start_research', { project_id: pid, owner_request: 'all three again', models: 'all' })).data.status, 'resumed');
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(calls.length, sent, 'no second paid request');
  // Claude finishes in Cowork; the ChatGPT report stays, Gemini's failure stays its own.
  const cs = await tool(d, claude.access, 'save_report', { project_id: pid, run_id: runId, report_markdown: mockReport(d.ws, 'claude', run) });
  assert.equal(cs.data.status, 'saved', cs.text);
  assert.equal(research.runStatus(research.loadRun(d.ws, pid, runId)), 'partially_completed');
  assert.deepEqual(Object.keys((await tool(d, claude.access, 'compare_reports', { project_id: pid })).data.reports).sort(), ['chatgpt', 'claude']);
  assert.ok(research.spendSoFar(d.ws).daily >= 0.124, 'counted against the daily limit');
  // The keys never reached the records.
  const all2 = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else all2.push(p); } };
  walk(d.ws.root);
  for (const f of all2) assert.ok(!fs.readFileSync(f, 'utf8').includes('test-openai-key-fictional'), f);
});

test('connector: a transaction is recorded only on an explicit request, asks for what is missing, and applies once', async (t) => {
  const d = await desk(t, 'mcp-tx');
  const { access } = await connect(d);
  const pid = (await tool(d, access, 'add_project', { name: 'Examplecoin (FICTIONAL)', symbol: 'XMC', official_website: 'https://examplecoin.example/', contracts: [{ chain: 'base', address: '0x2222222222222222222222222222222222222222' }], evidence: [{ url: 'https://examplecoin.example/' }], owner_request: 'add it' })).data.project.project_id;
  const accounts = await tool(d, access, 'list_accounts', {});
  assert.ok(accounts.data.assets.some((a) => a.asset_id === pid), 'a verified project without a CoinGecko ID can hold positions under its project ID');
  const base = { request_id: 'tx-2026-10-03-xmc-1', owner_request: 'I bought 1,500 XMC on Test Exchange at 2 cents (FICTIONAL)', type: 'buy', date: '2026-10-01', account_id: 'test-exchange-fictional', asset_id: pid, quantity: '1500', price_usd: '0.02' };
  const noWords = await tool(d, access, 'record_transaction', { ...base, owner_request: '' });
  assert.equal(noWords.isError, true);
  const missing = await tool(d, access, 'record_transaction', { ...base, quantity: '' });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /Missing: quantity\. Ask Eric for it/);
  const noAccount = await tool(d, access, 'record_transaction', base);
  assert.equal(noAccount.isError, true);
  assert.match(noAccount.text, /unknown account/);
  assert.equal((await tool(d, access, 'add_account', { name: 'Test Exchange (FICTIONAL)', kind: 'exchange', owner_request: 'it was on Test Exchange' })).data.account_id, 'test-exchange-fictional');
  const rec = await tool(d, access, 'record_transaction', base);
  assert.equal(rec.isError, false, rec.text);
  assert.equal(rec.data.status, 'saved');
  const again = await tool(d, access, 'record_transaction', base);
  assert.equal(again.data.status, 'unchanged', 'a repeated call with the same request_id records nothing new');
  const conflict = await tool(d, access, 'record_transaction', { ...base, quantity: '9999' });
  assert.equal(conflict.isError, true);
  assert.match(conflict.text, /IDEMPOTENCY_CONFLICT/);
  const txs = readJson(path.join(d.ws.root, 'portfolio', 'transactions.json')).transactions;
  assert.equal(txs.length, 1);
  assert.equal(txs[0].source, 'cowork');
  const pf = await tool(d, access, 'portfolio_overview', {});
  assert.equal(pf.data.positions.length, 1);
  assert.equal(pf.data.positions[0].quantity, '1500');
  assert.equal(pf.data.positions[0].price, 'unavailable', 'no price source: unavailable, not zero');
});
