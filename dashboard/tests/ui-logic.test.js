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
    [null, null, 'none', 'None'],
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
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
  assert.match(root, /color-scheme: light/, 'the default palette is the light one');
  assert.match(css, /:root\[data-theme="dark"\] \{[^}]*color-scheme: dark/, 'dark stays available');
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

test('research models in brief: automatic, setup required (with the missing key named), demo', async () => {
  const { wl } = await mods;
  const manual = { mode: 'manual', reason: 'not configured: API key, model ID, token prices, a search price (or max searches 0 to turn web search off), spending budget' };
  assert.equal(wl.readinessSummary({ claude: manual, chatgpt: manual, gemini: manual }).text, '3 need setup');
  assert.equal(wl.readinessSummary({ claude: { mode: 'api' }, chatgpt: { mode: 'api' }, gemini: { mode: 'api' } }).text, 'all automatic');
  assert.equal(wl.readinessSummary({ claude: { mode: 'api' }, chatgpt: manual, gemini: { mode: 'mock' } }).text, '1 automatic · 1 needs setup · 1 demo');
  assert.equal(wl.readinessSummary(null).text, 'unknown');
  assert.equal(wl.setupShort(manual.reason), 'Setup required: no API key');
  assert.equal(wl.setupShort('not configured: model ID, spending budget'), 'Setup required: 2 settings missing');
  assert.equal(wl.setupShort('not configured: a search price (or max searches 0 to turn web search off)'), 'Setup required: 1 setting missing', 'a comma inside parentheses is one setting');
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
