'use strict';
// Test child for the record lock under real contention (lock-release.test.js):
// takes and releases the lock of a temporary FICTIONAL workspace in a loop,
// adding one to a shared counter while it holds it, and prints what happened.
//   node child-lock-cycle.js <root> <cycles>
const fs = require('fs');
const path = require('path');
const base = path.resolve(__dirname, '..', '..');
const [root, cycles] = process.argv.slice(2);
const ops = require(path.join(base, 'core', 'ops'));
const ws = require(path.join(base, 'core', 'workspace')).openWorkspace({ root, actor: `child-${process.pid}` });
const counter = path.join(root, 'count.txt');
let ok = 0;
const errors = [];
for (let i = 0; i < Number(cycles); i++) {
  try {
    ops.withLock(ws, 'lock-cycle', () => {
      const n = Number(fs.readFileSync(counter, 'utf8'));
      fs.writeFileSync(counter, String(n + 1));
    });
    ok += 1;
  } catch (err) {
    errors.push(`${err.code} ${err.syscall || ''} ${path.basename(err.path || '')}`.trim());
  }
}
process.stdout.write(JSON.stringify({ ok, errors }));
