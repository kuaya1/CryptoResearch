'use strict';
// The Portfolio page's reading rules, tested on the browser modules: records
// that need attention read as rows (never a raw ID or a full-precision dump),
// amounts round for reading and keep their exact value, and the wallet
// balance sheet folds unverified tokens away.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

let tmp;
async function load() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-portfolio-view-'));
  fs.cpSync(path.join(__dirname, '..', 'public'), tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{ "type": "module" }');
  const ui = await import(pathToFileURL(path.join(tmp, 'ui.js')).href);
  const portfolio = await import(pathToFileURL(path.join(tmp, 'views', 'portfolio.js')).href);
  const wallets = await import(pathToFileURL(path.join(tmp, 'views', 'wallets.js')).href);
  return { ui, portfolio, wallets };
}
const mods = load();
test.after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test('amounts: two decimals from 1,000, four below, four significant under 1; a minus sign, no trailing zeros', async () => {
  const { ui } = await mods;
  assert.equal(ui.fmtAmount('3383.859022'), '3,383.86');
  assert.equal(ui.fmtAmount('1.25491'), '1.2549');
  assert.equal(ui.fmtAmount('0.0523149'), '0.05231');
  assert.equal(ui.fmtAmount('2.5000'), '2.5');
  assert.equal(ui.fmtAmount('0'), '0');
  assert.equal(ui.fmtAmount('-12.5'), '−12.5');
  assert.equal(ui.fmtAmount(null), '—');
});

test('short IDs: a hash keeps its start and end, a ledger ID its last part', async () => {
  const { ui } = await mods;
  assert.equal(ui.shortId('0x9f2c4b7e1a3d5f60718293a4b5c6d7e8f9012345'), '0x9f2c…2345');
  assert.equal(ui.shortId('tx_2026-10-07T174355Z_riztvc'), '…riztvc');
  assert.equal(ui.shortId('0x12'), '0x12', 'a short hex value stays whole');
});

const shortfall = { kind: 'shortfall', tx_id: 'tx_2026-10-07T174355Z_riztvc', asset_id: 'zama-fictional', account_id: 'ex', quantity: '3383.859022', tx_quantity: '3400', tx_type: 'sell', date: '2026-10-07T17:43:55Z', message: 'tx_2026-10-07T174355Z_riztvc: 3383.859022 zama-fictional more than recorded in ex. Earlier purchases are probably missing; the missing units are treated as unknown cost.' };

test('attention: a shortfall reads as words with a rounded amount, keeps the exact one, and offers to record the purchase', async () => {
  const { portfolio } = await mods;
  const [r] = portfolio.attentionRows([shortfall], { symbols: new Map([['zama-fictional', 'ZAMA']]), accounts: new Map([['ex', 'Exchange']]) });
  assert.equal(r.what, '3,383.86 ZAMA more than recorded');
  assert.equal(r.exact, '3383.859022');
  assert.equal(r.tone, 'warn');
  assert.equal(r.action, 'record-purchase');
  assert.deepEqual(r.account, { id: 'ex', name: 'Exchange' });
  assert.equal(r.message, shortfall.message, 'the full sentence stays as the tooltip');
  assert.doesNotMatch(`${r.what} ${r.detail}`, /tx_|\d{5,}/, 'no raw ID and no full-precision figure in the words');
});

test('attention: quarantines first, wallet notes as one row, an unknown kind without its raw ID', async () => {
  const { portfolio } = await mods;
  const rows = portfolio.attentionRows([
    { kind: 'unknown_basis', tx_id: 'tx_a_1', asset_id: 'x', tx_quantity: '5', date: '2026-10-05', message: 'tx_a_1: purchase price unknown, so cost basis is unknown.' },
    { kind: 'transfer_quarantined', tx_id: 'tx_b_2', asset_id: 'x', date: '2026-10-01', message: 'tx_b_2: arrival cannot be matched.' },
    { kind: 'external_deposit', tx_id: 'tx_c_3', source: 'wallet_sync', account_id: 'w1', date: '2026-10-02', message: 'tx_c_3: deposit from outside your recorded accounts; cost basis unknown.' },
    { kind: 'external_transfer_out', tx_id: 'tx_d_4', source: 'wallet_sync', account_id: 'w1', date: '2026-10-06', message: 'tx_d_4: sent outside your recorded accounts (no transfer_id).' },
    { kind: 'something_new', tx_id: 'tx_e_5', message: 'tx_e_5: a new kind of note.' },
  ]);
  assert.deepEqual(rows.map((r) => r.kind), ['transfer_quarantined', 'unknown_basis', 'something_new', 'wallet_imports']);
  assert.equal(rows[0].tone, 'bad');
  assert.equal(rows[1].amount.text, '5 X', 'the transaction\'s amount beside the words');
  assert.equal(rows[2].what, 'a new kind of note.');
  const w = rows[3];
  assert.equal(w.count, 2);
  assert.match(w.what, /^2 wallet imports/);
  assert.equal(w.date_from, '2026-10-02');
  assert.equal(w.date, '2026-10-06');
  assert.equal(w.action, 'transactions');
});

test('wallet balance sheet: verified tokens and the network coin first, unverified tokens folded', async () => {
  const { wallets } = await mods;
  const { main, unverified } = wallets.holdingGroups([
    { key: 'a', verified: true, symbol: 'ETH' },
    { key: 'b', verified: false, symbol: 'AIRDROP' },
    { key: 'c', verified: true, symbol: 'ZAMA' },
  ]);
  assert.deepEqual(main.map((r) => r.key), ['a', 'c']);
  assert.deepEqual(unverified.map((r) => r.key), ['b']);
});

test('static: the Portfolio keeps sentence-case labels and draws no card shadow', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const part = css.slice(css.indexOf('/* Tracked wallets (views/wallets.js) as a balance sheet'));
  assert.ok(part.length > 1000, 'the balance sheet and Portfolio rules exist');
  assert.doesNotMatch(part, /text-transform:\s*uppercase/);
  assert.doesNotMatch(part.replace(/box-shadow: 1px 0 0 var\(--separator\), 0 1px 0 var\(--separator\)/g, ''), /box-shadow:\s*(?!none)[^;]*rgba/, 'hairlines only, no elevation');
});
