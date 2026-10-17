'use strict';
// The disagreement resolution board (cr-forensic-adjudication@1): Claude's
// finding beside ChatGPT's challenge of that exact receipt, and Eric's
// judgment, append-only. Fictional workspaces only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempWorkspace, addFixtureProject, hashTree } = require('./helpers');
const F = require('../core/forensics');
const B = require('../core/forensic-disagreements');
const FX = require('./forensic-fixtures');
const { atomicWrite, jsonText } = require('../core/fsx');

// An assessment with a challenge that reviews F3 as overstated and F1 as
// supported (the fixture's challenge, FICTIONAL).
function boardSetup(label) {
  const t = tempWorkspace(label);
  const pid = addFixtureProject(t.ws).project_id;
  const a = F.createAudit(t.ws, { project_id: pid, assistant: 'claude', challenge: true });
  const s = F.saveReport(t.ws, { project_id: pid, audit_id: a.audit_id, provider: 'claude', text: FX.reportText(a.audit) });
  const c = F.saveReport(t.ws, { project_id: pid, audit_id: a.audit_id, provider: 'chatgpt', text: FX.challengeText(F.loadAudit(t.ws, pid, a.audit_id), s.receipt) });
  return { ...t, pid, a, s, c };
}

test('board: one disagreement per disputed finding, both positions as saved, what would resolve it', (t) => {
  const x = boardSetup('fb-board');
  t.after(x.cleanup);
  const before = hashTree(path.join(x.root, 'projects'));
  const v = F.view(x.ws, x.pid);
  assert.deepEqual(hashTree(path.join(x.root, 'projects')), before, 'reading the board writes nothing');
  const d = v.disagreements;
  assert.equal(d.status, 'compared');
  assert.equal(d.assessment_receipt_id, x.s.receipt_id);
  assert.equal(d.challenge_receipt_id, x.c.receipt_id);
  assert.equal(d.items.length, 1, 'F1 is supported, F3 is overstated: one disagreement');
  assert.equal(d.supported, 1);
  assert.equal(d.open, 1);
  const i = d.items[0];
  assert.equal(i.finding_id, 'F3');
  assert.match(i.disagreement_id, /^dg_[0-9a-f]{16}$/);
  const stored = F.loadReceipt(x.ws, x.pid, x.s.receipt_id).assessment.findings.find((f) => f.finding_id === 'F3');
  assert.equal(i.claude.statement, stored.statement, 'Claude\'s position is the finding as saved');
  assert.equal(i.claude.receipt_id, x.s.receipt_id);
  assert.equal(i.claude.block_sha256, x.s.receipt.block_sha256);
  assert.equal(i.challenge.verdict, 'overstated');
  assert.equal(i.challenge.receipt_id, x.c.receipt_id);
  assert.equal(i.challenge.attribution_check, 'Substance not shown.');
  assert.deepEqual(i.challenge.source_ids, ['X1']);
  assert.deepEqual(i.resolve_with.map((r) => r.text), ['A tagged audit.', 'Stub implementations.', 'Test coverage.'], 'what would resolve it, from the two reports\' own fields');
  assert.equal(i.state, 'unjudged');
  assert.equal(i.judgment, null);
});

test('board: a judgment names both receipts, is replay-safe, and changes no opinion, grade or holding', (t) => {
  const x = boardSetup('fb-judge');
  t.after(x.cleanup);
  const id = F.view(x.ws, x.pid).disagreements.items[0].disagreement_id;
  const receiptsDir = path.join(x.root, 'projects', x.pid, 'forensics', 'receipts');
  const receiptsBefore = hashTree(receiptsDir);
  const portfolioBefore = hashTree(path.join(x.root, 'portfolio'));
  const gradesBefore = JSON.stringify(F.view(x.ws, x.pid).current.category_grades);
  assert.throws(() => B.judge(x.ws, x.pid, { disagreement_id: id, judgment: 'challenge_accepted', reason: 'short' }), (e) => e.code === 'INVALID');
  assert.throws(() => B.judge(x.ws, x.pid, { disagreement_id: id, judgment: 'consensus', reason: 'Not a judgment the board knows.' }), (e) => e.code === 'INVALID');
  assert.throws(() => B.judge(x.ws, x.pid, { disagreement_id: 'dg_0000000000000000', judgment: 'unresolved', reason: 'No such disagreement on record.' }), (e) => e.code === 'NOT_FOUND');
  // Unresolved is a judgment of its own, first-class.
  const u = B.judge(x.ws, x.pid, { disagreement_id: id, judgment: 'unresolved', reason: 'Waiting for the tagged audit (FICTIONAL).', request_id: 'req-fictional-1' });
  assert.equal(u.result.status, 'saved');
  assert.equal(F.view(x.ws, x.pid).disagreements.items[0].state, 'unresolved');
  assert.equal(F.view(x.ws, x.pid).disagreements.open, 1, 'unresolved stays open');
  const j = B.judge(x.ws, x.pid, { disagreement_id: id, judgment: 'challenge_accepted', reason: 'The substance is not shown in the cited release (FICTIONAL).', request_id: 'req-fictional-2' });
  assert.equal(j.result.status, 'saved');
  const line = j.result.judgment;
  assert.equal(line.assessment.receipt_id, x.s.receipt_id);
  assert.equal(line.assessment.block_sha256, x.s.receipt.block_sha256);
  assert.equal(line.challenge.receipt_id, x.c.receipt_id);
  assert.equal(line.challenge.verdict, 'overstated');
  assert.equal(line.supersedes, u.result.judgment.judgment_id);
  assert.match(line.meaning, /not independent verification/);
  // A lost response retried, and the same judgment sent again: one line each.
  assert.equal(B.judge(x.ws, x.pid, { disagreement_id: id, judgment: 'challenge_accepted', reason: 'The substance is not shown in the cited release (FICTIONAL).', request_id: 'req-fictional-2' }).result.status, 'unchanged');
  assert.equal(B.judge(x.ws, x.pid, { disagreement_id: id, judgment: 'challenge_accepted', reason: 'The substance is not shown in the cited release (FICTIONAL).', request_id: 'req-fictional-3' }).result.status, 'unchanged');
  assert.equal(B.readJudgments(x.ws, x.pid).length, 2);
  const after = F.view(x.ws, x.pid);
  assert.equal(after.disagreements.items[0].state, 'challenge_accepted');
  assert.equal(after.disagreements.items[0].history.length, 2);
  assert.equal(after.disagreements.open, 0);
  assert.deepEqual(hashTree(receiptsDir), receiptsBefore, 'both original opinions stay as saved');
  assert.deepEqual(hashTree(path.join(x.root, 'portfolio')), portfolioBefore, 'no holding changes');
  assert.equal(JSON.stringify(after.current.category_grades), gradesBefore, 'no grade changes');
  assert.equal(after.current.findings.find((f) => f.finding_id === 'F3').statement, F.loadReceipt(x.ws, x.pid, x.s.receipt_id).assessment.findings.find((f) => f.finding_id === 'F3').statement);
  // The judgments travel in the export and a restored package, every line,
  // and the restored copy reads the same judgment.
  const X = require('../core/exporter');
  const proj = X.exportJson(x.ws).projects.find((p) => p.project.project_id === x.pid);
  assert.equal(proj.forensics.judgments.length, 2);
  const dest = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'cr-test-fb-restore-')), 'copy');
  t.after(() => fs.rmSync(path.dirname(dest), { recursive: true, force: true }));
  assert.equal(X.restorePackage(JSON.parse(JSON.stringify(X.exportPackage(x.ws))), dest).status, 'restored_and_verified');
  const copy = require('../core/workspace').openWorkspace({ root: dest, actor: 'test' });
  assert.equal(B.readJudgments(copy, x.pid).length, 2);
  assert.equal(F.view(copy, x.pid).disagreements.items[0].state, 'challenge_accepted');
});

test('board: a later revision is a new disagreement and never inherits a judgment; history browsing keeps its own', (t) => {
  const x = boardSetup('fb-revise');
  t.after(x.cleanup);
  const first = F.view(x.ws, x.pid).disagreements.items[0];
  B.judge(x.ws, x.pid, { disagreement_id: first.disagreement_id, judgment: 'challenge_rejected', reason: 'The release notes name the module (FICTIONAL).' });
  const a2 = F.createAudit(x.ws, { project_id: x.pid, assistant: 'claude', challenge: true, refresh: true });
  const s2 = F.saveReport(x.ws, { project_id: x.pid, audit_id: a2.audit_id, provider: 'claude', text: FX.reportText(a2.audit, { plain_assessment: 'FICTIONAL. A later assessment.' }) });
  F.saveReport(x.ws, { project_id: x.pid, audit_id: a2.audit_id, provider: 'chatgpt', text: FX.challengeText(F.loadAudit(x.ws, x.pid, a2.audit_id), s2.receipt) });
  const now = F.view(x.ws, x.pid).disagreements;
  assert.equal(now.assessment_receipt_id, s2.receipt_id);
  const i = now.items[0];
  assert.equal(i.finding_id, 'F3');
  assert.notEqual(i.disagreement_id, first.disagreement_id, 'another pair of receipts, another disagreement');
  assert.equal(i.state, 'unjudged', 'a later revision inherits no judgment');
  assert.equal(i.earlier.length, 1, 'the earlier judgment is history, apart');
  assert.equal(i.earlier[0].assessment_receipt_id, x.s.receipt_id);
  const old = F.view(x.ws, x.pid, { receipt: x.s.receipt_id }).disagreements;
  assert.equal(old.items[0].state, 'challenge_rejected', 'the earlier receipt keeps its own judgment');
});

test('board: a challenge that disagrees with its original is not compared, and cannot be judged', (t) => {
  const x = boardSetup('fb-tamper');
  t.after(x.cleanup);
  const id = F.view(x.ws, x.pid).disagreements.items[0].disagreement_id;
  const file = x.ws.abs(F.receiptRel(x.pid, x.c.receipt_id));
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  r.challenge.finding_reviews[1].verdict = 'unsupported';
  atomicWrite(file, jsonText(r));
  const d = F.view(x.ws, x.pid).disagreements;
  assert.equal(d.status, 'no_challenge');
  assert.equal(d.items.length, 0);
  assert.throws(() => B.judge(x.ws, x.pid, { disagreement_id: id, judgment: 'unresolved', reason: 'A tampered challenge (FICTIONAL).' }), (e) => e.code === 'NOT_FOUND');
});

test('board: without a challenge there is nothing to compare', (t) => {
  const tw = tempWorkspace('fb-none');
  t.after(tw.cleanup);
  const pid = addFixtureProject(tw.ws).project_id;
  const a = F.createAudit(tw.ws, { project_id: pid, assistant: 'claude' });
  F.saveReport(tw.ws, { project_id: pid, audit_id: a.audit_id, provider: 'claude', text: FX.reportText(a.audit) });
  const d = F.view(tw.ws, pid).disagreements;
  assert.equal(d.status, 'no_challenge');
  assert.match(d.note, /No ChatGPT challenge/);
});
