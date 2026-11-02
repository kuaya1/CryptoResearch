'use strict';
// The multi-project pilot runner (scripts/pilot.js --pilot-all) and its
// zero-token pre-poll route (core/pilot-poll.js, GET /api/pilot/queue).
// Autonomous paper playbook, Stage 11. Stubs only: no claude -p is spawned,
// no desk is reached; the lock and the log go to a temporary folder.
// FICTIONAL projects and tokens.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const P = require('../scripts/pilot');
const { tempWorkspace, addFixtureProject, importAllFixtures } = require('./helpers');

function dirs(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pilot-all-test-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return { lockFile: path.join(d, 'pilot-all.lock'), logFile: path.join(d, 'pilot-all.jsonl') };
}
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// A fake desk for the local path: each project's queue moves from its step to
// pm_review once its agent has saved.
function fakeDesk(steps, { claims = {}, paused = false, claimAnswer = {} } = {}) {
  const state = new Map(steps.map((s) => [s.project_id, s.step]));
  const calls = [];
  const call = (args, { text = false } = {}) => {
    calls.push(args.join(' '));
    const [, sub, pid] = args;
    if (sub === 'queue') {
      const all = [...state.entries()].map(([project_id, step]) => ({ project_id, name: project_id, step, why: 'FICTIONAL', ticket_id: step === 'ticket' ? `tk_${project_id}` : null }));
      return { steps: pid ? all.filter((s) => s.project_id === pid) : all, pending: [], paused, claims };
    }
    if (sub === 'claim') return claimAnswer[pid] || { status: 'claimed_now', token: `tok_${pid}` };
    if (sub === 'start') return { status: 'created', ticket_id: `tk_${pid}`, message: 'opened' };
    if (sub === 'bind' || sub === 'release') return { status: 'ok' };
    // Before each import the runner asks whether Eric stopped the project
    // since the dispatch (tickets check, fix/stop-halts-pilot): not here.
    if (sub === 'check') return { status: 'ok' };
    if (sub === 'prompt') return text ? 'FICTIONAL PROMPT' : {};
    if (sub === 'import') { state.set(pid, 'pm_review'); return { status: 'saved', receipt_id: `tr_${pid}`, message: 'saved', verified: true }; }
    if (args[0] === 'research' && sub === 'add') return { status: 'created', run_id: `run_${pid}` };
    if (args[0] === 'research' && sub === 'prompt') return 'FICTIONAL RESEARCH PROMPT';
    if (args[0] === 'import-text') { state.set(args[args.indexOf('--project') + 1], 'ticket'); return { status: 'saved', report_id: 'r1', verified: true }; }
    throw new Error(`unexpected cli ${args.join(' ')}`);
  };
  return { call, calls, state };
}
const quiet = () => {};

test('a pre-poll that finds nothing to do spawns no claude and logs one line, exit 0', async (t) => {
  const d = dirs(t);
  const desk = fakeDesk([{ project_id: 'a-fictional', step: 'pm_review' }, { project_id: 'b-fictional', step: 'done' }]);
  let spawned = 0;
  const code = await P.runAll({ desk: 'local', maxAgents: 2 }, { ...d, call: desk.call, agent: () => { spawned += 1; return ''; }, out: quiet });
  assert.equal(code, 0);
  assert.equal(spawned, 0);
  assert.deepEqual(desk.calls, ['tickets queue'], 'only the pre-poll');
  const [log] = lines(d.logFile);
  assert.deepEqual([log.format, log.exit, log.polled.length, log.dispatches.length], ['cr-pilot-all@1', 0, 2, 0]);
  assert.equal(fs.existsSync(d.lockFile), false, 'the lock is let go');
});

test('paused: nothing is dispatched', async (t) => {
  const d = dirs(t);
  const desk = fakeDesk([{ project_id: 'a-fictional', step: 'ticket' }], { paused: true });
  let spawned = 0;
  const code = await P.runAll({ desk: 'local', maxAgents: 2 }, { ...d, call: desk.call, agent: () => { spawned += 1; return ''; }, out: quiet });
  assert.equal(code, 0);
  assert.equal(spawned, 0);
  assert.equal(lines(d.logFile)[0].paused, true);
});

test('the max-agents cap holds: two sessions, the third project waits; the ticket step goes first', async (t) => {
  const d = dirs(t);
  const desk = fakeDesk([{ project_id: 'r-fictional', step: 'research' }, { project_id: 'a-fictional', step: 'ticket' }, { project_id: 'b-fictional', step: 'ticket' }]);
  const order = [];
  const code = await P.runAll({ desk: 'local', maxAgents: 2 }, { ...d, call: desk.call, agent: (prompt) => { order.push(prompt); return '# FICTIONAL'; }, out: quiet });
  assert.equal(code, 0);
  assert.equal(order.length, 2, 'at most two claude -p sessions');
  const log = lines(d.logFile)[0];
  assert.deepEqual(log.dispatches.map((x) => [x.project_id, x.outcome]), [['a-fictional', 'done'], ['b-fictional', 'done'], ['r-fictional', 'cap']]);
  assert.deepEqual(log.dispatches.slice(0, 2).map((x) => x.next_step), ['pm_review', 'pm_review'], 'each project is polled again after its agent');
  assert.ok(!desk.calls.includes('research add r-fictional --providers claude --channel cowork --utterance autonomous pilot (npm run pilot)'));
});

test('a dry run dispatches nothing and says what it would do', async (t) => {
  const d = dirs(t);
  const desk = fakeDesk([{ project_id: 'a-fictional', step: 'ticket' }]);
  const said = [];
  const code = await P.runAll({ desk: 'local', maxAgents: 2, dryRun: true }, { ...d, call: desk.call, agent: () => { throw new Error('no agent in a dry run'); }, out: (s) => said.push(s) });
  assert.equal(code, 0);
  assert.ok(said.some((s) => /Would dispatch a-fictional: ticket/.test(s)));
  assert.deepEqual(desk.calls, ['tickets queue']);
});

test('the lock blocks a second run; one older than 3 hours is taken over', async (t) => {
  const d = dirs(t);
  fs.writeFileSync(d.lockFile, JSON.stringify({ pid: 999999, started_at: new Date().toISOString() }));
  const desk = fakeDesk([{ project_id: 'a-fictional', step: 'ticket' }]);
  const said = [];
  assert.equal(await P.runAll({ desk: 'local', maxAgents: 2 }, { ...d, call: desk.call, agent: () => '', out: (s) => said.push(s) }), 0);
  assert.match(said.join(' '), /Another run is in progress/);
  assert.deepEqual(desk.calls, [], 'not even the pre-poll');
  assert.equal(lines(d.logFile)[0].skipped, 'locked');
  fs.writeFileSync(d.lockFile, JSON.stringify({ pid: 999999, started_at: new Date(Date.now() - 4 * 3600000).toISOString() }));
  const said2 = [];
  await P.runAll({ desk: 'local', maxAgents: 2 }, { ...d, call: desk.call, agent: () => '# FICTIONAL', out: (s) => said2.push(s) });
  assert.match(said2.join(' '), /older than 3 hours; taken over/);
  assert.ok(desk.calls.includes('tickets queue'));
});

test('a dispatch that expired with no known outcome (reconcile) spawns nothing and exits 3; it is never released', async (t) => {
  const d = dirs(t);
  const polled = fakeDesk([{ project_id: 'a-fictional', step: 'ticket' }], { claims: { 'a-fictional': 'reconcile' } });
  let spawned = 0;
  assert.equal(await P.runAll({ desk: 'local', maxAgents: 2 }, { ...d, call: polled.call, agent: () => { spawned += 1; return ''; }, out: quiet }), 3);
  assert.equal(spawned, 0);
  assert.ok(!polled.calls.some((c) => /release/.test(c)));
  assert.equal(lines(d.logFile)[0].needs_eric[0].project_id, 'a-fictional');
  // The claim itself answers reconcile (the pre-poll did not see it): also 3.
  const d2 = dirs(t);
  const claimed = fakeDesk([{ project_id: 'b-fictional', step: 'ticket' }], { claimAnswer: { 'b-fictional': { status: 'reconcile', words: 'expired (FICTIONAL)' } } });
  assert.equal(await P.runAll({ desk: 'local', maxAgents: 2 }, { ...d2, call: claimed.call, agent: () => { spawned += 1; return ''; }, out: quiet }), 3);
  assert.equal(spawned, 0);
  assert.ok(!claimed.calls.some((c) => /release/.test(c)));
  // Held by another runner: skipped, not Eric's.
  const d3 = dirs(t);
  const held = fakeDesk([{ project_id: 'c-fictional', step: 'ticket' }], { claims: { 'c-fictional': 'claimed' } });
  assert.equal(await P.runAll({ desk: 'local', maxAgents: 2 }, { ...d3, call: held.call, agent: () => '', out: quiet }), 0);
});

test('online: the poll token goes only to the poll, the worker token only to the worker routes; neither is printed or reaches a session', async (t) => {
  const d = dirs(t);
  const TOKEN = 'FICTIONAL-poll-token-0123456789abcdef';
  const WORKER = 'FICTIONAL-worker-token-0123456789abcd';
  const seen = [];
  const polls = [{ paused: false, steps: [{ project_id: 'a-fictional', step: 'ticket', claim: null }] }, { paused: false, steps: [{ project_id: 'a-fictional', step: 'pm_review', claim: null }] }];
  const PROMPT = 'FROZEN PROSECUTOR PROMPT (FICTIONAL)';
  let claims = 0;
  const fetchImpl = async (url, init) => {
    seen.push({ url, auth: init.headers.authorization });
    const ok = (b) => ({ status: 200, ok: true, json: async () => b });
    if (url.endsWith('/api/pilot/queue')) return ok({ format: 'cr-pilot-poll@1', ...polls[Math.min(seen.filter((s) => s.url.endsWith('/queue')).length - 1, 1)] });
    const op = url.split('/').pop();
    const w = (b) => ok({ format: 'cr-pilot-worker@1', ...b });
    if (op === 'claim') return (claims += 1) === 1 ? w({ status: 'claimed_now', step: 'ticket', key: 'ticket:-', token: 'b'.repeat(20), attempt_id: 'pa_1', expires_at: '2099-01-01T00:00:00.000Z' }) : w({ status: 'nothing', step: 'pm_review' });
    if (op === 'prepare') return w({ status: 'prepared', role: 'prosecutor', attempt_id: 'pa_1', ticket_id: 'tk_FICTIONAL', prompt: PROMPT, prompt_sha256: crypto.createHash('sha256').update(PROMPT).digest('hex') });
    if (op === 'complete') return w({ status: 'saved', receipt_id: 'tr_FICTIONAL' });
    return { status: 404, ok: false, json: async () => ({}) };
  };
  const prompts = [];
  const said = [];
  const code = await P.runAll({ desk: 'online', maxAgents: 2, deskUrl: 'https://desk.example.org' }, { ...d, token: TOKEN, workerToken: WORKER, fetchImpl, agent: (prompt, opts) => { prompts.push({ prompt, tools: opts.tools }); return 'Ticket text (FICTIONAL).'; }, out: (s) => said.push(s) });
  assert.equal(code, 0);
  assert.deepEqual(prompts, [{ prompt: PROMPT, tools: P.WEB_TOOLS }], 'one Prosecutor session on the frozen prompt, web tools only; no researcher session on a ticket step');
  assert.equal(seen[0].url, 'https://desk.example.org/api/pilot/queue');
  for (const s of seen) assert.equal(s.auth, `Bearer ${s.url.endsWith('/api/pilot/queue') ? TOKEN : WORKER}`, s.url);
  for (const tok of [TOKEN, WORKER]) {
    assert.ok(!said.join('\n').includes(tok), 'never printed');
    assert.ok(!fs.readFileSync(d.logFile, 'utf8').includes(tok), 'nor logged');
    assert.ok(!prompts.some((p) => p.prompt.includes(tok)), 'nor given to a session');
  }
  assert.throws(() => P.deskUrlOf({ deskUrl: 'http://desk.example.org' }), /https origin/);
});

test('the poll token is read from secrets.json (pilot_poll_token)', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-secrets-test-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const f = path.join(d, 'secrets.json');
  fs.writeFileSync(f, JSON.stringify({ pilot_poll_token: 'FICTIONAL-poll-token-0123456789' }));
  assert.equal(P.readPollToken(f), 'FICTIONAL-poll-token-0123456789');
  fs.writeFileSync(f, JSON.stringify({}));
  assert.throws(() => P.readPollToken(f), /holds no pilot_poll_token/);
});

// --- The route.

const PP = require('../core/pilot-poll');
const TOKEN = 'FICTIONAL-poll-token-abcdef0123456789';
const DIGEST = crypto.createHash('sha256').update(TOKEN).digest('hex');

function fakeRes() {
  const r = { status: null, headers: null, body: null };
  r.writeHead = (s, h) => { r.status = s; r.headers = h; };
  r.end = (b) => { r.body = b ? JSON.parse(b) : null; };
  return r;
}
function poll(handle, auth) {
  const res = fakeRes();
  handle({ method: 'GET', headers: auth ? { authorization: auth } : {} }, res);
  return res;
}

test('the poll route: 404 unset, 401 on a wrong bearer, names and IDs only, and 60 an hour', (t) => {
  const w = tempWorkspace('pilot-poll');
  t.after(w.cleanup);
  const pid = addFixtureProject(w.ws).project_id;
  importAllFixtures(w.ws);
  const file = w.ws.abs(`projects/${pid}/tickets/profile.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema_version: 'cr.ticket-profile.v1', project_id: pid, pilot: true }));
  assert.equal(poll(PP.makePilotPollRoute(w.ws, { env: {} }), `Bearer ${TOKEN}`).status, 404);
  assert.equal(poll(PP.makePilotPollRoute(w.ws, { env: { CR_PILOT_POLL_TOKEN_SHA256: 'not-hex' } }), `Bearer ${TOKEN}`).status, 404);
  let t0 = Date.now();
  const handle = PP.makePilotPollRoute(w.ws, { env: { CR_PILOT_POLL_TOKEN_SHA256: DIGEST.toUpperCase() }, now: () => t0 });
  assert.equal(poll(handle, 'Bearer FICTIONAL-wrong-token-000000').status, 401);
  assert.equal(poll(handle, null).status, 401);
  const ok = poll(handle, `Bearer ${TOKEN}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.format, 'cr-pilot-poll@1');
  assert.equal(ok.body.paused, false);
  assert.equal(ok.body.steps.length, 1);
  assert.deepEqual(Object.keys(ok.body.steps[0]).sort(), ['claim', 'project_id', 'receipt_id', 'run_id', 'step', 'ticket_id']);
  assert.ok(!/why|prompt|settings|report text/i.test(JSON.stringify(ok.body)), 'no reasons, prompts or settings');
  // 60 accepted polls an hour; the two refused above are not among them.
  for (let i = 1; i < 60; i++) poll(handle, `Bearer ${TOKEN}`);
  const limited = poll(handle, `Bearer ${TOKEN}`);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['Retry-After']) > 0);
  t0 += 3600000;
  assert.equal(poll(handle, `Bearer ${TOKEN}`).status, 200, 'an hour later it answers again');
});

// Corrective PR, §4: a stranger's refused requests are throttled on their own
// allowance and never use up the runner's. Before the fix, 60 refused bearers
// left the runner's next poll at 429.
test('the poll route: refused bearers fill their own allowance, never the runner\'s', (t) => {
  const w = tempWorkspace('pilot-poll-abuse');
  t.after(w.cleanup);
  const t0 = Date.now();
  const handle = PP.makePilotPollRoute(w.ws, { env: { CR_PILOT_POLL_TOKEN_SHA256: DIGEST }, now: () => t0 });
  for (let i = 0; i < PP.LIMIT_PER_HOUR; i++) assert.equal(poll(handle, `Bearer FICTIONAL-wrong-token-${String(i).padStart(6, '0')}`).status, 401);
  const throttled = poll(handle, 'Bearer FICTIONAL-wrong-token-999999');
  assert.equal(throttled.status, 429, 'the 61st refused bearer in the hour is throttled');
  assert.equal(poll(handle, null).status, 429);
  assert.equal(poll(handle, `Bearer ${TOKEN}`).status, 200, 'the runner still polls');
});

test('through the server: the poll answers with no session token, before it; a POST is refused', async (t) => {
  const w = tempWorkspace('pilot-poll-srv');
  t.after(w.cleanup);
  const before = process.env.CR_PILOT_POLL_TOKEN_SHA256;
  process.env.CR_PILOT_POLL_TOKEN_SHA256 = DIGEST;
  t.after(() => { if (before === undefined) delete process.env.CR_PILOT_POLL_TOKEN_SHA256; else process.env.CR_PILOT_POLL_TOKEN_SHA256 = before; });
  const { start } = require('../server');
  const srv = await start(w.ws, { port: 47990 + Math.floor(Math.random() * 9), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } });
  const ask = (p, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: p, method, headers: { host: `127.0.0.1:${srv.port}`, ...headers } }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(Buffer.concat(c).toString()); } catch (_) { return null; } })() }));
    });
    req.on('error', reject);
    req.end();
  });
  const ok = await ask('/api/pilot/queue', { authorization: `Bearer ${TOKEN}` });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.format, 'cr-pilot-poll@1');
  assert.equal((await ask('/api/pilot/queue', { authorization: 'Bearer FICTIONAL-wrong-token-000000' })).status, 401);
  assert.equal((await ask('/api/pilot/queue', { authorization: `Bearer ${TOKEN}` }, 'POST')).status, 405);
  assert.equal((await ask('/api/index')).status, 401, 'every other route still needs the session token');
});

// ---------------------------------------------------------------------------
// The scheduled task's status, read only (scripts/pilot-task-status.js;
// bounded paper readiness A4). Task Scheduler's facts are FICTIONAL inputs, as
// pilot-task.ps1 -Status gathers them; the runner's log and lock are its own
// formats. A fixed clock: nothing here depends on the hour it runs.

const TS = require('../scripts/pilot-task-status');
const T_NOW = Date.parse('2027-01-15T15:20:00Z');
const T_MIN = 60000;
const isoAt = (ms) => new Date(ms).toISOString();
const taskFacts = (over = {}) => ({
  format: TS.FACTS_FORMAT, registered: true, ours: true, state: 'Ready', enabled: true,
  last_run_time: isoAt(T_NOW - 40 * T_MIN), last_task_result: 0, next_run_time: isoAt(T_NOW + 20 * T_MIN),
  time_limit: 'PT3H', launcher: 'job_wrapper', max_agents: 1, running: [], running_error: null, ...over,
});
const runLine = (startedAt, over = {}) => ({ ok: true, rec: { format: 'cr-pilot-all@1', started_at: isoAt(startedAt), finished_at: isoAt(startedAt + 3 * T_MIN), desk: 'online', max_agents: 1, polled: [], dispatches: [], needs_eric: [], error: null, exit: 0, ...over } });
const runLog = (...l) => ({ status: 'ok', code: null, lines: l });
const status = (f, o = {}) => TS.classify(f, { now: T_NOW, log: { status: 'absent', lines: [] }, lock: { status: 'absent' }, alive: () => false, ...o });
// A running instance: the launcher's process (Task Scheduler's engine) and its
// children, started at `at` (the node child about 0.7 s later, as measured).
const instance = (children = [{ pid: 4242, name: 'node.exe', started_at: isoAt(T_NOW - 70 * T_MIN + 700) }], at = T_NOW - 70 * T_MIN) => [{ engine_pid: 4200, engine_started_at: isoAt(at), children }];

test('task status: not registered, never run (another start\'s line never counts), and a long legitimate run is running, not stale', () => {
  assert.equal(status({ format: TS.FACTS_FORMAT, registered: false }).state, 'not_registered');
  const never = status(taskFacts({ state: 'Disabled', enabled: false, last_run_time: '1999-11-30T00:00:00.000Z', last_task_result: 0x41303 }), { log: runLog(runLine(T_NOW - 30 * T_MIN)) });
  assert.equal(never.state, 'never_run');
  assert.match(never.reason, /is another start's, not this task's/);
  assert.equal(never.task.last_result_means, 'has not run');
  // 70 minutes into a 3-hour limit; the log's last line is 2 hours old (a
  // healthy agent writes its line only when it finishes).
  const start = T_NOW - 70 * T_MIN;
  const long = status(taskFacts({ state: 'Running', last_run_time: isoAt(start), last_task_result: 0x41301, running: instance() }), {
    log: runLog(runLine(T_NOW - 120 * T_MIN)), lock: { status: 'ok', pid: 4242, started_at: isoAt(start + 900) }, alive: (pid) => pid === 4242,
  });
  assert.equal(long.state, 'running', long.reason);
  assert.match(long.reason, /110 min left before the time limit/);
  assert.equal(long.task.deadline, isoAt(start + 3 * 3600000));
  // Inside the start-up grace, before the runner's lock exists.
  const starting = status(taskFacts({ state: 'Running', last_run_time: isoAt(T_NOW - 30000), running: instance([], T_NOW - 30000) }));
  assert.equal(starting.state, 'running');
  assert.match(starting.reason, /start-up grace/);
});

test('task status: completed, needs Eric, failed, a failed start, a locked/skipped start, and a later skipped line never completing this start', () => {
  const at = T_NOW - 40 * T_MIN;
  const done = status(taskFacts({ last_task_result: 0 }), { log: runLog(runLine(at - 30 * T_MIN), runLine(at + 800, { dispatches: [{ outcome: 'done' }] })) });
  assert.deepEqual([done.state, done.runner.exit, done.runner.dispatches], ['completed', 0, 1], done.reason);
  const eric = status(taskFacts({ last_task_result: 3 }), { log: runLog(runLine(at + 800, { exit: 3, needs_eric: [{ project_id: 'xmpl' }] })) });
  assert.equal(eric.state, 'completed');
  assert.match(eric.reason, /1 project needs Eric \(exit 3\)/);
  const failed = status(taskFacts({ last_task_result: 1 }), { log: runLog(runLine(at + 800, { exit: 1, error: 'FICTIONAL words never printed' })) });
  assert.equal(failed.state, 'failed');
  assert.doesNotMatch(JSON.stringify(failed), /FICTIONAL words never printed/, 'no log text is printed');
  const badStart = status(taskFacts({ last_task_result: 90 }));
  assert.equal(badStart.state, 'failed');
  assert.match(badStart.reason, /could not start node/);
  const skipped = status(taskFacts({ last_task_result: 0 }), { log: runLog(runLine(at + 700, { skipped: 'locked' })) });
  assert.equal(skipped.state, 'completed');
  assert.match(skipped.reason, /another run holding the lock/);
  // A manual run that began 10 minutes after this start and skipped is not this start's result.
  const later = status(taskFacts({ last_task_result: 0 }), { log: runLog(runLine(at + 10 * T_MIN, { skipped: 'locked' })) });
  assert.equal(later.state, 'unknown');
  assert.equal(later.gap, true);
  assert.match(later.reason, /supervision gap; the runner's own result is not known/);
  // Task Scheduler and the runner disagree: never one picked.
  assert.equal(status(taskFacts({ last_task_result: 0 }), { log: runLog(runLine(at + 800, { exit: 1 })) }).state, 'unknown');
  // The old conhost launcher: its 0 is not the runner's.
  const conhost = status(taskFacts({ launcher: 'conhost', last_task_result: 0 }));
  assert.equal(conhost.gap, true);
  assert.match(conhost.reason, /conhost's result is not the runner's/);
});

test('task status: a termination is interrupted (a left lock is reported, never taken over), and a run past its limit is stale', () => {
  const at = T_NOW - 40 * T_MIN;
  const lock = { status: 'ok', pid: 5151, started_at: isoAt(at + 600) };
  const killed = status(taskFacts({ last_task_result: 0x41306 }), { lock, alive: () => false });
  assert.equal(killed.state, 'interrupted', killed.reason);
  assert.match(killed.reason, /Its lock is left as it is/);
  assert.deepEqual([killed.lock.held, killed.lock.owner_alive, killed.lock.this_start], [true, false, true]);
  assert.equal(status(taskFacts({ last_task_result: 0x41306 })).state, 'interrupted');
  const stale = status(taskFacts({ state: 'Running', last_run_time: isoAt(T_NOW - 4 * 3600000), running: instance(undefined, T_NOW - 4 * 3600000) }), { lock: { status: 'ok', pid: 4242, started_at: isoAt(T_NOW - 4 * 3600000 + 900) }, alive: () => true });
  assert.equal(stale.state, 'interrupted');
  assert.match(stale.reason, /past its time limit/);
  // Running with no lock long after the grace: said, never assumed fine.
  const noLock = status(taskFacts({ state: 'Running', last_run_time: isoAt(T_NOW - 20 * T_MIN), running: instance(undefined, T_NOW - 20 * T_MIN) }));
  assert.deepEqual([noLock.state, noLock.gap], ['unknown', true]);
  // A lock held by a process that is not this task's.
  const foreign = status(taskFacts({ state: 'Running', last_run_time: isoAt(T_NOW - 20 * T_MIN), running: instance(undefined, T_NOW - 20 * T_MIN) }), { lock: { status: 'ok', pid: 9999, started_at: isoAt(T_NOW - 20 * T_MIN + 500) }, alive: () => true });
  assert.equal(foreign.state, 'unknown');
  assert.match(foreign.reason, /not this task's process/);
});

// Measured under Task Scheduler (2026-11-01): a trigger refused while a run
// goes on (IgnoreNew) moves the last start to the refused trigger's time and
// keeps it after the run ends with its own exit code. A run longer than the
// 30-minute interval meets one every time.
test('task status: a trigger refused while a long run goes on (IgnoreNew) is neither a stale run nor a supervision gap', () => {
  const runAt = T_NOW - 70 * T_MIN;
  const refusedAt = T_NOW - 40 * T_MIN;
  const lock = { status: 'ok', pid: 4242, started_at: isoAt(runAt + 900) };
  // Running: the lock is the running instance's, 40 minutes before the last start.
  const going = status(taskFacts({ state: 'Running', last_run_time: isoAt(refusedAt), last_task_result: 0x800710e0, running: instance() }), { lock, alive: (pid) => pid === 4242 });
  assert.equal(going.state, 'running', going.reason);
  assert.match(going.reason, /was a later trigger it refused while this run goes on \(IgnoreNew\)/);
  assert.match(going.reason, /110 min left before the time limit/, 'the limit runs from the run\'s own start, not the refused one');
  assert.equal(going.task.deadline, isoAt(runAt + 3 * 3600000));
  assert.equal(going.task.last_result_means, 'a start refused (another instance was running: IgnoreNew)');
  assert.equal(going.lock.this_start, true);
  // The same lock, but held by a process that is not the instance's child.
  const other = status(taskFacts({ state: 'Running', last_run_time: isoAt(refusedAt), running: instance([{ pid: 5000, name: 'node.exe', started_at: isoAt(runAt + 700) }]) }), { lock, alive: () => true });
  assert.match(other.reason, /not this task's process/);
  // An instance that began after the last start does not read.
  const odd = status(taskFacts({ state: 'Running', last_run_time: isoAt(T_NOW - 70 * T_MIN), running: instance(undefined, T_NOW - 20 * T_MIN) }), { lock, alive: () => true });
  assert.equal(odd.state, 'unknown');
  assert.match(odd.reason, /after Task Scheduler's last start/);
  // Ended: the run that began before the refused start and finished after it,
  // with Task Scheduler's result its exit code, is the one.
  const spanned = runLine(runAt + 900, { finished_at: isoAt(T_NOW - 10 * T_MIN), exit: 3, needs_eric: [{ project_id: 'xmpl' }] });
  const done = status(taskFacts({ last_run_time: isoAt(refusedAt), last_task_result: 3 }), { log: runLog(runLine(runAt - 60 * T_MIN), spanned) });
  assert.equal(done.state, 'completed', done.reason);
  assert.match(done.reason, /1 project needs Eric \(exit 3\)\. The last start Task Scheduler shows .* was refused while this run, begun .*, went on \(IgnoreNew\)/);
  assert.deepEqual([done.runner.started_at, done.runner.exit, done.gap], [isoAt(runAt + 900), 3, false]);
  // A result that is not that run's exit: which run it was is not known.
  const disagree = status(taskFacts({ last_run_time: isoAt(refusedAt), last_task_result: 0 }), { log: runLog(spanned) });
  assert.deepEqual([disagree.state, disagree.gap], ['unknown', true]);
  assert.match(disagree.reason, /is not that run's exit \(3\), so which run it was is unknown/);
  // A skipped line spanning it, or a terminated result, is never read as that run's completion.
  assert.equal(status(taskFacts({ last_run_time: isoAt(refusedAt), last_task_result: 0x41306 }), { log: runLog(spanned) }).state, 'unknown');
  assert.equal(status(taskFacts({ last_run_time: isoAt(refusedAt), last_task_result: 0 }), { log: runLog(runLine(runAt + 900, { finished_at: isoAt(T_NOW - 10 * T_MIN), skipped: 'locked' })) }).state, 'unknown');
  // The old conhost launcher's 0 never confirms one.
  assert.equal(status(taskFacts({ launcher: 'conhost', last_run_time: isoAt(refusedAt), last_task_result: 0 }), { log: runLog(runLine(runAt + 900, { finished_at: isoAt(T_NOW - 10 * T_MIN) })) }).state, 'unknown');
});

test('task status: unreadable, malformed, ambiguous and future-dated evidence is unknown with the reason', () => {
  const at = T_NOW - 40 * T_MIN;
  const cases = [
    [status(null), /facts about the task did not read/],
    [status(taskFacts({ ours: false })), /did not register/],
    [status(taskFacts(), { log: { status: 'unreadable', code: 'EACCES', lines: [] } }), /could not be read \(EACCES\)/],
    [status(taskFacts(), { lock: { status: 'malformed' } }), /does not read as a lock/],
    [status(taskFacts(), { lock: { status: 'unreadable', code: 'EPERM' } }), /lock could not be read/],
    [status(taskFacts(), { log: runLog({ ok: false }, runLine(at - 60 * T_MIN)) }), /1 line of the log do not read/],
    [status(taskFacts(), { log: runLog(runLine(at + 200), runLine(at + 900)) }), /ambiguous/],
    [status(taskFacts({ last_run_time: isoAt(T_NOW + 3600000) })), /after this clock/],
    [status(taskFacts(), { log: runLog(runLine(at + 800, { finished_at: isoAt(T_NOW + 7200000) })) }), /dated after this clock/],
    [status(taskFacts({ state: 'Running', running: instance() }), { lock: { status: 'ok', pid: 4242, started_at: isoAt(T_NOW + 600000) }, alive: () => true }), /lock is dated after this clock/],
    [status(taskFacts({ state: 'Running', running: instance(), time_limit: 'three hours' })), /time limit does not read/],
    [status(taskFacts({ running_error: '0x80070005' })), /running instances could not be read/],
  ];
  for (const [r, re] of cases) {
    assert.equal(r.state, 'unknown', r.reason);
    assert.match(r.reason, re);
  }
  assert.equal(TS.durationMs('PT3H'), 3 * 3600000);
  assert.equal(TS.durationMs('PT15S'), 15000);
  assert.equal(TS.durationMs('P1DT2H'), 26 * 3600000);
  assert.equal(TS.durationMs(''), null);
});

test('task status from the command line reads the log and lock where pilot.js keeps them, and writes nothing', (t) => {
  const { spawnSync } = require('child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-task-status-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const tmp = path.join(home, 'tmp');
  const env = { ...process.env, USERPROFILE: home, HOME: home, TEMP: tmp, TMP: tmp, TMPDIR: tmp };
  const probe = spawnSync(process.execPath, ['-e', 'const P=require(process.argv[1]);process.stdout.write(JSON.stringify([P.lockPath(),P.pilotLogPath()]))', path.join(__dirname, '..', 'scripts', 'pilot.js')], { env, encoding: 'utf8' });
  const [lockFile, logFile] = JSON.parse(probe.stdout);
  assert.ok(lockFile.startsWith(tmp) && logFile.startsWith(home), `${lockFile} ${logFile}`);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const start = Date.now() - 20 * T_MIN;
  fs.writeFileSync(logFile, `not json\n${JSON.stringify(runLine(start + 2000, { exit: 3, needs_eric: [{ project_id: 'xmpl' }] }).rec)}\n`);
  const snapshot = () => fs.readdirSync(home, { recursive: true }).sort().map((p) => { const f = path.join(home, p); return fs.statSync(f).isFile() ? `${p}:${fs.readFileSync(f, 'utf8')}` : p; }).join('\n');
  const before = snapshot();
  const facts = taskFacts({ last_run_time: isoAt(start), last_task_result: 3, next_run_time: null });
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'pilot-task-status.js')], { env, input: JSON.stringify(facts), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.state, 'completed', out.reason);
  assert.equal(out.runner.needs_eric, 1);
  assert.equal(snapshot(), before, 'nothing written, moved or taken over');
  // A lock left by a process that is gone, with no line: interrupted, and the lock stays.
  fs.writeFileSync(logFile, '');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 2147483646, started_at: isoAt(start + 1000) }));
  const left = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'pilot-task-status.js')], { env, input: JSON.stringify(taskFacts({ last_run_time: isoAt(start), last_task_result: 0x41306 })), encoding: 'utf8' });
  assert.equal(JSON.parse(left.stdout).state, 'interrupted');
  assert.ok(fs.existsSync(lockFile), 'the lock is left as it is');
});
