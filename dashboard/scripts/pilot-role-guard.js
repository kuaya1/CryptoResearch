#!/usr/bin/env node
'use strict';
// The pilot's role guard (D6, Eric 2026-10-28). A PreToolUse hook in each
// pilot sub-agent's own file (.claude/agents/), run as
//
//   node dashboard/scripts/pilot-role-guard.js researcher|prosecutor
//
// with the hook's JSON on stdin. It lets Bash run one `node dashboard/cli.js`
// command of that role's at a time, and Write save only in the system's
// temporary folder. Anything else, and any input it cannot read, is refused
// with exit 2 (the reason on stderr is what the agent sees); the hook's
// `onFailure: block` refuses when the guard cannot run at all.
//
// The tools lists in the agent files keep each role to its own connector
// tools; this guard closes the two built-in tools that could cross over
// (the other role's CLI, or a file in the repository).

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// Each role's desk commands, as the words after `node dashboard/cli.js`.
const ROLES = {
  researcher: [['doctor'], ['research', 'add'], ['research', 'status'], ['research', 'prompt'], ['import-text']],
  prosecutor: [['doctor'], ['tickets', 'start'], ['tickets', 'prompt'], ['tickets', 'import'], ['tickets', 'view']],
};

// The words of one simple command, or null when the text could run more than
// one command or build one at run time: chaining, pipes, redirects,
// subshells, command substitution, a line break, an unclosed quote.
function words(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return null;
  if (/[`\r\n]|\$\(/.test(cmd)) return null;
  const out = [];
  let cur = null;
  let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q === "'") {
      if (ch === "'") q = null;
      else cur += ch;
      continue;
    }
    if (q === '"') {
      if (ch === '"') q = null;
      else if (ch === '\\' && '"\\$'.includes(cmd[i + 1] || '')) cur += cmd[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      q = ch;
      if (cur === null) cur = '';
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur !== null) out.push(cur);
      cur = null;
      continue;
    }
    if (';&|<>()'.includes(ch)) return null;
    if (ch === '\\') {
      if (i + 1 >= cmd.length) return null;
      cur = (cur || '') + cmd[++i];
      continue;
    }
    cur = (cur || '') + ch;
  }
  if (q) return null;
  if (cur !== null) out.push(cur);
  return out;
}

// A path as Git Bash writes it (/c/Users/…) read as Windows does (C:\Users\…).
function fromShell(p, platform) {
  if (platform !== 'win32') return p;
  const m = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(p);
  return m ? `${m[1].toUpperCase()}:\\${(m[2] || '').replace(/\//g, '\\')}` : p;
}

// The path with every existing part resolved through links, so a junction or
// symlink cannot carry a write out of the folder it seems to be in.
function real(p) {
  let dir = p;
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(dir), ...rest);
    } catch (_) {
      const up = path.dirname(dir);
      if (up === dir) return p;
      rest.unshift(path.basename(dir));
      dir = up;
    }
  }
}

// True when file is dir itself (orSame) or somewhere under it.
function inside(file, dir, P, platform, orSame = false) {
  const norm = (x) => (platform === 'win32' ? x.toLowerCase() : x);
  const rel = P.relative(norm(dir), norm(file));
  if (rel === '') return orSame;
  return !rel.startsWith('..') && !P.isAbsolute(rel);
}

function optionValue(ws, name) {
  const vals = [];
  ws.forEach((w, i) => {
    if (w === name) vals.push(ws[i + 1] === undefined ? '' : ws[i + 1]);
    else if (w.startsWith(`${name}=`)) vals.push(w.slice(name.length + 1));
  });
  return vals;
}

function bashDecision(role, command, { cwd, root, platform }) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const ws = words(command);
  if (!ws) return { allow: false, reason: 'only one plain command at a time: no chaining, pipes, redirects, substitution or line breaks.' };
  if (!['node', 'node.exe'].includes(ws[0])) return { allow: false, reason: `only \`node dashboard/cli.js …\` runs here, not \`${ws[0]}\`.` };
  const script = ws[1] ? P.resolve(fromShell(cwd || root, platform), fromShell(ws[1], platform)) : null;
  const cli = P.join(root, 'dashboard', 'cli.js');
  const same = script && (platform === 'win32' ? script.toLowerCase() === cli.toLowerCase() : script === cli);
  if (!same) return { allow: false, reason: 'only the desk\'s own CLI, `node dashboard/cli.js`, runs here.' };
  const rest = ws.slice(2);
  const allowed = ROLES[role].find((c) => c.every((w, i) => rest[i] === w));
  if (!allowed) return { allow: false, reason: `the ${role} runs only ${ROLES[role].map((c) => c.join(' ')).join(', ')}.` };
  if (role === 'researcher') {
    if (allowed[0] === 'import-text') {
      const p = optionValue(rest, '--provider');
      if (p.length !== 1 || p[0] !== 'claude') return { allow: false, reason: 'import-text files Claude\'s report only: give `--provider claude` once.' };
    }
    if (allowed[1] === 'add') {
      const p = optionValue(rest, '--providers');
      if (p.length !== 1 || p[0] !== 'claude') return { allow: false, reason: 'research add opens Claude\'s run only: give `--providers claude` once.' };
    }
  }
  return { allow: true };
}

function writeDecision(filePath, { cwd, root, tmp, platform }) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  if (typeof filePath !== 'string' || !filePath.trim()) return { allow: false, reason: 'Write needs a file path.' };
  const native = platform === process.platform;
  const file = P.resolve(fromShell(cwd || root, platform), fromShell(filePath, platform));
  const f = native ? real(file) : file;
  const t = native ? real(tmp) : tmp;
  const r = native ? real(root) : root;
  if (inside(f, r, P, platform, true)) return { allow: false, reason: 'Write never saves inside the repository.' };
  if (!inside(f, t, P, platform)) return { allow: false, reason: `Write saves scratch files in the system's temporary folder only (${tmp}).` };
  return { allow: true };
}

// The guard's answer for one hook input: { allow, reason }.
function decide(role, input, { root = ROOT, tmp = os.tmpdir(), platform = process.platform } = {}) {
  if (!Object.prototype.hasOwnProperty.call(ROLES, role)) return { allow: false, reason: `unknown role ${JSON.stringify(role)}.` };
  if (!input || typeof input !== 'object') return { allow: false, reason: 'the hook input could not be read.' };
  const ti = input.tool_input || {};
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : null;
  if (input.tool_name === 'Bash') return bashDecision(role, ti.command, { cwd, root, platform });
  if (input.tool_name === 'Write') return writeDecision(ti.file_path, { cwd, root, tmp, platform });
  return { allow: true };
}

function main() {
  const role = process.argv[2];
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) { /* answered below */ }
  let input = null;
  try {
    input = JSON.parse(raw);
  } catch (_) { /* answered below */ }
  const d = decide(role, input);
  if (d.allow) process.exit(0);
  process.stderr.write(`Refused by the pilot's role guard (${role || 'no role'}): ${d.reason}\n`);
  process.exit(2);
}

if (require.main === module) main();

module.exports = { decide, words, ROLES };
