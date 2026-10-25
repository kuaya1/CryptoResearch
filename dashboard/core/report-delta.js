'use strict';
// The change since Claude's last report on a project (backlog item 26): the
// current eligible Claude report against the eligible one before it, in one
// line ("+4.2 vs Oct 6", "−8.1 vs Oct 6") with a verdict change in words.
// Computed on read from the two stored reports and never stored, so a later
// quarantine or exclusion of either changes it; an earlier report that is no
// longer eligible falls back to the one before it, or says there is none.
//
// A grade delta is given only between two firm grades under the same rubric;
// a range, a withheld grade or another rubric says why and gives no figure.
// Category deltas only under the same rubric, profile and category definition
// (the @1 and @2 profiles are not compared), scored values only, a range never
// a midpoint.

const rubrics = require('./rubrics');
const { scoreBounds } = require('./scoring');
const { reportSortKey, isEligible } = require('./reports');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const dayWord = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};
const rounded = (n) => Math.round(n * 100) / 100;
const signed = (n) => `${n < 0 ? '−' : '+'}${Math.abs(rounded(n)).toFixed(1)}`;

// A grade as it is for the comparison: { kind: 'firm'|'range'|'withheld'|'none', value, display }.
function gradeOf(ws, report) {
  const g = rubrics.gradeAssessment(ws, report.assessment);
  if (!g) return { kind: 'none', value: null, display: null };
  if (g.status === 'firm' && isNum(g.value)) return { kind: 'firm', value: g.value, display: g.display || String(g.value) };
  if (isNum(g.low) && isNum(g.high) && g.status !== 'withheld') return { kind: 'range', value: null, display: g.display || `${g.low}–${g.high}` };
  if (g.status === 'withheld') return { kind: 'withheld', value: null, display: null };
  return isNum(g.value) ? { kind: 'firm', value: g.value, display: g.display || String(g.value) } : { kind: 'none', value: null, display: null };
}

function reportDelta(ws, reports) {
  const claude = reports
    .filter((r) => !r.broken && r.meta.provider === 'claude' && isEligible(r) && r.assessment.source_format !== 'pdf' && !r.assessment.needs_text)
    .sort((a, b) => reportSortKey(b).localeCompare(reportSortKey(a)));
  if (!claude.length) return null;
  const [now, before] = claude;
  if (!before) return { status: 'none', line: 'No earlier eligible Claude report to compare.', previous_report_id: null, new_report_id: now.report_id, grade_delta: null, verdict_changed: false, category_deltas: [] };
  const a = before.assessment;
  const b = now.assessment;
  const gOld = gradeOf(ws, before);
  const gNew = gradeOf(ws, now);
  const sameRubric = a.rubric_version === b.rubric_version;
  const sameProfile = a.sector_profile === b.sector_profile;
  const out = {
    status: 'ok',
    previous_report_id: before.report_id,
    previous_at: a.analysis_at || null,
    new_report_id: now.report_id,
    previous_grade: gOld.display,
    new_grade: gNew.display,
    previous_verdict: a.verdict || null,
    new_verdict: b.verdict || null,
    prompt_versions: { previous: a.prompt_version || null, new: b.prompt_version || null },
    grade_delta: null,
    grade_note: null,
    verdict_changed: Boolean(a.verdict && b.verdict && a.verdict !== b.verdict),
    category_deltas: [],
    category_note: null,
  };
  if (gOld.kind !== 'firm' || gNew.kind !== 'firm') {
    const word = (g) => (g.kind === 'range' ? `a range (${g.display})` : g.kind === 'withheld' ? 'withheld' : 'not graded');
    out.grade_note = `No grade change given: ${gOld.kind !== 'firm' ? `the earlier grade is ${word(gOld)}` : `the new grade is ${word(gNew)}`}.`;
  } else if (!sameRubric) {
    out.grade_note = `No grade change given: rubric ${a.rubric_version || 'not stated'} then, ${b.rubric_version || 'not stated'} now.`;
  } else {
    out.grade_delta = rounded(gNew.value - gOld.value);
  }
  if (!sameRubric || !sameProfile) {
    out.category_note = `Categories are not compared: ${!sameRubric ? `rubric ${a.rubric_version || 'not stated'} then, ${b.rubric_version || 'not stated'} now` : `profile ${a.sector_profile || 'not stated'} then, ${b.sector_profile || 'not stated'} now`}.`;
  } else {
    const x = a.diagnostic_scores || {};
    const y = b.diagnostic_scores || {};
    for (const id of new Set([...Object.keys(x), ...Object.keys(y)])) {
      const p = x[id] && x[id].status === 'scored' ? scoreBounds(x[id]) : null;
      const q = y[id] && y[id].status === 'scored' ? scoreBounds(y[id]) : null;
      if (p && q && p[0] !== q[0]) out.category_deltas.push({ id, from: p[0], to: q[0], delta: rounded(q[0] - p[0]) });
    }
    out.category_deltas.sort((m, n) => Math.abs(n.delta) - Math.abs(m.delta) || m.id.localeCompare(n.id));
  }
  const when = dayWord(a.analysis_at);
  const parts = [];
  if (out.grade_delta !== null) parts.push(`${signed(out.grade_delta)} vs ${when || 'the earlier report'}`);
  else parts.push(`${out.grade_note.replace(/^No grade change given: /, 'Grade change not given: ').replace(/\.$/, '')}${when ? ` (vs ${when})` : ''}`);
  if (out.verdict_changed) parts.push(`verdict ${a.verdict} → ${b.verdict}`);
  out.line = parts.join('; ');
  return out;
}

module.exports = { reportDelta, gradeOf };
