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
const { redirectAllowed, redirectMatches, CLAUDE_CALLBACK } = require('../oauth');
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

// The connection Claude makes, step by step.
async function connect(d, { redirect = CLAUDE_CALLBACK, presented = redirect } = {}) {
  const reg = await req(d.port, { method: 'POST', path: '/oauth/register', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
  assert.equal(reg.status, 201, reg.text);
  const clientId = reg.json.client_id;
  const verifier = b64url(crypto.randomBytes(40));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const q = form({ response_type: 'code', client_id: clientId, redirect_uri: presented, code_challenge: challenge, code_challenge_method: 'S256', state: 'state-123', scope: 'desk offline_access', resource: RESOURCE });
  const consent = await req(d.port, { path: `/oauth/authorize?${q}` });
  assert.equal(consent.status, 200, consent.text);
  const requestId = consent.text.match(/name="request" value="([^"]+)"/)[1];
  const approve = await req(d.port, { method: 'POST', path: '/oauth/authorize', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN }, body: form({ request: requestId, password: PASS, decision: 'allow' }) });
  assert.equal(approve.status, 303, approve.text);
  const back = new URL(approve.headers.location);
  assert.equal(back.searchParams.get('state'), 'state-123');
  const tok = await req(d.port, { method: 'POST', path: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: presented, client_id: clientId, code_verifier: verifier, resource: RESOURCE }) });
  assert.equal(tok.status, 200, tok.text);
  return { clientId, access: tok.json.access_token, refresh: tok.json.refresh_token, tokenResponse: tok.json, consent, approve };
}

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

test('connector: redirect URIs are Claude\'s own only, loopback on any port', () => {
  assert.equal(redirectAllowed(CLAUDE_CALLBACK), true);
  assert.equal(redirectAllowed('http://localhost:3118/callback'), true);
  assert.equal(redirectAllowed('http://127.0.0.1/callback'), true);
  assert.equal(redirectAllowed('https://claude.ai/api/mcp/auth_callback?x=1'), false);
  assert.equal(redirectAllowed('https://evil.example/callback'), false);
  assert.equal(redirectAllowed('http://localhost:3118/other'), false);
  assert.equal(redirectMatches('http://localhost/callback', 'http://localhost:51234/callback'), true);
  assert.equal(redirectMatches('http://localhost/callback', 'http://127.0.0.1:51234/callback'), false);
  assert.equal(redirectMatches(CLAUDE_CALLBACK, 'https://claude.ai/api/mcp/auth_callback/'), false);
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
  assert.equal(asm.json.client_id_metadata_document_supported, undefined, 'registration, not CIMD');

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
  assert.deepEqual(list.json.result.tools.map((x) => x.name).sort(), ['add_account', 'add_project', 'cancel_research', 'find_projects', 'get_report', 'get_research', 'list_accounts', 'portfolio_overview', 'record_transaction', 'save_report', 'save_research_draft', 'start_research', 'update_project_identity']);
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
  const cc = await connect(d, { redirect: 'http://localhost:3118/callback', presented: 'http://localhost:54321/callback' });
  assert.ok(cc.access);
  assert.match(cc.consent.text, /a program on this computer/);
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

  // The saved report is still there after a restart (a deploy).
  await d.restart();
  const after = await tool(d, access, 'get_report', { project_id: pid, include_text: true });
  assert.equal(after.data.report.report_id, reportId);
  assert.equal(after.data.text, text);
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
