'use strict';
// Law 1, the environment path (Stage 1.5, PR B1; core/child-env.js): a GitHub
// credential in the runner's environment reaches no child it starts. Every
// token here is a FICTIONAL marker. The children are real where a real child
// can be started, and no GitHub read is made: `gh` is always a stand-in here.
// This says nothing about a stored `gh` login, which no environment can remove;
// the doctor line reports that one, and only Eric's real PC can show it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('../scripts/pilot');
const CE = require('../core/child-env');
const { doctor } = require('../core/doctor');
const { tempWorkspace } = require('./helpers');

const DASH = path.join(__dirname, '..');
const MARKERS = {
  GH_TOKEN: 'FICTIONAL-marker-gh-token-000',
  GITHUB_TOKEN: 'FICTIONAL-marker-github-token-111',
  GH_ENTERPRISE_TOKEN: 'FICTIONAL-marker-gh-enterprise-222',
  GITHUB_ENTERPRISE_TOKEN: 'FICTIONAL-marker-github-enterprise-333',
  GITHUB_PAT: 'FICTIONAL-marker-github-pat-444',
  GH_APP_PRIVATE_KEY: 'FICTIONAL-marker-gh-app-key-555',
  HOMEBREW_GITHUB_API_TOKEN: 'FICTIONAL-marker-homebrew-666',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'FICTIONAL-marker-actions-777',
  GIT_ASKPASS: 'FICTIONAL-marker-askpass-888',
};
const VALUES = Object.values(MARKERS);
const READER = 'FICTIONAL-desk-reader-999';

const noMarker = (text, where) => { for (const v of VALUES) assert.ok(!String(text).includes(v), `${where} carried ${v}`); };
const baseEnv = () => {
  const out = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) if (process.env[k] !== undefined) out[k] = process.env[k];
  return out;
};
const markedEnv = (extra = {}) => ({ ...baseEnv(), ...MARKERS, CR_GITHUB_TOKEN: READER, ...extra });

// A real child: it prints the whole environment it was started with.
const DUMP = 'process.stdout.write(JSON.stringify(process.env))';
function childSaw(opts) {
  const r = spawnSync(process.execPath, ['-e', DUMP], { ...opts, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, `the dump child ran: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// Set markers in this process's own environment for one call, then restore it.
function withProcessEnv(over, fn) {
  const before = {};
  for (const k of Object.keys(over)) { before[k] = process.env[k]; process.env[k] = over[k]; }
  const restore = () => { for (const k of Object.keys(over)) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; } };
  try { return fn(); } finally { restore(); }
}

// ---- The rule

test('the rule names GitHub credentials in any case and keeps what is not one', () => {
  for (const name of Object.keys(MARKERS)) {
    assert.equal(CE.isGithubCredentialName(name), true, name);
    assert.equal(CE.isGithubCredentialName(name.toLowerCase()), true, name.toLowerCase());
  }
  for (const name of ['GITHUB_PERSONAL_ACCESS_TOKEN', 'GH_PAT', 'NPM_GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'SSH_ASKPASS', 'Github_Token']) assert.equal(CE.isGithubCredentialName(name), true, name);
  for (const name of ['CR_GITHUB_TOKEN', 'cr_github_token', 'GH_PROMPT_DISABLED', 'GH_CONFIG_DIR', 'GITHUB_ACTIONS', 'GITHUB_SHA', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'PATH', 'SIGHT_TOKEN', 'WEIGHT_TOKEN']) assert.equal(CE.isGithubCredentialName(name), false, name);
});

test('the scrub returns a copy without the credentials and leaves its input alone', () => {
  const input = { ...MARKERS, gh_token: 'FICTIONAL-marker-gh-token-000', KEEP: 'yes', CR_GITHUB_TOKEN: READER };
  const before = JSON.stringify(input);
  const out = CE.withoutGithubCredentials(input);
  assert.deepEqual(out, { KEEP: 'yes', CR_GITHUB_TOKEN: READER });
  assert.equal(JSON.stringify(input), before);
});

// ---- Agent sessions

test('a real child started with a session\'s environment sees no marker and no desk reader', () => {
  const saw = childSaw({ env: P.launchEnv(markedEnv()) });
  noMarker(JSON.stringify(saw), 'a session child');
  assert.ok(saw.PATH || saw.Path, 'the child was started with the runner\'s own path, so this is not an empty environment');
  assert.equal(saw.CR_GITHUB_TOKEN, undefined, 'the desk\'s reader is not on a session\'s allowlist');
});

test('the runner\'s real launcher: neither the probe nor the session gets a marker, and the stand-in proves it ran', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-credential-stand-in-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(path.join(__dirname, 'claude-stand-in.js'), path.join(dir, 'claude-stand-in.js'));
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  const launch = P.makeLauncher({ bin: { file: process.execPath, args: [path.join(dir, 'claude-stand-in.js')] }, env: markedEnv(), settings: { model: null, effort: null }, platform: 'linux', statFile: () => 'absent', probeTimeoutMs: 20000 });
  const verdict = await launch.preflight({});
  assert.equal(verdict.ok, true);
  launch('FROZEN PROMPT (FICTIONAL)', { tools: P.AGENT_TOOLS, model: null, timeoutMin: 1 });
  const records = fs.readFileSync(path.join(dir, 'record.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(records.length >= 2, 'one probe and one session ran for real');
  for (const r of records) {
    noMarker(JSON.stringify(r), 'the launched executable');
    assert.equal(r.env.CR_GITHUB_TOKEN, undefined);
  }
});

test('a credential name added to the allowlist by mistake still does not reach a session', () => {
  const added = ['GH_TOKEN', 'GITHUB_TOKEN', 'GIT_ASKPASS'].filter((k) => !P.ENV_KEEP.has(k));
  assert.equal(added.length, 3, 'none is on the allowlist today');
  for (const k of added) P.ENV_KEEP.add(k);
  try {
    noMarker(JSON.stringify(P.launchEnv(markedEnv())), 'launchEnv with a widened allowlist');
  } finally {
    for (const k of added) P.ENV_KEEP.delete(k);
  }
});

// ---- The runner's other children

test('the runner\'s desk-command wrapper: a real `node cli.js` child sees no marker, and keeps the desk\'s reader', (t) => {
  const w = tempWorkspace('credential-cli');
  t.after(() => w.cleanup());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-credential-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const seen = path.join(dir, 'seen.jsonl');
  const probe = path.join(dir, 'probe.js');
  fs.writeFileSync(probe, `require('fs').appendFileSync(${JSON.stringify(seen)}, JSON.stringify(process.env) + '\\n');\n`);
  // The child loads the probe before cli.js: what it records is what it was given.
  const answer = withProcessEnv({ ...MARKERS, CR_GITHUB_TOKEN: READER, NODE_OPTIONS: `--require ${JSON.stringify(probe)}` }, () => P.cli(['capabilities', '--json', '--workspace', w.root]));
  assert.ok(answer && typeof answer === 'object', 'the desk command still answered');
  const rows = fs.readFileSync(seen, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1, 'the probe ran in the one child');
  noMarker(JSON.stringify(rows[0]), 'the desk-command child');
  assert.equal(rows[0].CR_GITHUB_TOKEN, READER, 'the forensic monitor\'s reader stays for the desk\'s commands');
});

test('the registry read: the options it passes start a real child with no marker', () => {
  let saw = null;
  const out = withProcessEnv(MARKERS, () => P.regQuery(baseEnv(), (file, args, opts) => { saw = childSaw(opts); return { status: 0, stdout: '', stderr: '' }; }));
  assert.ok(out && saw, 'the read asked for a child');
  noMarker(JSON.stringify(saw), 'the registry child');
  assert.ok(saw.PATH || saw.Path, 'the rest of the environment is kept');
});

test('the checkout\'s git read: the options it passes start a real child with no marker', () => {
  const saws = [];
  const run = (file, args, opts) => { saws.push(childSaw(opts)); return { status: 0, stdout: 'a'.repeat(40), stderr: '' }; };
  withProcessEnv(MARKERS, () => P.runnerRevision({ env: baseEnv(), root: DASH, run, hasGit: () => true }));
  assert.ok(saws.length >= 1, 'git was asked');
  for (const saw of saws) noMarker(JSON.stringify(saw), 'the git child');
});

test('OPS-1\'s preflight children get no marker, whatever env it was given', async () => {
  const O = require('../scripts/ops1-preflight');
  const saws = [];
  const run = (file, args, opts) => { saws.push(childSaw(opts)); return { status: 0, stdout: '', stderr: '' }; };
  await O.preflight({ env: markedEnv({ CR_PILOT_MODEL: 'claude-opus-5-5' }), run, fetchImpl: async () => { throw new Error('FICTIONAL no network'); }, nodeVersion: '24.0.0', resolveClaude: () => process.execPath });
  assert.equal(saws.length, 2, 'the claude check and the isolation check both asked for a child');
  for (const saw of saws) {
    noMarker(JSON.stringify(saw), 'a preflight child');
    assert.equal(saw.CR_PILOT_MODEL, 'claude-opus-5-5', 'the rest of what it was given is kept');
  }
});

// ---- Every place the code starts a process

// Each file that loads child_process, and how a credential is kept out of what
// it starts. A new file, or a new start line, is red until someone decides.
const INVENTORY = {
  'dashboard/cli.js': 'scrubbed',
  'dashboard/server.js': 'scrubbed',
  'dashboard/core/schedule.js': 'scrubbed',
  'dashboard/scripts/rollback-drill.js': 'scrubbed',
  'dashboard/scripts/ops1-preflight.js': 'scrubbed',
  'dashboard/scripts/pilot.js': 'scrubbed',
  'dashboard/core/child-env.js': 'the reader itself: gh, with the environment it is measuring',
  'dashboard/core/autonomy-proof.js': 'its own limited environment (autonomy-proof.test.js)',
  'dashboard/scripts/sanity-report.js': 'Eric\'s own report: it runs gh on purpose and no runner calls it',
  'atlas/build.mjs': 'a build tool Eric runs: git only',
  'atlas/pdf.mjs': 'a build tool Eric runs: a local browser',
  'dashboard/web/scripts/cdp.mjs': 'a dev browser tool',
  'dashboard/web/scripts/check.mjs': 'a dev browser tool',
  'dashboard/web/scripts/dev.mjs': 'a dev server tool',
  'dashboard/web/scripts/fx-shots.mjs': 'a dev browser tool',
  'dashboard/web/scripts/proof-shots.mjs': 'a dev browser tool',
  'dashboard/web/scripts/regress.mjs': 'a dev browser tool',
};
const REPO = path.join(__dirname, '..', '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'tests', 'audits', 'app', 'dist']);
function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) sourceFiles(path.join(dir, e.name), out); }
    else if (/\.(c|m)?js$/.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}
const rel = (f) => path.relative(REPO, f).split(path.sep).join('/');

test('every file that can start a process is on the list, with how a credential is kept out', () => {
  const found = sourceFiles(REPO).filter((f) => /require\(['"](node:)?child_process['"]\)|from ['"](node:)?child_process['"]/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort();
  assert.deepEqual(found, Object.keys(INVENTORY).sort());
});

test('in each scrubbed file, every direct start states its environment', () => {
  const START = /\b(?:spawnSync|spawn|execSync|execFileSync|execFile|fork)\(/;
  for (const [file, posture] of Object.entries(INVENTORY)) {
    if (posture !== 'scrubbed') continue;
    const text = fs.readFileSync(path.join(REPO, file), 'utf8');
    assert.match(text, /withoutGithubCredentials|launchEnv/, `${file} uses the rule`);
    for (const line of text.split('\n')) {
      const code = line.replace(/^\s*\/\/.*$/, '');
      if (START.test(code) && !/^\s*function /.test(code)) assert.match(code, /\benv\b/, `${file}: ${code.trim().slice(0, 120)}`);
    }
  }
});

test('the test runner, the scheduled-task reader and the browser opener hand their child a scrubbed environment', () => {
  const lineOf = (file, re) => fs.readFileSync(path.join(DASH, file), 'utf8').split('\n').filter((l) => re.test(l));
  for (const [file, re, n] of [['cli.js', /spawnSync\(process\.execPath, \['--test'/, 1], ['core/schedule.js', /spawnSync\('powershell\.exe'/, 1], ['server.js', /\bspawn\('(cmd|open|xdg-open)'/, 3], ['scripts/rollback-drill.js', /\bspawnSync\(/, 2]]) {
    const lines = lineOf(file, re);
    assert.equal(lines.length, n, `${file} has the expected start lines`);
    for (const l of lines) assert.match(l, /env: withoutGithubCredentials\(process\.env\)/, file);
  }
});

// ---- The diagnostic

const gh = (answer) => {
  const calls = [];
  const run = (file, args, opts) => { calls.push({ file, args, opts }); return typeof answer === 'function' ? answer(calls.length, opts) : answer; };
  return { run, calls };
};
const read = (run, over = {}) => CE.readGithubAccess({ env: markedEnv(), run, sessionEnv: P.launchEnv, ...over });
const ok = (stdout) => ({ status: 0, stdout, stderr: '' });

test('admin true: both reads go out, gh\'s session read carries no credential, and the line warns about the stored login', () => {
  const g = gh(ok('true\n'));
  const a = read(g.run);
  assert.equal(g.calls.length, 2);
  assert.deepEqual(g.calls[0].args, ['api', 'repos/kuaya1/CryptoResearch', '--jq', '.permissions.admin'], 'the one read-only call');
  assert.equal(g.calls[1].file, 'gh');
  noMarker(JSON.stringify(g.calls[1].opts.env), 'the session read');
  for (const c of g.calls) { assert.equal(c.opts.env.GH_PROMPT_DISABLED, '1'); assert.equal(c.opts.timeout, CE.GH_TIMEOUT_MS); assert.equal(c.opts.shell, undefined); }
  assert.deepEqual([a.shell.auth, a.shell.admin, a.session.admin], ['available', true, true]);
  assert.deepEqual(a.children_exclude, { session: true, desk_command: true });
  const line = CE.credentialLine(a);
  assert.equal(line.level, 'warn');
  assert.match(line.detail, /GitHub auth in this shell: available/);
  assert.match(line.detail, /Admin on kuaya1\/CryptoResearch: yes/);
  assert.match(line.detail, /GH_TOKEN/);
  assert.match(line.detail, /Child environments exclude them: yes/);
  assert.match(line.detail, /through the stored gh login/);
  assert.match(line.detail, /Law 1 is procedural/);
  noMarker(line.detail, 'the doctor line');
  noMarker(JSON.stringify(a), 'the access record');
});

test('admin false is not an alarm, and it never claims Law 1 is enforced', () => {
  const line = CE.credentialLine(read(gh(ok('false')).run));
  assert.equal(line.level, 'info');
  assert.match(line.detail, /Admin on kuaya1\/CryptoResearch: no/);
  assert.match(line.detail, /can still read GitHub through the stored gh login, without admin/);
  assert.doesNotMatch(line.detail, /enforced|safe|secure/i);
});

test('a shell token GitHub refuses does not hide the stored login behind it', () => {
  const g = gh((n) => (n === 1 ? { status: 1, stdout: '', stderr: 'HTTP 401: Bad credentials (FICTIONAL)' } : ok('true')));
  const a = read(g.run);
  assert.equal(a.shell.auth, 'none');
  assert.equal(a.session.admin, true);
  assert.equal(CE.credentialLine(a).level, 'warn');
});

test('every way gh cannot answer is unknown, says why in fixed words, and is never a pass or a failure', () => {
  const ENOENT = Object.assign(new Error('spawn gh ENOENT (FICTIONAL)'), { code: 'ENOENT' });
  const TIMEOUT = Object.assign(new Error('FICTIONAL'), { code: 'ETIMEDOUT' });
  for (const [answer, why] of [
    [{ status: null, error: ENOENT, stdout: '', stderr: '' }, /gh is not installed/],
    [{ status: null, error: TIMEOUT, stdout: '', stderr: '' }, /gh timed out/],
    [{ status: 1, stdout: '', stderr: 'error connecting to api.github.com (FICTIONAL)' }, /expected offline/],
    [ok(''), /did not state a permission/],
    [ok('null'), /did not state a permission/],
    [ok('maybe'), /did not state a permission/],
    [null, /did not answer/],
  ]) {
    const g = gh(answer);
    const a = read(g.run);
    assert.equal(g.calls.length, 1, 'no second read once the first came back unknown');
    assert.deepEqual([a.shell.auth, a.shell.admin, a.session.admin], ['unknown', null, null]);
    const line = CE.credentialLine(a);
    assert.equal(line.level, 'info', 'an offline doctor does not fail on this');
    assert.equal(line.ok, true);
    assert.match(line.detail, why);
    assert.match(line.detail, /Admin on kuaya1\/CryptoResearch: unknown/);
    assert.doesNotMatch(line.detail, /FICTIONAL/, 'gh\'s own words are never repeated');
  }
  const threw = read(() => { throw new Error('FICTIONAL bad spawn'); });
  assert.equal(threw.shell.auth, 'unknown');
  assert.doesNotMatch(CE.credentialLine(threw).detail, /FICTIONAL/);
});

test('exit 4 means not signed in, and that is not admin', () => {
  const a = read(gh({ status: 4, stdout: '', stderr: 'FICTIONAL' }).run);
  assert.deepEqual([a.shell.auth, a.shell.admin], ['none', null]);
  assert.match(CE.credentialLine(a).detail, /GitHub auth in this shell: none \(gh is not signed in\)/);
});

test('gh\'s output never reaches the record, even when it holds a token', () => {
  for (const answer of [{ status: 1, stdout: MARKERS.GH_TOKEN, stderr: MARKERS.GITHUB_TOKEN }, ok(MARKERS.GH_TOKEN), { status: 4, stdout: MARKERS.GH_TOKEN, stderr: MARKERS.GH_TOKEN }]) {
    const a = read(gh(answer).run);
    noMarker(JSON.stringify(a), 'the access record');
    noMarker(CE.credentialLine(a).detail, 'the doctor line');
  }
});

test('network: false makes no call at all, and still checks the children', () => {
  const g = gh(ok('true'));
  const a = read(g.run, { network: false });
  assert.equal(g.calls.length, 0);
  assert.deepEqual([a.shell.auth, a.session.auth], ['not_read', 'not_read']);
  assert.deepEqual(a.children_exclude, { session: true, desk_command: true });
  const line = CE.credentialLine(a);
  assert.equal(line.level, 'info');
  assert.match(line.detail, /GitHub auth in this shell: not read/);
});

test('a leaking builder is a failure in the line, named for the builder that leaks, and never blamed on the stored login', () => {
  const leakSession = read(gh(ok('true')).run, { sessionEnv: (e) => ({ ...P.launchEnv(e), GH_TOKEN: e.GH_TOKEN }) });
  assert.equal(leakSession.children_exclude.session, false);
  let line = CE.credentialLine(leakSession);
  assert.deepEqual([line.ok, line.level], [false, 'fail']);
  assert.match(line.detail, /NO \(session leaks, desk command clean\)/);
  assert.doesNotMatch(line.detail, /stored gh login/);
  const renamed = read(gh(ok('false')).run, { sessionEnv: (e) => ({ PATH: e.PATH, CARRIED: e.GH_TOKEN }) });
  assert.equal(renamed.children_exclude.session, false, 'a marker value under another name is still a leak');
  const leakDesk = read(gh(ok('false')).run, { deskEnv: (e) => ({ ...e }) });
  line = CE.credentialLine(leakDesk);
  assert.equal(line.level, 'fail');
  assert.match(line.detail, /NO \(session clean, desk command leaks\)/);
});

test('the shell\'s token names are listed once, in upper case, with no value; the desk\'s reader is named apart', () => {
  const a = read(gh(ok('false')).run, { env: { ...baseEnv(), gh_token: MARKERS.GH_TOKEN, GH_TOKEN: MARKERS.GH_TOKEN, CR_GITHUB_TOKEN: READER } });
  assert.deepEqual(a.shell_token_names, ['GH_TOKEN']);
  assert.equal(a.desk_reader_token, true);
  const line = CE.credentialLine(a);
  assert.match(line.detail, /CR_GITHUB_TOKEN is set/);
  assert.ok(!line.detail.includes(READER));
  const none = read(gh(ok('false')).run, { env: baseEnv() });
  assert.match(CE.credentialLine(none).detail, /Token variables in this shell: none/);
});

// ---- The doctor

test('the doctor carries the line only when its caller asks: the desk\'s status read has none and starts nothing', async (t) => {
  const w = tempWorkspace('credential-doctor');
  t.after(() => w.cleanup());
  const plain = await doctor(w.ws);
  assert.equal(plain.checks.some((c) => c.name === 'GitHub credentials'), false);
  const server = fs.readFileSync(path.join(DASH, 'server.js'), 'utf8');
  assert.match(server, /route\('GET', '\/api\/doctor', async \(\) => require\('\.\/core\/doctor'\)\.doctor\(ws\)\)/);
  assert.match(server, /route\('POST', '\/api\/doctor\/write-test', async \(\) => require\('\.\/core\/doctor'\)\.doctor\(ws, \{ writeProbe: true \}\)\)/);
  for (const [level, status] of [['warn', 'warn'], ['info', 'info'], ['fail', 'fail']]) {
    const r = await doctor(w.ws, { credentials: () => ({ ok: level !== 'fail', level, detail: 'FICTIONAL line' }) });
    const row = r.checks.find((c) => c.name === 'GitHub credentials');
    assert.deepEqual([row.status, row.detail], [status, 'FICTIONAL line']);
    if (level === 'fail') assert.equal(r.status, 'fail');
  }
});

test('a reader that throws is unknown in the doctor, never a crash', async (t) => {
  const w = tempWorkspace('credential-doctor-throw');
  t.after(() => w.cleanup());
  const r = await doctor(w.ws, { credentials: () => { throw new Error('FICTIONAL secret-looking words'); } });
  const row = r.checks.find((c) => c.name === 'GitHub credentials');
  assert.equal(row.status, 'info');
  assert.doesNotMatch(row.detail, /FICTIONAL/);
});

test('the real command: `cli doctor` in a test workspace reports the line, echoes no marker, and exits 0 without asking GitHub', (t) => {
  const w = tempWorkspace('credential-cli-doctor');
  t.after(() => w.cleanup());
  const r = spawnSync(process.execPath, [path.join(DASH, 'cli.js'), 'doctor', '--json', '--workspace', w.root], { env: markedEnv(), encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  noMarker(r.stdout + r.stderr, 'the doctor\'s output');
  const out = JSON.parse(r.stdout);
  const row = out.checks.find((c) => c.name === 'GitHub credentials');
  assert.equal(row.status, 'info');
  assert.match(row.detail, /GitHub auth in this shell: not read \(not read in a test or demo workspace\)/);
  assert.match(row.detail, /Admin on kuaya1\/CryptoResearch: unknown/);
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) assert.match(row.detail, new RegExp(name));
  assert.match(row.detail, /Child environments exclude them: yes/);
});

test('the module asks GitHub nothing but the one read and never asks gh for a token', () => {
  const text = fs.readFileSync(path.join(DASH, 'core', 'child-env.js'), 'utf8');
  assert.doesNotMatch(text, /auth['"], *['"]token|'auth token'|"auth token"/);
  assert.equal((text.match(/run\('gh'/g) || []).length, 1, 'one call site');
  assert.doesNotMatch(text, /shell: *true/);
  assert.doesNotMatch(text, /\b(POST|PUT|PATCH|DELETE)\b|--method|-X\b/);
});
