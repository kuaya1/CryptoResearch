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
