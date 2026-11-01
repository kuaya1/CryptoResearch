'use strict';
// The Paper Book's hourly candles (core/trader-candles.js, blueprint slot
// 12b): closed pool hours from GeckoTerminal for the pairs the desk's adapter
// wants, one frozen pool per pair, under a budget, a 429 gate and the
// restored-copy hold. Temporary workspaces, fictional projects, contracts,
// pools and hours, and a fake GeckoTerminal only: no request leaves the test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempWorkspace, addFixtureProject, importAllFixtures, withExitReadings, freshPrice } = require('./helpers');
const T = require('../core/tickets');
const TD = require('../core/trader-desk');
const PT = require('../core/paper-trader');
const C = require('../core/trader-candles');
const A = require('../core/call-accounting');
const MC = require('./meter-cases');
const { ymdInTz } = require('../core/dates');

const H = 3600000;
const M = 60000;
const iso = (ms) => new Date(ms).toISOString();
const PAIR = 'XMPL/USDC';
const RULES = { stop_min_pct: '0.01', stop_min_atr: '1', notional_max_pct: '0.25', max_validity_minutes: 180, allowlist: [PAIR] };
const BOOK = { cash_usd: '25000', fee_rate: '0.003' };
// FICTIONAL addresses: none is a real contract or pool.
const TOKEN = '0x00000000000000000000000000000000000f1c71';
const QUOTE = '0x0000000000000000000000000000000000000c0c';
const OTHER = '0x0000000000000000000000000000000000000b0b';
const POOL = (tag) => `0x${tag.padStart(40, '0')}`;
const POOL_V4 = `0x${'d4'.padStart(64, '0')}`;
const noSleep = async () => {};

// The Prosecutor's answer for a ticket (as in trader-desk.test.js): an
// ACCUMULATE between $0.80 and $0.90, stop $0.70, target $1.40 (FICTIONAL).
const AT = new Date().toISOString();
function answer(ticket) {
  const b = {
    format: T.FORMAT, ticket_id: ticket.ticket_id, project_id: ticket.project_id, prompt_version: T.PROMPT_VERSION, role: 'prosecutor', model: 'claude', model_version: 'claude-test', as_of: AT,
    researcher_report_id: ticket.basis.researcher.report_id, researcher_report_sha256: ticket.basis.researcher.original.sha256,
    prosecution: {
      verdict: 'thesis_damaged', conviction_score: 38,
      tests: { mercenary_emissions: { result: 'fail', finding: 'Rewards exceed fees (FICTIONAL).', source_ids: ['S1'] }, tax_revenue: { result: 'pass', finding: '' }, exit_slippage: { result: 'unknown', finding: 'No reading.' }, unverified_claims: { result: 'pass', finding: '' } },
      fatal_flaws: [{ test: 'mercenary_emissions', severity: 'fatal', finding: 'Activity is paid for by emissions (FICTIONAL).', source_ids: ['S1'] }],
      strongest_bull_rebuttal: 'Emissions taper next quarter.',
    },
    proposal: {
      proposal_type: 'ACCUMULATE',
      non_consensus_thesis: 'The market assumes organic demand; the evidence shows paid activity; the emission cut in Q1 makes the difference observable.',
      entry_zone: { low_usd: 0.8, high_usd: 0.9, basis: 'prior range' },
      upside_target: { price_usd: 1.4, basis: 'fees double' },
      invalidation_trigger: { price_usd: 0.7, metric: { key: 'fees', below_30d_usd: 100000 }, statement: 'Below $0.70 or fees under $100k a month.' },
    },
    agent_disagreement_note: 'The researcher grades 60.5 on product reality; I score 38 on emissions.',
    sources: [{ source_id: 'S1', url: 'https://example.com/xmpl/emissions', publisher: 'Example (FICTIONAL)', retrieved_at: AT, excerpt: 'fictional' }],
  };
  return `# Prosecution (FICTIONAL)\n\n${'The four tests and the flaws, written out for the test fixture. '.repeat(12)}\n\n\`\`\`json\n${JSON.stringify(b, null, 2)}\n\`\`\`\n`;
}

// A fictional desk with a Prosecutor's ticket sized at $500 and Eric's
// Halve ($250) waiting for hours. `onBase` moves the project's contract to
// a fictional address on Base, a network the hourly read lists.
function deskWith(t, { onBase = true, funded = true } = {}) {
  const w = tempWorkspace('trader-candles');
  t.after(w.cleanup);
  const pid = addFixtureProject(w.ws).project_id;
  importAllFixtures(w.ws);
  const portfolio = require('../core/portfolio');
  const real = portfolio.computePortfolio;
  portfolio.computePortfolio = (...a) => ({ ...real(...a), positions: [] });
  t.after(() => { portfolio.computePortfolio = real; });
  const tk = withExitReadings(1.5, () => T.createTicket(w.ws, { project_id: pid, assistant: true })).ticket;
  freshPrice(w.ws, 'example-payfi-fictional', 0.85);
  const saved = T.saveTicket(w.ws, { project_id: pid, ticket_id: tk.ticket_id, text: answer(T.loadTicket(w.ws, pid, tk.ticket_id)) });
  if (onBase) {
    const f = w.ws.abs(`projects/${pid}/project.json`);
    const p = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.equal(p.identity.status, 'verified', 'the fixture project has a verified identity');
    p.identity.assets = [{ ...p.identity.assets[0], chain: 'base', contract_address: TOKEN }];
    fs.writeFileSync(f, JSON.stringify(p, null, 2));
  }
  if (funded) w.ws.settings.trader = { rules: { ...RULES }, book: { ...BOOK } };
  const hv = T.decide(w.ws, pid, { receipt_id: saved.receipt_id, action: 'halve', request_id: 'req_12b_halve001' });
  return { ...w, pid, rid: saved.receipt_id, halve: hv.result.decision };
}

// A run's clock: at least 15 minutes into the hour, so the hour that just
// closed has settled and the counts below hold at any minute.
function clockFrom(ms = Date.now()) {
  const top = Math.floor(ms / H) * H;
  return { top, t: Math.max(ms, top + 15 * M) };
}

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const pool = (address, { base = TOKEN, quote = QUOTE, price = '0.85', reserve = '150000', vol = '40000', name = 'XMPL / USDC', dex = 'fictional-dex' } = {}) => ({
  id: `base_${address}`, type: 'pool',
  attributes: { address, name, reserve_in_usd: reserve, volume_usd: { h24: vol }, token_price_usd: price },
  relationships: { base_token: { data: { id: `base_${base}`, type: 'token' } }, quote_token: { data: { id: `base_${quote}`, type: 'token' } }, dex: { data: { id: dex, type: 'dex' } } },
});
// GeckoTerminal's order for the token's pools: another token's pool, one
// priced three times off, one with no trade in 24 hours, the one the rule
// takes, and a deeper reserve after it that the rule never reaches.
const POOLS = { data: [pool(POOL('a1'), { base: OTHER }), pool(POOL('b2'), { price: '2.6' }), pool(POOL('c3'), { vol: '0' }), pool(POOL_V4, { base: QUOTE, quote: TOKEN }), pool(POOL('e5'), { reserve: '9000000' })] };

// A fake GeckoTerminal: the token's pools, and a pool's hours newest first
// at the run's clock (the hour in progress first), as many as `limit`, less
// the hours named in `skip` (no trade, so GeckoTerminal leaves them out).
function gecko(clock, { pools = () => json(POOLS), skip = () => [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    calls.push(u);
    assert.equal(u.origin, 'https://api.geckoterminal.com');
    assert.equal(opts.redirect, 'error');
    if (/^\/api\/v2\/networks\/base\/tokens\/[^/]+\/pools$/.test(u.pathname)) return pools(u);
    const m = /^\/api\/v2\/networks\/base\/pools\/([^/]+)\/ohlcv\/hour$/.exec(u.pathname);
    assert.ok(m, `an unexpected request: ${u.pathname}`);
    const top = Math.floor(clock.t / H) * H;
    const rows = [];
    for (let i = 0; rows.length < Number(u.searchParams.get('limit')) && i < 2000; i++) {
      const start = top - i * H;
      if (!skip().includes(start)) rows.push([start / 1000, 0.85, 0.86, 0.84, 0.85, 8600]);
    }
    return json({ data: { id: 'fict', type: 'ohlcv_request_response', attributes: { ohlcv_list: rows } }, meta: { base: { address: u.searchParams.get('token'), symbol: 'XMPL' }, quote: { address: QUOTE, symbol: 'USDC' } } });
  };
  return { calls, fetchImpl };
}
const run = (ws, clock, g) => C.refresh(ws, { trigger: 'test', fetchImpl: g.fetchImpl, sleep: noSleep, now: clock.t });
const tree = (root) => fs.readdirSync(root, { recursive: true }).sort().map((p) => `${p}:${fs.statSync(path.join(root, p)).mtimeMs}`).join('\n');

test('a closed hour is read as the book reads it: plain decimals at 18 places, the hour in progress and an unsettled one left out, volume in tokens at the high', () => {
  assert.deepEqual([0.85, 1e-7, 2.5e-12, 1e21, '0.86', 3].map((x) => C.dec18(x)), ['0.85', '0.0000001', '0.0000000000025', '1000000000000000000000', '0.86', '3']);
  assert.deepEqual([0, -1, NaN, Infinity, null, '1,5', 1e-19].map((x) => C.dec18(x)), [null, null, null, null, null, null, null], 'unknown is never 0');
  assert.equal(C.dec18(0, { zero: true }), '0', 'a volume may be 0');
  const top = Date.UTC(2026, 9, 28, 15);
  assert.equal(C.latestSettled(top + 9 * M), top - 2 * H, 'the hour that closed at the top settles 10 minutes after it');
  assert.equal(C.latestSettled(top + 10 * M), top - H);
  const row = (start, over = []) => [start / 1000, 0.85, 0.86, 0.84, 0.85, 8600].map((v, i) => (over[i] !== undefined ? over[i] : v));
  const rows = [row(top), row(top - H), row(top - 2 * H), row(top - 3 * H)];
  const a = C.barsOf(PAIR, rows, { t: top + 20 * M });
  assert.equal(a.stopped, null);
  assert.deepEqual(a.bars.map((b) => b.hour), [iso(top - 3 * H), iso(top - 2 * H), iso(top - H)], 'oldest first; the hour in progress is never used');
  assert.deepEqual(a.bars[0], { pair: PAIR, hour: iso(top - 3 * H), open: '0.85', high: '0.86', low: '0.84', close: '0.85', volume: '10000' }, '$8,600 at a high of $0.86 is 10,000 tokens');
  assert.deepEqual(C.barsOf(PAIR, rows, { t: top + 5 * M }).bars.map((b) => b.hour), [iso(top - 3 * H), iso(top - 2 * H)], 'the hour that just closed waits to settle');
  assert.deepEqual(C.barsOf(PAIR, rows, { t: top + 20 * M, after: top - 2 * H }).bars.map((b) => b.hour), [iso(top - H)], 'only the hours after the last on record');
  assert.equal(C.barsOf(PAIR, [row(top - H, [undefined, 0.85, 0.86, 0.84, 0.85, 3])], { t: top + 20 * M }).bars[0].volume, '3.488372093023255813', 'cut at the 18th place: never more tokens than traded');
  const bad = C.barsOf(PAIR, [row(top - H), row(top - 2 * H, [undefined, 0.85, 0.86, 0.87])], { t: top + 20 * M });
  assert.deepEqual(bad.bars, [], 'a bad hour stops its pair there: the hours after it would be a gap');
  assert.match(bad.stopped, /low and high do not hold the open and close/);
  assert.match(C.barsOf(PAIR, [row(top - H), row(top - H, [undefined, 0.9])], { t: top + 20 * M }).stopped, /twice with different prices/);
});

test('one pool per contract, by GeckoTerminal\'s own order: never another token\'s, never one priced off CoinGecko\'s, never one with no trade; never a guess for a native coin', () => {
  const tg = C.targetOf({ identity: { status: 'verified', coingecko_id: 'x', assets: [{ chain: 'base', contract_address: TOKEN }] } });
  assert.deepEqual(tg, { network: 'base', chain_id: '8453', chain_label: 'Base', family: 'evm', contract_address: TOKEN, coingecko_id: 'x' });
  assert.equal(C.targetOf({ identity: { status: 'verified', coingecko_id: 'x', assets: [{ chain: 'robinhood', contract_address: TOKEN }, { chain: 'ethereum', contract_address: TOKEN }] } }).network, 'eth', 'the first contract on a network it reads');
  assert.match(C.targetOf({ identity: { status: 'verified', coingecko_id: 'bitcoin-fictional', assets: [] } }).why, /a native coin has none/);
  assert.match(C.targetOf({ identity: { status: 'verified', coingecko_id: 'x', assets: [{ chain: 'example-chain', contract_address: 'FICTIONAL' }] } }).why, /no contract on a network/);
  assert.match(C.targetOf({ identity: { status: 'pending', coingecko_id: 'x', assets: [{ chain: 'base', contract_address: TOKEN }] } }).why, /not verified/);
  const pick = C.pickPool(POOLS, tg, 0.85);
  assert.equal(pick.pool.pool_address, POOL_V4, 'the first that holds the token, trades and prices it near CoinGecko, even as the quote side; a 32-byte pool ID reads');
  assert.equal(pick.pool.token_side, 'quote');
  assert.equal(C.pickPool(POOLS, { ...tg, contract_address: TOKEN.toUpperCase().replace('0X', '0x') }, 0.85).pool.pool_address, POOL_V4, 'an EVM address in any case');
  assert.match(C.pickPool(POOLS, tg, 0.3).why, /within 2x of CoinGecko's/, 'every pool priced more than twice off is left');
  assert.match(C.pickPool({}, tg, 0.85).why, /lists no pools/);
  assert.equal(C.poolsPath(tg), `/networks/base/tokens/${TOKEN}/pools?page=1`);
  assert.equal(C.hoursPath({ network: 'base', pool_address: POOL_V4, contract_address: TOKEN }, 26), `/networks/base/pools/${POOL_V4}/ohlcv/hour?aggregate=1&limit=26&currency=usd&token=${TOKEN}`);
  assert.match(C.readHours({ data: { attributes: { ohlcv_list: [] } }, meta: { base: { address: QUOTE } } }, { chain_id: '8453', contract_address: TOKEN }).why, /not priced as this token/);
});

test('12b end to end: the hourly read freezes one pool, hands the book its closed hours, the Halve is ordered; a later run asks the same pool for the next hour only', async (t) => {
  const s = deskWith(t);
  const { ws, pid, halve } = s;
  assert.equal(TD.wanted(ws)[0].pair, PAIR, 'the Halve waits for hours');
  const clock = clockFrom();
  const { top } = clock;
  assert.equal(C.isDue(ws, clock.t), true);

  // 1. The first run: GeckoTerminal's pools, then 24 hours of the chosen one
  // (asked for 26: the hour in progress and one settling come back too).
  const g = gecko(clock);
  const r1 = await run(ws, clock, g);
  assert.equal(r1.status, 'ok', r1.message);
  assert.deepEqual(g.calls.map((u) => u.pathname), [`/api/v2/networks/base/tokens/${TOKEN}/pools`, `/api/v2/networks/base/pools/${POOL_V4}/ohlcv/hour`]);
  assert.equal(g.calls[1].searchParams.get('limit'), '26');
  assert.equal(g.calls[1].searchParams.get('token'), TOKEN, 'priced as the token itself');
  assert.equal(r1.counts.hours, 25);
  assert.deepEqual(PT.hours(ws), [{ pair: PAIR, first_hour: iso(top - 25 * H), last_hour: iso(top - H), count: 25 }]);
  const bars = fs.readFileSync(ws.abs(PT.JOURNAL), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'bar');
  assert.deepEqual([bars[0].open, bars[0].high, bars[0].low, bars[0].close, bars[0].volume], ['0.85', '0.86', '0.84', '0.85', '10000']);
  assert.equal(PT.results(ws, { now: iso(clock.t) }).funded_usd, '25000', 'funded from Eric\'s setting before the first hour');
  const src = C.readSources(ws).get(PAIR);
  assert.deepEqual([src.pair, src.project_id, src.network, src.contract_address, src.pool_address, src.token_side, src.coingecko_price_usd, src.version], [PAIR, pid, 'base', TOKEN, POOL_V4, 'quote', 0.85, 'cr-trader-candles@1']);
  assert.equal(src.rule, C.RULE);
  // The adapter's step ran after the hours: the Halve's order, as 12a sized it.
  assert.deepEqual(r1.counts.step, { done: 1, problems: 0 });
  const ord = PT.intents(ws).find((i) => i.intent_id === TD.intentIdOf(halve, 'open'));
  assert.deepEqual([ord.state, ord.side, ord.pair, ord.quantity], ['ACKED', 'OPEN_LONG', PAIR, '1598.519131']);
  const status = fs.readFileSync(ws.abs(C.STATUS_REL), 'utf8');
  for (const x of [TOKEN, POOL_V4, 'geckoterminal.com']) assert.ok(!status.toLowerCase().includes(x.toLowerCase()), `the status file holds no ${x}`);

  // 2. Asked since the hour settled: nothing more this hour.
  assert.equal(C.isDue(ws, clock.t + 5 * M), false);
  const g0 = gecko({ t: clock.t + 5 * M });
  assert.equal((await run(ws, { t: clock.t + 5 * M }, g0)).status, 'noop');
  assert.equal(g0.calls.length, 0);

  // 3. The next hour: the frozen pool, whatever GeckoTerminal's order says
  // now; one hour asked for (three rows), one hour applied.
  const c2 = { t: clock.t + H };
  assert.equal(C.isDue(ws, c2.t), true);
  const g2 = gecko(c2, { pools: () => json({ data: [pool(POOL('e5'), { reserve: '9000000' }), ...POOLS.data] }) });
  const r2 = await run(ws, c2, g2);
  assert.equal(r2.status, 'ok', r2.message);
  assert.deepEqual(g2.calls.map((u) => u.pathname), [`/api/v2/networks/base/pools/${POOL_V4}/ohlcv/hour`], 'the pool is never chosen again');
  assert.equal(g2.calls[0].searchParams.get('limit'), '3');
  assert.equal(r2.counts.hours, 1);
  assert.equal(PT.hours(ws)[0].last_hour, iso(top));
  assert.equal(fs.readFileSync(ws.abs(C.SOURCES_REL), 'utf8').trim().split('\n').length, 1, 'the source is written once');

  // 4. An hour with no trade: GeckoTerminal leaves it out and it is never
  // filled in. The pair waits for the next hour; then, holding a live order,
  // the book refuses the gap, and that is said.
  const c3 = { t: clock.t + 2 * H };
  const gap = top + H;
  const r3 = await run(ws, c3, gecko(c3, { skip: () => [gap] }));
  assert.equal(r3.counts.hours, 0);
  assert.equal(C.isDue(ws, c3.t + 5 * M), false, 'asked since that hour settled');
  const c4 = { t: clock.t + 3 * H };
  assert.equal(C.isDue(ws, c4.t), true);
  const r4 = await run(ws, c4, gecko(c4, { skip: () => [gap] }));
  assert.equal(r4.status, 'attention');
  assert.equal(r4.counts.hours, 0);
  assert.ok(r4.counts.problems.some((p) => p.code === 'GAP' && /an open position or a live order/.test(p.words)), JSON.stringify(r4.counts.problems));
  assert.equal(PT.hours(ws)[0].last_hour, iso(top), 'no hour after the gap is applied');
  assert.match(r4.message, /refused by the book/);

  // The view says where the hours come from, and reading it writes nothing.
  const before = tree(ws.root);
  const v = C.statusView(ws, c4.t);
  assert.deepEqual(v.sources, [{ pair: PAIR, project_id: pid, network: 'base', pool_name: 'XMPL / USDC', dex: 'fictional-dex', chosen_at: iso(clock.t) }]);
  assert.ok(v.requests_today >= 1);
  C.isDue(ws, c4.t);
  assert.equal(tree(ws.root), before);
});

test('a contract on a network the read does not list asks nothing and says why; the pair waits 6 hours before it is tried again', async (t) => {
  const s = deskWith(t, { onBase: false });
  const clock = clockFrom();
  const g = gecko(clock);
  const r = await run(s.ws, clock, g);
  assert.equal(g.calls.length, 0);
  assert.equal(r.status, 'attention');
  assert.match(r.message, /no contract on a network this desk reads hourly candles for/);
  assert.equal(C.isDue(s.ws, clock.t + H), false);
  assert.equal(C.isDue(s.ws, clock.t + 6 * H + M), true);
});

test('a 429 closes the gate until its Retry-After: nothing more is sent, and the job is not due', async (t) => {
  const s = deskWith(t);
  const clock = clockFrom();
  const g = gecko(clock, { pools: () => json({ status: { error_code: 429 } }, 429, { 'retry-after': '600' }) });
  const r = await run(s.ws, clock, g);
  assert.equal(r.status, 'attention');
  assert.equal(g.calls.length, 1);
  assert.match(r.message, /GeckoTerminal asked to wait until/);
  assert.equal(C.isDue(s.ws, clock.t + 5 * M), false);
  const g2 = gecko(clock);
  const again = await run(s.ws, { t: clock.t + 5 * M }, g2);
  assert.equal(again.status, 'backoff');
  assert.equal(g2.calls.length, 0);
  assert.equal(C.isDue(s.ws, clock.t + 11 * M), true, 'open again after the wait');
});

test('an error backs off; the day\'s request budget stops the read before anything is sent', async (t) => {
  const s = deskWith(t);
  const clock = clockFrom();
  const r = await run(s.ws, clock, { fetchImpl: async () => { throw new Error('FICTIONAL: socket closed'); } });
  assert.equal(r.status, 'attention');
  assert.match(r.message, /did not answer \(FICTIONAL: socket closed\)/);
  assert.equal(C.isDue(s.ws, clock.t + M), false, 'a backoff of about 15 minutes');
  const day = ymdInTz(new Date(clock.t + H));
  fs.writeFileSync(s.ws.abs(C.STATUS_REL), JSON.stringify({ schema_version: 'cr.trader-candles-status.v1', calls: { month: day.slice(0, 7), month_count: C.DAILY_BUDGET, day, day_count: C.DAILY_BUDGET } }));
  const g = gecko(clock);
  const b = await run(s.ws, { t: clock.t + H }, g);
  assert.equal(b.status, 'budget_paused');
  assert.equal(g.calls.length, 0);
  assert.match(b.message, /the request budget is used up/);
});

test('nothing is asked until Eric funds the book, and a restored copy asks nothing until it is released', async (t) => {
  const s = deskWith(t, { funded: false });
  const clock = clockFrom();
  const g = gecko(clock);
  assert.equal(C.isDue(s.ws, clock.t), false);
  assert.equal((await run(s.ws, clock, g)).status, 'noop');
  s.ws.settings.trader = { rules: { ...RULES }, book: { ...BOOK } };
  fs.writeFileSync(s.ws.abs('config/restored-copy.json'), JSON.stringify({ research_held: true }));
  assert.equal(C.isDue(s.ws, clock.t), false);
  assert.equal((await run(s.ws, clock, g)).status, 'held');
  assert.equal(g.calls.length, 0);
  assert.equal(fs.existsSync(s.ws.abs(PT.JOURNAL)), false, 'the book is untouched');
  // As a job: skipped in a restored copy, before any network.
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('no request may leave the test'); };
  t.after(() => { global.fetch = realFetch; });
  const j = await require('../core/jobs').runJob(s.ws, 'trader', { trigger: 'test' });
  assert.equal(j.status, 'skipped');
});

// Bounded paper readiness A2: the provider-meter matrix (tests/meter-cases.js,
// call-accounting.test.js for the other three meters) through the hourly read.
test('an unusable request count asks GeckoTerminal nothing and keeps the file as it is; the book still steps on stored hours and the impairment is said; a usable one asks', async (t) => {
  const s = deskWith(t);
  const clock = clockFrom();
  const g = gecko(clock);
  for (const c of MC.invalidCases('candles', clock.t)) {
    MC.put(s.ws, C.STATUS_REL, c);
    const before = MC.stored(s.ws, C.STATUS_REL);
    const r = await run(s.ws, clock, g);
    assert.equal(r.status, 'held', `${c.name}: ${r.message}`);
    assert.equal(r.accounting_unknown, true);
    assert.match(r.message, /^Candle collection stopped: GeckoTerminal's candle read's request count \(market-data\/trader\/candles-status\.json\) cannot be used: .+ The book's step ran on the hours already stored \(\d+ done, \d+ problems?\); a stop or fill that needs a newer hour cannot be evaluated until then\.$/);
    assert.ok(r.counts.step, `${c.name}: the step ran`);
    assert.equal(g.calls.length, 0, `${c.name}: nothing was sent`);
    assert.equal(MC.stored(s.ws, C.STATUS_REL), before, `${c.name}: the file is kept as it is`);
    const v = C.statusView(s.ws, clock.t);
    assert.ok(v.accounting_unknown, `${c.name}: the view says so`);
    assert.deepEqual([v.requests_today, v.requests_this_month], [null, null], `${c.name}: never shown as 0`);
  }
  assert.equal(PT.hours(s.ws).length, 0, 'no hour was taken while the count could not be used');
  MC.put(s.ws, C.STATUS_REL, { absent: true });
  const ok = await run(s.ws, clock, g);
  assert.equal(ok.status, 'ok', ok.message);
  assert.equal(g.calls.length, 2, 'the same desk asks with a count it can use');
  const written = A.classify('candles', () => fs.readFileSync(s.ws.abs(C.STATUS_REL), 'utf8'));
  assert.equal(written.unknown, null, 'the writer\'s output reads');
  assert.deepEqual([written.status.calls.month_count, written.status.calls.day_count], [2, 2]);
});

test('a request count that goes bad while a candle request is out is kept as it is: no further request, and the run ends held', async (t) => {
  const s = deskWith(t);
  const clock = clockFrom();
  const bad = '{"schema_version": "cr.trader-candles-status.v1", "calls": {"month": "2026-11", "month_count": 1e999}}\n';
  const g = gecko(clock);
  const fetchImpl = async (url, opts) => {
    const res = await g.fetchImpl(url, opts);
    fs.writeFileSync(s.ws.abs(C.STATUS_REL), bad);
    return res;
  };
  const r = await run(s.ws, clock, { fetchImpl });
  assert.equal(r.status, 'held', r.message);
  assert.equal(g.calls.length, 1, 'the pools request was out; the hours were never asked');
  assert.equal(fs.readFileSync(s.ws.abs(C.STATUS_REL), 'utf8'), bad, 'finalizing the run did not overwrite it');
  assert.equal((await run(s.ws, clock, g)).status, 'held');
  assert.equal(g.calls.length, 1);
});

test('the job runs on the desk\'s 30-minute timer, and the read reaches the trader only through the adapter and the network only at GeckoTerminal', () => {
  assert.ok(require('../core/jobs').JOB_NAMES.includes('trader'));
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // The timer's list lives in jobs.js (HOSTED_TIMER_JOBS, intake plan rev. 2 §4).
  assert.ok(require('../core/jobs').HOSTED_TIMER_JOBS.includes('trader'));
  assert.match(server, /const DAILY_JOBS = jobs\.HOSTED_TIMER_JOBS;/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'trader-candles.js'), 'utf8');
  assert.doesNotMatch(src, /require\(\s*'\.\/(paper-trader|trade-risk|paper)'\s*\)/);
  assert.match(src, /require\('\.\/trader-desk'\)/);
  for (const re of [/process\.env/, /secrets/i, /api[_-]?key/i, /wallet/i, /\beval\(/]) assert.doesNotMatch(src, re, String(re));
  assert.deepEqual([...new Set(src.match(/https?:\/\/[a-z0-9.-]+/gi))], ['https://api.geckoterminal.com'], 'one origin');
  assert.equal(C.ORIGIN, 'https://api.geckoterminal.com');
});
