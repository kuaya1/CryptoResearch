'use strict';
// Test child: processes the request queue and exits (code 77) at a chosen point,
// to reproduce a crash between a committed effect and its receipt (audit F01).
// Usage: node child-queue-crash.js <workspaceRoot> <mode>
//   before_seal     exit while the effect is staged but not sealed
//   after_effect    exit right after the effect committed, before the receipt
//   during_receipt  exit after the receipt operation sealed, before it applied
const fs = require('fs');
const path = require('path');
const base = path.resolve(__dirname, '..', '..');
const [root, mode] = process.argv.slice(2);
const ops = require(path.join(base, 'core', 'ops'));
const requests = require(path.join(base, 'core', 'requests'));

if (mode === 'before_seal') {
  const seal = ops.StagedOp.prototype.seal;
  ops.StagedOp.prototype.seal = function sealThenMaybeExit() {
    if (this.type !== 'request_result') process.exit(77);
    return seal.call(this);
  };
}
if (mode === 'after_effect') {
  const orig = requests.ACTIONS;
  for (const name of Object.keys(orig)) {
    const run = orig[name].run;
    orig[name].run = (ws, a) => {
      run(ws, a);
      process.exit(77);
    };
  }
}
if (mode === 'during_receipt') {
  const rename = fs.renameSync;
  fs.renameSync = function renameMaybeExit(from, to) {
    if (String(to).replace(/\\/g, '/').includes('logs/requests/') && String(from).includes('staging')) process.exit(77);
    return rename.call(fs, from, to);
  };
}
const ws = require(path.join(base, 'core', 'workspace')).openWorkspace({ root, actor: `crash-${mode}` });
requests.processRequests(ws);
process.exit(0);
