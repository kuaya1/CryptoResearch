// The project page's Compare view (views/brief-compare.js) on the desk's own
// saved reports: the project record the page already holds (one read of GET
// /api/projects/<id>), shaped the way compare-model.js reads a report, so the
// rules are the Second opinion's own: numbers compared only under the same
// stated profile and rubric and the same category definition; a range never a
// midpoint; unknown and N/A kept; nothing averaged, no consensus, no winner.
// The default pair is the desk's own latest eligible Claude and ChatGPT
// reports (compare.js latestByProvider, sent as d.comparison.latest). The
// basis of a difference is each report's own stored words and citations;
// where they give none, it says the records cannot explain it. Nothing here
// fetches, saves, asks a model or reads the Explorer. No DOM: pure, for the
// tests.
import { compareReports, compareScores, relationOf, reportChoices, valueOf, valueText, MODEL_LABELS } from './compare-model.js';
import { selectBriefReport, emptyOf, ineligibleReason } from './brief-model.js';

const list = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const ymd = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
const TAGS = ['V', 'C', 'I', 'S'];
export const WHERE = 'with these reports';

// The calendar day a report says it was analyzed, by the desk's own rule
// (core/explorer-adapter.js researchDate): readable and not more than a day
// after the save; else unknown.
function researchDate(r) {
  const t = r.analysis_timing;
  const at = r.assessment && r.assessment.analysis_at;
  if (!t || !['ok', 'after_save'].includes(t.status)) return null;
  if ((t.zone === 'utc' || t.zone === 'offset') && t.normalized) return ymd(t.normalized);
  return ymd(String(at || '').trim());
}

// One stored grade (a category, a component or a downside-risk score) as
// compare-model.js reads it, with the report's own words beside it.
function gradeRow(id, label, position, s, flags = []) {
  const st = s && typeof s === 'object' ? s.status : null;
  const scored = st === 'scored' && num(s.value);
  const ranged = st === 'range' && num(s.low) && num(s.high);
  const status = scored ? 'scored' : ranged ? 'range' : st === 'not_applicable' ? 'not_applicable' : 'unknown';
  return {
    category_id: id,
    category_label: label || id,
    position,
    status,
    score: scored ? s.value : null,
    score_low: ranged ? s.low : null,
    score_high: ranged ? s.high : null,
    confidence: (scored || ranged) && ['high', 'medium', 'low'].includes(s.confidence) ? s.confidence : null,
    evidence_refs: list(s && s.evidence_refs).filter((x) => typeof x === 'string'),
    rationale: s ? str(s.rationale) : null,
    unknown_reason: status === 'unknown' && s ? str(s.missing_data) : null,
    strongest_evidence: s ? str(s.strongest_evidence) : null,
    main_weakness: s ? str(s.main_weakness) : null,
    would_raise: s ? str(s.would_raise) : null,
    would_lower: s ? str(s.would_lower) : null,
    evidence_flags: flags,
  };
}

// The category grades a report gives, in its scoring profile's order (the
// profile it states: index.rubrics.profiles), as the Explorer stores them: a
// category the profile lists and the report does not grade gets no row.
// Without its profile on this desk, the report's own categories, in its order.
function categoryScores(r, profiles) {
  const a = r.assessment || {};
  const scores = a.diagnostic_scores || {};
  const profile = list(profiles).find((p) => p && p.profile_ref === a.sector_profile) || null;
  const flags = list(r.evidence && r.evidence.flags);
  const flagsFor = (id) => flags.filter((f) => list(f.categories).includes(id)).map((f) => ({ rule: f.rule || null, severity: f.severity, message: f.beside || f.message }));
  const defs = profile ? list(profile.diagnostic_categories) : Object.keys(scores).map((id) => ({ id, label: id }));
  const rows = [];
  defs.forEach((def, i) => {
    const s = scores[def.id];
    if (s && typeof s === 'object') rows.push(gradeRow(def.id, def.label, i + 1, s, flagsFor(def.id)));
  });
  return { rows, profile_known: Boolean(profile) };
}

// The six weighted components (or the four downside-risk scores) under the
// rubric the desk holds, every one listed: a component the report does not
// give is a row with no grade (compare-model says "Not in report").
function rubricScores(a, defs, key) {
  return list(defs).map((def, i) => gradeRow(def.id, def.label, i + 1, (a[key] || {})[def.id] || null));
}

// One saved report of the desk as a comparison record: what compare-model.js
// reads (model, versions, run, horizon, research date, revision link, the
// desk's grade, category grades) and `report`, the saved record itself.
// `order` is its place in the desk's own order (reports.js reportSortKey: the
// project record lists reports newest first by it).
export function deskRecord(r, { order, profiles, grading = null }) {
  const a = r.assessment || {};
  const mp = (r.meta && r.meta.provenance) || {};
  const pv = r.provenance || {};
  const hz = a.position_context && a.position_context.horizon ? a.position_context.horizon : {};
  const g = r.grade || null;
  const rv = r.revision && r.revision.kind === 'revision' ? r.revision : null;
  const cats = categoryScores(r, profiles);
  return {
    report_id: r.report_id,
    model: r.meta.provider,
    model_version: str(a.model_version),
    research_run_id: str(pv.research_run_id) || str(mp.research_run_id) || str(a.research_run_id),
    research_date: researchDate(r),
    analysis_at: str(a.analysis_at),
    saved_at: (r.meta && r.meta.imported_at) || null,
    order_key: String(order).padStart(6, '0'),
    horizon_text: str(a.horizon),
    horizon_start: ymd(hz.start_date),
    horizon_end: ymd(hz.end_date),
    prompt_version: str(a.prompt_version),
    rubric_version: str(a.rubric_version),
    profile_version: str(a.sector_profile),
    prompt_sha256: str(mp.prompt_sha256) || str(pv.prompt_sha256),
    evidence_packet_sha256: str(mp.evidence_packet_sha256),
    verdict: str(a.verdict),
    revision_of: rv ? rv.of || null : null,
    revision_kind: rv ? (rv.declared && rv.declared.kind) || 'not_stated' : null,
    revision_basis: rv ? rv.basis || null : null,
    revision_note: rv && rv.declared ? str(rv.declared.note) : null,
    grade_status: g ? g.status : 'none',
    grade_display: g && g.display ? g.display : null,
    grade_value: g && num(g.value) ? g.value : null,
    grade_low: g && num(g.low) ? g.low : null,
    grade_high: g && num(g.high) ? g.high : null,
    grade_coverage_pct: g && num(g.coverage_pct) ? g.coverage_pct : null,
    grade_unscored: g ? list(g.missing).map((m) => m.label || m.id) : [],
    grade_reason: g && g.status !== 'firm' && g.status !== 'range' ? str(g.reason) : null,
    evidence_high: (r.evidence && r.evidence.high) || 0,
    evidence_medium: (r.evidence && r.evidence.medium) || 0,
    category_scores: cats.rows,
    profile_known: cats.profile_known,
    components: grading ? rubricScores(a, grading.investment_components, 'investment_components') : [],
    risks: grading ? rubricScores(a, grading.risk_scores, 'risk_scores') : [],
    report: r,
  };
}

// Every saved report the comparison can read: eligible text reports (never a
// quarantined, excluded or PDF answer), in the desk's order; and, apart, the
// ones it cannot, each with why (the brief's own rule, brief-model.js).
export function deskRecords(d, { profiles = [], grading = null } = {}) {
  const reports = list(d && d.reports).filter((r) => r && !r.broken && r.meta);
  const n = reports.length;
  const records = [];
  const set_aside = [];
  reports.forEach((r, i) => {
    const why = ineligibleReason(r);
    if (why) set_aside.push({ report_id: r.report_id, model: r.meta.provider, why, saved_at: r.meta.imported_at || null });
    else records.push(deskRecord(r, { order: n - i, profiles, grading }));
  });
  return { records, set_aside };
}

// The desk's own latest eligible report of a model (d.comparison.latest), as
// a record; null when it has none. Nothing earlier or from another model is
// put in its place.
export function latestRecord(d, records, model) {
  const meta = d && d.comparison && d.comparison.latest ? d.comparison.latest[model] : null;
  return meta ? records.find((x) => x.report_id === meta.report_id) || null : null;
}

// Why a model has no report to compare, in words, from the brief's own reading
// of the project (brief-model.js emptyOf): an answer quarantined, a PDF
// without a text copy, a report excluded, research waiting or running, the
// model on hold, or simply no report.
export function missingSide(d, { row = null, index = null, model, hosted = false }) {
  const who = MODEL_LABELS[model] || model;
  const e = emptyOf(selectBriefReport(d, { provider: model }), { d, row, index, provider: model, hosted });
  if (e.quarantined) return { who, kind: 'quarantined', report_id: e.quarantined.report_id, text: `${who}'s answer was quarantined: it does not match the research run it was saved for, so it is kept and not compared.` };
  if (e.pdf) return { who, kind: 'pdf', report_id: e.pdf.report_id, text: `${who}'s report is a PDF without a text copy: no grades were read from it, so it is not compared.` };
  if (e.excluded) return { who, kind: 'excluded', report_id: e.excluded.report_id, text: `${who}'s report is excluded from comparison${e.excluded.reason ? `: ${e.excluded.reason}` : ''}.` };
  if (e.job && e.job.key !== 'completed') return { who, kind: 'job', job: e.job, text: `No ${who} report yet. ${e.job.long}` };
  if (e.hold) return { who, kind: 'hold', text: `No ${who} report. ${who} is on hold on this desk: nothing new is assigned to it.` };
  return { who, kind: 'none', text: `No ${who} report for this project; nothing else is put in its place.` };
}

// ---- the basis of a difference -----------------------------------------------

// The same address however it is written (core/compare.js normUrl).
export function normUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    for (const k of [...x.searchParams.keys()]) if (/^utm_|^ref$|^source$/i.test(k)) x.searchParams.delete(k);
    return x.toString().toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
  } catch (_) {
    return null;
  }
}

// What a grade cites, resolved in its own report: each claim with its
// evidence tag, date and sources; a source cited directly; a reference the
// report does not list.
export function citedEvidence(refs, a) {
  const claims = new Map(list(a && a.claims).map((c) => [c.claim_id, c]));
  const sources = new Map(list(a && a.sources).map((s) => [s.source_id, s]));
  const cited = [];
  const dangling = [];
  for (const id of list(refs)) {
    if (claims.has(id)) {
      const c = claims.get(id);
      cited.push({ id, kind: 'claim', text: str(c.text), tag: TAGS.includes(c.evidence_tag) ? c.evidence_tag : null, as_of: str(c.as_of), metric_id: str(c.metric_id), sources: list(c.source_ids).map((s) => sources.get(s)).filter(Boolean) });
    } else if (sources.has(id)) {
      cited.push({ id, kind: 'source', text: null, tag: null, as_of: null, metric_id: null, sources: [sources.get(id)] });
    } else dangling.push(id);
  }
  return { cited, dangling };
}

function sideBasis(rec, s, who) {
  if (!rec) return null;
  const a = (rec.report && rec.report.assessment) || {};
  if (!s) return { who, graded: false, value: 'Not in report', explained: false, reason: null, cited: [], dangling: [], flags: [] };
  const { cited, dangling } = citedEvidence(s.evidence_refs, a);
  const reason = s.rationale || null;
  return {
    who,
    graded: true,
    value: valueText(s),
    kind: valueOf(s).kind,
    confidence: s.confidence,
    reason,
    unknown_reason: s.unknown_reason,
    strongest_evidence: s.strongest_evidence,
    main_weakness: s.main_weakness,
    would_raise: s.would_raise,
    would_lower: s.would_lower,
    cited,
    dangling,
    flags: s.evidence_flags || [],
    // A side "explains" its grade when it stores a reason or cites evidence
    // for it; the desk does not judge whether the reason is right.
    explained: Boolean(reason || s.unknown_reason || cited.length),
  };
}

// The basis of one category's difference: each report's own reason, cited
// evidence (resolved in its own report), weakness and what would change it;
// the sources both cite for it; figures among the cited claims that the desk's
// comparison found to differ (d.comparison.claim_conflicts, computed for each
// model's latest report, so only for that pair); and, when a side gives no
// reason and cites nothing, that the stored records cannot explain it.
export function basisOf(row, recA, recB, names, d) {
  const sides = [sideBasis(recA, row.a, names[0]), sideBasis(recB, row.b, names[1])];
  const urls = (side) => new Map(side ? side.cited.flatMap((c) => c.sources).filter((s) => s && s.url).map((s) => [normUrl(s.url), s]) : []);
  const ua = urls(sides[0]);
  const ub = urls(sides[1]);
  const shared = [...ua.entries()].filter(([k]) => k && ub.has(k)).map(([, s]) => ({ title: str(s.title) || s.url, url: s.url }));
  const latestPair = Boolean(recA && recB && recA.model !== recB.model && latestRecord(d, [recA], recA.model) && latestRecord(d, [recB], recB.model));
  // A figure pair between these two reports where either side's claim is one
  // this category cites.
  const conflicts = [];
  if (latestPair) {
    const claimIds = (side) => new Set(side.cited.filter((c) => c.kind === 'claim').map((c) => c.id));
    const cites = { [recA.report_id]: claimIds(sides[0]), [recB.report_id]: claimIds(sides[1]) };
    for (const m of list(d.comparison && d.comparison.claim_conflicts)) {
      for (const p of list(m.pairs)) {
        if (!cites[p.a.report_id] || !cites[p.b.report_id] || p.a.report_id === p.b.report_id) continue;
        if (!cites[p.a.report_id].has(p.a.claim_id) && !cites[p.b.report_id].has(p.b.claim_id)) continue;
        const [x, y] = p.a.report_id === recA.report_id ? [p.a, p.b] : [p.b, p.a];
        conflicts.push({ metric: m.metric_id, kind: p.kind, missing: p.missing || null, diff_pct: num(p.diff_pct) ? p.diff_pct : null, a: x, b: y });
      }
    }
  }
  const unexplained = sides.filter((s) => s && s.graded && !s.explained).map((s) => s.who);
  return { sides, shared, conflicts, figures_checked: latestPair, unexplained };
}

// The words for a figure pair, as the desk's comparison classifies it
// (core/compare.js classifyPair): a contradiction only for the same metric,
// unit, period, definition and date; anything else says what differs.
export const FIGURE_WORDS = {
  contradiction: 'The figures contradict each other on the same basis',
  agreement: 'The figures agree',
  agreement_shared_source: 'The figures agree, from a shared source',
  different_unit: 'Different units: not compared',
  different_period: 'Different periods: not a contradiction',
  different_definition: 'Different definitions: not a contradiction',
  different_date: 'Measured on different dates: a change over time, not a contradiction',
  context_unstated: 'Not stated the same way by both: unresolved, not a contradiction',
};

// ---- the grade inputs and downside risk, side by side -------------------------

// The six weighted components (or the downside-risk scores) of two reports,
// each with the Second opinion's comparison: a number compared only when both
// state the same rubric version. Each grade stays its own; nothing is summed
// across the two or combined.
export function rubricRows(recA, recB, names, key = 'components') {
  const comparable = Boolean(recA.rubric_version && recA.rubric_version === recB.rubric_version);
  const why = { label: recA.rubric_version && recB.rubric_version ? 'Different rubric versions' : 'Rubric version not stated', detail: 'The two reports do not state the same rubric version, so the numbers are shown side by side and not compared.' };
  const byId = (rec) => new Map(rec[key].map((x) => [x.category_id, x]));
  const xa = byId(recA);
  const xb = byId(recB);
  const ids = [...xa.keys(), ...[...xb.keys()].filter((k) => !xa.has(k))];
  return ids.map((id) => {
    const a = xa.get(id) || null;
    const b = xb.get(id) || null;
    return { id, label: (a || b).category_label, a, b, result: compareScores(a, b, { comparable, nameA: names[0], nameB: names[1], why }) };
  });
}

// ---- the whole view -------------------------------------------------------------

// The research scope's facts that differ or are missing, for the line under
// the grades; the same facts all stay in the details.
export function scopeDifferences(scope) {
  return list(scope && scope.facts).filter((f) => f.differs || (f.missing && !/^Not stored/.test(`${f.a}${f.b}`)) || (f.apart && f.a !== f.b));
}

// The Compare view's content for a pair (a and b are records or null): the
// comparison of the two, or one report's grades alone, with the reasons a side
// is empty. `all`: every record, to follow a chain of revisions.
export function compareView(d, { a, b, records, set_aside = [], row = null, index = null, hosted = false, picked = false }) {
  const first = a || b || null;
  const second = a && b ? b : null;
  const out = { first, second, set_aside, figures_checked: false };
  if (!first) return { ...out, empty: true };
  if (second && first.report_id === second.report_id) return { ...out, same: true };
  if (!second) {
    out.names = [MODEL_LABELS[first.model] || first.model, null];
    out.rows = first.category_scores.map((s) => ({ category_id: s.category_id, label: s.category_label, position: s.position, a: s, b: null, result: null })).sort((x, y) => x.position - y.position);
    return out;
  }
  const cmp = compareReports(first, second, records, { where: WHERE });
  return {
    ...out,
    cmp,
    names: cmp.names,
    relation: relationOf(first, second, records),
    rows: cmp.rows.inspection,
    scope_differences: scopeDifferences(cmp.scope),
    components: rubricRows(first, second, cmp.names, 'components'),
    risks: rubricRows(first, second, cmp.names, 'risks'),
    figures_checked: Boolean(latestRecord(d, [first], first.model) && latestRecord(d, [second], second.model)),
  };
}

// The pickers' choices, the Second opinion's own (latest by the desk's rule,
// revisions, revised later), from the desk's records.
export function deskChoices(records) {
  return reportChoices(records);
}
