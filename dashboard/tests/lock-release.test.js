'use strict';
// The record lock's release on Windows (PR #181). Releasing by deleting
// lock.json in place could make the next process's exclusive open answer EPERM
// for a moment, and that crashed its command. Release now frees the name first,
// by renaming the file aside, and deletes it under the other name. Taking the
// lock is unchanged. Temporary FICTIONAL workspaces only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tempWorkspace } = require('./helpers');
const ops = require('../core/ops');

const denied = (code = 'EPERM') => Object.assign(new Error(`${code}: refused (test)`), { code });
const isLock = (p) => path.basename(String(p)) === 'lock.json';
const isAside = (p) => /^lock-released-/.test(path.basename(String(p)));
const asides = (root) => fs.readdirSync(path.join(root, '.cr')).filter((f) => isAside(f));
const lockPath = (root) => path.join(root, '.cr', 'lock.json');

function desk(t, label) {
  const w = tempWorkspace(label);
  // Every stub below is put back before the folder goes, even when an assertion fails first.
  const { openSync, unlinkSync, renameSync } = fs;
  t.after(() => {
    fs.openSync = openSync;
    fs.unlinkSync = unlinkSync;
    fs.renameSync = renameSync;
    w.cleanup();
  });
  return { ...w, real: { openSync, unlinkSync, renameSync } };
}

test('a model of the Windows answer: a delete of lock.json in place makes the next open refuse; release no longer opens that window', (t) => {
  const { ws, real } = desk(t, 'lock-window');
  // Deleting lock.json in place arms the refusal Windows gave under load. On the
  // old release these same two commands crash the second one with EPERM.
  let window = false;
  fs.unlinkSync = (p) => {
    if (isLock(p)) window = true;
    return real.unlinkSync.call(fs, p);
  };
  fs.openSync = (p, ...rest) => {
    if (isLock(p) && window) {
      window = false;
      throw denied();
    }
    return real.openSync.call(fs, p, ...rest);
  };
  assert.equal(ops.withLock(ws, 'first', () => 'one'), 'one');
  assert.equal(ops.withLock(ws, 'second', () => 'two'), 'two');
});

test('release frees the name before it deletes anything, and nothing is left behind', (t) => {
  const { ws, root, real } = desk(t, 'lock-order');
  const seen = [];
  fs.unlinkSync = (p) => {
    if (isLock(p) || isAside(p)) seen.push({ name: path.basename(String(p)), lock_exists: fs.existsSync(lockPath(root)) });
    return real.unlinkSync.call(fs, p);
  };
  ops.withLock(ws, 'one', () => assert.ok(fs.existsSync(lockPath(root)), 'held while the work runs'));
  assert.equal(seen.length, 1, 'one delete');
  assert.ok(isAside(seen[0].name), `the delete was of the renamed file, not ${seen[0].name}`);
  assert.equal(seen[0].lock_exists, false, 'the name was already free');
  assert.equal(fs.existsSync(lockPath(root)), false);
  assert.deepEqual(asides(root), []);
});

test('the lock is released the same way when the work throws', (t) => {
  const { ws, root } = desk(t, 'lock-throw');
  assert.throws(() => ops.withLock(ws, 'one', () => { throw new Error('the work failed (test)'); }), /the work failed/);
  assert.equal(fs.existsSync(lockPath(root)), false);
  assert.deepEqual(asides(root), []);
});

test('a folder that refuses the rename still releases by deleting in place', (t) => {
  const { ws, root, real } = desk(t, 'lock-norename');
  fs.renameSync = (from, to) => {
    if (isLock(from)) throw denied();
    return real.renameSync.call(fs, from, to);
  };
  ops.withLock(ws, 'one', () => 1);
  assert.equal(fs.existsSync(lockPath(root)), false, 'deleted in place');
  assert.deepEqual(asides(root), []);
});

test('a folder that refuses the rename and the delete leaves the released marker, and the next command reclaims it at once', (t) => {
  const { ws, root, real } = desk(t, 'lock-neither');
  fs.renameSync = (from, to) => {
    if (isLock(from)) throw denied();
    return real.renameSync.call(fs, from, to);
  };
  fs.unlinkSync = (p) => {
    if (isLock(p)) throw denied();
    return real.unlinkSync.call(fs, p);
  };
  ops.withLock(ws, 'one', () => 1);
  assert.equal(JSON.parse(fs.readFileSync(lockPath(root), 'utf8')).released, true);
  fs.renameSync = real.renameSync;
  fs.unlinkSync = real.unlinkSync;
  const started = Date.now();
  assert.equal(ops.withLock(ws, 'two', () => 2), 2);
  assert.ok(Date.now() - started < 5000, 'no wait for a lease to expire');
});

test('a session known not to delete keeps the marker and piles up no renamed files', (t) => {
  const { ws, root, real } = desk(t, 'lock-caps');
  ws._caps = { write: true, rename: true, delete: false };
  fs.unlinkSync = (p) => {
    if (isLock(p) || isAside(p)) throw denied();
    return real.unlinkSync.call(fs, p);
  };
  ops.withLock(ws, 'one', () => 1);
  ops.withLock(ws, 'two', () => 2);
  assert.equal(JSON.parse(fs.readFileSync(lockPath(root), 'utf8')).released, true);
  assert.deepEqual(asides(root), []);
});

test('a renamed file that cannot be deleted does not hold the lock, and a later recovery that can delete sweeps it', (t) => {
  const { ws, root, real } = desk(t, 'lock-sweep');
  fs.unlinkSync = (p) => {
    if (isAside(p)) throw denied();
    return real.unlinkSync.call(fs, p);
  };
  ops.withLock(ws, 'one', () => 1);
  assert.equal(fs.existsSync(lockPath(root)), false, 'the name is free');
  assert.equal(asides(root).length, 1);
  assert.equal(ops.withLock(ws, 'two', () => 2), 2, 'the next command takes the lock');
  fs.unlinkSync = real.unlinkSync;
  ws._caps = { write: true, rename: true, delete: true };
  // Recovery's housekeeping runs when it has work, as it does for lock-broken files.
  fs.mkdirSync(path.join(root, '.cr', 'staging', 'interrupted-op'), { recursive: true });
  ops.recover(ws);
  assert.deepEqual(asides(root), [], 'swept by recovery');
});

test('a lock that vanishes just before the rename is not put back', (t) => {
  const { ws, root, real } = desk(t, 'lock-gone');
  fs.renameSync = (from, to) => {
    if (isLock(from) && isAside(to)) {
      real.unlinkSync.call(fs, from);
      throw denied('ENOENT');
    }
    return real.renameSync.call(fs, from, to);
  };
  ops.withLock(ws, 'one', () => 1);
  assert.equal(fs.existsSync(lockPath(root)), false, 'no marker written over a free name');
  assert.deepEqual(asides(root), []);
});

test('a new owner who takes the lock in that same moment keeps it: release stops at the first sign it is gone', (t) => {
  const { ws, root, real } = desk(t, 'lock-newowner');
  const other = JSON.stringify({ token: 'another-owner', pid: process.pid, host: 'another-host', at: new Date().toISOString() });
  fs.renameSync = (from, to) => {
    if (isLock(from) && isAside(to)) {
      real.unlinkSync.call(fs, from);
      fs.writeFileSync(lockPath(root), other);
      throw denied('ENOENT');
    }
    return real.renameSync.call(fs, from, to);
  };
  ops.withLock(ws, 'one', () => 1);
  assert.equal(fs.readFileSync(lockPath(root), 'utf8'), other);
});

test('only the owner releases: a lock now held by someone else is not renamed or deleted', (t) => {
  const { ws, root } = desk(t, 'lock-other');
  const other = JSON.stringify({ token: 'another-owner', pid: process.pid, host: 'another-host', at: new Date().toISOString() });
  ops.withLock(ws, 'one', () => fs.writeFileSync(lockPath(root), other));
  assert.equal(fs.readFileSync(lockPath(root), 'utf8'), other);
  assert.deepEqual(asides(root), []);
});

test('taking the lock is unchanged: a live holder is waited for and never broken, and a busy workspace says so', (t) => {
  const { ws, root } = desk(t, 'lock-busy');
  const held = JSON.stringify({ token: 'another-owner', pid: process.pid, host: os.hostname(), at: new Date().toISOString() });
  fs.mkdirSync(path.dirname(lockPath(root)), { recursive: true });
  fs.writeFileSync(lockPath(root), held);
  assert.throws(() => ops.withLock(ws, 'one', () => 1, { timeoutMs: 100 }), (err) => err.code === 'WORKSPACE_BUSY');
  assert.equal(fs.readFileSync(lockPath(root), 'utf8'), held);
});

test('taking the lock is unchanged: a refusal that is not about the lock existing still reaches the caller', (t) => {
  const { ws, real } = desk(t, 'lock-refused');
  fs.openSync = (p, ...rest) => {
    if (isLock(p)) throw denied('EACCES');
    return real.openSync.call(fs, p, ...rest);
  };
  assert.throws(() => ops.withLock(ws, 'one', () => 1), (err) => err.code === 'EACCES');
});

function cycle(root, cycles) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'children', 'child-lock-cycle.js'), root, String(cycles)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`child exited ${code}: ${err}`))));
  });
}

test('four real processes taking and releasing the lock: no refusal, no lost update, nothing left behind', async (t) => {
  const { root } = desk(t, 'lock-race');
  const CYCLES = 60;
  fs.writeFileSync(path.join(root, 'count.txt'), '0');
  const results = await Promise.all([1, 2, 3, 4].map(() => cycle(root, CYCLES)));
  assert.deepEqual(results.flatMap((r) => r.errors), []);
  assert.equal(results.reduce((n, r) => n + r.ok, 0), 4 * CYCLES);
  assert.equal(Number(fs.readFileSync(path.join(root, 'count.txt'), 'utf8')), 4 * CYCLES, 'one holder at a time: every update counted');
  assert.equal(fs.existsSync(lockPath(root)), false);
  assert.deepEqual(asides(root), []);
});
