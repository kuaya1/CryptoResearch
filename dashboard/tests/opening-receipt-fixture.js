'use strict';
// The FICTIONAL desk the opening-receipt tests share (core/opening-receipt.js,
// cr.opening-guard.v1). A fictional chain, pools, quoter, desk, ticket and
// prices; temporary workspaces only; no network, no key.
//
// One token (18 decimals) at a stored $7.04 on a fictional chain 8453, with
// two pools the desk counts:
// - a V3 pool whose quoter pays by MODE:
//     'impact'  $6.99424 a token up to 100 tokens (the $100 and $500
//               quantities) and $6.63520 above (the $2,000 quantity);
//     'poor'    $6.63520 at every size: with the $5 fee no quote of its own
//               is within 5%;
//     'zero'    nothing: every quantity holds.
// - a V2 pair whose reserves the test chooses: THIN proves none of these
//   sizes, MID proves the $500 quantity and not the $2,000 one, DEEP proves
//   the risk-sized order.
// Approved at $500 of risk, the order is risk-sized to 289.855072 tokens
// (about $2,000); the $500 reference quantity is 71.022727.
//
// Settings are written to config/settings.json as well as held in memory
// (`persist`), so a second process that opens the same folder (the tests'
// interrupted child, opening-receipt-child.js) reads the same desk.

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const G = require('../core/contract-gate');
const K = require('../core/keccak');
const CF = require('../core/contract-forensics');
const T = require('../core/tickets');
const TD = require('../core/trader-desk');
const PT = require('../core/paper-trader');
const OR = require('../core/opening-receipt');
const { validate } = require('../core/schema');
const TF = require('./trader-fixture');
const H = require('./helpers');
const { world, baseState, ROW, T0, T1, PAIR, USDC, BUYER, ADDR, Aw, W, sel, arg, ok, okA, TOKEN, TOKEN_CODE, sources, timelocks, liveBlock, TL } = require('./contract-world');

// Where the fixtures may live (as in the CG-14 suites): each test's workspace
// is its own directory under os.tmpdir(); an audit run names its disposable
// folder in CR_AUDIT_SAFE_ROOT, which must hold os.tmpdir().
const SAFE = process.env.CR_AUDIT_SAFE_ROOT;
if (SAFE !== undefined) assert.ok(typeof SAFE === 'string' && SAFE !== '' && path.isAbsolute(SAFE), 'CR_AUDIT_SAFE_ROOT must name the disposable folder');
const ROOT = path.resolve(SAFE === undefined ? os.tmpdir() : SAFE);
const under = (p) => {
  const rel = path.relative(ROOT, path.resolve(p));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
if (SAFE !== undefined) assert.ok(under(os.tmpdir()), `os.tmpdir() ${os.tmpdir()} is not under ${SAFE}`);
assert.ok(!process.env.CR_DATA_DIR && !process.env.CR_WORKSPACE, 'no real desk path may be set');

const E18 = 10n ** 18n;
const KEY = 'FICTIONALkey_0123456789';
const PRICE = 7.04;
const CHAIN = '8453';
const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'schemas', 'trade-intent.v3.schema.json'), 'utf8'));
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
// The book's own hashing, re-stated (paper-trader.js `canonical` is not exported).
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v === undefined ? null : v));

const FACT3 = ADDR('fac3');
const QUOTER = ADDR('9007');
const QCODE = '0x6080604052600f';
const INIT3 = K.keccak256Hex('0x0f1c7101a1');
const POOL3 = K.create2Address(FACT3, K.keccak256Hex(`0x${Aw(T0)}${Aw(T1)}${W(3000)}`), INIT3);
const ROW3 = { chain_id: CHAIN, name: 'Fictional V3', kind: 'v3', factory: FACT3, init_code_hash: INIT3, fee_tiers: [3000], quoter: QUOTER, quoter_code_hash: K.keccak256Hex(QCODE), quotes: [{ address: USDC, decimals: 6, usd_value: '1' }] };
const pay = (mode) => (q) => (mode === 'zero' ? 0n : ((mode === 'impact' && q <= 100n * E18) ? q * 699424n : q * 663520n) / (100000n * 10n ** 12n));
// The pool's own square-root price (slot0's first word) at $7.04 for an
// 18-decimal token0 and a 6-decimal quote asset, the nearest one not over it.
const isqrt = (n) => { if (n < 2n) return n; let a = n; let b = (n >> 1n) + 1n; while (b < a) { a = b; b = (b + n / b) >> 1n; } return a; };
const SQRT_704 = isqrt(((704n * 10n ** 6n) << 192n) / (100n * E18));
const v3 = (mode) => ({
  [FACT3]: { code: '0x60806040526003', fns: { [sel('getPool(address,address,uint24)')]: () => okA(POOL3) } },
  [POOL3]: { code: '0x60806040526004', fns: { [sel('token0()')]: () => okA(T0), [sel('token1()')]: () => okA(T1), [sel('slot0()')]: () => ok(SQRT_704, 0, 0, 0, 0, 0, 1) } },
  [QUOTER]: { code: QCODE, fns: { [sel('quoteExactInputSingle((address,address,uint256,uint24,uint160))')]: (S, f, d) => ok(pay(mode)(arg(d, 2)), 0, 0, 0) } },
});
const THIN = { token: 564531721145538574650n, quote: 3962014889n }; // about 565 tokens: proves none of these sizes
const MID = { token: 5000n * E18, quote: 35200000000n }; // 5,000 tokens at $7.04: proves the $500 quantity, not $2,000
const DEEP = { token: 500000n * E18, quote: 3520000000000n }; // 500,000 tokens at $7.04: proves the risk-sized order
const pairState = ({ token, quote }) => baseState({ owner: TL, minter: TL, reserve_token: token, reserve_quote: quote, bal: { [PAIR]: token, [BUYER]: 50000n * E18 } });

const TRAP = { proposal_type: 'LIMIT_TRAP', entry_zone: { low_usd: 6.9, high_usd: 7.2, basis: 'prior range (FICTIONAL)' }, upside_target: { price_usd: 9.5, basis: 'fees double' }, invalidation_trigger: { price_usd: 6.1, metric: { key: 'fees', below_30d_usd: 100000 }, statement: 'Below $6.10 or fees under $100k a month.' } };
const RISK_SIZED = '289.855072';
const AT_500 = '71.022727';

// The effective settings, written where a second process reads them.
function persist(s) {
  fs.writeFileSync(path.join(s.root, 'config', 'settings.json'), JSON.stringify(s.ws.settings, null, 2));
}
const setMode = (s, mode) => { s.ws.settings.tickets = { ...(s.ws.settings.tickets || {}), contract_gate: { mode } }; persist(s); };

// `mandate`: the paper mandate armed for a week on this chain, and Claude's grade stubbed to 60 (mandate-fixture.js).
function desk(t, { mandate = false, label = 'opening-receipt' } = {}) {
  const MF = require('./mandate-fixture');
  const w = H.tempWorkspace(label, {
    contracts: { daily_cu_cap: 1000000, monthly_cu_cap: 10000000, pool_factories: [ROW, ROW3], max_log_blocks: 1000, network_fee_ceiling_usd: { [CHAIN]: 5 } },
    tickets: { contract_gate: { mode: 'observe' }, ...(mandate ? { sizing: { min_grade_new_entry: 50 } } : {}) },
    ...(mandate ? { automation: { autonomous_paper_loop: true, mandate: { expires_at: MF.inDays(7), allowed_chains: ['base'], authority: MF.ARMED() } } } : {}),
  });
  t.after(w.cleanup);
  assert.ok(under(w.root), 'workspace under the disposable root');
  if (mandate) MF.stubGrade(t, 60);
  MF.noHoldings(t);
  const pid = H.addFixtureProject(w.ws).project_id;
  H.importAllFixtures(w.ws);
  const file = w.ws.abs(`projects/${pid}/project.json`);
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  p.identity.assets = [{ chain: 'base', contract_address: TOKEN }];
  fs.writeFileSync(file, JSON.stringify(p, null, 2));
  H.freshPrice(w.ws, 'example-payfi-fictional', PRICE);
  // The mandate grants only on a project Eric enrolled in the pilot.
  if (mandate) T.setPilot(w.ws, pid, true, { by: 'eric' });
  const s = { ...w, pid, mandate };
  TF.settle(s.ws);
  persist(s);
  return s;
}

let blockN = 73000 + Math.floor(Math.random() * 1000) * 10;
// One real capture (contract-forensics.js observeProject) against the fictional node.
async function observe(s, { pair = THIN, quoter = 'impact' } = {}) {
  H.freshPrice(s.ws, 'example-payfi-fictional', PRICE);
  const w = world({ S: pairState(pair), tokenCode: TOKEN_CODE, extra: { ...timelocks, ...v3(quoter) }, block: liveBlock(blockN += 1) });
  await CF.probeNetwork(s.ws, CHAIN, { fetchImpl: w.fetch, key: KEY, now: Date.now });
  const r = await CF.observeProject(s.ws, s.pid, { fetchImpl: w.fetch, key: KEY, sourceImpl: sources, now: Date.now });
  assert.equal(r.results[0].status, 'saved', JSON.stringify(r.results[0]));
  return CF.readObservation(s.ws, s.pid, r.results[0].observation_id).observation;
}

// Everything up to the grant: the ticket saved on a first observation, the
// book's hours closed at $7.04, `current` the observation the guard will
// read, and `mode` in force (in memory and on disk).
async function ready(s, { current = (x) => observe(x), mode = 'enforce' } = {}) {
  await observe(s);
  const MF = require('./mandate-fixture');
  const tk = H.withExitReadings(1.5, () => T.createTicket(s.ws, { project_id: s.pid, assistant: true })).ticket;
  const saved = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: TF.answer(T.loadTicket(s.ws, s.pid, tk.ticket_id), TRAP, ...(s.mandate ? [MF.CONSISTENT] : [])) });
  assert.equal(saved.status, 'saved', saved.message);
  const BAR = { open: '7.04', high: '7.100', low: '6.980', close: '7.04' };
  const now0 = Date.now();
  const top = Math.floor(now0 / TF.H) * TF.H;
  TD.applyHours(s.ws, Array.from({ length: 16 }, (_, i) => TF.bar(top - (16 - i) * TF.H, BAR)), { now: TF.iso(now0) });
  const ob = await current(s);
  H.freshPrice(s.ws, 'example-payfi-fictional', PRICE);
  setMode(s, mode);
  return { receipt: saved.receipt, ob };
}

// Eric's approval, through the desk's own decision path: it runs the trader's first step.
const REQUEST = 'req_opening_receipt_0001';
const approve = (s, receipt, request_id = REQUEST) => T.decide(s.ws, s.pid, { receipt_id: receipt.receipt_id, action: 'approve', request_id }).result.decision;
// The paper mandate's sweep, as the hosted trader job runs it: the grant, by the mandate.
function mandateGrant(s) {
  const out = T.mandateSweep(s.ws, { now: Date.now() });
  const d = T.readDecisions(s.ws, s.pid).filter((l) => l.decided_by === T.MANDATE_BY).pop() || null;
  return { sweep: out, decision: d };
}

const journal = (s) => { try { return fs.readFileSync(path.join(s.root, ...PT.JOURNAL.split('/')), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)); } catch (_) { return []; } };
const reservedFor = (s, did) => journal(s).filter((e) => e.type === 'reserved' && e.intent && e.intent.decision_id === did && e.intent.side === 'OPEN_LONG');
const rowOf = (s, did) => TD.requests(s.ws, {}).requests.find((x) => x.decision_id === did);
const check = (s, line) => OR.verify(line, { readObservation: (pid, id) => CF.readObservation(s.ws, pid, id), ticketReceipt: (pid, rid) => { try { return JSON.parse(fs.readFileSync(s.ws.abs(`projects/${pid}/tickets/receipts/${rid}.json`), 'utf8')); } catch (_) { return null; } }, decisionOf: (pid, did) => T.readDecisions(s.ws, pid).find((d) => d.decision_id === did) || null });

// What every opening line written by this code must satisfy, whatever its receipt says.
function wellFormed(line) {
  const it = line.intent;
  assert.deepEqual(validate(SCHEMA, it).errors, [], 'the reserved intent is a valid cr.trade-intent.v3 by the published schema');
  assert.deepEqual(Object.keys(it.evidence).sort(), ['catalyst', 'metrics_evaluated', 'negative_invalidation'], 'evidence keeps its three properties');
  assert.ok(it.evidence.metrics_evaluated.every((m) => typeof m === 'string' && m.trim() !== ''));
  assert.equal(it.evidence.metrics_evaluated.filter((m) => m.startsWith(`${OR.KEY}=`)).length, 1, 'one receipt item');
  assert.equal(it.evidence.metrics_evaluated[it.evidence.metrics_evaluated.length - 1].startsWith(`${OR.KEY}=`), true, 'after the ticket\'s own metrics');
  assert.equal(line.intent_sha256, sha256(canonical(it)), 'the line\'s intent hash is the hash of the intent with its receipt');
  const rec = OR.readFrom(it);
  assert.equal(rec.version, 'cr.opening-guard.v1');
  assert.deepEqual(OR.problemsOf(rec), []);
  assert.equal(rec.quantity.final, line.quantity, 'the receipt\'s final quantity is the quantity the book reserved');
  return rec;
}

// A second process on the same folder (opening-receipt-child.js): one entry
// point of the desk, stopped dead at a named point. Resolves with how it ended.
const CHILD = path.join(__dirname, 'opening-receipt-child.js');
const childEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
function childSync(s, entry, kill, args = {}) {
  const r = spawnSync(process.execPath, [CHILD, s.root, entry, kill, JSON.stringify(args)], { encoding: 'utf8', env: childEnv(), timeout: 120000 });
  return { status: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function childAsync(s, entry, kill, args = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [CHILD, s.root, entry, kill, JSON.stringify(args)], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('error', reject);
    c.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}
// The same desk as a process that has just started reads it (settings from disk, nothing held in memory).
const reopened = (s) => ({ ...s, ws: require('../core/workspace').openWorkspace({ root: s.root, actor: 'test' }) });

module.exports = {
  G, CF, T, TD, PT, OR, TF, H, validate, SCHEMA, sha256, canonical, under,
  E18, PRICE, CHAIN, POOL3, PAIR, USDC, ROW, ROW3, THIN, MID, DEEP, TRAP, RISK_SIZED, AT_500, REQUEST,
  persist, setMode, desk, observe, ready, approve, mandateGrant, journal, reservedFor, rowOf, check, wellFormed, childSync, childAsync, reopened,
};
