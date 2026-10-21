'use strict';
// ChatGPT's research on the online desk, as found on 2026-10-03, and what
// changed for it. Fictional reports and workspaces only; nothing leaves this
// PC and no model is called.
//
// What the desk showed: every ChatGPT grade withheld (40%, 60% or 80% of the
// weight scored). The reports were saved and read correctly. In every one,
// "BTC-relative asymmetry" (defined from scenario probabilities, which ChatGPT
// would not invent) and "timing and executable liquidity" (defined for "a
// position of the intended size", a size no prompt states) were unknown,
// while the same reports scored liquidity risk and some stated a timing view.
// Four reports were saved twice: the desk's reply to a withheld grade invited
// a second save, and ChatGPT sent the same report again with new timestamps.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { tempWorkspace, addFixtureProject, FIXTURES } = require('./helpers');
const research = require('../core/research');
const inbox = require('../core/inbox');
const indexer = require('../core/indexer');
const execution = require('../core/execution');
const { structureChecks } = require('../core/consistency');
const { runOp } = require('../core/ops');
const { sha256, readJson, atomicWrite, jsonText } = require('../core/fsx');
const { openWorkspace } = require('../core/workspace');

const BASE = fs.readFileSync(path.join(FIXTURES, 'reports', 'example-payfi-fictional__chatgpt.md'), 'utf8');

// The model's own notes on the parts it left unknown, as ChatGPT wrote them
// on 2026-10-03 (paraphrased, FICTIONAL).
const NOTES = {
  sustainable_business_demand: 'FICTIONAL: no paid-fee series by month.',
  valuation_supply: 'FICTIONAL: supply schedule not reconciled.',
  btc_relative_asymmetry: 'FICTIONAL: no calibrated scenarios or fee-supported targets.',
  timing_executable_liquidity: 'FICTIONAL: permitted live venue, intended size and net costs.',
};

// A ChatGPT-shaped report from the fictional fixture: the given parts left
// unknown with the model's notes, no scenario probabilities, its own "as of"
// and "accessed" stamps, and no provider in the JSON (the channel decides).
function chatgptReport({ unknown = [], diagUnknown = [], stamp = '2026-10-03T14:12:54.843Z', runId = null, promptVersion = 'cr-research-prompt@4', profile = 'payfi-credit@1', edit = null } = {}) {
  const m = BASE.match(/```json\n([\s\S]*?)\n```/);
  const a = JSON.parse(m[1]);
  a.analysis_at = stamp;
  a.prompt_version = promptVersion;
  a.sector_profile = profile;
  a.provider = null;
  if (runId) a.research_run_id = runId;
  for (const id of unknown) a.investment_components[id] = { status: 'unknown', value: null, low: null, high: null, rationale: `FICTIONAL: ${id.replace(/_/g, ' ')} not judged.`, evidence_refs: [], missing_data: NOTES[id] };
  // Category grades left unknown too, as ChatGPT did where its demand or
  // valuation evidence was missing (consistent unknowns).
  for (const id of diagUnknown) a.diagnostic_scores[id] = { status: 'unknown', value: null, low: null, high: null, rationale: '', evidence_refs: [], missing_data: 'FICTIONAL: not established.' };
  for (const s of a.scenarios.items) s.probability_pct = null;
  a.scenarios.probability_note = 'FICTIONAL: no calibrated probabilities.';
  if (edit) edit(a);
  const prose = BASE.slice(0, m.index).replace(/^(# .*)$/m, `$1\n\nAs of ${stamp}. FICTIONAL sources accessed ${stamp}.`);
  return `${prose}\`\`\`json\n${JSON.stringify(a, null, 2)}\n\`\`\`\n`;
}

function workspace(t, label) {
  const { ws, root, cleanup } = tempWorkspace(label);
  t.after(cleanup);
  const pid = addFixtureProject(ws).project_id;
  return { ws, root, pid };
}

// A ChatGPT job as made before execution notes existed: no note on record.
function asOlderJob(ws, pid, runId) {
  const rel = `projects/${pid}/research/${runId}/run.json`;
  runOp(ws, { type: 'test_older_job', summary: 'FICTIONAL: a job made before execution notes' }, (op) => {
    const r = op.readJson(rel);
    delete r.jobs.chatgpt.execution;
    op.writeJson(rel, r);
  });
}

test('withheld ChatGPT reports: each unknown part is read as written, the grade is withheld with its coverage, and the saved report stays the latest and openable', (t) => {
  const { ws, pid } = workspace(t, 'gpt-withheld');
  // Ondo (80%), Movement (60%), Heima and Aleo (40%), in that shape.
  const cases = [
    [['btc_relative_asymmetry', 'timing_executable_liquidity'], [], 80, '2026-10-03T14:12:54.843Z'],
    [['sustainable_business_demand', 'btc_relative_asymmetry', 'timing_executable_liquidity'], ['organic_demand'], 60, '2026-10-03T14:30:48.260Z'],
    [['sustainable_business_demand', 'valuation_supply', 'btc_relative_asymmetry', 'timing_executable_liquidity'], ['organic_demand', 'valuation_supply_attractiveness'], 40, '2026-10-03T14:39:05.085Z'],
  ];
  let last = null;
  for (const [unknown, diagUnknown, coverage, stamp] of cases) {
    const out = inbox.importContent(ws, 'chatgpt', { content: chatgptReport({ unknown, diagUnknown, stamp }), filename: `gpt-${coverage}.md`, projectId: pid });
    assert.equal(out.result.status, 'ingested', out.result.message);
    const d = indexer.projectDetail(ws, pid);
    const r = d.reports.find((x) => x.report_id === out.result.report_id);
    assert.equal(r.meta.provider, 'chatgpt', 'the connection, not the JSON, says whose report it is');
    for (const id of unknown) {
      assert.equal(r.assessment.investment_components[id].status, 'unknown', id);
      assert.equal(r.assessment.investment_components[id].missing_data, NOTES[id], `${id}: the model's own note, as written`);
    }
    assert.equal(r.grade.status, 'withheld');
    assert.equal(r.grade.coverage_pct, coverage, 'coverage is the scored share of the six weights; never renormalized');
    assert.deepEqual(r.grade.missing.map((x) => x.id).sort(), [...unknown].sort());
    assert.equal(r.assessment.prompt_version, 'cr-research-prompt@4');
    assert.equal(r.assessment.sector_profile, 'payfi-credit@1', 'read under the profile it declares');
    last = out.result.report_id;
  }
  // The newest saved report is the one every view opens, withheld or not.
  const idx = indexer.buildIndex(ws);
  const row = idx.projects.find((p) => p.project_id === pid);
  const gpt = row.providers.chatgpt;
  assert.equal(gpt.report_id, last);
  assert.equal(gpt.grade.status, 'withheld');
  assert.equal(gpt.grade.coverage_pct, 40);
  assert.deepEqual(gpt.unscored.map((x) => [x.label, x.note]), [
    ['Sustainable business demand', NOTES.sustainable_business_demand],
    ['Valuation and supply', NOTES.valuation_supply],
    ['BTC-relative asymmetry', NOTES.btc_relative_asymmetry],
    ['Timing and executable liquidity', NOTES.timing_executable_liquidity],
  ]);
  assert.equal(gpt.scorecard.total, 11, 'an @1 report keeps its eleven categories');
  const d = indexer.projectDetail(ws, pid);
  assert.equal(d.comparison.latest.chatgpt.report_id, last, 'the project page (Overview, Scorecards, Reports) opens it');
  assert.equal(d.history.chatgpt.length, 3, 'every saved report is listed');
  // The part left unknown while the same report scores related ground is named.
  assert.equal(gpt.structure.flagged, 1);
  assert.equal(gpt.structure.flags[0].component, 'timing_executable_liquidity');
  assert.match(gpt.structure.flags[0].message, /^Timing and executable liquidity is unknown, while the same report gives liquidity risk 45 \(higher is more risk\)\. Check whether its written assessment supports a judgment on this part\. Nothing is changed\.$/);
});

test('structure checks: a part left unknown while the same report scores related ground is named; consistent unknowns, N/A parts and scored parts are not; nothing is changed', () => {
  const a = JSON.parse(chatgptReport({ unknown: ['sustainable_business_demand', 'btc_relative_asymmetry', 'timing_executable_liquidity'] }).match(/```json\n([\s\S]*?)\n```/)[1]);
  const grading = require('../../templates/rubrics/cr-grading.v1.json');
  const profile = require('../../templates/rubrics/payfi-credit.v1.json');
  const before = JSON.stringify(a);
  // Organic demand is scored in the fixture: sustainable business demand is flagged.
  let c = structureChecks(a, { grading, profile });
  assert.deepEqual(c.flags.map((f) => f.component), ['sustainable_business_demand', 'timing_executable_liquidity']);
  assert.match(c.flags[0].message, /gives the category grade organic demand \d+\./);
  assert.match(c.summary, /2 weighted parts are not scored while the same report scores related ground: sustainable business demand and timing and executable liquidity\. These checks change no score\./);
  assert.equal(JSON.stringify(a), before, 'the checks never change the assessment');
  // Unknown on both sides is consistent: no flag.
  a.diagnostic_scores.organic_demand = { status: 'unknown', value: null, low: null, high: null, rationale: '', evidence_refs: [], missing_data: 'FICTIONAL' };
  c = structureChecks(a, { grading, profile });
  assert.deepEqual(c.flags.map((f) => f.component), ['timing_executable_liquidity']);
  // A full set of scenario probabilities next to an unknown BTC-relative part, and a stated timing view.
  a.scenarios.items.forEach((s, i) => { s.probability_pct = [25, 50, 25][i]; });
  a.position_context = { timing: { state: 'extended' } };
  c = structureChecks(a, { grading, profile });
  assert.match(c.flags.find((f) => f.component === 'btc_relative_asymmetry').message, /a probability for every scenario \(bull 25%, base 50%, bear 25%\)/);
  assert.match(c.flags.find((f) => f.component === 'timing_executable_liquidity').message, /liquidity risk 45 \(higher is more risk\) and a timing view \(extended\)/);
  // A part marked not applicable, or scored, is never flagged; a PDF has no checks.
  a.investment_components.timing_executable_liquidity = { status: 'not_applicable', value: null, low: null, high: null, rationale: 'FICTIONAL', evidence_refs: [], missing_data: null };
  a.investment_components.btc_relative_asymmetry = { status: 'scored', value: 40, low: null, high: null, rationale: 'FICTIONAL', evidence_refs: [], missing_data: null };
  assert.deepEqual(structureChecks(a, { grading, profile }).flags, []);
  assert.deepEqual(structureChecks({ ...a, needs_text: true }, { grading, profile }).flags, []);
});

test('execution note: a new run freezes ChatGPT\'s note with its job; the prompt stays one text for every model; a model added later gets its note then; a job without one gets none', (t) => {
  const { ws, root, pid } = workspace(t, 'gpt-note');
  // The published templates never change: a new version gets a new file.
  assert.equal(sha256(fs.readFileSync(path.join(root, 'templates', 'execution', 'chatgpt.v1.md'))), 'a7ad4872d8db69af998d73ee928741f4d8c68b8169fee994b50e31cd92129106');
  assert.equal(sha256(fs.readFileSync(path.join(root, 'templates', 'execution', 'chatgpt.v2.md'))), 'fddb85f49c79d6f119544828fe59efd939d9846af7cce640657e62e880482d8d');
  const run = research.createRun(ws, { project_id: pid, providers: ['claude', 'chatgpt', 'gemini'] }).run;
  assert.equal(run.prompt.version, 'cr-research-prompt@6');
  assert.equal(run.prompt.identical_for_all_providers, true);
  const rec = run.jobs.chatgpt.execution;
  assert.equal(rec.ref, 'cr-execution-chatgpt@2', 'a job made now gets note @2');
  assert.equal(rec.path, `projects/${pid}/research/${run.run_id}/execution.chatgpt.md`);
  const text = fs.readFileSync(path.join(root, rec.path), 'utf8');
  assert.equal(sha256(text), rec.sha256);
  assert.equal(run.jobs.claude.execution, undefined, 'Claude has no note');
  assert.equal(run.jobs.gemini.execution, undefined, 'Gemini has no note');
  // Bound to this run; the prompt decides; the discipline of 2026-10-04.
  assert.ok(text.startsWith('<!-- CR-EXECUTION cr-execution-chatgpt@2 '));
  assert.ok(text.includes(`research run ${run.run_id} (ChatGPT)`));
  assert.ok(text.includes(`cr-research-prompt@6, SHA-256 ${run.prompt.sha256}, holding period ${run.horizon.start_date} to ${run.horizon.end_date}`));
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(text), 'every placeholder filled');
  for (const phrase of [
    /Where they seem to differ from the prompt, the prompt decides\./,
    /do not look for or use Claude's or Gemini's reports, grades or conclusions/,
    /Finish with one save_report and report its receipt \(status and report ID\) to Eric before starting any other project\./,
    /the implementation files that power the product, at a named commit/,
    /Commit counts, stars or an audit badge are not code quality; a listing on a venue is not executable liquidity; intuition is not a probability\./,
    /Make one bounded alternative attempt .* and state plainly what stayed unavailable/,
    /a token launched last month has a month of data, and that is a disclosure, not a failure/,
    /its own claim and source IDs, not one shared list/,
    /Where a related category grade is unknown but you score a component, say which narrower evidence and assumptions support the component\./,
    /Give a range only when its low and high ends are two named interpretations the evidence supports, and say what observable fact would tell them apart\./,
    /A range is your judgment, not a statistical confidence interval/,
    /Never turn an unknown into a band, and never fill in a number to complete the form\./,
    /the volume baseline you compared against/,
    /every categorical word is one the appendix allows/,
    /A withheld grade is an acceptable result\.\*\*/,
    /Save again only to correct a documented issue .* or to record a clearly explained revision, and then pass revision/,
  ]) {
    assert.match(text, phrase);
  }
  assert.doesNotMatch(text, /give a score or a range/, 'the @1 wording that invited bands is gone');
  // The prompt itself carries no note: the same bytes for every model.
  const prompt = fs.readFileSync(path.join(root, run.prompt.path), 'utf8');
  assert.equal(sha256(prompt), run.prompt.sha256);
  assert.ok(!prompt.includes('CR-EXECUTION'));
  // Read back against its hash; a changed file is not given out.
  const fresh = research.loadRun(ws, pid, run.run_id);
  assert.equal(execution.readNote(ws, fresh, 'chatgpt').delivery.status, 'verified');
  assert.equal(execution.readNote(ws, fresh, 'claude'), null);
  fs.writeFileSync(path.join(root, rec.path), `${text}\nFICTIONAL tampering`);
  const bad = execution.readNote(ws, fresh, 'chatgpt');
  assert.equal(bad.text, null);
  assert.equal(bad.delivery.status, 'hash_mismatch');
  fs.writeFileSync(path.join(root, rec.path), text);
  // ChatGPT added to a Claude-only run gets its note when its job is made.
  const solo = research.createRun(ws, { project_id: pid, providers: ['claude'], kind: 'refresh' }).run;
  assert.equal(solo.jobs.claude.execution, undefined);
  research.addProviders(ws, pid, solo.run_id, ['chatgpt']);
  const added = research.loadRun(ws, pid, solo.run_id).jobs.chatgpt.execution;
  assert.equal(added.ref, 'cr-execution-chatgpt@2');
  assert.ok(fs.readFileSync(path.join(root, added.path), 'utf8').includes(`research run ${solo.run_id} (ChatGPT)`));
  // A job frozen with note @1 (made before 2026-10-04) keeps exactly that
  // note: delivered as frozen, never upgraded.
  const v1 = fs.readFileSync(path.join(root, 'templates', 'execution', 'chatgpt.v1.md'), 'utf8').replace(/\{\{RUN_ID\}\}/g, solo.run_id);
  runOp(ws, { type: 'test_v1_job', summary: 'FICTIONAL: a job frozen with note @1' }, (op) => {
    const rel = `projects/${pid}/research/${solo.run_id}/run.json`;
    const r = op.readJson(rel);
    op.write(r.jobs.chatgpt.execution.path, v1);
    r.jobs.chatgpt.execution = { ...r.jobs.chatgpt.execution, ref: 'cr-execution-chatgpt@1', sha256: sha256(v1), chars: v1.length };
    op.writeJson(rel, r);
  });
  const kept = execution.readNote(ws, research.loadRun(ws, pid, solo.run_id), 'chatgpt');
  assert.deepEqual([kept.delivery.status, kept.delivery.ref, kept.text], ['verified', 'cr-execution-chatgpt@1', v1]);
  // A job made before notes existed has none, and none is made up for it.
  asOlderJob(ws, pid, solo.run_id);
  assert.equal(execution.readNote(ws, research.loadRun(ws, pid, solo.run_id), 'chatgpt'), null);
});

// The API route, against an in-process stand-in for OpenAI (fake key).
const KEYS = { OPENAI_API_KEY: 'test-key-not-real-o' };
function apiWorkspace(t, label) {
  const prev = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = KEYS.OPENAI_API_KEY;
  t.after(() => { if (prev === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prev; });
  const { root, cleanup } = tempWorkspace(label);
  t.after(cleanup);
  let ws = openWorkspace({ root, actor: 'test' });
  const pid = addFixtureProject(ws).project_id;
  const file = path.join(root, 'config', 'settings.json');
  const s = readJson(file);
  s.research = { providers: { chatgpt: { model: 'gpt-test-model', input_usd_per_mtok: 2, output_usd_per_mtok: 10, search_usd_per_call: 0.01, max_searches: 5, effort: 'high' } }, budget: { per_run_usd: 20, daily_usd: 50, monthly_usd: 100 }, max_output_tokens: 20000 };
  atomicWrite(file, jsonText(s));
  ws = openWorkspace({ root, actor: 'test' });
  return { ws, root, pid };
}

function openaiStandIn() {
  const posts = [];
  const reply = (body, headers = {}) => ({ ok: true, status: 200, headers: { get: (k) => headers[String(k).toLowerCase()] || null }, text: async () => JSON.stringify(body) });
  const f = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (url === 'https://api.openai.com/v1/responses' && method === 'POST') {
      posts.push(JSON.parse(opts.body));
      return reply({ id: `resp_fictional_${posts.length}`, status: 'queued', model: 'gpt-test-model' }, { 'x-request-id': 'req_fictional' });
    }
    const m = String(url).match(/^https:\/\/api\.openai\.com\/v1\/responses\/([^/]+)$/);
    if (m && method === 'GET') return reply({ id: m[1], status: 'in_progress' });
    throw new Error(`unexpected call ${method} ${url}`);
  };
  return { f, posts };
}

test('API route: ChatGPT gets its note as instructions while the input stays the frozen prompt byte for byte, and the attempt records both hashes', async (t) => {
  const { ws, root, pid } = apiWorkspace(t, 'gpt-api-note');
  const run = research.createRun(ws, { project_id: pid, providers: ['chatgpt'] }).run;
  const sp = openaiStandIn();
  const out = await research.runDueJobs(ws, { fetchImpl: sp.f });
  assert.equal(out.results[0].status, 'submitted');
  const prompt = fs.readFileSync(path.join(root, run.prompt.path), 'utf8');
  const note = fs.readFileSync(path.join(root, run.jobs.chatgpt.execution.path), 'utf8');
  assert.equal(sp.posts.length, 1);
  assert.equal(sp.posts[0].input, prompt, 'the input is the run\'s prompt, byte for byte');
  assert.equal(sp.posts[0].instructions, note, 'the note goes as the request\'s instructions');
  const a = research.loadRun(ws, pid, run.run_id).jobs.chatgpt.attempts[0];
  assert.deepEqual(a.delivered, { prompt_sha256: run.prompt.sha256, execution: { ref: 'cr-execution-chatgpt@2', sha256: sha256(note) } });
});

test('API route: a ChatGPT job made before notes existed sends the prompt alone, as before', async (t) => {
  const { ws, pid } = apiWorkspace(t, 'gpt-api-older');
  const run = research.createRun(ws, { project_id: pid, providers: ['chatgpt'] }).run;
  asOlderJob(ws, pid, run.run_id);
  const sp = openaiStandIn();
  await research.runDueJobs(ws, { fetchImpl: sp.f });
  assert.equal(sp.posts.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(sp.posts[0], 'instructions'), false);
  assert.equal(research.loadRun(ws, pid, run.run_id).jobs.chatgpt.attempts[0].delivered.execution, null);
});

test('API route: a ChatGPT note that no longer matches its hash is never sent, and neither is the prompt', async (t) => {
  const { ws, root, pid } = apiWorkspace(t, 'gpt-api-tampered');
  const run = research.createRun(ws, { project_id: pid, providers: ['chatgpt'] }).run;
  fs.appendFileSync(path.join(root, run.jobs.chatgpt.execution.path), '\nFICTIONAL tampering');
  const sp = openaiStandIn();
  await research.runDueJobs(ws, { fetchImpl: sp.f });
  assert.equal(sp.posts.length, 0, 'nothing sent');
  const j = research.loadRun(ws, pid, run.run_id).jobs.chatgpt;
  assert.equal(j.state, 'failed');
  assert.match(j.error, /execution notes no longer match their recorded hash; not sent/);
  assert.equal(j.attempts.length, 0, 'no attempt was reserved');
});

// The re-save checks run on a fixed clock, on three different days (the day
// a run starts sets its horizon, and the stamps below are on that day), so
// the result never depends on the day the tests run.
const nextDayOf = (ymd) => new Date(Date.parse(`${ymd}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
for (const day of ['2026-10-03', '2026-10-04', '2026-10-31']) {
  test(`re-saves on ${day}: only restamped analysis and access times on the same day are the same report; every evidence date, a score, another day, model or run is another`, (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(`${day}T18:00:00Z`) });
    const { ws, pid } = workspace(t, `gpt-resave-${day}`);
    const run = research.createRun(ws, { project_id: pid, providers: ['chatgpt'] }).run;
    assert.equal(run.horizon.start_date, day, 'the run starts on the fixed day');
    const unknown = ['btc_relative_asymmetry', 'timing_executable_liquidity'];
    // A report for this run, with ChatGPT's own stamps: its analysis time and
    // each source's access time, repeated in its prose ("As of ...").
    const forRun = (stamp, edit = null, { obs = `${day}T08:00:00Z` } = {}) => chatgptReport({
      unknown, runId: run.run_id, promptVersion: run.prompt.version, profile: run.sector_profile, stamp,
      edit: (a) => {
        a.horizon = run.horizon.text;
        for (const s of a.sources) s.accessed_at = stamp;
        if (edit) edit(a);
      },
    }).replace('FICTIONAL sources accessed', `FICTIONAL observation ${obs}. FICTIONAL sources accessed`);
    const first = forRun(`${day}T14:30:48.260Z`);
    const out = inbox.importContent(ws, 'chatgpt', { content: first, filename: 'first.md', projectId: pid, runId: run.run_id });
    assert.equal(out.result.status, 'ingested', out.result.message);
    const same = (text, provider = 'chatgpt', runId = run.run_id) => inbox.sameReportForRun(ws, { projectId: pid, runId, provider, text });
    // Exact content: the same report (and the exact text is a duplicate on import).
    assert.equal(same(first).report_id, out.result.report_id);
    assert.equal(same(first.replace(/\n/g, '\r\n')).report_id, out.result.report_id, 'line endings are not content');
    // Restamped 17 minutes later the same day, as on 2026-10-03: the same report.
    const again = forRun(`${day}T14:47:05.085Z`);
    assert.notEqual(again, first);
    assert.equal(same(again).report_id, out.result.report_id);
    assert.equal(inbox.sameReportText(first, again).reason, 'the same report restamped on the same day');
    // Restamped on another day: another report, kept as its own original.
    assert.equal(same(forRun(`${nextDayOf(day)}T09:00:00.000Z`)), null);
    // Evidence times are content, whatever else is restamped.
    assert.equal(same(forRun(`${day}T14:47:05.085Z`, null, { obs: `${nextDayOf(day)}T08:00:00Z` })), null, 'a source observation time');
    assert.equal(same(forRun(`${day}T14:47:05.085Z`, null, { obs: `${day}T09:00:00Z` })), null, 'the same day, another observation time');
    assert.equal(same(forRun(`${day}T14:47:05.085Z`, (a) => { a.claims[0].as_of = `${nextDayOf(day)}`; })), null, 'a claim\'s as-of date');
    assert.equal(same(forRun(`${day}T14:47:05.085Z`, (a) => { a.catalysts = [{ title: 'FICTIONAL launch', date: nextDayOf(day), kind: 'product', status: 'announced' }]; })), null, 'a catalyst date');
    assert.equal(same(forRun(`${day}T14:47:05.085Z`, (a) => { a.chart_cycle = { data: { latest_observation_at: `${day}T16:00:00Z` } }; })), null, 'a chart candle');
    assert.equal(same(forRun(`${day}T14:47:05.085Z`, (a) => { a.sources[0].accessed_at = `${nextDayOf(day)}T01:00:00Z`; })), null, 'a source accessed on another day');
    assert.equal(same(forRun(`${day}T14:47:05.085Z`, (a) => { a.horizon = '3 months'; })), null, 'the horizon');
    assert.equal(same(forRun(`${day}T14:47:05.085Z`, (a) => { a.investment_components.valuation_supply.value += 1; })), null, 'a score');
    assert.equal(same(again, 'gemini'), null, 'another model');
    assert.equal(same(again, 'chatgpt', 'run_2026-10-03T000000Z_other'), null, 'another run');
    // A text without a readable JSON block is the same only when it is identical.
    assert.equal(inbox.sameReportText(`# Prose\n\nAs of ${day}T14:30:00Z.`, `# Prose\n\nAs of ${day}T14:47:00Z.`).same, false);
    assert.equal(inbox.sameReportText(`# Prose\n\nAs of ${day}T14:30:00Z.`, `# Prose\n\nAs of ${day}T14:30:00Z.\n`).same, true);
  });
}

function request(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('pasting by hand: the copied prompt for ChatGPT is its frozen note, then the unchanged prompt; for any other model, the prompt alone', async (t) => {
  const { ws, root, pid } = workspace(t, 'gpt-paste');
  const run = research.createRun(ws, { project_id: pid, providers: ['claude', 'chatgpt'] }).run;
  const { start } = require('../server');
  const srv = await start(ws, { port: 49300 + Math.floor(Math.random() * 200), quiet: true });
  t.after(() => srv.shutdown());
  const prompt = fs.readFileSync(path.join(root, run.prompt.path), 'utf8');
  const note = fs.readFileSync(path.join(root, run.jobs.chatgpt.execution.path), 'utf8');
  const session = JSON.parse((await request(srv.port, '/api/session')).body);
  const auth = { 'x-cr-token': session.token };
  const base = `/api/projects/${pid}/research/${run.run_id}/prompt`;
  const plain = await request(srv.port, base, auth);
  assert.equal(plain.status, 200);
  assert.equal(plain.body, prompt);
  const gpt = await request(srv.port, `${base}?provider=chatgpt`, auth);
  assert.equal(gpt.status, 200);
  assert.equal(gpt.body, `${note}\n\n---\n\n${prompt}`);
  assert.equal((await request(srv.port, `${base}?provider=claude`, auth)).body, prompt);
});
