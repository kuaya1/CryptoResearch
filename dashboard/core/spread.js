'use strict';
// Spread alerts (backlog item 28, 2026-10-25): when Claude's current eligible
// report and ChatGPT's or Gemini's differ in grade by Eric's threshold or
// more (15 points unless he changed it), or Claude's grade and the
// Prosecutor's conviction on the current ticket differ by his second
// threshold (20). Computed on read from stored records, never stored, so a
// later quarantine, exclusion or new report changes it.
//
// Only firm grades under the same rubric are compared; a range, a withheld
// grade or another rubric reads "not compared" with the reason. The widest
// category is named only under the same rubric and sector profile (so the
// same category definitions) and only between two scored, non-range values.
// Never an average, a midpoint or a winner. Gemini's saved reports count; its
// hold is untouched (a hold only stops new assignments).

const { gradeOf } = require('./report-delta');
const { latestByProvider } = require('./compare');
const { scoreBounds } = require('./scoring');

const VERSION = 'cr-spread@1';
const DEFAULTS = { grade_points: 15, conviction_points: 20 };
const LABELS = { chatgpt: 'ChatGPT', gemini: 'Gemini' };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (n) => Math.round(n * 100) / 100;
const enc = encodeURIComponent;

// Eric's choices (settings alerts.spread; bounded in server.js validateSettingsPatch).
function thresholds(ws) {
  const s = (ws.settings && ws.settings.alerts && ws.settings.alerts.spread) || {};
  const ok = (v, d) => (isNum(v) && v >= 1 && v <= 100 ? v : d);
  return { grade_points: ok(s.grade_points, DEFAULTS.grade_points), conviction_points: ok(s.conviction_points, DEFAULTS.conviction_points), basis: "Eric's choice" };
}

// The widest comparable category between two reports, or why none is named.
function widestCategory(a, b) {
  const x = a.assessment;
  const y = b.assessment;
  if (x.rubric_version !== y.rubric_version) return { category: null, note: `Categories are not compared: rubric ${x.rubric_version || 'not stated'} and ${y.rubric_version || 'not stated'}.` };
  if (x.sector_profile !== y.sector_profile) return { category: null, note: `Categories are not compared: profile ${x.sector_profile || 'not stated'} and ${y.sector_profile || 'not stated'}.` };
  const dx = x.diagnostic_scores || {};
  const dy = y.diagnostic_scores || {};
  let best = null;
  for (const id of new Set([...Object.keys(dx), ...Object.keys(dy)])) {
    const p = dx[id] && dx[id].status === 'scored' ? scoreBounds(dx[id]) : null;
    const q = dy[id] && dy[id].status === 'scored' ? scoreBounds(dy[id]) : null;
    if (!p || !q || p[0] !== p[1] || q[0] !== q[1]) continue; // a range is never a midpoint
    const gap = Math.abs(p[0] - q[0]);
    if (!best || gap > best.gap || (gap === best.gap && id < best.id)) best = { id, claude: p[0], other: q[0], gap: round(gap) };
  }
  return best ? { category: best, note: null } : { category: null, note: 'No category is scored as a single figure in both reports.' };
}

function spreadOf(ws, pid, { reports, ticket = null, project = null } = {}) {
  const th = thresholds(ws);
  const latest = latestByProvider(reports);
  const alerts = [];
  const not_compared = [];
  const claude = latest.claude;
  const gc = claude ? gradeOf(ws, claude) : null;
  for (const prov of ['chatgpt', 'gemini']) {
    const other = latest[prov];
    if (!claude || !other) continue;
    const go = gradeOf(ws, other);
    const name = LABELS[prov];
    if (gc.kind !== 'firm' || go.kind !== 'firm') {
      const word = (g, who) => (g.kind === 'range' ? `${who}'s grade is a range (${g.display})` : g.kind === 'withheld' ? `${who}'s grade is withheld` : `${who} has no grade`);
      not_compared.push({ kind: 'model_spread', other: prov, reason: `Not compared: ${gc.kind !== 'firm' ? word(gc, 'Claude') : word(go, name)}.` });
      continue;
    }
    if (claude.assessment.rubric_version !== other.assessment.rubric_version) {
      not_compared.push({ kind: 'model_spread', other: prov, reason: `Not compared: rubric ${claude.assessment.rubric_version || 'not stated'} (Claude) and ${other.assessment.rubric_version || 'not stated'} (${name}).` });
      continue;
    }
    const gap = round(Math.abs(gc.value - go.value));
    if (gap < th.grade_points) continue;
    const w = widestCategory(claude, other);
    const link = `#/project/${enc(pid)}/compare${w.category ? `?category=${enc(w.category.id)}` : ''}`;
    alerts.push({
      kind: 'model_spread',
      other: prov,
      claude_grade: gc.value,
      other_grade: go.value,
      gap,
      threshold: th.grade_points,
      claude_report_id: claude.report_id,
      other_report_id: other.report_id,
      category: w.category,
      category_note: w.note,
      link,
      words: `Claude ${gc.display} and ${name} ${go.display} differ by ${gap} points (your threshold ${th.grade_points}). ${w.category ? `Widest category: ${w.category.id.replace(/_/g, ' ')}, Claude ${w.category.claude} and ${name} ${w.category.other}.` : w.note}`,
    });
  }
  const pr = ticket && !ticket.desk_gate && ticket.prosecution ? ticket : null;
  if (pr) {
    const conviction = pr.prosecution.conviction_score;
    const g = pr.researcher && pr.researcher.grade;
    const firm = isNum(g) && pr.researcher.grade_display !== null && /^\d+(\.\d+)?$/.test(String(pr.researcher.grade_display));
    if (!isNum(conviction)) not_compared.push({ kind: 'prosecutor_spread', reason: 'Not compared: the ticket gives no conviction figure.' });
    else if (!firm) not_compared.push({ kind: 'prosecutor_spread', reason: `Not compared: Claude's grade on the ticket is not a single figure (${pr.researcher.grade_display || 'none'}).` });
    else {
      const gap = round(Math.abs(g - conviction));
      if (gap >= th.conviction_points) {
        alerts.push({
          kind: 'prosecutor_spread',
          claude_grade: g,
          conviction,
          gap,
          threshold: th.conviction_points,
          receipt_id: pr.receipt_id,
          link: `#/?p=${enc(pid)}`,
          words: `Claude's grade ${pr.researcher.grade_display} and the Prosecutor's conviction ${conviction} (ticket ${pr.receipt_id}) differ by ${gap} points (your threshold ${th.conviction_points}).`,
        });
      }
    }
  }
  return { format: VERSION, project_id: pid, thresholds: th, alerts, not_compared };
}

module.exports = { spreadOf, thresholds, VERSION, DEFAULTS };
