'use strict';
// Read-only wallet sync through Alchemy (core/alchemy.js, core/wallets.js,
// core/walletsync.js). Every Alchemy answer comes from a stub chain that
// speaks its JSON-RPC shapes (alchemy_getAssetTransfers, receipts, blocks,
// balances, token metadata) with FICTIONAL addresses, contracts, hashes and
// amounts; global fetch is replaced by one that fails, so nothing is ever
// sent anywhere. The sync clock is fixed; block times are in the past so the
// ledger accepts them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { tempWorkspace, hashTree } = require('./helpers');
const wallets = require('../core/wallets');
const walletsync = require('../core/walletsync');
const alchemy = require('../core/alchemy');
const portfolio = require('../core/portfolio');
const projects = require('../core/projects');
const jobs = require('../core/jobs');
const { buildIndex } = require('../core/indexer');

const NOW = Date.parse('2026-10-01T12:00:00Z');
const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const FAST = { retryDelayMs: 0, pauseMs: 0 };
const KEY = 'alchemyTestKeyFICTIONAL7f3a9c1e5b';
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
const hexOf = (v) => `0x${BigInt(v).toString(16)}`;
const wei = (eth) => {
  const [i, f = ''] = String(eth).split('.');
  return (BigInt(i) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18))).toString();
};
const GAS = 21000n;
const PRICE = 20000000000n; // 20 gwei: 0.00042 ETH per transaction
const FEE = '0.00042';
const TRANSFER = alchemy.TRANSFER_TOPIC;
const SWAP_TOPIC = '0x00000000000000000000000000000000000000000000000000000000000057a9';
const APPROVAL_TOPIC = '0x0000000000000000000000000000000000000000000000000000000000000a99';

function setup(t, label, settings = {}) {
  const { ws, root, cleanup } = tempWorkspace(label, { wallet_sync: settings });
  t.after(cleanup);
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network access is not allowed in tests');
  });
  const prev = process.env.ALCHEMY_API_KEY;
  process.env.ALCHEMY_API_KEY = KEY;
  t.after(() => {
    if (prev === undefined) delete process.env.ALCHEMY_API_KEY;
    else process.env.ALCHEMY_API_KEY = prev;
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

const HOSTS = { 'eth-mainnet': 'eth', 'base-mainnet': 'base', 'arb-mainnet': 'arbitrum', 'opt-mainnet': 'optimism', 'polygon-mainnet': 'polygon' };
const INTERNAL = new Set(['eth', 'base', 'polygon']);

// A fictional chain behind a stub Alchemy. Transactions carry their own
// transfers (external, internal, erc20) and logs; transfers are listed by
// alchemy_getAssetTransfers as Alchemy does (uniqueId, rawContract hex, block
// metadata), paged by an opaque pageKey; receipts, blocks, balances and token
// metadata answer from the same state. fail(when, answer, times) answers
// matching requests differently.
function chain({ pageSize = 2 } = {}) {
  const nets = new Map();
  const calls = [];
  const failures = [];
  const net = (n) => {
    if (!nets.has(n)) nets.set(n, { head: 20000000, finalized: 19999900, noFinalized: false, txs: new Map(), salt: new Map(), balances: new Map(), tokens: new Map(), meta: new Map(), hidden: new Set(), pageKeys: new Map() });
    return nets.get(n);
  };
  const blockHash = (s, n) => hash(`9${n}${s.salt.get(String(n)) || ''}`);
  const transfersOf = (s, network) => {
    const out = [];
    for (const tx of s.txs.values()) {
      if (tx.block > s.head || s.hidden.has(tx.hash) || tx.reorged) continue;
      tx.transfers.forEach((x, i) => {
        if (x.category === 'internal' && !INTERNAL.has(network)) return;
        if (x.category !== 'external' && tx.status === 0) return;
        out.push({
          blockNum: hexOf(tx.block),
          uniqueId: x.category === 'erc20' ? `${tx.hash}:log:${x.log}` : x.category === 'external' ? `${tx.hash}:external` : `${tx.hash}:internal:${i}`,
          hash: tx.hash,
          from: x.from,
          to: x.to,
          value: Number(x.raw) / 10 ** (x.decimals ?? 18),
          erc721TokenId: null,
          erc1155Metadata: null,
          tokenId: null,
          asset: x.symbol || (x.category === 'erc20' ? 'XTKN' : 'ETH'),
          category: x.category,
          rawContract: { value: hexOf(x.raw), address: x.contract || null, decimal: x.decimals === null ? null : hexOf(x.decimals ?? 18) },
          metadata: { blockTimestamp: iso(tx.at) },
        });
      });
    }
    return out.sort((a, b) => Number(BigInt(a.blockNum) - BigInt(b.blockNum)) || a.uniqueId.localeCompare(b.uniqueId));
  };
  const handle = (network, method, params) => {
    const s = net(network);
    switch (method) {
      case 'eth_blockNumber': return hexOf(s.head);
      case 'eth_getBlockByNumber': {
        const tag = params[0];
        if (tag === 'finalized') {
          if (s.noFinalized) return { error: { code: -32602, message: 'invalid block tag' } };
          return { number: hexOf(s.finalized), hash: blockHash(s, s.finalized) };
        }
        const n = tag === 'latest' ? s.head : Number(BigInt(tag));
        return { number: hexOf(n), hash: blockHash(s, n) };
      }
      case 'alchemy_getAssetTransfers': {
        const p = params[0];
        const from = BigInt(p.fromBlock || '0x0');
        const to = BigInt(p.toBlock || hexOf(s.head));
        let list = transfersOf(s, network).filter((x) => p.category.includes(x.category) && BigInt(x.blockNum) >= from && BigInt(x.blockNum) <= to);
        if (p.fromAddress) list = list.filter((x) => x.from === p.fromAddress.toLowerCase());
        if (p.toAddress) list = list.filter((x) => x.to === p.toAddress.toLowerCase());
        if (p.excludeZeroValue !== false) list = list.filter((x) => BigInt(x.rawContract.value) !== 0n);
        // A pageKey belongs to the query that made it: other parameters are refused.
        const { pageKey: given, ...rest } = p;
        const sig = JSON.stringify(rest);
        if (given && (!s.pageKeys.has(given) || s.pageKeys.get(given).sig !== sig)) return { error: { code: -32602, message: 'invalid pageKey' } };
        const offset = given ? s.pageKeys.get(given).offset : 0;
        const page = list.slice(offset, offset + pageSize);
        let pageKey;
        if (offset + pageSize < list.length) {
          pageKey = `pk-${Math.random().toString(36).slice(2, 10)}`;
          s.pageKeys.set(pageKey, { offset: offset + pageSize, sig });
        }
        return { transfers: page, ...(pageKey ? { pageKey } : {}) };
      }
      case 'eth_getTransactionReceipt': {
        const tx = s.txs.get(params[0]);
        if (!tx || tx.reorged || tx.block > s.head) return null;
        const fee = { gasUsed: hexOf(GAS), effectiveGasPrice: hexOf(PRICE), ...(tx.l1Fee ? { l1Fee: hexOf(tx.l1Fee) } : {}) };
        const logs = tx.logs.map((l, i) => ({ address: l.address, topics: [l.topic0], logIndex: hexOf(l.log ?? i) }));
        return { transactionHash: tx.hash, blockNumber: hexOf(tx.block), blockHash: blockHash(s, tx.block), status: tx.status === 1 ? '0x1' : '0x0', from: tx.from, to: tx.to, ...fee, logs, ...(tx.receiptExtra || {}) };
      }
      case 'eth_getTransactionCount': {
        const who = params[0].toLowerCase();
        const at = BigInt(params[1]);
        return hexOf([...s.txs.values()].filter((tx) => tx.from === who && BigInt(tx.block) <= at && !tx.reorged).length + (s.extraNonce || 0));
      }
      case 'eth_getBalance': return hexOf(s.balances.get(params[0].toLowerCase()) || '0');
      case 'alchemy_getTokenBalances': {
        const held = [...(s.tokens.get(params[0].toLowerCase()) || new Map()).entries()].map(([c, v]) => (v === 'error' ? { contractAddress: c, tokenBalance: null, error: 'execution reverted' } : { contractAddress: c, tokenBalance: hexOf(v), error: null }));
        const opts = params[2] || {};
        const offset = opts.pageKey ? Number(opts.pageKey.slice(3)) : 0;
        const page = held.slice(offset, offset + pageSize);
        return { address: params[0], tokenBalances: page, ...(offset + pageSize < held.length ? { pageKey: `tb-${offset + pageSize}` } : {}) };
      }
      case 'alchemy_getTokenMetadata': return s.meta.get(params[0].toLowerCase()) || { name: null, symbol: null, decimals: null, logo: null };
      default: return { error: { code: -32601, message: 'method not found' } };
    }
  };
  const f = async (url, init = {}) => {
    const u = new URL(url);
    const network = HOSTS[u.hostname.split('.')[0]];
    const body = JSON.parse(init.body);
    const call = { network, method: body.method, params: body.params, key: u.pathname.split('/').pop(), host: u.hostname };
    calls.push(call);
    for (const x of failures) {
      if (x.times > 0 && x.when(call)) {
        x.times--;
        if (x.answer instanceof Error) throw x.answer;
        return typeof x.answer === 'function' ? x.answer(call) : x.answer;
      }
    }
    const result = handle(network, body.method, body.params || []);
    if (result && result.error && Object.keys(result).length === 1) return reply(200, { jsonrpc: '2.0', id: body.id, error: result.error });
    return reply(200, { jsonrpc: '2.0', id: body.id, result });
  };
  let n = 1;
  let blockSeq = 19000000;
  // A transaction: from, to, its transfers and logs, status and block.
  f.tx = (network, { from, to, transfers = [], logs = null, status = 1, at, block = null, l1Fee = null, hashN = null, receipt = null }) => {
    const s = net(network);
    const h = hash(hashN || n++);
    const derived = transfers.filter((x) => x.category === 'erc20').map((x) => ({ address: x.contract, topic0: TRANSFER, log: x.log }));
    const tx = { hash: h, from: from.toLowerCase(), to: to ? to.toLowerCase() : null, transfers: transfers.map((x) => ({ ...x, from: x.from.toLowerCase(), to: x.to.toLowerCase(), contract: x.contract ? x.contract.toLowerCase() : null })), logs: logs || derived, status, at, block: block === null ? blockSeq++ : block, l1Fee, receiptExtra: receipt };
    s.txs.set(h, tx);
    return tx;
  };
  // Plain ETH send (no contract events).
  f.send = (network, { from, to, value, at, status = 1, block = null }) => f.tx(network, { from, to, transfers: [{ category: 'external', from, to, raw: wei(value) }], logs: [], status, at, block });
  // A token's own transfer call: one Transfer event, a zero-value external leg.
  f.tokenSend = (network, { from, to, contract = TOKEN, raw, decimals = 18, symbol = 'XTKN', at, log = 0, block = null }) => f.tx(network, { from, to: contract, transfers: [{ category: 'external', from, to: contract, raw: '0' }, { category: 'erc20', from, to, contract, raw, decimals, symbol, log }], at, block });
  f.net = net;
  f.list = (network) => transfersOf(net(network), network);
  f.calls = calls;
  f.fail = (when, answer, times = 1) => failures.push({ when, answer, times });
  f.setBalance = (network, who, value) => net(network).balances.set(who.toLowerCase(), value);
  f.setToken = (network, who, contract, raw) => {
    const s = net(network);
    if (!s.tokens.has(who.toLowerCase())) s.tokens.set(who.toLowerCase(), new Map());
    s.tokens.get(who.toLowerCase()).set(contract.toLowerCase(), raw);
  };
  f.setMeta = (network, contract, meta) => net(network).meta.set(contract.toLowerCase(), meta);
  f.reorg = (network, h) => {
    const s = net(network);
    const tx = s.txs.get(h);
    tx.reorged = true;
    s.salt.set(String(tx.block), 'ff');
  };
  return f;
}

const XTKN_META = { name: 'Example XTKN (FICTIONAL)', symbol: 'XTKN', decimals: 18, logo: 'https://logo.example/x.png' };
const marketAt = (prices, at = NOW) => ({ assets: Object.fromEntries(Object.entries(prices).map(([id, p]) => [id, { price_usd: p, fetched_at: iso(at), source_last_updated_at: iso(at) }])) });
const sync = (ws, f, extra = {}) => walletsync.refresh(ws, { fetchImpl: f, force: true, now: NOW, ...FAST, ...extra });
const ledger = (ws) => portfolio.loadTransactions(ws);
const position = (ws, assetId) => portfolio.computePortfolio(ws, { market: { assets: {} } }).positions.find((p) => p.asset_id === assetId) || null;
const accountQty = (ws, account, assetId) => {
  const p = position(ws, assetId);
  const a = p && p.by_account.find((x) => x.account_id === account);
  return a ? a.quantity_exact : '0';
};
const decide = (ws, w, network, txHash, decision) => {
  const e = wallets.loadEvents(ws, w.wallet_id, network).find((x) => x.tx_hash === txHash && x.ledger.status === 'held');
  return wallets.resolveEvent(ws, { wallet_id: w.wallet_id, network, event_key: e.event_key, decision });
};
const ethLeft = (start, ...moves) => moves.reduce((acc, m) => acc + BigInt(m), BigInt(wei(start))).toString();
const FEE_WEI = (GAS * PRICE).toString();

// ---------------------------------------------------------------------------

test('adding a wallet: a public address and networks Alchemy covers; no holding is created', (t) => {
  const { ws } = setup(t, 'al-add');
  const seed = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  assert.throws(() => wallets.addWallet(ws, { label: 'MetaMask', address: seed, networks: ['eth'] }), (e) => e.code === 'REFUSED' && /seed phrase/.test(e.message));
  assert.throws(() => wallets.addWallet(ws, { label: 'MetaMask', address: `0x${'ab'.repeat(32)}`, networks: ['eth'] }), (e) => e.code === 'REFUSED' && /private key/.test(e.message));
  assert.throws(() => wallets.addWallet(ws, { label: 'MetaMask', address: 'eric.eth', networks: ['eth'] }), (e) => e.code === 'INVALID');
  assert.throws(() => wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: [] }), (e) => e.code === 'INVALID' && /at least one network/.test(e.message));
  assert.throws(() => wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['solana'] }), (e) => e.code === 'INVALID');
  assert.throws(() => wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['linea'] }), (e) => e.code === 'INVALID' && /Alchemy's transfer history does not cover/.test(e.message));
  assert.deepEqual(Object.keys(wallets.NETWORKS).filter((n) => wallets.NETWORKS[n].supported).sort(), ['arbitrum', 'base', 'eth', 'optimism', 'polygon']);
  const out = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth', 'base'] });
  assert.equal(out.status, 'saved');
  assert.match(out.wallet_id, wallets.WALLET_ID_RE);
  assert.ok(!out.wallet_id.includes('a11ce'), 'the wallet ID is not derived from the address');
  assert.equal(wallets.listWallets(ws)[0].provider, 'alchemy');
  assert.ok(portfolio.assetRegistry(ws).has('ethereum'), 'the native coin became a reference asset');
  assert.equal(ledger(ws).length, 0, 'adding a wallet records no transaction');
  assert.equal(wallets.addWallet(ws, { label: 'Again', address: A, networks: ['eth'] }).status, 'exists');
  assert.equal(globalThis.fetch.mock.calls.length, 0, 'nothing is read until a sync runs');
});

test('first sync with no history: native and token balances observed exactly, nothing recorded, cost unknown', async (t) => {
  const { ws } = setup(t, 'al-first');
  addToken(ws);
  wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const f = chain();
  f.setBalance('eth', A, wei('1.5'));
  f.setToken('eth', A, TOKEN, wei('1000'));
  f.setToken('eth', A, OTHER, '0');
  f.setMeta('eth', TOKEN, XTKN_META);
  const r = await sync(ws, f);
  assert.equal(r.status, 'ok', r.message);
  assert.ok(f.calls.every((c) => c.key === KEY && Object.values(HOSTS).includes(c.network)), 'only the documented Alchemy hosts');
  assert.equal(ledger(ws).length, 0, 'a first balance snapshot is never a purchase');
  const o = wallets.overview(ws, { market: marketAt({ 'xtkn-fictional': 0.5, ethereum: 2000 }), now: NOW });
  const x = o.holdings.find((h) => h.asset_id === 'xtkn-fictional');
  assert.equal(x.quantity, '1000');
  assert.equal(x.value_usd, 500);
  assert.equal(x.acquisition.status, 'unknown');
  assert.equal(x.reconciliation.status, 'mismatch', 'observed but not in the ledger stays a visible difference');
  assert.equal(o.holdings.find((h) => h.native).quantity, '1.5');
  assert.equal(o.holdings.length, 2, 'a zero token balance is not a holding');
  assert.equal(f.calls.filter((c) => c.method === 'alchemy_getTokenMetadata').length, 1);
  await sync(ws, f, { now: NOW + 13 * HOUR });
  assert.equal(f.calls.filter((c) => c.method === 'alchemy_getTokenMetadata').length, 1, 'token details are cached');
});

test('buy, partial sale, full sale and send: plain transfers recorded, swaps only on your decision, fees once per transaction, exact to the wei', async (t) => {
  const { ws } = setup(t, 'al-cycle');
  addToken(ws);
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const f = chain({ pageSize: 2 });
  f.setMeta('eth', TOKEN, XTKN_META);
  f.send('eth', { from: EXT, to: A, value: '1', at: NOW - 30 * DAY });
  const buy = f.tx('eth', { from: A, to: ROUTER, transfers: [{ category: 'external', from: A, to: ROUTER, raw: wei('0.2') }, { category: 'erc20', from: ROUTER, to: A, contract: TOKEN, raw: wei('500'), log: 3 }], logs: [{ address: TOKEN, topic0: TRANSFER }, { address: ROUTER, topic0: SWAP_TOPIC }], at: NOW - 20 * DAY });
  const part = f.tx('eth', { from: A, to: ROUTER, transfers: [{ category: 'external', from: A, to: ROUTER, raw: '0' }, { category: 'erc20', from: A, to: ROUTER, contract: TOKEN, raw: wei('200'), log: 1 }, { category: 'internal', from: ROUTER, to: A, raw: wei('0.1') }], logs: [{ address: TOKEN, topic0: TRANSFER }, { address: ROUTER, topic0: SWAP_TOPIC }], at: NOW - 10 * DAY });
  const full = f.tx('eth', { from: A, to: ROUTER, transfers: [{ category: 'external', from: A, to: ROUTER, raw: '0' }, { category: 'erc20', from: A, to: ROUTER, contract: TOKEN, raw: wei('300'), log: 7 }, { category: 'internal', from: ROUTER, to: A, raw: wei('0.15') }], logs: [{ address: TOKEN, topic0: TRANSFER }, { address: ROUTER, topic0: SWAP_TOPIC }], at: NOW - 5 * DAY });
  f.send('eth', { from: A, to: EXT, value: '0.05', at: NOW - 2 * DAY });
  const left = ethLeft('1', `-${wei('0.2')}`, wei('0.1'), wei('0.15'), `-${wei('0.05')}`, `-${FEE_WEI}`, `-${FEE_WEI}`, `-${FEE_WEI}`, `-${FEE_WEI}`);
  f.setBalance('eth', A, left);
  const r = await sync(ws, f);
  assert.equal(r.status, 'ok', r.message);
  const before = ledger(ws).map((x) => x.type).sort();
  assert.deepEqual(before, ['fee', 'fee', 'fee', 'fee', 'transfer_in', 'transfer_out'], 'transfers and fees only: no swap is assumed');
  const o = wallets.overview(ws, { market: marketAt({}), now: NOW });
  assert.equal(o.held.length, 3, 'three possible swaps, each asked once');
  assert.ok(o.held.every((h) => h.ledger.hold.code === 'possible_swap' && h.swap_legs.length === 2));
  for (const tx of [buy, part, full]) decide(ws, w, 'eth', tx.hash, 'record');
  wallets.importReady(ws, { now: NOW });
  const txs = ledger(ws);
  assert.deepEqual(txs.map((x) => x.type).sort(), ['buy', 'buy', 'buy', 'fee', 'fee', 'fee', 'fee', 'sell', 'sell', 'sell', 'transfer_in', 'transfer_out']);
  assert.ok(txs.every((x) => x.source === 'wallet_sync' && x.price_usd === null), 'prices are never invented');
  assert.ok(txs.every((x) => x.provenance && x.provenance.provider === 'alchemy' && x.provenance.tx_hash), 'every entry names its chain reference and provider');
  assert.equal(txs.filter((x) => x.type === 'fee').length, 4, 'gas once per transaction this wallet sent');
  assert.equal(accountQty(ws, w.account_id, 'xtkn-fictional'), '0');
  assert.equal(position(ws, 'xtkn-fictional').realized_unknown_quantity, 500, 'no profit invented');
  assert.equal(accountQty(ws, w.account_id, 'ethereum'), wallets.unitsToDecimal(left, 18));
  const recon = wallets.reconcileAll(ws, { pf: portfolio.computePortfolio(ws, { market: { assets: {} } }) });
  assert.equal(recon.find((x) => x.asset_id === 'ethereum').status, 'matches');
});

test('one transaction with several transfers: separate events, one fee; repeated reads, a self-transfer and duplicate items count once', async (t) => {
  const { ws } = setup(t, 'al-multi');
  addToken(ws);
  addToken(ws, { symbol: 'OTKN', contract: OTHER });
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const f = chain({ pageSize: 2 });
  f.setMeta('eth', TOKEN, XTKN_META);
  f.setMeta('eth', OTHER, { name: 'Example OTKN (FICTIONAL)', symbol: 'OTKN', decimals: 0 });
  const batch = f.tx('eth', { from: EXT, to: ROUTER, transfers: [{ category: 'erc20', from: ROUTER, to: A, contract: TOKEN, raw: wei('10'), log: 4 }, { category: 'erc20', from: ROUTER, to: A, contract: TOKEN, raw: wei('10'), log: 5 }, { category: 'erc20', from: ROUTER, to: A, contract: OTHER, raw: '7', decimals: 0, symbol: 'OTKN', log: 6 }], at: NOW - 3 * DAY });
  const multi = f.tx('eth', { from: A, to: ROUTER, transfers: [{ category: 'external', from: A, to: ROUTER, raw: '0' }, { category: 'erc20', from: A, to: EXT, contract: TOKEN, raw: wei('3'), log: 1 }, { category: 'erc20', from: A, to: ROUTER, contract: TOKEN, raw: wei('2'), log: 2 }], at: NOW - 2 * DAY });
  const self = f.tokenSend('eth', { from: A, to: A, raw: wei('1'), at: NOW - DAY, log: 0 });
  f.setToken('eth', A, TOKEN, wei('15'));
  f.setToken('eth', A, OTHER, '7');
  f.setBalance('eth', A, '0');
  await sync(ws, f);
  const events = wallets.loadEvents(ws, w.wallet_id, 'eth');
  assert.equal(events.filter((e) => e.tx_hash === batch.hash).length, 3, 'one event per transfer in the transaction');
  assert.equal(events.filter((e) => e.tx_hash === self.hash && e.kind !== 'fee').length, 1, 'a self-transfer read by both queries is one event');
  assert.equal(events.find((e) => e.tx_hash === self.hash && e.kind !== 'fee').classification, 'self_transfer');
  assert.ok(events.filter((e) => e.tx_hash === multi.hash && e.kind !== 'fee').every((e) => e.classification === 'unresolved'), 'a batch send is not assumed to be two plain sends');
  assert.equal(events.filter((e) => e.kind === 'fee').length, 2, 'one fee per transaction this wallet sent');
  const recorded = ledger(ws).length;
  assert.equal(recorded, 3 + 2, 'three receipts in, two fees');
  // Repeated reads, and a provider that repeats an item on a page.
  f.fail((c) => c.method === 'alchemy_getAssetTransfers' && c.params[0].toAddress, () => {
    const item = f.list('eth').find((x) => x.uniqueId === `${batch.hash}:log:4`);
    return reply(200, { jsonrpc: '2.0', id: 1, result: { transfers: [item, item] } });
  }, 1);
  await sync(ws, f, { now: NOW + 13 * HOUR });
  await sync(ws, f, { now: NOW + 26 * HOUR });
  assert.equal(ledger(ws).length, recorded, 'nothing recorded twice');
  assert.equal(wallets.loadEvents(ws, w.wallet_id, 'eth').length, events.length);
  assert.equal(accountQty(ws, w.account_id, 'otkn-fictional'), '7');
  const raw = JSON.parse(fs.readFileSync(ws.abs(wallets.rawRel(w.wallet_id, 'eth', iso(NOW - 3 * DAY).slice(0, 7))), 'utf8'));
  assert.equal(raw.transfers[`${batch.hash}:log:4`].length, 1, 'an unchanged answer is kept once');
  assert.ok(raw.receipts[batch.hash], 'the receipt is kept as answered');
});

test('pagination interrupted, then a restart: the read continues from the block reached; an expired page key is not reused', async (t) => {
  const { ws } = setup(t, 'al-resume');
  addToken(ws);
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const f = chain({ pageSize: 2 });
  f.setMeta('eth', TOKEN, XTKN_META);
  for (let i = 0; i < 5; i++) f.tokenSend('eth', { from: EXT, to: A, raw: wei('1'), at: NOW - (10 - i) * DAY, log: 0 });
  f.setToken('eth', A, TOKEN, wei('5'));
  f.setBalance('eth', A, '0');
  // The second page of the "in" query fails on both attempts: an outage mid-read.
  let inPages = 0;
  f.fail((c) => c.method === 'alchemy_getAssetTransfers' && c.params[0].toAddress && ++inPages === 2, new Error(`connect ECONNRESET https://eth-mainnet.g.alchemy.com/v2/${KEY}`), 1);
  f.fail((c) => c.method === 'alchemy_getAssetTransfers' && c.params[0].toAddress && c.params[0].pageKey, new Error('connect ECONNRESET again'), 1);
  const r1 = await sync(ws, f);
  assert.equal(r1.status, 'failed');
  const st = walletsync.readState(ws).networks[`${w.wallet_id}:eth`];
  assert.equal(st.pass.phase, 2, 'stopped in the third query');
  assert.ok(st.pass.page_key && st.pass.resume_block !== st.pass.from_block, 'the place is kept');
  assert.equal(st.history_complete_to, undefined, 'a partial read is never complete');
  assert.equal(st.last_success_at, undefined);
  assert.ok(wallets.loadEvents(ws, w.wallet_id, 'eth').every((e) => e.state === 'pending'), 'nothing is final after a partial read');
  assert.equal(ledger(ws).length, 0);
  assert.ok(!JSON.stringify(walletsync.readState(ws)).includes(KEY), 'no key in the status file');
  assert.ok(!/0x0+a11ce/i.test(JSON.stringify(walletsync.readState(ws))), 'no address in the status file');
  // Fifteen minutes later (a restart): the page key has expired, so the read
  // continues from the block reached, without it.
  const before = f.calls.length;
  const r2 = await sync(ws, f, { now: NOW + 15 * MIN });
  assert.equal(r2.status, 'ok', r2.message);
  const next = f.calls.slice(before).find((c) => c.method === 'alchemy_getAssetTransfers');
  assert.ok(next.params[0].toAddress, 'it went on with the third query');
  assert.equal(next.params[0].pageKey, undefined, 'an expired page key is not sent');
  assert.equal(next.params[0].fromBlock, hexOf(st.pass.resume_block));
  assert.equal(ledger(ws).length, 5, 'every transfer once');
  assert.equal(accountQty(ws, w.account_id, 'xtkn-fictional'), '5');
});

test('a transfer between two tracked wallets is one transfer, with its lots and acquisition date', async (t) => {
  const { ws } = setup(t, 'al-internal');
  addToken(ws);
  const a = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const b = wallets.addWallet(ws, { label: 'Ledger', address: B, networks: ['eth'] });
  const f = chain();
  f.setMeta('eth', TOKEN, XTKN_META);
  f.send('eth', { from: EXT, to: A, value: '1', at: NOW - 10 * DAY });
  f.tokenSend('eth', { from: EXT, to: A, raw: wei('100'), at: NOW - 9 * DAY, log: 2 });
  const move = f.tokenSend('eth', { from: A, to: B, raw: wei('60'), at: NOW - 4 * DAY, log: 9 });
  f.setToken('eth', A, TOKEN, wei('40'));
  f.setToken('eth', B, TOKEN, wei('60'));
  f.setBalance('eth', A, ethLeft('1', `-${FEE_WEI}`));
  const r = await sync(ws, f);
  assert.equal(r.status, 'ok', r.message);
  const pair = ledger(ws).filter((x) => x.transfer_id);
  assert.deepEqual(pair.map((x) => x.type).sort(), ['transfer_in', 'transfer_out']);
  assert.equal(pair.find((x) => x.type === 'transfer_out').account_id, a.account_id);
  assert.equal(pair.find((x) => x.type === 'transfer_in').account_id, b.account_id);
  assert.ok(!ledger(ws).some((x) => ['buy', 'sell'].includes(x.type)), 'never a buy or a sale');
  const pf = portfolio.computePortfolio(ws, { market: { assets: {} } });
  assert.equal(accountQty(ws, b.account_id, 'xtkn-fictional'), '60');
  assert.equal(accountQty(ws, a.account_id, 'xtkn-fictional'), '40');
  const evB = wallets.loadEvents(ws, b.wallet_id, 'eth').find((e) => e.tx_hash === move.hash);
  assert.equal(evB.classification, 'internal_transfer');
  assert.equal(evB.ledger.status, 'recorded');
  assert.ok(wallets.reconcileAll(ws, { pf }).filter((x) => x.asset_id === 'xtkn-fictional').every((x) => x.status === 'matches'));
});

test('receipts decide success: a failed transaction counts only its fee; the OP-stack L1 fee is part of the fee', async (t) => {
  const { ws } = setup(t, 'al-failed');
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth', 'base'] });
  const f = chain();
  f.send('eth', { from: EXT, to: A, value: '1', at: NOW - 6 * DAY });
  const failed = f.send('eth', { from: A, to: EXT, value: '0.5', at: NOW - 4 * DAY, status: 0 });
  f.setBalance('eth', A, ethLeft('1', `-${FEE_WEI}`));
  f.send('base', { from: EXT, to: A, value: '0.1', at: NOW - 6 * DAY });
  const l2 = f.tx('base', { from: A, to: EXT, transfers: [{ category: 'external', from: A, to: EXT, raw: wei('0.01') }], logs: [], at: NOW - 3 * DAY, l1Fee: 1234567n });
  f.setBalance('base', A, ethLeft('0.1', `-${wei('0.01')}`, `-${FEE_WEI}`, '-1234567'));
  await sync(ws, f);
  const ev = wallets.loadEvents(ws, w.wallet_id, 'eth').filter((e) => e.tx_hash === failed.hash);
  assert.equal(ev.find((e) => e.kind === 'native').classification, 'failed_transfer');
  assert.equal(ev.find((e) => e.kind === 'native').ledger.status, 'not_recorded');
  assert.equal(ev.find((e) => e.kind === 'fee').ledger.status, 'recorded', 'the fee of a failed transaction was paid');
  const fee = wallets.loadEvents(ws, w.wallet_id, 'base').find((e) => e.tx_hash === l2.hash && e.kind === 'fee');
  assert.equal(fee.amount_raw, (GAS * PRICE + 1234567n).toString());
  assert.match(fee.fee_basis, /L1 data fee/);
  const pf = portfolio.computePortfolio(ws, { market: { assets: {} } });
  assert.equal(wallets.reconcileAll(ws, { pf }).find((r) => r.asset_id === 'ethereum').status, 'matches', 'both networks reconcile to the wei');
});

test('reversals need chain evidence: a gone receipt plus a replaced block reverses; a missing row or an unchanged block never does', async (t) => {
  const { ws } = setup(t, 'al-reorg');
  addToken(ws);
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const f = chain({ pageSize: 10 });
  f.setMeta('eth', TOKEN, XTKN_META);
  const s = f.net('eth');
  const old = f.tokenSend('eth', { from: EXT, to: A, raw: wei('100'), at: NOW - 5 * DAY, log: 0 });
  const recent = f.tokenSend('eth', { from: EXT, to: A, raw: wei('3'), at: NOW - 5 * MIN, block: s.finalized + 50, log: 1 });
  const quiet = f.tokenSend('eth', { from: EXT, to: A, raw: wei('2'), at: NOW - 4 * MIN, block: s.finalized + 60, log: 2 });
  f.setToken('eth', A, TOKEN, wei('105'));
  f.setBalance('eth', A, '0');
  await sync(ws, f);
  let ev = wallets.loadEvents(ws, w.wallet_id, 'eth');
  assert.equal(ev.find((e) => e.tx_hash === old.hash).ledger.status, 'recorded');
  assert.equal(ev.find((e) => e.tx_hash === recent.hash).state, 'pending', 'above the finalized block: not final');
  assert.equal(accountQty(ws, w.account_id, 'xtkn-fictional'), '100', 'only final activity is recorded');
  // The recent one is reorganized away (receipt gone, its block replaced);
  // the quiet one's receipt is briefly missing but its block is unchanged;
  // the old, recorded one vanishes from Alchemy's answers.
  f.reorg('eth', recent.hash);
  s.txs.get(quiet.hash).reorged = true;
  s.hidden.add(old.hash);
  await sync(ws, f, { now: NOW + 13 * HOUR });
  ev = wallets.loadEvents(ws, w.wallet_id, 'eth');
  const rec = ev.find((e) => e.tx_hash === recent.hash);
  assert.equal(rec.state, 'reverted');
  assert.match(wallets.loadEventsDoc(ws, w.wallet_id, 'eth').txs[recent.hash].reversal.evidence, /no longer found, and block .* now has hash/);
  assert.equal(ev.find((e) => e.tx_hash === quiet.hash).state, 'pending', 'an unchanged block is not evidence of a reversal');
  assert.equal(ev.find((e) => e.tx_hash === old.hash).ledger.status, 'recorded', 'missing from an answer is never a reversal');
  assert.equal(accountQty(ws, w.account_id, 'xtkn-fictional'), '100');
  assert.ok(ledger(ws).every((x) => !x.voided));
  // With evidence for a recorded entry, it is voided with that evidence.
  const doc = wallets.loadEventsDoc(ws, w.wallet_id, 'eth');
  const oldRc = doc.txs[old.hash].receipt;
  wallets.storeReceipts(ws, w, 'eth', [{ tx_hash: old.hash, receipt: null, raw: null, block_check: { number: oldRc.block_number, hash: hash('ffff') } }], { now: NOW + 14 * HOUR });
  wallets.settleNetwork(ws, w, 'eth', { finalized: String(s.finalized), now: NOW + 14 * HOUR });
  wallets.importReady(ws, { now: NOW + 14 * HOUR });
  const voided = ledger(ws).find((x) => x.provenance && x.provenance.tx_hash === old.hash);
  assert.equal(voided.voided, true);
  assert.match(voided.void_reason, /reversed on chain: The receipt is no longer found/);
  const pf = portfolio.computePortfolio(ws, { market: { assets: {} } });
  assert.ok(wallets.attentionItems(ws, { pf, now: NOW }).some((a) => a.kind === 'wallet_reversed'));
});

test('unverified tokens: an advertising name or an unsolicited token is set aside, never recorded or researched; a small verified holding stays in view', async (t) => {
  const { ws } = setup(t, 'al-spam');
  addToken(ws);
  const projectsBefore = projects.listProjects(ws).length;
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const f = chain({ pageSize: 10 });
  f.setMeta('eth', TOKEN, XTKN_META);
  f.setMeta('eth', SPAM, { name: 'Visit claim-reward.example‮ now', symbol: 'CLAIM', decimals: 18 });
  f.setMeta('eth', MYST, { name: 'Mystery', symbol: 'MYST', decimals: 18 });
  f.setMeta('eth', GOOD, { name: 'Good Token', symbol: 'GOOD', decimals: 6 });
  f.send('eth', { from: EXT, to: A, value: '1', at: NOW - 20 * DAY });
  f.tx('eth', { from: EXT, to: SPAM, transfers: [{ category: 'erc20', from: EXT, to: A, contract: SPAM, raw: wei('1000000'), symbol: 'CLAIM', log: 0 }], at: NOW - 3 * DAY });
  f.tx('eth', { from: EXT, to: MYST, transfers: [{ category: 'erc20', from: EXT, to: A, contract: MYST, raw: wei('5'), symbol: 'MYST', log: 0 }], at: NOW - 3 * DAY });
  f.tokenSend('eth', { from: EXT, to: A, raw: wei('1.000001'), at: NOW - 9 * DAY });
  const swap = f.tx('eth', { from: A, to: ROUTER, transfers: [{ category: 'external', from: A, to: ROUTER, raw: '0' }, { category: 'erc20', from: A, to: ROUTER, contract: TOKEN, raw: wei('1'), log: 1 }, { category: 'erc20', from: ROUTER, to: A, contract: GOOD, raw: '250000', decimals: 6, symbol: 'GOOD', log: 2 }], at: NOW - 2 * DAY });
  f.setToken('eth', A, SPAM, wei('1000000'));
  f.setToken('eth', A, MYST, wei('5'));
  f.setToken('eth', A, GOOD, '250000');
  f.setToken('eth', A, TOKEN, wei('0.000001'));
  f.setBalance('eth', A, ethLeft('1', `-${FEE_WEI}`));
  await sync(ws, f);
  const o = wallets.overview(ws, { market: marketAt({ 'xtkn-fictional': 0.5, ethereum: 2000 }), now: NOW });
  const main = o.holdings.map((x) => x.symbol).sort();
  assert.deepEqual(main, ['ETH', 'GOOD', 'XTKN'], 'the small verified holding and the token you swapped for stay in view');
  assert.ok(o.holdings.find((x) => x.symbol === 'XTKN').value_usd < 0.01);
  const good = o.holdings.find((x) => x.symbol === 'GOOD');
  assert.equal(good.verified, false);
  assert.equal(good.value_usd, null);
  assert.equal(good.price.usd, null, '"Price unavailable": no price without a verified identity');
  assert.equal(good.quantity, '0.25');
  const hid = new Map(o.hidden.map((x) => [x.reported.symbol, x]));
  assert.equal(hid.get('CLAIM').hidden, 'suspicious');
  assert.equal(hid.get('MYST').hidden, 'unsolicited');
  assert.match(hid.get('MYST').hidden_reason, /not a judgment that it is safe or unsafe/);
  assert.ok(!/[‮]/.test(hid.get('CLAIM').name), 'direction-override characters are removed');
  assert.equal(hid.get('CLAIM').logo_url, null, 'never the provider\'s logo link');
  const ev = wallets.loadEvents(ws, w.wallet_id, 'eth');
  assert.equal(ev.find((e) => e.asset.contract === SPAM.toLowerCase()).ledger.code, 'spam');
  assert.equal(ev.find((e) => e.asset.contract === MYST.toLowerCase()).ledger.hold.code, 'unmapped_asset');
  assert.ok(ev.filter((e) => e.tx_hash === swap.hash && e.kind === 'erc20').every((e) => e.ledger.status === 'held' && e.ledger.hold.code === 'unmapped_asset'), 'a swap into an unverified token is held whole, with no decision asked');
  assert.equal(projects.listProjects(ws).length, projectsBefore, 'no project was created');
  assert.equal(fs.readdirSync(ws.abs('projects')).flatMap((p) => (fs.existsSync(ws.abs(`projects/${p}/research`)) ? fs.readdirSync(ws.abs(`projects/${p}/research`)) : [])).length, 0, 'no research was started');
});

test('caps, outages, rate limits, key and plan refusals keep the last good view and never pass a cap', async (t) => {
  const { ws } = setup(t, 'al-limits', { daily_cu_cap: 2000, monthly_cu_cap: 3000 });
  addToken(ws);
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const f = chain();
  f.setMeta('eth', TOKEN, XTKN_META);
  f.tokenSend('eth', { from: EXT, to: A, raw: wei('10'), at: NOW - 3 * DAY });
  f.setToken('eth', A, TOKEN, wei('10'));
  f.setBalance('eth', A, '0');
  assert.equal((await sync(ws, f)).status, 'ok');
  const goodAt = walletsync.readState(ws).networks[`${w.wallet_id}:eth`].last_success_at;
  // Outage: both attempts at the first request answer 503.
  f.fail(() => true, reply(503, 'unavailable'), 2);
  assert.equal((await sync(ws, f, { now: NOW + 13 * HOUR })).status, 'failed');
  let st = walletsync.statusOf(ws, { now: NOW + 13 * HOUR }).networks[`${w.wallet_id}:eth`];
  assert.equal(st.state, 'failing');
  assert.equal(st.last_success_at, goodAt);
  assert.equal(wallets.overview(ws, { market: marketAt({}), now: NOW + 13 * HOUR }).holdings[0].quantity, '10', 'the last complete view stays');
  // HTTP 429 with Retry-After: every runner waits.
  f.fail(() => true, reply(429, 'slow down', { 'retry-after': '120' }), 1);
  await sync(ws, f, { now: NOW + 14 * HOUR });
  assert.equal(Date.parse(walletsync.readState(ws).retry_after_until), NOW + 14 * HOUR + 120000);
  const calls = f.calls.length;
  assert.equal((await sync(ws, f, { now: NOW + 14 * HOUR + MIN })).status, 'backoff');
  assert.equal(f.calls.length, calls, 'nothing is sent while Alchemy asked to wait');
  // A JSON-RPC 429 inside an HTTP 200 is a rate limit too.
  f.fail(() => true, (c) => reply(200, { jsonrpc: '2.0', id: 1, error: { code: 429, message: 'Your app has exceeded its compute units per second capacity' } }), 1);
  await sync(ws, f, { now: NOW + 15 * HOUR });
  assert.ok(Date.parse(walletsync.readState(ws).retry_after_until) > NOW + 15 * HOUR);
  // A refused key pauses the sync.
  f.fail(() => true, reply(401, { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Must be authenticated!' } }), 1);
  const kr = await sync(ws, f, { now: NOW + 16 * HOUR });
  assert.equal(kr.networks[0].outcome, 'key_refused');
  assert.ok(walletsync.readState(ws).key_refused_until);
  // A used-up plan pauses it for a day.
  f.fail(() => true, (c) => reply(200, { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Monthly capacity limit exceeded. Upgrade your plan.' } }), 1);
  const q = await sync(ws, f, { now: NOW + 23 * HOUR });
  assert.equal(q.networks[0].outcome, 'quota');
  assert.ok(Date.parse(walletsync.readState(ws).quota_until) > NOW + 23 * HOUR);
  // The caps: never passed, a run that meets one pauses.
  const c = walletsync.readState(ws).calls;
  assert.ok(c.month_cu <= 3000 && c.day_cu <= 2000, JSON.stringify(c));
  const r = await sync(ws, f, { now: NOW + 2 * DAY });
  assert.ok(['budget_paused', 'ok', 'failed', 'partial'].includes(r.status));
  const after = walletsync.readState(ws).calls;
  assert.ok(after.month_cu <= 3000, `month ${after.month_cu}`);
  assert.ok(after.day_cu <= 2000, `day ${after.day_cu}`);
  assert.ok(after.methods.alchemy_getAssetTransfers > 0, 'usage is counted per method');
  st = walletsync.statusOf(ws, { now: NOW + 2 * DAY });
  assert.ok(st.summary.calls.month_cu <= 3000);
});

test('a cap stops the run before passing it: requests are counted before they are sent, retries included', async (t) => {
  const { ws } = setup(t, 'al-cap', { daily_cu_cap: 100 });
  wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const f = chain();
  f.fail((c) => c.method === 'eth_getBlockByNumber', reply(503, 'busy'), 1);
  const r = await sync(ws, f);
  assert.equal(r.status, 'budget_paused');
  const c = walletsync.readState(ws).calls;
  assert.ok(c.day_cu <= 100, `${c.day_cu}`);
  assert.deepEqual(f.calls.map((x) => x.method), ['eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByNumber'], 'the retry counted too; the 120-unit transfers query was never sent');
  assert.equal(c.day_cu, 50);
  assert.equal(wallets.overview(ws, { now: NOW }).wallets[0].networks[0].state, 'unavailable');
});

test('records the earlier provider (Moralis) saved are kept with their provenance and never counted twice', async (t) => {
  const { ws } = setup(t, 'al-earlier');
  addToken(ws);
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const f = chain();
  f.setMeta('eth', TOKEN, XTKN_META);
  f.send('eth', { from: EXT, to: A, value: '1', at: NOW - 9 * DAY });
  const moved = f.tokenSend('eth', { from: EXT, to: A, raw: wei('10'), at: NOW - 8 * DAY, log: 0 });
  const sent = f.send('eth', { from: A, to: EXT, value: '0.1', at: NOW - 7 * DAY });
  f.setToken('eth', A, TOKEN, wei('10'));
  f.setBalance('eth', A, ethLeft('1', `-${wei('0.1')}`, `-${FEE_WEI}`));
  // What the earlier provider saved and recorded: the token receipt, the ETH
  // send (another key format) and its fee, with ledger entries.
  const at = iso(NOW - 2 * DAY);
  const base = { wallet_id: w.wallet_id, network: 'eth', state: 'final', first_seen_at: at, last_seen_at: at, history: [{ at, change: 'seen' }], suspected_spam: false, counterparty_wallet_id: null };
  const old = [
    { ...base, event_key: `eth:${moved.hash}:log:0`, tx_hash: moved.hash, block_number: '1', block_timestamp: iso(NOW - 8 * DAY), kind: 'erc20', direction: 'in', asset: { native: false, contract: TOKEN.toLowerCase(), decimals: 18, symbol: 'XTKN' }, amount_raw: wei('10'), amount: '10', classification: 'incoming_transfer' },
    { ...base, event_key: `eth:${sent.hash}:native:abc123`, tx_hash: sent.hash, block_number: '2', block_timestamp: iso(NOW - 7 * DAY), kind: 'native', direction: 'out', asset: { native: true, contract: null, decimals: 18, symbol: 'ETH' }, amount_raw: wei('0.1'), amount: '0.1', classification: 'outgoing_transfer' },
    { ...base, event_key: `eth:${sent.hash}:fee`, tx_hash: sent.hash, block_number: '2', block_timestamp: iso(NOW - 7 * DAY), kind: 'fee', direction: 'out', asset: { native: true, contract: null, decimals: 18, symbol: 'ETH' }, amount_raw: FEE_WEI, amount: FEE, classification: 'gas_fee' },
  ].map((e) => ({ ...e, ledger: { status: 'waiting', tx_ids: [], revision: 0 } }));
  fs.mkdirSync(ws.abs(`portfolio/wallets/${w.wallet_id}/eth/raw`), { recursive: true });
  fs.writeFileSync(ws.abs(wallets.eventsRel(w.wallet_id, 'eth')), JSON.stringify({ schema_version: 'cr.wallet-events.v1', wallet_id: w.wallet_id, network: 'eth', events: old }));
  fs.writeFileSync(ws.abs(`portfolio/wallets/${w.wallet_id}/eth/raw/2026-09.json`), JSON.stringify({ schema_version: 'cr.wallet-raw.v1', provider: 'moralis', items: {} }));
  wallets.importReady(ws, { now: NOW });
  const earlier = ledger(ws).length;
  assert.equal(earlier, 3);
  assert.ok(ledger(ws).every((x) => x.provenance.provider === 'moralis'));
  await sync(ws, f);
  const ev = wallets.loadEvents(ws, w.wallet_id, 'eth');
  assert.equal(ev.filter((e) => e.tx_hash === moved.hash).length, 1, 'the token receipt is the earlier event, not a second one');
  assert.equal(ev.filter((e) => e.tx_hash === sent.hash && e.kind === 'native').length, 1, 'the ETH send is matched across key formats');
  assert.equal(ev.filter((e) => e.event_key === `eth:${sent.hash}:fee`).length, 1, 'one fee event');
  assert.equal(ledger(ws).filter((x) => x.provenance.provider === 'moralis').length, earlier, 'earlier entries kept as they were');
  assert.equal(ledger(ws).length, earlier + 1, 'only the new ETH receipt was added');
  assert.ok(fs.existsSync(ws.abs(`portfolio/wallets/${w.wallet_id}/eth/raw/2026-09.json`)), 'the earlier raw file is kept');
  const pf = portfolio.computePortfolio(ws, { market: { assets: {} } });
  assert.ok(wallets.reconcileAll(ws, { pf }).every((r) => r.status === 'matches'), JSON.stringify(wallets.reconcileAll(ws, { pf })));
});

test('unsupported networks are never read; their records stay', async (t) => {
  const { ws } = setup(t, 'al-unsupported');
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  // A wallet saved earlier with Linea (no longer covered).
  const reg = JSON.parse(fs.readFileSync(ws.abs(wallets.REGISTRY_REL), 'utf8'));
  reg.wallets[0].networks = ['eth', 'linea'];
  fs.writeFileSync(ws.abs(wallets.REGISTRY_REL), JSON.stringify(reg));
  const f = chain();
  f.setBalance('eth', A, '0');
  await sync(ws, f);
  assert.ok(f.calls.every((c) => c.network === 'eth'), 'nothing is asked about Linea');
  const st = walletsync.statusOf(ws, { now: NOW });
  assert.equal(st.networks[`${w.wallet_id}:linea`].state, 'unsupported');
  const o = wallets.overview(ws, { market: marketAt({}), now: NOW });
  assert.equal(o.wallets[0].networks.find((n) => n.network === 'linea').supported, false);
  assert.ok(!o.networks_supported.some((n) => n.id === 'linea'));
  assert.ok(o.networks_unsupported.some((n) => n.id === 'linea'));
  assert.throws(() => wallets.setWalletNetworks(ws, w.wallet_id, ['eth', 'bsc']), (e) => e.code === 'INVALID');
});

test('your own records are never overwritten or doubled: overlap waits for your decision; a difference stays visible with when it was first seen', async (t) => {
  const { ws } = setup(t, 'al-overlap');
  addToken(ws);
  portfolio.addAccount(ws, { account_id: 'metamask', name: 'MetaMask', kind: 'self_custody' });
  portfolio.addTransactions(ws, [{ type: 'buy', date: iso(NOW - 8 * DAY), account_id: 'metamask', asset_id: 'xtkn-fictional', quantity: '1000', price_usd: '0.02' }], { source: 'manual' });
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'], account_id: 'metamask' });
  const f = chain({ pageSize: 10 });
  f.setMeta('eth', TOKEN, XTKN_META);
  const inTx = f.tokenSend('eth', { from: EXT, to: A, raw: wei('1000'), at: NOW - 8 * DAY });
  const outTx = f.tokenSend('eth', { from: A, to: EXT, raw: wei('100'), at: NOW - 2 * DAY });
  f.send('eth', { from: EXT, to: A, value: '1', at: NOW - 9 * DAY });
  f.setToken('eth', A, TOKEN, wei('900'));
  f.setBalance('eth', A, ethLeft('1', `-${FEE_WEI}`));
  await sync(ws, f);
  const ev = wallets.loadEvents(ws, w.wallet_id, 'eth');
  assert.equal(ev.find((e) => e.tx_hash === inTx.hash).ledger.hold.code, 'manual_records');
  assert.equal(ev.find((e) => e.tx_hash === outTx.hash && e.kind === 'erc20').ledger.status, 'held');
  assert.equal(ledger(ws).filter((x) => x.source === 'wallet_sync' && x.asset_id === 'xtkn-fictional').length, 0, 'nothing imported over your own records');
  assert.equal(ledger(ws).find((x) => x.source === 'manual').price_usd, '0.02', 'your entry is untouched');
  const o = wallets.overview(ws, { market: marketAt({ 'xtkn-fictional': 0.03 }), now: NOW });
  assert.equal(o.holdings.find((x) => x.symbol === 'XTKN').quantity, '900', 'the observed balance still shows');
  assert.equal(o.reconciliation.find((r) => r.asset_id === 'xtkn-fictional').status, 'awaiting_decision');
  decide(ws, w, 'eth', inTx.hash, 'skip');
  decide(ws, w, 'eth', outTx.hash, 'record');
  wallets.importReady(ws, { now: NOW });
  assert.equal(accountQty(ws, 'metamask', 'xtkn-fictional'), '900');
  const pf = portfolio.computePortfolio(ws, { market: { assets: {} } });
  assert.equal(wallets.reconcileAll(ws, { pf }).find((r) => r.asset_id === 'xtkn-fictional').status, 'matches');
  f.setToken('eth', A, TOKEN, wei('850'));
  await sync(ws, f, { now: NOW + 13 * HOUR });
  const r2 = wallets.overview(ws, { market: marketAt({}), now: NOW + 13 * HOUR }).reconciliation.find((r) => r.asset_id === 'xtkn-fictional');
  assert.equal(r2.status, 'mismatch');
  assert.equal(r2.difference, '-50');
  await sync(ws, f, { now: NOW + 26 * HOUR });
  assert.equal(wallets.overview(ws, { market: marketAt({}), now: NOW + 26 * HOUR }).reconciliation.find((r) => r.asset_id === 'xtkn-fictional').since, r2.since, 'never silently fixed');
  assert.equal(accountQty(ws, 'metamask', 'xtkn-fictional'), '900', 'the ledger is not adjusted to the chain');
});

test('a held transfer between two tracked wallets is one decision; a send that may be a move to your exchange is held', async (t) => {
  const { ws } = setup(t, 'al-pair');
  addToken(ws);
  portfolio.addAccount(ws, { account_id: 'cold', name: 'Cold wallet', kind: 'self_custody' });
  portfolio.addAccount(ws, { account_id: 'coinbase', name: 'Coinbase' });
  portfolio.addTransactions(ws, [{ type: 'buy', date: iso(NOW - 20 * DAY), account_id: 'cold', asset_id: 'xtkn-fictional', quantity: '5', price_usd: '1' }], { source: 'manual' });
  portfolio.addTransactions(ws, [{ type: 'transfer_in', date: iso(NOW - DAY), account_id: 'coinbase', asset_id: 'xtkn-fictional', quantity: '9.9', price_usd: null }], { source: 'manual' });
  const a = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const b = wallets.addWallet(ws, { label: 'Ledger', address: B, networks: ['eth'], account_id: 'cold' });
  const f = chain({ pageSize: 10 });
  f.setMeta('eth', TOKEN, XTKN_META);
  f.tokenSend('eth', { from: EXT, to: A, raw: wei('100'), at: NOW - 9 * DAY });
  const move = f.tokenSend('eth', { from: A, to: B, raw: wei('60'), at: NOW - 4 * DAY, log: 9 });
  const toExchange = f.tokenSend('eth', { from: A, to: EXT, raw: wei('10'), at: NOW - DAY - HOUR });
  f.setToken('eth', A, TOKEN, wei('30'));
  f.setToken('eth', B, TOKEN, wei('65'));
  await sync(ws, f);
  const o = wallets.overview(ws, { market: marketAt({}), now: NOW });
  const pairHeld = o.held.filter((x) => x.tx_hash === move.hash);
  assert.equal(pairHeld.length, 1, 'the same leg seen from both wallets asks once');
  assert.equal(o.held.find((x) => x.tx_hash === toExchange.hash).ledger.hold.code, 'possible_own_transfer');
  wallets.resolveEvent(ws, { wallet_id: pairHeld[0].wallet_id, network: 'eth', event_key: pairHeld[0].event_key, decision: 'record' });
  wallets.importReady(ws, { now: NOW });
  assert.equal(ledger(ws).filter((x) => x.transfer_id).length, 2, 'one transfer_out and one transfer_in');
  assert.equal(wallets.loadEvents(ws, b.wallet_id, 'eth').find((e) => e.tx_hash === move.hash).ledger.status, 'recorded');
  assert.equal(accountQty(ws, 'cold', 'xtkn-fictional'), '65');
  assert.equal(a.status, 'saved');
});

test('exact quantities: 6, 18 and 24 decimals without floats; the ledger refuses what it cannot keep exactly', async (t) => {
  assert.equal(wallets.unitsToDecimal('1234567', 6), '1.234567');
  assert.equal(wallets.unitsToDecimal('1', 18), '0.000000000000000001');
  assert.equal(wallets.unitsToDecimal('123456789012345678901234567890', 24), '123456.78901234567890123456789');
  assert.equal(wallets.decSub('1', '0.000000000000000000000001'), '0.999999999999999999999999');
  assert.equal(alchemy.hexToDec('0x18ee90ff6c373e0ee4e3f0ad2'), '123456789012345678901234567890');
  assert.equal(alchemy.normalizeTransfer({ blockNum: '0x10', uniqueId: `${hash(1)}:log:3`, hash: hash(1), from: A, to: B, value: 1.2345678901234567, asset: 'X', category: 'erc20', rawContract: { value: '0x112210f47de98115', address: TOKEN, decimal: '0x12' } }).value_raw, '1234567890123456789', 'the float "value" is never used');
  const { ws } = setup(t, 'al-exact');
  addToken(ws, { symbol: 'OTKN', contract: OTHER });
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const f = chain({ pageSize: 10 });
  f.setMeta('eth', OTHER, { name: 'Example OTKN (FICTIONAL)', symbol: 'OTKN', decimals: 24 });
  f.tx('eth', { from: EXT, to: OTHER, transfers: [{ category: 'erc20', from: EXT, to: A, contract: OTHER, raw: '123456789012345678901234567890', decimals: 24, symbol: 'OTKN', log: 0 }], at: NOW - 3 * DAY });
  f.setToken('eth', A, OTHER, '123456789012345678901234567890');
  f.setBalance('eth', A, '0');
  await sync(ws, f);
  const e = wallets.loadEvents(ws, w.wallet_id, 'eth')[0];
  assert.equal(e.amount, '123456.78901234567890123456789');
  assert.equal(e.ledger.hold.code, 'precision', 'more than 18 places: held, never rounded into the ledger');
  const o = wallets.overview(ws, { market: marketAt({}), now: NOW });
  assert.equal(o.holdings.find((x) => x.symbol === 'OTKN').quantity, '123456.78901234567890123456789');
});

test('history: ETH sent by contracts is not reported on Arbitrum, said as partial history; a sent transaction missing from the read is counted', async (t) => {
  const { ws } = setup(t, 'al-coverage');
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['arbitrum'] });
  const f = chain();
  f.send('arbitrum', { from: EXT, to: A, value: '1', at: NOW - 9 * DAY });
  // ETH a contract sent (internal): not in Alchemy's Arbitrum history.
  f.tx('arbitrum', { from: EXT, to: ROUTER, transfers: [{ category: 'internal', from: ROUTER, to: A, raw: wei('0.5') }], logs: [{ address: ROUTER, topic0: SWAP_TOPIC }], at: NOW - 8 * DAY });
  f.net('arbitrum').extraNonce = 1;
  f.setBalance('arbitrum', A, wei('1.5'));
  await sync(ws, f);
  const phases = f.calls.filter((c) => c.method === 'alchemy_getAssetTransfers').map((c) => c.params[0].category.join(','));
  assert.ok(phases.every((p) => !p.includes('internal')), 'internal is not asked where Alchemy does not offer it');
  const pf = portfolio.computePortfolio(ws, { market: { assets: {} } });
  const row = wallets.reconcileAll(ws, { pf }).find((r) => r.asset_id === 'ethereum');
  assert.equal(row.status, 'history_partial');
  assert.match(row.notes.join(' '), /Arbitrum One/);
  const n = wallets.overview(ws, { market: marketAt({}), now: NOW }).wallets[0].networks[0];
  assert.equal(n.sent_count_chain, '1');
  assert.equal(n.sent_seen, 0);
  assert.equal(w.status, 'saved');
});

test('usage: one wallet on one network twice daily is about 900 compute units a day, a small share of Alchemy Free', (t) => {
  const { ws } = setup(t, 'al-usage');
  wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const e = walletsync.estimateUsage(ws);
  assert.equal(e.per_sync, 450);
  assert.equal(e.syncs_per_day, 2);
  assert.equal(e.per_network_day, 900);
  assert.equal(e.per_network_month, 27000);
  assert.ok(e.total_month / e.free_plan_month < 0.001);
  assert.equal(wallets.intervalWords(wallets.cfgOf(ws).interval_minutes), 'Twice daily');
});

test('Sync now joins the queue; pause, remove and tracking again keep every record', async (t) => {
  const { ws } = setup(t, 'al-ctl');
  addToken(ws);
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const f = chain();
  f.setMeta('eth', TOKEN, XTKN_META);
  f.tokenSend('eth', { from: EXT, to: A, raw: wei('10'), at: NOW - 3 * DAY });
  f.setToken('eth', A, TOKEN, wei('10'));
  f.setBalance('eth', A, '0');
  assert.equal(walletsync.isDue(ws, NOW), true, 'a new wallet is due');
  await walletsync.refresh(ws, { fetchImpl: f, now: NOW, ...FAST });
  assert.equal(walletsync.isDue(ws, NOW + 6 * HOUR), false, 'not again before twelve hours');
  assert.equal(walletsync.isDue(ws, NOW + 12 * HOUR), true);
  assert.equal(walletsync.requestSync(ws, w.wallet_id, { now: NOW + 3 * MIN }).status, 'queued');
  assert.equal(walletsync.isDue(ws, NOW + 3 * MIN), true, 'Sync now makes it due');
  const n = f.calls.length;
  await walletsync.refresh(ws, { fetchImpl: f, now: NOW + 3 * MIN, ...FAST });
  assert.ok(f.calls.slice(n).some((c) => c.method === 'eth_getBalance'), 'Sync now also reads balances');
  assert.equal(walletsync.isDue(ws, NOW + 4 * MIN), false);
  wallets.pauseWallet(ws, w.wallet_id);
  assert.equal(walletsync.requestSync(ws, w.wallet_id).status, 'refused');
  assert.equal(walletsync.isDue(ws, NOW + DAY), false);
  wallets.resumeWallet(ws, w.wallet_id);
  assert.equal(walletsync.isDue(ws, NOW + DAY), true);
  const files = hashTree(ws.abs(`portfolio/wallets/${w.wallet_id}`));
  const entries = ledger(ws).length;
  wallets.removeWallet(ws, w.wallet_id, 'moved to a new wallet');
  assert.deepEqual(hashTree(ws.abs(`portfolio/wallets/${w.wallet_id}`)), files, 'nothing erased');
  assert.equal(ledger(ws).length, entries);
  const o = wallets.overview(ws, { market: marketAt({}), now: NOW + DAY });
  assert.equal(o.holdings.length, 0);
  assert.equal(o.wallets[0].status, 'removed');
  assert.equal(walletsync.isDue(ws, NOW + DAY), false);
  const again = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  assert.equal(again.wallet_id, w.wallet_id);
});

test('jobs: the wallets job is due only with a tracked wallet and an Alchemy key, never in a restored copy; no Moralis key is asked for', async (t) => {
  const { ws } = setup(t, 'al-jobs');
  const state = jobs.readJobState(ws);
  assert.equal(jobs.isDue(ws, 'wallets', state), false, 'no wallet');
  wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  process.env.MORALIS_API_KEY = 'leftover-moralis-key';
  t.after(() => delete process.env.MORALIS_API_KEY);
  assert.equal(jobs.isDue(ws, 'wallets', state), true);
  delete process.env.ALCHEMY_API_KEY;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => home);
  assert.equal(jobs.isDue(ws, 'wallets', state), false, 'a Moralis key alone does nothing');
  const f = chain();
  const r = await walletsync.refresh(ws, { fetchImpl: f, force: true });
  assert.equal(r.status, 'not_configured');
  assert.match(r.message, /ALCHEMY_API_KEY/);
  assert.equal(f.calls.length, 0);
  process.env.ALCHEMY_API_KEY = KEY;
  fs.writeFileSync(ws.abs('config/restored-copy.json'), JSON.stringify({ schema_version: 'cr.restored-copy.v1', research_held: true }));
  assert.equal(jobs.isDue(ws, 'wallets', state), false, 'a restored copy holds the sync');
  assert.equal((await walletsync.refresh(ws, { fetchImpl: f, force: true })).status, 'held');
  assert.equal(f.calls.length, 0);
});

test('secrets, endpoint URLs and addresses stay out of status, logs, settings, errors, the page and the assistant connector', async (t) => {
  const { ws } = setup(t, 'al-secrets');
  addToken(ws);
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const f = chain();
  f.setMeta('eth', TOKEN, XTKN_META);
  f.tokenSend('eth', { from: EXT, to: A, raw: wei('10'), at: NOW - 3 * DAY });
  f.setToken('eth', A, TOKEN, wei('10'));
  f.setBalance('eth', A, '0');
  f.fail((c) => c.method === 'eth_getBalance', new Error(`getaddrinfo ENOTFOUND https://eth-mainnet.g.alchemy.com/v2/${KEY} for ${A}`), 2);
  f.fail((c) => c.method === 'alchemy_getTokenBalances', (c) => reply(200, { jsonrpc: '2.0', id: 1, error: { code: -32602, message: `bad params for https://eth-mainnet.g.alchemy.com/v2/${KEY}` } }), 1);
  await jobs.runJob(ws, 'wallets', { trigger: 'scheduler' }).catch(() => {});
  await sync(ws, f);
  await sync(ws, f, { now: NOW + 13 * HOUR });
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
    assert.ok(!/g\.alchemy\.com\/v2/.test(text), `no endpoint URL in ${name}`);
    assert.ok(!text.toLowerCase().includes(A.toLowerCase()), `no address in ${name}`);
  }
  assert.ok(!everything(ws.abs('portfolio')).includes(KEY), 'no key in any record');
  const page = JSON.stringify(wallets.overview(ws, { market: marketAt({}), now: NOW }));
  assert.ok(!page.includes(KEY) && !/g\.alchemy\.com\/v2/.test(page), 'no key or endpoint in what the page reads');
  assert.equal(wallets.overview(ws, { now: NOW }).provider.source, 'environment variable ALCHEMY_API_KEY');
  // The assistant connector (ChatGPT's connection here) never returns an address.
  const { makeMcp } = require('../mcp');
  const mcp = makeMcp(ws, {});
  const ask = async (name) => {
    const req = Readable.from([Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }))]);
    req.method = 'POST';
    let out = '';
    await mcp(req, { writeHead() {}, end(s) { out = String(s || ''); } }, { assistant: 'chatgpt', client_id: 'test' });
    return out;
  };
  for (const tool of ['list_accounts', 'portfolio_overview', 'desk_status']) {
    const out = await ask(tool);
    assert.ok(out.length > 20, `${tool} answered`);
    assert.ok(!out.toLowerCase().includes(A.toLowerCase()), `${tool} carries no wallet address`);
    assert.ok(!out.includes(KEY), `${tool} carries no key`);
  }
  const { validateSettingsPatch } = require('../server');
  assert.throws(() => validateSettingsPatch({ wallet_sync: { alchemy_api_key: 'x' } }), (e) => e.code === 'REFUSED');
  assert.throws(() => validateSettingsPatch({ wallet_sync: { endpoint_url: 'https://x' } }), (e) => e.code === 'REFUSED');
  assert.deepEqual(validateSettingsPatch({ wallet_sync: { interval_minutes: 720, daily_cu_cap: null, monthly_cu_cap: 1000000 } }), { wallet_sync: { interval_minutes: 720, daily_cu_cap: null, monthly_cu_cap: 1000000 } });
  assert.throws(() => validateSettingsPatch({ wallet_sync: { interval_minutes: 10 } }), (e) => e.code === 'INVALID', 'no frequent polling');
  assert.equal(w.status, 'saved');
});

test('backup and an isolated restore keep every wallet record; the restored copy asks Alchemy nothing', async (t) => {
  const { ws } = setup(t, 'al-backup');
  addToken(ws);
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const f = chain();
  f.setMeta('eth', TOKEN, XTKN_META);
  f.tokenSend('eth', { from: EXT, to: A, raw: wei('10'), at: NOW - 3 * DAY });
  f.setToken('eth', A, TOKEN, wei('10'));
  f.setBalance('eth', A, '0');
  await sync(ws, f);
  const exporter = require('../core/exporter');
  const b = exporter.createBackup(ws, { reason: 'test' });
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-al-restore-'));
  t.after(() => fs.rmSync(dest, { recursive: true, force: true, maxRetries: 5 }));
  fs.rmSync(dest, { recursive: true, force: true });
  const r = exporter.restoreBackup(ws, b.name, { to: dest });
  assert.equal(r.status, 'restored_and_verified', JSON.stringify(r.reconciliation));
  assert.deepEqual(hashTree(path.join(dest, 'portfolio', 'wallets')), hashTree(ws.abs('portfolio/wallets')));
  const ws2 = require('../core/workspace').openWorkspace({ root: dest, actor: 'test' });
  assert.deepEqual(wallets.recordSummary(ws2), wallets.recordSummary(ws));
  const f2 = chain();
  assert.equal(walletsync.isDue(ws2, NOW + DAY), false);
  assert.equal((await walletsync.refresh(ws2, { fetchImpl: f2, force: true })).status, 'held');
  assert.equal(f2.calls.length, 0, 'zero provider calls from the restored copy');
  const pkg = exporter.exportPackage(ws);
  assert.ok(pkg.files.some((x) => x.path === `portfolio/wallets/${w.wallet_id}/eth/events.json`));
  assert.ok(pkg.files.some((x) => x.path === 'portfolio/wallets/token-metadata.json'));
});

test('the server: wallet routes need the page token and same-origin writes; viewing pages sends nothing', async (t) => {
  const http = require('http');
  const { ws } = setup(t, 'al-server');
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
  assert.equal((await request('/api/wallets')).status, 401);
  const { token } = JSON.parse((await request('/api/session')).body);
  const r = await request('/api/wallets', { headers: { 'x-cr-token': token } });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).settings.interval_words, 'Twice daily');
  assert.ok(!r.body.includes(KEY));
  assert.equal((await request(`/api/wallets/${w.wallet_id}/sync`, { method: 'POST', headers: { 'x-cr-token': token, 'content-type': 'application/json', origin: 'https://evil.example' }, body: {} })).status, 403);
  for (const p of ['/', '/api/index', '/api/wallets', '/api/portfolio/ledger']) await request(p, { headers: { 'x-cr-token': token } });
  assert.equal(globalThis.fetch.mock.calls.length, 0, 'viewing pages sends nothing to Alchemy');
});

test('reading the wallet views never syncs or researches, and writes nothing', async (t) => {
  const { ws } = setup(t, 'al-read');
  wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  buildIndex(ws);
  wallets.overview(ws, { now: NOW });
  walletsync.statusOf(ws, { now: NOW });
  assert.equal(globalThis.fetch.mock.calls.length, 0);
  assert.equal(fs.existsSync(ws.abs(walletsync.STATE_REL)), false);
});

test('classification reads only evidence: a contract call is not a plain send, value taken by a contract is unresolved', () => {
  const me = A.toLowerCase();
  const own = new Map();
  const leg = (o) => ({ event_key: `eth:${o.k}`, tx_hash: hash(1), direction: o.dir, amount: '1', internal: false, asset: o.native ? { native: true, contract: null } : { native: false, contract: TOKEN.toLowerCase() }, to: o.to, counterparty: o.to, ...o });
  const rc = (o) => ({ status: '1', from: me, to: EXT.toLowerCase(), logs: [], fee_raw: '1', fee_basis: 'x', ...o });
  // ETH to a contract that emits events (a deposit): unresolved.
  let r = wallets.classifyTx([leg({ k: 'a', dir: 'out', native: true, to: ROUTER.toLowerCase() })], rc({ to: ROUTER.toLowerCase(), logs: [{ address: ROUTER.toLowerCase(), topic0: SWAP_TOPIC }] }), { me, own, walletId: 'w_x' });
  assert.equal(r.legs.get('eth:a').classification, 'unresolved');
  // A token moved by a router (approve + transferFrom), not the token's own call.
  r = wallets.classifyTx([leg({ k: 'b', dir: 'out', to: ROUTER.toLowerCase() })], rc({ to: ROUTER.toLowerCase(), logs: [{ address: TOKEN.toLowerCase(), topic0: TRANSFER }] }), { me, own, walletId: 'w_x' });
  assert.equal(r.legs.get('eth:b').classification, 'unresolved');
  // Value leaving in a transaction someone else sent.
  r = wallets.classifyTx([leg({ k: 'c', dir: 'out', to: EXT.toLowerCase() })], rc({ from: EXT.toLowerCase() }), { me, own, walletId: 'w_x' });
  assert.equal(r.legs.get('eth:c').classification, 'unresolved');
  assert.equal(r.fee, null, 'no fee for a transaction this wallet did not send');
  // A claim this wallet sent that only brought value in.
  r = wallets.classifyTx([leg({ k: 'd', dir: 'in', to: me })], rc({ to: ROUTER.toLowerCase() }), { me, own, walletId: 'w_x' });
  assert.equal(r.legs.get('eth:d').classification, 'unresolved');
  // No receipt yet: nothing decided.
  r = wallets.classifyTx([leg({ k: 'e', dir: 'in', to: me })], null, { me, own, walletId: 'w_x' });
  assert.equal(r.legs.get('eth:e').classification, 'awaiting_receipt');
});

// ---------------------------------------------------------------------------
// Adversarial checks before the live pilot (2026-10-07)

test('failed transactions: a listed one counts its fee once; one Alchemy does not list makes the history incomplete, never "Synced" or "matches"', async (t) => {
  const { ws } = setup(t, 'al-gap');
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const f = chain({ pageSize: 2 });
  f.send('eth', { from: EXT, to: A, value: '1', at: NOW - 6 * DAY });
  // A failed contract call that moved nothing: a zero-value listing and its receipt.
  const listed = f.tx('eth', { from: A, to: ROUTER, transfers: [{ category: 'external', from: A, to: ROUTER, raw: '0' }], logs: [], status: 0, at: NOW - 5 * DAY });
  // Another failed call that Alchemy does not list at all: only the nonce counts it.
  const unlisted = f.tx('eth', { from: A, to: ROUTER, transfers: [{ category: 'external', from: A, to: ROUTER, raw: '0' }], logs: [], status: 0, at: NOW - 4 * DAY });
  f.net('eth').hidden.add(unlisted.hash);
  f.setBalance('eth', A, ethLeft('1', `-${FEE_WEI}`, `-${FEE_WEI}`));
  const r = await sync(ws, f);
  assert.equal(r.status, 'ok', r.message);
  const fees = wallets.loadEvents(ws, w.wallet_id, 'eth').filter((e) => e.kind === 'fee');
  assert.deepEqual(fees.map((e) => e.tx_hash), [listed.hash], 'the listed failed transaction has its fee; nothing is guessed for the other');
  assert.equal(ledger(ws).filter((x) => x.type === 'fee').length, 1);
  const st = walletsync.statusOf(ws, { now: NOW }).networks[`${w.wallet_id}:eth`];
  assert.equal(st.state, 'gap', 'never plain "Synced"');
  assert.equal(st.history_gap, 1);
  assert.match(st.words, /history incomplete/);
  const pf = portfolio.computePortfolio(ws, { market: { assets: {} } });
  const row = wallets.reconcileAll(ws, { pf }).find((x) => x.asset_id === 'ethereum');
  assert.equal(row.status, 'history_partial');
  assert.equal(row.difference, `-${FEE}`);
  assert.match(row.notes.join(' '), /1 transaction\(s\) this wallet sent on Ethereum are not in Alchemy's history/);
  assert.ok(wallets.attentionItems(ws, { pf, now: NOW }).some((a) => a.kind === 'wallet_history_gap'));
  assert.equal(wallets.overview(ws, { market: marketAt({}), now: NOW }).wallets[0].networks[0].history_gap, 1);
  // Read again, twice: the fee stays once, the gap stays said.
  await sync(ws, f, { now: NOW + 13 * HOUR });
  await sync(ws, f, { now: NOW + 26 * HOUR });
  assert.equal(ledger(ws).filter((x) => x.type === 'fee').length, 1);
  assert.equal(walletsync.statusOf(ws, { now: NOW + 26 * HOUR }).networks[`${w.wallet_id}:eth`].state, 'gap');
});

test('partial or malformed answers never void a recorded entry, finality never goes back, and errors carry no address or key', async (t) => {
  const { ws } = setup(t, 'al-partial');
  addToken(ws);
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  assert.throws(() => wallets.addWallet(ws, { label: `Mine ${B}`, address: B, networks: ['eth'] }), (e) => e.code === 'INVALID', 'a label is never the address');
  const f = chain({ pageSize: 10 });
  f.setMeta('eth', TOKEN, XTKN_META);
  const s = f.net('eth');
  const got = f.tokenSend('eth', { from: EXT, to: A, raw: wei('100'), at: NOW - 5 * DAY, log: 0 });
  const recent = f.tokenSend('eth', { from: EXT, to: A, raw: wei('3'), at: NOW - 5 * MIN, block: s.finalized + 50, log: 1 });
  f.setToken('eth', A, TOKEN, wei('103'));
  f.setBalance('eth', A, '0');
  assert.equal((await sync(ws, f)).status, 'ok');
  const recordedQty = accountQty(ws, w.account_id, 'xtkn-fictional');
  assert.equal(recordedQty, '100');
  // 1. The "in" answer repeats the recorded transfer without its contract.
  f.fail((c) => c.method === 'alchemy_getAssetTransfers' && c.params[0].toAddress, () => {
    const items = f.list('eth').filter((x) => x.to === A.toLowerCase()).map((x) => (x.hash === got.hash ? { ...x, rawContract: { ...x.rawContract, address: null } } : x));
    return reply(200, { jsonrpc: '2.0', id: 1, result: { transfers: items } });
  }, 1);
  // 2. A node a little behind answers an older finalized block.
  s.finalized = 18999000;
  // 3. The receipt of the pending transaction comes back as something else.
  f.fail((c) => c.method === 'eth_getTransactionReceipt' && c.params[0] === recent.hash, reply(200, { jsonrpc: '2.0', id: 1, result: { blockNumber: '0x1', status: '0x1' } }), 1);
  const r2 = await sync(ws, f, { now: NOW + 13 * HOUR });
  assert.equal(r2.status, 'ok', r2.message);
  const e = wallets.loadEvents(ws, w.wallet_id, 'eth').find((x) => x.tx_hash === got.hash);
  assert.equal(e.state, 'final', 'finality never goes back');
  assert.equal(e.ledger.status, 'recorded');
  assert.equal(e.asset.contract, TOKEN.toLowerCase(), 'an answer without the contract is not a change');
  assert.ok(!ledger(ws).some((x) => x.voided), 'nothing voided');
  assert.equal(accountQty(ws, w.account_id, 'xtkn-fictional'), recordedQty);
  assert.equal(walletsync.readState(ws).networks[`${w.wallet_id}:eth`].finalized_block, '19999900');
  const doc = wallets.loadEventsDoc(ws, w.wallet_id, 'eth');
  assert.ok(doc.txs[recent.hash].receipt, 'an answer that is not the receipt is not "gone"');
  assert.equal(doc.txs[recent.hash].reversal, undefined);
  assert.ok(!doc.txs[recent.hash].missing_since);
  s.finalized = 19999900;
  // 4. A node behind the history already read: nothing is read or changed.
  s.head = 19000000;
  const before = JSON.stringify(wallets.loadEventsDoc(ws, w.wallet_id, 'eth'));
  const r3 = await sync(ws, f, { now: NOW + 26 * HOUR });
  assert.equal(r3.status, 'failed');
  assert.match(r3.networks[0].error, /behind block/);
  assert.equal(JSON.stringify(wallets.loadEventsDoc(ws, w.wallet_id, 'eth')), before);
  assert.ok(!ledger(ws).some((x) => x.voided));
  s.head = 20000000;
  // 5. An error that names the address and the key: neither is kept.
  f.fail((c) => c.method === 'eth_blockNumber', reply(200, { jsonrpc: '2.0', id: 1, error: { code: -32000, message: `cannot read ${A} with key ${KEY} at https://eth-mainnet.g.alchemy.com/v2/${KEY}` } }), 1);
  const r4 = await sync(ws, f, { now: NOW + 39 * HOUR });
  assert.equal(r4.status, 'failed');
  const text = JSON.stringify([r4, walletsync.readState(ws), walletsync.statusOf(ws, { now: NOW + 39 * HOUR })]);
  assert.ok(!text.includes(KEY), 'no key');
  assert.ok(!/0x0+a11ce/i.test(text), 'no address');
  assert.match(text, /\[address\]/);
});

test('approving a possible swap records one sale and one purchase, never its transfers as well; a changed side is decided again', async (t) => {
  const { ws } = setup(t, 'al-swapdecide');
  addToken(ws);
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const f = chain({ pageSize: 2 });
  f.setMeta('eth', TOKEN, XTKN_META);
  f.send('eth', { from: EXT, to: A, value: '1', at: NOW - 30 * DAY });
  f.tokenSend('eth', { from: EXT, to: A, raw: wei('500'), at: NOW - 25 * DAY, log: 0 });
  // Final, and inside the overlap every later read covers again.
  const swap = f.tx('eth', { from: A, to: ROUTER, block: 19999850, transfers: [{ category: 'external', from: A, to: ROUTER, raw: '0' }, { category: 'erc20', from: A, to: ROUTER, contract: TOKEN, raw: wei('200'), log: 1 }, { category: 'internal', from: ROUTER, to: A, raw: wei('0.1') }], logs: [{ address: TOKEN, topic0: TRANSFER }, { address: ROUTER, topic0: SWAP_TOPIC }], at: NOW - 10 * DAY });
  f.setToken('eth', A, TOKEN, wei('300'));
  f.setBalance('eth', A, ethLeft('1', wei('0.1'), `-${FEE_WEI}`));
  await sync(ws, f);
  const forSwap = () => ledger(ws).filter((x) => x.provenance && x.provenance.tx_hash === swap.hash && !x.voided);
  assert.deepEqual(forSwap().map((x) => x.type), ['fee'], 'only the fee before your decision');
  decide(ws, w, 'eth', swap.hash, 'record');
  wallets.importReady(ws, { now: NOW });
  assert.deepEqual(forSwap().map((x) => x.type).sort(), ['buy', 'fee', 'sell']);
  for (let i = 1; i <= 3; i++) {
    await sync(ws, f, { now: NOW + i * 13 * HOUR });
    wallets.importReady(ws, { now: NOW + i * 13 * HOUR });
  }
  assert.deepEqual(forSwap().map((x) => x.type).sort(), ['buy', 'fee', 'sell'], 'later reads add nothing');
  assert.ok(!ledger(ws).some((x) => x.provenance && x.provenance.tx_hash === swap.hash && ['transfer_in', 'transfer_out'].includes(x.type)), 'its transfers are never recorded as well');
  const swapIds = forSwap().filter((x) => x.type !== 'fee').map((x) => x.tx_id).sort();
  const legs = wallets.loadEvents(ws, w.wallet_id, 'eth').filter((e) => e.tx_hash === swap.hash && e.kind !== 'fee');
  assert.equal(legs.length, 2);
  assert.ok(legs.every((e) => e.ledger.status === 'recorded' && JSON.stringify([...e.ledger.tx_ids].sort()) === JSON.stringify(swapIds)));
  assert.equal(accountQty(ws, w.account_id, 'xtkn-fictional'), '300');
  assert.equal(accountQty(ws, w.account_id, 'ethereum'), wallets.unitsToDecimal(ethLeft('1', wei('0.1'), `-${FEE_WEI}`), 18));
  // Alchemy later reports another amount for one side: both entries are
  // voided together and the swap is asked again; nothing doubles or breaks.
  f.net('eth').txs.get(swap.hash).transfers[1].raw = wei('250');
  const r = await sync(ws, f, { now: NOW + 60 * HOUR });
  assert.notEqual(r.ledger.status, 'failed', r.message);
  assert.deepEqual(forSwap().map((x) => x.type), ['fee'], 'the swap entries are voided together; the fee stays');
  const again = wallets.overview(ws, { market: marketAt({}), now: NOW + 60 * HOUR }).held.filter((h) => h.tx_hash === swap.hash);
  assert.equal(again.length, 1);
  assert.equal(again[0].ledger.hold.code, 'possible_swap');
  assert.equal(again[0].swap_legs.length, 2);
  assert.equal(ledger(ws).filter((x) => x.provenance && x.provenance.tx_hash === swap.hash && x.voided).length, 2, 'kept with the reason, never deleted');
});

test('OP-stack receipts: a deposit bridged in from Ethereum is never a self-transfer and has no fee here; an operator fee is not guessed', async (t) => {
  const { ws } = setup(t, 'al-opstack');
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['base'] });
  const f = chain();
  const dep = f.tx('base', { from: A, to: A, transfers: [{ category: 'external', from: A, to: A, raw: wei('0.5') }], logs: [], at: NOW - 6 * DAY, receipt: { type: '0x7e', depositNonce: '0x1', effectiveGasPrice: '0x0' } });
  const op = f.tx('base', { from: A, to: EXT, transfers: [{ category: 'external', from: A, to: EXT, raw: wei('0.1') }], logs: [], at: NOW - 3 * DAY, l1Fee: 1000n, receipt: { operatorFeeScalar: '0x1', operatorFeeConstant: '0x0' } });
  f.setBalance('base', A, wei('0.39'));
  assert.equal((await sync(ws, f)).status, 'ok');
  const ev = wallets.loadEvents(ws, w.wallet_id, 'base');
  const d = ev.filter((e) => e.tx_hash === dep.hash);
  assert.equal(d.length, 1, 'the deposit leg only; no fee event');
  assert.equal(d[0].classification, 'unresolved');
  assert.match(d[0].reason, /deposit bridged in from Ethereum/);
  const fee = ev.find((e) => e.tx_hash === op.hash && e.kind === 'fee');
  assert.equal(fee.amount_raw, null);
  assert.match(fee.reason, /operator fee/);
  assert.equal(fee.ledger.status, 'not_recorded');
  assert.ok(!ledger(ws).some((x) => x.type === 'fee'), 'no fee is recorded that is not known exactly');
  assert.equal(walletsync.statusOf(ws, { now: NOW }).networks[`${w.wallet_id}:base`].history_gap, 0);
});

test('a passing failure to read token details is asked again the next day; the transfer it held back is then recorded', async (t) => {
  const { ws } = setup(t, 'al-metaretry');
  addToken(ws);
  const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const f = chain({ pageSize: 10 });
  f.setMeta('eth', TOKEN, XTKN_META);
  // The transfer listing gives no decimals; the first details request fails.
  const got = f.tx('eth', { from: EXT, to: TOKEN, transfers: [{ category: 'erc20', from: EXT, to: A, contract: TOKEN, raw: wei('42'), decimals: null, log: 0 }], at: NOW - 3 * DAY });
  f.setToken('eth', A, TOKEN, wei('42'));
  f.setBalance('eth', A, '0');
  f.fail((c) => c.method === 'alchemy_getTokenMetadata', reply(200, { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'temporarily unavailable' } }), 1);
  await sync(ws, f);
  let e = wallets.loadEvents(ws, w.wallet_id, 'eth').find((x) => x.tx_hash === got.hash);
  assert.equal(e.amount, null);
  assert.equal(e.ledger.status, 'not_recorded');
  await sync(ws, f, { now: NOW + 13 * HOUR });
  assert.equal(f.calls.filter((c) => c.method === 'alchemy_getTokenMetadata').length, 1, 'not asked again the same day');
  await sync(ws, f, { now: NOW + 26 * HOUR });
  assert.equal(f.calls.filter((c) => c.method === 'alchemy_getTokenMetadata').length, 2, 'asked again the next day');
  e = wallets.loadEvents(ws, w.wallet_id, 'eth').find((x) => x.tx_hash === got.hash);
  assert.equal(e.amount, '42');
  assert.equal(e.ledger.status, 'recorded', 'no longer kept out once its amount is known');
  assert.equal(accountQty(ws, w.account_id, 'xtkn-fictional'), '42');
});

test('any page size, interruption, expired page key and restart reads every transfer exactly once: the same events and ledger as one clean read', async (t) => {
  const build = (f) => {
    f.setMeta('eth', TOKEN, XTKN_META);
    f.setMeta('eth', OTHER, { name: 'Example OTKN (FICTIONAL)', symbol: 'OTKN', decimals: 6 });
    f.send('eth', { from: EXT, to: A, value: '2', at: NOW - 40 * DAY });
    for (let i = 0; i < 4; i++) f.tokenSend('eth', { from: EXT, to: A, raw: wei(String(10 + i)), at: NOW - (35 - i) * DAY, log: i });
    f.tx('eth', { from: EXT, to: ROUTER, transfers: [{ category: 'erc20', from: ROUTER, to: A, contract: OTHER, raw: '1500000', decimals: 6, symbol: 'OTKN', log: 2 }, { category: 'erc20', from: ROUTER, to: A, contract: TOKEN, raw: wei('1'), log: 3 }], at: NOW - 30 * DAY });
    f.tokenSend('eth', { from: A, to: EXT, raw: wei('4'), at: NOW - 25 * DAY, log: 0 });
    f.tokenSend('eth', { from: A, to: A, raw: wei('1'), at: NOW - 24 * DAY, log: 0 });
    f.send('eth', { from: A, to: EXT, value: '0.3', at: NOW - 20 * DAY });
    f.send('eth', { from: A, to: EXT, value: '0.2', at: NOW - 19 * DAY, status: 0 });
    f.tx('eth', { from: A, to: ROUTER, transfers: [{ category: 'external', from: A, to: ROUTER, raw: wei('0.5') }, { category: 'erc20', from: ROUTER, to: A, contract: TOKEN, raw: wei('70'), log: 5 }], logs: [{ address: TOKEN, topic0: TRANSFER }, { address: ROUTER, topic0: SWAP_TOPIC }], at: NOW - 15 * DAY });
    f.tx('eth', { from: A, to: ROUTER, transfers: [{ category: 'external', from: A, to: ROUTER, raw: '0' }, { category: 'erc20', from: A, to: ROUTER, contract: TOKEN, raw: wei('20'), log: 1 }, { category: 'internal', from: ROUTER, to: A, raw: wei('0.05') }], logs: [{ address: TOKEN, topic0: TRANSFER }, { address: ROUTER, topic0: SWAP_TOPIC }], at: NOW - 10 * DAY });
    for (let i = 0; i < 3; i++) f.send('eth', { from: EXT, to: A, value: `0.0${i + 1}`, at: NOW - (8 - i) * DAY });
    f.setBalance('eth', A, wei('1'));
    f.setToken('eth', A, TOKEN, wei('100'));
  };
  const snapshot = (ws, w) => ({
    events: wallets.loadEvents(ws, w.wallet_id, 'eth').map((e) => [e.event_key, e.kind, e.direction, e.amount_raw, e.classification, e.state, e.ledger.status].join('|')).sort(),
    ledger: ledger(ws).map((x) => [x.external_id, x.type, x.asset_id, x.quantity, x.date, Boolean(x.voided)].join('|')).sort(),
  });
  const clean = setup(t, 'al-clean');
  addToken(clean.ws);
  addToken(clean.ws, { symbol: 'OTKN', contract: OTHER });
  const w0 = wallets.addWallet(clean.ws, { label: 'MetaMask', address: A, networks: ['eth'] });
  const f0 = chain({ pageSize: 100 });
  build(f0);
  assert.equal((await sync(clean.ws, f0)).status, 'ok');
  const base = snapshot(clean.ws, w0);
  assert.equal(base.events.filter((x) => x.includes('|fee|')).length, 6, 'one fee per transaction sent');
  assert.ok(base.ledger.length > 8);
  for (const pageSize of [1, 2, 3]) {
    const { ws } = setup(t, `al-chaos-${pageSize}`, { max_pages_per_run: 4, max_receipts_per_run: 5 });
    addToken(ws);
    addToken(ws, { symbol: 'OTKN', contract: OTHER });
    const w = wallets.addWallet(ws, { label: 'MetaMask', address: A, networks: ['eth'] });
    const f = chain({ pageSize });
    build(f);
    // Both attempts of every fifth transfers request fail while the chaos lasts.
    let k = 0;
    let chaos = true;
    f.fail((c) => chaos && c.method === 'alchemy_getAssetTransfers' && [0, 1].includes(++k % 5), new Error('connect ECONNRESET'), 1e9);
    let at = NOW;
    let r = null;
    let runs = 0;
    for (; runs < 120; runs++) {
      if (runs === 30) chaos = false;
      // Mostly a minute apart (the page key lives), every third run later (it has expired).
      at += (runs % 3 === 2 ? 20 : 1) * MIN;
      r = await sync(ws, f, { now: at });
      if (!chaos && r.status === 'ok') break;
    }
    assert.equal(r.status, 'ok', `page size ${pageSize}: ${r.message}`);
    assert.deepEqual(snapshot(ws, w), base, `page size ${pageSize}: same events and ledger as one clean read`);
  }
});
