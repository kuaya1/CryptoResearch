'use strict';
// Scout leads, stage A: the delivery and its status (intake plan rev. 2 §3,
// PR 2; audits/2026-10-29-intake-dialectic/PLAN.md). Grok's leads arrive at
// the front door with the desk's ingest key, are kept create-only per
// delivery and once per asset, and are acknowledged only once on disk. A lead
// is identified by its chain and contract only. FICTIONAL temporary desks;
// nothing here asks a provider or a model for anything.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const hosted = require('../hosted');
const { start } = require('../server');
const S = require('../core/scout');
const L = require('../core/leads');
const exporter = require('../core/exporter');
const { stableStringify } = require('../core/requests');
const { tempWorkspace } = require('./helpers');
const { readJson, sha256 } = require('../core/fsx');

const PASS = 'test-passphrase-not-real';
const HOST = 'desk.test';
const KEY = 'test-ingest-key-not-real-0123456789abcdef';
const T0 = Date.parse('2026-10-29T11:35:00.000Z');
// Two fictional base58 addresses that differ only in one letter's case.
const SOL_A = `FakeMintAddrForTestsAbc${'1'.repeat(20)}`;
const SOL_B = `FakeMintAddrForTestsabc${'1'.repeat(20)}`;
const EVM = (n) => `0x${String(n).padStart(4, '0')}${'ab'.repeat(18)}`;

const lead = (over = {}) => ({ chain: 'base', contract: EVM(1), coingecko_id: null, signal: 'A fictional lead for these tests.', urls: ['https://example.com/lead'], ...over });
const delivery = (over = {}) => ({
  schema: 'cr.scout-leads.v1',
  prompt_version: 'cr-scout-leads-prompt@1',
  delivery_id: 'gh-1000-1',
  generated_at: '2026-10-29T11:30:00.000Z',
  model: 'grok-4.3',
  leads: [lead()],
  ...over,
});

function temp(t, label) {
  const w = tempWorkspace(label);
  t.after(w.cleanup);
  return w.ws;
}
const leadFiles = (ws) => (fs.existsSync(ws.abs('scout/leads')) ? fs.readdirSync(ws.abs('scout/leads'), { recursive: true }).map((p) => String(p).split(path.sep).join('/')).sort() : []);
const assetFiles = (ws) => (fs.existsSync(ws.abs(L.ASSETS)) ? fs.readdirSync(ws.abs(L.ASSETS)).sort() : []);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}
function req(port, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = { host: HOST, ...headers };
    if (data) h['content-length'] = data.length;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    r.on('error', (err) => (err.code === 'ECONNRESET' || err.code === 'EPIPE' ? resolve({ status: 'closed', json: null }) : reject(err)));
    if (data) r.write(data);
    r.end();
  });
}
async function desk(t, label) {
  const prev = process.env.DESK_INGEST_KEY;
  process.env.DESK_INGEST_KEY = KEY;
  t.after(() => { if (prev === undefined) delete process.env.DESK_INGEST_KEY; else process.env.DESK_INGEST_KEY = prev; });
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `cr-leads-${label}-`));
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
const auth = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
// Counts every outbound request the code under test makes.
function noProviders(t) {
  const real = global.fetch;
  const calls = [];
  global.fetch = async (...a) => { calls.push(String(a[0])); throw new Error('no provider in these tests'); };
  t.after(() => { global.fetch = real; });
  return calls;
}

test('leads: delivered, acknowledged once on disk; a lost answer and the same delivery again give the same receipt and one asset', async (t) => {
  const calls = noProviders(t);
  const d = await desk(t, 'route');
  // The route checks generated_at against the real clock: one stamp, so the same delivery again is the same body.
  const at = new Date().toISOString();
  let r = await req(d.port, { path: L.LEADS_PATH, headers: { authorization: `Bearer ${KEY}` } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, key: 'accepted', leads_today: 0, max_per_day: 6 });
  assert.equal((await req(d.port, { path: L.LEADS_PATH })).status, 401, 'the key is needed');
  assert.equal((await req(d.port, { method: 'POST', path: L.LEADS_PATH, headers: { ...auth, origin: `https://${HOST}` }, body: delivery({ generated_at: at }) })).status, 403, 'never from a browser');
  assert.equal((await req(d.port, { method: 'POST', path: L.LEADS_PATH, headers: { ...auth, 'content-type': 'text/plain' }, body: delivery({ generated_at: at }) })).status, 415);
  assert.deepEqual(leadFiles(d.ws), [], 'no refusal wrote anything');

  r = await req(d.port, { method: 'POST', path: L.LEADS_PATH, headers: auth, body: delivery({ generated_at: at }) });
  assert.equal(r.status, 202, r.text);
  assert.equal(r.json.status, 'accepted');
  assert.equal(r.json.delivery_id, 'gh-1000-1');
  assert.match(r.json.receipt_id, /^ld_[0-9a-f]{14}$/);
  assert.match(r.json.payload_sha256, /^[0-9a-f]{64}$/);
  assert.equal(r.json.rows.length, 1);
  assert.equal(r.json.rows[0].outcome, 'new');
  const first = r.json;
  // The sender never saw the answer and sends the same delivery again.
  r = await req(d.port, { method: 'POST', path: L.LEADS_PATH, headers: auth, body: delivery({ generated_at: at }) });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'unchanged');
  assert.equal(r.json.receipt_id, first.receipt_id);
  assert.deepEqual(r.json.rows, first.rows);
  assert.equal(assetFiles(d.ws).length, 1, 'one asset record');
  const asset = readJson(d.ws.abs(`${L.ASSETS}/${first.rows[0].lead_key}.json`));
  assert.equal(asset.sightings.length, 1, 'a replay is not a second sighting');
  assert.equal(asset.state, 'NEW');
  // Its status, with the key; reading writes nothing.
  const before = leadFiles(d.ws);
  r = await req(d.port, { path: `${L.LEADS_PATH}/gh-1000-1`, headers: { authorization: `Bearer ${KEY}` } });
  assert.equal(r.status, 200);
  assert.equal(r.json.receipt_id, first.receipt_id);
  assert.equal(r.json.source, 'grok-scout');
  assert.deepEqual(r.json.model, { declared: 'grok-4.3', basis: 'declared by the sender' });
  assert.equal((await req(d.port, { path: `${L.LEADS_PATH}/gh-9999-1`, headers: { authorization: `Bearer ${KEY}` } })).status, 404);
  assert.equal((await req(d.port, { path: `${L.LEADS_PATH}/gh-1000-1` })).status, 401);
  assert.deepEqual(leadFiles(d.ws), before, 'a status read writes nothing');
  // The same delivery ID with a different body is a conflict; the first is kept.
  r = await req(d.port, { method: 'POST', path: L.LEADS_PATH, headers: auth, body: delivery({ generated_at: at, leads: [lead({ signal: 'Altered.' })] }) });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'CONFLICT');
  assert.equal(readJson(d.ws.abs(`${L.DELIVERIES}/grok-scout-gh-1000-1.json`)).payload_sha256, first.payload_sha256);
  assert.deepEqual(calls, [], 'the route asked no provider for anything');
});

test('leads: an envelope fault refuses the whole delivery; a row fault refuses that row only', (t) => {
  const ws = temp(t, 'leads-rows');
  const refused = (b, re) => {
    try { L.ingest(ws, b, { now: T0 }); } catch (err) {
      assert.equal(err.code, 'INVALID');
      assert.match(err.message, /nothing was saved/);
      assert.ok(err.details.errors.some((e) => re.test(e)), `${re} in ${JSON.stringify(err.details.errors)}`);
      return;
    }
    assert.fail('the delivery was saved');
  };
  refused([delivery()], /must be a JSON object/);
  refused(delivery({ extra: 1 }), /^extra: not a field/);
  refused(delivery({ schema: 'cr.scout-leads.v0' }), /^schema: must be cr\.scout-leads\.v1/);
  refused(delivery({ prompt_version: 'cr-scout-prompt@1' }), /^prompt_version: must be cr-scout-leads-prompt@1/);
  refused(delivery({ delivery_id: 'GH-1' }), /^delivery_id:/);
  refused(delivery({ generated_at: 'yesterday' }), /^generated_at:/);
  refused(delivery({ generated_at: '2026-10-28T11:00:00.000Z' }), /^generated_at: more than 24 hours/);
  refused(delivery({ generated_at: '2026-10-30T12:00:00.000Z' }), /^generated_at: more than 24 hours/);
  refused(delivery({ generated_at: '2026-10-29T11:30:00+02:00' }), /^generated_at: must be UTC/);
  refused(delivery({ model: 'gpt-5' }), /^model: must be a Grok model name/);
  refused(delivery({ leads: [] }), /^leads: must be a list of 1 to 10/);
  refused(delivery({ leads: Array.from({ length: 11 }, (_, i) => lead({ contract: EVM(i) })) }), /^leads: must be a list of 1 to 10/);
  assert.deepEqual(leadFiles(ws), [], 'nothing was saved');

  // Ten rows, one bad: nine are recorded, the tenth with its reasons.
  const rows = Array.from({ length: 9 }, (_, i) => lead({ contract: EVM(i + 1) }));
  rows.push(lead({ contract: 'So11111111111111111111111111111111111111112' }));
  const r = L.ingest(ws, delivery({ leads: rows }), { now: T0 });
  assert.equal(r.status, 'accepted');
  assert.equal(r.rows.filter((x) => x.outcome === 'new').length, 9);
  assert.equal(r.rows[9].outcome, 'refused_at_intake');
  assert.equal(r.rows[9].lead_key, null);
  assert.deepEqual(r.rows[9].reasons, ['contract: does not fit base (an EVM address, 0x and 40 hex digits)']);
  assert.equal(assetFiles(ws).length, 9);

  // Every row fault, each recorded on its row and none throwing the delivery.
  const bad = [
    'not a lead',
    lead({ extra: 1 }),
    lead({ chain: 'nowhere' }),
    lead({ chain: 'solana', contract: '0xnot-base58' }),
    lead({ contract: '0x0000000000000000000000000000000000000000' }),
    lead({ signal: 'line one\nline two' }),
    lead({ signal: 'x'.repeat(281) }),
    lead({ urls: ['http://example.com/x'] }),
    lead({ urls: Array.from({ length: 6 }, (_, i) => `https://example.com/${i}`) }),
    lead({ coingecko_id: 'Not A Slug' }),
  ];
  const r2 = L.ingest(ws, delivery({ delivery_id: 'gh-1001-1', leads: bad }), { now: T0 });
  const reasons = r2.rows.map((x) => { assert.equal(x.outcome, 'refused_at_intake'); return x.reasons.join('; '); });
  assert.match(reasons[0], /must be an object/);
  assert.match(reasons[1], /extra: not a field of a lead/);
  assert.match(reasons[2], /chain: "nowhere" is not a chain the desk knows/);
  assert.match(reasons[3], /contract: does not fit solana/);
  assert.match(reasons[4], /a native coin's placeholder address/);
  assert.match(reasons[5], /signal: must be one plain line/);
  assert.match(reasons[6], /signal: longer than 280/);
  assert.match(reasons[7], /urls\[0\]: must start with https:\/\//);
  assert.match(reasons[8], /urls: at most 5/);
  assert.match(reasons[9], /coingecko_id: must be null or a CoinGecko ID/);
  assert.equal(assetFiles(ws).length, 9, 'no refused row made an asset');
});

test('leads: one asset per chain and contract; base58 keeps its case, EVM does not, and chain aliases are one chain', (t) => {
  const ws = temp(t, 'leads-identity');
  // The same row twice in one delivery: the second is a duplicate.
  let r = L.ingest(ws, delivery({ leads: [lead(), lead({ contract: EVM(1).toUpperCase().replace('0X', '0x') })] }), { now: T0 });
  assert.equal(r.rows[0].outcome, 'new');
  assert.equal(r.rows[1].outcome, 'refused_at_intake');
  assert.deepEqual(r.rows[1].reasons, ['duplicate of row 0']);
  // bsc and bnb-chain are one chain; 0xAbC… and 0xabc… one contract.
  r = L.ingest(ws, delivery({ delivery_id: 'gh-1002-1', leads: [lead({ chain: 'bsc', contract: EVM(7).replace(/ab/g, 'AB') }), lead({ chain: 'base', contract: EVM(7) })] }), { now: T0 });
  assert.deepEqual(r.rows.map((x) => x.outcome), ['new', 'new'], 'the same address on two networks is two assets');
  const bsc = r.rows[0].lead_key;
  r = L.ingest(ws, delivery({ delivery_id: 'gh-1003-1', leads: [lead({ chain: 'bnb-chain', contract: EVM(7) })] }), { now: T0 + 60000 });
  assert.equal(r.rows[0].outcome, 'sighting');
  assert.equal(r.rows[0].lead_key, bsc);
  const rec = L.getAsset(ws, bsc);
  assert.deepEqual(rec.identity, { chain_id: '56', chain_label: 'BNB Smart Chain', family: 'evm', address: EVM(7).replace(/ab/g, 'AB'), address_key: EVM(7) });
  assert.equal(rec.sightings.length, 2);
  assert.equal(rec.revision, 1, 'a sighting does not change the revision');
  assert.equal(bsc, sha256(stableStringify(['56', EVM(7)])).slice(0, 32));
  // Two base58 addresses differing only in one letter's case: two files on this disk.
  r = L.ingest(ws, delivery({ delivery_id: 'gh-1004-1', leads: [lead({ chain: 'solana', contract: SOL_A }), lead({ chain: 'sol', contract: SOL_B })] }), { now: T0 });
  assert.deepEqual(r.rows.map((x) => x.outcome), ['new', 'new']);
  assert.notEqual(r.rows[0].lead_key, r.rows[1].lead_key);
  for (const [row, addr] of [[r.rows[0], SOL_A], [r.rows[1], SOL_B]]) {
    assert.ok(fs.existsSync(ws.abs(`${L.ASSETS}/${row.lead_key}.json`)));
    assert.equal(L.getAsset(ws, row.lead_key).identity.address, addr, 'base58 is never lowercased');
  }
  assert.equal(assetFiles(ws).length, 5);
});

test('leads: a record whose identity does not hash to its name is refused as INTEGRITY, and nothing is returned in its place', (t) => {
  const ws = temp(t, 'leads-integrity');
  const r = L.ingest(ws, delivery({ leads: [lead(), lead({ contract: EVM(2) })] }), { now: T0 });
  const [a, b] = r.rows.map((x) => x.lead_key);
  const file = ws.abs(`${L.ASSETS}/${a}.json`);
  const rec = readJson(file);
  rec.identity = { ...rec.identity, address: EVM(2), address_key: EVM(2) };
  fs.writeFileSync(file, JSON.stringify(rec));
  assert.throws(() => L.getAsset(ws, a), (err) => err.code === 'INTEGRITY' && err.status === 409);
  const v = L.view(ws);
  assert.deepEqual(v.assets.find((x) => x.asset_id === a), { asset_id: a, integrity: 'failed' });
  assert.equal(v.assets.filter((x) => x.asset_id === b).length, 1, 'the other asset is still read');
  assert.equal(v.assets.length, 2);
  // A later sighting of the damaged record is held on its row; the file is untouched.
  const r2 = L.ingest(ws, delivery({ delivery_id: 'gh-1005-1', leads: [lead()] }), { now: T0 });
  assert.equal(r2.rows[0].outcome, 'integrity_hold');
  assert.deepEqual(readJson(file), rec);
});

test('leads: six deliveries a day apart from the briefs; a replay still resolves after the sixth', (t) => {
  const ws = temp(t, 'leads-quota');
  for (let i = 0; i < 6; i += 1) assert.equal(L.ingest(ws, delivery({ delivery_id: `gh-200${i}-1` }), { now: T0 }).status, 'accepted');
  assert.equal(L.ingest(ws, delivery({ delivery_id: 'gh-2000-1' }), { now: T0 }).status, 'unchanged', 'a replay resolves after the sixth');
  assert.throws(() => L.ingest(ws, delivery({ delivery_id: 'gh-2006-1' }), { now: T0 }), (err) => err.code === 'DAILY_LIMIT');
  assert.equal(L.view(ws, { now: T0 }).leads_today, 6);
  assert.equal(S.view(ws, { env: {} }).briefs, 0, 'the brief count is untouched');
  // The next UTC day takes deliveries again.
  assert.equal(L.ingest(ws, delivery({ delivery_id: 'gh-2007-1', generated_at: '2026-10-30T00:30:00.000Z' }), { now: Date.parse('2026-10-30T00:31:00.000Z') }).status, 'accepted');
});

test('leads: a save that does not verify is 503, never accepted, and saves nothing; the same delivery again recovers', async (t) => {
  const d = await desk(t, 'fail');
  const at = new Date().toISOString(); // the route checks generated_at against the real clock
  const realOpen = fs.openSync;
  let failing = true;
  fs.openSync = function (p, ...rest) {
    if (failing && /[\\/]\.cr[\\/]staging[\\/]/.test(String(p))) throw Object.assign(new Error('ENOSPC: no space left on device (injected)'), { code: 'ENOSPC' });
    return realOpen.call(this, p, ...rest);
  };
  t.after(() => { fs.openSync = realOpen; });
  let r = await req(d.port, { method: 'POST', path: L.LEADS_PATH, headers: auth, body: delivery({ generated_at: at }) });
  assert.equal(r.status, 503);
  assert.equal(r.json.saved, false);
  assert.equal(r.json.code, 'NOT_SAVED');
  assert.deepEqual(leadFiles(d.ws), [], 'nothing was saved');
  failing = false;
  r = await req(d.port, { method: 'POST', path: L.LEADS_PATH, headers: auth, body: delivery({ generated_at: at }) });
  assert.equal(r.status, 202);
});

test('leads: a dismissal reason that is not one plain line of 280 characters is a clean 400, nothing written', (t) => {
  const calls = noProviders(t);
  const ws = temp(t, 'leads-dismiss-reason');
  const key = L.ingest(ws, delivery(), { now: T0 }).rows[0].lead_key;
  const files = leadFiles(ws);
  let n = 0;
  const rid = () => `req_dismiss_${++n}`;
  for (const reason of ['Line one\nline two', 'Hidden‮mark', 42, { why: 'no' }, 'x'.repeat(281)]) {
    assert.throws(() => L.dismissLead(ws, { lead_key: key, request_id: rid(), reason }), (err) => err.code === 'INVALID' && err.status === 400 && /^The reason was refused: reason: /.test(err.message), `refused: ${JSON.stringify(reason)}`);
    assert.deepEqual(leadFiles(ws), files, 'a refused reason writes nothing');
  }
  assert.equal(L.getAsset(ws, key).state, 'NEW');
  // Blank and missing reasons are no reason; a plain one is kept trimmed.
  assert.equal(L.dismissLead(ws, { lead_key: key, request_id: rid(), reason: '   ' }).status, 'dismissed');
  assert.equal(L.getAsset(ws, key).dismissal.reason, null);
  const other = L.ingest(ws, delivery({ delivery_id: 'gh-1001-1', leads: [lead({ contract: EVM(2) })] }), { now: T0 }).rows[0].lead_key;
  assert.equal(L.dismissLead(ws, { lead_key: other, request_id: rid(), reason: '  Not for me.  ' }).status, 'dismissed');
  assert.equal(L.getAsset(ws, other).dismissal.reason, 'Not for me.');
  assert.deepEqual(calls, []);
});

test('leads: reads write nothing; the backup and offsite package carry scout/leads', (t) => {
  const calls = noProviders(t);
  const ws = temp(t, 'leads-read');
  assert.deepEqual(L.view(ws).assets, []);
  assert.deepEqual(leadFiles(ws), [], 'reading wrote nothing');
  const r = L.ingest(ws, delivery(), { now: T0 });
  const files = leadFiles(ws);
  const v = L.view(ws, { now: T0 });
  assert.equal(v.deliveries, 1);
  assert.equal(v.assets.length, 1);
  assert.equal(v.assets[0].state, 'NEW');
  assert.equal(L.status(ws, 'grok-scout', 'gh-1000-1').receipt_id, r.receipt_id);
  assert.throws(() => L.status(ws, 'grok-scout', 'gh-0000-1'), (err) => err.code === 'NOT_FOUND');
  assert.deepEqual(leadFiles(ws), files, 'reading wrote nothing');
  const paths = exporter.packageSnapshot(ws).entries.map((e) => e.path);
  assert.ok(paths.includes(`${L.DELIVERIES}/grok-scout-gh-1000-1.json`), 'the package carries the delivery');
  assert.ok(paths.includes(`${L.ASSETS}/${r.rows[0].lead_key}.json`), 'and the asset');
  assert.deepEqual(calls, []);
  // The schema file describes the same envelope.
  const schema = readJson(path.join(__dirname, '..', '..', 'templates', 'schemas', 'scout-leads.v1.schema.json'));
  assert.equal(schema.$id, 'cr.scout-leads.v1');
  assert.deepEqual(schema.required.slice().sort(), [...L.ENVELOPE_FIELDS].sort());
  assert.deepEqual(Object.keys(schema.properties.leads.items.properties).sort(), [...L.ROW_FIELDS].sort());
});
