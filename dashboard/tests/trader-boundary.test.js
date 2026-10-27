'use strict';
// The Junior Trader's boundary (pipeline review, 2026-10-27;
// audits/2026-10-27-pipeline-review): the Paper Book (dashboard/core/paper.js)
// and the pre-trade risk engine (dashboard/core/trade-risk.js, not built yet)
// are protected, so no builder or agent-lane candidate changes them; the
// contract in DESK_STATE.md says an order never times out to lost and the
// intent is cr.trade-intent.v2; and no builder takes items 73 and 74. This
// file is protected too, so a candidate cannot loosen it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const BP = require('../scripts/backlog-promote');
const P = require('../engineering/policy');
const { parseBacklog } = require('../scripts/backlog-status');

const ROOT = path.join(__dirname, '..', '..');
const DESK = fs.readFileSync(path.join(ROOT, 'DESK_STATE.md'), 'utf8');
const section = (head) => {
  const at = DESK.indexOf(head);
  assert.ok(at >= 0, head);
  const next = DESK.slice(at + head.length).search(/\n##+ /);
  return DESK.slice(at, next < 0 ? undefined : at + head.length + next);
};

test('the Paper Book, the risk engine and their tests are protected, by name and by any glob that reaches them', () => {
  for (const p of ['dashboard/core/paper.js', 'dashboard/core/trade-risk.js', 'dashboard/tests/trade-risk.test.js', 'dashboard/tests/paper-trader.test.js', 'dashboard/tests/trader-boundary.test.js', 'Dashboard/Core/Paper.js', 'dashboard/core/trade-risk.js.']) {
    assert.ok(BP.protectedHit(p), p);
    assert.ok(P.protectedWhy(p), p);
  }
  for (const g of ['dashboard/core/*.js', 'dashboard/core/pap*.js', 'dashboard/*/trade-risk.js', 'dashboard/tests/trade*.test.js']) assert.ok(P.globTouchesProtected(g), g);
  // The PM Paper Book's status-strip cell is not the book: builders keep it.
  for (const p of ['dashboard/core/paper-book.js', 'dashboard/tests/paper-book.test.js', 'dashboard/public/paper-model.js']) assert.equal(BP.protectedHit(p), null, p);
});

test('invariant 4: an order is never recorded lost on a clock; unknown stays unknown until the venue answers', () => {
  const inv = section('### Junior Trader Desk Invariants');
  const four = inv.slice(inv.indexOf('4. **Reconciliation and nonce guard.**'), inv.indexOf('5. **Sovereign capital governance.**'));
  assert.match(four, /never times out to `lost`/);
  assert.match(four, /`INTENT` → `RESERVED`[^\n]*→ `SENT` → `ACKED`, `REJECTED` or `UNKNOWN`/);
  assert.match(four, /`ACKED` → `PARTIAL` → `FILLED`, `CANCELLED` or `EXPIRED`/);
  assert.match(four, /stays `UNKNOWN` until the engine has asked the venue for that `client_order_id`/);
  assert.match(four, /`NOT_FOUND` only when the venue says so after the venue's own duplicate-order window/);
  assert.match(four, /opens no new intent/);
  assert.match(four, /never resends an order under a new `client_order_id`/);
  assert.doesNotMatch(four, /then is recorded `lost`/, 'the build lane\'s timeout is not an order\'s');
});

test('cr.trade-intent.v2: an intent id, decimal strings, an explicit long-only side and a minimum stop distance', () => {
  const s = section('### `TradeIntent` schema (`cr.trade-intent.v2`)');
  const shape = JSON.parse(/```json\n([\s\S]+?)\n```/.exec(s)[1]);
  assert.equal(shape.version, 'cr.trade-intent.v2');
  for (const k of ['intent_id', 'side', 'position_id', 'created_at', 'reference_price', 'reference_at', 'entry_price', 'stop_loss_price', 'take_profit_price', 'risk_ceiling_usd', 'max_slippage_bps', 'valid_until', 'evidence']) assert.ok(k in shape, k);
  assert.equal(shape.side, 'OPEN_LONG | CLOSE_LONG');
  assert.ok(!('action' in shape) && !('allocated_risk_usd' in shape) && !('target_price' in shape), 'v1\'s fields are gone');
  for (const k of ['reference_price', 'entry_price', 'stop_loss_price', 'take_profit_price', 'risk_ceiling_usd']) assert.match(shape[k], /^decimal string/, k);
  assert.match(s, /\*\*Minimum stop distance\.\*\*[^\n]*`STOP_MIN_PCT`[^\n]*`STOP_MIN_ATR`[^\n]*every intent is refused/);
  assert.match(s, /\*\*Size and notional cap\.\*\*[^\n]*`floor_to_lot\(/);
  assert.match(s, /\*\*Fresh price\.\*\*/);
  assert.match(s, /reads none of it for a decision/);
});

test('the cr-paper@2 blueprint: cash NAV, discrete sizing, fees and slippage, high/low stops with the stop first', () => {
  const s = section('### Paper Book `cr-paper@2` (blueprint, not built)');
  for (const part of ['**Cash NAV.**', '**Discrete sizing.**', '**Fills through the price.**', '**Fees and slippage.**', '**High/low wick stops.**', '**Long only.**', '**Protected.**']) assert.ok(s.includes(part), part);
  assert.match(s, /the stop is taken: the worse outcome/);
  assert.match(s, /never rewrites `paper\/positions\.jsonl`/);
});

test('no builder takes the trader items: 73 and 74 are Eric\'s, on v2 and cr-paper@2', () => {
  const items = parseBacklog(DESK);
  for (const n of [73, 74]) {
    const it = items.find((x) => x.n === n);
    assert.ok(it, `item ${n}`);
    assert.equal(it.eric, true, `item ${n} is marked (Eric)`);
    assert.doesNotMatch(it.text, /TASK-\d+/, 'no task label of the retired PM builder');
  }
  const block = (n) => {
    const at = DESK.indexOf(`**${n}. `);
    const end = DESK.indexOf('\n- [', at);
    return DESK.slice(at, end < 0 ? undefined : end);
  };
  assert.match(block(73), /`version` is `cr\.trade-intent\.v2`/);
  assert.match(block(73), /dashboard\/core\/trade-risk\.js/);
  assert.match(block(74), /\*\*74\. Paper Book `cr-paper@2`/);
  assert.match(block(74), /touches dashboard\/core\/paper\.js/);
  assert.doesNotMatch(DESK, /^- \[ \] \*\*\d+\.[^\n]*paper-fills\.js/m, 'the never-built fill harness is not an open item');
});
