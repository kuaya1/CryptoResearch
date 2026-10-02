'use strict';
// The single write path. Every change to workspace records goes through runOp:
//   lock -> stage files under .cr/staging/<op> -> seal manifest -> mark the
//   generation "applying" -> move files into place (keeping the previous version
//   of anything replaced) -> verify hashes -> mark the generation stable ->
//   append logs/operations.jsonl -> release lock.
// If a process dies after the manifest is sealed, recover() finishes the move on
// the next start (roll forward). If it dies before, the staging folder is discarded.
//
// Safety rules (audit F01/F04):
// - A lock records a random owner token. A lock held by a live process on this
//   PC is never broken, however old. A lock from another host (for example a
//   Cowork cloud session writing through the desktop bridge) is a lease that
//   expires 2 minutes after its last renewal; long operations renew it.
// - Only the owner (same token) may release a lock. A process that lost its
//   lock aborts before applying anything.
// - A commit whose files do not read back with the staged hashes keeps its
//   staging folder as evidence, writes .cr/blocked.json and refuses further
//   writes until the owner resolves it (node dashboard/cli.js recover).
// - An idempotency key commits a record under logs/applied/ in the SAME staged
//   operation as the effect, so a retry after a crash finds it and does not
//   apply the effect twice.
// - Environments that may not delete or rename files (some sandboxed sessions)
//   still commit correctly; their leftover temporary files are cleaned up by the
//   next run on a machine that can delete.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  sha256, sleepSync, withRetry, mkdirp, writeDurable, exists, readJson, parseJson, jsonText, listDir, appendLine, rmrf,
} = require('./fsx');
const { randomId, compactTs, fileTs } = require('./ids');
const { safeRel } = require('./workspace');

const LEASE_MS = 120000;
const OPLOG_REL = 'logs/operations.jsonl';
const GEN_REL = '.cr/generation.json';
const BLOCK_REL = '.cr/blocked.json';
const APPLIED_DIR = 'logs/applied';

class OpError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

function crDir(ws) {
  return path.join(ws.root, '.cr');
}

function lockFile(ws) {
  return path.join(crDir(ws), 'lock.json');
}

function logOp(ws, entry) {
  appendLine(ws.abs(OPLOG_REL), { at: new Date().toISOString(), ...entry });
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readRaw(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (_) {
    return null;
  }
}

function parseSafe(raw) {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// What this process may do in this folder. Some sandboxed sessions can create
// and overwrite files but not delete or rename them. Probed once per process
// with fixed file names, so probing never accumulates files.

function capabilities(ws) {
  if (ws._caps) return ws._caps;
  const dir = path.join(crDir(ws), 'caps');
  const a = path.join(dir, 'probe-a');
  const b = path.join(dir, 'probe-b');
  const caps = { write: false, rename: false, delete: false, probed_at: new Date().toISOString(), host: os.hostname(), platform: process.platform };
  try {
    mkdirp(dir);
    fs.writeFileSync(a, `probe ${process.pid} ${Date.now()}`);
    caps.write = true;
    try {
      fs.renameSync(a, b);
      caps.rename = true;
    } catch (_) { /* not permitted */ }
    try {
      fs.unlinkSync(caps.rename ? b : a);
      caps.delete = true;
    } catch (_) { /* not permitted */ }
  } catch (_) { /* cannot write at all */ }
  ws._caps = caps;
  return caps;
}

// Replace a whole file. Atomic (temp file + rename) where renames are allowed,
// otherwise a direct durable overwrite.
function replaceFile(ws, abs, data) {
  const caps = capabilities(ws);
  if (caps.rename) {
    const tmp = `${abs}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    writeDurable(tmp, data);
    try {
      withRetry(() => fs.renameSync(tmp, abs));
      return;
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (_) { /* cleaned up later */ }
      if (!['EPERM', 'EACCES', 'EXDEV'].includes(err.code)) throw err;
    }
  }
  writeDurable(abs, data);
}

function tryRemove(ws, abs, { dir = false } = {}) {
  try {
    if (dir) rmrf(abs);
    else fs.unlinkSync(abs);
    return true;
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Locking

function ownerRecord(ws, label) {
  return { token: crypto.randomBytes(12).toString('hex'), pid: process.pid, host: os.hostname(), actor: ws.actor, label, at: new Date().toISOString() };
}

function lockState(ws) {
  const p = lockFile(ws);
  const raw = readRaw(p);
  if (raw === null) return { present: false };
  const current = parseSafe(raw);
  let ageMs = 0;
  try {
    ageMs = Date.now() - fs.statSync(p).mtimeMs;
  } catch (_) {
    return { present: false };
  }
  if (current && current.released) return { present: true, raw, current, ageMs, released: true, stale: true, reason: 'released by a session that could not delete it' };
  if (!current) return { present: true, raw, current, ageMs, stale: ageMs > 5000, reason: 'unreadable lock file' };
  const sameHost = current.host === os.hostname();
  if (sameHost) {
    if (current.pid === process.pid && current.token && current.token === (ws._lockOwner && ws._lockOwner.token)) return { present: true, raw, current, ageMs, stale: false, mine: true };
    const alive = pidAlive(current.pid);
    return { present: true, raw, current, ageMs, stale: !alive, live: alive, reason: alive ? `held by live process ${current.pid} on this PC` : `process ${current.pid} is no longer running` };
  }
  return { present: true, raw, current, ageMs, stale: ageMs > LEASE_MS, reason: ageMs > LEASE_MS ? `lease from ${current.host} expired ${Math.round((ageMs - LEASE_MS) / 1000)} s ago` : `held by ${current.host} (lease)` };
}

// Overwrite-and-confirm, used only when the lock file cannot be renamed away.
function takeOver(p, owner, expectedRaw) {
  if (readRaw(p) !== expectedRaw) return false;
  try {
    writeDurable(p, JSON.stringify(owner));
  } catch (_) {
    return false;
  }
  sleepSync(40);
  const back = parseSafe(readRaw(p));
  return Boolean(back && back.token === owner.token);
}

function tryAcquire(ws, owner, allowBreak = true) {
  const p = lockFile(ws);
  mkdirp(path.dirname(p));
  try {
    const fd = fs.openSync(p, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify(owner));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const st = lockState(ws);
  if (!st.present) return allowBreak ? tryAcquire(ws, owner, false) : false;
  if (!st.stale || !allowBreak) return false;
  // Break atomically: rename the stale lock aside, then create a fresh one.
  const aside = path.join(crDir(ws), `lock-broken-${fileTs()}-${randomId(4)}.json`);
  try {
    fs.renameSync(p, aside);
    logOp(ws, { phase: st.released ? 'lock_reclaimed' : 'lock_broken', previous_owner: st.current, age_ms: Math.round(st.ageMs), reason: st.reason });
    tryRemove(ws, aside);
    return tryAcquire(ws, owner, false);
  } catch (err) {
    if (err.code === 'ENOENT') return tryAcquire(ws, owner, false);
    if (!['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
  }
  const ok = takeOver(p, owner, st.raw);
  if (ok) logOp(ws, { phase: 'lock_reclaimed', method: 'overwrite', previous_owner: st.current, reason: st.reason });
  return ok;
}

function release(ws, owner) {
  const p = lockFile(ws);
  const cur = parseSafe(readRaw(p));
  if (!cur || cur.token !== owner.token) {
    logOp(ws, { phase: 'lock_release_skipped', reason: cur ? 'lock now belongs to another owner' : 'lock already gone', token: owner.token });
    return;
  }
  try {
    fs.unlinkSync(p);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    // Cannot delete here: leave a released marker the next run can reclaim at once.
    try {
      writeDurable(p, JSON.stringify({ released: true, token: owner.token, host: owner.host, pid: owner.pid, released_at: new Date().toISOString() }));
    } catch (_) { /* nothing else to do */ }
  }
}

// Extends the lease (and proves we still own the lock). Throws LOCK_LOST if not.
function renewLock(ws) {
  if (!ws._lockOwner) return;
  const p = lockFile(ws);
  const cur = parseSafe(readRaw(p));
  if (!cur || cur.token !== ws._lockOwner.token) {
    throw new OpError('LOCK_LOST', 'This process no longer holds the workspace lock (it was taken over). Nothing more was written by this operation.');
  }
  const now = new Date();
  try {
    fs.utimesSync(p, now, now);
  } catch (_) {
    try { writeDurable(p, JSON.stringify(cur)); } catch (__) { /* best effort */ }
  }
}

function withLock(ws, label, fn, { timeoutMs = 20000 } = {}) {
  if (ws._lockHeld) return fn();
  const owner = ownerRecord(ws, label);
  const started = Date.now();
  let wait = 25;
  while (!tryAcquire(ws, owner)) {
    if (Date.now() - started > timeoutMs) {
      const st = lockState(ws);
      throw new OpError('WORKSPACE_BUSY', `The workspace is busy with another operation${st.reason ? ` (${st.reason})` : ''}. Nothing was saved; try again in a moment.`);
    }
    sleepSync(wait);
    wait = Math.min(wait * 2, 250);
  }
  ws._lockHeld = true;
  ws._lockOwner = owner;
  try {
    return fn();
  } finally {
    ws._lockHeld = false;
    ws._lockOwner = null;
    release(ws, owner);
  }
}

// ---------------------------------------------------------------------------
// Generation pointer: readers retry until they see one stable generation.

function readGen(ws) {
  const g = parseSafe(readRaw(ws.abs(GEN_REL)));
  return g && typeof g.generation === 'number' ? g : { generation: 0, state: 'stable' };
}

function writeGen(ws, doc) {
  try {
    mkdirp(path.dirname(ws.abs(GEN_REL)));
    replaceFile(ws, ws.abs(GEN_REL), JSON.stringify(doc));
  } catch (_) { /* readers fall back to a best-effort read */ }
}

// Runs fn against a coherent generation of the records: if a commit was in
// progress or completed while fn was reading, fn runs again.
function readConsistent(ws, fn, { attempts = 8 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    const a = readGen(ws);
    if (a.state === 'applying') {
      const age = Date.now() - Date.parse(a.at || 0);
      if (age < 30000) {
        sleepSync(30 * (i + 1));
        continue;
      }
    }
    last = fn();
    const b = readGen(ws);
    if (b.generation === a.generation && b.state === a.state && (a.state !== 'applying')) return last;
  }
  return last === undefined ? fn() : last;
}

// ---------------------------------------------------------------------------
// Staged operations

class StagedOp {
  constructor(ws, type, summary) {
    this.ws = ws;
    this.type = type;
    this.summary = summary || '';
    this.id = `op_${compactTs()}_${randomId(6)}`;
    this.dir = path.join(crDir(ws), 'staging', this.id);
    this.entries = [];
    this.staged = new Map(); // rel -> Buffer, for read-after-write inside one op
    this.after = []; // callbacks run after a verified commit
  }

  write(rel, data, { mode = 'replace' } = {}) {
    const relN = safeRel(rel);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const target = this.ws.abs(relN);
    if (mode === 'create' && exists(target)) {
      throw new OpError('ALREADY_EXISTS', `Refusing to overwrite a record that never changes: ${relN}`);
    }
    let entry = this.entries.find((e) => e.kind === 'write' && e.rel === relN);
    if (!entry) {
      entry = { kind: 'write', rel: relN, staged: `f${String(this.entries.length).padStart(4, '0')}`, mode };
      this.entries.push(entry);
    }
    writeDurable(path.join(this.dir, 'files', entry.staged), buf);
    entry.sha256 = sha256(buf);
    entry.bytes = buf.length;
    this.staged.set(relN, buf);
    return target;
  }

  writeJson(rel, obj, opts) {
    return this.write(rel, jsonText(obj), opts);
  }

  // Moves an existing workspace file (for example inbox -> processed) as part of the commit.
  move(fromRel, toRel) {
    this.entries.push({ kind: 'move', from: safeRel(fromRel), to: safeRel(toRel) });
  }

  // Read a file as this operation will leave it (staged content wins).
  readText(rel, fallback) {
    const relN = safeRel(rel);
    if (this.staged.has(relN)) return this.staged.get(relN).toString('utf8');
    const abs = this.ws.abs(relN);
    if (!exists(abs)) {
      if (fallback !== undefined) return fallback;
      throw new OpError('NOT_FOUND', `Missing file: ${relN}`);
    }
    return fs.readFileSync(abs, 'utf8').replace(/^﻿/, '');
  }

  readJson(rel, fallback) {
    const relN = safeRel(rel);
    if (this.staged.has(relN)) return parseJson(this.staged.get(relN).toString('utf8'), relN);
    return readJson(this.ws.abs(relN), fallback);
  }

  manifest(extra = {}) {
    return {
      op_id: this.id,
      type: this.type,
      summary: this.summary,
      actor: this.ws.actor,
      host: os.hostname(),
      created_at: new Date().toISOString(),
      ready: true,
      entries: this.entries,
      ...extra,
    };
  }

  seal() {
    writeDurable(path.join(this.dir, 'manifest.json'), jsonText(this.manifest()));
  }

  abort() {
    if (!tryRemove(this.ws, this.dir, { dir: true }) && exists(this.dir)) {
      // Could not delete: mark it abandoned so recovery discards it without applying.
      try { writeDurable(path.join(this.dir, 'manifest.json'), jsonText({ op_id: this.id, ready: false, abandoned: true, at: new Date().toISOString() })); } catch (_) { /* ignore */ }
    }
  }
}

function uniqueTarget(ws, rel) {
  if (!exists(ws.abs(rel))) return rel;
  const ext = path.posix.extname(rel);
  const base = rel.slice(0, rel.length - ext.length);
  for (let i = 2; i < 1000; i++) {
    const cand = `${base}-${i}${ext}`;
    if (!exists(ws.abs(cand))) return cand;
  }
  throw new OpError('NAME_COLLISION', `Could not find a free name for ${rel}`);
}

function placeFile(ws, staged, target) {
  if (capabilities(ws).rename) {
    try {
      withRetry(() => fs.renameSync(staged, target));
      return;
    } catch (err) {
      if (!['EPERM', 'EACCES', 'EXDEV'].includes(err.code)) throw err;
    }
  }
  writeDurable(target, fs.readFileSync(staged));
}

function moveFile(ws, from, to) {
  if (capabilities(ws).rename) {
    try {
      withRetry(() => fs.renameSync(from, to));
      return;
    } catch (err) {
      if (!['EPERM', 'EACCES', 'EXDEV'].includes(err.code)) throw err;
    }
  }
  // Copy, then remove the source if allowed. A source that cannot be removed is
  // left in place; consumers treat "already present at destination with the same
  // bytes" as moved.
  writeDurable(to, fs.readFileSync(from));
  tryRemove(ws, from);
}

function applyManifest(ws, manifest, dir) {
  const stamp = fileTs();
  const applied = [];
  for (const e of manifest.entries) {
    if (ws._lockOwner) renewLock(ws);
    if (e.kind === 'write') {
      const target = ws.abs(e.rel);
      const staged = path.join(dir, 'files', e.staged);
      if (exists(target)) {
        const current = fs.readFileSync(target);
        if (sha256(current) === e.sha256) {
          applied.push({ ...e, already: true });
          continue;
        }
        if (e.mode === 'create') {
          throw new OpError('ALREADY_EXISTS', `A different file already exists at ${e.rel}; refusing to overwrite it.`);
        }
        const versionAbs = ws.abs(`backups/versions/${e.rel}@${stamp}`);
        mkdirp(path.dirname(versionAbs));
        fs.writeFileSync(versionAbs, current);
      }
      if (!exists(staged)) throw new OpError('STAGING_MISSING', `Staged copy of ${e.rel} is missing.`);
      mkdirp(path.dirname(target));
      placeFile(ws, staged, target);
      applied.push(e);
    } else if (e.kind === 'move') {
      const from = ws.abs(e.from);
      if (!exists(from)) {
        applied.push({ ...e, skipped: 'source already moved' });
        continue;
      }
      const toRel = e.to_final || uniqueTarget(ws, e.to);
      const to = ws.abs(toRel);
      mkdirp(path.dirname(to));
      moveFile(ws, from, to);
      e.to = toRel;
      e.to_final = toRel;
      applied.push(e);
    }
  }
  return applied;
}

function verifyEntries(ws, entries) {
  const out = [];
  for (const e of entries) {
    if (e.kind === 'write') {
      const abs = ws.abs(e.rel);
      let ok = false;
      try {
        ok = sha256(fs.readFileSync(abs)) === e.sha256;
      } catch (_) {
        ok = false;
      }
      out.push({ rel: e.rel, path: abs, sha256: e.sha256, bytes: e.bytes, ok });
    } else if (e.kind === 'move') {
      const abs = ws.abs(e.to_final || e.to);
      out.push({ rel: e.to_final || e.to, path: abs, moved_from: e.from, ok: exists(abs) || Boolean(e.skipped) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Write blocking after an unverifiable commit

function blockedState(ws) {
  return parseSafe(readRaw(ws.abs(BLOCK_REL)));
}

function blockWrites(ws, info) {
  const doc = {
    blocked_at: new Date().toISOString(),
    ...info,
    message: 'A commit did not read back with the expected content. Its staged files are kept as evidence. New writes are refused until you inspect it: node dashboard/cli.js recover --status, then recover --resolve.',
  };
  try {
    writeDurable(ws.abs(BLOCK_REL), JSON.stringify(doc, null, 2));
  } catch (_) { /* logged below */ }
  logOp(ws, { phase: 'writes_blocked', ...info });
  return doc;
}

function assertNotBlocked(ws) {
  const b = blockedState(ws);
  if (b) throw new OpError('WRITES_BLOCKED', `Writes are blocked: ${b.reason || 'an earlier commit could not be verified'} (op ${b.op_id || '?'}). Nothing was saved. Run: node dashboard/cli.js recover --status`, b);
}

function quarantine(ws, opId, dir) {
  const target = path.join(crDir(ws), 'quarantine', opId);
  try {
    mkdirp(path.dirname(target));
    fs.renameSync(dir, target);
    return target;
  } catch (_) {
    return dir;
  }
}

// ---------------------------------------------------------------------------
// Idempotency records (logs/applied/<key>.json)

function appliedRel(key) {
  const safe = String(key).replace(/[^A-Za-z0-9_.#:-]/g, '_').replace(/[#:]/g, '--').slice(0, 160);
  return `${APPLIED_DIR}/${safe}.json`;
}

function readApplied(ws, key) {
  return readJson(ws.abs(appliedRel(key)), null);
}

function compactResult(result) {
  try {
    const text = JSON.stringify(result === undefined ? null : result, (k, v) => (['project', 'raw', 'raw_json', 'assessment', 'record'].includes(k) ? undefined : v));
    if (text && text.length > 20000) return { truncated: true, preview: text.slice(0, 2000) };
    return text === undefined ? null : JSON.parse(text);
  } catch (_) {
    return null;
  }
}

// Runs build(op) under the workspace lock and commits whatever it staged.
// Returns { op_id, noop, files, verified, result }.
// Options: idempotencyKey — if a record for this key exists, nothing is applied
// again and the stored result is returned (replayed: true). payloadHash — a
// different payload under the same key is a conflict, never a second effect.
function runOp(ws, { type, summary, idempotencyKey = null, payloadHash = null }, build) {
  // A queued request (requests.js) sets ws._idem while its action runs; every
  // operation of that action is then keyed by request ID and operation type.
  if (!idempotencyKey && ws._idem && type !== 'request_result') {
    idempotencyKey = `${ws._idem.requestId}#${type}`;
    payloadHash = ws._idem.payloadHash;
  }
  return withLock(ws, type, () => {
    assertNotBlocked(ws);
    recoverLocked(ws);
    assertNotBlocked(ws);
    if (idempotencyKey) {
      const prior = readApplied(ws, idempotencyKey);
      if (prior) {
        if (payloadHash && prior.payload_sha256 && prior.payload_sha256 !== payloadHash) {
          throw new OpError('IDEMPOTENCY_CONFLICT', `Request ${idempotencyKey} was already applied with different content (op ${prior.op_id}). Nothing new was applied; use a new request ID for a different change.`, { prior_op_id: prior.op_id });
        }
        return { op_id: prior.op_id, noop: true, replayed: true, files: (prior.files || []).map((rel) => ({ rel, ok: true, replayed: true })), verified: true, result: prior.result, applied_at: prior.committed_at };
      }
    }
    const op = new StagedOp(ws, type, summary);
    let result;
    try {
      result = build(op);
    } catch (err) {
      op.abort();
      if (op.entries.length) logOp(ws, { op_id: op.id, phase: 'failed', type, actor: ws.actor, error: err.message });
      throw err;
    }
    if (!op.entries.length) {
      op.abort();
      return { op_id: null, noop: true, files: [], verified: true, result };
    }
    if (idempotencyKey) {
      op.writeJson(appliedRel(idempotencyKey), {
        schema_version: 'cr.applied.v1',
        key: idempotencyKey,
        payload_sha256: payloadHash,
        op_id: op.id,
        type,
        committed_at: new Date().toISOString(),
        actor: ws.actor,
        files: op.entries.filter((e) => e.kind === 'write').map((e) => e.rel).concat(op.entries.filter((e) => e.kind === 'move').map((e) => e.to)),
        result: compactResult(result),
      }, { mode: 'create' });
    }
    renewLock(ws);
    op.seal();
    const gen = readGen(ws);
    writeGen(ws, { generation: gen.generation, state: 'applying', op_id: op.id, at: new Date().toISOString() });
    logOp(ws, { op_id: op.id, phase: 'begin', type, actor: ws.actor, summary: op.summary, entries: op.entries.length });
    try {
      applyManifest(ws, op.manifest(), op.dir);
    } catch (err) {
      logOp(ws, { op_id: op.id, phase: 'apply_interrupted', type, error: err.message });
      if (err.code === 'LOCK_LOST') {
        throw err;
      }
      throw new OpError(
        'APPLY_INTERRUPTED',
        `The write was interrupted (${err.message}). It is journaled and will be completed automatically on the next start, or run: node dashboard/cli.js recover`
      );
    }
    const files = verifyEntries(ws, op.entries);
    const verified = files.every((f) => f.ok);
    if (!verified) {
      const kept = quarantine(ws, op.id, op.dir);
      writeGen(ws, { generation: gen.generation + 1, state: 'stable', op_id: op.id, at: new Date().toISOString(), note: 'unverified commit; writes blocked' });
      blockWrites(ws, { op_id: op.id, type, reason: 'commit did not verify', mismatched: files.filter((f) => !f.ok).map((f) => f.rel), evidence: path.relative(ws.root, kept).split(path.sep).join('/') });
      logOp(ws, { op_id: op.id, phase: 'commit_unverified', type, actor: ws.actor, files: files.map((f) => f.rel) });
      throw new OpError('COMMIT_UNVERIFIED', `Files written by this operation did not read back correctly: ${files.filter((f) => !f.ok).map((f) => f.rel).join(', ')}. The staged copies are kept as evidence and further writes are blocked. Run: node dashboard/cli.js recover --status`, { files });
    }
    writeGen(ws, { generation: gen.generation + 1, state: 'stable', op_id: op.id, at: new Date().toISOString() });
    logOp(ws, { op_id: op.id, phase: 'commit', type, actor: ws.actor, summary: op.summary, files: files.map((f) => f.rel) });
    finishStaging(ws, op.dir, op.manifest({ committed: true, committed_at: new Date().toISOString() }));
    for (const fn of op.after) {
      try { fn(); } catch (_) { /* after-commit hooks are best effort */ }
    }
    return { op_id: op.id, noop: false, files, verified, result };
  });
}

// Removes a committed staging folder. Where deletes are not allowed, the
// manifest is marked committed so recovery only cleans it up later.
function finishStaging(ws, dir, committedManifest) {
  if (tryRemove(ws, dir, { dir: true }) && !exists(dir)) return true;
  try {
    writeDurable(path.join(dir, 'manifest.json'), jsonText(committedManifest));
  } catch (_) { /* cannot even mark it; recovery re-verifies */ }
  return false;
}

function recoverLocked(ws) {
  const stagingRoot = path.join(crDir(ws), 'staging');
  const results = [];
  const blocked = blockedState(ws);
  for (const name of listDir(stagingRoot, { dirs: true })) {
    const dir = path.join(stagingRoot, name);
    if (blocked && blocked.op_id === name) {
      results.push({ op_id: name, action: 'held_as_evidence' });
      continue;
    }
    let manifest = null;
    try {
      manifest = readJson(path.join(dir, 'manifest.json'), null);
    } catch (_) {
      manifest = null;
    }
    if (manifest && manifest.committed) {
      // Already committed and verified; only the cleanup was deferred.
      if (tryRemove(ws, dir, { dir: true })) results.push({ op_id: name, action: 'cleaned_up' });
      continue;
    }
    if (manifest && manifest.ready && !manifest.abandoned) {
      try {
        const gen = readGen(ws);
        writeGen(ws, { generation: gen.generation, state: 'applying', op_id: name, at: new Date().toISOString(), recovering: true });
        applyManifest(ws, manifest, dir);
        const files = verifyEntries(ws, manifest.entries);
        const ok = files.every((f) => f.ok);
        writeGen(ws, { generation: gen.generation + 1, state: 'stable', op_id: name, at: new Date().toISOString() });
        if (!ok) {
          const kept = quarantine(ws, name, dir);
          blockWrites(ws, { op_id: name, type: manifest.type, reason: 'recovered operation did not verify', mismatched: files.filter((f) => !f.ok).map((f) => f.rel), evidence: path.relative(ws.root, kept).split(path.sep).join('/') });
          results.push({ op_id: name, action: 'recovery_unverified', type: manifest.type });
          continue;
        }
        finishStaging(ws, dir, { ...manifest, committed: true, committed_at: new Date().toISOString(), recovered: true });
        logOp(ws, { op_id: name, phase: 'recovered_forward', type: manifest.type, files: files.map((f) => f.rel) });
        results.push({ op_id: name, action: 'rolled_forward', type: manifest.type });
      } catch (err) {
        const kept = quarantine(ws, name, dir);
        blockWrites(ws, { op_id: name, type: manifest.type, reason: `recovery failed: ${err.message}`, evidence: path.relative(ws.root, kept).split(path.sep).join('/') });
        logOp(ws, { op_id: name, phase: 'recovery_failed', type: manifest.type, error: err.message });
        results.push({ op_id: name, action: 'recovery_failed', error: err.message });
      }
    } else {
      const removed = tryRemove(ws, dir, { dir: true });
      if (!removed && !(manifest && manifest.abandoned)) {
        try { writeDurable(path.join(dir, 'manifest.json'), jsonText({ op_id: name, ready: false, abandoned: true, at: new Date().toISOString() })); } catch (_) { /* ignore */ }
      }
      if (!(manifest && manifest.abandoned && !removed)) {
        logOp(ws, { op_id: name, phase: 'rolled_back', note: 'Operation never sealed; nothing had been written to records.' });
        results.push({ op_id: name, action: 'rolled_back' });
      }
    }
  }
  // Housekeeping a run that can delete does for one that could not.
  if (capabilities(ws).delete) {
    for (const f of listDir(crDir(ws), { dirs: false })) {
      if (/^lock-broken-|^doctor-[0-9a-f]+\.probe$/.test(f)) tryRemove(ws, path.join(crDir(ws), f));
    }
  }
  return results;
}

function pendingRecovery(ws) {
  const stagingRoot = path.join(crDir(ws), 'staging');
  return listDir(stagingRoot, { dirs: true }).map((name) => {
    const m = readJson(path.join(stagingRoot, name, 'manifest.json'), null);
    return { op_id: name, state: !m ? 'unsealed' : m.committed ? 'committed_cleanup_pending' : m.abandoned ? 'abandoned' : m.ready ? 'sealed' : 'unsealed', type: m && m.type };
  });
}

function recover(ws) {
  const pending = pendingRecovery(ws);
  if (!pending.length) return [];
  if (pending.every((p) => p.state === 'committed_cleanup_pending' || p.state === 'abandoned') && !capabilities(ws).delete) return [];
  return withLock(ws, 'recover', () => recoverLocked(ws));
}

// Owner action after inspecting a blocked commit: re-verify the evidence; clear
// the block when current files match, or when the owner forces it with a reason.
function resolveBlock(ws, { force = false, reason = null } = {}) {
  return withLock(ws, 'resolve_block', () => {
    const b = blockedState(ws);
    if (!b) return { status: 'not_blocked' };
    const evidenceDir = b.evidence ? ws.abs(b.evidence) : null;
    const manifest = evidenceDir ? readJson(path.join(evidenceDir, 'manifest.json'), null) : null;
    const files = manifest ? verifyEntries(ws, manifest.entries || []) : [];
    const matches = manifest && files.length > 0 && files.every((f) => f.ok);
    if (!matches && !force) {
      return { status: 'still_blocked', block: b, files, message: 'Current files still differ from the staged copies. Inspect the evidence folder; to unblock anyway run recover --resolve --force --reason "..."' };
    }
    if (force && !String(reason || '').trim()) throw new OpError('INVALID', 'Unblocking without a match needs --reason.');
    tryRemove(ws, ws.abs(BLOCK_REL)) || writeDurable(ws.abs(BLOCK_REL), '');
    logOp(ws, { phase: 'writes_unblocked', op_id: b.op_id, method: matches ? 'files_match' : 'forced', reason: reason || null, evidence: b.evidence || null });
    return { status: 'unblocked', method: matches ? 'files_match' : 'forced', evidence_kept: b.evidence || null };
  });
}

module.exports = {
  OpError,
  runOp,
  withLock,
  renewLock,
  recover,
  recoverLocked,
  pendingRecovery,
  resolveBlock,
  blockedState,
  assertNotBlocked,
  readConsistent,
  readGen,
  lockState,
  capabilities,
  replaceFile,
  readApplied,
  appliedRel,
  logOp,
  OPLOG_REL,
  GEN_REL,
  BLOCK_REL,
  StagedOp,
  applyManifest,
  LEASE_MS,
};
