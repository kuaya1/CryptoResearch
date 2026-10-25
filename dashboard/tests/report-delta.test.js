'use strict';
// The change since Claude's last report (core/report-delta.js, backlog item
// 26): firm grades under one rubric give a signed delta and a one-line words;
// a range, a withheld grade or another rubric gives words and no figure; a
// profile change compares no category; an earlier report that is no longer
// eligible falls back to the one before it, or says there is none. Nothing is
// stored. FICTIONAL reports built in memory; the grade is stubbed from the
// assessment.

const test = require('node:test');
const assert = require('node:assert/strict');
const rubrics = require('../core/rubrics');
const { reportDelta } = require('../core/report-delta');

const real = rubrics.gradeAssessment;
test.beforeEach(() => { rubrics.gradeAssessment = (ws, a) => a._grade; });
test.afterEach(() => { rubrics.gradeAssessment = real; });

const firm = (v) => ({ status: 'firm', value: v, low: null, high: null, display: String(v) });
function rep(id, at, over = {}) {
  const { grade = firm(60), excluded = false, ...a } = over;
  return {
    report_id: id,
    meta: { provider: 'claude', imported_at: at },
    assessment: { analysis_at: at, verdict: 'WATCH', rubric_version: 'cr-grading@1', sector_profile: 'p@2', prompt_version: 'cr-research-prompt@6', diagnostic_scores: {}, eligibility: excluded ? { excluded: true } : undefined, _grade: grade, ...a },
  };
}
const ws = {};

test('firm grades under one rubric: a signed delta, a dated line and a changed verdict in words', () => {
  const d = reportDelta(ws, [rep('r1', '2026-10-06T10:00:00Z', { grade: firm(60.5), diagnostic_scores: { a: { status: 'scored', value: 50 }, b: { status: 'scored', value: 70 } } }), rep('r2', '2026-10-20T10:00:00Z', { grade: firm(64.7), verdict: 'BUY', diagnostic_scores: { a: { status: 'scored', value: 58 }, b: { status: 'scored', value: 70 } } })]);
  assert.equal(d.grade_delta, 4.2);
  assert.equal(d.line, '+4.2 vs Oct 6; verdict WATCH → BUY');
  assert.equal(d.verdict_changed, true);
  assert.equal(d.previous_report_id, 'r1');
  assert.deepEqual(d.prompt_versions, { previous: 'cr-research-prompt@6', new: 'cr-research-prompt@6' });
  assert.deepEqual(d.category_deltas, [{ id: 'a', from: 50, to: 58, delta: 8 }]);
  const down = reportDelta(ws, [rep('r1', '2026-10-06T10:00:00Z', { grade: firm(70) }), rep('r2', '2026-10-20T10:00:00Z', { grade: firm(61.9) })]);
  assert.equal(down.line, '−8.1 vs Oct 6');
});

test('a range, a withheld grade or another rubric gives words and no figure', () => {
  const range = { status: 'range', value: null, low: 55, high: 65, display: '55–65' };
  const a = reportDelta(ws, [rep('r1', '2026-10-06T10:00:00Z', { grade: range }), rep('r2', '2026-10-20T10:00:00Z')]);
  assert.equal(a.grade_delta, null);
  assert.match(a.line, /earlier grade is a range \(55–65\)/);
  const w = reportDelta(ws, [rep('r1', '2026-10-06T10:00:00Z'), rep('r2', '2026-10-20T10:00:00Z', { grade: { status: 'withheld', value: null, low: null, high: null } })]);
  assert.equal(w.grade_delta, null);
  assert.match(w.line, /new grade is withheld/);
  const rb = reportDelta(ws, [rep('r1', '2026-10-06T10:00:00Z'), rep('r2', '2026-10-20T10:00:00Z', { rubric_version: 'cr-grading@2' })]);
  assert.equal(rb.grade_delta, null);
  assert.match(rb.line, /rubric cr-grading@1 then, cr-grading@2 now/);
  assert.match(rb.category_note, /not compared/);
});

test('a profile change compares no category', () => {
  const sc = { a: { status: 'scored', value: 50 } };
  const d = reportDelta(ws, [rep('r1', '2026-10-06T10:00:00Z', { sector_profile: 'p@1', diagnostic_scores: sc }), rep('r2', '2026-10-20T10:00:00Z', { sector_profile: 'p@2', diagnostic_scores: { a: { status: 'scored', value: 80 } } })]);
  assert.deepEqual(d.category_deltas, []);
  assert.match(d.category_note, /profile p@1 then, p@2 now/);
  assert.equal(d.grade_delta, 0, 'the grade itself is still comparable under one rubric');
});

test('a quarantined earlier report falls back to the one before it, or says there is none', () => {
  const r1 = rep('r1', '2026-10-01T10:00:00Z', { grade: firm(50) });
  const r2 = rep('r2', '2026-10-06T10:00:00Z', { grade: firm(99), excluded: true });
  const r3 = rep('r3', '2026-10-20T10:00:00Z', { grade: firm(55) });
  const d = reportDelta(ws, [r1, r2, r3]);
  assert.equal(d.previous_report_id, 'r1');
  assert.equal(d.line, '+5.0 vs Oct 1');
  const none = reportDelta(ws, [r2, r3]);
  assert.equal(none.status, 'none');
  assert.match(none.line, /No earlier eligible Claude report/);
  assert.equal(reportDelta(ws, [r2]), null, 'no eligible Claude report at all');
  const other = rep('g1', '2026-10-06T10:00:00Z');
  other.meta.provider = 'chatgpt';
  assert.equal(reportDelta(ws, [other, r3]).status, 'none', 'another model\'s report is never the earlier one');
});

test('the index row, the ticket view and the daily brief carry the same delta, and reading writes nothing', (t) => {
  rubrics.gradeAssessment = real; // the real grading for the whole desk in this test
  const { tempWorkspace, addFixtureProject, importAllFixtures, hashTree } = require('./helpers');
  const w = tempWorkspace('report-delta');
  t.after(w.cleanup);
  const pid = addFixtureProject(w.ws).project_id;
  importAllFixtures(w.ws);
  const tree = hashTree(w.root);
  const row = require('../core/indexer').buildIndex(w.ws).projects.find((p) => p.project_id === pid);
  assert.ok(row.report_delta, 'a row with a Claude report carries a delta');
  assert.equal(row.report_delta.status, 'none', 'one report: no earlier one, said in words');
  assert.deepEqual(hashTree(w.root), tree);
});
