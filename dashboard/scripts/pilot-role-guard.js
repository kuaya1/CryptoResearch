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
// tools; this guard closes the built-in tools that could cross over (the
// other role's CLI, or a file in the repository).
//
// Isolation (cr-pilot-isolation@1, the cohesion audit's M5, 2026-10-29): each
// role has its own scratch folder, <temp>/cr-pilot/<role>/ (one subfolder per
// run or ticket by convention); Write saves only there, and a desk import
// takes its --text-file only from there. Read, Grep and Glob are guarded too:
// neither role reads the desk's records (projects/, where drafts, tickets,
// other models' reports and receipts live, and the other record folders),
// any other temporary folder (the other role's scratch, other sessions'),
// or Claude Code's own session folder (~/.claude, where transcripts live). A
// search may not start above a refused folder. The Prosecutor gets the
// completed Researcher report only as frozen into its prompt (tickets prompt
// / start_ticket); the Researcher gets nothing of the Prosecutor's. The
// online route has no server-side role split: there the agent files' tool
// lists (the client's configuration) are the boundary.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ISOLATION_VERSION = 'cr-pilot-isolation@1';
// The desk's record folders at the workspace root: never read by either role.
const RECORDS = ['projects', 'inbox', 'portfolio', 'paper', 'backups', 'logs', 'archive', 'engineering', 'scout', 'project-context', '.cr'];
const scratchOf = (tmp, role, P = path) => P.join(tmp, 'cr-pilot', role);

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

// A path as the guard compares it: resolved from the working folder, Git Bash
// spelling read as Windows, and on this machine through any links.
function resolved(p, { cwd, root, platform }) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const file = P.resolve(fromShell(cwd || root, platform), fromShell(p, platform));
  return platform === process.platform ? real(file) : file;
}
const realOn = (x, platform) => (platform === process.platform ? real(x) : x);

// Why a path is closed to this role, or null when it may be read. `search`:
// the path is where a search starts, so a refused folder under it is refused.
function readBlock(role, file, { root, tmp, home, platform }, search = false) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const r = realOn(root, platform);
  const t = realOn(tmp, platform);
  const mine = realOn(scratchOf(tmp, role, P), platform);
  const closed = [
    ...RECORDS.map((d) => ({ dir: P.join(r, d), why: `the desk's records (${d}/) are not read here: the work comes from the frozen prompt and the desk's commands.` })),
    ...(home ? [{ dir: realOn(P.join(home, '.claude'), platform), why: 'Claude Code\'s session folder (transcripts) is not read here.' }] : []),
  ];
  for (const c of closed) {
    if (inside(file, c.dir, P, platform, true)) return c.why;
    if (search && inside(c.dir, file, P, platform, true)) return `a search may not start above a closed folder: ${c.why}`;
  }
  if (inside(file, t, P, platform, true) && !inside(file, mine, P, platform, true)) return `in the temporary folder only this role's own scratch (${scratchOf(tmp, role, P)}) is read: not the other role's, nor another session's.`;
  if (search && inside(t, file, P, platform, true)) return 'a search may not start at or above the temporary folder: only this role\'s own scratch is read.';
  return null;
}

function readDecision(role, tool, ti, ctx) {
  const P = ctx.platform === 'win32' ? path.win32 : path.posix;
  if (tool === 'Read') {
    if (typeof ti.file_path !== 'string' || !ti.file_path.trim()) return { allow: false, reason: 'Read needs a file path.' };
    const why = readBlock(role, resolved(ti.file_path, ctx), ctx);
    return why ? { allow: false, reason: why } : { allow: true };
  }
  // Grep and Glob: where the search starts (the working folder when none is
  // given), and a Glob pattern that stays under it.
  const start = typeof ti.path === 'string' && ti.path.trim() ? ti.path : ctx.cwd || ctx.root;
  const pattern = tool === 'Glob' ? ti.pattern : ti.glob;
  if (typeof pattern === 'string' && (/(^|[\\/])\.\.([\\/]|$)/.test(pattern) || P.isAbsolute(fromShell(pattern, ctx.platform)) || /^[a-zA-Z]:/.test(pattern) || pattern.startsWith('~'))) return { allow: false, reason: `${tool}'s pattern stays under where the search starts: no "..", no absolute path.` };
  const why = readBlock(role, resolved(start, ctx), ctx, true);
  return why ? { allow: false, reason: why } : { allow: true };
}

function bashDecision(role, command, { cwd, root, platform, tmp }) {
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
  // A desk import reads its text only from this role's own scratch, so the
  // other role's file (or any other) is never filed as this one's work.
  const texts = optionValue(rest, '--text-file');
  if (texts.length) {
    const P2 = platform === 'win32' ? path.win32 : path.posix;
    const mine = realOn(scratchOf(tmp, role, P2), platform);
    if (texts.length !== 1 || !texts[0] || !inside(resolved(texts[0], { cwd, root, platform }), mine, P2, platform)) return { allow: false, reason: `--text-file is read only from this role's own scratch folder (${scratchOf(tmp, role, P2)}).` };
  }
  return { allow: true };
}

function writeDecision(role, filePath, { cwd, root, tmp, platform }) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  if (typeof filePath !== 'string' || !filePath.trim()) return { allow: false, reason: 'Write needs a file path.' };
  const native = platform === process.platform;
  const file = P.resolve(fromShell(cwd || root, platform), fromShell(filePath, platform));
  const f = native ? real(file) : file;
  const t = native ? real(tmp) : tmp;
  const r = native ? real(root) : root;
  if (inside(f, r, P, platform, true)) return { allow: false, reason: 'Write never saves inside the repository.' };
  if (!inside(f, t, P, platform)) return { allow: false, reason: `Write saves scratch files in the system's temporary folder only (${tmp}).` };
  const mine = native ? real(scratchOf(tmp, role, P)) : scratchOf(tmp, role, P);
  if (!inside(f, mine, P, platform)) return { allow: false, reason: `Write saves only in this role's own scratch folder (${scratchOf(tmp, role, P)}), one subfolder per run or ticket.` };
  return { allow: true };
}

// The guard's answer for one hook input: { allow, reason }.
function decide(role, input, { root = ROOT, tmp = os.tmpdir(), home = os.homedir(), platform = process.platform } = {}) {
  if (!Object.prototype.hasOwnProperty.call(ROLES, role)) return { allow: false, reason: `unknown role ${JSON.stringify(role)}.` };
  if (!input || typeof input !== 'object') return { allow: false, reason: 'the hook input could not be read.' };
  const ti = input.tool_input || {};
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : null;
  if (input.tool_name === 'Bash') return bashDecision(role, ti.command, { cwd, root, platform, tmp });
  if (input.tool_name === 'Write') return writeDecision(role, ti.file_path, { cwd, root, tmp, platform });
  if (['Read', 'Grep', 'Glob'].includes(input.tool_name)) return readDecision(role, input.tool_name, ti, { cwd, root, tmp, home, platform });
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

module.exports = { decide, words, ROLES, RECORDS, ISOLATION_VERSION, scratchOf };
