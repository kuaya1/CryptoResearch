'use strict';
// A fictional EVM chain for contract observations (moved unchanged from
// contract-gate.test.js, corrective PR 2026-10-31, so the autonomous paper
// witness observes its contract through the same transport stand-in): the
// accounts are JavaScript, a minimal EVM runs the probe, and fetch() answers
// JSON-RPC the way a node would. FICTIONAL addresses, pools and contracts.

const K = require('../core/keccak');
const CF = require('../core/contract-forensics');

const NOW = Date.parse('2026-10-30T12:00:00Z');
const E18 = 10n ** 18n;

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

function world({ S, tokenCode, factoryPair = PAIR, extra = {}, block = BLOCK, buyers = [BUYER], chainIdHex = '0x2105' }) {
  const accounts = {
    [TOKEN]: { code: tokenCode, fns: tokenFns() },
    [USDC]: { code: codeWith('transfer(address,uint256)'), fns: { [sel('decimals()')]: () => ok(6), [sel('balanceOf(address)')]: (s, f, d) => ok(argA(d, 0) === PAIR ? s.reserve_quote || USDC_RES : 0n) } },
    [FACTORY]: { code: '0x60806040526001', fns: { [sel('getPair(address,address)')]: () => okA(factoryPair) } },
    [factoryPair]: { code: '0x60806040526002', fns: { [sel('token0()')]: () => okA(T0), [sel('token1()')]: () => okA(T1), [sel('getReserves()')]: (s) => (T0 === TOKEN ? ok(s.reserve_token, s.reserve_quote || USDC_RES, 0) : ok(s.reserve_quote || USDC_RES, s.reserve_token, 0)) } },
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
      case 'eth_chainId': return reply({ result: chainIdHex });
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

const baseState = (over = {}) => ({ supply: 10000000n * E18, bal: { [PAIR]: TOKEN_RES, [BUYER]: 50000n * E18 }, pool: PAIR, reserve_token: TOKEN_RES, owner: OWNER, ...over });

// The contract-gate suite's live harness: a timelock controller (a review
// finding), its verified sources and a shallow pool.
const TL = ADDR('71e10c');
const TL2 = ADDR('71e20c');
const TL_CODE = codeWith('getMinDelay()');
const TOKEN_CODE = codeWith('transfer(address,uint256)', 'mint(address,uint256)');
const TOKEN_ABI = ['transfer', 'mint'].map((name) => ({ type: 'function', name, inputs: [{ type: 'address' }, { type: 'uint256' }], stateMutability: 'nonpayable' }));
const sources = async (c, a) => (a === TOKEN ? { status: 'verified_full', abi: TOKEN_ABI, contract_name: 'ExampleToken', runtime_code_hash: K.keccak256Hex(TOKEN_CODE) }
  : a === TL || a === TL2 ? { status: 'verified_full', abi: [], contract_name: 'TimelockController', runtime_code_hash: K.keccak256Hex(TL_CODE) } : { status: 'unverified' });
const timelocks = { [TL]: { code: TL_CODE, fns: { [sel('getMinDelay()')]: () => ok(72 * 3600) } }, [TL2]: { code: TL_CODE, fns: { [sel('getMinDelay()')]: () => ok(96 * 3600) } } };
// $0.85 a token: 30,000 USDC against 35,294 tokens. A $500 sale costs about
// 2%; a $2,000 sale about 6.5%, over the 5% limit.
const SHALLOW = 35294n * E18;
const shallowState = (controller) => baseState({ owner: controller, minter: controller, reserve_token: SHALLOW, reserve_quote: 30000n * 10n ** 6n, bal: { [PAIR]: SHALLOW, [BUYER]: 50000n * E18 } });
const liveBlock = (n) => ({ number: n, hash: `0x${n.toString(16).padStart(64, '0')}`, timestamp: Math.floor(Date.now() / 1000) - 600 });

// A concentrated pool's own price for these fixtures (cr-contract-exit@2).
// `sqrtAt` is the square-root price slot0() stores (Q64.96) for a token that
// costs `usd` in a quote asset worth $1: the nearest one that does not put
// the pool's price over `usd`, so a pool "at" a price never reads above it.
// `spotAt` is the pool row's `spot` as the capture writes it; `slot0At` is
// the pool's answer to slot0(). The fictional token sorts below the quote
// asset, so it is token0 unless a test says otherwise.
function isqrt(n) {
  if (n < 2n) return n;
  let x0 = n;
  let x1 = (n >> 1n) + 1n;
  while (x1 < x0) { x0 = x1; x1 = (x1 + n / x1) >> 1n; }
  return x0;
}
function sqrtAt(usd, { tokenDecimals = 18, quoteDecimals = 6, side = TOKEN === T0 ? 'token0' : 'token1' } = {}) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(usd));
  if (!m) throw new Error(`not a plain price: ${usd}`);
  const frac = m[2] || '';
  // The price as quote base units per token base unit: num / den.
  const num = BigInt(`${m[1]}${frac}`) * 10n ** BigInt(quoteDecimals);
  const den = 10n ** BigInt(frac.length + tokenDecimals);
  if (num === 0n) throw new Error('a pool has no price of zero');
  if (side === 'token0') return isqrt((num << 192n) / den); // s² / 2^192 <= price
  const s = isqrt((den << 192n) / num); // 2^192 / s² <= price
  return s * s * num < den << 192n ? s + 1n : s;
}
const spotAt = (usd, opts = {}) => ({ sqrt_price_x96: sqrtAt(usd, opts).toString(), token_side: opts.side || (TOKEN === T0 ? 'token0' : 'token1') });
const slot0At = (usd, opts = {}) => ok(sqrtAt(usd, opts), 0, 0, 0, 0, 0, 1);

module.exports = { NOW, E18, ADDR, W, Aw, sel, arg, argA, ok, okA, REVERT, codeWith, M256, runEvm, TOKEN, USDC, FACTORY, INIT, OWNER, BUYER, HIDDEN, T0, T1, PAIR, TOKEN_RES, USDC_RES, BLOCK, tokenFns, world, ROW, baseState, TL, TL2, TL_CODE, TOKEN_CODE, TOKEN_ABI, sources, timelocks, SHALLOW, shallowState, liveBlock, sqrtAt, spotAt, slot0At };
