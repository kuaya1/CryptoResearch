'use strict';
// The minter() reader (2026-11-02): a mint guarded by a minter() getter (the
// Compound and Uniswap pattern) is resolved through the same controller rules
// as an owner, instead of reading as an unknown guard (K6, CG-23 hold).
// FICTIONAL temporary workspaces; every chain answer comes from a fictional
// node in this file (no network, no key, no provider).

const test = require('node:test');
const assert = require('node:assert/strict');
const { tempWorkspace } = require('./helpers');
const K = require('../core/keccak');
const CF = require('../core/contract-forensics');
const gate = require('../core/contract-gate');
const projects = require('../core/projects');

const KEY = 'FICTIONALkey_0123456789';
const NOW = Date.parse('2026-11-02T12:00:00Z');
const clock = () => NOW;
const CAPS = { contracts: { daily_cu_cap: 100000, monthly_cu_cap: 1000000 } };

const ADDR = (n) => `0x${String(n).padStart(40, '0')}`;
const W = (x) => BigInt(x).toString(16).padStart(64, '0');
const A = (a) => a.slice(2).toLowerCase().padStart(64, '0');
const ret = (...words) => `0x${words.join('')}`;
const sel = (sig) => K.selector(sig);
const codeWith = (...sigs) => `0x6080604052${sigs.map((s) => `63${sel(s).slice(2)}`).join('')}00`;
const fn = (name, inputs = []) => ({ type: 'function', name, inputs: inputs.map((type) => ({ type })), stateMutability: 'nonpayable' });

const BLOCK = { number: 2000, hash: `0x${'c2'.repeat(32)}`, timestamp: Math.floor(NOW / 1000) - 900 };
const TOKEN = ADDR('a1');
const MINTER = ADDR('3e1');
const OWNER = ADDR('0e1');
const DEAD = '0x000000000000000000000000000000000000dead';
const ZERO = ADDR(0);
// The token: mint and transfer, verified, so the only finding is the mint's.
const TOKEN_CODE = codeWith('transfer(address,uint256)', 'mint(address,uint256)', 'minter()');
const TOKEN_SRC = { code: TOKEN_CODE, name: 'ExampleToken', abi: [fn('transfer', ['address', 'uint256']), fn('mint', ['address', 'uint256'])] };
// Compound's Timelock: delay() and admin(), recognized only by verified source.
const TL_CODE = codeWith('delay()', 'admin()');
const compoundTimelock = (hours) => ({ code: TL_CODE, calls: { [sel('delay()')]: ret(W(hours * 3600)), [sel('admin()')]: ret(A(ADDR('90f'))) } });
const TL_SRC = { code: TL_CODE, name: 'Timelock', abi: [] };
// OpenZeppelin's TimelockController: getMinDelay().
const OZ_CODE = codeWith('getMinDelay()');
const ozTimelock = (hours) => ({ code: OZ_CODE, calls: { [sel('getMinDelay()')]: ret(W(hours * 3600)) } });
const OZ_SRC = { code: OZ_CODE, name: 'TimelockController', abi: [] };

// A node answering from `state`: accounts { address: { code, storage, calls } }
// at the pinned block; `latest` overrides accounts for reads at latest.
function fakeNode(state) {
  const calls = [];
  const violations = [];
  const reply = (id, body) => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: '2.0', id, ...body }) });
  const acct = (a, latest) => {
    const base = (state.accounts || {})[a.toLowerCase()] || {};
    const over = latest && state.latest ? state.latest[a.toLowerCase()] : null;
    return over ? { ...base, ...over, calls: { ...(base.calls || {}), ...(over.calls || {}) } } : base;
  };
  const pinned = (m, ref, allowLatest) => (ref === 'latest' && allowLatest) || (ref && ref.blockHash === BLOCK.hash && ref.requireCanonical === true) || (violations.push(m), false);
  async function fetch(url, init) {
    const { id, method, params } = JSON.parse(init.body);
    calls.push({ method, params });
    switch (method) {
      case 'eth_chainId': return reply(id, { result: '0x2105' });
      case 'eth_getBlockByNumber': return reply(id, { result: { number: `0x${BLOCK.number.toString(16)}`, hash: BLOCK.hash, timestamp: `0x${BLOCK.timestamp.toString(16)}` } });
      case 'eth_getCode': pinned(method, params[1], false); return reply(id, { result: acct(params[0]).code || '0x' });
      case 'eth_getStorageAt': pinned(method, params[2], true); return reply(id, { result: `0x${(acct(params[0], params[2] === 'latest').storage || {})[params[1]] || W(0)}` });
      case 'eth_call': {
        pinned(method, params[1], true);
        const h = (acct(params[0].to, params[1] === 'latest').calls || {})[params[0].data.slice(0, 10)];
        const out = typeof h === 'function' ? h(params[0].data) : h;
        return out === undefined || out === null ? reply(id, { error: { code: 3, message: 'execution reverted' } }) : reply(id, { result: out });
      }
      case 'eth_getLogs': return reply(id, { result: [] });
      default: return reply(id, { error: { code: -32601, message: `method ${method} not served by the fictional node` } });
    }
  }
  return { fetch, calls, violations };
}

const tokenCalls = (extra = {}) => ({ [sel('decimals()')]: ret(W(18)), [sel('totalSupply()')]: ret(W(1000000n * 10n ** 18n)), ...extra });
// A token whose mint is guarded by minter() (and, when given, an owner).
const minterToken = ({ minter = MINTER, owner = null, minterAnswer } = {}, accounts = {}) => ({
  accounts: {
    [TOKEN]: { code: TOKEN_CODE, calls: tokenCalls({ ...(minterAnswer !== undefined ? { [sel('minter()')]: minterAnswer } : minter ? { [sel('minter()')]: ret(A(minter)) } : {}), ...(owner ? { [sel('owner()')]: ret(A(owner)) } : {}) }) },
    ...accounts,
  },
});

function sources(map) {
  return async (chainId, address) => {
    const s = map[address.toLowerCase()];
    if (!s) return { status: 'unverified' };
    return { status: 'verified_full', abi: s.abi, contract_name: s.name, compiler: 'v0.8.FICTIONAL', runtime_code_hash: K.keccak256Hex(s.code) };
  };
}

async function observe(t, state, src = {}) {
  const w = tempWorkspace('minter', CAPS);
  t.after(w.cleanup);
  const pid = projects.addProject(w.ws, { name: 'Example Token (FICTIONAL)', symbol: 'XFIC', official_website: 'https://xfic.example.org/', coingecko_id: 'xfic-fictional', evidence: [{ url: 'https://xfic.example.org/', note: 'fictional' }], assets: [{ chain: 'base', contract_address: TOKEN }] }).project_id;
  const node = fakeNode(state);
  await CF.probeNetwork(w.ws, '8453', { fetchImpl: node.fetch, key: KEY, now: clock });
  node.calls.length = 0;
  const r = await CF.observeProject(w.ws, pid, { fetchImpl: node.fetch, key: KEY, sourceImpl: sources({ [TOKEN]: TOKEN_SRC, ...src }), now: clock });
  const res = r.results[0];
  assert.equal(res.status, 'saved', JSON.stringify(res));
  const obs = CF.readObservation(w.ws, pid, res.observation_id).observation;
  assert.deepEqual(node.violations, [], 'every read carried the pin or the labeled latest');
  const c2 = obs.authorities.find((a) => a.capability === 'C2');
  const v = gate.verdict({ subjects: [{ role: 'exit_chain', chain_id: '8453', observation: obs }], now: NOW });
  const minterCalls = node.calls.filter((c) => c.method === 'eth_call' && c.params[0].data === sel('minter()'));
  return { obs, c2, v, node, minterCalls };
}
const nodes = (a) => a.path.map((p) => p.node);
const only = (v) => v.findings.map((f) => `${f.rule_id}/${f.tier}`);

test('minter() is derived from its preimage and matches the published selector', () => {
  assert.equal(CF.READS['minter()'], '0x07546172');
});

test('a minter that is a verified Compound timelock at 48 hours is K2: CG-41 review, not a hold', async (t) => {
  const { obs, c2, v, minterCalls } = await observe(t, minterToken({}, { [MINTER]: compoundTimelock(48) }), { [MINTER]: TL_SRC });
  assert.equal(c2.class, 'K2', c2.words);
  assert.equal(c2.delay_hours, 48);
  assert.deepEqual(nodes(c2), ['minter', 'compound_timelock']);
  assert.deepEqual(c2.path[0], { address: MINTER, node: 'minter', via: 'minter()' });
  assert.deepEqual(only(v), ['CG-41/review']);
  assert.equal(v.tier, 'review');
  assert.equal(obs.block.latest_slots_match, null, 'no proxy: nothing at latest to disagree with');
  assert.equal(minterCalls.length, 2, 'once at the pinned block, once at latest');
});

test('a minter that is a verified OpenZeppelin TimelockController above the minimum is K2 too', async (t) => {
  const { c2, v } = await observe(t, minterToken({}, { [MINTER]: ozTimelock(72) }), { [MINTER]: OZ_SRC });
  assert.equal(c2.class, 'K2', c2.words);
  assert.equal(c2.delay_hours, 72);
  assert.deepEqual(nodes(c2), ['minter', 'oz_timelock']);
  assert.deepEqual(only(v), ['CG-41/review']);
});

test('a minter timelock under 48 hours is K4: one key, a block', async (t) => {
  const { c2, v } = await observe(t, minterToken({}, { [MINTER]: compoundTimelock(24) }), { [MINTER]: TL_SRC });
  assert.equal(c2.class, 'K4', c2.words);
  assert.equal(c2.delay_hours, 24);
  assert.match(c2.words, /under your 48-hour minimum/);
  assert.deepEqual(only(v), ['CG-04/block']);
  assert.equal(v.tier, 'block');
});

test('a minter timelock without verified source naming it is not recognized: K6, a hold', async (t) => {
  const { c2, v } = await observe(t, minterToken({}, { [MINTER]: compoundTimelock(72) }));
  assert.equal(c2.class, 'K6', c2.words);
  assert.match(c2.words, /without verified source/);
  assert.deepEqual(only(v), ['CG-23/hold']);
});

test('a minter that is a wallet is K5: one key, a block', async (t) => {
  const { c2, v } = await observe(t, minterToken({}, { [MINTER]: {} }));
  assert.equal(c2.class, 'K5', c2.words);
  assert.deepEqual(nodes(c2), ['minter', 'eoa']);
  assert.deepEqual(only(v), ['CG-04/block']);
  assert.equal(v.tier, 'block');
});

test('a zero or dead minter is K1: renounced, no finding', async (t) => {
  for (const m of [ZERO, DEAD]) {
    const { c2, v } = await observe(t, minterToken({ minter: m }));
    assert.equal(c2.class, 'K1', `${m}: ${c2.words}`);
    assert.deepEqual(nodes(c2), ['minter', 'renounced']);
    assert.equal(v.tier, 'none', m);
  }
});

test('a minter that is an unrecognized contract is K6: CG-23 hold, as before', async (t) => {
  const { c2, v } = await observe(t, minterToken({}, { [MINTER]: { code: codeWith('mintFor(address)') } }));
  assert.equal(c2.class, 'K6', c2.words);
  assert.deepEqual(nodes(c2), ['minter', 'contract']);
  assert.deepEqual(only(v), ['CG-23/hold']);
});

test('a minter() answer that is not an address is unreadable: K6, never a guess', async (t) => {
  const { c2, v } = await observe(t, minterToken({ minterAnswer: ret('f'.repeat(64)) }));
  assert.equal(c2.class, 'K6', c2.words);
  assert.equal(c2.path[0].node, 'minter');
  assert.equal(c2.path[0].address, null);
  assert.deepEqual(only(v), ['CG-23/hold']);
});

test('no minter() and no owner: unchanged, K6 "No owner or role answered", a hold', async (t) => {
  const { c2, v, minterCalls } = await observe(t, minterToken({ minter: null }));
  assert.equal(c2.class, 'K6');
  assert.match(c2.words, /No owner or role answered/);
  assert.deepEqual(c2.path, []);
  assert.deepEqual(only(v), ['CG-23/hold']);
  assert.equal(minterCalls.length, 1, 'asked once; a revert is no answer');
});

test('no minter() with an owner: unchanged, the owner\'s class', async (t) => {
  const { c2 } = await observe(t, minterToken({ minter: null, owner: OWNER }, { [OWNER]: {} }));
  assert.equal(c2.class, 'K5');
  assert.deepEqual(nodes(c2), ['owner', 'eoa']);
});

test('a minter and an owner: the worse of the two counts, both paths kept', async (t) => {
  // A 48-hour timelock minter under a wallet owner: the wallet sets the class.
  const a = await observe(t, minterToken({ owner: OWNER }, { [MINTER]: compoundTimelock(48), [OWNER]: {} }), { [MINTER]: TL_SRC });
  assert.equal(a.c2.class, 'K5', a.c2.words);
  assert.deepEqual(nodes(a.c2), ['minter', 'compound_timelock', 'owner', 'eoa']);
  assert.equal(a.c2.delay_hours, null, 'the delay belongs to the controller that does not set the class');
  assert.match(a.c2.words, /^minter\(\): .*owner\(\): .*The worse of the two counts/);
  assert.equal(a.v.tier, 'block');
  // A renounced owner over a 48-hour timelock minter: the timelock sets it.
  const b = await observe(t, minterToken({ owner: ZERO }, { [MINTER]: compoundTimelock(48) }), { [MINTER]: TL_SRC });
  assert.equal(b.c2.class, 'K2', b.c2.words);
  assert.equal(b.c2.delay_hours, 48);
  assert.deepEqual(nodes(b.c2), ['minter', 'compound_timelock', 'owner', 'renounced']);
  assert.deepEqual(only(b.v), ['CG-41/review']);
  // An unrecognized owner contract over a timelock minter: still a hold.
  const c = await observe(t, minterToken({ owner: OWNER }, { [MINTER]: compoundTimelock(48), [OWNER]: { code: codeWith('execute(bytes)') } }), { [MINTER]: TL_SRC });
  assert.equal(c.c2.class, 'K6', c.c2.words);
  assert.deepEqual(only(c.v), ['CG-23/hold']);
});

test('AccessControl with MINTER_ROLE still decides the mint: minter() is not asked', async (t) => {
  const roleCalls = {
    [sel('getRoleAdmin(bytes32)')]: () => ret(W(0)),
    [sel('getRoleMemberCount(bytes32)')]: (data) => ret(W(data.slice(10) === W(0) ? 1 : 0)),
    [sel('getRoleMember(bytes32,uint256)')]: () => ret(A(OWNER)),
  };
  const state = minterToken({}, { [MINTER]: compoundTimelock(48), [OWNER]: {} });
  Object.assign(state.accounts[TOKEN].calls, roleCalls);
  const { c2, minterCalls } = await observe(t, state, { [MINTER]: TL_SRC });
  assert.equal(c2.class, 'K5', c2.words);
  assert.ok(!nodes(c2).includes('minter'));
  assert.equal(minterCalls.length, 0);
});

test('a minter that differs at latest is a change in flight: CG-24 hold', async (t) => {
  const state = minterToken({}, { [MINTER]: compoundTimelock(48) });
  state.latest = { [TOKEN]: { calls: { [sel('minter()')]: ret(A(ADDR('bad'))) } } };
  const { c2, obs, v } = await observe(t, state, { [MINTER]: TL_SRC });
  assert.equal(c2.class, 'K2');
  assert.equal(obs.block.latest_slots_match, false);
  assert.deepEqual(only(v), ['CG-24/hold', 'CG-41/review']);
  assert.equal(v.tier, 'hold');
});

// With state overrides, the authority probe calls mint as the named minter
// (tests/contract-world.js: a minimal EVM runs the probe).
test('authority probe: the named minter that can mint is proven; a minter() that names the wrong address is K6', async (t) => {
  const Wd = require('./contract-world');
  const run = async (S) => {
    const w = tempWorkspace('minter-probe', { contracts: { daily_cu_cap: 1000000, monthly_cu_cap: 10000000, pool_factories: [] } });
    t.after(w.cleanup);
    const pid = projects.addProject(w.ws, { name: 'Example Token (FICTIONAL)', symbol: 'XFIC', official_website: 'https://xfic.example.org/', coingecko_id: 'xfic-fictional', evidence: [{ url: 'https://xfic.example.org/', note: 'fictional' }], assets: [{ chain: 'base', contract_address: Wd.TOKEN }] }).project_id;
    const code = Wd.codeWith('transfer(address,uint256)', 'mint(address,uint256)');
    const world = Wd.world({ S, tokenCode: code, extra: { [Wd.TOKEN]: { code, fns: Wd.tokenFns({ [Wd.sel('minter()')]: (s) => Wd.okA(s.named_minter) }) } } });
    const p = await CF.probeNetwork(w.ws, '8453', { fetchImpl: world.fetch, key: KEY, now: () => Wd.NOW });
    assert.equal(p.state_overrides, true);
    const r = await CF.observeProject(w.ws, pid, { fetchImpl: world.fetch, key: KEY, sourceImpl: async () => ({ status: 'unverified' }), now: () => Wd.NOW });
    const obs = CF.readObservation(w.ws, pid, r.results[0].observation_id).observation;
    return obs.authorities.find((a) => a.capability === 'C2');
  };
  const MW = Wd.ADDR('3e9');
  const real = await run(Wd.baseState({ owner: null, minter: MW, named_minter: MW }));
  assert.deepEqual([real.class, real.proof, real.random_caller, real.coverage], ['K5', 'authority_probe', 'reverted', 'complete'], real.words);
  assert.deepEqual(nodes(real), ['minter', 'eoa']);
  const wrong = await run(Wd.baseState({ owner: null, minter: Wd.HIDDEN, named_minter: MW }));
  assert.equal(wrong.class, 'K6', wrong.words);
  assert.match(wrong.words, /Neither the named controller/);
});

test('the minter is part of the identity key: a new minter is a new identity', async (t) => {
  const a = await observe(t, minterToken({}, { [MINTER]: compoundTimelock(48) }), { [MINTER]: TL_SRC });
  const M2 = ADDR('3e2');
  const b = await observe(t, minterToken({ minter: M2 }, { [M2]: compoundTimelock(48) }), { [M2]: TL_SRC });
  assert.equal(a.c2.class, b.c2.class);
  assert.notEqual(a.obs.identity_key, b.obs.identity_key);
});
