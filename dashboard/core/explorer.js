'use strict';
// Research Explorer: an optional mirror of research records in Supabase, for
// learning and comparing category grades across projects. The desk's own
// records (and the online desk on Render) stay the record; the Explorer is
// never needed for anything else to work.
//
// Path: the browser asks this server (GET /api/explorer, behind the desk's
// own sign-in and session token); this server asks Supabase's REST API
// (PostgREST) with a secret key the browser never sees; the answer comes back
// as plain JSON. Writes go one way only, by the CLI: `explorer export
// --fixtures` sends the FICTIONAL fixture records through the database
// function public.explorer_import(), which stores each report whole or not
// at all and refuses changed content under a known report ID. Opening the
// Explorer reads; it never writes, screens, prices or starts research.
//
// Configuration (never in the page, logs, settings or Git):
//   CR_SUPABASE_URL         or settings explorer.supabase_url (https://<ref>.supabase.co)
//   CR_SUPABASE_SECRET_KEY  or "supabase_secret_key" in ~/.cryptoresearch/secrets.json
//   CR_EXPLORER=off         or settings explorer.enabled = false switches it off
// A secret key (sb_secret_...) or a legacy service_role key. A publishable or
// anon key is refused: it can read nothing here, by design.
//
// Supabase down, slow or misconfigured: the Explorer says "unavailable" with
// the reason (and the last copy this server read, labeled with its time);
// every other page is untouched.

const { secretsFile } = require('./providers');
const adapter = require('./explorer-adapter');

const READ_TIMEOUT_MS = 8000;
const EXPORT_TIMEOUT_MS = 30000;
const CACHE_MS = 30000;
const MIN_REFRESH_MS = 5000;
const STALE_DAYS = 7;
const MAX_ROWS = 1000;
const URL_RE = /^https:\/\/[a-z0-9]{20}\.supabase\.co$/;
// A test workspace may point at a local stand-in for Supabase.
const LOOPBACK_RE = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
// CR_EXPLORER_READ_TIMEOUT_MS shortens the read limit in tests.
const readTimeoutMs = () => Math.max(200, Number(process.env.CR_EXPLORER_READ_TIMEOUT_MS) || READ_TIMEOUT_MS);

class ExplorerError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

// The owner's secrets file: its keys, or that it is missing, or that it is
// there but not valid JSON (a missing comma hides every key in it, so that is
// said, never taken as "no key").
function readSecretsFile() {
  const fs = require('fs');
  let text;
  try {
    text = fs.readFileSync(secretsFile(), 'utf8');
  } catch (_) {
    return { data: {}, unreadable: false };
  }
  try {
    const data = JSON.parse(text.replace(/^﻿/, ''));
    return { data: data && typeof data === 'object' ? data : {}, unreadable: false };
  } catch (_) {
    return { data: {}, unreadable: true };
  }
}

// What a key is, without ever returning it. A legacy key is a JWT whose role
// claim says which one it is.
function keyKind(key) {
  if (typeof key !== 'string' || !key.trim()) return 'none';
  const k = key.trim();
  if (k.startsWith('sb_secret_')) return 'secret';
  if (k.startsWith('sb_publishable_')) return 'publishable';
  const parts = k.split('.');
  if (parts.length === 3) {
    try {
      const role = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role;
      return role === 'service_role' ? 'service_role_jwt' : role === 'anon' ? 'anon_jwt' : 'unknown';
    } catch (_) {
      return 'unknown';
    }
  }
  return 'unknown';
}

// The configuration in words, plus (internally, in _key) the key itself,
// which status(), read() and every reply leave out.
function resolve(ws, env = process.env) {
  const s = (ws.settings && ws.settings.explorer) || {};
  const off = String(env.CR_EXPLORER || '').trim().toLowerCase() === 'off' || s.enabled === false;
  const url = String(env.CR_SUPABASE_URL || s.supabase_url || '').trim().replace(/\/+$/, '');
  const urlSource = env.CR_SUPABASE_URL ? 'environment variable CR_SUPABASE_URL' : s.supabase_url ? 'settings (explorer.supabase_url)' : null;
  let key = env.CR_SUPABASE_SECRET_KEY || null;
  let keySource = key ? 'environment variable CR_SUPABASE_SECRET_KEY' : null;
  // Only the real workspace reads the owner's secrets file: a test or demo
  // workspace never picks up a real key (it takes one from its environment).
  let secretsUnreadable = false;
  if (!key && ws.kind === 'real') {
    const f = readSecretsFile();
    secretsUnreadable = f.unreadable;
    if (typeof f.data.supabase_secret_key === 'string' && f.data.supabase_secret_key.trim()) {
      key = f.data.supabase_secret_key.trim();
      keySource = `${secretsFile()} (supabase_secret_key)`;
    }
  }
  const kind = keyKind(key);
  const problems = [];
  const missing = [];
  if (secretsUnreadable) problems.push(`${secretsFile()} is not valid JSON (often a missing comma or quote), so no key in it can be read. Fix the file; nothing else is needed.`);
  if (!url) missing.push('the Supabase project URL (node dashboard/cli.js explorer configure --url https://<ref>.supabase.co, or CR_SUPABASE_URL)');
  else if (!URL_RE.test(url) && !(ws.kind === 'test' && LOOPBACK_RE.test(url))) problems.push('The Supabase URL must be a project address, https://<20-character ref>.supabase.co, and nothing else.');
  if (!key) missing.push(`a Supabase secret key ("supabase_secret_key" in ${secretsFile()}, or CR_SUPABASE_SECRET_KEY)`);
  else if (kind === 'publishable' || kind === 'anon_jwt') problems.push('The key given is a publishable (anon) key: it can read nothing in the Explorer by design. The desk needs a secret key, kept on this server only.');
  else if (kind === 'unknown') problems.push('The key given is not a Supabase secret key (sb_secret_...) or service_role key.');
  const state = off ? 'off' : missing.length || problems.length ? 'not_configured' : 'configured';
  return { state, url: url || null, url_source: urlSource, key_present: Boolean(key), key_source: keySource, key_kind: kind === 'none' ? null : kind, missing, problems, _key: state === 'configured' ? key.trim() : null };
}

// Safe to show anywhere: no key, only where it would come from.
function status(ws, env = process.env) {
  const { _key, ...safe } = resolve(ws, env);
  return safe;
}

// For the navigation: show the Explorer where it is set up, and on the PC.
function navInfo(ws, { hosted = false } = {}) {
  const st = resolve(ws).state;
  return { state: st, show: st === 'configured' || (st !== 'off' && !hosted) };
}

// ---- the REST client --------------------------------------------------------

const scrub = (s, key) => (key ? String(s).split(key).join('[secret]') : String(s));

async function rest(cfg, method, pathQuery, { body = null, timeoutMs = readTimeoutMs() } = {}) {
  const headers = { apikey: cfg._key, accept: 'application/json' };
  // A legacy service_role key is a JWT and goes in Authorization too; a
  // secret key goes in apikey only (Supabase refuses it as a bearer token).
  if (cfg.key_kind === 'service_role_jwt') headers.authorization = `Bearer ${cfg._key}`;
  if (body) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(`${cfg.url}/rest/v1${pathQuery}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new ExplorerError(timedOut ? 'TIMEOUT' : 'NETWORK', timedOut ? `Supabase did not answer within ${Math.round(timeoutMs / 1000)} seconds.` : `Supabase could not be reached (${scrub((err.cause && err.cause.code) || err.message, cfg._key)}).`);
  }
  const raw = await res.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch (_) {
    json = null;
  }
  if (!res.ok) {
    const said = json && (json.message || json.error || json.msg) ? `${json.message || json.error || json.msg}${json.code ? ` (${json.code})` : ''}` : `HTTP ${res.status}`;
    const code = res.status === 401 || res.status === 403 ? 'REFUSED_BY_SUPABASE' : res.status >= 500 ? 'SUPABASE_ERROR' : 'BAD_REQUEST';
    throw new ExplorerError(code, `Supabase answered ${res.status}: ${scrub(said, cfg._key).slice(0, 300)}`, { http_status: res.status });
  }
  return json;
}

// ---- reading (GET /api/explorer) --------------------------------------------

const REPORT_COLUMNS = [
  'report_id', 'project_id', 'dataset', 'model', 'model_version', 'research_run_id', 'research_date', 'saved_at',
  'horizon_text', 'horizon_start', 'horizon_end', 'report_format', 'prompt_version', 'rubric_version', 'profile_version', 'verdict',
  'revision_of', 'revision_kind', 'revision_basis', 'revision_note',
  'grade_status', 'grade_value', 'grade_low', 'grade_high', 'grade_coverage_pct', 'grade_unscored', 'grade_reason',
  'evidence_summary', 'evidence_coverage', 'evidence_high', 'evidence_medium', 'evidence_low', 'evidence_checked_at', 'exported_at',
];
const SCORE_COLUMNS = ['category_id', 'category_label', 'position', 'status', 'score', 'score_low', 'score_high', 'confidence', 'evidence_refs', 'rationale', 'main_weakness', 'unknown_reason', 'evidence_flags'];
const PROJECT_COLUMNS = ['project_id', 'dataset', 'name', 'ticker', 'identity_status', 'chain', 'contract_address', 'native_chain', 'updated_at'];
const EXPORT_COLUMNS = ['export_id', 'dataset', 'source', 'adapter_version', 'started_at', 'finished_at', 'projects_inserted', 'projects_updated', 'projects_unchanged', 'reports_inserted', 'reports_unchanged', 'reports_evidence_updated', 'reports_refused', 'scores_inserted'];

// Numbers come back as numbers; a numeric column may come back as text from
// some proxies, so read it as a number only when it is one. Null stays null:
// an unknown score is never 0.
const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

function shapeScore(s) {
  return {
    ...s,
    position: num(s.position),
    score: num(s.score),
    score_low: num(s.score_low),
    score_high: num(s.score_high),
    evidence_refs: Array.isArray(s.evidence_refs) ? s.evidence_refs : [],
    evidence_flags: Array.isArray(s.evidence_flags) ? s.evidence_flags : [],
  };
}

function shapeReport(r) {
  const scores = (Array.isArray(r.category_scores) ? r.category_scores : []).map(shapeScore).sort((a, b) => (a.position || 0) - (b.position || 0));
  return {
    ...r,
    grade_value: num(r.grade_value),
    grade_low: num(r.grade_low),
    grade_high: num(r.grade_high),
    grade_coverage_pct: num(r.grade_coverage_pct),
    grade_unscored: Array.isArray(r.grade_unscored) ? r.grade_unscored : [],
    category_scores: scores,
  };
}

let memory = null; // { url, fetched_at, at, data } — this server's last good read

async function read(ws, { refresh = false, env = process.env, now = Date.now } = {}) {
  const cfg = resolve(ws, env);
  const base = { state: cfg.state, configured: cfg.state === 'configured', checked_at: new Date(now()).toISOString() };
  if (cfg.state === 'off') return { ...base, reason: 'The Research Explorer is switched off on this desk.' };
  if (cfg.state === 'not_configured') return { ...base, missing: cfg.missing.map((m) => m.replace(/ \(.*$/, '')), problems: cfg.problems, reason: cfg.problems[0] || `Missing ${cfg.missing.map((m) => m.replace(/ \(.*$/, '')).join(' and ')}.` };
  const mine = memory && memory.url === cfg.url ? memory : null;
  const age = mine ? now() - mine.at : Infinity;
  if (mine && (age < (refresh ? MIN_REFRESH_MS : CACHE_MS))) return { ...mine.data, checked_at: base.checked_at, served: 'cache' };
  try {
    const [projects, reports, exportsList] = await Promise.all([
      rest(cfg, 'GET', `/projects?select=${PROJECT_COLUMNS.join(',')}&order=name.asc&limit=${MAX_ROWS}`),
      rest(cfg, 'GET', `/reports?select=${REPORT_COLUMNS.join(',')},category_scores(${SCORE_COLUMNS.join(',')})&order=saved_at.desc&limit=${MAX_ROWS}`),
      rest(cfg, 'GET', `/export_runs?select=${EXPORT_COLUMNS.join(',')}&order=finished_at.desc&limit=1`),
    ]);
    const last = Array.isArray(exportsList) && exportsList.length ? exportsList[0] : null;
    const lastAt = last ? Date.parse(last.finished_at) : NaN;
    const stale = !last || !Number.isFinite(lastAt) || now() - lastAt > STALE_DAYS * 86400000;
    const list = Array.isArray(reports) ? reports.map(shapeReport) : [];
    const datasets = [...new Set([...(projects || []).map((p) => p.dataset), ...list.map((r) => r.dataset)])].filter(Boolean).sort();
    const data = {
      ...base,
      state: !last ? 'empty' : stale ? 'stale' : 'ok',
      reason: !last ? 'Nothing has been exported to the Explorer yet (node dashboard/cli.js explorer export --fixtures).' : stale ? `The last export finished ${Math.floor((now() - lastAt) / 86400000)} days ago; the Explorer may not match the desk.` : null,
      fetched_at: new Date(now()).toISOString(),
      served: 'supabase',
      demo: datasets.includes('demo'),
      datasets,
      stale_after_days: STALE_DAYS,
      last_export: last,
      truncated: list.length >= MAX_ROWS || (projects || []).length >= MAX_ROWS,
      projects: projects || [],
      reports: list,
    };
    memory = { url: cfg.url, at: now(), data };
    return data;
  } catch (err) {
    const reason = err instanceof ExplorerError ? err.message : `The Explorer could not be read: ${scrub(err.message, cfg._key)}`;
    if (mine) return { ...mine.data, state: 'unavailable', reason, checked_at: base.checked_at, served: 'memory', copy_fetched_at: mine.data.fetched_at };
    return { ...base, state: 'unavailable', reason, projects: [], reports: [] };
  }
}

// ---- exporting (CLI only) ---------------------------------------------------

function fixtureBatch(ws) {
  return adapter.buildBatch(ws, adapter.loadFixtures(), { dataset: 'demo', source: adapter.FIXTURE_REL });
}

// Sends the FICTIONAL fixture records. Repeatable: identical reports come back
// "unchanged", nothing is duplicated, and a timeout after Supabase committed
// is settled by running it again.
async function exportFixtures(ws, { dryRun = false, env = process.env } = {}) {
  const { batch, skipped } = fixtureBatch(ws);
  const counts = { projects: batch.projects.length, reports: batch.reports.length, category_scores: batch.reports.reduce((n, r) => n + r.category_scores.length, 0) };
  if (dryRun) return { status: 'dry_run', dataset: 'demo', sent: false, ...counts, skipped, batch };
  const cfg = resolve(ws, env);
  if (cfg.state !== 'configured') {
    throw new ExplorerError('REFUSED', cfg.state === 'off' ? 'The Research Explorer is switched off (explorer.enabled or CR_EXPLORER). Nothing was sent.' : `The Research Explorer is not set up: ${[...cfg.problems, ...cfg.missing.map((m) => `missing ${m}`)].join('; ')}. Nothing was sent.`);
  }
  let out;
  try {
    out = await rest(cfg, 'POST', '/rpc/explorer_import', { body: { batch }, timeoutMs: EXPORT_TIMEOUT_MS });
  } catch (err) {
    // One call is one database transaction: a refusal wrote nothing, and
    // after a lost answer a repeat settles it (stored reports come back
    // "unchanged").
    if (['TIMEOUT', 'NETWORK', 'SUPABASE_ERROR'].includes(err.code)) err.message += ' Whether Supabase stored it is unknown; running the export again is safe (identical reports come back unchanged).';
    else err.message += ' Nothing was stored: the export is one transaction.';
    throw err;
  }
  memory = null;
  const refused = (out.results || []).filter((x) => x.status === 'conflict' || x.status === 'refused');
  return {
    status: refused.some((x) => x.status === 'conflict') ? 'conflict' : refused.length ? 'rejected' : 'exported',
    dataset: 'demo',
    export_id: out.export_id,
    finished_at: out.finished_at,
    projects: out.projects,
    reports: out.reports,
    scores_inserted: out.scores_inserted,
    results: out.results,
    skipped,
    sent: counts,
  };
}

// The desk's real records. Prepared (explorer-adapter.js deskSources) and
// deliberately not enabled: copying real research to Supabase is Eric's
// decision, made in a later version.
function exportDesk() {
  throw new ExplorerError('REFUSED', 'Exporting real desk records to the Explorer is prepared but not enabled in this version. Only the FICTIONAL fixtures are exported (explorer export --fixtures).');
}

function resetMemory() {
  memory = null;
}

module.exports = { ExplorerError, keyKind, resolve, status, navInfo, read, exportFixtures, exportDesk, fixtureBatch, resetMemory, STALE_DAYS, URL_RE };
