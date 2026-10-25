'use strict';
// The weekly digest (backlog item 34, tickets.js digest): the last N days of
// the pilot in numbers from stored records only, deterministic, nothing
// written, an unreadable part said and never counted as zero. FICTIONAL
// workspaces only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tempWorkspace, importAllFixtures } = require('./helpers');
const T = require('../core/tickets');

function setup(t) {
  const w = tempWorkspace('ticket-digest');
  t.after(w.cleanup);
  const P = require('../core/projects');
  const pid = P.addProject(w.ws, { name: 'Example PayFi (FICTIONAL)', symbol: 'XMPL', official_website: 'https://example.com/xmpl', coingecko_id: 'example-payfi-fictional', assets: [{ chain: 'base', contract_address: '0x3333333333333333333333333333333333333333' }], evidence: [{ url: 'https://example.com/xmpl', note: 'fictional' }], sector_profile: 'payfi-credit@1' }).project_id;
  importAllFixtures(w.ws);
  return { ...w, pid };
}

// A hash of every file under the workspace: a read must leave it unchanged.
function treeHash(root) {
  const h = crypto.createHash('sha256');
  const walk = (d) => {
    for (const f of fs.readdirSync(d).sort()) {
      const p = path.join(d, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else h.update(`${path.relative(root, p)}\0`).update(fs.readFileSync(p));
    }
  };
  walk(root);
  return h.digest('hex');
}

test('the digest has every section, is deterministic for one `now`, and writes nothing', (t) => {
  const s = setup(t);
  const before = treeHash(s.ws.root);
  const now = Date.now();
  const a = T.digest(s.ws, { now });
  const b = T.digest(s.ws, { now });
  assert.deepEqual(a, b);
  assert.equal(treeHash(s.ws.root), before, 'a read writes nothing');
  assert.equal(a.format, 'cr-ticket-digest@1');
  assert.equal(a.days, 7);
  for (const k of ['reports_v6', 'tickets', 'grade_spreads', 'invalidations', 'provider_budget']) assert.ok(['ok', 'unreadable'].includes(a[k].status), k);
  assert.equal(a.reports_v6.status, 'ok');
  assert.equal(a.until, new Date(now).toISOString());
  assert.equal(a.since, new Date(now - 7 * 86400000).toISOString());
  assert.equal(a.grade_spreads.bands.length, 4);
  assert.equal(a.grade_spreads.pairs_compared, a.grade_spreads.bands.reduce((x, y) => x + y.pairs, 0));
});

test('reports are counted only inside the window, by model and prompt', (t) => {
  const s = setup(t);
  const now = Date.now();
  const all = T.digest(s.ws, { now, days: 366 });
  const none = T.digest(s.ws, { now: now - 400 * 86400000, days: 1 });
  const inRange = all.reports_v6.completed;
  assert.equal(Object.values(all.reports_v6.by_model).reduce((x, y) => x + y, 0), inRange);
  assert.ok(all.reports_v6.eligible <= inRange);
  assert.equal(none.reports_v6.completed, 0, 'a window before any record holds none');
});

test('a section that cannot be read is said, never zero', (t) => {
  const s = setup(t);
  const research = require('../core/research');
  const real = research.allCharges;
  research.allCharges = () => { throw new Error('spend ledger unreadable'); };
  t.after(() => { research.allCharges = real; });
  const d = T.digest(s.ws);
  assert.equal(d.provider_budget.status, 'unreadable');
  assert.match(d.provider_budget.why, /spend ledger unreadable/);
  assert.equal(d.provider_budget.total_usd, undefined, 'no figure is invented');
  assert.match(T.digestText(d), /Provider budget: unreadable\. Could not be read: spend ledger unreadable/);
  assert.equal(d.reports_v6.status, 'ok', 'the other sections stand');
});

test('provider budget sums the window by provider and says undated charges are not counted', (t) => {
  const s = setup(t);
  const research = require('../core/research');
  const real = research.allCharges;
  const now = Date.parse('2026-10-25T12:00:00Z');
  research.allCharges = () => [
    { provider: 'claude', at: '2026-10-24T10:00:00Z', usd: 1.5, basis: 'actual' },
    { provider: 'claude', at: '2026-10-20T10:00:00Z', usd: 0.5, basis: 'estimated' },
    { provider: 'chatgpt', at: '2026-10-01T10:00:00Z', usd: 9, basis: 'actual' },
    { provider: 'chatgpt', at: null, usd: 2, basis: 'reserved' },
  ];
  t.after(() => { research.allCharges = real; });
  const b = T.digest(s.ws, { now }).provider_budget;
  assert.equal(b.total_usd, 2);
  assert.equal(b.calls, 2);
  assert.deepEqual(b.by_provider, { claude: { calls: 2, usd: 2 } });
  assert.equal(b.estimated_or_open_calls, 1);
  assert.equal(b.undated_not_counted, 1);
});

test('days are bounded, and the text form names each section', (t) => {
  const s = setup(t);
  assert.throws(() => T.digest(s.ws, { days: 0 }), /days must be/);
  assert.throws(() => T.digest(s.ws, { days: 'x' }), /days must be/);
  const text = T.digestText(T.digest(s.ws));
  for (const w of ['Digest, last 7 days', 'reports completed', 'Prosecutor tickets', 'Grade spreads between models', 'Invalidation triggers fired', 'Provider budget used']) assert.ok(text.includes(w), w);
});

test('@6 reports and model grade spreads are counted from stored reports inside the window', (t) => {
  const s = setup(t);
  const reports = require('../core/reports');
  const rubrics = require('../core/rubrics');
  const realLoad = reports.loadReports;
  const realGrade = rubrics.gradeAssessment;
  const now = Date.parse('2026-10-25T12:00:00Z');
  const mk = (id, provider, at, grade, over = {}) => ({ report_id: id, meta: { provider, imported_at: at }, assessment: { prompt_version: 'cr-research-prompt@6', rubric_version: 'cr-grading@1', sector_profile: 'p@2', analysis_at: at, _grade: grade, ...over } });
  const firm = (v) => ({ status: 'firm', value: v, low: null, high: null, display: String(v) });
  reports.loadReports = (ws, pid) => (pid === s.pid ? [
    mk('r1', 'claude', '2026-10-24T09:00:00Z', firm(70)),
    mk('r2', 'chatgpt', '2026-10-24T10:00:00Z', firm(52)),
    mk('r3', 'claude', '2026-09-01T09:00:00Z', firm(60), { prompt_version: 'cr-research-prompt@5' }),
    mk('r4', 'gemini', '2026-10-24T11:00:00Z', { status: 'withheld' }),
    mk('r5', 'chatgpt', null, firm(50)),
  ] : realLoad(ws, pid));
  rubrics.gradeAssessment = (ws, a) => a._grade;
  t.after(() => { reports.loadReports = realLoad; rubrics.gradeAssessment = realGrade; });
  const d = T.digest(s.ws, { now });
  assert.equal(d.reports_v6.completed, 3, 'r1, r2 and r4: @6 and saved in the window');
  assert.deepEqual(d.reports_v6.by_model, { claude: 1, chatgpt: 1, gemini: 1 });
  assert.equal(d.reports_v6.undated_not_counted, 1, 'r5 has no save time');
  const band = (id) => d.grade_spreads.bands.find((b) => b.id === id).pairs;
  assert.equal(band('15_to_30'), 1, 'Claude 70 and ChatGPT 52 differ by 18');
  assert.equal(d.grade_spreads.pairs_compared, 1);
  assert.equal(d.grade_spreads.not_compared, 1, 'the withheld Gemini grade is not compared, and not a zero gap');
  assert.deepEqual(d.grade_spreads.largest.map((x) => [x.other, x.gap]), [['chatgpt', 18]]);
});

test('the CLI prints the digest as text and as JSON', async (t) => {
  const s = setup(t);
  const { spawnSync } = require('child_process');
  const cli = path.join(__dirname, '..', 'cli.js');
  const run = (...a) => spawnSync(process.execPath, [cli, ...a, '--workspace', s.ws.root], { encoding: 'utf8' });
  const text = run('tickets', 'digest');
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Digest, last 7 days/);
  const json = run('tickets', 'digest', '--days', '30', '--json');
  assert.equal(JSON.parse(json.stdout).days, 30);
});
