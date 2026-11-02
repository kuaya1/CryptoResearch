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
// Each row joins two things side by side, never merged:
// - what the decision stood on: decision-basis.js viewOf (decision_time, or
//   reconstructed for a decision from before the basis existed); a record
//   that does not match its SHA-256 is said by name, never rebuilt;
// - what the book recorded: the trader adapter's own view (trader-desk.js;
//   nothing here calls the book), its phase, order, fills, position, the
//   realized result net of every fee, and whether each fee is known.
//
// Denominators are always shown (§5.4). No rate is shown at any count until
// Eric sets a minimum number of closed positions (Q3): the default is counts
// and rows only. Groups follow Q3's default key: who decided (Eric or the
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
const NO_RATE = 'No rate is shown until Eric sets a minimum number of closed positions (blueprint Q3). Counts and rows only.';
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
    execution: v.execution,
  };
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

function positionOf(req, exec, tv) {
  const p = req.position || null;
  if (!p) return null;
  const closed = (tv.results.closed_positions || []).find((x) => x.decision_id === req.decision_id) || null;
  const fills = exec ? exec.fills : [];
  const exits = exec ? exec.exits : [];
  const fees = [...fills.map((f) => f.fee_usd), ...exits.map((e) => e.fee_usd)];
  const feesKnown = fees.length > 0 && fees.every((f) => typeof f === 'string' && f !== '');
  if (p.state === 'closed' && closed) {
    return {
      state: 'closed',
      position_id: closed.position_id,
      realized_pnl_usd: closed.realized_pnl_usd,
      fees_usd: feesKnown ? sumDec(fees) : null,
      fees: feesKnown ? 'complete' : 'incomplete',
      exit_reason: closed.exits && closed.exits.length ? closed.exits[closed.exits.length - 1].reason : null,
      basis: 'Trader Sim: proceeds less every fee less the fills\' cost',
    };
  }
  return { state: 'open', position_id: p.position_id || null, realized_pnl_usd: null, fees: feesKnown ? 'complete' : 'incomplete' };
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

function view(ws, { now, from = null, to = null } = {}) {
  const w = windowOf({ from, to });
  const tv = require('./trader-desk').view(ws, { now });
  const rows = [];
  for (const req of tv.requests) {
    if (!inWindow(req.decided_at, w)) continue;
    const lines = require('./tickets').readDecisions(ws, req.project_id);
    const d = lines.find((x) => x.decision_id === req.decision_id) || {};
    const inputs = inputsOf(basisOf(ws, req.project_id, req.decision_id));
    const exec = inputs.execution || null;
    delete inputs.execution;
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
    basis: { decision_time: count((r) => r.inputs.label === 'decision_time'), reconstructed: count((r) => r.inputs.label === 'reconstructed'), refused: count((r) => r.inputs.label === 'integrity' || r.inputs.label === 'unreadable') },
    excluded: { count: 0, of: rows.length, rule: 'none', words: `0 excluded of ${rows.length}.` },
  };
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

module.exports = { FORMAT, VIEWS, NO_RATE, view };
