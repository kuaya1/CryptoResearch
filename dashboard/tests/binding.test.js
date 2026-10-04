'use strict';
// Binding a saved report to the research run it completes (core/binding.js),
// through the desk connector's own save_report handler. Found 2026-10-04
// (Codex engineering review, finding 1): a manual save completed a waiting
// Gemini job although the report declared another run, prompt @3 and
// general-token@1. Fictional workspaces and reports only; no model is called.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { Readable } = require('stream');
const { tempWorkspace, addFixtureProject, dropText } = require('./helpers');
const { makeMcp } = require('../mcp');
const research = require('../core/research');
const inbox = require('../core/inbox');
const indexer = require('../core/indexer');
const { loadReports } = require('../core/reports');
const { mockReport } = require('../core/demo');
const { addDays } = require('../core/dates');

const PID = 'example-payfi-fictional';

// One tools/call through the connector's request handler, as the given model's
// connection (its sign-in decides the model).
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

function setup(t, label, providers = ['claude', 'chatgpt', 'gemini']) {
  const { ws, cleanup } = tempWorkspace(label);
  t.after(cleanup);
  addFixtureProject(ws);
  const run = research.createRun(ws, { project_id: PID, providers, channel: 'dashboard' }).run;
  return { ws, run };
}

// The model's report for the run, its JSON block edited.
function reportFor(ws, provider, run, edit = null) {
  const text = mockReport(ws, provider, run);
  const m = text.match(/```json\n([\s\S]*?)\n```/);
  const obj = JSON.parse(m[1]);
  if (edit) edit(obj);
  return text.replace(m[1], JSON.stringify(obj, null, 2));
}

const jobOf = (ws, run, p) => research.loadRun(ws, PID, run.run_id).jobs[p];
const savedBy = (ws, p) => loadReports(ws, PID).filter((r) => !r.broken && r.meta.provider === p);

test('binding: the reproduced case: a Gemini save that declares another run, prompt @3 and general-token@1 is refused field by field and completes nothing', async (t) => {
  const { ws, run } = setup(t, 'bind-repro');
  assert.equal(jobOf(ws, run, 'gemini').state, 'unconfigured', 'waiting for Gemini');
  const text = reportFor(ws, 'gemini', run, (o) => {
    o.research_run_id = 'run_2026-09-30T120000Z_other';
    o.prompt_version = 'cr-research-prompt@3';
    o.sector_profile = 'general-token@1';
  });
  const out = await call(ws, 'gemini', 'save_report', { project_id: PID, run_id: run.run_id, report_markdown: text });
  assert.equal(out.isError, true);
  assert.match(out.text, new RegExp(`^Not saved: this report does not match research run ${run.run_id}, the job it would complete\\. Nothing was saved or linked, and the job stays open\\.`));
  assert.match(out.text, new RegExp(`research_run_id: the report says "run_2026-09-30T120000Z_other", the run's is "${run.run_id}"`));
  assert.match(out.text, new RegExp(`prompt_version: the report says "cr-research-prompt@3", the run's is "${run.prompt.version}"`));
  assert.match(out.text, new RegExp(`sector_profile: the report says "general-token@1", the run's is "${run.sector_profile}"`));
  // Nothing completed, linked, saved or shown as the latest.
  const job = jobOf(ws, run, 'gemini');
  assert.equal(job.state, 'unconfigured');
  assert.equal(job.report_id, null);
  assert.equal(savedBy(ws, 'gemini').length, 0);
  assert.equal(indexer.buildIndex(ws).projects.find((p) => p.project_id === PID).providers.gemini, null);
  assert.equal(fs.readdirSync(ws.abs('inbox/gemini')).filter((f) => f.endsWith('.md')).length, 0, 'nothing left in the inbox either');
  // The same report with the run's own contract saves and completes the job.
  const ok = await call(ws, 'gemini', 'save_report', { project_id: PID, run_id: run.run_id, report_markdown: reportFor(ws, 'gemini', run) });
  assert.equal(ok.data.status, 'saved', ok.text);
  assert.equal(jobOf(ws, run, 'gemini').state, 'completed');
  const rep = savedBy(ws, 'gemini')[0];
  assert.equal(rep.meta.provenance.binding.status, 'bound');
  assert.equal(rep.meta.provenance.binding.mode, 'assistant');
  assert.deepEqual(['research_run_id', 'project_id', 'prompt_version', 'rubric_version', 'sector_profile', 'horizon'].map((f) => rep.meta.provenance.binding.fields[f]), ['match', 'match', 'match', 'match', 'match', 'match']);
  assert.equal(rep.meta.provenance.binding.prompt_sha256, run.prompt.sha256);
});

test('binding: each contract field on its own (run, project, model, prompt, rubric, profile, horizon, position horizon) is refused and named alone', async (t) => {
  const { ws, run } = setup(t, 'bind-fields');
  const cases = [
    ['research_run_id', (o) => { o.research_run_id = 'run_2026-09-30T120000Z_other'; }],
    ['project_id', (o) => { o.project_id = 'another-project'; }],
    ['model', (o) => { o.model_self_identification = 'Claude (Anthropic)'; o.provider = null; }],
    ['prompt_version', (o) => { o.prompt_version = 'cr-research-prompt@4'; }],
    ['rubric_version', (o) => { o.rubric_version = 'cr-grading@0'; }],
    ['sector_profile', (o) => { o.sector_profile = 'payfi-credit@1'; }],
    ['horizon', (o) => { o.horizon = `4 months (${run.horizon.start_date} to ${addDays(run.horizon.end_date, 14)})`; }],
    ['position_context.horizon.end_date', (o) => { o.position_context.horizon.end_date = addDays(run.horizon.end_date, 14); }],
    ['position_context.horizon.mode', (o) => { o.position_context.horizon.mode = 'long_term'; }],
  ];
  for (const [field, edit] of cases) {
    const out = await call(ws, 'chatgpt', 'save_report', { project_id: PID, run_id: run.run_id, report_markdown: reportFor(ws, 'chatgpt', run, edit) });
    assert.equal(out.isError, true, field);
    const named = out.text.slice(out.text.indexOf('job stays open.') + 15).split('; ').map((s) => s.trim().split(':')[0]);
    assert.deepEqual(named, [field], `${field}: only that field is named (${out.text})`);
  }
  assert.equal(jobOf(ws, run, 'chatgpt').state, 'unconfigured');
  assert.equal(savedBy(ws, 'chatgpt').length, 0);
});

test('binding: missing declarations: a connected model must name the run and prompt in a readable JSON block; the rest is read under the run and recorded', async (t) => {
  const { ws, run } = setup(t, 'bind-missing');
  const noRun = await call(ws, 'chatgpt', 'save_report', { project_id: PID, run_id: run.run_id, report_markdown: reportFor(ws, 'chatgpt', run, (o) => { delete o.research_run_id; delete o.prompt_version; }) });
  assert.equal(noRun.isError, true);
  assert.match(noRun.text, new RegExp(`research_run_id: the report does not state it; the run's is "${run.run_id}"; prompt_version: the report does not state it`));
  const prose = mockReport(ws, 'chatgpt', run).replace(/```json\n[\s\S]*?\n```/, `No JSON block, FICTIONAL. ${'FICTIONAL prose. '.repeat(150)}`);
  const noBlock = await call(ws, 'chatgpt', 'save_report', { project_id: PID, run_id: run.run_id, report_markdown: prose });
  assert.equal(noBlock.isError, true);
  assert.match(noBlock.text, /^Not saved: the report has no JSON block\./);
  const broken = mockReport(ws, 'chatgpt', run).replace(/"verdict":/, '"verdict" ');
  const unreadable = await call(ws, 'chatgpt', 'save_report', { project_id: PID, run_id: run.run_id, report_markdown: broken });
  assert.equal(unreadable.isError, true);
  assert.match(unreadable.text, /^Not saved: the JSON block at the end of the report could not be read/);
  assert.equal(savedBy(ws, 'chatgpt').length, 0);
  // Rubric, profile and horizon left out: read under the run's, recorded as such.
  const partial = await call(ws, 'chatgpt', 'save_report', { project_id: PID, run_id: run.run_id, report_markdown: reportFor(ws, 'chatgpt', run, (o) => { delete o.rubric_version; delete o.sector_profile; delete o.horizon; }) });
  assert.equal(partial.data.status, 'saved', partial.text);
  const rep = savedBy(ws, 'chatgpt')[0];
  assert.deepEqual(rep.assessment.fields_from_run.sort(), ['horizon', 'rubric_version', 'sector_profile']);
  assert.deepEqual(['rubric_version', 'sector_profile', 'horizon'].map((f) => rep.meta.provenance.binding.fields[f]), ['missing', 'missing', 'missing']);
  assert.equal(jobOf(ws, run, 'chatgpt').state, 'completed');
});

test('binding: Eric\'s import for a run he chose: conflicts refused (held in the inbox with the reason), a prose answer without a JSON block is bound to his choice', (t) => {
  const { ws, run } = setup(t, 'bind-owner');
  const wrong = inbox.importContent(ws, 'claude', { content: reportFor(ws, 'claude', run, (o) => { o.prompt_version = 'cr-research-prompt@4'; }), projectId: PID, runId: run.run_id, channel: 'dashboard paste' });
  assert.equal(wrong.result.status, 'run_mismatch');
  assert.match(wrong.result.message, /prompt_version: the report says "cr-research-prompt@4"/);
  assert.ok(inbox.inboxStatus(ws).in_inbox.some((f) => f.status === 'run_mismatch'), 'kept in the inbox with its reason');
  assert.ok(indexer.buildIndex(ws).attention.some((a) => a.kind === 'import_failed'), 'and listed for Eric');
  assert.notEqual(jobOf(ws, run, 'claude').state, 'completed');
  const prose = `# FICTIONAL Claude answer pasted by hand\n\nVerdict: CONDITIONAL OPPORTUNITY\n\n${'FICTIONAL prose. '.repeat(150)}\n`;
  const ok = inbox.importContent(ws, 'claude', { content: prose, projectId: PID, runId: run.run_id, channel: 'dashboard paste' });
  assert.equal(ok.result.status, 'ingested', ok.result.message);
  assert.equal(jobOf(ws, run, 'claude').state, 'completed');
  const rep = savedBy(ws, 'claude')[0];
  assert.equal(rep.meta.provenance.binding.mode, 'owner');
  assert.equal(rep.meta.provenance.binding.status, 'bound');
  assert.equal(rep.assessment.prompt_version, run.prompt.version, 'read under the run Eric chose, and recorded as such');
});

test('binding: a correctly bound report with unknown scores saves, its grade withheld; an old standalone report imports as before', async (t) => {
  const { ws, run } = setup(t, 'bind-unknown');
  const text = reportFor(ws, 'chatgpt', run, (o) => {
    o.investment_components.btc_relative_asymmetry = { status: 'unknown', value: null, low: null, high: null, rationale: 'FICTIONAL: no defensible probabilities.', evidence_refs: [], missing_data: 'FICTIONAL: calibrated scenarios.' };
  });
  const out = await call(ws, 'chatgpt', 'save_report', { project_id: PID, run_id: run.run_id, report_markdown: text });
  assert.equal(out.data.status, 'saved', out.text);
  assert.equal(out.data.report.grade.status, 'withheld');
  assert.equal(jobOf(ws, run, 'chatgpt').state, 'completed');
  // An old prompt@1 report dropped in the inbox without any run: imported as before.
  const old = fs.readFileSync(require('path').join(__dirname, '..', 'fixtures', 'reports', 'example-payfi-fictional__gemini.md'), 'utf8');
  dropText(ws, 'gemini', 'example-payfi-fictional__old.md', old);
  const scan = inbox.scanInbox(ws, { force: true });
  assert.equal(scan.results[0].status, 'ingested', scan.results[0].message);
  const g = savedBy(ws, 'gemini')[0];
  assert.equal(g.meta.provenance.research_run_id, null);
  assert.equal(g.meta.provenance.binding, null, 'no run, nothing to bind');
  assert.equal(jobOf(ws, run, 'gemini').state, 'unconfigured', 'an old report never completes a job of another contract');
});

test('binding: the desk\'s own paid API answer is checked and recorded, never refused; a tampered run prompt binds nothing', async (t) => {
  const { ws, run } = setup(t, 'bind-api', ['chatgpt', 'gemini']);
  const api = inbox.importContent(ws, 'chatgpt', { content: reportFor(ws, 'chatgpt', run, (o) => { o.sector_profile = 'payfi-credit@1'; }), projectId: PID, runId: run.run_id, attested: { provider: 'chatgpt', model: 'FICTIONAL' }, channel: 'api' });
  assert.equal(api.result.status, 'ingested', api.result.message);
  const rep = savedBy(ws, 'chatgpt')[0];
  assert.equal(rep.meta.provenance.binding.mode, 'record');
  assert.deepEqual(rep.meta.provenance.binding.conflicts, ['sector_profile']);
  // The run's frozen prompt no longer matches its hash: no report can complete it.
  fs.appendFileSync(ws.abs(run.prompt.path), '\nFICTIONAL tampering\n');
  const out = await call(ws, 'gemini', 'save_report', { project_id: PID, run_id: run.run_id, report_markdown: reportFor(ws, 'gemini', run) });
  assert.equal(out.isError, true);
  assert.match(out.text, /frozen prompt no longer matches the SHA-256 recorded when the run started, so no report can be bound to it/);
  assert.equal(jobOf(ws, run, 'gemini').state, 'unconfigured');
});

test('binding: an analysis time more than a day after the save is refused; minutes after is saved, flagged and ordered by its save time', async (t) => {
  const { ws, run } = setup(t, 'bind-time', ['chatgpt']);
  const future = new Date(Date.now() + 3 * 86400000).toISOString();
  const refused = await call(ws, 'chatgpt', 'save_report', { project_id: PID, run_id: run.run_id, report_markdown: reportFor(ws, 'chatgpt', run, (o) => { o.analysis_at = future; }) });
  assert.equal(refused.isError, true);
  assert.match(refused.text, new RegExp(`analysis_at: the report says "${future}", the run's is "on or before`));
  const soon = new Date(Date.now() + 40 * 60000).toISOString();
  const saved = await call(ws, 'chatgpt', 'save_report', { project_id: PID, run_id: run.run_id, report_markdown: reportFor(ws, 'chatgpt', run, (o) => { o.analysis_at = soon; }) });
  assert.equal(saved.data.status, 'saved', saved.text);
  const row = indexer.buildIndex(ws).projects.find((p) => p.project_id === PID).providers.chatgpt;
  assert.equal(row.analysis_at, soon, 'the stated time is kept as written');
  assert.equal(row.analysis_timing.status, 'after_save');
  assert.ok(row.analysis_timing.minutes_after_save >= 39);
  // A later report for a new run, analyzed now, is the latest: the earlier
  // one's stated time after its save does not keep it on top.
  const run2 = research.createRun(ws, { project_id: PID, providers: ['chatgpt'], channel: 'dashboard', force_new: true }).run;
  const now = await call(ws, 'chatgpt', 'save_report', { project_id: PID, run_id: run2.run_id, report_markdown: reportFor(ws, 'chatgpt', run2, (o) => { o.analysis_at = new Date().toISOString(); o.summary = 'FICTIONAL second report.'; }) });
  assert.equal(now.data.status, 'saved', now.text);
  assert.equal(indexer.buildIndex(ws).projects.find((p) => p.project_id === PID).providers.chatgpt.report_id, now.data.report.report_id);
  assert.equal(indexer.buildIndex(ws).projects.find((p) => p.project_id === PID).providers.chatgpt.revision.kind, 'new_run');
});
