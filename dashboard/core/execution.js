'use strict';
// Execution notes: how one model carries out a research run.
//
// The research prompt of a run is one canonical text, byte for byte the same
// for every model (prompts.js). An execution note sits beside it for one
// model only. It adds no research question, scope or grading rule: it says
// how to work through the prompt (fetch it whole, research independently,
// judge where the evidence supports it, check the JSON block against the
// report before finishing). Only ChatGPT has one. cr-execution-chatgpt@1 was
// written after its reports of 2026-10-03 left "timing and executable
// liquidity" unknown for want of a position size no prompt states.
// cr-execution-chatgpt@2 (2026-10-04, for jobs made from then on) replaced
// "give a score or a range" with point-or-named-range-or-unknown, asks for
// primary sources before grading, one bounded retry for a failed source,
// evidence per component, a checked JSON block, one project per save, and
// says a withheld grade is acceptable. Jobs keep the note they were frozen with.
//
// A note is frozen with its job, like the prompt: rendered when the job is
// created (a new run, or a model added to a run), written next to prompt.md
// and recorded on the job with its SHA-256. It is delivered exactly as frozen
// (through the desk connection, as the API's instructions, or with the
// pasted prompt) and checked against that hash first. Jobs made before notes
// existed have none and get none: their runs keep what they were made with.

const fs = require('fs');
const path = require('path');
const { sha256 } = require('./fsx');

// The note a new job of each model is frozen with. Published notes never
// change: a revision is a new file and version.
const NOTES = {
  chatgpt: { ref: 'cr-execution-chatgpt@2', file: 'execution/chatgpt.v2.md' },
};
const PUBLISHED = {
  'cr-execution-chatgpt@1': 'execution/chatgpt.v1.md',
  'cr-execution-chatgpt@2': 'execution/chatgpt.v2.md',
};

const notePath = (runDir, provider) => `${runDir}/execution.${provider}.md`;

// The note for one model's job in a run, rendered from its template with the
// run's own values; null for a model that has none.
function renderNote(ws, provider, run) {
  const spec = NOTES[provider];
  if (!spec) return null;
  const template = fs.readFileSync(path.join(ws.root, 'templates', spec.file), 'utf8');
  const h = run.horizon && typeof run.horizon === 'object' ? run.horizon : {};
  const values = {
    RUN_ID: run.run_id,
    PROMPT_VERSION: run.prompt ? run.prompt.version : 'unknown',
    PROMPT_SHA256: run.prompt ? run.prompt.sha256 : 'unknown',
    HORIZON_START: h.start_date || 'the start of the horizon',
    HORIZON_END: h.end_date || 'the end of the horizon',
  };
  const text = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(values, k) ? String(values[k]) : m));
  return { ref: spec.ref, text };
}

// Writes the note for a job inside an operation and returns the record kept
// on the job ({ ref, path, sha256, chars }), or null.
function freezeNote(op, ws, run, provider, runDir) {
  const note = renderNote(ws, provider, run);
  if (!note) return null;
  const rel = notePath(runDir, provider);
  op.write(rel, note.text, { mode: 'create' });
  return { ref: note.ref, path: rel, sha256: sha256(note.text), chars: note.text.length };
}

// The frozen note of a job, read back and checked against the hash recorded
// when it was frozen. null when the job has none. A file that cannot be read
// or no longer matches is not given out (nothing is rebuilt from the
// template, which may have changed since). Read-only.
function readNote(ws, run, provider) {
  const job = run && run.jobs ? run.jobs[provider] : null;
  const rec = job && job.execution;
  if (!rec || !rec.path) return null;
  let buf;
  try {
    buf = fs.readFileSync(ws.abs(rec.path));
  } catch (err) {
    return { text: null, delivery: { status: 'unreadable', ref: rec.ref, frozen_sha256: rec.sha256 || null, message: `This job's execution notes could not be read (${err.code || err.message}), so they are not given out. Tell Eric; never rebuild them from the templates.` } };
  }
  const sha = sha256(buf);
  if (!rec.sha256 || sha !== rec.sha256) {
    return { text: null, delivery: { status: 'hash_mismatch', ref: rec.ref, frozen_sha256: rec.sha256 || null, file_sha256: sha, message: 'This job\'s execution notes no longer match the SHA-256 recorded when they were frozen, so they are not given out. Tell Eric; never rebuild them from the templates.' } };
  }
  const text = buf.toString('utf8');
  return { text, delivery: { status: 'verified', ref: rec.ref, sha256: sha, chars: text.length, note: 'Execution notes for this model only, frozen with its job. The research prompt is unchanged and the same for every model; where the two seem to differ, the prompt decides.' } };
}

module.exports = { NOTES, PUBLISHED, notePath, renderNote, freezeNote, readNote };
