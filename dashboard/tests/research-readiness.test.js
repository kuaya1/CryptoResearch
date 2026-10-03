'use strict';
// Readiness (independent review, 2026-10-03): each model's real route and
// what its jobs are doing. A missing key says "setup required" and names the
// environment variable (never a key); its jobs wait. With keys, the summary
// says what a Cowork request and a dashboard run reserve against the per-run
// limit. Keys here are fake test values; nothing is sent anywhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tempWorkspace, addFixtureProject } = require('./helpers');
const research = require('../core/research');
const { readJson, atomicWrite, jsonText } = require('../core/fsx');
const { openWorkspace } = require('../core/workspace');

const KEY_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];
const GEMINI = { model: 'gemini-test-model', input_usd_per_mtok: 2, output_usd_per_mtok: 12, search_usd_per_call: 0.014, max_searches: 20, search_billing: 'per_query', effort: 'high' };
const CHATGPT = { model: 'gpt-test-model', input_usd_per_mtok: 2, output_usd_per_mtok: 10, search_usd_per_call: 0.01, max_searches: 5, effort: 'high' };

function keys(t, values) {
  const prev = {};
  for (const k of KEY_VARS) {
    prev[k] = process.env[k];
    if (values[k]) process.env[k] = values[k];
    else delete process.env[k];
  }
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

function setup(t, label, researchSettings) {
  const { root, cleanup } = tempWorkspace(label);
  t.after(cleanup);
  let ws = openWorkspace({ root, actor: 'test' });
  const pid = addFixtureProject(ws).project_id;
  const file = path.join(root, 'config', 'settings.json');
  const s = readJson(file);
  s.research = researchSettings;
  atomicWrite(file, jsonText(s));
  ws = openWorkspace({ root, actor: 'test' });
  return { ws, pid };
}

const SETTINGS = { providers: { chatgpt: CHATGPT, gemini: GEMINI }, budget: { per_run_usd: 5, daily_usd: 10, monthly_usd: 40 }, max_output_tokens: 20000 };

test('readiness: a missing key is "setup required" with its environment variable; the job waits and is counted; nothing is billed', (t) => {
  keys(t, {});
  const { ws, pid } = setup(t, 'ready-nokeys', SETTINGS);
  const run = research.createRun(ws, { project_id: pid, providers: ['chatgpt', 'gemini'] });
  assert.equal(run.run.jobs.chatgpt.state, 'unconfigured');
  const r = research.readiness(ws);
  assert.equal(r.models.chatgpt.route, 'setup_required');
  assert.equal(r.models.chatgpt.setup_short, 'no OpenAI API key: OPENAI_API_KEY');
  assert.deepEqual(r.models.chatgpt.key, { present: false, env: 'OPENAI_API_KEY' });
  assert.equal(r.models.gemini.setup_short, 'no Google API key: GEMINI_API_KEY');
  assert.equal(r.models.chatgpt.jobs.waiting, 1);
  assert.equal(r.models.gemini.jobs.waiting, 1);
  assert.equal(r.models.chatgpt.reservation_usd, null);
  assert.match(r.models.chatgpt.sentence, /^ChatGPT: setup required \(no OpenAI API key on the desk \(OPENAI_API_KEY, or "openai_api_key" in .+\)\)\. Until then its research waits for a pasted answer; nothing is billed for it\. Open jobs: 1 waiting\.$/);
  assert.match(r.summary, /^No model runs automatically yet\. Setup required: Claude \(no Anthropic API key: ANTHROPIC_API_KEY, and \d+ more settings?\); ChatGPT \(no OpenAI API key: OPENAI_API_KEY\); Gemini \(no Google API key: GEMINI_API_KEY\); their jobs wait meanwhile\.$/);
  assert.deepEqual(r.reservations, { cowork_request_usd: null, cowork_request_fits: null, dashboard_run_usd: null, dashboard_run_fits: null });
  assert.equal(r.spend.today_usd, 0, 'a waiting job reserves nothing');
  // On the online desk the waiting job goes to the model's own assistant.
  const hostedWs = Object.create(ws, { hosted: { value: true } });
  assert.match(research.readiness(hostedWs).models.chatgpt.sentence, /OPENAI_API_KEY, set in Render's environment\)\)\. Until then its research waits for ChatGPT itself \(Eric asks it through its desk connection\) or a pasted answer/);
});

test('readiness: with keys, the models run automatically; the summary shows what a Cowork request and a dashboard run reserve against the per-run limit; never a key', (t) => {
  keys(t, { OPENAI_API_KEY: 'test-key-not-real-o', GEMINI_API_KEY: 'test-key-not-real-g' });
  const { ws, pid } = setup(t, 'ready-keys', SETTINGS);
  const r = research.readiness(ws);
  assert.deepEqual(r.automatic, ['chatgpt', 'gemini']);
  assert.equal(r.models.chatgpt.route, 'automatic');
  assert.equal(r.models.chatgpt.background, true);
  const rc = research.callPlan(ws, 'chatgpt', 'x'.repeat(30000)).total_usd;
  const rg = research.callPlan(ws, 'gemini', 'x'.repeat(30000)).total_usd;
  assert.equal(r.models.chatgpt.reservation_usd, rc);
  assert.equal(r.reservations.cowork_request_usd, Math.round((rc + rg) * 10000) / 10000);
  assert.equal(r.reservations.cowork_request_fits, true);
  assert.match(r.summary, /^Automatic: ChatGPT and Gemini\. Setup required: Claude .*A three-model request from Cowork reserves about \$\d+\.\d\d on the ChatGPT and Gemini APIs \(Claude researches in Cowork itself\), within the \$5\.00 per-run limit\.$/);
  assert.doesNotMatch(JSON.stringify(r), /test-key-not-real/, 'never a key');
  // A run queued on the API is counted as open work.
  research.createRun(ws, { project_id: pid, providers: ['chatgpt'] });
  assert.equal(research.readiness(ws).models.chatgpt.jobs.queued, 1);

  // A per-run limit below the reservations says the last model would be refused.
  const file = path.join(ws.root, 'config', 'settings.json');
  const s = readJson(file);
  s.research.budget.per_run_usd = Math.round(rc * 100) / 100 + 0.01;
  atomicWrite(file, jsonText(s));
  const ws2 = openWorkspace({ root: ws.root, actor: 'test' });
  const low = research.readiness(ws2);
  assert.equal(low.reservations.cowork_request_fits, false);
  assert.match(low.summary, /more than the \$\d+\.\d\d per-run limit, so the last model would be refused \(not sent\) until the limit is raised\./);
});
