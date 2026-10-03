'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempWorkspace, addFixtureProject, importAllFixtures, hashTree } = require('./helpers');
const market = require('../core/market');
const jobs = require('../core/jobs');
const { loadReports } = require('../core/reports');
const { compareProject } = require('../core/compare');
const { readJson, atomicWrite, jsonText } = require('../core/fsx');

function fakeFetch(prices) {
  return async (url) => {
    const ids = decodeURIComponent(new URL(url).searchParams.get('ids')).split(',');
    return {
      ok: true,
      status: 200,
      json: async () => ids.filter((id) => prices[id] !== undefined).map((id) => ({ id, symbol: id.slice(0, 4), name: id, current_price: prices[id], market_cap: 1e6, fully_diluted_valuation: 2e6, total_volume: 1e5, price_change_percentage_24h: 1.5, circulating_supply: 1e6, total_supply: 2e6, max_supply: null, last_updated: new Date().toISOString() })),
    };
  };
}

function enableMarket(ws, root) {
  const s = readJson(path.join(root, 'config', 'settings.json'));
  s.market_data = { enabled: true };
  atomicWrite(path.join(root, 'config', 'settings.json'), jsonText(s));
  ws.reloadSettings();
}

test('price updates never change stored reports or historical grades', async (t) => {
  const { ws, root, cleanup } = tempWorkspace('mkt');
  t.after(cleanup);
  addFixtureProject(ws);
  importAllFixtures(ws);
  enableMarket(ws, root);
  const before = hashTree(path.join(root, 'projects'));
  const gradesBefore = JSON.stringify(compareProject(ws, loadReports(ws, 'example-payfi-fictional')).grades);
  const r1 = await market.refresh(ws, { fetchImpl: fakeFetch({ 'example-payfi-fictional': 0.5, bitcoin: 70000 }) });
  // usd-coin and tether are tracked but not in this fake response: a partial refresh.
  assert.equal(r1.status, 'partial');
  assert.deepEqual(r1.missing.sort(), ['tether', 'usd-coin']);
  const r2 = await market.refresh(ws, { fetchImpl: fakeFetch({ 'example-payfi-fictional': 0.05, bitcoin: 30000 }) });
  assert.equal(r2.status, 'partial');
  assert.deepEqual(hashTree(path.join(root, 'projects')), before, 'no project or report file changed');
  assert.equal(JSON.stringify(compareProject(ws, loadReports(ws, 'example-payfi-fictional')).grades), gradesBefore);
  assert.equal(market.readLatest(ws).assets['example-payfi-fictional'].price_usd, 0.05);
  const obsFiles = fs.readdirSync(path.join(root, 'market-data', 'observations'));
  assert.equal(obsFiles.length, 1);
});

test('a failed refresh keeps the last valid observation and reports failure', async (t) => {
  const { ws, root, cleanup } = tempWorkspace('mktfail');
  t.after(cleanup);
  addFixtureProject(ws);
  enableMarket(ws, root);
  await market.refresh(ws, { fetchImpl: fakeFetch({ 'example-payfi-fictional': 0.5, bitcoin: 70000 }) });
  const failing = async () => {
    throw new Error('getaddrinfo ENOTFOUND api.coingecko.com');
  };
  const r = await market.refresh(ws, { fetchImpl: failing });
  assert.equal(r.status, 'failed');
  const status = market.readStatus(ws);
  assert.equal(status.state, 'failed');
  assert.equal(status.consecutive_failures, 1);
  assert.ok(status.last_success_at, 'last valid timestamp kept');
  assert.equal(market.readLatest(ws).assets['example-payfi-fictional'].price_usd, 0.5, 'last valid price kept');
  const later = market.freshness(ws, Date.now() + 3 * 3600 * 1000);
  assert.equal(later.freshness, 'stale_failed');
});

test('only verified identities are sent to the price provider', async (t) => {
  const { ws, cleanup } = tempWorkspace('mktids');
  t.after(cleanup);
  addFixtureProject(ws);
  require('../core/projects').addProject(ws, { name: 'Guess Token', symbol: 'GSS', coingecko_id: 'guess-token' });
  const ids = market.trackedIds(ws);
  assert.ok(ids.includes('example-payfi-fictional'));
  assert.ok(ids.includes('bitcoin'));
  assert.ok(!ids.includes('guess-token'));
});

// --- the shared CoinGecko rate-limit gate (every provider answer below is a stub)

// One canned answer for every request, with an optional Retry-After header.
function answer(status, { retryAfter = null, rows = [] } = {}) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    return { ok: status === 200, status, headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? retryAfter : null) }, json: async () => rows };
  };
  f.calls = calls;
  return f;
}

const TIME = '(\\w{3} \\d{1,2}, )?\\d{1,2}:\\d{2} [AP]M';
const msFromNow = (iso) => Date.parse(iso) - Date.now();
const writeStatus = (root, patch) => {
  const file = path.join(root, 'market-data', 'status.json');
  atomicWrite(file, jsonText({ ...readJson(file, {}), ...patch }));
};

test('a 429 without Retry-After closes the shared gate for two minutes; Refresh prices waits for it and says when it will try again', async (t) => {
  const { ws, root, cleanup } = tempWorkspace('mkt429');
  t.after(cleanup);
  addFixtureProject(ws);
  enableMarket(ws, root);
  await market.refresh(ws, { fetchImpl: fakeFetch({ 'example-payfi-fictional': 0.5, bitcoin: 70000 }) });
  const okAt = market.readStatus(ws).last_success_at;
  const limited = answer(429);
  const r = await market.refresh(ws, { fetchImpl: limited, force: true });
  assert.equal(r.status, 'failed');
  assert.equal(r.rate_limited, true);
  const st = market.readStatus(ws);
  const wait = msFromNow(st.retry_after_until);
  assert.ok(wait > 110000 && wait <= 120000, `the default wait, got ${wait} ms`);
  assert.ok(Date.parse(st.next_allowed_at) >= Date.parse(st.retry_after_until), 'scheduled runners wait at least as long');
  assert.deepEqual([st.rate_limit.source, st.rate_limit.retry_after_ms, st.rate_limit.strikes], ['prices', null, 1]);

  const again = await market.refresh(ws, { fetchImpl: limited, force: true });
  assert.equal(again.status, 'backoff', 'a manual refresh never skips a rate-limit wait');
  assert.equal(again.rate_limited, true);
  assert.equal(again.retry_at, st.retry_after_until);
  assert.match(again.message, new RegExp(`CoinGecko is rate-limiting this server; next try ${TIME}\\.$`));
  assert.equal(limited.calls.length, 1, 'no second request');
  assert.equal(jobs.marketDue(ws, Date.now(), { foreground: true }), false);
  assert.equal(jobs.marketDue(ws, Date.now(), { foreground: false }), false);

  const f = market.freshness(ws);
  assert.equal(f.rate_limited, true);
  assert.equal(f.retry_at, st.next_allowed_at);
  assert.equal(f.last_success_at, okAt, 'the last success is not moved');
  assert.match(f.note, new RegExp(`^CoinGecko is rate-limiting this server; showing prices from ${TIME}; next try ${TIME}$`));

  // Once the wait has passed, a refresh goes out and its success opens the gate.
  writeStatus(root, { retry_after_until: new Date(Date.now() - 1000).toISOString(), next_allowed_at: new Date(Date.now() - 1000).toISOString() });
  const back = await market.refresh(ws, { fetchImpl: fakeFetch({ 'example-payfi-fictional': 0.6, bitcoin: 71000 }) });
  assert.equal(back.status, 'partial');
  const after = market.readStatus(ws);
  assert.equal(after.retry_after_until, null);
  assert.equal(after.next_allowed_at, null);
  assert.equal(after.consecutive_failures, 0);
  assert.equal(after.note, undefined, 'the failure note is gone');
  assert.equal(market.freshness(ws).rate_limited, false);
});

test('Retry-After is honored as sent, capped at the longest backoff; a running wait is never shortened; repeated 429s without it double the wait', async (t) => {
  const { ws, root, cleanup } = tempWorkspace('mktra');
  t.after(cleanup);
  enableMarket(ws, root);
  const near = (iso, ms) => Math.abs(msFromNow(iso) - ms) < 5000;
  let g = market.noteRateLimit(ws, { retryAfterMs: 30000, source: 'identity search' });
  assert.equal(g.open, false);
  assert.ok(near(g.until, 30000));
  g = market.noteRateLimit(ws, { retryAfterMs: 5000, source: 'prices' });
  assert.ok(near(g.until, 30000), 'a shorter Retry-After never shortens the running wait');
  g = market.noteRateLimit(ws, { retryAfterMs: 10 * 3600000, source: 'prices' });
  assert.ok(near(g.until, 60 * 60000), 'capped at backoff_max_minutes (60)');

  const { ws: ws2, root: root2, cleanup: c2 } = tempWorkspace('mktra2');
  t.after(c2);
  enableMarket(ws2, root2);
  const waits = [];
  for (let i = 0; i < 3; i++) {
    market.noteRateLimit(ws2, { source: 'prices' });
    waits.push(market.readStatus(ws2).rate_limit.wait_ms);
  }
  assert.deepEqual(waits, [120000, 240000, 480000]);
  assert.ok(near(market.readStatus(ws2).retry_after_until, 480000));
  // A 429 long after the last wait ended starts a new episode at two minutes.
  const old = new Date(Date.now() - 20 * 60000).toISOString();
  writeStatus(root2, { retry_after_until: old, next_allowed_at: old, rate_limit: { ...market.readStatus(ws2).rate_limit, until: old } });
  market.noteRateLimit(ws2, { source: 'prices' });
  assert.deepEqual([market.readStatus(ws2).rate_limit.strikes, market.readStatus(ws2).rate_limit.wait_ms], [1, 120000]);
});

test('an answer that updates no price is not a success: the last success time and latest.json stay as they were', async (t) => {
  const { ws, root, cleanup } = tempWorkspace('mktzero');
  t.after(cleanup);
  addFixtureProject(ws);
  enableMarket(ws, root);
  await market.refresh(ws, { fetchImpl: fakeFetch({ 'example-payfi-fictional': 0.5, bitcoin: 70000 }) });
  const before = market.readStatus(ws);
  const latestFile = path.join(root, 'market-data', 'latest.json');
  const latestBefore = fs.readFileSync(latestFile, 'utf8');

  const empty = await market.refresh(ws, { fetchImpl: answer(200, { rows: [] }) });
  assert.equal(empty.status, 'failed');
  assert.equal(empty.updated, 0);
  assert.match(empty.message, /none of the 4 tracked prices could be used \(0 invalid row\(s\), 4 not returned\)/);
  let st = market.readStatus(ws);
  assert.equal(st.state, 'failed');
  assert.equal(st.last_success_at, before.last_success_at, 'last success unchanged');
  assert.equal(st.last_error, empty.message);
  assert.equal(st.consecutive_failures, 1);
  assert.ok(Date.parse(st.next_allowed_at) > Date.now(), 'the usual failure backoff applies');
  assert.equal(fs.readFileSync(latestFile, 'utf8'), latestBefore, 'latest.json untouched, its fetch time included');
  const f = market.freshness(ws);
  assert.equal(f.freshness, 'fresh_last_failed');
  assert.match(f.note, new RegExp(`^The last price refresh failed; showing prices from ${TIME}; next try ${TIME}$`));

  // Only invalid rows: the same.
  const bad = await market.refresh(ws, { fetchImpl: answer(200, { rows: [{ id: 'bitcoin', current_price: 0, last_updated: new Date().toISOString() }] }), force: true });
  assert.equal(bad.status, 'failed');
  st = market.readStatus(ws);
  assert.equal(st.consecutive_failures, 2);
  assert.equal(st.last_success_at, before.last_success_at);
  assert.equal(st.invalid_rows[0].id, 'bitcoin');

  // A usable answer is a success again.
  const ok = await market.refresh(ws, { fetchImpl: fakeFetch({ 'example-payfi-fictional': 0.6, bitcoin: 71000 }), force: true });
  assert.equal(ok.status, 'partial');
  st = market.readStatus(ws);
  assert.equal(st.consecutive_failures, 0);
  assert.equal(st.state, 'partial');
  assert.match(market.freshness(ws).note, new RegExp(`^Prices updated ${TIME} for 2 of 4 tracked assets$`));
});

test('forcing skips a failure backoff, never a rate limit; a rate limit noted while a refresh was out stays after its success', async (t) => {
  const { ws, root, cleanup } = tempWorkspace('mktforce');
  t.after(cleanup);
  enableMarket(ws, root);
  await market.refresh(ws, { fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND api.coingecko.com'); } });
  assert.equal(market.nextAllowed(ws, market.readStatus(ws)).allowed, false, 'scheduled runners back off');
  assert.equal(market.rateLimitGate(ws).open, true, 'being offline is not a rate limit');
  const manual = await market.refresh(ws, { fetchImpl: fakeFetch({ bitcoin: 70000 }), force: true });
  assert.equal(manual.status, 'partial', 'a manual refresh may skip a failure backoff');

  // Another caller's 429 lands while this request is out.
  const overlapping = async (url) => {
    market.noteRateLimit(ws, { source: 'identity search' });
    return fakeFetch({ bitcoin: 70500 })(url);
  };
  const r = await market.refresh(ws, { fetchImpl: overlapping, force: true });
  assert.equal(r.status, 'partial');
  assert.equal(market.rateLimitGate(ws).open, false, 'the other caller\'s rate limit is kept');
  const blocked = answer(200, { rows: [] });
  assert.equal((await market.refresh(ws, { fetchImpl: blocked, force: true })).status, 'backoff');
  assert.equal(blocked.calls.length, 0);
});

test('a 429 on identity search closes the shared gate; search, prices and market context then wait without calling', async (t) => {
  const { ws, root, cleanup } = tempWorkspace('mktsearch429');
  t.after(cleanup);
  enableMarket(ws, root);
  const limited = answer(429, { retryAfter: '45' });
  const r = await market.searchCoins(ws, 'allo', { fetchImpl: limited });
  assert.equal(r.status, 'failed');
  assert.equal(r.rate_limited, true);
  assert.match(r.message, new RegExp(`^CoinGecko is rate-limiting this server; next try ${TIME}\\.$`));
  const st = market.readStatus(ws);
  assert.equal(st.calls.month_count, 1, 'the call is counted');
  assert.equal(st.rate_limit.source, 'identity search');
  assert.equal(st.rate_limit.retry_after_ms, 45000);
  assert.ok(Math.abs(msFromNow(st.retry_after_until) - 45000) < 5000);
  const again = await market.searchCoins(ws, 'allo', { fetchImpl: limited });
  assert.equal(again.status, 'backoff');
  assert.equal((await market.refresh(ws, { fetchImpl: limited, force: true })).status, 'backoff');
  assert.equal((await require('../core/cycle').refreshContext(ws, { fetchImpl: limited, force: true })).status, 'backoff');
  assert.equal(limited.calls.length, 1, 'nothing else was sent');
  assert.equal(market.readStatus(ws).calls.month_count, 1);
});

test('status notes use New York clock times, the date only for another day', (t) => {
  const now = Date.parse('2026-10-03T04:35:00.000Z'); // 12:35 AM in New York (EDT)
  assert.equal(market.clock('2026-10-03T04:29:58.000Z', now), '12:29 AM');
  assert.equal(market.clock('2026-10-02T01:15:00.000Z', now), 'Oct 1, 9:15 PM');
  assert.equal(market.clock(null, now), null);
  const { ws, root, cleanup } = tempWorkspace('mktnote');
  t.after(cleanup);
  enableMarket(ws, root);
  fs.mkdirSync(path.join(root, 'market-data'), { recursive: true });
  // The state the Render log showed: last success 04:29:58Z, rate-limited until 04:37:18Z.
  writeStatus(root, { state: 'failed', last_success_at: '2026-10-03T04:29:58.000Z', last_error: 'CoinGecko responded HTTP 429 (rate limited)', consecutive_failures: 1, retry_after_until: '2026-10-03T04:37:18.000Z', next_allowed_at: '2026-10-03T04:37:18.000Z', rate_limit: { at: '2026-10-03T04:34:58.000Z', source: 'prices', http_status: 429, retry_after_ms: null, wait_ms: 140000, strikes: 1, until: '2026-10-03T04:37:18.000Z' } });
  const f = market.freshness(ws, now);
  assert.equal(f.freshness, 'fresh_last_failed');
  assert.equal(f.rate_limited, true);
  assert.equal(f.retry_at, '2026-10-03T04:37:18.000Z');
  assert.equal(f.note, 'CoinGecko is rate-limiting this server; showing prices from 12:29 AM; next try 12:37 AM');
  const later = market.freshness(ws, Date.parse('2026-10-03T04:40:00.000Z'));
  assert.equal(later.rate_limited, false);
  assert.equal(later.retry_at, null);
  assert.equal(later.note, 'The last price refresh failed; showing prices from 12:29 AM');
});

test('a verified CoinGecko ID the refresh does not get back is flagged (attention, start log, connector), never rebound automatically', async (t) => {
  const { ws, root, cleanup } = tempWorkspace('mktnotreturned');
  t.after(cleanup);
  enableMarket(ws, root);
  const projects = require('../core/projects');
  projects.addProject(ws, { name: 'Wrong Id Coin (FICTIONAL)', symbol: 'WIC', official_website: 'https://wrong-id-fictional.example/', coingecko_id: 'wrong-id-fictional', assets: [{ chain: 'base', contract_address: '0x00000000000000000000000000000000000f1c71' }], evidence: [{ url: 'https://wrong-id-fictional.example/' }] });
  addFixtureProject(ws);
  // CoinGecko answers for the others and leaves the unknown ID out, as /coins/markets does.
  const r = await market.refresh(ws, { fetchImpl: fakeFetch({ 'example-payfi-fictional': 0.5, bitcoin: 70000, tether: 1, 'usd-coin': 1 }) });
  assert.equal(r.status, 'partial');
  assert.deepEqual(r.missing, ['wrong-id-fictional']);
  const idx = require('../core/indexer').buildIndex(ws);
  const flag = idx.attention.find((a) => a.kind === 'identity_price');
  assert.equal(flag.project_id, 'wrong-id-coin-fictional');
  assert.equal(flag.title, 'Wrong Id Coin (FICTIONAL): CoinGecko returned no price for "wrong-id-fictional"');
  assert.equal(idx.attention.filter((a) => a.kind === 'identity_price').length, 1, 'the priced projects are not flagged');
  const lines = require('../hosted').healthLines(ws);
  assert.ok(lines.includes('Identity: wrong-id-coin-fictional verified, but CoinGecko returned no price for its ID "wrong-id-fictional" in the last refresh (the ID may be wrong).'), lines.join('\n'));
  assert.match(lines.find((l) => l.startsWith('Prices:')), /; not returned wrong-id-fictional\.$/);
  assert.equal(projects.getProject(ws, 'wrong-id-coin-fictional').identity.coingecko_id, 'wrong-id-fictional', 'never rebound automatically');
});

// Audit V2-007, reproduced again in review v3 (finding 6): with several
// chunks, a later request that failed before an answer (no connection, a
// timeout, an unreadable body) was counted as one call in all.
test('V2-007: every CoinGecko request a price refresh sends counts once, also when a later chunk fails on the network, times out or is unreadable; answered requests are counted apart', async (t) => {
  const { ws, root, cleanup } = tempWorkspace('mkt-v2007');
  t.after(cleanup);
  addFixtureProject(ws);
  const s = readJson(path.join(root, 'config', 'settings.json'));
  s.market_data = { enabled: true, max_ids_per_call: 2 };
  atomicWrite(path.join(root, 'config', 'settings.json'), jsonText(s));
  ws.reloadSettings();
  // bitcoin, tether, usd-coin and the fixture's token, two per request.
  assert.equal(market.trackedIds(ws).length, 4);
  const row = (id) => ({ id, symbol: id.slice(0, 4), name: id, current_price: 1.5, market_cap: 1e6, total_volume: 1e5, last_updated: new Date().toISOString() });
  const ok = (url) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => decodeURIComponent(new URL(url).searchParams.get('ids')).split(',').map(row) });
  const twoChunks = (second) => {
    const calls = [];
    const f = async (url) => {
      calls.push(url);
      return calls.length === 2 && second ? second(url) : ok(url);
    };
    f.calls = calls;
    return f;
  };
  const fresh = () => atomicWrite(ws.abs('market-data/status.json'), jsonText({ state: 'never_run' }));
  const counts = () => { const c = market.readStatus(ws).calls; return [c.month_count, c.day_count, c.month_answered, c.day_answered, c.remaining]; };
  const budget = market.callBudget(ws, market.readStatus(ws)).budget_monthly;
  const failures = [
    ['a network error', () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); }, /fetch failed \(ECONNRESET\)/],
    ['a timeout', () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }, /^Request timed out/],
    ['unreadable JSON', () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); } }), /^CoinGecko answered with unreadable JSON \(Unexpected token </],
    ['an answer that is not a list', () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ status: { error_code: 1 } }) }), /not a list/],
    ['HTTP 500', () => ({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) }), /HTTP 500/],
  ];
  for (const [what, second, message] of failures) {
    fresh();
    const f = twoChunks(second);
    const r = await market.refresh(ws, { fetchImpl: f, force: true });
    assert.equal(r.status, 'failed', what);
    assert.match(r.message, message, what);
    assert.equal(f.calls.length, 2, `${what}: two requests were sent`);
    assert.deepEqual(counts(), [2, 2, 1, 1, budget - 2], `${what} on the second request: both requests count once, one was answered`);
  }
  // The first request failing: one sent, none answered, nothing more sent.
  fresh();
  const first = twoChunks(null);
  await market.refresh(ws, { fetchImpl: async (url) => { first.calls.push(url); throw new TypeError('fetch failed'); }, force: true });
  assert.equal(first.calls.length, 1);
  assert.deepEqual(counts(), [1, 1, 0, 0, budget - 1]);
  // Counts add up across refreshes, each request once.
  fresh();
  await market.refresh(ws, { fetchImpl: twoChunks(null), force: true });
  assert.deepEqual(counts(), [2, 2, 2, 2, budget - 2]);
  await market.refresh(ws, { fetchImpl: twoChunks(() => { throw new TypeError('fetch failed'); }), force: true });
  assert.deepEqual(counts(), [4, 4, 3, 3, budget - 4]);
  // A month already counted by older code (no answered count) keeps its
  // count and says from when answers are counted.
  const today = require('../core/dates').ymdInTz();
  atomicWrite(ws.abs('market-data/status.json'), jsonText({ state: 'ok', calls: { month: today.slice(0, 7), month_count: 119, day: today, day_count: 3 } }));
  assert.equal(market.readStatus(ws).calls.month_answered, undefined);
  await market.refresh(ws, { fetchImpl: twoChunks(null), force: true });
  const c = market.readStatus(ws).calls;
  assert.deepEqual([c.month_count, c.day_count, c.month_answered, c.day_answered], [121, 5, 2, 2]);
  assert.ok(Date.parse(c.answered_counted_since) <= Date.now(), 'answers are counted from this refresh on, and it says so');
});
