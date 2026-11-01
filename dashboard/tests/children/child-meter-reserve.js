'use strict';
// Test child for simultaneous meter reservations (call-accounting.test.js):
// reserves `attempts` requests on one provider meter of a temporary
// FICTIONAL workspace at a fixed clock and prints how many were granted.
//   node child-meter-reserve.js <root> <meter> <attempts> <now> <cap>
const path = require('path');
const base = path.resolve(__dirname, '..', '..');
const [root, meter, attempts, nowArg, capArg] = process.argv.slice(2);
const now = Number(nowArg);
const cap = Number(capArg);
const ws = require(path.join(base, 'core', 'workspace')).openWorkspace({ root, actor: `child-${process.pid}` });
const reserve = {
  coingecko: () => require(path.join(base, 'core', 'market')).reserveCall(ws, now),
  goplus: () => require(path.join(base, 'core', 'screening')).reserveRequest(ws, { monthly_request_budget: cap }, now),
  exit_quotes: () => require(path.join(base, 'core', 'forensic-monitor')).reserveRequest(ws, { monthly_request_budget: cap }, now),
  candles: () => require(path.join(base, 'core', 'trader-candles')).reserve(ws, now),
}[meter];
if (!reserve) throw new Error(`no meter ${meter}`);
let ok = 0;
for (let i = 0; i < Number(attempts); i++) if (reserve()) ok += 1;
process.stdout.write(JSON.stringify({ ok }));
