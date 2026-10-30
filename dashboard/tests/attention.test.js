'use strict';
// Stage 3: one attention contract (public/attention-model.js, cr-attention@1)
// read by the Desk's PM cards, the Review queue and the Daily Brief, so their
// counts agree; Eric's own notes and runs never re-queue a project; a
// quarantined or excluded report neither counts toward a review nor drives
// staleness. Fictional workspaces and rows only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { tempWorkspace, addFixtureProject, importAllFixtures } = require('./helpers');
const B = require('../core/brief-daily');
const A = require('../public/attention-model.js');

const PID = 'example-payfi-fictional';

// The golden rows: a low-grade PM card, a $0 desk gate on a token not held,
// a desk gate on a held token, a desk-gate Trim / exit, a decided ticket, a
// re-opened ticket and an archived one.
function goldenRows() {
  const low = { headline: null, providers: { claude: { report_id: 'r_low', grade: { status: 'firm', value: 22, display: '22' } } } };
  const row = (id, ticket, more = {}) => ({ project_id: id, name: id, status: 'active', ticket: { status: 'pending_pm_review', proposal_type: 'ACCUMULATE', saved_at: '2026-10-01T00:00:00Z', suggested_risk_usd: 500, ...ticket }, ...more });
  return [
    row('low-card', {}, low),
    row('gate-zero', { desk_gate: true, proposal_type: 'HARD_PASS', suggested_risk_usd: 0 }, low),
    row('gate-held', { desk_gate: true, proposal_type: 'WATCH_ONLY', suggested_risk_usd: 0 }, { held: true, position: { value_usd: 10 } }),
    row('gate-trim', { desk_gate: true, proposal_type: 'TRIM_EXIT', suggested_risk_usd: 0 }),
    row('decided', { decision: { action: 'veto', at: '2026-10-02T00:00:00Z' } }),
    row('reopened', { status: 'reopened' }),
    row('archived', {}, { status: 'archived' }),
  ];
}

function stubIndex(t, ws, rows) {
  const indexer = require('../core/indexer');
  const real = indexer.buildIndex;
  indexer.buildIndex = (...a) => ({ ...real(...a), projects: rows });
  t.after(() => { indexer.buildIndex = real; });
  return indexer.buildIndex(ws);
}

test('attention: Desk, Review and the Daily Brief count the same PM cards; a $0 desk gate on a token not held is "Closed by the desk"; a low grade never hides a card', async (t) => {
  const { ws, cleanup } = tempWorkspace('attn');
  t.after(cleanup);
  const rows = goldenRows();
  const index = stubIndex(t, ws, rows);
  const { reviewQueue } = await import('../public/review-model.js');

  const W = await import('../public/watchlist-model.js');
  assert.equal(W.lowGradeHidden(rows[0], index), true, 'the fixture is a low grade the Review queue would otherwise leave out');
  const desk = A.decisionsOf(rows);
  assert.deepEqual(desk.cards.map((p) => p.project_id).sort(), ['gate-held', 'gate-trim', 'low-card', 'reopened']);
  assert.deepEqual(desk.closed.map((p) => p.project_id), ['gate-zero']);
  assert.equal(desk.count, 4);

  const review = reviewQueue(index);
  const waiting = review.flat.filter((x) => x.reasons.some((r) => r.ticket)).map((x) => x.pid).sort();
  assert.deepEqual(waiting, ['gate-held', 'gate-trim', 'low-card', 'reopened'], 'the Review queue names the same cards, the low grade included');

  const brief = B.brief(ws, { now: Date.parse('2026-10-05T00:00:00Z') });
  const pm = brief.sections.find((s) => s.id === 'pm_cards');
  assert.equal(pm.count, 4);
  assert.ok(pm.lines.some((l) => l.text === 'Closed by the desk (1): gate-zero.'));

  const att = B.attention(ws, { now: Date.parse('2026-10-05T00:00:00Z') });
  assert.equal(att.format, 'cr-attention@1');
  assert.equal(att.decisions.count, 4);
  assert.deepEqual(att.decisions.closed_by_desk.map((x) => x.project_id), ['gate-zero']);
  assert.equal(brief.attention.decisions.count, att.decisions.count);
});

test('attention: an unreadable ticket makes every count unknown, never 0', async (t) => {
  const { ws, cleanup } = tempWorkspace('attn-bad');
  t.after(cleanup);
  const rows = [...goldenRows(), { project_id: 'bad', name: 'bad', status: 'active', ticket: { unavailable: true, error: 'FICTIONAL read failure' } }];
  stubIndex(t, ws, rows);
  assert.equal(A.decisionsOf(rows).count, null);
  assert.equal(A.countWords(A.decisionsOf(rows).count), 'Unknown');
  const brief = B.brief(ws, { now: Date.parse('2026-10-05T00:00:00Z') });
  const pm = brief.sections.find((s) => s.id === 'pm_cards');
  assert.equal(pm.state, 'partial');
  assert.equal(pm.count, null);
  const ex = brief.sections.find((s) => s.id === 'exceptions');
  assert.equal(ex.state, 'partial');
  assert.equal(ex.count, null);
  assert.equal(brief.attention.exceptions.count, null);
  const one = brief.attention.exceptions.items.find((e) => e.reason === 'ticket_unreadable');
  assert.equal(one.key, 'bad:-:ticket_unreadable');
  assert.ok(one.action.label && one.action.href);
});

test('attention: exceptions carry one identity and one action: invalidated tickets, uncertain paid calls, budget waits and a restored copy', (t) => {
  const index = {
    projects: [
      { project_id: 'inv', name: 'inv', status: 'active', ticket: { status: 'invalidated', receipt_id: 'tr_1', invalidation: { words: 'Invalidated: the price fell below $1.' } } },
      { project_id: 'unc', name: 'unc', status: 'active', research: { providers: { chatgpt: { state: 'uncertain', run_id: 'run_1' }, claude: { state: 'queued', run_id: 'run_1', budget_wait: { limit: 'daily', until: '2026-10-06T04:00:00Z' } } } } },
    ],
  };
  const ex = A.exceptionsOf(index, { jobs: [{ job: 'trader', failing: true, at: '2026-10-05T00:00:00Z', error: 'FICTIONAL' }], queue: [{ step: 'ticket_failed', project_id: 'inv', ticket_id: 'tk_1', refused_field: 'entry_zone' }], trader: [], intake: [], restored: { research_held: true } });
  assert.equal(ex.count, 6);
  const keys = ex.items.map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length, 'each exception has one identity');
  assert.deepEqual(ex.items.map((e) => e.reason).sort(), ['budget_wait_claude', 'invalidated', 'job_failing', 'restored_copy', 'ticket_failed', 'uncertain_chatgpt']);
  for (const e of ex.items) assert.ok(e.action.label && /^#\//.test(e.action.href), e.key);
  // A source that could not be read is said, its count unknown.
  const part = A.exceptionsOf(index, { jobs: null });
  assert.equal(part.count, null);
  assert.ok(part.items.some((e) => e.reason === 'jobs_unreadable'));
});

test('attention: Eric\'s own note or research run never re-queues a project; a quarantined or excluded report does not count toward a review', async (t) => {
  const { ws, cleanup } = tempWorkspace('attn-churn');
  t.after(cleanup);
  addFixtureProject(ws);
  const projects = require('../core/projects');
  const notes = require('../core/notes');
  const indexer = require('../core/indexer');
  const research = require('../core/research');
  const { reviewQueue } = await import('../public/review-model.js');
  projects.markReviewed(ws, PID);
  await new Promise((r) => setTimeout(r, 15));
  notes.addJournal(ws, PID, { type: 'note', text: 'FICTIONAL: my own thought' });
  research.createRun(ws, { project_id: PID, providers: ['chatgpt'] });
  let row = indexer.buildIndex(ws).projects.find((p) => p.project_id === PID);
  assert.ok(row.changes.item_count >= 2, 'the digest still lists the note and the run');
  assert.equal(row.changes.review_count, 0);
  assert.ok(!reviewQueue(indexer.buildIndex(ws)).flat.some((x) => x.pid === PID && x.reasons.some((r) => r.kind === 'changed')), 'no "Changed since review" from Eric\'s own work');

  importAllFixtures(ws);
  row = indexer.buildIndex(ws).projects.find((p) => p.project_id === PID);
  const all = row.changes.review_count;
  assert.ok(all >= 1, 'new eligible reports count');
  const claude = indexer.projectDetail(ws, PID).comparison.latest.claude;
  notes.addCorrection(ws, PID, claude.report_id || claude, 'eligibility', { excluded: true, reason: 'FICTIONAL: wrong project.' }, 'FICTIONAL test');
  row = indexer.buildIndex(ws).projects.find((p) => p.project_id === PID);
  assert.equal(row.changes.review_count, all - 1, 'an excluded report does not count');
});

test('attention: staleness reads one threshold, research_stale_days; report_stale_days is retired', () => {
  const { DEFAULT_SETTINGS, researchStaleDays } = require('../core/workspace');
  assert.equal(DEFAULT_SETTINGS.freshness.report_stale_days, undefined);
  assert.equal(researchStaleDays({ freshness: { research_stale_days: 30, report_stale_days: 5 } }), 30);
  assert.equal(researchStaleDays({}), 90);
});
