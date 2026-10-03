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

function given(v) {
  return v !== null && v !== undefined && v !== '';
}

// What a category grade also shows from cr-research-prompt@5 on: how strong
// the evidence behind it is, the strongest evidence, the main weakness, and
// what would raise or lower it. Kept as written (trimmed, bounded) and only
// where given, so older score objects are read exactly as before. A
// confidence word outside high / medium / low is noted and not used, and a
// grade that is unknown or not applicable carries no confidence.
const CONFIDENCE = ['high', 'medium', 'low'];
const DETAIL_FIELDS = ['strongest_evidence', 'main_weakness', 'would_raise', 'would_lower'];
const DETAIL_MAX = 1200;

function withDetail(s, raw, label, warnings) {
  if (given(raw.confidence)) {
    const c = String(raw.confidence).trim().toLowerCase();
    if (CONFIDENCE.includes(c)) {
      if (s.status === 'scored' || s.status === 'range') s.confidence = c;
    } else if (!['unknown', 'none', 'n/a', 'na'].includes(c)) {
      warnings.push(`${label}: confidence ${JSON.stringify(raw.confidence)} is not high, medium or low; not used`);
    }
  }
  for (const k of DETAIL_FIELDS) {
    const v = str(raw[k]);
    if (v) s[k] = v.slice(0, DETAIL_MAX);
  }
  return s;
}

// A number written as text: "72", "72.5" or "72/100". Anything else, including
// "7/10" (another scale), is left as it was for the caller to reject.
function numberText(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(\d{1,3}(?:\.\d+)?)\s*(?:\/\s*100)?$/);
  return m ? Number(m[1]) : null;
}

// A range written as one string: "60-70", "60–70", "60 to 70" (optionally /100).
function rangeText(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(\d{1,3}(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d{1,3}(?:\.\d+)?)\s*(?:\/\s*100)?$/i);
  return m ? { low: Number(m[1]), high: Number(m[2]) } : null;
}

// "7/10", "7.5 / 10", "7 out of 10": a 10-point score. It is never converted,
// because 7/10 could mean 70 or a different judgement altogether.
function tenPointText(v) {
  return typeof v === 'string' && /^\d{1,2}(?:\.\d+)?\s*(?:\/|out of)\s*10$/i.test(v.trim());
}

// Returns { score, errors, warnings }. Invalid input becomes status "unknown"
// with the original kept in invalid_source, so nothing invalid is ever scored.
// Leniency is limited to writings whose meaning is not in doubt: status in any
// case, "score" for "value", numbers written as text ("72", "72/100"), a range
// written as "60-70", and an object with no status whose fields say which kind
// of score it is. Each of those, apart from letter case, is noted as a warning.
// A 10-point score, a value outside 1-100, low above high, or an unknown status
// word stays invalid.
function normalizeScore(raw, label = 'score') {
  const errors = [];
  const warnings = [];
  if (raw === null || raw === undefined) return { score: null, errors, warnings };
  if (typeof raw === 'string' && !tenPointText(raw)) {
    // A bare score written as text is read the way a bare number is.
    const n = numberText(raw);
    const r = n === null ? rangeText(raw) : null;
    if (n !== null) {
      warnings.push(`${label}: ${JSON.stringify(raw)} given as text; read as ${n}`);
      raw = n;
    } else if (r) {
      warnings.push(`${label}: ${JSON.stringify(raw)} given as text; read as a range`);
      raw = { status: 'range', low: r.low, high: r.high };
    }
  }
  if (typeof raw === 'number') {
    if (!inScale(raw)) {
      errors.push(`${label}: ${raw} is outside 1-100`);
      return { score: { ...emptyScore('unknown', `Invalid in source: ${raw} is outside 1-100`), invalid_source: raw }, errors, warnings };
    }
    warnings.push(`${label}: given as a bare number; read as a single score with no rationale`);
    return { score: { status: 'scored', value: raw, low: null, high: null, rationale: null, evidence_refs: [], missing_data: null }, errors, warnings };
  }
  if (tenPointText(raw)) {
    errors.push(`${label}: ${JSON.stringify(raw)} is on a 10-point scale; this desk scores 1-100, so it was not converted`);
    return { score: { ...emptyScore('unknown', `Invalid in source: ${raw} is on a 10-point scale; not converted`), invalid_source: raw }, errors, warnings };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${label}: not a score object`);
    return { score: { ...emptyScore('unknown', 'Invalid in source: not a score object'), invalid_source: raw }, errors, warnings };
  }
  const status = typeof raw.status === 'string' ? raw.status.trim().toLowerCase().replace(/[\s-]+/g, '_') : raw.status;
  let value = raw.value;
  if (!given(value) && given(raw.score)) {
    value = raw.score;
    warnings.push(`${label}: "score" read as the value`);
  }
  // Numbers written as text become numbers; anything unreadable stays as it
  // was, so the checks below reject it with what was actually written.
  const asNumber = (v, field) => {
    const n = numberText(v);
    if (n === null) return v;
    warnings.push(`${label}: ${field} ${JSON.stringify(v)} given as text; read as ${n}`);
    return n;
  };
  let low = asNumber(raw.low, 'low');
  let high = asNumber(raw.high, 'high');
  const tenPoint = [value, low, high].find(tenPointText);
  if (tenPoint) {
    errors.push(`${label}: ${JSON.stringify(tenPoint)} is on a 10-point scale; this desk scores 1-100, so it was not converted`);
  }
  value = asNumber(value, 'value');
  const span = rangeText(value);
  if (span && (status === 'range' || !given(status)) && !given(low) && !given(high)) {
    warnings.push(`${label}: value ${JSON.stringify(value)} read as a range`);
    low = span.low;
    high = span.high;
    value = null;
  }
  let kind = status;
  if (!given(status) && !tenPoint) {
    if (isNum(value)) {
      kind = 'scored';
      warnings.push(`${label}: status missing; read as a single score`);
    } else if (!given(value) && isNum(low) && isNum(high)) {
      kind = 'range';
      warnings.push(`${label}: status missing; read as a range`);
    } else if (!given(value) && !given(low) && !given(high) && str(raw.missing_data)) {
      kind = 'unknown';
      warnings.push(`${label}: status missing; read as unknown (no value, only what is missing)`);
    }
  }
  const s = {
    status: kind,
    value: null,
    low: null,
    high: null,
    rationale: str(raw.rationale),
    evidence_refs: Array.isArray(raw.evidence_refs) ? raw.evidence_refs.filter((x) => typeof x === 'string') : [],
    missing_data: str(raw.missing_data),
  };
  if (raw.extraction) s.extraction = raw.extraction;
  switch (tenPoint ? 'ten_point' : kind) {
    case 'ten_point':
      // Already rejected above; the status checks would only repeat it.
      break;
    case 'scored':
      if (!inScale(value)) errors.push(`${label}: a single score must be a number from 1 to 100 (got ${JSON.stringify(value)})`);
      else s.value = value;
      if (given(low) || given(high)) {
        warnings.push(`${label}: low/high ignored for a single score`);
      }
      if (!s.rationale && !s.extraction) warnings.push(`${label}: no rationale given`);
      break;
    case 'range':
      if (!inScale(low) || !inScale(high)) errors.push(`${label}: a range needs low and high from 1 to 100`);
      else if (low > high) errors.push(`${label}: range low ${low} is above high ${high}`);
      else {
        s.low = low;
        s.high = high;
      }
      if (given(value)) warnings.push(`${label}: value ignored for a range`);
      if (!s.rationale) warnings.push(`${label}: range has no rationale, so it is not justified and cannot form a grade range`);
      break;
    case 'unknown':
      if (given(value)) errors.push(`${label}: status unknown must have value null`);
      if (!s.missing_data && !s.rationale) warnings.push(`${label}: unknown without an explanation of what is missing`);
      break;
    case 'not_applicable':
      if (given(value)) errors.push(`${label}: status not_applicable must have value null`);
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
  return { score: withDetail(s, raw, label, warnings), errors, warnings };
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
  CONFIDENCE,
  DETAIL_FIELDS,
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
