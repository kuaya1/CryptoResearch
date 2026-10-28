'use strict';
// The trader's Paper Book, cr-paper@2 (core/paper-trader.js; backlog item 74).
// Temporary workspaces and a fictional pair only: nothing here is a market,
// an account, a venue or an order.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tempWorkspace } = require('./helpers');
const { sha256 } = require('../core/fsx');
const PT = require('../core/paper-trader');
const paper = require('../core/paper');

const H = 3600000;
const M = 60000;
const T0 = Date.parse('2026-10-27T00:00:00Z');
// Fifteen closed hours behind it. Orders are sent at the top of hour 15: an
// order fills only from hours that start at or after it was sent (red team
// P1-7), so one sent at 15:05 would first fill from hour 16. And an order
// expires in the hour its life ends (P2-14), so the fixture's orders live 175
// minutes under a 180-minute longest validity (they were 115 and 120): an
// order sent at 15:00 can still fill in hours 15 and 16 and expires in hour
// 17, and a close sent at 16:01 can fill in hour 17.
const NOW = T0 + 15 * H;
const at = (ms) => new Date(ms).toISOString();
const ID = (c) => `01JBXQ5R7Z8Y9W0V1T2S3R4Q5${c}`;
const VENUE = { lot: '0.001', min_notional_usd: '10', maker_rate: '0.001', taker_rate: '0.002' };
const RULES = { stop_min_pct: '0.01', stop_min_atr: '1', notional_max_pct: '0.25', price_stale_minutes: 15, max_validity_minutes: 180, allowlist: ['FICT/USDC'] };
// The ticket every fixture intent acts on (cr.trade-intent.v3, D8): a
// fictional project, receipt and decision. Its grant is read from the stored
// decision; the book read takes the ticket in ctx.ticket, a reservation from
// the intent itself, and neither takes a grant from ctx.
const PID = 'fict-project';
const RID = 'tr_2026-10-27T000000Z_fict2';
const DID = 'td_fict0000000001';
const TICKET = { project_id: PID, receipt_id: RID, decision_id: DID };
const DECISIONS = `projects/${PID}/tickets/decisions.jsonl`;
const decision = (over = {}) => ({ schema_version: 'cr.ticket-decision.v1', decision_id: DID, project_id: PID, receipt_id: RID, ticket_id: 'tk_2026-10-27T000000Z_fict2', action: 'approve', pm_approved_risk_usd: 250, suggested_risk_usd: 250, proposal_type: 'ACCUMULATE', note: null, decided_at: '2026-10-27T00:00:00.000Z', decided_by: 'eric', request_id: null, ...over });
function writeDecisions(ws, ls) {
  fs.mkdirSync(ws.abs(`projects/${PID}/tickets`), { recursive: true });
  fs.writeFileSync(ws.abs(DECISIONS), ls.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
}
// The ticket's frozen exit readings (D11): its receipt and the packet the
// receipt's SHA-256 names. The cap is read from them, never from ctx.
const TID = 'tk_2026-10-27T000000Z_fict2';
const RECEIPT = `projects/${PID}/tickets/receipts/${RID}.json`;
const PACKET = `projects/${PID}/tickets/${TID}/packet.json`;
const exitRow = (size, cost, over = {}) => ({ size_usd: size, status: 'measured', cost_pct: cost, cost_complete: true, missing_costs: [], method: 'executable_quote', route_scope: 'aggregator', as_of: at(T0), note: null, ...over });
const EXITS = [exitRow(500, 0.4), exitRow(5000, 1.2), exitRow(20000, 7.5)];
function writeExits(ws, exits = EXITS, { limit = 5, receipt = {}, packetText = null } = {}) {
  const text = packetText === null ? JSON.stringify({ project_id: PID, exits }, null, 2) + '\n' : packetText;
  fs.mkdirSync(ws.abs(`projects/${PID}/tickets/${TID}`), { recursive: true });
  fs.mkdirSync(ws.abs(`projects/${PID}/tickets/receipts`), { recursive: true });
  fs.writeFileSync(ws.abs(PACKET), text);
  const rc = { schema_version: 'cr.ticket-receipt.v1', receipt_id: RID, project_id: PID, ticket_id: TID, packet: { path: PACKET, sha256: sha256(text), captured_at: at(T0) }, desk: { sizing: { max_exit_cost_pct: limit } }, ...receipt };
  fs.writeFileSync(ws.abs(RECEIPT), JSON.stringify(rc, null, 2) + '\n');
}
const ctx = (now = NOW, over = {}) => ({ now: at(now), rules: RULES, venue: VENUE, ticket: TICKET, ...over });
const bar = (i, over = {}) => ({ pair: 'FICT/USDC', hour: at(T0 + i * H), open: '100', high: '101', low: '99.5', close: '100', volume: '1000000', ...over });
const hour = (ws, i, over = {}, now = T0 + (i + 1) * H) => PT.applyBar(ws, bar(i, over), { now: at(now) });
const intent = (c, over = {}, now = NOW) => ({
  version: 'cr.trade-intent.v3', intent_id: ID(c), thesis_id: RID, ...TICKET, pair: 'FICT/USDC', side: 'OPEN_LONG', order_type: 'LIMIT',
  created_at: at(now - 2 * M), reference_price: '100', reference_at: at(now - 3 * M), entry_price: '100', stop_loss_price: '95', take_profit_price: '115',
  risk_ceiling_usd: '100', max_slippage_bps: 20, valid_until: at(now + 175 * M),
  evidence: { catalyst: 'Fictional catalyst', metrics_evaluated: ['fictional metric'], negative_invalidation: 'Fictional invalidation' },
  ...over,
});

// Funded, fifteen hours on record, Eric's approve of `grant` on the ticket,
// and its exit readings (a $5,000 cap under a 5% limit).
function setup(t, { cash = '10000', grant = 250 } = {}) {
  const tw = tempWorkspace('ptrader');
  t.after(tw.cleanup);
  const ws = tw.ws;
  writeDecisions(ws, [decision({ pm_approved_risk_usd: grant, suggested_risk_usd: grant })]);
  writeExits(ws);
  assert.equal(PT.fund(ws, { cash_usd: cash, now: at(T0) }).status, 'saved');
  for (let i = 0; i < 15; i++) hour(ws, i);
  return ws;
}
const res = (ws, now) => PT.results(ws, { now: at(now) });
const venueLines = (ws) => { try { return fs.readFileSync(ws.abs(PT.VENUE), 'utf8').split('\n').filter(Boolean).length; } catch (_) { return 0; } };
const D = (s) => Number(s);

test('an intent is sized by cr-trade-risk@2 with the stop slippage and fees in, reserved, sent and acknowledged', (t) => {
  const ws = setup(t);
  const b = PT.book(ws, 'FICT/USDC', ctx());
  assert.deepEqual([b.nav_usd, b.cash_usd, b.drawdown_24h_usd, b.price, b.atr_14h], ['10000', '10000', '0', '100', '1.5']);
  assert.deepEqual(b.unknown, []);
  const r = PT.submitIntent(ws, intent('A'), ctx());
  assert.equal(r.state, 'ACKED');
  assert.equal(r.client_order_id, `cr2-${ID('A')}`);
  // Stop fill 95 less 25 bps = 94.7625; per unit 5.2375 + 0.2 + 0.189525.
  assert.deepEqual(r.sizing, { quantity: '17.771', notional_usd: '1777.1', loss_at_stop_usd: '99.997861275', per_unit_loss_usd: '5.627025' });
  // Committed: the notional and its taker fee.
  assert.equal(PT.book(ws, 'FICT/USDC', ctx()).available_cash_usd, '8219.3458');
  assert.equal(venueLines(ws), 1);
});

test('a limit buy fills only when the low trades below it, never at a touch, at its limit, with the taker fee', (t) => {
  const ws = setup(t);
  PT.submitIntent(ws, intent('A'), ctx());
  assert.deepEqual(hour(ws, 15, { low: '100', open: '100.5', close: '100.5' }).events.map((e) => e.type), ['bar']);
  const e = hour(ws, 16, { low: '99.99' }).events;
  assert.deepEqual(e.map((x) => x.type), ['bar', 'fill']);
  assert.deepEqual([e[1].quantity, e[1].price], ['17.771', '100']);
  const r = res(ws, T0 + 17 * H + M);
  assert.equal(r.cash_usd, '8219.3458');
  assert.equal(r.fees_usd, '3.5542');
  assert.deepEqual(r.orders.map((o) => o.state), ['FILLED']);
  const p = r.open_positions[0];
  assert.deepEqual([p.quantity, p.entry_price, p.notional_usd, p.cost_usd, p.planned_loss_at_stop_usd], ['17.771', '100', '1777.1', '1780.6542', '99.997861275']);
  // NAV, cash, value and the unrealized result are kept apart.
  assert.deepEqual([r.nav_usd, p.value_usd, p.unrealized_pnl_usd, r.unrealized_pnl_usd, r.realized_pnl_usd], ['9996.4458', '1777.1', '-3.5542', '-3.5542', '0']);
});

test('one hour fills at most FILL_SHARE_MAX of its volume; the rest stays open as a partial fill', (t) => {
  const ws = setup(t);
  PT.submitIntent(ws, intent('A'), ctx());
  assert.equal(PT.FILL_SHARE_MAX, '0.1');
  const e = hour(ws, 15, { low: '99', volume: '50.009' }).events;
  assert.equal(e.find((x) => x.type === 'fill').quantity, '5', '10% of 50.009 is 5.0009, floored to the lot');
  let r = res(ws, T0 + 16 * H + M);
  assert.deepEqual(r.orders.map((o) => [o.state, o.filled]), [['PARTIAL', '5']]);
  assert.equal(r.open_positions[0].quantity, '5');
  hour(ws, 16, { low: '99', volume: '1000' });
  r = res(ws, T0 + 17 * H + M);
  assert.deepEqual(r.orders.map((o) => [o.state, o.filled]), [['FILLED', '17.771']]);
  assert.equal(r.open_positions[0].quantity, '17.771');
  // Volume under one lot's share fills nothing.
  const ws2 = setup(t);
  PT.submitIntent(ws2, intent('B'), ctx());
  assert.deepEqual(hour(ws2, 15, { low: '99', volume: '0.009' }).events.map((x) => x.type), ['bar']);
});

test('POST_ONLY pays the maker fee; the venue rejects one that would cross; an unknown fee refuses', (t) => {
  const ws = setup(t);
  const r = PT.submitIntent(ws, intent('A', { order_type: 'POST_ONLY', entry_price: '99.5', stop_loss_price: '94.5' }), ctx());
  assert.equal(r.state, 'ACKED');
  const fill = hour(ws, 15, { low: '99.4' }).events.find((x) => x.type === 'fill');
  assert.equal(fill.price, '99.5');
  const q = D(fill.quantity);
  assert.equal(res(ws, T0 + 16 * H + M).fees_usd, String(Math.round(q * 99.5 * 0.001 * 1e10) / 1e10), 'the maker fee, 0.1%');
  const ws2 = setup(t);
  const rej = PT.submitIntent(ws2, intent('B', { order_type: 'POST_ONLY', entry_price: '100', stop_loss_price: '95' }), ctx());
  assert.equal(rej.state, 'REJECTED');
  assert.match(rej.words, /would take liquidity/);
  assert.equal(PT.book(ws2, 'FICT/USDC', ctx()).available_cash_usd, '10000', 'a rejected order commits no cash');
  const noFee = PT.submitIntent(ws2, intent('C'), ctx(NOW, { venue: { ...VENUE, taker_rate: undefined } }));
  assert.equal(noFee.status, 'refused');
  assert.deepEqual(noFee.refusals.map((x) => [x.field, x.rule]), [['book.fees', 'unknown']]);
});

test('a stop exits STOP_SLIPPAGE_BPS below the stop, or at the open when the hour opened through it, with the taker fee', (t) => {
  const ws = setup(t);
  PT.submitIntent(ws, intent('A'), ctx());
  hour(ws, 15, { low: '99' });
  const e = hour(ws, 16, { open: '99', low: '94', close: '94.5', high: '99.2' }).events.find((x) => x.type === 'exit');
  assert.deepEqual([e.reason, e.price, e.quantity], ['stop', '94.7625', '17.771']);
  const r = res(ws, T0 + 17 * H + M);
  // The loss at the stop, every cost in, is within the risk ceiling and is the planned loss.
  assert.equal(r.closed_positions[0].realized_pnl_usd, '-99.997861275');
  assert.equal(r.realized_pnl_usd, '-99.997861275');
  assert.equal(r.nav_usd, r.cash_usd);
  // A gap through the stop fills at the open.
  const ws2 = setup(t);
  PT.submitIntent(ws2, intent('A'), ctx());
  hour(ws2, 15, { low: '99' });
  const g = hour(ws2, 16, { open: '90', high: '91', low: '89', close: '90' }).events.find((x) => x.type === 'exit');
  assert.deepEqual([g.reason, g.price], ['stop_gap', '90']);
  assert.ok(D(res(ws2, T0 + 17 * H + M).realized_pnl_usd) < -100, 'a gap can lose more than the ceiling; it is recorded, never hidden');
  // An open a hair under the stop is never better than the slipped stop.
  const ws3 = setup(t);
  PT.submitIntent(ws3, intent('A'), ctx());
  hour(ws3, 15, { low: '99' });
  assert.equal(hour(ws3, 16, { open: '94.99', high: '95', low: '94.9', close: '95' }).events.find((x) => x.type === 'exit').price, '94.7625');
});

test('one hour reaching both the stop and the target takes the stop; a target is taken only through it', (t) => {
  const ws = setup(t);
  PT.submitIntent(ws, intent('A'), ctx());
  hour(ws, 15, { low: '99' });
  assert.equal(hour(ws, 16, { open: '100', high: '116', low: '94', close: '100' }).events.find((x) => x.type === 'exit').reason, 'stop');
  const ws2 = setup(t);
  PT.submitIntent(ws2, intent('A'), ctx());
  hour(ws2, 15, { low: '99' });
  assert.deepEqual(hour(ws2, 16, { high: '115', close: '114' }).events.map((x) => x.type), ['bar'], 'a touch of the target is not a fill');
  const tp = hour(ws2, 17, { high: '115.5', close: '115' }).events.find((x) => x.type === 'exit');
  assert.deepEqual([tp.reason, tp.price], ['take_profit', '115']);
  assert.ok(D(res(ws2, T0 + 18 * H + M).realized_pnl_usd) > 0);
});

test('the hour that fills a buy checks its stop, never its target', (t) => {
  const ws = setup(t);
  PT.submitIntent(ws, intent('A'), ctx());
  const types = hour(ws, 15, { open: '100', high: '120', low: '94', close: '96' }).events.map((x) => [x.type, x.reason]);
  assert.deepEqual(types, [['bar', undefined], ['fill', undefined], ['exit', 'stop']]);
  const ws2 = setup(t);
  PT.submitIntent(ws2, intent('A'), ctx());
  assert.deepEqual(hour(ws2, 15, { high: '120', low: '99', close: '110' }).events.map((x) => x.type), ['bar', 'fill']);
});

test('NAV is unknown without a fresh price, never 0 or the entry; an intent is then refused', (t) => {
  const ws = setup(t);
  PT.submitIntent(ws, intent('A'), ctx());
  hour(ws, 15, { low: '99' });
  const late = T0 + 16 * H + 121 * M;
  const r = res(ws, late);
  assert.equal(r.nav_usd, null);
  assert.equal(r.unrealized_pnl_usd, null);
  assert.equal(r.open_positions[0].value_usd, null);
  assert.match(r.unknown.join(' '), /no hourly price within 120 minutes/);
  const b = PT.book(ws, 'FICT/USDC', ctx(late));
  assert.equal(b.nav_usd, null);
  assert.match(b.unknown.join(' '), /NAV is unknown/);
  const refused = PT.submitIntent(ws, intent('B', {}, late), ctx(late));
  assert.equal(refused.status, 'refused');
  assert.ok(refused.refusals.some((x) => x.field === 'book.nav_usd' && x.rule === 'unknown'));
  // Unfunded, nothing is valued and every intent is refused.
  const tw = tempWorkspace('ptrader-unfunded');
  t.after(tw.cleanup);
  for (let i = 0; i < 15; i++) hour(tw.ws, i);
  const u = PT.submitIntent(tw.ws, intent('C'), ctx());
  assert.ok(u.refusals.some((x) => x.field === 'book.nav_usd'));
  assert.match(PT.book(tw.ws, 'FICT/USDC', ctx()).unknown.join(' '), /not funded/);
});

test('cash never goes negative: orders commit their cash and fee, and one that does not fit is refused', (t) => {
  // Five orders of 50 at a 2% stop under a 400 grant: 250 open at the stops,
  // inside the grant and the 24-hour ceiling, so cash is what refuses the sixth.
  // (Before red team P0-1 this test placed five orders of 100 under the 250
  // grant, 500 at the stops: the defect P0-1 fixes.)
  const ws = setup(t, { grant: 400 });
  const states = ['A', 'B', 'C', 'D', 'E', 'F'].map((c) => PT.submitIntent(ws, intent(c, { stop_loss_price: '98', risk_ceiling_usd: '50' }), ctx()));
  assert.deepEqual(states.map((s) => s.state || s.status), ['ACKED', 'ACKED', 'ACKED', 'ACKED', 'ACKED', 'refused']);
  assert.deepEqual(states[5].refusals.map((x) => [x.field, x.rule]), [['book.cash_usd', 'cash']]);
  assert.equal(PT.book(ws, 'FICT/USDC', ctx()).available_cash_usd, '513.565');
  hour(ws, 15, { low: '99' });
  const r = res(ws, T0 + 16 * H + M);
  assert.equal(r.cash_usd, '513.565');
  assert.ok(D(r.cash_usd) >= 0);
  assert.equal(r.open_positions.length, 5);
});

test('the same intent twice is unchanged; a different body under its ID is refused; the venue sees one order', (t) => {
  const ws = setup(t);
  const first = PT.submitIntent(ws, intent('A'), ctx());
  // The same intent with its keys in another order is the same intent.
  const shuffled = Object.fromEntries(Object.entries(intent('A')).reverse());
  const again = PT.submitIntent(ws, shuffled, ctx(NOW + M));
  assert.equal(again.status, 'unchanged');
  assert.equal(again.client_order_id, first.client_order_id);
  assert.equal(venueLines(ws), 1);
  const before = fs.readFileSync(ws.abs(PT.JOURNAL), 'utf8');
  assert.throws(() => PT.submitIntent(ws, intent('A', { risk_ceiling_usd: '99' }), ctx(NOW + M)), (e) => e.code === 'CONFLICT');
  assert.equal(fs.readFileSync(ws.abs(PT.JOURNAL), 'utf8'), before);
  // A refused intent is on record too: the same ID again is unchanged, still refused.
  const refused = PT.submitIntent(ws, intent('B', { pair: 'OTHER/USDC' }), ctx(NOW + M));
  assert.equal(refused.status, 'refused');
  const refusedAgain = PT.submitIntent(ws, intent('B', { pair: 'OTHER/USDC' }), ctx(NOW + 2 * M));
  assert.deepEqual([refusedAgain.status, refusedAgain.state], ['unchanged', 'REFUSED']);
  // The venue refuses a second send of the same client order ID.
  const dup = PT.venueSend(ws, first.client_order_id, { now: at(NOW + 2 * M) });
  assert.deepEqual([dup.answer, dup.duplicate], ['accepted', true]);
  assert.equal(venueLines(ws), 1);
});

// Red team P1-3 changed the first half of this test. It used to assert that
// recover() cancels a RESERVED order ("not sent late") without asking the
// venue; a second process may have sent it in the meantime (the race in the
// P1-3 test below), so a reservation with no outcome is now UNKNOWN and
// reconciled like a send with no answer, never cancelled blind.
test('crash and restart: reserved or sent with no outcome is UNKNOWN, halts every intent and is reconciled, never cancelled blind or sent late', (t) => {
  const ws = setup(t);
  const a = PT.reserveIntent(ws, intent('A'), ctx());
  assert.equal(a.status, 'reserved');
  // While it is RESERVED, a new intent is refused.
  assert.deepEqual(PT.submitIntent(ws, intent('B'), ctx()).refusals.map((x) => x.rule), ['halt_unresolved']);
  let rec = PT.recover(ws, { now: at(NOW + M) });
  assert.deepEqual(rec.orders.map((o) => o.state), ['UNKNOWN']);
  assert.equal(venueLines(ws), 0);
  // Its cash stays committed while the venue's answer is unknown.
  assert.equal(PT.book(ws, 'FICT/USDC', ctx(NOW + M)).available_cash_usd, '8219.3458');
  assert.deepEqual(PT.submitIntent(ws, intent('G', {}, NOW + 2 * M), ctx(NOW + 2 * M)).refusals.map((x) => x.rule), ['halt_unresolved']);
  // The venue never got it; after its duplicate window, NOT_FOUND.
  assert.equal(PT.reconcile(ws, a.client_order_id, { now: at(NOW + 60 * M) }).state, 'NOT_FOUND');
  assert.equal(PT.submitIntent(ws, intent('A'), ctx(NOW + 60 * M)).state, 'NOT_FOUND', 'the same intent is never sent again');
  assert.equal(venueLines(ws), 0);
  assert.equal(PT.book(ws, 'FICT/USDC', ctx(NOW + 60 * M)).available_cash_usd, '10000');

  hour(ws, 15);
  const t1 = T0 + 16 * H;
  const c = PT.reserveIntent(ws, intent('C', {}, t1 + M), ctx(t1 + M));
  PT.markSent(ws, c.client_order_id, { now: at(t1 + M) });
  rec = PT.recover(ws, { now: at(t1 + 2 * M) });
  assert.deepEqual(rec.orders.map((o) => o.state), ['UNKNOWN']);
  assert.equal(PT.recover(ws, { now: at(t1 + 2 * M) }).status, 'unchanged');
  const blocked = PT.submitIntent(ws, intent('D', {}, t1 + 3 * M), ctx(t1 + 3 * M));
  assert.deepEqual(blocked.refusals.map((x) => [x.field, x.rule]), [['book.orders', 'halt_unresolved']]);
  // UNKNOWN never times out: hours pass, it does not fill, expire or turn into NOT_FOUND on the clock.
  for (let i = 16; i < 25; i++) hour(ws, i, { low: '98' });
  assert.equal(res(ws, T0 + 25 * H + M).orders.find((o) => o.client_order_id === c.client_order_id).state, 'UNKNOWN');
  // The venue never got it (the crash came before the send); after its duplicate window, NOT_FOUND.
  const nf = PT.reconcile(ws, c.client_order_id, { now: at(T0 + 25 * H + 2 * M) });
  assert.equal(nf.state, 'NOT_FOUND');
  assert.match(nf.words, /duplicate-order window closed/);
  assert.equal(PT.submitIntent(ws, intent('E', {}, T0 + 25 * H + 3 * M), ctx(T0 + 25 * H + 3 * M)).state, 'ACKED');
});

test('reconcile: NOT_FOUND only after the venue\'s duplicate window; an order the venue has is acknowledged at once', (t) => {
  const ws = setup(t);
  const a = PT.reserveIntent(ws, intent('A'), ctx());
  PT.markSent(ws, a.client_order_id, { now: at(NOW) });
  PT.recover(ws, { now: at(NOW + M) });
  const early = PT.reconcile(ws, a.client_order_id, { now: at(NOW + 59 * M) });
  assert.deepEqual([early.status, early.state], ['unchanged', 'UNKNOWN']);
  assert.match(early.words, /window is open until/);
  assert.equal(PT.reconcile(ws, a.client_order_id, { now: at(NOW + 60 * M) }).state, 'NOT_FOUND');

  // Sent and accepted by the venue, then a crash before the answer was recorded.
  const ws2 = setup(t);
  const b = PT.reserveIntent(ws2, intent('B'), ctx());
  PT.markSent(ws2, b.client_order_id, { now: at(NOW) });
  assert.equal(PT.venueSend(ws2, b.client_order_id, { now: at(NOW) }).answer, 'accepted');
  PT.recover(ws2, { now: at(NOW + M) });
  const found = PT.reconcile(ws2, b.client_order_id, { now: at(NOW + 2 * M) });
  assert.equal(found.state, 'ACKED');
  assert.equal(venueLines(ws2), 1);
  // An answer that does not read leaves the order UNKNOWN.
  const ws3 = setup(t);
  const c = PT.reserveIntent(ws3, intent('C'), ctx());
  PT.markSent(ws3, c.client_order_id, { now: at(NOW) });
  assert.equal(PT.recordAnswer(ws3, c.client_order_id, { answer: 'ok?' }, { now: at(NOW) }).state, 'UNKNOWN');
  assert.throws(() => PT.cancelOrder(ws3, c.client_order_id, { now: at(NOW) }), (e) => e.code === 'STATE' && /reconciled first/.test(e.message));
});

test('an order past its life expires at the next hour and releases its cash; cancel releases what is left', (t) => {
  const ws = setup(t);
  const a = PT.submitIntent(ws, intent('A'), ctx());
  hour(ws, 15, { low: '99', volume: '50' });
  hour(ws, 16, { low: '100' });
  const e = hour(ws, 17, { low: '99' }).events;
  assert.deepEqual(e.map((x) => x.type), ['bar', 'expired'], 'valid_until fell inside hour 17');
  assert.deepEqual(res(ws, T0 + 18 * H + M).orders.map((o) => [o.state, o.filled]), [['EXPIRED', '5']]);
  assert.equal(PT.book(ws, 'FICT/USDC', ctx(T0 + 18 * H + M)).available_cash_usd, res(ws, T0 + 18 * H + M).cash_usd);
  const ws2 = setup(t);
  const b = PT.submitIntent(ws2, intent('B'), ctx());
  assert.equal(PT.cancelOrder(ws2, b.client_order_id, { now: at(NOW + M) }).state, 'CANCELLED');
  assert.equal(PT.cancelOrder(ws2, b.client_order_id, { now: at(NOW + M) }).status, 'unchanged');
  assert.equal(PT.book(ws2, 'FICT/USDC', ctx(NOW + M)).available_cash_usd, '10000');
  assert.equal(a.state, 'ACKED');
});

test('a CLOSE_LONG closes the whole position at its limit when the high trades above it', (t) => {
  const ws = setup(t);
  PT.submitIntent(ws, intent('A'), ctx());
  hour(ws, 15, { low: '99' });
  const now = T0 + 16 * H + M;
  const close = intent('B', { side: 'CLOSE_LONG', position_id: `pos-${ID('A')}`, entry_price: '100.5', reference_price: '100' }, now);
  const r = PT.submitIntent(ws, close, ctx(now));
  assert.equal(r.state, 'ACKED');
  assert.deepEqual(r.sizing, { quantity: '17.771' });
  assert.deepEqual(hour(ws, 16, { high: '100.5', close: '100.4' }).events.map((x) => x.type), ['bar']);
  const ex = hour(ws, 17, { high: '100.6' }).events.find((x) => x.type === 'exit');
  assert.deepEqual([ex.reason, ex.price, ex.quantity], ['close', '100.5', '17.771']);
  const out = res(ws, T0 + 18 * H + M);
  assert.equal(out.open_positions.length, 0);
  assert.deepEqual(out.orders.map((o) => o.state), ['FILLED', 'FILLED']);
  // Proceeds 1785.9855 less its 0.2% fee 3.571971, less the cost 1780.6542.
  assert.equal(out.realized_pnl_usd, '1.759329');
  // A second close of a position already closing is refused.
  const ws2 = setup(t);
  PT.submitIntent(ws2, intent('A'), ctx());
  hour(ws2, 15, { low: '99' });
  PT.submitIntent(ws2, close, ctx(now));
  const second = PT.submitIntent(ws2, intent('C', { side: 'CLOSE_LONG', position_id: `pos-${ID('A')}`, entry_price: '101', reference_price: '100' }, now), ctx(now));
  assert.deepEqual(second.refusals.map((x) => [x.field, x.rule]), [['position_id', 'position']]);
});

test('adverse outcomes: a stop within its ceiling, then a gap past it; the 24-hour drawdown then refuses new risk', (t) => {
  const rules = { ...RULES, notional_max_pct: '0.5' };
  // At the stop, the whole planned risk is lost and no more; the drawdown is
  // that loss, and 2% more still fits under 4% of NAV.
  const ws = setup(t);
  assert.equal(PT.submitIntent(ws, intent('A', { risk_ceiling_usd: '196' }), ctx(NOW, { rules })).state, 'ACKED');
  hour(ws, 15, { low: '99' });
  hour(ws, 16, { open: '96', low: '94', close: '94.5', high: '96' });
  let now = T0 + 17 * H + M;
  const after = res(ws, now);
  assert.ok(D(after.realized_pnl_usd) >= -196 && D(after.realized_pnl_usd) < -195.9, after.realized_pnl_usd);
  assert.equal(PT.book(ws, 'FICT/USDC', ctx(now)).drawdown_24h_usd, String(-D(after.realized_pnl_usd)));
  // A gap through the stop loses more than the ceiling: recorded as it is.
  const ws2 = setup(t);
  PT.submitIntent(ws2, intent('A', { risk_ceiling_usd: '196' }), ctx(NOW, { rules }));
  hour(ws2, 15, { low: '99' });
  hour(ws2, 16, { open: '90', low: '89', close: '90', high: '91' });
  now = T0 + 17 * H + M;
  const gap = res(ws2, now);
  assert.ok(D(gap.realized_pnl_usd) < -350, gap.realized_pnl_usd);
  const b = PT.book(ws2, 'FICT/USDC', ctx(now));
  assert.equal(b.drawdown_24h_usd, String(-D(gap.realized_pnl_usd)));
  assert.equal(gap.max_drawdown_usd, b.drawdown_24h_usd);
  assert.equal(gap.nav_usd, gap.cash_usd);
  const next = PT.submitIntent(ws2, intent('B', { reference_price: '90', entry_price: '90', stop_loss_price: '85', take_profit_price: '100', risk_ceiling_usd: '100' }, now), ctx(now, { rules }));
  assert.equal(next.status, 'refused');
  assert.deepEqual(next.refusals.map((x) => [x.field, x.rule]), [['risk_ceiling_usd', 'drawdown']]);
});

test('a stale reference price or a future stamp is refused; results set the book against BTC only with BTC\'s prices', (t) => {
  const ws = setup(t);
  assert.ok(PT.submitIntent(ws, intent('A', { reference_at: at(NOW - 16 * M) }), ctx()).refusals.some((x) => x.rule === 'stale_price'));
  assert.ok(PT.submitIntent(ws, intent('B', { created_at: at(NOW + M) }), ctx()).refusals.some((x) => x.rule === 'future_time'));
  const r = res(ws, NOW);
  assert.equal(r.vs_btc, null);
  assert.match(r.unknown.join(' '), /not set against BTC/);
  const vs = PT.results(ws, { now: at(NOW), btc: { start_price: '50000', end_price: '55000' } }).vs_btc;
  // (1 + 0) / (1 + 0.1) - 1, floored at 18 places.
  assert.deepEqual(vs, { book_return: '0', btc_return: '0.1', relative: '-0.09090909090909091' });
});

test('hours: the same hour again is unchanged; other prices for it, an earlier hour or one not yet closed are refused', (t) => {
  const ws = setup(t);
  assert.equal(hour(ws, 14, {}, T0 + 15 * H + M).status, 'unchanged');
  assert.throws(() => hour(ws, 14, { close: '100.01' }, T0 + 15 * H + M), (e) => e.code === 'CONFLICT');
  assert.throws(() => hour(ws, 13, { close: '100.01' }, T0 + 15 * H + M), (e) => e.code === 'CONFLICT');
  assert.throws(() => PT.applyBar(ws, bar(15), { now: at(T0 + 15 * H + 59 * M) }), (e) => e.code === 'INVALID');
  PT.applyBar(ws, bar(16), { now: at(T0 + 17 * H) });
  assert.throws(() => PT.applyBar(ws, bar(15), { now: at(T0 + 17 * H) }), (e) => e.code === 'ORDER');
  assert.throws(() => PT.applyBar(ws, bar(18, { close: 101 }), { now: at(T0 + 19 * H) }), (e) => e.code === 'INVALID' && /plain decimal string/.test(e.message));
  assert.throws(() => PT.applyBar(ws, bar(18, { low: '102' }), { now: at(T0 + 19 * H) }), (e) => e.code === 'INVALID');
});

test('the journal is a hash chain: an edited line refuses every read and write; the book never goes back in time', (t) => {
  const ws = setup(t);
  PT.submitIntent(ws, intent('A'), ctx());
  assert.throws(() => PT.applyBar(ws, bar(15), { now: at(NOW - M) }), (e) => e.code === 'TIME');
  const text = fs.readFileSync(ws.abs(PT.JOURNAL), 'utf8');
  fs.writeFileSync(ws.abs(PT.JOURNAL), text.replace('"cash_usd":"10000"', '"cash_usd":"20000"'));
  assert.throws(() => PT.results(ws, { now: at(NOW) }), (e) => e.code === 'INTEGRITY');
  assert.throws(() => PT.applyBar(ws, bar(15), { now: at(T0 + 16 * H) }), (e) => e.code === 'INTEGRITY');
  assert.throws(() => PT.book(ws, 'FICT/USDC', ctx()), (e) => e.code === 'INTEGRITY');
});

test('cr-paper@1 reads the same before and after; nothing enters paper/positions.jsonl', (t) => {
  const ws = setup(t);
  const now = Date.parse('2026-10-28T00:00:00Z');
  const before = JSON.stringify(paper.book(ws, { now }));
  PT.submitIntent(ws, intent('A'), ctx());
  hour(ws, 15, { low: '99' });
  hour(ws, 16, { open: '99', low: '94', close: '95', high: '99' });
  assert.equal(JSON.stringify(paper.book(ws, { now })), before);
  assert.equal(fs.existsSync(ws.abs(paper.REL)), false);
  assert.ok(fs.existsSync(ws.abs(PT.JOURNAL)));
});

// --- Red team, 2026-10-27 (trader audit): each test failed on 6b1e876.

const events = (ws) => fs.readFileSync(ws.abs(PT.JOURNAL), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('red team P0-1: open risk is summed; a thesis never holds more than its grant, nor the book more than the 24-hour ceiling at its stops', (t) => {
  // The grant is 250: two orders of 100 hold 199.99572255 at their stops; a third would pass it.
  const ws = setup(t);
  const s = ['A', 'B', 'C'].map((c) => PT.submitIntent(ws, intent(c), ctx()));
  assert.deepEqual(s.map((x) => x.state || x.status), ['ACKED', 'ACKED', 'refused']);
  assert.deepEqual(s[2].refusals.map((x) => [x.field, x.rule]), [['risk_ceiling_usd', 'gate_cap'], ['risk_ceiling_usd', 'pm_cap']]);
  const b = PT.book(ws, 'FICT/USDC', ctx());
  assert.deepEqual([b.open_risk_usd, b.thesis_risk_usd], ['199.99572255', '199.99572255']);
  // A grant of 1000: four orders hold 399.9914451 at their stops; a fifth would pass 4% of NAV (400).
  const ws2 = setup(t, { grant: 1000 });
  const r = ['A', 'B', 'C', 'D', 'E'].map((c) => PT.submitIntent(ws2, intent(c), ctx()));
  assert.deepEqual(r.map((x) => x.state || x.status), ['ACKED', 'ACKED', 'ACKED', 'ACKED', 'refused']);
  assert.deepEqual(r[4].refusals.map((x) => [x.field, x.rule]), [['risk_ceiling_usd', 'drawdown']]);
  // One ordinary hour (no gap) stops all four: the 24-hour drawdown stays within the ceiling.
  hour(ws2, 15, { low: '99' });
  hour(ws2, 16, { open: '96', high: '96', low: '94.9', close: '95' });
  const after = PT.book(ws2, 'FICT/USDC', ctx(T0 + 17 * H + M));
  assert.equal(after.drawdown_24h_usd, '399.9914451');
  assert.equal(after.open_risk_usd, '0');
});

test('red team P0-2: fills and exits stay inside the hour; a limit through the market is refused', (t) => {
  // A buy fills at the open when the hour opens below its limit.
  const ws = setup(t);
  PT.submitIntent(ws, intent('A'), ctx());
  const f = hour(ws, 15, { open: '99.8', high: '100.1', low: '99.6', close: '99.9' }).events.find((x) => x.type === 'fill');
  assert.deepEqual([f.price, f.quantity], ['99.8', '17.771']);
  assert.equal(res(ws, T0 + 16 * H + M).open_positions[0].notional_usd, '1773.5458');
  // A close (sent at 16:01, so it first fills from hour 17) fills at the open when the hour opens above its limit.
  const now = T0 + 16 * H + M;
  const c = PT.submitIntent(ws, intent('B', { side: 'CLOSE_LONG', position_id: `pos-${ID('A')}`, entry_price: '100', reference_price: '99.9' }, now), ctx(now));
  assert.equal(c.state, 'ACKED');
  hour(ws, 16, { open: '99.9', high: '99.95', low: '99.5', close: '99.9' });
  const ex = hour(ws, 17, { open: '101', high: '101.5', low: '100.8', close: '101.2' }).events.find((x) => x.type === 'exit');
  assert.deepEqual([ex.reason, ex.price, ex.quantity], ['close', '101', '17.771']);
  // A target the hour opened above is taken at the open, never below the hour's low.
  const ws3 = setup(t);
  PT.submitIntent(ws3, intent('A'), ctx());
  hour(ws3, 15, { low: '99' });
  const tp = hour(ws3, 16, { open: '116', high: '117', low: '115.5', close: '116' }).events.find((x) => x.type === 'exit');
  assert.deepEqual([tp.reason, tp.price], ['take_profit', '116']);
  // A sell limit of 1 or a buy limit of 1000 against a market at 100 is refused.
  const ws2 = setup(t);
  PT.submitIntent(ws2, intent('A'), ctx());
  hour(ws2, 15, { low: '99' });
  const dump = PT.submitIntent(ws2, intent('B', { side: 'CLOSE_LONG', position_id: `pos-${ID('A')}`, entry_price: '1', stop_loss_price: '0.5', take_profit_price: '2' }, now), ctx(now));
  assert.deepEqual(dump.refusals && dump.refusals.map((x) => [x.field, x.rule]), [['entry_price', 'through_market']]);
  const chase = PT.submitIntent(ws2, intent('C', { entry_price: '1000', stop_loss_price: '950', take_profit_price: '1100' }, now), ctx(now));
  assert.ok(chase.refusals && chase.refusals.some((x) => x.rule === 'through_market'));
});

test('red team P1-3: an order goes to the venue only from SENT; a recover() racing a submit leaves it UNKNOWN, never live and untracked', (t) => {
  const ws = setup(t);
  const a = PT.reserveIntent(ws, intent('A'), ctx());
  assert.throws(() => PT.venueSend(ws, a.client_order_id, { now: at(NOW) }), (e) => e.code === 'STATE');
  assert.equal(venueLines(ws), 0);
  // The race, made deterministic: a second process's recover() lands between
  // the reservation and markSent (ops.runOp is wrapped before a fresh copy of
  // the Paper Book module loads it).
  const ops = require('../core/ops');
  const real = ops.runOp;
  const key = require.resolve('../core/paper-trader');
  let armed = true;
  let PT2 = null;
  ops.runOp = function wrapped(w, meta) {
    if (armed && / sent$/.test(meta.summary)) { armed = false; PT2.recover(w, { now: at(NOW) }); }
    return real.apply(this, arguments);
  };
  delete require.cache[key];
  try {
    PT2 = require('../core/paper-trader');
    const ws2 = setup(t);
    const r = PT2.submitIntent(ws2, intent('B'), ctx());
    assert.equal(armed, false, 'the second process ran');
    assert.equal(r.state, 'UNKNOWN');
    assert.equal(venueLines(ws2), 0, 'nothing reached the venue');
    assert.deepEqual(PT2.submitIntent(ws2, intent('C'), ctx()).refusals.map((x) => x.rule), ['halt_unresolved']);
  } finally {
    ops.runOp = real;
    delete require.cache[key];
  }
});

test('red team P1-4: a venue answer that does not read is an INTEGRITY error; the order stays UNKNOWN, never NOT_FOUND', (t) => {
  const spoilers = [(p) => fs.writeFileSync(p, fs.readFileSync(p, 'utf8').slice(0, 40)), (p) => fs.rmSync(p)];
  for (const spoil of spoilers) {
    const ws = setup(t);
    const a = PT.reserveIntent(ws, intent('A'), ctx());
    PT.markSent(ws, a.client_order_id, { now: at(NOW) });
    assert.equal(PT.venueSend(ws, a.client_order_id, { now: at(NOW) }).answer, 'accepted');
    spoil(ws.abs(PT.VENUE));
    PT.recover(ws, { now: at(NOW + M) });
    assert.throws(() => PT.reconcile(ws, a.client_order_id, { now: at(NOW + 61 * M) }), (e) => e.code === 'INTEGRITY');
    assert.equal(res(ws, NOW + 61 * M).orders[0].state, 'UNKNOWN');
    assert.ok(PT.submitIntent(ws, intent('B', {}, NOW + 62 * M), ctx(NOW + 62 * M)).refusals.some((x) => x.rule === 'halt_unresolved'));
  }
});

// Rewrites the journal and its head consistently, as a hand edit of both would.
function writeChain(ws, ls) {
  let head = null;
  const out = ls.map((l) => {
    const line = JSON.stringify({ ...JSON.parse(l), prev_sha256: head });
    head = sha256(line);
    return line;
  });
  fs.writeFileSync(ws.abs(PT.JOURNAL), `${out.join('\n')}\n`);
  fs.writeFileSync(ws.abs(PT.HEAD), `${JSON.stringify({ seq: out.length, head_sha256: head, at: at(NOW) })}\n`);
}

test('red team P1-5: a rolled-back journal is refused by its head and by the venue\'s record; rewritten under another body, the venue refuses the ID and the order stays UNKNOWN', (t) => {
  const ws = setup(t);
  const a = PT.reserveIntent(ws, intent('A'), ctx());
  PT.markSent(ws, a.client_order_id, { now: at(NOW) });
  PT.venueSend(ws, a.client_order_id, { now: at(NOW) });
  const full = fs.readFileSync(ws.abs(PT.JOURNAL), 'utf8').trim().split('\n');
  // The journal loses its last two lines (a rollback): its head refuses it.
  fs.writeFileSync(ws.abs(PT.JOURNAL), `${full.slice(0, -2).join('\n')}\n`);
  assert.throws(() => PT.submitIntent(ws, intent('A', { risk_ceiling_usd: '50' }), ctx(NOW + M)), (e) => e.code === 'INTEGRITY');
  // Its head rolled back with it: the venue holds an order the journal never reserved.
  writeChain(ws, full.slice(0, -2));
  assert.throws(() => PT.submitIntent(ws, intent('A', { risk_ceiling_usd: '50' }), ctx(NOW + M)), (e) => e.code === 'INTEGRITY' && /never reserved/.test(e.message));
  assert.equal(venueLines(ws), 1);
  // Both rewritten consistently with intent A's order at another quantity:
  // the venue holds its ID as a different order.
  writeChain(ws, full.map((l) => { const e = JSON.parse(l); return e.type === 'reserved' ? JSON.stringify({ ...e, quantity: '8.885' }) : l; }));
  assert.throws(() => PT.venueSend(ws, a.client_order_id, { now: at(NOW + 2 * M) }), (e) => e.code === 'CONFLICT');
  PT.recover(ws, { now: at(NOW + 2 * M) });
  assert.throws(() => PT.reconcile(ws, a.client_order_id, { now: at(NOW + 62 * M) }), (e) => e.code === 'INTEGRITY');
  assert.equal(res(ws, NOW + 62 * M).orders[0].state, 'UNKNOWN');
  assert.equal(venueLines(ws), 1);
});

// --- The journal's head (D7, Eric 2026-10-28).

test('D7: a journal that lost its last lines is refused by its head; nothing is read or written', (t) => {
  const ws = setup(t);
  const a = PT.reserveIntent(ws, intent('A'), ctx());
  PT.markSent(ws, a.client_order_id, { now: at(NOW) });
  const p = ws.abs(PT.JOURNAL);
  const kept = fs.readFileSync(p, 'utf8').trim().split('\n').slice(0, -2);
  fs.writeFileSync(p, `${kept.join('\n')}\n`);
  const files = () => [fs.readFileSync(p, 'utf8'), fs.readFileSync(ws.abs(PT.HEAD), 'utf8')];
  const before = files();
  assert.throws(() => PT.results(ws, { now: at(NOW + M) }), (e) => e.code === 'INTEGRITY' && /lines were lost from its end/.test(e.message));
  assert.throws(() => PT.book(ws, 'FICT/USDC', ctx(NOW + M)), (e) => e.code === 'INTEGRITY');
  assert.throws(() => PT.submitIntent(ws, intent('B', {}, NOW + M), ctx(NOW + M)), (e) => e.code === 'INTEGRITY');
  assert.throws(() => hour(ws, 15), (e) => e.code === 'INTEGRITY');
  assert.throws(() => PT.recover(ws, { now: at(NOW + M) }), (e) => e.code === 'INTEGRITY');
  assert.deepEqual(files(), before);
});

test('D7: a deleted or unreadable journal, or a missing head, is never a fresh book', (t) => {
  // The journal deleted while its head is there: not even a new funding.
  let ws = setup(t);
  fs.rmSync(ws.abs(PT.JOURNAL));
  assert.throws(() => PT.results(ws, { now: at(NOW) }), (e) => e.code === 'INTEGRITY' && /ends at line 0/.test(e.message));
  assert.throws(() => PT.fund(ws, { cash_usd: '10000', now: at(NOW) }), (e) => e.code === 'INTEGRITY');
  assert.equal(fs.existsSync(ws.abs(PT.JOURNAL)), false);
  // A journal that does not read as a file.
  ws = setup(t);
  fs.rmSync(ws.abs(PT.JOURNAL));
  fs.mkdirSync(ws.abs(PT.JOURNAL));
  assert.throws(() => PT.results(ws, { now: at(NOW) }), (e) => e.code === 'INTEGRITY' && /could not be read/.test(e.message));
  // Its head deleted.
  ws = setup(t);
  fs.rmSync(ws.abs(PT.HEAD));
  assert.throws(() => PT.book(ws, 'FICT/USDC', ctx()), (e) => e.code === 'INTEGRITY' && /head record \(paper\/trader\/journal\.head\.json\) is missing/.test(e.message));
});

test('D7: a venue order the journal does not know is refused', (t) => {
  const ws = setup(t);
  assert.equal(PT.submitIntent(ws, intent('A'), ctx()).state, 'ACKED');
  fs.appendFileSync(ws.abs(PT.VENUE), `${JSON.stringify({ client_order_id: `cr2-${ID('B')}`, pair: 'FICT/USDC', side: 'OPEN_LONG', order_type: 'LIMIT', limit: '100', quantity: '1', answer: 'accepted', words: null, at: at(NOW) })}\n`);
  assert.throws(() => PT.results(ws, { now: at(NOW) }), (e) => e.code === 'INTEGRITY' && /never reserved: the journal has lost lines/.test(e.message));
  assert.throws(() => hour(ws, 15, { low: '99' }), (e) => e.code === 'INTEGRITY');
});

test('D7: a hand edit of the last line, the chain still valid, is refused by the head\'s hash', (t) => {
  const ws = setup(t);
  PT.submitIntent(ws, intent('A'), ctx());
  const p = ws.abs(PT.JOURNAL);
  const ls = fs.readFileSync(p, 'utf8').trim().split('\n');
  const last = JSON.parse(ls[ls.length - 1]);
  assert.equal(last.answer, 'accepted');
  ls[ls.length - 1] = JSON.stringify({ ...last, answer: 'rejected' });
  fs.writeFileSync(p, `${ls.join('\n')}\n`);
  assert.throws(() => PT.results(ws, { now: at(NOW) }), (e) => e.code === 'INTEGRITY' && /is not the line its head record names/.test(e.message));
});

test('D7: a journal ahead of its head, the chain intact, is read; the next write moves the head forward', (t) => {
  const ws = setup(t);
  const h = ws.abs(PT.HEAD);
  const older = fs.readFileSync(h, 'utf8');
  PT.submitIntent(ws, intent('A'), ctx());
  // A crash between the two writes, or the head restored from before them.
  fs.writeFileSync(h, older);
  assert.equal(res(ws, NOW).orders[0].state, 'ACKED');
  hour(ws, 15, { low: '99' });
  const ls = fs.readFileSync(ws.abs(PT.JOURNAL), 'utf8').trim().split('\n');
  const head = JSON.parse(fs.readFileSync(h, 'utf8'));
  assert.deepEqual([head.seq, head.head_sha256], [ls.length, sha256(ls[ls.length - 1])]);
});

test('red team P1-6: inside a queued request each journal write keeps its own identity; none is collapsed into the first', (t) => {
  const ws = setup(t);
  ws._idem = { requestId: 'req_fictional_1', payloadHash: 'fictional' };
  let r;
  try {
    r = PT.submitIntent(ws, intent('A'), ctx());
    hour(ws, 15, { low: '99' });
    hour(ws, 16);
  } finally {
    ws._idem = null;
  }
  assert.equal(r.state, 'ACKED');
  assert.deepEqual(events(ws).slice(-6).map((e) => e.type), ['reserved', 'sent', 'answer', 'bar', 'fill', 'bar']);
  assert.deepEqual(res(ws, T0 + 17 * H + M).nav_by_hour.slice(-2).map((m) => m.hour_end), [at(T0 + 16 * H), at(T0 + 17 * H)]);
});

test('red team P1-7: an order fills only from hours that start at or after it was sent', (t) => {
  const ws = setup(t);
  const rules = { ...RULES, price_stale_minutes: 120 };
  const now = T0 + 16 * H + 5 * M;
  assert.equal(PT.submitIntent(ws, intent('A', {}, now), ctx(now, { rules })).state, 'ACKED');
  // Hour 15 ended before the order existed; hour 16 began before it was sent.
  assert.deepEqual(PT.applyBar(ws, bar(15, { low: '99', high: '103.5', close: '103' }), { now: at(now + M) }).events.map((e) => e.type), ['bar']);
  assert.deepEqual(hour(ws, 16, { low: '99' }).events.map((e) => e.type), ['bar']);
  assert.deepEqual(hour(ws, 17, { low: '99' }).events.map((e) => e.type), ['bar', 'fill']);
});

test('red team P2-8: for a pair with exposure, an hour that is not the next one is refused', (t) => {
  const ws = setup(t);
  PT.submitIntent(ws, intent('A'), ctx());
  hour(ws, 15, { low: '99' });
  assert.throws(() => hour(ws, 20), (e) => e.code === 'GAP');
  assert.equal(hour(ws, 16).status, 'saved');
});

test('red team P2-9: the book carries its price\'s time, and the freshness limit applies to it', (t) => {
  const ws = setup(t);
  const now = T0 + 16 * H + 59 * M;
  const b = PT.book(ws, 'FICT/USDC', ctx(now));
  assert.equal(b.price_at, at(T0 + 15 * H));
  const r = PT.submitIntent(ws, intent('A', {}, now), ctx(now));
  assert.equal(r.status, 'refused');
  assert.deepEqual(r.refusals.map((x) => [x.field, x.rule]), [['book.price_at', 'stale_price']]);
});

test('red team P2-11: an intent is validated, hashed and recorded as its own fields; inherited ones neither pass nor wedge the book', (t) => {
  const ws = setup(t);
  const own = intent('A');
  delete own.stop_loss_price;
  delete own.take_profit_price;
  const inherited = Object.assign(Object.create({ stop_loss_price: '95', take_profit_price: '115' }), own);
  const r = PT.submitIntent(ws, inherited, ctx());
  assert.equal(r.status, 'refused');
  assert.deepEqual(r.refusals.map((x) => [x.field, x.rule]), [['stop_loss_price', 'decimal'], ['take_profit_price', 'decimal']]);
  assert.equal(hour(ws, 15, { low: '99' }).status, 'saved');
  assert.equal(hour(ws, 16, { low: '90' }).status, 'saved');
});

test('red team P2-12: a close while its opener is still live is refused; a close never sells more than its order', (t) => {
  const ws = setup(t);
  const a = PT.submitIntent(ws, intent('A'), ctx());
  hour(ws, 15, { low: '99', volume: '50' }); // 5 of 17.771 filled; the opener stays live
  const now = T0 + 16 * H + M;
  const close = (c) => intent(c, { side: 'CLOSE_LONG', position_id: `pos-${ID('A')}`, entry_price: '102', reference_price: '100' }, now);
  const r = PT.submitIntent(ws, close('B'), ctx(now));
  assert.equal(r.status, 'refused');
  assert.deepEqual(r.refusals.map((x) => [x.field, x.rule]), [['position_id', 'opener_live']]);
  // Cancel what is left of the opener; the close then sells exactly the position.
  PT.cancelOrder(ws, a.client_order_id, { now: at(now) });
  const c = PT.submitIntent(ws, close('C'), ctx(now));
  assert.deepEqual([c.state, c.sizing.quantity], ['ACKED', '5']);
  hour(ws, 16, { low: '99' });
  const ex = hour(ws, 17, { high: '103', open: '100', close: '102.5' }).events.find((x) => x.type === 'exit');
  assert.deepEqual([ex.reason, ex.quantity, ex.price], ['close', '5', '102']);
});

test('red team P2-13: the Paper Book took the risk engine at load; swapping the engine\'s export changes nothing', (t) => {
  const risk = require('../core/trade-risk');
  const original = risk.validateTradeIntent;
  const swapped = Reflect.set(risk, 'validateTradeIntent', () => ({ ok: true, version: 'fake', refusals: [], sizing: { quantity: '50', notional_usd: '5000', loss_at_stop_usd: '0', per_unit_loss_usd: '0' } }));
  try {
    assert.equal(swapped, false);
    const ws = setup(t);
    const r = PT.submitIntent(ws, intent('A', { risk_ceiling_usd: '9999', pair: 'NOT-ALLOWED/USDC' }), ctx());
    assert.equal(r.status, 'refused');
  } finally {
    if (swapped) Reflect.set(risk, 'validateTradeIntent', original);
  }
});

test('red team P2-14: an order whose life ends inside an hour expires before that hour can fill it', (t) => {
  const ws = setup(t);
  assert.equal(PT.submitIntent(ws, intent('A', { valid_until: at(T0 + 16 * H + M) }), ctx()).state, 'ACKED');
  hour(ws, 15, { low: '100.2', open: '100.5', close: '100.5', high: '101' });
  assert.deepEqual(hour(ws, 16, { low: '99' }).events.map((e) => e.type), ['bar', 'expired']);
});

// --- D8 (Eric, 2026-10-28): the grant is read from Eric's stored decision.

const DID2 = 'td_fict0000000002';
const undo = (undoes, over = {}) => ({ schema_version: 'cr.ticket-decision.v1', decision_id: 'td_fict00000000u1', project_id: PID, receipt_id: RID, action: 'undo', undoes, decided_at: '2026-10-27T00:01:00.000Z', ...over });
const fieldRules = (r) => r.refusals.map((x) => [x.field, x.rule]);
const journalText = (ws) => { try { return fs.readFileSync(ws.abs(PT.JOURNAL), 'utf8'); } catch (_) { return null; } };

test('D8: a grant from the caller is refused, nothing written; the stored decision is the grant', (t) => {
  const ws = setup(t, { grant: 50 });
  const before = journalText(ws);
  const big = { thesis_id: RID, ...TICKET, suggested_risk_usd: '1000', pm_approved_risk_usd: '1000' };
  assert.throws(() => PT.submitIntent(ws, intent('A'), ctx(NOW, { grant: big })), (e) => e.code === 'INVALID' && /never taken from the caller/.test(e.message));
  assert.throws(() => PT.reserveIntent(ws, intent('A'), ctx(NOW, { grant: big })), (e) => e.code === 'INVALID');
  assert.throws(() => PT.book(ws, 'FICT/USDC', ctx(NOW, { grant: big })), (e) => e.code === 'INVALID');
  assert.equal(journalText(ws), before);
  // Eric approved 50: an intent at 100 is refused against the stored amounts.
  assert.deepEqual(PT.book(ws, 'FICT/USDC', ctx()).grant, { thesis_id: RID, ...TICKET, action: 'approve', suggested_risk_usd: '50', pm_approved_risk_usd: '50' });
  assert.deepEqual(fieldRules(PT.submitIntent(ws, intent('A'), ctx())), [['risk_ceiling_usd', 'gate_cap'], ['risk_ceiling_usd', 'pm_cap']]);
  assert.equal(PT.submitIntent(ws, intent('B', { risk_ceiling_usd: '50' }), ctx()).state, 'ACKED');
  // The reservation records the decision that granted it.
  const reserved = events(ws).find((e) => e.type === 'reserved');
  assert.deepEqual([reserved.grant.decision_id, reserved.grant.pm_approved_risk_usd], [DID, '50']);
});

test('D8: a halve grants its halved amount, and the thesis is held to it', (t) => {
  const ws = setup(t);
  writeDecisions(ws, [decision({ action: 'halve', pm_approved_risk_usd: 125, suggested_risk_usd: 250 })]);
  assert.equal(PT.submitIntent(ws, intent('A'), ctx()).state, 'ACKED');
  // What A holds at its stop and 100 more is above Eric's 125, not the gate's 250.
  assert.deepEqual(fieldRules(PT.submitIntent(ws, intent('B'), ctx())), [['risk_ceiling_usd', 'pm_cap']]);
});

test('D8: a veto, pass or watch, an undone or replaced decision, or one that does not read grants nothing', (t) => {
  const cases = [
    [[decision({ action: 'veto', pm_approved_risk_usd: 0 })], /is a veto: only an approve or a halve grants risk/],
    [[decision({ action: 'pass', pm_approved_risk_usd: 0, suggested_risk_usd: 0 })], /is a pass/],
    [[decision({ action: 'watch', pm_approved_risk_usd: 0, suggested_risk_usd: 0 })], /is a watch/],
    [[decision(), undo(DID)], /is not in force for ticket .*: it was undone/],
    [[decision(), decision({ decision_id: DID2, action: 'reopen', pm_approved_risk_usd: 0 })], /reopen td_fict0000000002 replaced it/],
    [[decision(), undo(DID), decision({ decision_id: DID2 })], /it was undone/],
    [[decision({ project_id: 'other-project' })], /is not a cr\.ticket-decision\.v1 decision on fict-project/],
    [[decision({ schema_version: 'cr.ticket-decision.v2' })], /is not a cr\.ticket-decision\.v1 decision/],
    [[decision({ decision_id: DID2 })], /is not on record for ticket/],
    [[decision({ pm_approved_risk_usd: '250' })], /does not state its approved and suggested risk as amounts/],
    [[decision({ pm_approved_risk_usd: 0 })], /approves \$0/],
    [[decision(), 'not json'], /line 2 does not read/],
  ];
  for (const [ls, words] of cases) {
    const ws = setup(t);
    writeDecisions(ws, ls);
    const r = PT.submitIntent(ws, intent('A'), ctx());
    assert.equal(r.status, 'refused', String(words));
    assert.deepEqual(fieldRules(r), [['book.grant', 'unknown'], ['decision_id', 'grant']], String(words));
    assert.match(r.refusals[1].words, words);
    const b = PT.book(ws, 'FICT/USDC', ctx());
    assert.equal(b.grant, null);
    assert.match(b.unknown.join(' '), words);
  }
  // After the undo, the new approve is the grant: an intent naming it passes.
  const ws = setup(t);
  writeDecisions(ws, [decision(), undo(DID), decision({ decision_id: DID2 })]);
  assert.equal(PT.submitIntent(ws, intent('A', { decision_id: DID2 }), ctx()).state, 'ACKED');
});

test('D8: a missing or unreadable record, a project ID that is not one, or a v2 intent is refused', (t) => {
  const ws = setup(t);
  fs.rmSync(ws.abs(DECISIONS));
  const grantWords = (r) => r.refusals.find((x) => x.rule === 'grant').words;
  assert.match(grantWords(PT.submitIntent(ws, intent('A'), ctx())), /No decision of Eric's is on record for fict-project/);
  fs.mkdirSync(ws.abs(DECISIONS));
  assert.match(grantWords(PT.submitIntent(ws, intent('B'), ctx())), /could not be read/);
  // A project ID is checked before it names a file: nothing outside projects/ is read.
  assert.match(grantWords(PT.submitIntent(setup(t), intent('C', { project_id: '../../config' }), ctx())), /names no desk project/);
  // A v2 intent names no ticket and is refused, whatever the record holds.
  const v2 = intent('D', { version: 'cr.trade-intent.v2', thesis_id: 'THESIS-FICT-001' });
  for (const f of ['project_id', 'receipt_id', 'decision_id']) delete v2[f];
  const r2 = PT.submitIntent(setup(t), v2, ctx());
  assert.equal(r2.status, 'refused');
  assert.ok(fieldRules(r2).some(([f, rule]) => f === 'version' && rule === 'shape'));
});

test('D8: a close reads no grant, so a position still closes after Eric takes the grant back', (t) => {
  const ws = setup(t);
  assert.equal(PT.submitIntent(ws, intent('A'), ctx()).state, 'ACKED');
  hour(ws, 15, { low: '99' });
  writeDecisions(ws, [decision(), undo(DID), decision({ decision_id: DID2, action: 'veto', pm_approved_risk_usd: 0 })]);
  const now = T0 + 16 * H + M;
  assert.equal(PT.submitIntent(ws, intent('B', {}, now), ctx(now)).status, 'refused');
  const close = intent('C', { side: 'CLOSE_LONG', position_id: `pos-${ID('A')}`, entry_price: '100.5', reference_price: '100' }, now);
  assert.equal(PT.submitIntent(ws, close, ctx(now)).state, 'ACKED');
});

const exitWords = (r) => r.refusals.find((x) => x.rule === 'exit').words;

test('D11: the cap is the largest fresh size whose full cost is within the receipt\'s frozen limit', (t) => {
  const ws = setup(t);
  // The audit's ladder: $100 at 1.2%, $500 at 3.8%, $2,000 at 7.5%, under a 5% limit.
  writeExits(ws, [exitRow(100, 1.2), exitRow(500, 3.8), exitRow(2000, 7.5)]);
  const sha = sha256(fs.readFileSync(ws.abs(PACKET), 'utf8'));
  const b = PT.book(ws, 'FICT/USDC', ctx());
  assert.equal(b.exit_max_usd, '500');
  assert.deepEqual(b.exit, { receipt_id: RID, packet_sha256: sha, limit_pct: '5', fresh_hours: 72, size_usd: '500', cost_pct: '3.8', as_of: at(T0) });
  assert.deepEqual(b.unknown, []);
  // $100 of risk is a notional of 1777.1, more than $500 can be sold for within 5%.
  assert.deepEqual(fieldRules(PT.submitIntent(ws, intent('A'), ctx())), [['risk_ceiling_usd', 'exit_cap']]);
  // $25 is 4.442 units, a notional of 444.2.
  const r = PT.submitIntent(ws, intent('B', { risk_ceiling_usd: '25' }), ctx());
  assert.equal(r.state, 'ACKED');
  assert.equal(r.sizing.notional_usd, '444.2');
  // The reservation records the reading that set the cap, read under its lock.
  assert.deepEqual(events(ws).find((e) => e.type === 'reserved').exit, b.exit);
  // A reading exactly 72 hours old still counts; one a millisecond older does not.
  writeExits(ws, [exitRow(500, 3.8, { as_of: at(NOW - 72 * H) })]);
  assert.equal(PT.book(ws, 'FICT/USDC', ctx()).exit_max_usd, '500');
  writeExits(ws, [exitRow(500, 3.8, { as_of: at(NOW - 72 * H - 1) })]);
  assert.equal(PT.book(ws, 'FICT/USDC', ctx()).exit_max_usd, null);
});

test('D11: an exit cap from the caller is refused, nothing written', (t) => {
  const ws = setup(t);
  const before = journalText(ws);
  for (const v of ['1000000', null, '0']) {
    assert.throws(() => PT.submitIntent(ws, intent('A'), ctx(NOW, { exit_max_usd: v })), (e) => e.code === 'INVALID' && /exit cap is never taken from the caller/.test(e.message));
    assert.throws(() => PT.reserveIntent(ws, intent('A'), ctx(NOW, { exit_max_usd: v })), (e) => e.code === 'INVALID');
    assert.throws(() => PT.book(ws, 'FICT/USDC', ctx(NOW, { exit_max_usd: v })), (e) => e.code === 'INVALID');
  }
  assert.equal(journalText(ws), before);
});

test('D11: a stale, undated, future, incomplete, over-limit or missing reading gives no cap, in words', (t) => {
  const cases = [
    [[exitRow(5000, 1.2, { as_of: at(NOW - 73 * H) })], /\$5,000 is 1\.2%, but its reading is older than 72 hours/],
    [[exitRow(5000, 1.2, { as_of: null })], /\$5,000 is 1\.2%, but its reading is undated/],
    [[exitRow(5000, 1.2, { as_of: at(NOW + H) })], /its reading is dated after now/],
    [[exitRow(5000, 1.2, { cost_complete: false, missing_costs: ['transfer_tax'] })], /\$5,000 is at least 1\.2% \(a cost not known in full\)/],
    [[exitRow(5000, 6)], /\$5,000 is 6%, over 5%/],
    [[exitRow(5000, null, { status: 'unknown' })], /\$5,000 has no reading/],
    [[], /No exit reading of ticket tr_2026-10-27T000000Z_fict2 shows a size within 5%\.$/],
  ];
  for (const [exits, words] of cases) {
    const ws = setup(t);
    writeExits(ws, exits);
    const r = PT.submitIntent(ws, intent('A'), ctx());
    assert.equal(r.status, 'refused', String(words));
    assert.deepEqual(fieldRules(r), [['book.exit_max_usd', 'unknown'], ['receipt_id', 'exit']], String(words));
    assert.match(exitWords(r), words);
    const b = PT.book(ws, 'FICT/USDC', ctx());
    assert.deepEqual([b.exit_max_usd, b.exit], [null, null]);
    assert.match(b.unknown.join(' '), words);
    assert.equal(venueLines(ws), 0);
  }
});

test('D11: an altered packet, a missing or foreign receipt, a packet outside the ticket or no limit gives no cap', (t) => {
  const cases = [
    [(ws) => fs.appendFileSync(ws.abs(PACKET), ' '), /does not match the SHA-256 its receipt froze/],
    [(ws) => fs.rmSync(ws.abs(PACKET)), /The packet of ticket .* is not on record/],
    [(ws) => writeExits(ws, EXITS, { packetText: 'not json' }), /The packet of ticket .* does not read/],
    [(ws) => fs.rmSync(ws.abs(RECEIPT)), /Ticket receipt tr_2026-10-27T000000Z_fict2 is not on record/],
    [(ws) => writeExits(ws, EXITS, { receipt: { project_id: 'other-project' } }), /is not a cr\.ticket-receipt\.v1 receipt on fict-project/],
    [(ws) => writeExits(ws, EXITS, { receipt: { schema_version: 'cr.ticket-receipt.v2' } }), /is not a cr\.ticket-receipt\.v1 receipt/],
    [(ws) => writeExits(ws, EXITS, { receipt: { packet: { path: 'config/settings.json', sha256: 'f'.repeat(64) } } }), /names no packet inside fict-project's tickets/],
    [(ws) => writeExits(ws, EXITS, { receipt: { packet: { path: `projects/${PID}/tickets/../../other/packet.json`, sha256: 'f'.repeat(64) } } }), /names no packet inside/],
    [(ws) => writeExits(ws, EXITS, { limit: null }), /states no exit-cost limit/],
    [(ws) => writeExits(ws, EXITS, { limit: '5' }), /states no exit-cost limit/],
  ];
  for (const [change, words] of cases) {
    const ws = setup(t);
    change(ws);
    const r = PT.submitIntent(ws, intent('A'), ctx());
    assert.equal(r.status, 'refused', String(words));
    assert.match(exitWords(r), words);
    assert.equal(PT.book(ws, 'FICT/USDC', ctx()).exit_max_usd, null);
  }
  // A receipt ID that is not one names no file.
  const ws = setup(t);
  assert.match(exitWords(PT.submitIntent(ws, intent('B', { receipt_id: '../receipts/x' }), ctx())), /names no ticket receipt/);
});

test('D11: a close reads no exit cap, so a position still closes after its readings go stale', (t) => {
  const ws = setup(t);
  assert.equal(PT.submitIntent(ws, intent('A'), ctx()).state, 'ACKED');
  hour(ws, 15, { low: '99' });
  fs.rmSync(ws.abs(RECEIPT));
  const now = T0 + 16 * H + M;
  assert.match(exitWords(PT.submitIntent(ws, intent('B', {}, now), ctx(now))), /is not on record/);
  const close = intent('C', { side: 'CLOSE_LONG', position_id: `pos-${ID('A')}`, entry_price: '100.5', reference_price: '100' }, now);
  assert.equal(PT.submitIntent(ws, close, ctx(now)).state, 'ACKED');
});

// --- Portfolio time (F1, the Codex audit of 2026-10-28): each test failed on 5022c2c.

const OTHR = 'OTHR/USDC';
const obar = (i, over = {}) => ({ pair: OTHR, hour: at(T0 + i * H), open: '50', high: '51', low: '49.5', close: '50', volume: '1000000', ...over });
const navs = (r) => r.nav_by_hour.map((m) => [m.hour_end, m.nav_usd]);
// Every hour's end from the first at or after the funding, one hour apart, each known.
function portfolioTime(r) {
  const ends = r.nav_by_hour.map((m) => Date.parse(m.hour_end));
  assert.ok(ends.length > 0);
  assert.ok(ends[0] >= Date.parse(r.funded_at), 'no NAV before the funding');
  ends.forEach((e, i) => { if (i) assert.equal(e - ends[i - 1], H, 'one hour apart, in time order'); });
  assert.ok(r.nav_by_hour.every((m) => m.nav_usd !== null), 'every NAV known');
}

test('F1: a second pair\'s earlier hours change no NAV by the hour, and none is before the funding', (t) => {
  const ws = setup(t);
  PT.submitIntent(ws, intent('A'), ctx());
  hour(ws, 15, { low: '99' });
  hour(ws, 16, { high: '103', close: '102' });
  const now = T0 + 17 * H + M;
  const before = res(ws, now);
  portfolioTime(before);
  // The hourly read's first answer for a new pair: 22 hours, from before the funding.
  for (let i = -5; i <= 16; i++) assert.equal(PT.applyBar(ws, obar(i), { now: at(now) }).status, 'saved');
  const after = res(ws, now);
  portfolioTime(after);
  assert.deepEqual(navs(after), navs(before));
  assert.deepEqual([after.nav_usd, after.max_drawdown_usd, after.drawdown_24h_usd], [before.nav_usd, before.max_drawdown_usd, before.drawdown_24h_usd]);
  assert.equal(PT.book(ws, 'FICT/USDC', ctx(now)).drawdown_24h_usd, before.drawdown_24h_usd);
  // NAV is never written: the journal holds the hours and the fill.
  assert.equal(events(ws).filter((e) => e.type === 'mark').length, 0);
});

test('F1: two held pairs caught up pair by pair give the NAV the same hours give in time order', (t) => {
  const rules = { ...RULES, allowlist: ['FICT/USDC', OTHR] };
  const fict = { 15: { low: '99' }, 16: { high: '103', close: '102' }, 17: { open: '102', high: '102', low: '97.5', close: '98' }, 18: { open: '98', high: '101.5', low: '97.8', close: '101' } };
  const othr = { 15: { low: '49' }, 16: { high: '52.5', close: '52' }, 17: { open: '52', high: '52', low: '48', close: '48.5' }, 18: { open: '48.5', high: '50.5', low: '48.2', close: '50' } };
  const now = T0 + 19 * H + M;
  // Both pairs held from hour 15; four hours each, read after an outage.
  const held = (order) => {
    const ws = setup(t);
    for (let i = 0; i < 15; i++) PT.applyBar(ws, obar(i), { now: at(NOW) });
    assert.equal(PT.submitIntent(ws, intent('A'), ctx(NOW, { rules })).state, 'ACKED');
    assert.equal(PT.submitIntent(ws, intent('B', { pair: OTHR, reference_price: '50', entry_price: '50', stop_loss_price: '47.5', take_profit_price: '57.5' }), ctx(NOW, { rules })).state, 'ACKED');
    for (const [pair, i] of order) {
      const b = pair === OTHR ? obar(i, othr[i]) : bar(i, fict[i]);
      assert.equal(PT.applyBar(ws, b, { now: at(now) }).status, 'saved');
    }
    return res(ws, now);
  };
  const hours = [15, 16, 17, 18];
  // As the hourly read applies them, one pair's hours after the other's; and in time order.
  const byPair = held([...hours.map((i) => ['FICT/USDC', i]), ...hours.map((i) => [OTHR, i])]);
  const byHour = held(hours.flatMap((i) => [['FICT/USDC', i], [OTHR, i]]));
  portfolioTime(byPair);
  assert.deepEqual(navs(byPair), navs(byHour));
  assert.deepEqual([byPair.max_drawdown_usd, byPair.drawdown_24h_usd], [byHour.max_drawdown_usd, byHour.drawdown_24h_usd]);
  // At 19:00 both are held at hour 18's close: cash 10000 − 2 × 1780.6542,
  // 17.771 × 101 and 35.542 × 50.
  assert.deepEqual(navs(byPair).slice(-1), [[at(T0 + 19 * H), '10010.6626']]);
  assert.equal(byPair.nav_usd, '10010.6626');
});

test('F1: the hours read before the funding hold no NAV; the first is the funding\'s own hour', (t) => {
  const tw = tempWorkspace('ptrader');
  t.after(tw.cleanup);
  const ws = tw.ws;
  writeDecisions(ws, [decision()]);
  writeExits(ws);
  // The adapter funds the book, then the hourly read fills in the hours before.
  assert.equal(PT.fund(ws, { cash_usd: '10000', now: at(NOW) }).status, 'saved');
  for (let i = 0; i < 15; i++) assert.equal(PT.applyBar(ws, bar(i), { now: at(NOW) }).status, 'saved');
  const r = res(ws, NOW + 30 * M);
  assert.deepEqual(navs(r), [[at(NOW), '10000']]);
  assert.deepEqual([r.max_drawdown_usd, r.drawdown_24h_usd], ['0', '0']);
  assert.equal(PT.submitIntent(ws, intent('A'), ctx()).state, 'ACKED');
});
