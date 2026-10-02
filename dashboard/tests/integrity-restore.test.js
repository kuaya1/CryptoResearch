'use strict';
// Restore path safety (audit V2-002). Package and backup manifests are
// untrusted input: an entry can carry a correct SHA-256 and still name a path
// outside the destination. Every path is checked before anything is written,
// nothing partial is left behind, and legitimate round trips still verify.
// Every destination is nested three folders deep inside a throwaway sandbox,
// so even code without these checks could only write inside the sandbox.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { addFixtureProject } = require('./helpers');
const exporter = require('../core/exporter');
const { readJson, jsonText, atomicWrite } = require('../core/fsx');
const { initWorkspace, openWorkspace, DEFAULT_ROOT } = require('../core/workspace');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// A TEST workspace nested two folders inside its own sandbox, so a path that
// escaped the workspace (or a restore target) would still land in the sandbox.
function nestedWorkspace(t, label) {
  const sbx = fs.mkdtempSync(path.join(os.tmpdir(), `cr-restore-ws-${label}-`));
  t.after(() => fs.rmSync(sbx, { recursive: true, force: true }));
  const root = path.join(sbx, 'n1', 'n2', 'ws');
  fs.mkdirSync(root, { recursive: true });
  initWorkspace(root, { kind: 'test', name: `test ${label}`, templatesFrom: path.join(DEFAULT_ROOT, 'templates') });
  atomicWrite(path.join(root, 'config', 'settings.json'), jsonText({ schema_version: 1, market_data: { enabled: false }, inbox: { settle_seconds: 0 }, requests: { settle_seconds: 0 } }));
  return { ws: openWorkspace({ root, actor: 'test' }), sbx };
}

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-restore-sbx-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dest = path.join(root, 'l1', 'l2', 'dest');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  return { root, dest };
}

// Every file anywhere in the sandbox, so an escape is seen wherever it lands.
function listAll(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

function withEntry(pkg, rel, content = 'payload') {
  const copy = JSON.parse(JSON.stringify(pkg));
  copy.files.push({ path: rel, bytes: Buffer.byteLength(content), sha256: sha(Buffer.from(content)), encoding: 'utf8', content });
  return copy;
}

const HOSTILE = [
  ['backslash traversal', '..\\escaped.txt'],
  ['slash traversal', '../escaped.txt'],
  ['traversal inside a path', 'projects/../../escaped.txt'],
  ['trailing space folds to ..', '.. /escaped.txt'],
  ['trailing dots fold to ..', '.../escaped.txt'],
  ['trailing dot name', 'projects/report.'],
  ['absolute (POSIX)', '/abs-escaped.txt'],
  ['drive absolute', 'C:\\escaped.txt'],
  ['drive relative', 'C:escaped.txt'],
  ['UNC', '\\\\server\\share\\escaped.txt'],
  ['UNC with slashes', '//server/share/escaped.txt'],
  ['rooted', '\\rooted-escaped.txt'],
  ['NUL byte', 'projects/x\u0000.txt'],
  ['control character', 'projects/x\u0007.txt'],
  ['reserved device name', 'projects/CON.txt'],
  ['reserved device name with superscript', 'projects/COM\u00b9.json'],
  ['alternate data stream', 'projects/notes.txt:hidden'],
  ['empty segment', 'projects//x.txt'],
];

test('V2-002 package: every hostile path is refused before anything is written, even with a valid hash', (t) => {
  const { ws } = nestedWorkspace(t, 'pkg');
  addFixtureProject(ws);
  const pkg = exporter.exportPackage(ws);
  for (const [label, rel] of HOSTILE) {
    const { root, dest } = sandbox(t);
    const before = listAll(root);
    assert.throws(() => exporter.restorePackage(withEntry(pkg, rel), dest), (e) => e.code === 'UNSAFE_PATH' && /SHA-256 only ties bytes/.test(e.message), label);
    assert.equal(fs.existsSync(dest), false, `${label}: no destination folder was created`);
    assert.deepEqual(listAll(root), before, `${label}: nothing was written anywhere in the sandbox`);
  }
});

test('V2-002 package: duplicate targets and file/folder conflicts are refused as a whole', (t) => {
  const { ws } = nestedWorkspace(t, 'dup');
  addFixtureProject(ws);
  const pkg = exporter.exportPackage(ws);
  const cases = [
    ['same name, different case', ['notes/Readme.txt', 'notes/README.txt']],
    ['same name, different Unicode form', ['notes/caf\u00e9.txt', 'notes/cafe\u0301.txt']],
    ['a file where a folder is needed', ['notes/x', 'notes/x/y.txt']],
  ];
  for (const [label, rels] of cases) {
    const { root, dest } = sandbox(t);
    let p = pkg;
    rels.forEach((r, i) => { p = withEntry(p, r, `content ${i}`); });
    assert.throws(() => exporter.restorePackage(p, dest), (e) => e.code === 'UNSAFE_PATH', label);
    assert.equal(fs.existsSync(dest), false, label);
    assert.deepEqual(listAll(root), [], label);
  }
});

test('V2-002 package: a damaged last entry, or a write failure part way, leaves no partial destination', (t) => {
  const { ws } = nestedWorkspace(t, 'late');
  addFixtureProject(ws);
  const pkg = exporter.exportPackage(ws);
  assert.ok(pkg.files.length > 5);
  // Damaged entry at the end: refused before the first file is written.
  const damaged = JSON.parse(JSON.stringify(pkg));
  const last = damaged.files[damaged.files.length - 1];
  last.content = last.encoding === 'base64' ? Buffer.from('tampered').toString('base64') : `${last.content} tampered`;
  let sb = sandbox(t);
  assert.throws(() => exporter.restorePackage(damaged, sb.dest), (e) => e.code === 'INVALID' && /damaged/.test(e.message));
  assert.equal(fs.existsSync(sb.dest), false);
  // A write that fails after some files were written: everything is removed.
  sb = sandbox(t);
  const fsync = fs.fsyncSync;
  let n = 0;
  fs.fsyncSync = function failing(fd) {
    if (++n === 4) throw Object.assign(new Error('simulated disk failure'), { code: 'EIO' });
    return fsync.call(fs, fd);
  };
  try {
    assert.throws(() => exporter.restorePackage(pkg, sb.dest), /simulated disk failure/);
  } finally {
    fs.fsyncSync = fsync;
  }
  assert.ok(n >= 4, 'the failure happened after earlier files were written');
  assert.equal(fs.existsSync(sb.dest), false, 'the partly written destination was removed');
  // A non-empty destination is refused and left as it was.
  sb = sandbox(t);
  fs.mkdirSync(sb.dest, { recursive: true });
  fs.writeFileSync(path.join(sb.dest, 'mine.txt'), 'keep me');
  assert.throws(() => exporter.restorePackage(pkg, sb.dest), /not an empty folder/);
  assert.deepEqual(fs.readdirSync(sb.dest), ['mine.txt']);
});

test('V2-002 package and backup: legitimate round trips still restore and verify', (t) => {
  const { ws } = nestedWorkspace(t, 'ok');
  addFixtureProject(ws);
  const pkg = exporter.exportPackage(ws);
  let sb = sandbox(t);
  const r = exporter.restorePackage(JSON.parse(JSON.stringify(pkg)), sb.dest);
  assert.equal(r.status, 'restored_and_verified', JSON.stringify(r.reconciliation));
  for (const f of pkg.files) assert.equal(sha(fs.readFileSync(path.join(sb.dest, ...f.path.split('/')))), f.sha256, f.path);
  const b = exporter.createBackup(ws, { reason: 'roundtrip' });
  assert.equal(exporter.verifyBackup(ws, b.name).ok, true);
  sb = sandbox(t);
  const rb = exporter.restoreBackupTo(ws, b.name, sb.dest);
  assert.equal(rb.status, 'restored_and_verified', JSON.stringify(rb.reconciliation));
});

test('V2-002 restores say whether the records were verified when the package or backup was made', (t) => {
  const { ws } = nestedWorkspace(t, 'okv');
  addFixtureProject(ws);
  let sb = sandbox(t);
  assert.equal(exporter.restorePackage(exporter.exportPackage(ws), sb.dest).consistency_when_packaged.verified, true);
  const b = exporter.createBackup(ws, { reason: 'roundtrip' });
  sb = sandbox(t);
  assert.equal(exporter.restoreBackupTo(ws, b.name, sb.dest).records_verified_when_taken, true);
});

// Adds an item to a sealed backup and reseals it, as anyone with write access
// to the backup folder could. The payload sits where the item path resolves.
function resealWith(ws, name, rel, content) {
  const dir = ws.abs(`backups/snapshots/${name}`);
  const mf = path.join(dir, 'MANIFEST.json');
  const m = readJson(mf);
  const buf = Buffer.from(content);
  const src = path.join(dir, 'files', rel.replace(/[\\/]/g, path.sep));
  fs.mkdirSync(path.dirname(src), { recursive: true });
  try { fs.writeFileSync(src, buf); } catch (_) { /* some names cannot be created; the manifest still lists them */ }
  m.items.push({ path: rel, bytes: buf.length, sha256: sha(buf) });
  m.seal = sha(JSON.stringify(m.items.map((i) => [i.path, i.bytes, i.sha256])));
  fs.writeFileSync(mf, jsonText(m));
}

test('V2-002 backup: a resealed manifest with a traversal path is refused by verify and every restore mode', (t) => {
  const { ws, sbx } = nestedWorkspace(t, 'bk');
  addFixtureProject(ws);
  const b = exporter.createBackup(ws, { reason: 'base' });
  resealWith(ws, b.name, '..\\escaped.txt', 'payload');
  const v = exporter.verifyBackup(ws, b.name);
  assert.equal(v.ok, false);
  assert.ok(v.unsafe_paths && v.unsafe_paths.some((x) => x.path === '..\\escaped.txt'), JSON.stringify(v));
  const { root, dest } = sandbox(t);
  assert.throws(() => exporter.restoreBackupTo(ws, b.name, dest), (e) => e.code === 'UNSAFE_PATH');
  assert.equal(fs.existsSync(dest), false);
  assert.deepEqual(listAll(root), []);
  const snapshotsBefore = fs.readdirSync(ws.abs('backups/snapshots')).sort();
  assert.throws(() => exporter.restoreBackupOverlay(ws, b.name, { confirm: true }), (e) => e.code === 'UNSAFE_PATH');
  assert.deepEqual(fs.readdirSync(ws.abs('backups/snapshots')).sort(), snapshotsBefore, 'refused before the pre-restore backup');
  assert.throws(() => exporter.restoreBackupPointInTime(ws, b.name, { confirm: true }), (e) => e.code === 'UNSAFE_PATH');
  assert.deepEqual(listAll(sbx).filter((f) => /escaped\.txt$/.test(f) && !f.includes(`${path.sep}backups${path.sep}`)), [], 'no escaped file anywhere outside the backup folder');
});

test('V2-002 backup: a junction inside the files folder that leads outside is not followed', (t) => {
  const { ws } = nestedWorkspace(t, 'link');
  addFixtureProject(ws);
  const b = exporter.createBackup(ws, { reason: 'base' });
  const { root, dest } = sandbox(t);
  // Replace files/portfolio with a junction to a folder outside the backup
  // that holds byte-identical copies, so every recorded hash still matches.
  const filesPortfolio = ws.abs(`backups/snapshots/${b.name}/files/portfolio`);
  const outside = path.join(root, 'outside-portfolio');
  fs.cpSync(filesPortfolio, outside, { recursive: true });
  fs.rmSync(filesPortfolio, { recursive: true, force: true });
  fs.symlinkSync(outside, filesPortfolio, 'junction');
  const v = exporter.verifyBackup(ws, b.name);
  assert.equal(v.ok, false);
  assert.ok((v.escaped && v.escaped.length) || (v.links && v.links.length), JSON.stringify({ escaped: v.escaped, links: v.links }));
  assert.throws(() => exporter.restoreBackupTo(ws, b.name, dest), (e) => e.code === 'INVALID');
  assert.equal(fs.existsSync(dest), false);
});
