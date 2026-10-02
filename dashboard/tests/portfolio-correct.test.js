'use strict';
// Correcting a recorded transaction from the phone: one verified save voids
// the old entry (kept, with the reason and a pointer) and adds the corrected
// one. Fictional TEST workspace and holdings only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { tempWorkspace, addFixtureProject } = require('./helpers');
const portfolio = require('../core/portfolio');

test('portfolio: a correction voids the old entry and records the new one together; nothing is edited in place', (t) => {
  const { ws, cleanup } = tempWorkspace('pf-correct');
  t.after(cleanup);
  addFixtureProject(ws);
  portfolio.addAccount(ws, { name: 'Test Exchange (FICTIONAL)', kind: 'exchange' });
  const acct = portfolio.loadAccounts(ws)[0].account_id;
  const add = portfolio.addTransactions(ws, [{ type: 'buy', date: '2026-09-01', account_id: acct, asset_id: 'example-payfi-fictional', quantity: '100', price_usd: '0.5', note: 'first fill' }], { source: 'dashboard' });
  const id = add.added[0];

  assert.throws(() => portfolio.correctTransaction(ws, id, { type: 'buy', date: '2026-09-01', account_id: acct, asset_id: 'example-payfi-fictional', quantity: '120' }, ''), /needs a reason/);
  assert.throws(() => portfolio.correctTransaction(ws, id, { type: 'buy', date: '2026-09-01', account_id: acct, asset_id: 'example-payfi-fictional', quantity: '100', price_usd: '0.5', note: 'first fill' }, 'no change'), /same as the current one/);
  assert.throws(() => portfolio.correctTransaction(ws, id, { type: 'buy', date: '2026-09-01', account_id: acct, asset_id: 'example-payfi-fictional', quantity: '-1' }, 'typo'), /quantity must be positive/);
  assert.equal(portfolio.loadTransactions(ws).filter((x) => x.voided).length, 0, 'a rejected correction changes nothing');

  const fix = portfolio.correctTransaction(ws, id, { type: 'buy', date: '2026-09-01', account_id: acct, asset_id: 'example-payfi-fictional', quantity: '120', price_usd: '0.5', note: 'first fill' }, 'wrong quantity');
  assert.equal(fix.status, 'corrected');
  assert.equal(fix.verified, true);
  const all = portfolio.loadTransactions(ws);
  assert.equal(all.length, 2, 'the old entry is kept');
  const old = all.find((x) => x.tx_id === id);
  const neu = all.find((x) => x.tx_id === fix.added);
  assert.equal(old.voided, true);
  assert.equal(old.void_reason, 'Corrected: wrong quantity');
  assert.equal(old.corrected_by, neu.tx_id);
  assert.equal(neu.corrects, id);
  assert.equal(neu.voided, false);
  assert.equal(Number(neu.quantity), 120);
  assert.equal(neu.source, 'correction');
  assert.throws(() => portfolio.correctTransaction(ws, id, { type: 'buy', date: '2026-09-01', account_id: acct, asset_id: 'example-payfi-fictional', quantity: '130' }, 'again'), /already voided \(corrected by/);
});
