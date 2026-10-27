'use strict';
// The Paper Book cell of the Desk status strip (core/paper-book.js): open
// paper exposure and the 30-day result against BTC, as plain numbers, from
// rows already read; empty or missing data gives zeros, never a throw. It
// never reaches the portfolio or wallets and uses no outside package.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');
const { computePaperBookSummary } = require('../core/paper-book');

const SRC = path.join(__dirname, '..', 'core', 'paper-book.js');
const h30 = (vs) => ({ horizons: [{ days: 30, status: 'measured', vs_btc_pct: vs }, { days: 60, status: 'pending' }] });

test('populated rows: open exposure and the 30-day median against BTC', () => {
  const s = computePaperBookSummary([
    { state: 'open', risk_usd: 100 },
    { state: 'open', risk_usd: 50.25 },
    { state: 'closed', risk_usd: 400 },
    { state: 'voided', risk_usd: 900 },
    { state: 'open', risk_usd: 'lots' },
    h30(12.5),
    h30(-4),
    h30(3),
    h30(7),
    { horizons: [{ days: 30, status: 'no_price' }, { days: 60, status: 'measured', vs_btc_pct: 99 }] },
  ]);
  assert.deepEqual(s, { open_positions: 2, open_exposure_usd: 150.25, matured_30d: 4, median_vs_btc_30d_pct: 5, beat_btc_30d: 3 });
  assert.equal(computePaperBookSummary([h30(-1), h30(2), h30(9)]).median_vs_btc_30d_pct, 2);
});

test('empty or missing data gives zeros and never throws', () => {
  const zero = { open_positions: 0, open_exposure_usd: 0, matured_30d: 0, median_vs_btc_30d_pct: 0, beat_btc_30d: 0 };
  for (const input of [undefined, null, [], {}, 'x', 42, [null, 7, 'a', { horizons: null }, { horizons: [null] }]]) {
    let s;
    assert.doesNotThrow(() => { s = computePaperBookSummary(input); });
    assert.deepEqual(s, zero);
  }
});

test('every value in the summary is a finite number', () => {
  for (const input of [undefined, [{ state: 'open', risk_usd: 10 }, h30(1)], [h30(NaN), { state: 'open', risk_usd: Infinity }]]) {
    for (const [k, v] of Object.entries(computePaperBookSummary(input))) assert.ok(Number.isFinite(v), `${k} is ${v}`);
  }
});

test('negative: never loads the portfolio or wallet modules', () => {
  const loaded = Object.keys(require.cache).map((f) => path.basename(f));
  for (const f of ['portfolio.js', 'wallets.js', 'walletsync.js', 'alchemy.js']) assert.ok(!loaded.includes(f), `${f} was loaded`);
  const src = fs.readFileSync(SRC, 'utf8');
  assert.doesNotMatch(src, /require\([^)]*(portfolio|wallet|alchemy)/);
});

test('negative: requires no outside package', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  for (const r of reqs) assert.ok(r.startsWith('.') || r.startsWith('node:') || builtinModules.includes(r), `outside package: ${r}`);
  assert.doesNotMatch(src, /\bimport\s*\(|^\s*import\s/m);
});
