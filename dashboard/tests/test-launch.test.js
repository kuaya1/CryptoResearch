'use strict';
// The suite's launcher: `node dashboard/cli.js test` and the exit code it
// ends with (core/test-launch.js). Temporary folders of tiny FICTIONAL test
// files only; no workspace, no network.
//
// The command is run for real, as its own process: a miniature checkout holds
// the repository's cli.js byte for byte, beside a `core` folder whose every
// module is the real one (a one-line re-export each) and a `tests` folder of
// this test's choosing. So what is measured is the command's own discovery,
// launch and exit code.
//
// The rules under test:
// - A passing run exits 0 and a failing test exits non-zero, as the runner says.
// - A run that started no test is never a pass: no test file found, a launch
//   the operating system refused (on Windows, a command line over 32,767
//   characters: the long folder path case), a start from inside another test
//   run, or a runner that ended without an exit status, each exit 1 and say why.
// - Discovery, the one command and the child's environment are unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const TL = require('../core/test-launch');

const CLI = path.join(__dirname, '..', 'cli.js');
const CORE = path.join(__dirname, '..', 'core');
const PASSING = "require('node:test')('a FICTIONAL test that passes', () => {});\n";
const FAILING = "require('node:test')('a FICTIONAL test that fails', () => { throw new Error('FICTIONAL failure'); });\n";
// A plain shell's environment: without the variable `node --test` gives its
// own children (this file is one), under which a second runner starts nothing.
const PLAIN = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));

function checkout(t, name = 'cr-test-launch-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dash = path.join(root, 'dashboard');
  fs.mkdirSync(path.join(dash, 'core'), { recursive: true });
  fs.copyFileSync(CLI, path.join(dash, 'cli.js'));
  for (const f of fs.readdirSync(CORE)) if (f.endsWith('.js')) fs.writeFileSync(path.join(dash, 'core', f), `module.exports = require(${JSON.stringify(path.join(CORE, f))});\n`);
  const tests = path.join(dash, 'tests');
  return { root, tests, cli: path.join(dash, 'cli.js'), put: (rel, text = PASSING) => { fs.mkdirSync(path.dirname(path.join(tests, rel)), { recursive: true }); fs.writeFileSync(path.join(tests, rel), text); } };
}
// The command, as a process of its own, from the checkout's folder.
const command = (c, env = PLAIN) => spawnSync(process.execPath, [c.cli, 'test'], { cwd: c.root, env, encoding: 'utf8' });
// The runner's own count, in either of its two report forms; null when no runner reported.
const counted = (r, key) => { const m = new RegExp(`^(?:ℹ|#) ${key} (\\d+)$`, 'm').exec(`${r.stdout}${r.stderr}`); return m ? Number(m[1]) : null; };
const NO_TEST = 'No test file (*.test.js) was found, so no test ran. That is a failure, never a pass.';

test('a passing run exits 0 and a failing test exits non-zero: the runner\'s own exit code, with its tests counted', (t) => {
  const ok = checkout(t);
  assert.ok(fs.readFileSync(ok.cli).equals(fs.readFileSync(CLI)), 'the command under test is the repository\'s, byte for byte');
  ok.put('one.test.js');
  ok.put('two.test.js');
  const pass = command(ok);
  assert.equal(pass.status, 0, pass.stderr);
  assert.deepEqual([counted(pass, 'tests'), counted(pass, 'pass'), counted(pass, 'fail')], [2, 2, 0]);
  assert.equal(pass.stderr, '', 'a passing run says nothing of its own');

  const bad = checkout(t);
  bad.put('one.test.js');
  bad.put('two.test.js', FAILING);
  const fail = command(bad);
  assert.equal(fail.status, 1, 'a failing test is never exit 0: the runner\'s own code');
  assert.deepEqual([counted(fail, 'tests'), counted(fail, 'pass'), counted(fail, 'fail')], [2, 1, 1]);
  assert.doesNotMatch(fail.stderr, /never a pass/, 'the runner already said what failed');
});

test('no test file found: exit 1, nothing launched, and the reason in words', (t) => {
  // A tests folder with no test of its own (a helper, a note, a test one folder too deep), and no tests folder at all.
  const empty = checkout(t);
  empty.put('not-a-test.js');
  empty.put('notes.test.js.txt');
  empty.put(path.join('deeper', 'nested.test.js'));
  const none = checkout(t);
  for (const c of [empty, none]) {
    const r = command(c);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stderr.trim(), NO_TEST);
    assert.equal(counted(r, 'tests'), null, 'no runner was started: with an empty list it would look for tests of its own');
    assert.equal(r.stdout, '');
  }
  assert.deepEqual(TL.refusal([], PLAIN), { code: 1, words: NO_TEST });
  assert.equal(TL.refusal(['x.test.js'], PLAIN), null, 'with a test file and a plain environment the suite is launched');
});

test('the long folder path case, for real: more test files than one Windows command line holds either all run or the command fails; it never passes with nothing run', (t) => {
  const c = checkout(t, 'cr-test-launch-long-');
  // Names as long as a classic Windows path allows, and enough of them to pass 32,767 characters.
  const room = 240 - c.tests.length - 1;
  assert.ok(room >= 40, `the temporary folder leaves room for long names (${c.tests})`);
  const names = [];
  let chars = process.execPath.length + 10;
  for (let i = 0; chars <= TL.WINDOWS_COMMAND_LINE_MAX + 2000; i++) {
    const name = `long-${String(i).padStart(3, '0')}-${'x'.repeat(room - 17)}.test.js`;
    c.put(name);
    names.push(name);
    chars += c.tests.length + 1 + name.length + 3;
  }
  assert.ok(chars > TL.WINDOWS_COMMAND_LINE_MAX, `${names.length} files make a command line of about ${chars} characters`);
  const r = command(c);
  if (process.platform === 'win32') {
    // Windows refuses the launch. Before the correction the command then exited 0 with nothing printed.
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stderr.trim(), `The test runner could not be started (ENAMETOOLONG), so no test ran. That is a failure, never a pass. The command line that names all ${names.length} test files is too long for this system (Windows allows 32767 characters). Run the suite from a checkout in a shorter folder path.`);
    assert.equal(counted(r, 'tests'), null, 'nothing ran');
  } else {
    // Elsewhere the same list fits: every file runs and the run passes.
    assert.equal(r.status, 0, `${r.stderr}${r.stdout}`.slice(-600));
    assert.deepEqual([counted(r, 'tests'), counted(r, 'pass')], [names.length, names.length]);
  }
});

test('a launch the operating system refuses, or a runner that ends without an exit status, is exit 1 with the reason; the runner\'s own codes pass through', () => {
  const files = ['a.test.js', 'b.test.js'];
  const refused = (code) => ({ status: null, signal: null, error: Object.assign(new Error(`spawnSync node ${code}`), { code }) });
  // What the launch returns when the program cannot be started, taken from a real one.
  const real = spawnSync(path.join(os.tmpdir(), 'cr-no-such-node-binary'), ['--test'], { stdio: 'pipe' });
  assert.equal(real.status, null, 'a launch that did not happen has no exit status');
  assert.ok(real.error && real.error.code, 'and carries the operating system\'s error');
  assert.deepEqual(TL.outcome(files, real), { code: 1, words: `The test runner could not be started (${real.error.code}), so no test ran. That is a failure, never a pass.` });
  // The long command line, as Windows reports it (and as other systems name it).
  for (const code of ['ENAMETOOLONG', 'E2BIG']) {
    assert.deepEqual(TL.outcome(files, refused(code)), { code: 1, words: `The test runner could not be started (${code}), so no test ran. That is a failure, never a pass. The command line that names all 2 test files is too long for this system (Windows allows 32767 characters). Run the suite from a checkout in a shorter folder path.` });
  }
  assert.equal(TL.outcome(files, { status: null, error: new Error('no code') }).code, 1);
  // Stopped by a signal, or anything else without a whole-number status.
  assert.deepEqual(TL.outcome(files, { status: null, signal: 'SIGKILL' }), { code: 1, words: 'The test runner ended without an exit status (signal SIGKILL), so the suite did not finish. That is a failure, never a pass.' });
  for (const r of [{ status: null, signal: null }, { status: undefined }, {}, null, undefined, { status: '0' }, { status: 0.5 }]) {
    const out = TL.outcome(files, r);
    assert.equal(out.code, 1, JSON.stringify(r));
    assert.equal(out.words, 'The test runner ended without an exit status, so the suite did not finish. That is a failure, never a pass.');
  }
  // The runner's own codes, unchanged, with nothing added.
  for (const status of [0, 1, 2, 7, 130]) assert.deepEqual(TL.outcome(files, { status, signal: null }), { code: status, words: null });
});

test('started from inside another test run: exit 1 and nothing launched, because there the runner starts no file and exits 0', (t) => {
  const c = checkout(t);
  c.put('one.test.js');
  // This file is itself run by node --test, so the variable is set here.
  assert.notEqual(process.env.NODE_TEST_CONTEXT, undefined, 'node --test marks the processes it starts');
  // What the runner does there, for real: it starts no file and exits 0.
  const raw = spawnSync(process.execPath, ['--test', path.join(c.tests, 'one.test.js')], { encoding: 'utf8', env: process.env });
  assert.equal(raw.status, 0, 'the runner alone reports success');
  assert.equal(counted(raw, 'tests'), null, 'and ran nothing');
  // The command refuses instead, before any launch.
  const nested = command(c, process.env);
  assert.equal(nested.status, 1);
  assert.equal(nested.stderr.trim(), 'The suite was started from inside another test run (NODE_TEST_CONTEXT is set). There node --test starts none of the 1 test files and still exits 0, so nothing is launched. Run it from a plain shell.');
  assert.equal(counted(nested, 'tests'), null);
  assert.equal(TL.refusal(['one.test.js'], { NODE_TEST_CONTEXT: 'child-v8' }).code, 1);
  assert.equal(TL.refusal(['one.test.js'], { NODE_TEST_CONTEXT: '' }).code, 1, 'set at all, whatever its value');
  // From a plain shell the same folder runs.
  const plain = command(c);
  assert.deepEqual([plain.status, counted(plain, 'tests'), counted(plain, 'pass')], [0, 1, 1]);
});

test('what is launched is what it was: every *.test.js of the folder and of its sim folder and nothing else, without GitHub credentials', (t) => {
  const c = checkout(t);
  const seen = path.join(c.root, 'seen');
  fs.mkdirSync(seen);
  // Each FICTIONAL test file leaves its own name, and what it was given of the environment.
  const MARK = [
    "const fs = require('fs'); const path = require('path');",
    "require('node:test')('a FICTIONAL test that says it ran', () => {",
    "  const e = process.env;",
    "  fs.writeFileSync(path.join(e.CR_FIXTURE_SEEN, `${path.basename(__filename)}.json`), JSON.stringify({ GH_TOKEN: e.GH_TOKEN === undefined ? null : 'present', GITHUB_TOKEN: e.GITHUB_TOKEN === undefined ? null : 'present', CR_GITHUB_TOKEN: e.CR_GITHUB_TOKEN || null, KEEP: e.KEEP || null }));",
    '});',
    '',
  ].join('\n');
  for (const f of ['b.test.js', 'a.test.js', 'helper.js', 'notes.test.js.txt', path.join('sim', 's.test.js'), path.join('sim', 'deeper', 'd.test.js'), path.join('other', 'o.test.js')]) c.put(f, MARK);
  const r = command(c, { ...PLAIN, GH_TOKEN: 'FICTIONAL-not-a-token', GITHUB_TOKEN: 'FICTIONAL-not-a-token', CR_GITHUB_TOKEN: 'FICTIONAL-desk-reader', KEEP: '1', CR_FIXTURE_SEEN: seen });
  assert.equal(r.status, 0, `${r.stderr}${r.stdout}`.slice(-600));
  assert.deepEqual([counted(r, 'tests'), counted(r, 'pass')], [3, 3]);
  assert.deepEqual(fs.readdirSync(seen).sort(), ['a.test.js.json', 'b.test.js.json', 's.test.js.json'], 'the folder\'s tests and its sim folder\'s; no helper, no note, no other folder');
  for (const f of fs.readdirSync(seen)) {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(seen, f), 'utf8')), { GH_TOKEN: null, GITHUB_TOKEN: null, CR_GITHUB_TOKEN: 'FICTIONAL-desk-reader', KEEP: '1' }, `${f}: GitHub credentials are kept out, the rest is passed on`);
  }
  // The command's own lines: the discovery it had, and one launch.
  const src = fs.readFileSync(CLI, 'utf8');
  assert.ok(src.includes("const files = [dir, sim].filter((d) => fs.existsSync(d)).flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.test.js')).map((f) => path.join(d, f)));"), 'discovery is the line it was');
  assert.equal(src.split('\n').filter((l) => /spawnSync\(process\.execPath, \['--test', \.\.\.files\], \{ stdio: 'inherit', env: withoutGithubCredentials\(process\.env\) \}\)/.test(l)).length, 1, 'one launch, with the arguments it had');
});
