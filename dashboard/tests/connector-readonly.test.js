'use strict';
// Read-only connector grant (backlog 16, Eric 2026-10-24): the consent page
// offers "Read only"; such a connection lists and accepts only the read tools,
// a write is refused with the reason, and desk_status.assistants shows the
// kind. Fictional workspace; no model, market or network is called.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { readJson } = require('../core/fsx');
const { TOOLS, READ_ONLY_TOOLS } = require('../mcp');

const PASS = 'test-passphrase-not-real';
const HOST = 'desk.test';
const ORIGIN = `https://${HOST}`;
const CHATGPT_APP_CALLBACK = 'https://chatgpt.com/connector/oauth/cb_fictional123';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
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
const form = (o) => new URLSearchParams(o).toString();
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function desk(t, label) {
  const hosted = require('../hosted');
  const { start } = require('../server');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `cr-handoff-${label}-`));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 }));
  const port = await freePort();
  const cfg = hosted.hostedConfig({ CR_DATA_DIR: path.join(base, 'data'), CR_ACCESS_PASSWORD: PASS, PORT: String(port), RENDER_EXTERNAL_HOSTNAME: HOST });
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
    async restart() { srv.shutdown(); opts.hosted.port = await freePort(); srv = await start(ws, opts); },
  };
}

async function connect(d, { redirect, clientName, decision = 'allow' }) {
  const reg = await req(d.port, { method: 'POST', path: '/oauth/register', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: clientName, redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
  assert.equal(reg.status, 201, reg.text);
  const clientId = reg.json.client_id;
  const verifier = b64url(crypto.randomBytes(40));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const q = form({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 's', scope: 'desk offline_access', resource: `${ORIGIN}/mcp` });
  const consent = await req(d.port, { path: `/oauth/authorize?${q}` });
  const requestId = consent.text.match(/name="request" value="([^"]+)"/)[1];
  const approve = await req(d.port, { method: 'POST', path: '/oauth/authorize', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN }, body: form({ request: requestId, password: PASS, decision }) });
  const code = new URL(approve.headers.location).searchParams.get('code');
  const tok = await req(d.port, { method: 'POST', path: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier, client_id: clientId, resource: `${ORIGIN}/mcp` }) });
  assert.equal(tok.status, 200, tok.text);
  return { clientId, access: tok.json.access_token, refresh: tok.json.refresh_token };
}


let nextId = 1;
async function tool(d, access, name, args) {
  const r = await req(d.port, { method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${access}` }, body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }) });
  const res = r.json.result;
  return { status: 200, ...res, data: res.structuredContent || null, text: res.content.map((c) => c.text).join('\n') };
}

async function listTools(d, access) {
  const r = await req(d.port, { method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${access}` }, body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/list' }) });
  return r.json.result.tools.map((x) => x.name);
}

test('read only: the consent page offers it; the connection lists only the read tools, refuses a write with the reason, and desk_status shows the kind', async (t) => {
  const d = await desk(t, 'readonly');
  const page = await req(d.port, { method: 'POST', path: '/oauth/register', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Duet', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
  const consent = await req(d.port, { path: `/oauth/authorize?${form({ response_type: 'code', client_id: page.json.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: b64url(crypto.createHash('sha256').update('x'.repeat(50)).digest()), code_challenge_method: 'S256', scope: 'desk', resource: `${ORIGIN}/mcp` })}` });
  assert.match(consent.text, /name="decision" value="allow_readonly">Read only</);

  const full = await connect(d, { redirect: 'https://claude.ai/api/mcp/auth_callback', clientName: 'Claude' });
  const ro = await connect(d, { redirect: CHATGPT_APP_CALLBACK, clientName: 'Duet', decision: 'allow_readonly' });
  const fullTools = await listTools(d, full.access);
  const roTools = await listTools(d, ro.access);
  assert.equal(fullTools.length, TOOLS.length);
  assert.deepEqual(roTools.sort(), [...READ_ONLY_TOOLS].sort());
  assert.ok(roTools.includes('daily_brief') && roTools.includes('get_ticket') && roTools.includes('desk_status'));
  for (const w of ['add_project', 'save_report', 'save_ticket', 'start_ticket', 'record_transaction', 'save_forensic_report', 'cancel_research']) assert.ok(!roTools.includes(w), `${w} is not offered`);
  for (const n of roTools) assert.equal(TOOLS.find((x) => x.name === n).annotations.readOnlyHint, true, `${n} is annotated read-only`);

  // A write is refused with the reason and writes nothing.
  const before = JSON.stringify(readJson(path.join(d.ws.root, 'config', 'settings.json')));
  const refused = await tool(d, ro.access, 'add_project', { name: 'Nope (FICTIONAL)', symbol: 'NOPE', official_website: 'https://nope.example/', owner_request: 'FICTIONAL' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /Read only/);
  assert.match(refused.text, /READ_ONLY/);
  const found = await tool(d, full.access, 'find_projects', { query: 'Nope' });
  assert.equal((found.data.projects || found.data.matches || []).length, 0);
  assert.equal(JSON.stringify(readJson(path.join(d.ws.root, 'config', 'settings.json'))), before);
  // The same write from the full connection is not refused as read only.
  const allowed = await tool(d, full.access, 'add_project', { name: 'Yes (FICTIONAL)', symbol: 'YES', official_website: 'https://yes.example/', evidence: [{ url: 'https://yes.example/docs' }], owner_request: 'FICTIONAL' });
  assert.ok(!/READ_ONLY/.test(allowed.text));

  // A read tool works, and desk_status says the kind.
  const status = await tool(d, ro.access, 'desk_status', {});
  assert.notEqual(status.isError, true);
  const a = status.data.assistants;
  assert.deepEqual(a.chatgpt.kinds, { full: 0, read_only: 1 });
  assert.match(a.chatgpt.says, /read only/);
  assert.deepEqual(a.claude.kinds, { full: 1, read_only: 0 });
  // The kind survives a token refresh.
  const refreshed = await req(d.port, { method: 'POST', path: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'refresh_token', refresh_token: ro.refresh, client_id: ro.clientId, resource: `${ORIGIN}/mcp` }) });
  assert.equal(refreshed.status, 200);
  assert.ok(!(await listTools(d, refreshed.json.access_token)).includes('add_project'));
});
