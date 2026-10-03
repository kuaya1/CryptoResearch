'use strict';
// Display rules the watchlist depends on, tested on the browser modules
// themselves: small prices keep their precision, unknown values sort last in
// both directions, and a missing grade is never shown as a number.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

// The browser modules are ES modules in a CommonJS package: load a copy that
// is marked as ESM. Nothing in them touches the DOM until a view renders.
let tmp;
async function load() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ui-logic-'));
  fs.cpSync(path.join(__dirname, '..', 'public'), tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{ "type": "module" }');
  const ui = await import(pathToFileURL(path.join(tmp, 'ui.js')).href);
  const wl = await import(pathToFileURL(path.join(tmp, 'views', 'watchlist.js')).href);
  return { ui, wl };
}
const mods = load();
test.after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test('prices: four significant digits below $1, never fewer than two decimals, cents above', async () => {
  const { ui } = await mods;
  assert.equal(ui.fmtPrice(0.033643), '$0.03364');
  assert.equal(ui.fmtPrice(0.0004213), '$0.0004213');
  assert.equal(ui.fmtPrice(0.00000012346), '$0.0000001235');
  assert.equal(ui.fmtPrice(0.5), '$0.50');
  assert.equal(ui.fmtPrice(0.1), '$0.10');
  assert.equal(ui.fmtPrice(0.98767), '$0.9877');
  assert.equal(ui.fmtPrice(0.99999), '$1.00');
  assert.equal(ui.fmtPrice(1234.5), '$1,234.50');
  assert.equal(ui.fmtPrice(-0.12), '−$0.12');
  assert.equal(ui.fmtPrice(0), '$0.00');
  assert.equal(ui.fmtPrice(null), '—');
  assert.equal(ui.fmtPrice(Number.NaN), '—');
});

test('compact amounts and signed changes', async () => {
  const { ui } = await mods;
  assert.equal(ui.fmtCompactUsd(1234567), '$1.23M');
  assert.equal(ui.fmtCompactUsd(98_700_000_000), '$98.7B');
  assert.equal(ui.fmtCompactUsd(950), '$950');
  assert.equal(ui.fmtCompactUsd(null), '—');
  assert.equal(ui.fmtSignedPct(12.345), '+12.3%');
  assert.equal(ui.fmtSignedPct(-3.21), '−3.2%');
  assert.equal(ui.fmtSignedPct(-0.04), '0.0%');
  assert.equal(ui.fmtSignedPct(null), 'unknown');
});

const ROW = (name, extra = {}) => ({ project_id: name.toLowerCase(), name, providers: {}, research: { providers: {} }, ...extra });
const MKT = (fields) => ({ market: { status: 'fresh', price_usd: 1, ...fields } });
const REPORT = (grade, extra = {}) => ({ grade, analysis_at: '2026-09-20', imported_at: '2026-09-20T12:00:00Z', ...extra });

test('sorting: unknown values stay last in both directions; ranges sort by their low end', async () => {
  const { wl } = await mods;
  const rows = [
    ROW('Alpha', MKT({ change_7d_pct: 5 })),
    ROW('Bravo', MKT({ change_7d_pct: null })),
    ROW('Charlie', MKT({ change_7d_pct: -2 })),
    ROW('Delta'), // no market data at all
  ];
  assert.deepEqual(wl.sortRows(rows, { key: 'change7d', dir: 'desc' }).map((r) => r.name), ['Alpha', 'Charlie', 'Bravo', 'Delta']);
  assert.deepEqual(wl.sortRows(rows, { key: 'change7d', dir: 'asc' }).map((r) => r.name), ['Charlie', 'Alpha', 'Bravo', 'Delta']);

  const graded = [
    ROW('Firm70', { providers: { claude: REPORT({ status: 'firm', value: 70, display: '70.0' }) } }),
    ROW('Range60to80', { providers: { claude: REPORT({ status: 'range', low: 60, high: 80, display: '60–80' }) } }),
    ROW('Withheld', { providers: { claude: REPORT({ status: 'withheld', coverage_pct: 0 }) } }),
    ROW('PdfOnly', { providers: { claude: REPORT({ status: 'firm', value: 99, display: '99.0' }, { needs_text: true }) } }),
    ROW('NoReport'),
  ];
  const desc = wl.sortRows(graded, { key: 'grade:claude', dir: 'desc' }).map((r) => r.name);
  assert.deepEqual(desc.slice(0, 2), ['Firm70', 'Range60to80']);
  assert.deepEqual(new Set(desc.slice(2)), new Set(['Withheld', 'PdfOnly', 'NoReport']), 'withheld, PDF-only and missing grades are unknown, so they sort last');
  const asc = wl.sortRows(graded, { key: 'grade:claude', dir: 'asc' }).map((r) => r.name);
  assert.deepEqual(asc.slice(0, 2), ['Range60to80', 'Firm70']);
});

test('grade badges: every missing grade states why and is never shown as a number', async () => {
  const { ui } = await mods;
  const cases = [
    [null, null, 'none', 'None'],
    [REPORT({ status: 'withheld', coverage_pct: 0 }), null, 'withheld', 'Withheld'],
    [REPORT({ status: 'invalid_weights' }), null, 'withheld', 'No grade'],
    [REPORT({ status: 'firm', value: 81.2, display: '81.2', label: 'B' }, { needs_text: true }), null, 'pdf', 'PDF'],
    [null, { state: 'failed', error: 'timeout' }, 'failed', 'Failed'],
    // Waiting for the model: its assistant through the desk connection, or a pasted answer.
    [null, { state: 'unconfigured' }, 'manual', 'Waiting'],
    [null, { state: 'queued' }, 'queued', 'Queued'],
    [null, { state: 'running', mode: 'cowork' }, 'cowork', 'Cowork'],
    [null, { state: 'running', mode: 'connector', progress_at: new Date().toISOString() }, 'connector', 'Working'],
    [null, { state: 'running', mode: 'connector', progress_at: new Date(Date.now() - 3 * 3600000).toISOString() }, 'interrupted', 'Paused'],
  ];
  for (const [report, job, kind, value] of cases) {
    const info = ui.badgeInfo('chatgpt', report, job);
    assert.equal(info.kind, kind, JSON.stringify({ report, job }));
    assert.equal(info.value, value);
    assert.doesNotMatch(String(info.value), /^\d/, 'a missing grade never reads as a number');
    assert.match(info.text, /^ChatGPT/, 'the spoken label names the model');
  }
  const firm = ui.badgeInfo('claude', REPORT({ status: 'firm', value: 0, display: '0.0', label: 'F' }), null);
  assert.equal(firm.kind, 'grade');
  assert.equal(firm.value, '0.0', 'a real zero grade is still shown as the grade');
});

test('grade badges: analysis age and staleness are stated; newer research in progress is flagged', async () => {
  const { ui } = await mods;
  const old = new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 10);
  const stale = ui.badgeInfo('gemini', REPORT({ status: 'firm', value: 64, display: '64.0', label: 'D' }, { analysis_at: old }), null, { staleDays: 90 });
  assert.equal(stale.stale, true);
  assert.match(stale.text, /stale/);
  assert.match(stale.age, /^\d+(mo|w|y|d)$/);
  const report = REPORT({ status: 'firm', value: 64, display: '64.0' }, { imported_at: '2026-09-01T00:00:00Z' });
  const refreshing = ui.badgeInfo('gemini', report, { state: 'queued', run_created_at: '2026-09-25T00:00:00Z' });
  assert.equal(refreshing.kind, 'grade', 'the saved grade stays visible while newer research runs');
  assert.equal(refreshing.refreshing, true);
  assert.match(refreshing.text, /newer research queued/);
});
