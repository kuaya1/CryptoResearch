'use strict';
// Small filesystem helpers. Everything is synchronous on purpose: this is a
// single-user local tool and synchronous writes keep the commit order obvious.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Windows antivirus/indexers briefly lock freshly written files; retry those.
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

function withRetry(fn, attempts = 10) {
  let delay = 20;
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (err) {
      if (i >= attempts || !RETRYABLE.has(err.code)) throw err;
      sleepSync(delay);
      delay = Math.min(delay * 2, 500);
    }
  }
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeDurable(abs, data) {
  mkdirp(path.dirname(abs));
  const fd = fs.openSync(abs, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Write to a temp file next to the target, then rename over it.
function atomicWrite(abs, data) {
  const tmp = `${abs}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  writeDurable(tmp, data);
  try {
    withRetry(() => fs.renameSync(tmp, abs));
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    throw err;
  }
}

function exists(abs) {
  try {
    fs.accessSync(abs);
    return true;
  } catch (_) {
    return false;
  }
}

function readText(abs, fallback) {
  try {
    return fs.readFileSync(abs, 'utf8').replace(/^﻿/, '');
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw err;
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(String(text).replace(/^﻿/, ''));
  } catch (err) {
    const e = new Error(`Invalid JSON in ${label}: ${err.message}`);
    e.code = 'EBADJSON';
    throw e;
  }
}

function readJson(abs, fallback) {
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw err;
  }
  return parseJson(text, abs);
}

function jsonText(obj) {
  return JSON.stringify(obj, null, 2) + '\n';
}

// dirs: null = everything, true = directories only, false = files only.
function listDir(abs, { dirs = null } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw err;
  }
  return entries
    .filter((e) => dirs === null || (dirs ? e.isDirectory() : e.isFile()))
    .map((e) => e.name)
    .sort();
}

function appendLine(abs, obj) {
  mkdirp(path.dirname(abs));
  fs.appendFileSync(abs, JSON.stringify(obj) + '\n');
}

function readJsonLines(abs, { tail = 0 } = {}) {
  const text = readText(abs, '');
  let lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (tail > 0) lines = lines.slice(-tail);
  return lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch (_) {
      return { _corrupt_line: line.slice(0, 200) };
    }
  });
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function rmrf(abs) {
  fs.rmSync(abs, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function fileInfo(abs) {
  try {
    const st = fs.statSync(abs);
    return { size: st.size, mtimeMs: st.mtimeMs, isFile: st.isFile(), isDirectory: st.isDirectory() };
  } catch (_) {
    return null;
  }
}

module.exports = {
  sha256,
  sleepSync,
  withRetry,
  mkdirp,
  writeDurable,
  atomicWrite,
  exists,
  readText,
  readJson,
  parseJson,
  jsonText,
  listDir,
  appendLine,
  readJsonLines,
  toPosix,
  rmrf,
  fileInfo,
};
