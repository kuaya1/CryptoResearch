'use strict';
// N1 (post-remediation audit, 2026-11-02): the decision-basis digest ledger
// (projects/<id>/tickets/basis-digests.jsonl, audit F3) is an integrity
// record about the decision; it never decides whether the decision commits.
// A ledger that cannot be read while Eric's veto, Undo or archiving pass is
// staged must not abort it: the decision line commits, the project stops, an
// Undo still cancels the resting buy, and the basis record says in its own
// words that its digest could not be recorded (read back as unverified, never
// as verified). The ledger itself is left exactly as it was: it cannot be
// appended to without its prior bytes. A grant, a mandate line, a watch, a
// trim and a re-open still commit only with their digest line.
// The failure is injected where the decision really reads the ledger:
// fs.readFileSync on basis-digests.jsonl, as a disk would fail (EIO).
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
const { deskWith, settle, bar, mine, answer, H, iso } = require('./trader-fixture');
const { tempWorkspace, addFixtureProject, importAllFixtures } = require('./helpers');

const LEDGER_RE = /[\\/]tickets[\\/]basis-digests\.jsonl$/;
const decisionsOf = (ws, pid) => {
  const abs = ws.abs(`projects/${pid}/tickets/decisions.jsonl`);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').split('\n').filter(Boolean) : [];
};
const ledgerBytes = (ws, pid) => fs.readFileSync(ws.abs(DB.digestRel(pid)));
const recordOf = (ws, pid, d) => JSON.parse(fs.readFileSync(ws.abs(DB.basisRel(pid, d.decision_id)), 'utf8'));

// Every read of the digest ledger fails as a disk would, until restored.
function ledgerEio(fn) {
  const real = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (p) {
    if (LEDGER_RE.test(String(p))) { reads += 1; throw Object.assign(new Error('FICTIONAL EIO reading the digest ledger'), { code: 'EIO' }); }
    return real.apply(this, arguments);
  };
  try { return { out: fn(), reads: () => reads }; } finally { fs.readFileSync = real; }
}

// A funded book with sixteen closed hours and Eric's live approve: its buy
// reserved and acknowledged, and its digest on the ledger.
function liveGrant(t) {
  const s = deskWith(t);
  const { ws, pid, rid } = s;
  settle(ws);
  const now0 = Date.now();
  const top = Math.floor(now0 / H) * H;
  TD.applyHours(ws, Array.from({ length: 16 }, (_, i) => bar(top - (16 - i) * H)), { now: iso(now0) });
  const ap = T.decide(ws, pid, { receipt_id: rid, action: 'approve', by: 'eric', request_id: 'req_n1_approve01' });
  assert.equal(ap.result.status, 'saved');
  const approve = ap.result.decision;
  const buy = PT.intents(ws).find((i) => i.intent_id === TD.intentIdOf(approve, 'open'));
  assert.equal(buy.state, 'ACKED', 'a live buy is resting');
  assert.equal(MA.automationGate(ws, pid).project_stopped, false, 'a grant stops nothing');
  assert.equal(DB.ledgerOf(ws, pid).entries.size, 1, 'the approve\'s digest is on the ledger');
  return { ...s, approve };
}

// The record says its digest could not be recorded, in the failure's words,
// and carries no ledger declaration; its views read it as unverified.
function assertUnrecorded(ws, pid, d, rec) {
  assert.ok(!('digest_ledger' in rec), 'it declares no ledger line it does not have');
  assert.equal(rec.digest_unrecorded.code, 'EIO');
  assert.match(rec.digest_unrecorded.words, /FICTIONAL EIO reading the digest ledger/);
  assert.deepEqual(DB.identityProblems(rec, d), [], 'it holds the identity contract');
  assert.equal(DB.ledgerOf(ws, pid).entries.has(d.decision_id), false, 'no digest line is invented for it');
  const v = DB.viewOf(ws, pid, d.decision_id);
  assert.notEqual(v.label, 'decision_time', 'never read as verified decision-time history');
  assert.notEqual(v.digest, 'verified');
  assert.match(v.words, /digest ledger could not be read/);
  assert.match(v.words, /FICTIONAL EIO/);
  assert.equal(v.ledger_failure.code, 'EIO');
  const st = DB.stateOf(ws, pid, d);
  assert.notEqual(st.state, 'frozen');
  assert.match(st.words, /digest ledger could not be read/);
  return v;
}

test('N1: Undo of a live grant commits, cancels the buy and stops the project when the digest ledger does not read (EIO)', (t) => {
  const { ws, pid, rid, approve } = liveGrant(t);
  const lines0 = decisionsOf(ws, pid).length;
  const ledger0 = ledgerBytes(ws, pid);

  const { out, reads } = ledgerEio(() => T.decide(ws, pid, { receipt_id: rid, action: 'undo', by: 'eric', request_id: 'req_n1_undo01' }));
  assert.ok(reads() >= 1, 'the decision did read the ledger, and the read failed');
  assert.equal(out.result.status, 'saved', 'the Undo is recorded');
  assert.equal(out.verified, true, 'and read back');
  const u = out.result.decision;
  assert.deepEqual([u.action, u.undoes], ['undo', approve.decision_id]);
  assert.equal(decisionsOf(ws, pid).length, lines0 + 1, 'one decision line');

  // The risk is off: the decision's own step cancelled the resting buy.
  assert.equal(out.result.trader.status, 'ended');
  const buy = PT.intents(ws).find((i) => i.intent_id === TD.intentIdOf(approve, 'open'));
  assert.equal(buy.state, 'CANCELLED', 'the buy is cancelled');
  assert.equal(mine(TD.requests(ws), approve.decision_id).phase, 'ended');

  // The stop is in force: the one gate every automated path asks.
  const gate = MA.automationGate(ws, pid);
  assert.equal(gate.project_stopped, true);
  assert.ok(gate.autonomy.interventions.some((l) => l.id === u.decision_id && l.kind === 'undo'), 'the Undo is the latch');

  // The answer says the digest was not recorded, never that it was frozen.
  assert.equal(out.result.basis.state, 'unverified');
  assert.match(out.result.basis.words, /digest ledger could not be read.*FICTIONAL EIO/s);

  // The ledger is exactly as it was, and still reads and chains.
  assert.ok(ledgerBytes(ws, pid).equals(ledger0), 'the ledger is not rewritten without its prior bytes');
  const rec = recordOf(ws, pid, u);
  assert.equal(rec.schema_version, DB.BASIS_VERSION, 'the basis itself was built and kept');
  assertUnrecorded(ws, pid, u, rec);
  assert.equal(DB.viewOf(ws, pid, approve.decision_id).label, 'decision_time', 'the approve keeps its verified basis');

  // Replay with the ledger healthy: unchanged, nothing added or rebuilt.
  const recBytes = fs.readFileSync(ws.abs(DB.basisRel(pid, u.decision_id)));
  const intents = JSON.stringify(PT.intents(ws));
  const again = T.decide(ws, pid, { receipt_id: rid, action: 'undo', by: 'eric', request_id: 'req_n1_undo01' });
  assert.equal(again.result.status, 'unchanged');
  assert.equal(again.result.decision.decision_id, u.decision_id);
  assert.equal(again.result.basis.state, 'unverified');
  assert.equal(decisionsOf(ws, pid).length, lines0 + 1);
  assert.equal(JSON.stringify(PT.intents(ws)), intents, 'no new intent');
  assert.ok(fs.readFileSync(ws.abs(DB.basisRel(pid, u.decision_id))).equals(recBytes), 'never rebuilt');
  assert.ok(ledgerBytes(ws, pid).equals(ledger0), 'no digest is added later');

  // A replay while the ledger still fails is answered too, never thrown.
  const { out: during } = ledgerEio(() => T.decide(ws, pid, { receipt_id: rid, action: 'undo', by: 'eric', request_id: 'req_n1_undo01' }));
  assert.equal(during.result.status, 'unchanged');
});

test('N1: Eric\'s veto commits and stops the project when the digest ledger does not read (EIO); the ledger still reads and every recorded digest verifies', (t) => {
  const { ws, pid, rid, approve } = liveGrant(t);
  // The grant undone while healthy (a veto never replaces a grant in force);
  // the project is then rearmed by Eric, so the veto is what stops it.
  const w = T.decide(ws, pid, { receipt_id: rid, action: 'undo', by: 'eric', request_id: 'req_n1_undo04' });
  assert.equal(w.result.status, 'saved');
  MA.setAutonomy(ws, pid, { action: 'rearm', by: 'eric', request_id: 'req_n1_rearm01' });
  assert.equal(MA.automationGate(ws, pid).project_stopped, false, 'rearmed before the veto');
  assert.equal(DB.ledgerOf(ws, pid).entries.size, 2);
  const ledger0 = ledgerBytes(ws, pid);

  const { out, reads } = ledgerEio(() => T.decide(ws, pid, { receipt_id: rid, action: 'veto', by: 'eric', request_id: 'req_n1_veto01' }));
  assert.ok(reads() >= 1, 'the veto did read the ledger, and the read failed');
  assert.equal(out.result.status, 'saved', 'the veto is recorded');
  const v = out.result.decision;
  assert.equal(v.action, 'veto');
  const gate = MA.automationGate(ws, pid);
  assert.equal(gate.project_stopped, true, 'the veto stops the project');
  assert.ok(gate.autonomy.interventions.some((l) => l.id === v.decision_id && l.kind === 'veto'), 'the veto is the latch');
  assert.equal(out.result.basis.state, 'unverified');
  assert.ok(ledgerBytes(ws, pid).equals(ledger0), 'the ledger is not rewritten');
  assertUnrecorded(ws, pid, v, recordOf(ws, pid, v));
  for (const d of [approve, w.result.decision]) assert.equal(DB.viewOf(ws, pid, d.decision_id).digest, 'verified', `the ${d.action}'s recorded digest still verifies`);
});

test('N1: a pass that archives commits when the digest ledger does not read (EIO)', (t) => {
  // A $0 ticket on a project Eric does not hold: pass applies and archives.
  const w = tempWorkspace('n1-pass');
  t.after(w.cleanup);
  const { ws } = w;
  const pid = addFixtureProject(ws).project_id;
  importAllFixtures(ws);
  const portfolio = require('../core/portfolio');
  const real = portfolio.computePortfolio;
  portfolio.computePortfolio = (...a) => ({ ...real(...a), positions: [] });
  t.after(() => { portfolio.computePortfolio = real; });
  const tk = T.createTicket(ws, { project_id: pid, assistant: true }).ticket;
  const saved = T.saveTicket(ws, { project_id: pid, ticket_id: tk.ticket_id, text: answer(T.loadTicket(ws, pid, tk.ticket_id)) });
  assert.equal(saved.receipt.desk.suggested_risk_usd, 0, 'a $0 ticket: pass applies');
  const rid = saved.receipt_id;
  // A healthy watch first, so the ledger exists and the pass reads it.
  const watch = T.decide(ws, pid, { receipt_id: rid, action: 'watch', by: 'eric', request_id: 'req_n1_watch02' });
  assert.equal(watch.result.status, 'saved');
  const ledger0 = ledgerBytes(ws, pid);

  const { out, reads } = ledgerEio(() => T.decide(ws, pid, { receipt_id: rid, action: 'pass', by: 'eric', request_id: 'req_n1_pass01' }));
  assert.ok(reads() >= 1, 'the pass did read the ledger, and the read failed');
  assert.equal(out.result.status, 'saved');
  const p = out.result.decision;
  assert.equal(p.archive, 'archived');
  assert.equal(out.result.project_archived, true, 'the project is archived');
  assert.equal(require('../core/projects').getProject(ws, pid).status, 'archived');
  assert.equal(MA.automationGate(ws, pid).project_stopped, true);
  assert.ok(ledgerBytes(ws, pid).equals(ledger0), 'the ledger is not rewritten');
  assertUnrecorded(ws, pid, p, recordOf(ws, pid, p));
});

test('N1: a grant still commits only with its digest: approve is refused and writes nothing when the digest ledger does not read', (t) => {
  const { ws, pid, rid } = liveGrant(t);
  T.decide(ws, pid, { receipt_id: rid, action: 'undo', by: 'eric', request_id: 'req_n1_undo03' });
  const lines0 = decisionsOf(ws, pid).length;
  const ledger0 = ledgerBytes(ws, pid);
  const intents = JSON.stringify(PT.intents(ws));
  assert.throws(() => ledgerEio(() => T.decide(ws, pid, { receipt_id: rid, action: 'approve', by: 'eric', request_id: 'req_n1_approve02' })), (e) => e.code === 'EIO');
  assert.equal(decisionsOf(ws, pid).length, lines0, 'no decision line');
  assert.ok(ledgerBytes(ws, pid).equals(ledger0), 'the ledger is unchanged');
  assert.equal(JSON.stringify(PT.intents(ws)), intents, 'no order');
});

test('N1: a record claiming its digest went unrecorded is refused for anything but one of Eric\'s stops', (t) => {
  const { ws, pid, approve } = liveGrant(t);
  // Take the approve's digest line off (it is the ledger's last, so the chain
  // still reads) and dress its record as one whose digest went unrecorded.
  const ledgerAbs = ws.abs(DB.digestRel(pid));
  fs.writeFileSync(ledgerAbs, '');
  const abs = ws.abs(DB.basisRel(pid, approve.decision_id));
  const { digest_ledger, ...rest } = JSON.parse(fs.readFileSync(abs, 'utf8'));
  assert.ok(digest_ledger);
  fs.writeFileSync(abs, `${JSON.stringify({ ...rest, digest_unrecorded: { code: 'EIO', words: 'FICTIONAL forged' } }, null, 2)}\n`);
  assert.throws(() => DB.viewOf(ws, pid, approve.decision_id), (e) => e.code === 'INTEGRITY' && /digest_unrecorded/.test(e.message));
  assert.equal(DB.stateOf(ws, pid, approve).state, 'integrity');
  assert.ok(DB.identityProblems(JSON.parse(fs.readFileSync(abs, 'utf8')), approve).includes('digest_unrecorded (only a stop is recorded without its digest)'));
});
