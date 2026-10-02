'use strict';
// Interrupted paid attempts (audit V2-003). A real runner process is killed at
// each point of a paid attempt; a fresh runner process then continues. The
// "provider" is a local stub server, so the number of requests that reached it
// is counted where it happens. Keys are fake test values and every provider
// URL is rewritten to 127.0.0.1: nothing leaves this PC.
//
// Windows and expected outcomes:
//   1 after the reservation, before the dispatch marker  -> released, sent once on restart
//   2 after the dispatch marker, before the request       -> uncertain, held (the ambiguous window)
//   3 while the provider has the request                  -> uncertain, never resent by itself
//   4 after the answer arrived and was captured, before it was saved -> saved on restart (F1)
//   4b after the answer arrived, before it was captured   -> uncertain, never resent by itself
//   5 after the answer and its pointer were saved          -> imported on restart, no new request
//   6 an older runner's answer file without a pointer     -> validated and imported, no new request

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
const ops = require('../core/ops');
const { mockReport } = require('../core/demo');
const { readJson, atomicWrite, jsonText, readJsonLines, sha256 } = require('../core/fsx');
const { openWorkspace } = require('../core/workspace');

const CHILD = path.join(__dirname, 'children', 'child-research-runner.js');
const FAKE_KEY = 'test-key-not-real-0000';

function configure(root, research) {
  const file = path.join(root, 'config', 'settings.json');
  const s = readJson(file);
  s.research = research;
  atomicWrite(file, jsonText(s));
  return openWorkspace({ root, actor: 'test' });
}

const CLAUDE = { model: 'claude-test-model', input_usd_per_mtok: 3, output_usd_per_mtok: 15, search_usd_per_call: 0.01, max_searches: 5 };

function claudeAnswer(text, usage = {}) {
  return { id: 'msg_stub_1', model: 'claude-test-model', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: usage.input ?? 12000, output_tokens: usage.output ?? 3000, server_tool_use: { web_search_requests: usage.searches ?? 2 } } };
}

// A local stand-in for the provider. behavior(call) returns 'hang', 'reset',
// or { status, json }.
async function stubProvider() {
  const calls = [];
  const sockets = new Set();
  let behavior = () => ({ status: 500, json: { error: { message: 'no behavior set' } } });
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const call = { path: req.url, body: body ? JSON.parse(body) : null, at: Date.now() };
      calls.push(call);
      server.emit('call', call);
      const b = behavior(call);
      if (b === 'hang') return;
      if (b === 'reset') {
        req.socket.destroy();
        return;
      }
      res.writeHead(b.status, { 'content-type': 'application/json', 'request-id': 'req_stub_1' });
      res.end(JSON.stringify(b.json));
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    calls,
    server,
    set(fn) { behavior = fn; },
    close() {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

// One runner process. crash: { op, when } kills it at that point; killOnCall
// kills it as soon as the stub receives a request.
function runner(root, stub, { crash = null, killOnCall = false, capture = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-runner-'));
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ stub_port: stub.port, crash, capture }));
  return new Promise((resolve) => {
    const child = cp.spawn(process.execPath, [CHILD, root, cfgFile], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ANTHROPIC_API_KEY: FAKE_KEY, OPENAI_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '' } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const onCall = () => child.kill('SIGKILL');
    if (killOnCall) stub.server.once('call', onCall);
    child.on('exit', (code, signal) => {
      stub.server.removeListener('call', onCall);
      fs.rmSync(dir, { recursive: true, force: true });
      let json = null;
      try { json = JSON.parse(out); } catch (_) { /* killed */ }
      resolve({ code, signal, out: json, err });
    });
  });
}

async function paidRun(t, label, budget = { per_run_usd: 5, daily_usd: 20, monthly_usd: 100 }) {
  const { root, cleanup } = tempWorkspace(label);
  t.after(cleanup);
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = FAKE_KEY;
  t.after(() => { if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev; });
  let ws = openWorkspace({ root, actor: 'test' });
  const pid = addFixtureProject(ws).project_id;
  ws = configure(root, { providers: { claude: CLAUDE }, budget, max_output_tokens: 8000, max_attempts: 2, timeout_seconds: 30 });
  assert.equal(research.providerStatus(ws).claude.mode, 'api');
  const run = research.createRun(ws, { project_id: pid, providers: ['claude'] });
  assert.equal(run.run.jobs.claude.state, 'queued');
  const text = mockReport(ws, 'claude', run.run).replace('FICTIONAL demo fixture standing in for Claude', 'Claude (Anthropic)');
  const stub = await stubProvider();
  t.after(() => stub.close());
  stub.set(() => ({ status: 200, json: claudeAnswer(text) }));
  const job = () => research.loadRun(ws, pid, run.run_id).jobs.claude;
  const reports = () => indexer.projectDetail(ws, pid).reports.filter((r) => r.provenance.research_run_id === run.run_id);
  const spent = () => research.spendSoFar(ws, new Date(), { runId: run.run_id }).run;
  return { root, ws, pid, run, text, stub, job, reports, spent };
}

test('V2-003 window 1: killed after the reservation, before the dispatch marker: released and sent once on restart', async (t) => {
  const c = await paidRun(t, 'w1');
  const first = await runner(c.root, c.stub, { crash: { op: 'research_admit', when: 'after' } });
  assert.equal(first.signal || first.code !== 0 ? 'killed' : 'ran', 'killed');
  assert.equal(c.stub.calls.length, 0);
  assert.equal(c.job().state, 'dispatching');
  assert.equal(c.job().attempts[0].phase, 'reserved');
  assert.ok(c.spent() > 0, 'the reservation counts while it is open');
  const second = await runner(c.root, c.stub);
  assert.equal(second.code, 0, second.err);
  assert.equal(c.stub.calls.length, 1, 'sent exactly once');
  const j = c.job();
  assert.equal(j.state, 'completed');
  assert.deepEqual(j.attempts.map((a) => a.phase), ['not_sent', 'imported']);
  assert.equal(c.reports().length, 1);
  assert.equal(c.spent(), j.attempts[1].cost_actual_usd, 'the released reservation counts nothing');
  const lines = readJsonLines(c.ws.abs('logs/research-spend.jsonl'));
  assert.ok(lines.some((l) => l.attempt === 1 && l.kind === 'release' && l.actual_usd === 0), 'older code reading the ledger also counts $0 for attempt 1');
});

test('V2-003 window 2: killed after the dispatch marker, before the request: held as uncertain, never sent by itself', async (t) => {
  const c = await paidRun(t, 'w2');
  await runner(c.root, c.stub, { crash: { op: 'fetch', when: 'before' } });
  assert.equal(c.stub.calls.length, 0, 'the request never left');
  for (let i = 0; i < 2; i++) {
    const r = await runner(c.root, c.stub);
    assert.equal(r.code, 0, r.err);
  }
  assert.equal(c.stub.calls.length, 0, 'restarts never send it');
  const j = c.job();
  assert.equal(j.state, 'uncertain');
  assert.equal(j.attempts.length, 1);
  assert.equal(j.attempts[0].phase, 'uncertain');
  assert.match(j.error, /may have reached the provider|may have been billed/);
  const reserved = j.attempts[0].reserved_usd;
  assert.equal(c.spent(), reserved, 'counted at its reservation until reconciled');
  // The owner checks the provider's usage page and records "not charged".
  const rec = research.reconcileAttempt(c.ws, c.pid, c.run.run_id, 'claude', { not_charged: true, reason: 'test: usage page shows no request' });
  assert.equal(rec.status, 'saved');
  assert.equal(c.spent(), 0);
  assert.equal(c.job().state, 'failed');
  assert.equal(c.job().attempts[0].phase, 'reconciled');
  assert.throws(() => research.reconcileAttempt(c.ws, c.pid, c.run.run_id, 'claude', { attempt: 1, charged_usd: 0.5, reason: 'changed my mind' }), (e) => e.code === 'CONFLICT');
});

test('V2-003 window 3: killed while the provider has the request: uncertain, kept, and only an explicit retry asks again', async (t) => {
  const c = await paidRun(t, 'w3');
  c.stub.set(() => 'hang');
  const first = await runner(c.root, c.stub, { killOnCall: true });
  assert.ok(first.signal || first.code !== 0, 'killed mid-request');
  assert.equal(c.stub.calls.length, 1);
  c.stub.set(() => ({ status: 200, json: claudeAnswer(c.text) }));
  await runner(c.root, c.stub);
  await runner(c.root, c.stub);
  assert.equal(c.stub.calls.length, 1, 'no automatic second request');
  let j = c.job();
  assert.equal(j.state, 'uncertain');
  const held = j.attempts[0].reserved_usd;
  assert.equal(c.spent(), held);
  // An explicit retry: a new attempt, reserved separately; the old one still counts.
  const retry = research.retryJob(c.ws, c.pid, c.run.run_id, 'claude');
  assert.match(retry.message, /stays counted/);
  const again = await runner(c.root, c.stub);
  assert.equal(again.code, 0, again.err);
  assert.equal(c.stub.calls.length, 2);
  j = c.job();
  assert.equal(j.state, 'completed');
  assert.deepEqual(j.attempts.map((a) => a.phase), ['uncertain', 'imported']);
  assert.equal(c.spent(), Math.round((held + j.attempts[1].cost_actual_usd) * 10000) / 10000);
  assert.equal(c.reports().length, 1);
});

test('V2-003 window 4 (revised for F1): killed after the answer arrived and was captured, before it was saved: saved on restart, never resent', async (t) => {
  const c = await paidRun(t, 'w4');
  await runner(c.root, c.stub, { crash: { op: 'research_response', when: 'before' } });
  assert.equal(c.stub.calls.length, 1);
  assert.equal(fs.existsSync(c.ws.abs(`projects/${c.pid}/research/${c.run.run_id}/responses/claude-attempt1.json`)), false, 'nothing was saved into the records');
  assert.equal(c.job().attempts[0].phase, 'dispatched');
  assert.equal(fs.existsSync(c.ws.abs(`.cr/captures/${c.job().attempts[0].attempt_id}.json`)), true, 'the answer was captured before the commit');
  await runner(c.root, c.stub);
  await runner(c.root, c.stub);
  assert.equal(c.stub.calls.length, 1, 'no second request');
  assert.equal(c.job().state, 'completed');
  assert.equal(c.job().attempts[0].phase, 'imported');
  assert.equal(c.reports().length, 1);
  assert.equal(fs.existsSync(c.ws.abs(`.cr/captures/${c.job().attempts[0].attempt_id}.json`)), false, 'the capture is removed after the verified commit');
});

test('V2-003 window 4b: killed after the answer arrived, before it was captured: uncertain, never resent by itself', async (t) => {
  const c = await paidRun(t, 'w4b');
  await runner(c.root, c.stub, { capture: { crash: 'before' } });
  assert.equal(c.stub.calls.length, 1);
  await runner(c.root, c.stub);
  await runner(c.root, c.stub);
  assert.equal(c.stub.calls.length, 1);
  assert.equal(c.job().state, 'uncertain');
  assert.equal(c.reports().length, 0);
  assert.equal(c.spent(), c.job().attempts[0].reserved_usd);
});

test('V2-003 window 5: killed after the answer and its pointer were saved: imported on restart without a new request', async (t) => {
  const c = await paidRun(t, 'w5');
  await runner(c.root, c.stub, { crash: { op: 'research_response', when: 'after' } });
  assert.equal(c.stub.calls.length, 1);
  const respAbs = c.ws.abs(`projects/${c.pid}/research/${c.run.run_id}/responses/claude-attempt1.json`);
  const savedBefore = fs.readFileSync(respAbs);
  const r = await runner(c.root, c.stub);
  assert.equal(r.code, 0, r.err);
  await runner(c.root, c.stub);
  assert.equal(c.stub.calls.length, 1, 'no second request');
  const a = c.job().attempts[0];
  const j = c.job();
  assert.equal(j.state, 'completed');
  assert.equal(j.attempts.length, 1);
  assert.equal(j.attempts[0].phase, 'imported');
  assert.equal(c.reports().length, 1);
  assert.ok(fs.readFileSync(respAbs).equals(savedBefore), 'the saved original is unchanged');
  assert.equal(a.response_path, `projects/${c.pid}/research/${c.run.run_id}/responses/claude-attempt1.json`);
  assert.equal(c.spent(), j.attempts[0].cost_actual_usd);
});

// The state an older runner leaves when it dies between saving an answer and
// recording a pointer to it (audit V2-003 reproduction): job "running", the
// attempt unfinished, the answer at its deterministic path.
function legacyCrashState(c, { tamper = false } = {}) {
  const runRel = `projects/${c.pid}/research/${c.run.run_id}/run.json`;
  const respRel = `projects/${c.pid}/research/${c.run.run_id}/responses/claude-attempt1.json`;
  const startedAt = new Date().toISOString();
  const payload = {
    schema_version: 'cr.research-response.v1',
    run_id: c.run.run_id,
    provider: 'claude',
    attempt: 1,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    mode: 'api',
    prompt_sha256: tamper ? sha256('a different prompt') : c.run.run.prompt.sha256,
    evidence_packet_sha256: c.run.run.evidence_packet.sha256,
    attested: { provider: 'anthropic', model: 'claude-test-model', response_id: 'msg_legacy_1', request_id: 'req_legacy_1', stop_reason: 'end_turn' },
    usage: { input_tokens: 12000, output_tokens: 3000, search_calls: 2 },
    cost_estimate_usd: 0.3,
    cost_actual_usd: 0.101,
    error: null,
    text: c.text,
    raw_response: '{}',
  };
  ops.runOp(c.ws, { type: 'legacy_fixture', summary: 'state left by an older runner' }, (op) => {
    const doc = op.readJson(runRel);
    doc.jobs.claude.state = 'running';
    doc.jobs.claude.attempts = [{ n: 1, started_at: startedAt, finished_at: null, outcome: null, model: 'claude-test-model', cost_estimate_usd: 0.3 }];
    op.writeJson(runRel, doc);
    op.write(respRel, `${JSON.stringify(payload, null, 2)}\n`);
  });
  return respRel;
}

test('V2-003 window 6: an older runner\'s saved answer without a pointer is validated and imported; a mismatched one is not', async (t) => {
  const c = await paidRun(t, 'w6');
  const respRel = legacyCrashState(c);
  const original = fs.readFileSync(c.ws.abs(respRel));
  const r = await runner(c.root, c.stub);
  assert.equal(r.code, 0, r.err);
  await runner(c.root, c.stub);
  assert.equal(c.stub.calls.length, 0, 'imported without sending anything');
  const j = c.job();
  assert.equal(j.state, 'completed');
  assert.equal(j.attempts[0].phase, 'imported');
  assert.match(j.attempts[0].recovered_from, /saved response found/);
  assert.equal(c.reports().length, 1);
  assert.ok(fs.readFileSync(c.ws.abs(respRel)).equals(original));
  assert.equal(c.spent(), 0.101, 'its recorded usage is priced');

  const d = await paidRun(t, 'w6bad');
  legacyCrashState(d, { tamper: true });
  await runner(d.root, d.stub);
  await runner(d.root, d.stub);
  assert.equal(d.stub.calls.length, 0);
  const jd = d.job();
  assert.equal(jd.state, 'uncertain', 'a file that does not match its attempt is never imported');
  assert.match(jd.error, /does not match this attempt \(prompt hash\)/);
  assert.equal(d.reports().length, 0);
});

test('V2-003 older records: a paid job left "running" with no saved answer is held, not requeued', async (t) => {
  const c = await paidRun(t, 'legacy-running');
  const runRel = `projects/${c.pid}/research/${c.run.run_id}/run.json`;
  ops.runOp(c.ws, { type: 'legacy_fixture', summary: 'older runner died mid-call' }, (op) => {
    const doc = op.readJson(runRel);
    doc.jobs.claude.state = 'running';
    doc.jobs.claude.attempts = [{ n: 1, started_at: new Date().toISOString(), finished_at: null, outcome: null, model: 'claude-test-model', cost_estimate_usd: 0.3 }];
    op.writeJson(runRel, doc);
  });
  await runner(c.root, c.stub);
  await runner(c.root, c.stub);
  assert.equal(c.stub.calls.length, 0, 'the older code requeued here and sent a second request');
  assert.equal(c.job().state, 'uncertain');
  assert.equal(c.spent(), 0.3);
});

test('V2-003 connection never made: the attempt is released, not uncertain', async (t) => {
  const c = await paidRun(t, 'refused');
  const refused = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' }) }); };
  const out = await research.runDueJobs(c.ws, { fetchImpl: refused });
  assert.equal(out.results[0].status, 'not_sent');
  let j = c.job();
  assert.equal(j.attempts[0].phase, 'not_sent');
  assert.equal(j.state, 'queued', 'requeued within max_attempts');
  assert.equal(c.spent(), 0);
  // A timeout after the request started is different: uncertain.
  const timeout = async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); };
  const out2 = await research.runDueJobs(c.ws, { fetchImpl: timeout });
  assert.equal(out2.results[0].status, 'uncertain');
  j = c.job();
  assert.equal(j.state, 'uncertain');
  assert.equal(c.spent(), j.attempts[1].reserved_usd);
  const again = await research.runDueJobs(c.ws, { fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.equal(again.status, 'noop', 'an uncertain job is not due');
});
