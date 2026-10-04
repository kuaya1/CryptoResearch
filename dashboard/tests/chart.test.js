'use strict';
// The inspector's technical chart (public/views/chart.js): which symbol it
// shows, the exact TradingView widget frame it embeds, the chart symbol on the
// project record, and the one frame origin the page's security policy allows.
// FICTIONAL projects only; nothing here contacts TradingView.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');
const { tempWorkspace } = require('./helpers');
const projects = require('../core/projects');

// The browser module, loaded as ESM from a copy (as ui-logic.test.js does).
let tmp;
async function load() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-chart-'));
  fs.cpSync(path.join(__dirname, '..', 'public'), tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{ "type": "module" }');
  return import(pathToFileURL(path.join(tmp, 'views', 'chart.js')).href);
}
const mod = load();
test.after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test('symbol: the one set on the record wins; otherwise a guess from the ticker on Binance against USDT, marked as a guess; no ticker, no chart', async () => {
  const c = await mod;
  assert.deepEqual(c.chartSymbol({ symbol: 'ONDO', chart_symbol: 'coinbase:ondousd' }), { symbol: 'COINBASE:ONDOUSD', source: 'set' });
  assert.deepEqual(c.chartSymbol({ symbol: 'syrup' }), { symbol: 'BINANCE:SYRUPUSDT', source: 'ticker' });
  assert.deepEqual(c.chartSymbol({ symbol: 'X-1.b' }), { symbol: 'BINANCE:X1BUSDT', source: 'ticker' }, 'only letters and digits of a ticker');
  assert.deepEqual(c.chartSymbol({ symbol: 'ONDO', chart_symbol: 'not a symbol' }), { symbol: 'BINANCE:ONDOUSDT', source: 'ticker' }, 'an unreadable record value is never sent');
  assert.deepEqual(c.chartSymbol({ symbol: null }), { symbol: null, source: null });
  assert.deepEqual(c.chartSymbol(null), { symbol: null, source: null });
  assert.deepEqual(c.symbolSuggestions({ symbol: 'huma' }), ['BINANCE:HUMAUSDT', 'COINBASE:HUMAUSD', 'MEXC:HUMAUSDT']);
});

test('widget: the settings asked for, in the frame TradingView\'s own embed script builds (locale in the query, the rest as JSON in the hash, no page address)', async () => {
  const c = await mod;
  const s = c.widgetSettings('BINANCE:ONDOUSDT', { theme: 'light', toolbarBg: '#fafaf9' });
  assert.deepEqual(s, {
    autosize: true,
    symbol: 'BINANCE:ONDOUSDT',
    interval: 'D',
    timezone: 'Etc/UTC',
    theme: 'light',
    style: '1',
    locale: 'en',
    toolbar_bg: '#fafaf9',
    enable_publishing: false,
    hide_side_toolbar: false,
    allow_symbol_change: true,
    save_image: false,
  });
  const u = new URL(c.widgetUrl(s));
  assert.equal(u.origin, 'https://www.tradingview-widget.com');
  assert.equal(u.pathname, '/embed-widget/advanced-chart/');
  assert.equal(u.search, '?locale=en');
  const hash = JSON.parse(decodeURIComponent(u.hash.slice(1)));
  const { locale: _l, ...rest } = s; // eslint-disable-line no-unused-vars
  assert.deepEqual(hash, rest);
  assert.ok(!('page-uri' in hash) && !('frameElementId' in hash), 'nothing about this page goes to TradingView');
  assert.equal(c.widgetSettings('BINANCE:ONDOUSDT', { theme: 'dark' }).theme, 'dark');
  assert.ok(!('toolbar_bg' in c.widgetSettings('BINANCE:ONDOUSDT')), 'no toolbar color without the desk\'s token');
});

test('record: chart_symbol is EXCHANGE:PAIR, stored upper case, refused otherwise, cleared with null; the page and the record read symbols the same way', async (t) => {
  const c = await mod;
  const { ws, cleanup } = tempWorkspace('chart-symbol');
  t.after(cleanup);
  const out = projects.addProject(ws, { name: 'Example Chart (FICTIONAL)', symbol: 'XCHT', official_website: 'https://xcht.example/', coingecko_id: 'xcht-fictional', evidence: [{ url: 'https://xcht.example/docs', note: 'fictional' }] });
  const id = out.project_id;
  const before = projects.getProject(ws, id);
  projects.updateProjectFields(ws, id, { chart_symbol: ' bybit:xchtusdt.p ' });
  const after = projects.getProject(ws, id);
  assert.equal(after.chart_symbol, 'BYBIT:XCHTUSDT.P');
  assert.deepEqual({ ...after, chart_symbol: undefined, updated_at: null }, { ...before, chart_symbol: undefined, updated_at: null }, 'nothing else changes');
  for (const bad of ['BINANCE', 'BINANCE:', ':ONDOUSDT', 'BINANCE:ONDO USDT', 'https://tradingview.com/symbols/ONDOUSDT', 'BINANCE:ONDO/USDT<script>']) {
    assert.throws(() => projects.updateProjectFields(ws, id, { chart_symbol: bad }), /EXCHANGE:PAIR/, bad);
    assert.equal(c.CHART_SYMBOL_RE.test(bad.trim().toUpperCase()), false, `the page refuses ${bad} too`);
  }
  for (const good of ['BINANCE:ONDOUSDT', 'COINBASE:ONDOUSD', 'MEXC:SYRUPUSDT', 'BYBIT:HUMAUSDT.P', 'CRYPTO:BTCUSD']) assert.equal(c.CHART_SYMBOL_RE.test(good), true, good);
  projects.updateProjectFields(ws, id, { chart_symbol: null });
  assert.equal('chart_symbol' in projects.getProject(ws, id), false, 'cleared, back to the ticker guess');
  projects.updateProjectFields(ws, id, { chart_symbol: 'MEXC:XCHTUSDT' });
  projects.updateProjectFields(ws, id, { chart_symbol: '' });
  assert.equal('chart_symbol' in projects.getProject(ws, id), false, 'an empty value clears it too');
});

test('page policy: one frame origin beyond the desk\'s own, TradingView\'s widget; scripts still only from the desk', async (t) => {
  const { ws, cleanup } = tempWorkspace('chart-csp');
  const srv = await require('../server').start(ws, { port: 47600 + Math.floor(Math.random() * 300), quiet: true });
  t.after(() => {
    try { srv.shutdown(); } catch (_) { /* already stopped */ }
    cleanup();
  });
  const headers = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: '/', headers: { host: `127.0.0.1:${srv.port}` } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.headers));
    });
    req.on('error', reject);
    req.end();
  });
  const csp = Object.fromEntries(headers['content-security-policy'].split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')]));
  assert.equal(csp['frame-src'], 'https://www.tradingview-widget.com');
  assert.equal(csp['script-src'], "'self'");
  assert.equal(csp['connect-src'], "'self'");
  assert.equal(csp['default-src'], "'self'");
  assert.equal(csp['frame-ancestors'], "'none'");
});
