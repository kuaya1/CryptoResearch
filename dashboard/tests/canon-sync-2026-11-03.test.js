'use strict';
// Blueprint 2026-11-03 §4 PR 3 (A7, E6, C12, C14; Eric's correction 3): the
// desk's own words and the canon say what Eric ratified on 2026-11-03. A
// ticket's decision can come from Eric or from the paper mandate he armed;
// no rate shows before 50 closed positions in a group (Q3); the 2026-11-02
// decision list is superseded; and the runbook says only what each step
// proves. Reads the repository's own files and one CLI help text; no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

test('the CLI help says the paper mandate can decide too, and that orders are paper only', () => {
  const help = execFileSync(process.execPath, [path.join(ROOT, 'dashboard', 'cli.js'), 'help'], { encoding: 'utf8', env: { ...process.env, CR_WORKSPACE: '' } });
  assert.match(help, /PM trade tickets \(Claude researches, Claude prosecutes; the desk sizes; you decide, or the paper mandate grants inside a generation you armed; paper orders only, never a real one\)/);
  assert.doesNotMatch(help, /you decide; no order is ever placed/);
});

test('the no-rate sentence states the Q3 floor and the unrecorded execution policy', () => {
  const V = require('../core/grade-outcome-view');
  assert.equal(V.NO_RATE, 'No rate is shown before 50 closed positions in a group (Q3, 2026-11-03), and none while the execution policy is not recorded. Counts and rows only.');
  assert.doesNotMatch(V.NO_RATE, /until Eric sets/);
});

test('DESK_STATE is dated 2026-11-03, registers the task from the runner worktree with a pinned model, and names the Q5 candidate rule', () => {
  const s = read('DESK_STATE.md');
  assert.match(s.split('\n')[2], /^Last updated 2026-11-03\./);
  assert.match(s, /3\. \*\*Windows task\*\*, from the clean runner worktree[^\n]*CryptoResearch-runner\\dashboard\\scripts\\pilot-task\.ps1" -Register -MaxAgents 1 -Model <id>`/);
  assert.match(s, /\*\*The candidate \(Q5, 2026-11-03\)\.\*\*[^\n]*CG-21\/CG-23[^\n]*clean-contract candidate[^\n]*stored chain, contract and CoinGecko ID, never by ticker/);
  assert.doesNotMatch(s, /Numeraire is the owner-selected candidate/);
});

test('the 2026-11-02 decision list opens with its superseded banner and keeps its body', () => {
  const s = read('docs', 'engineering', 'OWNER_DECISIONS_2026-11-02.md');
  const lines = s.split('\n');
  assert.equal(lines[0], "# Eric's open decisions (2026-11-02)");
  assert.equal(lines[2], "**Superseded on 2026-11-03 by `AUTONOMY_COMPLETION_BLUEPRINT_2026-11-03.md` §3, Eric's ratified answers.** The text below is kept as history.");
  assert.match(s, /A proposal for Eric to answer, edit or close\./, 'the body stays as history');
});

test('the blueprint\'s runbook says only what each step proves (correction 3)', () => {
  const b = read('docs', 'engineering', 'AUTONOMY_COMPLETION_BLUEPRINT_2026-11-03.md');
  // R0.5: doctor reports no Git revision; the revision is read with git.
  assert.doesNotMatch(b, /Doctor must name `Documents\\CryptoResearch` as the workspace and the runner's `main` revision/);
  assert.match(b, /Doctor does not report a Git revision/);
  assert.match(b, /git -C "\$HOME\\Documents\\CryptoResearch-runner" rev-parse HEAD/);
  // B0.3 / B0.4: a dry run proves the guard and the GET poll only.
  assert.doesNotMatch(b, /This proves the poll token, PR 1's guard, the `POST` sighting and the heartbeat/);
  assert.match(b, /This proves PR 1's revision guard and the `GET` poll with the poll token, and nothing more\. `--dry-run` sends no worker `POST` sighting and no Healthchecks ping/);
  assert.match(b, /the first `POST` sighting \(Desk Controls poll `Fresh`\), come from B1's run, the first invocation without `--dry-run`/);
  // B2.4: the attribution view's real label, and the per-record check by the CLI.
  assert.doesNotMatch(b, /basis state `frozen`/);
  assert.match(b, /`inputs\.label === 'decision_time'`/);
  assert.match(b, /node dashboard\/cli\.js tickets basis <project_id> <decision_id> --json/);
  // Rule (b) of the sheet's self-entry check uses --first-parent.
  assert.match(b, /git log -1 --merges --first-parent --format=%s -- docs\/ONE-SHEET\.md/);
});

test('the words the runbook names are the code\'s own: decision_time, the basis CLI, and a dry run with no POST sighting or ping', () => {
  assert.match(read('dashboard', 'core', 'decision-basis.js'), /label: 'decision_time', digest: 'verified'/);
  assert.match(read('dashboard', 'core', 'grade-outcome-view.js'), /r\.inputs\.label === 'decision_time'/);
  assert.match(read('dashboard', 'cli.js'), /tickets basis <id> <decision_id> \[--json\]/);
  const pilot = read('dashboard', 'scripts', 'pilot.js');
  assert.match(pilot, /const hb = o\.dryRun \? \{ base: null, words: null \} : heartbeatBase\(env\);/);
  assert.match(pilot, /const production = o\.desk === 'online' && Boolean\(o\.unattended\) && !o\.dryRun;/);
});
