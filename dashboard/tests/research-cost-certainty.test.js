'use strict';
// Cost certainty (independent review, 2026-10-03): a cost is "actual" only when
// the provider reported every billable quantity. When it did not (usually how
// many searches ran), the cost is an estimate, the reserved capacity is never
// released on an assumed count, concurrent jobs cannot spend it, and the owner
// reconciles it once from the provider's billing. Providers are in-process
// stand-ins; keys are fake test values; nothing leaves this PC.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tempWorkspace, addFixtureProject } = require('./helpers');
const research = require('../core/research');
const providers = require('../core/providers');
const { mockReport } = require('../core/demo');
const { readJson, atomicWrite, jsonText, readJsonLines } = require('../core/fsx');
const { openWorkspace } = require('../core/workspace');

const KEYS = { OPENAI_API_KEY: 'test-key-not-real-o', GEMINI_API_KEY: 'test-key-not-real-g' };
const GEMINI = { model: 'gemini-test-model', input_usd_per_mtok: 2, output_usd_per_mtok: 12, search_usd_per_call: 0.014, max_searches: 20, search_billing: 'per_query', effort: 'high' };
const CHATGPT = { model: 'gpt-test-model', input_usd_per_mtok: 2, output_usd_per_mtok: 10, search_usd_per_call: 0.01, max_searches: 5, effort: 'high' };

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

function setup(t, label, researchSettings) {
  withKeys(t);
  const { root, cleanup } = tempWorkspace(label);
  t.after(cleanup);
  let ws = openWorkspace({ root, actor: 'test' });
  const pid = addFixtureProject(ws).project_id;
  const file = path.join(root, 'config', 'settings.json');
  const s = readJson(file);
  s.research = researchSettings;
  atomicWrite(file, jsonText(s));
  ws = openWorkspace({ root, actor: 'test' });
  return { root, ws, pid };
}

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
const reportFor = (ws, pid, provider, runId) => mockReport(ws, provider, research.loadRun(ws, pid, runId)).replace(/FICTIONAL demo fixture standing in for \w+/, provider === 'chatgpt' ? 'ChatGPT (OpenAI)' : 'Gemini (Google)');

// Gemini Interactions stand-in. searchSteps: the google_search_call steps the
// finished answer carries (with or without their queries list).
function gemini(ws, pid, { searchSteps, usage = { total_input_tokens: 20000, total_output_tokens: 10000 } }) {
  const calls = [];
  let runId = null;
  const f = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ url, method });
    if (url === 'https://generativelanguage.googleapis.com/v1beta/interactions' && method === 'POST') {
      runId = (String(JSON.parse(opts.body).input).match(/run_[A-Za-z0-9_-]+/) || [])[0];
      return json(200, { id: 'int_cost_1', status: 'in_progress' });
    }
    if (url === 'https://generativelanguage.googleapis.com/v1beta/interactions/int_cost_1' && method === 'GET') {
      return json(200, { id: 'int_cost_1', status: 'completed', steps: [...searchSteps, { type: 'model_output', content: [{ type: 'text', text: reportFor(ws, pid, 'gemini', runId) }] }], usage });
    }
    if (url === 'https://api.openai.com/v1/responses' && method === 'POST') return json(200, { id: 'resp_cost_1', status: 'queued' });
    throw new Error(`unexpected call ${method} ${url}`);
  };
  f.calls = calls;
  f.posts = () => calls.filter((c) => c.method === 'POST').length;
  return f;
}

test('cost: known tokens with an unknown Gemini search count are an estimate, never an actual cost, and the reservation keeps counting (the review\'s case)', (t) => {
  const { ws } = setup(t, 'cost-review-case', { providers: { gemini: GEMINI }, budget: { per_run_usd: 5, daily_usd: 10, monthly_usd: 40 }, max_output_tokens: 48000 });
  const plan = research.callPlan(ws, 'gemini', 'x'.repeat(30000));
  assert.equal(plan.total_usd, 1.0331);
  const attempt = { prices: plan.prices, bounds: plan.bounds, estimate: { parts: plan.parts }, reserved_usd: plan.total_usd };
  const usage = { input_tokens: 1000, output_tokens: 1000, search_calls: null };
  assert.equal(research.actualCostUsd(ws, 'gemini', usage, attempt), null, 'not an actual cost');
  const c = research.costFromUsage(ws, 'gemini', usage, attempt);
  assert.equal(c.status, 'incomplete');
  assert.deepEqual(c.unknown, ['search_calls']);
  assert.equal(c.known_usd, 0.014, '1,000 in x $2/M + 1,000 out x $12/M');
  assert.equal(c.held_usd, 0.28, 'the reserved search estimate is kept for the unreported searches');
  assert.equal(c.usd, 0.294);
  const charge = research.attemptCharge({ phase: 'imported', reserved_usd: plan.total_usd, cost_usage_estimate_usd: c.usd });
  assert.deepEqual(charge, { usd: 1.0331, basis: 'estimated' }, 'never released below the reservation on an assumed count');
  // With the count reported, it is actual.
  assert.equal(research.actualCostUsd(ws, 'gemini', { ...usage, search_calls: 3 }, attempt), 0.056);
  // An estimate above the reservation counts in full.
  assert.equal(research.attemptCharge({ phase: 'imported', reserved_usd: 0.5, cost_usage_estimate_usd: 0.9 }).usd, 0.9);
});

test('cost: a Gemini search step without its queries leaves the count unknown, never assumed', () => {
  const read = (steps) => providers.readGemini({ id: 'x', status: 'completed', steps: [...steps, { type: 'model_output', content: [{ type: 'text', text: 'hi' }] }], usage: { total_input_tokens: 10, total_output_tokens: 10 } }, '{}', null).usage.search_calls;
  assert.equal(read([{ type: 'google_search_call', queries: ['a', 'b'] }, { type: 'google_search_call', queries: ['c'] }]), 3);
  assert.equal(read([{ type: 'google_search_call', queries: ['a'] }, { type: 'google_search_call' }]), null);
  assert.equal(read([]), 0, 'a full timeline with no searches is zero searches');
  assert.equal(providers.readGemini({ id: 'x', status: 'completed', usage: {} }, '{}', null).usage.search_calls, null, 'no timeline: unknown');
});

test('cost: an answer with incomplete usage is saved as a report, logged as an estimate, held at its reservation, and reconciled once', async (t) => {
  const { root, ws, pid } = setup(t, 'cost-incomplete', { providers: { gemini: GEMINI }, budget: { per_run_usd: 5, daily_usd: 10, monthly_usd: 40 }, max_output_tokens: 20000 });
  const run = research.createRun(ws, { project_id: pid, providers: ['gemini'] });
  const f = gemini(ws, pid, { searchSteps: [{ type: 'google_search_call' }, { type: 'google_search_call', queries: ['b'] }] });
  await research.runDueJobs(ws, { fetchImpl: f });
  await research.runDueJobs(ws, { fetchImpl: f });
  const job = () => research.loadRun(ws, pid, run.run_id).jobs.gemini;
  assert.equal(job().state, 'completed', 'the report itself is saved');
  const a = job().attempts[0];
  assert.equal(a.phase, 'imported');
  assert.equal(a.cost_actual_usd, null);
  assert.equal(a.cost_status, 'estimated');
  assert.match(a.cost_note, /did not report how many searches ran/);
  const reserved = a.reserved_usd;
  assert.ok(a.cost_usage_estimate_usd < reserved, 'this estimate is below the reservation');
  const spent = () => research.spendSoFar(ws, new Date(), { runId: run.run_id });
  assert.equal(spent().run, reserved, 'counts at the reservation, not the lower estimate');
  assert.equal(spent().estimated_attempts, 1);
  const lines = readJsonLines(path.join(root, 'logs', 'research-spend.jsonl'));
  assert.deepEqual(lines.map((l) => l.kind), ['reservation', 'usage_incomplete'], 'no actual-cost line for an incomplete usage');
  assert.equal(lines[1].estimate_usd, reserved);
  assert.equal(lines[1].actual_usd, null);
  // Running again records nothing twice.
  await research.runDueJobs(ws, { fetchImpl: f });
  assert.equal(readJsonLines(path.join(root, 'logs', 'research-spend.jsonl')).length, 2);
  // Eric reads the charge from Google's billing and reconciles it once.
  const rec = research.reconcileAttempt(ws, pid, run.run_id, 'gemini', { charged_usd: '0.31', reason: 'test: Google billing shows $0.31' });
  assert.equal(rec.status, 'saved');
  const b = job().attempts[0];
  assert.equal(b.phase, 'imported', 'the report link stays');
  assert.equal(b.cost_status, 'reconciled');
  assert.equal(research.attemptCharge(b).basis, 'reconciled');
  assert.equal(spent().run, 0.31);
  assert.equal(job().state, 'completed');
  assert.equal(research.reconcileAttempt(ws, pid, run.run_id, 'gemini', { attempt: 1, charged_usd: '0.31', reason: 'again' }).message, 'Attempt #1 is already reconciled at $0.31.');
  assert.throws(() => research.reconcileAttempt(ws, pid, run.run_id, 'gemini', { attempt: 1, charged_usd: '0.50', reason: 'different' }), (e) => e.code === 'CONFLICT');
  assert.equal(readJsonLines(path.join(root, 'logs', 'research-spend.jsonl')).filter((l) => l.kind === 'reconciled').length, 1);
});

test('cost: concurrent jobs and retries cannot spend capacity held for an unreported search count', async (t) => {
  // The per-run limit fits the Gemini reservation, not Gemini plus ChatGPT.
  const { ws, pid } = setup(t, 'cost-concurrent', { providers: { gemini: GEMINI, chatgpt: CHATGPT }, budget: { per_run_usd: 0.9, daily_usd: 10, monthly_usd: 40 }, max_output_tokens: 20000, max_concurrent: 2 });
  const rg = research.callPlan(ws, 'gemini', 'x'.repeat(20000)).total_usd;
  const rc = research.callPlan(ws, 'chatgpt', 'x'.repeat(20000)).total_usd;
  assert.ok(rg <= 0.9 && rg + rc > 0.9, `reservations ${rg} + ${rc}`);
  const run = research.createRun(ws, { project_id: pid, providers: ['gemini', 'chatgpt'] });
  const f = gemini(ws, pid, { searchSteps: [{ type: 'google_search_call' }] });
  const first = await research.runDueJobs(ws, { fetchImpl: f });
  const byProvider = Object.fromEntries(first.results.map((r) => [r.provider, r.status]));
  assert.equal(byProvider.gemini, 'submitted');
  assert.equal(byProvider.chatgpt, 'budget_refused', 'two jobs at once: the second is refused under the shared lock');
  await research.runDueJobs(ws, { fetchImpl: f });
  const r = research.loadRun(ws, pid, run.run_id);
  assert.equal(r.jobs.gemini.state, 'completed');
  assert.equal(r.jobs.gemini.attempts[0].cost_status, 'estimated');
  // A retry of ChatGPT is still refused: the Gemini estimate is lower than its
  // reservation, but the unreported searches keep the whole reservation held.
  research.retryJob(ws, pid, run.run_id, 'chatgpt');
  const again = await research.runDueJobs(ws, { fetchImpl: f });
  assert.equal(again.results.find((x) => x.provider === 'chatgpt').status, 'budget_refused');
  assert.equal(f.calls.filter((c) => c.url === 'https://api.openai.com/v1/responses').length, 0, 'ChatGPT was never sent');
  // Repeating the request starts nothing new and spends nothing.
  const repeat = research.createRun(ws, { project_id: pid, providers: ['gemini', 'chatgpt'] });
  assert.equal(repeat.status, 'exists');
  const posts = f.posts();
  await research.runDueJobs(ws, { fetchImpl: f });
  assert.equal(f.posts(), posts);
  // Once reconciled at the billed amount, the capacity is free again.
  research.reconcileAttempt(ws, pid, run.run_id, 'gemini', { charged_usd: '0.30', reason: 'test: billing page' });
  research.retryJob(ws, pid, run.run_id, 'chatgpt');
  const freed = await research.runDueJobs(ws, { fetchImpl: f });
  assert.equal(freed.results.find((x) => x.provider === 'chatgpt').status, 'submitted');
});
