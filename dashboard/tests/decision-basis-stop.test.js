'use strict';
// Audit F1 (audit-blueprint-implementation-2026-11-02.md): building the
// decision basis must never stop one of Eric's documented stop actions from
// committing: his veto and Undo (their lines ARE the project stop;
// mandate-authority.js autonomyOf reads them from decisions.jsonl) and his
// pass on a project he does not hold (it archives the project; DESK_STATE.md
// "Confirm Pass & Archive (archives the project unless held)"). A basis that
// cannot be built is recorded as unavailable (cr.decision-basis-unavailable.v1,
// create-only, in the same operation) and read back as `unavailable`: never
// `decision_time`, never `reconstructed`, never rebuilt, and never a claim
// about whether the decision still applies. A grant, any mandate line, a
// watch, a trim, a re-open and a pass on a held project still commit only
// with their basis.
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
const { deskWith, settle, bar, mine, answer, H, M, iso } = require('./trader-fixture');
const { tempWorkspace, addFixtureProject, importAllFixtures } = require('./helpers');
const { openWorkspace } = require('../core/workspace');

// Words about a historical record never speak for current authority.
const noAuthority = (words, what) => assert.ok(!/in force|stands/.test(words), `${what} makes no claim of current authority: ${words}`);

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
  noAuthority(v.words, 'the view');
  noAuthority(rec.meaning, 'the record');
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
    assert.match(out.result.basis.words, /could be recorded/);
    noAuthority(out.result.basis.words, 'the answer');
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

// ---------------------------------------------------------------------------
// One identity contract for every reader (viewOf, stateOf and the replay).

test('F1: every reader applies one identity contract: a record that does not match its decision (receipt, project, action, time, schema, state) is INTEGRITY in the view, the replay and stateOf; the replay adds no decision and repeats no effect', (t) => {
  const { ws, pid, rid } = deskWith(t);
  const out = withFailure('build_basis', ws, () => T.decide(ws, pid, { receipt_id: rid, action: 'veto', by: 'eric', request_id: 'req_f1_ident_v01' }));
  const d = out.result.decision;
  const file = ws.abs(DB.basisRel(pid, d.decision_id));
  const was = fs.readFileSync(file);
  const rec = JSON.parse(was.toString('utf8'));
  const lines = decisionsOf(ws, pid).length;
  const journal = journalFor(ws, pid, d.decision_id).length;
  const cases = {
    receipt_id: { ...rec, receipt_id: 'tr_2026-01-01T000000Z_fictio' },
    project_id: { ...rec, project_id: 'some-other-project' },
    action: { ...rec, action: 'undo' },
    decided_at: { ...rec, decided_at: '2026-01-01T00:00:00.000Z' },
    schema_version: { ...rec, schema_version: DB.BASIS_VERSION },
    state: { ...rec, state: 'frozen' },
    failure: (() => { const x = { ...rec }; delete x.failure; return x; })(),
    research: { ...rec, research: [] },
    unknown_schema: { ...rec, schema_version: 'cr.decision-basis.v9' },
  };
  for (const [what, bad] of Object.entries(cases)) {
    fs.writeFileSync(file, JSON.stringify(bad, null, 2));
    assert.throws(() => DB.viewOf(ws, pid, d.decision_id), (e) => e.code === 'INTEGRITY' && e.details.record === 'The decision basis', `${what}: the view refuses it`);
    const st = DB.stateOf(ws, pid, d);
    assert.equal(st.state, 'integrity', `${what}: stateOf agrees with the view`);
    assert.notEqual(st.state, 'unavailable');
    const again = T.decide(ws, pid, { receipt_id: rid, action: 'veto', by: 'eric', request_id: 'req_f1_ident_v01' });
    assert.equal(again.result.status, 'unchanged', `${what}: the replay decides nothing again`);
    assert.equal(again.result.basis.state, 'integrity', `${what}: and says the record does not match`);
    assert.equal(decisionsOf(ws, pid).length, lines, `${what}: no second decision line`);
    assert.equal(journalFor(ws, pid, d.decision_id).length, journal, `${what}: no second journal entry`);
    assert.ok(fs.readFileSync(file).equals(Buffer.from(JSON.stringify(bad, null, 2))), `${what}: the record is not rebuilt`);
  }
  // Malformed bytes: the same answer from both.
  fs.writeFileSync(file, Buffer.concat([was, Buffer.from('x')]));
  assert.throws(() => DB.viewOf(ws, pid, d.decision_id), (e) => e.code === 'INTEGRITY');
  assert.equal(DB.stateOf(ws, pid, d).state, 'integrity');
  fs.writeFileSync(file, was);
  assert.equal(DB.viewOf(ws, pid, d.decision_id).label, 'unavailable', 'restored, it reads again');
  assert.equal(DB.stateOf(ws, pid, d).state, 'unavailable');

  // A frozen basis is held to the same contract by both readers.
  const s2 = deskWith(t);
  const v2 = T.decide(s2.ws, s2.pid, { receipt_id: s2.rid, action: 'veto', by: 'eric' }).result.decision;
  const f2 = s2.ws.abs(DB.basisRel(s2.pid, v2.decision_id));
  const b2 = JSON.parse(fs.readFileSync(f2, 'utf8'));
  for (const [what, bad] of Object.entries({ receipt_id: { ...b2, receipt_id: 'tr_2026-01-01T000000Z_fictio' }, project_id: { ...b2, project_id: 'x' }, action: { ...b2, action: 'pass' }, decided_at: { ...b2, decided_at: '2026-01-01T00:00:00.000Z' }, schema_version: { ...b2, schema_version: DB.UNAVAILABLE_VERSION }, receipt_sha256: { ...b2, receipt_sha256: null } })) {
    fs.writeFileSync(f2, JSON.stringify(bad, null, 2));
    assert.throws(() => DB.viewOf(s2.ws, s2.pid, v2.decision_id), (e) => e.code === 'INTEGRITY', `frozen ${what}: the view refuses it`);
    assert.equal(DB.stateOf(s2.ws, s2.pid, v2).state, 'integrity', `frozen ${what}: stateOf agrees`);
  }
});

// ---------------------------------------------------------------------------
// Historical basis availability never asserts current authority.

test('F1: a replay of a veto says the basis as recorded, whether the veto is current or was undone since; neither answer claims the decision is in force', (t) => {
  const { ws, pid, rid } = deskWith(t);
  const v = withFailure('build_basis', ws, () => T.decide(ws, pid, { receipt_id: rid, action: 'veto', by: 'eric', request_id: 'req_f1_super_v01' }));
  noAuthority(v.result.basis.words, 'the first answer');
  // Current: the veto is the decision in force.
  const cur = T.decide(ws, pid, { receipt_id: rid, action: 'veto', by: 'eric', request_id: 'req_f1_super_v01' });
  assert.equal(cur.result.status, 'unchanged');
  assert.equal(cur.result.live, true, 'the veto is in force');
  assert.equal(cur.result.basis.state, 'unavailable');
  noAuthority(cur.result.basis.words, 'the current replay');
  // Superseded: Eric undoes the veto (its own basis builds); no decision is in force.
  const u = T.decide(ws, pid, { receipt_id: rid, action: 'undo', by: 'eric', request_id: 'req_f1_super_u01' });
  assert.equal(u.result.basis.state, 'frozen');
  assert.equal(T.decisionFor(T.readDecisions(ws, pid), rid), null, 'nothing is in force after the Undo');
  const old = T.decide(ws, pid, { receipt_id: rid, action: 'veto', by: 'eric', request_id: 'req_f1_super_v01' });
  assert.equal(old.result.status, 'unchanged');
  assert.equal(old.result.live, false, 'the replay says the veto is no longer in force');
  assert.equal(old.result.basis.state, 'unavailable', 'and the basis as it was recorded');
  noAuthority(old.result.basis.words, 'the superseded replay');
  noAuthority(DB.viewOf(ws, pid, v.result.decision.decision_id).words, 'the superseded view');
  assert.equal(decisionsOf(ws, pid).length, 2, 'veto and Undo, nothing more');
});

// ---------------------------------------------------------------------------
// Undo after a causal fill: the book's own hours, its own rules.

for (const kind of Object.keys(FAILURES)) {
  test(`F1 (${kind}): Undo after a partial fill commits and stops the project; the rest of the buy is cancelled and the filled part closed, each at the hour the book allows; repeats and a restart add nothing`, (t) => {
    const { ws, pid, rid, root, approve } = liveGrant(t);
    const now0 = Date.now();
    const top = Math.floor(now0 / H) * H;
    // A causal fill: only an hour that starts after the order was sent fills
    // it, at most 10% of the hour's 10,000 volume.
    const sentAt = Date.now();
    const fillHour = Math.ceil(sentAt / H) * H;
    const upTo = Array.from({ length: Math.round((fillHour - top) / H) + 1 }, (_, i) => bar(top + i * H));
    const n1 = fillHour + H + M;
    const hours = TD.applyHours(ws, upTo, { now: iso(n1) });
    assert.deepEqual(hours.flatMap((x) => x.events.filter((e) => e.type === 'fill').map((e) => [x.hour, e.quantity, e.price])), [[iso(fillHour), '1000', '0.85']], 'one causal fill of 1,000 at $0.85');
    assert.match(mine(TD.requests(ws, { now: iso(n1) }), approve.decision_id).words, /the buy is still PARTIAL, 1000 of 2352\.941176 filled/);

    // The Undo, with the basis failing.
    const out = withFailure(kind, ws, () => T.decide(ws, pid, { receipt_id: rid, action: 'undo', by: 'eric', request_id: `req_f1_fill_${kind}` }));
    assert.equal(out.result.status, 'saved', 'the Undo is recorded');
    const u = out.result.decision;
    assert.equal(u.effects.trader, 'close', 'the line asks the book to cancel and close');
    assert.equal(out.result.basis.state, 'unavailable');
    assert.equal(T.decisionFor(T.readDecisions(ws, pid), rid), null, 'the grant is revoked');
    assert.equal(MA.automationGate(ws, pid).project_stopped, true, 'the project is stopped');
    assertUnavailable(ws, pid, u, WORDS[kind]);
    // The decision's own step runs at the wall clock, before the book's last
    // hour: the book never goes back in time, and the answer says so rather
    // than claiming the position ended.
    assert.ok(out.result.trader.problems.some((p) => p.code === 'TIME'), 'the close waits for the book\'s next hour, said');
    assert.notEqual(out.result.trader.status, 'closed');
    assert.equal(PT.results(ws, { now: iso(n1) }).open_positions.length, 1, 'the filled part is still open until the book can act');

    // The close request is durable: the next step at the book's time cancels
    // the unfilled rest and sells the 1,000 at 20 bps under the last close.
    const s2 = TD.step(ws, { now: iso(n1 + M) });
    assert.deepEqual(s2.done.map((x) => [x.kind, x.status, x.state]), [['cancel', 'saved', 'CANCELLED'], ['close', 'saved', 'ACKED']]);
    const buy = PT.intents(ws).find((i) => i.intent_id === TD.intentIdOf(approve, 'open'));
    assert.equal(buy.state, 'CANCELLED', 'the unfilled rest is cancelled');
    const sell = PT.intents(ws).find((i) => i.intent_id === TD.intentIdOf(approve, 'close-1'));
    assert.deepEqual([sell.side, sell.quantity, sell.state], ['CLOSE_LONG', '1000', 'ACKED'], 'one sell for the filled 1,000');

    // Repeats and a restart: no second line, intent, order, fill or journal entry.
    const intents = JSON.stringify(PT.intents(ws));
    const book = fs.readFileSync(ws.abs(PT.JOURNAL));
    const again = T.decide(ws, pid, { receipt_id: rid, action: 'undo', by: 'eric', request_id: `req_f1_fill_${kind}` });
    assert.equal(again.result.status, 'unchanged');
    assert.equal(again.result.basis.state, 'unavailable');
    assert.deepEqual(TD.step(ws, { now: iso(n1 + 2 * M) }).done, [], 'nothing is asked twice');
    const ws2 = openWorkspace({ root, actor: 'test' });
    ws2.settings.trader = ws.settings.trader;
    const after = T.decide(ws2, pid, { receipt_id: rid, action: 'undo', by: 'eric', request_id: `req_f1_fill_${kind}` });
    assert.equal(after.result.status, 'unchanged', 'after a restart, the same');
    assert.deepEqual(TD.step(ws2, { now: iso(n1 + 3 * M) }).done, [], 'nothing is asked after a restart');
    assert.equal(JSON.stringify(PT.intents(ws2)), intents, 'no new intent');
    assert.ok(fs.readFileSync(ws2.abs(PT.JOURNAL)).equals(book), 'the book journal is unchanged');
    assert.equal(decisionsOf(ws2, pid).filter((l) => JSON.parse(l).action === 'undo').length, 1, 'one Undo line');
    assert.equal(journalFor(ws2, pid, u.decision_id).length, 1, 'one journal entry');

    // The next whole hour trades above the limit: the 1,000 are sold at its
    // open; the position is closed only now, by the book.
    const n2 = fillHour + 3 * H + M;
    const h3 = TD.applyHours(ws2, [bar(fillHour + H), bar(fillHour + 2 * H)], { now: iso(n2) });
    assert.deepEqual(h3.map((x) => x.events.filter((e) => e.type === 'exit').map((e) => [e.reason, e.quantity, e.price])), [[], [['close', '1000', '0.85']]]);
    assert.equal(mine(TD.requests(ws2, { now: iso(n2) }), approve.decision_id).phase, 'closed');
    assert.equal(PT.results(ws2, { now: iso(n2) }).open_positions.length, 0);
    const fills = (j) => j.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'fill' || e.type === 'exit').length;
    const closed = fs.readFileSync(ws2.abs(PT.JOURNAL));
    assert.equal(T.decide(ws2, pid, { receipt_id: rid, action: 'undo', by: 'eric', request_id: `req_f1_fill_${kind}` }).result.status, 'unchanged');
    assert.deepEqual(TD.step(ws2, { now: iso(n2 + M) }).done, []);
    assert.equal(fills(fs.readFileSync(ws2.abs(PT.JOURNAL))), fills(closed), 'no second fill or exit');
  });
}

// ---------------------------------------------------------------------------
// Eric's pass: it archives an unheld project (a stop); a held one stays watched.

function zeroTicket(t, { held }) {
  const w = tempWorkspace('f1-pass');
  t.after(w.cleanup);
  const pid = addFixtureProject(w.ws).project_id;
  importAllFixtures(w.ws);
  const portfolio = require('../core/portfolio');
  const real = portfolio.computePortfolio;
  portfolio.computePortfolio = (...a) => ({ ...real(...a), positions: held ? [{ project_id: pid, closed: false }] : [] });
  t.after(() => { portfolio.computePortfolio = real; });
  const tk = T.createTicket(w.ws, { project_id: pid, assistant: true }).ticket;
  const saved = T.saveTicket(w.ws, { project_id: pid, ticket_id: tk.ticket_id, text: answer(T.loadTicket(w.ws, pid, tk.ticket_id)) });
  assert.equal(saved.receipt.desk.suggested_risk_usd, 0, 'a $0 ticket: pass applies');
  return { ...w, pid, rid: saved.receipt_id };
}

for (const kind of Object.keys(FAILURES)) {
  test(`F1 (${kind}): Eric's pass on a project he does not hold commits, archives it and stops it when the basis cannot be built; a replay adds nothing`, (t) => {
    const { ws, pid, rid } = zeroTicket(t, { held: false });
    const projects = require('../core/projects');
    const out = withFailure(kind, ws, () => T.decide(ws, pid, { receipt_id: rid, action: 'pass', by: 'eric', request_id: `req_f1_pass_${kind}` }));
    assert.equal(out.result.status, 'saved');
    const d = out.result.decision;
    assert.equal(d.archive, 'archived');
    assert.equal(out.result.project_archived, true);
    assert.equal(projects.getProject(ws, pid).status, 'archived');
    const gate = MA.automationGate(ws, pid);
    assert.equal(gate.project_stopped, true, 'the archive stops the project');
    assert.ok(gate.autonomy.interventions.some((x) => x.kind === 'archive'));
    assertUnavailable(ws, pid, d, WORDS[kind]);
    const again = T.decide(ws, pid, { receipt_id: rid, action: 'pass', by: 'eric', request_id: `req_f1_pass_${kind}` });
    assert.equal(again.result.status, 'unchanged');
    assert.equal(decisionsOf(ws, pid).length, 1);
    assert.equal(journalFor(ws, pid, d.decision_id).length, 1);
  });
}

test('F1: a pass on a held project stays watched and stops nothing, so it still commits only with its basis; watch, trim, re-open and mandate lines are never recorded without one', (t) => {
  const { ws, pid, rid } = zeroTicket(t, { held: true });
  const projects = require('../core/projects');
  for (const kind of Object.keys(FAILURES)) {
    assert.throws(() => withFailure(kind, ws, () => T.decide(ws, pid, { receipt_id: rid, action: 'pass', by: 'eric' })), WORDS[kind], `${kind}: the held pass is refused`);
    assert.throws(() => withFailure(kind, ws, () => T.decide(ws, pid, { receipt_id: rid, action: 'watch', by: 'eric' })), WORDS[kind], `${kind}: a watch is refused`);
    assert.equal(decisionsOf(ws, pid).length, 0, `${kind}: nothing written`);
    assert.deepEqual(basisFiles(ws, pid), []);
    assert.notEqual(projects.getProject(ws, pid).status, 'archived', `${kind}: the held project is not archived`);
    assert.equal(MA.automationGate(ws, pid).project_stopped, false, `${kind}: nothing is stopped`);
  }
  const held = T.decide(ws, pid, { receipt_id: rid, action: 'pass', by: 'eric' });
  assert.equal(held.result.decision.archive, 'kept: held');
  assert.equal(held.result.basis.state, 'frozen');
  // The record itself refuses every decision that is not a stop.
  const base = { decision_id: 'td_00000000000000', project_id: pid, receipt_id: rid, decided_at: new Date().toISOString(), decided_by: 'eric' };
  for (const d of [{ action: 'approve' }, { action: 'halve' }, { action: 'watch' }, { action: 'trim' }, { action: 'reopen' }, { action: 'pass', archive: 'kept: held' }, { action: 'veto', decided_by: 'mandate:cr-paper-mandate@1' }]) {
    assert.throws(() => DB.unavailableBasis({ decision: { ...base, ...d }, error: new Error('x') }), (e) => e.code === 'INVALID', JSON.stringify(d));
    assert.equal(DB.stopsProject({ ...base, ...d }), false, JSON.stringify(d));
  }
  for (const d of [{ action: 'veto' }, { action: 'undo' }, { action: 'pass', archive: 'archived' }]) assert.equal(DB.stopsProject({ ...base, ...d }), true, JSON.stringify(d));
});
