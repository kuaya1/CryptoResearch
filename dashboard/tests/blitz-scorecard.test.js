'use strict';
// The Day-30 scorecard (dashboard/scripts/blitz-scorecard.js, backlog item
// 29): every row of the blueprint's section 7 computes from a temporary git
// repo and a fictional workspace; a source the records cannot answer reads
// "not measurable from records"; nothing is written. No network, no model.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempWorkspace, addFixtureProject, hashTree } = require('./helpers');
const { scorecard, render } = require('../scripts/blitz-scorecard');
const tickets = require('../core/tickets');
const briefDaily = require('../core/brief-daily');

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
const g = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const put = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
const NOW = Date.parse('2026-10-26T12:00:00Z');
const byId = (card, id) => card.rows.find((r) => r.id === id);
const signedOut = () => ({ status: 1, out: '', err: 'not logged in' });

function repo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-score-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  g(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const work = path.join(root, 'work');
  g(root, 'clone', '-q', origin, work);
  g(work, 'checkout', '-q', '-b', 'main');
  put(work, 'DESK_STATE.md', '## Autonomous Build Backlog\n- [x] **1. One.** a\n- [ ] **2. Two.** b\n');
  g(work, 'add', '-A'); g(work, 'commit', '-qm', 'base'); g(work, 'push', '-q', '-u', 'origin', 'main');
  const merged = (item) => { put(work, `f${item}.txt`, 'x'); g(work, 'add', '-A'); g(work, 'commit', '-qm', `backlog: item ${item}\n\nBacklog-Item: ${item}`); };
  const branch = (name, item) => {
    g(work, 'checkout', '-q', '-B', name, 'origin/main');
    put(work, `f${item}.txt`, 'y'); g(work, 'add', '-A'); g(work, 'commit', '-qm', `backlog: item ${item}\n\nBacklog-Item: ${item}`);
    g(work, 'push', '-q', 'origin', name); g(work, 'checkout', '-q', 'main');
  };
  return { work, merged, branch, push: () => g(work, 'push', '-q', 'origin', 'main'), fetch: () => g(work, 'fetch', '-q', 'origin') };
}

test('git rows: items merged from trailers and ticks, branches waiting, CI through gh, rollback drill', (t) => {
  const r = repo(t);
  for (const i of [3, 4, 5, 6, 7, 8]) r.merged(i);
  r.push();
  r.branch('claude/backlog-batch-items-9-10', 9);
  r.fetch();

  const card = scorecard({ cwd: r.work, ws: null, now: NOW, gh: signedOut });
  assert.equal(card.rows.length, 10);
  const items = byId(card, 'items_merged');
  assert.equal(items.value, 7, 'six trailers plus the ticked item 1');
  assert.equal(items.status, 'met');
  const waiting = byId(card, 'branches_waiting');
  assert.equal(waiting.value, 1);
  assert.equal(waiting.status, 'not measurable from records', 'within the cap says nothing about earlier moments');
  assert.equal(byId(card, 'ci_coverage').status, 'not measurable from records');
  assert.match(byId(card, 'ci_coverage').note, /not signed in/);
  assert.equal(byId(card, 'rollback_drill').status, 'not measurable from records');
  assert.equal(byId(card, 'briefs_delivered').status, 'not measurable from records');

  // Over the cap now is a miss (after the surge the cap is 4).
  for (let i = 11; i <= 15; i++) r.branch(`claude/backlog-slug-${i}`, i);
  r.fetch();
  const after = scorecard({ cwd: r.work, ws: null, now: Date.parse('2026-10-29T00:00:00Z'), gh: signedOut });
  assert.equal(byId(after, 'branches_waiting').status, 'not met');
  assert.equal(byId(after, 'branches_waiting').value, 6);

  const ok = (args) => (args[0] === 'auth' ? { status: 0, out: '', err: '' } : { status: 0, out: JSON.stringify([{ headBranch: 'claude/backlog-batch-items-9-10' }, { headBranch: 'claude/backlog-slug-11' }]), err: '' });
  const ci = byId(scorecard({ cwd: r.work, ws: null, now: NOW, gh: (cwd, args) => ok(args) }), 'ci_coverage');
  assert.equal(ci.status, 'not met');
  assert.match(ci.note, /2 of 6 backlog branches/);
  const all = byId(scorecard({ cwd: r.work, ws: null, now: NOW, gh: (cwd, args) => (args[0] === 'auth' ? { status: 0, out: '', err: '' } : { status: 0, out: JSON.stringify(['claude/backlog-batch-items-9-10', ...[11, 12, 13, 14, 15].map((i) => `claude/backlog-slug-${i}`)].map((b) => ({ headBranch: b }))), err: '' }) }), 'ci_coverage');
  assert.equal(all.status, 'met');
  assert.equal(all.value, 100);

  put(r.work, 'audits/2026-11-01-rollback-drill/README.md', 'The drill passed.');
  g(r.work, 'add', '-A');
  assert.equal(byId(scorecard({ cwd: r.work, ws: null, now: NOW, gh: signedOut }), 'rollback_drill').status, 'met');
});

test('a folder that is not a git repository reads not measurable, never a guess', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-score-nogit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const card = scorecard({ cwd: dir, ws: null, now: NOW, gh: signedOut });
  for (const id of ['items_merged', 'branches_waiting', 'ci_coverage', 'rollback_drill']) assert.equal(byId(card, id).status, 'not measurable from records', id);
  assert.equal(card.summary.not_measurable, 10, 'with no workspace either, every row says so');
  assert.equal(card.summary.met, 0);
  assert.match(render(card), /not measurable from records/);
});

test('workspace rows: pilot tickets, holding across a gap, old PM cards named in the brief, paper and ledger kept apart; nothing is written', (t) => {
  const w = tempWorkspace('scorecard');
  t.after(w.cleanup);
  const pid = addFixtureProject(w.ws).project_id;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-score-empty-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const realView = tickets.view;
  const realBrief = briefDaily.brief;
  t.after(() => { tickets.view = realView; briefDaily.brief = realBrief; });
  const pmCard = { desk_gate: false, status: 'pending_pm_review', saved_at: '2026-10-20T12:00:00Z', superseded_by_report: null, invalidation: { checks: [{ kind: 'price', status: 'holding', coverage: { gaps: [{ from: 'a', to: 'b' }] } }] } };
  tickets.view = () => ({ pilot: true, ticket: pmCard });
  briefDaily.brief = () => ({ sections: [{ id: 'pm_cards', state: 'ok', lines: [{ text: 'Example PayFi (FICTIONAL): accumulate, waiting 6 days.' }] }] });

  const before = hashTree(w.ws.root);
  const card = scorecard({ cwd: dir, ws: w.ws, now: NOW, gh: signedOut });
  assert.deepEqual(hashTree(w.ws.root), before, 'a read writes nothing');

  const pilot = byId(card, 'pilot_current');
  assert.equal(pilot.value, 1);
  assert.equal(pilot.status, 'not met', 'one is not ETH, ZAMA and three more');
  const gap = byId(card, 'holding_across_gap');
  assert.equal(gap.value, 1);
  assert.equal(gap.status, 'not met');
  assert.match(gap.note, /Example PayFi/);
  const pm = byId(card, 'pm_cards_48h');
  assert.equal(pm.value, 1);
  assert.equal(pm.status, 'met', 'waiting more than 48 h, and named in the brief');
  assert.equal(byId(card, 'crossover').status, 'met');
  assert.equal(byId(card, 'crossover').value, 0);
  const edge = byId(card, 'edge_claims');
  assert.equal(edge.status, 'met');
  assert.equal(edge.value, 0);

  // A card the brief does not name is a miss; an unreadable brief is not measurable.
  briefDaily.brief = () => ({ sections: [{ id: 'pm_cards', state: 'ok', lines: [{ text: 'None right now.' }] }] });
  assert.equal(byId(scorecard({ cwd: dir, ws: w.ws, now: NOW, gh: signedOut }), 'pm_cards_48h').status, 'not met');
  briefDaily.brief = () => ({ sections: [{ id: 'pm_cards', state: 'unreadable', error: 'index failed', lines: [] }] });
  const un = byId(scorecard({ cwd: dir, ws: w.ws, now: NOW, gh: signedOut }), 'pm_cards_48h');
  assert.equal(un.status, 'not measurable from records');
  assert.match(un.note, /index failed/);

  // A ledger entry naming a paper record is a crossover.
  const portfolio = require('../core/portfolio');
  portfolio.addAccount(w.ws, { account_id: 'ex', name: 'Exchange (FICTIONAL)', kind: 'exchange' });
  portfolio.addTransactions(w.ws, [{ type: 'buy', date: '2026-10-01', account_id: 'ex', asset_id: 'example-payfi-fictional', quantity: 1, price_usd: 1, note: 'see pp_1' }], { source: 'manual' });
  fs.mkdirSync(w.ws.abs('paper'), { recursive: true });
  fs.writeFileSync(w.ws.abs('paper/positions.jsonl'), `${JSON.stringify({ event: 'void', position_id: 'pp_1' })}\n`);
  const cross = byId(scorecard({ cwd: dir, ws: w.ws, now: NOW, gh: signedOut }), 'crossover');
  assert.equal(cross.status, 'not met');
  assert.equal(cross.value, 1);
});
