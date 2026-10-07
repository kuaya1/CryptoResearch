'use strict';
// A research job completes only by a validated assignment to its exact run
// (review of 2026-10-07, finding 1). Before this repair an import that named
// no run (research.autoLinkReport) completed the one open job of its project
// and model: an old prose-only report, or a JSON report that simply left the
// run out, became the answer to research it never saw, and a paid answer's
// job that was failed because its answer was quarantined could be "completed"
// by any later unrelated import. Now such a report is saved on its own as
// history; a job completes only through:
//   - an import for a run the owner chose (binding.js mode owner),
//   - a model's own save through its connection (mode assistant),
//   - a report whose JSON names the run and matches it (mode declared),
//   - the desk's own paid answer to the frozen prompt (mode record).
// Fictional workspaces and reports only; nothing is sent anywhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempWorkspace, addFixtureProject, dropText } = require('./helpers');
const research = require('../core/research');
const inbox = require('../core/inbox');
const indexer = require('../core/indexer');
const { loadReports } = require('../core/reports');
const { mockReport } = require('../core/demo');
const { readJson, atomicWrite, jsonText } = require('../core/fsx');
const { openWorkspace } = require('../core/workspace');

const PID = 'example-payfi-fictional';

function setup(t, label, providers = ['claude', 'chatgpt', 'gemini']) {
  const { ws, cleanup } = tempWorkspace(label);
  t.after(cleanup);
  addFixtureProject(ws);
  const run = research.createRun(ws, { project_id: PID, providers, channel: 'dashboard' }).run;
  return { ws, run };
}

function reportFor(ws, provider, run, edit = null) {
  const text = mockReport(ws, provider, run);
  const m = text.match(/```json\n([\s\S]*?)\n```/);
  const obj = JSON.parse(m[1]);
  if (edit) edit(obj);
  return text.replace(m[1], JSON.stringify(obj, null, 2));
}

const jobOf = (ws, run, p) => research.loadRun(ws, PID, run.run_id).jobs[p];
const savedBy = (ws, p) => loadReports(ws, PID).filter((r) => !r.broken && r.meta.provider === p);
const PROSE = (who) => `# FICTIONAL ${who} research note from September\n\nVerdict: CONDITIONAL OPPORTUNITY\n\nInvestment grade 71 of 100.\n\n${'FICTIONAL older prose, written before any current research run. '.repeat(60)}\n`;

test('finding 1: an old prose-only report with no run ID is saved as history and completes no job, even with exactly one job open', (t) => {
  const { ws, run } = setup(t, 'jc-prose', ['gemini']);
  assert.equal(jobOf(ws, run, 'gemini').state, 'unconfigured', 'one open Gemini job');
  // Dropped in the inbox (scan) and pasted without a run (dashboard): both routes.
  dropText(ws, 'gemini', `${PID}__september-note.md`, PROSE('Gemini'));
  const scan = inbox.scanInbox(ws, { force: true });
  assert.equal(scan.results[0].status, 'ingested', scan.results[0].message);
  assert.match(scan.results[0].message, /completes no research job/);
  assert.match(scan.results[0].message, new RegExp(`Gemini's open job in run ${run.run_id} stays open`));
  const pasted = inbox.importContent(ws, 'gemini', { content: PROSE('Gemini').replace('September', 'August'), projectId: PID, channel: 'dashboard paste' });
  assert.equal(pasted.result.status, 'ingested', pasted.result.message);
  const job = jobOf(ws, run, 'gemini');
  assert.equal(job.state, 'unconfigured', 'the job stays open');
  assert.equal(job.report_id, null);
  assert.equal(job.link_method, undefined);
  for (const r of savedBy(ws, 'gemini')) {
    assert.equal(r.meta.provenance.research_run_id, null, 'no run inferred for the history');
    assert.equal(r.meta.provenance.binding, null);
    assert.equal(r.assessment.research_run_id, null);
  }
  assert.equal(savedBy(ws, 'gemini').length, 2, 'both kept as history');
  // The same text again, now for the open run: already saved as history, it is
  // not bound afterwards (no binding is inferred for a stored report).
  const again = inbox.importContent(ws, 'gemini', { content: PROSE('Gemini'), projectId: PID, runId: run.run_id, channel: 'dashboard paste' });
  assert.equal(again.result.status, 'duplicate');
  assert.match(again.result.message, new RegExp(`saved without a research run, and a saved report is never bound to a run afterwards, so it completes nothing in ${run.run_id}`));
  assert.equal(jobOf(ws, run, 'gemini').state, 'unconfigured');
});

test('finding 1: a historical JSON report with no run ID completes nothing, whether its horizon conflicts or it simply leaves the run out', (t) => {
  const { ws, run } = setup(t, 'jc-json', ['claude']);
  const before = jobOf(ws, run, 'claude').state;
  assert.notEqual(before, 'completed');
  // Another horizon, no run ID.
  const mismatch = reportFor(ws, 'claude', run, (o) => { delete o.research_run_id; o.horizon = '2 months (2026-08-01 to 2026-10-01)'; o.summary = 'FICTIONAL older report, other horizon.'; });
  const a = inbox.importContent(ws, 'claude', { content: mismatch, projectId: PID, channel: 'dashboard paste' });
  assert.equal(a.result.status, 'ingested', a.result.message);
  assert.equal(jobOf(ws, run, 'claude').state, before, 'still open');
  // No conflicting field at all, only no run ID: still not this run's answer.
  const silent = reportFor(ws, 'claude', run, (o) => { delete o.research_run_id; delete o.horizon; delete o.prompt_version; o.summary = 'FICTIONAL older report, no run named.'; });
  const b = inbox.importContent(ws, 'claude', { content: silent, projectId: PID, channel: 'dashboard paste' });
  assert.equal(b.result.status, 'ingested', b.result.message);
  const job = jobOf(ws, run, 'claude');
  assert.equal(job.state, before, 'an unbound report never completes the job');
  assert.equal(job.report_id, null);
  assert.ok(savedBy(ws, 'claude').every((r) => r.meta.provenance.research_run_id === null));
});

test('finding 1: with several open jobs for the model, an unbound report completes none of them', (t) => {
  const { ws, run } = setup(t, 'jc-many', ['gemini']);
  const run2 = research.createRun(ws, { project_id: PID, providers: ['gemini'], channel: 'dashboard', force_new: true }).run;
  assert.notEqual(run2.run_id, run.run_id);
  const out = inbox.importContent(ws, 'gemini', { content: PROSE('Gemini'), projectId: PID, channel: 'dashboard paste' });
  assert.equal(out.result.status, 'ingested');
  assert.match(out.result.message, /completes no research job/);
  for (const r of [run, run2]) {
    const j = research.loadRun(ws, PID, r.run_id).jobs.gemini;
    assert.notEqual(j.state, 'completed', `${r.run_id} stays open`);
    assert.equal(j.report_id, null);
  }
});

test('finding 1: an explicit assignment to the exact run completes it under the binding contract; a conflicting one is refused field by field', (t) => {
  const { ws, run } = setup(t, 'jc-explicit', ['claude', 'gemini']);
  // Eric imports for the run he chose: a horizon that is not the run's is refused, nothing linked.
  const wrong = inbox.importContent(ws, 'gemini', { content: reportFor(ws, 'gemini', run, (o) => { o.horizon = '2 months (2026-08-01 to 2026-10-01)'; }), projectId: PID, runId: run.run_id, channel: 'dashboard paste' });
  assert.equal(wrong.result.status, 'run_mismatch');
  assert.match(wrong.result.message, /horizon: the report says "2 months \(2026-08-01 to 2026-10-01\)"/);
  assert.equal(jobOf(ws, run, 'gemini').state, 'unconfigured');
  // The same model's report for this run, chosen explicitly: bound and completed.
  const ok = inbox.importContent(ws, 'gemini', { content: reportFor(ws, 'gemini', run, (o) => { o.summary = 'FICTIONAL bound answer.'; }), projectId: PID, runId: run.run_id, channel: 'dashboard paste' });
  assert.equal(ok.result.status, 'ingested', ok.result.message);
  const job = jobOf(ws, run, 'gemini');
  assert.equal(job.state, 'completed');
  assert.equal(job.report_id, ok.result.report_id);
  assert.equal(job.link_method, 'run');
  const rep = savedBy(ws, 'gemini').find((r) => r.report_id === ok.result.report_id);
  assert.equal(rep.meta.provenance.binding.mode, 'owner');
  assert.equal(rep.meta.provenance.binding.status, 'bound');
  assert.equal(rep.meta.provenance.research_run_id, run.run_id);
  // A report whose own JSON names this run and matches it (an inbox drop) completes Claude's job.
  dropText(ws, 'claude', `${PID}__claude-for-run.md`, reportFor(ws, 'claude', run));
  const scan = inbox.scanInbox(ws, { force: true });
  assert.equal(scan.results[0].status, 'ingested', scan.results[0].message);
  assert.equal(jobOf(ws, run, 'claude').state, 'completed');
  assert.equal(jobOf(ws, run, 'claude').link_method, 'report json');
  // The original frozen prompt and evidence are untouched by any of it.
  assert.equal(require('../core/fsx').sha256(fs.readFileSync(ws.abs(run.prompt.path))), run.prompt.sha256);
});

test('finding 1: a conflicting paid answer stays quarantined with its receipt and cost, is never resent, and a later unbound import does not complete its job', async (t) => {
  const { root, cleanup } = tempWorkspace('jc-paid');
  t.after(cleanup);
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real-0000';
  t.after(() => { if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev; });
  let ws = openWorkspace({ root, actor: 'test' });
  addFixtureProject(ws);
  const file = path.join(root, 'config', 'settings.json');
  const s = readJson(file);
  s.research = { providers: { claude: { model: 'claude-test-model', input_usd_per_mtok: 3, output_usd_per_mtok: 15, search_usd_per_call: 0.01, max_searches: 5 } }, budget: { per_run_usd: 5, daily_usd: 20, monthly_usd: 100 }, max_output_tokens: 8000, max_attempts: 2, timeout_seconds: 30 };
  atomicWrite(file, jsonText(s));
  ws = openWorkspace({ root, actor: 'test' });
  const run = research.createRun(ws, { project_id: PID, providers: ['claude'] }).run;
  assert.equal(run.jobs.claude.state, 'queued');
  // The paid answer states another scoring profile than the run froze.
  const text = reportFor(ws, 'claude', run, (o) => { o.sector_profile = 'general-token@1'; o.model_self_identification = 'Claude (Anthropic)'; });
  let calls = 0;
  const answer = { id: 'msg_stub_1', model: 'claude-test-model', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 12000, output_tokens: 3000, server_tool_use: { web_search_requests: 2 } } };
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_stub_1' } });
  };
  const out = await research.runDueJobs(ws, { fetchImpl });
  assert.equal(calls, 1);
  assert.equal(out.results[0].quarantined, true, JSON.stringify(out.results[0]));
  const check = () => {
    const job = research.loadRun(ws, PID, run.run_id).jobs.claude;
    assert.equal(job.state, 'failed');
    assert.equal(job.outcome, 'contract_conflict');
    assert.equal(job.report_id || null, null, 'the quarantined answer did not complete the job');
    const a = job.attempts[0];
    assert.equal(a.phase, 'imported');
    assert.equal(a.quarantined, true);
    assert.ok(a.response_path && fs.existsSync(ws.abs(a.response_path)), 'the receipt (response file) is kept');
    assert.equal(a.request_id, 'req_stub_1');
    assert.equal(a.cost_actual_usd, 0.101, 'its actual cost is kept');
    return job;
  };
  const job = check();
  const q = savedBy(ws, 'claude').find((r) => r.report_id === job.quarantined_report_id);
  assert.equal(q.assessment.eligibility.excluded, true, 'kept, excluded from grades');
  // A later import that names no run (a historical note) must not complete the failed job.
  const later = inbox.importContent(ws, 'claude', { content: PROSE('Claude'), projectId: PID, channel: 'dashboard paste' });
  assert.equal(later.result.status, 'ingested');
  check();
  // Nothing is due: the runner sends nothing again, now or after a recovery pass.
  const again = await research.runDueJobs(ws, { fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.equal(again.status, 'noop');
  assert.equal(calls, 1, 'never resent');
  check();
  // The desk's latest Claude grade is not the quarantined one nor the unbound history's.
  const row = indexer.buildIndex(ws).projects.find((p) => p.project_id === PID).providers.claude;
  assert.notEqual(row && row.report_id, job.quarantined_report_id);
});
