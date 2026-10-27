'use strict';
// The pre-trade risk engine, cr-trade-risk@1 (core/trade-risk.js; backlog
// item 73). Fictional pair, book and rules only: nothing here is a market,
// an account or an order.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { validateTradeIntent, VERSION } = require('../core/trade-risk');

const NOW = '2026-10-27T12:00:00Z';
const intent = () => ({
  version: 'cr.trade-intent.v2',
  intent_id: '01JBXQ5R7Z8Y9W0V1T2S3R4Q5P',
  thesis_id: 'THESIS-FICT-001',
  pair: 'FICT/USDC',
  side: 'OPEN_LONG',
  order_type: 'LIMIT',
  created_at: '2026-10-27T11:58:00Z',
  reference_price: '100',
  reference_at: '2026-10-27T11:57:00Z',
  entry_price: '100',
  stop_loss_price: '95',
  take_profit_price: '115',
  risk_ceiling_usd: '100',
  max_slippage_bps: 20,
  valid_until: '2026-10-27T13:00:00Z',
  evidence: { catalyst: 'Fictional catalyst', metrics_evaluated: ['fictional metric'], negative_invalidation: 'Fictional invalidation' },
});
const book = () => ({
  now: NOW,
  nav_usd: '10000',
  drawdown_24h_usd: '0',
  price: '100.1',
  atr_14h: '2',
  lot: '0.001',
  min_notional_usd: '10',
  exit_max_usd: '5000',
  fees: { maker_rate: '0.001', taker_rate: '0.002' },
  stop_slippage_bps: 10,
  grant: { thesis_id: 'THESIS-FICT-001', suggested_risk_usd: '250', pm_approved_risk_usd: '250' },
  positions: [{ position_id: 'pos-1', pair: 'FICT/USDC', state: 'open', quantity: '18.232' }],
  orders: [{ client_order_id: 'cr-old', state: 'FILLED' }],
});
const rules = () => ({ stop_min_pct: '0.01', stop_min_atr: '1', notional_max_pct: '0.25', price_stale_minutes: 15, max_validity_minutes: 120, allowlist: ['FICT/USDC'] });

// Applies { intent, book, rules } patches; an undefined value removes the key.
function run(patch = {}) {
  const parts = { intent: intent(), book: book(), rules: rules() };
  for (const k of Object.keys(parts)) {
    for (const [f, v] of Object.entries(patch[k] || {})) {
      if (v === undefined) delete parts[k][f];
      else parts[k][f] = v;
    }
  }
  return validateTradeIntent(parts.intent, parts.book, parts.rules);
}
const pairs = (r) => r.refusals.map((x) => [x.field, x.rule]);

test('a passing OPEN_LONG is sized from the risk with the stop slippage and both fees in, never rounded up', () => {
  const r = run();
  assert.deepEqual(r.refusals, []);
  assert.equal(r.ok, true);
  assert.equal(r.version, VERSION);
  // Stop fill 95 less 10 bps = 94.905; per unit 5.095 + 0.2 entry fee + 0.18981 exit fee.
  assert.deepEqual(r.sizing, { quantity: '18.232', notional_usd: '1823.2', loss_at_stop_usd: '99.99905592', per_unit_loss_usd: '5.48481' });
  // One lot more would lose more than the ceiling at the stop.
  assert.ok(5.48481 * 18.233 > 100);
});

test('a passing CLOSE_LONG closes the whole open quantity and takes none of the opening checks', () => {
  const close = { side: 'CLOSE_LONG', position_id: 'pos-1', entry_price: '110', stop_loss_price: '95', take_profit_price: '115', reference_price: '110' };
  const r = run({ intent: close, book: { price: '110', drawdown_24h_usd: '9000', grant: undefined, atr_14h: undefined, exit_max_usd: undefined }, rules: { allowlist: [], stop_min_pct: undefined, notional_max_pct: undefined } });
  assert.deepEqual(r.refusals, []);
  assert.deepEqual(r.sizing, { quantity: '18.232' });
  assert.deepEqual(pairs(run({ intent: { ...close, position_id: 'pos-2' }, book: { price: '110' } })), [['position_id', 'position']]);
  assert.deepEqual(pairs(run({ intent: { ...close, pair: 'OTHER/USDC' }, book: { price: '110' } })), [['pair', 'position']]);
  assert.deepEqual(pairs(run({ intent: { side: 'CLOSE_LONG' } })), [['position_id', 'shape']]);
  assert.deepEqual(pairs(run({ intent: { position_id: 'pos-1' } })), [['position_id', 'shape']]);
});

test('each rule refused on its own, with its field named', () => {
  const cases = [
    [{ intent: { version: 'cr.trade-intent.v1' } }, ['version', 'shape']],
    [{ intent: { intent_id: 'not-a-ulid' } }, ['intent_id', 'shape']],
    [{ intent: { client_order_id: 'cr-1' } }, ['client_order_id', 'shape']],
    [{ intent: { side: 'BUY' } }, ['side', 'shape']],
    [{ intent: { order_type: 'MARKET' } }, ['order_type', 'shape']],
    [{ intent: { thesis_id: '' }, book: { grant: { thesis_id: '', suggested_risk_usd: '250', pm_approved_risk_usd: '250' } } }, ['thesis_id', 'shape']],
    [{ intent: { evidence: { catalyst: 'x', metrics_evaluated: [], negative_invalidation: 'y' } } }, ['evidence', 'shape']],
    [{ intent: { created_at: '2026-10-27 11:58' } }, ['created_at', 'timestamp']],
    [{ intent: { created_at: '2026-10-27T12:00:01Z' } }, ['created_at', 'future_time']],
    [{ intent: { reference_at: '2026-10-27T12:00:01Z' } }, ['reference_at', 'future_time']],
    [{ intent: { reference_at: '2026-10-27T11:44:59Z' } }, ['reference_at', 'stale_price']],
    [{ intent: { valid_until: '2026-10-27T12:00:00Z' } }, ['valid_until', 'expired']],
    // The life is clipped to created_at plus the longest validity (120 minutes).
    [{ intent: { created_at: '2026-10-27T10:00:00Z', valid_until: '2026-10-28T00:00:00Z' } }, ['valid_until', 'expired']],
    [{ intent: { max_slippage_bps: 21 } }, ['max_slippage_bps', 'slippage_limit']],
    [{ intent: { max_slippage_bps: '20' } }, ['max_slippage_bps', 'shape']],
    [{ book: { price: '100.21' } }, ['reference_price', 'slippage']],
    [{ intent: { pair: 'OTHER/USDC' } }, ['pair', 'allowlist']],
    [{ intent: { pair: 'fict/usdc' } }, ['pair', 'allowlist']],
    [{ intent: { stop_loss_price: '116', take_profit_price: '120' } }, ['stop_loss_price', 'price_order']],
    [{ intent: { take_profit_price: '100' } }, ['stop_loss_price', 'price_order']],
    [{ intent: { risk_ceiling_usd: '0' } }, ['risk_ceiling_usd', 'size_zero']],
    [{ intent: { risk_ceiling_usd: '0.001' } }, ['risk_ceiling_usd', 'size_zero']],
    [{ intent: { risk_ceiling_usd: '0.5' } }, ['risk_ceiling_usd', 'min_notional']],
    [{ rules: { notional_max_pct: '0.1' } }, ['risk_ceiling_usd', 'notional_cap']],
    [{ book: { exit_max_usd: '1000' } }, ['risk_ceiling_usd', 'exit_cap']],
    [{ book: { grant: undefined } }, ['book.grant', 'unknown']],
    [{ book: { grant: { thesis_id: 'THESIS-OTHER', suggested_risk_usd: '250', pm_approved_risk_usd: '250' } } }, ['book.grant', 'unknown']],
    [{ book: { grant: { thesis_id: 'THESIS-FICT-001', suggested_risk_usd: '99.99', pm_approved_risk_usd: '250' } } }, ['risk_ceiling_usd', 'gate_cap']],
    [{ book: { grant: { thesis_id: 'THESIS-FICT-001', suggested_risk_usd: '250', pm_approved_risk_usd: '99.99' } } }, ['risk_ceiling_usd', 'pm_cap']],
    [{ rules: { allowlist: [] } }, ['rules.allowlist', 'rule_unset']],
    [{ rules: { allowlist: undefined } }, ['rules.allowlist', 'rule_unset']],
    [{ rules: { stop_min_pct: undefined } }, ['rules.stop_min_pct', 'rule_unset']],
    [{ rules: { stop_min_atr: undefined } }, ['rules.stop_min_atr', 'rule_unset']],
    [{ rules: { notional_max_pct: undefined } }, ['rules.notional_max_pct', 'rule_unset']],
    [{ rules: { price_stale_minutes: undefined } }, ['rules.price_stale_minutes', 'rule_unset']],
    [{ rules: { max_validity_minutes: 0 } }, ['rules.max_validity_minutes', 'rule_unset']],
  ];
  for (const [patch, expected] of cases) assert.deepEqual(pairs(run(patch)), [expected], JSON.stringify(patch));
});

test('several failures are listed together, never only the first', () => {
  const r = run({ intent: { side: 'BUY', entry_price: 100, max_slippage_bps: 50 }, book: { nav_usd: undefined }, rules: { risk_per_trade_max: '0.05' } });
  assert.equal(r.ok, false);
  assert.deepEqual(pairs(r), [
    ['rules.risk_per_trade_max', 'rule_error'],
    ['side', 'shape'],
    ['entry_price', 'decimal'],
    ['max_slippage_bps', 'slippage_limit'],
  ]);
  // A stop half a point from the entry also sizes past both notional caps,
  // which is why the minimum distance exists.
  const many = run({ intent: { pair: 'OTHER/USDC', reference_at: '2026-10-27T11:00:00Z', stop_loss_price: '99.5' }, book: { grant: undefined, orders: [{ state: 'UNKNOWN' }] } });
  assert.deepEqual(pairs(many).map((p) => p[1]).sort(), ['allowlist', 'exit_cap', 'halt_unresolved', 'notional_cap', 'stale_price', 'stop_distance', 'unknown']);
});

test('risk at exactly 2% of NAV passes and a cent over is refused', () => {
  const at = { intent: { risk_ceiling_usd: '200' }, rules: { notional_max_pct: '0.5' } };
  assert.deepEqual(run(at).refusals, []);
  assert.deepEqual(pairs(run({ ...at, intent: { risk_ceiling_usd: '200.01' } })), [['risk_ceiling_usd', 'risk_cap']]);
});

test('the 24-hour drawdown at exactly 4% of NAV passes and over it is refused', () => {
  assert.deepEqual(run({ book: { drawdown_24h_usd: '300' } }).refusals, []);
  assert.deepEqual(pairs(run({ book: { drawdown_24h_usd: '300.01' } })), [['risk_ceiling_usd', 'drawdown']]);
});

test('a stop one tick inside the minimum distance is refused; the ATR floor counts when it is the larger', () => {
  // The floor is the larger of 1% of 100 and 1 x ATR 2: 2.
  assert.deepEqual(run({ intent: { stop_loss_price: '98', risk_ceiling_usd: '50' } }).refusals, []);
  assert.deepEqual(pairs(run({ intent: { stop_loss_price: '98.01', risk_ceiling_usd: '50' } })), [['stop_loss_price', 'stop_distance']]);
  assert.deepEqual(pairs(run({ intent: { stop_loss_price: '98', risk_ceiling_usd: '50' }, book: { atr_14h: '2.01' } })), [['stop_loss_price', 'stop_distance']]);
});

test('a float, exponent, sign or extra precision where a decimal string belongs is refused', () => {
  for (const bad of [100, '1e2', '+100', '-100', ' 100', '100.', '.5', 'NaN', 'Infinity', '1,000', '100.0000000000000000001']) {
    assert.deepEqual(pairs(run({ intent: { entry_price: bad } })), [['entry_price', 'decimal']], String(bad));
  }
  assert.deepEqual(pairs(run({ book: { nav_usd: 10000 } })), [['book.nav_usd', 'unknown']]);
});

test('an unknown NAV, drawdown, price, ATR, lot, fee or exit size refuses, never read as 0', () => {
  const cases = [
    [{ nav_usd: undefined }, 'book.nav_usd'],
    [{ nav_usd: null }, 'book.nav_usd'],
    [{ drawdown_24h_usd: undefined }, 'book.drawdown_24h_usd'],
    [{ price: undefined }, 'book.price'],
    [{ atr_14h: undefined }, 'book.atr_14h'],
    [{ lot: undefined }, 'book.lot'],
    [{ min_notional_usd: undefined }, 'book.min_notional_usd'],
    [{ exit_max_usd: undefined }, 'book.exit_max_usd'],
    [{ fees: { maker_rate: '0.001' } }, 'book.fees'],
    [{ stop_slippage_bps: undefined }, 'book.stop_slippage_bps'],
    [{ now: undefined }, 'book.now'],
  ];
  for (const [patch, field] of cases) {
    const r = run({ book: patch });
    assert.equal(r.ok, false, field);
    assert.deepEqual(pairs(r), [[field, 'unknown']], field);
    assert.match(r.refusals[0].words, /unknown|0/, field);
  }
  // A POST_ONLY order pays the maker fee: an unknown maker fee refuses it.
  assert.deepEqual(pairs(run({ intent: { order_type: 'POST_ONLY' }, book: { fees: { taker_rate: '0.002' } } })), [['book.fees', 'unknown']]);
  assert.deepEqual(run({ intent: { order_type: 'POST_ONLY' } }).refusals, []);
});

test('an UNKNOWN order refuses every intent, and so does one RESERVED or SENT with no answer', () => {
  const close = { side: 'CLOSE_LONG', position_id: 'pos-1' };
  for (const state of ['UNKNOWN', 'RESERVED', 'SENT']) {
    const orders = [{ client_order_id: 'cr-a', state: 'FILLED' }, { client_order_id: 'cr-b', state }];
    assert.deepEqual(pairs(run({ book: { orders } })), [['book.orders', 'halt_unresolved']], state);
    assert.deepEqual(pairs(run({ intent: close, book: { orders } })), [['book.orders', 'halt_unresolved']], `close ${state}`);
  }
  for (const state of ['ACKED', 'PARTIAL', 'FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED', 'NOT_FOUND']) assert.deepEqual(run({ book: { orders: [{ state }] } }).refusals, [], state);
  assert.deepEqual(pairs(run({ book: { orders: undefined } })), [['book.orders', 'unknown']]);
  assert.deepEqual(pairs(run({ book: { orders: [null] } })), [['book.orders', 'halt_unresolved']]);
});

test('a looser rule is refused and never applied; a tighter one is', () => {
  assert.deepEqual(pairs(run({ rules: { risk_per_trade_max: '0.021' } })), [['rules.risk_per_trade_max', 'rule_error']]);
  assert.deepEqual(pairs(run({ rules: { daily_drawdown_max: '0.05' } })), [['rules.daily_drawdown_max', 'rule_error']]);
  assert.deepEqual(pairs(run({ rules: { slippage_bps_max: 25 } })), [['rules.slippage_bps_max', 'rule_error']]);
  assert.deepEqual(pairs(run({ rules: { risk_per_trade: '0.01' } })), [['rules.risk_per_trade', 'rule_error']]);
  // The looser value is not applied: 2% still holds beside the rule error.
  assert.deepEqual(pairs(run({ intent: { risk_ceiling_usd: '200.01' }, rules: { risk_per_trade_max: '0.05', notional_max_pct: '0.5' } })), [['rules.risk_per_trade_max', 'rule_error'], ['risk_ceiling_usd', 'risk_cap']]);
  // Tighter: 1% of 10000 is 100 exactly; a cent over is refused.
  assert.deepEqual(run({ rules: { risk_per_trade_max: '0.01' } }).refusals, []);
  assert.deepEqual(pairs(run({ intent: { risk_ceiling_usd: '100.01' }, rules: { risk_per_trade_max: '0.01' } })), [['risk_ceiling_usd', 'risk_cap']]);
  assert.deepEqual(pairs(run({ book: { drawdown_24h_usd: '100.01' }, rules: { daily_drawdown_max: '0.02' } })), [['risk_ceiling_usd', 'drawdown']]);
  assert.deepEqual(pairs(run({ rules: { slippage_bps_max: 5 } })), [['max_slippage_bps', 'slippage_limit']]);
});

test('missing inputs refuse in words; the inputs are unchanged after the call', () => {
  assert.deepEqual(pairs(validateTradeIntent(null, book(), rules())), [['intent', 'shape']]);
  assert.deepEqual(pairs(validateTradeIntent(intent(), undefined, undefined)), [['book', 'unknown'], ['rules', 'unknown']]);
  const freeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(freeze); Object.freeze(o); } return o; };
  const args = [intent(), book(), rules()];
  const before = JSON.stringify(args);
  freeze(args);
  assert.equal(validateTradeIntent(...args).ok, true);
  assert.equal(validateTradeIntent({ ...args[0], side: 'CLOSE_LONG', position_id: 'pos-1' }, args[1], args[2]).ok, true);
  assert.equal(JSON.stringify(args), before);
});

test('the engine is pure: it requires only the decimal module and reads no clock, file, network or environment', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'trade-risk.js'), 'utf8');
  assert.deepEqual([...src.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]), ['./decimal']);
  for (const re of [/Date\.now/, /new Date\(/, /Math\.random/, /process\./, /\bfetch\(/, /setTimeout|setInterval/]) assert.doesNotMatch(src, re);
  // The same inputs give the same answer.
  assert.deepEqual(run(), run());
});
