'use strict';
// The Review queue (public/review-model.js; DESIGN_AND_IA_BLUEPRINT.md §3.4,
// D3, 2026-10-17): one queue for "what needs me", grouped by reason in a fixed
// order, each project once with every reason it has; the Desk's Needs review
// count, its view and the rail count the same projects (the agenda's due item
// included). Pure functions over FICTIONAL index rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

let tmp;
async function load() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-review-queue-'));
  fs.cpSync(path.join(__dirname, '..', 'public'), tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{ "type": "module" }');
  const rq = await import(pathToFileURL(path.join(tmp, 'review-model.js')).href);
  const wl = await import(pathToFileURL(path.join(tmp, 'watchlist-model.js')).href);
  return { rq, wl };
}
const mods = load();
test.after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

const row = (id, extra = {}) => ({ project_id: id, name: `${id} (FICTIONAL)`, symbol: id.toUpperCase().slice(0, 4), status: 'active', on_watchlist: true, ...extra });
const changed = (n) => ({ changes: { item_count: n, cursor_source: 'your last review' } });
function fixture() {
  return {
    today: '2026-10-17',
    projects: [
      row('alpha', changed(3)),
      row('bravo', { next_review: { date: '2026-10-10', overdue: true } }),
      row('charlie', { forensic: { audited: false, open_audit: { audit_id: 'fa_x', investigator: 'waiting' }, to_review: 0 } }),
      row('delta'),
      row('echo', { ...changed(2), forensic: { audited: true, open_audit: null, to_review: 1 } }),
      row('foxtrot', { ...changed(5), status: 'archived' }),
      row('golf'),
      row('hotel', { broken: true }),
    ],
    attention: [
      { kind: 'disagreement', project_id: 'delta', title: 'delta (FICTIONAL): models disagree on 2 items' },
      { kind: 'disagreement', project_id: 'echo', title: 'echo (FICTIONAL): models disagree on 1 item' },
    ],
    imports: { inbox: { in_inbox: [{ key: 'k1', provider: 'claude', filename: 'fictional.md', status: 'waiting' }] }, requests_pending: [{ request_id: 'rq1', action: 'save_report', waiting_since: '2026-10-16T12:00:00Z' }] },
  };
}
const agendaFixture = () => ({
  rows: [
    { project_id: 'golf', primary: { item_id: 'ag_g1', kind: 'checkpoint', title: 'Review the 14 days checkpoint', due: true, due_at: '2026-10-12T00:00:00Z' }, due: [], upcoming: [], undated: [], snoozed: [], completed: [] },
    { project_id: 'echo', primary: null, due: [], upcoming: [], undated: [], snoozed: [], completed: [] },
  ],
  failed: [],
});

test('review queue: groups in a fixed order; each project once, in its first group, with all its reasons; archived and broken projects stay out', async () => {
  const { rq } = await mods;
  assert.deepEqual(rq.GROUPS.map(([g]) => g), ['changed', 'due', 'waiting', 'differ', 'imports']);
  const q = rq.reviewQueue(fixture());
  const where = Object.fromEntries(q.flat.map((x) => [x.pid, x.group]));
  assert.deepEqual(where, { alpha: 'changed', echo: 'changed', bravo: 'due', charlie: 'waiting', delta: 'differ' });
  assert.equal(new Set(q.flat.map((x) => x.pid)).size, q.flat.length, 'one project counts once (D3)');
  const echo = q.flat.find((x) => x.pid === 'echo');
  assert.deepEqual(echo.reasons.map((r) => r.group), ['changed', 'due', 'differ'], 'every reason named beside the project');
  assert.match(echo.reasons[1].words, /1 forensic evidence change to review/);
  assert.equal(q.groups.find((g) => g.id === 'changed').items[0].pid, 'alpha', 'the most changes first');
  assert.equal(q.imports.length, 2);
  assert.equal(q.projects, 5);
  assert.equal(q.total, 7, 'projects and imports to confirm');
});

test('review queue: the agenda\'s due item puts a project under Review due; read with the agenda, the forensic count gives way to it', async () => {
  const { rq } = await mods;
  const q = rq.reviewQueue(fixture(), agendaFixture());
  const golf = q.flat.find((x) => x.pid === 'golf');
  assert.equal(golf.group, 'due');
  assert.equal(golf.reasons[0].words, 'Review the 14 days checkpoint');
  assert.equal(golf.reasons[0].item.item_id, 'ag_g1');
  const echo = q.flat.find((x) => x.pid === 'echo');
  assert.ok(!echo.reasons.some((r) => /forensic evidence change/.test(r.words)), 'the agenda is the record of what is due once it is read');
  // A snoozed or completed primary is not a reason.
  const a = agendaFixture();
  a.rows[0].primary.snoozed = { until: '2026-10-30' };
  assert.ok(!rq.reviewQueue(fixture(), a).flat.some((x) => x.pid === 'golf'));
});

test('review queue: the Desk\'s Needs review count, its view and the queue count the same projects', async () => {
  const { rq, wl } = await mods;
  for (const agenda of [null, agendaFixture()]) {
    const index = fixture();
    const q = rq.reviewQueue(index, agenda);
    const k = wl.deskKpis(index, agenda);
    assert.equal(k.review.projects, q.projects);
    assert.deepEqual(k.review.ids.slice().sort(), q.flat.map((x) => x.pid).sort());
    const inView = index.projects.filter((p) => !p.broken && p.status !== 'archived' && wl.inView(p, 'review', index, agenda)).map((p) => p.project_id).sort();
    assert.deepEqual(inView, q.flat.map((x) => x.pid).sort());
    for (const p of index.projects.filter((x) => q.flat.some((y) => y.pid === x.project_id))) assert.equal(wl.actionOf(p, index, agenda).kind, p.identity_status === 'verified' ? 'review' : 'identity');
  }
});

test('upcoming: overdue, dated, invalidators, alerts, undated catalysts and past report dates, never done or dismissed items', async () => {
  const { rq } = await mods;
  const c = (x) => ({ project_id: 'alpha', project_name: 'alpha (FICTIONAL)', title: 'FICTIONAL item', status: 'open', source: 'report', ...x });
  const u = rq.upcomingOf({
    today: '2026-10-17',
    calendar: [
      c({ type: 'review', date: '2026-10-01', overdue: true, source: 'you' }),
      c({ type: 'catalyst', date: '2026-11-01' }),
      c({ type: 'catalyst', date: '2026-09-01' }),
      c({ type: 'catalyst', date: null }),
      c({ type: 'invalidator', date: null }),
      c({ type: 'alert', date: null, source: 'you' }),
      c({ type: 'catalyst', date: '2026-11-02', status: 'done' }),
      c({ type: 'catalyst', date: '2026-11-03', status: 'dismissed' }),
    ],
  });
  assert.equal(u.today, '2026-10-17');
  assert.equal(u.overdue.length, 1);
  assert.deepEqual(u.dated.map((x) => x.date), ['2026-11-01']);
  assert.deepEqual(u.pastReport.map((x) => x.date), ['2026-09-01']);
  assert.equal(u.undated.length, 1);
  assert.equal(u.invalidators.length, 1);
  assert.equal(u.alerts.length, 1);
});
