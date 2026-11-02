'use strict';
// A stop must stop everything (fix/stop-halts-pilot, 2026-11-02). One stop of
// Eric's on a project (a veto or Undo of his, an archive, an explicit autonomy
// stop) halts every automated effect on it: pilot claims and sessions, paper
// mandate grants and openings, and automatic admission. The one check is
// mandate-authority.js automationGate; every path asks it.
//
// FICTIONAL temporary workspaces. A real desk server on 127.0.0.1 for the
// runner tests; the only stand-ins are the claude -p session (a function) and
// the network beyond the desk (refused).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('../scripts/pilot');
const PC = require('../core/pilot-claims');
const PW = require('../core/pilot-worker');
const MA = require('../core/mandate-authority');
const T = require('../core/tickets');
const L = require('../core/leads');
const LA = require('../core/lead-admission');
const projects = require('../core/projects');
const { mandateDesk, saveTicket, mandateArgs } = require('./mandate-fixture');
const { answer } = require('./trader-fixture');

const POLL = 'FICTIONAL-poll-token-0123456789abcdef';
const WORKER = 'FICTIONAL-worker-token-0123456789abcd';
const DESK = 'https://desk.fictional.example';
const digest = (x) => crypto.createHash('sha256').update(x).digest('hex');
const NO_NET = async () => { throw new Error('FICTIONAL: no network'); };

function envFor(t, vars) {
  for (const [k, v] of Object.entries(vars)) {
    const before = process.env[k];
    process.env[k] = v;
    t.after(() => { if (before === undefined) delete process.env[k]; else process.env[k] = before; });
  }
}

// A desk whose pilot project's next step is the Prosecutor's ticket.
function desk(t, { mandate = false, settings = {} } = {}) {
  const s = mandateDesk(t, { mandate, settings });
  T.setPilot(s.ws, s.pid, true);
  envFor(t, { CR_PILOT_POLL_TOKEN_SHA256: digest(POLL), CR_PILOT_WORKER_TOKEN_SHA256: digest(WORKER) });
  assert.equal(T.nextStep(s.ws, s.pid).step, 'ticket', 'the fixture starts at the Prosecutor\'s step');
  return s;
}

const stop = (s, note = 'FICTIONAL stop') => MA.setAutonomy(s.ws, s.pid, { action: 'stop', note, by: 'eric' });
const rearm = (s) => MA.setAutonomy(s.ws, s.pid, { action: 'rearm', by: 'eric' });
const ledger = (ws) => (fs.existsSync(ws.abs(PC.SESSIONS_REL)) ? fs.readFileSync(ws.abs(PC.SESSIONS_REL), 'utf8').trim().split('\n').filter(Boolean) : []);
const receipts = (s) => T.listReceipts(s.ws, s.pid).filter((r) => !r.broken && !r.desk_gate);
const ticketsOpened = (s) => T.listTickets(s.ws, s.pid).length;

function assertStoppedClaim(s, stateAtStop, dispatched) {
  const c = PC.read(s.ws, s.pid);
  assert.equal(c.released, true, 'the claim is let go');
  assert.equal(c.outcome, 'autonomy_stopped', 'recorded as stopped, never as saved or done');
  assert.equal(c.stopped.state_at_stop, stateAtStop);
  assert.equal(c.stopped.session_dispatched, dispatched);
  assert.equal(c.stopped.code, 'SUSPENDED');
  assert.match(c.stopped.words, /suspended by Eric's autonomy stop/);
  return c;
}

function assertBlocked(s) {
  const n = T.nextStep(s.ws, s.pid);
  assert.equal(n.step, 'blocked', 'no further step');
  assert.match(n.why, /suspended by Eric's autonomy stop/);
  assert.equal(PC.claim(s.ws, s.pid, { owner: 'next' }).status, 'stopped', 'no new claim');
}

// ---------------------------------------------------------------------------
// The worker's transitions

test('stop during claimed: prepare hands out no prompt, opens nothing, reserves no session; the claim reads stopped', async (t) => {
  const s = desk(t);
  const c = PW.claimStep(s.ws, s.pid, { owner: 'unit' });
  assert.equal(c.status, 'claimed_now');
  const opened = ticketsOpened(s);
  stop(s);
  const p = await PW.prepare(s.ws, s.pid, c.token, { fetchImpl: NO_NET });
  assert.equal(p.status, 'stopped');
  assert.equal(p.prompt, undefined, 'no prompt');
  assert.equal(p.session, false);
  assert.equal(ticketsOpened(s), opened, 'no ticket opened');
  assert.equal(ledger(s.ws).length, 0, 'no session reserved');
  assertStoppedClaim(s, 'claimed', false);
  assertBlocked(s);
});

test('stop during preparing (the exit quote\'s wait): nothing is opened, no session reserved', async (t) => {
  const s = desk(t);
  const c = PW.claimStep(s.ws, s.pid, { owner: 'unit' });
  const opened = ticketsOpened(s);
  // Eric's stop lands while the desk waits on the network, after the claim
  // moved to preparing.
  t.mock.method(T, 'prepareExitQuote', async () => {
    assert.equal(PC.read(s.ws, s.pid).state, 'preparing');
    stop(s);
    return { size_usd: null, status: 'error', reason: 'FICTIONAL', asked_at: new Date().toISOString() };
  });
  const p = await PW.prepare(s.ws, s.pid, c.token, { fetchImpl: NO_NET });
  assert.equal(p.status, 'stopped');
  assert.equal(p.prompt, undefined);
  assert.equal(ticketsOpened(s), opened, 'no ticket opened');
  assert.equal(ledger(s.ws).length, 0);
  assertStoppedClaim(s, 'preparing', false);
  assertBlocked(s);
});

test('stop during preparing, at the bind itself: the bind lets the claim go; no prompt, no session', async (t) => {
  const s = desk(t);
  const c = PW.claimStep(s.ws, s.pid, { owner: 'unit' });
  // The stop lands after the ticket is opened, before the bind.
  const real = T.promptFor;
  t.mock.method(T, 'promptFor', (...a) => { stop(s); return real(...a); });
  const p = await PW.prepare(s.ws, s.pid, c.token, { fetchImpl: NO_NET });
  assert.equal(p.status, 'stopped');
  assert.equal(p.prompt, undefined, 'the prompt is never handed out');
  assert.equal(ledger(s.ws).length, 0, 'bind reserved no session');
  assertStoppedClaim(s, 'preparing', false);
  assertBlocked(s);
});

test('stop after dispatched: the answer is not saved, the attempt reads stopped (not success), the session still counts, no further step', async (t) => {
  const s = desk(t);
  const c = PW.claimStep(s.ws, s.pid, { owner: 'unit' });
  const p = await PW.prepare(s.ws, s.pid, c.token, { fetchImpl: NO_NET });
  assert.equal(p.status, 'prepared');
  assert.equal(ledger(s.ws).length, 1, 'the session was reserved at the bind');
  const text = answer(T.loadTicket(s.ws, s.pid, p.ticket_id));
  stop(s);
  const done = PW.complete(s.ws, s.pid, c.token, { text, prompt_sha256: p.prompt_sha256 });
  assert.equal(done.status, 'stopped');
  assert.equal(done.saved, false);
  assert.equal(done.session, true, 'it says a session ran');
  assert.equal(done.outcome, 'autonomy_stopped');
  assert.equal(receipts(s).length, 0, 'no Prosecutor receipt was saved');
  assert.equal(ledger(s.ws).length, 1, 'the session that ran is counted, never erased');
  assertStoppedClaim(s, 'dispatched', true);
  // A second delivery of the same answer finds no claim: nothing saved.
  assert.throws(() => PW.complete(s.ws, s.pid, c.token, { text, prompt_sha256: p.prompt_sha256 }), (e) => e.code === 'CHANGED');
  assert.equal(receipts(s).length, 0);
  assertBlocked(s);
});

test('a dispatch whose outcome is unknown stays visible as reconcile after a stop, never as merely expired; Eric can still reconcile it', async (t) => {
  const s = desk(t);
  const c = PW.claimStep(s.ws, s.pid, { owner: 'unit' });
  const p = await PW.prepare(s.ws, s.pid, c.token, { fetchImpl: NO_NET });
  assert.equal(p.status, 'prepared');
  // The runner went away (its answer was lost); Eric stops the project.
  stop(s);
  const later = Date.parse(PC.read(s.ws, s.pid).expires_at) + 1000;
  const step = T.pilotQueue(s.ws, { project: s.pid, now: later })[0];
  assert.equal(step.step, 'blocked');
  assert.equal(PC.peek(s.ws, s.pid, step, later), 'reconcile', 'the poll still names it for Eric');
  const poll = require('../core/pilot-poll').pollBody(s.ws, later);
  assert.deepEqual(poll.steps.map((x) => [x.step, x.claim]), [['blocked', 'reconcile']], 'the runner\'s poll lists it, so the run says it needs Eric');
  const row = MA.statusRows(s.ws, [step], { now: later })[0];
  assert.equal(row.claim.state, 'reconcile');
  assert.equal(PC.read(s.ws, s.pid).released, false, 'nothing settles it by itself');
  // Eric's reconcile is his own act; the stop never blocks it.
  assert.equal(PC.release(s.ws, s.pid, { reconciled: true, attempt_id: PC.read(s.ws, s.pid).attempt_id, now: later }).claim.outcome, 'reconciled');
  assert.equal(PC.claim(s.ws, s.pid, { now: later }).status, 'stopped', 'and the project stays stopped');
});

// ---------------------------------------------------------------------------
// The runner, end to end, against a real desk

async function startDesk(t, ws) {
  const { start } = require('../server');
  const srv = await start(ws, { port: 48800 + Math.floor(Math.random() * 600), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } });
  return srv;
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
const toDesk = (port, real, before = async () => {}) => async (url, init) => {
  await before(String(url));
  return real(String(url).replace(DESK, `http://127.0.0.1:${port}`), { ...init, headers: { ...init.headers, host: `127.0.0.1:${port}` } });
};
function logFiles(t) {
  const d = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cr-stop-test-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return { lockFile: path.join(d, 'a.lock'), logFile: path.join(d, 'a.jsonl') };
}
const runLog = (f) => JSON.parse(fs.readFileSync(f, 'utf8').trim().split('\n').pop());

test('runner: Eric stops the project between the claim and the prepare; no claude -p session starts', async (t) => {
  const s = desk(t);
  const real = noNetwork(t);
  const srv = await startDesk(t, s.ws);
  const files = logFiles(t);
  const before = async (url) => { if (url.endsWith('/api/pilot/worker/prepare')) stop(s); };
  const agent = () => assert.fail('no session may start after the stop');
  const code = await P.runAll({ desk: 'online', maxAgents: 1, deskUrl: DESK }, { ...files, token: POLL, workerToken: WORKER, fetchImpl: toDesk(srv.port, real, before), agent, out: () => {} });
  assert.equal(code, 0);
  const row = runLog(files.logFile).dispatches[0];
  assert.equal(row.outcome, 'not_dispatched');
  assert.equal(row.stop, 'stopped');
  assert.equal(ledger(s.ws).length, 0);
  assertStoppedClaim(s, 'claimed', false);
  assertBlocked(s);
});

test('runner: Eric stops the project while the session runs; the run log and the desk say stopped, nothing is saved', async (t) => {
  const s = desk(t);
  const real = noNetwork(t);
  const srv = await startDesk(t, s.ws);
  const files = logFiles(t);
  let sessions = 0;
  const agent = () => {
    sessions += 1;
    stop(s);
    return answer(T.loadTicket(s.ws, s.pid, PC.read(s.ws, s.pid).ticket_id));
  };
  const code = await P.runAll({ desk: 'online', maxAgents: 1, deskUrl: DESK }, { ...files, token: POLL, workerToken: WORKER, fetchImpl: toDesk(srv.port, real), agent, out: () => {} });
  assert.equal(code, 0);
  assert.equal(sessions, 1);
  const row = runLog(files.logFile).dispatches[0];
  assert.equal(row.outcome, 'stopped', 'never "done"');
  assert.equal(row.next_step, 'blocked');
  assert.equal(receipts(s).length, 0);
  assertStoppedClaim(s, 'dispatched', true);
  // The next run polls the project as blocked and dispatches nothing.
  const again = await P.runAll({ desk: 'online', maxAgents: 1, deskUrl: DESK }, { ...files, token: POLL, workerToken: WORKER, fetchImpl: toDesk(srv.port, real), agent: () => assert.fail('nothing runs'), out: () => {} });
  assert.equal(again, 0);
  assert.deepEqual(runLog(files.logFile).dispatches, []);
});

test('local runner: a stop during the session is checked before the import; nothing is saved', async (t) => {
  const s = desk(t);
  const calls = [];
  // The CLI the runner calls, answered by the desk's own modules in process.
  const cli = (args) => {
    calls.push(args.slice(0, 2).join(' '));
    const [, sub] = args;
    const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
    if (sub === 'queue') return { steps: T.pilotQueue(s.ws, { project: s.pid }) };
    if (sub === 'claim') return PC.claim(s.ws, s.pid, { owner: 'local' });
    if (sub === 'start') return T.createTicket(s.ws, { project_id: s.pid, assistant: true });
    if (sub === 'bind') return PC.bind(s.ws, s.pid, flag('--token'), { ticket_id: flag('--ticket') });
    if (sub === 'prompt') return T.promptFor(s.ws, T.loadTicket(s.ws, s.pid, args[3])).text;
    if (sub === 'check') return PC.stopIfHalted(s.ws, s.pid, flag('--token'));
    if (sub === 'import') return assert.fail('nothing is imported after the stop');
    if (sub === 'release') return PC.release(s.ws, s.pid, { token: flag('--token'), outcome: flag('--outcome') });
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const agent = Object.assign(() => { stop(s); return answer(T.loadTicket(s.ws, s.pid, PC.read(s.ws, s.pid).ticket_id)); }, { ready: () => true });
  const r = P.runLocal({ project: s.pid, dryRun: false }, { call: cli, agent });
  assert.equal(r.stop, 'stopped');
  assert.equal(r.session_stopped, true);
  assert.ok(calls.includes('tickets check'), 'checked before any save');
  assert.ok(!calls.includes('tickets import'));
  assert.equal(receipts(s).length, 0);
  assertStoppedClaim(s, 'dispatched', true);
});

// ---------------------------------------------------------------------------
// Veto, Undo and archive are stops too; the pause still works; un-stopping is explicit and logged

test('a veto, an Undo or an archive of Eric\'s blocks the pilot\'s next step and its claim, as an explicit stop does', async (t) => {
  for (const kind of ['veto', 'undo', 'archive']) {
    await t.test(kind, (t2) => {
      const s = desk(t2, { mandate: true });
      const r = saveTicket(s.ws, s.pid);
      if (kind === 'veto') T.decide(s.ws, s.pid, { receipt_id: r.receipt_id, action: 'veto', by: 'eric' });
      if (kind === 'undo') {
        T.decide(s.ws, s.pid, { receipt_id: r.receipt_id, action: 'halve', by: 'eric' });
        T.decide(s.ws, s.pid, { receipt_id: r.receipt_id, action: 'undo', by: 'eric' });
      }
      if (kind === 'archive') projects.archiveProject(s.ws, s.pid, 'FICTIONAL');
      const n = T.nextStep(s.ws, s.pid);
      assert.equal(n.step, 'blocked', kind);
      assert.match(n.why, kind === 'archive' ? /archived/ : kind === 'veto' ? /Eric's veto/ : /Eric's Undo/);
      const c = PC.claim(s.ws, s.pid, { owner: 'x' });
      assert.equal(c.status, 'stopped');
      assert.equal(c.code, 'SUSPENDED');
    });
  }
});

test('the global pause still works as before: no claim or bind; dispatched work settles. A project stop is never masked by the pause', async (t) => {
  const s = desk(t);
  const c = PW.claimStep(s.ws, s.pid, { owner: 'unit' });
  const p = await PW.prepare(s.ws, s.pid, c.token, { fetchImpl: NO_NET });
  assert.equal(p.status, 'prepared');
  s.ws.settings = { ...s.ws.settings, automation: { ...s.ws.settings.automation, paused: true } };
  assert.equal(PC.claim(s.ws, s.pid).status, 'paused');
  const g = MA.automationGate(s.ws, s.pid);
  assert.deepEqual([g.ok, g.code, g.paused, g.project_stopped], [false, 'PAUSED', true, false]);
  // Paused only: the dispatched answer settles, as it always did.
  const text = answer(T.loadTicket(s.ws, s.pid, p.ticket_id));
  assert.equal(PW.complete(s.ws, s.pid, c.token, { text, prompt_sha256: p.prompt_sha256 }).status, 'saved');
  // Paused and stopped: the stop wins.
  stop(s);
  const g2 = MA.automationGate(s.ws, s.pid);
  assert.deepEqual([g2.ok, g2.code, g2.paused, g2.project_stopped], [false, 'SUSPENDED', true, true]);
  assert.equal(PC.claim(s.ws, s.pid).status, 'stopped');
});

test('un-stopping is explicit and logged: only Eric\'s rearm clears the stop; resume, re-enrollment and re-arming the mandate do not', async (t) => {
  const s = desk(t, { mandate: true });
  const { applySettings } = require('../server');
  const st = stop(s, 'FICTIONAL: hold this one');
  assert.equal(st.status, 'saved');
  // None of these un-stops it.
  applySettings(s.ws, { automation: { paused: true } });
  applySettings(s.ws, { automation: { paused: false } });
  T.setPilot(s.ws, s.pid, false);
  T.setPilot(s.ws, s.pid, true);
  applySettings(s.ws, { automation: { autonomous_paper_loop: true, mandate: { expires_at: new Date(Date.now() + 5 * 86400000).toISOString() } } });
  assert.equal(T.nextStep(s.ws, s.pid).step, 'blocked');
  assert.equal(PC.claim(s.ws, s.pid).status, 'stopped');
  // Eric's rearm: one logged line naming who, when and what it clears.
  const r = rearm(s);
  assert.equal(r.status, 'saved');
  const lines = fs.readFileSync(s.ws.abs(MA.autonomyRel(s.pid)), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.action), ['stop', 'rearm']);
  assert.equal(lines[1].by, 'eric');
  assert.ok(Date.parse(lines[1].at));
  assert.deepEqual(lines[1].clears, [lines[0].line_id]);
  assert.equal(T.nextStep(s.ws, s.pid).step, 'ticket');
  assert.equal(PC.claim(s.ws, s.pid).status, 'claimed_now');
});

// ---------------------------------------------------------------------------
// No path bypasses the shared check

// Every automated path asks automationGate through its module's exports: with
// the real records clean and only the shared check closed, each path stops.
// A path that kept its own predicate would go on, and this test fails.
test('every pilot, grant and admission path asks the one shared check (automationGate)', async (t) => {
  const s = desk(t, { mandate: true });
  const r = saveTicket(s.ws, s.pid);
  const m = T.mandateOf(s.ws);
  assert.equal(m.on, true);
  const WORDS = 'FICTIONAL: the shared check is closed';
  const asked = [];
  let closed = false;
  const realGate = MA.automationGate;
  t.mock.method(MA, 'automationGate', (ws, pid, opts) => {
    if (!closed) return realGate(ws, pid, opts);
    asked.push(pid);
    return { version: MA.GATE_VERSION, ok: false, code: 'SUSPENDED', words: WORDS, paused: false, project_stopped: true, autonomy: { suspended: true, unreadable: false, interventions: [], all: [], words: WORDS } };
  });
  const paths = {};
  const check = (name, fn, pid = s.pid) => { asked.length = 0; closed = true; try { paths[name] = fn(); } finally { closed = false; } assert.ok(asked.includes(pid), `${name} asked the shared check`); };

  // The mandate.
  assert.equal(T.mandateDue(s.ws), true, 'open: a grant is due');
  check('mandateDue', () => assert.equal(T.mandateDue(s.ws), false));
  check('mandateSweep', () => {
    const out = T.mandateSweep(s.ws);
    assert.equal(out.granted.length, 0);
    assert.ok(out.skipped.some((x) => x.project_id === s.pid && x.rule === 'R0' && x.words === WORDS));
  });
  check('decide (mandate)', () => assert.throws(() => T.decide(s.ws, s.pid, { receipt_id: r.receipt_id, action: 'halve', request_id: `mandate_${r.receipt_id}`, mandate: mandateArgs('exploratory_50_54', 52) }), (e) => e.code === 'REFUSED' && e.details.reason === 'MANDATE_SUSPENDED'));
  const d = { decision_id: 'pd_FICTIONAL', project_id: s.pid, receipt_id: 'tr_FICTIONAL_missing', decided_by: 'mandate:cr-paper-mandate@1', decided_at: new Date().toISOString(), mandate: { authority: { generation: m.generation, policy_sha256: m.settings_sha256 } } };
  assert.equal(MA.grantAuthority(s.ws, d).code, 'MANDATE_RECEIPT', 'open: it reaches the receipt');
  check('grantAuthority', () => assert.equal(MA.grantAuthority(s.ws, d).code, 'MANDATE_SUSPENDED'));

  // The pilot, on a second desk whose next step is the Prosecutor's ticket.
  const q = desk(t);
  const P2 = q.pid;
  check('nextStep', () => assert.equal(T.nextStep(q.ws, P2).step, 'blocked'), P2);
  check('claim', () => assert.equal(PC.claim(q.ws, P2).status, 'stopped'), P2);
  const c1 = PC.claim(q.ws, P2, { owner: 'one' });
  assert.equal(c1.status, 'claimed_now');
  check('beginPreparation', () => assert.equal(PC.beginPreparation(q.ws, P2, c1.token).status, 'stopped'), P2);
  const c2 = PC.claim(q.ws, P2, { owner: 'two' });
  assert.equal(PC.beginPreparation(q.ws, P2, c2.token).status, 'preparing');
  check('assertPreparing', () => assert.throws(() => PC.assertPreparing(q.ws, P2, c2.token), (e) => e.code === 'STOPPED'), P2);
  check('bind', () => assert.throws(() => PC.bind(q.ws, P2, c2.token, { ticket_id: 'tk_FICTIONAL', from: 'preparing' }), (e) => e.code === 'STOPPED'), P2);
  const c3 = PC.claim(q.ws, P2, { owner: 'three' });
  PC.bind(q.ws, P2, c3.token, { ticket_id: 'tk_FICTIONAL', extra: { role: 'prosecutor', prompt_sha256: 'a'.repeat(64) } });
  check('complete', () => assert.equal(PW.complete(q.ws, P2, c3.token, { text: 'FICTIONAL answer', prompt_sha256: 'a'.repeat(64) }).status, 'stopped'), P2);
  const c4 = PC.claim(q.ws, P2, { owner: 'four' });
  check('stopIfHalted', () => assert.equal(PC.stopIfHalted(q.ws, P2, c4.token).status, 'stopped'), P2);

  // Automatic admission, on the second desk (its pipeline is at the ticket).
  t.mock.method(LA, 'authorityOf', () => ({ on: true, generation: 1, policy_sha256: 'FICTIONAL' }));
  const a = { kind: 'delegated', project_id: P2, authority: { generation: 1, policy_sha256: 'FICTIONAL' }, state: 'complete' };
  PC.release(q.ws, P2, { token: c4.token });
  assert.equal(L.delegatedGate(q.ws, a, Date.now()), null, 'open: the admission may go on');
  check('delegatedGate', () => assert.equal(L.delegatedGate(q.ws, a, Date.now()), WORDS), P2);
  assert.equal(LA.pipelineOf(q.ws, a).active, true, 'open: its pipeline is active');
  check('pipelineOf', () => assert.deepEqual(LA.pipelineOf(q.ws, a), { active: false, stage: 'suspended' }), P2);

  assert.deepEqual(Object.keys(paths).sort(), ['assertPreparing', 'beginPreparation', 'bind', 'claim', 'complete', 'decide (mandate)', 'delegatedGate', 'grantAuthority', 'mandateDue', 'mandateSweep', 'nextStep', 'pipelineOf', 'stopIfHalted']);
});

// The callers of the latch and of the pause, enumerated from the source: only
// the shared check decides; the others only report state.
test('no module keeps its own stop predicate: autonomyOf and automationPaused are read only by the gate and by status reports', () => {
  const root = path.join(__dirname, '..');
  const files = [
    ...fs.readdirSync(path.join(root, 'core')).filter((f) => f.endsWith('.js')).map((f) => `core/${f}`),
    'server.js', 'cli.js', 'mcp.js', 'hosted.js', 'scripts/pilot.js',
  ].filter((f) => fs.existsSync(path.join(root, f)));
  const callers = (re) => {
    const out = {};
    for (const f of files) {
      const n = fs.readFileSync(path.join(root, f), 'utf8').split('\n').filter((l) => re.test(l) && !/^\s*\/\//.test(l)).length;
      if (n) out[f] = n;
    }
    return out;
  };
  // mandate-authority.js: the definition, the gate, setAutonomy's answer and
  // statusRows (a report). tickets.js: the export alias. cli.js: "tickets
  // autonomy <project>" with no flag, a report.
  assert.deepEqual(callers(/autonomyOf\(/), { 'core/mandate-authority.js': 4, 'core/tickets.js': 1, 'cli.js': 1 });
  // workspace.js: the definition. mandate-authority.js: the gate and
  // statusRows. The rest are desk-wide reports or the research job (Eric's
  // own API runs; pilot and admission runs are never sent by it): the
  // connector's and the CLI's queue, the poll.
  assert.deepEqual(callers(/automationPaused\(/), { 'core/workspace.js': 1, 'core/mandate-authority.js': 2, 'core/jobs.js': 2, 'core/pilot-poll.js': 1, 'cli.js': 1, 'mcp.js': 1 });
  // Each module that acts automatically on a project asks the gate.
  for (const f of ['core/pilot-claims.js', 'core/tickets.js', 'core/leads.js', 'core/lead-admission.js']) {
    assert.match(fs.readFileSync(path.join(root, f), 'utf8'), /automationGate\(/, `${f} asks the shared check`);
  }
  // The pilot's claim no longer reads the pause by itself.
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'core', 'pilot-claims.js'), 'utf8'), /automationPaused/);
});
