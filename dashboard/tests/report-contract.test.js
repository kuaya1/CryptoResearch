'use strict';
// The report contract (independent review, 2026-10-03): cr-research-prompt@4
// lists the accepted source types, allows [V] only from a primary source with
// its date and an excerpt or query, asks for primary sources and dates on
// critical claims, and lets scenarios leave probabilities unknown with the
// reason. The parser reads source types outside the list as their nearest type
// (one line, not one warning per source); the desk's evidence checks flag what
// a report's claims rest on. None of this changes a score or a grade. Reports
// and identities here are FICTIONAL; the flagged claims mirror the two the
// review cited (an audit "verified" by an AI summary page, a fee estimate no
// one could reproduce).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempWorkspace, addFixtureProject, FIXTURES } = require('./helpers');
const inbox = require('../core/inbox');
const research = require('../core/research');
const prompts = require('../core/prompts');
const { loadReports } = require('../core/reports');
const { gradeAssessment } = require('../core/rubrics');
const { evidenceChecks, normalizeSourceType } = require('../core/evidence');
const { getProject } = require('../core/projects');

const PID = 'example-payfi-fictional';
const FIXTURE = fs.readFileSync(path.join(FIXTURES, 'reports', `${PID}__claude.md`), 'utf8');
const FENCE_AT = FIXTURE.indexOf('```json');
const PROSE = FIXTURE.slice(0, FENCE_AT);
const BASE = JSON.parse(FIXTURE.slice(FENCE_AT + 7, FIXTURE.indexOf('\n```', FENCE_AT + 7)));
const BASE_GRADE = 60.5;
const clone = () => JSON.parse(JSON.stringify(BASE));
const report = (json) => `${PROSE}\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;

function workspace(t, label) {
  const { ws, root, cleanup } = tempWorkspace(label);
  t.after(cleanup);
  addFixtureProject(ws);
  return { ws, root };
}

function importOne(ws, json) {
  const out = inbox.importContent(ws, 'claude', { content: report(json), projectId: PID });
  assert.equal(out.result.status, 'ingested', out.result.message);
  const rep = loadReports(ws, PID).find((r) => r.report_id === out.result.report_id);
  const issues = rep.record.extraction.issues;
  return { rep, a: rep.assessment, issues, grade: gradeAssessment(ws, rep.assessment) };
}

test('prompt @4: new runs get the source types, the [V] rule, critical-claim evidence and optional probabilities; an older run\'s @3 prompt is still reproduced', (t) => {
  const { ws, root } = workspace(t, 'contract-prompt');
  const r = research.createRun(ws, { project_id: PID, providers: ['claude', 'chatgpt', 'gemini'] });
  assert.equal(r.run.prompt.version, 'cr-research-prompt@4');
  const p = fs.readFileSync(path.join(root, r.run.prompt.path), 'utf8');
  assert.match(p, /CR-PROMPT cr-research-prompt@4/);
  assert.match(p, /\*\*\[V\]\*\* Verified in your session from a primary source/);
  assert.match(p, /An AI-generated summary \(for example CoinMarketCap's AI pages, or any chatbot answer\) never supports \[V\]/);
  assert.match(p, /10\. Critical claims need a primary source and a date, or a lower tag:/);
  assert.match(p, /realized fees or revenue: the measurement period, and the on-chain query or dashboard that reproduces the figure/);
  assert.match(p, /`source_type` is exactly one of:/);
  for (const type of ['official', 'onchain_data', 'data_aggregator', 'exchange', 'audit', 'news', 'research', 'social', 'ai_summary', 'other']) assert.ok(p.includes(`- \`${type}\`:`), type);
  assert.match(p, /`critical_kind`: for an audit, a deployment, realized fees or revenue, a supply change, live liquidity or a dated catalyst/);
  assert.match(p, /or `null` for all three with the reason in `scenarios.probability_note`\. Never force a total\./);
  assert.match(p, /- probability: only when the evidence supports probabilities, a number for each case with the three totaling 100%; otherwise none for any case, and say why\./);
  assert.doesNotMatch(p, /probabilities must total 100|the three must total 100%\)|with probabilities totaling 100%/, 'the old conflicting rule is gone');
  // The JSON skeleton carries the new fields.
  assert.match(p, /"critical_kind": ?null,\s*"excerpt": ?null,\s*"query": ?null/);
  assert.match(p, /"probability_note": ?null/);
  // The sector profile's scenario guidance follows the same rule in @4.
  assert.match(p, /9\. \*\*BTC-relative scenarios\.\*\* Bull, base and bear cases with probabilities only when the evidence supports them \(all three totaling 100%, or none, with the reason\)/);
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(p), 'every placeholder filled');
  // Weights are unchanged: the same six components and appendix rules as @3.
  const v3 = prompts.buildRunPrompt(ws, getProject(ws, PID), { runId: r.run.run_id, horizon: r.run.horizon, rubricRef: r.run.rubric_version, packet: JSON.parse(fs.readFileSync(path.join(root, r.run.evidence_packet.path), 'utf8')), version: prompts.PROMPT_VERSION_V3 });
  assert.match(v3, /CR-PROMPT cr-research-prompt@3/);
  assert.match(v3, /probabilities must total 100/);
  const comps = (text) => [...text.matchAll(/^- `([a-z_]+)` \(/gm)].map((m) => m[1]);
  assert.deepEqual(comps(p), comps(v3), 'the same scored parts are asked for');
});

test('scenarios: no probabilities with a reason is accepted without any issue; partial or wrong totals are warnings, shown as given; the grade is unchanged', (t) => {
  const { ws } = workspace(t, 'contract-scenarios');
  const none = clone();
  none.scenarios.items.forEach((i) => { i.probability_pct = null; });
  none.scenarios.probability_note = 'FICTIONAL: credible fee and supply evidence does not support numerical probabilities.';
  const a = importOne(ws, none);
  assert.equal(a.a.scenarios.probability_check.status, 'not_given');
  assert.equal(a.a.scenarios.probability_note, none.scenarios.probability_note);
  assert.ok(!a.issues.some((i) => /^scenarios/.test(i.field || '')), JSON.stringify(a.issues.filter((i) => /scenario/.test(i.field || ''))));
  assert.equal(a.grade.value, BASE_GRADE);

  const silent = clone();
  silent.scenarios.items.forEach((i) => { i.probability_pct = null; });
  const b = importOne(ws, silent);
  assert.ok(b.issues.some((i) => i.field === 'scenarios.probability_note' && i.severity === 'warning'), 'no reason given: one warning');

  const partial = clone();
  partial.scenarios.items[2].probability_pct = null;
  const c = importOne(ws, partial);
  assert.equal(c.a.scenarios.probability_check.status, 'incomplete');
  assert.deepEqual(c.issues.filter((i) => i.field === 'scenarios').map((i) => i.severity), ['warning']);
  assert.equal(c.a.scenarios.items[2].probability_pct, null, 'not completed');

  const wrong = clone();
  wrong.scenarios.items[0].probability_pct = 15;
  const d = importOne(ws, wrong);
  assert.equal(d.a.scenarios.probability_check.status, 'invalid');
  assert.equal(d.a.scenarios.items[0].probability_pct, 15, 'not corrected');
  assert.ok(!d.issues.some((i) => i.severity === 'error'), 'a wrong total is shown as given, not an error');
  for (const x of [b, c, d]) assert.equal(x.grade.value, BASE_GRADE);
});

test('source types: words outside the list are read as their nearest type (the word is kept), one line instead of a warning per source; an AI summary page is an AI summary whatever it is called', (t) => {
  const { ws } = workspace(t, 'contract-sources');
  const j = clone();
  j.sources = [
    { source_id: 'S1', url: 'https://example.com/xmpl/docs', title: 'Fictional docs', source_type: 'official' },
    { source_id: 'S2', url: 'https://example.org/xmpl-dashboard', title: 'Fictional dashboard', source_type: 'onchain_data' },
    { source_id: 'S3', url: 'https://example.com/xmpl', title: 'Fictional site', source_type: 'project_website' },
    { source_id: 'S4', url: 'https://etherscan.io/token/0x0000000000000000000000000000000000f1c7a1', title: 'Fictional token page', source_type: 'block_explorer' },
    { source_id: 'S5', url: 'https://coinmarketcap.com/cmc-ai/example-payfi-fictional/latest-updates/', title: 'Fictional AI summary', source_type: 'market_data' },
    { source_id: 'S6', url: 'https://news.example.net/xmpl', title: 'Fictional article', source_type: 'news_article' },
    { source_id: 'S7', url: 'https://unknown.example.net/a', title: 'Fictional A', source_type: 'weird_kind' },
    { source_id: 'S8', url: 'https://unknown.example.net/b', title: 'Fictional B', source_type: 'weird_kind' },
  ];
  const r = importOne(ws, j);
  const st = Object.fromEntries(r.a.sources.map((s) => [s.source_id, [s.source_type, s.source_type_raw || null]]));
  assert.deepEqual(st, {
    S1: ['official', null],
    S2: ['onchain_data', null],
    S3: ['official', 'project_website'],
    S4: ['onchain_data', 'block_explorer'],
    S5: ['ai_summary', 'market_data'],
    S6: ['news', 'news_article'],
    S7: ['other', 'weird_kind'],
    S8: ['other', 'weird_kind'],
  });
  const lines = r.issues.filter((i) => /source_type|source type/.test(`${i.field} ${i.message}`));
  assert.equal(lines.length, 2, JSON.stringify(lines));
  assert.equal(lines[0].message, '4 source type(s) were written outside the accepted list and read as the nearest type: "project_website" as official, "block_explorer" as onchain_data, "market_data" as ai_summary, "news_article" as news.');
  assert.match(lines[1].message, /^\$\.sources\[\*\]\.source_type: must be one of .* \(2 items\)$/, 'unrecognized words: one grouped line');
  assert.equal(r.grade.value, BASE_GRADE);
  // Hosts settle a vague type; the project's own domain is official.
  assert.equal(normalizeSourceType('independent_source', 'https://www.binance.com/en/trade/X_USDT').type, 'exchange');
  assert.equal(normalizeSourceType(null, 'https://docs.example-fictional.io/a', { officialDomain: 'example-fictional.io' }).type, 'official');
  assert.equal(normalizeSourceType('data_aggregator', 'https://coinmarketcap.com/cmc-ai/x/price-prediction/').type, 'ai_summary');
  assert.equal(normalizeSourceType('data_aggregator', 'https://coinmarketcap.com/currencies/x/').type, 'data_aggregator');
});

test('evidence checks: an AI summary never verifies; critical claims need a primary source and a date; a fee figure needs its period and a query or dashboard; nothing changes a score', (t) => {
  const assessment = {
    prompt_version: 'cr-research-prompt@3',
    sources: [
      { source_id: 'S1', url: 'https://fictional-protocol.example/', source_type: 'project_website' },
      { source_id: 'S2', url: 'https://fictional-protocol.example/docs', source_type: 'project_documentation' },
      { source_id: 'S3', url: 'https://coinmarketcap.com/cmc-ai/fictional-protocol/latest-updates/', source_type: 'market_data' },
      { source_id: 'S4', url: 'https://academy.example.net/top-tokens', source_type: 'independent_analysis' },
      { source_id: 'S5', url: 'https://etherscan.io/token/0x0000000000000000000000000000000000f1c7a2', source_type: 'block_explorer' },
      { source_id: 'S6', url: 'https://www.coingecko.com/en/coins/fictional-protocol', source_type: 'market_aggregator' },
      { source_id: 'S7', url: 'https://github.com/fictional-protocol/core', source_type: 'code_repository' },
    ],
    claims: [
      // The review's audit case: "verified" from an AI summary page alone.
      { claim_id: 'C1', text: 'FICTIONAL: the protocol completed a security audit with a well-known firm in August.', evidence_tag: 'V', source_ids: ['S3'], as_of: '2026-08-31' },
      // The contract on an explorer: a primary source.
      { claim_id: 'C2', text: 'FICTIONAL: the token contract is deployed and verified on Ethereum.', evidence_tag: 'V', source_ids: ['S1', 'S5'], as_of: '2026-10-02' },
      // Live liquidity from an academy article: secondary.
      { claim_id: 'C3', text: 'FICTIONAL: on-chain liquidity depth is about $176,000.', evidence_tag: 'V', source_ids: ['S4'], metric_id: 'on_chain_liquidity_usd', as_of: '2026-08-23' },
      // The review's fee case: an estimate with a period but no query or dashboard.
      { claim_id: 'C4', text: 'FICTIONAL: organic network fees are estimated below $30,000 per month.', evidence_tag: 'I', source_ids: ['S2', 'S7'], metric_id: 'monthly_protocol_fees_usd', period: '30d', as_of: '2026-10-02' },
      // A price from an aggregator: not a critical claim, not flagged.
      { claim_id: 'C5', text: 'FICTIONAL: the price is about $0.15.', evidence_tag: 'V', source_ids: ['S6'], metric_id: 'price_usd', as_of: '2026-10-02' },
      // A supply change with no date.
      { claim_id: 'C6', text: 'FICTIONAL: a burn of 16.5M tokens was approved.', evidence_tag: 'C', source_ids: ['S1'] },
    ],
    catalysts: [],
  };
  const e = evidenceChecks(assessment, { officialWebsite: 'https://fictional-protocol.example/' });
  const by = Object.fromEntries(e.flags.map((f) => [`${f.claim_id}:${f.rule}`, f]));
  assert.deepEqual(Object.keys(by).sort(), ['C1:ai_summary_as_verified', 'C3:critical_without_primary', 'C4:fees_not_reproducible', 'C6:critical_without_date']);
  assert.equal(by['C1:ai_summary_as_verified'].severity, 'high');
  assert.match(by['C1:ai_summary_as_verified'].message, /^C1 is tagged verified, but its only support is an AI-generated summary \(S3: coinmarketcap\.com\/cmc-ai\/.*\)\. An AI summary never verifies a claim; an audit needs the audit report itself/);
  assert.match(by['C3:critical_without_primary'].message, /^C3 \(live liquidity\) is tagged verified without a primary source \(its sources: research\)\. It needs the order book or pool itself, on a dated snapshot\.$/);
  assert.match(by['C4:fees_not_reproducible'].message, /^C4 \(a fee or revenue figure: monthly_protocol_fees_usd\) cannot be reproduced: it lacks a query, dashboard or explorer view that reproduces it \(its sources: official\)\.$/);
  assert.equal(e.critical_claims, 5, 'the deployment (C2) is critical and has its primary source');
  assert.equal(e.flagged_claims, 4);
  assert.equal(e.high, 1);
  assert.deepEqual(e.source_types.ai_summaries, ['S3']);
  assert.match(e.summary, /^4 of 6 claims need better evidence \(1 high, 2 medium, 1 low\)\. These checks change no score\.$/);

  // From @4 on, a critical [V] claim shows its excerpt or query; the model's own critical_kind is used.
  const v4 = { ...assessment, prompt_version: 'cr-research-prompt@4', claims: [
    { claim_id: 'C1', text: 'FICTIONAL: audited by a firm.', evidence_tag: 'V', source_ids: ['S7'], as_of: '2026-08-01', critical_kind: 'audit' },
    { claim_id: 'C2', text: 'FICTIONAL: fees of $12,000 over 30 days.', evidence_tag: 'V', source_ids: ['S5'], as_of: '2026-10-01', period: '30 days to 2026-10-01', critical_kind: 'realized_fees', query: 'FICTIONAL dashboard query 123, 2026-09-01 to 2026-10-01' },
  ] };
  const e4 = evidenceChecks(v4, { officialWebsite: 'https://fictional-protocol.example/' });
  assert.deepEqual(e4.flags.map((f) => `${f.claim_id}:${f.rule}`), ['C1:critical_without_excerpt']);

  // The fixture report (primary sources, dated, reproducible) is not flagged,
  // and the project detail carries the checks next to an unchanged grade.
  const { ws } = workspace(t, 'contract-evidence');
  const r = importOne(ws, clone());
  const detail = require('../core/indexer').projectDetail(ws, PID);
  const full = detail.reports.find((x) => x.report_id === r.rep.report_id);
  assert.equal(full.evidence.flags.length, 0, JSON.stringify(full.evidence.flags));
  assert.equal(full.grade.value, BASE_GRADE);
  const brief = detail.history.claude.find((x) => x.report_id === r.rep.report_id).evidence;
  assert.deepEqual(Object.keys(brief).sort(), ['critical', 'flagged', 'high', 'low', 'medium', 'summary']);
});

test('reports imported before @4 keep their stored scenario error, but every view rates it as the current contract does (a warning); the record is not changed', (t) => {
  const { ws, root } = workspace(t, 'contract-old-scenario');
  const r = importOne(ws, clone());
  // What an import before @4 stored for a report without probabilities.
  const file = path.join(root, r.rep.dir, 'report.json');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  rec.extraction.issues.push({ severity: 'error', field: 'scenarios', message: 'Not every scenario has a probability.' });
  fs.writeFileSync(file, JSON.stringify(rec));
  const before = fs.readFileSync(file);
  const detail = require('../core/indexer').projectDetail(ws, PID);
  const brief = detail.history.claude.find((x) => x.report_id === r.rep.report_id);
  assert.equal(brief.errors, 0, 'not counted as an error');
  const shown = detail.reports.find((x) => x.report_id === r.rep.report_id).extraction.issues.find((i) => i.field === 'scenarios');
  assert.equal(shown.severity, 'warning');
  assert.equal(shown.severity_when_imported, 'error');
  assert.match(shown.message, /a warning under the current report contract: scenario probabilities are optional/);
  assert.ok(fs.readFileSync(file).equals(before), 'the stored record is unchanged');
  assert.equal(brief.grade.value, BASE_GRADE);
});
