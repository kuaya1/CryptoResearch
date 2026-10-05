'use strict';
// What a saved report is, next to the same model's earlier reports on the
// project, read from the stored records only (nothing is rewritten):
//   first          the model's first report on the project
//   new_run        new research: a report for another research run (or none)
//   revision       a later report for the same run as an earlier one. Its
//                  basis says what changed:
//                    existing_evidence  scores changed and no source was added
//                    new_sources        scores changed with new sources cited
//                    scores_unchanged   the same scores, rewritten text
// A range the earlier save gave that the revision turns into a point inside
// it, with no new source, is a narrowing of the same judgment (often the
// midpoint), never new research: the label says so, and the earlier save,
// with its range, stays saved.
// A model that saves a revision through its connection says why (kind and
// note, kept on its meta as provenance.revision); reports saved before that
// was asked for have no stated reason, and that is said, never guessed.
// Every original stays saved and listed; the dashboard opens the latest, and
// says when it is a revision.

const REVISION_KINDS = {
  format_fix: 'Format fix: the JSON block misstated the written report',
  reassessment: 'Reassessment: a changed judgment from evidence already in the report',
  new_evidence: 'New evidence: sources retrieved since the earlier save',
  other: 'Other',
};

const runOf = (r) => (r.meta.provenance && r.meta.provenance.research_run_id) || null;
const urlKey = (s) => String((s && (s.url || s.url_raw)) || '').trim().replace(/\/+$/, '').toLowerCase();
const urls = (a) => new Set(((a && a.sources) || []).map(urlKey).filter(Boolean));
const claimTexts = (a) => new Set(((a && a.claims) || []).map((c) => String(c.text || '').trim()).filter(Boolean));
const scoreKey = (s) => (s ? `${s.status}|${s.value ?? ''}|${s.low ?? ''}|${s.high ?? ''}` : 'none');
const scoreText = (s) => (!s ? 'not given' : s.status === 'scored' ? String(s.value) : s.status === 'range' ? `${s.low}–${s.high}` : s.status === 'not_applicable' ? 'N/A' : 'unknown');

function changed(a, b, group) {
  const x = (a && a[group]) || {};
  const y = (b && b[group]) || {};
  return [...new Set([...Object.keys(x), ...Object.keys(y)])]
    .filter((k) => scoreKey(x[k]) !== scoreKey(y[k]))
    .map((k) => ({ id: k, from: scoreText(x[k]), to: scoreText(y[k]) }));
}

// Scores that were a range in the earlier save and are a point inside that
// range now: which, in which group, and whether the point is the midpoint.
function narrowed(a, b) {
  const out = [];
  for (const group of ['investment_components', 'diagnostic_scores', 'risk_scores']) {
    const x = (a && a[group]) || {};
    const y = (b && b[group]) || {};
    for (const k of Object.keys(y)) {
      const s0 = x[k];
      const s1 = y[k];
      if (!s0 || !s1 || s0.status !== 'range' || s1.status !== 'scored') continue;
      if (![s0.low, s0.high, s1.value].every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
      if (s1.value < s0.low || s1.value > s0.high) continue;
      out.push({ id: k, group, from: scoreText(s0), to: scoreText(s1), midpoint: Math.abs(s1.value - (s0.low + s0.high) / 2) <= 0.5 });
    }
  }
  return out;
}

// The new source URLs of `r` against `prev` (for the reply and the label).
function newSources(prev, r) {
  const before = urls(prev.assessment);
  return ((r.assessment && r.assessment.sources) || []).filter((s) => urlKey(s) && !before.has(urlKey(s))).map((s) => s.url || s.url_raw);
}

// The revision record of one report among the project's loaded reports.
function revisionOf(reports, r) {
  if (!r || r.broken) return null;
  const prov = r.meta.provider;
  const at = r.meta.imported_at || '';
  const earlier = reports
    .filter((x) => !x.broken && x.meta.provider === prov && x.report_id !== r.report_id && String(x.meta.imported_at || '') < at)
    .sort((x, y) => String(x.meta.imported_at || '').localeCompare(String(y.meta.imported_at || '')));
  if (!earlier.length) return { kind: 'first' };
  const run = runOf(r);
  const prev = run ? [...earlier].reverse().find((x) => runOf(x) === run) : null;
  if (!prev) return { kind: 'new_run', previous_report_id: earlier[earlier.length - 1].report_id };
  const before = urls(prev.assessment);
  const after = urls(r.assessment);
  const added = newSources(prev, r);
  const claimsBefore = claimTexts(prev.assessment);
  const components = changed(prev.assessment, r.assessment, 'investment_components');
  const categories = changed(prev.assessment, r.assessment, 'diagnostic_scores');
  const risks = changed(prev.assessment, r.assessment, 'risk_scores');
  const scoresChanged = components.length + categories.length + risks.length > 0;
  const basis = !scoresChanged ? 'scores_unchanged' : added.length ? 'new_sources' : 'existing_evidence';
  const declared = r.meta.provenance && r.meta.provenance.revision ? r.meta.provenance.revision : null;
  return {
    kind: 'revision',
    of: prev.report_id,
    run_id: run,
    revision_number: earlier.filter((x) => runOf(x) === run).length,
    basis,
    sources: { before: before.size, after: after.size, added: added.length, dropped: [...before].filter((u) => !after.has(u)).length, added_urls: added.slice(0, 5) },
    claims_added: ((r.assessment && r.assessment.claims) || []).filter((c) => !claimsBefore.has(String(c.text || '').trim())).length,
    changed_components: components,
    changed_categories: categories.length,
    changed_risks: risks.length,
    // Ranges turned into a point inside them; with no new source, not new research.
    narrowed: narrowed(prev.assessment, r.assessment),
    declared: declared ? { kind: declared.kind || null, label: REVISION_KINDS[declared.kind] || null, note: declared.note || null } : null,
    minutes_after: Math.round((Date.parse(at) - Date.parse(prev.meta.imported_at || '')) / 60000) || 0,
  };
}

// One line for any view: "Revision using existing evidence: ..." and so on.
function revisionLabel(rev, { labels = {} } = {}) {
  if (!rev || rev.kind !== 'revision') return null;
  const parts = rev.changed_components.map((c) => `${labels[c.id] || c.id.replace(/_/g, ' ')} ${c.from} → ${c.to}`);
  const what = parts.length ? `${parts.join('; ')}` : rev.changed_categories ? `${rev.changed_categories} category grade(s) changed` : 'no score changed';
  const head = rev.basis === 'existing_evidence' ? 'Revision using existing evidence (no source added)'
    : rev.basis === 'new_sources' ? `Revision with ${rev.sources.added} new source${rev.sources.added === 1 ? '' : 's'}`
      : 'Re-saved: the same scores';
  const why = rev.declared && rev.declared.note ? ` The model's reason: ${rev.declared.note}` : ' No reason was recorded with this save.';
  const nar = narrowedText(rev);
  return `${head}, ${rev.minutes_after} min after ${rev.of}: ${what}.${nar ? ` ${nar}` : ''}${why}`;
}

// "2 ranges became a point inside the same range (1 at its midpoint) with no
// new source: a narrowing of the earlier judgment, not new research."
function narrowedText(rev) {
  const n = rev && Array.isArray(rev.narrowed) ? rev.narrowed : [];
  if (!n.length) return null;
  const mid = n.filter((x) => x.midpoint).length;
  const many = n.length !== 1;
  const midText = mid ? ` (${mid === n.length ? (many ? 'each at its midpoint' : 'at its midpoint') : `${mid} at the midpoint`})` : '';
  return rev.basis === 'new_sources'
    ? `${n.length} range${many ? 's' : ''} became a point inside the same range${midText}.`
    : `${n.length} range${many ? 's' : ''} became a point inside the same range${midText} with no new source: a narrowing of the earlier judgment, not new research.`;
}

module.exports = { REVISION_KINDS, revisionOf, revisionLabel, narrowedText, newSources, runOf };
