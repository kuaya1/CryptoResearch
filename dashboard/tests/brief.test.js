'use strict';
// The Claude Brief (public/brief-model.js, public/views/brief.js) on FICTIONAL
// workspaces built through the real import path: which report it reads (the
// latest eligible Claude report; never a quarantined, excluded or PDF answer;
// an earlier report only when named), the desk's own grade (never the model's
// total), ranges as ranges and unknowns as unknowns, a timeline from saved
// dates only, evidence tags kept apart, the binding to its exact report, the
// empty states; and, read from the source, that opening it posts, refreshes,
// screens and researches nothing and never turns report text into HTML.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { buildBriefWorkspace, LONG_NAME, HOSTILE } = require('./brief-fixtures');
const { tempWorkspace, addFixtureProject } = require('./helpers');
const indexer = require('../core/indexer');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (rel) => fs.readFileSync(path.join(PUBLIC, rel), 'utf8');

// Nothing in these tests may reach the network.
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('network access is not allowed in tests'); };
test.after(() => { globalThis.fetch = realFetch; });

// The browser modules, as ES modules (nothing touches the DOM until a view renders).
let tmp;
async function load() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-brief-'));
  fs.cpSync(PUBLIC, tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{ "type": "module" }');
  const model = await import(pathToFileURL(path.join(tmp, 'brief-model.js')).href);
  return { model };
}
const mods = load();
test.after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

let fixture = null;
const fx = () => (fixture = fixture || buildBriefWorkspace('brief-test'));
test.after(() => { if (fixture) fixture.cleanup(); });

async function brief(key, { reportId = null, today = null, ws = null, pid = null } = {}) {
  const { model } = await mods;
  const w = ws || fx().ws;
  const id = pid || fx().pids[key];
  const index = indexer.buildIndex(w);
  const detail = indexer.projectDetail(w, id);
  const row = index.projects.find((p) => p.project_id === id) || null;
  const m = model.briefModel({ detail, row, index, provider: 'claude', reportId, ...(today ? { today } : {}) });
  return { m, detail, row, index };
}

test('selection: the latest eligible Claude report; a quarantined, excluded or PDF answer is never picked; a named report stays bound to itself', async () => {
  const f = fx();
  const c = await brief('complete');
  assert.equal(c.m.status, 'ok');
  assert.equal(c.m.report_id, f.reports.latest, 'the latest save of the newest run (a revision)');
  assert.equal(c.m.is_latest, true);
  assert.equal(c.m.report_id, c.detail.comparison.latest.claude.report_id, 'the same report the desk compares');

  // A newer answer that was quarantined does not replace the eligible one.
  const r = await brief('ranges');
  assert.equal(r.m.report_id, f.reports.range);
  const q = r.m.history.find((x) => x.report_id === f.reports.quarantinedLater);
  assert.ok(q && !q.eligible && q.excluded, 'listed as excluded, with its reason');

  // Only a quarantined answer: no brief, the reason said once.
  const only = await brief('quarantined');
  assert.equal(only.m.status, 'none');
  assert.equal(only.m.empty.quarantined.report_id, f.reports.quarantined);
  assert.match(only.m.empty.quarantined.reason, /does not match research run/);
  assert.equal(only.m.empty.can_run, false, 'its job exists, so no new research is offered here');

  // Named reports: an earlier one is shown and said to be earlier.
  const old = await brief('complete', { reportId: f.reports.earlier });
  assert.equal(old.m.status, 'ok');
  assert.equal(old.m.report_id, f.reports.earlier);
  assert.equal(old.m.is_latest, false);
  const older = old.m.notices.find((n) => n.kind === 'older');
  assert.equal(older.latest_id, f.reports.latest);
  // A quarantined answer, another model's report, an unknown ID: no brief.
  assert.equal((await brief('ranges', { reportId: f.reports.quarantinedLater })).m.status, 'ineligible');
  assert.equal((await brief('ranges', { reportId: f.reports.quarantinedLater })).m.empty.why.kind, 'quarantined');
  const gpt = c.detail.reports.find((x) => !x.broken && x.meta.provider === 'chatgpt');
  assert.ok(gpt, 'the fixture has a ChatGPT report');
  assert.equal((await brief('complete', { reportId: gpt.report_id })).m.status, 'other_provider');
  assert.equal((await brief('complete', { reportId: 'no-such-report' })).m.status, 'not_found');
});

test('selection: a PDF without a text copy and a report excluded by your correction carry no brief; an archived project offers no research', async (t) => {
  const { model } = await mods;
  const { ws, cleanup } = tempWorkspace('brief-pdf');
  t.after(cleanup);
  const p = addFixtureProject(ws);
  const inbox = require('../core/inbox');
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
  assert.equal(inbox.importContent(ws, 'claude', { content: pdf, filename: 'fictional.pdf', projectId: p.project_id }).result.status, 'ingested');
  let b = await brief(null, { ws, pid: p.project_id });
  assert.equal(b.m.status, 'none');
  assert.ok(b.m.empty.pdf, 'the PDF is named, with the way to import its text');
  assert.equal(b.m.empty.can_run, true);
  const pdfId = b.detail.reports[0].report_id;
  assert.equal((await brief(null, { ws, pid: p.project_id, reportId: pdfId })).m.empty.why.kind, 'pdf');

  // A text report you excluded from comparison (a correction): no brief.
  const text = require('./brief-fixtures').reportText({ project: { project_id: p.project_id, name: 'Example PayFi (FICTIONAL)' }, symbol: 'XMPL', profile: 'payfi-credit@1', analysisAt: '2026-09-20', horizon: { start: '2026-09-20', end: '2027-01-20', text: '4 months (2026-09-20 to 2027-01-20)', mode: 'position' } });
  const rid = inbox.importContent(ws, 'claude', { content: text, projectId: p.project_id }).result.report_id;
  assert.equal((await brief(null, { ws, pid: p.project_id })).m.report_id, rid);
  require('../core/notes').addCorrection(ws, p.project_id, rid, 'eligibility', { excluded: true, reason: 'FICTIONAL: excluded for the test' }, 'FICTIONAL test');
  b = await brief(null, { ws, pid: p.project_id });
  assert.equal(b.m.status, 'none');
  assert.equal(b.m.empty.excluded.report_id, rid);

  require('../core/projects').archiveProject(ws, p.project_id, 'FICTIONAL test');
  b = await brief(null, { ws, pid: p.project_id });
  assert.equal(b.m.empty.archived, true);
  assert.equal(b.m.empty.can_run, false, 'an archived project offers no research');
  assert.equal(typeof model.ineligibleReason, 'function');
});

test('grade: the desk\'s calculated grade and the rubric\'s word, never the model\'s own total; a difference is a notice with both figures', async () => {
  const { m, detail } = await brief('complete');
  const r = detail.reports.find((x) => x.report_id === m.report_id);
  assert.equal(m.grade.status, 'firm');
  assert.equal(m.grade.display, r.grade.display);
  assert.equal(m.grade.value, r.grade.value);
  assert.equal(m.grade.word, 'Adequate or mixed');
  assert.notEqual(Number(m.grade.display), 72, 'not the model\'s own total');
  const mt = m.notices.find((n) => n.kind === 'model_total');
  assert.equal(mt.reported, '72');
  assert.equal(mt.calculated, r.grade.display);
  assert.equal(mt.difference, r.model_total.difference);
  // The six weighted parts with their points, exactly as the desk calculated them.
  assert.deepEqual(m.components.map((c) => c.id), r.grade.parts.map((p) => p.id));
  assert.deepEqual(m.components.map((c) => c.contribution), r.grade.parts.map((p) => p.contribution));
  assert.deepEqual(m.components.map((c) => c.weight_pct), [20, 25, 20, 15, 10, 10]);
});

test('ranges stay ranges and unknowns stay unknown: never a midpoint, never a zero', async () => {
  const { m } = await brief('ranges');
  assert.equal(m.grade.status, 'range');
  assert.ok(m.grade.low < m.grade.high);
  assert.equal(m.grade.value, null, 'no point value for a range grade');
  assert.match(m.grade.word, / to /, 'the words of both ends');
  const val = m.components.find((c) => c.id === 'valuation_supply');
  assert.equal(val.status, 'range');
  assert.equal(val.contribution, null, 'no points for a range part');
  const cats = Object.fromEntries(m.categories.items.map((x) => [x.id, x]));
  assert.deepEqual([cats.organic_demand.status, cats.organic_demand.low, cats.organic_demand.high, cats.organic_demand.value], ['range', 30, 45, null]);
  assert.deepEqual([cats.chart_structure.status, cats.chart_structure.value, cats.chart_structure.tier], ['unknown', null, null]);
  assert.match(cats.chart_structure.missing, /no reliable chart data/);
  for (const x of m.categories.items) if (!['scored', 'range'].includes(x.status)) assert.ok(x.value === null && x.low === null && x.high === null && x.tier === null, `${x.id} carries no number`);
  const liq = m.risks.find((x) => x.id === 'liquidity');
  assert.deepEqual([liq.status, liq.low, liq.high, liq.value], ['range', 55, 70, null]);

  const w = (await brief('withheld')).m;
  assert.equal(w.grade.status, 'withheld');
  assert.equal(w.grade.coverage, 80, 'the scored share of the weight, not a score');
  assert.deepEqual(w.grade.why.items.map((x) => x.label).sort(), ['BTC-relative asymmetry', 'Timing and executable liquidity']);
  assert.ok(w.components.filter((c) => c.status === 'unknown').every((c) => c.contribution === null && c.score.value === null));
  assert.equal(w.notices.find((n) => n.kind === 'model_total_unchecked').reported, '58', 'its own total is kept, not checked against a grade that does not exist');
  assert.ok(w.structure && w.structure.flagged, 'the structure check on the unscored parts');
});

test('category grades: grouped as the research is (project, product, token, market), each with its confidence and flags; diagnostics only', async () => {
  const { m } = await brief('complete');
  assert.deepEqual(m.categories.groups.map((g) => g.id), ['project', 'product', 'token', 'market']);
  assert.equal(m.categories.items.length, 13);
  assert.deepEqual(m.categories.counts.total, 13);
  const code = m.categories.items.find((x) => x.id === 'code_quality');
  assert.equal(code.flags.length, 1, 'a scored code grade with no code read is flagged');
  assert.equal(code.flags[0].severity, 'medium');
  assert.equal(code.value, 61, 'the grade is shown as the model gave it');
  assert.equal(m.categories.items.find((x) => x.id === 'legitimacy').confidence, 'high');
  // An older profile (eleven categories, one not applicable) still groups, the rest under Other.
  const s = (await brief('sparse')).m;
  assert.ok(s.categories.groups.some((g) => g.id === 'other'));
  assert.equal(s.categories.items.find((x) => x.id === 'credit_risk_transparency').status, 'na');
});

test('thesis: answered from the report\'s own fields, each with where it comes from; an unknown grade is never an answer; nothing is written for a sparse report', async () => {
  const { m, detail } = await brief('complete');
  const a = detail.reports.find((x) => x.report_id === m.report_id).assessment;
  const [matters, capture, asym] = m.thesis;
  assert.equal(matters.answer.text, a.diagnostic_scores.technology_usefulness.rationale);
  assert.equal(matters.answer.from, 'category');
  assert.equal(capture.answer.text, a.investment_components.token_value_capture.rationale);
  assert.equal(capture.answer.from, 'component');
  assert.equal(asym.answer.text, a.independent_judgment.within_holding_period.view);
  assert.equal(asym.answer.kind, 'speculation', 'labeled as the model labeled it');
  assert.equal(asym.answer.test, a.independent_judgment.within_holding_period.disconfirming_test);
  assert.equal(m.verdict.summary, a.summary);
  assert.equal(m.verdict.final_take, a.final_take);
  assert.equal(m.verdict.label, 'Conditional opportunity');
  assert.deepEqual([m.verdict.timing.word, m.verdict.market.word], ['Early', 'Bitcoin-led']);

  const s = (await brief('sparse')).m;
  assert.equal(s.thesis[0].answer, null, 'only unknown product grades: no answer, never an unknown grade\'s note');
  assert.equal(s.verdict.summary, null);
  assert.equal(s.verdict.final_take, null);
  assert.deepEqual([s.supports.length, s.threatens.length, s.watch.items.length, s.scenarios], [0, 0, 0, null]);
  assert.equal(s.watch.horizon.start, null, 'no dates: no track, the horizon as written');
  assert.equal(s.watch.horizon.text, '3 months');
});

test('where the value goes: drawn only when the report quantifies two layers; a reported zero is a figure, an unknown is not reported', async () => {
  const { m } = await brief('complete');
  assert.equal(m.value.show, true);
  const holders = m.value.layers.find((l) => l.id === 'holders').items[0];
  assert.deepEqual([holders.id, holders.reported, holders.text, holders.tag], ['token_holder_distributions', true, '$0.00', 'V']);
  const staking = m.value.items.find((x) => x.id === 'staking_yield');
  assert.equal(staking.reported, false);
  assert.equal((await brief('ranges')).m.value.show, false, 'one layer only: no comparison is drawn');
  assert.equal((await brief('withheld')).m.value.show, false);
});

test('what supports and threatens it: three each at most, with the evidence tags and sources of the claims they cite; uncited and dangling references said', async () => {
  const { m } = await brief('complete');
  assert.equal(m.supports.length, 3);
  assert.deepEqual(m.supports.map((f) => f.tags), [['V'], ['C'], ['S']]);
  assert.equal(m.supports[0].sources.length, 2);
  assert.deepEqual(m.supports[2].dangling, ['C99']);
  assert.deepEqual(m.threatens.map((f) => f.tags), [['I'], ['V'], []], 'an uncited risk has no tag');
  // Higher is worse: the risk panel, apart from the quality grades.
  assert.deepEqual(m.risks.map((x) => x.id), ['credit', 'dilution', 'liquidity', 'overall_downside']);
  assert.equal(m.risks.find((x) => x.id === 'credit').status, 'na');
  assert.equal(m.risks.find((x) => x.id === 'dilution').value, 58);
});

test('key points before the scorecard: the strongest risk that cites a source, else the first said unsourced; the first confirm and break with how many more; the report\'s words only', async () => {
  const { model } = await mods;
  const { m } = await brief('complete');
  assert.equal(m.key.risk.text, m.threatens[0].text, 'the model\'s first risk cites a source here');
  assert.equal(m.key.risk.sourced, true);
  assert.ok(m.key.risk.sources.length >= 1);
  assert.equal(m.key.confirm, m.watch.confirms[0]);
  assert.equal(m.key.break, m.watch.breaks[0]);
  assert.equal(m.key.confirm_more, m.watch.confirms.length - 1);
  const a = {
    claims: [{ claim_id: 'C1', evidence_tag: 'I', source_ids: [] }, { claim_id: 'C2', evidence_tag: 'V', source_ids: ['S1'] }],
    sources: [{ source_id: 'S1', url: 'https://docs.example/fees', title: 'FICTIONAL docs' }],
    bearish_facts: [{ text: 'FICTIONAL: first risk, cites nothing with a source.', claim_ids: ['C1'] }, { text: 'FICTIONAL: second risk, sourced.', claim_ids: ['C2'] }],
  };
  const k = model.keyPoints(a);
  assert.deepEqual([k.risk.text, k.risk.sourced, k.risk.rank, k.risk.of], ['FICTIONAL: second risk, sourced.', true, 2, 2]);
  const bare = model.keyPoints({ bearish_facts: [{ text: 'FICTIONAL: unsourced.', claim_ids: [] }] });
  assert.deepEqual([bare.risk.text, bare.risk.sourced], ['FICTIONAL: unsourced.', false]);
  assert.deepEqual(model.keyPoints({}), { risk: null, confirm: null, confirm_more: 0, break: null, break_more: 0 });
  // [V] is named as the researcher's classification wherever the tag is a word.
  assert.equal(model.TAG_WORDS.V, 'Researcher-verified');
});

test('what to watch: dated catalysts and the suggested review, numbered in date order on the horizon; undated and outside apart; no date made up', async () => {
  const { model } = await mods;
  const base = await brief('complete');
  const start = base.m.watch.horizon.start;
  const { m } = await brief('complete', { today: require('../core/dates').addDays(start, 10) });
  const w = m.watch;
  assert.equal(w.horizon.source, 'report');
  assert.equal(w.horizon.months, 4);
  assert.deepEqual(w.items.map((x) => x.n), [1, 2, 3, 4]);
  assert.deepEqual(w.items.map((x) => x.kind), ['catalyst', 'review', 'catalyst', 'catalyst']);
  assert.ok(w.items.every((x, i) => !i || w.items[i - 1].start <= x.start), 'in date order');
  assert.ok(w.items.every((x) => x.pos >= 0 && x.pos <= 100 && x.pos_end >= x.pos));
  assert.equal(w.undated.length, 1);
  assert.equal(w.outside.length, 1);
  assert.equal(w.days.elapsed, 10);
  assert.equal(w.days.left, w.days.total - 10);
  assert.equal(w.ended, false);
  assert.match(w.review.trigger, /vote result/);
  assert.equal(w.metric.threshold, 'Fictional: passes with quorum');
  // The track: inside the horizon only, a window clipped to it.
  assert.equal(model.trackPos('2026-10-01', '2026-10-05', '2027-02-05'), null);
  assert.equal(model.trackPos('2026-10-05', '2026-10-05', '2027-02-05'), 0);
  assert.equal(model.trackPos('2027-02-05', '2026-10-05', '2027-02-05'), 100);
  assert.equal(model.trackPos('2026-11-01', '2026-11-01', '2026-11-01'), null, 'no horizon length');
  // No catalysts and no review in the report: none on the page.
  const r = (await brief('ranges')).m.watch;
  assert.deepEqual([r.items.length, r.review], [0, null]);
});

test('scenarios: the probability bar only for a complete set totaling 100; the price plot only with two ranges; what is missing stays missing', async () => {
  const c = (await brief('complete')).m.scenarios;
  assert.deepEqual([c.bar, c.plot], [true, true]);
  assert.deepEqual(c.rows.map((x) => [x.id, x.probability]), [['bear', 25], ['base', 50], ['bull', 25]]);
  const w = (await brief('withheld')).m.scenarios;
  assert.deepEqual([w.bar, w.plot], [false, false]);
  assert.ok(w.rows.every((x) => x.probability === null && x.range === null));
  assert.match(w.probability_note, /default data/);
  const r = (await brief('ranges')).m.scenarios;
  assert.deepEqual([r.bar, r.plot], [false, true], 'one probability is not a set');
  assert.equal(r.rows.find((x) => x.id === 'base').probability, 60);
});

test('binding: every brief names its project, report, run and the original\'s SHA-256; a revision is labeled from the stored record', async () => {
  const f = fx();
  const { m, detail } = await brief('complete');
  const r = detail.reports.find((x) => x.report_id === m.report_id);
  assert.deepEqual([m.provenance.format, m.provenance.project_id, m.provenance.report_id, m.provenance.run_id], ['cr-brief@1', f.pids.complete, f.reports.latest, f.runs.complete]);
  assert.equal(m.provenance.sha256, r.meta.original_sha256);
  assert.match(m.provenance.sha256, /^[0-9a-f]{64}$/);
  assert.equal(m.provenance.run_found, true);
  const rev = m.notices.find((n) => n.kind === 'revision');
  assert.equal(rev.basis, 'existing_evidence');
  assert.equal(rev.of, f.reports.first);
  assert.deepEqual(rev.changed, ['Token value capture 54 → 58']);
  assert.match(rev.declared.note, /re-read the fee switch proposal/);
  // Each earlier report keeps its own brief; the list is newest first.
  assert.deepEqual(m.history.map((x) => x.report_id), [f.reports.latest, f.reports.first, f.reports.earlier]);
  assert.ok(m.history[0].current && m.history[0].latest);
  // A report outside any run says so.
  assert.equal((await brief('complete', { reportId: f.reports.earlier })).m.provenance.run_id, null);
});

test('evidence: claims counted by tag, the desk\'s checks kept with their severity, the limits the report itself states', async () => {
  const { m } = await brief('complete');
  assert.deepEqual(m.evidence.counts, { V: 4, C: 1, I: 1, S: 1, other: 0 });
  assert.equal(m.evidence.level, 'serious');
  assert.ok(m.evidence.flags.some((x) => x.rule === 'ai_summary_as_verified' && x.severity === 'high'));
  assert.ok(m.notices.some((n) => n.kind === 'evidence' && n.level === 'serious'));
  assert.ok(m.evidence.limits.some((x) => x.label === 'Volume confirmation and executable liquidity' && /order-book depth/.test(x.text)));
  assert.ok(m.evidence.limits.some((x) => x.label === 'Code that was read'));
  assert.equal(m.evidence.sources.length, 7);
  assert.equal(m.evidence.questions.length, 2);
});

test('no Claude report: the research action only where the inspector offers it; research in progress said in words; opening it starts nothing', async () => {
  const none = (await brief('none')).m;
  assert.equal(none.status, 'none');
  assert.deepEqual([none.empty.job, none.empty.can_run], [null, true]);
  const waiting = (await brief('waiting')).m;
  assert.equal(waiting.empty.job.key, 'waiting');
  assert.equal(waiting.empty.can_run, false);
  assert.match(waiting.empty.job.long, /Waiting for you/);
  // Building the brief wrote nothing: no run, no job, no new file.
  const before = fs.readdirSync(path.join(fx().root, 'projects', fx().pids.none));
  await brief('none');
  assert.deepEqual(fs.readdirSync(path.join(fx().root, 'projects', fx().pids.none)), before);
});

test('identity and market: the long name whole; the market line from the index row with its own time; none without a price', async () => {
  const { m } = await brief('long');
  assert.equal(m.identity.name, LONG_NAME);
  assert.equal(m.identity.verified, true);
  assert.deepEqual(m.identity.chains.map((c) => c.label), ['Ethereum']);
  const c = (await brief('complete')).m;
  assert.equal(c.market.price, '$1.07');
  assert.equal(c.market.mcap, '$214.00M');
  assert.equal(c.market.source, 'Fictional demo data');
  assert.ok(c.market.as_of);
  assert.equal((await brief('quarantined')).m.market, null, 'no price: no market line');
  // Report text is data: kept as written, never interpreted.
  assert.ok(m.verdict.summary.includes(HOSTILE));
});

test('newer research in progress never replaces the saved brief', async () => {
  const f = fx();
  require('../core/research').createRun(f.ws, { project_id: f.pids.complete, providers: ['claude'], channel: 'dashboard', force_new: true });
  const { m } = await brief('complete');
  assert.equal(m.report_id, f.reports.latest, 'the last saved report stays');
  const n = m.notices.find((x) => x.kind === 'newer');
  assert.ok(n, 'a newer run is named');
  assert.match(n.text, /Newer run waiting for Claude/);
});

// ---- read from the source -----------------------------------------------------------

test('the brief only reads: no write, refresh, screen, provider or research call; no HTML from report text; no outside embed', () => {
  // Code only: the comments may name what the brief never does.
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const view = code(read('views/brief.js'));
  const model = code(read('brief-model.js'));
  for (const [name, src] of [['views/brief.js', view], ['brief-model.js', model]]) {
    for (const re of [/\.innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function/, /\bfetch\(/, /api\.post\(/, /ctx\.refresh\(/, /\/api\/market/, /dexscreener\.com/i, /tradingview(-widget)?\.com/i, /from '\.\/(dex|chart)\.js'/, /lookupTargets|dexCard|technicalChart/, /\/research\/run|start_research/]) {
      assert.ok(!re.test(src), `${name} must not match ${re}`);
    }
  }
  // Its one read is the project record the inspector already loaded, which
  // the project page passes in.
  assert.match(view, /export function briefPanel\(ctx, \{ d, row, pid, provider = 'claude', reportId = null \}\)/);
  assert.match(read('views/project.js'), /d = await ctx\.projectDetail\(id\)/);
  assert.ok(!/ctx\.api\./.test(view), 'no other API call');
  // The model never imports the views or the network-facing modules.
  assert.ok(!/from '\.\/views\//.test(model));
});

test('the brief\'s styles use the desk\'s tokens only; the page is wired into the desk', () => {
  const css = read('brief.css');
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(noComments), 'no raw hex colour');
  assert.ok(!/\b(rgb|rgba|hsl|hsla)\(/i.test(noComments), 'no raw colour function');
  assert.ok(!/font-family:(?!\s*var\()/.test(noComments), 'type from the tokens');
  assert.ok(!/text-transform:\s*uppercase/.test(noComments), 'sentence case');
  // The app bundles the hosted views' stylesheets (scoped, dashboard/web).
  const web = (f) => fs.readFileSync(path.join(__dirname, '..', 'web', 'src', ...f.split('/')), 'utf8');
  assert.match(web('legacy/views.js'), /import '\.\.\/\.\.\/\.\.\/public\/brief\.css';/);
  // The Brief is the project page's default tab (D1); its old address redirects.
  assert.match(web('lib/router.js'), /if \(route\.name === 'brief' \|\| route\.name === 'project'\)/);
  assert.match(read('project-routes.js'), /if \(name === 'brief'\) return to\('brief', \{ model: 'claude'/);
  assert.match(read('views/project.js'), /briefPanel\(ctx, \{ d, row, pid, provider: prov/);
  // The React Overview reads the same model; the inspector's link opens it
  // with one history entry to return through (crBrief).
  assert.match(web('views/project/ProjectPage.jsx'), /briefModel\(\{ detail: d, row, index: d0\.index, provider: prov, reportId, hosted: hosted\(\) \}\)/);
  assert.match(web('views/inspector/Inspector.jsx'), /navigate\(`#\/project\/\$\{encodeURIComponent\(pid\)\}\/brief\?model=claude`, \{ state: \{ crBrief: pid, from: 'watchlist' \} \}\)/);
  // The link opens the brief's address with one history entry to return through.
  const ui = read('ui.js');
  assert.match(ui, /const href = `#\/project\/\$\{encodeURIComponent\(pid\)\}\/brief\?model=claude`;/);
  assert.match(ui, /ctx\.navigate\(href, \{ state: \{ crBrief: pid, from \} \}\)/);
  // Back leaves through that entry, else to the project in the watchlist.
  // (through every project tab entry since it was opened: crDepth).
  assert.match(read('views/brief.js'), /st\.crBrief === pid\) history\.go\(-\(Number\(st\.crDepth\) \|\| 1\)\);\s*else ctx\.navigate\(`#\/watchlist\?p=\$\{enc\(pid\)\}`, \{ replace: true \}\)/);
  assert.match(read('views/project.js'), /crDepth: \(Number\(now\.crDepth\) \|\| 1\) \+ 1/);
  // The React project page keeps the same way back.
  const page = web('views/project/ProjectPage.jsx');
  assert.match(page, /if \(st && st\.crBrief === pid\) history\.go\(-\(Number\(st\.crDepth\) \|\| 1\)\);\s*else navigate\(`#\/watchlist\?p=\$\{enc\(pid\)\}`, \{ replace: true \}\);/);
  assert.match(page, /crDepth: \(Number\(now\.crDepth\) \|\| 1\) \+ 1/);
});
