'use strict';
// The Research Explorer (core/explorer.js, core/explorer-adapter.js,
// GET /api/explorer, views/explorer.js), against a local stand-in for
// Supabase's REST API in temporary TEST workspaces. No real Supabase project
// and no real key: the stand-in checks the key the desk sends and answers the
// way PostgREST does. The database's own rules (constraints, grants, RLS,
// immutability, the import function) are in supabase/migrations and were
// checked against the live project; here the desk's side is tested:
// - the adapter keeps every score's meaning (point, range, unknown, N/A; 0 is
//   a number), only category grades become category rows, revisions stay
//   separate, the grade is the desk's own;
// - the key never reaches the page, a log line, an error or the URL;
// - every route checks the desk's own sign-in and token itself;
// - Supabase down, slow or refusing leaves the rest of the desk working;
// - opening the Explorer writes nothing and starts no research.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');
const { tempWorkspace, hashTree, addFixtureProject, importAllFixtures } = require('./helpers');
const { atomicWrite, jsonText, readJson } = require('../core/fsx');
const adapter = require('../core/explorer-adapter');
const explorer = require('../core/explorer');

const KEY = 'sb_secret_TESTONLY_not_a_real_key_0123456789';
// A hanging stand-in gives up after a second here, not the 8 seconds a page waits.
process.env.CR_EXPLORER_READ_TIMEOUT_MS = '1000';

// ---- a stand-in for Supabase's REST API -------------------------------------

// Pages the way PostgREST does: the Range header asks for rows from-to, the
// server never answers more than its own row cap (maxRows), and with
// "Prefer: count=exact" Content-Range states the rows sent and the total.
// lie adds rows to the stated total that are never sent; repeat answers the
// first rows again under the range asked for (a server whose order is not
// stable).
function paged(st, req, list) {
  const r = /^(\d+)-(\d+)$/.exec(String(req.headers.range || ''));
  const from = r ? Number(r[1]) : 0;
  const to = r ? Number(r[2]) : list.length - 1;
  const end = Math.min(to, from + st.maxRows - 1, list.length - 1);
  const src = st.repeat ? 0 : from;
  const rows = from < list.length ? list.slice(src, src + end - from + 1) : [];
  const total = list.length + (st.lie || 0);
  return { rows, contentRange: rows.length ? `${from}-${from + rows.length - 1}/${total}` : `*/${total}` };
}

function standIn() {
  const st = { requests: [], projects: new Map(), reports: new Map(), texts: new Map(), exports: [], fail: null, maxRows: Infinity, lie: 0, repeat: false, hook: null };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      st.requests.push({ method: req.method, url: req.url, headers: { ...req.headers }, body });
      const send = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (st.fail === 'hang') return;
      if (st.fail === 500) return send(500, { message: 'stand-in failure', code: 'XX000' });
      if (req.headers.apikey !== KEY) return send(401, { message: 'Invalid API key' });
      const u = new URL(req.url, 'http://stand-in');
      if (req.method === 'POST' && u.pathname === '/rest/v1/rpc/explorer_import') {
        const { batch } = JSON.parse(body);
        for (const p of batch.projects) st.projects.set(p.project_id, { ...p, dataset: batch.dataset, updated_at: '2026-10-06T00:00:00Z' });
        const results = batch.reports.map((r) => {
          const text = JSON.stringify(r);
          const prev = st.texts.get(r.report_id);
          if (prev === undefined) {
            st.texts.set(r.report_id, text);
            st.reports.set(r.report_id, { ...r, dataset: batch.dataset, exported_at: new Date().toISOString(), evidence_checked_at: new Date().toISOString() });
            return { report_id: r.report_id, status: 'inserted', scores: r.category_scores.length };
          }
          return prev === text ? { report_id: r.report_id, status: 'unchanged' } : { report_id: r.report_id, status: 'conflict', stored_sha256: 'a'.repeat(64), new_sha256: 'b'.repeat(64) };
        });
        const count = (s) => results.filter((x) => x.status === s).length;
        const run = { export_id: `exp-${st.exports.length + 1}`, dataset: batch.dataset, source: batch.source, adapter_version: batch.adapter_version, started_at: new Date().toISOString(), finished_at: new Date().toISOString(), reports_inserted: count('inserted'), reports_unchanged: count('unchanged'), reports_refused: count('conflict') };
        st.exports.push(run);
        return send(200, { export_id: run.export_id, dataset: batch.dataset, finished_at: run.finished_at, projects: { inserted: batch.projects.length, updated: 0, unchanged: 0 }, reports: { inserted: count('inserted'), unchanged: count('unchanged'), evidence_updated: 0, refused: count('conflict') }, scores_inserted: results.reduce((n, x) => n + (x.scores || 0), 0), results });
      }
      // A paged read (Range header), filtered or whole, in the order the
      // server asks for (each ends with the table's key): what read() and
      // compareData ask for. hook runs before each answer (a test can change
      // the tables mid-read).
      if (req.method === 'GET' && req.headers.range) {
        if (st.hook) st.hook(u, st);
        const eq = (k) => { const v = u.searchParams.get(k); return v && v.startsWith('eq.') ? v.slice(3) : null; };
        const order = u.searchParams.get('order');
        let list;
        if (u.pathname === '/rest/v1/projects') {
          assert.ok(['name.asc,project_id.asc', 'project_id.asc'].includes(order), `projects in a unique order (${order})`);
          list = [...st.projects.values()].filter((p) => !eq('project_id') || p.project_id === eq('project_id')).sort((a, b) => (order === 'project_id.asc' ? 0 : a.name.localeCompare(b.name)) || a.project_id.localeCompare(b.project_id));
        } else if (u.pathname === '/rest/v1/reports') {
          assert.equal(order, 'saved_at.desc,report_id.asc', 'reports in a unique order');
          list = [...st.reports.values()].filter((r) => !eq('project_id') || r.project_id === eq('project_id')).sort((a, b) => b.saved_at.localeCompare(a.saved_at) || a.report_id.localeCompare(b.report_id)).map(({ category_scores: _c, ...r }) => r);
        } else if (u.pathname === '/rest/v1/category_scores') {
          assert.equal(order, 'report_id.asc,category_id.asc', 'grades in a unique order');
          const filter = u.searchParams.get('report_id');
          const ids = filter ? (/^in\.\((.*)\)$/.exec(filter) || [null, ''])[1].split(',').map((x) => x.replace(/^"|"$/g, '')).filter(Boolean) : null;
          list = [...st.reports.values()].filter((r) => !ids || ids.includes(r.report_id)).flatMap((r) => r.category_scores.map((s) => ({ report_id: r.report_id, ...s })))
            .sort((a, b) => a.report_id.localeCompare(b.report_id) || a.category_id.localeCompare(b.category_id));
        } else return send(404, { message: 'no such route' });
        const p = paged(st, req, list);
        res.writeHead(200, { 'content-type': 'application/json', 'content-range': p.contentRange });
        return res.end(JSON.stringify(p.rows));
      }
      if (req.method === 'GET' && u.pathname === '/rest/v1/projects') return send(200, [...st.projects.values()]);
      if (req.method === 'GET' && u.pathname === '/rest/v1/reports') return send(200, [...st.reports.values()].sort((a, b) => b.saved_at.localeCompare(a.saved_at)));
      if (req.method === 'GET' && u.pathname === '/rest/v1/export_runs') return send(200, st.exports.slice(-1).reverse());
      return send(404, { message: 'no such route' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ st, server, url: `http://127.0.0.1:${server.address().port}` })));
}

function explorerWorkspace(label, url, extra = {}) {
  const t = tempWorkspace(label, { explorer: { supabase_url: url, ...extra } });
  return t;
}

function withKey(t, key = KEY) {
  const prev = process.env.CR_SUPABASE_SECRET_KEY;
  process.env.CR_SUPABASE_SECRET_KEY = key;
  t.after(() => {
    if (prev === undefined) delete process.env.CR_SUPABASE_SECRET_KEY;
    else process.env.CR_SUPABASE_SECRET_KEY = prev;
  });
}

function request(port, { method = 'GET', path: p = '/', headers = {}, host = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: host || `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.end();
  });
}

// ---- the adapter: meaning kept ----------------------------------------------

test('adapter: the fictional fixtures become 6 projects, 13 reports and 167 category grades, byte for byte the same each time', () => {
  const { ws, cleanup } = tempWorkspace('xp-adapter');
  try {
    const a = adapter.buildBatch(ws, adapter.loadFixtures(), { dataset: 'demo', source: adapter.FIXTURE_REL });
    const b = adapter.buildBatch(ws, adapter.loadFixtures(), { dataset: 'demo', source: adapter.FIXTURE_REL });
    assert.equal(JSON.stringify(a.batch), JSON.stringify(b.batch), 'the same records give the same batch, so a repeat is "unchanged"');
    assert.deepEqual(a.skipped, []);
    assert.equal(a.batch.dataset, 'demo');
    assert.equal(a.batch.projects.length, 6);
    assert.equal(a.batch.reports.length, 13);
    assert.equal(a.batch.reports.reduce((n, r) => n + r.category_scores.length, 0), 167);
    assert.ok(a.batch.projects.every((p) => /\(FICTIONAL\)$/.test(p.name)));
    // Oldest save first, so an original is stored before its revision.
    const ids = a.batch.reports.map((r) => r.report_id);
    assert.ok(ids.indexOf('2026-09-28_claude_demo0003') < ids.indexOf('2026-09-28_claude_demo0004'));
  } finally {
    cleanup();
  }
});

test('adapter: a point, a range, unknown and N/A keep their meaning; unknown never carries a number', () => {
  const { ws, cleanup } = tempWorkspace('xp-meaning');
  try {
    const { batch } = adapter.buildBatch(ws, adapter.loadFixtures(), { dataset: 'demo', source: adapter.FIXTURE_REL });
    const all = batch.reports.flatMap((r) => r.category_scores);
    for (const s of all) {
      if (s.status === 'scored') assert.ok(typeof s.score === 'number' && s.score_low === null && s.score_high === null, `${s.category_id} point`);
      else if (s.status === 'range') assert.ok(s.score === null && s.score_low <= s.score_high, `${s.category_id} range`);
      else assert.ok(s.score === null && s.score_low === null && s.score_high === null, `${s.category_id} ${s.status} has no number`);
      if (s.status !== 'scored' && s.status !== 'range') assert.equal(s.confidence, null);
    }
    const counts = Object.fromEntries(['scored', 'range', 'unknown', 'not_applicable'].map((k) => [k, all.filter((s) => s.status === k).length]));
    assert.deepEqual(counts, { scored: 132, range: 16, unknown: 16, not_applicable: 3 });
    const r2 = batch.reports.find((r) => r.report_id === '2026-10-03_chatgpt_demo0002');
    const code = r2.category_scores.find((s) => s.category_id === 'code_quality');
    assert.equal(code.status, 'unknown');
    assert.match(code.unknown_reason, /repository is private/);
    const legit = r2.category_scores.find((s) => s.category_id === 'legitimacy');
    assert.deepEqual([legit.status, legit.score, legit.score_low, legit.score_high], ['range', null, 70, 80], 'a range stays its two ends, never a midpoint');
  } finally {
    cleanup();
  }
});

test('adapter: category grades only, never the six weighted components; each model keeps its own grade', () => {
  const { ws, cleanup } = tempWorkspace('xp-separate');
  try {
    const { batch } = adapter.buildBatch(ws, adapter.loadFixtures(), { dataset: 'demo', source: adapter.FIXTURE_REL });
    const components = ['sustainable_business_demand', 'valuation_supply', 'risk_resilience', 'btc_relative_asymmetry', 'timing_executable_liquidity'];
    for (const r of batch.reports) for (const s of r.category_scores) assert.ok(!components.includes(s.category_id), `${s.category_id} is a weighted component`);
    // token_value_capture is both a category and a component: the row is the category grade.
    const r1 = batch.reports.find((r) => r.report_id === '2026-10-02_claude_demo0001');
    assert.equal(r1.category_scores.find((s) => s.category_id === 'token_value_capture').score, 54, 'the category grade (54), not the component (58)');
    assert.equal(r1.category_scores.length, 13, 'payfi-credit@2 lists 13 categories');
    const gemini = batch.reports.find((r) => r.model === 'gemini');
    assert.equal(gemini.category_scores.length, 12, 'network-infrastructure@1 lists its own categories');
    assert.equal(gemini.profile_version, 'network-infrastructure@1');
    // Grades: the desk's calculation from the components, per report.
    assert.deepEqual([r1.grade_status, r1.grade_value, r1.grade_coverage_pct], ['firm', 57.65, 100]);
    const range = batch.reports.find((r) => r.report_id === '2026-09-28_claude_demo0003');
    assert.deepEqual([range.grade_status, range.grade_value, range.grade_low, range.grade_high], ['range', null, 63.8, 65.4]);
    const withheld = batch.reports.find((r) => r.report_id === '2026-10-03_chatgpt_demo0002');
    assert.deepEqual([withheld.grade_status, withheld.grade_value, withheld.grade_coverage_pct], ['withheld', null, 80]);
    assert.deepEqual(withheld.grade_unscored, ['BTC-relative asymmetry', 'Timing and executable liquidity']);
    assert.ok(!('model_reported_overall_score' in withheld) && !Object.keys(batch).includes('consensus'), 'no model total and nothing combined across models');
  } finally {
    cleanup();
  }
});

test('adapter: a revision stays its own report, names the one it revises, and says why', () => {
  const { ws, cleanup } = tempWorkspace('xp-revision');
  try {
    const { batch } = adapter.buildBatch(ws, adapter.loadFixtures(), { dataset: 'demo', source: adapter.FIXTURE_REL });
    const first = batch.reports.find((r) => r.report_id === '2026-09-28_claude_demo0003');
    const rev = batch.reports.find((r) => r.report_id === '2026-09-28_claude_demo0004');
    assert.equal(first.revision_of, null);
    assert.deepEqual([rev.revision_of, rev.revision_kind, rev.revision_basis], ['2026-09-28_claude_demo0003', 'reassessment', 'existing_evidence']);
    assert.match(rev.revision_note, /narrows to a point/);
    // The original keeps its range; the revision has its own point.
    assert.equal(first.category_scores.find((s) => s.category_id === 'btc_relative_opportunity').status, 'range');
    assert.equal(rev.category_scores.find((s) => s.category_id === 'btc_relative_opportunity').score, 52);
    assert.equal(first.grade_status, 'range');
    assert.equal(rev.grade_status, 'firm');
  } finally {
    cleanup();
  }
});

test('adapter: the desk\'s evidence checks go along as flags and change no score', () => {
  const { ws, cleanup } = tempWorkspace('xp-flags');
  try {
    const { batch } = adapter.buildBatch(ws, adapter.loadFixtures(), { dataset: 'demo', source: adapter.FIXTURE_REL });
    const r7 = batch.reports.find((r) => r.report_id === '2026-10-05_chatgpt_demo0007');
    const code = r7.category_scores.find((s) => s.category_id === 'code_quality');
    assert.equal(code.score, 40, 'the score as written');
    assert.deepEqual(code.evidence_flags.map((f) => [f.rule, f.severity]), [['code_score_without_source', 'high']]);
    assert.equal(r7.evidence_high, 1);
    const r3 = batch.reports.find((r) => r.report_id === '2026-09-28_claude_demo0003');
    assert.ok(r3.category_scores.every((s) => !s.evidence_flags.length));
    assert.match(r3.evidence_summary, /No inconsistencies detected by these checks/);
    assert.match(r3.evidence_summary, /Coverage is partial/, 'a clean result states its coverage');
  } finally {
    cleanup();
  }
});

test('adapter: zero is a number, a malformed grade is refused (never mended), identities carry contracts only when verified', () => {
  const { ws, cleanup } = tempWorkspace('xp-shapes');
  try {
    const profile = ws.rubrics.profiles['general-token@2'];
    const ev = { flags: [] };
    const zero = adapter.categoryRows({ diagnostic_scores: { legitimacy: { status: 'scored', value: 0, low: null, high: null, evidence_refs: [] } } }, profile, ev);
    assert.deepEqual([zero[0].status, zero[0].score], ['scored', 0], '0 stays a scored 0, not unknown');
    assert.throws(() => adapter.categoryRows({ diagnostic_scores: { legitimacy: { status: 'unknown', value: 0, low: null, high: null } } }, profile, ev), /must carry no number/);
    assert.throws(() => adapter.categoryRows({ diagnostic_scores: { legitimacy: { status: 'range', value: null, low: 70, high: 60 } } }, profile, ev), /low not above high/);
    assert.throws(() => adapter.categoryRows({ diagnostic_scores: { legitimacy: { status: 'scored', value: 101 } } }, profile, ev), /0 to 100/);
    // A report whose grade breaks the rules is left out with the reason; the others go.
    const bad = adapter.loadFixtures();
    bad[0].reports[0].assessment.diagnostic_scores.legitimacy = { status: 'unknown', value: 12, low: null, high: null, rationale: null, evidence_refs: [], missing_data: 'x' };
    const out = adapter.buildBatch(ws, bad, { dataset: 'demo', source: 'test' });
    assert.equal(out.batch.reports.length, 12, 'the other 12 fixture reports still go');
    assert.equal(out.skipped.length, 1);
    assert.match(out.skipped[0].reason, /must carry no number/);
    // Identities.
    assert.deepEqual(adapter.projectRow({ project_id: 'p', name: 'P', symbol: 'P', identity: { status: 'pending', assets: [{ chain: 'x', contract_address: 'C' }] } }), { project_id: 'p', name: 'P', ticker: 'P', identity_status: 'pending', chain: null, contract_address: null, native_chain: false });
    assert.equal(adapter.projectRow({ project_id: 'p', name: 'P', identity: { status: 'verified', assets: [{ chain: 'x', contract_address: 'C' }] } }).contract_address, 'C');
    assert.deepEqual(adapter.projectRow({ project_id: 'p', name: 'P', identity: { status: 'verified', native_chain: true, assets: [{ chain: 'l1', contract_address: null }] } }).native_chain, true);
    // The fixture loader reads only fictional files.
    const tmp = path.join(os.tmpdir(), `cr-xp-notfictional-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify({ schema_version: 'cr.explorer-fixtures.v1', fictional: false, projects: [] }));
    assert.throws(() => adapter.loadFixtures(tmp), /Not a fictional/);
    fs.rmSync(tmp, { force: true });
  } finally {
    cleanup();
  }
});

test('adapter: real desk records can be read (prepared) but no command exports them', async () => {
  const { ws, cleanup } = tempWorkspace('xp-desk');
  try {
    addFixtureProject(ws);
    importAllFixtures(ws);
    const { batch } = adapter.buildBatch(ws, adapter.deskSources(ws), { dataset: 'desk', source: 'test workspace' });
    assert.equal(batch.projects.length, 1);
    assert.ok(batch.reports.length >= 1);
    assert.ok(batch.reports.every((r) => r.category_scores.every((s) => ['scored', 'range', 'unknown', 'not_applicable'].includes(s.status))));
    assert.throws(() => explorer.exportDesk(), /prepared but not enabled/);
    const cli = require('../cli');
    await assert.rejects(cli.run(['explorer', 'export', '--desk', '--workspace', ws.root]), /prepared but not enabled/);
  } finally {
    cleanup();
  }
});

test('export --project (the canary): one real project previewed as the exact request body with its hashes; no network, nothing written; sending stays refused', async (t) => {
  const { ws, root, cleanup } = tempWorkspace('xp-canary');
  t.after(cleanup);
  addFixtureProject(ws);
  importAllFixtures(ws);
  const pid = 'example-payfi-fictional';
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('a dry run makes no network call');
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const sha = (s) => require('crypto').createHash('sha256').update(s, 'utf8').digest('hex');
  const before = hashTree(path.join(root, 'projects'));
  const a = explorer.exportProject(ws, pid, { dryRun: true });
  const b = explorer.exportProject(ws, pid, { dryRun: true });
  assert.deepEqual([a.status, a.sent, a.network, a.dataset, a.project_id], ['dry_run', false, 'none', 'desk', pid]);
  assert.equal(JSON.stringify(a.batch), JSON.stringify(b.batch), 'the same records give the same payload');
  assert.equal(a.request.body_sha256, sha(JSON.stringify({ batch: a.batch })), 'the hash is of the exact request body');
  assert.equal(a.request.body_bytes, Buffer.byteLength(JSON.stringify({ batch: a.batch })));
  assert.equal(a.request.path, '/rest/v1/rpc/explorer_import');
  assert.deepEqual(a.batch.projects.map((p) => p.project_id), [pid], 'one project only');
  assert.equal(a.batch.dataset, 'desk');
  assert.equal(a.batch.source, `desk:projects/${pid}`);
  assert.ok(a.batch.reports.length >= 1 && a.batch.reports.every((r) => r.project_id === pid));
  assert.equal(a.reports, a.batch.reports.length);
  assert.equal(a.hashes.length, a.batch.reports.length);
  for (const [i, h] of a.hashes.entries()) assert.equal(h.row_sha256, sha(JSON.stringify(a.batch.reports[i])));
  assert.ok(a.batch.reports.flatMap((r) => r.category_scores).every((s) => ['scored', 'range', 'unknown', 'not_applicable'].includes(s.status)));
  // Sending real records stays refused; refused requests send nothing either.
  assert.throws(() => explorer.exportProject(ws, pid), /not enabled\. Nothing was sent/);
  assert.equal(calls, 0, 'no network call at all');
  assert.deepEqual(hashTree(path.join(root, 'projects')), before, 'nothing written');
  // Through the CLI, as Eric runs it.
  const cli = require('../cli');
  const out = await cli.run(['explorer', 'export', '--project', pid, '--dry-run', '--workspace', root]);
  assert.equal(out.request.body_sha256, a.request.body_sha256);
  await assert.rejects(cli.run(['explorer', 'export', '--project', pid, '--workspace', root]), /not enabled/);
  await assert.rejects(cli.run(['explorer', 'export', '--project', '--dry-run', '--workspace', root]), /--project needs a project ID/);
  await assert.rejects(cli.run(['explorer', 'export', '--project', pid, '--fixtures', '--dry-run', '--workspace', root]), /Choose one of/);
  await assert.rejects(cli.run(['explorer', 'export', '--project', 'no-such-project', '--dry-run', '--workspace', root]), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(cli.run(['explorer', 'export', '--project', 'Not An ID!', '--dry-run', '--workspace', root]), (e) => e.code === 'BAD_ID');
  // Bulk export of every project stays off; the fixtures still work as before.
  await assert.rejects(cli.run(['explorer', 'export', '--desk', '--workspace', root]), /prepared but not enabled/);
  const fx = await cli.run(['explorer', 'export', '--fixtures', '--dry-run', '--workspace', root]);
  assert.deepEqual([fx.status, fx.dataset, fx.reports], ['dry_run', 'demo', 13]);
  // An archived project is not exported.
  require('../core/projects').archiveProject(ws, pid, 'test');
  assert.throws(() => explorer.exportProject(ws, pid, { dryRun: true }), (e) => e.code === 'REFUSED');
  assert.equal(calls, 0);
});

// ---- configuration and the key ----------------------------------------------

test('config: the key never leaves the server; publishable keys, odd URLs and the off switch are said plainly', (t) => {
  const { ws, cleanup } = explorerWorkspace('xp-config', 'http://127.0.0.1:9');
  t.after(cleanup);
  const st = explorer.status(ws, { CR_SUPABASE_SECRET_KEY: KEY });
  assert.equal(st.state, 'configured');
  assert.equal(st.key_kind, 'secret');
  assert.ok(!JSON.stringify(st).includes(KEY), 'status never carries the key');
  assert.ok(!('_key' in st));
  assert.equal(explorer.status(ws, {}).state, 'not_configured', 'a test workspace never reads the real secrets file');
  const pub = explorer.status(ws, { CR_SUPABASE_SECRET_KEY: 'sb_publishable_abc' });
  assert.equal(pub.state, 'not_configured');
  assert.match(pub.problems[0], /publishable/);
  const anonJwt = `x.${Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url')}.y`;
  assert.match(explorer.status(ws, { CR_SUPABASE_SECRET_KEY: anonJwt }).problems[0], /publishable/);
  assert.equal(explorer.keyKind(`x.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.y`), 'service_role_jwt');
  assert.match(explorer.status(ws, { CR_SUPABASE_SECRET_KEY: KEY, CR_SUPABASE_URL: 'https://evil.example.com' }).problems[0], /project address/);
  assert.equal(explorer.status(ws, { CR_SUPABASE_SECRET_KEY: KEY, CR_EXPLORER: 'off' }).state, 'off');
  assert.ok(explorer.URL_RE.test('https://oflelsyzifreqntfncrm.supabase.co'));
  assert.ok(!explorer.URL_RE.test('https://oflelsyzifreqntfncrm.supabase.co.evil.com'));
  assert.ok(!explorer.URL_RE.test('http://oflelsyzifreqntfncrm.supabase.co'));
});

// ---- export and read through the client --------------------------------------

test('export: one call per run; a repeat is all "unchanged"; changed content under a known ID is a conflict; reads send the key only in its header', async (t) => {
  const si = await standIn();
  t.after(() => si.server.close());
  const { ws, cleanup } = explorerWorkspace('xp-export', si.url);
  t.after(cleanup);
  explorer.resetMemory();
  const env = { CR_SUPABASE_SECRET_KEY: KEY };
  const first = await explorer.exportFixtures(ws, { env });
  assert.equal(first.status, 'exported');
  assert.equal(first.reports.inserted, 13);
  assert.equal(first.scores_inserted, 167);
  const second = await explorer.exportFixtures(ws, { env });
  assert.equal(second.status, 'exported');
  assert.deepEqual([second.reports.inserted, second.reports.unchanged], [0, 13], 'running it twice duplicates nothing');
  const posts = si.st.requests.filter((r) => r.method === 'POST');
  assert.equal(posts.length, 2, 'one request per export: one database transaction');
  for (const r of si.st.requests) {
    assert.equal(r.headers.apikey, KEY);
    assert.equal(r.headers.authorization, undefined, 'a secret key goes in apikey only');
    assert.ok(!r.url.includes(KEY), 'never in the URL');
  }
  // A changed report under the same ID is refused, never overwritten.
  const changed = adapter.loadFixtures();
  changed[0].reports[0].assessment.diagnostic_scores.legitimacy.value = 79;
  const orig = adapter.loadFixtures;
  adapter.loadFixtures = () => changed;
  try {
    const third = await explorer.exportFixtures(ws, { env });
    assert.equal(third.status, 'conflict');
    assert.equal(third.results.find((x) => x.report_id === '2026-10-02_claude_demo0001').status, 'conflict');
  } finally {
    adapter.loadFixtures = orig;
  }
  // The read: shaped rows, demo flagged, nulls kept as null.
  const data = await explorer.read(ws, { env, refresh: true });
  assert.equal(data.state, 'ok');
  assert.equal(data.demo, true);
  assert.equal(data.reports.length, 13);
  const unknown = data.reports.flatMap((r) => r.category_scores).filter((s) => s.status === 'unknown');
  assert.ok(unknown.length && unknown.every((s) => s.score === null && s.score_low === null), 'unknown is read back as null, never 0');
  assert.ok(!JSON.stringify(data).includes(KEY));
  const gets = si.st.requests.filter((r) => r.method === 'GET').map((r) => new URL(r.url, 'http://x').pathname).sort();
  assert.deepEqual(gets, ['/rest/v1/category_scores', '/rest/v1/export_runs', '/rest/v1/projects', '/rest/v1/reports'], 'four queries, one page each here; never a request per report or category');
  // Dry run: the batch, nothing sent.
  const before = si.st.requests.length;
  const dry = await explorer.exportFixtures(ws, { env, dryRun: true });
  assert.equal(dry.status, 'dry_run');
  assert.equal(si.st.requests.length, before);
});

test('read: Supabase down, slow or refusing is "unavailable" with the reason (and the last copy, labeled); a stale export is said', async (t) => {
  const si = await standIn();
  t.after(() => si.server.close());
  const { ws, cleanup } = explorerWorkspace('xp-fail', si.url);
  t.after(cleanup);
  explorer.resetMemory();
  const env = { CR_SUPABASE_SECRET_KEY: KEY };
  // Nothing exported yet.
  assert.equal((await explorer.read(ws, { env, refresh: true })).state, 'empty');
  await explorer.exportFixtures(ws, { env });
  const good = await explorer.read(ws, { env, refresh: true });
  assert.equal(good.state, 'ok');
  // Stale: the last export older than the limit.
  let clock = Date.now() + (explorer.STALE_DAYS + 1) * 86400000;
  explorer.resetMemory();
  const stale = await explorer.read(ws, { env, now: () => clock });
  assert.equal(stale.state, 'stale');
  assert.match(stale.reason, /days ago/);
  clock += 60000;
  // Failing: a server error with a copy in memory.
  si.st.fail = 500;
  const failed = await explorer.read(ws, { env, refresh: true, now: () => clock });
  assert.equal(failed.state, 'unavailable');
  assert.equal(failed.served, 'memory');
  assert.ok(failed.copy_fetched_at);
  assert.match(failed.reason, /500/);
  // Refused key, no copy.
  explorer.resetMemory();
  si.st.fail = null;
  const refused = await explorer.read(ws, { env: { CR_SUPABASE_SECRET_KEY: 'sb_secret_wrong_key_TESTONLY' }, refresh: true });
  assert.equal(refused.state, 'unavailable');
  assert.match(refused.reason, /401/);
  assert.ok(!refused.reason.includes('sb_secret_wrong_key_TESTONLY'));
  assert.deepEqual(refused.reports, []);
  // Nobody listening.
  const dead = explorerWorkspace('xp-dead', 'http://127.0.0.1:9');
  t.after(dead.cleanup);
  explorer.resetMemory();
  const down = await explorer.read(dead.ws, { env, refresh: true });
  assert.equal(down.state, 'unavailable');
  assert.match(down.reason, /could not be reached|did not answer/);
});

// ---- the endpoint: sign-in, token, failure isolation, no writes --------------

test('GET /api/explorer: refused without the token or cross-site, answers with it; never writes, never starts research; the key never reaches the page', async (t) => {
  const si = await standIn();
  t.after(() => si.server.close());
  const { ws, root, cleanup } = explorerWorkspace('xp-route', si.url);
  withKey(t);
  explorer.resetMemory();
  addFixtureProject(ws);
  await explorer.exportFixtures(ws);
  const { start } = require('../server');
  const port = 47600 + Math.floor(Math.random() * 300);
  const srv = await start(ws, { port, quiet: true });
  t.after(() => {
    try { srv.shutdown(); } catch (_) { /* stopped */ }
    cleanup();
  });
  const p = srv.port || port;
  const sess = await request(p, { path: '/api/session' });
  const s = JSON.parse(sess.text);
  assert.deepEqual(s.explorer, { state: 'configured', show: true });
  assert.ok(!sess.text.includes(KEY));
  // Direct requests without the desk's own checks are refused.
  assert.equal((await request(p, { path: '/api/explorer' })).status, 401, 'no token');
  assert.equal((await request(p, { path: '/api/explorer', headers: { 'x-cr-token': 'wrong' } })).status, 401, 'wrong token');
  assert.equal((await request(p, { path: '/api/explorer', headers: { 'x-cr-token': s.token, 'sec-fetch-site': 'cross-site' } })).status, 403, 'cross-site');
  assert.equal((await request(p, { path: '/api/explorer', headers: { 'x-cr-token': s.token }, host: 'evil.test' })).status, 403, 'another host name');
  assert.equal((await request(p, { method: 'DELETE', path: '/api/explorer', headers: { 'x-cr-token': s.token } })).status, 405);
  // With the token: the comparison data, nothing secret.
  const recordsBefore = hashTree(path.join(root, 'projects'));
  const configBefore = hashTree(path.join(root, 'config'));
  const supabaseBefore = si.st.requests.filter((r) => r.method !== 'GET').length;
  const ok = await request(p, { path: '/api/explorer?refresh=1', headers: { 'x-cr-token': s.token } });
  assert.equal(ok.status, 200);
  const body = JSON.parse(ok.text);
  assert.equal(body.state, 'ok');
  assert.equal(body.reports.length, 13);
  assert.equal(body.demo, true);
  assert.ok(!ok.text.includes(KEY), 'the key never reaches the page');
  assert.equal(ok.headers['cache-control'], 'no-store');
  // Second opinion's read: behind the same checks, one project, no key.
  const cmp = await request(p, { path: '/api/explorer/compare?project=demo-meridian-ledger', headers: { 'x-cr-token': s.token } });
  assert.equal(cmp.status, 200);
  const cmpBody = JSON.parse(cmp.text);
  assert.deepEqual([cmpBody.state, cmpBody.project.project_id, cmpBody.reports.length], ['ok', 'demo-meridian-ledger', 2]);
  assert.ok(!cmp.text.includes(KEY));
  assert.equal((await request(p, { path: '/api/explorer/compare?project=demo-meridian-ledger' })).status, 401, 'no token');
  assert.equal((await request(p, { path: '/api/explorer/compare?project=demo-meridian-ledger', headers: { 'x-cr-token': s.token, 'sec-fetch-site': 'cross-site' } })).status, 403, 'cross-site');
  assert.equal((await request(p, { path: '/api/explorer/compare?project=Not%20An%20ID', headers: { 'x-cr-token': s.token } })).status, 400, 'not a project ID');
  // Opening it wrote nothing on the desk and nothing to Supabase.
  assert.deepEqual(hashTree(path.join(root, 'projects')), recordsBefore);
  assert.deepEqual(hashTree(path.join(root, 'config')), configBefore);
  assert.equal(si.st.requests.filter((r) => r.method !== 'GET').length, supabaseBefore, 'a read sends no write to Supabase');
  const runs = fs.existsSync(path.join(root, 'projects')) ? fs.readdirSync(path.join(root, 'projects')).flatMap((id) => { const d = path.join(root, 'projects', id, 'research'); return fs.existsSync(d) ? fs.readdirSync(d) : []; }) : [];
  assert.deepEqual(runs, [], 'no research run started');
  // Supabase goes down: the Explorer says so; the rest of the desk answers.
  si.st.fail = 'hang';
  explorer.resetMemory();
  const slow = await request(p, { path: '/api/explorer?refresh=1', headers: { 'x-cr-token': s.token } });
  assert.equal(slow.status, 200);
  assert.equal(JSON.parse(slow.text).state, 'unavailable');
  const idx = await request(p, { path: '/api/index', headers: { 'x-cr-token': s.token } });
  assert.equal(idx.status, 200, 'the watchlist still loads');
  assert.equal(JSON.parse(idx.text).projects.length, 1);
  si.st.fail = null;
});

test('GET /api/explorer on the online desk: behind the passphrase sign-in and the token; hidden from the nav until set up', async (t) => {
  const si = await standIn();
  t.after(() => si.server.close());
  const { ws, cleanup } = explorerWorkspace('xp-hosted', si.url);
  withKey(t);
  explorer.resetMemory();
  await explorer.exportFixtures(ws);
  const { start } = require('../server');
  const freePort = await new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  const PASS = 'test-passphrase-not-real';
  const srv = await start(ws, { quiet: true, hosted: { port: freePort, hosts: ['desk.test'], password: PASS, bind: '127.0.0.1', failDelayMs: 0 } });
  t.after(() => {
    try { srv.shutdown(); } catch (_) { /* stopped */ }
    cleanup();
  });
  const call = (opts) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: freePort, method: opts.method || 'GET', path: opts.path, headers: { host: 'desk.test', ...(opts.headers || {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
  assert.equal((await call({ path: '/api/explorer' })).status, 401, 'signed out');
  const login = await call({ method: 'POST', path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://desk.test' }, body: `password=${encodeURIComponent(PASS)}` });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  assert.equal((await call({ path: '/api/explorer', headers: { cookie } })).status, 401, 'signed in but no token');
  const sess = JSON.parse((await call({ path: '/api/session', headers: { cookie } })).text);
  assert.deepEqual(sess.explorer, { state: 'configured', show: true });
  const ok = await call({ path: '/api/explorer', headers: { cookie, 'x-cr-token': sess.token } });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.text).reports.length, 13);
  assert.ok(!ok.text.includes(KEY));
  // Not set up there: no nav item on the online desk (on the PC it shows,
  // with its set-up state).
  const bare = tempWorkspace('xp-nav-bare');
  t.after(bare.cleanup);
  delete process.env.CR_SUPABASE_SECRET_KEY;
  assert.deepEqual(explorer.navInfo(bare.ws, { hosted: true }), { state: 'not_configured', show: false });
  assert.deepEqual(explorer.navInfo(bare.ws, { hosted: false }), { state: 'not_configured', show: true });
});

// ---- the view's own rules (views/explorer.js) ---------------------------------

let tmpUi;
async function view() {
  tmpUi = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-xp-ui-'));
  fs.cpSync(path.join(__dirname, '..', 'public'), tmpUi, { recursive: true });
  fs.writeFileSync(path.join(tmpUi, 'package.json'), '{ "type": "module" }');
  return import(pathToFileURL(path.join(tmpUi, 'views', 'explorer.js')).href);
}
const viewMod = view();
const cmpMod = viewMod.then(() => import(pathToFileURL(path.join(tmpUi, 'compare-model.js')).href));
const S = (score) => ({ status: 'scored', score, score_low: null, score_high: null });
const R = (lo, hi) => ({ status: 'range', score: null, score_low: lo, score_high: hi });
const U = { status: 'unknown', score: null, score_low: null, score_high: null };
const NA = { status: 'not_applicable', score: null, score_low: null, score_high: null };
test.after(() => { if (tmpUi) fs.rmSync(tmpUi, { recursive: true, force: true }); });

function viewData() {
  const { ws, cleanup } = tempWorkspace('xp-view');
  try {
    const { batch } = adapter.buildBatch(ws, adapter.loadFixtures(), { dataset: 'demo', source: 'test' });
    // Shaped as the server sends them (each with the desk's order key).
    return { projects: batch.projects.map((p) => ({ ...p, dataset: 'demo' })), reports: batch.reports.map((r) => explorer.shapeReport({ ...r, dataset: 'demo' })) };
  } finally {
    cleanup();
  }
}

test('view: words for every state; 0 is a number; unknown and N/A sort last; ranges by their low end', async () => {
  const v = await viewMod;
  assert.equal(v.scoreText({ status: 'scored', score: 0 }), '0');
  assert.equal(v.sortValue({ status: 'scored', score: 0 }), 0);
  assert.equal(v.scoreText({ status: 'range', score_low: 45, score_high: 60 }), '45–60');
  assert.equal(v.sortValue({ status: 'range', score_low: 45, score_high: 60 }), 45);
  assert.equal(v.scoreText({ status: 'unknown', score: null }), 'Unknown');
  assert.equal(v.sortValue({ status: 'unknown', score: null }), null);
  assert.equal(v.scoreText({ status: 'not_applicable' }), 'N/A');
  assert.equal(v.scoreText(null), 'Not in this report');
  assert.equal(v.gradeText({ grade_status: 'firm', grade_value: 57.65 }), 'Grade 57.6', 'truncated, never rounded up');
  assert.equal(v.gradeText({ grade_status: 'range', grade_low: 63.8, grade_high: 65.4 }), 'Grade 63.8–65.4');
  assert.equal(v.gradeText({ grade_status: 'withheld', grade_coverage_pct: 80 }), 'Grade withheld · 80% coverage');
});

test('view: one category across projects, grouped by scoring version; latest save per model unless all saves are asked for; search and model filters', async () => {
  const v = await viewMod;
  const data = viewData();
  const cats = v.categoriesOf(data.reports);
  assert.equal(cats[0].id, 'legitimacy');
  assert.equal(cats[0].label, 'Project legitimacy');
  assert.ok(cats.some((c) => c.id === 'chart_quality'), 'the @1 profile\'s own categories are listed too');
  const latest = v.selectReports(data, { q: '', model: 'all', saves: 'latest' });
  assert.equal(latest.length, 12, 'the earlier Halcyon save is left out by default');
  assert.ok(!latest.some((e) => e.report.report_id === '2026-09-28_claude_demo0003'));
  const all = v.selectReports(data, { q: '', model: 'all', saves: 'all' });
  assert.equal(all.length, 13);
  assert.deepEqual(all.find((e) => e.report.report_id === '2026-09-28_claude_demo0003').revisedBy, ['2026-09-28_claude_demo0004']);
  const cmp = v.compareCategory(latest, 'legitimacy');
  assert.deepEqual(cmp.groups.map((g) => g.key).sort(), ['general-token@2 · cr-grading@1', 'network-infrastructure@1 · cr-grading@1', 'network-infrastructure@2 · cr-grading@1', 'payfi-credit@2 · cr-grading@1']);
  const payfi = cmp.groups.find((g) => g.profile === 'payfi-credit@2');
  assert.deepEqual(payfi.rows.map((e) => v.scoreText(e.score)), ['78', '70–80'], 'highest first; a range by its low end');
  const code = v.compareCategory(latest, 'code_quality');
  const gt = code.groups.find((g) => g.profile === 'general-token@2');
  assert.deepEqual(gt.rows.map((e) => v.scoreText(e.score)), ['40', 'N/A', 'Unknown', 'Unknown', 'Unknown', 'Unknown'], 'a number first; N/A and unknown after it, by name');
  assert.equal(code.missing.length, 2, 'the @1 reports have no code-quality grade: said, not hidden');
  assert.equal(v.selectReports(data, { q: 'quill', model: 'all', saves: 'latest' }).length, 2);
  assert.equal(v.selectReports(data, { q: 'qul', model: 'chatgpt', saves: 'latest' }).length, 1);
  assert.equal(v.selectReports(data, { q: '', model: 'gemini', saves: 'latest' }).length, 1);
});

// ---- Second opinion (compare-model.js, GET /api/explorer/compare) -------------

test('second opinion: the comparison rules (two points, point and range, two ranges, unknown, N/A, zero, versions)', async () => {
  const c = await cmpMod;
  const cmp = (a, b, o = {}) => c.compareScores(a, b, { nameA: 'Claude', nameB: 'ChatGPT', ...o });
  const pick = (r) => [r.kind, r.label, r.gap, r.group];
  // Two points: the absolute difference, in points.
  assert.deepEqual(pick(cmp(S(55), S(64))), ['difference', '9-point difference', 9, 'notable']);
  assert.match(cmp(S(55), S(64)).detail, /not a measure of which is right/);
  assert.deepEqual(pick(cmp(S(66), S(63))), ['difference', '3-point difference', 3, 'close']);
  assert.deepEqual(pick(cmp(S(52), S(52))), ['same', 'Same score', 0, 'close']);
  assert.match(cmp(S(52), S(52)).detail, /do not mean the facts behind them agree/);
  assert.deepEqual(pick(cmp(S(0), S(9))), ['difference', '9-point difference', 9, 'notable'], 'zero is a number');
  assert.equal(cmp(S(2.5), S(4)).label, '1.5-point difference');
  // A point and a range: inside (ends included) or outside, by how much.
  assert.deepEqual(pick(cmp(S(78), R(70, 80))), ['inside', 'Inside the range', 0, 'close']);
  assert.match(cmp(S(78), R(70, 80)).detail, /Claude's 78 is inside ChatGPT's 70–80/);
  assert.equal(cmp(S(80), R(70, 80)).kind, 'inside');
  assert.deepEqual(pick(cmp(R(45, 60), S(44))), ['outside', 'Outside the range by 1 point', 1, 'close']);
  assert.match(cmp(R(45, 60), S(44)).detail, /ChatGPT's 44 is 1 point below Claude's 45–60/);
  assert.deepEqual(pick(cmp(S(90), R(70, 80))), ['outside', 'Outside the range by 10 points', 10, 'notable']);
  // Two ranges: overlap (touching counts) or separated by a gap.
  assert.deepEqual(pick(cmp(R(60, 75), R(70, 85))), ['overlap', 'Scores overlap', 0, 'close']);
  assert.match(cmp(R(60, 75), R(70, 85)).detail, /70–75/);
  assert.equal(cmp(R(50, 60), R(60, 70)).kind, 'overlap');
  assert.deepEqual(pick(cmp(R(50, 60), R(65, 75))), ['separated', 'Separated by 5 points', 5, 'notable']);
  // Unknown and N/A keep their meaning; nothing is a number.
  assert.deepEqual(pick(cmp(U, S(44))), ['one_unknown', 'Evidence missing', null, 'missing']);
  assert.match(cmp(U, S(44)).detail, /Unknown for Claude/);
  assert.deepEqual(pick(cmp(U, U)), ['both_unknown', 'Evidence missing', null, 'missing']);
  assert.deepEqual(pick(cmp(NA, U)), ['one_na', 'N/A for Claude', null, 'other']);
  assert.deepEqual(pick(cmp(NA, NA)), ['both_na', 'Not applicable to both', null, 'other']);
  assert.deepEqual([c.valueText(U), c.valueText(NA), c.valueText(S(0)), c.valueText(R(45, 60)), c.valueText(null)], ['Unknown', 'N/A', '0', '45–60', 'Not in report']);
  // Different scoring versions: no number is compared; missing evidence is still said.
  assert.deepEqual(pick(cmp(S(55), S(64), { comparable: false })), ['not_comparable', 'Different scoring versions', null, 'other']);
  assert.equal(cmp(U, S(64), { comparable: false }).kind, 'one_unknown');
  assert.deepEqual(pick(cmp(null, S(64), { comparable: false })), ['not_in_profile', "Not in Claude's scoring profile", null, 'other']);
  assert.deepEqual(pick(cmp(S(64), null)), ['not_in_report', 'Not graded by ChatGPT', null, 'missing']);
  // No midpoint, no average, no winner: only these fields.
  assert.deepEqual(Object.keys(cmp(R(60, 75), R(70, 85))).sort(), ['detail', 'gap', 'group', 'kind', 'label']);
});

test('second opinion on the fixtures: scope from stored metadata, versions, the inspection order, revisions and a single model', async () => {
  const c = await cmpMod;
  const data = viewData();
  const rep = (id) => data.reports.find((r) => r.report_id === id);
  const of = (pid) => data.reports.filter((r) => r.project_id === pid);
  // Meridian: one research run, prompt and horizon; the same scoring version.
  const m = c.compareReports(rep('2026-10-05_claude_demo0008'), rep('2026-10-06_chatgpt_demo0009'), data.reports);
  assert.deepEqual([m.scope.confirmed, m.scope.label, m.versions.compatible], [true, 'Research scope matches', true]);
  assert.match(m.scope.text, /hashes are not stored in the Explorer, so they are not compared/);
  assert.deepEqual([m.authorship.independent, m.authorship.label], [true, 'Independent authorship']);
  assert.deepEqual(m.scope.facts.filter((f) => f.differs).map((f) => f.what), ['Research date'], 'models in one run may finish on different days; that is shown, not hidden');
  assert.deepEqual(m.counts, { categories: 13, notable: 5, missing: 2, close: 5, other: 1 });
  assert.deepEqual(m.rows.inspection.map((r) => r.category_id), ['valuation_supply_attractiveness', 'volume_liquidity', 'development_credibility', 'token_value_capture', 'product_reality', 'organic_demand', 'btc_relative_opportunity', 'legitimacy', 'build_operational_quality', 'technology_usefulness', 'chart_structure', 'cycle_timing', 'code_quality']);
  assert.deepEqual([m.rows.profile[0].category_id, m.rows.profile[12].category_id], ['legitimacy', 'btc_relative_opportunity']);
  const label = Object.fromEntries(m.rows.profile.map((r) => [r.category_id, r.result.label]));
  assert.deepEqual([label.valuation_supply_attractiveness, label.development_credibility, label.product_reality, label.legitimacy, label.technology_usefulness, label.build_operational_quality, label.organic_demand, label.btc_relative_opportunity, label.code_quality],
    ['13-point difference', '9-point difference', 'Separated by 5 points', 'Scores overlap', 'Inside the range', 'Same score', 'Evidence missing', 'Evidence missing', 'N/A for Claude']);
  assert.deepEqual([rep('2026-10-05_claude_demo0008').grade_status, rep('2026-10-06_chatgpt_demo0009').grade_status], ['withheld', 'range'], 'each grade as stored, never combined');
  // Corvid: different scoring versions and runs: side by side, nothing compared.
  const cv = c.compareReports(rep('2026-10-06_claude_demo0010'), rep('2026-09-24_chatgpt_demo0011'), data.reports);
  assert.deepEqual([cv.versions.compatible, cv.versions.label, cv.scope.status, cv.scope.label], [false, 'Different scoring versions', 'differs', 'Research scope differs']);
  assert.match(cv.scope.text, /^Different research runs; different prompt versions; different scoring profiles; different horizons./);
  assert.match(cv.scope.text, /not a controlled comparison/);
  assert.ok(cv.rows.profile.every((r) => r.result.gap === null), 'no numeric comparison across scoring versions');
  const cl = Object.fromEntries(cv.rows.profile.map((r) => [r.category_id, r.result.label]));
  assert.deepEqual([cl.legitimacy, cl.chart_structure, cl.chart_quality], ['Different scoring versions', "Not in ChatGPT's scoring profile", "Not in Claude's scoring profile"]);
  // Sable: ChatGPT's report names no research run or horizon; numbers are compared, the scope is not confirmed.
  const sb = c.compareReports(rep('2026-10-03_claude_demo0012'), rep('2026-10-04_chatgpt_demo0013'), data.reports);
  assert.deepEqual([sb.scope.status, sb.scope.label, sb.versions.compatible], ['unconfirmed', 'Scope not confirmed', true]);
  assert.match(sb.scope.text, /^ChatGPT states no research run; ChatGPT states no horizon. Missing metadata leaves the scope unconfirmed/);
  assert.equal(sb.rows.profile.find((r) => r.category_id === 'legitimacy').result.label, '4-point difference');
  // Halcyon: the revision is the latest Claude report; the original stays choosable and says it was revised.
  const hal = of('demo-halcyon-mesh');
  assert.equal(c.latestFor(hal, 'claude').report_id, '2026-09-28_claude_demo0004');
  const choices = c.reportChoices(hal);
  const orig = choices.find((x) => x.report.report_id === '2026-09-28_claude_demo0003');
  const rev = choices.find((x) => x.report.report_id === '2026-09-28_claude_demo0004');
  assert.deepEqual([orig.latest, orig.revisedBy, rev.latest, rev.revision.kind], [false, ['2026-09-28_claude_demo0004'], true, 'reassessment']);
  assert.deepEqual(choices.map((x) => x.model), ['claude', 'claude', 'gemini'], 'desk order, newest first per model');
  // Only one model by default: no ChatGPT report, and nothing put in its place.
  const pair = c.defaultPair(hal);
  assert.equal(pair.a.report_id, '2026-09-28_claude_demo0004');
  assert.equal(pair.b, null, 'Gemini or an earlier report is never substituted');
  // The original and its revision, read side by side when chosen.
  const or = c.compareReports(rep('2026-09-28_claude_demo0003'), rep('2026-09-28_claude_demo0004'), data.reports);
  assert.equal(or.rows.profile.find((r) => r.category_id === 'btc_relative_opportunity').result.label, 'Inside the range');
  assert.equal(or.rows.profile.find((r) => r.category_id === 'token_value_capture').result.label, '6-point difference');
  assert.deepEqual(or.names, ['Claude (original)', 'Claude (revision)'], 'an original and its revision are labelled as such');
  assert.deepEqual([or.relation, or.authorship.independent, or.authorship.label], ['revision', false, 'Original and revision']);
  assert.match(or.authorship.text, /the revision revises the original for the same research run. A revision is the same model's judgment again, not an independent second opinion/);
  assert.equal(or.scope.label, 'Research scope matches', 'the same request; still not independent: two separate facts');
  assert.deepEqual(c.compareReports(rep('2026-09-28_claude_demo0004'), rep('2026-09-28_claude_demo0003'), data.reports).names, ['Claude (revision)', 'Claude (original)'], 'either way round');
  assert.deepEqual(m.names, ['Claude', 'ChatGPT']);
  assert.deepEqual(c.namesFor(rep('2026-09-28_claude_demo0004'), null), ['Claude', '']);
  // Lumen: the default pair; a withheld grade stays withheld.
  const lp = c.defaultPair(of('demo-lumen-pay'));
  assert.deepEqual([lp.a.model, lp.b.model, lp.b.grade_status, lp.b.grade_coverage_pct], ['claude', 'chatgpt', 'withheld', 80]);
  const lu = c.compareReports(lp.a, lp.b, data.reports);
  assert.equal(lu.rows.profile.find((r) => r.category_id === 'legitimacy').result.label, 'Inside the range');
  assert.equal(lu.rows.profile.find((r) => r.category_id === 'volume_liquidity').result.label, 'Outside the range by 1 point');
});

test('second opinion picks reports by the desk\'s own rules: latest by reports.js reportSortKey (a future analysis date never wins by it), revisions by revisions.js revisionOf', async () => {
  const c = await cmpMod;
  const { latestByProvider } = require('../core/compare');
  const { revisionOf } = require('../core/revisions');
  const { ws, cleanup } = tempWorkspace('xp-rules');
  try {
    // The desk's choice and the Explorer's, from the same FICTIONAL desk records.
    const both = (sources, projectId, model) => {
      const desk = latestByProvider(sources.find((x) => x.project.project_id === projectId).reports)[model];
      const rows = adapter.buildBatch(ws, sources, { dataset: 'demo', source: 'test' }).batch.reports.map((r) => explorer.shapeReport(r)).filter((r) => r.project_id === projectId);
      return { desk: desk && desk.report_id, explorer: (c.latestFor(rows, model) || {}).report_id, rows };
    };
    const withClone = (id, analysisAt, importedAt) => {
      const sources = adapter.loadFixtures();
      const list = sources.find((x) => x.project.project_id === 'demo-meridian-ledger').reports;
      const r = structuredClone(list.find((x) => x.report_id === '2026-10-06_chatgpt_demo0009'));
      r.report_id = id;
      r.assessment.analysis_at = analysisAt;
      r.meta.imported_at = importedAt;
      r.meta.provenance = { research_run_id: 'run_demo_meridian_future' };
      r.provenance = { research_run_id: 'run_demo_meridian_future' };
      list.push(r);
      return sources;
    };
    // A report stating an analysis date months ahead, saved before the current
    // one: the desk sorts it at its save time, so it is not the latest.
    const early = both(withClone('2026-10-05_chatgpt_demo0090', '2027-03-01', '2026-10-05T12:00:00.000Z'), 'demo-meridian-ledger', 'chatgpt');
    assert.deepEqual([early.desk, early.explorer], ['2026-10-06_chatgpt_demo0009', '2026-10-06_chatgpt_demo0009']);
    assert.equal(early.rows.find((r) => r.report_id === '2026-10-05_chatgpt_demo0090').research_date, null, 'the impossible date is not exported as an analysis date');
    // Saved after it: latest by its save time, on the desk and here alike.
    const late = both(withClone('2026-10-07_chatgpt_demo0091', '2027-03-01', '2026-10-07T08:00:00.000Z'), 'demo-meridian-ledger', 'chatgpt');
    assert.deepEqual([late.desk, late.explorer], ['2026-10-07_chatgpt_demo0091', '2026-10-07_chatgpt_demo0091']);
    // A stored row whose day is far after its save (written by hand, not by the
    // adapter) is held to the same check: it sorts at its save time.
    const current = early.rows.find((r) => r.report_id === '2026-10-06_chatgpt_demo0009');
    const future = explorer.shapeReport({ ...current, report_id: '2026-10-05_chatgpt_demo0092', research_date: '2027-03-01', saved_at: '2026-10-05T12:00:00+00:00' });
    assert.ok(future.order_key.startsWith('2026-10-05T12:00:00.000Z|'), future.order_key);
    assert.equal(c.latestFor([current, future], 'chatgpt'), current, 'a future date never makes a report "latest"');
    // A day one day after the save is the desk's tolerance for time zones: used as stated.
    assert.ok(explorer.shapeReport({ ...current, research_date: '2026-10-07', saved_at: '2026-10-06T09:20:00.000Z' }).order_key.startsWith('2026-10-07T00:00:00.000Z|'));
    // An original followed by its revision (Halcyon, one research run): the
    // revision is the latest on both; the link is the desk's own.
    const hal = both(adapter.loadFixtures(), 'demo-halcyon-mesh', 'claude');
    assert.deepEqual([hal.desk, hal.explorer], ['2026-09-28_claude_demo0004', '2026-09-28_claude_demo0004']);
    const deskList = adapter.loadFixtures().find((x) => x.project.project_id === 'demo-halcyon-mesh').reports;
    const rev = revisionOf(deskList, deskList.find((r) => r.report_id === '2026-09-28_claude_demo0004'));
    assert.equal(rev.kind, 'revision');
    assert.equal(hal.rows.find((r) => r.report_id === '2026-09-28_claude_demo0004').revision_of, rev.of);
    const choices = c.reportChoices(hal.rows).filter((x) => x.model === 'claude');
    assert.deepEqual(choices.map((x) => [x.report.report_id, x.latest, x.revision && x.revision.of, x.revisedBy]), [
      ['2026-09-28_claude_demo0004', true, '2026-09-28_claude_demo0003', []],
      ['2026-09-28_claude_demo0003', false, null, ['2026-09-28_claude_demo0004']],
    ]);
    assert.equal(c.defaultPair(hal.rows).a.report_id, '2026-09-28_claude_demo0004');
    // The list's "Latest" uses the same rule.
    const v = await viewMod;
    const lst = v.selectReports({ projects: [], reports: early.rows }, { q: '', model: 'chatgpt', saves: 'latest' });
    assert.deepEqual(lst.map((e) => e.report.report_id), ['2026-10-06_chatgpt_demo0009']);
  } finally {
    cleanup();
  }
});

test('second opinion: scope and authorship are separate facts; frozen hashes compared where stored; missing metadata is "Scope not confirmed"; numbers only under the same profile, rubric and category definition', async () => {
  const c = await cmpMod;
  const grade = (id, label, score, position = 1) => ({ category_id: id, category_label: label, position, status: 'scored', score, score_low: null, score_high: null });
  const base = { report_id: 'r-a', model: 'claude', research_run_id: 'run_1', prompt_version: 'cr-research-prompt@5', profile_version: 'general-token@2', rubric_version: 'cr-grading@1', horizon_start: '2026-10-01', horizon_end: '2027-02-01', research_date: '2026-10-01', category_scores: [grade('legitimacy', 'Project legitimacy', 70), grade('code_quality', 'Code quality', 50, 2)] };
  const A = base;
  const B = { ...base, report_id: 'r-b', model: 'chatgpt', category_scores: [grade('legitimacy', 'Project legitimacy', 79), grade('code_quality', 'Code quality', 52, 2)] };
  // Matching scope, two models; the hashes are not stored here, so said and not compared.
  const m = c.compareReports(A, B);
  assert.deepEqual([m.scope.status, m.scope.label, m.authorship.independent, m.authorship.label], ['matches', 'Research scope matches', true, 'Independent authorship']);
  assert.deepEqual(m.scope.facts.filter((f) => /hash/.test(f.what)).map((f) => [f.what, f.a, f.b, f.differs, f.missing]), [
    ['Frozen prompt hash', 'Not stored in the Explorer', 'Not stored in the Explorer', false, false],
    ['Evidence packet hash', 'Not stored in the Explorer', 'Not stored in the Explorer', false, false],
  ]);
  assert.match(m.scope.caveat, /does not certify that either report is accurate/);
  assert.equal(m.rows.profile[0].result.label, '9-point difference');
  // Hashes where stored: the same, different, or on one side only.
  const P = 'a'.repeat(64);
  const E = 'b'.repeat(64);
  const hashed = c.scopeOf({ ...A, prompt_sha256: P, evidence_packet_sha256: E }, { ...B, prompt_sha256: P, evidence_packet_sha256: E });
  assert.equal(hashed.status, 'matches');
  assert.match(hashed.text, /and the same frozen prompt and evidence packet: both reports answered the same frozen request\.$/);
  const otherPrompt = c.scopeOf({ ...A, prompt_sha256: P, evidence_packet_sha256: E }, { ...B, prompt_sha256: 'c'.repeat(64), evidence_packet_sha256: E });
  assert.deepEqual([otherPrompt.status, otherPrompt.label], ['differs', 'Research scope differs']);
  assert.match(otherPrompt.text, /^Different frozen prompts\./);
  const oneSide = c.scopeOf({ ...A, evidence_packet_sha256: E }, B);
  assert.deepEqual([oneSide.status, oneSide.label], ['unconfirmed', 'Scope not confirmed']);
  assert.match(oneSide.text, /^The evidence packet hash is stored for Claude only\. Missing metadata leaves the scope unconfirmed/);
  // Missing metadata: never assumed to match.
  for (const [field, words] of [['research_run_id', 'ChatGPT states no research run'], ['prompt_version', 'ChatGPT states no prompt version'], ['profile_version', 'ChatGPT states no scoring profile'], ['rubric_version', 'ChatGPT states no rubric version'], ['horizon_end', 'ChatGPT states no horizon']]) {
    const s = c.scopeOf(A, { ...B, [field]: null });
    assert.deepEqual([s.status, s.label, s.confirmed], ['unconfirmed', 'Scope not confirmed', false], field);
    assert.ok(s.text.startsWith(words), s.text);
  }
  assert.match(c.scopeOf({ ...A, horizon_start: null }, { ...B, horizon_start: null }).text, /^Neither states a horizon/);
  // A known difference outranks a missing fact.
  assert.equal(c.scopeOf(A, { ...B, research_run_id: 'run_2', horizon_end: null }).status, 'differs');
  // Numbers: the same profile and rubric, both stated, and the same category definition.
  const noRubric = c.compareReports(A, { ...B, rubric_version: null });
  assert.deepEqual([noRubric.versions.compatible, noRubric.versions.label, noRubric.rows.profile[0].result.label, noRubric.rows.profile[0].result.gap], [false, 'Scoring version not stated', 'Scoring version not stated', null]);
  const otherRubric = c.compareReports(A, { ...B, rubric_version: 'cr-grading@2' });
  assert.deepEqual([otherRubric.versions.label, otherRubric.rows.profile[0].result.kind, otherRubric.rows.profile[0].result.gap], ['Different scoring versions', 'not_comparable', null]);
  const otherProfile = c.compareReports(A, { ...B, profile_version: 'general-token@3' });
  assert.equal(otherProfile.rows.profile[0].result.label, 'Different scoring versions');
  const redefined = c.compareReports(A, { ...B, category_scores: [grade('legitimacy', 'Team legitimacy', 79), grade('code_quality', 'Code quality', 52, 2)] });
  const row = redefined.rows.profile.find((r) => r.category_id === 'legitimacy');
  assert.deepEqual([row.result.kind, row.result.label, row.result.gap, row.other_label], ['not_comparable', 'Category definitions differ', null, 'Team legitimacy']);
  assert.match(row.result.detail, /“Project legitimacy” and “Team legitimacy”/);
  assert.equal(redefined.rows.profile.find((r) => r.category_id === 'code_quality').result.label, '2-point difference', 'only the redefined category is held back');
  // Authorship: one model twice, an original and its revision through a chain.
  const O = { ...A, report_id: 'o' };
  const R1 = { ...A, report_id: 'r1', revision_of: 'o' };
  const R2 = { ...A, report_id: 'r2', revision_of: 'r1' };
  const same = c.compareReports(O, { ...A, report_id: 'x', research_run_id: 'run_2' });
  assert.deepEqual([same.names, same.relation, same.authorship.independent, same.authorship.label], [['Claude (first)', 'Claude (second)'], 'same_model', false, 'Same model']);
  assert.match(same.authorship.text, /not an independent second opinion/);
  assert.deepEqual(c.compareReports(O, R2, [O, R1, R2]).names, ['Claude (original)', 'Claude (revision)']);
  assert.deepEqual(c.compareReports(R2, R1, [O, R1, R2]).names, ['Claude (later revision)', 'Claude (earlier revision)']);
  const chain = c.compareReports(O, R1, [O, R1, R2]);
  assert.deepEqual([chain.authorship.label, chain.scope.label], ['Original and revision', 'Research scope matches'], 'the same request, the same author: two facts');
});

test('explorer list: every row across pages past Supabase\'s 1,000-row cap, in a unique order; counts and filters over all of them; rows read twice or a table that changes mid-read are refused', async (t) => {
  const si = await standIn();
  t.after(() => si.server.close());
  const { ws, cleanup } = explorerWorkspace('xp-bulk', si.url);
  t.after(cleanup);
  explorer.resetMemory();
  const env = { CR_SUPABASE_SECRET_KEY: KEY };
  await explorer.exportFixtures(ws, { env });
  // 90 more FICTIONAL projects with one report of 13 grades each: 1,170 +
  // 167 = 1,337 category grades, more than one Supabase answer holds.
  const template = si.st.reports.get('2026-10-06_chatgpt_demo0009');
  for (let i = 1; i <= 90; i++) {
    const n = String(i).padStart(3, '0');
    const pid = `demo-bulk-${n}`;
    const model = i % 2 ? 'claude' : 'chatgpt';
    si.st.projects.set(pid, { project_id: pid, dataset: 'demo', name: `Bulk Test ${n} (FICTIONAL)`, ticker: `BK${n}`, identity_status: 'pending', chain: null, contract_address: null, native_chain: false, updated_at: '2026-10-06T00:00:00Z' });
    si.st.reports.set(`2026-10-01_${model}_bulk${n}`, { ...template, report_id: `2026-10-01_${model}_bulk${n}`, project_id: pid, model, research_run_id: `run_bulk_${n}`, research_date: '2026-10-01', saved_at: `2026-10-01T${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`, revision_of: null, revision_kind: null, revision_basis: null, revision_note: null });
  }
  const fixtureView = viewData();
  si.st.maxRows = 1000; // Supabase's default row cap per answer
  let before = si.st.requests.length;
  const d = await explorer.read(ws, { env, refresh: true });
  assert.equal(d.state, 'ok', d.reason);
  assert.deepEqual(d.totals, { projects: 96, reports: 103, category_scores: 1337 });
  assert.deepEqual(d.pages, { projects: 1, reports: 1, category_scores: 2 });
  assert.equal('truncated' in d, false, 'nothing is cut off, so nothing says so');
  assert.ok(d.reports.every((r) => r.category_scores.length === si.st.reports.get(r.report_id).category_scores.length && r.order_key), 'every report with all its grades and the desk\'s order key');
  const keys = d.reports.flatMap((r) => r.category_scores.map((s) => `${r.report_id}/${s.category_id}`));
  assert.equal(new Set(keys).size, 1337, 'every grade once');
  let reqs = si.st.requests.slice(before);
  assert.ok(reqs.every((r) => r.method === 'GET'), 'reads only');
  assert.equal(reqs.filter((r) => r.url.startsWith('/rest/v1/category_scores')).length, 2, 'two pages of grades, not a request per report or category');
  assert.ok(reqs.filter((r) => !r.url.startsWith('/rest/v1/export_runs')).every((r) => /^\d+-\d+$/.test(r.headers.range || '') && r.headers.prefer === 'count=exact' && !/limit=/.test(r.url)), 'paged with an exact count, never a row limit');
  // The view counts and filters over every row read, the last page included.
  const v = await viewMod;
  assert.equal(v.selectReports(d, { q: '', model: 'all', saves: 'latest' }).length, 102, '12 fixture reports in view and 90 more');
  assert.equal(v.selectReports(d, { q: '', model: 'all', saves: 'all' }).length, 103);
  assert.equal(v.selectReports(d, { q: 'bulk test', model: 'claude', saves: 'latest' }).length, 45);
  assert.equal(v.selectReports(d, { q: 'bulk test 090', model: 'all', saves: 'latest' }).length, 1);
  const legit = v.categoriesOf(d.reports).find((x) => x.id === 'legitimacy');
  assert.equal(legit.count, v.categoriesOf(fixtureView.reports).find((x) => x.id === 'legitimacy').count + 90);
  const latest = v.selectReports(d, { q: '', model: 'all', saves: 'latest' });
  const groups = v.compareCategory(latest, 'legitimacy').groups;
  assert.equal(groups.find((g) => g.profile === 'general-token@2').rows.length, v.compareCategory(v.selectReports(fixtureView, { q: '', model: 'all', saves: 'latest' }), 'legitimacy').groups.find((g) => g.profile === 'general-token@2').rows.length + 90);
  // Small answers: the same rows, page after page.
  si.st.maxRows = 7;
  explorer.resetMemory();
  before = si.st.requests.length;
  const small = await explorer.read(ws, { env, refresh: true });
  assert.equal(small.state, 'ok', small.reason);
  assert.deepEqual(small.totals, d.totals);
  assert.deepEqual(small.pages, { projects: 14, reports: 15, category_scores: 191 });
  assert.deepEqual(small.reports.map((r) => r.report_id), d.reports.map((r) => r.report_id));
  assert.deepEqual(small.reports.flatMap((r) => r.category_scores.map((s) => `${r.report_id}/${s.category_id}`)), keys);
  assert.deepEqual(small.projects.map((p) => p.project_id), d.projects.map((p) => p.project_id));
  reqs = si.st.requests.slice(before);
  assert.ok(reqs.every((r) => r.method === 'GET'));
  // A server that answers the same rows again: refused, never doubled.
  si.st.repeat = true;
  explorer.resetMemory();
  const twice = await explorer.read(ws, { env, refresh: true });
  assert.equal(twice.state, 'unavailable');
  assert.match(twice.reason, /came back twice|rows from 0 when rows from 7/);
  si.st.repeat = false;
  // An export landing mid-read changes the count: refused, read again later.
  let calls = 0;
  si.st.hook = (u, st) => {
    if (u.pathname === '/rest/v1/reports' && ++calls === 2) st.reports.set('2026-10-07_claude_bulk999', { ...template, report_id: '2026-10-07_claude_bulk999', project_id: 'demo-bulk-001', model: 'claude', saved_at: '2026-10-07T00:00:00.000Z' });
  };
  explorer.resetMemory();
  const moved = await explorer.read(ws, { env, refresh: true });
  assert.equal(moved.state, 'unavailable');
  assert.match(moved.reason, /changed while it was being read \(103 rows, then 104\)/);
  si.st.hook = null;
  explorer.resetMemory();
  const again = await explorer.read(ws, { env, refresh: true });
  assert.equal(again.state, 'ok', again.reason);
  assert.equal(again.totals.reports, 104);
});

test('compare endpoint: one project only, every row across pages (never a request per category), an incomplete count refused, failures said, nothing written', async (t) => {
  const si = await standIn();
  t.after(() => si.server.close());
  const { ws, cleanup } = explorerWorkspace('xp-compare', si.url);
  t.after(cleanup);
  explorer.resetMemory();
  const env = { CR_SUPABASE_SECRET_KEY: KEY };
  await explorer.exportFixtures(ws, { env });
  const prev = process.env.CR_EXPLORER_PAGE_SIZE;
  process.env.CR_EXPLORER_PAGE_SIZE = '4';
  t.after(() => { if (prev === undefined) delete process.env.CR_EXPLORER_PAGE_SIZE; else process.env.CR_EXPLORER_PAGE_SIZE = prev; });
  si.st.maxRows = 3; // the server answers fewer rows than a page asks for, as Supabase's cap does
  const before = si.st.requests.length;
  const d = await explorer.compareData(ws, 'demo-meridian-ledger', { env });
  assert.equal(d.state, 'ok', d.reason);
  assert.equal(d.project.project_id, 'demo-meridian-ledger');
  assert.deepEqual(d.reports.map((r) => [r.report_id, r.category_scores.length]), [['2026-10-06_chatgpt_demo0009', 13], ['2026-10-05_claude_demo0008', 13]]);
  assert.deepEqual(d.totals, { reports: 2, category_scores: 26 });
  assert.deepEqual(d.pages, { projects: 1, reports: 1, category_scores: 9 }, '26 rows at 3 per answer: 9 pages, none skipped');
  const reqs = si.st.requests.slice(before);
  assert.ok(reqs.every((r) => r.method === 'GET'), 'reads only');
  assert.equal(reqs.filter((r) => r.url.startsWith('/rest/v1/category_scores')).length, 9, 'one request per page, not per category');
  assert.ok(reqs.every((r) => /project_id=eq\.demo-meridian-ledger|report_id=in\./.test(r.url)), 'only the selected project');
  const legit = d.reports[0].category_scores.find((s) => s.category_id === 'legitimacy');
  assert.deepEqual([legit.status, legit.score, legit.score_low, legit.score_high, legit.confidence], ['range', null, 70, 85, 'medium']);
  assert.match(legit.rationale, /registered and its filings/);
  assert.deepEqual(legit.evidence_refs, ['C4']);
  const unknown = d.reports.flatMap((r) => r.category_scores).filter((s) => s.status === 'unknown');
  assert.ok(unknown.length && unknown.every((s) => s.score === null && s.score_low === null && s.score_high === null), 'unknown stays null');
  assert.ok(!JSON.stringify(d).includes(KEY));
  // A count the rows do not reach is refused, never shown as a shorter list.
  si.st.lie = 2;
  const short = await explorer.compareData(ws, 'demo-meridian-ledger', { env });
  assert.equal(short.state, 'unavailable');
  assert.match(short.reason, /incomplete/);
  assert.deepEqual(short.reports, []);
  si.st.lie = 0;
  // Unknown project, bad ID, Supabase failing, not set up.
  assert.equal((await explorer.compareData(ws, 'demo-no-such-project', { env })).state, 'not_found');
  await assert.rejects(explorer.compareData(ws, 'Not An ID', { env }), (e) => e.code === 'BAD_ID');
  si.st.fail = 500;
  const down = await explorer.compareData(ws, 'demo-meridian-ledger', { env });
  assert.equal(down.state, 'unavailable');
  assert.match(down.reason, /500/);
  si.st.fail = null;
  assert.equal((await explorer.compareData(ws, 'demo-meridian-ledger', { env: {} })).state, 'not_configured');
  // A project with one model's reports only.
  const hal = await explorer.compareData(ws, 'demo-halcyon-mesh', { env });
  assert.deepEqual(hal.reports.map((r) => r.model).sort(), ['claude', 'claude', 'gemini']);
  assert.ok(si.st.requests.slice(before).every((r) => r.method === 'GET'), 'comparing never writes');
});
