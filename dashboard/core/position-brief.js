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
    return { status: 'cost_unknown', unrealized_usd: null, words: 'Cost unknown: no result. Set the cost in Portfolio > Needs attention (portfolio set-cost).' };
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

// One entry per open position of a computed portfolio.
function describe(ws, pf, { now = Date.now() } = {}) {
  return pf.positions.filter((p) => !p.closed && p.asset_id !== 'usd').map((p) => ({ asset_id: p.asset_id, project_id: p.project_id || null, pnl: pnlOf(p), invalidation_distance: distanceOf(ws, p, { now }) }));
}

module.exports = { describe, pnlOf, distanceOf };
