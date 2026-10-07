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
// at all and refuses changed content under a known report ID. Real records
// can only be previewed, one project at a time (`explorer export --project
// <id> --dry-run`, no network); sending them is not enabled. Opening the
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
const { reportOrder } = require('./reports');

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

async function rest(cfg, method, pathQuery, { body = null, timeoutMs = readTimeoutMs(), headers: extra = null, withHeaders = false } = {}) {
  const headers = { ...(extra || {}), apikey: cfg._key, accept: 'application/json' };
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
  return withHeaders ? { json, headers: res.headers } : json;
}

// Every row of one query, page by page: PostgREST's Range header with an
// exact count. Supabase caps each answer at its own row limit (1,000 by
// default) whatever the page asked for, so the next page starts after the
// rows actually received. The query's order must be unique (it ends with the
// table's key), so pages neither overlap nor skip; `key` names each row, and
// a row read twice, or a count that changes between pages (an export landing
// mid-read), makes the read incomplete. The stated total is checked at the
// end: nothing is ever drawn from a silently shortened list.
// CR_EXPLORER_PAGE_SIZE makes the pages small in tests.
const pageSize = () => Math.max(1, Math.min(MAX_ROWS, Number(process.env.CR_EXPLORER_PAGE_SIZE) || MAX_ROWS));
const MAX_PAGES = 500;

async function restAll(cfg, pathQuery, key) {
  const size = pageSize();
  const rows = [];
  const seen = new Set();
  let total = null;
  let pages = 0;
  for (;;) {
    if (pages >= MAX_PAGES) throw new ExplorerError('INCOMPLETE', `Stopped after ${MAX_PAGES} pages with ${rows.length} rows read; the read is incomplete.`);
    const from = rows.length;
    const { json, headers } = await rest(cfg, 'GET', pathQuery, { headers: { 'range-unit': 'items', range: `${from}-${from + size - 1}`, prefer: 'count=exact' }, withHeaders: true });
    pages += 1;
    const got = Array.isArray(json) ? json : [];
    const m = /^(?:(\d+)-(\d+)|\*)\/(\d+|\*)$/.exec(String(headers.get('content-range') || '').trim());
    if (!m || m[3] === '*') throw new ExplorerError('INCOMPLETE', 'Supabase did not state how many rows there are, so a complete read cannot be confirmed.');
    if (got.length && Number(m[1]) !== from) throw new ExplorerError('INCOMPLETE', `Supabase answered rows from ${m[1]} when rows from ${from} were asked for; the read is incomplete.`);
    if (total !== null && Number(m[3]) !== total) throw new ExplorerError('INCOMPLETE', `The Explorer changed while it was being read (${total} rows, then ${m[3]}); the read is incomplete. Refresh to read it again.`, { changed: true });
    total = Number(m[3]);
    for (const row of got) {
      const k = key(row);
      if (seen.has(k)) throw new ExplorerError('INCOMPLETE', `Row ${k} came back twice across pages; the read is incomplete. Refresh to read it again.`);
      seen.add(k);
      rows.push(row);
    }
    if (rows.length >= total) break;
    if (!got.length) throw new ExplorerError('INCOMPLETE', `Supabase returned ${rows.length} of ${total} rows and then none; the read is incomplete.`);
  }
  if (rows.length !== total) throw new ExplorerError('INCOMPLETE', `Read ${rows.length} rows where Supabase counts ${total}; the read is incomplete.`);
  return { rows, total, pages };
}

const byProject = (p) => p.project_id;
const byReport = (r) => r.report_id;
const byScore = (s) => `${s.report_id}/${s.category_id}`;

// ---- one consistent state (review of 2026-10-07, finding 4) ------------------
//
// One answer is assembled from several requests (reports, projects, grades,
// the last export receipt), each its own snapshot. The database keeps one
// generation number (public.explorer_state, schema 2) that every write to the
// Explorer tables raises in its own transaction, the export's inserts,
// evidence refreshes and completions included. The marker is read before and
// after the requests: the same number means no write committed in between,
// so the reports, their grades and the receipt belong together. Otherwise the
// whole answer is read again, up to MAX_READ_ATTEMPTS times, then said to be
// "updating"; it is never labeled synced. A count that changes between pages
// (restAll) is the same event seen mid-request and is read again too.
const MIGRATION_2 = 'explorer_exact_order_precision_marker';
const MAX_READ_ATTEMPTS = 3;

async function markerOf(cfg) {
  let rows;
  try {
    rows = await rest(cfg, 'GET', '/explorer_state?select=generation,changed_at&singleton=eq.true');
  } catch (err) {
    if (err instanceof ExplorerError && (err.http_status === 404 || /explorer_state/.test(err.message))) {
      throw new ExplorerError('NOT_MIGRATED', `The Explorer database has no consistency marker (public.explorer_state, migration ${MIGRATION_2}), so whether one read saw one export cannot be confirmed. Apply the migration, then Refresh.`);
    }
    throw err;
  }
  const row = Array.isArray(rows) ? rows[0] : null;
  const generation = row ? num(row.generation) : null;
  if (generation === null) throw new ExplorerError('NOT_MIGRATED', `The Explorer database's consistency marker is missing or unreadable (public.explorer_state, migration ${MIGRATION_2}). Refresh after it is restored.`);
  return { generation, changed_at: row.changed_at || null };
}

async function consistentRead(cfg, assemble) {
  for (let attempt = 1; ; attempt += 1) {
    const before = await markerOf(cfg);
    let value = null;
    let failure = null;
    try {
      value = await assemble();
    } catch (err) {
      if (!(err instanceof ExplorerError && err.code === 'INCOMPLETE')) throw err;
      failure = err;
    }
    const after = await markerOf(cfg);
    const moved = after.generation !== before.generation;
    if (!failure && !moved) return { value, marker: { ...after, attempts: attempt } };
    if (attempt >= MAX_READ_ATTEMPTS) {
      // Writes kept landing: "updating". A read that stays incomplete with
      // nothing written (rows repeated, a count never reached) is said as such.
      if (moved || failure.changed) throw new ExplorerError('UPDATING', `The Explorer changed while it was being read, ${MAX_READ_ATTEMPTS} times in a row (an export is landing). What was read is not shown as synced; Refresh in a moment.`);
      throw failure;
    }
  }
}

// ---- reading (GET /api/explorer) --------------------------------------------

const REPORT_COLUMNS = [
  'report_id', 'project_id', 'dataset', 'model', 'model_version', 'research_run_id', 'research_date', 'saved_at', 'order_basis', 'order_at',
  'horizon_text', 'horizon_start', 'horizon_end', 'report_format', 'prompt_version', 'rubric_version', 'profile_version', 'verdict',
  'revision_of', 'revision_kind', 'revision_basis', 'revision_note',
  'grade_status', 'grade_value', 'grade_low', 'grade_high', 'grade_coverage_pct', 'grade_unscored', 'grade_reason',
  'evidence_summary', 'evidence_coverage', 'evidence_high', 'evidence_medium', 'evidence_low', 'evidence_checked_at', 'exported_at',
];
const SCORE_COLUMNS = ['category_id', 'category_label', 'position', 'status', 'score', 'score_low', 'score_high', 'score_exact', 'score_low_exact', 'score_high_exact', 'confidence', 'evidence_refs', 'rationale', 'main_weakness', 'unknown_reason', 'evidence_flags'];
const PROJECT_COLUMNS = ['project_id', 'dataset', 'name', 'ticker', 'identity_status', 'chain', 'contract_address', 'native_chain', 'updated_at'];
const EXPORT_COLUMNS = ['export_id', 'dataset', 'source', 'adapter_version', 'started_at', 'finished_at', 'projects_inserted', 'projects_updated', 'projects_unchanged', 'reports_inserted', 'reports_unchanged', 'reports_evidence_updated', 'reports_refused', 'scores_inserted', 'reports_metadata_completed', 'reports_metadata_missing'];

// Numbers come back as numbers; a numeric column may come back as text from
// some proxies, so read it as a number only when it is one. Null stays null:
// an unknown score is never 0.
const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const given = (v) => v !== null && v !== undefined && v !== '';

// A category grade with its exact value: the number the export sent
// (score_exact and the range ends, schema 2), else the two-decimal column of a
// row stored before 2026-10-07, said as such ("precision"), since its source
// value may have been rounded (review of 2026-10-07, finding 7). Display
// rounding is the page's business; nothing here rounds.
function shapeScore(s) {
  const { score_exact: px, score_low_exact: lx, score_high_exact: hx, ...rest } = s;
  const precision = s.status === 'scored' ? (given(px) ? 'exact' : 'two_decimals') : s.status === 'range' ? (given(lx) && given(hx) ? 'exact' : 'two_decimals') : null;
  return {
    ...rest,
    position: num(s.position),
    score: num(given(px) ? px : s.score),
    score_low: num(given(lx) ? lx : s.score_low),
    score_high: num(given(hx) ? hx : s.score_high),
    precision,
    evidence_refs: Array.isArray(s.evidence_refs) ? s.evidence_refs : [],
    evidence_flags: Array.isArray(s.evidence_flags) ? s.evidence_flags : [],
  };
}

const isoOf = (s) => {
  const t = Date.parse(s || '');
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
};

// The desk's latest-report rule (reports.js reportSortKey: the instant from
// reportOrder, then the save time, then the report ID; newest is the largest
// key). Since schema 2 the export stores the desk's own basis and instant
// (order_basis, order_at), so the key is exactly the desk's. A report stored
// before 2026-10-07 has only its analysis day: its key is that day through
// the same rule (a day more than a day after the save sorts at the save
// time), order_exact false, and the response says how many such reports
// there are: two of one model's reports on the same day may then order
// differently than on the desk (review of 2026-10-07, finding 3).
function orderKey(r) {
  const saved = isoOf(r.saved_at);
  if (r.order_basis) return `${r.order_basis === 'undated' ? '' : isoOf(r.order_at)}|${saved}|${r.report_id}`;
  const day = r.research_date ? reportOrder({ report_id: r.report_id, assessment: { analysis_at: String(r.research_date).slice(0, 10) }, meta: { imported_at: saved } }).at : saved;
  return `${day || ''}|${saved}|${r.report_id}`;
}

function shapeReport(r) {
  const scores = (Array.isArray(r.category_scores) ? r.category_scores : []).map(shapeScore).sort((a, b) => (a.position || 0) - (b.position || 0));
  return {
    ...r,
    order_key: orderKey(r),
    order_exact: Boolean(r.order_basis),
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
    // Every row, page by page (restAll), each query in a unique order, all of
    // it between two readings of the consistency marker (consistentRead): the
    // reports, their projects and grades and the export receipt shown are one
    // committed state of the database.
    const { value: got, marker } = await consistentRead(cfg, async () => {
      const reports = await restAll(cfg, `/reports?select=${REPORT_COLUMNS.join(',')}&order=saved_at.desc,report_id.asc`, byReport);
      const [projects, scores, exportsList] = await Promise.all([
        restAll(cfg, `/projects?select=${PROJECT_COLUMNS.join(',')}&order=name.asc,project_id.asc`, byProject),
        restAll(cfg, `/category_scores?select=report_id,${SCORE_COLUMNS.join(',')}&order=report_id.asc,category_id.asc`, byScore),
        rest(cfg, 'GET', `/export_runs?select=${EXPORT_COLUMNS.join(',')}&order=finished_at.desc,export_id.asc&limit=1`),
      ]);
      return { reports, projects, scores, exportsList };
    });
    const { reports, projects, scores, exportsList } = got;
    const grades = new Map(reports.rows.map((r) => [r.report_id, []]));
    for (const s of scores.rows) if (grades.has(s.report_id)) grades.get(s.report_id).push(s);
    const last = Array.isArray(exportsList) && exportsList.length ? exportsList[0] : null;
    const lastAt = last ? Date.parse(last.finished_at) : NaN;
    const stale = !last || !Number.isFinite(lastAt) || now() - lastAt > STALE_DAYS * 86400000;
    const list = reports.rows.map((r) => shapeReport({ ...r, category_scores: grades.get(r.report_id) }));
    const datasets = [...new Set([...projects.rows.map((p) => p.dataset), ...list.map((r) => r.dataset)])].filter(Boolean).sort();
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
      totals: { projects: projects.total, reports: reports.total, category_scores: list.reduce((n, r) => n + r.category_scores.length, 0) },
      pages: { projects: projects.pages, reports: reports.pages, category_scores: scores.pages },
      // The committed state this answer describes, and how many reads it took.
      marker,
      // Reports exported before exact order and exact values were stored.
      legacy: legacyOf(list),
      projects: projects.rows,
      reports: list,
    };
    memory = { url: cfg.url, at: now(), data };
    return data;
  } catch (err) {
    const reason = err instanceof ExplorerError ? err.message : `The Explorer could not be read: ${scrub(err.message, cfg._key)}`;
    const state = err instanceof ExplorerError && err.code === 'UPDATING' ? 'updating' : 'unavailable';
    if (mine) return { ...mine.data, state, reason, checked_at: base.checked_at, served: 'memory', copy_fetched_at: mine.data.fetched_at };
    return { ...base, state, reason, projects: [], reports: [] };
  }
}

// How many reports lack the schema-2 metadata (stored before 2026-10-07 and
// not completed since): their order is known to the day and their values to
// two decimals. Said, never filled in.
function legacyOf(list) {
  const order = list.filter((r) => !r.order_exact).length;
  const values = list.filter((r) => r.category_scores.some((s) => s.precision === 'two_decimals')).length;
  return { reports_without_exact_order: order, reports_without_exact_values: values };
}

// ---- one project, for Second opinion (GET /api/explorer/compare) -------------

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IDS_PER_QUERY = 100;

// Every report of one project and every category grade of those reports,
// for the comparison panel. Read-only. Three queries, each paged until the
// database's own count is reached (restAll): its reports; the project row;
// the category scores whose report_id is one of those reports (the join,
// done by report ID; never a request per category). Nothing is computed or
// written here: the page compares (public/compare-model.js).
async function compareData(ws, projectId, { env = process.env, now = Date.now } = {}) {
  if (!PROJECT_ID_RE.test(String(projectId || ''))) throw new ExplorerError('BAD_ID', 'Not a project ID.');
  const cfg = resolve(ws, env);
  const base = { state: cfg.state, configured: cfg.state === 'configured', checked_at: new Date(now()).toISOString(), project_id: projectId };
  if (cfg.state === 'off') return { ...base, reason: 'The Research Explorer is switched off on this desk.', reports: [] };
  if (cfg.state === 'not_configured') return { ...base, reason: cfg.problems[0] || `Missing ${cfg.missing.map((m) => m.replace(/ \(.*$/, '')).join(' and ')}.`, reports: [] };
  try {
    const id = encodeURIComponent(projectId);
    // The reports, then the project and the grades, all between two readings
    // of the consistency marker (consistentRead), as read() does.
    const { value: got, marker } = await consistentRead(cfg, async () => {
      const reports = await restAll(cfg, `/reports?project_id=eq.${id}&select=${REPORT_COLUMNS.join(',')}&order=saved_at.desc,report_id.asc`, byReport);
      const projects = await restAll(cfg, `/projects?project_id=eq.${id}&select=${PROJECT_COLUMNS.join(',')}&order=project_id.asc`, byProject);
      const scores = { rows: [], total: 0, pages: 0 };
      const ids = reports.rows.map((r) => r.report_id);
      for (let i = 0; i < ids.length; i += IDS_PER_QUERY) {
        const list = ids.slice(i, i + IDS_PER_QUERY).map((x) => `"${x}"`).join(',');
        const part = await restAll(cfg, `/category_scores?report_id=in.(${encodeURIComponent(list)})&select=report_id,${SCORE_COLUMNS.join(',')}&order=report_id.asc,category_id.asc`, byScore);
        scores.rows.push(...part.rows);
        scores.total += part.total;
        scores.pages += part.pages;
      }
      return { reports, projects, scores };
    });
    const { reports, projects, scores } = got;
    const project = projects.rows[0] || null;
    if (!project) return { ...base, state: 'not_found', reason: `No project "${projectId}" in the Explorer.`, reports: [] };
    const gradesOf = new Map();
    for (const s of scores.rows) {
      if (!gradesOf.has(s.report_id)) gradesOf.set(s.report_id, []);
      gradesOf.get(s.report_id).push(s);
    }
    const list = reports.rows.map((r) => shapeReport({ ...r, category_scores: gradesOf.get(r.report_id) || [] }));
    return {
      ...base,
      state: 'ok',
      served: 'supabase',
      fetched_at: new Date(now()).toISOString(),
      demo: project.dataset === 'demo',
      project,
      reports: list,
      totals: { reports: reports.total, category_scores: scores.total },
      pages: { projects: projects.pages, reports: reports.pages, category_scores: scores.pages },
      marker,
      legacy: legacyOf(list),
    };
  } catch (err) {
    const reason = err instanceof ExplorerError ? err.message : `The comparison could not be read: ${scrub(err.message, cfg._key)}`;
    return { ...base, state: err instanceof ExplorerError && err.code === 'UPDATING' ? 'updating' : 'unavailable', reason, reports: [] };
  }
}

// ---- exporting (CLI only) ---------------------------------------------------

function fixtureBatch(ws) {
  return adapter.buildBatch(ws, adapter.loadFixtures(), { dataset: 'demo', source: adapter.FIXTURE_REL });
}

// Sends the FICTIONAL fixture records. Repeatable: identical reports come back
// "unchanged", nothing is duplicated, and a timeout after Supabase committed
// is settled by running it again.
// completeExisting: also fill, once, the schema-2 order and exact values of
// fixture reports stored before 2026-10-07, from these same records; the
// database does it only for a report whose content hash matches and whose
// values agree with what it stores (explorer_import). An explicit step,
// never a side effect of an ordinary export.
async function exportFixtures(ws, { dryRun = false, completeExisting = false, env = process.env } = {}) {
  const { batch, skipped } = fixtureBatch(ws);
  if (completeExisting) batch.complete_existing = true;
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
    // Schema 2: reports whose order and exact values were filled now, or are
    // still missing (stored before 2026-10-07; complete_existing fills them).
    metadata: out.metadata || null,
    complete_existing: Boolean(completeExisting),
    scores_inserted: out.scores_inserted,
    results: out.results,
    skipped,
    sent: counts,
  };
}

// The desk's real records, all projects at once. Prepared (explorer-adapter.js
// deskSources) and deliberately not enabled: copying real research to
// Supabase is Eric's decision, made in a later version.
function exportDesk() {
  throw new ExplorerError('REFUSED', 'Exporting all real desk records to the Explorer is prepared but not enabled. Preview one project with: explorer export --project <id> --dry-run');
}

const sha256 = (text) => require('crypto').createHash('sha256').update(text, 'utf8').digest('hex');

// One real project, the canary. --dry-run reads its records through the same
// adapter and returns the exact request body explorer_import would receive,
// with the SHA-256 of that body and of each report row: no key is read, no
// network call is made and nothing is written. Sending stays refused until
// Eric enables real-record export.
function exportProject(ws, projectId, { dryRun = false } = {}) {
  if (!dryRun) {
    throw new ExplorerError('REFUSED', `Sending real desk records to the Explorer is not enabled. Nothing was sent. Preview exactly what would be sent with: explorer export --project ${String(projectId).slice(0, 80)} --dry-run`);
  }
  const { batch, skipped } = adapter.buildBatch(ws, adapter.deskSourceFor(ws, projectId), { dataset: 'desk', source: `desk:projects/${projectId}` });
  const body = JSON.stringify({ batch });
  return {
    status: 'dry_run',
    dataset: 'desk',
    project_id: projectId,
    sent: false,
    network: 'none',
    request: { method: 'POST', path: '/rest/v1/rpc/explorer_import', body_bytes: Buffer.byteLength(body, 'utf8'), body_sha256: sha256(body) },
    projects: batch.projects.length,
    reports: batch.reports.length,
    category_scores: batch.reports.reduce((n, r) => n + r.category_scores.length, 0),
    hashes: batch.reports.map((r) => ({ report_id: r.report_id, model: r.model, saved_at: r.saved_at, category_scores: r.category_scores.length, row_sha256: sha256(JSON.stringify(r)) })),
    hash_note: 'SHA-256 of the exact JSON this desk would send (the request body, and each report row as sent). Supabase computes its own content hash from the values it stores, so its content_sha256 differs; the same payload sent twice comes back "unchanged" there.',
    skipped,
    batch,
  };
}

function resetMemory() {
  memory = null;
}

module.exports = { ExplorerError, keyKind, resolve, status, navInfo, read, compareData, shapeReport, orderKey, exportFixtures, exportDesk, exportProject, fixtureBatch, resetMemory, STALE_DAYS, URL_RE };
