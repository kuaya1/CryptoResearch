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

function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}
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

async function observeEvm(session, subject, { ws, sourceImpl, now, prev }) {
  const ctx = { cfg: cfgOf(ws), chain_id: subject.chain_id, sourceImpl, code: new Map() };
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
  const obs = { block, proxy: null, source: null, surface: null, authorities: [], roles: { enumeration: 'unknown' }, supply: null };
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
        const c = await resolveController(rd, owner, 1, ctx);
        res = { ...c, path: [{ address: owner, node: 'owner', via: 'owner()' }, ...c.path] };
      } else res = { class: 'K6', path: [], words: accessControl ? 'Guarded by roles the desk cannot attribute to this function.' : 'No owner or role answered: the guard is not known.' };
      obs.authorities.push({ capability: cap, function: fn, path: res.path, class: res.class, delay_hours: res.delay_hours === undefined ? null : res.delay_hours, proof: 'state_read', random_caller: 'not_tried', coverage: 'partial', words: res.words });
    }
    if (obs.roles.enumeration === 'pending') obs.roles.enumeration = 'enumerable';
    if (!accessControl) obs.roles.enumeration = 'none';

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
  missing.push('authority_probe');
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
      errors: rd.errors,
      coverage: { complete: false, missing: [...new Set(missing)].sort(), words: 'Authorities rest on state reads; the authority and effect probes are not run in this version.' },
      retrieved: { started_at: started, finished_at: new Date(now()).toISOString() },
    },
    code: ctx.code,
  };
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
  return out;
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
      if (prev.ok && prev.observation.identity_key !== kept.identity_key) {
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
          ? await observeEvm(session, s, { ws, sourceImpl, now: clock, prev: prev && prev.ok ? prev.observation : null })
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
  VERSION, SCHEMA, IDENTITY_VERSION, JSON_VERSION, SLOTS, READS, TOPICS, ROLES, CAPABILITIES, SIGNATURES, SELECTOR_CAP, CLASS_WORDS, SOL,
  canonicalJson, codeKind, scanCode, withoutMetadata, surfaceOf, identityKeyOf, subjectsOf, observeProject, probeNetwork, dryRun,
  readObservation, readCode, readStatus, view, deskStatus, exportOf, isDue, refresh, sourcifyGet, decString, decAddressArray,
};
