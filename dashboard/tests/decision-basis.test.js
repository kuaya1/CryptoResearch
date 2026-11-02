'use strict';
// The decision basis (cr.decision-basis.v1; blueprint 2026-11-02 §5.2/§5.3,
// build plan row 8): frozen in the decision's own operation, never rewritten,
// read back as a join that checks every record by its SHA-256 and never
// substitutes a current value. FICTIONAL temporary workspaces only: nothing
// here is a market, a venue or an order.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const T = require('../core/tickets');
const TD = require('../core/trader-desk');
const PT = require('../core/paper-trader');
const DB = require('../core/decision-basis');
const { sha256 } = require('../core/fsx');
const { mandateDesk, saveTicket, mandateArgs } = require('./mandate-fixture');
const { H, iso, PAIR, settle, bar } = require('./trader-fixture');

const bytes = (ws, rel) => fs.readFileSync(ws.abs(rel));

test('§5.3 acceptance: a mandate grant commits with its basis; the trader effect fails; rules and fee change; reconcile, reserve and fill; the basis holds and the execution reads its own time', (t) => {
  const s = mandateDesk(t, { grade: 52 });
  const { ws, pid } = s;
  const r = saveTicket(ws, pid);
  assert.equal(r.desk.suggested_risk_usd, 500);
  // The mandate's own contract recheck before its order: a readable pass.
  const rv = T.contractVerdictNow;
  const rc = T.contractCheckOf;
  T.contractVerdictNow = () => ({ tier: 'pass', words: 'FICTIONAL pass', findings: [] });
  T.contractCheckOf = () => ({ status: 'holding', words: 'unchanged' });
  t.after(() => { T.contractVerdictNow = rv; T.contractCheckOf = rc; });

  // 1–2. The mandate halves; the trader effect fails (stubbed), the decision stands.
  const realStep = TD.step;
  TD.step = () => { throw new Error('FICTIONAL trader outage'); };
  let out;
  try {
    out = T.decide(ws, pid, { receipt_id: r.receipt_id, action: 'halve', request_id: `mandate_${r.receipt_id}`, mandate: mandateArgs('exploratory_50_54', 52) });
  } finally { TD.step = realStep; }
  const d = out.result.decision;
  assert.equal(out.result.status, 'saved');
  assert.equal(d.schema_version, 'cr.ticket-decision.v1', 'the decision line keeps the format the book reads');
  assert.equal(out.result.trader.status, 'failed');
  const rel = DB.basisRel(pid, d.decision_id);
  const frozen = bytes(ws, rel);
  const basis = JSON.parse(frozen.toString('utf8'));
  assert.equal(basis.schema_version, DB.BASIS_VERSION);
  assert.deepEqual([basis.decision_id, basis.receipt_id, basis.decided_at, basis.action], [d.decision_id, r.receipt_id, d.decided_at, 'halve']);
  assert.equal(basis.receipt_sha256, sha256(bytes(ws, `projects/${pid}/tickets/receipts/${r.receipt_id}.json`)));
  assert.equal(basis.packet_sha256, r.packet.sha256);
  assert.equal(basis.text_sha256, r.text.sha256);
  // The report vector: Claude's report the receipt names is the input; the others are context, or say why not.
  assert.deepEqual(basis.research.map((e) => [e.provider, e.use]), [['claude', 'decision_input'], ['chatgpt', 'available_context'], ['gemini', 'available_context']]);
  const claude = basis.research[0];
  assert.equal(claude.report_id, r.researcher.report_id);
  assert.equal(claude.eligible_at_decision, true);
  assert.match(claude.original_sha256, /^[0-9a-f]{64}$/);
  assert.equal(claude.grade.value, 52);
  for (const e of basis.research.slice(1)) assert.ok(e.report_id || ['none', 'held', 'excluded', 'pdf_only'].includes(e.state), `${e.provider}: a report or a stated absence`);
  // The Prosecutor and the typed spread, copied from the receipt.
  assert.equal(basis.prosecutor.spread.kind, 'researcher_gate_grade_minus_prosecutor_conviction');
  assert.equal(basis.prosecutor.spread.points, r.agent_disagreement.spread_points);
  assert.equal(basis.prosecutor.conviction_score, r.prosecution.conviction_score);
  // Authority: the mandate's generation and policy, the gate's state.
  assert.equal(basis.authority.decided_by, d.decided_by);
  assert.deepEqual([basis.authority.mandate.generation, basis.authority.mandate.policy_sha256, basis.authority.mandate.tier], [1, d.mandate.authority.policy_sha256, 'exploratory_50_54']);
  assert.deepEqual([basis.authority.gate.paused, basis.authority.gate.project_stopped], [false, false]);
  assert.ok('commit' in basis.code_revision);
  assert.ok(!('trader' in basis) && !JSON.stringify(basis).includes('fee_rate'), 'no execution context in the basis');

  // 3. Eric's rules and the fee change (a fee the decision never saw).
  settle(ws, { book: { fee_rate: '0.004' } });
  const now0 = Date.now();
  const top = Math.floor(now0 / H) * H;
  TD.applyHours(ws, Array.from({ length: 16 }, (_, i) => bar(top - (16 - i) * H)), { now: iso(now0) });

  // 5. tickets reconcile runs (the trader's request is completed by the
  // adapter's own later step, not by reconcile); 4. that step reserves.
  T.reconcileEffects(ws);
  assert.equal(PT.intents(ws).length, 0, 'nothing was reserved while the effect had failed');
  TD.step(ws);
  const ord = PT.intents(ws).find((i) => i.thesis_id === r.receipt_id && i.side === 'OPEN_LONG');
  assert.ok(ord, 'a buy is reserved');
  // The hour in progress at the send (it cannot fill: it began before the
  // order was live), then the next whole hour, which trades through the limit.
  TD.applyHours(ws, [bar(top), bar(top + H, { open: '0.85', high: '0.86', low: '0.80', close: '0.84', volume: '1000000' })], { now: iso(top + 2 * H + 11 * 60000) });

  // The basis bytes are unchanged by the effect, the settings, reconcile and the fill.
  assert.ok(bytes(ws, rel).equals(frozen), 'the basis is never rewritten');

  const v = DB.viewOf(ws, pid, d.decision_id);
  assert.equal(v.label, 'decision_time');
  assert.deepEqual(v.basis, basis, 'the view shows the basis as frozen, never current values');
  assert.equal(v.basis.authority.mandate.generation, 1);
  // Execution context, apart: the new fee from the reservation, labeled execution-time.
  assert.equal(v.execution.label, 'execution_time');
  assert.equal(v.execution.state, 'recorded');
  assert.equal(v.execution.reserved[0].venue.fee_rate, '0.004');
  assert.equal(v.execution.reserved[0].grant.decision_id, d.decision_id);
  assert.ok(v.execution.fills.length >= 1, 'the fill is read');
  assert.deepEqual(v.execution.not_recorded, ['engine revision', 'fill_share_max', 'trader.rules digest']);
});

test('a corrupted basis, receipt, packet or report original is refused as INTEGRITY, never rebuilt', (t) => {
  const s = mandateDesk(t, { grade: 60 });
  const { ws, pid } = s;
  const r = saveTicket(ws, pid);
  const d = T.decide(ws, pid, { receipt_id: r.receipt_id, action: 'veto', by: 'eric' }).result.decision;
  assert.equal(DB.viewOf(ws, pid, d.decision_id).label, 'decision_time');
  const basisFile = ws.abs(DB.basisRel(pid, d.decision_id));
  const receiptFile = ws.abs(`projects/${pid}/tickets/receipts/${r.receipt_id}.json`);
  const packetFile = ws.abs(r.packet.path);
  const basis = JSON.parse(fs.readFileSync(basisFile, 'utf8'));
  const reports = require('../core/reports').loadReports(ws, pid);
  const claude = reports.find((x) => x.report_id === basis.research[0].report_id);
  const originalFile = ws.abs(`${claude.dir}/${claude.meta.original_file}`);
  const integrity = (what) => (e) => e.code === 'INTEGRITY' && e.details && e.details.record === what;
  for (const [file, what] of [[receiptFile, 'The ticket receipt'], [packetFile, 'The frozen ticket packet'], [originalFile, `The original of report ${claude.report_id}`], [basisFile, 'The decision basis']]) {
    const was = fs.readFileSync(file);
    fs.writeFileSync(file, Buffer.concat([was, Buffer.from(file === basisFile ? 'x' : '\n')]));
    assert.throws(() => DB.viewOf(ws, pid, d.decision_id), integrity(what), what);
    assert.ok(fs.readFileSync(file).equals(Buffer.concat([was, Buffer.from(file === basisFile ? 'x' : '\n')])), `${what} is not rebuilt`);
    fs.writeFileSync(file, was);
  }
  assert.equal(DB.viewOf(ws, pid, d.decision_id).label, 'decision_time', 'restored, it reads again');
});

test('a decision from before the basis reads `reconstructed`, as of its time; later corrections are annotations, never applied', (t) => {
  const s = mandateDesk(t, { grade: 60 });
  const { ws, pid } = s;
  const r = saveTicket(ws, pid);
  const d = T.decide(ws, pid, { receipt_id: r.receipt_id, action: 'veto', by: 'eric' }).result.decision;
  // Deleting only the basis is refused: its digest is on record (audit F3).
  fs.unlinkSync(ws.abs(DB.basisRel(pid, d.decision_id)));
  assert.throws(() => DB.viewOf(ws, pid, d.decision_id), (e) => e.code === 'INTEGRITY' && /missing, though its digest is on record/.test(e.message));
  // A project from before the basis has neither a basis nor a digest ledger.
  fs.unlinkSync(ws.abs(DB.digestRel(pid)));
  // A correction dated after the decision: Claude's report later excluded.
  const notes = require('../core/notes');
  const rid = r.researcher.report_id;
  notes.addCorrection(ws, pid, rid, 'eligibility', { excluded: true, reason: 'FICTIONAL later exclusion' }, 'FICTIONAL test');
  const v = DB.viewOf(ws, pid, d.decision_id);
  assert.equal(v.label, 'reconstructed');
  assert.notEqual(v.label, 'decision_time');
  assert.equal(v.basis.receipt_sha256, null, 'the receipt\'s bytes then were not recorded');
  assert.deepEqual(v.basis.code_revision, { state: 'not_recorded' });
  const input = v.basis.research.find((e) => e.use === 'decision_input');
  assert.equal(input.report_id, rid);
  assert.equal(input.eligible_at_decision, true, 'the exclusion came after the decision and is not applied');
  assert.ok(v.later.some((x) => x.report_id === rid && x.field === 'eligibility'), 'listed as a later annotation');
});

test('a replay writes no second basis; every decision action gets one; the basis is create-only', (t) => {
  const s = mandateDesk(t, { grade: 60 });
  const { ws, pid } = s;
  const r = saveTicket(ws, pid);
  const a = T.decide(ws, pid, { receipt_id: r.receipt_id, action: 'veto', by: 'eric', request_id: 'req_basis_veto01' }).result.decision;
  const again = T.decide(ws, pid, { receipt_id: r.receipt_id, action: 'veto', by: 'eric', request_id: 'req_basis_veto01' });
  assert.equal(again.result.status, 'unchanged');
  const u = T.decide(ws, pid, { receipt_id: r.receipt_id, action: 'undo', by: 'eric' }).result.decision;
  const dir = ws.abs(`projects/${pid}/tickets/basis`);
  assert.deepEqual(fs.readdirSync(dir).sort(), [`${a.decision_id}.json`, `${u.decision_id}.json`].sort());
  assert.equal(JSON.parse(fs.readFileSync(`${dir}/${u.decision_id}.json`, 'utf8')).authority.decided_by, 'eric');
  assert.throws(() => DB.viewOf(ws, pid, 'td_nope'), (e) => e.code === 'BAD_ID');
  assert.throws(() => DB.viewOf(ws, pid, 'td_00000000000000'), (e) => e.code === 'NOT_FOUND');
});
