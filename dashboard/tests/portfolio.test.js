'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempWorkspace, addFixtureProject, FIXTURES } = require('./helpers');
const pf = require('../core/portfolio');

const NOW = Date.parse('2026-10-01T14:00:00Z');
function market(prices, fetchedAt = '2026-10-01T13:55:00Z') {
  const assets = {};
  for (const [id, price] of Object.entries(prices)) assets[id] = { id, price_usd: price, source_last_updated_at: fetchedAt, fetched_at: fetchedAt };
  return { provider: 'test', assets };
}
function setup(label) {
  const t = tempWorkspace(label);
  addFixtureProject(t.ws);
  pf.addAccount(t.ws, { account_id: 'ex', name: 'Exchange', kind: 'exchange' });
  pf.addAccount(t.ws, { account_id: 'wallet', name: 'Wallet', kind: 'self_custody' });
  return t;
}
const pos = (out, id) => out.positions.find((p) => p.asset_id === id);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≈ ${b}`);

test('FIFO realized P&L with USD fees on both sides', (t) => {
  const { ws, cleanup } = setup('fifo');
  t.after(cleanup);
  pf.addTransactions(ws, [
    { type: 'buy', date: '2026-07-01', account_id: 'ex', asset_id: 'example-payfi-fictional', quantity: 10, price_usd: 100, fee: { amount: 10, asset_id: 'usd' } },
    { type: 'buy', date: '2026-07-02', account_id: 'ex', asset_id: 'example-payfi-fictional', quantity: 10, price_usd: 200 },
    { type: 'sell', date: '2026-07-03', account_id: 'ex', asset_id: 'example-payfi-fictional', quantity: 15, price_usd: 300, fee: { amount: 5, asset_id: 'usd' } },
  ]);
  const out = pf.computePortfolio(ws, { market: market({ 'example-payfi-fictional': 250 }), now: NOW });
  const p = pos(out, 'example-payfi-fictional');
  close(p.realized_known_usd, 4495 - 2010); // proceeds 4500-5, cost 1010 + 5*200
  close(p.quantity, 5);
  close(p.cost_basis_known_usd, 1000);
  close(p.value_usd, 1250);
  close(p.unrealized_known_usd, 250);
  close(p.fees_usd, 15);
});

test('internal transfers and bridges move lots with no profit and no double counting', (t) => {
  const { ws, cleanup } = setup('transfer');
  t.after(cleanup);
  pf.addTransactions(ws, [
    { type: 'buy', date: '2026-07-01', account_id: 'ex', asset_id: 'example-payfi-fictional', quantity: 100, price_usd: 1 },
    { type: 'transfer_out', date: '2026-07-05', account_id: 'ex', asset_id: 'example-payfi-fictional', quantity: 100, transfer_id: 'bridge-1', chain: 'ethereum' },
    { type: 'transfer_in', date: '2026-07-05', account_id: 'wallet', asset_id: 'example-payfi-fictional', quantity: 99, transfer_id: 'bridge-1', chain: 'solana' },
  ]);
  const out = pf.computePortfolio(ws, { market: market({ 'example-payfi-fictional': 2 }), now: NOW });
  const p = pos(out, 'example-payfi-fictional');
  close(p.quantity, 99);
  close(p.cost_basis_known_usd, 100); // basis carried over, the 1 unit fee stays in basis
  close(p.realized_known_usd, 0);
  close(p.fees_in_kind_quantity, 1);
  assert.deepEqual(p.by_account.map((a) => a.account_id), ['wallet']);
  close(out.totals.value_priced_usd, 198);
});

test('a transfer that has not arrived stays counted as in transit, with a warning', (t) => {
  const { ws, cleanup } = setup('transit');
  t.after(cleanup);
  pf.addTransactions(ws, [
    { type: 'buy', date: '2026-07-01', account_id: 'ex', asset_id: 'example-payfi-fictional', quantity: 50, price_usd: 1 },
    { type: 'transfer_out', date: '2026-07-05', account_id: 'ex', asset_id: 'example-payfi-fictional', quantity: 50, transfer_id: 'x1' },
  ]);
  const out = pf.computePortfolio(ws, { market: market({ 'example-payfi-fictional': 1 }), now: NOW });
  const p = pos(out, 'example-payfi-fictional');
  close(p.quantity, 50);
  close(p.in_transit_quantity, 50);
  assert.ok(out.warnings.some((w) => w.kind === 'in_transit'));
});

test('unknown purchase history means unknown cost basis, never a guess', (t) => {
  const { ws, cleanup } = setup('basis');
  t.after(cleanup);
  pf.addTransactions(ws, [{ type: 'transfer_in', date: '2026-07-01', account_id: 'wallet', asset_id: 'example-payfi-fictional', quantity: 40 }]);
  const out = pf.computePortfolio(ws, { market: market({ 'example-payfi-fictional': 3 }), now: NOW });
  const p = pos(out, 'example-payfi-fictional');
  assert.equal(p.cost_basis_status, 'unknown');
  assert.equal(p.cost_basis_known_usd, null);
  assert.equal(p.unrealized_known_usd, null);
  close(p.value_usd, 120);
  assert.equal(p.btc_relative.status, 'incomplete');
});

test('missing prices make value unknown (not zero); stale prices are marked stale', (t) => {
  const { ws, cleanup } = setup('prices');
  t.after(cleanup);
  pf.addTransactions(ws, [
    { type: 'buy', date: '2026-07-01', account_id: 'ex', asset_id: 'example-payfi-fictional', quantity: 10, price_usd: 1 },
    { type: 'buy', date: '2026-07-01', account_id: 'ex', asset_id: 'bitcoin', quantity: 0.01, price_usd: 60000 },
  ]);
  const out = pf.computePortfolio(ws, { market: market({ bitcoin: 65000 }, '2026-10-01T09:00:00Z'), now: NOW });
  const x = pos(out, 'example-payfi-fictional');
  assert.equal(x.value_usd, null);
  assert.equal(x.allocation_pct, null);
  assert.equal(out.totals.unpriced_count, 1);
  const b = pos(out, 'bitcoin');
  assert.equal(b.price.status, 'stale');
  close(out.totals.value_priced_usd, 650);
});

test('BTC-relative result only when every cash flow has a BTC price', (t) => {
  const { ws, cleanup } = setup('btc');
  t.after(cleanup);
  pf.addTransactions(ws, [
    { type: 'buy', date: '2026-07-01', account_id: 'ex', asset_id: 'example-payfi-fictional', quantity: 1000, price_usd: 1, btc_price_usd: 50000 },
    { type: 'sell', date: '2026-08-01', account_id: 'ex', asset_id: 'example-payfi-fictional', quantity: 500, price_usd: 2, btc_price_usd: 50000 },
  ]);
  const out = pf.computePortfolio(ws, { market: market({ 'example-payfi-fictional': 2, bitcoin: 100000 }), now: NOW });
  const b = pos(out, 'example-payfi-fictional').btc_relative;
  assert.equal(b.status, 'computed');
  close(b.cost_btc, 0.02);
  close(b.proceeds_btc, 0.02);
  close(b.current_btc, 0.01);
  close(b.result_btc, 0.01);
  pf.addTransactions(ws, [{ type: 'buy', date: '2026-09-01', account_id: 'ex', asset_id: 'example-payfi-fictional', quantity: 10, price_usd: 2 }]);
  const out2 = pf.computePortfolio(ws, { market: market({ 'example-payfi-fictional': 2, bitcoin: 100000 }), now: NOW });
  assert.equal(pos(out2, 'example-payfi-fictional').btc_relative.status, 'incomplete');
});

test('cash settlement, limits flags and stablecoin exposure', (t) => {
  const { ws, cleanup } = setup('cash');
  t.after(cleanup);
  pf.addTransactions(ws, [
    { type: 'deposit_cash', date: '2026-07-01', account_id: 'ex', asset_id: 'usd', quantity: 1000 },
    { type: 'buy', date: '2026-07-02', account_id: 'ex', asset_id: 'example-payfi-fictional', quantity: 500, price_usd: 1, settle_cash: true },
  ]);
  pf.setLimits(ws, { speculative_capital_cap_usd: 400, max_position_pct: 30 });
  const out = pf.computePortfolio(ws, { market: market({ 'example-payfi-fictional': 1 }), now: NOW });
  close(pos(out, 'usd').quantity, 500);
  close(out.totals.cash_stable_pct, 50);
  assert.ok(out.limits.flags.some((f) => f.kind === 'cap'));
  assert.ok(out.limits.flags.some((f) => f.kind === 'position'));
});

test('duplicate CSV rows are skipped and secrets are refused', (t) => {
  const { ws, cleanup } = tempWorkspace('csv');
  t.after(cleanup);
  addFixtureProject(ws);
  pf.addAccount(ws, { account_id: 'demo-exchange', name: 'Demo exchange' });
  pf.addAccount(ws, { account_id: 'demo-wallet', name: 'Demo wallet' });
  const csv = fs.readFileSync(path.join(FIXTURES, 'portfolio', 'fictional-transactions.csv'), 'utf8');
  const first = pf.importCsv(ws, csv, { filename: 'f.csv' });
  assert.equal(first.added.length, 8);
  const second = pf.importCsv(ws, csv, { filename: 'f.csv' });
  assert.equal(second.added.length, 0);
  // Rows with an external ID come back as unchanged retries; rows without one are held as possible re-imports.
  assert.equal(second.duplicates.length + second.unchanged.length, 8);
  assert.throws(() => pf.addAccount(ws, { name: 'bad', public_address: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' }), /seed phrase/);
  assert.throws(() => pf.addTransactions(ws, [{ type: 'buy', date: '2026-07-01', account_id: 'demo-exchange', asset_id: 'not-a-known-asset', quantity: 1, price_usd: 1 }]), /unknown asset/);
});
