'use strict';
// Host recovery on an ephemeral disk (blueprint 2026-11-02 §8 F03/F7, build
// plan row 5). The runner's own disk (its lock, log and pending-submission
// folder) is thrown away between runs, as a cron host's is. Three failures:
// an answer the desk saved whose reply was lost, the desk down, and the
// runner killed mid-attempt. In every case a restart on a fresh disk never
// starts a second session for the same step: the claim on the desk decides,
// and an attempt with no known outcome waits for Eric to reconcile.
//
// A real desk server on 127.0.0.1 with a FICTIONAL workspace; the stand-ins
// are the claude -p session (a function) and the faults injected into the
// runner's fetch. Nothing leaves 127.0.0.1.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const P = require('../scripts/pilot');
const FICTIONAL_REV = 'e'.repeat(40);
const PC = require('../core/pilot-claims');
const T = require('../core/tickets');
const { mandateDesk } = require('./mandate-fixture');
const { answer } = require('./trader-fixture');

const POLL = 'FICTIONAL-poll-token-0123456789abcdef';
const WORKER = 'FICTIONAL-worker-token-0123456789abcd';
const DESK = 'https://desk.fictional.example';
const digest = (t) => crypto.createHash('sha256').update(t).digest('hex');

function envFor(t, vars) {
  for (const [k, v] of Object.entries(vars)) {
    const before = process.env[k];
    process.env[k] = v;
    t.after(() => { if (before === undefined) delete process.env[k]; else process.env[k] = before; });
  }
}
function noNetwork(t) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (new URL(String(url)).hostname === '127.0.0.1') return real(url, init);
    throw new Error('FICTIONAL: no network');
  };
  t.after(() => { globalThis.fetch = real; });
  return real;
}
function desk(t) {
  const s = mandateDesk(t, { mandate: false });
  const file = s.ws.abs(`projects/${s.pid}/tickets/profile.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema_version: 'cr.ticket-profile.v1', project_id: s.pid, pilot: true }));
  envFor(t, { CR_PILOT_POLL_TOKEN_SHA256: digest(POLL), CR_PILOT_WORKER_TOKEN_SHA256: digest(WORKER) });
  return s;
}
async function startDesk(t, ws) {
  const { start } = require('../server');
  const srv = await start(ws, { port: 48800 + Math.floor(Math.random() * 600), quiet: true });
  let stopped = false;
  const stop = () => { if (!stopped) { stopped = true; try { srv.shutdown(); } catch (_) { /* stopped */ } } };
  t.after(stop);
  return { ...srv, stop };
}

// The runner's network: each request reaches the test desk unless a fault
// says otherwise. `down(op)`: the desk cannot be reached (nothing arrives).
// `lose(op)`: the desk carried the request out, and its reply is lost.
const opOf = (url) => (String(url).match(/\/api\/pilot\/(?:worker\/)?([a-z]+)$/) || [])[1] || null;
function network(real, port, { down = () => false, lose = () => false } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    const op = opOf(url);
    if (down(op)) { calls.push({ op, fate: 'down' }); throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }); }
    const res = await real(String(url).replace(DESK, `http://127.0.0.1:${port}`), { ...init, headers: { ...init.headers, host: `127.0.0.1:${port}` } });
    if (lose(op)) { await res.text(); calls.push({ op, fate: 'lost' }); throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }); }
    calls.push({ op, fate: 'answered', status: res.status });
    return res;
  };
  return { fn, calls };
}

// A fresh host: its own temporary disk for the lock, the log and the
// pending-submission folder, thrown away when the run ends.
function freshHost(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-host-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return { lockFile: path.join(d, 'pilot-all.lock'), logFile: path.join(d, 'pilot-all.jsonl'), pendingDir: path.join(d, 'pending'), root: d };
}
async function runOn(host, net, s, sessions, said = []) {
  const agent = (prompt, opts) => {
    sessions.push({ tools: opts.tools });
    const tid = (PC.read(s.ws, s.pid) || {}).ticket_id;
    return answer(T.loadTicket(s.ws, s.pid, tid));
  };
  const runOnlineImpl = (po, opts) => P.runOnline(po, { ...opts, sleep: async () => {}, pendingDir: host.pendingDir });
  const code = await P.runAll({ desk: 'online', maxAgents: 2, deskUrl: DESK, unattended: true, model: 'claude-fictional' }, {
    lockFile: host.lockFile, logFile: host.logFile, token: POLL, workerToken: WORKER, fetchImpl: net.fn, agent, out: (x) => said.push(x), runOnlineImpl,
    // The revision guard (blueprint 2026-11-03 §4 PR 1) sees the same fictional
    // commit on the runner and the desk; pilot-revision-guard.test.js covers it.
    runnerRevisionImpl: () => ({ commit: FICTIONAL_REV, source: 'render', clean: true }), deskRevisionImpl: async () => ({ commit: FICTIONAL_REV }),
  });
  const log = JSON.parse(fs.readFileSync(host.logFile, 'utf8').trim().split('\n').pop());
  fs.rmSync(host.root, { recursive: true, force: true }); // the host's disk is gone
  return { code, log, said };
}
const receipts = (s) => T.listReceipts(s.ws, s.pid).filter((r) => !r.broken && !r.desk_gate);
const ledger = (s) => (fs.existsSync(s.ws.abs(PC.SESSIONS_REL)) ? fs.readFileSync(s.ws.abs(PC.SESSIONS_REL), 'utf8').trim().split('\n').filter(Boolean).length : 0);
// The claim's 90 minutes pass, on the desk's own record.
function expire(s) {
  const f = s.ws.abs(`.cr/pilot-claims/${s.pid}.json`);
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  c.expires_at = new Date(Date.now() - 60000).toISOString();
  fs.writeFileSync(f, JSON.stringify(c, null, 2));
}

test('an answer the desk saved whose reply was lost: one session, one receipt; the restart on a fresh disk runs nothing', async (t) => {
  const s = desk(t);
  const real = noNetwork(t);
  const srv = await startDesk(t, s.ws);
  const sessions = [];
  // Every reply to complete is lost, the first included, though the desk saved it.
  const net = network(real, srv.port, { lose: (op) => op === 'complete' });
  const first = await runOn(freshHost(t), net, s, sessions);
  assert.equal(sessions.length, 1);
  assert.equal(receipts(s).length, 1, 'the desk saved the answer once');
  assert.ok(net.calls.filter((c) => c.op === 'complete').length >= 2, 'complete was asked again after the lost reply');
  // The runner could not confirm the save: it says reconcile, exit 3, and
  // stdout keeps the identifiers and the answer's hash (the disk will not).
  assert.equal(first.code, 3);
  assert.equal(first.log.health, 'reconcile');
  const lost = first.said.filter((l) => l.startsWith('Lost complete: '));
  assert.equal(lost.length, 1);
  const rec = JSON.parse(lost[0].slice('Lost complete: '.length));
  assert.equal(rec.project_id, s.pid);
  assert.match(rec.text_sha256, /^[0-9a-f]{64}$/);
  // The desk itself knows the outcome: the claim released as saved.
  const c = PC.read(s.ws, s.pid);
  assert.equal(c.released, true);
  assert.equal(c.outcome, 'saved');
  // A restart on a fresh host: nothing to do, no second session or receipt.
  const again = await runOn(freshHost(t), network(real, srv.port), s, sessions);
  assert.equal(again.code, 0);
  assert.equal(sessions.length, 1, 'never regenerated');
  assert.equal(receipts(s).length, 1);
  assert.equal(ledger(s), 1, 'one session reserved in all');
  assert.equal(T.pilotQueue(s.ws, { project: s.pid })[0].step, 'pm_review');
  srv.stop();
});

test('the desk down: before the claim nothing runs; after the session the answer waits for Eric and a restart never regenerates', async (t) => {
  const s = desk(t);
  const real = noNetwork(t);
  const srv = await startDesk(t, s.ws);
  const sessions = [];
  // Down from the start: the poll fails, nothing is claimed or run.
  const before = await runOn(freshHost(t), network(real, srv.port, { down: () => true }), s, sessions);
  assert.equal(before.code, 1);
  assert.equal(before.log.health, 'failure');
  assert.equal(sessions.length, 0);
  assert.equal(PC.read(s.ws, s.pid), null, 'no claim was taken');
  // Down after the session, at complete: the claim stays dispatched, the
  // answer is lost with the host's disk, the run says reconcile.
  const mid = await runOn(freshHost(t), network(real, srv.port, { down: (op) => op === 'complete' }), s, sessions);
  assert.equal(mid.code, 3);
  assert.equal(sessions.length, 1);
  assert.equal(receipts(s).length, 0, 'nothing reached the desk');
  assert.equal(PC.read(s.ws, s.pid).state, 'dispatched');
  assert.ok(mid.said.some((l) => l.startsWith('Lost complete: ')));
  // The desk is back. Within the claim's life, a restart is refused the step.
  const live = await runOn(freshHost(t), network(real, srv.port), s, sessions);
  assert.equal(sessions.length, 1, 'no second session while the claim lives');
  assert.notEqual(live.log.health, 'ok');
  // After its expiry, the step reads reconcile: still no session, exit 3.
  expire(s);
  const after = await runOn(freshHost(t), network(real, srv.port), s, sessions);
  assert.equal(after.code, 3);
  assert.equal(after.log.health, 'reconcile');
  assert.ok(after.log.needs_eric.some((n) => n.project_id === s.pid));
  assert.equal(sessions.length, 1, 'never regenerated');
  assert.equal(ledger(s), 1);
  srv.stop();
});

test('the runner killed after its claim was prepared: the restart is refused the step, then waits for Eric; never a second session', async (t) => {
  const s = desk(t);
  const real = noNetwork(t);
  const srv = await startDesk(t, s.ws);
  const sessions = [];
  // The runner claims and prepares, starts its session, and is killed: it
  // sends nothing after prepare (no complete, no release).
  const killed = network(real, srv.port, { down: (op) => op === 'complete' || op === 'release' });
  const agent = () => { sessions.push({}); throw Object.assign(new Error('FICTIONAL: the process was killed'), { killed: true }); };
  const host = freshHost(t);
  const runOnlineImpl = async (po, opts) => {
    // The kill: the session never returns and nothing after it is sent.
    try { await P.runOnline(po, { ...opts, run: agent, sleep: async () => {}, pendingDir: host.pendingDir }); } catch (_) { /* gone */ }
    return { stop: 'killed' };
  };
  await P.runAll({ desk: 'online', maxAgents: 2, deskUrl: DESK }, { lockFile: host.lockFile, logFile: host.logFile, token: POLL, workerToken: WORKER, fetchImpl: killed.fn, agent, out: () => {}, runOnlineImpl });
  fs.rmSync(host.root, { recursive: true, force: true });
  assert.equal(sessions.length, 1);
  assert.deepEqual(killed.calls.filter((c) => c.fate === 'answered').map((c) => c.op).filter((op) => op !== 'queue'), ['claim', 'prepare']);
  assert.equal(PC.read(s.ws, s.pid).state, 'dispatched', 'the desk holds the attempt as dispatched');
  assert.equal(ledger(s), 1);
  // Restarted on a fresh host within the claim's life: refused the step.
  const live = await runOn(freshHost(t), network(real, srv.port), s, sessions);
  assert.equal(sessions.length, 1, 'no second session while the claim lives');
  assert.notEqual(live.log.health, 'ok');
  // Past its expiry: reconcile, exit 3, and still no session.
  expire(s);
  const after = await runOn(freshHost(t), network(real, srv.port), s, sessions);
  assert.equal(after.code, 3);
  assert.equal(after.log.health, 'reconcile');
  assert.equal(sessions.length, 1, 'never regenerated');
  assert.equal(ledger(s), 1);
  assert.equal(receipts(s).length, 0);
  srv.stop();
});
