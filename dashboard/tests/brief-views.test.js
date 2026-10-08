'use strict';
// The project brief's three views (2026-10-07): Overview, Compare and
// Evidence, on FICTIONAL workspaces built through the real import path
// (brief-fixtures.js). Compare reads the desk's own saved reports with the
// Second opinion's rules (compare-desk.js over compare-model.js): the desk's
// latest eligible Claude and ChatGPT reports by default, a missing side said
// in words, comparable differences first, a range never a midpoint, numbers
// only under the same scoring versions, each grade its own (nothing averaged,
// no consensus or winner), and the basis of a difference from each report's
// own stored words, saying so when the records cannot explain it. Read from
// the source: opening the views reads only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { buildBriefWorkspace } = require('./brief-fixtures');
const indexer = require('../core/indexer');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (rel) => fs.readFileSync(path.join(PUBLIC, rel), 'utf8');

const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('network access is not allowed in tests'); };
test.after(() => { globalThis.fetch = realFetch; });

let tmp;
async function load() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-views-'));
  fs.cpSync(PUBLIC, tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{ "type": "module" }');
  return import(pathToFileURL(path.join(tmp, 'compare-desk.js')).href);
}
const mod = load();
test.after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

let fixture = null;
const fx = () => (fixture = fixture || buildBriefWorkspace('views-test'));
test.after(() => { if (fixture) fixture.cleanup(); });

async function view(key, pick = {}) {
  const cd = await mod;
  const w = fx().ws;
  const id = fx().pids[key];
  const index = indexer.buildIndex(w);
  const d = indexer.projectDetail(w, id);
  const row = index.projects.find((p) => p.project_id === id) || null;
  const { records, set_aside } = cd.deskRecords(d, { profiles: index.rubrics.profiles, grading: index.rubrics.grading });
  const a = 'a' in pick ? pick.a : cd.latestRecord(d, records, 'claude');
  const b = 'b' in pick ? pick.b : cd.latestRecord(d, records, 'chatgpt');
  const v = cd.compareView(d, { a, b, records, set_aside, row, index });
  return { cd, d, row, index, records, set_aside, v };
}

test('the default pair is the desk\'s own latest eligible Claude and ChatGPT reports; a quarantined answer is set aside, never compared', async () => {
  const f = fx();
  const c = await view('complete');
  assert.equal(c.v.first.report_id, f.reports.latest, 'Claude\'s latest save (a revision), as the desk names it');
  assert.equal(c.v.first.report_id, c.d.comparison.latest.claude.report_id);
  assert.equal(c.v.second.report_id, f.reports.chatgpt);
  assert.deepEqual(c.v.names, ['Claude', 'ChatGPT']);
  // The desk's grade as stored, never re-computed or the model's own total.
  const saved = c.d.reports.find((r) => r.report_id === f.reports.latest);
  assert.equal(c.v.first.grade_display, saved.grade.display);
  assert.equal(c.v.first.grade_status, 'firm');
  // Another project: its newer quarantined answer is listed apart.
  const r = await view('ranges');
  assert.ok(r.set_aside.some((x) => x.report_id === f.reports.quarantinedLater && x.why.kind === 'quarantined'));
  assert.ok(!r.records.some((x) => x.report_id === f.reports.quarantinedLater));
  assert.equal(r.v.first.report_id, f.reports.range);
});

test('comparable differences come first, largest first; a range stays a range; unknown is evidence missing; the same number is not agreement on the facts', async () => {
  const { v } = await view('complete');
  assert.equal(v.cmp.scope.status, 'matches', 'same run, prompt, profile, rubric and horizon');
  assert.equal(v.cmp.authorship.label, 'Independent authorship');
  assert.equal(v.cmp.versions.compatible, true);
  const groups = v.rows.map((r) => r.result.group);
  const firstOther = groups.findIndex((g) => g !== 'notable');
  assert.ok(firstOther > 0 && groups.slice(firstOther).every((g) => g !== 'notable'), 'every notable difference before the rest');
  const notable = v.rows.filter((r) => r.result.group === 'notable');
  for (let i = 1; i < notable.length; i += 1) assert.ok(notable[i - 1].result.gap >= notable[i].result.gap, 'largest first');
  const row = (id) => v.rows.find((r) => r.category_id === id);
  assert.equal(row('organic_demand').result.gap, 14);
  assert.equal(row('token_value_capture').result.gap, 14);
  const val = row('valuation_supply_attractiveness');
  assert.deepEqual([val.a.status, val.a.score_low, val.a.score_high, val.a.score], ['range', 48, 60, null], 'a range, never a midpoint');
  assert.equal(val.result.kind, 'outside');
  assert.equal(val.result.gap, 10);
  assert.equal(row('volume_liquidity').result.group, 'missing');
  assert.equal(row('code_quality').result.group, 'missing');
  assert.equal(row('legitimacy').result.kind, 'same');
  assert.match(row('legitimacy').result.detail, /do not mean the facts behind them agree/);
});

test('each grade stays its own: nothing is averaged, combined or ranked into a winner', async () => {
  const { v } = await view('complete');
  const keys = new Set();
  const walk = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 4) return;
    for (const [k, x] of Object.entries(o)) {
      if (k === 'report') continue;
      keys.add(k);
      walk(x, depth + 1);
    }
  };
  walk({ ...v, first: null, second: null });
  for (const k of keys) assert.doesNotMatch(k, /average|mean|median|midpoint|consensus|winner|combined|blend/i, `no ${k}`);
  // The six components are compared one by one under the same rubric; the
  // grades themselves are never subtracted or summed across the two.
  const tvc = v.components.find((x) => x.id === 'token_value_capture');
  assert.deepEqual([tvc.a.score, tvc.b.score, tvc.result.gap, tvc.result.group], [58, 40, 18, 'notable']);
  assert.equal(v.components.length, 6);
  assert.ok(v.risks.some((x) => x.id === 'credit' && x.result.kind === 'both_na'), 'not applicable stays not applicable');
});

test('the basis of a difference: each report\'s own reason and cited evidence, the sources both cite, the figures that differ; and when the records cannot explain it, it says so', async () => {
  const { cd, d, v } = await view('complete');
  const row = (id) => v.rows.find((r) => r.category_id === id);
  const demand = cd.basisOf(row('organic_demand'), v.first, v.second, v.names, d);
  assert.deepEqual(demand.unexplained, []);
  const [claude, gpt] = demand.sides;
  assert.equal(gpt.reason, 'Fictional: 1.2M paid jobs in 30 days with no incentive campaign running.');
  assert.equal(gpt.cited[0].id, 'C2');
  assert.equal(gpt.cited[0].tag, 'C');
  assert.ok(gpt.cited[0].as_of);
  assert.equal(gpt.cited[0].sources[0].url, 'https://dashboard.relay.example/jobs');
  assert.ok(claude.main_weakness);
  // The paid-jobs figures the desk's comparison found to differ, with its own
  // word for them (not called a contradiction without the same definition).
  assert.equal(demand.figures_checked, true);
  const jobs = demand.conflicts.find((c) => c.metric === 'paid_jobs');
  assert.ok(jobs, 'the figure pair is named under the category whose grade cites it');
  assert.deepEqual([jobs.a.value, jobs.b.value], [1800000, 1200000]);
  assert.notEqual(jobs.kind, 'agreement');
  assert.ok(cd.FIGURE_WORDS[jobs.kind]);
  // A source both cite, compared by address.
  const capture = cd.basisOf(row('token_value_capture'), v.first, v.second, v.names, d);
  assert.ok(capture.shared.some((s) => s.url === 'https://docs.relay.example/fees'));
  // ChatGPT gives no reason and cites nothing for its timing grade.
  const timing = cd.basisOf(row('cycle_timing'), v.first, v.second, v.names, d);
  assert.deepEqual(timing.unexplained, ['ChatGPT']);
  assert.equal(timing.sides[1].reason, null);
  assert.deepEqual(timing.sides[1].cited, []);
  // An earlier Claude report is not the desk's latest: no figure check is claimed.
  const earlier = (await view('complete')).records.find((x) => x.report_id === fx().reports.earlier);
  const other = cd.compareView(d, { a: earlier, b: v.second, records: (await view('complete')).records });
  const b2 = cd.basisOf(other.rows.find((r) => r.category_id === 'organic_demand'), earlier, v.second, other.names, d);
  assert.equal(b2.figures_checked, false);
  assert.deepEqual(b2.conflicts, []);
});

test('different scoring versions: the numbers are shown side by side and not compared; the scope, dates and versions that differ are named', async () => {
  const f = fx();
  const s = await view('sparse');
  assert.equal(s.v.second.report_id, f.reports.sparseChatgpt);
  assert.equal(s.v.cmp.versions.compatible, false);
  assert.equal(s.v.cmp.scope.status, 'differs');
  assert.ok(s.v.rows.every((r) => r.result.gap === null), 'no gap across versions');
  assert.ok(!s.v.rows.some((r) => r.result.group === 'notable' || r.result.group === 'close'));
  const named = s.v.scope_differences.map((x) => x.what);
  for (const w of ['Prompt', 'Scoring profile', 'Research date']) assert.ok(named.includes(w), `${w} is named`);
});

test('a side with no report says why, in words, and nothing is put in its place', async () => {
  const w = await view('withheld');
  assert.equal(w.v.second, null);
  assert.equal(w.cd.latestRecord(w.d, w.records, 'chatgpt'), null);
  assert.equal(w.cd.missingSide(w.d, { row: w.row, index: w.index, model: 'chatgpt' }).text, 'No ChatGPT report for this project; nothing else is put in its place.');
  // The withheld grade stays withheld with its coverage.
  assert.equal(w.v.first.grade_status, 'withheld');
  assert.equal(typeof w.v.first.grade_coverage_pct, 'number');
  const q = await view('quarantined');
  assert.equal(q.v.first, null);
  const miss = q.cd.missingSide(q.d, { row: q.row, index: q.index, model: 'claude' });
  assert.equal(miss.kind, 'quarantined');
  assert.match(miss.text, /quarantined/);
  const wt = await view('waiting');
  assert.equal(wt.cd.missingSide(wt.d, { row: wt.row, index: wt.index, model: 'claude' }).kind, 'job');
  assert.equal((await view('none')).v.empty, true);
});

test('the hashes are compared only where stored; missing ones are said, never assumed to match', async () => {
  const { v } = await view('complete');
  const hash = v.cmp.scope.facts.find((x) => x.what === 'Frozen prompt hash');
  assert.equal(hash.a, 'Not stored with these reports');
  assert.match(v.cmp.scope.text, /not stored with these reports, so they are not compared/);
});

// ---- read from the source -----------------------------------------------------------

test('opening the views only reads: no write, fetch, refresh, research or Explorer call; report text never becomes HTML', () => {
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  for (const f of ['views/brief-compare.js', 'compare-desk.js', 'views/brief.js']) {
    const src = code(read(f));
    for (const re of [/\.innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function/, /\bfetch\(/, /api\.post\(/, /ctx\.api\./, /ctx\.refresh\(/, /\/api\/explorer/, /\/research\/run|start_research/]) {
      assert.ok(!re.test(src), `${f} must not match ${re}`);
    }
  }
  // The comparison's logic is the Second opinion's own module.
  assert.match(read('compare-desk.js'), /from '\.\/compare-model\.js'/);
  assert.ok(!/from '\.\/views\//.test(read('compare-desk.js')));
  // The three views read the project record the page loaded once.
  const project = read('views/project.js');
  assert.match(project, /d = await ctx\.projectDetail\(id\)/);
  assert.match(project, /compare: \(\) => compareTab\(ctx, d, row, route\)/);
  assert.match(project, /evidencePanel\(ctx, \{ d, row, pid, provider: prov/);
  assert.match(read('project-routes.js'), /\['brief', 'Overview'\],\s*\['compare', 'Compare'\],\s*\['evidence', 'Evidence'\]/);
  // The React project page and its Overview read only: no write, fetch or
  // research outside an explicit action, and no report text as HTML.
  const webRoot = path.join(__dirname, '..', 'web', 'src');
  const overview = code(fs.readFileSync(path.join(webRoot, 'views', 'project', 'Overview.jsx'), 'utf8'));
  for (const re of [/dangerouslySetInnerHTML/, /\.innerHTML/, /\bfetch\(/, /api\.post\(/, /\brefresh\(/, /\/api\/explorer/, /\/research\/run|start_research/]) {
    assert.ok(!re.test(overview), `Overview.jsx must not match ${re}`);
  }
  // The Overview's only action is the research dialog the inspector also offers (a click, never on render).
  assert.match(overview, /onClick=\{async \(\) => \{ const L = await loadLegacy\(\);[\s\S]{0,240}L\.openResearchDialog\(/);
});

test('the Overview reads in order: the verdict with its warnings and key points, the category grades, then apart the six components; the evidence has its own view', () => {
  const src = read('views/brief.js');
  const body = /: \[sheetHead\(m, title\), verdictSection\(ctx, m, pid, staleDays\), (.*)\];/.exec(src);
  assert.ok(body, 'the Overview body is one list');
  const order = ['categoriesSection', 'inputsSection', 'thesisSection', 'forAgainstSection', 'watchSection', 'scenariosSection', 'evidenceLinkSection', 'noteSection'];
  const at = order.map((n) => body[1].indexOf(n));
  assert.ok(at.every((x, i) => x >= 0 && (i === 0 || x > at[i - 1])), `in order: ${order.join(', ')}`);
  assert.match(src, /export function evidencePanel\(ctx, \{ d, row, pid, provider = 'claude', reportId = null \}\)/);
  // The grade's own warnings are named beside it.
  assert.match(src, /const GRADE_NOTICES = \['evidence', 'model_total', 'text_scores', 'extraction'\];/);
});

test('phone layout (2026-10-07): the strongest risk is the report\'s own words, whole; a long one reads as its first lines on a phone with an explicit way to the rest', async () => {
  // The risk is the report's own text, never shortened in the model.
  const bm = await import(pathToFileURL(path.join(tmp, 'brief-model.js')).href);
  await mod;
  const w = fx().ws;
  const id = fx().pids.ranges;
  const index = indexer.buildIndex(w);
  const d = indexer.projectDetail(w, id);
  const m = bm.briefModel({ detail: d, row: index.projects.find((p) => p.project_id === id), index, provider: 'claude' });
  const stored = d.reports.find((r) => r.report_id === m.report_id).assessment.bearish_facts[0].text;
  assert.equal(m.key.risk.text, stored);
  assert.ok(stored.length > 160, 'the fixture\'s risk is long');
  // The view keeps the whole text in the page and names the way to it.
  const src = read('views/brief.js');
  assert.match(src, /const RISK_SHORT = 160;/);
  assert.match(src, /h\('p', \{ class: 'bf-key-t bf-clamp', id: 'bf-risk-text' \}, text\)/);
  assert.match(src, /'aria-expanded': 'false', 'aria-controls': 'bf-risk-text'/);
  assert.match(src, /'Show the full risk'/);
  // Only a phone clamps it, and only a phone shows the button.
  const css = read('brief-views.css');
  const phone = css.slice(css.indexOf('@media (max-width: 760px)'));
  const wide = css.slice(0, css.indexOf('@media'));
  assert.match(phone, /\.bf-key-t\.bf-clamp:not\(\.open\) \{[^}]*-webkit-line-clamp: 4/);
  assert.match(wide, /\.bf-key-more-btn \{ display: none; \}/);
  assert.ok(!/bf-clamp/.test(wide), 'a wide screen shows the risk whole');
});

test('phone layout: the project\'s actions are one menu beside the name with the same actions; the head that repeats the model tab steps aside only for the latest report; warnings stay', () => {
  const project = read('views/project.js');
  assert.match(project, /function actionsMenu\(name, items\)/);
  assert.match(project, /role: 'menu'/);
  // The menu and the row of buttons call the same handlers.
  for (const fn of ['runResearch', 'setWatch', 'archiveOrRestore']) assert.ok((project.match(new RegExp(`\\b${fn}\\b`, 'g')) || []).length >= 3, `${fn} shared`);
  const css = read('brief-views.css');
  const phone = css.slice(css.indexOf('@media (max-width: 760px)'));
  assert.match(css.slice(0, css.indexOf('@media')), /\.pb-more \{ display: none; \}/);
  assert.match(phone, /\.pb-head \.actions \{ display: none; \}/);
  assert.match(phone, /\.pb-more \{ display: block;/);
  // Only the latest report's head is set aside; an earlier one keeps it.
  assert.match(phone, /\.brief \.bf-head\.is-latest \{ position: absolute;/);
  assert.match(read('views/brief.js'), /class: `bf-head\$\{m\.report_id && m\.is_latest \? ' is-latest' : ''\}`/);
  // The grade's warnings are never hidden on a phone.
  assert.ok(!/\.bf-gflags[^{]*\{[^}]*display: none/.test(phone));
  assert.ok(!/\.bf-notices[^{]*\{[^}]*display: none/.test(phone));
});

test('the views\' styles use the desk\'s tokens only, in light and dark alike', () => {
  const css = read('brief-views.css');
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(noComments), 'no raw hex colour');
  assert.ok(!/\b(rgb|rgba|hsl|hsla)\(/i.test(noComments), 'no raw colour function');
  assert.ok(!/font-family:(?!\s*var\()/.test(noComments), 'type from the tokens');
  assert.ok(!/text-transform:\s*uppercase/.test(noComments), 'sentence case');
  assert.ok(!/font-size:\s*(?:[0-9]|1[01])(?:\.\d+)?px/.test(noComments), 'nothing under 12px');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'legacy', 'views.js'), 'utf8'), /import '\.\.\/\.\.\/\.\.\/public\/brief-views\.css';/);
  // The React project page's styles: tokens only, nothing under 12px.
  const web = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'styles', 'project.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(web), 'no raw hex colour');
  assert.ok(!/font-family:(?!\s*var\()/.test(web), 'type from the tokens');
  assert.ok(!/text-transform:\s*uppercase/.test(web), 'sentence case');
  assert.ok(!/font-size:\s*(?:[0-9]|1[01])(?:\.\d+)?px/.test(web), 'nothing under 12px');
});
