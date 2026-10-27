'use strict';
// The agent lane's behavioral verification (Eric, 2026-10-26;
// audits/2026-10-26-engineering-simplification): the named tests run on the
// merge tree, every changed line of code runs under them, and putting each
// implementation file back as main has it makes one of them fail. GPT's
// reproduction of the old import scan (two changed modules, a commented-out
// require, assert.ok(true)) is the first case. FICTIONAL modules in a
// temporary repository.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const V = require('../scripts/agent-verify');
const G = require('../scripts/agent-guard');

const POLICY = G.loadPolicy();
const WHO = { GIT_AUTHOR_NAME: 'FICTIONAL', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'FICTIONAL', GIT_COMMITTER_EMAIL: 'f@example.invalid' };
const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...WHO } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return String(r.stdout).trim();
};
const lines = (...l) => `${l.join('\n')}\n`;

// main with `before`, a candidate with `after` (null deletes), and the merge
// commit GitHub would test, checked out.
function mergeTree(t, before, after) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-verify-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (files) => {
    for (const [p, text] of Object.entries(files)) {
      const abs = path.join(dir, p);
      if (text === null) { fs.rmSync(abs, { force: true }); continue; }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
    }
  };
  git(dir, ['init', '-q']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  write(before);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'main']);
  const main = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  git(dir, ['checkout', '-q', '-b', 'candidate']);
  write(after);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'candidate']);
  git(dir, ['checkout', '-q', main]);
  git(dir, ['merge', '-q', '--no-ff', '--no-edit', 'candidate']);
  return { tree: dir, base: git(dir, ['rev-parse', 'HEAD^1']) };
}
const task = (tests = []) => ({ agent: true, ok: true, template: 'eng-backend@1', tests });
const run = (m, tests) => V.verify({ tree: m.tree, base: m.base, rev: 'HEAD', task: task(tests), policy: POLICY });

const WIDGET_BEFORE = lines("'use strict';", 'module.exports = { size: (s) => s.length };');
const WIDGET_AFTER = lines(
  "'use strict';",
  'function size(s) {',
  "  if (s === null || s === undefined) throw new TypeError('no input');",
  '  return s.trim().length;',
  '}',
  'module.exports = { size };',
);
const WIDGET_TEST = lines(
  "'use strict';",
  "const test = require('node:test');",
  "const assert = require('node:assert/strict');",
  "const { size } = require('../core/widget');",
  "test('surrounding spaces do not count', () => assert.equal(size(' ab '), 2));",
  "test('no input throws', () => assert.throws(() => size(null), { message: 'no input' }));",
);

test('GPT\'s reproduction fails: a commented-out require and assert.ok(true) are not evidence', (t) => {
  const before = { 'dashboard/core/a.js': lines('module.exports = { a: (x) => x + 1 };'), 'dashboard/core/b.js': lines('module.exports = { b: (x) => x * 2 };') };
  const after = { 'dashboard/core/a.js': lines('module.exports = { a: (x) => x + 2 };'), 'dashboard/core/b.js': lines('module.exports = { b: (x) => x * 3 };') };
  const trivial = mergeTree(t, before, { ...after, 'dashboard/tests/ab.test.js': lines("const assert = require('node:assert/strict');", "const { a } = require('../core/a');", "// const { b } = require('../core/b');", 'assert.ok(true);') });
  const r1 = run(trivial);
  assert.equal(r1.ok, false);
  assert.match(r1.reasons.join('\n'), /ab\.test\.js asserts only literals/);
  // With a real assertion on a, b still never loads: one changed module is
  // not evidence for the other.
  const half = mergeTree(t, before, { ...after, 'dashboard/tests/ab.test.js': lines("const assert = require('node:assert/strict');", "const { a } = require('../core/a');", "// const { b } = require('../core/b');", 'assert.equal(a(1), 3);') });
  const r2 = run(half);
  assert.equal(r2.ok, false);
  assert.deepEqual(r2.reasons, ['dashboard/core/b.js never loads while the named tests run']);
});

test('a change whose tests exercise the outcome and the negative case is verified, with revert evidence', (t) => {
  const m = mergeTree(t, { 'dashboard/core/widget.js': WIDGET_BEFORE }, { 'dashboard/core/widget.js': WIDGET_AFTER, 'dashboard/tests/widget.test.js': WIDGET_TEST });
  const r = run(m);
  assert.deepEqual(r.reasons, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.tests, ['dashboard/tests/widget.test.js']);
  assert.match(r.notes.join('\n'), /all 4 changed lines of code run/);
  assert.match(r.notes.join('\n'), /With dashboard\/core\/widget\.js as main has it, 2 named tests fail: they depend on the change/);
  assert.equal(fs.readFileSync(path.join(m.tree, 'dashboard/core/widget.js'), 'utf8'), WIDGET_AFTER, 'the file is put back after the revert run');
});

test('integration coverage counts: the test reaches the change through another module', (t) => {
  const service = lines("'use strict';", "const { size } = require('./widget');", 'module.exports = { describe: (s) => `${size(s)} chars` };');
  const viaService = lines(
    "'use strict';",
    "const assert = require('node:assert/strict');",
    "const { describe } = require('../core/service');",
    "assert.equal(describe(' ab '), '2 chars');",
    'assert.throws(() => describe(null), /no input/);',
  );
  const m = mergeTree(t, { 'dashboard/core/widget.js': WIDGET_BEFORE, 'dashboard/core/service.js': service }, { 'dashboard/core/widget.js': WIDGET_AFTER, 'dashboard/tests/service.test.js': viaService });
  const r = run(m);
  assert.deepEqual(r.reasons, []);
  assert.equal(r.ok, true);
});

test('an added module that is only imported is not covered', (t) => {
  const fresh = lines("'use strict';", 'function tenfold(x) {', '  return x * 10;', '}', 'module.exports = { tenfold };');
  const importOnly = lines("const assert = require('node:assert/strict');", "const m = require('../core/fresh');", "assert.equal(typeof m.tenfold, 'function');");
  const r = run(mergeTree(t, { 'dashboard/core/widget.js': WIDGET_BEFORE }, { 'dashboard/core/fresh.js': fresh, 'dashboard/tests/fresh.test.js': importOnly }));
  assert.equal(r.ok, false);
  assert.match(r.reasons[0], /fresh\.js: 2 of 4 changed lines of code never run under the named tests \(lines 2, 3\)/);
});

test('a test that runs the changed line but does not depend on it fails the revert check', (t) => {
  const r = run(mergeTree(t,
    { 'dashboard/core/label.js': lines("module.exports = { label: (n) => 'n=' + n };") },
    { 'dashboard/core/label.js': lines("module.exports = { label: (n) => 'count: ' + n };"), 'dashboard/tests/label.test.js': lines("const assert = require('node:assert/strict');", "const { label } = require('../core/label');", "assert.equal(typeof label(2), 'string');") }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons, ['with dashboard/core/label.js as main has it, every named test still passes: the tests do not depend on this change']);
});

test('failing tests, a deleted test and a change with no test are refused', (t) => {
  const failing = run(mergeTree(t, { 'dashboard/core/widget.js': WIDGET_BEFORE }, { 'dashboard/core/widget.js': WIDGET_AFTER, 'dashboard/tests/widget.test.js': WIDGET_TEST.replace("size(' ab '), 2", "size(' ab '), 4") }));
  assert.equal(failing.ok, false);
  assert.match(failing.reasons[0], /the named tests fail on the merge tree \(exit 1; 1 of 2 failed\)/);
  assert.deepEqual(failing.reasons.slice(1), ['failing: surrounding spaces do not count'], 'the failing test is named, the file line left out');
  assert.deepEqual(V.failingReason([]), []);
  assert.deepEqual(V.failingReason(['a', 'b', 'c', 'd', 'e', 'f', 'g']), ['failing: a; b; c; d; e (and 2 more)']);
  const deleted = run(mergeTree(t, { 'dashboard/core/widget.js': WIDGET_BEFORE, 'dashboard/tests/old.test.js': lines("require('node:assert').ok(require('../core/widget'));") }, { 'dashboard/core/widget.js': WIDGET_AFTER, 'dashboard/tests/old.test.js': null, 'dashboard/tests/widget.test.js': WIDGET_TEST }));
  assert.match(deleted.reasons.join('\n'), /old\.test\.js is deleted/);
  const untested = run(mergeTree(t, { 'dashboard/core/widget.js': WIDGET_BEFORE }, { 'dashboard/core/widget.js': WIDGET_AFTER }));
  assert.deepEqual(untested.reasons, ['no test is added, changed or named by the task']);
  // A regression test the task names counts even when the change leaves it
  // as it was on main.
  const named = run(mergeTree(t, { 'dashboard/core/widget.js': WIDGET_BEFORE, 'dashboard/tests/widget.test.js': WIDGET_TEST }, { 'dashboard/core/widget.js': WIDGET_AFTER }), ['dashboard/tests/widget.test.js']);
  assert.equal(named.ok, true);
});

test('the lint reads code, not comments or strings', () => {
  assert.equal(V.lintTest('assert.equal(size(""), 0);'), null);
  assert.equal(V.lintTest('t.assert.deepEqual(out, { a: 1 });'), null);
  assert.equal(V.lintTest('expect(result).toBe(2);'), null);
  assert.match(V.lintTest('assert.ok(true);\nassert.equal(1, 1);\nassert.equal("a", "a");'), /only literals/);
  assert.match(V.lintTest('// assert.equal(size(x), 0);\nconst s = "assert.equal(size(x), 0)";'), /holds no assertion/);
  assert.match(V.lintTest('/* assert.equal(size(x), 0); */ assert.ok(true);'), /only literals/);
  assert.equal(V.isCode('  }'), false);
  assert.equal(V.isCode('  // note'), false);
  assert.equal(V.isCode('  return x;'), true);
});

test('documentation tasks have no behavior to verify', (t) => {
  const m = mergeTree(t, { 'docs/engineering/a.md': 'a\n' }, { 'docs/engineering/a.md': 'b\n' });
  const r = V.verify({ tree: m.tree, base: m.base, task: { agent: true, ok: true, template: 'eng-docs@1', tests: [] }, policy: POLICY });
  assert.equal(r.ok, true);
  assert.match(r.notes[0], /No implementation file of eng-docs@1 changed/);
});
