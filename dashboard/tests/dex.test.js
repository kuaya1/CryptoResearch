'use strict';
// DexScreener in the inspector (public/views/dex.js) and the chart's choice of
// source (public/views/chart.js): which contracts are looked up, the links,
// the one chain-scoped request per contract, the pool kept, the figures shown,
// and when the chart shows the DEX pool. FICTIONAL addresses and pools only;
// fetch is stubbed, so nothing here contacts DexScreener.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { chainInfo } = require('../core/chains');

// The browser modules, loaded as ESM from a copy (as ui-logic.test.js does).
// fetch is stubbed before they load, so a request at import would be seen.
const calls = [];
let answer = () => ({ status: 200, body: [] });
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  const r = await answer(String(url));
  if (r.network) throw new TypeError('fetch failed');
  return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => (r.raw !== undefined ? JSON.parse(r.raw) : r.body) };
};
let tmp;
async function load() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-dex-'));
  fs.cpSync(path.join(__dirname, '..', 'public'), tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{ "type": "module" }');
  const dex = await import(pathToFileURL(path.join(tmp, 'views', 'dex.js')).href);
  const chart = await import(pathToFileURL(path.join(tmp, 'views', 'chart.js')).href);
  return { dex, chart };
}
const mods = load();
test.after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

const ADDR = '0x1111111111111111111111111111111111111111';
const SOL = 'So11111111111111111111111111111111111111112';
const verified = (assets, extra = {}) => ({ project_id: 'xmpl-fictional', symbol: 'XMPL', identity: { status: 'verified', assets, ...extra } });
const pool = (o = {}) => ({
  chainId: 'ethereum',
  dexId: 'uniswap',
  labels: ['v3'],
  pairAddress: '0x2222222222222222222222222222222222222222',
  baseToken: { address: ADDR, symbol: 'XMPL' },
  quoteToken: { address: '0x3333333333333333333333333333333333333333', symbol: 'WETH' },
  priceUsd: '0.27',
  liquidity: { usd: 4200000 },
  volume: { h24: 890000 },
  txns: { h24: { buys: 1240, sells: 890 } },
  fdv: 270000000,
  ...o,
});

test('chains: every DexScreener chain maps from the same chain IDs and names core/chains.js gives assets', async () => {
  const { dex } = await mods;
  assert.ok(dex.DEX_CHAINS.length >= 20);
  for (const c of dex.DEX_CHAINS) {
    const info = chainInfo(c.id);
    assert.ok(info, `${c.slug}: chain ID ${c.id} is one core/chains.js knows`);
    assert.equal(info.label, c.label, c.slug);
    for (const a of c.aliases) assert.equal(chainInfo(a) && chainInfo(a).chain_id, c.id, `${c.slug}: "${a}" means ${c.id} in core/chains.js too`);
  }
  assert.equal(dex.dexChainOf({ chain: 'ethereum', chain_id: '1' }).slug, 'ethereum');
  assert.equal(dex.dexChainOf({ chain: 'BNB Chain ', chain_id: null }), null, 'not an alias: nothing guessed from a similar name');
  assert.equal(dex.dexChainOf({ chain: 'bnb-chain' }).slug, 'bsc', 'a record saved before chain IDs maps by its chain name');
  assert.equal(dex.dexChainOf({ chain: 'ethereum', chain_id: '48900' }), null, 'a chain DexScreener is not matched to here');
  assert.equal(dex.dexChainOf({ chain: 'example-chain' }), null);
});

test('targets: only a verified identity\'s contracts, on chains DexScreener lists, with that chain\'s address shape', async () => {
  const { dex } = await mods;
  const one = dex.dexTargets(verified([{ chain: 'ethereum', chain_id: '1', contract_address: ADDR }]));
  assert.equal(one.state, 'contract');
  assert.deepEqual(one.targets.map((t) => [t.slug, t.address, t.label]), [['ethereum', ADDR, 'Ethereum']]);
  assert.equal(dex.dexTargets({ ...verified([{ chain: 'ethereum', contract_address: ADDR }]), identity: { status: 'pending', assets: [{ chain: 'ethereum', contract_address: ADDR }] } }).state, 'unverified', 'an unverified contract is never used');
  assert.equal(dex.dexTargets(verified([], { native_chain: true })).state, 'native');
  assert.equal(dex.dexTargets(verified([])).state, 'none');
  assert.deepEqual(dex.dexTargets(verified([{ chain: 'example-chain', contract_address: 'FICTIONAL-CONTRACT-XMPL' }])), { state: 'unmatched', targets: [], address: 'FICTIONAL-CONTRACT-XMPL' });
  assert.equal(dex.dexTargets(verified([{ chain: 'ethereum', contract_address: '0x1234' }])).state, 'unmatched', 'a typo is never sent');
  assert.equal(dex.dexTargets(verified([{ chain: 'solana', contract_address: SOL }])).targets[0].slug, 'solana');
  const many = dex.dexTargets(verified([
    { chain: 'ethereum', contract_address: ADDR },
    { chain: 'eth', contract_address: ADDR.toUpperCase().replace('0X', '0x') },
    { chain: 'base', contract_address: ADDR },
    { chain: 'arbitrum', contract_address: ADDR },
    { chain: 'polygon', contract_address: ADDR },
  ]));
  assert.deepEqual(many.targets.map((t) => t.slug), ['ethereum', 'base', 'arbitrum'], 'the same contract once; three at most, in the record\'s order');
});

test('links: the recorded contract\'s DexScreener page; a search for the contract or the ticker otherwise; nothing to link without either', async () => {
  const { dex } = await mods;
  assert.equal(dex.dexLink(verified([{ chain: 'base', contract_address: ADDR }])).href, `https://dexscreener.com/base/${ADDR}`);
  assert.equal(dex.dexLink(verified([{ chain: 'example-chain', contract_address: 'FICTIONAL-1' }])).href, 'https://dexscreener.com/search?q=FICTIONAL-1');
  assert.equal(dex.dexLink(verified([], { native_chain: true })).href, 'https://dexscreener.com/search?q=XMPL');
  const pending = { project_id: 'p', symbol: 'X&Y', identity: { status: 'pending', assets: [{ chain: 'ethereum', contract_address: ADDR }] } };
  assert.equal(dex.dexLink(pending).href, 'https://dexscreener.com/search?q=X%26Y', 'an unverified contract is not linked; the ticker is searched');
  assert.equal(dex.dexLink({ project_id: 'p', symbol: '', identity: { status: 'pending' } }), null);
});

test('pools: only the recorded token\'s pools on its chain (not the same address on PulseChain, not another token); its own markets; none priced far from the token; then the deepest', async () => {
  const { dex } = await mods;
  const t = dex.dexTargets(verified([{ chain: 'ethereum', contract_address: ADDR }])).targets[0];
  const quoted = pool({ baseToken: { address: '0x3333333333333333333333333333333333333333', symbol: 'WETH' }, quoteToken: { address: ADDR.toUpperCase().replace('0X', '0x'), symbol: 'XMPL' }, priceUsd: '3100', liquidity: { usd: 9e6 } });
  const kept = dex.readAnswer([
    pool({ chainId: 'pulsechain', liquidity: { usd: 9e9 } }),
    pool({ baseToken: { address: '0x4444444444444444444444444444444444444444', symbol: 'OTHER' }, liquidity: { usd: 8e9 } }),
    pool({ liquidity: { usd: 50000 }, pairAddress: '0x5555555555555555555555555555555555555555', quoteToken: { address: '0x5555555555555555555555555555555555555555', symbol: 'USDC' } }),
    quoted,
    pool({ liquidity: null, pairAddress: '0x6666666666666666666666666666666666666666' }),
    // A dead pool that prices the token at 100,000 times its price, and its
    // liquidity with it (as UNI/REN did on 2026-10-04).
    pool({ quoteToken: { address: '0x7777777777777777777777777777777777777777', symbol: 'REN' }, priceUsd: '27000', liquidity: { usd: 9e8 }, volume: { h24: 2700000 }, txns: { h24: { buys: 1, sells: 1 } }, pairAddress: '0x7777777777777777777777777777777777777777' }),
    pool({}),
  ], t);
  assert.equal(kept.length, 5);
  assert.equal(dex.readAnswer({ pairs: [pool()] }, t).length, 1, 'the older { pairs } shape reads the same');
  assert.equal(dex.readAnswer('nonsense', t), null);
  for (const refPrice of [0.27, null, 5]) {
    const top = dex.topPool({ pools: kept, fetched_at: '2026-10-04T00:00:00Z' }, [t], { refPrice });
    assert.equal(top.pair, 'XMPL/WETH', `DexScreener's own base/quote order; the deepest sane own market (reference ${refPrice}: CoinGecko's price, else the pools' median)`);
    assert.equal(top.liquidity, 4200000);
    assert.equal(top.count, 3, 'the quoted pool and the mispriced one are not ranked');
    assert.equal(top.leftOut, 1);
    assert.equal(top.volume24hAll, 890000 * 3, 'the mispriced pool\'s volume is not counted either');
  }
  const top = dex.topPool({ pools: kept }, [t], { refPrice: 0.27 });
  assert.equal(top.dex, 'Uniswap v3');
  assert.equal(top.thin, false);
  assert.equal(top.url, 'https://dexscreener.com/ethereum/0x2222222222222222222222222222222222222222');
  assert.equal(Math.round(top.ratio), 64);
  assert.deepEqual([top.buys, top.sells], [1240, 890]);
  assert.equal(dex.topPool({ pools: [quoted] }, [t]).pair, 'WETH/XMPL', 'only quoted elsewhere: those pools are used');
  const two = dex.topPool({ pools: [pool({ priceUsd: '9.07', liquidity: { usd: 16.6e6 } }), pool({ priceUsd: '8877332', liquidity: { usd: 216e6 } })] }, [t]);
  assert.equal(two.liquidity, 16.6e6, 'two pools and no CoinGecko price: the lower middle price is the reference');
  const thin = dex.topPool({ pools: [pool({ liquidity: { usd: 84000 }, fdv: null, txns: {}, pairAddress: 'bad/address', dexId: 'some-new-dex', labels: ['<b>', 'v2'] })] }, [t]);
  assert.equal(thin.thin, true);
  assert.equal(thin.ratio, null);
  assert.deepEqual([thin.buys, thin.sells], [null, null]);
  assert.equal(thin.pairAddress, null, 'a pool address that is not one is never put in a URL');
  assert.equal(thin.url, null);
  assert.equal(thin.dex, 'Some-new-dex v2');
  assert.equal(dex.topPool({ pools: [] }, [t]), null);
  assert.deepEqual([dex.ratioText(64.2), dex.ratioText(1250.4), dex.ratioText(3.14), dex.ratioText(null)], ['64×', '1,250×', '3.1×', '—']);
});

test('lookup: one chain-scoped request per contract, none at import, none twice in flight, the answer reused; failures said in words', async () => {
  const { dex } = await mods;
  assert.equal(calls.length, 0, 'loading the page\'s modules asks DexScreener nothing');
  const targets = dex.dexTargets(verified([{ chain: 'ethereum', contract_address: ADDR }, { chain: 'solana', contract_address: SOL }])).targets;
  answer = (url) => ({ status: 200, body: url.includes('/ethereum/') ? [pool(), pool({ chainId: 'pulsechain' })] : [pool({ chainId: 'solana', baseToken: { address: SOL, symbol: 'XMPL' }, pairAddress: 'Pool1111111111111111111111111111111111111111', liquidity: { usd: 9e6 } })] });
  const heard = [];
  const off = dex.onLookup((ts, a) => heard.push([ts.length, a.pools.length]));
  assert.equal(dex.peekLookup(targets), null);
  const [a, b] = await Promise.all([dex.lookupTargets(targets), dex.lookupTargets(targets)]);
  assert.equal(calls.length, 2, 'one request per contract, though asked twice at once');
  assert.deepEqual(calls.map((c) => c.url).sort(), [`https://api.dexscreener.com/token-pairs/v1/ethereum/${ADDR}`, `https://api.dexscreener.com/token-pairs/v1/solana/${SOL}`]);
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.referrerPolicy, 'no-referrer');
  assert.equal(a.pools.length, 2, 'the PulseChain pool is not the token\'s');
  assert.deepEqual(a, b);
  assert.equal(dex.topPool(a, targets).slug, 'solana', 'the deepest pool across the recorded chains');
  assert.equal(dex.topPool(a, targets).multiChain, true);
  assert.ok(dex.peekLookup(targets));
  await dex.lookupTargets(targets);
  assert.equal(calls.length, 2, 'reused, not asked again');
  assert.deepEqual(heard[0], [2, 2]);
  off();
  const lone = dex.dexTargets(verified([{ chain: 'base', contract_address: ADDR }])).targets;
  answer = () => ({ status: 429, body: null });
  await assert.rejects(dex.lookupTargets(lone), /limiting requests/);
  answer = () => ({ network: true });
  await assert.rejects(dex.lookupTargets(lone), /could not be reached/);
  answer = () => ({ status: 200, raw: '<html>' });
  await assert.rejects(dex.lookupTargets(lone), /could not be read/);
  answer = () => ({ status: 200, body: [] });
  assert.deepEqual((await dex.lookupTargets(lone)).pools, [], 'a failure is not kept: the next ask is sent');
});

test('chart: your switch, then your own TradingView symbol, then the DEX pool when DEXs carry half the volume, else the ticker guess', async () => {
  const { chart } = await mods;
  const p = { slug: 'ethereum', pairAddress: '0x2222222222222222222222222222222222222222', pair: 'XMPL/WETH', dex: 'Uniswap v3', volume24hAll: 600 };
  const set = { symbol: 'COINBASE:XMPLUSD', source: 'set' };
  const guess = { symbol: 'BINANCE:XMPLUSDT', source: 'ticker' };
  const none = { symbol: null, source: null };
  assert.equal(chart.chooseSource({ tv: set, pool: p, share: 1 }), 'tradingview');
  assert.equal(chart.chooseSource({ tv: set, pool: p, share: 1, choice: 'dexscreener' }), 'dexscreener');
  assert.equal(chart.chooseSource({ tv: guess, pool: p, share: 0.6 }), 'dexscreener');
  assert.equal(chart.chooseSource({ tv: guess, pool: p, share: null }), 'dexscreener', 'no CoinGecko volume: the pool, bound to the contract, before a guess');
  assert.equal(chart.chooseSource({ tv: guess, pool: p, share: 0.2 }), 'tradingview', 'mainly traded on exchanges');
  assert.equal(chart.chooseSource({ tv: guess, pool: p, share: 0.9, choice: 'tradingview' }), 'tradingview');
  assert.equal(chart.chooseSource({ tv: guess, pool: null }), 'tradingview');
  assert.equal(chart.chooseSource({ tv: none, pool: p, share: 0 }), 'dexscreener');
  assert.equal(chart.chooseSource({ tv: none, pool: null }), null);
  assert.equal(chart.chooseSource({ tv: guess, pool: { ...p, pairAddress: null }, share: 1 }), 'tradingview', 'a pool without a usable address is not charted');
  assert.equal(chart.dexShare(p, 1000), 0.6);
  assert.equal(chart.dexShare(p, null), null);
  assert.equal(chart.dexShare({ ...p, volume24hAll: null }, 1000), null);
  assert.equal(chart.dexEmbedUrl(p), 'https://dexscreener.com/ethereum/0x2222222222222222222222222222222222222222?embed=1&theme=light&trades=0&info=0&chartTheme=light&interval=1D');
  assert.match(chart.dexEmbedUrl(p, 'dark'), /theme=dark&trades=0&info=0&chartTheme=dark/);
  assert.equal(chart.dexEmbedUrl({ ...p, slug: 'pulsechain' }), null, 'only a chain the desk maps');
  assert.equal(chart.dexEmbedUrl({ ...p, pairAddress: '../../x' }), null);
});
