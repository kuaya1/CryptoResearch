'use strict';
// One shared parse of each month of the price history (market.js parsedMonth,
// 2026-10-29): readers on the server's one thread no longer parse the month
// again per ticket, per paper book and per outcome. A line appended after a
// read is seen by the next read; a month with no file reads as empty; the
// readings handed out are the same as reading the file afresh. Fictional
// workspace and prices; nothing leaves this PC.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempWorkspace } = require('./helpers');
const { openWorkspace } = require('../core/workspace');
const market = require('../core/market');
const outcomes = require('../core/report-outcomes');

const CG = 'example-history-fictional';
const MONTH = '2026-09';

function append(root, at, assets) {
  const dir = path.join(root, 'market-data', 'observations');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${MONTH}.jsonl`), `${JSON.stringify({ fetched_at: at, provider: 'coingecko', trigger: 'test', assets })}\n`);
}
const asset = (at, price, extra = {}) => ({ id: CG, price_usd: price, market_cap_usd: price * 1e6, volume_24h_usd: price * 1e4, source_last_updated_at: at, ...extra });
const scanned = (ws) => {
  const out = [];
  outcomes.scanMonth(ws, MONTH, new Set([CG, 'bitcoin']), (id, t, price, mcap) => out.push([id, t, price, mcap]));
  return out;
};

function workspace(t) {
  const { root, cleanup } = tempWorkspace('history-cache');
  t.after(cleanup);
  return { root, ws: openWorkspace({ root, actor: 'test' }) };
}

test('a month is parsed once for every reader, and an appended line is read at once', (t) => {
  const { root, ws } = workspace(t);
  append(root, '2026-09-01T00:00:00.000Z', [asset('2026-09-01T00:00:00.000Z', 1.0), { id: 'bitcoin', price_usd: 60000, source_last_updated_at: '2026-09-01T00:00:00.000Z' }]);
  append(root, '2026-09-01T01:00:00.000Z', [asset('2026-09-01T01:00:00.000Z', 1.1)]);
  const reads = [];
  const real = fs.readFileSync;
  fs.readFileSync = function (p, ...a) {
    if (String(p).includes(`${MONTH}.jsonl`)) reads.push(p);
    return real.call(this, p, ...a);
  };
  t.after(() => { fs.readFileSync = real; });

  const first = market.historyMonth(ws, MONTH);
  assert.equal(first.get(CG).length, 2);
  assert.equal(scanned(ws).length, 3, 'both assets\' priced readings');
  for (let i = 0; i < 5; i++) {
    assert.equal(market.historyMonth(ws, MONTH), first, 'the same parse, not a new one');
    scanned(ws);
  }
  assert.equal(reads.length, 1, 'six history reads and six scans read the file once');

  append(root, '2026-09-01T02:00:00.000Z', [asset('2026-09-01T02:00:00.000Z', 0.9)]);
  assert.equal(market.historyMonth(ws, MONTH).get(CG).length, 3, 'the appended hour is read');
  assert.equal(scanned(ws).filter(([id]) => id === CG).at(-1)[2], 0.9);
  assert.equal(reads.length, 2, 'read again only after the file changed');
});

test('the shared parse gives the readings the file holds, in file order', (t) => {
  const { root, ws } = workspace(t);
  const a = '2026-09-02T00:00:00.000Z';
  const b = '2026-09-02T01:00:00.000Z';
  append(root, a, [asset(a, 2.0), asset(a, 2.5), { id: CG, price_usd: 0 }, { id: 'bitcoin', price_usd: 61000, fetched_at: a }]);
  fs.appendFileSync(path.join(root, 'market-data', 'observations', `${MONTH}.jsonl`), '{"not json\n');
  append(root, b, [{ id: CG, price_usd: 2.2, source_last_updated_at: null, fetched_at: b }]);

  // historyMonth: each asset's first entry of every line, the fields readers use.
  assert.deepEqual(market.historyMonth(ws, MONTH).get(CG), [
    { source_last_updated_at: a, fetched_at: a, price_usd: 2.0, volume_24h_usd: 2.0 * 1e4 },
    { source_last_updated_at: null, fetched_at: b, price_usd: 2.2, volume_24h_usd: undefined },
  ]);
  // scanMonth: every priced reading (a zero price and an unreadable line skipped),
  // timed by its own source time, else its fetch, else the line's.
  assert.deepEqual(scanned(ws), [
    [CG, Date.parse(a), 2.0, 2.0 * 1e6],
    [CG, Date.parse(a), 2.5, 2.5 * 1e6],
    [CG, Date.parse(b), 2.2, null],
    ['bitcoin', Date.parse(a), 61000, null],
  ]);
});

test('a month with no history file reads as empty and is not kept', (t) => {
  const { root, ws } = workspace(t);
  assert.equal(market.historyMonth(ws, MONTH).size, 0);
  assert.deepEqual(scanned(ws), []);
  append(root, '2026-09-03T00:00:00.000Z', [asset('2026-09-03T00:00:00.000Z', 3.0)]);
  assert.equal(market.historyMonth(ws, MONTH).get(CG).length, 1, 'the month written later is read');
});
