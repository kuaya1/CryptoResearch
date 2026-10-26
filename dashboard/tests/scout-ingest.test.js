'use strict';
// Grok Scout (Eric, 2026-10-26; audits/2026-10-26-grok-scout): the ingest the
// front door serves before sign-in (core/scout.js) and the daily sweep
// (scripts/grok-cron.js). This file is protected (backlog-promote.js
// PROTECTED). FICTIONAL temporary desks; xAI and the desk are fakes where the
// sweep is tested; no network beyond this PC's loopback.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const hosted = require('../hosted');
const { start } = require('../server');
const S = require('../core/scout');
const G = require('../scripts/grok-cron');
const exporter = require('../core/exporter');
const { tempWorkspace } = require('./helpers');
const { readJson, jsonText, sha256 } = require('../core/fsx');

const PASS = 'test-passphrase-not-real';
const HOST = 'desk.test';
const KEY = 'test-ingest-key-not-real-0123456789abcdef';
const XAI_KEY = 'xai-test-key-not-real-0123456789';
const DESK = 'https://desk.test';
const REPO = path.join(__dirname, '..', '..');
const T0 = Date.parse('2026-10-27T11:31:00.000Z');

const item = (over = {}) => ({
  lane: 'agents',
  title: 'Example Agent Runner (FICTIONAL)',
  creator: 'Example Labs',
  url_primary: 'https://example.com/agent-runner',
  url_repo: 'https://github.com/Example/Agent-Runner',
  summary: 'A fictional tool for these tests.',
  desk_leverage: 'Could run the builder checks in parallel.',
  readiness: 'beta',
  ...over,
});
const brief = (over = {}) => ({
  schema_version: 'cr.scout-brief.v1',
  generated_at: '2026-10-27T11:30:00.000Z',
  prompt: 'cr-scout-prompt@1',
  model: 'grok-4.3',
  lanes_run: ['agents'],
  lanes_missing: [],
  items: [item()],
  usage: { agents: { input_tokens: 150000, cached_input_tokens: 100000, output_tokens: 8000, web_search_calls: 10 } },
  ...over,
});

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}
function req(port, { method = 'GET', path: p = '/', headers = {}, body = null, chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = { host: HOST, ...headers };
    if (data && !chunked && h['content-length'] === undefined) h['content-length'] = data.length;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    // A refused upload may close the connection before the body is sent.
    r.on('error', (err) => (err.code === 'ECONNRESET' || err.code === 'EPIPE' ? resolve({ status: 'closed', json: null }) : reject(err)));
    if (data) r.write(data);
    r.end();
  });
}
function withEnv(t, vars) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}
async function desk(t, label) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `cr-scout-${label}-`));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 }));
  const port = await freePort();
  const cfg = hosted.hostedConfig({ CR_DATA_DIR: path.join(base, 'data'), CR_ACCESS_PASSWORD: PASS, PORT: String(port), RENDER_EXTERNAL_HOSTNAME: HOST }, { platform: 'win32' });
  const ws = hosted.prepareWorkspace(cfg);
  const file = path.join(ws.root, 'config', 'settings.json');
  const s = readJson(file);
  s.market_data = { ...(s.market_data || {}), enabled: false };
  fs.writeFileSync(file, JSON.stringify(s));
  ws.reloadSettings();
  const srv = await start(ws, { quiet: true, hosted: { port, hosts: cfg.hosts, password: cfg.password, bind: '127.0.0.1', failDelayMs: 0 } });
  t.after(() => srv.shutdown());
  return { ws, port };
}
function temp(t, label) {
  const w = tempWorkspace(label);
  t.after(w.cleanup);
  return w.ws;
}
const bearer = (k = KEY) => ({ authorization: `Bearer ${k}` });
const json = { 'content-type': 'application/json' };
const scoutFiles = (ws) => (fs.existsSync(ws.abs('scout')) ? fs.readdirSync(ws.abs('scout'), { recursive: true }) : []);

test('scout ingest: only the ingest key, never a browser; not set up without a key of 32 characters', async (t) => {
  withEnv(t, { DESK_INGEST_KEY: undefined });
  const d = await desk(t, 'route');
  // Not set up: the key check and every brief, with a key or without, are 404.
  let r = await req(d.port, { path: S.BRIEF_PATH });
  assert.equal(r.status, 404);
  assert.equal(r.json.code, 'NOT_SET_UP');
  r = await req(d.port, { path: S.BRIEF_PATH, headers: bearer() });
  assert.equal(r.status, 404);
  assert.equal(r.json.code, 'NOT_SET_UP');
  r = await req(d.port, { method: 'POST', path: S.BRIEF_PATH, headers: { ...bearer(), ...json }, body: brief() });
  assert.equal(r.status, 404);
  assert.match(r.json.error, /no DESK_INGEST_KEY on the desk/);
  process.env.DESK_INGEST_KEY = 'too-short-key';
  r = await req(d.port, { method: 'POST', path: S.BRIEF_PATH, headers: { authorization: 'Bearer too-short-key', ...json }, body: brief() });
  assert.equal(r.status, 404);
  assert.match(r.json.error, /13 characters; it needs at least 32/);

  process.env.DESK_INGEST_KEY = KEY;
  // The key check: refused without the key or with a wrong one.
  assert.equal((await req(d.port, { path: S.BRIEF_PATH })).status, 401);
  r = await req(d.port, { path: S.BRIEF_PATH, headers: bearer('wrong-key-not-real-0123456789abcdefgh') });
  assert.equal(r.status, 401);
  assert.equal(r.json.code, 'REFUSED');
  r = await req(d.port, { path: S.BRIEF_PATH, headers: bearer() });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, key: 'accepted', briefs_today: 0, max_per_day: 6 });
  assert.equal((await req(d.port, { method: 'HEAD', path: S.BRIEF_PATH, headers: bearer() })).status, 200);
  // The brief: no key, a wrong key, a browser, the wrong method or type.
  assert.equal((await req(d.port, { method: 'POST', path: S.BRIEF_PATH, headers: json, body: brief() })).status, 401);
  assert.equal((await req(d.port, { method: 'POST', path: S.BRIEF_PATH, headers: { ...bearer('another-wrong-key-not-real-0123456789'), ...json }, body: brief() })).status, 401);
  r = await req(d.port, { method: 'POST', path: S.BRIEF_PATH, headers: { ...bearer(), ...json, origin: `https://${HOST}` }, body: brief() });
  assert.equal(r.status, 403, 'not from a browser, even the desk\'s own origin');
  assert.equal((await req(d.port, { path: S.BRIEF_PATH, headers: { ...bearer(), origin: 'https://elsewhere.test' } })).status, 403);
  assert.equal((await req(d.port, { method: 'PUT', path: S.BRIEF_PATH, headers: bearer() })).status, 405);
  r = await req(d.port, { method: 'POST', path: S.BRIEF_PATH, headers: { ...bearer(), 'content-type': 'text/plain' }, body: brief() });
  assert.equal(r.status, 415);
  // Too large, by its declared length or as it streams; not JSON.
  const big = JSON.stringify(brief({ note: 'x'.repeat(70 * 1024) }));
  r = await req(d.port, { method: 'POST', path: S.BRIEF_PATH, headers: { ...bearer(), ...json }, body: big });
  assert.ok(r.status === 413 || r.status === 'closed', `declared too large: ${r.status}`);
  r = await req(d.port, { method: 'POST', path: S.BRIEF_PATH, headers: { ...bearer(), ...json }, body: big, chunked: true });
  assert.ok(r.status === 413 || r.status === 'closed', `streamed too large: ${r.status}`);
  r = await req(d.port, { method: 'POST', path: S.BRIEF_PATH, headers: { ...bearer(), ...json }, body: '{ not json' });
  assert.equal(r.status, 400);
  assert.equal(r.json.saved, false);
  // Any other /api/ingest/ path, the signed-in ping (item 66) included, and
  // the scout's list wait for the sign-in, whatever the ingest key.
  assert.equal((await req(d.port, { path: '/api/ingest/ping', headers: bearer() })).status, 401);
  assert.equal((await req(d.port, { path: '/api/ingest/other', headers: bearer() })).status, 401);
  assert.equal((await req(d.port, { path: '/api/scout', headers: bearer() })).status, 401);
  assert.deepEqual(scoutFiles(d.ws), [], 'nothing was written by any refusal');

  // A good brief is saved, and the same brief again is unchanged.
  r = await req(d.port, { method: 'POST', path: S.BRIEF_PATH, headers: { ...bearer(), 'content-type': 'application/json; charset=utf-8' }, body: brief() });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, 'saved');
  assert.equal(r.json.items_new, 1);
  assert.equal(r.json.verified, true);
  const again = await req(d.port, { method: 'POST', path: S.BRIEF_PATH, headers: { ...bearer(), ...json }, body: brief() });
  assert.equal(again.json.status, 'unchanged');
  assert.equal(again.json.brief_id, r.json.brief_id);
  r = await req(d.port, { path: S.BRIEF_PATH, headers: bearer() });
  assert.equal(r.json.briefs_today, 1);
  // A refused brief says each problem, and saves nothing.
  r = await req(d.port, { method: 'POST', path: S.BRIEF_PATH, headers: { ...bearer(), ...json }, body: brief({ items: [item({ url_primary: 'http://example.com/x', readiness: 'soon' })] }) });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'INVALID');
  assert.deepEqual(r.json.errors, ['items[0].readiness: not one of production, beta, experimental, research', 'items[0].url_primary: must start with https://']);
  assert.equal(S.view(d.ws).briefs, 1);
});

test('scout ingest: ten refused keys in 15 minutes lock the key check and the brief, the right key included', async (t) => {
  let clock = T0;
  const w = temp(t, 'scout-lock');
  const env = { DESK_INGEST_KEY: KEY };
  const route = S.makeScoutRoute(w, { env, now: () => clock });
  const call = (method, p, headers = {}) => new Promise((resolve) => {
    const res = { status: null, body: '', headers: null, writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = b; resolve(this); } };
    const reqLike = { method, headers, on() {}, pause() {} };
    route(reqLike, res, new URL(`https://${HOST}${p}`));
  });
  for (let i = 0; i < 10; i += 1) assert.equal((await call('GET', S.BRIEF_PATH, { authorization: 'Bearer nope-not-the-key-0123456789abcdefgh' })).status, 401);
  let r = await call('GET', S.BRIEF_PATH, { authorization: `Bearer ${KEY}` });
  assert.equal(r.status, 429);
  assert.equal(JSON.parse(r.body).code, 'LOCKED');
  r = await call('POST', S.BRIEF_PATH, { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' });
  assert.equal(r.status, 429);
  assert.equal(r.headers.Connection, 'close');
  clock += 16 * 60000;
  assert.equal((await call('GET', S.BRIEF_PATH, { authorization: `Bearer ${KEY}` })).status, 200, 'the lock ends after 15 minutes');
});

test('scout ingest: a brief is checked field by field; one bad field refuses it and nothing is saved', (t) => {
  const ws = temp(t, 'scout-check');
  const refused = (b) => {
    try {
      S.ingest(ws, b, { now: T0 });
    } catch (err) {
      assert.equal(err.code, 'INVALID');
      assert.match(err.message, /nothing was saved/);
      return err.details.errors;
    }
    assert.fail('the brief was saved');
  };
  const has = (b, re) => {
    const errors = refused(b);
    assert.ok(errors.some((e) => re.test(e)), `${re} in ${JSON.stringify(errors)}`);
  };
  has([brief()], /must be a JSON object/);
  has(brief({ schema_version: 'cr.scout-brief.v0' }), /^schema_version: must be cr\.scout-brief\.v1/);
  has(brief({ extra: 1 }), /^extra: not a field of a scout brief/);
  has(brief({ generated_at: 'yesterday' }), /^generated_at: not a date/);
  has(brief({ prompt: 'cr-scout-prompt@2' }), /^prompt: must be one of cr-scout-prompt@1/);
  has(brief({ model: 'gpt-5' }), /^model: must be a Grok model name/);
  has(brief({ lanes_run: ['agents', 'agents'] }), /lanes_run: agents is listed twice/);
  has(brief({ lanes_run: ['markets'] }), /lanes_run: "markets" is not a lane/);
  has(brief({ lanes_run: [], items: [], usage: {} }), /lanes_run: names no lane/);
  has(brief({ lanes_missing: ['agents'] }), /lanes_missing: agents is also in lanes_run/);
  has(brief({ items: 'none' }), /^items: must be a list/);
  has(brief({ items: Array.from({ length: 41 }, (_, i) => item({ url_primary: `https://example.com/${i}`, url_repo: null })) }), /^items: more than 40/);
  has(brief({ items: Array.from({ length: 11 }, (_, i) => item({ url_primary: `https://example.com/${i}`, url_repo: null })) }), /more than 10 in lane agents/);
  has(brief({ items: [item({ lane: 'onchain' })] }), /items\[0\]\.lane: onchain is not in lanes_run/);
  has(brief({ items: [item({ lane: 'markets' })] }), /items\[0\]\.lane: not one of/);
  has(brief({ items: [item({ readiness: 'ready' })] }), /items\[0\]\.readiness: not one of production, beta, experimental, research/);
  has(brief({ items: [item({ score: 9 })] }), /items\[0\]\.score: not a field of a scout item/);
  has(brief({ items: [item({ title: '' })] }), /items\[0\]\.title: missing/);
  has(brief({ items: [item({ title: 'x'.repeat(121) })] }), /items\[0\]\.title: longer than 120/);
  has(brief({ items: [item({ summary: 'line one\nline two' })] }), /items\[0\]\.summary: must be one plain line/);
  has(brief({ items: [item({ title: 'Agent\u200bRunner' })] }), /items\[0\]\.title: must be one plain line/);
  has(brief({ items: [item({ desk_leverage: 'safe \u202eevil' })] }), /items\[0\]\.desk_leverage: must be one plain line/);
  has(brief({ items: [item({ creator: 7 })] }), /items\[0\]\.creator: must be text/);
  has(brief({ items: [item({ url_primary: 'http://example.com/x' })] }), /items\[0\]\.url_primary: must start with https:\/\//);
  has(brief({ items: [item({ url_primary: 'https://203.0.113.9/x' })] }), /needs a host name, not an IP address/);
  has(brief({ items: [item({ url_repo: 'https://user:pw@github.com/x/y' })] }), /url_repo: carries a user name or password/);
  has(brief({ items: [item({ url_repo: 'https://github.com:8443/x/y' })] }), /url_repo: names a port/);
  has(brief({ items: [item({ url_primary: 'not a url' })] }), /url_primary: a web address has no spaces/);
  has(brief({ items: [item({ url_primary: 'javascript:alert(1)' })] }), /url_primary: must start with https:\/\//);
  has(brief({ usage: { agents: { input_tokens: -1 } } }), /usage\.agents\.input_tokens: must be a whole number from 0/);
  has(brief({ usage: { agents: { dollars: 3 } } }), /usage\.agents\.dollars: not a usage field/);
  has(brief({ usage: { onchain: { input_tokens: 1 } } }), /usage\.onchain: not a lane of this brief/);
  // Several problems are all said at once.
  assert.ok(refused(brief({ model: 'x', items: [item({ readiness: 'x', url_repo: 'http://x.test' })] })).length >= 3);
  assert.deepEqual(scoutFiles(ws), [], 'no refusal saved anything');
});

test('scout ingest: each brief is kept whole; the list has one item per repository, its first sighting kept', (t) => {
  const ws = temp(t, 'scout-save');
  const a = S.ingest(ws, brief({ items: [item(), item({ title: 'Example Notes (FICTIONAL)', url_primary: 'https://www.example.org/notes?id=7', url_repo: null, lane: 'agents' })] }), { now: T0 });
  assert.equal(a.status, 'saved');
  assert.deepEqual([a.items_new, a.items_updated], [2, 0]);
  assert.match(a.brief_id, /^sb-20261027-[0-9a-f]{10}$/);
  const rec = readJson(ws.abs(`scout/briefs/${a.brief_id}.json`));
  assert.equal(rec.schema_version, 'cr.scout-brief-record.v1');
  assert.equal(rec.sha256, sha256(jsonText(rec.brief)), 'the brief is kept whole with its SHA-256');
  // The same repository spelled another way is the same item; a page keeps its query.
  const later = T0 + 86400000;
  const b = S.ingest(ws, brief({
    generated_at: '2026-10-28T11:30:00.000Z',
    lanes_run: ['agents', 'security'],
    items: [
      item({ url_repo: 'https://www.github.com/example/agent-runner.git/', summary: 'Now with a second release.', lane: 'security' }),
      item({ url_repo: 'https://github.com/EXAMPLE/agent-runner/tree/main/docs', title: 'Duplicate in the same brief' }),
      item({ title: 'Example Notes, again', url_primary: 'https://example.org/notes?id=7', url_repo: null }),
      item({ title: 'Other notes', url_primary: 'https://example.org/notes?id=8', url_repo: null }),
    ],
    usage: {},
  }), { now: later });
  assert.deepEqual([b.items_new, b.items_updated], [1, 2]);
  const v = S.view(ws);
  assert.equal(v.items.length, 3);
  const runner = v.items.find((x) => x.key === 'repo:github.com/example/agent-runner');
  assert.ok(runner, JSON.stringify(v.items.map((x) => x.key)));
  assert.equal(runner.times_seen, 2);
  assert.equal(runner.first_seen, new Date(T0).toISOString());
  assert.equal(runner.first_brief, a.brief_id);
  assert.equal(runner.last_seen, new Date(later).toISOString());
  assert.equal(runner.summary, 'Now with a second release.');
  assert.equal(runner.lane, 'security', 'the latest sighting\'s fields');
  assert.ok(v.items.find((x) => x.key === 'page:example.org/notes?id=7' && x.times_seen === 2));
  assert.ok(v.items.find((x) => x.key === 'page:example.org/notes?id=8' && x.times_seen === 1));
  const state = readJson(ws.abs(S.ITEMS_REL));
  assert.equal(state.briefs.length, 2);
  assert.equal(state.briefs[1].duplicates_in_brief, 1);
  assert.equal(state.briefs[1].cost_usd_estimate, null);
  assert.equal(state.briefs[1].cost_basis, 'no usage reported');
  assert.equal(state.briefs[0].cost_usd_estimate, 0.1525);
  // The same brief again: unchanged, with its first receipt; nothing written.
  const before = fs.readdirSync(ws.abs(S.BRIEFS)).length;
  const c = S.ingest(ws, brief({ items: [item(), item({ title: 'Example Notes (FICTIONAL)', url_primary: 'https://www.example.org/notes?id=7', url_repo: null, lane: 'agents' })] }), { now: later + 1000 });
  assert.equal(c.status, 'unchanged');
  assert.equal(c.brief_id, a.brief_id);
  assert.equal(c.received_at, new Date(T0).toISOString());
  assert.equal(fs.readdirSync(ws.abs(S.BRIEFS)).length, before);
  // Nothing is ever deleted: the list keeps the items the latest brief left out.
  S.ingest(ws, brief({ generated_at: '2026-10-29T11:30:00.000Z', items: [], usage: {} }), { now: later + 86400000 });
  assert.equal(S.view(ws).items.length, 3);
});

test('scout ingest: a save that cannot complete leaves the earlier list as it was', (t) => {
  const ws = temp(t, 'scout-atomic');
  S.ingest(ws, brief(), { now: T0 });
  const before = fs.readFileSync(ws.abs(S.ITEMS_REL), 'utf8');
  // A brief file already under the next brief's name: the create-only write
  // refuses, so neither the brief nor the list changes.
  const next = brief({ generated_at: '2026-10-27T12:00:00.000Z', items: [item({ url_repo: 'https://github.com/example/other' })] });
  const { brief: normalized } = S.checkBrief(next);
  const id = `sb-20261027-${sha256(jsonText(normalized)).slice(0, 10)}`;
  fs.writeFileSync(ws.abs(`scout/briefs/${id}.json`), '{}');
  assert.throws(() => S.ingest(ws, next, { now: T0 + 60000 }), (err) => err.code === 'ALREADY_EXISTS');
  assert.equal(fs.readFileSync(ws.abs(S.ITEMS_REL), 'utf8'), before);
});

test('scout ingest: at most six briefs a UTC day', (t) => {
  const ws = temp(t, 'scout-day');
  for (let i = 0; i < 6; i += 1) assert.equal(S.ingest(ws, brief({ generated_at: `2026-10-27T0${i}:00:00.000Z` }), { now: T0 + i }).status, 'saved');
  assert.throws(() => S.ingest(ws, brief({ generated_at: '2026-10-27T09:00:00.000Z' }), { now: T0 + 10 }), (err) => err.code === 'DAILY_LIMIT');
  // The same brief again is still unchanged; the next day takes new ones.
  assert.equal(S.ingest(ws, brief({ generated_at: '2026-10-27T00:00:00.000Z' }), { now: T0 + 20 }).status, 'unchanged');
  assert.equal(S.ingest(ws, brief({ generated_at: '2026-10-28T00:00:00.000Z' }), { now: T0 + 86400000 }).status, 'saved');
});

test('scout cost: an estimate from xAI\'s own counts under cr-scout-prices@1', () => {
  assert.equal(S.PRICES.id, 'cr-scout-prices@1');
  assert.deepEqual(S.PRICES.models['grok-4.3'], { input: 1.25, cached: 0.2, output: 2.5 });
  // The plan's typical lane: 50,000 uncached, 100,000 cached, 8,000 out, 10 searches.
  assert.equal(S.usageCost('grok-4.3', G.ASSUME.typical), 0.1525);
  assert.equal(S.usageCost('grok-4.7', G.ASSUME.typical), 0.248);
  assert.equal(S.usageCost('grok-4.3', G.ASSUME.heavy), 0.2845);
  // A prompt of 200,000 tokens or more doubles every token rate, not the searches.
  assert.equal(S.usageCost('grok-4.3', { input_tokens: 200000, output_tokens: 0, web_search_calls: 1 }), 0.505);
  assert.equal(S.usageCost('grok-4.3', { input_tokens: 1000, cached_input_tokens: 5000 }), 0.0002, 'cached never counts more than the input');
  assert.equal(S.usageCost('grok-9', G.ASSUME.typical), null);
  assert.deepEqual(S.briefCost(brief({ model: 'grok-9' })), { usd: null, basis: 'no price for grok-9 in cr-scout-prices@1' });
  assert.deepEqual(S.briefCost(brief()), { usd: 0.1525, basis: 'cr-scout-prices@1' });
});

test('scout reads: the list and status write nothing; the backup and offsite package carry scout/', (t) => {
  const ws = temp(t, 'scout-read');
  const v0 = S.view(ws, { env: {} });
  assert.equal(v0.ingest, 'not_set_up');
  assert.equal(v0.last_brief, null);
  assert.equal(v0.cost_usd_estimate_total, null);
  assert.match(S.statusLine(ws, { env: {} }), /^not set up \(no DESK_INGEST_KEY on the desk\); no brief yet$/);
  assert.deepEqual(scoutFiles(ws), [], 'reading wrote nothing');
  S.ingest(ws, brief(), { now: T0 });
  S.ingest(ws, brief({ generated_at: '2026-10-27T12:00:00.000Z', items: [item({ title: 'Newer', url_repo: 'https://github.com/example/newer' })] }), { now: T0 + 3600000 });
  const files = scoutFiles(ws).sort();
  const v = S.view(ws, { env: { DESK_INGEST_KEY: KEY } });
  assert.equal(v.ingest, 'ready');
  assert.equal(v.items[0].title, 'Newer', 'newest first');
  assert.equal(v.briefs, 2);
  assert.equal(v.cost_usd_estimate_total, 0.305);
  assert.match(S.statusLine(ws, { env: { DESK_INGEST_KEY: KEY }, now: T0 + 3 * 3600000 }), /^ready; last brief sb-20261027-[0-9a-f]{10} 2 h ago \(1 item\); 2 briefs, about \$0\.30 estimated in total$/);
  assert.deepEqual(scoutFiles(ws).sort(), files, 'reading wrote nothing');
  const snap = exporter.packageSnapshot(ws);
  assert.ok(snap.header.inventory.included.includes('scout'));
  const paths = snap.entries.map((e) => e.path);
  assert.ok(paths.includes('scout/items.json'), 'the package carries the list');
  assert.equal(paths.filter((p) => p.startsWith('scout/briefs/sb-20261027-')).length, 2, 'and every brief');
});

// The sweep, against a fake xAI and a fake desk that saves with the real
// ingest into a temporary workspace.
function fakes(t, { lanes = {}, ping = null, post = [], deskWs = null } = {}) {
  const ws = deskWs || temp(t, 'scout-sweep');
  const calls = { xai: [], ping: 0, post: 0, bodies: [] };
  const answer = (status, body) => ({ status, json: async () => body });
  const f = async (url, opts = {}) => {
    if (url === G.XAI_URL) {
      const body = JSON.parse(opts.body);
      calls.xai.push({ headers: opts.headers, body });
      const lane = /for the lane ([a-z]+)\./.exec(body.input[1].content)[1];
      const spec = lanes[lane] || {};
      if (spec.throws) throw Object.assign(new Error('boom'), { name: spec.throws });
      return answer(spec.status || 200, spec.body || {
        output_text: JSON.stringify({ lane, items: spec.items || [] }),
        usage: { input_tokens: 120000, input_tokens_details: { cached_tokens: 80000 }, output_tokens: 5000, output_tokens_details: { reasoning_tokens: 3000 }, total_tokens: 128000, server_side_tool_usage: { SERVER_SIDE_TOOL_WEB_SEARCH: 7 } },
      });
    }
    assert.equal(opts.headers.authorization, `Bearer ${KEY}`);
    if (url === `${DESK}${S.BRIEF_PATH}` && opts.method === 'GET') {
      calls.ping += 1;
      return ping || answer(200, { ok: true, key: 'accepted', briefs_today: 0, max_per_day: 6 });
    }
    if (url === `${DESK}${S.BRIEF_PATH}`) {
      calls.post += 1;
      const queued = post.shift();
      if (queued) return queued;
      const body = JSON.parse(opts.body);
      calls.bodies.push(body);
      try {
        return answer(200, S.ingest(ws, body, { now: T0 }));
      } catch (err) {
        return answer(400, { code: err.code, errors: err.details && err.details.errors });
      }
    }
    throw new Error(`unexpected address ${url}`);
  };
  return { f, calls, ws };
}
const ENV = { XAI_API_KEY: XAI_KEY, DESK_INGEST_KEY: KEY, DESK_INGEST_URL: DESK };
function lines() {
  const out = [];
  const fn = (l) => out.push(l);
  fn.all = out;
  return fn;
}
function privateFree(out) {
  const text = out.join('\n');
  for (const s of [KEY, XAI_KEY, 'desk.test', 'example.com', 'example.org', 'github.com', 'FICTIONAL', 'Example Labs']) assert.ok(!text.includes(s), `the output names ${s}`);
}

test('scout sweep: --dry-run prints the four requests and the cost range, needs no key and sends nothing', async () => {
  const out = lines();
  let fetched = 0;
  const r = await G.run({ env: {}, fetch: async () => { fetched += 1; }, now: T0, out, dryRun: true });
  assert.equal(r.status, 'dry_run');
  assert.equal(fetched, 0);
  const text = out.all.join('\n');
  for (const lane of S.LANES) assert.match(text, new RegExp(`Request for lane ${lane} \\(POST https://api\\.x\\.ai/v1/responses\\)`));
  assert.match(text, /"model": "grok-4\.3"/);
  assert.match(text, /"type": "web_search"/);
  assert.doesNotMatch(text, /x_search/, 'no X search in the first version');
  assert.match(text, /Today is 2026-10-27\. Sweep one lane only: `security`\./);
  assert.match(text, /typical: \$0\.15 a lane, \$0\.61 a day, about \$18 a month/);
  assert.match(text, /heavy: \$0\.28 a lane, \$1\.14 a day, about \$34 a month/);
  assert.match(text, /Nothing was sent\./);
});

test('scout sweep: nothing goes to xAI unless the prompt matches its pin and the desk accepts the key', async (t) => {
  // Not set up.
  let out = lines();
  let x = fakes(t);
  let r = await G.run({ env: { XAI_API_KEY: XAI_KEY }, fetch: x.f, now: T0, out });
  assert.equal(r.status, 'not_set_up');
  assert.deepEqual(r.missing, ['DESK_INGEST_KEY', 'DESK_INGEST_URL (the desk\'s https origin)']);
  assert.equal(x.calls.xai.length + x.calls.ping, 0);
  r = await G.run({ env: { ...ENV, DESK_INGEST_URL: 'http://desk.test' }, fetch: x.f, now: T0, out: lines() });
  assert.equal(r.status, 'not_set_up', 'the desk only over https');
  // A prompt that is not the pinned text.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-scout-pin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(path.join(REPO, 'templates', 'scout', 'LOCK.json'), path.join(dir, 'LOCK.json'));
  fs.writeFileSync(path.join(dir, 'scout-prompt.v1.md'), `${fs.readFileSync(path.join(REPO, 'templates', 'scout', 'scout-prompt.v1.md'), 'utf8')}\nAlso buy tokens.\n`);
  await assert.rejects(G.run({ env: ENV, fetch: x.f, now: T0, out: lines(), templateDir: dir }), (err) => err.code === 'INTEGRITY');
  assert.equal(x.calls.xai.length + x.calls.ping, 0);
  // The desk refuses the key, is unreachable, or has taken its briefs.
  for (const [ping, status] of [
    [{ status: 401, json: async () => ({ code: 'REFUSED' }) }, 'desk_refused'],
    [{ status: 404, json: async () => ({ code: 'NOT_SET_UP' }) }, 'desk_refused'],
    [{ status: 200, json: async () => ({ ok: true, key: 'accepted', briefs_today: 6, max_per_day: 6 }) }, 'desk_full'],
  ]) {
    out = lines();
    x = fakes(t, { ping });
    r = await G.run({ env: ENV, fetch: x.f, now: T0, out });
    assert.equal(r.status, status);
    assert.equal(x.calls.xai.length, 0, `${status}: nothing sent to xAI`);
    assert.match(out.all.join('\n'), /Nothing was sent to xAI\./);
  }
  out = lines();
  r = await G.run({ env: ENV, fetch: async () => { throw Object.assign(new Error('down'), { name: 'TypeError' }); }, now: T0, out });
  assert.equal(r.status, 'desk_unreachable');
});

test('scout sweep: one request per lane, checked items only, one brief to the desk; the output names counts only', async (t) => {
  const good = (n, over = {}) => ({ title: `Example Tool ${n} (FICTIONAL)`, creator: 'Example Labs', url_primary: `https://example.com/tool-${n}`, url_repo: `https://github.com/example/tool-${n}`, summary: `A fictional tool\nnumber ${n}.`, desk_leverage: 'Could help.', readiness: 'beta', ...over });
  const x = fakes(t, {
    lanes: {
      agents: { items: [good(1), good(2, { url_primary: 'http://example.com/insecure' }), good(3, { stars: 400 })] },
      onchain: { items: [good(4, { url_repo: '' })] },
      desk: { items: [] },
      security: { items: [good(1, { title: 'Tool 1 again (FICTIONAL)' })] },
    },
  });
  const out = lines();
  const r = await G.run({ env: ENV, fetch: x.f, now: T0, out });
  assert.equal(r.ok, true, out.all.join('\n'));
  assert.equal(r.status, 'saved');
  assert.deepEqual(r.lanes_run, ['agents', 'onchain', 'desk', 'security']);
  assert.equal(x.calls.ping, 1);
  assert.equal(x.calls.xai.length, 4, 'one request per lane');
  for (const c of x.calls.xai) {
    assert.equal(c.headers.authorization, `Bearer ${XAI_KEY}`);
    assert.equal(c.body.model, 'grok-4.3');
    assert.deepEqual(c.body.tools, [{ type: 'web_search' }]);
    assert.equal(c.body.store, false);
    assert.equal(c.body.max_output_tokens, 8000);
  }
  assert.equal(x.calls.post, 1);
  const sent = x.calls.bodies[0];
  assert.equal(sent.items.length, 4, 'the http:// item dropped; an unknown field left out, not the item');
  assert.equal(sent.items[0].summary, 'A fictional tool number 1.', 'spaces and line breaks collapsed');
  assert.equal(sent.items.find((i) => i.title.startsWith('Example Tool 4')).url_repo, undefined);
  // Reasoning counted apart is added to the output; searches from xAI's tool usage.
  assert.deepEqual(sent.usage.agents, { input_tokens: 120000, cached_input_tokens: 80000, output_tokens: 8000, reasoning_tokens: 3000, web_search_calls: 7 });
  const v = S.view(x.ws);
  assert.equal(v.items.length, 3, 'tool 1 seen in two lanes is one item');
  assert.ok(v.last_brief.cost_usd_estimate > 0);
  const text = out.all.join('\n');
  assert.match(text, /Lane agents: 2 items kept, 1 dropped; 7 web searches; 120,000 input tokens \(80,000 cached\), 8,000 output\./);
  assert.match(text, /Lane desk: 0 items kept, 0 dropped/);
  assert.match(text, /Desk: saved sb-20261027-[0-9a-f]{10} \(3 new, 0 updated\)\./);
  assert.equal(readJson(x.ws.abs(S.ITEMS_REL)).briefs[0].duplicates_in_brief, 1);
  privateFree(out.all);
});

test('scout sweep: a failed lane is missing and never retried; only posting the brief is tried again', async (t) => {
  const x = fakes(t, {
    lanes: {
      agents: { items: [{ title: 'Example (FICTIONAL)', url_primary: 'https://example.com/a', summary: 'S.', desk_leverage: 'L.', readiness: 'beta' }] },
      onchain: { status: 500, body: { error: 'overloaded', usage: { input_tokens: 2000, output_tokens: 0 } } },
      desk: { body: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'I could not find anything, sorry.' }] }], usage: { input_tokens: 9000, output_tokens: 100 } } },
      security: { throws: 'AbortError' },
    },
    post: [{ status: 503, json: async () => ({ code: 'READ_BUSY' }) }],
  });
  const out = lines();
  const r = await G.run({ env: ENV, fetch: x.f, now: T0, out, postWaits: [0, 0, 0] });
  assert.equal(x.calls.xai.length, 4, 'no lane retried');
  assert.equal(x.calls.post, 2, 'the brief posted again after a server error');
  assert.equal(r.status, 'saved');
  assert.equal(r.ok, true);
  assert.deepEqual(r.lanes_run, ['agents']);
  assert.deepEqual(r.lanes_missing, ['onchain', 'desk', 'security']);
  const sent = x.calls.bodies[0];
  assert.deepEqual(Object.keys(sent.usage).sort(), ['agents', 'desk', 'onchain'], 'what the failed lanes used is on record');
  const text = out.all.join('\n');
  assert.match(text, /Lane onchain: missing \(xAI answered HTTP 500\)\./);
  assert.match(text, /Lane desk: missing \(the answer had no JSON object\)/);
  assert.match(text, /Lane security: missing \(no answer within 180 s\)\./);
  assert.match(text, /::warning::Scout lanes missing: onchain, desk, security\./);
  privateFree(out.all);
  // Every lane failed: the brief still records what was used, and the run fails.
  const y = fakes(t, { lanes: Object.fromEntries(S.LANES.map((l) => [l, { status: 429, body: { error: 'rate' } }])) });
  const r2 = await G.run({ env: ENV, fetch: y.f, now: T0, out: lines(), postWaits: [0] });
  assert.equal(r2.ok, false);
  assert.equal(r2.status, 'saved');
  // A refused brief is not posted again.
  const z = fakes(t, { post: [{ status: 400, json: async () => ({ code: 'INVALID' }) }] });
  const zo = lines();
  const r3 = await G.run({ env: ENV, fetch: z.f, now: T0, out: zo, postWaits: [0, 0, 0] });
  assert.equal(z.calls.post, 1);
  assert.equal(r3.status, 'desk_not_saved');
  assert.match(zo.all.join('\n'), /The desk did not save the brief \(HTTP 400, INVALID\)\. The xAI calls above were made\./);
});

test('scout sweep: reading xAI\'s answer and usage', () => {
  assert.equal(G.answerText({ output_text: 'a' }), 'a');
  assert.equal(G.answerText({ output: [{ type: 'web_search_call' }, { type: 'message', content: [{ type: 'output_text', text: '{"items":[]}' }] }] }), '{"items":[]}');
  assert.deepEqual(G.itemsFrom('```json\n{"lane":"agents","items":[]}\n```', 'agents'), { items: [], dropped: 0 });
  assert.deepEqual(G.itemsFrom('{"lane":"desk","items":[]}', 'agents'), { reason: 'the answer named another lane' });
  assert.deepEqual(G.itemsFrom('{"items": 3}', 'agents'), { reason: 'the answer had no items list' });
  assert.deepEqual(G.itemsFrom('{oops}', 'agents'), { reason: 'the answer was not valid JSON' });
  // At most ten kept a lane.
  const many = Array.from({ length: 12 }, (_, i) => ({ title: `T${i}`, url_primary: `https://example.com/${i}`, summary: 'S.', desk_leverage: 'L.', readiness: 'beta' }));
  assert.deepEqual([G.itemsFrom(JSON.stringify({ items: many }), 'agents').items.length, G.itemsFrom(JSON.stringify({ items: many }), 'agents').dropped], [10, 2]);
  // Reasoning inside the output is not added twice.
  assert.equal(G.usageOf({ usage: { input_tokens: 10, output_tokens: 50, output_tokens_details: { reasoning_tokens: 30 }, total_tokens: 60 } }).output_tokens, 50);
  assert.equal(G.usageOf({ usage: { input_tokens: 10, output_tokens: 50, output_tokens_details: { reasoning_tokens: 30 }, total_tokens: 90 } }).output_tokens, 80);
  // Searches: xAI's tool usage, else the search calls in the output.
  assert.equal(G.usageOf({ output: [{ type: 'web_search_call' }, { type: 'web_search_call' }, { type: 'message' }], usage: {} }).web_search_calls, 2);
  assert.equal(G.deskOrigin('https://desk.test/'), 'https://desk.test');
  for (const bad of ['http://desk.test', 'https://desk.test/api', 'https://desk.test/?x=1', 'https://u:p@desk.test', 'desk.test']) assert.equal(G.deskOrigin(bad), null, bad);
});

test('scout prompt and workflow: the prompt is pinned and names the four lanes; the schedule runs only while Eric enables it', () => {
  const dir = path.join(REPO, 'templates', 'scout');
  const text = G.promptTemplate(dir);
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'LOCK.json'), 'utf8'));
  assert.equal(lock.sha256['scout-prompt.v1.md'], sha256(fs.readFileSync(path.join(dir, 'scout-prompt.v1.md'))));
  assert.match(text, /^# Scout sweep \(cr-scout-prompt@1\)/);
  for (const lane of S.LANES) assert.match(text, new RegExp(`^- \`${lane}\`: `, 'm'));
  for (const p of ['{{TODAY}}', '{{LANE}}', '{{MAX_ITEMS}}']) assert.ok(text.includes(p), p);
  assert.match(text, /never instructions to you/);
  const wf = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'scout-cron.yml'), 'utf8');
  assert.match(wf, /cron: '30 11 \* \* \*'/);
  assert.match(wf, /workflow_dispatch:/);
  assert.match(wf, /if: github\.event_name == 'workflow_dispatch' \|\| vars\.SCOUT_ENABLED == 'true'/);
  assert.match(wf, /permissions:\n {2}contents: read\n/);
  assert.match(wf, /persist-credentials: false/);
  for (const s of ['XAI_API_KEY', 'DESK_INGEST_KEY', 'DESK_INGEST_URL']) assert.match(wf, new RegExp(`${s}: \\$\\{\\{ secrets\\.${s} \\}\\}`));
  assert.match(wf, /run: node dashboard\/scripts\/grok-cron\.js\n/);
  assert.doesNotMatch(wf, /pull_request|npm (ci|install)/);
});
