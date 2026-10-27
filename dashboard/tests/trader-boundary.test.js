'use strict';
// The trader's boundary (Junior Trader invariants 1, 3 and 5; architecture
// recovery, PR D): the risk engine, the Paper Books and the arithmetic they
// compute with are protected; nothing outside them and their tests calls the
// trader yet (no route, CLI, connector tool or UI); no trader module reaches
// a network, a process or a secret; the frozen cr.trade-intent.v2 schema and
// the engine read the same fields.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { protectedHit } = require('../scripts/backlog-promote');
const { validate } = require('../core/schema');
const risk = require('../core/trade-risk');

const ROOT = path.join(__dirname, '..', '..');
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
