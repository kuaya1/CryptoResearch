'use strict';
// The trader's boundary (Junior Trader invariants 1, 3, 4 and 5; the
// pipeline review and the architecture recovery's PR D, 2026-10-27): the risk
// engine, the Paper Books and the arithmetic they compute with are protected,
// by name and by any glob that reaches them; nothing outside them and their
// tests calls the trader yet (no route, CLI, connector tool or UI); no trader
// module reaches a network, a process or a secret; the frozen
// cr.trade-intent.v2 schema and the engine read the same fields; and the
// contract in DESK_STATE.md says an order never times out to lost. This file
// is protected too, so a candidate cannot loosen it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const BP = require('../scripts/backlog-promote');
const P = require('../engineering/policy');
const { parseBacklog } = require('../scripts/backlog-status');
const { validate } = require('../core/schema');
const risk = require('../core/trade-risk');
const { protectedHit } = BP;

const ROOT = path.join(__dirname, '..', '..');
const DESK = fs.readFileSync(path.join(ROOT, 'DESK_STATE.md'), 'utf8');
const section = (head) => {
  const at = DESK.indexOf(head);
  assert.ok(at >= 0, head);
  const next = DESK.slice(at + head.length).search(/\n##+ /);
  return DESK.slice(at, next < 0 ? undefined : at + head.length + next);
};

test('the Paper Books, the risk engine, their arithmetic and their tests are protected, by name and by any glob that reaches them', () => {
  for (const p of ['dashboard/core/paper.js', 'dashboard/core/paper-trader.js', 'dashboard/core/decimal.js', 'dashboard/core/trade-risk.js', 'dashboard/tests/trade-risk.test.js', 'dashboard/tests/paper-trader.test.js', 'dashboard/tests/trader-boundary.test.js', 'Dashboard/Core/Paper.js', 'dashboard/core/trade-risk.js.']) {
    assert.ok(BP.protectedHit(p), p);
    assert.ok(P.protectedWhy(p), p);
  }
  for (const g of ['dashboard/core/*.js', 'dashboard/core/pap*.js', 'dashboard/*/trade-risk.js', 'dashboard/tests/trade*.test.js', 'dashboard/core/paper-t*.js', 'dashboard/core/dec*.js']) assert.ok(P.globTouchesProtected(g), g);
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
  assert.match(four, /While any order is `RESERVED`, `SENT` or `UNKNOWN`[^\n]*opens no new intent/);
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

test('cr-paper@2: cash NAV, discrete sizing, fees and slippage, high/low stops with the stop first, apart from cr-paper@1', () => {
  const s = section('### Paper Book `cr-paper@2`');
  assert.match(s, /Built in `dashboard\/core\/paper-trader\.js` \(PR #59\) beside `cr-paper@1` \(`dashboard\/core\/paper\.js`, unchanged\)/);
  for (const part of ['**Cash NAV.**', '**Discrete sizing.**', '**Fills through the price.**', '**Fees and slippage.**', '**High/low wick stops.**', '**Long only.**', '**Protected.**']) assert.ok(s.includes(part), part);
  assert.match(s, /the stop is taken: the worse outcome/);
  assert.match(s, /never touches `paper\/positions\.jsonl`/);
});

test('no builder took the trader items: 73 and 74 are Eric\'s, on v2 and cr-paper@2, and built by PRs #58 and #59', () => {
  const items = parseBacklog(DESK);
  for (const n of [73, 74]) {
    const it = items.find((x) => x.n === n);
    assert.ok(it, `item ${n}`);
    assert.equal(it.eric, true, `item ${n} is marked (Eric)`);
    assert.equal(it.checked, true, `item ${n} is built`);
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
  assert.match(block(73), /Built by PR #58/);
  assert.match(block(74), /Built by PR #59[^\n]*`dashboard\/core\/paper-trader\.js`, so `paper\.js` \(`cr-paper@1`\) is not edited/);
  assert.doesNotMatch(DESK, /^- \[ \] \*\*\d+\.[^\n]*paper-fills\.js/m, 'the never-built fill harness is not an open item');
});


const TRADER = ['dashboard/core/trade-risk.js', 'dashboard/core/paper-trader.js'];
// The modules that may call the trader: none yet but the trader itself.
const CALLERS = new Set([...TRADER]);
const ALLOWED_REQUIRES = new Set(['./decimal', './trade-risk', './ops', './fsx', './ids', 'fs', 'path', 'crypto']);

function files(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (!['node_modules', 'app', 'dist'].includes(e.name)) files(rel, out);
    } else if (/\.(c|m)?jsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

test('the risk engine, both Paper Books, their arithmetic and their tests are protected', () => {
  for (const p of [...TRADER, 'dashboard/core/paper.js', 'dashboard/core/decimal.js', 'dashboard/tests/trade-risk.test.js', 'dashboard/tests/paper-trader.test.js', 'dashboard/tests/trader-boundary.test.js', 'templates/schemas/trade-intent.v2.schema.json']) {
    assert.ok(protectedHit(p) || /^templates\/schemas\//.test(p), `${p} is protected`);
  }
  for (const p of ['dashboard/core/trade-risk.js', 'Dashboard/Core/Paper.JS', 'dashboard/core/decimal.js']) assert.ok(protectedHit(p), p);
  // A neighbour is not caught by accident.
  assert.equal(protectedHit('dashboard/core/paper-book.js'), null);
});

test('nothing outside the trader and its tests calls it yet', () => {
  const hits = [];
  for (const rel of files('dashboard')) {
    if (CALLERS.has(rel) || rel.startsWith('dashboard/tests/')) continue;
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (/(require\(|from|import\()\s*['"][^'"]*(trade-risk|paper-trader)(\.js)?['"]/.test(src)) hits.push(rel);
  }
  assert.deepEqual(hits, []);
});

test('no trader module reaches a network, a process, the environment or a secret', () => {
  for (const rel of TRADER) {
    if (!fs.existsSync(path.join(ROOT, rel))) continue;
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(/require\(\s*'([^']+)'\s*\)/g)) assert.ok(ALLOWED_REQUIRES.has(m[1]), `${rel} requires ${m[1]}`);
    for (const re of [/process\.env/, /\bfetch\(/, /secrets/i, /api[_-]?key/i, /wallet/i]) assert.doesNotMatch(src, re, `${rel} ${re}`);
  }
});

test('the frozen cr.trade-intent.v2 schema and the engine read the same fields and the same decimals', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', 'schemas', 'trade-intent.v2.schema.json'), 'utf8'));
  assert.equal(schema.$id, risk.INTENT_VERSION);
  assert.deepEqual(Object.keys(schema.properties).sort(), [...risk.INTENT_FIELDS].sort());
  assert.deepEqual([...schema.required].sort(), risk.INTENT_FIELDS.filter((f) => f !== 'position_id').sort());
  const intent = {
    version: 'cr.trade-intent.v2', intent_id: '01JBXQ5R7Z8Y9W0V1T2S3R4Q5P', thesis_id: 'THESIS-FICT-001', pair: 'FICT/USDC', side: 'OPEN_LONG', order_type: 'LIMIT',
    created_at: '2026-10-27T11:58:00Z', reference_price: '100', reference_at: '2026-10-27T11:57:00Z', entry_price: '100', stop_loss_price: '95', take_profit_price: '115',
    risk_ceiling_usd: '100', max_slippage_bps: 20, valid_until: '2026-10-27T13:00:00Z', evidence: { catalyst: 'c', metrics_evaluated: ['m'], negative_invalidation: 'n' },
  };
  assert.deepEqual(validate(schema, intent).errors, []);
  assert.deepEqual(validate(schema, { ...intent, side: 'CLOSE_LONG', position_id: 'pos-1' }).errors, []);
  for (const bad of [{ position_id: 'pos-1' }, { side: 'CLOSE_LONG' }, { entry_price: 100 }, { entry_price: '1e2' }, { max_slippage_bps: 21 }, { client_order_id: 'x' }, { version: 'cr.trade-intent.v1' }]) {
    assert.equal(validate(schema, { ...intent, ...bad }).valid, false, JSON.stringify(bad));
  }
});
