'use strict';
// Market-cycle context (core/cycle.js): a dated, descriptive snapshot with
// explicit definitions, counted against the CoinGecko call budget, kept when a
// fetch fails, and carried into research evidence packets. All data FICTIONAL.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempWorkspace } = require('./helpers');
const cycle = require('../core/cycle');
const market = require('../core/market');
const { readJson, atomicWrite, jsonText, readJsonLines } = require('../core/fsx');

const now = () => new Date().toISOString();
let fixedTs = null;
const row =(id, price, ch7, ch30, extra = {}) => ({ id, symbol: extra.symbol || id.slice(0, 4), name: extra.name || `${id} (FICTIONAL)`, current_price: price, market_cap: 1e9, price_change_percentage_7d_in_currency: ch7, price_change_percentage_30d_in_currency: ch30, last_updated: fixedTs || now(), ...extra });

// 2 base coins, 5 counted alts (3 beat BTC over 30D), 3 stablecoins, 3 derivatives, 1 invalid row.
function fictionalRows() {
  return [
    row('bitcoin', 70000, 2, 10, { symbol: 'btc', name: 'Bitcoin' }),
    row('ethereum', 3500, 1, 15, { symbol: 'eth', name: 'Ethereum' }),
    row('tether', 1.0, 0, 0.01, { symbol: 'usdt', name: 'Tether' }),
    row('usd-coin', 0.9999, 0, -0.02, { symbol: 'usdc', name: 'USDC' }),
    row('fictional-dollar', 1.003, 0.1, 0.3, { symbol: 'fusd', name: 'Fictional Dollar' }),
    row('wrapped-bitcoin', 69990, 2, 10, { symbol: 'wbtc', name: 'Wrapped Bitcoin' }),
    row('staked-ether', 3499, 1, 15, { symbol: 'steth', name: 'Lido Staked Ether' }),
    row('fictional-restaked-eth', 3600, 1, 15, { symbol: 'feth', name: 'Fictional Restaked ETH' }),
    row('alpha-fictional', 2, 5, 30),
    row('beta-fictional', 3, -1, 12),
    row('gamma-fictional', 4, 3, 5),
    row('delta-fictional', 5, -4, -20),
    row('tether-gold', 4100, -1, -5, { symbol: 'xaut', name: 'Tether Gold' }),
    row('fictional-tbill', 1.12, 0.1, 0.3, { symbol: 'ftb', name: 'Fictional Treasury Fund' }),
    row('broken-fictional', 0, 1, 1),
  ];
}

function fakeFetch({ globalStatus = 200, marketsStatus = 200, rows = fictionalRows(), log = [] } = {}) {
  return async (url) => {
    log.push(url);
    if (url.includes('/global')) {
      return { ok: globalStatus === 200, status: globalStatus, json: async () => ({ data: { total_market_cap: { usd: 2.5e12 }, total_volume: { usd: 9e10 }, market_cap_percentage: { btc: 57.25, eth: 12.5 }, market_cap_change_percentage_24h_usd: -0.8, updated_at: Math.floor(Date.now() / 1000) - 60 } }) };
    }
    if (url.includes('/coins/markets')) return { ok: marketsStatus === 200, status: marketsStatus, json: async () => rows };
    throw new Error(`unexpected URL ${url}`);
  };
}

function enableMarket(ws, root, extra = {}) {
  const s = readJson(path.join(root, 'config', 'settings.json'));
  s.market_data = { enabled: true, ...extra };
  atomicWrite(path.join(root, 'config', 'settings.json'), jsonText(s));
  ws.reloadSettings();
}

test('relative-to-BTC return uses (1 + a) / (1 + b) - 1 and never invents a value', () => {
  assert.equal(Math.round(cycle.relativeToBtc(30, 10) * 1000) / 1000, 18.182);
  assert.equal(cycle.relativeToBtc(10, 10), 0);
  assert.equal(cycle.relativeToBtc(null, 10), null);
  assert.equal(cycle.relativeToBtc(5, null), null);
  assert.equal(cycle.relativeToBtc(5, -100), null, 'a -100% denominator has no meaning');
});

test('a snapshot counts breadth over a stated universe and names every exclusion', () => {
  fixedTs = '2026-10-02T21:59:00.000Z';
  const snap = cycle.buildSnapshot({ global: { data: { total_market_cap: { usd: 2.5e12 }, total_volume: { usd: 9e10 }, market_cap_percentage: { btc: 57.25, eth: 12.5 }, market_cap_change_percentage_24h_usd: -0.8, updated_at: 1790000000 } }, rows: fictionalRows(), capturedAt: '2026-10-02T22:00:00.000Z' });
  assert.match(snap.snapshot_id, cycle.SNAPSHOT_ID_RE);
  assert.equal(snap.dominance.btc_pct, 57.25);
  assert.equal(snap.bitcoin.change_30d_pct, 10);
  assert.deepEqual(snap.breadth.excluded, { bitcoin: 1, stablecoin: 3, commodity_backed: 1, tokenized_fund: 1, derivative: 3, invalid: 1 });
  // Counted: ethereum, alpha, beta, gamma, delta. Beating BTC's +10% over 30D: ethereum (15), alpha (30), beta (12).
  assert.equal(snap.breadth.counted, 5);
  assert.equal(snap.breadth.d30.beating_btc, 3);
  assert.equal(snap.breadth.d30.share_pct, 60);
  // 7D: BTC +2; ethereum 1, alpha 5, beta -1, gamma 3, delta -4 -> alpha and gamma beat it.
  assert.equal(snap.breadth.d7.beating_btc, 2);
  assert.equal(snap.ethereum.eth_btc, 0.05);
  assert.ok(Math.abs(snap.ethereum.vs_btc_30d_pct - 4.55) < 0.01);
  assert.match(snap.breadth.universe, /minus Bitcoin, stablecoins/);
  assert.match(snap.note, /Not a forecast/);
  // Same inputs, same snapshot: the ID carries a content hash.
  const again = cycle.buildSnapshot({ global: { data: { total_market_cap: { usd: 2.5e12 }, total_volume: { usd: 9e10 }, market_cap_percentage: { btc: 57.25, eth: 12.5 }, market_cap_change_percentage_24h_usd: -0.8, updated_at: 1790000000 } }, rows: fictionalRows(), capturedAt: '2026-10-02T22:00:00.000Z' });
  assert.equal(again.snapshot_id, snap.snapshot_id);
  fixedTs = null;
});

test('a snapshot without usable dominance or without Bitcoin is refused, not guessed', () => {
  assert.throws(() => cycle.buildSnapshot({ global: { data: { total_market_cap: { usd: 1 }, market_cap_percentage: {} } }, rows: fictionalRows() }), /dominance/);
  assert.throws(() => cycle.buildSnapshot({ global: { data: { total_market_cap: { usd: 2e12 }, market_cap_percentage: { btc: 55 } } }, rows: fictionalRows().filter((r) => r.id !== 'bitcoin') }), /Bitcoin/);
  assert.throws(() => cycle.buildSnapshot({ global: { nope: true }, rows: [] }), /data object/);
});

test('refresh saves the snapshot and its history, counts both calls, and waits for its interval', async (t) => {
  const { ws, root, cleanup } = tempWorkspace('cycle');
  t.after(cleanup);
  enableMarket(ws, root);
  assert.equal(cycle.packetContext(ws).status, 'unknown', 'no snapshot yet: explicitly unknown');
  const log = [];
  const r = await cycle.refreshContext(ws, { fetchImpl: fakeFetch({ log }) });
  assert.equal(r.status, 'ok', r.message);
  assert.equal(log.length, 2);
  assert.match(log[1], /order=market_cap_desc&per_page=100/);
  const latest = cycle.readContext(ws);
  assert.equal(latest.snapshot_id, r.snapshot_id);
  const history = readJsonLines(path.join(root, 'market-data', 'context', `${latest.captured_at.slice(0, 7)}.jsonl`));
  assert.equal(history.length, 1);
  assert.equal(cycle.findSnapshot(ws, r.snapshot_id).sha256, latest.sha256);
  const st = market.readStatus(ws);
  assert.equal(st.calls.month_count, 2, 'both requests count against the monthly CoinGecko budget');
  assert.equal(st.context.state, 'ok');
  // Not due again for an hour; forcing makes a new snapshot.
  const r2 = await cycle.refreshContext(ws, { fetchImpl: fakeFetch() });
  assert.equal(r2.status, 'not_due');
  const later = await cycle.refreshContext(ws, { fetchImpl: fakeFetch(), now: Date.now() + 61 * 60000 });
  assert.equal(later.status, 'ok');
  const pkt = cycle.packetContext(ws);
  assert.equal(pkt.status, 'captured');
  assert.equal(pkt.snapshot_id, cycle.readContext(ws).snapshot_id);
  assert.equal(pkt.sha256, undefined, 'the packet carries the snapshot, not its storage hash');
});

test('a failed fetch keeps the last snapshot, counts the attempted request and backs off', async (t) => {
  const { ws, root, cleanup } = tempWorkspace('cyclefail');
  t.after(cleanup);
  enableMarket(ws, root);
  const ok = await cycle.refreshContext(ws, { fetchImpl: fakeFetch() });
  const kept = cycle.readContext(ws).snapshot_id;
  const bad = await cycle.refreshContext(ws, { fetchImpl: fakeFetch({ marketsStatus: 500 }), force: true });
  assert.equal(ok.status, 'ok');
  assert.equal(bad.status, 'failed');
  assert.match(bad.message, /HTTP 500/);
  assert.equal(cycle.readContext(ws).snapshot_id, kept, 'last valid snapshot kept');
  const st = market.readStatus(ws);
  assert.equal(st.calls.month_count, 4, '2 + 2: the failing second request still counts');
  assert.equal(st.context.state, 'failed');
  assert.equal(cycle.due(ws, Date.now()), false, 'waits after a failure');
  const offline = await cycle.refreshContext(ws, { fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); }, force: true });
  assert.equal(offline.status, 'failed');
  assert.equal(market.readStatus(ws).calls.month_count, 5);
});

test('a price refresh keeps the market-context record, so context is not fetched again right after it', async (t) => {
  const { ws, root, cleanup } = tempWorkspace('cyclekeep');
  t.after(cleanup);
  enableMarket(ws, root);
  const ctx = await cycle.refreshContext(ws, { fetchImpl: fakeFetch() });
  assert.equal(ctx.status, 'ok', ctx.message);
  const log = [];
  const prices = await market.refresh(ws, { fetchImpl: fakeFetch({ log }), trigger: 'dashboard' });
  assert.ok(['ok', 'partial'].includes(prices.status), prices.message);
  assert.equal(log.length, 1, 'one batched /coins/markets call for prices');
  const st = market.readStatus(ws);
  assert.equal(st.context.state, 'ok', 'the price write keeps the context block');
  assert.equal(st.context.last_snapshot_id, ctx.snapshot_id);
  assert.equal(st.calls.month_count, 3, 'two context calls and one price call');
  assert.equal(cycle.due(ws, Date.now(), { foreground: true }), false);
  const again = await cycle.refreshContext(ws, { fetchImpl: fakeFetch({ log }), trigger: 'dashboard', foreground: true });
  assert.equal(again.status, 'not_due');
  assert.equal(log.length, 1, 'no /global or top-100 call after the price refresh');
  assert.equal(cycle.contextStatus(ws).last_success_at, st.context.last_success_at);
  // Due again only after its hour.
  assert.equal(cycle.due(ws, Date.now() + 61 * 60000, { foreground: true }), true);
});

test('a 429 on market context honors Retry-After and closes the shared gate: prices and context wait, even when forced', async (t) => {
  const { ws, root, cleanup } = tempWorkspace('cycle429');
  t.after(cleanup);
  enableMarket(ws, root);
  const log = [];
  const limited = async (url) => {
    log.push(url);
    return { ok: false, status: 429, headers: { get: (k) => (k === 'retry-after' ? '90' : null) }, json: async () => ({}) };
  };
  const r = await cycle.refreshContext(ws, { fetchImpl: limited });
  assert.equal(r.status, 'failed');
  assert.match(r.message, /HTTP 429/);
  assert.equal(log.length, 1, 'stops at the first 429');
  const st = market.readStatus(ws);
  assert.equal(st.context.state, 'failed');
  assert.equal(st.rate_limit.source, 'market context');
  assert.equal(st.rate_limit.retry_after_ms, 90000);
  assert.ok(Math.abs(Date.parse(st.retry_after_until) - Date.now() - 90000) < 5000);
  const p = await market.refresh(ws, { fetchImpl: limited, force: true });
  assert.equal(p.status, 'backoff');
  assert.equal(p.rate_limited, true);
  const c = await cycle.refreshContext(ws, { fetchImpl: limited, force: true });
  assert.equal(c.status, 'backoff');
  assert.match(c.message, /rate-limiting this server; next try/);
  assert.equal(log.length, 1, 'nothing else was sent');
  assert.equal(require('../core/jobs').marketDue(ws, Date.now(), { foreground: true }), false);

  // Without Retry-After the gate still closes, for the default two minutes.
  const { ws: ws2, root: root2, cleanup: c2 } = tempWorkspace('cycle429b');
  t.after(c2);
  enableMarket(ws2, root2);
  await cycle.refreshContext(ws2, { fetchImpl: fakeFetch({ globalStatus: 429 }) });
  const wait = Date.parse(market.readStatus(ws2).retry_after_until) - Date.now();
  assert.ok(wait > 110000 && wait <= 120000, `got ${wait} ms`);
});

test('market context is skipped while the rate-limit gate is closed, even when it is due', async (t) => {
  const { ws, root, cleanup } = tempWorkspace('cyclegate');
  t.after(cleanup);
  enableMarket(ws, root);
  assert.equal(cycle.due(ws, Date.now()), true, 'never captured: due');
  market.noteRateLimit(ws, { source: 'research intake' });
  const log = [];
  const r = await cycle.refreshContext(ws, { fetchImpl: fakeFetch({ log }) });
  assert.equal(r.status, 'backoff');
  assert.equal(r.rate_limited, true);
  assert.equal(log.length, 0);
  assert.equal(market.callBudget(ws, market.readStatus(ws)).month_count, 0);
});

test('the monthly call budget pauses market context before any request', async (t) => {
  const { ws, root, cleanup } = tempWorkspace('cyclebudget');
  t.after(cleanup);
  enableMarket(ws, root, { monthly_call_budget: 1 });
  const log = [];
  const r = await cycle.refreshContext(ws, { fetchImpl: fakeFetch({ log }), force: true });
  assert.equal(r.status, 'budget_paused');
  assert.equal(log.length, 0);
  assert.equal(fs.existsSync(path.join(root, 'market-data', 'context', 'latest.json')), false);
});

test('market context can be turned off; then nothing is fetched and packets say so', async (t) => {
  const { ws, root, cleanup } = tempWorkspace('cycleoff');
  t.after(cleanup);
  enableMarket(ws, root, { context_enabled: false });
  const log = [];
  const r = await cycle.refreshContext(ws, { fetchImpl: fakeFetch({ log }), force: true });
  assert.equal(r.status, 'skipped');
  assert.equal(log.length, 0);
  assert.match(cycle.packetContext(ws).note, /turned off/);
  assert.equal(cycle.contextStatus(ws).state, 'off');
});
