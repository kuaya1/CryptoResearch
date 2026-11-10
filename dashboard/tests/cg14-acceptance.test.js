'use strict';
// What CG-14 may accept (audit 2026-11-08, part 1). FICTIONAL chain, pools,
// quoter, desk and prices; temporary workspaces only, no network, no key.
// Each REQUIREMENT test states the behaviour CG-14 should have. A requirement
// that fails on 8664635 is a defect; the comment says why it fails there.
//
// The evidence rule: a concentrated pool's quote is the quoter's answer for one
// token quantity, the dollar size divided by the observation's stored price
// (contract-forensics.js quotePools, price_ref), in base units. The fitted
// order sells the trader's own sz.quantity (trade-risk.js sizing). A quote is
// evidence for the order only when those two base-unit quantities are equal;
// a quantity rebuilt from a dollar notional is not the order's quantity.
// Since the lot-aligned capture (prototype, same day) a quote also records the
// base units it was sent (quoted_in); the B2, B4 and B5 cases are therefore
// run on older observations, re-sealed without it (cg14-lot-sizing.test.js
// covers recorded quotes).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Where the fixtures may live. Each test's workspace is its own directory,
// made by helpers.tempWorkspace under os.tmpdir(). An audit run supplies its
// disposable folder in CR_AUDIT_SAFE_ROOT: an absolute path that must hold
// os.tmpdir(). Any other run (CI included) checks the fixtures against the
// system temp folder. Containment is by path segment, so a sibling sharing
// the root's name prefix is outside it.
const SAFE = process.env.CR_AUDIT_SAFE_ROOT;
if (SAFE !== undefined) assert.ok(typeof SAFE === 'string' && SAFE !== '' && path.isAbsolute(SAFE), 'CR_AUDIT_SAFE_ROOT must name the disposable folder');
const ROOT = path.resolve(SAFE === undefined ? os.tmpdir() : SAFE);
const under = (p) => {
  const rel = path.relative(ROOT, path.resolve(p));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
assert.ok(under(path.join(ROOT, 'w')) && !under(ROOT) && !under(`${ROOT}-sibling`) && !under(path.join(`${ROOT}x`, 'w')), 'containment is by path segment, not by name prefix');
if (SAFE !== undefined) assert.ok(under(os.tmpdir()), `os.tmpdir() ${os.tmpdir()} is not under ${SAFE}`);
assert.ok(!process.env.CR_DATA_DIR && !process.env.CR_WORKSPACE, 'no real desk path may be set');

const G = require('../core/contract-gate');
const K = require('../core/keccak');
const CF = require('../core/contract-forensics');
const T = require('../core/tickets');
const TD = require('../core/trader-desk');
const TF = require('./trader-fixture');
const H = require('./helpers');
const projects = require('../core/projects');
const { world, baseState, ROW, TOKEN, USDC, BUYER, T0, T1, PAIR, ADDR, Aw, W, sel, arg, ok, okA, TOKEN_CODE, sources, timelocks, liveBlock, TL } = require('./contract-world');

const KEY = 'FICTIONALkey_0123456789';
const E18 = 10n ** 18n;
const E6 = 10n ** 6n;

// ---------------------------------------------------------------------------
// Unit level: one concentrated pool, quoted at a stored price of $0.85.
// The quoter pays $0.849 a token: 0.12% price impact.

const REF = '0.85';
const quotedAt = (ref, sizes) => Object.fromEntries(sizes.map((s) => [String(s), ((G.tokensFor(s, ref, 18) * 849n) / (1000n * 10n ** 12n)).toString()]));
const clPool = (ref = REF, sizes = [100, 500, 2000]) => ({ pool: '0xv3', mechanism: 'concentrated', counted: true, quote_decimals: 6, quote_usd: '1', reserves: { token: '1', quote: '1' }, quoted: quotedAt(ref, sizes) });
// The three times a capture writes (audit round 6): the stored price 8 minutes after the block, the capture finished 13 minutes after.
const TIMED = { block: { timestamp: '2026-11-09T12:00:00.000Z' }, retrieved: { started_at: '2026-11-09T12:12:00.000Z', finished_at: '2026-11-09T12:13:00.000Z' } };
const obsOf = (pools, { tax = 0, ref = REF } = {}) => ({ token: { decimals: 18 }, ...TIMED, price_ref: { usd: ref, as_of: '2026-11-09T12:08:00.000Z', source: 'coingecko_stored' }, transfer_probe: tax === null ? { status: 'unavailable', words: 'The pool\'s recent transfers did not read.' } : { status: 'ok', sell_path: { tax_bps: tax } }, pools });
// A base-unit count as a decimal token quantity (18 decimals).
const asQty = (base, decimals = 18) => { const s = base.toString().padStart(decimals + 1, '0'); return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, ''); };
// The quantity an order of `notional` at `entry` buys, for the unit cases.
const qtyOf = (notional, entry) => asQty(G.tokensFor(notional, entry, 18));
const fx = (o, notional, entry = REF, quantity = qtyOf(notional, entry)) => G.fittedExit(o, { notionalUsd: notional, priceUsd: entry, quantity, networkFeeUsd: '0.5', limitPct: 5, priceStaleMinutes: 90 });

test('REQUIREMENT A1 (passes on 8664635): $500 at the stored price uses the $500 quote', () => {
  const r = fx(obsOf([clPool()]), '500');
  assert.equal(r.ok, true, r.words);
  assert.equal(r.pool, '0xv3');
});

test('REQUIREMENT A2 (fails on 8664635): "500.00" is the same token quantity as "500", so it uses the same quote', () => {
  const a = fx(obsOf([clPool()]), '500');
  const b = fx(obsOf([clPool()]), '500.00');
  // 8664635: the lookup is quoted[String(sizeUsd)], so "500.00" finds no key
  // and reads "No verified pool prices a sale of $500".
  assert.equal(b.ok, true, b.words);
  assert.equal(b.cost_pct, a.cost_pct);
});

test('REQUIREMENT A3 (passes on 8664635): $500.01 and other unquoted sizes refuse; no quote covers their quantity', () => {
  for (const n of ['500.01', '499.99', '250', '2000.01']) {
    const r = fx(obsOf([clPool()]), n);
    assert.equal(r.ok, false, n);
    assert.equal(r.rule_id, 'CG-14');
  }
});

test('REQUIREMENT A4 (fails on 8664635): a $500 quote taken at $0.85 does not clear a $500 order at a $0.90 entry (a different token quantity)', () => {
  // 10,000/17 = 588.2 tokens were quoted; the order sells 555.6.
  assert.notEqual(G.tokensFor('500', '0.85', 18), G.tokensFor('500', '0.90', 18));
  const r = fx(obsOf([clPool()]), '500', '0.90');
  // 8664635: the label "500" matches, so the $0.85 quote is used and the
  // order passes at about 0.2%.
  assert.equal(r.ok, false, r.words);
});

test('REQUIREMENT A5 (passes on 8664635): an unavailable sell probe leaves tax unknown and holds; a measured 0% tax with a complete quote passes', () => {
  const held = fx(obsOf([clPool()], { tax: null }), '500');
  assert.equal(held.ok, false);
  assert.match(held.words, /transfer tax unknown/);
  const pass = fx(obsOf([clPool()], { tax: 0 }), '500');
  assert.equal(pass.ok, true, pass.words);
});

test('REQUIREMENT A6 (fails on 8664635): the quote is compared with the order\'s own quantity, not one rebuilt from its rounded-up notional', () => {
  // The trader rounds the notional UP at 18 places (trade-risk.js mulCeil), so
  // notional / entry can be one base unit more than the quantity it sells.
  const entry = '0.5';
  const qty = '1000.000000000000000001';
  const notional = '500.000000000000000001'; // ceil(qty x 0.5) at 18 places
  const rebuilt = G.tokensFor(notional, entry, 18);
  assert.equal(rebuilt, 1000000000000000000002n);
  assert.notEqual(rebuilt, 1000000000000000000001n, 'the order sells one base unit fewer');
  // A quote, at the stored price $0.50, for the rebuilt quantity (the quoter pays $0.4995).
  const pool = { ...clPool(entry, []), quoted: { [notional]: ((rebuilt * 4995n) / (10000n * 10n ** 12n)).toString() } };
  const o = obsOf([pool], { ref: entry });
  const r = fx(o, notional, entry, qty);
  assert.equal(r.ok, false, r.words);
  assert.equal(r.rule_id, 'CG-14');
  // The same quote is evidence for an order of exactly its quantity.
  assert.equal(fx(o, notional, entry, asQty(rebuilt)).ok, true);
});

test('REQUIREMENT A7 (fails on 8664635): an unknown fitted quantity, or one that is not a whole number of base units, refuses', () => {
  const none = G.fittedExit(obsOf([clPool()]), { notionalUsd: '500', priceUsd: REF, networkFeeUsd: '0.5', limitPct: 5, priceStaleMinutes: 90 });
  assert.equal(none.ok, false);
  assert.match(none.words, /fitted quantity is unknown/);
  const six = { ...obsOf([clPool()]), token: { decimals: 6 } };
  const frac = G.fittedExit(six, { notionalUsd: '500', priceUsd: REF, quantity: '588.2352941', networkFeeUsd: '0.5', limitPct: 5, priceStaleMinutes: 90 });
  assert.equal(frac.ok, false);
  assert.match(frac.words, /not a whole number of the token's base units/);
});

test('REQUIREMENT A8 (fails on 8664635): with no saved quote price, no quote can be tied to a quantity, so the exit is not proven', () => {
  const priced = obsOf([clPool()]);
  assert.equal(fx(priced, '500').ok, true, 'the control passes with the stored price');
  for (const price_ref of [undefined, null, { usd: null }, { usd: '' }]) {
    const r = fx({ ...priced, price_ref }, '500');
    assert.equal(r.ok, false, JSON.stringify(price_ref));
    assert.match(r.words, /no stored price/);
  }
});

// ---------------------------------------------------------------------------
// Through the normal trader opening path (trader-desk.js assess, enforce mode):
// a fictional V2 pair (thin, so it never clears the fitted size by itself) and
// a fictional V3 pool whose quoter pays $0.849 a token.

const FACT3 = ADDR('fac3');
const QUOTER = ADDR('9007');
const QCODE = '0x6080604052600f';
const INIT3 = K.keccak256Hex('0x0f1c7101a1');
const POOL3 = K.create2Address(FACT3, K.keccak256Hex(`0x${Aw(T0)}${Aw(T1)}${W(3000)}`), INIT3);
const ROW3 = { chain_id: '8453', name: 'Fictional V3', kind: 'v3', factory: FACT3, init_code_hash: INIT3, fee_tiers: [3000], quoter: QUOTER, quoter_code_hash: K.keccak256Hex(QCODE), quotes: [{ address: USDC, decimals: 6, usd_value: '1' }] };
const V3 = {
  [FACT3]: { code: '0x60806040526003', fns: { [sel('getPool(address,address,uint24)')]: () => okA(POOL3) } },
  [POOL3]: { code: '0x60806040526004', fns: { [sel('token0()')]: () => okA(T0), [sel('token1()')]: () => okA(T1) } },
  [QUOTER]: { code: QCODE, fns: { [sel('quoteExactInputSingle((address,address,uint256,uint24,uint160))')]: (S, f, d) => ok((arg(d, 2) * 849n) / (1000n * 10n ** 12n), 0, 0, 0) } },
};
const THIN_TOKEN = 3529n * E18;
const thinState = () => baseState({ owner: TL, minter: TL, reserve_token: THIN_TOKEN, reserve_quote: 3000n * E6, bal: { [PAIR]: THIN_TOKEN, [BUYER]: 50000n * E18 } });

function desk(t) {
  const w = H.tempWorkspace('cg14-accept', { contracts: { daily_cu_cap: 1000000, monthly_cu_cap: 10000000, pool_factories: [ROW, ROW3], max_log_blocks: 1000 } });
  t.after(w.cleanup);
  assert.ok(under(w.root), 'workspace under the disposable root');
  const pid = H.addFixtureProject(w.ws).project_id;
  H.importAllFixtures(w.ws);
  const file = w.ws.abs(`projects/${pid}/project.json`);
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  p.identity.assets = [{ chain: 'base', contract_address: TOKEN }];
  fs.writeFileSync(file, JSON.stringify(p, null, 2));
  H.freshPrice(w.ws, 'example-payfi-fictional', 0.85);
  w.ws.settings.tickets = { contract_gate: { mode: 'observe' } };
  w.ws.settings.contracts.network_fee_ceiling_usd = { 8453: 0.5 };
  const portfolio = require('../core/portfolio');
  const real = portfolio.computePortfolio;
  portfolio.computePortfolio = (...a) => ({ ...real(...a), positions: [] });
  t.after(() => { portfolio.computePortfolio = real; });
  return { ...w, pid };
}

function failingLogs(w) {
  return { ...w, fetch: async (url, init) => { const { id, method } = JSON.parse(init.body); if (method === 'eth_getLogs') return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message: 'FICTIONAL refusal' } }) }; return w.fetch(url, init); } };
}

let blockN = 9900;
async function observe(s, { price, failLogs = false }) {
  H.freshPrice(s.ws, 'example-payfi-fictional', price);
  let w = world({ S: thinState(), tokenCode: TOKEN_CODE, extra: { ...timelocks, ...V3 }, block: liveBlock(blockN += 1) });
  if (failLogs) w = failingLogs(w);
  await CF.probeNetwork(s.ws, '8453', { fetchImpl: w.fetch, key: KEY, now: Date.now });
  const r = await CF.observeProject(s.ws, s.pid, { fetchImpl: w.fetch, key: KEY, sourceImpl: sources, now: Date.now });
  assert.equal(r.results[0].status, 'saved', JSON.stringify(r.results[0]));
  return CF.readObservation(s.ws, s.pid, r.results[0].observation_id).observation;
}

// A saved ticket and a book with hours; `between` runs before Eric's
// approval, then the approval is recorded. Returns the decision and a reader.
async function granted(s, between = async () => {}) {
  TF.settle(s.ws);
  await observe(s, { price: 0.85 });
  H.freshPrice(s.ws, 'example-payfi-fictional', 0.85);
  const tk = H.withExitReadings(1.5, () => T.createTicket(s.ws, { project_id: s.pid, assistant: true })).ticket;
  const saved = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: TF.answer(T.loadTicket(s.ws, s.pid, tk.ticket_id)) });
  assert.equal(saved.status, 'saved', saved.message);
  const now0 = Date.now();
  const top = Math.floor(now0 / TF.H) * TF.H;
  TD.applyHours(s.ws, Array.from({ length: 16 }, (_, i) => TF.bar(top - (16 - i) * TF.H)), { now: TF.iso(now0) });
  await between();
  const d = T.decide(s.ws, s.pid, { receipt_id: saved.receipt.receipt_id, action: 'approve', request_id: 'req_cg14_accept_0001' }).result.decision;
  return { decision: d, read: () => TD.requests(s.ws, {}).requests.find((x) => x.decision_id === d.decision_id) };
}

// The order the trader makes on this fixture, read on an identical twin desk
// in observe mode (no CG-14), where it is asked of the book at once.
async function twinOrder(t) {
  const s = desk(t);
  const g = await granted(s);
  const a = g.read();
  assert.ok(['order', 'ready', 'open'].includes(a.phase), a.words);
  const ex = TD.executionFor(s.ws, g.decision.decision_id);
  const r = ex.reserved.find((x) => x.side === 'OPEN_LONG') || ex.reserved[0];
  assert.ok(r && r.notional_usd && r.entry_price, JSON.stringify(ex).slice(0, 300));
  return { notional: r.notional_usd, entry: r.entry_price, quantity: r.quantity };
}
const OPENED = ['order', 'open', 'ready'];

test('REQUIREMENT B1 (passes on 8664635): positive control: a measured 0% tax and a V3 quote for the order\'s exact quantity opens', async (t) => {
  const o = await twinOrder(t);
  const s = desk(t);
  const g = await granted(s, async () => {
    // Quote the fitted notional itself, at a stored price equal to the entry.
    s.ws.settings.forensics = { preferences: { exit_sizes_usd: [100, 500, Number(o.notional)], exit_position_usd: 500 } };
    const ob = await observe(s, { price: Number(o.entry) });
    assert.equal(ob.transfer_probe.status, 'ok');
    assert.equal(ob.transfer_probe.sell_path.tax_bps, 0);
    assert.ok(ob.pools.find((p) => p.pool === POOL3).quoted[String(Number(o.notional))], 'the V3 pool is quoted at the fitted notional');
    // The V3 quote is what clears it: the thin V2 pair alone is over the limit.
    const at = { notionalUsd: o.notional, priceUsd: o.entry, quantity: o.quantity, networkFeeUsd: '0.5', limitPct: 5, priceStaleMinutes: 90 };
    assert.equal(G.fittedExit(ob, at).pool, POOL3);
    assert.equal(G.fittedExit({ ...ob, pools: ob.pools.filter((p) => p.pool !== POOL3) }, at).ok, false);
    s.ws.settings.tickets.contract_gate.mode = 'enforce';
  });
  const a = g.read();
  assert.ok(OPENED.includes(a.phase), `${a.phase}: ${a.words}`);
  const ex = TD.executionFor(s.ws, g.decision.decision_id);
  assert.equal(ex.reserved[0].notional_usd, o.notional, 'the twin\'s size is this desk\'s size');
  assert.equal(ex.reserved[0].quantity, o.quantity, 'and its quantity');
});

test('REQUIREMENT B2 (fails on 8664635): an older observation: the same dollar label quoted at a different stored price does not open', async (t) => {
  const o = await twinOrder(t);
  const s = desk(t);
  const g = await granted(s, async () => {
    s.ws.settings.forensics = { preferences: { exit_sizes_usd: [100, 500, Number(o.notional)], exit_position_usd: 500 } };
    // Stored price 20% under the entry: the quote covers 25% more tokens than the order sells.
    asLegacy(s, await observe(s, { price: Number(o.entry) * 0.8 }));
    s.ws.settings.tickets.contract_gate.mode = 'enforce';
  });
  const a = g.read();
  // 8664635: quoted[notional] exists, so the quote for the larger quantity
  // clears the order and it is asked of the book.
  assert.equal(a.phase, 'waiting', `${a.phase}: ${a.words}`);
  assert.equal(a.contract.rule_id, 'CG-14');
  assert.equal(TD.executionFor(s.ws, g.decision.decision_id).reserved.length, 0, 'no order');
});

test('REQUIREMENT B3 (passes on 8664635): an unavailable sell probe keeps the paper order waiting on CG-14 with tax unknown', async (t) => {
  const o = await twinOrder(t);
  const s = desk(t);
  const g = await granted(s, async () => {
    s.ws.settings.forensics = { preferences: { exit_sizes_usd: [100, 500, Number(o.notional)], exit_position_usd: 500 } };
    const ob = await observe(s, { price: Number(o.entry), failLogs: true });
    assert.equal(ob.transfer_probe.status, 'unavailable');
    s.ws.settings.tickets.contract_gate.mode = 'enforce';
  });
  const a = g.read();
  assert.equal(a.phase, 'waiting', `${a.phase}: ${a.words}`);
  assert.equal(a.contract.rule_id, 'CG-14');
  assert.match(a.words, /transfer tax unknown/);
  assert.equal(TD.executionFor(s.ws, g.decision.decision_id).reserved.length, 0, 'no order');
});

test('REQUIREMENT B4 (passes on 8664635): an older observation: a quote for the rounded dollar notional ($2,000) is for a different quantity, so the order stays waiting', async (t) => {
  const o = await twinOrder(t);
  // The fitted order: 2,352.941176 tokens (floored to the lot) for $1,999.9999996.
  // Its notional rounds to $2,000.00, a ladder size the V3 pool is quoted at,
  // and $2,000 at the same price is 2,352.941176470588235294 tokens.
  assert.equal(G.fixed(G.ratio(o.notional), 2, 'ceil', false), '2000');
  const rounded = G.tokensFor('2000', o.entry, 18);
  assert.notEqual(asQty(rounded), o.quantity);
  const s = desk(t);
  const g = await granted(s, async () => {
    // The default ladder ($100, $500, $2,000) at a stored price equal to the entry.
    const ob = asLegacy(s, await observe(s, { price: Number(o.entry) }));
    assert.ok(ob.pools.find((p) => p.pool === POOL3).quoted['2000'], 'the V3 pool is quoted at $2,000');
    assert.equal(ob.transfer_probe.sell_path.tax_bps, 0);
    // That quote is good evidence for a sale of its own quantity: within 5%.
    const own = G.fittedExit(ob, { notionalUsd: '2000', priceUsd: o.entry, quantity: asQty(rounded), networkFeeUsd: '0.5', limitPct: 5, priceStaleMinutes: 90 });
    assert.equal(own.ok, true, own.words);
    assert.equal(own.pool, POOL3);
    s.ws.settings.tickets.contract_gate.mode = 'enforce';
  });
  const a = g.read();
  assert.equal(a.phase, 'waiting', `${a.phase}: ${a.words}`);
  assert.equal(a.contract.rule_id, 'CG-14');
  assert.equal(TD.executionFor(s.ws, g.decision.decision_id).reserved.length, 0, 'no order');
  assert.notEqual(a.contract.fitted && a.contract.fitted.pool, POOL3, 'the V3 quote is not taken as evidence');
});

// An older observation, recorded before quote inputs were kept (quoted_in),
// and with `dropPrice` also before price_ref was: the same record without
// them, re-sealed with its SHA-256. Its quotes can be tied to a quantity only
// by rebuilding it from the stored price.
function asLegacy(s, ob, { dropPrice = false } = {}) {
  const file = s.ws.abs(CF.obsPath(s.pid, ob.observation_id));
  assert.ok(under(file), 'the observation is in the temporary workspace');
  const { sha256: _old, ...rest } = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const p of rest.pools || []) delete p.quoted_in;
  if (dropPrice) delete rest.price_ref;
  rest.sha256 = require('crypto').createHash('sha256').update(G.canonicalJson(rest)).digest('hex');
  fs.writeFileSync(file, JSON.stringify(rest, null, 2));
  const back = CF.readObservation(s.ws, s.pid, ob.observation_id);
  assert.equal(back.ok, true, back.words);
  assert.ok(back.observation.pools.every((p) => p.quoted_in === undefined));
  if (dropPrice) assert.equal(back.observation.price_ref, undefined);
  assert.equal(back.observation.identity_key, ob.identity_key, 'the identity is unchanged');
  return back.observation;
}

test('REQUIREMENT B5 (fails on 8664635): an older observation with the saved quote price missing: the exact-quantity quote cannot be proven and the order stays waiting', async (t) => {
  const o = await twinOrder(t);
  const s = desk(t);
  const g = await granted(s, async () => {
    // B1's setup, which opens: the V3 pool quoted at the fitted notional, at the entry price.
    s.ws.settings.forensics = { preferences: { exit_sizes_usd: [100, 500, Number(o.notional)], exit_position_usd: 500 } };
    const ob = await observe(s, { price: Number(o.entry) });
    assert.ok(ob.pools.find((p) => p.pool === POOL3).quoted[String(Number(o.notional))]);
    asLegacy(s, ob, { dropPrice: true });
    s.ws.settings.tickets.contract_gate.mode = 'enforce';
  });
  const a = g.read();
  assert.equal(a.phase, 'waiting', `${a.phase}: ${a.words}`);
  assert.equal(a.contract.rule_id, 'CG-14');
  assert.equal(TD.executionFor(s.ws, g.decision.decision_id).reserved.length, 0, 'no order');
  assert.notEqual(a.contract.fitted && a.contract.fitted.pool, POOL3, 'the V3 quote is not taken as evidence');
});
