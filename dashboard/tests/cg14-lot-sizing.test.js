'use strict';
// Lot-aligned exit quotes and order sizing (audit 2026-11-08, prototype).
// FICTIONAL chain, pools, quoter, desk and prices, shaped like Uniswap on the
// 2026-11-07 observation: price $7.04, an 18-decimal token, a deep
// concentrated pool and a thin constant-product pair (564.53 / 3,962.01),
// the receipt's $6.10 stop and a $5 network-fee ceiling. Temporary
// workspaces only, no network, no key.
//
// The rule under test: a quote is asked for a whole number of the trader's
// lots (trader-desk.js LOT) and the exact base units sent are recorded
// (quoted_in). When CG-14 holds the risk-sized order, the trader tries the
// largest recorded quantity at or under it, re-fits the order through the
// engine at the risk that buys exactly that many, and reads the whole guard
// again. Anything it cannot prove waits, with nothing reserved.

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

const KEY = 'FICTIONALkey_0123456789';
const E18 = 10n ** 18n;
const PRICE = 7.04;
const STEP = 10n ** 12n; // 0.000001 at 18 decimals

// ---------------------------------------------------------------------------
// Unit level

test('the whole-lot step is the trader\'s lot at the token\'s decimals, never finer than one base unit', () => {
  assert.equal(TD.LOT, '0.000001');
  assert.equal(G.lotStep(TD.LOT, 18), STEP);
  assert.equal(G.lotStep(TD.LOT, 6), 1n);
  assert.equal(G.lotStep(TD.LOT, 4), 1n, 'a 4-decimal token: the lot is finer than a base unit, so the step is one base unit');
  assert.equal(G.lotStep('0.000025', 8), 2500n);
  assert.equal(G.lotStep(TD.LOT, null), null);
});

const v3 = (quotedIn, outs, extra = {}) => ({ pool: '0xv3', mechanism: 'concentrated', counted: true, quote_decimals: 6, quote_usd: '1', reserves: { token: '1', quote: '1' }, quoted: outs, ...(quotedIn ? { quoted_in: quotedIn } : {}), ...extra });
// The three times a capture writes (audit round 6): the stored price 8 minutes after the block, the capture finished 13 minutes after.
const TIMED = { block: { timestamp: '2026-11-09T12:00:00.000Z' }, retrieved: { started_at: '2026-11-09T12:12:00.000Z', finished_at: '2026-11-09T12:13:00.000Z' } };
const obs = (pools, { price = '7.04', tax = 0 } = {}) => ({ token: { decimals: 18 }, ...TIMED, price_ref: price === null ? undefined : { usd: price, as_of: '2026-11-09T12:08:00.000Z', source: 'coingecko_stored' }, transfer_probe: tax === null ? { status: 'unavailable' } : { status: 'ok', sell_path: { tax_bps: tax } }, pools });

test('a recorded quote is matched to the order unit for unit: one base unit more or less refuses', () => {
  const q = 71022727000000000000n; // 71.022727 UNI, the $500 reference at $7.04, whole lots
  const out = ((q * 699424n) / (100000n * 10n ** 12n)).toString(); // the quoter pays $6.99424 a token
  const o = obs([v3({ 500: q.toString() }, { 500: out })]);
  const at = (base) => G.fittedExit(o, { notionalUsd: str(mulCeil(dec(G.tokensText(base, 18)), dec('7.04'))), priceUsd: '7.04', quantity: G.tokensText(base, 18), networkFeeUsd: '5', limitPct: 5, priceStaleMinutes: 90 });
  const hit = at(q);
  assert.equal(hit.ok, true, hit.words);
  assert.equal(hit.pool, '0xv3');
  for (const off of [q + 1n, q - 1n]) {
    const r = at(off);
    assert.equal(r.ok, false, `${off}: ${r.words}`);
    assert.match(r.words, /No verified pool prices/);
  }
  // With no stored price the sale cannot be valued at the observation price,
  // so even a recorded quote is not proven (audit round 5; Round 4 let it pass).
  const unpriced = G.fittedExit({ ...o, price_ref: undefined }, { notionalUsd: '499.99999808', priceUsd: '7.04', quantity: '71.022727', networkFeeUsd: '5', limitPct: 5, priceStaleMinutes: 90 });
  assert.equal(unpriced.ok, false);
  assert.match(unpriced.words, /no stored price, so the sale cannot be valued at it/);
});

test('older observations: a legacy quote is provable only by rebuilding it from the stored price, and only a whole-lot rebuild can size an order', () => {
  const legacyOut = { 100: '99411807', 500: '496425630', 2000: '1967363732' }; // the 2026-11-07 outputs, no quoted_in
  const legacy = G.quotedQuantities(obs([v3(null, legacyOut)]));
  assert.deepEqual(legacy.map((x) => [x.label, G.tokensText(x.base, 18), x.recorded]), [['100', '14.204545454545454545', false], ['500', '71.022727272727272727', false], ['2000', '284.090909090909090909', false]]);
  assert.equal(legacy.filter((x) => x.base % STEP === 0n).length, 0, 'none is a whole number of lots');
  assert.equal(G.quotedQuantities(obs([v3(null, legacyOut)], { price: null })).length, 0, 'without the stored price none is provable');
  // At a price whose rebuild is whole lots, a legacy quote can size an order.
  const half = G.quotedQuantities(obs([v3(null, { 500: '1' })], { price: '0.5' }));
  assert.equal(half[0].base, 1000n * E18);
  assert.equal(half[0].base % STEP, 0n);
  // A recorded entry that is not a positive integer is unprovable, and is not rebuilt.
  assert.equal(G.quotedQuantities(obs([v3({ 500: '71.5' }, { 500: '1' })])).length, 0);
});

// ---------------------------------------------------------------------------
// Through the normal trader opening path (enforce), Uniswap-shaped.

const FACT3 = ADDR('fac3');
const QUOTER = ADDR('9007');
const QCODE = '0x6080604052600f';
const INIT3 = K.keccak256Hex('0x0f1c7101a1');
const POOL3 = K.create2Address(FACT3, K.keccak256Hex(`0x${Aw(T0)}${Aw(T1)}${W(3000)}`), INIT3);
const ROW3 = { chain_id: '8453', name: 'Fictional V3', kind: 'v3', factory: FACT3, init_code_hash: INIT3, fee_tiers: [3000], quoter: QUOTER, quoter_code_hash: K.keccak256Hex(QCODE), quotes: [{ address: USDC, decimals: 6, usd_value: '1' }] };
const SENT = [];
let QUOTER_CAP = null; // above it the fictional quoter answers 0 (no liquidity)
const V3 = {
  [FACT3]: { code: '0x60806040526003', fns: { [sel('getPool(address,address,uint24)')]: () => okA(POOL3) } },
  [POOL3]: { code: '0x60806040526004', fns: { [sel('token0()')]: () => okA(T0), [sel('token1()')]: () => okA(T1) } },
  // The quoter pays $6.99424 a token (0.65% under $7.04) and notes what it was asked.
  [QUOTER]: { code: QCODE, fns: { [sel('quoteExactInputSingle((address,address,uint256,uint24,uint160))')]: (S, f, d) => { SENT.push(arg(d, 2)); if (QUOTER_CAP !== null && arg(d, 2) > QUOTER_CAP) return ok(0n, 0, 0, 0); return ok((arg(d, 2) * 699424n) / (100000n * 10n ** 12n), 0, 0, 0); } } },
};
// The thin pair of the 2026-11-07 observation: 564.531721 tokens / 3,962.014889 USDC.
const THIN_TOKEN = 564531721145538574650n;
const thinState = ({ token = THIN_TOKEN, quote = 3962014889n } = {}) => baseState({ owner: TL, minter: TL, reserve_token: token, reserve_quote: quote, bal: { [PAIR]: token, [BUYER]: 50000n * E18 } });

function desk(t, { fee = 5, sizes = null } = {}) {
  const w = H.tempWorkspace('cg14-lot', { contracts: { daily_cu_cap: 1000000, monthly_cu_cap: 10000000, pool_factories: [ROW, ROW3], max_log_blocks: 1000 } });
  t.after(w.cleanup);
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
  if (sizes) w.ws.settings.forensics = { preferences: { exit_sizes_usd: sizes, exit_position_usd: sizes[sizes.length - 1] } };
  const portfolio = require('../core/portfolio');
  const real = portfolio.computePortfolio;
  portfolio.computePortfolio = (...a) => ({ ...real(...a), positions: [] });
  t.after(() => { portfolio.computePortfolio = real; });
  return { ...w, pid };
}

function failingLogs(w) {
  return { ...w, fetch: async (url, init) => { const { id, method } = JSON.parse(init.body); if (method === 'eth_getLogs') return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message: 'FICTIONAL refusal' } }) }; return w.fetch(url, init); } };
}

let blockN = 9700;
async function observe(s, { failLogs = false, thin = {} } = {}) {
  H.freshPrice(s.ws, 'example-payfi-fictional', PRICE);
  let w = world({ S: thinState(thin), tokenCode: TOKEN_CODE, extra: { ...timelocks, ...V3 }, block: liveBlock(blockN += 1) });
  if (failLogs) w = failingLogs(w);
  await CF.probeNetwork(s.ws, '8453', { fetchImpl: w.fetch, key: KEY, now: Date.now });
  const r = await CF.observeProject(s.ws, s.pid, { fetchImpl: w.fetch, key: KEY, sourceImpl: sources, now: Date.now });
  assert.equal(r.results[0].status, 'saved', JSON.stringify(r.results[0]));
  return CF.readObservation(s.ws, s.pid, r.results[0].observation_id).observation;
}

// Re-seal a saved observation after `edit` (an older record), SHA-256 recomputed.
function reseal(s, ob, edit) {
  const file = s.ws.abs(CF.obsPath(s.pid, ob.observation_id));
  assert.ok(under(file));
  const { sha256: _old, ...rest } = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(rest);
  rest.sha256 = crypto.createHash('sha256').update(G.canonicalJson(rest)).digest('hex');
  fs.writeFileSync(file, JSON.stringify(rest, null, 2));
  const back = CF.readObservation(s.ws, s.pid, ob.observation_id);
  assert.equal(back.ok, true, back.words);
  assert.equal(back.observation.identity_key, ob.identity_key);
  return back.observation;
}

const PROPOSAL = { entry_zone: { low_usd: 6.9, high_usd: 7.2, basis: 'prior range (FICTIONAL)' }, upside_target: { price_usd: 9.5, basis: 'fees double' }, invalidation_trigger: { price_usd: 6.1, metric: { key: 'fees', below_30d_usd: 100000 }, statement: 'Below $6.10 or fees under $100k a month.' } };
const BAR = { open: '7.04', high: '7.10', low: '6.98', close: '7.04' };

async function granted(s, between = async () => {}, { proposal = PROPOSAL, action = 'approve' } = {}) {
  TF.settle(s.ws);
  await observe(s);
  const tk = H.withExitReadings(1.5, () => T.createTicket(s.ws, { project_id: s.pid, assistant: true })).ticket;
  const saved = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: TF.answer(T.loadTicket(s.ws, s.pid, tk.ticket_id), proposal) });
  assert.equal(saved.status, 'saved', saved.message);
  const now0 = Date.now();
  const top = Math.floor(now0 / TF.H) * TF.H;
  TD.applyHours(s.ws, Array.from({ length: 16 }, (_, i) => TF.bar(top - (16 - i) * TF.H, BAR)), { now: TF.iso(now0) });
  await between();
  const d = T.decide(s.ws, s.pid, { receipt_id: saved.receipt.receipt_id, action, request_id: 'req_cg14_lot_00001' }).result.decision;
  return { decision: d, receipt: saved.receipt, read: () => TD.requests(s.ws, {}).requests.find((x) => x.decision_id === d.decision_id) };
}

// The risk-sized order, read on an identical twin in observe mode (no CG-14).
async function riskSized(t, opts, action = 'approve') {
  const s = desk(t, opts);
  const g = await granted(s, async () => {}, { action });
  const ex = TD.executionFor(s.ws, g.decision.decision_id);
  const r = ex.reserved.find((x) => x.side === 'OPEN_LONG') || ex.reserved[0];
  assert.ok(r && r.quantity, JSON.stringify(ex).slice(0, 300));
  return { quantity: r.quantity, notional: r.notional_usd, entry: r.entry_price, loss: r.loss_at_stop_usd };
}

const OPENED = ['order', 'open', 'ready'];
const nothingReserved = (s, g) => assert.equal(TD.executionFor(s.ws, g.decision.decision_id).reserved.length, 0, 'nothing reserved');

test('LOT1: capture asks the quoter for whole lots and records the exact base units sent', async (t) => {
  const s = desk(t);
  TF.settle(s.ws);
  SENT.length = 0;
  const ob = await observe(s);
  const p = ob.pools.find((x) => x.pool === POOL3);
  assert.deepEqual(Object.keys(p.quoted_in), ['100', '500', '2000']);
  assert.deepEqual(Object.values(p.quoted_in), ['14204545000000000000', '71022727000000000000', '284090909000000000000']);
  for (const v of Object.values(p.quoted_in)) assert.equal(BigInt(v) % STEP, 0n);
  assert.deepEqual(SENT.slice(-3).map(String), Object.values(p.quoted_in), 'quoted_in is exactly what the quoter was sent');
  assert.equal(ob.transfer_probe.status, 'ok');
  assert.equal(ob.transfer_probe.sell_path.tax_bps, 0);
});

test('LOT2 worked example: Eric halves the grant; the risk-sized order falls between rungs, is sized down to the largest proven quote and opens through the normal path', async (t) => {
  const r = await riskSized(t, {}, 'halve');
  const s = desk(t);
  let ob = null;
  let sizes = null;
  const g = await granted(s, async () => {
    ob = await observe(s);
    s.ws.settings.tickets.contract_gate.mode = 'enforce';
    sizes = T.contractQuotedSizes(s.ws, require('../core/projects').getProject(s.ws, s.pid), { lot: TD.LOT });
  }, { action: 'halve' });
  const a = g.read();
  assert.ok(OPENED.includes(a.phase), `${a.phase}: ${a.words}`);
  const ex = TD.executionFor(s.ws, g.decision.decision_id);
  const fin = ex.reserved[0];
  const pick = sizes.find((x) => dec(x.quantity) <= dec(r.quantity));
  assert.ok(pick, 'a quote at or under the risk-sized quantity');
  assert.ok(dec(fin.quantity) < dec(r.quantity), 'sized down');
  assert.equal(fin.quantity, pick.quantity, 'the final quantity is the quote\'s recorded quantity');
  assert.equal(G.baseUnits(fin.quantity, 18).toString(), ob.pools.find((x) => x.pool === POOL3).quoted_in[pick.reference_usd], 'unit for unit');
  assert.equal(fin.notional_usd, str(mulCeil(dec(fin.quantity), dec(fin.entry_price))));
  // The final guard, read by hand, proves it on the V3 pool; the risk-sized one is not provable.
  const fx = G.fittedExit(ob, { notionalUsd: fin.notional_usd, priceUsd: fin.entry_price, quantity: fin.quantity, networkFeeUsd: '5', limitPct: 5, priceStaleMinutes: 90 });
  assert.equal(fx.ok, true, fx.words);
  assert.equal(fx.pool, POOL3);
  const before = G.fittedExit(ob, { notionalUsd: r.notional, priceUsd: r.entry, quantity: r.quantity, networkFeeUsd: '5', limitPct: 5, priceStaleMinutes: 90 });
  assert.equal(before.ok, false);
  // The ticket's exit table (tickets.js packet ladder: the reference size at the stored price) agrees with the guard.
  const row = G.exitLadder(ob, { sizes: [Number(pick.reference_usd)], priceUsd: ob.price_ref.usd, networkFeeUsd: '5', limitPct: 5 }).pools.find((x) => x.pool === POOL3).rows[0];
  assert.equal(row.q, G.baseUnits(fin.quantity, 18).toString(), 'the table row sells the same quantity');
  assert.equal(row.out, ob.pools.find((x) => x.pool === POOL3).quoted[pick.reference_usd], 'and the same quoter answer');
  const gap = Number(row.cost_pct) - Number(fx.cost_pct);
  assert.ok(gap >= 0 && gap < 1e-5, `table ${row.cost_pct}% vs guard ${fx.cost_pct}%`);
  console.log(`WORKED-EXAMPLE ${JSON.stringify({
    entry_usd: fin.entry_price, stop_usd: '6.1', risk_sized: { quantity: r.quantity, notional_usd: r.notional, loss_at_stop_usd: r.loss, exit: before.words },
    quotes_whole_lot: sizes.map((x) => ({ reference_usd: x.reference_usd, quantity: x.quantity, base_units: x.base, input: x.recorded ? 'recorded' : 'rebuilt' })),
    chosen: pick.reference_usd, final: { quantity: fin.quantity, base_units: G.baseUnits(fin.quantity, 18).toString(), notional_usd: fin.notional_usd, loss_at_stop_usd: fin.loss_at_stop_usd, exit: fx.words, pool: fx.pool },
    exit_table_row: { reference_usd: pick.reference_usd, q: row.q, cost_pct: row.cost_pct }, guard_cost_pct: fx.cost_pct,
  })}`);
});

test('LOT3: a recorded quantity one base unit off is not a whole number of lots, so nothing is sized to it and nothing is reserved', async (t) => {
  const s = desk(t);
  const g = await granted(s, async () => {
    const ob = await observe(s);
    reseal(s, ob, (o) => { for (const p of o.pools) if (p.quoted_in) for (const k of Object.keys(p.quoted_in)) p.quoted_in[k] = (BigInt(p.quoted_in[k]) + 1n).toString(); });
    s.ws.settings.tickets.contract_gate.mode = 'enforce';
  });
  const a = g.read();
  assert.equal(a.phase, 'waiting', `${a.phase}: ${a.words}`);
  assert.equal(a.contract.rule_id, 'CG-14');
  assert.match(a.words, /No saved exit quote is proven for a whole number of lots/);
  nothingReserved(s, g);
});

test('LOT4: an older observation (no recorded inputs, a stored price that rebuilds to fractional lots) is not sized down and waits', async (t) => {
  const s = desk(t);
  const g = await granted(s, async () => {
    const ob = await observe(s);
    reseal(s, ob, (o) => { for (const p of o.pools) delete p.quoted_in; });
    s.ws.settings.tickets.contract_gate.mode = 'enforce';
  });
  const a = g.read();
  assert.equal(a.phase, 'waiting', `${a.phase}: ${a.words}`);
  assert.equal(a.contract.rule_id, 'CG-14');
  assert.match(a.words, /No saved exit quote is proven for a whole number of lots/);
  nothingReserved(s, g);
});

test('LOT5: an unprovable legacy quote (no recorded inputs and no stored price) waits', async (t) => {
  const s = desk(t);
  const g = await granted(s, async () => {
    const ob = await observe(s);
    reseal(s, ob, (o) => { for (const p of o.pools) delete p.quoted_in; delete o.price_ref; });
    s.ws.settings.tickets.contract_gate.mode = 'enforce';
  });
  const a = g.read();
  assert.equal(a.phase, 'waiting', `${a.phase}: ${a.words}`);
  assert.equal(a.contract.rule_id, 'CG-14');
  assert.match(a.words, /no stored price|No saved exit quote/);
  nothingReserved(s, g);
});

test('LOT6: with the sell tax unavailable, the snapped quantity is not proven either and the order waits, tax unknown', async (t) => {
  const s = desk(t);
  const g = await granted(s, async () => {
    const ob = await observe(s, { failLogs: true });
    assert.equal(ob.transfer_probe.status, 'unavailable');
    assert.ok(ob.pools.find((x) => x.pool === POOL3).quoted_in, 'the quotes are recorded');
    s.ws.settings.tickets.contract_gate.mode = 'enforce';
  });
  const a = g.read();
  assert.equal(a.phase, 'waiting', `${a.phase}: ${a.words}`);
  assert.equal(a.contract.rule_id, 'CG-14');
  assert.match(a.words, /transfer tax unknown/);
  // The risk-sized order is itself the $2,000 rung here, so it is tried "At" that quantity.
  assert.match(a.words, /At 284\.090909, the quantity of the \$2000 reference quote, the exit is still not proven: .*transfer tax unknown/);
  nothingReserved(s, g);
});

test('LOT7: an order snapped below the venue minimum is refused by the book\'s own check and waits', async (t) => {
  // A $5 reference size, under the $10 minimum, is the only quote with an
  // answer (the quoter has nothing above 1 token), and the fee is small enough
  // that its exit is proven.
  const s = desk(t, { fee: 0.01 });
  t.after(() => { QUOTER_CAP = null; });
  const g = await granted(s, async () => {
    s.ws.settings.forensics = { preferences: { exit_sizes_usd: [5, 100, 500, 2000], exit_position_usd: 500 } };
    QUOTER_CAP = E18;
    // A pair of 20 tokens / $140.80: it proves $5 but not $100.
    const ob = await observe(s, { thin: { token: 20n * E18, quote: 140800000n } });
    QUOTER_CAP = null;
    assert.deepEqual(Object.keys(ob.pools.find((x) => x.pool === POOL3).quoted_in), ['5', '100', '500', '2000']);
    s.ws.settings.tickets.contract_gate.mode = 'enforce';
  });
  const a = g.read();
  assert.equal(a.phase, 'waiting', `${a.phase}: ${a.words}`);
  assert.equal(a.contract.rule_id, 'CG-14');
  assert.match(a.words, /Sized down to 0\.710227, the quantity of the \$5 reference quote, the book would refuse it: .*below the venue's minimum 10/);
  nothingReserved(s, g);
});

test('LOT8: the WATCH_ONLY outcome stays valid: a desk gate kept on watch opens nothing', async (t) => {
  const s = desk(t);
  s.ws.settings.tickets.sizing = { min_grade_new_entry: 99 };
  TF.settle(s.ws);
  await observe(s);
  s.ws.settings.tickets.contract_gate.mode = 'enforce';
  const tk = H.withExitReadings(1.5, () => T.createTicket(s.ws, { project_id: s.pid, assistant: true })).ticket;
  const saved = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: TF.answer(T.loadTicket(s.ws, s.pid, tk.ticket_id), { ...PROPOSAL, proposal_type: 'WATCH_ONLY' }) });
  assert.equal(saved.status, 'saved', saved.message);
  assert.equal(saved.receipt.desk.proposal_type, 'WATCH_ONLY');
  const d = T.decide(s.ws, s.pid, { receipt_id: saved.receipt.receipt_id, action: 'watch', request_id: 'req_cg14_lot_watch1' }).result.decision;
  assert.equal(d.action, 'watch');
  const a = TD.requests(s.ws, {}).requests.find((x) => x.decision_id === d.decision_id);
  assert.ok(!a || !OPENED.includes(a.phase), a && `${a.phase}: ${a.words}`);
  assert.equal(TD.executionFor(s.ws, d.decision_id).reserved.length, 0);
});

test('LOT2b: the full grant is capped at the $2,000 exit reading, which is exactly the whole-lot $2,000 quote, so it opens on that quote with no size-down', async (t) => {
  const r = await riskSized(t);
  const s = desk(t);
  let ob = null;
  const g = await granted(s, async () => {
    ob = await observe(s);
    s.ws.settings.tickets.contract_gate.mode = 'enforce';
  });
  const a = g.read();
  assert.ok(OPENED.includes(a.phase), `${a.phase}: ${a.words}`);
  const fin = TD.executionFor(s.ws, g.decision.decision_id).reserved[0];
  assert.equal(fin.quantity, r.quantity, 'the risk-sized order itself');
  assert.equal(G.baseUnits(fin.quantity, 18).toString(), ob.pools.find((x) => x.pool === POOL3).quoted_in['2000']);
  console.log(`EXACT-RUNG ${JSON.stringify({ quantity: fin.quantity, notional_usd: fin.notional_usd, quoted_in_2000: ob.pools.find((x) => x.pool === POOL3).quoted_in['2000'] })}`);
});
