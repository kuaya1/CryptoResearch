'use strict';
// Alchemy: read-only wallet data for the wallet sync (walletsync.js), over
// JSON-RPC to one endpoint per network. Checked against Alchemy's documentation
// on 2026-10-07:
//   - The Free plan includes the Node API, the Transfers API and the Token API
//     (30M compute units a month, 25 requests a second).
//   - alchemy_getAssetTransfers (120 CU) supports Ethereum and the L2s Base,
//     Polygon, Arbitrum and Optimism. Its "internal" category (ETH sent by a
//     contract) exists only on Ethereum, Polygon and Base; block timestamps
//     (withMetadata) on all five. Results are ordered by block, paged by a
//     pageKey that lives 10 minutes; uniqueId identifies one transfer.
//     Amounts are taken from rawContract.value and rawContract.decimal (hex),
//     never from the float "value".
//   - alchemy_getTokenBalances (20 CU) and alchemy_getTokenMetadata (10 CU).
//   - Standard methods: eth_blockNumber (10), eth_getBlockByNumber (20),
//     eth_getBalance (20), eth_getTransactionReceipt (20; null when the
//     transaction is not in the chain), eth_getTransactionCount (counted 20
//     here as an estimate).
//   - Throughput is limited per second; past it Alchemy answers HTTP 429,
//     sometimes with Retry-After (honored), and a JSON-RPC error 429 on some
//     transports.
// The Portfolio API (200 CU, several networks per request, HTTP 200 with
// partial per-network failures) was not used: the per-network Token API gives
// the same balances for about 40 CU with one failure mode, and its prices are
// not used (the desk keeps its own price bindings).
//
// Only public data is read. Nothing here can sign, approve or move anything.
//
// The key comes from ALCHEMY_API_KEY or "alchemy_api_key" in
// ~/.cryptoresearch/secrets.json. It is part of the endpoint URL, so the URL
// never leaves this module: no log line, error, status file or reply carries
// it or the address in a request. Errors name the method and the HTTP status.
//
// Compute units counted by the desk are an estimate from Alchemy's published
// method costs; Alchemy's dashboard is the provider's record of usage.

const fs = require('fs');
const os = require('os');
const path = require('path');

// The networks Alchemy documents for the Transfers API, with their endpoint
// hosts and what the history there covers.
const NETWORKS = {
  eth: { host: 'eth-mainnet', internal: true, timestamps: true },
  base: { host: 'base-mainnet', internal: true, timestamps: true },
  polygon: { host: 'polygon-mainnet', internal: true, timestamps: true },
  arbitrum: { host: 'arb-mainnet', internal: false, timestamps: true },
  optimism: { host: 'opt-mainnet', internal: false, timestamps: true },
};

// Alchemy's published compute-unit cost per method (an estimate for the
// desk's own caps).
const CU = {
  eth_blockNumber: 10,
  eth_getBlockByNumber: 20,
  eth_getBalance: 20,
  eth_getTransactionReceipt: 20,
  eth_getTransactionCount: 20,
  alchemy_getAssetTransfers: 120,
  alchemy_getTokenBalances: 20,
  alchemy_getTokenMetadata: 10,
};

// keccak256("Transfer(address,address,uint256)"): the ERC-20 Transfer event.
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const MAX_BODY_CHARS = 16 * 1024 * 1024;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const KEY_SHAPE = /^[A-Za-z0-9_-]{8,128}$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function secretsFile() {
  return path.join(os.homedir(), '.cryptoresearch', 'secrets.json');
}

// The key itself (server-side use only).
function apiKey(env = process.env) {
  const k = typeof env.ALCHEMY_API_KEY === 'string' ? env.ALCHEMY_API_KEY.trim() : '';
  if (k) return k;
  try {
    const s = JSON.parse(fs.readFileSync(secretsFile(), 'utf8'));
    return typeof s.alchemy_api_key === 'string' && s.alchemy_api_key.trim() ? s.alchemy_api_key.trim() : null;
  } catch (_) {
    return null;
  }
}

// Safe to show: whether a key is present and where it would come from.
function keyStatus(env = process.env) {
  if (typeof env.ALCHEMY_API_KEY === 'string' && env.ALCHEMY_API_KEY.trim()) return { present: true, source: 'environment variable ALCHEMY_API_KEY' };
  if (apiKey({})) return { present: true, source: `${secretsFile()} (alchemy_api_key)` };
  return { present: false, source: null, how: 'Set ALCHEMY_API_KEY in Render > Environment (online desk), or put "alchemy_api_key" in ~/.cryptoresearch/secrets.json (PC).' };
}

function supports(network) {
  return Object.prototype.hasOwnProperty.call(NETWORKS, network);
}

// The one URL for a network: a fixed host from the table above. Private to
// this module.
function endpoint(network, key) {
  if (!supports(network)) throw new Error('Not a network the desk reads through Alchemy');
  if (!KEY_SHAPE.test(String(key || ''))) throw new Error('The Alchemy key does not have the expected shape');
  const url = new URL(`https://${NETWORKS[network].host}.g.alchemy.com/v2/${key}`);
  if (url.hostname !== `${NETWORKS[network].host}.g.alchemy.com`) throw new Error('Unexpected Alchemy host');
  return url.toString();
}

// Text from a provider or an error, safe to keep in status, logs and replies:
// no URL, no key, no address.
function scrub(text, key = null) {
  let t = String(text || '').replace(/https?:\/\/\S+/g, '[url]').replace(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g, '[address]');
  if (key && String(key).length >= 8) t = t.split(String(key)).join('[key]');
  return t;
}

let rpcId = 0;

// One JSON-RPC call, with a bounded retry for a failure that may be transient
// (no answer, a timeout, a 5xx, an unreadable answer). Each attempt reserves
// its compute units before it is sent (reserve); when it says no, nothing is
// sent. A 429 stops at once (Retry-After kept); a 401 or 403 means the key was
// refused; an error saying the plan's capacity is used up stops the run.
async function call(network, method, params, { fetchImpl, key, timeoutMs = 20000, maxAttempts = 2, retryDelayMs = 1200, reserve = () => true, counts = { sent: 0, answered: 0 } }) {
  const cu = CU[method] || 0;
  let failure = null;
  if (!supports(network)) return { kind: 'refused', error: `${method}: not a network the desk reads through Alchemy` };
  let url;
  try {
    url = endpoint(network, key);
  } catch (err) {
    return { kind: 'key_refused', error: err.message };
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1 && retryDelayMs) await sleep(retryDelayMs);
    if (!reserve(cu, method)) return { kind: 'budget', attempts: attempt - 1, after: failure };
    counts.sent++;
    let res;
    let text;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'CryptoResearch-desk' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429) {
        try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch (_) { /* nothing to release */ }
        return { kind: 'rate_limited', http_status: 429, retry_after_ms: require('./market').retryAfterMs(res), attempts: attempt };
      }
      text = await res.text();
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      failure = { kind: 'failed', error: `${method}: ${timedOut ? `no answer within ${Math.round(timeoutMs / 1000)} s` : 'the request failed (network)'}`, attempts: attempt };
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      counts.answered++;
      return { kind: 'key_refused', http_status: res.status, error: `Alchemy refused the key (HTTP ${res.status})`, attempts: attempt };
    }
    let body = null;
    try { body = typeof text === 'string' && text && text.length <= MAX_BODY_CHARS ? JSON.parse(text) : null; } catch (_) { body = null; }
    if (res.status >= 500 || !body || typeof body !== 'object') {
      failure = { kind: 'failed', http_status: res.status, error: `${method}: ${res.status >= 500 ? `Alchemy answered HTTP ${res.status}` : 'the answer was not JSON-RPC'}`, attempts: attempt };
      continue;
    }
    counts.answered++;
    if (body.error) {
      const code = Number(body.error.code);
      const msg = typeof body.error.message === 'string' ? scrub(body.error.message, key).slice(0, 160) : '';
      if (code === 429 || /compute units per second|rate limit|too many requests/i.test(msg)) return { kind: 'rate_limited', http_status: res.status, retry_after_ms: require('./market').retryAfterMs(res), attempts: attempt };
      if (/capacity|monthly limit|exceeded .*limit|upgrade your plan/i.test(msg)) return { kind: 'quota', http_status: res.status, error: `Alchemy says the plan's capacity is used up (${msg || `code ${code}`})`, attempts: attempt };
      if (/must be authenticated|invalid api key|unauthorized/i.test(msg)) return { kind: 'key_refused', http_status: res.status, error: 'Alchemy refused the key', attempts: attempt };
      return { kind: 'refused', http_status: res.status, code: Number.isFinite(code) ? code : null, error: `${method}: Alchemy answered error ${Number.isFinite(code) ? code : '?'}${msg ? ` (${msg})` : ''}`, attempts: attempt };
    }
    if (!res.ok) return { kind: 'refused', http_status: res.status, error: `${method}: Alchemy answered HTTP ${res.status}`, attempts: attempt };
    if (!('result' in body)) {
      failure = { kind: 'failed', http_status: res.status, error: `${method}: the answer had no result`, attempts: attempt };
      continue;
    }
    return { kind: 'ok', result: body.result, cu, attempts: attempt };
  }
  return failure;
}

// ---------------------------------------------------------------------------
// Normalizing answers. Text is data: control and direction characters out,
// whitespace collapsed, length capped. Quantities stay integer strings.

function cleanText(v, max = 80) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const lower = (a) => (typeof a === 'string' && EVM_ADDRESS.test(a) ? a.toLowerCase() : null);

// A hex quantity ("0x1a") as a decimal string, exact; null when it is not one.
function hexToDec(v) {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (/^0x[0-9a-fA-F]{1,80}$/.test(s)) return BigInt(s).toString();
  if (s === '0x') return '0';
  return null;
}

function hexToInt(v) {
  const d = hexToDec(v);
  return d === null || d.length > 15 ? null : Number(d);
}

function isoOf(v) {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// One transfer from alchemy_getAssetTransfers, or { error }.
function normalizeTransfer(t) {
  if (!t || typeof t !== 'object') return { error: 'not an object' };
  const hash = typeof t.hash === 'string' && TX_HASH.test(t.hash) ? t.hash.toLowerCase() : null;
  const block = hexToDec(t.blockNum);
  const category = ['external', 'internal', 'erc20'].includes(t.category) ? t.category : null;
  if (!hash || block === null || !category) return { error: 'missing hash, block or a category the desk reads', hash };
  const raw = t.rawContract && typeof t.rawContract === 'object' ? t.rawContract : {};
  const native = category !== 'erc20';
  const contract = native ? null : lower(raw.address);
  // A token transfer without its contract is incomplete, never a change.
  if (!native && !contract) return { error: 'a token transfer without its contract address', hash };
  const decimals = native ? 18 : hexToInt(raw.decimal);
  const value = hexToDec(raw.value);
  const uid = typeof t.uniqueId === 'string' && t.uniqueId.length <= 200 ? t.uniqueId.trim().toLowerCase() : null;
  const logMatch = uid ? uid.match(/:log:(\d{1,9})$/) : null;
  return {
    unique_id: uid || `${hash}:${category}:${lower(t.from)}:${lower(t.to)}:${value}`,
    hash,
    block_number: block,
    block_timestamp: isoOf(t.metadata && t.metadata.blockTimestamp),
    category,
    from: lower(t.from),
    to: lower(t.to),
    contract,
    value_raw: value,
    decimals,
    symbol: cleanText(t.asset, 24),
    log_index: logMatch ? Number(logMatch[1]) : null,
  };
}

// The facts a receipt gives: success, sender, block, the fee paid (gas used
// times effective price, plus the L1 data fee on OP-stack networks and blob
// gas when present), and its logs in brief. A deposit bridged in from
// Ethereum (OP-stack type 0x7e) is marked: its gas was paid on Ethereum. An
// OP-stack operator fee (zero on standard chains) is not computed: its formula
// changed between network upgrades, so such a fee stays unknown rather than
// guessed. null when the answer is not a receipt.
function normalizeReceipt(r) {
  if (!r || typeof r !== 'object') return null;
  const hash = typeof r.transactionHash === 'string' && TX_HASH.test(r.transactionHash) ? r.transactionHash.toLowerCase() : null;
  const block = hexToDec(r.blockNumber);
  if (!hash || block === null) return null;
  const status = r.status === '0x1' || r.status === 1 || r.status === '1' ? '1' : r.status === '0x0' || r.status === 0 || r.status === '0' ? '0' : null;
  const deposit = String(r.type || '').toLowerCase() === '0x7e' || r.depositNonce !== undefined;
  const used = hexToDec(r.gasUsed);
  const price = hexToDec(r.effectiveGasPrice);
  const operatorFee = [r.operatorFeeScalar, r.operatorFeeConstant].some((v) => v !== undefined && v !== null && hexToDec(v) !== '0');
  let fee = null;
  const parts = [];
  if (deposit) parts.push('a deposit from Ethereum: its gas was paid there');
  else if (operatorFee) parts.push('the receipt names an OP-stack operator fee, which the desk does not compute');
  else if (used !== null && price !== null) {
    let total = BigInt(used) * BigInt(price);
    parts.push('gas used × effective gas price');
    const l1 = hexToDec(r.l1Fee);
    if (l1 !== null) {
      total += BigInt(l1);
      parts.push('L1 data fee');
    }
    const blobUsed = hexToDec(r.blobGasUsed);
    const blobPrice = hexToDec(r.blobGasPrice);
    if (blobUsed !== null && blobPrice !== null) {
      total += BigInt(blobUsed) * BigInt(blobPrice);
      parts.push('blob gas');
    }
    fee = total.toString();
  }
  const logs = (Array.isArray(r.logs) ? r.logs : []).map((l) => ({ address: lower(l && l.address), topic0: l && Array.isArray(l.topics) && typeof l.topics[0] === 'string' ? l.topics[0].toLowerCase() : null, log_index: hexToInt(l && l.logIndex) }));
  return {
    tx_hash: hash,
    status,
    from: lower(r.from),
    to: lower(r.to),
    block_number: block,
    block_hash: typeof r.blockHash === 'string' && TX_HASH.test(r.blockHash) ? r.blockHash.toLowerCase() : null,
    fee_raw: fee,
    fee_basis: parts.join(' + ') || null,
    deposit,
    logs,
  };
}

function normalizeTokenBalance(row) {
  if (!row || typeof row !== 'object') return { error: 'not an object' };
  const contract = lower(row.contractAddress);
  if (!contract) return { error: 'no contract address' };
  if (row.error) return { contract, error: cleanText(String(row.error), 120) || 'balance unreadable' };
  const bal = hexToDec(row.tokenBalance);
  if (bal === null) return { contract, error: 'balance unreadable' };
  return { contract, balance_raw: bal };
}

function normalizeMetadata(m) {
  if (!m || typeof m !== 'object') return null;
  const decimals = Number.isInteger(m.decimals) && m.decimals >= 0 && m.decimals <= 255 ? m.decimals : null;
  return { name: cleanText(m.name, 64), symbol: cleanText(m.symbol, 24), decimals };
}

module.exports = { NETWORKS, CU, TRANSFER_TOPIC, apiKey, keyStatus, supports, call, scrub, normalizeTransfer, normalizeReceipt, normalizeTokenBalance, normalizeMetadata, cleanText, hexToDec, hexToInt, EVM_ADDRESS, TX_HASH };
