'use strict';
// Draining waiting research (2026-10-21): a call that only today's or this
// month's limit stops waits in the queue for that limit instead of failing,
// and one click sends every job still waiting for a model's assistant to that
// model's API once it is set up. Providers are in-process fetch stubs; keys
// are fake test values; nothing leaves this PC.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tempWorkspace, addFixtureProject } = require('./helpers');
const research = require('../core/research');
const { mockReport } = require('../core/demo');
const { readJson, atomicWrite, jsonText } = require('../core/fsx');
const { openWorkspace } = require('../core/workspace');
const { runOp } = require('../core/ops');

const KEYS = { ANTHROPIC_API_KEY: 'test-key-not-real-a', OPENAI_API_KEY: 'test-key-not-real-o', GEMINI_API_KEY: 'test-key-not-real-g' };
const NAMES = { claude: 'Claude (Anthropic)', chatgpt: 'ChatGPT (OpenAI)', gemini: 'Gemini (Google)' };
const FIXTURE_NAMES = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };
const MODELS = { claude: 'claude-test-model', chatgpt: 'gpt-test-model', gemini: 'gemini-test-model' };
const BLOCKING = { claude: {}, chatgpt: { api: 'blocking' }, gemini: { api: 'generate_content' } };
// A $1.00 reservation: 10,000 output tokens at $100 per million, free input, no search.
const DOLLAR = { input_usd_per_mtok: 0, output_usd_per_mtok: 100, search_usd_per_call: 0.01, max_searches: 0 };
const providersAll = (cfg) => Object.fromEntries(Object.keys(MODELS).map((p) => [p, { model: MODELS[p], ...BLOCKING[p], ...cfg }]));

function withKeys(t, keys = KEYS) {
  const prev = {};
  for (const k of [...Object.keys(KEYS), 'GOOGLE_API_KEY']) {
    prev[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, keys);
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

function configure(root, patch) {
  const file = path.join(root, 'config', 'settings.json');
  const s = readJson(file);
  s.research = { ...s.research, ...patch };
  atomicWrite(file, jsonText(s));
  return openWorkspace({ root, actor: 'test' });
}

const promptOf = (provider, body) => (provider === 'claude' ? body.messages[0].content : provider === 'chatgpt' ? body.input : body.contents[0].parts[0].text);
function answerFor(provider, text) {
  const u = { input: 5000, output: 10000 };
  if (provider === 'claude') return { id: 'msg_stub', model: MODELS.claude, stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: u.input, output_tokens: u.output, server_tool_use: { web_search_requests: 0 } } };
  if (provider === 'chatgpt') return { id: 'resp_stub', model: MODELS.chatgpt, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: u.input, output_tokens: u.output } };
  return { responseId: 'g_stub', modelVersion: MODELS.gemini, candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP', groundingMetadata: { webSearchQueries: [] } }], usageMetadata: { promptTokenCount: u.input, candidatesTokenCount: u.output } };
}
function stubFetch(ws, pid) {
  const calls = [];
  const f = async (url, opts) => {
    const provider = url.startsWith('https://api.anthropic.com/') ? 'claude' : url.startsWith('https://api.openai.com/') ? 'chatgpt' : url.startsWith('https://generativelanguage.googleapis.com/') ? 'gemini' : null;
    if (!provider) throw new Error(`unexpected URL ${url}`);
    const body = JSON.parse(opts.body);
    calls.push({ provider, url });
    const run = research.listRuns(ws, pid).find((r) => promptOf(provider, body).includes(r.run_id));
    const text = mockReport(ws, provider, run).replace(`FICTIONAL demo fixture standing in for ${FIXTURE_NAMES[provider]}`, NAMES[provider]);
    return { ok: true, status: 200, headers: { get: (k) => (k === 'request-id' ? 'req_stub' : null) }, text: async () => JSON.stringify(answerFor(provider, text)) };
  };
  f.calls = calls;
  return f;
}

test('budget wait: the next day and month start at the desk\'s midnight, across a clock change', () => {
  // 09:00 in New York (EDT) on Oct 21, 2026: the next day starts at 04:00 UTC.
  assert.equal(research.nextBudgetWindow(new Date('2026-10-21T13:00:00Z'), 'daily').toISOString(), '2026-10-22T04:00:00.000Z');
  // The month: November 1 starts before the clocks go back that night.
  assert.equal(research.nextBudgetWindow(new Date('2026-10-21T13:00:00Z'), 'monthly').toISOString(), '2026-11-01T04:00:00.000Z');
  // After the change (EST) midnight is 05:00 UTC.
  assert.equal(research.nextBudgetWindow(new Date('2026-11-01T12:00:00Z'), 'daily').toISOString(), '2026-11-02T05:00:00.000Z');
  // Just before midnight, the window is minutes away, never the day after.
  assert.equal(research.nextBudgetWindow(new Date('2026-10-22T03:59:30Z'), 'daily').toISOString(), '2026-10-22T04:00:00.000Z');
});

test('budget wait: a call only the daily limit stops stays queued, is not asked again before the limit resets, and needs no Retry', async (t) => {
  withKeys(t);
  const { root, cleanup } = tempWorkspace('drain-daily');
  t.after(cleanup);
  let ws = openWorkspace({ root, actor: 'test' });
  const pid = addFixtureProject(ws).project_id;
  ws = configure(root, { providers: providersAll(DOLLAR), budget: { per_run_usd: 10, daily_usd: 1.5, monthly_usd: 100 }, max_output_tokens: 10000, max_concurrent: 1 });
  const run1 = research.createRun(ws, { project_id: pid, providers: ['claude'] });
  const run2 = research.createRun(ws, { project_id: pid, providers: ['chatgpt'], refresh: true });
  const f = stubFetch(ws, pid);
  const out = await research.runDueJobs(ws, { fetchImpl: f });
  assert.equal(f.calls.length, 1, 'one $1.00 call fits the $1.50 day');
  // Whichever the runner took first is sent; the other waits.
  const jobOf = (run, p) => research.loadRun(ws, pid, run.run_id).jobs[p];
  const [sent, held] = f.calls[0].provider === 'claude' ? [[run1, 'claude'], [run2, 'chatgpt']] : [[run2, 'chatgpt'], [run1, 'claude']];
  assert.equal(jobOf(...sent).state, 'completed');
  const waiting = jobOf(...held);
  assert.equal(waiting.state, 'queued', 'waits in the queue; not failed');
  assert.equal(waiting.attempts.length, 0, 'nothing was sent');
  assert.equal(waiting.budget_wait.limit, 'daily');
  assert.match(waiting.error, /Waiting for the day's budget, not sent: .*daily limit of \$1\.50.*Nothing was sent or billed\./);
  // No call is still open, so it waits for the day's limit to reset.
  assert.equal(waiting.not_before, research.nextBudgetWindow(new Date(waiting.budget_wait.at), 'daily').toISOString());
  assert.match(out.summary, /0 failed or refused, 1 waiting for the budget/);
  // Asked again before then: nothing is sent.
  const again = await research.runDueJobs(ws, { fetchImpl: f });
  assert.equal(f.calls.length, 1);
  assert.equal(again.status, 'noop');
  // Once the window opens (here: the limit raised and the wait over), the
  // same job goes out by itself.
  runOp(ws, { type: 'test_time_passes', summary: 'the wait is over' }, (op) => {
    const rel = `projects/${pid}/research/${held[0].run_id}/run.json`;
    const r = op.readJson(rel);
    r.jobs[held[1]].not_before = new Date(Date.now() - 1000).toISOString();
    op.writeJson(rel, r);
  });
  ws = configure(root, { budget: { per_run_usd: 10, daily_usd: 5, monthly_usd: 100 } });
  await research.runDueJobs(ws, { fetchImpl: f });
  assert.equal(f.calls.length, 2);
  const done = jobOf(...held);
  assert.equal(done.state, 'completed');
  assert.equal(done.budget_wait, undefined);
  assert.equal(done.budget_refused, undefined);
});

test('budget wait: a call larger than the daily limit itself still fails; it could never fit', async (t) => {
  withKeys(t);
  const { root, cleanup } = tempWorkspace('drain-too-large');
  t.after(cleanup);
  let ws = openWorkspace({ root, actor: 'test' });
  const pid = addFixtureProject(ws).project_id;
  ws = configure(root, { providers: providersAll(DOLLAR), budget: { per_run_usd: 10, daily_usd: 0.5, monthly_usd: 100 }, max_output_tokens: 10000 });
  const run = research.createRun(ws, { project_id: pid, providers: ['claude'] });
  const f = stubFetch(ws, pid);
  await research.runDueJobs(ws, { fetchImpl: f });
  const j = research.loadRun(ws, pid, run.run_id).jobs.claude;
  assert.equal(f.calls.length, 0);
  assert.equal(j.state, 'failed');
  assert.equal(j.budget_refused, true);
  assert.equal(j.budget_wait, undefined);
});

test('send waiting: one click sends every waiting job whose API is set up now; a held model, a pending identity and an archived project are left', async (t) => {
  withKeys(t, {});
  const { root, cleanup } = tempWorkspace('drain-send');
  t.after(cleanup);
  let ws = openWorkspace({ root, actor: 'test' });
  const pid = addFixtureProject(ws).project_id;
  ws = configure(root, { providers: providersAll(DOLLAR), budget: { per_run_usd: 10, daily_usd: 10, monthly_usd: 100 }, max_output_tokens: 10000 });
  // Made while no key was set: every job waits for its model's assistant.
  const run = research.createRun(ws, { project_id: pid, providers: ['claude', 'chatgpt', 'gemini'] });
  for (const p of ['claude', 'chatgpt', 'gemini']) assert.equal(research.loadRun(ws, pid, run.run_id).jobs[p].state, 'unconfigured', p);
  assert.deepEqual(research.waitingForApi(ws).sendable, [], 'no API is set up: nothing can be sent');
  // Keys arrive for ChatGPT and Gemini; Gemini is on hold.
  withKeys(t, { OPENAI_API_KEY: KEYS.OPENAI_API_KEY, GEMINI_API_KEY: KEYS.GEMINI_API_KEY });
  ws = configure(root, { on_hold: { gemini: { since: '2026-10-04', reason: 'test hold' } } });
  const w = research.waitingForApi(ws);
  assert.deepEqual(w.sendable.map((x) => x.provider), ['chatgpt']);
  assert.equal(w.left.held, 1, 'Gemini is on hold');
  assert.equal(w.left.manual, 1, 'Claude has no key');
  const out = research.sendAllWaitingToApi(ws);
  assert.deepEqual(out.sent, [{ project_id: pid, run_id: run.run_id, provider: 'chatgpt' }]);
  const r = research.loadRun(ws, pid, run.run_id);
  assert.equal(r.jobs.chatgpt.state, 'queued');
  assert.equal(r.jobs.chatgpt.mode, 'api');
  assert.equal(r.jobs.gemini.state, 'unconfigured', 'a held model is never sent');
  assert.equal(r.jobs.claude.state, 'unconfigured');
  // Sending again changes nothing.
  assert.deepEqual(research.sendAllWaitingToApi(ws).sent, []);
  // A project whose identity is not verified keeps its waiting jobs.
  const run2 = research.createRun(ws, { project_id: pid, providers: ['claude'], refresh: true });
  assert.equal(research.loadRun(ws, pid, run2.run_id).jobs.claude.state, 'unconfigured');
  withKeys(t, KEYS);
  ws = configure(root, { on_hold: { gemini: { since: '2026-10-04', reason: 'test hold' } } });
  runOp(ws, { type: 'test_identity_pending', summary: 'identity reopened' }, (op) => {
    const rel = `projects/${pid}/project.json`;
    const p = op.readJson(rel);
    p.identity.status = 'pending';
    op.writeJson(rel, p);
  });
  const w2 = research.waitingForApi(ws);
  assert.equal(w2.sendable.length, 0);
  assert.equal(w2.left.identity, 2, 'Claude in both runs waits for the identity');
  assert.deepEqual(research.sendAllWaitingToApi(ws).sent, []);
});
