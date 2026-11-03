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

// N7 (post-remediation audit, 2026-11-02): the Proposed line still named
// #153, #154, #155 and #157 after Eric had merged them. The test above only
// sees pull requests the sheet lists with a merge commit, so a merged one left
// on the Proposed line passed. Every pull request the Proposed line names is
// checked against this checkout's own merge commits ("Merge pull request #N").
test('no pull request on the Proposed line has a merge commit on this checkout\'s history (a full clone; skipped on a shallow one)', (t) => {
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
  const merged = new Set(execFileSync('git', ['log', '--merges', '--format=%s', 'HEAD'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').map((s) => /^Merge pull request #(\d+) /.exec(s)).filter(Boolean).map((m) => Number(m[1])));
  assert.ok(merged.size > 0, 'the history has merged pull requests');
  const proposed = SHEET.slice(SHEET.indexOf('- **Proposed**')).split('\n')[0];
  const named = [...proposed.matchAll(/#(\d+)\b/g)].map((m) => Number(m[1]));
  const wrong = named.filter((n) => merged.has(n));
  assert.deepEqual(wrong, [], `listed as proposed but merged on main: ${wrong.map((n) => `#${n}`).join(', ')}`);
  for (const n of [153, 154, 155, 156, 157]) if (merged.has(n)) assert.match(mergedBlock(), new RegExp(`#${n} \``), `#${n} is merged, so the sheet lists it as merged with its merge commit`);
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
