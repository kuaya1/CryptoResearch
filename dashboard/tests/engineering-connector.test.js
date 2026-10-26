'use strict';
// The engineering connector on the real hosted server (Connected Engineering
// v1, 2026-10-25; audits/2026-10-25-connected-engineering): its own OAuth
// resource with one role per connection, tools by role, the desk and
// engineering audiences kept apart both ways, Eric's controls behind sign-in
// and his passphrase, and the public admission and attestation reads. A
// FICTIONAL temporary desk; no model, market or network is called.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { readJson } = require('../core/fsx');
const { TOOLS: DESK_TOOLS } = require('../mcp');
const { TOOLS: ENG_TOOLS } = require('../engineering/tools');

const PASS = 'test-passphrase-not-real';
const HOST = 'desk.test';
const ORIGIN = `https://${HOST}`;
const ENG = `${ORIGIN}/mcp/engineering`;
const CLAUDE_CB = 'https://claude.ai/api/mcp/auth_callback';
const CHATGPT_CB = 'https://chatgpt.com/connector/oauth/cb_fictional123';

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
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `cr-eng-${label}-`));
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
  const srv = await start(ws, opts);
  t.after(() => srv && srv.shutdown());
  return { ws, port };
}

// One connection: register, the consent page (role for engineering), the code
// and the tokens.
async function connect(d, { redirect, clientName, resource = ENG, role = null, scope = null }) {
  const reg = await req(d.port, { method: 'POST', path: '/oauth/register', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: clientName, redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
  assert.equal(reg.status, 201, reg.text);
  const clientId = reg.json.client_id;
  const verifier = b64url(crypto.randomBytes(40));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const q = form({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 's', scope: scope || (resource === ENG ? 'engineering offline_access' : 'desk offline_access'), resource });
  const consent = await req(d.port, { path: `/oauth/authorize?${q}` });
  assert.equal(consent.status, 200, consent.text.slice(0, 300));
  const requestId = consent.text.match(/name="request" value="([^"]+)"/)[1];
  const approve = await req(d.port, { method: 'POST', path: '/oauth/authorize', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN }, body: form({ request: requestId, password: PASS, decision: 'allow', ...(role ? { role } : {}) }) });
  assert.equal(approve.status, 303, approve.text.slice(0, 300));
  const code = new URL(approve.headers.location).searchParams.get('code');
  const tok = await req(d.port, { method: 'POST', path: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier, client_id: clientId, resource }) });
  assert.equal(tok.status, 200, tok.text);
  return { clientId, access: tok.json.access_token, refresh: tok.json.refresh_token, consent: consent.text };
}

let nextId = 1;
const rpc = (d, at, access, method, params) => req(d.port, { method: 'POST', path: at, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${access}` }, body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) }) });
async function names(d, at, access) {
  const r = await rpc(d, at, access, 'tools/list');
  assert.equal(r.status, 200, r.text);
  return r.json.result.tools.map((x) => x.name).sort();
}
async function call(d, access, name, args = {}) {
  const r = await rpc(d, '/mcp/engineering', access, 'tools/call', { name, arguments: args });
  assert.equal(r.status, 200, r.text);
  const res = r.json.result;
  return { ...res, data: res.structuredContent || null, text: res.content.map((c) => c.text).join('\n') };
}
const forRole = (role) => ENG_TOOLS.filter((x) => x.roles.includes(role)).map((x) => x.name).sort();

async function signIn(d) {
  const ok = await req(d.port, { method: 'POST', path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN }, body: `password=${encodeURIComponent(PASS)}` });
  assert.equal(ok.status, 303);
  const cookie = ok.headers['set-cookie'][0].split(';')[0];
  const s = (await req(d.port, { path: '/api/session', headers: { cookie } })).json;
  const h = { cookie, 'x-cr-token': s.token, origin: ORIGIN };
  return {
    get: (p) => req(d.port, { path: p, headers: h }),
    post: (p, body) => req(d.port, { method: 'POST', path: p, headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }),
  };
}
const docsTask = (over = {}) => ({
  title: 'Engineering lane note (FICTIONAL)',
  intent: 'implement',
  outcome: 'A short note under docs/engineering says how a task moves through the lane.',
  scope: { paths: ['docs/engineering/trial.md'] },
  acceptance: ['docs/engineering/trial.md exists and names each state'],
  ...over,
});

test('engineering is its own resource: one role per connection, tools by role, and the desk and engineering never reach each other', async (t) => {
  const d = await desk(t, 'audience');
  // Discovery for the engineering resource.
  const meta = await req(d.port, { path: '/.well-known/oauth-protected-resource/mcp/engineering' });
  assert.equal(meta.status, 200);
  assert.equal(meta.json.resource, ENG);
  assert.deepEqual(meta.json.scopes_supported.filter((s) => s !== 'offline_access'), ['engineering']);
  const challenge = await rpc(d, '/mcp/engineering', 'no-token', 'tools/list');
  assert.equal(challenge.status, 401);
  assert.match(challenge.headers['www-authenticate'], /oauth-protected-resource\/mcp\/engineering/);

  // The consent page asks for one role and refuses without one.
  const reg = await req(d.port, { method: 'POST', path: '/oauth/register', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [CHATGPT_CB], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
  const q = form({ response_type: 'code', client_id: reg.json.client_id, redirect_uri: CHATGPT_CB, code_challenge: b64url(crypto.createHash('sha256').update('y'.repeat(50)).digest()), code_challenge_method: 'S256', scope: 'engineering', resource: ENG });
  const page = await req(d.port, { path: `/oauth/authorize?${q}` });
  for (const r of ['submitter', 'reviewer', 'worker', 'reader']) assert.match(page.text, new RegExp(`name="role" value="${r}"`));
  assert.match(page.text, /never research, tickets, the portfolio, wallets or any money/);
  assert.doesNotMatch(page.text, /allow_readonly/);
  const noRole = await req(d.port, { method: 'POST', path: '/oauth/authorize', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN }, body: form({ request: page.text.match(/name="request" value="([^"]+)"/)[1], password: PASS, decision: 'allow' }) });
  assert.equal(noRole.status, 200);
  assert.match(noRole.text, /Choose this connection(&#39;|')s role/);
  const unknown = await req(d.port, { path: `/oauth/authorize?${form({ response_type: 'code', client_id: reg.json.client_id, redirect_uri: CHATGPT_CB, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', resource: `${ORIGIN}/mcp/other` })}` });
  assert.notEqual(unknown.status, 200, 'an unknown resource is refused');

  const chat = await connect(d, { redirect: CHATGPT_CB, clientName: 'ChatGPT', role: 'submitter' });
  const worker = await connect(d, { redirect: CLAUDE_CB, clientName: 'Claude', role: 'worker' });
  const reader = await connect(d, { redirect: CLAUDE_CB, clientName: 'Claude', role: 'reader' });
  const deskConn = await connect(d, { redirect: CLAUDE_CB, clientName: 'Claude', resource: `${ORIGIN}/mcp` });

  // Each connection lists its role's tools only.
  assert.deepEqual(await names(d, '/mcp/engineering', chat.access), forRole('submitter'));
  assert.deepEqual(await names(d, '/mcp/engineering', worker.access), forRole('worker'));
  assert.deepEqual(await names(d, '/mcp/engineering', reader.access), forRole('reader'));
  assert.ok(forRole('submitter').includes('engineering_save_review') && !forRole('worker').includes('engineering_save_review'), 'a worker never reviews');
  for (const role of ['submitter', 'worker', 'reader', 'reviewer']) for (const n of forRole(role)) assert.ok(n.startsWith('engineering_'));
  const deskNames = await names(d, '/mcp', deskConn.access);
  assert.equal(deskNames.length, DESK_TOOLS.length);
  assert.ok(!deskNames.some((n) => n.startsWith('engineering_')), 'no desk tool reaches the inbox');
  for (const n of ['add_project', 'save_report', 'record_transaction', 'start_ticket']) assert.ok(!forRole('submitter').includes(n));
  // Nothing in the engineering tools decides for Eric.
  for (const n of ENG_TOOLS.map((x) => x.name)) assert.doesNotMatch(n, /authorize|activate|revoke|resume|cancel|reopen|merge|deploy/);

  // Audiences never cross: a desk token is refused by engineering and the reverse.
  assert.equal((await rpc(d, '/mcp/engineering', deskConn.access, 'tools/list')).status, 401);
  assert.equal((await rpc(d, '/mcp', chat.access, 'tools/list')).status, 401);
  assert.equal((await rpc(d, '/mcp', worker.access, 'tools/list')).status, 401);

  // The server checks the role on every call, whatever the client lists.
  const refused = await call(d, chat.access, 'engineering_claim_task', { task_id: 'eng-20261025-abcdef' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /ROLE_REFUSED/);
  const forged = await call(d, chat.access, 'engineering_prepare_task', { ...docsTask(), approved: true });
  assert.equal(forged.isError, true);
  assert.match(forged.text, /FORGED_AUTHORITY/);

  // The role survives a refresh; a refresh for the other resource is refused.
  const other = await req(d.port, { method: 'POST', path: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'refresh_token', refresh_token: worker.refresh, client_id: worker.clientId, resource: `${ORIGIN}/mcp` }) });
  assert.equal(other.status, 400);
  assert.equal(other.json.error, 'invalid_target');
  const fresh = await req(d.port, { method: 'POST', path: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'refresh_token', refresh_token: worker.refresh, client_id: worker.clientId, resource: ENG }) });
  assert.equal(fresh.status, 200, fresh.text);
  assert.deepEqual(await names(d, '/mcp/engineering', fresh.json.access_token), forRole('worker'));
  assert.equal((await rpc(d, '/mcp', fresh.json.access_token, 'tools/list')).status, 401);

  // The desk's own view of its assistants leaves engineering connections out.
  const st = await rpc(d, '/mcp', deskConn.access, 'tools/call', { name: 'desk_status', arguments: {} });
  const assistants = st.json.result.structuredContent.assistants;
  assert.deepEqual(assistants.chatgpt.kinds, { full: 0, read_only: 0 }, 'the ChatGPT engineering connection is not a desk connection');
  assert.deepEqual(assistants.claude.kinds, { full: 1, read_only: 0 });
  // The records stay on the desk disk.
  assert.ok(!fs.existsSync(path.join(d.ws.root, 'engineering', 'tasks')), 'listing tools wrote nothing');
});

test('Eric decides on the desk behind sign-in and his passphrase; the connector only proposes; the public reads hold nothing private', async (t) => {
  const d = await desk(t, 'owner');
  const chat = await connect(d, { redirect: CHATGPT_CB, clientName: 'ChatGPT', role: 'submitter' });
  const worker = await connect(d, { redirect: CLAUDE_CB, clientName: 'Claude', role: 'worker' });

  assert.equal((await req(d.port, { path: '/api/engineering' })).status, 401, 'signed out');
  const eric = await signIn(d);
  const view = await eric.get('/api/engineering');
  assert.equal(view.status, 200, view.text);
  assert.equal(view.json.mcp_url, ENG);
  assert.equal(view.json.paused, false);
  assert.deepEqual(view.json.templates.map((x) => x.template).sort(), ['eng-app@3', 'eng-docs@1'], 'eng-app@1 and eng-app@2 are retired: never offered');
  assert.deepEqual(view.json.connections.map((c) => c.role).sort(), ['submitter', 'worker']);
  assert.ok(view.json.connections.every((c) => c.audience === 'engineering'));

  // No delegation yet: a submitted task waits for Eric.
  const p = await call(d, chat.access, 'engineering_prepare_task', { ...docsTask(), original_instruction: 'Eric: write the trial note; mention eric@example.com only to me (FICTIONAL).' });
  assert.notEqual(p.isError, true, p.text);
  const s = await call(d, chat.access, 'engineering_submit_task', { task_id: p.data.task_id, version: p.data.version, content_sha256: p.data.content_sha256 });
  assert.equal(s.data.status, 'awaiting_authorization');
  const claimEarly = await call(d, worker.access, 'engineering_claim_task', { task_id: p.data.task_id });
  assert.equal(claimEarly.isError, true);
  assert.match(claimEarly.text, /NOT_CLAIMABLE/);

  // Authorizing takes the passphrase, and binds the exact version and hash.
  const auth = (body) => eric.post(`/api/engineering/tasks/${p.data.task_id}/authorize`, body);
  assert.equal((await auth({ version: 1, content_sha256: p.data.content_sha256 })).status, 403);
  assert.equal((await auth({ version: 1, content_sha256: p.data.content_sha256, password: 'wrong-fictional' })).status, 403);
  assert.equal((await auth({ version: 1, content_sha256: 'f'.repeat(64), password: PASS })).status, 409);
  const ok = await auth({ version: 1, content_sha256: p.data.content_sha256, password: PASS });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.status, 'saved');
  assert.equal(ok.json.task.status, 'admitted');

  // Eric's own review decides any requirement, so it takes the passphrase
  // too (review N3): code in his signed-in page cannot save one.
  const review = (body) => eric.post(`/api/engineering/tasks/${p.data.task_id}/review`, { head_sha: 'a'.repeat(40), merge_base_sha: 'a'.repeat(40), result: 'pass', read: { diff: true, tests: true }, ...body });
  assert.equal((await review({})).status, 403);
  assert.equal((await review({ password: 'wrong-fictional' })).status, 403);
  const reviewed = await review({ password: PASS });
  assert.equal(reviewed.status, 400, reviewed.text);
  assert.match(reviewed.json.error, /has no candidate to review yet/, 'past the passphrase, the inbox answers');

  // Activating a delegation takes the passphrase too.
  assert.equal((await eric.post('/api/engineering/policies', { template: 'eng-docs@1' })).status, 403);
  const retired = await eric.post('/api/engineering/policies', { template: 'eng-app@1', goal_id: 'desk-polish', goal: 'Polish the desk (FICTIONAL)', password: PASS });
  assert.equal(retired.status, 400, 'eng-app@1 is retired: never activated again');
  assert.match(retired.json.error, /eng-app@1 is retired on 2026-10-25 for eng-app@2/);
  const act = await eric.post('/api/engineering/policies', { template: 'eng-docs@1', days: 7, password: PASS });
  assert.equal(act.status, 200, act.text);
  const policyId = act.json.policy.policy_id;
  const p2 = await call(d, chat.access, 'engineering_prepare_task', docsTask({ title: 'Second note (FICTIONAL)' }));
  const s2 = await call(d, chat.access, 'engineering_submit_task', { task_id: p2.data.task_id, version: 1, content_sha256: p2.data.content_sha256 });
  assert.equal(s2.data.status, 'admitted', s2.text);

  // The worker binds a number; the public admission read shows the binding only.
  const c = await call(d, worker.access, 'engineering_claim_task', { task_id: p.data.task_id });
  assert.notEqual(c.isError, true, c.text);
  const n = await call(d, worker.access, 'engineering_record_event', { task_id: p.data.task_id, claim_token: c.data.claim_token, type: 'admission_number', number: 63, observed_max: 62, observed_main_sha: 'a'.repeat(40) });
  assert.equal(n.data.number, 63, n.text);
  const pub = await req(d.port, { path: `/engineering/admissions/${p.data.task_id}` });
  assert.equal(pub.status, 200);
  assert.equal(pub.json.number, 63);
  assert.equal(pub.json.admissible, true);
  assert.equal(pub.json.entry_sha256, n.data.entry_sha256);
  assert.ok(!pub.text.includes('eric@example.com') && !pub.text.includes('Eric: write'), 'no private content in a public read');
  assert.equal(pub.headers['cache-control'], 'no-store');
  assert.equal((await req(d.port, { path: '/engineering/admissions/eng-20261025-000000' })).status, 404);
  assert.equal((await req(d.port, { path: `/engineering/attestations/${'b'.repeat(40)}` })).status, 404);
  assert.equal((await req(d.port, { method: 'POST', path: `/engineering/admissions/${p.data.task_id}` })).status, 405);
  // The private instruction is on the desk disk, outside Git's reach.
  assert.ok(fs.existsSync(path.join(d.ws.root, 'engineering', 'tasks', p.data.task_id, 'private', 'instruction-1.json')));

  // Pausing everything stops the connector and the public admission.
  const pause = await eric.post('/api/engineering/pause', { paused: true, reason: 'paused by Eric (FICTIONAL)' });
  assert.equal(pause.status, 200, pause.text);
  const hb = await call(d, worker.access, 'engineering_record_event', { task_id: p.data.task_id, claim_token: c.data.claim_token, type: 'heartbeat' });
  assert.equal(hb.isError, true);
  assert.match(hb.text, /PAUSED/);
  assert.equal((await req(d.port, { path: `/engineering/admissions/${p.data.task_id}` })).json.admissible, false);
  assert.equal((await eric.post('/api/engineering/pause', { paused: false })).status, 200);

  // Revoking the delegation; cancelling frees the number. Nothing is deleted.
  assert.equal((await eric.post(`/api/engineering/policies/${policyId}/revoke`, { reason: 'trial over (FICTIONAL)' })).status, 200);
  assert.equal((await eric.post(`/api/engineering/tasks/${p2.data.task_id}/pause`, {})).json.task_status, 'paused');
  const cancel = await eric.post(`/api/engineering/tasks/${p.data.task_id}/cancel`, { reason: 'not needed (FICTIONAL)' });
  assert.equal(cancel.status, 200, cancel.text);
  assert.equal(cancel.json.task.status, 'cancelled');
  assert.equal((await eric.post('/api/engineering/tasks/not-a-task/cancel', {})).status, 400);
  const after = await eric.get('/api/engineering');
  assert.equal(after.json.tasks.length, 2);
  assert.equal(after.json.policies.find((x) => x.policy_id === policyId).active, false);
});

// Eric's decision on review finding 2 (2026-10-25): the routes live in the
// protected dashboard/engineering/routes.js and dashboard/server.js only
// mounts them, so a line there naming engineering is one of these.
test('dashboard/server.js only mounts the engineering routes', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  for (const route of ['/api/engineering', '/mcp/engineering', '/engineering/admissions', '/engineering/attestations']) assert.ok(!server.includes(route), `server.js declares no ${route} route`);
  for (const mod of ['inbox', 'tools', 'policy']) assert.ok(!server.includes(`require('./engineering/${mod}')`), `server.js reaches engineering/${mod} only through routes.js`);
  // Since review N1 (2026-10-26) the connector and the public reads are
  // answered by the protected dashboard/frontdoor.js, which builds the
  // engineering routes; server.js receives them from it and mounts Eric's.
  for (const handled of ['engineering.connector(', 'engineering.publicRead(', "require('./engineering/routes')", 'makeEngineeringRoutes(']) assert.ok(!server.includes(handled), `server.js does not call ${handled}`);
  const known = [
    '// sign-in and builds the sign-in, connector and engineering handlers this',
    'const { origin, allowedOrigins, oauth, auth, engineering, serveStatic } = door;',
    'const api = makeApi({',
    'function makeApi({',
    '// Preferences > Developer > Engineering (dashboard/engineering/routes.js).',
    'engineering.mount(route);',
  ];
  const lines = server.split('\n').map((l) => l.trim()).filter((l) => /engineering/i.test(l));
  for (const l of lines) assert.ok(known.some((k) => l.startsWith(k)), `an unexpected engineering line in server.js: ${l.slice(0, 120)}`);
  const R = require('../engineering/routes');
  assert.ok(R.PUBLIC_READ_RE.test('/engineering/admissions/eng-20261025-0a0a0a'));
  assert.ok(!R.PUBLIC_READ_RE.test('/engineering/tasks'));
  // Without a connector (this PC) the module answers nothing it does not own.
  const r = R.makeEngineeringRoutes(null, { HttpError: Error });
  assert.equal(r.publicRead({ method: 'GET' }, null, new URL('http://x/api/engineering')), false);
});
