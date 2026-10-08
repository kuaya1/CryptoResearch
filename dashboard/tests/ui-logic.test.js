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
  // The watchlist's rules (the React watchlist in dashboard/web draws from them).
  const wl = await import(pathToFileURL(path.join(tmp, 'watchlist-model.js')).href);
  const dialogs = await import(pathToFileURL(path.join(tmp, 'views', 'dialogs.js')).href);
  return { ui, wl, dialogs };
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
    [null, null, 'none', '—'],
    [REPORT({ status: 'withheld', coverage_pct: 0 }), null, 'withheld', 'Withheld'],
    [REPORT({ status: 'invalid_weights' }), null, 'withheld', 'No grade'],
    [REPORT({ status: 'firm', value: 81.2, display: '81.2', label: 'B' }, { needs_text: true }), null, 'pdf', 'PDF'],
    [null, { state: 'failed', error: 'timeout' }, 'failed', 'Failed'],
    // Waiting for you: its assistant through the desk connection, or a pasted answer.
    [null, { state: 'unconfigured', mode: 'manual' }, 'waiting', 'Waiting'],
    [null, { state: 'queued' }, 'queued', 'Queued'],
    [null, { state: 'running', mode: 'cowork', progress_at: new Date().toISOString() }, 'cowork', 'Working'],
    [null, { state: 'running', mode: 'connector', progress_at: new Date().toISOString() }, 'connector', 'Working'],
    [null, { state: 'dispatching', mode: 'api' }, 'dispatching', 'Working'],
    [null, { state: 'running', mode: 'connector', progress_at: new Date(Date.now() - 3 * 3600000).toISOString() }, 'interrupted', 'Paused'],
    [null, { state: 'uncertain', mode: 'api' }, 'uncertain', 'Check'],
    // An answer that stopped before finishing: its own state, not "Failed".
    [null, { state: 'failed', mode: 'api', outcome: 'incomplete', error: 'ChatGPT ran out of its output limit' }, 'incomplete', 'Incomplete'],
    [null, { state: 'failed', mode: 'api', attempts: [{ outcome: 'incomplete' }] }, 'incomplete', 'Incomplete'],
    [null, { state: 'failed', mode: 'api', attempts: [{ outcome: 'http' }] }, 'failed', 'Failed'],
    [null, { state: 'canceled' }, 'canceled', 'Canceled'],
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

test('research vocabulary: one word per meaning, Working for anything in progress, Waiting means it needs you', async () => {
  const { ui } = await mods;
  for (const k of ['running', 'dispatching', 'cowork', 'connector']) {
    assert.equal(ui.RESEARCH_STATE[k].short, 'Working', k);
    assert.equal(ui.RESEARCH_STATE[k].tone, 'work', `${k} shows the blue working dot`);
  }
  assert.equal(ui.RESEARCH_STATE.queued.short, 'Queued');
  assert.equal(ui.RESEARCH_STATE.waiting.short, 'Waiting');
  assert.equal(ui.RESEARCH_STATE.waiting.tone, 'warn', 'waiting needs you: a warn-toned marker');
  assert.equal(ui.RESEARCH_STATE.interrupted.short, 'Paused');
  assert.equal(ui.RESEARCH_STATE.uncertain.short, 'Check');
  assert.equal(ui.RESEARCH_STATE.uncertain.tone, 'warn');
  assert.equal(ui.RESEARCH_STATE.failed.tone, 'bad');
  assert.equal(ui.RESEARCH_STATE.manual, undefined, 'the old manual key is gone: an unconfigured job is "waiting"');
  assert.equal(ui.jobKey({ state: 'unconfigured', mode: 'manual' }), 'waiting');
  // The next step for a waiting job: the sentence on the online desk, the pasted prompt on this PC.
  const online = ui.researchState('waiting', { provider: 'chatgpt', hosted: true });
  assert.match(online.long, /Tell ChatGPT: "Do my waiting CryptoResearch research"/);
  assert.match(ui.researchState('waiting', { provider: 'gemini', hosted: false }).long, /paste the prompt into Gemini and import its answer/);
  assert.match(ui.waitingInstruction('gemini', { full: true }), /type @ and pick CryptoResearch.*"Do my waiting CryptoResearch research"/);
  assert.match(ui.researchState('dispatching', { provider: 'chatgpt' }).long, /Running on the ChatGPT API in the background/);
  // The badge's spoken label carries the same next step.
  assert.match(ui.badgeInfo('chatgpt', null, { state: 'unconfigured', mode: 'manual' }, { hosted: true }).text, /Do my waiting CryptoResearch research/);
});

test('newer runs on a saved grade: ↻ only while work is in progress, ! when it failed, needs a check or stalled', async () => {
  const { ui } = await mods;
  const report = REPORT({ status: 'firm', value: 72.1, display: '72.1', label: 'C' }, { imported_at: '2026-09-01T00:00:00Z' });
  const newer = (job) => ui.badgeInfo('chatgpt', report, { run_created_at: '2026-09-25T00:00:00Z', ...job });
  const waiting = newer({ state: 'unconfigured', mode: 'manual' });
  assert.equal(waiting.refreshing, false, 'a job waiting for you is not research in progress');
  assert.equal(waiting.problem, false);
  assert.equal(waiting.newerText, 'Newer run waiting for ChatGPT');
  for (const job of [{ state: 'dispatching', mode: 'api' }, { state: 'running', mode: 'connector', progress_at: new Date().toISOString() }]) {
    const b = newer(job);
    assert.equal(b.refreshing, true, JSON.stringify(job));
    assert.equal(b.problem, false);
  }
  const failed = newer({ state: 'failed', error: 'HTTP 500 from the provider' });
  assert.equal(failed.kind, 'grade', 'the saved grade stays');
  assert.equal(failed.refreshing, false);
  assert.equal(failed.problem, true);
  assert.equal(failed.newerText, 'Newer run failed: HTTP 500 from the provider');
  assert.match(failed.text, /newer run failed: HTTP 500/, 'the spoken label says it');
  assert.equal(newer({ state: 'uncertain', mode: 'api' }).problem, true);
  const paused = newer({ state: 'running', mode: 'connector', progress_at: new Date(Date.now() - 2 * 3600000).toISOString() });
  assert.equal(paused.problem, true);
  assert.match(paused.newerText, /^Newer run paused/);
  // A run older than the saved report is not "newer", whatever its state.
  const older = ui.badgeInfo('chatgpt', report, { state: 'failed', run_created_at: '2026-08-01T00:00:00Z' });
  assert.equal(older.problem, false);
  assert.equal(older.newerText, null);
  assert.equal(newer({ state: 'canceled' }).newerText, null, 'a canceled newer run is your choice, not a problem');
});

const WITHHELD = { status: 'withheld', coverage_pct: 40, reason: 'Grade withheld: four parts are not scored.' };
const UNSCORED = [
  { label: 'Token value capture', status: 'unknown', note: 'No fee data found for this token.' },
  { label: 'Valuation & supply', status: 'unknown', note: 'Unlock schedule not published.' },
  { label: 'Risk resilience', status: 'unknown', note: null },
  { label: 'Timing & executable liquidity', status: 'unknown', note: 'No order-book depth available.' },
];

test('withheld grades: a saved report reads "Grade withheld — 40% coverage", never a bare percentage, and the reason names the parts and the model\'s notes', async () => {
  const { ui } = await mods;
  const b = ui.badgeInfo('chatgpt', REPORT(WITHHELD), null);
  assert.equal(b.report, true, 'a saved report, not a missing one');
  assert.equal(b.kind, 'withheld');
  assert.equal(b.value, 'Withheld');
  assert.equal(b.sub, '40% coverage', 'the coverage is named as coverage, on its own line');
  assert.match(b.text, /^ChatGPT: report saved, grade withheld — 40% coverage \(the share of the investment weight it scored, not research progress\)/);
  const r = ui.withheldReason('chatgpt', WITHHELD, UNSCORED);
  assert.equal(r.short, 'Grade withheld — 40% coverage');
  assert.equal(r.sentence, 'Grade withheld — 40% coverage: ChatGPT said evidence was missing for token value capture, valuation & supply, risk resilience and timing & executable liquidity.');
  assert.equal(ui.withheldLabel(80), 'Grade withheld — 80% coverage');
  assert.equal(ui.withheldLabel(null), 'Grade withheld');
  assert.match(ui.COVERAGE_MEANS, /share of the investment grade's weight that this report scored\. It is not research progress and not the score\./);
  assert.deepEqual(r.items.map((x) => x.note), ['No fee data found for this token.', 'Unlock schedule not published.', null, 'No order-book depth available.']);
  assert.doesNotMatch(r.sentence, /\b\d+(\.\d)?\b(?!%)/, 'no number stands in for the grade');
  const mixed = ui.withheldReason('gemini', { status: 'withheld', coverage_pct: 80 }, [{ label: 'Token value capture', status: 'missing', note: null }, { label: 'Risk resilience', status: 'not_applicable', note: 'No lending.' }]);
  assert.match(mixed.why, /Gemini marked risk resilience not applicable/);
  assert.match(mixed.why, /Gemini's report did not score token value capture/);
  // Without a part list (an older index), the grade's own reason is used.
  assert.match(ui.withheldReason('claude', WITHHELD, null).why, /four parts are not scored/);
  // From a full report record: the grade's missing parts with the components' own notes.
  const parts = ui.unscoredFrom({ status: 'withheld', missing: [{ id: 'token_value_capture', label: 'Token value capture', status: 'unknown' }] }, { token_value_capture: { status: 'unknown', missing_data: 'No fee data.' } });
  assert.deepEqual(parts, [{ label: 'Token value capture', status: 'unknown', note: 'No fee data.' }]);
  assert.deepEqual(ui.unscoredFrom({ status: 'firm' }, {}), []);
});

test('prices: the header names a failed or rate-limited refresh with the source\'s own note', async () => {
  const { ui, wl } = await mods;
  const ago = new Date(Date.now() - 25 * 60000).toISOString();
  const fresh = ui.priceStatus({ freshness: 'fresh', age_minutes: 25, last_success_at: ago });
  assert.equal(fresh.problem, false);
  assert.equal(fresh.note, null);
  assert.match(fresh.asOf, /^Prices as of .* \(25 min ago\)$/);
  const limited = ui.priceStatus({ freshness: 'fresh_last_failed', last_success_at: ago, last_error: 'HTTP 429', rate_limited: true, note: 'CoinGecko is limiting requests; the next try is at 3:20 PM.' });
  assert.equal(limited.problem, true, 'fresh_last_failed uses the warn style');
  assert.equal(limited.note, 'CoinGecko is limiting requests; the next try is at 3:20 PM.');
  assert.equal(ui.priceStatus({ freshness: 'stale_failed', last_success_at: ago, last_error: 'HTTP 503' }).note, 'HTTP 503', 'the last error when there is no note');
  assert.match(ui.priceStatus({ freshness: 'fresh', rate_limited: true, retry_at: ago }).note, /limiting requests/);
  // The refresh toast: anything but ok or partial is a failure, with the age of the prices shown.
  const [okText, okKind] = wl.refreshToast({ result: { status: 'ok', message: 'Updated 3 of 3 tracked assets.' } });
  assert.equal(okKind, '');
  assert.equal(okText, 'Updated 3 of 3 tracked assets.');
  const [badText, badKind] = wl.refreshToast({ result: null, status: { last_success_at: ago, last_error: 'HTTP 429.' } });
  assert.equal(badKind, 'bad');
  assert.match(badText, /^Prices not refreshed: HTTP 429\. Showing prices from .+\.$/);
  const [backoff] = wl.refreshToast({ result: { status: 'backoff', message: 'Not refreshed: rate limited; next attempt after 15:20.' }, status: {} });
  assert.equal(backoff, 'Prices not refreshed: rate limited; next attempt after 15:20. There are no earlier prices to show.');
});

test('watchlist: opens on what you follow, one count for the nav and the header, Not watching one choice away', async () => {
  const { ui, wl } = await mods;
  const rows = [
    ROW('Watched', { on_watchlist: true }),
    ROW('HeldOnly', { on_watchlist: false, held: true }),
    ROW('Dropped', { on_watchlist: false }),
    ROW('OldOne', { on_watchlist: true, status: 'archived' }),
  ];
  const show = (owned) => rows.filter((p) => wl.matches(p, { sector: '', owned, coverage: 'any', ret30: 'any', archived: false }, '')).map((p) => p.name);
  assert.deepEqual(show('watching'), ['Watched', 'HeldOnly'], 'watched or held');
  assert.deepEqual(show('held'), ['HeldOnly']);
  assert.deepEqual(show('off'), ['Dropped']);
  assert.deepEqual(show('all'), ['Watched', 'HeldOnly', 'Dropped']);
  assert.equal(ui.followedCount(rows), 2, 'the nav and the header count the same projects');
  // A saved "all" from before was the old default, not a choice.
  const ctxWith = (saved) => ({ ui: { get: () => saved } });
  assert.equal(wl.prefs(ctxWith({ filters: { owned: 'all' } })).filters.owned, 'watching');
  assert.equal(wl.prefs(ctxWith({ v: 2, filters: { owned: 'all' } })).filters.owned, 'all', 'a choice made since is kept');
  assert.equal(wl.prefs(ctxWith({})).filters.owned, 'watching');
});

test('theme: light is the default, also for a browser that used the dark default; dark and "match this device" are choices', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'theme.js'), 'utf8');
  const run = (stored) => {
    const attrs = {};
    const window = { localStorage: { getItem: () => (stored === undefined ? null : JSON.stringify(stored)) } };
    const document = { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } };
    new Function('window', 'document', src)(window, document);
    return attrs['data-theme'] || 'light';
  };
  assert.equal(run(undefined), 'light', 'nothing stored: light');
  assert.equal(run(null), 'light');
  assert.equal(run('light'), 'light');
  assert.equal(run('dark'), 'dark');
  assert.equal(run('system'), 'system');
  assert.equal(run('<script>'), 'light', 'anything else is ignored');
  // The one token layer (tokens.css, Eric 2026-10-08): light by default, dark a choice.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'tokens.css'), 'utf8');
  const root = css.slice(css.indexOf(':root {'), css.indexOf('\n}', css.indexOf(':root {')));
  assert.match(root, /color-scheme: light/, 'the default palette is the light one');
  assert.match(css, /:root\[data-theme="dark"\] \{[^}]*color-scheme: dark/, 'dark stays available');
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\s*:root\[data-theme="system"\] \{[^}]*color-scheme: dark/, '"match this device" follows the system');
  // The app loads it before the first paint's stylesheet, after theme.js.
  const page = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  assert.ok(page.indexOf('/theme.js') > 0 && page.indexOf('/theme.js') < page.indexOf('/src/main.jsx'), 'the theme is applied before the app loads');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'main.jsx'), 'utf8'), /^import '\.\.\/\.\.\/public\/tokens\.css';/m);
});

test('research progress: each model\'s way from prompt to grade, without inventing a step', async () => {
  const { wl } = await mods;
  const firm = { grade: { status: 'firm', value: 72 } };
  assert.deepEqual(wl.progressSteps(null, null), ['todo', 'todo', 'todo', 'todo'], 'nothing asked yet');
  assert.deepEqual(wl.progressSteps(null, 'queued'), ['done', 'now', 'todo', 'todo']);
  assert.deepEqual(wl.progressSteps(null, 'waiting'), ['done', 'warn', 'todo', 'todo'], 'waiting needs you');
  assert.deepEqual(wl.progressSteps(null, 'uncertain'), ['done', 'warn', 'todo', 'todo']);
  assert.deepEqual(wl.progressSteps(null, 'failed'), ['done', 'bad', 'todo', 'todo']);
  assert.deepEqual(wl.progressSteps(firm, 'completed'), ['done', 'done', 'done', 'done']);
  assert.deepEqual(wl.progressSteps(firm, null), ['done', 'done', 'done', 'done'], 'a report saved outside a run');
  assert.deepEqual(wl.progressSteps({ grade: { status: 'withheld', coverage_pct: 55 } }, 'completed'), ['done', 'done', 'done', 'warn'], 'a withheld grade is not a grade');
  assert.deepEqual(wl.progressSteps({ ...firm, needs_text: true }, null)[3], 'warn', 'a PDF is not graded yet');
});

test('inspector: opens on a calculated grade, then any saved report, then Claude; unknown bars stay empty', async () => {
  const { wl } = await mods;
  const firm = { grade: { status: 'firm', value: 61 } };
  const withheld = { grade: { status: 'withheld', coverage_pct: 55 } };
  assert.equal(wl.defaultModel({ claude: withheld, chatgpt: firm }), 'chatgpt', 'the first calculated grade, not the first report');
  assert.equal(wl.defaultModel({ gemini: { grade: { status: 'range', low: 40, high: 55 } } }), 'gemini', 'a range is a grade');
  assert.equal(wl.defaultModel({ chatgpt: { ...firm, needs_text: true }, gemini: withheld }), 'chatgpt', 'no grade anywhere: the first saved report');
  assert.equal(wl.defaultModel({}), 'claude');
  assert.equal(wl.defaultModel(null), 'claude');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.cbar\.unknown \{[^}]*background: transparent;[^}]*dashed/, 'an unknown category is an empty dashed track, never a zero');
  // The React bars: an unknown score is an empty dashed track (ScoreBar), never a fill.
  const web = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'styles', 'inspector.css'), 'utf8');
  assert.match(web, /\.bar\.is-unknown \{[^}]*background: transparent;[^}]*repeating-linear-gradient/);
  const bar = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'components', 'Gauge.jsx'), 'utf8');
  assert.match(bar, /return <span className="bar is-unknown" aria-hidden="true" \/>;/);
});

test('one formatter for the list and the inspector: the same row reads the same in both; two decimals for every change', async () => {
  const { wl, ui } = await mods;
  const row = { price_usd: 0.41274, change_24h_pct: 0.857, change_7d_pct: -12.5, change_30d_pct: 0, market_cap_usd: 412.3e6, volume_24h_usd: 18.61e6, fdv_usd: 498e6 };
  const s = wl.marketStrings(row);
  assert.equal(s.change24h, '+0.86%', 'not "0.86%" in one place and "+0.9%" in the other');
  assert.equal(s.change7d, '−12.50%');
  assert.equal(s.change30d, '0.00%');
  assert.equal(s.price, ui.fmtPrice(0.41274));
  assert.equal(s.mcap, '$412.30M');
  assert.equal(s.fdvMc, '1.21×', 'FDV / MC from the two values shown');
  assert.equal(wl.marketStrings({ ...row, market_cap_usd: null }).fdvMc, null, 'no market cap, no ratio');
  assert.equal(ui.fmtChangePct(null), null);
  // Both views draw their figures from marketStrings and the shared formatters, never their own.
  const web = (f) => fs.readFileSync(path.join(__dirname, '..', 'web', 'src', ...f.split('/')), 'utf8');
  const body = (src, name) => src.slice(src.indexOf(`function ${name}(`), src.indexOf('\n}\n', src.indexOf(`function ${name}(`)));
  const table = web('views/watchlist/ProjectTable.jsx');
  assert.match(body(table, 'Cell'), /const s = marketStrings\(m\) \|\| \{\};/);
  assert.match(body(table, 'Cell'), /s\.mcap/);
  assert.match(body(web('components/figures.jsx'), 'Change'), /fmtChangePct\(value\)/);
  const insp = web('views/inspector/Inspector.jsx');
  assert.match(body(insp, 'HeadMarket'), /marketStrings\(m\)/);
  assert.doesNotMatch(body(insp, 'HeadMarket'), /fmtSignedPct|toFixed\(1\)\}%/);
  assert.doesNotMatch(table + insp, /cmcCompact/);
});

test('price clock: the drawer reads the bar\'s refresh time when that refresh stored the price, and says so when it kept an older one', async () => {
  const { wl } = await mods;
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const same = wl.priceClock(iso(10000), iso(10000));
  assert.equal(same.kept, false);
  assert.equal(same.text, 'just now');
  const kept = wl.priceClock(iso(6 * 60000), iso(10000));
  assert.equal(kept.kept, true);
  assert.equal(kept.text, 'Not refreshed · 6 min ago', 'an older stored price is labeled, never shown as the bar\'s time');
  assert.equal(wl.priceClock(null, iso(10000)).text, 'just now');
});

test('breadth is labeled with what it counts: n of N over 30 days', async () => {
  const { wl } = await mods;
  const b = wl.breadthWords({ beating_btc: 57, counted: 74, share_pct: 77 });
  assert.equal(b.text, '57 of 74 beat BTC');
  assert.equal(b.window, '30d');
  assert.match(b.title, /100 largest by CoinGecko market cap/);
  assert.equal(wl.breadthWords(null), null);
});

test('a model on hold: its header and its dashes follow the model status, for any model; a dash only where it has no report at all', async () => {
  const { wl } = await mods;
  const index = { settings: { research: { on_hold: { gemini: { since: '2026-10-04T12:00:00Z', reason: 'x' } } } } };
  const firm = { grade: { status: 'firm', value: 61 } };
  const withheld = { grade: { status: 'withheld', coverage_pct: 55 } };
  assert.deepEqual(wl.holdCell(index, 'gemini', null), { hold: true, dash: true, label: 'No Gemini score' }, 'no report: a dash');
  assert.equal(wl.holdCell(index, 'gemini', withheld).dash, false, 'a saved report whose grade was withheld keeps its Withheld pill');
  assert.equal(wl.holdCell(index, 'gemini', firm).dash, false, 'a score it gave keeps its pill');
  assert.equal(wl.holdCell(index, 'gemini', { ...firm, needs_text: true }).dash, false, 'a saved PDF keeps its pill');
  assert.deepEqual(wl.holdCell(index, 'chatgpt', null), { hold: false, dash: false, label: 'No ChatGPT score' }, 'only the model on hold');
  const chatgptHeld = { settings: { research: { on_hold: { chatgpt: { since: null } } } } };
  assert.equal(wl.holdCell(chatgptHeld, 'chatgpt', null).hold, true, 'not hardcoded to Gemini');
  assert.equal(wl.holdCell({ settings: {} }, 'gemini', null).hold, false);
  for (const f of [['public', 'watchlist-model.js'], ['web', 'src', 'views', 'watchlist', 'ProjectTable.jsx'], ['web', 'src', 'views', 'inspector', 'ModelPanel.jsx']]) {
    const src = fs.readFileSync(path.join(__dirname, '..', ...f), 'utf8');
    assert.doesNotMatch(src, /'gemini'[^\n]*on hold|on hold[^\n]*'gemini'/i, `no model is named in the on-hold code (${f.join('/')})`);
  }
});

test('R: only a plain R outside fields, with nothing open, on a project with something to review; it goes to the next one to review in the list\'s order', async () => {
  const { wl } = await mods;
  const todo = { project_id: 'a', changes: { item_count: 3 } };
  const done = { project_id: 'b', changes: { item_count: 0 } };
  const key = (k, mods = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...mods });
  assert.equal(wl.reviewKeyAllowed(key('r'), { project: todo }), true);
  assert.equal(wl.reviewKeyAllowed(key('R'), { project: todo }), true);
  assert.equal(wl.reviewKeyAllowed(key('r', { ctrlKey: true }), { project: todo }), false, 'Ctrl+R is the browser\'s');
  assert.equal(wl.reviewKeyAllowed(key('r', { metaKey: true }), { project: todo }), false, 'Cmd+R is the browser\'s');
  assert.equal(wl.reviewKeyAllowed(key('r', { altKey: true }), { project: todo }), false);
  assert.equal(wl.reviewKeyAllowed(key('r'), { project: todo, busy: true }), false, 'typing, a dialog or a menu');
  assert.equal(wl.reviewKeyAllowed(key('r'), { project: done }), false, 'nothing to review');
  assert.equal(wl.reviewKeyAllowed(key('r'), { project: null }), false, 'no project chosen');
  assert.equal(wl.reviewKeyAllowed(key('j'), { project: todo }), false);
  assert.equal(wl.needsReview({ changes: { item_count: 2 }, status: 'archived' }), false, 'archived: nothing to review');
  const projects = [{ project_id: 'a', changes: { item_count: 1 } }, { project_id: 'b', changes: { item_count: 0 } }, { project_id: 'c', changes: { item_count: 4 } }, { project_id: 'd', changes: { item_count: 2 } }];
  assert.equal(wl.nextToReview(['a', 'b', 'c', 'd'], projects, 'a'), 'c', 'skips projects with nothing to review');
  assert.equal(wl.nextToReview(['a', 'b', 'c', 'd'], projects, 'd'), 'a', 'wraps to the top of the list');
  assert.equal(wl.nextToReview(['d', 'c', 'b', 'a'], projects, 'c'), 'a', 'in the order shown');
  assert.equal(wl.nextToReview(['a', 'b'], projects, 'a'), null, 'none left: All caught up');
  // The browser's own keys stay the browser's: the handler checks before acting.
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'views', 'watchlist', 'Watchlist.jsx'), 'utf8');
  assert.match(src, /reviewKeyAllowed\(e, \{ busy: Boolean\(busy\) \|\| reviewBusy, project \}\)/);
  assert.match(src, /markReviewed\(project, \{ advance: true/);
});

test('contract chips: always Mint, Blacklist (Freeze on Solana), Proxy and Tax, with a clean, risky or unknown dot; n/a for a native coin', async () => {
  const { wl } = await mods;
  const keys = (m) => m.chips.map((c) => `${c.label}:${c.value}:${c.dot}`);
  const unscreened = wl.contractChipModel({ state: 'pending', contracts: [{ chain: 'ethereum', label: 'Ethereum', address: '0x1111111111111111111111111111111111111111', status: 'pending' }] });
  assert.deepEqual(keys(unscreened), ['Mint:—:unknown', 'Blacklist:—:unknown', 'Proxy:—:unknown', 'Tax:—:unknown'], 'no screen yet: all four, unknown');
  const native = wl.contractChipModel({ state: 'native_chain', contracts: [] });
  assert.deepEqual(keys(native), ['Mint:n/a:none', 'Blacklist:n/a:none', 'Proxy:n/a:none', 'Tax:n/a:none']);
  const evm = wl.contractChipModel({ state: 'fresh', fetched_at: '2026-10-04T12:00:00Z', age_hours: 2, contracts: [{ chain: 'ethereum', label: 'Ethereum', family: 'evm', address: '0x2222222222222222222222222222222222222222', status: 'ok', mint: 'absent', blacklist: 'unknown', proxy: 'present', sell_tax_pct: 0, severe: [] }] });
  assert.deepEqual(keys(evm), ['Mint:No:clean', 'Blacklist:—:unknown', 'Proxy:Yes:risky', 'Tax:0%:clean']);
  const sol = wl.contractChipModel({ state: 'fresh', fetched_at: '2026-10-04T12:00:00Z', age_hours: 2, contracts: [{ chain: 'solana', label: 'Solana', family: 'solana', address: 'So11111111111111111111111111111111111111112', status: 'ok', mint: 'present', blacklist: 'absent', severe: [] }] });
  assert.deepEqual(keys(sol), ['Mint:Yes:risky', 'Freeze:No:clean', 'Proxy:n/a:none', 'Tax:—:unknown']);
});

test('inspector scroll: the body\'s keep-scroll key names the project, so the page\'s restore keeps a redraw in place and never carries a place to another project', () => {
  const web = (...f) => fs.readFileSync(path.join(__dirname, '..', 'web', 'src', ...f), 'utf8');
  const insp = web('views', 'inspector', 'Inspector.jsx');
  // The router restores every [data-keep-scroll] element by its key.
  assert.match(web('lib', 'router.js'), /querySelector\(`\[data-keep-scroll="\$\{CSS\.escape\(key\)\}"\]`\)/);
  assert.match(insp, /className="insp-body" ref=\{body\} data-keep-scroll=\{`panel:\$\{pid\}`\}/, 'one key per project');
  assert.doesNotMatch(insp, /data-keep-scroll="panel"/, 'no shared key');
  // And the inspector's body starts at its top when the project changes.
  assert.match(insp, /if \(changed && body\.current\) body\.current\.scrollTop = 0;/);
});

test('evidence marks in the pills: a solid dot for a serious flag, a ring for a material one (the last rule for each wins)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const last = (sel) => { const re = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^{]*\\{([^}]*)\\}`, 'g'); let m; let out = null; while ((m = re.exec(css))) out = m[1]; return out || ''; };
  const material = last(':is(table.wl, .mtabs) .gb.ev-material .ev');
  assert.match(material, /background: transparent/, 'material: hollow');
  assert.match(material, /box-shadow: inset 0 0 0 1\.5px var\(--warn-strong\)/, 'material: a ring');
  assert.match(css, /:is\(table\.wl, \.mtabs\) \.gb\.ev-serious \.ev,[^}]*background: var\(--warn-strong\)/, 'serious: solid');
  // The React pills (GradePill): the same marks.
  const web = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'styles', 'watchlist.css'), 'utf8');
  assert.match(web, /\.gp-ev \{[^}]*background: var\(--warn-strong\)/, 'serious: solid');
  assert.match(web, /\.gp\.ev-material \.gp-ev \{ background: transparent; box-shadow: inset 0 0 0 1\.5px var\(--warn-strong\); \}/, 'material: a ring');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'components', 'GradePill.jsx'), 'utf8'), /\$\{info\.ev \? ` ev-\$\{info\.ev\}` : ''\}/);
});

test('static: no CoinMarketCap tokens or colors, no "Inter", the serif only on the wordmark', () => {
  // The sources (the hosted views in public, the React app in web/src); the
  // built bundle in public/app is made from them.
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'app' && e.name !== 'node_modules') walk(p); } else if (/\.(css|js|jsx|html)$/.test(e.name)) files.push(p); } };
  const root = path.join(__dirname, '..');
  walk(path.join(root, 'public'));
  walk(path.join(root, 'web', 'src'));
  const all = files.map((f) => [path.relative(root, f).split(path.sep).join('/'), fs.readFileSync(f, 'utf8')]);
  for (const [f, s] of all) {
    assert.doesNotMatch(s, /--cmc-/, `${f}: a --cmc- token`);
    assert.doesNotMatch(s, /#16c784|#ea3943|#0d1421|#58667e|#eff2f5/i, `${f}: a CoinMarketCap color`);
    assert.doesNotMatch(s, /font-family:[^;]*\bInter\b/, `${f}: Inter in a font stack`);
  }
  const serif = (prefix) => all.filter(([f]) => f.startsWith(prefix) && f.endsWith('.css')).map(([, s]) => s).join('\n')
    .split('\n').filter((l) => l.includes('var(--font-serif)')).map((l) => l.trim().split(' {')[0]);
  assert.deepEqual(serif('public/'), ['.brand'], 'the serif is the wordmark\'s alone');
  assert.deepEqual(serif('web/src/').sort(), ['.boot-error h1', '.brand-word'], 'the serif is the wordmark\'s alone');
});

test('status strip and header: secondary figures step aside (Dom and Total first), what needs action keeps its words and comes first on a phone; four figures sit in one row', () => {
  const web = (...f) => fs.readFileSync(path.join(__dirname, '..', 'web', 'src', ...f), 'utf8');
  const css = web('styles', 'watchlist.css');
  const phone = css.slice(css.indexOf('@media (max-width: 767.98px)'), css.indexOf('@container (max-width: 920px)'));
  assert.match(phone, /\.ss-attn \{ order: -1;/, 'on a phone what needs action and the review queue come first');
  assert.match(phone, /\.ss-dom, \.ss-total, [^{]*\{ display: none; \}/, 'dominance and the total step aside on a phone');
  assert.doesNotMatch(phone, /\.(ss-warn|is-bad|ss-attn|ss-kinds)[^{]*\{[^}]*display: none/, 'warnings keep their words on a phone');
  const narrow = css.slice(css.indexOf('@container (max-width: 920px)'));
  assert.match(narrow, /^@container \(max-width: 920px\) \{\s*\.ss-dom, \.ss-total[,\s{]/, 'a narrower list (the inspector beside it) drops Dom and Total first');
  assert.doesNotMatch(narrow.slice(0, narrow.indexOf('}')), /ss-warn|is-bad|ss-attn|ss-kinds|ss-win/, 'warnings and each change\'s window keep their words in a narrower list');
  // Each part's accessible name keeps what a phone hides.
  const strip = web('views', 'watchlist', 'StatusStrip.jsx');
  assert.match(strip, /label=\{`Prices: \$\{m\.last_success_at \? ps\.asOf : 'not fetched yet'\}/);
  assert.match(strip, /label=\{`Needs action: \$\{critical\.map\(\(a\) => a\.title\)\.join\('; '\)\}\. Details`\}/);
  assert.match(strip, /kinds\.length === 1 \? kinds\[0\] : `\$\{critical\.length\} need action`/, 'what needs action is named in words, never a bare count');
  // The inspector's four figures in one row, the name never cut short.
  const insp = web('styles', 'inspector.css');
  assert.match(insp, /\.ih-stats \{\s*display: grid; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
  assert.match(insp, /\.ih-name \{[^}]*-webkit-line-clamp: 3/, 'the name wraps up to three lines');
  assert.doesNotMatch(insp, /\.ih-name \{[^}]*text-overflow: ellipsis/);
});

test('logos: the crisp cached image is preferred, the earlier small one serves until it arrives', () => {
  const market = require('../core/market');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-logo-'));
  const ws = { abs: (rel) => path.join(dir, rel) };
  const logos = path.join(dir, 'market-data', 'logos');
  fs.mkdirSync(logos, { recursive: true });
  fs.writeFileSync(path.join(logos, 'example-fictional.png'), 'small');
  assert.match(market.logoFile(ws, 'example-fictional').abs, /example-fictional\.png$/);
  fs.writeFileSync(path.join(logos, 'example-fictional.lg.png'), 'large');
  assert.match(market.logoFile(ws, 'example-fictional').abs, /example-fictional\.lg\.png$/);
  assert.equal(market.logoFile(ws, 'example-fictional.lg'), null, 'an id never names a file variant');
  assert.equal(market.logoFile(ws, 'nothing-here'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('attention: a possibly billed call, blocked research and recovery problems stay in view; the rest is counted', async () => {
  const { wl } = await mods;
  const items = [
    { kind: 'research_uncertain', severity: 'high', project_id: 'x', title: 'X: ChatGPT API call needs a check' },
    { kind: 'research_failed', severity: 'medium', project_id: 'x', title: 'X: Gemini research job failed' },
    { kind: 'research_incomplete', severity: 'medium', project_id: 'x', title: 'X: ChatGPT answer incomplete' },
    { kind: 'research_interrupted', severity: 'medium', project_id: 'y', title: 'Y: Cowork stopped working on its research' },
    { kind: 'writes_blocked', severity: 'high', project_id: null, title: 'Saving is blocked' },
    { kind: 'broken_record', severity: 'high', project_id: 'z', title: 'Project record z could not be read' },
    { kind: 'request_pending', severity: 'high', project_id: null, title: 'Cowork request pending for 140 min' },
    { kind: 'request_pending', severity: 'medium', project_id: null, title: 'Cowork request pending for 9 min' },
    { kind: 'review_overdue', severity: 'high', project_id: 'y', title: 'Y: review overdue' },
    { kind: 'identity', severity: 'low', project_id: 'y', title: 'Y: token identity pending' },
  ];
  const { critical, rest } = wl.splitAttention(items);
  assert.deepEqual(critical.map((a) => a.kind), ['research_uncertain', 'research_failed', 'research_incomplete', 'research_interrupted', 'writes_blocked', 'broken_record', 'request_pending']);
  assert.equal(wl.kindWord(items[2]), 'Research incomplete', 'an answer that stopped early is said apart from a failure');
  assert.deepEqual(rest.map((a) => a.kind), ['request_pending', 'review_overdue', 'identity']);
  // Each kept item says what it is in words, never only a color or an icon.
  for (const a of items) assert.match(wl.kindWord(a), /^[A-Z][a-z]+( [a-z]+)?$/, a.kind);
  assert.equal(wl.kindWord(items[0]), 'Check charge');
  assert.equal(wl.kindWord({ kind: 'portfolio_shortfall', severity: 'medium' }), 'Portfolio');
});

test('research models in brief: automatic, manual (nothing to set up), on hold, demo; the optional API is said apart', async () => {
  const { wl } = await mods;
  const manual = { mode: 'manual', reason: 'not configured: API key, model ID, token prices, a search price (or max searches 0 to turn web search off), spending budget' };
  assert.equal(wl.readinessSummary({ claude: manual, chatgpt: manual, gemini: manual }).text, 'all manual');
  assert.equal(wl.readinessSummary({ claude: manual, chatgpt: manual, gemini: manual }, { gemini: { since: '2026-10-04' } }).text, '2 manual · Gemini on hold');
  assert.equal(wl.readinessSummary({ claude: { mode: 'api' }, chatgpt: { mode: 'api' }, gemini: { mode: 'api' } }).text, 'all automatic');
  assert.equal(wl.readinessSummary({ claude: { mode: 'api' }, chatgpt: manual, gemini: { mode: 'mock' } }).text, '1 automatic · 1 manual · 1 demo');
  assert.equal(wl.readinessSummary(null).text, 'unknown');
  assert.equal(wl.readinessSummary({ claude: manual }).setup, 0, 'manual research is not a warning');
  assert.equal(wl.setupShort(manual.reason), 'Automatic: no API key (optional)');
  assert.equal(wl.setupShort('not configured: model ID, spending budget'), 'Automatic: 2 settings missing (optional)');
  assert.equal(wl.setupShort('not configured: a search price (or max searches 0 to turn web search off)'), 'Automatic: 1 setting missing (optional)', 'a comma inside parentheses is one setting');
});

test('rate-limit countdown: m:ss to the next try, h:mm:ss past an hour, "due" once passed, nothing for no time', async () => {
  const { wl } = await mods;
  const now = Date.parse('2026-10-04T18:00:00.000Z');
  assert.equal(wl.countdownText('2026-10-04T18:05:32.000Z', now), '5:32');
  assert.equal(wl.countdownText('2026-10-04T18:00:00.400Z', now), '0:01', 'a part second still counts as waiting');
  assert.equal(wl.countdownText('2026-10-04T19:02:05.000Z', now), '1:02:05');
  assert.equal(wl.countdownText('2026-10-04T17:59:00.000Z', now), 'due');
  assert.equal(wl.countdownText(null, now), null);
  assert.equal(wl.countdownText('not a time', now), null);
});

test('states: a model on hold and work held unsent are their own words; ages count calendar days in New York; anchors are the rubric\'s own words', async () => {
  const { ui } = await mods;
  assert.equal(ui.jobKey({ state: 'unconfigured', mode: 'manual' }, null, { onHold: true }), 'on_hold');
  assert.equal(ui.jobKey({ state: 'queued', mode: 'api', hold: { why: 'archived' } }), 'held');
  assert.equal(ui.RESEARCH_STATE.on_hold.short, 'On hold');
  assert.equal(ui.RESEARCH_STATE.held.short, 'Held');
  const b = ui.badgeInfo('gemini', null, { state: 'unconfigured', mode: 'manual' }, { hosted: true, onHold: true });
  assert.equal(b.kind, 'on_hold');
  assert.doesNotMatch(b.text, /Do my waiting/, 'no prompt to act for a model on hold');
  assert.equal(ui.onHoldOf({ settings: { research: { on_hold: { gemini: { since: '2026-10-04' } } } } }, 'gemini').since, '2026-10-04');
  assert.equal(ui.onHoldOf({ settings: { research: { on_hold: { gemini: null } } } }, 'gemini'), null);
  // An analysis on Oct 3 at 11 PM New York time, seen on Oct 4 at 9 AM: yesterday, not today.
  const now = Date.parse('2026-10-04T13:00:00Z');
  assert.equal(ui.daysSince('2026-10-04T03:00:00Z', now), 1);
  assert.equal(ui.fmtRelDay('2026-10-04T03:00:00Z', now), 'yesterday');
  assert.equal(ui.fmtAge('2026-10-04T03:00:00Z', now), '1d');
  assert.equal(ui.fmtRelDay('2026-10-04T12:00:00Z', now), 'today');
  assert.equal(ui.fmtRelDay('2026-10-03', now), 'yesterday');
  assert.equal(ui.daysSince('2026-09-27', now), 7);
  const anchors = [{ band: '90-100', meaning: 'Exceptional. x' }, { band: '75-89', meaning: 'Strong. x' }, { band: '60-74', meaning: 'Adequate or mixed. x' }, { band: '40-59', meaning: 'Weak. x' }, { band: '20-39', meaning: 'Poor. x' }, { band: '1-19', meaning: 'Severe. x' }];
  assert.equal(ui.anchorWord(anchors, 57.2), 'Weak');
  assert.equal(ui.anchorWord(anchors, 59.9), 'Weak', 'a value between bands keeps its lower band');
  assert.equal(ui.anchorWord(anchors, 60), 'Adequate or mixed');
  assert.equal(ui.anchorWord(anchors, 0), null, 'no word the rubric does not define');
  assert.equal(ui.anchorText(anchors, { status: 'range', low: 52.3, high: 64.7 }), 'Weak to adequate or mixed', 'a range keeps both ends, never a midpoint');
  assert.equal(ui.anchorText(anchors, { status: 'unknown' }), null);
});

test('report page: the data block is set apart from the written report, the text itself unchanged; the Archived filter lists every archived project', async () => {
  const { wl } = await mods;
  const projectView = await import(pathToFileURL(path.join(tmp, 'views', 'project.js')).href);
  const text = '# Report\n\nProse.\n\n```bash\necho not data\n```\n\nMore prose.\n\n```json\n{ "schema_version": "cr.report.v2", "verdict": "X" }\n```\n';
  const { prose, block } = projectView.splitDataBlock(text);
  assert.equal(block, '{ "schema_version": "cr.report.v2", "verdict": "X" }');
  assert.ok(prose.includes('echo not data'), 'other code blocks stay in the report');
  assert.ok(!prose.includes('schema_version'));
  assert.deepEqual(projectView.splitDataBlock('# No data block'), { prose: '# No data block', block: null });
  const base = { broken: false, name: 'X', project_id: 'x', providers: {}, research: {} };
  const f = { sector: '', owned: 'watching', coverage: 'any', ret30: 'any', archived: true };
  assert.equal(wl.matches({ ...base, status: 'archived', on_watchlist: false }, f, ''), true, 'archived and not watched: listed under Archived');
  assert.equal(wl.matches({ ...base, status: 'active', on_watchlist: true }, f, ''), false);
  assert.equal(wl.matches({ ...base, status: 'archived', on_watchlist: false }, { ...f, archived: false }, ''), false);
});

test('evidence flags: a serious flag sits beside the grade and is said in words; the grade itself is unchanged', async () => {
  const { ui } = await mods;
  const graded = (evidence, extra = {}) => ui.badgeInfo('gemini', REPORT({ status: 'firm', value: 81.4, display: '81.4', label: 'B' }, { evidence, ...extra }), null);
  const serious = graded({ flagged: 2, high: 1, medium: 1, low: 0 });
  assert.equal(serious.kind, 'grade');
  assert.equal(serious.value, '81.4', 'the number stays the calculated grade');
  assert.equal(serious.ev, 'serious');
  assert.match(serious.text, /^Gemini grade 81\.4, B, .*; 2 claims flagged by evidence checks \(1 serious\)/);
  const material = graded({ flagged: 1, high: 0, medium: 1, low: 0 });
  assert.equal(material.ev, 'material');
  assert.match(material.text, /1 claim flagged by evidence checks \(1 material\)/);
  assert.equal(graded({ flagged: 1, high: 0, medium: 0, low: 1 }).ev, null, 'a low flag (a missing date) is shown in the inspector only');
  assert.equal(graded({ flagged: 0, high: 0, medium: 0, low: 0 }).ev, null);
  assert.equal(graded(undefined).ev, null, 'an older index without evidence briefs');
  assert.equal(graded({ flagged: 1, high: 1 }, { needs_text: true }).ev, null, 'a PDF has no checked claims yet');
  const withheld = ui.badgeInfo('claude', REPORT({ status: 'withheld', coverage_pct: 55 }, { evidence: { flagged: 1, high: 1 } }), null);
  assert.equal(withheld.value, 'Withheld');
  assert.equal(withheld.ev, 'serious', 'a withheld report can be flagged too');
  assert.equal(ui.evidenceText({ flagged: 3, high: 0, medium: 2 }), '3 claims flagged by evidence checks (2 material)');
});

test('watchlist: holdings stay in Portfolio, so a saved "held" view opens on what you follow', async () => {
  const { wl } = await mods;
  const ctxWith = (saved) => ({ ui: { get: () => saved } });
  assert.equal(wl.prefs(ctxWith({ v: 2, filters: { owned: 'held' } })).filters.owned, 'watching');
  assert.equal(wl.prefs(ctxWith({ v: 2, filters: { owned: 'off' } })).filters.owned, 'off');
});

test('Add project: a listing or explorer link is searched by its slug, never saved as the website or the name', async () => {
  const { dialogs } = await mods;
  const cmc = dialogs.parseQuery('https://coinmarketcap.com/currencies/allora-network/');
  assert.equal(cmc.search, 'allora network');
  assert.equal(cmc.website, null);
  assert.equal(cmc.name, '');
  const cg = dialogs.parseQuery('https://www.coingecko.com/en/coins/allora');
  assert.equal(cg.search, 'allora');
  assert.equal(cg.listing, 'allora', 'the exact CoinGecko listing is preselected');
  assert.equal(cg.website, null);
  assert.equal(cg.name, '');
  assert.equal(dialogs.parseQuery('coingecko.com/coins/bitcoin-cash').listing, 'bitcoin-cash');
  for (const link of ['https://etherscan.io/token/0x1234567890abcdef', 'https://dexscreener.com/solana/abc123', 'https://x.com/AlloraNetwork', 'https://t.me/allora_chat', 'https://github.com/allora-network/allora-chain']) {
    const q = dialogs.parseQuery(link);
    assert.equal(q.website, null, `${link} is not the official website`);
    assert.equal(q.name, '', `${link} does not become the name`);
    assert.ok(q.note, `${link} says why`);
  }
  assert.equal(dialogs.parseQuery('https://etherscan.io/token/0x1234567890abcdef').search, null, 'an address names no project');
  assert.equal(dialogs.parseQuery('https://x.com/AlloraNetwork').search, 'AlloraNetwork');
  const site = dialogs.parseQuery('https://www.allora.network');
  assert.equal(site.website, 'https://www.allora.network/');
  assert.equal(site.search, 'allora');
  assert.equal(dialogs.parseQuery('Allora Network').search, 'Allora Network');
});

test('7-day chart: one path scaled to its box, thinned to a cap, flat through the middle, nothing for no series', async () => {
  const { ui } = await mods;
  const d = ui.sparkPath([10, 20, 15], { width: 135, height: 36, pad: 3 });
  assert.equal(d, 'M1.0 33.0L67.5 3.0L134.0 18.0', 'low at the bottom, high at the top, x across the width');
  assert.equal(ui.sparkPath([5, 5, 5], { width: 135, height: 36 }), 'M1.0 18.0L67.5 18.0L134.0 18.0', 'a flat series runs through the middle');
  assert.equal(ui.sparkPath([1]), null);
  assert.equal(ui.sparkPath(null), null);
  assert.equal(ui.sparkPath([1, 'x', 2, NaN, 3]).split('L').length, 3, 'only numbers are drawn');
  const long = Array.from({ length: 168 }, (_, i) => Math.sin(i / 9) + i / 50);
  const thin = ui.sparkPath(long, { max: 140 });
  assert.equal(thin.split('L').length, 140, 'an hourly week is thinned to the cap');
  assert.ok(thin.endsWith(`${(135 - 1).toFixed(1)} ${thin.split(' ').pop()}`), 'the last point is kept at the right edge');
});

test('the list\'s market figures: compact USD with two decimals (the shared formatter); saved columns from before start from the new layout', async () => {
  const { wl, ui } = await mods;
  assert.equal(ui.fmtMarketUsd(1.71e12), '$1.71T');
  assert.equal(ui.fmtMarketUsd(329.66e9), '$329.66B');
  assert.equal(ui.fmtMarketUsd(920e6), '$920.00M');
  assert.equal(ui.fmtMarketUsd(595620), '$595.62K');
  assert.equal(ui.fmtMarketUsd(12.5), '$12.50');
  assert.equal(ui.fmtMarketUsd(null), null);
  const store = (saved) => ({ ui: { get: () => saved, set: () => {} } });
  const old = wl.prefs(store({ v: 2, columns: ['rank', 'price', 'sector', 'research'], sort: { key: 'mcap', dir: 'desc' }, filters: { owned: 'all' } }));
  assert.deepEqual(old.columns, ['rank', 'price', 'change24h', 'change7d', 'change30d', 'mcap', 'volume', 'spark', 'research'], 'the CMC order');
  assert.deepEqual(old.sort, { key: 'mcap', dir: 'desc' }, 'the sort is kept');
  const now = wl.prefs(store({ v: 3, columns: ['spark', 'price', 'sector'], sort: { key: 'rank', dir: 'asc' }, filters: {} }));
  assert.deepEqual(now.columns, ['price', 'spark', 'sector', 'research'], 'choices made in this layout are kept, in its order');
});

test('one 0–100 spectrum on the rubric anchors, and the gauge geometry', async () => {
  const { ui } = await mods;
  assert.deepEqual([0, 15.8, 39.9, 40, 59.9, 60, 74.9, 75, 89.9, 90, 100].map(ui.scoreTier), [1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  assert.equal(ui.scoreTier(null), null);
  assert.equal(ui.scoreTier(NaN), null);
  const geo = { cx: 90, cy: 90, r: 76 };
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const [x0, y0] = ui.gaugePoint(0, geo);
  const [x50, y50] = ui.gaugePoint(50, geo);
  const [x100, y100] = ui.gaugePoint(100, geo);
  assert.ok(near(x0, 14) && near(y0, 90), '0 at the left end');
  assert.ok(near(x50, 90) && near(y50, 14), '50 at the top');
  assert.ok(near(x100, 166) && near(y100, 90), '100 at the right end');
  assert.deepEqual(ui.gaugePoint(140, geo), ui.gaugePoint(100, geo), 'clamped');
  assert.equal(ui.gaugeArc(0, 50, geo), 'M14.00 90.00A76 76 0 0 1 90.00 14.00', 'clockwise over the top');
});

test('inspector tiles: DefiLlama 30-day totals as saved, "—" with the reason otherwise; a partial month is not a total', async () => {
  const { wl } = await mods;
  const f = { state: 'fresh', slug: 'example-proto', scope: 'product', window: { start: '2026-09-04', end: '2026-10-03' }, metrics: { fees: { status: 'ok', total_30d_usd: 6.47e6, observed_subtotal_usd: 6.47e6, observed_days: 30 }, revenue: { status: 'ok', total_30d_usd: 0, observed_subtotal_usd: 0, observed_days: 30 } } };
  assert.equal(wl.fundamentalsTile(f, 'fees').text, '$6.47M');
  assert.match(wl.fundamentalsTile(f, 'fees').title, /DefiLlama product example-proto, 30 days to 2026-10-03/);
  assert.equal(wl.fundamentalsTile(f, 'revenue').text, '$0', 'a reported zero is a value');
  assert.equal(wl.fundamentalsTile({ state: 'unmapped', metrics: null }, 'fees').text, null);
  assert.match(wl.fundamentalsTile({ state: 'unmapped', metrics: null }, 'fees').title, /No DefiLlama entity is bound/);
  const partial = { ...f, metrics: { fees: { status: 'ok', total_30d_usd: null, observed_subtotal_usd: 1.2e6, observed_days: 22 } } };
  assert.equal(wl.fundamentalsTile(partial, 'fees').text, null, 'never filled in');
  assert.match(wl.fundamentalsTile(partial, 'fees').title, /22 of 30 days/);
  assert.equal(wl.fundamentalsTile({ ...f, metrics: { revenue: { status: 'unsupported', total_30d_usd: null } } }, 'revenue').text, null);
  assert.equal(wl.fundamentalsTile({ ...f, state: 'stale', age_hours: 50 }, 'fees').stale, true);
  assert.equal(wl.fundamentalsTile(null, 'fees').text, null);
});

test('contract line: GoPlus answers as Yes / No / — across the contracts, never "safe"; states without a screen say which', async () => {
  const { wl } = await mods;
  const ok = (over = {}) => ({ chain: 'ethereum', label: 'Ethereum', family: 'evm', address: '0x8408d45b61f5823298f19a09b53b7339c0280489', status: 'ok', mint: 'absent', blacklist: 'absent', proxy: 'absent', sell_tax_pct: 0, severe: [], watch: [], unknown: 0, ...over });
  const screen = (contracts, over = {}) => ({ state: 'fresh', reason: null, native_chain: false, fetched_at: '2026-10-04T22:25:49Z', age_hours: 3.2, contracts, alerts: [], last_error: null, ...over });
  const clean = wl.contractStrip(screen([ok()]));
  assert.deepEqual(clean.badges.map((b) => [b.key, b.label, b.value, b.tone]), [['mint', 'Mint', 'No', 'plain'], ['blacklist', 'Blacklist', 'No', 'plain'], ['proxy', 'Proxy', 'No', 'plain'], ['tax', 'Tax', '0%', 'plain']]);
  assert.equal(clean.age, '3h');
  assert.equal(clean.items[0].label, 'Ethereum');
  // Worst across contracts: present beats unknown beats absent; the tooltip names each.
  const mixed = wl.contractStrip(screen([ok({ proxy: 'present', mint: 'unknown' }), ok({ chain: 'base', label: 'Base', address: '0x032d86656db142138ac97d2c5c4e3766e8c0482d', mint: 'absent', proxy: 'absent', sell_tax_pct: null })]));
  const by = Object.fromEntries(mixed.badges.map((b) => [b.key, b]));
  assert.deepEqual([by.mint.value, by.mint.tone, by.proxy.value, by.proxy.tone], ['—', 'unknown', 'Yes', 'watch']);
  assert.match(by.proxy.title, /Ethereum 0x8408…0489: yes\nBase 0x032d…482d: no/);
  assert.match(by.mint.aria, /unknown \(GoPlus gave no answer\), across 2 contracts/);
  // Solana: freeze stands where a blacklist would, no proxy badge.
  const sol = wl.contractStrip(screen([ok({ chain: 'solana', label: 'Solana', family: 'solana', address: 'HUMA1821qVDKta3u2ovmfDQeW2fSQouSKE8fkF44wvGw', blacklist: 'present', proxy: null, sell_tax_pct: null })]));
  assert.deepEqual(sol.badges.map((b) => [b.key, b.label, b.value]), [['mint', 'Mint', 'No'], ['blacklist', 'Freeze', 'Yes']]);
  // Severe flags, a high sell tax and a recent change are rose.
  const bad = wl.contractStrip(screen([ok({ severe: ['Honeypot', 'Hidden owner'], sell_tax_pct: 25, mint: 'present' })], { alerts: [{ at: '2026-10-04T12:00:00Z', chain: 'ethereum', address: '0x8408d45b61f5823298f19a09b53b7339c0280489', check: 'mint', words: 'now has a mint function' }] }));
  const b2 = Object.fromEntries(bad.badges.map((b) => [b.key, b]));
  assert.deepEqual([b2.severe.label, b2.severe.value, b2.severe.tone], ['Honeypot', '+1', 'severe'], 'worst first');
  const evmOnly = wl.contractStrip(screen([ok()])).badges.find((b) => b.key === 'blacklist');
  assert.match(evmOnly.aria, /^Blacklist: no, from GoPlus$/);
  assert.deepEqual([b2.tax.value, b2.tax.tone], ['25%', 'severe']);
  assert.deepEqual([b2.alert.label, b2.alert.tone], ['Changed', 'severe']);
  assert.match(b2.alert.title, /now has a mint function/);
  // Stale shows its age as stale; a failed latest run is in the tooltip.
  const stale = wl.contractStrip(screen([ok()], { state: 'stale', age_hours: 400, last_error: 'GoPlus answered HTTP 503' }));
  assert.equal(stale.stale, true);
  assert.equal(stale.age, '17d');
  assert.match(stale.ageTitle, /Latest run failed: GoPlus answered HTTP 503/);
  // States without a screen.
  assert.equal(wl.contractStrip(screen([], { state: 'native_chain' })).text, 'Native coin');
  assert.equal(wl.contractStrip(screen([], { state: 'no_contract' })).text, 'None on record');
  assert.equal(wl.contractStrip(screen([], { state: 'identity_pending' })).text, 'Identity pending');
  const notYet = wl.contractStrip(screen([{ chain: 'base', label: 'Base', address: '0x032d86656db142138ac97d2c5c4e3766e8c0482d', status: 'not_screened' }], { state: 'pending', reason: 'Not screened yet.' }));
  assert.deepEqual([notYet.status.word, notYet.badges.length, notYet.items.length], ['Not screened yet', 0, 1]);
  assert.equal(wl.contractStrip(screen([{ chain: 'example-chain', label: 'example-chain', address: 'X', status: 'unsupported_chain' }], { state: 'unsupported' })).status.word, 'Not screenable');
  const off = wl.contractStrip(screen([{ chain: 'ethereum', label: 'Ethereum', address: '0x8408d45b61f5823298f19a09b53b7339c0280489', status: 'not_screened' }], { state: 'disabled' }));
  assert.deepEqual([off.text, off.items.length, off.status.word], [null, 1, 'Screening off'], 'turned off still shows the contract, never "None on record"');
  assert.deepEqual(wl.contractStrip(screen([], { state: 'unavailable', last_error: 'no answer within 20 s' })).status, { word: 'Screen failed', tone: 'warn', title: 'no answer within 20 s' });
  const nf = wl.contractStrip(screen([{ chain: 'ethereum', label: 'Ethereum', address: '0x1', status: 'not_found', reason: 'GoPlus has no record of this contract' }]));
  assert.deepEqual([nf.status.word, nf.badges.length], ['Not in GoPlus', 0]);
  assert.equal(wl.contractStrip(null).text, '—');
  for (const m of [clean, mixed, sol, bad, stale]) assert.ok(!JSON.stringify(m).match(/\bsafe\b/i), 'never "safe"');
});

test('contract checks: every check in words, present first, then unknown, then absent; facts and GoPlus notes as data', async () => {
  const insp = await import(pathToFileURL(path.join(tmp, 'views', 'inspector.js')).href);
  assert.equal(insp.contractChecks(null), null);
  assert.equal(insp.contractChecks({ state: 'pending', contracts: [] }), null, 'no screen, no list');
  const m = insp.contractChecks({
    state: 'fresh',
    fetched_at: '2026-10-04T22:25:49Z',
    alerts: [],
    contracts: [
      { chain: 'ethereum', label: 'Ethereum', family: 'evm', address: '0xabc', status: 'ok', checked_at: '2026-10-04T22:25:49Z', checks: { mint: 'absent', proxy: 'present', honeypot: 'unknown', hidden_owner: 'present', whitelist: 'absent' }, taxes: { buy_pct: 0, sell_pct: 5 }, owner: { state: 'renounced', address: null }, source: 'open', facts: { holder_count: 12345 }, notes: { other_potential_risks: 'FICTIONAL note', note: null } },
      { chain: 'base', label: 'Base', family: 'evm', address: '0xdef', status: 'not_found', reason: 'GoPlus has no record of this contract' },
    ],
  });
  const c = m.contracts[0];
  assert.deepEqual(c.rows.map((r) => [r.label, r.value]), [['Hidden owner', 'Yes'], ['Upgradeable proxy', 'Yes'], ['Mint function', 'No'], ['Whitelist', 'No']]);
  assert.deepEqual(c.unknown, ['Honeypot'], 'unanswered checks are named, never shown as No');
  assert.deepEqual(c.facts, [['Buy / sell tax', '0% / 5%'], ['Owner', 'Renounced', null], ['Source code', 'Open'], ['Holders', '12,345']]);
  assert.deepEqual(c.notes, ['FICTIONAL note']);
  assert.deepEqual([m.contracts[1].status, m.contracts[1].reason], ['not_found', 'GoPlus has no record of this contract']);
  const sol = insp.contractChecks({ state: 'fresh', fetched_at: '2026-10-04T22:25:49Z', contracts: [{ label: 'Solana', family: 'solana', address: 'HUMA', status: 'ok', checks: { mint: 'absent', freeze: 'absent', metadata_mutable: 'present' }, taxes: { transfer_fee_pct: null }, owner: { state: 'unknown' }, source: 'unknown', facts: {} }] });
  assert.deepEqual(sol.contracts[0].rows.map((r) => r.label), ['Metadata can change', 'Mint authority', 'Freeze authority']);
  assert.deepEqual(sol.contracts[0].facts, [['Transfer fee', '—']]);
  assert.ok(!JSON.stringify(m).match(/\bsafe\b/i));
});

test('header links from the index row: the verified contract\'s DexScreener page, else a ticker search; DefiLlama tiles only when bound', async () => {
  const { wl } = await mods;
  const dex = await import(pathToFileURL(path.join(tmp, 'views', 'dex.js')).href);
  const row = (screening, identity_status = 'verified', symbol = 'XFCT') => ({ project_id: 'example-fictional', name: 'Example (FICTIONAL)', symbol, identity_status, screening });
  const base = dex.dexLink(wl.rowProject(row({ state: 'fresh', contracts: [{ chain: 'base', label: 'Base', address: '0xba12bc7b210e61e5d3110b997a63ea216e0e18f7', status: 'ok' }] })));
  assert.equal(base.href, 'https://dexscreener.com/base/0xba12bc7b210e61e5d3110b997a63ea216e0e18f7');
  assert.equal(base.exact, true);
  const native = dex.dexLink(wl.rowProject(row({ state: 'native_chain', native_chain: true, contracts: [] }, 'verified', 'ALEO')));
  assert.equal(native.href, 'https://dexscreener.com/search?q=ALEO');
  const pending = dex.dexLink(wl.rowProject(row({ state: 'identity_pending', contracts: [] }, 'pending')));
  assert.equal(pending.href, 'https://dexscreener.com/search?q=XFCT');
  assert.equal(dex.dexLink(wl.rowProject(row(null, 'pending', null))), null, 'nothing to look up: no link at all');
  // The same contracts from the row and from the full record make the same card key.
  const fromRow = dex.dexTargets(wl.rowProject(row({ state: 'fresh', contracts: [{ chain: 'ethereum', address: '0x0000000000000000000000000000000000000ab1', status: 'ok' }, { chain: 'bsc', address: '0x0000000000000000000000000000000000000ab2', status: 'ok' }] })));
  const fromRecord = dex.dexTargets({ project_id: 'example-fictional', symbol: 'XFCT', identity: { status: 'verified', assets: [{ chain: 'ethereum', chain_id: '1', contract_address: '0x0000000000000000000000000000000000000ab1' }, { chain: 'bsc', chain_id: '56', contract_address: '0x0000000000000000000000000000000000000ab2' }] } });
  assert.deepEqual(fromRow.targets.map((x) => x.key), fromRecord.targets.map((x) => x.key));
  assert.equal(wl.defillamaBound({ state: 'unmapped' }), false);
  assert.equal(wl.defillamaBound({ state: 'disabled' }), false);
  assert.equal(wl.defillamaBound(null), false);
  assert.equal(wl.defillamaBound({ state: 'fresh' }), true);
  assert.equal(wl.defillamaBound({ state: 'pending' }), true);
});

test('market figures: a missing or zero market cap, FDV or volume is unknown ("—" with its reason), never $0, in every view', async () => {
  const { ui, wl } = await mods;
  const bm = await import(pathToFileURL(path.join(tmp, 'brief-model.js')).href);
  for (const v of [0, null, undefined, Number.NaN, Infinity, -5]) assert.equal(ui.fmtMarketFigure(v), null, `${v} is unknown`);
  assert.equal(ui.fmtMarketFigure(54e6), '$54.00M');
  assert.equal(ui.fmtMarketFigure(54e6, ui.fmtCompactUsd), '$54.0M', 'the project page keeps its own format, under the same rule');
  assert.equal(ui.marketFigureReason('Market cap', 0), 'Market cap unknown: the data source reported 0');
  assert.equal(ui.marketFigureReason('FDV', null), 'FDV unknown: not reported by the data source');
  assert.equal(ui.fmtMarketUsd(0), '$0.00', "a report's own USD metric of 0 stays a real $0");
  // The list and the side panel (marketStrings), FDV/MC included.
  const zero = { price_usd: 0.061, market_cap_usd: 0, fdv_usd: 0, volume_24h_usd: 0 };
  const s = wl.marketStrings(zero);
  assert.deepEqual([s.mcap, s.fdv, s.volume, s.fdvMc], [null, null, null, null]);
  assert.equal(wl.marketStrings({ ...zero, fdv_usd: 61e6 }).fdvMc, null, 'no ratio over a zero market cap');
  assert.equal(wl.marketStrings({ ...zero, market_cap_usd: 12.4e6 }).fdvMc, null, 'no ratio from a zero FDV');
  // A zero sorts with the unknowns: last, both ways.
  const rows = [ROW('Zero', MKT({ market_cap_usd: 0 })), ROW('Big', MKT({ market_cap_usd: 9e8 })), ROW('Small', MKT({ market_cap_usd: 3e6 }))];
  assert.deepEqual(wl.sortRows(rows, { key: 'mcap', dir: 'asc' }).map((r) => r.name), ['Small', 'Big', 'Zero']);
  assert.deepEqual(wl.sortRows(rows, { key: 'mcap', dir: 'desc' }).map((r) => r.name), ['Big', 'Small', 'Zero']);
  // The Brief's market line.
  const now = bm.marketNow({ market: { status: 'fresh', price_usd: 0.061, market_cap_usd: 0, volume_24h_usd: 4e5 } });
  assert.equal(now.mcap, null);
  assert.equal(now.mcap_usd, 0, 'the source value is kept for the reason');
  assert.equal(now.volume, '$400.00K');
  // Every view goes through the rule, never a bare typeof check.
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
  const web = (f) => fs.readFileSync(path.join(__dirname, '..', 'web', 'src', ...f.split('/')), 'utf8');
  for (const f of ['views/watchlist/ProjectTable.jsx', 'views/inspector/Inspector.jsx', 'views/project/ProjectPage.jsx']) {
    assert.doesNotMatch(web(f), /typeof m\.(market_cap_usd|fdv_usd|volume_24h_usd) === 'number'/, f);
  }
  assert.doesNotMatch(src('watchlist-model.js'), /typeof m\.(market_cap_usd|fdv_usd|volume_24h_usd) === 'number'/);
  assert.match(web('components/figures.jsx'), /marketFigureReason\(label, value\)/, 'an unknown figure says why');
  assert.doesNotMatch(src('views/project.js'), /fmtCompactUsd\(m\.(fdv_usd|volume_24h_usd)\)\]/);
  // The market now is the project page's header (2026-10-07), from the same rule.
  assert.match(src('views/project.js'), /unknownFigure\('Market cap', mk\.mcap_usd\)/);
});

test('a model on hold: its brief offers no run and reads On hold; the routes table says On hold; saved pills are untouched', async () => {
  const { wl } = await mods;
  const research = await import(pathToFileURL(path.join(tmp, 'views', 'research.js')).href);
  const bm = await import(pathToFileURL(path.join(tmp, 'brief-model.js')).href);
  const hold = { since: '2026-10-04', reason: 'paused' };
  // The project page's Brief tab, for a model with no report (D1 replaced the Overview's cards).
  const d = { project: { status: 'active' }, reports: [] };
  const none = { status: 'none', own: [] };
  const held = { settings: { research: { on_hold: { gemini: hold } } } };
  const e = bm.emptyOf(none, { d, row: null, index: held, provider: 'gemini' });
  assert.equal(e.can_run, false, 'a model on hold offers no run');
  assert.ok(e.hold, 'and says it is on hold');
  assert.equal(bm.emptyOf(none, { d, row: null, index: held, provider: 'claude' }).can_run, true, 'a model not on hold still offers its run');
  const queued = { research: { providers: { gemini: { state: 'queued', run_id: 'r1' } } } };
  assert.equal(bm.emptyOf(none, { d, row: queued, index: held, provider: 'gemini' }).can_run, false, 'a kept job: no new run');
  const manual = { mode: 'manual', missing: ['API key'] };
  const w = research.routeWords(held, 'gemini', manual, { hosted: true });
  assert.equal(w.route, 'On hold');
  assert.match(w.happens, /^On hold on this desk since 2026-10-04: nothing new is assigned to Gemini\./);
  assert.doesNotMatch(w.happens, /paste|prompt|import the answer|API|assistant/i, 'no way to run it');
  assert.equal(w.setup, null, 'no setup is offered for a held model');
  // Manual research is ready, never a warning; the optional API is a quiet second line.
  const c = research.routeWords(held, 'claude', manual, { hosted: true });
  assert.equal(c.route, 'Manual · ready through its assistant');
  assert.equal(c.tone, '');
  assert.equal(c.setup, 'Automatic route (optional): not set up (API key)');
  assert.doesNotMatch(c.happens, /No API/);
  assert.match(c.happens, /^Each run waits for you: In Cowork, say: "Do my waiting CryptoResearch research"\. Claude researches under its own plan .* Nothing is billed here\.$/);
  assert.equal(research.routeWords(held, 'chatgpt', manual).route, 'Manual · ready by paste and import');
  assert.deepEqual([research.routeWords(held, 'chatgpt', { mode: 'api', model: 'FICTIONAL-model' }).route, research.routeWords(held, 'chatgpt', { mode: 'api', model: 'FICTIONAL-model' }).tone], ['Automatic (API) · FICTIONAL-model', 'ok']);
  // Saved reports keep their pills (unchanged rule).
  const index = { settings: { research: { on_hold: { gemini: hold } } } };
  assert.equal(wl.holdCell(index, 'gemini', { grade: { status: 'firm', value: 67, display: '67.0' } }).dash, false);
});

test('one page per project (D1): every former project tab and the Brief page redirect to the new home; the Brief\'s former folds land on Compare and Evidence (2026-10-07)', async () => {
  const project = await import(pathToFileURL(path.join(tmp, 'views', 'project.js')).href);
  const go = (name, args, qs = '') => project.projectRedirect(name, args, new URLSearchParams(qs));
  const P = 'p1';
  assert.equal(go('project', [P]), '#/project/p1/brief');
  assert.equal(go('project', [P, 'overview']), '#/project/p1/brief');
  assert.equal(go('project', [P, 'scorecards'], 'provider=chatgpt'), '#/project/p1/brief?model=chatgpt&open=scorecard');
  assert.equal(go('project', [P, 'reports'], 'report=r1'), '#/project/p1/report?report=r1');
  assert.equal(go('project', [P, 'comparison']), '#/project/p1/compare');
  assert.equal(go('project', [P, 'research'], 'run=run1'), '#/project/p1/evidence?open=runs&run=run1');
  // The Brief's former folds, by their old addresses.
  assert.equal(go('project', [P, 'brief'], 'open=compare'), '#/project/p1/compare');
  assert.equal(go('project', [P, 'brief'], 'model=chatgpt&open=evidence'), '#/project/p1/evidence?model=chatgpt&open=claims');
  assert.equal(go('project', [P, 'brief'], 'open=runs&run=run1'), '#/project/p1/evidence?open=runs&run=run1');
  assert.equal(go('project', [P, 'brief'], 'run=run1'), '#/project/p1/evidence?open=runs&run=run1');
  assert.equal(go('project', [P, 'brief'], 'open=identity'), '#/project/p1/evidence?open=identity');
  assert.equal(go('project', [P, 'brief'], 'model=chatgpt&open=scorecard'), null, 'the scorecard stays on the Overview');
  assert.equal(go('project', [P, 'history']), '#/project/p1/notes');
  assert.equal(go('brief', [P]), '#/project/p1/brief?model=claude');
  assert.equal(go('brief', [P], 'report=r2'), '#/project/p1/brief?model=claude&report=r2');
  // The new tabs stay where they are.
  for (const t of ['brief', 'compare', 'evidence', 'report', 'market', 'notes']) assert.equal(go('project', [P, t]), null);
  assert.equal(go('project', [P, 'nonsense']), '#/project/p1/brief');
});
