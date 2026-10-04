'use strict';
// Contract screening: GoPlus Security's reading of each token contract a
// verified project identity records (identity.assets: chain + contract
// address). Facts about the deployed contract, each one present, absent or
// unknown, as GoPlus answers: a mint function, a blacklist, an upgradeable
// proxy, owner powers, simulated buy and sell taxes. Never a verdict: nothing
// here is labeled safe, and a field GoPlus leaves out is unknown, never
// "absent". A present flag is a capability (a mint function may serve
// scheduled emissions), not proof of misuse; an absent flag is not an audit.
//
// What is screened: the contract assets of a verified, active identity, on a
// chain GoPlus lists (core/chains.js). A chain it does not list, or an address
// that does not fit its chain, is recorded as not screenable and costs no
// request. A project with no contract on record is "no_contract"; it is
// "native_chain" only when its identity says so explicitly (identity
// native_chain: true), never because a contract is missing.
//
// Requests: GET https://api.gopluslabs.io/api/v1/token_security/<chain_id>
// ?contract_addresses=<address> (EVM chains and Tron) or
// /api/v1/solana/token_security?contract_addresses=<address> (Solana). The
// origin and paths are fixed and the address is validated, then encoded. One
// address per request: a keyless call answers for the first address only.
// Every runner (dashboard, online desk, scheduled task, CLI) shares one lease,
// one rate-limit gate (a 429 or GoPlus code 4029; a valid Retry-After is
// honored), the failure backoff and the request counts. Every request, a retry
// or a token request included, is counted on disk before it is sent, and none
// is sent past the monthly budget. A request that may have failed transiently
// (no answer, a timeout, a 5xx, an unreadable answer) is tried once more.
// Network waits never hold the workspace save lock. A failed refresh keeps
// the last good screen, with its age and the failure.
//
// Credentials (optional): GoPlus serves token security without a key (its
// free tier). With GOPLUS_APP_KEY and GOPLUS_APP_SECRET both in the
// environment (Render's Environment page), a run first asks GoPlus for an
// access token (POST /api/v1/token with app_key, time and sign = SHA-1 of
// app_key + time + app_secret) and sends it as "Authorization: Bearer
// <token>". The token stays in this process's memory, never in a file, a log
// line or a reply. A key without its secret, a token request that fails, or a
// token GoPlus refuses (401 or 403): the run goes on keyless and says why;
// nothing throws for a missing key. A rate limit or backoff belongs to the
// credential it was met with (status.json records "app_key" or "keyless",
// never the key), as for CoinGecko (market.js).
//
// Alerts: only severe structural changes between two good screens of the same
// contract (a mint function or mint authority newly present, an upgradeable
// proxy newly present, a blacklist or freeze authority newly present, the sell
// tax rising above settings sell_tax_alert_pct). Unknown to present is not a
// change. They are kept on the project's cache file and raised in the review
// queue by the indexer for alert_days.
//
// Research: packetBlock() prepares the block a run's evidence packet would
// carry, labeled "captured by the dashboard, not checked in your session".
// While settings packet_mode is "monitor" (the first week, to audit false
// positives) research.js does not include it.
//
// Files (derived and refetchable, kept with the market data and backed up):
//   market-data/screening/status.json         gate, backoff, request counts
//   market-data/screening/<project_id>.json   the current contracts' last good
//                                             screen, its last attempt and the
//                                             recent alert transitions

const crypto = require('crypto');
const { readJson, jsonText, sha256 } = require('./fsx');
const { withLock, replaceFile } = require('./ops');
const { acquireLease, releaseLease } = require('./leases');
const { isProjectId } = require('./ids');
const { ymdInTz } = require('./dates');
const { OpError } = require('./ops');
const { chainInfo, addressFits, addressKey } = require('./chains');

const ORIGIN = 'https://api.gopluslabs.io';
const TOKEN_PATH = '/api/v1/token';
const DIR = 'market-data/screening';
const STATUS_REL = `${DIR}/status.json`;
const LEASE = 'screening';
const RATE_LIMIT_DEFAULT_MS = 10 * 60000;
const RATE_LIMIT_MIN_MS = 60000;
// A Retry-After GoPlus sends is honored in full (a monthly quota can mean weeks);
// only a value past this ceiling is treated as unreadable and capped.
const RETRY_AFTER_CEILING_MS = 31 * 86400000;
const MAX_BODY_CHARS = 2 * 1024 * 1024;
const MAX_TRANSITIONS = 30;
const DEFAULTS = {
  enabled: true,
  refresh_hours: 168,
  stale_hours: 336,
  timeout_seconds: 20,
  max_attempts: 2,
  monthly_request_budget: 1500,
  max_contracts_per_run: 24,
  backoff_initial_minutes: 10,
  backoff_max_minutes: 720,
  sell_tax_alert_pct: 10,
  alert_days: 14,
  packet_mode: 'monitor',
};
const NOTE = 'Token contract flags from GoPlus Security, captured by the dashboard, not checked in your session. Each flag is GoPlus\'s reading of the deployed contract: present, absent or unknown (GoPlus gave no answer), never inferred. A present flag is a capability (for example, a mint function used for scheduled emissions), not proof of misuse; an absent flag is not an audit. Taxes are GoPlus\'s simulated buy and sell taxes. Contracts on chains GoPlus does not cover are listed as not screenable.';

// The checks, by chain family: key, GoPlus field, label, and how much a
// present flag matters (severe: it can take holders' funds or trap them;
// watch: an owner power worth knowing; info: context).
const EVM_CHECKS = [
  ['mint', 'is_mintable', 'Mint function', 'watch'],
  ['proxy', 'is_proxy', 'Upgradeable proxy', 'watch'],
  ['blacklist', 'is_blacklisted', 'Blacklist', 'watch'],
  ['whitelist', 'is_whitelisted', 'Whitelist', 'info'],
  ['owner_change_balance', 'owner_change_balance', 'Owner can change balances', 'severe'],
  ['hidden_owner', 'hidden_owner', 'Hidden owner', 'severe'],
  ['selfdestruct', 'selfdestruct', 'Self-destruct', 'severe'],
  ['take_back_ownership', 'can_take_back_ownership', 'Ownership can be reclaimed', 'watch'],
  ['transfer_pausable', 'transfer_pausable', 'Transfers can be paused', 'watch'],
  ['trading_cooldown', 'trading_cooldown', 'Trading cooldown', 'info'],
  ['honeypot', 'is_honeypot', 'Honeypot', 'severe'],
  ['cannot_buy', 'cannot_buy', 'Cannot be bought', 'severe'],
  ['cannot_sell_all', 'cannot_sell_all', 'Cannot sell the whole balance', 'severe'],
  ['tax_modifiable', 'slippage_modifiable', 'Tax can be changed', 'watch'],
  ['personal_tax', 'personal_slippage_modifiable', 'Tax can differ per address', 'watch'],
  ['external_call', 'external_call', 'Calls external contracts', 'info'],
  ['anti_whale', 'is_anti_whale', 'Anti-whale limit', 'info'],
];
const SOL_CHECKS = [
  ['mint', 'mintable', 'Mint authority', 'watch'],
  ['freeze', 'freezable', 'Freeze authority', 'watch'],
  ['closable', 'closable', 'Can be closed', 'severe'],
  ['balance_mutable', 'balance_mutable_authority', 'Balances can be changed', 'severe'],
  ['metadata_mutable', 'metadata_mutable', 'Metadata can change', 'info'],
  ['transfer_hook_upgradable', 'transfer_hook_upgradable', 'Transfer hook can change', 'watch'],
  ['transfer_fee_upgradable', 'transfer_fee_upgradable', 'Transfer fee can change', 'watch'],
];
// The changes that raise a review-queue alert, by check key.
const ALERT_CHECKS = { mint: 'now has a mint function', proxy: 'is now an upgradeable proxy', blacklist: 'now has a blacklist', freeze: 'now has a freeze authority' };

const isoOf = (ms) => new Date(ms).toISOString();
const round2 = (n) => Math.round(n * 100) / 100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cfgOf(ws) {
  return { ...DEFAULTS, ...((ws.settings && ws.settings.screening) || {}) };
}

// Text from GoPlus is data: control characters out, whitespace collapsed,
// length capped.
function cleanText(v, max = 240) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// A GoPlus flag ("1", "0", 1, 0, or absent) as present, absent or unknown.
function tri(v) {
  if (v === '1' || v === 1 || v === true) return 'present';
  if (v === '0' || v === 0 || v === false) return 'absent';
  return 'unknown';
}

// A GoPlus tax ("0.1" is 10%) as a percentage, or null when not given.
function taxPct(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? round2(n * 100) : null;
}

const ZERO_OWNERS = new Set(['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead']);

// One EVM (or Tron) token's GoPlus record, normalized. Pure, for the tests.
function normalizeEvm(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const checks = Object.fromEntries(EVM_CHECKS.map(([key, field]) => [key, tri(r[field])]));
  let owner = 'unknown';
  if (typeof r.owner_address === 'string') owner = !r.owner_address.trim() ? 'none' : ZERO_OWNERS.has(r.owner_address.trim().toLowerCase()) ? 'renounced' : 'present';
  const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    checks,
    taxes: { buy_pct: taxPct(r.buy_tax), sell_pct: taxPct(r.sell_tax) },
    owner: { state: owner, address: owner === 'present' ? cleanText(r.owner_address, 64) : null },
    source: r.is_open_source === undefined ? 'unknown' : tri(r.is_open_source) === 'present' ? 'open' : tri(r.is_open_source) === 'absent' ? 'closed' : 'unknown',
    facts: { holder_count: num(r.holder_count), lp_holder_count: num(r.lp_holder_count), in_dex: tri(r.is_in_dex), trust_list: tri(r.trust_list) },
    notes: { other_potential_risks: cleanText(r.other_potential_risks), note: cleanText(r.note) },
  };
}

// One Solana token's GoPlus record, normalized. Pure, for the tests.
function normalizeSolana(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const status = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x.status : x);
  const checks = Object.fromEntries(SOL_CHECKS.map(([key, field]) => [key, tri(status(r[field]))]));
  checks.non_transferable = tri(r.non_transferable !== undefined ? r.non_transferable : r.none_transferable);
  checks.transfer_hook = Array.isArray(r.transfer_hook) ? (r.transfer_hook.length ? 'present' : 'absent') : 'unknown';
  const fee = r.transfer_fee && typeof r.transfer_fee === 'object' ? r.transfer_fee : null;
  const rate = fee && fee.current_fee_rate !== undefined ? Number(fee.current_fee_rate) : NaN;
  return {
    checks,
    taxes: { buy_pct: null, sell_pct: null, transfer_fee_pct: Number.isFinite(rate) ? round2(rate * 100) : null },
    owner: { state: 'unknown', address: null },
    source: 'unknown',
    facts: { trusted_token: r.trusted_token === 1 || r.trusted_token === '1' ? 'present' : r.trusted_token === 0 || r.trusted_token === '0' ? 'absent' : 'unknown', default_account_state: cleanText(String(r.default_account_state ?? ''), 4) },
    notes: { other_potential_risks: null, note: null },
  };
}

// Which present flags are severe or worth watching, with their labels.
function flagsOf(family, checks) {
  const table = family === 'solana' ? [...SOL_CHECKS, ['non_transferable', null, 'Not transferable', 'severe'], ['transfer_hook', null, 'Transfer hook', 'watch']] : EVM_CHECKS;
  const out = { severe: [], watch: [], unknown: 0 };
  for (const [key, , label, level] of table) {
    if (checks[key] === 'present' && level === 'severe') out.severe.push(label);
    else if (checks[key] === 'present' && level === 'watch') out.watch.push(label);
    else if (checks[key] === 'unknown') out.unknown++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Contracts and what is screened

// A project's contracts, as the identity records them, each with what a
// screen needs or why it cannot have one. Pure, for the tests.
function contractsOf(identity) {
  const id = identity || {};
  const seen = new Set();
  const out = [];
  for (const a of Array.isArray(id.assets) ? id.assets : []) {
    if (!a || typeof a.contract_address !== 'string' || !a.contract_address.trim()) continue;
    const address = a.contract_address.trim();
    const info = chainInfo(a.chain_id || a.chain);
    const base = { chain: a.chain ? String(a.chain) : null, address };
    if (!info) { out.push({ ...base, chain_id: null, family: null, label: base.chain, screenable: false, reason: `GoPlus does not screen tokens on ${base.chain || 'an unnamed chain'}` }); continue; }
    const key = `${info.chain_id}:${addressKey(info.family, address)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!addressFits(info.family, address)) { out.push({ ...base, chain_id: info.chain_id, family: info.family, label: info.label, screenable: false, reason: `The address does not have the shape of a ${info.label} address` }); continue; }
    out.push({ ...base, chain_id: info.chain_id, family: info.family, label: info.label, screenable: true, key });
  }
  return out;
}

// The contracts the cache belongs to: a change re-screens at once.
function contractsKey(contracts) {
  return sha256(JSON.stringify(contracts.map((c) => [c.chain_id, c.family ? addressKey(c.family, c.address) : c.address, c.chain]).sort()));
}

// The one URL a contract is screened from: the fixed origin and path, the
// validated address encoded.
function screenUrl(c) {
  if (!c || !c.screenable || !addressFits(c.family, c.address)) throw new OpError('INVALID', 'Not a screenable contract');
  const url = c.family === 'solana'
    ? new URL(`${ORIGIN}/api/v1/solana/token_security`)
    : new URL(`${ORIGIN}/api/v1/token_security/${encodeURIComponent(c.chain_id)}`);
  url.searchParams.set('contract_addresses', c.address.trim());
  if (url.origin !== ORIGIN) throw new OpError('INVALID', 'Unexpected screening origin');
  return url.toString();
}

// ---------------------------------------------------------------------------
// Credentials (optional; see the top of this file)

// The app key and secret, from the environment only. Never logged or saved.
function credentials() {
  const read = (k) => (typeof process.env[k] === 'string' ? process.env[k].trim() : '');
  const key = read('GOPLUS_APP_KEY');
  const secret = read('GOPLUS_APP_SECRET');
  if (key && secret) return { mode: 'app_key', key, secret, note: null };
  const note = key ? 'GOPLUS_APP_KEY is set without GOPLUS_APP_SECRET, which GoPlus needs to sign its token request, so screening runs keyless.'
    : secret ? 'GOPLUS_APP_SECRET is set without GOPLUS_APP_KEY, so screening runs keyless.' : null;
  return { mode: 'keyless', key: null, secret: null, note };
}

// The word status.json and the logs carry: "app_key" or "keyless".
function credential() {
  return credentials().mode;
}

// The access token, in this process's memory only, for the key it was issued
// to (a hash of key and secret, never the key itself).
let tokenCache = null;
const credsId = (creds) => sha256(`${creds.key}\n${creds.secret}`);

// A token for this run: the cached one while it has more than two minutes
// left, else a new one from GoPlus (one request, reserved like any other).
// Returns { token } or { token: null, why }; never throws.
async function accessToken(creds, { fetchImpl, timeoutMs, now, reserve, counts }) {
  if (creds.mode !== 'app_key') return { token: null, why: creds.note };
  const id = credsId(creds);
  if (tokenCache && tokenCache.id === id && tokenCache.expires_at - 120000 > now) return { token: tokenCache.token };
  tokenCache = null;
  if (!reserve()) return { token: null, why: 'the monthly GoPlus request budget left no room for a token request', budget: true };
  counts.sent++;
  const time = Math.floor(now / 1000);
  const sign = crypto.createHash('sha1').update(`${creds.key}${time}${creds.secret}`).digest('hex');
  const url = new URL(`${ORIGIN}${TOKEN_PATH}`);
  if (url.origin !== ORIGIN) return { token: null, why: 'unexpected token origin' };
  try {
    const res = await fetchImpl(url.toString(), { method: 'POST', headers: { ...HEADERS, 'content-type': 'application/json' }, body: JSON.stringify({ app_key: creds.key, sign, time }), signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let body = null;
    try { body = typeof text === 'string' && text.length <= MAX_BODY_CHARS ? JSON.parse(text) : null; } catch (_) { body = null; }
    const r = body && body.result && typeof body.result === 'object' ? body.result : body;
    const token = r && typeof r.access_token === 'string' && r.access_token.trim() ? r.access_token.trim() : null;
    if (!res.ok || !body || Number(body.code) !== 1 || !token) {
      const code = body && body.code !== undefined ? `, code ${cleanText(String(body.code), 12)}` : '';
      return { token: null, why: `GoPlus issued no access token (HTTP ${res.status}${code})` };
    }
    counts.answered++;
    const ttl = Number(r.expires_in);
    tokenCache = { id, token, expires_at: now + (Number.isFinite(ttl) && ttl > 0 ? Math.min(ttl, 86400) * 1000 : 1800000) };
    return { token };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { token: null, why: timedOut ? `the token request had no answer within ${Math.round(timeoutMs / 1000)} s` : 'the token request failed' };
  }
}

// ---------------------------------------------------------------------------
// Requests

const HEADERS = { accept: 'application/json', 'user-agent': 'CryptoResearch-desk' };

// One contract, with a bounded retry for a failure that may be transient.
// Each attempt is reserved in the month's count before it is sent (reserve);
// when the budget is used up nothing more is sent. A 429 (or GoPlus code
// 4029) stops at once. With an access token (auth.token), a 401 or 403 drops
// it: the retry, and the rest of the run, go keyless.
async function getScreen(url, c, { fetchImpl, timeoutMs, maxAttempts, retryDelayMs, counts, reserve = () => true, auth = { token: null } }) {
  let failure = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1 && retryDelayMs) await sleep(retryDelayMs);
    if (!reserve()) return { kind: 'budget', attempts: attempt - 1, after: failure };
    counts.sent++;
    const headers = auth.token ? { ...HEADERS, authorization: `Bearer ${auth.token}` } : HEADERS;
    let res;
    let text;
    try {
      res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (auth.token && (res.status === 401 || res.status === 403)) {
        try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch (_) { /* nothing to release */ }
        auth.token = null;
        auth.dropped = `GoPlus refused the access token (HTTP ${res.status}); the rest of the run went keyless`;
        tokenCache = null;
        failure = { kind: 'failed', http_status: res.status, error: `GoPlus refused the access token (HTTP ${res.status})`, attempts: attempt };
        continue;
      }
      if (res.status === 429) {
        try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch (_) { /* nothing to release */ }
        return { kind: 'rate_limited', http_status: 429, retry_after_ms: require('./market').retryAfterMs(res), attempts: attempt };
      }
      text = await res.text();
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      failure = { kind: 'failed', error: timedOut ? `no answer within ${Math.round(timeoutMs / 1000)} s` : `the request failed: ${cleanText(String((err && err.message) || err), 160)}`, attempts: attempt };
      continue;
    }
    if (!res.ok) {
      failure = { kind: 'failed', http_status: res.status, error: `GoPlus answered HTTP ${res.status}`, attempts: attempt };
      if (res.status >= 500) continue;
      return failure;
    }
    let body = null;
    try { body = typeof text === 'string' && text && text.length <= MAX_BODY_CHARS ? JSON.parse(text) : null; } catch (_) { body = null; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      failure = { kind: 'failed', http_status: res.status, error: 'the answer was not a GoPlus result', attempts: attempt };
      continue;
    }
    const code = Number(body.code);
    if (code === 4029) return { kind: 'rate_limited', http_status: res.status, retry_after_ms: null, goplus_code: code, attempts: attempt };
    if (code !== 1 && code !== 2) {
      counts.answered++;
      return { kind: 'refused', http_status: res.status, goplus_code: Number.isFinite(code) ? code : null, error: `GoPlus answered code ${Number.isFinite(code) ? code : '?'}${body.message ? `: ${cleanText(String(body.message), 120)}` : ''}`, attempts: attempt };
    }
    counts.answered++;
    const result = body.result && typeof body.result === 'object' ? body.result : {};
    const want = addressKey(c.family, c.address);
    const entryKey = Object.keys(result).find((k) => addressKey(c.family, k) === want);
    const raw = entryKey !== undefined ? result[entryKey] : null;
    if (!raw || typeof raw !== 'object' || !Object.keys(raw).length) return { kind: 'not_found', http_status: res.status, goplus_code: code, attempts: attempt };
    return { kind: 'ok', http_status: res.status, goplus_code: code, partial: code === 2, raw, attempts: attempt };
  }
  return failure;
}

// ---------------------------------------------------------------------------
// Status, gate, backoff, request counts

// The status as it applies to the credential in use now: a rate limit or
// failure backoff met with the key never holds back a keyless run, and the
// other way round (the superseded limit is kept for the record). A status
// written before this was recorded counts as keyless: no key was used then.
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

function readStatus(ws) {
  let st;
  try {
    st = readJson(ws.abs(STATUS_REL), { state: 'never_run' });
  } catch (_) {
    st = { state: 'never_run', unreadable: true };
  }
  return forCredential(st);
}

function laterIso(iso, t) {
  return iso && Date.parse(iso) > t ? iso : isoOf(t);
}

function gateOf(status, now) {
  const until = status.retry_after_until ? Date.parse(status.retry_after_until) : 0;
  return until > now ? { open: false, until: status.retry_after_until } : { open: true, until: null };
}

// The gate a rate limit sets: GoPlus's own Retry-After when it sends one (never
// shortened to backoff_max_minutes), otherwise the desk's default, doubling per
// strike within an hour and capped at backoff_max_minutes.
function rateLimitFields(cfg, status, retryAfter, now) {
  const maxMs = cfg.backoff_max_minutes * 60000;
  const given = typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null;
  const prev = status.rate_limit || null;
  const prevEnd = prev && prev.until ? Date.parse(prev.until) : NaN;
  const strikes = !Number.isNaN(prevEnd) && now - prevEnd < 3600000 ? (prev.strikes || 1) + 1 : 1;
  const waitMs = given !== null
    ? Math.min(RETRY_AFTER_CEILING_MS, Math.max(RATE_LIMIT_MIN_MS, given))
    : Math.min(maxMs, Math.max(RATE_LIMIT_MIN_MS, RATE_LIMIT_DEFAULT_MS * 2 ** (strikes - 1)));
  const until = laterIso(status.retry_after_until, now + waitMs);
  return { retry_after_until: until, rate_limit: { at: isoOf(now), retry_after_ms: given, wait_ms: waitMs, strikes, until } };
}

function backoffMs(cfg, failures) {
  const base = cfg.backoff_initial_minutes * 60000;
  const max = cfg.backoff_max_minutes * 60000;
  const raw = Math.min(max, base * 2 ** Math.max(0, failures - 1));
  const jitter = raw * 0.2 * (crypto.randomInt(0, 1000) / 1000 - 0.5) * 2;
  return Math.max(base / 2, Math.round(raw + jitter));
}

function callCounts(status, now) {
  const today = ymdInTz(new Date(now));
  const month = today.slice(0, 7);
  const c = status.calls && status.calls.month === month ? { ...status.calls } : { month, month_count: 0, month_answered: 0, day: today, day_count: 0, day_answered: 0 };
  if (c.day !== today) {
    c.day = today;
    c.day_count = 0;
    c.day_answered = 0;
  }
  return c;
}

function addCalls(c, sent, answered) {
  return { ...c, month_count: (c.month_count || 0) + sent, day_count: (c.day_count || 0) + sent, month_answered: (c.month_answered || 0) + answered, day_answered: (c.day_answered || 0) + answered };
}

function updateStatus(ws, fn) {
  withLock(ws, 'screening_status', () => {
    const cur = readStatus(ws);
    replaceFile(ws, ws.abs(STATUS_REL), jsonText({ ...fn(cur), schema_version: 'cr.screening-status.v1', provider: 'goplus', credential: credential() }));
  });
}

// Reserves one request in this month's count before it is sent, under the
// save lock, so the count is on disk even if the process stops mid-request
// and no runner sends past the monthly budget. False when the budget is used
// up (nothing is counted then).
function reserveRequest(ws, cfg, now) {
  return withLock(ws, 'screening_status', () => {
    const cur = readStatus(ws);
    const c = callCounts(cur, now);
    if (cfg.monthly_request_budget && (c.month_count || 0) >= cfg.monthly_request_budget) return false;
    replaceFile(ws, ws.abs(STATUS_REL), jsonText({ ...cur, calls: addCalls(c, 1, 0), schema_version: 'cr.screening-status.v1', provider: 'goplus', credential: credential() }));
    return true;
  });
}

function blockedBy(status, now, { force = false } = {}) {
  const clock = require('./market').clock;
  const gate = gateOf(status, now);
  if (!gate.open) return { status: 'backoff', rate_limited: true, retry_at: gate.until, message: `Contracts not screened: GoPlus asked this server to wait; next try ${clock(gate.until, now)}.` };
  if (!force && status.next_allowed_at && Date.parse(status.next_allowed_at) > now) {
    return { status: 'backoff', rate_limited: false, retry_at: status.next_allowed_at, message: `Contracts not screened: backing off after ${status.consecutive_failures || 1} failed run(s); next try ${clock(status.next_allowed_at, now)}.` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cache files

function projectRel(id) {
  if (!isProjectId(id)) throw new OpError('BAD_ID', `Not a valid project ID: ${JSON.stringify(id)}`);
  return `${DIR}/${id}.json`;
}

function readProjectDoc(ws, id) {
  try {
    return readJson(ws.abs(projectRel(id)), null);
  } catch (_) {
    return null; // an unreadable cache file is screened again
  }
}

function writeProjectDoc(ws, id, doc) {
  withLock(ws, 'screening', () => replaceFile(ws, ws.abs(projectRel(id)), jsonText(doc)));
}

// Projects the desk screens: a verified identity, not archived, with at least
// one contract GoPlus can screen (the others never cost a request).
function screenedProjects(ws) {
  return require('./projects').listProjects(ws).filter((p) => !p.broken && p.status !== 'archived' && p.identity && p.identity.status === 'verified' && contractsOf(p.identity).some((c) => c.screenable));
}

function projectDue(ws, project, now) {
  const doc = readProjectDoc(ws, project.project_id);
  if (!doc || doc.contracts_key !== contractsKey(contractsOf(project.identity))) return true;
  return !(doc.next_attempt_at && Date.parse(doc.next_attempt_at) > now);
}

function isDue(ws, now = Date.now()) {
  if (!cfgOf(ws).enabled) return false;
  if (blockedBy(readStatus(ws), now)) return false;
  return screenedProjects(ws).some((p) => projectDue(ws, p, now));
}

// The alert transitions between two good screens of the same contract. Pure,
// for the tests.
function transitionsBetween(prev, next, { sellTaxAlertPct = DEFAULTS.sell_tax_alert_pct, at = null } = {}) {
  const out = [];
  if (!prev || !next || prev.status !== 'ok' || next.status !== 'ok') return out;
  for (const [key, words] of Object.entries(ALERT_CHECKS)) {
    if (prev.checks && next.checks && prev.checks[key] === 'absent' && next.checks[key] === 'present') {
      out.push({ at, chain: next.chain, chain_id: next.chain_id, address: next.address, check: key, from: 'absent', to: 'present', words });
    }
  }
  const was = prev.taxes ? prev.taxes.sell_pct : null;
  const now = next.taxes ? next.taxes.sell_pct : null;
  if (typeof was === 'number' && typeof now === 'number' && was <= sellTaxAlertPct && now > sellTaxAlertPct) {
    out.push({ at, chain: next.chain, chain_id: next.chain_id, address: next.address, check: 'sell_tax', from: `${was}%`, to: `${now}%`, words: `sell tax rose to ${now}%` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Refresh

// Screens the projects that are due (all of them, or the ones named, when
// forced: a manual refresh skips the failure backoff, never a rate limit).
// Returns { status: ok | partial | failed | backoff | busy | noop |
// budget_paused | skipped, message, ... }.
async function refresh(ws, opts = {}) {
  const { trigger = 'manual', fetchImpl = fetch, force = false, projectIds = null, retryDelayMs = 1500, pauseMs = 1200 } = opts;
  const clock = () => (opts.now !== undefined ? opts.now : Date.now());
  const cfg = cfgOf(ws);
  if (!cfg.enabled) return { status: 'skipped', message: 'Contract screening is turned off in settings.' };
  const now0 = clock();
  const blocked = blockedBy(readStatus(ws), now0, { force });
  if (blocked) return blocked;
  let list = screenedProjects(ws);
  if (Array.isArray(projectIds)) list = list.filter((p) => projectIds.includes(p.project_id));
  if (!force) list = list.filter((p) => projectDue(ws, p, now0));
  if (!list.length) {
    return { status: 'noop', message: Array.isArray(projectIds) ? 'Nothing to screen: none of those projects has a contract on a verified, active identity.' : 'No contract screens are due.', screened: [], not_screened: [] };
  }
  // Fit the run to the per-run cap and the month's budget, whole projects only.
  const budget = cfg.monthly_request_budget || null;
  const used = callCounts(readStatus(ws), now0).month_count;
  let room = Math.max(1, cfg.max_contracts_per_run || 1);
  if (budget) {
    if (budget - used <= 0) return { status: 'budget_paused', message: `Monthly GoPlus request budget reached (${used} of ${budget}). Saved screens stay as they are.` };
    room = Math.min(room, budget - used);
  }
  const fitted = [];
  let take = 0;
  for (const p of list) {
    const n = contractsOf(p.identity).filter((c) => c.screenable).length;
    if (fitted.length && take + n > room) break;
    fitted.push(p);
    take += n;
  }
  const timeoutMs = Math.max(1, cfg.timeout_seconds) * 1000;
  const ttl = Math.max(1, take) * (timeoutMs * cfg.max_attempts + retryDelayMs + pauseMs) + 60000;
  const lease = acquireLease(ws, LEASE, ttl, { label: trigger });
  if (!lease) return { status: 'busy', message: 'Another contract screening run is in progress; its result will be used.' };
  try {
    const again = blockedBy(readStatus(ws), clock(), { force });
    if (again) return again;
    return await refreshLeased(ws, fitted, { trigger, fetchImpl, cfg, clock, retryDelayMs, pauseMs, timeoutMs });
  } finally {
    releaseLease(ws, LEASE, lease);
  }
}

async function refreshLeased(ws, list, { trigger, fetchImpl, cfg, clock, retryDelayMs, pauseMs, timeoutMs }) {
  const counts = { sent: 0, answered: 0 };
  const results = [];
  let limited = null;
  let exhausted = false;
  let sentAny = false;
  const reserve = () => reserveRequest(ws, cfg, clock());
  // An access token when a key and secret are set; keyless otherwise, or when
  // GoPlus issues none (never a screening failure: the run goes on keyless).
  const creds = credentials();
  const tok = await accessToken(creds, { fetchImpl, timeoutMs, now: clock(), reserve, counts });
  sentAny = counts.sent > 0; // a token request also spaces the next one
  const auth = { token: tok.token || null, dropped: null };
  const authNote = creds.mode !== 'app_key' ? creds.note : tok.token ? null : `key set, but ${tok.why}; this run went keyless`;
  for (const p of list) {
    const contracts = contractsOf(p.identity);
    const key = contractsKey(contracts);
    if (limited || exhausted) {
      results.push({ project_id: p.project_id, outcome: 'not_attempted', error: limited ? 'not attempted: GoPlus rate-limited this run' : 'not attempted: the monthly GoPlus request budget is used up' });
      continue;
    }
    const screened = [];
    let failure = null;
    for (const c of contracts) {
      if (!c.screenable) {
        screened.push({ chain: c.chain, chain_id: c.chain_id, family: c.family, label: c.label, address: c.address, status: c.family ? 'invalid_address' : 'unsupported_chain', reason: c.reason });
        continue;
      }
      if (sentAny && pauseMs) await sleep(pauseMs);
      sentAny = true;
      const url = screenUrl(c);
      const r = await getScreen(url, c, { fetchImpl, timeoutMs, maxAttempts: Math.max(1, cfg.max_attempts), retryDelayMs, counts, reserve, auth });
      if (r.kind === 'budget') {
        // A project that cannot be finished publishes nothing: its last good
        // screen stays, with this reason.
        exhausted = true;
        failure = { outcome: 'budget_paused', error: `${c.label} ${c.address}: the monthly GoPlus request budget (${cfg.monthly_request_budget}) was used up during this run${r.after ? ` after ${r.after.error}` : ''}; nothing from this project's run was used`, http_status: (r.after && r.after.http_status) || null };
        break;
      }
      if (r.kind === 'rate_limited') {
        limited = r;
        failure = { outcome: 'rate_limited', error: `${c.label} ${c.address}: GoPlus rate-limited the request` };
        break;
      }
      if (r.kind === 'failed') {
        failure = { outcome: 'failed', error: `${c.label} ${c.address}: ${r.error}${r.attempts > 1 ? ` (after ${r.attempts} attempts)` : ''}`, http_status: r.http_status || null };
        break;
      }
      const at = isoOf(clock());
      const base = { chain: c.chain, chain_id: c.chain_id, family: c.family, label: c.label, address: c.address, checked_at: at, endpoint: url, http_status: r.http_status || null, goplus_code: r.goplus_code ?? null };
      if (r.kind === 'refused') screened.push({ ...base, status: 'refused', reason: r.error });
      else if (r.kind === 'not_found') screened.push({ ...base, status: 'not_found', reason: 'GoPlus has no record of this contract' });
      else {
        const n = c.family === 'solana' ? normalizeSolana(r.raw) : normalizeEvm(r.raw);
        screened.push({ ...base, status: 'ok', partial: Boolean(r.partial), ...n, ...flagsOf(c.family, n.checks) });
      }
    }
    const now = clock();
    const at = isoOf(now);
    const prev = readProjectDoc(ws, p.project_id);
    const same = prev && prev.contracts_key === key ? prev : null;
    const docBase = { schema_version: 'cr.screening-project.v1', project_id: p.project_id, contracts_key: key };
    const kept = { snapshot: same && same.snapshot ? same.snapshot : null, last_good_at: same ? same.last_good_at || null : null };
    // Alerts are kept across contract changes for the contracts still on record.
    const keepTransitions = (prev && Array.isArray(prev.transitions) ? prev.transitions : []).filter((t) => contracts.some((c) => c.chain_id === t.chain_id && c.address === t.address));
    let doc;
    if (failure && failure.outcome === 'budget_paused') {
      // Not GoPlus's failure: no backoff; the monthly admission check holds it.
      doc = { ...docBase, ...kept, transitions: keepTransitions, last_attempt: { at, trigger, outcome: failure.outcome, error: failure.error, http_status: failure.http_status || null }, consecutive_failures: (same && same.consecutive_failures) || 0, next_attempt_at: isoOf(now + cfg.refresh_hours * 3600000) };
    } else if (failure) {
      const fails = ((same && same.consecutive_failures) || 0) + 1;
      doc = { ...docBase, ...kept, transitions: keepTransitions, last_attempt: { at, trigger, outcome: failure.outcome, error: failure.error, http_status: failure.http_status || null }, consecutive_failures: fails, next_attempt_at: isoOf(now + Math.min(cfg.refresh_hours * 3600000, backoffMs(cfg, fails))) };
    } else {
      const before = new Map(((same && same.snapshot && same.snapshot.contracts) || (prev && prev.snapshot && prev.snapshot.contracts) || []).map((x) => [`${x.chain_id}:${x.family ? addressKey(x.family, x.address) : x.address}`, x]));
      const fresh = screened.flatMap((x) => transitionsBetween(before.get(`${x.chain_id}:${x.family ? addressKey(x.family, x.address) : x.address}`), x, { sellTaxAlertPct: cfg.sell_tax_alert_pct, at }));
      const snapshot = { schema_version: 'cr.screening-snapshot.v1', provider: 'GoPlus Security', fetched_at: at, contracts: screened };
      doc = { ...docBase, snapshot, last_good_at: at, transitions: [...fresh, ...keepTransitions].slice(0, MAX_TRANSITIONS), last_attempt: { at, trigger, outcome: 'ok', error: null }, consecutive_failures: 0, next_attempt_at: isoOf(now + cfg.refresh_hours * 3600000) };
    }
    let outcome = doc.last_attempt.outcome;
    let error = doc.last_attempt.error;
    try {
      writeProjectDoc(ws, p.project_id, doc);
    } catch (err) {
      outcome = 'failed';
      error = `screened, but the cache could not be saved: ${err.message}`;
    }
    results.push({ project_id: p.project_id, outcome, error, alerts: failure ? 0 : doc.transitions.filter((t) => t.at === doc.last_good_at).length });
  }

  const now = clock();
  const ok = results.filter((r) => r.outcome === 'ok');
  const transient = results.filter((r) => ['failed', 'rate_limited', 'not_attempted', 'budget_paused'].includes(r.outcome));
  const status = exhausted && !ok.length ? 'budget_paused' : transient.length ? (ok.length ? 'partial' : 'failed') : 'ok';
  const offline = !ok.length && results.some((r) => r.outcome === 'failed');
  const alerts = ok.reduce((a, r) => a + (r.alerts || 0), 0);
  // Which credential the run used, in words that never carry the key.
  const authUsed = creds.mode === 'app_key' && tok.token ? (auth.dropped ? 'access token, then keyless' : 'access token') : 'keyless';
  const authWhy = auth.dropped || authNote || null;
  const message = [
    `Contract screening: ${ok.length} of ${results.length} project(s) screened.`,
    alerts ? `${alerts} new alert(s).` : '',
    transient.length ? `Not screened: ${transient.map((r) => `${r.project_id} (${r.error})`).join('; ')}.` : '',
    exhausted ? `Monthly GoPlus request budget reached (${cfg.monthly_request_budget}); saved screens stay as they are.` : '',
    authWhy ? `GoPlus credential: ${authWhy}.` : '',
  ].filter(Boolean).join(' ');
  updateStatus(ws, (cur) => {
    const failures = offline ? (cur.consecutive_failures || 0) + 1 : ok.length ? 0 : cur.consecutive_failures || 0;
    const next = {
      ...cur,
      state: status,
      last_run: { at: isoOf(now), trigger, status, screened: ok.length, not_screened: transient.length, alerts, requests: counts.sent, auth: authUsed, auth_note: authWhy, summary: message.slice(0, 600) },
      ...(ok.length ? { last_success_at: isoOf(now) } : {}),
      consecutive_failures: failures,
      next_allowed_at: offline ? laterIso(cur.next_allowed_at, now + backoffMs(cfg, failures)) : ok.length ? null : cur.next_allowed_at || null,
      // Each request was counted when it was reserved (reserveRequest); only
      // the answers are added now.
      calls: addCalls(callCounts(cur, now), 0, counts.answered),
    };
    return limited ? { ...next, ...rateLimitFields(cfg, cur, limited.retry_after_ms, now) } : next;
  });
  const gate = gateOf(readStatus(ws), now);
  return {
    status,
    message,
    screened: ok.map((r) => r.project_id),
    not_screened: transient.map((r) => ({ project_id: r.project_id, outcome: r.outcome, error: r.error })),
    alerts,
    requests: counts.sent,
    ...(limited ? { rate_limited: true, retry_at: gate.until } : {}),
  };
}

// ---------------------------------------------------------------------------
// Reading what was saved (never fetches)

// The state of one project's contract screen:
//   disabled           screening is turned off in settings
//   identity_pending   the identity is not verified, so nothing is screened
//   native_chain       no contract on record and the identity says the token
//                      is its chain's native coin
//   no_contract        no contract on record
//   unsupported        contracts on record, none on a chain GoPlus screens (or
//                      none with a valid address)
//   pending            contracts on record, not screened yet (or changed since)
//   unavailable        no screen for these contracts; the last try failed
//   fresh              a screen of these contracts within stale_hours
//   fresh_last_failed  the same, but the latest run failed (shown)
//   stale              a screen older than stale_hours
function stateFor(ws, project, now = Date.now()) {
  const cfg = cfgOf(ws);
  const id = (project && project.identity) || {};
  const native = id.native_chain === true;
  if (!cfg.enabled) return { state: 'disabled', native, reason: 'Contract screening is turned off in settings.' };
  if (id.status !== 'verified') return { state: 'identity_pending', native, reason: 'The project\'s identity is not verified, so its contracts are not screened.' };
  const contracts = contractsOf(id);
  if (!contracts.length) {
    return native
      ? { state: 'native_chain', native, contracts, reason: 'The identity records this token as its chain\'s native coin: there is no token contract to screen.' }
      : { state: 'no_contract', native, contracts, reason: 'No contract address is on record for this token.' };
  }
  if (!contracts.some((c) => c.screenable)) return { state: 'unsupported', native, contracts, reason: contracts.map((c) => c.reason).join('; ') };
  const doc = isProjectId(project.project_id) ? readProjectDoc(ws, project.project_id) : null;
  const mine = doc && doc.contracts_key === contractsKey(contracts) ? doc : null;
  const transitions = doc && Array.isArray(doc.transitions) ? doc.transitions : [];
  const last = mine ? mine.last_attempt || null : null;
  const snap = mine && mine.snapshot ? mine.snapshot : null;
  const failed = last && last.outcome !== 'ok' ? last : null;
  if (!snap) {
    if (!last) return { state: 'pending', native, contracts, transitions, reason: doc ? 'The contracts on record changed since the last screen; not screened yet.' : 'Not screened yet.', last_attempt: null, next_attempt_at: null };
    return { state: 'unavailable', native, contracts, transitions, reason: last.error, last_attempt: last, next_attempt_at: mine.next_attempt_at || null };
  }
  const fetchedMs = Date.parse(snap.fetched_at);
  const ageHours = Number.isNaN(fetchedMs) ? null : Math.max(0, Math.round(((now - fetchedMs) / 3600000) * 10) / 10);
  const stale = ageHours === null || ageHours > cfg.stale_hours;
  const state = stale ? 'stale' : failed ? 'fresh_last_failed' : 'fresh';
  const reason = stale
    ? `The saved screen is ${ageHours === null ? 'of unknown age' : `${Math.round(ageHours)} h old`}, older than ${cfg.stale_hours} h.${failed ? ` The latest run failed: ${failed.error}` : ''}`
    : failed ? `The latest run failed (${failed.error}); this is the screen from ${snap.fetched_at}.` : null;
  return { state, native, contracts, transitions, reason, snapshot: snap, age_hours: ageHours, last_attempt: last, next_attempt_at: mine.next_attempt_at || null };
}

// One contract as the packet and the index carry it.
function contractView(x) {
  const base = { chain: x.chain, chain_id: x.chain_id, label: x.label, family: x.family || null, address: x.address, status: x.status };
  if (x.status !== 'ok') return { ...base, reason: x.reason || null };
  return { ...base, partial: Boolean(x.partial), checked_at: x.checked_at, checks: x.checks, taxes: x.taxes, owner: x.owner, source: x.source, facts: x.facts || null, severe: x.severe, watch: x.watch, unknown: x.unknown, notes: x.notes };
}

// The block a research run's evidence packet will carry (research.js, once
// packet_mode is "include"): the contracts, each check as GoPlus answered it,
// when, and the note that the desk captured it.
function packetBlock(ws, project, { now = Date.now() } = {}) {
  const cfg = cfgOf(ws);
  const s = stateFor(ws, project, now);
  const block = { schema_version: 'cr.contract-screen.v1', provider: 'GoPlus Security', mode: cfg.packet_mode, state: s.state, reason: s.reason || null, native_chain: s.native, note: NOTE };
  if (s.last_attempt && s.last_attempt.outcome !== 'ok') block.last_refresh_failure = { at: s.last_attempt.at, outcome: s.last_attempt.outcome, error: s.last_attempt.error };
  if (s.snapshot) Object.assign(block, { fetched_at: s.snapshot.fetched_at, age_hours: s.age_hours, contracts: s.snapshot.contracts.map(contractView) });
  else if (s.contracts) block.contracts = s.contracts.map((c) => ({ chain: c.chain, chain_id: c.chain_id, label: c.label, address: c.address, status: c.screenable ? 'not_screened' : c.family ? 'invalid_address' : 'unsupported_chain', reason: c.screenable ? null : c.reason }));
  return block;
}

// Whether research.js puts the block in new evidence packets.
function includeInPacket(ws) {
  return cfgOf(ws).enabled && cfgOf(ws).packet_mode === 'include';
}

// The review-queue alerts still in their window.
function recentTransitions(ws, s, now) {
  const days = cfgOf(ws).alert_days;
  return (s.transitions || []).filter((t) => t.at && now - Date.parse(t.at) <= days * 86400000);
}

// The project page and the connector: the packet block, the recent alerts and
// when the next run may screen it.
function view(ws, project, { now = Date.now() } = {}) {
  const s = stateFor(ws, project, now);
  return { ...packetBlock(ws, project, { now }), alerts: recentTransitions(ws, s, now), last_attempt: s.last_attempt || null, next_attempt_at: s.next_attempt_at || null };
}

// One project's line in the dashboard index: state, each contract in brief,
// and the recent alerts.
function summary(ws, project, now = Date.now()) {
  const s = stateFor(ws, project, now);
  const contracts = s.snapshot
    ? s.snapshot.contracts.map((x) => (x.status === 'ok'
      ? { chain: x.chain, label: x.label, address: x.address, status: 'ok', mint: x.checks.mint, blacklist: x.family === 'solana' ? x.checks.freeze : x.checks.blacklist, proxy: x.family === 'solana' ? null : x.checks.proxy, family: x.family, sell_tax_pct: x.taxes ? x.taxes.sell_pct : null, severe: x.severe, watch: x.watch, unknown: x.unknown }
      : { chain: x.chain, label: x.label, address: x.address, status: x.status, reason: x.reason || null }))
    : (s.contracts || []).map((c) => ({ chain: c.chain, label: c.label, address: c.address, status: c.screenable ? 'not_screened' : c.family ? 'invalid_address' : 'unsupported_chain', reason: c.screenable ? null : c.reason }));
  return {
    state: s.state,
    reason: s.reason || null,
    native_chain: s.native,
    fetched_at: s.snapshot ? s.snapshot.fetched_at : null,
    age_hours: s.snapshot ? s.age_hours : null,
    contracts,
    alerts: recentTransitions(ws, s, now),
    last_error: s.last_attempt && s.last_attempt.outcome !== 'ok' ? s.last_attempt.error : null,
  };
}

// The whole desk (doctor, start log): states, the last run, the gate, the
// request counts.
function overview(ws, now = Date.now()) {
  const cfg = cfgOf(ws);
  const st = readStatus(ws);
  const states = {};
  let alerts = 0;
  // Contracts on a verified identity that can never be screened: a chain
  // GoPlus does not list, or an address that does not fit its chain.
  const identityIssues = [];
  for (const p of require('./projects').listProjects(ws).filter((x) => !x.broken && x.status !== 'archived')) {
    const s = stateFor(ws, p, now);
    states[s.state] = (states[s.state] || 0) + 1;
    alerts += recentTransitions(ws, s, now).length;
    if (p.identity && p.identity.status === 'verified') {
      for (const c of contractsOf(p.identity).filter((x) => !x.screenable)) identityIssues.push({ project_id: p.project_id, kind: c.family ? 'invalid_address' : 'unsupported_chain', chain: c.chain, address: c.address, reason: c.reason });
    }
  }
  const gate = gateOf(st, now);
  const creds = credentials();
  return {
    enabled: cfg.enabled,
    // "app_key" (GOPLUS_APP_KEY and GOPLUS_APP_SECRET set) or "keyless"; the
    // note says why a key that is set is not used. Never the key itself.
    credential: creds.mode,
    credential_note: creds.note,
    screened: ['fresh', 'fresh_last_failed', 'stale'].reduce((a, k) => a + (states[k] || 0), 0),
    states,
    alerts,
    identity_issues: identityIssues,
    last_run: st.last_run || null,
    last_success_at: st.last_success_at || null,
    consecutive_failures: st.consecutive_failures || 0,
    rate_limited: !gate.open,
    retry_at: gate.until || (st.next_allowed_at && Date.parse(st.next_allowed_at) > now ? st.next_allowed_at : null),
    calls: callCounts(st, now),
    budget_monthly: cfg.monthly_request_budget || null,
    refresh_hours: cfg.refresh_hours,
    packet_mode: cfg.packet_mode,
  };
}

module.exports = {
  ORIGIN,
  DIR,
  STATUS_REL,
  LEASE,
  DEFAULTS,
  NOTE,
  EVM_CHECKS,
  SOL_CHECKS,
  ALERT_CHECKS,
  tri,
  taxPct,
  normalizeEvm,
  normalizeSolana,
  flagsOf,
  contractsOf,
  contractsKey,
  screenUrl,
  transitionsBetween,
  readStatus,
  readProjectDoc,
  credential,
  isDue,
  refresh,
  stateFor,
  packetBlock,
  includeInPacket,
  view,
  summary,
  overview,
};
