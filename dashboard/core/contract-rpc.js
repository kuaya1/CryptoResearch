'use strict';
// Read-only JSON-RPC for contract observations (Pillar 1, cr-contract-rpc@1).
//
//   - An allowlist of read methods. Anything else (eth_sendRawTransaction,
//     eth_sign*, personal_*, wallet_* …) is refused before a request is built.
//   - One block per observation: after pinTo(hash), every state read
//     (eth_getCode, eth_getStorageAt, eth_call) carries the EIP-1898 object
//     { blockHash, requireCanonical: true }. The one exception is the labeled
//     comparison at "latest" (compareLatest), used only to say the state is
//     changing. A node refusing the canonical pin ends the observation (reorg).
//   - Compute units are reserved on disk before each request is sent, against
//     Eric's contracts.daily_cu_cap and contracts.monthly_cu_cap. While either
//     is unset nothing is sent at all. A 429 closes the gate (Retry-After kept),
//     a used-up plan or a refused key stops the run, and a restored copy asks
//     nothing until it is released.
//   - The key (ALCHEMY_API_KEY, alchemy.js) is part of the endpoint URL and
//     never leaves this module: errors and status are scrubbed.
//
// Compute units are the desk's estimate. Alchemy's compute-unit page
// (alchemy.com/docs/reference/compute-units, read 2026-10-30) gives eth_call 26
// and eth_getLogs 75; eth_getBlockByNumber 20 is alchemy.js's figure. The page
// gave no figure for eth_getCode, eth_getStorageAt, eth_getBlockByHash or the
// Solana reads, so they are counted at eth_call's 26, the conservative side.
// Alchemy's dashboard is the provider's record of usage.

const { withLock, replaceFile, OpError } = require('./ops');
const { readJson, jsonText } = require('./fsx');
const { ymdInTz } = require('./dates');

const VERSION = 'cr-contract-rpc@1';
const STATE_REL = 'market-data/contracts/status.json';
const NETWORKS_REL = 'market-data/contracts/networks.json';

// The read methods, with their compute-unit estimate.
const CU = Object.freeze({
  eth_chainId: 0,
  eth_getBlockByNumber: 20,
  eth_getBlockByHash: 26,
  eth_getCode: 26,
  eth_getStorageAt: 26,
  eth_call: 26,
  eth_getLogs: 75,
  getAccountInfo: 26,
  getMultipleAccounts: 26,
});
const READ_METHODS = new Set(Object.keys(CU));
// State reads that must carry the observation's block.
const PINNED = new Set(['eth_getCode', 'eth_getStorageAt', 'eth_call']);
const SOLANA = new Set(['getAccountInfo', 'getMultipleAccounts']);

// The Alchemy endpoint host per chain (chains.js chain IDs). A chain absent
// here is not read; a chain here is read only once its capability probe says
// so (networks.json).
const HOSTS = Object.freeze({
  1: 'eth-mainnet',
  8453: 'base-mainnet',
  137: 'polygon-mainnet',
  42161: 'arb-mainnet',
  10: 'opt-mainnet',
  solana: 'solana-mainnet',
});
const KEY_SHAPE = /^[A-Za-z0-9_-]{8,128}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const MAX_BODY_CHARS = 8 * 1024 * 1024;
const RATE_LIMIT_MIN_MS = 60000;
const RATE_LIMIT_CEILING_MS = 6 * 3600000;
const QUOTA_MS = 24 * 3600000;
const KEY_REFUSED_MS = 6 * 3600000;

const isoOf = (ms) => new Date(ms).toISOString();

// Refused before anything is built: a method that is not a read.
function assertReadMethod(method) {
  if (!READ_METHODS.has(method)) throw new OpError('REFUSED', `${String(method).slice(0, 60)} is not a read method the desk sends; nothing was built or sent.`);
}

// The EIP-1898 block parameter of a pinned read.
function pin(hash) {
  if (!HASH.test(String(hash || ''))) throw new OpError('INVALID', 'A pinned read needs a 32-byte block hash.');
  return { blockHash: hash, requireCanonical: true };
}

// A request's params with the pin appended, refused when they already carry a
// block of their own.
function pinnedParams(method, params, hash) {
  const p = Array.isArray(params) ? params.slice() : [];
  const want = method === 'eth_getStorageAt' ? 2 : 1;
  if (p.length !== want) throw new OpError('INVALID', `${method} is pinned by the session; it takes no block of its own.`);
  return [...p, pin(hash)];
}

// ---------------------------------------------------------------------------
// The desk-wide state: compute units, gate. No key, no URL, no address.

function emptyState() {
  return { schema_version: 'cr.contract-rpc-state.v1', calls: null, retry_after_until: null, quota_until: null, key_refused_until: null };
}

function readState(ws) {
  try {
    const s = readJson(ws.abs(STATE_REL), null);
    return s && typeof s === 'object' ? { ...emptyState(), ...s } : emptyState();
  } catch (_) {
    return { ...emptyState(), unreadable: true };
  }
}

function updateState(ws, fn) {
  return withLock(ws, 'contract_rpc_state', () => {
    const next = { ...fn(readState(ws)), schema_version: 'cr.contract-rpc-state.v1' };
    replaceFile(ws, ws.abs(STATE_REL), jsonText(next));
    return next;
  });
}

function countsOf(state, now) {
  const day = ymdInTz(new Date(now));
  const month = day.slice(0, 7);
  const c = state.calls && state.calls.month === month ? { ...state.calls } : { month, month_cu: 0, month_count: 0, day, day_cu: 0, day_count: 0 };
  if (c.day !== day) Object.assign(c, { day, day_cu: 0, day_count: 0 });
  return c;
}

// Eric's caps, or why there are none. A cap must be a positive whole number.
function capsOf(ws) {
  const c = (ws.settings && ws.settings.contracts) || {};
  const ok = (v) => Number.isInteger(v) && v > 0;
  if (!ok(c.daily_cu_cap) || !ok(c.monthly_cu_cap)) return { set: false, why: 'Your contract compute-unit caps (contracts.daily_cu_cap and contracts.monthly_cu_cap) are not set, so the desk asks the chain nothing.' };
  return { set: true, daily: c.daily_cu_cap, monthly: c.monthly_cu_cap };
}

// Reserves one request's compute units on disk before it is sent. False, with
// nothing counted, when a cap would be passed or the caps are unset.
function reserveCu(ws, cu, now) {
  const caps = capsOf(ws);
  if (!caps.set) return false;
  let ok = false;
  updateState(ws, (s) => {
    const c = countsOf(s, now);
    if (c.day_cu + cu > caps.daily || c.month_cu + cu > caps.monthly) return s;
    ok = true;
    return { ...s, calls: { ...c, day_cu: c.day_cu + cu, month_cu: c.month_cu + cu, day_count: c.day_count + 1, month_count: c.month_count + 1 } };
  });
  return ok;
}

// Closed while Alchemy asked the desk to wait, said the plan is used up, or
// refused the key.
function gateOf(state, now) {
  for (const [field, why] of [['retry_after_until', 'Alchemy asked the desk to wait (rate limit)'], ['quota_until', 'Alchemy says the plan\'s capacity is used up'], ['key_refused_until', 'Alchemy refused the key']]) {
    const until = state[field] ? Date.parse(state[field]) : 0;
    if (until > now) return { open: false, until: state[field], why, rate_limited: field === 'retry_after_until' };
  }
  return { open: true };
}

// ---------------------------------------------------------------------------
// The network capability record (contracts probe), Eric's to run.

function readNetworks(ws) {
  try {
    const n = readJson(ws.abs(NETWORKS_REL), null);
    return n && typeof n === 'object' && n.networks && typeof n.networks === 'object' ? n : { schema_version: 'cr.contract-networks.v1', networks: {} };
  } catch (_) {
    return { schema_version: 'cr.contract-networks.v1', networks: {}, unreadable: true };
  }
}

// What the desk may read on a chain, or why not. Pure over the stored record.
function networkSupport(ws, chainId) {
  const id = String(chainId);
  if (!Object.prototype.hasOwnProperty.call(HOSTS, id)) return { supported: false, reason: 'network_not_supported', words: `Chain ${id} has no read route in this release.` };
  const rec = readNetworks(ws).networks[id];
  if (!rec) return { supported: false, reason: 'network_not_probed', words: `Chain ${id} has not been probed (contracts probe ${id}).` };
  if (id === 'solana') return rec.finalized ? { supported: true, record: rec } : { supported: false, reason: 'network_not_supported', words: 'The Solana probe found no finalized commitment.', record: rec };
  if (!rec.finalized || !rec.eip1898) return { supported: false, reason: 'network_not_supported', words: `Chain ${id} does not answer ${!rec.finalized ? 'the finalized tag' : 'reads pinned by block hash (EIP-1898)'}.`, record: rec };
  return { supported: true, record: rec };
}

function supportedNetworks(ws) {
  return Object.keys(HOSTS).filter((id) => networkSupport(ws, id).supported);
}

// ---------------------------------------------------------------------------
// The transport

function endpoint(chainId, key) {
  const host = HOSTS[String(chainId)];
  if (!host) throw new OpError('REFUSED', `No read route for chain ${chainId}.`);
  if (!KEY_SHAPE.test(String(key || ''))) throw new OpError('KEY', 'The Alchemy key does not have the expected shape.');
  const url = new URL(`https://${host}.g.alchemy.com/v2/${key}`);
  if (url.hostname !== `${host}.g.alchemy.com`) throw new OpError('REFUSED', 'Unexpected Alchemy host.');
  return url.toString();
}

const scrub = (text, key) => require('./alchemy').scrub(text, key);

// The run stops: nothing more is sent in this session.
class Stop extends Error {
  constructor(kind, words, extra = {}) {
    super(words);
    this.kind = kind;
    Object.assign(this, extra);
  }
}

let rpcId = 0;

// One session: one chain, one provider, one pinned block. `fetchImpl` is the
// transport (tests pass a fictional node). In a dry run nothing is reserved or
// sent: each request is added to `plan`.
function openSession(ws, { chainId, fetchImpl = null, key = undefined, now = Date.now, dryRun = false, timeoutMs = null } = {}) {
  const id = String(chainId);
  const clock = typeof now === 'function' ? now : () => now;
  const cfg = (ws.settings && ws.settings.contracts) || {};
  const tmo = timeoutMs || (Number(cfg.timeout_seconds) || 20) * 1000;
  const k = key === undefined ? require('./alchemy').apiKey() : key;
  const session = { chain_id: id, dry_run: dryRun, plan: [], requests: 0, cu: 0, pinned: null };
  if (!dryRun) {
    let held = null;
    try { held = require('./research').restoredHold(ws); } catch (_) { held = null; }
    if (held) throw new Stop('held', 'This is a restored copy: the desk asks the chain nothing until it is released.');
    const caps = capsOf(ws);
    if (!caps.set) throw new Stop('caps_unset', caps.why);
    const g = gateOf(readState(ws), clock());
    if (!g.open) throw new Stop(g.rate_limited ? 'rate_limited' : 'gate_closed', `${g.why}; next try after ${g.until}.`, { until: g.until });
    if (!k) throw new Stop('no_key', 'No Alchemy key is set (ALCHEMY_API_KEY).');
    if (typeof fetchImpl !== 'function') fetchImpl = globalThis.fetch;
  }

  async function send(method, params) {
    const cu = CU[method];
    if (dryRun) {
      session.plan.push({ method, cu });
      session.cu += cu;
      return { kind: 'planned' };
    }
    if (!reserveCu(ws, cu, clock())) throw new Stop('budget', `The contract compute-unit budget would be passed by ${method} (${cu} CU); nothing more is sent.`);
    session.requests++;
    session.cu += cu;
    let res;
    let text;
    try {
      res = await fetchImpl(endpoint(id, k), { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'CryptoResearch-desk' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), signal: AbortSignal.timeout(tmo) });
      if (res.status === 429) {
        const wait = Math.min(RATE_LIMIT_CEILING_MS, Math.max(RATE_LIMIT_MIN_MS, require('./market').retryAfterMs(res) || 0));
        updateState(ws, (s) => ({ ...s, retry_after_until: isoOf(clock() + wait) }));
        throw new Stop('rate_limited', `Alchemy rate-limited ${method}; the desk waits until ${isoOf(clock() + wait)}.`);
      }
      text = await res.text();
    } catch (err) {
      if (err instanceof Stop) throw err;
      if (err instanceof OpError) throw new Stop('refused', err.message);
      throw new Stop('failed', `${method}: ${err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'no answer in time' : 'the request failed (network)'}.`);
    }
    if (res.status === 401 || res.status === 403) {
      updateState(ws, (s) => ({ ...s, key_refused_until: isoOf(clock() + KEY_REFUSED_MS) }));
      throw new Stop('key_refused', `Alchemy refused the key (HTTP ${res.status}).`);
    }
    let body = null;
    try { body = typeof text === 'string' && text.length <= MAX_BODY_CHARS ? JSON.parse(text) : null; } catch (_) { body = null; }
    if (!body || typeof body !== 'object') throw new Stop('failed', `${method}: the answer was not JSON-RPC (HTTP ${res.status}).`);
    if (body.error) {
      const code = Number(body.error.code);
      const msg = scrub(typeof body.error.message === 'string' ? body.error.message : '', k).slice(0, 160);
      if (code === 429 || /rate limit|too many requests|compute units per second/i.test(msg)) {
        updateState(ws, (s) => ({ ...s, retry_after_until: isoOf(clock() + RATE_LIMIT_MIN_MS) }));
        throw new Stop('rate_limited', `Alchemy rate-limited ${method}.`);
      }
      if (/capacity|monthly limit|exceeded .*limit|upgrade your plan/i.test(msg)) {
        updateState(ws, (s) => ({ ...s, quota_until: isoOf(clock() + QUOTA_MS) }));
        throw new Stop('quota', `Alchemy says the plan's capacity is used up (${msg}).`);
      }
      if (/canonical|unknown block|header not found|block not found/i.test(msg) && PINNED.has(method)) throw new Stop('reorg', `${method}: the pinned block is no longer canonical (${msg}).`);
      return { ok: false, code: Number.isFinite(code) ? code : null, reverted: /revert/i.test(msg) || code === 3, error: `${method}: ${msg || `error ${code}`}` };
    }
    if (!('result' in body)) throw new Stop('failed', `${method}: the answer had no result.`);
    return { ok: true, result: body.result };
  }

  // A read. Pinned methods take the session's block; { latest: true } is the
  // labeled comparison read and is allowed for eth_getStorageAt and eth_call only.
  // { overrides } is a probe: eth_call at the pinned block with replaced code
  // at the named addresses (code only: no balance, nonce or storage), never
  // at latest. It changes nothing on chain; the node simulates it.
  session.call = async (method, params = [], { latest = false, overrides = null } = {}) => {
    assertReadMethod(method);
    let p = Array.isArray(params) ? params : [];
    if (overrides !== null) {
      if (method !== 'eth_call' || latest) throw new OpError('INVALID', 'A state override is an eth_call at the pinned block only.');
      const ok = overrides && typeof overrides === 'object' && Object.entries(overrides).every(([a, v]) => /^0x[0-9a-f]{40}$/.test(a) && v && Object.keys(v).length === 1 && typeof v.code === 'string' && /^0x[0-9a-f]*$/.test(v.code));
      if (!ok) throw new OpError('INVALID', 'A state override replaces code only, at lowercase addresses.');
    }
    if (PINNED.has(method)) {
      if (latest) {
        if (method === 'eth_getCode') throw new OpError('INVALID', 'Code is read at the pinned block only.');
        p = [...p, 'latest'];
      } else {
        if (!session.pinned) throw new OpError('INVALID', `${method} before the block is pinned.`);
        p = pinnedParams(method, p, session.pinned);
        if (overrides !== null) p = [...p, overrides];
      }
    }
    if (SOLANA.has(method)) {
      const opts = p[p.length - 1] && typeof p[p.length - 1] === 'object' ? p[p.length - 1] : null;
      if (!opts || opts.commitment !== 'finalized') throw new OpError('INVALID', `${method} is read at the finalized commitment only.`);
    }
    return send(method, p);
  };
  session.pinTo = (hash) => { pin(hash); session.pinned = hash; };
  return session;
}

module.exports = { VERSION, CU, READ_METHODS, PINNED, HOSTS, STATE_REL, NETWORKS_REL, Stop, assertReadMethod, pin, pinnedParams, openSession, readState, gateOf, capsOf, readNetworks, networkSupport, supportedNetworks };
