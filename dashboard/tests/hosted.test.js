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
  assert.deepEqual(ws.settings.research.budget, { per_run_usd: 5, daily_usd: 10, monthly_usd: 40 });
  assert.equal(ws.settings.research.providers.claude.model, 'claude-opus-5-5');
  assert.equal(ws.settings.research.max_continuations, 2);
  assert.equal(ws.settings.research.max_output_tokens, 48000, 'room for a full report plus thinking');
  assert.equal(ws.settings.research.timeout_seconds, 1500);
  // One attempt at these bounds fits the per-run limit.
  const research = require('../core/research');
  const plan = research.callPlan(ws, 'claude', 'x'.repeat(30000));
  assert.ok(plan.ok && plan.total_usd < ws.settings.research.budget.per_run_usd, `reservation ${plan.total_usd}`);
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

test('hosted: the start log names pending identities, withheld grades (which parts and why) and the last price refresh, never report text', (t) => {
  const { dataDir, cleanup } = tempDataDir('health');
  t.after(cleanup);
  const cfg = hosted.hostedConfig({ CR_DATA_DIR: dataDir, CR_ACCESS_PASSWORD: PASS, PORT: '10000', RENDER_EXTERNAL_HOSTNAME: HOST });
  const ws = offline(hosted.prepareWorkspace(cfg));
  const projects = require('../core/projects');
  const inbox = require('../core/inbox');
  projects.addProject(ws, { name: 'Pending Thing (FICTIONAL)', official_website: 'https://pending.example.org/', evidence: [], utterance: 'add this one' });
  const p = projects.addProject(ws, { name: 'Example PayFi (FICTIONAL)', symbol: 'XMPL', official_website: 'https://example.com/xmpl', coingecko_id: 'example-payfi-fictional', assets: [{ chain: 'example-chain', contract_address: 'FICTIONAL-CONTRACT-XMPL' }], evidence: [{ url: 'https://example.com/xmpl', note: 'fictional' }], sector_profile: 'payfi-credit@1' });
  const fixture = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'reports', 'example-payfi-fictional__chatgpt.md'), 'utf8');
  // One weighted component given in a shape the parser does not read as a score.
  const broken = fixture.replace(/("investment_components"\s*:\s*\{[^]*?)"token_value_capture"\s*:\s*\{[^}]*\}/, '$1"token_value_capture": { "value": "7/10" }');
  assert.notEqual(broken, fixture, 'the fixture has a token_value_capture score to break');
  const out = inbox.importContent(ws, 'chatgpt', { content: broken, filename: 'x.md', projectId: p.project_id, channel: 'test' });
  assert.equal(out.result.status, 'ingested');
  const lines = hosted.healthLines(ws);
  const text = lines.join('\n');
  assert.match(text, /Identity: pending-thing-fictional "Pending Thing \(FICTIONAL\)" pending; website https:\/\/pending\.example\.org\/; candidates none; evidence none/);
  assert.match(text, /Grade: example-payfi-fictional\/\S+ \(chatgpt, appendix_json, rubric cr-grading@1\) withheld at 75% of the weight; token_value_capture=unknown \(given \{"value":"7\/10"\}\)/);
  assert.match(text, /Prices: never_run; last success never/);
  assert.ok(!text.includes(fixture.slice(0, 200)), 'no report text in the log');
});

test('hosted: defaults written by the first version move to the current ones on start, unless Eric changed them', (t) => {
  const { dataDir, cleanup } = tempDataDir('upgrade');
  t.after(cleanup);
  const cfg = hosted.hostedConfig({ CR_DATA_DIR: dataDir, CR_ACCESS_PASSWORD: PASS, PORT: '10000', RENDER_EXTERNAL_HOSTNAME: HOST });
  hosted.prepareWorkspace(cfg);
  // What the desk wrote on 2026-10-02 (version 1), with one limit Eric changed.
  const file = path.join(dataDir, 'config', 'settings.json');
  const s = readJson(file);
  delete s.hosted_defaults_version;
  delete s.research.timeout_seconds;
  delete s.research.max_concurrent;
  delete s.research.providers.chatgpt;
  delete s.research.providers.gemini;
  s.research.max_output_tokens = 16000;
  s.research.providers.claude.max_searches = 10;
  s.research.budget = { per_run_usd: 4, daily_usd: 12, monthly_usd: 30 };
  fs.writeFileSync(file, JSON.stringify(s));
  const ws = hosted.prepareWorkspace(cfg);
  const r = ws.settings.research;
  assert.equal(r.max_output_tokens, 48000);
  assert.equal(r.timeout_seconds, 1500);
  assert.equal(r.providers.claude.max_searches, 8);
  assert.deepEqual(r.budget, { per_run_usd: 5, daily_usd: 12, monthly_usd: 40 }, 'the daily limit Eric set stays');
  const after = readJson(file);
  assert.equal(after.hosted_defaults_version, 3);
  assert.deepEqual(after.hosted_defaults_upgrades[0].changed.map((c) => c.setting).sort(), ['research.budget.monthly_usd', 'research.budget.per_run_usd', 'research.max_output_tokens', 'research.providers.claude.max_searches', 'research.timeout_seconds']);
  // v3 proposes ChatGPT and Gemini API settings; they are used only with a key.
  assert.deepEqual(after.hosted_defaults_upgrades[1].changed.map((c) => c.setting).sort(), ['research.max_concurrent', 'research.providers.chatgpt', 'research.providers.gemini']);
  assert.equal(r.providers.chatgpt.model, 'gpt-6.1-sol');
  assert.equal(r.providers.gemini.search_billing, 'per_request', 'Gemini search bounded by one fee per request');
  // The start log says what research would be sent with; never a key.
  const keys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real-a';
  const line = hosted.researchSummary(ws);
  const research = require('../core/research');
  const noKeys = research.providerStatus(ws);
  process.env.OPENAI_API_KEY = 'test-key-not-real-o';
  const withOpenai = research.providerStatus(ws);
  for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  assert.match(line, /48000 output tokens per request, up to 3 requests, 8 searches per request, 1500 s per call/);
  assert.match(line, /limits \$5 per run, \$12 per day, \$40 per month; Claude key present; route api; ChatGPT gpt-6\.1-sol \(key missing; route manual\), Gemini gemini-2\.5-pro \(key missing; route manual\); 2 at a time\./);
  assert.match(line, /Defaults v2, v3 applied .*research\.max_output_tokens 16000 -> 48000.*research\.providers\.chatgpt unset -> gpt-6\.1-sol/);
  assert.doesNotMatch(line, /test-key-not-real/);
  assert.equal(noKeys.chatgpt.mode, 'manual', 'no key: nothing paid');
  assert.equal(withOpenai.chatgpt.mode, 'api', 'the key is the only missing piece');
  // A ChatGPT attempt fits well inside the per-run limit.
  const plan = research.callPlan(ws, 'chatgpt', 'x'.repeat(30000));
  assert.ok(plan.ok && plan.total_usd < 1, `reservation ${plan.total_usd}`);
  const gplan = research.callPlan(ws, 'gemini', 'x'.repeat(30000));
  assert.ok(gplan.ok && gplan.total_usd < 1, `reservation ${gplan.total_usd}`);
  // Applied once: a later change of Eric's is never overwritten.
  after.research.max_output_tokens = 20000;
  fs.writeFileSync(file, JSON.stringify(after));
  assert.equal(hosted.prepareWorkspace(cfg).settings.research.max_output_tokens, 20000);
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

test('hosted: a real browser\'s sign-in form is accepted (Origin "null" from a no-referrer page, or the real origin); other sites are refused', async (t) => {
  const { dataDir, cleanup } = tempDataDir('browser');
  t.after(cleanup);
  const port = await freePort();
  const cfg = hosted.hostedConfig({ CR_DATA_DIR: dataDir, CR_ACCESS_PASSWORD: PASS, PORT: String(port), RENDER_EXTERNAL_HOSTNAME: HOST });
  const ws = offline(hosted.prepareWorkspace(cfg));
  const srv = await start(ws, { quiet: true, hosted: { port, hosts: cfg.hosts, password: cfg.password, bind: '127.0.0.1', failDelayMs: 0 } });
  t.after(() => srv.shutdown());
  // The sign-in page now keeps the real origin on its form post.
  assert.equal((await req(port, { path: '/login' })).headers['referrer-policy'], 'same-origin');
  const post = (headers) => req(port, { method: 'POST', path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: `password=${encodeURIComponent(PASS)}` });
  // What Chrome sent from the earlier no-referrer page (seen 2026-10-03).
  const fromCached = await post({ origin: 'null', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' });
  assert.equal(fromCached.status, 303);
  assert.equal(fromCached.headers.location, '/');
  assert.match(fromCached.headers['set-cookie'][0], /^cr_session=/);
  const fromPage = await post({ origin: `https://${HOST}`, 'sec-fetch-site': 'same-origin' });
  assert.equal(fromPage.status, 303);
  assert.equal((await post({ origin: 'null', 'sec-fetch-site': 'cross-site' })).status, 403, 'an opaque origin that says it is cross-site');
  assert.equal((await post({ origin: `https://${HOST}`, 'sec-fetch-site': 'same-site' })).status, 403, 'a sibling site');
  assert.equal((await post({ origin: 'https://evil.test' })).status, 403);
  // Sign-out from the same kind of form.
  const cookie = fromPage.headers['set-cookie'][0].split(';')[0];
  const out = await req(port, { method: 'POST', path: '/logout', headers: { cookie, origin: 'null', 'sec-fetch-site': 'same-origin' } });
  assert.equal(out.status, 303);
  assert.equal((await req(port, { path: '/api/session', headers: { cookie } })).status, 401);
  assert.equal((await req(port, { method: 'POST', path: '/logout', headers: { cookie, 'sec-fetch-site': 'cross-site' } })).status, 403);
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
