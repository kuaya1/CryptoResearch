'use strict';
// Test child (audit F1): takes the workspace lock the normal way and holds it
// until <release> exists (at most 60 s), like a long backup or export would.
// Usage: node child-lock-holder.js <root> <ready-file> <release-file>
const fs = require('fs');
const path = require('path');
const base = path.resolve(__dirname, '..', '..');
const [root, ready, release] = process.argv.slice(2);
const ops = require(path.join(base, 'core', 'ops'));
const { sleepSync } = require(path.join(base, 'core', 'fsx'));
const ws = require(path.join(base, 'core', 'workspace')).openWorkspace({ root, actor: 'lock-holder' });
ops.withLock(ws, 'test_lock_holder', () => {
  fs.writeFileSync(ready, String(process.pid));
  const until = Date.now() + 60000;
  while (!fs.existsSync(release) && Date.now() < until) sleepSync(20);
});
process.stdout.write(JSON.stringify({ released: true }));
