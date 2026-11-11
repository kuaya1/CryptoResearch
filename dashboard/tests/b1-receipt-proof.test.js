'use strict';
// B1's lineage gate through the real command (Eric's option (b), 2026-11-11):
//   node dashboard/cli.js prove-autonomy b1 --desk=online --evidence=<dir> --out=<dir> --fixture --offline
// run as its own process on a sealed FICTIONAL bundle. The order is made by
// the desk's own path (opening-receipt-fixture.js: the ticket, two fictional
// observations, Eric's approval through tickets.decide); trader-after-ack.json
// is GET /api/paper/trader from the signed-in local server and
// basis-after-ack.json is `cli.js tickets basis <project> <decision> --json`,
// stdout as written. The other B1 members are stand-ins: only b1:lineage is
// under test here, and a --fixture run never reads PASS overall (exit 2).
//
// The rules under test:
// - A valid new opening passes b1:lineage.
// - The row says `bound` in every case below; an incorrect quantity, a wrong
//   reservation link, a contradictory observation or proving pool, a cost over
//   the recorded limit, or no receipt on the reservation fails (exit 1).
// - The reservation not captured is UNVERIFIED, never PASS.
// - A proof reads the same from its bundle after the desk's current
//   observation and settings change, and a capture made after them still binds.
// - An order made before the receipt existed stays readable and fails B1.
// Temporary workspaces and folders only; a local server on 127.0.0.1; no other network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const X = require('./opening-receipt-fixture');
const { OR, POOL3 } = X;

const REPO = path.join(__dirname, '..', '..');
const CLI = path.join(__dirname, '..', 'cli.js');
const env = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const clone = (v) => JSON.parse(JSON.stringify(v));
const iso = (ms) => new Date(ms).toISOString();
// A decimal string one part in 10^18 larger, written to 18 places.
const up18 = (s) => { const [w, f = ''] = String(s).split('.'); const n = BigInt(`${w}${f.padEnd(18, '0')}`) + 1n; const t = n.toString().padStart(19, '0'); return `${t.slice(0, -18)}.${t.slice(-18)}`; };

function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, bytes: Buffer.concat(c) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function tmp(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cr-b1p-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// What the desk shows for the order now: the signed-in trader view and the CLI's basis, as bytes.
async function capture(t, s, d) {
  const { start } = require('../server');
  const srv = await start(X.reopened(s).ws, { port: 47700 + Math.floor(Math.random() * 300), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } });
  const view = await get(srv.port, '/api/paper/trader', { 'x-cr-token': srv.token });
  try { srv.shutdown(); } catch (_) { /* stopped */ }
  assert.equal(view.status, 200, 'the trader view reads');
  const basis = spawnSync(process.execPath, [CLI, 'tickets', 'basis', s.pid, d.decision_id, '--json', '--workspace', s.root], { encoding: 'buffer', env: env(), timeout: 120000 });
  assert.equal(basis.status, 0, String(basis.stderr));
  return { view: view.bytes, basis: basis.stdout };
}

// The B1 members for one order: the two captures as given, the rest stand-ins.
function membersOf(s, d, receipt, line, cap) {
  const at = Date.parse(line.at);
  const after = JSON.parse(cap.view.toString('utf8'));
  after.orders.find((o) => o.client_order_id === line.client_order_id).state = 'CANCELLED';
  after.now = iso(at + 3 * 3600000);
  after.candles = { ...(after.candles || {}), last_run_at: iso(at + 3 * 3600000) };
  return {
    'lineage.json': {
      project_id: s.pid, run_id: 'run_fictional_b1', report_id: 'rep_fictional_b1', receipt_id: receipt.receipt_id, generation: 1,
      decision_id: d.decision_id, intent_id: line.intent_id, client_order_id: line.client_order_id, sent_at: line.at,
      control: 'pause', control_applied_at: iso(at + 60000),
      healthchecks_start_and_final_seen: true, grant_stays_in_force: true, grant_reused: false, counted_toward_ny_day: line.at.slice(0, 10),
    },
    'trader-after-ack.json': cap.view,
    'basis-after-ack.json': cap.basis,
    'trader-after-window.json': after,
    'window.json': { enabled_at: iso(at - 600000), disabled_at: iso(at + 120000), candidate_project_id: s.pid, other_projects_ran: false },
    'tasks-after.json': { observed_at: iso(at + 180000), pilot: { state: 'Disabled', instances: 0 } },
    'run-log.json': { format: 'cr-pilot-all@1', dry_run: false, max_agents: 1, polled: [], exit: 0, error: null, revision: { runner: 'a'.repeat(40), desk: 'a'.repeat(40), source: 'git', clean: true } },
    'desk-controls-after.json': { format: 'cr-desk-controls@1', at: iso(at + 3 * 3600000), poll: { state: 'fresh', last_polled_at: iso(at + 3 * 3600000) }, controls: { pause: { done: true } } },
    'B1.txt': 'FICTIONAL capture for code-path tests.\n',
  };
}

// A sealed bundle: <root>/B1/ with its manifest binding every member written.
function seal(root, files) {
  const dir = path.join(root, 'B1');
  fs.mkdirSync(dir, { recursive: true });
  const listed = [];
  for (const [name, value] of Object.entries(files)) {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, name), buf);
    listed.push({ path: name, bytes: buf.length, sha256: sha256(buf) });
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify({ format: 'cr-operating-proof-b1-evidence@1', closed_at: new Date().toISOString(), baseline: 'a'.repeat(40), provenance: 'fictional', files: listed }, null, 2)}\n`);
  return root;
}

// The real command, as its own process; its report and exit status.
function prove(t, root) {
  const out = tmp(t, 'out');
  const r = spawnSync(process.execPath, [CLI, 'prove-autonomy', 'b1', '--desk=online', `--evidence=${root}`, `--out=${out}`, '--fixture', '--offline'], { cwd: REPO, encoding: 'utf8', env: env(), timeout: 120000 });
  let report = null;
  try { report = JSON.parse(r.stdout); } catch (_) { assert.fail(`no report: ${r.stderr}`); }
  const lineage = report.checks.find((c) => c.id === 'b1:lineage');
  return { exit: r.status, result: report.result, lineage: lineage.result, reason: lineage.reason };
}

// One member edited as parsed JSON, the rest as captured; resealed.
function variant(t, files, edits, drop = []) {
  const next = { ...files };
  for (const [name, change] of Object.entries(edits)) {
    const v = JSON.parse(Buffer.isBuffer(next[name]) ? next[name].toString('utf8') : JSON.stringify(next[name]));
    change(v);
    next[name] = v;
  }
  for (const name of drop) delete next[name];
  return seal(tmp(t, 'ev'), next);
}

// A new opening by one of the desk's paths:
//   approve-down   Eric's approval, sized down to the V3 pool's $500 quote, the exit proven in the V2 pair
//   approve-risk   Eric's approval, kept at its risk-sized quantity (a deep pair)
//   mandate-down   the paper mandate's grant, sized down as above
//   mandate-risk   the paper mandate's grant at its risk-sized quantity
async function newOpening(t, kind = 'approve-down') {
  const mandate = kind.startsWith('mandate');
  const s = X.desk(t, { label: 'b1-proof', mandate });
  const down = async (x) => { await X.observe(x); return X.observe(x, { pair: X.MID, quoter: 'poor' }); };
  const { receipt } = await X.ready(s, { current: kind.endsWith('down') ? down : (x) => X.observe(x, { pair: X.DEEP }) });
  const d = mandate ? X.mandateGrant(s).decision : X.approve(s, receipt);
  assert.ok(d, `${kind}: a grant`);
  const lines = X.reservedFor(s, d.decision_id);
  assert.equal(lines.length, 1, X.rowOf(s, d.decision_id).words);
  assert.equal(X.check(s, lines[0]).status, 'bound');
  const rec = OR.readFrom(lines[0].intent);
  assert.equal(rec.quantity.sized_by, kind.endsWith('down') ? 'quote' : 'risk', `${kind}: how it was sized`);
  return { s, d, receipt, line: lines[0] };
}

test('B1P1: through the real command, a valid new opening passes b1:lineage; each contradiction under a row reading bound fails it; the reservation not captured is UNVERIFIED', async (t) => {
  const { s, d, receipt, line } = await newOpening(t);
  const files = membersOf(s, d, receipt, line, await capture(t, s, d));
  const row = (v) => v.orders.find((o) => o.client_order_id === line.client_order_id).opening_receipt;
  const res = (v) => v.execution.reserved.find((x) => x.client_order_id === line.client_order_id);
  assert.equal(row(JSON.parse(files['trader-after-ack.json'].toString('utf8'))).status, 'bound');

  const ok = prove(t, seal(tmp(t, 'ev'), files));
  assert.deepEqual([ok.exit, ok.result, ok.lineage], [2, 'UNVERIFIED', 'PASS'], ok.reason);
  assert.ok(ok.reason.includes(`The reservation the book holds carries its receipt: an enforced CG-14 pass for exactly ${X.AT_500} tokens`), ok.reason);

  const CASES = [
    ['an incorrect quantity: the receipt (and the row) for one unit less than the book reserved', {
      'basis-after-ack.json': (v) => { res(v).contract_guard.quantity.final = '71.022726'; },
      'trader-after-ack.json': (v) => { row(v).quantity.final = '71.022726'; },
    }, /the receipt's final quantity against the quantity the book reserved is a different value, required a different value\.|base units are not its final quantity/],
    ['a wrong reservation link: the grant the book read is another decision\'s', {
      'basis-after-ack.json': (v) => { res(v).grant.decision_id = 'td_other'; },
    }, /the grant's decision is td_other/],
    ['a contradictory observation: the row names another', {
      'trader-after-ack.json': (v) => { row(v).observation_id = 'co_0000000000000000'; },
    }, /the observation the row names is a different value/],
    ['a contradictory proving pool: the row names the sizing pool', {
      'trader-after-ack.json': (v) => { row(v).exit_pool = POOL3; },
    }, /the pool the row says proved the exit is a different value/],
    ['a cost above the recorded limit, in the receipt and the row alike', {
      'basis-after-ack.json': (v) => { res(v).contract_guard.exit.cost_pct = '5.000000000000000001'; },
      'trader-after-ack.json': (v) => { row(v).cost_pct = '5.000000000000000001'; },
    }, /The receipt's unrounded exit cost 5\.000000000000000001% is over the 5% limit it records\./],
    ['no receipt on the reservation', {
      'basis-after-ack.json': (v) => { res(v).contract_guard = null; },
    }, /The reservation carries no opening receipt, whatever the row says\./],
    ['no reservation in the book for this order', {
      'basis-after-ack.json': (v) => { v.execution.reserved = []; },
    }, /holds no reservation for this order/],
  ];
  for (const [name, edits, why] of CASES) {
    const dir = variant(t, files, edits);
    assert.equal(row(JSON.parse(fs.readFileSync(path.join(dir, 'B1', 'trader-after-ack.json'), 'utf8'))).status, 'bound', `${name}: the row still says bound`);
    const r = prove(t, dir);
    assert.deepEqual([r.exit, r.result, r.lineage], [1, 'FAIL', 'FAIL'], `${name}: ${r.reason}`);
    assert.match(r.reason, why, name);
  }

  const absent = prove(t, variant(t, files, {}, ['basis-after-ack.json']));
  assert.deepEqual([absent.exit, absent.lineage], [2, 'UNVERIFIED'], absent.reason);
  assert.match(absent.reason, /Not bound in the manifest: basis-after-ack\.json\./);
});

test('B1P4: every opening path passes through the real command, the book\'s notional equal to the receipt\'s as written; a capture with several distinct orders and reservations stays valid', async (t) => {
  const caps = {};
  for (const kind of ['approve-down', 'approve-risk', 'mandate-down', 'mandate-risk']) {
    const o = await newOpening(t, kind);
    const cap = await capture(t, o.s, o.d);
    const basis = JSON.parse(cap.basis.toString('utf8'));
    const res = basis.execution.reserved.find((x) => x.client_order_id === o.line.client_order_id);
    // The producer's representation: the book's notional (mulCeil(quantity, entry) at 18 places, trailing zeros trimmed) is the receipt's string.
    assert.equal(res.notional_usd, res.contract_guard.exit.notional_usd, `${kind}: the same notional, character for character`);
    assert.deepEqual(res.opening_receipt.differences, [], `${kind}: the desk's check lists none`);
    const files = membersOf(o.s, o.d, o.receipt, o.line, cap);
    const r = prove(t, seal(tmp(t, 'ev'), files));
    assert.deepEqual([r.exit, r.result, r.lineage], [2, 'UNVERIFIED', 'PASS'], `${kind}: ${r.reason}`);
    assert.match(r.reason, /The book reserved the notional the receipt was measured at, /, kind);
    caps[kind] = { o, files, row: JSON.parse(cap.view.toString('utf8')).orders.find((x) => x.client_order_id === o.line.client_order_id), res };
  }
  // A's capture with the other desks' orders and reservations beside its own, before and after it: distinct IDs, hashes and orders.
  const a = caps['approve-down'];
  const others = ['approve-risk', 'mandate-down', 'mandate-risk'].map((k) => caps[k]);
  const ids = new Set([a, ...others].map((c) => c.res.intent_id));
  assert.equal(ids.size, 4, 'four distinct intents');
  const many = variant(t, a.files, {
    'trader-after-ack.json': (v) => { const mine = v.orders.find((x) => x.client_order_id === a.o.line.client_order_id); v.orders = [others[0].row, others[1].row, mine, others[2].row]; },
    'basis-after-ack.json': (v) => { const mine = v.execution.reserved.find((x) => x.client_order_id === a.o.line.client_order_id); v.execution.reserved = [others[0].res, mine, others[1].res, others[2].res]; },
  });
  const r = prove(t, many);
  assert.deepEqual([r.exit, r.lineage], [2, 'PASS'], r.reason);
});

test('B1P5: through the real command, the review\'s contradictions on real captures: the reservation\'s own differences, its notional, and repeated rows or reservations fail even when the row reads bound', async (t) => {
  const { s, d, receipt, line } = await newOpening(t);
  const files = membersOf(s, d, receipt, line, await capture(t, s, d));
  const row = (v) => v.orders.find((o) => o.client_order_id === line.client_order_id);
  const res = (v) => v.execution.reserved.find((x) => x.client_order_id === line.client_order_id);
  const CASES = [
    ['X1: the reservation\'s desk check reads bound and lists a difference', { 'basis-after-ack.json': (v) => { res(v).opening_receipt.differences = [{ field: 'exit.pool' }]; } }, /The desk's check of the reservation lists 1 difference\(s\)\./],
    ['X2: the book reserved another notional', { 'basis-after-ack.json': (v) => { res(v).notional_usd = '1'; } }, /The book reserved a notional of 1; the receipt was measured at /],
    ['X2b: the book\'s notional one part in 10^18 over', { 'basis-after-ack.json': (v) => { res(v).notional_usd = up18(res(v).notional_usd); } }, /The book reserved a notional of \d+\.\d{18}; the receipt was measured at /],
    ['M8a: this order\'s row again after it, naming another observation', { 'trader-after-ack.json': (v) => { const o = clone(row(v)); o.opening_receipt.observation_id = 'co_0000000000000000'; v.orders.push(o); } }, /The trader view lists this order 2 times/],
    ['M8c: another row carrying this order\'s intent', { 'trader-after-ack.json': (v) => { v.orders.push({ ...clone(row(v)), client_order_id: 'cr2-twin' }); } }, /Another row in the trader view carries this order's intent/],
    ['M9: a twin reservation with this intent\'s ID and hash, another order, 70 tokens', { 'basis-after-ack.json': (v) => { v.execution.reserved.push({ ...clone(res(v)), client_order_id: 'cr2-twin', position_id: 'pos-twin', quantity: '70' }); } }, /Another reservation in the decision's execution carries this order's intent/],
    ['M3: this order\'s reservation twice', { 'basis-after-ack.json': (v) => { v.execution.reserved.push(clone(res(v))); } }, /holds more than one reservation for this order/],
  ];
  for (const [name, edits, why] of CASES) {
    const dir = variant(t, files, edits);
    assert.equal(row(JSON.parse(fs.readFileSync(path.join(dir, 'B1', 'trader-after-ack.json'), 'utf8'))).opening_receipt.status, 'bound', `${name}: the row still says bound`);
    const r = prove(t, dir);
    assert.deepEqual([r.exit, r.result, r.lineage], [1, 'FAIL', 'FAIL'], `${name}: ${r.reason}`);
    assert.match(r.reason, why, name);
  }
});

test('B1P2: a valid proof reads the same from its bundle after the desk\'s current observation and settings change, and a capture made after them still binds', async (t) => {
  const { s, d, receipt, line } = await newOpening(t);
  const files = membersOf(s, d, receipt, line, await capture(t, s, d));
  const bundle = seal(tmp(t, 'ev'), files);
  const before = prove(t, bundle);
  assert.equal(before.lineage, 'PASS', before.reason);

  // The pool drained to a size that proves nothing, the quoter paying zero; settings tightened on disk.
  await X.observe(s, { pair: X.THIN, quoter: 'zero' });
  s.ws.settings.contracts = { ...s.ws.settings.contracts, network_fee_ceiling_usd: { [X.CHAIN]: 0.25 } };
  s.ws.settings.freshness = { ...(s.ws.settings.freshness || {}), price_stale_minutes: 30 };
  X.persist(s);

  const again = prove(t, bundle);
  assert.deepEqual([again.exit, again.result, again.lineage, again.reason], [before.exit, before.result, before.lineage, before.reason], 'the same verdict and the same words from the same bundle');

  const later = await capture(t, s, d);
  const laterRow = JSON.parse(later.view.toString('utf8')).orders.find((o) => o.client_order_id === line.client_order_id).opening_receipt;
  assert.equal(laterRow.status, 'bound', laterRow.words);
  const relived = prove(t, seal(tmp(t, 'ev'), membersOf(s, d, receipt, line, later)));
  assert.equal(relived.lineage, 'PASS', relived.reason);
});

test('B1P3: an order made before the receipt existed stays readable (trader view and basis) and fails B1, never passes', async (t) => {
  const s = X.desk(t, { label: 'b1-proof-old' });
  const { receipt } = await X.ready(s);
  const realAttach = OR.attach;
  OR.attach = (intent) => intent;
  t.after(() => { OR.attach = realAttach; });
  const d = X.approve(s, receipt);
  OR.attach = realAttach;
  const lines = X.reservedFor(s, d.decision_id);
  assert.equal(lines.length, 1, X.rowOf(s, d.decision_id).words);
  const cap = await capture(t, s, d);
  const row = JSON.parse(cap.view.toString('utf8')).orders.find((o) => o.client_order_id === lines[0].client_order_id);
  assert.deepEqual([row.state, row.side, row.opening_receipt.status], ['ACKED', 'OPEN_LONG', 'missing']);
  const res = JSON.parse(cap.basis.toString('utf8')).execution.reserved[0];
  assert.deepEqual([res.contract_guard, res.opening_receipt.status, res.quantity], [null, 'missing', lines[0].quantity]);
  const r = prove(t, seal(tmp(t, 'ev'), membersOf(s, d, receipt, lines[0], cap)));
  assert.deepEqual([r.exit, r.lineage], [1, 'FAIL'], r.reason);
  assert.match(r.reason, /opening receipt reads missing/);
});
