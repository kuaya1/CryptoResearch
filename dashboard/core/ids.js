'use strict';
const crypto = require('crypto');

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Generic record IDs used in folder and file names (report IDs, entry IDs, ...).
const RECORD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

function slugify(input, max = 48) {
  const s = String(input || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, max).replace(/-+$/g, '');
}

function randomId(len = 6) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// 2026-10-01T133005Z
function compactTs(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '');
}

// 2026-10-01T13-30-05-123Z (safe in Windows file names)
function fileTs(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function isProjectId(s) {
  return typeof s === 'string' && PROJECT_ID_RE.test(s);
}

function isRecordId(s) {
  return typeof s === 'string' && RECORD_ID_RE.test(s) && !s.includes('..');
}

module.exports = { slugify, randomId, compactTs, fileTs, isProjectId, isRecordId, PROJECT_ID_RE, RECORD_ID_RE };
