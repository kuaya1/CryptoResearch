'use strict';
// The corrective PR's regressions (2026-10-31): one test per finding, each
// written to fail on the code before the PR (origin/main 7322be2) and pass
// after it. The end-to-end proof is tests/witness-autonomous-paper.test.js;
// the online worker's two-worker proof is tests/pilot-worker.test.js. Here
// each defect is pinned on its own, through the desk's own functions.
// FICTIONAL temporary workspaces, tickets, pairs, pools and contracts; any
// request off the test is refused.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const T = require('../core/tickets');
const TD = require('../core/trader-desk');
const PT = require('../core/paper-trader');
const C = require('../core/trader-candles');
const M = require('../core/forensic-model');
const F = require('../core/forensics');
const rpc = require('../core/contract-rpc');
const jobs = require('../core/jobs');
const projects = require('../core/projects');
const { applySettings } = require('../server');
const H = require('./helpers');
const TF = require('./trader-fixture');
const { mandateDesk, saveTicket, CONTRADICTORY, noHoldings } = require('./mandate-fixture');

const HR = 3600000;
const MIN = 60000;
const iso = (ms) => new Date(ms).toISOString();
const BY = 'mandate:cr-paper-mandate@1';
const TOKEN = '0x00000000000000000000000000000000000f1c71';
const QUOTE = '0x0000000000000000000000000000000000000c0c';
const POOL = `0x${'d4'.padStart(40, '0')}`;

// Nothing leaves the test.
function noNetwork(t) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => { throw new Error(`FICTIONAL: no network to ${new URL(String(url)).host}`); };
  t.after(() => { globalThis.fetch = real; });
}

// The contract's checks pass: the mandate's live evidence (R4) and the
// adapter's re-check before an opening. Those gates are tested in
// mandate.test.js, trader-mandate-opening.test.js and contract-gate.test.js,
// and the witness runs them for real; here what is tested is the scheduler,
// the latch, the fatal-finding hold and the cancel before an hour.
function contractPasses(t) {
  const real = { e: T.mandateContractEvidence, v: T.contractVerdictNow, c: T.contractCheckOf };
  T.mandateContractEvidence = () => null;
  T.contractVerdictNow = () => ({ tier: 'pass', words: 'Nothing found (FICTIONAL).', findings: [] });
  T.contractCheckOf = () => ({ status: 'holding', words: 'unchanged' });
  t.after(() => { T.mandateContractEvidence = real.e; T.contractVerdictNow = real.v; T.contractCheckOf = real.c; });
}

// A second Claude report on the fixture project (one claim reworded), so a
// replacement ticket is opened on new research, not re-opened.
function newClaudeReport(ws) {
  const text = fs.readFileSync(path.join(H.FIXTURES, 'reports', 'example-payfi-fictional__claude.md'), 'utf8');
  const changed = text.replace('a fee switch is announced for Q1 2027.', 'a fee switch is now scheduled for Q1 2027.');
  assert.notEqual(changed, text);
  H.dropText(ws, 'claude', 'example-payfi-fictional__claude-2.md', changed);
  return require('../core/inbox').scanInbox(ws, { force: true });
}

function onBase(ws, pid, address = TOKEN) {
  const file = ws.abs(`projects/${pid}/project.json`);
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  p.identity.assets = [{ chain: 'base', contract_address: address }];
  fs.writeFileSync(file, JSON.stringify(p, null, 2));
}

function pilotOn(ws, pid) {
  const file = ws.abs(`projects/${pid}/tickets/profile.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema_version: 'cr.ticket-profile.v1', project_id: pid, pilot: true, pilot_set_at: new Date().toISOString(), pilot_set_by: 'eric' }));
}

// An enrolled pilot desk on Base, the mandate armed for a week (generation
// 1), a consistent Prosecutor's ticket saved (sized $500).
function pilotDesk(t, { prosecution } = {}) {
  const s = mandateDesk(t, { grade: 60 });
  onBase(s.ws, s.pid);
  pilotOn(s.ws, s.pid);
  contractPasses(t);
  const r = saveTicket(s.ws, s.pid, prosecution ? { prosecution } : {});
  return { ...s, r };
}

const grants = (ws, pid) => T.readDecisions(ws, pid).filter((l) => l.decided_by === BY);
// Hours enough for the 14-hour ATR, ending at the last whole hour.
const hours = (ws, now = Date.now()) => {
  const top = Math.floor(now / HR) * HR;
  TD.applyHours(ws, Array.from({ length: 16 }, (_, i) => TF.bar(top - (16 - i) * HR)), { now: iso(now) });
};

// ---------------------------------------------------------------------------
// A. Scheduler bootstrap

test('A: on a cold desk the hosted timer\'s onlyDue path finds the mandate\'s work and grants', async (t) => {
  noNetwork(t);
  const s = pilotDesk(t);
  assert.equal(jobs.isDue(s.ws, 'trader', jobs.readJobState(s.ws), Date.now()), true, 'the trader job is due on a pending grant');
  await jobs.runJobs(s.ws, ['trader'], { trigger: 'dashboard', onlyDue: true });
  assert.equal(grants(s.ws, s.pid).length, 1, 'granted through the scheduled path');
});

test('A: GeckoTerminal\'s backoff holds neither the mandate\'s grant nor the book\'s step', async (t) => {
  noNetwork(t);
  const s = pilotDesk(t);
  TF.settle(s.ws);
  hours(s.ws);
  const file = s.ws.abs(C.STATUS_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema_version: 'cr.trader-candles-status.v1', gate: { failures: 3, backoff_until: iso(Date.now() + 2 * HR), last_failure_at: iso(Date.now()) } }));
  assert.equal(C.isDue(s.ws, Date.now()), false, 'the candle read waits');
  assert.equal(jobs.isDue(s.ws, 'trader', jobs.readJobState(s.ws), Date.now()), true, 'the trader job is due anyway');
  await jobs.runJobs(s.ws, ['trader'], { trigger: 'dashboard', onlyDue: true });
  const g = grants(s.ws, s.pid);
  assert.equal(g.length, 1, 'granted during the backoff');
  const buy = PT.intents(s.ws).find((i) => i.intent_id === TD.intentIdOf(g[0], 'open'));
  assert.ok(buy && buy.state === 'ACKED', `the book stepped during the backoff: ${JSON.stringify(buy)} ${JSON.stringify(TD.requests(s.ws, {}).requests.map((x) => [x.phase, x.words]))} ${JSON.stringify(jobs.readJobState(s.ws).jobs.trader)}`);
});

// ---------------------------------------------------------------------------
// B. A durable human suspension latch

test('B: after Eric\'s veto, a replacement ticket on the project is not granted, and re-arming the mandate does not lift it', (t) => {
  const s = pilotDesk(t);
  T.decide(s.ws, s.pid, { receipt_id: s.r.receipt_id, action: 'veto', request_id: 'req_reg_veto00001', by: 'eric' });
  newClaudeReport(s.ws);
  const r2 = saveTicket(s.ws, s.pid);
  assert.notEqual(r2.receipt_id, s.r.receipt_id);
  assert.equal(T.mandateSweep(s.ws).granted.length, 0, 'the replacement is not granted');
  applySettings(s.ws, { automation: { autonomous_paper_loop: false } });
  applySettings(s.ws, { automation: { autonomous_paper_loop: true, mandate: { expires_at: iso(Date.now() + 6 * 24 * HR) } } });
  assert.equal(T.mandateSweep(s.ws).granted.length, 0, 'a new arming does not lift Eric\'s suspension');
  assert.equal(grants(s.ws, s.pid).length, 0);
});

// ---------------------------------------------------------------------------
// C. Authority at execution: cancelled before an hour can fill it

test('C: a grant\'s buy, revoked between hours, is cancelled before the next hour is applied, never filled by it', (t) => {
  noNetwork(t);
  const s = pilotDesk(t);
  // The clock from here: 20 minutes into the next hour.
  const T0 = (Math.floor(Date.now() / HR) + 1) * HR + 20 * MIN;
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  H.freshPrice(s.ws, 'example-payfi-fictional', 0.85);
  applySettings(s.ws, { trader: { rules: { ...TF.RULES }, book: { ...TF.BOOK } } });
  hours(s.ws);
  assert.equal(T.mandateSweep(s.ws, { now: Date.now() }).granted.length, 1);
  TD.step(s.ws, { now: iso(Date.now()) });
  const d = grants(s.ws, s.pid)[0];
  const id = TD.intentIdOf(d, 'open');
  assert.equal(PT.intents(s.ws).find((i) => i.intent_id === id).state, 'ACKED');
  // Eric pauses automation; two hours later both hours since are applied.
  applySettings(s.ws, { automation: { paused: true } });
  t.mock.timers.tick(2 * HR);
  const top = Math.floor(T0 / HR) * HR;
  const out = TD.applyHours(s.ws, [TF.bar(top), TF.bar(top + HR, { low: '0.79' })], { now: iso(Date.now()) });
  const buy = PT.intents(s.ws).find((i) => i.intent_id === id);
  assert.equal(buy.state, 'CANCELLED', JSON.stringify(out));
  assert.ok(!(Number(buy.filled) > 0), `nothing filled: ${JSON.stringify(buy)}`);
  assert.equal(PT.results(s.ws, { now: iso(Date.now()) }).open_positions.length, 0);
  assert.ok(out.some((r) => r.status === 'cancelled' && r.client_order_id === buy.client_order_id), 'the cancel is recorded before the hour');
});

// ---------------------------------------------------------------------------
// E. A fatal finding holds automatic entry

test('E: a Prosecutor\'s fatal finding beside an ACCUMULATE is never granted by the mandate', (t) => {
  const s = pilotDesk(t, { prosecution: CONTRADICTORY });
  const out = T.mandateSweep(s.ws);
  assert.equal(out.granted.length, 0);
  assert.equal(grants(s.ws, s.pid).length, 0);
});

// ---------------------------------------------------------------------------
// §5. Caps across the lifecycle: a grant that waits or is not listed holds
// its capacity; only a finished one frees it.

test('§5 caps: a grant that has not opened for a reason that may pass, or that the trader does not list, holds the open cap', (t) => {
  const s = mandateDesk(t, { grade: 60, settings: { automation: { autonomous_paper_loop: true, mandate: { expires_at: iso(Date.now() + 7 * 24 * HR), max_open_grants: 1, authority: require('./mandate-fixture').ARMED() } } } });
  onBase(s.ws, s.pid);
  pilotOn(s.ws, s.pid);
  contractPasses(t);
  saveTicket(s.ws, s.pid);
  // Another project's mandate grant, made yesterday (not today's cap).
  const other = projects.addProject(s.ws, { name: 'Other (FICTIONAL)', symbol: 'XOTH', official_website: 'https://oth.example.org/', coingecko_id: 'oth-fictional', evidence: [{ url: 'https://oth.example.org/', note: 'fictional' }], assets: [{ chain: 'base', contract_address: '0x00000000000000000000000000000000000c0c00' }] }).project_id;
  const file = s.ws.abs(`projects/${other}/tickets/decisions.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = { schema_version: 'cr.ticket-decision.v1', decision_id: 'td_otherfict0001', project_id: other, receipt_id: 'tr_2026-10-01T000000Z_aaaaa', action: 'halve', decided_at: iso(Date.now() - 36 * HR), decided_by: BY, effects: { trader: 'open' } };
  fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
  const real = TD.requests;
  t.after(() => { TD.requests = real; });
  // It waits on evidence that may still arrive: not opened, not final.
  TD.requests = () => ({ requests: [{ decision_id: line.decision_id, project_id: other, in_force: true, phase: 'not_opened', final: false }] });
  assert.equal(T.mandateSweep(s.ws).granted.length, 0, 'a waiting grant holds its place');
  // The trader's view does not list it at all: unknown, so it holds too.
  TD.requests = () => ({ requests: [] });
  assert.equal(T.mandateSweep(s.ws).granted.length, 0, 'an unlisted grant holds its place');
  // Finished for good: the cap is free.
  TD.requests = () => ({ requests: [{ decision_id: line.decision_id, project_id: other, in_force: true, phase: 'not_opened', final: true }] });
  assert.equal(T.mandateSweep(s.ws).granted.length, 1, 'a grant that can never open frees it');
});

// ---------------------------------------------------------------------------
// §4. Fail-open accounting and history

const RPC_KEY = 'FICTIONALkey_0123456789';
const RPC_NOW = Date.parse('2026-10-30T12:00:00Z');
function rpcDesk(t, state) {
  const w = H.tempWorkspace('reg-rpc', { contracts: { daily_cu_cap: 100000, monthly_cu_cap: 1000000 } });
  t.after(w.cleanup);
  const file = w.ws.abs(rpc.STATE_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(JSON.parse(init.body).method); return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x2105' }) }; };
  return { ws: w.ws, file, calls, fetchImpl };
}
async function sendOne(d) {
  try {
    const session = rpc.openSession(d.ws, { chainId: '8453', fetchImpl: d.fetchImpl, key: RPC_KEY, now: () => RPC_NOW });
    await session.call('eth_getBlockByNumber', ['finalized', false]);
    return null;
  } catch (err) { return err; }
}

test('RPC: a budget counter that is not a whole number is unknown accounting: nothing is sent and the file is kept', async (t) => {
  const d = rpcDesk(t, { schema_version: 'cr.contract-rpc-state.v1', calls: { month: '2026-10', month_cu: '0', month_count: 0, day: '2026-10-30', day_cu: '0', day_count: 0 } });
  const before = fs.readFileSync(d.file, 'utf8');
  const err = await sendOne(d);
  assert.ok(err && err.kind === 'budget_unreadable', String(err && err.message));
  assert.equal(d.calls.length, 0, 'nothing sent');
  assert.equal(fs.readFileSync(d.file, 'utf8'), before);
});

test('RPC: counts dated after today are unknown history, never a fresh zero', async (t) => {
  const d = rpcDesk(t, { schema_version: 'cr.contract-rpc-state.v1', calls: { month: '2026-11', month_cu: 99000, month_count: 9, day: '2026-11-05', day_cu: 99000, day_count: 9 } });
  const before = fs.readFileSync(d.file, 'utf8');
  const err = await sendOne(d);
  assert.ok(err && err.kind === 'budget_unreadable', String(err && err.message));
  assert.equal(d.calls.length, 0, 'nothing sent');
  assert.equal(fs.readFileSync(d.file, 'utf8'), before, 'the record is kept as it is');
});

test('Sources: a candle-binding line that is not a supported binding makes an unbound pair\'s pool unknown, not "not yet bound"', (t) => {
  const w = H.tempWorkspace('reg-sources');
  t.after(w.cleanup);
  const pid = H.addFixtureProject(w.ws).project_id;
  onBase(w.ws, pid);
  const file = w.ws.abs(TD.SOURCES_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"schema_version":"cr.trader-candle-source.v1","pair":"XMPL/USDC","project_id":\n');
  const p = projects.getProject(w.ws, pid);
  const r = TD.pairOf(p, [p], { sources: TD.sourceBindings(w.ws) });
  assert.equal(r.pair, null, JSON.stringify(r));
  assert.match(r.why, /could not be read/);
});

// ---------------------------------------------------------------------------
// §5. Exit readiness

test('§5: a reading whose cost completeness is not stated is not a complete cost', (t) => {
  const w = H.tempWorkspace('reg-exit-complete');
  t.after(w.cleanup);
  const pid = H.addFixtureProject(w.ws).project_id;
  const real = F.view;
  const at = new Date().toISOString();
  F.view = () => ({ liquidity: { exits: [{ size_usd: 500, status: 'current', as_of: at, note: null, best: { cost_pct: 1.5, missing_costs: [], method: 'executable_quote', route_scope: 'aggregator', retrieved_at: at } }] } });
  t.after(() => { F.view = real; });
  const [row] = T.exitsOf(w.ws, pid, [500]);
  assert.notEqual(row.cost_complete, true, JSON.stringify(row));
});

test('§5: an exit reading dated after now is not current and never counts', () => {
  const now = Date.parse('2026-10-31T12:00:00Z');
  const q = { obs_id: 'Q1', kind: 'executable_quote', route_scope: 'aggregator', venue: 'Example aggregator', chain: 'example-chain', retrieved_at: iso(now + HR), quote: { sell_usd: 500, received_usd: 495, gas_usd: 0.1 } };
  const row = M.exitTable([q], [500], { taxOf: () => ({ pct: 0, source: 'GoPlus' }), now })[0];
  assert.notEqual(row.status, 'estimated', JSON.stringify(row));
  assert.equal(row.best, null);
});

test('§5: with an approved exit-quote target, the Prosecutor waits for a complete reading; none is claimed meanwhile', (t) => {
  const w = H.tempWorkspace('reg-exit-wait');
  t.after(w.cleanup);
  noHoldings(t);
  const pid = H.addFixtureProject(w.ws).project_id;
  H.importAllFixtures(w.ws);
  onBase(w.ws, pid);
  T.setPilot(w.ws, pid, true, { by: 'eric' });
  assert.ok((F.readProfile(w.ws, pid).targets.exit_quotes || []).length > 0, 'enrollment approved an exit-quote target');
  const waiting = T.nextStep(w.ws, pid);
  assert.equal(waiting.step, 'exit_evidence', waiting.why);
  assert.equal(require('../core/pilot-claims').claim(w.ws, pid, { owner: 'regression', now: Date.now() }).status, 'nothing');
  assert.equal(H.withExitReadings(1.5, () => T.nextStep(w.ws, pid), { complete: false }).step, 'exit_evidence', 'incomplete costs still wait');
  assert.equal(H.withExitReadings(1.5, () => T.nextStep(w.ws, pid)).step, 'ticket', 'a complete reading opens the ticket');
});

// ---------------------------------------------------------------------------
// The candle read's pacing after a clock step back (found by the witness)

test('Pacing: after the clock steps back, GeckoTerminal\'s next request waits at most one interval', async (t) => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const pools = { data: [{ id: `base_${POOL}`, type: 'pool', attributes: { address: POOL, name: 'XMPL / USDC', reserve_in_usd: '150000', volume_usd: { h24: '40000' }, token_price_usd: '0.85' }, relationships: { base_token: { data: { id: `base_${TOKEN}`, type: 'token' } }, quote_token: { data: { id: `base_${QUOTE}`, type: 'token' } }, dex: { data: { id: 'fictional-dex', type: 'dex' } } } }] };
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    const body = /\/pools$/.test(u.pathname) ? pools : (() => {
      const top = Math.floor(Date.now() / HR) * HR;
      const rows = Array.from({ length: Number(u.searchParams.get('limit')) }, (_, i) => [(top - i * HR) / 1000, 0.85, 0.86, 0.84, 0.85, 8600]);
      return { data: { attributes: { ohlcv_list: rows } }, meta: { base: { address: u.searchParams.get('token') } } };
    })();
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const desk = () => {
    const s = TF.deskWith(t);
    onBase(s.ws, s.pid);
    TF.settle(s.ws);
    T.decide(s.ws, s.pid, { receipt_id: s.rid, action: 'halve', request_id: `req_pace_${Date.now()}`, by: 'eric' });
    return s;
  };
  // Two desks, made now; the first is read three hours ahead, then the clock
  // steps back to now and the second is read.
  const a = desk();
  const b = desk();
  const real = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: real + 3 * HR });
  await C.refresh(a.ws, { trigger: 'test', fetchImpl, sleep, now: Date.now() });
  t.mock.timers.setTime(real + 1000);
  waits.length = 0;
  await C.refresh(b.ws, { trigger: 'test', fetchImpl, sleep, now: Date.now() });
  assert.ok(waits.length > 0, 'the second desk\'s requests were paced');
  assert.ok(Math.max(...waits) <= 2100, `waited ${Math.max(...waits)} ms`);
});
