'use strict';
// Aggregate spending and honest tool bounds (audit V2-004/005). Providers are
// in-process fetch stubs (or a local stub server for the multi-process test);
// keys are fake test values; nothing leaves this PC.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { tempWorkspace, addFixtureProject } = require('./helpers');
const research = require('../core/research');
const projects = require('../core/projects');
const { validateSettingsPatch } = require('../server');
const { mockReport } = require('../core/demo');
const { readJson, atomicWrite, jsonText, readJsonLines } = require('../core/fsx');
const { openWorkspace } = require('../core/workspace');

const CHILD = path.join(__dirname, 'children', 'child-research-runner.js');
const KEYS = { ANTHROPIC_API_KEY: 'test-key-not-real-a', OPENAI_API_KEY: 'test-key-not-real-o', GEMINI_API_KEY: 'test-key-not-real-g' };
const NAMES = { claude: 'Claude (Anthropic)', chatgpt: 'ChatGPT (OpenAI)', gemini: 'Gemini (Google)' };
const FIXTURE_NAMES = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };

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

function configure(root, research) {
  const file = path.join(root, 'config', 'settings.json');
  const s = readJson(file);
  s.research = research;
  atomicWrite(file, jsonText(s));
  return openWorkspace({ root, actor: 'test' });
}

// A $1.00 reservation: 10,000 output tokens at $100 per million, free input, no search.
const DOLLAR = { input_usd_per_mtok: 0, output_usd_per_mtok: 100, search_usd_per_call: 0.01, max_searches: 0 };
const MODELS = { claude: 'claude-test-model', chatgpt: 'gpt-test-model', gemini: 'gemini-test-model' };

const promptOf = (provider, body) => (provider === 'claude' ? body.messages[0].content : provider === 'chatgpt' ? body.input : body.contents[0].parts[0].text);

function answerFor(provider, text, u) {
  if (provider === 'claude') return { id: 'msg_stub', model: MODELS.claude, stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: u.input, output_tokens: u.output, server_tool_use: { web_search_requests: u.searches } } };
  if (provider === 'chatgpt') {
    const searches = Array.from({ length: u.searches }, () => ({ type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'x' } }));
    return { id: 'resp_stub', model: MODELS.chatgpt, status: 'completed', output: [...searches, { type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: u.input, output_tokens: u.output } };
  }
  return { responseId: 'g_stub', modelVersion: MODELS.gemini, candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP', groundingMetadata: { webSearchQueries: Array.from({ length: u.searches }, () => 'x') } }], usageMetadata: { promptTokenCount: u.input, candidatesTokenCount: u.output } };
}

// The answer text a provider gives for whichever run its prompt belongs to.
function texts(ws, pid) {
  return (provider, prompt) => {
    const run = research.listRuns(ws, pid).find((r) => prompt.includes(r.run_id));
    return mockReport(ws, provider, run).replace(`FICTIONAL demo fixture standing in for ${FIXTURE_NAMES[provider]}`, NAMES[provider]);
  };
}

function stubFetch(textOf, { usage = { input: 5000, output: 10000, searches: 0 }, behavior = null } = {}) {
  const calls = [];
  const f = async (url, opts) => {
    const provider = url.startsWith('https://api.anthropic.com/') ? 'claude' : url.startsWith('https://api.openai.com/') ? 'chatgpt' : url.startsWith('https://generativelanguage.googleapis.com/') ? 'gemini' : null;
    if (!provider) throw new Error(`unexpected URL ${url}`);
    const body = JSON.parse(opts.body);
    calls.push({ provider, url, body });
    const b = behavior ? behavior(provider, calls.length) : 'ok';
    if (b === 'timeout') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    if (b === 'http500') return { ok: false, status: 500, headers: { get: () => null }, text: async () => JSON.stringify({ error: { message: 'stub overloaded' } }) };
    return { ok: true, status: 200, headers: { get: (k) => (k === 'request-id' ? 'req_stub' : null) }, text: async () => JSON.stringify(answerFor(provider, textOf(provider, promptOf(provider, body)), usage)) };
  };
  f.calls = calls;
  return f;
}

function setup(t, label, researchSettings) {
  withKeys(t);
  const { root, cleanup } = tempWorkspace(label);
  t.after(cleanup);
  let ws = openWorkspace({ root, actor: 'test' });
  const pid = addFixtureProject(ws).project_id;
  ws = configure(root, researchSettings);
  return { root, ws, pid };
}

// These tests cover the blocking calls; the background routes (the default for
// ChatGPT and Gemini) are covered in research-background.test.js.
const BLOCKING = { claude: {}, chatgpt: { api: 'blocking' }, gemini: { api: 'generate_content' } };
const providersAll = (cfg) => Object.fromEntries(Object.keys(MODELS).map((p) => [p, { model: MODELS[p], ...BLOCKING[p], ...cfg }]));

test('V2-004 a $1.10 per-run limit with three $1.00 calls: one is sent, the other two are refused before sending', async (t) => {
  const { ws, pid } = setup(t, 'v2004-run', { providers: providersAll(DOLLAR), budget: { per_run_usd: 1.1, daily_usd: 100, monthly_usd: 100 }, max_output_tokens: 10000 });
  for (const p of Object.keys(MODELS)) assert.equal(research.providerStatus(ws)[p].mode, 'api', p);
  const run = research.createRun(ws, { project_id: pid, providers: ['claude', 'chatgpt', 'gemini'] });
  const f = stubFetch(texts(ws, pid));
  const out = await research.runDueJobs(ws, { fetchImpl: f });
  assert.equal(f.calls.length, 1, 'one call reached a provider');
  assert.equal(research.callPlan(ws, 'claude', 'x').total_usd, 1, 'each call reserves $1.00');
  const st = out.results.map((r) => r.status).sort();
  assert.deepEqual(st, ['budget_refused', 'budget_refused', 'completed']);
  const r = research.loadRun(ws, pid, run.run_id);
  for (const j of Object.values(r.jobs).filter((x) => x.state !== 'completed')) {
    assert.equal(j.attempts.length, 0, 'refused before any attempt');
    assert.match(j.error, /per-run limit of \$1\.10/);
    assert.match(j.error, /every model and attempt/);
  }
  const spent = research.spendSoFar(ws, new Date(), { runId: run.run_id });
  assert.equal(spent.run, 1);
  assert.ok(spent.run <= 1.1);
});

// A local provider stand-in for runner processes: answers after a delay.
async function stubServer(textOf, delayMs = 300) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      calls.push(req.url);
      const b = JSON.parse(body);
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_srv' });
        res.end(JSON.stringify(answerFor('claude', textOf('claude', b.messages[0].content), { input: 5000, output: 10000, searches: 0 })));
      }, delayMs);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, calls, close: () => server.close() };
}

test('V2-004 four runner processes started together cannot pass the daily limit between them', async (t) => {
  const { root, ws, pid } = setup(t, 'v2004-conc', { providers: { claude: { model: MODELS.claude, ...DOLLAR } }, budget: { per_run_usd: 5, daily_usd: 1.5, monthly_usd: 100 }, max_output_tokens: 10000, max_concurrent: 1 });
  const runs = [];
  for (let i = 0; i < 4; i++) runs.push(research.createRun(ws, { project_id: pid, providers: ['claude'], force_new: true }).run_id);
  const srv = await stubServer(texts(ws, pid));
  t.after(() => srv.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-conc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const barrier = path.join(dir, 'go');
  const children = [];
  for (let i = 0; i < 4; i++) {
    const cfg = path.join(dir, `c${i}.json`);
    fs.writeFileSync(cfg, JSON.stringify({ stub_port: srv.port, crash: null, barrier }));
    children.push(new Promise((resolve) => {
      const c = cp.spawn(process.execPath, [CHILD, root, cfg], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...KEYS } });
      let err = '';
      c.stderr.on('data', (d) => { err += d; });
      c.on('exit', (code) => resolve({ code, err }));
    }));
  }
  await new Promise((r) => setTimeout(r, 400));
  fs.writeFileSync(barrier, 'go');
  const done = await Promise.all(children);
  for (const d of done) assert.equal(d.code, 0, d.err);
  assert.equal(srv.calls.length, 1, `exactly one request reached the provider (got ${srv.calls.length})`);
  const jobs = runs.map((id) => research.loadRun(ws, pid, id).jobs.claude);
  assert.equal(jobs.filter((j) => j.state === 'completed').length, 1);
  assert.equal(jobs.filter((j) => j.budget_refused && /daily limit/.test(j.error)).length, 3);
  const spent = research.spendSoFar(ws);
  assert.equal(spent.daily, 1);
  assert.ok(spent.daily <= 1.5);
});

test('V2-004 retries, provider errors and uncertain attempts all count against the per-run limit until reconciled', async (t) => {
  const { ws, pid } = setup(t, 'v2004-retry', { providers: { claude: { model: MODELS.claude, ...DOLLAR } }, budget: { per_run_usd: 2.5, daily_usd: 100, monthly_usd: 100 }, max_output_tokens: 10000, max_attempts: 2 });
  const run = research.createRun(ws, { project_id: pid, providers: ['claude'] });
  const job = () => research.loadRun(ws, pid, run.run_id).jobs.claude;
  const spentRun = () => research.spendSoFar(ws, new Date(), { runId: run.run_id }).run;
  const plan = ['timeout', 'http500', 'ok'];
  const f = stubFetch(texts(ws, pid), { behavior: (p, n) => plan[n - 1] || 'ok' });
  await research.runDueJobs(ws, { fetchImpl: f });
  assert.equal(job().state, 'uncertain');
  assert.equal(spentRun(), 1);
  await research.runDueJobs(ws, { fetchImpl: f });
  assert.equal(f.calls.length, 1, 'an uncertain attempt is not retried automatically');
  research.retryJob(ws, pid, run.run_id, 'claude');
  await research.runDueJobs(ws, { fetchImpl: f });
  assert.equal(f.calls.length, 2);
  assert.equal(job().attempts[1].phase, 'uncertain', 'a 500-level answer may come from a request that ran');
  assert.equal(job().state, 'uncertain', 'held, never resent by itself');
  await research.runDueJobs(ws, { fetchImpl: f });
  assert.equal(f.calls.length, 2, 'the 500 is not resent automatically');
  assert.equal(spentRun(), 2, 'the HTTP error keeps its reservation: its cost is not known');
  research.retryJob(ws, pid, run.run_id, 'claude');
  const refused = await research.runDueJobs(ws, { fetchImpl: f });
  assert.equal(refused.results[0].status, 'budget_refused');
  assert.equal(f.calls.length, 2, 'not sent: $2.00 counted + $1.00 would pass $2.50');
  assert.match(job().error, /plus \$2\.00 already counted for this run/);
  // The owner checks the provider's usage page: attempt 1 was never billed.
  research.reconcileAttempt(ws, pid, run.run_id, 'claude', { attempt: 1, not_charged: true, reason: 'test: not on the usage page' });
  assert.equal(spentRun(), 1);
  research.retryJob(ws, pid, run.run_id, 'claude');
  await research.runDueJobs(ws, { fetchImpl: f });
  assert.equal(f.calls.length, 3);
  assert.equal(job().state, 'completed');
  assert.equal(spentRun(), 2);
  research.reconcileAttempt(ws, pid, run.run_id, 'claude', { attempt: 2, charged_usd: '0', reason: 'test: 500 responses are not billed' });
  assert.equal(spentRun(), 1);
  // Older code reading only the ledger counts the same money.
  const ledger = new Map();
  for (const e of readJsonLines(ws.abs('logs/research-spend.jsonl'))) {
    const k = `${e.attempt}`;
    const cur = ledger.get(k) || { estimate: null, actual: null };
    if (typeof e.estimate_usd === 'number') cur.estimate = e.estimate_usd;
    if (typeof e.actual_usd === 'number') cur.actual = e.actual_usd;
    ledger.set(k, cur);
  }
  const ledgerTotal = [...ledger.values()].reduce((s, c) => s + (c.actual !== null ? c.actual : c.estimate || 0), 0);
  assert.equal(Math.round(ledgerTotal * 10000) / 10000, spentRun());
});

test('V2-005 search limits are sent as documented: zero sends no search tool; Claude max_uses; ChatGPT max_tool_calls', async (t) => {
  for (const provider of ['claude', 'chatgpt']) {
    for (const n of [0, 1, 200]) {
      const { ws, pid } = setup(t, `v2005-${provider}-${n}`, { providers: { [provider]: { model: MODELS[provider], input_usd_per_mtok: 3, output_usd_per_mtok: 15, search_usd_per_call: 0.01, max_searches: n } }, budget: { per_run_usd: 50, daily_usd: 100, monthly_usd: 100 }, max_output_tokens: 4000 });
      assert.equal(research.providerStatus(ws)[provider].mode, 'api', `${provider} ${n}`);
      research.createRun(ws, { project_id: pid, providers: [provider] });
      const f = stubFetch(texts(ws, pid), { usage: { input: 1000, output: 1000, searches: Math.min(n, 2) } });
      await research.runDueJobs(ws, { fetchImpl: f });
      assert.equal(f.calls.length, 1);
      const body = f.calls[0].body;
      if (provider === 'claude') {
        assert.equal(body.max_tokens, 4000);
        if (n === 0) assert.equal(body.tools, undefined, 'zero searches: no web search tool');
        else assert.deepEqual(body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: n }]);
      } else {
        assert.equal(body.max_output_tokens, 4000);
        if (n === 0) {
          assert.equal(body.tools, undefined);
          assert.equal(body.max_tool_calls, undefined);
        } else {
          assert.deepEqual(body.tools, [{ type: 'web_search' }]);
          assert.equal(body.max_tool_calls, n);
        }
      }
    }
  }
});

test('V2-005 Gemini: no search cap is invented; search is refused unless per-request billing is declared', async (t) => {
  // max_searches 5 with no declared billing: not dispatched, and the reason says why.
  let c = setup(t, 'v2005-gem-refuse', { providers: { gemini: { model: MODELS.gemini, input_usd_per_mtok: 1, output_usd_per_mtok: 4, search_usd_per_call: 0.035, max_searches: 5, api: 'generate_content' } }, budget: { per_run_usd: 50, daily_usd: 100, monthly_usd: 100 }, max_output_tokens: 4000 });
  const st = research.providerStatus(c.ws).gemini;
  assert.equal(st.mode, 'manual');
  assert.match(st.reason, /no per-request search limit/);
  const run = research.createRun(c.ws, { project_id: c.pid, providers: ['gemini'] });
  assert.equal(run.run.jobs.gemini.state, 'unconfigured');
  const f0 = stubFetch(texts(c.ws, c.pid));
  await research.runDueJobs(c.ws, { fetchImpl: f0 });
  assert.equal(f0.calls.length, 0);
  // Zero: no search tool, sent.
  c = setup(t, 'v2005-gem-zero', { providers: { gemini: { model: MODELS.gemini, input_usd_per_mtok: 1, output_usd_per_mtok: 4, max_searches: 0, api: 'generate_content' } }, budget: { per_run_usd: 50, daily_usd: 100, monthly_usd: 100 }, max_output_tokens: 4000 });
  research.createRun(c.ws, { project_id: c.pid, providers: ['gemini'] });
  const f1 = stubFetch(texts(c.ws, c.pid), { usage: { input: 1000, output: 1000, searches: 0 } });
  await research.runDueJobs(c.ws, { fetchImpl: f1 });
  assert.equal(f1.calls.length, 1);
  assert.equal(f1.calls[0].body.tools, undefined);
  assert.equal(f1.calls[0].body.generationConfig.maxOutputTokens, 4000);
  // Declared per-request billing: the tool is sent without any invented cap and
  // the reservation holds one search fee.
  c = setup(t, 'v2005-gem-req', { providers: { gemini: { model: MODELS.gemini, input_usd_per_mtok: 1, output_usd_per_mtok: 4, search_usd_per_call: 0.035, max_searches: 200, search_billing: 'per_request', api: 'generate_content' } }, budget: { per_run_usd: 50, daily_usd: 100, monthly_usd: 100 }, max_output_tokens: 4000 });
  assert.equal(research.providerStatus(c.ws).gemini.mode, 'api');
  const r2 = research.createRun(c.ws, { project_id: c.pid, providers: ['gemini'] });
  const f2 = stubFetch(texts(c.ws, c.pid), { usage: { input: 1000, output: 1000, searches: 7 } });
  await research.runDueJobs(c.ws, { fetchImpl: f2 });
  assert.deepEqual(f2.calls[0].body.tools, [{ google_search: {} }]);
  assert.ok(!/max_?uses|max_?tool|maxSearch|limit/i.test(JSON.stringify(f2.calls[0].body.tools)), 'no cap field was invented');
  const a = research.loadRun(c.ws, c.pid, r2.run_id).jobs.gemini.attempts[0];
  const fee = a.estimate.parts.find((p) => p.part === 'search_fee');
  assert.equal(fee.basis, 'enforced');
  assert.equal(fee.units, 1);
  assert.equal(a.cost_actual_usd, Math.round(((1000 / 1e6) * 1 + (1000 / 1e6) * 4 + 0.035) * 10000) / 10000, 'seven searches, one per-request fee');
});

test('V2-005 settings: zero is kept, invalid values are refused, nothing is coerced', (t) => {
  assert.equal(validateSettingsPatch({ research: { providers: { claude: { max_searches: 0 } } } }).research.providers.claude.max_searches, 0);
  assert.equal(validateSettingsPatch({ research: { providers: { claude: { max_searches: '0' } } } }).research.providers.claude.max_searches, 0);
  assert.equal(validateSettingsPatch({ research: { providers: { claude: { max_searches: '' } } } }).research.providers.claude.max_searches, null, 'empty means not set, never 0');
  for (const bad of [2.5, -1, 201, 'abc', '1e1x']) {
    assert.throws(() => validateSettingsPatch({ research: { providers: { claude: { max_searches: bad } } } }), (e) => e.code === 'INVALID', String(bad));
  }
  assert.equal(validateSettingsPatch({ research: { budget: { per_run_usd: 0 } } }).research.budget.per_run_usd, 0);
  for (const bad of [-1, 'NaN', 'Infinity', 10001]) {
    assert.throws(() => validateSettingsPatch({ research: { budget: { per_run_usd: bad } } }), (e) => e.code === 'INVALID', String(bad));
  }
  assert.throws(() => validateSettingsPatch({ research: { providers: { claude: { search_billing: 'per_request' } } } }), (e) => e.code === 'INVALID');
  assert.throws(() => validateSettingsPatch({ research: { providers: { gemini: { search_billing: 'unlimited' } } } }), (e) => e.code === 'INVALID');
  assert.equal(validateSettingsPatch({ research: { providers: { gemini: { search_billing: 'per_request' } } } }).research.providers.gemini.search_billing, 'per_request');
  // Hand-edited settings are read as written, never coerced.
  withKeys(t);
  const { root, cleanup } = tempWorkspace('v2005-coerce');
  t.after(cleanup);
  const base = { model: MODELS.claude, input_usd_per_mtok: 3, output_usd_per_mtok: 15, search_usd_per_call: 0.01 };
  const budget = { per_run_usd: 5, daily_usd: 5, monthly_usd: 5 };
  let ws = configure(root, { providers: { claude: { ...base, max_searches: '5' } }, budget });
  assert.match(research.providerStatus(ws).claude.reason, /max searches/);
  ws = configure(root, { providers: { claude: { model: MODELS.claude, input_usd_per_mtok: 3, output_usd_per_mtok: 15 } }, budget });
  assert.match(research.providerStatus(ws).claude.reason, /search price/, 'the default 20 searches needs a search price');
  ws = configure(root, { providers: { claude: { model: MODELS.claude, input_usd_per_mtok: 3, output_usd_per_mtok: 15, max_searches: 0 } }, budget });
  assert.equal(research.providerStatus(ws).claude.mode, 'api', 'search off needs no search price');
  ws = configure(root, { providers: { claude: { ...base, max_searches: 5 } }, budget: { ...budget, per_run_usd: -2 } });
  assert.match(research.providerStatus(ws).claude.reason, /spending budget/);
  ws = configure(root, { providers: { claude: { ...base, max_searches: 5, input_usd_per_mtok: -3 } }, budget });
  assert.match(research.providerStatus(ws).claude.reason, /token prices/);
});

test('V2-005 a zero per-run limit is a limit: nothing is sent', async (t) => {
  const { ws, pid } = setup(t, 'v2005-zero-budget', { providers: { claude: { model: MODELS.claude, ...DOLLAR } }, budget: { per_run_usd: 0, daily_usd: 0, monthly_usd: 0 }, max_output_tokens: 10000 });
  assert.equal(research.providerStatus(ws).claude.mode, 'api');
  research.createRun(ws, { project_id: pid, providers: ['claude'] });
  const f = stubFetch(texts(ws, pid));
  const out = await research.runDueJobs(ws, { fetchImpl: f });
  assert.equal(f.calls.length, 0);
  assert.equal(out.results[0].status, 'budget_refused');
});

test('V2-005 the reservation is labeled enforced vs estimated, never "maximum"; usage above it is recorded and counted', async (t) => {
  const { ws, pid } = setup(t, 'v2005-overrun', { providers: { claude: { model: MODELS.claude, input_usd_per_mtok: 3, output_usd_per_mtok: 15, search_usd_per_call: 0.01, max_searches: 5 } }, budget: { per_run_usd: 50, daily_usd: 6.2, monthly_usd: 100 }, max_output_tokens: 8000 });
  const st = research.providerStatus(ws).claude;
  assert.ok(st.bounds, 'the status says what the request enforces and what is estimated');
  assert.ok(st.bounds.enforced.some((x) => /8000 output tokens/.test(x)));
  assert.ok(st.bounds.enforced.some((x) => /5 searches \(max_uses/.test(x)));
  assert.ok(st.bounds.estimated.some((x) => /prompt tokens/.test(x)));
  const plan = research.callPlan(ws, 'claude', 'x'.repeat(35000));
  assert.deepEqual(plan.parts.map((p) => [p.part, p.basis]), [['output_tokens', 'enforced'], ['search_fee', 'enforced'], ['prompt_tokens', 'estimated'], ['search_result_tokens', 'estimated']]);
  assert.equal(plan.enforced_usd, 0.17);
  assert.equal(plan.estimated_usd, 0.09);
  assert.equal(plan.total_usd, 0.26);
  const run = research.createRun(ws, { project_id: pid, providers: ['claude'] });
  // Search results pulled in two million input tokens: far above the reservation.
  const f = stubFetch(texts(ws, pid), { usage: { input: 2000000, output: 3000, searches: 5 } });
  await research.runDueJobs(ws, { fetchImpl: f });
  const a = research.loadRun(ws, pid, run.run_id).jobs.claude.attempts[0];
  assert.equal(a.cost_actual_usd, 6.095);
  assert.ok(a.overrun_usd > 5.5, 'the overrun is recorded on the attempt');
  assert.equal(research.spendSoFar(ws).daily, 6.095);
  assert.ok(readJsonLines(ws.abs('logs/research-spend.jsonl')).some((l) => l.kind === 'actual' && l.actual_usd === 6.095));
  // The next call is admitted against the actual figure, not the old estimate.
  research.createRun(ws, { project_id: pid, providers: ['claude'], force_new: true });
  const out = await research.runDueJobs(ws, { fetchImpl: f });
  assert.equal(out.results[0].status, 'budget_refused');
  assert.match(out.results[0].reason, /daily limit/);
  for (const text of [out.results[0].reason, ...plan.parts.map((p) => p.detail), ...st.bounds.enforced, ...st.bounds.estimated]) assert.ok(!/maximum/i.test(text), text);
});

test('V2-005 unattended schedules are declined while a bound or price is missing', async (t) => {
  const sched = [{ id: 'monthly', every_days: 30, providers: ['claude'], enabled: true }];
  const { root, ws, pid } = setup(t, 'v2005-sched', { providers: { claude: { model: MODELS.claude, input_usd_per_mtok: 3, output_usd_per_mtok: 15 } }, budget: { per_run_usd: 5, daily_usd: 5, monthly_usd: 5 }, schedules: sched, unattended_enabled: true });
  projects.setWatchlist(ws, pid, true);
  const f = stubFetch(texts(ws, pid));
  const out = await research.runDueJobs(ws, { fetchImpl: f });
  assert.equal(out.created.length, 0);
  assert.match(out.summary, /no provider has a configured, bounded paid API/);
  assert.equal(f.calls.length, 0);
  const ws2 = configure(root, { providers: { claude: { model: MODELS.claude, input_usd_per_mtok: 3, output_usd_per_mtok: 15, max_searches: 0 } }, budget: { per_run_usd: 5, daily_usd: 5, monthly_usd: 5 }, schedules: sched, unattended_enabled: true });
  const out2 = await research.runDueJobs(ws2, { fetchImpl: stubFetch(texts(ws2, pid), { usage: { input: 1000, output: 1000, searches: 0 } }) });
  assert.equal(out2.created.length, 1);
});

test('V2-004 spend from older records: ledger lines count when no attempt can be read; a never-committed reservation is superseded', (t) => {
  const { ws } = setup(t, 'v2004-ledger', { providers: {}, budget: { per_run_usd: 5, daily_usd: 5, monthly_usd: 5 } });
  const now = new Date().toISOString();
  fs.mkdirSync(ws.abs('logs'), { recursive: true });
  const lines = [
    { at: now, run_id: 'run_legacyAAAA', provider: 'claude', attempt: 1, estimate_usd: 0.4, actual_usd: null },
    { at: now, run_id: 'run_legacyAAAA', provider: 'claude', attempt: 1, estimate_usd: null, actual_usd: 0.25, replaces_estimate: true },
    { at: now, run_id: 'run_legacyBBBB', provider: 'gemini', attempt: 1, estimate_usd: 0.3, actual_usd: null },
  ];
  fs.writeFileSync(ws.abs('logs/research-spend.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const s = research.spendSoFar(ws);
  assert.equal(s.daily, 0.55, 'actual where known, else the estimate');
  assert.equal(s.open_reservations_usd, 0.3);
});

test('V2-004 an older runner that priced an answer but stopped before recording it is counted at that price', (t) => {
  const { ws, pid } = setup(t, 'v2004-ledger-actual', { providers: { claude: { model: MODELS.claude, ...DOLLAR } }, budget: { per_run_usd: 5, daily_usd: 5, monthly_usd: 5 }, max_output_tokens: 10000 });
  const run = research.createRun(ws, { project_id: pid, providers: ['claude'] });
  const rel = `projects/${pid}/research/${run.run_id}/run.json`;
  const now = new Date().toISOString();
  // The original runner's state: attempt unfinished in run.json (estimate only),
  // while its ledger already holds the actual cost of the answer it received.
  require('../core/ops').runOp(ws, { type: 'legacy_fixture', summary: 'older runner state' }, (op) => {
    const doc = op.readJson(rel);
    doc.jobs.claude.state = 'running';
    doc.jobs.claude.attempts = [{ n: 1, started_at: now, finished_at: null, outcome: null, model: MODELS.claude, cost_estimate_usd: 1 }];
    op.writeJson(rel, doc);
  });
  fs.appendFileSync(ws.abs('logs/research-spend.jsonl'), [
    { at: now, run_id: run.run_id, provider: 'claude', attempt: 1, estimate_usd: 1, actual_usd: null },
    { at: now, run_id: run.run_id, provider: 'claude', attempt: 1, estimate_usd: null, actual_usd: 0.42, replaces_estimate: true },
  ].map((l) => `${JSON.stringify(l)}\n`).join(''));
  assert.equal(research.spendSoFar(ws, new Date(), { runId: run.run_id }).run, 0.42);
});
