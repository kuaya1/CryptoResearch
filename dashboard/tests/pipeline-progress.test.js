'use strict';
// The Pipeline cockpit (2026-10-27): core/pipeline.js reads the backlog and
// what is in flight from a copy, public/pipeline-progress.js turns it into
// the percentages, the categories, the stage working now, today's builds and
// the pace. FICTIONAL backlogs only; the route writes nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');
const P = require('../core/pipeline');
const { tempWorkspace, hashTree } = require('./helpers');

let model;
async function load() {
  if (model) return model;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pipeline-'));
  fs.copyFileSync(path.join(__dirname, '..', 'public', 'pipeline-progress.js'), path.join(tmp, 'pipeline-progress.js'));
  fs.writeFileSync(path.join(tmp, 'package.json'), '{ "type": "module" }');
  model = await import(pathToFileURL(path.join(tmp, 'pipeline-progress.js')).href);
  return model;
}

const STATE = [
  '# Desk state',
  '',
  '## Autonomous Build Backlog',
  '',
  '- [x] Phase 1 tickets (not numbered, not counted)',
  '- [x] **1. Core rule.** In `dashboard/core/tickets.js`. Tests in `tickets.test.js`.',
  '- [x] **2. A panel.** (`shell/Preferences.jsx`), saved through `validateSettingsPatch`.',
  '- [ ] **3. The brief.** Mentions `DailyBrief.jsx` as unchanged.',
  '  - **Schedule:** touches dashboard/core/brief-daily.js, dashboard/tests/brief-daily.test.js',
  '- [ ] **4. A workflow.** `.github/workflows/backlog-intake.yml` and `#/project/<id>/forensics`.',
  '- [x] **5. Words only.** No file at all.',
  '- [ ] *(Eric)* **6. A decision.** `dashboard/core/portfolio.js`',
  '- [ ] **7. Web and core.**',
  '  - **Schedule:** after 3; touches dashboard/core/ticket-format.js, web',
  '- [x] **8. Only the web test.** `dashboard/tests/web-app.test.js`',
  '',
  '## Next section',
  '- [ ] **99. Not in the backlog.** `dashboard/core/x.js`',
].join('\n');

const base = (over = {}) => ({
  format: 'cr-pipeline@1',
  backlog: P.backlogOf(STATE),
  in_flight: { known: true, waiting: [], claimed: [] },
  agent_lane: { known: true, limit: 6, used: 0, building: 0, revising: 0 },
  inbox: { known: true, by_status: {} },
  pace: { known: true, days: 7, merged: 0 },
  ...over,
});

test('pipeline: the backlog is the numbered items of its own section, with their paths and touches', () => {
  const b = P.backlogOf(STATE);
  assert.deepEqual(b.map((x) => x.n), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(b.find((x) => x.n === 6).eric, true);
  assert.deepEqual(b.find((x) => x.n === 1).paths, ['dashboard/core/tickets.js', 'tickets.test.js']);
  assert.deepEqual(b.find((x) => x.n === 3).touches, ['dashboard/core/brief-daily.js', 'dashboard/tests/brief-daily.test.js']);
  assert.deepEqual(b.find((x) => x.n === 4).paths, ['.github/workflows/backlog-intake.yml'], 'an address is not a path');
  assert.equal(b.find((x) => x.n === 5).paths.length, 0);
  assert.equal(b.find((x) => x.n === 1).touches, null);
});

test('pipeline: categories follow the lane templates, touches before mentions', async () => {
  const m = await load();
  const by = Object.fromEntries(P.backlogOf(STATE).map((it) => [it.n, m.categoryOf(it)]));
  assert.deepEqual(by, { 1: 'backend', 2: 'app', 3: 'backend', 4: 'ops', 5: 'unsorted', 6: 'backend', 7: 'app', 8: 'app' });
});

test('pipeline: overall and category percentages leave Eric\'s decisions out', async () => {
  const m = await load();
  const c = m.cockpit(base({ in_flight: { known: true, waiting: [3], claimed: [7] } }));
  assert.deepEqual(c.macro, { known: true, total: 7, done: 4, in_flight: 2, pct: 57 });
  const cat = Object.fromEntries(c.categories.rows.map((r) => [r.id, [r.done, r.total, r.pct]]));
  assert.deepEqual(cat, { backend: [1, 2, 50], app: [2, 3, 67], ops: [0, 1, 0] });
  assert.equal(c.categories.unsorted, 1);
  assert.deepEqual(c.categories.rows.map((r) => r.template), ['eng-backend@1', 'eng-app@4', 'eng-docs@1']);
});

test('pipeline: an empty or unreadable backlog is no percentage, never 0% or 100%', async () => {
  const m = await load();
  const empty = m.cockpit(base({ backlog: [] }));
  assert.equal(empty.macro.pct, null);
  assert.equal(empty.macro.total, 0);
  assert.ok(empty.categories.rows.every((r) => r.pct === null && r.total === 0));
  const none = m.cockpit(base({ backlog: null }));
  assert.equal(none.macro.known, false);
  assert.equal(none.macro.pct, null);
  assert.equal(none.node.counts.backlog, null);
  assert.equal(m.pct(0, 0), null);
  assert.equal(P.backlogOf('# no backlog here').length, 0);
});

test('pipeline: the stage working now, furthest from done first', async () => {
  const m = await load();
  assert.equal(m.nodeState(base()).state, 'idle');
  assert.equal(m.nodeState(base()).active, null);
  assert.equal(m.nodeState(base({ inbox: { known: true, by_status: { awaiting_authorization: 1 } } })).state, 'pm_groom');
  const merge = m.nodeState(base({ in_flight: { known: true, waiting: [3, 7], claimed: [] }, inbox: { known: true, by_status: { prepared: 2 } } }));
  assert.equal(merge.state, 'awaiting_merge');
  assert.equal(merge.active, 'merge');
  assert.equal(merge.counts.merge, 2);
  assert.equal(merge.counts.pm, 2);
  assert.equal(m.nodeState(base({ inbox: { known: true, by_status: { verifying: 1 } }, in_flight: { known: true, waiting: [3], claimed: [] } })).state, 'verifying');
  const build = m.nodeState(base({ in_flight: { known: true, waiting: [3], claimed: [7] } }));
  assert.equal(build.state, 'building');
  assert.equal(build.active, 'sandbox');
  assert.equal(build.remediating, false);
  const fix = m.nodeState(base({ agent_lane: { known: true, limit: 6, used: 2, building: 0, revising: 1 }, in_flight: { known: true, waiting: [], claimed: [7] } }));
  assert.equal(fix.state, 'remediating');
  assert.equal(fix.active, 'sandbox');
  assert.equal(fix.remediating, true);
  assert.equal(m.nodeState(base({ in_flight: { known: false, why: 'no git' } })).partial, true);
});

test('pipeline: builds today against the ceiling, and the pace in hours per item', async () => {
  const m = await load();
  assert.equal(m.buildsToday(base({ agent_lane: { known: true, limit: 6, used: 4 } })).words, '4 / 6 daily builds used');
  const unknown = m.buildsToday(base({ agent_lane: { known: false, limit: 6, why: 'No local copy of the agent ledger.' } }));
  assert.equal(unknown.known, false);
  assert.equal(unknown.used, null, 'unknown is never 0');
  assert.equal(m.pace(base({ pace: { known: true, days: 7, merged: 80 } })).words, 'Pace: ~2.1 hrs/item');
  assert.equal(m.pace(base()).words, 'Queue idle');
  assert.equal(m.pace(base({ in_flight: { known: true, waiting: [3], claimed: [] } })).words, 'No merges in 7 days');
  assert.equal(m.pace(base({ pace: { known: false, why: 'No git history in this copy.' } })).words, 'Pace unknown');
});

test('pipeline: a copy with no git says so in words and reads the backlog anyway', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pipeline-root-'));
  fs.writeFileSync(path.join(root, 'DESK_STATE.md'), STATE);
  const r = P.read(null, { root, now: new Date('2026-10-27T12:00:00Z') });
  assert.equal(r.format, 'cr-pipeline@1');
  assert.equal(r.writes_nothing, true);
  assert.equal(r.backlog.length, 8);
  assert.equal(r.in_flight.known, false);
  assert.ok(r.in_flight.why);
  assert.equal(r.agent_lane.known, false);
  assert.equal(r.pace.known, false);
  assert.equal(r.inbox.known, false);
});

test('pipeline: reading a workspace writes nothing', (t) => {
  const s = tempWorkspace('pipeline');
  t.after(s.cleanup);
  const before = hashTree(s.root);
  const r = P.read(s.ws);
  assert.equal(r.inbox.known, true, 'the inbox read as Eric');
  assert.deepEqual(hashTree(s.root), before);
});

test('pipeline: GET /api/pipeline answers behind the session', async (t) => {
  const s = tempWorkspace('pipeline-route');
  const { start } = require('../server');
  const srv = await start(s.ws, { port: 47990 + Math.floor(Math.random() * 9), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } s.cleanup(); });
  const get = (p, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: srv.port, path: p, headers: { host: `127.0.0.1:${srv.port}`, ...headers } }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(Buffer.concat(c).toString()); } catch (_) { return null; } })() }));
    }).on('error', reject);
  });
  assert.notEqual((await get('/api/pipeline')).status, 200, 'not without the token');
  const token = (await get('/api/session')).json.token;
  const r = await get('/api/pipeline', { 'x-cr-token': token });
  assert.equal(r.status, 200);
  assert.equal(r.json.format, 'cr-pipeline@1');
  assert.ok(Array.isArray(r.json.backlog) && r.json.backlog.length > 0, 'the repository backlog');
});
