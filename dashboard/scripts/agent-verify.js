'use strict';
// The agent lane's behavioral verification (Eric, 2026-10-26;
// audits/2026-10-26-engineering-simplification). It replaces the old text
// scan for imports (reviewer.js testCoverage), which a commented-out require
// and assert.ok(true) satisfied. The contract, on the proposed merge tree
// (refs/pull/<n>/merge, checked out fresh) with this driver taken from main:
//
//   1. The named tests are the test files the change adds or changes plus the
//      regression tests the task names; the change deletes no test file.
//   2. Each named test holds at least one assertion about something other
//      than literals (comments do not count).
//   3. The named tests pass on the merge tree.
//   4. Every changed line of code in an implementation file (the template's,
//      .github/agent-policy.json) runs while they do (V8 coverage), so an
//      import of a module whose new functions are never called is not
//      coverage. A test may reach the code through other modules
//      (integration) instead of requiring it directly.
//   5. Each implementation file put back as main has it makes a named test
//      fail: the tests depend on the change.
//
// It runs the candidate's code, so its result is evidence for the review and
// for Eric, not proof against a candidate built to defeat it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { fileURLToPath } = require('url');
const P = require('../engineering/policy');

const TEST_RE = /^dashboard\/tests\/.+\.test\.js$/;
const RUN_MS = 10 * 60 * 1000;

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.error) throw r.error;
  return { status: r.status, out: String(r.stdout || '').trim(), raw: String(r.stdout || ''), err: String(r.stderr || '').trim() };
}

function changesOf(tree, base, rev) {
  const r = git(tree, ['diff', '--name-status', '--no-renames', base, rev]);
  if (r.status !== 0) return null;
  return r.out.split('\n').filter(Boolean).map((l) => { const [status, ...p] = l.split('\t'); return { status: status[0], path: p.join('\t') }; });
}
// Line numbers of `file` at `rev` that the change adds or rewrites.
function changedLines(tree, base, rev, file) {
  const out = new Set();
  for (const m of git(tree, ['diff', '-U0', '--no-renames', base, rev, '--', file]).raw.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const n = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < n; i += 1) out.add(start + i);
  }
  return out;
}
// A line that is code: not blank, not only a comment, not only closing marks.
function isCode(line) {
  const s = line.trim();
  return Boolean(s) && !/^(\/\/|\/\*|\*)/.test(s) && !/^[\])};,]+$/.test(s);
}

// The test text with comments and string contents removed, so neither a
// commented-out call nor an assertion in a string counts.
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; out += ' '; continue; }
    if (c === '"' || c === "'" || c === '`') {
      out += c;
      i += 1;
      while (i < src.length && src[i] !== c) { if (src[i] === '\\') i += 1; i += 1; }
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}
// Each assertion call's arguments, as written (balanced parentheses).
function assertionArgs(code) {
  const out = [];
  const re = /\b(?:assert(?:\.[A-Za-z]+)?|t\.assert\.[A-Za-z]+|expect)\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    let depth = 1;
    let j = re.lastIndex;
    while (j < code.length && depth) { if (code[j] === '(') depth += 1; else if (code[j] === ')') depth -= 1; j += 1; }
    out.push(code.slice(re.lastIndex, j - 1));
  }
  return out;
}
// An assertion about something: an argument holds a name or a call, not only
// literals (assert.ok(true), assert.equal(1, 1), assert.equal('a', 'a')).
const LITERAL_WORDS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);
function meaningful(args) {
  const rest = args.replace(/(["'`])(?:\\.|(?!\1).)*\1/gs, ' ').replace(/\b\d[\d_.eExXa-fA-F]*\b/g, ' ');
  return (rest.match(/[A-Za-z_$][\w$]*/g) || []).some((w) => !LITERAL_WORDS.has(w));
}
function lintTest(text) {
  const args = assertionArgs(stripComments(text));
  if (!args.length) return 'holds no assertion (assert, t.assert or expect)';
  if (!args.some(meaningful)) return 'asserts only literals (such as assert.ok(true)), so it checks nothing';
  return null;
}

// The named tests with V8 coverage in `dir` (one file per process).
function runTests(tree, files, { coverageDir = null } = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/TOKEN|KEY|SECRET|PASSWORD/i.test(k)) delete env[k];
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  if (coverageDir) env.NODE_V8_COVERAGE = coverageDir; else delete env.NODE_V8_COVERAGE;
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: tree, env, encoding: 'utf8', timeout: RUN_MS, maxBuffer: 64 * 1024 * 1024 });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  const count = (k) => { const m = new RegExp(`^# ${k} (\\d+)$`, 'm').exec(output); return m ? Number(m[1]) : null; };
  return { ok: r.status === 0, code: r.status, signal: r.signal, tests: count('tests'), passed: count('pass'), failed: count('fail'), tail: output.split('\n').slice(-40).join('\n') };
}

// For one source file: per character, the execution count of the innermost
// V8 range over it, the highest from any process (the runner forks one per
// test file).
function coverageOf(dir, absFile, text) {
  const all = new Float64Array(text.length).fill(-1);
  const want = process.platform === 'win32' ? absFile.toLowerCase() : absFile;
  let seen = false;
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    let data = null;
    try { data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch (_) { continue; }
    for (const script of (data && data.result) || []) {
      let p = null;
      try { p = script.url.startsWith('file:') ? fileURLToPath(script.url) : null; } catch (_) { p = null; }
      if (!p || (process.platform === 'win32' ? p.toLowerCase() : p) !== want) continue;
      seen = true;
      // Outer ranges first, so an inner range's count wins over its own.
      const ranges = (script.functions || []).flatMap((f) => f.ranges).sort((a, b) => (b.endOffset - b.startOffset) - (a.endOffset - a.startOffset));
      const proc = new Float64Array(text.length).fill(-1);
      for (const r of ranges) for (let i = Math.max(0, r.startOffset); i < Math.min(text.length, r.endOffset); i += 1) proc[i] = r.count;
      for (let i = 0; i < text.length; i += 1) all[i] = Math.max(all[i], proc[i]);
    }
  }
  return { seen, all };
}
// Per line (1-based index - 1): whether any of its characters ran.
function lineRuns(cov, text) {
  const lines = [];
  let start = 0;
  for (const line of text.split('\n')) {
    let ran = false;
    for (let i = 0; i < line.length && !ran; i += 1) if (!/\s/.test(line[i]) && cov.all[start + i] > 0) ran = true;
    lines.push(ran);
    start += line.length + 1;
  }
  return lines;
}

// The whole contract. `base` is main as the merge has it (the merge commit's
// first parent), `rev` the merge commit, checked out in `tree`.
function verify({ tree, base, rev = 'HEAD', task, policy }) {
  const reasons = [];
  const notes = [];
  const impl = (policy.templates[task.template] || {}).implementation;
  if (!impl) return { ok: false, reasons: [`no verification rule for ${task.template}`], notes };
  const changes = changesOf(tree, base, rev);
  if (!changes) return { ok: false, reasons: ['the merge tree\'s change could not be read'], notes };
  for (const c of changes) if (c.status === 'D' && TEST_RE.test(c.path)) reasons.push(`${c.path} is deleted: the lane never removes a test`);
  const implFiles = changes.filter((c) => c.status !== 'D' && P.matches(c.path, impl)).map((c) => c.path);
  const tests = [...new Set([...changes.filter((c) => c.status !== 'D' && TEST_RE.test(c.path)).map((c) => c.path), ...(task.tests || [])])].sort();
  if (!implFiles.length) {
    notes.push(`No implementation file of ${task.template} changed, so there is no behavior to verify here; the suite and the review still run.`);
    return { ok: reasons.length === 0, reasons, notes, tests, implFiles };
  }
  if (!tests.length) return { ok: false, reasons: [...reasons, 'no test is added, changed or named by the task'], notes, tests, implFiles };
  for (const t of tests) {
    const abs = path.join(tree, t);
    if (!fs.existsSync(abs)) { reasons.push(`${t} is not in the merge tree`); continue; }
    const why = lintTest(fs.readFileSync(abs, 'utf8'));
    if (why) reasons.push(`${t} ${why}`);
  }
  if (reasons.length) return { ok: false, reasons, notes, tests, implFiles };

  const covDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cov-'));
  try {
    const run = runTests(tree, tests, { coverageDir: covDir });
    if (!run.ok) return { ok: false, reasons: [`the named tests fail on the merge tree (exit ${run.code}${run.signal ? `, ${run.signal}` : ''}; ${run.failed ?? '?'} of ${run.tests ?? '?'} failed)`], notes, tests, implFiles, tail: run.tail };
    notes.push(`The named tests pass on the merge tree: ${run.passed ?? '?'} of ${run.tests ?? '?'} (${tests.join(', ')}).`);
    for (const f of implFiles) {
      const abs = path.resolve(tree, f);
      const text = fs.readFileSync(abs, 'utf8');
      const cov = coverageOf(covDir, abs, text);
      if (!cov.seen) { reasons.push(`${f} never loads while the named tests run`); continue; }
      const runs = lineRuns(cov, text);
      const src = text.split('\n');
      const code = [...changedLines(tree, base, rev, f)].filter((n) => src[n - 1] !== undefined && isCode(src[n - 1])).sort((a, b) => a - b);
      if (!code.length) { notes.push(`${f}: no changed line of code (comments or layout only).`); continue; }
      const missed = code.filter((n) => !runs[n - 1]);
      if (missed.length) reasons.push(`${f}: ${missed.length} of ${code.length} changed lines of code never run under the named tests (lines ${missed.slice(0, 20).join(', ')}${missed.length > 20 ? ', …' : ''})`);
      else notes.push(`${f}: all ${code.length} changed lines of code run under the named tests.`);
    }
  } finally {
    fs.rmSync(covDir, { recursive: true, force: true });
  }
  if (reasons.length) return { ok: false, reasons, notes, tests, implFiles };

  // 5. Revert evidence: each file as main has it, the rest as the change has it.
  for (const f of implFiles) {
    const abs = path.resolve(tree, f);
    const now = fs.readFileSync(abs);
    const before = git(tree, ['show', `${base}:${f}`]);
    try {
      if (before.status === 0) fs.writeFileSync(abs, before.raw); else fs.rmSync(abs);
      const r = runTests(tree, tests);
      if (r.ok) reasons.push(`with ${f} as main has it, every named test still passes: the tests do not depend on this change`);
      else notes.push(`With ${f} as main has it, ${r.failed ?? 'some'} named ${r.failed === 1 ? 'test fails' : 'tests fail'}: they depend on the change.`);
    } finally {
      fs.writeFileSync(abs, now);
    }
  }
  return { ok: reasons.length === 0, reasons, notes, tests, implFiles };
}

// --- CLI ---------------------------------------------------------------------
function main(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) flags[argv[i].replace(/^--/, '')] = argv[i + 1];
  const tree = path.resolve(flags.tree || '.');
  const summary = (text) => { if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n\n`); process.stdout.write(`${text}\n`); };
  const task = JSON.parse(fs.readFileSync(flags.task, 'utf8'));
  if (task.agent === false) { summary('Owner change: not an agent candidate, so the behavioral contract does not apply. The required tests still do.'); return 0; }
  if (!task.agent || !task.ok) { summary('### Not verified\n\n- agent-guard does not hold for this candidate; see its check.'); return 1; }
  const policy = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'agent-policy.json'), 'utf8'));
  const base = git(tree, ['rev-parse', '--verify', `${flags.rev || 'HEAD'}^1`]).out;
  const r = verify({ tree, base, rev: flags.rev || 'HEAD', task, policy });
  summary(`### ${r.ok ? 'Verified' : 'Not verified'} on the merge tree\n\n${[...r.reasons.map((x) => `- **${x}**`), ...r.notes.map((x) => `- ${x}`)].join('\n')}${r.tail ? `\n\n\`\`\`text\n${r.tail.replace(/```/g, "'''")}\n\`\`\`` : ''}`);
  return r.ok ? 0 : 1;
}

if (require.main === module) { try { process.exitCode = main(process.argv.slice(2)); } catch (err) { process.stderr.write(`agent-verify: ${String((err && err.message) || err).slice(0, 400)}\n`); process.exitCode = 1; } }

module.exports = { changesOf, changedLines, isCode, stripComments, assertionArgs, meaningful, lintTest, runTests, coverageOf, lineRuns, verify, main };
