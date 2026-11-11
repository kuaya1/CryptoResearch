'use strict';
// Checking an opening receipt (core/opening-receipt.js verify), and where
// that check is read: the decision's execution (CLI `tickets basis`), the
// signed-in trader view (GET /api/paper/trader) and the B1 operating proof's
// lineage gate (core/autonomy-proof.js), which reads that view as captured.
// FICTIONAL chain, pools, quoter, desk and prices (opening-receipt-fixture.js);
// temporary workspaces only; a local server on 127.0.0.1; no other network.
//
// The rules under test:
// - Each thing the receipt binds is checked on its own: change the quantity,
//   the observation, the proving pool, the cost, a limit or setting, the
//   rule's version or the sizing quote, one at a time, and the check names it.
// - An order with no receipt (one made before the receipt existed) reads
//   `missing`, said as such; everything else about it reads as before.
// - The book's own journal integrity is unchanged: a receipt edited on disk
//   is refused by the book before any receipt is read.
// - The B1 lineage gate passes only on a receipt that is bound, for this
//   order, under enforce, with a pass.
// - Eric's approval through the signed-in route ends in a reservation that
//   carries its receipt; unsigned it is refused; asked twice it is one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const X = require('./opening-receipt-fixture');
const { G, T, TD, PT, OR, CF, POOL3, PAIR, RISK_SIZED, AT_500 } = X;
const A = require('../core/autonomy-proof');

const clone = (v) => JSON.parse(JSON.stringify(v));
// The same reservation line with its receipt changed by `edit` (the line's other fields untouched).
function withReceipt(line, edit) {
  const out = clone(line);
  const list = out.intent.evidence.metrics_evaluated;
  const i = list.findIndex((m) => m.startsWith(`${OR.KEY}=`));
  const rec = JSON.parse(list[i].slice(OR.KEY.length + 1));
  const next = edit(rec) || rec;
  list[i] = OR.textOf(next);
  return out;
}
// A sized-down order across two pools, bound: the line every negative case starts from.
async function mixed(t, opts = {}) {
  const s = X.desk(t, opts);
  let first = null;
  const { receipt, ob } = await X.ready(s, { current: async (x) => { first = await X.observe(x); return X.observe(x, { pair: X.MID, quoter: 'poor' }); } });
  const d = X.approve(s, receipt);
  const lines = X.reservedFor(s, d.decision_id);
  assert.equal(lines.length, 1, X.rowOf(s, d.decision_id).words);
  assert.equal(X.check(s, lines[0]).status, 'bound');
  return { s, receipt, ob, first, d, line: lines[0], rec: OR.readFrom(lines[0].intent) };
}

test('OV1: each thing the receipt binds, changed on its own, is named by the check', async (t) => {
  const { s, line, rec, first } = await mixed(t);
  assert.deepEqual([rec.size.pool, rec.exit.pool, rec.quantity.final, rec.quantity.risk_sized], [POOL3, PAIR, AT_500, RISK_SIZED]);
  // name, the change, the status, a field the check must name
  const CASES = [
    ['the final quantity', (r) => { r.quantity.final = '71.022726'; }, 'mismatch', 'quantity.final'],
    ['the final quantity\'s base units', (r) => { r.quantity.final_base_units = '71022727000000000001'; }, 'mismatch', 'quantity.final_base_units'],
    ['the risk-sized quantity, below the final one', (r) => { r.quantity.risk_sized = '70'; }, 'mismatch', 'quantity.risk_sized'],
    ['how it was sized', (r) => { r.quantity.sized_by = 'risk'; r.size = null; }, 'mismatch', 'quantity.sized_by'],
    ['the token\'s decimals', (r) => { r.quantity.decimals = 6; r.quantity.final_base_units = '71022727'; }, 'mismatch', 'quantity.decimals'],
    ['the observation, to another one on file', (r) => { r.observation.observation_id = first.observation_id; }, 'mismatch', 'observation.sha256'],
    ['the observation\'s SHA-256', (r) => { r.observation.sha256 = 'f'.repeat(64); }, 'mismatch', 'observation.sha256'],
    ['the pinned block number', (r) => { r.observation.block_number += 1; }, 'mismatch', 'observation.block'],
    ['the pinned block hash', (r) => { r.observation.block_hash = `0x${'9'.repeat(64)}`; }, 'mismatch', 'observation.block'],
    ['the chain', (r) => { r.observation.chain_id = '1'; }, 'mismatch', 'observation.chain_id'],
    ['an observation that is not on file', (r) => { r.observation.observation_id = 'co_00000000deadbeef'; }, 'unverifiable', null],
    ['the proving pool, to the sizing pool', (r) => { r.exit.pool = POOL3; }, 'mismatch', 'exit.pool'],
    ['the exit cost', (r) => { r.exit.cost_pct = '2.5'; }, 'mismatch', 'exit.cost_pct'],
    ['the exit cost, by its last digit', (r) => { r.exit.cost_pct = `${r.exit.cost_pct.slice(0, -1)}${r.exit.cost_pct.endsWith('1') ? '2' : '1'}`; }, 'mismatch', 'exit.cost_pct'],
    ['the value the sale was measured against', (r) => { r.exit.value_usd = '499'; }, 'mismatch', 'exit.value'],
    ['the value basis', (r) => { r.exit.value_basis = 'entry'; }, 'mismatch', 'exit.value'],
    ['the notional', (r) => { r.exit.notional_usd = '480'; }, 'mismatch', 'exit.notional_usd'],
    ['the entry price', (r) => { r.exit.entry_usd = '6.8'; }, 'mismatch', 'exit.entry_usd'],
    ['a quote-asset value the guard never used', (r) => { r.exit.quote_usd = '1'; r.exit.quote_basis = 'stored'; }, 'mismatch', 'exit.quote'],
    ['the exit-cost limit (a setting frozen on the ticket)', (r) => { r.limits.exit_cost_pct = 6; }, 'mismatch', 'limits.exit_cost_pct'],
    ['the network fee (a setting)', (r) => { r.limits.network_fee_usd = '0'; }, 'mismatch', 'exit.cost_pct'],
    ['the price freshness limit (a setting), to one the stored price fails', (r) => { r.limits.price_stale_minutes = 1; }, 'mismatch', 'result'],
    ['the price freshness limit (a setting), to another that still passes', (r) => { r.limits.price_stale_minutes = 60; }, 'mismatch', 'price_check.limit_minutes'],
    ['the stored price\'s gap', (r) => { r.price_check.gap_ms += 1; }, 'mismatch', 'price_check.gap_ms'],
    ['the stored price\'s time', (r) => { r.price_check.as_of = '2026-11-10T12:00:00.000Z'; }, 'mismatch', 'price_check.as_of'],
    ['the valuation version', (r) => { r.gate.exit = 'cr-contract-exit@1'; }, 'unverifiable', null],
    ['the gate version', (r) => { r.gate.version = 'cr-contract-gate@0'; }, 'unverifiable', null],
    ['the sizing pool', (r) => { r.size.pool = PAIR; }, 'mismatch', 'size'],
    ['the sizing rung', (r) => { r.size.reference_usd = '2000'; }, 'mismatch', 'size.quantity'],
    ['the sizing quote\'s input', (r) => { r.size.quote_input = 'rebuilt'; }, 'mismatch', 'size.quote_input'],
    ['the sizing quote\'s observation, to one that is not on file', (r) => { r.size.observation_id = 'co_00000000deadbeef'; }, 'mismatch', 'size.observation_id'],
    ['when it was read', (r) => { r.checked_at = '2026-11-10T12:00:00.000Z'; }, 'mismatch', 'checked_at'],
    ['the gate mode on a pass', (r) => { r.gate_mode = 'observe'; }, 'unreadable', null],
    ['the result', (r) => { r.result = 'hold'; }, 'unreadable', null],
    ['the rule', (r) => { r.rule_id = 'CG-10'; }, 'unreadable', null],
  ];
  const seen = [];
  for (const [name, edit, status, field] of CASES) {
    const c = X.check(s, withReceipt(line, edit));
    seen.push(`${name}: ${c.status}${c.differences.length ? ` [${c.differences.map((x) => x.field).join(', ')}]` : ''}`);
    assert.equal(c.status, status, `${name}: ${c.words}`);
    if (field) assert.ok(c.differences.some((x) => x.field === field), `${name}: names ${field} (${c.differences.map((x) => x.field).join(', ')})`);
    assert.ok(c.words && c.words.length > 20, name);
    assert.notEqual(c.status, 'bound', name);
  }
  console.log(`OPENING OV1 ${JSON.stringify(seen)}`);
  // The reservation side, changed on its own: the book's quantity, the order's limit, the grant, the ticket.
  for (const [name, change, field] of [
    ['the reserved quantity', (l) => { l.quantity = '71'; }, 'quantity.final'],
    ['the order\'s limit price', (l) => { l.intent.entry_price = '6.8'; }, 'exit.entry_usd'],
    ['the time the intent was written', (l) => { l.intent.created_at = '2026-11-10T12:00:00.000Z'; }, 'checked_at'],
    ['the decision the order names, to one not on record', (l) => { l.intent.decision_id = 'td_not_on_record'; }, 'grant'],
    ['the grant the book read', (l) => { l.grant.decision_id = 'td_other'; }, 'grant'],
    ['the ticket the order acts on', (l) => { l.intent.receipt_id = 'tr_not_on_record'; }, 'grant'],
    ['the project', (l) => { l.intent.project_id = 'another-project'; }, 'observation.project'],
  ]) {
    const l = clone(line);
    change(l);
    let c;
    try { c = X.check(s, l); } catch (err) { c = { status: 'threw', words: err.message, differences: [] }; }
    assert.ok(['mismatch', 'unverifiable'].includes(c.status), `${name}: ${c.status} ${c.words}`);
    if (c.status === 'mismatch') assert.ok(c.differences.some((x) => x.field === field || name === 'the project'), `${name}: names ${field} (${c.differences.map((x) => x.field).join(', ')})`);
  }
  // The records the check reads, each missing or another's on its own: exactly that is named.
  const readers = {
    readObservation: (pid, id) => CF.readObservation(s.ws, pid, id),
    ticketReceipt: (pid, rid) => JSON.parse(fs.readFileSync(s.ws.abs(`projects/${pid}/tickets/receipts/${rid}.json`), 'utf8')),
    decisionOf: (pid, did) => T.readDecisions(s.ws, pid).find((x) => x.decision_id === did) || null,
  };
  assert.equal(OR.verify(line, readers).status, 'bound');
  for (const [name, over, field] of [
    ['the decision is not on the project\'s record', { decisionOf: () => null }, 'grant'],
    ['the ticket receipt does not read', { ticketReceipt: () => null }, 'limits.exit_cost_pct'],
    ['the ticket receipt carries no frozen limit', { ticketReceipt: (p, r) => { const x = readers.ticketReceipt(p, r); delete x.desk.sizing.max_exit_cost_pct; return x; } }, 'limits.exit_cost_pct'],
    ['the observation on file under that ID is another project\'s', { readObservation: (p, id) => { const b = readers.readObservation(p, id); return { ...b, observation: { ...b.observation, subject: { ...b.observation.subject, project_id: 'another-project' } } }; } }, 'observation.project'],
  ]) {
    const c = OR.verify(line, { ...readers, ...over });
    assert.equal(c.status, 'mismatch', `${name}: ${c.words}`);
    assert.deepEqual(c.differences.map((x) => x.field), [field], name);
  }
  // Two receipts, and one that is not canonical: unreadable, never half-read.
  const two = clone(line);
  two.intent.evidence.metrics_evaluated.push(two.intent.evidence.metrics_evaluated[two.intent.evidence.metrics_evaluated.length - 1]);
  assert.equal(X.check(s, two).status, 'unreadable');
  const spaced = clone(line);
  spaced.intent.evidence.metrics_evaluated[spaced.intent.evidence.metrics_evaluated.length - 1] = `${OR.KEY}=${JSON.stringify(rec, null, 1)}`;
  assert.equal(X.check(s, spaced).status, 'unreadable');
  // A close is not an opening.
  assert.equal(X.check(s, { ...clone(line), intent: { ...clone(line.intent), side: 'CLOSE_LONG' } }).status, 'not_an_opening');
  // The line as written still checks out after all of that: nothing above touched the desk.
  assert.equal(X.check(s, line).status, 'bound');
});

test('OV2: the observation the receipt names is altered or removed on disk: mismatch, or unverifiable, never bound', async (t) => {
  const { s, line, rec } = await mixed(t);
  const file = s.ws.abs(CF.obsPath(s.pid, rec.observation.observation_id));
  const original = fs.readFileSync(file, 'utf8');
  // Altered without resealing: it no longer matches its own SHA-256.
  const o = JSON.parse(original);
  o.pools.find((p) => p.pool === PAIR).reserves.quote = '1';
  fs.writeFileSync(file, JSON.stringify(o, null, 2));
  const altered = X.check(s, line);
  assert.equal(altered.status, 'mismatch', altered.words);
  assert.match(altered.words, /does not match its SHA-256/);
  // Altered and sealed again (a different record under the same ID): another SHA-256 than the receipt names.
  const { sha256: _old, ...rest } = o;
  rest.sha256 = X.sha256(G.canonicalJson(rest));
  fs.writeFileSync(file, JSON.stringify(rest, null, 2));
  const resealed = X.check(s, line);
  assert.equal(resealed.status, 'mismatch', resealed.words);
  assert.ok(resealed.differences.some((d) => d.field === 'observation.sha256'));
  // Gone.
  fs.rmSync(file);
  const gone = X.check(s, line);
  assert.equal(gone.status, 'unverifiable', gone.words);
  assert.match(gone.words, /is not readable now/);
  // Put back as it was: bound again.
  fs.writeFileSync(file, original);
  assert.equal(X.check(s, line).status, 'bound');
});

test('OV3: a receipt edited in the journal on disk is the book\'s own integrity refusal, before any receipt is read', async (t) => {
  const { s, line, d } = await mixed(t);
  const file = path.join(s.root, ...PT.JOURNAL.split('/'));
  const text = fs.readFileSync(file, 'utf8');
  const edited = withReceipt(line, (r) => { r.exit.pool = POOL3; });
  assert.notEqual(JSON.stringify(edited), JSON.stringify(line));
  fs.writeFileSync(file, text.replace(JSON.stringify(line), JSON.stringify(edited)));
  assert.notEqual(fs.readFileSync(file, 'utf8'), text, 'the line on disk was changed');
  assert.throws(() => TD.executionFor(s.ws, d.decision_id), (e) => e.code === 'INTEGRITY');
  assert.throws(() => TD.view(s.ws, {}), (e) => e.code === 'INTEGRITY');
  fs.writeFileSync(file, text);
  assert.equal(TD.executionFor(s.ws, d.decision_id).reserved[0].opening_receipt.status, 'bound');
});

test('OV4: an order with no receipt (as every order made before the receipt existed): explicitly `missing`, and every other read of it is as before', async (t) => {
  const s = X.desk(t);
  const { receipt } = await X.ready(s);
  // The order as the code before this change asked for it: the same intent, with no receipt item.
  const realAttach = OR.attach;
  OR.attach = (intent) => intent;
  t.after(() => { OR.attach = realAttach; });
  const d = X.approve(s, receipt);
  OR.attach = realAttach;
  const lines = X.reservedFor(s, d.decision_id);
  assert.equal(lines.length, 1, X.rowOf(s, d.decision_id).words);
  assert.deepEqual(lines[0].intent.evidence.metrics_evaluated, ['entry_zone.low_usd', 'upside_target.price_usd', 'invalidation_trigger.price_usd', 'invalidation_trigger.metric.fees'], 'exactly the intent the earlier code wrote');
  assert.deepEqual(X.validate(X.SCHEMA, lines[0].intent).errors, []);
  const c = X.check(s, lines[0]);
  assert.equal(c.status, 'missing');
  assert.match(c.words, /carries no opening receipt: it was reserved before cr\.opening-guard\.v1 existed, or by code that does not write one\. Nothing is inferred for it\./);
  assert.equal(c.record, null);
  assert.deepEqual([c.reservation.decision_id, c.reservation.quantity, c.reservation.grant.by_mandate], [d.decision_id, lines[0].quantity, false]);
  // The new readers on the old order.
  const ex = TD.executionFor(s.ws, d.decision_id);
  assert.deepEqual([ex.state, ex.reserved.length, ex.reserved[0].contract_guard, ex.reserved[0].opening_receipt.status, ex.reserved[0].quantity], ['recorded', 1, null, 'missing', lines[0].quantity]);
  const view = TD.view(s.ws, {});
  const row = view.orders.find((o) => o.client_order_id === lines[0].client_order_id);
  assert.deepEqual([row.state, row.side, row.decision_id, row.opening_receipt.status, row.opening_receipt.reserved_quantity], ['ACKED', 'OPEN_LONG', d.decision_id, 'missing', lines[0].quantity]);
  assert.deepEqual(Object.keys(row.opening_receipt).includes('result'), false, 'nothing is inferred');
  assert.equal(view.requests.find((r) => r.decision_id === d.decision_id).phase, 'order');
  // A later step leaves it alone: no receipt is ever added to an order after the fact.
  TD.step(s.ws, {});
  assert.deepEqual(X.reservedFor(s, d.decision_id), lines);
  // B1's lineage gate fails on it: an enforced opening must carry its receipt.
  const lineage = { project_id: s.pid, run_id: 'r', report_id: 'p', receipt_id: receipt.receipt_id, generation: 1, decision_id: d.decision_id, intent_id: lines[0].intent_id, client_order_id: lines[0].client_order_id, sent_at: lines[0].at };
  const judged = A.READERS.b1.lineage.judge({ 'lineage.json': lineage, 'trader-after-ack.json': clone(view) }, { project: null });
  assert.equal(judged.result, 'FAIL');
  assert.match(judged.words, /opening receipt reads missing/);
});

function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(c).toString() || 'null') }); } catch (err) { reject(err); } });
    });
    req.on('error', reject);
    req.end();
  });
}

test('OV5: reading the receipt: the signed-in trader view (GET /api/paper/trader), the decision\'s execution (tickets basis), and B1\'s lineage gate on that view as captured', async (t) => {
  const { s, d, line, rec, receipt } = await mixed(t);
  // The CLI's read of the decision (cr-decision-view@1), from disk as a new process reads it.
  const basis = await require('../cli').run(['tickets', 'basis', s.pid, d.decision_id, '--workspace', s.root]);
  const shown = basis.execution.reserved[0];
  assert.deepEqual(shown.contract_guard, rec, 'the receipt as recorded');
  assert.deepEqual([shown.opening_receipt.status, shown.opening_receipt.version, shown.quantity, shown.intent_sha256], ['bound', 'cr-opening-guard-check@1', AT_500, line.intent_sha256]);
  assert.match(shown.opening_receipt.words, /sized down from 289\.855072 to the \$500 quote of .+; the exit proven in .+ within 5%, on observation co_[0-9a-f]{16} at block \d+; made again from that observation, every figure agrees\./);
  // The signed-in route.
  const { start } = require('../server');
  const srv = await start(X.reopened(s).ws, { port: 48300 + Math.floor(Math.random() * 300), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } });
  assert.equal((await get(srv.port, '/api/paper/trader')).status, 401, 'unsigned: refused');
  assert.equal((await get(srv.port, '/api/paper/trader', { 'x-cr-token': 'FICTIONAL-wrong' })).status, 401);
  const r = await get(srv.port, '/api/paper/trader', { 'x-cr-token': srv.token });
  assert.equal(r.status, 200);
  const row = r.json.orders.find((o) => o.client_order_id === line.client_order_id);
  assert.deepEqual(row.opening_receipt, {
    version: 'cr-opening-guard-check@1', status: 'bound', words: shown.opening_receipt.words, differences: [],
    decision_id: d.decision_id, granted_by: 'owner', intent_id: line.intent_id, intent_sha256: line.intent_sha256, reserved_quantity: AT_500,
    result: 'pass', gate_mode: 'enforce', quantity: rec.quantity, size: rec.size,
    observation_id: rec.observation.observation_id, observation_sha256: rec.observation.sha256, chain_id: '8453', block_number: rec.observation.block_number,
    exit_pool: PAIR, cost_pct: rec.exit.cost_pct, limit_pct: 5, valuation: G.EXIT_VERSION,
  });
  assert.deepEqual([row.state, row.quantity, row.side], ['ACKED', AT_500, 'OPEN_LONG']);
  // B1's lineage gate, on that answer exactly as the desk gave it.
  const lineage = { project_id: s.pid, run_id: 'run_fict', report_id: 'rep_fict', receipt_id: receipt.receipt_id, generation: 1, decision_id: d.decision_id, intent_id: line.intent_id, client_order_id: line.client_order_id, sent_at: line.at };
  const judge = (view, l = lineage) => A.READERS.b1.lineage.judge({ 'lineage.json': l, 'trader-after-ack.json': view }, { project: null });
  const ok = judge(clone(r.json));
  assert.equal(ok.result, 'PASS', ok.words);
  assert.match(ok.words, /The opening receipt is bound to the reservation/);
  // The same capture with the receipt's reading changed one way at a time.
  for (const [name, change, want] of [
    ['a mismatch', (o) => { o.opening_receipt.status = 'mismatch'; }, 'FAIL'],
    ['another order\'s quantity', (o) => { o.opening_receipt.reserved_quantity = '71'; }, 'FAIL'],
    ['an unchecked gate', (o) => { o.opening_receipt.gate_mode = 'observe'; }, 'FAIL'],
    ['no reading', (o) => { delete o.opening_receipt; }, 'UNVERIFIED'],
    ['a reading that could not be made', (o) => { o.opening_receipt.status = 'unverifiable'; }, 'UNVERIFIED'],
  ]) {
    const v = clone(r.json);
    change(v.orders.find((o) => o.client_order_id === line.client_order_id));
    assert.equal(judge(v).result, want, name);
  }
  assert.equal(judge(clone(r.json), { ...lineage, decision_id: 'td_other' }).result, 'FAIL');
});

test('OV6: the gate observed only: the trader view and B1\'s gate read not_checked, never a pass', async (t) => {
  const s = X.desk(t);
  const { receipt } = await X.ready(s, { mode: 'observe' });
  const d = X.approve(s, receipt);
  const line = X.reservedFor(s, d.decision_id)[0];
  const view = TD.view(s.ws, {});
  const row = view.orders.find((o) => o.client_order_id === line.client_order_id);
  assert.deepEqual([row.opening_receipt.status, row.opening_receipt.result, row.opening_receipt.gate_mode, row.opening_receipt.why], ['not_checked', 'not_checked', 'observe', 'gate_not_enforced']);
  const lineage = { project_id: s.pid, run_id: 'r', report_id: 'p', receipt_id: receipt.receipt_id, generation: 1, decision_id: d.decision_id, intent_id: line.intent_id, client_order_id: line.client_order_id, sent_at: line.at };
  const judged = A.READERS.b1.lineage.judge({ 'lineage.json': lineage, 'trader-after-ack.json': clone(view) }, { project: null });
  assert.equal(judged.result, 'FAIL');
  assert.match(judged.words, /opening receipt reads not_checked/);
  // A "guard did not run" receipt is still held to its own reservation: for another quantity it is a mismatch, not merely unchecked.
  assert.equal(X.check(s, line).status, 'not_checked');
  const other = X.check(s, withReceipt(line, (r) => { r.quantity.final = '1'; r.quantity.risk_sized = '1'; }));
  assert.equal(other.status, 'mismatch', other.words);
  assert.deepEqual(other.differences.map((x) => x.field), ['quantity.final']);
  const moved = X.check(s, withReceipt(line, (r) => { r.checked_at = '2026-11-10T12:00:00.000Z'; }));
  assert.deepEqual([moved.status, moved.differences.map((x) => x.field)], ['mismatch', ['checked_at']]);
});

test('OV8: the ticket\'s frozen packet is altered on disk: the desk\'s check no longer takes the limit from that ticket, and the receipt is not bound', async (t) => {
  const { s, line, receipt } = await mixed(t);
  assert.equal(T.openingReceipt.check(s.ws, line).status, 'bound');
  // The desk reads the ticket's frozen exit-cost limit only from a receipt that still checks out against its frozen packet.
  const tr = JSON.parse(fs.readFileSync(s.ws.abs(`projects/${s.pid}/tickets/receipts/${receipt.receipt_id}.json`), 'utf8'));
  assert.equal(tr.desk.sizing.max_exit_cost_pct, 5, 'the limit the receipt was read under is the ticket\'s own');
  const packet = s.ws.abs(tr.packet.path);
  const bytes = fs.readFileSync(packet);
  try { fs.chmodSync(packet, 0o666); } catch (_) { /* already writable */ }
  fs.writeFileSync(packet, Buffer.concat([bytes, Buffer.from(' ')]));
  let c;
  try { c = T.openingReceipt.check(s.ws, line); } finally { fs.writeFileSync(packet, bytes); }
  assert.equal(c.status, 'mismatch', c.words);
  assert.deepEqual(c.differences.map((x) => x.field), ['limits.exit_cost_pct']);
  assert.match(c.words, /The ticket receipt this order acts on, or its frozen exit-cost limit, does not read\./);
  // The line checks out again once the packet is as it was.
  assert.equal(T.openingReceipt.check(s.ws, line).status, 'bound');
});

// A signed-in write to the local server: same-origin, JSON, with the desk's token (or without).
function post(port, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers } }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(c).toString() || 'null') }); } catch (err) { reject(err); } });
    });
    req.on('error', reject);
    req.end(text);
  });
}

test('OV7: Eric\'s approval through the signed-in route (POST /api/projects/<id>/tickets/decisions): unsigned it is refused and nothing is granted or reserved; signed, the reservation it leads to carries its receipt, bound; the same request again leaves the reservation and its evidence as written', async (t) => {
  const s = X.desk(t);
  const { receipt } = await X.ready(s, { current: async (x) => { await X.observe(x); return X.observe(x, { pair: X.MID, quoter: 'poor' }); } });
  const { start } = require('../server');
  const srv = await start(X.reopened(s).ws, { port: 48900 + Math.floor(Math.random() * 300), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } });
  const route = `/api/projects/${s.pid}/tickets/decisions`;
  const ask = { receipt_id: receipt.receipt_id, action: 'approve', request_id: 'req_opening_http_0001' };
  const grants = () => T.readDecisions(s.ws, s.pid).filter((d) => d.receipt_id === receipt.receipt_id && d.action === 'approve');
  const openings = () => X.journal(s).filter((e) => e.type === 'reserved' && e.intent && e.intent.side === 'OPEN_LONG');
  // Not signed in, or with a wrong token: refused, and nothing is granted or reserved.
  assert.equal((await post(srv.port, route, ask)).status, 401, 'unsigned: refused');
  assert.equal((await post(srv.port, route, ask, { 'x-cr-token': 'FICTIONAL-wrong' })).status, 401);
  assert.deepEqual([grants().length, openings().length], [0, 0]);
  // Signed in: the approval, and the trader's first step, as the dashboard's button makes them.
  const ok = await post(srv.port, route, ask, { 'x-cr-token': srv.token });
  assert.equal(ok.status, 200, JSON.stringify(ok.json).slice(0, 300));
  assert.equal(grants().length, 1, 'one grant, on the project\'s own record');
  const d = grants()[0];
  assert.equal(d.decided_by, 'dashboard');
  const lines = X.reservedFor(s, d.decision_id);
  assert.equal(lines.length, 1, X.rowOf(s, d.decision_id).words);
  const rec = X.wellFormed(lines[0]);
  assert.deepEqual([rec.quantity.risk_sized, rec.quantity.final, rec.quantity.sized_by, rec.size.pool, rec.exit.pool], [RISK_SIZED, AT_500, 'quote', POOL3, PAIR]);
  const c = X.check(s, lines[0]);
  assert.equal(c.status, 'bound', `${c.words} ${JSON.stringify(c.differences)}`);
  assert.deepEqual([c.reservation.grant.decision_id, c.reservation.grant.by_mandate], [d.decision_id, false]);
  // The same request again (a double click, or a retry after a lost answer): one grant, one reservation, the same bytes.
  const again = await post(srv.port, route, ask, { 'x-cr-token': srv.token });
  assert.equal(again.status, 200, JSON.stringify(again.json).slice(0, 300));
  assert.equal(grants().length, 1);
  assert.deepEqual(openings().map((e) => JSON.stringify(e)), [JSON.stringify(lines[0])], 'the reservation and its receipt are as first written');
  // And the signed-in view shows it bound, for this decision.
  const view = await get(srv.port, '/api/paper/trader', { 'x-cr-token': srv.token });
  const row = view.json.orders.find((o) => o.client_order_id === lines[0].client_order_id);
  assert.deepEqual([row.opening_receipt.status, row.opening_receipt.decision_id, row.opening_receipt.granted_by, row.opening_receipt.reserved_quantity], ['bound', d.decision_id, 'owner', AT_500]);
});
