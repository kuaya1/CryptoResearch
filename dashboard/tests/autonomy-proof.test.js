'use strict';
// New functionality: acceptance/negative scenarios, not a claimed regression.
// Every desk/evidence input here is fictional. No task, provider or live desk.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const A = require('../core/autonomy-proof');
const ROOT = path.resolve(__dirname, '../..');
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const AT = '2026-11-03T20:00:00.000Z';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const check = (report, id) => report.checks.find((c) => c.id === id);

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-autonomy-proof-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('cr-autonomy-proof-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
function put(root, rel, value) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  return p;
}
function deps(over = {}) {
  const calls = [];
  const env = { PATH: process.env.PATH || process.env.Path, SYSTEMROOT: process.env.SYSTEMROOT || process.env.SystemRoot || '', GH_TOKEN: 'FICTIONAL-GITHUB-SECRET-123456789', NODE_OPTIONS: '--require FICTIONAL-never-executed' };
  return {
    calls, env, now: () => AT,
    run: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      assert.equal(cmd, 'git');
      const a = args.slice(2);
      let stdout = '';
      if (a[0] === 'rev-parse') stdout = a[2] === 'HEAD' ? HEAD : BASE;
      else if (a[0] === 'status') stdout = '';
      else if (a[0] === 'merge-base') stdout = a[1] === '--is-ancestor' ? '' : BASE;
      else if (a[0] === 'show') stdout = fs.readFileSync(path.join(ROOT, a[1].slice('HEAD:'.length)), 'utf8');
      else assert.fail(`Unexpected git operation: ${a[0]}`);
      return { status: 0, stdout };
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, A.HEALTHZ);
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, undefined);
      return new Response(`ok\nrevision ${BASE} (main)\n`, { status: 200 });
    },
    ...over,
  };
}
async function proof(step = 'b0', options = {}, d = deps()) {
  return A.verify({ step, offline: true, ...options }, d);
}
function controls(over = {}) {
  return { format: 'cr-desk-controls@1', at: AT, authority: { admission: { on: false, enabled: false } },
    dispatch: { projects_unreadable: null }, projects: [{ project_id: 'fictional-project', dispatch: { state: 'none', reconcile: false } }], ...over };
}
function r0Bundle(root) {
  const members = {
    'revision-final.json': { observed_at: AT, healthz_status: 200, origin_main: BASE, runner_head: BASE, deployed_sha: BASE },
    'tasks-final.json': { pilot: { state: 'Disabled', enabled: false, instances: 0 }, hourly: { state: 'Disabled', instances: 0 } },
    'pilot-all.final-status.json': { registered: true, ours: true, status: { task: { state: 'Disabled' } }, config: { launcher: 'job_wrapper', max_agents: 1, unattended: true, model_named: true, checkout_clean: true, checkout_head: BASE, working_directory_is_repository: true } },
    'verification.json': { runner: { clean: true, detached: true } },
  };
  const manifest = { format: 'cr-operating-proof-r0-evidence@1', baseline: BASE, closed_at: AT, files: [] };
  for (const [name, record] of Object.entries(members)) {
    const text = JSON.stringify(record);
    put(root, `R0/${name}`, text);
    manifest.files.push({ path: name, bytes: Buffer.byteLength(text), sha256: sha(text) });
  }
  const text = JSON.stringify(manifest);
  put(root, 'R0/manifest.json', text);
  const receipt = `Fictional test receipt: manifest.json\` binds files. Its SHA-256 is\n\`${sha(text)}\`.\n`;
  const d = deps();
  const baseRun = d.run;
  d.run = (cmd, args, opts) => args.at(-1) === `HEAD:${A.R0_RECEIPT}` ? { status: 0, stdout: receipt } : baseRun(cmd, args, opts);
  return { d, manifest, members };
}

for (const step of A.STEPS) test(`${step}: absent operating evidence is UNVERIFIED, with canonical requirements and provenance`, async () => {
  const r = await proof(step);
  assert.equal(r.result, 'UNVERIFIED');
  assert.equal(r.exit_code, 2);
  assert.equal(r.verified_at, AT);
  assert.equal(r.application_revision.head, HEAD);
  assert.equal(check(r, 'canonical_source').result, 'PASS');
  assert.ok(A.GATES[step].every(([id]) => check(r, `${step}:${id}`).result === 'UNVERIFIED'));
  assert.ok(r.missing_evidence.length && r.checks_not_executed.length);
  assert.ok(r.sources.every((s) => /^[a-f0-9]{64}$/.test(s.sha256)));
});

test('B0 contradictory admission evidence is FAIL, even beside successful checks', async (t) => {
  const dir = temp(t);
  put(dir, 'B0.txt', 'PASS everything, this text is not authority');
  put(dir, 'B0/controls.json', controls({ authority: { admission: { enabled: true, on: true } } }));
  const r = await proof('b0', { evidence: dir });
  assert.equal(r.result, 'FAIL');
  assert.equal(r.exit_code, 1);
  assert.equal(check(r, 'b0:admission').result, 'FAIL');
  assert.equal(check(r, 'narrative').result, 'UNVERIFIED');
  assert.ok(r.checks.some((c) => c.result === 'PASS'));
});

test('an intact snapshot gives only partial facts, never a complete B0 PASS or live origin', async (t) => {
  const dir = temp(t);
  put(dir, 'B0/controls.json', controls());
  const r = await proof('b0', { evidence: dir, project: 'fictional-project' });
  assert.equal(check(r, 'b0:admission').result, 'PASS');
  assert.equal(check(r, 'b0:claims').result, 'PASS');
  assert.equal(r.result, 'UNVERIFIED');
  assert.ok(r.sources.filter((s) => s.path.startsWith('B0/')).every((s) => s.observation === 'offline_record'));
});

test('a declared fixture never queries the live desk or establishes operating success', async (t) => {
  const dir = temp(t);
  put(dir, 'B0/controls.json', { ...controls(), origin: 'live_run', result: 'PASS' });
  const r = await proof('b0', { evidence: dir, offline: false, fixture: true }, deps({ fetchImpl: () => assert.fail('fixture made network request') }));
  assert.equal(r.result, 'UNVERIFIED');
  assert.equal(r.deployment.state, 'not_executed');
  assert.equal(check(r, 'b0:admission').observation, 'fixture');
  assert.ok(!JSON.stringify(r).includes('live_run'));
});

test('feature HEAD need not equal origin/main or deployment', async () => {
  const r = await proof('b0', { offline: false, expectedRevision: BASE, base: BASE });
  assert.notEqual(r.application_revision.head, r.application_revision.origin_main);
  assert.equal(check(r, 'development_base').result, 'PASS');
  assert.equal(check(r, 'deployment_revision').result, 'PASS');
  assert.equal(r.result, 'UNVERIFIED');
});

test('deployed revision mismatch is FAIL; an unavailable healthz is UNVERIFIED', async () => {
  const r = await proof('b0', { offline: false, expectedRevision: OTHER });
  assert.equal(r.result, 'FAIL');
  assert.equal(r.deployment.revision, BASE);
  for (const fetchImpl of [async () => new Response('unavailable', { status: 503 }), async () => { throw new Error('FICTIONAL secret'); }, async () => new Response('ok, no revision')]) {
    const unavailable = await proof('b0', { offline: false, expectedRevision: BASE }, deps({ fetchImpl }));
    assert.equal(unavailable.result, 'UNVERIFIED');
    assert.ok(unavailable.checks_executed.includes('deployment_revision'));
    assert.ok(!JSON.stringify(unavailable).includes('FICTIONAL secret'));
  }
});

test('healthz is bounded and never redirected or interpreted as pipeline proof', async () => {
  const r = await proof('r0', { offline: false, expectedRevision: BASE }, deps({ fetchImpl: async () => new Response(`revision ${BASE}\n${'X'.repeat(5000)}`) }));
  assert.equal(r.deployment.state, 'unavailable');
  assert.equal(r.result, 'UNVERIFIED');
  assert.match(check(r, 'deployment_revision').criterion, /not pipeline health/);
});

test('post-merge mode requires an explicit revision; development does not guess one', async () => {
  await assert.rejects(proof('b0', { mode: 'post-merge' }), { code: 'USAGE' });
  const r = await proof('r0', { offline: false });
  assert.equal(r.application_revision.expected_deployed, null);
  assert.equal(check(r, 'deployment_revision').result, 'UNVERIFIED');
});

test('a recorded base outside HEAD ancestry fails; unavailable git stays unknown', async () => {
  const d = deps();
  const run = d.run;
  d.run = (cmd, args, opts) => args.includes('--is-ancestor') ? { status: 1, stdout: '' } : run(cmd, args, opts);
  assert.equal((await proof('r0', { base: OTHER }, d)).result, 'FAIL');
  const r = await proof('r0', {}, deps({ run: () => ({ status: 128, stdout: '' }) }));
  assert.equal(r.result, 'UNVERIFIED');
  assert.equal(r.application_revision.head, null);
});

test('local Git readers receive neither synthetic token credentials nor executable environment injections', () => {
  const d = deps();
  A.gitRevision(ROOT, BASE, d);
  for (const call of d.calls) {
    assert.equal(call.opts.shell, undefined);
    assert.equal(call.opts.env.GH_TOKEN, undefined);
    assert.equal(call.opts.env.NODE_OPTIONS, undefined);
    assert.equal(call.opts.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(call.opts.env.GIT_CONFIG_GLOBAL, process.platform === 'win32' ? 'NUL' : os.devNull);
    assert.ok(!JSON.stringify(call.opts.env).includes(d.env.GH_TOKEN));
  }
});

test('missing/inaccessible scheduled-task information never claims tasks are disabled', async (t) => {
  const dir = temp(t);
  const r = await proof('r0', { evidence: dir });
  assert.equal(check(r, 'r0:registration').result, 'UNVERIFIED');
  assert.equal(r.result, 'UNVERIFIED');
  const b0 = await proof('b0');
  assert.equal(check(b0, 'b0:quiet_authority').result, 'UNVERIFIED');
});

test('malformed evidence is refused and is never reconstructed; an empty object gives no success', async (t) => {
  const dir = temp(t);
  put(dir, 'B0/controls.json', '{"format":"cr-desk-controls@1",');
  assert.equal((await proof('b0', { evidence: dir })).result, 'FAIL');
  put(dir, 'B0/controls.json', {});
  assert.equal((await proof('b0', { evidence: dir })).result, 'UNVERIFIED');
});

test('a missing evidence directory stays UNVERIFIED; incomplete/future claim snapshots cannot pass', async (t) => {
  const dir = temp(t);
  assert.equal((await proof('b0', { evidence: path.join(dir, 'missing') })).result, 'UNVERIFIED');
  put(dir, 'B0/controls.json', controls({ projects: [{ project_id: 'fictional-project', dispatch: {} }] }));
  assert.equal(check(await proof('b0', { evidence: dir }), 'b0:claims').result, 'UNVERIFIED');
  put(dir, 'B0/controls.json', controls({ at: '2026-11-04T00:00:00Z' }));
  const r = await proof('b0', { evidence: dir });
  assert.ok(!check(r, 'b0:admission'));
  assert.equal(r.result, 'UNVERIFIED');
});

test('duplicate /healthz revisions do not establish a deployment match', async () => {
  const r = await proof('b0', { offline: false, expectedRevision: BASE }, deps({ fetchImpl: async () => new Response(`revision ${BASE}\nrevision ${OTHER}\n`) }));
  assert.equal(r.deployment.state, 'unreadable');
  assert.equal(check(r, 'deployment_revision').result, 'UNVERIFIED');
});

test('an unreadable claim cannot be counted as a clean desk; a reconciliation is FAIL', async (t) => {
  const dir = temp(t);
  put(dir, 'B0/controls.json', controls({ dispatch: { projects_unreadable: 'unknown' }, projects: [] }));
  assert.equal(check(await proof('b0', { evidence: dir }), 'b0:claims').result, 'UNVERIFIED');
  put(dir, 'B0/controls.json', controls({ projects: [{ dispatch: { state: 'reconcile', reconcile: true } }] }));
  assert.equal((await proof('b0', { evidence: dir })).result, 'FAIL');
});

test('project scope is exact, and invalid project paths/options are refused', async (t) => {
  const dir = temp(t);
  put(dir, 'B0/controls.json', controls());
  const r = await proof('b0', { evidence: dir, project: 'different-project' });
  assert.equal(check(r, 'b0:project').result, 'UNVERIFIED');
  for (const project of ['../config', 'NMR', 'project/name']) await assert.rejects(proof('b0', { project }), { code: 'BAD_ID' });
  await assert.rejects(A.command('b0', { confirm: true }, deps()), { code: 'USAGE' });
  await assert.rejects(A.command('b0', { out: true }, deps()), { code: 'USAGE' });
});

test('committed R0 manifest verifies bytes, while an offline routing probe never proves a real offsite run', async (t) => {
  const dir = temp(t);
  const { d } = r0Bundle(dir);
  const r = await proof('r0', { evidence: dir, fixture: true }, d);
  assert.equal(check(r, 'r0:manifest').result, 'PASS');
  assert.equal(check(r, 'r0:recorded_registration').result, 'PASS');
  assert.equal(check(r, 'r0:recorded_registration').observed_at, null, 'no timestamp is borrowed from another observation');
  assert.equal(r.r0_bundle.verified_members, 4);
  assert.equal(r.evidence_root, dir);
  assert.equal(check(r, 'r0:offsite_run').result, 'UNVERIFIED');
  assert.equal(r.result, 'UNVERIFIED');
  assert.ok(r.checks.filter((c) => c.id.startsWith('r0:recorded')).every((c) => c.observation === 'fixture'));
});

test('R0 changed manifest or a missing/truncated member is FAIL, with no partial acceptance', async (t) => {
  for (const kind of ['manifest', 'member', 'missing']) {
    const dir = path.join(temp(t), kind);
    const { d } = r0Bundle(dir);
    if (kind === 'manifest') fs.appendFileSync(path.join(dir, 'R0/manifest.json'), ' ');
    else if (kind === 'member') put(dir, 'R0/verification.json', '{}');
    else fs.unlinkSync(path.join(dir, 'R0/verification.json'));
    const r = await proof('r0', { evidence: dir, fixture: true }, d);
    assert.equal(check(r, 'r0:manifest').result, 'FAIL');
    assert.equal(r.result, 'FAIL');
    assert.ok(!check(r, 'r0:recorded_alignment'));
  }
});

test('aggregate gives failure precedence, treats empty/unknown as UNVERIFIED, and only all PASS as PASS', () => {
  assert.equal(A.aggregate(['PASS', 'FAIL', 'UNVERIFIED']), 'FAIL');
  assert.equal(A.aggregate(['PASS', 'UNVERIFIED']), 'UNVERIFIED');
  assert.equal(A.aggregate([]), 'UNVERIFIED');
  assert.equal(A.aggregate(['PASS', 'unknown']), 'UNVERIFIED');
  assert.equal(A.aggregate(['PASS', 'PASS']), 'PASS');
});

test('output refuses traversal, Windows aliases, code/desk directories and symlink escape', async (t) => {
  const dir = temp(t);
  const r = await proof('b0');
  for (const out of [path.join(dir, 'child') + '/../outside', path.join(dir, 'NUL'), path.join(dir, 'stream:secret'), ROOT]) assert.throws(() => A.writeBundle(r, out), /path|directory|Output/i);
  const desk = path.join(dir, 'desk');
  put(desk, 'workspace.json', { kind: 'test' });
  assert.throws(() => A.writeBundle(r, path.join(desk, 'reports')), { code: 'BAD_PATH' });
  const target = path.join(dir, 'external');
  fs.mkdirSync(target);
  const link = path.join(dir, 'link');
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => A.writeBundle(r, path.join(link, 'escape')), { code: 'BAD_PATH' });
  assert.deepEqual(fs.readdirSync(target), []);
  await assert.rejects(proof('b0', { evidence: link }), { code: 'BAD_PATH' });
});

test('bundle files are exclusively created and hash-verifiable; collision preserves all previous bytes', async (t) => {
  const dir = temp(t);
  const r = await proof('b0');
  const runId = () => 'fixture-run-0001';
  const bundle = A.writeBundle(r, dir, { runId });
  const manifest = JSON.parse(fs.readFileSync(bundle.manifest));
  for (const f of manifest.files) assert.equal(sha(fs.readFileSync(path.join(bundle.directory, f.path))), f.sha256);
  const old = fs.readFileSync(bundle.metadata);
  assert.throws(() => A.writeBundle(r, dir, { runId }), { code: 'ALREADY_EXISTS' });
  assert.deepEqual(fs.readFileSync(bundle.metadata), old);
  assert.deepEqual(fs.readdirSync(bundle.directory).sort(), ['B0.txt', 'manifest.json', 'metadata.json']);
  const next = A.writeBundle(r, dir);
  assert.notEqual(next.directory, bundle.directory);
});

test('secret marker values in records, errors and environment never reach reports or generated bundles', async (t) => {
  const dir = temp(t);
  const evidence = path.join(dir, 'evidence');
  const marker = 'FICTIONAL-SECRET-MARKER-8943194812';
  put(evidence, 'B0.txt', `PASS ${marker}`);
  put(evidence, 'B0/controls.json', { ...controls(), token: marker, notes: marker });
  const r = await proof('b0', { evidence }, deps({ env: { GITHUB_TOKEN: marker, CR_HEALTHCHECK_URL: 'https://FICTIONAL-secret-ping.invalid/check' } }));
  const bundle = A.writeBundle(r, path.join(dir, 'out'));
  for (const p of [bundle.metadata, bundle.report, bundle.manifest]) assert.ok(!fs.readFileSync(p, 'utf8').includes(marker));
  assert.ok(!JSON.stringify(r).includes(marker));
});

test('preferred output uses the actual home and New York evidence date; supplied output stays selected', (t) => {
  const home = temp(t);
  const chosen = A.outputRoot(undefined, { home, now: new Date('2026-11-04T02:00:00Z') });
  assert.equal(chosen, path.join(home, 'Documents', 'CryptoResearch-evidence', 'operating-proof-2026-11-03'));
  assert.equal(A.outputRoot(path.join(home, 'chosen')), path.join(home, 'chosen'));
});

test('CLI bypasses recovery, exits 2 on missing proof, and leaves every desk-state byte unchanged', (t) => {
  const dir = temp(t);
  const desk = path.join(dir, 'desk');
  for (const [p, value] of Object.entries({ 'workspace.json': { kind: 'test' }, 'paper/positions.jsonl': '{CORRUPT\n', '.cr/ops/pending.json': { incomplete: true }, 'config/settings.json': { schema_version: 1 }, 'projects/fictional-project/project.json': { project_id: 'fictional-project' } })) put(desk, p, value);
  const before = new Map();
  const visit = (folder) => fs.readdirSync(folder, { withFileTypes: true }).forEach((e) => e.isDirectory() ? visit(path.join(folder, e.name)) : before.set(path.relative(desk, path.join(folder, e.name)), sha(fs.readFileSync(path.join(folder, e.name)))));
  visit(desk);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'dashboard/cli.js'), 'prove-autonomy', 'b0', '--offline', '--json', '--workspace', desk, '--out', path.join(dir, 'out')], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(r.status, 2, r.stderr || r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.result, 'UNVERIFIED');
  assert.equal(out.application_revision.head.length, 40);
  const after = new Map();
  for (const [rel, digest] of before) { after.set(rel, sha(fs.readFileSync(path.join(desk, rel)))); assert.equal(after.get(rel), digest); }
  const all = [];
  const list = (folder) => fs.readdirSync(folder, { withFileTypes: true }).forEach((e) => e.isDirectory() ? list(path.join(folder, e.name)) : all.push(path.relative(desk, path.join(folder, e.name))));
  list(desk);
  assert.deepEqual(all.sort(), [...before.keys()].sort());
  assert.ok(fs.existsSync(out.bundle.manifest));
});
