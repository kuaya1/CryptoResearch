'use strict';
// The opening receipt (core/opening-receipt.js, cr.opening-guard.v1): what
// the contract guard evaluated for the order the trader's book was asked for,
// written with the reservation. FICTIONAL chain, pools, quoter, desk and
// prices (opening-receipt-fixture.js); temporary workspaces only; no network.
//
// The rules under test:
// - When the guard does not hold an opening, its final reading goes on the
//   intent the book is asked for: the observation by ID, SHA-256, chain and
//   pinned block; the pool that proved the exit with its unrounded cost; the
//   limits and the rule's versions; the quantity the risk sized and the
//   quantity asked for in exact units; and the pool and reference rung whose
//   saved quote set the size, apart from the pool that proved the exit.
// - It rides as one item of evidence.metrics_evaluated, so the intent stays
//   inside the published cr.trade-intent.v3 schema, which is never edited.
// - The book copies the intent, hashes it and writes it on the reservation's
//   own journal line: no receipt without a reservation, and the line's
//   intent_sha256 covers the receipt.
// - The receipt checks out (verify): made again from the observation it
//   names, with its own inputs, every figure agrees.
// - A hold records nothing. A retry records what the retry read.
// - The receipt names the observation the guard was given, even when another
//   becomes the current one while the guard is still reading.
// - contractOpenGuard answers exactly as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('./opening-receipt-fixture');
const { G, T, TD, PT, OR, POOL3, PAIR, RISK_SIZED, AT_500 } = X;
const risk = require('../core/trade-risk');

const say = (label, v) => console.log(`OPENING ${label} ${JSON.stringify(v)}`);
// Bound, by the independent check, and shown the same by the trader's own read of the decision.
function bound(s, line, did) {
  const c = X.check(s, line);
  assert.equal(c.status, 'bound', `${c.words} ${JSON.stringify(c.differences)}`);
  assert.deepEqual(c.differences, []);
  const ex = TD.executionFor(s.ws, did);
  const shown = ex.reserved.find((r) => r.intent_id === line.intent_id);
  assert.deepEqual(shown.contract_guard, c.record, 'the decision\'s execution shows the receipt as recorded');
  assert.deepEqual([shown.opening_receipt.status, shown.opening_receipt.differences], ['bound', []]);
  assert.equal(shown.intent_sha256, line.intent_sha256);
  return c;
}

test('OG1: a sized-down order: the reservation line carries what the guard evaluated, inside the published intent schema, under the line\'s own hash', async (t) => {
  const s = X.desk(t);
  const { receipt, ob } = await X.ready(s);
  const d = X.approve(s, receipt);
  const lines = X.reservedFor(s, d.decision_id);
  assert.equal(lines.length, 1, X.rowOf(s, d.decision_id).words);
  const rec = X.wellFormed(lines[0]);
  say('OG1', { reserved: { quantity: lines[0].quantity, intent_sha256: lines[0].intent_sha256 }, record: rec, bytes: Buffer.byteLength(OR.textOf(rec)) });
  assert.deepEqual([rec.result, rec.rule_id, rec.gate_mode], ['pass', 'CG-14', 'enforce']);
  // The valuation version and the gate's.
  assert.deepEqual(rec.gate, { version: G.GATE_VERSION, exit: G.EXIT_VERSION });
  assert.equal(rec.gate.exit, 'cr-contract-exit@2');
  // Original and final quantities, in exact units, and how the final one was reached.
  assert.deepEqual(rec.quantity, { unit: 'token', risk_sized: RISK_SIZED, final: AT_500, sized_by: 'quote', decimals: 18, final_base_units: '71022727000000000000' });
  // The observation and block the guard evaluated: the current one, by ID, SHA-256, chain and pinned block.
  assert.deepEqual(rec.observation, { observation_id: ob.observation_id, sha256: ob.sha256, chain_id: '8453', block_number: ob.block.number, block_hash: ob.block.hash, block_time: ob.block.timestamp });
  // The pool and reference rung that supplied the size, and the pool that proved the exit (here the same one).
  assert.deepEqual(rec.size, { pool: POOL3, reference_usd: '500', quote_input: 'recorded', observation_id: ob.observation_id });
  assert.equal(rec.exit.pool, POOL3);
  assert.deepEqual([rec.exit.entry_usd, rec.exit.notional_usd, rec.exit.value_basis], ['6.9', '490.0568163', 'observation']);
  // The limits it was read under, and the unrounded cost.
  assert.deepEqual(rec.limits, { exit_cost_pct: 5, network_fee_usd: '5', price_stale_minutes: 90 });
  assert.match(rec.exit.cost_pct, /^1\.6\d{6,}$/, 'the cost as the guard computed it, not rounded for display');
  assert.equal(G.fixed(G.ratio(rec.exit.cost_pct), 3, 'half_up'), '1.650');
  assert.deepEqual([rec.price_check.state, rec.price_check.limit_minutes], ['ok', 90]);
  assert.equal(rec.checked_at, lines[0].intent.created_at, 'read in the same step that asked the book');
  // What it does not repeat: the project, the ticket and the decision are the intent's own; the grant is the line's.
  assert.equal(JSON.stringify(rec).includes(s.pid), false);
  assert.deepEqual([lines[0].intent.project_id, lines[0].intent.receipt_id, lines[0].intent.decision_id, lines[0].grant.decision_id], [s.pid, receipt.receipt_id, d.decision_id, d.decision_id]);
  // The receipt checks out against the reservation and the observation it names.
  const c = bound(s, lines[0], d.decision_id);
  assert.deepEqual(c.reservation, { project_id: s.pid, receipt_id: receipt.receipt_id, decision_id: d.decision_id, intent_id: lines[0].intent_id, intent_sha256: lines[0].intent_sha256, client_order_id: lines[0].client_order_id, position_id: lines[0].position_id, reserved_at: lines[0].at, quantity: AT_500, entry_price: '6.9', grant: { decision_id: d.decision_id, action: 'approve', decided_at: d.decided_at, decided_by: d.decided_by || null, by_mandate: false } });
  assert.deepEqual([c.recomputed.ok, c.recomputed.pool, c.recomputed.cost_pct], [true, POOL3, rec.exit.cost_pct]);
  // The ticket's own metrics are untouched, and the book's sizing is the line's own.
  assert.deepEqual(lines[0].intent.evidence.metrics_evaluated.slice(0, -1), ['entry_zone.low_usd', 'upside_target.price_usd', 'invalidation_trigger.price_usd', 'invalidation_trigger.metric.fees']);
  assert.equal(lines[0].quantity, AT_500);
  // Steps again: still one reservation, the same line.
  TD.step(s.ws, {});
  TD.step(s.ws, {});
  const again = X.reservedFor(s, d.decision_id);
  assert.equal(again.length, 1);
  assert.equal(again[0].intent_sha256, lines[0].intent_sha256);
});

test('OG2: two pools: the pool whose quote set the size cannot prove the exit, another pool does, and the receipt names them apart', async (t) => {
  const s = X.desk(t);
  // Every V3 quote is over the limit; the pair proves the $500 quantity and not the $2,000 one.
  const { receipt } = await X.ready(s, { current: (x) => X.observe(x, { pair: X.MID, quoter: 'poor' }) });
  const d = X.approve(s, receipt);
  const lines = X.reservedFor(s, d.decision_id);
  assert.equal(lines.length, 1, X.rowOf(s, d.decision_id).words);
  const rec = X.wellFormed(lines[0]);
  say('OG2', { quantity: rec.quantity, size_pool: rec.size.pool === POOL3 ? 'V3' : rec.size.pool, exit_pool: rec.exit.pool === PAIR ? 'V2' : rec.exit.pool, cost_pct: rec.exit.cost_pct });
  assert.deepEqual([rec.quantity.risk_sized, rec.quantity.final, rec.quantity.sized_by], [RISK_SIZED, AT_500, 'quote']);
  assert.equal(rec.size.pool, POOL3, 'the quantity is the V3 pool\'s $500 quote');
  assert.equal(rec.size.reference_usd, '500');
  assert.equal(rec.exit.pool, PAIR, 'the pair proved the exit');
  const c = bound(s, lines[0], d.decision_id);
  // In the pool that supplied the size, that quantity is over the limit.
  const o = X.CF.readObservation(s.ws, s.pid, rec.observation.observation_id).observation;
  const own = G.fittedExit({ ...o, pools: o.pools.filter((p) => p.pool === POOL3) }, { notionalUsd: rec.exit.notional_usd, priceUsd: rec.exit.entry_usd, quantity: rec.quantity.final, networkFeeUsd: '5', limitPct: 5, priceStaleMinutes: 90 });
  assert.equal(own.ok, false, own.words);
  assert.equal(c.recomputed.pool, PAIR);
});

test('OG3: an order the guard passes at the risk-sized quantity records that nothing was sized down', async (t) => {
  const s = X.desk(t);
  const { receipt } = await X.ready(s, { current: (x) => X.observe(x, { pair: X.DEEP }) });
  const d = X.approve(s, receipt);
  const lines = X.reservedFor(s, d.decision_id);
  assert.equal(lines.length, 1, X.rowOf(s, d.decision_id).words);
  const rec = X.wellFormed(lines[0]);
  assert.deepEqual([rec.quantity.risk_sized, rec.quantity.final, rec.quantity.sized_by], [RISK_SIZED, RISK_SIZED, 'risk']);
  assert.equal(lines[0].quantity, RISK_SIZED);
  assert.equal(rec.quantity.final_base_units, '289855072000000000000');
  assert.equal(rec.size, null);
  assert.equal(rec.exit.pool, PAIR);
  bound(s, lines[0], d.decision_id);
});

test('OG10: a newer observation becomes current while the guard is reading: the receipt names the observation the guard was given, never the one that is current afterwards', async (t) => {
  const fs = require('fs');
  const s = X.desk(t);
  // Two observations of a pair deep enough to prove the risk-sized quantity.
  // `given` is the current one when the guard begins; `later` is on file and
  // becomes current only inside the guard's own reading (below).
  let given = null;
  const { receipt } = await X.ready(s, { current: async (x) => { given = await X.observe(x, { pair: X.DEEP }); return given; } });
  const status = s.ws.abs(`projects/${s.pid}/forensics/contracts/status.json`);
  const withGiven = fs.readFileSync(status);
  const later = await X.observe(s, { pair: X.DEEP });
  const withLater = fs.readFileSync(status);
  assert.notEqual(later.observation_id, given.observation_id);
  fs.writeFileSync(status, withGiven);
  X.H.freshPrice(s.ws, 'example-payfi-fictional', X.PRICE);
  const currentNow = () => T.contractIdentityNow(s.ws, require('../core/projects').getProject(s.ws, s.pid), Date.now()).exit_observation.observation_id;
  assert.equal(currentNow(), given.observation_id, 'the first observation is the current one as the order is approved');
  // The guard's own evaluation (contract-gate.js fittedExit), with the newer
  // observation made current the moment it has answered and before the
  // reading is put together.
  const realFitted = G.fittedExit;
  t.after(() => { G.fittedExit = realFitted; });
  const read = [];
  G.fittedExit = (o, opts) => {
    const fx = realFitted(o, opts);
    read.push(o.observation_id);
    fs.writeFileSync(status, withLater);
    return fx;
  };
  const d = X.approve(s, receipt);
  G.fittedExit = realFitted;
  assert.deepEqual(read, [given.observation_id], 'the guard evaluated once, on the observation current when it began');
  assert.equal(currentNow(), later.observation_id, 'and another observation is the current one afterwards');
  const lines = X.reservedFor(s, d.decision_id);
  assert.equal(lines.length, 1, X.rowOf(s, d.decision_id).words);
  const rec = X.wellFormed(lines[0]);
  assert.deepEqual(rec.observation, { observation_id: given.observation_id, sha256: given.sha256, chain_id: String(given.subject.chain_id), block_number: given.block.number, block_hash: given.block.hash, block_time: given.block.timestamp }, 'the receipt names what the guard evaluated');
  assert.notEqual(rec.observation.block_number, later.block.number);
  bound(s, lines[0], d.decision_id);
});

test('OG11: a newer observation becomes current after the sizing quote was proven and before the final guard: the receipt is the final reading, on the newer observation, with the sizing quote\'s own observation named apart', async (t) => {
  const fs = require('fs');
  const s = X.desk(t);
  let given = null;
  const { receipt } = await X.ready(s, { current: async (x) => { given = await X.observe(x); return given; } });
  const status = s.ws.abs(`projects/${s.pid}/forensics/contracts/status.json`);
  const withGiven = fs.readFileSync(status);
  const later = await X.observe(s);
  const withLater = fs.readFileSync(status);
  assert.notEqual(later.observation_id, given.observation_id);
  fs.writeFileSync(status, withGiven);
  X.H.freshPrice(s.ws, 'example-payfi-fictional', X.PRICE);
  // Every evaluation the guard makes; the newer observation is made current
  // the moment a quantity first passes (the sizing quote's own check).
  const realFitted = G.fittedExit;
  t.after(() => { G.fittedExit = realFitted; });
  const read = [];
  G.fittedExit = (o, opts) => {
    const fx = realFitted(o, opts);
    if (fx.ok && !read.some((r) => r[2])) fs.writeFileSync(status, withLater);
    read.push([o.observation_id === given.observation_id ? 'given' : o.observation_id === later.observation_id ? 'later' : o.observation_id, opts.quantity, fx.ok === true]);
    return fx;
  };
  const d = X.approve(s, receipt);
  G.fittedExit = realFitted;
  say('OG11 evaluations', read);
  assert.deepEqual(read[0], ['given', RISK_SIZED, false], 'the risk-sized quantity is not proven');
  assert.ok(read.some((r) => r[0] === 'given' && r[1] === AT_500 && r[2]), 'the $500 quote\'s quantity is proven on the first observation');
  assert.deepEqual(read[read.length - 1], ['later', AT_500, true], 'the final guard evaluated the newer observation');
  const lines = X.reservedFor(s, d.decision_id);
  assert.equal(lines.length, 1, X.rowOf(s, d.decision_id).words);
  const rec = X.wellFormed(lines[0]);
  assert.deepEqual([rec.observation.observation_id, rec.observation.sha256, rec.observation.block_number], [later.observation_id, later.sha256, later.block.number], 'the receipt is the final reading, not the first that passed');
  assert.equal(rec.size.observation_id, given.observation_id, 'the sizing quote is named with the observation it was read from');
  assert.deepEqual([rec.quantity.risk_sized, rec.quantity.final, rec.quantity.sized_by], [RISK_SIZED, AT_500, 'quote']);
  bound(s, lines[0], d.decision_id);
});

test('OG4: observe mode: the receipt says the guard did not run, and the check reads not_checked, never bound', async (t) => {
  const s = X.desk(t);
  const { receipt } = await X.ready(s, { mode: 'observe' });
  const d = X.approve(s, receipt);
  const lines = X.reservedFor(s, d.decision_id);
  assert.equal(lines.length, 1, X.rowOf(s, d.decision_id).words);
  const rec = X.wellFormed(lines[0]);
  assert.deepEqual([rec.result, rec.why, rec.gate_mode], ['not_checked', 'gate_not_enforced', 'observe']);
  assert.deepEqual(rec.quantity, { unit: 'token', risk_sized: lines[0].quantity, final: lines[0].quantity, sized_by: 'risk' });
  assert.equal(rec.size, null);
  assert.equal(rec.exit, undefined);
  assert.equal(rec.observation, undefined);
  const c = X.check(s, lines[0]);
  assert.equal(c.status, 'not_checked');
  assert.match(c.words, /was not enforced when this order was asked for \(observe mode\): the guard did not run/);
  assert.equal(TD.executionFor(s.ws, d.decision_id).reserved[0].opening_receipt.status, 'not_checked');
});

test('OG5: a hold records nothing; the retry records the observation the retry read; one reservation', async (t) => {
  const s = X.desk(t);
  // The current observation's quoter pays nothing: every quantity holds.
  const { receipt, ob: first } = await X.ready(s, { current: (x) => X.observe(x, { quoter: 'zero' }) });
  const d = X.approve(s, receipt);
  const held = X.rowOf(s, d.decision_id);
  assert.equal(held.phase, 'waiting', held.words);
  assert.equal(held.contract.rule_id, 'CG-14');
  assert.equal(X.reservedFor(s, d.decision_id).length, 0);
  assert.equal(X.journal(s).some((e) => JSON.stringify(e).includes(OR.KEY)), false, 'nothing of a receipt is on disk');
  // A newer observation, then the next step.
  const second = await X.observe(s);
  assert.notEqual(second.observation_id, first.observation_id);
  TD.step(s.ws, {});
  const lines = X.reservedFor(s, d.decision_id);
  assert.equal(lines.length, 1, X.rowOf(s, d.decision_id).words);
  const rec = X.wellFormed(lines[0]);
  assert.equal(rec.observation.observation_id, second.observation_id, 'the retry\'s own reading');
  assert.equal(rec.size.observation_id, second.observation_id);
  assert.deepEqual([rec.quantity.risk_sized, rec.quantity.final, rec.quantity.sized_by], [RISK_SIZED, AT_500, 'quote']);
  bound(s, lines[0], d.decision_id);
  TD.step(s.ws, {});
  assert.equal(X.reservedFor(s, d.decision_id).length, 1);
});

test('OG6: the book fails before anything is written: no receipt and no reservation; the next step writes both in one line', async (t) => {
  const s = X.desk(t);
  const { receipt } = await X.ready(s);
  const real = PT.submitIntent;
  let asked = 0;
  PT.submitIntent = () => { asked += 1; const err = new Error('FICTIONAL: the disk is full'); err.code = 'ENOSPC'; throw err; };
  t.after(() => { PT.submitIntent = real; });
  const d = X.approve(s, receipt);
  assert.equal(asked, 1, 'the book was asked once');
  assert.equal(X.journal(s).filter((e) => e.type === 'reserved').length, 0);
  assert.equal(X.journal(s).some((e) => JSON.stringify(e).includes(OR.KEY)), false);
  assert.equal(X.rowOf(s, d.decision_id).phase, 'ready', 'the request still waits to be asked');
  PT.submitIntent = real;
  TD.step(s.ws, {});
  const lines = X.reservedFor(s, d.decision_id);
  assert.equal(lines.length, 1, X.rowOf(s, d.decision_id).words);
  X.wellFormed(lines[0]);
  bound(s, lines[0], d.decision_id);
});

test('OG7: the step stops after the reservation and before the order is sent: the line and its receipt are already whole, and stay as written', async (t) => {
  const s = X.desk(t);
  const { receipt } = await X.ready(s);
  const real = PT.submitIntent;
  PT.submitIntent = (ws, intent, ctx) => { PT.reserveIntent(ws, intent, ctx); throw new Error('FICTIONAL: the process stopped here'); };
  t.after(() => { PT.submitIntent = real; });
  const d = X.approve(s, receipt);
  PT.submitIntent = real;
  const lines = X.reservedFor(s, d.decision_id);
  assert.equal(lines.length, 1);
  const rec = X.wellFormed(lines[0]);
  bound(s, lines[0], d.decision_id);
  // The book's own recovery settles the order; the reservation and its receipt stay as written.
  TD.step(s.ws, {});
  TD.step(s.ws, {});
  const after = X.reservedFor(s, d.decision_id);
  assert.equal(after.length, 1);
  assert.equal(after[0].intent_sha256, lines[0].intent_sha256);
  assert.deepEqual(TD.executionFor(s.ws, d.decision_id).reserved[0].contract_guard, rec);
  bound(s, after[0], d.decision_id);
});

test('OG8: reading a receipt back: none, one, and what does not read', () => {
  const rec = { version: 'cr.opening-guard.v1', gate_mode: 'observe', checked_at: '2026-11-10T12:00:00.000Z', result: 'not_checked', why: 'gate_not_enforced', quantity: { unit: 'token', risk_sized: '2', final: '2', sized_by: 'risk' }, size: null };
  assert.deepEqual(OR.problemsOf(rec), []);
  const base = { evidence: { catalyst: 'c (FICTIONAL)', metrics_evaluated: ['entry_zone.low_usd'], negative_invalidation: 'n' } };
  const withItems = (...items) => ({ evidence: { ...base.evidence, metrics_evaluated: [...base.evidence.metrics_evaluated, ...items] } });
  const text = OR.textOf(rec);
  assert.equal(text, `contract_gate.opening_guard=${G.canonicalJson(rec)}`);
  assert.deepEqual(OR.readFrom(withItems(text)), rec);
  assert.deepEqual(OR.readFrom(OR.attach(base, rec)), rec);
  assert.deepEqual(OR.attach(base, rec).evidence.metrics_evaluated, ['entry_zone.low_usd', text], 'after the ticket\'s own metrics');
  // No receipt: an order made before it existed, a close, or no intent at all. Said as none, never guessed.
  for (const it of [base, { evidence: {} }, {}, null, undefined]) assert.equal(OR.readFrom(it), null);
  // Not readable: two receipts, text that is not JSON, another version, JSON not in canonical form, or a record that is not whole.
  const spaced = `contract_gate.opening_guard=${JSON.stringify(rec, null, 1)}`;
  const reordered = `contract_gate.opening_guard=${JSON.stringify({ result: 'not_checked', ...rec })}`;
  const partial = OR.textOf({ version: 'cr.opening-guard.v1', gate_mode: 'enforce', checked_at: rec.checked_at, result: 'pass', quantity: { ...rec.quantity } });
  for (const it of [withItems(text, text), withItems('contract_gate.opening_guard={'), withItems('contract_gate.opening_guard=[]'), withItems(OR.textOf({ ...rec, version: 'cr.opening-guard.v2' })), withItems(spaced), withItems(reordered), withItems(partial)]) {
    const r = OR.readFrom(it);
    assert.equal(r && r.unreadable, true, JSON.stringify(it.evidence.metrics_evaluated).slice(0, 120));
    assert.ok(r.words);
  }
  // A whole record, and each thing a whole record needs, taken away or spoiled one at a time: named, and not read.
  const pass = {
    version: 'cr.opening-guard.v1', gate_mode: 'enforce', checked_at: rec.checked_at, result: 'pass', rule_id: 'CG-14', gate: { version: G.GATE_VERSION, exit: G.EXIT_VERSION },
    observation: { observation_id: 'co_0123456789abcdef', sha256: 'a'.repeat(64), chain_id: '8453', block_number: 73001, block_hash: `0x${'b'.repeat(64)}`, block_time: '2026-11-10T11:59:00.000Z' },
    exit: { pool: POOL3, cost_pct: '1.25', value_usd: '500.00', value_basis: 'observation', notional_usd: '490.056816', entry_usd: '6.9' },
    limits: { exit_cost_pct: 5, network_fee_usd: '5', price_stale_minutes: 90 },
    price_check: { state: 'ok', limit_minutes: 90, gap_ms: 1000, as_of: '2026-11-10T11:58:59.000Z' },
    quantity: { unit: 'token', risk_sized: RISK_SIZED, final: AT_500, sized_by: 'quote', decimals: 18, final_base_units: '71022727000000000000' },
    size: { pool: POOL3, reference_usd: '500', quote_input: 'recorded', observation_id: 'co_0123456789abcdef' },
  };
  assert.deepEqual(OR.problemsOf(pass), []);
  assert.deepEqual(OR.readFrom(withItems(OR.textOf(pass))), pass);
  const SHAPE = [
    ['a gate mode the gate does not have', rec, (r) => { r.gate_mode = 'sometimes'; }, /its gate mode is not one the gate has/],
    ['a time that is not a UTC instant', rec, (r) => { r.checked_at = 'yesterday'; }, /its time is not a UTC instant/],
    ['a result that is neither a pass nor not checked', rec, (r) => { r.result = 'hold'; }, /its result is neither pass nor not_checked/],
    ['quantities in another unit', rec, (r) => { r.quantity.unit = 'usd'; }, /its quantities are not the risk-sized and final token quantities/],
    ['a risk-sized quantity that is not a plain decimal', rec, (r) => { r.quantity.risk_sized = '2e3'; }, /its quantities are not the risk-sized and final token quantities/],
    ['no reason the guard did not run', rec, (r) => { delete r.why; }, /it does not say why the guard did not run/],
    ['an unchecked order that names a sizing quote', rec, (r) => { r.size = { ...pass.size }; }, /an order the guard did not check names a sizing quote/],
    ['a pass with the gate not enforced', pass, (r) => { r.gate_mode = 'observe'; }, /a pass is recorded with the gate not enforced/],
    ['a pass under another rule', pass, (r) => { r.rule_id = 'CG-10'; }, /its rule is not CG-14/],
    ['a pass without the valuation\'s version', pass, (r) => { delete r.gate.exit; }, /it does not name the gate's and the valuation's versions/],
    ['a pass without the observation\'s SHA-256', pass, (r) => { r.observation.sha256 = null; }, /it does not name the observation by ID, SHA-256, chain and pinned block/],
    ['a pass without the pinned block', pass, (r) => { delete r.observation.block_number; }, /it does not name the observation by ID, SHA-256, chain and pinned block/],
    ['a pass without exact base units', pass, (r) => { delete r.quantity.final_base_units; }, /its final quantity has no exact base units/],
    ['a pass with its base units as a number', pass, (r) => { r.quantity.final_base_units = 71022727; }, /its final quantity has no exact base units/],
    ['a pass without the proving pool', pass, (r) => { delete r.exit.pool; }, /it does not name the pool that proved the exit with its unrounded cost and basis/],
    ['a pass whose cost is not a number', pass, (r) => { r.exit.cost_pct = 'about 1'; }, /it does not name the pool that proved the exit with its unrounded cost and basis/],
    ['a quote-asset value with no basis', pass, (r) => { r.exit.quote_usd = '0.99'; }, /its quote-asset value is not a stored or configured figure/],
    ['a pass without the network fee it was read under', pass, (r) => { delete r.limits.network_fee_usd; }, /it does not state the exit-cost limit, the network fee and the price freshness limit/],
    ['a pass whose price check did not pass', pass, (r) => { r.price_check.state = 'stale'; }, /it does not carry the stored price's passing freshness check/],
    ['a sized-down order without its sizing pool', pass, (r) => { delete r.size.pool; }, /it does not name the pool, reference rung and observation of the quote that set the size/],
    ['an order kept at its risk size that names a sizing quote', pass, (r) => { r.quantity.sized_by = 'risk'; }, /an order kept at its risk-sized quantity names a sizing quote/],
  ];
  for (const [name, from, spoil, words] of SHAPE) {
    const r = JSON.parse(JSON.stringify(from));
    spoil(r);
    const bad = OR.problemsOf(r);
    assert.equal(bad.length, 1, `${name}: ${bad.join('; ')}`);
    assert.match(bad[0], words, name);
    const back = OR.readFrom(withItems(OR.textOf(r)));
    assert.equal(back && back.unreadable, true, name);
    assert.match(back.words, words, name);
  }
  // The published schema takes the item as the string it is, and the engine's shape check has nothing to say about it.
  const intent = { version: 'cr.trade-intent.v3', intent_id: '01JBXQ5R7Z8Y9W0V1T2S3R4Q5P', thesis_id: 'tr_fict', project_id: 'fict-project', receipt_id: 'tr_fict', decision_id: 'td_fict', pair: 'FICT/USDC', side: 'OPEN_LONG', order_type: 'LIMIT', created_at: '2026-11-10T12:00:00.000Z', reference_price: '6.9', reference_at: '2026-11-10T11:00:00.000Z', entry_price: '6.9', stop_loss_price: '6.1', take_profit_price: '9.5', risk_ceiling_usd: '61.25', max_slippage_bps: 10, valid_until: '2026-11-13T12:00:00.000Z', ...withItems(text) };
  assert.deepEqual(X.validate(X.SCHEMA, intent).errors, []);
  assert.equal(risk.validateTradeIntent(intent, {}, {}).refusals.some((r) => r.field === 'evidence'), false);
  // The same record as a new evidence property is NOT a valid cr.trade-intent.v3: the schema allows evidence three properties.
  assert.deepEqual(X.validate(X.SCHEMA, { ...intent, evidence: { ...base.evidence, contract_guard: rec } }).errors, ['$.evidence.contract_guard: not allowed']);
});

test('OG9: contractOpenGuard answers as before: null when nothing holds, the same hold when something does', async (t) => {
  const s = X.desk(t);
  const { receipt, ob } = await X.ready(s);
  const project = require('../core/projects').getProject(s.ws, s.pid);
  const pass = { notionalUsd: '490.0568163', priceUsd: '6.9', quantity: AT_500 };
  const over = { notionalUsd: '1960.2272721', priceUsd: '6.9', quantity: '284.090909' };
  assert.equal(T.contractOpenGuard(s.ws, project, receipt, pass), null);
  const r = T.contractOpenReading(s.ws, project, receipt, pass);
  assert.equal(r.hold, null);
  assert.equal(r.guard.result, 'pass');
  assert.equal(r.guard.quantity, undefined, 'the quantities are the adapter\'s to add');
  assert.deepEqual(r.guard.evaluated, { quantity: AT_500, token_decimals: 18 });
  assert.equal(r.guard.observation.sha256, ob.sha256, 'the observation the guard was given, by its own hash');
  const h = T.contractOpenGuard(s.ws, project, receipt, over);
  assert.deepEqual([h.hold, h.final, h.rule_id], [true, false, 'CG-14']);
  const hr = T.contractOpenReading(s.ws, project, receipt, over);
  assert.deepEqual(hr.hold, h);
  assert.equal(hr.guard, null, 'a hold has nothing to record');
  X.setMode(s, 'observe');
  assert.equal(T.contractOpenGuard(s.ws, project, receipt, over), null);
  assert.deepEqual(T.contractOpenReading(s.ws, project, receipt, over).guard.why, 'gate_not_enforced');
  // The sizes the guard can prove name the observation they were read from.
  X.setMode(s, 'enforce');
  const sizes = T.contractQuotedSizes(s.ws, project, { lot: TD.LOT });
  assert.ok(sizes.length > 0);
  assert.ok(sizes.every((x) => x.observation_id === ob.observation_id));
});
