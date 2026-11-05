'use strict';
// A book that once existed is never a new one. With its journal and head both
// gone the trader reads what a book reads before its first funding, so the desk
// has to ask the record outside the book: the operation log. Temporary
// workspaces and fictional projects, pairs and hours only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const T = require('../core/tickets');
const TD = require('../core/trader-desk');
const PT = require('../core/paper-trader');
const B = require('../core/brief-daily');
const { OPLOG_REL } = require('../core/ops');
const { tempWorkspace, hashTree } = require('./helpers');
const { H, M, iso, deskWith, settle, bar, mine } = require('./trader-fixture');

const FUNDED_AT = '2026-10-01T00:00:00.000Z';
const AT = Date.parse('2026-10-05T00:00:00Z');
const NOW = iso(AT);

function funded(t) {
  const w = tempWorkspace('lost-book');
  t.after(w.cleanup);
  w.ws.settings.trader = { rules: {}, book: { cash_usd: '1000', fee_rate: '0.003' } };
  assert.equal(PT.fund(w.ws, { cash_usd: '1000', now: FUNDED_AT }).status, 'saved');
  return w;
}
const lose = (ws) => { fs.rmSync(ws.abs(PT.JOURNAL)); fs.rmSync(ws.abs(PT.HEAD)); };
const refused = (fn) => assert.throws(fn, (e) => e.code === 'INTEGRITY' && /lost, not new/.test(e.message), 'refused as a lost book');
function saidInTheBrief(ws, at) {
  const att = B.attention(ws, { now: at });
  assert.ok(att.exceptions.items.some((e) => e.reason === 'trader_unreadable'), 'an exception');
  assert.equal(att.exceptions.count, null, 'the count is unknown, never zero');
  const sec = B.brief(ws, { now: at }).sections.find((s) => s.id === 'exceptions');
  assert.equal(sec.state, 'partial');
  assert.equal(sec.count, null);
}

// A real history: a funded book, an order from Eric's grant, a fill, an open
// position with its stop.
function history(t) {
  const s = deskWith(t);
  const { ws, pid, rid } = s;
  const decision = T.decide(ws, pid, { receipt_id: rid, action: 'approve', request_id: 'req_lost_approve1' }).result.decision;
  settle(ws);
  const now0 = Date.now();
  const top = Math.floor(now0 / H) * H;
  TD.applyHours(ws, Array.from({ length: 16 }, (_, i) => bar(top - (16 - i) * H)), { now: iso(now0) });
  TD.step(ws);
  const fillHour = Math.ceil(Date.now() / H) * H;
  const at = fillHour + H + M;
  TD.applyHours(ws, Array.from({ length: Math.round((fillHour - top) / H) + 1 }, (_, i) => bar(top + i * H)), { now: iso(at) });
  assert.equal(TD.view(ws, { now: iso(at) }).results.open_positions.length, 1, 'the fixture holds an open position');
  assert.equal(mine(TD.requests(ws, { now: iso(at) }), decision.decision_id).phase, 'open');
  return { ...s, at, top };
}

test('a book with a position, its whole folder gone: refused everywhere, said in the brief, nothing funded or re-ordered', (t) => {
  const { ws, at, top } = history(t);
  fs.rmSync(ws.abs('paper/trader'), { recursive: true });
  const now = iso(at);
  refused(() => TD.view(ws, { now }));
  refused(() => TD.requests(ws, { now }));
  refused(() => TD.wanted(ws, { now }));
  refused(() => TD.pending(ws, { now }));
  refused(() => TD.step(ws, { now }));
  saidInTheBrief(ws, at);
  const out = TD.applyHours(ws, [bar(top)], { now });
  assert.deepEqual(out.map((r) => [r.status, r.code]), [['refused', 'INTEGRITY']]);
  assert.match(out[0].words, /lost, not new/);
  assert.equal(fs.existsSync(ws.abs(PT.JOURNAL)), false, 'no new journal in its place');
});

test('a funded book with no orders, journal and head gone: the same, and a read writes nothing', (t) => {
  const { root, ws } = funded(t);
  lose(ws);
  const before = hashTree(root);
  refused(() => TD.view(ws, { now: NOW }));
  saidInTheBrief(ws, AT);
  assert.deepEqual(hashTree(root), before, 'reads write nothing');
  refused(() => TD.step(ws, { now: NOW }));
  assert.deepEqual(TD.applyHours(ws, [], { now: NOW }).map((r) => r.code), ['INTEGRITY']);
  assert.equal(fs.existsSync(ws.abs(PT.JOURNAL)), false, 'the book was not funded again');
});

test('the decision basis does not call a lost book no book; a new book still is one', (t) => {
  const { ws } = funded(t);
  lose(ws);
  refused(() => TD.executionFor(ws, 'dec_fictional'));
  const w = tempWorkspace('new-book-basis');
  t.after(w.cleanup);
  assert.equal(TD.executionFor(w.ws, 'dec_fictional').state, 'no_book');
});

test('put back, the book reads again as it was', (t) => {
  const { ws } = funded(t);
  const j = fs.readFileSync(ws.abs(PT.JOURNAL));
  const h = fs.readFileSync(ws.abs(PT.HEAD));
  lose(ws);
  refused(() => TD.view(ws, { now: NOW }));
  fs.writeFileSync(ws.abs(PT.JOURNAL), j);
  fs.writeFileSync(ws.abs(PT.HEAD), h);
  assert.equal(TD.view(ws, { now: NOW }).results.funded_usd, '1000');
  assert.deepEqual(TD.step(ws, { now: NOW }).problems, []);
});

test('a genuinely new book still reads and funds once', (t) => {
  const w = tempWorkspace('new-book');
  t.after(w.cleanup);
  const { ws } = w;
  ws.settings.trader = { rules: {}, book: { cash_usd: '1000', fee_rate: '0.003' } };
  assert.equal(TD.view(ws, { now: NOW }).results.funded_usd, null);
  assert.equal(B.attention(ws, { now: AT }).exceptions.count, 0);
  assert.deepEqual(TD.step(ws, { now: NOW }).done.map((d) => [d.kind, d.status]), [['fund', 'saved']]);
  assert.equal(TD.view(ws, { now: NOW }).results.funded_usd, '1000');
  assert.deepEqual(TD.step(ws, { now: NOW }).done, [], 'once');
  const fundCommits = fs.readFileSync(ws.abs(OPLOG_REL), 'utf8').split('\n').filter((l) => l.includes('"paper_trader.fund.') && l.includes('"phase":"commit"'));
  assert.equal(fundCommits.length, 1);
});

test('a new book funds through the hours path too', (t) => {
  const w = tempWorkspace('new-book-hours');
  t.after(w.cleanup);
  w.ws.settings.trader = { rules: {}, book: { cash_usd: '1000', fee_rate: '0.003' } };
  assert.deepEqual(TD.applyHours(w.ws, [], { now: NOW }), []);
  assert.equal(TD.view(w.ws, { now: NOW }).results.funded_usd, '1000');
});

test('what counts as evidence: a commit or a recovery of a funding, never a funding that only began, failed, or another operation', (t) => {
  const line = (o) => `${JSON.stringify({ at: FUNDED_AT, ...o })}\n`;
  const log = (ws, text) => fs.appendFileSync(ws.abs(OPLOG_REL), text);
  const fresh = () => {
    const w = tempWorkspace('lost-book-evidence');
    t.after(w.cleanup);
    return w.ws;
  };
  for (const text of [
    line({ op_id: 'o', phase: 'begin', type: 'paper_trader.fund.abc' }),
    line({ op_id: 'o', phase: 'failed', type: 'paper_trader.fund.abc' }),
    line({ op_id: 'o', phase: 'rolled_back', type: 'paper_trader.fund.abc' }),
    line({ op_id: 'o', phase: 'commit', type: 'paper_trader.apply_bar.abc', summary: 'paper_trader.fund.abc' }),
    line({ op_id: 'o', phase: 'commit', type: 'settings' }),
    '{"phase":"commit","type":"paper_trader.fund.abc", torn\n',
  ]) {
    const ws = fresh();
    log(ws, text);
    assert.equal(TD.view(ws, { now: NOW }).results.funded_usd, null, text);
  }
  for (const phase of ['commit', 'commit_unverified', 'recovered_forward']) {
    const ws = fresh();
    log(ws, line({ op_id: 'o', phase, type: 'paper_trader.fund.abc' }));
    refused(() => TD.view(ws, { now: NOW }));
  }
});

test('an unfunded book whose operation log does not read is unknown, never new; an absent log is no evidence', (t) => {
  const w = tempWorkspace('lost-book-log');
  t.after(w.cleanup);
  const { ws } = w;
  fs.rmSync(ws.abs(OPLOG_REL), { force: true });
  assert.equal(TD.view(ws, { now: NOW }).results.funded_usd, null, 'the limit: with the log gone too, this reads as new');
  fs.mkdirSync(ws.abs(OPLOG_REL), { recursive: true });
  assert.throws(() => TD.view(ws, { now: NOW }), (e) => e.code === 'INTEGRITY' && /whether the unfunded book once existed is unknown/.test(e.message));
  const out = TD.applyHours(ws, [], { now: NOW });
  assert.deepEqual(out.map((r) => r.code), ['INTEGRITY']);
});

test('a funded book does not depend on the operation log', (t) => {
  const { ws } = funded(t);
  fs.rmSync(ws.abs(OPLOG_REL), { force: true });
  fs.mkdirSync(ws.abs(OPLOG_REL), { recursive: true });
  assert.equal(TD.view(ws, { now: NOW }).results.funded_usd, '1000');
  fs.rmSync(ws.abs(OPLOG_REL), { recursive: true });
});

test('a corrupt book keeps its own refusal', (t) => {
  const { ws } = funded(t);
  fs.writeFileSync(ws.abs(PT.JOURNAL), 'FICTIONAL not json\n');
  assert.throws(() => TD.view(ws, { now: NOW }), (e) => e.code === 'INTEGRITY' && !/lost, not new/.test(e.message));
  assert.throws(() => TD.applyHours(ws, [bar(AT - 2 * H)], { now: NOW }), (e) => e.code === 'INTEGRITY' && !/lost, not new/.test(e.message));
});

test('a funding that commits between the two reads is not called lost', (t) => {
  const { ws } = funded(t);
  const real = PT.results;
  let calls = 0;
  t.mock.method(PT, 'results', (...a) => {
    const r = real(...a);
    calls += 1;
    return calls === 1 ? { ...r, funded_usd: null } : r;
  });
  assert.doesNotThrow(() => TD.view(ws, { now: NOW }));
  assert.ok(calls >= 2, 'the book was read again after the log');
});
