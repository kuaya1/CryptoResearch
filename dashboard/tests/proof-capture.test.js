'use strict';
// The owner's paperwork for an operating proof. Every record here is invented,
// in temporary folders, so a PASS below proves the paperwork and never a step.
// No task, provider, live desk or real evidence folder is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const A = require('../core/autonomy-proof');
const C = require('../core/proof-capture');

const ROOT = path.resolve(__dirname, '../..');
const SHA = 'a'.repeat(40);
const OTHER = 'c'.repeat(40);
const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const iso = (h) => new Date(T0 + h * 3600000).toISOString();
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const PID = 'proof-project';
const clone = (v) => JSON.parse(JSON.stringify(v));

function evidenceRoot(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-proof-capture-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 }));
  return path.join(base, 'evidence');
}
const deps = (over = {}) => ({ env: {}, now: () => iso(3), ...over });
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'no refusal'; };
const message = (fn) => { try { fn(); } catch (e) { return e.message; } return ''; };

// ---- Invented records in the shape the verifier reads --------------------
const revision = { observed_at: iso(0), origin_main: SHA, runner_head: SHA, healthz_status: 200, deployed_sha: SHA };
const healthz = `ok\nrevision ${SHA} (main)\nstarted ${iso(0)}\n`;
const tasks = { observed_at: iso(0), pilot: { state: 'Disabled', enabled: false, instances: 0 }, hourly: { state: 'Disabled', enabled: false, instances: 0 } };
const R0 = {
  'revision-final.json': revision,
  'healthz.txt': healthz,
  'tasks-final.json': tasks,
  'verification.json': { runner: { detached: true, clean: true }, hourly_route: { stand_in_exit: 73, expected_exit: 73, records_root: 'D:\\Desk' } },
  'pilot-all.final-status.json': { registered: true, ours: true, status: { task: { state: 'Disabled' } }, config: { launcher: 'job_wrapper', max_agents: 1, unattended: true, model_named: true, checkout_clean: true, checkout_head: SHA, working_directory_is_repository: true } },
  'doctor-main-workspace.json': { verified_write: true, checks: [{ name: 'Workspace folder', status: 'ok', detail: 'D:\\Desk (kind: real, id: ws_1)' }] },
  'offsite-readback.json': { jobs: { offsite: { last_run_at: iso(2), last_status: 'ok' } } },
};
const controls = {
  format: 'cr-desk-controls@1', at: iso(1), poll: { state: 'fresh', last_polled_at: iso(1), runner_id: 'pc-runner' },
  dispatch: { sessions: { day: '2026-11-01', used: 2 }, projects_unreadable: null },
  authority: { paused: false, mandate: { generation: 3, expires_at: iso(200) }, admission: { on: false, enabled: false } },
  controls: { pause: { done: false }, mandate_off: { done: true } },
  projects: [{ project_id: PID, dispatch: { state: 'released', reconcile: false, attempt_id: 'att1', claim_state: 'released', run_id: 'run1' }, reports: { claude: { report_id: 'rep1' } } }],
};
const line = (over = {}) => ({ format: 'cr-pilot-all@1', dry_run: true, max_agents: 1, polled: [], exit: 0, error: null, revision: { runner: SHA, desk: SHA, source: 'git', clean: true }, ...over });
const B0_RUN = {
  'revision-final.json': revision,
  'healthz.txt': healthz,
  'tasks-final.json': tasks,
  'controls.json': controls,
  'trader.json': { now: iso(1), orders: [], requests: [], results: { open_positions: [], closed_positions: [] }, candles: { accounting_unknown: null, last_run_at: iso(1) } },
  'dry-run.json': line(),
  'dry-run-negative.json': line({ exit: 1, error: 'Revision guard: This checkout has uncommitted changes.' }),
  'isolation.json': { format: 'cr-pilot-launch@1', ok: true },
  'doctor.json': { checks: [{ name: 'Market data', detail: 'Last success' }, { name: 'Contract screening', detail: '2 screened' }, { name: 'Forensics', detail: 'none yet' }] },
  'B0.txt': 'readback\n',
};
const B0_FILLED = {
  'candidate.json': { project_id: PID, chain: 'ethereum', contract: '0xabc', coingecko_id: 'proof', exit_target: '500', model_id: 'claude-opus-5-5', vetoed: false, held: false, arm_desk_reviewed: true, contract_gate: 'enforce', max_grants_per_day: 1 },
  'build-deploy.json': { render_deploy_commit: SHA, prs: [1, 2, 3, 4].map((number) => ({ number, merged: true, head_checks: 'green' })) },
  'authority.json': { render_cron: 'absent', scout_enabled: false },
  'heartbeat.json': { period_minutes: 60, grace_minutes: 120, alerts_eric_only: true, dry_run_ping_claimed: false },
};
function put(root, step, files) {
  const dir = path.join(root, A.FOLDERS[step]);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
  return dir;
}
const sealIt = (root, step, flags = {}, d = deps()) => C.command(step, { seal: true, evidence: root, baseline: SHA, ...flags }, d);

// The verifier's git and /healthz reads, stubbed as the verifier's own tests do.
function verifierDeps({ anchored = () => true } = {}) {
  return {
    now: () => iso(400),
    env: { PATH: process.env.PATH || process.env.Path },
    fetchImpl: async () => new Response(`ok\nrevision ${SHA} (main)\n`, { status: 200 }),
    run: (cmd, args) => {
      const a = args.slice(2);
      if (a[0] === 'rev-parse') return { status: 0, stdout: SHA };
      if (a[0] === 'status') return { status: 0, stdout: '' };
      if (a[0] === 'merge-base') return { status: 0, stdout: SHA };
      if (a[0] === 'show') return { status: 0, stdout: fs.readFileSync(path.join(ROOT, a[1].slice('HEAD:'.length)), 'utf8') };
      if (a[0] === 'grep') return { status: anchored(a[3]) ? 0 : 1, stdout: '' };
      if (a[0] === 'diff') return { status: 0, stdout: 'docs/engineering/OPERATING_PROOF_B0.md\n' };
      return assert.fail(`Unexpected git operation: ${a[0]}`);
    },
  };
}
const prove = (step, root, d = verifierDeps()) => A.verify({ step, desk: 'online', evidence: root, mode: 'post-merge', expectedRevision: SHA }, d);

// ---- The template --------------------------------------------------------
test('--template writes the blank forms and the commands, and runs nothing', (t) => {
  const root = evidenceRoot(t);
  const out = C.command('b0', { template: true, evidence: root }, deps({ run: () => assert.fail('a command ran'), fetchImpl: () => assert.fail('the network was used') }));
  assert.deepEqual(fs.readdirSync(path.join(root, 'B0')).sort(), Object.keys(C.FORMS.b0).sort());
  assert.ok(fs.readFileSync(path.join(root, 'CAPTURE-B0.txt'), 'utf8').includes('dry-run-negative.json'));
  assert.equal(out._text, fs.readFileSync(path.join(root, 'CAPTURE-B0.txt'), 'utf8'));
  for (const form of Object.values(C.FORMS.b0)) assert.ok(JSON.stringify(form).includes('null'));
});

test('every value on a form starts blank: no form presets an answer', () => {
  const leaves = (v) => (v && typeof v === 'object' ? Object.values(v).flatMap(leaves) : [v]);
  for (const form of Object.values(C.FORMS.b0)) assert.ok(leaves(form).every((v) => v === null));
});

test('the forms have exactly the fields the verifier reads', () => {
  const keys = (v) => (Array.isArray(v) ? v.map(keys) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, keys(x)])) : 0);
  for (const [name, form] of Object.entries(C.FORMS.b0)) assert.deepEqual(keys(form), keys(B0_FILLED[name]), name);
  assert.deepEqual(Object.keys(C.FORMS.b0).sort(), Object.keys(B0_FILLED).sort());
  for (const name of Object.keys(C.FORMS.b0)) assert.ok(A.OWNER_RECORDS.has(name), `${name} is on Eric's own list`);
});

test('every record a gate reads has a command or a form, and every form field is explained', () => {
  for (const step of ['r0', 'b0']) {
    const covered = new Set([...Object.keys(C.FORMS[step]), ...C.CAPTURES[step].flatMap((c) => c.files), A.NARRATIVES[step]]);
    for (const f of C.requiredFiles(step)) assert.ok(covered.has(f), `${step} has no way to make ${f}`);
    const text = C.captureText(step, path.join(os.tmpdir(), 'x'));
    for (const c of C.CAPTURES[step]) for (const f of c.files) assert.ok(text.includes(f), f);
  }
  const words = C.FILLING.b0.join('\n');
  const fields = (v) => (Array.isArray(v) ? fields(v[0]) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...fields(x)]) : []);
  for (const [name, form] of Object.entries(C.FORMS.b0)) {
    assert.ok(words.includes(name), name);
    for (const f of fields(form)) if (f !== 'number' && f !== 'merged' && f !== 'head_checks') assert.ok(words.includes(f), `${name}: ${f}`);
  }
});

test('the commands do not do a runbook step and never name a secret', () => {
  const forbidden = /Enable-ScheduledTask|Disable-ScheduledTask|Register-ScheduledTask|Unregister|Start-ScheduledTask|Stop-|-Register\b|-Remove\b|-Enable\b|-Disable\b|-Method\b|\bgit\s+(?:-C\s+\S+\s+)?(?:reset|clean|checkout|push|merge)\b|job run|explorer export|arm-desk|\bPOST\b|CR_HEALTHCHECK|TOKEN|method:/i;
  for (const step of ['r0', 'b0']) {
    const lines = C.CAPTURES[step].flatMap((c) => c.run);
    for (const l of lines) assert.doesNotMatch(l, forbidden, l);
  }
  // The one edit in them is undone by name, and the last line shows it is gone.
  const negative = C.CAPTURES.b0.find((c) => c.files.includes('dry-run-negative.json')).run;
  assert.match(negative[0], /Add-Content/);
  assert.match(negative[3], /restore package\.json$/);
  assert.match(negative[4], /status --porcelain$/);
  assert.equal(C.CAPTURES.b0.flatMap((c) => c.run).filter((l) => /Add-Content/.test(l)).length, 1);
  assert.equal(C.CAPTURES.r0.flatMap((c) => c.run).filter((l) => /Add-Content/.test(l)).length, 0);
  assert.ok(fs.existsSync(path.join(ROOT, 'package.json')), 'the file it edits is in the repository');
});

test('the Hourly tasks are read while still Disabled: the commands come before it is enabled', () => {
  const note = C.CAPTURES.r0.find((c) => c.files.includes('tasks-final.json')).note;
  assert.match(note, /before you enable Hourly/);
  const order = C.CAPTURES.r0.map((c) => c.files[0]);
  assert.ok(order.indexOf('tasks-final.json') < order.indexOf('offsite-readback.json'));
  assert.ok(order.indexOf('verification.json') < order.indexOf('offsite-readback.json'));
});

test('--template refuses an existing step folder and changes nothing in it', (t) => {
  const root = evidenceRoot(t);
  const dir = put(root, 'r0', { 'revision-final.json': { keep: 'me' } });
  assert.equal(code(() => C.command('r0', { template: true, evidence: root }, deps())), 'ALREADY_EXISTS');
  assert.deepEqual(fs.readdirSync(dir), ['revision-final.json']);
  assert.equal(fs.readFileSync(path.join(dir, 'revision-final.json'), 'utf8'), '{"keep":"me"}');
  assert.ok(!fs.existsSync(path.join(root, 'CAPTURE-R0.txt')));
});

test('--template and --seal refuse a checkout or a workspace as the evidence folder', (t) => {
  const base = path.dirname(evidenceRoot(t));
  const checkout = path.join(base, 'checkout');
  fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
  assert.equal(code(() => C.command('r0', { template: true, evidence: path.join(checkout, 'proof') }, deps())), 'BAD_PATH');
  const desk = path.join(base, 'desk');
  fs.mkdirSync(path.join(desk, 'R0'), { recursive: true });
  fs.writeFileSync(path.join(desk, 'workspace.json'), '{}');
  assert.equal(code(() => sealIt(desk, 'r0')), 'BAD_PATH');
  assert.equal(code(() => C.command('r0', { template: true, evidence: ROOT }, deps())), 'BAD_PATH');
});

test('forms and commands exist for r0 and b0 only, and the flags are strict', (t) => {
  const root = evidenceRoot(t);
  assert.equal(code(() => C.command('b1', { template: true, evidence: root }, deps())), 'USAGE');
  assert.equal(code(() => C.command('nope', { template: true, evidence: root }, deps())), 'USAGE');
  assert.equal(code(() => C.command('r0', { template: true }, deps())), 'USAGE');
  assert.equal(code(() => C.command('r0', { template: true, seal: true, evidence: root, baseline: SHA }, deps())), 'USAGE');
  assert.equal(code(() => C.command('r0', { template: 'x', evidence: root }, deps())), 'USAGE');
  assert.equal(code(() => C.command('r0', { seal: 'x', evidence: root }, deps())), 'USAGE');
  assert.equal(code(() => C.command('r0', { template: true, evidence: root, baseline: SHA }, deps())), 'USAGE');
  assert.equal(code(() => C.command('r0', { template: true, evidence: [root, root] }, deps())), 'USAGE');
  assert.equal(code(() => C.command('r0', { template: true, evidence: root, desk: 'online' }, deps())), 'USAGE');
  assert.ok(!fs.existsSync(root), 'no refusal created the folder');
});

test('a form left blank never passes a gate, even if it is bound by hand', async (t) => {
  const root = evidenceRoot(t);
  const bind = (step, files) => {
    const dir = put(root, step, files);
    const listed = Object.keys(files).map((name) => { const b = fs.readFileSync(path.join(dir, name)); return { path: name, bytes: b.length, sha256: sha256(b) }; });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ format: `cr-operating-proof-${step}-evidence@1`, closed_at: iso(3), baseline: SHA, files: listed }));
  };
  bind('r0', R0);
  bind('b0', { ...B0_RUN, ...C.FORMS.b0 });
  const report = await prove('b0', root);
  assert.notEqual(report.result, 'PASS');
  for (const gate of ['b0:build_deploy', 'b0:quiet_authority', 'b0:heartbeat_config', 'b0:arming_identity']) {
    const row = report.checks.find((c) => c.id === gate);
    assert.ok(row, gate);
    assert.notEqual(row.result, 'PASS', gate);
  }
});

// ---- The seal ------------------------------------------------------------
test('a sealed folder reads as a closed bundle, and the steps pass only on their records', async (t) => {
  const root = evidenceRoot(t);
  put(root, 'r0', R0);
  const r0 = sealIt(root, 'r0');
  assert.equal(r0.status, 'ok');
  assert.equal(r0.members, Object.keys(R0).length);
  C.command('b0', { template: true, evidence: root }, deps());
  put(root, 'b0', { ...B0_RUN, ...B0_FILLED });
  const b0 = sealIt(root, 'b0');
  const manifest = JSON.parse(fs.readFileSync(b0.manifest, 'utf8'));
  assert.equal(manifest.format, 'cr-operating-proof-b0-evidence@1');
  assert.equal(manifest.baseline, SHA);
  assert.equal(manifest.closed_at, iso(3));
  assert.equal(sha256(fs.readFileSync(b0.manifest)), b0.manifest_sha256);
  const report = await prove('b0', root);
  assert.equal(report.result, 'PASS', JSON.stringify(report.checks.filter((c) => c.result !== 'PASS')));
});

test('sealing certifies nothing: with no merged receipt the step stays unproved', async (t) => {
  const root = evidenceRoot(t);
  put(root, 'r0', R0);
  sealIt(root, 'r0');
  put(root, 'b0', { ...B0_RUN, ...B0_FILLED });
  const b0 = sealIt(root, 'b0');
  assert.match(b0.note, /does not mean they are true/);
  assert.match(b0.note, /receipt merged/);
  const report = await prove('b0', root, verifierDeps({ anchored: () => false }));
  assert.notEqual(report.result, 'PASS');
  assert.equal(report.checks.find((c) => c.id === 'b0:anchor').result, 'UNVERIFIED');
});

test('a changed member after sealing fails the verifier', async (t) => {
  const root = evidenceRoot(t);
  put(root, 'r0', R0);
  sealIt(root, 'r0');
  put(root, 'b0', { ...B0_RUN, ...B0_FILLED });
  const b0 = sealIt(root, 'b0');
  fs.appendFileSync(path.join(path.dirname(b0.manifest), 'heartbeat.json'), ' ');
  const report = await prove('b0', root);
  assert.equal(report.result, 'FAIL');
});

test('--seal refuses a missing member and names it, and writes no manifest', (t) => {
  const root = evidenceRoot(t);
  const files = { ...R0 };
  delete files['offsite-readback.json'];
  const dir = put(root, 'r0', files);
  assert.equal(code(() => sealIt(root, 'r0')), 'MISSING');
  assert.match(message(() => sealIt(root, 'r0')), /offsite-readback\.json/);
  assert.ok(!fs.existsSync(path.join(dir, 'manifest.json')));
});

test('--seal needs B0\'s own account, but R0\'s record is its receipt', (t) => {
  const root = evidenceRoot(t);
  const files = { ...B0_RUN, ...B0_FILLED };
  delete files['B0.txt'];
  put(root, 'b0', files);
  assert.match(message(() => sealIt(root, 'b0')), /B0\.txt/);
  assert.ok(!C.requiredFiles('r0').includes('R0.txt'));
});

test('--seal refuses a form still blank, naming the field', (t) => {
  const root = evidenceRoot(t);
  const heartbeat = clone(B0_FILLED['heartbeat.json']);
  heartbeat.grace_minutes = null;
  const build = clone(B0_FILLED['build-deploy.json']);
  build.prs[2].head_checks = null;
  const dir = put(root, 'b0', { ...B0_RUN, ...B0_FILLED, 'heartbeat.json': heartbeat, 'build-deploy.json': build });
  assert.equal(code(() => sealIt(root, 'b0')), 'UNFILLED');
  const words = message(() => sealIt(root, 'b0'));
  assert.match(words, /heartbeat\.json: grace_minutes/);
  assert.match(words, /build-deploy\.json: prs\.2\.head_checks/);
  assert.ok(!fs.existsSync(path.join(dir, 'manifest.json')));
});

test('a null in the desk\'s own record is the desk\'s to say, so it does not stop the seal', (t) => {
  const root = evidenceRoot(t);
  put(root, 'b0', { ...B0_RUN, ...B0_FILLED });
  assert.ok(JSON.stringify(B0_RUN['controls.json']).includes('null'));
  assert.equal(sealIt(root, 'b0').status, 'ok');
});

test('--seal refuses a credential-shaped value without repeating it', (t) => {
  const root = evidenceRoot(t);
  const value = `ghp_${'x'.repeat(30)}`;
  const dir = put(root, 'r0', { ...R0, 'notes.txt': `token ${value}\n` });
  assert.equal(code(() => sealIt(root, 'r0')), 'SECRET');
  const words = message(() => sealIt(root, 'r0'));
  assert.match(words, /notes\.txt/);
  assert.ok(!words.includes(value));
  assert.ok(!fs.existsSync(path.join(dir, 'manifest.json')));
});

test('--seal refuses this machine\'s own secret value, and any shape in a member no gate reads', (t) => {
  const root = evidenceRoot(t);
  const value = 'correct-horse-battery';
  put(root, 'r0', { ...R0, 'full-suite.log': `saw ${value}\n` });
  const d = deps({ env: { CR_SOME_TOKEN: value } });
  assert.equal(code(() => sealIt(root, 'r0', {}, d)), 'SECRET');
  assert.ok(!message(() => sealIt(root, 'r0', {}, d)).includes(value));
});

test('--seal refuses fictional markers in a record a gate reads, and leaves a saved log alone', (t) => {
  const root = evidenceRoot(t);
  const dir = put(root, 'r0', { ...R0, 'doctor-main-workspace.json': { verified_write: true, checks: [{ name: 'Workspace folder', status: 'ok', detail: 'D:\\Desk (kind: demo)' }] } });
  assert.equal(code(() => sealIt(root, 'r0')), 'FICTIONAL');
  assert.ok(!fs.existsSync(path.join(dir, 'manifest.json')));
  const other = evidenceRoot(t);
  put(other, 'r0', { ...R0, 'full-suite.log': 'a test named FICTIONAL ran\n' });
  assert.equal(sealIt(other, 'r0').status, 'ok');
});

test('--seal refuses a baseline that is not the recorded origin/main, or not a SHA', (t) => {
  const root = evidenceRoot(t);
  const dir = put(root, 'r0', R0);
  assert.equal(code(() => sealIt(root, 'r0', { baseline: OTHER })), 'MISMATCH');
  assert.equal(code(() => sealIt(root, 'r0', { baseline: 'abc' })), 'USAGE');
  assert.equal(code(() => C.command('r0', { seal: true, evidence: root }, deps())), 'USAGE');
  assert.ok(!fs.existsSync(path.join(dir, 'manifest.json')));
});

test('--seal refuses broken JSON, and a folder that is not there', (t) => {
  const root = evidenceRoot(t);
  assert.equal(code(() => sealIt(root, 'r0')), 'MISSING');
  assert.ok(!fs.existsSync(root), 'a seal never creates the folder');
  put(root, 'r0', { ...R0, 'verification.json': '{"torn' });
  assert.equal(code(() => sealIt(root, 'r0')), 'INVALID');
  assert.match(message(() => sealIt(root, 'r0')), /verification\.json/);
});

test('PowerShell\'s UTF-16 and byte-order marks seal and read back', async (t) => {
  const root = evidenceRoot(t);
  const dir = put(root, 'r0', R0);
  fs.writeFileSync(path.join(dir, 'doctor-main-workspace.json'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(R0['doctor-main-workspace.json']), 'utf16le')]));
  fs.writeFileSync(path.join(dir, 'tasks-final.json'), `\uFEFF${JSON.stringify(tasks)}`);
  assert.equal(sealIt(root, 'r0').status, 'ok');
  const value = `ghp_${'x'.repeat(30)}`;
  const other = evidenceRoot(t);
  const otherDir = put(other, 'r0', R0);
  fs.writeFileSync(path.join(otherDir, 'notes.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, 'utf16le')]));
  assert.equal(code(() => sealIt(other, 'r0')), 'SECRET', 'a secret in UTF-16 is still seen');
});

test('a sealed folder cannot be sealed twice and its manifest is not changed', (t) => {
  const root = evidenceRoot(t);
  put(root, 'r0', R0);
  const first = sealIt(root, 'r0');
  const before = fs.readFileSync(first.manifest);
  assert.equal(code(() => sealIt(root, 'r0', {}, deps({ now: () => iso(5) }))), 'ALREADY_EXISTS');
  assert.deepEqual(fs.readFileSync(first.manifest), before);
});

test('a subfolder is left out and named, the bound files are every file, and no temporary file stays', (t) => {
  const root = evidenceRoot(t);
  const dir = put(root, 'r0', { ...R0, 'hourly-route-probe.ps1': '# probe\n', 'hourly-route-probe.txt': 'exit=73\n' });
  fs.mkdirSync(path.join(dir, 'route-probe-bin'));
  fs.writeFileSync(path.join(dir, 'route-probe-bin', 'node.exe'), 'MZ');
  const out = sealIt(root, 'r0');
  assert.deepEqual(out.not_bound, ['route-probe-bin']);
  const listed = JSON.parse(fs.readFileSync(out.manifest, 'utf8')).files.map((f) => f.path);
  assert.deepEqual(listed, [...Object.keys(R0), 'hourly-route-probe.ps1', 'hourly-route-probe.txt'].sort());
  assert.deepEqual(fs.readdirSync(dir).sort(), [...listed, 'manifest.json', 'route-probe-bin'].sort());
});

test('--seal refuses a link, too many files, and more than the verifier reads', (t) => {
  const root = evidenceRoot(t);
  const dir = put(root, 'r0', R0);
  for (let i = 0; i < 60; i += 1) fs.writeFileSync(path.join(dir, `extra-${i}.txt`), 'x');
  assert.equal(code(() => sealIt(root, 'r0')), 'INVALID');
  assert.match(message(() => sealIt(root, 'r0')), /More than 64/);

  const big = evidenceRoot(t);
  const bigDir = put(big, 'r0', R0);
  for (let i = 0; i < 9; i += 1) { const p = path.join(bigDir, `big-${i}.bin`); fs.writeFileSync(p, ''); fs.truncateSync(p, A.MAX_FILE); }
  assert.match(message(() => sealIt(big, 'r0')), /larger than the verifier reads/);

  const linked = evidenceRoot(t);
  const linkedDir = put(linked, 'r0', R0);
  try { fs.symlinkSync(path.join(linkedDir, 'healthz.txt'), path.join(linkedDir, 'link.txt')); } catch (_) { return; } // Windows without the privilege.
  assert.equal(code(() => sealIt(linked, 'r0')), 'BAD_PATH');
});

// ---- Through the CLI -----------------------------------------------------
const cli = (args) => {
  const env = { ...process.env };
  delete env.CR_WORKSPACE;
  return spawnSync(process.execPath, [path.join(ROOT, 'dashboard', 'cli.js'), ...args], { encoding: 'utf8', timeout: 60000, env });
};

test('through the CLI: --template prints the commands and --seal closes the folder', (t) => {
  const root = evidenceRoot(t);
  const made = cli(['prove-autonomy', 'r0', '--template', `--evidence=${root}`]);
  assert.equal(made.status, 0, made.stderr);
  assert.ok(made.stdout.includes('pilot-all.final-status.json'));
  put(root, 'r0', R0);
  const closed = cli(['prove-autonomy', 'r0', '--seal', `--baseline=${SHA}`, `--evidence=${root}`, '--json']);
  assert.equal(closed.status, 0, closed.stderr);
  assert.equal(JSON.parse(closed.stdout).status, 'ok');
  const again = cli(['prove-autonomy', 'r0', '--seal', `--baseline=${SHA}`, `--evidence=${root}`]);
  assert.notEqual(again.status, 0);
});

test('the verifier without these flags is unchanged, and refuses them on itself', async (t) => {
  const root = evidenceRoot(t);
  const full = { desk: 'online', mode: 'post-merge', expected_revision: SHA, evidence: root, out: `${root}-report` };
  await assert.rejects(A.command('r0', { ...full, template: true }, verifierDeps()), (e) => e.code === 'USAGE');
  await assert.rejects(A.command('r0', { ...full, seal: true }, verifierDeps()), (e) => e.code === 'USAGE');
  await assert.rejects(A.command('r0', { ...full, seal: 'x' }, verifierDeps()), (e) => e.code === 'USAGE');
  await assert.rejects(A.command('r0', { ...full, template: 'x' }, verifierDeps()), (e) => e.code === 'USAGE');
  const help = cli(['help']);
  assert.match(help.stdout, /--template --evidence=DIR/);
  assert.match(help.stdout, /--seal --baseline=SHA --evidence=DIR/);
});

test('the module imports no way to run anything or reach the network', () => {
  const source = fs.readFileSync(path.join(ROOT, 'dashboard', 'core', 'proof-capture.js'), 'utf8');
  const code2 = source.replace(/String\.raw`[^`]*`/g, '').replace(/'[^'\n]*'/g, (m) => (m.includes('./autonomy-proof') || ["'fs'", "'path'", "'crypto'"].includes(m) ? m : "''"));
  const required = [...code2.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(required, ['./autonomy-proof', 'crypto', 'fs', 'path']);
  assert.doesNotMatch(code2, /\bfetch\(|spawn|exec\(|openWorkspace/);
});
