'use strict';
// D12 (audits/2026-10-27-de-escalation): one paper trade through the trader's
// Paper Book, cr-paper@2, from funding to the stop, asserted to the cent.
// A temporary workspace and a fictional pair, project, ticket and decision
// only: nothing here is a market, an account, a venue or an order. The book
// is driven directly here; in the desk only its adapter, core/trader-desk.js,
// calls it (trader-boundary.test.js; trader-desk.test.js drives it from
// Eric's decisions).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tempWorkspace } = require('./helpers');
const { sha256 } = require('../core/fsx');
const PT = require('../core/paper-trader');

const H = 3600000;
const M = 60000;
const T0 = Date.parse('2026-10-27T00:00:00Z');
const at = (ms) => new Date(ms).toISOString();
const ID = (c) => `01JBXQ5R7Z8Y9W0V1T2S3R4Q5${c}`;
const PAIR = 'FICT/USDC';
const VENUE = { lot: '0.001', min_notional_usd: '10', maker_rate: '0.001', taker_rate: '0.002' };
const RULES = { stop_min_pct: '0.01', stop_min_atr: '1', notional_max_pct: '0.25', price_stale_minutes: 15, max_validity_minutes: 180, allowlist: [PAIR] };

// The ticket: Eric's approve of $500 on a fictional receipt, and the
// receipt's frozen exit readings (a $5,000 cap under its 5% limit).
const PID = 'fict-project';
const RID = 'tr_2026-10-27T000000Z_fict2';
const DID = 'td_fict0000000001';
const TID = 'tk_2026-10-27T000000Z_fict2';
const TICKET = { project_id: PID, receipt_id: RID, decision_id: DID };
function writeTicket(ws) {
  const dir = `projects/${PID}/tickets`;
  fs.mkdirSync(ws.abs(`${dir}/${TID}`), { recursive: true });
  fs.mkdirSync(ws.abs(`${dir}/receipts`), { recursive: true });
  const decision = { schema_version: PT.DECISION_VERSION, decision_id: DID, project_id: PID, receipt_id: RID, ticket_id: TID, action: 'approve', pm_approved_risk_usd: 500, suggested_risk_usd: 500, proposal_type: 'ACCUMULATE', note: null, decided_at: at(T0), decided_by: 'eric', request_id: null };
  fs.writeFileSync(ws.abs(`${dir}/decisions.jsonl`), `${JSON.stringify(decision)}\n`);
  const row = (size, cost) => ({ size_usd: size, status: 'measured', cost_pct: cost, cost_complete: true, missing_costs: [], method: 'executable_quote', route_scope: 'aggregator', as_of: at(T0), note: null });
  const packet = `${JSON.stringify({ project_id: PID, exits: [row(500, 0.4), row(5000, 1.2), row(20000, 7.5)] }, null, 2)}\n`;
  fs.writeFileSync(ws.abs(`${dir}/${TID}/packet.json`), packet);
  const receipt = { schema_version: 'cr.ticket-receipt.v1', receipt_id: RID, project_id: PID, ticket_id: TID, packet: { path: `${dir}/${TID}/packet.json`, sha256: sha256(packet), captured_at: at(T0) }, desk: { sizing: { max_exit_cost_pct: 5 } } };
  fs.writeFileSync(ws.abs(`${dir}/receipts/${RID}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
}

const ctx = (now) => ({ now: at(now), rules: RULES, venue: VENUE, ticket: TICKET });
const bar = (i, over = {}) => ({ pair: PAIR, hour: at(T0 + i * H), open: '100', high: '101', low: '99.5', close: '100', volume: '1000000', ...over });
const hour = (ws, i, over = {}) => PT.applyBar(ws, bar(i, over), { now: at(T0 + (i + 1) * H) });
const intent = (c, now, over = {}) => ({
  version: 'cr.trade-intent.v3', intent_id: ID(c), thesis_id: RID, ...TICKET, pair: PAIR, side: 'OPEN_LONG', order_type: 'LIMIT',
  created_at: at(now - 2 * M), reference_price: '100', reference_at: at(now - 3 * M), entry_price: '100', stop_loss_price: '90', take_profit_price: '130',
  risk_ceiling_usd: '200', max_slippage_bps: 20, valid_until: at(now + 175 * M),
  evidence: { catalyst: 'Fictional catalyst', metrics_evaluated: ['fictional metric'], negative_invalidation: 'Fictional invalidation' },
  ...over,
});
const fieldRules = (r) => r.refusals.map((x) => [x.field, x.rule]);
const orderState = (ws, coid, now) => PT.results(ws, { now: at(now) }).orders.find((o) => o.client_order_id === coid);

test('D12: fund, size from the stored $500 approval, lose the ack, reconcile, fill in part, stop out: every figure to the cent', (t) => {
  const tw = tempWorkspace('ptrader-e2e');
  t.after(tw.cleanup);
  const ws = tw.ws;
  writeTicket(ws);

  // 1. Fund $10,000, then fifteen quiet hours: ranges of 1.5, so the 14-hour ATR is 1.5.
  assert.equal(PT.fund(ws, { cash_usd: '10000', now: at(T0) }).status, 'saved');
  for (let i = 0; i < 15; i++) hour(ws, i);
  const T1 = T0 + 15 * H;
  const b0 = PT.book(ws, PAIR, ctx(T1));
  assert.deepEqual([b0.nav_usd, b0.cash_usd, b0.atr_14h, b0.price, b0.exit_max_usd, b0.open_risk_usd], ['10000', '10000', '1.5', '100', '5000', '0']);
  assert.deepEqual([b0.grant.pm_approved_risk_usd, b0.grant.suggested_risk_usd], ['500', '500']);
  assert.deepEqual(b0.unknown, []);

  // 2. Eric approved $500, but 2% of NAV ($200) is the hard cap per trade. $500
  // is refused: above it, above the 4% 24-hour ceiling ($400) on its own, and
  // its notional (47.149 × 100) above 25% of NAV.
  const big = PT.reserveIntent(ws, intent('X', T1, { risk_ceiling_usd: '500' }), ctx(T1));
  assert.deepEqual(fieldRules(big), [['risk_ceiling_usd', 'risk_cap'], ['risk_ceiling_usd', 'drawdown'], ['risk_ceiling_usd', 'notional_cap']]);

  // 3. $200 at a stop of 90, ten points under the entry: past the floor, the
  // larger of 1% of the entry (1) and one ATR (1.5).
  //   stop fill  = 90 × (1 − 25 bps)                        = 89.775
  //   per unit   = 100 − 89.775 + 0.2 (entry fee) + 0.17955  = 10.60455
  //   quantity   = floor(200 / 10.60455 to 0.001)           = 18.859
  //   notional   = 18.859 × 100                             = 1885.9   (under $2,500 and the $5,000 exit cap)
  //   at the stop  18.859 × 10.60455                        = 199.99120845
  // 4. Reserved, then marked sent.
  const r = PT.reserveIntent(ws, intent('A', T1), ctx(T1));
  assert.equal(r.status, 'reserved');
  const coid = r.client_order_id;
  assert.equal(coid, `cr2-${ID('A')}`);
  assert.deepEqual(r.sizing, { quantity: '18.859', notional_usd: '1885.9', loss_at_stop_usd: '199.99120845', per_unit_loss_usd: '10.60455' });
  // Committed: the notional and its taker fee, 1885.9 + 3.7718.
  assert.equal(PT.book(ws, PAIR, ctx(T1)).available_cash_usd, '8110.3282');
  assert.equal(PT.markSent(ws, coid, { now: at(T1) }).state, 'SENT');

  // 5. The venue takes it, but its acknowledgement is lost: the order is
  // UNKNOWN, and nothing new opens until the venue is asked.
  assert.deepEqual(PT.venueSend(ws, coid, { now: at(T1) }), { answer: 'accepted', duplicate: false, client_order_id: coid, words: null });
  assert.equal(PT.recordAnswer(ws, coid, null, { now: at(T1) }).state, 'UNKNOWN');
  const T2 = T1 + 2 * M;
  const halted = PT.submitIntent(ws, intent('B', T2, { risk_ceiling_usd: '50' }), ctx(T2));
  assert.equal(halted.status, 'refused');
  assert.deepEqual(fieldRules(halted), [['book.orders', 'halt_unresolved']]);
  assert.match(halted.refusals[0].words, /1 order is unresolved \(UNKNOWN\)/);

  // 6. Reconciled by its client order ID: the venue's record says accepted.
  const rc = PT.reconcile(ws, coid, { now: at(T2 + M) });
  assert.deepEqual([rc.status, rc.state], ['saved', 'ACKED']);
  assert.match(rc.words, /accepted at 2026-10-27T15:00:00\.000Z/);

  // 7. Hour 15 trades through the limit with 100 units of volume: at most
  // FILL_SHARE_MAX (0.1) of it fills, 10 of the 18.859.
  //   fill  10 × 100 = 1000, taker fee 2; cash 10000 − 1002 = 8998
  //   NAV at 16:00 = 8998 + 10 × 99.5 = 9993
  assert.equal(PT.FILL_SHARE_MAX, '0.1');
  const h15 = hour(ws, 15, { open: '100', high: '100.5', low: '99', close: '99.5', volume: '100' });
  assert.deepEqual(h15.events.map((e) => [e.type, e.quantity, e.price]), [['bar', undefined, undefined], ['fill', '10', '100']]);
  assert.deepEqual(orderState(ws, coid, T1 + H), { client_order_id: coid, state: 'PARTIAL', filled: '10', quantity: '18.859', words: rc.words });
  const b1 = PT.book(ws, PAIR, ctx(T1 + H));
  // Open risk: the position at its stop (10 × 10.60455 = 106.0455) and the
  // unfilled 8.859 (93.94570845): the same 199.99120845 as at the reservation.
  assert.deepEqual([b1.nav_usd, b1.cash_usd, b1.open_risk_usd, b1.thesis_risk_usd], ['9993', '8998', '199.99120845', '199.99120845']);
  // Still committed: 8.859 × 100 = 885.9 and its fee 1.7718.
  assert.equal(b1.available_cash_usd, '8110.3282');

  // 8. Hour 16 opens above the stop and trades through it: the stop fills
  // 25 bps under 90, the taker fee is paid, and what is left of the buy is
  // cancelled with its position.
  //   proceeds 10 × 89.775 = 897.75, fee 897.75 × 0.002 = 1.7955
  //   realized 897.75 − 1.7955 − 1002 = −106.0455 (10 units' planned loss, exactly)
  //   cash 8998 + 897.75 − 1.7955 = 9893.9545
  const h16 = hour(ws, 16, { open: '95', high: '95.5', low: '89', close: '90', volume: '100' });
  assert.deepEqual(h16.events.map((e) => [e.type, e.reason, e.quantity, e.price]), [['bar', undefined, undefined, undefined], ['exit', 'stop', '10', '89.775'], ['cancelled', undefined, undefined, undefined]]);
  assert.equal(orderState(ws, coid, T1 + 2 * H).state, 'CANCELLED');

  // 9. NAV, realized P&L and open risk.
  const T3 = T1 + 2 * H;
  const b2 = PT.book(ws, PAIR, ctx(T3));
  assert.deepEqual([b2.nav_usd, b2.cash_usd, b2.available_cash_usd, b2.open_risk_usd, b2.thesis_risk_usd, b2.drawdown_24h_usd], ['9893.9545', '9893.9545', '9893.9545', '0', '0', '106.0455']);
  const res = PT.results(ws, { now: at(T3) });
  assert.deepEqual(
    [res.funded_usd, res.cash_usd, res.nav_usd, res.realized_pnl_usd, res.unrealized_pnl_usd, res.fees_usd, res.max_drawdown_usd],
    ['10000', '9893.9545', '9893.9545', '-106.0455', '0', '3.7955', '106.0455'],
  );
  assert.deepEqual(res.open_positions, []);
  assert.deepEqual(res.closed_positions, [{
    position_id: `pos-${ID('A')}`, pair: PAIR, realized_pnl_usd: '-106.0455',
    exits: [{ hour: at(T0 + 16 * H), reason: 'stop', quantity: '10', price: '89.775', realized_pnl_usd: '-106.0455' }],
  }]);
  assert.deepEqual(res.nav_by_hour.slice(-3), [{ hour_end: at(T0 + 15 * H), nav_usd: '10000' }, { hour_end: at(T0 + 16 * H), nav_usd: '9993' }, { hour_end: at(T0 + 17 * H), nav_usd: '9893.9545' }]);
  // The loss is within the risk taken: 106.0455 of the 199.99120845 at the stops.
  assert.ok(Number(res.realized_pnl_usd) >= -Number(r.sizing.loss_at_stop_usd));
  // The book is resolved again, so a new intent is no longer halted.
  const T4 = T3 + M;
  assert.equal(PT.reserveIntent(ws, intent('C', T4, { reference_price: '90', entry_price: '90', stop_loss_price: '85', take_profit_price: '110', risk_ceiling_usd: '50' }), ctx(T4)).status, 'reserved');
});
