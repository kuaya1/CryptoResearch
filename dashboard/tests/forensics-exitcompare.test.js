'use strict';
// The fixed-token exit comparison (cr-forensic-exit-compare@1): fixed
// dollars against a fixed token quantity over time, from stored quotes and
// explicit quotes Eric asks for. Hypothetical, never a transaction.
// Fictional workspaces and stubbed providers only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempWorkspace, hashTree } = require('./helpers');
const F = require('../core/forensics');
const monitor = require('../core/forensic-monitor');
const FX = require('./forensic-fixtures');
const { atomicWrite, jsonText } = require('../core/fsx');

const H = 3600000;
const at = (ms) => new Date(ms).toISOString();
const TOKEN = '0x2222222222222222222222222222222222222222';
const CG = 'fictional-compare-token';

// A Base project with exit quotes approved, a 0% tax screen (or none), and
// one monitor run of stubbed KyberSwap quotes at $2 (FICTIONAL).
async function setup(label, { tax = true, settings = {} } = {}) {
  const t = tempWorkspace(label, settings);
  const P = require('../core/projects');
  const p = P.addProject(t.ws, { name: 'Compare Example (FICTIONAL)', symbol: 'XCMP', official_website: 'https://compare.example', coingecko_id: CG, assets: [{ chain: 'base', contract_address: TOKEN }], evidence: [{ url: 'https://compare.example', note: 'fictional' }] });
  const pid = p.project_id;
  const a = F.createAudit(t.ws, { project_id: pid, assistant: 'claude' });
  const s = F.saveReport(t.ws, { project_id: pid, audit_id: a.audit_id, provider: 'claude', text: FX.reportText(a.audit) });
  const key = F.view(t.ws, pid).monitoring.proposed.exit_quotes.find((o) => o.chain === 'base').key;
  F.setMonitoring(t.ws, pid, { approve_quotes: [key], enabled: true });
  const target = F.readProfile(t.ws, pid).targets.exit_quotes[0];
  const S = require('../core/screening');
  const contracts = S.contractsOf(P.getProject(t.ws, pid).identity);
  const t0 = Date.now();
  if (tax) {
    fs.mkdirSync(path.join(t.ws.root, 'market-data', 'screening'), { recursive: true });
    atomicWrite(path.join(t.ws.root, 'market-data', 'screening', `${pid}.json`), jsonText({ schema_version: 'cr.screening-project.v1', project_id: pid, contracts_key: S.contractsKey(contracts), snapshot: { fetched_at: at(t0), contracts: contracts.filter((c) => c.screenable).map((c) => ({ chain: c.chain, chain_id: c.chain_id, label: c.label, family: c.family, address: c.address, status: 'ok', checked_at: at(t0), checks: {}, taxes: { buy_pct: 0, sell_pct: 0 }, severe: [], watch: [], unknown: [], notes: [] })) }, last_attempt: { at: at(t0), outcome: 'ok' }, transitions: [] }));
  }
  const calls = [];
  // The stub prices the token at the market file's price, 2% under.
  const fetchImpl = async (u, opts = {}) => {
    calls.push({ url: String(u), method: (opts && opts.method) || 'GET' });
    const url = new URL(u);
    const amountIn = url.searchParams.get('amountIn');
    const px = JSON.parse(fs.readFileSync(path.join(t.ws.root, 'market-data', 'latest.json'), 'utf8')).assets[CG].price_usd;
    const sold = (Number(amountIn) / 1e6) * px;
    const body = { code: 0, data: { routeSummary: { tokenIn: url.searchParams.get('tokenIn'), tokenOut: url.searchParams.get('tokenOut'), amountIn, amountOut: String(Math.floor(sold * 0.98 * 1e6)), amountInUsd: String(sold), amountOutUsd: String(sold * 0.98), gasUsd: '0.05', route: [[{ exchange: 'fictional-dex' }]] } } };
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  const cgGetImpl = async () => ({ id: CG, detail_platforms: { base: { decimal_place: 6, contract_address: TOKEN } } });
  const price = (ms, usd) => atomicWrite(path.join(t.ws.root, 'market-data', 'latest.json'), jsonText({ provider: 'coingecko', assets: { [CG]: { id: CG, price_usd: usd, source_last_updated_at: at(ms), fetched_at: at(ms) } } }));
  price(t0 - 60000, 2);
  await monitor.refresh(t.ws, { now: t0, fetchImpl, cgGetImpl, sleep: async () => {} });
  return { ...t, pid, s, target, t0, calls, fetchImpl, cgGetImpl, price };
}

const quote = (x, extra = {}) => monitor.quoteFixedToken(x.ws, x.pid, { target_id: x.target.target_id, fetchImpl: x.fetchImpl, cgGetImpl: x.cgGetImpl, sleep: async () => {}, ...extra });

test('exit compare: reading needs only stored quotes; the reference is what the position size bought; nothing is asked or written', async (t) => {
  const x = await setup('xc-read');
  t.after(x.cleanup);
  const n = x.calls.length;
  const before = hashTree(path.join(x.root, 'projects'));
  const c = F.view(x.ws, x.pid).exit_compare;
  assert.equal(x.calls.length, n, 'reading asks no provider');
  assert.deepEqual(hashTree(path.join(x.root, 'projects')), before, 'reading writes nothing');
  assert.equal(c.status, 'compared');
  assert.equal(c.size_usd, 500);
  const it = c.items[0];
  assert.equal(it.status, 'compared');
  assert.equal(it.chain_id, '8453');
  assert.equal(it.contract_address, TOKEN);
  assert.equal(it.reference.amount_in, '250000000', '$500 at $2 is 250 tokens of 6 decimals');
  assert.equal(it.reference.tokens, '250');
  assert.equal(it.fixed_usd.length, 1);
  assert.equal(it.fixed_token.length, 0);
  assert.match(it.note, /Quote this quantity now/);
  assert.match(c.note, /never transactions/);
});

test('exit compare: a price change alters the fixed-dollar quantity only; the fixed-token row sells the same tokens and reconciles', async (t) => {
  const x = await setup('xc-price');
  t.after(x.cleanup);
  const t1 = x.t0 + 13 * H;
  x.price(t1 - 60000, 4);
  await monitor.refresh(x.ws, { now: t1, fetchImpl: x.fetchImpl, cgGetImpl: x.cgGetImpl, sleep: async () => {} });
  const r = await quote(x, { amount_in: '250000000', request_id: 'req-fictional-xc-1', now: t1 + 60000 });
  assert.equal(r.status, 'saved');
  const o = r.observation;
  assert.equal(o.source, 'explicit');
  assert.equal(o.basis_kind, 'fixed_token');
  assert.equal(o.amount_in, '250000000');
  assert.equal(o.request_ref, 'req-fictional-xc-1');
  const last = x.calls[x.calls.length - 1];
  assert.equal(last.method, 'GET', 'a keyless GET quote, never a transaction');
  assert.match(last.url, /amountIn=250000000/);
  assert.ok(!/build|swap|execute/i.test(new URL(last.url).pathname), 'no route build, swap or execution is ever asked');
  const it = F.view(x.ws, x.pid, { now: t1 + 120000 }).exit_compare.items[0];
  assert.equal(it.reference.amount_in, '250000000', 'the reference quantity does not move with the price');
  const [d0, d1] = it.fixed_usd;
  assert.equal(d0.amount_in, '250000000');
  assert.equal(d1.amount_in, '125000000', 'fixed dollars sell fewer tokens at the higher price');
  assert.equal(d0.value_usd, 500);
  assert.equal(d1.value_usd, 500);
  assert.equal(it.fixed_token.length, 1);
  const k = it.fixed_token[0];
  assert.equal(k.amount_in, '250000000', 'fixed tokens sell the same quantity');
  assert.equal(k.tokens, '250');
  assert.equal(k.value_usd, 1000, 'the same tokens are worth more at $4');
  assert.equal(k.price_usd, 4);
  // Proceeds and cost reconcile: value less what is received is the cost.
  for (const row of [d0, d1, k]) {
    assert.equal(row.cost_complete, true, 'tax known (0%), network fee quoted');
    assert.ok(Math.abs(((row.value_usd - row.net_received_usd) / row.value_usd) * 100 - row.cost_pct) < 0.01, JSON.stringify(row));
  }
  // Explicit quotes are not monitor readings: not in the review queue, the
  // liquidity readings or the target's last monitor answer.
  const v = F.view(x.ws, x.pid, { now: t1 + 120000 });
  assert.ok(!v.monitoring.exit_quote_targets[0].last_at || v.monitoring.exit_quote_targets[0].last_at !== o.observed_at);
  const ids = new Set(v.states.liquidity.recent.flatMap((rr) => rr.obs_ids || []));
  assert.ok(!ids.has(o.obs_id), 'an explicit quote never enters the liquidity readings');
  const items = (v.evidence_changes.threads || []).flatMap((th) => th.items || []);
  assert.ok(!items.some((i) => i.current && i.current.obs_id === o.obs_id), 'an explicit quote never enters the review queue');
});

test('exit compare: a retry is unchanged with no second request; another amount is refused before any request', async (t) => {
  const x = await setup('xc-retry');
  t.after(x.cleanup);
  const r1 = await quote(x, { amount_in: '250000000', request_id: 'req-fictional-xc-2' });
  assert.equal(r1.status, 'saved');
  const n = x.calls.length;
  const r2 = await quote(x, { amount_in: '250000000', request_id: 'req-fictional-xc-2' });
  assert.equal(r2.status, 'unchanged');
  assert.equal(r2.observation.obs_id, r1.observation.obs_id);
  assert.equal(x.calls.length, n, 'a lost response retried sends nothing');
  await assert.rejects(quote(x, { amount_in: '999000000', request_id: 'req-fictional-xc-3' }), (e) => e.code === 'INVALID');
  await assert.rejects(quote(x, { amount_in: '250000000' }), (e) => e.code === 'INVALID', 'no request without a request ID');
  await assert.rejects(quote(x, { amount_in: '250000000', request_id: 'req-fictional-xc-4', target_id: 'xq_notapproved' }), (e) => e.code === 'NOT_FOUND');
  assert.equal(x.calls.length, n, 'refusals ask nothing');
  assert.equal(F.view(x.ws, x.pid).exit_compare.items[0].fixed_token.length, 1);
});

test('exit compare: unknown tax is never a complete cost', async (t) => {
  const x = await setup('xc-tax', { tax: false });
  t.after(x.cleanup);
  await quote(x, { amount_in: '250000000', request_id: 'req-fictional-xc-5' });
  const it = F.view(x.ws, x.pid).exit_compare.items[0];
  for (const row of [...it.fixed_usd, ...it.fixed_token]) {
    assert.equal(row.cost_complete, false);
    assert.ok(row.missing_costs.some((m) => /tax/i.test(m)), JSON.stringify(row.missing_costs));
  }
});

test('exit compare: the provider gate, the budget, a restored copy and the off switch refuse before any request', async (t) => {
  const x = await setup('xc-gates');
  t.after(x.cleanup);
  const n = x.calls.length;
  const statusFile = path.join(x.root, 'market-data', 'forensics', 'status.json');
  const st = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  atomicWrite(statusFile, jsonText({ ...st, quote_gates: { ...(st.quote_gates || {}), [x.target.provider]: { retry_after_until: at(Date.now() + H) } } }));
  await assert.rejects(quote(x, { amount_in: '250000000', request_id: 'req-fictional-xc-6' }), (e) => e.code === 'REFUSED' && /wait/.test(e.message));
  atomicWrite(statusFile, jsonText(st));
  atomicWrite(path.join(x.root, 'config', 'restored-copy.json'), jsonText({ schema_version: 'cr.restored-copy.v1', research_held: true }));
  await assert.rejects(quote(x, { amount_in: '250000000', request_id: 'req-fictional-xc-7' }), (e) => e.code === 'REFUSED' && /restored copy/.test(e.message));
  fs.rmSync(path.join(x.root, 'config', 'restored-copy.json'));
  x.ws.settings.forensics = { monitor: { enabled: false } };
  await assert.rejects(quote(x, { amount_in: '250000000', request_id: 'req-fictional-xc-8' }), (e) => e.code === 'REFUSED' && /turned off/.test(e.message));
  x.ws.settings.forensics = { monitor: { monthly_request_budget: 1 } };
  await assert.rejects(quote(x, { amount_in: '250000000', request_id: 'req-fictional-xc-9' }), (e) => e.code === 'REFUSED' && /budget/.test(e.message));
  assert.equal(x.calls.length, n, 'no request left the desk');
});

test('exit compare: without an approved chain the comparison says what is missing', (t) => {
  const tw = tempWorkspace('xc-none');
  t.after(tw.cleanup);
  const pid = require('./helpers').addFixtureProject(tw.ws).project_id;
  const c = F.view(tw.ws, pid).exit_compare;
  assert.equal(c.status, 'unavailable');
  assert.match(c.reason, /approve one under Monitoring/);
});
