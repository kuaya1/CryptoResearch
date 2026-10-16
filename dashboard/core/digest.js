'use strict';
// "What changed since my last review": a dated digest per project, measured from
// your review cursor (project.review.last_reviewed_at). It lists new reports and
// how each provider's scores moved, research runs, your own new notes and
// events, and the price change over the same period. It proposes; it never
// changes grades, reports or your selected thesis.

const { loadReports, reportSortKey } = require('./reports');
const { diffReports, latestByProvider } = require('./compare');
const { scoreBounds } = require('./scoring');
const { gradeAssessment } = require('./rubrics');
const notes = require('./notes');
const { getProject } = require('./projects');
const { PROVIDERS } = require('./workspace');

// The stored price nearest the cursor. `history` is an index rebuild's shared
// parse of the month files (market.historyMonth); without it, each month is
// read for this call.
function priceAt(ws, coingeckoId, sinceMs, history = null) {
  if (!coingeckoId) return null;
  const { historyMonth } = require('./market');
  const months = [...new Set([new Date(sinceMs).toISOString().slice(0, 7), new Date(sinceMs + 86400000 * 3).toISOString().slice(0, 7)])];
  let best = null;
  for (const m of months) {
    for (const o of historyMonth(ws, m, history).get(coingeckoId) || []) {
      if (typeof o.price_usd !== 'number') continue;
      const t = Date.parse(o.source_last_updated_at || o.fetched_at);
      if (Number.isNaN(t) || t < sinceMs - 6 * 3600000) continue;
      if (!best || Math.abs(t - sinceMs) < Math.abs(best.t - sinceMs)) best = { t, price: o.price_usd, at: new Date(t).toISOString() };
    }
  }
  return best;
}

const MODEL_IN_ID = new RegExp(`_(${PROVIDERS.join('|')})_`);

// A report named by a receipt, as it stands now: readable and eligible
// ("ok"), quarantined, excluded, unreadable or missing. A report that is not
// "ok" is said by its ID; its grade is never given as current.
function thenStatus(all, id) {
  const r = all.find((x) => x.report_id === id) || null;
  if (!r) return { report: null, status: 'missing' };
  if (r.broken) return { report: null, status: 'unreadable' };
  const el = r.assessment.eligibility;
  if (el && el.excluded) return { report: r, status: el.quarantined ? 'quarantined' : 'excluded', reason: el.reason || null };
  if (r.assessment.source_format === 'pdf' || r.assessment.needs_text) return { report: r, status: 'needs_text' };
  return { report: r, status: 'ok' };
}

// The review the comparison starts from: the receipt asked for (?base=), else
// your latest review. A receipt names the reports you saw; a review saved
// before receipts existed (or by a call that sends none) has only its time,
// and the reports then are inferred from it, said so; no review, none.
function reviewBase(project, journal, base) {
  const receipts = journal.filter((e) => e.type === 'review_completed' && !e.broken && Array.isArray(e.linked_report_ids));
  const latestReceipt = project.review && project.review.receipt_id ? project.review.receipt_id : null;
  let missing = null;
  if (base) {
    const e = receipts.find((x) => x.entry_id === base);
    if (e) {
      const seen = e.entry_id === latestReceipt && project.review.seen ? project.review.seen : null;
      return { basis: 'receipt', receipt_id: e.entry_id, reviewed_at: e.created_at, note: e.text || null, seen, report_ids: e.linked_report_ids, requested: base, found: true, latest: e.entry_id === latestReceipt };
    }
    missing = base;
  }
  const r = project.review && typeof project.review === 'object' ? project.review : null;
  const head = { requested: base || null, found: base ? false : null, missing };
  if (r && r.receipt_id && r.seen) {
    const e = receipts.find((x) => x.entry_id === r.receipt_id);
    return { basis: 'receipt', receipt_id: r.receipt_id, reviewed_at: r.last_reviewed_at, note: r.note || null, seen: r.seen, report_ids: e ? e.linked_report_ids : PROVIDERS.map((m) => r.seen[m]).filter(Boolean), ...head, latest: true };
  }
  if (r && r.last_reviewed_at) return { basis: 'inferred_by_time', receipt_id: null, reviewed_at: r.last_reviewed_at, note: r.note || null, seen: null, report_ids: [], ...head, latest: true };
  return { basis: 'none', receipt_id: null, reviewed_at: null, note: null, seen: null, report_ids: [], ...head, latest: true };
}

// A category moved when a bound moved by `min` points or more (a range keeps
// its two ends; nothing is turned into a midpoint).
function categoriesMoved(from, to, min = 5) {
  const out = [];
  const a = from.assessment.diagnostic_scores || {};
  const b = to.assessment.diagnostic_scores || {};
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = scoreBounds(a[id] || null);
    const y = scoreBounds(b[id] || null);
    if (!x || !y) continue;
    const by = Math.max(Math.abs(y[0] - x[0]), Math.abs(y[1] - x[1]));
    if (by >= min) out.push({ id, from: x, to: y, by: Number(by.toFixed(2)) });
  }
  return out.sort((p, q) => q.by - p.by || p.id.localeCompare(q.id));
}

// Then and now for one model: the report your review saw (by ID), the latest
// eligible report now (the desk's own selector), the reports saved between
// them, and whether the two can be compared number for number (the same
// rubric and profile).
function modelRow(prov, all, latest, review, cursorMs) {
  const own = all.filter((r) => !r.broken && r.meta.provider === prov);
  const now = latest[prov] || null;
  let thenId = null;
  let basis = review.basis;
  if (review.basis === 'receipt') {
    thenId = review.seen ? review.seen[prov] || null : (review.report_ids.find((id) => {
      const r = all.find((x) => x.report_id === id);
      return r && !r.broken ? r.meta.provider === prov : (MODEL_IN_ID.exec(id) || [])[1] === prov;
    }) || null);
  } else if (review.basis === 'inferred_by_time') {
    const before = latestByProvider(own.filter((r) => Date.parse(r.meta.imported_at) <= cursorMs))[prov];
    thenId = before ? before.report_id : null;
  }
  if (!own.length && !thenId) return null;
  const t = thenId ? thenStatus(all, thenId) : null;
  const then = t ? { report_id: thenId, status: t.status, reason: t.reason || null, imported_at: t.report ? t.report.meta.imported_at : null } : null;
  if (review.basis === 'receipt' && !thenId) basis = 'not_seen';
  const lo = t && t.report ? reportSortKey(t.report) : null;
  const hi = now ? reportSortKey(now) : null;
  const between = !then || !now || then.report_id === now.report_id ? [] : own
    .filter((r) => r.report_id !== then.report_id && r.report_id !== now.report_id)
    .filter((r) => (lo ? reportSortKey(r) > lo : Date.parse(r.meta.imported_at) > Date.parse(review.reviewed_at)) && reportSortKey(r) < hi)
    .sort((a, b) => reportSortKey(a).localeCompare(reportSortKey(b)))
    .map((r) => ({ report_id: r.report_id, imported_at: r.meta.imported_at, analysis_at: r.assessment.analysis_at || null, eligible: thenStatus(all, r.report_id).status }));
  let comparable = null;
  let moved = null;
  if (t && t.report && t.status === 'ok' && now && then.report_id !== now.report_id) {
    const a = t.report.assessment;
    const b = now.assessment;
    const why = [a.rubric_version !== b.rubric_version ? `rubric ${a.rubric_version || 'not stated'} then, ${b.rubric_version || 'not stated'} now` : null, a.sector_profile !== b.sector_profile ? `profile ${a.sector_profile || 'not stated'} then, ${b.sector_profile || 'not stated'} now` : null].filter(Boolean);
    comparable = { ok: !why.length, reason: why.length ? why.join('; ') : null };
    if (comparable.ok) moved = { categories: categoriesMoved(t.report, now) };
  }
  return {
    provider: prov,
    then_basis: basis,
    then,
    then_status: then ? then.status : null,
    now: now ? { report_id: now.report_id, imported_at: now.meta.imported_at, analysis_at: now.assessment.analysis_at || null } : null,
    same: Boolean(then && now && then.report_id === now.report_id),
    between,
    comparable,
    moved,
  };
}

function changesSince(ws, projectId, { since = null, base = null, latestMarket = null, history = null } = {}) {
  const project = getProject(ws, projectId);
  const journalAll = notes.loadJournal(ws, projectId);
  const review = reviewBase(project, journalAll, base);
  const cursor = since || (review.basis === 'receipt' && review.requested && review.found ? review.reviewed_at : null) || (project.review && project.review.last_reviewed_at) || project.created_at;
  const sinceMs = Date.parse(cursor);
  const all = loadReports(ws, projectId);
  const reports = all.filter((r) => !r.broken);
  const latest = latestByProvider(reports);
  const models = PROVIDERS.map((prov) => modelRow(prov, all, latest, review, sinceMs)).filter(Boolean);
  const newReports = reports.filter((r) => Date.parse(r.meta.imported_at) > sinceMs);
  const providerChanges = [];
  for (const p of PROVIDERS) {
    const list = reports.filter((r) => r.meta.provider === p).sort((a, b) => reportSortKey(a).localeCompare(reportSortKey(b)));
    const before = list.filter((r) => Date.parse(r.meta.imported_at) <= sinceMs).pop() || null;
    const after = list.filter((r) => Date.parse(r.meta.imported_at) > sinceMs).pop() || null;
    if (!after) continue;
    const ga = before ? gradeAssessment(ws, before.assessment) : null;
    const gb = gradeAssessment(ws, after.assessment);
    providerChanges.push({
      provider: p,
      from_report: before ? before.report_id : null,
      to_report: after.report_id,
      grade_from: ga ? ga.display || ga.status : null,
      grade_to: gb ? gb.display || gb.status : null,
      verdict_from: before ? before.assessment.verdict : null,
      verdict_to: after.assessment.verdict,
      diff: before ? diffReports(before, after) : null,
    });
  }
  const runs = require('./research').listRuns(ws, projectId).filter((r) => !r.broken && Date.parse(r.created_at) > sinceMs).map((r) => ({ run_id: r.run_id, status: r.status, created_at: r.created_at, providers: r.providers }));
  const journal = journalAll.filter((e) => Date.parse(e.created_at) > sinceMs);
  const events = notes.loadEvents(ws, projectId).filter((e) => Date.parse(e.created_at) > sinceMs);
  const id = project.identity && project.identity.status === 'verified' ? project.identity.coingecko_id : null;
  const then = priceAt(ws, id, sinceMs, history);
  const nowObs = latestMarket && id && latestMarket.assets ? latestMarket.assets[id] : null;
  const price = then && nowObs && typeof nowObs.price_usd === 'number' ? { from: then.price, from_at: then.at, to: nowObs.price_usd, to_at: nowObs.source_last_updated_at, change_pct: (nowObs.price_usd / then.price - 1) * 100 } : null;
  const count = newReports.length + runs.length + journal.length + events.length;
  return {
    project_id: projectId,
    since: cursor,
    cursor_source: since ? 'requested' : review.requested && review.found ? 'a review receipt' : project.review && project.review.last_reviewed_at ? 'your last review' : 'project created',
    // The check-in: the review it starts from and, per model, the report then
    // (by ID from the receipt), the latest eligible report now and the
    // reports saved between them.
    review: { basis: review.basis, receipt_id: review.receipt_id, reviewed_at: review.reviewed_at, note: review.note, seen: review.seen, report_ids: review.report_ids, requested: review.requested, found: review.found, latest: review.latest },
    models,
    new_reports: newReports.map((r) => ({ report_id: r.report_id, provider: r.meta.provider, imported_at: r.meta.imported_at, analysis_at: r.assessment.analysis_at, verdict: r.assessment.verdict })),
    provider_changes: providerChanges,
    research_runs: runs,
    journal_entries: journal.map((e) => ({ entry_id: e.entry_id, type: e.type, created_at: e.created_at, text: e.text })),
    events: events.map((e) => ({ event_id: e.event_id, type: e.type, title: e.title, due_date: e.due_date })),
    price,
    item_count: count,
    note: 'A digest proposes what to look at. It never changes grades, reports or your selected thesis.',
  };
}

module.exports = { changesSince };
