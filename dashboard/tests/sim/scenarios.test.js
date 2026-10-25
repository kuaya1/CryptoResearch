'use strict';
// Scenario harness (backlog 19, blueprint W4.2): ten situations the desk must
// get right, each replayed from a price path in dashboard/tests/fixtures/sim/
// (or a stubbed answer) with zero network, each asserting statuses and words.
// Fictional workspaces and fixtures only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const S = require('./sim-helpers');
const { T, H } = S;

test('sim 1: a wick through the invalidation price invalidates the ticket, names the reading, and a recovery does not undo it', (t) => {
  const s = S.workspace(t);
  const saved = S.savedTicket(t, s);
  const t0 = Date.parse(saved.receipt.saved_at);
  S.replay(s.ws, 'wick-through-invalidation', t0);
  const v = T.view(s.ws, s.pid, { now: t0 + 11 * H });
  assert.equal(v.ticket.status, 'invalidated');
  const c = v.ticket.invalidation.checks.find((x) => x.kind === 'price');
  assert.equal(c.status, 'triggered');
  assert.equal(c.lowest_usd, 0.69);
  assert.equal(c.at, new Date(t0 + 5 * H).toISOString());
  assert.match(v.ticket.invalidation.words, /Price reached \$0\.69 at .* at or below the invalidation price \$0\.7/);
  assert.equal(T.view(s.ws, s.pid, { now: t0 + 40 * H }).ticket.status, 'invalidated', 'the later 0.9 readings do not undo it');
});

test('sim 2: a 12 h gap with the low inside reads unknown with the gap named, never holding', (t) => {
  const s = S.workspace(t);
  const saved = S.savedTicket(t, s);
  const t0 = Date.parse(saved.receipt.saved_at);
  S.replay(s.ws, 'gap-12h-low-inside', t0);
  const c = S.priceCheck(s.ws, s.pid, t0 + 24.5 * H);
  assert.equal(c.status, 'unknown');
  assert.notEqual(c.status, 'holding');
  assert.ok(c.coverage.coverage_pct < 90);
  assert.equal(c.coverage.gaps.length, 1);
  assert.ok(c.coverage.gaps[0].hours >= 12);
  assert.match(c.words, /Not enough price readings to say the price held/);
  assert.equal(T.view(s.ws, s.pid, { now: t0 + 24.5 * H }).ticket.status, 'pending_pm_review', 'unknown does not invalidate and is not "holding"');
});

test('sim 3: CoinGecko 429 closes the shared gate with nothing fetched; a stale price is "no price recorded", never holding or 0', async (t) => {
  const s = S.workspace(t);
  const saved = S.savedTicket(t, s);
  const t0 = Date.parse(saved.receipt.saved_at);
  S.replay(s.ws, 'stale-only', t0);
  const market = require('../../core/market');
  s.ws.settings = { ...s.ws.settings, market_data: { ...s.ws.settings.market_data, enabled: true } };
  const gate = market.noteRateLimit(s.ws, { httpStatus: 429 });
  assert.equal(gate.open, false);
  assert.match(gate.reason, /rate-limiting/);
  let fetched = 0;
  const out = await market.refresh(s.ws, { trigger: 'test', force: true, fetchImpl: async () => { fetched += 1; throw new Error('must not be called'); } });
  assert.equal(out.status, 'backoff');
  assert.equal(out.rate_limited, true);
  assert.equal(fetched, 0, 'force skips the failure backoff, never the rate-limit gate');
  const c = S.priceCheck(s.ws, s.pid, t0 + 6 * H);
  assert.equal(c.status, 'unknown');
  assert.match(c.words, /No price recorded since the ticket/);
  assert.equal(c.lowest_usd, undefined, 'no number is made up');
});

test('sim 4: the aggregator\'s no-route answer is no reading; the ticket is capped to $0 with the reason in words', async (t) => {
  const { tempWorkspace } = require('../helpers');
  const F = require('../../core/forensics');
  const FX = require('../forensic-fixtures');
  const w = tempWorkspace('sim-noroute');
  t.after(w.cleanup);
  const TOKEN = '0x2222222222222222222222222222222222222222';
  const CG = 'fictional-sim-token';
  const pid = require('../../core/projects').addProject(w.ws, { name: 'Sim Route Example (FICTIONAL)', symbol: 'XSR', official_website: 'https://sr.example', coingecko_id: CG, assets: [{ chain: 'base', contract_address: TOKEN }], evidence: [{ url: 'https://sr.example', note: 'fictional' }] }).project_id;
  const a = F.createAudit(w.ws, { project_id: pid, assistant: 'claude' });
  F.saveReport(w.ws, { project_id: pid, audit_id: a.audit_id, provider: 'claude', text: FX.reportText(a.audit) });
  F.setMonitoring(w.ws, pid, { approve_quotes: [F.view(w.ws, pid).monitoring.proposed.exit_quotes.find((o) => o.chain === 'base').key], enabled: true });
  fs.mkdirSync(path.join(w.ws.root, 'market-data'), { recursive: true });
  const at = new Date(Date.now() - 60000).toISOString();
  S.atomicWrite(path.join(w.ws.root, 'market-data', 'latest.json'), S.jsonText({ provider: 'coingecko', assets: { [CG]: { id: CG, price_usd: 2, source_last_updated_at: at, fetched_at: at } } }));
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { status: 400, headers: { get: () => null }, text: async () => JSON.stringify({ code: 4008, message: 'route not found (FICTIONAL)' }) }; };
  const cgGetImpl = async () => ({ id: CG, detail_platforms: { base: { decimal_place: 6, contract_address: TOKEN } } });
  const out = await T.prepareExitQuote(w.ws, pid, { fetchImpl, cgGetImpl, sleep: async () => {} });
  assert.equal(calls, 1);
  assert.equal(out.status, 'no_answer');
  assert.match(out.reason, /found no route at 500 USD/);
  // No route proves no exit: the gate allows no risk.
  const g = T.gate({ researcher: { grade: { status: 'firm', value: 70 } }, held: false, exits: [{ size_usd: 500, cost_pct: null, cost_complete: null }], native: null }, T.sizingOf(w.ws), 'ACCUMULATE');
  assert.equal(g.suggested_risk_usd, 0);
  assert.equal(g.proposal_type, 'WATCH_ONLY');
  assert.match(g.reasons.join(' '), /No current exit reading at \$500/);
});

test('sim 5: an unknown sell tax makes the exit a lower bound, which proves nothing: $0, and the missing cost is named', () => {
  const sizing = T.sizingOf({ settings: {} });
  const basis = { researcher: { grade: { status: 'firm', value: 70 } }, held: false, exits: [{ size_usd: 500, cost_pct: 2.1, cost_complete: false, missing_costs: ['transfer tax'] }], native: null };
  const g = T.gate(basis, sizing, 'ACCUMULATE');
  assert.equal(g.suggested_risk_usd, 0);
  assert.equal(g.capped.from, 'ACCUMULATE');
  assert.match(g.reasons.join(' '), /at least 2\.1%.*transfer tax.*unknown.*lower bound/);
  const known = T.gate({ ...basis, exits: [{ size_usd: 500, cost_pct: 2.1, cost_complete: true, missing_costs: [] }] }, sizing, 'ACCUMULATE');
  assert.equal(known.suggested_risk_usd, 500, 'the same cost with the tax known passes');
});

test('sim 6: a report superseded mid-ticket is said on the receipt and the status does not change', (t) => {
  const s = S.workspace(t);
  const saved = S.savedTicket(t, s);
  const t0 = Date.parse(saved.receipt.saved_at);
  S.replay(s.ws, 'wick-through-invalidation', t0);
  const project = require('../../core/projects').getProject(s.ws, s.pid);
  const receipt = JSON.parse(JSON.stringify(saved.receipt));
  const was = T.invalidationOf(s.ws, project, receipt, { now: t0 + 3 * H });
  assert.equal(was.basis_stale, undefined);
  receipt.researcher.report_id = 'an-earlier-report-id';
  const now = T.invalidationOf(s.ws, project, receipt, { now: t0 + 3 * H });
  assert.match(now.basis_stale.why, /an-earlier-report-id is superseded by /);
  assert.equal(now.invalidated, was.invalidated);
  assert.deepEqual(now.checks.map((c) => c.status), was.checks.map((c) => c.status));
});

test('sim 7: a decision on a superseded receipt is refused with 409 NEWER_REPORT naming the newer ticket; nothing is written', (t) => {
  const s = S.workspace(t);
  const first = S.savedTicket(t, s);
  const second = S.savedTicket(t, s, { refresh: true });
  assert.notEqual(first.receipt_id, second.receipt_id);
  const before = T.readDecisions(s.ws, s.pid).length;
  assert.throws(() => T.decide(s.ws, s.pid, { receipt_id: first.receipt_id, action: 'approve' }), (e) => e.code === 'NEWER_REPORT' && e.details.newer[0].receipt_id === second.receipt_id);
  assert.equal(T.readDecisions(s.ws, s.pid).length, before);
  assert.equal(T.decide(s.ws, s.pid, { receipt_id: second.receipt_id, action: 'approve' }).result.status, 'saved');
});

test('sim 8: agents 40 points apart keep both figures and the difference; there is no average or midpoint', (t) => {
  const s = S.workspace(t);
  const tk = T.createTicket(s.ws, { project_id: s.pid, assistant: true }).ticket;
  const text = S.answer(tk, { prosecution: { verdict: 'fatal_flaw', conviction_score: 20, tests: {}, fatal_flaws: [], strongest_bull_rebuttal: 'none' } });
  const out = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text });
  const d = out.receipt.agent_disagreement;
  assert.equal(d.researcher.grade, 60.5);
  assert.equal(d.prosecutor.conviction_score, 20);
  assert.equal(d.spread_points, 40.5);
  assert.ok(!Object.keys(d).some((k) => /average|mean|midpoint|combined/i.test(k)));
  assert.ok(!/average|midpoint/i.test(JSON.stringify(T.view(s.ws, s.pid).ticket.agent_disagreement || {})));
});

test('sim 9: ETH under the native L1 exemption passes the exit check without a quote; a small coin or a token does not', () => {
  const sizing = T.sizingOf({ settings: {} });
  const mk = (native, cap) => ({ researcher: { grade: { status: 'firm', value: 70 } }, held: false, exits: [], native: { native_chain: native, market_cap_usd: cap } });
  const eth = T.gate(mk(true, 450e9), sizing, 'ACCUMULATE');
  assert.equal(eth.exit_basis, 'native_l1_liquid');
  assert.equal(eth.suggested_risk_usd, 500);
  assert.deepEqual(eth.reasons, []);
  assert.equal(T.gate(mk(true, 2e9), sizing, 'ACCUMULATE').suggested_risk_usd, 0, 'under the floor');
  assert.equal(T.gate(mk(false, 450e9), sizing, 'ACCUMULATE').suggested_risk_usd, 0, 'a token is not a native coin');
});

test('sim 10: a paper position across an invalidation closes at the first reading at or below the price, with the return against BTC', (t) => {
  const P = require('../../core/paper');
  const s = S.workspace(t);
  const saved = S.savedTicket(t, s);
  const ref = Date.now();
  S.replay(s.ws, 'paper-across-invalidation', ref);
  T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'approve' });
  const early = P.book(s.ws, { now: ref + 1.5 * H }).positions[0];
  assert.equal(early.state, 'open');
  assert.equal(early.entry.price_usd, 1.0);
  assert.equal(early.return.status, 'unrealized');
  const b = P.book(s.ws, { now: ref + 6 * H });
  const p = b.positions[0];
  assert.equal(p.state, 'closed');
  assert.equal(p.close.kind, 'invalidated');
  assert.equal(p.close.price_usd, 0.7, 'the first reading at or below, not the lower one after it');
  assert.equal(p.close.at, new Date(ref + 3 * H).toISOString());
  assert.equal(p.return.return_pct, -30);
  assert.equal(p.return.btc_return_pct, 5);
  assert.equal(p.return.vs_btc_pct, -33.33);
  assert.match(b.summary.note, /Too few to judge/);
  // The same decision undone voids it, still on record.
  T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'undo' });
  assert.equal(P.book(s.ws, { now: ref + 6 * H }).positions[0].state, 'voided');
});
