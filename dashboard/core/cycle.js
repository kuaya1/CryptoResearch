'use strict';
// Market-cycle context: a dated, descriptive snapshot of the whole crypto
// market. Every new research run carries the latest one in its evidence packet,
// and the watchlist shows it as one line. It describes; it does not decide:
// no "altcoin season" verdict, no forecast, no regime label made up by the app.
//
//   market-data/context/latest.json     the last VALID snapshot (kept when a fetch fails)
//   market-data/context/YYYY-MM.jsonl   every snapshot, append-only (research runs cite them by ID)
//   market-data/status.json             `context` block: attempts, errors; calls count in the
//                                       same monthly CoinGecko budget as prices
//
// Sources (CoinGecko public API, same optional key, base URL, backoff, call
// budget and rate-limit gate as prices: a 429 here makes prices wait too, and
// nothing is fetched while the gate is closed; at most one refresh per
// context_interval_minutes, default 60):
//   /global                  total market cap and 24h volume, BTC and ETH dominance
//   /coins/markets top 100   Bitcoin's own 7D/30D change, ETH/BTC, and breadth: how
//                            many of the largest coins beat Bitcoin over 7 and 30 days
//
// Breadth universe: the 100 largest coins by market cap at capture, minus Bitcoin,
// stablecoins and other dollar-pegged tokens, gold-backed tokens, tokenized funds
// (T-bills, money-market, credit), and wrapped, staked or bridged versions of
// other coins. The counts of each exclusion are kept with the snapshot.
// "Beats BTC" means the coin's price change over the period is larger than
// Bitcoin's. vs BTC = (1 + coin change) / (1 + BTC change) - 1.

const crypto = require('crypto');
const { readJson, jsonText, appendLine, readJsonLines } = require('./fsx');
const { withLock, replaceFile } = require('./ops');
const { acquireLease, releaseLease } = require('./leases');
const { compactTs } = require('./ids');

const LATEST_REL = 'market-data/context/latest.json';
const HISTORY_DIR = 'market-data/context';
const SCHEMA = 'cr.market-context.v1';
const DEFAULT_INTERVAL_MINUTES = 60;
const TOP_N = 100;
const SNAPSHOT_ID_RE = /^mc_\d{4}-\d{2}-\d{2}T\d{6}Z_[0-9a-f]{8}$/;

// Coins that move with something else rather than on their own. Matched by
// CoinGecko ID; the name and symbol rules below catch most new ones.
const STABLE_IDS = new Set([
  'tether', 'usd-coin', 'dai', 'usds', 'ethena-usde', 'first-digital-usd', 'paypal-usd', 'true-usd', 'frax', 'usdd',
  'ripple-usd', 'usd1-wlfi', 'falcon-finance', 'global-dollar', 'paxos-standard', 'gemini-dollar', 'binance-usd',
  'liquity-usd', 'gho', 'crvusd', 'euro-coin', 'stasis-eurs', 'tether-eurt', 'ethena-staked-usde', 'susds', 'savings-dai',
  'blackrock-usd-institutional-digital-liquidity-fund', 'ondo-us-dollar-yield', 'usdtb', 'usual-usd', 'agora-dollar',
  'united-stables', 'bfusd', 'usdgo', 'open-usd',
]);
const COMMODITY_IDS = new Set(['tether-gold', 'pax-gold', 'kinesis-gold', 'kinesis-silver']);
// Tokenized funds and credit (T-bills, money-market and venture funds, loans):
// they track their fund's value, not the crypto market.
const FUND_IDS = new Set([
  'hashnote-usyc', 'superstate-short-duration-us-government-securities-fund-ustb', 'spiko-amundi-overnight-swap-fund-eur', 'eutbl',
  'figure-heloc', 'blockchain-capital', 'ondo-short-term-us-government-bond-fund', 'franklin-onchain-us-government-money-fund',
  'janus-henderson-anemoy-treasury-fund', 'wisdomtree-government-money-market-digital-fund',
]);
const FUND_NAME = /\b(fund|t-?bills?|treasur(y|ies)|government securities|money market|heloc)\b/i;
const DERIVATIVE_IDS = new Set([
  'wrapped-bitcoin', 'coinbase-wrapped-btc', 'weth', 'staked-ether', 'wrapped-steth', 'wrapped-eeth', 'ether-fi-staked-eth',
  'rocket-pool-eth', 'mantle-staked-ether', 'binance-staked-sol', 'jito-staked-sol', 'msol', 'lido-staked-sol',
  'kelp-dao-restaked-eth', 'renzo-restaked-eth', 'solv-btc', 'lombard-staked-btc', 'binance-peg-weth', 'bitcoin-avalanche-bridged-btc-b',
  'wrapped-beacon-eth', 'coinbase-wrapped-staked-eth', 'stakewise-v3-oseth', 'wbnb', 'wrapped-solana', 'jupiter-staked-sol',
  'tbtc', 'kinesis-gold', 'wrapped-hype', 'staked-hype', 'kinetic-staked-hype',
]);
const DERIVATIVE_NAME = /\b(wrapped|staked|restaked|bridged|liquid staking|peg(ged)?)\b/i;
const DERIVATIVE_SYMBOL = /^(w|st|ws|cb|r|we|m|js|bn|bb|l|eb|ez|os)?(btc|eth|sol|bnb|hype)$/i;
const BASE_SYMBOLS = new Set(['btc', 'eth', 'sol', 'bnb', 'hype']);
const STABLE_NAME = /\b(usd|dollar|euro|stable)\b/i;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (x, d = 2) => (finite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

// BTC-relative return in percent, from two simple returns in percent over the
// same interval: (1 + a) / (1 + b) - 1. Unknown when either is unknown.
function relativeToBtc(assetPct, btcPct) {
  if (!finite(assetPct) || !finite(btcPct) || assetPct < -100 || btcPct <= -100) return null;
  return ((1 + assetPct / 100) / (1 + btcPct / 100) - 1) * 100;
}

function median(xs) {
  const s = xs.filter(finite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Why a row is left out of the breadth universe, or null to count it.
function exclusionOf(c) {
  if (c.id === 'bitcoin') return 'bitcoin';
  const name = String(c.name || '');
  const sym = String(c.symbol || '').toLowerCase();
  if (STABLE_IDS.has(c.id)) return 'stablecoin';
  if (COMMODITY_IDS.has(c.id) || /\b(gold|silver)\b/i.test(name)) return 'commodity_backed';
  if (FUND_IDS.has(c.id) || FUND_NAME.test(name)) return 'tokenized_fund';
  const p = c.current_price;
  const ch30 = c.price_change_percentage_30d_in_currency;
  const pegged = finite(p) && Math.abs(p - 1) <= 0.02 && (!finite(ch30) || Math.abs(ch30) <= 2);
  if (pegged || (STABLE_NAME.test(name) && finite(p) && Math.abs(p - 1) <= 0.05)) return 'stablecoin';
  if (DERIVATIVE_IDS.has(c.id)) return 'derivative';
  if (DERIVATIVE_NAME.test(name)) return 'derivative';
  if (DERIVATIVE_SYMBOL.test(sym) && !BASE_SYMBOLS.has(sym)) return 'derivative';
  return null;
}

function validMarketRow(c) {
  return c && typeof c === 'object' && typeof c.id === 'string' && /^[a-z0-9][a-z0-9-]{0,100}$/.test(c.id) && finite(c.current_price) && c.current_price > 0;
}

// Builds a snapshot from the two provider answers. Pure: no I/O.
function buildSnapshot({ global, rows, capturedAt = new Date().toISOString(), base = null, fictional = false }) {
  const g = global && global.data && typeof global.data === 'object' ? global.data : null;
  if (!g) throw new Error('CoinGecko /global answered without a data object');
  const totalCap = g.total_market_cap && finite(g.total_market_cap.usd) && g.total_market_cap.usd > 0 ? g.total_market_cap.usd : null;
  const pctBtc = g.market_cap_percentage && finite(g.market_cap_percentage.btc) ? g.market_cap_percentage.btc : null;
  const pctEth = g.market_cap_percentage && finite(g.market_cap_percentage.eth) ? g.market_cap_percentage.eth : null;
  if (totalCap === null || pctBtc === null || pctBtc <= 0 || pctBtc >= 100) throw new Error('CoinGecko /global answered without a usable total market cap and BTC dominance');
  if (!Array.isArray(rows)) throw new Error('CoinGecko /coins/markets did not answer with a list');
  const valid = rows.filter(validMarketRow).slice(0, TOP_N);
  const btc = valid.find((c) => c.id === 'bitcoin') || null;
  const eth = valid.find((c) => c.id === 'ethereum') || null;
  if (!btc) throw new Error('Bitcoin was not in the top-100 answer, so its trend and breadth are unknown');
  const btc7 = finite(btc.price_change_percentage_7d_in_currency) ? btc.price_change_percentage_7d_in_currency : null;
  const btc30 = finite(btc.price_change_percentage_30d_in_currency) ? btc.price_change_percentage_30d_in_currency : null;

  const excluded = { bitcoin: 0, stablecoin: 0, commodity_backed: 0, tokenized_fund: 0, derivative: 0, invalid: rows.slice(0, TOP_N).length - valid.length };
  const universe = [];
  for (const c of valid) {
    const why = exclusionOf(c);
    if (why) excluded[why]++;
    else universe.push(c);
  }
  const breadthFor = (key, btcPct) => {
    const counted = universe.filter((c) => finite(c[key]));
    if (!counted.length || btcPct === null) return { counted: counted.length, beating_btc: null, share_pct: null, median_vs_btc_pct: null };
    const beating = counted.filter((c) => c[key] > btcPct).length;
    return {
      counted: counted.length,
      beating_btc: beating,
      share_pct: round((beating / counted.length) * 100, 1),
      median_vs_btc_pct: round(median(counted.map((c) => relativeToBtc(c[key], btcPct))), 2),
    };
  };
  const b30 = breadthFor('price_change_percentage_30d_in_currency', btc30);
  const b7 = breadthFor('price_change_percentage_7d_in_currency', btc7);
  const lastUpdated = valid.map((c) => Date.parse(c.last_updated)).filter((t) => !Number.isNaN(t));
  const globalAsOf = finite(g.updated_at) ? new Date(g.updated_at * 1000).toISOString() : null;
  const marketsAsOf = lastUpdated.length ? new Date(Math.max(...lastUpdated)).toISOString() : null;
  const body = {
    schema_version: SCHEMA,
    captured_at: capturedAt,
    as_of: globalAsOf || marketsAsOf || capturedAt,
    provider: fictional ? 'fictional-demo' : 'coingecko',
    sources: [
      { endpoint: '/global', as_of: globalAsOf, base },
      { endpoint: `/coins/markets?order=market_cap_desc&per_page=${TOP_N}`, as_of: marketsAsOf, rows: valid.length, base },
    ],
    bitcoin: {
      price_usd: btc.current_price,
      change_7d_pct: round(btc7, 2),
      change_30d_pct: round(btc30, 2),
      market_cap_usd: finite(btc.market_cap) ? btc.market_cap : null,
    },
    ethereum: eth ? {
      price_usd: eth.current_price,
      change_30d_pct: round(eth.price_change_percentage_30d_in_currency, 2),
      eth_btc: round(eth.current_price / btc.current_price, 6),
      vs_btc_30d_pct: round(relativeToBtc(eth.price_change_percentage_30d_in_currency, btc30), 2),
    } : null,
    dominance: {
      btc_pct: round(pctBtc, 2),
      eth_pct: round(pctEth, 2),
      definition: 'Share of the total crypto market cap, as CoinGecko /global reports it (market_cap_percentage).',
    },
    total_market: {
      market_cap_usd: totalCap,
      volume_24h_usd: g.total_volume && finite(g.total_volume.usd) ? g.total_volume.usd : null,
      market_cap_change_24h_pct: round(g.market_cap_change_percentage_24h_usd, 2),
    },
    breadth: {
      universe: `The ${TOP_N} largest coins by CoinGecko market cap at capture, minus Bitcoin, stablecoins and other dollar-pegged tokens, gold-backed tokens, tokenized funds (T-bills, money-market, credit and venture funds), and wrapped, staked or bridged versions of other coins.`,
      considered: valid.length,
      excluded,
      counted: universe.length,
      d30: b30,
      d7: b7,
      definition: 'A coin beats BTC over a period when its price change over that period is larger than Bitcoin\'s. vs BTC = (1 + coin change) / (1 + BTC change) - 1. The median is over the counted coins.',
    },
    note: fictional
      ? 'FICTIONAL demo market context. Not market data.'
      : 'Descriptive market data from CoinGecko, captured by this dashboard. Not a forecast and not a market-regime verdict.',
  };
  const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return { snapshot_id: `mc_${compactTs(new Date(capturedAt))}_${hash.slice(0, 8)}`, ...body, sha256: hash };
}

// Saves a snapshot built elsewhere (the fictional demo workspace only).
function saveSnapshot(ws, snap) {
  if (ws.kind === 'real') throw new Error('Snapshots are only written by refreshContext in the real workspace.');
  withLock(ws, 'market_write', () => {
    appendLine(ws.abs(`${HISTORY_DIR}/${snap.captured_at.slice(0, 7)}.jsonl`), snap);
    replaceFile(ws, ws.abs(LATEST_REL), jsonText(snap));
  });
  return snap.snapshot_id;
}

function readContext(ws) {
  const s = readJson(ws.abs(LATEST_REL), null);
  return s && s.schema_version === SCHEMA && SNAPSHOT_ID_RE.test(String(s.snapshot_id || '')) ? s : null;
}

function findSnapshot(ws, snapshotId) {
  if (!SNAPSHOT_ID_RE.test(String(snapshotId || ''))) return null;
  const latest = readContext(ws);
  if (latest && latest.snapshot_id === snapshotId) return latest;
  const month = snapshotId.slice(3, 10);
  return readJsonLines(ws.abs(`${HISTORY_DIR}/${month}.jsonl`)).find((l) => l.snapshot_id === snapshotId) || null;
}

function intervalMinutes(ws) {
  const v = ws.settings.market_data && ws.settings.market_data.context_interval_minutes;
  return Number.isInteger(v) && v >= 15 && v <= 1440 ? v : DEFAULT_INTERVAL_MINUTES;
}

function enabled(ws) {
  const md = ws.settings.market_data || {};
  return md.enabled !== false && md.context_enabled !== false;
}

// fresh / stale (older than twice the interval) / never / off.
function contextStatus(ws, now = Date.now()) {
  const market = require('./market');
  const st = market.readStatus(ws).context || {};
  const snap = readContext(ws);
  const at = snap ? Date.parse(snap.captured_at) : NaN;
  const age = Number.isNaN(at) ? null : Math.round((now - at) / 60000);
  const state = !enabled(ws) ? 'off' : !snap ? 'never' : age > intervalMinutes(ws) * 2 ? 'stale' : 'fresh';
  return {
    state,
    age_minutes: age,
    interval_minutes: intervalMinutes(ws),
    last_attempt_at: st.last_attempt_at || null,
    last_success_at: st.last_success_at || null,
    last_error: st.last_error || null,
    last_state: st.state || null,
  };
}

function due(ws, now = Date.now(), { foreground = false } = {}) {
  if (!enabled(ws)) return false;
  const st = require('./market').readStatus(ws).context || {};
  const lastOk = st.last_success_at ? Date.parse(st.last_success_at) : 0;
  const lastTry = st.last_attempt_at ? Date.parse(st.last_attempt_at) : 0;
  const slack = foreground ? 15000 : 5 * 60000;
  const interval = intervalMinutes(ws) * 60000;
  // A failed attempt waits a quarter of the interval before the next one.
  if (st.state === 'failed' && now - lastTry < interval / 4) return false;
  return now - lastOk >= interval - slack;
}

async function fetchContext(ws, fetchImpl = fetch) {
  const market = require('./market');
  const md = ws.settings.market_data;
  const base = process.env.CR_MARKET_API_BASE || md.api_base;
  const headers = { accept: 'application/json', 'user-agent': 'CryptoResearch-local-dashboard' };
  const key = market.apiKey ? market.apiKey() : null;
  if (key) headers['x-cg-demo-api-key'] = key;
  const timeout = (md.timeout_seconds || 20) * 1000;
  let calls = 0;
  let answered = 0;
  const get = async (pathAndQuery) => {
    calls++; // counted before the request, so a failed request still counts
    let res;
    try {
      res = await fetchImpl(`${base}${pathAndQuery}`, { headers, signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      const e = new Error(err.name === 'TimeoutError' || err.name === 'AbortError' ? 'CoinGecko timed out (offline or slow)' : `CoinGecko request failed: ${err.message}`);
      Object.assign(e, { calls, answered });
      throw e;
    }
    if (!res.ok) {
      const e = new Error(`CoinGecko responded HTTP ${res.status}${res.status === 429 ? ' (rate limited)' : ''}`);
      Object.assign(e, { calls, answered });
      e.httpStatus = res.status;
      e.retryAfterMs = market.retryAfterMs(res);
      throw e;
    }
    let body;
    try {
      body = await res.json();
    } catch (err) {
      const e = new Error('CoinGecko answered with unreadable JSON');
      Object.assign(e, { calls, answered });
      throw e;
    }
    answered++;
    return body;
  };
  const global = await get('/global');
  const rows = await get(`/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${TOP_N}&page=1&sparkline=false&price_change_percentage=7d,30d`);
  return { global, rows, calls, answered, base: base === md.api_base ? null : 'custom' };
}

function recordAttempt(ws, { calls, answered = 0, outcome, error = null, snapshotId = null, at, rateLimit = null }) {
  const market = require('./market');
  withLock(ws, 'market_write', () => {
    const status = market.readStatus(ws);
    const c = market.addCalls(market.callBudget(ws, status), calls, answered);
    const prev = status.context || {};
    const context = {
      state: outcome,
      last_attempt_at: at,
      last_success_at: outcome === 'ok' ? at : prev.last_success_at || null,
      last_error: error,
      last_snapshot_id: snapshotId || prev.last_snapshot_id || null,
      consecutive_failures: outcome === 'ok' ? 0 : (prev.consecutive_failures || 0) + 1,
    };
    replaceFile(ws, ws.abs(market.STATUS_REL), jsonText({ ...status, schema_version: status.schema_version || 'cr.market-status.v2', calls: c, context }));
    // Under the same lock, so no runner sees the failure without the wait.
    if (rateLimit) market.noteRateLimit(ws, rateLimit);
  });
}

// Refreshes the snapshot when it is due (or forced). Shares the market lease,
// so it never runs at the same time as a price refresh, and the same backoff
// and call budget. A failure keeps the last valid snapshot.
async function refreshContext(ws, { trigger = 'manual', fetchImpl, force = false, now = Date.now(), foreground = false } = {}) {
  if (!enabled(ws)) return { status: 'skipped', message: 'Market context is turned off in settings.' };
  const market = require('./market');
  if (!force && !due(ws, now, { foreground })) return { status: 'not_due', message: 'Market context is not due yet.' };
  const status0 = market.readStatus(ws);
  const gate = market.nextAllowed(ws, status0, { force });
  if (!gate.allowed) return { status: 'backoff', message: `Market context not refreshed: ${gate.reason}; next try ${market.clock(gate.until)}.`, rate_limited: gate.rate_limited, retry_at: gate.until };
  const budget = market.callBudget(ws, status0);
  if (budget.budget_monthly && budget.month_count + 2 > budget.budget_monthly) {
    return { status: 'budget_paused', message: `Monthly CoinGecko call budget reached (${budget.month_count} of ${budget.budget_monthly}); market context stays at its last snapshot.` };
  }
  const ttl = ((ws.settings.market_data.timeout_seconds || 20) * 2 + 30) * 1000;
  const lease = acquireLease(ws, 'market', ttl, { label: `context-${trigger}` });
  if (!lease) return { status: 'busy', message: 'A price refresh is running; market context waits for the next turn.' };
  const at = new Date().toISOString();
  try {
    let data;
    try {
      data = await fetchContext(ws, fetchImpl);
    } catch (err) {
      const limited = err.httpStatus === 429 || typeof err.retryAfterMs === 'number';
      recordAttempt(ws, { calls: Number.isInteger(err.calls) ? err.calls : 1, answered: Number.isInteger(err.answered) ? err.answered : 0, outcome: 'failed', error: err.message, at, rateLimit: limited ? { retryAfterMs: err.retryAfterMs, source: 'market context', httpStatus: err.httpStatus } : null });
      return { status: 'failed', message: `Market context not refreshed: ${err.message}. The last snapshot is kept.` };
    }
    let snap;
    try {
      snap = buildSnapshot({ global: data.global, rows: data.rows, capturedAt: at, base: data.base });
    } catch (err) {
      recordAttempt(ws, { calls: data.calls, answered: data.answered, outcome: 'failed', error: err.message, at });
      return { status: 'failed', message: `Market context not refreshed: ${err.message}. The last snapshot is kept.` };
    }
    withLock(ws, 'market_write', () => {
      appendLine(ws.abs(`${HISTORY_DIR}/${at.slice(0, 7)}.jsonl`), snap);
      replaceFile(ws, ws.abs(LATEST_REL), jsonText(snap));
    });
    recordAttempt(ws, { calls: data.calls, answered: data.answered, outcome: 'ok', snapshotId: snap.snapshot_id, at });
    return { status: 'ok', message: `Market context ${snap.snapshot_id}: ${describe(snap)}`, snapshot_id: snap.snapshot_id, calls: data.calls };
  } finally {
    releaseLease(ws, 'market', lease);
  }
}

const pct = (v, d = 1) => (finite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(d)}%` : 'unknown');

// One plain line, for the CLI, the job log and the prompt.
function describe(s) {
  if (!s) return 'no market context snapshot yet';
  const b30 = s.breadth && s.breadth.d30;
  return [
    `BTC $${Math.round(s.bitcoin.price_usd).toLocaleString('en-US')} (7D ${pct(s.bitcoin.change_7d_pct)}, 30D ${pct(s.bitcoin.change_30d_pct)})`,
    `BTC dominance ${finite(s.dominance.btc_pct) ? `${s.dominance.btc_pct.toFixed(1)}%` : 'unknown'}`,
    b30 && b30.beating_btc !== null ? `${b30.beating_btc} of ${b30.counted} large coins beat BTC over 30D` : 'breadth unknown',
    `as of ${s.as_of}`,
  ].join('; ');
}

// What a research run's evidence packet carries: the snapshot itself (so the
// run's inputs are complete on their own) with its ID, or an explicit unknown.
function packetContext(ws, now = Date.now()) {
  const s = readContext(ws);
  if (!s) {
    return {
      status: 'unknown',
      snapshot_id: null,
      note: enabled(ws) ? 'No market context snapshot has been captured yet. Treat Bitcoin trend, dominance and breadth as unknown unless you retrieve them yourself.' : 'Market context is turned off in this dashboard.',
    };
  }
  const ageH = Math.round((now - Date.parse(s.captured_at)) / 360000) / 10;
  const { sha256, ...rest } = s; // eslint-disable-line no-unused-vars
  return { status: 'captured', age_hours_at_packet: ageH, ...rest };
}

// A tracked coin's 7D and 30D change against Bitcoin's, from the same stored
// price observations (market-data/latest.json). Unknown stays unknown.
function assetVsBtc(latest, obs) {
  const btc = latest && latest.assets ? latest.assets.bitcoin : null;
  if (!obs || !btc || obs.id === 'bitcoin') return null;
  const v7 = relativeToBtc(obs.change_7d_pct, btc.change_7d_pct);
  const v30 = relativeToBtc(obs.change_30d_pct, btc.change_30d_pct);
  return {
    btc_change_7d_pct: finite(btc.change_7d_pct) ? round(btc.change_7d_pct, 2) : null,
    btc_change_30d_pct: finite(btc.change_30d_pct) ? round(btc.change_30d_pct, 2) : null,
    vs_btc_7d_pct: round(v7, 2),
    vs_btc_30d_pct: round(v30, 2),
    btc_source_last_updated_at: btc.source_last_updated_at || null,
    definition: 'vs BTC = (1 + coin change) / (1 + BTC change) - 1, both rolling changes from the same CoinGecko /coins/markets observations.',
  };
}

// Compact form for the index and the watchlist strip.
function summary(ws, now = Date.now()) {
  const s = readContext(ws);
  const st = contextStatus(ws, now);
  if (!s) return { status: st.state, freshness: st, snapshot: null };
  return {
    status: st.state,
    freshness: st,
    snapshot: {
      snapshot_id: s.snapshot_id,
      captured_at: s.captured_at,
      as_of: s.as_of,
      bitcoin: s.bitcoin,
      ethereum: s.ethereum,
      dominance: s.dominance,
      total_market: s.total_market,
      breadth: { counted: s.breadth.counted, considered: s.breadth.considered, excluded: s.breadth.excluded, d30: s.breadth.d30, d7: s.breadth.d7, universe: s.breadth.universe, definition: s.breadth.definition },
      provider: s.provider,
    },
  };
}

module.exports = {
  LATEST_REL,
  HISTORY_DIR,
  SNAPSHOT_ID_RE,
  relativeToBtc,
  assetVsBtc,
  exclusionOf,
  buildSnapshot,
  saveSnapshot,
  readContext,
  findSnapshot,
  contextStatus,
  due,
  fetchContext,
  refreshContext,
  describe,
  packetContext,
  summary,
};
