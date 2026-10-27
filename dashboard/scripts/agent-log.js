'use strict';
// What the agent lane's trusted scripts print in a GitHub Actions log
// (Engineering v3, change 5). The reasons a check gives are its error
// annotations, the part of agent-guard and agent-verify that /revise reads
// back (agent-revise.js). Everything else printed is data, with workflow
// commands off around it, so a path, an issue's words or a test's output
// never becomes an annotation, an output or a mask.
//
// A candidate's own code runs in agent-verify; what it writes there is the
// candidate speaking about itself, as its files do, and is read as such.

const crypto = require('crypto');

const MAX = 10; // GitHub keeps at most ten error annotations per step
const MAX_CHARS = 500;
const inActions = (env = process.env) => env.GITHUB_ACTIONS === 'true';
const flat = (s, n) => String(s || '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

// One `::error` line per reason, at most ten: past ten, nine and a line
// saying how many more the job summary holds.
function errorLines(title, reasons) {
  const all = (reasons || []).map((r) => flat(r, MAX_CHARS)).filter(Boolean);
  const kept = all.length > MAX ? [...all.slice(0, MAX - 1), `${all.length - (MAX - 1)} more reasons are in the job summary`] : all;
  return kept.map((r) => `::error title=${title}::${escapeData(r)}`);
}

function write(text, { title = null, reasons = [], env = process.env, stdout = process.stdout } = {}) {
  if (!inActions(env)) { if (text) stdout.write(`${text}\n`); return; }
  if (text) {
    const stop = crypto.randomBytes(16).toString('hex');
    stdout.write(`::stop-commands::${stop}\n${text}\n::${stop}::\n`);
  }
  const lines = title ? errorLines(title, reasons) : [];
  if (lines.length) stdout.write(`${lines.join('\n')}\n`);
}

module.exports = { MAX, MAX_CHARS, escapeData, errorLines, write };
