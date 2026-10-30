'use strict';
// What a held position stands at (2026-10-25): its unrealized result against
// the cost in the ledger, and how far the stored price is from the invalidation
// price of the ticket in force. Read-only, computed on read, never stored.
//
// No cost is never a zero: units of unknown cost keep "cost unknown" and give
// no result. No ticket, or a ticket with no invalidation price, says so. The
// price is the stored one with its time; the distance is not a forecast.

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const NOT_IN_FORCE = new Set(['pass', 'veto']);

function pnlOf(p) {
  if (p.cost_basis_status === 'unknown' || p.cost_basis_known_usd === null || p.cost_basis_known_usd === undefined) {
    return { status: 'cost_unknown', unrealized_usd: null, words: 'Cost unknown: no result. Use Set cost on the row in Portfolio > Needs attention (or `portfolio set-cost`).' };
  }
  if (!isNum(p.unrealized_known_usd)) return { status: 'price_unavailable', unrealized_usd: null, words: 'No stored price, so no result.' };
  const partial = p.cost_basis_status === 'partial';
  const sign = p.unrealized_known_usd >= 0 ? '+' : '-';
  return {
    status: partial ? 'partial' : 'known',
    unrealized_usd: p.unrealized_known_usd,
    cost_basis_known_usd: p.cost_basis_known_usd,
    words: `Unrealized ${sign}$${Math.abs(p.unrealized_known_usd).toLocaleString('en-US', { maximumFractionDigits: 2 })}${partial ? ' on the units of known cost only; the rest is cost unknown' : ''}.`,
  };
}

function distanceOf(ws, p, { now }) {
  if (!p.project_id) return { status: 'no_project', words: 'No project is bound to this asset, so there is no ticket.' };
  let v;
  try { v = require('./tickets').view(ws, p.project_id, { now }); } catch (err) { return { status: 'unreadable', words: `The ticket could not be read: ${err.message}` }; }
  const t = v.ticket;
  if (!t || t.desk_gate) return { status: 'no_ticket', words: t ? 'The ticket is the desk\'s gate, which sets no invalidation price.' : 'No ticket in force.' };
  if (t.decision && NOT_IN_FORCE.has(t.decision.action)) return { status: 'no_ticket', receipt_id: t.receipt_id, words: `The ticket was ${t.decision.action === 'pass' ? 'passed' : 'vetoed'}: no ticket in force.` };
  const inv = t.invalidation_trigger && t.invalidation_trigger.price_usd;
  if (!isNum(inv)) return { status: 'no_trigger', receipt_id: t.receipt_id, words: 'The ticket in force has no invalidation price.' };
  const price = p.price && isNum(p.price.usd) ? p.price : null;
  const base = { receipt_id: t.receipt_id, invalidation_price_usd: inv, ticket_status: t.status };
  if (t.status === 'invalidated') return { status: 'invalidated', ...base, words: `The ticket is invalidated (${t.invalidation && t.invalidation.words ? t.invalidation.words : 'trigger reached'}).` };
  if (!price) return { status: 'price_unavailable', ...base, words: `Invalidation price $${inv}; no stored price to measure from.` };
  const pct = ((price.usd - inv) / price.usd) * 100;
  const when = price.as_of ? ` (stored ${price.as_of})` : '';
  return { status: 'measured', ...base, price_usd: price.usd, price_as_of: price.as_of || null, distance_pct: Number(pct.toFixed(2)), words: `${Math.abs(pct).toFixed(2)}% ${pct >= 0 ? 'above' : 'below'} the invalidation price $${inv}; price $${price.usd}${when}.` };
}

const DAY_MS = 86400000;
const MARKS = [30, 60, 90, 120];

// Where a position stands in its horizon (2026-10-27, item 72): day n counted
// from the decision day as day 1, the next 30/60/90/120-day mark after it, the
// horizon's end. No horizon end is said in words (`horizon_missing`), never a
// default length; past the end says so. Shared by the held and paper lines.
function checkpoints({ decided_at: decidedAt, horizon_end: endIso, horizon_missing: missing = null }, { now = Date.now() } = {}) {
  const start = Date.parse(decidedAt);
  if (!Number.isFinite(start)) return { status: 'no_decision', words: 'No decision date, so the horizon has no start.' };
  const day = Math.floor((now - start) / DAY_MS) + 1;
  const end = endIso ? Date.parse(endIso) : null;
  if (end === null || !Number.isFinite(end)) {
    return { status: 'horizon_missing', day, horizon_missing: missing || 'No horizon end is on record.', words: `Day ${day}; ${missing || 'no horizon end is on record'} (no default length is used).` };
  }
  const endDay = String(endIso).slice(0, 10);
  if (end <= now) return { status: 'past_end', day, horizon_end: endDay, days_past_end: Math.floor((now - end) / DAY_MS), words: `Day ${day}; the horizon ended on ${endDay}.` };
  const next = MARKS.find((m) => m > day) || null;
  const left = Math.ceil((end - now) / DAY_MS);
  return { status: 'in_horizon', day, next_mark: next, horizon_end: endDay, days_left: left, words: `Day ${day}; ${next ? `next mark day ${next}` : 'past the day 120 mark'}; the horizon ends ${endDay} (${left} ${left === 1 ? 'day' : 'days'} left).` };
}

// Age of Claude's current report against the one research staleness
// threshold (freshness.research_stale_days; report_stale_days is retired).
function researchDue(ws, pid, { now = Date.now() } = {}) {
  let r;
  try { r = require('./compare').latestByProvider(require('./reports').loadReports(ws, pid)).claude; } catch (err) { return { status: 'unreadable', words: `The report could not be read: ${err.message}` }; }
  const at = r && Date.parse(r.assessment.analysis_at);
  if (!r || !Number.isFinite(at)) return { status: 'no_report', words: 'No current Claude report with a date.' };
  const days = Math.max(0, Math.floor((now - at) / DAY_MS));
  const limit = require('./workspace').researchStaleDays(ws.settings);
  if (!isNum(limit)) return { status: 'unknown_limit', age_days: days, words: `Claude's report is ${days} days old; no stale limit is set.` };
  const due = days > limit;
  return { status: due ? 'due' : 'current', age_days: days, limit_days: limit, report_id: r.meta.report_id || null, words: due ? `research due, ${days} days old` : `Claude's report is ${days} days old (due after ${limit})` };
}

// The horizon end the receipt froze, else its run's, else the run in its
// frozen packet; never a default length (the same order as paper.js).
function horizonEndOf(ws, receipt) {
  const dayIso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '').slice(0, 10)) ? String(v).slice(0, 10) : null);
  const r = receipt.researcher || {};
  if (r.horizon && dayIso(r.horizon.end_date)) return { end: dayIso(r.horizon.end_date) };
  const fromRun = (id) => {
    if (!id) return null;
    try {
      const run = require('./research').loadRun(ws, receipt.project_id, id);
      return dayIso(run && run.horizon && run.horizon.end_date);
    } catch (_) { return null; }
  };
  const named = fromRun(r.run_id);
  if (named) return { end: named };
  try {
    if (receipt.packet && receipt.packet.path && receipt.packet.sha256) {
      const pk = JSON.parse(require('./forensics').verifiedFrozen(ws, receipt.packet.path, receipt.packet.sha256, 'The frozen ticket packet'));
      const via = fromRun(pk.researcher && pk.researcher.run_id);
      if (via) return { end: via };
    }
  } catch (_) { /* an unreadable packet names no run */ }
  return { end: null, why: 'The report this ticket answers names no research run with a horizon end on record.' };
}

// The held line's timing: the ticket in force, its decision date and horizon.
function heldHorizon(ws, p, { now = Date.now() } = {}) {
  if (!p.project_id) return { status: 'no_ticket', words: 'No project is bound to this asset, so there is no ticket or horizon.' };
  const tickets = require('./tickets');
  const t = tickets.view(ws, p.project_id, { now }).ticket;
  if (!t || t.desk_gate) return { status: 'no_ticket', words: 'No ticket in force, so no horizon.' };
  if (t.decision && NOT_IN_FORCE.has(t.decision.action)) return { status: 'no_ticket', words: 'The ticket was passed or vetoed: no horizon.' };
  if (!t.decision) return { status: 'no_decision', receipt_id: t.receipt_id, words: 'The ticket has no decision yet, so the horizon has no start.' };
  const receipt = tickets.listReceipts(ws, p.project_id).find((r) => !r.broken && r.receipt_id === t.receipt_id);
  const h = receipt ? horizonEndOf(ws, { ...receipt, project_id: p.project_id }) : { end: null, why: 'The ticket\'s receipt could not be read.' };
  return { receipt_id: t.receipt_id, ...checkpoints({ decided_at: t.decision.at, horizon_end: h.end, horizon_missing: h.why }, { now }), research: researchDue(ws, p.project_id, { now }) };
}

// One entry per open position of a computed portfolio.
function describe(ws, pf, { now = Date.now() } = {}) {
  return pf.positions.filter((p) => !p.closed && p.asset_id !== 'usd').map((p) => ({ asset_id: p.asset_id, project_id: p.project_id || null, pnl: pnlOf(p), invalidation_distance: distanceOf(ws, p, { now }) }));
}

module.exports = { describe, pnlOf, distanceOf, checkpoints, researchDue, heldHorizon };
