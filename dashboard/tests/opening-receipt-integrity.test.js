'use strict';
// The opening receipt through failures (core/opening-receipt.js,
// cr.opening-guard.v1). FICTIONAL chain, pools, quoter, desk and prices
// (opening-receipt-fixture.js); temporary workspaces only; no network.
//
// The normal entry points are used: Eric's approval (tickets.decide) and the
// paper mandate's sweep (tickets.mandateSweep), each of which runs the
// trader's step. Where a failure is a process dying, a real second process
// (opening-receipt-child.js) runs the same entry point on the same folder
// and is killed outright at the named point; this process then goes on as
// the next start would.
//
// The rules under test:
// - A reservation that is committed carries its receipt: they are one line.
//   Nothing of a receipt is on disk without its reservation.
// - A retry never changes a reservation or its receipt, and never makes a
//   second one, whatever happened to the first attempt and however many
//   attempts run at once.
// - The receipt describes what the guard evaluated for that order: after a
//   newer observation the retry's receipt names the newer one; when the
//   observation changes between the sizing and the final guard, the sizing
//   quote and the proving observation are named apart.
// - When the book reserves another quantity than the guard proved, it is
//   said at once and reads `mismatch` wherever the receipt is checked.
// - Under enforce, an order whose receipt cannot be made is not asked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const X = require('./opening-receipt-fixture');
const { G, T, TD, PT, OR, CF, POOL3, PAIR, RISK_SIZED, AT_500 } = X;

const receiptBytes = (s) => { try { return fs.readFileSync(path.join(s.root, ...PT.JOURNAL.split('/')), 'utf8').includes(OR.KEY); } catch (_) { return false; } };
const orderOf = (s, did) => { const row = X.rowOf(s, did); return { phase: row.phase, state: row.order_state || null, words: row.words }; };
// Exactly one reservation for the decision, whole and bound; returns it.
function oneBound(s, did) {
  const lines = X.reservedFor(s, did);
  assert.equal(lines.length, 1, `one reservation (${orderOf(s, did).words})`);
  const rec = X.wellFormed(lines[0]);
  const c = X.check(s, lines[0]);
  assert.equal(c.status, 'bound', `${c.words} ${JSON.stringify(c.differences)}`);
  return { line: lines[0], rec, check: c };
}
// Killed, not exited: no result line, and never a clean exit.
function killed(r, what) {
  assert.notEqual(r.status, 0, `${what}: the process did not end cleanly (${r.stderr.slice(0, 300)})`);
  assert.equal(/^CHILD /m.test(r.stdout), false, `${what}: it was stopped before it could answer`);
}
const answered = (r) => { const m = /^CHILD (.+)$/m.exec(r.stdout); assert.ok(m, `the child answered (${r.stderr.slice(0, 400)})`); return JSON.parse(m[1]); };
// Eric's approval with the book failing before it writes anything (the request stays ready to be asked).
function approveWithBookDown(t, s, receipt) {
  const real = PT.submitIntent;
  PT.submitIntent = () => { throw Object.assign(new Error('FICTIONAL: the book is not reachable'), { code: 'EIO' }); };
  t.after(() => { PT.submitIntent = real; });
  const d = X.approve(s, receipt);
  PT.submitIntent = real;
  assert.equal(X.reservedFor(s, d.decision_id).length, 0);
  assert.equal(X.rowOf(s, d.decision_id).phase, 'ready');
  return d;
}

test('IT1: the process dies as the book is asked (before the reservation): nothing of a receipt is on disk; the next start reserves once, with its receipt', async (t) => {
  const s = X.desk(t);
  const { receipt } = await X.ready(s);
  const r = X.childSync(s, 'approve', 'before_reserve', { project_id: s.pid, receipt_id: receipt.receipt_id, request_id: X.REQUEST });
  killed(r, 'before the reservation');
  const d = T.readDecisions(s.ws, s.pid).find((x) => x.receipt_id === receipt.receipt_id && x.action === 'approve');
  assert.ok(d, 'Eric\'s approval is on record: it was saved before the book was asked');
  assert.equal(X.reservedFor(s, d.decision_id).length, 0, 'no reservation');
  assert.equal(receiptBytes(s), false, 'no receipt without a reservation');
  // The next start, as a new process reads the folder.
  const n = X.reopened(s);
  const st = TD.step(n.ws, {});
  assert.deepEqual(st.problems, []);
  const { rec } = oneBound(n, d.decision_id);
  assert.deepEqual([rec.quantity.risk_sized, rec.quantity.final, rec.quantity.sized_by], [RISK_SIZED, AT_500, 'quote']);
  assert.equal(orderOf(n, d.decision_id).state, 'ACKED');
});

test('IT2: the process dies while the reservation is being put on disk (journal in place, head not): the write completes on the next start as one line with its receipt, never a second', async (t) => {
  const s = X.desk(t);
  const { receipt, ob } = await X.ready(s);
  const r = X.childSync(s, 'approve', 'mid_reserve_commit', { project_id: s.pid, receipt_id: receipt.receipt_id, request_id: X.REQUEST });
  killed(r, 'mid-commit');
  const d = T.readDecisions(s.ws, s.pid).find((x) => x.receipt_id === receipt.receipt_id && x.action === 'approve');
  // As the dead process left it: the journal holds the line; the book's head does not cover it yet.
  const raw = X.reservedFor(s, d.decision_id);
  assert.equal(raw.length, 1, 'the journal file already holds the reservation line');
  const head = JSON.parse(fs.readFileSync(path.join(s.root, ...PT.HEAD.split('/')), 'utf8'));
  assert.ok(head.seq < raw[0].seq, 'the head was not written: the commit is half done');
  assert.equal(X.wellFormed(raw[0]).observation.observation_id, ob.observation_id);
  // The next start completes the interrupted write, then steps.
  const n = X.reopened(s);
  TD.step(n.ws, {});
  TD.step(n.ws, {});
  const { line } = oneBound(n, d.decision_id);
  assert.equal(line.intent_sha256, raw[0].intent_sha256, 'the same reservation, with the receipt it was written with');
  assert.deepEqual(line, raw[0]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.root, ...PT.HEAD.split('/')), 'utf8')).seq >= line.seq, true, 'the head now covers it');
  assert.equal(TD.executionFor(n.ws, d.decision_id).reserved[0].opening_receipt.status, 'bound');
});

test('IT3: the process dies after the reservation is committed and before the order is sent: the line and its receipt are whole at once and stay as written; the order is never sent late', async (t) => {
  const s = X.desk(t);
  const { receipt } = await X.ready(s);
  const r = X.childSync(s, 'approve', 'after_reserve', { project_id: s.pid, receipt_id: receipt.receipt_id, request_id: X.REQUEST });
  killed(r, 'after the reservation');
  const d = T.readDecisions(s.ws, s.pid).find((x) => x.receipt_id === receipt.receipt_id && x.action === 'approve');
  const n = X.reopened(s);
  const first = oneBound(n, d.decision_id);
  assert.equal(orderOf(n, d.decision_id).state, 'RESERVED');
  TD.step(n.ws, {});
  TD.step(n.ws, {});
  const after = oneBound(n, d.decision_id);
  assert.deepEqual(after.line, first.line, 'the reservation and its receipt are unchanged by recovery');
  assert.equal(orderOf(n, d.decision_id).state, 'UNKNOWN', 'reserved with no outcome on record: never sent late, never a second order');
  assert.equal(X.journal(n).filter((e) => e.type === 'reserved').length, 1);
});

test('IT4: a lost acknowledgment (the venue has the order; the process dies before its answer is recorded): reconciled from the venue, the reservation and its receipt untouched', async (t) => {
  const s = X.desk(t);
  const { receipt } = await X.ready(s);
  const r = X.childSync(s, 'approve', 'after_venue', { project_id: s.pid, receipt_id: receipt.receipt_id, request_id: X.REQUEST });
  killed(r, 'after the venue took the order');
  const d = T.readDecisions(s.ws, s.pid).find((x) => x.receipt_id === receipt.receipt_id && x.action === 'approve');
  const n = X.reopened(s);
  const first = oneBound(n, d.decision_id);
  assert.equal(orderOf(n, d.decision_id).state, 'SENT');
  TD.step(n.ws, {});
  TD.step(n.ws, {});
  const after = oneBound(n, d.decision_id);
  assert.deepEqual(after.line, first.line);
  assert.equal(orderOf(n, d.decision_id).state, 'ACKED', 'the venue was asked by the client order ID');
  // The same approval sent again, and a different request for it: nothing new is reserved.
  const again = T.decide(n.ws, n.pid, { receipt_id: receipt.receipt_id, action: 'approve', request_id: X.REQUEST });
  assert.equal(again.result.decision.decision_id, d.decision_id, 'the same request is the same decision');
  let second = null;
  try { second = T.decide(n.ws, n.pid, { receipt_id: receipt.receipt_id, action: 'approve', request_id: 'req_opening_receipt_0002' }); } catch (err) { second = { refused: err.code || String(err.message).slice(0, 80) }; }
  TD.step(n.ws, {});
  assert.equal(X.journal(n).filter((e) => e.type === 'reserved' && e.intent.side === 'OPEN_LONG').length, 1, `a duplicate request reserves nothing more (${JSON.stringify(second.refused || second.result.status)})`);
  assert.deepEqual(oneBound(n, d.decision_id).line, first.line);
});

test('IT5: a retry after a newer observation became current: the receipt names the observation the retry\'s guard evaluated, not the one current at the first attempt', async (t) => {
  const s = X.desk(t);
  const { receipt, ob: atApproval } = await X.ready(s);
  const r = X.childSync(s, 'approve', 'before_reserve', { project_id: s.pid, receipt_id: receipt.receipt_id, request_id: X.REQUEST });
  killed(r, 'before the reservation');
  const d = T.readDecisions(s.ws, s.pid).find((x) => x.receipt_id === receipt.receipt_id && x.action === 'approve');
  // A newer observation lands; this one's pair is deep enough to prove the risk-sized order.
  const newer = await X.observe(s, { pair: X.DEEP });
  assert.notEqual(newer.observation_id, atApproval.observation_id);
  const n = X.reopened(s);
  TD.step(n.ws, {});
  const { rec } = oneBound(n, d.decision_id);
  assert.equal(rec.observation.observation_id, newer.observation_id);
  assert.equal(rec.observation.sha256, newer.sha256);
  assert.deepEqual([rec.quantity.final, rec.quantity.sized_by, rec.exit.pool], [RISK_SIZED, 'risk', PAIR]);
  // The older observation is still on file and is not the one the receipt binds.
  assert.equal(CF.readObservation(n.ws, n.pid, atApproval.observation_id).ok, true);
});

test('IT6: two attempts at once (two processes step the same ready request together): one reservation with its receipt; the other attempt writes nothing', async (t) => {
  const s = X.desk(t);
  const { receipt } = await X.ready(s);
  const d = approveWithBookDown(t, s, receipt);
  const go = path.join(s.root, 'go-FICTIONAL.txt');
  const ready = [path.join(s.root, 'ready-a.txt'), path.join(s.root, 'ready-b.txt')];
  const kids = ready.map((f) => X.childAsync(s, 'step', 'none', { ready_file: f, go_file: go }));
  // Both loaded and waiting at the line, then released together.
  await new Promise((resolve, reject) => { const until = Date.now() + 60000; const poll = setInterval(() => { if (ready.every((f) => fs.existsSync(f))) { clearInterval(poll); resolve(); } else if (Date.now() > until) { clearInterval(poll); reject(new Error('the two processes did not start')); } }, 10); });
  fs.writeFileSync(go, 'go');
  const outs = (await Promise.all(kids)).map(answered);
  for (const f of [...ready, go]) fs.rmSync(f, { force: true });
  const n = X.reopened(s);
  const { line } = oneBound(n, d.decision_id);
  assert.equal(X.journal(n).filter((e) => e.type === 'reserved').length, 1, 'one reservation in the whole book');
  const opened = outs.filter((o) => (o.done || []).some((x) => x.kind === 'open' && x.status === 'saved'));
  assert.equal(opened.length, 1, `exactly one attempt reserved it: ${JSON.stringify(outs).slice(0, 600)}`);
  const other = outs.find((o) => o !== opened[0]);
  assert.ok(!(other.done || []).some((x) => x.kind === 'open' && x.status === 'saved'));
  // Whatever the other attempt saw, it changed nothing: the order already
  // there (no problem at all), or one of the book's own refusals of a second
  // or late attempt: a second body for the same intent (CONFLICT), the book
  // busy with the first, or a clock reading taken just before the first
  // attempt's record was written (TIME: the book never goes back in time).
  console.log(`OPENING IT6 the other attempt ${JSON.stringify((other.problems || []).map((p) => p.code))}`);
  for (const p of other.problems || []) assert.match(`${p.code} ${p.words}`, /CONFLICT|one intent_id is one intent|WORKSPACE_BUSY|busy|^TIME .+the book never goes back in time/i);
  TD.step(n.ws, {});
  assert.deepEqual(oneBound(n, d.decision_id).line, line);
  assert.equal(orderOf(n, d.decision_id).state, 'ACKED');
});

test('IT7: the paper mandate\'s grant, sized down across two pools (the sizing pool cannot prove the exit, the pair does): bound, by the mandate; and after the book fails first, a killed step and a retry', async (t) => {
  const s = X.desk(t, { mandate: true });
  await X.ready(s, { current: (x) => X.observe(x, { pair: X.MID, quoter: 'poor' }) });
  // The sweep's own step finds the book down: the grant is made, nothing is reserved.
  const real = PT.submitIntent;
  PT.submitIntent = () => { throw Object.assign(new Error('FICTIONAL: the book is not reachable'), { code: 'EIO' }); };
  t.after(() => { PT.submitIntent = real; });
  const g = X.mandateGrant(s);
  PT.submitIntent = real;
  assert.equal(g.sweep.granted.length, 1, JSON.stringify(g.sweep).slice(0, 400));
  const d = g.decision;
  assert.match(d.decided_by, /^mandate:/);
  assert.equal(X.reservedFor(s, d.decision_id).length, 0);
  assert.equal(receiptBytes(s), false);
  // The next tick's step, in a process that dies mid-commit; then the tick after it.
  killed(X.childSync(s, 'step', 'mid_reserve_commit', {}), 'the mandate grant\'s step, mid-commit');
  const n = X.reopened(s);
  TD.step(n.ws, {});
  const { rec, check, line } = oneBound(n, d.decision_id);
  assert.deepEqual(check.reservation.grant, { decision_id: d.decision_id, action: 'approve', decided_at: d.decided_at, decided_by: d.decided_by, by_mandate: true });
  assert.deepEqual([rec.quantity.risk_sized, rec.quantity.final, rec.quantity.sized_by], [RISK_SIZED, AT_500, 'quote']);
  assert.equal(rec.size.pool, POOL3, 'the V3 pool\'s $500 quote supplied the quantity');
  assert.equal(rec.exit.pool, PAIR, 'the pair proved the exit');
  // The sizing pool alone does not prove that quantity.
  const o = CF.readObservation(n.ws, n.pid, rec.observation.observation_id).observation;
  assert.equal(G.fittedExit({ ...o, pools: o.pools.filter((p) => p.pool === POOL3) }, { notionalUsd: rec.exit.notional_usd, priceUsd: rec.exit.entry_usd, quantity: rec.quantity.final, networkFeeUsd: '5', limitPct: 5, priceStaleMinutes: 90 }).ok, false);
  // The trader view names who granted it.
  const row = TD.view(n.ws, {}).orders.find((x) => x.client_order_id === line.client_order_id);
  assert.deepEqual([row.opening_receipt.status, row.opening_receipt.granted_by, row.opening_receipt.exit_pool, row.opening_receipt.size.pool], ['bound', 'mandate', PAIR, POOL3]);
});

test('IT8: the paper mandate\'s grant that keeps its risk-sized quantity: the sweep itself reserves it, with its receipt', async (t) => {
  const s = X.desk(t, { mandate: true });
  await X.ready(s, { current: (x) => X.observe(x, { pair: X.DEEP }) });
  const g = X.mandateGrant(s);
  assert.equal(g.sweep.granted.length, 1, JSON.stringify(g.sweep).slice(0, 400));
  const { rec, check } = oneBound(s, g.decision.decision_id);
  assert.deepEqual([rec.quantity.risk_sized, rec.quantity.final, rec.quantity.sized_by, rec.size], [RISK_SIZED, RISK_SIZED, 'risk', null]);
  assert.equal(check.reservation.grant.by_mandate, true);
});

test('IT9: the observation changes between the sizing and the final guard: the receipt names the observation the guard evaluated, and the sizing quote\'s own observation apart; when the newer one cannot prove the quantity, nothing is reserved', async (t) => {
  // The sizing step reads observation A; before the final guard, B becomes current.
  const sizesFrom = (a) => () => G.quotedQuantities(a).filter((x) => x.base % G.lotStep(TD.LOT, a.token.decimals) === 0n).sort((x, y) => (x.base < y.base ? 1 : x.base > y.base ? -1 : 0))
    .map((x) => ({ quantity: G.tokensText(x.base, a.token.decimals), base: x.base.toString(), pool: x.pool, reference_usd: x.label, recorded: x.recorded, observation_id: a.observation_id }));
  const real = T.contractQuotedSizes;
  t.after(() => { T.contractQuotedSizes = real; });
  {
    const s = X.desk(t);
    let a = null;
    const { receipt, ob: b } = await X.ready(s, { current: async (x) => { a = await X.observe(x, { pair: X.MID, quoter: 'poor' }); return X.observe(x, { pair: X.MID, quoter: 'poor' }); } });
    assert.notEqual(a.observation_id, b.observation_id);
    T.contractQuotedSizes = sizesFrom(a);
    const d = X.approve(s, receipt);
    T.contractQuotedSizes = real;
    const { rec, check } = oneBound(s, d.decision_id);
    assert.equal(rec.observation.observation_id, b.observation_id, 'the guard evaluated the newer observation');
    assert.equal(rec.size.observation_id, a.observation_id, 'the sizing quote came from the earlier one');
    assert.deepEqual([rec.size.pool, rec.exit.pool], [POOL3, PAIR]);
    assert.equal(check.recomputed.pool, PAIR);
  }
  {
    const s = X.desk(t);
    let a = null;
    const { receipt } = await X.ready(s, { current: async (x) => { a = await X.observe(x, { pair: X.MID, quoter: 'poor' }); return X.observe(x, { pair: X.THIN, quoter: 'zero' }); } });
    T.contractQuotedSizes = sizesFrom(a);
    const d = X.approve(s, receipt);
    T.contractQuotedSizes = real;
    assert.equal(X.reservedFor(s, d.decision_id).length, 0, 'the newer observation proves no exit at that quantity');
    const row = X.rowOf(s, d.decision_id);
    assert.deepEqual([row.phase, row.contract.rule_id], ['waiting', 'CG-14']);
    assert.equal(receiptBytes(s), false);
  }
});

test('IT10: the book reserves another quantity than the guard proved: said at once, read as mismatch everywhere, and nothing is cancelled or rewritten', async (t) => {
  const s = X.desk(t);
  const { receipt } = await X.ready(s);
  const d = approveWithBookDown(t, s, receipt);
  // The book sizes with a coarser lot than the one the guard's quantity was fitted to.
  const real = PT.submitIntent;
  PT.submitIntent = (ws, intent, ctx) => real(ws, intent, { ...ctx, venue: { ...ctx.venue, lot: '1' } });
  t.after(() => { PT.submitIntent = real; });
  const st = TD.step(s.ws, {});
  PT.submitIntent = real;
  const lines = X.reservedFor(s, d.decision_id);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].quantity, '71', 'the book reserved whole tokens');
  const said = st.problems.find((p) => p.code === 'RECEIPT_MISMATCH');
  assert.ok(said, JSON.stringify(st.problems));
  assert.match(said.words, /The book reserved 71; this order's opening receipt is for 71\.022727\./);
  assert.deepEqual([said.decision_id, said.kind], [d.decision_id, 'open']);
  const c = X.check(s, lines[0]);
  assert.equal(c.status, 'mismatch');
  assert.deepEqual(c.differences.map((x) => x.field), ['quantity.final']);
  assert.match(c.words, /The receipt is for 71\.022727; the book reserved 71\./);
  assert.equal(TD.executionFor(s.ws, d.decision_id).reserved[0].opening_receipt.status, 'mismatch');
  const row = TD.view(s.ws, {}).orders.find((x) => x.client_order_id === lines[0].client_order_id);
  assert.deepEqual([row.opening_receipt.status, row.opening_receipt.differences, row.opening_receipt.reserved_quantity, row.opening_receipt.quantity.final], ['mismatch', ['quantity.final'], '71', AT_500]);
  // The guard does not prove 71 either: no saved quote was asked for exactly that many.
  const o = CF.readObservation(s.ws, s.pid, c.record.observation.observation_id).observation;
  assert.equal(G.fittedExit(o, { notionalUsd: '489.9', priceUsd: '6.9', quantity: '71', networkFeeUsd: '5', limitPct: 5, priceStaleMinutes: 90 }).ok, false);
  // Later steps leave the reservation as the book wrote it.
  TD.step(s.ws, {});
  assert.deepEqual(X.reservedFor(s, d.decision_id), lines);
  assert.equal(orderOf(s, d.decision_id).state, 'ACKED');
});

test('IT11: the receipt cannot be made: under enforce the order is not asked and waits in words, then opens once it can; with the gate observed only, the order is never held back over it', async (t) => {
  // What cannot be made into a whole record, each said in words.
  const whole = { version: OR.VERSION, gate_mode: 'enforce', checked_at: '2026-11-10T12:00:00.000Z', result: 'pass', rule_id: 'CG-14', gate: { version: G.GATE_VERSION, exit: G.EXIT_VERSION }, observation: { observation_id: 'co_0123456789abcdef', sha256: 'a'.repeat(64), chain_id: '8453', block_number: 7, block_hash: '0xabc', block_time: '2026-11-10T11:50:00.000Z' }, exit: { pool: POOL3, cost_pct: '1.65', value_usd: '500', value_basis: 'observation', notional_usd: '490.0568163', entry_usd: '6.9' }, limits: { exit_cost_pct: 5, network_fee_usd: '5', price_stale_minutes: 90 }, price_check: { state: 'ok', limit_minutes: 90, gap_ms: 1000, as_of: '2026-11-10T11:50:01.000Z' }, evaluated: { quantity: AT_500, token_decimals: 18 } };
  const snapped = { pool: POOL3, reference_usd: '500', quote_input: 'recorded', observation_id: 'co_0123456789abcdef' };
  assert.deepEqual(OR.problemsOf(OR.build(whole, { riskSized: RISK_SIZED, final: AT_500, snapped })), []);
  for (const [name, guard, opts, why] of [
    ['no reading', null, { riskSized: RISK_SIZED, final: AT_500 }, /gave no reading/],
    ['the guard read another quantity', whole, { riskSized: RISK_SIZED, final: '71' }, /the guard read 71\.022727, not the 71 the order asks for/],
    ['an observation with no SHA-256', { ...whole, observation: { ...whole.observation, sha256: null } }, { riskSized: RISK_SIZED, final: AT_500, snapped }, /does not name the observation by ID, SHA-256, chain and pinned block/],
    ['no pinned block', { ...whole, observation: { ...whole.observation, block_number: null } }, { riskSized: RISK_SIZED, final: AT_500, snapped }, /pinned block/],
    ['a quantity that is no whole number of base units', { ...whole, evaluated: { quantity: '0.5', token_decimals: 0 } }, { riskSized: '0.5', final: '0.5' }, /not a whole number of the token's base units/],
    ['no network fee', { ...whole, limits: { ...whole.limits, network_fee_usd: null } }, { riskSized: RISK_SIZED, final: AT_500, snapped }, /the network fee/],
    ['no freshness setting', { ...whole, limits: { ...whole.limits, price_stale_minutes: undefined } }, { riskSized: RISK_SIZED, final: AT_500, snapped }, /price freshness limit/],
    ['a sizing quote with no observation', whole, { riskSized: RISK_SIZED, final: AT_500, snapped: { ...snapped, observation_id: undefined } }, /observation of the quote that set the size/],
    ['no pool', { ...whole, exit: { ...whole.exit, pool: null } }, { riskSized: RISK_SIZED, final: AT_500, snapped }, /pool that proved the exit/],
    ['a rounded-away cost', { ...whole, exit: { ...whole.exit, cost_pct: null } }, { riskSized: RISK_SIZED, final: AT_500, snapped }, /unrounded cost/],
  ]) assert.throws(() => OR.build(guard, opts), why, name);

  const realBuild = OR.build;
  t.after(() => { OR.build = realBuild; });
  // Under enforce.
  {
    const s = X.desk(t);
    const { receipt } = await X.ready(s);
    OR.build = () => { throw new Error('FICTIONAL: the observation carries no SHA-256'); };
    const d = X.approve(s, receipt);
    const row = X.rowOf(s, d.decision_id);
    assert.deepEqual([row.phase, row.contract.rule_id], ['waiting', 'OPENING_RECEIPT']);
    assert.match(row.words, /opening receipt could not be made \(FICTIONAL: the observation carries no SHA-256\), and no order is asked without it while the contract gate is enforced; the order waits\./);
    assert.equal(X.journal(s).filter((e) => e.type === 'reserved' || e.type === 'refused').length, 0, 'the book was not asked: its one attempt is kept');
    TD.step(s.ws, {});
    assert.equal(X.reservedFor(s, d.decision_id).length, 0);
    OR.build = realBuild;
    TD.step(s.ws, {});
    oneBound(s, d.decision_id);
  }
  // Observed only: an order is never held back over its paperwork; it is asked without a receipt, and reads `missing`.
  {
    const s = X.desk(t);
    const { receipt } = await X.ready(s, { mode: 'observe' });
    OR.build = () => { throw new Error('FICTIONAL: no record'); };
    const d = X.approve(s, receipt);
    OR.build = realBuild;
    const lines = X.reservedFor(s, d.decision_id);
    assert.equal(lines.length, 1, X.rowOf(s, d.decision_id).words);
    assert.equal(OR.readFrom(lines[0].intent), null);
    assert.equal(X.check(s, lines[0]).status, 'missing');
  }
});
