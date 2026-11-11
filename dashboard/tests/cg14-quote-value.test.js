'use strict';
// CG-14 and the quote asset's dollar value (cr-contract-exit@2, decision D1,
// Eric 2026-11-10). FICTIONAL chain, pools, quoter, desk and prices; the one
// real value is Ethereum USDC's contract address, which Eric mapped to
// CoinGecko `usd-coin`. Temporary workspaces only; no network, no key.
//
// The rules under test:
// - Only Ethereum's USDC (chain 1, 0xa0b8…eb48) is mapped. Its dollar value
//   is the lower of the setting and its fresh stored CoinGecko value at the
//   observation; every other quote asset keeps its setting alone.
// - The capture records that stored value from the market record the token's
//   stored price comes from: the value, the provider's time, the fetch time,
//   and the asset, chain and contract it was read for. No chain read is added.
// - The stored value passes the token price's freshness rule against the
//   same block. Missing, stale, malformed or for another identity: no row of
//   that pool is a reading, so under enforce the guard holds and says why; a
//   ticket row carries the setting's figure only as a labeled estimate.
// - The ticket's reference rows and the guard's fitted row are one
//   calculation (exitLadder), each at its own quantity.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SAFE = process.env.CR_AUDIT_SAFE_ROOT;
if (SAFE !== undefined) assert.ok(typeof SAFE === 'string' && SAFE !== '' && path.isAbsolute(SAFE), 'CR_AUDIT_SAFE_ROOT must name the disposable folder');
const ROOT = path.resolve(SAFE === undefined ? os.tmpdir() : SAFE);
const under = (p) => {
  const rel = path.relative(ROOT, path.resolve(p));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
if (SAFE !== undefined) assert.ok(under(os.tmpdir()), `os.tmpdir() ${os.tmpdir()} is not under ${SAFE}`);
assert.ok(!process.env.CR_DATA_DIR && !process.env.CR_WORKSPACE, 'no real desk path may be set');

const G = require('../core/contract-gate');
const K = require('../core/keccak');
const CF = require('../core/contract-forensics');
const T = require('../core/tickets');
const H = require('./helpers');
const { world, baseState, ROW, PAIR, TOKEN, TOKEN_CODE, BUYER, ADDR, Aw, W, sel, arg, ok, okA, tokenFns, sources, timelocks, liveBlock, TL } = require('./contract-world');

const Q96 = 2n ** 96n;
const ETH_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'; // Ethereum's USDC (contract-presets.js USDC[1])
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const STALE = 90;

// ---------------------------------------------------------------------------
// Unit level. Token and USDC both 6 decimals. 125 tokens are sold into a pool
// at exactly 4 USDC a token, so the sale is worth $500.00 at the pool with
// USDC at $1. The stored token price is $3.96, the entry $3.90, the fee $5.

const TIMED = { block: { timestamp: '2026-11-10T12:00:00.000Z' }, retrieved: { started_at: '2026-11-10T12:12:00.000Z', finished_at: '2026-11-10T12:13:00.000Z' } };
const usdcRef = (usd, over = {}) => ({ [ETH_USDC]: { usd, as_of: '2026-11-10T12:07:00.000Z', fetched_at: '2026-11-10T12:07:30.000Z', source: 'coingecko_stored', coingecko_id: 'usd-coin', chain_id: '1', address: ETH_USDC, ...over } });
function v3(out, { set = '1', side = 'token0', quote = ETH_USDC, labels = { 500: ['125000000', out] } } = {}) {
  return {
    pool: '0x00000000000000000000000000000000000c0de3', mechanism: 'concentrated', counted: true, fee_bps: 30, fee_tier: 3000,
    quote_asset: quote, quote_decimals: 6, quote_usd: set, reserves: { token: '1', quote: '1' },
    quoted: Object.fromEntries(Object.entries(labels).map(([k, [, o]]) => [k, String(o)])),
    quoted_in: Object.fromEntries(Object.entries(labels).map(([k, [q]]) => [k, q])),
    spot: side === 'token0' ? { sqrt_price_x96: (2n * Q96).toString(), token_side: 'token0' } : { sqrt_price_x96: (Q96 / 2n).toString(), token_side: 'token1' },
  };
}
// A pair at exactly 4 quote units a token; `rt` its token reserve.
const v2 = (rt, { set = '1', quote = ETH_USDC } = {}) => ({ pool: '0x00000000000000000000000000000000000c0de2', mechanism: 'constant_product', counted: true, fee_bps: 30, quote_asset: quote, quote_decimals: 6, quote_usd: set, reserves: { token: rt.toString(), quote: (4n * rt).toString() } });
function obs(pools, { usdc = '1', ref, chain = '1', stored = '3.96' } = {}) {
  const o = { subject: { chain_id: chain }, token: { decimals: 6 }, ...TIMED, price_ref: { usd: stored, as_of: '2026-11-10T12:08:00.000Z', source: 'coingecko_stored' }, transfer_probe: { status: 'ok', sell_path: { tax_bps: 0 } }, pools };
  const r = ref !== undefined ? ref : usdc === null ? null : usdcRef(usdc);
  if (r) o.quote_price_ref = r;
  return o;
}
const guard = (o, { quantity = '125', entry = '3.9', fee = '5', stale = STALE } = {}) => G.fittedExit(o, { notionalUsd: (Number(quantity) * Number(entry)).toString(), priceUsd: entry, quantity, networkFeeUsd: fee, limitPct: 5, priceStaleMinutes: stale });
const ticketRows = (o, { price = '3.96', fee = '5', stale = STALE } = {}) => G.exitLadder(o, { sizes: [100, 500, 2000], priceUsd: price, networkFeeUsd: fee, limitPct: 5, priceStaleMinutes: stale });
// The V2 pair's token reserve whose 125-token sale pays `out` (the smallest such), found on the gate's own cpOut.
function reserveFor(out) {
  const pay = (rt) => BigInt(G.cpOut({ rIn: rt.toString(), rOut: (4n * rt).toString(), feeBps: 30, qIn: 125000000n }));
  let lo = 1250000000n; let hi = 125000000000n;
  while (hi - lo > 1n) { const mid = (lo + hi) / 2n; if (pay(mid) >= out) hi = mid; else lo = mid; }
  return { rt: hi, out: pay(hi) };
}

test('QV1: the mapping is Ethereum\'s USDC contract on chain 1 only', () => {
  assert.deepEqual(G.QUOTE_PRICE_IDS, { [`1:${ETH_USDC}`]: 'usd-coin' });
  const P = require('../core/contract-presets');
  assert.equal(P.USDC[1], ETH_USDC, 'the preset USDC on Ethereum is the mapped contract');
  for (const r of P.POOL_FACTORIES.filter((x) => String(x.chain_id) === '1')) assert.equal(r.quotes[0].address, ETH_USDC, r.name);
  assert.deepEqual(G.quoteMapping('1', ETH_USDC.toUpperCase().replace('0X', '0x')), { coingecko_id: 'usd-coin', chain_id: '1', address: ETH_USDC });
  assert.deepEqual(G.quoteMapping(1, ETH_USDC), { coingecko_id: 'usd-coin', chain_id: '1', address: ETH_USDC });
  assert.equal(G.quoteMapping('8453', ETH_USDC), null, 'the same address on another chain is not mapped');
  assert.equal(G.quoteMapping('8453', BASE_USDC), null, 'Base\'s USDC is not mapped');
  assert.equal(G.quoteMapping('1', BASE_USDC), null);
  assert.equal(G.quoteMapping('1', ADDR('5dc')), null);
  // A record with no chain on it cannot step around the rule.
  assert.equal(G.quoteMapping(null, ETH_USDC).chain_id, '1');
  // An unmapped quote asset reads exactly as before: no quote fields, the setting alone.
  const base = guard(obs([v3(479975000n, { set: '1.01', quote: ADDR('5dc') })], { usdc: null }));
  assert.deepEqual([base.ok, base.cost_pct, base.quote_basis], [true, '4.9950990099009901', undefined]);
  const other = guard(obs([v3(479975000n, { set: '1.01' })], { chain: '8453', usdc: null }));
  assert.equal(other.ok, true, 'Ethereum\'s USDC address on chain 8453 keeps the setting');
});

test('QV2: the three lines on V3 (token0 and token1) and V2: 5.005% with USDC set 1% high holds, exactly 5% passes, one base unit less holds', () => {
  const lo = reserveFor(479975000n); // the first reserve whose sale pays at least 479.975
  const at5 = reserveFor(480000000n);
  const cases = [
    ['V3 token0', (out, o) => [v3(out, o)]],
    ['V3 token1', (out, o) => [v3(out, { ...o, side: 'token1' })]],
  ];
  for (const [name, pools] of cases) {
    const over = guard(obs(pools(479975000n, { set: '1.01' }), { usdc: '1' }));
    assert.deepEqual([over.ok, over.cost_pct, over.value_basis, over.quote_basis, over.quote_usd], [false, '5.005', 'pool', 'stored', '1'], `${name}: ${over.words}`);
    assert.match(over.words, /at the pool's own price \(\$500\) with the quote asset at its stored \$1, is 5\.005%, over the 5% limit/);
    // The same sale where USDC really is $1.01 (set and stored): 4.9951%, a pass. The rule does not over-hold.
    const real = guard(obs(pools(479975000n, { set: '1.01' }), { usdc: '1.01' }));
    assert.deepEqual([real.ok, real.cost_pct, real.quote_basis], [true, '4.9950990099009901', 'setting'], name);
    const exact = guard(obs(pools(480000000n, {}), { usdc: '1' }));
    assert.deepEqual([exact.ok, exact.cost_pct], [true, '5'], `${name}: ${exact.words}`);
    const less = guard(obs(pools(479999999n, {}), { usdc: '1' }));
    assert.deepEqual([less.ok, less.cost_pct], [false, '5.0000002'], name);
  }
  // V2: the reserve is the evidence; 125 tokens at 4 a token is $500 at the pool.
  const over = guard(obs([v2(lo.rt, { set: '1.01' })], { usdc: '1' }));
  assert.equal(over.ok, false, over.words);
  assert.ok(Number(over.cost_pct) >= 5.005 && Number(over.cost_pct) < 5.0051, over.cost_pct);
  assert.equal(over.quote_basis, 'stored');
  const setOnly = guard(obs([v2(lo.rt, { set: '1.01', quote: ADDR('5dc') })], { usdc: null }));
  assert.equal(setOnly.ok, true, 'the same pair on an unmapped quote asset still passes: the gap this rule closes');
  const exact = guard(obs([v2(at5.rt)], { usdc: '1' }));
  assert.deepEqual([at5.out, exact.ok, exact.cost_pct], [480000000n, true, '5']);
  const less = guard(obs([v2(at5.rt - 1n)], { usdc: '1' }));
  assert.deepEqual([less.ok, less.cost_pct], [false, '5.0000002']);
});

test('QV3: missing or invalid USDC evidence: the guard holds and says why; a ticket row is an estimate, labeled, never a reading', () => {
  const pool = [v3(480000001n)];
  const bad = [
    ['missing', { ref: null }, 'missing'],
    ['another asset', { ref: { [ETH_USDC]: { ...usdcRef('1')[ETH_USDC], coingecko_id: 'tether' } } }, 'identity'],
    ['another chain', { ref: { [ETH_USDC]: { ...usdcRef('1')[ETH_USDC], chain_id: '8453' } } }, 'identity'],
    ['another contract', { ref: { [ETH_USDC]: { ...usdcRef('1')[ETH_USDC], address: BASE_USDC } } }, 'identity'],
    ['another source', { ref: { [ETH_USDC]: { ...usdcRef('1')[ETH_USDC], source: 'manual' } } }, 'identity'],
    ['keyed to another address', { ref: { [BASE_USDC]: usdcRef('1')[ETH_USDC] } }, 'missing'],
    ['text', { ref: usdcRef('abc') }, 'malformed'],
    ['zero', { ref: usdcRef('0') }, 'malformed'],
    ['negative', { ref: usdcRef('-1') }, 'malformed'],
    ['an exponent', { ref: usdcRef('1e0') }, 'malformed'],
    ['a number, not text', { ref: usdcRef(1) }, 'malformed'],
    ['three hours before its block', { ref: usdcRef('1', { as_of: '2026-11-10T09:00:00.000Z' }) }, 'stale'],
    ['an hour after the capture', { ref: usdcRef('1', { as_of: '2026-11-10T13:30:00.000Z' }) }, 'after_capture'],
    ['no time', { ref: usdcRef('1', { as_of: null }) }, 'no_time'],
    ['a time that is not UTC', { ref: usdcRef('1', { as_of: '2026-11-10 12:07' }) }, 'malformed_time'],
  ];
  for (const [name, o, state] of bad) {
    const ob = obs(pool, o);
    const r = guard(ob);
    assert.equal(r.ok, false, name);
    assert.equal(r.no_quote_price, 1, name);
    assert.deepEqual(r.quote_states, [{ pool: pool[0].pool, state }], name);
    assert.match(r.words, /quote asset has no usable stored dollar value at the observation/, name);
    const lad = ticketRows(ob);
    const at500 = lad.best.find((b) => b.size_usd === 500);
    assert.equal(at500.best, null, `${name}: no reading at the ticket's reference size`);
    assert.deepEqual([at500.estimate.decision, at500.estimate.label, at500.estimate.quote_usd], [false, 'Estimate at the configured quote-asset value; not a decision', '1'], name);
    assert.equal(at500.estimate.cost_pct, '4.9999998', name);
    // An estimate within the limit never proves a pass: the ticket holds and says why (D1 correction).
    const v = G.verdict({ subjects: [], exits: lad, params: { exit_cost_limit_pct: 5, exit_size_usd: 500 }, now: 0 });
    assert.deepEqual(v.findings.filter((f) => f.rule_id === 'CG-10').map((f) => f.tier), ['hold'], `${name}: an estimate never decides a pass`);
    assert.equal(v.tier, 'hold', name);
    assert.match(v.findings.find((f) => f.rule_id === 'CG-10').words, /is not measured: the quote asset's stored dollar value at the observation is not usable \(.+\)\. At its configured value it would be 5\.000%, an estimate and not a decision/, name);
  }
  // No desk freshness limit: nothing can be fresh, so it holds.
  const nolimit = guard(obs(pool), { stale: null });
  assert.equal(nolimit.ok, false);
  assert.equal(G.quoteValue(obs(pool), pool[0], undefined).state, 'no_limit');
  // An estimate over the limit is still only an estimate on the ticket's row, but it is a floor on
  // D1's cost, so the ticket blocks as the setting alone would.
  const overLad = ticketRows(obs([v3(470000000n)], { ref: null }));
  const overEst = overLad.best.find((b) => b.size_usd === 500);
  assert.deepEqual([overEst.best, overEst.estimate.cost_pct_3], [null, '7.000']);
  const ov = G.verdict({ subjects: [], exits: overLad, params: { exit_cost_limit_pct: 5, exit_size_usd: 500 }, now: 0 });
  assert.deepEqual(ov.findings.filter((f) => f.rule_id === 'CG-10').map((f) => [f.tier, f.words]), [['block', 'The complete on-chain exit cost at $500 is at least 7.000% with the quote asset at its configured value, over the 5% limit; its stored dollar value at the observation is not usable (it is not on record).']]);
});

// The ticket's verdict at the reference size, on an exitLadder.
const verdictOf = (lad) => G.verdict({ subjects: [], exits: lad, params: { exit_cost_limit_pct: 5, exit_size_usd: 500 }, now: 0 });
const cg10Of = (v) => v.findings.filter((f) => f.rule_id === 'CG-10').map((f) => f.tier);
const UNMAPPED = ADDR('5dc'); // a fictional quote asset D1 does not cover: the setting alone, as Option A reads it

test('QV6: missing USDC evidence never removes a block the setting alone imposes, and an estimate never proves a pass (V3 token0, V3 token1, V2)', () => {
  // Each line: the sale's $500 proceeds, USDC's setting, what the ticket reads with no usable USDC
  // value, with the setting alone (Option A: the same pool on an unmapped quote asset) and with a
  // fresh stored $1.
  const LINES = [
    ['9% at the setting', 460000000n, '1', 'block', 'block', 'block'],
    ['5.005% with USDC set 1% high (the false pass)', 479975000n, '1.01', 'hold', 'none', 'block'],
    ['exactly 5% at the setting', 480000000n, '1', 'hold', 'none', 'none'],
    ['one base unit less', 479999999n, '1', 'block', 'block', 'block'],
    ['4% at the setting', 485000000n, '1', 'hold', 'none', 'none'],
  ];
  const tierOf = (v) => (cg10Of(v)[0] || 'none');
  const at5 = reserveFor(480000000n);
  for (const [name, out, set, missing, optionA, fresh] of LINES) {
    const shapes = [
      ['V3 token0', (q) => [v3(out, { set, quote: q })], '3.96'],
      ['V3 token1', (q) => [v3(out, { set, quote: q, side: 'token1' })], '3.96'],
    ];
    // The V2 pair whose 125-token sale pays at least `out` (sized at $4, as QV5's).
    const r = reserveFor(out);
    if (out === 480000000n) assert.equal(r.rt, at5.rt);
    shapes.push(['V2', (q) => [v2(out === 479999999n ? at5.rt - 1n : r.rt, { set, quote: q })], '4']);
    for (const [shape, pools, price] of shapes) {
      const rows = (o) => ticketRows(o, { price });
      const without = verdictOf(rows(obs(pools(ETH_USDC), { ref: null, stored: price })));
      const a = verdictOf(rows(obs(pools(UNMAPPED), { ref: null, stored: price })));
      const withValue = verdictOf(rows(obs(pools(ETH_USDC), { usdc: '1', stored: price })));
      assert.deepEqual([tierOf(without), tierOf(a), tierOf(withValue)], [missing, optionA, fresh], `${shape}, ${name}`);
      // Never looser than Option A: whatever Option A blocks, missing evidence blocks.
      if (tierOf(a) === 'block') assert.equal(tierOf(without), 'block', `${shape}, ${name}`);
      if (missing !== 'none') assert.notEqual(without.tier, 'none');
    }
  }
  // A sweep around the line: with no usable value the ticket blocks exactly where the setting alone
  // blocks, and holds wherever the setting alone would pass. It never reads clear on an estimate.
  for (const set of ['0.99', '1', '1.01']) {
    for (let out = 479900000n; out <= 480100000n; out += 12500n) {
      const without = verdictOf(ticketRows(obs([v3(out, { set })], { ref: null })));
      const a = verdictOf(ticketRows(obs([v3(out, { set, quote: UNMAPPED })], { ref: null })));
      assert.deepEqual(cg10Of(without), cg10Of(a)[0] === 'block' ? ['block'] : ['hold'], `${set} ${out}`);
    }
  }
  // The sell tax unmeasured: no cost is complete, so nothing is proven either way, as with the setting alone.
  const untaxed = (q) => ({ ...obs([v3(460000000n, { quote: q })], { ref: null }), transfer_probe: { status: 'unavailable' } });
  assert.deepEqual([cg10Of(verdictOf(ticketRows(untaxed(ETH_USDC)))), cg10Of(verdictOf(ticketRows(untaxed(UNMAPPED))))], [[], []]);
});

test('QV7: mixed pools: a measured reading within the limit proves the size; an estimate never does, and never turns a measured over-limit reading into a pass', () => {
  const other = (out) => ({ ...v3(out, { quote: UNMAPPED }), pool: '0x00000000000000000000000000000000000c0de4' });
  const usdc = (out) => v3(out);
  const lines = [
    ['the other pool reads 4.5%, the USDC pool would read 1%', [other(482500000n), usdc(500000000n)], []],
    ['the other pool reads 6%, the USDC pool would read 4%', [other(475000000n), usdc(485000000n)], ['hold']],
    ['the other pool reads 6%, the USDC pool would read 7%', [other(475000000n), usdc(470000000n)], ['block']],
  ];
  for (const [name, pools, want] of lines) {
    const v = verdictOf(ticketRows(obs(pools, { ref: null })));
    assert.deepEqual(cg10Of(v), want, name);
    // With the value on record each pool is a reading, and the cheapest decides, as before.
    const fresh = verdictOf(ticketRows(obs(pools, { usdc: '1' })));
    assert.deepEqual(cg10Of(fresh), name.includes('7%') ? ['block'] : [], `${name}, USDC on record`);
  }
  const words = verdictOf(ticketRows(obs(lines[2][1], { ref: null }))).findings.find((f) => f.rule_id === 'CG-10').words;
  assert.equal(words, 'The complete on-chain exit cost at $500 is 6.000%, over the 5% limit.', 'the measured pool is the cheapest complete figure');
});

test('QV4: the lower value only: a stored value above the setting never loosens a reading', () => {
  for (const usdc of ['1', '1.02', '7']) {
    const r = guard(obs([v3(479999999n)], { usdc }));
    assert.deepEqual([r.ok, r.cost_pct, r.quote_usd, r.quote_basis], [false, '5.0000002', '1', 'setting'], usdc);
  }
  // The backup's stored USDC value on 2026-11-10 ($0.999484): an exactly-5% sale at the setting reads 5.0005 and holds.
  const live = guard(obs([v3(480000000n)], { usdc: '0.999484' }));
  assert.deepEqual([live.ok, live.cost_pct, live.quote_basis], [false, '5.000516266393459025', 'stored']);
});

test('QV5: one calculation: the ticket\'s reference rows and the guard read the same cost, each at its own quantity', () => {
  // Quotes at the ticket's three sizes, recorded with their token inputs (25, 125 and 500 tokens).
  const labels = (o500) => ({ 100: ['25000000', 96000000n], 500: ['125000000', o500], 2000: ['500000000', 1901000000n] });
  for (const [o500, want] of [[479975000n, false], [480000000n, true]]) {
    const o = obs([v3(null, { set: '1.01', labels: labels(o500) })], { usdc: '1' });
    const lad = ticketRows(o);
    for (const [size, qty] of [[500, '125'], [2000, '500']]) {
      const row = lad.best.find((b) => b.size_usd === size).best;
      const g = guard(o, { quantity: qty });
      assert.deepEqual([row.cost_pct, row.value_basis, row.quote_basis, row.quote_usd], [g.cost_pct, g.value_basis, g.quote_basis, g.quote_usd], `$${size} row against the guard at ${qty} tokens`);
    }
    const g = guard(o);
    assert.equal(g.ok, want);
    const v = G.verdict({ subjects: [], exits: lad, params: { exit_cost_limit_pct: 5, exit_size_usd: 500 }, now: 0 });
    assert.equal(v.findings.some((f) => f.rule_id === 'CG-10'), !want, 'CG-10 blocks the ticket exactly when the guard holds the order');
  }
  // The ticket's V2 row is sized at the ticket's price (125 tokens at $4) and reads as the guard does.
  const at5 = reserveFor(480000000n);
  const o = obs([v2(at5.rt - 1n, { set: '1.01' })], { usdc: '1', stored: '4' });
  const row = ticketRows(o, { price: '4' }).best.find((b) => b.size_usd === 500).best;
  const g = guard(o);
  assert.deepEqual([row.cost_pct, row.quote_basis, g.cost_pct, g.ok], ['5.0000002', 'stored', '5.0000002', false]);
});

// ---------------------------------------------------------------------------
// The capture to the guard, on a fictional chain 1 whose pools sell into
// Ethereum's USDC address. The fictional token has 6 decimals and sorts below
// USDC, so it is token0, as UNI and NMR are on Ethereum. A thin fictional
// pair (an unmapped quote asset) is where the sell probe runs.

const KEY = 'FICTIONALkey_0123456789';
const FACT3E = ADDR('fac3e1');
const QUOTER_E = ADDR('90e1');
const QCODE_E = '0x6080604052601e';
const INIT3E = K.keccak256Hex('0x0f1c7101e1');
const POOL3E = K.create2Address(FACT3E, K.keccak256Hex(`0x${Aw(TOKEN)}${Aw(ETH_USDC)}${W(3000)}`), INIT3E);
const FACT2E = ADDR('fac2e1');
const INIT2E = K.keccak256Hex('0x0f1c7102e1');
const PAIR2E = K.create2Address(FACT2E, K.keccak256Hex(`0x${TOKEN.slice(2)}${ETH_USDC.slice(2)}`), INIT2E);
assert.ok(TOKEN < ETH_USDC, 'the fictional token sorts below Ethereum\'s USDC');
const row3 = (set, chain = '1') => ({ chain_id: chain, name: 'Fictional V3 (Ethereum USDC)', kind: 'v3', factory: FACT3E, init_code_hash: INIT3E, fee_tiers: [3000], quoter: QUOTER_E, quoter_code_hash: K.keccak256Hex(QCODE_E), quotes: [{ address: ETH_USDC, decimals: 6, usd_value: set }] });
const row2 = (set, chain = '1') => ({ chain_id: chain, name: 'Fictional V2 (Ethereum USDC)', kind: 'v2', factory: FACT2E, init_code_hash: INIT2E, fee_bps: 30, quotes: [{ address: ETH_USDC, decimals: 6, usd_value: set }] });
const THIN_PAIR = { ...ROW, chain_id: '1' };
let PAY = () => 0n; // the quoter's answer by token base units
let RT = 1n; // the V2 pair's token reserve
const chain1 = () => ({
  [TOKEN]: { code: TOKEN_CODE, fns: tokenFns({ [sel('decimals()')]: () => ok(6) }) },
  [ETH_USDC]: { code: '0x60806040526ee1', fns: { [sel('decimals()')]: () => ok(6), [sel('balanceOf(address)')]: (S, f, d) => ok(`0x${d.subarray(16, 36).toString('hex')}` === PAIR2E ? 4n * RT : `0x${d.subarray(16, 36).toString('hex')}` === POOL3E ? 1000000000n : 0n) } },
  [FACT3E]: { code: '0x60806040526e03', fns: { [sel('getPool(address,address,uint24)')]: () => okA(POOL3E) } },
  [POOL3E]: { code: '0x60806040526e04', fns: { [sel('token0()')]: () => okA(TOKEN), [sel('token1()')]: () => okA(ETH_USDC), [sel('slot0()')]: () => ok(2n * Q96, 0, 0, 0, 0, 0, 1) } },
  [QUOTER_E]: { code: QCODE_E, fns: { [sel('quoteExactInputSingle((address,address,uint256,uint24,uint160))')]: (S, f, d) => ok(PAY(arg(d, 2)), 0, 0, 0) } },
  [FACT2E]: { code: '0x60806040526e05', fns: { [sel('getPair(address,address)')]: () => okA(PAIR2E) } },
  [PAIR2E]: { code: '0x60806040526e06', fns: { [sel('token0()')]: () => okA(TOKEN), [sel('token1()')]: () => okA(ETH_USDC), [sel('getReserves()')]: () => ok(RT, 4n * RT, 0) } },
});
const PRICE = 4; // the token's stored price, equal to the pools' own

function desk(t, { factories, usdc = 1, usdcAgeMs = 60000, mode = 'enforce', chain = '1', chainName = 'ethereum' }) {
  const w = H.tempWorkspace('cg14-quote-value', { contracts: { daily_cu_cap: 1000000, monthly_cu_cap: 10000000, pool_factories: factories, max_log_blocks: 1000 } });
  t.after(w.cleanup);
  t.after(() => { PAY = () => 0n; RT = 1n; });
  assert.ok(under(w.root), 'workspace under the disposable root');
  const pid = H.addFixtureProject(w.ws).project_id;
  const file = w.ws.abs(`projects/${pid}/project.json`);
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  p.identity.assets = [{ chain: chainName, contract_address: TOKEN }];
  fs.writeFileSync(file, JSON.stringify(p, null, 2));
  w.ws.settings.tickets = { contract_gate: { mode } };
  w.ws.settings.contracts.network_fee_ceiling_usd = { [chain]: 5 };
  return { ...w, pid, chain, usdc, usdcAgeMs, project: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}
let blockN = 71000;
let calls = [];
// `edit` changes the market file after it is written as the desk's refresh writes it (a row or a
// provider as something else might leave them: an older file, a restore, a hand edit).
async function observe(s, { usdc = s.usdc, usdcAgeMs = s.usdcAgeMs, edit } = {}) {
  H.freshPrice(s.ws, 'example-payfi-fictional', PRICE);
  const file = s.ws.abs('market-data/latest.json');
  const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete cur.assets['usd-coin'];
  fs.writeFileSync(file, JSON.stringify(cur));
  if (usdc !== null) H.freshPrice(s.ws, 'usd-coin', usdc, usdcAgeMs);
  if (edit) { const m = JSON.parse(fs.readFileSync(file, 'utf8')); edit(m); fs.writeFileSync(file, JSON.stringify(m)); }
  const block = liveBlock(blockN += 1);
  const S = baseState({ owner: TL, minter: TL, bal: { [PAIR]: 4000000n * 10n ** 18n, [BUYER]: 50000n * 10n ** 18n, [PAIR2E]: RT, [POOL3E]: 1000n * 10n ** 6n } });
  const w = world({ S, tokenCode: TOKEN_CODE, extra: { ...timelocks, ...chain1() }, block, chainIdHex: `0x${Number(s.chain).toString(16)}` });
  await CF.probeNetwork(s.ws, s.chain, { fetchImpl: w.fetch, key: KEY, now: Date.now });
  const from = w.calls.length;
  const r = await CF.observeProject(s.ws, s.pid, { fetchImpl: w.fetch, key: KEY, sourceImpl: sources, now: Date.now });
  assert.equal(r.results[0].status, 'saved', JSON.stringify(r.results[0]));
  calls = w.calls.slice(from);
  return CF.readObservation(s.ws, s.pid, r.results[0].observation_id).observation;
}
// The trader's real guard on the desk's current observation, and the ticket's real attestation.
function guardNow(s, { quantity = '125', entry = '3.9' } = {}) {
  const project = s.project();
  const idNow = T.contractIdentityNow(s.ws, project);
  const receipt = { desk: { contract_gate: { identity_key: idNow.identity_key }, sizing: { max_exit_cost_pct: 5 } } };
  return T.contractOpenGuard(s.ws, project, receipt, { notionalUsd: (Number(quantity) * Number(entry)).toString(), priceUsd: entry, quantity });
}
const ticketNow = (s) => T.contractVerdictNow(s.ws, s.project(), { exit_sizes_usd: [100, 500, 2000], exit_size_usd: 500, max_exit_cost_pct: 5 }, Date.now());
const cg10 = (v) => v.findings.find((f) => f.rule_id === 'CG-10' && /on-chain exit cost/.test(f.words)) || null;
// Quotes by token base units: the $100, $500 and $2,000 quantities at $4 are 25, 125 and 500 tokens.
const quotesWith = (o500) => (q) => (q === 125000000n ? o500 : q === 25000000n ? 96000000n : q === 500000000n ? 1901000000n : 0n);

test('QC1: the capture records Ethereum USDC\'s stored value with its provider time and identity, and reads nothing more from the chain', async (t) => {
  const s = desk(t, { factories: [THIN_PAIR, row3('1.01')] });
  PAY = quotesWith(479975000n);
  const o = await observe(s);
  const p = o.pools.find((x) => x.pool === POOL3E);
  assert.equal(p.counted, true, p.excluded);
  assert.deepEqual(p.quoted_in, { 100: '25000000', 500: '125000000', 2000: '500000000' });
  assert.deepEqual(p.spot, { sqrt_price_x96: (2n * Q96).toString(), token_side: 'token0' });
  const row = JSON.parse(fs.readFileSync(s.ws.abs('market-data/latest.json'), 'utf8')).assets['usd-coin'];
  assert.deepEqual(o.quote_price_ref, { [ETH_USDC]: { usd: '1', as_of: row.source_last_updated_at, fetched_at: row.fetched_at, source: 'coingecko_stored', coingecko_id: 'usd-coin', chain_id: '1', address: ETH_USDC } });
  assert.equal(o.subject.chain_id, '1');
  // The record's hash covers it.
  const { sha256, ...rest } = o;
  assert.equal(crypto.createHash('sha256').update(G.canonicalJson(rest)).digest('hex'), sha256);
  // The same reads with no stored USDC value: no chain call is added by the value.
  const n = calls.length;
  const without = await observe(s, { usdc: null });
  assert.equal(without.quote_price_ref, undefined);
  assert.equal(calls.length, n, 'the same number of chain calls');
  assert.equal(without.identity_key, o.identity_key, 'the value does not move the contract\'s identity fingerprint');
  // A pool on an unmapped quote asset gets no entry.
  assert.equal(Object.keys(o.quote_price_ref).length, 1);
});

test('QC2: capture to guard, V3 token0: 5.005% with USDC set at $1.01 holds; exactly 5% passes; one base unit less holds; the ticket blocks exactly when the guard holds', async (t) => {
  const s = desk(t, { factories: [THIN_PAIR, row3('1.01')] });
  PAY = quotesWith(479975000n);
  await observe(s);
  const over = guardNow(s);
  assert.equal(over && over.rule_id, 'CG-14');
  assert.deepEqual([over.fitted.cost_pct, over.fitted.quote_basis, over.fitted.quote_usd, over.fitted.pool], ['5.005', 'stored', '1', POOL3E], over.words);
  assert.match(over.words, /with the quote asset at its stored \$1, is 5\.005%, over the 5% limit/);
  assert.match(cg10(ticketNow(s)).words, /at \$500 is 5\.005%, over the 5% limit/);
  // Exactly 5% on the approved basis (USDC set and stored at $1): passes; the ticket is clear.
  const s1 = desk(t, { factories: [THIN_PAIR, row3('1')] });
  PAY = quotesWith(480000000n);
  await observe(s1);
  assert.equal(guardNow(s1), null, 'the guard lets the order open');
  assert.equal(cg10(ticketNow(s1)), null);
  PAY = quotesWith(479999999n);
  await observe(s1);
  const less = guardNow(s1);
  assert.deepEqual([less.rule_id, less.fitted.cost_pct], ['CG-14', '5.0000002']);
  assert.match(cg10(ticketNow(s1)).words, /at \$500 is 5\.000%/);
});

test('QC3: capture to guard, V2: the pair\'s reserves are the evidence; the same three lines', async (t) => {
  const over = reserveFor(479975000n);
  const at5 = reserveFor(480000000n);
  const s = desk(t, { factories: [THIN_PAIR, row2('1.01')] });
  RT = over.rt;
  const o = await observe(s);
  assert.equal(o.pools.find((x) => x.pool === PAIR2E).counted, true, o.pools.find((x) => x.pool === PAIR2E).excluded);
  assert.equal(o.quote_price_ref[ETH_USDC].usd, '1');
  const g = guardNow(s);
  assert.equal(g && g.rule_id, 'CG-14');
  assert.ok(Number(g.fitted.cost_pct) >= 5.005 && Number(g.fitted.cost_pct) < 5.0051, g.fitted.cost_pct);
  assert.deepEqual([g.fitted.pool, g.fitted.quote_basis], [PAIR2E, 'stored']);
  const s1 = desk(t, { factories: [THIN_PAIR, row2('1')] });
  RT = at5.rt;
  await observe(s1);
  assert.equal(guardNow(s1), null, 'exactly 5% passes');
  RT = at5.rt - 1n;
  await observe(s1);
  assert.equal(guardNow(s1).fitted.cost_pct, '5.0000002');
});

test('QC4: V3 token1 through the same guard: the captured record with its pool read from the other side', async (t) => {
  // The fictional token sorts below USDC, so the capture always records token0. The
  // gate's token1 branch is shown on the captured record, resealed with the same
  // pool price written as token1 reads it (2^192 / s^2 = 4).
  const s = desk(t, { factories: [THIN_PAIR, row3('1.01')] });
  const reseal = (ob) => {
    const f = s.ws.abs(CF.obsPath(s.pid, ob.observation_id));
    assert.ok(under(f));
    const { sha256: _old, ...rest } = JSON.parse(fs.readFileSync(f, 'utf8'));
    rest.pools.find((x) => x.pool === POOL3E).spot = { sqrt_price_x96: (Q96 / 2n).toString(), token_side: 'token1' };
    rest.sha256 = crypto.createHash('sha256').update(G.canonicalJson(rest)).digest('hex');
    fs.writeFileSync(f, JSON.stringify(rest, null, 2));
  };
  for (const [out, set, want] of [[479975000n, '1.01', '5.005'], [480000000n, '1', null], [479999999n, '1', '5.0000002']]) {
    s.ws.settings.contracts.pool_factories = [THIN_PAIR, row3(set)];
    PAY = quotesWith(out);
    reseal(await observe(s));
    const g = guardNow(s);
    if (want === null) assert.equal(g, null, 'exactly 5% passes');
    else assert.deepEqual([g.rule_id, g.fitted.cost_pct], ['CG-14', want]);
  }
});

test('QC5: capture to guard with no usable USDC value: missing, or older than the freshness limit: enforce holds and says why', async (t) => {
  for (const [name, opts] of [['none stored', { usdc: null }], ['three hours old', { usdcAgeMs: 3 * 3600000 }]]) {
    const s = desk(t, { factories: [THIN_PAIR, row3('1')] });
    PAY = quotesWith(480000000n); // a valid exit at exactly 5%, if USDC were proven
    await observe(s, opts);
    const g = guardNow(s);
    assert.equal(g && g.rule_id, 'CG-14', name);
    assert.equal(g.fitted.no_quote_price, 1, name);
    assert.match(g.words, /quote asset has no usable stored dollar value at the observation/, name);
  }
});

// ---------------------------------------------------------------------------
// D1 corrections after the independent review (2026-11-10).

const iso = (ms) => new Date(ms).toISOString();
const SIZING = { exit_sizes_usd: [100, 500, 2000], exit_size_usd: 500, max_exit_cost_pct: 5 };
// A receipt as the paper mandate's contract check reads it: the attestation's fingerprint now.
const receiptNow = (s) => ({ desk: { contract_gate: { identity_key: T.contractIdentityNow(s.ws, s.project()).identity_key }, sizing: { max_exit_cost_pct: 5 } }, packet: { path: 'none', sha256: 'none' } });
// Rewrites the desk's current observation and seals it again through the desk's own hash.
function reseal(s, ob, edit) {
  const f = s.ws.abs(CF.obsPath(s.pid, ob.observation_id));
  assert.ok(under(f));
  const { sha256: _old, ...rest } = JSON.parse(fs.readFileSync(f, 'utf8'));
  edit(rest);
  rest.sha256 = crypto.createHash('sha256').update(G.canonicalJson(rest)).digest('hex');
  fs.writeFileSync(f, JSON.stringify(rest, null, 2));
  const back = CF.readObservation(s.ws, s.pid, ob.observation_id);
  assert.ok(back.ok, back.words);
  return back.observation;
}
const exitTiers = (v) => v.findings.filter((f) => f.rule_id === 'CG-10' && /on-chain exit cost/.test(f.words)).map((f) => f.tier);
const stateOf = (g) => (g === null ? 'opens' : g.fitted && g.fitted.no_quote_price ? g.fitted.quote_states.map((q) => q.state).join(',') : `holds at ${g.fitted ? g.fitted.cost_pct : g.rule_id}`);

test('QC6: observe mode with the sell tax measured: missing or stale USDC evidence never lets the ticket or the paper mandate pass an exit the setting alone blocks, nor one only an estimate supports', async (t) => {
  const LINES = [
    ['9%, no USDC value on record', 460000000n, { usdc: null }, 'block'],
    ['9%, USDC value three hours old', 460000000n, { usdcAgeMs: 3 * 3600000 }, 'block'],
    ['9%, USDC value fresh on record', 460000000n, {}, 'block'],
    ['4%, no USDC value on record', 485000000n, { usdc: null }, 'hold'],
    ['4%, USDC value three hours old', 485000000n, { usdcAgeMs: 3 * 3600000 }, 'hold'],
    ['4%, USDC value fresh on record (the passing control)', 485000000n, {}, 'none'],
  ];
  for (const [name, out, opts, want] of LINES) {
    const s = desk(t, { factories: [THIN_PAIR, row3('1')], mode: 'observe' });
    PAY = quotesWith(out);
    const o = await observe(s, opts);
    assert.deepEqual([o.transfer_probe.status, o.transfer_probe.sell_path.tax_bps], ['ok', 0], `${name}: the sell tax is measured, so no other gap masks the result`);
    const v = ticketNow(s);
    const m = T.mandateContractEvidence(s.ws, s.project(), receiptNow(s), SIZING, Date.now());
    assert.equal(guardNow(s), null, `${name}: the trader's guard is not read in observe mode`);
    if (want === 'none') {
      assert.deepEqual(exitTiers(v), [], name);
      assert.equal(m, null, `${name}: nothing stands against the grant`);
      continue;
    }
    assert.deepEqual(exitTiers(v), [want], `${name}: ${v.words}`);
    assert.equal(v.tier, want, name);
    assert.match(m, want === 'block' ? /^The contract gate blocks: / : /^The contract gate holds: /, name);
    if (opts.usdc === null) assert.match(v.findings.find((f) => f.rule_id === 'CG-10').words, /not usable \(it is not on record\)/, name);
    if (opts.usdcAgeMs) assert.match(v.findings.find((f) => f.rule_id === 'CG-10').words, /not usable \(its stored price \(.+\) is .+ minutes before its block .+, past the 90-minute limit\)/, name);
  }
});

test('QC7: provider time is required: a fresh fetch never stands in for a missing, malformed or stale source time (capture to guard)', async (t) => {
  const row = (over) => (n) => ({ id: 'usd-coin', price_usd: 1, fetched_at: iso(n - 60000), ...over(n) });
  const LINES = [
    ['source and fetch time one minute old (control)', row((n) => ({ source_last_updated_at: iso(n - 60000) })), 'opens', (n, e) => e.as_of === iso(n - 60000)],
    ['no source time, fetched a minute ago', row(() => ({})), 'no_time', (n, e) => e.as_of === null],
    ['source time null, fetched a minute ago', row(() => ({ source_last_updated_at: null })), 'no_time', (n, e) => e.as_of === null],
    ['source time an empty text, fetched a minute ago', row(() => ({ source_last_updated_at: '' })), 'no_time', (n, e) => e.as_of === null],
    ['source time not UTC text, fetched a minute ago', row(() => ({ source_last_updated_at: '2026-11-10 12:07' })), 'malformed_time', (n, e) => e.as_of === '2026-11-10 12:07'],
    ['source time a number, fetched a minute ago', row((n) => ({ source_last_updated_at: n - 60000 })), 'malformed_time', (n, e) => typeof e.as_of === 'number'],
    ['source time three hours old, fetched a minute ago', row((n) => ({ source_last_updated_at: iso(n - 3 * 3600000) })), 'stale', (n, e) => e.as_of === iso(n - 3 * 3600000)],
    ['no source time, fetched three hours ago', (n) => ({ id: 'usd-coin', price_usd: 1, fetched_at: iso(n - 3 * 3600000) }), 'no_time', (n, e) => e.as_of === null],
  ];
  for (const [name, mk, want, recorded] of LINES) {
    const s = desk(t, { factories: [THIN_PAIR, row3('1')] });
    PAY = quotesWith(480500000n); // 4.9% when USDC is proven at $1
    const n = Date.now();
    const r = mk(n);
    const o = await observe(s, { usdc: null, edit: (m) => { m.assets['usd-coin'] = r; } });
    const e = o.quote_price_ref && o.quote_price_ref[ETH_USDC];
    assert.ok(e, `${name}: the value is recorded with what it carries`);
    assert.ok(recorded(n, e), `${name}: as_of ${JSON.stringify(e.as_of)}`);
    assert.equal(e.fetched_at, r.fetched_at, `${name}: the fetch time is kept as provenance`);
    assert.equal(stateOf(guardNow(s)), want, name);
    if (want !== 'opens') assert.deepEqual(exitTiers(ticketNow(s)), ['hold'], `${name}: the ticket holds on the estimate`);
  }
});

test('QC8: the value is used only for the identity the record itself establishes: the row\'s asset, the file\'s source, this chain and this contract', async (t) => {
  const fresh = () => ({ source_last_updated_at: iso(Date.now() - 60000), fetched_at: iso(Date.now() - 60000) });
  const LINES = [
    ['control: a usd-coin row in CoinGecko\'s file', (m) => { m.assets['usd-coin'] = { id: 'usd-coin', price_usd: 1, ...fresh() }; }, 'opens', { coingecko_id: 'usd-coin', source: 'coingecko_stored' }],
    ['the row under usd-coin names another asset', (m) => { m.assets['usd-coin'] = { id: 'tether', symbol: 'USDT', price_usd: 1, ...fresh() }; }, 'identity', { coingecko_id: 'tether', source: 'coingecko_stored' }],
    ['the row names no asset', (m) => { m.assets['usd-coin'] = { price_usd: 1, ...fresh() }; }, 'identity', { coingecko_id: null, source: 'coingecko_stored' }],
    ['the file says another provider', (m) => { m.assets['usd-coin'] = { id: 'usd-coin', price_usd: 1, ...fresh() }; m.provider = 'fictional-demo'; }, 'identity', { coingecko_id: 'usd-coin', source: 'unverified_stored:fictional-demo' }],
    ['the file names no provider', (m) => { m.assets['usd-coin'] = { id: 'usd-coin', price_usd: 1, ...fresh() }; delete m.provider; }, 'identity', { coingecko_id: 'usd-coin', source: 'unverified_stored:no_provider' }],
  ];
  for (const [name, edit, want, ident] of LINES) {
    const s = desk(t, { factories: [THIN_PAIR, row3('1')] });
    PAY = quotesWith(480500000n);
    const o = await observe(s, { usdc: null, edit });
    const e = o.quote_price_ref[ETH_USDC];
    assert.deepEqual([e.coingecko_id, e.source, e.chain_id, e.address], [ident.coingecko_id, ident.source, '1', ETH_USDC], name);
    assert.equal(stateOf(guardNow(s)), want, name);
  }
  // Another chain or another contract on the record, sealed again: refused as the identity it names.
  const s = desk(t, { factories: [THIN_PAIR, row3('1')] });
  PAY = quotesWith(480500000n);
  const o = await observe(s);
  assert.equal(stateOf(guardNow(s)), 'opens', 'control: the record as captured');
  for (const [name, over] of [['another chain', { chain_id: '8453' }], ['another contract', { address: BASE_USDC }]]) {
    reseal(s, o, (r) => { r.quote_price_ref[ETH_USDC] = { ...r.quote_price_ref[ETH_USDC], ...over }; });
    assert.equal(stateOf(guardNow(s)), 'identity', name);
  }
  // A capture on another chain: Ethereum USDC's address there is not the mapped asset, so its
  // stored value is not attached, and the pool keeps its setting alone (D1 covers Ethereum only).
  const b = desk(t, { factories: [{ ...ROW, chain_id: '8453' }, row3('1', '8453')], chain: '8453', chainName: 'base' });
  PAY = quotesWith(480500000n);
  const ob = await observe(b);
  assert.equal(ob.subject.chain_id, '8453');
  assert.equal(ob.quote_price_ref, undefined, 'nothing is recorded for an asset that is not mapped on this chain');
  const fx = G.fittedExit(ob, { notionalUsd: '487.5', priceUsd: '3.9', quantity: '125', networkFeeUsd: '5', limitPct: 5, priceStaleMinutes: STALE });
  assert.deepEqual([fx.ok, fx.quote_basis, fx.no_quote_price], [true, undefined, undefined]);
});

test('QC9: the ticket holds a USDC value to the desk\'s own freshness limit, as the guard does; the same observation passes under the wider limit', async (t) => {
  const s = desk(t, { factories: [THIN_PAIR, row3('1')] });
  PAY = quotesWith(480000000n); // exactly 5% with USDC at $1
  const o = await observe(s);
  // Times fixed against the block, so nothing depends on the clock: the token's stored price at the
  // block's own time (its own freshness check always passes), USDC's exactly 60 minutes before it.
  const blockMs = Date.parse(o.block.timestamp);
  reseal(s, o, (r) => { r.price_ref.as_of = iso(blockMs); r.quote_price_ref[ETH_USDC].as_of = iso(blockMs - 60 * 60000); });
  const LIMITS = [
    [90, [], 'opens'],
    [60, [], 'opens'], // exactly at the limit passes
    [59, ['hold'], 'stale'],
    [30, ['hold'], 'stale'],
  ];
  for (const [limit, ticket, guard] of LIMITS) {
    s.ws.settings.freshness = { ...s.ws.settings.freshness, price_stale_minutes: limit };
    const v = ticketNow(s);
    assert.deepEqual(exitTiers(v), ticket, `limit ${limit}: ${v.words}`);
    assert.equal(stateOf(guardNow(s)), guard, `limit ${limit}`);
    if (ticket.length) assert.match(v.findings.find((f) => f.rule_id === 'CG-10').words, new RegExp(`60\\.000 minutes before its block .+, past the ${limit}-minute limit`));
  }
});
