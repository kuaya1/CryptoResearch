'use strict';
// OP-1 (2026-11-01): a re-opened ticket freezes a new packet, so it waits for
// the same exit evidence a first ticket waits for. The reproduction: a $0
// ticket was re-opened while the exit-quote target had just been approved and
// its first quote was still out; nextStep answered "ticket" at once, the
// worker's own quote was refused (the monitor held the lease) and the new
// packet froze no exit reading at any size. Fictional workspaces only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const T = require('../core/tickets');
const F = require('../core/forensics');
const PC = require('../core/pilot-claims');
const { withExitReadings } = require('./helpers');
const { mandateDesk, saveTicket } = require('./mandate-fixture');

const TOKEN = '0x00000000000000000000000000000000000f1c71'; // FICTIONAL

function onBase(ws, pid) {
  const file = ws.abs(`projects/${pid}/project.json`);
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  p.identity.assets = [{ chain: 'base', contract_address: TOKEN }];
  fs.writeFileSync(file, JSON.stringify(p, null, 2));
}

function reopenedDesk(t) {
  const s = mandateDesk(t, { mandate: false });
  onBase(s.ws, s.pid);
  // The first ticket froze no exit reading: the gate sized it $0.
  const first = saveTicket(s.ws, s.pid, { exits: false });
  assert.equal(first.desk.suggested_risk_usd, 0);
  // Enrollment approves the exit-quote target; no reading has arrived yet.
  T.setPilot(s.ws, s.pid, true, { by: 'eric' });
  assert.ok((F.readProfile(s.ws, s.pid).targets.exit_quotes || []).length > 0, 'enrollment approved an exit-quote target');
  // Eric re-opens it while a reading is current (the re-open's own rule).
  withExitReadings(1.5, () => T.decide(s.ws, s.pid, { receipt_id: first.receipt_id, action: 'reopen', by: 'eric' }));
  return { ...s, first };
}

test('a re-opened ticket waits for a complete exit reading before a Prosecutor is claimed', (t) => {
  const s = reopenedDesk(t);
  const waiting = T.nextStep(s.ws, s.pid);
  assert.equal(waiting.step, 'exit_evidence', waiting.why);
  assert.equal(waiting.reopen, true);
  assert.match(waiting.why, new RegExp(`re-opened`));
  assert.equal(PC.claim(s.ws, s.pid, { owner: 'regression', now: Date.now() }).status, 'nothing', 'no claim, so no session and no frozen packet');
  assert.equal(withExitReadings(1.5, () => T.nextStep(s.ws, s.pid), { complete: false }).step, 'exit_evidence', 'incomplete costs still wait');
});

test('POST /api/projects/:id/tickets/:tk/cancel: signed in, with a reason, never under a live claim; the canceled ticket and its packet are kept and the re-open waits for evidence again', async (t) => {
  const http = require('http');
  const { start } = require('../server');
  const s = reopenedDesk(t);
  // The live incident's ticket: opened on the re-open with no exit reading.
  const opened = T.createTicket(s.ws, { project_id: s.pid, assistant: true, refresh: true });
  assert.ok(opened.ticket_id, opened.message);
  const tid = opened.ticket_id;
  const packet = T.loadTicket(s.ws, s.pid, tid).packet;
  const srv = await start(s.ws, { port: 47600 + Math.floor(Math.random() * 300), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } });
  const ask = (p, headers = {}, body = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: p, method: body === null ? 'GET' : 'POST', headers: { host: `127.0.0.1:${srv.port}`, ...(body !== null ? { 'content-type': 'application/json', origin: `http://127.0.0.1:${srv.port}` } : {}), ...headers } }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(Buffer.concat(c).toString()); } catch (_) { return null; } })() }));
    });
    req.on('error', reject);
    req.end(body !== null ? JSON.stringify(body) : undefined);
  });
  const token = (await ask('/api/session', {}, null)).json.token;
  const path = `/api/projects/${s.pid}/tickets/${tid}/cancel`;
  const stillOpen = () => T.loadTicket(s.ws, s.pid, tid).job.state;
  assert.equal((await ask(path, {}, { reason: 'FICTIONAL' })).status, 401, 'signed in only');
  assert.equal((await ask(path, { 'x-cr-token': token }, {})).status, 400, 'a reason is required');
  assert.equal((await ask(`/api/projects/${s.pid}/tickets/tk_2026-01-01T000000Z_nones/cancel`, { 'x-cr-token': token }, { reason: 'FICTIONAL' })).status, 404);
  // A live pilot claim on the project: refused, nothing changed.
  const c = PC.claim(s.ws, s.pid, { owner: 'regression', now: Date.now() });
  assert.equal(c.status, 'claimed_now', c.words);
  const busy = await ask(path, { 'x-cr-token': token }, { reason: 'FICTIONAL: empty packet' });
  assert.equal(busy.status, 409, JSON.stringify(busy.json));
  assert.match(busy.json.error, /live/);
  assert.ok(['waiting', 'running'].includes(stillOpen()));
  PC.release(s.ws, s.pid, { token: c.token, outcome: 'stopped' });
  // Released: canceled with the reason; the ticket and its frozen packet are kept.
  const done = await ask(path, { 'x-cr-token': token }, { reason: 'FICTIONAL: empty packet' });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.deepEqual([done.json.status, done.json.state], ['canceled', 'canceled']);
  assert.match(done.json.cancel_reason, /^Eric: FICTIONAL: empty packet$/);
  const kept = T.loadTicket(s.ws, s.pid, tid);
  assert.deepEqual(kept.packet, packet, 'the frozen packet is untouched');
  assert.equal((await ask(path, { 'x-cr-token': token }, { reason: 'again' })).json.status, 'unchanged');
  // The re-open stands again: it waits for the reading, then opens a fresh ticket.
  assert.equal(T.nextStep(s.ws, s.pid).step, 'exit_evidence');
  const ready = withExitReadings(1.5, () => T.nextStep(s.ws, s.pid));
  assert.deepEqual([ready.step, ready.ticket_id, ready.refresh], ['ticket', null, true]);
  srv.shutdown();
});

test('once the reading is complete the re-open proceeds as before: a refresh ticket on the same report; the old receipt is kept', (t) => {
  const s = reopenedDesk(t);
  const ready = withExitReadings(1.5, () => T.nextStep(s.ws, s.pid));
  assert.deepEqual([ready.step, ready.refresh, ready.reopen, ready.ticket_id], ['ticket', true, true, null], ready.why);
  const r2 = saveTicket(s.ws, s.pid, { exits: true, reopen: true });
  assert.equal(r2.desk.suggested_risk_usd, 500, 'the new packet froze the reading and the gate sized it');
  assert.ok(T.listReceipts(s.ws, s.pid).some((r) => r.receipt_id === s.first.receipt_id && !r.broken), 'the re-opened receipt is kept');
});
