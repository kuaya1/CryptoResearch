'use strict';
// Read-only wallet sync (core/moralis.js, core/wallets.js, core/walletsync.js).
// Every Moralis answer comes from a stub "chain" with FICTIONAL addresses,
// contracts, hashes and amounts; global fetch is replaced by one that fails,
// so nothing is ever sent anywhere. The sync clock is fixed; block times are
// in the past so the ledger accepts them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tempWorkspace, hashTree } = require('./helpers');
const wallets = require('../core/wallets');
const walletsync = require('../core/walletsync');
const moralis = require('../core/moralis');
const portfolio = require('../core/portfolio');
const projects = require('../core/projects');
const jobs = require('../core/jobs');
const { buildIndex } = require('../core/indexer');

const NOW = Date.parse('2026-10-01T12:00:00Z');
const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const FAST = { retryDelayMs: 0, pauseMs: 0 };
const KEY = 'moralis-test-key-FICTIONAL-7f3a9c1e5b';
const addr = (tag) => `0x${tag.padStart(40, '0')}`;
const A = addr('a11ce');
const B = addr('b0b');
const EXT = addr('e47e47');
const ROUTER = addr('7007e7');
const TOKEN = addr('fc0001');
const OTHER = addr('fc0002');
const SPAM = addr('5a5a5a');
const MYST = addr('3a3a3a');
const GOOD = addr('600d');
const iso = (ms) => new Date(ms).toISOString();
const hash = (n) => `0x${String(n).padStart(64, '0')}`;
const FEE = '0.000420000000000001';

function setup(t, label, settings = {}) {
  const { ws, root, cleanup } = tempWorkspace(label, { wallet_sync: settings });
  t.after(cleanup);
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network access is not allowed in tests');
  });
  const prev = process.env.MORALIS_API_KEY;
  process.env.MORALIS_API_KEY = KEY;
  t.after(() => {
    if (prev === undefined) delete process.env.MORALIS_API_KEY;
    else process.env.MORALIS_API_KEY = prev;
  });
  return { ws, root };
}

function addToken(ws, { symbol = 'XTKN', contract = TOKEN, chain = 'ethereum' } = {}) {
  const host = `${symbol.toLowerCase()}.example`;
  const out = projects.addProject(ws, {
    name: `Example ${symbol} (FICTIONAL)`,
    symbol,
    official_website: `https://${host}/`,
    coingecko_id: `${symbol.toLowerCase()}-fictional`,
    assets: [{ chain, contract_address: contract }],
    evidence: [{ url: `https://${host}/docs`, note: 'fictional test evidence' }],
    sector: 'defi',
  });
  assert.equal(out.status, 'created', out.message);
  return out.project_id;
}

const reply = (status, payload, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => (headers[String(k).toLowerCase()] === undefined ? null : headers[String(k).toLowerCase()]) },
  text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
});

// A fictional chain behind a stub Moralis: history newest first, paged by an
// offset cursor, filtered by from_date / to_date; balances paged the same way.
// fail(predicate, answer, times) answers matching requests differently.
function chain({ pageSize = 2 } = {}) {
  const data = new Map();
  const calls = [];
  const failures = [];
  const of = (address, net = 'eth') => {
    const k = `${address.toLowerCase()}|${net}`;
    if (!data.has(k)) data.set(k, { history: [], tokens: [], block: '1000' });
    return data.get(k);
  };
  const f = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, params: Object.fromEntries(u.searchParams), key: init.headers && init.headers['X-API-Key'] });
    for (const x of failures) {
      if (x.times > 0 && x.when(u)) {
        x.times--;
        if (x.answer instanceof Error) throw x.answer;
        return typeof x.answer === 'function' ? x.answer(u) : x.answer;
      }
    }
    const m = u.pathname.match(/^\/api\/v2\.2\/wallets\/(0x[0-9a-fA-F]{40})\/(history|tokens)$/);
    if (!m) return reply(404, { message: 'not found' });
    const d = of(m[1], u.searchParams.get('chain'));
    const offset = Number(String(u.searchParams.get('cursor') || 'c0').slice(1));
    if (m[2] === 'history') {
      const from = u.searchParams.get('from_date');
      const to = u.searchParams.get('to_date');
      const list = d.history
        .filter((x) => (!from || x.block_timestamp >= from) && (!to || x.block_timestamp <= to))
        .sort((a, b) => b.block_timestamp.localeCompare(a.block_timestamp) || b.hash.localeCompare(a.hash));
      const page = list.slice(offset, offset + pageSize);
      return reply(200, { cursor: offset + pageSize < list.length ? `c${offset + pageSize}` : null, page: offset / pageSize, page_size: pageSize, result: page });
    }
    const page = d.tokens.slice(offset, offset + pageSize);
    return reply(200, { cursor: offset + pageSize < d.tokens.length ? `c${offset + pageSize}` : null, page: offset / pageSize, page_size: pageSize, block_number: d.block, result: page });
  };
  f.calls = calls;
  f.of = of;
  f.fail = (when, answer, times = 1) => failures.push({ when, answer, times });
  f.history = (address, net = 'eth') => of(address, net).history;
  f.setTokens = (address, rows, net = 'eth') => { of(address, net).tokens = rows; };
  return f;
}

let blockSeq = 100;
function tx({ n, at, from, to = null, category, status = '1', fee = FEE, native = [], tokens = [], spam = false, block = null }) {
  const b = block === null ? blockSeq++ : block;
  return { hash: hash(n), nonce: '1', transaction_index: '0', from_address: from, to_address: to, value: '0', gas_price: '1000000000', receipt_gas_used: '21000', receipt_status: status, block_timestamp: iso(at), block_number: String(b), block_hash: hash(`b${b}`.replace('b', '9')), transaction_fee: fee, category, summary: `${category} (fictional)`, possible_spam: spam, method_label: null, native_transfers: native, erc20_transfers: tokens, nft_transfers: [] };
}
const erc20 = ({ contract = TOKEN, from, to, value, decimals = 18, log = 0, symbol = 'XTKN', name = 'Example XTKN (FICTIONAL)', spam = false, verified = true }) => ({ token_name: name, token_symbol: symbol, token_logo: 'https://logo.example/x.png', token_decimals: String(decimals), value_formatted: 'ignored', address: contract, from_address: from, to_address: to, value: String(value), log_index: log, possible_spam: spam, verified_contract: verified });
const nat = ({ from, to, value, internal = false }) => ({ from_address: from, to_address: to, value: String(value), value_formatted: 'ignored', direction: 'ignored', internal_transaction: internal, token_symbol: 'ETH' });
const bal = ({ contract = null, native = false, balance, decimals = 18, symbol = 'XTKN', name = 'Example XTKN (FICTIONAL)', spam = false, verified = true, price = null }) => ({ token_address: native ? '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' : contract, symbol: native ? 'ETH' : symbol, name: native ? 'Ether' : name, logo: 'https://logo.example/y.png', decimals, balance: String(balance), possible_spam: spam, verified_contract: verified, usd_price: price, native_token: native });
const wei = (eth) => {
  const [i, f = ''] = String(eth).split('.');
  return (BigInt(i) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18))).toString();
};

const marketAt = (prices, at = NOW) => ({ assets: Object.fromEntries(Object.entries(prices).map(([id, p]) => [id, { price_usd: p, fetched_at: iso(at), source_last_updated_at: iso(at) }])) });
const sync = (ws, f, extra = {}) => walletsync.refresh(ws, { fetchImpl: f, force: true, now: NOW, ...FAST, ...extra });
const ledger = (ws) => portfolio.loadTransactions(ws);
const position = (ws, assetId) => portfolio.computePortfolio(ws, { market: { assets: {} } }).positions.find((p) => p.asset_id === assetId) || null;
const accountQty = (ws, account, assetId) => {
  const p = position(ws, assetId);
  const a = p && p.by_account.find((x) => x.account_id === account);
  return a ? a.quantity_exact : '0';
};

// ---------------------------------------------------------------------------

test('adding a wallet: a public address and chosen networks only; no holding is created', (t) => {
  const { ws } = setup(t, 'wl-add');
  const seed = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  assert.throws(() => wallets.addWallet(ws, { label: 'MetaMask', address: seed, networks: ['eth'] }), (e) => e.code === 'REFUSED' && /seed phrase/.test(e.message));
  assert.throws(() => wallets.addWallet(ws, { label: 'MetaMask', address: `0x${'ab'.repeat(32)}`, networks: ['eth'] }), (e) => e.code === 'REFUSED' && /private key/.test(e.message));
  assert.throws(() => wallets.addWallet(ws, { label: 'MetaMask', address: 'eric.eth', networks: ['eth'] }), (e) => e.code === 'INVALID');
  assert.throws(() => wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: [] }), (e) => e.code === 'INVALID' && /at least one network/.test(e.message));
  assert.throws(() => wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['solana'] }), (e) => e.code === 'INVALID');
  const out = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth', 'base'] });
  assert.equal(out.status, 'saved');
  assert.match(out.wallet_id, wallets.WALLET_ID_RE);
  assert.ok(!out.wallet_id.includes('a11ce'), 'the wallet ID is not derived from the address');
  const acct = portfolio.loadAccounts(ws).find((a) => a.account_id === out.account_id);
  assert.equal(acct.kind, 'self_custody');
  assert.ok(portfolio.assetRegistry(ws).has('ethereum'), 'the native coin became a reference asset');
  assert.equal(ledger(ws).length, 0, 'adding a wallet records no transaction');
  assert.equal(wallets.addWallet(ws, { label: 'Again', address: A.toUpperCase().replace('0X', '0x'), networks: ['eth'] }).status, 'exists');
  // Nothing is read until a sync runs.
  assert.equal(globalThis.fetch.mock.calls.length, 0);
});

test('first sync with no history: balances are observed, nothing is recorded, acquisition cost unknown', async (t) => {
  const { ws } = setup(t, 'wl-first');
  addToken(ws);
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const f = chain();
  f.setTokens(A, [bal({ native: true, balance: wei('1.5') }), bal({ contract: TOKEN, balance: wei('1000') })]);
  const r = await sync(ws, f);
  assert.equal(r.status, 'ok', r.message);
  assert.ok(f.calls.every((c) => c.key === KEY));
  assert.equal(ledger(ws).length, 0, 'a first balance snapshot is never a purchase');
  const o = wallets.overview(ws, { market: marketAt({ 'xtkn-fictional': 0.5, ethereum: 2000 }), now: NOW });
  const x = o.holdings.find((h) => h.asset_id === 'xtkn-fictional');
  assert.equal(x.quantity, '1000');
  assert.equal(x.value_usd, 500);
  assert.equal(x.acquisition.status, 'unknown');
  assert.equal(x.reconciliation.status, 'mismatch', 'observed but not in the ledger stays a visible difference');
  assert.equal(o.holdings.find((h) => h.native).quantity, '1.5');
  assert.ok(o.summary.mismatches >= 1);
  const pf = portfolio.computePortfolio(ws, { market: { assets: {} } });
  assert.equal(pf.positions.length, 0);
  assert.ok(wallets.attentionItems(ws, { pf, now: NOW }).some((a) => a.kind === 'wallet_mismatch'));
  assert.equal(w.status, 'saved');
});

test('buy, partial sale, full sale and transfer: ledger entries from swaps and transfers, exact to the wei', async (t) => {
  const { ws } = setup(t, 'wl-cycle');
  addToken(ws);
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const f = chain({ pageSize: 2 });
  const h = f.history(A);
  h.push(tx({ n: 1, at: NOW - 30 * DAY, from: EXT, to: A, category: 'receive', native: [nat({ from: EXT, to: A, value: wei('1') })] }));
  h.push(tx({ n: 2, at: NOW - 20 * DAY, from: A, to: ROUTER, category: 'token swap', native: [nat({ from: A, to: ROUTER, value: wei('0.2') })], tokens: [erc20({ from: ROUTER, to: A, value: wei('500'), log: 3 })] }));
  h.push(tx({ n: 3, at: NOW - 10 * DAY, from: A, to: ROUTER, category: 'token swap', native: [nat({ from: ROUTER, to: A, value: wei('0.1'), internal: true })], tokens: [erc20({ from: A, to: ROUTER, value: wei('200'), log: 1 })] }));
  h.push(tx({ n: 4, at: NOW - 5 * DAY, from: A, to: ROUTER, category: 'token swap', native: [nat({ from: ROUTER, to: A, value: wei('0.15'), internal: true })], tokens: [erc20({ from: A, to: ROUTER, value: wei('300'), log: 7 })] }));
  h.push(tx({ n: 5, at: NOW - 2 * DAY, from: A, to: EXT, category: 'send', native: [nat({ from: A, to: EXT, value: wei('0.05') })] }));
  // 1 - 0.2 + 0.1 + 0.15 - 0.05 - 4 fees
  const ethLeft = '0.998319999999999996';
  f.setTokens(A, [bal({ native: true, balance: wei(ethLeft) })]);
  const r = await sync(ws, f);
  assert.equal(r.status, 'ok', r.message);
  const txs = ledger(ws);
  assert.deepEqual(txs.map((x) => x.type).sort(), ['buy', 'buy', 'buy', 'fee', 'fee', 'fee', 'fee', 'sell', 'sell', 'sell', 'transfer_in', 'transfer_out'].sort());
  assert.ok(txs.every((x) => x.source === 'wallet_sync' && x.price_usd === null), 'prices are never invented');
  assert.ok(txs.every((x) => x.provenance && x.provenance.tx_hash && x.provenance.event_key), 'every entry names its chain reference');
  assert.equal(accountQty(ws, w.account_id, 'xtkn-fictional'), '0', 'bought 500, sold 200 then 300');
  const xtkn = position(ws, 'xtkn-fictional');
  assert.equal(xtkn.closed, true);
  assert.equal(xtkn.realized_unknown_quantity, 500, 'sale prices unknown: no profit is invented');
  assert.equal(accountQty(ws, w.account_id, 'ethereum'), ethLeft);
  const recon = wallets.reconcileAll(ws, { pf: portfolio.computePortfolio(ws, { market: { assets: {} } }) });
  assert.equal(recon.find((x) => x.asset_id === 'ethereum').status, 'matches');
});

test('repeated syncs and duplicate items record nothing twice; multiple transfers in one transaction are separate events', async (t) => {
  const { ws } = setup(t, 'wl-dupe');
  addToken(ws);
  addToken(ws, { symbol: 'OTKN', contract: OTHER });
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const f = chain({ pageSize: 2 });
  const batch = tx({ n: 11, at: NOW - 3 * DAY, from: EXT, to: A, category: 'token receive', native: [nat({ from: EXT, to: A, value: wei('0.3') })], tokens: [erc20({ from: EXT, to: A, value: wei('10'), log: 4 }), erc20({ from: EXT, to: A, value: wei('10'), log: 5 }), erc20({ contract: OTHER, symbol: 'OTKN', from: EXT, to: A, value: '7', decimals: 0, log: 6 })] });
  f.history(A).push(batch, { ...batch }, tx({ n: 12, at: NOW - 2 * DAY, from: A, to: EXT, category: 'token send', tokens: [erc20({ from: A, to: EXT, value: wei('3'), log: 1 }), erc20({ from: A, to: ROUTER, value: wei('2'), log: 2 })] }));
  // 0.3 ETH in, less the fee of the send A paid for.
  f.setTokens(A, [bal({ native: true, balance: (BigInt(wei('0.3')) - BigInt(wei(FEE))).toString() }), bal({ contract: TOKEN, balance: wei('15') }), bal({ contract: OTHER, balance: '7', decimals: 0, symbol: 'OTKN' })]);
  await sync(ws, f);
  const events = wallets.loadEvents(ws, w.wallet_id, 'eth');
  const keys = events.map((e) => e.event_key);
  assert.equal(new Set(keys).size, keys.length, 'one event per leg');
  assert.equal(events.filter((e) => e.tx_hash === hash(11)).length, 4, 'two XTKN legs, one OTKN leg and one ETH leg');
  const first = ledger(ws).length;
  assert.equal(first, 4 + 2 + 1, '4 legs in, 2 legs out, 1 fee');
  // Repeat: same chain, later clock, and a restart in between (new module state).
  await sync(ws, f, { now: NOW + 15 * MIN });
  await sync(ws, f, { now: NOW + 30 * MIN });
  assert.equal(ledger(ws).length, first, 'nothing recorded twice');
  assert.equal(wallets.loadEvents(ws, w.wallet_id, 'eth').length, events.length);
  assert.equal(accountQty(ws, w.account_id, 'xtkn-fictional'), '15');
  assert.equal(accountQty(ws, w.account_id, 'otkn-fictional'), '7');
  const raw = JSON.parse(fs.readFileSync(ws.abs(wallets.rawRel(w.wallet_id, 'eth', iso(NOW - 3 * DAY).slice(0, 7))), 'utf8'));
  assert.equal(raw.items[hash(11)].length, 1, 'an unchanged provider item is kept once');
  const recon = wallets.reconcileAll(ws, { pf: portfolio.computePortfolio(ws, { market: { assets: {} } }) });
  assert.ok(recon.every((r) => r.status === 'matches'), JSON.stringify(recon));
});

test('an interrupted read resumes from its saved cursor; a partial read finalizes nothing', async (t) => {
  const { ws } = setup(t, 'wl-resume');
  addToken(ws);
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const f = chain({ pageSize: 2 });
  for (let i = 0; i < 5; i++) f.history(A).push(tx({ n: 20 + i, at: NOW - (10 - i) * DAY, from: EXT, to: A, category: 'token receive', tokens: [erc20({ from: EXT, to: A, value: wei('1'), log: 0 })] }));
  f.setTokens(A, [bal({ contract: TOKEN, balance: wei('5') })]);
  // The second history page fails twice (both attempts): an outage mid-read.
  f.fail((u) => u.pathname.endsWith('/history') && u.searchParams.get('cursor') === 'c2', new Error('connect ECONNRESET https://deep-index.moralis.io/...'), 2);
  const r1 = await sync(ws, f);
  assert.equal(r1.status, 'failed');
  const st = walletsync.readState(ws).networks[`${w.wallet_id}:eth`];
  assert.equal(st.pass.cursor, 'c2', 'the cursor of the last good page is saved');
  assert.equal(wallets.loadEvents(ws, w.wallet_id, 'eth').length, 2, 'the first page was kept');
  assert.ok(wallets.loadEvents(ws, w.wallet_id, 'eth').every((e) => e.state === 'pending'), 'nothing is final after a partial read');
  assert.equal(ledger(ws).length, 0);
  assert.equal(st.last_success_at, undefined, 'a partial read is never a success');
  assert.ok(!/0x0+a11ce/i.test(JSON.stringify(walletsync.readState(ws))), 'no address in the status file');
  // A new run (as after a restart) continues at c2, not from the start.
  const before = f.calls.length;
  const r2 = await sync(ws, f, { now: NOW + 2 * MIN });
  assert.equal(r2.status, 'ok', r2.message);
  assert.equal(f.calls[before].params.cursor, 'c2');
  assert.equal(ledger(ws).length, 5);
  assert.equal(accountQty(ws, w.account_id, 'xtkn-fictional'), '5');
});

test('a transfer between two tracked wallets is one transfer, with its lots and acquisition date', async (t) => {
  const { ws } = setup(t, 'wl-internal');
  addToken(ws);
  const a = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const b = wallets.addWallet(ws, { label: 'Ledger', address: B, networks: ['eth'] });
  const f = chain();
  const recv = tx({ n: 30, at: NOW - 9 * DAY, from: EXT, to: A, category: 'token receive', tokens: [erc20({ from: EXT, to: A, value: wei('100'), log: 2 })] });
  const move = tx({ n: 31, at: NOW - 4 * DAY, from: A, to: TOKEN, category: 'token send', tokens: [erc20({ from: A, to: B, value: wei('60'), log: 9 })] });
  f.history(A).push(recv, move);
  f.history(B).push(JSON.parse(JSON.stringify(move)));
  f.setTokens(A, [bal({ contract: TOKEN, balance: wei('40') })]);
  f.setTokens(B, [bal({ contract: TOKEN, balance: wei('60') })]);
  // ETH for A's fee: received earlier.
  f.history(A).push(tx({ n: 29, at: NOW - 10 * DAY, from: EXT, to: A, category: 'receive', native: [nat({ from: EXT, to: A, value: wei('1') })] }));
  f.of(A).tokens.push(bal({ native: true, balance: (BigInt(wei('1')) - BigInt(wei(FEE))).toString() }));
  const r = await sync(ws, f);
  assert.equal(r.status, 'ok', r.message);
  const txs = ledger(ws).filter((x) => x.asset_id === 'xtkn-fictional');
  const outs = txs.filter((x) => x.type === 'transfer_out');
  const ins = txs.filter((x) => x.type === 'transfer_in' && x.transfer_id);
  assert.equal(outs.length, 1);
  assert.equal(ins.length, 1);
  assert.equal(outs[0].transfer_id, ins[0].transfer_id);
  assert.equal(outs[0].account_id, a.account_id);
  assert.equal(ins[0].account_id, b.account_id);
  const pf = portfolio.computePortfolio(ws, { market: { assets: {} } });
  assert.ok(!pf.warnings.some((x) => x.kind === 'external_deposit' && x.tx_id === ins[0].tx_id), 'not counted as a deposit from outside');
  assert.equal(accountQty(ws, b.account_id, 'xtkn-fictional'), '60');
  assert.equal(accountQty(ws, a.account_id, 'xtkn-fictional'), '40');
  // Both wallets' views point at the same two entries.
  const evB = wallets.loadEvents(ws, b.wallet_id, 'eth').find((e) => e.tx_hash === hash(31));
  assert.equal(evB.classification, 'internal_transfer');
  assert.equal(evB.ledger.status, 'recorded');
  assert.deepEqual([...evB.ledger.tx_ids].sort(), [outs[0].tx_id, ins[0].tx_id].sort());
  const recon = wallets.reconcileAll(ws, { pf });
  assert.ok(recon.filter((x) => x.asset_id === 'xtkn-fictional').every((x) => x.status === 'matches'), JSON.stringify(recon));
});

test('a failed transaction counts only its fee; a reorganized event is reversed, and voided if it was recorded', async (t) => {
  const { ws } = setup(t, 'wl-reorg');
  addToken(ws);
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const f = chain({ pageSize: 10 });
  const h = f.history(A);
  h.push(tx({ n: 40, at: NOW - 6 * DAY, from: EXT, to: A, category: 'receive', native: [nat({ from: EXT, to: A, value: wei('1') })] }));
  h.push(tx({ n: 41, at: NOW - 5 * DAY, from: EXT, to: A, category: 'token receive', tokens: [erc20({ from: EXT, to: A, value: wei('100'), log: 0 })] }));
  h.push(tx({ n: 42, at: NOW - 4 * DAY, from: A, to: TOKEN, status: '0', category: 'token send', tokens: [erc20({ from: A, to: EXT, value: wei('50'), log: 0 })] }));
  const late = tx({ n: 43, at: NOW - 60 * MIN, from: EXT, to: A, category: 'token receive', tokens: [erc20({ from: EXT, to: A, value: wei('7'), log: 1 })] });
  const fresh = tx({ n: 44, at: NOW - 5 * MIN, from: EXT, to: A, category: 'token receive', tokens: [erc20({ from: EXT, to: A, value: wei('3'), log: 1 })] });
  h.push(late, fresh);
  f.setTokens(A, [bal({ native: true, balance: (BigInt(wei('1')) - BigInt(wei(FEE))).toString() }), bal({ contract: TOKEN, balance: wei('110') })]);
  await sync(ws, f);
  let ev = wallets.loadEvents(ws, w.wallet_id, 'eth');
  const failed = ev.filter((e) => e.tx_hash === hash(42));
  assert.equal(failed.find((e) => e.kind === 'erc20').classification, 'failed_transfer');
  assert.equal(failed.find((e) => e.kind === 'erc20').ledger.status, 'not_recorded');
  assert.equal(failed.find((e) => e.kind === 'fee').ledger.status, 'recorded', 'the network fee of a failed transaction was paid');
  assert.equal(ev.find((e) => e.tx_hash === hash(44)).state, 'pending', 'too recent to be final');
  assert.equal(ev.find((e) => e.tx_hash === hash(43)).ledger.status, 'recorded');
  assert.equal(accountQty(ws, w.account_id, 'xtkn-fictional'), '107', 'final entries only: 100 + 7');
  // Both late transactions are reorganized away.
  h.splice(h.indexOf(late), 1);
  h.splice(h.indexOf(fresh), 1);
  f.setTokens(A, [bal({ native: true, balance: (BigInt(wei('1')) - BigInt(wei(FEE))).toString() }), bal({ contract: TOKEN, balance: wei('100') })]);
  await sync(ws, f, { now: NOW + 20 * MIN });
  ev = wallets.loadEvents(ws, w.wallet_id, 'eth');
  assert.equal(ev.find((e) => e.tx_hash === hash(44)).state, 'reverted');
  assert.equal(ev.find((e) => e.tx_hash === hash(44)).ledger.status, 'waiting', 'never recorded, nothing to void');
  const lateEv = ev.find((e) => e.tx_hash === hash(43));
  assert.equal(lateEv.state, 'reverted');
  assert.equal(lateEv.ledger.status, 'voided');
  const voided = ledger(ws).find((x) => lateEv.ledger.voided_tx_ids.includes(x.tx_id));
  assert.equal(voided.voided, true);
  assert.match(voided.void_reason, /reorganization/);
  assert.equal(accountQty(ws, w.account_id, 'xtkn-fictional'), '100');
  const pf = portfolio.computePortfolio(ws, { market: { assets: {} } });
  assert.ok(wallets.attentionItems(ws, { pf, now: NOW }).some((a) => a.kind === 'wallet_reversed'));
  // The same transaction mined again later: recorded afresh, under a new external ID.
  h.push({ ...late, block_number: '999', block_hash: hash(999), block_timestamp: iso(NOW - 10 * MIN) });
  f.setTokens(A, [bal({ native: true, balance: (BigInt(wei('1')) - BigInt(wei(FEE))).toString() }), bal({ contract: TOKEN, balance: wei('107') })]);
  await sync(ws, f, { now: NOW + 60 * MIN });
  assert.equal(accountQty(ws, w.account_id, 'xtkn-fictional'), '107');
  assert.equal(ledger(ws).filter((x) => !x.voided && x.asset_id === 'xtkn-fictional').length, 2);
});

test('spam, unverified tokens, a missing price and dust: kept out of the main list, inspectable, never recorded or researched', async (t) => {
  const { ws } = setup(t, 'wl-spam');
  addToken(ws);
  const projectsBefore = projects.listProjects(ws).length;
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const f = chain({ pageSize: 10 });
  const h = f.history(A);
  h.push(tx({ n: 50, at: NOW - 3 * DAY, from: EXT, to: A, category: 'airdrop', tokens: [erc20({ contract: SPAM, symbol: 'CLAIM', name: 'Visit claim-reward.example‮ now', from: EXT, to: A, value: wei('1000000'), spam: true })] }));
  h.push(tx({ n: 51, at: NOW - 3 * DAY, from: EXT, to: A, category: 'token receive', tokens: [erc20({ contract: MYST, symbol: 'MYST', name: 'Mystery', from: EXT, to: A, value: wei('5'), verified: false })] }));
  h.push(tx({ n: 52, at: NOW - 2 * DAY, from: A, to: ROUTER, category: 'token swap', tokens: [erc20({ from: A, to: ROUTER, value: wei('1'), log: 1 }), erc20({ contract: GOOD, symbol: 'GOOD', name: 'Good Token', from: ROUTER, to: A, value: '250000', decimals: 6, log: 2 })] }));
  h.push(tx({ n: 53, at: NOW - 9 * DAY, from: EXT, to: A, category: 'token receive', tokens: [erc20({ from: EXT, to: A, value: wei('1.000001'), log: 0 })] }));
  f.setTokens(A, [
    bal({ contract: SPAM, symbol: 'CLAIM', name: 'Visit claim-reward.example‮ now', balance: wei('1000000'), spam: true, price: 999 }),
    bal({ contract: MYST, symbol: 'MYST', name: 'Mystery', balance: wei('5'), verified: false }),
    bal({ contract: GOOD, symbol: 'GOOD', name: 'Good Token', balance: '250000', decimals: 6 }),
    bal({ contract: TOKEN, balance: wei('0.000001') }),
  ]);
  await sync(ws, f);
  const o = wallets.overview(ws, { market: marketAt({ 'xtkn-fictional': 0.5 }), now: NOW });
  const main = o.holdings.map((x) => x.symbol);
  assert.deepEqual(main, ['GOOD'], 'only the token this wallet swapped for stays in the main list');
  const good = o.holdings[0];
  assert.equal(good.verified, false);
  assert.equal(good.value_usd, null);
  assert.equal(good.price.usd, null, 'no desk price: "Price unavailable", never the provider\'s quote');
  assert.equal(good.acquisition.status, 'unknown');
  assert.equal(good.reconciliation.status, 'not_in_ledger');
  assert.equal(good.quantity, '0.25');
  const hid = new Map(o.hidden.map((x) => [x.reported.symbol || x.symbol, x.hidden]));
  assert.equal(hid.get('CLAIM'), 'spam');
  assert.equal(hid.get('MYST'), 'spam');
  assert.equal(hid.get('XTKN'), 'dust');
  const claim = o.hidden.find((x) => x.reported.symbol === 'CLAIM');
  assert.ok(!/[‮]/.test(claim.name), 'direction-override characters are removed from untrusted names');
  assert.equal(claim.logo_url, null, 'never the provider\'s logo link');
  assert.ok(!ledger(ws).some((x) => [SPAM, MYST, GOOD].includes(x.asset_id)), 'unmapped tokens never reach the ledger');
  const spamEv = wallets.loadEvents(ws, w.wallet_id, 'eth').find((e) => e.tx_hash === hash(50));
  assert.equal(spamEv.ledger.status, 'not_recorded');
  const swap = wallets.loadEvents(ws, w.wallet_id, 'eth').filter((e) => e.tx_hash === hash(52) && e.kind === 'erc20');
  assert.ok(swap.every((e) => e.ledger.status === 'held' && e.ledger.hold.code === 'unmapped_asset'), 'a swap into an unverified token is held whole');
  assert.equal(projects.listProjects(ws).length, projectsBefore, 'no project was created');
  assert.equal(fs.readdirSync(ws.abs('projects')).flatMap((p) => fs.existsSync(ws.abs(`projects/${p}/research`)) ? fs.readdirSync(ws.abs(`projects/${p}/research`)) : []).length, 0, 'no research was started');
});

test('rate limits, outages, key refusals and the compute-unit budget keep the last good view and never overspend', async (t) => {
  const { ws } = setup(t, 'wl-limits', { daily_cu_budget: 1000 });
  addToken(ws);
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const f = chain();
  f.history(A).push(tx({ n: 60, at: NOW - 3 * DAY, from: EXT, to: A, category: 'token receive', tokens: [erc20({ from: EXT, to: A, value: wei('10'), log: 0 })] }));
  f.setTokens(A, [bal({ contract: TOKEN, balance: wei('10') })]);
  assert.equal((await sync(ws, f)).status, 'ok');
  const goodAt = walletsync.readState(ws).networks[`${w.wallet_id}:eth`].last_success_at;
  // Outage: both attempts at the history page answer 503.
  f.fail(() => true, reply(503, 'unavailable'), 2);
  const out = await sync(ws, f, { now: NOW + 15 * MIN });
  assert.equal(out.status, 'failed');
  let st = walletsync.statusOf(ws, { now: NOW + 16 * MIN }).networks[`${w.wallet_id}:eth`];
  assert.equal(st.state, 'failing');
  assert.equal(st.last_success_at, goodAt);
  const o = wallets.overview(ws, { market: marketAt({}), now: NOW + 16 * MIN });
  assert.equal(o.holdings[0].quantity, '10', 'the last complete view stays');
  assert.ok(walletsync.readState(ws).networks[`${w.wallet_id}:eth`].next_attempt_at, 'backs off after a failure');
  // Rate limit with Retry-After: the gate closes for every runner.
  f.fail(() => true, reply(429, 'slow down', { 'retry-after': '120' }), 1);
  const rl = await sync(ws, f, { now: NOW + 30 * MIN });
  assert.equal(rl.status, 'failed');
  const gate = walletsync.readState(ws);
  assert.equal(Date.parse(gate.retry_after_until), NOW + 30 * MIN + 120000);
  const calls = f.calls.length;
  assert.equal((await sync(ws, f, { now: NOW + 31 * MIN })).status, 'backoff');
  assert.equal(f.calls.length, calls, 'nothing is sent while Moralis asked to wait');
  assert.equal(walletsync.isDue(ws, NOW + 31 * MIN), false);
  // A refused key pauses the sync.
  f.fail(() => true, reply(401, { message: 'invalid key' }), 1);
  const kr = await sync(ws, f, { now: NOW + 40 * MIN });
  assert.equal(kr.networks[0].outcome, 'key_refused');
  assert.ok(walletsync.readState(ws).key_refused_until);
  // Budget: 1,000 CU a day; the requests above spent most of it.
  const spent = walletsync.readState(ws).calls.day_cu;
  assert.ok(spent <= 1000, `spent ${spent}`);
  const before = f.calls.length;
  const b = await sync(ws, f, { now: NOW + 2 * HOUR });
  assert.ok(['budget_paused', 'failed', 'partial', 'ok'].includes(b.status));
  assert.ok(walletsync.readState(ws).calls.day_cu <= 1000, 'never past the daily budget');
  assert.ok(f.calls.length - before <= Math.floor((1000 - spent) / 100), 'only what the budget allows is sent');
  st = walletsync.statusOf(ws, { now: NOW + 2 * HOUR });
  assert.ok(st.summary.calls.day_cu <= 1000);
});

test('your own records are never overwritten or doubled: overlap is held for your decision; a difference stays visible', async (t) => {
  const { ws } = setup(t, 'wl-overlap');
  addToken(ws);
  portfolio.addAccount(ws, { account_id: 'metamask', name: 'MetaMask', kind: 'self_custody' });
  portfolio.addAccount(ws, { account_id: 'coinbase', name: 'Coinbase' });
  portfolio.addTransactions(ws, [{ type: 'buy', date: iso(NOW - 8 * DAY), account_id: 'metamask', asset_id: 'xtkn-fictional', quantity: '1000', price_usd: '0.02' }], { source: 'manual' });
  portfolio.addTransactions(ws, [{ type: 'transfer_in', date: iso(NOW - 2 * DAY), account_id: 'coinbase', asset_id: 'xtkn-fictional', quantity: '99.5', price_usd: null }], { source: 'manual' });
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'], account_id: 'metamask' });
  assert.equal(w.account_id, 'metamask');
  const f = chain({ pageSize: 10 });
  f.history(A).push(tx({ n: 70, at: NOW - 8 * DAY, from: EXT, to: A, category: 'token receive', tokens: [erc20({ from: EXT, to: A, value: wei('1000'), log: 0 })] }));
  f.history(A).push(tx({ n: 71, at: NOW - 2 * DAY, from: A, to: TOKEN, category: 'token send', fee: '0', tokens: [erc20({ from: A, to: EXT, value: wei('100'), log: 0 })] }));
  f.setTokens(A, [bal({ contract: TOKEN, balance: wei('900') })]);
  await sync(ws, f);
  const ev = wallets.loadEvents(ws, w.wallet_id, 'eth');
  const inEv = ev.find((e) => e.tx_hash === hash(70));
  assert.equal(inEv.ledger.status, 'held');
  assert.equal(inEv.ledger.hold.code, 'manual_records');
  assert.equal(inEv.ledger.hold.needs_decision, true);
  const outEv = ev.find((e) => e.tx_hash === hash(71));
  assert.equal(outEv.ledger.status, 'held');
  assert.equal(ledger(ws).filter((x) => x.source === 'wallet_sync').length, 0, 'nothing imported over your own records');
  assert.equal(ledger(ws).find((x) => x.source === 'manual' && x.type === 'buy').price_usd, '0.02', 'your entry is untouched');
  const o = wallets.overview(ws, { market: marketAt({ 'xtkn-fictional': 0.03 }), now: NOW });
  assert.equal(o.holdings[0].quantity, '900', 'the observed balance still shows');
  assert.equal(o.held.length, 2);
  const recon = o.reconciliation.find((r) => r.asset_id === 'xtkn-fictional');
  assert.equal(recon.status, 'awaiting_decision', 'ledger 1000, chain 900: which entry is which is your decision, not a guess');
  // You say the receipt is your recorded buy, and record the send.
  wallets.resolveEvent(ws, { wallet_id: w.wallet_id, network: 'eth', event_key: inEv.event_key, decision: 'skip' });
  wallets.resolveEvent(ws, { wallet_id: w.wallet_id, network: 'eth', event_key: outEv.event_key, decision: 'record' });
  wallets.importReady(ws, { now: NOW });
  const after = wallets.loadEvents(ws, w.wallet_id, 'eth');
  assert.equal(after.find((e) => e.tx_hash === hash(70)).ledger.status, 'skipped');
  assert.equal(after.find((e) => e.tx_hash === hash(71)).ledger.status, 'recorded');
  assert.equal(accountQty(ws, 'metamask', 'xtkn-fictional'), '900');
  const pf = portfolio.computePortfolio(ws, { market: { assets: {} } });
  assert.equal(wallets.reconcileAll(ws, { pf }).find((r) => r.asset_id === 'xtkn-fictional').status, 'matches');
  // A later difference nobody explains stays visible, with when it was first seen.
  f.setTokens(A, [bal({ contract: TOKEN, balance: wei('850') })]);
  await sync(ws, f, { now: NOW + 70 * MIN });
  const recon2 = wallets.overview(ws, { market: marketAt({}), now: NOW + 70 * MIN }).reconciliation.find((r) => r.asset_id === 'xtkn-fictional');
  assert.equal(recon2.status, 'mismatch');
  assert.equal(recon2.difference, '-50');
  const since = recon2.since;
  assert.ok(since);
  await sync(ws, f, { now: NOW + 140 * MIN });
  assert.equal(wallets.overview(ws, { market: marketAt({}), now: NOW + 140 * MIN }).reconciliation.find((r) => r.asset_id === 'xtkn-fictional').since, since, 'never silently fixed: the first-seen time stays');
  assert.equal(accountQty(ws, 'metamask', 'xtkn-fictional'), '900', 'the ledger is not adjusted to the chain');
});

test('a held transfer between two tracked wallets is one decision, recorded once as a pair', async (t) => {
  const { ws } = setup(t, 'wl-pair-decide');
  addToken(ws);
  portfolio.addAccount(ws, { account_id: 'cold', name: 'Cold wallet', kind: 'self_custody' });
  portfolio.addTransactions(ws, [{ type: 'buy', date: iso(NOW - 20 * DAY), account_id: 'cold', asset_id: 'xtkn-fictional', quantity: '5', price_usd: '1' }], { source: 'manual' });
  const a = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const b = wallets.addWallet(ws, { label: 'Ledger', address: B, networks: ['eth'], account_id: 'cold' });
  const f = chain({ pageSize: 10 });
  const move = tx({ n: 130, at: NOW - 4 * DAY, from: A, to: TOKEN, category: 'token send', fee: '0', tokens: [erc20({ from: A, to: B, value: wei('60'), log: 9 })] });
  f.history(A).push(tx({ n: 129, at: NOW - 9 * DAY, from: EXT, to: A, category: 'token receive', tokens: [erc20({ from: EXT, to: A, value: wei('100'), log: 2 })] }), move);
  f.history(B).push(JSON.parse(JSON.stringify(move)));
  f.setTokens(A, [bal({ contract: TOKEN, balance: wei('40') })]);
  f.setTokens(B, [bal({ contract: TOKEN, balance: wei('65') })]);
  await sync(ws, f);
  const o = wallets.overview(ws, { market: marketAt({}), now: NOW });
  assert.equal(o.held.length, 1, 'the same leg seen from both wallets asks once');
  wallets.resolveEvent(ws, { wallet_id: o.held[0].wallet_id, network: 'eth', event_key: o.held[0].event_key, decision: 'record' });
  wallets.importReady(ws, { now: NOW });
  const pair = ledger(ws).filter((x) => x.transfer_id);
  assert.equal(pair.length, 2, 'one transfer_out and one transfer_in, not two pairs');
  assert.equal(wallets.loadEvents(ws, a.wallet_id, 'eth').find((e) => e.tx_hash === hash(130)).ledger.status, 'recorded');
  assert.equal(wallets.loadEvents(ws, b.wallet_id, 'eth').find((e) => e.tx_hash === hash(130)).ledger.status, 'recorded');
  assert.equal(accountQty(ws, 'cold', 'xtkn-fictional'), '65');
  assert.equal(wallets.overview(ws, { market: marketAt({}), now: NOW }).held.length, 0);
});

test('a send that may be a move to another of your accounts is held, not recorded as leaving', async (t) => {
  const { ws } = setup(t, 'wl-own');
  addToken(ws);
  portfolio.addAccount(ws, { account_id: 'coinbase', name: 'Coinbase' });
  portfolio.addTransactions(ws, [{ type: 'transfer_in', date: iso(NOW - 2 * DAY), account_id: 'coinbase', asset_id: 'xtkn-fictional', quantity: '99.5', price_usd: null }], { source: 'manual' });
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const f = chain({ pageSize: 10 });
  f.history(A).push(tx({ n: 80, at: NOW - 9 * DAY, from: EXT, to: A, category: 'token receive', tokens: [erc20({ from: EXT, to: A, value: wei('100'), log: 0 })] }));
  f.history(A).push(tx({ n: 81, at: NOW - 2 * DAY + HOUR, from: A, to: TOKEN, category: 'token send', fee: '0', tokens: [erc20({ from: A, to: EXT, value: wei('100'), log: 0 })] }));
  f.setTokens(A, [bal({ contract: TOKEN, balance: '0' })]);
  await sync(ws, f);
  const outEv = wallets.loadEvents(ws, w.wallet_id, 'eth').find((e) => e.tx_hash === hash(81));
  assert.equal(outEv.ledger.hold.code, 'possible_own_transfer');
  assert.match(outEv.ledger.hold.reason, /coinbase/);
});

test('exact quantities: any decimals, no floating point, the ledger refuses what it cannot keep exactly', async (t) => {
  assert.equal(wallets.unitsToDecimal('1234567', 6), '1.234567');
  assert.equal(wallets.unitsToDecimal('1', 18), '0.000000000000000001');
  assert.equal(wallets.unitsToDecimal('123456789012345678901234567890', 24), '123456.78901234567890123456789');
  assert.equal(wallets.unitsToDecimal('5000000', 6), '5');
  assert.equal(wallets.decAdd('0.1', '0.2'), '0.3');
  assert.equal(wallets.decSub('1', '0.000000000000000000000001'), '0.999999999999999999999999');
  assert.equal(wallets.decCmp('2.50', '2.5'), 0);
  const big = moralis.normalizeTokenBalance(bal({ contract: OTHER, balance: '123456789012345678901234567890', decimals: 24 }));
  assert.equal(big.balance_raw, '123456789012345678901234567890');
  const { ws } = setup(t, 'wl-exact');
  addToken(ws, { symbol: 'OTKN', contract: OTHER });
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const f = chain({ pageSize: 10 });
  f.history(A).push(tx({ n: 90, at: NOW - 3 * DAY, from: EXT, to: A, category: 'token receive', tokens: [erc20({ contract: OTHER, symbol: 'OTKN', from: EXT, to: A, value: '123456789012345678901234567890', decimals: 24, log: 0 })] }));
  f.setTokens(A, [bal({ contract: OTHER, symbol: 'OTKN', balance: '123456789012345678901234567890', decimals: 24 })]);
  await sync(ws, f);
  const e = wallets.loadEvents(ws, w.wallet_id, 'eth')[0];
  assert.equal(e.amount, '123456.78901234567890123456789');
  assert.equal(e.ledger.status, 'held');
  assert.equal(e.ledger.hold.code, 'precision', 'more than 18 places: held, never rounded into the ledger');
  const o = wallets.overview(ws, { market: marketAt({}), now: NOW });
  assert.equal(o.holdings[0].quantity, '123456.78901234567890123456789', 'the observed balance keeps every digit');
});

test('Sync now joins the queue; pause, remove and tracking again keep every record', async (t) => {
  const { ws } = setup(t, 'wl-ctl');
  addToken(ws);
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const f = chain();
  f.history(A).push(tx({ n: 100, at: NOW - 3 * DAY, from: EXT, to: A, category: 'token receive', tokens: [erc20({ from: EXT, to: A, value: wei('10'), log: 0 })] }));
  f.setTokens(A, [bal({ contract: TOKEN, balance: wei('10') })]);
  assert.equal(walletsync.isDue(ws, NOW), true, 'a new wallet is due');
  await walletsync.refresh(ws, { fetchImpl: f, now: NOW, ...FAST });
  assert.equal(walletsync.isDue(ws, NOW + 2 * MIN), false, 'not again before the interval');
  assert.equal(walletsync.requestSync(ws, w.wallet_id, { now: NOW + 2 * MIN }).status, 'queued');
  assert.equal(walletsync.isDue(ws, NOW + 2 * MIN), true, 'Sync now makes it due');
  const n = f.calls.length;
  await walletsync.refresh(ws, { fetchImpl: f, now: NOW + 2 * MIN, ...FAST });
  assert.ok(f.calls.length > n);
  assert.ok(f.calls.slice(n).some((c) => c.path.endsWith('/tokens')), 'Sync now also reads balances');
  assert.equal(walletsync.isDue(ws, NOW + 3 * MIN), false);
  // Pause.
  wallets.pauseWallet(ws, w.wallet_id);
  assert.equal(walletsync.requestSync(ws, w.wallet_id).status, 'refused');
  assert.equal(walletsync.isDue(ws, NOW + DAY), false);
  wallets.resumeWallet(ws, w.wallet_id);
  assert.equal(walletsync.isDue(ws, NOW + DAY), true);
  // Remove: history and ledger stay.
  const files = hashTree(ws.abs(`portfolio/wallets/${w.wallet_id}`));
  const entries = ledger(ws).length;
  wallets.removeWallet(ws, w.wallet_id, 'moved to a new wallet');
  assert.deepEqual(hashTree(ws.abs(`portfolio/wallets/${w.wallet_id}`)), files, 'nothing erased');
  assert.equal(ledger(ws).length, entries);
  assert.ok(ledger(ws).every((x) => !x.voided));
  const o = wallets.overview(ws, { market: marketAt({}), now: NOW + DAY });
  assert.equal(o.holdings.length, 0, 'no longer in the holdings view');
  assert.equal(o.wallets[0].status, 'removed');
  assert.equal(walletsync.isDue(ws, NOW + DAY), false);
  // Tracking it again reuses the same wallet and its history.
  const again = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  assert.equal(again.wallet_id, w.wallet_id);
  assert.equal(again.again, true);
});

test('jobs: the wallets job is due only with a tracked wallet and a key, never in a restored copy', async (t) => {
  const { ws } = setup(t, 'wl-jobs');
  const state = jobs.readJobState(ws);
  assert.equal(jobs.isDue(ws, 'wallets', state), false, 'no wallet');
  wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  assert.equal(jobs.isDue(ws, 'wallets', state), true);
  delete process.env.MORALIS_API_KEY;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => home);
  assert.equal(jobs.isDue(ws, 'wallets', state), false, 'no key: nothing is read');
  const r = await walletsync.refresh(ws, { fetchImpl: chain(), force: true });
  assert.equal(r.status, 'not_configured');
  process.env.MORALIS_API_KEY = KEY;
  fs.writeFileSync(ws.abs('config/restored-copy.json'), JSON.stringify({ schema_version: 'cr.restored-copy.v1', research_held: true }));
  assert.equal(jobs.isDue(ws, 'wallets', state), false, 'a restored copy holds the sync');
  const f = chain();
  assert.equal((await walletsync.refresh(ws, { fetchImpl: f, force: true })).status, 'held');
  assert.equal(f.calls.length, 0);
});

test('secrets and addresses stay out of status, logs, settings and errors', async (t) => {
  const { ws } = setup(t, 'wl-secrets');
  addToken(ws);
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const f = chain();
  f.history(A).push(tx({ n: 110, at: NOW - 3 * DAY, from: EXT, to: A, category: 'token receive', tokens: [erc20({ from: EXT, to: A, value: wei('10'), log: 0 })] }));
  f.setTokens(A, [bal({ contract: TOKEN, balance: wei('10') })]);
  f.fail((u) => u.pathname.endsWith('/tokens'), new Error(`getaddrinfo ENOTFOUND for ${A} with key ${KEY}`), 2);
  await jobs.runJob(ws, 'wallets', { trigger: 'scheduler' }).catch(() => {});
  await sync(ws, f);
  const everything = (dir) => {
    let text = '';
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else text += fs.readFileSync(p, 'utf8');
      }
    };
    if (fs.existsSync(dir)) walk(dir);
    return text;
  };
  const logs = everything(ws.abs('logs'));
  const status = fs.readFileSync(ws.abs(walletsync.STATE_REL), 'utf8');
  const settings = fs.readFileSync(ws.abs('config/settings.json'), 'utf8');
  for (const [name, text] of [['logs', logs], ['sync status', status], ['settings', settings]]) {
    assert.ok(!text.includes(KEY), `no key in ${name}`);
    assert.ok(!text.toLowerCase().includes(A.toLowerCase()), `no address in ${name}`);
  }
  assert.ok(!everything(ws.abs('portfolio')).includes(KEY), 'no key in any record');
  assert.ok(!JSON.stringify(wallets.overview(ws, { market: marketAt({}), now: NOW })).includes(KEY), 'no key in what the page reads');
  assert.equal(wallets.overview(ws, { now: NOW }).provider.source, 'environment variable MORALIS_API_KEY');
  const { validateSettingsPatch } = require('../server');
  assert.throws(() => validateSettingsPatch({ wallet_sync: { moralis_api_key: 'x' } }), (e) => e.code === 'REFUSED');
  assert.throws(() => validateSettingsPatch({ wallet_sync: { address: A } }), (e) => e.code === 'REFUSED');
  assert.deepEqual(validateSettingsPatch({ wallet_sync: { interval_minutes: 15, daily_cu_budget: null } }), { wallet_sync: { interval_minutes: 15, daily_cu_budget: null } });
  assert.throws(() => validateSettingsPatch({ wallet_sync: { interval_minutes: 1 } }), (e) => e.code === 'INVALID');
  assert.equal(w.status, 'saved');
});

test('backup and an isolated restore keep every wallet record; the restored copy reads nothing', async (t) => {
  const { ws } = setup(t, 'wl-backup');
  addToken(ws);
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const f = chain();
  f.history(A).push(tx({ n: 120, at: NOW - 3 * DAY, from: EXT, to: A, category: 'token receive', tokens: [erc20({ from: EXT, to: A, value: wei('10'), log: 0 })] }));
  f.setTokens(A, [bal({ contract: TOKEN, balance: wei('10') })]);
  await sync(ws, f);
  const exporter = require('../core/exporter');
  const b = exporter.createBackup(ws, { reason: 'test' });
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-wl-restore-'));
  t.after(() => fs.rmSync(dest, { recursive: true, force: true, maxRetries: 5 }));
  fs.rmSync(dest, { recursive: true, force: true });
  const r = exporter.restoreBackup(ws, b.name, { to: dest });
  assert.equal(r.status, 'restored_and_verified', JSON.stringify(r.reconciliation));
  assert.deepEqual(hashTree(path.join(dest, 'portfolio', 'wallets')), hashTree(ws.abs('portfolio/wallets')));
  const ws2 = require('../core/workspace').openWorkspace({ root: dest, actor: 'test' });
  assert.deepEqual(wallets.recordSummary(ws2), wallets.recordSummary(ws));
  assert.equal(wallets.recordSummary(ws2).events, 1);
  const f2 = chain();
  assert.equal(walletsync.isDue(ws2, NOW + DAY), false);
  assert.equal((await walletsync.refresh(ws2, { fetchImpl: f2, force: true })).status, 'held');
  assert.equal(f2.calls.length, 0, 'zero provider calls from the restored copy');
  // The complete package carries them too.
  const pkg = exporter.exportPackage(ws);
  assert.ok(pkg.files.some((x) => x.path === `portfolio/wallets/${w.wallet_id}/eth/events.json`));
  assert.ok(pkg.files.some((x) => x.path === 'portfolio/wallets/registry.json'));
});

test('the server: wallet routes need the page token and same-origin writes; viewing pages never syncs', async (t) => {
  const http = require('http');
  const { ws } = setup(t, 'wl-server');
  addToken(ws);
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const { start } = require('../server');
  const srv = await start(ws, { port: 48600 + Math.floor(Math.random() * 300), quiet: true });
  t.after(() => srv.shutdown());
  const port = srv.port;
  const request = (p, { method = 'GET', headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
  assert.equal((await request('/api/wallets')).status, 401, 'no page token, no wallet data');
  const { token } = JSON.parse((await request('/api/session')).body);
  const r = await request('/api/wallets', { headers: { 'x-cr-token': token } });
  assert.equal(r.status, 200);
  const o = JSON.parse(r.body);
  assert.equal(o.wallets[0].wallet_id, w.wallet_id);
  assert.ok(!r.body.includes(KEY));
  assert.equal((await request(`/api/wallets/${w.wallet_id}/sync`, { method: 'POST', headers: { 'x-cr-token': token, 'content-type': 'application/json', origin: 'https://evil.example' }, body: {} })).status, 403, 'writes only from the page itself');
  assert.equal((await request(`/api/wallets/${w.wallet_id}/remove`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` }, body: {} })).status, 401);
  for (const p of ['/', '/api/index', '/api/wallets', '/api/portfolio/ledger']) await request(p, { headers: { 'x-cr-token': token } });
  assert.equal(globalThis.fetch.mock.calls.length, 0, 'viewing pages sends nothing to Moralis');
  assert.equal(wallets.listWallets(ws)[0].status, 'active');
});

test('reading the wallet views never syncs or researches', async (t) => {
  const { ws } = setup(t, 'wl-read');
  addToken(ws);
  wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  buildIndex(ws);
  wallets.overview(ws, { now: NOW });
  walletsync.statusOf(ws, { now: NOW });
  assert.equal(globalThis.fetch.mock.calls.length, 0);
  assert.equal(fs.existsSync(ws.abs(walletsync.STATE_REL)), false, 'a read writes no status');
});
