'use strict';
// The gate readers: lineage, attribution, basis, restart and the five hosted
// results. New functionality. Every bundle here is synthetic, so a PASS below
// proves the classifier and never a milestone. No task, provider or live desk.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const A = require('../core/autonomy-proof');
const OR = require('../core/opening-receipt');
const G = require('../core/contract-gate');
const { tempWorkspace } = require('./helpers');

const ROOT = path.resolve(__dirname, '../..');
const SHA = 'a'.repeat(40);
const OTHER = 'c'.repeat(40);
const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const iso = (h) => new Date(T0 + h * 3600000).toISOString();
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const check = (r, id) => r.checks.find((c) => c.id === id);
const PID = 'proof-project';
const [DEC1, COID1, INT1, DEC2, COID2, INT2] = ['td_one', 'cr2-one', 'intent-one', 'td_two', 'cr2-two', 'intent-two'];
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---- One complete bundle per step, in the shape of the desk's own views ----
function complete(step, base = SHA) {
  const revision = { observed_at: iso(0), origin_main: base, runner_head: base, healthz_status: 200, deployed_sha: base };
  const healthz = `ok\nrevision ${base} (main)\nstarted ${iso(0)}\n`;
  const tasks = { observed_at: iso(0), pilot: { state: 'Disabled', enabled: false, instances: 0 }, hourly: { state: 'Disabled', instances: 0 } };
  const controls = (over = {}) => ({
    format: 'cr-desk-controls@1', at: iso(1), poll: { state: 'fresh', last_polled_at: iso(1), runner_id: 'pc-runner' },
    dispatch: { sessions: { day: '2026-11-01', used: 2 }, projects_unreadable: null },
    authority: { paused: false, mandate: { generation: 3, expires_at: iso(200) }, admission: { on: false, enabled: false } },
    controls: { pause: { done: false }, mandate_off: { done: true } },
    projects: [{ project_id: PID, dispatch: { state: 'released', reconcile: false, attempt_id: 'att1', claim_state: 'released', run_id: 'run1' }, reports: { claude: { report_id: 'rep1' } } }],
    ...over,
  });
  // The order's opening receipt (cr.opening-guard.v1) as the book wrote it on
  // the reservation line, and that reservation as `tickets basis` shows it
  // (decision-basis.js executionOf: execution.reserved[], contract_guard).
  const guard = {
    version: OR.VERSION, gate_mode: 'enforce', checked_at: iso(1 / 3), result: 'pass', rule_id: 'CG-14', gate: { version: G.GATE_VERSION, exit: G.EXIT_VERSION },
    observation: { observation_id: 'co_0123456789abcdef', sha256: 'b'.repeat(64), chain_id: '1', block_number: 100, block_hash: `0x${'c'.repeat(64)}`, block_time: iso(0) },
    quantity: { unit: 'token', risk_sized: '10', final: '10', sized_by: 'risk', decimals: 18, final_base_units: '10000000000000000000' },
    exit: { pool: `0x${'d'.repeat(40)}`, cost_pct: '2.5', value_usd: '20', value_basis: 'entry', notional_usd: '20', entry_usd: '2' },
    limits: { exit_cost_pct: 5, network_fee_usd: '1', price_stale_minutes: 90 }, price_check: { state: 'ok', limit_minutes: 90, gap_ms: 0, as_of: iso(0) }, size: null,
  };
  const checked = { version: OR.CHECK_VERSION, status: 'bound', words: 'The receipt is bound to this reservation.', differences: [] };
  const reserved1 = {
    at: iso(1 / 3), intent_id: INT1, intent_sha256: 'a'.repeat(64), side: 'OPEN_LONG', entry_price: '2', client_order_id: COID1, position_id: 'pos-one', quantity: '10', notional_usd: '20',
    grant: { thesis_id: 'tk1', project_id: PID, receipt_id: 'tk1', decision_id: DEC1, action: 'approve', suggested_risk_usd: '500', pm_approved_risk_usd: '500' },
    contract_guard: guard, opening_receipt: checked,
  };
  const basis1 = { format: 'cr-decision-view@1', label: 'decision_time', digest: 'verified', decision: { decision_id: DEC1 }, originals: [], execution: { label: 'execution_time', state: 'recorded', reserved: [reserved1], fills: [], exits: [] } };
  // The order's opening receipt as the trader view's order row carries it (core/opening-receipt.js summaryOf).
  const receipt = OR.summaryOf({ ...checked, reservation: { decision_id: DEC1, grant: { by_mandate: true }, intent_id: INT1, intent_sha256: 'a'.repeat(64), quantity: '10' }, record: guard });
  const order = (over = {}) => ({ client_order_id: COID1, intent_id: INT1, side: 'OPEN_LONG', decision_id: DEC1, state: 'ACKED', filled: '0', quantity: '10', opening_receipt: { ...receipt }, ...over });
  const trader = (over = {}) => ({ now: iso(1), orders: [order()], requests: [{ decision_id: DEC1, receipt_id: 'tk1' }], results: { open_positions: [], closed_positions: [] }, candles: { accounting_unknown: null, last_run_at: iso(1) }, ...over });
  const line = (over = {}) => ({ format: 'cr-pilot-all@1', dry_run: false, max_agents: 1, polled: [], exit: 0, error: null, revision: { runner: base, desk: base, source: 'git', clean: true }, ...over });
  // Sent at 00:20: the first eligible hour is 01:00-02:00, usable at 02:10.
  const lineage1 = { project_id: PID, run_id: 'run1', report_id: 'rep1', receipt_id: 'tk1', generation: 3, decision_id: DEC1, intent_id: INT1, client_order_id: COID1, sent_at: iso(1 / 3), control: 'mandate_off', control_applied_at: iso(1), healthchecks_start_and_final_seen: true, grant_stays_in_force: true, grant_reused: false, counted_toward_ny_day: '2026-11-01' };
  const lineage2 = { ...lineage1, run_id: 'run2', report_id: 'rep2', receipt_id: 'tk2', generation: 4, decision_id: DEC2, intent_id: INT2, client_order_id: COID2, sent_at: iso(24.5) };
  const order2 = order({ client_order_id: COID2, intent_id: INT2, decision_id: DEC2, state: 'FILLED', filled: '10' });
  const fill = { client_order_id: COID2, hour: iso(25), price: '2', quantity: '10', fee_usd: '0.1' };
  switch (step) {
    case 'r0': return {
      'revision-final.json': revision, 'healthz.txt': healthz, 'tasks-final.json': tasks,
      'verification.json': { runner: { detached: true, clean: true }, hourly_route: { stand_in_exit: 73, expected_exit: 73, records_root: 'D:\\Desk' } },
      'pilot-all.final-status.json': { registered: true, ours: true, status: { task: { state: 'Disabled' } }, config: { launcher: 'job_wrapper', max_agents: 1, unattended: true, model_named: true, checkout_clean: true, checkout_head: base, working_directory_is_repository: true } },
      'doctor-main-workspace.json': { verified_write: true, checks: [{ name: 'Workspace folder', status: 'ok', detail: 'D:\\Desk (kind: real, id: ws_1)' }, { name: 'Scheduled task', status: 'warn', detail: 'note' }] },
      'offsite-readback.json': { jobs: { offsite: { last_run_at: iso(2), last_status: 'ok' } } },
    };
    case 'b0': return {
      'revision-final.json': revision, 'healthz.txt': healthz, 'tasks-final.json': tasks, 'controls.json': controls(), 'trader.json': trader({ orders: [] }),
      'dry-run.json': line({ dry_run: true }), 'dry-run-negative.json': line({ dry_run: true, exit: 1, error: 'Revision guard: This checkout has uncommitted changes.' }),
      'isolation.json': { format: 'cr-pilot-launch@1', ok: true },
      'doctor.json': { checks: [{ name: 'Market data', detail: 'Last success' }, { name: 'Contract screening', detail: '2 screened' }, { name: 'Forensics', detail: 'none yet' }] },
      'candidate.json': { project_id: PID, chain: 'ethereum', contract: '0xabc', coingecko_id: 'proof', exit_target: '500', model_id: 'claude-opus-5-5', vetoed: false, held: false, arm_desk_reviewed: true, contract_gate: 'enforce', max_grants_per_day: 1 },
      'build-deploy.json': { render_deploy_commit: base, prs: [1, 2, 3, 4].map((number) => ({ number, merged: true, head_checks: 'green' })) },
      'authority.json': { render_cron: 'absent', scout_enabled: false },
      'heartbeat.json': { period_minutes: 60, grace_minutes: 120, alerts_eric_only: true, dry_run_ping_claimed: false },
      'B0.txt': 'readback\n',
    };
    case 'b1': return {
      'lineage.json': lineage1, 'run-log.json': line(), 'desk-controls-after.json': controls({ at: iso(3) }),
      'trader-after-ack.json': trader({ now: iso(0.5), candles: { accounting_unknown: null, last_run_at: iso(0.2) } }),
      'basis-after-ack.json': basis1,
      'trader-after-window.json': trader({ now: iso(3), orders: [order({ state: 'CANCELLED' })], candles: { accounting_unknown: null, last_run_at: iso(3) } }),
      'window.json': { enabled_at: iso(-1), disabled_at: iso(2.5), candidate_project_id: PID, other_projects_ran: false },
      'tasks-after.json': { observed_at: iso(2.6), pilot: { state: 'Disabled', instances: 0 } },
      'B1.txt': 'readback\n',
    };
    case 'b2': return {
      'lineage.json': lineage2,
      'successor.json': { report_id: 'rep2', rearm_reviewed: true, cap_relaxed: false, respects_cancelled_grant: true },
      'attribution.json': { rows: [{ decision_id: DEC2, decided_by: 'mandate', inputs: { label: 'decision_time' }, not_recorded_at_execution: ['engine'] }] },
      'basis.json': { format: 'cr-decision-view@1', label: 'decision_time', digest: 'verified', decision: { decision_id: DEC2 }, originals: [{ report_id: 'rep2', digest: 'verified' }], execution: { fills: [fill], exits: [] } },
      'trader.json': trader({ now: iso(26), orders: [order2], results: { open_positions: [{ position_id: 'pos-2', decision_id: DEC2, stop_loss_price: '1.5' }], closed_positions: [] } }),
      'lifecycle-evidence.json': { contract_evidence_block_pinned: true, exits_complete_and_fresh: true, sizing_passed: true, candles_passed: true, risk_management_observed: true },
      'deploys.json': { backfilled: false, render_deploys: [] },
      'B2.txt': 'readback\n',
    };
    case 'b3': {
      const tv = trader({ now: iso(27), orders: [order2], results: { open_positions: [{ position_id: 'pos-2', decision_id: DEC2, stop_loss_price: '1.5' }], closed_positions: [] } });
      return {
        'trader-before.json': tv, 'trader-after.json': { ...tv, now: iso(28) }, 'trader-restart.json': { ...tv, now: iso(29) },
        'desk-controls-before.json': controls({ at: iso(27) }), 'desk-controls-repeat.json': controls({ at: iso(28) }), 'desk-controls-restart.json': controls({ at: iso(29) }),
        'run-log-repeat.json': line(), 'run-log-restart.json': line(),
        'B3.txt': 'readback\n',
      };
    }
    case 'cutover': {
      const hosted = (at) => controls({ at, poll: { state: 'fresh', last_polled_at: at, runner_id: 'render-ops1' } });
      return {
        'approval.json': { hosted_activation: true, credentials: true, recurring_cost: true, approved_at: iso(9) },
        'pc-task.json': { observed_at: iso(10), pilot: { state: 'Disabled' } },
        'service.json': { name: 'cryptoresearch-runner', stayed_suspended_until_cutover: true, resumed_at: iso(11), first_run: { preflight_ok: true, revision_match: true, runner_id: 'render-ops1', post_sighting: true, heartbeat_delivered: true } },
        'kill-drill.json': { attempt_id: 'att9', saves_after_cancel: 0, completes_after_cancel: 0, claim_stayed_dispatched: true, sessions_grew: false, pc_task_disabled: true, cron_suspended: true, reconciled_by_eric: true },
        'desk-down.json': { ci_run_id: '12345' },
        'operations.json': { stop_veto_verified: true, failure_visibility_verified: true, recovery_verified: true, suspend_first_rollback_verified: true },
        'desk-controls-2h.json': hosted(iso(13)), 'desk-controls-6h.json': hosted(iso(17)), 'desk-controls-24h.json': hosted(iso(35)),
        'healthchecks.json': { missed_periods: 0 },
        'lifecycle.json': { project_id: PID, report_id: 'rep3', receipt_id: 'tk3', runner_id: 'render-ops1', pc_task_disabled: true, receipt_intact: true, mandate_evaluation: 'granted', fill: 'proven', closed_outcome: 'proven', decision_id: 'td_three', client_order_id: 'cr2-three', sent_at: iso(36.5) },
        'basis-hosted.json': { execution: { fills: [{ client_order_id: 'cr2-three', hour: iso(37), price: '2', fee_usd: '0.1' }] } },
        'trader-hosted.json': { results: { open_positions: [], closed_positions: [{ position_id: 'pos-3', decision_id: 'td_three', realized_pnl_usd: '4', exits: [{ reason: 'take_profit', hour: iso(38) }] }] } },
        'cutover.txt': 'readback\n',
      };
    }
    default: throw new Error(step);
  }
}
const CLOSED = { r0: 3, b0: 4, b1: 5, b2: 30, b3: 31, cutover: 40 };

function writeStep(root, step, { edit = {}, drop = [], manifest = {}, base = SHA } = {}) {
  const dir = path.join(root, A.FOLDERS[step]);
  fs.mkdirSync(dir, { recursive: true });
  const files = { ...complete(step, base), ...edit };
  for (const name of drop) delete files[name];
  const listed = [];
  for (const [name, value] of Object.entries(files)) {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    fs.writeFileSync(path.join(dir, name), buf);
    listed.push({ path: name, bytes: buf.length, sha256: sha256(buf) });
  }
  const text = JSON.stringify({ format: `cr-operating-proof-${step}-evidence@1`, closed_at: iso(CLOSED[step]), baseline: base, files: listed, ...manifest });
  fs.writeFileSync(path.join(dir, 'manifest.json'), text);
  return sha256(text);
}
function evidence(t, over = {}, steps = A.STEPS) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-proof-records-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  for (const s of steps) writeStep(root, s, over[s]);
  return root;
}
function proofDeps({ head = SHA, origin = SHA, anchored = () => true, changed = ['docs/engineering/OPERATING_PROOF_B1.md'], onMain = true, deployed = SHA, env = {} } = {}) {
  return {
    now: () => iso(400),
    env: { PATH: process.env.PATH || process.env.Path, ...env },
    fetchImpl: async () => new Response(`ok\nrevision ${deployed} (main)\n`, { status: 200 }),
    run: (cmd, args) => {
      const a = args.slice(2);
      if (a[0] === 'rev-parse') return { status: 0, stdout: a[2] === 'HEAD' ? head : origin };
      if (a[0] === 'status') return { status: 0, stdout: '' };
      if (a[0] === 'merge-base') return a[1] === '--is-ancestor' ? { status: a[2] === SHA && !onMain ? 1 : 0, stdout: '' } : { status: 0, stdout: head };
      if (a[0] === 'show') return { status: 0, stdout: fs.readFileSync(path.join(ROOT, a[1].slice('HEAD:'.length)), 'utf8') };
      if (a[0] === 'grep') return { status: anchored(a[3]) ? 0 : 1, stdout: '' };
      if (a[0] === 'diff') return { status: 0, stdout: `${changed.join('\n')}\n` };
      return assert.fail(`Unexpected git operation: ${a[0]}`);
    },
  };
}
const prove = (step, root, opts = {}, d = proofDeps()) => A.verify({ step, evidence: root, mode: 'post-merge', expectedRevision: SHA, ...opts }, d);

// ---- PASS is reachable, and only with everything in place -------------------
for (const step of A.STEPS) test(`${step}: complete bound records, anchored, post-merge: PASS (synthetic: the classifier only)`, async (t) => {
  const r = await prove(step, evidence(t));
  assert.equal(r.result, 'PASS', JSON.stringify(r.checks.filter((c) => c.result !== 'PASS'), null, 1));
  assert.equal(r.exit_code, 0);
  assert.ok(A.GATES[step].every(([id]) => check(r, `${step}:${id}`).result === 'PASS'));
  assert.equal(r.provenance.anchored_by_merged_receipt, true);
  assert.match(r.reason, /on Eric's own record/);
  assert.ok(r.checks.filter((c) => c.observation === 'owner_record').length || ['r0', 'b3'].includes(step), 'where the desk has no read, the check says it rests on Eric');
  assert.deepEqual(r.missing_evidence, []);
});

test('every gate in the merged canon has a reader, and only those', () => {
  for (const step of A.STEPS) assert.deepEqual(Object.keys(A.READERS[step]).sort(), A.GATES[step].map(([id]) => id).sort());
});

for (const step of A.STEPS) test(`${step}: removing any one record keeps the step from PASS`, async (t) => {
  for (const name of Object.keys(complete(step))) {
    const r = await prove(step, evidence(t, { [step]: { drop: [name] } }));
    assert.notEqual(r.result, 'PASS', `${step} passed without ${name}`);
  }
});

for (const step of ['b1', 'b2', 'b3', 'cutover']) test(`${step}: an unrecorded step is UNVERIFIED beside complete earlier steps, never a false PASS`, async (t) => {
  const earlier = A.STEPS.slice(0, A.STEPS.indexOf(step));
  const r = await prove(step, evidence(t, {}, earlier));
  assert.equal(r.result, 'UNVERIFIED');
  assert.equal(r.exit_code, 2);
  assert.ok(A.GATES[step].every(([id]) => check(r, `${step}:${id}`).result === 'UNVERIFIED' && check(r, `${step}:${id}`).executed === false));
  assert.equal(check(r, 'prerequisites').result, 'PASS');
});

// ---- Contradiction is FAIL, and names the gate ------------------------------
const edit = (step, name, change) => { const v = clone(complete(step)[name]); change(v); return { [step]: { edit: { [name]: v } } }; };
const CONTRADICTIONS = [
  ['r0', 'tasks-final.json', (v) => { v.pilot.state = 'Ready'; }, 'r0:quiet_swap'],
  ['r0', 'pilot-all.final-status.json', (v) => { v.config.checkout_head = OTHER; }, 'r0:registration'],
  ['r0', 'revision-final.json', (v) => { v.deployed_sha = OTHER; }, 'r0:alignment'],
  ['r0', 'doctor-main-workspace.json', (v) => { v.checks[0].detail = 'D:\\Other (kind: real, id: ws_2)'; }, 'r0:hourly_route'],
  ['r0', 'doctor-main-workspace.json', (v) => { v.verified_write = false; }, 'r0:doctor'],
  ['r0', 'offsite-readback.json', (v) => { v.jobs.offsite.last_status = 'error'; }, 'r0:offsite_run'],
  ['b0', 'build-deploy.json', (v) => { v.prs[2].head_checks = 'red'; }, 'b0:build_deploy'],
  ['b0', 'authority.json', (v) => { v.render_cron = 'running'; }, 'b0:quiet_authority'],
  ['b0', 'controls.json', (v) => { v.authority.admission.on = true; }, 'b0:quiet_authority'],
  ['b0', 'controls.json', (v) => { v.projects[0].dispatch = { state: 'reconcile', reconcile: true }; }, 'b0:quiet_authority'],
  ['b0', 'dry-run-negative.json', (v) => { v.exit = 0; }, 'b0:dry_run'],
  ['b0', 'heartbeat.json', (v) => { v.grace_minutes = 60; }, 'b0:heartbeat_config'],
  ['b0', 'doctor.json', (v) => { v.checks[0].detail = 'meter unknown'; }, 'b0:meters'],
  ['b0', 'trader.json', (v) => { v.orders = [{ client_order_id: 'x', state: 'UNKNOWN' }]; }, 'b0:meters'],
  ['b0', 'candidate.json', (v) => { v.vetoed = true; }, 'b0:arming_identity'],
  ['b1', 'window.json', (v) => { v.other_projects_ran = true; }, 'b1:window'],
  ['b1', 'tasks-after.json', (v) => { v.pilot.state = 'Ready'; }, 'b1:window'],
  ['b1', 'trader-after-ack.json', (v) => { v.orders[0].decision_id = 'td_other'; }, 'b1:lineage'],
  // The order's opening receipt (cr.opening-guard.v1): anything but bound, to this order, under enforce, with a pass.
  ['b1', 'trader-after-ack.json', (v) => { v.orders[0].opening_receipt.status = 'missing'; }, 'b1:lineage'],
  ['b1', 'trader-after-ack.json', (v) => { v.orders[0].opening_receipt.status = 'not_checked'; }, 'b1:lineage'],
  ['b1', 'trader-after-ack.json', (v) => { v.orders[0].opening_receipt.status = 'unreadable'; }, 'b1:lineage'],
  ['b1', 'trader-after-ack.json', (v) => { v.orders[0].opening_receipt.status = 'mismatch'; v.orders[0].opening_receipt.differences = ['exit.pool']; }, 'b1:lineage'],
  ['b1', 'trader-after-ack.json', (v) => { v.orders[0].opening_receipt.status = 'some later word'; }, 'b1:lineage'],
  ['b1', 'trader-after-ack.json', (v) => { v.orders[0].opening_receipt.reserved_quantity = '9'; }, 'b1:lineage'],
  ['b1', 'trader-after-ack.json', (v) => { v.orders[0].opening_receipt.decision_id = 'td_other'; }, 'b1:lineage'],
  ['b1', 'trader-after-ack.json', (v) => { v.orders[0].opening_receipt.intent_id = 'intent-other'; }, 'b1:lineage'],
  ['b1', 'trader-after-ack.json', (v) => { v.orders[0].opening_receipt.gate_mode = 'observe'; }, 'b1:lineage'],
  ['b1', 'trader-after-ack.json', (v) => { v.orders[0].opening_receipt.result = 'not_checked'; }, 'b1:lineage'],
  // A row that reads bound is borne out by the persisted reservation (basis-after-ack.json, `tickets basis --json`):
  // the row's figures must be the receipt's on that reservation, figure by figure.
  ['b1', 'trader-after-ack.json', (v) => { v.orders[0].opening_receipt.differences = ['exit.pool']; }, 'b1:lineage'],
  ['b1', 'trader-after-ack.json', (v) => { v.orders[0].opening_receipt.cost_pct = '9.1'; }, 'b1:lineage'],
  ['b1', 'trader-after-ack.json', (v) => { v.orders[0].opening_receipt.limit_pct = 50; }, 'b1:lineage'],
  ['b1', 'trader-after-ack.json', (v) => { v.orders[0].opening_receipt.exit_pool = `0x${'e'.repeat(40)}`; }, 'b1:lineage'],
  ['b1', 'trader-after-ack.json', (v) => { v.orders[0].opening_receipt.observation_id = 'co_fedcba9876543210'; }, 'b1:lineage'],
  ['b1', 'trader-after-ack.json', (v) => { v.orders[0].opening_receipt.observation_sha256 = 'e'.repeat(64); }, 'b1:lineage'],
  ['b1', 'trader-after-ack.json', (v) => { v.orders[0].opening_receipt.block_number = 101; }, 'b1:lineage'],
  ['b1', 'trader-after-ack.json', (v) => { v.orders[0].opening_receipt.valuation = 'cr-contract-exit@9'; }, 'b1:lineage'],
  ['b1', 'trader-after-ack.json', (v) => { v.orders[0].opening_receipt.intent_sha256 = 'f'.repeat(64); }, 'b1:lineage'],
  ['b1', 'trader-after-ack.json', (v) => { v.orders[0].opening_receipt.quantity.final = '9'; }, 'b1:lineage'],
  ['b1', 'trader-after-ack.json', (v) => { v.orders[0].opening_receipt.size = { pool: `0x${'e'.repeat(40)}`, reference_usd: '500', quote_input: 'recorded', observation_id: 'co_0123456789abcdef' }; }, 'b1:lineage'],
  ['b1', 'trader-after-ack.json', (v) => { const o = v.orders[0]; o.quantity = '9'; o.opening_receipt.reserved_quantity = '9'; o.opening_receipt.quantity = { ...o.opening_receipt.quantity, final: '9', risk_sized: '9', final_base_units: '9000000000000000000' }; }, 'b1:lineage'],
  // The reservation itself: its identifiers, its grant, the desk's check of it, and the receipt written on it.
  ['b1', 'basis-after-ack.json', (v) => { v.execution.reserved[0].quantity = '9'; }, 'b1:lineage'],
  ['b1', 'basis-after-ack.json', (v) => { v.execution.reserved[0].client_order_id = 'cr2-other'; }, 'b1:lineage'],
  ['b1', 'basis-after-ack.json', (v) => { v.execution.reserved.push(clone(v.execution.reserved[0])); }, 'b1:lineage'],
  ['b1', 'basis-after-ack.json', (v) => { v.execution.reserved[0].side = 'CLOSE_LONG'; }, 'b1:lineage'],
  ['b1', 'basis-after-ack.json', (v) => { v.execution.reserved[0].intent_id = 'intent-other'; }, 'b1:lineage'],
  ['b1', 'basis-after-ack.json', (v) => { v.execution.reserved[0].intent_sha256 = 'e'.repeat(64); }, 'b1:lineage'],
  ['b1', 'basis-after-ack.json', (v) => { v.execution.reserved[0].grant.decision_id = 'td_other'; }, 'b1:lineage'],
  ['b1', 'basis-after-ack.json', (v) => { v.execution.reserved[0].grant.receipt_id = 'tk_other'; }, 'b1:lineage'],
  ['b1', 'basis-after-ack.json', (v) => { v.execution.reserved[0].grant.project_id = 'another-project'; }, 'b1:lineage'],
  ['b1', 'basis-after-ack.json', (v) => { v.execution.reserved[0].grant.action = 'veto'; }, 'b1:lineage'],
  ['b1', 'basis-after-ack.json', (v) => { v.execution.reserved[0].opening_receipt.status = 'mismatch'; }, 'b1:lineage'],
  ['b1', 'basis-after-ack.json', (v) => { v.execution.reserved[0].contract_guard = null; }, 'b1:lineage'],
  ['b1', 'basis-after-ack.json', (v) => { delete v.execution.reserved[0].contract_guard.price_check; }, 'b1:lineage'],
  ['b1', 'basis-after-ack.json', (v) => { v.execution.reserved[0].contract_guard.gate_mode = 'observe'; }, 'b1:lineage'],
  ['b1', 'basis-after-ack.json', (v) => { const g = v.execution.reserved[0].contract_guard; v.execution.reserved[0].contract_guard = { version: g.version, gate_mode: 'observe', checked_at: g.checked_at, result: 'not_checked', why: 'gate_not_enforced', quantity: { unit: 'token', risk_sized: '10', final: '10', sized_by: 'risk' }, size: null }; }, 'b1:lineage'],
  ['b1', 'basis-after-ack.json', (v) => { v.execution.reserved[0].contract_guard.observation.observation_id = 'co_fedcba9876543210'; }, 'b1:lineage'],
  ['b1', 'basis-after-ack.json', (v) => { v.execution.reserved[0].contract_guard.observation.sha256 = 'e'.repeat(64); }, 'b1:lineage'],
  ['b1', 'basis-after-ack.json', (v) => { v.execution.reserved[0].contract_guard.exit.pool = `0x${'e'.repeat(40)}`; }, 'b1:lineage'],
  ['b1', 'basis-after-ack.json', (v) => { v.execution.reserved[0].contract_guard.quantity.final_base_units = '10000000000000000001'; }, 'b1:lineage'],
  ['b1', 'basis-after-ack.json', (v) => { v.execution.reserved[0].contract_guard.quantity.risk_sized = '9'; }, 'b1:lineage'],
  ['b1', 'basis-after-ack.json', (v) => { v.execution.reserved[0].entry_price = '2.5'; }, 'b1:lineage'],
  ['b1', 'basis-after-ack.json', (v) => { v.execution.reserved[0].contract_guard.exit.notional_usd = '21'; }, 'b1:lineage'],
  ['b1', 'basis-after-ack.json', (v) => { v.execution.reserved[0].at = iso(0.2); }, 'b1:lineage'],
  ['b1', 'basis-after-ack.json', (v) => { v.execution = { label: 'execution_time', state: 'integrity', code: 'INTEGRITY', words: 'refused', reserved: null, fills: null, exits: null }; }, 'b1:lineage'],
  ['b1', 'basis-after-ack.json', (v) => { v.decision.decision_id = 'td_other'; }, 'b1:lineage'],
  // The reservation's own desk check, its notional, and records the producer never repeats (review 2026-11-11, F1-F3).
  ['b1', 'basis-after-ack.json', (v) => { v.execution.reserved[0].opening_receipt.differences = [{ field: 'exit.pool' }]; }, 'b1:lineage'],
  ['b1', 'basis-after-ack.json', (v) => { v.execution.reserved[0].notional_usd = '1'; }, 'b1:lineage'],
  ['b1', 'basis-after-ack.json', (v) => { v.execution.reserved[0].notional_usd = '20.000000000000000001'; }, 'b1:lineage'],
  ['b1', 'basis-after-ack.json', (v) => { v.execution.reserved[0].notional_usd = 'twenty'; }, 'b1:lineage'],
  ['b1', 'basis-after-ack.json', (v) => { v.execution.reserved.push({ ...clone(v.execution.reserved[0]), client_order_id: 'cr2-twin', position_id: 'pos-twin', quantity: '70' }); }, 'b1:lineage'],
  ['b1', 'basis-after-ack.json', (v) => { v.execution.reserved.unshift({ ...clone(v.execution.reserved[0]), client_order_id: 'cr2-twin', intent_id: 'intent-twin', position_id: 'pos-twin' }); }, 'b1:lineage'],
  ['b1', 'trader-after-ack.json', (v) => { const o = clone(v.orders[0]); o.opening_receipt.observation_id = 'co_fedcba9876543210'; v.orders.push(o); }, 'b1:lineage'],
  ['b1', 'trader-after-ack.json', (v) => { v.orders.push({ ...clone(v.orders[0]), client_order_id: 'cr2-twin' }); }, 'b1:lineage'],
  ['b1', 'trader-after-window.json', (v) => { v.orders.push({ ...clone(v.orders[0]), state: 'ACKED' }); }, 'b1:cancellation'],
  ['b1', 'lineage.json', (v) => { v.control_applied_at = iso(2.5); }, 'b1:cancellation'],
  ['b1', 'trader-after-window.json', (v) => { v.orders[0].state = 'FILLED'; v.orders[0].filled = '10'; }, 'b1:cancellation'],
  ['b1', 'trader-after-window.json', (v) => { v.results.open_positions = [{ position_id: 'p', decision_id: DEC1 }]; }, 'b1:cancellation'],
  ['b1', 'trader-after-window.json', (v) => { v.candles.last_run_at = iso(0.1); }, 'b1:progress'],
  ['b1', 'desk-controls-after.json', (v) => { v.controls.mandate_off.done = false; }, 'b1:progress'],
  ['b1', 'lineage.json', (v) => { v.grant_reused = true; }, 'b1:grant_liveness'],
  ['b2', 'successor.json', (v) => { v.cap_relaxed = true; }, 'b2:successor'],
  ['b2', 'lineage.json', (v) => { v.decision_id = DEC1; }, 'b2:successor'],
  ['b2', 'attribution.json', (v) => { v.rows[0].decided_by = 'eric'; }, 'b2:lifecycle'],
  ['b2', 'attribution.json', (v) => { v.rows[0].inputs.label = 'reconstructed'; }, 'b2:basis'],
  ['b2', 'attribution.json', () => {}, 'b2:basis', { code: 'INTEGRITY', rows: [] }],
  ['b2', 'basis.json', (v) => { v.digest = 'refused'; }, 'b2:basis'],
  ['b2', 'basis.json', (v) => { v.label = 'reconstructed'; }, 'b2:basis'],
  ['b2', 'deploys.json', (v) => { v.backfilled = true; }, 'b2:execution_stamp'],
  ['b2', 'basis.json', (v) => { v.execution.fills[0].hour = iso(24); }, 'b2:fill_risk'],
  ['b2', 'trader.json', (v) => { v.results.open_positions[0].stop_loss_price = ''; }, 'b2:fill_risk'],
  ['b3', 'trader-after.json', (v) => { v.orders.push({ client_order_id: 'cr2-new', state: 'ACKED', filled: '0' }); }, 'b3:idempotency'],
  ['b3', 'desk-controls-restart.json', (v) => { v.dispatch.sessions.used = 3; }, 'b3:idempotency'],
  ['cutover', 'pc-task.json', (v) => { v.observed_at = iso(12); }, 'cutover:single_runner'],
  ['cutover', 'operations.json', (v) => { v.suspend_first_rollback_verified = false; }, 'cutover:single_runner'],
  ['cutover', 'service.json', (v) => { v.stayed_suspended_until_cutover = false; }, 'cutover:host_installed'],
  ['cutover', 'kill-drill.json', (v) => { v.saves_after_cancel = 1; }, 'cutover:kill_drill'],
  ['cutover', 'kill-drill.json', (v) => { v.sessions_grew = true; }, 'cutover:kill_drill'],
  ['cutover', 'desk-controls-6h.json', (v) => { v.poll.state = 'stale'; }, 'cutover:runner_alive'],
  ['cutover', 'healthchecks.json', (v) => { v.missed_periods = 1; }, 'cutover:runner_alive'],
  ['cutover', 'lifecycle.json', (v) => { v.runner_id = 'pc-runner'; }, 'cutover:lifecycle_proven'],
  ['cutover', 'approval.json', (v) => { v.credentials = false; }, 'cutover:approval'],
];
test('a record that contradicts a gate is FAIL and names that gate', async (t) => {
  for (const [step, name, change, gate, whole] of CONTRADICTIONS) {
    const over = whole ? { [step]: { edit: { [name]: whole } } } : edit(step, name, change);
    const r = await prove(step, evidence(t, over));
    assert.equal(check(r, gate).result, 'FAIL', `${gate} via ${name}: ${check(r, gate).reason}`);
    assert.equal(r.result, 'FAIL');
    assert.equal(r.exit_code, 1);
  }
});

test('B1 lineage: the order\'s opening receipt must be on the capture and checked; absent or uncheckable is UNVERIFIED, never PASS', async (t) => {
  const whole = await prove('b1', evidence(t));
  assert.equal(check(whole, 'b1:lineage').result, 'PASS');
  assert.match(check(whole, 'b1:lineage').reason, /The desk's check reads the order's opening receipt bound\./);
  assert.match(check(whole, 'b1:lineage').reason, /The reservation the book holds carries its receipt: an enforced CG-14 pass for exactly 10 tokens, the exit proven at an unrounded 2\.5% within 5%, and the row agrees with it figure by figure\./);
  // The persisted reservation not captured, or captured without the parts B1 reads: never PASS, and not a contradiction.
  const noBasis = await prove('b1', evidence(t, { b1: { drop: ['basis-after-ack.json'] } }));
  assert.equal(check(noBasis, 'b1:lineage').result, 'UNVERIFIED');
  assert.match(check(noBasis, 'b1:lineage').reason, /Not bound in the manifest: basis-after-ack\.json\./);
  for (const [name, change, why] of [
    ['a basis that shows no receipt field (a desk before the receipt existed)', (v) => { delete v.execution.reserved[0].contract_guard; }, /does not show the receipt written on the reservation/],
    ['a reservation with no time', (v) => { delete v.execution.reserved[0].at; }, /The reservation's time is not on record/],
    ['a reservation with no grant', (v) => { delete v.execution.reserved[0].grant; }, /The grant the book read is not on record/],
    ['a basis with no execution', (v) => { delete v.execution; }, /The basis capture carries no execution/],
  ]) {
    const r = await prove('b1', evidence(t, edit('b1', 'basis-after-ack.json', change)));
    assert.equal(check(r, 'b1:lineage').result, 'UNVERIFIED', name);
    assert.match(check(r, 'b1:lineage').reason, why, name);
  }
  const bare = await prove('b1', evidence(t, edit('b1', 'trader-after-ack.json', (v) => { const r = v.orders[0].opening_receipt; for (const k of ['quantity', 'size', 'observation_id', 'observation_sha256', 'exit_pool', 'cost_pct', 'limit_pct', 'valuation', 'differences']) delete r[k]; })));
  assert.equal(check(bare, 'b1:lineage').result, 'UNVERIFIED', 'a bound row with its figures removed');
  assert.match(check(bare, 'b1:lineage').reason, /the pool the row says proved the exit is not on record/);
  // The unrounded cost against the limit the receipt records, exactly: at the limit is within it; one part in 10^18 over is not.
  const at = (cost) => ({ b1: { edit: {
    'trader-after-ack.json': (() => { const v = clone(complete('b1')['trader-after-ack.json']); v.orders[0].opening_receipt.cost_pct = cost; return v; })(),
    'basis-after-ack.json': (() => { const v = clone(complete('b1')['basis-after-ack.json']); v.execution.reserved[0].contract_guard.exit.cost_pct = cost; return v; })(),
  } } });
  assert.equal(check(await prove('b1', evidence(t, at('5'))), 'b1:lineage').result, 'PASS', 'at the limit');
  assert.equal(check(await prove('b1', evidence(t, at('4.999999999999999999'))), 'b1:lineage').result, 'PASS', 'just under');
  const over = await prove('b1', evidence(t, at('5.000000000000000001')));
  assert.equal(check(over, 'b1:lineage').result, 'FAIL', 'just over, in both records alike');
  assert.match(check(over, 'b1:lineage').reason, /The receipt's unrounded exit cost 5\.000000000000000001% is over the 5% limit it records\./);
  for (const [name, change, why] of [
    ['a capture from a desk before the receipt existed', (v) => { delete v.orders[0].opening_receipt; }, /carries no reading of the order's opening receipt/],
    ['a null reading', (v) => { v.orders[0].opening_receipt = null; }, /carries no reading of the order's opening receipt/],
    ['a receipt the desk could not check', (v) => { v.orders[0].opening_receipt.status = 'unverifiable'; v.orders[0].opening_receipt.words = 'The observation the receipt names is not readable now.'; }, /could not be checked: The observation the receipt names is not readable now/],
    ['an order row with no quantity to compare', (v) => { delete v.orders[0].quantity; }, /What the quantity the receipt is for must match is not on record/],
    ['a bound reading that names no decision', (v) => { delete v.orders[0].opening_receipt.decision_id; }, /the receipt's decision is not on record/],
    ['a bound reading with no gate mode', (v) => { delete v.orders[0].opening_receipt.gate_mode; }, /the gate mode at the opening is not on record/],
  ]) {
    const r = await prove('b1', evidence(t, edit('b1', 'trader-after-ack.json', change)));
    assert.equal(check(r, 'b1:lineage').result, 'UNVERIFIED', name);
    assert.match(check(r, 'b1:lineage').reason, why, name);
    assert.equal(r.result, 'UNVERIFIED', name);
  }
  // A failing receipt says what it reads, in the desk's own words.
  const bad = await prove('b1', evidence(t, edit('b1', 'trader-after-ack.json', (v) => { v.orders[0].opening_receipt.status = 'mismatch'; v.orders[0].opening_receipt.words = 'The receipt is for 71.022727; the book reserved 71.'; })));
  assert.equal(check(bad, 'b1:lineage').result, 'FAIL');
  assert.match(check(bad, 'b1:lineage').reason, /opening receipt reads mismatch: The receipt is for 71\.022727; the book reserved 71/);
});

test('B1 lineage: the reservation\'s own check and notional, and one record per order; several distinct orders stay valid', async (t) => {
  const whole = await prove('b1', evidence(t));
  assert.match(check(whole, 'b1:lineage').reason, /The desk's check of the reservation lists no difference\./);
  assert.match(check(whole, 'b1:lineage').reason, /The book reserved the notional the receipt was measured at, 20\./);
  // The book's notional against the receipt's, exactly: the same figure written with trailing zeros is the same figure.
  assert.equal(check(await prove('b1', evidence(t, edit('b1', 'basis-after-ack.json', (v) => { v.execution.reserved[0].notional_usd = '20.000000000000000000'; }))), 'b1:lineage').result, 'PASS');
  const lost = await prove('b1', evidence(t, edit('b1', 'basis-after-ack.json', (v) => { delete v.execution.reserved[0].notional_usd; })));
  assert.equal(check(lost, 'b1:lineage').result, 'UNVERIFIED', 'no notional on the reservation');
  assert.match(check(lost, 'b1:lineage').reason, /The notional the book reserved is not on record\./);
  const unlisted = await prove('b1', evidence(t, edit('b1', 'basis-after-ack.json', (v) => { delete v.execution.reserved[0].opening_receipt.differences; })));
  assert.equal(check(unlisted, 'b1:lineage').result, 'UNVERIFIED', 'a desk check that lists no differences field');
  assert.match(check(unlisted, 'b1:lineage').reason, /The desk's check of the reservation does not list its differences\./);
  const listed = await prove('b1', evidence(t, edit('b1', 'basis-after-ack.json', (v) => { v.execution.reserved[0].opening_receipt.differences = [{ field: 'exit.pool' }]; })));
  assert.match(check(listed, 'b1:lineage').reason, /The desk's check of the reservation lists 1 difference\(s\)\./);
  // Repeats the producer never writes: ambiguous, FAIL, wherever the repeat sits.
  for (const [name, file, change, why] of [
    ['this order\'s row twice, the copy after it', 'trader-after-ack.json', (v) => { v.orders.push(clone(v.orders[0])); }, /The trader view lists this order 2 times/],
    ['this order\'s row twice, the copy before it', 'trader-after-ack.json', (v) => { v.orders.unshift(clone(v.orders[0])); }, /The trader view lists this order 2 times/],
    ['another row with this order\'s intent', 'trader-after-ack.json', (v) => { v.orders.push({ ...clone(v.orders[0]), client_order_id: 'cr2-twin' }); }, /Another row in the trader view carries this order's intent/],
    ['another reservation with this intent\'s ID', 'basis-after-ack.json', (v) => { v.execution.reserved.push({ ...clone(v.execution.reserved[0]), client_order_id: 'cr2-twin', intent_sha256: 'e'.repeat(64), quantity: '70' }); }, /Another reservation in the decision's execution carries this order's intent/],
    ['another reservation with this intent\'s SHA-256', 'basis-after-ack.json', (v) => { v.execution.reserved.unshift({ ...clone(v.execution.reserved[0]), client_order_id: 'cr2-twin', intent_id: 'intent-twin' }); }, /Another reservation in the decision's execution carries this order's intent/],
  ]) {
    const r = await prove('b1', evidence(t, edit('b1', file, change)));
    assert.equal(check(r, 'b1:lineage').result, 'FAIL', name);
    assert.match(check(r, 'b1:lineage').reason, why, name);
  }
  // Several distinct orders, as a desk with other openings and a close shows them: still PASS.
  const other = (v, i) => ({ ...clone(v), client_order_id: `cr2-other${i}`, intent_id: `intent-other${i}`, intent_sha256: String(i).repeat(64), position_id: `pos-other${i}` });
  const many = { b1: { edit: {
    'trader-after-ack.json': (() => { const v = clone(complete('b1')['trader-after-ack.json']); v.orders = [other(v.orders[0], 1), v.orders[0], { ...other(v.orders[0], 2), side: 'CLOSE_LONG', opening_receipt: null }]; return v; })(),
    'basis-after-ack.json': (() => { const v = clone(complete('b1')['basis-after-ack.json']); const r = v.execution.reserved[0]; v.execution.reserved = [other(r, 1), r, { ...other(r, 2), side: 'CLOSE_LONG', contract_guard: null, opening_receipt: null }]; return v; })(),
  } } };
  const r = await prove('b1', evidence(t, many));
  assert.equal(check(r, 'b1:lineage').result, 'PASS', check(r, 'b1:lineage').reason);
});

test('B2 attribution: inputs.label must be decision_time, and absence is UNVERIFIED, not PASS', async (t) => {
  const none = await prove('b2', evidence(t, edit('b2', 'attribution.json', (v) => { delete v.rows[0].inputs.label; })));
  assert.equal(check(none, 'b2:basis').result, 'UNVERIFIED');
  const norow = await prove('b2', evidence(t, edit('b2', 'attribution.json', (v) => { v.rows = []; })));
  assert.equal(check(norow, 'b2:basis').result, 'UNVERIFIED');
  const badHash = await prove('b2', evidence(t, edit('b2', 'basis.json', (v) => { v.originals.push({ report_id: 'x', digest: 'mismatch' }); })));
  assert.equal(check(badHash, 'b2:basis').result, 'UNVERIFIED');
  const noOriginals = await prove('b2', evidence(t, edit('b2', 'basis.json', (v) => { v.originals = []; })));
  assert.equal(check(noOriginals, 'b2:basis').result, 'UNVERIFIED');
});

test('a lineage missing any one ID, or a fill without its price or fee, is UNVERIFIED; an unknown basis format is FAIL', async (t) => {
  for (const id of ['project_id', 'run_id', 'report_id', 'receipt_id', 'generation', 'decision_id', 'intent_id', 'client_order_id', 'sent_at']) {
    const r = await prove('b1', evidence(t, edit('b1', 'lineage.json', (v) => { delete v[id]; })));
    assert.notEqual(check(r, 'b1:lineage').result, 'PASS', id);
    assert.equal(r.result, 'UNVERIFIED', id);
  }
  for (const field of ['price', 'fee_usd']) {
    const r = await prove('b2', evidence(t, edit('b2', 'basis.json', (v) => { delete v.execution.fills[0][field]; })));
    assert.equal(check(r, 'b2:fill_risk').result, 'UNVERIFIED', field);
  }
  const format = await prove('b2', evidence(t, edit('b2', 'basis.json', (v) => { v.format = 'other@1'; })));
  assert.equal(check(format, 'b2:basis').result, 'FAIL');
});

test('B1 window arithmetic follows the runbook: a send at 14:20 is usable at 16:10', async (t) => {
  assert.equal(new Date(A.usableAt('2026-11-03T14:20:00.000Z')).toISOString(), '2026-11-03T16:10:00.000Z');
  assert.equal(new Date(A.usableAt('2026-11-03T15:00:00.000Z')).toISOString(), '2026-11-03T16:10:00.000Z');
  const early = await prove('b1', evidence(t, edit('b1', 'trader-after-window.json', (v) => { v.now = iso(2); })));
  assert.equal(check(early, 'b1:progress').result, 'UNVERIFIED', 'read before the hour was usable');
});

test('no fill reads "Fill pending": UNVERIFIED, never a pass and never a failure', async (t) => {
  const r = await prove('b2', evidence(t, edit('b2', 'basis.json', (v) => { v.execution.fills = []; })));
  assert.equal(check(r, 'b2:fill_risk').result, 'UNVERIFIED');
  assert.match(check(r, 'b2:fill_risk').reason, /Fill pending/);
  assert.equal(r.result, 'UNVERIFIED');
});

test('B2 closure stays apart: pending blocks nothing, a natural exit is observed, a forced one fails', async (t) => {
  const pending = await prove('b2', evidence(t));
  assert.match(check(pending, 'b2:closure_status').reason, /Closure pending/);
  assert.equal(pending.result, 'PASS');
  const closed = (reason) => ({ b2: { edit: {
    'trader.json': { ...complete('b2')['trader.json'], results: { open_positions: [], closed_positions: [{ position_id: 'pos-2', decision_id: DEC2 }] } },
    'basis.json': { ...complete('b2')['basis.json'], execution: { fills: complete('b2')['basis.json'].execution.fills, exits: [{ position_id: 'pos-2', reason }] } },
  } } });
  assert.match(check(await prove('b2', evidence(t, closed('stop'))), 'b2:closure_status').reason, /natural exit/);
  assert.equal(check(await prove('b2', evidence(t, closed('forced'))), 'b2:closure_status').result, 'FAIL');
});

test('B3: an uncertain attempt stays claimed; releasing it never makes the comparison pass', async (t) => {
  const hold = (state) => (v) => { v.projects[0].dispatch = { state, reconcile: state !== 'claimed', attempt_id: 'att7', claim_state: 'dispatched', run_id: 'run7' }; };
  const before = clone(complete('b3')['desk-controls-before.json']);
  hold('claimed')(before);
  const restart = clone(complete('b3')['desk-controls-restart.json']);
  hold('claimed')(restart);
  restart.projects[0].dispatch.state = 'released';
  const r = await prove('b3', evidence(t, { b3: { edit: { 'desk-controls-before.json': before, 'desk-controls-restart.json': restart } } }));
  assert.equal(check(r, 'b3:uncertainty').result, 'FAIL');
});

test('B3 reports its results apart; hosted restart is never claimed', async (t) => {
  const r = await prove('b3', evidence(t));
  assert.deepEqual(r.separate_results, { cancellation: 'proven', live_fill: 'proven', risk_reduction: 'pending', closure: 'pending', restart: 'proven' });
  assert.equal(r.result, 'PASS', 'pending closure and an unauthorized hosted restart do not block');
  assert.match(check(r, 'b3:separate_results').reason, /Hosted restart stays UNVERIFIED/);
  const stopped = await prove('b3', evidence(t, edit('b3', 'trader-restart.json', (v) => { v.results.open_positions[0].exits = [{ reason: 'close', quantity: '4' }]; })));
  assert.equal(stopped.separate_results.risk_reduction, 'proven', 'a part sold reduces risk');
  assert.equal(stopped.separate_results.closure, 'pending', 'and closes nothing');
  const bad = await prove('b3', evidence(t, edit('b3', 'desk-controls-restart.json', (v) => { v.dispatch.sessions.used = 3; })));
  assert.equal(bad.separate_results.restart, 'failed');
  assert.equal(check(bad, 'b3:separate_results').result, 'FAIL');
});

// ---- The five hosted results ------------------------------------------------
const FLAGS = ['host_installed', 'runner_alive', 'lifecycle_proven', 'fill_proven', 'closed_outcome_proven'];
test('cutover: all five results read from records report proven, apart', async (t) => {
  const r = await prove('cutover', evidence(t));
  assert.deepEqual(r.separate_results, Object.fromEntries(FLAGS.map((f) => [f, 'proven'])));
  assert.equal(r.result, 'PASS');
});
test('cutover: a pending fill reads "fill pending", never passed, and leaves the earlier results standing', async (t) => {
  const r = await prove('cutover', evidence(t, edit('cutover', 'lifecycle.json', (v) => { v.fill = 'pending'; v.closed_outcome = 'pending'; })));
  assert.deepEqual(r.separate_results, { host_installed: 'proven', runner_alive: 'proven', lifecycle_proven: 'proven', fill_proven: 'pending', closed_outcome_proven: 'pending' });
  assert.match(check(r, 'cutover:fill_proven').reason, /Fill pending/);
  assert.equal(r.result, 'UNVERIFIED');
});
test('cutover: a later result never stands in for an earlier one', async (t) => {
  const r = await prove('cutover', evidence(t, edit('cutover', 'lifecycle.json', (v) => { v.receipt_intact = false; })));
  assert.equal(r.separate_results.lifecycle_proven, 'failed');
  assert.equal(r.separate_results.fill_proven, 'proven');
  assert.equal(r.result, 'FAIL');
  const alive = await prove('cutover', evidence(t, edit('cutover', 'desk-controls-24h.json', (v) => { v.at = iso(13); })));
  assert.equal(alive.separate_results.runner_alive, 'pending', 'a read at the wrong hour is no read');
  assert.equal(alive.separate_results.closed_outcome_proven, 'proven');
  assert.equal(alive.result, 'UNVERIFIED');
});
test('cutover: the record\'s own word never proves the fill or the close; failed is FAIL', async (t) => {
  const noBasis = await prove('cutover', evidence(t, { cutover: { drop: ['basis-hosted.json'] } }));
  assert.equal(noBasis.separate_results.fill_proven, 'pending');
  const noBook = await prove('cutover', evidence(t, { cutover: { drop: ['trader-hosted.json'] } }));
  assert.equal(noBook.separate_results.closed_outcome_proven, 'pending');
  const notCausal = await prove('cutover', evidence(t, edit('cutover', 'basis-hosted.json', (v) => { v.execution.fills[0].hour = iso(36); })));
  assert.equal(notCausal.separate_results.fill_proven, 'failed');
  const forced = await prove('cutover', evidence(t, edit('cutover', 'trader-hosted.json', (v) => { v.results.closed_positions[0].exits[0].reason = 'forced'; })));
  assert.equal(forced.separate_results.closed_outcome_proven, 'failed');
  for (const field of ['fill', 'closed_outcome']) {
    const r = await prove('cutover', evidence(t, edit('cutover', 'lifecycle.json', (v) => { v[field] = 'failed'; })));
    assert.equal(r.result, 'FAIL');
  }
});

// ---- What keeps a synthetic or unanchored bundle from PASS ------------------
test('an unanchored bundle stays UNVERIFIED even with every gate satisfied, and declaring it live changes nothing', async (t) => {
  const root = evidence(t, { b1: { manifest: { provenance: 'live_run' } } });
  const bytes = fs.readFileSync(path.join(root, 'B1/manifest.json'));
  const r = await prove('b1', root, {}, proofDeps({ anchored: (d) => d !== sha256(bytes) }));
  assert.equal(check(r, 'b1:anchor').result, 'UNVERIFIED');
  assert.ok(A.GATES.b1.every(([id]) => check(r, `b1:${id}`).result === 'PASS'));
  assert.equal(r.result, 'UNVERIFIED');
  assert.equal(r.provenance.anchored_by_merged_receipt, false);
});
test('a declared or marked fixture never reaches PASS; a fictional marker under a merged receipt is FAIL', async (t) => {
  const flagged = await prove('b1', evidence(t), { fixture: true });
  assert.equal(flagged.result, 'UNVERIFIED');
  assert.equal(flagged.deployment.state, 'not_executed');
  const declared = await prove('b1', evidence(t, { b1: { manifest: { provenance: 'synthetic' } } }));
  assert.equal(check(declared, 'b1:anchor').result, 'UNVERIFIED');
  assert.equal(declared.result, 'UNVERIFIED');
  const marked = edit('b1', 'lineage.json', (v) => { v.note = 'FICTIONAL'; });
  const unanchoredDeps = proofDeps({ anchored: () => false });
  assert.equal(check(await prove('b1', evidence(t, marked), {}, unanchoredDeps), 'b1:anchor').result, 'UNVERIFIED');
  assert.equal(check(await prove('b1', evidence(t, marked)), 'b1:anchor').result, 'FAIL');
});
test('development mode, a stale checkout or an offline read never certifies a complete bundle', async (t) => {
  const root = evidence(t);
  const dev = await A.verify({ step: 'b1', evidence: root, offline: true }, proofDeps());
  assert.equal(check(dev, 'proof_mode').result, 'UNVERIFIED');
  assert.equal(dev.result, 'UNVERIFIED');
  const offline = await prove('b1', root, { offline: true });
  assert.equal(check(offline, 'deployment_revision').result, 'UNVERIFIED');
  assert.equal(offline.result, 'UNVERIFIED');
  const behind = await prove('b1', root, {}, proofDeps({ origin: OTHER }));
  assert.equal(check(behind, 'merged_revision').result, 'UNVERIFIED');
  assert.equal(behind.result, 'UNVERIFIED');
  const elsewhere = await prove('b1', root, {}, proofDeps({ deployed: OTHER }));
  assert.equal(check(elsewhere, 'deployment_revision').result, 'FAIL');
});

// The regression for the flaw in the closed #170: merging the required receipt
// redeploys the desk, so PASS cannot need the deployed revision to equal the baseline.
test('a docs-only merge since the proof keeps PASS reachable; a code change asks for a repeat, never FAIL', async (t) => {
  const root = evidence(t);
  const merge = 'd'.repeat(40);
  const d = (changed) => proofDeps({ head: merge, origin: merge, deployed: merge, changed });
  const docs = await prove('b1', root, { expectedRevision: merge }, d(['docs/engineering/OPERATING_PROOF_B1.md', 'audits/x.md']));
  assert.equal(check(docs, 'baseline_current').result, 'PASS');
  assert.equal(docs.result, 'PASS', 'the deployed revision is the merge, not the baseline');
  const code = await prove('b1', root, { expectedRevision: merge }, d(['docs/engineering/OPERATING_PROOF_B1.md', 'dashboard/cli.js']));
  assert.equal(check(code, 'baseline_current').result, 'UNVERIFIED');
  assert.match(check(code, 'baseline_current').reason, /repeat from R0/);
  assert.equal(code.result, 'UNVERIFIED');
  const offMain = await prove('b1', root, { expectedRevision: merge }, proofDeps({ head: merge, origin: merge, deployed: merge, onMain: false }));
  assert.equal(check(offMain, 'baseline_current').result, 'UNVERIFIED');
});

// ---- Bytes first ------------------------------------------------------------
test('a same-length edit, a missing member or a malformed manifest is FAIL; an unlisted file proves nothing', async (t) => {
  const tampered = evidence(t);
  const p = path.join(tampered, 'B1/lineage.json');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('"grant_reused":false', '"grant_reused":fals3'));
  const r = await prove('b1', tampered);
  assert.equal(check(r, 'b1:manifest').result, 'FAIL');
  assert.ok(A.GATES.b1.every(([id]) => check(r, `b1:${id}`).result === 'UNVERIFIED'), 'no record of a broken bundle is read');
  const gone = evidence(t);
  fs.unlinkSync(path.join(gone, 'B1/window.json'));
  assert.equal(check(await prove('b1', gone), 'b1:manifest').result, 'FAIL');
  const bad = evidence(t);
  fs.writeFileSync(path.join(bad, 'B1/manifest.json'), '{"files":');
  assert.equal(check(await prove('b1', bad), 'b1:manifest').result, 'FAIL');
  const unlisted = evidence(t, { b1: { drop: ['window.json'] } });
  fs.writeFileSync(path.join(unlisted, 'B1/window.json'), JSON.stringify(complete('b1')['window.json']));
  const u = await prove('b1', unlisted);
  assert.equal(check(u, 'b1:window').result, 'UNVERIFIED');
  assert.match(check(u, 'b1:window').reason, /Not bound/);
});
test('a manifest cannot read outside its bundle, and a future or unnamed bundle is not accepted', async (t) => {
  const out = evidence(t);
  const m = JSON.parse(fs.readFileSync(path.join(out, 'B1/manifest.json')));
  m.files[0].path = '../R0/healthz.txt';
  fs.writeFileSync(path.join(out, 'B1/manifest.json'), JSON.stringify(m));
  assert.equal(check(await prove('b1', out), 'b1:manifest').result, 'FAIL');
  for (const manifest of [{ closed_at: iso(500) }, { baseline: 'nope' }, { format: 'other@1' }]) {
    const r = await prove('b1', evidence(t, { b1: { manifest } }));
    assert.equal(check(r, 'b1:manifest').result, 'UNVERIFIED');
    assert.equal(r.result, 'UNVERIFIED');
  }
});
test('a bound record that does not parse or has the wrong shape is UNVERIFIED: nothing is reconstructed', async (t) => {
  const r = await prove('b1', evidence(t, { b1: { edit: { 'lineage.json': '{"project_id":' } } }));
  assert.match(check(r, 'b1:lineage').reason, /malformed/);
  assert.equal(check(r, 'b1:lineage').result, 'UNVERIFIED');
  for (const shape of [{}, { orders: 'x' }, []]) {
    const s = await prove('b1', evidence(t, { b1: { edit: { 'trader-after-window.json': shape } } }));
    assert.notEqual(check(s, 'b1:cancellation').result, 'PASS');
  }
  const empty = await prove('b2', evidence(t, { b2: { edit: { 'basis.json': {} } } }));
  assert.equal(check(empty, 'b2:fill_risk').result, 'UNVERIFIED');
});
test('a UTF-16 PowerShell capture reads the same', async (t) => {
  const v = complete('b1')['lineage.json'];
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(v), 'utf16le')]);
  const r = await prove('b1', evidence(t, { b1: { edit: { 'lineage.json': utf16 } } }));
  assert.equal(r.result, 'PASS');
});

// ---- The chain --------------------------------------------------------------
test('a step is not proven past an earlier one; out-of-order bundles fail', async (t) => {
  const noB1 = await prove('b2', evidence(t, {}, ['r0', 'b0', 'b2']));
  assert.equal(check(noB1, 'prerequisites').result, 'UNVERIFIED');
  assert.equal(noB1.prerequisite_results.b1.result, 'UNVERIFIED');
  assert.equal(noB1.prerequisite_results.r0.result, 'PASS');
  assert.equal(noB1.result, 'UNVERIFIED');
  const failedB0 = await prove('b1', evidence(t, edit('b0', 'authority.json', (v) => { v.render_cron = 'running'; })));
  assert.equal(failedB0.prerequisite_results.b0.result, 'FAIL');
  assert.ok(failedB0.prerequisite_results.b0.not_passing.includes('b0:quiet_authority'));
  assert.equal(check(failedB0, 'prerequisites').result, 'UNVERIFIED');
  const order = await prove('b1', evidence(t, { b1: { manifest: { closed_at: iso(3.5) } } }));
  assert.equal(check(order, 'prerequisites').result, 'FAIL');
  assert.equal(order.result, 'FAIL');
  const pendingFill = await prove('b3', evidence(t, edit('b2', 'basis.json', (v) => { v.execution.fills = []; })));
  assert.equal(pendingFill.separate_results.live_fill, 'pending');
  assert.equal(pendingFill.result, 'UNVERIFIED');
});

// ---- Project scope ----------------------------------------------------------
test('--project scopes a lineage: another project\'s records prove nothing for it', async (t) => {
  const r = await prove('b1', evidence(t), { project: 'other-project' });
  assert.equal(check(r, 'b1:lineage').result, 'UNVERIFIED');
  assert.equal(r.result, 'UNVERIFIED');
});

// ---- Secrets ----------------------------------------------------------------
test('a credential in a bound record is FAIL and its value is never repeated, nor is any record\'s free text', async (t) => {
  const token = `ghp_${'x'.repeat(24)}`;
  const r = await prove('b1', evidence(t, edit('b1', 'lineage.json', (v) => { v.note = token; })));
  assert.equal(check(r, 'b1:no_secret_values').result, 'FAIL');
  assert.ok(!JSON.stringify(r).includes(token));
  const envValue = 'ENV-CREDENTIAL-VALUE-123456';
  const e = await prove('b1', evidence(t, edit('b1', 'window.json', (v) => { v.note = envValue; })), {}, proofDeps({ env: { DESK_INGEST_KEY: envValue } }));
  assert.equal(check(e, 'b1:no_secret_values').result, 'FAIL');
  assert.ok(!JSON.stringify(e).includes(envValue));
  const marker = 'Free text from a record, with a path C:\\private\\file';
  const echo = await prove('b1', evidence(t, edit('b1', 'trader-after-window.json', (v) => { v.orders[0].state = marker; })));
  assert.equal(check(echo, 'b1:cancellation').result, 'FAIL');
  assert.ok(!JSON.stringify(echo).includes(marker));
  assert.ok(!A.render(echo).includes(marker));
});
test('a saved test log that mentions credential shapes does not fail a bundle: only records a gate reads are scanned', async (t) => {
  const r = await prove('r0', evidence(t, { r0: { edit: { 'full-suite.log': `FICTIONAL sk-ant-${'y'.repeat(20)}` } } }));
  assert.equal(check(r, 'r0:no_secret_values').result, 'PASS');
  assert.equal(r.result, 'PASS');
});

// ---- Against the desk's real views and real git, not stubs ------------------
test('the readers hold against the desk\'s own views on a fictional workspace', async (t) => {
  const w = tempWorkspace('proof-shape');
  t.after(w.cleanup);
  const ctl = require('../core/desk-controls').view(w.ws);
  const tv = { ...require('../core/trader-desk').view(w.ws), candles: require('../core/trader-candles').statusView(w.ws) };
  assert.equal(ctl.format, 'cr-desk-controls@1');
  const ctx = { baseline: SHA, prior: {}, separate: () => ({}) };
  assert.equal(A.READERS.b3.uncertainty.judge({ 'desk-controls-before.json': ctl, 'desk-controls-restart.json': ctl }, ctx).result, 'PASS');
  const same = A.READERS.b3.idempotency.judge({ 'trader-before.json': tv, 'trader-after.json': tv, 'trader-restart.json': tv, 'desk-controls-before.json': ctl, 'desk-controls-repeat.json': ctl, 'desk-controls-restart.json': ctl }, ctx);
  assert.equal(same.result, 'PASS', same.words);
  const quiet = A.READERS.b0.quiet_authority.judge({ 'controls.json': ctl, 'tasks-final.json': { pilot: { state: 'Disabled' } }, 'authority.json': { render_cron: 'absent', scout_enabled: false } }, ctx);
  assert.equal(quiet.result, 'PASS', quiet.words);
  const doctor = await require('../core/doctor').doctor(w.ws);
  const meters = A.READERS.b0.meters.judge({ 'doctor.json': doctor, 'trader.json': tv }, ctx);
  assert.notEqual(meters.result, 'FAIL', meters.words);
  for (const name of ['Market data', 'Contract screening', 'Forensics']) assert.ok(doctor.checks.some((c) => c.name === name), `the doctor still has its ${name} line`);
});
test('the basis reader holds against the view\'s real names in the code', () => {
  const src = fs.readFileSync(path.join(ROOT, 'dashboard/core/decision-basis.js'), 'utf8');
  assert.match(src, /VIEW_VERSION = 'cr-decision-view@1'/);
  const view = fs.readFileSync(path.join(ROOT, 'dashboard/core/grade-outcome-view.js'), 'utf8');
  for (const name of ['not_recorded_at_execution', 'decided_by', 'inputs,']) assert.ok(view.includes(name), name);
  const pilot = fs.readFileSync(path.join(ROOT, 'dashboard/scripts/pilot.js'), 'utf8');
  assert.match(pilot, /format: 'cr-pilot-all@1'/);
  assert.match(pilot, /log\.revision = g\.rec/);
});
test('every step cites a heading that exists in its canonical document', () => {
  const blueprint = fs.readFileSync(path.join(ROOT, A.BLUEPRINT), 'utf8');
  for (const heading of ['### R0. Align the PC', '### B0. Prerequisites', '### B1. Pre-eligible-hour', '### B2. One natural mandate', '### B3. Restart', '### Ops-1 drill and cutover']) assert.ok(blueprint.includes(heading), heading);
  const ops = fs.readFileSync(path.join(ROOT, A.OPS1), 'utf8');
  for (const flag of FLAGS) assert.ok(ops.includes(`\`${flag}\``), flag);
});

// No git stub here: this is the path the closed #170's stubs hid. The evidence
// closes at a baseline; a receipt is merged after it; only then does PASS read.
test('real git: PASS is reachable once the receipt is merged, and not before it', async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-proof-git-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5 }));
  const env = { PATH: process.env.PATH || process.env.Path, SYSTEMROOT: process.env.SYSTEMROOT || process.env.SystemRoot || '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : os.devNull, GIT_AUTHOR_NAME: 'Proof', GIT_AUTHOR_EMAIL: 'proof@localhost', GIT_COMMITTER_NAME: 'Proof', GIT_COMMITTER_EMAIL: 'proof@localhost' };
  const git = (...args) => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env, windowsHide: true }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('init', '-q');
  for (const rel of [A.BLUEPRINT, A.READINESS, A.OPS1, A.R0_RECEIPT]) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), fs.readFileSync(path.join(ROOT, rel)));
  }
  fs.mkdirSync(path.join(repo, 'dashboard'));
  fs.writeFileSync(path.join(repo, 'dashboard/app.js'), 'code\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'baseline');
  const baseline = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-proof-git-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const hashes = ['r0', 'b0', 'b1'].map((s) => writeStep(root, s, { base: baseline }));
  const deployed = (rev) => async () => new Response(`ok\nrevision ${rev} (main)\n`, { status: 200 });
  const opts = (rev) => ({ step: 'b1', evidence: root, mode: 'post-merge', expectedRevision: rev });
  const deps = (rev) => ({ repoRoot: repo, now: () => iso(400), env: { PATH: env.PATH, SYSTEMROOT: env.SYSTEMROOT }, fetchImpl: deployed(rev) });
  const before = await A.verify(opts(baseline), deps(baseline));
  assert.equal(check(before, 'b1:anchor').result, 'UNVERIFIED');
  assert.equal(before.result, 'UNVERIFIED');
  // The receipt's merge redeploys the desk: expected and /healthz are the new merge.
  fs.writeFileSync(path.join(repo, 'docs/engineering/OPERATING_PROOF_B1.md'), `Bundles:\n${hashes.map((h) => `- \`${h}\``).join('\n')}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'receipt');
  const merge = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const after = await A.verify(opts(merge), deps(merge));
  assert.notEqual(merge, baseline);
  assert.equal(after.result, 'PASS', JSON.stringify(after.checks.filter((c) => c.result !== 'PASS'), null, 1));
  // Then application code moves: the proof asks for a repeat, and says so.
  fs.writeFileSync(path.join(repo, 'dashboard/app.js'), 'changed\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'code');
  const next = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const stale = await A.verify(opts(next), deps(next));
  assert.equal(check(stale, 'baseline_current').result, 'UNVERIFIED');
  assert.equal(stale.result, 'UNVERIFIED');
});

test('the report and its bundle carry the provenance the milestone asks for', async (t) => {
  const r = await prove('cutover', evidence(t));
  for (const field of ['verified_at', 'application_revision', 'sources', 'checks', 'checks_executed', 'checks_not_executed', 'missing_evidence', 'prerequisite_results', 'provenance', 'separate_results', 'reason']) assert.ok(r[field] !== undefined, field);
  for (const c of r.checks) for (const key of ['id', 'criterion', 'result', 'reason', 'sources', 'observation']) assert.ok(c[key] !== undefined, `${c.id}.${key}`);
  assert.ok(['PASS', 'FAIL', 'UNVERIFIED'].includes(r.result));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-proof-out-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true, maxRetries: 5 }));
  const bundle = A.writeBundle(r, out);
  const text = fs.readFileSync(bundle.report, 'utf8');
  for (const flag of FLAGS) assert.ok(text.includes(`${flag}: proven`), flag);
});
