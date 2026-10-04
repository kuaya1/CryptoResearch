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
const { runOp } = require('../core/ops');

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
  // Manual research (nothing to set up) is said apart from the optional
  // background API, which needs its key.
  assert.equal(r.models.chatgpt.status, 'manual');
  assert.match(r.models.chatgpt.sentence, /^ChatGPT: manual\. Eric pastes the prompt into ChatGPT and imports the answer; nothing is billed\. Automatic background research is optional and not set up: no OpenAI API key on this PC \(OPENAI_API_KEY, or "openai_api_key" in .+\)\. Open jobs: 1 waiting\.$/);
  assert.match(r.summary, /^Manual research: Claude, ChatGPT and Gemini, when Eric asks \(paste the prompt, import the answer\); nothing is billed\. Automatic background research: not set up for any model \(optional; each needs its API key\)\.$/);
  assert.deepEqual(r.reservations, { cowork_request_usd: null, cowork_request_fits: null, dashboard_run_usd: null, dashboard_run_fits: null });
  assert.equal(r.spend.today_usd, 0, 'a waiting job reserves nothing');
  // On the online desk the waiting job goes to the model's own assistant.
  const hostedWs = Object.create(ws, { hosted: { value: true } });
  assert.match(research.readiness(hostedWs).models.chatgpt.sentence, /^ChatGPT: manual\. ChatGPT through its desk connection researches when Eric asks it \(or he pastes the prompt\); nothing is billed here\. Automatic background research is optional and not set up: no OpenAI API key on the desk \(OPENAI_API_KEY, set in Render's environment\)\./);
});

test('readiness: a model on hold gets nothing new; its waiting jobs are kept and not handed out; unsent work stays unsent, sent work is still collected', async (t) => {
  keys(t, { OPENAI_API_KEY: 'test-key-not-real-o', GEMINI_API_KEY: 'test-key-not-real-g' });
  const { ws: ws0, pid } = setup(t, 'ready-hold', SETTINGS);
  // A waiting Gemini job from before the hold (made while its API had no key).
  const before = research.createRun(ws0, { project_id: pid, providers: ['gemini'] }).run;
  const setJob = (w, runId, patch) => runOp(w, { type: 'test_job_state', summary: 'FICTIONAL job state' }, (op) => {
    const rel = `projects/${pid}/research/${runId}/run.json`;
    const r = op.readJson(rel);
    Object.assign(r.jobs.gemini, patch);
    op.writeJson(rel, r);
  });
  setJob(ws0, before.run_id, { state: 'unconfigured', mode: 'manual' });
  const file = path.join(ws0.root, 'config', 'settings.json');
  const s = readJson(file);
  s.research.on_hold = { gemini: { since: '2026-10-04', reason: 'FICTIONAL: paused for this milestone.' } };
  s.research.default_providers = ['claude', 'chatgpt', 'gemini'];
  atomicWrite(file, jsonText(s));
  const ws = openWorkspace({ root: ws0.root, actor: 'test' });
  assert.deepEqual(Object.keys(research.heldProviders(ws)), ['gemini']);
  // The default models leave it out; naming it for one run is Eric's choice.
  const def = research.createRun(ws, { project_id: pid, force_new: true }).run;
  assert.deepEqual(def.providers, ['claude', 'chatgpt']);
  const named = research.createRun(ws, { project_id: pid, providers: ['gemini'], force_new: true }).run;
  assert.equal(named.jobs.gemini.state, 'queued', 'queued for its API, but held unsent');
  // The runner sends nothing for it, and Eric's next request does not move its waiting job.
  const sent = [];
  const out = await research.runDueJobs(ws, { fetchImpl: async (url) => { sent.push(url); throw new Error('FICTIONAL: no network in tests'); } });
  assert.ok(!sent.some((u) => /generativelanguage|googleapis/.test(String(u))), 'nothing sent to Gemini');
  assert.ok(!out.results.some((x) => x.provider === 'gemini'));
  assert.deepEqual(research.sendWaitingToApi(ws, pid, before.run_id, ['gemini']), []);
  assert.equal(research.loadRun(ws, pid, named.run_id).jobs.gemini.state, 'queued');
  assert.equal(research.loadRun(ws, pid, before.run_id).jobs.gemini.state, 'unconfigured', 'the waiting job is kept');
  const r = research.readiness(ws);
  assert.equal(r.models.gemini.status, 'on_hold');
  assert.deepEqual(r.on_hold, ['gemini']);
  assert.match(r.models.gemini.sentence, /^Gemini: on hold since 2026-10-04 \(FICTIONAL: paused for this milestone\)\. Nothing new is assigned to it; its saved reports stay, and its 1 waiting job is kept but not handed out\./);
  assert.match(r.summary, /On hold: Gemini since 2026-10-04 \(1 waiting job kept, nothing new assigned\)\./);
  assert.ok(!r.automatic.includes('gemini'), 'never promised as automatic');
  // No reminder nags about a waiting job of a model on hold.
  const idx = require('../core/indexer').buildIndex(ws);
  assert.ok(!idx.attention.some((a) => a.kind === 'research_waiting' && /Gemini/.test(a.title)));
  // Only held unsent work: nothing is due. A request already sent to its API
  // (accepted, running in the background) is still checked and collected.
  assert.equal(research.hasDueWork(ws), false);
  setJob(ws, named.run_id, { state: 'dispatching', attempts: [{ n: 1, attempt_id: 'att_fictional', phase: 'submitted', provider_request_id: 'FICTIONAL' }] });
  assert.equal(research.hasDueWork(ws), true, 'the sent request is still collected');
  assert.equal(research.hasBackgroundWork(ws), true);
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
  assert.match(r.summary, /^Manual research: Claude, when Eric asks \(paste the prompt, import the answer\); nothing is billed\. Automatic background research \(paid API, within the limits\): ChatGPT and Gemini\. Background API not set up: Claude .*A three-model request from Cowork reserves about \$\d+\.\d\d on the ChatGPT and Gemini APIs \(Claude researches in Cowork itself\), within the \$5\.00 per-run limit\.$/);
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
