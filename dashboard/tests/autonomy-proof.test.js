'use strict';
// prove-autonomy (cr-autonomy-proof@1, Stage 1.5 PR A1): false operational
// success must be hard to produce.
//
// These bundles are synthetic and built in temporary folders. Those that reach
// PASS carry no fiction marker and a stubbed merged receipt, on purpose, because
// the classifier refuses anything less;
// a PASS here exercises the classifier and proves no milestone. git and
// /healthz are stubbed: no network, no session, no real desk or evidence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const AP = require('../core/autonomy-proof');
const { tempWorkspace, hashTree } = require('./helpers');

const REPO = path.join(__dirname, '..', '..');
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const T0 = Date.parse('2026-11-10T00:00:00.000Z');
const iso = (h) => new Date(T0 + h * 3600000).toISOString();
const NOW = T0 + 400 * 3600000;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ---- A complete bundle per step: the shape of the desk's own views --------

const revisionFinal = { observed_at: iso(0), origin_main: SHA, runner_head: SHA, healthz_status: 200, deployed_sha: SHA };
const healthz = `ok\nrevision ${SHA} (main)\nstarted ${iso(0)}\n`;
const tasks = { observed_at: iso(0), pilot: { state: 'Disabled', instances: 0 }, hourly: { state: 'Ready', instances: 0 } };
const PID = 'proof-project';
const DEC = 'td_decision1';
const COID = 'cr2-intent1';
const INTENT = 'intent1';
const controls = (over = {}) => ({
  format: 'cr-desk-controls@1',
  at: iso(1),
  poll: { state: 'fresh', last_polled_at: iso(1), runner_id: 'pc-runner' },
  dispatch: { sessions: { day: '2026-11-10', used: 2, ceiling: 4, left: 2, unreadable: false }, projects_unreadable: null },
  authority: { paused: false, mandate: { on: true, generation: 3, expires_at: iso(200) }, admission: { on: false, enabled: false } },
  controls: { pause: { done: false }, mandate_off: { done: true }, admission_off: { done: true } },
  projects: [{ project_id: PID, dispatch: { state: 'released', reconcile: false, attempt_id: 'att1', claim_state: 'released', run_id: 'run1' }, reports: { claude: { report_id: 'rep1' } } }],
  ...over,
});
const order = (over = {}) => ({ client_order_id: COID, intent_id: INTENT, side: 'OPEN_LONG', decision_id: DEC, state: 'ACKED', filled: '0', quantity: '10', ...over });
const trader = (over = {}) => ({
  now: iso(1),
  orders: [order()],
  requests: [{ decision_id: DEC, receipt_id: 'tk1' }],
  results: { open_positions: [], closed_positions: [] },
  candles: { accounting_unknown: null, last_run_at: iso(1) },
  ...over,
});
const dryLine = (over = {}) => ({ format: 'cr-pilot-all@1', dry_run: true, desk: 'online', max_agents: 1, polled: [], exit: 0, error: null, revision: { runner: SHA, desk: SHA, source: 'git', clean: true }, ...over });
// Sent at 00:20: the first eligible hour is 01:00-02:00, usable at 02:10.
const sentAt = new Date(T0 + 20 * 60000).toISOString();
const lineage = (over = {}) => ({ project_id: PID, run_id: 'run1', report_id: 'rep1', receipt_id: 'tk1', generation: 3, decision_id: DEC, intent_id: INTENT, client_order_id: COID, sent_at: sentAt, control: 'mandate_off', control_applied_at: iso(1), healthchecks_start_and_final_seen: true, ...over });
const openPos = { position_id: 'pos-1', decision_id: DEC, stop_loss_price: '1.5' };

function completeFiles(step) {
  switch (step) {
    case 'r0': return {
      'revision-final.json': revisionFinal, 'healthz.txt': healthz, 'tasks-final.json': tasks,
      'verification.json': { runner: { detached: true, clean: true }, hourly_route: { stand_in_exit: 73, expected_exit: 73, records_root: 'D:\\Desk' } },
      'pilot-all.final-status.json': { config: { unattended: true, model_named: true, checkout_clean: true, checkout_head: SHA, launcher: 'job_wrapper', working_directory_is_repository: true }, status: { task: { state: 'Disabled' } } },
      'doctor-main-workspace.json': { checks: [{ name: 'Workspace folder', detail: 'D:\\Desk (kind: real, id: ws_1)' }] },
      'offsite-readback.json': { jobs: { offsite: { last_run_at: iso(2), last_status: 'ok' } } },
    };
    case 'b0': return {
      'revision-final.json': revisionFinal, 'healthz.txt': healthz, 'tasks-final.json': tasks, 'desk-controls.json': controls(), 'trader.json': trader({ orders: [] }),
      'dry-run.json': dryLine(), 'dry-run-negative.json': dryLine({ exit: 1, error: 'Revision guard: This checkout has uncommitted changes (git status --porcelain is not empty) at aaaaaaa.' }),
      'isolation.json': { format: 'cr-pilot-launch@1', ok: true },
      'doctor.json': { checks: [{ name: 'Market data', detail: 'Last success' }, { name: 'Contract screening', detail: '2 screened' }, { name: 'Forensics', detail: 'none yet' }] },
      'candidate.json': { project_id: PID, chain: 'ethereum', contract: '0xabc', coingecko_id: 'proof', model_id: 'claude-opus-5-5', vetoed: false, held: false, arm_desk_reviewed: true, contract_gate: 'enforce', max_grants_per_day: 1 },
      'B0.txt': 'readback\n',
    };
    case 'b1': return {
      'lineage.json': lineage(), 'run-log.json': dryLine({ dry_run: false }), 'desk-controls-after.json': controls({ at: iso(3) }),
      'trader-after-ack.json': trader({ now: iso(0.5) }),
      'trader-after-window.json': trader({ now: iso(3), orders: [order({ state: 'CANCELLED' })], candles: { accounting_unknown: null, last_run_at: iso(3) } }),
      'B1.txt': 'readback\n',
    };
    case 'b2': return {
      'lineage.json': lineage(),
      'attribution.json': { rows: [{ decision_id: DEC, decided_by: 'mandate', inputs: { label: 'decision_time' }, not_recorded_at_execution: ['engine'] }] },
      'basis.json': { format: 'cr-decision-view@1', label: 'decision_time', digest: 'verified', decision: { decision_id: DEC }, originals: [{ report_id: 'rep1', digest: 'verified' }], execution: { fills: [{ client_order_id: COID, hour: iso(1), fee_usd: '0.1' }] } },
      'trader.json': trader({ results: { open_positions: [openPos], closed_positions: [] } }),
      'B2.txt': 'readback\n',
    };
    case 'b3': return {
      'trader-before.json': trader(), 'trader-after.json': trader(), 'trader-restart.json': trader(),
      'desk-controls-before.json': controls(), 'desk-controls-repeat.json': controls(), 'desk-controls-restart.json': controls(),
      'B3.txt': 'readback\n',
    };
    case 'cutover': return {
      'pc-task.json': { observed_at: iso(10), pilot: { state: 'Disabled' } },
      'service.json': { name: 'cryptoresearch-runner', stayed_suspended_until_cutover: true, resumed_at: iso(11), first_run: { preflight_ok: true, revision_match: true, runner_id: 'render-ops1' } },
      'kill-drill.json': { pass: true, attempt_id: 'att9', saves_after_cancel: 0 },
      'desk-down.json': { ci_run_id: '12345' },
      'desk-controls-2h.json': controls({ at: iso(13), poll: { state: 'fresh', runner_id: 'render-ops1' } }),
      'desk-controls-6h.json': controls({ at: iso(17), poll: { state: 'fresh', runner_id: 'render-ops1' } }),
      'desk-controls-24h.json': controls({ at: iso(35), poll: { state: 'fresh', runner_id: 'render-ops1' } }),
      'healthchecks.json': { missed_periods: 0 },
      'lifecycle.json': { project_id: PID, report_id: 'rep2', receipt_id: 'tk2', runner_id: 'render-ops1', pc_task_disabled: true, receipt_intact: true, mandate_evaluation: 'evaluated_not_granted', fill: 'pending', closed_outcome: 'pending' },
      'cutover.txt': 'readback\n',
    };
    default: throw new Error(step);
  }
}
const closedAt = { r0: 3, b0: 4, b1: 5, b2: 6, b3: 7, cutover: 40 };

// Writes one bundle; `edit` may change files, `manifest` the manifest.
function writeBundle(root, step, { edit = {}, drop = [], manifest = {} } = {}) {
  const dir = path.join(root, AP.SPECS[step].folder);
  fs.mkdirSync(dir, { recursive: true });
  const files = { ...completeFiles(step), ...edit };
  for (const name of drop) delete files[name];
  const listed = [];
  for (const [name, value] of Object.entries(files)) {
    const buf = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    fs.writeFileSync(path.join(dir, name), buf);
    listed.push({ path: name, bytes: buf.length, sha256: sha256(buf) });
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ format: `cr-operating-proof-${step}-evidence@1`, closed_at: iso(closedAt[step]), baseline: SHA, provenance: 'live_run', files: listed, ...manifest }));
  return dir;
}
function fullProof(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-proof-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  for (const s of AP.STEPS) writeBundle(root, s, overrides[s]);
  return root;
}
// git as origin/main at SHA, clean, every baseline on main, a merged receipt naming every manifest.
function gitStub({ head = SHA, origin = SHA, dirty = '', ancestor = 0, anchored = true, calls = [] } = {}) {
  return (args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return { status: 0, stdout: `${args[1] === 'HEAD' ? head : origin}\n` };
    if (args[0] === 'status') return { status: 0, stdout: dirty };
    if (args[0] === 'symbolic-ref') return { status: 1, stdout: '' };
    if (args[0] === 'merge-base') return { status: ancestor, stdout: '' };
    if (args[0] === 'grep') return { status: anchored ? 0 : 1, stdout: '' };
    return { status: 128, stdout: '' };
  };
}
const healthzFetch = (commit = SHA, status = 200) => async () => ({ status, text: async () => `ok\nrevision ${commit} (main)\n` });
const run = (step, evidence, { opts = {}, git = gitStub(), fetchImpl = healthzFetch(), env = {}, home = os.tmpdir() } = {}) => AP.prove(step, { evidence, noWrite: true, desk: 'online', ...opts }, { env, git, fetchImpl, now: () => NOW, home });
const statusOf = (r, id) => {
  const c = r.checks_executed.find((x) => x.id === id) || r.checks_not_executed.find((x) => x.id === id);
  return c && c.status;
};

// ---- The classifier's positive path, and what removing anything does -------

test('a complete, consistent bundle reads PASS for every step (synthetic: the classifier only)', async (t) => {
  const root = fullProof(t);
  for (const s of AP.STEPS) {
    const r = await run(s, root);
    assert.equal(r.result, AP.PASS, `${s}: ${r.reason}`);
    assert.deepEqual(r.missing_evidence, []);
    assert.equal(r.audited_revision, SHA);
    assert.equal(r.verifier.mode, 'post_merge');
  }
});

test('removing any one required record from any step keeps that step from PASS', async (t) => {
  for (const step of AP.STEPS) {
    for (const name of Object.keys(completeFiles(step))) {
      const root = fullProof(t, { [step]: { drop: [name] } });
      const r = await run(step, root);
      assert.equal(r.result, AP.UNVERIFIED, `${step} without ${name}`);
      assert.ok(r.missing_evidence.some((m) => m.file.endsWith(name)), `${step} names ${name} as missing`);
    }
  }
});

test('every report carries the required provenance fields', async (t) => {
  const r = await run('r0', fullProof(t));
  for (const k of ['step', 'result', 'canon', 'audited_revision', 'sources', 'timestamps', 'checks_executed', 'checks_not_executed', 'missing_evidence', 'reason', 'evidence']) assert.ok(k in r, k);
  assert.ok(r.canon.criterion && r.canon.doc);
  assert.match(r.timestamps.verified_at, /Z$/);
  assert.ok(r.sources.length && r.sources.every((s) => /^[0-9a-f]{64}$/.test(s.sha256)));
  assert.ok(r.checks_executed.every((c) => c.observed_from));
  assert.deepEqual([...new Set(r.checks_executed.map((c) => c.status))].sort(), [AP.PASS]);
});

test('each step cites a heading that exists in its canonical document', () => {
  for (const s of AP.STEPS) {
    const { doc, section } = AP.SPECS[s].canon;
    assert.ok(fs.readFileSync(path.join(REPO, doc), 'utf8').includes(section), `${s}: ${section}`);
  }
});

// ---- Mandatory negative controls ------------------------------------------

test('1: missing B0 evidence is UNVERIFIED, never PASS', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-proof-empty-'));
  try {
    const r = await run('b0', empty);
    assert.equal(r.result, AP.UNVERIFIED);
    assert.ok(r.missing_evidence.length >= 1);
    assert.equal(r.evidence.bundle, null);
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});

test('2: contradictory evidence is FAIL, and names what contradicts', async (t) => {
  const cases = [
    ['r0', { 'revision-final.json': { ...revisionFinal, runner_head: OTHER } }, /runner's HEAD/],
    ['r0', { 'tasks-final.json': { ...tasks, pilot: { state: 'Ready', instances: 0 } } }, /pilot-all is Ready/],
    ['b0', { 'desk-controls.json': controls({ authority: { paused: false, mandate: { generation: 3, expires_at: iso(200) }, admission: { on: true } } }) }, /admission/],
    ['b0', { 'desk-controls.json': controls({ projects: [{ project_id: PID, dispatch: { state: 'reconcile', reconcile: true }, reports: {} }] }) }, /reconcile is open/],
    ['b1', { 'trader-after-window.json': trader({ now: iso(3), orders: [order({ state: 'FILLED', filled: '10' })], candles: { last_run_at: iso(3) } }) }, /FILLED|filled 10/],
    ['b1', { 'lineage.json': lineage({ control_applied_at: iso(2.5) }) }, /after the hour was usable/],
    ['b2', { 'basis.json': { ...completeFiles('b2')['basis.json'], execution: { fills: [{ client_order_id: COID, hour: iso(-1), fee_usd: '0.1' }] } } }, /not causal/],
    ['b2', { 'attribution.json': { rows: [{ decision_id: DEC, decided_by: 'mandate', inputs: { label: 'reconstructed' }, not_recorded_at_execution: ['engine'] }] } }, /inputs\.label is reconstructed/],
    ['b3', { 'trader-after.json': trader({ orders: [order(), order({ client_order_id: 'cr2-dup' })] }) }, /side effect/],
    ['b3', { 'desk-controls-repeat.json': controls({ dispatch: { sessions: { day: '2026-11-10', used: 3 } } }) }, /sessions_today went from 2 to 3/],
    ['cutover', { 'pc-task.json': { observed_at: iso(12), pilot: { state: 'Disabled' } } }, /not read Disabled before/],
    ['cutover', { 'kill-drill.json': { pass: false, saves_after_cancel: 1 } }, /saves after the cancel/],
  ];
  for (const [step, edit, re] of cases) {
    const r = await run(step, fullProof(t, { [step]: { edit } }));
    assert.equal(r.result, AP.FAIL, `${step}: ${r.reason}`);
    assert.match(r.reason, re);
  }
});

test('2b: no fill is "fill pending" and UNVERIFIED, never a pass and never a failure', async (t) => {
  const basis = { ...completeFiles('b2')['basis.json'], execution: { fills: [] } };
  const r = await run('b2', fullProof(t, { b2: { edit: { 'basis.json': basis } } }));
  assert.equal(r.result, AP.UNVERIFIED);
  assert.equal(statusOf(r, 'causal_fill_with_fees'), AP.UNVERIFIED);
  assert.match(r.checks_executed.find((c) => c.id === 'causal_fill_with_fees').words, /Fill pending/);
});

test('3: a synthetic fixture is never read as a live operating record', async (t) => {
  const declared = await run('r0', fullProof(t, { r0: { manifest: { provenance: 'fixture' } } }));
  assert.equal(declared.result, AP.UNVERIFIED);
  assert.equal(declared.evidence.provenance, 'fixture');
  assert.ok(declared.checks_executed.filter((c) => c.files.length).every((c) => c.observed_from === 'fixture' || c.observed_from === 'offline_record'));

  const undeclared = await run('r0', fullProof(t, { r0: { manifest: { provenance: undefined } } }), { git: gitStub({ anchored: false }) });
  assert.equal(undeclared.result, AP.UNVERIFIED);
  assert.equal(undeclared.evidence.provenance, 'undeclared');

  const mislabeled = await run('r0', fullProof(t, { r0: { edit: { 'tasks-final.json': { ...tasks, note: 'FICTIONAL' } } } }));
  assert.equal(mislabeled.result, AP.FAIL, 'labeled live, but marked fictional');
  assert.equal(mislabeled.evidence.provenance, 'fixture');

  const fictionalDesk = await run('r0', fullProof(t, { r0: { edit: { 'doctor-main-workspace.json': { checks: [{ name: 'Workspace folder', detail: 'D:\\Desk (kind: test, id: ws_1)' }] } } } }));
  assert.notEqual(fictionalDesk.result, AP.PASS, 'a test workspace is not the desk');

  const inCode = await AP.prove('r0', { evidence: path.join(os.tmpdir(), 'cr-absent'), noWrite: true }, { env: {}, git: gitStub(), now: () => NOW, home: os.tmpdir(), codeRoot: os.tmpdir() });
  assert.notEqual(inCode.result, AP.PASS);
  const root = fullProof(t);
  const inside = await AP.prove('r0', { evidence: root, noWrite: true, desk: 'online' }, { env: {}, git: gitStub(), fetchImpl: healthzFetch(), now: () => NOW, home: os.tmpdir(), codeRoot: path.dirname(root) });
  assert.equal(inside.result, AP.UNVERIFIED, 'evidence inside the code is not operating evidence');
});

test('3b: a receipt merged on origin/main anchors a bundle that declares nothing; a fixture stays one', async (t) => {
  const typed = await run('r0', fullProof(t), { git: gitStub({ anchored: false }) });
  assert.equal(typed.result, AP.UNVERIFIED, 'typing live_run proves nothing');
  assert.equal(typed.evidence.provenance, 'declared_live');
  assert.ok(typed.checks_executed.filter((c) => c.files.length).every((c) => c.observed_from !== 'live_run'));
  assert.match(typed.checks_executed.find((c) => c.id === 'provenance').words, /only a declaration/);
  const anchored = await run('r0', fullProof(t, { r0: { manifest: { provenance: undefined } } }), { git: gitStub({ anchored: true }) });
  assert.equal(anchored.result, AP.PASS);
  assert.equal(anchored.evidence.anchored_by_merged_receipt, true);
  const fixture = await run('r0', fullProof(t, { r0: { manifest: { provenance: 'fixture' } } }), { git: gitStub({ anchored: true }) });
  assert.equal(fixture.result, AP.UNVERIFIED);
});

test('4: a feature-branch HEAD differing from origin/main is development mode, never a production failure', async (t) => {
  const root = fullProof(t);
  const r = await run('r0', root, { git: gitStub({ head: OTHER }) });
  assert.equal(r.result, AP.UNVERIFIED);
  assert.equal(r.verifier.mode, 'development');
  assert.equal(statusOf(r, 'verifier_revision'), AP.UNVERIFIED);
  assert.ok(!r.checks_executed.some((c) => c.status === AP.FAIL));
  assert.match(r.checks_executed.find((c) => c.id === 'verifier_revision').words, /no production failure/);
  const dirty = await run('r0', root, { git: gitStub({ dirty: ' M dashboard/cli.js\n' }) });
  assert.equal(dirty.verifier.mode, 'development');
  assert.equal(dirty.result, AP.UNVERIFIED);
});

test('5: a deployed revision mismatch is reported as it is', async (t) => {
  const root = fullProof(t);
  const drift = await run('r0', root, { fetchImpl: healthzFetch(OTHER), git: gitStub() });
  assert.equal(drift.result, AP.UNVERIFIED, 'the record stands; it does not prove what runs now');
  assert.equal(drift.deployed.commit, OTHER);
  assert.equal(drift.deployed.differs_from_origin_main, true);
  assert.match(drift.deployed.words, /Merged is not deployed/);
  assert.match(drift.checks_executed.find((c) => c.id === 'deployed_revision_now').words, /desk now runs bbbbbbb/);

  const expected = await run('r0', root, { fetchImpl: healthzFetch(OTHER), opts: { expect: SHA } });
  assert.equal(expected.result, AP.FAIL, 'an explicit expectation is contradicted');

  const down = await run('r0', root, { fetchImpl: async () => { throw new Error('unreachable'); } });
  assert.equal(down.result, AP.UNVERIFIED);
  assert.equal(down.deployed.commit, null);
  assert.match(down.deployed.words, /says nothing of how the desk is configured/);

  const unread = await run('r0', root, { opts: { desk: undefined } });
  assert.equal(unread.result, AP.UNVERIFIED, 'no live read, no claim about now');
  assert.equal(unread.deployed.read, false);
});

test('6: missing or inaccessible scheduled-task information stays UNVERIFIED', async (t) => {
  const gone = await run('r0', fullProof(t, { r0: { drop: ['tasks-final.json'] } }));
  assert.equal(gone.result, AP.UNVERIFIED);
  assert.equal(statusOf(gone, 'pilot_all_disabled'), AP.UNVERIFIED);

  const noState = await run('r0', fullProof(t, { r0: { edit: { 'tasks-final.json': { observed_at: iso(0), pilot: {} } } } }));
  assert.equal(statusOf(noState, 'pilot_all_disabled'), AP.UNVERIFIED);
  assert.notEqual(noState.result, AP.PASS);

  const noPilot = await run('r0', fullProof(t, { r0: { edit: { 'tasks-final.json': { observed_at: iso(0) } } } }));
  assert.equal(statusOf(noPilot, 'pilot_all_disabled'), AP.UNVERIFIED);

  // A folder where the record should be: bound by the manifest, unreadable.
  const root = fullProof(t);
  const dir = path.join(root, 'R0');
  fs.rmSync(path.join(dir, 'tasks-final.json'));
  fs.mkdirSync(path.join(dir, 'tasks-final.json'));
  const unreadable = await run('r0', root);
  assert.equal(unreadable.result, AP.UNVERIFIED);
  assert.ok(unreadable.missing_evidence.some((m) => m.state === 'unreadable'));
});

test('7: output cannot escape its directory or land in the code or the records', async (t) => {
  const root = fullProof(t);
  const w = tempWorkspace('proof-out');
  t.after(w.cleanup);
  const deps = { env: {}, git: gitStub(), now: () => NOW, home: os.tmpdir() };
  const code = (p) => p.catch((e) => e.code);
  assert.equal(await code(AP.prove('r0', { evidence: root, out: path.join(REPO, 'proof-out') }, deps)), 'UNSAFE_PATH', 'inside the code');
  assert.equal(await code(AP.prove('r0', { evidence: root, out: path.join(w.root, 'logs', 'proof') }, deps)), 'UNSAFE_PATH', 'inside a workspace nobody named');
  const named = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-proof-named-'));
  t.after(() => fs.rmSync(named, { recursive: true, force: true }));
  assert.equal(await code(AP.prove('r0', { evidence: root, out: path.join(named, 'x'), forbiddenRoots: [named] }, deps)), 'UNSAFE_PATH', 'inside the named workspace');
  assert.ok(!fs.existsSync(path.join(named, 'x')), 'a refusal writes nothing');

  // A link (a junction needs no privilege on Windows) to the records.
  const linkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-proof-link-'));
  t.after(() => fs.rmSync(linkHome, { recursive: true, force: true }));
  const link = path.join(linkHome, 'to-records');
  fs.symlinkSync(w.root, link, 'junction');
  const beforeLink = hashTree(w.root);
  assert.equal(await code(AP.prove('r0', { evidence: root, out: link }, deps)), 'UNSAFE_PATH', 'a link into the records');
  assert.equal(await code(AP.prove('r0', { evidence: root, out: path.join(link, 'sub') }, deps)), 'UNSAFE_PATH', 'through a link');
  assert.deepEqual(hashTree(w.root), beforeLink);

  // A link elsewhere is refused too.
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-proof-else-'));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  const out = path.join(linkHome, 'out');
  fs.symlinkSync(elsewhere, out, 'junction');
  assert.equal(await code(AP.prove('r0', { evidence: root, out }, deps)), 'UNSAFE_PATH');
  assert.equal(await code(AP.prove('r0', { evidence: root, out: path.join(out, 'sub', 'deep') }, deps)), 'UNSAFE_PATH', 'a link higher up the path');
  assert.deepEqual(fs.readdirSync(elsewhere), []);

  // The step and the project never become a path.
  assert.equal(await code(AP.prove('../../x', { evidence: root, noWrite: true }, deps)), 'USAGE');
  assert.equal(await code(AP.prove('r0', { evidence: root, noWrite: true, project: '../../x' }, deps)), 'USAGE');
});

test('7b: a manifest cannot read outside its bundle, and a linked bundle is refused', async (t) => {
  const root = fullProof(t);
  const dir = path.join(root, 'R0');
  const secret = path.join(root, 'outside.json');
  fs.writeFileSync(secret, '{"pilot":{"state":"Disabled","instances":0}}');
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  m.files.push({ path: '../outside.json', bytes: 44, sha256: sha256(fs.readFileSync(secret)) });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  const r = await run('r0', root);
  assert.equal(r.result, AP.FAIL);
  assert.match(r.reason, /outside its bundle/);

  const other = fullProof(t);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-proof-lb-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  fs.symlinkSync(path.join(other, 'R0'), path.join(parent, 'R0'), 'junction');
  const linked = await run('r0', parent);
  assert.equal(linked.result, AP.FAIL);
  assert.match(linked.reason, /link/);
});

test('8: existing evidence is never silently overwritten', async (t) => {
  const root = fullProof(t);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-proof-w-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const deps = { env: {}, git: gitStub(), fetchImpl: healthzFetch(), now: () => NOW, home: path.join(os.tmpdir(), 'cr-proof-no-home'), runId: 'fixed-run' };
  const first = await AP.prove('r0', { evidence: root, out, desk: 'online' }, deps);
  assert.equal(path.basename(first.out_dir), 'fixed-run');
  const before = hashTree(out);
  await assert.rejects(AP.prove('r0', { evidence: root, out, desk: 'online' }, deps), (e) => e.code === 'UNSAFE_PATH' && /never overwritten/.test(e.message));
  assert.deepEqual(hashTree(out), before);
  // Two real runs never collide, and the owner's own readback is untouched.
  const { runId: _, ...fresh } = deps;
  const a = await AP.prove('r0', { evidence: root, out, desk: 'online' }, fresh);
  const b = await AP.prove('r0', { evidence: root, out, desk: 'online' }, fresh);
  assert.notEqual(a.out_dir, b.out_dir);
  assert.deepEqual(fs.readdirSync(a.out_dir).sort(), ['R0.json', 'R0.txt']);
  assert.equal(sha256(fs.readFileSync(path.join(a.out_dir, 'R0.txt'))), a.report_files.find((f) => f.name === 'R0.txt').sha256);
});

test('9: secret values never reach a report, and evidence carrying one fails', async (t) => {
  const TOKEN = 'FICTIONAL-marker-token-7a1b2c3d4e5f';
  const GHO = `gho_${'x'.repeat(36)}`;
  const env = { GH_TOKEN: TOKEN, CR_PILOT_POLL_TOKEN: 'marker-poll-value-99887766', PATH: 'ignored-path-value' };
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-proof-sec-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  // The secret sits in a field a sentence quotes.
  const root = fullProof(t, { r0: { edit: { 'tasks-final.json': { ...tasks, pilot: { state: GHO, instances: 0 } }, 'verification.json': { runner: { detached: env.CR_PILOT_POLL_TOKEN, clean: true }, hourly_route: { stand_in_exit: 73, expected_exit: 73, records_root: 'D:\\Desk' } } } } });
  const r = await AP.prove('r0', { evidence: root, out, desk: 'online' }, { env, git: gitStub(), fetchImpl: healthzFetch(), now: () => NOW, home: path.join(os.tmpdir(), 'cr-proof-no-home') });
  assert.equal(r.result, AP.FAIL);
  assert.equal(statusOf(r, 'no_secret_values'), AP.FAIL);
  const printed = JSON.stringify(r) + Object.values(hashTreeText(r.out_dir)).join('\n');
  for (const v of [TOKEN, GHO, env.CR_PILOT_POLL_TOKEN]) assert.ok(!printed.includes(v), 'a secret leaked');
  assert.ok(!printed.includes('ignored-path-value'), 'the environment is not echoed');
});
function hashTreeText(dir) {
  return Object.fromEntries(fs.readdirSync(dir).map((n) => [n, fs.readFileSync(path.join(dir, n), 'utf8')]));
}

test('9b: the git child gets an allowlisted environment, with no marker credential', () => {
  const marker = 'marker-credential-1234567890';
  const child = AP.gitChildEnv({ PATH: 'p', USERPROFILE: 'u', GH_TOKEN: marker, GITHUB_TOKEN: marker, CR_PILOT_WORKER_TOKEN: marker, RENDER_API_KEY: marker, GIT_ASKPASS: marker, GCM_INTERACTIVE: marker });
  assert.ok(!JSON.stringify(child).includes(marker));
  assert.deepEqual(child, { PATH: 'p', USERPROFILE: 'u', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
  const r = spawnSync(process.execPath, [path.join(REPO, 'dashboard', 'cli.js'), 'prove-autonomy', 'r0', '--no-write', '--evidence', os.tmpdir(), '--json'], { encoding: 'utf8', env: { ...process.env, GH_TOKEN: marker, GITHUB_TOKEN: marker, CR_PILOT_WORKER_TOKEN: marker } });
  assert.equal(r.status, 2, r.stderr);
  assert.ok(!r.stdout.includes(marker));
});

test('10: running the command leaves the desk\'s bytes unchanged and opens no workspace', async (t) => {
  const w = tempWorkspace('proof-bytes');
  t.after(w.cleanup);
  const root = fullProof(t);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-proof-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const before = hashTree(w.root);
  const mtimes = fs.statSync(path.join(w.root, 'workspace.json')).mtimeMs;
  for (const step of ['r0', 'cutover', 'all']) {
    const r = spawnSync(process.execPath, [path.join(REPO, 'dashboard', 'cli.js'), 'prove-autonomy', step, '--workspace', w.root, '--evidence', root, '--json'], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, CR_WORKSPACE: w.root } });
    assert.ok([0, 1, 2].includes(r.status), r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.format, AP.FORMAT);
    assert.equal(out.step, step);
    assert.equal(r.status, AP.EXIT[out.result]);
  }
  assert.deepEqual(hashTree(w.root), before);
  assert.equal(fs.statSync(path.join(w.root, 'workspace.json')).mtimeMs, mtimes);
  // The module holds no route to the desk's writers.
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'autonomy-proof.js'), 'utf8');
  for (const m of ['./workspace', './ops', './trader-desk', './paper', './paper-trader', './tickets', './jobs']) assert.ok(!src.includes(`require('${m}')`), m);
  assert.ok(!src.includes('fetch origin'), 'never fetches');
});

test('11: a missing or malformed record cannot be reconstructed into success', async (t) => {
  const malformed = await run('r0', fullProof(t, { r0: { edit: { 'tasks-final.json': '{"pilot":{"state":"Disabled"' } } }));
  assert.equal(malformed.result, AP.UNVERIFIED);
  assert.ok(malformed.missing_evidence.some((m) => m.state === 'malformed'));
  assert.equal(statusOf(malformed, 'pilot_all_disabled'), AP.UNVERIFIED);

  // Changed after the bundle closed: never parsed.
  const root = fullProof(t);
  fs.writeFileSync(path.join(root, 'R0', 'tasks-final.json'), JSON.stringify({ ...tasks, tampered: true }));
  const tampered = await run('r0', root);
  assert.equal(tampered.result, AP.FAIL);
  assert.match(tampered.reason, /changed after the bundle closed/);
  // The same length, so only the hash can catch it: Ready written over Disabled would not fit.
  const rootS = fullProof(t, { r0: { edit: { 'tasks-final.json': { ...tasks, pilot: { state: 'Disabled', instances: 0 } } } } });
  const tasksFile = path.join(rootS, 'R0', 'tasks-final.json');
  const held = fs.readFileSync(tasksFile, 'utf8');
  const forged = held.replace('"instances":0', '"instances":1');
  assert.equal(forged.length, held.length);
  fs.writeFileSync(tasksFile, forged);
  const sameLength = await run('r0', rootS);
  assert.equal(sameLength.result, AP.FAIL);
  assert.match(sameLength.reason, /changed after the bundle closed/);

  // A file present but not bound by the manifest supports nothing.
  const rootU = fullProof(t);
  const m = JSON.parse(fs.readFileSync(path.join(rootU, 'R0', 'manifest.json'), 'utf8'));
  m.files = m.files.filter((f) => f.path !== 'tasks-final.json');
  fs.writeFileSync(path.join(rootU, 'R0', 'manifest.json'), JSON.stringify(m));
  assert.equal((await run('r0', rootU)).result, AP.UNVERIFIED);

  // An empty manifest; a broken manifest; another step's manifest; a future close; no baseline.
  const rootE = fullProof(t);
  fs.writeFileSync(path.join(rootE, 'R0', 'manifest.json'), JSON.stringify({ format: 'cr-operating-proof-r0-evidence@1', closed_at: iso(1), baseline: SHA, provenance: 'live_run', files: [] }));
  assert.equal((await run('r0', rootE)).result, AP.UNVERIFIED);
  const rootB = fullProof(t);
  fs.writeFileSync(path.join(rootB, 'R0', 'manifest.json'), '{not json');
  assert.equal((await run('r0', rootB)).result, AP.UNVERIFIED);
  assert.equal((await run('r0', fullProof(t, { r0: { manifest: { format: 'cr-operating-proof-b0-evidence@1' } } }))).result, AP.UNVERIFIED);
  assert.equal((await run('r0', fullProof(t, { r0: { manifest: { closed_at: iso(99999) } } }))).result, AP.UNVERIFIED);
  for (const baseline of ['nope', undefined]) {
    const none = await run('r0', fullProof(t, { r0: { manifest: { baseline } } }));
    assert.equal(none.result, AP.UNVERIFIED, `baseline ${baseline}`);
    assert.equal(none.audited_revision, null);
  }
  // A baseline main does not contain.
  assert.equal((await run('r0', fullProof(t), { git: gitStub({ ancestor: 1 }) })).result, AP.UNVERIFIED);
  // A record of the wrong shape is unverified, and its check does not throw.
  assert.equal(statusOf(await run('b2', fullProof(t, { b2: { edit: { 'attribution.json': { rows: 'x' } } } })), 'attribution_row_is_decision_time'), AP.UNVERIFIED);
});

test('12: one step that does not PASS keeps the aggregate from PASS', async (t) => {
  assert.equal((await run('all', fullProof(t))).result, AP.PASS);
  const failed = await run('all', fullProof(t, { b1: { edit: { 'lineage.json': lineage({ control: 'mandate_off', control_applied_at: iso(9) }) } } }));
  assert.equal(failed.result, AP.FAIL);
  assert.equal(failed.steps.find((s) => s.step === 'b1').result, AP.FAIL);
  const unverified = await run('all', fullProof(t, { b3: { drop: ['B3.txt'] } }));
  assert.equal(unverified.result, AP.UNVERIFIED);
  assert.equal(unverified.steps.find((s) => s.step === 'r0').result, AP.PASS);
  assert.ok(!['PASS'].includes(unverified.steps.find((s) => s.step === 'cutover').result));
});

test('12b: a step is not proven past an earlier step that is not, and out-of-order records fail', async (t) => {
  const r = await run('b1', fullProof(t, { b0: { drop: ['isolation.json'] } }));
  assert.equal(r.result, AP.UNVERIFIED);
  assert.equal(statusOf(r, 'earlier_step'), AP.UNVERIFIED);
  const early = await run('b1', fullProof(t, { b1: { manifest: { closed_at: iso(1) } } }));
  assert.equal(early.result, AP.FAIL);
  assert.match(early.reason, /out of the runbook's order/);
});

// ---- The rest of what the runbook asks ------------------------------------

test('a poll read too early, or a capture before the hour is usable, is UNVERIFIED', async (t) => {
  const tooSoon = await run('b1', fullProof(t, { b1: { edit: { 'trader-after-window.json': trader({ now: iso(1.5), orders: [order({ state: 'CANCELLED' })], candles: { last_run_at: iso(3) } }) } } }));
  assert.equal(statusOf(tooSoon, 'control_before_first_eligible_hour'), AP.UNVERIFIED);
  const lazy = await run('cutover', fullProof(t, { cutover: { edit: { 'desk-controls-2h.json': controls({ at: iso(11.2), poll: { state: 'fresh', runner_id: 'render-ops1' } }) } } }));
  assert.equal(statusOf(lazy, 'runner_alive'), AP.UNVERIFIED);
  const stale = await run('cutover', fullProof(t, { cutover: { edit: { 'desk-controls-6h.json': controls({ at: iso(17), poll: { state: 'stale', runner_id: 'render-ops1' } }) } } }));
  assert.equal(statusOf(stale, 'runner_alive'), AP.FAIL);
});

test('usableAt follows the runbook\'s example: a send at 14:20 is usable at 16:10', () => {
  assert.equal(new Date(AP.usableAt('2026-11-10T14:20:00.000Z')).toISOString(), '2026-11-10T16:10:00.000Z');
  assert.equal(new Date(AP.usableAt('2026-11-10T15:00:00.000Z')).toISOString(), '2026-11-10T16:10:00.000Z', 'an hour starting at the send is eligible');
  assert.ok(Number.isNaN(AP.usableAt(null)));
});

test('cutover keeps five results apart: a pending fill fails nothing and proves nothing', async (t) => {
  const r = await run('cutover', fullProof(t));
  assert.equal(r.result, AP.PASS);
  assert.deepEqual(r.separate_results, { host_installed: 'proven', runner_alive: 'proven', lifecycle_proven: 'proven', fill_proven: 'pending', closed_outcome_proven: 'pending' });
  assert.ok(r.reason.includes('Eric\'s own record'), 'a PASS says what rests on his record');
  const noLife = await run('cutover', fullProof(t, { cutover: { drop: ['lifecycle.json'] } }));
  assert.equal(noLife.result, AP.UNVERIFIED);
  assert.equal(noLife.separate_results.host_installed, 'proven');
  assert.equal(noLife.separate_results.lifecycle_proven, 'pending');
  const bad = await run('cutover', fullProof(t, { cutover: { edit: { 'lifecycle.json': { ...completeFiles('cutover')['lifecycle.json'], fill: 'failed' } } } }));
  assert.equal(bad.result, AP.FAIL);
});

test('b3 reports its five outcomes apart', async (t) => {
  const r = await run('b3', fullProof(t));
  assert.deepEqual(r.separate_results, { cancellation: 'proven', live_fill: 'proven', risk_reduction: 'pending', closure: 'pending', restart: 'proven' });
  const pending = await run('b3', fullProof(t, { b2: { edit: { 'basis.json': { ...completeFiles('b2')['basis.json'], execution: { fills: [] } } } } }));
  assert.equal(pending.separate_results.live_fill, 'pending');
  assert.equal(pending.result, AP.UNVERIFIED);
});

test('--project scopes a lineage: another project\'s records prove nothing for it', async (t) => {
  const r = await run('b2', fullProof(t), { opts: { project: 'another-project' } });
  assert.equal(r.result, AP.UNVERIFIED);
  assert.equal(statusOf(r, 'lineage_on_record'), AP.UNVERIFIED);
  assert.equal((await run('b2', fullProof(t), { opts: { project: PID } })).result, AP.PASS);
});

test('the default bundle is the newest dated folder holding the step, and is named', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-proof-def-'));
  try {
    const base = path.join(home, 'Documents', 'CryptoResearch-evidence');
    writeBundle(path.join(base, 'operating-proof-2026-11-03'), 'r0');
    fs.mkdirSync(path.join(base, 'operating-proof-2026-11-04'), { recursive: true });
    fs.mkdirSync(path.join(base, 'unrelated-audit', 'R0'), { recursive: true });
    const r = await AP.prove('r0', { noWrite: true, desk: 'online' }, { env: {}, git: gitStub(), fetchImpl: healthzFetch(), now: () => NOW, home });
    assert.equal(r.result, AP.PASS);
    assert.match(r.evidence.bundle, /operating-proof-2026-11-03/);
    assert.match(r.evidence.bundle, /^~/, 'the home folder is not spelled out');
    assert.equal(r.evidence.searched.length, 2);
    // An empty newer R0 wins: the older record is not quietly substituted.
    fs.mkdirSync(path.join(base, 'operating-proof-2026-11-04', 'R0'));
    const newer = await AP.prove('r0', { noWrite: true, desk: 'online' }, { env: {}, git: gitStub(), fetchImpl: healthzFetch(), now: () => NOW, home });
    assert.equal(newer.result, AP.UNVERIFIED);
    // With no --out, reports land under the dated evidence folder, by UTC date.
    const wrote = await AP.prove('r0', { desk: 'online' }, { env: {}, git: gitStub(), fetchImpl: healthzFetch(), now: () => NOW, home });
    assert.match(wrote.out_dir, /operating-proof-2026-11-26[\\/]prove-autonomy[\\/]/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('the verifier reads a record in the desk\'s real view shape (fictional workspace)', async (t) => {
  const w = tempWorkspace('proof-shape');
  t.after(w.cleanup);
  const view = require('../core/desk-controls').view(w.ws);
  const j = AP.SPECS.b0.checks.find((c) => c.id === 'no_open_reconcile').judge;
  const tv = { ...require('../core/trader-desk').view(w.ws), candles: require('../core/trader-candles').statusView(w.ws) };
  assert.equal(j({ 'desk-controls.json': view, 'trader.json': tv }, {}).status, AP.PASS);
  const admission = AP.SPECS.b0.checks.find((c) => c.id === 'admission_off_and_authority_read_back').judge({ 'desk-controls.json': view }, {});
  assert.equal(admission.status, AP.UNVERIFIED, 'no armed mandate here: its generation is not on record');
  assert.match(admission.words, /mandate generation/);
  const meters = AP.SPECS.b0.checks.find((c) => c.id === 'meters_valid');
  const doctor = await require('../core/doctor').doctor(w.ws);
  assert.notEqual(meters.judge({ 'doctor.json': doctor, 'trader.json': tv }, {}).status, undefined);
  for (const name of ['Market data', 'Contract screening', 'Forensics']) assert.ok(doctor.checks.some((c) => c.name === name), `the doctor still has its ${name} line`);
});

test('CLI: bad arguments are usage errors, never a verdict', () => {
  const cli = (...a) => spawnSync(process.execPath, [path.join(REPO, 'dashboard', 'cli.js'), 'prove-autonomy', ...a], { encoding: 'utf8' });
  for (const args of [['nope'], [], ['r0', '--desk=render'], ['r0', '--out'], ['r0', '--project', 'Bad/ID'], ['r0', '--expect-revision=abc']]) {
    const r = cli(...args, '--no-write');
    assert.equal(r.status, 64, `${args.join(' ')}: ${r.stderr}`);
  }
  assert.match(spawnSync(process.execPath, [path.join(REPO, 'dashboard', 'cli.js'), 'help'], { encoding: 'utf8' }).stdout, /prove-autonomy <r0\|b0\|b1\|b2\|b3\|cutover\|all>/);
});
