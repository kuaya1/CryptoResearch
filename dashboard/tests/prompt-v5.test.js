'use strict';
// cr-research-prompt@5: the position thesis prompt (one decision question, six
// research sections, a summary first), the @2 scoring profiles with thirteen
// category grades, and the cr.report.v2 format. These tests show that
//   - new runs get @5 with the current version of the project's profile, as
//     one prompt for every model, while the project record, earlier prompts,
//     published templates, stored reports and their grades stay as they were;
//   - the thirteen category grades are saved with their confidence and detail,
//     unknown stays unknown, and none of them enters the investment grade,
//     which still comes from the six weighted components alone;
//   - probabilities and price ranges may be unknown, with their reasons, and a
//     total of 100 is asked only of a complete distribution;
//   - the chart, code and judgment blocks are read as written and never
//     completed;
//   - the dashboard shows each report's categories under the profile version
//     that report declares.
// Everything here is FICTIONAL and runs in throwaway test workspaces; no paid
// model is called.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { tempWorkspace, addFixtureProject, importAllFixtures, hashTree, FIXTURES } = require('./helpers');
const inbox = require('../core/inbox');
const research = require('../core/research');
const prompts = require('../core/prompts');
const projects = require('../core/projects');
const { loadReports } = require('../core/reports');
const { gradeAssessment, currentProfileRef } = require('../core/rubrics');
const { compareProject } = require('../core/compare');
const { evidenceChecks } = require('../core/evidence');
const { buildIndex, projectDetail } = require('../core/indexer');
const { DEFAULT_ROOT } = require('../core/workspace');
const { readJson } = require('../core/fsx');

const PAYFI = 'example-payfi-fictional';
const NET = 'example-network-fictional';
const FIXTURE = fs.readFileSync(path.join(FIXTURES, 'reports', `${NET}__claude.v5.md`), 'utf8');
const FENCE_AT = FIXTURE.indexOf('```json');
const PROSE = FIXTURE.slice(0, FENCE_AT);
const BASE = JSON.parse(FIXTURE.slice(FENCE_AT + 7, FIXTURE.lastIndexOf('\n```')));
const clone = () => JSON.parse(JSON.stringify(BASE));
const report = (json) => `${PROSE}\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;
// The six components of the fixture under cr-grading@1 (20/25/20/15/10/10):
// 45*0.20 + 40*0.25 + 50*0.20 + 60*0.15 + 40*0.10 + 50*0.10 = 47.0
const BASE_GRADE = 47;
const CATEGORIES = [
  ['legitimacy', 'Project legitimacy'],
  ['development_credibility', 'Development credibility'],
  ['build_operational_quality', 'Build and operational quality'],
  ['code_quality', 'Code quality'],
  ['product_reality', 'Live product reality'],
  ['technology_usefulness', 'Technology usefulness and defensibility'],
  ['organic_demand', 'Organic demand and adoption'],
  ['token_value_capture', 'Token value capture'],
  ['valuation_supply_attractiveness', 'Valuation and supply attractiveness'],
  ['chart_structure', 'Chart structure'],
  ['cycle_timing', 'Cycle position and catalyst timing'],
  ['volume_liquidity', 'Volume confirmation and executable liquidity'],
  ['btc_relative_opportunity', 'BTC-relative asymmetric opportunity'],
];
const IDS = CATEGORIES.map(([id]) => id);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function workspace(t, label, settings = {}) {
  const { ws, root, cleanup } = tempWorkspace(label, settings);
  t.after(cleanup);
  return { ws, root };
}

function addNetworkProject(ws, extra = {}) {
  const out = projects.addProject(ws, {
    name: 'Example Network (FICTIONAL)',
    symbol: 'XNET',
    official_website: 'https://example.net/xnet',
    assets: [{ chain: 'example-chain', contract_address: 'FICTIONAL-CONTRACT-XNET' }],
    evidence: [{ url: 'https://example.net/xnet/docs', note: 'fictional test evidence' }],
    sector: 'ai_data',
    ...extra,
  });
  assert.equal(out.project_id, NET);
  return out;
}

function importOne(ws, json, { pid = NET, provider = 'claude' } = {}) {
  const out = inbox.importContent(ws, provider, { content: report(json), projectId: pid });
  assert.equal(out.result.status, 'ingested', out.result.message);
  const rep = loadReports(ws, pid).find((r) => r.report_id === out.result.report_id);
  return { rep, a: rep.assessment, issues: rep.record.extraction.issues, grade: gradeAssessment(ws, rep.assessment) };
}

const fields = (issues, re) => issues.filter((i) => re.test(i.field || '')).map((i) => `${i.severity}:${i.field}`);

test('new runs get prompt @5 with the current version of the project\'s profile: one prompt for every model, the project record untouched', (t) => {
  const { ws, root } = workspace(t, 'v5-run');
  addFixtureProject(ws);
  const projectFile = path.join(root, 'projects', PAYFI, 'project.json');
  const before = fs.readFileSync(projectFile);
  assert.equal(readJson(projectFile).sector_profile, 'payfi-credit@1');
  assert.equal(currentProfileRef(ws, 'payfi-credit@1'), 'payfi-credit@2');
  assert.equal(currentProfileRef(ws, 'payfi-credit@2'), 'payfi-credit@2');
  assert.equal(currentProfileRef(ws, 'unknown-profile@7'), 'unknown-profile@7', 'an unknown reference is never rewritten');

  const r = research.createRun(ws, { project_id: PAYFI, providers: ['claude', 'chatgpt', 'gemini'] });
  assert.equal(r.run.prompt.version, 'cr-research-prompt@5');
  assert.equal(r.run.sector_profile, 'payfi-credit@2');
  assert.equal(r.run.rubric_version, 'cr-grading@1', 'the grading rubric and its weights are unchanged');
  assert.ok(fs.readFileSync(projectFile).equals(before), 'creating a run does not rewrite the project record');
  assert.equal(r.run.prompt.identical_for_all_providers, true);
  assert.deepEqual(Object.keys(r.run.jobs).sort(), ['chatgpt', 'claude', 'gemini']);
  const p = fs.readFileSync(path.join(root, r.run.prompt.path), 'utf8');
  assert.equal(sha256(p), r.run.prompt.sha256, 'the one prompt file is the one that was hashed');
  assert.equal(readJson(path.join(root, r.run.evidence_packet.path)).project.scoring_profile, 'payfi-credit@2');

  // The decision, the standard of work and the holding period.
  assert.match(p, /^<!-- CR-PROMPT cr-research-prompt@5 /);
  assert.match(p, /Sector profile: payfi-credit@2 · Grading system: cr-grading@1/);
  assert.match(p, /> Is this a legitimate, well-built project whose token offers an attractive opportunity during my holding period, and what evidence would confirm or invalidate that opportunity\?/);
  assert.match(p, /Work at your highest reasoning capability\./);
  assert.match(p, /Be skeptical and curious, and be willing to reach an original conclusion\./);
  assert.match(p, /Missing evidence is not automatically evidence of failure/);
  assert.match(p, /A typical hold is about 2 months, and 4 months is the planning ceiling\./);
  assert.ok(p.includes(`**Assessment horizon for this report: ${r.run.horizon.start_date} to ${r.run.horizon.end_date}**`));
  assert.ok(p.includes(`A typical hold would end around ${require('../core/position').addCalendarMonths(r.run.horizon.start_date, 2)}`));
  assert.match(p, /Longer-term technology potential is a separate question\./);
  assert.match(p, /Do not look for, use or mention other AI models' conclusions or scores about this project\./);
  // The six research sections, the summary first, and the scenarios.
  for (const h of ['**1. Identity and legitimacy.**', '**2. Development credibility, build quality and code quality.**', '**3. Product reality and technology usefulness.**', '**4. Demand, token economics and valuation.**', '**5. Chart, volume and market cycle.**', '**6. Independent judgment and asymmetry.**']) assert.ok(p.includes(h), h);
  assert.ok(p.indexOf('### Summary (first; a reader should be able to stop here)') < p.indexOf('### Detailed research'));
  for (const s of ['**Verdict for the holding period**', '**Investment grade.**', '**Category scorecard.**', '**Three strongest positives and three strongest risks.**', '**Current chart and cycle interpretation.**', '**Dated catalysts, confirmation conditions and invalidators.**', '**Independent final judgment.**', '**Next review date and earlier review triggers.**']) assert.ok(p.includes(s), s);
  assert.match(p, /read representative implementation files at an identified commit/);
  assert.match(p, /If source access is insufficient, mark code quality unknown and explain why\./);
  assert.match(p, /Record the data source, venue, trading pair, timeframe and the time of the latest observation/);
  assert.match(p, /launch, decline, base formation, possible accumulation, breakout, expansion, distribution or renewed decline/);
  assert.match(p, /Do not invent levels, patterns, flows or numerical probabilities\./);
  assert.match(p, /Use derivatives data \(open interest, funding\) only as market context; the positions considered here are spot only\./);
  assert.match(p, /- \*\*Observations\*\*:/);
  assert.match(p, /- \*\*Assumptions\*\*:/);
  assert.match(p, /- \*\*Forecast\*\*:/);
  assert.match(p, /Numerical probabilities and price targets are subjective estimates, not verified facts/);
  assert.match(p, /If you give one for every case, the three must total 100%\. Leave any you cannot defend unknown and say why/);
  // The existing evidence labels and source types, unchanged.
  for (const tag of ['**[V]** Verified in your session from a primary source', '**[C]** Project-claimed', '**[I]** Your inference', '**[S]** Speculative forecast']) assert.ok(p.includes(tag), tag);
  assert.match(p, /An official statement verifies that the project made the statement\. It does not independently prove the underlying claim/);
  assert.match(p, /Followers and engagement do not establish legitimacy, adoption or demand\./);
  for (const type of ['official', 'onchain_data', 'data_aggregator', 'exchange', 'audit', 'news', 'research', 'social', 'ai_summary', 'other']) assert.ok(p.includes(`- \`${type}\`:`), type);
  // The thirteen category grades, kept apart from the investment grade.
  for (const [id, label] of CATEGORIES) assert.ok(p.includes(`- \`${id}\` (${label}): `), id);
  assert.match(p, /Grade each of the thirteen categories below, from 1 to 100\. They are diagnostics: my dashboard shows them beside the investment grade and never averages them into it\./);
  assert.match(p, /Unknown means unknown: use `"status": "unknown"` with no number/);
  // An answer has to fit a paid model's output limit, reasoning included: the
  // report is asked to be tight, the detail of each grade is given once (in
  // the JSON), the JSON is laid out compactly, and the JSON block comes first
  // when room runs short.
  assert.match(p, /If you are running short of room, shorten the prose, never the JSON block\./);
  assert.match(p, /Give these once, in the JSON block, where my dashboard shows them/);
  assert.match(p, /Write the JSON compactly, laid out as the skeleton is: one line per score, source, claim or fact, not one line per field\. Keep each text field to one or two sentences/);
  assert.match(p, /My dashboard applies the weights and calculates the investment grade; do not weight them yourself\./);
  assert.match(p, /\*\*C\. Downside-risk panel\. Higher means MORE risk\.\*\*/);
  for (const row of ['| 90–100 | Exceptional', '| 75–89 | Strong', '| 60–74 | Mixed', '| 40–59 | Weak', '| 20–39 | Poor', '| 1–19 | Severe concerns']) assert.ok(p.includes(row), row);
  assert.deepEqual([...p.matchAll(/^- `([a-z_]+)` \(/gm)].map((m) => m[1]).slice(13), ['sustainable_business_demand', 'token_value_capture', 'valuation_supply', 'risk_resilience', 'btc_relative_asymmetry', 'timing_executable_liquidity'], 'the same six weighted components');
  // The JSON contract: cr.report.v2 with the new fields.
  assert.match(p, /"schema_version": "cr\.report\.v2"/);
  assert.match(p, /"legitimacy": \{"status":"unknown","value":null,"low":null,"high":null,"confidence":null,"rationale":"","strongest_evidence":null,"main_weakness":null,"would_raise":null,"would_lower":null,/);
  for (const key of ['"code_review"', '"chart_cycle"', '"independent_judgment"', '"position_context"', '"probability_note"', '"target_note"', '"observations"']) assert.ok(p.includes(key), key);
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(p), 'every placeholder filled');
  // A prompt for any project: nothing from the Allora prompt it was modeled on.
  assert.doesNotMatch(p, /Allora|ALLO\b|Cobot|Kalshi|Pay-What-You-Want|PWYW|Bittensor/);
  // PayFi focus comes from the profile, in the same six sections.
  assert.match(p, /### Sector focus \(payfi-credit@2\)/);
  assert.match(p, /Give default and loss history, concentration, collateral and who bears first loss, per pool and with periods\./);
});

test('the three @2 profiles carry the same thirteen categories, each with its own sector focus; they are pinned and the @1 files are unchanged', (t) => {
  const { ws } = workspace(t, 'v5-profiles');
  const lock = readJson(path.join(DEFAULT_ROOT, 'templates', 'rubrics', 'RUBRIC-LOCK.json'));
  for (const id of ['general-token', 'network-infrastructure', 'payfi-credit']) {
    const p2 = ws.rubrics.profiles[`${id}@2`];
    assert.ok(p2, `${id}@2`);
    assert.deepEqual(p2.diagnostic_categories.map((c) => [c.id, c.label]), CATEGORIES);
    assert.ok(p2.diagnostic_categories.every((c) => c.applicable === true && c.definition && c.resolving_question));
    assert.equal(p2.written_for, 'cr-research-prompt@5');
    assert.equal(p2.supersedes, `${id}@1`);
    assert.equal(p2.research_sections.length, 6);
    assert.equal(ws.rubrics.versionStatus[`${id}@2`].status, 'pinned');
    assert.equal(lock.pinned[`${id}@2`].sha256, sha256(fs.readFileSync(path.join(DEFAULT_ROOT, 'templates', 'rubrics', `${id}.v2.json`))));
    assert.equal(ws.rubrics.versionStatus[`${id}@1`].status, 'pinned', 'the first version still matches its pin');
    assert.deepEqual(p2.economics_fields, ws.rubrics.profiles[`${id}@1`].economics_fields, 'the same economics fields');
    assert.equal(p2.risk_applicability.credit, ws.rubrics.profiles[`${id}@1`].risk_applicability.credit, 'credit risk applies where it did');
  }
  // Each profile adapts the same sections to its kind of project.
  addNetworkProject(ws);
  const net = prompts.buildProjectPrompt(ws, projects.getProject(ws, NET), 'claude');
  assert.match(net, /### Sector focus \(network-infrastructure@2\)/);
  assert.match(net, /validator or operator concentration/);
  assert.match(net, /whether fees or emissions fund them/);
  assert.doesNotMatch(net, /who bears first loss/, 'no credit questions for a network');
  assert.match(net, /`credit` is `not_applicable` outside credit and PayFi profiles/);
  // The grading rubric is the same file as before: six components, 20/25/20/15/10/10.
  assert.equal(ws.rubrics.activeRef, 'cr-grading@1');
  assert.deepEqual(ws.rubrics.grading.investment_components.map((c) => c.weight_bp), [2000, 2500, 2000, 1500, 1000, 1000]);
});

test('published versions are never edited: the prompt templates and appendices @1 to @5, both report schemas and the grading rubric keep their fingerprints', () => {
  // A change to any of these files is a new version, not an edit. (@5 and the
  // v2 schema were published on 2026-10-03; the @2 profiles are pinned in
  // RUBRIC-LOCK.json like every rubric file.)
  const published = {
    'templates/research-prompt.v5.md': '70b3b298c3404a5232c787e793e7952ea7a489184f4801e27e2d5533aac8826e',
    'templates/grading-appendix.v5.md': '3271356f528ba33414503ae74dd5769022d1b61cab4a6e714725247ad61b7272',
    'templates/schemas/report.v2.schema.json': 'bb2cc581901099f74518e5b5e2defe105dc7c192771ed3749b7395bcd56c200f',
    'templates/research-prompt.v1.md': '514172ca45f40e05ee5e9a36e5717817a9201314cb5f829808961fd1f8679943',
    'templates/research-prompt.v2.md': '205efd2a880c7dc47dfc03e137b5662a364ccb9f38fc993d0365774be202492a',
    'templates/research-prompt.v3.md': 'def0d898d201a74e05780d4bfb3738cfc5be608058485c51e94a4e4396f3c473',
    'templates/research-prompt.v4.md': '16406817419ace20fd5927cdec7ab5516785742f4a3a06960fb2ad7a2be26ca3',
    'templates/grading-appendix.v1.md': '53566ce0970ea533eda858327e19d1eb1dad72f15b6a131beba5d438e730013e',
    'templates/grading-appendix.v2.md': 'fdfdb7bfdff54b9534d9f2a53da09fb0985106260db129502526fb1d09165dd8',
    'templates/grading-appendix.v3.md': '2850d02980a1871f292c78bbe4ac40ba54875d450a63e56f0bbc983e00758c0b',
    'templates/grading-appendix.v4.md': 'e97ab422977c731025be2de3ec91f86fc8fe1a47d8c1d4421d4b0662cf9b284e',
    'templates/schemas/report.v1.schema.json': '071bc46edf851b5cab970ad37ce1b494a22713856ba0ec7c1ab1aa90ac3a722e',
    'templates/rubrics/cr-grading.v1.json': '7972df13a045b8babd139d519d67887b96949974c85b594f53d2f89d6c20ea93',
  };
  for (const [rel, hash] of Object.entries(published)) assert.equal(sha256(fs.readFileSync(path.join(DEFAULT_ROOT, ...rel.split('/')))), hash, rel);
});

test('a profile with no version written for @5 keeps prompt @4, and @5 is refused for it', (t) => {
  const { ws, root } = workspace(t, 'v5-custom');
  const custom = { ...readJson(path.join(root, 'templates', 'rubrics', 'general-token.v1.json')), profile_ref: 'custom-sector@1', profile_id: 'custom-sector', title: 'FICTIONAL custom profile' };
  fs.writeFileSync(path.join(root, 'templates', 'rubrics', 'custom-sector.v1.json'), `${JSON.stringify(custom, null, 2)}\n`);
  // A newer file of the same profile that is not pinned is a draft, not a
  // published version: new research does not move to it.
  const draft = { ...readJson(path.join(root, 'templates', 'rubrics', 'general-token.v2.json')), profile_ref: 'custom-sector@2', profile_id: 'custom-sector', supersedes: 'custom-sector@1' };
  fs.writeFileSync(path.join(root, 'templates', 'rubrics', 'custom-sector.v2.json'), `${JSON.stringify(draft, null, 2)}\n`);
  ws._rubrics = null;
  assert.equal(ws.rubrics.versionStatus['custom-sector@2'].status, 'unpinned');
  assert.equal(currentProfileRef(ws, 'custom-sector@1'), 'custom-sector@1');
  addNetworkProject(ws, { sector_profile: 'custom-sector@1' });
  const r = research.createRun(ws, { project_id: NET, providers: ['claude'] });
  assert.equal(r.run.prompt.version, 'cr-research-prompt@4');
  assert.equal(r.run.sector_profile, 'custom-sector@1');
  assert.match(fs.readFileSync(path.join(root, r.run.prompt.path), 'utf8'), /^<!-- CR-PROMPT cr-research-prompt@4 /);
  assert.throws(() => prompts.buildRunPrompt(ws, projects.getProject(ws, NET), { runId: r.run.run_id, horizon: r.run.horizon, rubricRef: 'cr-grading@1', packet: null, version: prompts.PROMPT_VERSION_V5 }), /needs a scoring profile written for it/);
});

test('earlier work is preserved: a run\'s frozen prompt, stored reports and their grades do not change when later research uses @5', async (t) => {
  const { ws, root } = workspace(t, 'v5-preserve', { research: { providers: { claude: { mock: 'ok' }, chatgpt: { mock: 'ok' }, gemini: { mock: 'ok' } } } });
  addFixtureProject(ws);
  // Three reports written under the first profile version (cr.report.v1).
  importAllFixtures(ws);
  const gradesOf = () => Object.fromEntries(loadReports(ws, PAYFI).filter((r) => r.assessment.sector_profile === 'payfi-credit@1').map((r) => {
    const g = gradeAssessment(ws, r.assessment);
    return [r.meta.provider, g.status === 'withheld' ? `withheld ${g.coverage_pct}%` : g.display];
  }));
  assert.deepEqual(gradesOf(), { claude: '60.5', chatgpt: '67.0', gemini: 'withheld 90%' });
  const old = loadReports(ws, PAYFI).find((r) => r.meta.provider === 'claude');
  assert.deepEqual(Object.keys(old.assessment.diagnostic_scores), ['legitimacy', 'builder_operations', 'product_usefulness', 'organic_demand', 'credit_risk_transparency', 'differentiation', 'category_potential', 'token_value_capture', 'valuation_supply_attractiveness', 'chart_quality', 'evidence_confidence'], 'read under the eleven categories it declares');
  assert.deepEqual([old.assessment.code_review, old.assessment.chart_cycle, old.assessment.independent_judgment], [null, null, null], 'an earlier report has none of the new blocks, and nothing is inferred for it');
  assert.ok(!old.record.extraction.issues.some((i) => /asked for the/.test(i.message)), 'and it is not faulted for what it was never asked');
  const reportsBefore = hashTree(path.join(root, 'projects', PAYFI, 'reports'));

  // A run, then later research under @5 with all three models (fictional adapters).
  const first = research.createRun(ws, { project_id: PAYFI, providers: ['claude'], horizon: '3 months' });
  const firstPrompt = fs.readFileSync(path.join(root, first.run.prompt.path));
  const second = research.createRun(ws, { project_id: PAYFI, providers: ['claude', 'chatgpt', 'gemini'], force_new: true });
  await research.runDueJobs(ws, { trigger: 'test' });
  buildIndex(ws);
  assert.ok(fs.readFileSync(path.join(root, first.run.prompt.path)).equals(firstPrompt), 'the first run\'s prompt file is untouched');
  assert.equal(sha256(firstPrompt), research.loadRun(ws, PAYFI, first.run_id).prompt.sha256);
  const after = hashTree(path.join(root, 'projects', PAYFI, 'reports'));
  for (const [file, hash] of Object.entries(reportsBefore)) assert.equal(after[file], hash, `${file} is byte for byte what it was`);
  assert.deepEqual(gradesOf(), { claude: '60.5', chatgpt: '67.0', gemini: 'withheld 90%' }, 'the earlier grades are what they were');
  const fresh = loadReports(ws, PAYFI).filter((r) => r.assessment.research_run_id === second.run_id);
  assert.equal(fresh.length, 3);
  for (const r of fresh) {
    assert.equal(r.assessment.prompt_version, 'cr-research-prompt@5');
    assert.equal(r.assessment.sector_profile, 'payfi-credit@2');
    assert.deepEqual(Object.keys(r.assessment.diagnostic_scores), IDS);
  }
  // Research never creates a holding.
  assert.equal(buildIndex(ws).portfolio.positions.length, 0);
});

test('a @5 report: thirteen category grades are saved with confidence and detail, unknown has no number, and the grade comes from the six components alone', (t) => {
  const { ws } = workspace(t, 'v5-report');
  addNetworkProject(ws);
  assert.equal(projects.getProject(ws, NET).sector_profile, 'network-infrastructure@2', 'a new project is given the current profile version');
  const { rep, a, issues, grade } = importOne(ws, clone());
  assert.equal(rep.record.extraction.schema_valid, true);
  assert.equal(rep.record.extraction.note, 'Structured JSON block (cr.report.v2).');
  assert.deepEqual(issues, [], 'nothing to note on a complete report');
  assert.equal(a.prompt_version, 'cr-research-prompt@5');
  assert.equal(a.sector_profile, 'network-infrastructure@2');
  assert.deepEqual(Object.keys(a.diagnostic_scores), IDS);
  assert.deepEqual(a.diagnostic_extra, {});
  assert.deepEqual(a.diagnostic_scores.legitimacy, {
    status: 'scored', value: 71, low: null, high: null, rationale: 'Fictional: project legitimacy.', evidence_refs: ['C1'], missing_data: null,
    confidence: 'medium',
    strongest_evidence: 'Fictional strongest evidence for project legitimacy.',
    main_weakness: 'Fictional main weakness of project legitimacy.',
    would_raise: 'Fictional development that would raise project legitimacy.',
    would_lower: 'Fictional development that would lower project legitimacy.',
  });
  // Unknown means unknown: no number, no confidence, and what is missing.
  const cq = a.diagnostic_scores.code_quality;
  assert.equal(cq.status, 'unknown');
  assert.equal(cq.value, null);
  assert.ok(!('confidence' in cq));
  assert.match(cq.missing_data, /node repository is private/);
  // A justified range stays a range.
  assert.deepEqual([a.diagnostic_scores.valuation_supply_attractiveness.status, a.diagnostic_scores.valuation_supply_attractiveness.low, a.diagnostic_scores.valuation_supply_attractiveness.high, a.diagnostic_scores.valuation_supply_attractiveness.confidence], ['range', 35, 50, 'low']);
  // The investment grade: the six weighted components, nothing else.
  assert.equal(grade.status, 'firm');
  assert.equal(grade.value, BASE_GRADE);
  assert.equal(grade.display, '47.0');
  assert.deepEqual(grade.parts.map((x) => [x.id, x.weight_pct, x.value]), [['sustainable_business_demand', 20, 45], ['token_value_capture', 25, 40], ['valuation_supply', 20, 50], ['risk_resilience', 15, 60], ['btc_relative_asymmetry', 10, 40], ['timing_executable_liquidity', 10, 50]]);
  const allHigh = clone();
  for (const id of IDS) allHigh.diagnostic_scores[id] = { ...allHigh.diagnostic_scores.legitimacy, value: 99, confidence: 'high' };
  allHigh.summary = 'FICTIONAL: every category grade raised to 99.';
  assert.equal(importOne(ws, allHigh).grade.value, BASE_GRADE, 'category grades never enter the investment grade');
  const noCategories = clone();
  noCategories.diagnostic_scores = {};
  noCategories.summary = 'FICTIONAL: no category grade given.';
  const none = importOne(ws, noCategories);
  assert.equal(none.grade.value, BASE_GRADE, 'nor does their absence change it');
  assert.ok(IDS.every((id) => none.a.diagnostic_scores[id].status === 'unknown' && none.a.diagnostic_scores[id].value === null), 'a category left out is unknown, never zero');
  // A component the evidence does not support is unknown: the grade is withheld, with the weight that was scored.
  const unproven = clone();
  unproven.investment_components.btc_relative_asymmetry = { status: 'unknown', value: null, low: null, high: null, rationale: '', evidence_refs: [], missing_data: 'FICTIONAL: no probabilities or price ranges, so asymmetry is unproven.' };
  const w = importOne(ws, unproven);
  assert.equal(w.grade.status, 'withheld');
  assert.equal(w.grade.coverage_pct, 90);
  assert.equal(w.grade.value, null);
  // The risk panel is kept apart, higher meaning more risk.
  assert.equal(a.risk_scores.credit.status, 'not_applicable');
  assert.equal(a.risk_scores.dilution.value, 70);
  // The blocks of the report, as written.
  assert.equal(a.chart_cycle.phase, 'base_formation');
  assert.deepEqual(a.chart_cycle.data, { source: 'Fictional market data page', venue: 'Example Exchange (FICTIONAL)', pair: 'XNET/USD', timeframes: ['1W', '1D'], latest_observation_at: '2026-10-03T14:00:00Z', limitations: null });
  assert.deepEqual(a.chart_cycle.levels.map((l) => [l.kind, l.price_usd]), [['support', 0.42], ['resistance', 0.61]]);
  assert.equal(a.code_review.source_access, 'partial');
  assert.deepEqual(a.code_review.repositories.map((r) => r.commit), ['3f9c2ab', null]);
  assert.equal(a.code_review.deployed_link.status, 'not_verified');
  assert.deepEqual(Object.entries(a.independent_judgment).filter(([, v]) => v && v.label).map(([k, v]) => [k, v.label]), [['market_misunderstanding', 'judgment'], ['overlooked_bull_case', 'speculation'], ['overlooked_bear_case', 'judgment'], ['technology_without_token', 'judgment'], ['within_holding_period', 'judgment'], ['advantage_over_btc', 'judgment']]);
  assert.match(a.position_context.long_term_note, /not a reason to hold the token for these four months/);
  assert.equal(a.position_context.timing.next_review_date, '2026-11-21');
  assert.equal(rep.integrity.status, 'valid');
  // The desk's evidence checks hold for @5 reports and flag nothing here.
  const ev = evidenceChecks(a, { officialWebsite: 'https://example.net/xnet' });
  assert.deepEqual(ev.flags, []);
  assert.equal(ev.critical_claims, 5);
  const noExcerpt = clone();
  noExcerpt.claims[0].excerpt = null;
  assert.deepEqual(evidenceChecks(importOne(ws, { ...noExcerpt, summary: 'FICTIONAL: excerpt removed.' }).a).flags.map((f) => [f.rule, f.claim_id]), [['critical_without_excerpt', 'C1']], 'a @5 report was asked for an excerpt or query, like @4');
  // Watching and researching a project is not a holding.
  assert.equal(buildIndex(ws).portfolio.positions.length, 0);
});

test('category keys written as labels are read as the categories; a confidence word outside the list is not used', (t) => {
  const { ws } = workspace(t, 'v5-keys');
  addNetworkProject(ws);
  const j = clone();
  const byLabel = {};
  for (const [id, label] of CATEGORIES) byLabel[id === 'code_quality' ? 'Code Quality' : id === 'cycle_timing' ? 'cycle-position-and-catalyst-timing' : label] = j.diagnostic_scores[id];
  byLabel['Project legitimacy'].confidence = 'High';
  byLabel['Development credibility'].confidence = 'certain';
  j.diagnostic_scores = byLabel;
  const { a, issues, grade } = importOne(ws, j);
  assert.deepEqual(Object.keys(a.diagnostic_scores), IDS);
  assert.equal(a.diagnostic_scores.legitimacy.value, 71);
  assert.equal(a.diagnostic_scores.legitimacy.confidence, 'high', 'letter case is not a difference');
  assert.ok(!('confidence' in a.diagnostic_scores.development_credibility));
  assert.ok(issues.some((i) => i.field === 'diagnostic_scores.development_credibility' && /confidence "certain" is not high, medium or low; not used/.test(i.message)));
  assert.ok(issues.some((i) => /key 'Project legitimacy' read as legitimacy/.test(i.message)));
  assert.equal(a.diagnostic_scores.cycle_timing.value, 52);
  assert.ok(!issues.some((i) => i.severity === 'error'));
  assert.equal(grade.value, BASE_GRADE);
});

test('scenarios: unknown probabilities and price ranges are accepted with their reasons; a total of 100 is asked only of a complete distribution', (t) => {
  const { ws } = workspace(t, 'v5-scenarios');
  addNetworkProject(ws);
  const scn = (issues) => fields(issues, /^scenarios/);
  // None of either, with the reasons: nothing to note.
  const none = importOne(ws, clone());
  assert.equal(none.a.scenarios.probability_check.status, 'not_given');
  assert.equal(none.a.scenarios.target_check.status, 'not_given');
  assert.match(none.a.scenarios.target_check.message, /^No price ranges: Fictional: without a reconciled supply figure/);
  assert.deepEqual(scn(none.issues), []);
  assert.deepEqual(none.a.scenarios.items.map((s) => s.case), ['bear', 'base', 'bull']);
  assert.deepEqual(none.a.scenarios.items[0].observations, ['Fictional observation the bear case builds on: fees were $95k over 30 days.']);
  // Some probabilities, with the reason: shown as given, not completed, no total asked.
  const partial = clone();
  partial.scenarios.items[1].probability_pct = 55;
  partial.scenarios.probability_note = 'FICTIONAL: only the base case can be defended.';
  const b = importOne(ws, partial);
  assert.equal(b.a.scenarios.probability_check.status, 'incomplete');
  assert.deepEqual(b.a.scenarios.items.map((s) => s.probability_pct), [null, 55, null]);
  assert.deepEqual(scn(b.issues), []);
  // Some probabilities and no reason: one note.
  const silent = clone();
  silent.scenarios.items[1].probability_pct = 55;
  silent.scenarios.probability_note = null;
  assert.deepEqual(scn(importOne(ws, silent).issues), ['warning:scenarios']);
  // A complete distribution must total 100; one that does not is shown as given.
  const complete = clone();
  complete.scenarios.items.forEach((s, i) => { s.probability_pct = [30, 50, 20][i]; });
  complete.scenarios.probability_note = null;
  const c = importOne(ws, complete);
  assert.equal(c.a.scenarios.probability_check.status, 'ok');
  assert.deepEqual(scn(c.issues), []);
  const wrong = clone();
  wrong.scenarios.items.forEach((s, i) => { s.probability_pct = [30, 50, 10][i]; });
  wrong.scenarios.probability_note = null;
  const d = importOne(ws, wrong);
  assert.equal(d.a.scenarios.probability_check.status, 'invalid');
  assert.equal(d.a.scenarios.probability_check.total, 90);
  assert.deepEqual(d.a.scenarios.items.map((s) => s.probability_pct), [30, 50, 10], 'not corrected');
  assert.deepEqual(scn(d.issues), ['warning:scenarios']);
  // Price ranges: given for some cases, or none without the reason.
  const targets = clone();
  targets.scenarios.items[2].price_range_usd = { low: 0.7, high: 1.1 };
  const e = importOne(ws, targets);
  assert.equal(e.a.scenarios.target_check.status, 'partial');
  assert.deepEqual(scn(e.issues), []);
  const noReason = clone();
  noReason.scenarios.target_note = null;
  assert.deepEqual(scn(importOne(ws, noReason).issues), ['warning:scenarios.target_note']);
  const older = clone();
  older.scenarios.target_note = null;
  older.prompt_version = 'cr-research-prompt@4';
  assert.deepEqual(scn(importOne(ws, older).issues), [], 'a report that was not asked for the reason gets no note');
  // None of this touches the grade or turns into an error.
  for (const x of [none, b, c, d, e]) {
    assert.equal(x.grade.value, BASE_GRADE);
    assert.ok(!x.issues.some((i) => i.severity === 'error'));
  }
});

test('chart, code and judgment blocks are read as written: a reading without its basis is noted, an unknown word is not guessed, and a missing block is unknown', (t) => {
  const { ws } = workspace(t, 'v5-blocks');
  addNetworkProject(ws);
  const j = clone();
  j.chart_cycle.data.source = null;
  j.chart_cycle.volume.baseline = null;
  j.chart_cycle.phase = 'Re-accumulation';
  j.chart_cycle.levels.push({ kind: 'support', price_usd: 'about 0.4', timeframe: '1D', basis: null });
  j.chart_cycle.evidence_refs = ['C4', 'C99'];
  j.code_review.repositories[1].files_inspected = ['node/consensus.go'];
  j.code_review.deployed_link = { status: 'verified', note: null };
  j.independent_judgment.overlooked_bull_case.label = 'fact';
  j.independent_judgment.advantage_over_btc = 'FICTIONAL: none that the evidence shows.';
  const { a, issues, grade, rep } = importOne(ws, j);
  const noted = (field) => issues.filter((i) => i.field === field).map((i) => i.message);
  assert.equal(a.chart_cycle.phase, 'unknown');
  assert.equal(a.chart_cycle.phase_raw, 'Re-accumulation', 'the word the report used is kept');
  assert.match(noted('chart_cycle.phase')[0], /is not one of unknown, launch, decline, base_formation, possible_accumulation, breakout, expansion, distribution, renewed_decline/);
  assert.deepEqual(noted('chart_cycle.data.source'), ['Price levels are given without a named data source.']);
  assert.deepEqual(noted('chart_cycle.volume.baseline'), ['A volume reading is given without the baseline it was compared against.']);
  assert.equal(a.chart_cycle.levels.length, 2, 'a level with neither a price nor a basis is not kept');
  assert.match(noted('chart_cycle.levels[2].price_usd')[0], /is not a positive number; not used/);
  assert.deepEqual(noted('code_review.repositories[1].commit'), ['Files are listed as inspected without the commit they were read at.']);
  assert.deepEqual(noted('code_review.deployed_link.note'), ['The code is said to match what is deployed, without saying how that was checked.']);
  assert.equal(a.independent_judgment.overlooked_bull_case.label, null);
  assert.equal(a.independent_judgment.overlooked_bull_case.label_raw, 'fact');
  assert.equal(a.independent_judgment.advantage_over_btc.view, 'FICTIONAL: none that the evidence shows.');
  assert.deepEqual(noted('independent_judgment'), ['2 view(s) are not labeled judgment or speculation; shown without a label.']);
  assert.ok(rep.integrity.issues.some((i) => i.kind === 'dangling_evidence_ref' && i.path === 'chart_cycle.evidence_refs[1]' && i.id === 'C99'));
  assert.equal(grade.value, BASE_GRADE, 'none of it moves a score');
  assert.ok(!issues.some((i) => i.severity === 'error'));
  // A @5 report without the blocks: each is unknown, and said so.
  const bare = clone();
  for (const k of ['code_review', 'chart_cycle', 'independent_judgment']) delete bare[k];
  const m = importOne(ws, bare);
  assert.deepEqual([m.a.code_review, m.a.chart_cycle, m.a.independent_judgment], [null, null, null]);
  assert.deepEqual(m.issues.filter((i) => /asked for the/.test(i.message)).map((i) => i.field), ['code_review', 'chart_cycle', 'independent_judgment']);
  // An earlier-version report was never asked for them: nothing is noted, nothing is inferred.
  const v4 = clone();
  for (const k of ['code_review', 'chart_cycle', 'independent_judgment']) delete v4[k];
  v4.prompt_version = 'cr-research-prompt@4';
  const o = importOne(ws, v4);
  assert.ok(!o.issues.some((i) => /asked for the/.test(i.message)));
  assert.deepEqual([o.a.code_review, o.a.chart_cycle, o.a.independent_judgment], [null, null, null]);
});

test('a prose-only answer to a @5 run: labeled category grades are read from the scorecard under the run\'s profile; nothing else is inferred', (t) => {
  const { ws } = workspace(t, 'v5-prose');
  addNetworkProject(ws);
  const run = research.createRun(ws, { project_id: NET, providers: ['claude'] });
  const out = inbox.importContent(ws, 'claude', { content: PROSE, projectId: NET, runId: run.run_id });
  assert.equal(out.result.status, 'ingested', out.result.message);
  const rep = loadReports(ws, NET).find((r) => r.report_id === out.result.report_id);
  const a = rep.assessment;
  assert.equal(a.source_format, 'prose');
  assert.deepEqual(a.fields_from_run, ['sector_profile', 'rubric_version', 'prompt_version', 'horizon']);
  assert.equal(a.sector_profile, 'network-infrastructure@2');
  const read = Object.fromEntries(Object.entries(a.diagnostic_scores).map(([k, s]) => [k, s.status === 'scored' ? s.value : s.status === 'range' ? `${s.low}-${s.high}` : s.status]));
  assert.deepEqual(read, { legitimacy: 71, development_credibility: 64, build_operational_quality: 58, code_quality: 'unknown', product_reality: 62, technology_usefulness: 55, organic_demand: 41, token_value_capture: 38, valuation_supply_attractiveness: '35-50', chart_structure: 47, cycle_timing: 52, volume_liquidity: 44, btc_relative_opportunity: 40 });
  assert.equal(a.verdict, 'REAL PRODUCT, WEAK TOKEN');
  // Token value capture appears in both panels; in prose without a clear section it is not guessed.
  assert.equal(a.investment_components.token_value_capture.status, 'unknown');
  assert.equal(gradeAssessment(ws, a).status, 'withheld');
});

test('comparison and summaries: reports of one run compare under the profile version they declare; the project page knows what a new run will use', async (t) => {
  const { ws } = workspace(t, 'v5-compare', { research: { providers: { claude: { mock: 'ok' }, chatgpt: { mock: 'ok' }, gemini: { mock: 'ok' } } } });
  addFixtureProject(ws);
  importAllFixtures(ws);
  const created = research.createRun(ws, { project_id: PAYFI, providers: ['claude', 'chatgpt', 'gemini'] });
  await research.runDueJobs(ws, { trigger: 'test' });
  const reports = loadReports(ws, PAYFI);
  const cmp = compareProject(ws, reports);
  assert.equal(cmp.comparability.comparable, true);
  assert.deepEqual(cmp.comparability.comparable_providers, ['claude', 'chatgpt', 'gemini']);
  assert.equal(cmp.comparability.context.sector_profile, 'payfi-credit@2');
  assert.deepEqual(cmp.rows.filter((r) => r.section === 'diagnostic').map((r) => r.label), CATEGORIES.map(([, label]) => label));
  assert.equal(cmp.rows.filter((r) => r.section === 'component').length, 6);
  // The same model's earlier report was written under another profile version: shown, not compared numerically.
  const d = projectDetail(ws, PAYFI);
  assert.ok(d.diffs.claude.length >= 1);
  assert.equal(d.diffs.claude[d.diffs.claude.length - 1].comparable, false);
  assert.match(d.diffs.claude[d.diffs.claude.length - 1].note, /different rubric, profile or horizon/);
  // What a new run on this project would use; the record still names the first version.
  assert.deepEqual(d.research_contract, { sector_profile: 'payfi-credit@2', project_profile: 'payfi-credit@1', prompt_version: 'cr-research-prompt@5', rubric_version: 'cr-grading@1', category_grades: 13 });
  // The summary of each new report counts its category grades; it never totals them.
  const latest = d.history.claude[d.history.claude.length - 1];
  assert.equal(latest.report_id, research.loadRun(ws, PAYFI, created.run_id).jobs.claude.report_id);
  assert.equal(latest.scorecard.total, 13);
  assert.equal(latest.scorecard.scored, 12);
  assert.deepEqual(latest.scorecard.unknown_labels, ['Code quality']);
  assert.equal(latest.scorecard.confidence.high + latest.scorecard.confidence.medium + latest.scorecard.confidence.low, 12);
  assert.ok(['base_formation', 'possible_accumulation', 'decline'].includes(latest.chart_phase));
  const first = d.history.claude[0];
  assert.equal(first.scorecard.total, 11, 'an earlier report keeps its own eleven');
  assert.equal(first.scorecard.confidence.not_given, 11);
  assert.equal(first.chart_phase, null);
});

// The browser modules are ES modules in a CommonJS package: load a copy that
// is marked as ESM (as ui-logic.test.js does). The functions tested here touch
// no DOM.
let tmp;
async function loadUi() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ui-v5-'));
  fs.cpSync(path.join(__dirname, '..', 'public'), tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{ "type": "module" }');
  return import(pathToFileURL(path.join(tmp, 'thesis-ui.js')).href);
}
const ui = loadUi();
test.after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test('dashboard: a report\'s categories come from the profile it declares; counts and confidence are words, never a total; scenarios split observed, assumed and forecast', async (t) => {
  const m = await ui;
  const { ws } = workspace(t, 'v5-ui');
  const profiles = Object.values(ws.rubrics.profiles);
  const current = ws.rubrics.profiles['payfi-credit@2'];
  // A @5 report under the network profile.
  assert.equal(m.profileOf(profiles, BASE, current).profile_ref, 'network-infrastructure@2', 'the report\'s own profile, not the project\'s');
  const rows = m.categoryRows(m.profileOf(profiles, BASE, current), BASE);
  assert.deepEqual(rows.map((r) => [r.id, r.label]), CATEGORIES);
  const counts = m.scorecardCounts(rows);
  assert.deepEqual(counts, { total: 13, scored: 12, unknown: 1, high: 1, medium: 7, low: 4, unstated: 0, unknownLabels: ['Code quality'] });
  assert.equal(m.confidenceLine(counts), 'Evidence confidence, as the model states it: 1 high · 7 medium · 4 low.');
  assert.equal(m.statesConfidence(rows), true);
  assert.equal(m.hasDetail(rows[0].score), true);
  assert.equal(m.hasDetail(rows[3].score), false, 'an unknown grade has no detail to show');
  // An earlier report under the first PayFi profile: its eleven categories, no confidence column.
  const old = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'reports', `${PAYFI}__claude.md`), 'utf8').split('```json')[1].split('\n```')[0]);
  const oldRows = m.categoryRows(m.profileOf(profiles, old, current), old);
  assert.equal(oldRows.length, 11);
  assert.equal(oldRows[0].label, 'Legitimacy');
  assert.equal(m.statesConfidence(oldRows), false);
  assert.equal(m.confidenceLine(m.scorecardCounts(oldRows)), null);
  // A report that declares no profile falls back to the project's; one that declares an unknown profile shows its own keys.
  assert.equal(m.profileOf(profiles, { sector_profile: null }, current).profile_ref, 'payfi-credit@2');
  assert.equal(m.profileOf(profiles, { sector_profile: 'someone-else@9' }, current), null);
  assert.deepEqual(m.categoryRows(null, { diagnostic_scores: { made_up: { status: 'scored', value: 50 } } }).map((r) => [r.id, r.label]), [['made_up', 'made_up']]);
  // Scenarios: bear, base, bull; unknown probabilities and ranges stay unknown.
  const scn = m.scenarioRows(BASE.scenarios);
  assert.deepEqual(scn.map((s) => [s.label, s.probability, s.price, s.vsBtc]), [['Bear', null, null, null], ['Base', null, null, null], ['Bull', null, null, null]]);
  assert.deepEqual(scn[0].observations, ['Fictional observation the bear case builds on: fees were $95k over 30 days.']);
  assert.deepEqual(scn[0].assumptions.map(([k]) => k), ['Token value capture', 'Supply', 'Bitcoin and the market']);
  assert.equal(scn[0].outcome, 'Fictional: fees fall after incentives end.');
  const oldScn = m.scenarioRows(old.scenarios);
  assert.deepEqual(oldScn.map((s) => [s.label, s.probability, s.price]), [['Bear', 25, '$0.05 to $0.15'], ['Base', 50, '$0.25 to $0.45'], ['Bull', 25, '$0.60 to $1.00']]);
  assert.equal(m.rangeText({ low: null, high: 2 }, (n) => String(n)), 'up to 2');
  assert.equal(m.rangeText({ low: null, high: null }, (n) => String(n)), null);
});

// Review v3, finding 4: a numeric code-quality grade with no code read, and a
// chart grade on an undated chart, passed every check. The category checks
// flag them beside the grade they concern; nothing is rewritten or rescored.
const withCode = (j, code) => { j.code_review = { ...j.code_review, ...code }; return j; };
const scoredAt = (j, id, value, confidence = 'medium') => { j.diagnostic_scores[id] = { ...j.diagnostic_scores.chart_structure, status: 'scored', value, confidence, rationale: `FICTIONAL: ${id} scored ${value}.`, missing_data: null }; return j; };
const flagsOf = (a) => evidenceChecks(a, { officialWebsite: 'https://example.net/xnet' }).flags.map((f) => [f.rule, f.severity, (f.categories || []).join('+')]);

test('category checks: the review\'s contradictory report (no code access, no repository, code quality 99 high, undated chart) is flagged beside code quality and the chart grades; the original and every score are kept', (t) => {
  const { ws } = workspace(t, 'v5-category-flags');
  addNetworkProject(ws);
  const good = importOne(ws, clone());
  const j = withCode(scoredAt(clone(), 'code_quality', 99, 'high'), { source_access: 'none', repositories: [] });
  delete j.chart_cycle.data.latest_observation_at;
  j.summary = 'FICTIONAL: the contradictory case from the review.';
  const bad = importOne(ws, j);
  // The parser reads it as written: no error, the score kept as given.
  assert.equal(bad.issues.filter((i) => i.severity === 'error').length, 0);
  assert.equal(bad.a.diagnostic_scores.code_quality.value, 99);
  assert.equal(bad.a.diagnostic_scores.code_quality.confidence, 'high');
  // The checks flag both contradictions, each beside the grades it concerns.
  const ev = evidenceChecks(bad.a, { officialWebsite: 'https://example.net/xnet' });
  assert.deepEqual(ev.flags.map((f) => [f.rule, f.severity, f.categories.join('+'), f.claim_id]), [
    ['code_score_without_source', 'high', 'code_quality', null],
    ['chart_without_observation_date', 'medium', 'chart_structure+cycle_timing+volume_liquidity', null],
  ]);
  assert.match(ev.flags[0].message, /^Code quality is scored 99, but the report says the source could not be read \(source access: none\)\. The prompt asks for code quality to be unknown when the source cannot be read\.$/);
  assert.match(ev.flags[1].message, /^Chart structure, Cycle position and catalyst timing and Volume confirmation and executable liquidity are scored, but its chart reading gives no date for the latest observation\. A current chart assessment needs the date of the latest candle or quote it used\.$/);
  assert.deepEqual([ev.flagged_claims, ev.flagged_categories, ev.checked_categories, ev.high, ev.medium], [0, 4, 4, 1, 1]);
  assert.match(ev.summary, /^4 category grades lack the evidence the prompt asks for beside them \(1 high, 1 medium\)\. These checks change no score\.$/);
  // Flags only: the grade comes from the six components, exactly as before,
  // and the stored report is the text as received.
  assert.equal(bad.grade.value, BASE_GRADE);
  assert.equal(bad.grade.value, good.grade.value);
  assert.equal(fs.readFileSync(ws.abs(`projects/${NET}/reports/${bad.rep.report_id}/${bad.rep.meta.original_file}`), 'utf8'), report(j));
  // The project page and the watchlist carry them.
  const d = projectDetail(ws, NET);
  assert.equal(d.reports.find((r) => r.report_id === bad.rep.report_id).evidence.flags.length, 2);
  const brief = d.history.claude.find((r) => r.report_id === bad.rep.report_id).evidence;
  assert.deepEqual([brief.flagged, brief.flagged_categories, brief.high, brief.medium], [0, 4, 1, 1]);
  assert.equal(d.history.claude.find((r) => r.report_id === bad.rep.report_id).grade.value, BASE_GRADE);
});

test('category checks: reports that carry the evidence stay unflagged (code read at a commit, a dated chart, older price history), as do grades left unknown and reports not asked for the blocks', (t) => {
  const { ws } = workspace(t, 'v5-category-clean');
  addNetworkProject(ws);
  let n = 0;
  const imp = (j) => importOne(ws, { ...j, summary: `FICTIONAL variant ${n += 1}.` }).a;
  // The fixture: code quality unknown (private node), chart dated the same day.
  assert.deepEqual(flagsOf(imp(clone())), []);
  // Code read at a commit with its files, as Linea's report records it.
  assert.deepEqual(flagsOf(imp(withCode(scoredAt(clone(), 'code_quality', 70), { source_access: 'public', repositories: [{ url: 'https://code.example.net/xnet/node', role: 'FICTIONAL node', commit: 'c27732d199f8ad603d1983d8af72031c730b0382', files_inspected: ['src/vault.sol', 'src/burner.sol'], observations: 'FICTIONAL' }] }))), []);
  // Partial access with one repository read is enough evidence for a grade.
  assert.deepEqual(flagsOf(imp(scoredAt(clone(), 'code_quality', 55))), [], 'the fixture\'s SDK was read at a commit');
  // Unknown code quality with no access is what the prompt asks for.
  assert.deepEqual(flagsOf(imp(withCode(clone(), { source_access: 'none', repositories: [] }))), []);
  // A chart whose latest candle is a few days old, built on months of history
  // before the holding period: legitimate context, no flag.
  const recent = clone();
  recent.chart_cycle.data.latest_observation_at = '2026-09-28';
  recent.chart_cycle.data.limitations = 'FICTIONAL: weekly candles from 2025-06 to 2026-09-28.';
  assert.deepEqual(flagsOf(imp(recent)), []);
  const sameDay = clone();
  sameDay.chart_cycle.data.latest_observation_at = '2026-10-03 14:00 UTC';
  assert.deepEqual(flagsOf(imp(sameDay)), [], 'a date-time written another way still names the day');
  // Chart grades left unknown: nothing to date.
  const unknownCharts = clone();
  for (const id of ['chart_structure', 'cycle_timing', 'volume_liquidity']) unknownCharts.diagnostic_scores[id] = { ...unknownCharts.diagnostic_scores.code_quality };
  delete unknownCharts.chart_cycle.data.latest_observation_at;
  assert.deepEqual(flagsOf(imp(unknownCharts)), []);
  // A report written for prompt @4 was not asked for these blocks.
  const v4 = withCode(scoredAt(clone(), 'code_quality', 99, 'high'), { source_access: 'none', repositories: [] });
  v4.prompt_version = 'cr-research-prompt@4';
  delete v4.chart_cycle.data.latest_observation_at;
  assert.deepEqual(flagsOf(imp(v4)), [], 'the checks apply only where the prompt asked for the evidence');
});

test('category checks: a code grade without a commit and files, and a chart dated weeks before the report, after it, or in words, are each flagged beside the grade', async (t) => {
  const { ws } = workspace(t, 'v5-category-variants');
  addNetworkProject(ws);
  let n = 0;
  const imp = (j) => importOne(ws, { ...j, summary: `FICTIONAL variant ${n += 1}.` }).a;
  const noCommit = withCode(scoredAt(clone(), 'code_quality', 80), { source_access: 'public', repositories: [{ url: 'https://code.example.net/xnet/node', role: 'FICTIONAL', commit: null, files_inspected: ['src/a.ts'], observations: null }] });
  const fl = evidenceChecks(imp(noCommit)).flags;
  assert.deepEqual(fl.map((f) => [f.rule, f.severity, f.category]), [['code_score_without_inspection', 'medium', 'code_quality']]);
  assert.match(fl[0].message, /^Code quality is scored 80, but files are listed without the commit they were read at\. The prompt asks for the repository, the commit and the files read; without them code quality is unknown\.$/);
  const noBlock = scoredAt(clone(), 'code_quality', 80);
  delete noBlock.code_review;
  assert.match(evidenceChecks(imp(noBlock)).flags[0].message, /but the report has no account of the code it read\./);
  const range = withCode(clone(), { source_access: 'none', repositories: [] });
  range.diagnostic_scores.code_quality = { ...range.diagnostic_scores.chart_structure, status: 'range', value: null, low: 60, high: 80, rationale: 'FICTIONAL range.', missing_data: null };
  assert.match(evidenceChecks(imp(range)).flags[0].message, /^Code quality is scored 60-80, but the report says the source could not be read/);
  const stale = clone();
  stale.chart_cycle.data.latest_observation_at = '2026-09-10T00:00:00Z';
  const staleA = imp(stale);
  assert.deepEqual(flagsOf(staleA), [['chart_observation_stale', 'medium', 'chart_structure+cycle_timing+volume_liquidity']]);
  assert.match(evidenceChecks(staleA).flags[0].message, /latest observation \(2026-09-10\) is 23 days older than the report \(2026-10-03\)\. Older price history is context; a current assessment needs current data\.$/);
  const after = clone();
  after.chart_cycle.data.latest_observation_at = '2026-10-30';
  assert.deepEqual(flagsOf(imp(after)), [['chart_observation_after_report', 'medium', 'chart_structure+cycle_timing+volume_liquidity']]);
  const words = clone();
  words.chart_cycle.data.latest_observation_at = 'last week';
  assert.match(evidenceChecks(imp(words)).flags[0].message, /dates the latest observation "last week", which names no day/);
  const oneScored = clone();
  oneScored.chart_cycle.data.latest_observation_at = null;
  for (const id of ['cycle_timing', 'volume_liquidity']) oneScored.diagnostic_scores[id] = { ...oneScored.diagnostic_scores.code_quality };
  assert.deepEqual(flagsOf(imp(oneScored)), [['chart_without_observation_date', 'medium', 'chart_structure']], 'only the grades that are scored are named');
  // Shown beside the category: the scorecard picks a category's own flags,
  // and the watchlist's evidence words count category grades.
  const m = await ui;
  const both = evidenceChecks(imp(withCode(scoredAt(clone(), 'code_quality', 99, 'high'), { source_access: 'none', repositories: [] }))).flags;
  assert.deepEqual(m.categoryFlags(both, 'code_quality').map((f) => f.rule), ['code_score_without_source']);
  assert.deepEqual(m.categoryFlags(both, 'chart_structure'), []);
  assert.deepEqual(m.categoryFlags(fl, 'code_quality').map((f) => f.rule), ['code_score_without_inspection']);
  const uiMod = await import(pathToFileURL(path.join(tmp, 'ui.js')).href);
  assert.equal(uiMod.evidenceLevel({ flagged: 0, flagged_categories: 1, high: 1, medium: 0 }), 'serious');
  assert.equal(uiMod.evidenceText({ flagged: 0, flagged_categories: 1, high: 1, medium: 0 }), '1 category grade flagged by evidence checks (1 serious)');
  assert.equal(uiMod.evidenceText({ flagged: 2, flagged_categories: 3, high: 0, medium: 2 }), '2 claims and 3 category grades flagged by evidence checks (2 material)');
});
