'use strict';
// A replacement ticket when an exit reading arrives after a ticket froze none
// (tickets.js exitArrivedOf, reopenReason kind exit_evidence_arrived).
// FICTIONAL temporary workspaces; the readings are handed to forensics.view
// for the duration of a call only.

const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../core/tickets');
const F = require('../core/forensics');
const projects = require('../core/projects');
const { withExitReadings } = require('./helpers');
const { mandateDesk, saveTicket } = require('./mandate-fixture');

const H = 3600000;
// A reading at $500 of the given cost, `ageH` hours old, complete or not.
function withReading(fn, { cost = 1.5, ageH = 1, complete = true } = {}) {
  const real = F.view;
  const at = new Date(Date.now() - ageH * H).toISOString();
  const row = (size, c) => ({ size_usd: size, status: 'current', as_of: at, note: null, best: { cost_pct: c, cost_complete: complete, missing_costs: complete ? [] : ['network fee'], method: 'executable_quote', route_scope: 'aggregator', retrieved_at: at } });
  F.view = () => ({ liquidity: { exits: [row(100, cost / 2), row(500, cost), row(2000, cost * 2)] } });
  try { return fn(); } finally { F.view = real; }
}

function noExitTicket(t, opts = {}) {
  const s = mandateDesk(t, opts);
  const r = saveTicket(s.ws, s.pid, { exits: false });
  assert.equal(r.desk.suggested_risk_usd, 0, 'a ticket with no exit reading is sized $0');
  return { ...s, r, project: projects.getProject(s.ws, s.pid) };
}

test('a $0 ticket that froze no exit, plus a fresh complete reading within the limit: exit_evidence_arrived, and Re-open works', (t) => {
  const s = noExitTicket(t);
  assert.equal(T.exitArrivedOf(s.ws, s.project, s.r), null, 'no reading yet');
  const k = withReading(() => T.exitArrivedOf(s.ws, s.project, s.r));
  assert.equal(k.kind, 'exit_evidence_arrived');
  assert.equal(k.exit.size_usd, 500);
  assert.equal(k.exit.cost_pct, 1.5);
  assert.match(k.why, /arrived after this ticket froze none/);
  assert.equal(withReading(() => T.reopenReason(s.ws, s.project, s.r)).kind, 'exit_evidence_arrived');
  assert.equal(withReading(() => T.view(s.ws, s.pid)).ticket.can_reopen.kind, 'exit_evidence_arrived');
  const d = withReading(() => T.decide(s.ws, s.pid, { receipt_id: s.r.receipt_id, action: 'reopen', by: 'eric' })).result.decision;
  assert.equal(d.reopen.kind, 'exit_evidence_arrived');
  const r2 = withExitReadings(1.5, () => saveTicket(s.ws, s.pid, { exits: true, reopen: true }));
  assert.equal(r2.desk.suggested_risk_usd, 500, 'the replacement froze the reading and is sized');
  assert.equal(withReading(() => T.exitArrivedOf(s.ws, s.project, r2)), null, 'a ticket that froze an exit is not re-opened for one');
});

test('a stale, partial or over-limit reading gives nothing', (t) => {
  const s = noExitTicket(t);
  assert.equal(withReading(() => T.exitArrivedOf(s.ws, s.project, s.r), { ageH: 73 }), null, 'older than 72 hours');
  assert.equal(withReading(() => T.exitArrivedOf(s.ws, s.project, s.r), { complete: false }), null, 'a lower bound');
  assert.equal(withReading(() => T.exitArrivedOf(s.ws, s.project, s.r), { cost: 6 }), null, 'over the 5% limit');
  assert.ok(withReading(() => T.exitArrivedOf(s.ws, s.project, s.r), { ageH: 71 }));
});

test('a grade under the floor in force gives nothing: a replacement would still be $0', (t) => {
  const s = noExitTicket(t, { grade: 52 });
  assert.ok(withReading(() => T.exitArrivedOf(s.ws, s.project, s.r)));
  s.ws.settings.tickets.sizing.min_grade_new_entry = 55;
  assert.equal(withReading(() => T.exitArrivedOf(s.ws, s.project, s.r)), null);
  s.ws.settings.tickets.sizing.min_grade_new_entry = 50;
  s.setGrade(49);
  assert.equal(withReading(() => T.exitArrivedOf(s.ws, s.project, s.r)), null);
});

test('the desk\'s gate receipt, or a receipt whose packet does not read, gives nothing', (t) => {
  const s = noExitTicket(t);
  assert.equal(withReading(() => T.exitArrivedOf(s.ws, s.project, { ...s.r, kind: 'desk_gate' })), null);
  assert.equal(withReading(() => T.exitArrivedOf(s.ws, s.project, { ...s.r, packet: { ...s.r.packet, sha256: '0'.repeat(64) } })), null, 'fails closed');
  assert.equal(withReading(() => T.exitArrivedOf(s.ws, s.project, { ...s.r, packet: null })), null);
});

test('the paper mandate re-opens once per Claude report: a replacement that still froze no exit is not re-opened again', (t) => {
  const s = noExitTicket(t);
  const m = { version: T.MANDATE_VERSION, tier: null, grade_used: 52 };
  // Nothing has arrived: refused, nothing written.
  assert.throws(() => T.decide(s.ws, s.pid, { receipt_id: s.r.receipt_id, action: 'reopen', request_id: `mreopen_${s.r.receipt_id}`, mandate: m }), (e) => e.code === 'REFUSED' && e.details.reason === 'MANDATE_NO_REOPEN');
  const d = withReading(() => T.decide(s.ws, s.pid, { receipt_id: s.r.receipt_id, action: 'reopen', request_id: `mreopen_${s.r.receipt_id}`, mandate: m })).result.decision;
  assert.equal(d.decided_by, 'mandate:cr-paper-mandate@1');
  assert.equal(d.reopen.kind, 'exit_evidence_arrived');
  assert.equal(d.mandate.tier, null);
  assert.equal(d.effects.paper, null);
  assert.equal(d.effects.trader, null);
  const step = T.nextStep(s.ws, s.pid);
  assert.equal(step.step, 'ticket');
  assert.equal(step.reopen, true);
  assert.match(step.why, /^The paper mandate re-opened ticket/);
  // The replacement (refresh, as the next step says) is opened while the
  // reading is gone again: it froze none.
  const r2 = T.createTicket(s.ws, { project_id: s.pid, assistant: true, refresh: true });
  assert.ok(r2.ticket, r2.message);
  const saved = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: r2.ticket.ticket_id, text: require('./trader-fixture').answer(T.loadTicket(s.ws, s.pid, r2.ticket.ticket_id)) }).receipt;
  assert.equal(saved.desk.suggested_risk_usd, 0);
  assert.ok(withReading(() => T.exitArrivedOf(s.ws, s.project, saved)), 'Eric could still re-open it by hand');
  assert.throws(() => withReading(() => T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'reopen', request_id: `mreopen_${saved.receipt_id}`, mandate: m })), (e) => e.code === 'REFUSED' && e.details.reason === 'MANDATE_REOPEN_DONE');
});
