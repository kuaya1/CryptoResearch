'use strict';
// Binding a report to the research run it completes.
//
// A research run freezes one contract for every model: the run ID, the
// project, the prompt version (and the prompt's SHA-256), the rubric, the
// scoring profile and the exact holding horizon. A report that completes a
// model's job in that run must answer that contract. What the report declares
// about itself (in its JSON block) is compared with the run, field by field:
//   match       the report says what the run says
//   conflict    the report says something else (another run, an older prompt,
//               another profile, other horizon dates, another model)
//   missing     the report does not say (it is then read under the run's
//               value, and that is recorded)
//   unverified  the report says it in a form that cannot be compared (a
//               horizon without dates or a readable length)
// A conflicting declaration is never replaced with the run's value: the
// report is refused as this job's answer (nothing is linked, the job stays
// open, nothing becomes the dashboard's latest), with each field named.
//
// Who is completing the job decides what else is required (mode):
//   assistant  a model saving its own report through its desk connection
//              (save_report). The prompt asks for a JSON block naming the run
//              and the prompt version, so both must be there and match, and a
//              stated analysis time more than a day after the save is refused.
//   owner      Eric importing an answer for a run he chose (dashboard, CLI,
//              request queue). His choice is the binding: conflicts are
//              refused, missing fields are read under the run's.
//   declared   a file that names a run only inside its own JSON block (an
//              inbox drop, an import without a run). On a conflict it is
//              saved on its own and not linked to that run.
//   record     the desk's own paid API answer to the frozen prompt it sent
//              (attested): checked and recorded, never refused.
// Read-only: it changes nothing.

const fs = require('fs');
const { sha256, readJson } = require('./fsx');
const { PROVIDERS, PROVIDER_LABELS } = require('./workspace');

const RUN_ID_RE = /^run_[A-Za-z0-9_-]{4,80}$/;
const YMD = /\b\d{4}-\d{2}-\d{2}\b/g;

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function loadRun(ws, projectId, runId) {
  if (!RUN_ID_RE.test(String(runId || ''))) return null;
  try {
    const run = readJson(ws.abs(`projects/${projectId}/research/${runId}/run.json`), null);
    return run && typeof run === 'object' && (!run.project_id || run.project_id === projectId) ? run : null;
  } catch (_) {
    return null;
  }
}

// The declared horizon against the run's: its dates when the run has exact
// dates (the position recipe), else its length.
function horizonResult(declared, run) {
  const { parseHorizon } = require('./reports');
  const h = run.horizon && typeof run.horizon === 'object' ? run.horizon : { text: typeof run.horizon === 'string' ? run.horizon : null };
  const want = h.start_date && h.end_date ? `${h.text || ''}`.trim() || `${h.start_date} to ${h.end_date}` : h.text || null;
  if (!declared) return { result: 'missing', expected: want };
  const dates = String(declared).match(YMD) || [];
  if (h.start_date && h.end_date) {
    if (dates.length >= 2) return { result: dates[0] === h.start_date && dates[dates.length - 1] === h.end_date ? 'match' : 'conflict', expected: `${h.start_date} to ${h.end_date}` };
    if (dates.length === 1) return { result: dates[0] === h.end_date || dates[0] === h.start_date ? 'unverified' : 'conflict', expected: `${h.start_date} to ${h.end_date}` };
    const p = parseHorizon(String(declared));
    if (p && Number.isFinite(p.high_months) && Number.isInteger(h.months)) return { result: p.low_months === h.months && p.high_months === h.months ? 'match' : 'conflict', expected: `${h.months} months (${h.start_date} to ${h.end_date})` };
    return { result: 'unverified', expected: want };
  }
  if (!h.text) return { result: 'unverified', expected: null };
  if (String(declared).trim() === String(h.text).trim()) return { result: 'match', expected: h.text };
  const a = parseHorizon(String(declared));
  const b = parseHorizon(String(h.text));
  if (a && b && a.high_months !== null && b.high_months !== null) return { result: a.low_months === b.low_months && a.high_months === b.high_months ? 'match' : 'conflict', expected: h.text };
  return { result: 'unverified', expected: h.text };
}

// The model a report says wrote it: its JSON provider, else its self
// identification ("ChatGPT (OpenAI)").
function declaredModel(json) {
  if (!json) return null;
  if (typeof json.provider === 'string' && PROVIDERS.includes(json.provider.trim().toLowerCase())) return json.provider.trim().toLowerCase();
  return require('./reports').detectProviderClaim(json.model_self_identification);
}

function quote(v) {
  return v === null || v === undefined ? 'nothing' : `"${String(v).slice(0, 80)}"`;
}

// The check itself. `json` is the report's parsed JSON block (or null);
// `hasBlock` says a JSON block was found at all (even an unreadable one).
function checkBinding(ws, { projectId, runId, provider, json = null, hasBlock = false, parseError = null, mode = 'owner', now = new Date(), allowModelMismatch = false }) {
  const run = loadRun(ws, projectId, runId);
  if (!run) return { ok: false, status: 'no_run', mode, run_id: runId, checks: {}, conflicts: [], missing: [], message: `There is no research run ${runId} for ${projectId}, so nothing can be completed by this report.` };
  const out = { ok: true, status: 'bound', mode, run_id: runId, checks: {}, conflicts: [], missing: [], prompt_sha256: run.prompt ? run.prompt.sha256 || null : null, execution_sha256: null };
  const job = run.jobs ? run.jobs[provider] : null;
  if (job && job.execution) out.execution_sha256 = job.execution.sha256 || null;

  // The contract itself must be intact: the run's frozen prompt still matches
  // the SHA-256 recorded when the run started.
  if (mode !== 'record' && run.prompt && run.prompt.path) {
    let ok = false;
    try {
      ok = Boolean(run.prompt.sha256) && sha256(fs.readFileSync(ws.abs(run.prompt.path))) === run.prompt.sha256;
    } catch (_) {
      ok = false;
    }
    if (!ok) {
      return { ...out, ok: false, status: 'contract_unverifiable', message: `Research run ${runId}'s frozen prompt no longer matches the SHA-256 recorded when the run started, so no report can be bound to it. Nothing was saved. Tell Eric.` };
    }
  }

  const add = (field, result, declared, expected) => {
    out.checks[field] = { result, declared: declared === undefined ? null : declared, expected: expected === undefined ? null : expected };
    if (result === 'conflict') out.conflicts.push(field);
    if (result === 'missing') out.missing.push(field);
  };
  const same = (field, declared, expected) => {
    if (expected === null || expected === undefined) return add(field, declared ? 'unverified' : 'missing', declared, expected);
    if (declared === null) return add(field, 'missing', null, expected);
    return add(field, declared === expected ? 'match' : 'conflict', declared, expected);
  };

  const j = json && typeof json === 'object' ? json : null;
  same('research_run_id', j ? text(j.research_run_id) : null, run.run_id);
  same('project_id', j ? text(j.project_id) : null, run.project_id || projectId);
  const claimed = declaredModel(j);
  // A model mismatch Eric accepted on purpose (inbox "allow provider
  // mismatch") stays recorded, not refused.
  add('model', claimed ? (claimed === provider ? 'match' : allowModelMismatch ? 'accepted_mismatch' : 'conflict') : 'missing', claimed ? PROVIDER_LABELS[claimed] : null, PROVIDER_LABELS[provider]);
  same('prompt_version', j ? text(j.prompt_version) : null, run.prompt ? run.prompt.version || null : null);
  same('rubric_version', j ? text(j.rubric_version) : null, run.rubric_version || null);
  same('sector_profile', j ? text(j.sector_profile) : null, run.sector_profile || null);
  const hz = horizonResult(j ? text(j.horizon) : null, run);
  add('horizon', hz.result, j ? text(j.horizon) : null, hz.expected);
  // The position_context block's own horizon, field by field.
  const rh = run.horizon && typeof run.horizon === 'object' ? run.horizon : null;
  const ph = j && j.position_context && typeof j.position_context === 'object' && j.position_context.horizon && typeof j.position_context.horizon === 'object' ? j.position_context.horizon : null;
  if (rh && rh.start_date && ph) {
    for (const k of ['mode', 'start_date', 'end_date']) {
      const d = text(ph[k]);
      if (d !== null) add(`position_context.horizon.${k}`, String(d).slice(0, k === 'mode' ? 40 : 10) === String(rh[k]) ? 'match' : 'conflict', d, rh[k] || null);
    }
  }

  // An analysis time more than a day after the save cannot be right.
  if (mode === 'assistant' && j && text(j.analysis_at)) {
    const t = require('./reports').analysisTiming(text(j.analysis_at), now.toISOString());
    if (t.status === 'future') add('analysis_at', 'conflict', text(j.analysis_at), `on or before ${now.toISOString().slice(0, 16)}Z (when this report is saved)`);
  }

  // What each mode requires besides agreement.
  const required = [];
  if (mode === 'assistant') {
    if (!j) {
      out.ok = false;
      out.status = 'no_json';
      out.message = hasBlock
        ? `Not saved: the JSON block at the end of the report could not be read${parseError ? ` (${String(parseError).slice(0, 160)})` : ''}. The run's contract cannot be checked without it. Fix the block and save the same report again; nothing was saved or linked.`
        : 'Not saved: the report has no JSON block. The prompt asks for one at the very end (its skeleton is in the grading appendix), naming this run. Add it and save again; nothing was saved or linked.';
      return out;
    }
    required.push('research_run_id', 'prompt_version');
  }
  const missingRequired = required.filter((f) => out.checks[f] && out.checks[f].result === 'missing');
  if (out.conflicts.length || missingRequired.length) {
    out.ok = false;
    out.status = out.conflicts.length ? 'conflict' : 'missing';
    const lines = [
      ...out.conflicts.map((f) => `${f}: the report says ${quote(out.checks[f].declared)}, the run's is ${quote(out.checks[f].expected)}`),
      ...missingRequired.map((f) => `${f}: the report does not state it; the run's is ${quote(out.checks[f].expected)}`),
    ];
    const where = mode === 'declared'
      ? `It names research run ${runId} but does not match it, so it is saved on its own and not linked to that run`
      : `Not saved: this report does not match research run ${runId}, the job it would complete. Nothing was saved or linked, and the job stays open`;
    out.message = `${where}. ${lines.join('; ')}.${mode === 'declared' ? '' : ' Copy these from the run\'s prompt into the JSON block (never another run\'s) and save again. If the report really answers another run or prompt, save it against that run instead.'}`;
  }
  return out;
}

// What is kept on the report's meta: the result per field, never the text.
function bindingRecord(b) {
  if (!b) return null;
  const fields = Object.fromEntries(Object.entries(b.checks || {}).map(([k, v]) => [k, v.result]));
  return { mode: b.mode, status: b.ok ? 'bound' : b.status, run_id: b.run_id, fields, conflicts: b.conflicts || [], prompt_sha256: b.prompt_sha256 || null, execution_sha256: b.execution_sha256 || null, checked_at: new Date().toISOString() };
}

module.exports = { checkBinding, bindingRecord, horizonResult, declaredModel };
