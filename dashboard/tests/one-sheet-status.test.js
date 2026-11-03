'use strict';
// Audit F11 (audit-blueprint-implementation-2026-11-02.md, row 1): the sheet
// said four boxes were "Not on `main` yet" after Eric had merged all four.
// The sheet keeps merged, proposed, deployed and operating apart, never calls
// a merged pull request unmerged, and never claims a deployment or operation
// it has not read back. Reads the repository's own files only; no network.
//
// Blueprint 2026-11-03 §4 PR 3 (A7, E6, C12, C14; Eric's correction 3): the
// sheet names the host of every part, deployed is the `/healthz` revision
// read at a stated time, every Proposed item names a pull request or says it
// has none, and a Merged entry may go without its SHA only as
// "#N (this pull request)" while #N is unmerged or is the latest merge that
// touched the sheet.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SHEET = fs.readFileSync(path.join(ROOT, 'docs', 'ONE-SHEET.md'), 'utf8');

// The bullet list under "Merged on `main`", up to the next top-level bullet.
function mergedBlockOf(sheet) {
  const at = sheet.indexOf('- **Merged on `main`**');
  assert.ok(at >= 0, 'the sheet has a "Merged on `main`" list');
  const rest = sheet.slice(at + 1);
  const end = rest.search(/\n- \*\*/);
  return end < 0 ? rest : rest.slice(0, end);
}
const mergedBlock = () => mergedBlockOf(SHEET);
const mergedPairs = () => [...mergedBlock().matchAll(/#(\d+) `([0-9a-f]{7,40})`/g)].map((m) => ({ pr: Number(m[1]), sha: m[2] }));
const proposedLine = (sheet = SHEET) => sheet.slice(sheet.indexOf('- **Proposed**')).split('\n')[0];

// Every "#N" in the Merged list is "#N `<sha>`" or "#N (this pull request)".
// A self-entry is allowed only while #N has no merge commit in HEAD's history
// (its own branch, before the merge) or #N is the latest merge that touched
// the sheet (main, just after the merge). Anything else is an older entry
// left without its SHA: the next sheet edit backfills it.
function selfEntryProblems(block, { merged, latestSheetMerge }) {
  const problems = [];
  const self = [];
  for (const m of block.matchAll(/#(\d+)(?!\d)(?! `[0-9a-f]{7,40}`)/g)) {
    const n = Number(m[1]);
    if (!block.startsWith(' (this pull request)', m.index + m[0].length)) problems.push(`#${n} is listed as merged with neither its merge commit nor "(this pull request)"`);
    else self.push(n);
  }
  if (self.length > 1) problems.push(`more than one entry says "(this pull request)": ${self.map((n) => `#${n}`).join(', ')}`);
  if (merged) {
    for (const n of self) {
      if (merged.has(n) && n !== latestSheetMerge) problems.push(`#${n} is merged and is not the latest merge that touched the sheet, so it needs its merge commit`);
    }
  }
  return problems;
}

// Each item on the Proposed line names a pull request ("#N") or says
// "no pull request", so the history check below can see every item.
function proposedProblems(line) {
  const colon = line.indexOf(':');
  assert.ok(colon >= 0, 'the Proposed line lists its items after a colon');
  const items = line.slice(colon + 1).replace(/\.\s*$/, '').split(';').map((s) => s.trim()).filter(Boolean);
  assert.ok(items.length > 0, 'the Proposed line lists items');
  return items.filter((item) => !/#\d+\b/.test(item) && !/\bno pull request\b/.test(item));
}

function gitHistory(t) {
  let shallow;
  try {
    shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: ROOT, encoding: 'utf8' }).trim() === 'true';
  } catch (_) {
    t.skip('not a Git checkout');
    return null;
  }
  if (shallow) {
    t.skip('shallow clone: the merge commits are not in its history');
    return null;
  }
  const prOf = (s) => { const m = /^Merge pull request #(\d+) /.exec(s); return m ? Number(m[1]) : null; };
  const merged = new Set(execFileSync('git', ['log', '--merges', '--format=%s', 'HEAD'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').map(prOf).filter((n) => n !== null));
  // --first-parent: without it, history simplification drops the merge
  // commits that touched the sheet and this prints nothing (correction 3).
  const latest = execFileSync('git', ['log', '-1', '--merges', '--first-parent', '--format=%s', 'HEAD', '--', 'docs/ONE-SHEET.md'], { cwd: ROOT, encoding: 'utf8' }).trim();
  return { merged, latestSheetMerge: prOf(latest) };
}

test('the four states are said apart: merged, proposed, deployed by /healthz readback, no operating proof', () => {
  for (const head of ['- **Merged on `main`**', '- **Proposed**', '- **Deployed: the `/healthz` revision, read at a stated time.**', '- **Operating proof: none yet.**']) {
    assert.ok(SHEET.includes(head), `the sheet says ${head}`);
  }
  assert.match(SHEET, /Merged is not deployed, and deployed is not operating\./);
  assert.match(SHEET, /PR #134, closed unmerged/, 'the blueprint it draws from is named as a proposal');
  assert.doesNotMatch(SHEET, /Deployed: not verified/);
  const deployed = SHEET.slice(SHEET.indexOf('- **Deployed:')).split('\n')[0];
  assert.match(deployed, /Last read: `[0-9a-f]{7,40}`/, 'the deployed line names the revision it read');
  assert.match(deployed, /at \d{2}:\d{2}Z on \d{4}-\d{2}-\d{2}/, 'and the time it read it');
});

test('the host legend names one line per host', () => {
  const at = SHEET.indexOf('### Where each part runs');
  assert.ok(at >= 0 && at < SHEET.indexOf('## What the sheet says'), 'the legend sits under the diagram');
  const legend = SHEET.slice(at, SHEET.indexOf('## What the sheet says'));
  for (const [host, says] of [
    ['GitHub Actions', /11:30 UTC[\s\S]*`test` check/],
    ['Render desk', /30-minute timer: snapshot, reviews, backup, fundamentals, screening, forensics, trader, leads[\s\S]*2-minute research tick/],
    ['Runner host', /B0–B3[\s\S]*Ops-1[\s\S]*One at a time[\s\S]*Q1/],
    ['PC offsite backup', /\\CryptoResearch\\Hourly[\s\S]*only copy[\s\S]*off Render/],
  ]) {
    const row = legend.split('\n').find((l) => l.startsWith(`| **${host}** |`));
    assert.ok(row, `a row for ${host}`);
    assert.match(row, says, host);
  }
  // The timer's jobs are the code's own list.
  const { HOSTED_TIMER_JOBS } = require('../core/jobs');
  assert.match(legend, new RegExp(`30-minute timer: ${HOSTED_TIMER_JOBS.join(', ')} `));
});

test('the sheet names the Q1 exception and says the owner questions are answered by the 2026-11-03 blueprint', () => {
  assert.match(SHEET, /\*\*The one accepted exception \(Q1\)\.\*\*[^\n]*`reconcile` \(exit 3\)[^\n]*Eric reconciles it by hand/);
  assert.match(SHEET, /\*\*Owner questions: answered\.\*\*[^\n]*AUTONOMY_COMPLETION_BLUEPRINT_2026-11-03\.md/);
  assert.ok(fs.existsSync(path.join(ROOT, 'docs', 'engineering', 'AUTONOMY_COMPLETION_BLUEPRINT_2026-11-03.md')));
  assert.doesNotMatch(SHEET, /proposals, not Eric's answers/, 'Q1–Q5 are no longer called open proposals');
});

test('no pull request the sheet lists as merged is also called not on main or waiting on a merge', () => {
  const pairs = mergedPairs();
  assert.ok(pairs.length >= 4, 'merged pull requests are listed with their merge commit');
  // The section that was false (as of 3d791a5, docs/ONE-SHEET.md:41-49).
  assert.doesNotMatch(SHEET, /Not on `main` yet/);
  assert.doesNotMatch(SHEET, /waits on Eric's merge/);
  const proposed = proposedLine();
  for (const { pr } of pairs) assert.ok(!new RegExp(`#${pr}\\b`).test(proposed), `#${pr} is listed as merged and not also as proposed`);
});

test('every item on the Proposed line names a pull request or says "no pull request" (a bare label is refused)', () => {
  assert.deepEqual(proposedProblems(proposedLine()), []);
  // FICTIONAL lines: the 2026-11-02 sheet's bare "N4 … on its own pull request" fails.
  assert.deepEqual(proposedProblems('- **Proposed** (x): hardening N4 (N7), on its own pull request; the blueprint (#134, closed unmerged).'), ['hardening N4 (N7), on its own pull request']);
  assert.deepEqual(proposedProblems('- **Proposed** (x): Ops-1 (no pull request yet); the blueprint (#134).'), []);
});

test('the self-entry rule: "#N (this pull request)" only while #N is unmerged or is the latest merge that touched the sheet (FICTIONAL histories)', () => {
  const block = '- **Merged on `main`**:\n  - one, #10 `abcdef1`;\n  - this sheet, #12 (this pull request).';
  // (a) its own branch, before the merge.
  assert.deepEqual(selfEntryProblems(block, { merged: new Set([10]), latestSheetMerge: 10 }), []);
  // (b) main, just after the merge.
  assert.deepEqual(selfEntryProblems(block, { merged: new Set([10, 12]), latestSheetMerge: 12 }), []);
  // An older self-entry left without its SHA after a later sheet merge fails.
  assert.equal(selfEntryProblems(block, { merged: new Set([10, 12, 13]), latestSheetMerge: 13 }).length, 1);
  // A bare "#N" in the list, or two self-entries, fail on any history.
  assert.equal(selfEntryProblems('- **Merged on `main`**:\n  - one, #10;', { merged: null }).length, 1);
  assert.equal(selfEntryProblems('- **Merged on `main`**:\n  - #11 (this pull request); #12 (this pull request).', { merged: null }).length, 1);
  // The sheet itself, with no history: shapes only.
  assert.deepEqual(selfEntryProblems(mergedBlock(), { merged: null }), []);
});

test('the sheet\'s own self-entry holds against this checkout\'s history (a full clone; skipped on a shallow one)', (t) => {
  const h = gitHistory(t);
  if (!h) return;
  assert.deepEqual(selfEntryProblems(mergedBlock(), h), []);
});

// N7 (post-remediation audit, 2026-11-02): the Proposed line still named
// #153, #154, #155 and #157 after Eric had merged them. The test above only
// sees pull requests the sheet lists with a merge commit, so a merged one left
// on the Proposed line passed. Every pull request the Proposed line names is
// checked against this checkout's own merge commits ("Merge pull request #N").
test('no pull request on the Proposed line has a merge commit on this checkout\'s history (a full clone; skipped on a shallow one)', (t) => {
  const h = gitHistory(t);
  if (!h) return;
  const { merged } = h;
  assert.ok(merged.size > 0, 'the history has merged pull requests');
  const named = [...proposedLine().matchAll(/#(\d+)\b/g)].map((m) => Number(m[1]));
  const wrong = named.filter((n) => merged.has(n));
  assert.deepEqual(wrong, [], `listed as proposed but merged on main: ${wrong.map((n) => `#${n}`).join(', ')}`);
  for (const n of [153, 154, 155, 156, 157, 161, 162, 163, 164]) if (merged.has(n)) assert.match(mergedBlock(), new RegExp(`#${n} \``), `#${n} is merged, so the sheet lists it as merged with its merge commit`);
});

test('each merge commit the sheet names is on this checkout\'s history (a full clone; skipped on a shallow one)', (t) => {
  if (!gitHistory(t)) return;
  for (const { pr, sha } of mergedPairs()) {
    let ok = true;
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: ROOT, stdio: 'ignore' });
    } catch (_) { ok = false; }
    assert.ok(ok, `#${pr} ${sha} is an ancestor of HEAD`);
  }
});
