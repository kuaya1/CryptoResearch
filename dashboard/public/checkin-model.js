// The review check-in (the Overview's "Since your last review"): one row per
// model with saved reports, Claude first, from the desk's digest
// (core/digest.js changesSince: the review it starts from, each model's
// report then by ID from your receipt, the latest eligible report now, the
// reports saved between) and the project record's reports. Pure, for the app
// and the tests; it never fetches or writes.
//
// The then side is the report your receipt names, never guessed: no review is
// "First review"; a review saved before receipts existed is said to be
// inferred from its time; a report since quarantined, excluded or gone is said
// by its ID and its grade is never given as current. What moved is compared
// only under the same rubric and profile, else "Not directly comparable" and
// why. A newer report than the one you reviewed is said in words.
import { PROVIDERS, PROVIDER_LABELS, shortId, onHoldOf } from './ui.js';
import { gradeOf, verdictOf, keyPoints, categoryGroups } from './brief-model.js';

const list = (v) => (Array.isArray(v) ? v : []);

// A grade in words: a figure, a range as its two ends, Withheld with the
// share of the weight scored, or none.
export function gradeWords(g) {
  if (!g) return 'No grade';
  if (g.status === 'firm') return g.display || String(g.value);
  if (g.status === 'range') return `${g.low}–${g.high}`;
  if (g.status === 'withheld') return typeof g.coverage === 'number' ? `Withheld (${g.coverage}% of the weight scored)` : 'Withheld';
  return 'No grade';
}

const THEN_WORDS = {
  quarantined: 'was quarantined since; its grade is not shown',
  excluded: 'was excluded since; its grade is not shown',
  missing: 'is no longer on file',
  unreadable: 'cannot be read',
  needs_text: 'has no text, so no grade',
};

// One side of a row: the report as the desk holds it now.
export function sideOf(r, { grading = null, provider = 'claude' } = {}) {
  if (!r || r.broken) return null;
  const a = r.assessment || {};
  const g = gradeOf(r, grading, provider);
  const rev = r.revision && r.revision.kind === 'revision' ? r.revision : null;
  return {
    report_id: r.report_id,
    short: shortId(r.report_id),
    analysis_at: a.analysis_at || null,
    saved_at: (r.meta && r.meta.imported_at) || null,
    grade: g,
    grade_words: gradeWords(g),
    verdict: verdictOf(a).label,
    key: keyPoints(a),
    revision: rev ? { of: rev.of, kind: rev.declared && rev.declared.label ? rev.declared.label : rev.basis === 'new_sources' ? 'Revision with new sources' : rev.basis === 'existing_evidence' ? 'Revision using existing evidence' : 'Re-saved with the same scores', note: rev.declared ? rev.declared.note || null : null } : null,
    profile: a.sector_profile || null,
    rubric: a.rubric_version || null,
  };
}

// The review the rows start from, in words.
export function headWords(review, when = (s) => s) {
  const r = review || {};
  const lost = r.requested && r.found === false ? `Review receipt ${shortId(r.requested)} was not found; your latest review is shown.` : null;
  if (r.basis === 'receipt') return { text: `Reviewed ${when(r.reviewed_at)}${r.latest ? '' : ' (an earlier review)'}`, inferred: false, lost };
  if (r.basis === 'inferred_by_time') return { text: `Reviewed ${when(r.reviewed_at)}, report not recorded (inferred from the time)`, inferred: true, lost };
  return { text: 'First review', inferred: false, lost };
}

function changed(a, b) {
  return (a || null) !== (b || null);
}

// The rows: Claude, ChatGPT, Gemini, each only with saved reports (or a
// report your review saw).
export function checkInModel(changes, detail, index, { when = (s) => s } = {}) {
  const ch = changes || {};
  const reports = list(detail && detail.reports);
  const byId = new Map(reports.filter((r) => r && r.report_id).map((r) => [r.report_id, r]));
  const rubrics = (index && index.rubrics) || {};
  const grading = rubrics.grading || null;
  const models = new Map(list(ch.models).map((m) => [m.provider, m]));
  const rows = [];
  for (const prov of PROVIDERS) {
    const m = models.get(prov);
    if (!m) continue;
    const who = PROVIDER_LABELS[prov];
    const hold = onHoldOf(index, prov);
    const nowR = m.now ? byId.get(m.now.report_id) || null : null;
    const now = sideOf(nowR, { grading, provider: prov });
    let then = null;
    let thenNote = null;
    if (m.then) {
      if (m.then.status === 'ok') then = sideOf(byId.get(m.then.report_id) || null, { grading, provider: prov });
      if (!then) thenNote = `Report ${shortId(m.then.report_id)} ${THEN_WORDS[m.then.status] || 'is not available'}.`;
    } else if (m.then_basis === 'not_seen') thenNote = `No ${who} report at that review.`;
    else if (m.then_basis === 'none') thenNote = 'First review';
    else if (m.then_basis === 'inferred_by_time') thenNote = `No ${who} report saved by then.`;
    const between = list(m.between).map((b) => {
      const r = byId.get(b.report_id);
      return { report_id: b.report_id, short: shortId(b.report_id), analysis_at: b.analysis_at, revision: Boolean(r && r.revision && r.revision.kind === 'revision') };
    });
    const kind = between.length && between.every((b) => b.revision) ? 'revision' : 'report';
    const betweenWords = between.length ? `${between.length} earlier ${who} ${kind}${between.length === 1 ? '' : 's'} not shown` : null;
    let moved = null;
    if (then && now && !m.same && m.comparable && m.comparable.ok) {
      const labels = new Map(categoryGroups(nowR, rubrics.profiles, (detail && detail.profile) || null).items.map((x) => [x.id, x.label]));
      const span = (b) => (b[0] === b[1] ? String(b[0]) : `${b[0]}–${b[1]}`);
      moved = {
        grade: { then: then.grade_words, now: now.grade_words, changed: then.grade_words !== now.grade_words },
        verdict: { then: then.verdict, now: now.verdict, changed: changed(then.verdict, now.verdict) },
        risk: { then: then.key.risk, now: now.key.risk, changed: changed(then.key.risk && then.key.risk.text, now.key.risk && now.key.risk.text) },
        confirm: { then: then.key.confirm, now: now.key.confirm, changed: changed(then.key.confirm, now.key.confirm) },
        break: { then: then.key.break, now: now.key.break, changed: changed(then.key.break, now.key.break) },
        categories: list(m.moved && m.moved.categories).map((c) => ({ id: c.id, label: labels.get(c.id) || c.id.replace(/_/g, ' '), then: span(c.from), now: span(c.to) })),
        revision: now.revision,
      };
    }
    rows.push({
      provider: prov,
      who,
      on_hold: Boolean(hold),
      basis: m.then_basis,
      then,
      then_note: thenNote,
      now,
      now_note: now ? null : `No current ${who} report.`,
      same: Boolean(m.same),
      newer: Boolean(m.then && m.now && !m.same),
      between,
      between_words: betweenWords,
      comparable: m.comparable || null,
      not_comparable: m.comparable && !m.comparable.ok ? `Not directly comparable: ${m.comparable.reason}.` : null,
      moved,
    });
  }
  return { head: headWords(ch.review, when), review: ch.review || null, rows };
}
