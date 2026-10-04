'use strict';
// Market data: CoinGecko /coins/markets (public keyless or Demo-key tier).
// Only the tracked coin IDs are sent; no holdings, quantities or account data
// leave the PC.
// - market-data/latest.json   last VALID observation per asset (kept on failure)
// - market-data/status.json   attempts, successes, errors, backoff, call budget
// - market-data/observations/YYYY-MM.jsonl   append-only history (about hourly)
// - market-data/logos/<id>.<ext>   cached logos (served locally, no CDN calls from the page)
//
// Rules (audit F10/F17):
// - Each returned row is validated on its own: tracked ID, price > 0, numeric
//   fields finite and non-negative, a readable source timestamp that is neither
//   in the future nor too old. An invalid row never replaces a valid stored one;
//   its error is recorded and the asset keeps its older observation and age.
// - A row older than the stored observation (a late or out-of-order response)
//   is ignored, so timestamps never move backwards.
// - One lease (single-flight) for every runner; one shared backoff with jitter,
//   honoring Retry-After; one monthly call budget.
// - One shared rate-limit gate for every CoinGecko caller (prices, market
//   context, identity search, research intake): a 429 seen by any of them is
//   recorded by noteRateLimit and closes rateLimitGate for all of them, manual
//   refreshes included, until Retry-After (or a default wait) has passed.
// - An answer that updates no price at all (an empty list, or only invalid or
//   older rows) is not a success: last_success_at stays where it was.
// - A price of exactly 0 from the provider is treated as invalid data, not as a
//   real zero valuation (CoinGecko does not use 0 to mean "worthless").
// Prices never change stored reports or grades.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { readJson, jsonText, appendLine, readJsonLines, mkdirp, listDir } = require('./fsx');
const { withLock, replaceFile } = require('./ops');
const { listProjects } = require('./projects');
const { acquireLease, releaseLease } = require('./leases');
const { ymdInTz, TZ } = require('./dates');

const LATEST_REL = 'market-data/latest.json';
const STATUS_REL = 'market-data/status.json';
const LOGO_DIR = 'market-data/logos';
const SOURCE_LABEL = 'CoinGecko /coins/markets';
// A 429 without Retry-After closes the shared gate for two minutes, doubled for
// each further 429 in the same episode (one that comes within 15 minutes of the
// previous wait ending), so a rate limit is never answered by another call
// seconds later. The keyless public API sends no Retry-After most of the time.
const RATE_LIMIT_DEFAULT_MS = 120000;
const RATE_LIMIT_EPISODE_MS = 15 * 60000;

function readLatest(ws) {
  return readJson(ws.abs(LATEST_REL), { provider: 'coingecko', assets: {} });
}

// The status as it applies to the credential in use now (forCredential), so
// every reader and writer sees the same gate and backoff.
function readStatus(ws) {
  return forCredential(readJson(ws.abs(STATUS_REL), { state: 'never_run', last_attempt_at: null, last_success_at: null, last_error: null, consecutive_failures: 0 }));
}

// What CoinGecko sees this desk as: its Demo key, or no key. Only this word is
// recorded, never the key or anything derived from it.
function credential() {
  return apiKey() ? 'demo_key' : 'keyless';
}

// A rate limit or failure backoff belongs to the credential it was met with.
// CoinGecko counts a Demo key's calls on their own, apart from the shared
// keyless allowance, so a wait met without the key never holds back the first
// request with it (a manual refresh, or a start after the key was added), and
// the other way round. The superseded limit is kept for the record. A status
// written before this was recorded counts as keyless: no desk had a key then.
function forCredential(status) {
  const now = credential();
  const was = status.credential || 'keyless';
  if (was === now) return status;
  return {
    ...status,
    credential: now,
    retry_after_until: null,
    next_allowed_at: null,
    consecutive_failures: 0,
    rate_limit: null,
    ...(status.rate_limit ? { rate_limit_superseded: { ...status.rate_limit, credential: was } } : {}),
  };
}

function trackedIds(ws) {
  const ids = new Set(['bitcoin']);
  for (const a of readJson(ws.abs('portfolio/assets.json'), { assets: [] }).assets || []) if (a.coingecko_id) ids.add(a.coingecko_id);
  const archived = new Map();
  for (const p of listProjects(ws)) {
    if (p.broken || !p.identity || p.identity.status !== 'verified' || !p.identity.coingecko_id) continue;
    if (p.status !== 'archived') ids.add(p.identity.coingecko_id);
    else archived.set(p.project_id, p.identity.coingecko_id);
  }
  // Archiving a project hides its research, never a holding: a token still
  // held keeps getting prices for the portfolio.
  if (archived.size) {
    try {
      const pf = require('./portfolio').computePortfolio(ws, { market: readLatest(ws) });
      for (const pos of pf.positions || []) {
        if (pos.closed) continue;
        if (pos.project_id && archived.has(pos.project_id)) ids.add(archived.get(pos.project_id));
        else if ([...archived.values()].includes(pos.asset_id)) ids.add(pos.asset_id);
      }
    } catch (_) { /* prices for active projects still refresh */ }
  }
  return [...ids].sort();
}

// Optional CoinGecko Demo key, read from outside the workspace so it is never exported.
function apiKey() {
  if (process.env.COINGECKO_API_KEY) return process.env.COINGECKO_API_KEY;
  try {
    const f = path.join(os.homedir(), '.cryptoresearch', 'secrets.json');
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    return s.coingecko_demo_api_key || null;
  } catch (_) {
    return null;
  }
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function retryAfterMs(res) {
  const h = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const t = Date.parse(h);
  return Number.isNaN(t) ? null : Math.max(0, t - Date.now());
}

// The later of an ISO time (when it is still ahead of `t`) and `t` itself.
function laterIso(iso, t) {
  return iso && Date.parse(iso) > t ? iso : new Date(t).toISOString();
}

// A time the person reads: "12:29 AM" today, "Oct 2, 9:15 PM" another day,
// both in America/New_York. (Intl puts a narrow no-break space before AM/PM;
// it becomes a plain space, so logs and searches read the same.)
function clock(iso, now = Date.now()) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  const time = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(d).replace(/\s/g, ' ');
  if (ymdInTz(d) === ymdInTz(new Date(now))) return time;
  return `${new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' }).format(d)}, ${time}`;
}

// The status fields one rate limit sets. The wait is Retry-After when CoinGecko
// sends it, otherwise the default above; capped at backoff_max_minutes so a
// bad header never parks the desk for days. A wait already running is never
// shortened, and non-forced runners wait at least as long.
function rateLimitFields(ws, status, { retryAfterMs: header = null, source = 'prices', httpStatus = 429 } = {}, now = Date.now()) {
  const md = ws.settings.market_data || {};
  const maxMs = (md.backoff_max_minutes || 60) * 60000;
  const given = typeof header === 'number' && Number.isFinite(header) && header >= 0 ? header : null;
  const prev = status.rate_limit || null;
  const prevEnd = prev && prev.until ? Date.parse(prev.until) : NaN;
  const strikes = !Number.isNaN(prevEnd) && now - prevEnd < RATE_LIMIT_EPISODE_MS ? (prev.strikes || 1) + 1 : 1;
  const waitMs = Math.min(maxMs, given !== null ? given : RATE_LIMIT_DEFAULT_MS * 2 ** (strikes - 1));
  const until = laterIso(status.retry_after_until, now + waitMs);
  return {
    retry_after_until: until,
    next_allowed_at: laterIso(status.next_allowed_at, Date.parse(until)),
    rate_limit: { at: new Date(now).toISOString(), source, http_status: httpStatus || null, retry_after_ms: given, wait_ms: waitMs, strikes, until },
  };
}

// Records a rate limit seen by any CoinGecko caller in the shared gate, so
// every other caller waits too. Returns the gate as it now stands.
function noteRateLimit(ws, { retryAfterMs: header = null, source = 'prices', httpStatus = 429 } = {}) {
  withLock(ws, 'market_status', () => {
    const status = readStatus(ws);
    replaceFile(ws, ws.abs(STATUS_REL), jsonText({ ...status, schema_version: 'cr.market-status.v2', credential: credential(), ...rateLimitFields(ws, status, { retryAfterMs: header, source, httpStatus }) }));
  });
  return rateLimitGate(ws);
}

function gateOf(status, now = Date.now()) {
  const until = status.retry_after_until ? Date.parse(status.retry_after_until) : 0;
  if (!(until > now)) return { open: true, until: null, wait_ms: 0, reason: null, note: null };
  const rl = status.rate_limit;
  const reason = !rl || rl.http_status === 429 ? 'CoinGecko is rate-limiting this server' : `CoinGecko asked this server to wait (HTTP ${rl.http_status} with Retry-After)`;
  return { open: false, until: status.retry_after_until, wait_ms: until - now, reason, note: `${reason}; next try ${clock(status.retry_after_until, now)}`, source: rl ? rl.source : null };
}

// The shared gate every CoinGecko caller checks before it calls: closed while
// a rate-limit wait runs. Forcing never opens it.
function rateLimitGate(ws, now = Date.now()) {
  return gateOf(readStatus(ws), now);
}

// The counts a failed price refresh carries (audit V2-007): every request
// sent so far, the one that failed included, and how many came back with a
// usable answer. An error object that cannot take them is wrapped.
function withCounts(err, calls, answered) {
  const e = err && typeof err === 'object' && Object.isExtensible(err) ? err : Object.assign(new Error(String((err && err.message) || err)), { name: (err && err.name) || 'Error', cause: err });
  e.calls = calls;
  e.answered = answered;
  return e;
}

async function fetchMarkets(ids, settings, fetchImpl = fetch) {
  const md = settings.market_data;
  const base = process.env.CR_MARKET_API_BASE || md.api_base;
  const headers = { accept: 'application/json', 'user-agent': 'CryptoResearch-local-dashboard' };
  const key = apiKey();
  if (key) headers['x-cg-demo-api-key'] = key;
  const rows = [];
  let calls = 0;
  let answered = 0;
  for (const part of chunk(ids, Math.min(250, md.max_ids_per_call || 250))) {
    const url = `${base}/coins/markets?vs_currency=usd&ids=${encodeURIComponent(part.join(','))}&per_page=250&page=1&sparkline=true&price_change_percentage=24h,7d,30d`;
    // Counted before it is sent: a request that then fails in any way (no
    // connection, a timeout, an error status, an unreadable answer) counts.
    calls++;
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout((md.timeout_seconds || 20) * 1000) });
      if (!res.ok) {
        const err = new Error(`CoinGecko responded HTTP ${res.status}${res.status === 429 ? ' (rate limited)' : ''}`);
        err.httpStatus = res.status;
        err.retryAfterMs = retryAfterMs(res);
        throw err;
      }
      let arr;
      try {
        arr = await res.json();
      } catch (err) {
        throw Object.assign(new Error('CoinGecko answered with unreadable JSON'), { cause: err });
      }
      if (!Array.isArray(arr)) throw new Error('Unexpected response from CoinGecko (not a list)');
      answered++;
      rows.push(...arr);
    } catch (err) {
      throw withCounts(err, calls, answered);
    }
  }
  return { rows, calls, answered };
}

// Identity lookup: CoinGecko /search returns CANDIDATES only. Nothing is bound
// to a project until its identity is confirmed from an official source.
async function searchCoins(ws, query, { fetchImpl = fetch } = {}) {
  const q = String(query || '').trim().slice(0, 80);
  if (q.length < 2) return { status: 'invalid', message: 'Type at least two characters.', candidates: [] };
  const md = ws.settings.market_data;
  const status0 = readStatus(ws);
  const gate = gateOf(status0);
  if (!gate.open) return { status: 'backoff', message: `Not searched: ${gate.note}.`, rate_limited: true, retry_at: gate.until, candidates: [] };
  const budget = callBudget(ws, status0);
  if (budget.budget_monthly && budget.month_count + 1 > budget.budget_monthly) {
    return { status: 'budget_paused', message: `Monthly CoinGecko call budget reached (${budget.month_count} of ${budget.budget_monthly}).`, candidates: [] };
  }
  const base = process.env.CR_MARKET_API_BASE || md.api_base;
  const headers = { accept: 'application/json', 'user-agent': 'CryptoResearch-local-dashboard' };
  const key = apiKey();
  if (key) headers['x-cg-demo-api-key'] = key;
  let body = null;
  let failure = null;
  let limited = null;
  try {
    const res = await fetchImpl(`${base}/search?query=${encodeURIComponent(q)}`, { headers, signal: AbortSignal.timeout((md.timeout_seconds || 20) * 1000) });
    if (!res.ok) failure = `CoinGecko search responded HTTP ${res.status}${res.status === 429 ? ' (rate limited)' : ''}`;
    else body = await res.json();
    if (res.status === 429) limited = { retryAfterMs: retryAfterMs(res), source: 'identity search', httpStatus: 429 };
  } catch (err) {
    failure = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'CoinGecko search timed out (offline or slow).' : `CoinGecko search failed: ${err.message}`;
  }
  withLock(ws, 'market_status', () => {
    const status = readStatus(ws);
    const calls = addCalls(callBudget(ws, status), 1, body ? 1 : 0);
    // A 429 here closes the shared gate for prices and market context too.
    replaceFile(ws, ws.abs(STATUS_REL), jsonText({ ...status, schema_version: 'cr.market-status.v2', credential: credential(), calls, ...(limited ? rateLimitFields(ws, status, limited) : {}) }));
  });
  if (limited) {
    const g = rateLimitGate(ws);
    return { status: 'failed', message: g.open ? failure : `${g.note}.`, rate_limited: true, retry_at: g.until, candidates: [] };
  }
  if (failure) return { status: 'failed', message: failure, candidates: [] };
  const lower = q.toLowerCase();
  const candidates = (Array.isArray(body && body.coins) ? body.coins : []).slice(0, 12).filter((c) => c && typeof c.id === 'string' && /^[a-z0-9][a-z0-9-]{0,100}$/.test(c.id)).map((c) => ({
    coingecko_id: c.id,
    name: c.name ? String(c.name).slice(0, 120) : null,
    symbol: c.symbol ? String(c.symbol).toUpperCase().slice(0, 20) : null,
    market_cap_rank: Number.isInteger(c.market_cap_rank) ? c.market_cap_rank : null,
    rank_source: 'CoinGecko market-cap rank',
    exact_name: Boolean(c.name && String(c.name).toLowerCase() === lower),
    exact_symbol: Boolean(c.symbol && String(c.symbol).toLowerCase() === lower),
  }));
  const sameSymbol = candidates.filter((c) => c.exact_symbol).length;
  return {
    status: candidates.length ? 'ok' : 'none',
    query: q,
    candidates,
    ambiguous: sameSymbol > 1,
    message: !candidates.length
      ? 'No CoinGecko listing found. The project can still be added with a pending identity and no prices.'
      : `${candidates.length} candidate(s). Tickers are not unique: confirm the token on the project's official site before binding it.`,
  };
}

const finiteOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Validates one provider row. Returns { obs, errors }.
function validateRow(c, tracked, now, settings) {
  const errors = [];
  if (!c || typeof c !== 'object') return { obs: null, errors: ['not an object'] };
  if (typeof c.id !== 'string' || !tracked.has(c.id)) errors.push(`untracked or missing id ${JSON.stringify(c && c.id)}`);
  const price = c.current_price;
  if (!(typeof price === 'number' && Number.isFinite(price) && price > 0)) errors.push(`invalid price ${JSON.stringify(price)}`);
  const ts = Date.parse(c.last_updated);
  const maxAgeMs = ((settings.market_data && settings.market_data.max_source_age_hours) || 48) * 3600000;
  if (Number.isNaN(ts)) errors.push(`unreadable source timestamp ${JSON.stringify(c.last_updated)}`);
  else if (ts > now + 10 * 60000) errors.push(`source timestamp in the future (${c.last_updated})`);
  else if (now - ts > maxAgeMs) errors.push(`source timestamp too old (${c.last_updated})`);
  for (const f of ['market_cap', 'total_volume', 'fully_diluted_valuation', 'circulating_supply', 'total_supply', 'max_supply']) {
    const v = c[f];
    if (v !== null && v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v >= 0)) errors.push(`invalid ${f} ${JSON.stringify(v)}`);
  }
  if (c.market_cap_rank !== null && c.market_cap_rank !== undefined && !(Number.isInteger(c.market_cap_rank) && c.market_cap_rank >= 1)) errors.push(`invalid market_cap_rank ${JSON.stringify(c.market_cap_rank)}`);
  if (errors.length) return { obs: null, errors };
  const spark = c.sparkline_in_7d && Array.isArray(c.sparkline_in_7d.price) ? c.sparkline_in_7d.price.filter((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0) : null;
  const image = typeof c.image === 'string' && /^https:\/\/(coin-images|assets)\.coingecko\.com\//.test(c.image) ? c.image : null;
  const pct = (v) => finiteOrNull(v);
  return {
    errors,
    obs: {
      id: c.id,
      symbol: c.symbol ? String(c.symbol).toUpperCase().slice(0, 20) : null,
      name: c.name ? String(c.name).slice(0, 120) : null,
      image_url: image,
      price_usd: price,
      market_cap_usd: finiteOrNull(c.market_cap),
      market_cap_rank: Number.isInteger(c.market_cap_rank) ? c.market_cap_rank : null,
      rank_source: 'coingecko',
      fdv_usd: finiteOrNull(c.fully_diluted_valuation),
      volume_24h_usd: finiteOrNull(c.total_volume),
      change_24h_pct: pct(c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h),
      change_7d_pct: pct(c.price_change_percentage_7d_in_currency),
      change_30d_pct: pct(c.price_change_percentage_30d_in_currency),
      market_cap_change_24h_pct: pct(c.market_cap_change_percentage_24h),
      circulating_supply: finiteOrNull(c.circulating_supply),
      total_supply: finiteOrNull(c.total_supply),
      max_supply: finiteOrNull(c.max_supply),
      sparkline_7d: spark && spark.length >= 24 ? downsample(spark, 84) : null,
      source_last_updated_at: new Date(ts).toISOString(),
      source: SOURCE_LABEL,
    },
  };
}

function downsample(arr, n) {
  if (arr.length <= n) return arr.map((x) => Number(x.toPrecision(8)));
  const out = [];
  for (let i = 0; i < n; i++) out.push(Number(arr[Math.round((i * (arr.length - 1)) / (n - 1))].toPrecision(8)));
  return out;
}

function monthKey(d = new Date()) {
  return ymdInTz(d).slice(0, 7);
}

// The CoinGecko call counts of this month and day. month_count and day_count
// are requests sent (whatever came back): the monthly budget counts these.
// month_answered and day_answered are the requests that came back with a
// usable answer. A month that was already under way when answers started to
// be counted says since when (answered_counted_since).
function callBudget(ws, status) {
  const cap = ws.settings.market_data.monthly_call_budget || null;
  const month = monthKey();
  const day = ymdInTz();
  const c = status.calls && status.calls.month === month ? { ...status.calls } : { month, month_count: 0, day, day_count: 0, month_answered: 0, day_answered: 0 };
  if (c.day !== day) {
    c.day = day;
    c.day_count = 0;
    c.day_answered = 0;
  }
  return { ...c, budget_monthly: cap, remaining: cap ? Math.max(0, cap - c.month_count) : null };
}

// Adds requests to the counts above, once each, after they were made:
// attempted is every request sent, answered those with a usable answer.
function addCalls(calls, attempted, answered = 0) {
  const c = { ...calls };
  const sent = Number.isInteger(attempted) && attempted > 0 ? attempted : 0;
  const ok = Number.isInteger(answered) && answered > 0 ? answered : 0;
  c.month_count = (c.month_count || 0) + sent;
  c.day_count = (c.day_count || 0) + sent;
  if (typeof c.month_answered !== 'number') {
    c.month_answered = 0;
    if (c.month_count - sent > 0) c.answered_counted_since = new Date().toISOString();
  }
  if (typeof c.day_answered !== 'number') c.day_answered = 0;
  c.month_answered += ok;
  c.day_answered += ok;
  c.remaining = c.budget_monthly ? Math.max(0, c.budget_monthly - c.month_count) : null;
  return c;
}

function backoffMs(ws, failures) {
  const md = ws.settings.market_data;
  const base = (md.backoff_initial_minutes || 2) * 60000;
  const max = (md.backoff_max_minutes || 60) * 60000;
  const raw = Math.min(max, base * 2 ** Math.max(0, failures - 1));
  const jitter = raw * 0.2 * (crypto.randomInt(0, 1000) / 1000 - 0.5) * 2;
  return Math.max(base / 2, Math.round(raw + jitter));
}

// Shared due/backoff rule for every runner. Forcing (the manual "Refresh
// prices") skips only the failure backoff, never the rate-limit gate.
function nextAllowed(ws, status, { force = false } = {}) {
  const now = Date.now();
  const gate = gateOf(status, now);
  if (!gate.open) return { allowed: false, until: gate.until, reason: gate.reason, rate_limited: true };
  if (force) return { allowed: true };
  const next = status.next_allowed_at ? Date.parse(status.next_allowed_at) : 0;
  if (next > now) return { allowed: false, until: status.next_allowed_at, reason: `backing off after ${status.consecutive_failures || 1} failure(s)`, rate_limited: false };
  return { allowed: true };
}

async function refresh(ws, { trigger = 'manual', fetchImpl, force = false } = {}) {
  const md = ws.settings.market_data;
  if (!md.enabled) return { status: 'skipped', message: 'Market data is turned off in settings.' };
  const ids = trackedIds(ws);
  const status0 = readStatus(ws);
  const gate = nextAllowed(ws, status0, { force });
  if (!gate.allowed) {
    return { status: 'backoff', message: `Prices not refreshed: ${gate.reason}; next try ${clock(gate.until)}.`, rate_limited: gate.rate_limited, retry_at: gate.until, next_allowed_at: gate.until };
  }
  const budget = callBudget(ws, status0);
  const needed = Math.ceil(ids.length / Math.min(250, md.max_ids_per_call || 250));
  if (budget.budget_monthly && budget.month_count + needed > budget.budget_monthly) {
    return { status: 'budget_paused', message: `Monthly call budget reached (${budget.month_count} of ${budget.budget_monthly}). Prices stay at their last valid values until next month or until you raise the budget in settings.` };
  }
  const ttl = ((md.timeout_seconds || 20) * needed + 30) * 1000;
  const lease = acquireLease(ws, 'market', ttl, { label: trigger });
  if (!lease) return { status: 'busy', message: 'Another refresh is already running; its result will be used.' };
  try {
    return await refreshLocked(ws, { ids, trigger, fetchImpl, force, budget });
  } finally {
    releaseLease(ws, 'market', lease);
  }
}

async function refreshLocked(ws, { ids, trigger, fetchImpl, force, budget }) {
  const md = ws.settings.market_data;
  const attemptAt = new Date().toISOString();
  let data;
  try {
    data = await fetchMarkets(ids, ws.settings, fetchImpl);
  } catch (err) {
    const cause = err.cause && (err.cause.code || err.cause.message);
    const message = err.name === 'TimeoutError' || err.name === 'AbortError'
      ? 'Request timed out (offline or provider slow)'
      : `${err.message}${cause ? ` (${cause})` : ''}`;
    let gate = null;
    withLock(ws, 'market_status', () => {
      const status = readStatus(ws);
      const failures = (status.consecutive_failures || 0) + 1;
      const wait = backoffMs(ws, failures);
      // Every request this refresh sent, the failed one included (V2-007).
      const calls = addCalls(callBudget(ws, status), Number.isInteger(err.calls) ? err.calls : 1, Number.isInteger(err.answered) ? err.answered : 0);
      const next = {
        ...status,
        schema_version: 'cr.market-status.v2',
        credential: credential(),
        state: 'failed',
        last_attempt_at: attemptAt,
        last_trigger: trigger,
        last_error: message,
        consecutive_failures: failures,
        next_allowed_at: laterIso(status.next_allowed_at, Date.now() + wait),
        retry_after_until: gateOf(status).until,
        calls,
        tracked_ids: ids,
        note: 'Last valid prices in latest.json are kept and shown with their age.',
      };
      // A 429 (or any answer that names a Retry-After) closes the shared gate
      // for every caller, this refresh's next manual retry included.
      const limited = err.httpStatus === 429 || typeof err.retryAfterMs === 'number';
      replaceFile(ws, ws.abs(STATUS_REL), jsonText(limited ? { ...next, ...rateLimitFields(ws, next, { retryAfterMs: err.retryAfterMs, source: 'prices', httpStatus: err.httpStatus }) } : next));
      gate = limited ? gateOf(readStatus(ws)) : null;
    });
    if (gate && !gate.open) return { status: 'failed', message: `${message}; next try ${clock(gate.until)}.`, tracked: ids.length, rate_limited: true, retry_at: gate.until };
    return { status: 'failed', message, tracked: ids.length };
  }
  const now = Date.now();
  const fetchedAt = new Date(now).toISOString();
  const tracked = new Set(ids);
  const invalid = [];
  const valid = [];
  for (const c of data.rows) {
    const v = validateRow(c, tracked, now, ws.settings);
    if (v.obs) valid.push(v.obs);
    else invalid.push({ id: c && c.id ? String(c.id).slice(0, 80) : null, errors: v.errors });
  }
  const returned = new Set(data.rows.map((c) => c && c.id));
  const missing = ids.filter((id) => !returned.has(id));
  let observationWritten = false;
  let nothingUsable = null;
  const skippedOlder = [];
  const updated = [];
  withLock(ws, 'market_write', () => {
    const latest = readLatest(ws);
    const assets = { ...(latest.assets || {}) };
    for (const o of valid) {
      const prev = assets[o.id];
      if (prev && prev.source_last_updated_at && Date.parse(prev.source_last_updated_at) > Date.parse(o.source_last_updated_at)) {
        skippedOlder.push(o.id);
        continue;
      }
      assets[o.id] = { ...o, fetched_at: fetchedAt };
      updated.push(o.id);
    }
    // With nothing updated, latest.json stays as it was, its fetch time included.
    if (updated.length) {
      replaceFile(ws, ws.abs(LATEST_REL), jsonText({
        schema_version: 'cr.market-latest.v2',
        provider: 'coingecko',
        endpoint: '/coins/markets',
        fetched_at: fetchedAt,
        rank_source: 'CoinGecko market-cap rank',
        note: 'Last VALID observation per asset. An asset missing from, or invalid in, the latest fetch keeps its older observation and timestamp.',
        assets,
      }));
    }
    const status = readStatus(ws);
    const lastObs = status.last_observation_at ? Date.parse(status.last_observation_at) : 0;
    const interval = (md.observation_interval_minutes || 55) * 60000;
    if (updated.length && (force || trigger !== 'dashboard' || now - lastObs >= interval)) {
      appendLine(ws.abs(`market-data/observations/${fetchedAt.slice(0, 7)}.jsonl`), { fetched_at: fetchedAt, provider: 'coingecko', trigger, assets: valid.filter((o) => updated.includes(o.id)).map((o) => ({ ...o, sparkline_7d: undefined })) });
      observationWritten = true;
    }
    const calls = addCalls(callBudget(ws, status), data.calls, data.answered);
    const rows = { tracked_ids: ids, missing_ids: missing, invalid_rows: invalid.slice(0, 50), skipped_older: skippedOlder, coverage: { tracked: ids.length, updated: updated.length, kept_prior: ids.length - updated.length } };
    if (!updated.length) {
      // An answer that updates no price is a failed refresh, not a success:
      // last_success_at stays put, so the page never says "updated just now"
      // while every price is old, and the usual failure backoff applies.
      const failures = (status.consecutive_failures || 0) + 1;
      nothingUsable = `CoinGecko answered, but none of the ${ids.length} tracked prices could be used (${invalid.length} invalid row(s), ${missing.length} not returned${skippedOlder.length ? `, ${skippedOlder.length} older than the stored price` : ''}). Prices keep their previous values.`;
      replaceFile(ws, ws.abs(STATUS_REL), jsonText({
        ...status,
        schema_version: 'cr.market-status.v2',
        credential: credential(),
        state: 'failed',
        last_attempt_at: attemptAt,
        last_trigger: trigger,
        last_error: nothingUsable,
        consecutive_failures: failures,
        next_allowed_at: laterIso(status.next_allowed_at, Date.now() + backoffMs(ws, failures)),
        retry_after_until: gateOf(status).until,
        ...rows,
        calls,
        note: 'Last valid prices in latest.json are kept and shown with their age.',
      }));
      return;
    }
    const partial = invalid.length > 0 || missing.length > 0;
    // Everything else in status.json (the market-context block, the last rate
    // limit) is kept: dropping `context` made market context look never
    // captured and refetch right after every price refresh.
    const { note: failureNote, ...kept } = status; // eslint-disable-line no-unused-vars
    // A rate limit another caller noted while this request was out stays in force.
    const limitedSince = Boolean(status.rate_limit && Date.parse(status.rate_limit.at) >= Date.parse(attemptAt));
    replaceFile(ws, ws.abs(STATUS_REL), jsonText({
      ...kept,
      schema_version: 'cr.market-status.v2',
      credential: credential(),
      state: partial ? 'partial' : 'ok',
      last_attempt_at: attemptAt,
      last_success_at: fetchedAt,
      last_trigger: trigger,
      last_error: partial ? `${invalid.length} invalid row(s), ${missing.length} not returned` : null,
      consecutive_failures: 0,
      next_allowed_at: limitedSince ? status.next_allowed_at : null,
      retry_after_until: limitedSince ? status.retry_after_until : null,
      ...rows,
      calls,
      last_observation_at: observationWritten ? fetchedAt : status.last_observation_at || null,
    }));
  });
  if (nothingUsable) {
    return { status: 'failed', message: nothingUsable, tracked: ids.length, updated: 0, missing, invalid, calls: data.calls, observation_written: false };
  }
  if (!fetchImpl) {
    try { await cacheLogos(ws, valid); } catch (_) { /* logos are optional */ }
  }
  return {
    status: invalid.length || missing.length ? 'partial' : 'ok',
    message: `Updated ${updated.length} of ${ids.length} tracked assets${missing.length ? `; not returned: ${missing.join(', ')}` : ''}${invalid.length ? `; invalid rows kept their previous values: ${invalid.map((x) => x.id || '?').join(', ')}` : ''}${skippedOlder.length ? `; older responses ignored: ${skippedOlder.join(', ')}` : ''}.`,
    tracked: ids.length,
    updated: updated.length,
    missing,
    invalid,
    calls: data.calls,
    observation_written: observationWritten,
  };
}

// Logos are fetched once per asset from CoinGecko's image CDN (raster images
// only, size-limited) and served by the local dashboard. The large image
// (about 250 px) is kept as <id>.lg.<ext> so a logo stays crisp at 40 px on a
// phone's screen; an earlier small <id>.<ext> is served until it arrives.
async function cacheLogos(ws, observations, fetchImpl = fetch) {
  if (process.env.CR_MARKET_API_BASE) return; // tests and mocks never fetch images
  let fetched = 0;
  mkdirp(ws.abs(LOGO_DIR));
  const have = new Set(listDir(ws.abs(LOGO_DIR), { dirs: false }).map((f) => f.replace(/\.[a-z]+$/, '')));
  for (const o of observations) {
    if (!o.image_url || have.has(`${o.id}.lg`) || fetched >= 10) continue;
    fetched++;
    try {
      const res = await fetchImpl(o.image_url.replace(/\/(small|thumb)\//, '/large/'), { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const type = String(res.headers.get('content-type') || '').split(';')[0].trim();
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[type];
      if (!ext) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 200 * 1024 || buf.length < 32) continue;
      replaceFile(ws, ws.abs(`${LOGO_DIR}/${o.id}.lg.${ext}`), buf);
    } catch (_) { /* skip this logo */ }
  }
}

function logoFile(ws, id) {
  if (!/^[a-z0-9][a-z0-9-]{0,100}$/.test(id)) return null;
  const files = listDir(ws.abs(LOGO_DIR), { dirs: false });
  const base = (x) => x.replace(/\.[a-z]+$/, '');
  const f = files.find((x) => base(x) === `${id}.lg`) || files.find((x) => base(x) === id);
  return f ? { abs: ws.abs(`${LOGO_DIR}/${f}`), type: { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[f.split('.').pop()] } : null;
}

// Price freshness for the page and the logs. Besides the stored status:
//   rate_limited  the shared CoinGecko gate is closed right now
//   retry_at      when the next automatic try may happen (ISO), or null
//   note          one plain line the page can show as it is, or null when
//                 prices are fresh and nothing is waiting
function freshness(ws, now = Date.now()) {
  const status = readStatus(ws);
  const staleAfter = ws.settings.freshness.price_stale_minutes || 90;
  const last = status.last_success_at ? Date.parse(status.last_success_at) : null;
  const ageMin = last ? Math.round((now - last) / 60000) : null;
  let state = 'never_run';
  if (last) state = ageMin > staleAfter ? 'stale' : status.state === 'partial' ? 'fresh_partial' : 'fresh';
  if (status.state === 'failed') state = last ? (ageMin > staleAfter ? 'stale_failed' : 'fresh_last_failed') : 'failed';
  const gate = gateOf(status, now);
  const backoffUntil = status.next_allowed_at && Date.parse(status.next_allowed_at) > now ? status.next_allowed_at : null;
  const retryAt = gate.open ? backoffUntil : backoffUntil ? laterIso(gate.until, Date.parse(backoffUntil)) : gate.until;
  const shown = last ? `showing prices from ${clock(status.last_success_at, now)}` : 'no prices yet';
  const next = retryAt ? `; next try ${clock(retryAt, now)}` : '';
  const cov = status.coverage || {};
  let note = null;
  if (!gate.open) note = `${gate.reason}; ${shown}${next}`;
  else if (status.state === 'failed') note = `The last price refresh failed; ${shown}${next}`;
  else if (state === 'stale') note = `Prices are from ${clock(status.last_success_at, now)}, older than ${staleAfter} minutes`;
  else if (state === 'fresh_partial' && cov.tracked) note = `Prices updated ${clock(status.last_success_at, now)} for ${cov.updated} of ${cov.tracked} tracked assets`;
  else if (state === 'never_run') note = ws.settings.market_data && ws.settings.market_data.enabled === false ? 'Market data is turned off in settings' : 'No prices fetched yet';
  return { ...status, freshness: state, age_minutes: ageMin, stale_after_minutes: staleAfter, calls: callBudget(ws, status), rate_limited: !gate.open, retry_at: retryAt, note };
}

// 24-hour volume change from our own stored observations, only when a
// measurement 20-28 hours old exists. Never derived from price changes.
function volumeChange24h(ws, id, current) {
  if (!current || typeof current.volume_24h_usd !== 'number' || !current.source_last_updated_at) return null;
  const t = Date.parse(current.source_last_updated_at);
  const months = [...new Set([new Date(t).toISOString().slice(0, 7), new Date(t - 86400000 * 2).toISOString().slice(0, 7)])];
  let best = null;
  for (const m of months) {
    for (const line of readJsonLines(ws.abs(`market-data/observations/${m}.jsonl`))) {
      const o = (line.assets || []).find((a) => a.id === id);
      if (!o || typeof o.volume_24h_usd !== 'number' || !o.source_last_updated_at) continue;
      const age = (t - Date.parse(o.source_last_updated_at)) / 3600000;
      if (age >= 20 && age <= 28 && (!best || Math.abs(age - 24) < Math.abs(best.age - 24))) best = { age, vol: o.volume_24h_usd, at: o.source_last_updated_at };
    }
  }
  if (!best || best.vol <= 0) return null;
  return { pct: (current.volume_24h_usd / best.vol - 1) * 100, compared_with: best.at, hours: Math.round(best.age * 10) / 10 };
}

module.exports = { refresh, searchCoins, readLatest, readStatus, trackedIds, freshness, fetchMarkets, validateRow, nextAllowed, noteRateLimit, rateLimitGate, retryAfterMs, clock, volumeChange24h, logoFile, apiKey, credential, callBudget, addCalls, LATEST_REL, STATUS_REL, SOURCE_LABEL, RATE_LIMIT_DEFAULT_MS };
