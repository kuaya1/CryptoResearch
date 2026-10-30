'use strict';
// Contract state observations (Pillar 1, cr-contract-observation@1): what a
// token contract is at one finalized block, read from the chain itself and
// kept create-only beside the project. It extends GoPlus; it never replaces a
// vendor flag, and it never calls anything safe.
//
// One observation = one chain, one provider, one block (contract-rpc.js pins
// every state read to the finalized block's hash, EIP-1898). It records:
//   - the token's code (Keccak-256, stored once under its hash), an EIP-7702
//     delegation designator (0xef0100…) or empty code;
//   - the proxy: ERC-1967 implementation/admin/beacon, EIP-1822, the legacy
//     OpenZeppelin slot, EIP-1167 clones; a diamond or an unrecognized
//     DELEGATECALL is unsupported, never assumed harmless;
//   - the surface: Sourcify's verified ABI when its runtime code matches, else
//     the PUSH4 immediates of the code (an over-approximation, labeled);
//   - capability classes C1–C7 and, for each, its controllers resolved to a
//     class K1–K6 by state reads at the same block (Safe threshold, owners,
//     modules and guard; timelock delay; AccessControl members with the
//     DEFAULT_ADMIN_ROLE edges followed; EOAs and EIP-7702 accounts);
//   - totalSupply against the previous observation and the mint/burn
//     Transfer events between them;
//   - the ERC-1967 slots read again at "latest", to say when the state is
//     changing (latest_slots_match: false);
//   - what could not be read, by name. Unknown is never zero.
// Solana mints are read at the finalized commitment (mint and freeze
// authorities, Token-2022 extensions, the hook program's upgrade authority).
//
// The authority and effect probes (state-override eth_call) come in PR B:
// until then every authority rests on state reads, and coverage says so.
// Records: projects/<id>/forensics/contracts/ (observations/, code/,
// status.json), backed up and exported with the project. Reading them
// (view, contracts show, the Contract tab) writes nothing and asks nothing.

const crypto = require('crypto');
const fs = require('fs');
const { withLock, replaceFile, OpError } = require('./ops');
const { readJson, jsonText, readText } = require('./fsx');
const K = require('./keccak');
const rpc = require('./contract-rpc');

const VERSION = 'cr-contract-observation@1';
const SCHEMA = 'cr.contract-observation.v1';
const STATUS_SCHEMA = 'cr.contract-status.v1';
const IDENTITY_VERSION = 'cr-contract-identity@1';
const JSON_VERSION = 'cr-forensic-json@1';
const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';
const ZERO_WORD = `0x${'0'.repeat(64)}`;

// ---------------------------------------------------------------------------
// Definitions: every slot, selector and topic is derived here from its
// preimage by keccak.js (tests compare them with the published values).

const SLOTS = Object.freeze({
  implementation: K.slotMinusOne('eip1967.proxy.implementation'),
  admin: K.slotMinusOne('eip1967.proxy.admin'),
  beacon: K.slotMinusOne('eip1967.proxy.beacon'),
  eip1822: K.keccak256('PROXIABLE'),
  oz_legacy: K.keccak256('org.zeppelinos.proxy.implementation'),
  // Safe: the singleton is storage slot 0; the guard and fallback handler
  // live at these hashed slots (Safe's GuardManager, FallbackManager).
  safe_singleton: ZERO_WORD,
  safe_guard: K.keccak256('guard_manager.guard.address'),
});

const READS = Object.freeze(Object.fromEntries([
  'owner()', 'totalSupply()', 'decimals()', 'name()', 'symbol()', 'implementation()',
  'getThreshold()', 'getOwners()', 'getModulesPaginated(address,uint256)', 'getMinDelay()', 'delay()', 'admin()',
  'hasRole(bytes32,address)', 'getRoleAdmin(bytes32)', 'getRoleMemberCount(bytes32)', 'getRoleMember(bytes32,uint256)', 'facets()',
].map((s) => [s, K.selector(s)])));

const TOPICS = Object.freeze({
  Transfer: K.topic('Transfer(address,address,uint256)'),
  Upgraded: K.topic('Upgraded(address)'),
  AdminChanged: K.topic('AdminChanged(address,address)'),
  BeaconUpgraded: K.topic('BeaconUpgraded(address)'),
  RoleGranted: K.topic('RoleGranted(bytes32,address,address)'),
});

const ROLES = Object.freeze({
  DEFAULT_ADMIN_ROLE: ZERO_WORD,
  MINTER_ROLE: K.keccak256('MINTER_ROLE'),
  PAUSER_ROLE: K.keccak256('PAUSER_ROLE'),
  UPGRADER_ROLE: K.keccak256('UPGRADER_ROLE'),
});
// The role that conventionally guards a capability (OpenZeppelin's names).
const ROLE_FOR = Object.freeze({ C1: 'UPGRADER_ROLE', C2: 'MINTER_ROLE', C4: 'PAUSER_ROLE' });

// Capability classes. Signatures are canonical text; selectors computed.
const CAPABILITIES = Object.freeze({
  C1: 'Upgrade the logic',
  C2: 'Mint supply',
  C3: 'Move or destroy others\' balances',
  C4: 'Restrict transfers',
  C5: 'Change fees or taxes',
  C6: 'Change a transfer hook',
  C7: 'Self-destruct or change code',
});
const SIGNATURES = Object.freeze({
  C1: ['upgradeTo(address)', 'upgradeToAndCall(address,bytes)', 'changeAdmin(address)', 'upgradeAndCall(address,address,bytes)'],
  C2: ['mint(address,uint256)', 'mint(uint256)', 'mintTo(address,uint256)', 'issue(uint256)'],
  C3: ['burn(address,uint256)', 'setBalance(address,uint256)', 'forceTransfer(address,address,uint256)', 'adminTransfer(address,address,uint256)'],
  C4: ['pause()', 'unpause()', 'blacklist(address)', 'addToBlacklist(address)', 'setBlacklist(address,bool)', 'freeze(address)', 'setTradingEnabled(bool)', 'enableTrading()', 'setMaxTxAmount(uint256)', 'setMaxWalletSize(uint256)'],
  C5: ['setFee(uint256)', 'setFees(uint256,uint256)', 'setTaxFee(uint256)', 'setSellTax(uint256)', 'setBuyTax(uint256)', 'setSellFee(uint256)', 'setBuyFee(uint256)', 'excludeFromFee(address)'],
  C6: ['setTransferHook(address)', 'setHook(address)'],
});
// A verified ABI's function names read the same way.
const NAME_RULES = [
  ['C1', /^(upgrade|changeadmin)/i],
  ['C2', /^(mint|issue)/i],
  ['C3', /^(setbalance|forcetransfer|admintransfer|seize|wipe)/i],
  ['C4', /(blacklist|blocklist|freeze|^pause|^unpause|tradingenabled|enabletrading|maxtx|maxwallet)/i],
  ['C5', /^(set.*(fee|tax)|excludefromfee|includeinfee)/i],
  ['C6', /hook/i],
];
const DIAMOND = ['facets()', 'diamondCut((address,uint8,bytes4[])[],address,bytes)'];
// Mutating functions that are neither a capability nor unclassified.
const STANDARD = new Set(['transfer(address,uint256)', 'transferFrom(address,address,uint256)', 'approve(address,uint256)', 'increaseAllowance(address,uint256)', 'decreaseAllowance(address,uint256)',
  'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)', 'burn(uint256)', 'burnFrom(address,uint256)', 'renounceOwnership()', 'transferOwnership(address)', 'acceptOwnership()',
  'grantRole(bytes32,address)', 'revokeRole(bytes32,address)', 'renounceRole(bytes32,address)', 'delegate(address)', 'delegateBySig(address,uint256,uint256,uint8,bytes32,bytes32)', 'multicall(bytes[])']);

const SELECTOR_CAP = new Map();
for (const [cap, sigs] of Object.entries(SIGNATURES)) for (const s of sigs) SELECTOR_CAP.set(K.selector(s), { capability: cap, signature: s });
const DIAMOND_SELECTORS = new Set(DIAMOND.map(K.selector));

const CLASS_WORDS = Object.freeze({
  K1: 'renounced',
  K2: 'timelock at or above your minimum',
  K3: 'multisig (Safe, threshold 2 or more, no modules, no guard)',
  K4: 'weak constraint (treated as unconstrained)',
  K5: 'unconstrained (one key)',
  K6: 'unknown',
});
// Worst first, for a capability with several controllers.
const CLASS_RANK = Object.freeze({ K5: 6, K4: 5, K6: 4, K3: 3, K2: 2, K1: 1 });
const worst = (classes) => classes.reduce((a, b) => (CLASS_RANK[b] > CLASS_RANK[a] ? b : a), 'K1');

// Solana programs (published program IDs).
const SOL = Object.freeze({
  SPL: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  TOKEN_2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  SYSTEM: '11111111111111111111111111111111',
  UPGRADEABLE_LOADER: 'BPFLoaderUpgradeab1e11111111111111111111111',
});

// ---------------------------------------------------------------------------
// Canonical JSON (cr-forensic-json@1): keys sorted at every level, no
// whitespace, so a hash names the content, not the order it was written in.

const { canonicalJson } = require('./contract-gate');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// ---------------------------------------------------------------------------
// ABI words (only what the reads need)

const strip0x = (h) => String(h || '').replace(/^0x/i, '').toLowerCase();
const word = (hex) => strip0x(hex).padStart(64, '0');
const encAddress = (a) => word(a);
const encUint = (n) => BigInt(n).toString(16).padStart(64, '0');
const callData = (sig, ...words) => `${READS[sig] || K.selector(sig)}${words.join('')}`;

function wordAt(hex, i) {
  const h = strip0x(hex);
  const w = h.slice(i * 64, i * 64 + 64);
  return w.length === 64 ? w : null;
}
// An address from a 32-byte word, only with valid padding.
function decAddress(hex, i = 0) {
  const w = wordAt(hex, i);
  if (!w || !/^0{24}/.test(w)) return null;
  return `0x${w.slice(24)}`;
}
function decUint(hex, i = 0) {
  const w = wordAt(hex, i);
  return w === null ? null : BigInt(`0x${w}`);
}
function decAddressArray(hex, headIndex = 0) {
  const off = decUint(hex, headIndex);
  if (off === null || off % 32n !== 0n) return null;
  const at = Number(off / 32n);
  const n = decUint(hex, at);
  if (n === null || n > 1000n) return null;
  const out = [];
  for (let i = 0; i < Number(n); i++) {
    const a = decAddress(hex, at + 1 + i);
    if (!a) return null;
    out.push(a);
  }
  return out;
}
// A string return, or a bytes32 one (older tokens). Cleaned and capped.
function decString(hex) {
  const h = strip0x(hex);
  if (h.length === 64) return Buffer.from(h, 'hex').toString('utf8').replace(/\0+$/, '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮]/g, '').slice(0, 80) || null;
  const off = decUint(h, 0);
  if (off === null || off % 32n !== 0n) return null;
  const len = decUint(h, Number(off / 32n));
  if (len === null || len > 256n) return null;
  const start = (Number(off / 32n) + 1) * 64;
  const bytes = Buffer.from(h.slice(start, start + Number(len) * 2), 'hex');
  return bytes.toString('utf8').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮]/g, '').slice(0, 80) || null;
}

// ---------------------------------------------------------------------------
// Bytecode: kinds, the opcode scan, clones

const EIP7702 = /^ef0100([0-9a-f]{40})$/;
const EIP1167 = /^363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/;

function codeKind(hex) {
  const h = strip0x(hex);
  if (!h) return 'empty';
  if (EIP7702.test(h)) return 'eip7702_delegated';
  return 'contract';
}

// The Solidity metadata trailer: its CBOR length in the last two bytes.
function withoutMetadata(bytes) {
  if (bytes.length < 2) return bytes;
  const len = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
  const start = bytes.length - 2 - len;
  if (len > 0 && start >= 0 && bytes[start] >= 0xa1 && bytes[start] <= 0xa5) return bytes.subarray(0, start);
  return bytes;
}

// Opcodes found outside PUSH immediates and the metadata trailer, and the
// PUSH4 immediates (candidate selectors).
function scanCode(hex) {
  const bytes = withoutMetadata(Buffer.from(strip0x(hex), 'hex'));
  const out = { delegatecall: false, selfdestruct: false, push4: new Set() };
  for (let i = 0; i < bytes.length; i++) {
    const op = bytes[i];
    if (op === 0xf4) out.delegatecall = true;
    else if (op === 0xff) out.selfdestruct = true;
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      if (op === 0x63 && i + 4 < bytes.length) out.push4.add(`0x${bytes.subarray(i + 1, i + 5).toString('hex')}`);
      i += n;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sourcify (keyless, through the network guard). The ABI is used only when the
// runtime code Sourcify verified hashes to the code observed.

async function sourcifyGet(chainId, address, { safeGet = require('./netguard').safeGet } = {}) {
  const url = `https://sourcify.dev/server/v2/contract/${encodeURIComponent(chainId)}/${encodeURIComponent(address)}?fields=abi,compilation,runtimeBytecode`;
  const r = await safeGet(url, { timeoutMs: 15000, maxBytes: 4 * 1024 * 1024 });
  if (!r.ok) return { status: 'unknown', words: `Sourcify did not answer (${r.error_class || 'error'}).` };
  if (r.status === 404) return { status: 'unverified' };
  if (r.status !== 200) return { status: 'unknown', words: `Sourcify answered HTTP ${r.status}.` };
  let j = null;
  try { j = JSON.parse(r.body.toString('utf8')); } catch (_) { return { status: 'unknown', words: 'Sourcify\'s answer did not read.' }; }
  const match = j.runtimeMatch || j.match || null;
  const onchain = j.runtimeBytecode && (j.runtimeBytecode.onchainBytecode || j.runtimeBytecode.onChainBytecode);
  return {
    status: match === 'exact_match' ? 'verified_full' : match === 'match' ? 'verified_partial' : 'unverified',
    abi: Array.isArray(j.abi) ? j.abi : null,
    contract_name: j.compilation && typeof j.compilation.name === 'string' ? j.compilation.name.slice(0, 80) : null,
    compiler: j.compilation && typeof j.compilation.compilerVersion === 'string' ? j.compilation.compilerVersion.slice(0, 80) : null,
    runtime_code_hash: typeof onchain === 'string' && /^0x[0-9a-f]*$/i.test(onchain) ? K.keccak256Hex(onchain) : null,
  };
}

function signatureOf(fn) {
  const t = (p) => (p.type && p.type.startsWith('tuple') ? `(${(p.components || []).map(t).join(',')})${p.type.slice(5)}` : p.type);
  return `${fn.name}(${(fn.inputs || []).map(t).join(',')})`;
}

// The capability surface from a verified ABI, else from the code's PUSH4s.
function surfaceOf({ abi, codeHex }) {
  const functions = [];
  const unclassified = [];
  if (Array.isArray(abi)) {
    for (const f of abi) {
      if (!f || f.type !== 'function' || typeof f.name !== 'string') continue;
      const sig = signatureOf(f);
      const sel = K.selector(sig);
      const mutating = f.stateMutability ? !['view', 'pure'].includes(f.stateMutability) : !f.constant;
      const bySel = SELECTOR_CAP.get(sel);
      const byName = !bySel && mutating ? (NAME_RULES.find(([, re]) => re.test(f.name)) || [])[0] : null;
      const cap = bySel ? bySel.capability : byName;
      if (cap) functions.push({ selector: sel, signature: sig, capability: cap });
      else if (mutating && !STANDARD.has(sig)) unclassified.push({ selector: sel, signature: sig });
    }
    return { basis: 'abi', functions: sortBy(functions, 'selector'), unclassified_mutators: sortBy(unclassified, 'selector'), diamond: functions.concat(unclassified).some((f) => DIAMOND_SELECTORS.has(f.selector)) || abi.some((f) => f && f.type === 'function' && DIAMOND_SELECTORS.has(K.selector(signatureOf(f)))) };
  }
  if (!codeHex) return { basis: 'none', functions: [], unclassified_mutators: [], diamond: false };
  const scan = scanCode(codeHex);
  for (const sel of scan.push4) {
    const hit = SELECTOR_CAP.get(sel);
    if (hit) functions.push({ selector: sel, signature: hit.signature, capability: hit.capability });
  }
  return { basis: 'selectors', functions: sortBy(functions, 'selector'), unclassified_mutators: [], diamond: [...scan.push4].some((s) => DIAMOND_SELECTORS.has(s)) };
}

function sortBy(list, key) {
  return list.slice().sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
}

// ---------------------------------------------------------------------------
// One EVM observation

const lower = (a) => (typeof a === 'string' ? a.toLowerCase() : a);
const isZero = (a) => !a || lower(a) === ZERO;

function cfgOf(ws) {
  const c = (ws.settings && ws.settings.contracts) || {};
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    max_authority_depth: num(c.max_authority_depth, 3),
    max_log_blocks: num(c.max_log_blocks, 10000),
    min_timelock_hours: num(c.min_timelock_hours, 48),
    safe_singleton_code_hashes: Array.isArray(c.safe_singleton_code_hashes) ? c.safe_singleton_code_hashes.map(lower).filter((h) => /^0x[0-9a-f]{64}$/.test(h)) : [],
    ttl_hours: num(c.ttl_hours, 24),
    watch_interval_hours: num(c.watch_interval_hours, 6),
    baseline_interval_hours: num(c.baseline_interval_hours, 168),
    max_projects_per_run: num(c.max_projects_per_run, 5),
    backoff_initial_minutes: num(c.backoff_initial_minutes, 30),
    backoff_max_minutes: num(c.backoff_max_minutes, 720),
  };
}

// The reads of one observation, with what failed by name.
function reader(s, ctx) {
  const codeCache = new Map();
  const r = {
    errors: [],
    missing: new Set(),
    fail(read, res, part) {
      r.errors.push({ read, kind: res && res.reverted ? 'reverted' : 'rpc_error', words: (res && res.error) || 'no answer' });
      if (part) r.missing.add(part);
    },
    async code(addr) {
      const a = lower(addr);
      if (codeCache.has(a)) return codeCache.get(a);
      const res = await s.call('eth_getCode', [a]);
      const v = res.ok && typeof res.result === 'string' ? lower(res.result) : null;
      if (v === null) r.fail(`eth_getCode ${a}`, res, 'code');
      const out = v === null ? null : { hex: v, kind: codeKind(v), hash: K.keccak256Hex(v), size: strip0x(v).length / 2 };
      codeCache.set(a, out);
      if (out && out.kind === 'contract') ctx.code.set(out.hash, v);
      return out;
    },
    async slot(addr, slot, part) {
      const res = await s.call('eth_getStorageAt', [lower(addr), slot]);
      if (!res.ok || typeof res.result !== 'string') { r.fail(`eth_getStorageAt ${part}`, res, part); return null; }
      return lower(res.result);
    },
    // An eth_call that may not answer (a function the contract lacks).
    async view(addr, data) {
      const res = await s.call('eth_call', [{ to: lower(addr), data }]);
      return res.ok && typeof res.result === 'string' && res.result !== '0x' ? lower(res.result) : null;
    },
  };
  return r;
}

function slotAddress(w) {
  if (!w) return null;
  const h = word(w);
  if (/^0+$/.test(h)) return null;
  return /^0{24}/.test(h) ? `0x${h.slice(24)}` : 'malformed';
}

async function sourceFor(chainId, address, codeHash, sourceImpl) {
  let src;
  try { src = await sourceImpl(chainId, address); } catch (err) { src = { status: 'unknown', words: `Sourcify: ${String(err && err.message || err).slice(0, 80)}` }; }
  if (!src || typeof src !== 'object') src = { status: 'unknown' };
  const matches = src.runtime_code_hash ? src.runtime_code_hash === codeHash : null;
  const usable = (src.status === 'verified_full' || src.status === 'verified_partial') && matches === true && Array.isArray(src.abi);
  return {
    status: usable ? src.status : src.status === 'unverified' ? 'unverified' : (src.status === 'verified_full' || src.status === 'verified_partial') ? 'unverified' : 'unknown',
    provider: 'sourcify',
    contract_name: usable ? src.contract_name || null : null,
    compiler: usable ? src.compiler || null : null,
    abi_sha256: usable ? sha256(canonicalJson(src.abi)) : null,
    verified_code_hash_matches: matches,
    abi: usable ? src.abi : null,
    words: usable ? null : matches === false ? 'Sourcify\'s verified code is not the code observed: its ABI is not used.' : src.words || null,
  };
}

// A controller resolved to its class at the pinned block.
async function resolveController(rd, addr, depth, ctx) {
  const a = lower(addr);
  if (!a || a === 'malformed') return { class: 'K6', path: [{ address: null, node: 'unreadable' }], words: 'The controller address did not read.' };
  if (a === ZERO || a === DEAD) return { class: 'K1', path: [{ address: a, node: 'renounced' }], words: 'Renounced (zero or dead address); no other path was proven absent.' };
  if (depth > ctx.cfg.max_authority_depth) return { class: 'K6', path: [{ address: a, node: 'depth_cap' }], words: `The controller chain is deeper than ${ctx.cfg.max_authority_depth}.` };
  const code = await rd.code(a);
  if (!code) return { class: 'K6', path: [{ address: a, node: 'unreadable' }], words: 'The controller\'s code did not read.' };
  if (code.kind === 'empty') return { class: 'K5', path: [{ address: a, node: 'eoa' }], words: 'An externally owned account: one key.' };
  if (code.kind === 'eip7702_delegated') return { class: 'K5', path: [{ address: a, node: 'eip7702_delegated', delegate: `0x${strip0x(code.hex).slice(6)}` }], words: 'An account with EIP-7702 delegated code: still controlled by its key.' };
  // A Safe: threshold, owners, modules, guard, singleton.
  const thr = await rd.view(a, callData('getThreshold()'));
  if (thr !== null) {
    const threshold = Number(decUint(thr));
    const ownersHex = await rd.view(a, callData('getOwners()'));
    const owners = ownersHex ? decAddressArray(ownersHex) : null;
    const modsHex = await rd.view(a, callData('getModulesPaginated(address,uint256)', encAddress('0x0000000000000000000000000000000000000001'), encUint(10)));
    const modules = modsHex ? decAddressArray(modsHex) : null;
    const singleton = slotAddress(await rd.slot(a, SLOTS.safe_singleton, 'safe_singleton'));
    const guard = slotAddress(await rd.slot(a, SLOTS.safe_guard, 'safe_guard'));
    const sc = singleton && singleton !== 'malformed' ? await rd.code(singleton) : null;
    const node = { address: a, node: 'safe', threshold, owners: owners ? owners.length : null, owners_sha256: owners ? sha256(owners.map(lower).sort().join(',')) : null, modules: modules ? modules.length : null, guard: guard || null, singleton: singleton || null, singleton_code_hash: sc ? sc.hash : null };
    if (owners === null || modules === null) return { class: 'K6', path: [node], words: 'A Safe whose owners or modules did not read.' };
    if (modules.length) return { class: 'K6', path: [node], words: `A Safe with ${modules.length} module${modules.length === 1 ? '' : 's'}: a module can act without the owners' signatures.` };
    if (guard && guard !== 'malformed') return { class: 'K6', path: [node], words: 'A Safe with a guard set: its effect is not read.' };
    if (!sc || !ctx.cfg.safe_singleton_code_hashes.includes(sc.hash)) return { class: 'K6', path: [node], words: 'A Safe whose singleton code is not on your allowlist (contracts.safe_singleton_code_hashes).' };
    if (!(threshold >= 2)) return { class: 'K4', path: [node], words: `A Safe needing ${threshold} of ${owners.length}: one key can act.` };
    return { class: 'K3', path: [node], words: `A Safe needing ${threshold} of ${owners.length}, no modules, no guard.` };
  }
  // A timelock: OpenZeppelin's (getMinDelay) or Compound's (delay, admin),
  // recognized only by its verified source.
  const minDelay = await rd.view(a, callData('getMinDelay()'));
  const compound = minDelay === null ? await rd.view(a, callData('delay()')) : null;
  if (minDelay !== null || compound !== null) {
    const src = await sourceFor(ctx.chain_id, a, code.hash, ctx.sourceImpl);
    const secs = decUint(minDelay !== null ? minDelay : compound);
    const hours = secs === null ? null : Number(secs) / 3600;
    const named = src.contract_name && (minDelay !== null ? src.contract_name === 'TimelockController' : /timelock/i.test(src.contract_name));
    const node = { address: a, node: minDelay !== null ? 'oz_timelock' : 'compound_timelock', delay_hours: hours, source: src.status, contract_name: src.contract_name };
    if (!named) return { class: 'K6', path: [node], delay_hours: hours, words: 'A timelock-like contract without verified source naming it: not recognized.' };
    if (hours === null) return { class: 'K6', path: [node], words: 'The timelock\'s delay did not read.' };
    if (hours < ctx.cfg.min_timelock_hours) return { class: 'K4', path: [node], delay_hours: hours, words: `A timelock of ${hours} hours, under your ${ctx.cfg.min_timelock_hours}-hour minimum.` };
    return { class: 'K2', path: [node], delay_hours: hours, words: `A timelock of ${hours} hours (the delay read; proposer paths are not yet followed).` };
  }
  // A verified ProxyAdmin: followed to its owner.
  const ownerHex = await rd.view(a, callData('owner()'));
  if (ownerHex !== null) {
    const src = await sourceFor(ctx.chain_id, a, code.hash, ctx.sourceImpl);
    const node = { address: a, node: 'ownable_contract', source: src.status, contract_name: src.contract_name };
    if (src.contract_name === 'ProxyAdmin') {
      const next = await resolveController(rd, decAddress(ownerHex), depth + 1, ctx);
      return { ...next, path: [{ ...node, node: 'proxy_admin' }, ...next.path] };
    }
    return { class: 'K6', path: [node], words: 'A contract with an owner, not a recognized controller: its other paths are not read.' };
  }
  return { class: 'K6', path: [{ address: a, node: 'contract' }], words: 'An unrecognized contract.' };
}

// The members of a role and the roles that administer it, at the block.
async function roleControllers(rd, token, roleName, depth, ctx, seen = new Set()) {
  const role = ROLES[roleName] || roleName;
  if (seen.has(role) || seen.size > ctx.cfg.max_authority_depth) return { classes: ['K6'], path: [{ address: null, node: 'role', role, words: 'Role-admin chain too deep or cyclic.' }], words: ['Role-admin chain too deep or cyclic.'] };
  seen.add(role);
  const countHex = await rd.view(token, callData('getRoleMemberCount(bytes32)', word(role)));
  if (countHex === null) return { classes: ['K6'], path: [{ address: null, node: 'role', role, enumeration: 'none' }], words: [`${roleName} members could not be enumerated.`], enumeration: 'none' };
  const n = Number(decUint(countHex));
  const out = { classes: [], path: [], words: [], enumeration: 'enumerable' };
  for (let i = 0; i < Math.min(n, 20); i++) {
    const m = decAddress(await rd.view(token, callData('getRoleMember(bytes32,uint256)', word(role), encUint(i))));
    const c = await resolveController(rd, m, depth + 1, ctx);
    out.classes.push(c.class);
    out.path.push({ address: m, node: 'role_member', role }, ...c.path);
    out.words.push(`${roleName} member: ${c.words}`);
  }
  if (n > 20) { out.classes.push('K6'); out.words.push(`${roleName} has ${n} members; more than 20 are not followed.`); }
  // The role that can grant this one.
  const adminHex = await rd.view(token, callData('getRoleAdmin(bytes32)', word(role)));
  const adminRole = adminHex ? `0x${word(adminHex)}` : null;
  if (adminRole === null) { out.classes.push('K6'); out.words.push(`${roleName}'s admin role did not read.`); return out; }
  if (adminRole !== role) {
    const name = Object.keys(ROLES).find((k) => ROLES[k] === adminRole) || adminRole;
    const up = await roleControllers(rd, token, name, depth, ctx, seen);
    out.classes.push(...up.classes);
    out.path.push({ address: null, node: 'role_admin', role: adminRole }, ...up.path);
    out.words.push(...up.words.map((w) => `via ${name}: ${w}`));
  }
  if (!out.classes.length) out.classes.push('K1');
  return out;
}

async function observeEvm(session, subject, { ws, sourceImpl, now, prev, market = null }) {
  const net = (rpc.readNetworks(ws).networks || {})[String(subject.chain_id)] || {};
  const ctx = { cfg: cfgOf(ws), chain_id: subject.chain_id, sourceImpl, code: new Map(), factories: factoriesOf(ws, subject.chain_id), overrides: net.state_overrides === true, priceUsd: market ? market.price_usd : null, sizes: market ? market.sizes : [] };
  const started = new Date(now()).toISOString();
  const cid = await session.call('eth_chainId', []);
  if (!cid.ok || BigInt(cid.result) !== BigInt(subject.chain_id)) throw new OpError('INTEGRITY', `The node answered chain ${cid.ok ? BigInt(cid.result).toString() : 'unknown'}, not ${subject.chain_id}; nothing was recorded.`);
  const fin = await session.call('eth_getBlockByNumber', ['finalized', false]);
  if (!fin.ok || !fin.result || !/^0x[0-9a-f]{64}$/.test(lower(fin.result.hash))) throw new rpc.Stop('failed', 'The finalized block did not read.');
  const block = { number: Number(BigInt(fin.result.number)), hash: lower(fin.result.hash), timestamp: new Date(Number(BigInt(fin.result.timestamp)) * 1000).toISOString(), confirmation_policy: 'finalized' };
  if (Date.parse(block.timestamp) > now() + 10 * 60000) throw new OpError('INTEGRITY', 'The finalized block is dated more than 10 minutes ahead of this clock; nothing was recorded.');
  session.pinTo(block.hash);
  const rd = reader(session, ctx);
  const addr = lower(subject.address);

  // The token's code.
  const code = await rd.code(addr);
  const token = { code_kind: code ? code.kind : 'unknown', code_hash: code ? code.hash : null, code_size: code ? code.size : null, decimals: null, total_supply: null, name: null, symbol: null };
  const obs = { block, proxy: null, source: null, surface: null, authorities: [], roles: { enumeration: 'unknown' }, supply: null, transfer_probe: null, effects: [], pools: [], probes_ran: false };
  if (code && code.kind === 'contract') {
    const dec = await rd.view(addr, callData('decimals()'));
    token.decimals = dec === null ? null : Number(decUint(dec));
    const ts = await rd.view(addr, callData('totalSupply()'));
    token.total_supply = ts === null ? null : decUint(ts).toString();
    if (ts === null) rd.missing.add('total_supply');
    const nm = await rd.view(addr, callData('name()'));
    token.name = nm ? decString(nm) : null;
    const sy = await rd.view(addr, callData('symbol()'));
    token.symbol = sy ? decString(sy) : null;

    // The proxy.
    const raw = {};
    for (const k of ['implementation', 'admin', 'beacon', 'eip1822', 'oz_legacy']) raw[k] = slotAddress(await rd.slot(addr, SLOTS[k], `slot_${k}`));
    const scan = scanCode(code.hex);
    const clone = EIP1167.exec(strip0x(code.hex));
    let kind = 'none';
    let implAddr = null;
    let beaconAddr = null;
    const set = Object.keys(raw).filter((k) => raw[k]);
    if (set.some((k) => raw[k] === 'malformed')) kind = 'unknown';
    else if (clone) { kind = 'eip1167_minimal'; implAddr = `0x${clone[1]}`; }
    else if (raw.beacon) {
      kind = set.length === 1 || (set.length === 2 && raw.admin) ? 'erc1967_beacon' : 'unknown';
      beaconAddr = raw.beacon;
      const bi = await rd.view(beaconAddr, callData('implementation()'));
      implAddr = bi ? decAddress(bi) : null;
      if (!implAddr) rd.missing.add('beacon_implementation');
    } else if (raw.implementation) {
      kind = set.every((k) => k === 'implementation' || k === 'admin') ? (raw.admin ? 'erc1967_transparent' : 'erc1967_uups') : 'unknown';
      implAddr = raw.implementation;
    } else if (raw.eip1822 && set.length === 1) { kind = 'eip1822'; implAddr = raw.eip1822; }
    else if (raw.oz_legacy && set.length === 1) { kind = 'oz_legacy'; implAddr = raw.oz_legacy; }
    else if (set.length) kind = 'unknown';
    else if (scan.delegatecall) kind = 'nonstandard_delegatecall';
    if (rd.missing.has('slot_implementation') || rd.missing.has('slot_admin') || rd.missing.has('slot_beacon')) kind = kind === 'none' ? 'unknown' : kind;

    const impl = implAddr ? await rd.code(implAddr) : null;
    const target = impl && impl.kind === 'contract' ? { address: implAddr, code: impl } : { address: addr, code };
    // The surface is the implementation's when there is one.
    const source = await sourceFor(subject.chain_id, target.address, target.code.hash, sourceImpl);
    const surface = surfaceOf({ abi: source.abi, codeHex: target.code.hex });
    if (kind === 'erc1967_uups' && !surface.functions.some((f) => f.capability === 'C1')) kind = source.status === 'unverified' || source.status === 'unknown' ? 'erc1967_uups' : 'erc1967_frozen';
    if (kind === 'none' && surface.diamond) kind = 'diamond';
    const supported = !['diamond', 'nonstandard_delegatecall', 'unknown'].includes(kind) && !(implAddr && (!impl || impl.kind !== 'contract'));
    obs.proxy = {
      kind,
      supported,
      slots: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v || null])),
      implementation: implAddr ? { address: implAddr, code_kind: impl ? impl.kind : 'unknown', code_hash: impl ? impl.hash : null, code_size: impl ? impl.size : null } : null,
      beacon: beaconAddr ? { address: beaconAddr } : null,
      delegatecall_in_token_code: scan.delegatecall,
      selfdestruct_in_code: scanCode(target.code.hex).selfdestruct,
      words: !supported ? (implAddr && (!impl || impl.kind !== 'contract') ? 'The proxy points to an address with no contract code.' : `A ${kind.replace(/_/g, ' ')} proxy is not one the desk reads in this version.`) : null,
    };
    const { abi: _abi, ...sourceRec } = source;
    obs.source = { ...sourceRec, for: target.address === addr ? 'token' : 'implementation' };
    obs.surface = { basis: surface.basis, source: surface.basis === 'abi' ? 'verified' : 'unverified', functions: surface.functions, unclassified_mutators: surface.unclassified_mutators };

    // Capabilities and their controllers.
    const caps = new Set(surface.functions.map((f) => f.capability));
    if (['erc1967_transparent', 'erc1967_beacon', 'erc1967_uups', 'eip1822', 'oz_legacy'].includes(kind)) caps.add('C1');
    if (obs.proxy.selfdestruct_in_code) caps.add('C7');
    const accessControl = await rd.view(addr, callData('getRoleAdmin(bytes32)', ROLES.DEFAULT_ADMIN_ROLE)) !== null;
    const ownerHex = await rd.view(addr, callData('owner()'));
    const owner = ownerHex ? decAddress(ownerHex) : null;
    let ownerRes = null;
    const ownerCtl = async () => {
      if (!ownerRes && owner) {
        const c = await resolveController(rd, owner, 1, ctx);
        ownerRes = { ...c, address: owner, path: [{ address: owner, node: 'owner', via: 'owner()' }, ...c.path] };
      }
      return ownerRes;
    };
    obs.roles = { enumeration: accessControl ? 'pending' : 'none', members: [] };
    for (const cap of ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'].filter((c) => caps.has(c))) {
      const fn = (surface.functions.find((f) => f.capability === cap) || {}).signature || (cap === 'C1' ? `proxy ${kind}` : cap === 'C7' ? 'SELFDESTRUCT in code' : null);
      let res;
      if (cap === 'C7') res = { class: 'K6', path: [], words: 'SELFDESTRUCT appears in the code; who can reach it is not read.' };
      else if (cap === 'C1' && kind === 'erc1967_transparent') {
        const c = await resolveController(rd, raw.admin, 1, ctx);
        res = { ...c, path: [{ address: raw.admin, node: 'erc1967_admin', via: 'erc1967.admin' }, ...c.path] };
      } else if (cap === 'C1' && kind === 'erc1967_beacon') {
        const bo = await rd.view(beaconAddr, callData('owner()'));
        const c = bo ? await resolveController(rd, decAddress(bo), 1, ctx) : { class: 'K6', path: [], words: 'The beacon\'s owner did not read.' };
        res = { ...c, path: [{ address: beaconAddr, node: 'beacon', via: 'erc1967.beacon' }, ...c.path] };
      } else if (accessControl && ROLE_FOR[cap]) {
        const rc = await roleControllers(rd, addr, ROLE_FOR[cap], 0, ctx);
        obs.roles.enumeration = rc.enumeration === 'none' ? 'none' : obs.roles.enumeration === 'none' ? 'none' : 'enumerable';
        res = { class: worst(rc.classes), path: rc.path, words: rc.words.join(' ') || `${ROLE_FOR[cap]} has no member.` };
      } else if (owner) {
        res = await ownerCtl();
      } else res = { class: 'K6', path: [], words: accessControl ? 'Guarded by roles the desk cannot attribute to this function.' : 'No owner or role answered: the guard is not known.' };
      obs.authorities.push({ capability: cap, function: fn, path: res.path, class: res.class, delay_hours: res.delay_hours === undefined ? null : res.delay_hours, proof: 'state_read', random_caller: 'not_tried', coverage: 'partial', words: res.words });
    }
    if (obs.roles.enumeration === 'pending') obs.roles.enumeration = 'enumerable';
    if (!accessControl) obs.roles.enumeration = 'none';

    // Pools, the sell path, and the authority and effect probes (PR B).
    const pools = ctx.factories.length ? await discoverPools(session, rd, addr, ctx) : [];
    const sp = sellPool(pools);
    obs.transfer_probe = await transferProbe(session, rd, { token: addr, pool: sp, decimals: token.decimals, priceUsd: ctx.priceUsd, block, ctx });
    const holder = obs.transfer_probe.sender ? obs.transfer_probe.sender.address : sp ? sp.pool : null;
    if (owner && obs.surface.unclassified_mutators.length) await ownerCtl();
    const ap = await authorityProbes(session, rd, { token: addr, obs, holder, decimals: token.decimals, ownerRes, ctx });
    obs.effects = ap.effects;
    obs.probes_ran = ap.ran;
    const taxBps = obs.transfer_probe.status === 'ok' ? obs.transfer_probe.sell_path.tax_bps : null;
    await quotePools(session, rd, { token: addr, pools, decimals: token.decimals, priceUsd: ctx.priceUsd, taxBps, sizes: ctx.sizes, ctx });
    obs.pools = pools;

    // The state at "latest", compared (a labeled read outside the pin).
    let latestMatch = null;
    if (kind !== 'none' && kind !== 'eip1167_minimal') {
      latestMatch = true;
      for (const k of ['implementation', 'admin', 'beacon']) {
        const res = await session.call('eth_getStorageAt', [addr, SLOTS[k]], { latest: true });
        if (!res.ok) { latestMatch = null; rd.missing.add('latest_slots'); break; }
        if ((slotAddress(lower(res.result)) || null) !== (raw[k] || null)) latestMatch = false;
      }
    }
    if (owner) {
      const res = await session.call('eth_call', [{ to: addr, data: callData('owner()') }], { latest: true });
      if (res.ok && decAddress(res.result) !== owner) latestMatch = false;
    }
    block.latest_slots_match = latestMatch;

    // Supply against the previous observation.
    obs.supply = await supplyCheck(session, rd, addr, prev, block, token, ctx);
  }

  // The block is still canonical at the end, or nothing is kept.
  const again = await session.call('eth_getBlockByNumber', [`0x${block.number.toString(16)}`, false]);
  if (!again.ok || !again.result || lower(again.result.hash) !== block.hash) throw new rpc.Stop('reorg', `Block ${block.number} is no longer the one pinned (${block.hash.slice(0, 10)}…).`);

  const missing = [...rd.missing].sort();
  if (!obs.probes_ran || obs.authorities.some((a) => (a.capability === 'C2' || a.capability === 'C3') && a.proof === 'state_read')) missing.push('authority_probe');
  if (!obs.transfer_probe || obs.transfer_probe.status === 'unavailable') missing.push('transfer_probe');
  if (!obs.pools.some((p) => p.counted)) missing.push('verified_pool');
  missing.push('lp_removal');
  if (obs.source && obs.source.status !== 'verified_full' && obs.source.status !== 'verified_partial') missing.push('verified_source');
  return {
    observation: {
      block,
      token,
      proxy: obs.proxy,
      source: obs.source,
      surface: obs.surface,
      authorities: obs.authorities,
      roles: obs.roles,
      supply: obs.supply,
      transfer_probe: obs.transfer_probe,
      effects: obs.effects,
      pools: obs.pools,
      price_ref: market && market.price_usd !== null ? { usd: String(market.price_usd), as_of: market.as_of || null, source: 'coingecko_stored' } : null,
      errors: rd.errors,
      coverage: { complete: false, missing: [...new Set(missing)].sort(), words: 'LP removal is not read in this version.' },
      retrieved: { started_at: started, finished_at: new Date(now()).toISOString() },
    },
    code: ctx.code,
  };
}

// ---------------------------------------------------------------------------
// Probes (PR B). cr-probe@1 is hand-assembled EVM code placed by a state
// override at the address whose power is tested, so the token sees that
// address as msg.sender. It reads, acts, reads again and returns six words:
// [read_ok, before, act_ok, act_return, read_ok, after]. Its calldata is the
// target, the read's length, the action's length, then both. Nothing runs on
// chain: the node simulates one eth_call at the pinned block.
//
//   PUSH1 60 CALLDATASIZE SUB PUSH1 60 PUSH2 0100 CALLDATACOPY      ; data → 0x100
//   STATICCALL(gas, target, 0x100, readLen, 0x20, 32) → mstore 0x00  ; before
//   mstore(0x60, 1)                                                  ; no return data = true
//   CALL(gas, target, 0, 0x100+readLen, actLen, 0x60, 32) → mstore 0x40
//   STATICCALL(gas, target, 0x100, readLen, 0xa0, 32) → mstore 0x80  ; after
//   RETURN(0, 0xc0)
const PROBE_VERSION = 'cr-probe@1';
const PROBE_CODE = `0x${[
  '6060', '36', '03', '6060', '610100', '37',
  '6020', '6020', '602035', '610100', '600035', '5a', 'fa', '600052',
  '6001', '606052',
  '6020', '6060', '604035', '602035', '610100', '01', '6000', '600035', '5a', 'f1', '604052',
  '6020', '60a0', '602035', '610100', '600035', '5a', 'fa', '608052',
  '60c0', '6000', 'f3',
].join('')}`;
const PROBE_CODE_HASH = K.keccak256Hex(PROBE_CODE);
// A caller no one holds a key to: Keccak-256 of its own name.
const RANDOM_CALLER = `0x${K.keccak256('cr-probe@1 random caller').slice(-40)}`;
const PROBE_LIMIT = 'One sender, one path, one size, one block.';

const probeData = (target, read, act) => {
  const r = strip0x(read);
  const a = strip0x(act);
  return `0x${encAddress(target)}${encUint(r.length / 2)}${encUint(a.length / 2)}${r}${a}`;
};

async function probe(session, at, target, read, act) {
  const res = await session.call('eth_call', [{ to: lower(at), data: probeData(target, read, act) }], { overrides: { [lower(at)]: { code: PROBE_CODE } } });
  if (!res.ok || typeof res.result !== 'string' || strip0x(res.result).length < 384) return null;
  const w = (i) => decUint(`0x${wordAt(res.result, i)}`);
  return { read_ok: w(0) === 1n, before: w(1), act_ok: w(2) === 1n, act_return: w(3), after_ok: w(4) === 1n, after: w(5) };
}

// Arguments for the functions a probe calls: (holder, amount) → words.
const PROBE_ARGS = Object.freeze({
  'mint(address,uint256)': (h, amt) => [encAddress(RANDOM_CALLER), encUint(amt)],
  'mintTo(address,uint256)': (h, amt) => [encAddress(RANDOM_CALLER), encUint(amt)],
  'mint(uint256)': (h, amt) => [encUint(amt)],
  'issue(uint256)': (h, amt) => [encUint(amt)],
  'burn(address,uint256)': (h, amt) => [encAddress(h), encUint(amt)],
  'setBalance(address,uint256)': (h) => [encAddress(h), encUint(0)],
  'forceTransfer(address,address,uint256)': (h, amt) => [encAddress(h), encAddress(RANDOM_CALLER), encUint(amt)],
  'adminTransfer(address,address,uint256)': (h, amt) => [encAddress(h), encAddress(RANDOM_CALLER), encUint(amt)],
});
// An unclassified function shaped (address,uint256) or (uint256) is tried
// as an effect probe: if it raises supply, it is a mint.
function effectArgs(signature) {
  if (/^\w+\(address,uint256\)$/.test(signature)) return (h, amt) => [encAddress(RANDOM_CALLER), encUint(amt)];
  if (/^\w+\(uint256\)$/.test(signature)) return (h, amt) => [encUint(amt)];
  return null;
}

// Pools: Eric's allowlist (settings contracts.pool_factories), each row
// copied from the venue's published deployments; empty by default, so no
// pool counts until he adds one.
function factoriesOf(ws, chainId) {
  const rows = (ws.settings && ws.settings.contracts && Array.isArray(ws.settings.contracts.pool_factories)) ? ws.settings.contracts.pool_factories : [];
  const hex = (v, n) => typeof v === 'string' && new RegExp(`^0x[0-9a-fA-F]{${n}}$`).test(v);
  return rows.filter((r) => r && String(r.chain_id) === String(chainId) && ['v2', 'v3'].includes(r.kind) && hex(r.factory, 40) && hex(r.init_code_hash, 64)
    && Array.isArray(r.quotes) && (r.kind === 'v2' ? Number.isInteger(r.fee_bps) : Array.isArray(r.fee_tiers) && hex(r.quoter, 40) && hex(r.quoter_code_hash, 64)))
    .map((r) => ({ ...r, factory: lower(r.factory), init_code_hash: lower(r.init_code_hash), quoter: r.quoter ? lower(r.quoter) : null, quoter_code_hash: r.quoter_code_hash ? lower(r.quoter_code_hash) : null,
      quotes: r.quotes.filter((q) => q && hex(q.address, 40) && Number.isInteger(q.decimals) && typeof q.usd_value === 'string').map((q) => ({ address: lower(q.address), decimals: q.decimals, usd_value: q.usd_value, symbol: q.symbol || null })) }));
}

const sortedPair = (a, b) => (lower(a) < lower(b) ? [lower(a), lower(b)] : [lower(b), lower(a)]);

// Every allowlisted pool of the token, each checked: the factory's own
// lookup, the CREATE2 address, token0/token1, and for a constant-product pool
// the token balance against the reserve (a rebasing or fee-accruing token is
// not computed). A failed check excludes the pool with its reason.
async function discoverPools(session, rd, token, ctx) {
  const out = [];
  for (const f of ctx.factories) {
    for (const q of f.quotes) {
      if (q.address === token) continue;
      const [t0, t1] = sortedPair(token, q.address);
      const tiers = f.kind === 'v2' ? [null] : f.fee_tiers.filter((x) => Number.isInteger(x));
      for (const fee of tiers) {
        const look = f.kind === 'v2' ? await rd.view(f.factory, callData('getPair(address,address)', word(token), word(q.address)))
          : await rd.view(f.factory, callData('getPool(address,address,uint24)', word(token), word(q.address), encUint(fee)));
        const addr = look ? decAddress(look) : null;
        if (!addr || addr === ZERO) continue;
        const salt = f.kind === 'v2' ? K.keccak256Hex(`0x${strip0x(t0)}${strip0x(t1)}`) : K.keccak256Hex(`0x${word(t0)}${word(t1)}${encUint(fee)}`);
        const derived = K.create2Address(f.factory, salt, f.init_code_hash);
        const row = { pool: addr, factory: f.factory, venue: f.name || null, kind: f.kind, mechanism: f.kind === 'v2' ? 'constant_product' : 'concentrated', fee_bps: f.kind === 'v2' ? f.fee_bps : fee / 100, fee_tier: fee, quote_asset: q.address, quote_decimals: q.decimals, quote_usd: q.usd_value, create2_verified: derived === addr, counted: false, excluded: null };
        const exclude = (why) => { row.excluded = why; out.push(row); };
        if (!row.create2_verified) { exclude('The address is not the CREATE2 derivation of this factory and pair.'); continue; }
        const a0 = await rd.view(addr, callData('token0()'));
        const a1 = await rd.view(addr, callData('token1()'));
        if (!a0 || !a1 || decAddress(a0) !== t0 || decAddress(a1) !== t1) { exclude('token0 and token1 are not this token and the quote asset.'); continue; }
        const tokenBal = await rd.view(token, callData('balanceOf(address)', word(addr)));
        if (f.kind === 'v2') {
          const res = await rd.view(addr, callData('getReserves()'));
          if (!res || !tokenBal) { exclude('The reserves did not read.'); continue; }
          const r0 = decUint(`0x${wordAt(res, 0)}`);
          const r1 = decUint(`0x${wordAt(res, 1)}`);
          const rt = token === t0 ? r0 : r1;
          const rq = token === t0 ? r1 : r0;
          row.reserves = { token: rt.toString(), quote: rq.toString() };
          const bal = decUint(tokenBal);
          const diff = bal > rt ? bal - rt : rt - bal;
          if (diff > 1n) { exclude('The token balance differs from the reserve: a rebasing or fee-accruing token is not computed by constant product.'); continue; }
        } else {
          const qb = await rd.view(q.address, callData('balanceOf(address)', word(addr)));
          row.reserves = { token: tokenBal ? decUint(tokenBal).toString() : null, quote: qb ? decUint(qb).toString() : null };
          const qc = await rd.code(f.quoter);
          if (!qc || qc.hash !== f.quoter_code_hash) { exclude('The quoter\'s code is not the allowlisted code.'); continue; }
        }
        row.counted = true;
        out.push(row);
      }
    }
  }
  return out.sort((a, b) => (a.pool < b.pool ? -1 : a.pool > b.pool ? 1 : (a.fee_tier || 0) - (b.fee_tier || 0)));
}

// The pool a sale goes to: the counted pool with the most quote-asset value.
function sellPool(pools) {
  const counted = pools.filter((p) => p.counted && p.reserves && p.reserves.quote);
  const value = (p) => { const v = BigInt(p.reserves.quote) * 10n ** BigInt(30 - p.quote_decimals); return v; };
  return counted.sort((a, b) => (value(b) > value(a) ? 1 : value(b) < value(a) ? -1 : a.pool < b.pool ? -1 : 1))[0] || null;
}

// The sell path at the pinned block (cr-transfer-probe@1): a recent buyer
// from the pool sells to it; the pool's balance before and after gives the
// amount received, so the tax is measured, not reported.
async function transferProbe(session, rd, { token, pool, decimals, priceUsd, block, ctx }) {
  const base = { version: 'cr-transfer-probe@1', probe_code_hash: PROBE_CODE_HASH, limit: PROBE_LIMIT };
  if (!ctx.overrides) return { ...base, status: 'unavailable', words: 'This network\'s probe found no state overrides: the sale is not simulated.' };
  if (!pool) return { ...base, status: 'unavailable', words: 'No verified pool to sell into.' };
  const from = Math.max(0, block.number - ctx.cfg.max_log_blocks + 1);
  const logs = await session.call('eth_getLogs', [{ address: token, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${block.number.toString(16)}`, topics: [TOPICS.Transfer, `0x${word(pool.pool)}`] }]);
  if (!logs.ok || !Array.isArray(logs.result)) { rd.missing.add('transfer_probe'); return { ...base, status: 'unavailable', words: 'The pool\'s recent transfers did not read.' }; }
  const buyers = [];
  for (const l of logs.result.slice().reverse()) {
    const to = l && Array.isArray(l.topics) && l.topics[2] ? decAddress(l.topics[2]) : null;
    if (to && to !== ZERO && to !== pool.pool && !buyers.includes(to)) buyers.push(to);
    if (buyers.length >= 3) break;
  }
  let holder = null;
  let bal = 0n;
  for (const b of buyers) {
    const v = await rd.view(token, callData('balanceOf(address)', word(b)));
    if (v && decUint(v) > 0n) { holder = b; bal = decUint(v); break; }
  }
  if (!holder) return { ...base, status: 'unavailable', words: `No recent buyer within ${ctx.cfg.max_log_blocks} blocks still holds the token.` };
  const ref = Number.isInteger(decimals) && priceUsd !== null ? require('./contract-gate').tokensFor(500, priceUsd, decimals) : null;
  const amount = ref && ref > 0n && ref < bal ? ref : bal;
  const r = await probe(session, holder, token, callData('balanceOf(address)', word(pool.pool)), callData('transfer(address,uint256)', word(pool.pool), encUint(amount)));
  const sender = { address: holder, chosen_by: 'recent_buyer' };
  if (!r || !r.read_ok || !r.after_ok) return { ...base, status: 'unavailable', sender, words: 'The node did not run the probe.' };
  if (!r.act_ok) return { ...base, status: 'reverted', sender, sell_path: { to: pool.pool, sent: amount.toString(), received: null, tax_bps: null } };
  if (r.act_return === 0n) return { ...base, status: 'returned_false', sender, sell_path: { to: pool.pool, sent: amount.toString(), received: null, tax_bps: null } };
  const received = r.after - r.before;
  if (received < 0n || received > amount) return { ...base, status: 'unavailable', sender, words: 'The pool received an amount the sale cannot explain.' };
  return { ...base, status: 'ok', sender, sell_path: { to: pool.pool, sent: amount.toString(), received: received.toString(), tax_bps: Number(((amount - received) * 10000n) / amount) } };
}

// Who a probe calls as: the authority path's first owner or role member.
function senderOf(a) {
  const hop = (a.path || []).find((p) => p && p.address && ['owner', 'role_member'].includes(p.node));
  return hop ? hop.address : null;
}

// Authority and effect probes (cr-authority-probe@1) on mint and balance
// powers, as the named controller and as a caller no one holds: a power that
// works for anyone is unguarded; one that works for neither is held by
// someone the reads do not name; an unclassified function that raises supply
// is a mint.
async function authorityProbes(session, rd, { token, obs, holder, decimals, ownerRes, ctx }) {
  const effects = [];
  if (!ctx.overrides) return { effects, ran: false };
  const amt = 10n ** BigInt(Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : 18);
  const SUPPLY = callData('totalSupply()');
  const run = async (as, sig, args, read) => {
    const r = await probe(session, as, token, read, `${K.selector(sig)}${args.join('')}`);
    if (!r || !r.read_ok || !r.after_ok) return { state: 'unavailable' };
    const delta = r.after - r.before;
    return { state: !r.act_ok ? 'reverted' : delta === 0n ? 'no_effect' : 'succeeded', delta, act_ok: r.act_ok };
  };
  for (const a of obs.authorities.filter((x) => x.capability === 'C2' || x.capability === 'C3')) {
    const make = PROBE_ARGS[a.function];
    if (!make) continue;
    const read = a.capability === 'C2' ? SUPPLY : holder ? callData('balanceOf(address)', word(holder)) : null;
    if (!read) continue;
    const args = make(holder || RANDOM_CALLER, amt);
    const effectOf = (res) => (a.capability === 'C2' ? res.delta > 0n : res.delta < 0n);
    const rnd = await run(RANDOM_CALLER, a.function, args, read);
    a.random_caller = rnd.state === 'succeeded' && effectOf(rnd) ? 'succeeded' : rnd.state === 'unavailable' ? 'not_tried' : 'reverted';
    effects.push({ function: a.function, as: RANDOM_CALLER, [a.capability === 'C2' ? 'supply_delta' : 'holder_delta']: rnd.delta === undefined ? null : rnd.delta.toString(), result: rnd.state });
    const as = senderOf(a);
    if (as) {
      const ctl = await run(as, a.function, args, read);
      effects.push({ function: a.function, as, [a.capability === 'C2' ? 'supply_delta' : 'holder_delta']: ctl.delta === undefined ? null : ctl.delta.toString(), result: ctl.state });
      if (ctl.state === 'succeeded' && effectOf(ctl)) Object.assign(a, { proof: 'authority_probe', coverage: 'complete' });
      else if (ctl.state !== 'unavailable' && a.random_caller === 'reverted') Object.assign(a, { class: 'K6', proof: 'authority_probe', coverage: 'complete', words: `Neither the named controller (${as}) nor a fresh caller could call ${a.function}: who can is not named by the reads.` });
    } else if (a.class === 'K1' && a.random_caller === 'reverted') Object.assign(a, { proof: 'authority_probe', coverage: 'complete' });
  }
  // Effect probes on the functions the desk does not classify.
  const unclassified = (obs.surface && obs.surface.unclassified_mutators) || [];
  for (const f of unclassified.slice()) {
    const make = effectArgs(f.signature || '');
    if (!make) continue;
    const args = make(holder, amt);
    const callers = [RANDOM_CALLER, ownerRes ? ownerRes.address : null].filter(Boolean);
    for (const as of callers) {
      const res = await run(as, f.signature, args, SUPPLY);
      effects.push({ function: f.signature, as, supply_delta: res.delta === undefined ? null : res.delta.toString(), result: res.state });
      if (res.state === 'succeeded' && res.delta > 0n) {
        obs.surface.unclassified_mutators = obs.surface.unclassified_mutators.filter((x) => x.selector !== f.selector);
        obs.surface.functions = sortBy([...obs.surface.functions, { selector: f.selector, signature: f.signature, capability: 'C2', basis: 'effect_probe' }], 'selector');
        const unguarded = as === RANDOM_CALLER;
        obs.authorities.push(unguarded
          ? { capability: 'C2', function: f.signature, path: [], class: 'K6', delay_hours: null, proof: 'effect_probe', random_caller: 'succeeded', coverage: 'complete', words: `${f.signature} raised supply when a fresh caller called it.` }
          : { capability: 'C2', function: f.signature, path: ownerRes.path, class: ownerRes.class, delay_hours: ownerRes.delay_hours === undefined ? null : ownerRes.delay_hours, proof: 'effect_probe', random_caller: 'reverted', coverage: 'complete', words: `${f.signature} raised supply when the owner called it: it is a mint.` });
        break;
      }
    }
  }
  return { effects, ran: true };
}

// Concentrated-pool quotes through the allowlisted QuoterV2 at the pinned
// block, at each exit size; never for a taxed token (the pool checks it
// received the full input, so a tax makes the swap revert).
async function quotePools(session, rd, { token, pools, decimals, priceUsd, taxBps, sizes, ctx }) {
  const gate = require('./contract-gate');
  for (const p of pools.filter((x) => x.counted && x.mechanism === 'concentrated')) {
    if (taxBps !== null && taxBps > 0) { Object.assign(p, { counted: false, excluded: `A token with a ${taxBps / 100}% transfer tax cannot settle in a concentrated pool.` }); continue; }
    const f = ctx.factories.find((x) => x.factory === p.factory);
    p.quoted = {};
    for (const s of sizes) {
      const q = Number.isInteger(decimals) && priceUsd !== null ? gate.tokensFor(s, priceUsd, decimals) : null;
      if (q === null) continue;
      const data = callData('quoteExactInputSingle((address,address,uint256,uint24,uint160))', word(token), word(p.quote_asset), encUint(q), encUint(p.fee_tier), encUint(0));
      const v = await rd.view(f.quoter, data);
      p.quoted[String(s)] = v ? decUint(`0x${wordAt(v, 0)}`).toString() : null;
    }
  }
}

async function supplyCheck(session, rd, addr, prev, block, token, ctx) {
  if (!prev || !prev.token || prev.token.total_supply === null || token.total_supply === null) return { previous_observation_id: prev ? prev.observation_id : null, delta: null, explained: null, words: prev ? 'A supply did not read.' : 'First observation: nothing to compare.' };
  if (prev.block.number >= block.number) return { previous_observation_id: prev.observation_id, delta: null, explained: null, words: 'The previous observation is not older.' };
  const delta = BigInt(token.total_supply) - BigInt(prev.token.total_supply);
  if (delta === 0n) return { previous_observation_id: prev.observation_id, delta: '0', mint_events_net: '0', explained: true };
  const from = prev.block.number + 1;
  if (block.number - from + 1 > ctx.cfg.max_log_blocks) return { previous_observation_id: prev.observation_id, delta: delta.toString(), mint_events_net: null, explained: null, words: `More than ${ctx.cfg.max_log_blocks} blocks between the observations: the events were not read.` };
  const zeroTopic = `0x${word(ZERO)}`;
  const range = { address: addr, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${block.number.toString(16)}` };
  const mints = await session.call('eth_getLogs', [{ ...range, topics: [TOPICS.Transfer, zeroTopic] }]);
  const burns = await session.call('eth_getLogs', [{ ...range, topics: [TOPICS.Transfer, null, zeroTopic] }]);
  if (!mints.ok || !burns.ok || !Array.isArray(mints.result) || !Array.isArray(burns.result)) {
    rd.missing.add('supply_events');
    return { previous_observation_id: prev.observation_id, delta: delta.toString(), mint_events_net: null, explained: null, words: 'The mint and burn events did not read.' };
  }
  const sum = (logs) => logs.reduce((t, l) => t + (decUint(l.data) || 0n), 0n);
  const net = sum(mints.result) - sum(burns.result);
  return { previous_observation_id: prev.observation_id, delta: delta.toString(), mint_events_net: net.toString(), explained: net === delta, words: net === delta ? null : 'Supply changed by more than the token\'s own mint and burn events account for.' };
}

// ---------------------------------------------------------------------------
// One Solana observation (finalized commitment; the slot is recorded and
// cannot be re-read there: Solana keeps no account history).

async function observeSolana(session, subject, { now }) {
  const started = new Date(now()).toISOString();
  const opts = { encoding: 'jsonParsed', commitment: 'finalized' };
  const res = await session.call('getAccountInfo', [subject.address, opts]);
  if (!res.ok || !res.result || !res.result.context) throw new rpc.Stop('failed', 'The mint account did not read.');
  const slot = res.result.context.slot;
  const v = res.result.value;
  const errors = [];
  const missing = new Set(['authority_probe']);
  if (!v) {
    return { observation: { block: { slot, commitment: 'finalized' }, token: { code_kind: 'empty', program: null }, proxy: null, authorities: [], extensions: [], errors, coverage: { complete: false, missing: [...missing], words: 'The mint account does not exist.' }, retrieved: { started_at: started, finished_at: new Date(now()).toISOString() } }, code: new Map() };
  }
  const program = v.owner === SOL.TOKEN_2022 ? 'token_2022' : v.owner === SOL.SPL ? 'spl_token' : 'other';
  const info = v.data && v.data.parsed && v.data.parsed.info ? v.data.parsed.info : null;
  if (!info || program === 'other') {
    return { observation: { block: { slot, commitment: 'finalized' }, token: { code_kind: 'contract', program }, proxy: null, authorities: [], extensions: [], errors, coverage: { complete: false, missing: ['mint_layout', ...missing].sort(), words: 'Not a mint of the SPL Token or Token-2022 program.' }, retrieved: { started_at: started, finished_at: new Date(now()).toISOString() } }, code: new Map() };
  }
  const ext = Array.isArray(info.extensions) ? info.extensions : [];
  const extOf = (name) => ext.find((e) => e && e.extension === name) || null;
  const fee = extOf('transferFeeConfig');
  const pd = extOf('permanentDelegate');
  const hook = extOf('transferHook');
  const das = extOf('defaultAccountState');
  const auths = [
    ['C2', 'mintAuthority', info.mintAuthority || null],
    ['C4', 'freezeAuthority', info.freezeAuthority || null],
    ['C3', 'permanentDelegate', pd && pd.state ? pd.state.delegate || null : null],
    ['C5', 'transferFeeConfigAuthority', fee && fee.state ? fee.state.transferFeeConfigAuthority || null : null],
    ['C6', 'transferHook.authority', hook && hook.state ? hook.state.authority || null : null],
  ];
  const keys = [...new Set(auths.map((a) => a[2]).filter(Boolean))];
  const owners = new Map();
  if (keys.length) {
    const m = await session.call('getMultipleAccounts', [keys, opts]);
    if (m.ok && m.result && Array.isArray(m.result.value)) keys.forEach((k, i) => owners.set(k, m.result.value[i] ? m.result.value[i].owner : null));
    else { errors.push({ read: 'getMultipleAccounts authorities', kind: 'rpc_error', words: (m && m.error) || 'no answer' }); missing.add('authorities'); }
  }
  const classify = (k) => {
    if (!owners.has(k)) return { class: 'K6', words: 'The authority account did not read.' };
    const o = owners.get(k);
    if (o === null || o === SOL.SYSTEM) return { class: 'K5', words: 'A key (System Program account): one signer.' };
    return { class: 'K6', words: 'A program-owned authority (a multisig or another program): not read in this version.' };
  };
  const authorities = [];
  for (const [cap, field, key] of auths) {
    if (!key) continue;
    const c = classify(key);
    authorities.push({ capability: cap, function: field, path: [{ address: key, node: field }], class: c.class, delay_hours: null, proof: 'state_read', random_caller: 'not_tried', coverage: 'partial', words: c.words });
  }
  // The hook program's own upgrade authority.
  let hookProgram = null;
  if (hook && hook.state && hook.state.programId) {
    hookProgram = { program_id: hook.state.programId, upgrade_authority: null, words: null };
    const p = await session.call('getAccountInfo', [hook.state.programId, opts]);
    const pdAddr = p.ok && p.result && p.result.value && p.result.value.data && p.result.value.data.parsed && p.result.value.data.parsed.info ? p.result.value.data.parsed.info.programData : null;
    if (p.ok && p.result && p.result.value && p.result.value.owner !== SOL.UPGRADEABLE_LOADER) hookProgram.words = 'The hook program is not upgradeable (not owned by the upgradeable loader).';
    else if (pdAddr) {
      const q = await session.call('getAccountInfo', [pdAddr, opts]);
      const qi = q.ok && q.result && q.result.value && q.result.value.data && q.result.value.data.parsed ? q.result.value.data.parsed.info : null;
      if (qi) {
        hookProgram.upgrade_authority = qi.authority || null;
        hookProgram.words = qi.authority ? 'The hook program can be upgraded by its authority.' : 'The hook program is immutable (no upgrade authority).';
        if (qi.authority) authorities.push({ capability: 'C6', function: 'hook program upgrade', path: [{ address: qi.authority, node: 'program_upgrade_authority' }], class: 'K6', delay_hours: null, proof: 'state_read', random_caller: 'not_tried', coverage: 'partial', words: 'The hook program\'s upgrade authority is not classified in this version.' });
      } else { missing.add('hook_program'); errors.push({ read: 'getAccountInfo programData', kind: 'rpc_error', words: (q && q.error) || 'no answer' }); }
    } else { missing.add('hook_program'); errors.push({ read: 'getAccountInfo hook program', kind: 'rpc_error', words: (p && p.error) || 'no answer' }); }
  }
  const bps = (f) => (f && Number.isInteger(Number(f.transferFeeBasisPoints)) ? Number(f.transferFeeBasisPoints) : null);
  return {
    observation: {
      block: { slot, commitment: 'finalized' },
      token: { code_kind: 'contract', program, decimals: Number.isInteger(info.decimals) ? info.decimals : null, total_supply: typeof info.supply === 'string' ? info.supply : null },
      proxy: null,
      extensions: ext.map((e) => e && e.extension).filter(Boolean).sort(),
      flags: { non_transferable: Boolean(extOf('nonTransferable')), default_frozen: Boolean(das && das.state && das.state.accountState === 'frozen') },
      transfer_fee: fee && fee.state ? { older_bps: bps(fee.state.olderTransferFee), newer_bps: bps(fee.state.newerTransferFee), newer_epoch: fee.state.newerTransferFee ? Number(fee.state.newerTransferFee.epoch) : null } : null,
      hook_program: hookProgram,
      authorities,
      errors,
      coverage: { complete: false, missing: [...missing].sort(), words: 'Program-owned authorities are not resolved in this version.' },
      retrieved: { started_at: started, finished_at: new Date(now()).toISOString() },
    },
    code: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Identity and records

// The identity-critical fields, hashed: what a ticket is pinned to. Supply,
// balances and reserves are left out on purpose.
function identityKeyOf(subject, o) {
  const pathKey = (p) => ({ address: p.address || null, node: p.node, threshold: p.threshold === undefined ? undefined : p.threshold, owners_sha256: p.owners_sha256 || undefined, modules: p.modules === undefined ? undefined : p.modules, delay_hours: p.delay_hours === undefined ? undefined : p.delay_hours });
  const basis = {
    version: IDENTITY_VERSION,
    chain_id: subject.chain_id,
    address: subject.family === 'evm' ? lower(subject.address) : subject.address,
    code_kind: o.token.code_kind,
    code_hash: o.token.code_hash || null,
    program: o.token.program || null,
    proxy: o.proxy ? { kind: o.proxy.kind, implementation: o.proxy.implementation ? { address: o.proxy.implementation.address, code_hash: o.proxy.implementation.code_hash } : null, admin: o.proxy.slots.admin, beacon: o.proxy.beacon ? o.proxy.beacon.address : null } : null,
    flags: o.flags || null,
    hook_program: o.hook_program ? { program_id: o.hook_program.program_id, upgrade_authority: o.hook_program.upgrade_authority } : null,
    authorities: sortBy(o.authorities.map((a) => ({ capability: a.capability, function: a.function, class: a.class, path: a.path.map(pathKey) })), 'capability'),
  };
  return `sha256:${sha256(canonicalJson(basis))}`;
}

const baseRel = (pid) => `projects/${pid}/forensics/contracts`;
const obsRel = (pid, id) => `${baseRel(pid)}/observations/${id}.json`;
const codeRel = (pid, hash) => `${baseRel(pid)}/code/${strip0x(hash)}.hex`;
const statusRel = (pid) => `${baseRel(pid)}/status.json`;
const subjectKey = (s) => `${s.chain_id}:${s.family === 'evm' ? lower(s.address) : s.address}`;

// Create-only: the same bytes again is unchanged; different bytes refused.
function createOnly(ws, rel, text) {
  const abs = ws.abs(rel);
  const have = readText(abs, null);
  if (have !== null) {
    if (have === text) return 'unchanged';
    throw new OpError('INTEGRITY', `${rel} is already on record with different content; it is never rewritten.`);
  }
  replaceFile(ws, abs, text);
  return 'saved';
}

function readStatus(ws, pid) {
  try {
    const s = readJson(ws.abs(statusRel(pid)), null);
    return s && typeof s === 'object' ? { subjects: {}, ...s } : { schema_version: STATUS_SCHEMA, subjects: {} };
  } catch (_) {
    return { schema_version: STATUS_SCHEMA, subjects: {}, unreadable: true };
  }
}

// An observation as stored, its SHA-256 and every code file it names checked.
function readObservation(ws, pid, id) {
  if (!/^co_[0-9a-f]{16}$/.test(String(id))) return { ok: false, words: 'Not an observation ID.' };
  let rec;
  try { rec = readJson(ws.abs(obsRel(pid, id)), null); } catch (_) { return { ok: false, words: `Observation ${id} does not read.` }; }
  if (!rec) return { ok: false, words: `Observation ${id} is not on record.` };
  const { sha256: given, ...rest } = rec;
  if (sha256(canonicalJson(rest)) !== given) return { ok: false, words: `Observation ${id} does not match its SHA-256.` };
  return { ok: true, observation: rec };
}

// Stored code, re-hashed on every read.
function readCode(ws, pid, hash) {
  const hex = readText(ws.abs(codeRel(pid, hash)), null);
  if (hex === null) return { ok: false, words: 'Not on record.' };
  return K.keccak256Hex(hex.trim()) === lower(hash) ? { ok: true, hex: hex.trim() } : { ok: false, words: 'The stored code does not hash to its name.' };
}

// What changed in the identity between two observations of one subject.
// The measured sell tax, or null when no probe measured one.
const taxOf = (o) => (o && o.transfer_probe && o.transfer_probe.status === 'ok' && o.transfer_probe.sell_path ? o.transfer_probe.sell_path.tax_bps : null);

function changesBetween(a, b) {
  const out = [];
  const say = (field, x, y) => { if (canonicalJson(x) !== canonicalJson(y)) out.push({ field, from: x === undefined ? null : x, to: y === undefined ? null : y }); };
  say('token.code_hash', a.token.code_hash, b.token.code_hash);
  say('proxy.kind', a.proxy && a.proxy.kind, b.proxy && b.proxy.kind);
  say('proxy.implementation', a.proxy && a.proxy.implementation && a.proxy.implementation.address, b.proxy && b.proxy.implementation && b.proxy.implementation.address);
  say('proxy.implementation_code_hash', a.proxy && a.proxy.implementation && a.proxy.implementation.code_hash, b.proxy && b.proxy.implementation && b.proxy.implementation.code_hash);
  say('proxy.admin', a.proxy && a.proxy.slots.admin, b.proxy && b.proxy.slots.admin);
  say('proxy.beacon', a.proxy && a.proxy.beacon && a.proxy.beacon.address, b.proxy && b.proxy.beacon && b.proxy.beacon.address);
  const auth = (o) => Object.fromEntries(o.authorities.map((x) => [x.capability, { class: x.class, path: x.path.map((p) => p.address) }]));
  say('authorities', auth(a), auth(b));
  say('transfer_probe.tax_bps', taxOf(a), taxOf(b));
  return out;
}

// The stored price and Eric's exit sizes the pools are priced at (the
// screening preferences' ladder and position).
function marketFor(ws, project) {
  const cg = project && project.identity && project.identity.coingecko_id;
  let row = null;
  try { row = cg ? (require('./market').readLatest(ws).assets || {})[cg] : null; } catch (_) { row = null; }
  let sizes = [100, 500, 2000];
  try { const p = require('./forensics').prefsOf(ws); sizes = [...new Set([...p.exit_sizes_usd, p.exit_position_usd])].sort((a, b) => a - b); } catch (_) { /* defaults */ }
  const price = row && typeof row.price_usd === 'number' && row.price_usd > 0 ? row.price_usd : null;
  return { price_usd: price, as_of: row ? row.source_last_updated_at || row.fetched_at || null : null, sizes };
}

// Saves one observation and its code, and moves the subject's pointer.
function store(ws, pid, subject, built, { provider, now }) {
  const o = built.observation;
  const pinKey = subject.family === 'evm' ? o.block.hash : `slot:${o.block.slot}`;
  const dedupe = `${subject.chain_id}:${subject.family === 'evm' ? lower(subject.address) : subject.address}:${pinKey}:${VERSION}`;
  const rec = {
    schema_version: SCHEMA,
    method: VERSION,
    observation_id: `co_${sha256(dedupe).slice(0, 16)}`,
    dedupe_key: dedupe,
    subject: { project_id: pid, chain_id: subject.chain_id, family: subject.family, address: subject.family === 'evm' ? lower(subject.address) : subject.address },
    block: o.block,
    provider,
    retrieved: o.retrieved,
    token: { ...o.token, code_ref: o.token.code_hash ? codeRel(pid, o.token.code_hash) : null },
    proxy: o.proxy,
    source: o.source || null,
    surface: o.surface || null,
    authorities: o.authorities,
    roles: o.roles || null,
    supply: o.supply || null,
    transfer_probe: o.transfer_probe || undefined,
    effects: o.effects || undefined,
    pools: o.pools || undefined,
    price_ref: o.price_ref || undefined,
    extensions: o.extensions || undefined,
    flags: o.flags || undefined,
    transfer_fee: o.transfer_fee || undefined,
    hook_program: o.hook_program || undefined,
    identity_key: identityKeyOf(subject, o),
    coverage: o.coverage,
    errors: o.errors,
    json: JSON_VERSION,
  };
  const clean = JSON.parse(JSON.stringify(rec));
  clean.sha256 = sha256(canonicalJson(clean));
  return withLock(ws, `contracts ${pid}`, () => {
    // The observation at a block is already on record: the first one stands
    // (a re-read differs only in its retrieval time and comparison).
    const onRecord = fs.existsSync(ws.abs(obsRel(pid, clean.observation_id))) ? readObservation(ws, pid, clean.observation_id) : null;
    if (onRecord && !onRecord.ok) throw new OpError('INTEGRITY', `${obsRel(pid, clean.observation_id)} does not match its SHA-256; nothing was recorded.`);
    for (const [hash, hex] of built.code) createOnly(ws, codeRel(pid, hash), `${hex}\n`);
    const saved = onRecord ? 'unchanged' : createOnly(ws, obsRel(pid, clean.observation_id), jsonText(clean));
    const kept = onRecord ? onRecord.observation : clean;
    const st = readStatus(ws, pid);
    const key = subjectKey(subject);
    const cur = st.subjects[key] || { history: [], transitions: [] };
    const prevId = cur.current || null;
    let transition = null;
    if (prevId && prevId !== kept.observation_id) {
      const prev = readObservation(ws, pid, prevId);
      // A new identity, or a measured tax that moved (both measured).
      const taxMoved = taxOf(prev.observation) !== null && taxOf(kept) !== null && taxOf(prev.observation) !== taxOf(kept);
      if (prev.ok && (prev.observation.identity_key !== kept.identity_key || taxMoved)) {
        const pb = prev.observation.block;
        const nb = kept.block;
        transition = { at: new Date(now()).toISOString(), from_observation_id: prevId, to_observation_id: kept.observation_id, from_identity_key: prev.observation.identity_key, to_identity_key: kept.identity_key, between: { from: pb.number !== undefined ? pb.number : pb.slot, to: nb.number !== undefined ? nb.number : nb.slot }, changes: changesBetween(prev.observation, kept), words: 'Changed between these two observations; when exactly is not established.' };
      }
    }
    const next = {
      current: kept.observation_id,
      identity_key: kept.identity_key,
      block: kept.block.hash ? { number: kept.block.number, hash: kept.block.hash, timestamp: kept.block.timestamp } : { slot: kept.block.slot },
      observed_at: kept.retrieved.finished_at,
      history: [...(cur.history || []).filter((h) => h.observation_id !== kept.observation_id), { observation_id: kept.observation_id, identity_key: kept.identity_key, observed_at: kept.retrieved.finished_at }].slice(-50),
      transitions: transition ? [...(cur.transitions || []), transition].slice(-50) : cur.transitions || [],
    };
    replaceFile(ws, ws.abs(statusRel(pid)), jsonText({ ...st, schema_version: STATUS_SCHEMA, subjects: { ...st.subjects, [key]: next } }));
    return { status: saved, observation: kept, transition };
  });
}

// ---------------------------------------------------------------------------
// Subjects: the contracts of a verified, active identity on a chain family
// the desk reads. A native coin has none.

function subjectsOf(project) {
  const id = project && project.identity;
  if (!id || id.status !== 'verified' || id.native_chain === true) return [];
  const { chainInfo, addressFits } = require('./chains');
  const out = [];
  const seen = new Set();
  for (const a of Array.isArray(id.assets) ? id.assets : []) {
    const info = chainInfo(a && a.chain);
    if (!info || !a.contract_address || !['evm', 'solana'].includes(info.family) || !addressFits(info.family, a.contract_address)) continue;
    const s = { chain_id: info.chain_id, family: info.family, label: info.label, address: info.family === 'evm' ? lower(a.contract_address.trim()) : a.contract_address.trim() };
    if (!seen.has(subjectKey(s))) { seen.add(subjectKey(s)); out.push(s); }
  }
  return out;
}

// The fixed reads every EVM observation makes, and the ones its answers can
// add, for a dry run: nothing is reserved or sent.
function planFor(subject) {
  if (subject.family === 'solana') {
    const base = [['getAccountInfo', 1], ['getMultipleAccounts', 1]];
    return { base, more: 'plus up to 2 getAccountInfo reads when a transfer-hook program is set' };
  }
  const base = [['eth_chainId', 1], ['eth_getBlockByNumber', 2], ['eth_getCode', 1], ['eth_getStorageAt', 5], ['eth_call', 6]];
  return { base, more: 'plus the implementation\'s code, each controller (code, Safe or timelock reads, up to your authority depth), role members, three slots at latest, and two eth_getLogs when the supply moved' };
}

function dryRun(ws, pid) {
  const project = require('./projects').getProject(ws, pid);
  const subjects = subjectsOf(project);
  const rows = subjects.map((s) => {
    const p = planFor(s);
    const support = rpc.networkSupport(ws, s.chain_id);
    const requests = p.base.reduce((n, [, c]) => n + c, 0);
    const cu = p.base.reduce((n, [m, c]) => n + rpc.CU[m] * c, 0);
    return { chain_id: s.chain_id, label: s.label, address: s.address, network: support.supported ? 'supported' : support.reason, requests: p.base.map(([m, c]) => ({ method: m, count: c, cu: rpc.CU[m] * c })), base_requests: requests, base_cu: cu, more: p.more };
  });
  return { dry_run: true, project_id: pid, sent: 0, caps: rpc.capsOf(ws), subjects: rows, words: subjects.length ? `${rows.reduce((n, r) => n + r.base_requests, 0)} base requests, about ${rows.reduce((n, r) => n + r.base_cu, 0)} compute units before the reads their answers add. Nothing was sent.` : 'No contract on a verified identity to observe.' };
}

// One project's observations: each subject on a supported network, one
// retry at a new finalized block after a reorg. A stop (rate limit, budget,
// key, held copy) ends the run with nothing partial written.
async function observeProject(ws, pid, { fetchImpl = null, key = undefined, sourceImpl = sourcifyGet, now = Date.now, dryRun: dry = false, trigger = 'manual' } = {}) {
  if (dry) return dryRun(ws, pid);
  const clock = typeof now === 'function' ? now : () => now;
  const project = require('./projects').getProject(ws, pid);
  const subjects = subjectsOf(project);
  const market = marketFor(ws, project);
  const out = { project_id: pid, results: [], stopped: null };
  for (const s of subjects) {
    const support = rpc.networkSupport(ws, s.chain_id);
    if (!support.supported) { out.results.push({ chain_id: s.chain_id, address: s.address, status: support.reason, words: support.words }); continue; }
    const st = readStatus(ws, pid).subjects[subjectKey(s)];
    const prev = st && st.current ? readObservation(ws, pid, st.current) : null;
    let built = null;
    let session = null;
    for (let attempt = 1; attempt <= 2 && !built; attempt++) {
      try {
        session = rpc.openSession(ws, { chainId: s.chain_id, fetchImpl, key, now: clock });
        built = s.family === 'evm'
          ? await observeEvm(session, s, { ws, sourceImpl, now: clock, prev: prev && prev.ok ? prev.observation : null, market })
          : await observeSolana(session, s, { now: clock });
      } catch (err) {
        if (err instanceof rpc.Stop && err.kind === 'reorg' && attempt === 1) continue;
        if (err instanceof rpc.Stop) {
          out.results.push({ chain_id: s.chain_id, address: s.address, status: err.kind === 'reorg' ? 'reorged' : err.kind, words: err.message, requests: session ? session.requests : 0 });
          if (err.kind !== 'reorg' && err.kind !== 'failed') out.stopped = { kind: err.kind, words: err.message };
          break;
        }
        if (err instanceof OpError) { out.results.push({ chain_id: s.chain_id, address: s.address, status: 'refused', words: err.message }); break; }
        throw err;
      }
    }
    if (built) {
      const saved = store(ws, pid, s, built, { provider: { id: 'alchemy', chain_id: s.chain_id, requests: session.requests, cu_estimate: session.cu, rpc: rpc.VERSION }, now: clock });
      out.results.push({ chain_id: s.chain_id, address: s.address, status: saved.status, observation_id: saved.observation.observation_id, identity_key: saved.observation.identity_key, requests: session.requests, cu_estimate: session.cu, transition: saved.transition ? saved.transition.changes : null });
    }
    if (out.stopped) break;
  }
  withLock(ws, `contracts ${pid}`, () => {
    const st = readStatus(ws, pid);
    const failed = out.results.some((r) => ['failed', 'reorged'].includes(r.status));
    const failures = failed ? (st.failures || 0) + 1 : 0;
    const cfg = cfgOf(ws);
    const wait = Math.min(cfg.backoff_max_minutes, cfg.backoff_initial_minutes * 2 ** Math.max(0, failures - 1)) * 60000;
    replaceFile(ws, ws.abs(statusRel(pid)), jsonText({ ...st, schema_version: STATUS_SCHEMA, last_attempt: { at: new Date(clock()).toISOString(), trigger, outcome: out.stopped ? out.stopped.kind : failed ? 'failed' : 'ok', words: out.stopped ? out.stopped.words : null }, failures, next_attempt_at: failed ? new Date(clock() + wait).toISOString() : null }));
  });
  return out;
}

// ---------------------------------------------------------------------------
// Network probe (Eric runs it): what a chain answers, recorded with the block.

async function probeNetwork(ws, chainId, { fetchImpl = null, key = undefined, now = Date.now } = {}) {
  const id = String(chainId);
  if (!Object.prototype.hasOwnProperty.call(rpc.HOSTS, id)) throw new OpError('INVALID', `Chain ${id} has no read route in this release (${Object.keys(rpc.HOSTS).join(', ')}).`);
  const clock = typeof now === 'function' ? now : () => now;
  const s = rpc.openSession(ws, { chainId: id, fetchImpl, key, now: clock });
  const rec = { probed_at: new Date(clock()).toISOString(), rpc: rpc.VERSION, finalized: false, eip1898: false, state_overrides: 'not_probed' };
  if (id === 'solana') {
    const r = await s.call('getAccountInfo', [SOL.SPL, { encoding: 'base64', commitment: 'finalized' }]);
    rec.finalized = Boolean(r.ok && r.result && r.result.context && Number.isInteger(r.result.context.slot));
    if (rec.finalized) rec.slot = r.result.context.slot;
  } else {
    const c = await s.call('eth_chainId', []);
    if (!c.ok || BigInt(c.result) !== BigInt(id)) throw new OpError('INTEGRITY', `The node for ${id} answered another chain; nothing was recorded.`);
    const f = await s.call('eth_getBlockByNumber', ['finalized', false]);
    rec.finalized = Boolean(f.ok && f.result && f.result.hash);
    if (rec.finalized) {
      rec.block = { number: Number(BigInt(f.result.number)), hash: lower(f.result.hash) };
      s.pinTo(rec.block.hash);
      const g = await s.call('eth_getCode', [ZERO]);
      rec.eip1898 = Boolean(g.ok);
      // State overrides: code that returns 42 at an address no one holds.
      const at = RANDOM_CALLER;
      const o = await s.call('eth_call', [{ to: at, data: '0x' }], { overrides: { [at]: { code: '0x602a60005260206000f3' } } });
      rec.state_overrides = Boolean(o.ok && typeof o.result === 'string' && decUint(o.result) === 42n);
    }
  }
  rec.requests = s.requests;
  rec.cu_estimate = s.cu;
  withLock(ws, 'contract_networks', () => {
    const cur = rpc.readNetworks(ws);
    replaceFile(ws, ws.abs(rpc.NETWORKS_REL), jsonText({ schema_version: 'cr.contract-networks.v1', networks: { ...cur.networks, [id]: rec } }));
  });
  return { chain_id: id, ...rec, supported: rpc.networkSupport(ws, id).supported };
}

// ---------------------------------------------------------------------------
// The job (inside the forensics job, on the server's 30-minute timer). Off
// until Eric turns contracts.enabled on and sets both compute-unit caps.

function watched(ws, pid) {
  try {
    const T = require('./tickets');
    return Boolean(T.readTicketProfile(ws, pid).pilot);
  } catch (_) {
    return false;
  }
}

function dueProjects(ws, now) {
  const cfg = cfgOf(ws);
  const out = [];
  for (const p of require('./projects').listProjects(ws)) {
    if (p.broken || p.status === 'archived') continue;
    const subjects = subjectsOf(p).filter((s) => rpc.networkSupport(ws, s.chain_id).supported);
    if (!subjects.length) continue;
    const st = readStatus(ws, p.project_id);
    if (st.next_attempt_at && Date.parse(st.next_attempt_at) > now) continue;
    const every = (watched(ws, p.project_id) ? cfg.watch_interval_hours : cfg.baseline_interval_hours) * 3600000;
    const stale = subjects.some((s) => {
      const cur = st.subjects[subjectKey(s)];
      return !cur || !cur.observed_at || now - Date.parse(cur.observed_at) >= every;
    });
    if (stale) out.push(p.project_id);
  }
  return out.slice(0, cfg.max_projects_per_run);
}

function scheduledOff(ws) {
  const c = (ws.settings && ws.settings.contracts) || {};
  if (c.enabled !== true) return 'Contract observations are off (contracts.enabled).';
  const caps = rpc.capsOf(ws);
  if (!caps.set) return caps.why;
  try { if (require('./research').restoredHold(ws)) return 'This is a restored copy.'; } catch (_) { /* not held */ }
  return null;
}

function isDue(ws, now = Date.now()) {
  if (scheduledOff(ws)) return false;
  if (!rpc.gateOf(rpc.readState(ws), now).open) return false;
  return dueProjects(ws, now).length > 0;
}

async function refresh(ws, { trigger = 'scheduler', fetchImpl = null, key = undefined, sourceImpl = sourcifyGet, now = Date.now } = {}) {
  const off = scheduledOff(ws);
  if (off) return { status: 'skipped', message: off };
  const clock = typeof now === 'function' ? now : () => now;
  const due = dueProjects(ws, clock());
  if (!due.length) return { status: 'noop', message: 'No contract observation due.' };
  let saved = 0;
  let stopped = null;
  for (const pid of due) {
    const r = await observeProject(ws, pid, { fetchImpl, key, sourceImpl, now: clock, trigger });
    saved += r.results.filter((x) => x.status === 'saved').length;
    if (r.stopped) { stopped = r.stopped; break; }
  }
  return { status: stopped ? (stopped.kind === 'rate_limited' ? 'backoff' : 'attention') : 'ok', message: `Contract observations: ${saved} saved${stopped ? `; stopped: ${stopped.words}` : ''}.` };
}

// ---------------------------------------------------------------------------
// The read-only view (Contract tab, inspector, contracts show). Never asks.

function ageHours(iso, now) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.round(((now - t) / 3600000) * 10) / 10) : null;
}

function view(ws, project, now = Date.now()) {
  const p = typeof project === 'string' ? require('./projects').getProject(ws, project) : project;
  const pid = p.project_id;
  const subjects = subjectsOf(p);
  const st = readStatus(ws, pid);
  const cfg = cfgOf(ws);
  if (p.identity && p.identity.native_chain === true) return { state: 'native_chain', words: 'Native coin: no token contract.', subjects: [] };
  if (!subjects.length) return { state: 'no_contract', words: p.identity && p.identity.status === 'verified' ? 'No contract the desk reads on this identity.' : 'Identity pending: nothing is observed until it is confirmed.', subjects: [] };
  const rows = subjects.map((s) => {
    const cur = st.subjects[subjectKey(s)];
    const support = rpc.networkSupport(ws, s.chain_id);
    if (!cur || !cur.current) return { chain_id: s.chain_id, label: s.label, address: s.address, state: support.supported ? 'not_observed' : support.reason, words: support.supported ? 'Not observed yet.' : support.words };
    const r = readObservation(ws, pid, cur.current);
    if (!r.ok) return { chain_id: s.chain_id, label: s.label, address: s.address, state: 'unreadable', words: r.words };
    const o = r.observation;
    const age = ageHours(o.block.timestamp || o.retrieved.finished_at, now);
    return {
      chain_id: s.chain_id,
      label: s.label,
      address: s.address,
      state: age !== null && age <= cfg.ttl_hours ? 'fresh' : 'stale',
      age_hours: age,
      observation_id: o.observation_id,
      identity_key: o.identity_key,
      block: o.block,
      token: o.token,
      proxy: o.proxy,
      source: o.source,
      authorities: o.authorities.map((a) => ({ capability: a.capability, capability_words: CAPABILITIES[a.capability], function: a.function, class: a.class, class_words: CLASS_WORDS[a.class], words: a.words, proof: a.proof, path: a.path })),
      supply: o.supply,
      flags: o.flags || null,
      transfer_fee: o.transfer_fee || null,
      coverage: o.coverage,
      errors: o.errors,
      transitions: (cur.transitions || []).slice(-5),
    };
  });
  return { state: rows.some((r) => r.observation_id) ? 'observed' : 'not_observed', ttl_hours: cfg.ttl_hours, last_attempt: st.last_attempt || null, subjects: rows, words: 'What the chain showed at each block; never called safe.' };
}

// Every stored observation of a project, for the portable export.
function exportOf(ws, pid) {
  const dir = ws.abs(`${baseRel(pid)}/observations`);
  const ids = require('./fsx').listDir(dir).filter((n) => /^co_[0-9a-f]{16}\.json$/.test(n)).map((n) => n.slice(0, -5)).sort();
  return {
    status: readStatus(ws, pid),
    observations: ids.map((id) => {
      const r = readObservation(ws, pid, id);
      return r.ok ? r.observation : { observation_id: id, unreadable: r.words };
    }),
  };
}

// The desk-wide status (contracts status): caps, budget used, the gate,
// networks, and what each network leaves unread.
function deskStatus(ws, now = Date.now()) {
  const st = rpc.readState(ws);
  const nets = rpc.readNetworks(ws);
  const cfg = (ws.settings && ws.settings.contracts) || {};
  const unsupported = [];
  for (const p of require('./projects').listProjects(ws)) {
    if (p.broken || p.status === 'archived') continue;
    for (const s of subjectsOf(p)) {
      const sup = rpc.networkSupport(ws, s.chain_id);
      if (!sup.supported) unsupported.push({ project_id: p.project_id, chain_id: s.chain_id, label: s.label, reason: sup.reason });
    }
  }
  return {
    rpc: rpc.VERSION,
    observation: VERSION,
    enabled: cfg.enabled === true,
    caps: rpc.capsOf(ws),
    used: st.calls || null,
    gate: rpc.gateOf(st, now),
    networks: Object.fromEntries(Object.keys(rpc.HOSTS).map((id) => [id, { ...rpc.networkSupport(ws, id), record: nets.networks[id] || null }])),
    unsupported,
  };
}

module.exports = {
  VERSION, SCHEMA, IDENTITY_VERSION, JSON_VERSION, PROBE_VERSION, PROBE_CODE, PROBE_CODE_HASH, RANDOM_CALLER, factoriesOf, marketFor, obsPath: obsRel, SLOTS, READS, TOPICS, ROLES, CAPABILITIES, SIGNATURES, SELECTOR_CAP, CLASS_WORDS, SOL,
  canonicalJson, codeKind, scanCode, withoutMetadata, surfaceOf, identityKeyOf, subjectsOf, observeProject, probeNetwork, dryRun,
  readObservation, readCode, readStatus, view, deskStatus, exportOf, isDue, refresh, sourcifyGet, decString, decAddressArray,
};
