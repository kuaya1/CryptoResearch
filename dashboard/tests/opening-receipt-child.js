'use strict';
// A second process for the opening-receipt integrity tests
// (opening-receipt-integrity.test.js). It opens the FICTIONAL test workspace
// it is given, runs one normal entry point of the desk, and can be made to
// stop dead at a named point: the process is killed outright, so no `finally`
// runs, no lock is released and no half-made write is tidied up. It is not a
// test file and is never run on its own.
//
//   node opening-receipt-child.js <workspace root> <entry> <stop> <json args>
//
// entry  approve   Eric's approval of args.receipt_id (tickets.decide), which
//                  runs the trader's first step
//        step      one step of the trader's adapter (trader-desk.step)
// stop   none
//        before_reserve       as the book is asked: nothing is written yet
//        mid_reserve_commit   while the reservation is being put on disk:
//                             the journal is in place, its head is not
//        after_reserve        the reservation is committed; nothing was sent
//        after_venue          the venue has the order; its answer is not
//                             on record (a lost acknowledgment)
// args   { receipt_id, request_id, ready_file, go_file }: with go_file the
//        entry waits until that file exists (two children started together).

const fs = require('fs');
const os = require('os');
const path = require('path');

const [root, entry, stop, argJson] = process.argv.slice(2);
const args = JSON.parse(argJson || '{}');
const fail = (words) => { process.stderr.write(`${words}\n`); process.exit(2); };

// Only ever a temporary test workspace.
const rel = path.relative(path.resolve(os.tmpdir()), path.resolve(String(root)));
if (!root || rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) fail('The workspace is not under the temporary folder.');
let meta = null;
try { meta = JSON.parse(fs.readFileSync(path.join(root, 'workspace.json'), 'utf8')); } catch (_) { meta = null; }
if (!meta || meta.kind !== 'test') fail('The workspace is not marked as a test workspace.');
if (process.env.CR_DATA_DIR || process.env.CR_WORKSPACE) fail('A real desk path is set.');

const die = () => { process.kill(process.pid, 'SIGKILL'); for (;;) { /* until the kill lands */ } };

// The book takes its operation runner when it loads, so the stop points go in first.
const ops = require('../core/ops');
const realRunOp = ops.runOp;
let reserving = false;
ops.runOp = (ws, m, build) => {
  const type = String((m && m.type) || '');
  const reserve = type.startsWith('paper_trader.reserve.');
  if (reserve && stop === 'before_reserve') die();
  reserving = reserve;
  let r;
  try { r = realRunOp(ws, m, build); } finally { reserving = false; }
  if (reserve && stop === 'after_reserve') die();
  if (type.startsWith('paper_trader_venue.') && stop === 'after_venue') die();
  return r;
};
const PT = require('../core/paper-trader');
if (stop === 'mid_reserve_commit') {
  const realRename = fs.renameSync;
  const journal = PT.JOURNAL;
  fs.renameSync = (from, to) => {
    realRename(from, to);
    if (reserving && String(to).split(path.sep).join('/').endsWith(journal)) die();
  };
}

const { openWorkspace } = require('../core/workspace');
const T = require('../core/tickets');
const TD = require('../core/trader-desk');
// No position held, as in the parent's desk (mandate-fixture.js noHoldings).
const portfolio = require('../core/portfolio');
const realPortfolio = portfolio.computePortfolio;
portfolio.computePortfolio = (...a) => ({ ...realPortfolio(...a), positions: [] });

const ws = openWorkspace({ root, actor: 'test' });
if (args.ready_file) fs.writeFileSync(args.ready_file, String(process.pid));
if (args.go_file) { const wait = new Int32Array(new SharedArrayBuffer(4)); while (!fs.existsSync(args.go_file)) Atomics.wait(wait, 0, 0, 2); }

let out;
try {
  if (entry === 'approve') {
    const pid = meta.project_id || args.project_id;
    const r = T.decide(ws, args.project_id || pid, { receipt_id: args.receipt_id, action: 'approve', request_id: args.request_id });
    out = { entry, status: r.result.status, decision_id: r.result.decision ? r.result.decision.decision_id : null };
  } else if (entry === 'step') {
    const r = TD.step(ws, {});
    out = { entry, done: r.done, problems: r.problems };
  } else fail(`Unknown entry ${entry}.`);
} catch (err) {
  out = { entry, error: { code: err && err.code ? err.code : null, message: String(err && err.message || err).slice(0, 300) } };
}
process.stdout.write(`CHILD ${JSON.stringify(out)}\n`);
