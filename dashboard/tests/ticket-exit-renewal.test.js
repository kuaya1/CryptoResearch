'use strict';
// Exit-evidence renewal (cr-ticket-exit-evidence@1; the cohesion audit's M3
// and brief 3, 2026-10-29): a ticket whose frozen exit readings passed the
// desk's 72-hour window says so before consent, refuses a grant that could
// never open (409 EXIT_EXPIRED, nothing written), and offers one explicit
// renewal: Re-open, which keeps the old receipt and opens a successor ticket
// on fresh readings for Eric's review. Temporary workspaces and fictional
// tickets only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const T = require('../core/tickets');
const { sha256, jsonText } = require('../core/fsx');
const { withExitReadings, freshPrice } = require('./helpers');
const { H, answer, deskWith } = require('./trader-fixture');

// Ages the receipt's frozen exit readings to `hours` ago, keeping the packet
// pinned (a FICTIONAL rewrite of a test record, as if the ticket were old).
function ageExits(ws, pid, rid, hours) {
  const rel = `projects/${pid}/tickets/receipts/${rid}.json`;
  const rc = JSON.parse(fs.readFileSync(ws.abs(rel), 'utf8'));
  const pk = JSON.parse(fs.readFileSync(ws.abs(rc.packet.path), 'utf8'));
  const at = new Date(Date.now() - hours * H).toISOString();
  pk.exits = pk.exits.map((x) => ({ ...x, as_of: at }));
  const text = jsonText(pk);
  fs.writeFileSync(ws.abs(rc.packet.path), text);
  rc.packet.sha256 = sha256(text);
  fs.writeFileSync(ws.abs(rel), jsonText(rc));
  return { at, receiptText: fs.readFileSync(ws.abs(rel), 'utf8') };
}
const decisionsOf = (ws, pid) => { try { return fs.readFileSync(ws.abs(`projects/${pid}/tickets/decisions.jsonl`), 'utf8'); } catch (_) { return ''; } };

test('M3: a current ticket says when its exit readings stop giving the trader a size', (t) => {
  const { ws, pid, rid } = deskWith(t);
  const v = T.view(ws, pid).ticket;
  assert.equal(v.receipt_id, rid);
  assert.equal(v.exit_evidence.state, 'current');
  assert.equal(v.exit_evidence.version, T.EXIT_EVIDENCE_VERSION);
  assert.equal(v.exit_evidence.fresh_hours, 72);
  assert.ok(Date.parse(v.exit_evidence.expires_at) > Date.now() + 71 * H);
  assert.match(v.exit_evidence.words, /give the trader a size until/);
  assert.equal(v.can_reopen, null);
  // At the boundary: one minute past the window the same receipt reads expired.
  const later = T.exitEvidenceOf(ws, JSON.parse(fs.readFileSync(ws.abs(`projects/${pid}/tickets/receipts/${rid}.json`), 'utf8')), Date.parse(v.exit_evidence.expires_at) + 60000);
  assert.equal(later.expired, true);
});

test('M3: expired exit readings refuse a grant (409 EXIT_EXPIRED, nothing written) and offer one renewal that keeps the old receipt', (t) => {
  const { ws, pid, rid } = deskWith(t);
  const { receiptText } = ageExits(ws, pid, rid, 73);
  const v = T.view(ws, pid).ticket;
  assert.equal(v.status, 'pending_pm_review');
  assert.equal(v.exit_evidence.state, 'expired');
  assert.match(v.exit_evidence.words, /expired .* UTC .* no order would be made\. Renew the exit evidence/);
  assert.equal(v.can_reopen.kind, 'exit_expired');

  for (const action of ['approve', 'halve']) {
    assert.throws(() => T.decide(ws, pid, { receipt_id: rid, action, request_id: `req_m3_${action}0001` }), (e) => e.code === 'EXIT_EXPIRED' && /Not recorded: The exit readings this ticket froze expired/.test(e.message) && e.details.changed[0].kind === 'exit_evidence');
  }
  assert.equal(decisionsOf(ws, pid), '', 'a refused grant writes nothing');
  const { sendError } = require('../frontdoor');
  let sent = null;
  sendError({ method: 'POST' }, { writeHead: (s) => { sent = { status: s }; }, setHeader() {}, end: (b) => { sent.body = JSON.parse(b); } }, Object.assign(new Error('x'), { code: 'EXIT_EXPIRED', details: { changed: [{ kind: 'exit_evidence' }] } }));
  assert.equal(sent.status, 409);
  assert.equal(sent.body.saved, false);

  // The renewal: Re-open, once. The same request again, or a second click, is the same decision.
  const r1 = T.decide(ws, pid, { receipt_id: rid, action: 'reopen', request_id: 'req_m3_renew00001' });
  assert.equal(r1.result.status, 'saved');
  assert.equal(r1.result.decision.reopen.kind, 'exit_expired');
  assert.equal(T.decide(ws, pid, { receipt_id: rid, action: 'reopen', request_id: 'req_m3_renew00001' }).result.status, 'unchanged');
  assert.equal(T.decide(ws, pid, { receipt_id: rid, action: 'reopen', request_id: 'req_m3_renew00002' }).result.status, 'unchanged');
  assert.equal(decisionsOf(ws, pid).trim().split('\n').length, 1);
  const after = T.view(ws, pid).ticket;
  assert.equal(after.status, 'reopened');
  assert.equal(after.can_reopen, null);
  const step = T.nextStep(ws, pid);
  assert.equal(step.step, 'ticket');
  assert.equal(step.reopen, true);

  // The successor: a new ticket on fresh readings; the old receipt is unchanged.
  const opened = withExitReadings(1.5, () => T.createTicket(ws, { project_id: pid, reopen: true, assistant: true }));
  assert.ok(opened.ticket && opened.ticket.ticket_id);
  freshPrice(ws, 'example-payfi-fictional', 0.85);
  const saved = T.saveTicket(ws, { project_id: pid, ticket_id: opened.ticket.ticket_id, text: answer(T.loadTicket(ws, pid, opened.ticket.ticket_id)) });
  assert.notEqual(saved.receipt_id, rid);
  assert.equal(fs.readFileSync(ws.abs(`projects/${pid}/tickets/receipts/${rid}.json`), 'utf8'), receiptText, 'the old receipt is kept as it was');
  const next = T.view(ws, pid).ticket;
  assert.equal(next.receipt_id, saved.receipt_id);
  assert.equal(next.status, 'pending_pm_review', 'new evidence needs new consent: nothing is carried over');
  assert.equal(next.exit_evidence.state, 'current');
  assert.equal(T.view(ws, pid, { receiptId: rid }).ticket.status, 'reopened', 'the old decision stays on the old receipt');
  const granted = T.decide(ws, pid, { receipt_id: saved.receipt_id, action: 'halve', request_id: 'req_m3_halve00001' });
  assert.equal(granted.result.status, 'saved');
  assert.ok(granted.result.trader, 'the trader\'s answer comes back with the decision');
});

test('M3: a grant already in force is not re-opened over expired readings; an older-rule refusal still names the three reasons', (t) => {
  const { ws, pid, rid } = deskWith(t);
  T.decide(ws, pid, { receipt_id: rid, action: 'halve', request_id: 'req_m3_halve00002' });
  ageExits(ws, pid, rid, 80);
  const v = T.view(ws, pid).ticket;
  assert.equal(v.exit_evidence.expired, true);
  assert.equal(v.can_reopen, null);
  assert.throws(() => T.decide(ws, pid, { receipt_id: rid, action: 'reopen', request_id: 'req_m3_renew00003' }), (e) => e.code === 'REFUSED' && /exit readings expired before any grant/.test(e.message));
});
