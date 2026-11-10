'use strict';
// CG-14 valuation basis and quote-input integrity (audit round 5, from the
// adversarial review of Round 4). FICTIONAL chain, pools, quoter, desk and
// prices; temporary workspaces only; no network, no key.
//
// The rules under test:
// - CG-14 measures an exit against the larger of the order's fitted notional
//   (quantity x entry) and the sold quantity at the observation's stored
//   price, for concentrated pools (patch A) and constant-product pools
//   (patch B). An entry under the observation price cannot shrink the
//   denominator of a quoter answer or of reserves read at that price.
// - A ladder row selling a recorded quote input is valued the same way, so
//   the ticket's row and the guard read one basis.
// - `quoted_in` (patch C): absent is legacy (rebuilt from the stored price
//   only); present but not a plain map, or a value that is not a canonical
//   positive integer string, makes the affected quote ineligible, and nothing
//   rebuilt or invalid is labelled recorded.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SAFE = process.env.CR_AUDIT_SAFE_ROOT;
assert.ok(SAFE && path.isAbsolute(SAFE), 'CR_AUDIT_SAFE_ROOT must name the disposable folder');
const under = (p) => path.resolve(p).toLowerCase().startsWith(path.resolve(SAFE).toLowerCase());
assert.ok(under(os.tmpdir()), `os.tmpdir() ${os.tmpdir()} is not under ${SAFE}`);
assert.ok(!process.env.CR_DATA_DIR && !process.env.CR_WORKSPACE, 'no real desk path may be set');

const G = require('../core/contract-gate');
const K = require('../core/keccak');
const CF = require('../core/contract-forensics');
const T = require('../core/tickets');
const TD = require('../core/trader-desk');
const TF = require('./trader-fixture');
const H = require('./helpers');
const { exact: { dec, str, mulCeil } } = require('../core/trade-risk');
const { world, baseState, ROW, T0, T1, PAIR, USDC, BUYER, ADDR, Aw, W, sel, arg, ok, okA, TOKEN, TOKEN_CODE, sources, timelocks, liveBlock, TL } = require('./contract-world');

const E18 = 10n ** 18n;
const RUNG_2000 = 284090909000000000000n; // $2,000 at $7.04, whole lots
const RUNG_500 = 71022727000000000000n; // $500 at $7.04, whole lots

// ---------------------------------------------------------------------------
// Unit level: one observation at $7.04, a $5 fee and a 5% limit.

const v3 = (quotedIn, outs, name = '0xv3') => ({ pool: name, mechanism: 'concentrated', counted: true, quote_decimals: 6, quote_usd: '1', reserves: { token: '1', quote: '1' }, quoted: outs, ...(quotedIn !== undefined ? { quoted_in: quotedIn } : {}) });
// 5,000 tokens / $35,200: a constant-product pool priced at $7.04.
const cp = (name = '0xcp', token = 5000n * E18, quote = 35200000000n) => ({ pool: name, mechanism: 'constant_product', counted: true, fee_bps: 30, quote_decimals: 6, quote_usd: '1', reserves: { token: token.toString(), quote: quote.toString() } });
// The three times a capture writes (audit round 6): the stored price 8 minutes after the block, the capture finished 13 minutes after.
const TIMED = { block: { timestamp: '2026-11-09T12:00:00.000Z' }, retrieved: { started_at: '2026-11-09T12:12:00.000Z', finished_at: '2026-11-09T12:13:00.000Z' } };
const obs = (pools, { price = '7.04', tax = 0, decimals = 18 } = {}) => ({ token: { decimals }, ...TIMED, price_ref: price === null ? undefined : { usd: price, as_of: '2026-11-09T12:08:00.000Z', source: 'coingecko_stored' }, transfer_probe: tax === null ? { status: 'unavailable' } : { status: 'ok', sell_path: { tax_bps: tax } }, pools });
const guard = (o, quantity, entry, extra = {}) => G.fittedExit(o, { notionalUsd: str(mulCeil(dec(quantity), dec(entry))), priceUsd: entry, quantity, networkFeeUsd: '5', limitPct: 5, priceStaleMinutes: 90, ...extra });
// The $2,000 rung: the quoter paid $1,885.00, so with the $5 fee the exit costs 6.000%.
const sixPct = () => v3({ 2000: RUNG_2000.toString() }, { 2000: '1885000000' });

test('V1 (patch A): the 6% concentrated rung stays held at entries $7.04, $6.90 and $6.336, measured at the observation price', () => {
  const o = obs([sixPct()]);
  for (const entry of ['7.04', '6.9', '6.336']) {
    const r = guard(o, '284.090909', entry);
    assert.equal(r.ok, false, `entry ${entry}: ${r.words}`);
    assert.equal(r.cost_pct_3, '6.000', `entry ${entry}`);
    assert.match(r.words, /6\.000%, over the 5% limit/);
    if (entry !== '7.04') {
      assert.equal(r.value_basis, 'observation');
      assert.match(r.words, /measured against the 284\.090909 tokens at the observation price \$7\.04 \(\$2000\)/);
    }
  }
});

test('V2: an entry above the observation price keeps the stricter fitted-notional basis', () => {
  const r = guard(obs([sixPct()]), '284.090909', '7.11');
  assert.equal(r.ok, false);
  assert.equal(r.value_basis, 'entry');
  assert.equal(r.cost_pct_3, '6.925');
  assert.doesNotMatch(r.words, /observation price/);
});

test('V3 (patch B): a constant-product pool alone is held at every entry under the observation price, the same cost as at it', () => {
  const o = obs([cp()]);
  const at = guard(o, '284.090909', '7.04');
  assert.equal(at.ok, false, at.words);
  for (const entry of ['6.9', '6.336']) {
    const r = guard(o, '284.090909', entry);
    assert.equal(r.ok, false, `entry ${entry}: ${r.words}`);
    assert.equal(r.cost_pct, at.cost_pct, `entry ${entry}: the same sale, the same cost`);
    assert.equal(r.value_basis, 'observation');
  }
  // Positive control: a deep pair proves the same quantity at a lower entry.
  const deep = guard(obs([cp('0xdeep', 500000n * E18, 3520000000000n)]), '284.090909', '6.9');
  assert.equal(deep.ok, true, deep.words);
  assert.equal(deep.pool, '0xdeep');
});

test('V4 (patches A+B): a mixed observation cannot clear a rejected concentrated rung through the constant-product pool at the lower entry', () => {
  const o = obs([sixPct(), cp()]);
  for (const entry of ['7.04', '6.9', '6.336']) {
    const r = guard(o, '284.090909', entry);
    assert.equal(r.ok, false, `entry ${entry}: ${r.words} (pool ${r.pool})`);
  }
  // Each pool read alone at $6.90, measured at the observation price, is over the limit too.
  assert.equal(guard(obs([sixPct()]), '284.090909', '6.9').ok, false);
  assert.equal(guard(obs([cp()]), '284.090909', '6.9').ok, false);
});

test('V5: the 5% line at a lower entry: just below, exactly at and just above, decided on the raw cost, not the rounded display', () => {
  // 1,000 tokens at a stored price of $0.50 is $500 exactly; the entry is $0.45 ($450).
  // With the $5 fee the exit is exactly 5% when the quoter pays $480.000000.
  const q = (1000n * E18).toString();
  const at = (out) => G.fittedExit(obs([v3({ 500: q }, { 500: out })], { price: '0.5' }), { notionalUsd: '450', priceUsd: '0.45', quantity: '1000', networkFeeUsd: '5', limitPct: 5, priceStaleMinutes: 90 });
  const below = at('480000001');
  const exact = at('480000000');
  const above = at('479999999');
  assert.equal(below.ok, true, below.words);
  assert.equal(exact.ok, true, exact.words);
  assert.equal(exact.cost_pct, '5');
  assert.equal(above.ok, false, above.words);
  assert.equal(above.cost_pct, '5.0000002');
  // The rounded display is the same on both sides of the line; the decision is not.
  assert.equal(exact.cost_pct_3, '5.000');
  assert.equal(above.cost_pct_3, '5.000');
  assert.match(above.words, /5\.000%, over the 5% limit/);
  for (const r of [below, exact, above]) assert.equal(r.value_basis, 'observation');
});

test('V6: the ticket\'s exit row and the guard read one basis for a recorded quote: same quantity, same cost, same decision', () => {
  // The $500 rung at the line: 71.022727 tokens at $7.04 is $499.99999808, so
  // with the $5 fee it passes at $479.999999 and fails at $479.999998.
  for (const [out, pass] of [['480000000', true], ['479999999', true], ['479999998', false]]) {
    const o = obs([v3({ 500: RUNG_500.toString() }, { 500: out })]);
    const ladder = G.exitLadder(o, { sizes: [500], priceUsd: '7.04', networkFeeUsd: '5', limitPct: 5 });
    const row = ladder.best[0].best;
    for (const entry of ['7.04', '6.9']) {
      const r = guard(o, '71.022727', entry);
      assert.equal(r.ok, pass, `out ${out} entry ${entry}: ${r.words}`);
      assert.equal(row.q, RUNG_500.toString());
      assert.equal(row.cost_pct, r.cost_pct, `out ${out} entry ${entry}: the row and the guard`);
    }
    const v = G.verdict({ subjects: [], exits: ladder, params: { exit_cost_limit_pct: 5, exit_size_usd: 500 }, now: 0 });
    assert.equal(v.findings.some((f) => f.rule_id === 'CG-10'), !pass, `out ${out}: the ticket blocks exactly when the guard refuses`);
  }
});

test('V7: no stored price: no sale is valued, so a recorded quote and a constant-product pool both hold', () => {
  for (const pools of [[v3({ 500: RUNG_500.toString() }, { 500: '497000000' })], [cp('0xdeep', 500000n * E18, 3520000000000n)]]) {
    const r = guard(obs(pools, { price: null }), '71.022727', '7.04');
    assert.equal(r.ok, false, r.words);
    assert.match(r.words, /no stored price, so the sale cannot be valued at it/);
  }
});

// ---------------------------------------------------------------------------
// Quote-input integrity (patch C)

test('Q1: a valid recorded quantity is eligible and labelled recorded; one base unit off is not', () => {
  const o = obs([v3({ 500: RUNG_500.toString() }, { 500: '497000000' })]);
  assert.equal(guard(o, '71.022727', '7.04').ok, true);
  assert.deepEqual(G.quotedQuantities(o).map((x) => [x.label, x.base, x.recorded]), [['500', RUNG_500, true]]);
  for (const off of [RUNG_500 + 1n, RUNG_500 - 1n]) {
    const r = guard(o, G.tokensText(off, 18), '7.04');
    assert.equal(r.ok, false, `${off}: ${r.words}`);
  }
});

test('Q2: an absent quoted_in is legacy: rebuilt from the stored price only, and labelled rebuilt, never recorded', () => {
  const q = (1000n * E18).toString();
  const o = obs([v3(undefined, { 500: '497000000' })], { price: '0.5' });
  const r = G.fittedExit(o, { notionalUsd: '500', priceUsd: '0.5', quantity: '1000', networkFeeUsd: '5', limitPct: 5, priceStaleMinutes: 90 });
  assert.equal(r.ok, true, r.words);
  assert.deepEqual(G.quotedQuantities(o).map((x) => [x.base.toString(), x.recorded]), [[q, false]]);
  assert.equal(G.quotedQuantities(obs([v3(undefined, { 500: '497000000' })], { price: null })).length, 0, 'no stored price: not rebuilt');
});

test('Q3: a present but malformed quoted_in, or a malformed amount, makes the quote ineligible everywhere and is never rebuilt', () => {
  const q = (1000n * E18).toString();
  const shapes = {
    null: null, 'empty string': '', zero: 0, false: false, 'string "corrupt"': 'corrupt', 'number 5': 5, true: true,
    'array []': [], 'array [q]': [q], 'object {}': {}, 'wrong key': { 100: q }, '"1e21"': { 500: '1e21' }, 'number value': { 500: 1e21 },
    'leading zero': { 500: `0${q}` }, 'zero amount': { 500: '0' }, 'negative': { 500: `-${q}` }, 'decimal': { 500: `${q}.0` }, 'spaces': { 500: ` ${q}` },
    'null amount': { 500: null }, 'nested': { 500: { v: q } }, 'map with a prototype': Object.assign(Object.create({ 500: q }), {}),
  };
  for (const [name, val] of Object.entries(shapes)) {
    const o = obs([v3(val, { 500: '497000000' })], { price: '0.5' });
    const r = G.fittedExit(o, { notionalUsd: '500', priceUsd: '0.5', quantity: '1000', networkFeeUsd: '5', limitPct: 5, priceStaleMinutes: 90 });
    assert.equal(r.ok, false, `${name}: ${r.words}`);
    assert.equal(G.quotedQuantities(o).length, 0, `${name}: nothing to size an order to`);
    const row = G.exitLadder(o, { sizes: [500], priceUsd: '0.5', networkFeeUsd: '5', limitPct: 5 }).pools[0].rows[0];
    assert.equal(row.status, 'unavailable', `${name}: the ticket row is not read off it`);
  }
  // One malformed amount does not spoil the pool's other, valid, inputs.
  const mixed = obs([v3({ 100: '1e20', 500: q }, { 100: '99000000', 500: '497000000' })], { price: '0.5' });
  assert.deepEqual(G.quotedQuantities(mixed).map((x) => [x.label, x.recorded]), [['500', true]]);
});

// ---------------------------------------------------------------------------
// Low-decimal tokens (compatibility, reported separately)

test('L1: a 4-decimal token on a constant-product pool: a representable quantity is proven; the lot-sized one is not a whole number of base units and holds', () => {
  const o = obs([{ pool: '0xv2', mechanism: 'constant_product', counted: true, fee_bps: 30, quote_decimals: 6, quote_usd: '1', reserves: { token: '10000000000', quote: '7040000000000' } }], { decimals: 4 });
  const rep = guard(o, '71.0227', '7.04');
  assert.equal(rep.ok, true, rep.words);
  const lot = guard(o, '71.022727', '7.04');
  assert.equal(lot.ok, false);
  assert.match(lot.words, /71\.022727 is not a whole number of the token's base units/);
  assert.equal(G.quotedQuantities(o).length, 0, 'no concentrated quote, so nothing to size down to');
});

// ---------------------------------------------------------------------------
// Through the normal trader opening path (enforce): the reviewer's
// lower-entry fixture. A quoter with price impact pays $6.99424 a token up to
// 100 tokens ($100 and $500 rungs: 5.650% and 1.650%) and $6.63520 above
// ($2,000 rung: $1,885.00, 6.000%). Every observation is at $7.04.

const KEY = 'FICTIONALkey_0123456789';
const PRICE = 7.04;
const FACT3 = ADDR('fac3');
const QUOTER = ADDR('9007');
const QCODE = '0x6080604052600f';
const INIT3 = K.keccak256Hex('0x0f1c7101a1');
const POOL3 = K.create2Address(FACT3, K.keccak256Hex(`0x${Aw(T0)}${Aw(T1)}${W(3000)}`), INIT3);
const ROW3 = { chain_id: '8453', name: 'Fictional V3', kind: 'v3', factory: FACT3, init_code_hash: INIT3, fee_tiers: [3000], quoter: QUOTER, quoter_code_hash: K.keccak256Hex(QCODE), quotes: [{ address: USDC, decimals: 6, usd_value: '1' }] };
let QUOTER_MODE = 'impact'; // 'impact' | 'poor' (every size at $6.63520) | 'zero'
const PAY = (q) => (QUOTER_MODE === 'zero' ? 0n : ((QUOTER_MODE === 'impact' && q <= 100n * E18) ? q * 699424n : q * 663520n) / (100000n * 10n ** 12n));
const V3 = {
  [FACT3]: { code: '0x60806040526003', fns: { [sel('getPool(address,address,uint24)')]: () => okA(POOL3) } },
  [POOL3]: { code: '0x60806040526004', fns: { [sel('token0()')]: () => okA(T0), [sel('token1()')]: () => okA(T1) } },
  [QUOTER]: { code: QCODE, fns: { [sel('quoteExactInputSingle((address,address,uint256,uint24,uint160))')]: (S, f, d) => ok(PAY(arg(d, 2)), 0, 0, 0) } },
};
const THIN = { token: 564531721145538574650n, quote: 3962014889n }; // the 2026-11-07 thin pair
const MID = { token: 5000n * E18, quote: 35200000000n }; // proves $2,000 only at a lower entry's valuation
const pairState = ({ token, quote }) => baseState({ owner: TL, minter: TL, reserve_token: token, reserve_quote: quote, bal: { [PAIR]: token, [BUYER]: 50000n * E18 } });

function desk(t) {
  const w = H.tempWorkspace('cg14-valuation', { contracts: { daily_cu_cap: 1000000, monthly_cu_cap: 10000000, pool_factories: [ROW, ROW3], max_log_blocks: 1000 } });
  t.after(w.cleanup);
  t.after(() => { QUOTER_MODE = 'impact'; });
  assert.ok(under(w.root), 'workspace under the disposable root');
  const pid = H.addFixtureProject(w.ws).project_id;
  H.importAllFixtures(w.ws);
  const file = w.ws.abs(`projects/${pid}/project.json`);
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  p.identity.assets = [{ chain: 'base', contract_address: TOKEN }];
  fs.writeFileSync(file, JSON.stringify(p, null, 2));
  H.freshPrice(w.ws, 'example-payfi-fictional', PRICE);
  w.ws.settings.tickets = { contract_gate: { mode: 'observe' } };
  w.ws.settings.contracts.network_fee_ceiling_usd = { 8453: 5 };
  const portfolio = require('../core/portfolio');
  const real = portfolio.computePortfolio;
  portfolio.computePortfolio = (...a) => ({ ...real(...a), positions: [] });
  t.after(() => { portfolio.computePortfolio = real; });
  return { ...w, pid };
}

function failingLogs(w) {
  return { ...w, fetch: async (url, init) => { const { id, method } = JSON.parse(init.body); if (method === 'eth_getLogs') return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message: 'FICTIONAL refusal' } }) }; return w.fetch(url, init); } };
}

let blockN = 9500;
async function observe(s, { pair = THIN, failLogs = false } = {}) {
  H.freshPrice(s.ws, 'example-payfi-fictional', PRICE);
  let w = world({ S: pairState(pair), tokenCode: TOKEN_CODE, extra: { ...timelocks, ...V3 }, block: liveBlock(blockN += 1) });
  if (failLogs) w = failingLogs(w);
  await CF.probeNetwork(s.ws, '8453', { fetchImpl: w.fetch, key: KEY, now: Date.now });
  const r = await CF.observeProject(s.ws, s.pid, { fetchImpl: w.fetch, key: KEY, sourceImpl: sources, now: Date.now });
  assert.equal(r.results[0].status, 'saved', JSON.stringify(r.results[0]));
  return CF.readObservation(s.ws, s.pid, r.results[0].observation_id).observation;
}

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

const proposalAt = (low) => ({ entry_zone: { low_usd: low, high_usd: 7.2, basis: 'prior range (FICTIONAL)' }, upside_target: { price_usd: 9.5, basis: 'fees double' }, invalidation_trigger: { price_usd: 6.1, metric: { key: 'fees', below_30d_usd: 100000 }, statement: 'Below $6.10 or fees under $100k a month.' } });

// The ticket is saved on a first observation; `current` makes the one the
// guard reads; the book's hours close at `close`; `mode` is in force when
// Eric approves (the approval runs the trader's step).
async function granted(s, { close, mode = 'enforce', current = (x) => observe(x), low = 6.3 }) {
  TF.settle(s.ws);
  await observe(s);
  const tk = H.withExitReadings(1.5, () => T.createTicket(s.ws, { project_id: s.pid, assistant: true })).ticket;
  const saved = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: TF.answer(T.loadTicket(s.ws, s.pid, tk.ticket_id), proposalAt(low)) });
  assert.equal(saved.status, 'saved', saved.message);
  const c = Number(close);
  const BAR = { open: close, high: (c + 0.06).toFixed(3), low: (c - 0.06).toFixed(3), close };
  const now0 = Date.now();
  const top = Math.floor(now0 / TF.H) * TF.H;
  TD.applyHours(s.ws, Array.from({ length: 16 }, (_, i) => TF.bar(top - (16 - i) * TF.H, BAR)), { now: TF.iso(now0) });
  const ob = await current(s);
  s.ws.settings.tickets.contract_gate.mode = mode;
  const d = T.decide(s.ws, s.pid, { receipt_id: saved.receipt.receipt_id, action: 'approve', request_id: 'req_cg14_val_000001' }).result.decision;
  return { decision: d, ob, read: () => TD.requests(s.ws, {}).requests.find((x) => x.decision_id === d.decision_id) };
}

function outcome(label, s, g) {
  const a = g.read();
  const ex = TD.executionFor(s.ws, g.decision.decision_id);
  const fin = ex.reserved[0] || null;
  const p3 = g.ob.pools.find((x) => x.pool === POOL3);
  const rung = fin && p3 && p3.quoted_in ? Object.keys(p3.quoted_in).find((k) => p3.quoted_in[k] === G.baseUnits(fin.quantity, 18).toString()) || null : null;
  const fx = fin ? G.fittedExit(g.ob, { notionalUsd: fin.notional_usd, priceUsd: fin.entry_price, quantity: fin.quantity, networkFeeUsd: '5', limitPct: 5, priceStaleMinutes: 90 }) : null;
  console.log(`ROUND5 ${label} ${JSON.stringify({ phase: a && a.phase, rule: a && a.contract ? a.contract.rule_id : null, words: a && a.words, reserved: ex.reserved.map((x) => ({ quantity: x.quantity, entry: x.entry_price, notional_usd: x.notional_usd })), rung_usd: rung, guard_on_reserved: fx && { ok: fx.ok, cost_pct: fx.cost_pct, basis: fx.value_basis, pool: fx.pool === POOL3 ? 'V3' : fx.pool === PAIR ? 'V2' : fx.pool, words: fx.words } })}`);
  return { a, ex, fin, rung, fx };
}

for (const close of ['7.04', '6.90', '6.336']) {
  test(`P${close}: at a book entry of $${close} the 6% $2,000 rung is not opened; the trader reserves the 71.022727-token $500 rung`, async (t) => {
    const s = desk(t);
    const g = await granted(s, { close });
    const r = outcome(`P${close}`, s, g);
    assert.ok(r.fin, `${r.a.phase}: ${r.a.words}`);
    assert.equal(r.ex.reserved.length, 1);
    assert.equal(r.rung, '500', `reserved ${r.fin.quantity}`);
    assert.equal(r.fin.quantity, '71.022727');
    assert.equal(r.fx.ok, true, r.fx.words);
    assert.equal(r.fx.pool, POOL3);
  });
}

test('PM: a mixed observation (the V3 rung over the limit, a constant-product pair that reads under it only at the lower entry) still sizes down to $500 at $6.90', async (t) => {
  const s = desk(t);
  const g = await granted(s, { close: '6.90', current: (x) => observe(x, { pair: MID }) });
  const r = outcome('PM', s, g);
  assert.ok(r.fin, `${r.a.phase}: ${r.a.words}`);
  assert.equal(r.fin.quantity, '71.022727', 'the $2,000 quantity cannot clear through the pair');
  // The $2,000 quantity, read by hand on this observation at $6.90, is held on both pools.
  assert.equal(G.fittedExit(g.ob, { notionalUsd: str(mulCeil(dec('284.090909'), dec('6.9'))), priceUsd: '6.9', quantity: '284.090909', networkFeeUsd: '5', limitPct: 5, priceStaleMinutes: 90 }).ok, false);
});

test('PN: no valid rung (every quote over the limit at the observation price): it waits on CG-14 and reserves nothing', async (t) => {
  const s = desk(t);
  const g = await granted(s, { close: '6.90', current: async (x) => { QUOTER_MODE = 'poor'; const o = await observe(x); QUOTER_MODE = 'impact'; return o; } });
  const r = outcome('PN', s, g);
  assert.equal(r.a.phase, 'waiting', `${r.a.phase}: ${r.a.words}`);
  assert.equal(r.a.contract.rule_id, 'CG-14');
  assert.equal(r.ex.reserved.length, 0);
});

test('PQ: a malformed quoted_in on the current observation is not sized to and not rebuilt: it waits, nothing reserved', async (t) => {
  const s = desk(t);
  const g = await granted(s, { close: '6.90', current: async (x) => { const o = await observe(x); return reseal(x, o, (b) => { for (const p of b.pools) if (p.mechanism === 'concentrated') p.quoted_in = null; }); } });
  const r = outcome('PQ', s, g);
  assert.equal(r.a.phase, 'waiting', `${r.a.phase}: ${r.a.words}`);
  assert.equal(r.a.contract.rule_id, 'CG-14');
  assert.match(r.a.words, /No saved exit quote is proven for a whole number of lots/);
  assert.equal(r.ex.reserved.length, 0);
});

test('PO: observe mode is unchanged: the $6.90 desk opens the risk-sized order, with no size-down', async (t) => {
  const s = desk(t);
  const g = await granted(s, { close: '6.90', mode: 'observe' });
  const r = outcome('PO', s, g);
  assert.equal(r.ex.reserved.length, 1);
  assert.notEqual(r.fin.quantity, '71.022727');
  assert.equal(r.rung, null, 'not a rung: nothing was sized down');
});

test('PS: stale evidence (CG-20) holds first with nothing reserved; once current, the $500 rung is reserved at $6.90', async (t) => {
  const s = desk(t);
  const g = await granted(s, { close: '6.90', current: async (x) => { QUOTER_MODE = 'zero'; const o = await observe(x); QUOTER_MODE = 'impact'; return o; } });
  assert.equal(g.read().contract.rule_id, 'CG-14');
  g.ob = await observe(s);
  s.ws.settings.contracts.ttl_hours = 0.0000001;
  TD.step(s.ws, {});
  const stale = g.read();
  assert.equal(stale.phase, 'waiting');
  assert.equal(stale.contract.rule_id, 'CG-20');
  assert.equal(TD.executionFor(s.ws, g.decision.decision_id).reserved.length, 0);
  delete s.ws.settings.contracts.ttl_hours;
  TD.step(s.ws, {});
  const r = outcome('PS', s, g);
  assert.equal(r.rung, '500');
});

test('PT: unknown sell tax at $6.90: the size-down is tried and still not proven; it waits, tax unknown, nothing reserved', async (t) => {
  const s = desk(t);
  const g = await granted(s, { close: '6.90', current: (x) => observe(x, { failLogs: true }) });
  const r = outcome('PT', s, g);
  assert.equal(r.a.phase, 'waiting', `${r.a.phase}: ${r.a.words}`);
  assert.equal(r.a.contract.rule_id, 'CG-14');
  assert.match(r.a.words, /transfer tax unknown/);
  assert.equal(r.ex.reserved.length, 0);
});
