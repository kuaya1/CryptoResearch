'use strict';
// Rubric and sector-profile versions (audit F05).
// - Every report is graded with the rubric version it declares, never with the
//   currently active one. The active rubric only decides what NEW prompts ask for.
// - An unknown version gets no app-calculated grade (withheld, with the reason).
// - Published versions are pinned by SHA-256 in templates/rubrics/RUBRIC-LOCK.json.
//   If a pinned file later changes, grades that depend on it are withheld and the
//   doctor reports it, so editing a template can never silently regrade history.

const fs = require('fs');
const path = require('path');
const { readJson, listDir, sha256, jsonText } = require('./fsx');
const { computeInvestmentGrade } = require('./scoring');

const LOCK_REL = 'templates/rubrics/RUBRIC-LOCK.json';

class RubricError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function loadRubrics(root, settings) {
  const dir = path.join(root, 'templates', 'rubrics');
  const lock = readJson(path.join(root, ...LOCK_REL.split('/')), { schema_version: 'cr.rubric-lock.v1', pinned: {} });
  const profiles = {};
  const gradingVersions = {};
  const versionStatus = {};
  for (const name of listDir(dir, { dirs: false })) {
    if (!name.endsWith('.json') || name === 'RUBRIC-LOCK.json') continue;
    const bytes = fs.readFileSync(path.join(dir, name));
    const doc = JSON.parse(bytes.toString('utf8').replace(/^﻿/, ''));
    const ref = doc.rubric_ref || doc.profile_ref;
    if (!ref) continue;
    const hash = sha256(bytes);
    const pin = lock.pinned && lock.pinned[ref];
    const status = !pin ? 'unpinned' : pin.sha256 === hash ? 'pinned' : 'altered';
    versionStatus[ref] = { status, file: `templates/rubrics/${name}`, sha256: hash, pinned_sha256: pin ? pin.sha256 : null, pinned_at: pin ? pin.pinned_at : null };
    Object.defineProperty(doc, '_file', { value: `templates/rubrics/${name}`, enumerable: false });
    Object.defineProperty(doc, '_sha256', { value: hash, enumerable: false });
    Object.defineProperty(doc, '_status', { value: status, enumerable: false });
    if (doc.profile_ref) profiles[doc.profile_ref] = doc;
    if (doc.rubric_ref) gradingVersions[doc.rubric_ref] = doc;
  }
  const activeRef = (settings && settings.grading && settings.grading.rubric) || 'cr-grading@1';
  const grading = gradingVersions[activeRef] || null;
  if (!grading) throw new RubricError('NO_RUBRIC', `Grading rubric ${activeRef} not found in templates/rubrics.`);
  for (const g of Object.values(gradingVersions)) {
    const total = (g.investment_components || []).reduce((s, c) => s + c.weight_bp, 0);
    if (total !== 10000) Object.defineProperty(g, '_invalid', { value: `weights total ${total / 100}%`, enumerable: false });
  }
  if (grading._invalid) throw new RubricError('BAD_WEIGHTS', `Investment component weights in ${activeRef}: ${grading._invalid}, not 100%.`);
  const overrideLabels = settings && settings.grading && settings.grading.labels;
  const labels = overrideLabels || grading.grade_labels;
  return { profiles, grading, gradingVersions, labels, activeRef, overrideLabels: overrideLabels || null, versionStatus, lock };
}

function labelsFor(rubrics, rubric) {
  // The owner's label override applies to the active rubric; other versions keep their own.
  if (rubric.rubric_ref === rubrics.activeRef && rubrics.overrideLabels) return rubrics.overrideLabels;
  return rubric.grade_labels || rubrics.labels;
}

function resolveGrading(ws, ref) {
  const r = ws.rubrics;
  if (!ref) return { rubric: null, status: 'missing', reason: 'The report does not declare a rubric version, so no app grade is calculated.' };
  const rubric = r.gradingVersions[ref];
  if (!rubric) return { rubric: null, status: 'unknown', reason: `Rubric "${ref}" is not a known rubric version, so no authoritative grade is calculated. Its raw scores are kept.` };
  if (rubric._status === 'altered') return { rubric: null, status: 'altered', reason: `The file for ${ref} changed after it was published (hash mismatch), so grades that depend on it are withheld. Restore the original file or publish a new version.` };
  if (rubric._invalid) return { rubric: null, status: 'invalid', reason: `${ref}: ${rubric._invalid}` };
  return { rubric, status: 'ok', reason: null };
}

function resolveProfile(ws, ref) {
  if (!ref) return { profile: null, status: 'missing' };
  const p = ws.rubrics.profiles[ref];
  if (!p) return { profile: null, status: 'unknown' };
  if (p._status === 'altered') return { profile: p, status: 'altered' };
  return { profile: p, status: 'ok' };
}

// The published version of a scoring profile that NEW research uses: the
// highest pinned version of the same profile (payfi-credit@1 ->
// payfi-credit@2). Only a version pinned in RUBRIC-LOCK.json counts as
// published, so a draft file, or one that changed after it was pinned, is
// never moved to. A project record keeps the reference it was saved with, and
// a stored report is always read under the version it declares; only new runs
// and new prompts move forward.
function currentProfileRef(ws, ref) {
  const profiles = ws.rubrics.profiles;
  const p = ref ? profiles[ref] : null;
  if (!p || !p.profile_id) return ref;
  let best = p;
  for (const q of Object.values(profiles)) {
    if (q.profile_id !== p.profile_id || q._status !== 'pinned' || q.status === 'retired') continue;
    if (Number(q.version) > Number(best.version)) best = q;
  }
  return best.profile_ref;
}

// The app-calculated grade for one stored assessment, under its own rubric.
function gradeAssessment(ws, a) {
  if (!a) return null;
  if (a.source_format === 'pdf' || a.needs_text) {
    return { status: 'withheld', rubric: a.rubric_version || null, value: null, low: null, high: null, display: null, label: null, coverage_pct: 0, coverage_bp: 0, reason: 'No text extracted from this PDF yet, so no scores were read and no grade is calculated.', parts: [] };
  }
  const res = resolveGrading(ws, a.rubric_version);
  if (!res.rubric) {
    return { status: 'withheld', rubric: a.rubric_version || null, rubric_status: res.status, value: null, low: null, high: null, display: null, label: null, coverage_pct: null, reason: res.reason, parts: [] };
  }
  const g = computeInvestmentGrade(a.investment_components, res.rubric, labelsFor(ws.rubrics, res.rubric));
  return { ...g, rubric_status: 'ok', rubric_sha256: res.rubric._sha256 };
}

// Pins every rubric/profile file that is not pinned yet. Never re-pins an altered one.
function pinRubrics(ws, { runOp } = {}) {
  const run = runOp || require('./ops').runOp;
  ws._rubrics = null;
  const r = ws.rubrics;
  const toPin = Object.entries(r.versionStatus).filter(([, v]) => v.status === 'unpinned');
  if (!toPin.length) return { status: 'unchanged', altered: Object.entries(r.versionStatus).filter(([, v]) => v.status === 'altered').map(([k]) => k) };
  const out = run(ws, { type: 'pin_rubrics', summary: `Pin ${toPin.length} rubric/profile version(s)` }, (op) => {
    const lock = op.readJson(LOCK_REL, { schema_version: 'cr.rubric-lock.v1', note: 'Published rubric and profile versions, pinned by SHA-256. A pinned file must never change; publish a new version instead.', pinned: {} });
    lock.pinned = lock.pinned || {};
    for (const [ref, v] of toPin) lock.pinned[ref] = { file: v.file, sha256: v.sha256, pinned_at: new Date().toISOString() };
    op.write(LOCK_REL, jsonText(lock));
    return toPin.map(([ref]) => ref);
  });
  ws._rubrics = null;
  return { status: 'pinned', pinned: out.result, files: out.files };
}

module.exports = { LOCK_REL, loadRubrics, labelsFor, resolveGrading, resolveProfile, currentProfileRef, gradeAssessment, pinRubrics, RubricError };
