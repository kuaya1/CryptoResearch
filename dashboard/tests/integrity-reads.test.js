'use strict';
// Coherent reads (audit V2-001). A second process commits two project records
// in one operation and is held, killed or slowed after the first file moved.
// Readers use the production defaults (READ_WAIT_MS, the server's own wait):
// they return one whole generation, wait and then say busy, or refuse an
// interrupted or unverified commit. They never return a mixed pair and never
// turn a failed read into an empty result.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { tempWorkspace, addFixtureProject } = require('./helpers');
const ops = require('../core/ops');
const indexer = require('../core/indexer');
const exporter = require('../core/exporter');
const projects = require('../core/projects');
const { ymdInTz } = require('../core/dates');
const { readJson, atomicWrite, jsonText } = require('../core/fsx');
const { start } = require('../server');

const CHILD = path.join(__dirname, 'children', 'child-held-commit.js');
const PORT = 48000 + Math.floor(Math.random() * 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 15000, what = 'condition') {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

// Two projects, A and B. The held commit renames both: "A new" and "B new".
function twoProjects(ws) {
  const a = addFixtureProject(ws).project_id;
  const b = projects.addProject(ws, { name: 'Second Example (FICTIONAL)', symbol: 'XSEC', coingecko_id: 'second-example-fictional', official_website: 'https://example.org/xsec', evidence: [{ url: 'https://example.org/xsec', note: 'fictional test evidence' }], sector_profile: 'payfi-credit@1' }).project_id;
  assert.notEqual(a, b, 'two distinct projects');
  return [a, b];
}

function heldCommit(ws, ids, mode, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-held-'));
  const ready = path.join(dir, 'ready');
  const release = path.join(dir, 'release');
  const writes = ids.map((id, i) => {
    const rel = `projects/${id}/project.json`;
    const doc = readJson(ws.abs(rel));
    doc.name = `${i ? 'B' : 'A'} new`;
    return { rel, content: jsonText(doc) };
  });
  const spec = path.join(dir, 'spec.json');
  fs.writeFileSync(spec, JSON.stringify({ writes, after: writes[0].rel, mode, ready, release, ...extra }));
  const child = cp.spawn(process.execPath, [CHILD, ws.root, spec], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const done = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, out, err })));
  return {
    child,
    done,
    ready: () => waitFor(() => fs.existsSync(ready), 15000, 'the writer to stop mid-commit'),
    release: () => fs.writeFileSync(release, 'go'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const names = (ws, ids) => ids.map((id) => readJson(ws.abs(`projects/${id}/project.json`)).name);

// Runs a read and reports what it did: a value or an error.
function attempt(fn) {
  try {
    return { value: fn() };
  } catch (error) {
    return { error };
  }
}

test('V2-001 held writer: readers at the production default wait, then say busy; never a mixed pair', async (t) => {
  const { ws, cleanup } = tempWorkspace('v2001-held');
  t.after(cleanup);
  const ids = twoProjects(ws);
  const before = names(ws, ids);
  const w = heldCommit(ws, ids, 'hold');
  t.after(w.cleanup);
  await w.ready();
  // The window is real: the raw files are mixed right now.
  assert.deepEqual(names(ws, ids), ['A new', before[1]], 'raw read is mixed while the commit is held');
  let t0 = Date.now();
  const read = attempt(() => ops.readConsistent(ws, () => names(ws, ids)));
  const waited = Date.now() - t0;
  assert.ok(!read.value, `a read during the held commit returned ${JSON.stringify(read.value)}`);
  assert.ok(read.error.code === 'READ_BUSY' && read.error.details.state === 'applying' && read.error.details.retry_after_ms > 0, read.error.message);
  assert.equal(ops.generationStatus(ws).state, 'applying');
  assert.ok(waited >= ops.READ_WAIT_MS - 50 && waited < ops.READ_WAIT_MS + 1500, `waited ${waited} ms (default ${ops.READ_WAIT_MS})`);
  t0 = Date.now();
  assert.throws(() => indexer.buildIndex(ws), (e) => e.code === 'READ_BUSY', 'the index is never built over a commit in progress');
  assert.throws(() => indexer.projectDetail(ws, ids[1]), (e) => e.code === 'READ_BUSY');
  w.release();
  const r = await w.done;
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).verified, true);
  assert.deepEqual(ops.readConsistent(ws, () => names(ws, ids)), ['A new', 'B new']);
  const idx = indexer.buildIndex(ws);
  assert.deepEqual(ids.map((id) => idx.projects.find((p) => p.project_id === id).name), ['A new', 'B new']);
  assert.ok(idx.read_generation && idx.read_generation.generation > 0);
});

test('V2-001 slow writer: a read that starts during a short commit returns the new generation whole', async (t) => {
  const { ws, cleanup } = tempWorkspace('v2001-slow');
  t.after(cleanup);
  const ids = twoProjects(ws);
  const w = heldCommit(ws, ids, 'timed', { hold_ms: 500 });
  t.after(w.cleanup);
  await w.ready();
  const got = ops.readConsistent(ws, () => names(ws, ids));
  assert.deepEqual(got, ['A new', 'B new']);
  assert.equal((await w.done).code, 0);
});

test('V2-001 interrupted writer: reads refuse until recovery rolls the commit forward', async (t) => {
  const { ws, cleanup } = tempWorkspace('v2001-crash');
  t.after(cleanup);
  const ids = twoProjects(ws);
  const before = names(ws, ids);
  const w = heldCommit(ws, ids, 'crash');
  t.after(w.cleanup);
  const r = await w.done;
  assert.notEqual(r.code, 0, 'the writer was killed mid-commit');
  assert.deepEqual(names(ws, ids), ['A new', before[1]], 'files on disk are mixed');
  const t0 = Date.now();
  const read = attempt(() => ops.readConsistent(ws, () => names(ws, ids)));
  assert.ok(!read.value, `a read after the interrupted commit returned ${JSON.stringify(read.value)}`);
  assert.equal(read.error.code, 'READ_INTERRUPTED');
  assert.ok(Date.now() - t0 < 1000, 'an interrupted commit is reported at once, not waited for');
  assert.equal(ops.generationStatus(ws).state, 'interrupted');
  assert.throws(() => indexer.buildIndex(ws), (e) => e.code === 'READ_INTERRUPTED');
  const rec = ops.recover(ws);
  assert.ok(rec.some((x) => x.action === 'rolled_forward'), JSON.stringify(rec));
  assert.deepEqual(ops.readConsistent(ws, () => names(ws, ids)), ['A new', 'B new']);
});

test('V2-001 unreadable generation marker: an unfinished commit is still detected; a clean folder still reads', async (t) => {
  const { ws, cleanup } = tempWorkspace('v2001-marker');
  t.after(cleanup);
  const ids = twoProjects(ws);
  const w = heldCommit(ws, ids, 'crash');
  t.after(w.cleanup);
  await w.done;
  fs.writeFileSync(ws.abs('.cr/generation.json'), '{"generation": 7, "sta');
  const read = attempt(() => ops.readConsistent(ws, () => names(ws, ids)));
  assert.ok(!read.value, `a read with an unreadable marker returned ${JSON.stringify(read.value)}`);
  assert.equal(read.error.code, 'READ_INTERRUPTED');
  const st = ops.generationStatus(ws);
  assert.equal(st.state, 'interrupted');
  assert.equal(st.invalid_marker, true);
  ops.recover(ws);
  assert.deepEqual(ops.readConsistent(ws, () => names(ws, ids)), ['A new', 'B new']);
  // No unfinished commit: an unreadable marker does not block reading, and
  // the next commit writes a valid one.
  fs.writeFileSync(ws.abs('.cr/generation.json'), 'not json');
  assert.equal(ops.generationStatus(ws).state, 'stable');
  assert.deepEqual(ops.readConsistent(ws, () => names(ws, ids)), ['A new', 'B new']);
  ops.runOp(ws, { type: 'probe', summary: 'x' }, (op) => op.write('logs/probe.txt', 'x'));
  assert.equal(readJson(ws.abs('.cr/generation.json')).state, 'stable');
});

test('V2-001 quarantined commit: derived exports refuse; packages and backups say their records are unverified', (t) => {
  const { ws, cleanup } = tempWorkspace('v2001-quarantine');
  t.after(cleanup);
  twoProjects(ws);
  const rename = fs.renameSync;
  t.after(() => { fs.renameSync = rename; });
  fs.renameSync = function corrupting(from, to) {
    const r = rename.call(fs, from, to);
    if (String(to).endsWith('damaged.txt')) fs.writeFileSync(to, 'damaged on disk');
    return r;
  };
  assert.throws(() => ops.runOp(ws, { type: 'probe', summary: 'x' }, (op) => op.write('logs/damaged.txt', 'intended')), (e) => e.code === 'COMMIT_UNVERIFIED');
  fs.renameSync = rename;
  const exp = attempt(() => exporter.exportJson(ws));
  assert.ok(!exp.value, 'a portable export of possibly mixed records was produced');
  assert.equal(exp.error.code, 'READ_UNSAFE');
  assert.throws(() => exporter.csvTable(ws, 'projects'), (e) => e.code === 'READ_UNSAFE');
  assert.throws(() => ops.readConsistent(ws, () => 1), (e) => e.code === 'READ_UNSAFE');
  assert.throws(() => indexer.buildIndex(ws), (e) => e.code === 'READ_UNSAFE');
  assert.equal(ops.generationStatus(ws).state, 'blocked');
  const pkg = exporter.exportPackage(ws);
  assert.equal(pkg.consistency.verified, false);
  const b = exporter.createBackup(ws, { reason: 'test' });
  assert.equal(b.consistency.verified, false);
  assert.equal(readJson(path.join(b.path, 'BACKUP-INFO.json')).records_verified, false);
  assert.equal(exporter.verifyBackup(ws, b.name).records_verified_when_taken, false);
  assert.equal(ops.resolveBlock(ws, { force: true, reason: 'test: inspected' }).status, 'unblocked');
  assert.equal(exporter.exportJson(ws).consistency.verified, true);
});

test('V2-001 exports and backups taken during a save wait for it and capture one generation', async (t) => {
  const { ws, cleanup } = tempWorkspace('v2001-export');
  t.after(cleanup);
  const ids = twoProjects(ws);
  const pick = (list) => ids.map((id) => list.find((p) => p.id === id).name);
  for (const run of [
    () => pick(exporter.exportJson(ws).projects.map((p) => ({ id: p.project.project_id, name: p.project.name }))),
    () => {
      const rows = exporter.csvTable(ws, 'projects').split(/\r?\n/).slice(1).filter(Boolean);
      return pick(rows.map((line) => ({ id: line.split(',')[0], name: line.split(',')[1] })));
    },
    () => {
      const b = exporter.createBackup(ws, { reason: 'during-save' });
      return ids.map((id) => readJson(path.join(b.path, 'files', 'projects', id, 'project.json')).name);
    },
  ]) {
    const w = heldCommit(ws, ids, 'timed', { hold_ms: 700 });
    await w.ready();
    const got = run();
    const r = await w.done;
    w.cleanup();
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(got, ['A new', 'B new'], 'one whole generation, taken after the save finished');
    // Reset for the next export path.
    ops.runOp(ws, { type: 'reset', summary: 'reset names' }, (op) => {
      ids.forEach((id, i) => {
        const doc = op.readJson(`projects/${id}/project.json`);
        doc.name = `${i ? 'B' : 'A'} old`;
        op.writeJson(`projects/${id}/project.json`, doc);
      });
    });
  }
});

function request(port, pathname, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers: { host: `127.0.0.1:${port}`, 'x-cr-token': token } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = JSON.parse(text); } catch (_) { body = text; }
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// The server records each background job's result under the workspace lock
// and waits for that lock synchronously (up to 20 s; a known limit). Let the
// startup inbox and request jobs finish before a test holds a save open.
async function startupJobsDone(ws) {
  await waitFor(() => {
    const st = readJson(ws.abs('logs/jobs-state.json'), { jobs: {} });
    return st.jobs && st.jobs.inbox && st.jobs.inbox.last_run_at;
  }, 15000, 'the startup inbox job');
  await sleep(300);
}

// Daily jobs would take the workspace lock at startup; mark them done today so
// the server only does what this test drives.
function quietDailyJobs(ws) {
  const today = ymdInTz(new Date());
  atomicWrite(ws.abs('logs/jobs-state.json'), jsonText({ schema_version: 'cr.jobs-state.v1', jobs: { snapshot: { last_success_day: today }, reviews: { last_success_day: today }, backup: { last_success_day: today } }, runner: {} }));
}

test('V2-001 server: serves the last verified index as stale during a save, 503 with Retry-After for a fresh read, then current', async (t) => {
  const { ws, cleanup } = tempWorkspace('v2001-srv');
  const ids = twoProjects(ws);
  quietDailyJobs(ws);
  const srv = await start(ws, { port: PORT, quiet: true });
  t.after(() => {
    try { srv.shutdown(); } catch (_) { /* stopped */ }
    cleanup();
  });
  await startupJobsDone(ws);
  const first = await request(srv.port, '/api/index', srv.token);
  assert.equal(first.status, 200);
  assert.equal(first.body.read_status.status, 'current');
  const seq0 = first.body.live.seq;
  const firstNames = ids.map((id) => first.body.projects.find((p) => p.project_id === id).name);
  const w = heldCommit(ws, ids, 'hold');
  t.after(w.cleanup);
  await w.ready();
  // While the save is held, every index the server serves is one whole generation.
  const served = [];
  const until = Date.now() + 2500;
  while (Date.now() < until) {
    const r = await request(srv.port, '/api/index', srv.token);
    if (r.status === 200) served.push(ids.map((id) => r.body.projects.find((p) => p.project_id === id).name));
    await sleep(100);
  }
  const mixed = served.filter((pair) => JSON.stringify(pair) !== JSON.stringify(firstNames) && JSON.stringify(pair) !== JSON.stringify(['A new', 'B new']));
  assert.deepEqual(mixed, [], `the server served a mixed index: ${JSON.stringify(mixed[0])}`);
  // The watcher (or the 5-second poll) triggers a rebuild that meets the save.
  const stale = await waitFor(async () => {
    const v = await request(srv.port, '/api/version', srv.token);
    return v.body.read_status.status === 'stale' ? v.body : null;
  }, 15000, 'a stale read status');
  assert.equal(stale.read_status.code, 'READ_BUSY');
  const during = await request(srv.port, '/api/index', srv.token);
  assert.equal(during.status, 200, 'the last verified index is still served');
  assert.equal(during.body.read_status.status, 'stale');
  assert.deepEqual(ids.map((id) => during.body.projects.find((p) => p.project_id === id).name), firstNames, 'the snapshot is the old generation, whole');
  assert.notDeepEqual(names(ws, ids), firstNames, 'while the files on disk are mixed');
  const detail = await request(srv.port, `/api/projects/${ids[1]}`, srv.token);
  assert.equal(detail.status, 503);
  assert.equal(detail.body.code, 'READ_BUSY');
  assert.ok(Number(detail.headers['retry-after']) >= 1, 'Retry-After header');
  assert.equal(detail.body.saved, false);
  w.release();
  assert.equal((await w.done).code, 0);
  const current = await waitFor(async () => {
    const v = await request(srv.port, '/api/index', srv.token);
    return v.body.read_status && v.body.read_status.status === 'current' && v.body.live.seq > seq0 ? v.body : null;
  }, 15000, 'a current index after the save');
  assert.deepEqual(ids.map((id) => current.projects.find((p) => p.project_id === id).name), ['A new', 'B new']);
  const v = await request(srv.port, `/api/version?since=${seq0}`, srv.token);
  assert.ok(v.body.changes.some((c) => c.projects === null || c.projects.includes(ids[0])), JSON.stringify(v.body.changes));
});

test('V2-001 server: with nothing verified yet it answers 503; an interrupted save is recovered at startup', async (t) => {
  const { ws, cleanup } = tempWorkspace('v2001-cold');
  const ids = twoProjects(ws);
  quietDailyJobs(ws);
  t.after(cleanup);
  // No verified snapshot (as after a cold start) and a save held open: 503
  // with Retry-After, never a guess.
  const srv = await start(ws, { port: PORT + 20, quiet: true });
  await startupJobsDone(ws);
  const w = heldCommit(ws, ids, 'hold');
  t.after(w.cleanup);
  await w.ready();
  srv.state.index = null;
  try {
    const r = await request(srv.port, '/api/index', srv.token);
    assert.equal(r.status, 503, r.status === 200 ? `served ${JSON.stringify(ids.map((id) => r.body.projects.find((p) => p.project_id === id).name))} during the save` : '');
    assert.equal(r.body.code, 'READ_BUSY');
    assert.ok(Number(r.headers['retry-after']) >= 1);
  } finally {
    w.release();
    await w.done;
    srv.shutdown();
  }
  // Interrupted save, then a fresh server: it recovers and serves the whole new generation.
  const c = heldCommit(ws, ids.slice().reverse(), 'crash');
  t.after(c.cleanup);
  await c.done;
  assert.equal(ops.generationStatus(ws).state, 'interrupted');
  const srv2 = await start(ws, { port: PORT + 40, quiet: true });
  try {
    const r = await request(srv2.port, '/api/index', srv2.token);
    assert.equal(r.status, 200);
    assert.equal(r.body.read_status.status, 'current');
    assert.equal(ops.generationStatus(ws).state, 'stable');
    const got = ids.map((id) => r.body.projects.find((p) => p.project_id === id).name);
    assert.deepEqual(got, ['B new', 'A new'], 'rolled forward whole');
  } finally {
    srv2.shutdown();
  }
});
