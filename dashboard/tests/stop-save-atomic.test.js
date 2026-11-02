'use strict';
// Audit F2 (audit-blueprint-implementation-2026-11-02.md): a stop between the
// worker's check and its save still recorded "saved". The worker's check
// (claims.stopIfHalted) and the save were separate operations, so Eric's stop
// landing between them let the dispatched session's answer be saved and its
// claim released as saved.
//
// The stop is asked again inside the save's own locked operation, as the
// first thing before anything is written. The workspace lock is one lock, so
// no stop can land between that check and the commit. These tests land a real
// stop of Eric's at each point before the commit: right after the worker's
// check, and inside the save after its own reads, just before its operation.
//
// FICTIONAL temporary workspaces only. The only stand-ins are the injection
// points (a real stop, then the real function) and the network (refused).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const PC = require('../core/pilot-claims');
const PW = require('../core/pilot-worker');
const MA = require('../core/mandate-authority');
const T = require('../core/tickets');
const research = require('../core/research');
const inbox = require('../core/inbox');
const binding = require('../core/binding');
const forensics = require('../core/forensics');
const { mockReport } = require('../core/demo');
const { tempWorkspace, addFixtureProject, freshPrice } = require('./helpers');
const { mandateDesk } = require('./mandate-fixture');
const { answer } = require('./trader-fixture');

const NO_NET = async () => { throw new Error('FICTIONAL: no network'); };
const stop = (ws, pid) => MA.setAutonomy(ws, pid, { action: 'stop', note: 'FICTIONAL stop between check and save', by: 'eric' });
const decisions = (ws, pid) => (fs.existsSync(ws.abs(`projects/${pid}/tickets/decisions.jsonl`)) ? fs.readFileSync(ws.abs(`projects/${pid}/tickets/decisions.jsonl`), 'utf8').trim().split('\n').filter(Boolean) : []);
const receipts = (ws, pid) => T.listReceipts(ws, pid).filter((r) => !r.broken && !r.desk_gate);
const claudeReports = (ws, pid) => require('../core/reports').loadReports(ws, pid).filter((r) => r.broken || (r.record && r.record.provider === 'claude'));
const pendingInbox = (ws, pid) => fs.readdirSync(ws.abs('inbox/claude')).filter((f) => f.startsWith(`${pid}__`));

// Lands Eric's stop once, at the first call of mod[name], then runs the real
// function: the stop arrives exactly there.
function stopAt(t, mod, name, ws, pid) {
  const real = mod[name];
  let landed = false;
  t.mock.method(mod, name, (...a) => {
    if (!landed) { landed = true; stop(ws, pid); }
    return real.apply(mod, a);
  });
  return () => landed;
}
// Lands the stop right after the worker's own check has passed.
function stopAfterCheck(t, ws, pid) {
  const real = PC.stopIfHalted;
  let landed = false;
  t.mock.method(PC, 'stopIfHalted', (...a) => {
    const r = real.apply(PC, a);
    if (!landed && r.status === 'ok') { landed = true; stop(ws, pid); }
    return r;
  });
  return () => landed;
}

function assertStopped(ws, pid, done, dispatched = true) {
  assert.equal(done.status, 'stopped', `the answer is stopped, not ${done.status}: ${done.words || ''}`);
  assert.equal(done.saved, false, 'it says nothing was saved');
  assert.equal(done.outcome, 'autonomy_stopped');
  const c = PC.read(ws, pid);
  assert.equal(c.released, true);
  assert.equal(c.outcome, 'autonomy_stopped', 'the claim is let go as stopped, never as saved');
  assert.notEqual(c.outcome, 'saved');
  assert.equal(c.stopped.state_at_stop, 'dispatched');
  assert.equal(c.stopped.session_dispatched, dispatched);
  assert.equal(MA.automationGate(ws, pid).project_stopped, true);
  assert.equal(T.nextStep(ws, pid).step, 'blocked', 'no further step');
}

// ---------------------------------------------------------------------------
// Agent 1: the researcher's report.

async function researchDispatched(t) {
  const w = tempWorkspace('f2-research');
  t.after(w.cleanup);
  const pid = addFixtureProject(w.ws).project_id;
  freshPrice(w.ws, 'example-payfi-fictional', 0.85);
  T.setPilot(w.ws, pid, true);
  assert.equal(T.nextStep(w.ws, pid).step, 'research', 'the fixture starts at Agent 1');
  const c = PW.claimStep(w.ws, pid, { owner: 'f2' });
  const p = await PW.prepare(w.ws, pid, c.token, { fetchImpl: NO_NET });
  assert.deepEqual([p.status, p.role], ['prepared', 'researcher'], p.words);
  const run = research.loadRun(w.ws, pid, p.run_id);
  return { ...w, pid, c, p, run, text: mockReport(w.ws, 'claude', run) };
}

// copy: whether the answer's text reached the inbox before the stop (it is
// then set aside, kept and never imported).
const RESEARCH_POINTS = {
  'after the worker\'s check': { copy: false, inject: (t, s) => stopAfterCheck(t, s.ws, s.pid) },
  'inside the import, after the inbox copy and every check, just before the report is written': { copy: true, inject: (t, s) => stopAt(t, binding, 'bindingRecord', s.ws, s.pid) },
};
const setAsideCopies = (ws, pid) => (fs.existsSync(ws.abs('inbox/claude/processed')) ? fs.readdirSync(ws.abs('inbox/claude/processed')).filter((f) => f.includes(`_${pid}__`) && f.includes('.set-aside')) : []);

for (const [where, { copy, inject }] of Object.entries(RESEARCH_POINTS)) {
  test(`F2 research: a stop landing ${where} saves no report, completes no job and lets the claim go as stopped`, async (t) => {
    const s = await researchDispatched(t);
    const landed = inject(t, s);
    const done = PW.complete(s.ws, s.pid, s.c.token, { text: s.text, prompt_sha256: s.p.prompt_sha256 });
    assert.ok(landed(), 'the stop landed where the test put it');
    assertStopped(s.ws, s.pid, done);
    assert.deepEqual(claudeReports(s.ws, s.pid), [], 'no report was saved');
    const job = research.loadRun(s.ws, s.pid, s.run.run_id).jobs.claude;
    assert.notEqual(job.state, 'completed', 'the research job is not completed');
    assert.equal(job.report_id || null, null);
    assert.deepEqual(pendingInbox(s.ws, s.pid), [], 'no copy waits in the inbox to be imported later');
    assert.equal(inbox.inboxStatus(s.ws).in_inbox.filter((x) => String(x.filename || x.key || '').includes(s.pid)).length, 0);
    const kept = setAsideCopies(s.ws, s.pid);
    assert.equal(kept.length, copy ? 1 : 0, copy ? 'the copy the import made is set aside, kept, not imported' : 'nothing reached the inbox');
    if (copy) assert.equal(fs.readFileSync(s.ws.abs(`inbox/claude/processed/${kept[0]}`), 'utf8'), s.text, 'the text is kept as delivered');
    // Nothing downstream: no Prosecutor ticket, no decision.
    assert.equal(T.listTickets(s.ws, s.pid).length, 0, 'no Prosecutor ticket opened');
    assert.deepEqual(decisions(s.ws, s.pid), []);
    // A second delivery finds no claim; still nothing saved.
    assert.throws(() => PW.complete(s.ws, s.pid, s.c.token, { text: s.text, prompt_sha256: s.p.prompt_sha256 }), (e) => e.code === 'CHANGED');
    assert.deepEqual(claudeReports(s.ws, s.pid), []);
  });
}

test('F2 research: with no stop the same path saves, completes the job and releases the claim as saved (control)', async (t) => {
  const s = await researchDispatched(t);
  const done = PW.complete(s.ws, s.pid, s.c.token, { text: s.text, prompt_sha256: s.p.prompt_sha256 });
  assert.equal(done.status, 'saved', done.words);
  assert.equal(PC.read(s.ws, s.pid).outcome, 'saved');
  assert.equal(claudeReports(s.ws, s.pid).length, 1);
  assert.equal(research.loadRun(s.ws, s.pid, s.run.run_id).jobs.claude.state, 'completed');
});

// ---------------------------------------------------------------------------
// Agent 2: the Prosecutor's ticket, with the paper mandate armed.

async function ticketDispatched(t) {
  const s = mandateDesk(t, { mandate: true });
  T.setPilot(s.ws, s.pid, true);
  assert.equal(T.nextStep(s.ws, s.pid).step, 'ticket', 'the fixture starts at the Prosecutor\'s step');
  const c = PW.claimStep(s.ws, s.pid, { owner: 'f2' });
  const p = await PW.prepare(s.ws, s.pid, c.token, { fetchImpl: NO_NET });
  assert.deepEqual([p.status, p.role], ['prepared', 'prosecutor'], p.words);
  return { ...s, c, p, text: answer(T.loadTicket(s.ws, s.pid, p.ticket_id)) };
}

const TICKET_POINTS = {
  'after the worker\'s check': (t, s) => stopAfterCheck(t, s.ws, s.pid),
  'inside the save, after its first reads and before its operation': (t, s) => stopAt(t, forensics, 'findBlock', s.ws, s.pid),
};

for (const [where, inject] of Object.entries(TICKET_POINTS)) {
  test(`F2 prosecution: a stop landing ${where} saves no receipt, lets the claim go as stopped, and the armed mandate grants nothing`, async (t) => {
    const s = await ticketDispatched(t);
    const landed = inject(t, s);
    const done = PW.complete(s.ws, s.pid, s.c.token, { text: s.text, prompt_sha256: s.p.prompt_sha256 });
    assert.ok(landed(), 'the stop landed where the test put it');
    assertStopped(s.ws, s.pid, done);
    assert.deepEqual(receipts(s.ws, s.pid), [], 'no Prosecutor receipt was saved');
    const tk = T.loadTicket(s.ws, s.pid, s.p.ticket_id);
    assert.equal(tk.job.last_refusal || null, null, 'the stop is not recorded as a refusal of the ticket');
    // Downstream: the mandate is armed and finds nothing to grant.
    T.mandateSweep(s.ws);
    assert.deepEqual(decisions(s.ws, s.pid), [], 'no decision line, mandate or other');
    assert.throws(() => PW.complete(s.ws, s.pid, s.c.token, { text: s.text, prompt_sha256: s.p.prompt_sha256 }), (e) => e.code === 'CHANGED');
    assert.deepEqual(receipts(s.ws, s.pid), []);
  });
}

test('F2 prosecution: with no stop the same path saves the receipt and releases the claim as saved (control)', async (t) => {
  const s = await ticketDispatched(t);
  const done = PW.complete(s.ws, s.pid, s.c.token, { text: s.text, prompt_sha256: s.p.prompt_sha256 });
  assert.equal(done.status, 'saved', done.words);
  assert.equal(PC.read(s.ws, s.pid).outcome, 'saved');
  assert.equal(receipts(s.ws, s.pid).length, 1);
});

// The desk-wide pause is not a project stop: dispatched work still settles.
test('F2: the desk-wide pause landing between the check and the save does not refuse the save', async (t) => {
  const s = await ticketDispatched(t);
  const real = PC.stopIfHalted;
  t.mock.method(PC, 'stopIfHalted', (...a) => { const r = real.apply(PC, a); s.ws.settings = { ...s.ws.settings, automation: { ...s.ws.settings.automation, paused: true } }; return r; });
  const done = PW.complete(s.ws, s.pid, s.c.token, { text: s.text, prompt_sha256: s.p.prompt_sha256 });
  assert.equal(done.status, 'saved', done.words);
});
