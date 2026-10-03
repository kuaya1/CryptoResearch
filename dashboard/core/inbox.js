'use strict';
// Inbox ingestion: the one path every report takes, whether dropped into
// inbox/<provider>/, pasted in the dashboard, uploaded, sent by Cowork, or
// returned by a research job. Pasted and uploaded text is first saved into the
// inbox, so it is never lost even if the import then fails.
//
// For each inbox file:
//   read bytes -> duplicate check (sha256) -> classify (report / prompt / ...) ->
//   resolve project -> check provider (inbox folder vs. what the content says) ->
//   build structured record -> one atomic operation: copy original + report.json
//   + meta.json into projects/<id>/reports/<report_id>/, move the inbox file to
//   processed/, update logs/ingestion-state.json (and the research job, if any).
// Failures leave the file in place and are recorded with the reason.
//
// Provenance (audit F15): the inbox folder (or API adapter) is the channel; what
// the text says about its own author is the declared provider; only an API
// response is "attested". An explicit conflict between channel and declaration
// is held back as provider_mismatch and never imported under the wrong name.

const fs = require('fs');
const path = require('path');
const { runOp, withLock, OpError, capabilities } = require('./ops');
const { sha256, readJson, listDir, exists, fileInfo } = require('./fsx');
const { randomId, compactTs, slugify, isProjectId } = require('./ids');
const { PROVIDERS, PROVIDER_LABELS } = require('./workspace');
const { classify, buildFromText, loadReports, detectProviderClaim, declaredProviderClaims, completeShape } = require('./reports');
const { listProjects, coreName } = require('./projects');
const { ymdInTz } = require('./dates');

const STATE_REL = 'logs/ingestion-state.json';
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json']);
const ACCEPTED_EXT = new Set([...TEXT_EXT, '.pdf']);
const MAX_BYTES = 20 * 1024 * 1024;

function emptyState() {
  return { schema_version: 'cr.ingestion-state.v1', files: {} };
}

function stateKey(provider, filename) {
  return `${provider}/${filename}`;
}

function normalizedTextHash(text) {
  return sha256(text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim());
}

// Index of every stored original by hash, for duplicate detection.
function knownHashes(ws) {
  const map = new Map();
  for (const p of listProjects(ws)) {
    if (p.broken) continue;
    for (const r of loadReports(ws, p.project_id)) {
      if (r.broken) continue;
      if (r.meta.original_sha256) map.set(r.meta.original_sha256, { project_id: p.project_id, report_id: r.report_id });
      if (r.meta.text_sha256) map.set(`t:${r.meta.text_sha256}`, { project_id: p.project_id, report_id: r.report_id });
    }
  }
  return map;
}

function frontMatterProject(text) {
  const head = text.split(/\r?\n/).slice(0, 12).join('\n');
  const m = head.match(/^\s*(?:project|project_id)\s*:\s*([a-z0-9][a-z0-9-]{0,63})\s*$/im);
  return m ? m[1] : null;
}

// Works out which project a report belongs to. Never guesses between several.
function resolveProject(ws, { json, filename, text, hint }) {
  const projects = listProjects(ws).filter((p) => !p.broken);
  const byId = new Map(projects.map((p) => [p.project_id, p]));
  if (hint) {
    if (!byId.has(hint)) return { error: `Project "${hint}" does not exist.` };
    return { project_id: hint, method: 'assigned' };
  }
  if (json && json.project_id) {
    if (byId.has(json.project_id)) return { project_id: json.project_id, method: 'json project_id' };
  }
  const fm = frontMatterProject(text || '');
  if (fm && byId.has(fm)) return { project_id: fm, method: 'front matter' };
  const base = path.basename(filename || '').toLowerCase();
  const prefixHits = projects
    .filter((p) => base.startsWith(p.project_id) && /^[_.\-\s]/.test(base.slice(p.project_id.length)))
    .sort((a, b) => b.project_id.length - a.project_id.length);
  if (prefixHits.length) return { project_id: prefixHits[0].project_id, method: 'file name prefix' };
  if (json && (json.project_name || json.project_symbol)) {
    const hits = projects.filter((p) => (json.project_name && coreName(p.name) === coreName(json.project_name)) || (json.project_symbol && p.symbol && p.symbol === String(json.project_symbol).toUpperCase() && json.project_name && coreName(p.name) === coreName(json.project_name)));
    if (hits.length === 1) return { project_id: hits[0].project_id, method: 'json project_name' };
  }
  // Title: the first heading or first non-empty line must name exactly one project.
  const firstLines = (text || '').split(/\r?\n/).filter((l) => l.trim()).slice(0, 3).join(' ').toLowerCase();
  const titleHits = projects.filter((p) => {
    const names = [p.name, ...(p.aliases || [])].filter(Boolean);
    return names.some((n) => new RegExp(`(^|[^a-z0-9])${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(firstLines));
  });
  if (titleHits.length === 1) return { project_id: titleHits[0].project_id, method: 'report title' };
  if (titleHits.length > 1) return { error: `The title mentions several projects (${titleHits.map((p) => p.project_id).join(', ')}). Assign it to one.` };
  if (json && json.project_id) return { error: `The report names project_id "${json.project_id}", which is not in the workspace. Add the project first, or assign the report.` };
  return { error: 'Could not tell which project this report is about. Assign it to a project (dashboard Imports page, or: node dashboard/cli.js inbox assign).' };
}

// What a research run fixed for every answer to it: rubric, sector profile,
// prompt version and horizon. A report saved against the run (save_report and
// the API path always name it) that leaves these out, as prose or a JSON block
// that could not be read does, is read under the run's, with that recorded.
// run.json is read directly at the path research.js uses, rather than through
// research.js, which itself loads this module.
function runDefaultsFor(ws, projectId, runId) {
  if (!/^run_[A-Za-z0-9_-]{4,80}$/.test(String(runId))) return null;
  let run = null;
  try {
    run = readJson(ws.abs(`projects/${projectId}/research/${runId}/run.json`), null);
  } catch (_) {
    return null;
  }
  if (!run || typeof run !== 'object' || (run.project_id && run.project_id !== projectId)) return null;
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const h = run.horizon;
  return {
    run_id: runId,
    rubric_version: text(run.rubric_version),
    sector_profile: text(run.sector_profile),
    prompt_version: text(run.prompt && run.prompt.version),
    horizon: text(typeof h === 'string' ? h : h && h.text),
  };
}

function setState(op, key, patch) {
  const state = op.readJson(STATE_REL, emptyState());
  state.files[key] = { ...(state.files[key] || {}), ...patch, updated_at: new Date().toISOString() };
  op.writeJson(STATE_REL, state);
}

function processedName(filename) {
  return `${ymdInTz()}_${filename}`;
}

// True when processed/ already holds a byte-identical copy of this inbox file
// (a move that could copy but not delete, in a restricted session).
function processedCopyExists(ws, provider, filename, hash) {
  const dir = `inbox/${provider}/processed`;
  const base = filename.replace(/(\.[^.]+)$/, '');
  for (const f of listDir(ws.abs(dir), { dirs: false })) {
    if (!f.includes(base)) continue;
    try {
      if (sha256(fs.readFileSync(ws.abs(`${dir}/${f}`))) === hash) return true;
    } catch (_) { /* ignore */ }
  }
  return false;
}

// Ingests one inbox file. Returns a result object; never throws for content problems.
// Runs under the workspace lock so the dashboard and the scheduled task cannot
// import the same file twice.
function ingestFile(ws, provider, filename, opts = {}) {
  if (!PROVIDERS.includes(provider)) throw new OpError('INVALID', `Unknown provider ${provider}`);
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.startsWith('.')) throw new OpError('BAD_PATH', 'Invalid file name');
  return withLock(ws, 'ingest', () => ingestLocked(ws, provider, filename, opts));
}

function ingestLocked(ws, provider, filename, opts = {}) {
  const {
    projectHint = null, force = false, allowProviderMismatch = false,
    runId = null, channel = null, attested = null, promptSha256 = null, evidenceSha256 = null,
  } = opts;
  const rel = `inbox/${provider}/${filename}`;
  const abs = ws.abs(rel);
  const key = stateKey(provider, filename);
  const info = fileInfo(abs);
  if (!info || !info.isFile) return { status: 'missing', key, message: `${rel} is no longer in the inbox.` };
  const ext = path.extname(filename).toLowerCase();

  const fail = (status, message, extra = {}) => {
    const st = readJson(ws.abs(STATE_REL), emptyState()).files[key] || {};
    runOp(ws, { type: 'ingest_failed', summary: `Import failed: ${key}` }, (op) => {
      setState(op, key, {
        provider,
        filename,
        status,
        error: message,
        sha256: extra.sha256 || null,
        attempts: (st.attempts || 0) + 1,
        last_attempt_at: new Date().toISOString(),
        reasons: extra.reasons || null,
        run_id: runId || null,
      });
    });
    return { status, key, message, ...extra };
  };

  if (!ACCEPTED_EXT.has(ext)) return fail('failed', `Unsupported file type "${ext || '(none)'}". Use .md, .txt, .json or .pdf.`);
  if (info.size > MAX_BYTES) return fail('failed', `File is larger than ${MAX_BYTES / 1048576} MB.`);
  const bytes = fs.readFileSync(abs);
  const hash = sha256(bytes);
  const prior = readJson(ws.abs(STATE_REL), emptyState()).files[key];
  if (!force && prior && prior.sha256 === hash && ['failed', 'needs_project', 'prompt', 'provider_mismatch'].includes(prior.status) && !projectHint) {
    return { status: 'skipped', key, message: `Unchanged since the last failed attempt (${prior.error}). Fix the file or retry it explicitly.` };
  }

  const known = knownHashes(ws);
  const isPdf = ext === '.pdf';
  const text = isPdf ? null : bytes.toString('utf8').replace(/^﻿/, '');
  const textHash = text ? normalizedTextHash(text) : null;
  const dup = known.get(hash) || (textHash ? known.get(`t:${textHash}`) : null);
  if (dup) {
    const alreadyCopied = processedCopyExists(ws, provider, filename, hash);
    const out = runOp(ws, { type: 'ingest_duplicate', summary: `Duplicate: ${key}` }, (op) => {
      if (!alreadyCopied) op.move(rel, `inbox/${provider}/processed/${processedName(filename.replace(/(\.[^.]+)$/, '.duplicate$1'))}`);
      setState(op, key, { provider, filename, status: 'duplicate', sha256: hash, duplicate_of: dup, error: null, last_attempt_at: new Date().toISOString() });
    });
    if (alreadyCopied && capabilities(ws).delete) {
      try { fs.unlinkSync(abs); } catch (_) { /* left for the next pass */ }
    }
    return { status: 'duplicate', key, duplicate_of: dup, project_id: dup.project_id, report_id: dup.report_id, message: `Already imported as ${dup.project_id}/${dup.report_id}. Not imported again.`, files: out.files, verified: out.verified };
  }

  let classification;
  let built = null;
  if (isPdf) {
    classification = { kind: 'report', format: 'pdf' };
  } else {
    classification = classify(text);
    if (classification.kind === 'prompt') {
      return fail('prompt', `This looks like an analysis prompt, not a completed report (${classification.reasons.join('; ')}). Run it in ${PROVIDER_LABELS[provider]} and drop the answer here instead.`, { sha256: hash, reasons: classification.reasons });
    }
    if (classification.kind !== 'report') {
      return fail('failed', `Not imported: ${(classification.reasons || [classification.kind]).join('; ')}.`, { sha256: hash });
    }
  }

  const json = classification.json && classification.json.obj ? classification.json.obj : null;
  const target = resolveProject(ws, { json, filename, text, hint: projectHint });
  if (target.error) return fail('needs_project', target.error, { sha256: hash });

  // The channel decides the provider. A report that says otherwise is held back.
  const jsonClaim = json ? (json.provider && PROVIDERS.includes(json.provider) ? json.provider : detectProviderClaim(json.model_self_identification)) : null;
  const proseClaims = text && !jsonClaim ? declaredProviderClaims(text) : [];
  const proseProviders = [...new Set(proseClaims.map((c) => c.provider))];
  const claimed = jsonClaim || (proseProviders.length === 1 ? proseProviders[0] : null);
  if (claimed && claimed !== provider && !allowProviderMismatch) {
    const where = jsonClaim ? 'its JSON block' : `line ${proseClaims[0].line} ("${proseClaims[0].excerpt}")`;
    return fail('provider_mismatch', `The file came in as ${PROVIDER_LABELS[provider]} but ${where} identifies it as ${PROVIDER_LABELS[claimed]}. It was not imported, so nothing is mislabeled. If it really came from ${PROVIDER_LABELS[claimed]}, import it there; if the label inside is wrong, assign it with "allow provider mismatch" and the conflict stays recorded.`, { sha256: hash });
  }

  if (!isPdf) built = buildFromText(ws, { text, classification, provider, runDefaults: runId ? runDefaultsFor(ws, target.project_id, runId) : null });

  const assessment = completeShape(built
    ? built.assessment
    : {
      schema_version: 'cr.assessment.v1',
      source_format: 'pdf',
      provider,
      analysis_at: null,
      needs_text: true,
      rubric_version: null,
      sector_profile: null,
      verdict: null,
      note: 'PDF preserved as the original. Text extraction is not available offline; add a text transcription to extract scores. No scores are inferred from the PDF.',
    });
  const datePart = (assessment.analysis_at && /^\d{4}-\d{2}-\d{2}/.test(assessment.analysis_at) ? assessment.analysis_at.slice(0, 10) : ymdInTz());
  const reportId = `${datePart}_${provider}_${hash.slice(0, 8)}`;
  const projectId = target.project_id;
  const dir = `projects/${projectId}/reports/${reportId}`;
  const now = new Date().toISOString();
  const originalName = `original${isPdf ? '.pdf' : ext === '.json' ? '.json' : ext === '.txt' ? '.txt' : '.md'}`;
  const linkedRun = runId || (assessment.research_run_id && /^run_[A-Za-z0-9_-]{4,80}$/.test(assessment.research_run_id) ? assessment.research_run_id : null);
  if (built && linkedRun) {
    // A position-cycle report is checked against the run it answers (horizon, recipe).
    const bound = require('./position').bindToRun(ws, target.project_id, linkedRun, assessment);
    if (assessment.position_context) assessment.position_context.run_binding = bound.binding;
    built.extraction.issues.push(...bound.issues);
  }
  const meta = {
    schema_version: 'cr.report-meta.v1',
    report_id: reportId,
    project_id: projectId,
    provider,
    provider_source: projectHint ? 'inbox folder; project assigned by user' : 'inbox folder',
    project_resolution: target.method,
    original_file: originalName,
    original_filename: filename,
    original_sha256: hash,
    text_sha256: textHash,
    bytes: bytes.length,
    imported_at: now,
    imported_by: ws.actor,
    inbox_path: rel,
    format: classification.format,
    analysis_date_known: Boolean(assessment.analysis_at),
    provenance: {
      channel: channel || (projectHint ? 'inbox (project assigned)' : 'inbox'),
      inbox_provider: provider,
      declared_provider: claimed,
      declared_from: jsonClaim ? 'json' : proseProviders.length === 1 ? 'prose' : null,
      provider_conflict_accepted: Boolean(claimed && claimed !== provider && allowProviderMismatch),
      declared_model: assessment.model_version || null,
      attested: attested || null,
      research_run_id: linkedRun,
      prompt_sha256: promptSha256 || null,
      evidence_packet_sha256: evidenceSha256 || null,
    },
    immutable: true,
    note: 'The original file and report.json never change. Corrections are separate files in corrections/.',
  };
  const record = {
    schema_version: 'cr.report-record.v1',
    report_id: reportId,
    project_id: projectId,
    provider,
    assessment: { ...assessment, report_id: reportId, project_id: projectId },
    extraction: built ? built.extraction : { method: 'pdf', issues: [{ severity: 'warning', field: 'text', message: 'PDF text not extracted; needs a text copy.' }], ambiguous: [] },
    raw_json: built ? built.raw : null,
  };
  const out = runOp(ws, { type: 'ingest_report', summary: `Import ${PROVIDER_LABELS[provider]} report for ${projectId}` }, (op) => {
    op.write(`${dir}/${originalName}`, bytes, { mode: 'create' });
    op.writeJson(`${dir}/meta.json`, meta, { mode: 'create' });
    op.writeJson(`${dir}/report.json`, record, { mode: 'create' });
    op.move(rel, `inbox/${provider}/processed/${processedName(filename)}`);
    setState(op, key, { provider, filename, status: 'ingested', sha256: hash, project_id: projectId, report_id: reportId, error: null, last_attempt_at: now, run_id: linkedRun });
    if (linkedRun) {
      try {
        require('./research').stageReportLink(ws, op, { projectId, runId: linkedRun, provider, reportId, method: runId ? 'run' : 'report json' });
      } catch (_) { /* a missing or foreign run never blocks the import */ }
    }
    return { report_id: reportId, project_id: projectId };
  });
  const issues = record.extraction.issues || [];
  if (!linkedRun) {
    try { require('./research').autoLinkReport(ws, { projectId, provider, reportId, importedAt: now }); } catch (_) { /* optional */ }
  }
  return {
    status: 'ingested',
    key,
    project_id: projectId,
    report_id: reportId,
    format: classification.format,
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
    ambiguous: (record.extraction.ambiguous || []).length,
    message: `Imported ${PROVIDER_LABELS[provider]} report ${reportId} into ${projectId}.`,
    files: out.files,
    verified: out.verified,
    op_id: out.op_id,
  };
}

function settled(info, settleSeconds) {
  return Date.now() - info.mtimeMs >= settleSeconds * 1000;
}

function isCandidate(name) {
  return !name.startsWith('.') && !name.startsWith('~$') && !/\.(tmp|part|crdownload|download)$/i.test(name) && !/\.tmp-\d+-/.test(name);
}

// Scans every provider inbox once. Files still being written are left for the next scan.
function scanInbox(ws, { providers = PROVIDERS, force = false } = {}) {
  const results = [];
  const settleSeconds = (ws.settings.inbox && ws.settings.inbox.settle_seconds) || 2;
  for (const provider of providers) {
    for (const name of listDir(ws.abs(`inbox/${provider}`), { dirs: false })) {
      if (!isCandidate(name)) continue;
      const info = fileInfo(ws.abs(`inbox/${provider}/${name}`));
      if (!info) continue;
      if (!force && !settled(info, settleSeconds)) {
        results.push({ status: 'waiting', key: stateKey(provider, name), message: 'File was modified moments ago; will import on the next scan.' });
        continue;
      }
      try {
        results.push(ingestFile(ws, provider, name, { force }));
      } catch (err) {
        results.push({ status: 'error', key: stateKey(provider, name), message: err.message });
      }
    }
  }
  return {
    scanned_at: new Date().toISOString(),
    results,
    counts: results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {}),
  };
}

// Saves pasted or uploaded content into the provider inbox (step 1 of 2).
function saveToInbox(ws, provider, { content, filename = null, projectId = null, ext = '.md' }) {
  if (!PROVIDERS.includes(provider)) throw new OpError('INVALID', `Unknown provider ${provider}`);
  if (projectId && !isProjectId(projectId)) throw new OpError('BAD_ID', 'Invalid project ID');
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content || ''), 'utf8');
  if (!buf.length) throw new OpError('INVALID', 'Nothing to import: the text is empty.');
  if (buf.length > MAX_BYTES) throw new OpError('INVALID', 'Too large.');
  let base = filename ? path.basename(String(filename)).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '') : '';
  const e = (path.extname(base) || ext).toLowerCase();
  if (!ACCEPTED_EXT.has(e)) throw new OpError('INVALID', `Unsupported file type ${e}`);
  base = base ? base.slice(0, base.length - path.extname(base).length) : 'pasted';
  const name = `${projectId ? `${projectId}__` : ''}${compactTs()}_${slugify(base, 40) || 'report'}_${randomId(4)}${e}`;
  const rel = `inbox/${provider}/${name}`;
  const out = runOp(ws, { type: 'save_to_inbox', summary: `Save ${provider} report to inbox` }, (op) => {
    op.write(rel, buf, { mode: 'create' });
    return { filename: name, rel };
  });
  // A replayed request returns the filename it saved the first time.
  const saved = out.replayed && out.result ? out.result : { filename: name, rel };
  return { filename: saved.filename, rel: saved.rel, files: out.files, verified: out.verified, replayed: Boolean(out.replayed) };
}

function importContent(ws, provider, opts) {
  const saved = saveToInbox(ws, provider, opts);
  if (saved.replayed && !exists(ws.abs(saved.rel))) {
    // The earlier attempt already imported (or set aside) this text.
    const st = readJson(ws.abs(STATE_REL), emptyState()).files[stateKey(provider, saved.filename)] || {};
    return { saved, result: { status: st.status === 'ingested' ? 'duplicate' : st.status || 'missing', key: stateKey(provider, saved.filename), project_id: st.project_id || null, report_id: st.report_id || null, message: st.status === 'ingested' ? `Already imported as ${st.project_id}/${st.report_id}.` : st.error || 'The saved text is no longer in the inbox.' } };
  }
  const result = ingestFile(ws, provider, saved.filename, {
    projectHint: opts.projectId || null,
    force: true,
    runId: opts.runId || null,
    channel: opts.channel || null,
    attested: opts.attested || null,
    promptSha256: opts.promptSha256 || null,
    evidenceSha256: opts.evidenceSha256 || null,
  });
  return { saved, result };
}

function assignAndRetry(ws, key, projectId, opts = {}) {
  const [provider, filename] = String(key).split('/');
  if (projectId && !isProjectId(projectId)) throw new OpError('BAD_ID', 'Invalid project ID');
  return ingestFile(ws, provider, filename, { projectHint: projectId || null, force: true, allowProviderMismatch: Boolean(opts.allowProviderMismatch), runId: opts.runId || null });
}

// Moves a file that should not be imported (a prompt, a wrong file) out of the
// inbox into processed/ without importing it. Nothing is deleted.
function setAside(ws, key, reason = null) {
  const [provider, filename] = String(key).split('/');
  if (!PROVIDERS.includes(provider) || !filename || filename.startsWith('.') || filename.includes('\\')) throw new OpError('BAD_PATH', 'Invalid inbox key');
  const rel = `inbox/${provider}/${filename}`;
  if (!exists(ws.abs(rel))) throw new OpError('NOT_FOUND', `${rel} is not in the inbox.`);
  const out = runOp(ws, { type: 'inbox_set_aside', summary: `Set aside ${key}` }, (op) => {
    op.move(rel, `inbox/${provider}/processed/${processedName(filename.replace(/(\.[^.]+)?$/, '.set-aside$1'))}`);
    setState(op, key, { provider, filename, status: 'set_aside', error: null, reason, last_attempt_at: new Date().toISOString() });
  });
  return { status: 'set_aside', key, files: out.files };
}

function inboxStatus(ws) {
  const state = readJson(ws.abs(STATE_REL), emptyState());
  const pending = [];
  for (const provider of PROVIDERS) {
    for (const name of listDir(ws.abs(`inbox/${provider}`), { dirs: false })) {
      if (!isCandidate(name)) continue;
      const key = stateKey(provider, name);
      const st = state.files[key] || null;
      pending.push({ key, provider, filename: name, status: st ? st.status : 'new', error: st ? st.error : null, attempts: st ? st.attempts || 0 : 0, last_attempt_at: st ? st.last_attempt_at : null, reasons: st ? st.reasons : null });
    }
  }
  const recent = Object.entries(state.files)
    .map(([key, v]) => ({ key, ...v }))
    .filter((v) => ['ingested', 'duplicate'].includes(v.status))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, 30);
  return { in_inbox: pending, recent };
}

// Raw text of a file still waiting in the inbox (for correcting a failed import).
function readInboxText(ws, key) {
  const [provider, filename] = String(key).split('/');
  if (!PROVIDERS.includes(provider) || !filename || filename.startsWith('.') || filename.includes('\\') || filename.includes('/')) throw new OpError('BAD_PATH', 'Invalid inbox key');
  const abs = ws.abs(`inbox/${provider}/${filename}`);
  if (!exists(abs)) throw new OpError('NOT_FOUND', 'That file is no longer in the inbox.');
  if (/\.pdf$/i.test(filename)) return { key, binary: true, text: null };
  return { key, binary: false, text: fs.readFileSync(abs, 'utf8') };
}

module.exports = {
  STATE_REL,
  scanInbox,
  ingestFile,
  saveToInbox,
  importContent,
  assignAndRetry,
  setAside,
  inboxStatus,
  readInboxText,
  resolveProject,
  normalizedTextHash,
};
