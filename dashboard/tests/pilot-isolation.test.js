'use strict';
// Practical role isolation for the local pilot (cr-pilot-isolation@1; the
// cohesion audit's M5 and brief 4, 2026-10-29). The role guard keeps each
// sub-agent's scratch in its own folder, <temp>/cr-pilot/<role>/, and closes
// Read, Grep and Glob over the desk's records, the other role's scratch, any
// other temporary folder and Claude Code's session transcripts. Files and
// folders here are temporary; nothing starts Claude Code or a connector.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const GUARD = path.join(ROOT, 'dashboard', 'scripts', 'pilot-role-guard.js');
const { decide, RECORDS, ISOLATION_VERSION, scratchOf } = require('../scripts/pilot-role-guard');

const TMP = os.tmpdir();
const HOME = os.homedir();
const read = (file_path, cwd = ROOT) => ({ tool_name: 'Read', tool_input: { file_path }, cwd });
const grep = (p, cwd = ROOT, glob) => ({ tool_name: 'Grep', tool_input: { pattern: 'grade', ...(p ? { path: p } : {}), ...(glob ? { glob } : {}) }, cwd });
const globT = (pattern, p, cwd = ROOT) => ({ tool_name: 'Glob', tool_input: { pattern, ...(p ? { path: p } : {}) }, cwd });
const write = (file_path) => ({ tool_name: 'Write', tool_input: { file_path, content: 'x' }, cwd: ROOT });
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command }, cwd: ROOT });
const other = { researcher: 'prosecutor', prosecutor: 'researcher' };
const yes = (role, input, opts) => assert.equal(decide(role, input, opts).allow, true, `${role} may: ${JSON.stringify(input.tool_input)}`);
const no = (role, input, why, opts) => {
  const d = decide(role, input, opts);
  assert.equal(d.allow, false, `${role} may not: ${JSON.stringify(input.tool_input)}`);
  if (why) assert.match(d.reason, why);
};

test('M5: each role reads its instructions and its own scratch, never the desk\'s records, the other role\'s scratch or session transcripts', () => {
  assert.equal(ISOLATION_VERSION, 'cr-pilot-isolation@1');
  for (const role of ['researcher', 'prosecutor']) {
    const mine = scratchOf(TMP, role);
    const theirs = scratchOf(TMP, other[role]);
    yes(role, read(path.join(ROOT, 'CLAUDE.md')));
    yes(role, read('COWORK-INSTRUCTIONS.md'));
    yes(role, read(path.join(ROOT, 'templates', 'README.md')));
    yes(role, read(path.join(mine, 'run-1', 'notes.md')));
    // The other role's drafts and files, wherever they are.
    no(role, read(path.join(theirs, 'run-1', 'draft.md')), /only this role's own scratch/);
    no(role, read(path.join(TMP, 'cr-pilot-old', 'agent1-report.md')), /only this role's own scratch/);
    no(role, read(path.join(TMP, 'claude', 'session', 'scratchpad', 'x.md')), /only this role's own scratch/);
    no(role, read(path.join(HOME, '.claude', 'projects', 'x', 'session.jsonl')), /transcripts/);
    // Every record folder: drafts, tickets, other models' reports, receipts.
    for (const d of RECORDS) no(role, read(path.join(ROOT, d, 'x', 'y.json')), new RegExp(`records \\(${d.replace('.', '\\.')}/\\)`));
    no(role, read('projects/example/tickets/tk_1/draft.md'), /records/);
    no(role, read(path.join(ROOT, 'projects')), /records/);
    no(role, read(''), /needs a file path/);
  }
});

test('M5: a search may not start at or above a closed folder, and a Glob pattern stays under where it starts', () => {
  for (const role of ['researcher', 'prosecutor']) {
    const mine = scratchOf(TMP, role);
    no(role, grep(null), /search may not start above a closed folder/);
    no(role, grep(ROOT), /search may not start above a closed folder/);
    no(role, globT('**/*.md', null), /search may not start above a closed folder/);
    no(role, grep(HOME), /closed folder|temporary folder/);
    no(role, grep(TMP), /temporary folder/);
    no(role, grep(path.join(TMP, 'cr-pilot')), /only this role's own scratch/);
    no(role, grep(path.join(ROOT, 'projects', 'x')), /records/);
    yes(role, grep(path.join(ROOT, 'templates')));
    yes(role, grep('docs'));
    yes(role, grep(mine));
    yes(role, globT('**/*.md', path.join(ROOT, 'templates')));
    no(role, globT('../projects/**', path.join(ROOT, 'templates')), /no "\.\."/);
    no(role, globT('C:/Users/**', path.join(ROOT, 'templates')), /absolute/);
    no(role, globT('/etc/*', path.join(ROOT, 'templates')), /absolute/);
    no(role, grep(path.join(ROOT, 'templates'), ROOT, '../projects/**'), /no "\.\."/);
  }
});

test('M5: each role writes and imports only from its own scratch folder', () => {
  for (const role of ['researcher', 'prosecutor']) {
    const theirs = scratchOf(TMP, other[role]);
    no(role, write(path.join(theirs, 'run-1', 'x.md')), /own scratch folder/);
    no(role, write(path.join(TMP, 'shared.md')), /own scratch folder/);
  }
  const cmd = { researcher: (f) => `node dashboard/cli.js import-text --provider claude --project olas --text-file "${f}" --run rr_1`, prosecutor: (f) => `node dashboard/cli.js tickets import olas tk_1 --text-file "${f}"` };
  for (const role of ['researcher', 'prosecutor']) {
    yes(role, bash(cmd[role](path.join(scratchOf(TMP, role), 'run-1', 'x.md'))));
    no(role, bash(cmd[role](path.join(scratchOf(TMP, other[role]), 'run-1', 'x.md'))), /--text-file is read only from this role's own scratch/);
    no(role, bash(cmd[role](path.join(TMP, 'x.md'))), /own scratch/);
    no(role, bash(cmd[role](path.join(ROOT, 'projects', 'x', 'draft.md'))), /own scratch/);
  }
  no('prosecutor', bash(`node dashboard/cli.js tickets import olas tk_1 --text-file=${path.join(TMP, 'x.md')}`), /own scratch/);
  no('prosecutor', bash(`node dashboard/cli.js tickets import olas tk_1 --text-file ${path.join(scratchOf(TMP, 'prosecutor'), 'a.md')} --text-file ${path.join(TMP, 'b.md')}`), /own scratch/);
});

test('M5: a link inside a role\'s scratch cannot carry a read into the other role\'s', (t) => {
  const base = fs.mkdtempSync(path.join(TMP, 'cr-iso-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const opts = { tmp: base, home: path.join(base, 'home') };
  const theirs = path.join(scratchOf(base, 'prosecutor'), 'tk_1');
  const mine = scratchOf(base, 'researcher');
  fs.mkdirSync(theirs, { recursive: true });
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(theirs, 'ticket.md'), 'FICTIONAL');
  const link = path.join(mine, 'peek');
  try { fs.symlinkSync(theirs, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch (err) { t.skip(`links cannot be made here: ${err.code}`); return; }
  no('researcher', read(path.join(link, 'ticket.md')), /only this role's own scratch/, opts);
  no('researcher', grep(link), /only this role's own scratch/, opts);
  no('researcher', write(path.join(link, 'x.md')), /own scratch folder/, opts);
  yes('prosecutor', read(path.join(theirs, 'ticket.md')), opts);
});

test('M5: Git Bash spellings on Windows are read as Windows paths', () => {
  const opts = { root: 'C:\\desk', tmp: 'C:\\Users\\e\\AppData\\Local\\Temp', home: 'C:\\Users\\e', platform: 'win32' };
  no('researcher', read('/c/desk/projects/x/project.json', '/c/desk'), /records/, opts);
  no('researcher', read('/c/Users/e/AppData/Local/Temp/cr-pilot/prosecutor/tk/t.md'), /only this role's own scratch/, opts);
  no('researcher', read('C:\\USERS\\E\\.claude\\projects\\s.jsonl'), /transcripts/, opts);
  yes('researcher', read('/c/Users/e/AppData/Local/Temp/cr-pilot/researcher/rr/r.md'), opts);
  yes('researcher', read('/c/desk/CLAUDE.md', '/c/desk'), opts);
});

test('M5: run as a hook, a read of the records is refused with exit 2; the local pilot writes each role\'s file in its own scratch', () => {
  const r = spawnSync(process.execPath, [GUARD, 'prosecutor'], { input: JSON.stringify(read(path.join(ROOT, 'projects', 'x', 'research', 'drafts', 'claude.md'))), encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^Refused by the pilot's role guard \(prosecutor\): the desk's records \(projects\/\)/);
  const pilot = fs.readFileSync(path.join(ROOT, 'dashboard', 'scripts', 'pilot.js'), 'utf8');
  assert.match(pilot, /path\.join\(os\.tmpdir\(\), 'cr-pilot', role\)/);
  assert.match(pilot, /scratch\('researcher', 'agent1-report\.md'/);
  assert.match(pilot, /scratch\('prosecutor', 'agent2-ticket\.md'/);
});
