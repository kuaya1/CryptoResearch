'use strict';
// CG-14 price freshness (audit round 6, from the review of Round 5).
// FICTIONAL chain, pools, quoter, desk and prices; temporary workspaces only;
// no network, no key.
//
// The rule under test (contract-gate.js priceFreshness, under enforce): the
// stored price an exit is valued at must be dated within the lower of the
// desk's freshness.price_stale_minutes and 90 minutes of the quote's block,
// either way (exactly at the limit passes), and no more than 10 minutes after
// the capture finished. Times are read only as the desk writes them
// (Date#toISOString). Anything missing, malformed, stale or post-dated holds
// the order on CG-14 with nothing reserved. The record is compared with
// itself, never with the clock; the observation's own age stays CG-20's.
// Out of scope: a stored price that is fresh but disagrees with the pool.

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
const MIN = 60000;
const R500 = 71022727000000000000n; // the $500 rung at $7.04, whole lots

// ---------------------------------------------------------------------------
// Unit level. The block is at T; by default the capture finished at T+13 min
// and the stored price is dated T+8 min (the usual shape on the desk).

const T_MS = Date.parse('2026-11-09T12:00:00.000Z');
const at = (ms) => new Date(T_MS + ms).toISOString();
// The $500 rung, 1.650% at $7.04 with the $5 fee.
const v3 = (quotedIn = { 500: R500.toString() }, outs = { 500: '496749998' }) => ({ pool: '0xv3', mechanism: 'concentrated', counted: true, quote_decimals: 6, quote_usd: '1', reserves: { token: '1', quote: '1' }, quoted: outs, ...(quotedIn === null ? {} : { quoted_in: quotedIn }) });
// A deep constant-product pair priced at $7.04.
const cp = () => ({ pool: '0xcp', mechanism: 'constant_product', counted: true, fee_bps: 30, quote_decimals: 6, quote_usd: '1', reserves: { token: (500000n * E18).toString(), quote: '3520000000000' } });
// ABSENT leaves a time out of the record entirely.
const ABSENT = Symbol('absent');
function obs(pools, { price = '7.04', asOf = at(8 * MIN), block = at(0), finished = at(13 * MIN), priceRef } = {}) {
  return {
    token: { decimals: 18 },
    block: block === ABSENT ? { number: 1 } : { number: 1, timestamp: block },
    retrieved: finished === ABSENT ? { started_at: at(12 * MIN) } : { started_at: at(12 * MIN), finished_at: finished },
    price_ref: priceRef !== undefined ? priceRef : { usd: price, as_of: asOf, source: 'coingecko_stored' },
    transfer_probe: { status: 'ok', sell_path: { tax_bps: 0 } },
    pools,
  };
}
const guard = (o, opts = {}) => {
  const { quantity = '71.022727', entry = '7.04' } = opts;
  const limit = Object.prototype.hasOwnProperty.call(opts, 'limit') ? opts.limit : 90;
  return G.fittedExit(o, { notionalUsd: str(mulCeil(dec(quantity), dec(entry))), priceUsd: entry, quantity, networkFeeUsd: '5', limitPct: 5, priceStaleMinutes: limit });
};
const held = (r, state, label) => {
  assert.equal(r.ok, false, `${label}: ${r.words}`);
  assert.equal(r.rule_id, 'CG-14');
  assert.equal(r.price_check && r.price_check.state, state, `${label}: ${r.words}`);
  assert.match(r.words, /^The observation's stored price cannot value this sale: .*, so the exit at the fitted notional \$\d+(\.\d+)? is not proven within 5%\.$/);
};

test('F-U1: a fresh stored price passes for a concentrated and a constant-product pool; the result records the check', () => {
  for (const pools of [[v3()], [cp()]]) {
    const r = guard(obs(pools));
    assert.equal(r.ok, true, r.words);
    assert.equal(r.price_check.state, 'ok');
    assert.equal(r.price_check.limit_minutes, 90);
    assert.equal(r.price_check.gap_ms, 8 * MIN);
  }
});

test('F-U2: a stale stored price holds for a concentrated pool, a constant-product pool and both together', () => {
  for (const [name, pools] of [['V3', [v3()]], ['V2', [cp()]], ['V2+V3', [v3(), cp()]]]) {
    const r = guard(obs(pools, { asOf: at(-6 * 60 * MIN) }));
    held(r, 'stale', name);
    assert.match(r.words, /is 360\.000 minutes before its block .* past the 90-minute limit/);
  }
});

test('F-U3: missing or malformed times hold: the price time, the block time and the capture time, as the desk writes them only', () => {
  const p = () => [v3()];
  const cases = [
    ['as_of absent', obs(p(), { priceRef: { usd: '7.04', source: 'coingecko_stored' } }), 'no_time'],
    ['as_of null', obs(p(), { asOf: null }), 'no_time'],
    ['as_of "yesterday"', obs(p(), { asOf: 'yesterday' }), 'malformed_time'],
    ['as_of a number', obs(p(), { asOf: T_MS }), 'malformed_time'],
    ['as_of an empty string', obs(p(), { asOf: '' }), 'malformed_time'],
    ['as_of with no milliseconds', obs(p(), { asOf: '2026-11-09T12:08:00Z' }), 'malformed_time'],
    ['as_of with an offset', obs(p(), { asOf: '2026-11-09T12:08:00.000+00:00' }), 'malformed_time'],
    ['as_of lower-case z', obs(p(), { asOf: '2026-11-09T12:08:00.000z' }), 'malformed_time'],
    ['as_of microseconds', obs(p(), { asOf: '2026-11-09T12:08:00.000000Z' }), 'malformed_time'],
    ['as_of padded', obs(p(), { asOf: ' 2026-11-09T12:08:00.000Z' }), 'malformed_time'],
    ['as_of 2026-02-30 (no such day)', obs(p(), { asOf: '2026-02-30T12:08:00.000Z' }), 'malformed_time'],
    ['as_of 2026-02-29 (not a leap year)', obs(p(), { asOf: '2026-02-29T12:08:00.000Z' }), 'malformed_time'],
    ['as_of month 13', obs(p(), { asOf: '2026-13-09T12:08:00.000Z' }), 'malformed_time'],
    ['as_of hour 24', obs(p(), { asOf: '2026-11-09T24:00:00.000Z' }), 'malformed_time'],
    ['as_of second 60', obs(p(), { asOf: '2026-11-09T12:07:60.000Z' }), 'malformed_time'],
    ['block time absent', obs(p(), { block: ABSENT }), 'no_block_time'],
    ['block time null', obs(p(), { block: null }), 'no_block_time'],
    ['block time in seconds (a number)', obs(p(), { block: T_MS / 1000 }), 'malformed_block_time'],
    ['block time 2026-11-31', obs(p(), { block: '2026-11-31T12:00:00.000Z' }), 'malformed_block_time'],
    ['capture finish absent', obs(p(), { finished: ABSENT }), 'no_capture_time'],
    ['capture finish malformed', obs(p(), { finished: 'soon' }), 'malformed_capture_time'],
  ];
  for (const [name, o, state] of cases) held(guard(o), state, name);
  // A price_ref that is not an object is no stored price at all: Round 5's own hold.
  const str7 = guard(obs(p(), { priceRef: '7.04' }));
  assert.equal(str7.ok, false);
  assert.match(str7.words, /no stored price/);
  // A real leap day reads.
  assert.equal(guard(obs(p(), { block: '2028-02-29T12:00:00.000Z', asOf: '2028-02-29T12:08:00.000Z', finished: '2028-02-29T12:13:00.000Z' })).ok, true);
});

test('F-U4: the age limit, in both directions: exactly 90 minutes passes, one millisecond beyond holds', () => {
  // Price before the block.
  assert.equal(guard(obs([v3()], { asOf: at(-90 * MIN) })).ok, true, 'exactly 90 minutes before');
  held(guard(obs([v3()], { asOf: at(-90 * MIN - 1) })), 'stale', '90 minutes 1 ms before');
  // Price after the block. The capture finished at T+95 min, so a price at T+90 min (+1 ms)
  // is still inside the separate 10-minute allowance after the capture: only the gap decides.
  const late = { finished: at(95 * MIN) };
  const exact = guard(obs([v3()], { ...late, asOf: at(90 * MIN) }));
  assert.equal(exact.ok, true, `exactly 90 minutes after: ${exact.words}`);
  assert.equal(exact.price_check.gap_ms, 90 * MIN);
  const past = guard(obs([v3()], { ...late, asOf: at(90 * MIN + 1) }));
  held(past, 'stale', '90 minutes 1 ms after');
  assert.match(past.words, /after its block/);
});

test('F-U5: the allowance after the capture, at its own boundary: 10 minutes after the finish passes, 1 ms more holds', () => {
  // Capture finished at T+13 min; a price at T+23 min is 23 minutes from the block, well inside the age limit.
  const edge = guard(obs([v3()], { asOf: at(23 * MIN) }));
  assert.equal(edge.ok, true, edge.words);
  const over = guard(obs([v3()], { asOf: at(23 * MIN + 1) }));
  held(over, 'after_capture', '10 minutes 1 ms after the capture');
  assert.match(over.words, /more than 10 minutes after the capture finished/);
});

test('F-U6: the configured limit: a tighter one applies, a looser one cannot widen the 90-minute cap, and an invalid one holds', () => {
  const o31 = obs([v3()], { asOf: at(-30 * MIN - 1) });
  assert.equal(guard(o31, { limit: 90 }).ok, true, '30 min 1 ms is inside the default');
  held(guard(o31, { limit: 30 }), 'stale', 'a 30-minute setting');
  assert.equal(guard(obs([v3()], { asOf: at(-30 * MIN) }), { limit: 30 }).ok, true, 'exactly 30 minutes under a 30-minute setting');
  const o91 = obs([v3()], { asOf: at(-90 * MIN - 1) });
  for (const wide of [91, 120, 1440, 100000]) {
    const r = guard(o91, { limit: wide });
    held(r, 'stale', `a ${wide}-minute setting`);
    assert.equal(r.price_check.limit_minutes, 90);
  }
  for (const bad of [undefined, null, 0, -5, '90', 45.5, NaN, Infinity, true, [90], { minutes: 90 }]) {
    const r = guard(obs([v3()]), { limit: bad });
    held(r, 'no_limit', `limit ${String(bad)}`);
    assert.match(r.words, /freshness\.price_stale_minutes/);
  }
  // With no stored price either, the missing limit still holds.
  assert.equal(guard(obs([v3()], { priceRef: null }), { limit: undefined }).ok, false);
});

test('F-U7: legacy quotes (no recorded input) follow the same rule: a fresh whole-lot rebuild passes; stale or untimed holds', () => {
  // At a stored price of $0.50, the $500 rung rebuilds to 1,000 tokens: whole lots.
  const legacy = (o) => G.fittedExit(o, { notionalUsd: '500', priceUsd: '0.5', quantity: '1000', networkFeeUsd: '5', limitPct: 5, priceStaleMinutes: 90 });
  const pool = () => [v3(null, { 500: '497000000' })];
  const fresh = legacy(obs(pool(), { price: '0.5' }));
  assert.equal(fresh.ok, true, fresh.words);
  held(legacy(obs(pool(), { price: '0.5', asOf: at(-91 * MIN) })), 'stale', 'legacy, stale');
  held(legacy(obs(pool(), { price: '0.5', asOf: null })), 'no_time', 'legacy, no price time');
});

test('F-U8: preserved: the higher-entry basis, exact quantity matching, the sell-tax hold and the missing-price hold', () => {
  // An entry above the stored price keeps the entry basis (4.499% at $7.25).
  const hi = guard(obs([v3()]), { entry: '7.25' });
  assert.equal(hi.ok, true, hi.words);
  assert.equal(hi.value_basis, 'entry');
  assert.equal(hi.cost_pct_3, '4.499');
  // One base unit off the recorded quote is not proven, fresh or not.
  assert.equal(guard(obs([v3()]), { quantity: G.tokensText(R500 + 1n, 18) }).ok, false);
  // Tax unknown still holds with a fresh price.
  const untaxed = { ...obs([v3()]), transfer_probe: { status: 'unavailable' } };
  const t = guard(untaxed);
  assert.equal(t.ok, false);
  assert.match(t.words, /transfer tax unknown/);
  // No stored price keeps Round 5's own hold and words.
  const none = guard(obs([v3()], { priceRef: null }));
  assert.equal(none.ok, false);
  assert.match(none.words, /no stored price, so the sale cannot be valued at it/);
});

test('F-U9: the rule reads the record, not the clock: the same observation gives the same answer whenever it is read', () => {
  const o = obs([v3()], { asOf: at(-60 * MIN) });
  const a = guard(o);
  const realNow = Date.now;
  try { Date.now = () => T_MS + 20 * 3600000; assert.deepEqual(guard(o), a); } finally { Date.now = realNow; }
  assert.equal(a.ok, true);
});

// ---------------------------------------------------------------------------
// Through the normal trader opening path (enforce): the reviewer's Round 5
// fixture (r5review/r5-path.test.js RS1 and RS2). The pool trades at $7.32:
// up to 100 tokens the quoter pays $7.27242, above it $6.73440 (8% under the
// pool). The fixture's block is 10 minutes before the clock.

const KEY = 'FICTIONALkey_0123456789';
const FACT3 = ADDR('fac3');
const QUOTER = ADDR('9007');
const QCODE = '0x6080604052600f';
const INIT3 = K.keccak256Hex('0x0f1c7101a1');
const POOL3 = K.create2Address(FACT3, K.keccak256Hex(`0x${Aw(T0)}${Aw(T1)}${W(3000)}`), INIT3);
const ROW3 = { chain_id: '8453', name: 'Fictional V3', kind: 'v3', factory: FACT3, init_code_hash: INIT3, fee_tiers: [3000], quoter: QUOTER, quoter_code_hash: K.keccak256Hex(QCODE), quotes: [{ address: USDC, decimals: 6, usd_value: '1' }] };
const POOL_732 = { small: 727242n, large: 673440n };
let RATES = POOL_732;
const PAY = (q) => ((q <= 100n * E18 ? q * RATES.small : q * RATES.large) / (100000n * 10n ** 12n));
const V3 = {
  [FACT3]: { code: '0x60806040526003', fns: { [sel('getPool(address,address,uint24)')]: () => okA(POOL3) } },
  [POOL3]: { code: '0x60806040526004', fns: { [sel('token0()')]: () => okA(T0), [sel('token1()')]: () => okA(T1) } },
  [QUOTER]: { code: QCODE, fns: { [sel('quoteExactInputSingle((address,address,uint256,uint24,uint160))')]: (S, f, d) => ok(PAY(arg(d, 2)), 0, 0, 0) } },
};
const THIN = { token: 564531721145538574650n, quote: 3962014889n };

function desk(t) {
  const w = H.tempWorkspace('cg14-fresh', { contracts: { daily_cu_cap: 1000000, monthly_cu_cap: 10000000, pool_factories: [ROW, ROW3], max_log_blocks: 1000 } });
  t.after(w.cleanup);
  t.after(() => { RATES = POOL_732; });
  assert.ok(under(w.root), 'workspace under the disposable root');
  const pid = H.addFixtureProject(w.ws).project_id;
  H.importAllFixtures(w.ws);
  const file = w.ws.abs(`projects/${pid}/project.json`);
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  p.identity.assets = [{ chain: 'base', contract_address: TOKEN }];
  fs.writeFileSync(file, JSON.stringify(p, null, 2));
  H.freshPrice(w.ws, 'example-payfi-fictional', 7.04);
  w.ws.settings.tickets = { contract_gate: { mode: 'observe' } };
  w.ws.settings.contracts.network_fee_ceiling_usd = { 8453: 5 };
  const portfolio = require('../core/portfolio');
  const real = portfolio.computePortfolio;
  portfolio.computePortfolio = (...a) => ({ ...real(...a), positions: [] });
  t.after(() => { portfolio.computePortfolio = real; });
  return { ...w, pid };
}

let blockN = 17000;
// `price`: the stored price the observation is sized at; `ageMs`: how old it is at capture.
async function observe(s, { price = 7.04, ageMs = 60000 } = {}) {
  H.freshPrice(s.ws, 'example-payfi-fictional', price, ageMs);
  const S = baseState({ owner: TL, minter: TL, reserve_token: THIN.token, reserve_quote: THIN.quote, bal: { [PAIR]: THIN.token, [BUYER]: 50000n * E18 } });
  const w = world({ S, tokenCode: TOKEN_CODE, extra: { ...timelocks, ...V3 }, block: liveBlock(blockN += 1) });
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

const TRAP = { proposal_type: 'LIMIT_TRAP', entry_zone: { low_usd: 6.9, high_usd: 7.2, basis: 'prior range (FICTIONAL)' }, upside_target: { price_usd: 9.5, basis: 'fees double' }, invalidation_trigger: { price_usd: 6.1, metric: { key: 'fees', below_30d_usd: 100000 }, statement: 'Below $6.10 or fees under $100k a month.' } };

// The ticket is saved on a first, fresh observation at $7.04; the book's hours
// close at $7.32; `current` makes the observation the guard reads; the stored
// price is fresh again ($7.32) when Eric approves (the approval runs the step).
async function granted(s, { current, mode = 'enforce', before = () => {} }) {
  TF.settle(s.ws);
  await observe(s);
  const tk = H.withExitReadings(1.5, () => T.createTicket(s.ws, { project_id: s.pid, assistant: true })).ticket;
  const saved = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: TF.answer(T.loadTicket(s.ws, s.pid, tk.ticket_id), TRAP) });
  assert.equal(saved.status, 'saved', saved.message);
  const BAR = { open: '7.32', high: '7.380', low: '7.260', close: '7.32' };
  const now0 = Date.now();
  const top = Math.floor(now0 / TF.H) * TF.H;
  TD.applyHours(s.ws, Array.from({ length: 16 }, (_, i) => TF.bar(top - (16 - i) * TF.H, BAR)), { now: TF.iso(now0) });
  const ob = await current(s);
  H.freshPrice(s.ws, 'example-payfi-fictional', 7.32);
  s.ws.settings.tickets.contract_gate.mode = mode;
  before(s);
  const d = T.decide(s.ws, s.pid, { receipt_id: saved.receipt.receipt_id, action: 'approve', request_id: 'req_cg14_fresh_0001' }).result.decision;
  return { decision: d, ob, receipt: saved.receipt, read: () => TD.requests(s.ws, {}).requests.find((x) => x.decision_id === d.decision_id) };
}

function outcome(label, s, g) {
  const a = g.read();
  const ex = TD.executionFor(s.ws, g.decision.decision_id);
  const gap = Math.abs(Date.parse(g.ob.block.timestamp) - Date.parse(g.ob.price_ref.as_of)) / MIN;
  console.log(`ROUND6 ${label} ${JSON.stringify({ phase: a && a.phase, rule: a && a.contract ? a.contract.rule_id : null, price_check: a && a.contract && a.contract.fitted ? a.contract.fitted.price_check || null : null, words: a && a.words, price_ref: g.ob.price_ref, block_time: g.ob.block.timestamp, gap_minutes: Number(gap.toFixed(3)), reserved: ex.reserved.map((x) => ({ quantity: x.quantity, entry: x.entry_price, notional_usd: x.notional_usd })) })}`);
  return { a, ex, gap };
}
const waitsCG14 = (r, state) => {
  assert.equal(r.a.phase, 'waiting', `${r.a.phase}: ${r.a.words}`);
  assert.equal(r.a.contract.rule_id, 'CG-14');
  if (state) assert.equal(r.a.contract.fitted.price_check.state, state, r.a.words);
  assert.equal(r.ex.reserved.length, 0, 'nothing reserved');
};

test('F-T1 (RS1): a stored price 6 hours older than the block, 4% under the pool: the order waits on CG-14 and nothing is reserved', async (t) => {
  const s = desk(t);
  const g = await granted(s, { current: (x) => observe(x, { price: 7.04, ageMs: 6 * 3600000 }) });
  const r = outcome('F-T1', s, g);
  assert.ok(r.gap > 340, `the price is ${r.gap} minutes from its block`);
  waitsCG14(r, 'stale');
  assert.match(r.a.words, /past the 90-minute limit/);
});

test('F-T2 (RS2 control): a fresh stored price of $7.32: the 8% rung is refused and the 68.30601-token $500 rung is reserved', async (t) => {
  const s = desk(t);
  const g = await granted(s, { current: (x) => observe(x, { price: 7.32 }) });
  const r = outcome('F-T2', s, g);
  assert.equal(r.ex.reserved.length, 1, `${r.a.phase}: ${r.a.words}`);
  assert.equal(r.ex.reserved[0].quantity, '68.30601');
  assert.equal(G.baseUnits(r.ex.reserved[0].quantity, 18).toString(), g.ob.pools.find((p) => p.pool === POOL3).quoted_in['500']);
});

test('F-T3: observe is unchanged: the 6-hour-old price opens the risk-sized order, with no CG-14 read', async (t) => {
  const s = desk(t);
  const g = await granted(s, { mode: 'observe', current: (x) => observe(x, { price: 7.04, ageMs: 6 * 3600000 }) });
  const r = outcome('F-T3', s, g);
  assert.equal(r.ex.reserved.length, 1, `${r.a.phase}: ${r.a.words}`);
});

test('F-T4: settings: with no user override the desk default (90) applies and a 50-minute gap reserves; a 30-minute setting holds the same gap', async (t) => {
  const s = desk(t);
  assert.equal(s.ws.settings.freshness.price_stale_minutes, 90, 'resolved from workspace.js DEFAULT_SETTINGS');
  const g = await granted(s, { current: (x) => observe(x, { price: 7.32, ageMs: 60 * MIN }) });
  const r = outcome('F-T4-default', s, g);
  assert.ok(r.gap > 45 && r.gap < 55, `gap ${r.gap}`);
  assert.equal(r.ex.reserved[0] && r.ex.reserved[0].quantity, '68.30601', `${r.a.phase}: ${r.a.words}`);
  // The 30-minute setting is checked at the guard's handoff
  // (tickets.contractOpenGuard), as in F-T5. On the full trader path the same
  // setting also governs the trader's own market-hour freshness, which refuses
  // first late in an hour; the direct call shows the CG-14 hold itself.
  const project = require('../core/projects').getProject(s.ws, s.pid);
  const ask = { notionalUsd: str(mulCeil(dec('68.30601'), dec('6.9'))), priceUsd: '6.9', quantity: '68.30601' };
  assert.equal(T.contractOpenGuard(s.ws, project, g.receipt, ask), null, 'the default 90: nothing holds the $500 rung');
  s.ws.settings.freshness = { ...s.ws.settings.freshness, price_stale_minutes: 30 };
  const h = T.contractOpenGuard(s.ws, project, g.receipt, ask);
  console.log(`ROUND6 F-T4-30 ${JSON.stringify({ hold: h && h.hold, rule: h && h.rule_id, price_check: h && h.fitted ? h.fitted.price_check || null : null })}`);
  assert.ok(h && h.hold, 'a 30-minute setting: the guard holds');
  assert.equal(h.rule_id, 'CG-14');
  assert.equal(h.fitted.price_check.state, 'stale');
  assert.equal(h.fitted.price_check.limit_minutes, 30);
  assert.ok(h.fitted.price_check.gap_ms > 45 * MIN && h.fitted.price_check.gap_ms < 55 * MIN, `gap ${h.fitted.price_check.gap_ms}`);
  assert.match(h.words, /past the 30-minute limit/);
});

test('F-T5: settings: a 240-minute setting cannot widen the guard past 90 minutes, and a missing effective value holds', async (t) => {
  {
    const s = desk(t);
    const g = await granted(s, { current: (x) => observe(x, { price: 7.32, ageMs: 110 * MIN }), before: (x) => { x.ws.settings.freshness = { ...x.ws.settings.freshness, price_stale_minutes: 240 }; } });
    const r = outcome('F-T5-240', s, g);
    assert.ok(r.gap > 95 && r.gap < 105, `gap ${r.gap}`);
    waitsCG14(r, 'stale');
    assert.match(r.a.words, /past the 90-minute limit/);
  }
  {
    // With the setting gone the trader's own rules refuse first; the guard's
    // handoff (tickets.contractOpenGuard) holds on its own as well.
    const s = desk(t);
    const g = await granted(s, { current: (x) => observe(x, { price: 7.32 }), before: (x) => { const { price_stale_minutes: _gone, ...rest } = x.ws.settings.freshness; x.ws.settings.freshness = rest; } });
    const r = outcome('F-T5-missing', s, g);
    assert.equal(r.a.phase, 'waiting', r.a.words);
    assert.equal(r.ex.reserved.length, 0);
    const project = require('../core/projects').getProject(s.ws, s.pid);
    const ask = { notionalUsd: str(mulCeil(dec('68.30601'), dec('6.9'))), priceUsd: '6.9', quantity: '68.30601' };
    for (const value of [undefined, 0, '90', 45.5]) {
      const { price_stale_minutes: _v, ...rest } = s.ws.settings.freshness;
      s.ws.settings.freshness = value === undefined ? rest : { ...rest, price_stale_minutes: value };
      const h = T.contractOpenGuard(s.ws, project, g.receipt, ask);
      assert.ok(h && h.hold, `setting ${String(value)}: the guard holds`);
      assert.equal(h.rule_id, 'CG-14');
      assert.equal(h.fitted.price_check.state, 'no_limit');
    }
    s.ws.settings.freshness = { ...s.ws.settings.freshness, price_stale_minutes: 90 };
    assert.equal(T.contractOpenGuard(s.ws, project, g.receipt, ask), null, 'a valid setting: nothing holds the $500 rung');
  }
});

test('F-T6: a price valid for its block, read 5 hours later while CG-20 still allows the observation, reserves; past CG-20\'s life the approval itself is refused', async (t) => {
  const shift = (o) => {
    const back = (v) => new Date(Date.parse(v) - 5 * 3600000).toISOString();
    o.block.timestamp = back(o.block.timestamp);
    o.retrieved.started_at = back(o.retrieved.started_at);
    o.retrieved.finished_at = back(o.retrieved.finished_at);
    o.price_ref.as_of = back(o.price_ref.as_of);
  };
  {
    const s = desk(t);
    const g = await granted(s, { current: async (x) => reseal(x, await observe(x, { price: 7.32 }), shift) });
    const r = outcome('F-T6-within-ttl', s, g);
    assert.ok(Date.now() - Date.parse(g.ob.block.timestamp) > 5 * 3600000, 'the block is over 5 hours old when the order is read');
    assert.equal(r.ex.reserved[0] && r.ex.reserved[0].quantity, '68.30601', `${r.a.phase}: ${r.a.words}`);
  }
  {
    // The observation's age is still the existing rules': with a 4-hour life the
    // same record is refused at the approval itself, so nothing is granted or reserved.
    const s = desk(t);
    await assert.rejects(granted(s, { current: async (x) => reseal(x, await observe(x, { price: 7.32 }), shift), before: (x) => { x.ws.settings.contracts.ttl_hours = 4; } }), /5 hours old, past 4 hours. .*Nothing was granted/);
    assert.equal(TD.requests(s.ws, {}).requests.filter((x) => x.phase === 'order' || x.phase === 'open').length, 0);
  }

});

test('F-T7: a malformed price time on the current observation holds on CG-14, nothing reserved', async (t) => {
  const s = desk(t);
  const g = await granted(s, { current: async (x) => reseal(x, await observe(x, { price: 7.32 }), (o) => { o.price_ref.as_of = o.price_ref.as_of.replace(/\.\d{3}Z$/, 'Z'); }) });
  waitsCG14(outcome('F-T7', s, g), 'malformed_time');
});
