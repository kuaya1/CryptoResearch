'use strict';
// Offsite copies of the online desk (core/offsite.js) and the restore drill.
// The desk serves a complete package only to its own backup key (never the
// sign-in); this PC pulls it, verifies every file and keeps dated copies;
// a restore from such a copy collects a submitted background request by its
// captured ID instead of sending it again. Temporary folders, test keys and
// in-process provider stand-ins only; nothing leaves this PC.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const hosted = require('../hosted');
const { start } = require('../server');
const offsite = require('../core/offsite');
const exporter = require('../core/exporter');
const research = require('../core/research');
const captures = require('../core/captures');
const projects = require('../core/projects');
const { tempWorkspace, addFixtureProject } = require('./helpers');
const { readJson, atomicWrite, jsonText, sha256 } = require('../core/fsx');
const { openWorkspace } = require('../core/workspace');
const { mockReport } = require('../core/demo');

// This PC's own secrets file is never read here: the offsite key lookup is
// pointed at a file that does not exist, so a backup key kept on the machine
// running the tests cannot change what "not set up" says.
const providers = require('../core/providers');
const realSecretsFile = providers.secretsFile;
providers.secretsFile = () => path.join(os.tmpdir(), `cr-offsite-test-no-secrets-${process.pid}`, 'secrets.json');
test.after(() => { providers.secretsFile = realSecretsFile; });

const PASS = 'test-passphrase-not-real';
const HOST = 'desk.test';
const KEY = 'test-backup-key-not-real-0123456789abcdef';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function req(port, { method = 'GET', path: p = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: HOST, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.end();
  });
}

// A fetch for pull() that reaches the local test desk under its host name.
function deskFetch(port, { tamper = null } = {}) {
  const calls = [];
  const f = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ url, headers: opts.headers });
    const r = await req(port, { path: u.pathname, headers: opts.headers || {} });
    const text = tamper ? tamper(r.text) : r.text;
    return { status: r.status, text: async () => text };
  };
  f.calls = calls;
  return f;
}

function withEnv(t, vars) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

async function desk(t, label) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `cr-offsite-${label}-`));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 }));
  const port = await freePort();
  const cfg = hosted.hostedConfig({ CR_DATA_DIR: path.join(base, 'data'), CR_ACCESS_PASSWORD: PASS, PORT: String(port), RENDER_EXTERNAL_HOSTNAME: HOST });
  const ws = hosted.prepareWorkspace(cfg);
  const file = path.join(ws.root, 'config', 'settings.json');
  const s = readJson(file);
  s.market_data = { ...(s.market_data || {}), enabled: false };
  fs.writeFileSync(file, JSON.stringify(s));
  ws.reloadSettings();
  projects.addProject(ws, { name: 'Example PayFi (FICTIONAL)', symbol: 'XMPL', official_website: 'https://example.com/xmpl', coingecko_id: 'example-payfi-fictional', assets: [{ chain: 'example-chain', contract_address: 'FICTIONAL-CONTRACT-XMPL' }], evidence: [{ url: 'https://example.com/xmpl', note: 'fictional' }], sector_profile: 'payfi-credit@1' });
  const srv = await start(ws, { quiet: true, hosted: { port, hosts: cfg.hosts, password: cfg.password, bind: '127.0.0.1', failDelayMs: 0 } });
  t.after(() => srv.shutdown());
  return { ws, port, base };
}

test('offsite: the desk serves its package only to its backup key, never to the sign-in or without a key; wrong keys lock it for a while', async (t) => {
  withEnv(t, { CR_BACKUP_KEY: undefined });
  const d = await desk(t, 'route');
  const none = await req(d.port, { path: '/api/offsite/package', headers: { authorization: `Bearer ${KEY}` } });
  assert.equal(none.status, 404, 'not set up: no key in the desk environment');
  assert.match(JSON.parse(none.text).error, /CR_BACKUP_KEY/);
  process.env.CR_BACKUP_KEY = 'too-short-key';
  assert.equal((await req(d.port, { path: '/api/offsite/package', headers: { authorization: 'Bearer too-short-key' } })).status, 404, 'a short key is not a key');
  process.env.CR_BACKUP_KEY = KEY;
  assert.equal((await req(d.port, { path: '/api/offsite/package' })).status, 401);
  // A signed-in session is not the backup key.
  const login = await req(d.port, { method: 'POST', path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: `https://${HOST}` } });
  assert.notEqual(login.status, 200);
  assert.equal((await req(d.port, { path: `/api/offsite/package?key=${KEY}` })).status, 401, 'never accepted in a URL');
  const ok = await req(d.port, { path: '/api/offsite/package', headers: { authorization: `Bearer ${KEY}` } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['cache-control'], 'no-store');
  const pkg = JSON.parse(ok.text);
  const v = offsite.verifyPackage(pkg);
  assert.equal(v.ok, true, v.problems.join('; '));
  assert.equal(pkg.summary.projects, 1);
  assert.ok(pkg.files.some((f) => f.path === 'projects/example-payfi-fictional/project.json'));
  assert.ok(!pkg.files.some((f) => /^\.cr\/(oauth|sessions)/.test(f.path)), 'no sign-in or connection records');
  assert.equal(pkg.desk.revision.commit, require('../core/revision').revision().commit);
  assert.ok(!ok.text.includes(KEY) && !ok.text.includes(PASS), 'neither secret is in the package');
  // Ten refused keys (two above) lock the route, even for the right key, for 15 minutes.
  for (let i = 0; i < 8; i++) assert.equal((await req(d.port, { path: '/api/offsite/package', headers: { authorization: 'Bearer wrong-key-wrong-key-wrong-key-wrong' } })).status, 401);
  assert.equal((await req(d.port, { path: '/api/offsite/package', headers: { authorization: `Bearer ${KEY}` } })).status, 429);
});

test('offsite: this PC pulls a verified copy into its folder, keeps an index, and refuses a tampered package or one carrying sign-in files', async (t) => {
  withEnv(t, { CR_BACKUP_KEY: KEY });
  const d = await desk(t, 'pull');
  const { ws: pc, root, cleanup } = tempWorkspace('offsite-pc');
  t.after(cleanup);
  const folder = path.join(root, 'offsite-copies');
  // Not set up yet: says what is missing, saves nothing.
  const missing = await offsite.pull(pc, { to: folder, env: {} });
  assert.equal(missing.status, 'not_set_up');
  assert.match(missing.message, /the desk address .*; the backup key on this PC/);
  const r = await offsite.pull(pc, { to: folder, deskUrl: `https://${HOST}`, fetchImpl: deskFetch(d.port) });
  assert.equal(r.status, 'ok', r.message);
  assert.match(r.message, /^Saved cryptoresearch-desk-\S+\.json: \d+ files \(1 projects, 0 reports, 0 transactions\), every file verified\.$/);
  assert.equal(offsite.verifyFile(r.file).ok, true);
  const idx = readJson(path.join(folder, 'OFFSITE-INDEX.json'));
  assert.equal(idx.copies[0].file, path.basename(r.file));
  assert.equal(idx.copies[0].sha256, sha256(fs.readFileSync(r.file)));
  assert.match(r.restore, /^node dashboard\/cli\.js restore-package ".+" --to <empty folder>$/);
  assert.ok(!fs.readFileSync(r.file, 'utf8').includes(KEY), 'the key is not stored with the copy');
  // A changed byte anywhere: refused, nothing kept.
  const before = fs.readdirSync(folder).length;
  const bad = await offsite.pull(pc, { to: folder, deskUrl: `https://${HOST}`, fetchImpl: deskFetch(d.port, { tamper: (text) => text.replace('Example PayFi (FICTIONAL)', 'Example PayFi (TAMPERED)') }) });
  assert.equal(bad.status, 'failed');
  assert.match(bad.message, /did not verify, so nothing was kept: .*does not match its hash/);
  // A package that tries to carry a sign-in file: refused.
  const planted = await offsite.pull(pc, { to: folder, deskUrl: `https://${HOST}`, fetchImpl: deskFetch(d.port, { tamper: (text) => { const p = JSON.parse(text); const c = '{"grants":{}}'; p.files.push({ path: '.cr/oauth.json', bytes: c.length, sha256: sha256(Buffer.from(c)), encoding: 'utf8', content: c }); p.inventory.files += 1; return JSON.stringify(p); } }) });
  assert.equal(planted.status, 'failed');
  assert.match(planted.message, /"\.cr\/oauth\.json" is not a file a package may carry/);
  assert.equal(fs.readdirSync(folder).length, before, 'nothing kept from either');
  // The wrong key on this PC: refused by the desk, said plainly.
  const wrong = await offsite.pull(pc, { to: folder, deskUrl: `https://${HOST}`, env: { CR_BACKUP_KEY: 'another-key-not-real-0123456789abcdefgh' }, fetchImpl: deskFetch(d.port) });
  assert.match(wrong.message, /refused the backup key/);
  // Status for doctor and Settings.
  const st = offsite.status(Object.create(pc, { settings: { value: { ...pc.settings, offsite: { desk_url: `https://${HOST}`, folder } } } }), { CR_BACKUP_KEY: KEY });
  assert.equal(st.configured, true);
  assert.equal(st.last.file, path.basename(r.file));
  assert.equal(st.age_hours, 0);
});

test('offsite: copies are pruned to the newest 30 and one per month for a year; files it did not name are never touched', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-offsite-prune-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const names = [];
  for (let m = 1; m <= 12; m++) for (let dd = 1; dd <= 5; dd++) names.push(`cryptoresearch-desk-2026-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}T03-00-00-000Z.json`);
  for (const n of names) fs.writeFileSync(path.join(dir, n), '{}');
  fs.writeFileSync(path.join(dir, 'my-notes.json'), '{}');
  const removed = offsite.prune(dir, { keepRecent: 30, keepMonthly: 12 });
  const left = fs.readdirSync(dir).filter((n) => n.startsWith('cryptoresearch-desk-'));
  assert.equal(left.length, 30 + 6, 'the newest 30, plus the newest copy of each older month');
  assert.equal(removed.length, 60 - 36);
  assert.ok(fs.existsSync(path.join(dir, 'my-notes.json')));
});

test('restore drill: a backup or package made while a background request was submitted (its ID only in the capture) restores, and the restored desk collects the answer by that ID without sending it again', async (t) => {
  withEnv(t, { OPENAI_API_KEY: 'test-key-not-real-o', GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined });
  const { root, cleanup } = tempWorkspace('offsite-drill');
  t.after(cleanup);
  let ws = openWorkspace({ root, actor: 'test' });
  const pid = addFixtureProject(ws).project_id;
  const file = path.join(root, 'config', 'settings.json');
  const s = readJson(file);
  s.research = { providers: { chatgpt: { model: 'gpt-test-model', input_usd_per_mtok: 2, output_usd_per_mtok: 10, search_usd_per_call: 0.01, max_searches: 5, effort: 'high' } }, budget: { per_run_usd: 20, daily_usd: 50, monthly_usd: 100 }, max_output_tokens: 20000 };
  atomicWrite(file, jsonText(s));
  ws = openWorkspace({ root, actor: 'test' });
  const run = research.createRun(ws, { project_id: pid, providers: ['chatgpt'] });
  // An OpenAI stand-in: accepts once, then answers by ID.
  let posts = 0;
  const reply = (status, body) => ({ ok: status === 200, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
  const f = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (url === 'https://api.openai.com/v1/responses' && method === 'POST') {
      posts += 1;
      return reply(200, { id: 'resp_drill_1', status: 'queued', model: 'gpt-test-model' });
    }
    if (url === 'https://api.openai.com/v1/responses/resp_drill_1' && method === 'GET') {
      const text = mockReport(ws, 'chatgpt', research.loadRun(ws, pid, run.run_id)).replace(/FICTIONAL demo fixture standing in for \w+/, 'ChatGPT (OpenAI)');
      return reply(200, { id: 'resp_drill_1', model: 'gpt-test-model', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 30000, output_tokens: 12000 } });
    }
    throw new Error(`unexpected call ${method} ${url}`);
  };
  await research.runDueJobs(ws, { fetchImpl: f });
  assert.equal(posts, 1);
  // The crash window: the provider accepted it and its ID is captured, but run.json does not have it.
  const runFile = path.join(root, 'projects', pid, 'research', run.run_id, 'run.json');
  const doc = readJson(runFile);
  const a = doc.jobs.chatgpt.attempts[doc.jobs.chatgpt.attempts.length - 1];
  captures.writeCapture(ws, { run: doc, provider: 'chatgpt', attempt: a, result: null, error: null, finishedAt: null, mode: 'api', submission: { response_id: a.response_id, status: 'queued', route: a.provider_route, submitted_at: a.submitted_at } });
  Object.assign(a, { phase: 'dispatched', response_id: undefined, submitted_at: undefined, deadline_at: undefined, provider_status: undefined, provider_route: undefined });
  atomicWrite(runFile, jsonText(doc));
  const capRel = `.cr/captures/${a.attempt_id}.json`;
  // A lock file and a session file in .cr are never copied.
  fs.writeFileSync(path.join(root, '.cr', 'sessions.json'), '{"sessions":{}}');

  // Both kinds of copy carry the capture.
  const pkg = exporter.exportPackage(ws);
  assert.ok(pkg.files.some((x) => x.path === capRel), 'the package carries the capture');
  assert.ok(!pkg.files.some((x) => x.path === '.cr/sessions.json'));
  assert.equal(offsite.verifyPackage(pkg).captures, 1);
  const backup = exporter.createBackup(ws, { reason: 'drill' });
  const manifest = readJson(path.join(backup.path, 'MANIFEST.json'));
  assert.ok(manifest.items.some((x) => x.path === capRel), 'the sealed backup carries the capture');
  assert.equal(exporter.verifyBackup(ws, backup.name).ok, true);

  // Restore the package into an empty folder: verified, totals reconciled.
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-offsite-restored-'));
  t.after(() => fs.rmSync(dest, { recursive: true, force: true, maxRetries: 5 }));
  fs.rmdirSync(dest);
  const restored = exporter.restorePackage(JSON.parse(JSON.stringify(pkg)), dest);
  assert.equal(restored.status, 'restored_and_verified', JSON.stringify(restored));
  assert.ok(fs.existsSync(path.join(dest, ...capRel.split('/'))));
  // A restored copy holds research: nothing is asked of the provider, not
  // even the answer, until Eric releases it.
  const ws2 = openWorkspace({ root: dest, actor: 'test' });
  assert.equal(restored.restored_copy.research_held, true);
  const heldRun = await research.runDueJobs(ws2, { fetchImpl: async () => { throw new Error('no call may be made while held'); } });
  assert.equal(heldRun.status, 'held');
  assert.equal(posts, 1);
  // Released, it collects by the captured ID: nothing is sent again.
  assert.equal(research.releaseRestoredCopy(ws2).status, 'saved');
  const out = await research.runDueJobs(ws2, { fetchImpl: f });
  assert.equal(out.results[0].status, 'completed', JSON.stringify(out.results));
  assert.equal(posts, 1, 'collected by its ID, never sent again');
  const j = research.loadRun(ws2, pid, run.run_id).jobs.chatgpt;
  assert.equal(j.state, 'completed');
  assert.match(j.attempts[j.attempts.length - 1].recovered_from, /captured but not saved/);
  assert.equal(captures.listCaptures(ws2).length, 0, 'the capture is cleared once its answer is saved');

  // The sealed backup restores the same way.
  const dest2 = path.join(path.dirname(dest), `${path.basename(dest)}-from-backup`);
  t.after(() => fs.rmSync(dest2, { recursive: true, force: true, maxRetries: 5 }));
  const fromBackup = exporter.restoreBackup(ws, backup.name, { to: dest2 });
  assert.equal(fromBackup.status, 'restored_and_verified', JSON.stringify(fromBackup));
  assert.ok(fs.existsSync(path.join(dest2, ...capRel.split('/'))));

  // A package that plants a sign-in file is refused before anything is written.
  const evil = JSON.parse(JSON.stringify(pkg));
  const c = '{"sessions":{"x":{}}}';
  evil.files.push({ path: '.cr/sessions.json', bytes: c.length, sha256: sha256(Buffer.from(c)), encoding: 'utf8', content: c });
  const dest3 = path.join(path.dirname(dest), `${path.basename(dest)}-evil`);
  assert.throws(() => exporter.restorePackage(evil, dest3), /not a \.cr file a backup carries/);
  assert.equal(fs.existsSync(dest3), false, 'nothing written');
});

test('restore drill (2026-10-04): a copy holding an uncertain paid attempt and a job held unsent by an archived project restores with hashes and records reconciled, and the restored desk sends no request at all', async (t) => {
  withEnv(t, { OPENAI_API_KEY: 'test-key-not-real-o', GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined });
  const { root, cleanup } = tempWorkspace('offsite-drill-uncertain');
  t.after(cleanup);
  let ws = openWorkspace({ root, actor: 'test' });
  const pid = addFixtureProject(ws).project_id;
  const file = path.join(root, 'config', 'settings.json');
  const s = readJson(file);
  s.research = { providers: { chatgpt: { model: 'gpt-test-model', input_usd_per_mtok: 2, output_usd_per_mtok: 10, search_usd_per_call: 0.01, max_searches: 5, effort: 'high' } }, budget: { per_run_usd: 20, daily_usd: 50, monthly_usd: 100 }, max_output_tokens: 20000 };
  atomicWrite(file, jsonText(s));
  ws = openWorkspace({ root, actor: 'test' });
  // One request that may have been billed with no answer (uncertain), and a
  // second project archived while its request was still queued (held, unsent).
  const run = research.createRun(ws, { project_id: pid, providers: ['chatgpt'] }).run;
  const runFile = path.join(root, 'projects', pid, 'research', run.run_id, 'run.json');
  const doc = readJson(runFile);
  doc.jobs.chatgpt.state = 'uncertain';
  doc.jobs.chatgpt.attempts = [{ n: 1, attempt_id: 'att_drill_uncertain', phase: 'uncertain', reservation_usd: 0.5, dispatched_at: '2026-10-04T12:00:00Z' }];
  atomicWrite(runFile, jsonText(doc));
  const other = projects.addProject(ws, { name: 'Second Example (FICTIONAL)', official_website: 'https://second.example/', coingecko_id: 'second-example-fictional', evidence: [{ url: 'https://second.example/' }] }).project_id;
  const run2 = research.createRun(ws, { project_id: other, providers: ['chatgpt'] }).run;
  assert.equal(research.loadRun(ws, other, run2.run_id).jobs.chatgpt.state, 'queued');
  projects.archiveProject(ws, other, 'FICTIONAL drill');
  const pkg = exporter.exportPackage(ws);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-offsite-restored-u-'));
  t.after(() => fs.rmSync(dest, { recursive: true, force: true, maxRetries: 5 }));
  fs.rmdirSync(dest);
  const restored = exporter.restorePackage(JSON.parse(JSON.stringify(pkg)), dest);
  assert.equal(restored.status, 'restored_and_verified', JSON.stringify(restored));
  // Every file of the package is in the copy, byte for byte.
  for (const f of pkg.files) assert.equal(sha256(fs.readFileSync(path.join(dest, ...f.path.split('/')))), f.sha256, f.path);
  const ws2 = openWorkspace({ root: dest, actor: 'test' });
  // Released (a held copy would ask nothing anyway): the runner itself still
  // never resends the uncertain attempt or sends the held job.
  research.releaseRestoredCopy(ws2);
  assert.deepEqual(projects.listProjects(ws2).map((p) => [p.project_id, p.status]).sort(), [[other, 'archived'], [pid, 'active']].sort());
  assert.equal(research.loadRun(ws2, pid, run.run_id).jobs.chatgpt.state, 'uncertain');
  assert.equal(research.loadRun(ws2, other, run2.run_id).jobs.chatgpt.hold.why, 'archived');
  const calls = [];
  const out = await research.runDueJobs(ws2, { fetchImpl: async (url, opts = {}) => { calls.push(`${opts.method || 'GET'} ${url}`); throw new Error('FICTIONAL: no network in the drill'); } });
  assert.deepEqual(calls, [], 'no request of any kind: the uncertain attempt is never resent and the held job is never sent');
  assert.ok(!out.results.length, JSON.stringify(out.results));
  assert.equal(research.loadRun(ws2, pid, run.run_id).jobs.chatgpt.state, 'uncertain', 'still waiting for Eric to reconcile it');
  assert.equal(research.spendSoFar(ws2).uncertain_attempts, 1, 'and still counted against the limits');
});

// Review v3, finding 2: backup status said "backup" for same-disk snapshots
// and showed nothing on a PC with no offsite copy. It now reports three
// separate things, and only a verified copy on another machine counts as one.
test('backup status: same-disk snapshots, offsite set up and a verified independent copy are reported apart; a scheduled run that made no copy is not a copy; the desk notes what it served but cannot see the copy', async (t) => {
  withEnv(t, { CR_BACKUP_KEY: undefined });
  const jobs = require('../core/jobs');
  const { doctor } = require('../core/doctor');
  const { ws: pc, root, cleanup } = tempWorkspace('backup-status');
  t.after(cleanup);
  const folder = path.join(root, 'offsite-copies');
  // Nothing yet.
  let b = offsite.backupStatus(pc, {});
  assert.deepEqual([b.level, b.same_disk.present, b.offsite.configured, b.independent_copy.verified], ['none', false, false, false]);
  // A same-disk snapshot is not an independent copy.
  exporter.createBackup(pc, { reason: 'test' });
  b = offsite.backupStatus(pc, {});
  assert.equal(b.level, 'same_disk_only');
  assert.match(b.summary, /^Same-disk snapshots: latest \S+, 0 h ago, on this PC's disk \(undoes mistakes; does not survive losing that disk\)\. Offsite copies: not set up on this PC \(missing the desk address .*\)\. Verified independent copy: none yet\.$/);
  // The scheduled task runs, but with offsite not set up it makes no copy: the job says so, and the status does not change.
  const setUp = Object.create(pc, { settings: { value: { ...pc.settings, offsite: { desk_url: `https://${HOST}`, folder } } } });
  const skipped = await jobs.runJob(pc, 'offsite', { trigger: 'scheduler' });
  assert.equal(skipped.status, 'skipped');
  assert.match(skipped.summary, /^No offsite copy was made: Offsite backup is not set up on this PC/);
  assert.equal(offsite.backupStatus(pc, {}).independent_copy.verified, false);
  const docLine = (await doctor(pc)).checks.find((c) => c.name === 'Offsite backup');
  assert.equal(docLine.status, 'warn', 'doctor says it on a PC even before setup');
  assert.match(docLine.detail, /Verified independent copy: none yet\./);
  // Set up and pulled by the scheduled task: a verified independent copy.
  process.env.CR_BACKUP_KEY = KEY;
  const d = await desk(t, 'status');
  assert.equal(offsite.backupStatus(setUp).level, 'offsite_set_up');
  const pulled = await offsite.pull(setUp, { deskUrl: `https://${HOST}`, fetchImpl: deskFetch(d.port), trigger: 'scheduler' });
  assert.equal(pulled.status, 'ok', pulled.message);
  b = offsite.backupStatus(setUp);
  assert.deepEqual([b.level, b.independent_copy.verified, b.independent_copy.overdue, b.independent_copy.latest.trigger, b.independent_copy.latest.file], ['independent_copy', true, false, 'scheduler', path.basename(pulled.file)]);
  assert.match(b.summary, /Verified independent copy: cryptoresearch-desk-\S+\.json, pulled 0 h ago \(scheduler\), every file checked against its hash\.$/);
  assert.equal(offsite.verifyFile(pulled.file).ok, true);
  // A copy older than a day and a half is overdue.
  const idxFile = path.join(folder, 'OFFSITE-INDEX.json');
  const idx = readJson(idxFile);
  idx.copies[0].pulled_at = new Date(Date.now() - 40 * 3600000).toISOString();
  atomicWrite(idxFile, jsonText(idx));
  assert.equal(offsite.backupStatus(setUp).independent_copy.overdue, true);
  // The desk knows its key is set and when it last served a package, never whether a copy was kept.
  const ds = offsite.backupStatus(d.ws);
  assert.deepEqual([ds.hosted, ds.offsite.configured, ds.independent_copy.known_here, ds.independent_copy.verified], [true, true, false, null]);
  assert.ok(ds.offsite.last_served && ds.offsite.last_served.files > 0, 'the package it served is noted');
  assert.equal(ds.level, 'offsite_set_up', 'the desk never claims an independent copy');
  assert.match(ds.summary, /Offsite copies: set up \(the backup key is set\), so your PC can pull verified copies; this desk last served one 0 h ago\. Verified independent copy: not visible from the desk; the PC that pulls copies shows it\.$/);
  // Without the key the desk says the records exist only on its disk.
  delete process.env.CR_BACKUP_KEY;
  assert.match(offsite.backupStatus(d.ws).summary, /Offsite copies: not set up \(no CR_BACKUP_KEY on the desk\), so these records exist only on this disk and in Render's own disk snapshots\./);
  // A key that is set but too short says so (its length, never its value).
  const short = offsite.backupStatus(d.ws, { CR_BACKUP_KEY: 'FICTIONAL-short-key' });
  assert.equal(short.offsite.configured, false);
  assert.match(short.summary, /Offsite copies: not set up \(CR_BACKUP_KEY on the desk is 19 characters; it needs at least 32\)/);
  assert.ok(!JSON.stringify(short).includes('FICTIONAL-short-key'), 'the key itself is never in the status');
});

test('offsite job: due once a day on a PC that is set up; never on the online desk', (t) => {
  const { ws, cleanup } = tempWorkspace('offsite-job');
  t.after(cleanup);
  const jobs = require('../core/jobs');
  const state = { jobs: {}, runner: {} };
  assert.equal(jobs.isDue(ws, 'offsite', state, Date.now(), {}), false, 'not set up');
  const setUp = Object.create(ws, { settings: { value: { ...ws.settings, offsite: { desk_url: 'https://desk.example', folder: null } } } });
  withEnv(t, { CR_BACKUP_KEY: KEY });
  assert.equal(jobs.isDue(setUp, 'offsite', state, Date.now(), {}), true);
  assert.equal(jobs.isDue(setUp, 'offsite', { jobs: { offsite: { last_success_day: require('../core/dates').ymdInTz() } } }, Date.now(), {}), false, 'once a day');
  const deskWs = Object.create(setUp, { hosted: { value: true } });
  assert.equal(jobs.isDue(deskWs, 'offsite', state, Date.now(), {}), false, 'the desk serves, it does not pull');
});

// Review of fa05f99 (2026-10-05): the recovery drill as one command. A copy
// pulled from the desk is verified, restored into a new folder of its own,
// its records, originals and research state checked, and the restored copy's
// runner asked once with a network stand-in that refuses and counts: unsent,
// sent, uncertain and quarantined jobs are restored as they were and nothing
// is asked of any provider.
test('offsite drill: pulled copy verified, restored in isolation, originals and research states intact, zero provider calls; a tampered copy is not restored', async (t) => {
  withEnv(t, { CR_BACKUP_KEY: KEY, OPENAI_API_KEY: 'test-key-not-real-o' });
  const d = await desk(t, 'drill');
  const pid = 'example-payfi-fictional';
  const inbox = require('../core/inbox');
  const { FIXTURES } = require('./helpers');
  const saved = inbox.importContent(d.ws, 'claude', { content: fs.readFileSync(path.join(FIXTURES, 'reports', `${pid}__claude.md`), 'utf8'), projectId: pid });
  assert.equal(saved.result.status, 'ingested', saved.result.message);
  // Four ChatGPT jobs, one in each state the review names.
  const states = [];
  for (const kind of ['unsent', 'sent', 'uncertain', 'quarantined']) {
    const run = research.createRun(d.ws, { project_id: pid, providers: ['chatgpt'], force_new: true }).run;
    const file = d.ws.abs(`projects/${pid}/research/${run.run_id}/run.json`);
    const doc = readJson(file);
    const j = doc.jobs.chatgpt;
    if (kind === 'unsent') Object.assign(j, { state: 'queued', attempts: [] });
    if (kind === 'sent') Object.assign(j, { state: 'dispatching', attempts: [{ n: 1, attempt_id: 'att_drill_sent', phase: 'submitted', response_id: 'resp_drill_sent', submitted_at: '2026-10-05T10:00:00Z', reservation_usd: 0.5 }] });
    if (kind === 'uncertain') Object.assign(j, { state: 'uncertain', attempts: [{ n: 1, attempt_id: 'att_drill_unc', phase: 'uncertain', reservation_usd: 0.5, dispatched_at: '2026-10-05T10:00:00Z' }] });
    if (kind === 'quarantined') Object.assign(j, { state: 'failed', outcome: 'contract_conflict', quarantined_report_id: 'FICTIONAL-quarantined', attempts: [] });
    atomicWrite(file, jsonText(doc));
    states.push(kind);
  }
  const { ws: pc, root, cleanup } = tempWorkspace('offsite-drill-pc');
  t.after(cleanup);
  const folder = path.join(root, 'offsite-copies');
  const pulled = await offsite.pull(pc, { to: folder, deskUrl: `https://${HOST}`, fetchImpl: deskFetch(d.port) });
  assert.equal(pulled.status, 'ok', pulled.message);
  const liveBefore = fs.readdirSync(path.join(root, 'projects')).join(',');
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-drill-')), 'restored');
  t.after(() => fs.rmSync(path.dirname(dest), { recursive: true, force: true, maxRetries: 5 }));
  // Never into the live workspace.
  await assert.rejects(() => offsite.drill(pc, { folder, to: path.join(root, 'drill') }), /outside the live workspace/);
  const out = await offsite.drill(pc, { folder, to: dest });
  assert.equal(out.status, 'passed', out.message);
  assert.equal(out.copy.file, path.basename(pulled.file));
  assert.equal(out.copy.sha256, sha256(fs.readFileSync(pulled.file)));
  assert.equal(out.copy.matches_index, true);
  assert.equal(out.restore.status, 'restored_and_verified');
  assert.equal(out.restore.research_held, true);
  assert.equal(out.records.reports_checked, 1);
  assert.deepEqual(out.records.originals_changed, []);
  assert.deepEqual([out.research.unsent, out.research.sent_collect_by_id, out.research.uncertain, out.research.quarantined], [1, 1, 1, 1]);
  assert.equal(out.provider_calls, 0);
  assert.equal(out.runner, 'held');
  assert.match(out.message, /^Drill passed: .* no provider asked for anything \(1 unsent, 1 sent, 1 uncertain and 1 quarantined job\(s\) restored as they were\)\.$/);
  // The restored copy says what it is; the live workspace is untouched.
  const ws2 = openWorkspace({ root: dest, actor: 'test' });
  assert.equal(research.restoredHold(ws2).from.kind, 'package');
  assert.equal(fs.readdirSync(path.join(root, 'projects')).join(','), liveBefore);
  assert.equal(readJson(path.join(folder, 'OFFSITE-DRILLS.json')).drills[0].passed, true);
  // A copy changed on disk after it was pulled: not restored, recorded as failed.
  const tampered = path.join(folder, 'cryptoresearch-desk-2026-01-01T00-00-00Z.json');
  fs.writeFileSync(tampered, fs.readFileSync(pulled.file, 'utf8').replace('Example PayFi (FICTIONAL)', 'Example PayFi (TAMPERED)'));
  const bad = await offsite.drill(pc, { folder, file: tampered, to: path.join(path.dirname(dest), 'second') });
  assert.equal(bad.status, 'failed');
  assert.match(bad.message, /did not verify, so it was not restored/);
  assert.equal(fs.existsSync(path.join(path.dirname(dest), 'second')), false);
});

// Render restarted the online desk on 2026-10-10 when a 57 MB package, built
// as one string for the daily pull, took it past its 512 MB limit. The
// package is now written one file at a time; its bytes are unchanged.
test('offsite: the package is written one file at a time, byte for byte what JSON.stringify gave, and stops cleanly when the reader goes away', async (t) => {
  const { Writable } = require('stream');
  const { ws, root, cleanup } = tempWorkspace('pkgstream');
  t.after(cleanup);
  addFixtureProject(ws);
  // Text with characters outside ASCII, an empty file and a binary file.
  fs.writeFileSync(path.join(root, 'inbox', 'note.md'), 'Fictional — “quoted” ≈ 12%\n'.repeat(2000));
  fs.writeFileSync(path.join(root, 'inbox', 'empty.txt'), '');
  fs.mkdirSync(path.join(root, 'market-data', 'logos'), { recursive: true });
  fs.writeFileSync(path.join(root, 'market-data', 'logos', 'x.lg.png'), Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256)));
  const collect = (opts = {}) => {
    const chunks = [];
    const w = new Writable({ highWaterMark: 1024, ...opts, write(c, _e, cb) { chunks.push(Buffer.from(c)); setImmediate(cb); } });
    // The caller ends the stream (the route's res.end()); read what reached it then.
    w.text = async () => { await new Promise((resolve) => w.end(resolve)); return Buffer.concat(chunks).toString('utf8'); };
    return w;
  };
  const snap = exporter.packageSnapshot(ws);
  const desk = { revision: { short: 'abc1234' }, served_at: '2026-10-11T00:00:00.000Z' };
  // The snapshot's files are staged copies on the disk, not bytes in memory.
  assert.ok(fs.existsSync(snap.stage) && snap.entries.every((e) => !e.buf && fs.existsSync(e.staged)));
  const expected = JSON.stringify({ ...snap.header, files: snap.entries.map((e) => { const buf = fs.readFileSync(e.staged); return { path: e.path, bytes: e.bytes, sha256: e.sha256, encoding: e.text ? 'utf8' : 'base64', content: e.text ? buf.toString('utf8') : buf.toString('base64') }; }), desk });
  // A record saved after the snapshot does not reach this package.
  fs.writeFileSync(path.join(root, 'inbox', 'note.md'), 'changed after the snapshot\n');
  const out = collect();
  let drains = 0;
  out.on('drain', () => { drains += 1; });
  assert.equal(await exporter.writePackage(snap, out, { desk }), snap.header.inventory.files);
  assert.ok(drains > 0, 'it waited for the reader');
  const text = await out.text();
  assert.equal(text, expected, 'the same bytes as one JSON.stringify of the package');
  assert.ok(snap.entries.every((e) => e === null), 'each file is let go once written');
  assert.equal(fs.existsSync(snap.stage), false, 'the stage is removed once written');
  const pkg = JSON.parse(text);
  assert.equal(offsite.verifyPackage(pkg).ok, true);
  assert.ok(pkg.files.some((f) => f.path === 'market-data/logos/x.lg.png' && f.encoding === 'base64'));
  // Without extra fields it is exactly exportPackage's shape.
  const plain = collect();
  await exporter.writePackage(exporter.packageSnapshot(ws), plain);
  assert.deepEqual(Object.keys(JSON.parse(await plain.text())), Object.keys(exporter.exportPackage(ws)));
  // A reader that goes away part way: it rejects at once, writes nothing more, never hangs.
  const early = collect();
  const earlySnap = exporter.packageSnapshot(ws);
  const run = exporter.writePackage(earlySnap, early);
  setImmediate(() => early.destroy());
  await assert.rejects(run, /closed before the package was sent/);
  assert.equal(fs.existsSync(earlySnap.stage), false, 'an interrupted package leaves no stage');
  // Neither route builds the package as one string any more.
  const route = fs.readFileSync(path.join(__dirname, '..', 'core', 'offsite.js'), 'utf8');
  const fn = route.slice(route.indexOf('function makeOffsiteRoute'), route.indexOf('// Verifying a package'));
  assert.match(fn, /writePackage\(/);
  assert.doesNotMatch(fn, /exportPackage\(|send\(res, 200/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /route\('GET', '\/api\/export\/package', \(\) => \(\{ _stream: exporter\.packageSnapshot\(ws\)/);
});
