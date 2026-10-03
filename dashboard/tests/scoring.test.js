'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { computeInvestmentGrade, checkModelTotal, normalizeScore, labelFor } = require('../core/scoring');
const { readJson } = require('../core/fsx');
const { DEFAULT_ROOT } = require('../core/workspace');

const grading = readJson(path.join(DEFAULT_ROOT, 'templates', 'rubrics', 'cr-grading.v1.json'));
const labels = grading.grade_labels;
const ids = grading.investment_components.map((c) => c.id);
const S = (v, rationale = 'test') => ({ status: 'scored', value: v, low: null, high: null, rationale });
function comps(values) {
  return Object.fromEntries(ids.map((id, i) => [id, typeof values[i] === 'object' ? values[i] : S(values[i])]));
}

test('weights in the shipped rubric are exactly 20/25/20/15/10/10 and total 100%', () => {
  assert.deepEqual(grading.investment_components.map((c) => c.weight_bp), [2000, 2500, 2000, 1500, 1000, 1000]);
  assert.equal(grading.investment_components.reduce((a, c) => a + c.weight_bp, 0), 10000);
});

test('fully populated grade is the weighted sum, shown to one decimal', () => {
  const g = computeInvestmentGrade(comps([70, 55, 60, 65, 50, 60]), grading, labels);
  assert.equal(g.status, 'firm');
  assert.equal(g.value, 60.5); // 14 + 13.75 + 12 + 9.75 + 5 + 6
  assert.equal(g.display, '60.5');
  assert.equal(g.label, 'D');
  assert.equal(g.coverage_pct, 100);
});

test('display truncates so the number never lands in a higher band than its label', () => {
  // 4*90 + 5*90 + 4*90 + 3*89 + 2*91 + 2*90 = 1799 units of 0.05 = 89.95
  const g = computeInvestmentGrade(comps([90, 90, 90, 89, 91, 90]), grading, labels);
  assert.equal(g.value, 89.95);
  assert.equal(g.display, '89.9');
  assert.equal(g.label, 'B');
});

test('model-reported total that conflicts with the components is flagged, never substituted', () => {
  const g = computeInvestmentGrade(comps([75, 70, 65, 60, 70, 55]), grading, labels);
  assert.equal(g.display, '67.0');
  const check = checkModelTotal(g, S(72), 1.0);
  assert.equal(check.status, 'mismatch');
  assert.equal(check.difference, 5);
  assert.equal(g.value, 67); // the app's value is unchanged
  assert.equal(checkModelTotal(g, S(67.5), 1.0).status, 'match');
});

test('any unknown or N/A component withholds the grade and shows coverage without renormalizing', () => {
  const unknown = { status: 'unknown', value: null, low: null, high: null, missing_data: 'no valuation evidence' };
  const g = computeInvestmentGrade(comps([60, 35, 50, 55, unknown, 50]), grading, labels);
  assert.equal(g.status, 'withheld');
  assert.equal(g.value, null);
  assert.equal(g.display, null);
  assert.equal(g.coverage_pct, 90);
  assert.ok(g.reason.includes('not renormalized'));
  const na = { status: 'not_applicable', value: null, rationale: 'n/a' };
  const g2 = computeInvestmentGrade(comps([na, 35, 50, 55, 60, 50]), grading, labels);
  assert.equal(g2.status, 'withheld');
  assert.equal(g2.coverage_pct, 80);
  assert.equal(checkModelTotal(g, S(70)).status, 'unverifiable');
  const missing = computeInvestmentGrade({}, grading, labels);
  assert.equal(missing.status, 'withheld');
  assert.equal(missing.coverage_pct, 0);
});

test('justified ranges give a labeled grade range; an unjustified range withholds', () => {
  const range = { status: 'range', value: null, low: 40, high: 60, rationale: 'thin data' };
  const g = computeInvestmentGrade(comps([70, range, 60, 65, 50, 60]), grading, labels);
  assert.equal(g.status, 'range');
  assert.equal(g.low, 56.75); // 14 + 10 + 12 + 9.75 + 5 + 6
  assert.equal(g.high, 61.75);
  assert.equal(g.display, '56.7–61.7');
  assert.equal(g.label, 'F–D');
  const bare = { status: 'range', value: null, low: 40, high: 60, rationale: null };
  assert.equal(computeInvestmentGrade(comps([70, bare, 60, 65, 50, 60]), grading, labels).status, 'withheld');
});

test('weights that do not total 100% refuse to calculate', () => {
  const bad = { ...grading, investment_components: grading.investment_components.map((c, i) => (i === 0 ? { ...c, weight_bp: 2100 } : c)) };
  const g = computeInvestmentGrade(comps([70, 55, 60, 65, 50, 60]), bad, labels);
  assert.equal(g.status, 'invalid_weights');
  assert.equal(g.value, null);
});

test('risk scores keep their own direction and never feed the grade', () => {
  for (const r of grading.risk_scores) assert.equal(r.direction, 'higher_is_more_risk');
  const c = comps([70, 55, 60, 65, 50, 60]);
  const a = computeInvestmentGrade(c, grading, labels);
  const withRisk = { ...c, overall_downside: S(95), credit: S(99) };
  const b = computeInvestmentGrade(withRisk, grading, labels);
  assert.equal(a.value, b.value);
  assert.ok(!grading.investment_components.some((x) => x.id === 'overall_downside'));
});

test('invalid scores never count as scores', () => {
  assert.equal(normalizeScore({ status: 'scored', value: 150 }).score.status, 'unknown');
  assert.equal(normalizeScore({ status: 'scored', value: 0 }).score.status, 'unknown');
  assert.equal(normalizeScore({ status: 'range', low: 70, high: 60, rationale: 'x' }).score.status, 'unknown');
  assert.equal(normalizeScore({ status: 'maybe', value: 50 }).score.status, 'unknown');
  assert.ok(normalizeScore({ status: 'scored', value: 150 }).score.invalid_source);
  const bare = normalizeScore(72);
  assert.equal(bare.score.status, 'scored');
  assert.equal(bare.warnings.length, 1);
});

test('score writings whose meaning is clear are read; anything beyond letter case is noted', () => {
  const read = (raw) => normalizeScore(raw, 'x');
  const scored = (raw, v) => {
    const out = read(raw);
    assert.deepEqual([out.score.status, out.score.value, out.errors], ['scored', v, []], JSON.stringify(raw));
    return out.warnings;
  };
  assert.deepEqual(scored({ status: 'Scored', value: 72, rationale: 'r' }, 72), []);
  assert.deepEqual(scored({ status: ' scored ', value: 72, rationale: 'r' }, 72), []);
  assert.match(scored({ status: 'scored', value: '72', rationale: 'r' }, 72)[0], /"72" given as text; read as 72/);
  scored({ status: 'scored', value: '72.5', rationale: 'r' }, 72.5);
  scored({ status: 'scored', value: '72/100', rationale: 'r' }, 72);
  assert.match(scored({ status: 'scored', score: 72, rationale: 'r' }, 72)[0], /"score" read as the value/);
  assert.ok(scored({ value: 72, rationale: 'r' }, 72).some((w) => /status missing; read as a single score/.test(w)));
  scored({ score: '72', rationale: 'r' }, 72);
  assert.equal(scored('72', 72).length, 2, 'text, then the bare-number note');
  const range = (raw, low, high) => {
    const out = read(raw);
    assert.deepEqual([out.score.status, out.score.low, out.score.high, out.errors], ['range', low, high, []], JSON.stringify(raw));
  };
  range({ low: 60, high: 70, rationale: 'r' }, 60, 70);
  range({ status: 'range', value: '60-70', rationale: 'r' }, 60, 70);
  range({ status: 'Range', value: '60–70', rationale: 'r' }, 60, 70);
  range({ value: '60 to 70', rationale: 'r' }, 60, 70);
  range({ status: 'range', low: '60', high: '70', rationale: 'r' }, 60, 70);
  assert.equal(read({ status: 'Not Applicable', value: null, rationale: 'r' }).score.status, 'not_applicable');
  assert.equal(read({ status: 'UNKNOWN', value: null, missing_data: 'm' }).score.status, 'unknown');
  const unknown = read({ value: null, missing_data: 'no audit published' });
  assert.deepEqual([unknown.score.status, unknown.score.missing_data, unknown.errors], ['unknown', 'no audit published', []]);
});

test('ambiguous or invalid score writings stay invalid, with the original kept', () => {
  const invalid = (raw) => {
    const out = normalizeScore(raw, 'x');
    assert.equal(out.score.status, 'unknown', JSON.stringify(raw));
    assert.ok(out.errors.length > 0, `an error for ${JSON.stringify(raw)}`);
    assert.deepEqual(out.score.invalid_source, raw);
    return out;
  };
  // A 10-point score is never converted, with or without a status.
  assert.match(invalid({ status: 'scored', value: '7/10', rationale: 'r' }).errors[0], /10-point scale/);
  invalid({ value: '7 / 10', rationale: 'r' });
  invalid({ status: 'scored', value: '7 out of 10' });
  invalid('7/10');
  invalid({ status: 'range', low: '6/10', high: '8/10', rationale: 'r' });
  // Out of scale, low above high, unknown words, and a status that contradicts the value.
  invalid({ value: 150, rationale: 'r' });
  invalid({ value: 0 });
  invalid({ low: 70, high: 60, rationale: 'r' });
  invalid({ status: 'range', value: '70-60', rationale: 'r' });
  invalid({ status: 'probably', value: 50 });
  invalid({ status: 'scored', value: '60-70', rationale: 'r' });
  invalid({ status: 'scored', value: '72%' });
  invalid({ status: 'unknown', value: '72', missing_data: 'm' });
  invalid({ rationale: 'no numbers at all' });
  invalid({ status: null, rationale: 'a null status says nothing' });
  invalid('N/A');
});

test('labels use configurable bands', () => {
  assert.equal(labelFor(90, labels), 'A');
  assert.equal(labelFor(89.99, labels), 'B');
  assert.equal(labelFor(59.9, labels), 'F');
  assert.equal(labelFor(75, [{ label: 'High', min: 70 }, { label: 'Low', min: 0 }]), 'High');
});
