'use strict';
// Evidence checks read what the evidence says, not only whether a field holds
// text (review of fa05f99, 2026-10-05). Each gap is reproduced through the
// real import path (inbox.importContent: the same path the connector's
// save_report, the CLI's import-text, the request queue and the research
// runner use) and read back the way the dashboard and connector read it
// (indexer.projectDetail). The checks flag; a saved score, a stored report
// and its original are never changed.
//   - Code: named implementation files at a stated revision (a commit hash or
//     release tag). Commit history, releases, test-file counts, tests or
//     documents alone are repository activity; a branch name is not a
//     revision.
//   - Liquidity: a dated spread, depth or order-book figure. A venue list,
//     aggregate volume or "no depth retrieved" is not one; it never flags the
//     chart or timing grades, and the weighted timing component gets a low,
//     scoped note on its liquidity part only.
//   - Catalysts: a past price or chart observation a catalyst cites is not
//     checked as catalyst evidence.
//   - Wording: a clean result is "No inconsistencies detected by these
//     checks", with coverage stated; [V] is the researcher's classification.
// Everything is FICTIONAL, in throwaway workspaces; no provider is called.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempWorkspace, FIXTURES } = require('./helpers');
const inbox = require('../core/inbox');
const projects = require('../core/projects');
const { loadReports } = require('../core/reports');
const { gradeAssessment } = require('../core/rubrics');
const { evidenceChecks, criticalKind, TAG_NOTE } = require('../core/evidence');
const { projectDetail } = require('../core/indexer');

const NET = 'example-network-fictional';
const FIXTURE = fs.readFileSync(path.join(FIXTURES, 'reports', `${NET}__claude.v5.md`), 'utf8');
const FENCE_AT = FIXTURE.indexOf('```json');
const PROSE = FIXTURE.slice(0, FENCE_AT);
const BASE = JSON.parse(FIXTURE.slice(FENCE_AT + 7, FIXTURE.lastIndexOf('\n```')));
const clone = () => JSON.parse(JSON.stringify(BASE));
const text = (json) => `${PROSE}\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;
const SITE = 'https://example.net/xnet';

function desk(t, label) {
  const { ws, cleanup } = tempWorkspace(label);
  t.after(cleanup);
  projects.addProject(ws, {
    name: 'Example Network (FICTIONAL)', symbol: 'XNET', official_website: SITE,
    assets: [{ chain: 'example-chain', contract_address: 'FICTIONAL-CONTRACT-XNET' }],
    evidence: [{ url: `${SITE}/docs`, note: 'fictional test evidence' }], sector: 'ai_data',
  });
  let n = 0;
  // Save through the import path; read back as the dashboard and connector do.
  const save = (json) => {
    const j = { ...json, summary: `FICTIONAL variant ${n += 1}.` };
    const out = inbox.importContent(ws, 'claude', { content: text(j), projectId: NET });
    assert.equal(out.result.status, 'ingested', out.result.message);
    const rep = loadReports(ws, NET).find((r) => r.report_id === out.result.report_id);
    const shown = projectDetail(ws, NET).reports.find((r) => r.report_id === rep.report_id);
    return { rep, a: rep.assessment, ev: shown.evidence, grade: gradeAssessment(ws, rep.assessment), json: j };
  };
  return { ws, save };
}

const rules = (ev) => ev.flags.map((f) => [f.rule, f.severity, f.component || (f.categories || []).join('+') || f.claim_id]);
const codeAt = (j, repo, value = 78) => {
  j.diagnostic_scores.code_quality = { ...j.diagnostic_scores.chart_structure, status: 'scored', value, confidence: 'medium', rationale: 'FICTIONAL code grade.', missing_data: null };
  j.code_review = { source_access: 'public', repositories: [{ url: 'https://code.example.net/xnet/node', role: 'FICTIONAL node', observations: 'FICTIONAL', ...repo }], deployed_link: null, limitations: null };
  return j;
};
const liquidity = (j, reading) => { j.chart_cycle.liquidity = reading; return j; };

test('code: commit history, releases and test-file counts alone do not satisfy implementation inspection (the review\'s case, through the import path)', (t) => {
  const { ws, save } = desk(t, 'meaning-code-activity');
  const before = save(clone());
  const activity = save(codeAt(clone(), { commit: '3f9c2ab', files_inspected: ['commit history: 412 commits since 2024-03', 'releases: 14 tags, latest v1.4.0 on 2026-09-12', '38 test files under test/'] }));
  assert.deepEqual(rules(activity.ev), [['code_score_without_inspection', 'medium', 'code_quality']]);
  assert.match(activity.ev.flags[0].message, /^Code quality is scored 78, but what it lists as inspected \("commit history: 412 commits since 2024-03", "releases: 14 tags, latest v1\.4\.0 on 2026-09-12", "38 test files under test\/"\) is repository activity, tests or documents, not a named implementation file\./);
  // Tests and documents named as files are not implementation either.
  const tests = save(codeAt(clone(), { commit: '3f9c2ab', files_inspected: ['test/Vault.t.sol', 'src/vault.test.ts', 'README.md', 'CHANGELOG.md'] }));
  assert.deepEqual(rules(tests.ev), [['code_score_without_inspection', 'medium', 'code_quality']]);
  // A branch name or a description is not a stated revision.
  for (const commit of ['main', 'HEAD', 'latest as of 2026-10-01', '20261001']) {
    const r = save(codeAt(clone(), { commit, files_inspected: ['src/vault.sol'] }));
    assert.deepEqual(rules(r.ev), [['code_score_without_inspection', 'medium', 'code_quality']], commit);
    assert.match(r.ev.flags[0].message, /a branch or description rather than a commit hash or release tag, so the code read cannot be pinned/, commit);
  }
  // Flags only: the grade comes from the six components, and the saved
  // original is the text as received.
  assert.equal(activity.grade.value, before.grade.value);
  assert.equal(activity.a.diagnostic_scores.code_quality.value, 78);
  assert.equal(fs.readFileSync(ws.abs(`projects/${NET}/reports/${activity.rep.report_id}/${activity.rep.meta.original_file}`), 'utf8'), text(activity.json));
});

test('code: named implementation files at a commit hash or release tag are inspection, whatever else the entry says', (t) => {
  const { save } = desk(t, 'meaning-code-valid');
  for (const [commit, files] of [
    ['3f9c2ab', ['src/vault.sol']],
    ['c27732d199f8ad603d1983d8af72031c730b0382', ['contracts/core/Pool.sol (swap and fee paths)', 'test/Pool.t.sol']],
    ['v1.4.0', ['x/staking/keeper/msg_server.go']],
    ['tag v2.3.1', ['crates/node/src/lib.rs']],
    ['main @ 3f9c2ab1', ['programs/vault/src/instructions/withdraw.rs', 'commit history: 412 commits']],
  ]) assert.deepEqual(rules(save(codeAt(clone(), { commit, files_inspected: files })).ev), [], `${commit} ${files.join(', ')}`);
  // Unknown code quality needs no inspection; the source unreadable keeps its own flag.
  assert.deepEqual(rules(save(codeAt(clone(), { commit: null, files_inspected: [] }, 70)).ev), [['code_score_without_inspection', 'medium', 'code_quality']]);
});

test('liquidity: "no depth retrieved", a venue list and aggregate volume do not satisfy depth evidence; only the liquidity grade and the timing component\'s liquidity part are flagged', (t) => {
  const { save } = desk(t, 'meaning-liquidity-gaps');
  const base = save(clone());
  assert.deepEqual(rules(base.ev), [], 'the fixture: $40k within 2%, dated by its chart snapshot');
  const missing = save(liquidity(clone(), 'No depth retrieved; listed on Example Exchange and ExampleSwap with $1.2M 24h volume.'));
  assert.deepEqual(rules(missing.ev), [['liquidity_without_depth', 'medium', 'volume_liquidity'], ['executable_liquidity_unsupported', 'low', 'timing_executable_liquidity']]);
  assert.match(missing.ev.flags[0].message, /^Volume confirmation and executable liquidity is scored 44, but the report has only a statement that the depth data is missing \("No depth retrieved;/);
  assert.match(missing.ev.flags[0].message, /This concerns the liquidity grade; the chart and timing grades stand on their own evidence\.$/);
  assert.match(missing.ev.flags[1].message, /^Timing and executable liquidity is scored 50, and the report has only a statement that the depth data is missing .*: its executable-liquidity part rests on no measurement\. Its timing judgment can still stand on the chart; this flag does not question it, and changes no score\.$/);
  for (const reading of ['Order book depth not available; volume $3M.', 'Depth: n/a', 'Spread unknown.']) {
    assert.equal(save(liquidity(clone(), reading)).ev.flags[0].rule, 'liquidity_without_depth', reading);
  }
  for (const reading of ['Listed on Binance, OKX, Bybit and Uniswap.', '24h volume $12M across 15 venues.', 'Thin books on one venue.']) {
    const r = save(liquidity(clone(), reading));
    assert.equal(r.ev.flags[0].rule, 'liquidity_without_depth', reading);
    assert.match(r.ev.flags[0].message, /a liquidity reading with no spread, depth or order-book figure .*a venue list, aggregate volume or a description is not one/, reading);
  }
  // Missing order-book data never flags the chart structure or cycle timing grades.
  assert.ok(missing.ev.flags.every((f) => !(f.categories || []).some((c) => c === 'chart_structure' || c === 'cycle_timing')));
  // A baseline written as "unknown" is not a stated baseline.
  const noBase = clone();
  noBase.chart_cycle.volume.baseline = 'Unknown: no reliable history.';
  assert.match(save(noBase).ev.flags[0].message, /but the report has no stated volume baseline\./);
  // Scores and grades unchanged.
  assert.equal(missing.grade.value, base.grade.value);
  assert.equal(missing.a.diagnostic_scores.volume_liquidity.value, 44);
});

test('liquidity: dated spread, depth, slippage or pool figures satisfy it, including a reading that also names what it could not get', (t) => {
  const { save } = desk(t, 'meaning-liquidity-valid');
  for (const reading of [
    'Spread 0.3% and $85K within 2% on Example Exchange (2026-10-03).',
    'About $40k within ±2% on each side on one venue.',
    'ExampleSwap v3 pool liquidity $1.4M on 2026-10-02.',
    'Slippage of 1.2% on a $10k sell, 2026-10-03.',
    'Spread 25 bps on Example Exchange; no order book for the DEX pools (2026-10-03).',
  ]) assert.deepEqual(rules(save(liquidity(clone(), reading)).ev), [], reading);
  // A figure with no date anywhere (neither in the reading nor the chart
  // snapshot) is said once, by the chart date flag beside the chart grades.
  const undated = liquidity(clone(), 'About $40k within 2% on each side.');
  delete undated.chart_cycle.data.latest_observation_at;
  assert.deepEqual(rules(save(undated).ev).map((x) => x[0]), ['chart_without_observation_date']);
});

test('catalysts: a past price or chart observation a dated catalyst cites is not checked as catalyst evidence; an announcement still is', (t) => {
  const { save } = desk(t, 'meaning-catalyst');
  const j = clone();
  j.sources.push({ source_id: 'S9', url: 'https://www.coingecko.com/en/coins/example-network-fictional', title: 'FICTIONAL listing', publisher: 'CoinGecko', source_type: 'data_aggregator', accessed_at: '2026-10-03' });
  j.claims.push({ claim_id: 'C8', text: 'Fictional: the price fell 48% from the 2026-08-14 high and has traded between $0.42 and $0.61 since.', evidence_tag: 'V', source_ids: ['S9'], as_of: '2026-10-03', excerpt: 'FICTIONAL' });
  j.claims.push({ claim_id: 'C9', text: 'Fictional: the team announced the vote will open on 2026-11-10.', evidence_tag: 'V', source_ids: ['S9'], as_of: '2026-09-20', excerpt: 'FICTIONAL' });
  j.catalysts[0].claim_ids.push('C8', 'C9');
  const r = save(j);
  const byClaim = Object.fromEntries(r.ev.flags.filter((f) => f.claim_id).map((f) => [f.claim_id, f]));
  assert.equal(byClaim.C8, undefined, 'a historical price observation is context, not the catalyst');
  assert.equal(byClaim.C9.rule, 'critical_without_primary');
  assert.match(byClaim.C9.message, /^C9 \(a dated catalyst\) is tagged verified without a primary source/);
  const set = new Set(['C8', 'C9']);
  assert.equal(criticalKind(j.claims.find((c) => c.claim_id === 'C8'), set), null);
  assert.equal(criticalKind(j.claims.find((c) => c.claim_id === 'C9'), set), 'catalyst');
  // A liquidity claim that says the data is missing is not a live-liquidity measurement.
  assert.equal(criticalKind({ claim_id: 'X', text: 'No order-book depth could be retrieved; 24h volume was $2.1M.' }, new Set()), null);
  assert.equal(criticalKind({ claim_id: 'X', text: '2% depth on the main venue was $40k on each side.' }, new Set()), 'liquidity');
});

test('wording and coverage: a clean report says no inconsistencies were detected by these checks; too little to check says so; legacy reports without the blocks are not flagged for them', (t) => {
  const { save } = desk(t, 'meaning-wording');
  const clean = save(clone()).ev;
  assert.match(clean.summary, /^No inconsistencies detected by these checks: 7 claims checked, 5 of them critical, and 3 category grades against the code and chart evidence beside them\. They test structure and consistency, not whether the facts are true\. These checks change no score\.$/);
  assert.equal(clean.coverage.status, 'full');
  assert.equal(clean.tag_note, TAG_NOTE);
  assert.match(TAG_NOTE, /researcher's own classification .* the desk does not verify it independently/);
  assert.doesNotMatch(clean.summary, /nothing flagged|none flagged/i);
  // A @4 report (no code_review or chart_cycle asked for): scored grades are
  // not flagged for blocks it was never asked for, and the summary says so.
  const v4 = codeAt(clone(), { commit: 'main', files_inspected: ['commit history'] });
  v4.prompt_version = 'cr-research-prompt@4';
  delete v4.chart_cycle;
  delete v4.code_review;
  const old = save(v4).ev;
  assert.deepEqual(old.flags.filter((f) => !f.claim_id), []);
  assert.equal(old.coverage.status, 'partial');
  assert.match(old.summary, /Coverage is partial: its prompt \(cr-research-prompt@4\) did not ask for the code and chart evidence beside the category grades, so those grades were not checked\./);
  // A @5 report missing the liquidity field and the volume block.
  const gaps = clone();
  delete gaps.chart_cycle.liquidity;
  delete gaps.chart_cycle.volume;
  assert.match(save(gaps).ev.flags[0].message, /but the report has no stated volume baseline and no spread, depth or order-book reading\./);
  // Nothing at all to check: said as insufficient coverage, never as clean.
  const bare = evidenceChecks({ claims: [], diagnostic_scores: {} });
  assert.equal(bare.coverage.status, 'none');
  assert.match(bare.summary, /^Coverage insufficient: .* No flag here is not a clean result\./);
});

test('stored reports are read, never rewritten: a report saved before these checks keeps its bytes, record and grade, and its flags come from the current checks at read time', (t) => {
  const { ws, save } = desk(t, 'meaning-history');
  const r = save(liquidity(clone(), 'No depth retrieved.'));
  const dir = ws.abs(`projects/${NET}/reports/${r.rep.report_id}`);
  const snap = () => fs.readdirSync(dir).sort().map((f) => `${f}:${fs.readFileSync(path.join(dir, f)).toString('base64')}`).join('|');
  const before = snap();
  for (let i = 0; i < 3; i += 1) projectDetail(ws, NET);
  assert.equal(snap(), before, 'reading checks writes nothing into the report folder');
  const again = projectDetail(ws, NET).reports.find((x) => x.report_id === r.rep.report_id);
  assert.equal(again.grade.value, r.grade.value);
  assert.equal(again.evidence.flags[0].rule, 'liquidity_without_depth');
});
