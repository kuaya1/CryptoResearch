'use strict';
// The watchlist's 30D chart (2026-10-05): daily closes over the last 30 UTC
// calendar days from the desk's own stored observations (core/market.js
// priceHistory30d), drawn on a true 30-day axis (public/ui.js historySpark).
// A short history stays short, a missing day is never filled in, nothing is
// fetched; the column joins saved column choices once, and gives way first.
// FICTIONAL throwaway workspaces only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { tempWorkspace, addFixtureProject } = require('./helpers');
const market = require('../core/market');
const { buildIndex } = require('../core/indexer');
const { atomicWrite, jsonText } = require('../core/fsx');

const ID = 'example-payfi-fictional';
const NOW = Date.parse('2026-10-05T12:00:00Z');
const H = 3600000;

// Hourly fictional observations for the given days back from NOW, written to
// the month files they fall in; a price function of the hour.
function observe(ws, { days, price = (i) => 1 + i / 1000, skipDay = null, extra = null }) {
  const lines = {};
  let i = 0;
  for (let t = NOW - days * 24 * H; t <= NOW; t += H, i += 1) {
    const at = new Date(t).toISOString();
    if (skipDay && at.startsWith(skipDay)) continue;
    const assets = [{ id: ID, price_usd: price(i), volume_24h_usd: 1e6, source_last_updated_at: at }];
    if (extra) assets.push(extra(at));
    (lines[at.slice(0, 7)] = lines[at.slice(0, 7)] || []).push(JSON.stringify({ fetched_at: at, provider: 'fictional-demo', trigger: 'test', assets }));
  }
  for (const [m, ls] of Object.entries(lines)) {
    fs.mkdirSync(ws.abs('market-data/observations'), { recursive: true });
    fs.writeFileSync(ws.abs(`market-data/observations/${m}.jsonl`), `${ls.join('\n')}\n`);
  }
}

test('30-day series: daily closes over the last 30 calendar days, across months; gaps and bad prices never filled; nothing fetched', (t) => {
  const { ws, cleanup } = tempWorkspace('h30');
  t.after(cleanup);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('no fetch may happen'); };
  t.after(() => { globalThis.fetch = realFetch; });
  observe(ws, { days: 40, skipDay: '2026-09-20', price: (i) => (i === 5 ? -1 : 1 + i / 1000) });
  const s = market.priceHistory30d(ws, ID, { now: NOW });
  assert.equal(s.span_days, 30);
  assert.equal(s.from, '2026-09-06', 'the window opens 29 days before today (UTC)');
  assert.equal(s.to, '2026-10-05');
  assert.equal(s.covered_days, 29, 'thirty calendar days, one of them with no observation');
  assert.equal(s.points.length, 29);
  assert.ok(!s.points.some(([x]) => x >= 14 && x < 15), 'the missing day (2026-09-20) is not filled in');
  assert.ok(s.points.every(([x, p], i) => x >= 0 && x < 30 && p > 0 && (i === 0 || x > s.points[i - 1][0])));
  // Each day's close is its last observation: 23:00 UTC, the day's last hour.
  const sep6 = s.points[0];
  assert.equal(sep6[0], Math.round((23 / 24) * 100) / 100);
  // Today closes on the latest price, including the current one if newer.
  const withCurrent = market.priceHistory30d(ws, ID, { now: NOW, current: { price_usd: 9.99, source_last_updated_at: new Date(NOW + 60000).toISOString() } });
  assert.equal(withCurrent.points[withCurrent.points.length - 1][1], 9.99);
});

test('30-day series: a new desk shows only the days it has kept; none at all is said, not drawn', (t) => {
  const { ws, cleanup } = tempWorkspace('h30-short');
  t.after(cleanup);
  observe(ws, { days: 3 });
  const s = market.priceHistory30d(ws, ID, { now: NOW });
  assert.equal(s.covered_days, 4);
  assert.equal(s.from, '2026-10-02');
  assert.ok(s.points[0][0] >= 26, 'placed at the right end of the 30-day axis');
  assert.deepEqual(market.priceHistory30d(ws, 'another-coin-fictional', { now: NOW }), { span_days: 30, covered_days: 0, from: null, to: null, points: [] });
});

test('30-day series in the index row, from stored observations only', (t) => {
  const { ws, cleanup } = tempWorkspace('h30-index');
  t.after(cleanup);
  addFixtureProject(ws);
  const at = new Date().toISOString();
  atomicWrite(ws.abs('market-data/latest.json'), jsonText({ schema_version: 'cr.market-latest.v2', provider: 'fictional-demo', fetched_at: at, assets: { [ID]: { id: ID, symbol: 'xmpl', name: 'Example (FICTIONAL)', price_usd: 1.5, rank_source: 'fictional-demo', source: 'FICTIONAL', source_last_updated_at: at, fetched_at: at } } }));
  const row = buildIndex(ws).projects.find((p) => p.project_id === ID);
  assert.equal(row.market.sparkline_30d.covered_days, 1, 'only the current price: one day, too few to draw');
  assert.equal(row.market.sparkline_30d.points.length, 1);
});

// The browser side, with the smallest DOM the SVG builder needs.
class FakeNode {}
class FakeEl extends FakeNode {
  constructor(tag) { super(); this.tag = tag; this.attrs = {}; this.children = []; }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  appendChild(c) { this.children.push(c); return c; }
}

let tmp;
async function load() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-h30-ui-'));
  fs.cpSync(path.join(__dirname, '..', 'public'), tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{ "type": "module" }');
  return {
    ui: await import(pathToFileURL(path.join(tmp, 'ui.js')).href),
    wl: await import(pathToFileURL(path.join(tmp, 'views', 'watchlist.js')).href),
  };
}
const mods = load();
test.after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test('30D chart: drawn on a true 30-day axis, colored by its own change, its words in the label; fewer than two days is a dashed line', async (t) => {
  const { ui } = await mods;
  const prev = { document: globalThis.document, Node: globalThis.Node };
  globalThis.Node = FakeNode;
  globalThis.document = { createElementNS: (ns, tag) => new FakeEl(tag), createTextNode: (text) => Object.assign(new FakeNode(), { text }) };
  t.after(() => { globalThis.document = prev.document; globalThis.Node = prev.Node; });
  const down = ui.historySpark({ span_days: 30, covered_days: 4, from: '2026-10-02', to: '2026-10-05', points: [[26.9, 2], [27.9, 1.9], [28.9, 1.8], [29.5, 1.5]] }, { width: 108, label: 'XMPL 30-day price' });
  assert.equal(down.attrs.class, 'pspark down');
  assert.match(down.attrs['aria-label'], /^XMPL 30-day price, daily closes from this desk's own records: down 25\.00 percent over 4 of 30 days on record \(2026-10-02 to 2026-10-05\)$/);
  const d = down.children.find((c) => c.tag === 'path').attrs.d;
  const firstX = Number(/^M([\d.]+)/.exec(d)[1]);
  assert.ok(firstX > 95, `a 4-day history starts at the right end (x=${firstX} of 108)`);
  const up = ui.historySpark({ span_days: 30, covered_days: 2, from: '2026-09-06', to: '2026-10-05', points: [[0.9, 1], [29.5, 1.2]] });
  assert.equal(up.attrs.class, 'pspark up');
  assert.equal(Number(/^M([\d.]+)/.exec(up.children.find((c) => c.tag === 'path').attrs.d)[1]) < 5, true);
  const one = ui.historySpark({ span_days: 30, covered_days: 1, from: '2026-10-05', to: '2026-10-05', points: [[29.5, 1]] });
  assert.equal(one.attrs.class, 'pspark none');
  assert.match(one.attrs['aria-label'], /1 of 30 days on record \(2026-10-05\); a chart needs two$/);
  assert.match(ui.historySpark(null).attrs['aria-label'], /no stored price history yet$/);
});

test('30D chart column: after the 7D chart, on by default, added once to columns saved before it, and the first default to give way', async () => {
  const { wl } = await mods;
  const ctxWith = (saved) => ({ ui: { get: () => saved } });
  const fresh = wl.prefs(ctxWith(null)).columns;
  assert.ok(fresh.indexOf('spark30') === fresh.indexOf('spark') + 1);
  const v3 = wl.prefs(ctxWith({ v: 3, columns: ['rank', 'price', 'spark', 'research'] })).columns;
  assert.deepEqual(v3, ['rank', 'price', 'spark', 'spark30', 'research'], 'columns saved before it get it once');
  const v4 = wl.prefs(ctxWith({ v: 4, columns: ['rank', 'price', 'spark', 'research'] })).columns;
  assert.ok(!v4.includes('spark30'), 'a choice made since is kept');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'views', 'watchlist.js'), 'utf8');
  const order = JSON.parse(/const FIT_ORDER = (\[[^\]]+\])/.exec(src)[1].replace(/'/g, '"'));
  assert.ok(order.indexOf('spark30') < order.indexOf('change30d'), 'it gives way before 30d %');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /@container wl \(max-width: 1379px\) \{ table\.wl \.c-spark30 \{ display: none; \} \}/);
  assert.match(css, /@container wl \(min-width: 720px\) \{\n  table\.wl td\.c-project, table\.wl th\.c-project \{ padding-left: 24px; \}/, 'the name is set in from the edge in the table only, never on a phone card');
});
