'use strict';
// Test child for read consistency (audit F04).
//   writer: commits a.json and b.json together N times, slowing each rename
//   reader: reads both files N times, raw and through readConsistent, and
//           reports how often each saw a mixed generation
const fs = require('fs');
const path = require('path');
const base = path.resolve(__dirname, '..', '..');
const [root, role, count] = process.argv.slice(2);
const ops = require(path.join(base, 'core', 'ops'));
const { sleepSync } = require(path.join(base, 'core', 'fsx'));
const ws = require(path.join(base, 'core', 'workspace')).openWorkspace({ root, actor: role });
const n = Number(count || 20);

if (role === 'writer') {
  const rename = fs.renameSync;
  fs.renameSync = function slowRename(from, to) {
    const r = rename.call(fs, from, to);
    if (String(from).includes('staging')) sleepSync(25);
    return r;
  };
  for (let i = 1; i <= n; i++) {
    ops.runOp(ws, { type: 'gen_test', summary: `pair ${i}` }, (op) => {
      op.write('logs/gen-a.txt', String(i));
      op.write('logs/gen-b.txt', String(i));
    });
  }
  process.stdout.write('done');
} else {
  const read = () => {
    let a = null;
    let b = null;
    try { a = fs.readFileSync(ws.abs('logs/gen-a.txt'), 'utf8'); } catch (_) { /* not yet */ }
    sleepSync(5);
    try { b = fs.readFileSync(ws.abs('logs/gen-b.txt'), 'utf8'); } catch (_) { /* not yet */ }
    return { a, b };
  };
  let rawMixed = 0;
  let consistentMixed = 0;
  const started = Date.now();
  for (let i = 0; i < n * 6 && Date.now() - started < 20000; i++) {
    const r1 = read();
    if (r1.a !== null && r1.b !== null && r1.a !== r1.b) rawMixed++;
    const r2 = ops.readConsistent(ws, read, { attempts: 40 });
    if (r2.a !== null && r2.b !== null && r2.a !== r2.b) consistentMixed++;
    sleepSync(3);
  }
  process.stdout.write(JSON.stringify({ rawMixed, consistentMixed }));
}
