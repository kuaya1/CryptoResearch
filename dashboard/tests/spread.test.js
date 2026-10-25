'use strict';
// Spread alerts (core/spread.js, backlog item 28): Claude against ChatGPT or
// Gemini at Eric's grade threshold (15), Claude's grade against the
// Prosecutor's conviction (20), firm grades under one rubric only, the widest
// category only under one rubric and profile. Nothing averaged, nothing
// stored. FICTIONAL reports built in memory; the grade is stubbed from the
// assessment.

const test = require('node:test');
const assert = require('node:assert/strict');
const rubrics = require('../core/rubrics');
const { spreadOf, thresholds } = require('../core/spread');

const real = rubrics.gradeAssessment;
test.beforeEach(() => { rubrics.gradeAssessment = (ws, a) => a._grade; });
test.afterEach(() => { rubrics.gradeAssessment = real; });

const firm = (v) => ({ status: 'firm', value: v, low: null, high: null, display: String(v) });
const sc = (v) => ({ status: 'scored', value: v });
function rep(provider, id, grade, over = {}) {
  return {
    report_id: id,
    meta: { provider, imported_at: '2026-10-20T10:00:00Z' },
    assessment: { analysis_at: '2026-10-20T10:00:00Z', verdict: 'WATCH', rubric_version: 'cr-grading@1', sector_profile: 'p@2', diagnostic_scores: {}, _grade: grade, ...over },
  };
}
const ws = { settings: {} };

test('a 15-point pair alerts with its widest category and a link to Compare with that category open; 14 does not', () => {
  const ds = (a, b) => ({ liquidity: sc(a), team: sc(b) });
  const hit = spreadOf(ws, 'p1', { reports: [rep('claude', 'c1', firm(70), { diagnostic_scores: ds(80, 50) }), rep('chatgpt', 'g1', firm(55), { diagnostic_scores: ds(40, 52) })] });
  assert.equal(hit.alerts.length, 1);
  const a = hit.alerts[0];
  assert.equal(a.gap, 15);
  assert.equal(a.other, 'chatgpt');
  assert.deepEqual(a.category, { id: 'liquidity', claude: 80, other: 40, gap: 40 });
  assert.equal(a.link, '#/project/p1/compare?category=liquidity');
  assert.match(a.words, /Claude 70 and ChatGPT 55 differ by 15 points/);
  assert.doesNotMatch(a.words, /average|midpoint|winner/i);
  const miss = spreadOf(ws, 'p1', { reports: [rep('claude', 'c1', firm(70)), rep('chatgpt', 'g1', firm(56))] });
  assert.equal(miss.alerts.length, 0);
});

test('Gemini counts; a profile mismatch names no category; a rubric mismatch, a range or a withheld grade is not compared', () => {
  const g = spreadOf(ws, 'p1', { reports: [rep('claude', 'c1', firm(80), { sector_profile: 'p@1', diagnostic_scores: { a: sc(10) } }), rep('gemini', 'm1', firm(60), { sector_profile: 'p@2', diagnostic_scores: { a: sc(90) } })] });
  assert.equal(g.alerts.length, 1);
  assert.equal(g.alerts[0].other, 'gemini');
  assert.equal(g.alerts[0].category, null);
  assert.match(g.alerts[0].category_note, /profile p@1 and p@2/);
  assert.equal(g.alerts[0].link, '#/project/p1/compare');
  const r = spreadOf(ws, 'p1', { reports: [rep('claude', 'c1', firm(80)), rep('chatgpt', 'g1', firm(10), { rubric_version: 'cr-grading@2' })] });
  assert.equal(r.alerts.length, 0);
  assert.match(r.not_compared[0].reason, /rubric cr-grading@1 \(Claude\) and cr-grading@2 \(ChatGPT\)/);
  const range = { status: 'range', value: null, low: 10, high: 20, display: '10–20' };
  const rg = spreadOf(ws, 'p1', { reports: [rep('claude', 'c1', firm(80)), rep('chatgpt', 'g1', range)] });
  assert.equal(rg.alerts.length, 0);
  assert.match(rg.not_compared[0].reason, /ChatGPT's grade is a range \(10–20\)/);
  const w = spreadOf(ws, 'p1', { reports: [rep('claude', 'c1', { status: 'withheld', value: null, low: null, high: null }), rep('chatgpt', 'g1', firm(10))] });
  assert.match(w.not_compared[0].reason, /Claude's grade is withheld/);
});

test('a category scored as a range is never compared; no firm category says so', () => {
  const rangeScore = { status: 'scored', value: null, low: 20, high: 40 };
  const out = spreadOf(ws, 'p1', { reports: [rep('claude', 'c1', firm(80), { diagnostic_scores: { a: sc(90) } }), rep('chatgpt', 'g1', firm(60), { diagnostic_scores: { a: rangeScore } })] });
  assert.equal(out.alerts[0].category, null);
  assert.match(out.alerts[0].category_note, /single figure/);
});

test('a 20-point Prosecutor spread alerts; 19 does not; a range grade on the ticket is not compared', () => {
  const ticket = (conviction, display = '60', grade = 60) => ({ receipt_id: 'tr_1', prosecution: { conviction_score: conviction }, researcher: { grade, grade_display: display } });
  const reports = [rep('claude', 'c1', firm(60))];
  const hit = spreadOf(ws, 'p1', { reports, ticket: ticket(40) });
  assert.equal(hit.alerts.length, 1);
  assert.equal(hit.alerts[0].kind, 'prosecutor_spread');
  assert.equal(hit.alerts[0].gap, 20);
  assert.equal(spreadOf(ws, 'p1', { reports, ticket: ticket(41) }).alerts.length, 0);
  const rg = spreadOf(ws, 'p1', { reports, ticket: ticket(10, '55–65', 55) });
  assert.equal(rg.alerts.length, 0);
  assert.match(rg.not_compared[0].reason, /not a single figure/);
  assert.equal(spreadOf(ws, 'p1', { reports, ticket: { desk_gate: true, receipt_id: 'tr_2', prosecution: null } }).alerts.length, 0);
});

test('the thresholds are Eric\'s settings, labeled so, and bounded; an unset or invalid one falls back', () => {
  assert.deepEqual(thresholds(ws), { grade_points: 15, conviction_points: 20, basis: "Eric's choice" });
  assert.equal(thresholds({ settings: { alerts: { spread: { grade_points: 5, conviction_points: 'x' } } } }).conviction_points, 20);
  const low = spreadOf({ settings: { alerts: { spread: { grade_points: 5 } } } }, 'p1', { reports: [rep('claude', 'c1', firm(70)), rep('chatgpt', 'g1', firm(64))] });
  assert.equal(low.alerts.length, 1);
  assert.equal(low.thresholds.grade_points, 5);
});

test('the server bounds the settings', () => {
  const { validateSettingsPatch } = require('../server');
  assert.deepEqual(validateSettingsPatch({ alerts: { spread: { grade_points: 10, conviction_points: 30 } } }).alerts, { spread: { grade_points: 10, conviction_points: 30 } });
  assert.throws(() => validateSettingsPatch({ alerts: { spread: { grade_points: 0 } } }), /Grade spread alert/);
  assert.throws(() => validateSettingsPatch({ alerts: { spread: { conviction_points: 101 } } }), /Prosecutor spread alert/);
});
