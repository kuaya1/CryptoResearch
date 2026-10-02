'use strict';
// Model comparison without false certainty (audit F05, F12, F13).
// - Reports are compared only when they declare the same rubric version, sector
//   profile and horizon interval, and ALL their analysis dates fit inside the
//   date window (max date - min date <= window). Others are shown, labeled not
//   comparable, with the reason.
// - A category that the profile marks not applicable is shown but never enters
//   a spread.
// - Spread = widest gap between comparable providers (ranges use their bounds).
// - The median is descriptive only, never a committee grade.
// - Numbers are compared only for the same metric, unit, period, definition and
//   as-of date. A later measurement is a change, not a contradiction; missing
//   context is unresolved, not a conflict. Agreement that rests on the same
//   source is not independent confirmation; different URLs do not prove
//   independent upstream evidence either.

const { scoreBounds, checkModelTotal } = require('./scoring');
const { isEligible, reportSortKey, parseHorizon, horizonKey } = require('./reports');
const { gradeAssessment, resolveProfile } = require('./rubrics');
const { PROVIDERS, PROVIDER_LABELS } = require('./workspace');

const DAY = 86400000;

function latestByProvider(reports) {
  const out = {};
  for (const p of PROVIDERS) {
    const list = reports
      .filter((r) => isEligible(r) && r.meta.provider === p && r.assessment.source_format !== 'pdf' && !r.assessment.needs_text)
      .sort((a, b) => reportSortKey(b).localeCompare(reportSortKey(a)));
    out[p] = list[0] || null;
  }
  return out;
}

function horizonOf(a) {
  return a.horizon_interval || parseHorizon(a.horizon);
}

function groupKey(r) {
  const a = r.assessment;
  return [a.rubric_version || '?', a.sector_profile || '?', horizonKey(horizonOf(a)) || '?'].join('|');
}

function dateOf(r) {
  const t = Date.parse(r.assessment.analysis_at);
  return Number.isNaN(t) ? null : t;
}

// Largest set of reports that share rubric, profile and horizon and whose
// analysis dates all fall within the window.
function comparability(latest, settings) {
  const windowDays = settings.comparison.date_window_days;
  const present = PROVIDERS.filter((p) => latest[p]).map((p) => latest[p]);
  const notes = {};
  if (present.length < 2) {
    return { comparable_providers: [], excluded: {}, reasons: ['Fewer than two providers have an eligible report.'], comparable: false, window_days: windowDays };
  }
  const groups = new Map();
  for (const r of present) {
    const a = r.assessment;
    const missing = [];
    if (!a.rubric_version) missing.push('rubric');
    if (!a.sector_profile) missing.push('sector profile');
    const h = horizonOf(a);
    if (!h) missing.push('horizon');
    else if (h.kind === 'unknown') missing.push(`readable horizon ("${h.raw}")`);
    if (dateOf(r) === null) missing.push('analysis date');
    if (missing.length) {
      notes[r.meta.provider] = `${missing.join(', ')} not stated`;
      continue;
    }
    const k = groupKey(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  let best = [];
  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => dateOf(a) - dateOf(b));
    // Sliding window over the full date span.
    let lo = 0;
    for (let hi = 0; hi < sorted.length; hi++) {
      while (dateOf(sorted[hi]) - dateOf(sorted[lo]) > windowDays * DAY) lo++;
      const subset = sorted.slice(lo, hi + 1);
      if (subset.length > best.length) best = subset;
    }
  }
  if (best.length < 2) best = [];
  const bestSet = new Set(best.map((r) => r.meta.provider));
  const reference = best[0] || null;
  const span = best.length ? Math.round((dateOf(best[best.length - 1]) - dateOf(best[0])) / DAY) : null;
  for (const r of present) {
    const p = r.meta.provider;
    if (bestSet.has(p) || notes[p]) continue;
    const a = r.assessment;
    const why = [];
    if (reference) {
      const ref = reference.assessment;
      if (a.rubric_version !== ref.rubric_version) why.push(`rubric ${a.rubric_version} vs ${ref.rubric_version}`);
      if (a.sector_profile !== ref.sector_profile) why.push(`profile ${a.sector_profile} vs ${ref.sector_profile}`);
      if (horizonKey(horizonOf(a)) !== horizonKey(horizonOf(ref))) why.push(`horizon "${a.horizon}" vs "${ref.horizon}"`);
      if (!why.length) why.push(`analysis date ${a.analysis_at} makes the date span longer than ${windowDays} days`);
    } else {
      why.push('no other report shares its rubric, profile, horizon and date window');
    }
    notes[p] = why.join('; ');
  }
  const reasons = Object.entries(notes).map(([p, why]) => `${PROVIDER_LABELS[p]}: ${why}`);
  return {
    comparable_providers: [...bestSet],
    excluded: notes,
    reasons,
    comparable: bestSet.size >= 2,
    window_days: windowDays,
    date_span_days: span,
    context: reference ? { rubric_version: reference.assessment.rubric_version, sector_profile: reference.assessment.sector_profile, horizon: horizonOf(reference.assessment) } : null,
  };
}

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function rowFor(section, def, latest, comparableSet, threshold, direction) {
  const cells = {};
  for (const p of PROVIDERS) {
    const r = latest[p];
    if (!r) {
      cells[p] = null;
      continue;
    }
    const group = section === 'diagnostic' ? r.assessment.diagnostic_scores : section === 'component' ? r.assessment.investment_components : r.assessment.risk_scores;
    cells[p] = group && group[def.id] ? group[def.id] : null;
  }
  const applicable = def.applicable !== false;
  const usable = PROVIDERS.filter((p) => comparableSet.has(p) && cells[p] && cells[p].status !== 'not_applicable');
  const bounds = applicable ? usable.map((p) => scoreBounds(cells[p])).filter(Boolean) : [];
  const points = applicable ? usable.filter((p) => cells[p].status === 'scored').map((p) => cells[p].value) : [];
  const spread = bounds.length >= 2 ? Math.max(...bounds.map((b) => b[1])) - Math.min(...bounds.map((b) => b[0])) : null;
  return {
    section,
    id: def.id,
    label: def.label,
    direction,
    applicable,
    na_reason: applicable ? null : def.na_reason || 'Not applicable under this sector profile',
    resolving_question: def.resolving_question || null,
    cells,
    spread,
    spread_flag: spread !== null && spread >= threshold,
    median: points.length >= 2 ? median(points) : null,
    median_note: points.length >= 2 ? 'Descriptive median of comparable single scores. Not a committee grade.' : null,
  };
}

function normUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    for (const k of [...x.searchParams.keys()]) if (/^utm_|^ref$|^source$/i.test(k)) x.searchParams.delete(k);
    return x.toString().toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
  } catch (_) {
    return null;
  }
}

function sharedSources(latest) {
  const map = new Map();
  const perProvider = {};
  for (const p of PROVIDERS) {
    const r = latest[p];
    if (!r) continue;
    const sources = r.assessment.sources || [];
    const urls = new Set(sources.map((s) => s.url && normUrl(s.url)).filter(Boolean));
    perProvider[p] = urls.size;
    for (const s of sources) {
      const n = s.url && normUrl(s.url);
      if (!n) continue;
      if (!map.has(n)) map.set(n, { url: s.url, title: s.title || null, providers: new Set() });
      map.get(n).providers.add(p);
    }
  }
  const shared = [...map.values()].filter((v) => v.providers.size >= 2).map((v) => ({ url: v.url, title: v.title, providers: [...v.providers] }));
  const overlap = {};
  for (const p of Object.keys(perProvider)) {
    const mine = shared.filter((s) => s.providers.includes(p)).length;
    overlap[p] = { sources: perProvider[p], shared: mine, shared_pct: perProvider[p] ? Math.round((mine / perProvider[p]) * 100) : null };
  }
  return { shared, overlap, note: 'Agreement between providers that cite the same sources is not independent confirmation. Different URLs do not prove independent upstream evidence either.' };
}

function normText(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function asOfTime(c) {
  const t = Date.parse(c.as_of);
  return Number.isNaN(t) ? null : t;
}

function classifyPair(ca, cb, a, b, tolerancePct, sameDateDays) {
  const big = Math.max(Math.abs(ca.value), Math.abs(cb.value));
  const diffPct = big === 0 ? 0 : (Math.abs(ca.value - cb.value) / big) * 100;
  if (ca.unit && cb.unit && normText(ca.unit) !== normText(cb.unit)) return { kind: 'different_unit', diffPct };
  if (!ca.unit || !cb.unit) return { kind: 'context_unstated', missing: 'unit', diffPct };
  if (!ca.period || !cb.period) return { kind: 'context_unstated', missing: 'period', diffPct };
  if (normText(ca.period) !== normText(cb.period)) return { kind: 'different_period', diffPct };
  if (!ca.definition || !cb.definition) return { kind: diffPct > tolerancePct ? 'context_unstated' : (a.urls.some((u) => b.urls.includes(u)) ? 'agreement_shared_source' : 'agreement'), missing: 'definition', diffPct };
  if (normText(ca.definition) !== normText(cb.definition)) return { kind: 'different_definition', diffPct };
  const ta = asOfTime(ca);
  const tb = asOfTime(cb);
  if (ta === null || tb === null) return { kind: diffPct > tolerancePct ? 'context_unstated' : (a.urls.some((u) => b.urls.includes(u)) ? 'agreement_shared_source' : 'agreement'), missing: 'as-of date', diffPct };
  if (Math.abs(ta - tb) > sameDateDays * DAY) return { kind: 'different_date', diffPct };
  if (diffPct > tolerancePct) return { kind: 'contradiction', diffPct };
  return { kind: a.urls.some((u) => b.urls.includes(u)) ? 'agreement_shared_source' : 'agreement', diffPct };
}

function claimConflicts(latest, tolerancePct, sameDateDays = 7) {
  const byMetric = new Map();
  for (const p of PROVIDERS) {
    const r = latest[p];
    if (!r) continue;
    const urlsById = new Map((r.assessment.sources || []).map((s) => [s.source_id, s.url ? normUrl(s.url) : null]));
    for (const c of r.assessment.claims || []) {
      if (!c.metric_id || typeof c.value !== 'number') continue;
      const k = normText(c.metric_id).replace(/ /g, '_');
      if (!byMetric.has(k)) byMetric.set(k, []);
      byMetric.get(k).push({ provider: p, report_id: r.report_id, claim: c, urls: (c.source_ids || []).map((id) => urlsById.get(id)).filter(Boolean) });
    }
  }
  const out = [];
  for (const [metric, list] of byMetric) {
    if (new Set(list.map((x) => x.provider)).size < 2) continue;
    const pairs = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a.provider === b.provider) continue;
        const ca = a.claim;
        const cb = b.claim;
        const cls = classifyPair(ca, cb, a, b, tolerancePct, sameDateDays);
        const side = (x, c) => ({ provider: x.provider, report_id: x.report_id, claim_id: c.claim_id, value: c.value, unit: c.unit, period: c.period, definition: c.definition, as_of: c.as_of, evidence_tag: c.evidence_tag, text: c.text });
        pairs.push({
          kind: cls.kind,
          missing: cls.missing || null,
          diff_pct: Math.round(cls.diffPct * 10) / 10,
          comparable_values: ['contradiction', 'agreement', 'agreement_shared_source'].includes(cls.kind),
          a: side(a, ca),
          b: side(b, cb),
        });
      }
    }
    out.push({ metric_id: metric, pairs });
  }
  return out;
}

function fmtVal(v) {
  return `${v.value}${v.unit ? ` ${v.unit}` : ''}`;
}

function resolvingQuestions(rows, conflicts) {
  const qs = [];
  for (const r of rows) {
    if (!r.spread_flag) continue;
    const vals = PROVIDERS.filter((p) => r.cells[p] && scoreBounds(r.cells[p])).map((p) => `${PROVIDER_LABELS[p]} ${r.cells[p].status === 'range' ? `${r.cells[p].low}–${r.cells[p].high}` : r.cells[p].value}`).join(', ');
    qs.push({
      topic: `${r.section}:${r.id}`,
      label: r.label,
      reason: `Spread of ${r.spread} points (${vals}).`,
      question: r.resolving_question || `What evidence would settle ${r.label}?`,
      source: 'rubric',
    });
  }
  for (const c of conflicts) {
    for (const p of c.pairs) {
      if (p.kind === 'contradiction') {
        qs.push({
          topic: `metric:${c.metric_id}`,
          label: c.metric_id,
          reason: `${PROVIDER_LABELS[p.a.provider]} says ${fmtVal(p.a)}, ${PROVIDER_LABELS[p.b.provider]} says ${fmtVal(p.b)} for the same period, definition and date (${p.a.period}).`,
          question: `Which figure for ${c.metric_id} over ${p.a.period} does the primary source or on-chain data support: ${fmtVal(p.a)} or ${fmtVal(p.b)}?`,
          source: 'conflict',
        });
      } else if (['different_period', 'different_definition', 'context_unstated', 'different_date', 'different_unit'].includes(p.kind)) {
        const why = p.kind === 'different_date'
          ? `measured on different dates (${p.a.as_of} vs ${p.b.as_of}): a change over time, not a contradiction`
          : p.kind === 'context_unstated'
            ? `${p.missing || 'context'} not stated by both reports: unresolved, not a contradiction`
            : `${p.kind.replace(/_/g, ' ')}: not a contradiction`;
        qs.push({
          topic: `metric:${c.metric_id}`,
          label: c.metric_id,
          reason: `${why} (${PROVIDER_LABELS[p.a.provider]}: ${fmtVal(p.a)}, ${p.a.period || 'period unstated'}; ${PROVIDER_LABELS[p.b.provider]}: ${fmtVal(p.b)}, ${p.b.period || 'period unstated'}).`,
          question: `What is ${c.metric_id} when measured the same way, over the same period and date, in every report?`,
          source: 'basis',
        });
      }
    }
  }
  const seen = new Set();
  return qs.filter((q) => {
    const k = `${q.topic}|${q.question}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function compareProject(ws, reports) {
  const { profiles, grading } = ws.rubrics;
  const settings = ws.settings;
  const threshold = settings.comparison.spread_threshold;
  const latest = latestByProvider(reports);
  const comp = comparability(latest, settings);
  const comparableSet = new Set(comp.comparable_providers);
  const refProvider = comp.comparable_providers[0] || PROVIDERS.find((p) => latest[p]);
  const refAssessment = refProvider ? latest[refProvider].assessment : null;
  const refProfile = refAssessment ? resolveProfile(ws, refAssessment.sector_profile).profile : null;
  const refRubric = (refAssessment && ws.rubrics.gradingVersions[refAssessment.rubric_version]) || grading;
  const rows = [];
  const diagDefs = refProfile
    ? refProfile.diagnostic_categories.map((c) => ({ id: c.id, label: c.label, resolving_question: c.resolving_question, applicable: c.applicable !== false, na_reason: c.na_reason || null }))
    : [];
  const seen = new Set(diagDefs.map((d) => d.id));
  for (const p of PROVIDERS) {
    const r = latest[p];
    if (!r) continue;
    for (const id of Object.keys(r.assessment.diagnostic_scores || {})) {
      if (!seen.has(id)) {
        seen.add(id);
        const prof = profiles[r.assessment.sector_profile];
        const def = prof && prof.diagnostic_categories.find((c) => c.id === id);
        diagDefs.push({ id, label: def ? def.label : id, resolving_question: def ? def.resolving_question : null, applicable: def ? def.applicable !== false : true, na_reason: def ? def.na_reason || null : null });
      }
    }
  }
  const riskNa = refProfile && refProfile.risk_applicability && refProfile.risk_applicability.credit === false;
  for (const d of diagDefs) rows.push(rowFor('diagnostic', d, latest, comparableSet, threshold, 'higher_is_better'));
  for (const c of refRubric.investment_components) rows.push(rowFor('component', c, latest, comparableSet, threshold, 'higher_is_better'));
  for (const rd of refRubric.risk_scores) {
    const def = rd.id === 'credit' && riskNa ? { ...rd, applicable: false, na_reason: refProfile.risk_applicability.credit_na_reason || 'Credit risk is not applicable under this profile' } : rd;
    rows.push(rowFor('risk', def, latest, comparableSet, threshold, 'higher_is_more_risk'));
  }
  const grades = {};
  for (const p of PROVIDERS) {
    const r = latest[p];
    if (!r) continue;
    const g = gradeAssessment(ws, r.assessment);
    grades[p] = { grade: g, model_total: checkModelTotal(g, r.assessment.model_reported_overall_score, settings.grading.discrepancy_tolerance) };
  }
  const conflicts = claimConflicts(latest, settings.comparison.claim_value_tolerance_pct, settings.comparison.claim_same_date_days || 7);
  return {
    threshold,
    window_days: settings.comparison.date_window_days,
    latest: Object.fromEntries(PROVIDERS.map((p) => [p, latest[p] ? {
      report_id: latest[p].report_id,
      analysis_at: latest[p].assessment.analysis_at,
      horizon: latest[p].assessment.horizon,
      horizon_interval: horizonOf(latest[p].assessment),
      rubric_version: latest[p].assessment.rubric_version,
      sector_profile: latest[p].assessment.sector_profile,
      prompt_version: latest[p].assessment.prompt_version || null,
      model_version: latest[p].assessment.model_version,
      verdict: latest[p].assessment.verdict,
      imported_at: latest[p].meta.imported_at,
      evidence_confidence: latest[p].assessment.diagnostic_scores.evidence_confidence || null,
      citation_integrity: latest[p].integrity ? { status: latest[p].integrity.status, counts: latest[p].integrity.counts } : null,
      provenance: latest[p].provenance || null,
    } : null])),
    comparability: comp,
    rows,
    flagged: rows.filter((r) => r.spread_flag).map((r) => ({ section: r.section, id: r.id, label: r.label, spread: r.spread })),
    grades,
    shared_sources: sharedSources(latest),
    claim_conflicts: conflicts,
    resolving_questions: resolvingQuestions(rows, conflicts),
    independence_note: 'Several models agreeing is not independent corroboration: they may share sources, training data or the same prompt.',
  };
}

// Field-by-field changes between two reports from the same provider.
function diffReports(older, newer) {
  const changes = [];
  const sections = [['diagnostic_scores', 'diagnostic'], ['investment_components', 'component'], ['risk_scores', 'risk']];
  for (const [key, section] of sections) {
    const ids = new Set([...Object.keys(older.assessment[key] || {}), ...Object.keys(newer.assessment[key] || {})]);
    for (const id of ids) {
      const a = (older.assessment[key] || {})[id] || null;
      const b = (newer.assessment[key] || {})[id] || null;
      const ab = scoreBounds(a);
      const bb = scoreBounds(b);
      const same = JSON.stringify([a && a.status, ab]) === JSON.stringify([b && b.status, bb]);
      if (!same) changes.push({ section, id, from: a, to: b, delta: ab && bb && ab[0] === ab[1] && bb[0] === bb[1] ? bb[0] - ab[0] : null });
    }
  }
  if (older.assessment.verdict !== newer.assessment.verdict) changes.push({ section: 'verdict', id: 'verdict', from: older.assessment.verdict, to: newer.assessment.verdict });
  const comparable = groupKey(older) === groupKey(newer);
  return {
    from: older.report_id,
    to: newer.report_id,
    comparable,
    note: comparable ? null : 'The two reports use different rubric, profile or horizon; score changes may reflect the rubric rather than the project.',
    changes,
  };
}

module.exports = { latestByProvider, comparability, compareProject, diffReports, sharedSources, claimConflicts, normUrl, groupKey };
