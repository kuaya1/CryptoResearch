'use strict';
// What happened after each report (core/report-outcomes.js): the return
// against BTC from the run's start, read from the desk's own price records,
// at 30, 60, 90 and 120 days; nothing interpolated, nothing stored, and no
// verdict on which model is right until enough reports have matured.
// Fictional project, prices and fetch stubs; nothing leaves this PC.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempWorkspace, addFixtureProject, hashTree } = require('./helpers');
const research = require('../core/research');
const outcomes = require('../core/report-outcomes');
const { mockReport } = require('../core/demo');
const { readJson, atomicWrite, jsonText } = require('../core/fsx');
const { openWorkspace } = require('../core/workspace');

const CG = 'example-payfi-fictional';
const DAY = 86400000;

function withKey(t) {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real-a';
  t.after(() => { if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev; });
}

// One saved Claude report for a run, answered by a fetch stub.
async function savedReport(t) {
  withKey(t);
  const { root, cleanup } = tempWorkspace('outcomes');
  t.after(cleanup);
  let ws = openWorkspace({ root, actor: 'test' });
  const pid = addFixtureProject(ws).project_id;
  const file = path.join(root, 'config', 'settings.json');
  const s = readJson(file);
  s.research = { ...s.research, providers: { claude: { model: 'claude-test-model', input_usd_per_mtok: 0, output_usd_per_mtok: 1, search_usd_per_call: 0.01, max_searches: 0 } }, budget: { per_run_usd: 10, daily_usd: 10, monthly_usd: 10 }, max_output_tokens: 10000 };
  atomicWrite(file, jsonText(s));
  ws = openWorkspace({ root, actor: 'test' });
  const run = research.createRun(ws, { project_id: pid, providers: ['claude'] });
  const f = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const r = research.listRuns(ws, pid).find((x) => body.messages[0].content.includes(x.run_id));
    const text = mockReport(ws, 'claude', r).replace('FICTIONAL demo fixture standing in for Claude', 'Claude (Anthropic)');
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ id: 'msg_stub', model: 'claude-test-model', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 100 } }) };
  };
  await research.runDueJobs(ws, { fetchImpl: f });
  const saved = research.loadRun(ws, pid, run.run_id);
  assert.equal(saved.jobs.claude.state, 'completed');
  return { ws, root, pid, run: saved, t0: Date.parse(saved.evidence_packet.captured_at) };
}

// The desk's hourly records, as market.js appends them.
function record(root, atMs, price, btc) {
  const at = new Date(atMs).toISOString();
  const dir = path.join(root, 'market-data', 'observations');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${at.slice(0, 7)}.jsonl`), `${JSON.stringify({ fetched_at: at, provider: 'coingecko', trigger: 'test', assets: [{ id: CG, price_usd: price, market_cap_usd: price * 1e6, source_last_updated_at: at, fetched_at: at }, { id: 'bitcoin', price_usd: btc, market_cap_usd: btc * 2e7, source_last_updated_at: at, fetched_at: at }] })}\n`);
}

test('outcomes: each horizon is the return against BTC from the run\'s start, or pending, or no price; never interpolated', async (t) => {
  const { ws, root, pid, run, t0 } = await savedReport(t);
  record(root, t0 - 20 * 60000, 1, 100);
  record(root, t0 + 30 * DAY + 2 * 3600000, 1.2, 110);
  // Nothing near 60 days (the nearest record is two days off).
  record(root, t0 + 62 * DAY, 9, 100);
  record(root, t0 + 90 * DAY, 0.5, 100);
  const before = hashTree(root);
  const o = outcomes.projectOutcomes(ws, pid, { now: t0 + 95 * DAY });
  assert.deepEqual(hashTree(root), before, 'reading outcomes writes nothing');
  assert.equal(o.reports.length, 1);
  const r = o.reports[0];
  assert.equal(r.provider, 'claude');
  assert.equal(r.start.basis, 'run_packet');
  assert.equal(r.start.run_id, run.run_id);
  assert.equal(r.start.project.price_usd, 1);
  const h = Object.fromEntries(r.horizons.map((x) => [x.days, x]));
  assert.equal(h[30].status, 'measured');
  assert.equal(h[30].return_pct, 20);
  assert.equal(h[30].btc_return_pct, 10);
  assert.equal(h[30].vs_btc_pct, 9.09, '(1 + 20%) / (1 + 10%) - 1');
  assert.equal(h[60].status, 'no_price');
  assert.equal(h[90].vs_btc_pct, -50);
  assert.equal(h[120].status, 'pending');
  assert.equal(h[120].due, new Date(t0 + 120 * DAY).toISOString());
  assert.ok(r.verdict, 'the report\'s own verdict, as saved');
});

test('outcomes by model: counts only, and "too few to judge" until enough reports have matured; models never ranked', async (t) => {
  const { ws, root, t0 } = await savedReport(t);
  record(root, t0, 1, 100);
  record(root, t0 + 30 * DAY, 1.1, 100);
  const o = outcomes.deskOutcomes(ws, { now: t0 + 31 * DAY });
  assert.deepEqual(o.models.map((m) => m.provider), ['claude', 'chatgpt', 'gemini'], 'the fixed model order');
  const c = o.models[0];
  assert.equal(c.reports, 1);
  assert.equal(c.with_start, 1);
  const h30 = c.horizons.find((x) => x.days === 30);
  assert.equal(h30.matured, 1);
  assert.equal(h30.median_vs_btc_pct, null);
  assert.equal(h30.beat_btc, null);
  assert.match(h30.note, /^Too few to judge: 1 of 20 matured reports needed\.$/);
  assert.match(o.meaning, /not a forecast, an accuracy figure or a ranking of the models/);
  // From twenty matured reports a median and a share that beat BTC appear.
  const rows = Array.from({ length: 20 }, (_, i) => ({ provider: 'chatgpt', start: { project: {} }, horizons: [{ days: 30, status: 'measured', vs_btc_pct: i - 5 }] }));
  const g = outcomes.byModel(rows).find((m) => m.provider === 'chatgpt').horizons.find((x) => x.days === 30);
  assert.equal(g.matured, 20);
  assert.equal(g.median_vs_btc_pct, 4.5);
  assert.equal(g.beat_btc, 14);
  assert.equal(g.note, null);
});
