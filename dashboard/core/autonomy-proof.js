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

const FORMAT = 'cr-autonomy-proof@1';
const ROOT = path.resolve(__dirname, '../..');
const BLUEPRINT = 'docs/engineering/AUTONOMY_COMPLETION_BLUEPRINT_2026-11-03.md';
const READINESS = 'docs/engineering/BOUNDED_PAPER_READINESS.md';
const OPS1 = 'docs/engineering/OPS1_RENDER_CRON.md';
const R0_RECEIPT = 'docs/engineering/OPERATING_PROOF_R0_2026-11-03.md';
const HEALTHZ = 'https://cryptoresearch.onrender.com/healthz';
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const MAX_FILE = 1024 * 1024;
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
    const bytes = Buffer.alloc(MAX_FILE + 1);
    let size = 0;
    for (;;) {
      const n = fs.readSync(fd, bytes, size, bytes.length - size, null);
      size += n;
      if (size > MAX_FILE) refuse('INVALID', 'Evidence exceeds the file limit.');
      if (!n) return bytes.subarray(0, size);
    }
  } finally { fs.closeSync(fd); }
}
const jsonOf = (b) => JSON.parse(b.toString('utf8').replace(/^\uFEFF/, ''));

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
    base_source: base ? 'explicit' : 'local_merge_base', committed: (rel) => git(['show', `HEAD:${rel}`], true) };
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
function checkR0(report, root, receipt, observation) {
  const manifestBytes = evidenceFile(report, root, 'R0/manifest.json', observation);
  if (!manifestBytes) return;
  const pin = /manifest\.json`[\s\S]*?SHA-256 is\s*`([a-f0-9]{64})`/.exec(receipt || '');
  if (!pin || hash(manifestBytes) !== pin[1]) {
    addCheck(report, 'r0:manifest', 'R0 manifest matches its committed receipt.', pin ? 'FAIL' : 'UNVERIFIED', pin ? 'Manifest hash differs from the committed R0 receipt.' : 'No committed manifest pin is available.', ['R0/manifest.json', R0_RECEIPT], observation);
    return;
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
    return;
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
  // discharge the actual later offsite run, so the complete gate stays unknown.
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
  const secrets = Object.entries(env).filter(([k, v]) => /TOKEN|SECRET|PASSWORD|PASSPHRASE|PRIVATE|API_KEY|INGEST_KEY|AUTH|HEALTHCHECK_URL/i.test(k) && typeof v === 'string' && v).map(([, v]) => v).sort((a, b) => b.length - a.length);
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
    limitations: ['Offline files are never identified as live records. Hashes bind bytes, not origin.', 'No operating drill, task query, authenticated desk API, Render control-plane query or heartbeat query is executed.', 'A1 has no complete operating-gate reader: narratives and partial snapshots cannot discharge a gate.'],
  };
  const ancestry = revision.base_is_ancestor === false ? 'FAIL' : revision.head && revision.base && revision.base_is_ancestor === true ? 'PASS' : 'UNVERIFIED';
  addCheck(report, 'development_base', 'The audited application revision descends from the recorded base.', ancestry, ancestry === 'PASS' ? 'Feature HEAD may differ from main and deployment; this is not a production failure.' : ancestry === 'FAIL' ? 'Recorded base is not an ancestor of the audited revision.' : 'Base ancestry could not be established.', ['git:HEAD', 'git:base']);
  addCheck(report, 'checkout_revision', 'The local checkout has no uncommitted differences from the audited revision.', revision.worktree_clean === true ? 'PASS' : 'UNVERIFIED', revision.worktree_clean === true ? 'Working checkout is clean.' : 'Checkout is dirty or unreadable; HEAD alone does not identify its implementation bytes.', ['git:status']);
  if (fixture) addCheck(report, 'fixture', 'Synthetic verification never establishes an operating milestone.', 'UNVERIFIED', 'Fixture input selected; it cannot be promoted to live evidence.', [], 'fixture', null, false);
  const health = offline || fixture ? { state: 'not_executed' } : await healthRead({ ...deps, now });
  report.deployment = health;
  if (health.sha256) report.sources.push({ path: HEALTHZ, sha256: health.sha256, observed_at: health.at, observation: 'live_readback' });
  const deployed = !expectedRevision || health.state !== 'observed' ? 'UNVERIFIED' : health.revision === expectedRevision ? 'PASS' : 'FAIL';
  addCheck(report, 'deployment_revision', 'The live /healthz reports the explicitly expected merged revision; availability is not pipeline health.', deployed, !expectedRevision ? 'Expected deployed revision not specified; feature HEAD is not substituted.' : health.state !== 'observed' ? 'Deployment revision is unavailable or was not queried.' : deployed === 'PASS' ? 'Reported deployed revision matches the expected merge.' : 'Reported deployed revision differs from the expected merge.', [HEALTHZ], health.state === 'not_executed' ? 'static_configuration' : 'live_readback', health.at, health.state !== 'not_executed');
  if (mode === 'post-merge') addCheck(report, 'merged_revision', 'The audited checkout is the expected merged revision.', revision.head === expectedRevision ? 'PASS' : 'UNVERIFIED', revision.head === expectedRevision ? 'Auditing the expected merge itself.' : 'This checkout is not the expected merge; no operational conclusion is inferred.', ['git:HEAD']);
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
  if (evidenceRoot) {
    const name = step === 'cutover' ? 'cutover.txt' : `${step.toUpperCase()}.txt`;
    if (evidenceFile(report, evidenceRoot, name, observation)) addCheck(report, 'narrative', 'A human-readable evidence file is not itself proof of its claims.', 'UNVERIFIED', 'Narrative bytes inventoried only; no success words or booleans are trusted.', [name], observation);
    if (step === 'r0') checkR0(report, evidenceRoot, committed[R0_RECEIPT], observation);
    if (step === 'b0') checkB0(report, evidenceRoot, observation, project);
  }
  for (const [id, criterion] of GATES[step]) addCheck(report, `${step}:${id}`, criterion, 'UNVERIFIED', 'Complete authoritative readbacks for this criterion have not been verified by A1.', [step === 'cutover' ? OPS1 : BLUEPRINT], observation, null, false);
  const earlier = STEPS.slice(0, STEPS.indexOf(step));
  if (earlier.length) addCheck(report, 'prerequisites', `Prior gates (${earlier.join(', ')}) have authentic acceptance evidence.`, 'UNVERIFIED', 'Earlier gate verdicts were not independently verified; report files cannot establish them.', [BLUEPRINT], observation, null, false);
  report.result = aggregate(report.checks.map((c) => c.result));
  report.exit_code = { PASS: 0, FAIL: 1, UNVERIFIED: 2 }[report.result];
  report.checks_executed = report.checks.filter((c) => c.executed).map((c) => c.id);
  report.checks_not_executed = report.checks.filter((c) => !c.executed).map((c) => ({ id: c.id, reason: c.reason }));
  report.missing_evidence = report.checks.filter((c) => c.result === 'UNVERIFIED').map((c) => ({ id: c.id, criterion: c.criterion }));
  report.reason = report.result === 'FAIL' ? 'Observed evidence contradicts a required check; missing checks remain unverified.' : report.result === 'PASS' ? 'All required checks are supported by verified evidence.' : 'Required operating evidence is missing, inaccessible or not independently verifiable. No operating success is claimed.';
  return redact(report, deps.env || process.env);
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
module.exports = { FORMAT, STEPS, GATES, BLUEPRINT, READINESS, OPS1, R0_RECEIPT, HEALTHZ, aggregate, gitRevision, healthRead, verify, outputRoot, render, writeBundle, command };
