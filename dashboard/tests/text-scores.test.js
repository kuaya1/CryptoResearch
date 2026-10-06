'use strict';
// The written report against its own data block (core/textscores.js), read
// at read time and never written: a score the text states that differs from
// the data block the grade is calculated from is said (the project record,
// the Brief's notices, the connector's get_report), and neither side is
// chosen or changed. Also the completed job's original against a later save
// for the same run (views/project.js jobSaves, the connector's progress).
// Everything is FICTIONAL, in throwaway workspaces; no provider is called.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { pathToFileURL } = require('url');
const { tempWorkspace, addFixtureProject, FIXTURES } = require('./helpers');
const inbox = require('../core/inbox');
const projects = require('../core/projects');
const research = require('../core/research');
const { makeMcp } = require('../mcp');
const { mockReport } = require('../core/demo');
const { loadReports } = require('../core/reports');
const { projectDetail } = require('../core/indexer');
const { textScoreChecks } = require('../core/textscores');

const ROOT = path.join(__dirname, '..', '..');
const GRADING = require(path.join(ROOT, 'templates', 'rubrics', 'cr-grading.v1.json'));
const PROFILE = require(path.join(ROOT, 'templates', 'rubrics', 'network-infrastructure.v2.json'));

// The browser modules, as ES modules (nothing touches the DOM here).
let tmp;
async function load() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-textscores-'));
  fs.cpSync(path.join(__dirname, '..', 'public'), tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{ "type": "module" }');
  return {
    model: await import(pathToFileURL(path.join(tmp, 'brief-model.js')).href),
    project: await import(pathToFileURL(path.join(tmp, 'views', 'project.js')).href),
  };
}
const mods = load();
test.after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

const A = {
  investment_components: {
    sustainable_business_demand: { status: 'scored', value: 53 },
    token_value_capture: { status: 'scored', value: 47 },
    valuation_supply: { status: 'scored', value: 44 },
    risk_resilience: { status: 'range', low: 55, high: 70 },
    btc_relative_asymmetry: { status: 'scored', value: 43 },
    timing_executable_liquidity: { status: 'unknown', value: null, missing_data: 'FICTIONAL' },
  },
  diagnostic_scores: { token_value_capture: { status: 'scored', value: 49 }, code_quality: { status: 'scored', value: 58 }, cycle_timing: { status: 'scored', value: 53 } },
};
const check = (prose) => textScoreChecks(`${prose}\n\n\`\`\`json\n{ "schema_version": "cr.report.v2" }\n\`\`\`\n`, A, { grading: GRADING, profile: PROFILE });

test('text vs data: clear statements are compared; a range where the data block has a point, another number, or a score where it has unknown are said', () => {
  const out = check([
    'Investment inputs: Sustainable business demand 45–60; Token value capture 47; Valuation and supply **44**; Risk resilience 55-70; BTC-relative asymmetry 35 to 50; Timing and executable liquidity 61.',
    '| Category | Score |',
    '| Code quality | 58 |',
    '| Cycle position and catalyst timing | 40 |',
  ].join('\n'));
  assert.deepEqual(out.mismatches.map((m) => [m.id, m.text, m.data]), [
    ['sustainable_business_demand', ['45–60'], '53'],
    ['btc_relative_asymmetry', ['35–50'], '43'],
    ['timing_executable_liquidity', ['61'], 'unknown'],
    ['cycle_timing', ['40'], '53'],
  ]);
  assert.equal(out.compared, 8);
  assert.match(out.summary, /^The written report gives 4 scores that differ from its data block: Sustainable business demand 45–60 in the text, 53 in the data block; .* The grade is calculated from the data block as saved; the text is kept as written, and neither is changed\.$/);
});

test('text vs data: what is never read as a score, and what agrees', () => {
  const quiet = check([
    'Sustainable business demand rose 30 days after launch.',
    'Token value capture 31% of fees reach holders.',
    'Valuation and supply 2.5x the peers.',
    'Code quality 3/5 in the old rubric.',
    'Sustainable business demand 45–60 → 53 after the revision.',
    'Earlier, Sustainable business demand 45–60; it was narrowed.',
    'BTC-relative asymmetry 35–50 (central 43).',
    'Risk resilience 60.',
    'Token value capture 49 (category).',
    'Timing and executable liquidity unknown.',
    '## 5. Chart, volume and cycle 2026',
  ].join('\n'));
  assert.deepEqual(quiet.mismatches, [], JSON.stringify(quiet.mismatches));
  // A name a component and a category share agrees when it matches either.
  assert.equal(quiet.compared, 4);
  // Nothing found to compare is said as nothing compared, never as a clean result.
  assert.equal(check('A report that states no scores in its text.').summary, null);
  assert.equal(check('A report that states no scores in its text.').compared, 0);
});

// The fictional v5 report, through the import path, with a summary line whose
// timing range the data block no longer carries (the Linea case).
const NET = 'example-network-fictional';
const FIXTURE = fs.readFileSync(path.join(FIXTURES, 'reports', `${NET}__claude.v5.md`), 'utf8');
const FENCE_AT = FIXTURE.indexOf('```json');
const PROSE = FIXTURE.slice(0, FENCE_AT);
const BASE = JSON.parse(FIXTURE.slice(FENCE_AT + 7, FIXTURE.lastIndexOf('\n```')));

test('text vs data through the import path: said on the project record and in the Brief\'s notices; the original, the scores and the grade stay as saved', async (t) => {
  const { model } = await mods;
  const { ws, cleanup } = tempWorkspace('text-scores');
  t.after(cleanup);
  projects.addProject(ws, {
    name: 'Example Network (FICTIONAL)', symbol: 'XNET', official_website: 'https://example.net/xnet',
    assets: [{ chain: 'example-chain', contract_address: 'FICTIONAL-CONTRACT-XNET' }],
    evidence: [{ url: 'https://example.net/xnet/docs', note: 'fictional test evidence' }], sector: 'ai_data',
  });
  const j = JSON.parse(JSON.stringify(BASE));
  const timing = j.investment_components.timing_executable_liquidity.value;
  const line = `Investment components: Timing and executable liquidity ${timing - 5}–${timing + 10}.\n\n`;
  const text = `${PROSE}${line}\`\`\`json\n${JSON.stringify(j, null, 2)}\n\`\`\`\n`;
  const out = inbox.importContent(ws, 'claude', { content: text, projectId: NET });
  assert.equal(out.result.status, 'ingested', out.result.message);
  const rid = out.result.report_id;
  const dir = ws.abs(`projects/${NET}/reports/${rid}`);
  const snap = () => fs.readdirSync(dir).sort().map((f) => `${f}:${fs.readFileSync(path.join(dir, f)).toString('base64')}`).join('|');
  const before = snap();
  const d = projectDetail(ws, NET);
  const r = d.reports.find((x) => x.report_id === rid);
  assert.deepEqual(r.text_scores.mismatches.map((m) => [m.id, m.text, m.data]), [['timing_executable_liquidity', [`${timing - 5}–${timing + 10}`], String(timing)]]);
  assert.ok(r.text_scores.compared >= 13, 'the category table was compared too, and agrees');
  // The scores and the grade are the data block's, unchanged.
  assert.equal(r.assessment.investment_components.timing_executable_liquidity.value, timing);
  const plain = inbox.importContent(ws, 'claude', { content: FIXTURE.replace('Analysis date', 'FICTIONAL plain. Analysis date'), projectId: NET });
  const p = projectDetail(ws, NET).reports.find((x) => x.report_id === plain.result.report_id);
  assert.equal(r.grade.value, p.grade.value, 'the same grade as the same data block without the line');
  assert.deepEqual(p.text_scores.mismatches, [], 'the fixture\'s own text agrees with its data block');
  // Reading writes nothing.
  assert.equal(snap(), before);
  // The Brief's notices say it, with both values.
  const n = model.noticesOf({ r, sel: { isLatest: false, latest: null }, provider: 'claude', row: null, index: {}, history: [], ev: {}, hz: {} });
  const tn = n.find((x) => x.kind === 'text_scores');
  assert.deepEqual(tn.items, [{ label: 'Timing and executable liquidity', text: [`${timing - 5}–${timing + 10}`], data: String(timing) }]);
  // A report read from prose (no data block) has nothing to compare.
  const prose = inbox.importContent(ws, 'claude', { content: `${PROSE}\nThe scores above are the whole report.\n`, projectId: NET });
  if (prose.result.status === 'ingested') assert.equal(projectDetail(ws, NET).reports.find((x) => x.report_id === prose.result.report_id).text_scores, null);
});

// One tools/call through the connector's own request handler.
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

test('a completed job keeps its original apart from a later save for the same run: the run links the latest, the first save stays and is named; the connector says both', async (t) => {
  const { project, model } = await mods;
  const { ws, cleanup } = tempWorkspace('text-scores-revision');
  t.after(cleanup);
  addFixtureProject(ws);
  const PID = 'example-payfi-fictional';
  const run = research.createRun(ws, { project_id: PID, providers: ['chatgpt'], channel: 'dashboard' }).run;
  // ChatGPT takes its waiting job through its connection, as on the desk.
  const took = await call(ws, 'chatgpt', 'start_research', { project_id: PID, owner_request: 'Do my waiting CryptoResearch research' });
  assert.equal(took.data.run.yours.mode, 'connector', took.text);
  const first = mockReport(ws, 'chatgpt', run);
  const a = await call(ws, 'chatgpt', 'save_report', { project_id: PID, run_id: run.run_id, report_markdown: first });
  assert.equal(a.data.status, 'saved', a.text);
  const m = first.match(/```json\n([\s\S]*?)\n```/);
  const o = JSON.parse(m[1]);
  const v = o.investment_components.timing_executable_liquidity.value;
  o.investment_components.timing_executable_liquidity = { ...o.investment_components.timing_executable_liquidity, value: v > 50 ? v - 10 : v + 10 };
  const second = first.replace(m[1], JSON.stringify(o, null, 2));
  const b = await call(ws, 'chatgpt', 'save_report', { project_id: PID, run_id: run.run_id, report_markdown: second, revision: { kind: 'reassessment', note: 'FICTIONAL: a changed timing judgment on the same evidence.' } });
  assert.equal(b.data.status, 'saved', b.text);
  const job = research.loadRun(ws, PID, run.run_id).jobs.chatgpt;
  assert.equal(job.state, 'completed');
  assert.equal(job.previous_report_ids.length, 1, 'the first save is kept on the job');
  const original = job.previous_report_ids[0];
  const d = projectDetail(ws, PID);
  const s = project.jobSaves(job, d.reports);
  assert.deepEqual([s.original, s.latest, s.basis], [original, job.report_id, 'existing_evidence']);
  assert.equal(s.text, `Completed by its first save, ${original}. The run now links ${job.report_id}, a revision using existing evidence (no source added). Both are kept.`);
  assert.equal(project.jobSaves({ ...job, previous_report_ids: [] }, d.reports), null, 'one save: nothing to tell apart');
  // Both reports stay saved.
  assert.deepEqual(loadReports(ws, PID).filter((r) => !r.broken).map((r) => r.report_id).sort(), [original, job.report_id].sort());
  // The Brief's history names each: the first report, then the revision on its evidence.
  const hist = model.historyOf(d, 'chatgpt', job.report_id, job.report_id);
  assert.equal(hist.find((x) => x.report_id === original).revision, 'First report');
  assert.match(hist.find((x) => x.report_id === job.report_id).revision, /^Revision using existing evidence \(no source added\)/);
  // The connector's progress names both.
  const g = await call(ws, 'chatgpt', 'get_research', { project_id: PID });
  assert.match(g.text, new RegExp(`saved \\(${job.report_id}, a later save for this run; the first save, ${original}, completed the job and stays saved\\)`));
});

test('the connector\'s get_report carries the text-vs-data comparison when the text and the data block differ', async (t) => {
  const { ws, cleanup } = tempWorkspace('text-scores-connector');
  t.after(cleanup);
  addFixtureProject(ws);
  const PID = 'example-payfi-fictional';
  const run = research.createRun(ws, { project_id: PID, providers: ['chatgpt'], channel: 'dashboard' }).run;
  const raw = mockReport(ws, 'chatgpt', run);
  const v = JSON.parse(raw.match(/```json\n([\s\S]*?)\n```/)[1]).investment_components.risk_resilience.value;
  const shown = v >= 90 ? v - 20 : v + 5;
  const text = raw.replace('```json', `Investment components: Risk resilience ${shown}.\n\n\`\`\`json`);
  const saved = await call(ws, 'chatgpt', 'save_report', { project_id: PID, run_id: run.run_id, report_markdown: text });
  assert.equal(saved.data.status, 'saved', saved.text);
  const rep = await call(ws, 'chatgpt', 'get_report', { project_id: PID });
  assert.deepEqual(rep.data.text_vs_data.mismatches, [{ item: 'Risk resilience', kind: 'weighted component', text: [String(shown)], data_block: String(v) }]);
  assert.match(rep.data.text_vs_data.summary, /The grade is calculated from the data block as saved/);
});
