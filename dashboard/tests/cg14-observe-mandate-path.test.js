'use strict';
// CG-10 and D1 through the whole paper path with the gate OBSERVED ONLY (the
// default, and the mode the live desk was on when this was found): the pilot
// worker prepares and saves the Prosecutor's ticket, then the hosted timer's
// tick runs the paper mandate's sweep and the trader's step.
//
// The independent review of D1 (2026-11-10) reproduced a failure here that
// no unit of the gate showed: with the sell tax MEASURED and no usable stored
// dollar value for Ethereum's USDC, the ticket's exit-cost block went away, so
// in observe mode the mandate granted and the trader's book reserved an order
// whose $500 exit cost 9%. The correction (merged with D1, PR #193) made the
// ticket block where the setting alone blocks and hold where only an estimate
// supports the exit. cg14-quote-value.test.js checks that at the ticket and
// at the mandate's contract check; this file keeps the end-to-end path, down
// to what the book reserved, in the suite.
//
// Two desks. On the first the Ethereum-USDC pool is the ONLY pool the desk
// counts, as in the review's reproduction: no other pool's reading stands in
// for the one that is missing, so losing the block there means a grant and a
// reserved order. On the second a thin pair is counted as well, whose own
// reading (about 101%) must not replace the 9% the setting alone gives.
//
// FICTIONAL chain, token, pool, desk, ticket, hours and book; the one real
// value is Ethereum USDC's contract address. Temporary workspaces only; the
// "node" is JavaScript in this process; no network, no key, no provider.
// Modeled on tests/witness-autonomous-paper.test.js, moved to chain 1.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SAFE = process.env.CR_AUDIT_SAFE_ROOT;
if (SAFE !== undefined) assert.ok(typeof SAFE === 'string' && SAFE !== '' && path.isAbsolute(SAFE), 'CR_AUDIT_SAFE_ROOT must name the disposable folder');
const ROOT = path.resolve(SAFE === undefined ? os.tmpdir() : SAFE);
const under = (p) => {
  const rel = path.relative(ROOT, path.resolve(p));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
if (SAFE !== undefined) assert.ok(under(os.tmpdir()), `os.tmpdir() ${os.tmpdir()} is not under ${SAFE}`);
assert.ok(!process.env.CR_DATA_DIR && !process.env.CR_WORKSPACE, 'no real desk path may be set');

const K = require('../core/keccak');
const CF = require('../core/contract-forensics');
const T = require('../core/tickets');
const TD = require('../core/trader-desk');
const PT = require('../core/paper-trader');
const PW = require('../core/pilot-worker');
const F = require('../core/forensics');
const jobs = require('../core/jobs');
const { applySettings } = require('../server');
const H = require('./helpers');
const TF = require('./trader-fixture');
const { stubGrade, noHoldings, CONSISTENT } = require('./mandate-fixture');
const { world, baseState, ROW, PAIR, TOKEN, TOKEN_CODE, BUYER, ADDR, Aw, W, sel, arg, ok, okA, tokenFns, sources, timelocks, liveBlock, TL } = require('./contract-world');

const HR = 3600000;
const iso = (ms) => new Date(ms).toISOString();
const BY = T.MANDATE_BY;
const EPOCH = Date.parse('2026-10-07T14:20:00Z'); // the witness's own start: inside the fixture reports' freshness
const KEY = 'FICTIONALkey_0123456789';
const ETH_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'; // Ethereum's USDC (contract-presets.js USDC[1])
const PRICE = 0.85;

// One concentrated pool selling the fictional token (6 decimals, token0) into
// Ethereum USDC's address, at $0.85 a token; and the repo's thin fictional
// pair on chain 1, where the sell probe runs (so the sell tax is measured: 0).
const FACT3 = ADDR('fac3e1');
const QUOTER = ADDR('90e1');
const QCODE = '0x6080604052601e';
const INIT3 = K.keccak256Hex('0x0f1c7101e1');
const POOL3 = K.create2Address(FACT3, K.keccak256Hex(`0x${Aw(TOKEN)}${Aw(ETH_USDC)}${W(3000)}`), INIT3);
assert.ok(TOKEN < ETH_USDC, 'the fictional token sorts below Ethereum\'s USDC');
const ROW3 = { chain_id: '1', name: 'Fictional V3 (Ethereum USDC)', kind: 'v3', factory: FACT3, init_code_hash: INIT3, fee_tiers: [3000], quoter: QUOTER, quoter_code_hash: K.keccak256Hex(QCODE), quotes: [{ address: ETH_USDC, decimals: 6, usd_value: '1' }] };
const THIN_PAIR = { ...ROW, chain_id: '1' };
const isqrt = (n) => { if (n < 2n) return n; let a = n; let b = (n >> 1n) + 1n; while (b < a) { a = b; b = (b + n / b) >> 1n; } return a; };
const SQRT_085 = isqrt((85n << 192n) / 100n); // both at 6 decimals, the token as token0
// The quoter pays `payPct` percent of the sale's value at $0.85. With the $5
// fee on the $500 reference size: 92 -> 9%, 98 -> 3%.
const chain1 = (payPct) => ({
  [TOKEN]: { code: TOKEN_CODE, fns: tokenFns({ [sel('decimals()')]: () => ok(6) }) },
  [ETH_USDC]: { code: '0x60806040526ee1', fns: { [sel('decimals()')]: () => ok(6), [sel('balanceOf(address)')]: (S, f, d) => ok(`0x${d.subarray(16, 36).toString('hex')}` === POOL3 ? 1000000000n : 0n) } },
  [FACT3]: { code: '0x60806040526e03', fns: { [sel('getPool(address,address,uint24)')]: () => okA(POOL3) } },
  [POOL3]: { code: '0x60806040526e04', fns: { [sel('token0()')]: () => okA(TOKEN), [sel('token1()')]: () => okA(ETH_USDC), [sel('slot0()')]: () => ok(SQRT_085, 0, 0, 0, 0, 0, 1) } },
  [QUOTER]: { code: QCODE, fns: { [sel('quoteExactInputSingle((address,address,uint256,uint24,uint160))')]: (S, f, d) => ok((arg(d, 2) * 85n * BigInt(payPct)) / 10000n, 0, 0, 0) } },
});

// GeckoTerminal at the transport (the trader's hours), as the witness stands it in, on network "eth".
const GT_POOL = `0x${'d4'.padStart(40, '0')}`;
function gecko() {
  const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  const pool = { id: `eth_${GT_POOL}`, type: 'pool', attributes: { address: GT_POOL, name: 'XMPL / USDC', reserve_in_usd: '600000', volume_usd: { h24: '40000' }, token_price_usd: String(PRICE) }, relationships: { base_token: { data: { id: `eth_${TOKEN}`, type: 'token' } }, quote_token: { data: { id: `eth_${ETH_USDC}`, type: 'token' } }, dex: { data: { id: 'fictional-dex', type: 'dex' } } } };
  return async (url) => {
    const u = new URL(String(url));
    if (u.origin !== 'https://api.geckoterminal.com') throw new Error(`FICTIONAL: no network to ${u.host}`);
    if (/^\/api\/v2\/networks\/eth\/tokens\/[^/]+\/pools$/.test(u.pathname)) return json({ data: [pool] });
    if (!/^\/api\/v2\/networks\/eth\/pools\/[^/]+\/ohlcv\/hour$/.test(u.pathname)) throw new Error(`FICTIONAL: unexpected ${u.pathname}`);
    const top = Math.floor(Date.now() / HR) * HR;
    const rows = [];
    const limit = Math.min(Number(u.searchParams.get('limit')) || 100, 1000);
    for (let i = 0; i < limit; i++) rows.push([(top - i * HR) / 1000, 0.85, 0.86, 0.84, 0.85, 8600]);
    return json({ data: { id: 'fict', type: 'ohlcv_request_response', attributes: { ohlcv_list: rows } }, meta: { base: { address: u.searchParams.get('token'), symbol: 'XMPL' }, quote: { address: ETH_USDC, symbol: 'USDC' } } });
  };
}
// The forensic exit readings frozen into the ticket (1.5% at $500), as the witness installs them.
function exitReadings() {
  const real = F.view;
  F.view = () => {
    const at = iso(Date.now());
    const row = (size, cost) => ({ size_usd: size, status: 'current', as_of: at, note: null, best: { cost_pct: cost, cost_complete: true, missing_costs: [], method: 'executable_quote', route_scope: 'aggregator', retrieved_at: at } });
    return { liquidity: { exits: [row(100, 0.75), row(500, 1.5), row(2000, 3)] } };
  };
  return () => { F.view = real; };
}

// What the market record says of USDC, by name: each is a change to the file
// the fixture writer wrote (token $0.85 and USDC $1, both a minute old).
const EVIDENCE = {
  fresh: () => {},
  'none on record': (m) => { delete m.assets['usd-coin']; },
  'provider time three hours old, fetched a minute ago': (m, now) => { m.assets['usd-coin'].source_last_updated_at = iso(now - 3 * HR); },
  'no provider time, fetched a minute ago': (m) => { delete m.assets['usd-coin'].source_last_updated_at; },
  'the file\'s provider is not CoinGecko': (m) => { m.provider = 'fictional-demo'; },
};

let blockN = 915000;
// `only`: the Ethereum-USDC pool is the one pool the desk counts (the thin
// pair is on the chain and not in the desk's settings). The repo's stand-in
// node names a recent buyer for its own thin pair alone, so here the node
// also names one for that pool, and the sell probe runs there.
async function run(t, { evidence, payPct, mode = 'observe', only = false }) {
  t.mock.timers.enable({ apis: ['Date'], now: EPOCH });
  const w = H.tempWorkspace('cg14-observe-path', {
    contracts: { daily_cu_cap: 1000000, monthly_cu_cap: 10000000, pool_factories: only ? [ROW3] : [THIN_PAIR, ROW3], max_log_blocks: 1000, network_fee_ceiling_usd: { 1: 5 } },
    tickets: { sizing: { min_grade_new_entry: 50 }, contract_gate: { mode } },
  });
  t.after(w.cleanup);
  assert.ok(under(w.root), 'workspace under the disposable root');
  stubGrade(t, 60);
  noHoldings(t);
  const pid = H.addFixtureProject(w.ws).project_id;
  H.importAllFixtures(w.ws);
  const file = w.ws.abs(`projects/${pid}/project.json`);
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  p.identity.assets = [{ chain: 'ethereum', contract_address: TOKEN }];
  fs.writeFileSync(file, JSON.stringify(p, null, 2));
  T.setPilot(w.ws, pid, true, { by: 'eric' });
  const project = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  // The market record, then the named change, then one real capture.
  H.freshPrice(w.ws, 'example-payfi-fictional', PRICE);
  H.freshPrice(w.ws, 'usd-coin', 1);
  const mfile = w.ws.abs('market-data/latest.json');
  const m = JSON.parse(fs.readFileSync(mfile, 'utf8'));
  EVIDENCE[evidence](m, Date.now());
  fs.writeFileSync(mfile, JSON.stringify(m));
  const S = baseState({ owner: TL, minter: TL, bal: { [PAIR]: 4000000n * 10n ** 18n, [BUYER]: 50000n * 10n ** 18n, [POOL3]: 1000n * 10n ** 6n } });
  const chain = world({ S, tokenCode: TOKEN_CODE, extra: { ...timelocks, ...chain1(payPct) }, block: liveBlock(blockN += 1), chainIdHex: '0x1' });
  const node = !only ? chain.fetch : async (url, init) => {
    const { id, method, params } = JSON.parse(init.body);
    if (method === 'eth_getLogs' && params[0] && Array.isArray(params[0].topics) && params[0].topics[1] === `0x${Aw(POOL3)}`) {
      const result = [{ topics: [CF.TOPICS.Transfer, params[0].topics[1], `0x${Aw(BUYER)}`], data: `0x${W(1)}` }];
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: '2.0', id, result }) };
    }
    return chain.fetch(url, init);
  };
  await CF.probeNetwork(w.ws, '1', { fetchImpl: node, key: KEY, now: Date.now });
  const obs = await CF.observeProject(w.ws, pid, { fetchImpl: node, key: KEY, sourceImpl: sources, now: Date.now });
  assert.equal(obs.results[0].status, 'saved', JSON.stringify(obs.results[0]));
  const o = CF.readObservation(w.ws, pid, obs.results[0].observation_id).observation;
  assert.deepEqual([o.transfer_probe.status, o.transfer_probe.sell_path.tax_bps], ['ok', 0], 'the sell tax is measured, so no other gap masks the result');
  assert.equal(o.pools.find((x) => x.pool === POOL3).counted, true);
  if (only) assert.deepEqual(o.pools.filter((x) => x.counted).map((x) => x.pool), [POOL3], 'no other pool is counted');
  applySettings(w.ws, { trader: { rules: { ...TF.RULES }, book: { ...TF.BOOK } } });
  applySettings(w.ws, { automation: { autonomous_paper_loop: true, mandate: { expires_at: iso(EPOCH + 7 * 24 * HR), allowed_chains: ['ethereum'] } } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = gecko();
  t.after(() => { globalThis.fetch = realFetch; });
  // The book, read whole: every intent it holds (any side), and what it reserved for each grant.
  const book = () => {
    const grants = T.readDecisions(w.ws, pid).filter((l) => l.decided_by === BY);
    let intents = [];
    try { intents = PT.intents(w.ws); } catch (_) { intents = []; }
    const reserved = grants.flatMap((g) => { const ex = TD.executionFor(w.ws, g.decision_id); return ex && Array.isArray(ex.reserved) ? ex.reserved : []; });
    return { grants, intents, reserved };
  };
  // Agent 2 through the pilot worker (claim, prepare, the session's answer, complete).
  const restore = exitReadings();
  let c; let prep;
  try {
    c = PW.claimStep(w.ws, pid, { owner: 'test' });
    if (c.status !== 'claimed_now') return { o, stopped: `no Prosecutor was claimed (${c.step}): ${String(c.words).slice(0, 300)}`, ...book() };
    prep = await PW.prepare(w.ws, pid, c.token, { fetchImpl: async () => { throw new Error('FICTIONAL: no network'); } });
  } finally { restore(); }
  if (prep.status !== 'prepared') {
    await jobs.runJobs(w.ws, jobs.HOSTED_TIMER_JOBS, { trigger: 'dashboard', onlyDue: true });
    return { o, stopped: `the desk did not prepare a ticket (${prep.status}): ${String(prep.words).slice(0, 300)}`, ...book() };
  }
  const tk = T.loadTicket(w.ws, pid, prep.ticket_id);
  const done = PW.complete(w.ws, pid, c.token, { text: TF.answer(tk, {}, CONSISTENT).split(TF.AT).join(iso(Date.now())), prompt_sha256: prep.prompt_sha256 });
  assert.equal(done.status, 'saved', done.words);
  const receipt = T.listReceipts(w.ws, pid).find((r) => r.receipt_id === done.receipt_id);
  // The hosted timer's own call: every hosted job that is due (the mandate's sweep and the trader's step among them).
  await jobs.runJobs(w.ws, jobs.HOSTED_TIMER_JOBS, { trigger: 'dashboard', onlyDue: true });
  const sizing = T.sizingOf(w.ws);
  const v = T.contractVerdictNow(w.ws, project(), sizing, Date.now());
  const elig = T.mandateContractEvidence(w.ws, project(), receipt, sizing, Date.now());
  return { o, receipt, v, elig, ...book() };
}
const exitFinding = (v) => v.findings.find((f) => f.rule_id === 'CG-10' && /on-chain exit cost/.test(f.words)) || null;
// No grant, no intent of any kind in the book, nothing reserved.
function nothing(r, label) {
  assert.equal(r.grants.length, 0, `${label}: no grant`);
  assert.equal(r.intents.length, 0, `${label}: the book holds no intent`);
  assert.equal(r.reserved.length, 0, `${label}: nothing reserved`);
}
const BAD = Object.keys(EVIDENCE).filter((k) => k !== 'fresh');

// ---- The desk the failure was first reproduced on: the Ethereum-USDC pool is the only pool counted.

for (const evidence of ['none on record', 'provider time three hours old, fetched a minute ago']) {
  test(`observe, only the Ethereum-USDC pool counted, sell tax measured, a 9% exit, USDC value ${evidence}: the ticket blocks as the setting alone does; no grant, no order, nothing reserved`, async (t) => {
    const r = await run(t, { evidence, payPct: 92, only: true });
    assert.ok(!r.stopped, r.stopped);
    const f = exitFinding(r.v);
    assert.ok(f && f.tier === 'block', `CG-10 blocks: ${r.v.words}`);
    assert.match(f.words, /is at least 9\.000% with the quote asset at its configured value, over the 5% limit; its stored dollar value at the observation is not usable/);
    assert.equal(r.receipt.desk.contract_gate.tier, 'block', 'the ticket was saved with the block');
    assert.match(String(r.elig), /^The contract gate blocks: /);
    nothing(r, `only pool, ${evidence}`);
  });
}

test('observe, only the Ethereum-USDC pool counted, sell tax measured, a 3% exit, no USDC value on record: an estimate proves nothing, so the ticket holds; no grant, no order, nothing reserved', async (t) => {
  const r = await run(t, { evidence: 'none on record', payPct: 98, only: true });
  assert.ok(!r.stopped, r.stopped);
  const f = exitFinding(r.v);
  assert.ok(f && f.tier === 'hold', `CG-10 holds: ${r.v.words}`);
  assert.match(f.words, /At its configured value it would be 3\.000%, an estimate and not a decision/);
  assert.match(String(r.elig), /^The contract gate holds: /);
  nothing(r, 'only pool, 3%');
});

test('observe, only the Ethereum-USDC pool counted, sell tax measured, a 3% exit with USDC\'s value fresh on record (the passing control): the mandate grants, the trader opens and the book reserves', async (t) => {
  const r = await run(t, { evidence: 'fresh', payPct: 98, only: true });
  assert.ok(!r.stopped, r.stopped);
  assert.equal(exitFinding(r.v), null, `no exit-cost finding: ${r.v.words}`);
  assert.equal(r.elig, null, 'nothing stands against the grant');
  assert.equal(r.grants.length, 1, 'one grant, by the mandate');
  const opens = r.intents.filter((i) => i.side === 'OPEN_LONG');
  assert.deepEqual(opens.map((i) => i.state), ['ACKED'], 'the buy is acknowledged');
  assert.equal(r.reserved.length, 1, 'the book reserved it');
  assert.deepEqual([r.reserved[0].quantity, r.reserved[0].entry_price], ['2352.941176', '0.85']);
});

// ---- The same with a thin pair counted as well: its own reading must not stand in for the missing one.

for (const evidence of BAD) {
  test(`observe, sell tax measured, a 9% exit, USDC value ${evidence}: the ticket blocks as the setting alone does; no grant, no order, nothing reserved`, async (t) => {
    const r = await run(t, { evidence, payPct: 92 });
    assert.ok(!r.stopped, r.stopped);
    const f = exitFinding(r.v);
    assert.ok(f && f.tier === 'block', `CG-10 blocks: ${r.v.words}`);
    assert.match(f.words, /is at least 9\.000% with the quote asset at its configured value, over the 5% limit; its stored dollar value at the observation is not usable/);
    assert.equal(r.receipt.desk.contract_gate.tier, 'block', 'the ticket was saved with the block');
    assert.match(String(r.elig), /^The contract gate blocks: /);
    nothing(r, evidence);
  });
}

for (const evidence of ['none on record', 'provider time three hours old, fetched a minute ago']) {
  test(`observe, sell tax measured, a 3% exit, USDC value ${evidence}: an estimate proves nothing, so the ticket holds; no grant, no order, nothing reserved`, async (t) => {
    const r = await run(t, { evidence, payPct: 98 });
    assert.ok(!r.stopped, r.stopped);
    const f = exitFinding(r.v);
    assert.ok(f && f.tier === 'hold', `CG-10 holds: ${r.v.words}`);
    assert.match(f.words, /At its configured value it would be 3\.000%, an estimate and not a decision/);
    assert.match(String(r.elig), /^The contract gate holds: /);
    nothing(r, evidence);
  });
}

test('observe, sell tax measured, a 9% exit with USDC\'s value fresh on record (control): the ticket blocks on the reading itself', async (t) => {
  const r = await run(t, { evidence: 'fresh', payPct: 92 });
  assert.ok(!r.stopped, r.stopped);
  const f = exitFinding(r.v);
  assert.ok(f && f.tier === 'block', r.v.words);
  assert.equal(f.words, 'The complete on-chain exit cost at $500 is 9.000%, over the 5% limit.');
  nothing(r, 'fresh 9%');
});

test('observe, sell tax measured, a 3% exit with USDC\'s value fresh on record (the passing control): the mandate grants, the trader opens and the book reserves', async (t) => {
  const r = await run(t, { evidence: 'fresh', payPct: 98 });
  assert.ok(!r.stopped, r.stopped);
  assert.equal(exitFinding(r.v), null, `no exit-cost finding: ${r.v.words}`);
  assert.equal(r.elig, null, 'nothing stands against the grant');
  assert.equal(r.grants.length, 1, 'one grant, by the mandate');
  const opens = r.intents.filter((i) => i.side === 'OPEN_LONG');
  assert.deepEqual(opens.map((i) => i.state), ['ACKED'], 'the buy is acknowledged');
  assert.equal(r.reserved.length, 1, 'the book reserved it');
  assert.deepEqual([r.reserved[0].quantity, r.reserved[0].entry_price], ['2352.941176', '0.85']);
  assert.equal(r.reserved[0].quantity, opens[0].quantity);
});

for (const [payPct, name] of [[92, '9%'], [98, '3%']]) {
  test(`enforce, sell tax measured, a ${name} exit, no USDC value on record: the desk stops before any Prosecutor; no grant, no order, nothing reserved`, async (t) => {
    const r = await run(t, { evidence: 'none on record', payPct, mode: 'enforce' });
    nothing(r, `enforce ${name}`);
    // A block closes the gate at the prepare (gate_closed); a hold stops the step before it is claimed (contract_evidence).
    assert.match(String(r.stopped), payPct === 92 ? /did not prepare a ticket \(gate_closed\)/ : /no Prosecutor was claimed \(contract_evidence\)/);
  });
}
