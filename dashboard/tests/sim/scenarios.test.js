'use strict';
// Scenario harness (backlog 19, blueprint W4.2): twenty situations the desk must
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

// ---------------------------------------------------------------------------
// Cases 11 to 20 (backlog 59): the review fixes A03 to A07 and the Track 2
// items 41, 48 and 55 replayed as situations. Fictional workspaces only.

const { hashTree, withExitReadings, freshPrice } = require('../helpers');

test('sim 11: a stale price (over 90 minutes) on save is unchecked: the risk is capped at $0 and said as a cap, the receipt kept (A03)', (t) => {
  const s = S.workspace(t);
  S.stubHeld(t, s.pid, false);
  const tk = withExitReadings(1.5, () => T.createTicket(s.ws, { project_id: s.pid, assistant: true })).ticket;
  freshPrice(s.ws, S.CG, 0.85, 3 * S.H);
  const out = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: S.answer(T.loadTicket(s.ws, s.pid, tk.ticket_id)) });
  assert.equal(out.status, 'saved');
  assert.equal(out.receipt.desk.suggested_risk_usd, 0, 'unknown is never a pass');
  assert.equal(out.receipt.desk.proposal_type, 'WATCH_ONLY');
  assert.match(out.receipt.desk.gate.capped.reason, /past your 90-minute freshness limit/);
  assert.equal(out.receipt.desk.admission.price.status, 'unchecked');
  assert.throws(() => T.decide(s.ws, s.pid, { receipt_id: out.receipt_id, action: 'approve' }), (e) => e.code === 'REFUSED');
});

test('sim 12: a price drop stored after the text is checked and before the save\'s lock is read at the commit; the ticket is refused and nothing is written (A03)', (t) => {
  const s = S.workspace(t);
  S.stubHeld(t, s.pid, false);
  const tk = withExitReadings(1.5, () => T.createTicket(s.ws, { project_id: s.pid, assistant: true })).ticket;
  freshPrice(s.ws, S.CG, 0.85);
  const market = require('../../core/market');
  const real = market.readLatest;
  market.readLatest = (ws, ...a) => { const m = real(ws, ...a); return ws._lockHeld ? { ...m, assets: { ...m.assets, [S.CG]: { ...m.assets[S.CG], price_usd: 0.65 } } } : m; };
  t.after(() => { market.readLatest = real; });
  const before = hashTree(s.root);
  const text = S.answer(T.loadTicket(s.ws, s.pid, tk.ticket_id));
  assert.throws(() => T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text }), (e) => e.code === 'INVALID' && /price now \(\$0\.65/.test(e.message));
  assert.deepEqual(hashTree(s.root), before, 'a refusal at the commit writes nothing');
  assert.equal(T.listReceipts(s.ws, s.pid).length, 0);
});

test('sim 13: Approve and Halve after the price breached the invalidation price are refused with 409 INVALIDATED; a veto is still recorded (A04)', (t) => {
  const P = require('../../core/paper');
  const s = S.workspace(t);
  const saved = S.savedTicket(t, s);
  S.observe(s.ws, Date.parse(saved.receipt.saved_at), 0.69);
  assert.equal(T.view(s.ws, s.pid).ticket.status, 'invalidated');
  for (const action of ['approve', 'halve']) {
    assert.throws(() => T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action }), (e) => e.code === 'INVALIDATED' && /0\.69/.test(e.message), action);
  }
  assert.equal(T.readDecisions(s.ws, s.pid).length, 0);
  assert.equal(P.readRecords(s.ws).length, 0, 'no paper position');
  assert.equal(T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'veto' }).result.status, 'saved');
});

test('sim 14: Approve on a ticket whose report a newer one superseded is refused with BASIS_CHANGED naming the newer report; nothing is written (A04)', (t) => {
  const s = S.workspace(t);
  const saved = S.savedTicket(t, s);
  const compare = require('../../core/compare');
  const real = compare.latestByProvider;
  compare.latestByProvider = (...a) => { const l = real(...a); return { ...l, claude: { ...l.claude, report_id: 'r-newer-fictional' } }; };
  t.after(() => { compare.latestByProvider = real; });
  assert.throws(() => T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'approve' }), (e) => e.code === 'BASIS_CHANGED' && /superseded by r-newer-fictional/.test(e.message));
  assert.equal(T.readDecisions(s.ws, s.pid).length, 0);
});

test('sim 15: Approve, then Undo, then Halve leaves a single live paper position; the approve\'s position is kept, voided (A06)', (t) => {
  const P = require('../../core/paper');
  const s = S.workspace(t);
  const saved = S.savedTicket(t, s);
  T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'approve' });
  assert.throws(() => T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'halve' }), (e) => e.code === 'CONFLICT' && /Undo it first/.test(e.message));
  T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'undo' });
  T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'halve' });
  const b = P.book(s.ws);
  assert.equal(b.counts.positions, 1);
  assert.equal(b.counts.voided, 1);
  assert.equal(b.positions.find((x) => x.state !== 'voided').risk_usd, 250);
  assert.equal(require('../../core/portfolio').loadTransactions(s.ws).length, 0, 'the portfolio is untouched');
});

test('sim 16: a paper position closes on its horizon end, with no exit price when no reading is near it, and nothing in the paper file is edited by the read (A05)', (t) => {
  const P = require('../../core/paper');
  const s = S.workspace(t);
  const saved = S.savedTicket(t, s);
  const now0 = Date.now();
  S.observe(s.ws, now0 - S.H, 1.0, 100);
  T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'approve' });
  const file = s.ws.abs(P.REL);
  const open = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  open.horizon_end = new Date(now0 + 12 * S.H).toISOString();
  fs.writeFileSync(file, `${JSON.stringify(open)}\n`);
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(P.book(s.ws, { now: now0 + 6 * S.H }).positions[0].state, 'open', 'before the horizon end');
  const p = P.book(s.ws, { now: now0 + 20 * S.H }).positions[0];
  assert.equal(p.state, 'closed');
  assert.equal(p.close.kind, 'horizon_end');
  assert.equal(p.close.price_usd, null, 'no reading within 6 hours before the end: unknown, never filled in');
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('sim 17: a near-miss (grade 52) gets a Prosecutor from the pre-gate and the sizing gate still says $0 WATCH_ONLY (item 48)', () => {
  const sz = T.sizingOf({ settings: {} });
  const rep = (grade) => ({ grade });
  assert.equal(T.pregateReason(rep({ status: 'firm', value: 52 }), false, sz), null, 'a near miss opens a ticket');
  assert.equal(T.pregateReason(rep({ status: 'range', low: 40, high: 58 }), false, sz), null, 'a range reaching the floor opens one');
  assert.notEqual(T.pregateReason(rep({ status: 'firm', value: 40 }), false, sz), null, 'a grade well under stays closed');
  const g = T.gate({ researcher: rep({ status: 'firm', value: 52 }), held: false, exits: [], native: null }, sz);
  assert.equal(g.suggested_risk_usd, 0);
  assert.equal(g.proposal_type, 'WATCH_ONLY');
});

test('sim 18: the shadow gate\'s day-30 result is fixed at its reading and does not follow a later, moving price (item 41)', (t) => {
  const P = require('../../core/paper');
  const DAY = 24 * S.H;
  const s = S.workspace(t);
  s.ws.settings.tickets = { sizing: { min_grade_new_entry: 99, pregate_max_grade: 99, min_grade_any: 5 } };
  S.stubHeld(t, s.pid, false);
  const gate = T.createTicket(s.ws, { project_id: s.pid });
  const at = Date.parse(gate.receipt.saved_at);
  S.observe(s.ws, at - S.H, 1.0, 100);
  S.observe(s.ws, at + 30 * DAY - S.H, 2.0, 110);
  S.observe(s.ws, at + 35 * DAY, 3.0, 120);
  const row = P.book(s.ws, { now: at + 35 * DAY }).shadow_gate[0];
  assert.equal(row.since.change_pct, 200, 'the live change follows the price');
  assert.equal(row.day30.status, 'matured');
  assert.equal(row.day30.change_pct, 100);
  S.observe(s.ws, at + 60 * DAY, 9.0, 300);
  assert.deepEqual(P.book(s.ws, { now: at + 60 * DAY }).shadow_gate[0].day30, row.day30, 'matured, it never changes');
});

test('sim 19: MFE and MAE read across a price wick: the best and worst hourly price up to the close, none after it (item 55)', (t) => {
  const P = require('../../core/paper');
  const s = S.workspace(t);
  const saved = S.savedTicket(t, s);
  const now0 = Date.now();
  S.observe(s.ws, now0 - 2 * S.H, 1.0, 100);
  S.observe(s.ws, now0 + 0.5 * S.H, 1.2, 101);
  S.observe(s.ws, now0 + 1 * S.H, 0.95, 105);
  S.observe(s.ws, now0 + 2 * S.H, 0.69, 110);
  S.observe(s.ws, now0 + 3 * S.H, 0.3, 110);
  T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'approve' });
  const p = P.book(s.ws, { now: now0 + 5 * S.H }).positions[0];
  assert.equal(p.state, 'closed');
  assert.equal(p.max_favorable_pct, 20);
  assert.equal(p.max_adverse_pct, -31, 'the close reading, not the lower wick after it');
  assert.equal(p.excursion.status, 'known');
});

test('sim 20: a corrupt receipt is named in the daily brief\'s ticket_repairs, which is partial with no count, never "None right now"; the read writes nothing (A07)', (t) => {
  const B = require('../../core/brief-daily');
  const s = S.workspace(t);
  const saved = S.savedTicket(t, s);
  const rel = `projects/${s.pid}/tickets/receipts/${saved.receipt_id}.json`;
  const r = S.readJson(s.ws.abs(rel));
  r.researcher = null;
  S.atomicWrite(s.ws.abs(rel), S.jsonText(r));
  const tree = hashTree(s.root);
  const out = B.brief(s.ws, { now: Date.parse(saved.receipt.saved_at) + S.H });
  assert.deepEqual(hashTree(s.root), tree, 'a read writes nothing');
  const sec = out.sections.find((x) => x.id === 'ticket_repairs');
  assert.equal(sec.state, 'partial');
  assert.equal(sec.count, null);
  assert.equal(sec.unreadable_count, 1);
  assert.match(sec.lines[0].text, /the ticket could not be read/);
  assert.ok(!sec.lines.some((l) => l.text === 'None right now.'));
});
