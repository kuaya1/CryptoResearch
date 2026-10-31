'use strict';
// `arm-desk` and `contracts init-defaults` (2026-10-30): the paper desk's
// baseline settings and the published contract defaults, each checked by the
// same validateSettingsPatch as Settings. FICTIONAL temporary workspaces; no
// network, no key, no provider.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { tempWorkspace, hashTree } = require('./helpers');
const { run } = require('../cli');
const { validateSettingsPatch, start } = require('../server');
const A = require('../core/arm-desk');
const P = require('../core/contract-presets');
const K = require('../core/keccak');
const TR = require('../core/trader-rules');
const L = require('../core/leads');

function temp(t, settings = {}) {
  const w = tempWorkspace('arm', settings);
  t.after(w.cleanup);
  return w;
}
const reopen = (w) => require('../core/workspace').openWorkspace({ root: w.root, actor: 'test' });

test('arm-desk --dry-run validates cleanly against validateSettingsPatch and writes nothing', async (t) => {
  const w = temp(t);
  const before = hashTree(w.root);
  const out = await run(['arm-desk', '--dry-run', '--workspace', w.root]);
  assert.equal(out.status, 'planned');
  assert.equal(out.valid, true);
  assert.deepEqual(out.patch, validateSettingsPatch(A.armPatch(), w.ws), 'the patch shown is the validated one');
  assert.equal(out.patch.leads.enabled, true);
  assert.equal(out.patch.leads.chains.length, 10);
  assert.deepEqual([out.patch.leads.min_market_cap_usd, out.patch.leads.min_volume_24h_usd, out.patch.leads.max_sell_tax_pct, out.patch.leads.eligibility_hours], [5000000, 250000, 5, 48]);
  assert.equal(out.patch.automation.exit_quotes_auto, true);
  assert.deepEqual(out.patch.trader.book, { cash_usd: '25000', fee_rate: '0.001' });
  assert.deepEqual(out.patch.trader.rules, { stop_min_pct: '0.03', stop_min_atr: '0.5', notional_max_pct: '0.20', max_validity_minutes: 1440 });
  assert.deepEqual(out.patch.tickets, { sizing: { min_grade_new_entry: 50 } });
  assert.equal(out.patch.automation.autonomous_paper_loop, undefined, 'the mandate untouched without a flag');
  assert.equal(out.patch.contracts, undefined, 'contracts untouched without caps');
  assert.ok(out.left_for_you.some((s) => /allowlist is unset/.test(s)));
  assert.ok(out.left_for_you.some((s) => /caps are unset/.test(s)));
  assert.equal(out.contract_defaults.pool_factories.length, 8);
  assert.deepEqual(hashTree(w.root), before, 'nothing written');
  // With the caps and pairs named, still valid; a cap under the minimum is refused.
  const capped = await run(['arm-desk', '--dry-run', '--daily-cu=5000', '--monthly-cu=100000', '--allow=XFIC/USDC,ABC/USDC', '--workspace', w.root]);
  assert.deepEqual(capped.patch.contracts, { daily_cu_cap: 5000, monthly_cu_cap: 100000 });
  assert.deepEqual(capped.patch.trader.rules.allowlist, ['XFIC/USDC', 'ABC/USDC']);
  assert.ok(!capped.left_for_you.some((s) => /allowlist|caps/.test(s)));
  await assert.rejects(run(['arm-desk', '--dry-run', '--daily-cu=500', '--workspace', w.root]), (e) => e.code === 'INVALID');
  await assert.rejects(run(['arm-desk', '--dry-run', '--daily-cu=5k', '--workspace', w.root]), (e) => e.code === 'USAGE');
  await assert.rejects(run(['arm-desk', '--desk=elsewhere', '--workspace', w.root]), (e) => e.code === 'USAGE');
  assert.deepEqual(hashTree(w.root), before, 'still nothing written');
});

test('arm-desk locally: the settings and the contract defaults are written; the trader waits only for the allowlist', async (t) => {
  const w = temp(t);
  const out = await run(['arm-desk', '--workspace', w.root]);
  assert.equal(out.status, 'saved');
  assert.equal(out.verified, true);
  const ws = reopen(w);
  assert.deepEqual(L.policyOf(ws).missing, [], 'the lead policy is complete');
  assert.equal(L.policyOf(ws).values.enabled, true);
  assert.equal(ws.settings.automation.exit_quotes_auto, true);
  assert.equal(ws.settings.automation.paused, false, 'the pause untouched');
  assert.deepEqual(TR.bookOf(ws).unset, []);
  assert.deepEqual(TR.rulesOf(ws).unset, ['allowlist']);
  assert.equal(ws.settings.contracts.enabled, false, 'observations stay off');
  assert.equal(ws.settings.contracts.daily_cu_cap, null);
  assert.equal(ws.settings.contracts.pool_factories.length, 8);
  assert.equal(ws.settings.contracts.safe_singleton_code_hashes.length, 4);
  assert.deepEqual(ws.settings.contracts.network_fee_ceiling_usd, { 1: 5, 8453: 0.25, 42161: 0.25, 10: 0.25 });
  // Again, with pairs: the allowlist is the last rule; the defaults are not added twice.
  const again = await run(['arm-desk', '--allow=XFIC/USDC', '--workspace', w.root]);
  assert.deepEqual(again.contract_defaults.pool_factories, []);
  const ws2 = reopen(w);
  assert.deepEqual(TR.rulesOf(ws2).unset, []);
  assert.equal(ws2.settings.contracts.pool_factories.length, 8);
});

test('arm-desk --desk=online prints a console script with the same validated settings and no secret', async (t) => {
  const w = temp(t);
  const before = hashTree(w.root);
  const out = await run(['arm-desk', '--desk=online', '--workspace', w.root]);
  const text = out._text;
  assert.match(text, /fetch\('\/api\/session'/);
  assert.match(text, /'x-cr-token': s\.token/);
  assert.match(text, /post\('\/api\/contracts\/init-defaults', \{\}\)/);
  const body = JSON.parse(text.match(/post\('\/api\/settings', (\{.*\})\)\);/)[1]);
  assert.deepEqual(body, A.armPatch());
  validateSettingsPatch(body, w.ws);
  assert.doesNotMatch(text, /DESK_INGEST_KEY|XAI_API_KEY|ALCHEMY_API_KEY|passphrase/i);
  assert.deepEqual(hashTree(w.root), before, 'nothing written');
});

test('contract presets: every row passes Settings, the mainnet rows derive the published USDC/WETH pools, and Eric\'s own values are kept', async (t) => {
  const p = P.plan({ contracts: { pool_factories: [], safe_singleton_code_hashes: [], network_fee_ceiling_usd: {} } });
  const checked = validateSettingsPatch(p.patch).contracts;
  assert.equal(checked.pool_factories.length, 8);
  assert.deepEqual(checked.pool_factories, P.POOL_FACTORIES.map((r) => validateSettingsPatch({ contracts: { pool_factories: [r] } }).contracts.pool_factories[0]), 'already in the stored form');
  assert.deepEqual([...new Set(checked.pool_factories.map((r) => r.chain_id))].sort(), ['1', '10', '42161', '8453']);
  assert.ok(checked.pool_factories.every((r) => r.quotes.length === 1 && r.quotes[0].symbol === 'USDC' && r.quotes[0].decimals === 6 && r.quotes[0].usd_value === '1'));
  assert.equal(checked.safe_singleton_code_hashes.length, 4);
  assert.deepEqual(checked.network_fee_ceiling_usd, { 1: 5, 8453: 0.25, 42161: 0.25, 10: 0.25 });
  // The factory and init-code hash give the published mainnet USDC/WETH pools.
  const USDC = P.USDC[1].slice(2);
  const WETH = 'c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
  const v3 = P.POOL_FACTORIES.find((r) => r.chain_id === '1' && r.kind === 'v3');
  const v2 = P.POOL_FACTORIES.find((r) => r.chain_id === '1' && r.kind === 'v2');
  assert.equal(K.create2Address(v3.factory, K.keccak256Hex(`0x${USDC.padStart(64, '0')}${WETH.padStart(64, '0')}${(500).toString(16).padStart(64, '0')}`), v3.init_code_hash), '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640');
  assert.equal(K.create2Address(v2.factory, K.keccak256Hex(`0x${USDC}${WETH}`), v2.init_code_hash), '0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc');
  // Eric's own: a row with the same factory and a ceiling he chose are kept.
  const mine = { ...P.POOL_FACTORIES[0], name: 'Mine', fee_tiers: [500] };
  const kept = P.plan({ contracts: { pool_factories: [mine], safe_singleton_code_hashes: [P.SAFE_SINGLETON_CODE_HASHES[0].toUpperCase().replace('0X', '0x')], network_fee_ceiling_usd: { 1: 2 } } });
  assert.equal(kept.patch.contracts.pool_factories.length, 8);
  assert.equal(kept.patch.contracts.pool_factories[0].name, 'Mine');
  assert.equal(kept.patch.contracts.safe_singleton_code_hashes.length, 4);
  assert.equal(kept.patch.contracts.network_fee_ceiling_usd[1], 2);
  assert.equal(kept.added.pool_factories.length, 7);
  assert.equal(P.plan({ contracts: { ...checked } }).patch, null, 'nothing to add');
});

test('contracts init-defaults: --dry-run writes nothing; the run adds the defaults once', async (t) => {
  const w = temp(t);
  const before = hashTree(w.root);
  const dry = await run(['contracts', 'init-defaults', '--dry-run', '--workspace', w.root]);
  assert.equal(dry.status, 'planned');
  assert.equal(dry.patch.contracts.pool_factories.length, 8);
  assert.deepEqual(hashTree(w.root), before);
  const out = await run(['contracts', 'init-defaults', '--workspace', w.root]);
  assert.equal(out.status, 'saved');
  assert.equal(out.verified, true);
  assert.equal(reopen(w).settings.contracts.pool_factories.length, 8);
  assert.equal((await run(['contracts', 'init-defaults', '--workspace', w.root])).status, 'unchanged');
});

test('POST /api/contracts/init-defaults: dry_run writes nothing, then the defaults are saved, signed in only', async (t) => {
  const w = temp(t);
  const srv = await start(w.ws, { port: 47980 + Math.floor(Math.random() * 9), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } });
  const ask = (p, headers = {}, body = null) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: p, method: body ? 'POST' : 'GET', headers: { host: `127.0.0.1:${srv.port}`, ...(body ? { 'content-type': 'application/json', origin: `http://127.0.0.1:${srv.port}` } : {}), ...headers } }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(Buffer.concat(c).toString()); } catch (_) { return null; } })() }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  const token = (await ask('/api/session')).json.token;
  const settingsFile = () => fs.readFileSync(path.join(w.root, 'config', 'settings.json'), 'utf8');
  const before = settingsFile();
  const dry = await ask('/api/contracts/init-defaults', { 'x-cr-token': token }, { dry_run: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.json.status, 'planned');
  assert.equal(settingsFile(), before);
  assert.equal((await ask('/api/contracts/init-defaults', {}, {})).status, 401);
  const saved = await ask('/api/contracts/init-defaults', { 'x-cr-token': token }, {});
  assert.equal(saved.json.status, 'saved');
  assert.equal(JSON.parse(settingsFile()).contracts.pool_factories.length, 8);
  assert.equal((await ask('/api/contracts/init-defaults', { 'x-cr-token': token }, {})).json.status, 'unchanged');
});

// --- Autonomous paper playbook, Stage 12.

test('--intent-life sets the life of an intent (1 to 10,080 minutes); --contracts-on needs both caps', async (t) => {
  const w = temp(t);
  const before = hashTree(w.root);
  const life = await run(['arm-desk', '--dry-run', '--intent-life=4320', '--workspace', w.root]);
  assert.equal(life.patch.trader.rules.max_validity_minutes, 4320);
  await assert.rejects(run(['arm-desk', '--dry-run', '--intent-life=20000', '--workspace', w.root]), (e) => e.code === 'USAGE');
  await assert.rejects(run(['arm-desk', '--dry-run', '--intent-life=0', '--workspace', w.root]), (e) => e.code === 'USAGE');
  await assert.rejects(run(['arm-desk', '--dry-run', '--contracts-on', '--workspace', w.root]), (e) => e.code === 'REFUSED' && /both compute-unit caps/.test(e.message));
  await assert.rejects(run(['arm-desk', '--dry-run', '--contracts-on', '--daily-cu=5000', '--workspace', w.root]), (e) => e.code === 'REFUSED');
  const on = await run(['arm-desk', '--dry-run', '--contracts-on', '--daily-cu=5000', '--monthly-cu=100000', '--workspace', w.root]);
  assert.deepEqual(on.patch.contracts, { daily_cu_cap: 5000, monthly_cu_cap: 100000, enabled: true });
  assert.ok(on.left_for_you.some((s) => /ALCHEMY_API_KEY in Render > Environment/.test(s)));
  assert.deepEqual(hashTree(w.root), before, 'nothing written');
  // Caps already saved locally count.
  const w2 = temp(t, { contracts: { daily_cu_cap: 5000, monthly_cu_cap: 100000 } });
  assert.equal((await run(['arm-desk', '--dry-run', '--contracts-on', '--workspace', w2.root])).patch.contracts.enabled, true);
});

test('--mandate-days turns the paper mandate on for N days (1 to 30); --mandate-off turns it off; not both', async (t) => {
  const w = temp(t);
  const t0 = Date.now();
  const on = await run(['arm-desk', '--dry-run', '--mandate-days=7', '--workspace', w.root]);
  assert.equal(on.patch.automation.autonomous_paper_loop, true);
  const ahead = Date.parse(on.patch.automation.mandate.expires_at) - t0;
  assert.ok(ahead > 6.99 * 86400000 && ahead <= 7 * 86400000 + 60000, String(ahead));
  assert.ok(on.left_for_you.some((s) => /paper mandate is on until/.test(s)));
  await assert.rejects(run(['arm-desk', '--dry-run', '--mandate-days=31', '--workspace', w.root]), (e) => e.code === 'USAGE');
  await assert.rejects(run(['arm-desk', '--dry-run', '--mandate-days=0', '--workspace', w.root]), (e) => e.code === 'USAGE');
  await assert.rejects(run(['arm-desk', '--dry-run', '--mandate-days=7', '--mandate-off', '--workspace', w.root]), (e) => e.code === 'USAGE');
  const off = await run(['arm-desk', '--dry-run', '--mandate-off', '--workspace', w.root]);
  assert.equal(off.patch.automation.autonomous_paper_loop, false);
  assert.ok(off.left_for_you.some((s) => /paper mandate is off/.test(s)));
  // Written locally, the mandate reads on.
  await run(['arm-desk', '--mandate-days=7', '--workspace', w.root]);
  const T = require('../core/tickets');
  assert.equal(T.mandateOf(reopen(w)).on, true);
  assert.equal(reopen(w).settings.tickets.sizing.min_grade_new_entry, 50);
});

test('--desk=online with the flags: the settings, then the exit-quote targets, then the contract defaults; what is left as comments', async (t) => {
  const w = temp(t);
  const before = hashTree(w.root);
  const out = await run(['arm-desk', '--desk=online', '--allow=NMR/USDC', '--daily-cu=5000', '--monthly-cu=100000', '--contracts-on', '--mandate-days=7', '--intent-life=4320', '--workspace', w.root]);
  const text = out._text;
  const body = JSON.parse(text.match(/post\('\/api\/settings', (\{.*\})\)\);/)[1]);
  validateSettingsPatch(body, w.ws);
  assert.deepEqual(body.trader.rules.allowlist, ['NMR/USDC']);
  assert.equal(body.trader.rules.max_validity_minutes, 4320);
  assert.deepEqual(body.contracts, { daily_cu_cap: 5000, monthly_cu_cap: 100000, enabled: true });
  assert.equal(body.automation.autonomous_paper_loop, true);
  assert.deepEqual(body.tickets, { sizing: { min_grade_new_entry: 50 } });
  const at = (p) => text.indexOf(p);
  assert.ok(at("post('/api/settings'") < at("post('/api/forensics/exit-quotes/auto', {})") && at("post('/api/forensics/exit-quotes/auto', {})") < at("post('/api/contracts/init-defaults', {})"));
  assert.match(text, /^\/\/ Left for you: .*CR_PILOT_POLL_TOKEN_SHA256/m);
  assert.doesNotMatch(text, /DESK_INGEST_KEY|XAI_API_KEY|passphrase|pilot_poll_token":/i);
  // The online desk's caps are not known here: --contracts-on needs them named.
  await assert.rejects(run(['arm-desk', '--desk=online', '--contracts-on', '--workspace', w.root]), (e) => e.code === 'REFUSED');
  assert.deepEqual(hashTree(w.root), before, 'nothing written');
});

test('--print-schedule prints the schtasks line for pilot-all and runs nothing', async (t) => {
  const w = temp(t);
  const before = hashTree(w.root);
  const out = await run(['arm-desk', '--print-schedule', '--workspace', w.root]);
  assert.match(out._text, /^schtasks \/Create \/TN "CryptoResearch pilot-all" \/SC MINUTE \/MO 30 \/IT \/TR "cmd\.exe \/c cd \/d .* && npm run pilot -- --pilot-all --desk=online --max-agents=2" \/F$/m);
  assert.match(out._text, /Nothing was run/);
  assert.deepEqual(hashTree(w.root), before, 'nothing written');
});
