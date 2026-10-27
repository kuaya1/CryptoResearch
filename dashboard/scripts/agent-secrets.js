'use strict';
// The agent lane's scan for key-shaped strings (Engineering v3, change 1;
// audits/2026-10-26-engineering-v3). Whatever the builder produced (its patch,
// its report) is scanned before it leaves the build runner and again before
// it is published: a hit names the file and line and the kind of key, never
// the value.
//
//   node agent-secrets.js --dir <dir>   scan every file in <dir>; a file that
//                                       holds a hit is removed and scan.json
//                                       says where; exit 1 on any hit
//
// It requires nothing outside Node, so the build job copies it out of the
// checkout before the builder starts and runs that copy afterwards.

const fs = require('fs');
const path = require('path');

// The shapes of the keys this desk and its lanes hold or could meet.
const KINDS = [
  ['an Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['an OpenAI key', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/],
  ['a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['a private key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ['an AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['an xAI key', /\bxai-[A-Za-z0-9]{40,}/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}/],
  ['a Stripe live key', /\b[rs]k_live_[0-9A-Za-z]{20,}/],
  ['an npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
];

const kindOf = (line) => { const k = KINDS.find(([, re]) => re.test(line)); return k ? k[0] : null; };

// Every line of `text` that holds a key-shaped string: { line, kind }.
function secretHits(text) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach((l, i) => { const kind = kindOf(l); if (kind) out.push({ line: i + 1, kind }); });
  return out;
}

// A unified diff's added lines that hold one, by the file and line they land
// on: { path, line, kind }. A header line (a file name) that holds one is
// reported as the patch's own line. Removed and context lines are main's.
function patchHits(text) {
  const out = [];
  let file = null;
  let n = 0;
  let prev = '';
  String(text || '').split(/\r?\n/).forEach((l, i) => {
    const before = prev;
    prev = l;
    if (l.startsWith('diff --git ')) { file = null; const kind = kindOf(l); if (kind) out.push({ path: '(patch)', line: i + 1, kind }); return; }
    // "+++ " names the file only right after "--- "; inside a hunk it is an
    // added line that starts with "++ ".
    if (l.startsWith('+++ ') && before.startsWith('--- ')) { file = l.slice(4).replace(/^b\//, ''); const kind = kindOf(l); if (kind) out.push({ path: '(patch)', line: i + 1, kind }); return; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { n = Number(h[1]); return; }
    if (l.startsWith('+')) { const kind = kindOf(l); if (kind) out.push({ path: file || '(patch)', line: n, kind }); n += 1; return; }
    if (l.startsWith(' ')) { n += 1; return; }
    if (!l.startsWith('-') && !l.startsWith('\\')) { const kind = kindOf(l); if (kind) out.push({ path: '(patch)', line: i + 1, kind }); }
  });
  return out;
}

const describe = (h) => `${h.path}:${h.line} (${h.kind})`;

// The CLI: every regular file in a directory. A hit removes that file, so
// what is uploaded after it never carries one.
function scanDir(dir) {
  const hits = [];
  const skipped = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (name === 'scan.json') continue;
    const abs = path.join(dir, name);
    const st = fs.lstatSync(abs);
    if (!st.isFile()) { skipped.push(name); fs.rmSync(abs, { recursive: true, force: true }); continue; }
    const text = fs.readFileSync(abs, 'utf8');
    const found = (name.endsWith('.diff') ? patchHits(text) : secretHits(text).map((h) => ({ path: name, ...h }))).map((h) => ({ file: name, ...h }));
    if (found.length) { hits.push(...found); fs.rmSync(abs, { force: true }); }
  }
  fs.writeFileSync(path.join(dir, 'scan.json'), JSON.stringify({ hits: hits.map((h) => ({ file: h.file, path: h.path, line: h.line, kind: h.kind })), removed: [...new Set(hits.map((h) => h.file))], skipped }, null, 2));
  return { hits, skipped };
}

function main(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) flags[argv[i].replace(/^--/, '')] = argv[i + 1];
  if (!flags.dir || !fs.existsSync(flags.dir)) { process.stderr.write('Usage: agent-secrets.js --dir <dir>\n'); return 2; }
  const r = scanDir(flags.dir);
  if (r.skipped.length) process.stdout.write(`Not regular files, removed: ${r.skipped.join(', ')}\n`);
  if (!r.hits.length) { process.stdout.write('No key-shaped string in the build output.\n'); return r.skipped.length ? 1 : 0; }
  process.stdout.write(`Key-shaped strings found; those files were removed and are not uploaded:\n${r.hits.map((h) => `- ${h.file}: ${describe(h)}`).join('\n')}\n`);
  return 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { KINDS, secretHits, patchHits, describe, scanDir, main };
