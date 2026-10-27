'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../core/ticket-format');
const T = require('../core/tickets');

test('ticket-format helpers', () => {
  assert.equal(F.isNum(1), true);
  assert.equal(F.isNum(NaN), false);
  assert.equal(F.round(1.23456, 2), 1.23);
  assert.equal(F.round('x'), null);
  assert.equal(F.usd(1500), '$1,500');
});

test('tickets.js re-exports the same geometry functions', () => {
  assert.equal(T.tradePlanGeometry, F.tradePlanGeometry);
  assert.equal(T.nearInvalidation, F.nearInvalidation);
  const now = Date.parse('2026-10-25T12:00:00Z');
  const g = F.tradePlanGeometry({ entry_zone: { low_usd: 0.9, high_usd: 1.1 }, upside_target: { price_usd: 2 }, invalidation_trigger: { price_usd: 0.8 } }, { price_usd: 1, as_of: '2026-10-25T11:50:00Z' }, { now });
  assert.equal(g.position, 'in_zone');
  assert.equal(g.reward_risk_ratio, 5);
  assert.equal(F.nearInvalidation('pending_pm_review', g), null);
});

test('the radar, to_stop_pct and the held-position line measure from the price and agree to the cent', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  const plan = { entry_zone: { low_usd: 0.9, high_usd: 1.1 }, upside_target: { price_usd: 2 }, invalidation_trigger: { price_usd: 0.8 } };
  for (const price of [0.85, 0.8788, 0.88]) {
    const g = F.tradePlanGeometry(plan, { price_usd: price, as_of: '2026-10-25T11:50:00Z' }, { now });
    const n = F.nearInvalidation('pending_pm_review', g);
    assert.equal(n.distance_pct, -g.to_stop_pct, String(price));
    assert.equal(n.distance_pct, Number((((price - 0.8) / price) * 100).toFixed(2)));
  }
  const g = F.tradePlanGeometry(plan, { price_usd: 1, as_of: '2026-10-25T11:50:00Z' }, { now });
  assert.equal(g.plan_reward_risk_ratio, 5);
});
