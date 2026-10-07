'use strict';
// Research Explorer (Supabase): the one-way adapter. Desk records go in; the
// rows that public.explorer_import() stores come out
// (supabase/migrations/20261007012543_explorer_schema.sql). Nothing is read
// back from Supabase into the desk, and nothing here writes anywhere.
//
// It uses the desk's own readings, so a score means in the Explorer exactly
// what it means on the desk:
// - category grades as the report's declared scoring profile lists them
//   (13 under the @2 profiles, 11 under @1), never the six weighted
//   components, which only feed the grade;
// - scored / range / unknown / not_applicable kept as the desk stores them:
//   a range is never a midpoint, an unknown never a number;
// - the investment grade the desk calculates under the declared rubric
//   (rubrics.gradeAssessment), never the model's own total and never a
//   combination across models;
// - the desk's evidence checks (evidence.js), which change no score;
// - revision lineage from the stored records (revisions.js).
//
// Two sources share the mapping: the FICTIONAL fixture file (the only one
// any command exports in this version) and the desk's own records
// (deskSources), prepared for a later export Eric approves. Research jobs,
// spend, prompts, notes, portfolio and backups are never read here.

const fs = require('fs');
const path = require('path');
const { normalizeScore } = require('./scoring');
const { gradeAssessment } = require('./rubrics');
const { applyCorrections, analysisTiming, isEligible } = require('./reports');
const { revisionOf } = require('./revisions');
const { evidenceChecks } = require('./evidence');
const { CODE_ROOT } = require('./workspace');

const ADAPTER_VERSION = 'cr-explorer-adapter@1';
const FIXTURE_REL = 'dashboard/fixtures/explorer/fictional-records.json';
const FIXTURE_FILE = path.join(CODE_ROOT, 'fixtures', 'explorer', 'fictional-records.json');
const SCORE_STATUSES = new Set(['scored', 'range', 'unknown', 'not_applicable']);
const MODELS = new Set(['claude', 'chatgpt', 'gemini']);
const REVISION_KINDS = new Set(['format_fix', 'reassessment', 'new_evidence', 'other']);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const ymd = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);

class AdapterError extends Error {
  constructor(message) {
    super(message);
    this.code = 'INVALID';
  }
}

// ---- one project ------------------------------------------------------------

// The identity as the desk holds it now. A chain and contract only for a
// verified identity (the first recorded asset with a contract, else a native
// coin's chain); a pending or ambiguous identity carries none.
function projectRow(project) {
  const id = project.identity || {};
  const verified = id.status === 'verified';
  const assets = Array.isArray(id.assets) ? id.assets : [];
  const withContract = assets.find((a) => a && text(a.chain) && text(a.contract_address));
  const native = verified && id.native_chain === true;
  const nativeAsset = native ? assets.find((a) => a && text(a.chain)) : null;
  return {
    project_id: project.project_id,
    name: project.name,
    ticker: text(project.symbol),
    identity_status: ['verified', 'pending', 'ambiguous'].includes(id.status) ? id.status : 'pending',
    chain: verified ? (withContract ? text(withContract.chain) : nativeAsset ? text(nativeAsset.chain) : null) : null,
    contract_address: verified && withContract && !native ? text(withContract.contract_address) : null,
    native_chain: Boolean(native && nativeAsset && !withContract),
  };
}

// ---- one report -------------------------------------------------------------

// The calendar day the report says it was analyzed, when that is readable and
// not more than a day after the save (the desk's own rule); else unknown.
function researchDate(analysisAt, savedAt) {
  const t = analysisTiming(analysisAt, savedAt);
  if (!['ok', 'after_save'].includes(t.status)) return null;
  if (t.zone === 'utc' || t.zone === 'offset') return ymd(t.normalized);
  return ymd(String(analysisAt).trim());
}

// A category grade as the desk stores it, checked against the same shape
// rules as the database (a score that breaks them is refused, never mended).
function scoreRow(def, position, s, flags) {
  if (!SCORE_STATUSES.has(s.status)) throw new AdapterError(`${def.id}: status ${JSON.stringify(s.status)} is not one of scored, range, unknown, not_applicable`);
  const row = {
    category_id: def.id,
    category_label: def.label || def.id,
    position,
    status: s.status,
    score: null,
    score_low: null,
    score_high: null,
    confidence: (s.status === 'scored' || s.status === 'range') && ['high', 'medium', 'low'].includes(s.confidence) ? s.confidence : null,
    evidence_refs: Array.isArray(s.evidence_refs) ? s.evidence_refs.filter((x) => typeof x === 'string') : [],
    rationale: text(s.rationale),
    main_weakness: text(s.main_weakness),
    unknown_reason: s.status === 'unknown' ? text(s.missing_data) : null,
    evidence_flags: flags,
  };
  if (s.status === 'scored') {
    if (!isNum(s.value) || s.value < 0 || s.value > 100) throw new AdapterError(`${def.id}: a scored grade needs a number from 0 to 100`);
    row.score = s.value;
  } else if (s.status === 'range') {
    if (!isNum(s.low) || !isNum(s.high) || s.low < 0 || s.high > 100 || s.low > s.high) throw new AdapterError(`${def.id}: a range needs low and high from 0 to 100, low not above high`);
    row.score_low = s.low;
    row.score_high = s.high;
  } else if (isNum(s.value) || isNum(s.low) || isNum(s.high)) {
    throw new AdapterError(`${def.id}: ${s.status} must carry no number`);
  }
  return row;
}

// The category grades a report gives, in its profile's order. A category the
// profile lists and the report does not grade gets no row (the Explorer says
// "not in this report"); grades outside the profile are not category grades.
function categoryRows(a, profile, evidence) {
  const scores = a.diagnostic_scores || {};
  const defs = profile && Array.isArray(profile.diagnostic_categories) ? profile.diagnostic_categories : [];
  const flagsFor = (id) => (evidence.flags || [])
    .filter((f) => Array.isArray(f.categories) && f.categories.includes(id))
    .map((f) => ({ rule: f.rule, severity: f.severity, message: f.beside || f.message }));
  const rows = [];
  defs.forEach((def, i) => {
    const s = scores[def.id];
    if (s && typeof s === 'object') rows.push(scoreRow(def, i + 1, s, flagsFor(def.id)));
  });
  return rows;
}

function gradeFields(g) {
  const out = { grade_status: 'withheld', grade_value: null, grade_low: null, grade_high: null, grade_coverage_pct: null, grade_unscored: [], grade_reason: null };
  if (!g) return { ...out, grade_reason: 'No grade could be calculated for this report.' };
  out.grade_status = ['firm', 'range', 'withheld', 'invalid_weights'].includes(g.status) ? g.status : 'withheld';
  if (g.status === 'firm') out.grade_value = g.value;
  if (g.status === 'range') {
    out.grade_low = g.low;
    out.grade_high = g.high;
  }
  out.grade_coverage_pct = isNum(g.coverage_pct) ? g.coverage_pct : null;
  out.grade_unscored = Array.isArray(g.missing) ? g.missing.map((m) => m.label || m.id) : [];
  out.grade_reason = g.status === 'withheld' || g.status === 'invalid_weights' ? text(g.reason) : null;
  return out;
}

function revisionFields(rev) {
  if (!rev || rev.kind !== 'revision') return { revision_of: null, revision_kind: null, revision_basis: null, revision_note: null };
  const declared = rev.declared && REVISION_KINDS.has(rev.declared.kind) ? rev.declared.kind : 'not_stated';
  return { revision_of: rev.of, revision_kind: declared, revision_basis: rev.basis, revision_note: rev.declared ? text(rev.declared.note) : null };
}

// One stored report (loadReports shape: report_id, meta, record, assessment)
// as an Explorer row with its category scores, or why it is not exported.
function reportRow(ws, project, r, all) {
  if (r.broken) return { skip: 'the report record could not be read' };
  if (!isEligible(r)) return { skip: 'excluded from grading on the desk' };
  const a = r.assessment;
  if (a.needs_text || a.source_format === 'pdf') return { skip: 'a PDF without extracted text has no scores' };
  const model = r.meta && r.meta.provider;
  if (!MODELS.has(model)) return { skip: `unknown model ${JSON.stringify(model)}` };
  const profile = ws.rubrics.profiles[a.sector_profile] || null;
  const site = project.identity && project.identity.status === 'verified' ? project.identity.official_website || null : null;
  const evidence = evidenceChecks(a, { officialWebsite: site });
  const horizon = a.position_context && a.position_context.horizon ? a.position_context.horizon : {};
  const raw = r.record && r.record.raw_json;
  return {
    row: {
      report_id: r.report_id,
      project_id: project.project_id,
      model,
      model_version: text(a.model_version),
      research_run_id: text(r.provenance && r.provenance.research_run_id) || text(r.meta.provenance && r.meta.provenance.research_run_id) || text(a.research_run_id),
      research_date: researchDate(a.analysis_at, r.meta.imported_at),
      saved_at: r.meta.imported_at,
      horizon_text: text(a.horizon),
      horizon_start: ymd(horizon.start_date),
      horizon_end: ymd(horizon.end_date),
      report_format: text(raw && raw.schema_version) || text(a.source_format),
      prompt_version: text(a.prompt_version),
      rubric_version: text(a.rubric_version),
      profile_version: text(a.sector_profile),
      verdict: text(a.verdict),
      ...revisionFields(revisionOf(all, r)),
      ...gradeFields(gradeAssessment(ws, a)),
      evidence_summary: text(evidence.summary),
      evidence_coverage: evidence.coverage ? evidence.coverage.status : null,
      evidence_high: evidence.high || 0,
      evidence_medium: evidence.medium || 0,
      evidence_low: evidence.low || 0,
      category_scores: categoryRows(a, profile, evidence),
    },
  };
}

// ---- a batch ----------------------------------------------------------------

// sources: [{ project, reports: [loadReports shape] }]. Reports go oldest
// save first, so an original is stored before the revision that names it.
function buildBatch(ws, sources, { dataset, source }) {
  if (!['demo', 'desk'].includes(dataset)) throw new AdapterError('dataset must be demo or desk');
  const projects = [];
  const reports = [];
  const skipped = [];
  for (const { project, reports: list } of sources) {
    projects.push(projectRow(project));
    for (const r of list) {
      let out;
      try {
        out = reportRow(ws, project, r, list);
      } catch (err) {
        out = { skip: err.message };
      }
      if (out.skip) skipped.push({ project_id: project.project_id, report_id: r.report_id, reason: out.skip });
      else reports.push(out.row);
    }
  }
  reports.sort((x, y) => String(x.saved_at).localeCompare(String(y.saved_at)) || x.report_id.localeCompare(y.report_id));
  return { batch: { dataset, source, adapter_version: ADAPTER_VERSION, projects, reports }, skipped };
}

// ---- sources ----------------------------------------------------------------

// The FICTIONAL fixture file, read the way the desk reads a stored report:
// every score through the desk's own normalizer (an invalid fixture score is
// an error here, never a quiet unknown), then the desk's read-time shape.
function loadFixtures(file = FIXTURE_FILE) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (doc.schema_version !== 'cr.explorer-fixtures.v1' || doc.fictional !== true) throw new AdapterError('Not a fictional Explorer fixture file (cr.explorer-fixtures.v1 with "fictional": true).');
  return doc.projects.map(({ project, reports }) => {
    if (!/\(FICTIONAL\)$/.test(project.name || '')) throw new AdapterError(`Fixture project ${project.project_id} must be named "... (FICTIONAL)".`);
    if (!/^demo-/.test(project.project_id || '')) throw new AdapterError(`Fixture project IDs start with "demo-" (got ${project.project_id}).`);
    return {
      project,
      reports: reports.map((f) => {
        const a = JSON.parse(JSON.stringify(f.assessment));
        for (const group of ['diagnostic_scores', 'investment_components']) {
          for (const [id, raw] of Object.entries(a[group] || {})) {
            const { score, errors } = normalizeScore(raw, `${f.report_id} ${group}.${id}`);
            if (errors.length) throw new AdapterError(`Fixture score invalid: ${errors.join('; ')}`);
            a[group][id] = score;
          }
        }
        const meta = { project_id: project.project_id, ...f.meta };
        return { report_id: f.report_id, meta, record: { raw_json: { schema_version: f.format || null } }, assessment: applyCorrections(a, []), provenance: meta.provenance || {} };
      }),
    };
  });
}

// The desk's own records, prepared for a later one-way export that Eric
// approves (no command calls this in this version; explorer.js refuses).
// Archived projects and projects without a readable record are left out.
function deskSources(ws) {
  const { listProjects, getProject } = require('./projects');
  const { loadReports } = require('./reports');
  const out = [];
  for (const p of listProjects(ws)) {
    if (p.broken) continue;
    const id = p.project_id;
    let project;
    try {
      project = getProject(ws, id);
    } catch (_) {
      continue;
    }
    if (!project || project.status === 'archived') continue;
    out.push({ project, reports: loadReports(ws, id) });
  }
  return out;
}

// One project of the desk's own records, for a single-project preview (the
// canary): the same reading as deskSources, for one ID. An archived project
// is left out here too.
function deskSourceFor(ws, projectId) {
  const { isProjectId } = require('./ids');
  if (!isProjectId(projectId)) throw Object.assign(new AdapterError(`"${String(projectId).slice(0, 80)}" is not a project ID (lowercase letters, digits and dashes; see node dashboard/cli.js project list).`), { code: 'BAD_ID' });
  const { getProject } = require('./projects');
  const { loadReports } = require('./reports');
  const project = getProject(ws, projectId);
  if (project.status === 'archived') throw Object.assign(new AdapterError(`${projectId} is archived; archived projects are not exported.`), { code: 'REFUSED' });
  return [{ project, reports: loadReports(ws, projectId) }];
}

module.exports = { ADAPTER_VERSION, FIXTURE_REL, FIXTURE_FILE, AdapterError, projectRow, researchDate, categoryRows, reportRow, buildBatch, loadFixtures, deskSources, deskSourceFor };
