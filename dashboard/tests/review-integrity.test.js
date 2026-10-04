'use strict';
// The follow-up engineering review of 2026-10-04 (REVIEW.md, baseline
// 6b5f909): F1 completion paths, F3 timestamps, F4 DefiLlama identity, F5
// request caps and provider waits, F6 history parsing, F7 the phone drawer.
// Each case drives the production handler (the desk connector's own
// save_report, the import path, the research runner with a provider stand-in,
// the fundamentals and price refreshes). Fictional workspaces, reports and
// provider answers only; global fetch fails, so nothing is ever sent anywhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { tempWorkspace, addFixtureProject } = require('./helpers');
const { makeMcp } = require('../mcp');
const research = require('../core/research');
const inbox = require('../core/inbox');
const indexer = require('../core/indexer');
const projects = require('../core/projects');
const fundamentals = require('../core/fundamentals');
const market = require('../core/market');
const digest = require('../core/digest');
const reports = require('../core/reports');
const { loadReports } = require('../core/reports');
const { mockReport } = require('../core/demo');
const { openWorkspace } = require('../core/workspace');
const { readJson, atomicWrite, jsonText, readJsonLines } = require('../core/fsx');

const PID = 'example-payfi-fictional';
const HOUR = 3600000;
const DAY = 86400000;

function noNetwork(t) {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network access is not allowed in tests');
  });
}

function setup(t, label, settings = {}) {
  const { ws, root, cleanup } = tempWorkspace(label, settings);
  t.after(cleanup);
  noNetwork(t);
  addFixtureProject(ws);
  return { ws, root };
}

// One tools/call through the connector's request handler, as the given
// model's connection (its sign-in decides the model).
async function call(ws, assistant, name, args) {
  const handle = makeMcp(ws, {});
  const req = Readable.from([Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }))]);
  req.method = 'POST';
  let body = '';
  const res = { writeHead() {}, end(s) { body = s || ''; } };
  await handle(req, res, { assistant, client_name: `FICTIONAL ${assistant}` });
  const r = JSON.parse(body).result;
  return { ...r, data: r.structuredContent || null, text: r.content.map((c) => c.text).join('\n') };
}

// The model's report for a run, its JSON block edited, with optional prose
// put before the report.
function reportFor(ws, provider, run, edit = null, prose = '') {
  const text = mockReport(ws, provider, run);
  const m = text.match(/```json\n([\s\S]*?)\n```/);
  const obj = JSON.parse(m[1]);
  if (edit) edit(obj);
  return `${prose}${text.replace(m[1], JSON.stringify(obj, null, 2))}`;
}

const jobOf = (ws, runId, p) => research.loadRun(ws, PID, runId).jobs[p];
const savedBy = (ws, p) => loadReports(ws, PID).filter((r) => !r.broken && r.meta.provider === p);
const rowOf = (ws, p) => indexer.buildIndex(ws).projects.find((x) => x.project_id === PID).providers[p];

// ---------------------------------------------------------------------------
// F1: a report completes only the frozen run it was written for

test('F1: a valid save for run A (payfi-credit@2) never completes run B (general-token@2) or an identical later run C; both keep waiting', async (t) => {
  const { ws } = setup(t, 'f1-cross');
  const a = research.createRun(ws, { project_id: PID, providers: ['chatgpt'], channel: 'dashboard' }).run;
  assert.equal(a.sector_profile, 'payfi-credit@2');
  projects.updateProjectFields(ws, PID, { sector_profile: 'general-token@2' });
  const b = research.createRun(ws, { project_id: PID, providers: ['chatgpt'], channel: 'dashboard', force_new: true }).run;
  assert.equal(b.sector_profile, 'general-token@2');
  assert.equal(b.horizon.text, a.horizon.text, 'same horizon');
  assert.equal(b.owner_instructions, a.owner_instructions, 'same owner questions');
  // A third run on the very same contract except its own run ID and prompt.
  projects.updateProjectFields(ws, PID, { sector_profile: 'payfi-credit@1' });
  const c = research.createRun(ws, { project_id: PID, providers: ['chatgpt'], channel: 'dashboard', force_new: true }).run;
  assert.equal(c.sector_profile, a.sector_profile);
  assert.notEqual(c.prompt.sha256, a.prompt.sha256, 'each run\'s frozen prompt names its own run');

  const out = await call(ws, 'chatgpt', 'save_report', { project_id: PID, run_id: a.run_id, report_markdown: reportFor(ws, 'chatgpt', a) });
  assert.equal(out.data.status, 'saved', out.text);
  const reportId = out.data.report.report_id;
  assert.equal(jobOf(ws, a.run_id, 'chatgpt').state, 'completed');
  assert.equal(jobOf(ws, a.run_id, 'chatgpt').report_id, reportId);
  for (const other of [b, c]) {
    const j = jobOf(ws, other.run_id, 'chatgpt');
    assert.equal(j.state, 'unconfigured', `${other.run_id} still waits for its own report`);
    assert.equal(j.report_id, null);
    assert.equal(j.covered_by_run, undefined);
  }
  assert.match(out.text, new RegExp(`${b.run_id}`), 'the reply says which other runs still wait');
  assert.deepEqual((await call(ws, 'chatgpt', 'pending_research', {})).data.pending.map((x) => x.run_id).sort(), [b.run_id, c.run_id].sort());
  // The report links to A only.
  const rep = savedBy(ws, 'chatgpt');
  assert.equal(rep.length, 1);
  assert.equal(rep[0].meta.provenance.research_run_id, a.run_id);
  // A run whose frozen evidence packet changed after it started binds nothing.
  fs.appendFileSync(ws.abs(c.evidence_packet.path), '\n');
  const tampered = await call(ws, 'chatgpt', 'save_report', { project_id: PID, run_id: c.run_id, report_markdown: reportFor(ws, 'chatgpt', c) });
  assert.equal(tampered.isError, true);
  assert.match(tampered.text, /frozen evidence packet no longer matches the SHA-256 recorded when the run started/);
  assert.equal(jobOf(ws, c.run_id, 'chatgpt').state, 'unconfigured');
});

test('F1: an API answer that declares another run\'s profile is kept with its receipt but quarantined: excluded from grades, the job is not completed and needs attention', (t) => {
  const { ws } = setup(t, 'f1-record');
  const run = research.createRun(ws, { project_id: PID, providers: ['chatgpt'], channel: 'dashboard' }).run;
  const text = reportFor(ws, 'chatgpt', run, (o) => { o.sector_profile = 'payfi-credit@1'; o.research_run_id = 'run_2026-09-30T120000Z_other'; });
  const out = inbox.importContent(ws, 'chatgpt', { content: text, projectId: PID, runId: run.run_id, attested: { provider: 'openai', model: 'FICTIONAL', response_id: 'resp_fictional_q1' }, channel: 'OpenAI API' });
  assert.equal(out.result.status, 'ingested', out.result.message);
  assert.equal(out.result.quarantined, true);
  const rep = savedBy(ws, 'chatgpt');
  assert.equal(rep.length, 1, 'the answer is kept as its own original');
  assert.equal(rep[0].meta.provenance.attested.response_id, 'resp_fictional_q1', 'with the provider receipt');
  assert.equal(rep[0].meta.provenance.binding.status, 'conflict');
  assert.deepEqual(rep[0].meta.provenance.binding.conflicts.sort(), ['research_run_id', 'sector_profile']);
  assert.equal(reports.isEligible(rep[0]), false, 'never an authoritative grade');
  assert.match(rep[0].assessment.eligibility.reason, /does not match research run/);
  const job = jobOf(ws, run.run_id, 'chatgpt');
  assert.notEqual(job.state, 'completed');
  assert.equal(job.state, 'failed', 'not dispatchable: only Eric can retry it');
  assert.equal(job.outcome, 'contract_conflict');
  assert.equal(job.report_id, null);
  assert.equal(job.quarantined_report_id, rep[0].report_id);
  const idx = indexer.buildIndex(ws);
  assert.equal(idx.projects.find((x) => x.project_id === PID).providers.chatgpt, null, 'no grade on the watchlist from a quarantined answer');
  assert.equal(idx.projects.find((x) => x.project_id === PID).research.providers.chatgpt.outcome, 'contract_conflict');
  assert.ok(idx.attention.some((x) => x.kind === 'research_conflict' && x.project_id === PID), 'listed for Eric');
});

test('F1: an API answer whose sent prompt or evidence packet hash differs from the run\'s frozen contract is quarantined the same way', (t) => {
  const { ws } = setup(t, 'f1-hash');
  const run = research.createRun(ws, { project_id: PID, providers: ['chatgpt', 'gemini'], channel: 'dashboard' }).run;
  const prompt = inbox.importContent(ws, 'chatgpt', { content: reportFor(ws, 'chatgpt', run), projectId: PID, runId: run.run_id, attested: { provider: 'openai', model: 'FICTIONAL' }, promptSha256: 'f'.repeat(64), evidenceSha256: run.evidence_packet.sha256, channel: 'OpenAI API' });
  assert.equal(prompt.result.quarantined, true);
  assert.deepEqual(savedBy(ws, 'chatgpt')[0].meta.provenance.binding.conflicts, ['prompt_sha256']);
  assert.notEqual(jobOf(ws, run.run_id, 'chatgpt').state, 'completed');
  const packet = inbox.importContent(ws, 'gemini', { content: reportFor(ws, 'gemini', run), projectId: PID, runId: run.run_id, attested: { provider: 'google', model: 'FICTIONAL' }, promptSha256: run.prompt.sha256, evidenceSha256: 'e'.repeat(64), channel: 'Gemini API' });
  assert.equal(packet.result.quarantined, true);
  assert.deepEqual(savedBy(ws, 'gemini')[0].meta.provenance.binding.conflicts, ['evidence_packet_sha256']);
  assert.notEqual(jobOf(ws, run.run_id, 'gemini').state, 'completed');
  // The matching hashes, on another run: bound, completed.
  const run2 = research.createRun(ws, { project_id: PID, providers: ['chatgpt'], channel: 'dashboard', force_new: true }).run;
  const good = inbox.importContent(ws, 'chatgpt', { content: reportFor(ws, 'chatgpt', run2), projectId: PID, runId: run2.run_id, attested: { provider: 'openai', model: 'FICTIONAL' }, promptSha256: run2.prompt.sha256, evidenceSha256: run2.evidence_packet.sha256, channel: 'OpenAI API' });
  assert.equal(good.result.quarantined, undefined);
  assert.equal(jobOf(ws, run2.run_id, 'chatgpt').state, 'completed');
});

// A Claude API stand-in that answers every request with the given text.
function anthropicStandIn(text) {
  const calls = [];
  const f = async (url, opts) => {
    if (url !== 'https://api.anthropic.com/v1/messages') throw new Error(`unexpected call ${url}`);
    calls.push(JSON.parse(opts.body));
    const json = { id: `msg_fictional_${calls.length}`, model: 'claude-test-model', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 12000, output_tokens: 3000, server_tool_use: { web_search_requests: 2 } } };
    return { ok: true, status: 200, headers: { get: (k) => (k === 'request-id' ? `req_fictional_${calls.length}` : null) }, text: async () => JSON.stringify(json) };
  };
  f.calls = calls;
  return f;
}

function apiWorkspace(t, label) {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-FICTIONAL-KEY';
  t.after(() => { if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev; });
  const { ws: ws0, root } = setup(t, label);
  const file = path.join(root, 'config', 'settings.json');
  const s = readJson(file);
  s.research = { providers: { claude: { model: 'claude-test-model', input_usd_per_mtok: 3, output_usd_per_mtok: 15, search_usd_per_call: 0.01, max_searches: 5 } }, budget: { per_run_usd: 2, daily_usd: 5, monthly_usd: 20 }, max_output_tokens: 8000 };
  atomicWrite(file, jsonText(s));
  void ws0;
  return { ws: openWorkspace({ root, actor: 'test' }), root };
}

test('F1: a paid answer that declares another contract, through the provider stand-in, capture and import: raw answer, usage and cost kept; not completed; never resent, after a restart either', async (t) => {
  const { ws, root } = apiWorkspace(t, 'f1-paid');
  const run = research.createRun(ws, { project_id: PID, providers: ['claude'] }).run;
  assert.equal(run.jobs.claude.state, 'queued');
  const wrong = reportFor(ws, 'claude', run, (o) => { o.sector_profile = 'payfi-credit@1'; o.model_self_identification = 'Claude (Anthropic)'; });
  const f = anthropicStandIn(wrong);
  // The runner stops between saving the answer and importing it.
  const orig = inbox.importContent;
  inbox.importContent = () => { throw new Error('FICTIONAL: runner stopped before the import'); };
  try {
    await research.runDueJobs(ws, { fetchImpl: f, trigger: 'test' });
  } finally {
    inbox.importContent = orig;
  }
  assert.equal(f.calls.length, 1);
  let job = jobOf(ws, run.run_id, 'claude');
  assert.ok(job.attempts[0].response_path, 'the answer was saved');
  // Restart: the saved answer is imported, quarantined, and nothing is sent again.
  await research.runDueJobs(ws, { fetchImpl: f, trigger: 'restart' });
  await research.runDueJobs(ws, { fetchImpl: f, trigger: 'again' });
  assert.equal(f.calls.length, 1, 'the paid request is never repeated');
  job = jobOf(ws, run.run_id, 'claude');
  assert.equal(job.state, 'failed');
  assert.equal(job.outcome, 'contract_conflict');
  assert.equal(job.report_id, null);
  assert.equal(job.attempts.length, 1);
  const a = job.attempts[0];
  assert.equal(a.response_id, 'msg_fictional_1', 'the provider receipt');
  assert.ok(a.cost_actual_usd > 0, 'its cost is counted');
  assert.equal(a.quarantined, true);
  assert.ok(fs.existsSync(path.join(root, a.response_path)), 'the raw answer stays on disk');
  const spend = readJsonLines(path.join(root, 'logs', 'research-spend.jsonl')).filter((l) => l.run_id === run.run_id);
  assert.ok(spend.some((l) => l.kind === 'actual'), 'the ledger records what it cost');
  const rep = savedBy(ws, 'claude');
  assert.equal(rep.length, 1);
  assert.equal(reports.isEligible(rep[0]), false);
  assert.equal(rep[0].meta.provenance.attested.response_id, 'msg_fictional_1');
  assert.equal(rowOf(ws, 'claude'), null, 'no grade from it');
  // A recovery pass over a job left marked running never completes it either.
  const rel = `projects/${PID}/research/${run.run_id}/run.json`;
  require('../core/ops').runOp(ws, { type: 'test_left_running', summary: 'FICTIONAL: a job left marked running' }, (op) => {
    const r = op.readJson(rel);
    r.jobs.claude.state = 'running';
    op.writeJson(rel, r);
  });
  await research.runDueJobs(ws, { fetchImpl: f, trigger: 'restart-2' });
  job = jobOf(ws, run.run_id, 'claude');
  assert.notEqual(job.state, 'completed');
  assert.notEqual(job.state, 'queued');
  assert.equal(f.calls.length, 1);
});

// ---------------------------------------------------------------------------
// F3: timestamps

test('F3: an observation that coincides with the analysis stamp is evidence: both changed is a new original, while a pure restamp the same day stays one report', () => {
  const day = '2026-10-04';
  const base = (stamp, obs) => [
    '# FICTIONAL report',
    '',
    `As of ${stamp}. FICTIONAL sources accessed ${stamp}.`,
    '',
    `FICTIONAL executed swap filled at ${obs}; FICTIONAL 1H candle closed ${obs}.`,
    '',
    '```json',
    JSON.stringify({ schema_version: 'cr.report.v2', analysis_at: stamp, sources: [{ source_id: 'S1', url: 'https://example.com/s', accessed_at: stamp }], summary: 'FICTIONAL' }, null, 2),
    '```',
    '',
  ].join('\n');
  const first = base(`${day}T08:00:00Z`, `${day}T08:00:00Z`);
  const moved = base(`${day}T09:00:00Z`, `${day}T09:00:00Z`);
  assert.equal(inbox.sameReportText(first, moved).same, false, 'the swap and candle moved: another report');
  const restamp = base(`${day}T09:00:00Z`, `${day}T08:00:00Z`);
  assert.equal(inbox.sameReportText(first, restamp).same, true, 'only the "As of" and "accessed" stamps moved');
  assert.equal(inbox.sameReportText(first, base(`${day}T08:00:00Z`, `${day}T09:00:00Z`)).same, false, 'an observation that equalled the stamp moved, the stamp did not');
});

test('F3: through the connector, a re-save whose analysis time and coinciding swap observation both move is a revision kept as its own original, never "unchanged"', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-04T18:00:00Z') });
  const { ws } = setup(t, 'f3-collide');
  const run = research.createRun(ws, { project_id: PID, providers: ['chatgpt'], channel: 'dashboard' }).run;
  const stamped = (stamp) => reportFor(ws, 'chatgpt', run, (o) => {
    o.analysis_at = stamp;
    for (const s of o.sources) s.accessed_at = stamp;
  }, `As of ${stamp}. FICTIONAL executed swap filled at ${stamp}.\n\n`);
  const first = await call(ws, 'chatgpt', 'save_report', { project_id: PID, run_id: run.run_id, report_markdown: stamped('2026-10-04T08:00:00Z') });
  assert.equal(first.data.status, 'saved', first.text);
  const second = stamped('2026-10-04T09:00:00Z');
  const bare = await call(ws, 'chatgpt', 'save_report', { project_id: PID, run_id: run.run_id, report_markdown: second });
  assert.equal(bare.isError, true, 'another report for the same run needs a revision reason');
  assert.match(bare.text, /A different report for the same run is a revision/);
  const rev = await call(ws, 'chatgpt', 'save_report', { project_id: PID, run_id: run.run_id, report_markdown: second, revision: { kind: 'new_evidence', note: 'FICTIONAL: the swap filled an hour later than first written.' } });
  // new_evidence without a new source is refused; a reassessment is kept.
  assert.equal(rev.isError, true);
  const kept = await call(ws, 'chatgpt', 'save_report', { project_id: PID, run_id: run.run_id, report_markdown: second, revision: { kind: 'reassessment', note: 'FICTIONAL: the swap filled an hour later than first written.' } });
  assert.equal(kept.data.status, 'saved', kept.text);
  assert.notEqual(kept.data.report.report_id, first.data.report.report_id);
  assert.equal(savedBy(ws, 'chatgpt').length, 2, 'two append-only originals');
});

test('F3: dates are validated and ordered as instants: locale and RFC future dates are future, invalid calendar dates unreadable, offsets normalized', () => {
  const saved = '2026-10-04T12:00:00.000Z';
  const at = (s) => reports.analysisTiming(s, saved);
  assert.equal(at('October 12, 2026').status, 'future');
  assert.equal(at('Mon, 12 Oct 2026 08:00:00 GMT').status, 'future');
  assert.equal(at('12 October 2026 08:00 UTC').status, 'future');
  assert.equal(at('October 3, 2026').status, 'ok');
  assert.equal(at('October 3, 2026').zone, 'nonstandard');
  assert.equal(at('2026-02-30').status, 'unreadable');
  assert.equal(at('2026-02-30T10:00:00Z').status, 'unreadable');
  assert.equal(at('2026-13-01T10:00:00Z').status, 'unreadable');
  assert.equal(at('2026-10-05').status, 'ok', 'a calendar date a day ahead is allowed');
  assert.equal(at('2026-10-07').status, 'future');
  assert.equal(at('2026-10-04T13:30:00+02:00').normalized, '2026-10-04T11:30:00.000Z');
  assert.equal(at('2026-10-04T10:00').zone, 'none');
  assert.equal(at('2026-10-04T10:00').status, 'ok');
});

test('F3: a connected model\'s report dated "October 12, 2026" is refused as after its save; an imported one never sorts as latest by its raw text', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-04T18:00:00Z') });
  const { ws } = setup(t, 'f3-locale');
  const run = research.createRun(ws, { project_id: PID, providers: ['chatgpt'], channel: 'dashboard' }).run;
  const refused = await call(ws, 'chatgpt', 'save_report', { project_id: PID, run_id: run.run_id, report_markdown: reportFor(ws, 'chatgpt', run, (o) => { o.analysis_at = 'October 12, 2026'; }) });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /analysis_at: the report says "October 12, 2026"/);
  assert.equal(savedBy(ws, 'chatgpt').length, 0);
  // Two standalone imports: a non-ISO stated date (past), then an ISO one
  // saved later. The later save is the latest, whatever the raw text says.
  const standalone = (analysisAt, summary) => reportFor(ws, 'claude', run, (o) => {
    delete o.research_run_id;
    o.analysis_at = analysisAt;
    o.summary = summary;
  });
  const x = inbox.importContent(ws, 'claude', { content: standalone('October 3, 2026', 'FICTIONAL first'), projectId: PID, channel: 'dashboard paste' });
  assert.equal(x.result.status, 'ingested', x.result.message);
  t.mock.timers.tick(HOUR);
  const y = inbox.importContent(ws, 'claude', { content: standalone('2026-10-04T18:30:00Z', 'FICTIONAL second'), projectId: PID, channel: 'dashboard paste' });
  assert.equal(y.result.status, 'ingested', y.result.message);
  assert.equal(rowOf(ws, 'claude').report_id, y.result.report_id, 'ordered by instants, not by "O" > "2"');
  const xr = savedBy(ws, 'claude').find((r) => r.report_id === x.result.report_id);
  assert.equal(xr.assessment.analysis_at, 'October 3, 2026', 'the stated text is kept as written');
  // A future non-ISO date imported by hand sorts at its save time.
  t.mock.timers.tick(HOUR);
  const z = inbox.importContent(ws, 'claude', { content: standalone('December 31, 2026', 'FICTIONAL third'), projectId: PID, channel: 'dashboard paste' });
  assert.equal(z.result.status, 'ingested', z.result.message);
  const zr = savedBy(ws, 'claude').find((r) => r.report_id === z.result.report_id);
  assert.ok(reports.reportSortKey(zr).startsWith(zr.meta.imported_at), 'sorted by when it was saved');
});

// ---------------------------------------------------------------------------
// F4: DefiLlama answers must identify the bound entity

const LNOW = Date.parse('2026-10-04T15:00:00Z');
const point = (date, v) => [Date.parse(`${date}T00:00:00Z`) / 1000, v];
const full = (v, nowMs = LNOW) => {
  const today = Math.floor(nowMs / DAY) * DAY;
  return Array.from({ length: 30 }, (_, i) => point(new Date(today - (30 - i) * DAY).toISOString().slice(0, 10), v));
};
const reply = (status, payload, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => (headers[String(k).toLowerCase()] === undefined ? null : headers[String(k).toLowerCase()]) },
  text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
});
const identified = (chart, extra = {}) => ({ name: 'Example Lend', displayName: 'Example Lend', slug: 'example-lend', defillamaId: '9001', protocolType: 'protocol', methodology: { Fees: 'FICTIONAL fees.', Revenue: 'FICTIONAL revenue.', HoldersRevenue: 'FICTIONAL holders revenue.' }, totalDataChart: chart, ...extra });
function llama(byType) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    const type = new URL(url).searchParams.get('dataType');
    const a = typeof byType[type] === 'function' ? await byType[type](calls) : byType[type];
    return a || reply(400, 'not found');
  };
  f.calls = calls;
  return f;
}
const FAST = { retryDelayMs: 0, pauseMs: 0 };

function bindLend(t, label, settings = {}) {
  const { ws, root, cleanup } = tempWorkspace(label, settings);
  t.after(cleanup);
  noNetwork(t);
  const out = projects.addProject(ws, { name: 'Example Lend (FICTIONAL)', symbol: 'XLND', official_website: 'https://xlnd.example/', coingecko_id: 'xlnd-fictional', evidence: [{ url: 'https://xlnd.example/docs', note: 'fictional test evidence' }], sector: 'defi', defillama: { slug: 'example-lend', scope: 'product', source_url: 'https://defillama.com/protocol/example-lend' } });
  return { ws, root, id: out.project_id };
}
const fblock = (ws, id, now = LNOW) => fundamentals.packetBlock(ws, projects.getProject(ws, id), { now });

test('F4: an HTTP-200 series with no entity identity publishes nothing; the last good snapshot and its age stay, with an honest reason', async (t) => {
  const { ws, id } = bindLend(t, 'f4-anon');
  const anon = (v, nowMs = LNOW) => ({ methodology: {}, totalDataChart: full(v, nowMs) });
  // No snapshot yet: nothing usable from an anonymous answer.
  const r0 = await fundamentals.refresh(ws, { fetchImpl: llama({ dailyFees: reply(200, anon(9)), dailyRevenue: reply(200, anon(9)), dailyHoldersRevenue: reply(200, anon(9)) }), now: LNOW, ...FAST });
  assert.notEqual(r0.status, 'ok', r0.message);
  const b0 = fblock(ws, id);
  assert.equal(b0.state, 'unidentified');
  assert.equal(b0.fees_30d_usd, undefined, 'no total from an unidentified answer');
  assert.match(b0.reason, /does not identify/);
  // A good refresh, then an anonymous one 13 hours later.
  const ok = await fundamentals.refresh(ws, { fetchImpl: llama({ dailyFees: reply(200, identified(full(7))), dailyRevenue: reply(200, identified(full(1))), dailyHoldersRevenue: reply(200, identified(full(0))) }), now: LNOW, force: true, ...FAST });
  assert.equal(ok.status, 'ok', ok.message);
  const later = LNOW + 13 * HOUR;
  await fundamentals.refresh(ws, { fetchImpl: llama({ dailyFees: reply(200, anon(9, later)), dailyRevenue: reply(200, anon(9, later)), dailyHoldersRevenue: reply(200, anon(9, later)) }), now: later, force: true, ...FAST });
  const b = fblock(ws, id, later);
  assert.equal(b.fees_30d_usd, 210, 'the last good snapshot stays');
  assert.equal(b.age_hours, 13);
  assert.equal(b.state, 'fresh_last_failed');
  assert.equal(b.last_refresh_failure.outcome, 'unidentified');
  assert.equal(b.metrics.fees.status, 'complete', 'its coverage as it was');
});

test('F4: a scope must be shown, not assumed; per-metric identities and scopes must agree; a renamed slug or a parent is refused', async (t) => {
  const { ws, id } = bindLend(t, 'f4-scope');
  const cases = [
    ['no scope evidence', () => identified(full(1), { defillamaId: undefined, protocolType: undefined })],
    ['revenue from a parent', (type) => identified(full(1), type === 'dailyRevenue' ? { defillamaId: 'parent#example-lend', childProtocols: [{ name: 'Example Lend V1' }] } : {})],
    ['holders revenue from another id', (type) => identified(full(1), type === 'dailyHoldersRevenue' ? { defillamaId: '9002' } : {})],
    ['a renamed slug', () => identified(full(1), { slug: 'example-lend-v2', name: 'Example Lend V2', displayName: 'Example Lend V2' })],
    ['a chain', () => identified(full(1), { protocolType: 'chain', defillamaId: 'chain#example' })],
  ];
  let now = LNOW;
  for (const [what, make] of cases) {
    now += 13 * HOUR;
    const f = llama(Object.fromEntries(['dailyFees', 'dailyRevenue', 'dailyHoldersRevenue'].map((type) => [type, reply(200, { ...make(type), totalDataChart: full(1, now) })])));
    const r = await fundamentals.refresh(ws, { fetchImpl: f, now, force: true, ...FAST });
    assert.notEqual(r.status, 'ok', `${what}: ${r.message}`);
    const b = fblock(ws, id, now);
    assert.equal(b.fees_30d_usd, undefined, `${what}: nothing published`);
    assert.ok(['unidentified', 'entity_mismatch', 'scope_mismatch'].includes(b.state), `${what}: ${b.state}`);
  }
  // A name-only answer whose name is the bound slug's entity is identified.
  now += 13 * HOUR;
  const named = (v) => ({ name: 'Example Lend', protocolType: 'protocol', methodology: {}, totalDataChart: full(v, now) });
  const r = await fundamentals.refresh(ws, { fetchImpl: llama({ dailyFees: reply(200, named(2)), dailyRevenue: reply(200, named(1)), dailyHoldersRevenue: reply(200, named(0)) }), now, force: true, ...FAST });
  assert.equal(r.status, 'ok', r.message);
  assert.equal(fblock(ws, id, now).fees_30d_usd, 60);
});

// ---------------------------------------------------------------------------
// F5: request caps and provider waits

test('F5: a DefiLlama budget is a hard cap on attempts, retries included: budgets 1 to 4 never overshoot and nothing partial is published', async (t) => {
  for (const budget of [1, 2, 3, 4, 6]) {
    const { ws, id } = bindLend(t, `f5-budget-${budget}`, { fundamentals: { monthly_request_budget: budget } });
    // Every metric's first try answers 500, its retry answers.
    const seen = new Map();
    const flaky = (type) => () => {
      seen.set(type, (seen.get(type) || 0) + 1);
      return seen.get(type) === 1 ? reply(500, 'busy') : reply(200, identified(full(1)));
    };
    const f = llama({ dailyFees: flaky('dailyFees'), dailyRevenue: flaky('dailyRevenue'), dailyHoldersRevenue: flaky('dailyHoldersRevenue') });
    const r = await fundamentals.refresh(ws, { fetchImpl: f, now: LNOW, ...FAST });
    const st = fundamentals.readStatus(ws);
    assert.ok(f.calls.length <= budget, `budget ${budget}: sent ${f.calls.length}`);
    assert.equal(st.calls ? st.calls.month_count : 0, f.calls.length, `budget ${budget}: every sent attempt counted once`);
    if (budget < 3) {
      // Less than one project's three requests: nothing is started.
      assert.equal(r.status, 'budget_paused', r.message);
      assert.equal(f.calls.length, 0);
    } else if (budget >= 6) {
      assert.equal(r.status, 'ok', r.message);
      assert.equal(fblock(ws, id).fees_30d_usd, 30);
    } else {
      assert.equal(f.calls.length, budget, `budget ${budget}: stops at the cap`);
      assert.notEqual(r.status, 'ok');
      assert.match(r.message, /budget/i);
      assert.equal(fblock(ws, id).fees_30d_usd, undefined, 'an incomplete refresh publishes nothing');
      assert.equal((await fundamentals.refresh(ws, { fetchImpl: f, now: LNOW + 60000, force: true, ...FAST })).status, 'budget_paused');
      assert.equal(f.calls.length, budget, 'nothing more is sent');
    }
  }
});

test('F5: two DefiLlama refreshes at once share one lease and one budget: never more requests than the cap', async (t) => {
  const { ws } = bindLend(t, 'f5-concurrent', { fundamentals: { monthly_request_budget: 3 } });
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const f = llama({ dailyFees: async () => { await hold; return reply(500, 'busy'); }, dailyRevenue: reply(500, 'busy'), dailyHoldersRevenue: reply(500, 'busy') });
  const one = fundamentals.refresh(ws, { fetchImpl: f, now: LNOW, ...FAST });
  const two = fundamentals.refresh(ws, { fetchImpl: f, now: LNOW, force: true, ...FAST });
  release();
  await Promise.all([one, two]);
  assert.ok(f.calls.length <= 3, `sent ${f.calls.length}`);
  assert.equal(fundamentals.readStatus(ws).calls.month_count, f.calls.length);
});

test('F5: a 24-hour DefiLlama Retry-After is honored in full, across a restart, for forced and scheduled refreshes; an unreadable one waits a bounded default', async (t) => {
  const { ws, root, id } = bindLend(t, 'f5-llama-wait');
  await fundamentals.refresh(ws, { fetchImpl: llama({ dailyFees: reply(200, identified(full(1))), dailyRevenue: reply(200, identified(full(1))), dailyHoldersRevenue: reply(200, identified(full(1))) }), now: LNOW, ...FAST });
  const t1 = LNOW + 13 * HOUR;
  const limited = llama({ dailyFees: reply(429, 'slow down', { 'retry-after': String(24 * 3600) }) });
  const r = await fundamentals.refresh(ws, { fetchImpl: limited, now: t1, force: true, ...FAST });
  assert.equal(r.rate_limited, true);
  assert.equal(r.retry_at, new Date(t1 + 24 * HOUR).toISOString(), 'the whole wait the server asked for');
  // A restart: a fresh workspace handle reads the same gate.
  const ws2 = openWorkspace({ root, actor: 'test' });
  for (const hours of [6.5, 12, 23.9]) {
    const at = t1 + hours * HOUR;
    const again = await fundamentals.refresh(ws2, { fetchImpl: limited, now: at, force: true, ...FAST });
    assert.deepEqual([again.status, again.rate_limited], ['backoff', true], `${hours} h later, forced`);
    assert.equal(fundamentals.isDue(ws2, at), false, `${hours} h later, scheduled`);
  }
  assert.equal(limited.calls.length, 1, 'nothing sent before the deadline');
  const t2 = t1 + 24 * HOUR + 60000;
  const back = await fundamentals.refresh(ws2, { fetchImpl: llama({ dailyFees: reply(200, identified(full(2, t2))), dailyRevenue: reply(200, identified(full(1, t2))), dailyHoldersRevenue: reply(200, identified(full(1, t2))) }), now: t2, force: true, ...FAST });
  assert.equal(back.status, 'ok', back.message);
  assert.equal(fblock(ws2, id, t2).fees_30d_usd, 60);
  // An unreadable header: a bounded local wait, never longer than the backoff ceiling.
  const t3 = t2 + 2 * HOUR;
  await fundamentals.refresh(ws2, { fetchImpl: llama({ dailyFees: reply(429, '', { 'retry-after': 'tomorrow-ish' }) }), now: t3, force: true, ...FAST });
  const st = fundamentals.readStatus(ws2);
  assert.equal(st.rate_limit.retry_after_ms, null);
  assert.ok(st.rate_limit.wait_ms <= 360 * 60000);
});

function enableMarket(ws, root, extra = {}) {
  const file = path.join(root, 'config', 'settings.json');
  const s = readJson(file);
  s.market_data = { enabled: true, ...extra };
  atomicWrite(file, jsonText(s));
  ws.reloadSettings();
}

test('F5: a 24-hour CoinGecko Retry-After closes the shared gate for 24 hours, across a restart; a missing header waits a bounded default', async (t) => {
  const { ws, root } = setup(t, 'f5-cg-wait');
  enableMarket(ws, root);
  const g = market.noteRateLimit(ws, { retryAfterMs: 24 * HOUR, source: 'prices' });
  assert.ok(Math.abs(Date.parse(g.until) - (Date.now() + 24 * HOUR)) < 5000, `until ${g.until}`);
  const ws2 = openWorkspace({ root, actor: 'test' });
  const calls = [];
  const r = await market.refresh(ws2, { fetchImpl: async (url) => { calls.push(url); throw new Error('must not be called'); }, force: true });
  assert.deepEqual([r.status, r.rate_limited], ['backoff', true]);
  assert.equal(calls.length, 0);
  assert.equal(market.rateLimitGate(ws2, Date.now() + 23 * HOUR).open, false);
  assert.equal(market.rateLimitGate(ws2, Date.now() + 24 * HOUR + 10000).open, true);
  // No header: the local doubling stays bounded by backoff_max_minutes.
  const { ws: ws3, root: root3, cleanup } = tempWorkspace('f5-cg-default');
  t.after(cleanup);
  enableMarket(ws3, root3);
  for (let i = 0; i < 8; i++) market.noteRateLimit(ws3, { source: 'prices' });
  assert.ok(market.readStatus(ws3).rate_limit.wait_ms <= 60 * 60000);
});

test('F5: CoinGecko requests are reserved before they are sent: an identity search during a price refresh never overshoots the monthly budget', async (t) => {
  const { ws, root } = setup(t, 'f5-cg-budget');
  enableMarket(ws, root, { max_ids_per_call: 2, monthly_call_budget: 3 });
  assert.equal(market.trackedIds(ws).length, 4, 'two price requests');
  const sent = [];
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const row = (id) => ({ id, symbol: id.slice(0, 4), name: id, current_price: 1.5, market_cap: 1e6, total_volume: 1e5, last_updated: new Date().toISOString() });
  const f = async (url) => {
    sent.push(url);
    if (/\/search\?/.test(url)) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ coins: [] }) };
    if (sent.filter((u) => /coins\/markets/.test(u)).length === 1) await hold;
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => decodeURIComponent(new URL(url).searchParams.get('ids')).split(',').map(row) };
  };
  const refresh = market.refresh(ws, { fetchImpl: f, force: true });
  await new Promise((r) => setImmediate(r));
  const s1 = await market.searchCoins(ws, 'fictional one', { fetchImpl: f });
  const s2 = await market.searchCoins(ws, 'fictional two', { fetchImpl: f });
  release();
  const r = await refresh;
  assert.ok(sent.length <= 3, `sent ${sent.length}: ${sent.map((u) => new URL(u).pathname).join(', ')}`);
  assert.equal(market.readStatus(ws).calls.month_count, sent.length, 'each sent request counted once');
  assert.ok([s1.status, s2.status, r.status].some((s) => s === 'budget_paused' || s === 'partial'), JSON.stringify([s1.status, s2.status, r.status]));
});

// ---------------------------------------------------------------------------
// F6: one parse of the month's price history per index rebuild

test('F6: an index rebuild reads each month of price history once and gives the same volume changes and digest prices across a month boundary', (t) => {
  const { ws, root } = setup(t, 'f6-history');
  const ids = ['example-payfi-fictional', 'xtwo-fictional', 'xthree-fictional'];
  for (const [i, sym] of [[1, 'XTWO'], [2, 'XTHREE']]) {
    projects.addProject(ws, { name: `Example ${sym} (FICTIONAL)`, symbol: sym, official_website: `https://${sym.toLowerCase()}.example/`, coingecko_id: ids[i], evidence: [{ url: `https://${sym.toLowerCase()}.example/docs`, note: 'fictional' }], sector: 'defi' });
  }
  // Hourly observations from 2026-09-29 to 2026-10-01 10:00Z: two month files.
  const end = Date.parse('2026-10-01T10:00:00Z');
  const lines = {};
  for (let h = 72; h >= 0; h--) {
    const at = end - h * HOUR;
    const month = new Date(at).toISOString().slice(0, 7);
    (lines[month] = lines[month] || []).push(JSON.stringify({ fetched_at: new Date(at).toISOString(), provider: 'coingecko', trigger: 'test', assets: ids.map((id, i) => ({ id, price_usd: 1 + i + h / 100, volume_24h_usd: 1000 * (i + 1) + h, source_last_updated_at: new Date(at - 60000).toISOString() })) }));
  }
  fs.mkdirSync(path.join(root, 'market-data', 'observations'), { recursive: true });
  for (const [m, l] of Object.entries(lines)) fs.writeFileSync(path.join(root, 'market-data', 'observations', `${m}.jsonl`), `${l.join('\n')}\n`);
  assert.deepEqual(Object.keys(lines).sort(), ['2026-09', '2026-10']);
  const latest = { schema_version: 'cr.market-latest.v2', provider: 'coingecko', fetched_at: new Date(end).toISOString(), assets: Object.fromEntries(ids.map((id, i) => [id, { id, price_usd: 2 + i, volume_24h_usd: 5000 * (i + 1), source_last_updated_at: new Date(end).toISOString(), fetched_at: new Date(end).toISOString() }])) };
  atomicWrite(path.join(root, 'market-data', 'latest.json'), jsonText(latest));
  // Without a shared cache, the readers' own answers.
  const expected = ids.map((id) => market.volumeChange24h(ws, id, latest.assets[id]));
  assert.ok(expected.every((v) => v && Number.isFinite(v.pct)), JSON.stringify(expected));
  const since = Date.parse('2026-09-30T20:00:00Z');
  const cache = new Map();
  assert.deepEqual(ids.map((id) => market.volumeChange24h(ws, id, latest.assets[id], { history: cache })), expected, 'the same results from the shared parse');
  const reviewed = digest.changesSince(ws, PID, { since: new Date(since).toISOString(), latestMarket: latest });
  assert.deepEqual(digest.changesSince(ws, PID, { since: new Date(since).toISOString(), latestMarket: latest, history: cache }).price, reviewed.price);
  // A rebuild opens each month file once.
  const reads = [];
  const real = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (p, ...rest) {
    if (/observations[\\/]\d{4}-\d{2}\.jsonl$/.test(String(p))) reads.push(path.basename(String(p)));
    return real.call(this, p, ...rest);
  });
  const idx = indexer.buildIndex(ws, { now: end });
  const counts = reads.reduce((m, f) => ({ ...m, [f]: (m[f] || 0) + 1 }), {});
  assert.deepEqual(counts, { '2026-10.jsonl': 1, '2026-09.jsonl': 1 }, JSON.stringify(counts));
  for (const [i, id] of ids.entries()) {
    const p = idx.projects.find((x) => x.coingecko_id === id);
    assert.equal(p.market.volume_change_24h_pct, expected[i].pct, id);
  }
});

// ---------------------------------------------------------------------------
// F7: the phone drawer and the watchlist caption

test('F7: the phone drawer takes the containing width (no 100vw under a classic scrollbar); the caption no longer promises hover scorecards', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  // The full-screen panel at phone width: the rule that gives it the whole height.
  const rule = (css.match(/#panel-root \.panel \{[^}]*100dvh[^}]*\}/) || [''])[0];
  assert.ok(rule, 'the phone panel rule exists');
  assert.doesNotMatch(rule, /100vw/);
  assert.match(rule, /left: 0/);
  assert.match(rule, /right: 0/);
  assert.match(rule, /width: auto/);
  const wl = fs.readFileSync(path.join(__dirname, '..', 'public', 'views', 'watchlist.js'), 'utf8');
  assert.doesNotMatch(wl, /scorecard on hover/i);
  assert.match(wl, /Space or Enter opens and closes a project/);
});
