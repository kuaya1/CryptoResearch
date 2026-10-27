'use strict';
// The paper execution harness (core/paper-fills.js, backlog item 74): pure
// fills against the trader, a create-only fills file, and the Paper Book
// untouched. Temporary fictional workspaces only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tempWorkspace } = require('./helpers');
const { validateTradeIntent } = require('../core/trade-risk');
const { simulateFill, recordFill, readFills, intentHash } = require('../core/paper-fills');
const paper = require('../core/paper');

const NOW = Date.parse('2026-10-27T12:00:00Z');
const state = { now: NOW, paper_balance_usd: 10000, paper_value_usd: 10000, drawdown_24h_usd: 0 };
const rules = { allowlist: ['BTC-USD'] };
const buy = (o = {}) => ({
  version: 'cr.trade-intent.v1', action: 'BUY', order_type: 'LIMIT', pair: 'BTC-USD', thesis_id: 'th_1',
  target_price: 101, stop_loss_price: 90, take_profit_price: 130, allocated_risk_usd: 100, max_slippage_bps: 10,
  valid_until: '2026-10-27T13:00:00Z', evidence: { report_id: 'r1', claim: 'c1', source: 's1' }, ...o,
});
const sell = (o = {}) => buy({ action: 'SELL', target_price: 99, stop_loss_price: 110, take_profit_price: 70, ...o });
const quote = (o = {}) => ({ bid: 99.5, ask: 100, at: '2026-10-27T12:30:00Z', slippage_bps: 10, ...o });
const run = (i, q) => simulateFill(i, validateTradeIntent(i, state, rules), q);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test('BUY fills at the ask plus slippage; SELL at the bid less it; costs stated, fees unknown', () => {
  const b = run(buy(), quote());
  assert.equal(b.status, 'filled');
  close(b.fill_price, 100.1);
  close(b.quantity, 100 / 10.1);
  close(b.costs.spread_usd, b.quantity * 0.25);
  close(b.costs.slippage_usd, b.quantity * 0.1);
  assert.equal(b.costs.fees.usd, null);
  assert.equal(b.costs.fees.status, 'unknown');
  const s = run(sell(), quote());
  assert.equal(s.status, 'filled');
  close(s.fill_price, 99.5 * 0.999);
  close(s.quantity, 100 / (110 - 99.5 * 0.999));
});

test('a LIMIT not reached, a crossing POST_ONLY, slippage over the cap and an expired quote do not fill', () => {
  assert.equal(run(buy({ target_price: 100.05 }), quote()).status, 'not_filled');
  assert.equal(run(sell({ target_price: 99.45 }), quote()).status, 'not_filled');
  const post = run(buy({ order_type: 'POST_ONLY', target_price: 100 }), quote());
  assert.equal(post.status, 'not_filled');
  assert.match(post.reason, /cross/);
  assert.match(run(buy(), quote({ slippage_bps: 11 })).reason, /Slippage/);
  assert.equal(run(buy(), quote({ at: '2026-10-27T13:00:00Z' })).status, 'expired');
  assert.equal(run(buy(), quote({ at: '2026-10-27T14:00:00Z' })).status, 'expired');
});

test('a refused validation never fills and carries its refusals', () => {
  const i = buy({ pair: 'ETH-USD' });
  const r = simulateFill(i, validateTradeIntent(i, state, rules), quote());
  assert.equal(r.status, 'not_filled');
  assert.equal(r.refusals[0].field, 'pair');
  assert.equal(simulateFill(buy(), undefined, quote()).status, 'not_filled');
  assert.equal(simulateFill(buy(), { ok: 'yes' }, quote()).status, 'not_filled');
});

test('unknown quote fields are not filled, never at a guessed price', () => {
  for (const f of ['bid', 'ask', 'slippage_bps']) {
    for (const bad of [undefined, null, 'x', NaN]) {
      const r = run(buy(), quote({ [f]: bad }));
      assert.equal(r.status, 'not_filled', `${f} ${bad}`);
      assert.match(r.reason, new RegExp(f));
    }
  }
  assert.equal(run(buy(), undefined).status, 'not_filled');
  assert.equal(run(buy(), quote({ at: undefined })).status, 'not_filled');
});

test('quantity comes from the stop distance; a stop at the fill price is not filled', () => {
  const q = quote({ ask: 100, slippage_bps: 0 });
  const wide = run(buy({ stop_loss_price: 50 }), q);
  close(wide.quantity, 100 / 50);
  const tight = run(buy({ stop_loss_price: 99 }), q);
  close(tight.quantity, 100 / 1);
  const atFill = run(buy({ target_price: 101, stop_loss_price: 100 }), q);
  assert.equal(atFill.status, 'not_filled');
  assert.match(atFill.reason, /stop/);
});

test('the same intent recorded twice is unchanged; paper.book reads the same', (t) => {
  const { ws, cleanup } = tempWorkspace('fills');
  t.after(cleanup);
  const before = JSON.stringify(paper.book(ws, { now: NOW }));
  const fill = run(buy(), quote());
  const a = recordFill(ws, fill);
  assert.equal(a.status, 'saved');
  const b = recordFill(ws, { ...fill, quote: { ...fill.quote } });
  assert.deepEqual(b, { status: 'unchanged', fill_id: a.fill_id });
  assert.equal(readFills(ws).length, 1);
  assert.equal(readFills(ws)[0].intent_sha256, intentHash(buy()));
  assert.notEqual(intentHash(sell()), intentHash(buy()));
  assert.equal(recordFill(ws, run(buy({ pair: 'ETH-USD' }), quote())).status, 'not_recorded');
  assert.equal(JSON.stringify(paper.book(ws, { now: NOW })), before);
  assert.equal(fs.existsSync(ws.abs('paper/positions.jsonl')), false);
});
