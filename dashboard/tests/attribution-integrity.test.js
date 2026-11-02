'use strict';
// Audit 2026-11-02 F6: a damaged record under the attribution view
// (core/grade-outcome-view.js) is an INTEGRITY refusal, 409 through the
// signed-in route, naming the record (blueprint §5.2), and it never turns a
// reservation the book recorded into zero: the book's facts are read apart
// from the basis (§5.3, "never merged"), and every denominator (§5.4) is the
// intact one. When the book's own journal does not read, no count is given
// at all: unknown is not zero (docs/CONSTITUTION.md, Law 4).
//
// Before this fix the route answered 200 with orders_reserved 0, every fill
// count 0 and the closed position's fees "incomplete" for a damaged basis.
// Temporary FICTIONAL workspaces only; no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const T = require('../core/tickets');
const TD = require('../core/trader-desk');
const V = require('../core/grade-outcome-view');
const DB = require('../core/decision-basis');
const { tempWorkspace, addFixtureProject, importAllFixtures, withExitReadings, freshPrice } = require('./helpers');
const { H, M, iso, answer, settle, bar } = require('./trader-fixture');

// The §5.6 illustration (as in grade-outcome-view.test.js): one approved
// grant, a 100-unit order reserved, 40 filled, the position closed at the
// target. Its intact denominators are the baseline every refusal must keep.
const PROPOSAL = {
  entry_zone: { low_usd: 9.9, high_usd: 10, basis: 'prior range (FICTIONAL)' },
  upside_target: { price_usd: 10.8, basis: 'fees double (FICTIONAL)' },
  invalidation_trigger: { price_usd: 9.5, metric: { key: 'fees', below_30d_usd: 100000 }, statement: 'Below $9.50 or fees under $100k a month (FICTIONAL).' },
};
const calm = (start) => bar(start, { open: '10.2', high: '10.25', low: '10.15', close: '10.2', volume: '10000' });

function illustrated(t) {
  const w = tempWorkspace('attribution-integrity');
  t.after(w.cleanup);
  const pid = addFixtureProject(w.ws).project_id;
  importAllFixtures(w.ws);
  const portfolio = require('../core/portfolio');
  const real = portfolio.computePortfolio;
  portfolio.computePortfolio = (...a) => ({ ...real(...a), positions: [] });
  t.after(() => { portfolio.computePortfolio = real; });
  const tk = withExitReadings(1.5, () => T.createTicket(w.ws, { project_id: pid, assistant: true })).ticket;
  freshPrice(w.ws, 'example-payfi-fictional', 10.2);
  const saved = T.saveTicket(w.ws, { project_id: pid, ticket_id: tk.ticket_id, text: answer(T.loadTicket(w.ws, pid, tk.ticket_id), PROPOSAL) });
  settle(w.ws, { book: { cash_usd: '4000', fee_rate: '0.001' } });
  const top = Math.floor(Date.now() / H) * H;
  TD.applyHours(w.ws, Array.from({ length: 16 }, (_, i) => calm(top - (16 - i) * H)), { now: iso(Date.now()) });
  const d = T.decide(w.ws, pid, { receipt_id: saved.receipt_id, action: 'approve', by: 'eric' }).result;
  assert.equal(d.trader.status, 'order', 'the decision reserved a Trader Sim order');
  TD.applyHours(w.ws, [calm(top)], { now: iso(top + H + 11 * M) });
  TD.applyHours(w.ws, [bar(top + H, { open: '10.05', high: '10.10', low: '9.90', close: '10.00', volume: '400' })], { now: iso(top + 2 * H + 11 * M) });
  TD.step(w.ws, { now: iso(top + 2 * H + 12 * M) });
  TD.applyHours(w.ws, [bar(top + 2 * H, { open: '10.70', high: '10.90', low: '10.60', close: '10.80', volume: '400' })], { now: iso(top + 3 * H + 11 * M) });
  TD.step(w.ws, { now: iso(top + 3 * H + 12 * M) });
  return { ...w, pid, rid: saved.receipt_id, report: saved.receipt.researcher.report_id, decision: d.decision, end: iso(top + 3 * H + 30 * M) };
}

function tree(root) {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(root, p).split(path.sep).join('/')] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(root);
  return out;
}

// The intact view's denominators: what every refusal must still say.
const INTACT = {
  decisions_granted: 1,
  intents: { not_opened_final: 0, not_opened_not_final: 0, waiting: 0, refused: 0 },
  orders_reserved: 1,
  fills: { full: 0, part: 1, unfilled: 0, pending: 0, unknown: 0 },
  positions: { open: 0, closed: 1 },
  closed_fees: { complete: 1, incomplete: 0 },
  basis: { decision_time: 1, unverified: 0, reconstructed: 0, refused: 0 },
  excluded: { count: 0, of: 1, rule: 'none', words: '0 excluded of 1.' },
};
const REFUSED_BASIS = { decision_time: 0, unverified: 0, reconstructed: 0, refused: 1 };

const appendByte = (abs, b = ' ') => fs.writeFileSync(abs, Buffer.concat([fs.readFileSync(abs), Buffer.from(b)]));

// Each damage, applied to a freshly illustrated desk.
const DAMAGES = [
  // A byte that leaves the basis valid JSON is audit F3's (the basis's own bytes carry no digest yet); here, bytes that do not read.
  ['the decision basis, a byte that breaks it', /decision basis/, (s) => appendByte(s.ws.abs(DB.basisRel(s.pid, s.decision.decision_id)), 'x')],
  ['the decision basis, a valid-JSON edit naming another decision', /does not belong to decision/, (s) => {
    const abs = s.ws.abs(DB.basisRel(s.pid, s.decision.decision_id));
    const b = JSON.parse(fs.readFileSync(abs, 'utf8'));
    b.decision_id = `${b.decision_id.slice(0, -1)}${b.decision_id.endsWith('0') ? '1' : '0'}`;
    fs.writeFileSync(abs, JSON.stringify(b, null, 2));
  }],
  ['the ticket receipt, re-serialized with one field changed', /ticket receipt does not match/, (s) => {
    const abs = s.ws.abs(`projects/${s.pid}/tickets/receipts/${s.rid}.json`);
    const r = JSON.parse(fs.readFileSync(abs, 'utf8'));
    r.saved_at = 'FICTIONAL-edit';
    fs.writeFileSync(abs, JSON.stringify(r, null, 2));
  }],
  ['the original of the decision\'s report, one byte added', /original of report/, (s) => {
    const r = require('../core/reports').loadReports(s.ws, s.pid).find((x) => x.report_id === s.report);
    appendByte(s.ws.abs(`${r.dir}/${r.meta.original_file}`));
  }],
];

for (const [name, says, damage] of DAMAGES) {
  test(`F6: ${name} refuses the view by name (INTEGRITY) and keeps every denominator the book recorded`, (t) => {
    const s = illustrated(t);
    assert.deepEqual(V.view(s.ws, { now: s.end }).denominators, INTACT, 'the intact baseline');
    damage(s);
    const before = tree(s.root);
    let err = null;
    assert.throws(() => V.view(s.ws, { now: s.end }), (e) => { err = e; return e.code === 'INTEGRITY'; });
    assert.deepEqual(tree(s.root), before, 'the refused read wrote nothing');
    assert.match(err.message, /^The attribution view is refused: 1 record does not hold\. Nothing is rebuilt or put in its place\./);
    assert.ok(err.message.includes(s.decision.decision_id), 'the decision is named');
    assert.match(err.message, says, 'the record is named');
    assert.match(err.message, /1 decision granted, 1 order reserved, 0 positions open and 1 closed\./);
    assert.deepEqual(err.details.refused.map((x) => [x.decision_id, x.record, x.state]), [[s.decision.decision_id, 'decision_basis', 'integrity']]);
    // Every denominator is the intact one; only the basis count says refused.
    assert.deepEqual(err.details.denominators, { ...INTACT, basis: REFUSED_BASIS });
  });
}

test('F6: a book journal that does not read refuses the view with no count at all: unknown is not zero', (t) => {
  const s = illustrated(t);
  const abs = s.ws.abs(TD.JOURNAL);
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  const i = lines.findIndex((l) => l.includes('"type":"reserved"'));
  assert.ok(i >= 0, 'the reservation is on record');
  lines[i] = lines[i].slice(0, -3);
  fs.writeFileSync(abs, lines.join('\n'));
  const before = tree(s.root);
  let err = null;
  assert.throws(() => V.view(s.ws, { now: s.end }), (e) => { err = e; return e.code === 'INTEGRITY'; });
  assert.deepEqual(tree(s.root), before, 'the refused read wrote nothing');
  // The book's own reader refuses it first, in its own words, with no count.
  assert.match(err.message, /paper\/trader\/journal\.jsonl line \d+ does not follow the line before it/);
  assert.doesNotMatch(err.message, /orders? reserved|orders_reserved/);
  assert.ok(!err.details || err.details.denominators === undefined || err.details.denominators === null, 'no count from an unread book');
});

test('F6: the signed-in route answers 409 INTEGRITY naming the record and the book\'s counts, writes no record, and still refuses an unsigned request', async (t) => {
  const s = illustrated(t);
  const { start } = require('../server');
  const srv = await start(s.ws, { port: 49900 + Math.floor(Math.random() * 90), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } });
  const get = (p, headers) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: p, method: 'GET', headers: { host: `127.0.0.1:${srv.port}`, ...headers } }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(c).toString() || 'null') }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
  const signed = { 'x-cr-token': srv.token };
  const ok = await get('/api/research/attribution', signed);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.denominators, INTACT);

  appendByte(s.ws.abs(DB.basisRel(s.pid, s.decision.decision_id)), 'x');
  const before = tree(s.root);
  const r = await get('/api/research/attribution', signed);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'INTEGRITY');
  assert.equal(r.json.saved, false);
  assert.ok(r.json.error.includes(s.decision.decision_id), 'the decision is named');
  assert.match(r.json.error, /decision basis/);
  assert.match(r.json.error, /1 decision granted, 1 order reserved, 0 positions open and 1 closed\./);
  assert.equal(r.json.denominators, undefined, 'no view body with a refusal');
  assert.equal((await get('/api/research/attribution', {})).status, 401);
  // Read-only: every record the view reads is byte-identical. The server's
  // own background timers may write their bookkeeping meanwhile, and nothing else.
  const after = tree(s.root);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((f) => before[f] !== after[f]);
  const BOOKKEEPING = /^(logs\/(jobs-state\.json|operations\.jsonl|ingestion-state\.json)|\.cr\/|dashboard\/index\/|market-data\/)/;
  assert.deepEqual(changed.filter((f) => !BOOKKEEPING.test(f)), [], `only the server's own bookkeeping changed: ${changed.join(', ')}`);
  for (const f of Object.keys(before)) if (/^(projects|paper|config)\//.test(f)) assert.equal(after[f], before[f], `${f} unchanged`);
});

test('F6: an execution reader that refuses (a journal that does not read, or after audit F5 one that disagrees with the book) refuses the view with no count', (t) => {
  const s = illustrated(t);
  // Only the reader's answer is replaced; the view's handling of it is what is proved.
  const real = DB.executionOf;
  DB.executionOf = () => ({ label: 'execution_time', source: TD.JOURNAL, state: 'unreadable', words: `${TD.JOURNAL} has a line that does not read; execution is not shown from a partial journal.`, reserved: [], fills: [], exits: [], not_recorded: [] });
  t.after(() => { DB.executionOf = real; });
  let err = null;
  assert.throws(() => V.view(s.ws, { now: s.end }), (e) => { err = e; return e.code === 'INTEGRITY'; });
  assert.ok(err.message.includes(s.decision.decision_id));
  assert.match(err.message, /has a line that does not read/);
  assert.match(err.message, /The book's own records do not read, so no count is given: unknown is not zero\.$/);
  assert.doesNotMatch(err.message, /orders? reserved/);
  assert.deepEqual(err.details.refused.map((x) => [x.record, x.state]), [['book_journal', 'unreadable']]);
  assert.equal(err.details.denominators, null, 'no count from an unread book, never zero');
});
