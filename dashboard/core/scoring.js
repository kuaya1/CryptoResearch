'use strict';
// Score validation and the investment-grade calculation.
// Rules (see templates/rubrics/cr-grading.v1.json):
// - scores are 1-100, a single value or a justified range, or unknown / not_applicable with a reason
// - grade = sum(component score x weight); weights must total 100%
// - any unknown or N/A component withholds the grade (coverage shown, no renormalization, no midpoint)
// - a complete set of scores where some are justified ranges gives a grade range
// - the model-reported total is compared, never substituted

const STATUSES = ['scored', 'range', 'unknown', 'not_applicable'];

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function inScale(v) {
  return isNum(v) && v >= 1 && v <= 100;
}

function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function emptyScore(status, explanation) {
  return {
    status,
    value: null,
    low: null,
    high: null,
    rationale: status === 'not_applicable' ? explanation : null,
    evidence_refs: [],
    missing_data: status === 'unknown' ? explanation : null,
  };
}

// Returns { score, errors, warnings }. Invalid input becomes status "unknown"
// with the original kept in invalid_source, so nothing invalid is ever scored.
function normalizeScore(raw, label = 'score') {
  const errors = [];
  const warnings = [];
  if (raw === null || raw === undefined) return { score: null, errors, warnings };
  if (typeof raw === 'number') {
    if (!inScale(raw)) {
      errors.push(`${label}: ${raw} is outside 1-100`);
      return { score: { ...emptyScore('unknown', `Invalid in source: ${raw} is outside 1-100`), invalid_source: raw }, errors, warnings };
    }
    warnings.push(`${label}: given as a bare number; read as a single score with no rationale`);
    return { score: { status: 'scored', value: raw, low: null, high: null, rationale: null, evidence_refs: [], missing_data: null }, errors, warnings };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${label}: not a score object`);
    return { score: { ...emptyScore('unknown', 'Invalid in source: not a score object'), invalid_source: raw }, errors, warnings };
  }
  const s = {
    status: raw.status,
    value: null,
    low: null,
    high: null,
    rationale: str(raw.rationale),
    evidence_refs: Array.isArray(raw.evidence_refs) ? raw.evidence_refs.filter((x) => typeof x === 'string') : [],
    missing_data: str(raw.missing_data),
  };
  if (raw.extraction) s.extraction = raw.extraction;
  switch (raw.status) {
    case 'scored':
      if (!inScale(raw.value)) errors.push(`${label}: a single score must be a number from 1 to 100 (got ${JSON.stringify(raw.value)})`);
      else s.value = raw.value;
      if ((raw.low !== null && raw.low !== undefined) || (raw.high !== null && raw.high !== undefined)) {
        warnings.push(`${label}: low/high ignored for a single score`);
      }
      if (!s.rationale && !s.extraction) warnings.push(`${label}: no rationale given`);
      break;
    case 'range':
      if (!inScale(raw.low) || !inScale(raw.high)) errors.push(`${label}: a range needs low and high from 1 to 100`);
      else if (raw.low > raw.high) errors.push(`${label}: range low ${raw.low} is above high ${raw.high}`);
      else {
        s.low = raw.low;
        s.high = raw.high;
      }
      if (raw.value !== null && raw.value !== undefined) warnings.push(`${label}: value ignored for a range`);
      if (!s.rationale) warnings.push(`${label}: range has no rationale, so it is not justified and cannot form a grade range`);
      break;
    case 'unknown':
      if (raw.value !== null && raw.value !== undefined) errors.push(`${label}: status unknown must have value null`);
      if (!s.missing_data && !s.rationale) warnings.push(`${label}: unknown without an explanation of what is missing`);
      break;
    case 'not_applicable':
      if (raw.value !== null && raw.value !== undefined) errors.push(`${label}: status not_applicable must have value null`);
      if (!s.rationale && !s.missing_data) warnings.push(`${label}: not applicable without a reason`);
      break;
    default:
      errors.push(`${label}: status must be one of ${STATUSES.join(', ')} (got ${JSON.stringify(raw.status)})`);
  }
  if (errors.length) {
    return {
      score: { ...emptyScore('unknown', `Invalid in source: ${errors.join('; ')}`), rationale: s.rationale, evidence_refs: s.evidence_refs, invalid_source: raw },
      errors,
      warnings,
    };
  }
  return { score: s, errors, warnings };
}

function sortedLabels(labels) {
  return [...labels].sort((a, b) => b.min - a.min);
}

function labelFor(value, labels) {
  if (!isNum(value)) return null;
  for (const l of sortedLabels(labels)) if (value >= l.min) return l.label;
  return null;
}

// Truncate (not round) to one decimal so the displayed number never lands in a
// higher label band than the full-precision value.
function truncate1(x) {
  return (Math.floor(x * 10 + 1e-9) / 10).toFixed(1);
}

function weightedSum(parts, pick) {
  const values = parts.map(pick);
  if (values.every(Number.isInteger)) {
    // Exact integer arithmetic: sum(v * bp) / 10000.
    const units = parts.reduce((acc, p, i) => acc + values[i] * p.weight_bp, 0);
    return { value: units / 10000, display: (Math.floor(units / 1000) / 10).toFixed(1) };
  }
  const value = parts.reduce((acc, p, i) => acc + (values[i] * p.weight_bp) / 10000, 0);
  return { value, display: truncate1(value) };
}

function computeInvestmentGrade(components, grading, labels) {
  const defs = grading.investment_components;
  const totalBp = defs.reduce((s, c) => s + c.weight_bp, 0);
  const base = { rubric: grading.rubric_ref, weights_total_pct: totalBp / 100 };
  if (totalBp !== 10000) {
    return { ...base, status: 'invalid_weights', value: null, low: null, high: null, display: null, label: null, coverage_pct: 0, parts: [], reason: `Weights total ${totalBp / 100}%, not 100%.` };
  }
  const parts = defs.map((c) => {
    const s = components ? components[c.id] : null;
    const status = s ? s.status : 'missing';
    return {
      id: c.id,
      label: c.label,
      weight_bp: c.weight_bp,
      weight_pct: c.weight_bp / 100,
      status,
      value: s && isNum(s.value) ? s.value : null,
      low: s && isNum(s.low) ? s.low : null,
      high: s && isNum(s.high) ? s.high : null,
      justified: status !== 'range' || Boolean(s && s.rationale),
    };
  });
  const usable = (p) => p.status === 'scored' || (p.status === 'range' && p.justified);
  const coverageBp = parts.filter(usable).reduce((s, p) => s + p.weight_bp, 0);
  const blocking = parts.filter((p) => !usable(p));
  if (blocking.length) {
    return {
      ...base,
      status: 'withheld',
      value: null,
      low: null,
      high: null,
      display: null,
      label: null,
      coverage_bp: coverageBp,
      coverage_pct: coverageBp / 100,
      missing: blocking.map((p) => ({
        id: p.id,
        label: p.label,
        status: p.status,
        reason: p.status === 'range' ? 'range without rationale' : p.status === 'missing' ? 'not provided' : p.status,
      })),
      parts,
      reason: `Grade withheld: ${blocking.map((p) => p.label).join(', ')} ${blocking.length === 1 ? 'is' : 'are'} not scored. ${coverageBp / 100}% of the weight is covered. Weights are not renormalized.`,
    };
  }
  const anyRange = parts.some((p) => p.status === 'range');
  if (!anyRange) {
    const sum = weightedSum(parts, (p) => p.value);
    for (const p of parts) p.contribution = (p.value * p.weight_bp) / 10000;
    return {
      ...base,
      status: 'firm',
      value: sum.value,
      low: null,
      high: null,
      display: sum.display,
      label: labelFor(sum.value, labels),
      coverage_bp: 10000,
      coverage_pct: 100,
      parts,
    };
  }
  const lo = weightedSum(parts, (p) => (p.status === 'range' ? p.low : p.value));
  const hi = weightedSum(parts, (p) => (p.status === 'range' ? p.high : p.value));
  const labelLow = labelFor(lo.value, labels);
  const labelHigh = labelFor(hi.value, labels);
  return {
    ...base,
    status: 'range',
    value: null,
    low: lo.value,
    high: hi.value,
    display: `${lo.display}–${hi.display}`,
    label: labelLow === labelHigh ? labelLow : `${labelLow}–${labelHigh}`,
    label_low: labelLow,
    label_high: labelHigh,
    coverage_bp: 10000,
    coverage_pct: 100,
    parts,
  };
}

function scoreBounds(s) {
  if (!s) return null;
  if (s.status === 'scored' && isNum(s.value)) return [s.value, s.value];
  if (s.status === 'range' && isNum(s.low) && isNum(s.high)) return [s.low, s.high];
  return null;
}

function formatScore(s) {
  if (!s) return 'missing';
  if (s.status === 'scored') return String(s.value);
  if (s.status === 'range') return `${s.low}–${s.high}`;
  if (s.status === 'not_applicable') return 'N/A';
  return 'unknown';
}

// Compares the model's own total with the app-calculated grade. Never replaces either.
function checkModelTotal(grade, reported, tolerance = 1.0) {
  const rb = scoreBounds(reported);
  if (!rb) return { status: 'none', message: 'No model-reported overall score.' };
  const shown = formatScore(reported);
  if (grade.status !== 'firm' && grade.status !== 'range') {
    return {
      status: 'unverifiable',
      reported: shown,
      message: `Model reported ${shown}, but the app cannot calculate a grade (${grade.coverage_pct || 0}% of weight covered). The model's total cannot be checked.`,
    };
  }
  const gb = grade.status === 'firm' ? [grade.value, grade.value] : [grade.low, grade.high];
  const gap = Math.max(0, rb[0] - gb[1], gb[0] - rb[1]);
  if (gap > tolerance) {
    return {
      status: 'mismatch',
      reported: shown,
      calculated: grade.display,
      difference: Math.round(gap * 10) / 10,
      message: `Model-reported total ${shown} differs from the app-calculated ${grade.display} by ${(Math.round(gap * 10) / 10).toFixed(1)} points. Both are kept; neither overwrites the other.`,
    };
  }
  return { status: 'match', reported: shown, calculated: grade.display, message: `Model-reported total ${shown} agrees with the app-calculated ${grade.display} (tolerance ${tolerance}).` };
}

module.exports = {
  STATUSES,
  normalizeScore,
  emptyScore,
  computeInvestmentGrade,
  checkModelTotal,
  labelFor,
  truncate1,
  scoreBounds,
  formatScore,
  inScale,
};
