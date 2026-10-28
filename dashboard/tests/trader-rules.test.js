'use strict';
// Eric's trader rules in settings (core/trader-rules.js, D10): refused while
// unset, accepted once set, held to their bounds. Temporary workspaces and a
// fictional pair, book and grant only: nothing here is a market or an order.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tempWorkspace } = require('./helpers');
const { validateSettingsPatch } = require('../server');
const { deepMerge } = require('../core/workspace');
const { readJson, atomicWrite, jsonText } = require('../core/fsx');
const TR = require('../core/trader-rules');
const { validateTradeIntent } = require('../core/trade-risk');

const TICKET = { project_id: 'fict-project', receipt_id: 'tr_2026-10-27T000000Z_fict2', decision_id: 'td_fict0000000001' };
const intent = {
  version: 'cr.trade-intent.v3', intent_id: '01JBXQ5R7Z8Y9W0V1T2S3R4Q5P', thesis_id: TICKET.receipt_id, ...TICKET, pair: 'FICT/USDC', side: 'OPEN_LONG', order_type: 'LIMIT',
  created_at: '2026-10-27T11:58:00Z', reference_price: '100', reference_at: '2026-10-27T11:57:00Z', entry_price: '100', stop_loss_price: '95', take_profit_price: '115',
  risk_ceiling_usd: '100', max_slippage_bps: 20, valid_until: '2026-10-27T13:00:00Z',
  evidence: { catalyst: 'Fictional catalyst', metrics_evaluated: ['fictional metric'], negative_invalidation: 'Fictional invalidation' },
};
const book = {
  now: '2026-10-27T12:00:00Z', nav_usd: '10000', drawdown_24h_usd: '0', open_risk_usd: '0', thesis_risk_usd: '0', price: '100.1', price_at: '2026-10-27T11:59:00Z',
  atr_14h: '2', lot: '0.001', min_notional_usd: '10', exit_max_usd: '5000', fees: { maker_rate: '0.001', taker_rate: '0.002' }, stop_slippage_bps: 25,
  grant: { thesis_id: TICKET.receipt_id, ...TICKET, suggested_risk_usd: '250', pm_approved_risk_usd: '250' }, positions: [], orders: [],
};

function setup(t) {
  const tw = tempWorkspace('trules');
  t.after(tw.cleanup);
  return tw;
}
// The patch as the server checks it, merged into settings as POST /api/settings does.
function save(tw, rules) {
  const patch = validateSettingsPatch({ trader: { rules } });
  const file = path.join(tw.root, 'config', 'settings.json');
  atomicWrite(file, jsonText(deepMerge(readJson(file), patch)));
  tw.ws.reloadSettings();
}

test('unset, every intent is refused; once Eric sets them, the same intent passes', (t) => {
  const tw = setup(t);
  const unset = TR.rulesOf(tw.ws);
  assert.deepEqual(unset.unset, ['stop_min_pct', 'stop_min_atr', 'notional_max_pct', 'max_validity_minutes', 'allowlist']);
  assert.deepEqual(unset.rules, { price_stale_minutes: 90 });
  const refused = validateTradeIntent(intent, book, unset.rules);
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.refusals.filter((r) => r.rule === 'rule_unset').map((r) => r.field).sort(), ['rules.allowlist', 'rules.max_validity_minutes', 'rules.notional_max_pct', 'rules.stop_min_atr', 'rules.stop_min_pct']);

  save(tw, { stop_min_pct: '0.01', stop_min_atr: '1', notional_max_pct: '0.25', max_validity_minutes: 120, allowlist: ['FICT/USDC'] });
  const set = TR.rulesOf(tw.ws);
  assert.deepEqual(set.unset, []);
  assert.deepEqual(set.rules, { stop_min_pct: '0.01', stop_min_atr: '1', notional_max_pct: '0.25', max_validity_minutes: 120, allowlist: ['FICT/USDC'], price_stale_minutes: 90 });
  const passed = validateTradeIntent(intent, book, set.rules);
  assert.deepEqual(passed.refusals, []);
  assert.equal(passed.ok, true);

  // Null unsets a rule again, and the intent is refused again.
  save(tw, { allowlist: null });
  assert.deepEqual(TR.rulesOf(tw.ws).unset, ['allowlist']);
  assert.equal(validateTradeIntent(intent, book, TR.rulesOf(tw.ws).rules).ok, false);
});

test('the server refuses a value outside its bounds, and an unknown rule', () => {
  const bad = [
    { stop_min_pct: '0' }, { stop_min_pct: '0.6' }, { stop_min_pct: '-0.01' }, { stop_min_pct: '1e-2' }, { stop_min_pct: 'abc' },
    { stop_min_atr: '21' }, { notional_max_pct: '1.01' }, { notional_max_pct: 1e-7 },
    { max_validity_minutes: 0 }, { max_validity_minutes: 90.5 }, { max_validity_minutes: '120' }, { max_validity_minutes: 10081 },
    { allowlist: [] }, { allowlist: 'FICT/USDC' }, { allowlist: ['FICT'] }, { allowlist: ['FICT/USDC', 'FICT/USDC'] },
    { risk_per_trade_max: '0.01' }, { stop_min: '0.01' },
  ];
  for (const rules of bad) assert.throws(() => validateSettingsPatch({ trader: { rules } }), (e) => e.code === 'INVALID', JSON.stringify(rules));
  assert.throws(() => validateSettingsPatch({ trader: { rules: ['x'] } }), (e) => e.code === 'INVALID');
  // A number is read as its decimal text; pairs are trimmed and kept as named.
  assert.deepEqual(validateSettingsPatch({ trader: { rules: { stop_min_pct: 0.02, allowlist: [' BTC/USDC ', 'cbBTC/USDC'] } } }).trader.rules, { stop_min_pct: '0.02', allowlist: ['BTC/USDC', 'cbBTC/USDC'] });
});

test('a saved value outside the bounds reads as unset, never applied', (t) => {
  const tw = setup(t);
  const file = path.join(tw.root, 'config', 'settings.json');
  atomicWrite(file, jsonText(deepMerge(readJson(file), { trader: { rules: { stop_min_pct: '0.9', notional_max_pct: '0.25', allowlist: ['FICT/USDC'] } } })));
  tw.ws.reloadSettings();
  const r = TR.rulesOf(tw.ws);
  assert.deepEqual(r.unset, ['stop_min_pct', 'stop_min_atr', 'max_validity_minutes']);
  assert.equal('stop_min_pct' in r.rules, false);
});
