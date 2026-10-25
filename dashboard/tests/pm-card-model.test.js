'use strict';
// The PM Decision Card's rule note and report-delta badge (backlog item 33):
// pure rules in public/pm-card-model.js, plus a check that the card draws
// them. FICTIONAL values only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mod = import('../public/pm-card-model.js');
const ok = (o = {}) => ({ status: 'ok', line: '+4.2 vs Oct 6', grade_delta: 4.2, grade_note: null, category_note: null, verdict_changed: false, previous_verdict: 'WATCH', new_verdict: 'WATCH', prompt_versions: { previous: 'cr-research-prompt@5', new: 'cr-research-prompt@6' }, ...o });

test('a firm delta reads "+4.2 vs previous @5" and names both prompt versions', async () => {
  const { deltaBadgeOf } = await mod;
  const b = deltaBadgeOf(ok());
  assert.equal(b.text, '+4.2 vs previous @5');
  assert.match(b.title, /cr-research-prompt@5 then, cr-research-prompt@6 now: a different prompt/);
  assert.equal(b.tone, 'is-warn');
  assert.deepEqual(b.versions, { previous: 'cr-research-prompt@5', new: 'cr-research-prompt@6' });
});

test('a fall uses the minus sign, the same prompt is not called different, a changed verdict is said', async () => {
  const { deltaBadgeOf } = await mod;
  const b = deltaBadgeOf(ok({ grade_delta: -8.1, verdict_changed: true, previous_verdict: 'WATCH', new_verdict: 'AVOID', prompt_versions: { previous: 'cr-research-prompt@6', new: 'cr-research-prompt@6' } }));
  assert.equal(b.text, '−8.1 vs previous @6; verdict WATCH → AVOID');
  assert.equal(b.tone, 'is-bad');
  assert.doesNotMatch(b.title, /different prompt/);
});

test('without a figure the desk\'s words stand, with the reason in the title', async () => {
  const { deltaBadgeOf } = await mod;
  const b = deltaBadgeOf(ok({ grade_delta: null, line: 'Grade change not given: the earlier grade is a range (50–60) (vs Oct 6)', grade_note: 'No grade change given: the earlier grade is a range (50–60).' }));
  assert.match(b.text, /^Grade change not given/);
  assert.match(b.title, /No grade change given/);
  assert.equal(b.tone, 'is-warn');
});

test('missing prompt versions are said, and no comparison gives no badge', async () => {
  const { deltaBadgeOf } = await mod;
  assert.match(deltaBadgeOf(ok({ prompt_versions: { previous: null, new: null } })).title, /Prompt versions not stated/);
  assert.equal(deltaBadgeOf(null), null);
  assert.equal(deltaBadgeOf({ status: 'none', line: 'No earlier eligible Claude report to compare.' }), null);
});

test('the rule note is the ticket\'s own words or nothing', async () => {
  const { ruleNoteOf } = await mod;
  assert.equal(ruleNoteOf({ rule_note: 'Made under a newer rule (cr-ticket-sizing@9): shown as saved, not re-read.' }), 'Made under a newer rule (cr-ticket-sizing@9): shown as saved, not re-read.');
  assert.equal(ruleNoteOf({ rule_note: null }), null);
  assert.equal(ruleNoteOf(null), null);
});

test('the card draws both on the prosecutor and the desk-gate layouts', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'views', 'inspector', 'PMDecisionCard.jsx'), 'utf8');
  assert.equal((src.match(/<DeltaBadge /g) || []).length, 2);
  assert.equal((src.match(/<RuleNote /g) || []).length, 2);
});

test('item 56: the widest category link comes from the largest model-spread gap that names a category, else nothing', async () => {
  const { widestCategoryLink } = await mod;
  const alert = (other, gap, id) => ({ kind: 'model_spread', other, category: id ? { id, claude: 80, other: 80 - gap, gap } : null, link: `#/project/p/compare${id ? `?category=${id}` : ''}` });
  const l = widestCategoryLink({ alerts: [alert('chatgpt', 12, 'token_supply'), alert('gemini', 30, 'liquidity_exit')] });
  assert.equal(l.href, '#/project/p/compare?category=liquidity_exit');
  assert.match(l.text, /liquidity exit/);
  assert.match(l.title, /30 points apart/);
  assert.equal(widestCategoryLink({ alerts: [alert('chatgpt', 12, null)] }), null, 'no category named, none guessed');
  assert.equal(widestCategoryLink({ alerts: [{ kind: 'prosecutor_spread', gap: 25, link: '#/?p=p' }] }), null);
  assert.equal(widestCategoryLink(null), null);
});

test('item 56: the card draws the side-by-side block only when agent_disagreement is present', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'views', 'inspector', 'PMDecisionCard.jsx'), 'utf8');
  assert.match(src, /t\.agent_disagreement \? <Disagreement/);
  assert.match(src, /Agent 1 · Researcher/);
  assert.match(src, /Agent 2 · Prosecutor/);
  assert.match(src, /dis\.spread_points/);
  assert.match(src, /widestCategoryLink\(spread\)/);
});
