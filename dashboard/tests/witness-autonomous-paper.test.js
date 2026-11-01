'use strict';
// The corrective PR's integration witness (2026-10-31, §6): the real scheduled
// path takes an already-enrolled pilot project from its Prosecutor's ticket to
// exactly one simulated fill on the Trader Sim book, and stops at every human
// intervention and authority change.
//
// What runs is the desk's own code: the settings write that arms the mandate
// (server.js applySettings), the contract observation and its storage, the
// pilot worker's claim, prepare and complete, the frozen packet and receipt,
// the hosted timer's own call (jobs.runJobs(HOSTED_TIMER_JOBS, { onlyDue:
// true })), the mandate's sweep and decision, the candle read with its
// binding and backfill, the adapter (trader-desk.js) and the protected book
// (paper-trader.js).
//
// What stands in, at the transport only: the chain's JSON-RPC node
// (tests/contract-world.js), GeckoTerminal (a fetch that answers its two
// routes and refuses every other host, so the other hosted jobs meet a
// refused network), and the Prosecutor's claude -p session (the fixture's
// answer, handed to the worker's complete). Two inputs are fixtures, named
// here so the witness is read for what it is: Claude's grade (stubGrade, 60)
// and the forensic exit readings (forensics.view: complete, 0.75% / 1.5% / 3%
// at $100 / $500 / $2,000, as tests/helpers.js withExitReadings), installed
// only while the worker prepares the ticket, so they are frozen into its
// packet. The clock is mocked (Date only). FICTIONAL workspace, token, pool
// and contracts; no provider, venue or wallet is reached.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const T = require('../core/tickets');
const TD = require('../core/trader-desk');
const PT = require('../core/paper-trader');
const PW = require('../core/pilot-worker');
const PC = require('../core/pilot-claims');
const CF = require('../core/contract-forensics');
const F = require('../core/forensics');
const jobs = require('../core/jobs');
const paper = require('../core/paper');
const { openWorkspace } = require('../core/workspace');
const { applySettings } = require('../server');
const H = require('./helpers');
const CW = require('./contract-world');
const TF = require('./trader-fixture');
const { stubGrade, noHoldings, CONSISTENT } = require('./mandate-fixture');
const MA = require('../core/mandate-authority');
const { ymdInTz } = require('../core/dates');

const HR = 3600000;
const MIN = 60000;
const iso = (ms) => new Date(ms).toISOString();
const KEY = 'FICTIONALkey_0123456789';
const PAIR = 'XMPL/USDC';
const QUOTE_ADDR = '0x0000000000000000000000000000000000000c0c';
const POOL = `0x${'d4'.padStart(40, '0')}`;
const BY = T.MANDATE_BY;
const DEEP = 352940n * CW.E18;

// GeckoTerminal at the transport: the token's one pool and its hours, newest
// first (the forming hour included, as the real API answers), at the mocked
// clock; lowOf(start) sets an hour's low. Any other host is refused.
function gecko(token, lowOf) {
  const calls = [];
  const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  const pool = { id: `base_${POOL}`, type: 'pool', attributes: { address: POOL, name: 'XMPL / USDC', reserve_in_usd: '600000', volume_usd: { h24: '40000' }, token_price_usd: '0.85' }, relationships: { base_token: { data: { id: `base_${token}`, type: 'token' } }, quote_token: { data: { id: `base_${QUOTE_ADDR}`, type: 'token' } }, dex: { data: { id: 'fictional-dex', type: 'dex' } } } };
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    if (u.origin !== 'https://api.geckoterminal.com') throw new Error(`FICTIONAL: no network to ${u.host}`);
    calls.push(u.pathname);
    if (/^\/api\/v2\/networks\/base\/tokens\/[^/]+\/pools$/.test(u.pathname)) return json({ data: [pool] });
    if (!/^\/api\/v2\/networks\/base\/pools\/[^/]+\/ohlcv\/hour$/.test(u.pathname)) throw new Error(`FICTIONAL: unexpected ${u.pathname}`);
    const top = Math.floor(Date.now() / HR) * HR;
    const rows = [];
    const limit = Math.min(Number(u.searchParams.get('limit')) || 100, 1000);
    for (let i = 0; i < limit; i++) {
      const start = top - i * HR;
      rows.push([start / 1000, 0.85, 0.86, lowOf(start), 0.85, 8600]);
    }
    return json({ data: { id: 'fict', type: 'ohlcv_request_response', attributes: { ohlcv_list: rows } }, meta: { base: { address: u.searchParams.get('token'), symbol: 'XMPL' }, quote: { address: QUOTE_ADDR, symbol: 'USDC' } } });
  };
  return { calls, fetchImpl };
}

// The forensic exit readings at the mocked clock, held across the worker's
// await (as withExitReadings, which is synchronous).
function exitReadings() {
  const real = F.view;
  F.view = () => {
    const at = iso(Date.now());
    const row = (size, cost) => ({ size_usd: size, status: 'current', as_of: at, note: null, best: { cost_pct: cost, cost_complete: true, missing_costs: [], method: 'executable_quote', route_scope: 'aggregator', retrieved_at: at } });
    return { liquidity: { exits: [row(100, 0.75), row(500, 1.5), row(2000, 3)] } };
  };
  return () => { F.view = real; };
}

// The witness's start unless a test names its own: 10:20 in New York (14:20
// UTC) on an ordinary autumn weekday, 20 minutes into an hour, so the path
// never depends on the hour, the day or the season the suite runs in
// (bounded paper readiness A3). It sits 13 days after the fixture reports'
// analysis date (2026-09-24), inside the 90-day research freshness limit:
// started from a real clock, the witness passed on 2026-11-20 and failed from
// 2026-12-24 on (research due again, so no Prosecutor was claimed). Every
// fixture below (prices, exit readings, the Prosecutor's answer, the
// contract node's block, GeckoTerminal's hours, the mandate's expiry) is made
// at the mocked clock.
const EPOCH = Date.parse('2026-10-07T14:20:00Z');

// A funded desk with one enrolled pilot project whose token is a contract on
// Base, observed through the fictional node (a 72-hour timelock: a review,
// never a block or a hold), the trader's rules and book and the mandate set
// by settings writes. The clock starts 20 minutes into an hour (H0).
async function witnessDesk(t, { expiresAt = null, at = EPOCH } = {}) {
  const T0 = at;
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const w = H.tempWorkspace('witness', {
    contracts: { daily_cu_cap: 1000000, monthly_cu_cap: 10000000, pool_factories: [CW.ROW], max_log_blocks: 1000, network_fee_ceiling_usd: { 8453: 0.5 } },
    tickets: { sizing: { min_grade_new_entry: 50 }, contract_gate: { mode: 'enforce' } },
  });
  t.after(w.cleanup);
  stubGrade(t, 60);
  noHoldings(t);
  const pid = H.addFixtureProject(w.ws).project_id;
  H.importAllFixtures(w.ws);
  const file = w.ws.abs(`projects/${pid}/project.json`);
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  p.identity.assets = [{ chain: 'base', contract_address: CW.TOKEN }];
  fs.writeFileSync(file, JSON.stringify(p, null, 2));
  T.setPilot(w.ws, pid, true, { by: 'eric' });
  H.freshPrice(w.ws, 'example-payfi-fictional', 0.85);
  // The contract suite's timelocked token in a pool ten times as deep as its
  // shallow one (same $0.85 price), so a $2,000 sale is proven on chain
  // within the 5% exit limit (CG-14) rather than waiting on it.
  const node = CW.world({ S: CW.baseState({ owner: CW.TL, minter: CW.TL, reserve_token: DEEP, reserve_quote: 300000n * 10n ** 6n, bal: { [CW.PAIR]: DEEP, [CW.BUYER]: 50000n * CW.E18 } }), tokenCode: CW.TOKEN_CODE, extra: CW.timelocks, block: CW.liveBlock(9001) });
  await CF.probeNetwork(w.ws, '8453', { fetchImpl: node.fetch, key: KEY, now: Date.now });
  const o = await CF.observeProject(w.ws, pid, { fetchImpl: node.fetch, key: KEY, sourceImpl: CW.sources, now: Date.now });
  assert.equal(o.results[0].status, 'saved', JSON.stringify(o.results[0]));
  applySettings(w.ws, { trader: { rules: { ...TF.RULES }, book: { ...TF.BOOK } } });
  applySettings(w.ws, { automation: { autonomous_paper_loop: true, mandate: { expires_at: expiresAt || iso(T0 + 7 * 24 * HR), allowed_chains: ['base'] } } });
  assert.equal(w.ws.settings.automation.mandate.authority.generation, 1, 'the arming is recorded as generation 1');
  // Quiet hours (low 0.84) until setLows says otherwise.
  let g = gecko(CW.TOKEN, () => 0.84);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...a) => g.fetchImpl(...a);
  t.after(() => { globalThis.fetch = realFetch; });
  return { ...w, pid, T0, H0: Math.floor(T0 / HR) * HR, gecko: () => g, setLows: (fn) => { g = gecko(CW.TOKEN, fn); } };
}

// The hosted timer's own call (server.js): every hosted job, only those due.
async function tick(ws) {
  const r = await jobs.runJobs(ws, jobs.HOSTED_TIMER_JOBS, { trigger: 'dashboard', onlyDue: true });
  return r.find((x) => x.job === 'trader');
}
const traderDue = (ws) => jobs.isDue(ws, 'trader', jobs.readJobState(ws), Date.now());

// Agent 2 through the pilot worker: claim, prepare (the desk opens the ticket
// and freezes its packet), the session's answer, complete (saved, verified).
async function prosecute(s) {
  // Enrollment approved an exit-quote target: until the desk's own reading at
  // the exit size is complete, no Prosecutor is claimed (§5).
  const early = PW.claimStep(s.ws, s.pid, { owner: 'witness' });
  assert.deepEqual([early.status, early.step, early.token], ['nothing', 'exit_evidence', null], early.words);
  const restore = exitReadings();
  let c;
  let p;
  try {
    c = PW.claimStep(s.ws, s.pid, { owner: 'witness' });
    assert.deepEqual([c.status, c.step], ['claimed_now', 'ticket'], c.words);
    p = await PW.prepare(s.ws, s.pid, c.token, { fetchImpl: async () => { throw new Error('FICTIONAL: no network'); } });
  } finally { restore(); }
  assert.equal(p.status, 'prepared', p.words);
  assert.equal(p.role, 'prosecutor');
  const tk = T.loadTicket(s.ws, s.pid, p.ticket_id);
  // The session writes at the (mocked) time it runs.
  const text = TF.answer(tk, {}, CONSISTENT).split(TF.AT).join(iso(Date.now()));
  const done = PW.complete(s.ws, s.pid, c.token, { text, prompt_sha256: p.prompt_sha256 });
  assert.equal(done.status, 'saved', done.words);
  return { ticket: tk, receipt_id: done.receipt_id, attempt_id: c.attempt_id };
}

const grants = (ws, pid) => T.readDecisions(ws, pid).filter((l) => l.decided_by === BY);
const opens = (ws) => PT.intents(ws).filter((i) => i.side === 'OPEN_LONG');
const hoursOf = (ws) => PT.hours(ws).find((h) => h.pair === PAIR) || null;
const openPositions = (ws) => PT.results(ws, { now: iso(Date.now()) }).open_positions;

// Up to the opening order: a grant, its pair's pool bound, its hours read and
// its buy ACKED at T0 (so the first hour that can fill it starts at H0 + 1h).
async function toOrder(t, opts) {
  const s = await witnessDesk(t, opts);
  // A cold desk: before the ticket, the trader has nothing to do.
  assert.equal(traderDue(s.ws), false, 'nothing for the trader before a ticket');
  const pros = await prosecute(s);
  const receipt = T.listReceipts(s.ws, s.pid).find((r) => r.receipt_id === pros.receipt_id);
  assert.equal(receipt.desk.suggested_risk_usd, 500, 'the gate sized the ticket at $500');
  assert.equal(receipt.desk.contract_gate.tier, 'review', 'the frozen contract attestation');
  assert.equal(T.integrityOf(s.ws, receipt).status, 'ok', 'the frozen packet reads back under its hash');
  // The scheduler's due check finds the mandate's work on a cold desk
  // (defect A: before, nothing was due until a pair was wanted).
  assert.equal(traderDue(s.ws), true, 'the pending grant makes the trader due');
  const tr = await tick(s.ws);
  assert.ok(tr && tr.mandate && tr.mandate.granted === 1, JSON.stringify(tr));
  const g = grants(s.ws, s.pid);
  assert.equal(g.length, 1, 'exactly one decision');
  const d = g[0];
  assert.deepEqual([d.action, d.receipt_id, d.mandate.authority.generation], ['approve', pros.receipt_id, 1]);
  const src = TD.sourceBindings(s.ws).get(PAIR);
  assert.ok(src, 'the pair has a bound pool');
  assert.deepEqual([src.project_id, src.contract_address.toLowerCase(), src.pool_address], [s.pid, CW.TOKEN.toLowerCase(), POOL], 'the pool bound to this token');
  assert.ok(hoursOf(s.ws) && hoursOf(s.ws).count >= 24, `the hours backfilled: ${JSON.stringify(hoursOf(s.ws))}`);
  const ints = opens(s.ws);
  assert.equal(ints.length, 1, `exactly one intended order: ${JSON.stringify(tr)} ${JSON.stringify(TD.requests(s.ws, {}).requests.map((x) => [x.phase, x.words, x.next]))}`);
  assert.equal(ints[0].intent_id, TD.intentIdOf(d, 'open'), 'its ID is derived from the decision');
  assert.equal(ints[0].state, 'ACKED', JSON.stringify(ints[0]));
  // Every hour from H0 on trades down to 0.79, below the buy's limit: the
  // first hour that can fill it is H0 + 1h.
  s.setLows((start) => (start >= s.H0 ? 0.79 : 0.84));
  return { ...s, pros, decision: d, intent: ints[0] };
}

test('witness: the scheduled path takes a pilot ticket to exactly one fill on the Trader Sim book, and never twice', async (t) => {
  const s = await toOrder(t);
  const { decision, intent } = s;
  // Repeated ticks in the same hour: nothing new.
  await tick(s.ws);
  await tick(s.ws);
  assert.equal(grants(s.ws, s.pid).length, 1);
  assert.equal(opens(s.ws).length, 1);
  // H0's hour closes: it started before the buy was sent, so it cannot fill it.
  t.mock.timers.tick(HR);
  await tick(s.ws);
  assert.equal(opens(s.ws)[0].state, 'ACKED', 'an hour that started before the order cannot fill it');
  assert.equal(openPositions(s.ws).length, 0);
  // H0 + 1h closes and settles: the first causally eligible hour fills it.
  t.mock.timers.tick(HR);
  await tick(s.ws);
  const order = PT.intents(s.ws).find((i) => i.intent_id === intent.intent_id);
  assert.ok(['FILLED', 'PARTIAL'].includes(order.state), `the buy filled (${JSON.stringify(order)})`);
  const res = PT.results(s.ws, { now: iso(Date.now()) });
  assert.equal(res.open_positions.length, 1, 'one position');
  const pos = res.open_positions[0];
  assert.equal(pos.pair, PAIR);
  // Limits in force: the ticket's stop, the loss at the stop within the
  // mandate's $500 grant, the notional within Eric's 25% of $25,000.
  assert.equal(Number(pos.stop_loss_price), 0.7);
  assert.ok(Number(pos.planned_loss_at_stop_usd) <= 500, `loss at stop ${pos.planned_loss_at_stop_usd} within the $500 grant`);
  assert.ok(Number(pos.notional_usd) <= 6250, `notional ${pos.notional_usd} within notional_max_pct`);
  // No PM Cohort position: the Trader Sim book only.
  assert.equal(fs.existsSync(s.ws.abs(paper.REL)), false, 'nothing in the PM Cohort');
  // A restart (a new workspace object on the same folder) and more ticks:
  // the same IDs, nothing twice.
  const ws2 = openWorkspace({ root: s.root, actor: 'test' });
  await tick(ws2);
  t.mock.timers.tick(5 * MIN);
  await tick(ws2);
  await tick(ws2);
  assert.equal(grants(ws2, s.pid).length, 1, 'one decision after the restart');
  assert.deepEqual(opens(ws2).map((i) => i.intent_id), [intent.intent_id], 'one intended order, the same ID');
  assert.equal(PT.results(ws2, { now: iso(Date.now()) }).open_positions.length, 1, 'one position after the restart');
  assert.equal(decision.receipt_id, s.pros.receipt_id, 'the decision is on the worker\'s receipt');
  // One Prosecutor session: the durable record is the worker's attempt, on
  // the New York day it was bound, and that day's view at an explicit instant.
  const ledger = fs.readFileSync(ws2.abs(PC.SESSIONS_REL), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const day = ymdInTz(new Date(s.T0));
  assert.deepEqual(ledger.map((r) => [r.attempt_id, r.day, r.project_id, r.step]), [[s.pros.attempt_id, day, s.pid, 'ticket']]);
  assert.deepEqual(PC.sessionsView(ws2, s.T0), { day, used: 1, ceiling: 6, left: 5, unreadable: false }, 'one Prosecutor session counted');
  // The status output names the next action, the authority and every ID.
  const [row] = MA.statusRows(ws2, T.pilotQueue(ws2), { sessions: PC.sessionsView(ws2) });
  assert.equal(row.blocker, null, JSON.stringify(row));
  assert.deepEqual([row.authority.mandate.on, row.authority.mandate.generation, row.authority.autonomy.suspended], [true, 1, false]);
  assert.deepEqual([row.authority.grant.authority, row.authority.grant.phase, row.authority.grant.order_state], ['holds', 'open', PT.intents(ws2).find((i) => i.intent_id === intent.intent_id).state]);
  assert.deepEqual([row.ids.decision_id, row.ids.intent_id, row.ids.receipt_id, row.ids.client_order_id], [decision.decision_id, intent.intent_id, s.pros.receipt_id, `cr2-${intent.intent_id}`]);
  const polled = require('../core/pilot-poll').pollBody(ws2).status[0];
  assert.deepEqual([polled.next_action, polled.blocked, polled.ids.decision_id, polled.authority.grant.authority], [row.next_action, false, decision.decision_id, 'holds']);
  assert.ok(!JSON.stringify(polled).includes('"words"') && !('blocker' in polled), 'the poll carries codes and IDs, no words');
});

// Each intervention after the buy is ACKED and before its first eligible
// hour closes: the next hour is still applied (settlement goes on), the buy
// is cancelled before any hour can fill it, nothing opens, and with nothing
// live or held the pair is no longer wanted, so no further hours are read.
const cancelled = (s) => {
  const ord = PT.intents(s.ws).find((i) => i.intent_id === s.intent.intent_id);
  assert.equal(ord.state, 'CANCELLED', JSON.stringify(ord));
  assert.ok(!(Number(ord.filled) > 0), `nothing filled: ${JSON.stringify(ord)} ${JSON.stringify(PT.results(s.ws, { now: iso(Date.now()) }).closed_positions)}`);
  assert.equal(openPositions(s.ws).length, 0, 'nothing opened');
  assert.ok(Date.parse(hoursOf(s.ws).last_hour) >= s.H0, 'the hour after the intervention was applied');
  assert.equal(grants(s.ws, s.pid).length, 1, 'no new grant');
  assert.equal(opens(s.ws).length, 1, 'no new order');
};
const INTERVENTIONS = [
  ['Eric pauses automation', (s) => applySettings(s.ws, { automation: { paused: true } })],
  ['Eric turns the mandate off', (s) => applySettings(s.ws, { automation: { autonomous_paper_loop: false } })],
  ['Eric stops this project\'s autonomy', (s) => T.setAutonomy(s.ws, s.pid, { action: 'stop', note: 'witness', request_id: 'req_witness_stop1', by: 'eric' })],
];
for (const [name, act] of INTERVENTIONS) {
  test(`witness: ${name}: the opening is cancelled before an hour can fill it; the hours still apply`, async (t) => {
    const s = await toOrder(t);
    t.mock.timers.tick(HR);
    await tick(s.ws);
    assert.equal(PT.intents(s.ws).find((i) => i.intent_id === s.intent.intent_id).state, 'ACKED', 'live after H0\'s hour');
    // Between hours: the next tick's candle read meets the eligible hour
    // before the book's step runs, so the cancel must come before the hour.
    act(s);
    // The status output says what blocks the project now, with the grant's code.
    const [row] = MA.statusRows(s.ws, T.pilotQueue(s.ws), { sessions: PC.sessionsView(s.ws) });
    assert.ok(row.blocker, JSON.stringify(row));
    assert.notEqual(row.authority.grant.authority, 'holds', JSON.stringify(row.authority));
    assert.equal(row.ids.decision_id, s.decision.decision_id);
    t.mock.timers.tick(HR);
    const tr = await tick(s.ws);
    cancelled(s);
    assert.equal(hoursOf(s.ws).last_hour, iso(s.H0 + HR), `the eligible hour was applied after the cancel: ${tr && tr.summary}`);
  });
}

test('witness: the mandate expires inside the first eligible hour: that hour cancels the buy instead of filling it', async (t) => {
  // Armed to expire at H0 + 1h30m: H0's hour ends inside it, H0 + 1h's after.
  const T0 = EPOCH;
  const s = await toOrder(t, { expiresAt: iso(Math.floor(T0 / HR) * HR + HR + 30 * MIN) });
  t.mock.timers.tick(HR);
  await tick(s.ws);
  assert.equal(PT.intents(s.ws).find((i) => i.intent_id === s.intent.intent_id).state, 'ACKED', 'live while the mandate covers the hour');
  t.mock.timers.tick(HR);
  await tick(s.ws);
  cancelled(s);
  assert.equal(hoursOf(s.ws).last_hour, iso(s.H0 + HR), 'the hour that ends after the expiry was applied, after the cancel');
});

test('witness: after the fill, a pause opens nothing new but the stop still closes the position (risk reduction goes on)', async (t) => {
  const s = await toOrder(t);
  t.mock.timers.tick(HR);
  await tick(s.ws);
  t.mock.timers.tick(HR);
  await tick(s.ws);
  assert.equal(openPositions(s.ws).length, 1, 'filled');
  applySettings(s.ws, { automation: { paused: true } });
  // H0 + 2h trades through the stop ($0.70).
  s.setLows((start) => (start >= s.H0 + 2 * HR ? 0.69 : start >= s.H0 ? 0.79 : 0.84));
  t.mock.timers.tick(HR);
  await tick(s.ws);
  const res = PT.results(s.ws, { now: iso(Date.now()) });
  assert.equal(res.open_positions.length, 0, 'the stop closed it while paused');
  assert.equal(res.closed_positions.length, 1);
  assert.equal(opens(s.ws).length, 1, 'nothing new opened');
});
