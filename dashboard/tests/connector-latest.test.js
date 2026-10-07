'use strict';
// The connector (mcp.js) picks a model's current report with the desk's own
// selector (review of 2026-10-07, finding 2). Before this repair get_report,
// find_projects and start_research's "recent report" check took the newest
// saved report of any kind, so a newer quarantined or excluded answer showed
// through the connector as the model's current grade while the dashboard
// showed the older eligible one. Now the default is compare.latestByProvider
// (the watchlist's and the Brief's rule: eligible, not a PDF, newest by
// reports.js reportSortKey); an earlier or excluded report can still be read
// by its ID, with its eligibility, exclusion reason and revision status said,
// and an excluded grade is never given as a current grade.
// Fictional workspaces and reports only; no model is called.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');
const { tempWorkspace, addFixtureProject } = require('./helpers');
const { makeMcp } = require('../mcp');
const research = require('../core/research');
const inbox = require('../core/inbox');
const indexer = require('../core/indexer');
const { mockReport } = require('../core/demo');

const PID = 'example-payfi-fictional';

async function call(ws, assistant, name, args) {
  const handle = makeMcp(ws, {});
  const req = Readable.from([Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }))]);
  req.method = 'POST';
  let body = '';
  const res = { writeHead() {}, end(s) { body = s || ''; } };
  await handle(req, res, { assistant, client_name: `FICTIONAL ${assistant}` });
  const r = JSON.parse(body).result;
  return { ...r, data: r.structuredContent || null, text: r.content.map((c) => c.text).join('\n') };
}

function reportFor(ws, provider, run, edit = null) {
  const text = mockReport(ws, provider, run);
  const m = text.match(/```json\n([\s\S]*?)\n```/);
  const obj = JSON.parse(m[1]);
  if (edit) edit(obj);
  return text.replace(m[1], JSON.stringify(obj, null, 2));
}

const deskLatest = (ws, p) => {
  const row = indexer.buildIndex(ws).projects.find((x) => x.project_id === PID).providers[p];
  return row && !row.needs_text ? row.report_id : null;
};

// An eligible ChatGPT report for run 1, then a newer paid ChatGPT answer for
// run 2 that does not match run 2 (quarantined, excluded from grades).
function eligibleThenQuarantined(t, label) {
  const { ws, cleanup } = tempWorkspace(label);
  t.after(cleanup);
  addFixtureProject(ws);
  const run1 = research.createRun(ws, { project_id: PID, providers: ['chatgpt'], channel: 'dashboard' }).run;
  const ok = inbox.importContent(ws, 'chatgpt', { content: reportFor(ws, 'chatgpt', run1), projectId: PID, runId: run1.run_id, channel: 'dashboard paste' });
  assert.equal(ok.result.status, 'ingested', ok.result.message);
  const run2 = research.createRun(ws, { project_id: PID, providers: ['chatgpt'], channel: 'dashboard', force_new: true }).run;
  const q = inbox.importContent(ws, 'chatgpt', { content: reportFor(ws, 'chatgpt', run2, (o) => { o.sector_profile = 'general-token@1'; o.summary = 'FICTIONAL newer paid answer for another profile.'; }), projectId: PID, runId: run2.run_id, attested: { provider: 'chatgpt', model: 'FICTIONAL' }, channel: 'api' });
  assert.equal(q.result.quarantined, true, q.result.message);
  return { ws, eligibleId: ok.result.report_id, quarantinedId: q.result.report_id };
}

test('finding 2: a newer quarantined report beside an older eligible one: the connector picks the eligible one, as the desk does', async (t) => {
  const { ws, eligibleId, quarantinedId } = eligibleThenQuarantined(t, 'mcp-q');
  assert.equal(deskLatest(ws, 'chatgpt'), eligibleId, 'the desk shows the eligible report');
  const got = await call(ws, 'claude', 'get_report', { project_id: PID, model: 'chatgpt' });
  assert.equal(got.data.status, 'ok', got.text);
  assert.equal(got.data.report.report_id, eligibleId, 'the connector agrees with the desk');
  assert.equal(got.data.report.eligibility.eligible, true);
  assert.equal(got.data.report.current, true);
  assert.ok(got.data.report.grade, 'an eligible report carries its grade');
  const fp = await call(ws, 'chatgpt', 'find_projects', { query: 'Example PayFi' });
  const pv = fp.data.matches.find((p) => p.project_id === PID);
  assert.equal(pv.your_latest_report.report_id, eligibleId);
  assert.equal(pv.reports_by_model.chatgpt.latest_report_id, eligibleId);
  assert.equal(pv.reports_by_model.chatgpt.reports, 2);
  assert.equal(pv.reports_by_model.chatgpt.not_eligible, 1);
});

test('finding 2: a quarantined report read explicitly says so, and its grade is never given as a current grade', async (t) => {
  const { ws, eligibleId, quarantinedId } = eligibleThenQuarantined(t, 'mcp-qx');
  const got = await call(ws, 'claude', 'get_report', { project_id: PID, model: 'chatgpt', report_id: quarantinedId });
  assert.equal(got.data.status, 'ok', got.text);
  const r = got.data.report;
  assert.equal(r.report_id, quarantinedId);
  assert.equal(r.eligibility.eligible, false);
  assert.equal(r.eligibility.quarantined, true);
  assert.match(r.eligibility.excluded_reason, /does not match research run/);
  assert.equal(r.grade, null, 'no current grade');
  assert.ok(r.excluded_grade, 'the calculation is kept apart, labeled');
  assert.match(r.excluded_grade.note, /not a current grade/);
  assert.equal(r.current, false);
  assert.equal(got.data.current_report_id, eligibleId);
  assert.match(got.text, /excluded from the desk's grades/);
});

test('finding 2: a project with no eligible report: no current report through the connector, the excluded ones named', async (t) => {
  const { ws, cleanup } = tempWorkspace('mcp-none');
  t.after(cleanup);
  addFixtureProject(ws);
  const run = research.createRun(ws, { project_id: PID, providers: ['chatgpt'], channel: 'dashboard' }).run;
  const q = inbox.importContent(ws, 'chatgpt', { content: reportFor(ws, 'chatgpt', run, (o) => { o.rubric_version = 'cr-grading@0'; }), projectId: PID, runId: run.run_id, attested: { provider: 'chatgpt', model: 'FICTIONAL' }, channel: 'api' });
  assert.equal(q.result.quarantined, true, q.result.message);
  assert.equal(deskLatest(ws, 'chatgpt'), null, 'the desk shows no ChatGPT grade');
  const got = await call(ws, 'claude', 'get_report', { project_id: PID, model: 'chatgpt' });
  assert.equal(got.data.status, 'none', got.text);
  assert.match(got.data.message, /No eligible ChatGPT report/);
  assert.deepEqual(got.data.not_eligible.map((x) => x.report_id), [q.result.report_id]);
  assert.equal(got.data.report, undefined);
  const fp = await call(ws, 'chatgpt', 'find_projects', { query: 'Example PayFi' });
  const pv = fp.data.matches.find((p) => p.project_id === PID);
  assert.equal(pv.your_latest_report, null);
  assert.equal(pv.reports_by_model.chatgpt.latest_report_id, null);
  // A quarantined answer is not a recent usable report: research can start.
  const start = await call(ws, 'chatgpt', 'start_research', { project_id: PID, owner_request: 'FICTIONAL: research it again' });
  assert.notEqual(start.data.status, 'recent_report', start.text);
});

test('finding 2: an original and its revision: the revision is current; the original, read by ID, says it was revised and by which report', async (t) => {
  const { ws, cleanup } = tempWorkspace('mcp-rev');
  t.after(cleanup);
  addFixtureProject(ws);
  const run = research.createRun(ws, { project_id: PID, providers: ['claude'], channel: 'dashboard' }).run;
  const first = await call(ws, 'claude', 'save_report', { project_id: PID, run_id: run.run_id, report_markdown: reportFor(ws, 'claude', run) });
  assert.equal(first.data.status, 'saved', first.text);
  const second = await call(ws, 'claude', 'save_report', { project_id: PID, run_id: run.run_id, report_markdown: reportFor(ws, 'claude', run, (o) => { o.summary = 'FICTIONAL reassessed summary.'; o.investment_components.risk_resilience.value = 33; }), revision: { kind: 'reassessment', note: 'FICTIONAL: reweighed the same evidence on resilience.' } });
  assert.equal(second.data.status, 'saved', second.text);
  const origId = first.data.report.report_id;
  const revId = second.data.report.report_id;
  assert.equal(deskLatest(ws, 'claude'), revId);
  const cur = await call(ws, 'claude', 'get_report', { project_id: PID });
  assert.equal(cur.data.report.report_id, revId);
  assert.equal(cur.data.report.revision.kind, 'revision');
  assert.equal(cur.data.report.revision.of, origId);
  assert.equal(cur.data.report.current, true);
  const old = await call(ws, 'claude', 'get_report', { project_id: PID, report_id: origId });
  assert.equal(old.data.report.report_id, origId);
  assert.equal(old.data.report.eligibility.eligible, true);
  assert.equal(old.data.report.current, false);
  assert.deepEqual(old.data.report.revised_later_by, [revId]);
  assert.equal(old.data.current_report_id, revId);
  assert.ok(old.data.report.grade, 'an eligible earlier report keeps its own grade, said as not current');
});
