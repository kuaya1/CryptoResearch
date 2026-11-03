'use strict';
// N2 (post-remediation audit, 2026-11-02; Codex's P4): the local pilot runner
// (scripts/pilot.js localSteps) asked `tickets check` for Eric's stop, then
// ran the CLI's import as a separate command. A stop landing between the two
// still saved the session's answer, and the claim was released as done.
//
// The runner now hands its claim token to the import (--token), and the CLI
// asks the stop inside the save's own locked operation (cli.js claimedSave,
// pilot-claims stopGuard), as the worker's complete does (pilot-worker.js,
// tickets.js saveTicketOnce, inbox.js importContent). A stop before the commit
// saves nothing, sets aside any inbox copy, and lets the claim go as stopped.
//
// Every CLI call here is the real CLI in its own process, as the runner makes
// it, against a FICTIONAL temporary workspace. The only stand-ins are the
// agent (a fixture answer, no claude -p) and the injection point: Eric's stop,
// landed in this process right after the real `tickets check` returned ok.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('../scripts/pilot');
const PC = require('../core/pilot-claims');
const MA = require('../core/mandate-authority');
const T = require('../core/tickets');
const research = require('../core/research');
const { mockReport } = require('../core/demo');
const { tempWorkspace, addFixtureProject, freshPrice } = require('./helpers');
const { mandateDesk } = require('./mandate-fixture');
const { answer } = require('./trader-fixture');

const CLI = path.join(__dirname, '..', 'cli.js');
const stop = (ws, pid) => MA.setAutonomy(ws, pid, { action: 'stop', note: 'FICTIONAL stop after the runner\'s check', by: 'eric' });
const receipts = (ws, pid) => T.listReceipts(ws, pid).filter((r) => !r.broken && !r.desk_gate);
const claudeReports = (ws, pid) => require('../core/reports').loadReports(ws, pid).filter((r) => r.broken || (r.record && r.record.provider === 'claude'));
const inboxWaiting = (ws, pid) => (fs.existsSync(ws.abs('inbox/claude')) ? fs.readdirSync(ws.abs('inbox/claude')).filter((f) => f.startsWith(`${pid}__`)) : []);
const setAside = (ws, pid) => (fs.existsSync(ws.abs('inbox/claude/processed')) ? fs.readdirSync(ws.abs('inbox/claude/processed')).filter((f) => f.includes(`${pid}__`) && f.includes('.set-aside')) : []);

// The runner's CLI (pilot.js cli): the real CLI in its own process, on this
// workspace. `afterCheck` runs once, right after a `tickets check` answered ok.
function realCli(ws, { afterCheck = null } = {}) {
  const calls = [];
  let landed = false;
  const call = (args, { text = false } = {}) => {
    calls.push(args);
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CR_WORKSPACE: ws.root } });
    if (r.status !== 0) throw new Error(`cli ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.stdout || '').trim().slice(0, 600)}`);
    if (text) return r.stdout;
    const out = JSON.parse(r.stdout);
    if (afterCheck && !landed && args[0] === 'tickets' && args[1] === 'check' && out.status === 'ok') { landed = true; afterCheck(); }
    return out;
  };
  return { call, calls, landed: () => landed };
}

function assertStoppedClaim(ws, pid) {
  const c = PC.read(ws, pid);
  assert.equal(c.released, true, 'the claim is let go');
  assert.equal(c.outcome, 'autonomy_stopped', `the claim's outcome is stopped, not ${c.outcome}`);
  assert.notEqual(c.outcome, 'done');
  assert.equal(c.stopped.state_at_stop, 'dispatched');
  assert.equal(c.stopped.session_dispatched, true);
  assert.equal(MA.automationGate(ws, pid).project_stopped, true);
  assert.equal(T.nextStep(ws, pid).step, 'blocked', 'no further step');
  return c;
}

const importCall = (calls, a, b) => calls.find((x) => x[0] === a && x[1] === b);

// ---------------------------------------------------------------------------
// Agent 2: the Prosecutor's ticket.

function ticketDesk(t) {
  const s = mandateDesk(t, { mandate: false });
  T.setPilot(s.ws, s.pid, true);
  assert.equal(T.nextStep(s.ws, s.pid).step, 'ticket', 'the fixture starts at the Prosecutor\'s step');
  return s;
}
const prosecutor = (s) => Object.assign(() => answer(T.loadTicket(s.ws, s.pid, PC.read(s.ws, s.pid).ticket_id)), { ready: () => true });

test('N2 (P4) ticket: a stop after the runner\'s `tickets check` and before the import commits saves no receipt; the claim reads stopped', (t) => {
  const s = ticketDesk(t);
  const cli = realCli(s.ws, { afterCheck: () => stop(s.ws, s.pid) });
  const r = P.runLocal({ project: s.pid, dryRun: false }, { call: cli.call, agent: prosecutor(s) });
  assert.ok(cli.landed(), 'the stop landed after the check, as the test put it');
  const imp = importCall(cli.calls, 'tickets', 'import');
  assert.ok(imp, 'the runner went on to the import, as before');
  assert.ok(imp.includes('--token'), 'the import carries the runner\'s claim');
  assert.equal(r.stop, 'stopped');
  assert.equal(r.session_stopped, true);
  assert.equal(receipts(s.ws, s.pid).length, 0, 'zero receipts');
  assertStoppedClaim(s.ws, s.pid);
  assert.ok(!cli.calls.some((x) => x[0] === 'tickets' && x[1] === 'release'), 'never released as done');
});

test('N2 ticket: with no stop the same runner saves the receipt and releases the claim (control)', (t) => {
  const s = ticketDesk(t);
  const cli = realCli(s.ws);
  const r = P.runLocal({ project: s.pid, dryRun: false }, { call: cli.call, agent: prosecutor(s) });
  assert.equal(r, undefined, 'the runner ends at the PM review');
  assert.equal(receipts(s.ws, s.pid).length, 1);
  const c = PC.read(s.ws, s.pid);
  assert.equal(c.released, true);
  assert.notEqual(c.outcome, 'autonomy_stopped');
});

test('N2 ticket: an import under the runner\'s claim saves nothing when the project is already stopped', (t) => {
  const s = ticketDesk(t);
  const c = PC.claim(s.ws, s.pid, { owner: 'n2' });
  const tk = T.createTicket(s.ws, { project_id: s.pid, assistant: true });
  PC.bind(s.ws, s.pid, c.token, { ticket_id: tk.ticket_id });
  stop(s.ws, s.pid);
  const f = path.join(s.ws.root, 'n2-answer.md');
  fs.writeFileSync(f, answer(T.loadTicket(s.ws, s.pid, tk.ticket_id)));
  const out = realCli(s.ws).call(['tickets', 'import', s.pid, tk.ticket_id, '--text-file', f, '--token', c.token]);
  assert.equal(out.status, 'stopped');
  assert.equal(out.saved, false);
  assert.match(out.words, /suspended by Eric's autonomy stop/);
  assert.equal(receipts(s.ws, s.pid).length, 0);
  assertStoppedClaim(s.ws, s.pid);
});

// ---------------------------------------------------------------------------
// Agent 1: the researcher's report (import-text).

function researchDesk(t) {
  const w = tempWorkspace('n2-research');
  t.after(w.cleanup);
  const pid = addFixtureProject(w.ws).project_id;
  freshPrice(w.ws, 'example-payfi-fictional', 0.85);
  T.setPilot(w.ws, pid, true);
  assert.equal(T.nextStep(w.ws, pid).step, 'research', 'the fixture starts at Agent 1');
  return { ...w, pid };
}

test('N2 (P4) research: a stop after the runner\'s `tickets check` and before the report commits saves no report, completes no job; the claim reads stopped', (t) => {
  const s = researchDesk(t);
  const cli = realCli(s.ws, { afterCheck: () => stop(s.ws, s.pid) });
  const agent = Object.assign(() => mockReport(s.ws, 'claude', research.loadRun(s.ws, s.pid, PC.read(s.ws, s.pid).run_id)), { ready: () => true });
  const r = P.runLocal({ project: s.pid, dryRun: false }, { call: cli.call, agent });
  assert.ok(cli.landed(), 'the stop landed after the check');
  const imp = importCall(cli.calls, 'import-text', '--provider');
  assert.ok(imp && imp.includes('--token'), 'the import carries the runner\'s claim');
  assert.equal(r.stop, 'stopped');
  assert.equal(r.session_stopped, true);
  assert.deepEqual(claudeReports(s.ws, s.pid), [], 'no report saved');
  const c = assertStoppedClaim(s.ws, s.pid);
  const job = research.loadRun(s.ws, s.pid, c.run_id).jobs.claude;
  assert.notEqual(job.state, 'completed', 'the research job is not completed');
  assert.deepEqual(inboxWaiting(s.ws, s.pid), [], 'no copy waits in the inbox to be imported later');
  assert.equal(setAside(s.ws, s.pid).length, 0, 'the import\'s first guard refused it before any inbox copy was made');
  assert.equal(T.listTickets(s.ws, s.pid).length, 0, 'no Prosecutor ticket opened');
});

test('N2: without --token the CLI imports exactly as before (Eric\'s own imports are unchanged)', (t) => {
  const s = ticketDesk(t);
  const tk = T.createTicket(s.ws, { project_id: s.pid, assistant: true });
  const f = path.join(s.ws.root, 'n2-plain.md');
  fs.writeFileSync(f, answer(T.loadTicket(s.ws, s.pid, tk.ticket_id)));
  const out = realCli(s.ws).call(['tickets', 'import', s.pid, tk.ticket_id, '--text-file', f]);
  assert.equal(out.status, 'saved');
  assert.equal(receipts(s.ws, s.pid).length, 1);
});
