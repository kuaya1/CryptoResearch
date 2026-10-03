'use strict';
// Offsite copies of the online desk's records (independent review,
// 2026-10-03). The desk keeps its records on its Render disk; a copy that
// lives only there is not offsite. This PC pulls a complete package from the
// desk once a day (or when asked), verifies every file against its hash, and
// keeps dated copies in a folder Eric chooses (default backups/offsite in
// this workspace; a cloud-synced folder gives a second copy off this PC).
//
// Access: a backup key of its own, CR_BACKUP_KEY in Render's environment and
// the same value on this PC (CR_BACKUP_KEY, or "desk_backup_key" in
// ~/.cryptoresearch/secrets.json, outside the workspace). It only downloads
// the package: it is not the sign-in passphrase, it cannot change anything,
// and it is never in a URL, a log, Git or an export. Eric creates it; it is
// never asked for in a chat.
//
// The package (exporter.exportPackage) carries the records plus .cr/captures
// (paid answers and background request IDs not yet committed), so a restore
// collects a submitted request by its ID instead of sending it again. Restore:
//   node dashboard/cli.js restore-package <file> --to <empty folder>
// verifies every file and reconciles the record totals. Putting records back
// onto the online desk is Eric's decision; nothing here writes to the desk.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJson, jsonText, sha256, mkdirp, writeDurable, listDir } = require('./fsx');
const { fileTs } = require('./ids');

const MIN_KEY_CHARS = 32;
const FILE_RE = /^cryptoresearch-desk-(\d{4}-\d{2}-\d{2}T[\dZ-]+)\.json$/;
const INDEX_NAME = 'OFFSITE-INDEX.json';
const LOCK_FAILURES = 10;
const LOCK_WINDOW_MS = 15 * 60000;

// ---------------------------------------------------------------------------
// Desk side: GET /api/offsite/package with "Authorization: Bearer <key>".

const keyHash = (k) => crypto.createHash('sha256').update(String(k), 'utf8').digest();

function deskKey(env = process.env) {
  const k = env.CR_BACKUP_KEY;
  return typeof k === 'string' && k.length >= MIN_KEY_CHARS ? k : null;
}

function makeOffsiteRoute(ws, { env = process.env, log = () => {}, now = () => Date.now() } = {}) {
  const failures = [];
  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  return function handle(req, res) {
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
    const key = deskKey(env);
    if (!key) return send(res, 404, { error: `Offsite backup is not set up on this desk: CR_BACKUP_KEY (at least ${MIN_KEY_CHARS} characters) is not in its environment.`, code: 'NOT_SET_UP' });
    const t = now();
    while (failures.length && t - failures[0] > LOCK_WINDOW_MS) failures.shift();
    if (failures.length >= LOCK_FAILURES) return send(res, 429, { error: 'Too many refused backup keys; try again in 15 minutes.', code: 'LOCKED' });
    const m = String(req.headers.authorization || '').match(/^Bearer (\S+)$/);
    if (!m || !crypto.timingSafeEqual(keyHash(m[1]), keyHash(key))) {
      failures.push(t);
      log('Offsite package refused: wrong or missing backup key.');
      return send(res, 401, { error: 'The backup key was refused.', code: 'REFUSED' });
    }
    const pkg = require('./exporter').exportPackage(ws);
    pkg.desk = { revision: require('./revision').revision(), served_at: new Date().toISOString() };
    log(`Offsite package served: ${pkg.inventory.files} files, ${pkg.inventory.bytes} bytes${pkg.consistency && pkg.consistency.verified === false ? ' (an earlier save was not verified)' : ''}.`);
    return send(res, 200, pkg);
  };
}

// ---------------------------------------------------------------------------
// Verifying a package (used on the PC before anything is kept, and by restore).

// .cr paths a package may carry: capture files and the repairs ledger, never
// sign-in, connection or lock files.
const CR_ALLOWED = /^\.cr\/(captures\/(?!\.)[A-Za-z0-9_.-]+\.json|repairs\.json)$/;

function verifyPackage(pkg) {
  const problems = [];
  if (!pkg || pkg.schema_version !== 'cr.package.v1' || !Array.isArray(pkg.files)) return { ok: false, problems: ['not a CryptoResearch complete package (cr.package.v1)'] };
  const { checkRestoreInventory } = require('./workspace');
  const inv = checkRestoreInventory(pkg.files);
  if (!inv.ok) problems.push(`${inv.rejected.length} unsafe or conflicting path(s), first "${inv.rejected[0].path}": ${inv.rejected[0].error}`);
  let bytes = 0;
  let captures = 0;
  for (const f of pkg.files) {
    if (!f || typeof f.path !== 'string') continue;
    if (/^\.cr(\/|$)/.test(f.path) && !CR_ALLOWED.test(f.path)) problems.push(`"${f.path}" is not a file a package may carry`);
    if (CR_ALLOWED.test(f.path) && f.path.startsWith('.cr/captures/')) captures += 1;
    if (!['utf8', 'base64'].includes(f.encoding) || typeof f.content !== 'string' || typeof f.sha256 !== 'string') {
      problems.push(`"${f.path}" is malformed (encoding, content or hash missing)`);
      continue;
    }
    const buf = f.encoding === 'base64' ? Buffer.from(f.content, 'base64') : Buffer.from(f.content, 'utf8');
    bytes += buf.length;
    if (sha256(buf) !== f.sha256) problems.push(`"${f.path}" does not match its hash`);
  }
  if (pkg.inventory && typeof pkg.inventory.files === 'number' && pkg.inventory.files !== pkg.files.length) problems.push(`the inventory lists ${pkg.inventory.files} files but the package has ${pkg.files.length}`);
  return { ok: problems.length === 0, problems: problems.slice(0, 20), files: pkg.files.length, bytes, captures, summary: pkg.summary || null };
}

// ---------------------------------------------------------------------------
// PC side: pull, keep, prune, report.

function settingsOf(ws) {
  const o = (ws.settings && ws.settings.offsite) || {};
  return {
    desk_url: typeof o.desk_url === 'string' && o.desk_url ? o.desk_url.replace(/\/+$/, '') : null,
    folder: typeof o.folder === 'string' && o.folder ? o.folder : null,
    keep_recent: Number.isInteger(o.keep_recent) && o.keep_recent > 0 ? o.keep_recent : 30,
    keep_monthly: Number.isInteger(o.keep_monthly) && o.keep_monthly >= 0 ? o.keep_monthly : 12,
  };
}

function folderOf(ws, to = null) {
  return path.resolve(to || settingsOf(ws).folder || ws.abs('backups/offsite'));
}

function pcKey(env = process.env) {
  if (typeof env.CR_BACKUP_KEY === 'string' && env.CR_BACKUP_KEY.length >= MIN_KEY_CHARS) return { key: env.CR_BACKUP_KEY, source: 'environment variable CR_BACKUP_KEY' };
  const file = require('./providers').secretsFile();
  const s = readJson(file, {}) || {};
  if (typeof s.desk_backup_key === 'string' && s.desk_backup_key.length >= MIN_KEY_CHARS) return { key: s.desk_backup_key, source: `${file} (desk_backup_key)` };
  return { key: null, source: null, how: `Put "desk_backup_key" in ${file} or set CR_BACKUP_KEY (the same value as CR_BACKUP_KEY on the desk, at least ${MIN_KEY_CHARS} characters).` };
}

// What is set up, and what is missing, in words Eric can act on.
function readiness(ws, env = process.env) {
  const s = settingsOf(ws);
  const k = pcKey(env);
  const missing = [];
  if (!s.desk_url) missing.push('the desk address (node dashboard/cli.js offsite setup --desk https://<your desk>)');
  if (!k.key) missing.push(`the backup key on this PC (${k.how})`);
  return { configured: !missing.length, desk_url: s.desk_url, folder: folderOf(ws), key_source: k.source, missing, keep_recent: s.keep_recent, keep_monthly: s.keep_monthly };
}

function readIndex(folder) {
  return readJson(path.join(folder, INDEX_NAME), null) || { schema_version: 'cr.offsite-index.v1', copies: [] };
}

// Keeps the newest keep_recent copies plus the newest of each of the last
// keep_monthly months; removes only files this module named.
function prune(folder, { keepRecent = 30, keepMonthly = 12 } = {}) {
  const all = listDir(folder, { dirs: false }).filter((n) => FILE_RE.test(n)).sort().reverse();
  const keep = new Set(all.slice(0, keepRecent));
  const months = new Map();
  for (const n of all) {
    const m = n.match(FILE_RE)[1].slice(0, 7);
    if (!months.has(m)) months.set(m, n);
  }
  [...months.values()].slice(0, keepMonthly).forEach((n) => keep.add(n));
  const removed = [];
  for (const n of all) {
    if (keep.has(n)) continue;
    try {
      fs.unlinkSync(path.join(folder, n));
      removed.push(n);
    } catch (_) { /* kept */ }
  }
  return removed;
}

async function pull(ws, { to = null, deskUrl = null, env = process.env, fetchImpl = fetch, timeoutMs = 120000 } = {}) {
  const s = settingsOf(ws);
  const base = (deskUrl || s.desk_url || '').replace(/\/+$/, '');
  const k = pcKey(env);
  if (!base || !k.key) {
    const r = readiness(ws, env);
    return { status: 'not_set_up', message: `Offsite backup is not set up on this PC: missing ${r.missing.join('; ')}.`, missing: r.missing };
  }
  let u;
  try {
    u = new URL(`${base}/api/offsite/package`);
  } catch (_) {
    return { status: 'failed', message: `The desk address "${base}" is not a URL.` };
  }
  if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return { status: 'failed', message: 'The desk address must use https.' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  let text;
  try {
    res = await fetchImpl(u.href, { method: 'GET', headers: { authorization: `Bearer ${k.key}`, accept: 'application/json' }, signal: ctrl.signal, redirect: 'error' });
    text = await res.text();
  } catch (err) {
    return { status: 'failed', message: `Could not reach the desk: ${err.name === 'AbortError' ? 'timed out' : err.message}.` };
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  try { body = JSON.parse(text); } catch (_) { body = null; }
  if (res.status === 404) return { status: 'failed', message: (body && body.error) || 'The desk has no offsite backup route (an older deploy, or CR_BACKUP_KEY is not set there).' };
  if (res.status === 401) return { status: 'failed', message: 'The desk refused the backup key: the value on this PC differs from CR_BACKUP_KEY on the desk.' };
  if (res.status === 429) return { status: 'failed', message: 'The desk is refusing backup keys for 15 minutes after too many wrong ones.' };
  if (res.status !== 200 || !body) return { status: 'failed', message: `The desk answered HTTP ${res.status}.` };
  const v = verifyPackage(body);
  if (!v.ok) return { status: 'failed', message: `The package did not verify, so nothing was kept: ${v.problems.join('; ')}.` };
  const folder = folderOf(ws, to);
  mkdirp(folder);
  const name = `cryptoresearch-desk-${fileTs()}.json`;
  const dest = path.join(folder, name);
  const bytes = Buffer.from(text, 'utf8');
  writeDurable(dest, bytes);
  const fileSha = sha256(fs.readFileSync(dest));
  if (fileSha !== sha256(bytes)) return { status: 'failed', message: `${dest} did not read back as written; it is left for inspection.` };
  const entry = {
    file: name,
    pulled_at: new Date().toISOString(),
    package_created_at: body.created_at || null,
    desk_revision: body.desk && body.desk.revision ? body.desk.revision.short || null : null,
    files: v.files,
    captures: v.captures,
    bytes: bytes.length,
    sha256: fileSha,
    records: v.summary ? { projects: v.summary.projects, reports: (v.summary.reports || []).length, transactions: v.summary.transactions } : null,
    records_verified_on_desk: body.consistency ? body.consistency.verified !== false : null,
  };
  const removed = prune(folder, { keepRecent: s.keep_recent, keepMonthly: s.keep_monthly });
  const idx = readIndex(folder);
  idx.copies = [entry, ...(idx.copies || []).filter((c) => c.file !== name && !removed.includes(c.file))].slice(0, 400);
  idx.updated_at = entry.pulled_at;
  writeDurable(path.join(folder, INDEX_NAME), jsonText(idx));
  return {
    status: 'ok',
    message: `Saved ${name}: ${v.files} files (${entry.records ? `${entry.records.projects} projects, ${entry.records.reports} reports, ${entry.records.transactions} transactions` : 'records'}${v.captures ? `, ${v.captures} capture(s)` : ''}), every file verified${removed.length ? `; ${removed.length} older copy(ies) pruned` : ''}.`,
    file: dest,
    entry,
    pruned: removed,
    restore: `node dashboard/cli.js restore-package "${dest}" --to <empty folder>`,
  };
}

// The latest copy and its age, for doctor, Settings and desk checks.
function status(ws, env = process.env) {
  const r = readiness(ws, env);
  const idx = readIndex(r.folder);
  const last = (idx.copies || [])[0] || null;
  const ageHours = last ? Math.round((Date.now() - Date.parse(last.pulled_at)) / 3600000) : null;
  return { ...r, last, age_hours: ageHours, copies: (idx.copies || []).length };
}

// Re-checks one saved copy file by file.
function verifyFile(file) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { ok: false, problems: [`cannot read ${file}: ${err.message}`] };
  }
  return verifyPackage(pkg);
}

module.exports = { makeOffsiteRoute, verifyPackage, pull, status, readiness, verifyFile, prune, deskKey, CR_ALLOWED, MIN_KEY_CHARS };
