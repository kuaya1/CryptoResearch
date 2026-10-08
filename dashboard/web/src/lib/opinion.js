// One model's opinion as the inspector and the project page draw it: from the
// one report the index summary names, and only when the project record holds
// that same report (same ID, grade, verdict and analysis date). A record
// that does not (still loading, kept from before a change, or out of step
// with the list) gives no report at all, so nothing is ever drawn from
// another report in its place (review 2026-10-08, F1).
import { PROVIDERS } from '../../../public/ui.js';

const v = (x) => (x === undefined ? null : x);
const gradeKey = (g) => (g ? [g.status, g.value, g.low, g.high, g.coverage_pct].map(v).join('|') : 'none');

export function opinionOf(p, prov, detail) {
  const summary = p && p.providers ? p.providers[prov] || null : null;
  if (!summary) return { status: 'none', summary: null, report: null, report_id: null };
  const id = summary.report_id || null;
  if (!detail) return { status: 'loading', summary, report: null, report_id: id };
  const r = (Array.isArray(detail.reports) ? detail.reports : []).find((x) => x && x.report_id === id) || null;
  const a = (r && r.assessment) || {};
  const same = Boolean(r) && gradeKey(summary.grade) === gradeKey(r.grade) && v(summary.verdict) === v(a.verdict) && v(summary.analysis_at) === v(a.analysis_at);
  if (!same) return { status: 'pending', summary, report: null, report_id: id };
  return { status: 'ok', summary, report: r, report_id: id };
}

// Every model's opinion agrees between the list and the record: what a view
// that sets the models side by side (the comparison) needs before it draws.
export function opinionsAgree(p, detail) {
  if (!detail) return false;
  const latest = (detail.comparison && detail.comparison.latest) || {};
  return PROVIDERS.every((prov) => {
    const summary = p && p.providers ? p.providers[prov] : null;
    const lat = latest[prov] || null;
    if (!summary) return !lat;
    return Boolean(lat && lat.report_id === summary.report_id) && opinionOf(p, prov, detail).status === 'ok';
  });
}
