'use strict';
// Test child for coherent reads (audit V2-001). Commits several files in one
// operation and stops after the first one has been moved into place:
//   hold   writes <ready>, then waits until <release> exists, then finishes
//   timed  writes <ready>, waits <hold_ms>, then finishes
//   crash  writes <ready>, then the process is killed (no cleanup runs)
// Usage: node child-held-commit.js <root> <spec.json>
// spec: { writes: [{ rel, content }], after: rel, mode, ready, release, hold_ms }
const fs = require('fs');
const path = require('path');
const base = path.resolve(__dirname, '..', '..');
const [root, specFile] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const ops = require(path.join(base, 'core', 'ops'));
const { sleepSync } = require(path.join(base, 'core', 'fsx'));
const ws = require(path.join(base, 'core', 'workspace')).openWorkspace({ root, actor: 'held-writer' });

const target = path.resolve(ws.abs(spec.after));
const rename = fs.renameSync;
let stopped = false;
fs.renameSync = function heldRename(from, to) {
  const r = rename.call(fs, from, to);
  if (!stopped && String(from).includes(`${path.sep}staging${path.sep}`) && path.resolve(String(to)) === target) {
    stopped = true;
    fs.writeFileSync(spec.ready, String(process.pid));
    if (spec.mode === 'crash') process.kill(process.pid, 'SIGKILL');
    if (spec.mode === 'timed') sleepSync(spec.hold_ms || 2000);
    if (spec.mode === 'hold') {
      const until = Date.now() + 60000;
      while (!fs.existsSync(spec.release) && Date.now() < until) sleepSync(20);
    }
  }
  return r;
};

const out = ops.runOp(ws, { type: 'held_test', summary: 'held two-file commit' }, (op) => {
  for (const w of spec.writes) op.write(w.rel, w.content);
});
process.stdout.write(JSON.stringify({ verified: out.verified, op_id: out.op_id }));
