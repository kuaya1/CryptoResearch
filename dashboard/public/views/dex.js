// DexScreener in the project inspector: the header's DexScreener link (drawn
// by views/watchlist.js headLinks from dexLink), the DEX liquidity card at the
// top of the inspector, and the pool the technical chart shows for a token
// that trades mainly on DEXs (views/chart.js).
//
// Asked by this browser, on demand only: when an inspector rests on a project
// whose verified identity records a contract on a chain DexScreener lists.
// Never on page load, never in the background, never by the server, and
// nothing is saved to the records. The page's Content-Security-Policy allows
// that one API origin (server.js).
//
// The lookup is chain-scoped: GET
// https://api.dexscreener.com/token-pairs/v1/<chain>/<address>. The
// cross-chain endpoint (latest/dex/tokens/<address>) also answers with pools
// of other tokens that share the address on another chain: every Ethereum
// address exists on PulseChain as a different token, and for Ethereum tokens
// those pools came first (checked 2026-10-04). Only pools whose base or quote
// token is the recorded contract on its recorded chain are kept; the deepest
// by liquidity is the top pool.
import { h, button, fmtCompactUsd, fmtDateTime, fmtPrice } from '../ui.js';

const API = 'https://api.dexscreener.com/token-pairs/v1/';
const SITE = 'https://dexscreener.com/';
// Quick J/K presses never send a request for every project passed on the way.
const LOOKUP_DELAY_MS = 250;
// A lookup is reused for two minutes (redraws, coming back to a project).
const FRESH_MS = 120000;
// A pool below this is thin: a trade of any size moves its price.
export const THIN_USD = 100000;
// Above this share of the 24h volume on DEX pools, the token trades mainly
// on DEXs and the chart shows its pool (views/chart.js).
export const DEX_MAIN_SHARE = 0.5;
const MAX_CONTRACTS = 3;

// DexScreener's chain names for the chain IDs core/chains.js gives assets,
// with the chain names it accepts for them (the same aliases, so a record
// saved before chain IDs existed maps the same way; tests/dex.test.js keeps
// the two in step). Each DexScreener name was seen in its API's answers on
// 2026-10-04. A chain not listed here is not looked up: nothing is guessed
// from a similar name.
const CHAINS = [
  ['ethereum', '1', 'Ethereum', 'ethereum', 'eth', 'mainnet', 'ethereum-mainnet', 'erc20', 'erc-20'],
  ['bsc', '56', 'BNB Smart Chain', 'bsc', 'bnb', 'bnb-chain', 'bnbchain', 'bnb-smart-chain', 'binance-smart-chain', 'binance', 'bep20', 'bep-20'],
  ['arbitrum', '42161', 'Arbitrum One', 'arbitrum', 'arbitrum-one', 'arb'],
  ['polygon', '137', 'Polygon', 'polygon', 'polygon-pos', 'matic'],
  ['zksync', '324', 'zkSync Era', 'zksync', 'zksync-era'],
  ['linea', '59144', 'Linea', 'linea'],
  ['base', '8453', 'Base', 'base'],
  ['mantle', '5000', 'Mantle', 'mantle'],
  ['unichain', '130', 'Unichain', 'unichain'],
  ['scroll', '534352', 'Scroll', 'scroll'],
  ['optimism', '10', 'Optimism', 'optimism', 'op-mainnet', 'op'],
  ['avalanche', '43114', 'Avalanche C-Chain', 'avalanche', 'avax', 'avalanche-c', 'avalanche-c-chain'],
  ['cronos', '25', 'Cronos', 'cronos'],
  ['soneium', '1868', 'Soneium', 'soneium'],
  ['monad', '143', 'Monad', 'monad'],
  ['plasma', '9745', 'Plasma', 'plasma'],
  ['robinhood', '4663', 'Robinhood Chain', 'robinhood', 'robinhood-chain'],
  ['sonic', '146', 'Sonic', 'sonic'],
  ['abstract', '2741', 'Abstract', 'abstract'],
  ['berachain', '80094', 'Berachain', 'berachain', 'bera'],
  ['worldchain', '480', 'World Chain', 'world-chain', 'worldchain'],
  ['merlinchain', '4200', 'Merlin', 'merlin'],
  ['manta', '169', 'Manta Pacific', 'manta', 'manta-pacific'],
  ['blast', '81457', 'Blast', 'blast'],
  ['tron', 'tron', 'Tron', 'tron', 'trx', 'trc20', 'trc-20'],
  ['solana', 'solana', 'Solana', 'solana', 'sol', 'spl'],
];
export const DEX_CHAINS = CHAINS.map(([slug, id, label, ...aliases]) => ({ slug, id, label, aliases }));
const BY_ID = new Map(DEX_CHAINS.map((c) => [c.id, c]));
const BY_ALIAS = new Map(DEX_CHAINS.flatMap((c) => c.aliases.map((a) => [a, c])));

// Address shapes (core/chains.js), so a typo is never sent.
const SHAPE = {
  evm: /^0x[0-9a-fA-F]{40}$/,
  tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
};
const familyOf = (chain) => (chain.id === 'solana' || chain.id === 'tron' ? chain.id : 'evm');
// EVM addresses compare lowercased; base58 is case-sensitive.
const addressKey = (family, a) => (family === 'evm' ? String(a).toLowerCase() : String(a));
const shortAddr = (a) => (a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '');

// The chain an asset is on, as DexScreener names it, or null.
export function dexChainOf(asset) {
  if (!asset) return null;
  const id = asset.chain_id === null || asset.chain_id === undefined ? '' : String(asset.chain_id);
  if (id && BY_ID.has(id)) return BY_ID.get(id);
  if (id) return null;
  return BY_ALIAS.get(String(asset.chain || '').trim().toLowerCase()) || null;
}

// What DexScreener can be asked about a project, from its record:
//   contract    a verified identity with contracts on chains DexScreener
//               lists (targets: up to three, in the record's order)
//   unmatched   verified contracts, none on such a chain (or none with the
//               chain's address shape); address: the first one
//   native      verified as its chain's native coin: no token contract
//   none        verified, no contract on record
//   unverified  the identity is not verified: its contracts are not used
// Pure, for the tests.
export function dexTargets(project) {
  const id = (project && project.identity) || {};
  if (id.status !== 'verified') return { state: 'unverified', targets: [] };
  const assets = (Array.isArray(id.assets) ? id.assets : []).filter((a) => a && typeof a.contract_address === 'string' && a.contract_address.trim());
  if (!assets.length) return { state: id.native_chain === true ? 'native' : 'none', targets: [] };
  const targets = [];
  const seen = new Set();
  for (const a of assets) {
    const chain = dexChainOf(a);
    const address = a.contract_address.trim();
    if (!chain || !SHAPE[familyOf(chain)].test(address)) continue;
    const family = familyOf(chain);
    const key = `${chain.slug}:${addressKey(family, address)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ slug: chain.slug, label: chain.label, family, address, key });
    if (targets.length === MAX_CONTRACTS) break;
  }
  if (targets.length) return { state: 'contract', targets };
  return { state: 'unmatched', targets: [], address: assets[0].contract_address.trim() };
}

const tickerOf = (project) => String((project && project.symbol) || '').trim();

// The header's DEX link: the recorded contract's DexScreener page, else a
// DexScreener search for that contract (a chain DexScreener is not matched
// to here) or for the ticker (no verified contract, a native coin). Pure.
export function dexLink(project) {
  const t = dexTargets(project);
  if (t.state === 'contract') {
    const x = t.targets[0];
    return { href: `${SITE}${x.slug}/${encodeURIComponent(x.address)}`, title: `DexScreener: ${x.label} ${shortAddr(x.address)}`, aria: `DexScreener page of the contract on ${x.label}`, exact: true };
  }
  const q = t.state === 'unmatched' ? t.address : tickerOf(project);
  if (!q) return null;
  return { href: `${SITE}search?q=${encodeURIComponent(q)}`, title: t.state === 'unmatched' ? `Search DexScreener for the contract ${shortAddr(q)}` : `Search DexScreener for ${q}`, aria: `Search DexScreener for ${t.state === 'unmatched' ? 'the contract' : q}`, exact: false };
}

// ---- the lookup -------------------------------------------------------------

// Whether a pool is the recorded token's: on its chain, with the contract as
// its base or quote token.
function ownPool(p, t) {
  if (!p || p.chainId !== t.slug) return false;
  const want = addressKey(t.family, t.address);
  return [p.baseToken, p.quoteToken].some((x) => x && typeof x.address === 'string' && addressKey(t.family, x.address) === want);
}

// DexScreener's answer for one contract, as kept: its own pools only. Pure.
export function readAnswer(body, t) {
  const list = Array.isArray(body) ? body : body && Array.isArray(body.pairs) ? body.pairs : null;
  if (!list) return null;
  return list.filter((p) => ownPool(p, t));
}

const cache = new Map();
const listeners = new Set();

function fetchTarget(t) {
  const hit = cache.get(t.key);
  if (hit && hit.promise) return hit.promise;
  if (hit && hit.result && Date.now() - hit.at < FRESH_MS) return Promise.resolve(hit.result);
  const promise = fetch(`${API}${t.slug}/${encodeURIComponent(t.address)}`, { headers: { Accept: 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' })
    .then(async (res) => {
      if (res.status === 429) throw new Error('DexScreener is limiting requests: try again in a minute.');
      if (!res.ok) throw new Error(`DexScreener answered ${res.status}.`);
      let body;
      try {
        body = await res.json();
      } catch (_) {
        body = null;
      }
      const pools = readAnswer(body, t);
      if (!pools) throw new Error('DexScreener\'s answer could not be read.');
      return { pools, fetched_at: new Date().toISOString() };
    })
    .then((result) => {
      cache.set(t.key, { at: Date.now(), result });
      return result;
    }, (err) => {
      cache.delete(t.key);
      throw err instanceof TypeError ? new Error('DexScreener could not be reached.') : err;
    });
  cache.set(t.key, { promise });
  return promise;
}

const merge = (results) => ({ pools: results.flatMap((r) => r.pools), fetched_at: results.map((r) => r.fetched_at).sort()[0] });

// The pools of a project's contracts (one request per contract, at most one in
// flight each, reused for FRESH_MS); listeners hear every answer.
export function lookupTargets(targets) {
  return Promise.all(targets.map(fetchTarget)).then((results) => {
    const out = merge(results);
    for (const fn of listeners) fn(targets, out);
    return out;
  });
}

// The answer already at hand for these contracts, or null (never a request).
export function peekLookup(targets) {
  const now = Date.now();
  const hits = targets.map((t) => cache.get(t.key));
  if (!targets.length || hits.some((x) => !x || !x.result || now - x.at >= FRESH_MS)) return null;
  return merge(hits.map((x) => x.result));
}

// Called with (targets, answer) whenever a lookup answers; returns a remover.
export function onLookup(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const sameTargets = (a, b) => a.length === b.length && a.every((t, i) => t.key === b[i].key);

// ---- the top pool -----------------------------------------------------------

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const count = (v) => {
  const n = num(v);
  return n !== null && n >= 0 ? Math.round(n) : null;
};
const liquidityOf = (p) => num(p && p.liquidity && p.liquidity.usd);
const DEX_NAMES = { uniswap: 'Uniswap', pancakeswap: 'PancakeSwap', sushiswap: 'SushiSwap', raydium: 'Raydium', orca: 'Orca', meteora: 'Meteora', aerodrome: 'Aerodrome', velodrome: 'Velodrome', curve: 'Curve', balancer: 'Balancer', traderjoe: 'Trader Joe', camelot: 'Camelot', quickswap: 'QuickSwap', pumpswap: 'PumpSwap', fluxbeam: 'FluxBeam', sunswap: 'SunSwap', syncswap: 'SyncSwap', lynex: 'Lynex', thena: 'Thena', biswap: 'Biswap', kyberswap: 'KyberSwap', fraxswap: 'Fraxswap', maverick: 'Maverick', lfj: 'LFJ', shadow: 'Shadow', swapx: 'SwapX' };
function dexName(id, labels) {
  const raw = String(id || '').trim();
  const name = DEX_NAMES[raw.toLowerCase()] || (raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : 'DEX');
  const tags = (Array.isArray(labels) ? labels : []).filter((x) => typeof x === 'string' && /^[\w.-]{1,12}$/.test(x));
  return [name, ...tags].join(' ').slice(0, 40);
}
const symbolOf = (tok) => String((tok && tok.symbol) || '?').trim().slice(0, 16) || '?';
const POOL_ADDRESS = /^[A-Za-z0-9]{20,100}$/;
const priceOf = (p) => num(p && p.priceUsd);
const median = (list) => (list.length ? [...list].sort((a, b) => a - b)[Math.floor((list.length - 1) / 2)] : null);
// A pool whose price for the token is more than this factor away from the
// token's price is mispriced, and its liquidity with it (a dead pool once
// listed UNI at $8.9M and $216M of liquidity on 2 trades a day).
const PRICE_BAND = 2;

// The pools to choose from: the token's own markets (it is the base token)
// when it has any, else the pools that quote it; and of its own markets only
// those priced within PRICE_BAND of the token's price, which is CoinGecko's on
// the desk when the pools agree with it, else the median of the pools'.
// Pure.
export function poolsToRank(pools, targets = [], refPrice = null) {
  const isBase = (p) => targets.some((t) => p && p.chainId === t.slug && p.baseToken && typeof p.baseToken.address === 'string' && addressKey(t.family, p.baseToken.address) === addressKey(t.family, t.address));
  const base = pools.filter(isBase);
  if (!base.length) return { kept: pools, left_out: 0, ref: null };
  const within = (ref) => base.filter((p) => {
    const v = priceOf(p);
    return v !== null && v > 0 && v >= ref / PRICE_BAND && v <= ref * PRICE_BAND;
  });
  const prices = base.map(priceOf).filter((v) => v !== null && v > 0);
  for (const ref of [typeof refPrice === 'number' && refPrice > 0 ? refPrice : null, median(prices)]) {
    if (ref === null) continue;
    const kept = within(ref);
    if (kept.length) return { kept, left_out: base.length - kept.length, ref };
  }
  return { kept: base, left_out: 0, ref: null };
}

// The deepest of those pools and what the card and the chart show of it, or
// null when there is none. Liquidity unknown sorts last. Pure.
export function topPool(answer, targets = [], { refPrice = null } = {}) {
  const all = answer && Array.isArray(answer.pools) ? answer.pools : [];
  if (!all.length) return null;
  const { kept: pools, left_out: leftOut, ref } = poolsToRank(all, targets, refPrice);
  const sorted = [...pools].sort((a, b) => (liquidityOf(b) ?? -1) - (liquidityOf(a) ?? -1));
  const p = sorted[0];
  const chain = DEX_CHAINS.find((c) => c.slug === p.chainId) || null;
  const pairAddress = typeof p.pairAddress === 'string' && POOL_ADDRESS.test(p.pairAddress) ? p.pairAddress : null;
  const liquidity = liquidityOf(p);
  const fdv = num(p.fdv);
  const volumes = pools.map((x) => num(x && x.volume && x.volume.h24)).filter((v) => v !== null);
  const tx = (p.txns && p.txns.h24) || {};
  return {
    slug: p.chainId,
    chain: chain ? chain.label : p.chainId,
    dex: dexName(p.dexId, p.labels),
    pair: `${symbolOf(p.baseToken)}/${symbolOf(p.quoteToken)}`,
    pairAddress,
    url: pairAddress ? `${SITE}${p.chainId}/${pairAddress}` : null,
    liquidity,
    thin: liquidity !== null && liquidity < THIN_USD,
    volume24h: num(p.volume && p.volume.h24),
    buys: count(tx.buys),
    sells: count(tx.sells),
    fdv,
    ratio: fdv !== null && liquidity !== null && liquidity > 0 ? fdv / liquidity : null,
    count: pools.length,
    // Pools left out for a price far from the token's, and that price.
    leftOut,
    refPrice: ref,
    // The 24h volume of the pools kept, together, for the chart's choice.
    volume24hAll: volumes.length ? volumes.reduce((s, v) => s + v, 0) : null,
    multiChain: targets.length > 1,
  };
}

// FDV over the pool's liquidity, as "64×". Pure.
export function ratioText(r) {
  if (r === null || r === undefined || !Number.isFinite(r)) return '—';
  return `${r >= 100 ? Math.round(r).toLocaleString('en-US') : r >= 10 ? r.toFixed(0) : r.toFixed(1)}×`;
}

const n = (v) => (v === null ? '—' : v.toLocaleString('en-US'));

// ---- the card ---------------------------------------------------------------

let currentCard = null;

function noteLine(text, extra = null) {
  return h('p', { class: 'dexc-note' }, h('span', null, text), extra);
}

// While DexScreener is asked: the card's own rows with placeholder bars, the
// same height as the answer, so nothing below it moves when it arrives.
function skeleton() {
  const row = (k, wide = false) => h('div', { class: wide ? 'wide' : null }, h('dt', null, k), h('dd', null, h('span', { class: 'dexc-bar' }), ' '));
  return h('dl', { class: 'dexc-grid dexc-skel', 'aria-hidden': 'true' },
    row('Top pool', true), row('Pool liquidity'), row('24h volume'), row('Trades 24h', true), row('FDV / liquidity', true));
}

function draw(c, answer) {
  const pool = topPool(answer, c.targets, { refPrice: c.refPrice });
  c.el.removeAttribute('aria-busy');
  c.source.href = pool && pool.url ? pool.url : dexLink(c.project).href;
  c.source.title = `DexScreener, asked by this browser ${fmtDateTime(answer.fetched_at)}`;
  if (!pool) {
    c.state = 'drawn';
    c.body.replaceChildren(noteLine('No decentralized liquidity pool indexed'));
    return;
  }
  const item = (k, v, { wide = false, cls = null, title = null, label = null } = {}) => h('div', { class: wide ? 'wide' : null },
    h('dt', null, k), h('dd', { class: cls, title, 'aria-label': label }, v));
  const liq = pool.liquidity === null ? '—' : fmtCompactUsd(pool.liquidity);
  c.state = 'drawn';
  c.body.replaceChildren(h('dl', { class: 'dexc-grid' },
    item(`Top pool${pool.count > 1 ? ` (of ${pool.count})` : ''}`, `${pool.dex} · ${pool.pair}${pool.multiChain ? ` · ${pool.chain}` : ''}`, { wide: true, title: `${pool.chain}${pool.pairAddress ? ` · ${pool.pairAddress}` : ''}${pool.leftOut ? `\n${pool.leftOut} more pool${pool.leftOut === 1 ? '' : 's'} left out: priced over ${PRICE_BAND}× away from the token's price (${fmtPrice(pool.refPrice)})` : ''}` }),
    item('Pool liquidity', pool.thin ? [liq, h('span', { class: 'dexc-thin' }, ' · thin')] : liq, { cls: pool.thin ? 'thin' : null, title: pool.thin ? `Below ${fmtCompactUsd(THIN_USD)}: a trade of any size moves the price` : null, label: pool.thin ? `${liq}, thin: below ${fmtCompactUsd(THIN_USD)}` : null }),
    item('24h volume', pool.volume24h === null ? '—' : fmtCompactUsd(pool.volume24h)),
    item('Trades 24h', pool.buys === null && pool.sells === null ? '—' : `▲ ${n(pool.buys)} buys / ▼ ${n(pool.sells)} sells`, { wide: true, label: `${n(pool.buys)} buys and ${n(pool.sells)} sells in 24 hours` }),
    item('FDV / liquidity', ratioText(pool.ratio), { wide: true, title: pool.fdv === null ? 'DexScreener gives no FDV for this pool' : `DexScreener's FDV ${fmtCompactUsd(pool.fdv)} over this pool's liquidity` })));
}

function fail(c, err) {
  c.state = 'failed';
  c.el.removeAttribute('aria-busy');
  const retry = button('Retry', () => {
    c.el.setAttribute('aria-busy', 'true');
    c.body.replaceChildren(skeleton());
    run(c, true);
  }, { kind: 'small quiet', key: `dex-retry-${c.project.project_id}` });
  c.body.replaceChildren(noteLine(err && err.message ? err.message : 'DexScreener could not be reached.', retry));
}

// Asks DexScreener for the card's contracts, unless the inspector has moved
// on (or closed) since: then nothing is sent.
function run(c, now = false) {
  c.timer = null;
  if (currentCard !== c || (!now && !c.el.isConnected)) return;
  c.state = 'asked';
  lookupTargets(c.targets).then((answer) => {
    if (currentCard === c) draw(c, answer);
  }, (err) => {
    if (currentCard === c) fail(c, err);
  });
}

function schedule(c) {
  clearTimeout(c.timer);
  c.timer = setTimeout(() => run(c), LOOKUP_DELAY_MS);
}

// The token's price on the desk (CoinGecko's, from the index row), the
// reference a pool's price is checked against; null when there is none.
export function deskPrice(ctx, pid) {
  const row = ctx && ctx.state && ctx.state.index && Array.isArray(ctx.state.index.projects) ? ctx.state.index.projects.find((x) => x.project_id === pid) : null;
  const m = row && row.market;
  return m && m.status !== 'invalid' && typeof m.price_usd === 'number' && m.price_usd > 0 ? m.price_usd : null;
}

// The card for one project: the same element while the project and its
// contracts are the same, so a redraw neither asks again nor flickers. Null
// (no card) without a verified contract on a chain DexScreener lists.
export function dexCard(ctx, project) {
  const t = dexTargets(project);
  if (t.state !== 'contract') {
    if (currentCard) clearTimeout(currentCard.timer);
    currentCard = null;
    return null;
  }
  const key = `${project.project_id}|${t.targets.map((x) => x.key).join(',')}`;
  if (currentCard && currentCard.key === key) {
    // Shown again before it asked (the inspector closed within the delay):
    // it asks once it rests here.
    if (currentCard.state === 'waiting' && !currentCard.timer) schedule(currentCard);
    return currentCard.el;
  }
  if (currentCard) clearTimeout(currentCard.timer);
  const source = h('a', { class: 'dexc-src', href: dexLink(project).href, target: '_blank', rel: 'noopener noreferrer', dataset: { key: `dex-src-${project.project_id}` } }, 'DexScreener');
  const body = h('div', { class: 'dexc-body' }, skeleton());
  const el = h('section', { class: 'dexc', 'aria-label': 'DEX liquidity, from DexScreener', 'aria-busy': 'true' },
    h('div', { class: 'dexc-head' }, h('h3', null, 'DEX liquidity'), source),
    body);
  const c = { key, el, body, source, targets: t.targets, project, refPrice: deskPrice(ctx, project.project_id), timer: null, state: 'waiting' };
  currentCard = c;
  const cached = peekLookup(t.targets);
  if (cached) draw(c, cached);
  else schedule(c);
  return el;
}
