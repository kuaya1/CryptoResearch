'use strict';
// Executable exit quotes for the forensic monitor (forensic-monitor.js): what
// selling a hypothetical position of a project's token for USDC would receive,
// asked of a keyless public aggregator at a fixed origin. A quote, never a
// trade: nothing is signed, approved or sent, no wallet or taker address is
// given, and no transaction is built or requested.
//
//   Solana   Jupiter, GET https://api.jup.ag/swap/v1/quote (keyless requests
//            on api.jup.ag at 0.5 a second; docs and a live answer checked
//            2026-10-16). priceImpactPct is a fraction (0.177 for a 17.7%
//            loss), so it is multiplied by 100 here.
//   EVM      KyberSwap Aggregator, GET https://aggregator-api.kyberswap.com/
//            <chain>/api/v1/routes with x-client-id (public limit 3 requests a
//            second; docs and a live answer checked 2026-10-16), on the chains
//            listed below.
//
// Only the chains Eric approves per project (forensics.js setMonitoring,
// profile targets.exit_quotes) are asked, and only for a contract in the
// project's verified identity. Sizes are the exit sizes in his preferences
// turned into token amounts with CoinGecko's price as this desk stored it (no
// older than quote_price_max_age_hours) and the token's decimals from
// CoinGecko's /coins/{id} detail_platforms for that exact contract. The quote
// currency is the chain's native USDC at Circle's published address, valued
// at $1.00.
//
// Each answer at each size is one observation (kind executable_quote,
// route_scope aggregator) read by forensic-model.js liquidityReadings
// unchanged. "No route" is recorded only when the aggregator says it searched
// and found none at that size; a token it does not list, a refused size, an
// error, a timeout or a rate limit is no reading (unknown), never a cost.

const { chainInfo, addressFits, addressKey } = require('./chains');
const { sha256 } = require('./fsx');

const HOUR = 3600000;
const MAX_ANSWER_BYTES = 512 * 1024;
const DECIMALS_FRESH_DAYS = 30;
const NEVER_A_TRADE = 'A quote only: nothing was signed, approved or sent, and no wallet was given.';
const DETAIL_Q = '?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false';

// Circle's native USDC (developers.circle.com/stablecoins/usdc-contract-addresses,
// checked 2026-10-16), 6 decimals on each chain here.
const usdc = (address) => Object.freeze({ symbol: 'USDC', address, decimals: 6 });

const PROVIDERS = Object.freeze({
  jupiter: Object.freeze({
    id: 'jupiter',
    label: 'Jupiter',
    origin: 'https://api.jup.ag',
    docs: 'https://developers.jup.ag/docs/swap/get-quote',
    limit: 'keyless, 0.5 requests a second',
    min_interval_ms: 2100,
    chains: Object.freeze({
      solana: Object.freeze({ quote: usdc('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') }),
    }),
  }),
  kyberswap: Object.freeze({
    id: 'kyberswap',
    label: 'KyberSwap',
    origin: 'https://aggregator-api.kyberswap.com',
    docs: 'https://docs.kyberswap.com/developer-guide/aggregator-api',
    limit: 'keyless with a client ID, 3 requests a second',
    min_interval_ms: 400,
    client_id: 'CryptoResearch-desk',
    chains: Object.freeze({
      1: Object.freeze({ path: 'ethereum', quote: usdc('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48') }),
      8453: Object.freeze({ path: 'base', quote: usdc('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913') }),
      42161: Object.freeze({ path: 'arbitrum', quote: usdc('0xaf88d065e77c8cC2239327C5EDb3A432268e5831') }),
      10: Object.freeze({ path: 'optimism', quote: usdc('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85') }),
      137: Object.freeze({ path: 'polygon', quote: usdc('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359') }),
      43114: Object.freeze({ path: 'avalanche', quote: usdc('0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E') }),
      59144: Object.freeze({ path: 'linea', quote: usdc('0x176211869cA2b568f2A7D4EE941E073a821EE1ff') }),
      130: Object.freeze({ path: 'unichain', quote: usdc('0x078D782b760474a361dDA0AF3839290b0EF57AD6') }),
      146: Object.freeze({ path: 'sonic', quote: usdc('0x29219dd400f2Bf60E5a23d13Be72B486D4038894') }),
    }),
  }),
});

// The provider that quotes a chain (by chains.js chain_id), or null.
function providerFor(chainId) {
  for (const p of Object.values(PROVIDERS)) if (p.chains[chainId]) return { provider: p, chain: p.chains[chainId] };
  return null;
}

// The chains a quote can be asked on, in words (the tab and the packet).
const EVM_ORDER = ['1', '8453', '42161', '10', '137', '43114', '59144', '130', '146'];
function coverageWords() {
  const label = (id) => (chainInfo(id) || { label: id }).label;
  return `Solana through Jupiter; ${EVM_ORDER.filter((id) => PROVIDERS.kyberswap.chains[id]).map(label).join(', ')} through KyberSwap`;
}

const targetIdOf = (key) => `xq_${sha256(String(key)).slice(0, 12)}`;

// What can be quoted for a project: each contract in its identity with the
// quote source for its chain, or why it cannot be. Pure.
function quoteOptions(project) {
  const id = (project && project.identity) || {};
  const verified = id.status === 'verified' && typeof id.coingecko_id === 'string' && id.coingecko_id;
  const seen = new Set();
  const out = [];
  for (const a of Array.isArray(id.assets) ? id.assets : []) {
    const addr = typeof a.contract_address === 'string' ? a.contract_address.trim() : '';
    const info = chainInfo(a.chain);
    const base = { chain: a.chain || null, chain_label: info ? info.label : a.chain || 'Unknown chain', contract_address: addr || null, key: null, target_id: null, supported: false };
    if (!info) {
      out.push({ ...base, reason: `${a.chain || 'This chain'} is not a chain this desk recognizes.` });
      continue;
    }
    const p = providerFor(info.chain_id);
    if (!p) {
      out.push({ ...base, chain_id: info.chain_id, reason: `No keyless aggregator quote source on ${info.label} in this release.` });
      continue;
    }
    if (!addressFits(info.family, addr)) {
      out.push({ ...base, chain_id: info.chain_id, reason: `The contract on file does not have the address shape ${info.label} uses.` });
      continue;
    }
    const key = `${info.chain_id}:${addressKey(info.family, addr)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const row = { ...base, key, target_id: targetIdOf(key), chain_id: info.chain_id, family: info.family, provider: p.provider.id, provider_label: p.provider.label, quote_symbol: p.chain.quote.symbol };
    if (addressKey(info.family, addr) === addressKey(info.family, p.chain.quote.address)) out.push({ ...row, reason: 'This contract is the quote currency itself.' });
    else if (!verified) out.push({ ...row, reason: 'The identity is not verified with a CoinGecko ID, so no exit size can be set.' });
    else out.push({ ...row, supported: true, reason: null });
  }
  return out;
}

// A token amount in base units (a decimal integer string), from a whole-token
// amount and the token's decimals; 15 significant digits are kept and the rest
// is cut, never rounded up. null when nothing would be sold.
function toBaseUnits(tokens, decimals) {
  if (!(typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const [mant, e] = tokens.toExponential(14).split('e');
  const digits = mant.replace('.', '');
  const exp = Number(e) - 14 + decimals;
  const s = (exp >= 0 ? digits + '0'.repeat(exp) : digits.slice(0, Math.max(0, digits.length + exp))).replace(/^0+/, '');
  return s || null;
}

const unitsToNumber = (s, decimals) => (typeof s === 'string' && /^\d{1,60}$/.test(s) ? Number(s) / 10 ** decimals : null);
const num = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const clean = (s, max = 200) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const round = (x, d) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);
const isoOf = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Requests (fixed origins, no redirects, bounded answers)

async function getJson(url, origin, { fetchImpl, timeoutMs, headers }) {
  const u = new URL(url);
  if (u.origin !== origin || u.protocol !== 'https:') throw new Error('Unexpected origin');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(u.toString(), { headers, signal: ctrl.signal, redirect: 'error' });
    const text = await res.text();
    if (text.length > MAX_ANSWER_BYTES) throw new Error('Answer too large');
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
    return { status: res.status, body, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

// When a 429 says to come back: Retry-After (seconds), KyberSwap's
// x-ratelimit-reset-after (seconds) or Jupiter's x-ratelimit-reset (Unix
// seconds); otherwise 10 minutes. At least a minute, at most a day.
function rateLimitUntil(res, now) {
  if (!res || res.status !== 429) return null;
  const h = (k) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(k) : null);
  const ra = Number(h('retry-after'));
  const after = Number(h('x-ratelimit-reset-after'));
  const reset = Number(h('x-ratelimit-reset'));
  let until = now + 10 * 60000;
  if (Number.isFinite(ra) && ra > 0) until = now + ra * 1000;
  else if (Number.isFinite(after) && after > 0) until = now + after * 1000;
  else if (Number.isFinite(reset) && reset * 1000 > now) until = reset * 1000;
  return Math.min(Math.max(until, now + 60000), now + 24 * HOUR);
}

function requestUrl(p, chain, { token, amountIn }) {
  if (p.id === 'jupiter') {
    // ExactIn is the default; every route is allowed (no intermediate-token
    // restriction), so the quote is the aggregator's best, not a narrowed one.
    const q = new URLSearchParams({ inputMint: token, outputMint: chain.quote.address, amount: amountIn, slippageBps: '50' });
    return `${p.origin}/swap/v1/quote?${q}`;
  }
  const q = new URLSearchParams({ tokenIn: token, tokenOut: chain.quote.address, amountIn });
  return `${p.origin}/${chain.path}/api/v1/routes?${q}`;
}

function headersFor(p) {
  const h = { accept: 'application/json', 'user-agent': 'CryptoResearch-desk/1' };
  if (p.client_id) h['x-client-id'] = p.client_id;
  return h;
}

// ---------------------------------------------------------------------------
// Answers, read strictly: an answer that does not match the request is not used.

const JUP_NO_ROUTE = new Set(['NO_ROUTES_FOUND', 'COULD_NOT_FIND_ANY_ROUTE', 'ROUTE_PLAN_DOES_NOT_CONSUME_ALL_THE_AMOUNT']);
const JUP_NOT_LISTED = new Set(['TOKEN_NOT_TRADABLE']);
const KYBER_NO_ROUTE = new Set([4008, 4010]);
const KYBER_NOT_LISTED = new Set([4011]);

function errorOf(res, words) {
  return { status: 'error', transient: res.status >= 500 || res.status === 0, http_status: res.status, error: words };
}

function readJupiter(res, ctx) {
  const b = res.body;
  if (res.status === 200 && b && typeof b === 'object' && typeof b.outAmount === 'string') {
    if (b.inputMint !== ctx.token || b.outputMint !== ctx.quote.address || String(b.inAmount) !== ctx.amountIn || (b.swapMode && b.swapMode !== 'ExactIn')) return errorOf(res, 'Jupiter\'s answer does not match the request (token, currency or amount); it is not used.');
    const received = unitsToNumber(b.outAmount, ctx.quote.decimals);
    if (received === null) return errorOf(res, 'Jupiter\'s answer has no readable output amount.');
    const impact = num(b.priceImpactPct);
    const plan = Array.isArray(b.routePlan) ? b.routePlan.filter((r) => r && r.swapInfo) : [];
    return {
      status: 'quoted',
      http_status: 200,
      received_usd: received,
      price_impact_pct: impact === null ? null : round(impact * 100, 4),
      price_impact_basis: 'As Jupiter states it (priceImpactPct, a fraction, shown as a percent).',
      gas_usd: null,
      route: clean(plan.map((r) => `${clean(r.swapInfo.label, 40) || 'pool'} ${num(r.percent) ?? '?'}%`).join(', '), 300) || null,
      hops: plan.length,
      provider_usd: { input: num(b.swapUsdValue) },
      context: { slot: Number.isInteger(b.contextSlot) ? b.contextSlot : null },
    };
  }
  const code = b && typeof b.errorCode === 'string' ? clean(b.errorCode, 60) : null;
  const said = { code, message: b && typeof b.error === 'string' ? clean(b.error, 200) : null };
  if (res.status >= 400 && res.status < 500 && code && JUP_NO_ROUTE.has(code)) return { status: 'no_route', http_status: res.status, provider_said: said };
  if (res.status >= 400 && res.status < 500 && code && JUP_NOT_LISTED.has(code)) return { status: 'not_covered', http_status: res.status, provider_said: said, error: 'Jupiter does not trade this token. That says nothing about other routes, so it is no reading.' };
  return { ...errorOf(res, `Jupiter answered ${res.status}${code ? ` (${code})` : ''}.`), provider_said: said };
}

function readKyber(res, ctx) {
  const b = res.body;
  const r = b && b.code === 0 && b.data && b.data.routeSummary;
  if (res.status === 200 && r && typeof r === 'object') {
    const lc = (s) => String(s || '').toLowerCase();
    if (lc(r.tokenIn) !== lc(ctx.token) || lc(r.tokenOut) !== lc(ctx.quote.address) || String(r.amountIn) !== ctx.amountIn) return errorOf(res, 'KyberSwap\'s answer does not match the request (token, currency or amount); it is not used.');
    const received = unitsToNumber(String(r.amountOut), ctx.quote.decimals);
    if (received === null) return errorOf(res, 'KyberSwap\'s answer has no readable output amount.');
    const inUsd = num(r.amountInUsd);
    const outUsd = num(r.amountOutUsd);
    const gas = num(r.gasUsd);
    const l1 = num(r.l1FeeUsd);
    const paths = Array.isArray(r.route) ? r.route.filter(Array.isArray) : [];
    return {
      status: 'quoted',
      http_status: 200,
      received_usd: received,
      price_impact_pct: inUsd > 0 && outUsd !== null ? round((1 - outUsd / inUsd) * 100, 4) : null,
      price_impact_basis: 'KyberSwap\'s own USD values of the input and the output (amountInUsd, amountOutUsd).',
      gas_usd: gas === null ? null : round(gas + (l1 && l1 > 0 ? l1 : 0), 6),
      route: clean(paths.map((path) => path.map((h) => clean(h && h.exchange, 40) || 'pool').join(' > ')).join(', '), 300) || null,
      hops: paths.reduce((n, path) => n + path.length, 0),
      provider_usd: { input: inUsd, output: outUsd },
      context: { route_id: r.routeID ? clean(r.routeID, 60) : null, timestamp: Number.isInteger(r.timestamp) ? r.timestamp : null },
      request_id: b.requestId ? clean(b.requestId, 60) : null,
    };
  }
  const code = b && Number.isInteger(b.code) ? b.code : null;
  const said = { code, message: b && typeof b.message === 'string' ? clean(b.message, 200) : null };
  if (res.status === 400 && KYBER_NO_ROUTE.has(code)) return { status: 'no_route', http_status: 400, provider_said: said };
  if (res.status === 400 && KYBER_NOT_LISTED.has(code)) return { status: 'not_covered', http_status: 400, provider_said: said, error: 'KyberSwap does not list this token. That says nothing about other routes, so it is no reading.' };
  if (res.status === 400 && code === 4009) return { ...errorOf(res, 'KyberSwap refused the size (above its maximum). That is no reading.'), provider_said: said };
  return { ...errorOf(res, `KyberSwap answered ${res.status}${code !== null ? ` (code ${code})` : ''}.`), provider_said: said };
}

// ---------------------------------------------------------------------------
// The token's decimals, from CoinGecko's entry for this exact contract

async function lookupDecimals(ws, { coingeckoId, family, address, fetchImpl, cgGetImpl }) {
  const cgGet = cgGetImpl || require('./intake').cgGet;
  const coin = await cgGet(ws, `/coins/${encodeURIComponent(coingeckoId)}${DETAIL_Q}`, fetchImpl, { retries: 0, maxWaitMs: 0 });
  if (!coin) return { decimals: null, reason: `CoinGecko does not know ${coingeckoId}.` };
  const want = addressKey(family, address);
  const hit = Object.values((coin && coin.detail_platforms) || {}).find((d) => d && typeof d.contract_address === 'string' && addressKey(family, d.contract_address) === want);
  if (!hit) return { decimals: null, reason: `CoinGecko does not list this exact contract for ${coingeckoId}, so its decimals are not known.` };
  if (!Number.isInteger(hit.decimal_place) || hit.decimal_place < 0 || hit.decimal_place > 36) return { decimals: null, reason: `CoinGecko lists the contract without usable decimals for ${coingeckoId}.` };
  return { decimals: hit.decimal_place };
}

// The decimals recorded with this target's latest quote, while fresh.
function knownDecimals(observations, target, now) {
  for (let i = (observations || []).length - 1; i >= 0; i--) {
    const o = observations[i];
    if (o.target_id !== target.target_id || !o.token || !Number.isInteger(o.token.decimals) || o.contract_address !== target.contract_address) continue;
    const t = Date.parse(o.token.checked_at);
    if (Number.isFinite(t) && now - t <= DECIMALS_FRESH_DAYS * 24 * HOUR) return { decimals: o.token.decimals, checked_at: o.token.checked_at };
  }
  return null;
}

// ---------------------------------------------------------------------------
// One target: every size, in order, until the provider says to stop

const lastSent = new Map();
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// opts: { project, target, sizes, cfg, fetchImpl, now(), reserve(), sleep,
// observations (this target's recent ones, for its decimals), cgGetImpl }.
// Returns { observations, stop: 'budget' | null, skip: words | null,
// gate: { provider, until } | null, failure: bool, answered: n }.
async function quoteTarget(ws, opts) {
  const { project, target, sizes, cfg, fetchImpl, now, reserve } = opts;
  const sleep = opts.sleep || defaultSleep;
  const out = { observations: [], stop: null, skip: null, gate: null, failure: false, answered: 0 };
  const p = PROVIDERS[target.provider];
  const chain = p && p.chains[target.chain_id];
  const info = chainInfo(target.chain_id);
  const base = {
    kind: 'executable_quote',
    source: 'monitor',
    target_id: target.target_id,
    provider: target.provider,
    provider_label: p ? p.label : target.provider,
    venue: p ? p.label : target.provider,
    mechanism: 'aggregator',
    route_scope: 'aggregator',
    chain: info ? info.label : target.chain_label || null,
    chain_id: target.chain_id,
    contract_address: target.contract_address,
  };
  const notQuoted = (words) => {
    out.observations.push({ ...base, observed_at: isoOf(now()), retrieved_at: isoOf(now()), status: 'not_quoted', quote: null, error: words, note: 'Nothing was asked of the quote source.' });
    return out;
  };
  // The target must still be a supported contract of the verified identity.
  const option = quoteOptions(project).find((o) => o.key && targetIdOf(o.key) === target.target_id);
  if (!p || !chain || !info) return notQuoted('This chain is no longer quoted by this desk.');
  if (!option) return notQuoted('The project\'s identity no longer lists this contract on this chain.');
  if (!option.supported) return notQuoted(option.reason);
  // The price the sizes are set from: CoinGecko's, as this desk stored it.
  const cg = project.identity.coingecko_id;
  const mk = (require('./market').readLatest(ws).assets || {})[cg] || null;
  const priceAt = mk ? mk.source_last_updated_at || mk.fetched_at || null : null;
  const priceAge = priceAt ? (now() - Date.parse(priceAt)) / HOUR : Infinity;
  if (!mk || !(mk.price_usd > 0) || !(priceAge <= cfg.quote_price_max_age_hours)) return notQuoted(`No CoinGecko price stored in the last ${cfg.quote_price_max_age_hours} hours, so the exit sizes cannot be set.`);
  const price = { usd: mk.price_usd, as_of: new Date(Date.parse(priceAt)).toISOString(), source: 'CoinGecko /coins/markets, as stored by this desk' };
  // The token's decimals: recorded with a recent quote, or asked of CoinGecko.
  let dec = knownDecimals(opts.observations, target, now());
  if (!dec) {
    const market = require('./market');
    if (!market.rateLimitGate(ws).open) {
      out.skip = 'CoinGecko asked this desk to wait; the decimals lookup waits too.';
      return out;
    }
    if (!reserve()) {
      out.stop = 'budget';
      return out;
    }
    let r;
    try {
      r = await lookupDecimals(ws, { coingeckoId: cg, family: info.family, address: target.contract_address, fetchImpl, cgGetImpl: opts.cgGetImpl });
    } catch (err) {
      // A 429 just met closes CoinGecko's shared gate: the next run checks it
      // before asking. Anything else waits for the next interval.
      if (!market.rateLimitGate(ws).open) {
        out.skip = clean(err.message, 200);
        return out;
      }
      return notQuoted(`The token's decimals could not be read from CoinGecko (${clean(err.message, 160)}).`);
    }
    if (r.decimals === null) return notQuoted(r.reason);
    dec = { decimals: r.decimals, checked_at: isoOf(now()) };
  }
  const token = { decimals: dec.decimals, source: 'CoinGecko /coins/{id} detail_platforms, for this exact contract', checked_at: dec.checked_at };
  const quoteToken = { symbol: chain.quote.symbol, address: chain.quote.address, decimals: chain.quote.decimals, valued_usd: 1 };
  const valuation = `${chain.quote.symbol} valued at $1.00; the cost is measured against CoinGecko's price of ${price.as_of.slice(0, 16).replace('T', ' ')} UTC.`;
  for (const size of sizes) {
    const amountIn = toBaseUnits(size / price.usd, dec.decimals);
    const at = () => isoOf(now());
    if (!amountIn) {
      out.observations.push({ ...base, observed_at: at(), retrieved_at: at(), size_usd: size, status: 'not_quoted', price, token, quote_token: quoteToken, quote: null, error: 'The size is below one base unit of the token at this price.' });
      continue;
    }
    const sellUsd = round((Number(amountIn) / 10 ** dec.decimals) * price.usd, 6);
    if (!reserve()) {
      out.stop = 'budget';
      return out;
    }
    const wait = (lastSent.get(p.id) || 0) + p.min_interval_ms - Date.now();
    if (wait > 0) await sleep(wait);
    lastSent.set(p.id, Date.now());
    const url = requestUrl(p, chain, { token: target.contract_address, amountIn });
    const sentAt = now();
    let res;
    try {
      res = await getJson(url, p.origin, { fetchImpl, timeoutMs: cfg.timeout_seconds * 1000, headers: headersFor(p) });
    } catch (err) {
      out.observations.push({ ...base, observed_at: isoOf(sentAt), retrieved_at: isoOf(sentAt), size_usd: size, amount_in: amountIn, status: 'error', price, token, quote_token: quoteToken, quote: null, error: clean(`${p.label} did not answer (${err.name === 'AbortError' ? 'timeout' : err.message}). That is no reading.`, 240), note: NEVER_A_TRADE });
      out.failure = true;
      return out;
    }
    const until = rateLimitUntil(res, now());
    if (until) {
      out.gate = { provider: p.id, until };
      return out;
    }
    const ctx = { token: target.contract_address, quote: chain.quote, amountIn };
    const a = p.id === 'jupiter' ? readJupiter(res, ctx) : readKyber(res, ctx);
    const obs = { ...base, observed_at: isoOf(sentAt), retrieved_at: isoOf(sentAt), size_usd: size, amount_in: amountIn, status: a.status, price, token, quote_token: quoteToken, http_status: a.http_status ?? res.status };
    if (a.status === 'quoted') {
      obs.quote = { sell_usd: sellUsd, received_usd: round(a.received_usd, 6), fees_usd: null, fees_note: 'Pool and route fees are inside the quoted amount; not stated apart.', price_impact_pct: a.price_impact_pct, price_impact_basis: a.price_impact_basis, gas_usd: a.gas_usd, gas_included: false, route: a.route, no_route: false, valuation_note: valuation };
      Object.assign(obs, { hops: a.hops, provider_usd: a.provider_usd, context: a.context, request_id: a.request_id || null });
    } else if (a.status === 'no_route') {
      obs.quote = { sell_usd: sellUsd, received_usd: null, fees_usd: null, price_impact_pct: null, gas_usd: null, gas_included: false, route: null, no_route: true, valuation_note: valuation };
      obs.provider_said = a.provider_said;
    } else {
      obs.quote = null;
      obs.provider_said = a.provider_said || null;
      obs.error = a.error;
    }
    obs.note = NEVER_A_TRADE;
    out.observations.push(obs);
    if (a.status === 'error' && a.transient) {
      out.failure = true;
      return out;
    }
    if (a.status !== 'error') out.answered += 1;
  }
  return out;
}

// The sizes to quote: the exit sizes and the position sizes in use, each once.
function sizesFor(prefs, extraPositions = []) {
  const all = [...(prefs.exit_sizes_usd || []), prefs.exit_position_usd, ...extraPositions].filter((x) => typeof x === 'number' && Number.isFinite(x) && x > 0);
  return [...new Set(all)].sort((a, b) => a - b).slice(0, 6);
}

function cadenceWords(cfg) {
  return `Executable quotes from an aggregator every ${cfg.quote_interval_hours} hours on the chains you approved, while monitoring is on (${coverageWords()}; sold for USDC), and quotes and reserves captured in audits.`;
}

module.exports = {
  PROVIDERS,
  NEVER_A_TRADE,
  providerFor,
  coverageWords,
  cadenceWords,
  targetIdOf,
  quoteOptions,
  toBaseUnits,
  rateLimitUntil,
  requestUrl,
  readJupiter,
  readKyber,
  lookupDecimals,
  knownDecimals,
  quoteTarget,
  sizesFor,
};
