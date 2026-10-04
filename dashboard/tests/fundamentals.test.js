'use strict';
// DefiLlama fundamentals (core/fundamentals.js): the explicit binding, the
// 30-day window and its coverage, failures and the shared lease, gate and
// backoff, and the evidence packet each new research run freezes. Every
// DefiLlama answer here is a stub with FICTIONAL numbers, the clock is fixed
// where dates matter, and global fetch is replaced by one that fails, so
// nothing is ever sent anywhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { tempWorkspace } = require('./helpers');
const fundamentals = require('../core/fundamentals');
const projects = require('../core/projects');
const research = require('../core/research');
const jobs = require('../core/jobs');
const prompts = require('../core/prompts');
const ops = require('../core/ops');
const { checkBinding } = require('../core/binding');
const { buildIndex, projectDetail } = require('../core/indexer');
const { readJson, jsonText, atomicWrite } = require('../core/fsx');

const NOW = Date.parse('2026-10-04T15:00:00Z'); // window: 2026-09-04 to 2026-10-03
const HOUR = 3600000;
const DAY = 86400000;
const FAST = { retryDelayMs: 0, pauseMs: 0 };
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const BIND = { slug: 'example-lend', scope: 'product', source_url: 'https://defillama.com/protocol/example-lend' };

function workspace(t, label, settings = {}) {
  const { ws, root, cleanup } = tempWorkspace(label, settings);
  t.after(cleanup);
  // Nothing in these tests may reach the network.
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network access is not allowed in tests');
  });
  return { ws, root };
}

function addProject(ws, { name = 'Example Lend (FICTIONAL)', symbol = 'XLND', bind = null, extra = {} } = {}) {
  const host = `${symbol.toLowerCase()}.example`;
  const out = projects.addProject(ws, {
    name,
    symbol,
    official_website: `https://${host}/`,
    coingecko_id: `${symbol.toLowerCase()}-fictional`,
    evidence: [{ url: `https://${host}/docs`, note: 'fictional test evidence' }],
    sector: 'defi',
    ...(bind ? { defillama: bind } : {}),
    ...extra,
  });
  assert.equal(out.status, 'created', out.message);
  return out.project_id;
}

const point = (date, v) => [Date.parse(`${date}T00:00:00Z`) / 1000, v];
const windowOf = (nowMs = NOW) => {
  const today = Math.floor(nowMs / DAY) * DAY;
  return Array.from({ length: 30 }, (_, i) => new Date(today - (30 - i) * DAY).toISOString().slice(0, 10));
};
// One point for every day of the window ending the day before nowMs.
const full = (v, nowMs = NOW) => windowOf(nowMs).map((d, i) => point(d, typeof v === 'function' ? v(i, d) : v));

// A DefiLlama /summary/fees answer. Its own totals are deliberately wrong:
// the desk computes its window from the daily series and never uses them.
function body({ slug = 'example-lend', name = 'Example Lend', defillamaId = '9001', protocolType = 'protocol', parentProtocol = null, childProtocols = undefined, methodology = { Fees: 'Interest paid by borrowers (fictional).', Revenue: 'The share of interest the treasury keeps (fictional).', HoldersRevenue: 'Buybacks for token holders (fictional).' }, chart = [] } = {}) {
  return {
    name,
    displayName: name,
    slug,
    defillamaId,
    protocolType,
    parentProtocol,
    ...(childProtocols ? { childProtocols } : {}),
    methodology,
    methodologyURL: methodology ? `https://github.com/DefiLlama/dimension-adapters/blob/master/fees/${slug}.ts` : null,
    gecko_id: 'xlnd-fictional',
    total24h: 1,
    total30d: 999999,
    totalDataChart: chart,
  };
}

const reply = (status, payload, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => (headers[String(k).toLowerCase()] === undefined ? null : headers[String(k).toLowerCase()]) },
  text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
});
const ok = (b) => reply(200, b);
const notFound = (slug = 'example-lend') => reply(400, `Fees for ${slug} not found, please visit /overview/fees to see available protocols`);

// A stub for DefiLlama: answers by data type (an answer, a function, or an
// Error to throw), and keeps every URL it was asked for.
function llama(byType) {
  const calls = [];
  const f = async (url, init) => {
    calls.push(url);
    const type = new URL(url).searchParams.get('dataType');
    const a = typeof byType[type] === 'function' ? await byType[type](url, init, calls) : byType[type];
    if (a instanceof Error) throw a;
    return a || notFound();
  };
  f.calls = calls;
  return f;
}

const good = (fees, revenue, holders, opts = {}) => llama({
  dailyFees: ok(body({ ...opts, chart: fees })),
  dailyRevenue: ok(body({ ...opts, chart: revenue })),
  dailyHoldersRevenue: ok(body({ ...opts, chart: holders })),
});

const block = (ws, id, now = NOW) => fundamentals.packetBlock(ws, projects.getProject(ws, id), { now });

// Every key in a block, at any depth.
function keysOf(v, out = new Set()) {
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
  return out;
}

test('a bound product with all three series over the whole window: 30-day totals from the daily points, every day kept, DefiLlama\'s definitions and the exact requests', async (t) => {
  const { ws } = workspace(t, 'fund-complete');
  const id = addProject(ws, { bind: BIND });
  const f = llama({
    // A day before the window and the day in progress are in the answer too.
    dailyFees: ok(body({ chart: [point('2026-08-01', 5), ...full((i) => 1000 + i), point('2026-10-04', 777)] })),
    dailyRevenue: ok(body({ chart: full(100.25) })),
    dailyHoldersRevenue: ok(body({ chart: full(10) })),
  });
  const r = await fundamentals.refresh(ws, { fetchImpl: f, now: NOW, ...FAST });
  assert.equal(r.status, 'ok', r.message);
  assert.deepEqual(r.refreshed, [id]);
  assert.deepEqual(f.calls, [
    'https://api.llama.fi/summary/fees/example-lend?dataType=dailyFees&excludeTotalDataChartBreakdown=true',
    'https://api.llama.fi/summary/fees/example-lend?dataType=dailyRevenue&excludeTotalDataChartBreakdown=true',
    'https://api.llama.fi/summary/fees/example-lend?dataType=dailyHoldersRevenue&excludeTotalDataChartBreakdown=true',
  ]);

  const b = block(ws, id);
  assert.equal(b.state, 'fresh');
  assert.equal(b.reason, null);
  assert.deepEqual(b.binding, { slug: 'example-lend', scope: 'product', scope_meaning: fundamentals.SCOPES.product, source_url: 'https://defillama.com/protocol/example-lend', verified_at: b.binding.verified_at, verified_by: 'test' });
  assert.deepEqual([b.window.start, b.window.end, b.window.days, b.window.starts_at, b.window.ends_before], ['2026-09-04', '2026-10-03', 30, '2026-09-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z']);
  assert.equal(b.fetched_at, '2026-10-04T15:00:00.000Z');
  assert.equal(b.latest_observation_date, '2026-10-03');
  // 30 x 1000 + (0 + 1 + ... + 29); DefiLlama's own total30d (999999) is not used.
  assert.equal(b.fees_30d_usd, 30435);
  assert.equal(b.revenue_30d_usd, 3007.5);
  assert.equal(b.holders_revenue_30d_usd, 300);
  const fees = b.metrics.fees;
  assert.deepEqual([fees.status, fees.total_30d_usd, fees.observed_subtotal_usd, fees.reason], ['complete', 30435, null, null]);
  assert.equal(Object.keys(fees.daily).length, 30);
  assert.equal(fees.daily['2026-09-04'], 1000);
  assert.equal(fees.daily['2026-10-03'], 1029);
  assert.equal(fees.daily['2026-10-04'], undefined, 'the day in progress is left out');
  assert.equal(fees.daily['2026-08-01'], undefined, 'a day before the window is not in it');
  assert.deepEqual(fees.coverage, { expected_days: 30, observed_days: 30, missing_dates: [], conflicting_dates: [], history_starts: '2026-08-01', latest_observation_date: '2026-10-03' });
  assert.equal(fees.definition, 'Interest paid by borrowers (fictional).');
  assert.equal(b.metrics.revenue.definition, 'The share of interest the treasury keeps (fictional).');
  assert.equal(b.metrics.holders_revenue.definition, 'Buybacks for token holders (fictional).');
  assert.equal(b.metrics.revenue.source_url, f.calls[1]);
  assert.equal(b.entity.reported_scope, 'product');
  assert.equal(b.entity.methodology_url, 'https://github.com/DefiLlama/dimension-adapters/blob/master/fees/example-lend.ts');
  assert.match(b.note, /three separate DefiLlama measurements/);
  assert.match(b.note, /revenue is not net profit/);
  assert.match(b.note, /does not necessarily accrue to the token/);
  assert.equal(b.token_link_note, undefined, 'DefiLlama links the entity to this project\'s own CoinGecko ID');
  // No valuation ratio of any kind.
  for (const k of keysOf(b)) assert.ok(!/ratio|multiple|price_to|valuation/i.test(k), `no ratio field (${k})`);
  // Every request is counted once; all three were answered.
  const st = fundamentals.readStatus(ws);
  assert.deepEqual([st.calls.month_count, st.calls.month_answered, st.last_run.status], [3, 3, 'ok']);
});

test('a reported zero stays zero next to positive fees; legitimate negative days stay negative and are summed as reported', async (t) => {
  const { ws } = workspace(t, 'fund-zero-neg');
  const id = addProject(ws, { bind: BIND });
  const r = await fundamentals.refresh(ws, { fetchImpl: good(full((i) => (i % 2 ? -100 : 40)), full(0), full(0)), now: NOW, ...FAST });
  assert.equal(r.status, 'ok', r.message);
  const b = block(ws, id);
  assert.equal(b.revenue_30d_usd, 0, 'zero revenue is a reported zero, not unknown');
  assert.equal(b.metrics.revenue.status, 'complete');
  assert.equal(b.metrics.revenue.daily['2026-09-20'], 0);
  assert.equal(b.holders_revenue_30d_usd, 0);
  // 15 x 40 + 15 x (-100): never clamped.
  assert.equal(b.fees_30d_usd, -900);
  assert.equal(b.metrics.fees.daily['2026-09-05'], -100);
  assert.equal(b.metrics.fees.status, 'complete');
});

test('an unmapped project gets no fundamentals and says so; nothing is fetched and its research packet records why', async (t) => {
  const { ws, root } = workspace(t, 'fund-unmapped');
  const id = addProject(ws);
  const f = llama({});
  const r = await fundamentals.refresh(ws, { fetchImpl: f, now: NOW, ...FAST });
  assert.equal(r.status, 'noop');
  assert.equal(f.calls.length, 0);
  const b = block(ws, id);
  assert.deepEqual([b.state, b.binding, b.metrics], ['unmapped', null, undefined]);
  assert.match(b.reason, /No DefiLlama entity is bound to this project/);
  assert.equal(fundamentals.isDue(ws, NOW), false);
  const run = research.createRun(ws, { project_id: id, providers: ['claude'] });
  const packet = readJson(path.join(root, run.run.evidence_packet.path));
  assert.equal(packet.schema_version, 'cr.evidence-packet.v2');
  assert.equal(packet.fundamentals.state, 'unmapped');
  assert.equal(run.run.evidence_packet.fundamentals_state, 'unmapped');
});

test('an unsupported holders-revenue series (HTTP 400) is marked unsupported and leaves fees and revenue as reported', async (t) => {
  const { ws } = workspace(t, 'fund-unsupported');
  const id = addProject(ws, { bind: BIND });
  const f = llama({ dailyFees: ok(body({ chart: full(5) })), dailyRevenue: ok(body({ chart: full(1) })), dailyHoldersRevenue: notFound() });
  const r = await fundamentals.refresh(ws, { fetchImpl: f, now: NOW, ...FAST });
  assert.equal(r.status, 'ok', r.message);
  const b = block(ws, id);
  assert.deepEqual([b.fees_30d_usd, b.revenue_30d_usd, b.holders_revenue_30d_usd], [150, 30, null]);
  const h = b.metrics.holders_revenue;
  assert.deepEqual([h.status, h.http_status, h.total_30d_usd, h.daily], ['unsupported', 400, null, {}]);
  assert.match(h.reason, /^DefiLlama does not publish dailyHoldersRevenue for this entity \(HTTP 400: "Fees for example-lend not found/);
  assert.equal(fundamentals.readStatus(ws).calls.month_answered, 3, 'a 400 is a definite answer');
});

test('a newly launched protocol, a missing day and a day not yet published: partial with an observed subtotal, never a filled zero; no day in the window is unknown', async (t) => {
  const { ws } = workspace(t, 'fund-partial');
  const id = addProject(ws, { bind: BIND });
  const days = windowOf();
  const launched = days.slice(21).map((d) => point(d, 10)); // from 2026-09-25: nine days
  const gap = full(2).filter(([ts]) => new Date(ts * 1000).toISOString().slice(0, 10) !== '2026-09-15');
  const lagging = full(1).filter(([ts]) => new Date(ts * 1000).toISOString().slice(0, 10) !== '2026-10-03');
  const r = await fundamentals.refresh(ws, { fetchImpl: good(launched, gap, lagging), now: NOW, ...FAST });
  assert.equal(r.status, 'ok', r.message);
  const b = block(ws, id);
  assert.deepEqual([b.fees_30d_usd, b.revenue_30d_usd, b.holders_revenue_30d_usd], [null, null, null], 'no 30-day total without 30 reported days');

  const fees = b.metrics.fees;
  assert.deepEqual([fees.status, fees.total_30d_usd, fees.observed_subtotal_usd], ['partial', null, 90]);
  assert.equal(fees.observed_subtotal_note, 'The sum of the 9 reported day(s) only; not a 30-day total.');
  assert.deepEqual([fees.coverage.observed_days, fees.coverage.missing_dates.length, fees.coverage.history_starts], [9, 21, '2026-09-25']);
  assert.match(fees.reason, /DefiLlama's series starts on 2026-09-25, so fewer than 30 completed days exist/);
  assert.equal(fees.daily['2026-09-24'], undefined, 'a day before launch is absent, not zero');

  const rev = b.metrics.revenue;
  assert.deepEqual([rev.status, rev.observed_subtotal_usd, rev.coverage.missing_dates], ['partial', 58, ['2026-09-15']]);
  assert.match(rev.reason, /no value for 1 day\(s\) inside the window: 2026-09-15/);
  assert.ok(!('2026-09-15' in rev.daily), 'the missing day is not filled');

  const hold = b.metrics.holders_revenue;
  assert.deepEqual([hold.status, hold.observed_subtotal_usd, hold.coverage.latest_observation_date], ['partial', 29, '2026-10-02']);
  assert.match(hold.reason, /no value yet for 2026-10-03 \(the latest reported day is 2026-10-02\)/);

  // A series that ended before the window: unknown, no number at all.
  const old = llama({ dailyFees: ok(body({ chart: [point('2026-07-01', 3), point('2026-08-01', 4)] })), dailyRevenue: ok(body({ chart: [] })), dailyHoldersRevenue: ok(body({ chart: full(1) })) });
  await fundamentals.refresh(ws, { fetchImpl: old, now: NOW, force: true, ...FAST });
  const b2 = block(ws, id);
  assert.deepEqual([b2.metrics.fees.status, b2.metrics.fees.total_30d_usd, b2.metrics.fees.observed_subtotal_usd], ['unknown', null, null]);
  assert.match(b2.metrics.fees.reason, /DefiLlama's latest reported day is 2026-08-01, before the window/);
  assert.match(b2.metrics.revenue.reason, /DefiLlama reports no completed day for this metric/);
  assert.equal(b2.holders_revenue_30d_usd, 30);
});

test('duplicates are counted once, conflicting duplicates are left out, malformed, non-finite and future rows are ignored and named', async (t) => {
  const { ws } = workspace(t, 'fund-dirty');
  const id = addProject(ws, { bind: BIND });
  const msDay = Date.parse('2026-09-13T00:00:00Z');
  const chart = [
    ...full(10),
    point('2026-09-10', 10), // the same value again: once
    point('2026-09-11', 99), // a different value for a reported day: left out
    [1789000000.5, 3], // not a whole second
    [1789000001, 3], // not a day start
    ['2026-09-12', 3], // not a timestamp
    [msDay, 3], // milliseconds, not seconds
    'garbage',
    point('2026-09-14', null), // no number
    point('2026-09-14', '12'), // a string, not a number
    point('2026-10-06', 5), // after the current day
  ];
  const r = await fundamentals.refresh(ws, { fetchImpl: good(chart, full(1), full(1)), now: NOW, ...FAST });
  assert.equal(r.status, 'ok', r.message);
  const fees = block(ws, id).metrics.fees;
  assert.equal(fees.status, 'partial');
  assert.equal(fees.observed_subtotal_usd, 290, '29 days of 10: the conflicting day is out, the repeat counted once');
  assert.deepEqual(fees.coverage.conflicting_dates, ['2026-09-11']);
  assert.deepEqual(fees.coverage.missing_dates, ['2026-09-11']);
  assert.equal(fees.daily['2026-09-14'], 10, 'the valid point for that day is kept');
  assert.deepEqual(fees.issues, [
    '5 row(s) with an unreadable or misaligned timestamp were ignored',
    '2 row(s) without a finite number were ignored',
    '1 row(s) dated after the current day were ignored',
    '1 repeated row(s) with the same value were counted once',
    '1 date(s) reported twice with different values were left out',
  ]);
  assert.match(fees.reason, /1 day\(s\) left out because DefiLlama reported two different values: 2026-09-11/);
});

test('a timeout is retried once, a 5xx retry can succeed; a failed refresh keeps the last good snapshot with its age and the failure, counts every request and backs off', async (t) => {
  const { ws } = workspace(t, 'fund-fail');
  const id = addProject(ws, { bind: BIND });
  // The first try of fees answers 503, the retry answers.
  let first = true;
  const flaky = llama({
    dailyFees: () => {
      if (first) {
        first = false;
        return reply(503, 'busy');
      }
      return ok(body({ chart: full(7) }));
    },
    dailyRevenue: ok(body({ chart: full(1) })),
    dailyHoldersRevenue: ok(body({ chart: full(0) })),
  });
  const r1 = await fundamentals.refresh(ws, { fetchImpl: flaky, now: NOW, ...FAST });
  assert.equal(r1.status, 'ok', r1.message);
  assert.equal(flaky.calls.length, 4, 'one retry');
  assert.deepEqual([fundamentals.readStatus(ws).calls.month_count, fundamentals.readStatus(ws).calls.month_answered], [4, 3]);

  // Thirteen hours later DefiLlama does not answer at all.
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  const down = llama({ dailyFees: timeout, dailyRevenue: timeout, dailyHoldersRevenue: timeout });
  const later = NOW + 13 * HOUR;
  const r2 = await fundamentals.refresh(ws, { fetchImpl: down, now: later, ...FAST });
  assert.equal(r2.status, 'failed');
  assert.equal(down.calls.length, 2, 'two attempts, then the refresh stops for this project');
  assert.match(r2.message, /dailyFees: no answer within 20 s \(after 2 attempts\)/);
  const b = block(ws, id, later);
  assert.equal(b.state, 'fresh_last_failed');
  assert.equal(b.fees_30d_usd, 210, 'the last good snapshot is kept');
  assert.equal(b.age_hours, 13);
  assert.equal(b.last_refresh_failure.outcome, 'failed');
  assert.match(b.reason, /^The latest refresh failed \(dailyFees: no answer within 20 s \(after 2 attempts\)\); this is the snapshot fetched 2026-10-04T15:00:00.000Z\.$/);
  const st = fundamentals.readStatus(ws);
  assert.deepEqual([st.calls.month_count, st.calls.month_answered, st.consecutive_failures, st.last_run.status], [6, 3, 1, 'failed']);
  assert.ok(Date.parse(st.next_allowed_at) > later, 'scheduled refreshes back off');
  assert.equal(fundamentals.isDue(ws, later + 60000), false);
  assert.equal((await fundamentals.refresh(ws, { fetchImpl: down, now: later + 60000, ...FAST })).status, 'backoff');
  assert.equal(down.calls.length, 2, 'nothing sent while backing off');
  assert.equal(fundamentals.overview(ws, later).last_run.status, 'failed', 'never shown as healthy after a failure');

  // Past the stale age the same snapshot is stale, still with the failure.
  const stale = block(ws, id, NOW + 40 * HOUR);
  assert.equal(stale.state, 'stale');
  assert.match(stale.reason, /^The saved snapshot is 40 h old, older than 36 h\. The latest refresh failed: dailyFees: no answer within 20 s/);
  assert.equal(stale.fees_30d_usd, 210);
});

test('a 429 closes the gate for its valid Retry-After, nothing is sent until it passes (forced or scheduled), and an invalid Retry-After waits the default', async (t) => {
  const { ws } = workspace(t, 'fund-429');
  const id = addProject(ws, { bind: BIND });
  await fundamentals.refresh(ws, { fetchImpl: good(full(1), full(1), full(1)), now: NOW, ...FAST });
  const limited = llama({ dailyFees: reply(429, 'slow down', { 'retry-after': '120' }) });
  const t1 = NOW + 13 * HOUR;
  const r = await fundamentals.refresh(ws, { fetchImpl: limited, now: t1, force: true, ...FAST });
  assert.equal(r.status, 'failed');
  assert.equal(r.rate_limited, true);
  assert.equal(r.retry_at, new Date(t1 + 120000).toISOString());
  assert.equal(limited.calls.length, 1, 'a 429 is not retried');
  const st = fundamentals.readStatus(ws);
  assert.deepEqual([st.rate_limit.retry_after_ms, st.rate_limit.wait_ms, st.rate_limit.strikes], [120000, 120000, 1]);
  assert.equal(st.consecutive_failures, 0, 'a rate limit has its own gate, not the failure backoff');

  const again = await fundamentals.refresh(ws, { fetchImpl: limited, now: t1 + 30000, force: true, ...FAST });
  assert.deepEqual([again.status, again.rate_limited], ['backoff', true], 'forcing never skips a rate limit');
  assert.equal(fundamentals.isDue(ws, t1 + 30000), false);
  assert.equal(limited.calls.length, 1);
  assert.equal(block(ws, id, t1 + 30000).fees_30d_usd, 30, 'the last good snapshot stays');

  const back = await fundamentals.refresh(ws, { fetchImpl: good(full(2, t1), full(2, t1), full(2, t1)), now: t1 + 3 * 60000, force: true, ...FAST });
  assert.equal(back.status, 'ok', back.message);
  assert.equal(block(ws, id, t1 + 3 * 60000).fees_30d_usd, 60);

  // An unreadable Retry-After: the default wait (ten minutes), never shorter.
  const vague = llama({ dailyFees: reply(429, '', { 'retry-after': 'soon' }) });
  const t2 = t1 + 2 * HOUR;
  await fundamentals.refresh(ws, { fetchImpl: vague, now: t2, force: true, ...FAST });
  const st2 = fundamentals.readStatus(ws);
  assert.deepEqual([st2.rate_limit.retry_after_ms, st2.rate_limit.wait_ms], [null, 600000]);
});

test('concurrent refreshes do one fetch: the second finds the shared lease (also through the job runner); a lease left by a dead or restarted process is taken over', async (t) => {
  const { ws, root } = workspace(t, 'fund-lease');
  const id = addProject(ws, { bind: BIND });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = llama({
    dailyFees: async () => {
      await gate;
      return ok(body({ chart: full(3) }));
    },
    dailyRevenue: ok(body({ chart: full(1) })),
    dailyHoldersRevenue: ok(body({ chart: full(1) })),
  });
  const running = fundamentals.refresh(ws, { fetchImpl: slow, now: NOW, ...FAST });
  const second = llama({});
  const r2 = await fundamentals.refresh(ws, { fetchImpl: second, now: NOW, force: true, ...FAST });
  assert.equal(r2.status, 'busy');
  assert.equal(second.calls.length, 0, 'no duplicate work');
  const viaJob = await jobs.runJob(ws, 'fundamentals', { trigger: 'test' });
  assert.equal(viaJob.status, 'busy', 'the scheduled route shares the lease');
  release();
  const r1 = await running;
  assert.equal(r1.status, 'ok', r1.message);
  assert.equal(slow.calls.length, 3);
  assert.equal(block(ws, id).fees_30d_usd, 90);

  // Leases left behind are never permanent.
  const leaseFile = path.join(root, '.cr', 'leases', 'fundamentals.json');
  const leftover = (rec) => fs.writeFileSync(leaseFile, JSON.stringify({ token: 'old', name: 'fundamentals', host: os.hostname(), actor: 'test', label: 'crashed', acquired_at: new Date().toISOString(), expires_at: new Date(Date.now() + HOUR).toISOString(), ...rec }));
  for (const rec of [
    { pid: 2147483646, boot: 'gone' }, // a process that is no longer running
    { pid: process.pid, boot: 'an-earlier-boot' }, // this PID reused after a restart
    { pid: 12345, host: 'another-host', expires_at: new Date(Date.now() - 1000).toISOString() }, // another host, expired
  ]) {
    leftover(rec);
    const r = await fundamentals.refresh(ws, { fetchImpl: good(full(1), full(1), full(1)), now: NOW, force: true, ...FAST });
    assert.equal(r.status, 'ok', `${JSON.stringify(rec)}: ${r.message}`);
  }
  // Another host's lease that has not expired is respected.
  leftover({ pid: 12345, host: 'another-host' });
  const held = llama({});
  assert.equal((await fundamentals.refresh(ws, { fetchImpl: held, now: NOW, force: true, ...FAST })).status, 'busy');
  assert.equal(held.calls.length, 0);
});

test('network waits never hold the workspace save lock: records can be saved while DefiLlama is being asked', async (t) => {
  const { ws } = workspace(t, 'fund-lock');
  const id = addProject(ws, { bind: BIND });
  const checked = [];
  const f = llama({
    dailyFees: () => {
      checked.push(ops.lockState(ws).present);
      const saved = projects.markReviewed(ws, id, { note: 'saved while DefiLlama was asked' });
      checked.push(saved.verified);
      return ok(body({ chart: full(1) }));
    },
    dailyRevenue: ok(body({ chart: full(1) })),
    dailyHoldersRevenue: ok(body({ chart: full(1) })),
  });
  assert.equal((await fundamentals.refresh(ws, { fetchImpl: f, now: NOW, ...FAST })).status, 'ok');
  assert.deepEqual(checked, [false, true]);
  assert.equal(projects.getProject(ws, id).review.note, 'saved while DefiLlama was asked');
});

test('a binding change invalidates the current cache at once; the same binding again changes nothing; identity edits keep the binding; unbinding is unmapped', async (t) => {
  const { ws } = workspace(t, 'fund-rebind');
  const id = addProject(ws, { bind: BIND });
  await fundamentals.refresh(ws, { fetchImpl: good(full(5), full(1), full(1)), now: NOW, ...FAST });
  assert.equal(block(ws, id).state, 'fresh');

  // The same entity, scope and source again: nothing changes, the cache stays valid.
  const same = projects.setDefillamaBinding(ws, id, { defillama: { ...BIND } });
  assert.equal(same.status, 'unchanged');
  assert.equal(block(ws, id).state, 'fresh');

  // Other identity changes carry the binding through.
  projects.updateIdentity(ws, id, { evidence: [{ url: 'https://xlnd.example/token', note: 'another fictional source' }] });
  assert.equal(projects.getProject(ws, id).identity.defillama.slug, 'example-lend');
  assert.equal(block(ws, id).state, 'fresh');

  // Another slug: the saved snapshot belongs to the old binding and is not used.
  const moved = projects.setDefillamaBinding(ws, id, { defillama: { slug: 'example-lend-v2', scope: 'product', source_url: 'https://defillama.com/protocol/example-lend-v2' } });
  assert.equal(moved.status, 'bound');
  const b = block(ws, id);
  assert.deepEqual([b.state, b.metrics, b.fees_30d_usd], ['pending', undefined, undefined]);
  assert.match(b.reason, /The binding changed after the last fetch; "example-lend-v2" has not been fetched yet\./);
  assert.equal(fundamentals.isDue(ws, NOW + 60000), true, 'a new binding is due at once');
  const f = llama({ dailyFees: ok(body({ slug: 'example-lend-v2', chart: full(9) })), dailyRevenue: ok(body({ slug: 'example-lend-v2', chart: full(1) })), dailyHoldersRevenue: ok(body({ slug: 'example-lend-v2', chart: full(1) })) });
  assert.equal((await fundamentals.refresh(ws, { fetchImpl: f, now: NOW + 60000, ...FAST })).status, 'ok');
  assert.ok(f.calls.every((u) => new URL(u).pathname === '/summary/fees/example-lend-v2'));
  assert.deepEqual([block(ws, id).state, block(ws, id).fees_30d_usd], ['fresh', 270]);

  const gone = projects.setDefillamaBinding(ws, id, { defillama: null });
  assert.equal(gone.status, 'unbound');
  assert.equal(projects.getProject(ws, id).identity.defillama, undefined);
  assert.equal(block(ws, id).state, 'unmapped');
});

test('a binding is explicit and exact: slugs, scopes and sources are validated, one entity binds one project, and a binding never verifies an identity', async (t) => {
  const { ws } = workspace(t, 'fund-validate');
  const id = addProject(ws);
  const bad = (defillama, re) => assert.throws(() => projects.setDefillamaBinding(ws, id, { defillama }), re);
  for (const slug of ['../etc', '.hidden', 'Spark', 'spark lend', 'https://defillama.com/protocol/spark', '', 'a/b']) bad({ ...BIND, slug }, /is not a DefiLlama slug/);
  bad({ ...BIND, scope: 'protocol' }, /The DefiLlama scope must be product/);
  bad({ ...BIND, source_url: 'javascript:alert(1)' }, /needs the http\(s\) URL/);
  bad({ ...BIND, verified_at: '2099-01-01T00:00:00Z' }, /not in the future/);
  assert.equal(fundamentals.metricUrl('aave-v3', 'dailyFees'), 'https://api.llama.fi/summary/fees/aave-v3?dataType=dailyFees&excludeTotalDataChartBreakdown=true');
  assert.throws(() => fundamentals.metricUrl('aave', 'dailyVolume'), /Not a supported DefiLlama data type/);
  assert.throws(() => fundamentals.metricUrl('..', 'dailyFees'), /Not a DefiLlama slug/);

  assert.equal(projects.setDefillamaBinding(ws, id, { defillama: BIND }).status, 'bound');
  const other = addProject(ws, { name: 'Other Lend (FICTIONAL)', symbol: 'XOTH' });
  assert.throws(() => projects.setDefillamaBinding(ws, other, { defillama: BIND }), /already bound to "example-lend-fictional"/);

  // A pending identity keeps its binding unused, and binding does not verify it.
  const pending = projects.addProject(ws, { name: 'Pending Lend (FICTIONAL)', official_website: 'https://pending-lend.example/', evidence: [] });
  const out = projects.setDefillamaBinding(ws, pending.project_id, { defillama: { slug: 'pending-lend', scope: 'product', source_url: 'https://pending-lend.example/docs' } });
  assert.equal(out.identity_status, 'pending');
  assert.equal(projects.getProject(ws, pending.project_id).identity.status, 'pending');
  assert.equal(block(ws, pending.project_id).state, 'identity_pending');
  const none = llama({});
  assert.equal((await fundamentals.refresh(ws, { fetchImpl: none, now: NOW, projectIds: [pending.project_id], force: true, ...FAST })).status, 'noop');
  assert.equal(none.calls.length, 0);
});

test('the scope DefiLlama reports must be the bound scope: a parent or another slug is refused and flagged; a bound parent is DefiLlama\'s own aggregate; an unknown slug is not found', async (t) => {
  const { ws } = workspace(t, 'fund-scope');
  const id = addProject(ws, { bind: { slug: 'example-group', scope: 'product', source_url: 'https://defillama.com/protocol/example-group' } });
  const children = [{ name: 'Example V1', defillamaId: '11', methodologyURL: 'https://github.com/DefiLlama/dimension-adapters/blob/master/fees/example-v1.ts' }, { name: 'Example V2', defillamaId: '12' }];
  const parent = (chart) => ok(body({ slug: 'example-group', name: 'Example Group', defillamaId: 'parent#example-group', childProtocols: children, methodology: null, chart }));
  const asParent = llama({ dailyFees: parent(full(4)), dailyRevenue: parent(full(1)), dailyHoldersRevenue: parent(full(0)) });
  const r = await fundamentals.refresh(ws, { fetchImpl: asParent, now: NOW, ...FAST });
  assert.equal(r.status, 'attention');
  const b = block(ws, id);
  assert.equal(b.state, 'scope_mismatch');
  assert.equal(b.metrics, undefined, 'nothing is used');
  assert.match(b.reason, /^Bound as product \(an individual product \(one protocol or version\)\), but DefiLlama reports "example-group" as a parent with 2 child protocol\(s\) \(Example V1, Example V2\)\. Nothing was used/);
  const idx = buildIndex(ws);
  const flag = idx.attention.find((a) => a.kind === 'fundamentals_binding');
  assert.equal(flag.project_id, id);
  assert.equal(flag.title, 'Example Lend (FICTIONAL): DefiLlama binding "example-group" needs checking');
  assert.equal(idx.projects.find((p) => p.project_id === id).fundamentals.state, 'scope_mismatch');

  // Bound as what DefiLlama reports: its own parent aggregate, children named, never added.
  projects.setDefillamaBinding(ws, id, { defillama: { slug: 'example-group', scope: 'parent', source_url: 'https://defillama.com/protocol/example-group' } });
  assert.equal((await fundamentals.refresh(ws, { fetchImpl: asParent, now: NOW, ...FAST })).status, 'ok');
  const p = block(ws, id);
  assert.deepEqual([p.state, p.fees_30d_usd, p.entity.reported_scope, p.entity.child_protocol_count], ['fresh', 120, 'parent', 2]);
  assert.match(p.scope_note, /DefiLlama's own aggregate for the parent entity, which includes 2 child protocol\(s\)\. The desk does not add the children to it or fetch them separately\./);
  assert.equal(p.metrics.fees.definition, null);
  assert.match(p.metrics.fees.definition_note, /per child protocol/);
  assert.equal(p.entity.child_protocols[0].methodology_url, children[0].methodologyURL);
  assert.equal(asParent.calls.filter((u) => /example-v/.test(u)).length, 0, 'children are never fetched');

  // A chain bound as a chain.
  const chainId = addProject(ws, { name: 'Example Chain (FICTIONAL)', symbol: 'XCHN', bind: { slug: 'example-chain', scope: 'chain', source_url: 'https://defillama.com/chain/example-chain' } });
  const chain = (c) => ok(body({ slug: 'example-chain', name: 'Example Chain', defillamaId: 'chain#example-chain', protocolType: 'chain', chart: c }));
  await fundamentals.refresh(ws, { fetchImpl: llama({ dailyFees: chain(full(2)), dailyRevenue: chain(full(1)), dailyHoldersRevenue: notFound('example-chain') }), now: NOW, projectIds: [chainId], ...FAST });
  assert.deepEqual([block(ws, chainId).state, block(ws, chainId).entity.reported_scope, block(ws, chainId).metrics.holders_revenue.status], ['fresh', 'chain', 'unsupported']);
  // DefiLlama links that entity to another CoinGecko ID than the project's token: said, not decided.
  assert.equal(block(ws, chainId).token_link_note, 'DefiLlama links this entity to CoinGecko ID "xlnd-fictional", while this project\'s token is "xchn-fictional"; the binding\'s source explains how they relate.');

  // DefiLlama answers for another slug (renamed): refused.
  const renamedId = addProject(ws, { name: 'Renamed Lend (FICTIONAL)', symbol: 'XREN', bind: { slug: 'old-name-lend', scope: 'product', source_url: 'https://defillama.com/protocol/old-name-lend' } });
  const renamed = ok(body({ slug: 'new-name-lend', name: 'New Name Lend', chart: full(1) }));
  await fundamentals.refresh(ws, { fetchImpl: llama({ dailyFees: renamed, dailyRevenue: renamed, dailyHoldersRevenue: renamed }), now: NOW, projectIds: [renamedId], ...FAST });
  assert.equal(block(ws, renamedId).state, 'entity_mismatch');
  assert.match(block(ws, renamedId).reason, /Bound to "old-name-lend", but DefiLlama answers for "new-name-lend" \(New Name Lend\)/);

  // An unknown slug or missing endpoint (400 or 404 for every series): not found.
  const lostId = addProject(ws, { name: 'Lost Lend (FICTIONAL)', symbol: 'XLST', bind: { slug: 'no-such-lend', scope: 'product', source_url: 'https://lost-lend.example/docs' } });
  await fundamentals.refresh(ws, { fetchImpl: llama({ dailyFees: notFound('no-such-lend'), dailyRevenue: reply(404, 'Not Found'), dailyHoldersRevenue: notFound('no-such-lend') }), now: NOW, projectIds: [lostId], ...FAST });
  assert.equal(block(ws, lostId).state, 'not_found');
  assert.match(block(ws, lostId).reason, /^DefiLlama has no fee data for "no-such-lend" \(HTTP 400: "Fees for no-such-lend not found/);
});

test('due rules: a new binding at once, then every refresh_hours; a scheduled refresh waits out the first UTC hours, a first fetch never does', async (t) => {
  const { ws } = workspace(t, 'fund-due', { fundamentals: { refresh_hours: 6 } });
  const id = addProject(ws, { bind: BIND });
  assert.equal(fundamentals.isDue(ws, NOW), true);
  assert.equal(jobs.isDue(ws, 'fundamentals', jobs.readJobState(ws), NOW), true);
  await fundamentals.refresh(ws, { fetchImpl: good(full(1), full(1), full(1)), now: NOW, ...FAST });
  assert.equal(fundamentals.isDue(ws, NOW + HOUR), false);
  assert.equal(fundamentals.isDue(ws, NOW + 7 * HOUR), true, '22:00 UTC, past refresh_hours');
  const oneAm = Date.parse('2026-10-05T01:00:00Z');
  assert.equal(fundamentals.isDue(ws, oneAm), false, 'the day that just ended may still be published');
  assert.equal(fundamentals.isDue(ws, Date.parse('2026-10-05T03:30:00Z')), true);
  // A project bound at 01:00 with nothing saved is fetched at once.
  addProject(ws, { name: 'Night Lend (FICTIONAL)', symbol: 'XNGT', bind: { slug: 'night-lend', scope: 'product', source_url: 'https://defillama.com/protocol/night-lend' } });
  assert.equal(fundamentals.isDue(ws, oneAm), true);
  // A scheduled refresh does only what is due.
  const f = good(full(1, oneAm), full(1, oneAm), full(1, oneAm), { slug: 'night-lend' });
  const r = await fundamentals.refresh(ws, { fetchImpl: f, now: oneAm, ...FAST });
  assert.deepEqual(r.refreshed, ['night-lend-fictional']);
  assert.equal(f.calls.length, 3, 'the project fetched at 15:00 waits');
  assert.equal(block(ws, id, oneAm).fetched_at, '2026-10-04T15:00:00.000Z');
});

test('research: a new run freezes the fundamentals in its v2 packet and prompt; later refreshes and binding edits never change it, while the next run differs', async (t) => {
  const { ws, root } = workspace(t, 'fund-run');
  const id = addProject(ws, { bind: BIND });
  const now = Date.now();
  await fundamentals.refresh(ws, { fetchImpl: good(full(10, now), full(2, now), full(1, now)), now, ...FAST });
  const r1 = research.createRun(ws, { project_id: id, providers: ['claude', 'chatgpt'] });
  const packetFile = path.join(root, r1.run.evidence_packet.path);
  const promptFile = path.join(root, r1.run.prompt.path);
  const packetBytes = fs.readFileSync(packetFile);
  const promptBytes = fs.readFileSync(promptFile);
  const p1 = JSON.parse(packetBytes.toString('utf8'));
  assert.equal(p1.schema_version, 'cr.evidence-packet.v2');
  assert.equal(r1.run.evidence_packet.schema_version, 'cr.evidence-packet.v2');
  assert.equal(r1.run.evidence_packet.fundamentals_state, 'fresh');
  assert.deepEqual([p1.fundamentals.state, p1.fundamentals.fees_30d_usd, p1.fundamentals.binding.slug], ['fresh', 300, 'example-lend']);
  assert.equal(Object.keys(p1.fundamentals.metrics.fees.daily).length, 30, 'every reported day is frozen');
  assert.equal(sha256(packetBytes), r1.run.evidence_packet.sha256, 'the packet hash covers the fundamentals block');
  const prompt = promptBytes.toString('utf8');
  assert.equal(sha256(prompt), r1.run.prompt.sha256);
  assert.ok(prompt.includes(JSON.stringify(p1, null, 2)), 'the prompt carries the whole packet, fundamentals included, for every model');
  assert.ok(prompt.includes('"fees_30d_usd": 300'));
  assert.equal(r1.run.prompt.identical_for_all_providers, true);

  // DefiLlama revises its data, and the binding is edited: the run is untouched.
  await fundamentals.refresh(ws, { fetchImpl: good(full(11, now), full(2, now), full(1, now)), now, force: true, ...FAST });
  projects.setDefillamaBinding(ws, id, { defillama: { ...BIND, source_url: 'https://xlnd.example/defillama' } });
  assert.ok(fs.readFileSync(packetFile).equals(packetBytes), 'the frozen packet is byte for byte the same');
  assert.ok(fs.readFileSync(promptFile).equals(promptBytes), 'and so is the prompt');
  const reloaded = research.loadRun(ws, id, r1.run_id);
  assert.equal(reloaded.evidence_packet.sha256, sha256(packetBytes));
  const bound = checkBinding(ws, { projectId: id, runId: r1.run_id, provider: 'claude', json: { research_run_id: r1.run_id, prompt_version: r1.run.prompt.version }, mode: 'assistant' });
  assert.equal(bound.status, 'bound', bound.message);

  // The next run freezes what is saved then (the new binding is not fetched yet).
  const r2 = research.createRun(ws, { project_id: id, providers: ['claude'], force_new: true });
  assert.notEqual(r2.run.evidence_packet.sha256, r1.run.evidence_packet.sha256);
  const p2 = readJson(path.join(root, r2.run.evidence_packet.path));
  assert.equal(p2.fundamentals.state, 'pending');
  await fundamentals.refresh(ws, { fetchImpl: good(full(11, now), full(2, now), full(1, now)), now, ...FAST });
  const r3 = research.createRun(ws, { project_id: id, providers: ['claude'], force_new: true });
  const p3 = readJson(path.join(root, r3.run.evidence_packet.path));
  assert.deepEqual([p3.fundamentals.state, p3.fundamentals.fees_30d_usd], ['fresh', 330]);
  assert.notEqual(r3.run.evidence_packet.sha256, r1.run.evidence_packet.sha256, 'different fundamentals, a different packet hash');
  // Research never waits for DefiLlama: no request was made by creating runs.
  assert.ok(projectDetail(ws, id).fundamentals.state === 'fresh');
});

test('a run frozen under packet v1 stays as it was: its packet and prompt are byte for byte unchanged, still verify, and are never rebuilt under v2', async (t) => {
  const { ws, root } = workspace(t, 'fund-v1');
  const id = addProject(ws, { bind: BIND });
  const r = research.createRun(ws, { project_id: id, providers: ['claude'] });
  // The run as the code before 2026-10-04 froze it: a v1 packet without
  // fundamentals, and the prompt built from it.
  const packetFile = path.join(root, r.run.evidence_packet.path);
  const promptFile = path.join(root, r.run.prompt.path);
  const { fundamentals: _f, ...rest } = readJson(packetFile); // eslint-disable-line no-unused-vars
  const v1 = { ...rest, schema_version: 'cr.evidence-packet.v1' };
  const v1Text = `${JSON.stringify(v1, null, 2)}\n`;
  const project = projects.getProject(ws, id);
  const v1Prompt = prompts.buildRunPrompt(ws, project, { runId: r.run_id, horizon: r.run.horizon, rubricRef: r.run.rubric_version, packet: v1, profileRef: r.run.sector_profile, version: r.run.prompt.version });
  fs.writeFileSync(packetFile, v1Text);
  fs.writeFileSync(promptFile, v1Prompt);
  const runFile = path.join(root, 'projects', id, 'research', r.run_id, 'run.json');
  const run = readJson(runFile);
  run.evidence_packet = { path: r.run.evidence_packet.path, sha256: sha256(v1Text), captured_at: v1.captured_at, market_snapshot_id: v1.market_context.snapshot_id || null };
  run.prompt.sha256 = sha256(v1Prompt);
  atomicWrite(runFile, jsonText(run));

  // Fundamentals arrive, the dashboard and the connector read everything.
  const now = Date.now();
  await fundamentals.refresh(ws, { fetchImpl: good(full(1, now), full(1, now), full(1, now)), now, ...FAST });
  buildIndex(ws);
  projectDetail(ws, id);
  const loaded = research.loadRun(ws, id, r.run_id);
  assert.equal(fs.readFileSync(packetFile, 'utf8'), v1Text, 'the v1 packet is untouched');
  assert.equal(fs.readFileSync(promptFile, 'utf8'), v1Prompt, 'its prompt is untouched');
  assert.equal(loaded.evidence_packet.sha256, sha256(v1Text));
  assert.equal(loaded.evidence_packet.schema_version, undefined, 'the run record is not rewritten');
  assert.ok(v1Prompt.includes('"schema_version": "cr.evidence-packet.v1"'));
  assert.ok(!v1Prompt.includes('"fundamentals"'));
  // The prompt still verifies, and is reproduced from its own stored packet.
  const bound = checkBinding(ws, { projectId: id, runId: r.run_id, provider: 'claude', json: { research_run_id: r.run_id, prompt_version: r.run.prompt.version }, mode: 'assistant' });
  assert.equal(bound.status, 'bound', bound.message);
  assert.equal(prompts.buildRunPrompt(ws, project, { runId: r.run_id, horizon: r.run.horizon, rubricRef: r.run.rubric_version, packet: readJson(packetFile), profileRef: r.run.sector_profile, version: r.run.prompt.version }), v1Prompt);
  // A new run is v2.
  const next = research.createRun(ws, { project_id: id, providers: ['claude'], force_new: true });
  assert.equal(readJson(path.join(root, next.run.evidence_packet.path)).schema_version, 'cr.evidence-packet.v2');
});

// The connector's update_project_identity, called as an assistant would.
async function mcpCall(ws, name, args, fetchStub) {
  const handle = require('../mcp').makeMcp(ws, { fundamentalsFetch: fetchStub });
  const req = Readable.from([Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }))]);
  req.method = 'POST';
  let text = '';
  const res = { writeHead: () => {}, end: (b) => { text = b || ''; } };
  await handle(req, res, { assistant: 'claude', client_name: 'test' });
  const out = JSON.parse(text).result;
  return { ...out, data: out.structuredContent || null };
}

test('connector: Cowork binds a DefiLlama entity without other identity evidence; the reply says what DefiLlama answered; a wrong scope is named; the identity is otherwise untouched', async (t) => {
  const { ws } = workspace(t, 'fund-mcp');
  const id = addProject(ws, { extra: { unknowns: ['contract not published on the official site (fictional)'] } });
  const before = projects.getProject(ws, id).identity;
  const now = Date.now();
  const f = llama({ dailyFees: ok(body({ chart: full(3, now) })), dailyRevenue: ok(body({ chart: full(1, now) })), dailyHoldersRevenue: notFound() });
  const out = await mcpCall(ws, 'update_project_identity', { project_id: id, defillama_slug: 'example-lend', defillama_scope: 'product', defillama_source_url: 'https://defillama.com/protocol/example-lend' }, f);
  assert.ok(!out.isError, out.content && out.content[0].text);
  assert.equal(out.data.status, 'bound');
  assert.deepEqual([out.data.fundamentals.state, out.data.fundamentals.refresh.status, out.data.fundamentals.metrics.fees.total_30d_usd, out.data.fundamentals.metrics.holders_revenue.status], ['fresh', 'ok', 90, 'unsupported']);
  assert.equal(out.data.project.identity.defillama.slug, 'example-lend');
  const after = projects.getProject(ws, id).identity;
  assert.deepEqual({ ...after, defillama: undefined }, { ...before, defillama: undefined }, 'nothing else in the identity changed');
  assert.equal(after.defillama.verified_by, 'cowork');

  // The same binding again (an assistant retrying): nothing changes and nothing is asked again.
  const quiet = llama({});
  const repeat = await mcpCall(ws, 'update_project_identity', { project_id: id, defillama_slug: 'example-lend', defillama_scope: 'product', defillama_source_url: 'https://defillama.com/protocol/example-lend' }, quiet);
  assert.deepEqual([repeat.data.status, repeat.data.fundamentals.state, repeat.data.fundamentals.refresh.status], ['unchanged', 'fresh', 'not_needed']);
  assert.equal(quiet.calls.length, 0);

  // A wrong scope: refused by what DefiLlama reports, and said in the reply.
  const parent = ok(body({ slug: 'example-lend', defillamaId: 'parent#example-lend', childProtocols: [{ name: 'Example Lend V1' }], chart: full(1, now) }));
  const wrong = await mcpCall(ws, 'update_project_identity', { project_id: id, defillama_slug: 'example-lend', defillama_scope: 'chain', defillama_source_url: 'https://defillama.com/protocol/example-lend' }, llama({ dailyFees: parent, dailyRevenue: parent, dailyHoldersRevenue: parent }));
  assert.equal(wrong.data.fundamentals.state, 'scope_mismatch');
  assert.match(wrong.data.fundamentals.reason, /Bound as chain .* reports "example-lend" as a parent with 1 child protocol/);

  // Identity changes still need evidence; a bad slug is refused with its reason.
  const noEvidence = await mcpCall(ws, 'update_project_identity', { project_id: id, coingecko_id: 'something-else' }, llama({}));
  assert.equal(noEvidence.isError, true);
  const badSlug = await mcpCall(ws, 'update_project_identity', { project_id: id, defillama_slug: 'Example Lend', defillama_scope: 'product', defillama_source_url: 'https://x.example/' }, llama({}));
  assert.equal(badSlug.isError, true);
  assert.match(badSlug.content[0].text, /is not a DefiLlama slug/);
  const removed = await mcpCall(ws, 'update_project_identity', { project_id: id, remove_defillama: true }, llama({}));
  assert.equal(removed.data.status, 'unbound');
});
