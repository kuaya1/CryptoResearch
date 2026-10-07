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

function standIn() {
  const st = { requests: [], projects: new Map(), reports: new Map(), texts: new Map(), exports: [], fail: null };
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

test('adapter: the fictional fixtures become 3 projects, 7 reports and 90 category grades, byte for byte the same each time', () => {
  const { ws, cleanup } = tempWorkspace('xp-adapter');
  try {
    const a = adapter.buildBatch(ws, adapter.loadFixtures(), { dataset: 'demo', source: adapter.FIXTURE_REL });
    const b = adapter.buildBatch(ws, adapter.loadFixtures(), { dataset: 'demo', source: adapter.FIXTURE_REL });
    assert.equal(JSON.stringify(a.batch), JSON.stringify(b.batch), 'the same records give the same batch, so a repeat is "unchanged"');
    assert.deepEqual(a.skipped, []);
    assert.equal(a.batch.dataset, 'demo');
    assert.equal(a.batch.projects.length, 3);
    assert.equal(a.batch.reports.length, 7);
    assert.equal(a.batch.reports.reduce((n, r) => n + r.category_scores.length, 0), 90);
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
    assert.deepEqual(counts, { scored: 70, range: 9, unknown: 10, not_applicable: 1 });
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
    assert.equal(out.batch.reports.length, 6);
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
  assert.equal(first.reports.inserted, 7);
  assert.equal(first.scores_inserted, 90);
  const second = await explorer.exportFixtures(ws, { env });
  assert.equal(second.status, 'exported');
  assert.deepEqual([second.reports.inserted, second.reports.unchanged], [0, 7], 'running it twice duplicates nothing');
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
  assert.equal(data.reports.length, 7);
  const unknown = data.reports.flatMap((r) => r.category_scores).filter((s) => s.status === 'unknown');
  assert.ok(unknown.length && unknown.every((s) => s.score === null && s.score_low === null), 'unknown is read back as null, never 0');
  assert.ok(!JSON.stringify(data).includes(KEY));
  const gets = si.st.requests.filter((r) => r.method === 'GET').map((r) => new URL(r.url, 'http://x').pathname).sort();
  assert.deepEqual(gets, ['/rest/v1/export_runs', '/rest/v1/projects', '/rest/v1/reports']);
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
  assert.equal(body.reports.length, 7);
  assert.equal(body.demo, true);
  assert.ok(!ok.text.includes(KEY), 'the key never reaches the page');
  assert.equal(ok.headers['cache-control'], 'no-store');
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
  assert.equal(JSON.parse(ok.text).reports.length, 7);
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
test.after(() => { if (tmpUi) fs.rmSync(tmpUi, { recursive: true, force: true }); });

function viewData() {
  const { ws, cleanup } = tempWorkspace('xp-view');
  try {
    const { batch } = adapter.buildBatch(ws, adapter.loadFixtures(), { dataset: 'demo', source: 'test' });
    return { projects: batch.projects.map((p) => ({ ...p, dataset: 'demo' })), reports: batch.reports.map((r) => ({ ...r, dataset: 'demo' })) };
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
  assert.equal(latest.length, 6, 'the earlier Halcyon save is left out by default');
  assert.ok(!latest.some((e) => e.report.report_id === '2026-09-28_claude_demo0003'));
  const all = v.selectReports(data, { q: '', model: 'all', saves: 'all' });
  assert.equal(all.length, 7);
  assert.deepEqual(all.find((e) => e.report.report_id === '2026-09-28_claude_demo0003').revisedBy, ['2026-09-28_claude_demo0004']);
  const cmp = v.compareCategory(latest, 'legitimacy');
  assert.deepEqual(cmp.groups.map((g) => g.key).sort(), ['general-token@2 · cr-grading@1', 'network-infrastructure@1 · cr-grading@1', 'network-infrastructure@2 · cr-grading@1', 'payfi-credit@2 · cr-grading@1']);
  const payfi = cmp.groups.find((g) => g.profile === 'payfi-credit@2');
  assert.deepEqual(payfi.rows.map((e) => v.scoreText(e.score)), ['78', '70–80'], 'highest first; a range by its low end');
  const code = v.compareCategory(latest, 'code_quality');
  const gt = code.groups.find((g) => g.profile === 'general-token@2');
  assert.deepEqual(gt.rows.map((e) => v.scoreText(e.score)), ['40', 'Unknown'], 'unknown sorts last');
  assert.equal(code.missing.length, 1, 'the @1 report has no code-quality grade: said, not hidden');
  assert.equal(v.selectReports(data, { q: 'quill', model: 'all', saves: 'latest' }).length, 2);
  assert.equal(v.selectReports(data, { q: 'qul', model: 'chatgpt', saves: 'latest' }).length, 1);
  assert.equal(v.selectReports(data, { q: '', model: 'gemini', saves: 'latest' }).length, 1);
});
