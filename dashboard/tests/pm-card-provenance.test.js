'use strict';
// The PM Decision Card's provenance (autonomous paper playbook, Stage 10):
// a paper mandate grant says so with its R, amount, tier and expiry; the
// mandate's re-open says an exit reading arrived; after Eric undid a mandate
// grant, the card says the mandate never grants it again. Eric's own
// decisions read as before. Pure rules in public/pm-card-model.js, plus a
// check that the card draws them. FICTIONAL values only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mod = import('../public/pm-card-model.js');
const BY = 'mandate:cr-paper-mandate@1';
const EXP = '2026-11-07T12:00:00.000Z';

test('a mandate halve and approve read 0.5R and 1.0R with the amount, the tier in words and the expiry', async () => {
  const { provenanceOf } = await mod;
  const halve = provenanceOf({ pm_approved_risk_usd: 250, decision: { action: 'halve', decided_by: BY, mandate: { tier: 'exploratory_50_54', grade_used: 52, expires_at: EXP } } });
  assert.deepEqual(halve, { kind: 'mandate_grant', text: 'Granted by paper mandate (0.5R, $250)', tier_words: 'Exploratory, grade 50–54.9', expires_at: EXP, why: null });
  const approve = provenanceOf({ pm_approved_risk_usd: 500, decision: { action: 'approve', decided_by: BY, mandate: { tier: 'standard_55_plus', grade_used: 61, expires_at: EXP } } });
  assert.equal(approve.text, 'Granted by paper mandate (1.0R, $500)');
  assert.equal(approve.tier_words, 'Standard, grade 55+');
});

test('the mandate\'s re-open, and the latch after Eric\'s undo, read in words', async () => {
  const { provenanceOf } = await mod;
  const re = provenanceOf({ decision: { action: 'reopen', decided_by: BY, reopen: { kind: 'exit_evidence_arrived', why: 'An exit reading at $500 arrived (FICTIONAL).' } } });
  assert.deepEqual([re.kind, re.text, re.why], ['mandate_reopen', 'Re-opened by the paper mandate: an exit reading arrived', 'An exit reading at $500 arrived (FICTIONAL).']);
  const latched = provenanceOf({ decision: null, mandate_latched: { undone_decision_id: 'td_x', action: 'halve', tier: 'exploratory_50_54' } });
  assert.equal(latched.text, 'Undone by you. The mandate will not grant this ticket again.');
});

test('Eric\'s own decisions, or none, carry no provenance line', async () => {
  const { provenanceOf } = await mod;
  assert.equal(provenanceOf({ pm_approved_risk_usd: 500, decision: { action: 'approve', decided_by: 'eric' } }), null);
  assert.equal(provenanceOf({ decision: { action: 'reopen', decided_by: null } }), null);
  assert.equal(provenanceOf({}), null);
  assert.equal(provenanceOf(null), null);
});

test('the card draws the provenance line and names the mandate in the decided row', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'views', 'inspector', 'PMDecisionCard.jsx'), 'utf8');
  assert.match(src, /provenanceOf\(t\)/);
  assert.match(src, /data-key=\{`pm-provenance-\$\{pid\}`\}/);
  assert.match(src, /prov && prov\.kind !== 'mandate_latched' \? prov\.text : DECIDED_WORDS\[decided\.action\]/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'styles', 'inspector.css'), 'utf8');
  assert.match(css, /\.pm-provenance \{/);
});
