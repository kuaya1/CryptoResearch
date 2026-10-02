'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tempWorkspace } = require('./helpers');
const { StagedOp, runOp, recover } = require('../core/ops');
const { openWorkspace } = require('../core/workspace');
const { readJsonLines } = require('../core/fsx');

test('an interrupted write that was sealed is completed on the next start', (t) => {
  const { ws, root, cleanup } = tempWorkspace('rollfwd');
  t.after(cleanup);
  const op = new StagedOp(ws, 'test_write', 'simulated crash after seal');
  op.write('projects/demo-x/project.json', '{"x":1}\n', { mode: 'create' });
  op.write('projects/demo-x/notes/conviction.md', 'note\n');
  op.seal(); // the process "dies" here, before anything is moved into place
  assert.ok(!fs.existsSync(path.join(root, 'projects', 'demo-x', 'project.json')));
  const res = recover(ws);
  assert.equal(res[0].action, 'rolled_forward');
  assert.equal(fs.readFileSync(path.join(root, 'projects', 'demo-x', 'project.json'), 'utf8'), '{"x":1}\n');
  assert.ok(readJsonLines(path.join(root, 'logs', 'operations.jsonl')).some((l) => l.phase === 'recovered_forward'));
  assert.deepEqual(fs.readdirSync(path.join(root, '.cr', 'staging')), []);
});

test('an interrupted write that was never sealed is rolled back without touching records', (t) => {
  const { ws, root, cleanup } = tempWorkspace('rollback');
  t.after(cleanup);
  const op = new StagedOp(ws, 'test_write', 'simulated crash before seal');
  op.write('projects/demo-y/project.json', '{"y":1}\n');
  const res = recover(ws);
  assert.equal(res[0].action, 'rolled_back');
  assert.ok(!fs.existsSync(path.join(root, 'projects', 'demo-y')));
});

test('records that never change refuse to be overwritten; replaced files keep their previous version', (t) => {
  const { ws, root, cleanup } = tempWorkspace('immut');
  t.after(cleanup);
  runOp(ws, { type: 't' }, (op) => op.write('projects/z/report.txt', 'v1', { mode: 'create' }));
  assert.throws(() => runOp(ws, { type: 't' }, (op) => op.write('projects/z/report.txt', 'v2', { mode: 'create' })), /Refusing to overwrite/);
  runOp(ws, { type: 't' }, (op) => op.write('projects/z/mutable.txt', 'one'));
  const out = runOp(ws, { type: 't' }, (op) => op.write('projects/z/mutable.txt', 'two'));
  assert.equal(out.verified, true);
  const versions = fs.readdirSync(path.join(root, 'backups', 'versions', 'projects', 'z'));
  assert.ok(versions.some((v) => v.startsWith('mutable.txt@')));
});

test('a stale lock left by a dead process is broken; paths cannot escape the workspace', (t) => {
  const { ws, root, cleanup } = tempWorkspace('lock');
  t.after(cleanup);
  fs.mkdirSync(path.join(root, '.cr'), { recursive: true });
  fs.writeFileSync(path.join(root, '.cr', 'lock.json'), JSON.stringify({ pid: 999999, host: os.hostname(), at: new Date().toISOString() }));
  const out = runOp(ws, { type: 't' }, (op) => op.write('logs/x.txt', 'ok'));
  assert.equal(out.verified, true);
  for (const bad of ['../outside.txt', 'C:/Windows/x.txt', '/etc/passwd', 'projects/../../x', 'projects/./x', '..\\x']) {
    assert.throws(() => ws.abs(bad), /path|Path/, bad);
  }
});

test('a missing or disconnected folder fails loudly and saves nothing', () => {
  const missing = path.join(os.tmpdir(), `cr-missing-${Date.now()}`);
  assert.throws(() => openWorkspace({ root: missing }), (e) => e.code === 'WORKSPACE_UNREACHABLE');
  const notWs = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-notws-'));
  try {
    assert.throws(() => openWorkspace({ root: notWs }), (e) => e.code === 'NOT_A_WORKSPACE');
    assert.deepEqual(fs.readdirSync(notWs), [], 'nothing was written');
  } finally {
    fs.rmSync(notWs, { recursive: true, force: true });
  }
});
