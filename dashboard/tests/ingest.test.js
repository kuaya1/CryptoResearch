'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tempWorkspace, addFixtureProject, dropFixture, dropText, FIXTURES, importAllFixtures, hashTree } = require('./helpers');
const inbox = require('../core/inbox');
const { loadReports } = require('../core/reports');
const notes = require('../core/notes');
const { buildProjectPrompt } = require('../core/prompts');
const { getProject } = require('../core/projects');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('three fixture reports import once, keep their originals byte for byte, and land in project history', (t) => {
  const { ws, root, cleanup } = tempWorkspace('ingest3');
  t.after(cleanup);
  addFixtureProject(ws);
  const res = importAllFixtures(ws);
  assert.equal(res.counts.ingested, 3, JSON.stringify(res.results));
  const reports = loadReports(ws, 'example-payfi-fictional');
  assert.equal(reports.length, 3);
  for (const r of reports) {
    const fixture = fs.readFileSync(path.join(FIXTURES, 'reports', `example-payfi-fictional__${r.meta.provider}.md`));
    const original = fs.readFileSync(path.join(root, r.dir, r.meta.original_file));
    assert.equal(sha(original), sha(fixture), 'original preserved exactly');
    assert.equal(r.meta.original_sha256, sha(fixture));
    assert.ok(fs.existsSync(path.join(root, r.dir, 'report.json')));
    assert.equal(r.assessment.provider, r.meta.provider);
  }
  for (const p of ['claude', 'chatgpt', 'gemini']) {
    const left = fs.readdirSync(path.join(root, 'inbox', p)).filter((f) => f.endsWith('.md'));
    assert.deepEqual(left, [], `inbox/${p} emptied`);
    assert.equal(fs.readdirSync(path.join(root, 'inbox', p, 'processed')).length, 1);
  }
  // Scanning again does nothing.
  const again = inbox.scanInbox(ws, { force: true });
  assert.equal(again.results.length, 0);
});

test('a duplicate import under another name is detected and not imported twice', (t) => {
  const { ws, root, cleanup } = tempWorkspace('dup');
  t.after(cleanup);
  addFixtureProject(ws);
  importAllFixtures(ws);
  dropFixture(ws, 'claude', 'example-payfi-fictional__claude.md', 'example-payfi-fictional__copy.md');
  const r = inbox.scanInbox(ws, { force: true });
  assert.equal(r.results[0].status, 'duplicate');
  assert.equal(loadReports(ws, 'example-payfi-fictional').length, 3);
  assert.ok(fs.readdirSync(path.join(root, 'inbox', 'claude', 'processed')).some((f) => f.includes('.duplicate')));
});

test('a report in the wrong provider folder is held back, never mislabeled', (t) => {
  const { ws, root, cleanup } = tempWorkspace('mismatch');
  t.after(cleanup);
  addFixtureProject(ws);
  dropFixture(ws, 'chatgpt', 'example-payfi-fictional__claude.md');
  const r = inbox.scanInbox(ws, { force: true });
  assert.equal(r.results[0].status, 'provider_mismatch');
  assert.equal(loadReports(ws, 'example-payfi-fictional').length, 0);
  assert.ok(fs.existsSync(path.join(root, 'inbox', 'chatgpt', 'example-payfi-fictional__claude.md')), 'original stays in the inbox');
  // A failed file is not retried on every scan until it changes or is retried explicitly.
  assert.equal(inbox.scanInbox(ws, { force: false }).results[0].status, 'skipped');
});

test('an analysis prompt dropped in the inbox is recognized and not imported as a report', (t) => {
  const { ws, root, cleanup } = tempWorkspace('prompt');
  t.after(cleanup);
  addFixtureProject(ws);
  const prompt = buildProjectPrompt(ws, getProject(ws, 'example-payfi-fictional'), 'claude');
  dropText(ws, 'claude', 'example-payfi-fictional__prompt.md', prompt);
  const r = inbox.scanInbox(ws, { force: true });
  assert.equal(r.results[0].status, 'prompt');
  assert.equal(loadReports(ws, 'example-payfi-fictional').length, 0);
  assert.ok(fs.existsSync(path.join(root, 'inbox', 'claude', 'example-payfi-fictional__prompt.md')));
});

test('prose reports: only labeled scores are read, ambiguity is flagged, nothing is inferred', (t) => {
  const { ws, cleanup } = tempWorkspace('prose');
  t.after(cleanup);
  addFixtureProject(ws);
  dropFixture(ws, 'claude', 'example-payfi-fictional__prose-claude.md');
  const r = inbox.scanInbox(ws, { force: true });
  assert.equal(r.results[0].status, 'ingested', JSON.stringify(r.results[0]));
  const rep = loadReports(ws, 'example-payfi-fictional')[0];
  const a = rep.assessment;
  assert.equal(a.source_format, 'prose');
  assert.equal(a.sector_profile, null, 'profile unknown for prose');
  assert.equal(a.rubric_version, null, 'rubric unknown for prose');
  assert.equal(a.diagnostic_scores.legitimacy.value, 70);
  assert.equal(a.diagnostic_scores.product_usefulness.value, 68);
  assert.deepEqual([a.diagnostic_scores.organic_demand.low, a.diagnostic_scores.organic_demand.high], [50, 60]);
  assert.equal(a.diagnostic_scores.token_value_capture.value, 45);
  assert.equal(a.diagnostic_scores.credit_risk_transparency, undefined, '7/10 is a different scale and is not converted');
  assert.ok(rep.record.extraction.ambiguous.some((x) => /10-point/.test(x.reason)));
  assert.equal(a.investment_components.sustainable_business_demand.value, 66);
  assert.equal(a.investment_components.token_value_capture.value, 48);
  assert.equal(a.investment_components.btc_relative_asymmetry.status, 'unknown', 'not inferred');
  assert.equal(a.model_reported_overall_score.value, 58);
  assert.equal(a.risk_scores.dilution.value, 70);
  assert.equal(a.risk_scores.credit.status, 'unknown');
  assert.equal(a.verdict, 'CONDITIONAL OPPORTUNITY');
  assert.equal(a.analysis_at, '2026-09-10');
  assert.equal(a.bullish_facts.length, 3);
  assert.ok(a.diagnostic_scores.legitimacy.extraction.line > 0, 'linked back to the source line');
});

test('a report that names no known project waits for assignment, then imports', (t) => {
  const { ws, cleanup } = tempWorkspace('assign');
  t.after(cleanup);
  addFixtureProject(ws);
  const text = fs.readFileSync(path.join(FIXTURES, 'reports', 'example-payfi-fictional__prose-claude.md'), 'utf8').replace(/Example PayFi Protocol \(XMPL\)/g, 'Some report');
  dropText(ws, 'claude', 'untitled.md', text);
  const r = inbox.scanInbox(ws, { force: true });
  assert.equal(r.results[0].status, 'needs_project');
  const done = inbox.assignAndRetry(ws, 'claude/untitled.md', 'example-payfi-fictional');
  assert.equal(done.status, 'ingested');
});

test('corrections create an audit file and never change the original report', (t) => {
  const { ws, root, cleanup } = tempWorkspace('correct');
  t.after(cleanup);
  addFixtureProject(ws);
  importAllFixtures(ws);
  const rep = loadReports(ws, 'example-payfi-fictional').find((r) => r.meta.provider === 'gemini');
  const before = hashTree(path.join(root, rep.dir));
  notes.addCorrection(ws, 'example-payfi-fictional', rep.report_id, 'investment_components.btc_relative_asymmetry', { status: 'scored', value: 40, rationale: 'user correction for test' }, 'test');
  const after = hashTree(path.join(root, rep.dir));
  for (const [f, h] of Object.entries(before)) assert.equal(after[f], h, `${f} unchanged`);
  assert.equal(Object.keys(after).length, Object.keys(before).length + 1);
  const updated = loadReports(ws, 'example-payfi-fictional').find((r) => r.report_id === rep.report_id);
  assert.equal(updated.assessment.investment_components.btc_relative_asymmetry.value, 40);
  assert.equal(updated.record.assessment.investment_components.btc_relative_asymmetry.status, 'unknown', 'original extraction untouched');
  assert.throws(() => notes.addCorrection(ws, 'example-payfi-fictional', rep.report_id, 'investment_components.risk_resilience', { status: 'scored', value: 500 }, 'bad'), /Invalid score/);
});

test('PDF reports are preserved and flagged as needing text', (t) => {
  const { ws, root, cleanup } = tempWorkspace('pdf');
  t.after(cleanup);
  addFixtureProject(ws);
  const bytes = Buffer.from('%PDF-1.4\n% fictional test pdf\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
  fs.writeFileSync(path.join(root, 'inbox', 'gemini', 'example-payfi-fictional__report.pdf'), bytes);
  const r = inbox.scanInbox(ws, { force: true });
  assert.equal(r.results[0].status, 'ingested');
  const rep = loadReports(ws, 'example-payfi-fictional')[0];
  assert.equal(rep.assessment.needs_text, true);
  assert.equal(sha(fs.readFileSync(path.join(root, rep.dir, 'original.pdf'))), sha(bytes));
});

test('pasted text is saved to the inbox before import, so a failed import loses nothing', (t) => {
  const { ws, root, cleanup } = tempWorkspace('paste');
  t.after(cleanup);
  const out = inbox.importContent(ws, 'claude', { content: 'too short to be a report' });
  assert.notEqual(out.result.status, 'ingested');
  assert.ok(fs.existsSync(path.join(root, 'inbox', 'claude', out.saved.filename)));
});

test('a model total that differs from the calculated grade reaches the index with its gap, for the inspector badge', (t) => {
  const { ws, cleanup } = tempWorkspace('model-total');
  t.after(cleanup);
  addFixtureProject(ws);
  const text = fs.readFileSync(path.join(FIXTURES, 'reports', 'example-payfi-fictional__claude.md'), 'utf8')
    .replace('"model_reported_overall_score": {"status": "scored", "value": 61,', '"model_reported_overall_score": {"status": "scored", "value": 99,');
  assert.ok(text.includes('"value": 99,'), 'fixture edited');
  dropText(ws, 'claude', 'example-payfi-fictional__claude.md', text);
  assert.equal(inbox.scanInbox(ws, { force: true }).results[0].status, 'ingested');
  const row = require('../core/indexer').rebuildIndex(ws).projects.find((p) => p.project_id === 'example-payfi-fictional');
  const mt = row.providers.claude.model_total;
  assert.equal(mt.status, 'mismatch');
  assert.equal(typeof mt.difference, 'number');
  assert.ok(mt.difference > 1, `a gap above the tolerance: ${mt.difference}`);
  assert.match(mt.message, new RegExp(`by ${mt.difference.toFixed(1)} points`), 'the badge and the sentence agree');
});
