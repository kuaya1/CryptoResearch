'use strict';
// CG-14 and the pool's own price (cr-contract-exit@2; Eric's option A,
// 2026-11-10). FICTIONAL chain, pools, quoter, desk and prices; temporary
// workspaces only; no network, no key.
//
// The rules under test:
// - A sale CG-14 values at the observation is measured against three
//   yardsticks: quantity x entry, quantity x the stored price, and quantity x
//   the price of the pool it is sold into at the observation's block. The
//   largest value is used, so a fresh stored price under the pool's cannot
//   make a sale look cheaper than it is in that pool.
// - The pool's own price is a pair's reserve ratio, or a concentrated pool's
//   slot0 square-root price (`spot`) by the side the token sits on. A
//   concentrated pool's `reserves` are balances and are never read as a price.
// - With no pool price on record, CG-14 does not prove the sale in that pool.
//   A ladder row (the ticket's reading) of such a pool keeps the stored-price
//   basis.
// - The capture reads slot0() once for each concentrated pool it counts,
//   pinned to the observation's block.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Where the fixtures may live (as in the other CG-14 suites): each test's
// workspace is its own directory under os.tmpdir(); an audit run names its
// disposable folder in CR_AUDIT_SAFE_ROOT, which must hold os.tmpdir().
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
const RPC = require('../core/contract-rpc');
const T = require('../core/tickets');
const TD = require('../core/trader-desk');
const TF = require('./trader-fixture');
const H = require('./helpers');
const { exact: { dec, str, mulCeil } } = require('../core/trade-risk');
const { world, baseState, ROW, T0, T1, PAIR, USDC, BUYER, ADDR, Aw, W, sel, arg, argA, ok, okA, TOKEN, TOKEN_CODE, sources, timelocks, liveBlock, TL, sqrtAt, spotAt, slot0At } = require('./contract-world');

const E18 = 10n ** 18n;
const Q96 = 2n ** 96n;
const Q192 = 2n ** 192n;
const R100 = 14204545000000000000n; // $100 at $7.04, whole lots
const R500 = 71022727000000000000n; // $500 at $7.04, whole lots
const R2000 = 284090909000000000000n; // $2,000 at $7.04, whole lots
const STORED = '7.04';
const POOL_USD = '7.11744'; // the pool trades 1.1% over the stored price
const SQRT = sqrtAt(POOL_USD);

// A one-range concentrated pool at SQRT with liquidity L and a 0.30% fee:
// what it pays for `q` token base units (Uniswap V3's exact-input step for
// token0, rounded as the pool rounds). It stands in for the quoter.
const payOf = (L) => (q) => {
  const net = (q * 997000n) / 1000000n;
  if (net === 0n) return 0n;
  const n1 = L << 96n;
  const p = n1 * SQRT;
  const d = n1 + net * SQRT;
  return (L * (SQRT - (p / d + (p % d === 0n ? 0n : 1n)))) / Q96;
};
// SHALLOW: the $500 quantity costs 6.000% against the pool with a $0.25 fee
// (4.966% against the stored price). DEEP: the $2,000 quantity costs 5.500%
// against the pool with a $0.25 fee and 5.735% with a $5 fee, under 5% against
// the stored price either way; the $500 quantity costs 1.699% and 2.639%.
const SHALLOW = payOf(3144274459544531n);
const DEEP = payOf(13766816862370728n);

// Exact rationals for the expected values, kept apart from the gate's own.
const rr = (n, d = 1n) => ({ n, d });
const rAdd = (a, b) => rr(a.n * b.d + b.n * a.d, a.d * b.d);
const rSub = (a, b) => rr(a.n * b.d - b.n * a.d, a.d * b.d);
const rMul = (a, b) => rr(a.n * b.n, a.d * b.d);
const rDiv = (a, b) => rr(a.n * b.d, a.d * b.n);
// (S - received + fee) / S x 100 as the gate prints it: 18 places, rounded up.
const costOn = (S, outBase, fee, quoteUsd = '1') => G.fixed(rMul(rDiv(rAdd(rSub(S, rMul(rr(BigInt(outBase), 10n ** 6n), G.ratio(quoteUsd))), G.ratio(fee)), S), rr(100n)), 18, 'ceil', false);
const three = (cost) => G.fixed(G.ratio(cost), 3, 'half_up');
// The sold quantity's dollar value at the stored price, and at a pool's price (token0, 18 and 6 decimals).
const atStored = (q, usd = STORED) => rMul(rr(q, E18), G.ratio(usd));
const atPool = (q, sqrt, quoteUsd = '1') => rMul(rr(q * sqrt * sqrt, Q192 * 10n ** 6n), G.ratio(quoteUsd));

// ---------------------------------------------------------------------------
// Unit level: one observation at $7.04, a 5% limit.

const v3 = (quotedIn, outs, extra = {}) => ({ pool: '0xv3', mechanism: 'concentrated', counted: true, fee_tier: 3000, quote_decimals: 6, quote_usd: '1', reserves: { token: '1', quote: '1' }, quoted: outs, quoted_in: quotedIn, ...extra });
const cp = (token, quote, extra = {}) => ({ pool: '0xcp', mechanism: 'constant_product', counted: true, fee_bps: 30, quote_decimals: 6, quote_usd: '1', reserves: { token: token.toString(), quote: quote.toString() }, ...extra });
// The three times a capture writes: the stored price 8 minutes after the block, the capture finished 13 minutes after.
const TIMED = { block: { timestamp: '2026-11-10T12:00:00.000Z' }, retrieved: { started_at: '2026-11-10T12:12:00.000Z', finished_at: '2026-11-10T12:13:00.000Z' } };
const obs = (pools, { price = STORED, tax = 0, decimals = 18 } = {}) => ({ token: { decimals }, ...TIMED, price_ref: price === null ? undefined : { usd: price, as_of: '2026-11-10T12:08:00.000Z', source: 'coingecko_stored' }, transfer_probe: tax === null ? { status: 'unavailable' } : { status: 'ok', sell_path: { tax_bps: tax } }, pools });
const guard = (o, quantity, entry, { fee = '0.25' } = {}) => G.fittedExit(o, { notionalUsd: str(mulCeil(dec(quantity), dec(entry))), priceUsd: entry, quantity, networkFeeUsd: fee, limitPct: 5, priceStaleMinutes: 90 });
// The shallow pool's two quotes, with the pool's price at `usd` (null: not on record).
const shallow = (usd = POOL_USD, extra = {}) => v3({ 100: R100.toString(), 500: R500.toString() }, { 100: SHALLOW(R100).toString(), 500: SHALLOW(R500).toString() }, { ...(usd === null ? {} : { spot: spotAt(usd) }), ...extra });

test('PP1: the pool\'s own price is a pair\'s reserve ratio or a concentrated pool\'s slot0 price by the token\'s side, and nothing else', () => {
  assert.equal(G.EXIT_VERSION, 'cr-contract-exit@2');
  assert.deepEqual(G.poolPrice(cp(1000n * E18, 7040000000n)), { n: 7040000000n, d: 1000n * E18 });
  assert.deepEqual(G.poolPrice(shallow()), { n: SQRT * SQRT, d: Q192 });
  // The same pool with the token as token1 stores the inverse square-root price.
  const s1 = sqrtAt(POOL_USD, { side: 'token1' });
  const p1 = G.poolPrice(v3({}, {}, { spot: spotAt(POOL_USD, { side: 'token1' }) }));
  assert.deepEqual(p1, { n: Q192, d: s1 * s1 });
  // Both sides are the one price, $7.11744 a token, to better than a part in 10^15, and neither is over it.
  const target = rr(711744n * 10n ** 6n, 100000n * E18);
  for (const p of [G.poolPrice(shallow()), p1]) {
    assert.ok(p.n * target.d <= target.n * p.d, 'not over the price it was built for');
    assert.ok((target.n * p.d - p.n * target.d) * 10n ** 15n < target.n * p.d, 'and within a part in 10^15 of it');
  }
  // Not on record, or malformed: no price. The balances in `reserves` are never used.
  const bad = [undefined, null, [], {}, 'x', { sqrt_price_x96: Number(SQRT), token_side: 'token0' }, { sqrt_price_x96: '0', token_side: 'token0' }, { sqrt_price_x96: `0${SQRT}`, token_side: 'token0' }, { sqrt_price_x96: `-${SQRT}`, token_side: 'token0' }, { sqrt_price_x96: `${SQRT}.0`, token_side: 'token0' }, { sqrt_price_x96: (2n ** 160n).toString(), token_side: 'token0' }, { sqrt_price_x96: SQRT.toString() }, { sqrt_price_x96: SQRT.toString(), token_side: 'token2' }];
  for (const spot of bad) assert.equal(G.poolPrice(v3({}, {}, { spot, reserves: { token: (1000n * E18).toString(), quote: '7040000000' } })), null, JSON.stringify(spot === undefined ? 'absent' : spot));
  assert.equal(G.poolPrice(v3({}, {}, { reserves: { token: (1000n * E18).toString(), quote: '7040000000' } })), null, 'a concentrated pool\'s balances are not a price');
  for (const reserves of [undefined, null, { token: '0', quote: '5' }, { token: '5', quote: '0' }, { token: 5, quote: 5 }, { token: '5' }]) assert.equal(G.poolPrice({ mechanism: 'constant_product', reserves }), null, JSON.stringify(reserves === undefined ? 'absent' : reserves));
  assert.equal(G.poolPrice({ mechanism: 'stable', reserves: { token: '5', quote: '5' } }), null);
  assert.equal(G.poolPrice(null), null);
});

test('PP2: a fresh stored price 1.1% under the pool no longer turns a 6.000% exit into 4.966% (concentrated pool)', () => {
  assert.equal(SHALLOW(R500), 475419998n, 'the fixture pool pays $475.419998 for the $500 quantity');
  const o = obs([shallow()]);
  const r = guard(o, '71.022727', '6.9');
  assert.equal(r.ok, false, r.words);
  assert.equal(r.value_basis, 'pool');
  assert.equal(r.cost_pct, costOn(atPool(R500, SQRT), 475419998n, '0.25'), 'the cost against the pool\'s own price, exactly');
  assert.equal(r.cost_pct_3, '6.000');
  assert.equal(r.words, 'The exit cost at the fitted notional $490.06, measured against the 71.022727 tokens at the pool\'s own price ($505.5), is 6.000%, over the 5% limit.');
  // What the stored price alone made of the same sale (cr-contract-exit@1).
  assert.equal(three(costOn(atStored(R500), 475419998n, '0.25')), '4.966');
  // Every entry at or under the pool's price reads the same sale the same.
  for (const entry of ['7.04', '6.336']) assert.equal(guard(o, '71.022727', entry).cost_pct, r.cost_pct, entry);
  // The $100 quantity is within the limit against the pool, and passes on that basis.
  const small = guard(o, '14.204545', '6.9');
  assert.equal(small.ok, true, small.words);
  assert.deepEqual([small.cost_pct_3, small.value_basis], ['1.731', 'pool']);
  // The same two quotes from a pool AT the stored price cost 4.966% in that pool, and pass.
  const level = guard(obs([shallow(STORED)]), '71.022727', '6.9');
  assert.equal(level.ok, true, level.words);
  assert.deepEqual([level.cost_pct_3, level.value_basis], ['4.966', 'observation']);
  assert.match(level.words, /at the observation price \$7\.04 \(\$500\), is 4\.966%, within 5%\.$/);
});

test('PP3: a constant-product pair above the stored price is measured against its own reserve ratio', () => {
  // 1,186 tokens against 8,441.28384 USDC: $7.11744 a token.
  const pair = cp(1186n * E18, 8441283840n);
  const out = G.cpOut({ rIn: pair.reserves.token, rOut: pair.reserves.quote, feeBps: 30, qIn: R500 });
  const r = guard(obs([pair]), '71.022727', '6.9');
  const own = rMul(rr(R500 * 8441283840n, 1186n * E18), rr(1n, 10n ** 6n));
  assert.equal(r.value_basis, 'pool');
  assert.equal(r.cost_pct, costOn(own, out, '0.25'));
  assert.equal(r.ok, false, r.words);
  assert.ok(Number(r.cost_pct_3) > 5.9 && Number(r.cost_pct_3) < 6.1, r.cost_pct_3);
  // Against the stored price alone this sale read under the limit.
  assert.ok(Number(three(costOn(atStored(R500), out, '0.25'))) < 5);
  // A pair at or under the stored price is read as before (the stored price is the stricter yardstick).
  const under7 = guard(obs([cp(500000n * E18, 3520000000000n)]), '71.022727', '6.9');
  assert.equal(under7.ok, true, under7.words);
  assert.equal(under7.value_basis, 'observation');
});

test('PP4: the token on token1: the inverse square-root price gives the same reading', () => {
  const o = obs([shallow(null, { spot: spotAt(POOL_USD, { side: 'token1' }) })]);
  const r = guard(o, '71.022727', '6.9');
  assert.equal(r.ok, false, r.words);
  assert.deepEqual([r.cost_pct_3, r.value_basis], ['6.000', 'pool']);
  assert.equal(guard(o, '14.204545', '6.9').cost_pct_3, '1.731');
});

test('PP5: three yardsticks, the stricter one each time; the reading never falls as the pool\'s price rises', () => {
  const at = (usd, entry = '6.9') => guard(obs([shallow(usd)]), '71.022727', entry);
  // The pool under the stored price: the stored price is the yardstick, as before.
  for (const usd of ['6.5', '7', STORED]) assert.deepEqual([at(usd).value_basis, at(usd).cost_pct_3, at(usd).ok], ['observation', '4.966', true], usd);
  // The pool over it: the pool is.
  for (const usd of ['7.041', POOL_USD, '7.3']) assert.equal(at(usd).value_basis, 'pool', usd);
  // An entry over both: the fitted notional is, as in Round 5.
  const hi = at(POOL_USD, '7.2');
  assert.equal(hi.value_basis, 'entry');
  assert.equal(hi.cost_pct, costOn(rMul(rr(R500, E18), G.ratio('7.2')), 475419998n, '0.25'));
  assert.doesNotMatch(hi.words, /measured against/);
  const sweep = ['6.5', '7', '7.04', '7.041', '7.08', POOL_USD, '7.2', '7.3'].map((usd) => G.ratio(at(usd).cost_pct));
  for (let i = 1; i < sweep.length; i++) assert.ok(sweep[i].n * sweep[i - 1].d >= sweep[i - 1].n * sweep[i].d, `step ${i}`);
});

test('PP6: no pool price on record: CG-14 does not prove the sale in that pool, and says why', () => {
  const o = obs([shallow(null)]);
  const r = guard(o, '71.022727', '6.9');
  assert.equal(r.ok, false);
  assert.equal(r.cost_pct, null);
  assert.equal(r.no_pool_price, 1);
  assert.equal(r.words, 'No verified pool prices a sale of $490.06 on chain, so the exit at the fitted notional is not proven within 5%. One pool\'s own price at the observation\'s block is not on record, so that pool is not measured until the next observation records it.');
  // Two such pools are both named.
  const two = guard(obs([shallow(null), shallow(null, { pool: '0xv3b' })]), '71.022727', '6.9');
  assert.equal(two.no_pool_price, 2);
  assert.match(two.words, /2 pools' own prices at the observation's block are not on record, so those pools are not measured until the next observation records them\.$/);
  // Malformed is not on record.
  for (const spot of [null, { sqrt_price_x96: '0', token_side: 'token0' }, { sqrt_price_x96: SQRT.toString(), token_side: 'left' }]) assert.equal(guard(obs([shallow(null, { spot })]), '71.022727', '6.9').no_pool_price, 1, JSON.stringify(spot));
  // A deep pair beside it still proves the sale; nothing is said of the other pool on a pass.
  const withPair = guard(obs([shallow(null), cp(500000n * E18, 3520000000000n)]), '71.022727', '6.9');
  assert.equal(withPair.ok, true, withPair.words);
  assert.equal(withPair.pool, '0xcp');
  assert.doesNotMatch(withPair.words, /not on record/);
  // A thin pair beside it does not, and the wait names the pool that was not measured.
  const thin = guard(obs([shallow(null), cp(564531721145538574650n, 3962014889n)]), '71.022727', '6.9');
  assert.equal(thin.ok, false);
  assert.equal(thin.pool, '0xcp');
  assert.match(thin.words, /over the 5% limit\. One pool's own price at the observation's block is not on record/);
  // The ticket's row of that pool keeps the stored-price basis: it is a reading, and the guard decides the order.
  const ladder = G.exitLadder(o, { sizes: [500], priceUsd: STORED, networkFeeUsd: '0.25', limitPct: 5 });
  const row = ladder.best[0].best;
  assert.deepEqual([row.status, row.value_basis, row.cost_pct_3], ['ok', 'observation', '4.966']);
  assert.equal(G.verdict({ subjects: [], exits: ladder, params: { exit_cost_limit_pct: 5, exit_size_usd: 500 }, now: 0 }).findings.some((f) => f.rule_id === 'CG-10'), false);
  // No stored price keeps Round 5's own hold and words, with or without a pool price.
  for (const usd of [POOL_USD, null]) assert.match(guard(obs([shallow(usd)], { price: null }), '71.022727', '6.9').words, /no stored price, so the sale cannot be valued at it/);
});

test('PP7: with the pool\'s price on record, the ticket\'s exit row and the guard read one basis: the ticket blocks exactly when the guard refuses', () => {
  // The $500 quantity is worth $505.4999... at the pool's price; with the $0.25 fee the 5% line is at $480.474...
  for (const [out, pass] of [['475419998', false], ['480474000', false], ['480475000', true], ['497000000', true]]) {
    const o = obs([v3({ 500: R500.toString() }, { 500: out }, { spot: spotAt(POOL_USD) })]);
    const ladder = G.exitLadder(o, { sizes: [500], priceUsd: STORED, networkFeeUsd: '0.25', limitPct: 5 });
    const row = ladder.best[0].best;
    assert.equal(row.value_basis, 'pool');
    assert.equal(row.cost_pct, costOn(atPool(R500, SQRT), out, '0.25'));
    for (const entry of [STORED, '6.9']) {
      const r = guard(o, '71.022727', entry);
      assert.equal(r.ok, pass, `out ${out} entry ${entry}: ${r.words}`);
      assert.equal(row.cost_pct, r.cost_pct, `out ${out} entry ${entry}: the row and the guard`);
    }
    const v = G.verdict({ subjects: [], exits: ladder, params: { exit_cost_limit_pct: 5, exit_size_usd: 500 }, now: 0 });
    assert.equal(v.findings.some((f) => f.rule_id === 'CG-10'), !pass, `out ${out}: the ticket blocks exactly when the guard refuses`);
  }
  // A constant-product pool's ladder rows are sized at the ticket's price and keep their basis, as before.
  const cpRow = G.exitLadder(obs([cp(1186n * E18, 8441283840n)]), { sizes: [500], priceUsd: STORED, networkFeeUsd: '0.25', limitPct: 5 }).best[0].best;
  assert.equal(cpRow.value_basis, 'size');
});

test('PP8: the 5% line on the pool basis is decided on the raw cost, to the quote asset\'s base unit', () => {
  // A pool at exactly 2^-38 quote units per token unit ($3.637978807091713); 137.438953472 tokens are worth exactly $500 there.
  const q = 500000000n * 2n ** 38n;
  const at = (out) => G.fittedExit(obs([v3({ 500: q.toString() }, { 500: out }, { spot: { sqrt_price_x96: (2n ** 77n).toString(), token_side: 'token0' } })], { price: '3.6' }), { notionalUsd: '481.036337152', priceUsd: '3.5', quantity: '137.438953472', networkFeeUsd: '5', limitPct: 5, priceStaleMinutes: 90 });
  const [below, exact, above] = ['480000001', '480000000', '479999999'].map(at);
  assert.equal(below.ok, true, below.words);
  assert.equal(exact.ok, true, exact.words);
  assert.equal(exact.cost_pct, '5');
  assert.equal(above.ok, false, above.words);
  assert.equal(above.cost_pct, '5.0000002');
  assert.equal(above.cost_pct_3, '5.000');
  assert.match(above.words, /at the pool's own price \(\$500\), is 5\.000%, over the 5% limit/);
  for (const r of [below, exact, above]) assert.equal(r.value_basis, 'pool');
});

test('PP9: the quote asset\'s stated dollar value: too high can no longer produce a pass; too low still holds', () => {
  // The pool trades at 7.04 quote units a token and pays 458.25 of them for the $500 quantity: 8.400% at $1 a unit.
  const pool = (quoteUsd) => v3({ 500: R500.toString() }, { 500: '458250000' }, { spot: spotAt(STORED), quote_usd: quoteUsd });
  const right = guard(obs([pool('1')]), '71.022727', '6.9');
  assert.deepEqual([right.ok, right.cost_pct_3, right.value_basis], [false, '8.400', 'observation']);
  // Stated at $1.10: against the stored price alone the sale read -0.765% and passed (cr-contract-exit@1).
  assert.equal(three(costOn(atStored(R500), 458250000n, '0.25', '1.1')), '-0.765');
  const high = guard(obs([pool('1.1')]), '71.022727', '6.9');
  assert.equal(high.ok, false, high.words);
  assert.deepEqual([high.cost_pct_3, high.value_basis], ['8.395', 'pool']);
  assert.equal(high.cost_pct, costOn(atPool(R500, sqrtAt(STORED), '1.1'), 458250000n, '0.25', '1.1'));
  // What is left of the error is the fee's share alone: fee / value x e / (1 + e), here 0.05% x 0.1 / 1.1.
  assert.ok(Number(right.cost_pct_3) - Number(high.cost_pct_3) < 0.0051);
  // Stated at $0.90: the pool's value falls under the stored-price value, which then binds, and the reading overstates.
  const low = guard(obs([pool('0.9')]), '71.022727', '6.9');
  assert.equal(low.ok, false);
  assert.equal(low.value_basis, 'observation');
  assert.ok(Number(low.cost_pct_3) > 8.4);
});

test('PP10: the network fee as a share of the sale: a $5 ceiling leaves the $100 quantity no room, on any yardstick', () => {
  // The deep fixture pool, 1.1% over the stored price: its $100 quantity costs 0.820% with a $0.25 fee.
  const o = obs([v3({ 100: R100.toString(), 500: R500.toString(), 2000: R2000.toString() }, { 100: DEEP(R100).toString(), 500: DEEP(R500).toString(), 2000: DEEP(R2000).toString() }, { spot: spotAt(POOL_USD) })]);
  assert.deepEqual([guard(o, '14.204545', '6.9').cost_pct_3, guard(o, '14.204545', '6.9').ok], ['0.820', true]);
  const five = { fee: '5' };
  // With a $5 ceiling the fee alone is 4.946% of the $101.10 the quantity is worth in the pool.
  const r100 = guard(o, '14.204545', '6.9', five);
  assert.deepEqual([r100.ok, r100.cost_pct_3, r100.value_basis], [false, '5.518', 'pool']);
  assert.equal(r100.cost_pct, costOn(atPool(R100, SQRT), DEEP(R100), '5'));
  assert.deepEqual([guard(o, '71.022727', '6.9', five).ok, guard(o, '71.022727', '6.9', five).cost_pct_3], [true, '2.639']);
  assert.deepEqual([guard(o, '284.090909', '6.9', five).ok, guard(o, '284.090909', '6.9', five).cost_pct_3], [false, '5.735']);
  // Against the stored price alone the $100 and $2,000 quantities read under the limit (cr-contract-exit@1).
  assert.equal(three(costOn(atStored(R100), DEEP(R100), '5')), '4.479');
  assert.equal(three(costOn(atStored(R2000), DEEP(R2000), '5')), '4.698');
  // A fee larger than the proceeds: every yardstick reads over 100%, so which is largest cannot change the decision.
  const tiny = G.fittedExit(obs([v3({ 2: '549755813888000000' }, { 2: '1990000' }, { spot: { sqrt_price_x96: (2n ** 77n).toString(), token_side: 'token0' } })], { price: '3.3' }), { notionalUsd: '1.814194185830400000', priceUsd: '3.3', quantity: '0.549755813888', networkFeeUsd: '5', limitPct: 5, priceStaleMinutes: 90 });
  assert.equal(tiny.ok, false);
  assert.ok(Number(tiny.cost_pct_3) > 100, tiny.cost_pct_3);
  // An unknown fee is still "at least", never a pass.
  const unknown = G.fittedExit(o, { notionalUsd: '490.0568163', priceUsd: '6.9', quantity: '71.022727', networkFeeUsd: null, limitPct: 5, priceStaleMinutes: 90 });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.words, `The exit cost at the fitted notional $490.06, measured against the 71.022727 tokens at the pool's own price ($505.5), is at least ${three(costOn(atPool(R500, SQRT), DEEP(R500), '0'))}% (network fee unknown): not proven within 5%.`);
});

// ---------------------------------------------------------------------------
// The capture, and the trader's opening path (enforce), on a fictional chain:
// a thin pair and one concentrated pool at $7.11744; the stored price is $7.04.

const KEY = 'FICTIONALkey_0123456789';
const PRICE = 7.04;
const FACT3 = ADDR('fac3');
const QUOTER = ADDR('9007');
const QCODE = '0x6080604052600f';
const INIT3 = K.keccak256Hex('0x0f1c7101a1');
const POOL3 = K.create2Address(FACT3, K.keccak256Hex(`0x${Aw(T0)}${Aw(T1)}${W(3000)}`), INIT3);
const ROW3 = { chain_id: '8453', name: 'Fictional V3', kind: 'v3', factory: FACT3, init_code_hash: INIT3, fee_tiers: [3000], quoter: QUOTER, quoter_code_hash: K.keccak256Hex(QCODE), quotes: [{ address: USDC, decimals: 6, usd_value: '1' }] };
// A second quote asset whose address sorts below the token, so the token is token1 in its pool.
const LOWQ = ADDR('01');
const POOL3L = K.create2Address(FACT3, K.keccak256Hex(`0x${Aw(LOWQ)}${Aw(TOKEN)}${W(3000)}`), INIT3);
const ROW3L = { ...ROW3, quotes: [...ROW3.quotes, { address: LOWQ, decimals: 6, usd_value: '1' }] };
const SLOT0 = sel('slot0()');
let PAY = DEEP;
let SLOT0_ANSWER = () => slot0At(POOL_USD); // what the USDC pool answers to slot0()
const V3 = {
  [FACT3]: { code: '0x60806040526003', fns: { [sel('getPool(address,address,uint24)')]: (S, f, d) => okA(argA(d, 1) === LOWQ ? POOL3L : POOL3) } },
  [POOL3]: { code: '0x60806040526004', fns: { [sel('token0()')]: () => okA(T0), [sel('token1()')]: () => okA(T1), [SLOT0]: () => SLOT0_ANSWER() } },
  [POOL3L]: { code: '0x60806040526005', fns: { [sel('token0()')]: () => okA(LOWQ), [sel('token1()')]: () => okA(TOKEN), [SLOT0]: () => slot0At(POOL_USD, { side: 'token1' }) } },
  [LOWQ]: { code: '0x60806040526006', fns: { [sel('balanceOf(address)')]: () => ok(0) } },
  [QUOTER]: { code: QCODE, fns: { [sel('quoteExactInputSingle((address,address,uint256,uint24,uint160))')]: (S, f, d) => ok(PAY(arg(d, 2)), 0, 0, 0) } },
};
const THIN = { token: 564531721145538574650n, quote: 3962014889n }; // the 2026-11-07 thin pair
const pairState = ({ token, quote }) => baseState({ owner: TL, minter: TL, reserve_token: token, reserve_quote: quote, bal: { [PAIR]: token, [BUYER]: 50000n * E18 } });

function desk(t, { factories = [ROW, ROW3], fee = 5 } = {}) {
  const w = H.tempWorkspace('cg14-pool-price', { contracts: { daily_cu_cap: 1000000, monthly_cu_cap: 10000000, pool_factories: factories, max_log_blocks: 1000 } });
  t.after(w.cleanup);
  t.after(() => { PAY = DEEP; SLOT0_ANSWER = () => slot0At(POOL_USD); });
  assert.ok(under(w.root), 'workspace under the disposable root');
  const pid = H.addFixtureProject(w.ws).project_id;
  H.importAllFixtures(w.ws);
  const file = w.ws.abs(`projects/${pid}/project.json`);
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  p.identity.assets = [{ chain: 'base', contract_address: TOKEN }];
  fs.writeFileSync(file, JSON.stringify(p, null, 2));
  H.freshPrice(w.ws, 'example-payfi-fictional', PRICE);
  w.ws.settings.tickets = { contract_gate: { mode: 'observe' } };
  w.ws.settings.contracts.network_fee_ceiling_usd = { 8453: fee };
  const portfolio = require('../core/portfolio');
  const real = portfolio.computePortfolio;
  portfolio.computePortfolio = (...a) => ({ ...real(...a), positions: [] });
  t.after(() => { portfolio.computePortfolio = real; });
  return { ...w, pid };
}

let blockN = 61000;
let last = null; // the last capture's node, block and result
async function observe(s) {
  H.freshPrice(s.ws, 'example-payfi-fictional', PRICE);
  const block = liveBlock(blockN += 1);
  const w = world({ S: pairState(THIN), tokenCode: TOKEN_CODE, extra: { ...timelocks, ...V3 }, block });
  await CF.probeNetwork(s.ws, '8453', { fetchImpl: w.fetch, key: KEY, now: Date.now });
  const from = w.calls.length;
  const r = await CF.observeProject(s.ws, s.pid, { fetchImpl: w.fetch, key: KEY, sourceImpl: sources, now: Date.now });
  assert.equal(r.results[0].status, 'saved', JSON.stringify(r.results[0]));
  last = { w, block, result: r.results[0], calls: w.calls.slice(from) };
  return CF.readObservation(s.ws, s.pid, r.results[0].observation_id).observation;
}
const slot0Calls = (pool) => last.calls.filter((c) => c.method === 'eth_call' && c.params[0].to === pool && c.params[0].data === SLOT0);

// An observation as it was recorded before the capture read the pool's price.
function reseal(s, ob, edit) {
  const file = s.ws.abs(CF.obsPath(s.pid, ob.observation_id));
  assert.ok(under(file));
  const { sha256: _old, ...rest } = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(rest);
  rest.sha256 = crypto.createHash('sha256').update(G.canonicalJson(rest)).digest('hex');
  fs.writeFileSync(file, JSON.stringify(rest, null, 2));
  const back = CF.readObservation(s.ws, s.pid, ob.observation_id);
  assert.equal(back.ok, true, back.words);
  return back.observation;
}
const withoutSpot = (o) => { for (const p of o.pools) delete p.spot; };

test('PC1: the capture reads slot0 once for each concentrated pool it counts, at the pinned block, and records the price by the token\'s side', async (t) => {
  const s = desk(t, { factories: [ROW, ROW3L] });
  const o = await observe(s);
  const p = o.pools.find((x) => x.pool === POOL3);
  const pl = o.pools.find((x) => x.pool === POOL3L);
  assert.deepEqual(p.spot, { sqrt_price_x96: SQRT.toString(), token_side: 'token0' });
  assert.deepEqual(pl.spot, { sqrt_price_x96: sqrtAt(POOL_USD, { side: 'token1' }).toString(), token_side: 'token1' });
  assert.equal(p.counted && pl.counted, true);
  // One read each, an eth_call (26 compute units by the desk's table) carrying the observation's own block.
  for (const pool of [POOL3, POOL3L]) {
    const calls = slot0Calls(pool);
    assert.equal(calls.length, 1, pool);
    assert.deepEqual(calls[0].params[1], { blockHash: last.block.hash, requireCanonical: true });
  }
  assert.equal(RPC.CU.eth_call, 26);
  assert.equal(last.w.violations.length, 0, 'every state read carried the pinned block');
  assert.equal(o.block.hash, last.block.hash);
  // The pair is not asked: its reserves are its price.
  assert.equal(slot0Calls(PAIR).length, 0);
  assert.equal(o.pools.find((x) => x.pool === PAIR).spot, undefined);
  // Both sides give the gate the same reading: the deep pool's $500 quantity at 2.639% with the $5 fee.
  for (const pool of [p, pl]) {
    const r = guard({ ...o, pools: [pool] }, '71.022727', '6.9', { fee: '5' });
    assert.deepEqual([r.ok, r.cost_pct_3, r.value_basis], [true, '2.639', 'pool'], pool.pool);
  }
  // A new field on a pool row does not move the contract's identity fingerprint.
  const again = await observe(s);
  assert.equal(again.identity_key, o.identity_key);
});

test('PC2: a slot0 that does not answer, or answers nothing usable, leaves the pool counted with no price; CG-14 then holds on it', async (t) => {
  const s = desk(t);
  for (const [name, answer] of [['a revert', () => ({ ok: false, ret: '' })], ['zero', () => ok(0, 0, 0, 0, 0, 0, 1)], ['more than 160 bits', () => ok(2n ** 160n, 0, 0, 0, 0, 0, 1)], ['a short answer', () => ({ ok: true, ret: 'ab' })]]) {
    SLOT0_ANSWER = answer;
    const o = await observe(s);
    const p = o.pools.find((x) => x.pool === POOL3);
    assert.equal(p.counted, true, name);
    assert.equal(p.spot, undefined, name);
    assert.equal(p.quoted['500'], DEEP(R500).toString(), `${name}: its quotes are still recorded`);
    assert.equal(slot0Calls(POOL3).length, 1, name);
    const r = guard({ ...o, pools: [p] }, '71.022727', '6.9', { fee: '5' });
    assert.equal(r.ok, false, name);
    assert.match(r.words, /own price at the observation's block is not on record/, name);
  }
});

test('PC3: a pool that fails its checks is not asked for its price', async (t) => {
  const s = desk(t, { factories: [ROW, { ...ROW3, quoter_code_hash: K.keccak256Hex('0x60806040526010') }] });
  const o = await observe(s);
  const p = o.pools.find((x) => x.pool === POOL3);
  assert.equal(p.counted, false);
  assert.match(p.excluded, /quoter's code is not the allowlisted code/);
  assert.equal(slot0Calls(POOL3).length, 0);
  assert.equal(p.spot, undefined);
});

const TRAP = { proposal_type: 'LIMIT_TRAP', entry_zone: { low_usd: 6.9, high_usd: 7.2, basis: 'prior range (FICTIONAL)' }, upside_target: { price_usd: 9.5, basis: 'fees double' }, invalidation_trigger: { price_usd: 6.1, metric: { key: 'fees', below_30d_usd: 100000 }, statement: 'Below $6.10 or fees under $100k a month.' } };

// The ticket is saved on a first observation; the book's hours close at the
// pool's price; `current` makes the observation the guard reads; enforce is in
// force when Eric approves (the approval runs the trader's step).
async function granted(s, { current = (x) => observe(x) } = {}) {
  TF.settle(s.ws);
  await observe(s);
  const tk = H.withExitReadings(1.5, () => T.createTicket(s.ws, { project_id: s.pid, assistant: true })).ticket;
  const saved = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: TF.answer(T.loadTicket(s.ws, s.pid, tk.ticket_id), TRAP) });
  assert.equal(saved.status, 'saved', saved.message);
  const BAR = { open: '7.117', high: '7.177', low: '7.057', close: '7.117' };
  const now0 = Date.now();
  const top = Math.floor(now0 / TF.H) * TF.H;
  TD.applyHours(s.ws, Array.from({ length: 16 }, (_, i) => TF.bar(top - (16 - i) * TF.H, BAR)), { now: TF.iso(now0) });
  const ob = await current(s);
  H.freshPrice(s.ws, 'example-payfi-fictional', PRICE);
  s.ws.settings.tickets.contract_gate.mode = 'enforce';
  const d = T.decide(s.ws, s.pid, { receipt_id: saved.receipt.receipt_id, action: 'approve', request_id: 'req_cg14_pool_000001' }).result.decision;
  return { decision: d, ob, read: () => TD.requests(s.ws, {}).requests.find((x) => x.decision_id === d.decision_id) };
}
function outcome(label, s, g) {
  const a = g.read();
  const ex = TD.executionFor(s.ws, g.decision.decision_id);
  const fin = ex.reserved[0] || null;
  const fx = fin ? G.fittedExit(g.ob, { notionalUsd: fin.notional_usd, priceUsd: fin.entry_price, quantity: fin.quantity, networkFeeUsd: '5', limitPct: 5, priceStaleMinutes: 90 }) : null;
  console.log(`POOLPRICE ${label} ${JSON.stringify({ phase: a && a.phase, rule: a && a.contract ? a.contract.rule_id : null, words: a && a.words, reserved: ex.reserved.map((x) => ({ quantity: x.quantity, entry: x.entry_price, notional_usd: x.notional_usd })), guard_on_reserved: fx && { ok: fx.ok, cost_pct_3: fx.cost_pct_3, basis: fx.value_basis, pool: fx.pool === POOL3 ? 'V3' : fx.pool === PAIR ? 'V2' : fx.pool } })}`);
  return { a, ex, fin, fx };
}

test('PT1: a fresh stored $7.04 against a pool at $7.11744: the $2,000 quantity (5.735% against the pool) is not opened; the trader reserves the $500 quantity', async (t) => {
  const s = desk(t);
  const g = await granted(s);
  const r = outcome('PT1', s, g);
  // The stored price is fresh: Round 6's rule passes it.
  assert.ok(Math.abs(Date.parse(g.ob.block.timestamp) - Date.parse(g.ob.price_ref.as_of)) < 90 * 60000);
  assert.equal(r.ex.reserved.length, 1, `${r.a.phase}: ${r.a.words}`);
  assert.equal(r.fin.quantity, '71.022727', 'the $500 quantity');
  assert.deepEqual([r.fx.ok, r.fx.cost_pct_3, r.fx.value_basis, r.fx.pool], [true, '2.639', 'pool', POOL3]);
  // The $2,000 quantity on this observation: over the limit against the pool, under it against the stored price alone.
  const big = guard(g.ob, '284.090909', '6.9', { fee: '5' });
  assert.deepEqual([big.ok, big.cost_pct_3, big.value_basis], [false, '5.735', 'pool']);
  assert.equal(three(costOn(atStored(R2000), DEEP(R2000), '5')), '4.698');
});

test('PT2: an observation recorded before the pool\'s price was captured: the order waits on CG-14 and says why; the next observation lets it open', async (t) => {
  const s = desk(t);
  const g = await granted(s, { current: async (x) => reseal(x, await observe(x), withoutSpot) });
  assert.equal(g.ob.pools.find((p) => p.pool === POOL3).spot, undefined);
  const held = outcome('PT2-before', s, g);
  assert.equal(held.a.phase, 'waiting', `${held.a.phase}: ${held.a.words}`);
  assert.equal(held.a.contract.rule_id, 'CG-14');
  assert.match(held.a.words, /One pool's own price at the observation's block is not on record, so that pool is not measured until the next observation records it\./);
  assert.equal(held.ex.reserved.length, 0, 'nothing reserved');
  // The ticket's own rows of that observation still read (the stored-price basis).
  assert.equal(G.exitLadder(g.ob, { sizes: [500], priceUsd: STORED, networkFeeUsd: '5', limitPct: 5 }).pools.find((p) => p.pool === POOL3).rows[0].status, 'ok');
  g.ob = await observe(s);
  assert.ok(g.ob.pools.find((p) => p.pool === POOL3).spot);
  TD.step(s.ws, {});
  const r = outcome('PT2-after', s, g);
  assert.equal(r.ex.reserved.length, 1, `${r.a.phase}: ${r.a.words}`);
  assert.equal(r.fin.quantity, '71.022727');
  assert.equal(r.fx.value_basis, 'pool');
});

test('PT3: observe mode is unchanged: the risk-sized order opens with no CG-14 read', async (t) => {
  const s = desk(t);
  TF.settle(s.ws);
  await observe(s);
  const tk = H.withExitReadings(1.5, () => T.createTicket(s.ws, { project_id: s.pid, assistant: true })).ticket;
  const saved = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: TF.answer(T.loadTicket(s.ws, s.pid, tk.ticket_id), TRAP) });
  const BAR = { open: '7.117', high: '7.177', low: '7.057', close: '7.117' };
  const now0 = Date.now();
  const top = Math.floor(now0 / TF.H) * TF.H;
  TD.applyHours(s.ws, Array.from({ length: 16 }, (_, i) => TF.bar(top - (16 - i) * TF.H, BAR)), { now: TF.iso(now0) });
  await observe(s);
  const d = T.decide(s.ws, s.pid, { receipt_id: saved.receipt.receipt_id, action: 'approve', request_id: 'req_cg14_pool_000002' }).result.decision;
  const ex = TD.executionFor(s.ws, d.decision_id);
  assert.equal(ex.reserved.length, 1);
  assert.notEqual(ex.reserved[0].quantity, '71.022727', 'not sized down to a quote');
});

test('PT4: the ticket reads the same basis: a $500 reference exit of 6.000% against the pool blocks the ticket (CG-10), and an approval under enforce is refused', async (t) => {
  const s = desk(t, { fee: 0.25 });
  PAY = SHALLOW;
  TF.settle(s.ws);
  const ob = await observe(s);
  // The ticket's row at Eric's $500 reference size, on the pool's own price. Against the stored price alone it read 4.966%.
  const ladder = G.exitLadder(ob, { sizes: [100, 500, 2000], priceUsd: STORED, networkFeeUsd: '0.25', limitPct: 5 });
  const row = ladder.best.find((b) => b.size_usd === 500).best;
  assert.deepEqual([row.pool, row.cost_pct_3, row.value_basis], [POOL3, '6.000', 'pool']);
  assert.equal(three(costOn(atStored(R500), SHALLOW(R500), '0.25')), '4.966');
  const tk = H.withExitReadings(1.5, () => T.createTicket(s.ws, { project_id: s.pid, assistant: true })).ticket;
  const saved = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: TF.answer(T.loadTicket(s.ws, s.pid, tk.ticket_id), TRAP) });
  assert.equal(saved.status, 'saved', saved.message);
  const BAR = { open: '7.117', high: '7.177', low: '7.057', close: '7.117' };
  const now0 = Date.now();
  const top = Math.floor(now0 / TF.H) * TF.H;
  TD.applyHours(s.ws, Array.from({ length: 16 }, (_, i) => TF.bar(top - (16 - i) * TF.H, BAR)), { now: TF.iso(now0) });
  await observe(s);
  H.freshPrice(s.ws, 'example-payfi-fictional', PRICE);
  s.ws.settings.tickets.contract_gate.mode = 'enforce';
  assert.throws(() => T.decide(s.ws, s.pid, { receipt_id: saved.receipt.receipt_id, action: 'approve', request_id: 'req_cg14_pool_000004' }), /contract gate read block when it was saved .*The complete on-chain exit cost at \$500 is 6\.000%, over the 5% limit\. Nothing was granted\./);
  assert.equal(TD.requests(s.ws, {}).requests.filter((x) => x.phase === 'order' || x.phase === 'open').length, 0);
});
