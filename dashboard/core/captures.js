'use strict';
// Durable capture of a paid provider answer (audit F1, 2026-10-02 review).
//
// A paid answer is first written here, outside the workspace lock, the moment
// it arrives. Only then does the runner try the normal locked commit that puts
// the answer into run.json and responses/. If that commit cannot run (another
// process holds the lock, writes are blocked, the disk refuses), the answer is
// not lost: the next runner finds the capture, checks it against the attempt it
// claims to answer and commits it, without asking the provider again.
//
//   .cr/captures/<attempt_id>.json     { schema_version, body_sha256, body }
//
// - One file per attempt ID. It appears whole or not at all: the bytes go to a
//   temporary file first, which is then hard-linked into place (or, where links
//   are not allowed, created exclusively). Names starting with "." are
//   unfinished and never read.
// - A second write for the same attempt with the same body is a no-op; with a
//   different body it is a conflict: both are kept and nothing is imported
//   automatically.
// - The body binds the answer to its run, provider, attempt number, attempt ID,
//   prompt hash and evidence-packet hash; recovery refuses anything else.
// - A capture is removed only after run.json records the same capture hash in
//   a verified commit. Until then it stays, so a crash at any point after the
//   capture loses nothing.
// - .cr is not in backups or packages: a capture is a short-lived handoff, and
//   doctor warns while one is waiting.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sha256, mkdirp, writeDurable, listDir } = require('./fsx');

const SCHEMA = 'cr.research-capture.v1';
const ATTEMPT_ID_RE = /^att_[A-Za-z0-9_-]{6,100}$/;

class CaptureError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

function captureDir(ws) {
  return path.join(ws.root, '.cr', 'captures');
}

function captureRel(attemptId) {
  return `.cr/captures/${attemptId}.json`;
}

function capturePath(ws, attemptId) {
  if (!ATTEMPT_ID_RE.test(String(attemptId || ''))) throw new CaptureError('CAPTURE_BAD_ID', `Not a valid attempt ID: ${attemptId}`);
  return path.join(captureDir(ws), `${attemptId}.json`);
}

function plainError(error) {
  if (!error) return null;
  return {
    kind: error.kind || 'error',
    message: String(error.message || error),
    http_status: error.httpStatus || null,
    request_id: error.requestId || null,
    code: error.code || null,
    not_sent: Boolean(error.notSent),
    retryable: Boolean(error.retryable),
    usage: error.usage || null,
    attested: error.attested || null,
    raw: error.raw === undefined ? null : error.raw,
  };
}

function bodyFor({ run, provider, attempt, result, error, finishedAt, mode }) {
  return {
    run_id: run.run_id,
    project_id: run.project_id,
    provider,
    attempt: attempt.n,
    attempt_id: attempt.attempt_id,
    mode: mode || null,
    prompt_sha256: run.prompt.sha256,
    evidence_packet_sha256: run.evidence_packet.sha256,
    dispatched_at: attempt.dispatched_at || null,
    finished_at: finishedAt,
    captured_at: new Date().toISOString(),
    pid: process.pid,
    result: result ? { text: result.text, text_sha256: sha256(String(result.text)), attested: result.attested || null, usage: result.usage || null, raw: result.raw === undefined ? null : result.raw } : null,
    error: result ? null : plainError(error),
  };
}

function encode(body) {
  const bodyText = JSON.stringify(body);
  return `${JSON.stringify({ schema_version: SCHEMA, body_sha256: sha256(bodyText), body })}\n`;
}

// Parses and self-checks a capture file's bytes. Never throws.
function decode(buf) {
  let doc;
  try {
    doc = JSON.parse(buf.toString('utf8'));
  } catch (_) {
    return { ok: false, reason: 'not valid JSON (incomplete or damaged)' };
  }
  if (!doc || doc.schema_version !== SCHEMA || !doc.body || typeof doc.body !== 'object') return { ok: false, reason: 'not a research capture' };
  if (sha256(JSON.stringify(doc.body)) !== doc.body_sha256) return { ok: false, reason: 'its content does not match its own hash (damaged)' };
  if (doc.body.result && sha256(String(doc.body.result.text)) !== doc.body.result.text_sha256) return { ok: false, reason: 'its answer text does not match its hash (damaged)' };
  return { ok: true, body: doc.body, body_sha256: doc.body_sha256 };
}

function fsyncDir(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (_) { /* not supported on every platform (Windows) */ }
}

const NO_LINK = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EINVAL', 'EMLINK']);

// Writes the capture for one attempt. Returns { id, rel, sha256, bytes, already }.
// Throws CaptureError (CAPTURE_CONFLICT, CAPTURE_UNVERIFIED) or the filesystem
// error; the caller treats any throw as "not captured".
function writeCapture(ws, args) {
  const body = bodyFor(args);
  const text = encode(body);
  const want = sha256(text);
  const id = body.attempt_id;
  const final = capturePath(ws, id);
  const dir = path.dirname(final);
  mkdirp(dir);
  const tmp = path.join(dir, `.${id}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  writeDurable(tmp, text);
  let placed = false;
  let existed = false;
  try {
    try {
      fs.linkSync(tmp, final);
      placed = true;
    } catch (err) {
      if (err.code === 'EEXIST') existed = true;
      else if (!NO_LINK.has(err.code)) throw err;
    }
    if (!placed && !existed) {
      // No hard links here: create the file exclusively. A crash part way
      // leaves a damaged file that decode() refuses, never a wrong answer.
      let fd;
      try {
        fd = fs.openSync(final, 'wx');
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        existed = true;
      }
      if (fd !== undefined) {
        try {
          fs.writeFileSync(fd, text);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        placed = true;
      }
    }
    if (existed) {
      const cur = decode(fs.readFileSync(final));
      const same = (b) => JSON.stringify({ ...b, captured_at: null, pid: null });
      if (cur.ok && same(cur.body) === same(body)) {
        // Same answer captured before (only the capture time or process differs).
        return { id, rel: captureRel(id), sha256: sha256(fs.readFileSync(final)), bytes: fs.statSync(final).size, already: true };
      }
      const keep = path.join(dir, `conflict-${id}-${crypto.randomBytes(4).toString('hex')}.json`);
      fs.renameSync(tmp, keep);
      throw new CaptureError('CAPTURE_CONFLICT', `A different capture already exists for attempt ${id}; both are kept (${path.basename(keep)}) and neither is imported automatically.`, { kept: path.basename(keep) });
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* gone, renamed, or cannot delete here: names starting with "." are never read */ }
  }
  fsyncDir(dir);
  const back = fs.readFileSync(final);
  if (sha256(back) !== want) throw new CaptureError('CAPTURE_UNVERIFIED', `The capture for attempt ${id} did not read back with the bytes written.`);
  return { id, rel: captureRel(id), sha256: want, bytes: back.length, already: false };
}

// Reads the capture for an attempt: { missing } | { ok:false, reason, rel } | { ok, body, sha256, rel }.
function readCapture(ws, attemptId) {
  let p;
  try {
    p = capturePath(ws, attemptId);
  } catch (err) {
    return { missing: true };
  }
  let buf;
  try {
    buf = fs.readFileSync(p);
  } catch (err) {
    if (err.code === 'ENOENT') return { missing: true };
    return { ok: false, rel: captureRel(attemptId), reason: `cannot be read (${err.code || err.message})` };
  }
  const d = decode(buf);
  if (!d.ok) return { ok: false, rel: captureRel(attemptId), reason: d.reason };
  return { ok: true, rel: captureRel(attemptId), sha256: sha256(buf), body: d.body };
}

// Checks a capture against the attempt it claims to answer. Returns the
// outcome to commit ({ result } or { error }) or the reason it does not match.
function bindCapture(cap, run, provider, attempt) {
  const b = cap.body;
  const bad = [];
  if (b.run_id !== run.run_id) bad.push('run');
  if (b.project_id !== run.project_id) bad.push('project');
  if (b.provider !== provider) bad.push('provider');
  if (b.attempt !== attempt.n) bad.push('attempt number');
  if (!attempt.attempt_id || b.attempt_id !== attempt.attempt_id) bad.push('attempt ID');
  if (b.prompt_sha256 !== run.prompt.sha256) bad.push('prompt hash');
  if (b.evidence_packet_sha256 !== run.evidence_packet.sha256) bad.push('evidence packet hash');
  if (!b.result && !b.error) bad.push('outcome');
  if (bad.length) return { ok: false, reason: `${cap.rel} does not match this attempt (${bad.join(', ')})` };
  if (b.result) return { ok: true, finishedAt: b.finished_at, result: { text: b.result.text, attested: b.result.attested || {}, usage: b.result.usage || null, raw: b.result.raw } };
  const e = b.error;
  const error = Object.assign(new Error(e.message), { kind: e.kind, httpStatus: e.http_status, requestId: e.request_id, code: e.code, notSent: e.not_sent, retryable: e.retryable, usage: e.usage, attested: e.attested, raw: e.raw });
  return { ok: true, finishedAt: b.finished_at, error };
}

// Removes a capture, but only the exact bytes that were committed.
function removeCapture(ws, attemptId, expectSha) {
  let p;
  try {
    p = capturePath(ws, attemptId);
  } catch (_) {
    return false;
  }
  try {
    const cur = fs.readFileSync(p);
    if (expectSha && sha256(cur) !== expectSha) return false;
    fs.unlinkSync(p);
    return true;
  } catch (_) {
    return false;
  }
}

// Every finished capture file: [{ attempt_id, rel, ok, body?, sha256?, reason? }].
function listCaptures(ws) {
  const out = [];
  for (const name of listDir(captureDir(ws), { dirs: false })) {
    if (name.startsWith('.') || !name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (!ATTEMPT_ID_RE.test(id)) {
      out.push({ attempt_id: null, rel: `.cr/captures/${name}`, ok: false, reason: name.startsWith('conflict-') ? 'conflicting second capture kept for inspection' : 'unexpected file name' });
      continue;
    }
    const c = readCapture(ws, id);
    out.push({ attempt_id: id, ...c });
  }
  return out;
}

// Unfinished temporary files a stopped writer left behind (older than an hour).
function removeStaleTemps(ws, maxAgeMs = 3600000) {
  let n = 0;
  for (const name of listDir(captureDir(ws), { dirs: false })) {
    if (!name.startsWith('.') || !name.includes('.tmp-')) continue;
    const p = path.join(captureDir(ws), name);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) { fs.unlinkSync(p); n += 1; }
    } catch (_) { /* cannot delete here */ }
  }
  return n;
}

module.exports = { SCHEMA, ATTEMPT_ID_RE, CaptureError, captureDir, captureRel, writeCapture, readCapture, bindCapture, removeCapture, listCaptures, removeStaleTemps, decode, encode, bodyFor };
