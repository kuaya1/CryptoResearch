#!/usr/bin/env node
'use strict';
// The merge train (backlog item 12):
//
//   npm run train                 merge the waiting backlog branches locally
//   npm run train -- --push       ...and push claude/train-<date>
//   npm run train -- --tick-main  tick the checkboxes of items already on main
//                                 (see tickMain; --push sends claude/tick-<date>)
//
// From origin/main it merges each waiting origin/claude/backlog-* branch (one
// not yet merged into main) onto claude/train-<YYYY-MM-DD>: a stacked branch
// after the branch it stands on, otherwise by its lowest item number. A
// conflict only under dashboard/public/app/ or in DESK_STATE.md takes main's
// side (the train's own); the bundle is then rebuilt once. Any other conflict
// stops the train and names the branch and files. The merged items are ticked
// in DESK_STATE.md, the whole suite runs, and what was merged and skipped is
// printed with the counts. It pushes only with --push, only the train branch,
// and never touches main.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const BUNDLE_PREFIX = 'dashboard/public/app/';
const STATE_FILE = 'DESK_STATE.md';

function run(cwd, cmd, args, { allowFail = false, env = {} } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'merge-train', GIT_AUTHOR_EMAIL: 'merge-train@localhost', GIT_COMMITTER_NAME: 'merge-train', GIT_COMMITTER_EMAIL: 'merge-train@localhost', ...env }, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim().slice(0, 600)}`);
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
const git = (cwd, args, opts) => run(cwd, 'git', args, opts);

const isBundle = (f) => f.startsWith(BUNDLE_PREFIX) || f === STATE_FILE;

// The waiting branches with the items their own commits carry.
function waiting(cwd) {
  const merged = new Set(git(cwd, ['branch', '-r', '--merged', 'origin/main', '--list', 'origin/claude/backlog-*']).out.split('\n').map((s) => s.trim()).filter(Boolean));
  const all = git(cwd, ['branch', '-r', '--list', 'origin/claude/backlog-*']).out.split('\n').map((s) => s.trim()).filter(Boolean);
  const rows = all.filter((b) => !merged.has(b)).map((ref) => {
    const body = git(cwd, ['log', `origin/main..${ref}`, '--format=%B']).out;
    const items = [...body.matchAll(/^Backlog-Item:\s*(\d+)\s*$/gm)].map((m) => Number(m[1]));
    return { ref, branch: ref.replace(/^origin\//, ''), items: [...new Set(items)].sort((a, b) => a - b) };
  });
  const isAncestor = (a, b) => git(cwd, ['merge-base', '--is-ancestor', a, b], { allowFail: true }).status === 0;
  // A branch stood on another comes after it; otherwise lowest item first.
  const out = [];
  const rest = [...rows].sort((a, b) => (a.items[0] ?? Infinity) - (b.items[0] ?? Infinity) || a.ref.localeCompare(b.ref));
  while (rest.length) {
    const i = rest.findIndex((c) => !rest.some((o) => o !== c && isAncestor(o.ref, c.ref) && !isAncestor(c.ref, o.ref)));
    out.push(rest.splice(i === -1 ? 0 : i, 1)[0]);
  }
  return out;
}

function tick(cwd, items) {
  const file = path.join(cwd, STATE_FILE);
  if (!fs.existsSync(file) || !items.length) return [];
  let text = fs.readFileSync(file, 'utf8');
  const ticked = [];
  for (const n of items) {
    const re = new RegExp(`^(\\s*- )\\[ \\]( (?:\\*\\([^)]*\\)\\* )?\\*\\*${n}\\.)`, 'm');
    if (re.test(text)) { text = text.replace(re, '$1[x]$2'); ticked.push(n); }
  }
  if (ticked.length) fs.writeFileSync(file, text);
  return ticked;
}

// The items main carries by trailer (`Backlog-Item: <n>`) whose checkbox is
// still open in DESK_STATE.md on main, in item order. Reads git only.
function untickedOnMain(cwd) {
  const state = git(cwd, ['show', `origin/main:${STATE_FILE}`], { allowFail: true });
  if (state.status !== 0) throw new Error(`origin/main has no ${STATE_FILE}.`);
  const body = git(cwd, ['log', 'origin/main', '--format=%B']).out;
  const items = [...new Set([...body.matchAll(/^Backlog-Item:\s*(\d+)\s*$/gm)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  return items.filter((n) => new RegExp(`^\\s*- \\[ \\] (?:\\*\\([^)]*\\)\\* )?\\*\\*${n}\\.`, 'm').test(state.out));
}

// Tick step for merged backlog branches (item 35): the items main carries by
// trailer and DESK_STATE.md still shows open are ticked on claude/tick-<date>,
// one commit that changes nothing but those checkboxes. Nothing to tick
// changes nothing and creates no branch, so no empty PR follows. Never touches
// main; pushes only the tick branch, and only with push.
function tickMain(cwd, { date = new Date().toISOString().slice(0, 10), push = false } = {}) {
  const result = { branch: `claude/tick-${date}`, ticked: [], pushed: false, message: null };
  git(cwd, ['fetch', 'origin', '--prune']);
  if (git(cwd, ['status', '--porcelain']).out) throw new Error('The working tree is not clean; commit or stash first.');
  const open = untickedOnMain(cwd);
  if (!open.length) { result.branch = null; result.message = 'Nothing to tick.'; return result; }
  git(cwd, ['checkout', '-q', '-B', result.branch, 'origin/main']);
  result.ticked = tick(cwd, open);
  if (!result.ticked.length) { git(cwd, ['checkout', '-q', 'origin/main']); result.branch = null; result.message = 'Nothing to tick.'; return result; }
  // Only checkboxes: every changed line is a `[ ]` that became `[x]`.
  const changed = git(cwd, ['diff', '-U0', '--', STATE_FILE]).out.split('\n').filter((l) => /^[+-]/.test(l) && !/^(---|\+\+\+) /.test(l));
  const minus = changed.filter((l) => l[0] === '-').map((l) => l.slice(1).replace('[ ]', '[x]'));
  const plus = changed.filter((l) => l[0] === '+').map((l) => l.slice(1));
  if (!minus.length || minus.length !== plus.length || minus.some((l, i) => l !== plus[i])) {
    git(cwd, ['checkout', '-q', '--', STATE_FILE]);
    throw new Error(`The tick would change more than checkboxes in ${STATE_FILE}; nothing was committed.`);
  }
  git(cwd, ['add', '--', STATE_FILE]);
  git(cwd, ['commit', '-q', '-m', `train: tick items ${result.ticked.join(', ')}`]);
  if (push) { git(cwd, ['push', '-u', 'origin', result.branch]); result.pushed = true; }
  return result;
}

function counts(out) {
  const pick = (k) => { const m = new RegExp(`^# ${k} (\\d+)`, 'm').exec(out); return m ? Number(m[1]) : null; };
  return { tests: pick('tests'), pass: pick('pass'), fail: pick('fail') };
}

// build and test are injectable so a fixture can run without npm.
function train(cwd, { date = new Date().toISOString().slice(0, 10), push = false, build = null, test = null } = {}) {
  const doBuild = build || (() => { run(path.join(cwd, 'dashboard', 'web'), 'npm', ['ci']); run(path.join(cwd, 'dashboard', 'web'), 'npm', ['run', 'build']); });
  const doTest = test || (() => { const r = run(cwd, 'node', ['dashboard/cli.js', 'test'], { allowFail: true }); return { ok: r.status === 0, ...counts(`${r.out}\n${r.err}`) }; });
  const result = { branch: `claude/train-${date}`, merged: [], skipped: [], resolved_bundle: [], stopped: null, items_ticked: [], rebuilt: false, tests: null, pushed: false };
  git(cwd, ['fetch', 'origin', '--prune']);
  const list = waiting(cwd);
  if (!list.length) { result.message = 'No waiting backlog branch.'; return result; }
  git(cwd, ['checkout', '-q', '-B', result.branch, 'origin/main']);
  let touchedUi = false;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    const m = git(cwd, ['merge', '--no-ff', '--no-edit', '-m', `Merge ${b.branch} (items ${b.items.join(', ') || 'unnumbered'})`, b.ref], { allowFail: true });
    if (m.status !== 0) {
      const files = git(cwd, ['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean);
      if (files.length && files.every(isBundle)) {
        for (const f of files) { git(cwd, ['checkout', '--ours', '--', f]); git(cwd, ['add', '--', f]); }
        git(cwd, ['commit', '--no-edit', '-q']);
        result.resolved_bundle.push({ branch: b.branch, files });
        touchedUi = true;
      } else {
        git(cwd, ['merge', '--abort'], { allowFail: true });
        result.stopped = { branch: b.branch, files: files.length ? files : null, message: `Conflict outside the bundle and DESK_STATE.md${files.length ? `: ${files.join(', ')}` : ''}.` };
        result.skipped.push(...list.slice(i).map((x) => ({ branch: x.branch, items: x.items, why: x === b ? 'conflict' : 'not tried after the conflict' })));
        break;
      }
    }
    result.merged.push({ branch: b.branch, items: b.items });
  }
  if (!result.merged.length) { result.message = 'Nothing merged.'; return result; }
  const changed = git(cwd, ['diff', '--name-only', 'origin/main', 'HEAD']).out.split('\n');
  if (touchedUi || changed.some((f) => f.startsWith('dashboard/web/') || f.startsWith(BUNDLE_PREFIX))) {
    doBuild();
    git(cwd, ['add', '-A', '--', BUNDLE_PREFIX]);
    if (git(cwd, ['status', '--porcelain']).out) git(cwd, ['commit', '-q', '-m', 'train: rebuild the bundle once']);
    result.rebuilt = true;
  }
  result.items_ticked = tick(cwd, result.merged.flatMap((x) => x.items));
  if (result.items_ticked.length) {
    git(cwd, ['add', '--', STATE_FILE]);
    git(cwd, ['commit', '-q', '-m', `train: tick items ${result.items_ticked.join(', ')}`]);
  }
  result.tests = doTest();
  if (push) {
    if (result.stopped || !result.tests || result.tests.ok === false) result.message = 'Not pushed: the train stopped or the suite is not green.';
    else { git(cwd, ['push', '-u', 'origin', result.branch]); result.pushed = true; }
  }
  return result;
}

function print(r) {
  const w = (s) => process.stdout.write(`${s}\n`);
  w(`Train ${r.branch}`);
  for (const m of r.merged) w(`  merged ${m.branch} (items ${m.items.join(', ') || '—'})`);
  for (const s of r.skipped) w(`  skipped ${s.branch}: ${s.why}`);
  for (const x of r.resolved_bundle) w(`  bundle/state conflict taken from main in ${x.branch}: ${x.files.join(', ')}`);
  if (r.stopped) w(`  STOPPED at ${r.stopped.branch}: ${r.stopped.message}`);
  if (r.rebuilt) w('  bundle rebuilt once');
  if (r.items_ticked.length) w(`  ticked: ${r.items_ticked.join(', ')}`);
  if (r.tests) w(`  tests: ${r.tests.tests ?? '?'} run, ${r.tests.pass ?? '?'} passed, ${r.tests.fail ?? '?'} failed`);
  w(r.pushed ? `  pushed ${r.branch}` : `  not pushed${r.message ? ` (${r.message})` : ''}`);
  if (r.message && !r.pushed && !r.merged.length) w(`  ${r.message}`);
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--tick-main')) {
      const t = tickMain(ROOT, { push: args.includes('--push') });
      process.stdout.write(t.ticked.length ? `Ticked ${t.ticked.join(', ')} on ${t.branch}${t.pushed ? ' (pushed)' : ' (not pushed)'}\n` : `${t.message}\n`);
    } else {
      const r = train(ROOT, { push: args.includes('--push') });
      print(r);
      if (r.stopped || (r.tests && r.tests.ok === false)) process.exitCode = 1;
    }
  } catch (err) {
    process.stderr.write(`train: ${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { train, waiting, tick, tickMain, untickedOnMain, counts };
