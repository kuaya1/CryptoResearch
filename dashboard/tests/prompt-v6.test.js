'use strict';
// cr-research-prompt@6 (2026-10-21): @5 with three tests every model answers:
// who still pays if the price stops rising and how $1 reaches the holder (the
// waterfall), holder cash flow per token against supply growth (dilution),
// and a one-sentence falsifiable thesis. The profiles, report format and
// weights are @5's; a @5 run's prompt and a @5 report's blocks are unchanged.
// FICTIONAL workspaces only; no model is called.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tempWorkspace, addFixtureProject, FIXTURES } = require('./helpers');
const inbox = require('../core/inbox');
const research = require('../core/research');
const prompts = require('../core/prompts');
const projects = require('../core/projects');
const thesis = require('../core/thesis');
const { loadReports } = require('../core/reports');
const { gradeAssessment } = require('../core/rubrics');

const PAYFI = 'example-payfi-fictional';
const NET = 'example-network-fictional';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function workspace(t, label) {
  const d = tempWorkspace(label);
  t.after(d.cleanup);
  return d;
}

test('@6: a new run asks every model the waterfall, the per-token cash flow and the one-sentence thesis, in the prompt and in the JSON skeleton', (t) => {
  const { ws, root } = workspace(t, 'v6-run');
  addFixtureProject(ws);
  const r = research.createRun(ws, { project_id: PAYFI, providers: ['claude', 'chatgpt', 'gemini'] });
  assert.equal(r.run.prompt.version, prompts.PROMPT_VERSION_V6);
  assert.equal(r.run.sector_profile, 'payfi-credit@2', 'the @2 profile, as for @5');
  assert.equal(r.run.rubric_version, 'cr-grading@1');
  assert.equal(r.run.prompt.identical_for_all_providers, true);
  const p = fs.readFileSync(path.join(root, r.run.prompt.path), 'utf8');
  assert.equal(sha256(p), r.run.prompt.sha256);
  assert.match(p, /\*\*The waterfall test\.\*\* Suppose the token's price stopped rising\. Who would still pay/);
  assert.match(p, /Revenue from the token's own transfer or swap tax is paid by its holders and traders themselves/);
  assert.match(p, /Sustainable holder cash flow per token = the sustainable cash flow allocated to holders ÷ the supply economically entitled to it/);
  assert.match(p, /When the supply grows faster than the holder cash flow, say that the holder is being diluted\./);
  assert.match(p, /8\. \*\*One-sentence falsifiable thesis\.\*\* In exactly this form: "The market assumes \[X\]; verified evidence shows \[Y\]; \[event Z\] between \d{4}-\d{2}-\d{2} and \d{4}-\d{2}-\d{2} makes the difference observable\."/);
  // The skeleton asks for the three parts beside the six earlier ones.
  for (const k of ['payment_waterfall', 'per_token_cash_flow', 'falsifiable_thesis', 'market_misunderstanding', 'advantage_over_btc']) assert.ok(p.includes(`"${k}"`), k);
  // An older run's @5 prompt is rebuilt without them.
  const packet = JSON.parse(fs.readFileSync(path.join(root, r.run.evidence_packet.path), 'utf8'));
  const p5 = prompts.buildRunPrompt(ws, projects.getProject(ws, PAYFI), { runId: r.run.run_id, horizon: r.run.horizon, rubricRef: r.run.rubric_version, packet, version: prompts.PROMPT_VERSION_V5, profileRef: r.run.sector_profile });
  assert.match(p5, /^<!-- CR-PROMPT cr-research-prompt@5 /);
  assert.ok(!p5.includes('"falsifiable_thesis"'));
  assert.ok(!/waterfall/i.test(p5));
});

test('@6: the three parts are read as the model wrote them; a @5 report\'s judgment block keeps its earlier shape', (t) => {
  const { ws } = workspace(t, 'v6-report');
  addFixtureProject(ws);
  projects.addProject(ws, { name: 'Example Network (FICTIONAL)', symbol: 'XNET', official_website: 'https://example.net/xnet', coingecko_id: NET, assets: [{ chain: 'example-chain', contract_address: 'FICTIONAL-CONTRACT-XNET' }], evidence: [{ url: 'https://example.net/xnet', note: 'fictional' }], sector_profile: 'network-infrastructure@2' });
  const fixture = fs.readFileSync(path.join(FIXTURES, 'reports', `${NET}__claude.v5.md`), 'utf8');
  const at = fixture.indexOf('```json');
  const prose = fixture.slice(0, at);
  const base = JSON.parse(fixture.slice(at + 7, fixture.lastIndexOf('\n```')));
  const save = (json) => {
    const out = inbox.importContent(ws, 'claude', { content: `${prose}\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`, projectId: NET });
    assert.equal(out.result.status, 'ingested', out.result.message);
    return loadReports(ws, NET).find((r) => r.report_id === out.result.report_id);
  };
  const v5 = save(base);
  const b5 = v5.assessment.independent_judgment;
  assert.equal(b5.schema_version, 'cr.independent-judgment.v1');
  assert.ok(!('falsifiable_thesis' in b5), 'nothing added to an earlier report');
  const j = JSON.parse(JSON.stringify(base));
  j.prompt_version = prompts.PROMPT_VERSION_V6;
  j.summary = `${j.summary || ''} (a FICTIONAL @6 save)`;
  j.independent_judgment = { ...(j.independent_judgment || {}),
    payment_waterfall: { view: 'FICTIONAL: borrowers pay interest; about $0.15 of each $1 reaches stakers after incentives.', label: 'judgment', supporting_evidence: [], disconfirming_test: 'FICTIONAL: incentives end and payments fall.' },
    per_token_cash_flow: { view: 'FICTIONAL: holder cash flow per staked token grows slower than staked supply: diluted.', label: 'judgment', supporting_evidence: [], disconfirming_test: null },
    falsifiable_thesis: { view: 'FICTIONAL: The market assumes fees reach holders; verified evidence shows 15% does; the fee vote in the horizon makes it observable.', label: 'judgment', supporting_evidence: [], disconfirming_test: 'FICTIONAL: the vote passes with a full fee switch.' } };
  const v6 = save(j);
  const b6 = v6.assessment.independent_judgment;
  assert.equal(b6.schema_version, 'cr.independent-judgment.v2');
  assert.match(b6.falsifiable_thesis.view, /^FICTIONAL: The market assumes fees reach holders/);
  assert.equal(b6.payment_waterfall.label, 'judgment');
  assert.equal(b6.per_token_cash_flow.disconfirming_test, null);
  // The grade still comes from the six components alone.
  assert.deepEqual(gradeAssessment(ws, v6.assessment).grade, gradeAssessment(ws, v5.assessment).grade);
  // judgmentKeysFor: @6 asks nine parts, @5 six.
  assert.equal(thesis.judgmentKeysFor(prompts.PROMPT_VERSION_V6).length, 9);
  assert.equal(thesis.judgmentKeysFor(prompts.PROMPT_VERSION_V5).length, 6);
});
