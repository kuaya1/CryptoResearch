'use strict';
// Position-cycle recipe (core/position.js, cr-research-prompt@3): calendar
// horizons inside the planning ceiling, long-term exceptions with a reason,
// the position_context block validated on import and bound to its run, and
// none of it changing a score. All projects and reports are FICTIONAL.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempWorkspace, addFixtureProject, dropFixture } = require('./helpers');
const position = require('../core/position');
const research = require('../core/research');
const prompts = require('../core/prompts');
const inbox = require('../core/inbox');
const notes = require('../core/notes');
const cycle = require('../core/cycle');
const { loadReports, normalizeAssessment, citationIntegrity } = require('../core/reports');
const { gradeAssessment } = require('../core/rubrics');
const { buildIndex } = require('../core/indexer');
const { ymdInTz, addDays } = require('../core/dates');
const { readJson } = require('../core/fsx');

const PID = 'example-payfi-fictional';

// A complete FICTIONAL cr-research-prompt@3 answer for a run: prose plus the JSON
// block from the run's own skeleton, every score filled.
function v3Report(ws, run, provider, { pc = {}, catalysts = null, omitContext = false } = {}) {
  const profile = ws.rubrics.profiles[run.sector_profile];
  const sk = prompts.buildSkeleton(ws, profile, { provider, projectId: run.project_id, horizon: run.horizon.text, rubricRef: run.rubric_version, runId: run.run_id, promptVersion: prompts.PROMPT_VERSION_V3, positionHorizon: run.horizon });
  const fill = (group) => {
    for (const [k, s] of Object.entries(sk[group])) {
      if (s.status === 'not_applicable') continue;
      sk[group][k] = { status: 'scored', value: 60, low: null, high: null, rationale: 'FICTIONAL', evidence_refs: ['C1'], missing_data: null };
    }
  };
  fill('diagnostic_scores');
  fill('investment_components');
  fill('risk_scores');
  sk.model_reported_overall_score = { status: 'unknown', value: null, low: null, high: null, rationale: '', evidence_refs: [], missing_data: 'not given' };
  sk.analysis_at = ymdInTz();
  sk.verdict = 'CONDITIONAL OPPORTUNITY';
  sk.model_self_identification = `FICTIONAL test stand-in for ${provider}`;
  sk.summary = 'FICTIONAL test report.';
  sk.sources = [{ source_id: 'S1', url: 'https://example.com/fictional', title: 'FICTIONAL', publisher: 'example.com', source_type: 'other', accessed_at: ymdInTz() }];
  sk.claims = [{ claim_id: 'C1', text: 'FICTIONAL claim.', evidence_tag: 'I', source_ids: ['S1'], metric_id: null, value: null, unit: null, definition: null, period: null, as_of: ymdInTz(), limitation: null, section: null }];
  for (const f of ['bullish_facts', 'bearish_facts', 'conviction_increases', 'invalidators']) sk[f] = [{ text: `FICTIONAL ${f}`, claim_ids: ['C1'] }];
  sk.catalysts = catalysts || [{ title: 'FICTIONAL upgrade', date: null, date_precision: 'window', window_start: addDays(run.horizon.start_date, 20), window_end: addDays(run.horizon.start_date, 40), kind: 'product', status: 'announced', certainty: 'project_claimed', in_horizon: true, claim_ids: ['C1'] }];
  sk.unlocks = [];
  sk.tokenomics_changes = [];
  sk.scenarios.btc_relative_definition = '(1 + token return) / (1 + BTC return) - 1 over the horizon';
  sk.scenarios.items.forEach((s, i) => { s.probability_pct = [25, 45, 30][i]; });
  sk.final_take = 'FICTIONAL take.';
  if (omitContext) delete sk.position_context;
  else {
    sk.position_context.market = { state: 'bitcoin_led', rationale: 'FICTIONAL reading', evidence_refs: ['C1'], ...(pc.market || {}) };
    sk.position_context.timing = { state: 'early', rationale: 'FICTIONAL view', evidence_refs: ['C1'], next_review_date: addDays(run.horizon.start_date, 30), review_trigger: 'FICTIONAL trigger', ...(pc.timing || {}) };
    if (pc.horizon) sk.position_context.horizon = pc.horizon;
  }
  return `# FICTIONAL ${provider} position report\n\nAnalysis date: ${ymdInTz()}\n\nThis is fictional test text for an automated test, standing in for a model answer. It is long enough to read as a report.\n\n\`\`\`json\n${JSON.stringify(sk, null, 2)}\n\`\`\`\n`;
}

test('calendar months clamp to the end of shorter months, including leap years', () => {
  assert.equal(position.addCalendarMonths('2026-10-02', 4), '2027-02-02');
  assert.equal(position.addCalendarMonths('2026-10-31', 4), '2027-02-28');
  assert.equal(position.addCalendarMonths('2027-10-31', 4), '2028-02-29');
  assert.equal(position.addCalendarMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(position.addCalendarMonths('2026-12-15', 2), '2027-02-15');
  assert.equal(position.addCalendarMonths('2026-03-10', 0), '2026-03-10');
  assert.throws(() => position.addCalendarMonths('2026-02-30', 1));
});

test('a run horizon is an exact interval inside the planning ceiling; longer needs a reason', (t) => {
  const { ws, cleanup } = tempWorkspace('horizonpolicy');
  t.after(cleanup);
  const today = '2026-10-02';
  const def = position.resolveRunHorizon(ws, { today });
  assert.deepEqual([def.mode, def.months, def.start_date, def.end_date, def.text], ['position', 4, today, '2027-02-02', '4 months (2026-10-02 to 2027-02-02)']);
  assert.equal(def.recipe, 'position-cycle@1');
  assert.equal(position.resolveRunHorizon(ws, { args: { horizon: '3 months' }, today }).end_date, '2027-01-02');
  assert.equal(position.resolveRunHorizon(ws, { args: { horizon: '2-4 months' }, today }).months, 4, 'a range uses its end');
  assert.throws(() => position.resolveRunHorizon(ws, { args: { horizon: '6 weeks' }, today }), /whole number of calendar months/);
  assert.throws(() => position.resolveRunHorizon(ws, { args: { horizon: 'soon' }, today }), /not readable/);
  // Not in the agreed mission, so by default a longer horizon is allowed and labeled long-term.
  const open = position.resolveRunHorizon(ws, { args: { horizon: '24 months' }, today });
  assert.deepEqual([open.mode, open.exception_reason, open.end_date], ['long_term', null, '2028-10-02']);
  assert.equal(position.policy(ws).require_long_term_reason, false);
  // When Eric turns the rule on, a long horizon needs his reason.
  ws.settings.research.horizon_policy = { require_long_term_reason: true };
  assert.throws(() => position.resolveRunHorizon(ws, { args: { horizon: '24 months' }, today }), /long-term exception and needs your reason/);
  const lt = position.resolveRunHorizon(ws, { args: { horizon: '24 months', long_term_reason: 'FICTIONAL structural thesis' }, today });
  assert.deepEqual([lt.mode, lt.end_date, lt.exception_reason], ['long_term', '2028-10-02', 'FICTIONAL structural thesis']);
  assert.match(lt.text, /long-term exception/);
  // "Same as last" keeps the length and the reason, re-anchored to today.
  const again = position.resolveRunHorizon(ws, { args: { same_as_last: true }, previous: [{ horizon: lt }], today: '2026-11-15' });
  assert.deepEqual([again.mode, again.start_date, again.end_date, again.exception_reason], ['long_term', '2026-11-15', '2028-11-15', 'FICTIONAL structural thesis']);
  // A run from before this recipe: its length under today's policy.
  assert.throws(() => position.resolveRunHorizon(ws, { args: { same_as_last: true }, previous: [{ horizon: { text: '24 months', low_months: 24, high_months: 24 } }], today }), /needs your reason/);
  assert.equal(position.resolveRunHorizon(ws, { args: { same_as_last: true }, previous: [{ horizon: { text: '3 months', low_months: 3, high_months: 3 } }], today }).months, 3);
  // A project default above the ceiling carries its own recorded reason.
  const pd = position.resolveRunHorizon(ws, { project: { research_defaults: { horizon: '12 months', long_term_reason: 'FICTIONAL project reason' } }, today });
  assert.deepEqual([pd.mode, pd.exception_reason, pd.source], ['long_term', 'FICTIONAL project reason', 'project_default']);
  // A settings default above the ceiling is not used silently: the policy default applies.
  delete ws.settings.research.horizon_policy;
  ws.settings.research.default_horizon = '24 months';
  assert.equal(position.resolveRunHorizon(ws, { today }).source, 'policy_default');
  ws.settings.research.default_horizon = '2 months';
  assert.equal(position.resolveRunHorizon(ws, { today }).months, 2);
});

test('a run gets the position prompt (@5) with its dates and the market snapshot, identical for every model, without private notes', async (t) => {
  const { ws, root, cleanup } = tempWorkspace('runv3');
  t.after(cleanup);
  addFixtureProject(ws);
  notes.setConvictionNote(ws, PID, 'FICTIONAL-PRIVATE-NOTE-7731 must never reach a prompt.');
  // Before any market snapshot: the prompt says the context is unknown.
  const r0 = research.createRun(ws, { project_id: PID, providers: ['claude', 'chatgpt', 'gemini'] });
  const run0 = r0.run;
  assert.equal(run0.prompt.version, 'cr-research-prompt@5');
  assert.equal(run0.horizon.recipe, 'position-cycle@1');
  assert.equal(run0.horizon.start_date, ymdInTz());
  assert.equal(run0.evidence_packet.market_snapshot_id, null);
  const prompt0 = fs.readFileSync(path.join(root, run0.prompt.path), 'utf8');
  assert.match(prompt0, /CR-PROMPT cr-research-prompt@5/);
  assert.ok(prompt0.includes(`${run0.horizon.start_date} to ${run0.horizon.end_date}`));
  assert.match(prompt0, /none was available when this run was created/);
  assert.match(prompt0, /"position_context"/);
  assert.match(prompt0, /Dated catalysts, confirmation conditions and invalidators/);
  assert.match(prompt0, /dated catalysts and supply events inside the holding period/);
  assert.ok(!prompt0.includes('FICTIONAL-PRIVATE-NOTE-7731'), 'private notes never reach the prompt');
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(prompt0), 'every placeholder filled');
  const packet0 = readJson(path.join(root, run0.evidence_packet.path));
  assert.equal(packet0.market_context.status, 'unknown');
  // With a snapshot (FICTIONAL), a later run carries it by ID.
  const snapId = cycle.saveSnapshot(ws, cycle.buildSnapshot({ global: { data: { total_market_cap: { usd: 2e12 }, market_cap_percentage: { btc: 55.5, eth: 12 }, updated_at: Math.floor(Date.now() / 1000) } }, rows: [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', current_price: 60000, price_change_percentage_7d_in_currency: 1, price_change_percentage_30d_in_currency: 4, last_updated: new Date().toISOString() }, { id: 'alt-fictional', symbol: 'alt', name: 'Alt (FICTIONAL)', current_price: 2, price_change_percentage_7d_in_currency: 3, price_change_percentage_30d_in_currency: 9, last_updated: new Date().toISOString() }], fictional: true }));
  const r1 = research.createRun(ws, { project_id: PID, providers: ['claude', 'chatgpt', 'gemini'], horizon: '3 months', force_new: true });
  assert.equal(r1.run.evidence_packet.market_snapshot_id, snapId);
  const packet1 = readJson(path.join(root, r1.run.evidence_packet.path));
  assert.equal(packet1.market_context.snapshot_id, snapId);
  assert.equal(packet1.market_context.breadth.d30.beating_btc, 1);
  const prompt1 = fs.readFileSync(path.join(root, r1.run.prompt.path), 'utf8');
  assert.ok(prompt1.includes(`(snapshot ${snapId})`));
  assert.match(prompt1, /BTC dominance 55\.5%/);
  // One canonical prompt file per run, hashed.
  assert.equal(require('../core/fsx').sha256(prompt1), r1.run.prompt.sha256);
});

test('the position block is read and checked without touching any score', (t) => {
  const { ws, cleanup } = tempWorkspace('pcnorm');
  t.after(cleanup);
  addFixtureProject(ws);
  const run = research.createRun(ws, { project_id: PID, providers: ['claude'] }).run;
  const text = v3Report(ws, run, 'claude');
  const raw = JSON.parse(text.slice(text.indexOf('```json') + 7, text.lastIndexOf('```')));
  const withCtx = normalizeAssessment(ws, raw, { format: 'appendix_json', provider: 'claude' });
  const pc = withCtx.assessment.position_context;
  assert.deepEqual([pc.market.state, pc.timing.state, pc.timing.next_review_date], ['bitcoin_led', 'early', addDays(run.horizon.start_date, 30)]);
  assert.equal(pc.catalyst_windows[0].in_horizon, true);
  assert.equal(withCtx.issues.filter((i) => String(i.field).startsWith('position_context')).length, 0, JSON.stringify(withCtx.issues));
  // Removing the block changes no grade.
  const raw2 = JSON.parse(JSON.stringify(raw));
  delete raw2.position_context;
  const without = normalizeAssessment(ws, raw2, { format: 'appendix_json', provider: 'claude' });
  assert.deepEqual(gradeAssessment(ws, without.assessment), gradeAssessment(ws, withCtx.assessment));
  assert.ok(without.issues.some((i) => i.field === 'position_context' && /asked for a position_context block/.test(i.message)), 'a @3 report without the block is flagged');
  // Unknown words, impossible dates and dangling references are flagged, never guessed.
  const bad = JSON.parse(JSON.stringify(raw));
  bad.position_context.market.state = 'altseason imminent';
  bad.position_context.timing.next_review_date = 'next quarter';
  bad.position_context.timing.evidence_refs = ['C99'];
  bad.catalysts[0].window_start = addDays(run.horizon.start_date, 50);
  bad.catalysts[0].window_end = addDays(run.horizon.start_date, 10);
  const n = normalizeAssessment(ws, bad, { format: 'appendix_json', provider: 'claude' });
  const npc = n.assessment.position_context;
  assert.equal(npc.market.state, 'unknown');
  assert.equal(npc.market.state_raw, 'altseason imminent');
  assert.equal(npc.timing.next_review_date, null);
  assert.ok(n.issues.some((i) => /not one of unknown, bitcoin_led/.test(i.message)));
  assert.ok(n.issues.some((i) => /not a calendar date/.test(i.message)));
  assert.ok(n.issues.some((i) => /ends before it starts/.test(i.message)));
  const integ = citationIntegrity(n.assessment);
  assert.ok(integ.issues.some((i) => i.path === 'position_context.timing.evidence_refs[0]' && i.id === 'C99'));
  // A review date after the horizon ends is shown with a warning.
  const late = JSON.parse(JSON.stringify(raw));
  late.position_context.timing.next_review_date = addDays(run.horizon.end_date, 10);
  assert.ok(normalizeAssessment(ws, late, { format: 'appendix_json', provider: 'claude' }).issues.some((i) => /after the horizon ends/.test(i.message)));
});

test('an imported answer is bound to its run; a different horizon is recorded, not hidden', (t) => {
  const { ws, cleanup } = tempWorkspace('pcbind');
  t.after(cleanup);
  addFixtureProject(ws);
  const run = research.createRun(ws, { project_id: PID, providers: ['claude', 'chatgpt'] }).run;
  const ok = inbox.importContent(ws, 'claude', { content: v3Report(ws, run, 'claude'), projectId: PID, runId: run.run_id });
  assert.equal(ok.result.status, 'ingested', ok.result.message);
  const wrong = inbox.importContent(ws, 'chatgpt', { content: v3Report(ws, run, 'chatgpt', { pc: { horizon: { mode: 'position', start_date: run.horizon.start_date, end_date: addDays(run.horizon.end_date, 30) } } }), projectId: PID, runId: run.run_id });
  assert.equal(wrong.result.status, 'ingested', wrong.result.message);
  const reps = loadReports(ws, PID);
  const c = reps.find((r) => r.meta.provider === 'claude').assessment.position_context;
  const g = reps.find((r) => r.meta.provider === 'chatgpt');
  assert.equal(c.run_binding.horizon_matches, true);
  assert.equal(g.assessment.position_context.run_binding.horizon_matches, false);
  assert.ok(g.record.extraction.issues.some((i) => /is not the run's/.test(i.message)));
  // Both jobs completed; the run keeps its own horizon.
  const after = research.loadRun(ws, PID, run.run_id);
  assert.equal(after.jobs.claude.state, 'completed');
  assert.equal(after.jobs.chatgpt.state, 'completed');
  assert.equal(after.horizon.end_date, run.horizon.end_date);
});

test('the index shows each model\'s timing view and review date; older reports say not in this recipe', (t) => {
  const { ws, cleanup } = tempWorkspace('pcindex');
  t.after(cleanup);
  addFixtureProject(ws);
  dropFixture(ws, 'gemini', 'example-payfi-fictional__gemini.md');
  inbox.scanInbox(ws, { force: true });
  const run = research.createRun(ws, { project_id: PID, providers: ['claude'] }).run;
  const soon = addDays(ymdInTz(), 3);
  inbox.importContent(ws, 'claude', { content: v3Report(ws, run, 'claude', { pc: { timing: { next_review_date: soon } } }), projectId: PID, runId: run.run_id });
  const idx = buildIndex(ws);
  const p = idx.projects.find((x) => x.project_id === PID);
  assert.equal(p.providers.claude.position.status, 'provided');
  assert.equal(p.providers.claude.position.timing_label, 'Early');
  assert.equal(p.providers.claude.position.market_label, 'Bitcoin-led');
  assert.equal(p.providers.claude.position.next_review_date, soon);
  assert.equal(p.providers.claude.position.catalysts_in_horizon, 1);
  assert.equal(p.providers.gemini.position.status, 'not_in_recipe');
  assert.ok(idx.attention.some((a) => a.kind === 'review_suggested' && a.project_id === PID), 'a close suggested review is surfaced');
  assert.ok(idx.calendar.some((e) => e.type === 'suggested_review' && e.date === soon));
  assert.ok(idx.calendar.some((e) => e.type === 'catalyst' && e.precision === 'window' && e.window_end));
  assert.equal(idx.horizon_policy.planning_ceiling_months, 4);
  // Once you put a review on your calendar on or before it, the suggestion is covered.
  notes.addEvent(ws, PID, { type: 'review', title: 'Review thesis', due: soon });
  assert.ok(!buildIndex(ws).attention.some((a) => a.kind === 'review_suggested'));
});

test('mock providers answer a position run end to end; grades come from the scores alone', async (t) => {
  const { ws, cleanup } = tempWorkspace('pcmock', { research: { providers: { claude: { mock: 'ok' }, chatgpt: { mock: 'ok' }, gemini: { mock: 'ok' } } } });
  t.after(cleanup);
  addFixtureProject(ws);
  const created = research.createRun(ws, { project_id: PID, providers: ['claude', 'chatgpt', 'gemini'] });
  await research.runDueJobs(ws, { trigger: 'test' });
  const run = research.loadRun(ws, PID, created.run_id);
  for (const p of ['claude', 'chatgpt', 'gemini']) assert.equal(run.jobs[p].state, 'completed', `${p}: ${run.jobs[p].error}`);
  const reps = loadReports(ws, PID);
  assert.equal(reps.length, 3);
  for (const r of reps) {
    const pc = r.assessment.position_context;
    assert.ok(pc, `${r.meta.provider} has a position block`);
    assert.equal(pc.run_binding.horizon_matches, true);
    assert.equal(r.assessment.prompt_version, 'cr-research-prompt@5');
    assert.equal(r.assessment.sector_profile, 'payfi-credit@2', 'the run used the current version of the project\'s profile');
  }
});

function request(port, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = require('http').request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('dashboard route: a long horizon needs its reason; the timing view survives a restart', async (t) => {
  const { ws, root, cleanup } = tempWorkspace('pcserver', { research: { horizon_policy: { require_long_term_reason: true } } });
  t.after(cleanup);
  addFixtureProject(ws);
  const { start } = require('../server');
  const srv = await start(ws, { port: 49010 + Math.floor(Math.random() * 40), quiet: true });
  let stopped = false;
  t.after(() => { if (!stopped) try { srv.shutdown(); } catch (_) { /* stopped */ } });
  const session = (await request(srv.port, { path: '/api/session' })).body;
  const post = (p, body) => request(srv.port, { method: 'POST', path: p, headers: { 'x-cr-token': session.token, origin: `http://127.0.0.1:${srv.port}`, 'content-type': 'application/json' }, body });
  const refused = await post(`/api/projects/${PID}/research`, { providers: ['claude'], horizon: '12 months', submission_id: 'uitestpcsrv000001' });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.match(refused.body.error, /needs your reason/);
  const ok = await post(`/api/projects/${PID}/research`, { providers: ['claude'], horizon: '12 months', long_term_reason: 'FICTIONAL reason from the dashboard', submission_id: 'uitestpcsrv000002' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.run.horizon.mode, 'long_term');
  assert.equal(ok.body.run.horizon.exception_reason, 'FICTIONAL reason from the dashboard');
  // The settings default must stay inside the ceiling.
  const badDefault = await post('/api/settings', { research: { default_horizon: '24 months' } });
  assert.equal(badDefault.status, 400);
  assert.match(badDefault.body.error, /planning ceiling/);
  // Import an answer, stop the server, reopen the workspace: the view is still there.
  const run = research.loadRun(ws, PID, ok.body.run_id);
  inbox.importContent(ws, 'claude', { content: v3Report(ws, run, 'claude'), projectId: PID, runId: run.run_id });
  srv.shutdown();
  stopped = true;
  const { openWorkspace } = require('../core/workspace');
  const ws2 = openWorkspace({ root, actor: 'test-restart' });
  const p = buildIndex(ws2).projects.find((x) => x.project_id === PID);
  assert.equal(p.providers.claude.position.status, 'provided');
  assert.equal(p.providers.claude.position.horizon.mode, 'long_term');
  assert.equal(p.providers.claude.position.horizon_matches_run, true);
});

test('Cowork request queue: a long-term research request needs its reason; with it, it is saved once', (t) => {
  const { ws, root, cleanup } = tempWorkspace('pcqueue', { research: { horizon_policy: { require_long_term_reason: true } } });
  t.after(cleanup);
  addFixtureProject(ws);
  const requests = require('../core/requests');
  const put = (id, args) => fs.writeFileSync(path.join(root, 'inbox', 'requests', `${id}.json`), JSON.stringify({ schema_version: 'cr.request.v1', request_id: id, created_by: 'cowork', action: 'research_project', args: { project_id: PID, providers: ['claude', 'chatgpt', 'gemini'], channel: 'cowork', ...args } }));
  put('req_pc_noreason', { horizon: '24 months' });
  requests.processRequests(ws);
  const no = JSON.parse(fs.readFileSync(path.join(root, 'logs', 'requests', 'req_pc_noreason.result.json'), 'utf8'));
  assert.notEqual(no.status, 'done');
  assert.match(JSON.stringify(no), /needs your reason/);
  put('req_pc_reason', { horizon: '24 months', long_term_reason: 'FICTIONAL owner reason' });
  requests.processRequests(ws);
  const yes = JSON.parse(fs.readFileSync(path.join(root, 'logs', 'requests', 'req_pc_reason.result.json'), 'utf8'));
  assert.equal(yes.status, 'done', JSON.stringify(yes));
  const runs = research.listRuns(ws, PID);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].horizon.mode, 'long_term');
  assert.equal(runs[0].horizon.exception_reason, 'FICTIONAL owner reason');
  assert.equal(runs[0].jobs.claude.mode, 'cowork', 'the Cowork session does the Claude job');
  // The default request (no horizon) is a position run.
  put('req_pc_default', {});
  requests.processRequests(ws);
  const def = JSON.parse(fs.readFileSync(path.join(root, 'logs', 'requests', 'req_pc_default.result.json'), 'utf8'));
  assert.ok(['done', 'unchanged'].includes(def.status), JSON.stringify(def));
});
