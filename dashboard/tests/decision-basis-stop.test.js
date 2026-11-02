'use strict';
// Audit F1 (audit-blueprint-implementation-2026-11-02.md): building the
// decision basis must never stop Eric's veto or Undo from committing. Those
// lines ARE the project stop (mandate-authority.js autonomyOf reads them from
// decisions.jsonl), so a basis that cannot be built is recorded as unavailable
// (cr.decision-basis-unavailable.v1, create-only, in the same operation) and
// read back as `unavailable`: never `decision_time`, never `reconstructed`,
// never rebuilt. A grant (approve, halve) still commits only with its basis.
// The failures are injected into what buildBasis really calls: the rubric
// files on disk, the report loader, and buildBasis itself.
// FICTIONAL temporary workspaces only: nothing here is a market, a venue or
// an order.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const T = require('../core/tickets');
const TD = require('../core/trader-desk');
const PT = require('../core/paper-trader');
const DB = require('../core/decision-basis');
const MA = require('../core/mandate-authority');
const Ops = require('../core/ops');
const reports = require('../core/reports');
const { deskWith, settle, bar, mine, H, iso } = require('./trader-fixture');

const BASIS_FILE_RE = /[\\/]tickets[\\/]basis[\\/]td_[0-9a-f]{14}\.json$/;
const decisionsOf = (ws, pid) => {
  const rel = ws.abs(`projects/${pid}/tickets/decisions.jsonl`);
  return fs.existsSync(rel) ? fs.readFileSync(rel, 'utf8').split('\n').filter(Boolean) : [];
};
const basisFiles = (ws, pid) => {
  const dir = ws.abs(`projects/${pid}/tickets/basis`);
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
};
const journalFor = (ws, pid, did) => require('../core/notes').loadJournal(ws, pid).filter((e) => e.type === 'decision' && (e.reasons || []).includes(`decision_id: ${did}`));

// Each failure turns on at once and returns its own restore.
const FAILURES = {
  // buildBasis itself throws.
  build_basis: () => {
    const real = DB.buildBasis;
    DB.buildBasis = () => { throw new Error('FICTIONAL basis construction failed'); };
    return () => { DB.buildBasis = real; };
  },
  // The real rubric loader meets a rubric file that does not read: the
  // workspace's rubrics are loaded again from disk and JSON.parse throws
  // inside rubrics.gradeAssessment, which buildBasis calls for each report.
  rubric_grading: (ws) => {
    const bad = ws.abs('templates/rubrics/zz-fictional-unreadable.json');
    fs.writeFileSync(bad, '{ "rubric_ref": "cr-grading@fictional", ');
    ws._rubrics = null;
    assert.throws(() => require('../core/rubrics').gradeAssessment(ws, { rubric_version: 'cr-grading@1', investment_components: [] }), SyntaxError, 'the real grader now fails');
    return () => { fs.unlinkSync(bad); ws._rubrics = null; };
  },
  // The report loader fails as a disk would (EIO).
  report_loading: () => {
    const real = reports.loadReports;
    reports.loadReports = () => { throw Object.assign(new Error('FICTIONAL EIO reading the project\'s reports'), { code: 'EIO' }); };
    return () => { reports.loadReports = real; };
  },
};
const WORDS = { build_basis: /FICTIONAL basis construction failed/, rubric_grading: /JSON|Unexpected|Expected/, report_loading: /FICTIONAL EIO/ };

function withFailure(kind, ws, fn) {
  const restore = FAILURES[kind](ws);
  try { return fn(); } finally { restore(); }
}

// A funded book with sixteen closed hours and Eric's live approve: its buy
// reserved and acknowledged at the venue the book simulates.
function liveGrant(t) {
  const s = deskWith(t);
  const { ws, pid, rid } = s;
  settle(ws);
  const now0 = Date.now();
  const top = Math.floor(now0 / H) * H;
  TD.applyHours(ws, Array.from({ length: 16 }, (_, i) => bar(top - (16 - i) * H)), { now: iso(now0) });
  const ap = T.decide(ws, pid, { receipt_id: rid, action: 'approve', by: 'eric', request_id: 'req_f1_approve01' });
  assert.equal(ap.result.status, 'saved');
  assert.equal(ap.result.trader.status, 'order', 'the approve asks the book at once');
  const approve = ap.result.decision;
  const buy = PT.intents(ws).find((i) => i.intent_id === TD.intentIdOf(approve, 'open'));
  assert.equal(buy.state, 'ACKED', 'a live buy is resting');
  assert.equal(MA.automationGate(ws, pid).project_stopped, false, 'a grant stops nothing');
  return { ...s, approve };
}

// The unavailable record and what the view says of it.
function assertUnavailable(ws, pid, d, words) {
  const rel = DB.basisRel(pid, d.decision_id);
  const rec = JSON.parse(fs.readFileSync(ws.abs(rel), 'utf8'));
  assert.equal(rec.schema_version, DB.UNAVAILABLE_VERSION);
  assert.notEqual(rec.schema_version, DB.BASIS_VERSION, 'never labelled a basis');
  assert.deepEqual([rec.decision_id, rec.receipt_id, rec.decided_at, rec.action, rec.state], [d.decision_id, d.receipt_id, d.decided_at, d.action, 'unavailable']);
  assert.match(rec.failure.words, words, 'the failure is recorded in its own words');
  for (const k of ['research', 'prosecutor', 'authority', 'receipt_sha256', 'code_revision']) assert.ok(!(k in rec), `no ${k} is invented`);
  const v = DB.viewOf(ws, pid, d.decision_id);
  assert.equal(v.label, 'unavailable');
  assert.notEqual(v.label, 'decision_time');
  assert.notEqual(v.label, 'reconstructed');
  assert.equal(v.basis, null, 'no basis is shown, current or rebuilt');
  assert.deepEqual(v.unavailable, rec);
  assert.match(v.words, /not recorded.*never rebuilt/s);
  return rec;
}

for (const kind of Object.keys(FAILURES)) {
  test(`F1 (${kind}): Eric's veto commits and stops the project when the basis cannot be built; a replay adds nothing`, (t) => {
    const { ws, pid, rid } = deskWith(t);
    assert.equal(MA.automationGate(ws, pid).project_stopped, false, 'not stopped before the veto');
    const before = decisionsOf(ws, pid).length;

    const out = withFailure(kind, ws, () => T.decide(ws, pid, { receipt_id: rid, action: 'veto', by: 'eric', request_id: `req_f1_veto_${kind}` }));
    assert.equal(out.result.status, 'saved', 'the veto is recorded');
    assert.equal(out.verified, true, 'and read back');
    const d = out.result.decision;
    assert.equal(d.action, 'veto');
    assert.deepEqual(out.result.basis, { state: 'unavailable', words: out.result.basis.words });
    assert.match(out.result.basis.words, /could not be recorded/);
    assert.equal(decisionsOf(ws, pid).length, before + 1, 'one decision line');

    // The stop is in force: the one gate every automated path asks.
    const gate = MA.automationGate(ws, pid);
    assert.equal(gate.ok, false);
    assert.equal(gate.project_stopped, true);
    assert.equal(gate.code, 'SUSPENDED');
    assert.ok(gate.autonomy.interventions.some((l) => l.id === d.decision_id && l.kind === 'veto'), 'the veto is the latch');

    const rec = assertUnavailable(ws, pid, d, WORDS[kind]);
    assert.deepEqual(basisFiles(ws, pid), [`${d.decision_id}.json`]);
    assert.equal(journalFor(ws, pid, d.decision_id).length, 1, 'its journal entry, once');

    // The same request again, with the dependency healthy: unchanged, nothing
    // added, the unavailable record never replaced by a basis built now.
    const recBytes = fs.readFileSync(ws.abs(DB.basisRel(pid, d.decision_id)));
    const again = T.decide(ws, pid, { receipt_id: rid, action: 'veto', by: 'eric', request_id: `req_f1_veto_${kind}` });
    assert.equal(again.result.status, 'unchanged');
    assert.equal(again.result.decision.decision_id, d.decision_id);
    assert.equal(again.result.basis.state, 'unavailable', 'the replay says the basis state as recorded');
    // The same decision again under another request is also the one on record.
    const same = T.decide(ws, pid, { receipt_id: rid, action: 'veto', by: 'eric' });
    assert.equal(same.result.status, 'unchanged');
    assert.equal(decisionsOf(ws, pid).length, before + 1, 'no second decision line');
    assert.deepEqual(basisFiles(ws, pid), [`${d.decision_id}.json`], 'no second basis file');
    assert.ok(fs.readFileSync(ws.abs(DB.basisRel(pid, d.decision_id))).equals(recBytes), 'never rebuilt');
    assert.equal(journalFor(ws, pid, d.decision_id).length, 1, 'no second journal entry');
    if (kind === 'report_loading') assert.equal(rec.failure.code, 'EIO', 'the error code is kept');
  });

  test(`F1 (${kind}): Undo of a live grant commits, stops the project and keeps its cancel request when the basis cannot be built; a replay adds nothing`, (t) => {
    const { ws, pid, rid, approve } = liveGrant(t);
    const lines0 = decisionsOf(ws, pid).length;

    const out = withFailure(kind, ws, () => T.decide(ws, pid, { receipt_id: rid, action: 'undo', by: 'eric', request_id: `req_f1_undo_${kind}` }));
    assert.equal(out.result.status, 'saved', 'the Undo is recorded');
    const u = out.result.decision;
    assert.deepEqual([u.action, u.undoes], ['undo', approve.decision_id]);
    assert.equal(u.effects.trader, 'close', 'the line asks the book to cancel and close');
    assert.equal(out.result.basis.state, 'unavailable');

    // The risk is taken off: the decision's own step cancelled the resting buy.
    assert.equal(out.result.trader.status, 'ended');
    const buy = PT.intents(ws).find((i) => i.intent_id === TD.intentIdOf(approve, 'open'));
    assert.equal(buy.state, 'CANCELLED', 'the buy is cancelled');
    assert.equal(mine(TD.requests(ws), approve.decision_id).phase, 'ended');
    assert.equal(T.decisionFor(T.readDecisions(ws, pid), rid), null, 'no grant is in force');

    const gate = MA.automationGate(ws, pid);
    assert.equal(gate.project_stopped, true);
    assert.ok(gate.autonomy.interventions.some((l) => l.id === u.decision_id && l.kind === 'undo'), 'the Undo is the latch');
    assertUnavailable(ws, pid, u, WORDS[kind]);
    // The approve kept the basis it froze.
    assert.equal(DB.viewOf(ws, pid, approve.decision_id).label, 'decision_time');

    // Replay: no second line, intent, cancel or journal entry.
    const intents = JSON.stringify(PT.intents(ws));
    const book = fs.readFileSync(ws.abs(PT.JOURNAL));
    const again = T.decide(ws, pid, { receipt_id: rid, action: 'undo', by: 'eric', request_id: `req_f1_undo_${kind}` });
    assert.equal(again.result.status, 'unchanged');
    assert.equal(again.result.decision.decision_id, u.decision_id);
    assert.equal(again.result.basis.state, 'unavailable');
    assert.equal(decisionsOf(ws, pid).length, lines0 + 1);
    assert.equal(JSON.stringify(PT.intents(ws)), intents, 'no new intent');
    assert.ok(fs.readFileSync(ws.abs(PT.JOURNAL)).equals(book), 'the book journal is unchanged');
    assert.equal(journalFor(ws, pid, u.decision_id).length, 1);
    assert.deepEqual(TD.step(ws).done, [], 'the adapter has nothing left to ask');
  });
}

test('F1: a grant still commits only with its basis: approve is refused, writes nothing and opens nothing when the basis cannot be built', (t) => {
  const { ws, pid, rid } = deskWith(t);
  settle(ws);
  const now0 = Date.now();
  const top = Math.floor(now0 / H) * H;
  TD.applyHours(ws, Array.from({ length: 16 }, (_, i) => bar(top - (16 - i) * H)), { now: iso(now0) });
  for (const kind of Object.keys(FAILURES)) {
    // A rubric or report loader that fails is refused earlier still, by the
    // grant's own check (the report no longer reads as Claude's current
    // eligible one); buildBasis failing is refused by the basis. Either way,
    // refused, and nothing written.
    assert.throws(() => withFailure(kind, ws, () => T.decide(ws, pid, { receipt_id: rid, action: 'approve', by: 'eric' })), kind === 'build_basis' ? WORDS[kind] : /Not recorded: Claude's report .* is no longer Claude's current eligible report/, kind);
    assert.equal(decisionsOf(ws, pid).length, 0, `${kind}: no decision line`);
    assert.deepEqual(basisFiles(ws, pid), [], `${kind}: no basis file`);
    assert.equal(PT.intents(ws).length, 0, `${kind}: no order`);
  }
  // A halve, the same.
  assert.throws(() => withFailure('build_basis', ws, () => T.decide(ws, pid, { receipt_id: rid, action: 'halve', by: 'eric' })), /FICTIONAL/);
  assert.equal(decisionsOf(ws, pid).length, 0);
  // Healthy again, the approve commits with a decision-time basis.
  const ap = T.decide(ws, pid, { receipt_id: rid, action: 'approve', by: 'eric' });
  assert.equal(ap.result.basis.state, 'frozen');
  assert.equal(DB.viewOf(ws, pid, ap.result.decision.decision_id).label, 'decision_time');
});

test('F1: the decision line keeps cr.ticket-decision.v1, its fields and their order, whether or not the basis could be built', (t) => {
  const a = deskWith(t);
  const b = deskWith(t);
  const ok = T.decide(a.ws, a.pid, { receipt_id: a.rid, action: 'veto', by: 'eric', note: 'FICTIONAL note', request_id: 'req_f1_bytes_ok01' });
  const bad = withFailure('build_basis', b.ws, () => T.decide(b.ws, b.pid, { receipt_id: b.rid, action: 'veto', by: 'eric', note: 'FICTIONAL note', request_id: 'req_f1_bytes_ok01' }));
  assert.equal(ok.result.basis.state, 'frozen');
  assert.equal(bad.result.basis.state, 'unavailable');
  const [lineA] = decisionsOf(a.ws, a.pid);
  const [lineB] = decisionsOf(b.ws, b.pid);
  const A = JSON.parse(lineA);
  const B = JSON.parse(lineB);
  assert.equal(lineA, JSON.stringify(A), 'one JSON line as written');
  assert.equal(lineB, JSON.stringify(B), 'one JSON line as written');
  assert.equal(B.schema_version, 'cr.ticket-decision.v1');
  assert.deepEqual(Object.keys(B), Object.keys(A), 'the same fields in the same order');
  // Equal but for what differs between two workspaces: the time, the IDs
  // derived from it, and the ticket each workspace saved.
  const same = (x) => JSON.stringify({ ...x, decision_id: '', decided_at: '', receipt_id: '', ticket_id: '' });
  assert.equal(same(B), same(A));
  assert.equal(lineB.length - B.decision_id.length - B.decided_at.length - B.receipt_id.length - B.ticket_id.length, lineA.length - A.decision_id.length - A.decided_at.length - A.receipt_id.length - A.ticket_id.length, 'the same bytes apart from those values');
});

test('F1: recovery — an Undo whose basis could not be built and whose install was cut short is rolled forward; the stop holds; a retry completes its effects once and says the basis is unavailable', (t) => {
  const { ws, pid, rid, approve } = liveGrant(t);
  const realRename = fs.renameSync;
  const restoreBasis = FAILURES.build_basis();
  fs.renameSync = function (from, to) {
    if (BASIS_FILE_RE.test(String(to))) throw Object.assign(new Error('FICTIONAL EIO installing the basis record'), { code: 'EIO' });
    return realRename.apply(this, arguments);
  };
  try {
    assert.throws(() => T.decide(ws, pid, { receipt_id: rid, action: 'undo', by: 'eric', request_id: 'req_f1_recover01' }), (e) => e.code === 'APPLY_INTERRUPTED');
  } finally {
    fs.renameSync = realRename;
    restoreBasis();
  }
  // The operation is sealed; its decision line went in first, so the stop is
  // already in force while the rest waits to be rolled forward.
  assert.deepEqual(Ops.pendingRecovery(ws).map((p) => p.state), ['sealed']);
  const undoLine = decisionsOf(ws, pid).map((l) => JSON.parse(l)).find((d) => d.action === 'undo');
  assert.ok(undoLine, 'the Undo line is on disk');
  assert.equal(MA.automationGate(ws, pid).project_stopped, true);
  assert.equal(fs.existsSync(ws.abs(DB.basisRel(pid, undoLine.decision_id))), false, 'its basis record is not yet installed');

  assert.deepEqual(Ops.recover(ws).map((x) => x.action), ['rolled_forward']);
  assert.deepEqual(Ops.pendingRecovery(ws), []);
  assertUnavailable(ws, pid, undoLine, /FICTIONAL basis construction failed/);

  // The retry: the decision on record, its effects completed once, the basis
  // state said as recorded (the dependency is healthy now; nothing is rebuilt).
  const r1 = T.decide(ws, pid, { receipt_id: rid, action: 'undo', by: 'eric', request_id: 'req_f1_recover01' });
  assert.equal(r1.result.status, 'unchanged');
  assert.equal(r1.result.decision.decision_id, undoLine.decision_id);
  assert.equal(r1.result.live, true);
  assert.equal(r1.result.basis.state, 'unavailable');
  assert.equal(r1.result.trader.status, 'ended');
  assert.equal(PT.intents(ws).find((i) => i.intent_id === TD.intentIdOf(approve, 'open')).state, 'CANCELLED');
  assert.equal(journalFor(ws, pid, undoLine.decision_id).length, 1);
  const r2 = T.decide(ws, pid, { receipt_id: rid, action: 'undo', by: 'eric', request_id: 'req_f1_recover01' });
  assert.equal(r2.result.status, 'unchanged');
  assert.equal(journalFor(ws, pid, undoLine.decision_id).length, 1, 'the journal entry is not duplicated');
  assert.equal(decisionsOf(ws, pid).filter((l) => JSON.parse(l).action === 'undo').length, 1, 'one Undo line');
  assertUnavailable(ws, pid, undoLine, /FICTIONAL basis construction failed/);
});

test('F1: an unavailable record that does not belong to its decision is refused as INTEGRITY, never read as a basis', (t) => {
  const { ws, pid, rid } = deskWith(t);
  const d = withFailure('build_basis', ws, () => T.decide(ws, pid, { receipt_id: rid, action: 'veto', by: 'eric' })).result.decision;
  const file = ws.abs(DB.basisRel(pid, d.decision_id));
  const was = fs.readFileSync(file);
  const rec = JSON.parse(was.toString('utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...rec, decided_at: '2026-01-01T00:00:00.000Z' }, null, 2));
  assert.throws(() => DB.viewOf(ws, pid, d.decision_id), (e) => e.code === 'INTEGRITY' && e.details.record === 'The decision basis');
  fs.writeFileSync(file, was);
  assert.equal(DB.viewOf(ws, pid, d.decision_id).label, 'unavailable');
});
