'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempWorkspace, addFixtureProject, importAllFixtures, hashTree } = require('./helpers');
const market = require('../core/market');
const { loadReports } = require('../core/reports');
const { compareProject } = require('../core/compare');
const { readJson, atomicWrite, jsonText } = require('../core/fsx');

function fakeFetch(prices) {
  return async (url) => {
    const ids = decodeURIComponent(new URL(url).searchParams.get('ids')).split(',');
    return {
      ok: true,
      status: 200,
      json: async () => ids.filter((id) => prices[id] !== undefined).map((id) => ({ id, symbol: id.slice(0, 4), name: id, current_price: prices[id], market_cap: 1e6, fully_diluted_valuation: 2e6, total_volume: 1e5, price_change_percentage_24h: 1.5, circulating_supply: 1e6, total_supply: 2e6, max_supply: null, last_updated: new Date().toISOString() })),
    };
  };
}

function enableMarket(ws, root) {
  const s = readJson(path.join(root, 'config', 'settings.json'));
  s.market_data = { enabled: true };
  atomicWrite(path.join(root, 'config', 'settings.json'), jsonText(s));
  ws.reloadSettings();
}

test('price updates never change stored reports or historical grades', async (t) => {
  const { ws, root, cleanup } = tempWorkspace('mkt');
  t.after(cleanup);
  addFixtureProject(ws);
  importAllFixtures(ws);
  enableMarket(ws, root);
  const before = hashTree(path.join(root, 'projects'));
  const gradesBefore = JSON.stringify(compareProject(ws, loadReports(ws, 'example-payfi-fictional')).grades);
  const r1 = await market.refresh(ws, { fetchImpl: fakeFetch({ 'example-payfi-fictional': 0.5, bitcoin: 70000 }) });
  // usd-coin and tether are tracked but not in this fake response: a partial refresh.
  assert.equal(r1.status, 'partial');
  assert.deepEqual(r1.missing.sort(), ['tether', 'usd-coin']);
  const r2 = await market.refresh(ws, { fetchImpl: fakeFetch({ 'example-payfi-fictional': 0.05, bitcoin: 30000 }) });
  assert.equal(r2.status, 'partial');
  assert.deepEqual(hashTree(path.join(root, 'projects')), before, 'no project or report file changed');
  assert.equal(JSON.stringify(compareProject(ws, loadReports(ws, 'example-payfi-fictional')).grades), gradesBefore);
  assert.equal(market.readLatest(ws).assets['example-payfi-fictional'].price_usd, 0.05);
  const obsFiles = fs.readdirSync(path.join(root, 'market-data', 'observations'));
  assert.equal(obsFiles.length, 1);
});

test('a failed refresh keeps the last valid observation and reports failure', async (t) => {
  const { ws, root, cleanup } = tempWorkspace('mktfail');
  t.after(cleanup);
  addFixtureProject(ws);
  enableMarket(ws, root);
  await market.refresh(ws, { fetchImpl: fakeFetch({ 'example-payfi-fictional': 0.5, bitcoin: 70000 }) });
  const failing = async () => {
    throw new Error('getaddrinfo ENOTFOUND api.coingecko.com');
  };
  const r = await market.refresh(ws, { fetchImpl: failing });
  assert.equal(r.status, 'failed');
  const status = market.readStatus(ws);
  assert.equal(status.state, 'failed');
  assert.equal(status.consecutive_failures, 1);
  assert.ok(status.last_success_at, 'last valid timestamp kept');
  assert.equal(market.readLatest(ws).assets['example-payfi-fictional'].price_usd, 0.5, 'last valid price kept');
  const later = market.freshness(ws, Date.now() + 3 * 3600 * 1000);
  assert.equal(later.freshness, 'stale_failed');
});

test('only verified identities are sent to the price provider', async (t) => {
  const { ws, cleanup } = tempWorkspace('mktids');
  t.after(cleanup);
  addFixtureProject(ws);
  require('../core/projects').addProject(ws, { name: 'Guess Token', symbol: 'GSS', coingecko_id: 'guess-token' });
  const ids = market.trackedIds(ws);
  assert.ok(ids.includes('example-payfi-fictional'));
  assert.ok(ids.includes('bitcoin'));
  assert.ok(!ids.includes('guess-token'));
});
