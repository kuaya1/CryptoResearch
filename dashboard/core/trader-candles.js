'use strict';
// The Paper Book's hourly candles, cr-trader-candles@1 (blueprint slot 12b,
// Eric 2026-10-28; audits/2026-10-28-approve-wiring/PLAN.md, option A,
// approved): job "trader" in jobs.js, on the server's 30-minute timer. It
// asks the desk's adapter (core/trader-desk.js) which pairs the trader's
// Paper Book needs hours for, reads their closed hours from GeckoTerminal's
// public pool candles, hands them to the adapter, then runs the adapter's
// step. It reaches the trader only through the adapter
// (trader-boundary.test.js), and never asks a model or starts research.
//
//   pools   the first time a pair is wanted, one pool is chosen for it and
//           frozen (SOURCES_REL, create-only: the first line for a pair is
//           its source for good), so its hours never switch pools. The pool:
//           the first contract of the project's verified identity on a
//           network listed in NETWORKS; GET /networks/{network}/tokens/
//           {address}/pools, in GeckoTerminal's own order (liquidity with
//           24-hour volume); the first pool that holds that contract, has a
//           reserve and a 24-hour volume above 0, and prices the token
//           within PRICE_BAND times the CoinGecko price this desk stored in
//           the last CG_PRICE_MAX_AGE_HOURS. Not the largest reserve: a
//           pool's reserve is valued at its other token's price, which a thin
//           token can inflate (a live read on 2026-10-28 showed a UDTF/WETH
//           pool claiming $414M of reserve on $1M of daily volume, ahead of
//           WETH/USDC at $158M on $57M). A native coin has no contract, so
//           none is chosen for it.
//   hours   GET /networks/{network}/pools/{pool}/ohlcv/hour, one hour each,
//           in USD, priced as the token itself (token=<its address>). Only
//           the hours after the last one the book holds are asked for (the
//           first time, the last INITIAL_HOURS). Only closed hours, at least
//           SETTLE_MINUTES after their end: the hour in progress is never
//           used. GeckoTerminal leaves out an hour in which the pool had no
//           trade. That hour is never filled in, and the book refuses the gap
//           for a pair it holds or has an order in: the plan's "a missing
//           hour stops that pair". Volume comes in USD and the book counts
//           the token, so it is converted at the hour's high: the fewest
//           units, the cautious reading. Prices are in USD and the pair is
//           against USDC, so USDC is read at $1.00.
//
// One request every MIN_INTERVAL_MS (GeckoTerminal's public limit is 30 a
// minute), each counted on disk against DAILY_BUDGET and MONTHLY_BUDGET
// before it is sent. A 429 closes the gate until its Retry-After (else 10
// minutes); an error or a timeout starts a backoff that doubles up to
// BACKOFF_MAX_MINUTES. A fixed origin, no redirects, answers read bounded as
// they stream (netguard.readBodyBounded); only the network, the token and
// the pool are sent. A restored copy sends nothing until Eric releases it,
// and nothing is asked until he funds the book (the adapter wants nothing
// before that).
//
// Files: SOURCES_REL (each pair's frozen pool); STATUS_REL (the gate, the
// backoff, the counts and when each pair was last asked; no address or key).
// The hours themselves are the book's: its journal records each one applied.

const crypto = require('crypto');
const TD = require('./trader-desk');
const market = require('./market');
const projects = require('./projects');
const research = require('./research');
const { readBodyBounded } = require('./netguard');
const { chainInfo, addressFits, addressKey } = require('./chains');
const { readJson, readText, jsonText, appendLine } = require('./fsx');
const { withLock, replaceFile } = require('./ops');
const { acquireLease, releaseLease } = require('./leases');
const { ymdInTz } = require('./dates');

const VERSION = 'cr-trader-candles@1';
const ORIGIN = 'https://api.geckoterminal.com';
const API = '/api/v2';
const SOURCES_REL = 'paper/candles/sources.jsonl';
const STATUS_REL = 'market-data/trader/candles-status.json';
const LEASE = 'trader-candles';
const HOUR = 3600000;
const MIN = 60000;
const SETTLE_MINUTES = 10;
const INITIAL_HOURS = 24;
const MAX_HOURS_PER_ASK = 1000;
const MIN_INTERVAL_MS = 2100;
const DAILY_BUDGET = 400;
const MONTHLY_BUDGET = 5000;
const MAX_PAIRS_PER_RUN = 20;
const POOL_RETRY_HOURS = 6;
const PRICE_BAND = 2;
const CG_PRICE_MAX_AGE_HOURS = 24;
const TIMEOUT_MS = 15000;
const MAX_ANSWER_BYTES = 512 * 1024;
const BACKOFF_INITIAL_MINUTES = 15;
const BACKOFF_MAX_MINUTES = 360;
const RULE = `GeckoTerminal's first pool, in its own order (liquidity with 24-hour volume), that holds this contract, has a reserve and a 24-hour volume above 0, and prices the token within ${PRICE_BAND}x of CoinGecko's price as this desk stored it.`;

// GeckoTerminal's network IDs (GET /api/v2/networks, pages 1 and 2, read
// 2026-10-28) for the chains in chains.js that it lists.
const NETWORKS = Object.freeze({ 1: 'eth', 56: 'bsc', 42161: 'arbitrum', 10: 'optimism', 137: 'polygon_pos', 43114: 'avax', 59144: 'linea', 8453: 'base', 130: 'unichain', 146: 'sonic', solana: 'solana' });
// A pool's address: an EVM contract, or a 32-byte pool ID (Uniswap v4), or a
// Solana account.
const POOL_ADDRESS = { evm: /^0x[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?$/, solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ };

const iso = (ms) => new Date(ms).toISOString();
const clean = (s, max = 200) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const num = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The start of the latest hour that closed at least SETTLE_MINUTES before t.
const latestSettled = (t) => Math.floor((t - SETTLE_MINUTES * MIN) / HOUR) * HOUR - HOUR;

// ---------------------------------------------------------------------------
// Numbers: plain decimal strings at the book's 18 places, never a float's tail

const ONE = 10n ** 18n;

// A finite number (or its decimal text) as a plain decimal string cut at the
// 18th place, so the order of a candle's prices (low, open and close, high)
// holds after; null when it is not a number, is below 0, or is 0 and `zero`
// is not allowed.
function dec18(x, { zero = false } = {}) {
  const raw = typeof x === 'number' ? (Number.isFinite(x) ? String(x) : '') : typeof x === 'string' ? x.trim() : '';
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(raw);
  if (!m) return null;
  const digits = `${m[1]}${m[2] || ''}`;
  const point = m[1].length + (m[3] ? Number(m[3]) : 0);
  let int;
  let frac;
  if (point <= 0) { int = '0'; frac = `${'0'.repeat(-point)}${digits}`; } else if (point >= digits.length) { int = `${digits}${'0'.repeat(point - digits.length)}`; frac = ''; } else { int = digits.slice(0, point); frac = digits.slice(point); }
  frac = frac.slice(0, 18).replace(/0+$/, '');
  int = int.replace(/^0+(?=\d)/, '');
  const s = frac ? `${int}.${frac}` : int;
  if (s === '0') return zero ? '0' : null;
  return s;
}
const big = (s) => { const [i, f = ''] = s.split('.'); return BigInt(i) * ONE + BigInt(f.padEnd(18, '0')); };
const text = (v) => { const f = (v % ONE).toString().padStart(18, '0').replace(/0+$/, ''); return `${v / ONE}${f ? `.${f}` : ''}`; };

// GeckoTerminal's rows ([start in seconds, open, high, low, close, volume in
// USD], newest first) as the book's hours, oldest first: those closed and
// settled by t and after `after` (ms, or null). The first row that does not
// read stops the list there, with why: a skipped row would be a gap. Pure.
function barsOf(pair, rows, { t, after = null }) {
  const latest = latestSettled(t);
  const seen = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const start = Array.isArray(r) && Number.isInteger(r[0]) ? r[0] * 1000 : null;
    if (start === null || start % HOUR !== 0) return { bars: [], stopped: 'GeckoTerminal\'s answer has a row that is not an hour; none of its hours are used.' };
    if (seen.has(start) && JSON.stringify(seen.get(start)) !== JSON.stringify(r)) return { bars: [], stopped: `GeckoTerminal's answer gives ${iso(start)} twice with different prices; none of its hours are used.` };
    seen.set(start, r);
  }
  const bars = [];
  for (const start of [...seen.keys()].sort((a, b) => a - b)) {
    if (start > latest || (after !== null && start <= after)) continue;
    const [, o, h, l, c, v] = seen.get(start);
    const p = { open: dec18(o), high: dec18(h), low: dec18(l), close: dec18(c) };
    const vol = dec18(v, { zero: true });
    const stop = (why) => ({ bars, stopped: `${pair} ${iso(start)}: ${why} It and the hours after it are not used.` });
    if (Object.values(p).some((x) => x === null) || vol === null) return stop('a price or the volume is not a number above 0 at 18 places.');
    const [bo, bh, bl, bc] = [p.open, p.high, p.low, p.close].map(big);
    if (bl > bo || bl > bc || bh < bo || bh < bc) return stop('the low and high do not hold the open and close.');
    bars.push({ pair, hour: iso(start), ...p, volume: text((big(vol) * ONE) / bh) });
  }
  return { bars, stopped: null };
}

// ---------------------------------------------------------------------------
// Where a pair's hours come from

// The contract a project's hours are read for: the first in its verified
// identity on a network GeckoTerminal lists here, or why there is none. Pure.
function targetOf(project) {
  const id = (project && project.identity) || {};
  if (id.status !== 'verified' || typeof id.coingecko_id !== 'string' || !id.coingecko_id) return { why: 'The project\'s identity is not verified with a CoinGecko ID, so no pool is chosen for it.' };
  for (const a of Array.isArray(id.assets) ? id.assets : []) {
    const info = chainInfo(a && a.chain);
    const network = info && NETWORKS[info.chain_id];
    const addr = a && typeof a.contract_address === 'string' ? a.contract_address.trim() : '';
    if (network && addressFits(info.family, addr)) return { network, chain_id: info.chain_id, chain_label: info.label, family: info.family, contract_address: addr, coingecko_id: id.coingecko_id };
  }
  return { why: 'The project\'s identity has no contract on a network this desk reads hourly candles for (a native coin has none).' };
}

// The pool for a contract from GeckoTerminal's list of its pools (RULE), or
// why there is none. Pure.
function pickPool(body, target, cgPrice) {
  const data = body && Array.isArray(body.data) ? body.data : null;
  if (!data) return { why: 'GeckoTerminal\'s answer lists no pools.' };
  const k = (s) => (target.family === 'evm' ? String(s).toLowerCase() : String(s));
  const mine = k(`${target.network}_${addressKey(target.family, target.contract_address)}`);
  const idOf = (rel) => (rel && rel.data && typeof rel.data.id === 'string' ? rel.data.id : null);
  for (const p of data.slice(0, 20)) {
    const a = (p && p.attributes) || {};
    const r = (p && p.relationships) || {};
    const side = idOf(r.base_token) && k(idOf(r.base_token)) === mine ? 'base' : idOf(r.quote_token) && k(idOf(r.quote_token)) === mine ? 'quote' : null;
    const addr = typeof a.address === 'string' ? a.address.trim() : '';
    if (!side || !POOL_ADDRESS[target.family] || !POOL_ADDRESS[target.family].test(addr)) continue;
    const price = num(a.token_price_usd);
    const reserve = num(a.reserve_in_usd);
    const vol = num(a.volume_usd && a.volume_usd.h24);
    if (!(reserve > 0) || !(vol > 0) || !(price > 0) || price > cgPrice * PRICE_BAND || price < cgPrice / PRICE_BAND) continue;
    return { pool: { pool_address: addr, pool_name: clean(a.name, 80) || null, dex: clean(idOf(r.dex), 60) || null, token_side: side, reserve_usd: reserve, volume_24h_usd: vol, pool_price_usd: price } };
  }
  return { why: `No pool on GeckoTerminal holds this contract with a reserve, trades in the last 24 hours and a price within ${PRICE_BAND}x of CoinGecko's.` };
}

// Each pair's frozen pool: the first line for it. A line that does not read
// is left aside, never a source.
function readSources(ws) {
  const out = new Map();
  for (const line of readText(ws.abs(SOURCES_REL), '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let s;
    try { s = JSON.parse(line); } catch (_) { continue; }
    if (s && typeof s.pair === 'string' && s.schema_version === 'cr.trader-candle-source.v1' && !out.has(s.pair)) out.set(s.pair, s);
  }
  return out;
}
const sourceOf = (ws, pair) => readSources(ws).get(pair) || null;

// Create-only: a pair that already has a pool keeps it.
function saveSource(ws, rec) {
  return withLock(ws, 'trader_candle_sources', () => {
    const have = sourceOf(ws, rec.pair);
    if (have) return have;
    appendLine(ws.abs(SOURCES_REL), rec);
    return rec;
  });
}

// ---------------------------------------------------------------------------
// The status file: gate, backoff, counts, when each pair was last asked

function readStatus(ws) {
  try {
    return readJson(ws.abs(STATUS_REL), { state: 'never_run' });
  } catch (_) {
    return { state: 'never_run', unreadable: true };
  }
}
function updateStatus(ws, fn) {
  return withLock(ws, 'trader_candles_status', () => {
    const next = { ...fn(readStatus(ws)), schema_version: 'cr.trader-candles-status.v1' };
    replaceFile(ws, ws.abs(STATUS_REL), jsonText(next));
    return next;
  });
}

function callCounts(status, now) {
  const day = ymdInTz(new Date(now));
  const month = day.slice(0, 7);
  const c = status.calls && status.calls.month === month ? { ...status.calls } : { month, month_count: 0, day, day_count: 0 };
  if (c.day !== day) { c.day = day; c.day_count = 0; }
  return c;
}

// Counts one request before it is sent; false when the day's or the month's
// budget is used.
function reserve(ws, now) {
  return withLock(ws, 'trader_candles_status', () => {
    const cur = readStatus(ws);
    const c = callCounts(cur, now);
    if (c.day_count >= DAILY_BUDGET || c.month_count >= MONTHLY_BUDGET) return false;
    replaceFile(ws, ws.abs(STATUS_REL), jsonText({ ...cur, calls: { ...c, month_count: c.month_count + 1, day_count: c.day_count + 1 }, schema_version: 'cr.trader-candles-status.v1' }));
    return true;
  });
}

// GeckoTerminal's wait: its 429 or the failure backoff, whichever ends
// later; null when it may be asked.
function gateUntil(status, now) {
  const g = status.gate || {};
  const t = Math.max(Date.parse(g.retry_after_until || '') || 0, Date.parse(g.backoff_until || '') || 0);
  return t > now ? iso(t) : null;
}

function noteGate(ws, patch) {
  updateStatus(ws, (s) => ({ ...s, gate: { ...(s.gate || {}), ...patch(s.gate || {}) } }));
}
const noteRateLimit = (ws, until) => noteGate(ws, () => ({ retry_after_until: iso(until) }));
function noteFailure(ws, now) {
  noteGate(ws, (g) => {
    const failures = (g.failures || 0) + 1;
    const mins = Math.min(BACKOFF_MAX_MINUTES, BACKOFF_INITIAL_MINUTES * 2 ** (failures - 1));
    return { failures, backoff_until: iso(now + mins * MIN * (0.9 + crypto.randomInt(0, 200) / 1000)), last_failure_at: iso(now) };
  });
}
const noteAnswer = (ws, now) => noteGate(ws, () => ({ failures: 0, backoff_until: null, last_answer_at: iso(now) }));
const notePair = (ws, pair, patch) => updateStatus(ws, (s) => ({ ...s, pairs: { ...(s.pairs || {}), [pair]: { ...((s.pairs || {})[pair] || {}), ...patch } } }));
const notePoolAttempt = (ws, pair, why, now) => updateStatus(ws, (s) => ({ ...s, pool_attempts: { ...(s.pool_attempts || {}), [pair]: { at: iso(now), why } } }));

// When a 429 says to come back: Retry-After (seconds), else 10 minutes; at
// least a minute, at most a day.
function rateLimitUntil(res, now) {
  if (!res || res.status !== 429) return null;
  const ra = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : NaN);
  const until = Number.isFinite(ra) && ra > 0 ? now + ra * 1000 : now + 10 * MIN;
  return Math.min(Math.max(until, now + MIN), now + 24 * HOUR);
}

// ---------------------------------------------------------------------------
// Requests (one fixed origin, no redirects, bounded answers)

const poolsPath = (tg) => `/networks/${encodeURIComponent(tg.network)}/tokens/${encodeURIComponent(tg.contract_address)}/pools?page=1`;
const hoursPath = (src, limit) => `/networks/${encodeURIComponent(src.network)}/pools/${encodeURIComponent(src.pool_address)}/ohlcv/hour?${new URLSearchParams({ aggregate: '1', limit: String(limit), currency: 'usd', token: src.contract_address })}`;

let lastSent = 0;
async function getJson(path, { fetchImpl, sleep }) {
  const url = new URL(`${API}${path}`, ORIGIN);
  if (url.origin !== ORIGIN || url.protocol !== 'https:' || !url.pathname.startsWith(`${API}/networks/`)) throw new Error('Unexpected address');
  const wait = lastSent + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastSent = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url.toString(), { headers: { accept: 'application/json', 'user-agent': 'CryptoResearch-desk/1' }, signal: ctrl.signal, redirect: 'error' });
    const body = await readBodyBounded(res, MAX_ANSWER_BYTES, ctrl);
    let json = null;
    try { json = body ? JSON.parse(body) : null; } catch (_) { json = null; }
    return { status: res.status, body: json, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

// One request under the budget, the gate and the backoff. { res } or
// { stop: 'budget' | 'gate' | 'failure' }.
async function ask(ws, path, c) {
  if (!reserve(ws, c.now())) { c.counts.budget = true; return { stop: 'budget' }; }
  c.counts.requests += 1;
  let res;
  try {
    res = await getJson(path, c);
  } catch (err) {
    noteFailure(ws, c.now());
    c.counts.problems.push({ words: clean(`GeckoTerminal did not answer (${err.name === 'AbortError' ? 'timeout' : err.message}).`, 240) });
    return { stop: 'failure' };
  }
  const until = rateLimitUntil(res, c.now());
  if (until) {
    noteRateLimit(ws, until);
    c.counts.wait_until = iso(until);
    return { stop: 'gate' };
  }
  if (res.status >= 500) {
    noteFailure(ws, c.now());
    c.counts.problems.push({ words: `GeckoTerminal answered ${res.status}.` });
    return { stop: 'failure' };
  }
  noteAnswer(ws, c.now());
  return { res };
}

// The CoinGecko price the pool is checked against, as this desk stored it.
function cgPriceOf(ws, target, t) {
  const mk = (market.readLatest(ws).assets || {})[target.coingecko_id] || null;
  const at = mk ? Date.parse(mk.source_last_updated_at || mk.fetched_at || '') : NaN;
  if (!mk || !(mk.price_usd > 0) || !Number.isFinite(at) || t - at > CG_PRICE_MAX_AGE_HOURS * HOUR) return { why: `No CoinGecko price stored in the last ${CG_PRICE_MAX_AGE_HOURS} hours to check a pool's price against, so no pool is chosen yet.` };
  return { usd: mk.price_usd, at: iso(at) };
}

async function choosePool(ws, w, c) {
  let project;
  try { project = projects.getProject(ws, w.project_id); } catch (err) { return { why: clean(err.message, 200) }; }
  const tg = targetOf(project);
  if (tg.why) return { why: tg.why };
  const price = cgPriceOf(ws, tg, c.now());
  if (price.why) return { why: price.why };
  const a = await ask(ws, poolsPath(tg), c);
  if (a.stop) return a;
  if (a.res.status === 404) return { why: `GeckoTerminal does not list this contract on ${tg.chain_label}.` };
  if (a.res.status !== 200) return { why: `GeckoTerminal answered ${a.res.status} for this contract's pools.` };
  const pick = pickPool(a.res.body, tg, price.usd);
  if (pick.why) return { why: pick.why };
  return {
    source: {
      schema_version: 'cr.trader-candle-source.v1', version: VERSION, pair: w.pair, project_id: w.project_id,
      chain_id: tg.chain_id, network: tg.network, contract_address: tg.contract_address, ...pick.pool,
      coingecko_id: tg.coingecko_id, coingecko_price_usd: price.usd, coingecko_price_at: price.at, chosen_at: iso(c.now()), rule: RULE,
    },
  };
}

// GeckoTerminal's hours for a pool, read strictly: priced as this token.
function readHours(body, src) {
  const rows = body && body.data && body.data.attributes && body.data.attributes.ohlcv_list;
  const base = body && body.meta && body.meta.base && typeof body.meta.base.address === 'string' ? body.meta.base.address : null;
  const info = chainInfo(src.chain_id);
  if (!Array.isArray(rows)) return { why: 'GeckoTerminal\'s answer has no hourly rows.' };
  if (!base || !info || addressKey(info.family, base) !== addressKey(info.family, src.contract_address)) return { why: 'GeckoTerminal\'s answer is not priced as this token; it is not used.' };
  return { rows };
}

// ---------------------------------------------------------------------------
// The run

function heldCopy(ws) {
  try {
    return research.restoredHold(ws);
  } catch (_) {
    return null;
  }
}

const behind = (w, latest) => !w.last_hour || Date.parse(w.last_hour) < latest;
// Asked since its latest hour settled: GeckoTerminal had nothing newer then
// (no trade in that hour, or not yet read), so it waits for the next hour.
const askedSince = (st, pair, latest) => {
  const a = ((st.pairs || {})[pair] || {}).asked_at;
  return Boolean(a) && Date.parse(a) >= latest + HOUR + SETTLE_MINUTES * MIN;
};
const poolWaiting = (st, pair, now) => {
  const a = (st.pool_attempts || {})[pair];
  return Boolean(a) && now - Date.parse(a.at) < POOL_RETRY_HOURS * HOUR;
};

function isDue(ws, now = Date.now()) {
  if (heldCopy(ws)) return false;
  const st = readStatus(ws);
  if (gateUntil(st, now)) return false;
  let wanted;
  try { wanted = TD.wanted(ws, { now: iso(now) }); } catch (_) { return false; }
  if (!wanted.length) return false;
  const latest = latestSettled(now);
  const sources = readSources(ws);
  return wanted.some((w) => behind(w, latest) && !askedSince(st, w.pair, latest) && (sources.has(w.pair) || (w.project_id && !poolWaiting(st, w.pair, now))));
}

async function onePair(ws, w, c) {
  const t = c.now();
  const latest = latestSettled(t);
  if (!behind(w, latest)) return {};
  const st = readStatus(ws);
  if (askedSince(st, w.pair, latest)) return {};
  let src = sourceOf(ws, w.pair);
  if (src && w.project_id && src.project_id !== w.project_id) {
    c.counts.problems.push({ pair: w.pair, words: `${w.pair}'s hours come from the pool chosen for another project (${src.project_id}); none are read for ${w.project_id}.` });
    return {};
  }
  if (!src) {
    if (!w.project_id) {
      c.counts.problems.push({ pair: w.pair, words: `${w.pair} has no pool on record and no project to choose one for.` });
      return {};
    }
    if (poolWaiting(st, w.pair, t)) {
      c.counts.waits.push({ pair: w.pair, words: st.pool_attempts[w.pair].why });
      return {};
    }
    const chosen = await choosePool(ws, w, c);
    if (chosen.stop) return chosen;
    if (!chosen.source) {
      notePoolAttempt(ws, w.pair, chosen.why, t);
      c.counts.problems.push({ pair: w.pair, words: chosen.why });
      return {};
    }
    src = saveSource(ws, chosen.source);
    c.counts.sources += 1;
  }
  const last = w.last_hour ? Date.parse(w.last_hour) : null;
  const need = last === null ? INITIAL_HOURS : Math.round((latest - last) / HOUR);
  const a = await ask(ws, hoursPath(src, Math.min(MAX_HOURS_PER_ASK, need + 2)), c);
  if (a.stop) return a;
  notePair(ws, w.pair, { asked_at: iso(t), http_status: a.res.status });
  if (a.res.status !== 200) {
    c.counts.problems.push({ pair: w.pair, words: `GeckoTerminal answered ${a.res.status} for ${w.pair}'s hours.` });
    return {};
  }
  const read = readHours(a.res.body, src);
  if (read.why) {
    c.counts.problems.push({ pair: w.pair, words: read.why });
    return {};
  }
  const { bars, stopped } = barsOf(w.pair, read.rows, { t, after: last });
  if (stopped) c.counts.problems.push({ pair: w.pair, words: stopped });
  if (!bars.length) return {};
  for (const r of TD.applyHours(ws, bars, { now: iso(t) })) {
    if (r.status === 'saved') c.counts.hours += 1;
    else if (r.status === 'unchanged') c.counts.unchanged += 1;
    else {
      c.counts.refused += 1;
      if (r.status === 'refused') c.counts.problems.push({ pair: r.pair, hour: r.hour, code: r.code || null, words: r.words });
    }
  }
  notePair(ws, w.pair, { last_hour_received: bars[bars.length - 1].hour });
  return {};
}

// One run: the hours each wanted pair is missing, then the adapter's step.
// opts: { trigger, fetchImpl, sleep, now (ms) }.
async function refresh(ws, opts = {}) {
  const { trigger = 'manual', fetchImpl = fetch, sleep = defaultSleep } = opts;
  const now = () => (opts.now !== undefined ? opts.now : Date.now());
  if (heldCopy(ws)) return { status: 'held', message: 'A restored copy: the Paper Book\'s hourly read sends nothing until the copy is released.' };
  const wait = gateUntil(readStatus(ws), now());
  if (wait) return { status: 'backoff', message: `GeckoTerminal asked this desk to wait, or it is backing off, until ${wait}.` };
  const lease = acquireLease(ws, LEASE, 20 * MIN, { label: trigger });
  if (!lease) return { status: 'busy', message: 'Another run of the Paper Book\'s hourly read is in progress.' };
  const counts = { pairs: 0, requests: 0, sources: 0, hours: 0, unchanged: 0, refused: 0, budget: false, wait_until: null, waits: [], problems: [], step: null };
  const c = { now, fetchImpl, sleep, counts };
  try {
    const wanted = TD.wanted(ws, { now: iso(now()) });
    if (!wanted.length) return { status: 'noop', message: 'The Paper Book needs no hours (it is not funded, or nothing waits or is open).', counts };
    counts.pairs = wanted.length;
    for (const w of wanted.slice(0, MAX_PAIRS_PER_RUN)) {
      const r = await onePair(ws, w, c);
      if (r.stop) break;
    }
    try {
      const s = TD.step(ws, { now: iso(now()) });
      counts.step = { done: s.done.length, problems: s.problems.length };
      for (const p of s.problems) counts.problems.push({ step: p.kind || null, code: p.code || null, words: p.words });
    } catch (err) {
      counts.problems.push({ step: 'step', words: clean(err.message, 240) });
    }
    updateStatus(ws, (s) => ({ ...s, last_run_at: iso(now()), last_trigger: trigger, last_result: { ...counts, problems: counts.problems.slice(0, 20), waits: counts.waits.slice(0, 20) } }));
    const did = counts.requests + counts.hours + (counts.step ? counts.step.done : 0);
    const words = [
      `${counts.hours} hour${counts.hours === 1 ? '' : 's'} applied for ${counts.pairs} pair${counts.pairs === 1 ? '' : 's'} from ${counts.requests} request${counts.requests === 1 ? '' : 's'}`,
      counts.sources ? `${counts.sources} pool${counts.sources === 1 ? '' : 's'} chosen` : null,
      counts.refused ? `${counts.refused} refused by the book` : null,
      counts.budget ? 'the request budget is used up' : null,
      counts.wait_until ? `GeckoTerminal asked to wait until ${counts.wait_until}` : null,
      counts.problems.length ? `${counts.problems.length} problem${counts.problems.length === 1 ? '' : 's'}: ${counts.problems.slice(0, 3).map((p) => p.words).join(' ')}` : null,
    ].filter(Boolean);
    return {
      status: !did && !counts.problems.length && !counts.budget ? 'noop' : counts.budget ? 'budget_paused' : counts.problems.length || counts.refused || counts.wait_until ? 'attention' : 'ok',
      message: `${words.join('; ')}.`,
      counts,
    };
  } finally {
    releaseLease(ws, LEASE, lease);
  }
}

// What the read is and where each pair's hours come from (12c's view, the
// job's line). Reads only.
function statusView(ws, now = Date.now()) {
  const st = readStatus(ws);
  const c = callCounts(st, now);
  return {
    version: VERSION,
    held: Boolean(heldCopy(ws)),
    wait_until: gateUntil(st, now),
    requests_today: c.day_count,
    requests_this_month: c.month_count,
    daily_budget: DAILY_BUDGET,
    monthly_budget: MONTHLY_BUDGET,
    last_run_at: st.last_run_at || null,
    last_result: st.last_result || null,
    sources: [...readSources(ws).values()].map((s) => ({ pair: s.pair, project_id: s.project_id, network: s.network, pool_name: s.pool_name, dex: s.dex, chosen_at: s.chosen_at })),
    pairs: st.pairs || {},
  };
}

module.exports = {
  VERSION, ORIGIN, NETWORKS, SOURCES_REL, STATUS_REL, SETTLE_MINUTES, INITIAL_HOURS, DAILY_BUDGET, MONTHLY_BUDGET, PRICE_BAND, RULE,
  latestSettled, dec18, barsOf, targetOf, pickPool, readHours, poolsPath, hoursPath, readSources, isDue, refresh, statusView,
};
