#!/usr/bin/env node
'use strict';
// Rollback drill (backlog item 44; the blueprint's W4.4):
//
//   node dashboard/scripts/rollback-drill.js --from <ref> [--json] [--record <audit-dir>]
//
// Would the previous release still read the records this release writes? It
// builds a FICTIONAL workspace with this checkout's code (a desk gate, an
// admission-held receipt, a sized receipt with its decision and paper
// position: tests/drill-fixture.js), checks <ref> out into a temporary git
// worktree, and in a child process runs that code's tickets.view,
// tickets.summary, paper.book, indexer.buildIndex and brief-daily over the
// workspace. It passes when nothing throws and a record made under newer rules
// reads "made under a newer rule" (item 13). With --record it writes
// rollback-drill.json (cr.rollback-drill.v1, item 43) into the audit folder
// named; otherwise it writes nothing outside its temporary folders. It refuses
// a workspace that is not a test one, never touches the real workspace or a
// branch, and removes the worktree.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { withoutGithubCredentials } = require('../core/child-env');

const ROOT = path.join(__dirname, '..', '..');
const SCHEMA = 'cr.rollback-drill.v1';
const NEWER = /made under a newer rule/i;

const git = (cwd, args, { allowFail = false } = {}) => {
  const r = spawnSync('git', args, { cwd, env: withoutGithubCredentials(process.env), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  return (r.stdout || '').trim();
};

// Only a throwaway test workspace under the OS temp folder is read.
function assertDrillWorkspace(root, kind) {
  const rel = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(root));
  if (kind !== 'test' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refused: ${root} is not a fictional test workspace in the temporary folder. The drill never reads a real workspace.`);
  }
}

// ---------------------------------------------------------------------------
// The child: the previous release's code reads the workspace. Prints JSON.

function child(codeRoot, wsRoot) {
  const out = { checks: [], versions: {}, notes: {} };
  const req = (rel) => require(path.join(codeRoot, 'dashboard', 'core', rel));
  let ws;
  try {
    const { openWorkspace } = req('workspace');
    ws = openWorkspace({ root: wsRoot, actor: 'rollback-drill', recover: false });
    assertDrillWorkspace(wsRoot, ws.kind);
  } catch (err) { return { fatal: err.message }; }
  const check = (name, fn) => {
    try { const v = fn(); out.checks.push({ name, ok: true }); return v; } catch (err) {
      if (err && err.code === 'MODULE_NOT_FOUND' && /dashboard[\\/]core[\\/]/.test(String(err.message))) { out.checks.push({ name, ok: true, skipped: 'not in this release' }); return null; }
      out.checks.push({ name, ok: false, error: String((err && err.message) || err).slice(0, 300) }); return null;
    }
  };
  const T = req('tickets');
  const projects = req('projects').listProjects(ws).filter((p) => !p.broken);
  out.versions = { sizing: T.SIZING_VERSION || null, invalidation: T.INVALIDATION_VERSION || null };
  for (const p of projects) {
    const pid = p.project_id;
    const view = check(`tickets.view ${pid}`, () => T.view(ws, pid));
    const sum = check(`tickets.summary ${pid}`, () => T.summary(ws, pid));
    const receipts = check(`tickets.listReceipts ${pid}`, () => T.listReceipts(ws, pid)) || [];
    // Receipts whose rules are newer than this release's constants.
    const newer = receipts.filter((r) => !r.broken && ((r.versions && r.versions.sizing && out.versions.sizing && r.versions.sizing !== out.versions.sizing)
      || (r.desk && r.desk.invalidation_version && out.versions.invalidation && r.desk.invalidation_version !== out.versions.invalidation)));
    out.notes[pid] = { newer_receipts: newer.map((r) => r.receipt_id), view_note: (view && view.ticket && view.ticket.rule_note) || null, summary_note: (sum && sum.rule_note) || null, status: view && view.ticket ? view.ticket.status : null };
  }
  const index = check('indexer.buildIndex', () => req('indexer').buildIndex(ws));
  if (index) for (const row of index.projects || []) if (row && row.ticket && out.notes[row.project_id]) out.notes[row.project_id].index_note = row.ticket.rule_note || null;
  check('paper.book', () => req('paper').book(ws, {}));
  check('brief-daily', () => req('brief-daily').brief(ws, {}));
  return out;
}

// The verdict on one child run. requireNewer: the latest ticket must read as
// made under a newer rule (the workspace was stamped with a newer version).
function evaluate(result, { requireNewer = false } = {}) {
  if (!result || result.fatal) return { passed: false, problems: [result && result.fatal ? result.fatal : 'The previous release could not be run.'], checked: [] };
  const problems = [];
  for (const c of result.checks) if (!c.ok) problems.push(`${c.name} threw: ${c.error}`);
  for (const [pid, n] of Object.entries(result.notes || {})) {
    if (requireNewer && !n.newer_receipts.length) problems.push(`${pid}: no receipt reads as newer than the previous release's rules.`);
    if (n.newer_receipts.length) {
      if (!NEWER.test(n.view_note || '')) problems.push(`${pid}: tickets.view does not say "made under a newer rule".`);
      if (!NEWER.test(n.summary_note || '')) problems.push(`${pid}: tickets.summary does not say "made under a newer rule".`);
      if (n.index_note !== undefined && !NEWER.test(n.index_note || '')) problems.push(`${pid}: the index row does not say "made under a newer rule".`);
    }
  }
  return { passed: problems.length === 0, problems, checked: result.checks.map((c) => (c.skipped ? `${c.name} (${c.skipped})` : c.name)) };
}

// ---------------------------------------------------------------------------

// read(codeRoot, wsRoot) -> the child's answer; injectable so a test can run
// without a second node process. build() makes the fictional workspace.
function drill({ cwd = ROOT, from, record = null, read = null, build = null } = {}) {
  if (!from) throw new Error('Give the previous release: --from <ref>.');
  const to = git(cwd, ['rev-parse', '--short', 'HEAD']);
  const fromSha = git(cwd, ['rev-parse', '--verify', '--short', `${from}^{commit}`]);
  const reader = read || ((codeRoot, wsRoot) => {
    const r = spawnSync(process.execPath, [__filename, '--child', codeRoot, wsRoot], { env: withoutGithubCredentials(process.env), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    try { return JSON.parse(r.stdout); } catch (_) { return { fatal: `The previous release's code failed to run: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}` }; }
  });
  const make = build || (() => require('../tests/drill-fixture').buildDrillWorkspace());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-rollback-drill-'));
  const tree = path.join(tmp, 'release');
  let w = null;
  let added = false;
  try {
    w = make();
    assertDrillWorkspace(w.root, w.ws && w.ws.kind);
    git(cwd, ['worktree', 'add', '--detach', '-q', tree, from]);
    added = true;
    const asBuilt = evaluate(reader(tree, w.root));
    w.stampNewer();
    const stamped = evaluate(reader(tree, w.root), { requireNewer: true });
    const problems = [...asBuilt.problems.map((p) => `as built: ${p}`), ...stamped.problems.map((p) => `newer rules: ${p}`)];
    const checked = [...new Set([...asBuilt.checked, ...stamped.checked])];
    const result = { schema_version: SCHEMA, result: problems.length ? 'failed' : 'passed', from: fromSha, to, checked, problems, at: new Date().toISOString() };
    if (record) {
      const dir = path.resolve(cwd, record);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'rollback-drill.json'), `${JSON.stringify(result, null, 2)}\n`);
    }
    return result;
  } finally {
    if (added) git(cwd, ['worktree', 'remove', '--force', tree], { allowFail: true });
    git(cwd, ['worktree', 'prune'], { allowFail: true });
    if (w) { try { w.cleanup(); } catch (_) { /* gone */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--child') {
    process.stdout.write(JSON.stringify(child(args[1], args[2])));
  } else {
    const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
    try {
      const r = drill({ from: val('--from'), record: val('--record') });
      process.stdout.write(args.includes('--json') ? `${JSON.stringify(r, null, 2)}\n` : `Rollback drill ${r.from} <- ${r.to}: ${r.result.toUpperCase()}\n${r.problems.map((p) => `  - ${p}`).join('\n')}${r.problems.length ? '\n' : ''}Checked: ${r.checked.join(', ')}\n`);
      process.exit(r.result === 'passed' ? 0 : 1);
    } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(2); }
  }
}

module.exports = { drill, child, evaluate, assertDrillWorkspace, SCHEMA };
