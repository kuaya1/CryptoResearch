'use strict';
// Pillar 1, PR A: contract state observations (keccak.js, contract-rpc.js,
// contract-forensics.js). FICTIONAL temporary workspaces; every chain answer
// comes from a fictional node in this file (no network, no key, no provider).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempWorkspace } = require('./helpers');
const K = require('../core/keccak');
const rpc = require('../core/contract-rpc');
const CF = require('../core/contract-forensics');
const projects = require('../core/projects');

const KEY = 'FICTIONALkey_0123456789';
const NOW = Date.parse('2026-10-30T12:00:00Z');
const clock = () => NOW;
const CAPS = { contracts: { daily_cu_cap: 100000, monthly_cu_cap: 1000000 } };

// ---------------------------------------------------------------------------
// Keccak-256

test('keccak256: published vectors, and it is not FIPS SHA3-256', () => {
  assert.equal(K.keccak256(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(K.keccak256('abc'), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  // The Keccak team's 1600-bit vector: 200 bytes of 0xa3.
  assert.equal(K.keccak256(Buffer.alloc(200, 0xa3)), '0x3a57666b048777f2c953dc4456f45a2588e1cb6f2da760122d530ac2ce607d4a');
  // A message across the 136-byte rate boundary is absorbed in two blocks.
  assert.equal(K.keccak256(Buffer.alloc(136, 0)).length, 66);
  assert.notEqual(K.keccak256('').slice(2), require('crypto').createHash('sha3-256').update('').digest('hex'));
  assert.equal(K.keccak256Hex('0x'), K.keccak256(''));
});

test('every slot, selector and topic is derived from its preimage and matches the published value', () => {
  assert.equal(CF.SLOTS.implementation, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc');
  assert.equal(CF.SLOTS.admin, '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103');
  assert.equal(CF.SLOTS.beacon, '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50');
  assert.equal(CF.SLOTS.eip1822, '0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7');
  assert.equal(CF.SLOTS.oz_legacy, '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3');
  assert.equal(CF.READS['owner()'], '0x8da5cb5b');
  assert.equal(CF.READS['totalSupply()'], '0x18160ddd');
  assert.equal(CF.READS['getThreshold()'], '0xe75235b8');
  assert.equal(K.selector('upgradeToAndCall(address,bytes)'), '0x4f1ef286');
  assert.equal(K.selector('mint(address,uint256)'), '0x40c10f19');
  assert.equal(CF.TOPICS.Transfer, '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
  assert.equal(CF.TOPICS.Upgraded, '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b');
  assert.equal(CF.ROLES.MINTER_ROLE, '0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6');
  // CREATE2: EIP-1014's first example.
  assert.equal(K.create2Address('0x0000000000000000000000000000000000000000', `0x${'0'.repeat(64)}`, K.keccak256Hex('0x00')), '0x4d1a2e2bb4f88f0250f26ffff098b0b30b26bf38');
});

// ---------------------------------------------------------------------------
// The read-only boundary

test('the method allowlist refuses every write, sign and wallet method before a request is built', () => {
  for (const m of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'eth_signTypedData_v4', 'personal_sign', 'wallet_addEthereumChain', 'wallet_sendCalls', 'eth_accounts', 'debug_traceCall']) {
    assert.throws(() => rpc.assertReadMethod(m), (e) => e.code === 'REFUSED', m);
  }
  for (const m of ['eth_chainId', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getCode', 'eth_getStorageAt', 'eth_call', 'eth_getLogs', 'getAccountInfo', 'getMultipleAccounts']) rpc.assertReadMethod(m);
  assert.deepEqual(rpc.pin(`0x${'ab'.repeat(32)}`), { blockHash: `0x${'ab'.repeat(32)}`, requireCanonical: true });
  assert.throws(() => rpc.pinnedParams('eth_getCode', ['0xabc', 'latest'], `0x${'ab'.repeat(32)}`), /takes no block of its own/);
});

test('a session refused for a write method sends nothing', async (t) => {
  const s = setup(t);
  const node = fakeNode(plainToken());
  const session = rpc.openSession(s.ws, { chainId: '8453', fetchImpl: node.fetch, key: KEY, now: clock });
  await assert.rejects(session.call('eth_sendRawTransaction', ['0x00']), (e) => e.code === 'REFUSED');
  assert.equal(node.calls.length, 0);
});

// ---------------------------------------------------------------------------
// A fictional EVM node

const ADDR = (n) => `0x${String(n).padStart(40, '0')}`;
const W = (x) => BigInt(x).toString(16).padStart(64, '0');
const A = (a) => a.slice(2).toLowerCase().padStart(64, '0');
const ret = (...words) => `0x${words.join('')}`;
const addrArray = (list, extraHead = []) => ret(W(32 * (1 + extraHead.length)), ...extraHead, W(list.length), ...list.map(A));
const sel = (sig) => K.selector(sig);
const BLOCK = { number: 1000, hash: `0x${'b1'.repeat(32)}`, timestamp: Math.floor(NOW / 1000) - 900 };
const TOKEN = ADDR('a1');
const EOA = ADDR('e0a');
const fn = (name, inputs = [], stateMutability = 'nonpayable') => ({ type: 'function', name, inputs: inputs.map((type) => ({ type })), stateMutability });
const ERC20 = [fn('transfer', ['address', 'uint256']), fn('approve', ['address', 'uint256']), fn('balanceOf', ['address'], 'view')];

// Code with the given selectors as PUSH4s, no DELEGATECALL; or a proxy body.
const codeWith = (...sigs) => `0x6080604052${sigs.map((s) => `63${sel(s).slice(2)}`).join('')}00`;
const PROXY_CODE = '0x6080604036600080375af43d6000803e00'.replace('5af4', '5af4');

// A node answering from `state`: accounts { address: { code, storage, calls } }
// at the finalized block, `latest` overrides, `logs`, and faults.
function fakeNode(state) {
  const calls = [];
  const violations = [];
  const block = state.block || BLOCK;
  let reorgs = state.reorgs || 0;
  const reply = (id, body, status = 200, headers = {}) => ({ status, ok: status < 400, headers: { get: (k) => headers[k.toLowerCase()] || null }, text: async () => JSON.stringify({ jsonrpc: '2.0', id, ...body }) });
  const acct = (a, latest) => {
    const base = (state.accounts || {})[a.toLowerCase()] || {};
    if (!latest || !state.latest || !state.latest[a.toLowerCase()]) return base;
    return { ...base, ...state.latest[a.toLowerCase()], storage: { ...(base.storage || {}), ...(state.latest[a.toLowerCase()].storage || {}) } };
  };
  const checkPin = (m, ref, allowLatest) => {
    if (ref === 'latest' && allowLatest) return true;
    if (!ref || ref.blockHash !== block.hash || ref.requireCanonical !== true) { violations.push(m); return false; }
    return true;
  };
  async function fetch(url, init) {
    const body = JSON.parse(init.body);
    const { id, method, params } = body;
    calls.push({ url, method, params });
    const fault = state.fault ? state.fault(calls.length, method, params) : null;
    if (fault) return fault(id, reply);
    switch (method) {
      case 'eth_chainId': return reply(id, { result: `0x${BigInt(state.chainId || 8453).toString(16)}` });
      case 'eth_getBlockByNumber': {
        if (params[0] === 'finalized') return reply(id, { result: { number: `0x${block.number.toString(16)}`, hash: block.hash, timestamp: `0x${block.timestamp.toString(16)}` } });
        const canonical = reorgs > 0 ? (reorgs--, `0x${'c0'.repeat(32)}`) : block.hash;
        return reply(id, { result: { number: params[0], hash: canonical } });
      }
      case 'eth_getCode': if (!checkPin(method, params[1], false)) return reply(id, { error: { code: -32000, message: 'pin missing' } }); return reply(id, { result: acct(params[0]).code || '0x' });
      case 'eth_getStorageAt': {
        if (!checkPin(method, params[2], true)) return reply(id, { error: { code: -32000, message: 'pin missing' } });
        if (state.storageFails && state.storageFails(params[0], params[1])) return reply(id, { error: { code: -32603, message: 'internal error' } });
        const st = acct(params[0], params[2] === 'latest').storage || {};
        return reply(id, { result: `0x${(st[params[1]] || W(0))}` });
      }
      case 'eth_call': {
        if (!checkPin(method, params[1], true)) return reply(id, { error: { code: -32000, message: 'pin missing' } });
        const a = acct(params[0].to, params[1] === 'latest');
        const h = (a.calls || {})[params[0].data.slice(0, 10)];
        const out = typeof h === 'function' ? h(params[0].data) : h;
        return out === undefined || out === null ? reply(id, { error: { code: 3, message: 'execution reverted' } }) : reply(id, { result: out });
      }
      case 'eth_getLogs': return reply(id, { result: state.logs ? state.logs(params[0]) : [] });
      default: return reply(id, { error: { code: -32601, message: `method ${method} not served by the fictional node` } });
    }
  }
  return { fetch, calls, violations };
}

const tokenCalls = (extra = {}) => ({ [sel('decimals()')]: ret(W(18)), [sel('totalSupply()')]: ret(W(1000000n * 10n ** 18n)), [sel('name()')]: ret(W(32), W(17), Buffer.from('Example FICTIONAL').toString('hex').padEnd(64, '0')), [sel('symbol()')]: ret(W(32), W(4), Buffer.from('XFIC').toString('hex').padEnd(64, '0')), ...extra });
const safe = (threshold, owners, { modules = [], singletonHash = 'allowed', guard = null } = {}) => ({
  code: '0x608060405273ffff',
  storage: { [CF.SLOTS.safe_singleton]: A(ADDR('5a1')), ...(guard ? { [CF.SLOTS.safe_guard]: A(guard) } : {}) },
  calls: { [sel('getThreshold()')]: ret(W(threshold)), [sel('getOwners()')]: addrArray(owners), [sel('getModulesPaginated(address,uint256)')]: addrArray(modules, [A(ADDR(1))]) },
  _singleton: singletonHash,
});
const SINGLETON_CODE = '0x60806040526004361061fffe';
const SINGLETON_HASH = K.keccak256Hex(SINGLETON_CODE);

// Fixture: a plain token, Ownable by an EOA, with mint.
function plainToken() {
  return { accounts: { [TOKEN]: { code: codeWith('mint(address,uint256)', 'transfer(address,uint256)'), calls: tokenCalls({ [sel('owner()')]: ret(A(EOA)) }) }, [EOA]: {} } };
}

function setup(t, settings = CAPS) {
  const w = tempWorkspace('contracts', settings);
  t.after(w.cleanup);
  const pid = projects.addProject(w.ws, { name: 'Example Token (FICTIONAL)', symbol: 'XFIC', official_website: 'https://xfic.example.org/', coingecko_id: 'xfic-fictional', evidence: [{ url: 'https://xfic.example.org/', note: 'fictional' }], assets: [{ chain: 'base', contract_address: TOKEN }] }).project_id;
  return { ...w, pid };
}

// Sourcify answers: an ABI only for code that matches.
function sources(map) {
  return async (chainId, address) => {
    const s = map[address.toLowerCase()];
    if (!s) return { status: 'unverified' };
    return { status: 'verified_full', abi: s.abi, contract_name: s.name, compiler: 'v0.8.FICTIONAL', runtime_code_hash: K.keccak256Hex(s.code) };
  };
}

async function probeAndObserve(s, state, { src = {}, settings = null, now = clock } = {}) {
  if (settings) s.ws.settings = { ...s.ws.settings, contracts: { ...s.ws.settings.contracts, ...settings } };
  const node = fakeNode(state);
  await CF.probeNetwork(s.ws, '8453', { fetchImpl: node.fetch, key: KEY, now });
  node.calls.length = 0;
  const r = await CF.observeProject(s.ws, s.pid, { fetchImpl: node.fetch, key: KEY, sourceImpl: sources(src), now });
  const res = r.results[0];
  const obs = res && res.observation_id ? CF.readObservation(s.ws, s.pid, res.observation_id).observation : null;
  return { r, res, obs, node };
}
const authOf = (obs, cap) => obs.authorities.find((a) => a.capability === cap);

// ---------------------------------------------------------------------------
// The fixtures

test('caps unset: nothing is sent, and a dry run plans the reads with zero transport calls', async (t) => {
  const s = setup(t, {});
  const node = fakeNode(plainToken());
  await assert.rejects(CF.probeNetwork(s.ws, '8453', { fetchImpl: node.fetch, key: KEY, now: clock }), (e) => e.kind === 'caps_unset');
  const dry = await CF.observeProject(s.ws, s.pid, { dryRun: true, fetchImpl: node.fetch });
  assert.equal(dry.sent, 0);
  assert.ok(dry.subjects[0].base_requests > 0 && dry.subjects[0].base_cu > 0);
  assert.match(dry.words, /Nothing was sent/);
  assert.equal(node.calls.length, 0, 'zero transport calls');
  assert.ok(!fs.existsSync(s.ws.abs(rpc.STATE_REL)), 'no counter written');
});

test('a plain token: no proxy, its mint controlled by an EOA owner (K5), every state read pinned to the finalized block hash', async (t) => {
  const s = setup(t);
  const { res, obs, node } = await probeAndObserve(s, plainToken());
  assert.equal(res.status, 'saved');
  assert.deepEqual(node.violations, [], 'every eth_getCode, eth_getStorageAt and eth_call carried the EIP-1898 pin or the labeled latest');
  assert.equal(obs.block.hash, BLOCK.hash);
  assert.equal(obs.proxy.kind, 'none');
  assert.equal(obs.proxy.supported, true);
  assert.equal(obs.surface.basis, 'selectors');
  assert.equal(obs.surface.source, 'unverified');
  const c2 = authOf(obs, 'C2');
  assert.equal(c2.class, 'K5');
  assert.equal(c2.proof, 'state_read');
  assert.equal(obs.token.symbol, 'XFIC');
  assert.equal(obs.token.total_supply, (1000000n * 10n ** 18n).toString());
  assert.ok(obs.coverage.missing.includes('authority_probe') && obs.coverage.missing.includes('verified_source'));
  assert.match(obs.identity_key, /^sha256:[0-9a-f]{64}$/);
  // The code is stored once under its Keccak-256, re-hashed on read.
  assert.equal(CF.readCode(s.ws, s.pid, obs.token.code_hash).ok, true);
  assert.equal(res.requests, node.calls.length);
  assert.ok(res.cu_estimate > 0);
});

test('a transparent proxy behind a verified ProxyAdmin owned by a Safe 2 of 3 is K3; the same Safe off the allowlist is K6', async (t) => {
  const IMPL = ADDR('1a1');
  const PA = ADDR('9a');
  const SAFE = ADDR('5af3');
  const implCode = codeWith('mint(address,uint256)');
  const paCode = '0x60806040526004fe';
  const state = (allow) => ({
    accounts: {
      [TOKEN]: { code: PROXY_CODE, storage: { [CF.SLOTS.implementation]: A(IMPL), [CF.SLOTS.admin]: A(PA) }, calls: tokenCalls() },
      [IMPL]: { code: implCode },
      [PA]: { code: paCode, calls: { [sel('owner()')]: ret(A(SAFE)) } },
      [SAFE]: safe(2, [ADDR('o1'), ADDR('o2'), ADDR('o3')]),
      [ADDR('5a1')]: { code: allow ? SINGLETON_CODE : '0x6001' },
    },
  });
  const src = { [PA]: { code: paCode, name: 'ProxyAdmin', abi: [] } };
  const s = setup(t, { contracts: { ...CAPS.contracts, safe_singleton_code_hashes: [SINGLETON_HASH] } });
  const { obs } = await probeAndObserve(s, state(true), { src });
  assert.equal(obs.proxy.kind, 'erc1967_transparent');
  assert.equal(obs.proxy.implementation.address, IMPL);
  const c1 = authOf(obs, 'C1');
  assert.equal(c1.class, 'K3', c1.words);
  assert.deepEqual(c1.path.map((p) => p.node), ['erc1967_admin', 'proxy_admin', 'safe']);
  assert.equal(c1.path[2].threshold, 2);
  assert.equal(c1.path[2].owners, 3);
  assert.equal(c1.path[2].modules, 0);
  assert.equal(obs.block.latest_slots_match, true);
  const s2 = setup(t);
  const off = await probeAndObserve(s2, state(true), { src });
  assert.equal(authOf(off.obs, 'C1').class, 'K6');
  assert.match(authOf(off.obs, 'C1').words, /allowlist/);
});

test('UUPS with an EOA owner is K5 for upgrade; a beacon proxy follows the beacon\'s owner', async (t) => {
  const IMPL = ADDR('1a2');
  const s = setup(t);
  const { obs } = await probeAndObserve(s, {
    accounts: {
      [TOKEN]: { code: PROXY_CODE, storage: { [CF.SLOTS.implementation]: A(IMPL) }, calls: tokenCalls({ [sel('owner()')]: ret(A(EOA)) }) },
      [IMPL]: { code: codeWith('upgradeToAndCall(address,bytes)', 'transfer(address,uint256)') },
      [EOA]: {},
    },
  });
  assert.equal(obs.proxy.kind, 'erc1967_uups');
  assert.equal(authOf(obs, 'C1').class, 'K5');
  const BEACON = ADDR('bea');
  const s2 = setup(t);
  const b = await probeAndObserve(s2, {
    accounts: {
      [TOKEN]: { code: PROXY_CODE, storage: { [CF.SLOTS.beacon]: A(BEACON) }, calls: tokenCalls() },
      [BEACON]: { code: '0x6080604052600a', calls: { [sel('implementation()')]: ret(A(IMPL)), [sel('owner()')]: ret(A(EOA)) } },
      [IMPL]: { code: codeWith('transfer(address,uint256)') },
      [EOA]: {},
    },
  });
  assert.equal(b.obs.proxy.kind, 'erc1967_beacon');
  assert.equal(b.obs.proxy.implementation.address, IMPL);
  assert.equal(authOf(b.obs, 'C1').class, 'K5');
  assert.deepEqual(authOf(b.obs, 'C1').path.map((p) => p.node), ['beacon', 'eoa']);
});

test('an EIP-1167 clone is supported with its fixed implementation; a diamond and a nonstandard DELEGATECALL are unsupported', async (t) => {
  const IMPL = ADDR('1a3');
  const s = setup(t);
  const clone = await probeAndObserve(s, { accounts: { [TOKEN]: { code: `0x363d3d373d3d3d363d73${IMPL.slice(2)}5af43d82803e903d91602b57fd5bf3`, calls: tokenCalls() }, [IMPL]: { code: codeWith('transfer(address,uint256)') } } });
  assert.equal(clone.obs.proxy.kind, 'eip1167_minimal');
  assert.equal(clone.obs.proxy.supported, true);
  assert.equal(clone.obs.proxy.implementation.address, IMPL);
  const s2 = setup(t);
  const diamond = await probeAndObserve(s2, { accounts: { [TOKEN]: { code: codeWith('facets()', 'transfer(address,uint256)'), calls: tokenCalls() } } });
  assert.equal(diamond.obs.proxy.kind, 'diamond');
  assert.equal(diamond.obs.proxy.supported, false);
  const s3 = setup(t);
  const dc = await probeAndObserve(s3, { accounts: { [TOKEN]: { code: PROXY_CODE, calls: tokenCalls() } } });
  assert.equal(dc.obs.proxy.kind, 'nonstandard_delegatecall');
  assert.equal(dc.obs.proxy.supported, false);
  assert.match(dc.obs.proxy.words, /not one the desk reads/);
  // DELEGATECALL inside a PUSH immediate or the metadata trailer is not code.
  assert.equal(CF.scanCode('0x60f400').delegatecall, false);
  assert.equal(CF.scanCode(`0x6000${'a165627a7a72305820'}${'00'.repeat(32)}0029`).delegatecall, false);
});

test('a proxy pointing to empty code is unsupported; an unverified implementation is labeled and its source missing', async (t) => {
  const IMPL = ADDR('1a4');
  const s = setup(t);
  const { obs } = await probeAndObserve(s, { accounts: { [TOKEN]: { code: PROXY_CODE, storage: { [CF.SLOTS.implementation]: A(IMPL), [CF.SLOTS.admin]: A(EOA) }, calls: tokenCalls() }, [IMPL]: { code: '0x' } } });
  assert.equal(obs.proxy.supported, false);
  assert.match(obs.proxy.words, /no contract code/);
  const s2 = setup(t);
  const IMPL2 = ADDR('1a5');
  const implCode = codeWith('setFee(uint256)');
  const u = await probeAndObserve(s2, { accounts: { [TOKEN]: { code: PROXY_CODE, storage: { [CF.SLOTS.implementation]: A(IMPL2), [CF.SLOTS.admin]: A(EOA) }, calls: tokenCalls({ [sel('owner()')]: ret(A(EOA)) }) }, [IMPL2]: { code: implCode }, [EOA]: {} } });
  assert.equal(u.obs.source.status, 'unverified');
  assert.equal(u.obs.source.for, 'implementation');
  assert.ok(u.obs.coverage.missing.includes('verified_source'));
  assert.equal(authOf(u.obs, 'C5').class, 'K5');
  // Sourcify's ABI for other code is not used.
  const s3 = setup(t);
  const m = await probeAndObserve(s3, { accounts: { [TOKEN]: { code: PROXY_CODE, storage: { [CF.SLOTS.implementation]: A(IMPL2), [CF.SLOTS.admin]: A(EOA) }, calls: tokenCalls() }, [IMPL2]: { code: implCode }, [EOA]: {} } }, { src: { [IMPL2]: { code: '0x6001', abi: ERC20, name: 'Other' } } });
  assert.equal(m.obs.source.verified_code_hash_matches, false);
  assert.equal(m.obs.surface.basis, 'selectors');
});

test('controllers: an EIP-7702 admin is K5, a Safe 1 of 2 is K4, a Safe with a module is K6, a verified 72-hour timelock behind a Safe is K2', async (t) => {
  const IMPL = ADDR('1a6');
  const implCode = codeWith('transfer(address,uint256)');
  const withAdmin = (admin, extra, src) => ({ state: { accounts: { [TOKEN]: { code: PROXY_CODE, storage: { [CF.SLOTS.implementation]: A(IMPL), [CF.SLOTS.admin]: A(admin) }, calls: tokenCalls() }, [IMPL]: { code: implCode }, [ADDR('5a1')]: { code: SINGLETON_CODE }, ...extra } }, src });
  const allow = { contracts: { ...CAPS.contracts, safe_singleton_code_hashes: [SINGLETON_HASH] } };
  const D = ADDR('7702');
  let r = withAdmin(D, { [D]: { code: `0xef0100${ADDR('de1').slice(2)}` } });
  let o = (await probeAndObserve(setup(t, allow), r.state)).obs;
  assert.equal(authOf(o, 'C1').class, 'K5');
  assert.equal(authOf(o, 'C1').path[1].node, 'eip7702_delegated');
  const S1 = ADDR('5af1');
  o = (await probeAndObserve(setup(t, allow), withAdmin(S1, { [S1]: safe(1, [ADDR('o1'), ADDR('o2')]) }).state)).obs;
  assert.equal(authOf(o, 'C1').class, 'K4');
  const SM = ADDR('5af2');
  o = (await probeAndObserve(setup(t, allow), withAdmin(SM, { [SM]: safe(2, [ADDR('o1'), ADDR('o2')], { modules: [ADDR('m0d')] }) }).state)).obs;
  assert.equal(authOf(o, 'C1').class, 'K6');
  assert.match(authOf(o, 'C1').words, /module/);
  const TL = ADDR('71c');
  const tlCode = '0x6080604052600c';
  r = withAdmin(TL, { [TL]: { code: tlCode, calls: { [sel('getMinDelay()')]: ret(W(72 * 3600)) } } });
  o = (await probeAndObserve(setup(t, allow), r.state, { src: { [TL]: { code: tlCode, name: 'TimelockController', abi: [] } } })).obs;
  assert.equal(authOf(o, 'C1').class, 'K2');
  assert.equal(authOf(o, 'C1').delay_hours, 72);
  // The same delay without verified source is not recognized.
  o = (await probeAndObserve(setup(t, allow), r.state)).obs;
  assert.equal(authOf(o, 'C1').class, 'K6');
});

test('AccessControl: an empty MINTER_ROLE administered by an EOA DEFAULT_ADMIN_ROLE is unconstrained mint authority', async (t) => {
  const s = setup(t);
  const roleCalls = {
    [sel('getRoleAdmin(bytes32)')]: () => ret(W(0)),
    [sel('getRoleMemberCount(bytes32)')]: (data) => ret(W(data.slice(10) === W(0) ? 1 : 0)),
    [sel('getRoleMember(bytes32,uint256)')]: () => ret(A(EOA)),
  };
  const { obs } = await probeAndObserve(s, { accounts: { [TOKEN]: { code: codeWith('mint(address,uint256)', 'hasRole(bytes32,address)'), calls: tokenCalls(roleCalls) }, [EOA]: {} } });
  const c2 = authOf(obs, 'C2');
  assert.equal(c2.class, 'K5', c2.words);
  assert.ok(c2.path.some((p) => p.node === 'role_admin'));
  assert.equal(obs.roles.enumeration, 'enumerable');
});

test('an implementation swap between two finalized blocks is a transition with its bracket blocks', async (t) => {
  const s = setup(t);
  const I1 = ADDR('1b1');
  const I2 = ADDR('1b2');
  const st = (impl, block) => ({ block, accounts: { [TOKEN]: { code: PROXY_CODE, storage: { [CF.SLOTS.implementation]: A(impl), [CF.SLOTS.admin]: A(EOA) }, calls: tokenCalls() }, [I1]: { code: codeWith('transfer(address,uint256)') }, [I2]: { code: codeWith('transfer(address,uint256)', 'mint(address,uint256)') }, [EOA]: {} } });
  const first = await probeAndObserve(s, st(I1, BLOCK));
  const B2 = { number: 1300, hash: `0x${'b2'.repeat(32)}`, timestamp: BLOCK.timestamp + 3600 };
  const node = fakeNode(st(I2, B2));
  const r = await CF.observeProject(s.ws, s.pid, { fetchImpl: node.fetch, key: KEY, sourceImpl: sources({}), now: () => NOW + 3600000 });
  assert.equal(r.results[0].status, 'saved');
  assert.notEqual(r.results[0].identity_key, first.res.identity_key);
  const tr = CF.readStatus(s.ws, s.pid).subjects[`8453:${TOKEN}`].transitions;
  assert.equal(tr.length, 1);
  assert.deepEqual(tr[0].between, { from: 1000, to: 1300 });
  assert.ok(tr[0].changes.some((c) => c.field === 'proxy.implementation' && c.from === I1 && c.to === I2));
  // Same block again: the same observation, unchanged, no transition.
  const again = await CF.observeProject(s.ws, s.pid, { fetchImpl: fakeNode(st(I2, B2)).fetch, key: KEY, sourceImpl: sources({}), now: () => NOW + 3600000 });
  assert.equal(again.results[0].status, 'unchanged');
});

test('a slot at latest that differs from the finalized one is latest_slots_match: false', async (t) => {
  const s = setup(t);
  const I1 = ADDR('1c1');
  const { obs } = await probeAndObserve(s, { accounts: { [TOKEN]: { code: PROXY_CODE, storage: { [CF.SLOTS.implementation]: A(I1), [CF.SLOTS.admin]: A(EOA) }, calls: tokenCalls() }, [I1]: { code: codeWith('transfer(address,uint256)') }, [EOA]: {} }, latest: { [TOKEN]: { storage: { [CF.SLOTS.implementation]: A(ADDR('1c2')) } } } });
  assert.equal(obs.block.latest_slots_match, false);
});

test('a reorg discards the observation and retries once at a new finalized block; two in a row write nothing', async (t) => {
  const s = setup(t);
  const once = await probeAndObserve(s, { ...plainToken(), reorgs: 1 });
  assert.equal(once.res.status, 'saved');
  const s2 = setup(t);
  const twice = await probeAndObserve(s2, { ...plainToken(), reorgs: 2 });
  assert.equal(twice.res.status, 'reorged');
  assert.ok(!fs.existsSync(s2.ws.abs(`projects/${s2.pid}/forensics/contracts/observations`)) || !fs.readdirSync(s2.ws.abs(`projects/${s2.pid}/forensics/contracts/observations`)).length, 'nothing partial written');
});

test('a 429 mid-observation writes nothing, keeps the gate with Retry-After, and the key appears nowhere', async (t) => {
  const s = setup(t);
  let n = 0;
  const state = { ...plainToken(), fault: (i, method) => (method === 'eth_getStorageAt' && ++n === 3 ? (id, reply) => reply(id, {}, 429, { 'retry-after': '120' }) : null) };
  const { res, r } = await probeAndObserve(s, state);
  assert.equal(res.status, 'rate_limited');
  assert.equal(r.stopped.kind, 'rate_limited');
  assert.ok(!fs.existsSync(s.ws.abs(`projects/${s.pid}/forensics/contracts/observations`)));
  const gate = rpc.readState(s.ws);
  assert.equal(Date.parse(gate.retry_after_until), NOW + 120000);
  assert.equal(rpc.gateOf(gate, NOW).open, false);
  const files = [rpc.STATE_REL, rpc.NETWORKS_REL, `projects/${s.pid}/forensics/contracts/status.json`].map((rel) => fs.readFileSync(s.ws.abs(rel), 'utf8')).join('\n');
  assert.ok(!files.includes(KEY) && !JSON.stringify(r).includes(KEY), 'the key is in no file and no reply');
  // While the gate is closed nothing is sent.
  const node = fakeNode(plainToken());
  const again = await CF.observeProject(s.ws, s.pid, { fetchImpl: node.fetch, key: KEY, sourceImpl: sources({}), now: clock });
  assert.equal(again.results[0].status, 'rate_limited');
  assert.equal(node.calls.length, 0);
});

test('one failed eth_getStorageAt leaves the coverage incomplete with the read named', async (t) => {
  const s = setup(t);
  const { obs } = await probeAndObserve(s, { ...plainToken(), storageFails: (a, slot) => slot === CF.SLOTS.beacon });
  assert.ok(obs.coverage.missing.includes('slot_beacon'));
  assert.equal(obs.proxy.kind, 'unknown', 'a proxy slot that did not read is not "no proxy"');
  assert.ok(obs.errors.some((e) => /eth_getStorageAt slot_beacon/.test(e.read)));
});

test('supply that moved without matching mint or burn events is not explained', async (t) => {
  const s = setup(t);
  await probeAndObserve(s, plainToken());
  const B2 = { number: 1100, hash: `0x${'b3'.repeat(32)}`, timestamp: BLOCK.timestamp + 600 };
  const grown = plainToken();
  grown.block = B2;
  grown.accounts[TOKEN].calls[sel('totalSupply()')] = ret(W(1000500n * 10n ** 18n));
  grown.logs = (q) => (q.topics[1] ? [{ data: ret(W(100n * 10n ** 18n)) }] : []);
  const node = fakeNode(grown);
  const r = await CF.observeProject(s.ws, s.pid, { fetchImpl: node.fetch, key: KEY, sourceImpl: sources({}), now: clock });
  const obs = CF.readObservation(s.ws, s.pid, r.results[0].observation_id).observation;
  assert.equal(obs.supply.delta, (500n * 10n ** 18n).toString());
  assert.equal(obs.supply.mint_events_net, (100n * 10n ** 18n).toString());
  assert.equal(obs.supply.explained, false);
  assert.ok(node.calls.filter((c) => c.method === 'eth_getLogs').every((c) => c.params[0].fromBlock === '0x3e9' && c.params[0].toBlock === '0x44c'));
});

test('a restored copy sends nothing; the same fixture twice gives the same bytes', async (t) => {
  const s = setup(t);
  fs.writeFileSync(s.ws.abs('config/restored-copy.json'), JSON.stringify({ research_held: true }));
  const node = fakeNode(plainToken());
  await assert.rejects(CF.probeNetwork(s.ws, '8453', { fetchImpl: node.fetch, key: KEY, now: clock }), (e) => e.kind === 'held');
  assert.equal(node.calls.length, 0);
  const a = setup(t);
  const b = setup(t);
  // The two projects get different IDs; the observations differ only there.
  const x = (await probeAndObserve(a, plainToken())).obs;
  const y = (await probeAndObserve(b, plainToken())).obs;
  const strip = (o) => JSON.stringify({ ...o, subject: { ...o.subject, project_id: null }, token: { ...o.token, code_ref: null }, sha256: null });
  assert.equal(strip(x), strip(y));
  assert.equal(x.identity_key, y.identity_key);
});

test('reading writes nothing: view, contracts show and the project record', async (t) => {
  const s = setup(t);
  await probeAndObserve(s, plainToken());
  const snap = () => {
    const out = {};
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[p] = fs.readFileSync(p, 'utf8'); } };
    walk(s.root);
    return out;
  };
  const before = snap();
  const v = CF.view(s.ws, s.pid, NOW);
  assert.equal(v.state, 'observed');
  assert.equal(v.subjects[0].state, 'fresh');
  assert.equal(v.subjects[0].authorities[0].class_words, 'unconstrained (one key)');
  assert.ok(!JSON.stringify(v).match(/\b(is|looks|appears|considered) safe\b|"safe"/i), 'never called safe');
  const d = require('../core/indexer').projectDetail(s.ws, s.pid);
  assert.equal(d.contracts.subjects[0].observation_id, v.subjects[0].observation_id);
  CF.deskStatus(s.ws, NOW);
  assert.deepEqual(snap(), before);
  // A stored observation that no longer matches its SHA-256 is not shown.
  const rel = `projects/${s.pid}/forensics/contracts/observations/${v.subjects[0].observation_id}.json`;
  fs.appendFileSync(s.ws.abs(rel), ' ');
  const j = JSON.parse(fs.readFileSync(s.ws.abs(rel), 'utf8'));
  j.token.symbol = 'EDITED';
  fs.writeFileSync(s.ws.abs(rel), JSON.stringify(j));
  assert.equal(CF.view(s.ws, s.pid, NOW).subjects[0].state, 'unreadable');
});

test('a Solana mint: freeze authority, permanent delegate, a 2% transfer fee and an upgradeable hook program', async (t) => {
  const w = tempWorkspace('contracts-sol', CAPS);
  t.after(w.cleanup);
  const MINT = 'FiCTiona1Mint1111111111111111111111111111111';
  const pid = projects.addProject(w.ws, { name: 'Example Mint (FICTIONAL)', symbol: 'XSOL', official_website: 'https://xsol.example.org/', coingecko_id: 'xsol-fictional', evidence: [{ url: 'https://xsol.example.org/', note: 'fictional' }], assets: [{ chain: 'solana', contract_address: MINT }] }).project_id;
  const KEYS = { freeze: 'FiCTionaLFreeze11111111111111111111111111111', delegate: 'FiCTionaLDe1egate1111111111111111111111111', fee: 'FiCTionaLFee111111111111111111111111111111', hook: 'FiCTionaLHookProgram11111111111111111111111', data: 'FiCTionaLHookData11111111111111111111111111', up: 'FiCTionaLUpgrader1111111111111111111111111' };
  const calls = [];
  const ctxv = (value) => ({ context: { slot: 3141592 }, value });
  const fetchImpl = async (url, init) => {
    const { id, method, params } = JSON.parse(init.body);
    calls.push({ method, params });
    const reply = (result) => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: '2.0', id, result }) });
    if (params[1].commitment !== 'finalized') throw new Error('not finalized');
    if (method === 'getAccountInfo' && params[0] === CF.SOL.SPL) return reply(ctxv({ owner: 'BPFLoader2111111111111111111111111111111111' }));
    if (method === 'getAccountInfo' && params[0] === MINT) {
      return reply(ctxv({ owner: CF.SOL.TOKEN_2022, data: { parsed: { type: 'mint', info: { decimals: 6, supply: '5000000000', mintAuthority: null, freezeAuthority: KEYS.freeze, extensions: [
        { extension: 'transferFeeConfig', state: { transferFeeConfigAuthority: KEYS.fee, olderTransferFee: { epoch: 600, transferFeeBasisPoints: 0 }, newerTransferFee: { epoch: 612, transferFeeBasisPoints: 200 } } },
        { extension: 'permanentDelegate', state: { delegate: KEYS.delegate } },
        { extension: 'transferHook', state: { authority: null, programId: KEYS.hook } },
      ] } } } }));
    }
    if (method === 'getMultipleAccounts') return reply({ context: { slot: 3141592 }, value: params[0].map(() => ({ owner: CF.SOL.SYSTEM })) });
    if (method === 'getAccountInfo' && params[0] === KEYS.hook) return reply(ctxv({ owner: CF.SOL.UPGRADEABLE_LOADER, data: { parsed: { type: 'program', info: { programData: KEYS.data } } } }));
    if (method === 'getAccountInfo' && params[0] === KEYS.data) return reply(ctxv({ owner: CF.SOL.UPGRADEABLE_LOADER, data: { parsed: { type: 'programData', info: { authority: KEYS.up } } } }));
    throw new Error(`unexpected ${method}`);
  };
  await CF.probeNetwork(w.ws, 'solana', { fetchImpl, key: KEY, now: clock });
  const r = await CF.observeProject(w.ws, pid, { fetchImpl, key: KEY, now: clock });
  assert.equal(r.results[0].status, 'saved', JSON.stringify(r.results[0]));
  const o = CF.readObservation(w.ws, pid, r.results[0].observation_id).observation;
  assert.equal(o.block.slot, 3141592);
  assert.equal(o.token.program, 'token_2022');
  assert.deepEqual(o.transfer_fee, { older_bps: 0, newer_bps: 200, newer_epoch: 612 });
  const by = (c) => o.authorities.filter((a) => a.capability === c);
  assert.equal(by('C4')[0].class, 'K5');
  assert.equal(by('C3')[0].class, 'K5', 'a permanent delegate held by a key');
  assert.equal(by('C5')[0].class, 'K5');
  assert.equal(by('C2').length, 0, 'no mint authority');
  assert.equal(o.hook_program.upgrade_authority, KEYS.up);
  assert.ok(by('C6').some((a) => a.function === 'hook program upgrade'));
  assert.equal(o.flags.non_transferable, false);
});

test('settings: contract caps are validated, and no key or endpoint is ever accepted', () => {
  const { validateSettingsPatch } = require('../server');
  assert.deepEqual(validateSettingsPatch({ contracts: { daily_cu_cap: 50000, monthly_cu_cap: 1000000, enabled: true } }).contracts, { daily_cu_cap: 50000, monthly_cu_cap: 1000000, enabled: true });
  assert.throws(() => validateSettingsPatch({ contracts: { alchemy_key: 'x' } }), /never stored/);
  assert.throws(() => validateSettingsPatch({ contracts: { daily_cu_cap: 1500.5 } }), /whole number/);
  assert.throws(() => validateSettingsPatch({ contracts: { safe_singleton_code_hashes: ['0x12'] } }), /Keccak-256/);
  const w = tempWorkspace('contracts-defaults');
  try {
    assert.equal(w.ws.settings.contracts.enabled, false);
    assert.equal(w.ws.settings.contracts.daily_cu_cap, null);
    assert.equal(w.ws.settings.contracts.monthly_cu_cap, null);
    assert.deepEqual(w.ws.settings.contracts.safe_singleton_code_hashes, []);
    assert.equal(CF.isDue(w.ws, NOW), false, 'off by default');
  } finally { w.cleanup(); }
});

// ---------------------------------------------------------------------------
// The automatic network probe (caps set): a chain never probed is probed once.

const ON = { contracts: { ...CAPS.contracts, enabled: true } };
const netRecord = (ws) => rpc.readNetworks(ws).networks;

test('caps set and contracts on: the job probes a chain never probed, records it, observes, and never probes it again on its own', async (t) => {
  const s = setup(t, ON);
  const node = fakeNode(plainToken());
  assert.deepEqual(CF.unprobedChains(s.ws, NOW), ['8453']);
  assert.equal(CF.isDue(s.ws, NOW), true, 'an unprobed chain alone makes the job due');
  const r = await CF.refresh(s.ws, { fetchImpl: node.fetch, key: KEY, sourceImpl: sources({}), now: clock });
  assert.equal(r.status, 'ok', r.message);
  assert.match(r.message, /1 saved; networks probed: 8453 supported/);
  assert.equal(node.calls[0].method, 'eth_chainId', 'the probe comes first');
  const rec = netRecord(s.ws)['8453'];
  assert.equal(rec.finalized, true);
  assert.equal(rec.eip1898, true);
  assert.equal(rec.block.hash, BLOCK.hash);
  assert.equal(CF.view(s.ws, s.pid, NOW).subjects[0].state, 'fresh');
  // Recorded: never probed again by the job.
  const sent = node.calls.length;
  assert.deepEqual(CF.unprobedChains(s.ws, NOW), []);
  const again = await CF.refresh(s.ws, { fetchImpl: node.fetch, key: KEY, sourceImpl: sources({}), now: clock });
  assert.equal(again.status, 'noop');
  assert.equal(node.calls.length, sent, 'nothing sent');
  // A chain recorded as not supported is not probed again on its own either.
  const t2 = setup(t, ON);
  const blind = fakeNode({ ...plainToken(), fault: (n, method, params) => (method === 'eth_getBlockByNumber' && params[0] === 'finalized' ? (id, reply) => reply(id, { result: null }) : null) });
  const r2 = await CF.refresh(t2.ws, { fetchImpl: blind.fetch, key: KEY, sourceImpl: sources({}), now: clock });
  assert.match(r2.message, /0 saved; networks probed: 8453 not supported/);
  assert.equal(netRecord(t2.ws)['8453'].finalized, false);
  assert.deepEqual(CF.unprobedChains(t2.ws, NOW), []);
  assert.equal(CF.isDue(t2.ws, NOW), false);
});

test('the first observation by hand probes its chain first with the caps set; unset caps or contracts off send nothing', async (t) => {
  const s = setup(t);
  const node = fakeNode(plainToken());
  const r = await CF.observeProject(s.ws, s.pid, { fetchImpl: node.fetch, key: KEY, sourceImpl: sources({}), now: clock });
  assert.deepEqual(r.probes, [{ chain_id: '8453', supported: true }]);
  assert.equal(r.results[0].status, 'saved');
  assert.equal(netRecord(s.ws)['8453'].finalized, true);
  // Caps unset: nothing probed or sent; the subject says why.
  const u = setup(t, {});
  const quiet = fakeNode(plainToken());
  const ru = await CF.observeProject(u.ws, u.pid, { fetchImpl: quiet.fetch, key: KEY, now: clock });
  assert.equal(ru.probes, undefined);
  assert.equal(ru.results[0].status, 'network_not_probed');
  assert.equal(quiet.calls.length, 0);
  assert.ok(!fs.existsSync(u.ws.abs(rpc.NETWORKS_REL)));
  // Caps set, contracts off: the job probes nothing.
  const off = setup(t);
  assert.equal(CF.isDue(off.ws, NOW), false);
  assert.equal((await CF.refresh(off.ws, { fetchImpl: quiet.fetch, key: KEY, now: clock })).status, 'skipped');
  assert.equal(quiet.calls.length, 0);
});

test('a probe with no answer to record waits, doubling; a stop (the key refused) ends the run; Eric\'s probe needs his caps', async (t) => {
  const s = setup(t, ON);
  const wrong = fakeNode({ ...plainToken(), chainId: 1 });
  const r = await CF.refresh(s.ws, { fetchImpl: wrong.fetch, key: KEY, sourceImpl: sources({}), now: clock });
  assert.match(r.message, /no probe answer to record for 8453/);
  assert.equal(netRecord(s.ws)['8453'], undefined, 'nothing recorded');
  const wait = rpc.readState(s.ws).probe_waits['8453'];
  assert.equal(wait.failures, 1);
  assert.equal(Date.parse(wait.until), NOW + 30 * 60000);
  assert.deepEqual(CF.unprobedChains(s.ws, NOW), [], 'waiting');
  assert.equal(CF.isDue(s.ws, NOW), false);
  const later = NOW + 31 * 60000;
  assert.deepEqual(CF.unprobedChains(s.ws, later), ['8453']);
  await CF.refresh(s.ws, { fetchImpl: wrong.fetch, key: KEY, sourceImpl: sources({}), now: () => later });
  assert.equal(Date.parse(rpc.readState(s.ws).probe_waits['8453'].until), later + 60 * 60000, 'the wait doubles');
  // Eric's own probe never waits, and a recorded answer clears the wait.
  const node = fakeNode(plainToken());
  const mine = await CF.probeChains(s.ws, { fetchImpl: node.fetch, key: KEY, now: () => later });
  assert.deepEqual(mine.probed, [{ chain_id: '8453', supported: true }]);
  assert.match(mine.words, /networks probed: 8453 supported/);
  assert.equal((rpc.readState(s.ws).probe_waits || {})['8453'], undefined);
  assert.match((await CF.probeChains(s.ws, { fetchImpl: node.fetch, key: KEY, now: () => later })).words, /probed already/);
  // The key refused: the run stops, the gate closes, nothing recorded.
  const k = setup(t, ON);
  const refused = fakeNode({ ...plainToken(), fault: () => (id, reply) => reply(id, {}, 403) });
  const rk = await CF.refresh(k.ws, { fetchImpl: refused.fetch, key: KEY, sourceImpl: sources({}), now: clock });
  assert.equal(rk.status, 'attention');
  assert.match(rk.message, /stopped: Alchemy refused the key/);
  assert.equal(refused.calls.length, 1, 'nothing after the refusal');
  assert.equal(rpc.gateOf(rpc.readState(k.ws), NOW).open, false);
  assert.equal(netRecord(k.ws)['8453'], undefined);
  // Caps unset: Eric's probe is refused before anything is sent.
  const u = setup(t, {});
  await assert.rejects(CF.probeChains(u.ws, { fetchImpl: node.fetch, key: KEY, now: clock }), (e) => e.code === 'REFUSED' && e.status === 409 && /caps/.test(e.message));
  await assert.rejects(CF.probeChains(s.ws, { chainId: '999', fetchImpl: node.fetch, key: KEY, now: clock }), (e) => e.code === 'INVALID');
});

test('POST /api/contracts/probe: refused while the caps are unset, for a malformed chain and without the session token; nothing written', async (t) => {
  const http = require('http');
  const { start } = require('../server');
  const { hashTree } = require('./helpers');
  const s = setup(t, {});
  const srv = await start(s.ws, { port: 47990 + Math.floor(Math.random() * 9), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } });
  const ask = (method, p, headers = {}, body = null) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: p, method, headers: { host: `127.0.0.1:${srv.port}`, ...(body ? { 'content-type': 'application/json', origin: `http://127.0.0.1:${srv.port}` } : {}), ...headers } }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(Buffer.concat(c).toString()); } catch (_) { return null; } })() }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  const token = (await ask('GET', '/api/session')).json.token;
  const unset = await ask('POST', '/api/contracts/probe', { 'x-cr-token': token }, {});
  assert.equal(unset.status, 409);
  assert.match(unset.json.error, /caps/);
  assert.equal((await ask('POST', '/api/contracts/probe', { 'x-cr-token': token }, { chain_id: '8453; rm' })).status, 400);
  assert.equal((await ask('POST', '/api/contracts/probe', {}, { chain_id: '8453' })).status, 401, 'signed in only');
  assert.ok(!fs.existsSync(s.ws.abs(rpc.NETWORKS_REL)), 'no network record');
  assert.ok(!fs.existsSync(s.ws.abs(rpc.STATE_REL)), 'no counter written');
});
