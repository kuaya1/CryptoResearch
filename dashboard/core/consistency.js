'use strict';
// Structure checks: does a report's JSON block agree with itself?
//
// A weighted investment component that the report leaves unknown, while the
// same report scores a reading of the same ground. Seen in ChatGPT's reports
// of 2026-10-03: "timing and executable liquidity" unknown in every one,
// while the same reports scored liquidity risk (43 to 78) and some stated a
// timing view ("extended", "thesis impaired"). Such a pair points at a
// judgment the written report makes that the component leaves out, or a
// difference the report does not explain.
//
// Read-time checks, like the evidence checks: nothing stored changes, no score
// or grade moves, and an unknown is never filled in. A component can rightly
// be unknown next to a scored reading (the report may explain why); a flag
// says where to look, never that the report is wrong.

// The readings in the same report that cover a component's ground. Category
// grades are those of the @2 profiles (cr-research-prompt@5) and of @1 where
// the ids are shared; a profile without one simply has nothing to compare.
const RELATED = {
  sustainable_business_demand: [['diagnostic_scores', 'organic_demand']],
  token_value_capture: [['diagnostic_scores', 'token_value_capture']],
  valuation_supply: [['diagnostic_scores', 'valuation_supply_attractiveness']],
  btc_relative_asymmetry: [['diagnostic_scores', 'btc_relative_opportunity'], ['scenarios', 'probabilities']],
  timing_executable_liquidity: [['diagnostic_scores', 'volume_liquidity'], ['diagnostic_scores', 'cycle_timing'], ['risk_scores', 'liquidity'], ['position_context', 'timing']],
};

const TIMING_LABELS = { early: 'Early', developing: 'Developing', extended: 'Extended', thesis_impaired: 'Thesis impaired' };

const given = (s) => Boolean(s) && typeof s === 'object' && (s.status === 'scored' || s.status === 'range');
const valueText = (s) => (s.status === 'range' ? `${s.low}–${s.high}` : String(s.value));
const humanize = (id) => String(id).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const lowerFirst = (s) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

function joinAnd(list) {
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

// The given readings related to one component, in words.
function readingsFor(a, componentId, labels) {
  const out = [];
  for (const [panel, id] of RELATED[componentId] || []) {
    if (panel === 'diagnostic_scores' || panel === 'risk_scores') {
      const s = a[panel] && a[panel][id];
      if (!given(s)) continue;
      const label = (panel === 'risk_scores' ? labels.risk[id] : labels.diagnostic[id]) || humanize(id);
      out.push({
        where: `${panel}.${id}`,
        label,
        value: s.status === 'range' ? null : s.value,
        low: s.status === 'range' ? s.low : null,
        high: s.status === 'range' ? s.high : null,
        text: panel === 'risk_scores' ? `${lowerFirst(label)} ${valueText(s)} (higher is more risk)` : `the category grade ${lowerFirst(label)} ${valueText(s)}`,
      });
    } else if (panel === 'position_context') {
      const t = a.position_context && a.position_context.timing;
      const state = t && typeof t.state === 'string' ? t.state : null;
      if (!state || !TIMING_LABELS[state]) continue;
      out.push({ where: 'position_context.timing.state', label: 'Timing view', state, text: `a timing view (${TIMING_LABELS[state].toLowerCase()})` });
    } else if (panel === 'scenarios') {
      const items = a.scenarios && Array.isArray(a.scenarios.items) ? a.scenarios.items : [];
      const probs = items.map((x) => x && x.probability_pct);
      if (!items.length || !probs.every((p) => typeof p === 'number' && Number.isFinite(p))) continue;
      out.push({ where: 'scenarios.items[*].probability_pct', label: 'Scenario probabilities', text: `a probability for every scenario (${items.map((x) => `${x.case} ${x.probability_pct}%`).join(', ')})` });
    }
  }
  return out;
}

function labelsFrom(grading, profile) {
  const comp = {};
  const risk = {};
  const diagnostic = {};
  for (const c of (grading && grading.investment_components) || []) comp[c.id] = c.label;
  for (const r of (grading && grading.risk_scores) || []) risk[r.id] = r.label;
  for (const c of (profile && profile.diagnostic_categories) || []) diagnostic[c.id] = c.label;
  return { comp, risk, diagnostic };
}

// The checks for one assessment. grading: the rubric the report declares
// (labels only); profile: its scoring profile (labels only).
function structureChecks(a, { grading = null, profile = null } = {}) {
  const empty = { flags: [], flagged: 0, summary: null };
  if (!a || a.needs_text || !a.investment_components) return empty;
  const labels = labelsFrom(grading, profile);
  const flags = [];
  for (const id of Object.keys(RELATED)) {
    const s = a.investment_components[id];
    // Only a part that is not scored: unknown, or missing from the block.
    // A part marked not applicable says so on purpose.
    if (given(s) || (s && s.status === 'not_applicable')) continue;
    const readings = readingsFor(a, id, labels);
    if (!readings.length) continue;
    const label = labels.comp[id] || humanize(id);
    flags.push({
      component: id,
      label,
      status: s && s.status ? s.status : 'missing',
      readings,
      message: `${label} is ${s && s.status === 'unknown' ? 'unknown' : 'not scored'}, while the same report gives ${joinAnd(readings.map((r) => r.text))}. Check whether its written assessment supports a judgment on this part. Nothing is changed.`,
    });
  }
  return {
    flags,
    flagged: flags.length,
    summary: flags.length
      ? `${flags.length} weighted part${flags.length === 1 ? ' is' : 's are'} not scored while the same report scores related ground: ${joinAnd(flags.map((f) => lowerFirst(f.label)))}. These checks change no score.`
      : null,
  };
}

module.exports = { RELATED, structureChecks };
