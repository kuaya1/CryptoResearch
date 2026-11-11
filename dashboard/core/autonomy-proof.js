'use strict';
// Readbacks only. Do not openWorkspace(): its default recovery can write.
// No pilot, task script, job, trader or credential helper is invoked.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { safeRestoreRel, DEFAULT_ROOT } = require('./workspace');
const { isProjectId } = require('./ids');
const { readBodyBounded } = require('./netguard');
// Pure record checks only (no workspace, file, network or process): the
// opening receipt's own definition of a whole record, and the exact
// rationals and base units the contract guard computes with.
const OR = require('./opening-receipt');
const G = require('./contract-gate');

const FORMAT = 'cr-autonomy-proof@1';
const ROOT = path.resolve(__dirname, '../..');
const BLUEPRINT = 'docs/engineering/AUTONOMY_COMPLETION_BLUEPRINT_2026-11-03.md';
const READINESS = 'docs/engineering/BOUNDED_PAPER_READINESS.md';
const OPS1 = 'docs/engineering/OPS1_RENDER_CRON.md';
const R0_RECEIPT = 'docs/engineering/OPERATING_PROOF_R0_2026-11-03.md';
const HEALTHZ = 'https://cryptoresearch.onrender.com/healthz';
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const MAX_FILE = 8 * 1024 * 1024;
const MAX_BUNDLE_FILES = 64;
const HOUR_MS = 3600000;
// trader-candles: an hour is read only once closed and 10 minutes settled.
const SETTLE_MS = 10 * 60000;
// A receipt's own merge changes only these, so it does not stale its proof.
const DOCS_ONLY = /^(?:docs|audits)\//;
const SECRET_ENV = /TOKEN|SECRET|PASSWORD|PASSPHRASE|PRIVATE|API_KEY|INGEST_KEY|AUTH|HEALTHCHECK_URL|_KEY$/i;
const SECRET_SHAPES = [/gh[pousr]_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /sk-ant-[A-Za-z0-9-]{10,}/, /hc-ping\.com\/[A-Za-z0-9-]{8,}/, /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i];
const FICTION = /\bFICTIONAL\b|\.example\.invalid\b|dashboard[\\/]+fixtures\b|kind: (?:demo|test|fictional)\b/i;
const FIXTURE_WORDS = new Set(['fixture', 'synthetic', 'test', 'demo', 'fictional']);
const STEPS = Object.freeze(['r0', 'b0', 'b1', 'b2', 'b3', 'cutover']);

// Summaries of the merged runbooks, not a new operating policy. A complete
// criterion needs a complete reader; partial observations never discharge it.
const GATES = Object.freeze({
  r0: [
    ['alignment', 'Merged/deployed revision and the clean detached runner agree at the R0 observation.'],
    ['quiet_swap', 'Both PC tasks were quiet during the runner swap; pilot-all was Disabled.'],
    ['registration', 'Dedicated runner registration is Disabled, job_wrapper, unattended, pinned model, max-agents=1, clean checkout and correct working directory.'],
    ['hourly_route', 'Hourly selects merged runner code while CR_WORKSPACE selects the original records; no user-level workspace override.'],
    ['doctor', 'Doctor names the original workspace and verifies write/readback; warnings are recorded.'],
    ['offsite_run', 'After re-enabling Hourly, an actual later offsite job and its new timestamp are read back.'],
  ],
  b0: [
    ['build_deploy', 'PRs 1–4 have green head checks and are merged; /healthz, Render deploy record and dedicated runner match the expected merge revision.'],
    ['quiet_authority', 'Admission is off, pilot-all Disabled, Render cron absent or Suspended, scout unenabled, and hosted work and claims accounted for.'],
    ['dry_run', 'Isolation and the pinned unattended max-agents=1 GET dry run pass; a dirty-runner negative control refuses before polling.'],
    ['heartbeat_config', 'Healthchecks has period 60 min, grace 120 min, alerting Eric only; no dry-run heartbeat or POST sighting is claimed.'],
    ['meters', 'Online CoinGecko, GoPlus, exit-quote and candle meters are valid; no unknown meter or RECONCILE_REQUIRED attempt remains.'],
    ['arming_identity', 'Eric reviewed/applied the exact patch; read back generation, expiry, caps (one grant/day), chains, pause, pilot enrolment, enforce contract observation, approved exit target and stored candidate identity, never held or vetoed.'],
  ],
  b1: [
    ['window', 'Only the authorized candidate ran in a bounded supervised window; pilot-all was disabled afterwards.'],
    ['lineage', 'Recorded project → run/report → ticket receipt → generation/decision → intent → client_order_id and acknowledged buy send time.'],
    ['cancellation', 'Pause or mandate-off occurred before the first causally eligible hour; later authoritative state shows cancelled, no fill and no opening position.'],
    ['progress', 'After that eligible hour closed plus 10 minutes, candles and hosted timer still advance and the control reads done:true.'],
    ['grant_liveness', 'Cancelled grant stays in force, is not reused and counts toward its New York day; first real run records POST Fresh and actual heartbeat start/final delivery.'],
  ],
  b2: [
    ['successor', 'A supported legitimate successor and reviewed rearm respect the cancelled grant and daily cap; no gate or cap is relaxed.'],
    ['lifecycle', 'Authentic research → grade → prosecution → frozen ticket → mandate grant → intent → order; block-pinned contract evidence, complete fresh exits, sizing and candles pass.'],
    ['basis', 'Attribution is not refused; inputs are decision_time, digest verified and every named original hash checked; execution is read through the book, never integrity.'],
    ['execution_stamp', 'Q4=B execution facts remain not_recorded; intervening deploys are evidenced by Render records, never backfilled.'],
    ['fill_risk', 'One real closed-hour causal fill has actual price, fees, position lineage and protective stop recorded; valid-data risk management during pause is observed.'],
    ['closure_status', 'Natural stop/target/expiry/closure is reported separately as observed or pending; no forced fill or synthetic close is substituted.'],
  ],
  b3: [
    ['repeat_restart', 'With nothing newly eligible, the completed invocation is repeated and the local runner restarted and invoked again.'],
    ['idempotency', 'Before/after run, report, receipt, decision, intent, order, fill IDs, sessions and claims show no duplicate effect or extra session charge.'],
    ['uncertainty', 'Uncertain dispatch stays claimed for reconciliation; no release or retry makes the comparison pass.'],
    ['separate_results', 'Cancellation, real fill, risk reduction, closure and restart each have their own verdict; hosted restart is UNVERIFIED unless separately authorized and observed.'],
  ],
  cutover: [
    ['approval', 'B0–B3 prerequisites and explicit owner approval for hosted activation, credentials and recurring cost are recorded.'],
    ['host_installed', 'Service stayed Suspended until cutover; narrow configuration, first preflight, revision match, POST sighting and delivered heartbeat passed.'],
    ['kill_drill', 'With PC Disabled and cron Suspended, cancelled attempt saves/completes nothing after cancellation, keeps its dispatched ID/session count and reaches reconcile; Eric reconciles it.'],
    ['desk_down', 'Linux CI recovery tests and their run ID are recorded; no production runner is pointed at a fake desk.'],
    ['single_runner', 'PC Disabled readback precedes cron Resume; stop/veto, failure visibility, recovery and suspend-first rollback are verified.'],
    ['runner_alive', 'At about 2 h, 6 h and 24 h after cutover, render-ops1 poll is Fresh and Healthchecks has no missed period.'],
    ['lifecycle_proven', 'With PC Disabled, Ops-1 saves a Researcher report and Prosecutor ticket with intact packet, followed by recorded mandate evaluation.'],
    ['fill_proven', 'That hosted lifecycle has a causal paper fill on a real closed hour; a valid no-trade remains pending.'],
    ['closed_outcome_proven', 'That position has a natural fee-bearing closed Trader Sim outcome.'],
  ],
});
const FOLDERS = Object.freeze({ r0: 'R0', b0: 'B0', b1: 'B1', b2: 'B2', b3: 'B3', cutover: 'cutover' });
const NARRATIVES = Object.freeze({ r0: 'R0.txt', b0: 'B0.txt', b1: 'B1.txt', b2: 'B2.txt', b3: 'B3.txt', cutover: 'cutover.txt' });
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const refuse = (code, message) => { throw Object.assign(new Error(message), { code }); };
const validTime = (s) => typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(s)
  && Number.isFinite(Date.parse(s)) && new Date(Date.parse(s)).toISOString().slice(0, 19) === s.slice(0, 19);
function aggregate(results) {
  if (results.includes('FAIL')) return 'FAIL';
  return results.length && results.every((r) => r === 'PASS') ? 'PASS' : 'UNVERIFIED';
}
function absolute(input) {
  if (typeof input !== 'string' || !input || /^[\\/]{2}/.test(input)) refuse('BAD_PATH', 'A local directory path is required.');
  const rel = input.slice(path.parse(input).root.length).replace(/\\/g, '/');
  try { if (rel) safeRestoreRel(rel); } catch (_) { refuse('BAD_PATH', 'Unsafe directory path.'); }
  return path.resolve(input);
}
function within(root, child) {
  const r = path.relative(root, child);
  return r === '' || (!r.startsWith(`..${path.sep}`) && r !== '..' && !path.isAbsolute(r));
}
function noLinks(p, create = false) {
  const parsed = path.parse(p);
  let cur = parsed.root;
  for (const seg of p.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, seg);
    let st;
    try { st = fs.lstatSync(cur); } catch (e) {
      if (e.code !== 'ENOENT' || !create) throw e;
      try { fs.mkdirSync(cur, { mode: 0o700 }); } catch (m) { if (m.code !== 'EEXIST') throw m; }
      st = fs.lstatSync(cur);
    }
    if (st.isSymbolicLink()) refuse('BAD_PATH', 'Symlinks and junctions are refused.');
    if (cur !== p && !st.isDirectory()) refuse('BAD_PATH', 'A path component is not a directory.');
  }
}
function readBounded(root, rel) {
  safeRestoreRel(rel);
  const p = path.join(root, ...rel.split('/'));
  if (!within(root, p)) refuse('BAD_PATH', 'Evidence must stay within its selected root.');
  noLinks(p);
  const fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_FILE) refuse('INVALID', 'Evidence is not a bounded regular file.');
    const bytes = Buffer.alloc(st.size + 1);
    let size = 0;
    for (;;) {
      const n = fs.readSync(fd, bytes, size, bytes.length - size, null);
      size += n;
      if (size > st.size) refuse('INVALID', 'Evidence changed while it was read.');
      if (!n) return bytes.subarray(0, size);
    }
  } finally { fs.closeSync(fd); }
}
// PowerShell captures are often UTF-16; every read of a record comes through here.
function textOf(b) {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return Buffer.from(b.subarray(2)).swap16().toString('utf16le');
  return b.toString('utf8').replace(/^\uFEFF/, '');
}
const jsonOf = (b) => JSON.parse(textOf(b));

// Shell-free Git plumbing only. No token, NODE_OPTIONS, GIT_CONFIG_* injection
// or credential helper is inherited. This is not OS credential isolation.
function gitRevision(root, base, { run = spawnSync, env = process.env } = {}) {
  const childEnv = {};
  for (const key of Object.keys(env)) if (/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|SYSTEMDRIVE|TEMP|TMP)$/i.test(key)) childEnv[key] = env[key];
  Object.assign(childEnv, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : os.devNull, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
  const invoke = (args) => run('git', ['-C', root, ...args], { env: childEnv, encoding: 'utf8', timeout: 10000, maxBuffer: MAX_FILE, windowsHide: true });
  const git = (args, raw = false) => {
    const r = invoke(args);
    return r && !r.error && r.status === 0 ? (raw ? String(r.stdout || '') : String(r.stdout || '').trim()) : null;
  };
  const head = git(['rev-parse', '--verify', 'HEAD']);
  const main = git(['rev-parse', '--verify', 'refs/remotes/origin/main']);
  const status = git(['status', '--porcelain', '--untracked-files=normal']);
  const recorded = base || git(['merge-base', 'HEAD', 'refs/remotes/origin/main']);
  const ancestor = recorded && SHA.test(recorded) ? invoke(['merge-base', '--is-ancestor', recorded, 'HEAD']) : null;
  return { head: SHA.test(head || '') ? head : null, origin_main: SHA.test(main || '') ? main : null, worktree_clean: status === null ? null : status === '',
    base: SHA.test(recorded || '') ? recorded : null,
    base_is_ancestor: ancestor && !ancestor.error && ancestor.status === 0 ? true : ancestor && !ancestor.error && ancestor.status === 1 ? false : null,
    base_source: base ? 'explicit' : 'local_merge_base', committed: (rel) => git(['show', `HEAD:${rel}`], true),
    // Eric's merge is what vouches for a bundle: a merged receipt names its manifest hash.
    anchored: (digest) => { const r = invoke(['grep', '-q', '-F', digest, 'refs/remotes/origin/main', '--', 'docs/engineering']); return Boolean(r && !r.error && r.status === 0); },
    onMain: (rev) => { const r = invoke(['merge-base', '--is-ancestor', rev, 'refs/remotes/origin/main']); return Boolean(r && !r.error && r.status === 0); },
    changedSince: (rev) => { const out = git(['diff', '--name-only', rev, 'HEAD'], true); return out === null ? null : out.split(/\r?\n/).filter(Boolean); } };
}
async function healthRead({ fetchImpl = globalThis.fetch, now = () => new Date().toISOString() } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetchImpl(HEALTHZ, { method: 'GET', redirect: 'error', signal: ctrl.signal, headers: { Accept: 'text/plain' } });
    if (r.status !== 200) return { state: 'unavailable', http_status: r.status, at: now() };
    const body = await readBodyBounded(r, 4096, ctrl);
    const matches = [...body.matchAll(/^revision ([0-9a-f]{40})\b/gm)];
    return { state: matches.length === 1 ? 'observed' : 'unreadable', revision: matches.length === 1 ? matches[0][1] : null, at: now(), sha256: hash(body) };
  } catch (_) { return { state: 'unavailable', at: now() }; }
  finally { clearTimeout(timer); }
}
function addCheck(report, id, criterion, result, reason, sources = [], observation = 'static_configuration', observedAt = null, executed = true) {
  report.checks.push({ id, criterion, result, reason, sources, observation, observed_at: validTime(observedAt) ? observedAt : null, executed });
}
function evidenceFile(report, root, rel, observation) {
  if (!root) return null;
  try {
    const bytes = readBounded(root, rel);
    report.sources.push({ path: rel, sha256: hash(bytes), bytes: bytes.length, observation });
    return bytes;
  } catch (e) {
    const invalid = ['BAD_PATH', 'INVALID', 'ELOOP'].includes(e.code);
    // Original bytes/OS error messages are never copied to output.
    addCheck(report, `file:${rel}`, 'Supplied evidence is accessible, bounded and within its root.', invalid ? 'FAIL' : 'UNVERIFIED', invalid ? 'Unsafe or invalid record refused; nothing repaired.' : 'Record missing or inaccessible; no configuration conclusion is inferred.', [rel], observation);
    return null;
  }
}
function checkR0(report, root, receipt, observation, revision, fixture) {
  const manifestBytes = evidenceFile(report, root, 'R0/manifest.json', observation);
  if (!manifestBytes) return null;
  const pin = /manifest\.json`[\s\S]*?SHA-256 is\s*`([a-f0-9]{64})`/.exec(receipt || '');
  // A repeated R0 has its own receipt: any merged receipt naming its hash anchors it the same way.
  if (!(pin && hash(manifestBytes) === pin[1]) && !(!fixture && revision.anchored(hash(manifestBytes)))) {
    addCheck(report, 'r0:manifest', 'R0 manifest matches its committed receipt.', pin ? 'FAIL' : 'UNVERIFIED', pin ? 'Manifest hash differs from the committed R0 receipt, and no merged receipt names it. A repeated R0 reads once its own receipt is merged.' : 'No committed manifest pin is available.', ['R0/manifest.json', R0_RECEIPT], observation);
    return null;
  }
  let manifest, records;
  try {
    manifest = jsonOf(manifestBytes);
    if (manifest.format !== 'cr-operating-proof-r0-evidence@1' || !SHA.test(manifest.baseline) || !validTime(manifest.closed_at) || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 64) throw new Error();
    records = new Map();
    let total = 0;
    for (const entry of manifest.files) {
      safeRestoreRel(entry.path);
      if (records.has(entry.path) || !HASH.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error();
      const bytes = readBounded(root, `R0/${entry.path}`);
      total += bytes.length;
      if (total > 8 * MAX_FILE || bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error();
      records.set(entry.path, bytes);
    }
    for (const name of ['revision-final.json', 'tasks-final.json', 'pilot-all.final-status.json', 'verification.json']) if (!records.has(name)) throw new Error();
  } catch (_) {
    addCheck(report, 'r0:manifest', 'Every R0 member exists intact; no partial bundle is accepted.', 'FAIL', 'Pinned bundle is incomplete, malformed or has a hash mismatch.', ['R0/manifest.json'], observation);
    return null;
  }
  addCheck(report, 'r0:manifest', 'Every R0 manifest member matches the committed receipt.', 'PASS', 'All pinned bytes verified. This proves preservation, not live origin or completion of R0.', ['R0/manifest.json', R0_RECEIPT], observation, manifest.closed_at);
  report.r0_bundle = { baseline: manifest.baseline, closed_at: manifest.closed_at, manifest_sha256: hash(manifestBytes), verified_members: manifest.files.length };
  try {
    const revision = jsonOf(records.get('revision-final.json'));
    const tasks = jsonOf(records.get('tasks-final.json'));
    const task = jsonOf(records.get('pilot-all.final-status.json'));
    const verify = jsonOf(records.get('verification.json'));
    const c = task.config;
    const facts = [
      ['alignment', revision.healthz_status === 200 && [revision.origin_main, revision.runner_head, revision.deployed_sha].every((s) => s === manifest.baseline) && verify.runner.detached === true && verify.runner.clean === true, revision.observed_at],
      ['quiet_swap', tasks.pilot.state === 'Disabled' && tasks.pilot.enabled === false && tasks.pilot.instances === 0 && tasks.hourly.state === 'Disabled' && tasks.hourly.instances === 0, tasks.observed_at],
      ['registration', task.registered === true && task.ours === true && task.status.task.state === 'Disabled' && c.launcher === 'job_wrapper' && c.max_agents === 1 && c.unattended === true && c.model_named === true && c.checkout_clean === true && c.checkout_head === manifest.baseline && c.working_directory_is_repository === true, null],
    ];
    for (const [id, ok, at] of facts) addCheck(report, `r0:recorded_${id}`, GATES.r0.find((g) => g[0] === id)[1], ok ? 'PASS' : 'FAIL', ok ? 'Committed R0 offline readbacks support this recorded fact; not a current task inspection.' : 'Committed R0 readbacks contradict this condition.', ['R0/manifest.json'], observation, at);
  } catch (_) {
    addCheck(report, 'r0:readbacks', 'R0 readbacks have their complete expected shapes.', 'FAIL', 'A pinned readback is malformed; no reconstruction attempted.', ['R0/manifest.json'], observation);
  }
  // #167 kept Hourly disabled. Summaries, routing stand-ins and tests cannot
  // discharge the actual later offsite run: its gate needs offsite-readback.json.
  return { folder: 'R0', manifest, records, manifest_sha256: hash(manifestBytes), anchored: true };
}
// The same bytes-first rule for every later step: nothing is parsed until the
// manifest's every member matches, and a listed member that changed is a FAIL.
function checkBundle(report, root, step, observation, revision, fixture) {
  const folder = FOLDERS[step];
  const rel = `${folder}/manifest.json`;
  let manifestBytes;
  try { manifestBytes = readBounded(root, rel); } catch (e) {
    if (['BAD_PATH', 'INVALID', 'ELOOP'].includes(e.code)) addCheck(report, `${step}:manifest`, 'The step\'s manifest is accessible, bounded and within its root.', 'FAIL', 'Unsafe or invalid manifest refused; nothing repaired.', [rel], observation);
    else addCheck(report, `${step}:manifest`, `The step's evidence bundle is closed by ${rel}.`, 'UNVERIFIED', 'No manifest on record, so no record of this step is bound to anything.', [rel], observation, null, false);
    return null;
  }
  report.sources.push({ path: rel, sha256: hash(manifestBytes), bytes: manifestBytes.length, observation });
  const expected = `cr-operating-proof-${step}-evidence@1`;
  let manifest;
  const records = new Map();
  try {
    manifest = jsonOf(manifestBytes);
    if (!manifest || !Array.isArray(manifest.files) || manifest.files.length > MAX_BUNDLE_FILES) throw new Error();
    let total = 0;
    for (const entry of manifest.files) {
      safeRestoreRel(entry.path);
      if (records.has(entry.path) || !HASH.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error();
      const bytes = readBounded(root, `${folder}/${entry.path}`);
      total += bytes.length;
      if (total > 8 * MAX_FILE || bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error();
      records.set(entry.path, bytes);
    }
  } catch (_) {
    addCheck(report, `${step}:manifest`, 'Every listed member exists intact; no partial bundle is accepted.', 'FAIL', 'The bundle is malformed, incomplete or has a hash mismatch: it changed after it closed.', [rel], observation);
    return null;
  }
  if (manifest.format !== expected || !SHA.test(String(manifest.baseline)) || !validTime(manifest.closed_at) || Date.parse(manifest.closed_at) > Date.parse(report.verified_at)) {
    addCheck(report, `${step}:manifest`, 'The manifest names its format, a 40-character baseline and a past closing time.', 'UNVERIFIED', 'A required manifest field is missing or the closing time is in the future.', [rel], observation);
    return null;
  }
  addCheck(report, `${step}:manifest`, 'Every manifest member matches its recorded bytes and hash.', 'PASS', `All ${manifest.files.length} members verified. This proves preservation, not origin.`, [rel], observation, manifest.closed_at);
  return { folder, manifest, records, manifest_sha256: hash(manifestBytes), anchored: !fixture && FIXTURE_WORDS.has(String(manifest.provenance).toLowerCase()) === false && revision.anchored(hash(manifestBytes)) };
}

// ---- Gate readers: verdicts over the bound records ----------------------
const pass = (words) => ({ result: 'PASS', words });
const fail = (words) => ({ result: 'FAIL', words });
const unv = (words) => ({ result: 'UNVERIFIED', words });
function all(...vs) {
  for (const r of ['FAIL', 'UNVERIFIED']) {
    const hit = vs.filter((v) => v.result === r);
    if (hit.length) return { result: r, words: hit.map((v) => v.words).join(' ') };
  }
  return vs.length ? pass(vs.map((v) => v.words).join(' ')) : unv('Nothing was checked.');
}
// A record's arbitrary text never reaches a report: only safe shapes are repeated.
function said(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v !== 'string') return 'a different value';
  if (SHA.test(v)) return v.slice(0, 7);
  return /^[A-Za-z_-]{1,24}$/.test(v) ? v : 'a different value';
}
// Absent is UNVERIFIED and different is FAIL: a missing value is never a pass.
function eq(actual, expected, what) {
  if (actual === undefined || actual === null) return unv(`${what} is not on record.`);
  if (expected === undefined || expected === null) return unv(`What ${what} must match is not on record.`);
  return actual === expected ? pass(`${what}: ${said(actual)}.`) : fail(`${what} is ${said(actual)}, required ${said(expected)}.`);
}
const atOf = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : NaN;
};
const arr = (v, what) => { if (!Array.isArray(v)) throw new TypeError(`${what} is not a list`); return v; };
const present = (v) => typeof v === 'string' && v.trim() !== '';
const hasAll = (rec, names) => {
  const bad = names.filter((n) => !present(rec[n]) && !Number.isInteger(rec[n]));
  return bad.length ? unv(`Not on record: ${bad.join(', ')}.`) : pass('Each ID is on record.');
};
const healthzRevision = (text) => { const m = /^revision ([0-9a-f]{40})\b/m.exec(String(text)); return m ? m[1] : null; };
const orderIn = (tv, coid) => arr(tv.orders, 'orders').find((o) => o.client_order_id === coid) || null;
// B1's order row, only when the capture names it once. The trader view lists
// the book's orders, keyed by client_order_id, which the book derives from the
// intent ID (paper-trader.js reserve), so neither repeats in a real capture: a
// repeat is ambiguous, FAIL. Other orders' rows are left as they are.
function onlyOrderIn(tv, coid) {
  const rows = arr(tv.orders, 'orders').filter((o) => o && typeof o === 'object');
  const mine = rows.filter((o) => o.client_order_id === coid);
  if (!mine.length) return { verdict: unv('The order is not in the capture.') };
  if (mine.length > 1) return { verdict: fail(`The trader view lists this order ${mine.length} times: which row is the desk's is ambiguous.`) };
  const o = mine[0];
  if (o.intent_id !== undefined && o.intent_id !== null && rows.some((x) => x !== o && x.intent_id === o.intent_id)) return { verdict: fail('Another row in the trader view carries this order\'s intent: which row is the desk\'s is ambiguous.') };
  return { order: o };
}
const positionsOfAll = (tv) => [...arr(tv.results.open_positions, 'open_positions'), ...arr(tv.results.closed_positions, 'closed_positions')];
const positionsOf = (tv, decisionId) => positionsOfAll(tv).filter((p) => p.decision_id === decisionId);
const isZero = (v) => typeof v === 'string' && /^0(\.0*)?$/.test(v);
// The first causally eligible hour starts at or after the send; it is read
// only once closed and settled (blueprint B1.3: a send at 14:20 is usable at 16:10).
function usableAt(sentAt) {
  const t = atOf(sentAt);
  return Number.isFinite(t) ? Math.ceil(t / HOUR_MS) * HOUR_MS + HOUR_MS + SETTLE_MS : NaN;
}
const scope = (rec, c) => (!c.project ? pass('No project was named.') : rec.project_id === c.project ? pass('The project scope holds.') : unv('This record is another project\'s.'));
function revisionsAgree(d, c) {
  const r = d['revision-final.json'];
  return all(eq(r.healthz_status, 200, '/healthz status'), eq(healthzRevision(d['healthz.txt']), c.baseline, 'the raw /healthz revision'), eq(r.deployed_sha, c.baseline, 'the deployed commit'), eq(r.origin_main, c.baseline, 'origin/main'), eq(r.runner_head, c.baseline, 'the runner\'s HEAD'));
}
function noReconcile(ctl) {
  const rows = arr(ctl.projects, 'projects');
  if (rows.some((p) => p.dispatch && (p.dispatch.reconcile === true || p.dispatch.state === 'reconcile'))) return fail('A reconcile is open: Eric settles it first.');
  if (!ctl.dispatch || ctl.dispatch.projects_unreadable !== null || rows.some((p) => !p.dispatch || p.dispatch.state === 'unreadable')) return unv('A claim does not read.');
  return pass(`No reconcile among ${rows.length} pilot project(s).`);
}
function noUncertainOrder(tv) {
  const n = arr(tv.orders, 'orders').filter((o) => o.state === 'UNKNOWN' || o.state === 'RECONCILE_REQUIRED').length;
  return n ? fail(`${n} order(s) await reconciliation.`) : pass('No uncertain order.');
}
const pilotLine = (l, dryRun, c) => all(eq(l.format, 'cr-pilot-all@1', 'the runner log format'), eq(l.dry_run, dryRun, 'dry_run'), eq(l.revision && l.revision.runner, c.baseline, 'the runner revision'), eq(l.revision && l.revision.desk, c.baseline, 'the desk revision the guard read'));
function fingerprint(tv, ctl) {
  const sort = (xs) => xs.slice().sort();
  return {
    orders: sort(arr(tv.orders, 'orders').map((o) => `${o.client_order_id}|${o.intent_id || ''}|${o.state}|${o.filled}`)),
    decisions: sort(arr(tv.requests, 'requests').map((r) => `${r.decision_id}|${r.receipt_id}`)),
    positions: sort(positionsOfAll(tv).map((p) => p.position_id)),
    claims: sort(arr(ctl.projects, 'projects').map((p) => `${p.project_id}|${(p.dispatch && p.dispatch.attempt_id) || ''}|${(p.dispatch && p.dispatch.claim_state) || ''}|${(p.dispatch && p.dispatch.run_id) || ''}`)),
    reports: sort(arr(ctl.projects, 'projects').flatMap((p) => Object.values(p.reports || {}).filter(Boolean).map((r) => `${p.project_id}|${r.report_id}`))),
  };
}
function sameEffects(aTv, aC, bTv, bC, label) {
  const a = fingerprint(aTv, aC);
  const b = fingerprint(bTv, bC);
  const changed = Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  const sa = aC.dispatch && aC.dispatch.sessions;
  const sb = bC.dispatch && bC.dispatch.sessions;
  if (!sa || !sb || typeof sa.used !== 'number' || typeof sb.used !== 'number') return unv(`sessions_today does not read for ${label}.`);
  if (changed.length) return fail(`${label} changed ${changed.join(', ')}: a side effect where nothing was newly eligible.`);
  if (sa.day !== sb.day) return unv(`${label} crossed a New York day, so sessions_today is not comparable.`);
  return sa.used === sb.used ? pass(`${label}: the same IDs, ${sa.used} session(s).`) : fail(`${label}: sessions_today went from ${sa.used} to ${sb.used}.`);
}
// An uncertain attempt stays claimed: a release or a new attempt never makes a comparison pass.
function uncertainStays(before, after) {
  const UNSETTLED = ['claimed', 'expired', 'reconcile'];
  const held = arr(before.projects, 'projects').filter((p) => p.dispatch && p.dispatch.attempt_id && UNSETTLED.includes(p.dispatch.state));
  const now = new Map(arr(after.projects, 'projects').map((p) => [p.project_id, p.dispatch || {}]));
  const lost = held.filter((p) => { const n = now.get(p.project_id) || {}; return n.attempt_id !== p.dispatch.attempt_id || !UNSETTLED.includes(n.state); });
  if (lost.length) return fail(`${lost.length} uncertain attempt(s) were released or replaced.`);
  return pass(held.length ? `${held.length} uncertain attempt(s) stayed claimed.` : 'No attempt was uncertain.');
}
// "about 2 h": from three quarters of it to half again as long.
function pollAt(ctl, resumedAt, hours) {
  const t = atOf(ctl.at);
  const r = atOf(resumedAt);
  if (!Number.isFinite(t) || !Number.isFinite(r)) return unv(`The ${hours} h poll read carries no usable time.`);
  const age = (t - r) / HOUR_MS;
  if (age < hours * 0.75 || age > hours * 1.5) return unv(`The ${hours} h poll was read ${age.toFixed(1)} h after the Resume.`);
  return all(eq(ctl.poll && ctl.poll.state, 'fresh', `the poll at about ${hours} h`), eq(ctl.poll && ctl.poll.runner_id, 'render-ops1', `the runner at about ${hours} h`));
}
function causalFill(basis, coid, sentAt) {
  const sent = atOf(sentAt);
  const fills = arr(basis.execution.fills, 'fills').filter((f) => f.client_order_id === coid);
  if (!fills.length) return unv('Fill pending: no fill is on record for this order. A held or no-trade outcome is correct, and the milestone stays unproven.');
  if (!Number.isFinite(sent)) return unv('The send time is not on record.');
  return all(...fills.map((f) => {
    const hour = atOf(f.hour);
    if (!Number.isFinite(hour)) return unv('A fill names no usable hour.');
    if (hour < sent) return fail('A fill\'s hour starts before the send: not causal.');
    return all(present(f.price) ? pass('Its price is recorded.') : unv('A fill has no recorded price.'), present(f.fee_usd) ? pass('Its fee is recorded.') : unv('A fill has no recorded fee.'));
  }));
}
function basisVerified(b, decisionId) {
  const originals = arr(b.originals, 'originals');
  const bad = originals.filter((o) => o.digest !== 'verified').length;
  return all(eq(b.format, 'cr-decision-view@1', 'the basis view format'), eq(b.label, 'decision_time', 'label'), eq(b.digest, 'verified', 'digest'), eq(b.decision && b.decision.decision_id, decisionId, 'its decision'),
    originals.length && !bad ? pass(`${originals.length} named record(s) checked by SHA-256.`) : unv(`${bad} of ${originals.length} named records are not verified.`));
}
function attributionRow(v, decisionId) {
  if (v.code === 'INTEGRITY' || v.status === 'error') return { verdict: fail('The attribution view refused.') };
  const row = arr(v.rows, 'rows').find((r) => r.decision_id === decisionId);
  return row ? { row } : { verdict: unv('No attribution row for this decision.') };
}
// Exact figures (contract-gate.js ratio, never a float): a decimal string or
// a number as a rational, compared by cross-multiplication.
const exact = (v) => (typeof v === 'string' || typeof v === 'number' ? G.ratio(v) : null);
const cmpExact = (a, b) => { const x = a.n * b.d - b.n * a.d; return x > 0n ? 1 : x < 0n ? -1 : 0; };
// A figure repeated in a report only when it is a plain decimal.
const fig = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' && /^-?\d{1,40}(\.\d{1,40})?$/.test(v) ? v : 'a different value');
// The same value, or absent (UNVERIFIED), or different (FAIL), for an object.
function sameShape(actual, expected, what) {
  if (actual === undefined) return unv(`${what} is not on record.`);
  return G.canonicalJson(actual) === G.canonicalJson(expected) ? pass(`${what} agrees.`) : fail(`${what} is not the one on the reservation.`);
}

// The persisted reservation behind the row (B1 option (b), Eric 2026-11-11):
// the order's `reserved` line as the book holds it, read through the book's
// own integrity checks by `tickets basis <project> <decision> --json` at the
// acknowledgement (basis-after-ack.json: decision-basis.js executionOf, over
// trader-desk.js executionFor), with the opening receipt written on that line
// (cr.opening-guard.v1, `contract_guard`). That receipt is the source of
// record. It must be a whole record (opening-receipt.js problemsOf) of an
// enforced CG-14 pass, for exactly the quantity the book reserved, under this
// order's decision, ticket and project, with its unrounded exit cost within
// the limit it records and the book's notional equal to the one it was
// measured at; the desk's check of the reservation must list no difference;
// no other reservation may carry this intent; and the trader view's row must
// say the same thing.
// Everything is read from the bundle: the desk's current observation and
// settings are never consulted, so a proof reads the same from its bundle
// whenever it is run again. What this does not do: make the guard's reading
// again from the observation (that is the desk's own check, which `bound`
// reports at capture time; the observation is not in the bundle), or prove
// the bytes are the desk's (the manifest and Eric's merged receipt do that).
function persistedReceipt(b, o, row, l) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return unv('The decision\'s execution is not in the capture.');
  const head = all(eq(b.format, 'cr-decision-view@1', 'the decision basis view format'), eq(b.decision && b.decision.decision_id, l.decision_id, 'the decision the basis is for'));
  if (head.result !== 'PASS') return head;
  const ex = b.execution;
  if (!ex || typeof ex !== 'object') return unv('The basis capture carries no execution.');
  if (ex.state === 'integrity' || ex.code === 'INTEGRITY') return fail('The book refused its own journal when the reservation was read: no reservation it holds is shown.');
  const lines = arr(ex.reserved, 'reserved').filter((x) => x && typeof x === 'object');
  const mine = lines.filter((x) => x.client_order_id === l.client_order_id);
  if (mine.length !== 1) return fail(mine.length ? 'The decision\'s execution holds more than one reservation for this order.' : 'The decision\'s execution, read through the book, holds no reservation for this order.');
  const res = mine[0];
  // The book holds one order per intent (paper-trader.js reserve: client_order_id
  // is derived from intent_id) and executionFor refuses a line the book does not
  // hold as recorded, so no other reservation can carry this intent's ID or hash.
  const twins = lines.filter((x) => x !== res && ((x.intent_id !== undefined && x.intent_id !== null && x.intent_id === res.intent_id) || (HASH.test(String(x.intent_sha256)) && x.intent_sha256 === res.intent_sha256)));
  if (twins.length) return fail('Another reservation in the decision\'s execution carries this order\'s intent (its ID or its SHA-256): which one the book holds is ambiguous.');
  const g = res.grant;
  const links = all(eq(res.side, 'OPEN_LONG', 'the reservation\'s side'), eq(res.intent_id, l.intent_id, 'the reservation\'s intent'),
    HASH.test(String(res.intent_sha256)) ? eq(row.intent_sha256, res.intent_sha256, 'the reservation the row was checked against (intent_sha256)') : unv('The reservation\'s intent hash is not on record.'),
    !g || typeof g !== 'object' ? unv('The grant the book read is not on record.')
      : all(eq(g.decision_id, l.decision_id, 'the grant\'s decision'), eq(g.receipt_id, l.receipt_id, 'the grant\'s ticket'), eq(g.project_id, l.project_id, 'the grant\'s project'), g.action === 'approve' || g.action === 'halve' ? pass(`The grant is an ${g.action}.`) : fail('The grant the book read is not an approve or a halve.')),
    eq(res.opening_receipt && res.opening_receipt.status, 'bound', 'the desk\'s check of the reservation'),
    !res.opening_receipt || !Array.isArray(res.opening_receipt.differences) ? unv('The desk\'s check of the reservation does not list its differences.')
      : res.opening_receipt.differences.length ? fail(`The desk's check of the reservation lists ${res.opening_receipt.differences.length} difference(s).`) : pass('The desk\'s check of the reservation lists no difference.'),
    eq(o.quantity, res.quantity, 'the order\'s quantity against the reservation'));
  const rec = res.contract_guard;
  if (rec === undefined) return all(links, unv('The capture does not show the receipt written on the reservation.'));
  if (rec === null) return all(links, fail('The reservation carries no opening receipt, whatever the row says.'));
  const bad = OR.problemsOf(rec);
  if (bad.length) return all(links, fail(`The receipt on the reservation is not a whole ${OR.VERSION}: ${bad.join('; ')}.`));
  // problemsOf holds for a well-formed not_checked record too: only a pass under enforce opens B1.
  if (rec.result !== 'pass' || rec.gate_mode !== 'enforce') return all(links, fail(`The receipt on the reservation records the guard ${rec.result === 'pass' ? 'passing' : 'not run'} with the gate ${said(rec.gate_mode)}: B1's opening needs an enforced pass.`));
  const q = rec.quantity;
  const e = rec.exit;
  const ob = rec.observation;
  const lim = rec.limits;
  const base = G.baseUnits(q.final, q.decimals);
  const [fin, risk, entry, notional, price, cost, limit] = [q.final, q.risk_sized, e.entry_usd, e.notional_usd, res.entry_price, e.cost_pct, lim.exit_cost_pct].map(exact);
  const product = fin && entry ? { n: fin.n * entry.n, d: fin.d * entry.d } : null;
  const [lo, hi] = product ? [exact(G.fixed(product, 18, 'floor', false)), exact(G.fixed(product, 18, 'ceil', false))] : [null, null];
  const figures = all(
    eq(q.final, res.quantity, 'the receipt\'s final quantity against the quantity the book reserved'),
    base !== null && base.toString() === q.final_base_units ? pass(`Its base units are ${fig(q.final)} at ${q.decimals} decimals.`) : fail('The receipt\'s base units are not its final quantity at the token\'s decimals.'),
    fin && risk && cmpExact(fin, risk) <= 0 ? pass('The final quantity is not above the risk-sized one.') : fail('The receipt\'s final quantity is above the quantity the risk sized.'),
    q.sized_by === 'risk' && q.final !== q.risk_sized ? fail('The receipt says the order kept its risk-sized quantity, and its two quantities differ.') : pass(`Sized by ${q.sized_by}.`),
    price && entry && cmpExact(price, entry) === 0 ? pass('The sale was valued at the order\'s own entry.') : fail('The receipt valued the sale at another entry than the reservation\'s limit price.'),
    notional && lo && hi && cmpExact(notional, lo) >= 0 && cmpExact(notional, hi) <= 0 ? pass('The notional measured is the final quantity at that entry.') : fail('The notional the receipt was measured at is not the final quantity at the entry price.'),
    // The book's notional (trade-risk.js sizing, mulCeil(quantity, entry) at 18
    // places) and the guard's (trader-desk.js, the same sizing's notional_usd)
    // are one figure for the same quantity and entry: equal, exactly.
    res.notional_usd === undefined || res.notional_usd === null ? unv('The notional the book reserved is not on record.')
      : exact(res.notional_usd) && notional && cmpExact(exact(res.notional_usd), notional) === 0 ? pass(`The book reserved the notional the receipt was measured at, ${fig(res.notional_usd)}.`)
        : fail(`The book reserved a notional of ${fig(res.notional_usd)}; the receipt was measured at ${fig(e.notional_usd)}.`),
    !cost || !limit || limit.n <= 0n ? unv('The receipt\'s cost or its limit does not read as an exact figure.')
      : cmpExact(cost, limit) <= 0 ? pass(`The unrounded exit cost ${fig(e.cost_pct)}% is within the ${fig(lim.exit_cost_pct)}% limit the receipt records.`)
        : fail(`The receipt's unrounded exit cost ${fig(e.cost_pct)}% is over the ${fig(lim.exit_cost_pct)}% limit it records.`),
    !Number.isFinite(Date.parse(res.at)) ? unv('The reservation\'s time is not on record.') : Date.parse(rec.checked_at) <= Date.parse(res.at) ? pass('The receipt was made no later than its reservation.') : fail('The receipt is dated after the reservation it is written on.'));
  // The row the trader view showed, figure by figure, against the reservation's receipt.
  const agrees = all(
    eq(row.reserved_quantity, res.quantity, 'the row\'s reserved quantity'), sameShape(row.quantity, q, 'The quantity record on the row'), sameShape(row.size, rec.size === undefined ? null : rec.size, 'The sizing quote on the row'),
    eq(row.observation_id, ob.observation_id, 'the observation the row names'), eq(row.observation_sha256, ob.sha256, 'that observation\'s SHA-256 on the row'), eq(row.chain_id, ob.chain_id, 'the row\'s chain'), eq(row.block_number, ob.block_number, 'the row\'s block'),
    eq(row.exit_pool, e.pool, 'the pool the row says proved the exit'), eq(row.cost_pct, e.cost_pct, 'the cost the row records'), eq(row.limit_pct, lim.exit_cost_pct, 'the limit the row records'), eq(row.valuation, rec.gate.exit, 'the valuation the row names'),
    eq(row.result, rec.result, 'the row\'s guard result'), eq(row.gate_mode, rec.gate_mode, 'the row\'s gate mode'));
  return all(links, figures, agrees, pass(`The reservation the book holds carries its receipt: an enforced CG-14 pass for exactly ${fig(res.quantity)} tokens, the exit proven at an unrounded ${fig(e.cost_pct)}% within ${fig(lim.exit_cost_pct)}%, and the row agrees with it figure by figure.`));
}

// The order's opening receipt, as the desk checked it for the trader view's
// own order row (trader-desk.js view, core/opening-receipt.js verify,
// cr.opening-guard.v1), and then the reservation it was checked against
// (persistedReceipt). B1's opening runs with the contract gate enforced
// (b0:arming_identity), so the row must read bound and say the guard passed.
// A capture with no reading of it (a desk before the receipt existed) or one
// the desk could not check proves nothing; an order with no receipt, an
// unchecked one, a malformed one or any difference fails. `bound` is the
// desk's word: it is taken as the desk's statement only, and the persisted
// reservation must bear it out.
function openingReceipt(o, l, basis) {
  const r = o.opening_receipt;
  if (r === undefined || r === null) return unv('The capture carries no reading of the order\'s opening receipt.');
  const words = String(r.words || '').slice(0, 300);
  if (r.status === 'unverifiable') return unv(`The order's opening receipt could not be checked: ${words}`);
  if (r.status !== 'bound') return fail(`The order's opening receipt reads ${String(r.status)}: ${words}`);
  return all(pass('The desk\'s check reads the order\'s opening receipt bound.'),
    eq(r.decision_id, l.decision_id, 'the receipt\'s decision'), eq(r.intent_id, l.intent_id, 'the receipt\'s intent'), eq(r.reserved_quantity, o.quantity, 'the quantity the receipt is for'),
    eq(r.gate_mode, 'enforce', 'the gate mode at the opening'), eq(r.result, 'pass', 'the guard\'s result'),
    !Array.isArray(r.differences) ? unv('The row does not list the check\'s differences.') : r.differences.length ? fail(`The row reads bound and lists ${r.differences.length} difference(s).`) : pass('The check lists no difference.'),
    persistedReceipt(basis, o, r, l));
}
const owner = (rec, names) => all(...names.map(([n, want]) => eq(rec[n], want, n)));
const proofWord = (r) => (r === 'PASS' ? 'proven' : r === 'FAIL' ? 'failed' : 'pending');
const NATURAL_EXITS = new Set(['stop', 'stop_gap', 'take_profit', 'close']);

// Eric's records, where the desk has no read or he captures a fact by hand. A gate
// that reads any of them says so; every other record is the desk's output as captured.
const OWNER_RECORDS = new Set(['build-deploy.json', 'authority.json', 'heartbeat.json', 'candidate.json', 'lineage.json', 'window.json', 'successor.json', 'lifecycle-evidence.json', 'deploys.json', 'approval.json', 'service.json', 'kill-drill.json', 'desk-down.json', 'operations.json', 'healthchecks.json', 'lifecycle.json']);
// One reader per gate in the canon.
const READERS = {
  r0: {
    alignment: { files: ['revision-final.json', 'healthz.txt', 'verification.json'], judge: (d, c) => all(revisionsAgree(d, c), eq(d['verification.json'].runner.detached, true, 'detached'), eq(d['verification.json'].runner.clean, true, 'clean')) },
    quiet_swap: { files: ['tasks-final.json'], judge: (d) => { const t = d['tasks-final.json']; return all(eq(t.pilot.state, 'Disabled', 'pilot-all'), eq(t.pilot.instances, 0, 'its instances'), eq(t.hourly.state, 'Disabled', 'Hourly during the swap'), eq(t.hourly.instances, 0, 'its instances')); } },
    registration: { files: ['pilot-all.final-status.json'], judge: (d, c) => { const s = d['pilot-all.final-status.json']; const g = s.config; return all(eq(s.status.task.state, 'Disabled', 'state'), eq(g.launcher, 'job_wrapper', 'launcher'), eq(g.max_agents, 1, 'max_agents'), eq(g.unattended, true, 'unattended'), eq(g.model_named, true, 'model_named'), eq(g.checkout_clean, true, 'checkout_clean'), eq(g.checkout_head, c.baseline, 'checkout_head'), eq(g.working_directory_is_repository, true, 'working_directory_is_repository')); } },
    hourly_route: {
      files: ['verification.json', 'doctor-main-workspace.json'],
      judge: (d) => {
        const route = d['verification.json'].hourly_route;
        const row = arr(d['doctor-main-workspace.json'].checks, 'checks').find((x) => x.name === 'Workspace folder');
        const detail = row ? String(row.detail ?? '') : '';
        return all(eq(route.stand_in_exit, route.expected_exit, 'the wrapper\'s exit'), !present(route.records_root) || !row ? unv('The workspace the doctor names is not on record.') : detail.includes(route.records_root) && /kind: real\b/.test(detail) ? pass('The doctor names the records\' own real workspace.') : fail('The doctor names another workspace, or one that is not real.'));
      },
    },
    doctor: { files: ['doctor-main-workspace.json'], judge: (d) => { const r = d['doctor-main-workspace.json']; const n = arr(r.checks, 'checks').filter((x) => x.status === 'warn' || x.status === 'error' || x.status === 'fail').length; return all(eq(r.verified_write, true, 'write and readback'), pass(`${n} warning line(s) are recorded in the bundle.`)); } },
    offsite_run: {
      files: ['tasks-final.json', 'offsite-readback.json'],
      judge: (d) => {
        const job = d['offsite-readback.json'].jobs.offsite;
        const since = atOf(d['tasks-final.json'].observed_at);
        const ran = atOf(job.last_run_at);
        if (!Number.isFinite(since) || !Number.isFinite(ran)) return unv('The time of the repointing or of the offsite run is not on record.');
        if (ran <= since) return unv('The offsite run on record is from before the repointing.');
        return eq(job.last_status, 'ok', 'the offsite run\'s status');
      },
    },
  },
  b0: {
    build_deploy: {
      files: ['revision-final.json', 'healthz.txt', 'build-deploy.json'],
      judge: (d, c) => {
        const b = d['build-deploy.json'];
        const prs = arr(b.prs, 'prs');
        const bad = prs.filter((p) => p.merged === false || (p.head_checks !== undefined && p.head_checks !== 'green')).length;
        const unread = prs.filter((p) => p.merged === undefined || p.head_checks === undefined).length;
        return all(revisionsAgree(d, c), eq(b.render_deploy_commit, c.baseline, 'the Render deploy record'), bad ? fail(`${bad} PR(s) are not merged or not green.`) : prs.length < 4 || unread ? unv('PRs 1-4 are not all on record.') : pass('PRs 1-4 are merged with green head checks.'));
      },
    },
    quiet_authority: {
      files: ['controls.json', 'tasks-final.json', 'authority.json'],
      judge: (d) => {
        const ctl = d['controls.json'];
        const a = d['authority.json'];
        const adm = ctl.authority.admission;
        return all(eq(adm.on, false, 'authority.admission.on'), eq(adm.enabled, false, 'authority.admission.enabled'), eq(d['tasks-final.json'].pilot.state, 'Disabled', 'pilot-all'),
          a.render_cron === 'absent' || a.render_cron === 'suspended' ? pass(`The Render cron reads ${a.render_cron}.`) : a.render_cron === undefined ? unv('The Render cron is not on record.') : fail('The Render cron reads neither absent nor suspended.'),
          eq(a.scout_enabled, false, 'scout_enabled'), noReconcile(ctl));
      },
    },
    dry_run: {
      files: ['dry-run.json', 'dry-run-negative.json', 'isolation.json'],
      judge: (d, c) => {
        const l = d['dry-run.json'];
        const n = d['dry-run-negative.json'];
        return all(pilotLine(l, true, c), eq(l.revision && l.revision.clean, true, 'the runner\'s cleanliness'), eq(l.exit, 0, 'exit'), eq(l.max_agents, 1, 'max_agents'), Array.isArray(l.polled) ? pass('The pre-poll list is on record.') : unv('The pre-poll list is not on record.'),
          eq(n.dry_run, true, 'the negative\'s dry_run'), eq(n.exit, 1, 'the negative\'s exit'), /uncommitted changes/.test(String(n.error)) ? pass('The guard refused the edited tree.') : unv('The refusal is not the guard\'s dirty-tree refusal.'),
          eq(d['isolation.json'].format, 'cr-pilot-launch@1', 'the isolation format'), eq(d['isolation.json'].ok, true, 'isolation'));
      },
    },
    heartbeat_config: { files: ['heartbeat.json'], judge: (d) => owner(d['heartbeat.json'], [['period_minutes', 60], ['grace_minutes', 120], ['alerts_eric_only', true], ['dry_run_ping_claimed', false]]) },
    meters: {
      files: ['doctor.json', 'trader.json'],
      judge: (d) => {
        const rows = arr(d['doctor.json'].checks, 'checks');
        const lines = ['Market data', 'Contract screening', 'Forensics'].map((name) => {
          const row = rows.find((x) => x.name === name);
          if (!row) return unv(`The doctor has no ${name} line.`);
          return /unknown/i.test(String(row.detail ?? row.message ?? '')) ? fail(`${name} reads unknown.`) : pass(`${name} reads.`);
        });
        const candles = d['trader.json'].candles;
        lines.push(!candles ? unv('The candle meter is not on record.') : candles.accounting_unknown ? fail('The candle meter reads unknown.') : pass('The candle meter reads.'), noUncertainOrder(d['trader.json']));
        return all(...lines);
      },
    },
    arming_identity: {
      files: ['candidate.json', 'controls.json'],
      judge: (d, c) => {
        const k = d['candidate.json'];
        const auth = d['controls.json'].authority;
        const enrolled = arr(d['controls.json'].projects, 'projects').some((p) => p.project_id === k.project_id);
        return all(hasAll(k, ['project_id', 'chain', 'contract', 'coingecko_id', 'exit_target']), /^claude-[a-z0-9-]+$/.test(String(k.model_id)) ? pass('The pinned model is a full ID.') : unv('The pinned model is not a full model ID.'),
          owner(k, [['vetoed', false], ['held', false], ['arm_desk_reviewed', true], ['contract_gate', 'enforce'], ['max_grants_per_day', 1]]),
          typeof auth.paused === 'boolean' ? pass(`Paused reads ${auth.paused}.`) : unv('The pause state is not on record.'),
          Number.isInteger(auth.mandate.generation) && present(auth.mandate.expires_at) ? pass('The mandate generation and expiry read.') : unv('The mandate generation or expiry is not on record.'),
          enrolled ? pass('It is enrolled in the pilot.') : fail('The candidate is not among the pilot\'s projects on Desk Controls.'), scope(k, c));
      },
    },
  },
  b1: {
    window: {
      files: ['window.json', 'tasks-after.json', 'lineage.json'],
      judge: (d) => {
        const w = d['window.json'];
        const t = d['tasks-after.json'];
        const on = atOf(w.enabled_at);
        const off = atOf(w.disabled_at);
        const read = atOf(t.observed_at);
        if (![on, off, read].every(Number.isFinite)) return unv('The window\'s times are not on record.');
        return all(on < off ? pass('The window opened and closed.') : fail('The window closed before it opened.'), read >= off ? pass('The Disabled readback follows the window.') : unv('The readback was taken before the window closed.'),
          eq(t.pilot.state, 'Disabled', 'pilot-all afterwards'), eq(t.pilot.instances, 0, 'its instances'), eq(w.candidate_project_id, d['lineage.json'].project_id, 'the candidate'), eq(w.other_projects_ran, false, 'other_projects_ran'));
      },
    },
    lineage: {
      // basis-after-ack.json: `tickets basis <project_id> <decision_id> --json`, run after the acknowledgement.
      files: ['lineage.json', 'trader-after-ack.json', 'basis-after-ack.json'],
      judge: (d, c) => {
        const l = d['lineage.json'];
        const { order: o, verdict } = onlyOrderIn(d['trader-after-ack.json'], l.client_order_id);
        return all(hasAll(l, ['project_id', 'run_id', 'report_id', 'receipt_id', 'generation', 'decision_id', 'intent_id', 'client_order_id', 'sent_at']), scope(l, c),
          !o ? verdict : all(eq(o.state, 'ACKED', 'the order'), eq(o.side, 'OPEN_LONG', 'its side'), eq(o.decision_id, l.decision_id, 'its decision'), eq(o.intent_id, l.intent_id, 'its intent'), openingReceipt(o, l, d['basis-after-ack.json'])));
      },
    },
    cancellation: {
      files: ['lineage.json', 'trader-after-window.json'],
      judge: (d) => {
        const l = d['lineage.json'];
        const tv = d['trader-after-window.json'];
        const usable = usableAt(l.sent_at);
        const applied = atOf(l.control_applied_at);
        const { order: o, verdict } = onlyOrderIn(tv, l.client_order_id);
        if (!Number.isFinite(usable) || !Number.isFinite(applied)) return unv('The send or the control has no usable time.');
        if (applied >= usable) return fail('The control came after the first eligible hour was usable.');
        if (!o) return verdict;
        return all(pass('The control came before the first eligible hour was usable.'), eq(o.state, 'CANCELLED', 'the order'), isZero(o.filled) ? pass('Nothing filled.') : o.filled === undefined ? unv('Its filled quantity is not on record.') : fail('The order reads filled.'),
          positionsOf(tv, l.decision_id).length ? fail('A position came from it.') : pass('No position came from it.'));
      },
    },
    progress: {
      files: ['lineage.json', 'trader-after-ack.json', 'trader-after-window.json', 'desk-controls-after.json'],
      judge: (d) => {
        const l = d['lineage.json'];
        const usable = usableAt(l.sent_at);
        const read = atOf(d['trader-after-window.json'].now);
        const a = atOf(d['trader-after-ack.json'].candles.last_run_at);
        const b = atOf(d['trader-after-window.json'].candles.last_run_at);
        const name = l.control;
        if (!Number.isFinite(usable) || !Number.isFinite(read)) return unv('The send or the read has no usable time.');
        if (read < usable) return unv('The book was read before the eligible hour closed plus 10 minutes.');
        if (!Number.isFinite(a) || !Number.isFinite(b)) return unv('The candle read\'s time is not on record.');
        if (name !== 'pause' && name !== 'mandate_off') return unv('The lineage does not name the control (pause or mandate_off).');
        return all(b > a ? pass('The hourly read ran again after the control.') : fail('The hourly read did not run again in the window.'), eq(d['desk-controls-after.json'].controls[name].done, true, `controls.${name}.done`));
      },
    },
    grant_liveness: {
      files: ['lineage.json', 'run-log.json', 'desk-controls-after.json'],
      judge: (d, c) => {
        const l = d['lineage.json'];
        return all(pilotLine(d['run-log.json'], false, c), present(d['desk-controls-after.json'].poll.last_polled_at) ? pass('A POST sighting reached the desk.') : unv('No POST sighting is on record.'),
          owner(l, [['healthchecks_start_and_final_seen', true], ['grant_stays_in_force', true], ['grant_reused', false]]), present(l.counted_toward_ny_day) ? pass('It counts toward its New York day.') : unv('Its New York day is not on record.'));
      },
    },
  },
  b2: {
    successor: {
      files: ['lineage.json', 'successor.json'],
      judge: (d, c) => {
        const l = d['lineage.json'];
        const b1 = c.prior.b1 && c.prior.b1.records.get('lineage.json');
        let cancelled = null;
        try { cancelled = b1 ? jsonOf(b1) : null; } catch (_) { cancelled = null; }
        return all(owner(d['successor.json'], [['rearm_reviewed', true], ['cap_relaxed', false], ['respects_cancelled_grant', true]]), present(d['successor.json'].report_id) ? pass('The successor report is on record.') : unv('The successor report is not on record.'),
          !cancelled ? unv('B1\'s cancelled grant is not available to compare.') : cancelled.decision_id === l.decision_id || cancelled.client_order_id === l.client_order_id ? fail('This reuses B1\'s cancelled grant.') : pass('It is not B1\'s cancelled grant.'));
      },
    },
    lifecycle: {
      files: ['lineage.json', 'attribution.json', 'trader.json', 'lifecycle-evidence.json'],
      judge: (d, c) => {
        const l = d['lineage.json'];
        const { row, verdict } = attributionRow(d['attribution.json'], l.decision_id);
        const o = orderIn(d['trader.json'], l.client_order_id);
        return all(hasAll(l, ['project_id', 'run_id', 'report_id', 'receipt_id', 'generation', 'decision_id', 'intent_id', 'client_order_id', 'sent_at']), scope(l, c), verdict || eq(row.decided_by, 'mandate', 'decided_by'),
          !o ? unv('The order is not in the capture.') : all(eq(o.decision_id, l.decision_id, 'its decision'), eq(o.intent_id, l.intent_id, 'its intent')),
          owner(d['lifecycle-evidence.json'], [['contract_evidence_block_pinned', true], ['exits_complete_and_fresh', true], ['sizing_passed', true], ['candles_passed', true]]));
      },
    },
    basis: {
      files: ['lineage.json', 'attribution.json', 'basis.json'],
      judge: (d) => {
        const id = d['lineage.json'].decision_id;
        const { row, verdict } = attributionRow(d['attribution.json'], id);
        // A book that does not read refuses the whole view, so an unrefused row reads through the book.
        return all(verdict || eq(row.inputs.label, 'decision_time', 'inputs.label'), basisVerified(d['basis.json'], id));
      },
    },
    execution_stamp: {
      files: ['lineage.json', 'attribution.json', 'deploys.json'],
      judge: (d) => {
        const { row, verdict } = attributionRow(d['attribution.json'], d['lineage.json'].decision_id);
        return all(verdict || (Array.isArray(row.not_recorded_at_execution) && row.not_recorded_at_execution.length ? pass('Execution-time facts read not_recorded.') : unv('not_recorded_at_execution is empty or absent.')),
          eq(d['deploys.json'].backfilled, false, 'backfilled'), Array.isArray(d['deploys.json'].render_deploys) ? pass(`${d['deploys.json'].render_deploys.length} intervening deploy(s) on Render's record.`) : unv('The Render deploy record is not on file.'));
      },
    },
    fill_risk: {
      files: ['lineage.json', 'basis.json', 'trader.json', 'lifecycle-evidence.json'],
      judge: (d) => {
        const l = d['lineage.json'];
        const tv = d['trader.json'];
        const fill = causalFill(d['basis.json'], l.client_order_id, l.sent_at);
        if (fill.result !== 'PASS') return fill;
        const held = positionsOf(tv, l.decision_id);
        if (!held.length) return unv('No position from this decision is in the capture.');
        const open = arr(tv.results.open_positions, 'open_positions').filter((p) => p.decision_id === l.decision_id);
        return all(fill, ...open.map((p) => (present(p.stop_loss_price) ? pass('The open position carries its stop.') : fail('The open position carries no stop.'))), pass(`${held.length} position(s) trace to the decision.`), eq(d['lifecycle-evidence.json'].risk_management_observed, true, 'risk_management_observed'));
      },
    },
    closure_status: {
      files: ['lineage.json', 'trader.json', 'basis.json'],
      judge: (d) => {
        const l = d['lineage.json'];
        const closed = arr(d['trader.json'].results.closed_positions, 'closed_positions').filter((p) => p.decision_id === l.decision_id);
        if (!closed.length) return pass('Closure pending: reported apart, and it blocks nothing.');
        const ids = new Set(closed.map((p) => p.position_id));
        const exits = arr(d['basis.json'].execution.exits, 'exits').filter((e) => ids.has(e.position_id));
        if (exits.length < closed.length) return unv('A closed position has no exit on the basis record.');
        return exits.some((e) => !NATURAL_EXITS.has(e.reason)) ? fail('An exit is not a natural stop, target, expiry or close.') : pass('Closure observed, by a natural exit.');
      },
    },
  },
  b3: {
    repeat_restart: {
      files: ['run-log-repeat.json', 'run-log-restart.json', 'desk-controls-before.json', 'desk-controls-repeat.json', 'desk-controls-restart.json'],
      judge: (d, c) => {
        const t = ['before', 'repeat', 'restart'].map((n) => atOf(d[`desk-controls-${n}.json`].at));
        return all(pilotLine(d['run-log-repeat.json'], false, c), pilotLine(d['run-log-restart.json'], false, c), t.every(Number.isFinite) && t[0] < t[1] && t[1] < t[2] ? pass('Before, repeat and restart are read in order.') : unv('The three reads are not on record in order.'));
      },
    },
    idempotency: {
      files: ['trader-before.json', 'desk-controls-before.json', 'trader-after.json', 'desk-controls-repeat.json', 'trader-restart.json', 'desk-controls-restart.json'],
      judge: (d) => all(sameEffects(d['trader-before.json'], d['desk-controls-before.json'], d['trader-after.json'], d['desk-controls-repeat.json'], 'The repeat run'), sameEffects(d['trader-before.json'], d['desk-controls-before.json'], d['trader-restart.json'], d['desk-controls-restart.json'], 'The restart')),
    },
    uncertainty: { files: ['desk-controls-before.json', 'desk-controls-restart.json'], judge: (d) => uncertainStays(d['desk-controls-before.json'], d['desk-controls-restart.json']) },
    separate_results: {
      files: ['trader-restart.json'],
      judge: (d, c) => {
        const s = c.separate();
        return Object.values(s).includes('failed') ? fail('One of the separate results reads failed.') : pass(`Reported apart: ${Object.entries(s).map(([k, v]) => `${k} ${v}`).join(', ')}. Hosted restart stays UNVERIFIED unless separately authorized and observed.`);
      },
    },
  },
  cutover: {
    approval: { files: ['approval.json'], judge: (d) => all(owner(d['approval.json'], [['hosted_activation', true], ['credentials', true], ['recurring_cost', true]]), Number.isFinite(atOf(d['approval.json'].approved_at)) ? pass('The approval carries its time.') : unv('The approval carries no time.')) },
    host_installed: {
      files: ['service.json'],
      judge: (d) => {
        const s = d['service.json'];
        return all(eq(s.name, 'cryptoresearch-runner', 'the service'), eq(s.stayed_suspended_until_cutover, true, 'suspended until the cutover'), owner(s.first_run, [['preflight_ok', true], ['revision_match', true], ['runner_id', 'render-ops1'], ['post_sighting', true], ['heartbeat_delivered', true]]));
      },
    },
    kill_drill: { files: ['kill-drill.json'], judge: (d) => { const k = d['kill-drill.json']; return all(hasAll(k, ['attempt_id']), owner(k, [['saves_after_cancel', 0], ['completes_after_cancel', 0], ['claim_stayed_dispatched', true], ['sessions_grew', false], ['pc_task_disabled', true], ['cron_suspended', true], ['reconciled_by_eric', true]])); } },
    desk_down: { files: ['desk-down.json'], judge: (d) => (present(d['desk-down.json'].ci_run_id) || Number.isInteger(d['desk-down.json'].ci_run_id) ? pass('The CI run ID is on record.') : unv('No CI run ID is on record.')) },
    single_runner: {
      files: ['pc-task.json', 'service.json', 'operations.json'],
      judge: (d) => {
        const read = atOf(d['pc-task.json'].observed_at);
        const resumed = atOf(d['service.json'].resumed_at);
        if (!Number.isFinite(read) || !Number.isFinite(resumed)) return unv('The read of the PC task or the Resume has no usable time.');
        return all(eq(d['pc-task.json'].pilot.state, 'Disabled', 'the PC task'), read < resumed ? pass('It read Disabled before the Resume.') : fail('The PC task was not read Disabled before the Resume.'), owner(d['operations.json'], [['stop_veto_verified', true], ['failure_visibility_verified', true], ['recovery_verified', true], ['suspend_first_rollback_verified', true]]));
      },
    },
    runner_alive: { files: ['service.json', 'desk-controls-2h.json', 'desk-controls-6h.json', 'desk-controls-24h.json', 'healthchecks.json'], judge: (d) => all(pollAt(d['desk-controls-2h.json'], d['service.json'].resumed_at, 2), pollAt(d['desk-controls-6h.json'], d['service.json'].resumed_at, 6), pollAt(d['desk-controls-24h.json'], d['service.json'].resumed_at, 24), eq(d['healthchecks.json'].missed_periods, 0, 'missed Healthchecks periods')) },
    lifecycle_proven: {
      files: ['lifecycle.json'],
      judge: (d, c) => {
        const l = d['lifecycle.json'];
        return all(hasAll(l, ['project_id', 'report_id', 'receipt_id']), scope(l, c), owner(l, [['runner_id', 'render-ops1'], ['pc_task_disabled', true], ['receipt_intact', true]]), l.mandate_evaluation === 'granted' || l.mandate_evaluation === 'evaluated_not_granted' ? pass('The mandate\'s sweep evaluated it.') : unv('The mandate\'s evaluation is not on record.'));
      },
    },
    // Each of the last two reads the book, never the record's own word.
    fill_proven: {
      files: ['lifecycle.json'], optional: ['basis-hosted.json'],
      judge: (d) => {
        const l = d['lifecycle.json'];
        if (l.fill === 'failed') return fail('The fill reads failed.');
        if (l.fill !== 'proven') return unv('Fill pending: a held or no-trade result is a correct outcome, never passed.');
        if (!d['basis-hosted.json']) return unv('The record says proven, but no basis read is bound to it.');
        return causalFill(d['basis-hosted.json'], l.client_order_id, l.sent_at);
      },
    },
    closed_outcome_proven: {
      files: ['lifecycle.json'], optional: ['trader-hosted.json'],
      judge: (d) => {
        const l = d['lifecycle.json'];
        if (l.closed_outcome === 'failed') return fail('The closed outcome reads failed.');
        if (l.closed_outcome !== 'proven') return unv('Closed outcome pending: that position has not closed naturally.');
        if (!d['trader-hosted.json']) return unv('The record says proven, but no Paper Book read is bound to it.');
        const closed = arr(d['trader-hosted.json'].results.closed_positions, 'closed_positions').filter((p) => p.decision_id === l.decision_id);
        if (!closed.length) return unv('No closed position from that decision is in the capture.');
        const exits = closed.flatMap((p) => arr(p.exits, 'exits'));
        return !exits.length || exits.some((e) => !NATURAL_EXITS.has(e.reason)) ? fail('A close is not natural.') : pass('That position closed by a natural exit on the Paper Book.');
      },
    },
  },
};
const parseMembers = (bundle, names) => {
  const d = {};
  for (const name of names) {
    const bytes = bundle.records.get(name);
    if (!bytes) continue;
    try { d[name] = name.endsWith('.json') ? jsonOf(bytes) : textOf(bytes); } catch (_) { d[name] = undefined; }
  }
  return d;
};
// Every gate either reads bound records or says what it lacks: no gate defaults to success.
function readGates(report, step, bundle, observation, ctx) {
  const cited = step === 'cutover' ? OPS1 : BLUEPRINT;
  for (const [id, criterion] of GATES[step]) {
    const reader = READERS[step][id];
    const gate = `${step}:${id}`;
    const missing = bundle ? reader.files.filter((f) => !bundle.records.has(f)) : reader.files;
    if (!bundle || missing.length) {
      addCheck(report, gate, criterion, 'UNVERIFIED', bundle ? `Not bound in the manifest: ${missing.join(', ')}.` : 'No verified evidence bundle for this step.', [cited], observation, null, false);
      continue;
    }
    const names = [...reader.files, ...(reader.optional || [])];
    const d = parseMembers(bundle, names);
    const sources = names.filter((f) => bundle.records.has(f)).map((f) => `${bundle.folder}/${f}`);
    const onEric = reader.files.some((f) => OWNER_RECORDS.has(f));
    const label = observation === 'fixture' ? 'fixture' : onEric ? 'owner_record' : 'offline_record';
    if (reader.files.some((f) => d[f] === undefined)) {
      addCheck(report, gate, criterion, 'UNVERIFIED', 'A bound record is malformed; nothing is reconstructed from it.', sources, label);
      continue;
    }
    let verdict;
    try { verdict = reader.judge(d, { baseline: bundle.manifest.baseline, project: report.project_id, prior: ctx.prior, separate: () => separateResults(step, report, ctx, bundle) }); }
    catch (_) { verdict = unv('A required field is not on record in the shape the desk writes.'); }
    addCheck(report, gate, criterion, verdict.result, onEric && verdict.result === 'PASS' ? `${verdict.words} Rests on Eric's own record.` : verdict.words, sources, label);
  }
}
// Only records a gate reads are scanned: a saved test log rightly mentions markers.
function gateTexts(step, bundle) {
  const out = [];
  for (const reader of Object.values(READERS[step])) for (const f of [...reader.files, ...(reader.optional || [])]) if (bundle.records.has(f) && !out.some(([n]) => n === f)) out.push([f, textOf(bundle.records.get(f))]);
  const narrativeName = NARRATIVES[step];
  if (bundle.records.has(narrativeName)) out.push([narrativeName, textOf(bundle.records.get(narrativeName))]);
  return out;
}
function checkAnchor(report, step, bundle, observation, fixture, texts) {
  const sources = [`${bundle.folder}/manifest.json`];
  if (fixture) return addCheck(report, `${step}:anchor`, 'A receipt merged on origin/main names this manifest\'s SHA-256.', 'UNVERIFIED', 'A fixture is never anchored as an operating record.', sources, observation, null, false);
  const declared = FIXTURE_WORDS.has(String(bundle.manifest.provenance).toLowerCase());
  const marked = texts.some(([, t]) => FICTION.test(t));
  if (declared || marked) return addCheck(report, `${step}:anchor`, 'A receipt merged on origin/main names this manifest\'s SHA-256.', marked && bundle.anchored ? 'FAIL' : 'UNVERIFIED', marked && bundle.anchored ? 'This bundle is anchored, but its records carry fictional markers.' : 'This bundle reads as a fixture: it proves code paths, never operation.', sources, observation);
  return addCheck(report, `${step}:anchor`, 'A receipt merged on origin/main names this manifest\'s SHA-256.', bundle.anchored ? 'PASS' : 'UNVERIFIED', bundle.anchored ? 'Eric\'s merged receipt vouches for these bytes. It is not a cryptographic attestation.' : 'No receipt merged on origin/main (as last fetched) names this manifest: declaring a live run is only a declaration. Merge a receipt under docs/engineering that names its SHA-256.', sources, observation);
}
function checkSecrets(report, step, bundle, observation, texts, env) {
  const values = Object.entries(env).filter(([k, v]) => SECRET_ENV.test(k) && typeof v === 'string' && v.length >= 8).map(([, v]) => v);
  const hits = texts.filter(([, t]) => SECRET_SHAPES.some((re) => re.test(t)) || values.some((v) => t.includes(v))).map(([n]) => n);
  addCheck(report, `${step}:no_secret_values`, 'Blueprint §6: values of secrets never go in the evidence.', hits.length ? 'FAIL' : 'PASS', hits.length ? `A credential-shaped value is in: ${hits.join(', ')}. It is not repeated here; rotate it and rewrite the record.` : 'No credential-shaped value in the records read.', [`${bundle.folder}/manifest.json`], observation);
}
// One step's records, without the current-revision checks: earlier steps are
// judged on what they closed with, since the canon expects later deploys.
function evaluateStep(report, step, root, ctx) {
  const { observation, fixture, revision, committed, project, env } = ctx;
  const bundle = step === 'r0' ? checkR0(report, root, committed[R0_RECEIPT], observation, revision, fixture) : checkBundle(report, root, step, observation, revision, fixture);
  if (step === 'b0') checkB0(report, root, observation, project);
  const narrativeName = NARRATIVES[step];
  if (bundle && bundle.records.has(narrativeName)) addCheck(report, 'narrative', `${narrativeName} is written, as the runbook asks.`, 'PASS', 'Its bytes are inventoried under the manifest; its words are not interpreted.', [`${bundle.folder}/${narrativeName}`], observation);
  // R0's record is its committed receipt, so only B0 onward must bind a narrative.
  else if (bundle && step !== 'r0') addCheck(report, 'narrative', `${narrativeName} is written, as the runbook asks.`, 'UNVERIFIED', 'It is not bound in the manifest.', [`${bundle.folder}/manifest.json`], observation, null, false);
  else if (!bundle && evidenceFile(report, root, narrativeName, observation)) addCheck(report, 'narrative', 'A human-readable evidence file is not itself proof of its claims.', 'UNVERIFIED', 'Narrative bytes inventoried only; no success words or booleans are trusted.', [narrativeName], observation);
  if (bundle) {
    const texts = gateTexts(step, bundle);
    checkAnchor(report, step, bundle, observation, fixture, texts);
    checkSecrets(report, step, bundle, observation, texts, env);
  }
  readGates(report, step, bundle, observation, ctx);
  return bundle;
}
function separateResults(step, report, ctx, bundle) {
  const of = (id) => (report.checks.find((c) => c.id === id) || {}).result;
  if (step === 'cutover') return Object.fromEntries(['host_installed', 'runner_alive', 'lifecycle_proven', 'fill_proven', 'closed_outcome_proven'].map((id) => [id, proofWord(of(`cutover:${id}`))]));
  if (step !== 'b3') return null;
  const prior = ctx.prior;
  const priorGate = (s, id) => (prior[s] && prior[s].checks.find((c) => c.id === `${s}:${id}`) || {}).result;
  let closed = 0;
  let reduced = 0;
  try {
    if (bundle && bundle.records.has('trader-restart.json')) {
      const tv = jsonOf(bundle.records.get('trader-restart.json'));
      closed = arr(tv.results.closed_positions, 'closed').length;
      reduced = positionsOfAll(tv).filter((p) => Array.isArray(p.exits) && p.exits.length).length;
    }
  } catch (_) { closed = 0; reduced = 0; }
  const restart = (bundle && ['b3:repeat_restart', 'b3:idempotency'].map(of)) || [];
  return { cancellation: proofWord(priorGate('b1', 'cancellation')), live_fill: proofWord(priorGate('b2', 'fill_risk')), risk_reduction: reduced ? 'proven' : 'pending', closure: closed ? 'proven' : 'pending',
    restart: restart.includes('FAIL') ? 'failed' : restart.length && restart.every((r) => r === 'PASS') ? 'proven' : 'pending' };
}
function checkPrior(report, step, prior, bundle, observation, ranInEvidence) {
  const earlier = STEPS.slice(0, STEPS.indexOf(step));
  if (!earlier.length) return;
  const criterion = `Prior gates (${earlier.join(', ')}) have authentic acceptance evidence.`;
  if (!ranInEvidence) return addCheck(report, 'prerequisites', criterion, 'UNVERIFIED', 'Earlier gate verdicts were not independently verified; report files cannot establish them.', [BLUEPRINT], observation, null, false);
  report.prerequisite_results = Object.fromEntries(earlier.map((s) => [s, { result: prior[s].result, not_passing: prior[s].checks.filter((c) => c.result !== 'PASS').map((c) => c.id) }]));
  const sources = earlier.map((s) => `${FOLDERS[s]}/manifest.json`);
  const closedAt = earlier.map((s) => prior[s].bundle && prior[s].bundle.manifest.closed_at).filter(Boolean);
  if (bundle) closedAt.push(bundle.manifest.closed_at);
  if (closedAt.some((t, i) => i && Date.parse(t) < Date.parse(closedAt[i - 1]))) return addCheck(report, 'prerequisites', criterion, 'FAIL', 'The steps\' bundles closed out of order.', sources, observation);
  const open = earlier.filter((s) => prior[s].result !== 'PASS');
  return addCheck(report, 'prerequisites', criterion, open.length ? 'UNVERIFIED' : 'PASS', open.length ? `Not proven first: ${open.join(', ')}. This step is not proven past them.` : 'Each earlier step\'s own records read PASS.', sources, observation);
}
function checkBaseline(report, bundle, revision, observation) {
  const criterion = 'No application code changed since this proof closed; a receipt\'s own docs-only merge does not stale it.';
  if (!bundle) return addCheck(report, 'baseline_current', criterion, 'UNVERIFIED', 'No verified bundle names a baseline.', [], observation, null, false);
  const base = bundle.manifest.baseline;
  if (!revision.onMain(base)) return addCheck(report, 'baseline_current', criterion, 'UNVERIFIED', 'The proof\'s baseline is not on origin/main as last fetched.', ['git:origin/main'], observation);
  const changed = revision.changedSince(base);
  if (changed === null) return addCheck(report, 'baseline_current', criterion, 'UNVERIFIED', 'The difference since the baseline does not read.', ['git:HEAD'], observation);
  const code = changed.filter((f) => !DOCS_ONLY.test(f));
  return addCheck(report, 'baseline_current', criterion, code.length ? 'UNVERIFIED' : 'PASS', code.length ? `${code.length} code file(s) changed since this proof: refresh the runner and repeat from R0.` : 'Only docs changed since this proof closed.', ['git:HEAD'], observation);
}
function checkB0(report, root, observation, project) {
  const bytes = evidenceFile(report, root, 'B0/controls.json', observation);
  if (!bytes) return;
  let c;
  try { c = jsonOf(bytes); } catch (_) {
    addCheck(report, 'b0:controls', 'Desk controls JSON is intact.', 'FAIL', 'Malformed JSON; no replacement snapshot is constructed.', ['B0/controls.json'], observation);
    return;
  }
  if (!c || c.format !== 'cr-desk-controls@1' || !validTime(c.at) || Date.parse(c.at) > Date.parse(report.verified_at) || !Array.isArray(c.projects) || c.projects.some((p) => !p || typeof p !== 'object')) {
    addCheck(report, 'b0:controls', 'Desk controls have their canonical format and observation time.', 'UNVERIFIED', 'Required shape or timestamp is missing.', ['B0/controls.json'], observation);
    return;
  }
  const admission = c.authority && c.authority.admission;
  const disabled = admission && admission.enabled === false && admission.on === false;
  const enabled = admission && (admission.enabled === true || admission.on === true);
  addCheck(report, 'b0:admission', 'B0 admission is switched off and read back.', disabled ? 'PASS' : enabled ? 'FAIL' : 'UNVERIFIED', disabled ? 'Offline controls record admission off.' : enabled ? 'Offline controls record admission enabled.' : 'Admission state is unknown.', ['B0/controls.json'], observation, c.at);
  const unknown = !c.dispatch || c.dispatch.projects_unreadable !== null || c.projects.some((p) => !isProjectId(p.project_id) || !p.dispatch || !['none', 'claimed', 'released', 'expired', 'reconcile'].includes(p.dispatch.state) || typeof p.dispatch.reconcile !== 'boolean');
  const reconcile = c.projects.some((p) => p.dispatch && (p.dispatch.reconcile === true || p.dispatch.state === 'reconcile'));
  addCheck(report, 'b0:claims', 'Every pilot claim is accounted for; no unresolved reconciliation remains.', reconcile ? 'FAIL' : unknown ? 'UNVERIFIED' : 'PASS', reconcile ? 'An unresolved claim requires Eric.' : unknown ? 'Claim coverage is incomplete.' : 'No reconciliation is reported in this offline snapshot.', ['B0/controls.json'], observation, c.at);
  if (project && !c.projects.some((p) => p.project_id === project)) addCheck(report, 'b0:project', 'Selected project is covered by the controls readback.', 'UNVERIFIED', 'Selected project is absent; no fallback to another project.', ['B0/controls.json'], observation, c.at);
}
function redact(value, env) {
  const secrets = Object.entries(env).filter(([k, v]) => SECRET_ENV.test(k) && typeof v === 'string' && v).map(([, v]) => v).sort((a, b) => b.length - a.length);
  const visit = (v) => typeof v === 'string' ? secrets.reduce((s, secret) => s.split(secret).join('[redacted]'), v)
    : Array.isArray(v) ? v.map(visit) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, item]) => [k, visit(item)])) : v;
  return visit(value);
}

async function verify(options, deps = {}) {
  const { step, project = null, mode = 'development', expectedRevision = null, base = null, offline = false, fixture = false } = options;
  if (!STEPS.includes(step) || !['development', 'post-merge'].includes(mode)) refuse('USAGE', 'prove-autonomy needs r0|b0|b1|b2|b3|cutover and a valid mode.');
  if (project !== null && !isProjectId(project)) refuse('BAD_ID', 'Use a canonical project ID.');
  for (const rev of [base, expectedRevision]) if (rev !== null && (typeof rev !== 'string' || !SHA.test(rev))) refuse('USAGE', 'Revision options require a full lowercase 40-character SHA.');
  if (mode === 'post-merge' && !expectedRevision) refuse('USAGE', 'Post-merge proof requires --expected-revision=<merge SHA>.');
  if (options.desk !== undefined && options.desk !== 'online') refuse('USAGE', 'This verifier targets --desk=online only; offline evidence is labeled separately.');
  const now = deps.now || (() => new Date().toISOString());
  const revision = gitRevision(deps.repoRoot || ROOT, base, deps);
  const evidenceRoot = options.evidence ? absolute(options.evidence) : null;
  if (evidenceRoot) {
    try { noLinks(evidenceRoot); } catch (e) { if (e.code === 'BAD_PATH') throw e; }
  }
  const observation = fixture ? 'fixture' : 'offline_record';
  const report = { format: FORMAT, step, result: null, desk: 'online', project_id: project, mode, verified_at: now(), evidence_root: evidenceRoot,
    application_revision: { head: revision.head, base: revision.base, base_source: revision.base_source, origin_main: revision.origin_main, worktree_clean: revision.worktree_clean, expected_deployed: expectedRevision },
    sources: [], checks: [],
    limitations: ['Offline files are never identified as live records. Hashes bind bytes, not origin; Eric\'s merged receipt vouches for them, which is not a cryptographic attestation.', 'No operating drill, task query, authenticated desk API, Render control-plane query or heartbeat query is executed.', 'Gates judge the records supplied. Where the desk has no read, a gate rests on Eric\'s own record and is labeled owner_record. Narratives and partial snapshots never discharge a gate.'],
  };
  if (mode !== 'post-merge') addCheck(report, 'proof_mode', 'An operating PASS is read only in post-merge mode, on the merged revision.', 'UNVERIFIED', 'Development mode never certifies a milestone.', [], 'static_configuration', null, false);
  const ancestry = revision.base_is_ancestor === false ? 'FAIL' : revision.head && revision.base && revision.base_is_ancestor === true ? 'PASS' : 'UNVERIFIED';
  addCheck(report, 'development_base', 'The audited application revision descends from the recorded base.', ancestry, ancestry === 'PASS' ? 'Feature HEAD may differ from main and deployment; this is not a production failure.' : ancestry === 'FAIL' ? 'Recorded base is not an ancestor of the audited revision.' : 'Base ancestry could not be established.', ['git:HEAD', 'git:base']);
  addCheck(report, 'checkout_revision', 'The local checkout has no uncommitted differences from the audited revision.', revision.worktree_clean === true ? 'PASS' : 'UNVERIFIED', revision.worktree_clean === true ? 'Working checkout is clean.' : 'Checkout is dirty or unreadable; HEAD alone does not identify its implementation bytes.', ['git:status']);
  if (fixture) addCheck(report, 'fixture', 'Synthetic verification never establishes an operating milestone.', 'UNVERIFIED', 'Fixture input selected; it cannot be promoted to live evidence.', [], 'fixture', null, false);
  const health = offline || fixture ? { state: 'not_executed' } : await healthRead({ ...deps, now });
  report.deployment = health;
  if (health.sha256) report.sources.push({ path: HEALTHZ, sha256: health.sha256, observed_at: health.at, observation: 'live_readback' });
  const deployed = !expectedRevision || health.state !== 'observed' ? 'UNVERIFIED' : health.revision === expectedRevision ? 'PASS' : 'FAIL';
  addCheck(report, 'deployment_revision', 'The live /healthz reports the explicitly expected merged revision; availability is not pipeline health.', deployed, !expectedRevision ? 'Expected deployed revision not specified; feature HEAD is not substituted.' : health.state !== 'observed' ? 'Deployment revision is unavailable or was not queried.' : deployed === 'PASS' ? 'Reported deployed revision matches the expected merge.' : 'Reported deployed revision differs from the expected merge.', [HEALTHZ], health.state === 'not_executed' ? 'static_configuration' : 'live_readback', health.at, health.state !== 'not_executed');
  if (mode === 'post-merge') {
    const merged = revision.head === expectedRevision && revision.head === revision.origin_main;
    addCheck(report, 'merged_revision', 'The audited checkout is the expected merged revision, at origin/main as last fetched.', merged ? 'PASS' : 'UNVERIFIED', merged ? 'Auditing the expected merge itself.' : 'This checkout is not the expected merge at origin/main; no operational conclusion is inferred.', ['git:HEAD', 'git:origin/main']);
  }
  const committed = {};
  for (const rel of [BLUEPRINT, READINESS, OPS1, R0_RECEIPT]) {
    const text = revision.committed(rel);
    if (text !== null) {
      committed[rel] = text;
      report.sources.push({ path: rel, revision: revision.head, sha256: hash(text), hash_basis: 'committed UTF-8 bytes', observation: 'static_configuration' });
    }
  }
  const anchors = { r0: '### R0. Align the PC', b0: '### B0. Prerequisites', b1: '### B1. Pre-eligible-hour', b2: '### B2. One natural mandate', b3: '### B3. Restart', cutover: '### Ops-1 drill and cutover' };
  addCheck(report, 'canonical_source', 'Canonical acceptance criteria are available at the audited revision.', (committed[BLUEPRINT] || '').includes(anchors[step]) && committed[READINESS] && committed[OPS1] ? 'PASS' : 'UNVERIFIED', 'Criteria summarize cited merged runbooks; source hashes and revision are recorded.', [BLUEPRINT, READINESS, OPS1]);
  const env = deps.env || process.env;
  const ctx = { observation, fixture, revision, committed, project, env, prior: {} };
  // Earlier steps first, each on its own records, so a later step can read them.
  if (evidenceRoot) {
    for (const s of STEPS.slice(0, STEPS.indexOf(step))) {
      const sub = { checks: [], sources: [], project_id: project, verified_at: report.verified_at };
      const bundle = evaluateStep(sub, s, evidenceRoot, ctx);
      ctx.prior[s] = { result: aggregate(sub.checks.map((c) => c.result)), checks: sub.checks, bundle, records: bundle ? bundle.records : new Map() };
      report.sources.push(...sub.sources);
    }
  }
  const bundle = evidenceRoot ? evaluateStep(report, step, evidenceRoot, ctx) : null;
  if (!evidenceRoot) readGates(report, step, null, observation, ctx);
  if (bundle) report.provenance = { manifest_sha256: bundle.manifest_sha256, baseline: bundle.manifest.baseline, closed_at: bundle.manifest.closed_at, anchored_by_merged_receipt: bundle.anchored === true, owner_record_checks: report.checks.filter((c) => c.observation === 'owner_record').map((c) => c.id) };
  if (mode === 'post-merge' && !fixture) checkBaseline(report, bundle, revision, observation);
  checkPrior(report, step, ctx.prior, bundle, observation, Boolean(evidenceRoot));
  const separate = separateResults(step, report, ctx, bundle);
  if (separate) report.separate_results = separate;
  report.result = aggregate(report.checks.map((c) => c.result));
  report.exit_code = { PASS: 0, FAIL: 1, UNVERIFIED: 2 }[report.result];
  report.checks_executed = report.checks.filter((c) => c.executed).map((c) => c.id);
  report.checks_not_executed = report.checks.filter((c) => !c.executed).map((c) => ({ id: c.id, reason: c.reason }));
  report.missing_evidence = report.checks.filter((c) => c.result === 'UNVERIFIED').map((c) => ({ id: c.id, criterion: c.criterion }));
  const onEric = report.checks.filter((c) => c.observation === 'owner_record').length;
  report.reason = report.result === 'FAIL' ? 'Observed evidence contradicts a required check; missing checks remain unverified.' : report.result === 'PASS' ? `All ${report.checks.length} required checks are supported by the bound records, ${onEric} of them on Eric's own record, under a receipt merged on origin/main.` : 'Required operating evidence is missing, inaccessible or not independently verifiable. No operating success is claimed.';
  return redact(report, env);
}
function outputRoot(out, { now = new Date(), home = os.homedir(), forbiddenRoots = [] } = {}) {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
  const selected = absolute(out || path.join(home, 'Documents', 'CryptoResearch-evidence', `operating-proof-${date}`));
  const forbidden = [ROOT, DEFAULT_ROOT, process.env.CR_WORKSPACE, ...forbiddenRoots].filter(Boolean).map((p) => path.resolve(p));
  if (selected === path.parse(selected).root || forbidden.some((p) => within(p, selected))) refuse('BAD_PATH', 'Output must be outside application and desk-state directories.');
  for (let cur = selected; ; cur = path.dirname(cur)) {
    if (fs.existsSync(path.join(cur, 'workspace.json')) || fs.existsSync(path.join(cur, '.git')) || path.basename(cur).toLowerCase() === '.git') refuse('BAD_PATH', 'Output cannot be placed in a desk workspace or application checkout.');
    if (cur === path.dirname(cur)) break;
  }
  noLinks(selected, true);
  if (!fs.lstatSync(selected).isDirectory()) refuse('BAD_PATH', 'Output root must be a directory.');
  return selected;
}
function render(report) {
  return [`${report.step.toUpperCase()}: ${report.result}`, report.reason, `Verified at (UTC): ${report.verified_at}`, `Audited revision: ${report.application_revision.head || 'UNKNOWN'}`, `Mode: ${report.mode}`, '',
    ...report.checks.flatMap((c) => [`${c.result} ${c.id}: ${c.criterion}`, `  ${c.reason}`, `  Observation: ${c.observation}${c.observed_at ? ` at ${c.observed_at}` : ''}; sources: ${c.sources.join(', ') || 'none'}`]), '',
    ...(report.separate_results ? ['Reported apart, never merged into one:', ...Object.entries(report.separate_results).map(([k, v]) => `  ${k}: ${v}`), ''] : []),
    ...(report.prerequisite_results ? ['Earlier steps, each on its own records:', ...Object.entries(report.prerequisite_results).map(([k, v]) => `  ${k}: ${v.result}`), ''] : []),
    ...report.limitations, '', 'Complete provenance, hashes, missing evidence and unexecuted checks: metadata.json.', ''].join('\n');
}
function writeBundle(report, out, deps = {}) {
  if (!STEPS.includes(report.step) || !['PASS', 'FAIL', 'UNVERIFIED'].includes(report.result)) refuse('INVALID', 'Invalid proof report.');
  const root = outputRoot(out, deps);
  const runId = (deps.runId || (() => crypto.randomUUID()))();
  if (typeof runId !== 'string' || !/^[a-z0-9-]{8,80}$/.test(runId)) refuse('BAD_PATH', 'Unsafe run identifier.');
  const dir = path.join(root, `proof-${report.step}-${runId}`);
  noLinks(root);
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (_) { refuse('ALREADY_EXISTS', 'Run directory could not be created exclusively; existing evidence was not changed.'); }
  const textName = report.step === 'cutover' ? 'cutover.txt' : `${report.step.toUpperCase()}.txt`;
  const files = [[textName, render(report)], ['metadata.json', JSON.stringify(report, null, 2) + '\n']];
  const manifest = { format: 'cr-autonomy-proof-bundle@1', run_id: runId, step: report.step, result: report.result, verified_at: report.verified_at,
    files: files.map(([name, text]) => ({ path: name, bytes: Buffer.byteLength(text), sha256: hash(text) })) };
  files.push(['manifest.json', JSON.stringify(manifest, null, 2) + '\n']);
  // Atomic create without replacement. The last manifest marks completeness;
  // a crash before it leaves an incomplete bundle, never a resumed success.
  for (const [name, text] of files) {
    noLinks(dir);
    const tmp = path.join(dir, `${name}.tmp-${crypto.randomUUID()}`);
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.linkSync(tmp, path.join(dir, name));
    fs.unlinkSync(tmp);
  }
  return { directory: dir, report: path.join(dir, textName), metadata: path.join(dir, 'metadata.json'), manifest: path.join(dir, 'manifest.json') };
}
async function command(step, flags, deps = {}) {
  const allowed = new Set(['desk', 'project', 'out', 'evidence', 'mode', 'base', 'expected_revision', 'offline', 'fixture', 'workspace']);
  for (const [key, value] of Object.entries(flags)) if (!allowed.has(key) || Array.isArray(value) || (['offline', 'fixture'].includes(key) ? value !== true : typeof value !== 'string' || !value)) refuse('USAGE', 'Unsupported, repeated or malformed prove-autonomy option.');
  const report = await verify({ step, desk: flags.desk, project: flags.project, evidence: flags.evidence, mode: flags.mode, base: flags.base, expectedRevision: flags.expected_revision, offline: flags.offline, fixture: flags.fixture }, deps);
  const bundle = writeBundle(report, flags.out, { ...deps, forbiddenRoots: [flags.workspace, deps.repoRoot, ...(deps.forbiddenRoots || [])].filter(Boolean) });
  return redact({ ...report, bundle }, deps.env || process.env);
}
module.exports = { FORMAT, STEPS, GATES, READERS, FOLDERS, NARRATIVES, OWNER_RECORDS, SECRET_ENV, SECRET_SHAPES, FICTION, MAX_FILE, absolute, noLinks, readBounded, textOf, jsonOf, BLUEPRINT, READINESS, OPS1, R0_RECEIPT, HEALTHZ, aggregate, usableAt, gitRevision, healthRead, verify, outputRoot, render, writeBundle, command };
