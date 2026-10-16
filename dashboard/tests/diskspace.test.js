'use strict';
// Same-disk backups never fill the disk (2026-10-16: the online desk's 1 GB
// disk filled with fourteen daily copies and every write failed, the next
// start included). A simulated small disk: free space is its size less what
// the workspace holds. Fictional workspaces only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempWorkspace, addFixtureProject } = require('./helpers');
const X = require('../core/exporter');

const MB = 1024 * 1024;

function du(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += du(p);
    else if (e.isFile()) n += fs.statSync(p).size;
  }
  return n;
}

// A disk of `size` bytes holding only this workspace.
const disk = (root, size) => () => ({ bsize: 1, blocks: size, bavail: Math.max(0, size - du(root)) });

function setup(label) {
  const t = tempWorkspace(label);
  addFixtureProject(t.ws);
  // Some bulk in the records, so a copy has a size worth measuring.
  fs.mkdirSync(path.join(t.root, 'market-data', 'observations'), { recursive: true });
  fs.writeFileSync(path.join(t.root, 'market-data', 'observations', '2026-10.jsonl'), 'x'.repeat(400 * 1024));
  return t;
}

const snapshots = (root) => (fs.existsSync(path.join(root, 'backups', 'snapshots')) ? fs.readdirSync(path.join(root, 'backups', 'snapshots')).sort() : []);
let tick = 0;
// Backup names carry the second they were made; each test copy gets its own.
const backupAt = (ws, statfs, reason = 'daily') => X.createBackup(ws, { reason: `${reason}${String(++tick).padStart(3, '0')}`, statfs });

test('daily backups on a small disk remove the oldest copies to make room and never eat the reserve', (t) => {
  const { ws, root, cleanup } = setup('disk-prune');
  t.after(cleanup);
  const first = backupAt(ws);
  const copy = first.bytes;
  // Room for the records, the 64 MB reserve and about three and a half copies.
  const size = du(root) - copy + 64 * MB + Math.round(3.5 * copy);
  const statfs = disk(root, size);
  const made = [first.name];
  for (let i = 0; i < 6; i++) {
    const r = backupAt(ws, statfs);
    made.push(r.name);
    assert.ok(statfs().bavail >= 64 * MB - copy, `run ${i}: the reserve is kept (${statfs().bavail} free)`);
  }
  const left = snapshots(root);
  assert.equal(left.length, 3, 'as many copies as fit beside the reserve');
  assert.deepEqual(left, made.slice(-3), 'the newest stay; the oldest went first');
  assert.equal(X.verifyBackup(ws, left[2]).ok, true);
});

test('a disk too small for one more copy refuses it, keeps the newest two and leaves nothing half-written', (t) => {
  const { ws, root, cleanup } = setup('disk-refuse');
  t.after(cleanup);
  const a = backupAt(ws);
  const b = backupAt(ws);
  const statfs = disk(root, du(root) + 64 * MB + Math.round(0.5 * a.bytes));
  assert.throws(() => backupAt(ws, statfs), (e) => e.code === 'NO_SPACE' && /No backup was made/.test(e.message) && /offsite copies on the PC/.test(e.message));
  assert.deepEqual(snapshots(root), [a.name, b.name], 'the newest two complete copies are never removed for space');
});

test('an interrupted copy is removed first, then the oldest; the newest two and a pre-restore copy stay', (t) => {
  const { ws, root, cleanup } = setup('disk-order');
  t.after(cleanup);
  const pre = backupAt(ws, undefined, 'pre-restore');
  const old1 = backupAt(ws);
  const old2 = backupAt(ws);
  const new1 = backupAt(ws);
  const new2 = backupAt(ws);
  // A copy interrupted by a full disk: files, no manifest.
  const partial = path.join(root, 'backups', 'snapshots', '2099-01-01T000000Z_daily');
  fs.mkdirSync(path.join(partial, 'files'), { recursive: true });
  fs.writeFileSync(path.join(partial, 'files', 'big.bin'), Buffer.alloc(200 * 1024));
  // Room is wanted for about one more copy than is free.
  const size = du(root) + 64 * MB;
  const r = X.freeDiskSpace(root, 64 * MB + Math.round(1.5 * old1.bytes) + 200 * 1024, { statfs: disk(root, size) });
  assert.deepEqual(r.removed.map((x) => x.name), ['2099-01-01T000000Z_daily', old1.name, old2.name], 'unfinished first, then oldest');
  assert.equal(r.removed[0].complete, false);
  assert.deepEqual(snapshots(root), [pre.name, new1.name, new2.name].sort());
  // Nothing else can go: the answer says so instead of touching more.
  const none = X.freeDiskSpace(root, size * 10, { statfs: disk(root, size) });
  assert.equal(none.enough, false);
  assert.equal(none.removed.length, 0);
});

test('a write that fails part way through a copy leaves no partial backup behind', (t) => {
  const { ws, root, cleanup } = setup('disk-enospc');
  t.after(cleanup);
  const before = snapshots(root);
  const real = fs.writeFileSync;
  let n = 0;
  fs.writeFileSync = function (target, ...rest) {
    if (typeof target === 'number' && ++n > 5) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    return real.call(this, target, ...rest);
  };
  try {
    assert.throws(() => backupAt(ws), /ENOSPC/);
  } finally {
    fs.writeFileSync = real;
  }
  assert.deepEqual(snapshots(root), before, 'the interrupted copy was removed');
});

test('at start, a full disk is relieved before anything is written; a disk with room is left alone', (t) => {
  const { ws, root, cleanup } = setup('disk-start');
  t.after(cleanup);
  const names = [backupAt(ws).name, backupAt(ws).name, backupAt(ws).name, backupAt(ws).name];
  const roomy = X.relieveFullDisk(root, { statfs: disk(root, du(root) + 200 * MB) });
  assert.equal(roomy.removed.length, 0);
  const full = X.relieveFullDisk(root, { statfs: disk(root, du(root) + 64 * MB - 10) });
  assert.ok(full.removed.length >= 1, 'room is made');
  assert.equal(full.enough, true);
  assert.ok(full.before.free < full.reserve);
  assert.deepEqual(snapshots(root).slice(-2), names.slice(-2), 'the newest two remain');
  assert.match(X.diskLine(root, { statfs: disk(root, du(root) + 100 * MB) }), /MB free of \d+ MB; \d+ same-disk backups? \(\d+ MB\), reserve 64 MB/);
  // Unknown free space prunes and refuses nothing.
  assert.deepEqual(X.relieveFullDisk(root, { statfs: () => { throw new Error('no statfs'); } }).removed, []);
  assert.ok(backupAt(ws, () => { throw new Error('no statfs'); }).name);
});

test('the online desk relieves a full disk at start, then writes, and says so in its log', (t) => {
  const { ws, root, cleanup } = setup('disk-hosted');
  t.after(cleanup);
  const names = [backupAt(ws).name, backupAt(ws).name, backupAt(ws).name];
  const { prepareWorkspace } = require('../hosted');
  const lines = [];
  const real = console.log;
  console.log = (s) => lines.push(String(s));
  try {
    prepareWorkspace({ dataDir: root, statfs: disk(root, du(root) + 64 * MB - 10) });
  } finally {
    console.log = real;
  }
  assert.ok(lines.some((l) => /^Disk was full .* removed 1 same-disk backup\(s\) to make room .* The offsite copies on the PC were not touched\.$/.test(l)), lines.join('\n'));
  assert.deepEqual(snapshots(root), names.slice(1));
});
