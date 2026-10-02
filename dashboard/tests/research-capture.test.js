'use strict';
// Paid answers are captured before the locked commit (audit F1, Cowork review
// of 2026-10-02). Before this repair the answer lived only in memory until
// recordOutcome got the workspace lock: if the lock was busy (a long backup,
// export or package; another session) or writes were blocked, the commit threw
// and the paid answer was gone. The attempt then became "uncertain".
//
// Every test uses real runner processes, a real lock-holding process where the
// lock matters, and a local stub provider that counts the requests it receives.
// Keys are fake and every provider URL is rewritten to 127.0.0.1.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { tempWorkspace, addFixtureProject } = require('./helpers');
const research = require('../core/research');
const indexer = require('../core/indexer');
const { mockReport } = require('../core/demo');
const { readJson, atomicWrite, jsonText, readJsonLines } = require('../core/fsx');
const { openWorkspace } = require('../core/workspace');

const CHILD = path.join(__dirname, 'children', 'child-research-runner.js');
const HOLDER = path.join(__dirname, 'children', 'child-lock-holder.js');
const FAKE_KEY = 'test-key-not-real-0000';
const CLAUDE = { model: 'claude-test-model', input_usd_per_mtok: 3, output_usd_per_mtok: 15, search_usd_per_call: 0.01, max_searches: 5 };
// 12000 input x $3/M + 3000 output x $15/M + 2 searches x $0.01
const ACTUAL = 0.101;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function configure(root, research) {
  const file = path.join(root, 'config', 'settings.json');
  const s = readJson(file);
  s.research = research;
  atomicWrite(file, jsonText(s));
  return openWorkspace({ root, actor: 'test' });
}

function claudeAnswer(text) {
  return { id: 'msg_stub_1', model: 'claude-test-model', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 12000, output_tokens: 3000, server_tool_use: { web_search_requests: 2 } } };
}

// Stub provider. behavior(call) may return a Promise, so a test can do
// something (take the lock, block writes) while the request is in flight.
async function stubProvider() {
  const calls = [];
  const sockets = new Set();
  let behavior = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      calls.push({ path: req.url, at: Date.now() });
      const b = await behavior();
      res.writeHead(b.status, { 'content-type': 'application/json', 'request-id': 'req_stub_1' });
      res.end(JSON.stringify(b.json));
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, calls, set(fn) { behavior = fn; }, close() { for (const s of sockets) s.destroy(); server.close(); } };
}

function runner(root, stub, cfg = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-runner-'));
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ stub_port: stub.port, crash: cfg.crash || null, capture: cfg.capture || null, fs: cfg.fs || null }));
  return new Promise((resolve) => {
    const child = cp.spawn(process.execPath, [CHILD, root, cfgFile], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ANTHROPIC_API_KEY: FAKE_KEY, OPENAI_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '' } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code, signal) => {
      fs.rmSync(dir, { recursive: true, force: true });
      let json = null;
      try { json = JSON.parse(out); } catch (_) { /* killed */ }
      resolve({ code, signal, out: json, err });
    });
  });
}

// A separate process that holds the workspace lock until released.
async function holdLock(root) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-holder-'));
  const ready = path.join(dir, 'ready');
  const release = path.join(dir, 'release');
  const child = cp.spawn(process.execPath, [HOLDER, root, ready, release], { stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  const until = Date.now() + 15000;
  while (!fs.existsSync(ready) && Date.now() < until) await sleep(20);
  assert.ok(fs.existsSync(ready), 'the lock holder took the workspace lock');
  return { release: async () => { fs.writeFileSync(release, '1'); await exited; fs.rmSync(dir, { recursive: true, force: true }); } };
}

async function paidRun(t, label) {
  const { root, cleanup } = tempWorkspace(label);
  t.after(cleanup);
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = FAKE_KEY;
  t.after(() => { if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev; });
  let ws = openWorkspace({ root, actor: 'test' });
  const pid = addFixtureProject(ws).project_id;
  ws = configure(root, { providers: { claude: CLAUDE }, budget: { per_run_usd: 5, daily_usd: 20, monthly_usd: 100 }, max_output_tokens: 8000, max_attempts: 2, timeout_seconds: 60 });
  assert.equal(research.providerStatus(ws).claude.mode, 'api');
  const run = research.createRun(ws, { project_id: pid, providers: ['claude'] });
  const text = mockReport(ws, 'claude', run.run).replace('FICTIONAL demo fixture standing in for Claude', 'Claude (Anthropic)');
  const stub = await stubProvider();
  t.after(() => stub.close());
  stub.set(async () => ({ status: 200, json: claudeAnswer(text) }));
  const job = () => research.loadRun(ws, pid, run.run_id).jobs.claude;
  const reports = () => indexer.projectDetail(ws, pid).reports.filter((r) => r.provenance.research_run_id === run.run_id);
  const spent = () => research.spendSoFar(ws, new Date(), { runId: run.run_id }).run;
  const ledger = (kind) => readJsonLines(ws.abs('logs/research-spend.jsonl')).filter((l) => l.run_id === run.run_id && (!kind || l.kind === kind));
  const captureFile = () => ws.abs(`.cr/captures/${job().attempts[0].attempt_id}.json`);
  const captureFiles = () => (fs.existsSync(ws.abs('.cr/captures')) ? fs.readdirSync(ws.abs('.cr/captures')) : []);
  return { root, ws, pid, run, text, stub, job, reports, spent, ledger, captureFile, captureFiles };
}

// The end state every recovered case must reach: one request, one report,
// one actual-cost line, spend at the actual cost, no capture left.
function assertSavedOnce(c) {
  assert.equal(c.stub.calls.length, 1, 'exactly one request reached the provider');
  const j = c.job();
  assert.equal(j.state, 'completed', j.error || '');
  assert.equal(j.attempts.length, 1);
  assert.equal(j.attempts[0].phase, 'imported');
  assert.equal(j.attempts[0].cost_actual_usd, ACTUAL);
  assert.equal(c.reports().length, 1, 'one report');
  assert.equal(c.ledger('actual').length, 1, 'the actual cost is recorded once');
  assert.equal(c.spent(), ACTUAL, 'the run counts the actual cost once');
  assert.deepEqual(c.captureFiles().filter((f) => !f.startsWith('.')), [], 'no capture is left behind');
}

test('F1 lock contention: an answer arriving while another process holds the workspace lock is captured, then saved by the next run without a new request', async (t) => {
  const c = await paidRun(t, 'f1lock');
  let holder = null;
  c.stub.set(async () => {
    holder = await holdLock(c.root); // a long backup/export/package, say
    return { status: 200, json: claudeAnswer(c.text) };
  });
  const first = await runner(c.root, c.stub);
  assert.equal(c.stub.calls.length, 1);
  const r1 = first.out && first.out.results ? first.out.results[0] : first.out;
  assert.notEqual(r1 && r1.status, 'completed', 'the lock was busy, so the first runner could not save');
  assert.match(String(r1 && r1.error), /busy/i, 'the commit failed on the busy lock');
  assert.equal(r1.status, 'captured', `the answer is reported as captured, not lost (got ${JSON.stringify(r1)})`);
  assert.ok(fs.existsSync(c.captureFile()), 'the capture is on disk');
  assert.equal(c.job().attempts[0].phase, 'dispatched');
  // While it waits, the capture's reported usage counts (not less than the reservation).
  assert.ok(c.spent() >= c.job().attempts[0].reserved_usd);
  await holder.release();
  const second = await runner(c.root, c.stub);
  assert.equal(second.code, 0, second.err);
  assertSavedOnce(c);
  assert.match(c.job().attempts[0].recovered_from, /captured answer/);
  // Repeated recovery changes nothing.
  await runner(c.root, c.stub);
  await runner(c.root, c.stub);
  assertSavedOnce(c);
});

test('F1 blocked writes: an answer arriving while writes are blocked is captured and saved once writes resume', async (t) => {
  const c = await paidRun(t, 'f1blk');
  const block = c.ws.abs('.cr/blocked.json');
  c.stub.set(async () => {
    fs.writeFileSync(block, JSON.stringify({ op_id: 'op_test_block', reason: 'test: an earlier commit did not verify' }));
    return { status: 200, json: claudeAnswer(c.text) };
  });
  const first = await runner(c.root, c.stub);
  const r1 = first.out.results[0];
  assert.equal(r1.status, 'captured', JSON.stringify(r1));
  assert.match(r1.error, /blocked/i);
  // Still blocked: the next runner cannot save either, and sends nothing.
  await runner(c.root, c.stub);
  assert.equal(c.stub.calls.length, 1);
  assert.ok(fs.existsSync(c.captureFile()));
  fs.unlinkSync(block); // the owner resolved the block
  await runner(c.root, c.stub);
  assertSavedOnce(c);
});

test('F1 restart after capture, before commit: saved exactly once on restart, repeated recovery is a no-op', async (t) => {
  const c = await paidRun(t, 'f1crash');
  const first = await runner(c.root, c.stub, { capture: { crash: 'after' } });
  assert.ok(first.signal || first.code !== 0, 'the runner was killed');
  assert.equal(c.stub.calls.length, 1);
  assert.equal(c.job().attempts[0].phase, 'dispatched');
  assert.ok(fs.existsSync(c.captureFile()));
  await runner(c.root, c.stub);
  assertSavedOnce(c);
  await runner(c.root, c.stub);
  await runner(c.root, c.stub);
  assertSavedOnce(c);
});

test('F1 killed after the commit, before the capture was removed: the leftover capture is cleared and nothing is applied twice', async (t) => {
  const c = await paidRun(t, 'f1after');
  await runner(c.root, c.stub, { crash: { op: 'research_response', when: 'after' } });
  assert.equal(c.job().attempts[0].phase, 'responded');
  assert.ok(fs.existsSync(c.captureFile()), 'the capture outlived the commit');
  assert.equal(c.job().attempts[0].capture_sha256.length, 64);
  await runner(c.root, c.stub);
  await runner(c.root, c.stub);
  assertSavedOnce(c);
});

test('F1 capture write fails but the commit works: saved normally, the capture failure is recorded', async (t) => {
  const c = await paidRun(t, 'f1cfok');
  const first = await runner(c.root, c.stub, { capture: { fail: 'EIO' } });
  assert.equal(first.out.results[0].status, 'completed');
  assertSavedOnce(c);
  assert.match(c.job().attempts[0].capture_error, /capture write refused/);
});

test('F1 capture write fails and the commit cannot run: reported honestly, never resent, held as uncertain', async (t) => {
  const c = await paidRun(t, 'f1cfail');
  const block = c.ws.abs('.cr/blocked.json');
  c.stub.set(async () => {
    fs.writeFileSync(block, JSON.stringify({ op_id: 'op_test_block', reason: 'test block' }));
    return { status: 200, json: claudeAnswer(c.text) };
  });
  const first = await runner(c.root, c.stub, { capture: { fail: 'ENOSPC' } });
  const r1 = first.out.results[0];
  assert.equal(r1.status, 'unsaved', JSON.stringify(r1));
  assert.match(r1.error, /could not be captured/);
  assert.match(r1.error, /not resent automatically/);
  assert.equal(first.out.status, 'attention');
  assert.equal(c.job().state, 'dispatching', 'not requeued');
  fs.unlinkSync(block);
  await runner(c.root, c.stub);
  await runner(c.root, c.stub);
  assert.equal(c.stub.calls.length, 1, 'never resent');
  assert.equal(c.job().state, 'uncertain');
  assert.equal(c.reports().length, 0);
  assert.equal(c.spent(), c.job().attempts[0].reserved_usd, 'counted at its reservation until reconciled');
});

test('F1 a damaged or mismatched capture is never imported: held as uncertain and kept for inspection', async (t) => {
  for (const damage of ['truncate', 'other-prompt']) {
    const c = await paidRun(t, `f1dmg-${damage}`);
    await runner(c.root, c.stub, { capture: { crash: 'after' } });
    const file = c.captureFile();
    const buf = fs.readFileSync(file);
    if (damage === 'truncate') fs.writeFileSync(file, buf.subarray(0, Math.floor(buf.length / 2)));
    else {
      // A well-formed capture that answers a different prompt.
      const captures = require('../core/captures');
      const doc = JSON.parse(buf);
      doc.body.prompt_sha256 = 'f'.repeat(64);
      fs.writeFileSync(file, captures.encode(doc.body));
    }
    await runner(c.root, c.stub);
    await runner(c.root, c.stub);
    assert.equal(c.stub.calls.length, 1, `${damage}: never resent`);
    const a = c.job().attempts[0];
    assert.equal(c.job().state, 'uncertain', damage);
    assert.equal(a.unmatched_capture_path, `.cr/captures/${a.attempt_id}.json`);
    assert.ok(fs.existsSync(file), `${damage}: kept for inspection`);
    assert.equal(c.reports().length, 0);
    const doc = await require('../core/doctor').doctor(c.ws);
    assert.ok(doc.checks.some((x) => x.name === 'Research captures' && /do not match/.test(x.detail)), `${damage}: doctor says so`);
  }
});

test('F1 capture files: whole or absent, concurrent writers of the same attempt agree, a different answer is a kept conflict', async (t) => {
  const c = await paidRun(t, 'f1unit');
  const captures = require('../core/captures');
  const run = c.run.run;
  const attempt = { n: 1, attempt_id: 'att_2026-10-02T000000Z_testab' };
  const args = (text) => ({ run, provider: 'claude', attempt, result: { text, attested: { model: 'm' }, usage: { input_tokens: 1, output_tokens: 1 }, raw: '{}' }, finishedAt: '2026-10-02T00:00:00.000Z', mode: 'api' });
  // Unfinished temporary files are never read.
  fs.mkdirSync(captures.captureDir(c.ws), { recursive: true });
  fs.writeFileSync(path.join(captures.captureDir(c.ws), `.${attempt.attempt_id}.tmp-1-abcd`), '{"half":');
  assert.deepEqual(captures.listCaptures(c.ws), []);
  // Four processes capture the same answer at once: one file, all agree.
  const script = `const c=require(${JSON.stringify(require.resolve('../core/captures'))});const ws=require(${JSON.stringify(require.resolve('../core/workspace'))}).openWorkspace({root:process.argv[1],actor:'w'});const a=JSON.parse(process.argv[2]);const go=Date.now()+300;while(Date.now()<go);try{const r=c.writeCapture(ws,a);process.stdout.write(JSON.stringify({ok:true,already:r.already,sha:r.sha256}))}catch(e){process.stdout.write(JSON.stringify({ok:false,code:e.code}))}`;
  const spawnWriter = (a) => new Promise((resolve) => {
    const ch = cp.spawn(process.execPath, ['-e', script, c.root, JSON.stringify(a)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.on('exit', () => resolve(JSON.parse(out)));
  });
  const same = await Promise.all([1, 2, 3, 4].map(() => spawnWriter(args('the same answer, long enough to matter'))));
  assert.ok(same.every((r) => r.ok), JSON.stringify(same));
  assert.equal(same.filter((r) => !r.already).length, 1, 'exactly one writer placed the file');
  const listed = captures.listCaptures(c.ws);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].ok, true);
  // A different answer for the same attempt: conflict, both kept, nothing replaced.
  const before = fs.readFileSync(path.join(captures.captureDir(c.ws), `${attempt.attempt_id}.json`));
  assert.throws(() => captures.writeCapture(c.ws, args('a different answer')), (e) => e.code === 'CAPTURE_CONFLICT');
  assert.ok(fs.readFileSync(path.join(captures.captureDir(c.ws), `${attempt.attempt_id}.json`)).equals(before));
  assert.equal(fs.readdirSync(captures.captureDir(c.ws)).filter((f) => f.startsWith('conflict-')).length, 1);
  // Binding: only the attempt it names.
  const cap = captures.readCapture(c.ws, attempt.attempt_id);
  assert.equal(captures.bindCapture(cap, run, 'claude', attempt).ok, true);
  assert.equal(captures.bindCapture(cap, run, 'chatgpt', attempt).ok, false);
  assert.equal(captures.bindCapture(cap, run, 'claude', { n: 2, attempt_id: attempt.attempt_id }).ok, false);
  assert.equal(captures.bindCapture(cap, run, 'claude', { n: 1, attempt_id: 'att_2026-10-02T000000Z_other1' }).ok, false);
  assert.throws(() => captures.writeCapture(c.ws, { ...args('x'), attempt: { n: 1, attempt_id: '../escape' } }), (e) => e.code === 'CAPTURE_BAD_ID');
  // A stopped writer's temporary file is cleared once it is old; a fresh one is left alone.
  const dir = captures.captureDir(c.ws);
  const old = path.join(dir, `.${attempt.attempt_id}.tmp-1-abcd`);
  const fresh = path.join(dir, `.${attempt.attempt_id}.tmp-2-ef01`);
  fs.writeFileSync(fresh, '{"half":');
  const twoHoursAgo = new Date(Date.now() - 7200000);
  fs.utimesSync(old, twoHoursAgo, twoHoursAgo);
  research.sweepCaptures(c.ws);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
});

// --- Windows file-system conditions (RC validation on Windows, 2026-10-02) ---

test('F1 Windows: a volume without hard links that refuses the link with EISDIR (how Node reports Win32 ERROR_INVALID_FUNCTION) still captures, and the answer is saved once', async (t) => {
  const c = await paidRun(t, 'f1eisdir');
  const block = c.ws.abs('.cr/blocked.json');
  c.stub.set(async () => {
    fs.writeFileSync(block, JSON.stringify({ op_id: 'op_test_block', reason: 'test block' }));
    return { status: 200, json: claudeAnswer(c.text) };
  });
  const first = await runner(c.root, c.stub, { fs: { link_error: 'EISDIR' } });
  const r1 = first.out.results[0];
  assert.equal(r1.status, 'captured', `the exclusive-create fallback placed the capture (got ${JSON.stringify(r1)})`);
  assert.ok(fs.existsSync(c.captureFile()));
  fs.unlinkSync(block);
  await runner(c.root, c.stub);
  assertSavedOnce(c);
});

// A flag file: while it exists, the runner child cannot read finished captures (EBUSY).
function busyFlag(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-busy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'capture-busy');
  fs.writeFileSync(file, '1');
  return file;
}

test('F1 Windows: a capture held open without read sharing when it is read back (an exclusive scan) still counts: the commit records it, and no stale capture or warning is left', async (t) => {
  // The commit works.
  const c = await paidRun(t, 'f1busy1');
  const busy = busyFlag(t);
  const first = await runner(c.root, c.stub, { fs: { capture_read_busy_while: busy } });
  assert.equal(first.out.results[0].status, 'completed', JSON.stringify(first.out));
  const a = c.job().attempts[0];
  assert.equal(a.capture_sha256 && a.capture_sha256.length, 64, `the commit recorded the capture (capture_error: ${a.capture_error || 'none'})`);
  fs.unlinkSync(busy);
  await runner(c.root, c.stub);
  assertSavedOnce(c);
  const doc = await require('../core/doctor').doctor(c.ws);
  assert.deepEqual(doc.checks.filter((x) => x.name === 'Research captures'), [], 'doctor has nothing to report');
  // The commit cannot run either: reported as captured, saved by the next run.
  const d = await paidRun(t, 'f1busy2');
  const block = d.ws.abs('.cr/blocked.json');
  d.stub.set(async () => {
    fs.writeFileSync(block, JSON.stringify({ op_id: 'op_test_block', reason: 'test block' }));
    return { status: 200, json: claudeAnswer(d.text) };
  });
  const busy2 = busyFlag(t);
  const r1 = (await runner(d.root, d.stub, { fs: { capture_read_busy_while: busy2 } })).out.results[0];
  assert.equal(r1.status, 'captured', JSON.stringify(r1));
  fs.unlinkSync(busy2);
  fs.unlinkSync(block);
  await runner(d.root, d.stub);
  assertSavedOnce(d);
});

test('F1 Windows: a pending capture that another program still holds during recovery is tried again on the next run, not held as uncertain', async (t) => {
  const c = await paidRun(t, 'f1busy3');
  await runner(c.root, c.stub, { capture: { crash: 'after' } });
  assert.equal(c.job().attempts[0].phase, 'dispatched');
  assert.ok(fs.existsSync(c.captureFile()));
  const busy = busyFlag(t);
  const r2 = (await runner(c.root, c.stub, { fs: { capture_read_busy_while: busy } })).out.results[0];
  assert.equal(r2.status, 'captured', JSON.stringify(r2));
  assert.equal(c.job().attempts[0].phase, 'dispatched', 'still waiting for its captured answer, not uncertain');
  // Doctor, while the file cannot be read: it is in use, not unmatched.
  const readFileSync = fs.readFileSync;
  fs.readFileSync = function busyRead(p, ...rest) {
    if (typeof p === 'string' && /[\\/]\.cr[\\/]captures[\\/][^\\/.][^\\/]*$/.test(p)) throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${p}'`), { code: 'EBUSY' });
    return readFileSync.call(fs, p, ...rest);
  };
  let doc;
  try {
    doc = await require('../core/doctor').doctor(c.ws);
  } finally {
    fs.readFileSync = readFileSync;
  }
  const checks = doc.checks.filter((x) => x.name === 'Research captures');
  assert.equal(checks.length, 1, JSON.stringify(checks));
  assert.match(checks[0].detail, /open in another program/);
  assert.doesNotMatch(checks[0].detail, /never imported/);
  fs.unlinkSync(busy);
  await runner(c.root, c.stub);
  assertSavedOnce(c);
});

// --- Spend log under a save that fails after its build step (review R8) ---

test('F1 spend log: an outcome whose save fails after the cost line is written, then saved from the capture and recovered again, leaves exactly one actual-cost line', async (t) => {
  const c = await paidRun(t, 'f1ledger');
  const first = await runner(c.root, c.stub, { crash: { op: 'research_response', when: 'fail_after_build' } });
  const r1 = first.out.results[0];
  assert.equal(r1.status, 'captured', JSON.stringify(r1));
  assert.equal(c.job().attempts[0].phase, 'dispatched', 'nothing was committed');
  assert.equal(c.ledger('actual').length, 1, 'the failed save had already appended its actual-cost line');
  // Retry, then restart recovery twice more.
  await runner(c.root, c.stub);
  await runner(c.root, c.stub);
  await runner(c.root, c.stub);
  assertSavedOnce(c); // one request, one report, one actual line, spend = actual
  const lines = c.ledger();
  assert.equal(lines.filter((l) => l.kind === 'reservation').length, 1, 'one reservation line');
  assert.equal(lines.filter((l) => l.kind === 'adjustment').length, 0, 'no adjustment for the same amount');
  assert.equal(lines.length, 2, JSON.stringify(lines.map((l) => l.kind)));
});

test('F1 spend log: a later save of the same outcome keeps the cost frozen at reservation; where it does differ (an older record priced at current settings) it is an explicit adjustment and counts once', async (t) => {
  const research2 = { providers: { claude: { ...CLAUDE, output_usd_per_mtok: 30 } }, budget: { per_run_usd: 5, daily_usd: 20, monthly_usd: 100 }, max_output_tokens: 8000, max_attempts: 2, timeout_seconds: 60 };
  // Prices frozen on the attempt: a price change before the retry changes nothing.
  const f = await paidRun(t, 'f1frozen');
  await runner(f.root, f.stub, { crash: { op: 'research_response', when: 'fail_after_build' } });
  configure(f.root, research2);
  await runner(f.root, f.stub);
  await runner(f.root, f.stub);
  assertSavedOnce(f);
  assert.equal(f.ledger('adjustment').length, 0);
  // An attempt without frozen prices (written by older code) is priced at the
  // current settings, so the retried save computes a different cost.
  const c = await paidRun(t, 'f1adjust');
  await runner(c.root, c.stub, { crash: { op: 'research_response', when: 'fail_after_build' } });
  assert.equal(c.ledger('actual').length, 1);
  assert.equal(c.ledger('actual')[0].actual_usd, ACTUAL);
  const runFile = c.ws.abs(`projects/${c.pid}/research/${c.run.run_id}/run.json`);
  const doc = readJson(runFile);
  delete doc.jobs.claude.attempts[0].prices;
  atomicWrite(runFile, jsonText(doc));
  configure(c.root, research2);
  await runner(c.root, c.stub);
  await runner(c.root, c.stub);
  // 12000 x $3/M + 3000 x $30/M + 2 x $0.01
  const corrected = 0.146;
  const j = c.job();
  assert.equal(c.stub.calls.length, 1, 'exactly one request reached the provider');
  assert.equal(j.state, 'completed', j.error || '');
  assert.equal(j.attempts[0].cost_actual_usd, corrected);
  assert.equal(c.reports().length, 1);
  assert.equal(c.ledger('actual').length, 1, 'the first actual line is kept as written');
  const adj = c.ledger('adjustment');
  assert.equal(adj.length, 1, 'the correction is one explicit adjustment line');
  assert.equal(adj[0].actual_usd, corrected);
  assert.equal(adj[0].replaces_actual_usd, ACTUAL);
  assert.equal(c.spent(), corrected, 'the attempt counts once, at the corrected cost');
});
