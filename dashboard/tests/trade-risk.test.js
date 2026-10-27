'use strict';
// The pre-trade risk engine (core/trade-risk.js, backlog item 73): pure, every
// failed check listed, nothing adjusted. No file, network or model.

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateTradeIntent, VERSION } = require('../core/trade-risk');

const NOW = Date.parse('2026-10-27T12:00:00Z');
const state = () => ({ now: NOW, paper_balance_usd: 10000, paper_value_usd: 10000, drawdown_24h_usd: 0 });
const rules = () => ({ allowlist: ['BTC-USD'] });
const buy = () => ({
  version: 'cr.trade-intent.v1', action: 'BUY', order_type: 'LIMIT', pair: 'BTC-USD', thesis_id: 'th_1',
  target_price: 100, stop_loss_price: 90, take_profit_price: 130, allocated_risk_usd: 100, max_slippage_bps: 10,
  valid_until: '2026-10-27T13:00:00Z', evidence: { report_id: 'r1', claim: 'c1', source: 's1' },
});
const sell = () => ({ ...buy(), action: 'SELL', stop_loss_price: 110, take_profit_price: 70 });
const fields = (r) => r.refusals.map((x) => x.field);

test('a passing BUY and SELL', () => {
  for (const i of [buy(), sell()]) {
    const r = validateTradeIntent(i, state(), rules());
    assert.deepEqual(r, { ok: true, version: VERSION, refusals: [] });
  }
});

test('each rule refused on its own, with its field named', () => {
  const cases = [
    [{ action: 'HOLD' }, 'action'], [{ order_type: 'MARKET' }, 'order_type'], [{ version: 'x' }, 'version'],
    [{ target_price: 0 }, 'target_price'], [{ allocated_risk_usd: NaN }, 'allocated_risk_usd'],
    [{ thesis_id: '' }, 'thesis_id'], [{ pair: undefined }, 'pair'], [{ evidence: { report_id: 'r', claim: 'c' } }, 'evidence.source'],
    [{ max_slippage_bps: 21 }, 'max_slippage_bps'], [{ valid_until: '2026-10-27T12:00:00Z' }, 'valid_until'],
    [{ valid_until: 'tomorrow' }, 'valid_until'], [{ stop_loss_price: 100 }, 'stop_loss_price'],
    [{ stop_loss_price: 110 }, 'stop_loss_price'], [{ take_profit_price: 90 }, 'take_profit_price'],
    [{ pair: 'ETH-USD' }, 'pair'],
  ];
  for (const [patch, field] of cases) {
    const r = validateTradeIntent({ ...buy(), ...patch }, state(), rules());
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.deepEqual(fields(r), [field], JSON.stringify(patch));
  }
  const s = validateTradeIntent({ ...sell(), stop_loss_price: 90 }, state(), rules());
  assert.deepEqual(fields(s), ['stop_loss_price']);
});

test('several failures are listed together', () => {
  const r = validateTradeIntent({ ...buy(), action: 'x', pair: 'ETH-USD', max_slippage_bps: 50 }, state(), rules());
  assert.deepEqual(fields(r).sort(), ['action', 'max_slippage_bps', 'pair']);
});

test('risk at exactly 2% passes and a cent over is refused', () => {
  assert.equal(validateTradeIntent({ ...buy(), allocated_risk_usd: 200 }, state(), rules()).ok, true);
  const r = validateTradeIntent({ ...buy(), allocated_risk_usd: 200.01 }, state(), rules());
  assert.equal(r.refusals[0].rule, 'risk_cap');
});

test('drawdown at exactly 4% passes and over it is refused', () => {
  assert.equal(validateTradeIntent(buy(), { ...state(), drawdown_24h_usd: 300 }, rules()).ok, true);
  const r = validateTradeIntent(buy(), { ...state(), drawdown_24h_usd: 300.01 }, rules());
  assert.deepEqual(r.refusals.map((x) => x.rule), ['drawdown']);
});

test('an unknown balance, value, drawdown or time refuses, never taken as 0', () => {
  for (const f of ['paper_balance_usd', 'paper_value_usd', 'drawdown_24h_usd', 'now']) {
    for (const bad of [undefined, 'n/a']) {
      const r = validateTradeIntent(buy(), { ...state(), [f]: bad }, rules());
      assert.equal(r.ok, false, `${f} ${bad}`);
      assert.ok(fields(r).includes(`portfolioState.${f}`));
    }
  }
});

test('an empty or missing allowlist refuses every pair', () => {
  for (const rr of [{ allowlist: [] }, {}, undefined]) assert.deepEqual(fields(validateTradeIntent(buy(), state(), rr)), ['pair']);
  assert.deepEqual(fields(validateTradeIntent({ ...buy(), pair: 'btc-usd' }, state(), rules())), ['pair']);
});

test('riskRules may tighten a limit and a looser one is a rule error', () => {
  const tight = { ...rules(), risk_per_trade_max: 0.005 };
  assert.equal(validateTradeIntent(buy(), state(), tight).refusals[0].rule, 'risk_cap');
  for (const [k, v] of [['risk_per_trade_max', 0.03], ['daily_drawdown_max', 0.05], ['slippage_bps_max', 30], ['risk_per_trade_max', '0.01']]) {
    const r = validateTradeIntent(buy(), state(), { ...rules(), [k]: v });
    assert.equal(r.ok, false);
    assert.deepEqual(fields(r), [`riskRules.${k}`]);
    assert.equal(r.refusals[0].rule, 'rule_error');
  }
});

test('the inputs are unchanged by the call', () => {
  const a = [buy(), state(), rules()];
  const copy = JSON.stringify(a);
  validateTradeIntent(...a);
  assert.equal(JSON.stringify(a), copy);
});
