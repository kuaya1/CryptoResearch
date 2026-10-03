'use strict';
// Parser tolerance: the reasonable variants of the cr.report.v1 block that
// models actually write (trailing commas, comments, raw line breaks, keys in
// other cases or as label text, scores written as text, a list instead of an
// object, a nested report, prose answering a research run) are read when their
// meaning is clear. Where it is not (an honest unknown, an unjustified range, a
// 10-point score, a whole 0-10 scale) the grade is still withheld. Every
// original is stored byte for byte. All reports here are FICTIONAL.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tempWorkspace, addFixtureProject, FIXTURES } = require('./helpers');
const inbox = require('../core/inbox');
const research = require('../core/research');
const { loadReports, findReportJson } = require('../core/reports');
const { gradeAssessment } = require('../core/rubrics');

const PID = 'example-payfi-fictional';
const FIXTURE = fs.readFileSync(path.join(FIXTURES, 'reports', `${PID}__claude.md`), 'utf8');
const FENCE_AT = FIXTURE.indexOf('```json');
// The fixture's prose (no scores of its own) and its JSON block, kept apart so
// each test can rewrite the block. Its components grade to 60.5.
const PROSE = FIXTURE.slice(0, FENCE_AT);
const BASE = JSON.parse(FIXTURE.slice(FENCE_AT + 7, FIXTURE.indexOf('\n```', FENCE_AT + 7)));
const BASE_GRADE = 60.5;
const TEN_SCALE = 'Scores look like a 0-10 scale; this desk grades on 1-100, so they were not used';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const clone = () => JSON.parse(JSON.stringify(BASE));
const block = (json) => (typeof json === 'string' ? json : JSON.stringify(json, null, 2));
const report = (json, prose = PROSE) => `${prose}\`\`\`json\n${block(json)}\n\`\`\`\n`;

function workspace(t, label) {
  const { ws, cleanup } = tempWorkspace(label);
  t.after(cleanup);
  addFixtureProject(ws);
  return ws;
}

// Imports one text as Claude's report, checks the original is stored byte for
// byte, and returns the stored assessment, its extraction issues and its grade.
function importOne(ws, text, opts = {}) {
  const out = inbox.importContent(ws, 'claude', { content: text, projectId: PID, ...opts });
  assert.equal(out.result.status, 'ingested', out.result.message);
  const rep = loadReports(ws, PID).find((r) => r.report_id === out.result.report_id);
  const original = fs.readFileSync(ws.abs(`${rep.dir}/${rep.meta.original_file}`));
  assert.equal(sha(original), sha(Buffer.from(text, 'utf8')), 'original stored byte for byte');
  const issues = rep.record.extraction.issues;
  return { a: rep.assessment, issues, has: (re) => issues.some((i) => re.test(i.message)), grade: gradeAssessment(ws, rep.assessment) };
}

test('trailing commas, comments and raw line breaks in a rationale are repaired, flagged and graded', (t) => {
  const ws = workspace(t, 'tol-repair');
  const j = clone();
  j.investment_components.sustainable_business_demand.rationale = 'Fictional: first line.@NL@Second line.@TAB@Indented.';
  const text = block(j)
    .replace('@NL@', '\n')
    .replace('@TAB@', '\t')
    .replace('"investment_components": {', '"investment_components": { // scored on 1-100')
    .replace(/("timing_executable_liquidity": \{[^}]*\})/, '$1,')
    .replace('"risk_scores": {', '/* risk panel */ "risk_scores": {')
    .replace(/\n\}\s*$/, ',\n}');
  assert.throws(() => JSON.parse(text), 'the variant is not plain JSON');
  const r = importOne(ws, report(text));
  assert.equal(r.a.source_format, 'appendix_json');
  assert.ok(r.has(/needed repair \(trailing commas \/ comments \/ raw line breaks in text\)/));
  assert.equal(r.a.investment_components.sustainable_business_demand.rationale, 'Fictional: first line.\nSecond line.\tIndented.', 'string text kept, only escaped');
  assert.equal(r.a.sources[0].url, 'https://example.com/xmpl/docs', '// inside a string is not a comment');
  assert.equal(r.grade.status, 'firm');
  assert.equal(r.grade.value, BASE_GRADE);
  assert.equal(r.a.risk_scores.dilution.value, 65);
});

test('a block that repair cannot fix is not guessed at', () => {
  const unclosed = findReportJson(report('{ "schema_version": "cr.report.v1", /* never closed "verdict": null }'));
  assert.equal(unclosed.obj, null);
  const unquoted = findReportJson(report('{ "schema_version": "cr.report.v1", verdict: null }'));
  assert.equal(unquoted.obj, null);
  assert.match(unquoted.parseErrors[0], /^JSON block at line \d+: /);
});

test('scores without a status, with the status in another case, as text, or as "score" are read', (t) => {
  const ws = workspace(t, 'tol-score');
  const j = clone();
  const c = j.investment_components;
  c.sustainable_business_demand = { value: 70, rationale: 'Fictional.' };
  c.token_value_capture = { status: 'Scored', value: '55', rationale: 'Fictional.' };
  c.valuation_supply = { status: ' scored ', value: '60/100', rationale: 'Fictional.' };
  c.risk_resilience = { status: 'SCORED', score: 65, rationale: 'Fictional.' };
  c.btc_relative_asymmetry = { status: 'scored', value: '50.0', rationale: 'Fictional.' };
  c.timing_executable_liquidity = { score: '60', rationale: 'Fictional.' };
  const r = importOne(ws, report(j));
  assert.equal(r.grade.status, 'firm', JSON.stringify(r.grade.missing));
  assert.equal(r.grade.value, BASE_GRADE);
  assert.ok(r.has(/status missing; read as a single score/));
  assert.ok(r.has(/"score" read as the value/));
  assert.ok(r.has(/"60\/100" given as text; read as 60/));
  assert.equal(r.a.investment_components.token_value_capture.status, 'scored');
});

test('component, risk and diagnostic keys in other cases or as label text are mapped to the rubric ids', (t) => {
  const ws = workspace(t, 'tol-keys');
  const j = clone();
  const c = j.investment_components;
  j.investment_components = {
    'Sustainable Business Demand': c.sustainable_business_demand,
    tokenValueCapture: c.token_value_capture,
    'valuation-supply': c.valuation_supply,
    'Risk resilience (15%)': c.risk_resilience,
    'BTC-relative asymmetry': c.btc_relative_asymmetry,
    'Timing and executable liquidity': c.timing_executable_liquidity,
  };
  const rk = j.risk_scores;
  j.risk_scores = { 'Credit risk': rk.credit, Dilution: rk.dilution, 'Liquidity Risk': rk.liquidity, 'Overall downside risk': rk.overall_downside };
  const d = j.diagnostic_scores;
  j.diagnostic_scores = { ...d, 'Builder and operational quality': d.builder_operations, 'Competitive Differentiation': d.differentiation };
  delete j.diagnostic_scores.builder_operations;
  delete j.diagnostic_scores.differentiation;
  j.investment_components['Not A Rubric Component'] = { status: 'scored', value: 90, rationale: 'Fictional.' };
  const r = importOne(ws, report(j));
  assert.equal(r.grade.status, 'firm', JSON.stringify(r.grade.missing));
  assert.equal(r.grade.value, BASE_GRADE);
  assert.ok(r.has(/^investment_components: key 'Sustainable Business Demand' read as sustainable_business_demand$/));
  assert.ok(r.has(/key 'Timing and executable liquidity' read as timing_executable_liquidity/));
  assert.deepEqual([r.a.risk_scores.credit.value, r.a.risk_scores.liquidity.value, r.a.risk_scores.overall_downside.value], [55, 50, 58]);
  assert.equal(r.a.diagnostic_scores.builder_operations.value, 68);
  assert.equal(r.a.diagnostic_scores.differentiation.value, 62);
  assert.ok(r.issues.some((i) => i.field === 'investment_components.Not A Rubric Component' && /Not a component/.test(i.message)), 'an unknown key keeps today\'s behavior');
});

test('two keys for one component with different scores are not chosen between', (t) => {
  const ws = workspace(t, 'tol-dupkey');
  const j = clone();
  const c = j.investment_components;
  j.investment_components = { ...c, 'Token Value Capture': c.token_value_capture, 'token value capture': { ...c.token_value_capture, value: 80 } };
  delete j.investment_components.token_value_capture;
  const r = importOne(ws, report(j));
  assert.equal(r.a.investment_components.token_value_capture.status, 'unknown');
  assert.ok(r.has(/give different scores; none was used/));
  assert.equal(r.grade.status, 'withheld');
});

test('components given as a list of {id, ...} are read as the object form', (t) => {
  const ws = workspace(t, 'tol-list');
  const j = clone();
  const c = j.investment_components;
  j.investment_components = [
    { id: 'sustainable_business_demand', ...c.sustainable_business_demand },
    { key: 'token_value_capture', ...c.token_value_capture },
    { name: 'Valuation and supply', ...c.valuation_supply },
    { id: 'risk_resilience', ...c.risk_resilience },
    { id: 'btc_relative_asymmetry', ...c.btc_relative_asymmetry },
    { name: 'Timing and executable liquidity', ...c.timing_executable_liquidity },
  ];
  j.risk_scores = Object.entries(j.risk_scores).map(([id, s]) => ({ id, ...s }));
  const r = importOne(ws, report(j));
  assert.equal(r.grade.status, 'firm', JSON.stringify(r.grade.missing));
  assert.equal(r.grade.value, BASE_GRADE);
  assert.ok(r.has(/given as a list of \{id, \.\.\.\}; read as the object form/));
  assert.equal(r.a.risk_scores.dilution.value, 65);
});

test('a report nested one level under another key is unwrapped; a brace in a string does not end an unfenced search', (t) => {
  const ws = workspace(t, 'tol-nest');
  const nested = importOne(ws, report({ report: clone() }));
  assert.ok(nested.has(/nested under "report"/));
  assert.equal(nested.grade.value, BASE_GRADE);
  // An envelope that repeats schema_version but holds no scores of its own.
  const inner = clone();
  inner.summary = 'FICTIONAL envelope variant.';
  const envelope = importOne(ws, report({ schema_version: 'cr.report.v1', answer: inner }));
  assert.ok(envelope.has(/nested under "answer"/));
  assert.equal(envelope.a.rubric_version, 'cr-grading@1');
  assert.equal(envelope.grade.value, BASE_GRADE);
  // Unfenced, with a "{" in a string before schema_version and a "}" in one
  // after it: the last brace before "cr.report.v1" starts a candidate mid-string
  // that balances and fails to parse. Earlier braces are still tried.
  const j = { note: 'Fictional text {', schema_version: 'cr.report.v1', tag: 'closing } in text', ...clone() };
  j.summary = 'FICTIONAL unfenced variant.';
  const unfenced = importOne(ws, `${PROSE}\n${JSON.stringify(j, null, 2)}\n`);
  assert.equal(unfenced.a.source_format, 'appendix_json_unfenced');
  assert.equal(unfenced.grade.value, BASE_GRADE);
});

// A prose answer with a full component table and labeled risk scores.
function proseAnswer(extra = '') {
  return [
    '# Example PayFi (FICTIONAL): prose answer',
    '',
    '> FICTIONAL test text standing in for a model answer that has no JSON block. Every number is invented for an automated test and says nothing about any real project.',
    '',
    'Analysis date: 2026-09-30',
    '',
    '## Investment grade components',
    '',
    '| Component | Score |',
    '|---|---|',
    '| Sustainable business demand | 70 |',
    '| Token value capture | 55 |',
    '| Valuation and supply | 60 |',
    '| Risk resilience | 65 |',
    '| BTC-relative asymmetry | 50 |',
    '| Timing and executable liquidity | 60 |',
    '',
    '## Downside risk',
    '',
    '- Dilution risk: 65',
    '- Liquidity risk: 50',
    '',
    'Verdict: CONDITIONAL OPPORTUNITY',
    '',
    extra,
  ].join('\n');
}

test('prose saved against a research run is graded under the run\'s rubric and profile; without a run it is withheld', (t) => {
  const ws = workspace(t, 'tol-prose');
  const run = research.createRun(ws, { project_id: PID, providers: ['claude'] }).run;
  const r = importOne(ws, proseAnswer(), { runId: run.run_id });
  assert.equal(r.a.source_format, 'prose');
  assert.equal(r.a.rubric_version, run.rubric_version);
  assert.equal(r.a.sector_profile, run.sector_profile);
  assert.equal(r.a.prompt_version, run.prompt.version);
  assert.equal(r.a.horizon, run.horizon.text);
  assert.deepEqual(r.a.fields_from_run, ['sector_profile', 'rubric_version', 'prompt_version', 'horizon']);
  assert.ok(r.issues.some((i) => i.field === 'research_run' && i.message.includes(run.run_id)));
  assert.equal(r.grade.status, 'firm', r.grade.reason);
  assert.equal(r.grade.value, BASE_GRADE);
  // The same kind of answer pasted with no run keeps today's rule.
  const loose = importOne(ws, proseAnswer('Pasted without a run.'));
  assert.equal(loose.a.rubric_version, null);
  assert.equal(loose.a.fields_from_run, undefined);
  assert.equal(loose.grade.status, 'withheld');
  assert.match(loose.grade.reason, /does not declare a rubric version/);
});

test('what a report states itself is never replaced by its run\'s values', (t) => {
  const ws = workspace(t, 'tol-own');
  const run = research.createRun(ws, { project_id: PID, providers: ['claude'] }).run;
  const r = importOne(ws, report(clone()), { runId: run.run_id });
  assert.equal(r.a.horizon, '24 months', 'the report\'s own horizon');
  assert.equal(r.a.prompt_version, 'cr-research-prompt@1');
  assert.equal(r.a.fields_from_run, undefined);
  assert.ok(!r.issues.some((i) => i.field === 'research_run'));
});

test('an unreadable JSON block says so; against a run its prose is read under the run\'s rubric', (t) => {
  const ws = workspace(t, 'tol-unread');
  const run = research.createRun(ws, { project_id: PID, providers: ['claude'] }).run;
  const broken = '{ "schema_version": "cr.report.v1", verdict: "CONDITIONAL OPPORTUNITY" }';
  const r = importOne(ws, report(broken, proseAnswer()), { runId: run.run_id });
  assert.equal(r.a.source_format, 'prose');
  assert.ok(r.issues.some((i) => i.severity === 'error' && i.field === 'json' && /^A JSON block was found but could not be read: JSON block at line \d+: /.test(i.message)));
  assert.equal(r.a.rubric_version, run.rubric_version);
  assert.equal(r.grade.status, 'firm', r.grade.reason);
  assert.equal(r.grade.value, BASE_GRADE);
  const loose = importOne(ws, report(broken, proseAnswer('No run.')));
  assert.ok(loose.has(/^A JSON block was found but could not be read: /));
  assert.equal(loose.grade.status, 'withheld');
});

test('an honest unknown, an unjustified range or a 10-point score still withholds; a justified range gives a range', (t) => {
  const ws = workspace(t, 'tol-withhold');
  const variant = (id, score) => {
    const j = clone();
    j.investment_components[id] = score;
    j.summary = `FICTIONAL variant: ${JSON.stringify(score)}`;
    return importOne(ws, report(j));
  };
  const unknown = variant('btc_relative_asymmetry', { status: 'unknown', value: null, missing_data: 'Fictional: no BTC-relative data.' });
  assert.equal(unknown.grade.status, 'withheld');
  assert.equal(unknown.grade.coverage_pct, 90, 'not renormalized');
  const bareRange = variant('valuation_supply', { status: 'range', low: 55, high: 65 });
  assert.equal(bareRange.grade.status, 'withheld');
  const noStatusRange = variant('valuation_supply', { low: 55, high: 65 });
  assert.equal(noStatusRange.a.investment_components.valuation_supply.status, 'range');
  assert.equal(noStatusRange.grade.status, 'withheld', 'a range without rationale is not justified');
  const textRange = variant('valuation_supply', { status: 'range', value: '55–65', rationale: 'Fictional: thin data.' });
  assert.equal(textRange.grade.status, 'range');
  assert.deepEqual([textRange.grade.low, textRange.grade.high], [59.5, 61.5]);
  const tenPoint = variant('token_value_capture', { status: 'scored', value: '7/10', rationale: 'Fictional.' });
  assert.equal(tenPoint.grade.status, 'withheld');
  assert.equal(tenPoint.a.investment_components.token_value_capture.status, 'unknown');
  assert.equal(tenPoint.a.investment_components.token_value_capture.invalid_source.value, '7/10');
  assert.ok(tenPoint.has(/10-point scale/));
  const tenNoStatus = variant('token_value_capture', { value: '7 / 10', rationale: 'Fictional.' });
  assert.equal(tenNoStatus.grade.status, 'withheld');
});

test('six components on a 0-10 scale are not graded as 7/100; risk scores on a 0-10 scale are set aside too', (t) => {
  const ws = workspace(t, 'tol-ten');
  const j = clone();
  for (const id of Object.keys(j.investment_components)) j.investment_components[id].value = 7;
  const r = importOne(ws, report(j));
  assert.equal(r.grade.status, 'withheld');
  for (const s of Object.values(r.a.investment_components)) {
    assert.equal(s.status, 'unknown');
    assert.equal(s.missing_data, TEN_SCALE);
    assert.equal(s.invalid_source.value, 7, 'the original is kept');
  }
  assert.ok(r.issues.some((i) => i.severity === 'error' && i.field === 'investment_components' && i.message.startsWith(TEN_SCALE)));
  // One fractional score at 10 or below is set aside on its own.
  const f = clone();
  f.investment_components.risk_resilience.value = 6.5;
  const frac = importOne(ws, report(f));
  assert.equal(frac.grade.status, 'withheld');
  assert.equal(frac.a.investment_components.risk_resilience.missing_data, TEN_SCALE);
  assert.equal(frac.a.investment_components.token_value_capture.value, 55, 'the others are untouched');
  // One honest low whole score is a score.
  const low = clone();
  low.investment_components.btc_relative_asymmetry.value = 8;
  const honest = importOne(ws, report(low));
  assert.equal(honest.grade.status, 'firm');
  assert.equal(honest.grade.value, 56.3);
  // Risk scores never feed the grade, but are not shown as 6/100 either.
  const rk = clone();
  for (const id of Object.keys(rk.risk_scores)) rk.risk_scores[id].value = 6;
  const risk = importOne(ws, report(rk));
  assert.equal(risk.grade.value, BASE_GRADE);
  assert.ok(Object.values(risk.a.risk_scores).every((s) => s.status === 'unknown' && s.missing_data === TEN_SCALE));
  assert.ok(risk.issues.some((i) => i.severity === 'error' && i.field === 'risk_scores'));
});
