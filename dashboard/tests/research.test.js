'use strict';
// Research orchestration: runs, jobs, budgets, provenance. All providers here are
// mock adapters or recorded HTTP fixtures; no real API is called.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempWorkspace, addFixtureProject } = require('./helpers');
const research = require('../core/research');
const requests = require('../core/requests');
const indexer = require('../core/indexer');
const inbox = require('../core/inbox');
const { mockReport } = require('../core/demo');
const { readJson, atomicWrite, jsonText, readJsonLines } = require('../core/fsx');
const { openWorkspace } = require('../core/workspace');

function settings(root, research) {
  const file = path.join(root, 'config', 'settings.json');
  const s = readJson(file);
  s.research = research;
  atomicWrite(file, jsonText(s));
  return openWorkspace({ root, actor: 'test' });
}

test('three providers with mock adapters: each job gets its own state, one failure does not touch the others', async (t) => {
  const { root, cleanup } = tempWorkspace('r-mock');
  t.after(cleanup);
  let ws = openWorkspace({ root, actor: 'test' });
  const pid = addFixtureProject(ws).project_id;
  ws = settings(root, { providers: { claude: { mock: 'ok' }, chatgpt: { mock: 'invalid' }, gemini: { mock: 'timeout' } }, max_attempts: 2 });
  const run = research.createRun(ws, { project_id: pid, providers: 'claude,gpt,gemini', horizon: '4 months', channel: 'dashboard' });
  assert.equal(run.status, 'created');
  assert.deepEqual(run.run.providers, ['claude', 'chatgpt', 'gemini']);
  assert.ok(Object.values(run.run.jobs).every((j) => j.state === 'queued'));
  // The prompt is identical for every provider and its hash is recorded.
  const prompt = fs.readFileSync(path.join(root, run.run.prompt.path), 'utf8');
  assert.ok(prompt.includes(run.run_id));
  assert.ok(!/holdings":|transactions":/.test(fs.readFileSync(path.join(root, run.run.evidence_packet.path), 'utf8')), 'no holdings in the packet');
  await research.runDueJobs(ws, { trigger: 'test' });
  let r = research.loadRun(ws, pid, run.run_id);
  assert.equal(r.jobs.claude.state, 'completed');
  assert.ok(r.jobs.claude.report_id);
  assert.equal(r.jobs.chatgpt.state, 'failed', 'invalid output is not imported');
  assert.match(r.jobs.chatgpt.error, /saved but not imported/);
  assert.equal(r.jobs.gemini.state, 'queued', 'timeout is retried once');
  await research.runDueJobs(ws, { trigger: 'test' });
  r = research.loadRun(ws, pid, run.run_id);
  assert.equal(r.jobs.gemini.state, 'failed', 'bounded: no more than max_attempts');
  assert.equal(r.jobs.gemini.attempts.length, 2);
  assert.equal(research.runStatus(r), 'partially_completed');
  // Every attempt's raw response was saved before normalization.
  for (const job of Object.values(r.jobs)) for (const a of job.attempts) assert.ok(fs.existsSync(path.join(root, a.response_path)), a.response_path);
  // The Claude report is linked to its run and prompt hash, and is not "attested".
  const d = indexer.projectDetail(ws, pid);
  const rep = d.reports.find((x) => x.report_id === r.jobs.claude.report_id);
  assert.equal(rep.provenance.research_run_id, run.run_id);
  assert.equal(rep.meta.provenance.prompt_sha256, run.run.prompt.sha256);
  assert.equal(rep.provenance.attested, null, 'mock output is never shown as provider-attested');
  // Retrying a failed job is explicit and bounded.
  const retried = research.retryJob(ws, pid, run.run_id, 'gemini');
  assert.equal(retried.status, 'saved');
  assert.equal(research.loadRun(ws, pid, run.run_id).jobs.gemini.state, 'queued');
});

test('repeating the same research request within minutes does not start a second run', (t) => {
  const { root, cleanup } = tempWorkspace('r-dedupe');
  t.after(cleanup);
  let ws = openWorkspace({ root, actor: 'test' });
  const pid = addFixtureProject(ws).project_id;
  ws = settings(root, { providers: {} });
  const a = research.createRun(ws, { project_id: pid, providers: ['claude', 'chatgpt'], horizon: '4 months' });
  const b = research.createRun(ws, { project_id: pid, providers: ['claude', 'chatgpt'], horizon: '4 months' });
  assert.equal(b.status, 'exists');
  assert.equal(b.run_id, a.run_id);
  assert.equal(research.listRuns(ws, pid).length, 1);
});

test('without API configuration each job is unconfigured with a ready prompt, and a pasted answer completes it', (t) => {
  const { root, cleanup } = tempWorkspace('r-manual');
  t.after(cleanup);
  let ws = openWorkspace({ root, actor: 'test' });
  const pid = addFixtureProject(ws).project_id;
  ws = settings(root, { providers: {} });
  const run = research.createRun(ws, { project_id: pid, providers: ['chatgpt', 'gemini'], horizon: '4 months' });
  for (const j of Object.values(run.run.jobs)) {
    assert.equal(j.state, 'unconfigured');
    assert.equal(j.fallback, 'manual');
  }
  assert.equal(research.runStatus(run.run), 'waiting');
  // A ChatGPT answer pasted for this run completes only the ChatGPT job.
  const text = mockReport(ws, 'chatgpt', run.run).replace('FICTIONAL demo fixture standing in for ChatGPT', 'ChatGPT (OpenAI)');
  const out = inbox.importContent(ws, 'chatgpt', { content: text, projectId: pid, runId: run.run_id, channel: 'dashboard paste' });
  assert.equal(out.result.status, 'ingested', out.result.message);
  const r = research.loadRun(ws, pid, run.run_id);
  assert.equal(r.jobs.chatgpt.state, 'completed');
  assert.equal(r.jobs.gemini.state, 'unconfigured');
  assert.equal(research.runStatus(r), 'partially_completed');
  // A Claude session cannot slip a report in under GPT's name: the inbox
  // records the channel and the report's own provider claim must match.
  const wrong = mockReport(ws, 'gemini', run.run).replace('"provider": "gemini"', '"provider": "claude"');
  const bad = inbox.importContent(ws, 'gemini', { content: wrong, projectId: pid, runId: run.run_id });
  assert.equal(bad.result.status, 'provider_mismatch');
  assert.equal(research.loadRun(ws, pid, run.run_id).jobs.gemini.state, 'unconfigured');
});

test('a run created from a Cowork session assigns the Claude job to that session', (t) => {
  const { root, cleanup } = tempWorkspace('r-cowork');
  t.after(cleanup);
  let ws = openWorkspace({ root, actor: 'cowork' });
  const pid = addFixtureProject(ws).project_id;
  ws = settings(root, { providers: {} });
  ws.actor = 'cowork';
  const run = research.createRun(ws, { project_id: pid, providers: ['claude', 'chatgpt', 'gemini'], channel: 'cowork' });
  assert.equal(run.run.jobs.claude.mode, 'cowork');
  assert.equal(run.run.jobs.claude.state, 'running');
  assert.equal(run.run.jobs.chatgpt.state, 'unconfigured');
});

function anthropicFixture(text, { status = 200 } = {}) {
  let calls = 0;
  const f = async (url, opts) => {
    calls++;
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    const body = JSON.parse(opts.body);
    assert.ok(body.tools.some((x) => x.type.startsWith('web_search')), 'web search tool enabled');
    assert.ok(!JSON.stringify(opts).includes('transactions.json'));
    const json = status === 200
      ? { id: 'msg_fixture_123', model: 'claude-test-model', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 12000, output_tokens: 3000, server_tool_use: { web_search_requests: 4 } } }
      : { error: { type: 'overloaded_error', message: 'Overloaded' } };
    return { ok: status === 200, status, headers: { get: (k) => (k === 'request-id' ? 'req_fixture_abc' : null) }, text: async () => JSON.stringify(json) };
  };
  f.calls = () => calls;
  return f;
}

test('API path: budget is checked before the call, attested IDs and cost are recorded, the key never reaches the workspace', async (t) => {
  const { root, cleanup } = tempWorkspace('r-api');
  t.after(cleanup);
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-FAKE-KEY-123';
  t.after(() => { if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey; });
  let ws = openWorkspace({ root, actor: 'test' });
  const pid = addFixtureProject(ws).project_id;
  const priced = { model: 'claude-test-model', input_usd_per_mtok: 3, output_usd_per_mtok: 15, search_usd_per_call: 0.01, max_searches: 5 };
  // Budget too small: refused before any call.
  ws = settings(root, { providers: { claude: priced }, budget: { per_run_usd: 0.05, daily_usd: 1, monthly_usd: 5 }, max_output_tokens: 8000 });
  assert.equal(research.providerStatus(ws).claude.mode, 'api');
  const run1 = research.createRun(ws, { project_id: pid, providers: ['claude'] });
  const f1 = anthropicFixture('unused');
  const out1 = await research.runDueJobs(ws, { fetchImpl: f1 });
  assert.equal(f1.calls(), 0, 'no call made');
  assert.equal(out1.results[0].status, 'budget_refused');
  assert.match(research.loadRun(ws, pid, run1.run_id).jobs.claude.error, /per-run limit/);
  // Enough budget: one call, response saved, report imported with attested metadata.
  ws = settings(root, { providers: { claude: priced }, budget: { per_run_usd: 2, daily_usd: 5, monthly_usd: 20 }, max_output_tokens: 8000 });
  const run2 = research.createRun(ws, { project_id: pid, providers: ['claude'], force_new: true });
  const text = mockReport(ws, 'claude', run2.run).replace('FICTIONAL demo fixture standing in for Claude', 'Claude (Anthropic)');
  const f2 = anthropicFixture(text);
  const out2 = await research.runDueJobs(ws, { fetchImpl: f2 });
  assert.equal(f2.calls(), 1);
  assert.equal(out2.results.find((x) => x.provider === 'claude').status, 'completed');
  const job = research.loadRun(ws, pid, run2.run_id).jobs.claude;
  assert.equal(job.state, 'completed');
  const attempt = job.attempts[0];
  assert.equal(attempt.response_id, 'msg_fixture_123');
  assert.equal(attempt.request_id, 'req_fixture_abc');
  assert.equal(attempt.model_attested, 'claude-test-model');
  assert.ok(attempt.cost_estimate_usd > 0 && attempt.cost_estimate_usd <= 2);
  assert.equal(attempt.cost_actual_usd, Math.round(((12000 / 1e6) * 3 + (3000 / 1e6) * 15 + 0.04) * 10000) / 10000);
  const rep = indexer.projectDetail(ws, pid).reports.find((r) => r.report_id === job.report_id);
  assert.equal(rep.provenance.attested.response_id, 'msg_fixture_123');
  assert.equal(rep.provenance.self_reported, false);
  const spend = research.spendSoFar(ws);
  assert.equal(spend.daily, attempt.cost_actual_usd, 'actual cost replaces the estimate in the ledger');
  // The API key is nowhere in the workspace.
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(root)) assert.ok(!fs.readFileSync(f, 'utf8').includes('sk-ant-test-FAKE-KEY-123'), `key leaked into ${f}`);
});

test('a runner that dies after saving a response imports it on restart without calling the provider again', async (t) => {
  const { root, cleanup } = tempWorkspace('r-crash');
  t.after(cleanup);
  let ws = openWorkspace({ root, actor: 'test' });
  const pid = addFixtureProject(ws).project_id;
  ws = settings(root, { providers: { claude: { mock: 'ok' } } });
  const run = research.createRun(ws, { project_id: pid, providers: ['claude'] });
  // Simulate the crash window: response saved, job left running, report not imported.
  const inboxMod = require('../core/inbox');
  const orig = inboxMod.importContent;
  inboxMod.importContent = () => { throw new Error('simulated crash before import'); };
  try {
    await research.runDueJobs(ws, { trigger: 'test' });
  } finally {
    inboxMod.importContent = orig;
  }
  let job = research.loadRun(ws, pid, run.run_id).jobs.claude;
  assert.equal(job.state, 'running');
  assert.ok(job.attempts[0].response_path);
  await research.runDueJobs(ws, { trigger: 'restart' });
  job = research.loadRun(ws, pid, run.run_id).jobs.claude;
  assert.equal(job.state, 'completed');
  assert.equal(job.attempts.length, 1, 'no second provider call');
  await research.runDueJobs(ws, { trigger: 'again' });
  assert.equal(indexer.projectDetail(ws, pid).reports.filter((r) => r.provenance.research_run_id === run.run_id).length, 1, 'exactly one report');
});

test('queued research requests are idempotent and canceling a job is explicit', async (t) => {
  const { root, cleanup } = tempWorkspace('r-queue');
  t.after(cleanup);
  let ws = openWorkspace({ root, actor: 'test' });
  const pid = addFixtureProject(ws).project_id;
  ws = settings(root, { providers: {} });
  const req = { schema_version: 'cr.request.v1', request_id: 'req_research_01', action: 'research_project', utterance: 'Research it with Claude, GPT and Gemini', args: { project_id: pid, providers: ['claude', 'chatgpt', 'gemini'], horizon: '4 months' } };
  fs.writeFileSync(path.join(root, 'inbox', 'requests', 'req_research_01.json'), JSON.stringify(req));
  requests.processRequests(ws);
  fs.writeFileSync(path.join(root, 'inbox', 'requests', 'req_research_01.json'), JSON.stringify(req));
  requests.processRequests(ws);
  assert.equal(research.listRuns(ws, pid).length, 1);
  const receipt = requests.requestStatus(ws, 'req_research_01');
  assert.equal(receipt.status, 'done');
  const runId = research.listRuns(ws, pid)[0].run_id;
  const c = research.cancelJob(ws, pid, runId, 'gemini', 'not needed');
  assert.equal(c.status, 'saved');
  assert.equal(research.loadRun(ws, pid, runId).jobs.gemini.state, 'canceled');
  assert.equal(research.cancelJob(ws, pid, runId, 'gemini').status, 'unchanged');
});

test('price refreshes never start research; schedules need unattended mode and a budget', async (t) => {
  const { root, cleanup } = tempWorkspace('r-sched');
  t.after(cleanup);
  let ws = openWorkspace({ root, actor: 'test' });
  const pid = addFixtureProject(ws).project_id;
  ws = settings(root, { providers: { claude: { mock: 'ok' } }, schedules: [{ id: 'monthly', every_days: 30, providers: ['claude'], enabled: true }], unattended_enabled: false });
  assert.equal(research.dueSchedules(ws).length, 1);
  const out = await research.runDueJobs(ws, { trigger: 'scheduler' });
  assert.equal(out.created.length, 0);
  assert.match(out.summary, /unattended research is disabled/);
  assert.equal(research.listRuns(ws, pid).length, 0);
  ws = settings(root, { providers: { claude: { mock: 'ok' } }, schedules: [{ id: 'monthly', every_days: 30, providers: ['claude'], enabled: true }], unattended_enabled: true });
  const out2 = await research.runDueJobs(ws, { trigger: 'scheduler' });
  assert.equal(out2.created.length, 1);
  assert.equal(research.dueSchedules(ws).length, 0, 'not due again until 30 days later');
});

test('a model on hold is never retried: the retry is refused, the job and its record stay as they were; lifting the hold allows it again', async (t) => {
  const { root, cleanup } = tempWorkspace('r-hold-retry');
  t.after(cleanup);
  let ws = openWorkspace({ root, actor: 'test' });
  const pid = addFixtureProject(ws).project_id;
  const providers = { claude: { mock: 'ok' }, gemini: { mock: 'timeout' } };
  ws = settings(root, { providers, max_attempts: 1 });
  const run = research.createRun(ws, { project_id: pid, providers: 'gemini', horizon: '4 months', channel: 'dashboard' });
  await research.runDueJobs(ws, { trigger: 'test' });
  const jobOf = () => research.loadRun(ws, pid, run.run_id).jobs.gemini;
  assert.equal(jobOf().state, 'failed');
  const attempts = (jobOf().attempts || []).length;
  ws = settings(root, { providers, max_attempts: 1, on_hold: { gemini: { since: '2026-10-04', reason: 'FICTIONAL hold' } } });
  assert.throws(() => research.retryJob(ws, pid, run.run_id, 'gemini'), /Gemini is on hold since 2026-10-04: nothing new is sent to it/);
  assert.equal(jobOf().state, 'failed', 'the job is untouched');
  assert.equal((jobOf().attempts || []).length, attempts, 'no attempt was added');
  ws = settings(root, { providers, max_attempts: 1, on_hold: { gemini: null } });
  research.retryJob(ws, pid, run.run_id, 'gemini');
  assert.equal(jobOf().state, 'queued', 'with the hold lifted, the retry queues the job again');
});
