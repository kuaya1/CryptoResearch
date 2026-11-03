'use strict';
// Autonomy evidence readback (cr-autonomy-proof@1; Stage 1.5 PR A1): `prove-autonomy`.
//
// It reads the operating-proof records Eric's runbook produces
// (AUTONOMY_COMPLETION_BLUEPRINT_2026-11-03.md §6, OPS1_RENDER_CRON.md §7) and
// says, per step, exactly one of:
//   PASS        the canonical conditions are supported by actual records;
//   FAIL        a record contradicts a required condition;
//   UNVERIFIED  what is needed is missing, unreadable or insufficient.
// A readback verifies evidence. It never starts, simulates or repairs the
// event it reads, and missing evidence never becomes PASS.
//
// What it touches:
//   - reads an evidence bundle: <evidence root>/<STEP>/ with a manifest.json
//     of the shape the R0 bundle set (`format`, `closed_at`, `baseline`,
//     `files[{path,bytes,sha256}]`), plus `provenance`;
//   - runs read-only git in this checkout, never a fetch, so origin/main is
//     "as last fetched";
//   - GETs the desk's public /healthz once, only with --desk=online;
//   - writes one new folder of reports, outside the code and the desk's
//     records, and nothing else. It never opens a workspace.
//
// What PASS does not mean: the bundle's bytes are bound by hash, and a receipt
// merged on origin/main names that manifest's SHA-256. A manifest's own
// `provenance: live_run` is a declaration and never reaches PASS. None of this
// is a cryptographic attestation: Eric's merge is what vouches for the bytes.
// Checks resting on Eric's own record say so (`owner_record`). Passing tests
// prove this code, never a milestone.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { isProjectId } = require('./ids');
const { atomicWrite } = require('./fsx');

const FORMAT = 'cr-autonomy-proof@1';
const BLUEPRINT = 'docs/engineering/AUTONOMY_COMPLETION_BLUEPRINT_2026-11-03.md';
const OPS1 = 'docs/engineering/OPS1_RENDER_CRON.md';
const PASS = 'PASS';
const FAIL = 'FAIL';
const UNVERIFIED = 'UNVERIFIED';
const EXIT = Object.freeze({ [PASS]: 0, [FAIL]: 1, [UNVERIFIED]: 2 });
const STEPS = Object.freeze(['r0', 'b0', 'b1', 'b2', 'b3', 'cutover']);
const SHA_RE = /^[0-9a-f]{40}$/;
const MODEL_RE = /^claude-[a-z0-9-]+$/;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const HOUR_MS = 3600000;
// trader-candles SETTLE_MINUTES: an hour is read only once closed 10 minutes.
const SETTLE_MS = 10 * 60000;
// A clock read back may be a little ahead of this machine's.
const CLOCK_SKEW_MS = 5 * 60000;
const FICTION_RE = /\bFICTIONAL\b|\.example\.invalid\b|dashboard[\\/]+fixtures\b|kind: (?:demo|test|fictional)\b/i;
const FIXTURE_WORDS = new Set(['fixture', 'synthetic', 'test', 'demo', 'fictional']);
const SECRET_RES = [/gh[pousr]_[A-Za-z0-9]{20,}/g, /github_pat_[A-Za-z0-9_]{20,}/g, /sk-ant-[A-Za-z0-9-]{10,}/g, /hc-ping\.com\/[A-Za-z0-9-]{8,}/g, /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/gi];
const SECRET_ENV_RE = /TOKEN|SECRET|PASSWORD|PASSPHRASE|API_KEY|PRIVATE_KEY|OAUTH|HEALTHCHECK_URL|INGEST_KEY|_KEY$/i;
// Names a git child may inherit: none is a credential (Law 1).
const GIT_ENV_KEEP = ['PATH', 'Path', 'SystemRoot', 'windir', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'PATHEXT', 'COMSPEC'];

// ---- Verdicts ----------------------------------------------------------

const pass = (words) => ({ status: PASS, words });
const fail = (words) => ({ status: FAIL, words });
const unv = (words) => ({ status: UNVERIFIED, words });
function all(...vs) {
  if (!vs.length) return unv('Nothing was checked.');
  for (const s of [FAIL, UNVERIFIED]) {
    const hit = vs.filter((v) => v.status === s);
    if (hit.length) return { status: s, words: hit.map((v) => v.words).join(' ') };
  }
  return pass(vs.map((v) => v.words).join(' '));
}
// Absent is UNVERIFIED and different is FAIL: a missing value is never a pass.
function eq(actual, expected, what) {
  if (actual === undefined || actual === null) return unv(`${what} is not on record.`);
  const said = String(actual).slice(0, 120);
  return actual === expected ? pass(`${what}: ${said}.`) : fail(`${what} is ${said}, required ${expected}.`);
}
const atOf = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : NaN;
};
const arr = (v, what) => { if (!Array.isArray(v)) throw new TypeError(`${what} is not a list`); return v; };
const present = (v) => typeof v === 'string' && v.trim() !== '';
const short = (s) => (typeof s === 'string' && SHA_RE.test(s) ? s.slice(0, 7) : String(s));

// ---- Reading records' shapes (every field read here is the desk's own) --

function healthzRevision(text) {
  const m = /^revision ([0-9a-f]{40})\b/m.exec(String(text));
  return m ? m[1] : null;
}
// R0.1 / B0.1: the deployed commit, origin/main and the runner are one commit.
// A missing baseline is missing evidence: nothing can contradict it.
const noBaseline = (baseline) => (SHA_RE.test(String(baseline)) ? null : unv('The manifest names no 40-character baseline to compare with.'));
function revisionsAgree(d, baseline) {
  const none = noBaseline(baseline);
  if (none) return none;
  const r = d['revision-final.json'];
  const fromHealthz = healthzRevision(d['healthz.txt']);
  return all(
    eq(r.healthz_status, 200, '/healthz status'),
    eq(fromHealthz, baseline, 'the raw /healthz revision'),
    eq(r.deployed_sha, baseline, 'the deployed commit'),
    eq(r.origin_main, baseline, 'origin/main'),
    eq(r.runner_head, baseline, 'the runner\'s HEAD'),
  );
}
const orderIn = (tv, coid) => arr(tv.orders, 'orders').find((o) => o.client_order_id === coid) || null;
const positionsOf = (tv, decisionId) => [...arr(tv.results.open_positions, 'open_positions'), ...arr(tv.results.closed_positions, 'closed_positions')].filter((p) => p.decision_id === decisionId);
const isZero = (v) => typeof v === 'string' && /^0(\.0*)?$/.test(v);

function controlsHold(c) {
  return all(eq(c.format, 'cr-desk-controls@1', 'the Desk Controls format'), c.dispatch && c.dispatch.projects_unreadable ? unv(String(c.dispatch.projects_unreadable)) : pass('Its projects read.'));
}
function noReconcile(c) {
  const rows = arr(c.projects, 'projects');
  const open = rows.filter((p) => p.dispatch && p.dispatch.reconcile === true);
  if (open.length) return fail(`A reconcile is open on ${open.map((p) => p.project_id).join(', ')}: Eric's to settle first.`);
  const dark = rows.filter((p) => !p.dispatch || p.dispatch.state === 'unreadable');
  return dark.length ? unv(`The claim on ${dark.map((p) => p.project_id).join(', ')} does not read.`) : pass(`No reconcile among ${rows.length} pilot projects.`);
}
function noUncertainOrder(tv) {
  const bad = arr(tv.orders, 'orders').filter((o) => o.state === 'UNKNOWN' || o.state === 'RECONCILE_REQUIRED');
  return bad.length ? fail(`${bad.length} order(s) await reconciliation.`) : pass('No uncertain order.');
}
function pilotLogLine(line, { dryRun, baseline }) {
  const none = noBaseline(baseline);
  if (none) return none;
  return all(
    eq(line.format, 'cr-pilot-all@1', 'the runner log format'),
    eq(line.dry_run, dryRun, 'dry_run'),
    eq(line.revision && line.revision.runner, baseline, 'the runner revision'),
    eq(line.revision && line.revision.desk, baseline, 'the desk revision the guard read'),
  );
}
// The first causally eligible hour starts at or after the send; it is read
// only once closed and settled (blueprint B1.3).
function usableAt(sentAt) {
  const t = atOf(sentAt);
  return Number.isFinite(t) ? Math.ceil(t / HOUR_MS) * HOUR_MS + HOUR_MS + SETTLE_MS : NaN;
}
function lineageIds(l, names) {
  const bad = names.filter((n) => !present(l[n]) && !Number.isInteger(l[n]));
  return bad.length ? unv(`The lineage names no ${bad.join(', ')}.`) : pass('The lineage names each ID.');
}
function fingerprint(tv, c) {
  const sort = (xs) => xs.slice().sort();
  return {
    orders: sort(arr(tv.orders, 'orders').map((o) => `${o.client_order_id}|${o.intent_id || ''}|${o.state}|${o.filled}`)),
    decisions: sort(arr(tv.requests, 'requests').map((r) => `${r.decision_id}|${r.receipt_id}`)),
    positions: sort(positionsOfAll(tv).map((p) => p.position_id)),
    claims: sort(arr(c.projects, 'projects').map((p) => `${p.project_id}|${(p.dispatch && p.dispatch.attempt_id) || ''}|${(p.dispatch && p.dispatch.claim_state) || ''}|${(p.dispatch && p.dispatch.run_id) || ''}`)),
    reports: sort(arr(c.projects, 'projects').flatMap((p) => Object.values(p.reports || {}).filter(Boolean).map((r) => `${p.project_id}|${r.report_id}`))),
  };
}
function positionsOfAll(tv) { return [...arr(tv.results.open_positions, 'open_positions'), ...arr(tv.results.closed_positions, 'closed_positions')]; }
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
// "about 2 h": from three quarters of it to half again as long.
function pollAt(c, resumedAt, hours) {
  const t = atOf(c.at);
  const r = atOf(resumedAt);
  if (!Number.isFinite(t) || !Number.isFinite(r)) return unv(`The ${hours} h poll read carries no usable time.`);
  const age = (t - r) / HOUR_MS;
  if (age < hours * 0.75 || age > hours * 1.5) return unv(`The ${hours} h poll was read ${age.toFixed(1)} h after the resume.`);
  return all(eq(c.poll && c.poll.state, 'fresh', `the poll at about ${hours} h`), eq(c.poll && c.poll.runner_id, 'render-ops1', `the runner at about ${hours} h`));
}

// ---- The steps (each check cites the runbook line it stands on) --------

const HOW = Object.freeze({
  'revision-final.json': '{observed_at, origin_main, runner_head, healthz_status, deployed_sha} as read together (R0.1)',
  'healthz.txt': 'the raw GET /healthz body',
  'tasks-final.json': 'Get-ScheduledTask readback: {observed_at, pilot:{state,instances}, hourly:{state,instances}}',
  'pilot-all.final-status.json': 'pilot-task.ps1 -Status output',
  'verification.json': 'the runner worktree facts: runner:{detached,clean}, hourly_route:{records_root,stand_in_exit,expected_exit}',
  'doctor-main-workspace.json': 'doctor --json run from the runner with CR_WORKSPACE set for that shell only',
  'offsite-readback.json': 'a copy of logs/jobs-state.json after the next Hourly run (R0.5)',
  'desk-controls.json': 'GET /api/desk/controls, signed in, as returned',
  'dry-run.json': 'the runner\'s pilot-all.jsonl line for the --dry-run from the runner worktree',
  'dry-run-negative.json': 'the same line for the run with one tracked file edited: exit 1, the guard\'s refusal',
  'isolation.json': 'pilot.js --check-isolation output',
  'doctor.json': 'GET /api/doctor (Preferences > System), as returned',
  'trader.json': 'GET /api/paper/trader, signed in, as returned',
  'candidate.json': 'Eric\'s record: {project_id, chain, contract, coingecko_id, model_id, contract_gate, max_grants_per_day, arm_desk_reviewed, vetoed, held}',
  'lineage.json': 'Eric\'s record: project_id, run_id, report_id, receipt_id, generation, decision_id, intent_id, client_order_id, sent_at; on B1 also control, control_applied_at, healthchecks_start_and_final_seen',
  'run-log.json': 'the first run without --dry-run: its pilot-all.jsonl line',
  'trader-after-ack.json': 'GET /api/paper/trader as soon as the buy is acknowledged',
  'trader-after-window.json': 'GET /api/paper/trader after the first eligible hour plus 10 minutes',
  'desk-controls-after.json': 'GET /api/desk/controls after the same window',
  'attribution.json': 'GET /api/research/attribution, as returned (a refusal is evidence too)',
  'basis.json': 'cli.js tickets basis <project_id> <decision_id> --json, in the Render Shell',
  'trader-before.json': 'GET /api/paper/trader before the repeat run',
  'trader-after.json': 'GET /api/paper/trader after the repeat run',
  'trader-restart.json': 'GET /api/paper/trader after the simulated restart',
  'desk-controls-before.json': 'GET /api/desk/controls before the repeat run',
  'desk-controls-repeat.json': 'GET /api/desk/controls after the repeat run',
  'desk-controls-restart.json': 'GET /api/desk/controls after the simulated restart',
  'pc-task.json': 'tasks-final.json\'s shape, read after -Disable and before the Resume',
  'service.json': 'Eric\'s record from the Render page: {name, stayed_suspended_until_cutover, resumed_at, first_run:{preflight_ok,revision_match,runner_id}}',
  'desk-controls-2h.json': 'GET /api/desk/controls about 2 h after the Resume',
  'desk-controls-6h.json': 'GET /api/desk/controls about 6 h after the Resume',
  'desk-controls-24h.json': 'GET /api/desk/controls about 24 h after the Resume',
  'healthchecks.json': 'Eric\'s record of the Healthchecks history: {missed_periods}',
  'kill-drill.json': 'Eric\'s record of OPS1 §5.2: {pass, attempt_id, saves_after_cancel}',
  'desk-down.json': 'the CI run ID of pilot-host-recovery.test.js: {ci_run_id}',
  'lifecycle.json': 'Eric\'s record of OPS1 §7: {project_id, report_id, receipt_id, runner_id, pc_task_disabled, receipt_intact, mandate_evaluation, fill, closed_outcome}',
});
const narrative = (name) => ({ id: 'narrative_present', canon: `Write ${name}`, kind: 'owner', files: [name], judge: () => pass(`${name} is present; its contents are not judged.`) });

const SPECS = {
  r0: {
    folder: 'R0',
    canon: { doc: BLUEPRINT, section: '### R0. Align the PC', criterion: '/healthz = origin/main = a clean dedicated runner; pilot-all Disabled with the listed -Status fields; Hourly on main code, keeping the records, and an offsite run observed after it.' },
    checks: [
      { id: 'deployed_equals_main_equals_runner', canon: 'R0.1', kind: 'run', files: ['revision-final.json', 'healthz.txt'], judge: (d, c) => revisionsAgree(d, c.baseline) },
      { id: 'pilot_all_disabled', canon: 'R0.2', kind: 'run', files: ['tasks-final.json'], judge: (d) => all(eq(d['tasks-final.json'].pilot.state, 'Disabled', 'pilot-all'), eq(d['tasks-final.json'].pilot.instances, 0, 'running instances')) },
      { id: 'runner_detached_and_clean', canon: 'R0.3', kind: 'run', files: ['verification.json'], judge: (d) => all(eq(d['verification.json'].runner.detached, true, 'detached'), eq(d['verification.json'].runner.clean, true, 'clean')) },
      {
        id: 'pilot_all_registration', canon: 'R0.4', kind: 'config', files: ['pilot-all.final-status.json'],
        judge: (d, c) => {
          const s = d['pilot-all.final-status.json'];
          return all(
            eq(s.status.task.state, 'Disabled', 'state'), eq(s.config.unattended, true, 'unattended'), eq(s.config.model_named, true, 'model_named'),
            eq(s.config.checkout_clean, true, 'checkout_clean'), noBaseline(c.baseline) || eq(s.config.checkout_head, c.baseline, 'checkout_head'), eq(s.config.launcher, 'job_wrapper', 'launcher'),
            eq(s.config.working_directory_is_repository, true, 'working_directory_is_repository'),
          );
        },
      },
      {
        id: 'hourly_routes_to_main_keeping_records', canon: 'R0.5', kind: 'run', files: ['verification.json', 'doctor-main-workspace.json'],
        judge: (d) => {
          const route = d['verification.json'].hourly_route;
          const row = arr(d['doctor-main-workspace.json'].checks, 'checks').find((x) => x.name === 'Workspace folder');
          const detail = row ? String(row.detail ?? row.message ?? '') : '';
          return all(
            eq(route.stand_in_exit, route.expected_exit, 'the wrapper\'s exit'),
            !present(route.records_root) || !row ? unv('The workspace the doctor names is not on record.') : detail.includes(route.records_root) && /kind: real\b/.test(detail) ? pass('The doctor names the records\' own real workspace.') : fail('The doctor names another workspace, or one that is not real.'),
          );
        },
      },
      {
        id: 'offsite_run_after_repointing', canon: 'R0.5', kind: 'run', files: ['tasks-final.json', 'offsite-readback.json'],
        judge: (d) => {
          const job = d['offsite-readback.json'].jobs.offsite;
          const since = atOf(d['tasks-final.json'].observed_at);
          const ran = atOf(job.last_run_at);
          if (!Number.isFinite(since) || !Number.isFinite(ran)) return unv('The time of the repointing or of the offsite run is not on record.');
          if (ran <= since) return unv(`The offsite run on record (${job.last_run_at}) is from before the repointing.`);
          return eq(job.last_status, 'ok', 'the offsite run\'s status');
        },
      },
    ],
    not_executed: [{ id: 'hourly_state_at_b0', why: 'R0 records Hourly left Disabled for the quiet-PC instruction; whether it is on now is not read here.' }],
  },
  b0: {
    folder: 'B0',
    canon: { doc: BLUEPRINT, section: '### B0. Prerequisites and readbacks', criterion: 'SHAs agree; admission off and every claim accounted for; dry run from the runner and its negative; meters valid; a candidate by stored identity; arm-desk reviewed; gates G3 and G4.' },
    checks: [
      { id: 'sha_agreement', canon: 'B0.1 / G2', kind: 'run', files: ['revision-final.json', 'healthz.txt'], judge: (d, c) => revisionsAgree(d, c.baseline) },
      { id: 'pilot_all_disabled', canon: 'G3', kind: 'run', files: ['tasks-final.json'], judge: (d) => eq(d['tasks-final.json'].pilot.state, 'Disabled', 'pilot-all') },
      {
        id: 'admission_off_and_authority_read_back', canon: 'B0.2 / G3', kind: 'run', files: ['desk-controls.json'],
        judge: (d) => {
          const c = d['desk-controls.json'];
          return all(
            controlsHold(c), eq(c.authority.admission.on, false, 'authority.admission.on'),
            typeof c.authority.paused === 'boolean' ? pass(`Paused reads ${c.authority.paused}.`) : unv('The pause state is not on record.'),
            Number.isInteger(c.authority.mandate.generation) && present(c.authority.mandate.expires_at) ? pass('The mandate generation and expiry read.') : unv('The mandate generation or expiry is not on record.'),
          );
        },
      },
      { id: 'no_open_reconcile', canon: 'B0.2 / G4', kind: 'run', files: ['desk-controls.json', 'trader.json'], judge: (d) => all(noReconcile(d['desk-controls.json']), noUncertainOrder(d['trader.json'])) },
      {
        id: 'dry_run_guard_and_poll', canon: 'B0.3', kind: 'run', files: ['dry-run.json'],
        judge: (d, c) => {
          const l = d['dry-run.json'];
          return all(pilotLogLine(l, { dryRun: true, baseline: c.baseline }), eq(l.revision && l.revision.clean, true, 'the runner\'s cleanliness'), eq(l.exit, 0, 'exit'), eq(l.max_agents, 1, 'max_agents'), Array.isArray(l.polled) ? pass('The pre-poll list is on record.') : unv('The pre-poll list is not on record.'));
        },
      },
      {
        id: 'dry_run_refuses_a_dirty_tree', canon: 'B0.3', kind: 'run', files: ['dry-run-negative.json'],
        judge: (d) => {
          const l = d['dry-run-negative.json'];
          return all(eq(l.dry_run, true, 'dry_run'), eq(l.exit, 1, 'exit'), /uncommitted changes/.test(String(l.error)) ? pass('The guard refused the edited tree.') : unv('The refusal\'s words are not the guard\'s dirty-tree refusal.'));
        },
      },
      { id: 'isolation', canon: 'B0.3', kind: 'run', files: ['isolation.json'], judge: (d) => all(eq(d['isolation.json'].format, 'cr-pilot-launch@1', 'the isolation format'), eq(d['isolation.json'].ok, true, 'isolation')) },
      {
        id: 'meters_valid', canon: 'B0.5', kind: 'run', files: ['doctor.json', 'trader.json'],
        judge: (d) => {
          const rows = arr(d['doctor.json'].checks, 'checks');
          const lines = ['Market data', 'Contract screening', 'Forensics'].map((name) => {
            const row = rows.find((x) => x.name === name);
            if (!row) return unv(`The doctor has no ${name} line.`);
            return /unknown/i.test(String(row.detail ?? row.message ?? '')) ? fail(`${name} reads unknown.`) : pass(`${name} reads.`);
          });
          const candles = d['trader.json'].candles;
          lines.push(!candles ? unv('The candle meter is not on record.') : candles.accounting_unknown ? fail('The candle meter reads unknown.') : pass('The candle meter reads.'));
          return all(...lines);
        },
      },
      {
        id: 'candidate_by_stored_identity', canon: 'B0.6', kind: 'owner', files: ['candidate.json', 'desk-controls.json'],
        judge: (d, c) => {
          const k = d['candidate.json'];
          const enrolled = arr(d['desk-controls.json'].projects, 'projects').some((p) => p.project_id === k.project_id);
          return all(
            ['project_id', 'chain', 'contract', 'coingecko_id'].every((n) => present(k[n])) ? pass('The identity is complete.') : unv('The candidate\'s chain, contract or CoinGecko ID is not on record.'),
            MODEL_RE.test(String(k.model_id)) ? pass('The pinned model is a full ID.') : unv('The pinned model is not a full model ID.'),
            eq(k.vetoed, false, 'vetoed'), eq(k.held, false, 'held'),
            enrolled ? pass('It is enrolled in the pilot.') : fail(`${k.project_id} is not among the pilot's projects on Desk Controls.`),
            c.project && k.project_id !== c.project ? unv(`This candidate is ${k.project_id}, not ${c.project}.`) : pass('The project scope holds.'),
          );
        },
      },
      {
        id: 'arm_desk_reviewed', canon: 'B0.7', kind: 'owner', files: ['candidate.json'],
        judge: (d) => all(eq(d['candidate.json'].arm_desk_reviewed, true, 'arm-desk reviewed'), eq(d['candidate.json'].contract_gate, 'enforce', 'contract gate'), eq(d['candidate.json'].max_grants_per_day, 1, 'max_grants_per_day')),
      },
      narrative('B0.txt'),
    ],
    not_executed: [{ id: 'first_post_sighting_and_heartbeat', why: 'A dry run sends neither; B1\'s run proves them (B0.3, B0.4).' }, { id: 'nmr_contract_verdict', why: 'Read by Eric on the Forensics tab; only his record of it is read here.' }],
  },
  b1: {
    folder: 'B1',
    canon: { doc: BLUEPRINT, section: '### B1. Pre-eligible-hour cancellation proof', criterion: 'After an acknowledged paper buy, one control before the first eligible hour is usable: the order cancelled, no fill, no position, candles still advancing, the control reads done.' },
    checks: [
      { id: 'lineage_on_record', canon: 'B1.2', kind: 'owner', files: ['lineage.json'], judge: (d, c) => all(lineageIds(d['lineage.json'], ['project_id', 'run_id', 'report_id', 'receipt_id', 'generation', 'decision_id', 'intent_id', 'client_order_id', 'sent_at']), scope(d['lineage.json'], c)) },
      { id: 'first_real_run', canon: 'B0.3 / B0.4', kind: 'run', files: ['run-log.json', 'desk-controls-after.json'], judge: (d, c) => all(pilotLogLine(d['run-log.json'], { dryRun: false, baseline: c.baseline }), present(d['desk-controls-after.json'].poll.last_polled_at) ? pass('A POST sighting reached the desk.') : unv('No POST sighting is on record.')) },
      { id: 'heartbeat_seen', canon: 'B0.4', kind: 'owner', files: ['lineage.json'], judge: (d) => eq(d['lineage.json'].healthchecks_start_and_final_seen, true, 'the Healthchecks /start and final ping') },
      {
        id: 'buy_acknowledged', canon: 'B1.2', kind: 'run', files: ['lineage.json', 'trader-after-ack.json'],
        judge: (d) => {
          const l = d['lineage.json'];
          const o = orderIn(d['trader-after-ack.json'], l.client_order_id);
          if (!o) return unv(`Order ${l.client_order_id} is not in the capture.`);
          return all(eq(o.state, 'ACKED', 'the order'), eq(o.side, 'OPEN_LONG', 'its side'), eq(o.decision_id, l.decision_id, 'its decision'), eq(o.intent_id, l.intent_id, 'its intent'));
        },
      },
      {
        id: 'control_before_first_eligible_hour', canon: 'B1.3', kind: 'run', files: ['lineage.json', 'trader-after-window.json'],
        judge: (d) => {
          const l = d['lineage.json'];
          const usable = usableAt(l.sent_at);
          const applied = atOf(l.control_applied_at);
          const read = atOf(d['trader-after-window.json'].now);
          if (!Number.isFinite(usable) || !Number.isFinite(applied) || !Number.isFinite(read)) return unv('The send, the control or the read has no usable time.');
          const by = new Date(usable).toISOString();
          if (applied >= usable) return fail(`The control came at ${l.control_applied_at}, after the hour was usable at ${by}.`);
          return read < usable ? unv(`The book was read at ${d['trader-after-window.json'].now}, before ${by}.`) : pass(`The control came before ${by}, and the book was read after it.`);
        },
      },
      {
        id: 'order_cancelled_no_fill_no_position', canon: 'B1.4', kind: 'run', files: ['lineage.json', 'trader-after-window.json'],
        judge: (d) => {
          const l = d['lineage.json'];
          const tv = d['trader-after-window.json'];
          const o = orderIn(tv, l.client_order_id);
          if (!o) return unv(`Order ${l.client_order_id} is not in the capture.`);
          const held = positionsOf(tv, l.decision_id);
          return all(
            eq(o.state, 'CANCELLED', 'the order'),
            isZero(o.filled) ? pass('Nothing filled.') : o.filled === undefined ? unv('Its filled quantity is not on record.') : fail(`It filled ${o.filled}.`),
            held.length ? fail(`A position came from it: ${held.map((p) => p.position_id).join(', ')}.`) : pass('No position came from it.'),
          );
        },
      },
      {
        id: 'candles_still_advance', canon: 'B1.4', kind: 'run', files: ['trader-after-ack.json', 'trader-after-window.json'],
        judge: (d) => {
          const a = atOf(d['trader-after-ack.json'].candles.last_run_at);
          const b = atOf(d['trader-after-window.json'].candles.last_run_at);
          if (!Number.isFinite(a) || !Number.isFinite(b)) return unv('The candle read\'s time is not on record.');
          return b > a ? pass('The hourly read ran again after the control.') : fail('The hourly read did not run again in the window.');
        },
      },
      {
        id: 'control_reads_done', canon: 'B1.4', kind: 'run', files: ['lineage.json', 'desk-controls-after.json'],
        judge: (d) => {
          const name = d['lineage.json'].control;
          if (name !== 'pause' && name !== 'mandate_off') return unv('The lineage does not name the control (pause or mandate_off).');
          return eq(d['desk-controls-after.json'].controls[name].done, true, `controls.${name}.done`);
        },
      },
      narrative('B1.txt'),
    ],
    not_executed: [{ id: 'grant_not_reused', why: 'That a cancelled grant is never reused is the offline suite\'s proof, not this capture\'s.' }],
  },
  b2: {
    folder: 'B2',
    canon: { doc: BLUEPRINT, section: '### B2. One natural mandate grant to fill', criterion: 'A mandate grant reaches a causal fill on a real closed hour; the attribution row reads decision_time; the basis is verified by SHA-256; execution-time facts read not_recorded.' },
    checks: [
      { id: 'lineage_on_record', canon: 'B2.3', kind: 'owner', files: ['lineage.json'], judge: (d, c) => all(lineageIds(d['lineage.json'], ['project_id', 'decision_id', 'client_order_id', 'sent_at']), scope(d['lineage.json'], c)) },
      {
        id: 'attribution_row_is_decision_time', canon: 'B2.4', kind: 'run', files: ['lineage.json', 'attribution.json'],
        judge: (d) => {
          const v = d['attribution.json'];
          if (v.code === 'INTEGRITY' || v.status === 'error') return fail(`The attribution view refused: ${v.code || v.status}.`);
          const row = arr(v.rows, 'rows').find((r) => r.decision_id === d['lineage.json'].decision_id);
          if (!row) return unv(`No row for ${d['lineage.json'].decision_id}.`);
          return all(
            eq(row.inputs.label, 'decision_time', 'inputs.label'), eq(row.decided_by, 'mandate', 'decided_by'),
            Array.isArray(row.not_recorded_at_execution) && row.not_recorded_at_execution.length ? pass('Execution-time facts read not_recorded.') : unv('not_recorded_at_execution is empty or absent.'),
          );
        },
      },
      {
        id: 'basis_verified', canon: 'B2.4', kind: 'run', files: ['lineage.json', 'basis.json'],
        judge: (d) => {
          const b = d['basis.json'];
          const originals = arr(b.originals, 'originals');
          const unverified = originals.filter((o) => o.digest !== 'verified');
          return all(
            eq(b.format, 'cr-decision-view@1', 'the basis view format'),
            eq(b.label, 'decision_time', 'label'), eq(b.digest, 'verified', 'digest'), eq(b.decision && b.decision.decision_id, d['lineage.json'].decision_id, 'its decision'),
            originals.length && !unverified.length ? pass(`${originals.length} named record(s) checked by SHA-256.`) : unv(`${unverified.length} of ${originals.length} named records are not verified.`),
          );
        },
      },
      {
        id: 'causal_fill_with_fees', canon: 'B2.3 / B2.4', kind: 'run', files: ['lineage.json', 'basis.json'],
        judge: (d) => {
          const sent = atOf(d['lineage.json'].sent_at);
          const coid = d['lineage.json'].client_order_id;
          const fills = arr(d['basis.json'].execution.fills, 'fills').filter((f) => f.client_order_id === coid);
          if (!fills.length) return unv('Fill pending: no fill is on record for this order. A held or no-trade outcome is correct, and the milestone stays unproven.');
          if (!Number.isFinite(sent)) return unv('The send time is not on record.');
          return all(...fills.map((f) => {
            const hour = atOf(f.hour);
            if (!Number.isFinite(hour)) return unv('A fill names no usable hour.');
            if (hour < sent) return fail(`A fill's hour ${f.hour} starts before the send: not causal.`);
            return present(f.fee_usd) ? pass(`A fill from the hour ${f.hour}, fee recorded.`) : unv('A fill has no recorded fee.');
          }));
        },
      },
      {
        id: 'position_and_stop', canon: 'B2.4 / B2.5', kind: 'run', files: ['lineage.json', 'trader.json'],
        judge: (d) => {
          const held = positionsOf(d['trader.json'], d['lineage.json'].decision_id);
          if (!held.length) return unv('No position from this decision is in the capture.');
          const open = arr(d['trader.json'].results.open_positions, 'open_positions').filter((p) => p.decision_id === d['lineage.json'].decision_id);
          return all(...open.map((p) => (present(p.stop_loss_price) ? pass(`Position ${p.position_id} carries its stop.`) : fail(`Position ${p.position_id} carries no stop.`))), pass(`${held.length} position(s) trace to the decision.`));
        },
      },
      narrative('B2.txt'),
    ],
    not_executed: [{ id: 'natural_closure', why: 'A natural stop, target or expiry is reported if it comes; "closure pending" fails nothing (B2.5).' }],
  },
  b3: {
    folder: 'B3',
    canon: { doc: BLUEPRINT, section: '### B3. Restart and idempotency', criterion: 'With nothing newly eligible, the repeat run and the simulated restart leave run, report, receipt, decision, intent and order IDs, fills, sessions_today and claims unchanged.' },
    checks: [
      { id: 'repeat_run_no_side_effect', canon: 'B3.2', kind: 'run', files: ['trader-before.json', 'desk-controls-before.json', 'trader-after.json', 'desk-controls-repeat.json'], judge: (d) => sameEffects(d['trader-before.json'], d['desk-controls-before.json'], d['trader-after.json'], d['desk-controls-repeat.json'], 'The repeat run') },
      { id: 'restart_no_side_effect', canon: 'B3.1 / B3.2', kind: 'run', files: ['trader-before.json', 'desk-controls-before.json', 'trader-restart.json', 'desk-controls-restart.json'], judge: (d) => sameEffects(d['trader-before.json'], d['desk-controls-before.json'], d['trader-restart.json'], d['desk-controls-restart.json'], 'The restart') },
      narrative('B3.txt'),
    ],
    not_executed: [{ id: 'hosted_restart', why: 'Optional, and only if Eric authorizes it (B3.3); until then it is reported unverified.' }, { id: 'uncertain_attempt_stays_claimed', why: 'Read only through the claims compared above.' }],
    separate: (rep, d, prior) => {
      const closed = d['trader-restart.json'] && d['trader-restart.json'].results ? (d['trader-restart.json'].results.closed_positions || []).length : 0;
      const word = (r) => (r === PASS ? 'proven' : r === FAIL ? 'failed' : 'pending');
      const restart = rep.checks_executed.filter((c) => c.id.endsWith('side_effect'));
      return {
        cancellation: word(prior.b1), live_fill: word(prior.b2), risk_reduction: closed ? 'proven' : 'pending', closure: closed ? 'proven' : 'pending',
        restart: restart.length === 2 && restart.every((c) => c.status === PASS) ? 'proven' : restart.some((c) => c.status === FAIL) ? 'failed' : 'pending',
      };
    },
  },
  cutover: {
    folder: 'cutover',
    canon: { doc: OPS1, section: '## 7. Hosted mission proof', criterion: 'One scheduler, the service suspended until the cutover, its first run through the preflight, the drills recorded, the poll Fresh at 2, 6 and 24 h, and one real unattended lifecycle by Ops-1. Five results stay apart; a cron service existing proves none of them.' },
    checks: [
      {
        id: 'one_scheduler', canon: 'OPS1 §6 cutover', kind: 'run', files: ['pc-task.json', 'service.json'],
        judge: (d) => {
          const read = atOf(d['pc-task.json'].observed_at);
          const resumed = atOf(d['service.json'].resumed_at);
          if (!Number.isFinite(read) || !Number.isFinite(resumed)) return unv('The read of the PC task or the Resume has no usable time.');
          return all(eq(d['pc-task.json'].pilot.state, 'Disabled', 'the PC task'), read < resumed ? pass('It read Disabled before the Resume.') : fail('The PC task was not read Disabled before the Resume.'));
        },
      },
      {
        id: 'host_installed', canon: 'OPS1 §7', kind: 'owner', files: ['service.json'],
        judge: (d) => {
          const s = d['service.json'];
          return all(eq(s.name, 'cryptoresearch-runner', 'the service'), eq(s.stayed_suspended_until_cutover, true, 'suspended until the cutover'), eq(s.first_run.preflight_ok, true, 'the first run\'s preflight'), eq(s.first_run.revision_match, true, 'its revision match'), eq(s.first_run.runner_id, 'render-ops1', 'its runner'));
        },
      },
      { id: 'kill_drill', canon: 'OPS1 §5.2', kind: 'owner', files: ['kill-drill.json'], judge: (d) => all(eq(d['kill-drill.json'].saves_after_cancel, 0, 'saves after the cancel'), eq(d['kill-drill.json'].pass, true, 'the kill drill')) },
      { id: 'desk_down_drill', canon: 'OPS1 §5.3', kind: 'owner', files: ['desk-down.json'], judge: (d) => (present(d['desk-down.json'].ci_run_id) || Number.isInteger(d['desk-down.json'].ci_run_id) ? pass(`CI run ${d['desk-down.json'].ci_run_id}.`) : unv('No CI run ID is on record.')) },
      {
        id: 'runner_alive', canon: 'OPS1 §7', kind: 'run', files: ['service.json', 'desk-controls-2h.json', 'desk-controls-6h.json', 'desk-controls-24h.json', 'healthchecks.json'],
        judge: (d) => all(pollAt(d['desk-controls-2h.json'], d['service.json'].resumed_at, 2), pollAt(d['desk-controls-6h.json'], d['service.json'].resumed_at, 6), pollAt(d['desk-controls-24h.json'], d['service.json'].resumed_at, 24), eq(d['healthchecks.json'].missed_periods, 0, 'missed Healthchecks periods')),
      },
      {
        id: 'lifecycle_proven', canon: 'OPS1 §7', kind: 'owner', files: ['lifecycle.json'],
        judge: (d, c) => {
          const l = d['lifecycle.json'];
          return all(
            lineageIds(l, ['project_id', 'report_id', 'receipt_id']), scope(l, c), eq(l.runner_id, 'render-ops1', 'the runner'), eq(l.pc_task_disabled, true, 'the PC task disabled'), eq(l.receipt_intact, true, 'the frozen packet intact'),
            l.mandate_evaluation === 'granted' || l.mandate_evaluation === 'evaluated_not_granted' ? pass(`The mandate's sweep: ${l.mandate_evaluation}.`) : unv('The mandate\'s evaluation is not on record.'),
          );
        },
      },
      {
        id: 'later_results_not_failed', canon: 'OPS1 §7', kind: 'owner', files: ['lifecycle.json'],
        judge: (d) => {
          const l = d['lifecycle.json'];
          if (l.fill === 'failed' || l.closed_outcome === 'failed') return fail('A later result reads failed.');
          return pass(`fill ${present(l.fill) ? l.fill : 'pending'}, closed outcome ${present(l.closed_outcome) ? l.closed_outcome : 'pending'}: reported apart, and pending fails nothing.`);
        },
      },
      narrative('cutover.txt'),
    ],
    not_executed: [{ id: 'render_service_state', why: 'Render\'s own state is read only through Eric\'s record: this command calls no Render API.' }, { id: 'cancelled_child_signal', why: 'Render does not document it (OPS1 §5.4); the kill drill judges by what reaches the desk.' }],
    separate: (rep, d) => {
      const statusOf = (id) => (rep.checks_executed.concat(rep.checks_not_executed).find((c) => c.id === id) || {}).status;
      const word = (s) => (s === PASS ? 'proven' : s === FAIL ? 'failed' : 'pending');
      const l = d['lifecycle.json'] || {};
      const later = (v) => (v === 'proven' || v === 'failed' ? v : 'pending');
      return { host_installed: word(statusOf('host_installed')), runner_alive: word(statusOf('runner_alive')), lifecycle_proven: word(statusOf('lifecycle_proven')), fill_proven: later(l.fill), closed_outcome_proven: later(l.closed_outcome) };
    },
  },
};
function scope(rec, c) {
  if (!c.project) return pass('No project was named.');
  return rec.project_id === c.project ? pass(`Scoped to ${c.project}.`) : unv(`This record is ${rec.project_id}, not ${c.project}.`);
}

// ---- Paths --------------------------------------------------------------

const folded = (p) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
function within(child, parent) {
  const rel = path.relative(folded(parent), folded(child));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
function realOf(p) { try { return fs.realpathSync(p); } catch (_) { return null; } }
function nearestReal(p) {
  let cur = path.resolve(p);
  for (;;) {
    const real = realOf(cur);
    if (real) return real;
    const up = path.dirname(cur);
    if (up === cur) return cur;
    cur = up;
  }
}
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; } };
const refused = (words) => Object.assign(new Error(words), { code: 'UNSAFE_PATH' });
const usage = (words) => Object.assign(new Error(words), { code: 'USAGE' });
const evidenceHome = (home) => path.join(home, 'Documents', 'CryptoResearch-evidence');

// ---- The evidence bundle -------------------------------------------------

function decode(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
}
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

function proofRoots(ctx) {
  if (ctx.evidence) return [path.resolve(ctx.evidence)];
  const home = evidenceHome(ctx.home);
  let names = [];
  try { names = fs.readdirSync(home).filter((n) => /^operating-proof-\d{4}-\d{2}-\d{2}/.test(n)).sort().reverse(); } catch (_) { /* no evidence folder yet */ }
  return names.map((n) => path.join(home, n));
}

// Reads the bundle's manifest and every file it binds. Nothing outside the
// bundle is followed, and a file that fails its hash is never parsed.
function loadBundle(spec, ctx) {
  const out = { dir: null, searched: [], manifest: null, manifest_sha256: null, files: new Map(), problems: [], sources: [] };
  for (const root of proofRoots(ctx)) {
    const dir = path.join(root, spec.folder);
    out.searched.push(dir);
    if (fs.existsSync(dir)) { out.dir = dir; break; }
  }
  if (!out.dir) return out;
  if (isLink(out.dir)) { out.problems.push(fail(`${spec.folder} is a link, which a bundle may not be.`)); out.dir = null; return out; }
  const realDir = realOf(out.dir);
  let raw;
  try { raw = fs.readFileSync(path.join(out.dir, 'manifest.json')); } catch (err) { out.problems.push(unv(`The bundle's manifest.json does not read (${err.code || 'error'}).`)); return out; }
  out.manifest_sha256 = sha256(raw);
  let m;
  try { m = JSON.parse(decode(raw)); } catch (_) { out.problems.push(unv('The bundle\'s manifest.json is malformed.')); return out; }
  if (!m || typeof m !== 'object' || !Array.isArray(m.files)) { out.problems.push(unv('The bundle\'s manifest does not hold its shape.')); return out; }
  out.manifest = m;
  for (const f of m.files) {
    const rel = f && typeof f.path === 'string' ? f.path : null;
    if (!rel) { out.problems.push(unv('A manifest entry names no path.')); continue; }
    const abs = path.resolve(out.dir, rel);
    if (path.isAbsolute(rel) || !within(abs, out.dir)) { out.problems.push(fail(`The manifest names a path outside its bundle: ${rel}.`)); continue; }
    let st;
    try { st = fs.lstatSync(abs); } catch (_) { out.files.set(rel, { state: 'missing' }); continue; }
    if (st.isSymbolicLink() || (realDir && realOf(abs) && !within(realOf(abs), realDir))) { out.problems.push(fail(`A bound file is a link out of its bundle: ${rel}.`)); continue; }
    if (st.isDirectory()) { out.files.set(rel, { state: 'unreadable' }); continue; }
    if (st.size > MAX_FILE_BYTES) { out.files.set(rel, { state: 'unreadable' }); out.problems.push(unv(`${rel} is too large to read.`)); continue; }
    let buf;
    try { buf = fs.readFileSync(abs); } catch (_) { out.files.set(rel, { state: 'unreadable' }); continue; }
    const hash = sha256(buf);
    if (typeof f.sha256 !== 'string') { out.files.set(rel, { state: 'unbound' }); out.problems.push(unv(`The manifest gives no SHA-256 for ${rel}.`)); continue; }
    if (hash !== f.sha256.toLowerCase() || (Number.isInteger(f.bytes) && f.bytes !== buf.length)) { out.files.set(rel, { state: 'corrupt' }); out.problems.push(fail(`${rel} does not match its manifest hash: it changed after the bundle closed.`)); continue; }
    out.files.set(rel, { state: 'ok', buf });
    out.sources.push({ path: rel, bytes: buf.length, sha256: hash });
  }
  return out;
}

function parseFile(rel, entry) {
  const text = decode(entry.buf);
  if (!rel.endsWith('.json')) return { ok: true, value: text, text };
  try { return { ok: true, value: JSON.parse(text), text }; } catch (_) { return { ok: false, text }; }
}

function provenanceOf(bundle, texts, ctx) {
  const declared = bundle.manifest && typeof bundle.manifest.provenance === 'string' ? bundle.manifest.provenance.toLowerCase() : null;
  const anchored = bundle.manifest_sha256 ? anchorOf(bundle.manifest_sha256, ctx) : false;
  const info = { declared, anchored, kind: 'undeclared' };
  const claimsLive = declared === 'live_run' || anchored;
  if (declared && FIXTURE_WORDS.has(declared)) return { ...info, kind: 'fixture', check: unv(`This bundle declares itself ${declared}: a fixture proves code paths, never operation.`) };
  if (within(bundle.dir, ctx.codeRoot)) return { ...info, kind: 'fixture', check: unv('This bundle lives inside the code, where operating evidence never does.') };
  if (texts.some((t) => FICTION_RE.test(t))) return { ...info, kind: 'fixture', check: claimsLive ? fail('This bundle reads as live, but its records carry fictional markers.') : unv('This bundle\'s records carry fictional markers.') };
  if (anchored) return { ...info, kind: 'live_run', check: pass('A receipt merged on origin/main names this manifest\'s SHA-256.') };
  // Anyone can type live_run. Eric's merge of a receipt naming these bytes is what anchors them.
  if (declared === 'live_run') return { ...info, kind: 'declared_live', check: unv('The manifest declares a live run, which is only a declaration: no receipt merged on origin/main names its SHA-256 yet, as this checkout last fetched. Merge a receipt under docs/engineering that names it.') };
  return { ...info, check: unv(declared ? `The manifest declares "${declared}", which is no known provenance.` : 'The manifest states no provenance, and no merged receipt names it.') };
}
function anchorOf(hash, ctx) {
  const r = ctx.git(['grep', '-q', '-F', hash, 'origin/main', '--', 'docs/engineering']);
  return r.status === 0;
}

// ---- Facts this command reads itself ------------------------------------

function gitChildEnv(env) {
  const clean = {};
  for (const k of GIT_ENV_KEEP) if (env[k] !== undefined) clean[k] = env[k];
  clean.GIT_TERMINAL_PROMPT = '0';
  clean.GIT_OPTIONAL_LOCKS = '0';
  return clean;
}
function defaultGit(codeRoot, env) {
  const clean = gitChildEnv(env);
  return (args) => {
    const r = spawnSync('git', ['-C', codeRoot, ...args], { encoding: 'utf8', windowsHide: true, timeout: 20000, env: clean });
    return { status: typeof r.status === 'number' ? r.status : null, stdout: String(r.stdout || '') };
  };
}
function gitFacts(git) {
  const line = (args) => { const r = git(args); return r.status === 0 ? r.stdout.trim() : null; };
  const head = line(['rev-parse', 'HEAD']);
  const origin = line(['rev-parse', 'origin/main']);
  const st = git(['status', '--porcelain']);
  const clean = st.status === 0 ? st.stdout.trim() === '' : null;
  const branch = line(['symbolic-ref', '-q', '--short', 'HEAD']);
  const mode = !head || !origin || clean === null ? 'unknown' : head === origin && clean ? 'post_merge' : 'development';
  return { head, origin_main: origin, origin_main_as: 'as last fetched; this command never fetches', branch, clean, mode };
}
async function readDeployed(ctx) {
  if (!ctx.desk) return { read: false, commit: null, words: 'Not read: run with --desk=online to read the desk\'s /healthz.' };
  const P = require('../scripts/pilot');
  let d;
  try { d = await P.deskRevision(ctx.fetchImpl, P.deskUrlOf({}, ctx.env)); } catch (err) { d = { commit: null, words: String((err && err.message) || err).slice(0, 200) }; }
  let origin = null;
  try { origin = P.deskUrlOf({}, ctx.env); } catch (_) { /* the words say why */ }
  const out = { read: true, origin, commit: d.commit || null, read_at: new Date(ctx.now()).toISOString(), means: '/healthz names the running revision; it is not pipeline health.' };
  if (!d.commit) return { ...out, words: `${d.words || 'No revision answered.'} This says nothing of how the desk is configured.` };
  const vs = ctx.facts.origin_main && d.commit !== ctx.facts.origin_main;
  return { ...out, differs_from_origin_main: Boolean(vs), words: vs ? `The desk runs ${short(d.commit)}; origin/main as last fetched is ${short(ctx.facts.origin_main)}. Merged is not deployed, or this checkout has not fetched.` : `The desk runs ${short(d.commit)}.` };
}

// ---- One step ------------------------------------------------------------

function modeCheck(ctx) {
  const f = ctx.facts;
  if (f.mode === 'post_merge') return pass(`The verifier runs from origin/main at ${short(f.head)}, clean.`);
  if (f.mode === 'development') return unv(`Development mode: this checkout is ${short(f.head)}${f.clean === false ? ', with uncommitted changes,' : ''} and origin/main is ${short(f.origin_main)}. That is no production failure; a PASS needs the merged verifier and deployment-dependent checks stay unverified.`);
  return unv('This checkout\'s revision is unknown, so the verifier\'s own code is unidentified.');
}
function onMainCheck(baseline, ctx) {
  if (!SHA_RE.test(String(baseline))) return unv('The manifest names no 40-character baseline.');
  const r = ctx.git(['merge-base', '--is-ancestor', baseline, 'origin/main']);
  if (r.status === 0) return pass(`${short(baseline)} is on origin/main.`);
  return unv(`${short(baseline)} is not on origin/main as last fetched (or git could not say).`);
}
function deployedCheck(baseline, ctx) {
  const d = ctx.deployed;
  if (!d.read || !d.commit) return unv(d.words);
  if (ctx.expect && d.commit !== ctx.expect) return fail(`The desk runs ${short(d.commit)}; the expected merge is ${short(ctx.expect)}.`);
  if (ctx.expect && baseline !== ctx.expect) return fail(`This proof was made at ${short(baseline)}; the expected merge is ${short(ctx.expect)}.`);
  if (d.commit !== baseline) return unv(`This proof was made at ${short(baseline)}; the desk now runs ${short(d.commit)}. It is not a contradiction of the record, and it is not a proof of what runs now: refresh the runner and repeat (R0).`);
  return pass(`The desk runs the proof's revision, ${short(baseline)}.`);
}
function secretScan(texts, env) {
  const values = Object.entries(env || {}).filter(([k, v]) => SECRET_ENV_RE.test(k) && typeof v === 'string' && v.length >= 8).map(([, v]) => v);
  const hits = [];
  for (const [rel, t] of texts) if (SECRET_RES.some((re) => { re.lastIndex = 0; return re.test(t); }) || values.some((v) => t.includes(v))) hits.push(rel);
  return hits.length ? fail(`A secret's value appears in ${hits.join(', ')}: the runbook forbids it. The value is not repeated here. Treat it as exposed.`) : pass('No known secret shape or this shell\'s secret values in the records read.');
}

async function proveStep(step, ctx) {
  if (ctx.memo.has(step)) return ctx.memo.get(step);
  const spec = SPECS[step];
  const at = STEPS.indexOf(step);
  const prior = at > 0 ? await proveStep(STEPS[at - 1], ctx) : null;
  const bundle = loadBundle(spec, ctx);
  const baseline = bundle.manifest ? bundle.manifest.baseline : null;
  const rep = {
    format: FORMAT,
    step,
    result: UNVERIFIED,
    reason: null,
    canon: spec.canon,
    audited_revision: SHA_RE.test(String(baseline)) ? baseline : null,
    verifier: ctx.facts,
    deployed: ctx.deployed,
    evidence: { bundle: bundle.dir, searched: bundle.searched, manifest_sha256: bundle.manifest_sha256, provenance: null, anchored_by_merged_receipt: false, attestation: 'hash-bound; no cryptographic attestation' },
    timestamps: { bundle_closed_at: bundle.manifest ? bundle.manifest.closed_at || null : null, verified_at: new Date(ctx.now()).toISOString() },
    sources: bundle.sources,
    checks_executed: [],
    checks_not_executed: [...spec.not_executed],
    missing_evidence: [],
  };
  const record = (id, canon, v, observedFrom, files = []) => rep.checks_executed.push({ id, canon, status: v.status, words: v.words, observed_from: observedFrom, files });

  if (!bundle.dir && !bundle.problems.length) {
    rep.missing_evidence.push({ file: `${spec.folder}/manifest.json`, how: bundle.searched.length ? `no bundle in ${bundle.searched.join(', ')}` : 'no operating-proof folder exists yet' });
  }
  for (const p of bundle.problems) record('bundle_integrity', 'evidence folder', p, 'offline_record');
  if (bundle.dir && bundle.manifest) {
    const fmt = `cr-operating-proof-${step}-evidence@1`;
    record('manifest_names_this_step', 'evidence folder', bundle.manifest.format === fmt ? pass(`Manifest format ${fmt}.`) : unv(`The manifest's format is ${bundle.manifest.format || 'absent'}, not ${fmt}.`), 'offline_record', ['manifest.json']);
    const closed = atOf(bundle.manifest.closed_at);
    record('bundle_closed', 'evidence folder', !Number.isFinite(closed) ? unv('The manifest has no usable closed_at.') : closed > ctx.now() + CLOCK_SKEW_MS ? unv(`The bundle closes in the future (${bundle.manifest.closed_at}).`) : pass(`Closed at ${bundle.manifest.closed_at}.`), 'offline_record', ['manifest.json']);
  }

  // Parse only what this step reads.
  const needed = [...new Set(spec.checks.flatMap((c) => c.files))];
  const parsed = {};
  const state = {};
  const texts = new Map();
  for (const rel of needed) {
    const e = bundle.files.get(rel);
    if (!e) { state[rel] = 'missing'; continue; }
    if (e.state !== 'ok') { state[rel] = e.state; continue; }
    const r = parseFile(rel, e);
    texts.set(rel, r.text);
    if (r.ok) { parsed[rel] = r.value; state[rel] = 'ok'; } else state[rel] = 'malformed';
  }
  const prov = bundle.dir && bundle.manifest ? provenanceOf(bundle, [...texts.values(), JSON.stringify(bundle.manifest)], ctx) : { kind: 'undeclared', declared: null, anchored: false, check: unv('No readable bundle, so no provenance.') };
  rep.evidence.provenance = prov.kind;
  rep.evidence.anchored_by_merged_receipt = prov.anchored;
  const observed = (kind) => (kind === 'owner' ? 'owner_record' : prov.kind === 'fixture' ? 'fixture' : prov.kind !== 'live_run' ? 'offline_record' : kind === 'config' ? 'static_configuration' : 'live_run');
  record('provenance', 'one-sheet: "Fictional fills and passing tests prove code paths, not operation"', prov.check, prov.kind === 'fixture' ? 'fixture' : 'offline_record');
  if (texts.size) record('no_secret_values', 'blueprint §6: "Values of secrets never go there"', secretScan([...texts], ctx.env), 'offline_record', [...texts.keys()]);
  if (bundle.files.size > texts.size) rep.checks_not_executed.push({ id: 'secret_scan_of_other_bound_files', why: `${bundle.files.size - texts.size} bound file(s) this step does not read were hashed, not scanned.` });

  for (const c of spec.checks) {
    const bad = c.files.filter((f) => state[f] !== 'ok');
    if (bad.length) {
      for (const f of bad) if (!rep.missing_evidence.some((x) => x.file === `${spec.folder}/${f}`)) rep.missing_evidence.push({ file: `${spec.folder}/${f}`, state: state[f], how: HOW[f] || 'the runbook\'s own narrative record' });
      rep.checks_not_executed.push({ id: c.id, canon: c.canon, status: UNVERIFIED, why: `Needs ${bad.map((f) => `${f} (${state[f]})`).join(', ')}.` });
      continue;
    }
    let v;
    try { v = c.judge(parsed, { baseline, project: ctx.project }); } catch (_) { v = unv(`The records for ${c.id} do not hold their shape, and nothing is inferred from them.`); }
    record(c.id, c.canon, v, observed(c.kind), c.files);
  }

  // What makes it a proof of the merged system, kept apart from the records.
  record('audited_revision_on_main', 'R0.1', onMainCheck(baseline, ctx), 'git');
  record('verifier_revision', 'PR A1: development vs post-merge', modeCheck(ctx), 'git');
  record('deployed_revision_now', 'one-sheet: deployed means the /healthz revision at a stated time', deployedCheck(rep.audited_revision, ctx), ctx.deployed.read ? 'live_read' : 'none');
  if (prior) {
    const closedHere = atOf(rep.timestamps.bundle_closed_at);
    const closedPrior = atOf(prior.timestamps.bundle_closed_at);
    let v = prior.result === PASS ? pass(`${prior.step} reads PASS.`) : unv(`The runbook's order: ${prior.step} reads ${prior.result}, so ${step} is not proven whatever its own records say.`);
    if (Number.isFinite(closedHere) && Number.isFinite(closedPrior) && closedHere < closedPrior) v = fail(`This bundle closed before ${prior.step}'s: the records are out of the runbook's order.`);
    record('earlier_step', 'blueprint §6: R0 → B0 → B1 → B2 → B3 → cutover', v, 'offline_record');
  }
  if (!ctx.project && step !== 'r0') rep.checks_not_executed.push({ id: 'project_scope', why: 'No --project was named, so records are read as recorded.' });

  const statuses = [...rep.checks_executed.map((c) => c.status), ...rep.checks_not_executed.filter((c) => c.status).map((c) => c.status)];
  const specRan = spec.checks.every((c) => rep.checks_executed.some((x) => x.id === c.id));
  rep.result = statuses.includes(FAIL) ? FAIL : statuses.includes(UNVERIFIED) || !specRan || rep.missing_evidence.length ? UNVERIFIED : PASS;
  const first = rep.checks_executed.find((c) => c.status === rep.result) || null;
  const owners = rep.checks_executed.filter((c) => c.observed_from === 'owner_record').length;
  if (rep.result === PASS) rep.reason = `Every canonical check is supported by records${owners ? `; ${owners} of them rest on Eric's own record` : ''}.`;
  else if (rep.result === FAIL) rep.reason = `${rep.checks_executed.filter((c) => c.status === FAIL).map((c) => c.words).join(' ')}`;
  else rep.reason = `${rep.missing_evidence.length ? `Missing: ${rep.missing_evidence.map((m) => m.file).join(', ')}. ` : ''}${first ? first.words : ''}`.trim();
  if (spec.separate) {
    const priorResults = {};
    for (const [k, v] of ctx.memo) priorResults[k] = v.result;
    rep.separate_results = spec.separate(rep, parsed, priorResults);
  }
  ctx.memo.set(step, rep);
  return rep;
}

// ---- The report ----------------------------------------------------------

function cleaner(env, home) {
  const values = Object.entries(env || {}).filter(([k, v]) => SECRET_ENV_RE.test(k) && typeof v === 'string' && v.length >= 8).map(([, v]) => v).sort((a, b) => b.length - a.length);
  const homes = home ? [...new Set([home, home.replace(/\\/g, '/')])].sort((a, b) => b.length - a.length) : [];
  const scrub = (s) => {
    let t = s;
    for (const v of values) t = t.split(v).join('[redacted]');
    for (const re of SECRET_RES) t = t.replace(re, '[redacted]');
    for (const h of homes) t = t.split(h).join('~');
    return t;
  };
  const walk = (v) => {
    if (typeof v === 'string') return scrub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk;
}

function renderText(r) {
  const lines = [`prove-autonomy ${r.step}: ${r.result}`, r.reason || '', '', 'A readback verifies evidence. It does not make proof.', ''];
  if (r.steps) {
    for (const s of r.steps) lines.push(`  ${s.step.padEnd(8)} ${s.result}`);
    return `${lines.join('\n')}\n`;
  }
  lines.push(`Canon: ${r.canon.doc} "${r.canon.section}"`, `  ${r.canon.criterion}`, '');
  lines.push(`Audited revision: ${r.audited_revision || 'unknown'}`);
  lines.push(`Verifier: ${r.verifier.head || 'unknown'} (${r.verifier.mode}); origin/main ${r.verifier.origin_main || 'unknown'}, ${r.verifier.origin_main_as}`);
  lines.push(`Deployed: ${r.deployed.words}${r.deployed.read_at ? ` Read ${r.deployed.read_at}.` : ''}`);
  lines.push(`Verified at: ${r.timestamps.verified_at}`, `Bundle closed at: ${r.timestamps.bundle_closed_at || 'unknown'}`);
  lines.push(`Provenance: ${r.evidence.provenance}${r.evidence.anchored_by_merged_receipt ? ', anchored by a merged receipt' : ''}; ${r.evidence.attestation}`, '');
  if (r.separate_results) { lines.push('Reported apart:'); for (const [k, v] of Object.entries(r.separate_results)) lines.push(`  ${k}: ${v}`); lines.push(''); }
  lines.push('Checks executed:');
  for (const c of r.checks_executed) lines.push(`  [${c.status}] ${c.id} (${c.canon}; ${c.observed_from}): ${c.words}`);
  lines.push('', 'Checks not executed:');
  for (const c of r.checks_not_executed) lines.push(`  ${c.id}: ${c.why}`);
  lines.push('', 'Missing evidence:');
  if (!r.missing_evidence.length) lines.push('  none');
  for (const m of r.missing_evidence) lines.push(`  ${m.file}${m.state ? ` (${m.state})` : ''}: ${m.how}`);
  lines.push('', 'Sources:');
  if (!r.sources.length) lines.push('  none');
  for (const s of r.sources) lines.push(`  ${s.sha256}  ${s.path} (${s.bytes} bytes)`);
  return `${lines.join('\n')}\n`;
}

// One new folder of reports. Every refusal comes before anything is written.
function outputRoot(opts, ctx) {
  if (opts.out !== undefined && (typeof opts.out !== 'string' || !opts.out.trim())) throw usage('--out needs a directory.');
  const root = path.resolve(opts.out || path.join(evidenceHome(ctx.home), `operating-proof-${new Date(ctx.now()).toISOString().slice(0, 10)}`));
  for (const bad of [ctx.codeRoot, ...ctx.forbiddenRoots]) {
    if (within(root, bad) || within(nearestReal(root), realOf(bad) || bad)) throw refused(`--out may not be inside the code or the desk's records (${bad}).`);
  }
  // Any workspace, named or not: the runner's default root is not where the records live.
  for (let cur = nearestReal(root); ; cur = path.dirname(cur)) {
    if (fs.existsSync(path.join(cur, 'workspace.json'))) throw refused(`--out may not be inside a desk workspace (${cur}).`);
    if (path.dirname(cur) === cur) break;
  }
  // A link anywhere on the way, not only at the end: junctions pass a containment check.
  for (let cur = root; ; cur = path.dirname(cur)) {
    if (isLink(cur)) throw refused(`--out passes through a link (${cur}); name the real directory.`);
    if (path.dirname(cur) === cur) break;
  }
  return root;
}
function writeReports(reports, summary, root, ctx) {
  const parent = path.join(root, 'prove-autonomy');
  fs.mkdirSync(parent, { recursive: true });
  if (isLink(parent)) throw refused(`${parent} is a link.`);
  const runDir = path.join(parent, ctx.runId);
  try { fs.mkdirSync(runDir); } catch (err) {
    if (err.code === 'EEXIST') throw refused(`Run ${ctx.runId} already exists; existing evidence is never overwritten.`);
    throw err;
  }
  const real = realOf(runDir);
  if (!real || !within(real, realOf(root))) throw refused('The report folder resolved outside its output directory.');
  const files = [];
  for (const r of reports) {
    const name = SPECS[r.step].folder;
    files.push([`${name}.txt`, renderText(r)], [`${name}.json`, `${JSON.stringify(r, null, 2)}\n`]);
  }
  if (summary) files.push(['SUMMARY.txt', renderText(summary)], ['SUMMARY.json', `${JSON.stringify(summary, null, 2)}\n`]);
  // The run folder was created exclusively above, so these renames overwrite nothing.
  for (const [name, text] of files) atomicWrite(path.join(runDir, name), text);
  return { out_dir: runDir, report_files: files.map(([name, text]) => ({ name, sha256: sha256(text) })) };
}

// ---- Entry --------------------------------------------------------------

function worstOf(results) {
  if (!results.length) return UNVERIFIED;
  return results.includes(FAIL) ? FAIL : results.includes(UNVERIFIED) ? UNVERIFIED : PASS;
}

async function prove(step, opts = {}, deps = {}) {
  if (step !== 'all' && !STEPS.includes(step)) throw usage(`prove-autonomy <${STEPS.join('|')}|all>`);
  if (opts.desk !== undefined && opts.desk !== 'online') throw usage('--desk takes one value: online.');
  if (opts.project !== undefined && !isProjectId(opts.project)) throw usage('--project takes a project ID.');
  if (opts.expect !== undefined && !SHA_RE.test(String(opts.expect))) throw usage('--expect-revision takes a 40-character commit ID.');
  if (opts.evidence !== undefined && (typeof opts.evidence !== 'string' || !opts.evidence.trim())) throw usage('--evidence needs a directory.');
  const env = deps.env || process.env;
  const now = deps.now || (() => Date.now());
  const home = deps.home || os.homedir();
  const codeRoot = deps.codeRoot || path.resolve(__dirname, '..', '..');
  const ctx = {
    env, now, home, codeRoot,
    forbiddenRoots: (opts.forbiddenRoots || []).filter(Boolean),
    git: deps.git || defaultGit(codeRoot, env),
    fetchImpl: deps.fetchImpl || globalThis.fetch,
    evidence: opts.evidence,
    desk: opts.desk,
    project: opts.project,
    expect: opts.expect,
    memo: new Map(),
    runId: deps.runId || `${new Date(now()).toISOString().replace(/[-:.]/g, '').slice(0, 15)}Z-${step}-${crypto.randomBytes(4).toString('hex')}`,
  };
  const root = opts.noWrite ? null : outputRoot(opts, ctx);
  ctx.facts = gitFacts(ctx.git);
  ctx.deployed = await readDeployed(ctx);

  const wanted = step === 'all' ? STEPS : [step];
  for (const s of wanted) await proveStep(s, ctx);
  const clean = cleaner(env, home);
  const reports = wanted.map((s) => clean(ctx.memo.get(s)));
  const summary = step === 'all' ? {
    format: FORMAT,
    step: 'all',
    result: worstOf(reports.map((r) => r.result)),
    reason: 'One step that does not PASS keeps this aggregate from PASS.',
    verified_at: new Date(now()).toISOString(),
    verifier: clean(ctx.facts),
    deployed: clean(ctx.deployed),
    steps: reports.map((r) => ({ step: r.step, result: r.result, reason: r.reason })),
  } : null;
  const out = summary || reports[0];
  const written = root ? writeReports(reports, summary, root, ctx) : { out_dir: null, report_files: [] };
  return clean({ ...out, ...written, ...(summary ? { reports } : {}) });
}

module.exports = { FORMAT, PASS, FAIL, UNVERIFIED, EXIT, STEPS, SPECS, HOW, prove, renderText, within, usableAt, healthzRevision, secretScan, gitChildEnv };
