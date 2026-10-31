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

test('online: the poll token is sent as a bearer, never printed; the first session is the step\'s role', async (t) => {
  const d = dirs(t);
  const TOKEN = 'FICTIONAL-poll-token-0123456789abcdef';
  const seen = [];
  const answers = [{ paused: false, steps: [{ project_id: 'a-fictional', step: 'ticket', claim: null }] }, { paused: false, steps: [{ project_id: 'a-fictional', step: 'pm_review', claim: null }] }];
  const fetchImpl = async (url, init) => {
    seen.push({ url, auth: init.headers.authorization });
    const body = { format: 'cr-pilot-poll@1', ...answers[Math.min(seen.length - 1, 1)] };
    return { status: 200, json: async () => body };
  };
  const roles = [];
  const said = [];
  const code = await P.runAll({ desk: 'online', maxAgents: 2, connector: 'mcp__fictional', deskUrl: 'https://desk.example.org' }, { ...d, token: TOKEN, fetchImpl, agent: (prompt) => { roles.push(/Agent 2, the Prosecutor/.test(prompt) ? 'prosecutor' : 'researcher'); return 'done\nNEXT_STEP: pm_review'; }, out: (s) => said.push(s) });
  assert.equal(code, 0);
  assert.deepEqual(roles, ['prosecutor'], 'no researcher session is spent on a ticket step');
  assert.equal(seen[0].url, 'https://desk.example.org/api/pilot/queue');
  assert.equal(seen[0].auth, `Bearer ${TOKEN}`);
  assert.ok(!said.join('\n').includes(TOKEN), 'the token is never printed');
  assert.ok(!fs.readFileSync(d.logFile, 'utf8').includes(TOKEN), 'nor logged');
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
  // 60 an hour, refused ones counted.
  for (let i = 3; i < 60; i++) poll(handle, `Bearer ${TOKEN}`);
  const limited = poll(handle, `Bearer ${TOKEN}`);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['Retry-After']) > 0);
  t0 += 3600000;
  assert.equal(poll(handle, `Bearer ${TOKEN}`).status, 200, 'an hour later it answers again');
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
