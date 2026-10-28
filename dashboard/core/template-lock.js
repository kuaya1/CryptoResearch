'use strict';
// Published prompt templates, read at run time (D5, Eric 2026-10-28): from the
// code's own templates/ only, never a workspace copy, and only when the text
// matches its pin in the LOCK.json beside it. One changed byte is an INTEGRITY
// refusal before anything is built from it, so nothing is written. A change
// to a published template is the next version, pinned in its LOCK.json.

const fs = require('fs');
const path = require('path');
const { sha256 } = require('./fsx');
const { OpError } = require('./ops');

// The code's templates folder. Tests point it at a copy; nothing else does.
const state = { root: path.join(__dirname, '..', '..', 'templates') };

// Each lock and how its pins were published: 'bytes' (the file as stored) or
// 'lf' (the text with LF line ends, as templates/tickets/LOCK.json was).
const LOCKS = {
  research: { dir: '', eol: 'bytes', label: 'research template', lock: 'templates/LOCK.json' },
  tickets: { dir: 'tickets', eol: 'lf', label: 'ticket template', lock: 'templates/tickets/LOCK.json' },
  forensics: { dir: 'forensics', eol: 'bytes', label: 'forensic template', lock: 'templates/forensics/LOCK.json' },
};

function pinOf(kind) {
  const spec = LOCKS[kind];
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(state.root, spec.dir, 'LOCK.json'), 'utf8'));
    return lock && lock.sha256 && typeof lock.sha256 === 'object' ? lock.sha256 : {};
  } catch (_) {
    return {};
  }
}

// The file's SHA-256 as its lock pins it.
function hashOf(kind, buf) {
  return sha256(LOCKS[kind].eol === 'lf' ? buf.toString('utf8').replace(/\r\n/g, '\n') : buf);
}

// The text of one published template (name relative to its lock's folder,
// with forward slashes, e.g. 'execution/chatgpt.v2.md'), or an OpError.
function lockedText(kind, name) {
  const spec = LOCKS[kind];
  if (!spec) throw new Error(`Unknown template lock ${kind}`);
  let buf;
  try {
    buf = fs.readFileSync(path.join(state.root, spec.dir, ...name.split('/')));
  } catch (_) {
    throw new OpError('NOT_FOUND', `The ${spec.label} ${name} is missing.`);
  }
  const want = pinOf(kind)[name];
  if (!want) throw new OpError('INTEGRITY', `The ${spec.label} ${name} has no pin in ${spec.lock}, so nothing was built from it.`, { template: name, lock: spec.lock });
  const got = hashOf(kind, buf);
  if (got !== want) throw new OpError('INTEGRITY', `The ${spec.label} ${name} does not match its pinned SHA-256 in ${spec.lock}, so nothing was built from it. A change to a published template is the next version, pinned there.`, { template: name, lock: spec.lock, pinned: want, found: got });
  return buf.toString('utf8').replace(/^﻿/, '');
}

module.exports = { LOCKS, lockedText, hashOf, pinOf, state };
