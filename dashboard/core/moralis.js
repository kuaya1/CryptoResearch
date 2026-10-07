'use strict';
// Moralis Web3 Data API: read-only wallet data for the wallet sync
// (walletsync.js). Two endpoints, as Moralis documents them (checked
// 2026-10-07, API v2.2):
//   GET /wallets/{address}/history   decoded transactions, newest first, with
//       category, receipt_status, transaction_fee, possible_spam,
//       native_transfers and erc20_transfers (raw value, token_decimals,
//       log_index). 150 compute units (CU) a page. from_date / to_date bound a
//       window; cursor continues it.
//   GET /wallets/{address}/tokens    balances: native_token, raw balance,
//       decimals, possible_spam, verified_contract. 100 CU a page; cursor.
// Authentication is the X-API-Key header. Moralis limits throughput per plan
// over a rolling 4-second window and answers 429 when it is exceeded; a
// Retry-After it sends is honored (market.retryAfterMs).
//
// Only public data is read: a public address and the chain. Nothing here can
// sign, approve or move anything, and no wallet is connected.
//
// The key comes from MORALIS_API_KEY or "moralis_api_key" in
// ~/.cryptoresearch/secrets.json. It is sent only in the request header,
// never written to a file, a log line, an error message or a reply. URLs carry
// the address, so they are never logged either: errors name the endpoint and
// the HTTP status only.
//
// Tested against fixtures shaped like the documented responses (fictional
// addresses and values), not a live account.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ORIGIN = 'https://deep-index.moralis.io';
const BASE = '/api/v2.2';
const CU = { history: 150, tokens: 100 };
const PAGE_LIMIT = 100;
const MAX_BODY_CHARS = 8 * 1024 * 1024;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^\d{1,80}$/;
const DECIMAL = /^\d{1,60}(\.\d{1,80})?$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function secretsFile() {
  return path.join(os.homedir(), '.cryptoresearch', 'secrets.json');
}

// The key itself (server-side use only).
function apiKey(env = process.env) {
  const k = typeof env.MORALIS_API_KEY === 'string' ? env.MORALIS_API_KEY.trim() : '';
  if (k) return k;
  try {
    const s = JSON.parse(fs.readFileSync(secretsFile(), 'utf8'));
    return typeof s.moralis_api_key === 'string' && s.moralis_api_key.trim() ? s.moralis_api_key.trim() : null;
  } catch (_) {
    return null;
  }
}

// Safe to show: whether a key is present and where it would come from.
function keyStatus(env = process.env) {
  if (typeof env.MORALIS_API_KEY === 'string' && env.MORALIS_API_KEY.trim()) return { present: true, source: 'environment variable MORALIS_API_KEY' };
  if (apiKey({})) return { present: true, source: `${secretsFile()} (moralis_api_key)` };
  return { present: false, source: null, how: 'Set MORALIS_API_KEY in Render > Environment (online desk), or put "moralis_api_key" in ~/.cryptoresearch/secrets.json (PC).' };
}

// The one URL each request goes to: fixed origin and path, the validated
// address encoded, the network's Moralis name from the desk's own table.
function historyUrl(address, chain, { cursor = null, fromDate = null, toDate = null } = {}) {
  if (!EVM_ADDRESS.test(String(address || ''))) throw new Error('Not an EVM address');
  const url = new URL(`${ORIGIN}${BASE}/wallets/${encodeURIComponent(address)}/history`);
  url.searchParams.set('chain', chain);
  url.searchParams.set('order', 'DESC');
  url.searchParams.set('limit', String(PAGE_LIMIT));
  url.searchParams.set('include_internal_transactions', 'true');
  url.searchParams.set('nft_metadata', 'false');
  if (fromDate) url.searchParams.set('from_date', fromDate);
  if (toDate) url.searchParams.set('to_date', toDate);
  if (cursor) url.searchParams.set('cursor', cursor);
  if (url.origin !== ORIGIN) throw new Error('Unexpected origin');
  return url.toString();
}

function tokensUrl(address, chain, { cursor = null } = {}) {
  if (!EVM_ADDRESS.test(String(address || ''))) throw new Error('Not an EVM address');
  const url = new URL(`${ORIGIN}${BASE}/wallets/${encodeURIComponent(address)}/tokens`);
  url.searchParams.set('chain', chain);
  url.searchParams.set('limit', String(PAGE_LIMIT));
  if (cursor) url.searchParams.set('cursor', cursor);
  if (url.origin !== ORIGIN) throw new Error('Unexpected origin');
  return url.toString();
}

// One page, with a bounded retry for a failure that may be transient (no
// answer, a timeout, a 5xx, an unreadable answer). Each attempt is reserved
// against the CU budget before it is sent (reserve); when it says no, nothing
// is sent. A 429 stops at once; a 401 or 403 means the key was refused (or the
// plan's quota is used up) and stops the run.
async function getPage(url, { endpoint, fetchImpl, key, timeoutMs = 20000, maxAttempts = 2, retryDelayMs = 1500, reserve = () => true, counts = { sent: 0, answered: 0 } }) {
  let failure = null;
  const cu = CU[endpoint] || 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1 && retryDelayMs) await sleep(retryDelayMs);
    if (!reserve(cu)) return { kind: 'budget', attempts: attempt - 1, after: failure };
    counts.sent++;
    let res;
    let text;
    try {
      res = await fetchImpl(url, { headers: { accept: 'application/json', 'X-API-Key': key, 'user-agent': 'CryptoResearch-desk' }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429) {
        try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch (_) { /* nothing to release */ }
        return { kind: 'rate_limited', http_status: 429, retry_after_ms: require('./market').retryAfterMs(res), attempts: attempt };
      }
      text = await res.text();
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      failure = { kind: 'failed', error: timedOut ? `no answer within ${Math.round(timeoutMs / 1000)} s` : 'the request failed (network)', attempts: attempt };
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      counts.answered++;
      return { kind: 'key_refused', http_status: res.status, error: `Moralis refused the key (HTTP ${res.status}): the key is wrong, or the plan's compute units are used up`, attempts: attempt };
    }
    if (!res.ok) {
      failure = { kind: 'failed', http_status: res.status, error: `Moralis answered HTTP ${res.status}`, attempts: attempt };
      if (res.status >= 500) continue;
      counts.answered++;
      return { ...failure, kind: 'refused' };
    }
    let body = null;
    try { body = typeof text === 'string' && text && text.length <= MAX_BODY_CHARS ? JSON.parse(text) : null; } catch (_) { body = null; }
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.result)) {
      failure = { kind: 'failed', http_status: res.status, error: 'the answer was not a Moralis result page', attempts: attempt };
      continue;
    }
    counts.answered++;
    const cursor = typeof body.cursor === 'string' && body.cursor.trim() ? body.cursor.trim() : null;
    return { kind: 'ok', http_status: res.status, body, cursor, attempts: attempt, cu };
  }
  return failure;
}

// ---------------------------------------------------------------------------
// Normalizing what Moralis returns. Text from Moralis is data: control
// characters out, whitespace collapsed, length capped. Numbers that carry
// quantities stay integer strings (never floats).

function cleanText(v, max = 80) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const lower = (a) => (typeof a === 'string' && EVM_ADDRESS.test(a) ? a.toLowerCase() : null);
const uintOf = (v) => {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  if (typeof v === 'string' && UINT.test(v.trim())) return v.trim().replace(/^0+(?=\d)/, '');
  return null;
};
const intOf = (v) => {
  const s = uintOf(v);
  return s === null || s.length > 9 ? null : Number(s);
};
const boolOf = (v) => v === true || v === 'true' || v === 1 || v === '1';

function isoOf(v) {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// The fee the wallet paid, exact: Moralis's transaction_fee when it is a
// decimal string, else gas used times gas price (wei), else unknown. On
// rollups the second omits the L1 data fee; reconciliation shows that.
function feeOf(item) {
  if (typeof item.transaction_fee === 'string' && DECIMAL.test(item.transaction_fee.trim())) return { amount: item.transaction_fee.trim(), basis: 'transaction_fee' };
  const used = uintOf(item.receipt_gas_used);
  const price = uintOf(item.gas_price);
  if (used !== null && price !== null) return { amount_raw: (BigInt(used) * BigInt(price)).toString(), basis: 'gas_used_times_price' };
  return { amount: null, basis: null };
}

// One history item as a provider-neutral transaction, or { error } when it
// cannot be read (no valid hash, block or time).
function normalizeHistoryItem(item) {
  if (!item || typeof item !== 'object') return { error: 'not an object' };
  const hash = typeof item.hash === 'string' && TX_HASH.test(item.hash) ? item.hash.toLowerCase() : null;
  const block = uintOf(item.block_number);
  const at = isoOf(item.block_timestamp);
  if (!hash || block === null || !at) return { error: 'missing hash, block number or block time', hash };
  const status = item.receipt_status === undefined || item.receipt_status === null ? null : String(item.receipt_status).trim();
  const native = [];
  for (const n of Array.isArray(item.native_transfers) ? item.native_transfers : []) {
    const value = uintOf(n && n.value);
    native.push({ from: lower(n && n.from_address), to: lower(n && n.to_address), value_raw: value, internal: boolOf(n && n.internal_transaction), symbol: cleanText(n && n.token_symbol, 16) });
  }
  const tokens = [];
  for (const e of Array.isArray(item.erc20_transfers) ? item.erc20_transfers : []) {
    tokens.push({
      contract: lower(e && e.address),
      from: lower(e && e.from_address),
      to: lower(e && e.to_address),
      value_raw: uintOf(e && e.value),
      decimals: intOf(e && e.token_decimals),
      log_index: intOf(e && e.log_index),
      symbol: cleanText(e && e.token_symbol, 24),
      name: cleanText(e && e.token_name, 64),
      possible_spam: boolOf(e && e.possible_spam),
      verified_contract: e && e.verified_contract !== undefined ? boolOf(e.verified_contract) : null,
    });
  }
  const nftCount = Array.isArray(item.nft_transfers) ? item.nft_transfers.length : 0;
  return {
    hash,
    block_number: block,
    block_hash: typeof item.block_hash === 'string' && TX_HASH.test(item.block_hash) ? item.block_hash.toLowerCase() : null,
    block_timestamp: at,
    from: lower(item.from_address),
    to: lower(item.to_address),
    receipt_status: status === '1' || status === '0' ? status : null,
    category: cleanText(item.category, 40),
    summary: cleanText(item.summary, 160),
    possible_spam: boolOf(item.possible_spam),
    fee: feeOf(item),
    native,
    tokens,
    nft_transfers: nftCount,
  };
}

// One balance row, or { error }.
function normalizeTokenBalance(row) {
  if (!row || typeof row !== 'object') return { error: 'not an object' };
  const native = boolOf(row.native_token);
  const contract = native ? null : lower(row.token_address);
  const balance = uintOf(row.balance);
  const decimals = intOf(row.decimals);
  if ((!native && !contract) || balance === null || decimals === null || decimals > 255) return { error: 'missing token address, balance or decimals', contract };
  const price = typeof row.usd_price === 'number' && Number.isFinite(row.usd_price) && row.usd_price >= 0 ? row.usd_price : null;
  return {
    native,
    contract,
    decimals,
    balance_raw: balance,
    symbol: cleanText(row.symbol, 24),
    name: cleanText(row.name, 64),
    possible_spam: boolOf(row.possible_spam),
    verified_contract: row.verified_contract === undefined || row.verified_contract === null ? null : boolOf(row.verified_contract),
    provider_usd_price: price,
  };
}

module.exports = { ORIGIN, BASE, CU, PAGE_LIMIT, apiKey, keyStatus, historyUrl, tokensUrl, getPage, normalizeHistoryItem, normalizeTokenBalance, cleanText, feeOf, EVM_ADDRESS, TX_HASH };
