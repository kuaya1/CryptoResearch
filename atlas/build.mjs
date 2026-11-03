// Checks atlas/system.js against the repository and writes
// atlas/evidence.generated.js: the pinned commit, each anchor's line and each
// claim's line. Every file is read as it is at the pinned commit (git show),
// never from the working tree. Fails, writing nothing, if any file, anchor or
// claim cannot be found, or any connection or stage names an unknown part.
//   node atlas/build.mjs
//
// Two kinds of evidence:
//   evidence [path, anchor]      the source a reader should open; the anchor must exist.
//   claims   [path, regex, what] a fact the adjacent words depend on (a default, a
//                                limit, a refusal); the pattern must match the file.
// A claim that matches proves the text exists, not that the system ran.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(here, 'system.js'), 'utf8'), sandbox);
const A = sandbox.window.ATLAS;

// The newest commit that touched anything the atlas cites (never the atlas itself),
// so every link is a permalink that exists on GitHub.
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
const commit = git('rev-list', '-1', 'HEAD', '--', '.', ':(exclude)atlas', ':(exclude).gitignore').trim();
const cache = new Map();
const read = (p) => {
  if (!cache.has(p)) { try { cache.set(p, git('show', `${commit}:${p}`)); } catch { cache.set(p, null); } }
  return cache.get(p);
};

const refs = [];
const claims = [];
const take = (list, where) => (list || []).forEach(([p, a]) => refs.push({ p, a, where }));
const claim = (list, where) => (list || []).forEach(([p, re, what]) => claims.push({ p, re, what, where }));
A.nodes.forEach((n) => { take(n.evidence, `node ${n.id}`); take(n.proof && n.proof.evidence, `node ${n.id} proof`); claim(n.claims, `node ${n.id}`); });
A.chapters.forEach((c) => { take(c.evidence, `chapter ${c.id}`); claim(c.claims, `chapter ${c.id}`); });
Object.entries(A.open).forEach(([k, list]) => list.forEach((o) => take([o[2]], `open.${k} "${o[0]}"`)));
take(A.baseline.deployed.evidence, 'baseline'); take(A.baseline.pc.evidence, 'baseline');
take(A.pause.evidence, 'pause');
A.stage15.items.forEach((i) => { take(i.evidence, `stage15 item ${i.n}`); claim(i.claims, `stage15 item ${i.n}`); });
A.stage15.hosts.forEach((h) => take([h.evidence], `stage15 host ${h.name}`));

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function resolve(text, anchor) {
  const lines = text.split(/\r?\n/);
  if (!anchor) return 1;
  if (anchor.startsWith('~')) {
    const needle = anchor.slice(1);
    const i = lines.findIndex((l) => l.includes(needle));
    return i < 0 ? 0 : i + 1;
  }
  const s = esc(anchor);
  const defs = [
    new RegExp(`\\bfunction\\*?\\s+${s}\\s*\\(`),
    new RegExp(`\\b(const|let|var)\\s+${s}\\s*=`),
    new RegExp(`^\\s*(async\\s+)?${s}\\s*\\([^)]*\\)\\s*\\{`),
    new RegExp(`\\b${s}\\s*:\\s*(async\\s*)?(function|\\()`),
    new RegExp(`exports\\.${s}\\s*=`)
  ];
  for (const re of defs) {
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0) return i + 1;
  }
  return 0;
}

const out = {};
const claimOut = [];
const missing = [];
for (const r of refs) {
  const key = `${r.p}|${r.a}`;
  if (key in out) continue;
  const text = read(r.p);
  if (text === null) { missing.push(`${r.where}: no file ${r.p} at ${commit.slice(0, 7)}`); continue; }
  const line = resolve(text, r.a);
  if (!line) { missing.push(`${r.where}: no "${r.a}" in ${r.p}`); continue; }
  out[key] = r.a ? line : 0;
}
for (const c of claims) {
  const text = read(c.p);
  if (text === null) { missing.push(`${c.where}: claim "${c.what}": no file ${c.p}`); continue; }
  const m = new RegExp(c.re).exec(text);
  if (!m) { missing.push(`${c.where}: claim "${c.what}" not found in ${c.p} (/${c.re}/)`); continue; }
  claimOut.push({ where: c.where, what: c.what, path: c.p, line: text.slice(0, m.index).split('\n').length });
}

// Every edge, flow step, chapter, owner stage and view must name a real node,
// and every node on the five columns must belong to exactly one owner stage.
const ids = new Set(A.nodes.map((n) => n.id));
const unknown = (where, n) => { if (!ids.has(n)) missing.push(`${where}: unknown node ${n}`); };
A.edges.forEach(([f, t]) => { unknown(`edge ${f} -> ${t}`, f); unknown(`edge ${f} -> ${t}`, t); });
A.flows.forEach((f) => f.steps.forEach(([n]) => unknown(`flow ${f.id}`, n)));
A.chapters.forEach((c) => (c.nodes || []).forEach((n) => unknown(`chapter ${c.id}`, n)));
A.owner.forEach((s) => s.nodes.forEach((n) => unknown(`owner ${s.id}`, n)));
A.views.forEach((v) => unknown(`view ${v.name}`, v.book));
const staged = A.owner.flatMap((s) => s.nodes);
A.nodes.filter((n) => n.layer && n.layer !== 'sources' && !n.support).forEach((n) => {
  const k = staged.filter((x) => x === n.id).length;
  if (k !== 1) missing.push(`node ${n.id}: in ${k} owner stages (needs exactly 1)`);
});
A.nodes.forEach((n) => { if (!A.statuses[n.status]) missing.push(`node ${n.id}: unknown status ${n.status}`); });

// Each pull request named as merged has that merge commit in this checkout's
// history; one named as not merged has none. HEAD, not the pin: a merge that
// changed nothing beyond its branch is not the newest commit to touch a file.
for (const [n, sha] of A.stage15.prs) {
  if (sha) {
    let subject = '';
    try { git('merge-base', '--is-ancestor', sha, 'HEAD'); subject = git('log', '-1', '--format=%s', sha); } catch { missing.push(`#${n}: ${sha} is not in this checkout's history`); continue; }
    if (!subject.includes(`#${n} `)) missing.push(`#${n}: ${sha} is not its merge commit`);
  } else if (git('log', 'HEAD', '--format=%h', '--grep', `^Merge pull request #${n} `).trim()) {
    missing.push(`#${n}: named as not merged, but history has its merge`);
  }
}

if (missing.length) {
  console.error(`atlas: ${missing.length} problem(s), nothing written:\n  ` + missing.join('\n  '));
  process.exit(1);
}
const body = `/* Generated by atlas/build.mjs — do not edit. */\nwindow.ATLAS_EVIDENCE = ${JSON.stringify({ repo: 'kuaya1/CryptoResearch', commit, built: new Date().toISOString(), system_sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(here, 'system.js'))).digest('hex'), refs: out, claims: claimOut }, null, 1)};\n`;
fs.writeFileSync(path.join(here, 'evidence.generated.js'), body);
console.log(`atlas: ${Object.keys(out).length} evidence anchors and ${claimOut.length} claims checked at ${commit.slice(0, 7)}; ${A.nodes.length} components, ${A.edges.length} connections, ${A.flows.length} paths.`);
