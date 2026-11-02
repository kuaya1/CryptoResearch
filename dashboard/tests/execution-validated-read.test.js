'use strict';
// Audit F5 (audit-blueprint-implementation-2026-11-02.md): the decision
// basis's execution view read the trader's journal with its own
// fs.readFileSync and JSON.parse (decision-basis.js executionOf), without the
// book's hash chain, head record or venue check. An edited reservation
// (quantity 999, chain not repaired) showed through the basis view while the
// trader's own adapter refused the same journal as INTEGRITY.
//
// Now the execution view reads through the desk's one adapter
// (trader-desk.js executionFor), which runs the book's own integrity checks
// (paper-trader.js, protected and unchanged) over the same bytes it then
// shows. A damaged journal (an edited, malformed or removed line, lines lost
// from its end, a missing head, a venue order the journal never sent) is
// refused exactly as the adapter refuses it: no execution value is shown,
// the reason is the book's own words, and unknown is never an empty list.
//
// FICTIONAL temporary workspaces only: nothing here is a market, a venue or
// an order.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const T = require('../core/tickets');
const TD = require('../core/trader-desk');
const PT = require('../core/paper-trader');
const DB = require('../core/decision-basis');
const { sha256 } = require('../core/fsx');
const { mandateDesk, saveTicket, mandateArgs } = require('./mandate-fixture');
const { H, iso, settle, bar } = require('./trader-fixture');

const ROOT = path.resolve(__dirname, '..', '..');
const J = 'paper/trader/journal.jsonl';
const HEAD = 'paper/trader/journal.head.json';
const VENUE = 'paper/trader/venue.jsonl';
const NO_VALUES = { reserved: null, fills: null, exits: null };

// A mandate halve whose order the book reserved and filled (the §5.3
// acceptance flow in decision-basis.test.js, up to the fill).
function recorded(t) {
  const s = mandateDesk(t, { grade: 52 });
  const { ws, pid } = s;
  const r = saveTicket(ws, pid);
  const rv = T.contractVerdictNow;
  const rc = T.contractCheckOf;
  T.contractVerdictNow = () => ({ tier: 'pass', words: 'FICTIONAL pass', findings: [] });
  T.contractCheckOf = () => ({ status: 'holding', words: 'unchanged' });
  t.after(() => { T.contractVerdictNow = rv; T.contractCheckOf = rc; });
  const d = T.decide(ws, pid, { receipt_id: r.receipt_id, action: 'halve', request_id: `mandate_${r.receipt_id}`, mandate: mandateArgs('exploratory_50_54', 52) }).result.decision;
  settle(ws, { book: { fee_rate: '0.004' } });
  const now0 = Date.now();
  const top = Math.floor(now0 / H) * H;
  TD.applyHours(ws, Array.from({ length: 16 }, (_, i) => bar(top - (16 - i) * H)), { now: iso(now0) });
  T.reconcileEffects(ws);
  TD.step(ws);
  TD.applyHours(ws, [bar(top), bar(top + H, { open: '0.85', high: '0.86', low: '0.80', close: '0.84', volume: '1000000' })], { now: iso(top + 2 * H + 11 * 60000) });
  const v = DB.viewOf(ws, pid, d.decision_id);
  assert.equal(v.execution.state, 'recorded', 'the fixture reaches a reserved, filled order');
  assert.ok(v.execution.fills.length >= 1);
  return { ...s, d, v };
}

const lines = (ws) => fs.readFileSync(ws.abs(J), 'utf8').split('\n').filter((l) => l.trim());
const write = (ws, ls) => fs.writeFileSync(ws.abs(J), `${ls.join('\n')}\n`);
const reservedAt = (ls, did) => ls.findIndex((l) => { const e = JSON.parse(l); return e.type === 'reserved' && e.intent && e.intent.decision_id === did; });

// The basis view refuses the execution exactly where the adapter refuses the book.
function assertRefused(s, why) {
  const v = DB.viewOf(s.ws, s.pid, s.d.decision_id);
  assert.equal(v.label, 'decision_time', 'the decision basis itself still reads');
  const x = v.execution;
  assert.equal(x.state, 'integrity', `${why}: the execution is refused, not shown (state ${x.state}, reserved ${JSON.stringify(x.reserved && x.reserved.map((r) => r.quantity))})`);
  assert.equal(x.code, 'INTEGRITY');
  assert.deepEqual({ reserved: x.reserved, fills: x.fills, exits: x.exits }, NO_VALUES, `${why}: no execution value is shown, and unknown is never an empty list`);
  assert.doesNotMatch(JSON.stringify(x), /"999"/, 'the edited figure never appears');
  let adapter = null;
  try { TD.view(s.ws); } catch (err) { adapter = err; }
  assert.ok(adapter && adapter.code === 'INTEGRITY', `${why}: the trader's own adapter refuses the same journal`);
  assert.equal(x.words, adapter.message, 'in the book\'s own words, the same refusal');
  return x;
}

test('F5: an edited reservation (quantity 999, chain not repaired) is refused by the basis view as the adapter refuses it', (t) => {
  const s = recorded(t);
  const ls = lines(s.ws);
  const i = reservedAt(ls, s.d.decision_id);
  const e = JSON.parse(ls[i]);
  e.quantity = '999';
  ls[i] = JSON.stringify(e);
  write(s.ws, ls);
  assertRefused(s, 'an edited reservation');
});

test('F5: a partial repair (the next line re-chained, the rest not) is still refused; a full re-chain with a rewritten head reads the same in both readers, never two readings', (t) => {
  const s = recorded(t);
  const ls = lines(s.ws);
  const i = reservedAt(ls, s.d.decision_id);
  assert.ok(i < ls.length - 2, 'the reservation has at least two lines after it');
  const e = JSON.parse(ls[i]);
  e.quantity = '999';
  ls[i] = JSON.stringify(e);
  const rechain = (k) => { const n = JSON.parse(ls[k]); n.prev_sha256 = sha256(ls[k - 1]); ls[k] = JSON.stringify(n); };
  rechain(i + 1);
  write(s.ws, ls);
  assertRefused(s, 'an edit with only the next line re-chained');
  // Every later line re-chained and the head rewritten: the book's own checks
  // (hash chain, head, venue) hold, so the trader reads it, and the basis view
  // shows exactly what the book holds; it is not a second, laxer reader.
  for (let k = i + 2; k < ls.length; k += 1) rechain(k);
  write(s.ws, ls);
  const h = JSON.parse(fs.readFileSync(s.ws.abs(HEAD), 'utf8'));
  fs.writeFileSync(s.ws.abs(HEAD), `${JSON.stringify({ ...h, seq: ls.length, head_sha256: sha256(ls[ls.length - 1]) })}\n`);
  const x = DB.viewOf(s.ws, s.pid, s.d.decision_id).execution;
  const book = PT.intents(s.ws).find((o) => o.intent_id === e.intent_id);
  assert.equal(x.state, 'recorded');
  assert.equal(x.reserved[0].quantity, book.quantity, 'the basis view and the book agree, whatever the book holds');
});

test('F5: lines lost from the end of the journal are refused (its head names a later line)', (t) => {
  const s = recorded(t);
  const ls = lines(s.ws);
  write(s.ws, ls.slice(0, -1));
  assertRefused(s, 'a truncated journal');
});

test('F5: a journal cut back to before the reservation is refused, never read as "none"', (t) => {
  const s = recorded(t);
  const ls = lines(s.ws);
  write(s.ws, ls.slice(0, reservedAt(ls, s.d.decision_id)));
  assertRefused(s, 'a journal cut before the reservation');
});

test('F5: a malformed line is the same refusal as any other damage, not a separate "unreadable" reading', (t) => {
  const s = recorded(t);
  const ls = lines(s.ws);
  ls.splice(1, 0, '{"seq": not json');
  write(s.ws, ls);
  assertRefused(s, 'a malformed line');
});

test('F5: a missing head record and a venue order the journal never sent are refused', (t) => {
  const s = recorded(t);
  const head = fs.readFileSync(s.ws.abs(HEAD));
  fs.unlinkSync(s.ws.abs(HEAD));
  assertRefused(s, 'a missing head');
  fs.writeFileSync(s.ws.abs(HEAD), head);
  assert.equal(DB.viewOf(s.ws, s.pid, s.d.decision_id).execution.state, 'recorded', 'restored, it reads again');
  fs.appendFileSync(s.ws.abs(VENUE), `${JSON.stringify({ client_order_id: 'cr2-FICTIONAL-never-sent', state: 'ACKED' })}\n`);
  assertRefused(s, 'a venue order the journal never sent');
});

test('F5: an intact journal shows the values the book holds for that order, and nothing is written by reading', (t) => {
  const s = recorded(t);
  const before = [J, HEAD, VENUE].map((rel) => sha256(fs.readFileSync(s.ws.abs(rel))));
  const x = DB.viewOf(s.ws, s.pid, s.d.decision_id).execution;
  assert.equal(x.state, 'recorded');
  assert.equal(x.code || null, null);
  const r = x.reserved[0];
  const book = PT.intents(s.ws).find((i) => i.intent_id === r.intent_id);
  assert.ok(book, 'the reservation is one the book holds');
  assert.deepEqual([r.client_order_id, r.position_id, r.quantity], [book.client_order_id, book.position_id, book.quantity], 'the same order, the same quantity as the book');
  assert.equal(r.venue.fee_rate, '0.004');
  assert.deepEqual(before, [J, HEAD, VENUE].map((rel) => sha256(fs.readFileSync(s.ws.abs(rel)))), 'reading writes nothing');
});

test('F5: the journal changing while it is read is refused, never shown from a mix of two versions', (t) => {
  const s = recorded(t);
  const real = PT.intents;
  let once = false;
  t.mock.method(PT, 'intents', (ws) => {
    const out = real(ws);
    if (!once) {
      once = true;
      const ls = lines(ws);
      const i = reservedAt(ls, s.d.decision_id);
      const e = JSON.parse(ls[i]);
      e.quantity = '999';
      ls[i] = JSON.stringify(e);
      write(ws, ls);
    }
    return out;
  });
  const x = DB.viewOf(s.ws, s.pid, s.d.decision_id).execution;
  assert.ok(once, 'the change landed during the read');
  assert.equal(x.state, 'integrity');
  assert.deepEqual({ reserved: x.reserved, fills: x.fills, exits: x.exits }, NO_VALUES);
  assert.match(x.words, /changed while/);
});

test('F5: the CLI entry (tickets basis) refuses the damaged execution the same way', async (t) => {
  const { run } = require('../cli');
  const s = recorded(t);
  const ok = await run(['tickets', 'basis', s.pid, s.d.decision_id, '--workspace', s.root]);
  assert.equal(ok.execution.state, 'recorded');
  const ls = lines(s.ws);
  const i = reservedAt(ls, s.d.decision_id);
  const e = JSON.parse(ls[i]);
  e.quantity = '999';
  ls[i] = JSON.stringify(e);
  write(s.ws, ls);
  const bad = await run(['tickets', 'basis', s.pid, s.d.decision_id, '--workspace', s.root]);
  assert.equal(bad.execution.state, 'integrity');
  assert.deepEqual({ reserved: bad.execution.reserved, fills: bad.execution.fills, exits: bad.execution.exits }, NO_VALUES);
});

test('F5: the attribution view refuses as INTEGRITY over signed-in HTTP, also when the journal is damaged after its trader read, never counting the order as absent', async (t) => {
  const http = require('http');
  const GOV = require('../core/grade-outcome-view');
  const s = recorded(t);
  const intact = GOV.view(s.ws);
  assert.ok(intact.rows.some((r) => r.decision_id === s.d.decision_id && r.order), 'intact: the order is in the view');
  // Damage landing between the view's trader read and its basis read.
  const tv = TD.view(s.ws);
  const realView = TD.view;
  t.mock.method(TD, 'view', () => tv);
  const ls = lines(s.ws);
  const i = reservedAt(ls, s.d.decision_id);
  const e = JSON.parse(ls[i]);
  e.quantity = '999';
  ls[i] = JSON.stringify(e);
  write(s.ws, ls);
  assert.throws(() => GOV.view(s.ws), (err) => err.code === 'INTEGRITY' && !/TypeError/.test(String(err)), 'refused, not a crash and not a zero');
  TD.view.mock.restore();
  assert.equal(TD.view, realView);
  // The public entry: signed in, the route answers 409 INTEGRITY.
  const { start } = require('../server');
  const srv = await start(s.ws, { port: 49800 + Math.floor(Math.random() * 90), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } });
  const res = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: '/api/research/attribution', headers: { host: `127.0.0.1:${srv.port}`, 'x-cr-token': srv.token } }, (r) => { const c = []; r.on('data', (x) => c.push(x)); r.on('end', () => resolve({ status: r.statusCode, json: JSON.parse(Buffer.concat(c).toString() || 'null') })); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(res.status, 409, JSON.stringify(res.json));
  assert.equal(res.json.code, 'INTEGRITY');
  assert.doesNotMatch(JSON.stringify(res.json), /"999"/);
});

// The boundary the require scan in trader-boundary.test.js does not see: a
// file that reads the book's records from disk itself.
test('F5: only the book and its one adapter read the trader\'s journal, head or venue records', () => {
  const allowed = new Set(['dashboard/core/paper-trader.js', 'dashboard/core/trader-desk.js']);
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (!['node_modules', 'app', 'dist', 'tests'].includes(e.name)) walk(rel); } else if (/\.(c|m)?jsx?$/.test(e.name)) out.push(rel);
    }
  };
  walk('dashboard');
  const offenders = [];
  for (const rel of out) {
    if (allowed.has(rel)) continue;
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // The book's paths by name, or a file read of the constants that hold them.
    if (/paper\/trader\/(journal|venue)/.test(src) || /(readFileSync|readFile|createReadStream|openSync)\([^\n]*\b(JOURNAL|VENUE|PT\.HEAD|TD\.HEAD)\b/.test(src)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], 'no other reader of the protected execution history');
});
