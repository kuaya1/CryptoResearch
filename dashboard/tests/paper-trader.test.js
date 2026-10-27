'use strict';
// The trader's Paper Book, cr-paper@2 (core/paper-trader.js; backlog item 74).
// Temporary workspaces and a fictional pair only: nothing here is a market,
// an account, a venue or an order.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tempWorkspace } = require('./helpers');
const PT = require('../core/paper-trader');
const paper = require('../core/paper');

const H = 3600000;
const M = 60000;
const T0 = Date.parse('2026-10-27T00:00:00Z');
const NOW = T0 + 15 * H + 5 * M; // fifteen closed hours behind it
const at = (ms) => new Date(ms).toISOString();
const ID = (c) => `01JBXQ5R7Z8Y9W0V1T2S3R4Q5${c}`;
const VENUE = { lot: '0.001', min_notional_usd: '10', maker_rate: '0.001', taker_rate: '0.002' };
const RULES = { stop_min_pct: '0.01', stop_min_atr: '1', notional_max_pct: '0.25', price_stale_minutes: 15, max_validity_minutes: 120, allowlist: ['FICT/USDC'] };
const GRANT = { thesis_id: 'THESIS-FICT-001', suggested_risk_usd: '250', pm_approved_risk_usd: '250' };
const ctx = (now = NOW, over = {}) => ({ now: at(now), rules: RULES, venue: VENUE, exit_max_usd: '5000', grant: GRANT, ...over });
const bar = (i, over = {}) => ({ pair: 'FICT/USDC', hour: at(T0 + i * H), open: '100', high: '101', low: '99.5', close: '100', volume: '1000000', ...over });
const hour = (ws, i, over = {}, now = T0 + (i + 1) * H) => PT.applyBar(ws, bar(i, over), { now: at(now) });
const intent = (c, over = {}, now = NOW) => ({
  version: 'cr.trade-intent.v2', intent_id: ID(c), thesis_id: 'THESIS-FICT-001', pair: 'FICT/USDC', side: 'OPEN_LONG', order_type: 'LIMIT',
  created_at: at(now - 2 * M), reference_price: '100', reference_at: at(now - 3 * M), entry_price: '100', stop_loss_price: '95', take_profit_price: '115',
  risk_ceiling_usd: '100', max_slippage_bps: 20, valid_until: at(now + 115 * M),
  evidence: { catalyst: 'Fictional catalyst', metrics_evaluated: ['fictional metric'], negative_invalidation: 'Fictional invalidation' },
  ...over,
});

function setup(t, { cash = '10000' } = {}) {
  const tw = tempWorkspace('ptrader');
  t.after(tw.cleanup);
  const ws = tw.ws;
  assert.equal(PT.fund(ws, { cash_usd: cash, now: at(T0) }).status, 'saved');
  for (let i = 0; i < 15; i++) hour(ws, i);
  return ws;
}
const res = (ws, now) => PT.results(ws, { now: at(now) });
const venueLines = (ws) => { try { return fs.readFileSync(ws.abs(PT.VENUE), 'utf8').split('\n').filter(Boolean).length; } catch (_) { return 0; } };
const D = (s) => Number(s);

test('an intent is sized by cr-trade-risk@1 with the stop slippage and fees in, reserved, sent and acknowledged', (t) => {
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
  assert.deepEqual(hour(ws, 15, { low: '100', open: '100.5', close: '100.5' }).events.map((e) => e.type), ['bar', 'mark']);
  const e = hour(ws, 16, { low: '99.99' }).events;
  assert.deepEqual(e.map((x) => x.type), ['bar', 'fill', 'mark']);
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
  assert.deepEqual(hour(ws2, 15, { low: '99', volume: '0.009' }).events.map((x) => x.type), ['bar', 'mark']);
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
  assert.deepEqual(hour(ws2, 16, { high: '115', close: '114' }).events.map((x) => x.type), ['bar', 'mark'], 'a touch of the target is not a fill');
  const tp = hour(ws2, 17, { high: '115.5', close: '115' }).events.find((x) => x.type === 'exit');
  assert.deepEqual([tp.reason, tp.price], ['take_profit', '115']);
  assert.ok(D(res(ws2, T0 + 18 * H + M).realized_pnl_usd) > 0);
});

test('the hour that fills a buy checks its stop, never its target', (t) => {
  const ws = setup(t);
  PT.submitIntent(ws, intent('A'), ctx());
  const types = hour(ws, 15, { open: '100', high: '120', low: '94', close: '96' }).events.map((x) => [x.type, x.reason]);
  assert.deepEqual(types, [['bar', undefined], ['fill', undefined], ['exit', 'stop'], ['mark', undefined]]);
  const ws2 = setup(t);
  PT.submitIntent(ws2, intent('A'), ctx());
  assert.deepEqual(hour(ws2, 15, { high: '120', low: '99', close: '110' }).events.map((x) => x.type), ['bar', 'fill', 'mark']);
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
  const ws = setup(t);
  const states = ['A', 'B', 'C', 'D', 'E', 'F'].map((c) => PT.submitIntent(ws, intent(c), ctx()));
  assert.deepEqual(states.map((s) => s.state || s.status), ['ACKED', 'ACKED', 'ACKED', 'ACKED', 'ACKED', 'refused']);
  assert.deepEqual(states[5].refusals.map((x) => [x.field, x.rule]), [['book.cash_usd', 'cash']]);
  assert.equal(PT.book(ws, 'FICT/USDC', ctx()).available_cash_usd, '1096.729');
  hour(ws, 15, { low: '99' });
  const r = res(ws, T0 + 16 * H + M);
  assert.equal(r.cash_usd, '1096.729');
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

test('crash and restart: reserved but never sent is cancelled, not sent late; sent with no answer is UNKNOWN and halts every intent', (t) => {
  const ws = setup(t);
  const a = PT.reserveIntent(ws, intent('A'), ctx());
  assert.equal(a.status, 'reserved');
  // While it is RESERVED, a new intent is refused.
  assert.deepEqual(PT.submitIntent(ws, intent('B'), ctx()).refusals.map((x) => x.rule), ['halt_unresolved']);
  let rec = PT.recover(ws, { now: at(NOW + M) });
  assert.deepEqual(rec.orders.map((o) => o.state), ['CANCELLED']);
  assert.equal(venueLines(ws), 0);
  assert.equal(PT.submitIntent(ws, intent('A'), ctx(NOW + M)).state, 'CANCELLED', 'the same intent is never sent again');
  assert.equal(PT.book(ws, 'FICT/USDC', ctx(NOW + M)).available_cash_usd, '10000');

  const c = PT.reserveIntent(ws, intent('C', {}, NOW + 2 * M), ctx(NOW + 2 * M));
  PT.markSent(ws, c.client_order_id, { now: at(NOW + 2 * M) });
  rec = PT.recover(ws, { now: at(NOW + 3 * M) });
  assert.deepEqual(rec.orders.map((o) => o.state), ['UNKNOWN']);
  assert.equal(PT.recover(ws, { now: at(NOW + 3 * M) }).status, 'unchanged');
  const blocked = PT.submitIntent(ws, intent('D', {}, NOW + 4 * M), ctx(NOW + 4 * M));
  assert.deepEqual(blocked.refusals.map((x) => [x.field, x.rule]), [['book.orders', 'halt_unresolved']]);
  // UNKNOWN never times out: hours pass, it does not fill, expire or turn into NOT_FOUND on the clock.
  for (let i = 15; i < 25; i++) hour(ws, i, { low: '98' });
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
  assert.deepEqual(e.map((x) => x.type), ['bar', 'expired', 'mark'], 'valid_until fell inside hour 17');
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
  assert.deepEqual(hour(ws, 16, { high: '100.5', close: '100.4' }).events.map((x) => x.type), ['bar', 'mark']);
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
