'use strict';
// Your own records: conviction notes, journal entries (decisions, thesis), the
// review calendar, claim checks, dispute questions and report corrections.
// Journal entries and corrections are immutable files; a change is a new file.

const { runOp, OpError } = require('./ops');
const { readJson, readText, listDir, exists } = require('./fsx');
const { randomId, compactTs, isRecordId } = require('./ids');
const { parseDue, ymdInTz, isYmd, TZ } = require('./dates');
const { requireProjectId, getProject } = require('./projects');
const { validateCorrectionValue, getPath, loadReports } = require('./reports');
const { validate, loadSchema } = require('./schema');

const DECISIONS = ['watch', 'research_more', 'accumulate', 'hold', 'trim', 'exit', 'avoid'];
const JOURNAL_TYPES = ['decision', 'conviction_note', 'thesis', 'review_completed', 'note'];
const EVENT_TYPES = ['review', 'catalyst', 'unlock', 'alert', 'invalidator_check', 'other'];
const CHECK_STATUSES = ['not_checked', 'source_reachable', 'source_matches_claim', 'source_contradicts_claim', 'source_unavailable'];
const CORROBORATION = ['none', 'single_source_only', 'independently_corroborated', 'contradicted'];

function journalEntry(ws, op, projectId, fields) {
  const entry = {
    schema_version: 'cr.journal.v1',
    entry_id: `${compactTs()}_${fields.type}_${randomId(4)}`,
    project_id: projectId,
    type: fields.type,
    created_at: new Date().toISOString(),
    via: ws.actor,
    decision: fields.decision || null,
    conviction: fields.conviction || null,
    text: fields.text || null,
    reasons: (fields.reasons || []).map(String).filter(Boolean),
    linked_report_ids: (fields.linked_report_ids || []).filter(isRecordId),
    source_request_text: fields.utterance || null,
  };
  const res = validate(loadSchema(ws, 'journal.v1'), entry);
  if (!res.valid) throw new OpError('INVALID', `Journal entry invalid: ${res.errors.join('; ')}`);
  op.writeJson(`projects/${projectId}/journal/${entry.entry_id}.json`, entry, { mode: 'create' });
  return entry;
}

function setConvictionNote(ws, projectId, text, { utterance = null, conviction = null } = {}) {
  requireProjectId(projectId);
  getProject(ws, projectId);
  const body = String(text || '').trim();
  if (!body) throw new OpError('INVALID', 'The conviction note is empty.');
  if (conviction && !['low', 'medium', 'high'].includes(conviction)) throw new OpError('INVALID', 'Conviction must be low, medium or high.');
  const rel = `projects/${projectId}/notes/conviction.md`;
  const out = runOp(ws, { type: 'set_conviction_note', summary: `Update conviction note for ${projectId}` }, (op) => {
    const current = op.readText(rel, '');
    const stamped = `${body}\n`;
    if (current.replace(/\r\n/g, '\n').trim() === body.replace(/\r\n/g, '\n').trim()) return { unchanged: true };
    op.write(rel, stamped);
    const entry = journalEntry(ws, op, projectId, { type: 'conviction_note', text: body, conviction, utterance });
    return { entry_id: entry.entry_id };
  });
  return { status: out.noop ? 'unchanged' : 'saved', project_id: projectId, ...(out.result || {}), files: out.files, verified: out.verified };
}

function addJournal(ws, projectId, fields) {
  requireProjectId(projectId);
  getProject(ws, projectId);
  if (!JOURNAL_TYPES.includes(fields.type)) throw new OpError('INVALID', `Journal type must be one of ${JOURNAL_TYPES.join(', ')}`);
  if (fields.decision && !DECISIONS.includes(fields.decision)) throw new OpError('INVALID', `Decision must be one of ${DECISIONS.join(', ')}`);
  if (!fields.text && !fields.decision) throw new OpError('INVALID', 'A journal entry needs text or a decision.');
  const out = runOp(ws, { type: 'add_journal', summary: `Journal ${fields.type} for ${projectId}` }, (op) => journalEntry(ws, op, projectId, fields));
  return { status: 'saved', project_id: projectId, entry_id: out.result.entry_id, files: out.files, verified: out.verified };
}

function loadJournal(ws, projectId) {
  return listDir(ws.abs(`projects/${projectId}/journal`), { dirs: false })
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return readJson(ws.abs(`projects/${projectId}/journal/${f}`));
      } catch (err) {
        return { entry_id: f, broken: true, error: err.message };
      }
    })
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

function eventsRel(scope) {
  return scope === 'portfolio' ? 'portfolio/events.json' : `projects/${scope}/events.json`;
}

function addEvent(ws, scope, fields) {
  if (scope !== 'portfolio') {
    requireProjectId(scope);
    getProject(ws, scope);
  }
  if (!EVENT_TYPES.includes(fields.type)) throw new OpError('INVALID', `Event type must be one of ${EVENT_TYPES.join(', ')}`);
  const title = String(fields.title || '').trim() || (fields.type === 'review' ? 'Review thesis' : '');
  if (!title) throw new OpError('INVALID', 'An event needs a title.');
  let due = null;
  let interpretation = null;
  let alternative = null;
  if (fields.due) {
    const parsed = parseDue(fields.due, ymdInTz());
    due = parsed.date;
    interpretation = parsed.interpretation;
    alternative = parsed.alternative;
  }
  if (fields.type === 'review' && !due) throw new OpError('INVALID', 'A review needs a due date.');
  let alert = null;
  if (fields.type === 'alert') {
    if (!['price_below', 'price_above'].includes(fields.alert_kind)) throw new OpError('INVALID', 'Alert kind must be price_below or price_above.');
    const th = Number(fields.threshold_usd);
    if (!Number.isFinite(th) || th <= 0) throw new OpError('INVALID', 'Alert threshold must be a positive USD price.');
    alert = { kind: fields.alert_kind, threshold_usd: th };
  }
  const rel = eventsRel(scope);
  const out = runOp(ws, { type: 'add_event', summary: `Add ${fields.type} to ${scope}` }, (op) => {
    const doc = op.readJson(rel, { schema_version: 'cr.events.v1', events: [] });
    const dup = doc.events.find((e) => e.status === 'open' && e.type === fields.type && e.title === title && e.due_date === due && JSON.stringify(e.alert || null) === JSON.stringify(alert));
    if (dup) return { event: dup, duplicate: true };
    const event = {
      event_id: `ev_${compactTs()}_${randomId(4)}`,
      type: fields.type,
      title,
      due_date: due,
      timezone: TZ,
      status: 'open',
      note: fields.note || null,
      alert,
      created_at: new Date().toISOString(),
      created_via: ws.actor,
      completed_at: null,
      source_request_text: fields.utterance || null,
    };
    doc.events.push(event);
    const res = validate(loadSchema(ws, 'events.v1'), doc);
    if (!res.valid) throw new OpError('INVALID', `Event invalid: ${res.errors.join('; ')}`);
    op.writeJson(rel, doc);
    return { event };
  });
  return {
    status: out.result.duplicate ? 'exists' : 'saved',
    scope,
    event: out.result.event,
    due_interpretation: interpretation,
    due_alternative: alternative,
    files: out.files,
    verified: out.verified,
  };
}

function updateEventStatus(ws, scope, eventId, status) {
  if (scope !== 'portfolio') requireProjectId(scope);
  if (!['open', 'done', 'dismissed'].includes(status)) throw new OpError('INVALID', 'Status must be open, done or dismissed.');
  const rel = eventsRel(scope);
  const out = runOp(ws, { type: 'update_event', summary: `Mark ${eventId} ${status}` }, (op) => {
    const doc = op.readJson(rel, null);
    const ev = doc && doc.events.find((e) => e.event_id === eventId);
    if (!ev) throw new OpError('NOT_FOUND', `No event ${eventId}`);
    if (ev.status === status) return ev;
    ev.status = status;
    ev.completed_at = status === 'open' ? null : new Date().toISOString();
    op.writeJson(rel, doc);
    if (status === 'done' && ev.type === 'review' && scope !== 'portfolio') {
      journalEntry(ws, op, scope, { type: 'review_completed', text: `Completed review: ${ev.title}` });
    }
    return ev;
  });
  return { status: 'saved', event: out.result, files: out.files, verified: out.verified };
}

function loadEvents(ws, scope) {
  return readJson(ws.abs(eventsRel(scope)), { schema_version: 'cr.events.v1', events: [] }).events || [];
}

// Dashboard checks and independent corroboration are tracked separately from the
// analyst's own evidence tag. Opening an official statement is "source_reachable"
// or "source_matches_claim"; it is not corroboration of the substance.
function reviewClaim(ws, projectId, reportId, claimId, { dashboard_check = null, corroboration = null, corroboration_sources = [], note = null }) {
  requireProjectId(projectId);
  if (!isRecordId(reportId)) throw new OpError('BAD_ID', 'Invalid report ID');
  if (dashboard_check && !CHECK_STATUSES.includes(dashboard_check)) throw new OpError('INVALID', `Check status must be one of ${CHECK_STATUSES.join(', ')}`);
  if (corroboration && !CORROBORATION.includes(corroboration)) throw new OpError('INVALID', `Corroboration must be one of ${CORROBORATION.join(', ')}`);
  const report = loadReports(ws, projectId).find((r) => r.report_id === reportId);
  if (!report || report.broken) throw new OpError('NOT_FOUND', `No report ${reportId}`);
  if (!report.assessment.claims.some((c) => c.claim_id === claimId)) throw new OpError('NOT_FOUND', `No claim ${claimId} in ${reportId}`);
  const rel = `projects/${projectId}/claim-reviews.json`;
  const key = `${reportId}#${claimId}`;
  const out = runOp(ws, { type: 'review_claim', summary: `Review claim ${key}` }, (op) => {
    const doc = op.readJson(rel, { schema_version: 'cr.claim-reviews.v1', reviews: {} });
    const cur = doc.reviews[key] || { history: [] };
    const now = new Date().toISOString();
    if (dashboard_check) cur.dashboard_check = { status: dashboard_check, checked_at: now, note };
    if (corroboration) cur.corroboration = { status: corroboration, sources: (corroboration_sources || []).filter(Boolean), updated_at: now, note };
    cur.history = [...(cur.history || []), { at: now, dashboard_check, corroboration, note, via: ws.actor }];
    doc.reviews[key] = cur;
    op.writeJson(rel, doc);
    return cur;
  });
  return { status: 'saved', key, review: out.result, files: out.files, verified: out.verified };
}

function loadClaimReviews(ws, projectId) {
  return readJson(ws.abs(`projects/${projectId}/claim-reviews.json`), { reviews: {} }).reviews || {};
}

function addDispute(ws, projectId, { topic, question, status = 'open', resolution = null, dispute_id = null }) {
  requireProjectId(projectId);
  getProject(ws, projectId);
  const rel = `projects/${projectId}/disputes.json`;
  const out = runOp(ws, { type: 'dispute', summary: `Dispute question for ${projectId}` }, (op) => {
    const doc = op.readJson(rel, { schema_version: 'cr.disputes.v1', questions: [] });
    const now = new Date().toISOString();
    if (dispute_id) {
      const d = doc.questions.find((q) => q.dispute_id === dispute_id);
      if (!d) throw new OpError('NOT_FOUND', `No dispute ${dispute_id}`);
      d.status = status;
      d.resolution = resolution;
      d.updated_at = now;
      op.writeJson(rel, doc);
      return d;
    }
    if (!question || !String(question).trim()) throw new OpError('INVALID', 'A dispute needs the question that would resolve it.');
    const d = { dispute_id: `dq_${compactTs()}_${randomId(4)}`, topic: topic || null, question: String(question).trim(), status: 'open', resolution: null, created_at: now, updated_at: now };
    doc.questions.push(d);
    op.writeJson(rel, doc);
    return d;
  });
  return { status: 'saved', dispute: out.result, files: out.files, verified: out.verified };
}

function loadDisputes(ws, projectId) {
  return readJson(ws.abs(`projects/${projectId}/disputes.json`), { questions: [] }).questions || [];
}

// A correction never edits the original report. It is a new immutable file;
// the dashboard shows the corrected value and the audit trail.
function addCorrection(ws, projectId, reportId, field, value, reason) {
  requireProjectId(projectId);
  if (!isRecordId(reportId)) throw new OpError('BAD_ID', 'Invalid report ID');
  if (!reason || !String(reason).trim()) throw new OpError('INVALID', 'A correction needs a reason.');
  const report = loadReports(ws, projectId).find((r) => r.report_id === reportId);
  if (!report || report.broken) throw new OpError('NOT_FOUND', `No report ${reportId} in ${projectId}`);
  let newValue;
  try {
    newValue = validateCorrectionValue(ws, field, value, { rubricRef: report.assessment.rubric_version || null });
  } catch (err) {
    throw new OpError('INVALID', err.message);
  }
  const previous = getPath(report.assessment, field);
  const correction = {
    schema_version: 'cr.correction.v1',
    correction_id: `${compactTs()}_${randomId(4)}`,
    report_id: reportId,
    project_id: projectId,
    field,
    previous_value: previous === undefined ? null : previous,
    new_value: newValue,
    reason: String(reason).trim(),
    created_at: new Date().toISOString(),
    via: ws.actor,
  };
  const out = runOp(ws, { type: 'correct_report', summary: `Correct ${field} in ${reportId}` }, (op) => {
    op.writeJson(`projects/${projectId}/reports/${reportId}/corrections/${correction.correction_id}.json`, correction, { mode: 'create' });
  });
  return { status: 'saved', correction, files: out.files, verified: out.verified };
}

function readConvictionNote(ws, projectId) {
  const rel = `projects/${projectId}/notes/conviction.md`;
  const abs = ws.abs(rel);
  if (!exists(abs)) return null;
  const fs = require('fs');
  return { text: readText(abs), updated_at: fs.statSync(abs).mtime.toISOString() };
}

module.exports = {
  DECISIONS,
  JOURNAL_TYPES,
  EVENT_TYPES,
  CHECK_STATUSES,
  CORROBORATION,
  setConvictionNote,
  addJournal,
  loadJournal,
  addEvent,
  updateEventStatus,
  loadEvents,
  reviewClaim,
  loadClaimReviews,
  addDispute,
  loadDisputes,
  addCorrection,
  readConvictionNote,
  isYmd,
};
