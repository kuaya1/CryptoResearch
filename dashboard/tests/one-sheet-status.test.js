'use strict';
// Audit F11 (audit-blueprint-implementation-2026-11-02.md, row 1): the sheet
// said four boxes were "Not on `main` yet" after Eric had merged all four.
// The sheet keeps merged, proposed, deployed and operating apart, never calls
// a merged pull request unmerged, and never claims a deployment or operation
// it has not read back. Reads the repository's own files only; no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SHEET = fs.readFileSync(path.join(ROOT, 'docs', 'ONE-SHEET.md'), 'utf8');

// The bullet list under "Merged on `main`", up to the next top-level bullet.
function mergedBlock() {
  const at = SHEET.indexOf('- **Merged on `main`**');
  assert.ok(at >= 0, 'the sheet has a "Merged on `main`" list');
  const rest = SHEET.slice(at + 1);
  const end = rest.search(/\n- \*\*/);
  return end < 0 ? rest : rest.slice(0, end);
}
const mergedPairs = () => [...mergedBlock().matchAll(/#(\d+) `([0-9a-f]{7,40})`/g)].map((m) => ({ pr: Number(m[1]), sha: m[2] }));

test('the four states are said apart: merged, proposed, deployed not verified, no operating proof', () => {
  for (const head of ['- **Merged on `main`**', '- **Proposed**', '- **Deployed: not verified.**', '- **Operating proof: none yet.**']) {
    assert.ok(SHEET.includes(head), `the sheet says ${head}`);
  }
  assert.match(SHEET, /Merged is not deployed, and deployed is not operating\./);
  assert.match(SHEET, /proposals, not Eric's answers/, 'the blueprint defaults are not his approval');
  assert.match(SHEET, /PR #134, closed unmerged/, 'the blueprint it draws from is named as a proposal');
});

test('no pull request the sheet lists as merged is also called not on main or waiting on a merge', () => {
  const pairs = mergedPairs();
  assert.ok(pairs.length >= 4, 'merged pull requests are listed with their merge commit');
  // The section that was false (as of 3d791a5, docs/ONE-SHEET.md:41-49).
  assert.doesNotMatch(SHEET, /Not on `main` yet/);
  assert.doesNotMatch(SHEET, /waits on Eric's merge/);
  const proposed = SHEET.slice(SHEET.indexOf('- **Proposed**')).split('\n')[0];
  for (const { pr } of pairs) assert.ok(!new RegExp(`#${pr}\\b`).test(proposed), `#${pr} is listed as merged and not also as proposed`);
});

test('each merge commit the sheet names is on this checkout\'s history (a full clone; skipped on a shallow one)', (t) => {
  let shallow;
  try {
    shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: ROOT, encoding: 'utf8' }).trim() === 'true';
  } catch (_) {
    t.skip('not a Git checkout');
    return;
  }
  if (shallow) {
    t.skip('shallow clone: the merge commits are not in its history');
    return;
  }
  for (const { pr, sha } of mergedPairs()) {
    let ok = true;
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: ROOT, stdio: 'ignore' });
    } catch (_) { ok = false; }
    assert.ok(ok, `#${pr} ${sha} is an ancestor of HEAD`);
  }
});
