'use strict';
// The pilot runner finds Claude Code without a shell (backlog item 6): plain
// `claude` off Windows, claude.exe on Windows from PATH or its install folders.
// Stubs only; nothing is run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { resolveClaude } = require('../scripts/pilot');

test('off Windows the command is claude', () => {
  assert.equal(resolveClaude({ platform: 'linux', env: {}, exists: () => false }), 'claude');
  assert.equal(resolveClaude({ platform: 'darwin', env: {}, exists: () => false }), 'claude');
});

test('on Windows claude.exe is found on PATH first, then in the usual folders', () => {
  const env = { PATH: 'C:\\Windows;C:\\Tools', USERPROFILE: 'C:\\Users\\eric', LOCALAPPDATA: 'C:\\Users\\eric\\AppData\\Local' };
  const seen = new Set(['C:\\Tools\\claude.exe', 'C:\\Users\\eric\\.local\\bin\\claude.exe']);
  assert.equal(resolveClaude({ platform: 'win32', env, exists: (f) => seen.has(f) }), 'C:\\Tools\\claude.exe');
  assert.equal(resolveClaude({ platform: 'win32', env, exists: (f) => f === 'C:\\Users\\eric\\.local\\bin\\claude.exe' }), 'C:\\Users\\eric\\.local\\bin\\claude.exe');
});

test('on Windows a missing claude.exe is a plain error, never a shell lookup', () => {
  assert.throws(() => resolveClaude({ platform: 'win32', env: { PATH: 'C:\\Windows' }, exists: () => false }), /claude\.exe was not found/);
});

test('the runner no longer spawns through a shell', () => {
  assert.ok(!/shell:\s*/.test(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pilot.js'), 'utf8')));
});

// Eric's override (2026-10-25): a Prosecutor on a closed pre-gate. Pure
// helpers only; nothing is run.
const { parse, forcedTicket, onlineInstruction, FORCE_WORDS } = require('../scripts/pilot');

test('the override flag and owner words parse, an "=" inside the words kept', () => {
  const o = parse(['--project=velodrome-finance', '--desk=online', '--force-prosecution', '--owner-words=grade >= 50 = prosecute']);
  assert.equal(o.project, 'velodrome-finance');
  assert.equal(o.forceProsecution, true);
  assert.equal(o.ownerWords, 'grade >= 50 = prosecute');
  assert.equal(parse(['--project=olas']).forceProsecution, false);
});

test('the override turns the gate step and an undecided desk gate into a ticket, never a decided one', () => {
  const on = { forceProsecution: true };
  const gate = (status) => ({ desk_gate: true, status });
  assert.equal(forcedTicket({ step: 'gate_closed' }, null, { forceProsecution: false }), false);
  assert.equal(forcedTicket({ step: 'gate_closed' }, null, on), true);
  assert.equal(forcedTicket({ step: 'pm_review' }, gate('pending_pm_review'), on), true);
  assert.equal(forcedTicket({ step: 'pm_review' }, gate('passed'), on), false);
  assert.equal(forcedTicket({ step: 'pm_review' }, { desk_gate: false, status: 'pending_pm_review' }, on), false);
  assert.equal(forcedTicket({ step: 'done' }, gate('watching'), on), false);
  assert.equal(forcedTicket({ step: 'research' }, null, on), false);
});

test('the online instruction asks for force_prosecution only with the override, in Eric\'s words', () => {
  const plain = onlineInstruction({ project: 'olas', forceProsecution: false });
  assert.match(plain, /needs no Prosecutor/);
  assert.doesNotMatch(plain, /force_prosecution/);
  const forced = onlineInstruction({ project: 'olas', forceProsecution: true, ownerWords: null });
  assert.match(forced, /force_prosecution: true/);
  assert.ok(forced.includes(JSON.stringify(FORCE_WORDS)));
  assert.match(forced, /Never on a desk gate Eric already decided/);
  assert.match(forced, /Never decide a ticket, never choose a dollar amount/);
});
