'use strict';
// Pillar 1, PR B: exit physics, value capture, the verdict, and the
// state-override probes. FICTIONAL temporary workspaces and a fictional chain:
// tokens and pools are JavaScript in this file, and a minimal EVM interpreter
// runs the desk's hand-assembled probe code against them (no network, no key).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tempWorkspace } = require('./helpers');
const K = require('../core/keccak');
const G = require('../core/contract-gate');
const CF = require('../core/contract-forensics');
const projects = require('../core/projects');

const KEY = 'FICTIONALkey_0123456789';
const NOW = Date.parse('2026-10-30T12:00:00Z');
const clock = () => NOW;

// ---------------------------------------------------------------------------
// Exit physics: the worked example (fictional pool), exact to the unit.

const E18 = 10n ** 18n;
const WORKED = { mechanism: 'constant_product', reserves: { token: (4000000n * E18).toString(), quote: (200000n * 10n ** 6n).toString() }, fee_bps: 30, quote_decimals: 6, quote_usd: '1' };
const at = (taxBps, s) => G.exitAt({ sizeUsd: s, priceUsd: '0.05', tokenDecimals: 18, taxBps, pool: WORKED, networkFeeUsd: '0.50' });

test('the worked pool: 0.850 / 0.648 / 1.309% at $100 / $500 / $2,000 and 198,490 tokens of depth to 5%', () => {
  assert.deepEqual([100, 500, 2000].map((s) => at(0, s).cost_pct_3), ['0.850', '0.648', '1.309']);
  assert.deepEqual([100, 500, 2000].map((s) => at(300, s).cost_pct_3), ['3.838', '3.624', '4.242']);
  assert.deepEqual([100, 500, 2000].map((s) => at(500, s).cost_pct_3), ['5.830', '5.609', '6.199']);
  for (const s of [100, 500, 2000]) assert.equal(at(0, s).cost_complete, true);
  // The proceeds to the unit: q = 10,000 tokens, out in USDC base units.
  const r = at(0, 500);
  assert.equal(r.q, (10000n * E18).toString());
  assert.equal(r.out, ((10000n * E18 * 9970n * 200000000000n) / (4000000n * E18 * 10000n + 10000n * E18 * 9970n)).toString());
  // Depth: exactly 198,490 whole tokens (floor), none at a 5% tax.
  assert.equal(G.depthToLimit({ rIn: WORKED.reserves.token, feeBps: 30, taxBps: 0, limitPct: 5 }).tokens / E18, 198490n);
  const none = G.depthToLimit({ rIn: WORKED.reserves.token, feeBps: 30, taxBps: 500, limitPct: 5 });
  assert.equal(none.tokens, null);
  assert.match(none.words, /No size passes/);
  // The legacy projection rounds up, never down: 1.309197… → 1.310.
  assert.equal(G.legacyExit(at(0, 2000)).cost_pct, 1.31);
  assert.equal(G.legacyExit(at(0, 500)).cost_pct, 0.648);
  assert.ok(Number(at(0, 2000).cost_pct) <= G.legacyExit(at(0, 2000)).cost_pct);
  // Unknown fee or tax: a lower bound, said by name.
  assert.deepEqual(G.exitAt({ sizeUsd: 500, priceUsd: '0.05', tokenDecimals: 18, taxBps: null, pool: WORKED, networkFeeUsd: null }).missing_costs, ['transfer_tax', 'network_fee']);
});

test('a 5% measured tax is over the limit at every size, and the verdict records CG-10', () => {
  const obs = observation({ transfer_probe: { status: 'ok', sell_path: { tax_bps: 500 } }, pools: [{ ...WORKED, pool: '0x00000000000000000000000000000000000000p1'.replace('p1', '01'), counted: true }] });
  const ladder = G.exitLadder(obs, { sizes: [100, 500, 2000], priceUsd: '0.05', networkFeeUsd: '0.50', limitPct: 5 });
  assert.equal(ladder.best.find((b) => b.size_usd === 500).best.cost_pct_3, '5.609');
  assert.equal(ladder.best.find((b) => b.size_usd === 500).best.cost_complete, true);
  const v = G.verdict({ subjects: [{ role: 'exit_chain', chain_id: '8453', observation: obs }], exits: ladder, now: NOW });
  assert.equal(v.tier, 'block');
  assert.deepEqual([...new Set(v.findings.filter((f) => f.rule_id === 'CG-10').map((f) => f.tier))], ['block']);
  assert.equal(v.findings.filter((f) => f.rule_id === 'CG-10').length, 2, 'the tax and the complete $500 cost');
});

// ---------------------------------------------------------------------------
// Value capture: each class, never a share of revenue.

test('value capture: usage bound, diluted, tax entangled, no holder flow and unknown', () => {
  const vc = (i) => G.valueCapture(i);
  const usage = vc({ holders_revenue_30d_usd: 100000, market_cap_usd: 10000000, onchain_supply_growth_annual: 0.02, buy_tax_pct: 0, sell_tax_pct: 0, revenue_30d_usd: 200000 });
  assert.deepEqual(usage.classes, ['usage_bound']);
  assert.ok(Math.abs(usage.tests.VC1.holder_yield_annual - 0.12166) < 1e-4);
  assert.deepEqual(vc({ holders_revenue_30d_usd: 10000, market_cap_usd: 10000000, onchain_supply_growth_annual: 0.3, buy_tax_pct: 0, sell_tax_pct: 0 }).classes, ['diluted']);
  assert.deepEqual(vc({ holders_revenue_30d_usd: 50000, revenue_30d_usd: 50000, market_cap_usd: 10000000, onchain_supply_growth_annual: 0, buy_tax_pct: 5, sell_tax_pct: 5, volume_30d_usd: 2000000 }).classes, ['tax_entangled']);
  assert.deepEqual(vc({ holders_revenue_30d_usd: 0, market_cap_usd: 10000000, onchain_supply_growth_annual: 0, buy_tax_pct: 0, sell_tax_pct: 0 }).classes, ['no_holder_flow']);
  assert.deepEqual(vc({}).classes, ['unknown']);
  for (const x of [usage, vc({ holders_revenue_30d_usd: 50000, revenue_30d_usd: 50000, market_cap_usd: 1e7, buy_tax_pct: 5, sell_tax_pct: 5, volume_30d_usd: 2e6 })]) {
    assert.doesNotMatch(x.words, /share of|of (the )?revenue|% of revenue|probabilit/i);
    assert.equal(x.organic_demand, 'not_proven');
  }
  const v = G.verdict({ subjects: [], valueCapture: vc({ holders_revenue_30d_usd: 10000, market_cap_usd: 1e7, onchain_supply_growth_annual: 0.3 }), now: NOW });
  assert.deepEqual(v.findings.map((f) => [f.rule_id, f.tier]), [['CG-46', 'review']]);
});

// ---------------------------------------------------------------------------
// The verdict table on synthetic observations.

function observation(over = {}) {
  return {
    block: { number: 1000, hash: `0x${'b1'.repeat(32)}`, timestamp: new Date(NOW - 3600000).toISOString(), latest_slots_match: true },
    token: { code_kind: 'contract', code_hash: `0x${'c0'.repeat(32)}`, decimals: 18, total_supply: '1' },
    proxy: { kind: 'none', supported: true, slots: {}, implementation: null },
    source: { status: 'verified_full' },
    surface: { basis: 'abi', functions: [], unclassified_mutators: [] },
    authorities: [],
    supply: { explained: true },
    ...over,
  };
}
const auth = (capability, cls, extra = {}) => ({ capability, function: 'f()', class: cls, path: [], proof: 'state_read', random_caller: 'not_tried', ...extra });

test('the verdict: each class maps to its rule and tier, worst first, deterministic', () => {
  const run = (o, extra = {}) => G.verdict({ subjects: [{ role: 'exit_chain', chain_id: '8453', observation: o }], now: NOW, ...extra });
  assert.equal(run(observation()).tier, 'none');
  assert.equal(run(observation()).words, 'No finding by these checks. Not covered: LP removal.');
  const ids = (v) => v.findings.map((f) => `${f.rule_id}:${f.tier}`);
  assert.deepEqual(ids(run(observation({ authorities: [auth('C1', 'K5')] }))), ['CG-03:block']);
  assert.deepEqual(ids(run(observation({ authorities: [auth('C2', 'K4')] }))), ['CG-04:block']);
  assert.deepEqual(ids(run(observation({ authorities: [auth('C3', 'K3')] }))), ['CG-05:block'], 'any live controller of balances');
  assert.deepEqual(ids(run(observation({ authorities: [auth('C4', 'K6', { words: 'hidden' })] }))), ['CG-23:hold']);
  assert.deepEqual(ids(run(observation({ authorities: [auth('C5', 'K3')] }))), ['CG-40:review']);
  assert.deepEqual(ids(run(observation({ authorities: [auth('C1', 'K2', { delay_hours: 72 })] }))), ['CG-41:review']);
  assert.deepEqual(ids(run(observation({ authorities: [auth('C2', 'K1', { random_caller: 'succeeded' })] }))), ['CG-04:block']);
  assert.deepEqual(ids(run(observation({ token: { code_kind: 'empty' } }))), ['CG-01:block']);
  assert.deepEqual(ids(run(observation({ token: { code_kind: 'eip7702_delegated' } }))), ['CG-02:block']);
  assert.deepEqual(ids(run(observation({ proxy: { kind: 'diamond', supported: false } }))), ['CG-21:hold']);
  assert.deepEqual(ids(run(observation({ source: { status: 'unverified' }, proxy: { kind: 'erc1967_uups', supported: true } }))), ['CG-22:hold']);
  assert.deepEqual(ids(run(observation({ block: { ...observation().block, latest_slots_match: false } }))), ['CG-24:hold']);
  assert.deepEqual(ids(run(observation({ supply: { explained: false } }))), ['CG-25:hold']);
  assert.deepEqual(ids(run(observation({ transfer_probe: { status: 'reverted' } }))), ['CG-09:block']);
  assert.deepEqual(ids(run(observation({ transfer_probe: { status: 'ok', sell_path: { tax_bps: 200 } } }))), ['CG-43:review']);
  assert.deepEqual(ids(run(observation({ flags: { non_transferable: true } }))), ['CG-12:block']);
  assert.deepEqual(ids(run(observation({ surface: { functions: [], unclassified_mutators: [{ selector: '0x12345678' }] } }))), ['CG-44:review']);
  assert.deepEqual(ids(run(observation({ block: { ...observation().block, timestamp: new Date(NOW - 30 * 3600000).toISOString() } }))), ['CG-20:hold']);
  assert.deepEqual(ids(G.verdict({ subjects: [{ role: 'exit_chain', chain_id: '8453', observation: null, reason: 'network_not_probed' }], now: NOW })), ['CG-26:hold']);
  assert.deepEqual(ids(G.verdict({ subjects: [{ role: 'other_chain', chain_id: '1', observation: null, reason: 'network_not_supported' }], now: NOW })), ['CG-48:review']);
  assert.deepEqual(ids(G.verdict({ subjects: [], vendor: { severe: ['honeypot'] }, now: NOW })), ['CG-11:block']);
  const tr = [{ at: new Date(NOW - 86400000).toISOString(), changes: [{ field: 'proxy.implementation' }] }];
  assert.deepEqual(ids(G.verdict({ subjects: [{ role: 'exit_chain', chain_id: '8453', observation: observation({ proxy: { kind: 'erc1967_transparent', supported: true } }), transitions: tr }], now: NOW })), ['CG-42:review']);
  assert.deepEqual(ids(G.verdict({ subjects: [{ role: 'exit_chain', chain_id: '8453', observation: observation(), transitions: [{ at: tr[0].at, changes: [{ field: 'token.code_hash' }] }] }], now: NOW })), ['CG-13:block']);
  // Worst first; the same input gives the same bytes.
  const mixed = observation({ authorities: [auth('C1', 'K3'), auth('C4', 'K6'), auth('C2', 'K5')] });
  assert.equal(run(mixed).tier, 'block');
  assert.equal(G.canonicalJson(run(mixed)), G.canonicalJson(run(JSON.parse(JSON.stringify(mixed)))));
  assert.match(run(mixed).findings_sha256, /^[0-9a-f]{64}$/);
  assert.match(run(mixed).words, /^1 blocking, 1 holding, 1 for review: /);
  for (const v of [run(mixed), run(observation())]) assert.doesNotMatch(JSON.stringify(v), /\bis safe\b|"safe"/i);
});

// ---------------------------------------------------------------------------
// A fictional chain: accounts are JavaScript; a minimal EVM runs the probe.

const ADDR = (n) => `0x${String(n).padStart(40, '0')}`;
const W = (x) => BigInt(x).toString(16).padStart(64, '0');
const Aw = (a) => a.slice(2).toLowerCase().padStart(64, '0');
const sel = (s) => K.selector(s);
const arg = (d, i) => BigInt(`0x${d.subarray(4 + 32 * i, 36 + 32 * i).toString('hex') || '0'}`);
const argA = (d, i) => `0x${d.subarray(4 + 32 * i + 12, 36 + 32 * i).toString('hex')}`;
const ok = (...words) => ({ ok: true, ret: words.map(W).join('') });
const okA = (a) => ({ ok: true, ret: Aw(a) });
const REVERT = { ok: false, ret: '' };
const codeWith = (...sigs) => `0x6080604052${sigs.map((s) => `63${sel(s).slice(2)}`).join('')}00`;
const M256 = 2n ** 256n;

function runEvm(codeHex, { self, calldata, call }) {
  const code = Buffer.from(codeHex.slice(2), 'hex');
  const st = [];
  let mem = Buffer.alloc(0);
  const grow = (end) => { if (mem.length < end) { const m = Buffer.alloc(Math.ceil(end / 32) * 32); mem.copy(m); mem = m; } };
  const pop = () => { if (!st.length) throw new Error('stack underflow'); return st.pop(); };
  let pc = 0;
  while (pc < code.length) {
    const op = code[pc++];
    if (op >= 0x60 && op <= 0x7f) { const n = op - 0x5f; st.push(BigInt(`0x${code.subarray(pc, pc + n).toString('hex')}`)); pc += n; continue; }
    switch (op) {
      case 0x00: return { ok: true, ret: Buffer.alloc(0) };
      case 0x01: { const a = pop(); const b = pop(); st.push((a + b) % M256); break; }
      case 0x03: { const a = pop(); const b = pop(); st.push((a - b + M256) % M256); break; }
      case 0x35: { const o = Number(pop()); const b = Buffer.alloc(32); calldata.copy(b, 0, o, o + 32); st.push(BigInt(`0x${b.toString('hex')}`)); break; }
      case 0x36: st.push(BigInt(calldata.length)); break;
      case 0x37: { const d = Number(pop()); const o = Number(pop()); const s = Number(pop()); grow(d + s); const b = Buffer.alloc(s); calldata.copy(b, 0, o, o + s); b.copy(mem, d); break; }
      case 0x52: { const o = Number(pop()); const v = pop(); grow(o + 32); Buffer.from(W(v), 'hex').copy(mem, o); break; }
      case 0x5a: st.push(30000000n); break;
      case 0xf1: case 0xfa: {
        pop();
        const to = `0x${pop().toString(16).padStart(40, '0')}`;
        if (op === 0xf1) pop();
        const ao = Number(pop()); const as = Number(pop()); const ro = Number(pop()); const rs = Number(pop());
        grow(Math.max(ao + as, ro + rs));
        const r = call({ to, sender: self, data: Buffer.from(mem.subarray(ao, ao + as)), isStatic: op === 0xfa });
        const ret = Buffer.from(r.ret || '', 'hex');
        ret.copy(mem, ro, 0, Math.min(rs, ret.length));
        st.push(r.ok ? 1n : 0n);
        break;
      }
      case 0xf3: { const o = Number(pop()); const s = Number(pop()); grow(o + s); return { ok: true, ret: Buffer.from(mem.subarray(o, o + s)) }; }
      default: throw new Error(`opcode 0x${op.toString(16)} is not in the fictional EVM`);
    }
  }
  return { ok: true, ret: Buffer.alloc(0) };
}

const TOKEN = ADDR('a1');
const USDC = ADDR('5dc');
const FACTORY = ADDR('fac');
const INIT = K.keccak256Hex(Buffer.from('FICTIONAL pair init code').toString('hex').replace(/^/, '0x'));
const OWNER = ADDR('e0a');
const BUYER = ADDR('b0b');
const HIDDEN = ADDR('d1d');
const [T0, T1] = TOKEN < USDC ? [TOKEN, USDC] : [USDC, TOKEN];
const PAIR = K.create2Address(FACTORY, K.keccak256Hex(`0x${T0.slice(2)}${T1.slice(2)}`), INIT);
const TOKEN_RES = 4000000n * E18;
const USDC_RES = 200000n * 10n ** 6n;
const BLOCK = { number: 5000, hash: `0x${'5b'.repeat(32)}`, timestamp: Math.floor(NOW / 1000) - 900 };

// The world's state S is plain data (cloned per eth_call); behaviour is code.
function tokenFns(extraSigs = {}) {
  return {
    [sel('decimals()')]: () => ok(18),
    [sel('totalSupply()')]: (S) => ok(S.supply),
    [sel('owner()')]: (S) => (S.owner ? okA(S.owner) : REVERT),
    [sel('balanceOf(address)')]: (S, from, d) => ok(S.bal[argA(d, 0)] || 0n),
    [sel('transfer(address,uint256)')]: (S, from, d) => {
      const to = argA(d, 0);
      const amt = arg(d, 1);
      if (S.block_sells && to === S.pool) return REVERT;
      if (S.return_false && to === S.pool) return ok(0);
      if ((S.bal[from] || 0n) < amt) return REVERT;
      const tax = to === S.pool ? (amt * BigInt(S.tax_bps || 0)) / 10000n : 0n;
      S.bal[from] -= amt;
      S.bal[to] = (S.bal[to] || 0n) + amt - tax;
      S.bal[OWNER] = (S.bal[OWNER] || 0n) + tax;
      return ok(1);
    },
    [sel('mint(address,uint256)')]: (S, from, d) => {
      if (!S.minter || from !== S.minter) return REVERT;
      S.bal[argA(d, 0)] = (S.bal[argA(d, 0)] || 0n) + arg(d, 1);
      S.supply += arg(d, 1);
      return ok(1);
    },
    [sel('setBalance(address,uint256)')]: (S, from, d) => {
      if (!S.wiper || from !== S.wiper) return REVERT;
      const a = argA(d, 0);
      S.supply = S.supply - (S.bal[a] || 0n) + arg(d, 1);
      S.bal[a] = arg(d, 1);
      return ok(1);
    },
    [sel('rebalance(address,uint256)')]: (S, from, d) => {
      if (from !== S.owner) return REVERT;
      S.bal[argA(d, 0)] = (S.bal[argA(d, 0)] || 0n) + arg(d, 1);
      S.supply += arg(d, 1);
      return ok(1);
    },
    ...extraSigs,
  };
}

function world({ S, tokenCode, factoryPair = PAIR, extra = {}, block = BLOCK, buyers = [BUYER] }) {
  const accounts = {
    [TOKEN]: { code: tokenCode, fns: tokenFns() },
    [USDC]: { code: codeWith('transfer(address,uint256)'), fns: { [sel('decimals()')]: () => ok(6), [sel('balanceOf(address)')]: (s, f, d) => ok(argA(d, 0) === PAIR ? USDC_RES : 0n) } },
    [FACTORY]: { code: '0x60806040526001', fns: { [sel('getPair(address,address)')]: () => okA(factoryPair) } },
    [factoryPair]: { code: '0x60806040526002', fns: { [sel('token0()')]: () => okA(T0), [sel('token1()')]: () => okA(T1), [sel('getReserves()')]: (s) => (T0 === TOKEN ? ok(s.reserve_token, USDC_RES, 0) : ok(USDC_RES, s.reserve_token, 0)) } },
    ...extra,
  };
  const calls = [];
  const violations = [];
  const invoke = (S2, { to, sender, data }) => {
    const acct = accounts[to];
    const h = acct && acct.fns && acct.fns[`0x${data.subarray(0, 4).toString('hex')}`];
    if (!h) return REVERT;
    return h(S2, sender, data);
  };
  // A call from inside the probe: a revert undoes its writes; a static call
  // never keeps any.
  const inner = (S2) => (c) => {
    const snap = structuredClone(S2);
    const r = invoke(c.isStatic ? snap : S2, c);
    if (!r.ok && !c.isStatic) Object.assign(S2, snap);
    return r;
  };
  async function fetch(url, init) {
    const { id, method, params } = JSON.parse(init.body);
    calls.push({ method, params });
    const reply = (body) => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: '2.0', id, ...body }) });
    const pinned = (ref) => (ref && ref.blockHash === block.hash && ref.requireCanonical === true) || ref === 'latest' || (violations.push(method), false);
    switch (method) {
      case 'eth_chainId': return reply({ result: '0x2105' });
      case 'eth_getBlockByNumber': return reply({ result: { number: `0x${block.number.toString(16)}`, hash: block.hash, timestamp: `0x${block.timestamp.toString(16)}` } });
      case 'eth_getCode': pinned(params[1]); return reply({ result: (accounts[params[0]] && accounts[params[0]].code) || '0x' });
      case 'eth_getStorageAt': pinned(params[2]); return reply({ result: `0x${W(0)}` });
      case 'eth_getLogs': {
        const q = params[0];
        if (q.topics[1] === `0x${Aw(PAIR)}`) return reply({ result: buyers.map((b) => ({ topics: [CF.TOPICS.Transfer, `0x${Aw(PAIR)}`, `0x${Aw(b)}`], data: `0x${W(1)}` })) });
        return reply({ result: [] });
      }
      case 'eth_call': {
        pinned(params[1]);
        const S2 = structuredClone(S);
        const tx = params[0];
        const data = Buffer.from(tx.data.slice(2), 'hex');
        const o = params[2] && params[2][tx.to];
        const r = o ? runEvm(o.code, { self: tx.to, calldata: data, call: inner(S2) }) : invoke(S2, { to: tx.to, sender: tx.from || ADDR(0), data });
        const ret = Buffer.isBuffer(r.ret) ? r.ret.toString('hex') : r.ret;
        return r.ok && ret ? reply({ result: `0x${ret}` }) : reply({ error: { code: 3, message: 'execution reverted' } });
      }
      default: return reply({ error: { code: -32601, message: `${method} not served` } });
    }
  }
  return { fetch, calls, violations };
}

const ROW = { chain_id: '8453', name: 'Fictional V2', kind: 'v2', factory: FACTORY, init_code_hash: INIT, fee_bps: 30, quotes: [{ address: USDC, decimals: 6, usd_value: '1', symbol: 'USDC' }] };

function setup(t, { factories = [ROW] } = {}) {
  const w = tempWorkspace('contract-gate', { contracts: { daily_cu_cap: 1000000, monthly_cu_cap: 10000000, pool_factories: factories, max_log_blocks: 1000 } });
  t.after(w.cleanup);
  const pid = projects.addProject(w.ws, { name: 'Example Token (FICTIONAL)', symbol: 'XFIC', official_website: 'https://xfic.example.org/', coingecko_id: 'xfic-fictional', evidence: [{ url: 'https://xfic.example.org/', note: 'fictional' }], assets: [{ chain: 'base', contract_address: TOKEN }] }).project_id;
  fs.mkdirSync(w.ws.abs('market-data'), { recursive: true });
  fs.writeFileSync(w.ws.abs(require('../core/market').LATEST_REL), JSON.stringify({ provider: 'coingecko', assets: { 'xfic-fictional': { price_usd: 0.05, fetched_at: new Date(NOW).toISOString() } } }));
  return { ...w, pid };
}

const baseState = (over = {}) => ({ supply: 10000000n * E18, bal: { [PAIR]: TOKEN_RES, [BUYER]: 50000n * E18 }, pool: PAIR, reserve_token: TOKEN_RES, owner: OWNER, ...over });

async function observe(s, w, { src = {} } = {}) {
  await CF.probeNetwork(s.ws, '8453', { fetchImpl: w.fetch, key: KEY, now: clock });
  const r = await CF.observeProject(s.ws, s.pid, { fetchImpl: w.fetch, key: KEY, sourceImpl: async (c, a) => (src[a] ? { status: 'verified_full', abi: src[a].abi, contract_name: 'X', runtime_code_hash: K.keccak256Hex(src[a].code) } : { status: 'unverified' }), now: clock });
  assert.equal(r.results[0].status, 'saved', JSON.stringify(r.results[0]));
  return CF.readObservation(s.ws, s.pid, r.results[0].observation_id).observation;
}

test('the probe network check finds state overrides; the probe code is pinned by its Keccak-256', async (t) => {
  const s = setup(t);
  const w = world({ S: baseState(), tokenCode: codeWith('transfer(address,uint256)') });
  const p = await CF.probeNetwork(s.ws, '8453', { fetchImpl: w.fetch, key: KEY, now: clock });
  assert.equal(p.state_overrides, true);
  assert.equal(CF.PROBE_CODE_HASH, K.keccak256Hex(CF.PROBE_CODE));
  // Overrides only replace code, only on eth_call, only at the pinned block.
  const rpc = require('../core/contract-rpc');
  const sess = rpc.openSession(s.ws, { chainId: '8453', fetchImpl: w.fetch, key: KEY, now: clock });
  sess.pinTo(BLOCK.hash);
  await assert.rejects(sess.call('eth_call', [{ to: TOKEN, data: '0x' }], { latest: true, overrides: { [TOKEN]: { code: '0x00' } } }), /pinned block only/);
  await assert.rejects(sess.call('eth_call', [{ to: TOKEN, data: '0x' }], { overrides: { [TOKEN]: { code: '0x00', balance: '0x1' } } }), /code only/);
});

test('a verified pool counts; a spoofed one and a rebasing one are excluded with their reasons', async (t) => {
  const s = setup(t);
  const o = await observe(s, world({ S: baseState(), tokenCode: codeWith('transfer(address,uint256)') }));
  const p = o.pools.find((x) => x.pool === PAIR);
  assert.equal(p.counted, true);
  assert.equal(p.create2_verified, true);
  assert.deepEqual(p.reserves, { token: TOKEN_RES.toString(), quote: USDC_RES.toString() });
  const SPOOF = ADDR('5900f');
  const s2 = setup(t);
  const spoof = await observe(s2, world({ S: baseState(), tokenCode: codeWith('transfer(address,uint256)'), factoryPair: SPOOF }));
  assert.equal(spoof.pools[0].counted, false);
  assert.match(spoof.pools[0].excluded, /CREATE2/);
  assert.ok(spoof.coverage.missing.includes('verified_pool'));
  const s3 = setup(t);
  const reb = await observe(s3, world({ S: baseState({ reserve_token: TOKEN_RES - 10n }), tokenCode: codeWith('transfer(address,uint256)') }));
  assert.equal(reb.pools[0].counted, false);
  assert.match(reb.pools[0].excluded, /rebasing/);
  // With no allowlisted factory, no pool is read at all.
  const s4 = setup(t, { factories: [] });
  const none = await observe(s4, world({ S: baseState(), tokenCode: codeWith('transfer(address,uint256)') }));
  assert.deepEqual(none.pools, []);
  assert.equal(none.transfer_probe.status, 'unavailable');
});

test('the sell path is simulated: 0% then 8% tax is a transition with a complete exit over the limit', async (t) => {
  const s = setup(t);
  const code = codeWith('transfer(address,uint256)');
  const o1 = await observe(s, world({ S: baseState(), tokenCode: code }));
  assert.equal(o1.transfer_probe.status, 'ok');
  assert.equal(o1.transfer_probe.sell_path.tax_bps, 0);
  assert.equal(o1.transfer_probe.sender.address, BUYER);
  assert.equal(o1.transfer_probe.probe_code_hash, CF.PROBE_CODE_HASH);
  const B2 = { number: 5100, hash: `0x${'5c'.repeat(32)}`, timestamp: BLOCK.timestamp + 600 };
  const w2 = world({ S: baseState({ tax_bps: 800 }), tokenCode: code, block: B2 });
  const r = await CF.observeProject(s.ws, s.pid, { fetchImpl: w2.fetch, key: KEY, sourceImpl: async () => ({ status: 'unverified' }), now: clock });
  const o2 = CF.readObservation(s.ws, s.pid, r.results[0].observation_id).observation;
  assert.equal(o2.transfer_probe.sell_path.tax_bps, 800);
  assert.equal(o2.identity_key, o1.identity_key, 'a tax is not part of the identity');
  const tr = CF.readStatus(s.ws, s.pid).subjects[`8453:${TOKEN}`].transitions;
  assert.equal(tr.length, 1);
  assert.deepEqual(tr[0].changes.find((c) => c.field === 'transfer_probe.tax_bps'), { field: 'transfer_probe.tax_bps', from: 0, to: 800 });
  const ladder = G.exitLadder(o2, { sizes: [100, 500, 2000], priceUsd: '0.05', networkFeeUsd: '0.50', limitPct: 5 });
  const at500 = ladder.best.find((b) => b.size_usd === 500).best;
  assert.equal(at500.cost_complete, true);
  assert.ok(Number(at500.cost_pct) > 5);
  const v = G.verdict({ subjects: [{ role: 'exit_chain', chain_id: '8453', observation: o2 }], exits: ladder, now: NOW });
  assert.ok(v.findings.some((f) => f.rule_id === 'CG-10' && f.tier === 'block'));
});

test('a reverting sale records CG-09', async (t) => {
  const s = setup(t);
  const o = await observe(s, world({ S: baseState({ block_sells: true }), tokenCode: codeWith('transfer(address,uint256)') }));
  assert.equal(o.transfer_probe.status, 'reverted');
  const v = G.verdict({ subjects: [{ role: 'exit_chain', chain_id: '8453', observation: o }], now: NOW });
  assert.ok(v.findings.some((f) => f.rule_id === 'CG-09' && f.tier === 'block'));
});

test('authority probes: a hidden owner is CG-23; a balance wipe by the owner is CG-05; an innocently named mint is reclassified', async (t) => {
  // Hidden: owner() names an EOA, but only an unnamed address can mint.
  const s = setup(t);
  const hidden = await observe(s, world({ S: baseState({ minter: HIDDEN }), tokenCode: codeWith('transfer(address,uint256)', 'mint(address,uint256)') }));
  const c2 = hidden.authorities.find((a) => a.capability === 'C2');
  assert.equal(c2.class, 'K6', c2.words);
  assert.equal(c2.random_caller, 'reverted');
  assert.equal(c2.proof, 'authority_probe');
  let v = G.verdict({ subjects: [{ role: 'exit_chain', chain_id: '8453', observation: hidden }], now: NOW });
  assert.ok(v.findings.some((f) => f.rule_id === 'CG-23' && f.tier === 'hold'));
  assert.ok(!v.findings.some((f) => f.rule_id === 'CG-04'), 'the named owner cannot mint');
  // The owner can mint: proven, K5, CG-04.
  const s1 = setup(t);
  const minted = await observe(s1, world({ S: baseState({ minter: OWNER }), tokenCode: codeWith('transfer(address,uint256)', 'mint(address,uint256)') }));
  const m = minted.authorities.find((a) => a.capability === 'C2');
  assert.deepEqual([m.class, m.proof, m.random_caller], ['K5', 'authority_probe', 'reverted']);
  assert.ok(!minted.coverage.missing.includes('authority_probe'));
  // Wipe: the owner sets a holder's balance to zero.
  const s2 = setup(t);
  const wipe = await observe(s2, world({ S: baseState({ wiper: OWNER }), tokenCode: codeWith('transfer(address,uint256)', 'setBalance(address,uint256)') }));
  const c3 = wipe.authorities.find((a) => a.capability === 'C3');
  assert.equal(c3.proof, 'authority_probe');
  assert.ok(wipe.effects.some((e) => e.function === 'setBalance(address,uint256)' && e.as === OWNER && BigInt(e.holder_delta) < 0n));
  v = G.verdict({ subjects: [{ role: 'exit_chain', chain_id: '8453', observation: wipe }], now: NOW });
  assert.ok(v.findings.some((f) => f.rule_id === 'CG-05' && f.tier === 'block'));
  // Anyone can wipe: unguarded.
  const s3 = setup(t);
  const anyone = await observe(s3, world({ S: baseState({ wiper: CF.RANDOM_CALLER }), tokenCode: codeWith('transfer(address,uint256)', 'setBalance(address,uint256)') }));
  assert.equal(anyone.authorities.find((a) => a.capability === 'C3').random_caller, 'succeeded');
  // "rebalance" is not a mint by name; the effect probe finds it raises supply.
  const s4 = setup(t);
  const code = codeWith('transfer(address,uint256)', 'rebalance(address,uint256)');
  const abi = [{ type: 'function', name: 'transfer', inputs: [{ type: 'address' }, { type: 'uint256' }], stateMutability: 'nonpayable' }, { type: 'function', name: 'rebalance', inputs: [{ type: 'address' }, { type: 'uint256' }], stateMutability: 'nonpayable' }];
  const re = await observe(s4, world({ S: baseState(), tokenCode: code }), { src: { [TOKEN]: { code, abi } } });
  const rc = re.authorities.find((a) => a.capability === 'C2');
  assert.deepEqual([rc.function, rc.proof, rc.class], ['rebalance(address,uint256)', 'effect_probe', 'K5']);
  assert.ok(re.surface.functions.some((f) => f.signature === 'rebalance(address,uint256)' && f.capability === 'C2'));
  assert.equal(re.surface.unclassified_mutators.length, 0);
});

test('a concentrated pool is quoted at 0% tax and excluded for a taxed token', async (t) => {
  const FACT3 = ADDR('fac3');
  const QUOTER = ADDR('9007');
  const QCODE = '0x6080604052600f';
  const INIT3 = K.keccak256Hex('0x0f1c7101a1');
  const POOL3 = K.create2Address(FACT3, K.keccak256Hex(`0x${Aw(T0)}${Aw(T1)}${W(3000)}`), INIT3);
  const row3 = { chain_id: '8453', name: 'Fictional V3', kind: 'v3', factory: FACT3, init_code_hash: INIT3, fee_tiers: [3000], quoter: QUOTER, quoter_code_hash: K.keccak256Hex(QCODE), quotes: [{ address: USDC, decimals: 6, usd_value: '1' }] };
  const extra = {
    [FACT3]: { code: '0x60806040526003', fns: { [sel('getPool(address,address,uint24)')]: () => okA(POOL3) } },
    [POOL3]: { code: '0x60806040526004', fns: { [sel('token0()')]: () => okA(T0), [sel('token1()')]: () => okA(T1) } },
    [QUOTER]: { code: QCODE, fns: { [sel('quoteExactInputSingle((address,address,uint256,uint24,uint160))')]: (S, f, d) => ok((arg(d, 2) * 49n) / (1000n * 10n ** 12n), 0, 0, 0) } },
  };
  const s = setup(t, { factories: [ROW, row3] });
  const o = await observe(s, world({ S: baseState(), tokenCode: codeWith('transfer(address,uint256)'), extra }));
  const p3 = o.pools.find((p) => p.pool === POOL3);
  assert.equal(p3.counted, true);
  assert.equal(p3.mechanism, 'concentrated');
  assert.equal(p3.quoted['500'], ((10000n * E18 * 49n) / (1000n * 10n ** 12n)).toString());
  const s2 = setup(t, { factories: [ROW, row3] });
  const taxed = await observe(s2, world({ S: baseState({ tax_bps: 300 }), tokenCode: codeWith('transfer(address,uint256)'), extra }));
  const q3 = taxed.pools.find((p) => p.pool === POOL3);
  assert.equal(q3.counted, false);
  assert.match(q3.excluded, /cannot settle in a concentrated pool/);
});

// ---------------------------------------------------------------------------
// Packet v2 (observe mode): the attestation is frozen beside the ticket and
// changes no gate output; the Paper Book reads its exits as it reads v1.

const T = require('../core/tickets');
const H = require('./helpers');

function ticketDesk(t, { observe = true } = {}) {
  const w = H.tempWorkspace('contract-v2', { contracts: { daily_cu_cap: 1000000, monthly_cu_cap: 10000000, pool_factories: [ROW], max_log_blocks: 1000 } });
  t.after(w.cleanup);
  const pid = H.addFixtureProject(w.ws).project_id;
  H.importAllFixtures(w.ws);
  // The fixture's identity on a chain the desk reads (fictional address).
  const file = w.ws.abs(`projects/${pid}/project.json`);
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  p.identity.assets = [{ chain: 'base', contract_address: TOKEN }];
  fs.writeFileSync(file, JSON.stringify(p, null, 2));
  H.freshPrice(w.ws, 'example-payfi-fictional', 0.85);
  return { ...w, pid, observe };
}

async function storeObservation(s) {
  const w = world({ S: baseState({ minter: OWNER }), tokenCode: codeWith('transfer(address,uint256)', 'mint(address,uint256)') });
  await CF.probeNetwork(s.ws, '8453', { fetchImpl: w.fetch, key: KEY, now: Date.now });
  const r = await CF.observeProject(s.ws, s.pid, { fetchImpl: w.fetch, key: KEY, sourceImpl: async () => ({ status: 'unverified' }), now: Date.now });
  assert.equal(r.results[0].status, 'saved');
}

test('a ticket on an observed contract freezes a v2 packet; observe mode changes no gate output; the prompt shows the summary, no ABI', async (t) => {
  const s = ticketDesk(t);
  await storeObservation(s);
  const made = H.withExitReadings(3, () => T.createTicket(s.ws, { project_id: s.pid, assistant: true }));
  assert.equal(made.status, 'created', made.message);
  const tk = made.ticket;
  const packet = JSON.parse(fs.readFileSync(s.ws.abs(tk.packet.path), 'utf8'));
  assert.equal(packet.schema_version, 'cr.ticket-packet.v2');
  assert.equal(packet.contract.rules.mode, 'observe');
  assert.equal(packet.contract.subjects.length, 1);
  const sub = packet.contract.subjects[0];
  assert.equal(sub.observation.path, `projects/${s.pid}/tickets/${tk.ticket_id}/contract/${sub.observation.observation_id}.json`);
  assert.equal(require('../core/fsx').sha256(fs.readFileSync(s.ws.abs(sub.observation.path), 'utf8')), sub.observation.sha256);
  assert.ok(packet.contract.verdict.findings.some((f) => f.rule_id === 'CG-04' && f.tier === 'block'), 'the owner can mint: recorded');
  assert.ok(packet.value_capture && packet.value_capture.version === 'cr-value-capture@1');
  // The v1 fields keep their shape: exits are the forensics readings, not the desk's own.
  assert.deepEqual(packet.exits.map((x) => [x.size_usd, x.cost_pct, x.route_scope]), [[100, 1.5, 'aggregator'], [500, 3, 'aggregator'], [2000, 6, 'aggregator']]);
  // Observe: the gate reads the same basis with or without the attestation.
  const { contract, value_capture, ...plain } = tk.basis;
  assert.ok(contract && value_capture);
  for (const type of ['ACCUMULATE', 'LIMIT_TRAP', 'WATCH_ONLY', 'HARD_PASS', 'TRIM_EXIT']) assert.deepEqual(T.gate(tk.basis, tk.sizing, type), T.gate(plain, tk.sizing, type));
  const prompt = fs.readFileSync(s.ws.abs(tk.prompt.path), 'utf8');
  assert.match(prompt, /cr-contract-attestation@1/);
  assert.doesNotMatch(prompt, /"abi"|stateMutability/);
});

// A Prosecutor's answer for a ticket (fictional), as tickets.test.js writes one.
function answerFor(tk) {
  const now = new Date().toISOString();
  const b = {
    format: T.FORMAT, ticket_id: tk.ticket_id, project_id: tk.project_id, prompt_version: T.PROMPT_VERSION, role: 'prosecutor', model: 'claude', model_version: 'claude-test', as_of: now,
    researcher_report_id: tk.basis.researcher.report_id, researcher_report_sha256: tk.basis.researcher.original.sha256,
    prosecution: {
      verdict: 'thesis_damaged', conviction_score: 38,
      tests: { mercenary_emissions: { result: 'fail', finding: 'Rewards exceed fees (FICTIONAL).', source_ids: ['S1'] }, tax_revenue: { result: 'pass', finding: '' }, exit_slippage: { result: 'unknown', finding: 'No reading.' }, unverified_claims: { result: 'fail', finding: 'Partner list unsourced.' } },
      fatal_flaws: [{ test: 'mercenary_emissions', severity: 'fatal', finding: 'Activity is paid for by emissions (FICTIONAL).', source_ids: ['S1'] }],
      strongest_bull_rebuttal: 'Emissions taper next quarter.',
    },
    proposal: {
      proposal_type: 'ACCUMULATE',
      non_consensus_thesis: 'The market assumes organic demand; the evidence shows paid activity; the emission cut in Q1 makes the difference observable.',
      entry_zone: { low_usd: 0.8, high_usd: 0.9, basis: 'prior range' },
      upside_target: { price_usd: 1.4, basis: 'fees double' },
      invalidation_trigger: { price_usd: 0.7, metric: { key: 'fees', below_30d_usd: 100000 }, statement: 'Below $0.70 or fees under $100k a month.' },
    },
    agent_disagreement_note: 'The researcher grades higher on product reality; I score 38 on emissions.',
    sources: [{ source_id: 'S1', url: 'https://example.com/xmpl/emissions', publisher: 'Example (FICTIONAL)', retrieved_at: now, excerpt: 'fictional' }],
  };
  return `# Prosecution (FICTIONAL)\n\n${'The four tests and the flaws, written out for the test fixture. '.repeat(12)}\n\n\`\`\`json\n${JSON.stringify(b, null, 2)}\n\`\`\`\n`;
}

test('the saved receipt records the gate in observe mode; a tampered frozen observation is unverified', async (t) => {
  const s = ticketDesk(t);
  await storeObservation(s);
  const tk = H.withExitReadings(3, () => T.createTicket(s.ws, { project_id: s.pid, assistant: true })).ticket;
  H.freshPrice(s.ws, 'example-payfi-fictional', 0.85);
  const text = answerFor(tk);
  const saved = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text });
  assert.equal(saved.status, 'saved', saved.message);
  const cg = saved.receipt.desk.contract_gate;
  assert.deepEqual([cg.mode, cg.tier, cg.version], ['observe', 'block', 'cr-contract-gate@1']);
  assert.equal(T.integrityOf(s.ws, saved.receipt).status, 'ok');
  const v = T.view(s.ws, s.pid);
  assert.equal(v.ticket.contract_gate.mode, 'observe');
  assert.match(v.ticket.contract_gate.words, /blocking/);
  // Observe: the suggested size is the gate's, as without the attestation.
  const { contract, value_capture, ...plain } = tk.basis;
  assert.equal(saved.receipt.desk.gate.suggested_risk_usd, T.gate(plain, tk.sizing, saved.receipt.proposal.proposal_type).suggested_risk_usd);
  // Tampering with the frozen observation is caught before anything else.
  const p = JSON.parse(fs.readFileSync(s.ws.abs(tk.packet.path), 'utf8'));
  fs.appendFileSync(s.ws.abs(p.contract.subjects[0].observation.path), ' ');
  const bad = T.integrityOf(s.ws, saved.receipt);
  assert.equal(bad.status, 'unverified');
  assert.match(bad.words, /frozen observation/);
});

test('the Paper Book reads a v2 packet\'s exits exactly as a v1 packet\'s', (t) => {
  const PT = require('../core/paper-trader');
  const HR = 3600000;
  const T0 = Date.parse('2026-10-27T00:00:00Z');
  const NOWB = T0 + 15 * HR;
  const iso = (ms) => new Date(ms).toISOString();
  const PID = 'fict-project';
  const RID = 'tr_2026-10-27T000000Z_fict2';
  const TID = 'tk_2026-10-27T000000Z_fict2';
  const w = H.tempWorkspace('contract-v2-book');
  t.after(w.cleanup);
  const ws = w.ws;
  fs.mkdirSync(ws.abs(`projects/${PID}/tickets/${TID}`), { recursive: true });
  fs.mkdirSync(ws.abs(`projects/${PID}/tickets/receipts`), { recursive: true });
  fs.writeFileSync(ws.abs(`projects/${PID}/tickets/decisions.jsonl`), `${JSON.stringify({ schema_version: 'cr.ticket-decision.v1', decision_id: 'td_fict0000000001', project_id: PID, receipt_id: RID, ticket_id: TID, action: 'approve', pm_approved_risk_usd: 250, suggested_risk_usd: 250, proposal_type: 'ACCUMULATE', note: null, decided_at: iso(T0), decided_by: 'eric', request_id: null })}\n`);
  const exits = [500, 5000, 20000].map((size, i) => ({ size_usd: size, status: 'measured', cost_pct: [0.4, 1.2, 7.5][i], cost_complete: true, missing_costs: [], method: 'executable_quote', route_scope: 'aggregator', as_of: iso(T0), note: null }));
  const write = (packet) => {
    const text = `${JSON.stringify(packet, null, 2)}\n`;
    fs.writeFileSync(ws.abs(`projects/${PID}/tickets/${TID}/packet.json`), text);
    fs.writeFileSync(ws.abs(`projects/${PID}/tickets/receipts/${RID}.json`), JSON.stringify({ schema_version: 'cr.ticket-receipt.v1', receipt_id: RID, project_id: PID, ticket_id: TID, packet: { path: `projects/${PID}/tickets/${TID}/packet.json`, sha256: require('../core/fsx').sha256(text), captured_at: iso(T0) }, desk: { sizing: { max_exit_cost_pct: 5 } } }));
  };
  assert.equal(PT.fund(ws, { cash_usd: '10000', now: iso(T0) }).status, 'saved');
  for (let i = 0; i < 15; i++) PT.applyBar(ws, { pair: 'FICT/USDC', hour: iso(T0 + i * HR), open: '100', high: '101', low: '99.5', close: '100', volume: '1000000' }, { now: iso(T0 + (i + 1) * HR) });
  const ctx = { now: iso(NOWB), rules: { stop_min_pct: '0.01', stop_min_atr: '1', notional_max_pct: '0.25', price_stale_minutes: 15, max_validity_minutes: 180, allowlist: ['FICT/USDC'] }, venue: { lot: '0.001', min_notional_usd: '10', maker_rate: '0.001', taker_rate: '0.002' }, ticket: { project_id: PID, receipt_id: RID, decision_id: 'td_fict0000000001' } };
  write({ schema_version: 'cr.ticket-packet.v1', project_id: PID, exits });
  const v1 = PT.book(ws, 'FICT/USDC', ctx);
  write({ schema_version: 'cr.ticket-packet.v2', project_id: PID, exits, contract: { attestation_version: 'cr-contract-attestation@1', verdict: { tier: 'review', findings: [] } }, value_capture: { version: 'cr-value-capture@1', classes: ['unknown'] } });
  const v2 = PT.book(ws, 'FICT/USDC', ctx);
  assert.equal(v1.exit_max_usd, '5000');
  assert.equal(v2.exit_max_usd, v1.exit_max_usd);
  const { packet_sha256: a, ...e1 } = v1.exit;
  const { packet_sha256: b, ...e2 } = v2.exit;
  assert.deepEqual(e2, e1);
  assert.notEqual(a, b);
});