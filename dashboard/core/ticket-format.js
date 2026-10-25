'use strict';
// Pure formatting, rounding and trade-plan geometry helpers for tickets
// (backlog item 62). Extracted from tickets.js unchanged; tickets.js
// re-exports `tradePlanGeometry` and `nearInvalidation`.

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (x, d = 4) => (isNum(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const usd = (n) => `$${Number(n).toLocaleString('en-US')}`;

// Item 53: the invalidation proximity radar. A non-invalidated Prosecutor
// ticket still in play (not vetoed or passed) whose fresh stored price sits
// within NEAR_INVALIDATION_PCT above its invalidation price. Arithmetic on the
// geometry's own fresh price; a stale or missing price says nothing.
const NEAR_INVALIDATION_PCT = 10;
function nearInvalidation(status, geometry) {
  if (!geometry || ['invalidated', 'vetoed', 'passed'].includes(status)) return null;
  const price = geometry.price && geometry.price.status === 'fresh' ? geometry.price.price_usd : null;
  const stop = geometry.stop_usd;
  if (!isNum(price) || !isNum(stop) || !(stop > 0) || !(price > stop)) return null;
  const distance = round(((price - stop) / stop) * 100, 2);
  if (distance > NEAR_INVALIDATION_PCT) return null;
  return { distance_pct: distance, price_usd: price, threshold_usd: stop, words: `Near invalidation: the price $${price} is ${distance}% above the invalidation price $${stop} (within ${NEAR_INVALIDATION_PCT}%).` };
}

// Trade Plan geometry (item 49, `cr-ticket-geometry@1`): where the stored price
// sits against the receipt's own entry zone, target and invalidation price.
// Arithmetic only: a missing number is said unknown, never filled in, and a
// price past the freshness limit (or of unknown age) is not used.
function tradePlanGeometry(proposal, latest, { now = Date.now(), staleMinutes = 90 } = {}) {
  const pr = proposal || {};
  const ez = pr.entry_zone || null;
  const up = pr.upside_target && isNum(pr.upside_target.price_usd) ? pr.upside_target.price_usd : null;
  const stop = pr.invalidation_trigger && isNum(pr.invalidation_trigger.price_usd) ? pr.invalidation_trigger.price_usd : null;
  const low = ez && isNum(ez.low_usd) ? ez.low_usd : null;
  const high = ez && isNum(ez.high_usd) ? ez.high_usd : null;
  const out = {
    version: 'cr-ticket-geometry@1',
    price: { status: 'unknown', price_usd: null, as_of: null, age_minutes: null, reason: null },
    entry_zone: { low_usd: low, high_usd: high },
    upside_target_usd: up,
    stop_usd: stop,
    position: 'unknown', position_pct: null,
    to_upside_pct: null, to_stop_pct: null,
    reward_risk_ratio: null,
    words: null,
  };
  const at = latest && latest.as_of ? Date.parse(latest.as_of) : NaN;
  const age = Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 60000)) : null;
  if (!latest || !isNum(latest.price_usd) || !(latest.price_usd > 0)) out.price.reason = 'No stored price.';
  else if (age === null) out.price = { status: 'unknown', price_usd: latest.price_usd, as_of: latest.as_of || null, age_minutes: null, reason: 'The stored price is of unknown age: it is not used.' };
  else if (age > staleMinutes) out.price = { status: 'stale', price_usd: latest.price_usd, as_of: latest.as_of, age_minutes: age, reason: `The stored price is ${age} min old, past your ${staleMinutes}-minute limit: it is not used.` };
  else out.price = { status: 'fresh', price_usd: latest.price_usd, as_of: latest.as_of, age_minutes: age, reason: null };
  const ref = out.price.status === 'fresh' ? out.price.price_usd : null;
  if (ref !== null) {
    if (low !== null && high !== null) {
      if (ref < low) { out.position = 'below_zone'; out.position_pct = round(((low - ref) / ref) * 100, 2); }
      else if (ref > high) { out.position = 'above_zone'; out.position_pct = round(((ref - high) / high) * 100, 2); }
      else { out.position = 'in_zone'; out.position_pct = 0; }
    }
    if (up !== null) out.to_upside_pct = round(((up - ref) / ref) * 100, 2);
    if (stop !== null) out.to_stop_pct = round(((stop - ref) / ref) * 100, 2);
    if (up !== null && stop !== null && up > ref && ref > stop) out.reward_risk_ratio = round((up - ref) / (ref - stop), 2);
  }
  const bits = [];
  if (out.position !== 'unknown') bits.push(out.position === 'in_zone' ? 'price in the entry zone' : `price ${out.position_pct}% ${out.position === 'above_zone' ? 'above' : 'below'} the entry zone`);
  if (out.to_upside_pct !== null) bits.push(`${out.to_upside_pct}% to the target`);
  if (out.to_stop_pct !== null) bits.push(`${out.to_stop_pct}% to the invalidation price`);
  bits.push(out.reward_risk_ratio !== null ? `reward:risk ${out.reward_risk_ratio}:1` : 'reward:risk unknown');
  out.words = ref === null ? (out.price.reason || 'No fresh price.') + ' Position, distances and reward:risk are unknown.' : `${bits.join('; ')}.`;
  return out;
}

module.exports = { isNum, round, usd, NEAR_INVALIDATION_PCT, nearInvalidation, tradePlanGeometry };
