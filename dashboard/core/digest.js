'use strict';
// "What changed since my last review": a dated digest per project, measured from
// your review cursor (project.review.last_reviewed_at). It lists new reports and
// how each provider's scores moved, research runs, your own new notes and
// events, and the price change over the same period. It proposes; it never
// changes grades, reports or your selected thesis.

const { loadReports, reportSortKey } = require('./reports');
const { diffReports } = require('./compare');
const { gradeAssessment } = require('./rubrics');
const notes = require('./notes');
const { getProject } = require('./projects');
const { readJsonLines } = require('./fsx');
const { PROVIDERS } = require('./workspace');

function priceAt(ws, coingeckoId, sinceMs) {
  if (!coingeckoId) return null;
  const months = [...new Set([new Date(sinceMs).toISOString().slice(0, 7), new Date(sinceMs + 86400000 * 3).toISOString().slice(0, 7)])];
  let best = null;
  for (const m of months) {
    for (const line of readJsonLines(ws.abs(`market-data/observations/${m}.jsonl`))) {
      const o = (line.assets || []).find((a) => a.id === coingeckoId);
      if (!o || typeof o.price_usd !== 'number') continue;
      const t = Date.parse(o.source_last_updated_at || line.fetched_at);
      if (Number.isNaN(t) || t < sinceMs - 6 * 3600000) continue;
      if (!best || Math.abs(t - sinceMs) < Math.abs(best.t - sinceMs)) best = { t, price: o.price_usd, at: new Date(t).toISOString() };
    }
  }
  return best;
}

function changesSince(ws, projectId, { since = null, latestMarket = null } = {}) {
  const project = getProject(ws, projectId);
  const cursor = since || (project.review && project.review.last_reviewed_at) || project.created_at;
  const sinceMs = Date.parse(cursor);
  const reports = loadReports(ws, projectId).filter((r) => !r.broken);
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
  const journal = notes.loadJournal(ws, projectId).filter((e) => Date.parse(e.created_at) > sinceMs);
  const events = notes.loadEvents(ws, projectId).filter((e) => Date.parse(e.created_at) > sinceMs);
  const id = project.identity && project.identity.status === 'verified' ? project.identity.coingecko_id : null;
  const then = priceAt(ws, id, sinceMs);
  const nowObs = latestMarket && id && latestMarket.assets ? latestMarket.assets[id] : null;
  const price = then && nowObs && typeof nowObs.price_usd === 'number' ? { from: then.price, from_at: then.at, to: nowObs.price_usd, to_at: nowObs.source_last_updated_at, change_pct: (nowObs.price_usd / then.price - 1) * 100 } : null;
  const count = newReports.length + runs.length + journal.length + events.length;
  return {
    project_id: projectId,
    since: cursor,
    cursor_source: since ? 'requested' : project.review && project.review.last_reviewed_at ? 'your last review' : 'project created',
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
