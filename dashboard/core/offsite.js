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
// The desk's note of the last package it handed out (it cannot see the copy).
const SERVED_REL = 'logs/offsite-served.json';
// A verified copy older than this is reported as overdue.
const COPY_FRESH_HOURS = 36;

// ---------------------------------------------------------------------------
// Desk side: GET /api/offsite/package with "Authorization: Bearer <key>".

const keyHash = (k) => crypto.createHash('sha256').update(String(k), 'utf8').digest();

function deskKey(env = process.env) {
  const k = env.CR_BACKUP_KEY;
  return typeof k === 'string' && k.length >= MIN_KEY_CHARS ? k : null;
}

// Why the desk's key is not usable, in words that never carry it: absent, or
// set but too short (its length only).
function deskKeyProblem(env = process.env) {
  const k = env.CR_BACKUP_KEY;
  if (deskKey(env)) return null;
  return typeof k === 'string' && k.length ? `CR_BACKUP_KEY on the desk is ${k.length} characters; it needs at least ${MIN_KEY_CHARS}` : 'no CR_BACKUP_KEY on the desk';
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
    // A note of what was handed out, for this desk's backup status. Whether
    // the PC verified and kept it is known only on the PC.
    try {
      const { withLock, replaceFile } = require('./ops');
      withLock(ws, 'offsite_served', () => replaceFile(ws, ws.abs(SERVED_REL), jsonText({ schema_version: 'cr.offsite-served.v1', served_at: pkg.desk.served_at, files: pkg.inventory.files, bytes: pkg.inventory.bytes, desk_revision: pkg.desk.revision ? pkg.desk.revision.short || null : null })));
    } catch (_) { /* a status note only; the package was served */ }
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

async function pull(ws, { to = null, deskUrl = null, env = process.env, fetchImpl = fetch, timeoutMs = 120000, trigger = 'manual' } = {}) {
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
    // Who pulled it: the scheduled task, the dashboard or a command.
    trigger: String(trigger || 'manual').slice(0, 40),
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

// ---------------------------------------------------------------------------
// The recovery drill (review of fa05f99, 2026-10-05). From an offsite copy
// this PC pulled (the latest in the index, or the file named): verify it,
// restore it into a new folder of its own (never over live records), check
// the restored records, originals and research state, and show that nothing
// can be sent from it: the restored copy holds research, and its runner is
// asked once with a stand-in for the network that refuses and counts every
// call. Nothing here contacts the desk or a model provider. The result is
// kept in the offsite folder's DRILLS file.
const DRILLS_NAME = 'OFFSITE-DRILLS.json';

// Research jobs in a restored copy, by what the runner would do with them
// once released (never before): an unsent job would be sent; a request the
// provider accepted is collected by its ID, never sent again; an uncertain
// attempt waits for Eric; a job held by an archived project or a model on
// hold stays unsent; an answer quarantined against its run stays kept and
// ungraded.
function researchStates(ws2) {
  const research = require('./research');
  const { listProjects } = require('./projects');
  const held = research.heldProviders(ws2);
  const out = { unsent: 0, held_unsent: 0, sent_collect_by_id: 0, uncertain: 0, with_assistant: 0, waiting_manual: 0, completed: 0, failed: 0, quarantined: 0, other: 0 };
  for (const p of listProjects(ws2).filter((x) => !x.broken)) {
    for (const run of research.listRuns(ws2, p.project_id).filter((r) => !r.broken)) {
      for (const job of Object.values(run.jobs || {})) {
        const last = (job.attempts || [])[(job.attempts || []).length - 1] || null;
        if (job.state === 'queued') out[job.hold || held[job.provider] ? 'held_unsent' : 'unsent'] += 1;
        else if (job.state === 'dispatching') out.sent_collect_by_id += 1;
        else if (job.state === 'uncertain') out.uncertain += 1;
        else if (job.state === 'running') out.with_assistant += 1;
        else if (job.state === 'unconfigured') out.waiting_manual += 1;
        else if (job.state === 'completed') out.completed += 1;
        else if (job.state === 'failed' && (job.outcome === 'contract_conflict' || (last && last.outcome === 'contract_conflict'))) out.quarantined += 1;
        else if (job.state === 'failed') out.failed += 1;
        else out.other += 1;
      }
    }
  }
  return out;
}

async function drill(ws, { file = null, to = null, folder = null } = {}) {
  const { OpError } = require('./ops');
  const dir = folderOf(ws, folder);
  const idx = readIndex(dir);
  const name = file ? path.resolve(file) : (idx.copies || [])[0] ? path.join(dir, idx.copies[0].file) : null;
  if (!name || !fs.existsSync(name)) {
    throw new OpError('NOT_FOUND', file ? `${file} does not exist.` : `No offsite copy on this PC yet in ${dir}. Pull one first (node dashboard/cli.js offsite pull); it needs the desk address and the backup key (offsite status says which is missing).`);
  }
  const buf = fs.readFileSync(name);
  const fileSha = sha256(buf);
  const listed = (idx.copies || []).find((c) => c.file === path.basename(name)) || null;
  let pkg;
  try {
    pkg = JSON.parse(buf.toString('utf8'));
  } catch (err) {
    throw new OpError('INVALID', `${path.basename(name)} is not JSON: ${err.message}`);
  }
  const v = verifyPackage(pkg);
  const record = {
    schema_version: 'cr.offsite-drill.v1',
    at: new Date().toISOString(),
    copy: { file: path.basename(name), sha256: fileSha, matches_index: listed ? listed.sha256 === fileSha : null, pulled_at: listed ? listed.pulled_at : null, package_created_at: pkg.created_at || null, served_at: pkg.desk ? pkg.desk.served_at || null : null, desk_revision: pkg.desk && pkg.desk.revision ? pkg.desk.revision.short || null : null, files: v.files || 0, captures: v.captures || 0 },
    verify: { ok: v.ok, problems: v.problems || [] },
  };
  if (!v.ok) return finishDrill(dir, { ...record, passed: false, message: `The copy did not verify, so it was not restored: ${v.problems.join('; ')}.` });
  // A new folder of its own: never the live workspace or anything inside it.
  const dest = path.resolve(to || path.join(require('os').tmpdir(), `cryptoresearch-drill-${fileTs()}`));
  const live = path.resolve(ws.root);
  if (dest === live || dest.toLowerCase().startsWith(`${live.toLowerCase()}${path.sep}`)) throw new OpError('INVALID', 'Restore the drill into a folder outside the live workspace.');
  if (fs.existsSync(dest) && listDir(dest).length) throw new OpError('INVALID', `${dest} is not empty; the drill restores only into a new or empty folder.`);
  const restored = require('./exporter').restorePackage(pkg, dest);
  const ws2 = require('./workspace').openWorkspace({ root: dest, actor: 'drill', recover: false });
  // Every original as it was saved: its bytes against the hash on its record.
  const { listProjects } = require('./projects');
  const { loadReports } = require('./reports');
  let originals = 0;
  const changed = [];
  for (const p of listProjects(ws2).filter((x) => !x.broken)) {
    for (const r of loadReports(ws2, p.project_id)) {
      if (r.broken || !r.meta || !r.meta.original_sha256) continue;
      originals += 1;
      let sha = null;
      try { sha = sha256(fs.readFileSync(ws2.abs(`${r.dir}/${r.meta.original_file}`))); } catch (_) { /* missing */ }
      if (sha !== r.meta.original_sha256) changed.push(r.report_id);
    }
  }
  const states = researchStates(ws2);
  // The runner, once, with a stand-in for the network that refuses and
  // counts: the restored copy holds research, so it asks for nothing.
  const calls = [];
  const refuse = async (url, opts = {}) => { calls.push(`${opts.method || 'GET'} ${String(url).replace(/\?.*$/, '')}`); throw new Error('drill: no network'); };
  const run = await require('./research').runDueJobs(ws2, { trigger: 'drill', fetchImpl: refuse });
  // Tracked wallets are held too: the copy asks Moralis for nothing.
  const walletRun = await require('./walletsync').refresh(ws2, { trigger: 'drill', force: true, fetchImpl: refuse });
  const passed = restored.status === 'restored_and_verified' && !changed.length && !calls.length && run.status === 'held' && walletRun.status === 'held';
  return finishDrill(dir, {
    ...record,
    restore: { dest, status: restored.status, reconciliation: restored.reconciliation, research_held: Boolean(restored.restored_copy && restored.restored_copy.research_held) },
    records: { projects: listProjects(ws2).filter((x) => !x.broken).length, reports_checked: originals, originals_changed: changed },
    research: states,
    provider_calls: calls.length,
    runner: run.status,
    wallet_sync: walletRun.status,
    passed,
    message: passed
      ? `Drill passed: ${path.basename(name)} verified (${v.files} files), restored into ${dest} with every file and record total matching, ${originals} original report(s) byte for byte, and no provider asked for anything (${states.unsent} unsent, ${states.sent_collect_by_id} sent, ${states.uncertain} uncertain and ${states.quarantined} quarantined job(s) restored as they were).`
      : `Drill did not pass: ${[restored.status !== 'restored_and_verified' ? `restore ${restored.status}` : null, changed.length ? `${changed.length} original(s) changed` : null, calls.length ? `${calls.length} provider call(s)` : null, run.status !== 'held' ? 'research was not held' : null, walletRun.status !== 'held' ? 'wallet sync was not held' : null].filter(Boolean).join('; ')}.`,
  });
}

function finishDrill(dir, rec) {
  mkdirp(dir);
  const file = path.join(dir, DRILLS_NAME);
  const doc = readJson(file, null) || { schema_version: 'cr.offsite-drills.v1', drills: [] };
  doc.drills = [rec, ...(doc.drills || [])].slice(0, 100);
  writeDurable(file, jsonText(doc));
  return { status: rec.passed ? 'passed' : 'failed', ...rec, drills_file: file };
}

// The latest copy and its age, for doctor, Settings and desk checks.
function status(ws, env = process.env) {
  const r = readiness(ws, env);
  const idx = readIndex(r.folder);
  const last = (idx.copies || [])[0] || null;
  const ageHours = last ? Math.round((Date.now() - Date.parse(last.pulled_at)) / 3600000) : null;
  return { ...r, last, age_hours: ageHours, copies: (idx.copies || []).length };
}

// Backup status in three separate parts, never one "backed up":
//   same_disk         sealed snapshots on this machine's own disk: they undo
//                     mistakes, they do not survive losing this disk
//   offsite           whether copies can leave this disk: on the desk, its
//                     backup key; on the PC, the desk address and the key
//   independent_copy  a copy on another machine whose every file was checked:
//                     on the PC, the latest verified pull; the desk cannot see
//                     it and says so (it notes only when it last served one)
// level names the strongest protection that exists now.
function backupStatus(ws, env = process.env, now = Date.now()) {
  const hosted = Boolean(ws.hosted);
  const snaps = require('./exporter').listBackups(ws);
  const sealed = snaps.filter((b) => b.sealed);
  const latest = sealed[0] || null;
  const hoursAgo = (iso) => (iso && Number.isFinite(Date.parse(iso)) ? Math.max(0, Math.round((now - Date.parse(iso)) / 3600000)) : null);
  const sameDisk = {
    present: Boolean(latest),
    latest: latest ? { name: latest.name, created_at: latest.created_at, hours_ago: hoursAgo(latest.created_at), files: latest.files } : null,
    count: sealed.length,
    where: hosted ? 'the desk\'s own disk' : 'this PC\'s disk',
    note: 'Sealed snapshots on the same disk undo mistakes; they do not survive losing that disk.',
  };
  let offsiteSupport;
  let copy;
  if (hosted) {
    const served = readJson(ws.abs(SERVED_REL), null);
    offsiteSupport = {
      configured: Boolean(deskKey(env)),
      role: 'serves',
      last_served: served && served.served_at ? { at: served.served_at, hours_ago: hoursAgo(served.served_at), files: served.files || null } : null,
      missing: deskKey(env) ? [] : [deskKeyProblem(env) === 'no CR_BACKUP_KEY on the desk' ? `CR_BACKUP_KEY (at least ${MIN_KEY_CHARS} characters) in Render's environment, entered by Eric` : `a longer CR_BACKUP_KEY in Render's environment (${deskKeyProblem(env)})`],
    };
    copy = { verified: null, known_here: false, note: 'This desk cannot see copies kept elsewhere. Your PC checks every file of each copy it pulls; its Settings and "offsite status" show the latest verified copy.' };
  } else {
    const st = status(ws, env);
    offsiteSupport = { configured: st.configured, role: 'pulls', desk_url: st.desk_url, folder: st.folder, missing: st.missing };
    const last = st.last;
    copy = {
      verified: Boolean(last),
      known_here: true,
      latest: last ? { file: last.file, pulled_at: last.pulled_at, hours_ago: st.age_hours, files: last.files, captures: last.captures || 0, trigger: last.trigger || null, records: last.records || null } : null,
      copies: st.copies,
      overdue: Boolean(last) && st.age_hours > COPY_FRESH_HOURS,
      folder: st.folder,
    };
  }
  const level = copy.verified ? 'independent_copy' : offsiteSupport.configured ? 'offsite_set_up' : sameDisk.present ? 'same_disk_only' : 'none';
  const parts = [
    sameDisk.present ? `Same-disk snapshots: latest ${sameDisk.latest.name}, ${sameDisk.latest.hours_ago} h ago, on ${sameDisk.where} (undoes mistakes; does not survive losing that disk).` : `Same-disk snapshots: none yet on ${sameDisk.where}.`,
    hosted
      ? (offsiteSupport.configured ? `Offsite copies: set up (the backup key is set), so your PC can pull verified copies${offsiteSupport.last_served ? `; this desk last served one ${offsiteSupport.last_served.hours_ago} h ago` : '; none served yet'}.` : `Offsite copies: not set up (${deskKeyProblem(env)}), so these records exist only on this disk and in Render's own disk snapshots.`)
      : (offsiteSupport.configured ? 'Offsite copies: set up on this PC (desk address and backup key present).' : `Offsite copies: not set up on this PC (missing ${offsiteSupport.missing.join('; ')}).`),
    hosted
      ? 'Verified independent copy: not visible from the desk; the PC that pulls copies shows it.'
      : copy.verified ? `Verified independent copy: ${copy.latest.file}, pulled ${copy.latest.hours_ago} h ago${copy.latest.trigger ? ` (${copy.latest.trigger})` : ''}, every file checked against its hash${copy.overdue ? `; overdue (older than ${COPY_FRESH_HOURS} h)` : ''}.` : 'Verified independent copy: none yet.',
  ];
  return { hosted, level, same_disk: sameDisk, offsite: offsiteSupport, independent_copy: copy, summary: parts.join(' ') };
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

module.exports = { makeOffsiteRoute, verifyPackage, pull, drill, researchStates, status, backupStatus, readiness, verifyFile, prune, deskKey, deskKeyProblem, CR_ALLOWED, MIN_KEY_CHARS, COPY_FRESH_HOURS };
