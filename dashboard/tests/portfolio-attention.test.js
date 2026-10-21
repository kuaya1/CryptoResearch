'use strict';
// Portfolio's "Needs attention" (2026-10-21): the rail's count and the tab
// count one per row the page shows (the notes of imported wallet activity are
// one row together), and those notes can be accepted as unknown in one click:
// recorded once, append-only, with nothing priced, estimated or recorded in
// the ledger, and a later note comes back. FICTIONAL workspace only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { tempWorkspace, addFixtureProject } = require('./helpers');
const portfolio = require('../core/portfolio');
const { buildIndex } = require('../core/indexer');

function desk(t) {
  const d = tempWorkspace('pf-attention');
  t.after(d.cleanup);
  addFixtureProject(d.ws);
  portfolio.addAccount(d.ws, { account_id: 'wallet-a', name: 'Wallet A', kind: 'self_custody' });
  const imp = (rows) => portfolio.addTransactions(d.ws, rows.map((r) => ({ account_id: 'wallet-a', asset_id: 'example-payfi-fictional', ...r })), { source: 'wallet_sync' });
  imp([{ type: 'transfer_in', quantity: '5', date: '2026-10-01' }, { type: 'transfer_in', quantity: '7', date: '2026-10-02' }, { type: 'transfer_out', quantity: '1', date: '2026-10-03' }]);
  return { ...d, imp };
}

let tmp;
const model = (async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pf-model-'));
  fs.cpSync(path.join(__dirname, '..', 'public'), tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{ "type": "module" }');
  return import(pathToFileURL(path.join(tmp, 'portfolio-model.js')).href);
})();
test.after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test('needs attention counts rows: the wallet-import notes are one row, a manual warning its own', async (t) => {
  const m = await model;
  const d = desk(t);
  let idx = buildIndex(d.ws);
  assert.equal(idx.portfolio.warnings.filter(m.isWalletNote).length, 3);
  assert.equal(m.needsCount(idx), 1, 'three wallet-import notes are one row');
  // A purchase recorded by hand without a price is its own row.
  portfolio.addTransactions(d.ws, [{ type: 'buy', account_id: 'wallet-a', asset_id: 'example-payfi-fictional', quantity: '2', date: '2026-10-04' }], { source: 'manual' });
  idx = buildIndex(d.ws);
  assert.equal(m.needsCount(idx), 2);
});

test('accept as unknown: the notes shown leave Needs attention; nothing in the ledger changes; a later note comes back', async (t) => {
  const m = await model;
  const d = desk(t);
  const before = portfolio.computePortfolio(d.ws, { market: { assets: {} } });
  const txBefore = fs.readFileSync(path.join(d.root, 'portfolio', 'transactions.json'));
  const keys = before.warnings.filter(m.isWalletNote).map(m.warningKey);
  assert.throws(() => portfolio.acceptUnknown(d.ws, { keys: [...keys, 'external_deposit:tx_not_shown:x'] }), /not a current wallet-import note/, 'only notes shown now');
  const out = portfolio.acceptUnknown(d.ws, { keys, note: 'FICTIONAL airdrops', request_id: 'req_accept_1' });
  assert.equal(out.status, 'saved');
  assert.equal(out.accepted, 3);
  assert.equal(out.verified, true);
  // The same request again, or the same notes again: unchanged.
  assert.equal(portfolio.acceptUnknown(d.ws, { keys, request_id: 'req_accept_1' }).status, 'unchanged');
  assert.equal(portfolio.acceptUnknown(d.ws, { keys, request_id: 'req_accept_2' }).status, 'unchanged');
  assert.ok(fs.readFileSync(path.join(d.root, 'portfolio', 'transactions.json')).equals(txBefore), 'the ledger is untouched');
  const after = portfolio.computePortfolio(d.ws, { market: { assets: {} } });
  assert.deepEqual(after.positions, before.positions, 'positions and cost basis unchanged');
  assert.equal(after.warnings.length, before.warnings.length, 'the warnings are still computed');
  let idx = buildIndex(d.ws);
  assert.equal(idx.portfolio.acknowledged.count, 3);
  assert.equal(m.needsCount(idx), 0);
  assert.equal(m.openWarnings(idx.portfolio).length, 0);
  // A wallet import that arrives later comes back.
  d.imp([{ type: 'transfer_in', quantity: '3', date: '2026-10-05' }]);
  idx = buildIndex(d.ws);
  assert.equal(m.openWarnings(idx.portfolio).length, 1);
  assert.equal(m.needsCount(idx), 1);
  const lines = fs.readFileSync(path.join(d.root, 'portfolio', 'acknowledgments.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'accepted_unknown');
  assert.match(lines[0].meaning, /nothing was priced, estimated or recorded in the ledger/);
});
