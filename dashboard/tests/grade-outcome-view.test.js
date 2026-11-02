'use strict';
// The attribution view (core/grade-outcome-view.js, cr-grade-outcome-view@1;
// blueprint 2026-11-02 §5.4, §5.5 and §5.6, build plan row 12). Temporary
// FICTIONAL workspaces only; no network. The §5.6 illustration is run through
// the desk's real adapter and book: a LIMIT buy of 100 units at $10.00 with
// a 0.10% taker fee, 40 filled in hour 1 (10% of 400), the $10.80 target in
// hour 2, the unfilled 60 cancelled: net $31.168, never the signal-price $80.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const T = require('../core/tickets');
const TD = require('../core/trader-desk');
const V = require('../core/grade-outcome-view');
const DB = require('../core/decision-basis');
const { tempWorkspace, addFixtureProject, importAllFixtures, withExitReadings, freshPrice } = require('./helpers');
const { H, M, iso, answer, settle, bar } = require('./trader-fixture');

// The illustration's ticket: entry zone up to $10.00, stop $9.50, target
// $10.80, priced at $10.20, sized by the gate at $500; the book funded with
// $4,000 so the 25% notional cap makes it 100 units, fee 0.10%.
const PROPOSAL = {
  entry_zone: { low_usd: 9.9, high_usd: 10, basis: 'prior range (FICTIONAL)' },
  upside_target: { price_usd: 10.8, basis: 'fees double (FICTIONAL)' },
  invalidation_trigger: { price_usd: 9.5, metric: { key: 'fees', below_30d_usd: 100000 }, statement: 'Below $9.50 or fees under $100k a month (FICTIONAL).' },
};
const calm = (start) => bar(start, { open: '10.2', high: '10.25', low: '10.15', close: '10.2', volume: '10000' });

function ticketed(t) {
  const w = tempWorkspace('grade-outcome');
  t.after(w.cleanup);
  const pid = addFixtureProject(w.ws).project_id;
  importAllFixtures(w.ws);
  const portfolio = require('../core/portfolio');
  const real = portfolio.computePortfolio;
  portfolio.computePortfolio = (...a) => ({ ...real(...a), positions: [] });
  t.after(() => { portfolio.computePortfolio = real; });
  const tk = withExitReadings(1.5, () => T.createTicket(w.ws, { project_id: pid, assistant: true })).ticket;
  freshPrice(w.ws, 'example-payfi-fictional', 10.2);
  const saved = T.saveTicket(w.ws, { project_id: pid, ticket_id: tk.ticket_id, text: answer(T.loadTicket(w.ws, pid, tk.ticket_id), PROPOSAL) });
  assert.equal(saved.receipt.desk.suggested_risk_usd, 500, 'the gate sized the ticket at $500');
  settle(w.ws, { book: { cash_usd: '4000', fee_rate: '0.001' } });
  const top = Math.floor(Date.now() / H) * H;
  return { ...w, pid, rid: saved.receipt_id, report: saved.receipt.researcher.report_id, top };
}

// Hours on record, then Eric's approval: the book is asked at once.
function illustrated(t) {
  const s = ticketed(t);
  TD.applyHours(s.ws, Array.from({ length: 16 }, (_, i) => calm(s.top - (16 - i) * H)), { now: iso(Date.now()) });
  const d = T.decide(s.ws, s.pid, { receipt_id: s.rid, action: 'approve', by: 'eric' }).result;
  assert.equal(d.trader.status, 'order', 'the decision reserved a Trader Sim order');
  const { top } = s;
  // The hour the order went live in cannot fill it; hour 1 and hour 2 of §5.6.
  TD.applyHours(s.ws, [calm(top)], { now: iso(top + H + 11 * M) });
  TD.applyHours(s.ws, [bar(top + H, { open: '10.05', high: '10.10', low: '9.90', close: '10.00', volume: '400' })], { now: iso(top + 2 * H + 11 * M) });
  TD.step(s.ws, { now: iso(top + 2 * H + 12 * M) });
  TD.applyHours(s.ws, [bar(top + 2 * H, { open: '10.70', high: '10.90', low: '10.60', close: '10.80', volume: '400' })], { now: iso(top + 3 * H + 11 * M) });
  TD.step(s.ws, { now: iso(top + 3 * H + 12 * M) });
  return { ...s, decision: d.decision, end: iso(top + 3 * H + 30 * M) };
}

function tree(root) {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(root, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(root);
  return out;
}

test('the §5.6 illustration through the real book: net $31.168 from fee-bearing fills, never the signal-price $80', (t) => {
  const s = illustrated(t);
  const v = V.view(s.ws, { now: s.end });
  assert.equal(v.format, V.FORMAT);
  assert.equal(v.rows.length, 1);
  const r = v.rows[0];
  assert.equal(r.decision_id, s.decision.decision_id);
  assert.equal(r.phase, 'closed');
  assert.deepEqual(r.order, { client_order_id: r.order.client_order_id, order_state: r.order.order_state, ordered_quantity: '100', filled_quantity: '40', fill: 'part', fee_taker_rate: '0.001' });
  assert.equal(r.position.state, 'closed');
  assert.equal(r.position.exit_reason, 'take_profit');
  assert.equal(r.position.realized_pnl_usd, '31.168', '$432.00 − $400.00 − $0.40 − $0.432');
  assert.equal(r.position.fees_usd, '0.832');
  assert.equal(r.position.fees, 'complete');
  // The signal-price figure, 100 × ($10.80 − $10.00) = $80, is nowhere in it.
  const text = JSON.stringify(v);
  assert.doesNotMatch(text, /"80(\.0+)?"|:80[,}]/);
  assert.doesNotMatch(text, /signal_price|pm_cohort_pnl/);
  // Execution context the book does not record is said (option B).
  assert.deepEqual(r.not_recorded_at_execution, ['engine revision', 'fill_share_max', 'trader.rules digest']);
  // What it stood on, beside it: the decision's own basis, Claude's report
  // as the input, the Prosecutor as the other input.
  assert.equal(r.inputs.label, 'decision_time');
  assert.equal(r.inputs.decision_input.provider, 'claude');
  assert.equal(r.inputs.decision_input.report_id, s.report);
  assert.ok(r.inputs.prosecutor && r.inputs.prosecutor.model_version === 'claude-test');
  for (const c of r.inputs.context) assert.notEqual(c.provider, 'claude', 'other models are context only');
});

test('every denominator is shown, no rate at any count, groups by Q3\'s default key, the three views apart', (t) => {
  const s = illustrated(t);
  const v = V.view(s.ws, { now: s.end });
  assert.deepEqual(v.denominators, {
    decisions_granted: 1,
    intents: { not_opened_final: 0, not_opened_not_final: 0, waiting: 0, refused: 0 },
    orders_reserved: 1,
    fills: { full: 0, part: 1, unfilled: 0, pending: 0, unknown: 0 },
    positions: { open: 0, closed: 1 },
    closed_fees: { complete: 1, incomplete: 0 },
    basis: { decision_time: 1, reconstructed: 0, refused: 0 },
    excluded: { count: 0, of: 1, rule: 'none', words: '0 excluded of 1.' },
  });
  assert.equal(v.rates, null);
  assert.equal(v.rates_words, V.NO_RATE);
  assert.deepEqual(v.group_key, ['decided_by', 'researcher_model_version', 'execution_policy']);
  assert.equal(v.groups.length, 1);
  const g = v.groups[0];
  assert.equal(g.key.decided_by, 'eric');
  assert.deepEqual(g.key.execution_policy, { engine: 'not_recorded', rules_sha256: 'not_recorded', fee_taker_rate: '0.001' });
  assert.deepEqual(Object.keys(g).sort(), ['closed', 'decision_ids', 'decisions', 'key', 'open', 'orders_reserved'], 'counts only: no rate, no sum, no ranking');
  // The three views are named and kept apart; this one is the Trader Sim's.
  assert.deepEqual(Object.keys(v.views), ['research_vs_btc', 'pm_cohort', 'trader_sim']);
  assert.equal(v.views.trader_sim.in_this_view, true);
  assert.equal(v.views.research_vs_btc.in_this_view, false);
  assert.equal(v.views.pm_cohort.in_this_view, false);
  // Selection is visible: traded k of n eligible Claude reports.
  assert.equal(v.selection.traded, 1);
  assert.ok(v.selection.eligible_claude_reports >= 1);
  assert.equal(v.selection.untraded.length, v.selection.eligible_claude_reports - 1);
  assert.match(v.selection.words, new RegExp(`^Traded 1 of ${v.selection.eligible_claude_reports} eligible Claude report`));
  assert.match(v.selection.words, /not an unbiased model comparison/);
});

test('a later exclusion is an annotation; the book outcome stands. A basis that does not hold is said, never rebuilt; one from before reads reconstructed', (t) => {
  const s = illustrated(t);
  require('../core/notes').addCorrection(s.ws, s.pid, s.report, 'eligibility', { excluded: true, reason: 'FICTIONAL later exclusion' }, 'FICTIONAL test');
  const v = V.view(s.ws, { now: s.end });
  const r = v.rows[0];
  assert.equal(r.position.realized_pnl_usd, '31.168', 'the book outcome stands');
  assert.equal(r.inputs.decision_input.report_id, s.report, 'the input as it stood');
  assert.ok(r.inputs.later.some((a) => a.report_id === s.report && /after the decision/.test(a.words)), 'the exclusion is a later annotation');
  assert.equal(v.selection.untraded.some((x) => x.report_id === s.report), false);

  // The basis edited: the view is refused by name (INTEGRITY, blueprint
  // §5.2), nothing substituted, and the book's own facts still counted.
  const file = s.ws.abs(DB.basisRel(s.pid, s.decision.decision_id));
  const was = fs.readFileSync(file);
  fs.writeFileSync(file, Buffer.concat([was, Buffer.from('x')]));
  let bad = null;
  assert.throws(() => V.view(s.ws, { now: s.end }), (err) => { bad = err; return err.code === 'INTEGRITY'; });
  assert.match(bad.message, /decision basis/);
  assert.equal(bad.details.refused.length, 1);
  assert.equal(bad.details.refused[0].record, 'decision_basis');
  assert.equal(bad.details.denominators.basis.refused, 1);
  assert.equal(bad.details.denominators.orders_reserved, 1, 'the reservation is still counted');
  assert.equal(bad.details.denominators.positions.closed, 1);
  // No basis at all (a decision from before it existed): reconstructed.
  fs.unlinkSync(file);
  const old = V.view(s.ws, { now: s.end });
  assert.equal(old.rows[0].inputs.label, 'reconstructed');
  assert.equal(old.denominators.basis.reconstructed, 1);
});

test('a grant the book was never asked for, an undo and a veto: each counted in its own place', (t) => {
  const s = ticketed(t);
  // No hours on record: the grant waits, no order.
  const d = T.decide(s.ws, s.pid, { receipt_id: s.rid, action: 'approve', by: 'eric' }).result.decision;
  let v = V.view(s.ws);
  assert.equal(v.denominators.decisions_granted, 1);
  assert.equal(v.denominators.intents.waiting, 1);
  assert.equal(v.denominators.orders_reserved, 0);
  assert.equal(v.rows[0].order, null);
  assert.equal(v.rows[0].position, null);
  assert.equal(v.selection.traded, 0);
  assert.ok(v.selection.untraded.some((x) => x.report_id === s.report && x.why === 'granted, no order reserved'));
  // Undone before the book was asked: not opened, final.
  T.decide(s.ws, s.pid, { receipt_id: s.rid, action: 'undo', by: 'eric' });
  v = V.view(s.ws);
  assert.equal(v.rows.find((r) => r.decision_id === d.decision_id).phase, 'not_opened');
  assert.equal(v.denominators.intents.not_opened_final, 1);
  // Then vetoed: listed under selection, never a granted row.
  T.decide(s.ws, s.pid, { receipt_id: s.rid, action: 'veto', by: 'eric' });
  v = V.view(s.ws);
  assert.equal(v.denominators.decisions_granted, 1);
  assert.equal(v.selection.vetoed.length, 1);
  assert.equal(v.selection.vetoed[0].decided_by, 'eric');
  // A window that excludes the day leaves nothing, and says so in counts.
  const w = V.view(s.ws, { from: '2000-01-01', to: '2000-01-02' });
  assert.equal(w.denominators.decisions_granted, 0);
  assert.equal(w.selection.eligible_claude_reports, 0);
  assert.throws(() => V.view(s.ws, { from: 'yesterday' }), /YYYY-MM-DD/);
});

test('reading it writes nothing, in process and through the signed-in route, which refuses a bad day and an unsigned request', async (t) => {
  const s = illustrated(t);
  const before = tree(s.root);
  V.view(s.ws, { now: s.end });
  assert.deepEqual(tree(s.root), before);
  const { start } = require('../server');
  const srv = await start(s.ws, { port: 49400 + Math.floor(Math.random() * 500), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } });
  const started = tree(s.root); // the server's own start writes its index first
  const get = (p, headers) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: p, method: 'GET', headers: { host: `127.0.0.1:${srv.port}`, ...headers } }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(c).toString() || 'null') }); } catch (err) { reject(err); } });
    });
    req.on('error', reject);
    req.end();
  });
  const signed = { 'x-cr-token': srv.token };
  const r = await get('/api/research/attribution', signed);
  assert.equal(r.status, 200);
  assert.equal(r.json.format, V.FORMAT);
  assert.equal(r.json.rows.length, 1);
  assert.equal(r.json.rows[0].decision_id, s.decision.decision_id);
  assert.equal((await get('/api/research/attribution?from=nope', signed)).status, 400);
  assert.equal((await get('/api/research/attribution', {})).status, 401);
  assert.deepEqual(tree(s.root), started, 'the route wrote nothing');
});
