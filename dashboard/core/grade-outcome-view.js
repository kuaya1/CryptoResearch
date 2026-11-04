'use strict';
// The attribution view (cr-grade-outcome-view@1; blueprint 2026-11-02 §5.4
// and §5.5, build plan row 12). Read only and computed on read: nothing here
// writes, and nothing is stored.
//
// Identity. One row per decision that grants risk to the Trader Sim (an
// approve or halve whose effects open a trader request, trader-desk.js
// grantsOf), keyed by decision_id; its execution key is the position. A
// trade is one executed policy outcome: no model "earned" its result. The
// Claude report the ticket names and the Prosecutor were its inputs; any
// other model's report was context (decision-basis.js).
//
// Each row joins two things side by side, never merged, and each is read on
// its own:
// - what the decision stood on: decision-basis.js viewOf (decision_time, or
//   reconstructed for a decision from before the basis existed);
// - what the book recorded: the trader adapter's own view (trader-desk.js;
//   nothing here calls the book) and the decision's own book events
//   (decision-basis.js executionOf, read apart from the basis): its phase,
//   order, fills, position, the realized result net of every fee, and
//   whether each fee is known.
//
// A record that does not hold (a basis that does not read or does not belong
// to its decision; a receipt, packet or report original that does not match
// the SHA-256 on record; a book journal that does not read) refuses
// the whole view: INTEGRITY (409) naming each record, nothing rebuilt and
// nothing put in its place (blueprint §5.2). The refusal still says what the
// book recorded, read apart from the basis, so a reservation is never
// reported as zero; when the book itself does not read, no count is given,
// because unknown is not zero (docs/CONSTITUTION.md, Law 4).
//
// Denominators are always shown (§5.4). No rate is shown before 50 closed
// positions in a group (Q3, ratified 2026-11-03), and none while the execution
// policy reads not_recorded (Q4 = B): counts and rows only. Groups follow Q3's default key: who decided (Eric or the
// mandate) × the Claude researcher's model version × the execution policy;
// provider, model version and role are separate dimensions, never pooled.
//
// The three views stay distinct (§5.5): research against BTC (every eligible
// report, traded or not), the PM Cohort (Eric's own grants at the signal
// price, unknown costs) and the Trader Sim (fee-bearing fills). Every figure
// here is the Trader Sim's; the others are named, never mixed in. Selection
// is visible: "traded k of n eligible Claude reports", with the untraded,
// the vetoed and the desk's $0 gates listed. Later corrections and
// exclusions are annotations; a book outcome stands.

const FORMAT = 'cr-grade-outcome-view@1';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const NO_RATE = 'No rate is shown before 50 closed positions in a group (Q3, 2026-11-03), and none while the execution policy is not recorded. Counts and rows only.';
const NOT_RECORDED = 'not_recorded';

const VIEWS = Object.freeze({
  research_vs_btc: { source: 'GET /api/research/outcomes (core/report-outcomes.js)', unit: 'every eligible report, traded or not, against BTC at 30/60/90/120 days', in_this_view: false },
  pm_cohort: { source: 'the PM Paper Book (core/paper.js)', unit: 'Eric\'s own grants at the signal price, costs unknown; a mandate grant opens none', in_this_view: false },
  trader_sim: { source: 'GET /api/paper/trader (core/trader-desk.js)', unit: 'fee-bearing fills; a closed position\'s result is net of every fee', in_this_view: true },
});

// Exact decimals (core/decimal.js, read only): book figures are strings.
const D = require('./decimal');
const dec = (v) => D.parse(String(v)).value;
const str = (v) => D.toString(v);

const decidedByKind = (d) => (typeof d.decided_by === 'string' && d.decided_by.startsWith('mandate:') ? 'mandate' : 'eric');
const sumDec = (vals) => str(vals.reduce((a, v) => a + dec(v), 0n));

function windowOf({ from = null, to = null } = {}) {
  for (const [k, v] of [['from', from], ['to', to]]) if (v !== null && !DAY_RE.test(String(v))) throw Object.assign(new Error(`${k} is a day (YYYY-MM-DD).`), { code: 'INVALID' });
  return { from: from || null, to: to || null };
}
const inWindow = (at, w) => {
  const day = String(at || '').slice(0, 10);
  if (!day) return w.from === null && w.to === null;
  return (w.from === null || day >= w.from) && (w.to === null || day <= w.to);
};

// What the decision stood on, from decision-basis.js; a refusal is said.
function basisOf(ws, pid, decisionId) {
  try {
    const v = require('./decision-basis').viewOf(ws, pid, decisionId);
    return { ok: true, v };
  } catch (err) {
    return { ok: false, state: err.code === 'INTEGRITY' ? 'integrity' : 'unreadable', code: err.code || null, words: String(err && err.message || err).slice(0, 400) };
  }
}

function inputsOf(b) {
  if (!b.ok) return { label: b.state, words: b.words, decision_input: null, context: [], prosecutor: null, authority: null, later: [] };
  const v = b.v;
  const research = v.basis.research || [];
  const input = research.find((e) => e.use === 'decision_input') || null;
  const pick = (e) => (e ? { provider: e.provider, report_id: e.report_id || null, model_version: e.model_version || null, versions: e.versions || null, grade: e.grade || null, state: e.state || null, reason: e.reason || null } : null);
  return {
    label: v.label,
    words: v.words || null,
    decision_input: pick(input),
    context: research.filter((e) => e.use === 'available_context').map(pick),
    prosecutor: v.basis.prosecutor ? { provider: v.basis.prosecutor.provider, model_version: v.basis.prosecutor.model_version, verdict: v.basis.prosecutor.verdict, conviction_score: v.basis.prosecutor.conviction_score, spread: v.basis.prosecutor.spread } : null,
    authority: v.basis.authority || null,
    later: v.later || [],
  };
}

// What the book recorded for this decision, read on its own and never through
// the basis: a basis that does not hold leaves the book's facts as they are.
// A journal that does not read is a refusal of its own (no partial journal).
const EXEC_REFUSED = new Set(['unreadable', 'integrity']);
function executionFor(ws, decisionId) {
  return require('./decision-basis').executionOf(ws, decisionId);
}

// The order's fill, in the book's own words: full, part, none, or unknown.
function fillOf(req, exec) {
  const ordered = exec && exec.reserved.length ? exec.reserved.find((r) => r.side === 'OPEN_LONG') || exec.reserved[0] : null;
  if (!ordered) return null;
  const want = dec(ordered.quantity);
  const got = exec.fills.filter((f) => f.client_order_id === ordered.client_order_id).reduce((a, f) => a + dec(f.quantity), 0n);
  const state = req.order_state || null;
  let fill;
  if (state === 'UNKNOWN') fill = 'unknown';
  else if (got === 0n) fill = ['ACKED', 'SENT', 'RESERVED'].includes(state) ? 'pending' : 'none';
  else if (got >= want) fill = 'full';
  else fill = 'part';
  return { client_order_id: ordered.client_order_id, order_state: state, ordered_quantity: str(want), filled_quantity: str(got), fill, fee_taker_rate: ordered.venue && ordered.venue.taker_rate !== undefined ? String(ordered.venue.taker_rate) : null };
}

// Fee accounting (Stage 1.5 C1), one closed position's own, from the book's
// fills and exits. Gross is proceeds less the fills' notional; net is gross
// less every fee. An unknown part leaves what needs it null, never zero. A net
// that differs from the book's realized result does not hold: the book's own
// records disagree, and the view is refused rather than choosing one. Rows
// only, with no totals: Q3 allows counts and rows before 50 closed positions.
const known = (v) => typeof v === 'string' && v !== '';
function accountingOf(fills, exits, realizedPnlUsd) {
  const closed = fills.length > 0 && exits.length > 0;
  const flows = closed && fills.every((f) => known(f.notional_usd)) && exits.every((e) => known(e.proceeds_usd));
  const fees = [...fills.map((f) => f.fee_usd), ...exits.map((e) => e.fee_usd)];
  const gross = flows ? exits.reduce((a, e) => a + dec(e.proceeds_usd), 0n) - fills.reduce((a, f) => a + dec(f.notional_usd), 0n) : null;
  const total = closed && fees.every(known) ? fees.reduce((a, f) => a + dec(f), 0n) : null;
  const net = gross !== null && total !== null ? gross - total : null;
  return {
    gross_pnl_usd: gross === null ? null : str(gross),
    total_fees_usd: total === null ? null : str(total),
    net_pnl_usd: net === null ? null : str(net),
    holds: net === null || !known(realizedPnlUsd) || net === dec(realizedPnlUsd),
  };
}

// The fills' quantity-weighted price against the signal, in basis points of the
// signal: positive paid more than it, negative less. No fill or no usable
// signal is null, never zero.
const BPS = dec('10000');
function signalVsFillBps(signal, fills) {
  if (!known(signal) || !fills.length) return null;
  const quantity = fills.reduce((a, f) => a + dec(f.quantity), 0n);
  const paid = fills.reduce((a, f) => a + D.mul(dec(f.quantity), dec(f.price)), 0n);
  const atSignal = D.mul(quantity, dec(signal));
  if (atSignal <= 0n) return null;
  return str(D.div(D.mul(paid - atSignal, BPS), atSignal));
}
const SIGNAL_BASIS = 'Against the order\'s limit as reserved, weighted by quantity. Negative means the fills were below it. The book never fills a buy above its limit.';

function positionOf(req, exec, tv) {
  const p = req.position || null;
  if (!p) return null;
  const closed = (tv.results.closed_positions || []).find((x) => x.decision_id === req.decision_id) || null;
  const fills = exec ? exec.fills : [];
  const exits = exec ? exec.exits : [];
  const fees = [...fills.map((f) => f.fee_usd), ...exits.map((e) => e.fee_usd)];
  const feesKnown = fees.length > 0 && fees.every((f) => typeof f === 'string' && f !== '');
  const ordered = exec && exec.reserved.length ? exec.reserved.find((r) => r.side === 'OPEN_LONG') || null : null;
  const signal = {
    signal_vs_fill_bps: ordered ? signalVsFillBps(ordered.entry_price, fills.filter((f) => f.client_order_id === ordered.client_order_id)) : null,
    signal_basis: SIGNAL_BASIS,
  };
  if (p.state === 'closed' && closed) {
    const { holds, ...accounting } = accountingOf(fills, exits, closed.realized_pnl_usd);
    return {
      state: 'closed',
      position_id: closed.position_id,
      realized_pnl_usd: closed.realized_pnl_usd,
      ...accounting,
      ...signal,
      ...(holds ? {} : { does_not_reconcile: `Its fills and exits give a net of ${accounting.net_pnl_usd}, and the book's realized result is ${closed.realized_pnl_usd}.` }),
      fees_usd: feesKnown ? sumDec(fees) : null,
      fees: feesKnown ? 'complete' : 'incomplete',
      exit_reason: closed.exits && closed.exits.length ? closed.exits[closed.exits.length - 1].reason : null,
      basis: 'Trader Sim: proceeds less every fee less the fills\' cost',
    };
  }
  return { state: 'open', position_id: p.position_id || null, realized_pnl_usd: null, gross_pnl_usd: null, total_fees_usd: null, net_pnl_usd: null, ...signal, fees: feesKnown ? 'complete' : 'incomplete' };
}

function groupKeyOf(row) {
  const mv = row.inputs.decision_input ? row.inputs.decision_input.model_version : null;
  return {
    decided_by: row.decided_by,
    researcher_model_version: row.inputs.label === 'integrity' || row.inputs.label === 'unreadable' ? 'unknown' : mv || 'not_stated',
    execution_policy: { engine: NOT_RECORDED, rules_sha256: NOT_RECORDED, fee_taker_rate: row.order ? row.order.fee_taker_rate : null },
  };
}

function selectionOf(ws, rows, w) {
  const tickets = require('./tickets');
  const { loadReports, isEligible } = require('./reports');
  const projects = require('./projects').listProjects(ws).filter((p) => !p.broken);
  const tradedInputs = new Set(rows.filter((r) => r.order).map((r) => r.inputs.decision_input && r.inputs.decision_input.report_id).filter(Boolean));
  const grantedInputs = new Set(rows.map((r) => r.inputs.decision_input && r.inputs.decision_input.report_id).filter(Boolean));
  const eligible = [];
  const vetoed = [];
  const zeroGates = [];
  for (const p of projects) {
    const pid = p.project_id;
    for (const r of loadReports(ws, pid)) {
      if (!r.meta || r.meta.provider !== 'claude' || !isEligible(r) || !inWindow(r.meta.imported_at, w)) continue;
      eligible.push({ project_id: pid, report_id: r.report_id, imported_at: r.meta.imported_at || null });
    }
    const receipts = tickets.listReceipts(ws, pid).filter((x) => !x.broken);
    for (const rc of receipts) {
      const suggested = rc.desk ? rc.desk.suggested_risk_usd : null;
      if ((rc.kind === 'desk_gate' || suggested === 0) && inWindow(rc.saved_at, w)) zeroGates.push({ project_id: pid, receipt_id: rc.receipt_id, report_id: rc.researcher ? rc.researcher.report_id || null : null, kind: rc.kind === 'desk_gate' ? 'desk_gate' : 'sized_zero', saved_at: rc.saved_at || null });
    }
    for (const d of tickets.readDecisions(ws, pid)) {
      if (d.action === 'veto' && inWindow(d.decided_at, w)) vetoed.push({ project_id: pid, decision_id: d.decision_id, receipt_id: d.receipt_id, decided_at: d.decided_at, decided_by: decidedByKind(d) });
    }
  }
  const traded = eligible.filter((r) => tradedInputs.has(r.report_id));
  const untraded = eligible.filter((r) => !tradedInputs.has(r.report_id)).map((r) => ({ ...r, why: grantedInputs.has(r.report_id) ? 'granted, no order reserved' : 'no grant' }));
  return {
    eligible_claude_reports: eligible.length,
    traded: traded.length,
    words: `Traded ${traded.length} of ${eligible.length} eligible Claude report${eligible.length === 1 ? '' : 's'} in the window. Selected trades are not an unbiased model comparison.`,
    untraded,
    vetoed,
    zero_gates: zeroGates,
  };
}

// The view refused (blueprint §5.2: INTEGRITY, 409, naming the record). Its
// words name every record that does not hold and say what the book recorded,
// read apart from the basis; with the book itself unread, no count at all.
const n = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
function refusal(refused, denominators) {
  const named = refused.map((x) => `Decision ${x.decision_id} on ${x.project_id}: ${x.words}`).join(' ');
  const book = denominators
    ? `The book's own records stand, read apart from the basis: ${n(denominators.decisions_granted, 'decision')} granted, ${n(denominators.orders_reserved, 'order')} reserved, ${n(denominators.positions.open, 'position')} open and ${denominators.positions.closed} closed.`
    : 'The book\'s own records do not read, so no count is given: unknown is not zero.';
  const { OpError } = require('./ops');
  return new OpError('INTEGRITY', `The attribution view is refused: ${n(refused.length, 'record does', 'records do')} not hold. Nothing is rebuilt or put in its place. ${named} ${book}`, { refused, denominators });
}

function view(ws, { now, from = null, to = null } = {}) {
  const w = windowOf({ from, to });
  const tv = require('./trader-desk').view(ws, { now });
  const rows = [];
  const refused = [];
  let bookUnread = false;
  for (const req of tv.requests) {
    if (!inWindow(req.decided_at, w)) continue;
    const lines = require('./tickets').readDecisions(ws, req.project_id);
    const d = lines.find((x) => x.decision_id === req.decision_id) || {};
    const b = basisOf(ws, req.project_id, req.decision_id);
    if (!b.ok) refused.push({ decision_id: req.decision_id, project_id: req.project_id, record: 'decision_basis', state: b.state, code: b.code, words: b.words });
    const inputs = inputsOf(b);
    let exec = executionFor(ws, req.decision_id);
    if (exec && EXEC_REFUSED.has(exec.state)) {
      bookUnread = true;
      refused.push({ decision_id: req.decision_id, project_id: req.project_id, record: 'book_journal', state: exec.state, code: exec.code || 'INTEGRITY', words: String(exec.words || `${exec.source} does not read.`).slice(0, 400) });
      exec = null;
    }
    const order = fillOf(req, exec);
    const row = {
      decision_id: req.decision_id,
      project_id: req.project_id,
      receipt_id: req.receipt_id,
      action: req.action,
      decided_at: req.decided_at,
      decided_by: decidedByKind(d),
      risk_usd: req.risk_usd,
      in_force: req.in_force,
      phase: req.phase,
      final: req.final === true,
      phase_words: req.words,
      inputs,
      order,
      position: positionOf(req, exec, tv),
      not_recorded_at_execution: exec ? exec.not_recorded : [],
    };
    row.group = groupKeyOf(row);
    if (row.position && row.position.does_not_reconcile) refused.push({ decision_id: req.decision_id, project_id: req.project_id, record: 'book_accounting', state: 'integrity', code: 'INTEGRITY', words: row.position.does_not_reconcile });
    rows.push(row);
  }
  const count = (f) => rows.filter(f).length;
  const denominators = {
    decisions_granted: rows.length,
    intents: {
      not_opened_final: count((r) => r.phase === 'not_opened' && r.final),
      not_opened_not_final: count((r) => r.phase === 'not_opened' && !r.final),
      waiting: count((r) => r.phase === 'waiting' || r.phase === 'ready'),
      refused: count((r) => r.phase === 'refused'),
    },
    orders_reserved: count((r) => r.order),
    fills: {
      full: count((r) => r.order && r.order.fill === 'full'),
      part: count((r) => r.order && r.order.fill === 'part'),
      unfilled: count((r) => r.order && r.order.fill === 'none'),
      pending: count((r) => r.order && r.order.fill === 'pending'),
      unknown: count((r) => r.order && r.order.fill === 'unknown'),
    },
    positions: { open: count((r) => r.position && r.position.state === 'open'), closed: count((r) => r.position && r.position.state === 'closed') },
    closed_fees: { complete: count((r) => r.position && r.position.state === 'closed' && r.position.fees === 'complete'), incomplete: count((r) => r.position && r.position.state === 'closed' && r.position.fees !== 'complete') },
    basis: { decision_time: count((r) => r.inputs.label === 'decision_time'), unverified: count((r) => r.inputs.label === 'unverified'), reconstructed: count((r) => r.inputs.label === 'reconstructed'), refused: count((r) => r.inputs.label === 'integrity' || r.inputs.label === 'unreadable') },
    excluded: { count: 0, of: rows.length, rule: 'none', words: `0 excluded of ${rows.length}.` },
  };
  if (refused.length) throw refusal(refused, bookUnread ? null : denominators);
  const groups = new Map();
  for (const r of rows) {
    const k = JSON.stringify(r.group);
    const g = groups.get(k) || { key: r.group, decisions: 0, orders_reserved: 0, closed: 0, open: 0, decision_ids: [] };
    g.decisions += 1;
    if (r.order) g.orders_reserved += 1;
    if (r.position && r.position.state === 'closed') g.closed += 1;
    if (r.position && r.position.state === 'open') g.open += 1;
    g.decision_ids.push(r.decision_id);
    groups.set(k, g);
  }
  return {
    format: FORMAT,
    writes_nothing: true,
    now: tv.now,
    window: w,
    views: VIEWS,
    settlement: tv.settlement,
    denominators,
    rates: null,
    rates_words: NO_RATE,
    group_key: ['decided_by', 'researcher_model_version', 'execution_policy'],
    groups: [...groups.values()],
    selection: selectionOf(ws, rows, w),
    rows,
    words: 'One row per decision that granted risk to the Trader Sim: what it stood on beside what the book recorded, never merged. A trade is one executed policy outcome; no model earned its result.',
  };
}

module.exports = { FORMAT, VIEWS, NO_RATE, view, accountingOf, signalVsFillBps };
