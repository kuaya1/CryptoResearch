'use strict';
// ChatGPT and Gemini research in the provider's background (OpenAI Responses
// background mode, Gemini Interactions background execution): sent once,
// its ID saved, the answer collected by that ID on later checks, also after a
// restart; never sent again when its outcome is unknown. Providers are
// in-process stand-ins that count what they receive; keys are fake test
// values; nothing leaves this PC.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { tempWorkspace, addFixtureProject } = require('./helpers');
const research = require('../core/research');
const captures = require('../core/captures');
const leases = require('../core/leases');
const { mockReport } = require('../core/demo');
const { readJson, atomicWrite, jsonText, readJsonLines } = require('../core/fsx');
const { openWorkspace } = require('../core/workspace');

const KEYS = { OPENAI_API_KEY: 'test-key-not-real-o', GEMINI_API_KEY: 'test-key-not-real-g' };
const CHATGPT = { model: 'gpt-test-model', input_usd_per_mtok: 2, output_usd_per_mtok: 10, search_usd_per_call: 0.01, max_searches: 5, effort: 'high' };
const GEMINI = { model: 'gemini-test-model', input_usd_per_mtok: 2, output_usd_per_mtok: 12, search_usd_per_call: 0.014, max_searches: 20, search_billing: 'per_query', effort: 'high' };
const BUDGET = { per_run_usd: 20, daily_usd: 50, monthly_usd: 100 };

function withKeys(t) {
  const prev = {};
  for (const [k, v] of Object.entries(KEYS)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  prev.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

function configure(root, researchSettings) {
  const file = path.join(root, 'config', 'settings.json');
  const s = readJson(file);
  s.research = researchSettings;
  atomicWrite(file, jsonText(s));
  return openWorkspace({ root, actor: 'test' });
}

function setup(t, label, providers = { chatgpt: CHATGPT }, extra = {}) {
  withKeys(t);
  const { root, cleanup } = tempWorkspace(label);
  t.after(cleanup);
  let ws = openWorkspace({ root, actor: 'test' });
  const pid = addFixtureProject(ws).project_id;
  ws = configure(root, { providers, budget: BUDGET, max_output_tokens: 20000, ...extra });
  return { root, ws, pid };
}

const reportFor = (ws, pid, provider, runId) => mockReport(ws, provider, research.loadRun(ws, pid, runId)).replace(/FICTIONAL demo fixture standing in for \w+/, provider === 'chatgpt' ? 'ChatGPT (OpenAI)' : 'Gemini (Google)');

const json = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[String(k).toLowerCase()] || null }, text: async () => JSON.stringify(body) });

// An OpenAI Responses stand-in. Each GET answers from the script: a status
// word, or a function returning the full response object.
function openai(ws, pid, { create = null, script = [] } = {}) {
  const calls = [];
  let runId = null;
  let polls = 0;
  const f = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, url, body, headers: opts.headers });
    if (url === 'https://api.openai.com/v1/responses' && method === 'POST') {
      runId = (String(body.input).match(/run_[A-Za-z0-9_-]+/) || [])[0];
      if (create) return create(body, calls.length);
      return json(200, { id: 'resp_test_1', status: 'queued', model: 'gpt-test-model' }, { 'x-request-id': 'req_create' });
    }
    const m = url.match(/^https:\/\/api\.openai\.com\/v1\/responses\/([^/]+)(\/cancel)?$/);
    if (m) {
      const step = m[2] ? 'cancel' : script[Math.min(polls++, script.length - 1)];
      if (typeof step === 'function') return step(runId);
      if (step === 'cancel') return json(200, { id: m[1], status: 'cancelled', usage: { input_tokens: 9000, output_tokens: 1000 } });
      if (step === 'completed') return json(200, completedChatgpt(reportFor(ws, pid, 'chatgpt', runId)));
      if (step === '404') return json(404, { error: { message: 'No response found' } });
      if (step === 'network') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      return json(200, { id: m[1], status: step });
    }
    throw new Error(`unexpected call ${method} ${url}`);
  };
  f.calls = calls;
  f.posts = () => calls.filter((c) => c.method === 'POST' && c.url === 'https://api.openai.com/v1/responses').length;
  return f;
}

function completedChatgpt(text) {
  return { id: 'resp_test_1', model: 'gpt-test-model-2026', status: 'completed', output: [{ type: 'web_search_call', action: { type: 'search', query: 'x' } }, { type: 'web_search_call', action: { type: 'open_page' } }, { type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 30000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 12000, output_tokens_details: { reasoning_tokens: 4000 } } };
}

const job = (ws, pid, runId, p = 'chatgpt') => research.loadRun(ws, pid, runId).jobs[p];
const lastA = (j) => j.attempts[j.attempts.length - 1];

test('background: ChatGPT is sent once to run in the background, collected by its ID across a restart, and saved with its real cost', async (t) => {
  const { root, ws, pid } = setup(t, 'bg-happy');
  const run = research.createRun(ws, { project_id: pid, providers: ['chatgpt'] });
  const f = openai(ws, pid, { script: ['in_progress', 'in_progress', 'completed'] });
  const first = await research.runDueJobs(ws, { fetchImpl: f });
  assert.equal(first.results[0].status, 'submitted');
  const post = f.calls[0];
  assert.equal(post.body.background, true);
  assert.equal(post.body.store, true, 'background mode keeps the answer to collect');
  assert.equal(post.body.max_tool_calls, 5);
  assert.deepEqual(post.body.tools, [{ type: 'web_search' }]);
  assert.deepEqual(post.body.reasoning, { effort: 'high' });
  assert.equal(post.body.max_output_tokens, 20000);
  assert.equal(post.body.metadata.run_id, run.run_id);
  assert.equal(post.headers['x-client-request-id'], lastA(job(ws, pid, run.run_id)).attempt_id, 'the attempt ID travels with the request for tracing');
  let j = job(ws, pid, run.run_id);
  assert.equal(j.state, 'dispatching');
  assert.equal(lastA(j).phase, 'submitted');
  assert.equal(lastA(j).response_id, 'resp_test_1');
  assert.ok(lastA(j).deadline_at > lastA(j).submitted_at);
  assert.equal(captures.listCaptures(ws).length, 0, 'the ID capture is removed once run.json has the ID');
  assert.equal(research.hasBackgroundWork(ws), true);
  // Still running: nothing is sent again.
  await research.runDueJobs(ws, { fetchImpl: f });
  assert.equal(f.posts(), 1);
  // A restart: a new process opens the same folder and only asks for the answer.
  const ws2 = openWorkspace({ root, actor: 'test' });
  await research.runDueJobs(ws2, { fetchImpl: f });
  assert.equal(f.posts(), 1, 'never sent twice');
  const done = await research.runDueJobs(ws2, { fetchImpl: f });
  assert.equal(done.results[0].status, 'completed', JSON.stringify(done.results));
  j = job(ws2, pid, run.run_id);
  assert.equal(j.state, 'completed');
  const a = lastA(j);
  assert.equal(a.phase, 'imported');
  assert.equal(a.usage.search_calls, 1, 'open_page is not a search');
  // 30,000 in x $2/M + 12,000 out (reasoning included) x $10/M + 1 search x $0.01
  assert.equal(a.cost_actual_usd, 0.19);
  assert.equal(research.hasBackgroundWork(ws2), false);
  const meta = readJson(path.join(root, 'projects', pid, 'reports', j.report_id, 'meta.json'));
  assert.equal(meta.provenance.attested.response_id, 'resp_test_1');
  const kinds = readJsonLines(path.join(root, 'logs', 'research-spend.jsonl')).map((l) => l.kind);
  assert.deepEqual(kinds, ['reservation', 'actual'], 'one reservation, one actual cost');
});

test('background: killed after the ID was captured, before run.json recorded it: the next run records the ID and collects the answer, never sending again', async (t) => {
  const { root, ws, pid } = setup(t, 'bg-capture-window');
  const run = research.createRun(ws, { project_id: pid, providers: ['chatgpt'] });
  const f = openai(ws, pid, { script: ['completed'] });
  await research.runDueJobs(ws, { fetchImpl: f });
  // Rewind to the moment between the ID capture and the commit.
  const file = path.join(root, 'projects', pid, 'research', run.run_id, 'run.json');
  const doc = readJson(file);
  const a = lastA(doc.jobs.chatgpt);
  captures.writeCapture(ws, { run: doc, provider: 'chatgpt', attempt: a, result: null, error: null, finishedAt: null, mode: 'api', submission: { response_id: a.response_id, status: 'queued', route: a.provider_route, submitted_at: a.submitted_at } });
  Object.assign(a, { phase: 'dispatched', response_id: undefined, submitted_at: undefined, deadline_at: undefined, provider_status: undefined, provider_route: undefined });
  atomicWrite(file, jsonText(doc));
  const out = await research.runDueJobs(openWorkspace({ root, actor: 'test' }), { fetchImpl: f });
  assert.equal(out.results[0].status, 'completed', JSON.stringify(out.results));
  assert.equal(f.posts(), 1, 'collected by the captured ID, not sent again');
  const j = job(ws, pid, run.run_id);
  assert.match(lastA(j).recovered_from, /captured but not saved/);
  assert.equal(captures.listCaptures(ws).length, 0);
});

test('background: killed after the provider accepted it, before its ID was captured: held as uncertain, never resent', async (t) => {
  const { root, ws, pid } = setup(t, 'bg-lost-id');
  const run = research.createRun(ws, { project_id: pid, providers: ['chatgpt'] });
  const f = openai(ws, pid, { script: ['completed'] });
  await research.runDueJobs(ws, { fetchImpl: f });
  const file = path.join(root, 'projects', pid, 'research', run.run_id, 'run.json');
  const doc = readJson(file);
  Object.assign(lastA(doc.jobs.chatgpt), { phase: 'dispatched', response_id: undefined, submitted_at: undefined, deadline_at: undefined });
  atomicWrite(file, jsonText(doc));
  await research.runDueJobs(openWorkspace({ root, actor: 'test' }), { fetchImpl: f });
  const j = job(ws, pid, run.run_id);
  assert.equal(j.state, 'uncertain');
  assert.equal(f.posts(), 1);
  await research.runDueJobs(ws, { fetchImpl: f });
  assert.equal(f.posts(), 1, 'an uncertain attempt is never resent by itself');
});

test('background: still running at its time limit, it is cancelled at the provider; the usage so far is recorded and nothing is saved as a report', async (t) => {
  const { root, ws, pid } = setup(t, 'bg-deadline', { chatgpt: CHATGPT }, { background_deadline_minutes: 5 });
  const run = research.createRun(ws, { project_id: pid, providers: ['chatgpt'] });
  const f = openai(ws, pid, { script: ['in_progress'] });
  await research.runDueJobs(ws, { fetchImpl: f });
  const file = path.join(root, 'projects', pid, 'research', run.run_id, 'run.json');
  const doc = readJson(file);
  const a0 = lastA(doc.jobs.chatgpt);
  assert.equal(Date.parse(a0.deadline_at) - Date.parse(a0.submitted_at), 5 * 60000);
  a0.deadline_at = new Date(Date.now() - 1000).toISOString();
  atomicWrite(file, jsonText(doc));
  await research.runDueJobs(ws, { fetchImpl: f });
  assert.ok(f.calls.some((c) => c.url.endsWith('/responses/resp_test_1/cancel') && c.method === 'POST'), 'cancelled at the provider');
  const j = job(ws, pid, run.run_id);
  assert.equal(j.state, 'failed');
  assert.match(j.error, /had not finished after 5 minutes/);
  const a = lastA(j);
  assert.equal(a.phase, 'errored');
  // 9,000 in + 1,000 out tokens; the cancelled response does not say how many
  // searches ran, so they count at the limit (5 x $0.01), never as zero.
  assert.equal(a.cost_actual_usd, 0.078);
  assert.equal(j.report_id, null);
});

test('background: your cancel stops the request at the provider at its next check', async (t) => {
  const { ws, pid } = setup(t, 'bg-cancel');
  const run = research.createRun(ws, { project_id: pid, providers: ['chatgpt'] });
  const f = openai(ws, pid, { script: ['in_progress'] });
  await research.runDueJobs(ws, { fetchImpl: f });
  const msg = research.cancelJob(ws, pid, run.run_id, 'chatgpt', 'test').message;
  assert.match(msg, /asks OpenAI to stop the request at its next check/);
  await research.runDueJobs(ws, { fetchImpl: f });
  const j = job(ws, pid, run.run_id);
  assert.equal(j.state, 'canceled');
  assert.equal(lastA(j).outcome, 'cancelled');
  assert.equal(f.posts(), 1);
});

test('background: an answer cut off at the output limit is recorded with its cost and never imported as a report', async (t) => {
  const { ws, pid } = setup(t, 'bg-incomplete');
  const run = research.createRun(ws, { project_id: pid, providers: ['chatgpt'] });
  const f = openai(ws, pid, { script: [(runId) => json(200, { ...completedChatgpt('partial text'), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })] });
  await research.runDueJobs(ws, { fetchImpl: f });
  await research.runDueJobs(ws, { fetchImpl: f });
  const j = job(ws, pid, run.run_id);
  assert.equal(j.state, 'failed');
  assert.match(j.error, /ran out of its output limit/);
  assert.equal(lastA(j).phase, 'errored');
  assert.equal(lastA(j).cost_actual_usd, 0.19);
  assert.equal(j.report_id, null);
  assert.equal(f.posts(), 1, 'not retried by itself: the outcome is known and billed');
});

test('background: a rate-limited create is not billed and is asked again after Retry-After; a 500-level create is held as uncertain', async (t) => {
  const { ws, pid } = setup(t, 'bg-429');
  const run = research.createRun(ws, { project_id: pid, providers: ['chatgpt'] });
  let n = 0;
  const f = openai(ws, pid, { create: () => (++n === 1 ? json(429, { error: { message: 'Rate limit reached' } }, { 'retry-after': '30' }) : json(200, { id: 'resp_test_1', status: 'queued' })), script: ['completed'] });
  await research.runDueJobs(ws, { fetchImpl: f });
  let j = job(ws, pid, run.run_id);
  assert.equal(j.state, 'queued');
  assert.ok(Date.parse(j.not_before) - Date.now() > 20000, 'waits for Retry-After');
  assert.equal(lastA(j).cost_actual_usd, 0, 'a refusal before any work is not billed');
  assert.match(lastA(j).not_billed, /not billed/);
  await research.runDueJobs(ws, { fetchImpl: f });
  assert.equal(f.posts(), 1, 'not asked again before Retry-After');
  const file = path.join(ws.root, 'projects', pid, 'research', run.run_id, 'run.json');
  const doc = readJson(file);
  doc.jobs.chatgpt.not_before = new Date(Date.now() - 1000).toISOString();
  atomicWrite(file, jsonText(doc));
  await research.runDueJobs(ws, { fetchImpl: f });
  assert.equal(f.posts(), 2, 'asked again once the wait is over');
  await research.runDueJobs(ws, { fetchImpl: f });
  assert.equal(job(ws, pid, run.run_id).state, 'completed');
  assert.equal(research.spendSoFar(ws, new Date(), { runId: run.run_id }).run, 0.19, 'only the answered request counts');

  const c = setup(t, 'bg-500');
  const run2 = research.createRun(c.ws, { project_id: c.pid, providers: ['chatgpt'] });
  const f2 = openai(c.ws, c.pid, { create: () => json(502, { error: { message: 'Bad gateway' } }) });
  await research.runDueJobs(c.ws, { fetchImpl: f2 });
  j = job(c.ws, c.pid, run2.run_id);
  assert.equal(j.state, 'uncertain', 'a 500-level answer may come from a request that ran');
  await research.runDueJobs(c.ws, { fetchImpl: f2 });
  assert.equal(f2.posts(), 1, 'never resent by itself');
});

test('background: checks that fail change nothing; a request the provider no longer has is held as uncertain, never resent', async (t) => {
  const { ws, pid } = setup(t, 'bg-404');
  const run = research.createRun(ws, { project_id: pid, providers: ['chatgpt'] });
  const f = openai(ws, pid, { script: ['network', '404'] });
  await research.runDueJobs(ws, { fetchImpl: f });
  await research.runDueJobs(ws, { fetchImpl: f });
  let j = job(ws, pid, run.run_id);
  assert.equal(lastA(j).phase, 'submitted', 'a failed check only means asking again');
  assert.match(lastA(j).poll_error, /Network error/);
  await research.runDueJobs(ws, { fetchImpl: f });
  j = job(ws, pid, run.run_id);
  assert.equal(j.state, 'uncertain');
  assert.match(j.error, /no longer has request resp_test_1/);
  assert.equal(f.posts(), 1);
});

test('background: Gemini runs through the Interactions API with Google Search; each query is billed at the declared per-query price', async (t) => {
  const { root, ws, pid } = setup(t, 'bg-gemini', { gemini: GEMINI });
  const st = research.providerStatus(ws).gemini;
  assert.equal(st.mode, 'api', st.reason);
  assert.equal(st.background, true);
  const plan = research.callPlan(ws, 'gemini', 'x'.repeat(3500));
  const fee = plan.parts.find((p) => p.part === 'search_fee');
  assert.equal(fee.basis, 'estimated', 'Gemini cannot cap searches: the fee is an estimate');
  assert.equal(fee.units, 20);
  const run = research.createRun(ws, { project_id: pid, providers: ['gemini'] });
  const calls = [];
  let runId = null;
  const f = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ url, method, body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers });
    if (url === 'https://generativelanguage.googleapis.com/v1beta/interactions' && method === 'POST') {
      runId = (String(JSON.parse(opts.body).input).match(/run_[A-Za-z0-9_-]+/) || [])[0];
      return json(200, { id: 'int_test_1', status: 'in_progress' });
    }
    if (url === 'https://generativelanguage.googleapis.com/v1beta/interactions/int_test_1' && method === 'GET') {
      const text = reportFor(ws, pid, 'gemini', runId);
      return json(200, { id: 'int_test_1', model: 'gemini-test-model', status: 'completed', steps: [{ type: 'user_input' }, { type: 'google_search_call', queries: ['a', 'b'] }, { type: 'google_search_result' }, { type: 'google_search_call', queries: ['c'] }, { type: 'model_output', content: [{ type: 'text', text, annotations: [{ type: 'url_citation', url: 'https://example.com', title: 'x' }] }] }], usage: { total_input_tokens: 20000, total_tool_use_tokens: 5000, total_output_tokens: 10000, total_thought_tokens: 5000, total_tokens: 40000 } });
    }
    throw new Error(`unexpected call ${method} ${url}`);
  };
  await research.runDueJobs(ws, { fetchImpl: f });
  const create = calls[0];
  assert.equal(create.body.model, 'gemini-test-model');
  assert.equal(create.body.background, true);
  assert.equal(create.body.store, true);
  assert.deepEqual(create.body.tools, [{ type: 'google_search' }]);
  assert.equal(create.body.generation_config.max_output_tokens, 20000);
  assert.equal(create.body.generation_config.thinking_level, 'high');
  assert.equal(create.headers['x-goog-api-key'], KEYS.GEMINI_API_KEY);
  assert.ok(create.headers['api-revision'], 'the documented API revision is sent');
  assert.ok(!/max_?uses|max_?tool|maxSearch/i.test(JSON.stringify(create.body)), 'no search cap is invented');
  await research.runDueJobs(ws, { fetchImpl: f });
  const j = job(ws, pid, run.run_id, 'gemini');
  assert.equal(j.state, 'completed', JSON.stringify(j));
  const a = lastA(j);
  assert.equal(a.usage.search_calls, 3);
  assert.equal(a.usage.input_tokens, 25000, 'search results are billed as input');
  assert.equal(a.usage.output_tokens, 15000, 'thinking is billed as output');
  // 25,000 x $2/M + 15,000 x $12/M + 3 queries x $0.014
  assert.equal(a.cost_actual_usd, 0.272);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
  assert.ok(fs.existsSync(path.join(root, 'projects', pid, 'reports', j.report_id)));
});

test('a job made while a model\'s API was not set up goes to the API, with its route, once the key and limits exist', async (t) => {
  const { root, cleanup } = tempWorkspace('bg-promote');
  t.after(cleanup);
  let ws = openWorkspace({ root, actor: 'test' });
  const pid = addFixtureProject(ws).project_id;
  const run = research.createRun(ws, { project_id: pid, providers: ['chatgpt'] });
  assert.equal(run.run.jobs.chatgpt.state, 'unconfigured');
  assert.equal(run.run.jobs.chatgpt.mode, 'manual');
  assert.deepEqual(research.sendWaitingToApi(ws, pid, run.run_id), [], 'nothing to send without an API');
  withKeys(t);
  ws = configure(root, { providers: { chatgpt: CHATGPT }, budget: BUDGET, max_output_tokens: 20000 });
  assert.deepEqual(research.sendWaitingToApi(ws, pid, run.run_id), ['chatgpt']);
  const j0 = job(ws, pid, run.run_id);
  assert.equal(j0.state, 'queued');
  assert.equal(j0.mode, 'api', 'the integrity rules key on the route');
  assert.equal(j0.route_changes[0].from, 'manual');
  const f = openai(ws, pid, { script: ['completed'] });
  await research.runDueJobs(ws, { fetchImpl: f });
  await research.runDueJobs(ws, { fetchImpl: f });
  assert.equal(job(ws, pid, run.run_id).state, 'completed');
  const kinds = readJsonLines(path.join(root, 'logs', 'research-spend.jsonl')).map((l) => l.kind);
  assert.deepEqual(kinds, ['reservation', 'actual'], 'spent and logged like any API job');
});

test('retry after a key was added sends the job with the API route, so a later timeout is held as uncertain, not resent', async (t) => {
  const { root, cleanup } = tempWorkspace('bg-retry-route');
  t.after(cleanup);
  let ws = openWorkspace({ root, actor: 'test' });
  const pid = addFixtureProject(ws).project_id;
  const run = research.createRun(ws, { project_id: pid, providers: ['chatgpt'] });
  withKeys(t);
  ws = configure(root, { providers: { chatgpt: { ...CHATGPT, api: 'blocking' } }, budget: BUDGET, max_output_tokens: 20000 });
  research.retryJob(ws, pid, run.run_id, 'chatgpt');
  assert.equal(job(ws, pid, run.run_id).mode, 'api');
  let n = 0;
  const f = async () => {
    n += 1;
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  };
  await research.runDueJobs(ws, { fetchImpl: f });
  await research.runDueJobs(ws, { fetchImpl: f });
  assert.equal(job(ws, pid, run.run_id).state, 'uncertain');
  assert.equal(n, 1, 'never resent by itself');
});

test('leases: a lease left by an earlier process with this process ID is free; at the online desk\'s start, leases of an earlier instance are released', (t) => {
  const { ws, cleanup } = tempWorkspace('bg-leases');
  t.after(cleanup);
  const dir = path.join(ws.root, '.cr', 'leases');
  fs.mkdirSync(dir, { recursive: true });
  const far = new Date(Date.now() + 3600000).toISOString();
  // Same host, same process ID, another boot: an earlier process.
  fs.writeFileSync(path.join(dir, 'job-research.json'), JSON.stringify({ token: 'x', name: 'job-research', pid: process.pid, boot: 'an-earlier-boot', host: os.hostname(), expires_at: far }));
  const tok = leases.acquireLease(ws, 'job-research', 60000);
  assert.ok(tok, 'taken over');
  leases.releaseLease(ws, 'job-research', tok);
  // Same host, same process, no boot recorded (older records): still held.
  fs.writeFileSync(path.join(dir, 'market.json'), JSON.stringify({ token: 'y', name: 'market', pid: process.pid, host: os.hostname(), expires_at: far }));
  assert.equal(leases.acquireLease(ws, 'market', 60000), null);
  // Another host (an earlier Render instance): held until released at start.
  fs.writeFileSync(path.join(dir, 'research-run_x-chatgpt.json'), JSON.stringify({ token: 'z', name: 'research-run_x-chatgpt', pid: 1, host: 'srv-earlier-instance', expires_at: far }));
  assert.equal(leases.acquireLease(ws, 'research-run_x-chatgpt', 60000), null);
  assert.deepEqual(leases.releaseForeignLeases(ws), ['research-run_x-chatgpt']);
  assert.ok(leases.acquireLease(ws, 'research-run_x-chatgpt', 60000));
});
