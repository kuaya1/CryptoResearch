'use strict';
// "Set cost" (item 27): units that arrived with an unknown cost get Eric's
// own average cost through the standard correction, and the portfolio read
// then gives the unrealized result and the distance to the invalidation price
// of the ticket in force. Fictional TEST workspace and holdings only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { tempWorkspace, addFixtureProject } = require('./helpers');
const pf = require('../core/portfolio');
const PB = require('../core/position-brief');
const T = require('../core/tickets');

const NOW = Date.parse('2026-10-01T14:00:00Z');
const ASSET = 'example-payfi-fictional';
const market = (price) => ({ provider: 'test', assets: { [ASSET]: { id: ASSET, price_usd: price, source_last_updated_at: '2026-10-01T13:55:00Z', fetched_at: '2026-10-01T13:55:00Z' } } });

function setup(t) {
  const w = tempWorkspace('pf-setcost');
  t.after(w.cleanup);
  addFixtureProject(w.ws);
  pf.addAccount(w.ws, { account_id: 'wallet', name: 'Wallet (FICTIONAL)', kind: 'self_custody' });
  const add = pf.addTransactions(w.ws, [{ type: 'transfer_in', date: '2026-09-20', account_id: 'wallet', asset_id: ASSET, quantity: 10, note: 'first balance read' }], { source: 'dashboard' });
  return { ...w, txId: add.added[0] };
}
const position = (ws, price) => pf.computePortfolio(ws, { market: market(price), now: NOW }).positions.find((p) => p.asset_id === ASSET);

test('set cost: a position of unknown cost stays unknown, never zero, and has no result', (t) => {
  const { ws } = setup(t);
  const p = position(ws, 2);
  assert.equal(p.cost_basis_status, 'unknown');
  const b = PB.pnlOf(p);
  assert.equal(b.status, 'cost_unknown');
  assert.equal(b.unrealized_usd, null);
  assert.match(b.words, /Cost unknown/);
});

test('set cost: corrects the arrival the standard way, keeps the original voided with the reason, and gives the result', (t) => {
  const { ws, txId } = setup(t);
  assert.throws(() => pf.setCost(ws, { asset_id: ASSET, account_id: 'wallet' }), /average cost/);
  assert.throws(() => pf.setCost(ws, { asset_id: ASSET, account_id: 'wallet', avg_cost_usd: '-1' }), /negative/);
  assert.throws(() => pf.setCost(ws, { asset_id: ASSET, account_id: 'wallet', avg_cost_usd: '1', acquired_at: 'soon' }), /not a date/);
  assert.equal(pf.loadTransactions(ws).length, 1, 'a refused call writes nothing');

  const r = pf.setCost(ws, { asset_id: ASSET, account_id: 'wallet', avg_cost_usd: '1.5', acquired_at: '2026-09-18', reason: 'my own records' });
  assert.equal(r.status, 'cost_set');
  assert.equal(r.verified, true);
  const all = pf.loadTransactions(ws);
  assert.equal(all.length, 2);
  const old = all.find((x) => x.tx_id === txId);
  const neu = all.find((x) => x.tx_id === r.added);
  assert.equal(old.voided, true);
  assert.equal(old.void_reason, 'Corrected: my own records');
  assert.equal(old.corrected_by, neu.tx_id);
  assert.equal(neu.corrects, txId);
  assert.equal(neu.source, 'correction');
  assert.equal(Number(neu.price_usd), 1.5);
  assert.equal(neu.date, '2026-09-18');
  assert.equal(Number(neu.quantity), 10);

  const p = position(ws, 2);
  assert.equal(p.cost_basis_status, 'known');
  const b = PB.pnlOf(p);
  assert.equal(b.status, 'known');
  assert.ok(Math.abs(b.unrealized_usd - 5) < 1e-9, 'value 20 less cost 15');
  assert.throws(() => pf.setCost(ws, { asset_id: ASSET, account_id: 'wallet', avg_cost_usd: '2' }), /No entry/, 'nothing left with an unknown cost');
});

test('set cost: two entries of unknown cost need a named one', (t) => {
  const { ws, txId } = setup(t);
  const second = pf.addTransactions(ws, [{ type: 'transfer_in', date: '2026-09-25', account_id: 'wallet', asset_id: ASSET, quantity: 5 }], { source: 'dashboard' }).added[0];
  assert.throws(() => pf.setCost(ws, { asset_id: ASSET, account_id: 'wallet', avg_cost_usd: '1' }), /Name one with tx_id/);
  assert.throws(() => pf.setCost(ws, { asset_id: ASSET, account_id: 'wallet', avg_cost_usd: '1', tx_id: 'nope' }), /not an active entry/);
  const r = pf.setCost(ws, { asset_id: ASSET, account_id: 'wallet', avg_cost_usd: '1', tx_id: second });
  assert.equal(r.status, 'cost_set');
  assert.equal(position(ws, 2).cost_basis_status, 'partial');
  assert.match(PB.pnlOf(position(ws, 2)).words, /known cost only/);
  assert.ok(pf.loadTransactions(ws).find((x) => x.tx_id === txId && !x.voided), 'the other entry is untouched');
});

test('invalidation distance: uses the ticket in force and the stored price with its time; says when there is none', (t) => {
  const { ws } = setup(t);
  const p = position(ws, 2);
  const real = T.view;
  t.after(() => { T.view = real; });
  const stub = (ticket) => { T.view = () => ({ ticket }); };

  stub(null);
  assert.equal(PB.distanceOf(ws, p, { now: NOW }).status, 'no_ticket');
  stub({ desk_gate: true });
  assert.equal(PB.distanceOf(ws, p, { now: NOW }).status, 'no_ticket');
  stub({ receipt_id: 'tr_x', status: 'pending_pm_review', invalidation_trigger: { price_usd: null }, decision: null });
  assert.equal(PB.distanceOf(ws, p, { now: NOW }).status, 'no_trigger');
  stub({ receipt_id: 'tr_x', status: 'pending_pm_review', invalidation_trigger: { price_usd: 1.5 }, decision: { action: 'veto' } });
  assert.equal(PB.distanceOf(ws, p, { now: NOW }).status, 'no_ticket');

  stub({ receipt_id: 'tr_x', status: 'pending_pm_review', invalidation_trigger: { price_usd: 1.5 }, decision: null });
  const d = PB.distanceOf(ws, p, { now: NOW });
  assert.equal(d.status, 'measured');
  assert.equal(d.distance_pct, 25);
  assert.equal(d.price_usd, 2);
  assert.equal(d.price_as_of, '2026-10-01T13:55:00Z');
  assert.match(d.words, /25\.00% above the invalidation price \$1\.5/);

  stub({ receipt_id: 'tr_x', status: 'invalidated', invalidation_trigger: { price_usd: 1.5 }, invalidation: { words: 'Price reached $1.4.' }, decision: null });
  assert.equal(PB.distanceOf(ws, p, { now: NOW }).status, 'invalidated');
});

test('describe: reads and writes nothing; a position with no stored price says so', (t) => {
  const { ws } = setup(t);
  const before = JSON.stringify(pf.loadTransactions(ws));
  const out = PB.describe(ws, pf.computePortfolio(ws, { market: { provider: 'test', assets: {} }, now: NOW }), { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].pnl.status, 'cost_unknown');
  assert.equal(JSON.stringify(pf.loadTransactions(ws)), before);
});
