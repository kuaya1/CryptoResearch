'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tempWorkspace, addFixtureProject, importAllFixtures } = require('./helpers');
const { loadReports } = require('../core/reports');
const { compareProject } = require('../core/compare');
const notes = require('../core/notes');

function compare(ws) {
  return compareProject(ws, loadReports(ws, 'example-payfi-fictional'));
}

test('three compatible fixture reports compare side by side with correct grades and spreads', (t) => {
  const { ws, cleanup } = tempWorkspace('cmp');
  t.after(cleanup);
  addFixtureProject(ws);
  importAllFixtures(ws);
  const c = compare(ws);
  assert.deepEqual(new Set(c.comparability.comparable_providers), new Set(['claude', 'chatgpt', 'gemini']));
  assert.equal(c.grades.claude.grade.display, '60.5');
  assert.equal(c.grades.claude.model_total.status, 'match');
  assert.equal(c.grades.chatgpt.grade.display, '67.0');
  assert.equal(c.grades.chatgpt.model_total.status, 'mismatch');
  assert.equal(c.grades.gemini.grade.status, 'withheld');
  assert.equal(c.grades.gemini.grade.coverage_pct, 90);
  const tvcDiag = c.rows.find((r) => r.section === 'diagnostic' && r.id === 'token_value_capture');
  assert.equal(tvcDiag.spread, 42);
  assert.equal(tvcDiag.spread_flag, true);
  const tvcComp = c.rows.find((r) => r.section === 'component' && r.id === 'token_value_capture');
  assert.equal(tvcComp.spread, 35);
  // Gemini's 55-65 range counts with its bounds: 70 - 55 = 15.
  assert.equal(c.rows.find((r) => r.id === 'builder_operations').spread, 15);
  // Median is descriptive and uses single scores only.
  assert.equal(c.rows.find((r) => r.id === 'legitimacy').median, 72);
  // Risk rows keep the risk direction.
  for (const r of c.rows.filter((x) => x.section === 'risk')) assert.equal(r.direction, 'higher_is_more_risk');
});

test('conflicting numbers are told apart from numbers measured over different periods', (t) => {
  const { ws, cleanup } = tempWorkspace('conflict');
  t.after(cleanup);
  addFixtureProject(ws);
  importAllFixtures(ws);
  const c = compare(ws);
  const rev = c.claim_conflicts.find((m) => m.metric_id === 'protocol_revenue_usd');
  assert.equal(rev.pairs[0].kind, 'contradiction');
  const vol = c.claim_conflicts.find((m) => m.metric_id === 'payment_volume_usd');
  const kinds = vol.pairs.map((p) => p.kind).sort();
  assert.deepEqual(kinds, ['agreement_shared_source', 'different_period', 'different_period']);
  assert.ok(c.shared_sources.shared.some((s) => s.providers.length === 3), 'source cited by all three is flagged');
  assert.ok(c.resolving_questions.some((q) => q.source === 'conflict'));
  assert.ok(c.resolving_questions.some((q) => q.topic === 'diagnostic:token_value_capture'));
});

test('a report with a different sector profile or horizon is not compared', (t) => {
  const { ws, cleanup } = tempWorkspace('incompat');
  t.after(cleanup);
  addFixtureProject(ws);
  importAllFixtures(ws);
  const gem = loadReports(ws, 'example-payfi-fictional').find((r) => r.meta.provider === 'gemini');
  notes.addCorrection(ws, 'example-payfi-fictional', gem.report_id, 'sector_profile', 'general-token@1', 'test: different profile');
  let c = compare(ws);
  assert.deepEqual(new Set(c.comparability.comparable_providers), new Set(['claude', 'chatgpt']));
  assert.match(c.comparability.excluded.gemini, /profile/);
  // Gemini's token value capture of 30 no longer feeds the spread.
  assert.equal(c.rows.find((r) => r.section === 'diagnostic' && r.id === 'token_value_capture').spread, 22);
  const gpt = loadReports(ws, 'example-payfi-fictional').find((r) => r.meta.provider === 'chatgpt');
  notes.addCorrection(ws, 'example-payfi-fictional', gpt.report_id, 'horizon', '12 months', 'test: different horizon');
  c = compare(ws);
  assert.equal(c.comparability.comparable, false);
  assert.ok(c.rows.every((r) => r.spread === null), 'no spreads when nothing is comparable');
  assert.ok(c.rows.every((r) => r.median === null));
});

test('reports analyzed too far apart are not compared', (t) => {
  const { ws, cleanup } = tempWorkspace('window');
  t.after(cleanup);
  addFixtureProject(ws);
  importAllFixtures(ws);
  const claude = loadReports(ws, 'example-payfi-fictional').find((r) => r.meta.provider === 'claude');
  notes.addCorrection(ws, 'example-payfi-fictional', claude.report_id, 'analysis_at', '2026-05-01', 'test: old analysis');
  const c = compare(ws);
  assert.ok(!c.comparability.comparable_providers.includes('claude'));
  assert.match(c.comparability.excluded.claude, /days/);
});
