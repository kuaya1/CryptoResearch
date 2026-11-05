'use strict';
// A restored copy on hold (config/restored-copy.json, research.js restoredHold) and
// the Paper Book (core/trader-desk.js): nothing funds, orders or applies an hour until
// Eric has ruled on what would run and released it. Fictional records in temporary
// workspaces only: nothing here is a market, a venue, an order or the Render disk.
// See docs/engineering/PAPER_BOOK_RESTORE.md.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const T = require('../core/tickets');
const TD = require('../core/trader-desk');
const PT = require('../core/paper-trader');
const TR = require('../core/trader-rules');
const RS = require('../core/research');
const X = require('../core/exporter');
const J = require('../core/jobs');
const DB = require('../core/decision-basis');
const { OPLOG_REL, StagedOp, withLock, recover } = require('../core/ops');
const { openWorkspace } = require('../core/workspace');
const { H, iso, deskWith, settle, bar } = require('./trader-fixture');
const { mandateDesk, saveTicket } = require('./mandate-fixture');

const CODE = path.join(__dirname, '..');
const VAR = TR.BOOK_ANCHOR_ENV;
const MARK = 'config/restored-copy.json';
const WRITERS = ['fund', 'recover', 'reconcile', 'cancelOrder', 'submitIntent', 'applyBar'];

function stub(t, obj, name, make) {
  const real = obj[name];
  obj[name] = make(real);
  t.after(() => { obj[name] = real; });
}
function clean(t) {
  const had = process.env.CR_DATA_DIR;
  delete process.env.CR_DATA_DIR;
  delete process.env[VAR];
  t.after(() => { delete process.env[VAR]; if (had !== undefined) process.env.CR_DATA_DIR = had; });
}
const save = (ws, rels) => Object.fromEntries(rels.map((r) => { try { return [r, fs.readFileSync(ws.abs(r))]; } catch (_) { return [r, null]; } }));
function put(ws, saved, rels) { for (const r of rels) { if (saved[r] === null) fs.rmSync(ws.abs(r), { force: true }); else { fs.mkdirSync(path.dirname(ws.abs(r)), { recursive: true }); fs.writeFileSync(ws.abs(r), saved[r]); } } }
function find(ws, name) { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'backups') walk(p); } else if (e.name === name) out.push(path.relative(ws.root, p).split(path.sep).join('/')); } }; walk(ws.root); return out; }
const hold = (ws) => { fs.mkdirSync(path.dirname(ws.abs(MARK)), { recursive: true }); fs.writeFileSync(ws.abs(MARK), JSON.stringify({ schema_version: 'cr.restored-copy.v1', research_held: true, restored_at: new Date().toISOString(), from: { kind: 'test' } })); };
const marker = (ws) => fs.readFileSync(ws.abs(MARK), 'utf8');
// The fixtures read the real hour more than once, so a test must not cross the top of an
// hour. None starts within this long of it; the slowest takes about 8 seconds on its own.
const HOUR_MARGIN_MS = 30000;
test.beforeEach(async () => {
  const left = H - (Date.now() % H);
  if (left < HOUR_MARGIN_MS) await new Promise((resolve) => { setTimeout(resolve, left + 50); });
});
const topHour = () => Math.floor(Date.now() / H) * H;
const hours = (ws) => TD.applyHours(ws, Array.from({ length: 16 }, (_, i) => bar(topHour() - (16 - i) * H)), { now: iso(Date.now()) });
const anchorOn = (ws) => { process.env[VAR] = TR.genesisOf(fs.readFileSync(ws.abs(PT.JOURNAL), 'utf8').split('\n')[0]); };
const ready = (ws) => { settle(ws); PT.fund(ws, { cash_usd: '25000', now: iso(Date.now()) }); hours(ws); };
const has = (ws, id) => PT.intents(ws).some((i) => i.intent_id === id);
const code = (c) => (e) => e.code === c;

// The grant from before the cutoff whose order went after it, and the matched set from
// that cutoff put back: nothing in the copy says the order was ever sent.
function preCutoffGrant(t, tag = 'pre') {
  clean(t);
  const s = deskWith(t);
  const { ws, pid, rid } = s;
  const d = T.decide(ws, pid, { receipt_id: rid, action: 'approve', request_id: `req_hold_${tag}` }).result.decision;
  ready(ws);
  const rels = [PT.JOURNAL, PT.HEAD, PT.VENUE, OPLOG_REL, ...find(ws, 'decisions.jsonl')];
  const copy = save(ws, rels);
  TD.step(ws);
  const intent = TD.intentIdOf(d, 'open');
  assert.ok(has(ws, intent), 'the order went after the copy was made');
  ws.hosted = true;
  anchorOn(ws);
  fs.rmSync(ws.abs('paper/trader'), { recursive: true });
  fs.rmSync(ws.abs(OPLOG_REL));
  put(ws, copy, rels);
  assert.equal(has(ws, intent), false, 'the copy does not know it');
  return { ...s, d, intent };
}

// A live buy, or with fill: true an open position.
function liveOrder(t, { fill = false, tag = 'live' } = {}) {
  clean(t);
  const s = deskWith(t);
  const { ws, pid, rid } = s;
  ready(ws);
  const d = T.decide(ws, pid, { receipt_id: rid, action: 'approve', request_id: `req_hold_${tag}` }).result.decision;
  const intent = TD.intentIdOf(d, 'open');
  assert.ok(has(ws, intent), 'the buy is on record');
  const top = topHour();
  let next = top;
  if (fill) {
    const at = iso(top + 2 * H + 60000);
    TD.applyHours(ws, [bar(top), bar(top + H)], { now: at });
    assert.equal(PT.results(ws, { now: at }).open_positions.length, 1, 'the position is open');
    next = top + 2 * H;
  }
  return { ...s, d, intent, next };
}

// --- Requirement 2: the regression

test('REGRESSION a grant from before the cutoff whose order went after it is not sent again while held', (t) => {
  const { ws, intent } = preCutoffGrant(t);
  hold(ws);
  const r = TD.step(ws);
  assert.equal(has(ws, intent), false, 'UNSAFE: the order went out again under the same intent ID from a restored copy on hold');
  assert.deepEqual(r.done, []);
  assert.deepEqual(r.problems.map((p) => p.code), ['RESTORE_HELD']);
});

test('REGRESSION a release does not set that grant going without a ruling', (t) => {
  const { ws, intent, d } = preCutoffGrant(t);
  hold(ws);
  const before = marker(ws);
  assert.throws(() => RS.releaseRestoredCopy(ws), code('RULING_REQUIRED'), 'UNSAFE: released with a grant nobody ruled on');
  assert.equal(marker(ws), before, 'the hold stands');
  assert.ok(RS.restoredHold(ws));
  TD.step(ws);
  assert.equal(has(ws, intent), false);
  assert.deepEqual(TD.rulingsNeeded(ws).map((x) => [x.kind, x.decision_id, x.opening_intent]), [['opening', d.decision_id, intent]]);
});

// --- Requirement 1: every path refuses, reads say so

test('while held no writer of the book is reached, on any path', async (t) => {
  const { ws, pid, rid, intent, next } = liveOrder(t, { fill: true });
  hold(ws);
  const called = [];
  for (const w of WRITERS) stub(t, PT, w, (real) => (...a) => { called.push(w); return real(...a); });
  const journal = fs.readFileSync(ws.abs(PT.JOURNAL));
  assert.deepEqual(TD.step(ws).problems.map((p) => p.code), ['RESTORE_HELD'], 'the step');
  assert.deepEqual(TD.step(ws, { project: pid }).done, [], 'the step for one project');
  const rows = TD.applyHours(ws, [bar(next, { low: '0.60', close: '0.65' })], { now: iso(next + H + 60000) });
  assert.deepEqual(rows.map((r) => [r.pair, r.status, r.code]), [[null, 'refused', 'RESTORE_HELD']], 'the hours, stopped before any pair');
  const u = T.decide(ws, pid, { receipt_id: rid, action: 'undo', request_id: 'req_hold_undo_all' });
  assert.ok(u.result.decision, 'a decision is still recorded');
  assert.ok(u.result.trader.problems.some((p) => p.code === 'RESTORE_HELD'), 'and says the hold');
  const job = await J.runJob(ws, 'trader', { trigger: 'scheduler', foreground: true });
  assert.equal(job.status, 'skipped', 'the job');
  assert.deepEqual(called, []);
  assert.ok(fs.readFileSync(ws.abs(PT.JOURNAL)).equals(journal), 'the journal is the same bytes');
  assert.ok(has(ws, intent));
});

test('while held nothing funds: the command, the fictional exemption, the hours', (t) => {
  clean(t);
  const a = deskWith(t);
  settle(a.ws);
  hold(a.ws);
  assert.throws(() => TD.bootstrapBook(a.ws, { cash_usd: '25000', confirm: TD.bootstrapWords('25000') }), code('RESTORE_HELD'));
  assert.equal(fs.existsSync(a.ws.abs(PT.JOURNAL)), false);
  TD.step(a.ws);
  assert.equal(fs.existsSync(a.ws.abs(PT.JOURNAL)), false, 'the exemption for a fictional workspace is held too');
  TD.applyHours(a.ws, [bar(topHour() - H)], { now: iso(Date.now()) });
  assert.equal(fs.existsSync(a.ws.abs(PT.JOURNAL)), false);
});

test('an order caught mid-send is not recovered while held, and is named', (t) => {
  clean(t);
  const { ws, pid, rid } = deskWith(t);
  ready(ws);
  // The process dies between reserving the order and sending it.
  const realSubmit = PT.submitIntent;
  PT.submitIntent = (w, intent, ctx) => PT.reserveIntent(w, intent, ctx);
  let d;
  try { d = T.decide(ws, pid, { receipt_id: rid, action: 'approve', request_id: 'req_hold_reserved' }).result.decision; } finally { PT.submitIntent = realSubmit; }
  assert.ok(PT.results(ws, { now: iso(Date.now()) }).orders.some((o) => o.state === 'RESERVED'));
  hold(ws);
  const called = [];
  stub(t, PT, 'recover', (real) => (...a) => { called.push('recover'); return real(...a); });
  TD.step(ws);
  assert.deepEqual(called, [], 'not while held');
  const need = TD.rulingsNeeded(ws);
  assert.deepEqual(need.map((x) => [x.id, x.kind, x.may_accept]), [[d.decision_id, 'order', true]]);
  assert.equal(RS.releaseRestoredCopy(ws, { accept: [d.decision_id] }).status, 'saved');
  TD.step(ws);
  assert.deepEqual(called, ['recover'], 'after the release the book recovers it itself');
});

test('reads stay open and say the hold', (t) => {
  const { ws, d } = preCutoffGrant(t);
  assert.equal(TD.view(ws).restore_hold, undefined, 'nothing said when nothing is held');
  assert.equal(TD.requests(ws).requests[0].phase, 'ready');
  hold(ws);
  const v = TD.view(ws);
  assert.equal(v.restore_hold.held, true);
  assert.equal(v.restore_hold.from.kind, 'test');
  assert.deepEqual(v.restore_hold.rulings_needed.map((x) => x.decision_id), [d.decision_id]);
  assert.equal(v.waits[0], TD.HOLD_WORDS);
  assert.equal(v.book_identity.anchor, 'established');
  assert.equal(v.requests[0].phase, 'waiting', 'never reads as ready');
  assert.match(v.requests[0].words, /^On hold, nothing is sent/);
  assert.equal(v.requests[0].next, undefined);
  const q = TD.requests(ws);
  assert.equal(q.waits[0], TD.HOLD_WORDS);
  assert.equal(q.requests[0].phase, 'waiting');
});

test('a marker that does not read holds; only a release ends a hold', (t) => {
  for (const text of ['{ not json', '[]', '"held"', 'null', '7', '']) {
    const { ws, intent } = preCutoffGrant(t, `bad${text.length}`);
    fs.mkdirSync(path.dirname(ws.abs(MARK)), { recursive: true });
    fs.writeFileSync(ws.abs(MARK), text);
    TD.step(ws);
    assert.equal(has(ws, intent), false, `marker ${JSON.stringify(text)}`);
    assert.equal(TD.view(ws).restore_hold.held, true);
    assert.equal(TD.view(ws).restore_hold.unreadable, true);
    const before = fs.readFileSync(ws.abs(MARK), 'utf8');
    assert.throws(() => RS.releaseRestoredCopy(ws), 'a release refuses');
    assert.equal(fs.readFileSync(ws.abs(MARK), 'utf8'), before);
    // The way out: write the marker again, then rule and release.
    assert.equal(RS.holdRestoredCopy(ws, { from: 'marker repaired' }).status, 'saved');
    assert.equal(RS.restoredHold(ws).from.words, 'marker repaired');
  }
  const { ws } = preCutoffGrant(t, 'badcli');
  fs.writeFileSync(ws.abs(MARK), '{ not json');
  const r = spawnSync(process.execPath, [path.join(CODE, 'cli.js'), 'restored-copy', 'hold', '--confirm', '--from', 'repaired', '--workspace', ws.root], { encoding: 'utf8', env: process.env, timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(RS.restoredHold(ws));
});

test('a marker that is not a record cannot be released, even with nothing to rule on', (t) => {
  clean(t);
  const { ws } = deskWith(t);
  for (const text of ['[]', '"held"', '7', 'null']) {
    fs.mkdirSync(path.dirname(ws.abs(MARK)), { recursive: true });
    fs.writeFileSync(ws.abs(MARK), text);
    assert.throws(() => RS.releaseRestoredCopy(ws), code('INVALID'), text);
    assert.equal(fs.readFileSync(ws.abs(MARK), 'utf8'), text);
  }
});

// --- Requirement 3: everything that could run is accounted for

test('every kind is listed: a decision recorded during the hold, a queued grant, a position, a cancel', (t) => {
  clean(t);
  // Recorded during the hold, and queued: the book has no hours for it.
  const a = deskWith(t);
  settle(a.ws);
  PT.fund(a.ws, { cash_usd: '25000', now: iso(Date.now()) });
  hold(a.ws);
  const during = T.decide(a.ws, a.pid, { receipt_id: a.rid, action: 'approve', request_id: 'req_hold_during' }).result.decision;
  assert.equal(has(a.ws, TD.intentIdOf(during, 'open')), false);
  assert.deepEqual(TD.rulingsNeeded(a.ws).map((x) => [x.kind, x.decision_id, x.phase, x.may_accept]), [['opening', during.decision_id, 'waiting', false]]);
  assert.throws(() => RS.releaseRestoredCopy(a.ws), code('RULING_REQUIRED'));
  // An open position.
  const b = liveOrder(t, { fill: true, tag: 'pos' });
  hold(b.ws);
  assert.deepEqual(TD.rulingsNeeded(b.ws, { now: iso(b.next + 60000) }).map((x) => [x.kind, x.decision_id]), [['position', b.d.decision_id]]);
  // A live buy, and then Undone during the hold: the cancel it asks for.
  const c = liveOrder(t, { tag: 'buy' });
  hold(c.ws);
  assert.deepEqual(TD.rulingsNeeded(c.ws).map((x) => x.kind), ['order']);
  T.decide(c.ws, c.pid, { receipt_id: c.rid, action: 'undo', request_id: 'req_hold_undo_buy' });
  assert.deepEqual(TD.rulingsNeeded(c.ws).map((x) => [x.kind, x.decision_id]), [['cancel', c.d.decision_id]]);
  assert.throws(() => RS.releaseRestoredCopy(c.ws), code('RULING_REQUIRED'));
  assert.equal(RS.releaseRestoredCopy(c.ws, { accept: [c.d.decision_id] }).status, 'saved');
  TD.step(c.ws);
  const o = PT.results(c.ws, { now: iso(Date.now()) }).orders.find((x) => x.state === 'CANCELLED');
  assert.ok(o, 'the cancel the owner ruled on goes');
});

test('an order no decision names is not a matched set: named, and it cannot be accepted', (t) => {
  const { ws, pid, intent } = liveOrder(t, { tag: 'orphan' });
  for (const r of find(ws, 'decisions.jsonl')) if (r.includes(pid)) fs.writeFileSync(ws.abs(r), '');
  hold(ws);
  const need = TD.rulingsNeeded(ws);
  assert.deepEqual(need.map((x) => [x.id, x.kind, x.may_accept]), [[intent, 'unmatched_order', false]]);
  assert.throws(() => RS.releaseRestoredCopy(ws, { accept: [intent] }), code('RULING_REQUIRED'));
});

test('a history that does not read refuses the release: unknown is not none', (t) => {
  const { ws, pid } = preCutoffGrant(t, 'unread');
  hold(ws);
  const before = marker(ws);
  fs.appendFileSync(ws.abs(find(ws, 'decisions.jsonl').find((r) => r.includes(pid))), '{ not a line\n');
  assert.throws(() => RS.releaseRestoredCopy(ws));
  assert.equal(marker(ws), before);
  // The read stays open and says so.
  const seen = TD.view(ws).restore_hold;
  assert.equal(seen.rulings_needed, null);
  assert.ok(seen.rulings_unreadable);
});

test('an active mandate blocks the release and cannot be accepted; off, nothing grants after it', (t) => {
  clean(t);
  const s = mandateDesk(t, { grade: 60 });
  saveTicket(s.ws, s.pid, { exits: true });
  hold(s.ws);
  const need = TD.rulingsNeeded(s.ws);
  assert.deepEqual(need.map((x) => [x.kind, x.may_accept, x.generation]), [['mandate', false, 1]]);
  assert.match(T.mandateSweep(s.ws).why, /restored copy/, 'held at its source');
  const before = marker(s.ws);
  assert.throws(() => RS.releaseRestoredCopy(s.ws), code('RULING_REQUIRED'));
  assert.throws(() => RS.releaseRestoredCopy(s.ws, { accept: [need[0].id] }), code('RULING_REQUIRED'));
  assert.equal(marker(s.ws), before);
  s.ws.settings.automation.autonomous_paper_loop = false;
  assert.deepEqual(TD.rulingsNeeded(s.ws), []);
  assert.equal(RS.releaseRestoredCopy(s.ws).status, 'saved');
  const sweep = T.mandateSweep(s.ws);
  assert.equal(sweep.status, 'skipped');
  assert.deepEqual(sweep.granted, []);
  assert.deepEqual(T.readDecisions(s.ws, s.pid), [], 'no grant follows the release');
});

test('a grant the mandate made, ruled by Undo: no order follows the release', (t) => {
  clean(t);
  const s = mandateDesk(t, { grade: 60 });
  const r = saveTicket(s.ws, s.pid, { exits: true });
  const by = 'mandate:cr-paper-mandate@1';
  stub(t, T, 'mandateContractEvidence', () => () => null);
  const file = s.ws.abs(`projects/${s.pid}/project.json`);
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  p.identity.assets = [{ chain: 'base', contract_address: '0x00000000000000000000000000000000000a11ce' }];
  fs.writeFileSync(file, JSON.stringify(p, null, 2));
  fs.mkdirSync(s.ws.abs(`projects/${s.pid}/tickets`), { recursive: true });
  fs.writeFileSync(s.ws.abs(`projects/${s.pid}/tickets/profile.json`), JSON.stringify({ schema_version: 'cr.ticket-profile.v1', project_id: s.pid, pilot: true, pilot_set_at: new Date().toISOString(), pilot_set_by: 'eric' }));
  const swept = T.mandateSweep(s.ws);
  assert.equal(swept.granted.length, 1, JSON.stringify(swept.skipped));
  const line = T.readDecisions(s.ws, s.pid).find((l) => l.decided_by === by);
  hold(s.ws);
  assert.deepEqual(TD.rulingsNeeded(s.ws).map((x) => x.kind).sort(), ['mandate', 'opening']);
  s.ws.settings.automation.autonomous_paper_loop = false;
  // Off, its authority is revoked for good, so it can never pass and is not asked about.
  assert.deepEqual(TD.rulingsNeeded(s.ws), []);
  // Undo it anyway, as the owner may: recorded, and nothing goes.
  assert.ok(T.decide(s.ws, s.pid, { receipt_id: r.receipt_id || line.receipt_id, action: 'undo', request_id: 'req_hold_undo_mand' }).result.decision);
  assert.equal(RS.releaseRestoredCopy(s.ws).status, 'saved');
  settle(s.ws);
  TD.step(s.ws);
  assert.equal(fs.existsSync(s.ws.abs(PT.JOURNAL)) && has(s.ws, TD.intentIdOf(line, 'open')), false);
});

// --- Requirement 4: what accepting means

test('an opening cannot be accepted: its old ID would go out with a new life', (t) => {
  const { ws, d, intent } = preCutoffGrant(t, 'noaccept');
  hold(ws);
  const rels = [PT.JOURNAL, ...find(ws, 'decisions.jsonl'), MARK];
  const before = save(ws, rels);
  assert.throws(() => RS.releaseRestoredCopy(ws, { accept: [d.decision_id] }), (e) => e.code === 'RULING_REQUIRED' && /cannot be accepted/.test(e.message) && /decide again after the release/.test(e.message));
  for (const r of rels) assert.ok(fs.readFileSync(ws.abs(r)).equals(before[r]), `${r} is unchanged`);
  TD.step(ws);
  assert.equal(has(ws, intent), false);
});

test('the only way on for an opening: Undo, release, nothing goes; a new decision is new authority with a new ID and basis', (t) => {
  const { ws, pid, rid, d, intent } = preCutoffGrant(t, 'redecide');
  hold(ws);
  T.decide(ws, pid, { receipt_id: rid, action: 'undo', request_id: 'req_hold_undo_old' });
  assert.deepEqual(TD.rulingsNeeded(ws), [], 'an Undone grant with no order can never run');
  assert.equal(RS.releaseRestoredCopy(ws).status, 'saved');
  assert.deepEqual(TD.step(ws).done, []);
  assert.equal(has(ws, intent), false, 'the old ID never goes out');
  const again = T.decide(ws, pid, { receipt_id: rid, action: 'approve', request_id: 'req_hold_again' }).result.decision;
  assert.notEqual(again.decision_id, d.decision_id);
  const fresh = TD.intentIdOf(again, 'open');
  assert.notEqual(fresh, intent);
  assert.ok(has(ws, fresh), 'the new decision opens under its own ID');
  assert.equal(has(ws, intent), false);
  assert.equal(DB.viewOf(ws, pid, again.decision_id).label, 'decision_time', 'with its own basis, frozen when it was made');
});

test('accepting writes nothing into the book, extends nothing, and gives no new authority', (t) => {
  const { ws, d, intent } = liveOrder(t, { tag: 'accept' });
  const one = () => PT.intents(ws).find((i) => i.intent_id === intent);
  const lifeOf = () => { const seen = fs.readFileSync(ws.abs(PT.JOURNAL), 'utf8').split('\n').filter((l) => l.includes(intent) && l.includes('valid_until')).map((l) => /"valid_until":"([^"]+)"/.exec(l)[1]); assert.equal(new Set(seen).size, 1, 'one validity on record'); return seen[0]; };
  const was = JSON.stringify(one());
  const life = lifeOf();
  const lines = find(ws, 'decisions.jsonl');
  hold(ws);
  const before = save(ws, [PT.JOURNAL, PT.HEAD, ...lines]);
  const r = RS.releaseRestoredCopy(ws, { accept: [d.decision_id] });
  assert.equal(r.status, 'saved');
  assert.deepEqual(r.accepted.map((a) => [a.decision_id, a.kind]), [[d.decision_id, 'order']]);
  for (const f of Object.keys(before)) assert.ok(fs.readFileSync(ws.abs(f)).equals(before[f]), `${f}: the release did not touch it`);
  assert.equal(JSON.stringify(one()), was, 'the same intent: same ID, same state');
  assert.equal(lifeOf(), life, 'the same validity');
  assert.deepEqual(JSON.parse(marker(ws)).accepted.map((a) => a.decision_id), [d.decision_id], 'the ruling is on the marker');
  // The engine still decides from its own gates: the order expires at its own time.
  const above = { low: '0.90', high: '0.95', open: '0.92', close: '0.92' };
  const top = topHour();
  TD.applyHours(ws, [0, 1, 2, 3, 4].map((n) => bar(top + n * H, above)), { now: iso(top + 5 * H + 60000) });
  assert.equal(lifeOf(), life, 'never extended');
  assert.notEqual(one().state, 'ACKED', 'it ended on its own expiry');
});

test('accepting checks the decision basis: a record that does not stand refuses the release', (t) => {
  const { ws, pid, d } = liveOrder(t, { tag: 'basis' });
  hold(ws);
  const rel = DB.basisRel(pid, d.decision_id);
  fs.writeFileSync(ws.abs(rel), '{ not a record');
  const before = marker(ws);
  assert.throws(() => RS.releaseRestoredCopy(ws, { accept: [d.decision_id] }), (e) => ['INTEGRITY', 'RULING_REQUIRED'].includes(e.code));
  assert.equal(marker(ws), before, 'the hold stands');
});

test('a name that is not waiting refuses the whole release', (t) => {
  const { ws, d } = liveOrder(t, { tag: 'stray' });
  hold(ws);
  assert.throws(() => RS.releaseRestoredCopy(ws, { accept: [d.decision_id, 'td_NOT_A_DECISION'] }), code('INVALID'));
  assert.ok(RS.restoredHold(ws));
});

// --- Requirement 5: failure and concurrency

test('a release that fails after its checks, or dies before sealing, leaves the hold', (t) => {
  const { ws, d } = liveOrder(t, { tag: 'fail' });
  hold(ws);
  const before = marker(ws);
  stub(t, DB, 'viewOf', () => () => { throw new Error('died during the release'); });
  assert.throws(() => RS.releaseRestoredCopy(ws, { accept: [d.decision_id] }), /died during the release/);
  assert.equal(marker(ws), before);
  // Dies with the release staged and not sealed.
  const op = new StagedOp(ws, 'update_settings', 'a release that dies before its seal');
  op.write(MARK, JSON.stringify({ ...JSON.parse(before), research_held: false }));
  assert.equal(marker(ws), before);
  recover(ws);
  assert.equal(marker(ws), before, 'rolled back');
  assert.ok(RS.restoredHold(ws));
});

test('a hold sealed but not yet in place when a write comes: recovery completes it, then the write refuses', (t) => {
  const { ws, pid, rid } = preCutoffGrant(t, 'sealed');
  const op = new StagedOp(ws, 'update_settings', 'a hold that dies after its seal');
  op.write(MARK, JSON.stringify({ research_held: true, restored_at: new Date().toISOString() }));
  op.seal();
  assert.equal(fs.existsSync(ws.abs(MARK)), false);
  const r = TD.step(ws);
  assert.ok(RS.restoredHold(ws), 'recovery put it in place');
  assert.deepEqual(r.done, []);
  assert.ok(r.problems.some((p) => p.code === 'RESTORE_HELD'));
  assert.ok(pid && rid);
});

test('a step that read the book before a hold and a release writes nothing from that read', (t) => {
  const { ws, pid, rid, intent } = preCutoffGrant(t, 'cross');
  const called = [];
  stub(t, PT, 'submitIntent', (real) => (...a) => { called.push('submit'); return real(...a); });
  // Between the step's read and its write: Eric holds, Undoes the grant and releases.
  let once = false;
  stub(t, PT, 'book', (real) => (...a) => {
    const v = real(...a);
    if (!once) {
      once = true;
      hold(ws);
      T.decide(ws, pid, { receipt_id: rid, action: 'undo', request_id: 'req_hold_cross_undo' });
      RS.releaseRestoredCopy(ws);
    }
    return v;
  });
  const r = TD.step(ws);
  assert.equal(once, true, 'the interleaving happened');
  assert.deepEqual(called, [], 'the stale read never reached the book');
  assert.equal(has(ws, intent), false);
  assert.ok(r.problems.some((p) => p.code === 'RESTORE_HELD'));
});

test('a hold that lands between a read and its write refuses it: step and hours', (t) => {
  const a = preCutoffGrant(t, 'between');
  let once = false;
  stub(t, PT, 'book', (real) => (...x) => { const v = real(...x); if (!once) { once = true; hold(a.ws); } return v; });
  const r = TD.step(a.ws);
  assert.equal(once, true);
  assert.equal(has(a.ws, a.intent), false);
  assert.ok(r.problems.some((p) => p.code === 'RESTORE_HELD'));
  const b = liveOrder(t, { fill: true, tag: 'betweenhours' });
  const journal = fs.readFileSync(b.ws.abs(PT.JOURNAL));
  let twice = false;
  stub(t, PT, 'intents', (real) => (...x) => { const v = real(...x); if (!twice) { twice = true; hold(b.ws); } return v; });
  const rows = TD.applyHours(b.ws, [bar(b.next)], { now: iso(b.next + H + 60000) });
  assert.equal(twice, true);
  assert.ok(rows.some((x) => x.code === 'RESTORE_HELD'), JSON.stringify(rows));
  assert.ok(fs.readFileSync(b.ws.abs(PT.JOURNAL)).equals(journal));
});

test('the release reads under the lock: a decision made after the last read is seen, and no writer can come between', (t) => {
  clean(t);
  const { ws, pid, rid } = deskWith(t);
  ready(ws);
  hold(ws);
  // Read, then a decision, then the release naming only what was read: nothing.
  assert.deepEqual(TD.rulingsNeeded(ws), []);
  T.decide(ws, pid, { receipt_id: rid, action: 'approve', request_id: 'req_hold_fresh' });
  assert.throws(() => RS.releaseRestoredCopy(ws), code('RULING_REQUIRED'), 'the newer decision was read');
  assert.ok(RS.restoredHold(ws));
  // A second writer during the release's reads cannot get in.
  const second = openWorkspace({ root: ws.root, actor: 'contender' });
  let tried = 0;
  stub(t, TD, 'rulingsNeeded', (real) => (...a) => {
    tried += 1;
    assert.throws(() => withLock(second, 'contender', () => { throw new Error('it got in'); }, { timeoutMs: 40 }), code('WORKSPACE_BUSY'));
    return real(...a);
  });
  assert.throws(() => RS.releaseRestoredCopy(ws), code('RULING_REQUIRED'));
  assert.equal(tried, 1);
});

test('the book cannot be released through any route: command line only', () => {
  for (const f of ['server.js', 'hosted.js', 'core/mcp.js', 'mcp.js']) {
    const file = path.join(CODE, f);
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    assert.ok(!/releaseRestoredCopy|holdRestoredCopy/.test(src), `${f} must not reach them`);
  }
});

// --- Requirement 6: the hold through every supported restore, and what is excluded

function releasedWithBackup(t, tag) {
  const s = preCutoffGrant(t, tag);
  // A copy whose own marker says released: that must not carry through a restore.
  hold(s.ws);
  T.decide(s.ws, s.pid, { receipt_id: s.rid, action: 'undo', request_id: `req_hold_${tag}_u` });
  RS.releaseRestoredCopy(s.ws);
  assert.equal(RS.restoredHold(s.ws), null);
  return s;
}

test('a package restored into a new folder is held, whatever its source said', (t) => {
  const { ws, root } = releasedWithBackup(t, 'pkg');
  const dest = path.join(path.dirname(root), `${path.basename(root)}-pkg`);
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }));
  X.restorePackage(X.exportPackage(ws), dest);
  const copy = openWorkspace({ root: dest, actor: 'test' });
  assert.ok(RS.restoredHold(copy));
  settle(copy);
  assert.deepEqual(TD.step(copy).problems.map((p) => p.code), ['RESTORE_HELD']);
  assert.equal(TD.view(copy).restore_hold.held, true);
});

test('the offsite drill restores a held copy: the command itself, not only the package it calls', async (t) => {
  const { ws, root } = releasedWithBackup(t, 'drill');
  const dir = path.join(path.dirname(root), `${path.basename(root)}-offsite`);
  const dest = path.join(path.dirname(root), `${path.basename(root)}-drill`);
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dest, { recursive: true, force: true }); });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'copy.json');
  fs.writeFileSync(file, JSON.stringify(X.exportPackage(ws)));
  const r = await require('../core/offsite').drill(ws, { file, to: dest, folder: dir });
  assert.equal(r.passed, true, JSON.stringify(r).slice(0, 400));
  const copy = openWorkspace({ root: dest, actor: 'test' });
  assert.ok(RS.restoredHold(copy));
  settle(copy);
  assert.deepEqual(TD.step(copy).problems.map((p) => p.code), ['RESTORE_HELD']);
  assert.equal(RS.restoredHold(ws), null, 'the workspace it came from is not touched');
});

test('a clean restore into a new folder is held', (t) => {
  const { ws, root } = releasedWithBackup(t, 'clean');
  const b = X.createBackup(ws, { reason: 'manual' });
  const dest = path.join(path.dirname(root), `${path.basename(root)}-clean`);
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }));
  X.restoreBackup(ws, b.name, { to: dest });
  assert.ok(RS.restoredHold(openWorkspace({ root: dest, actor: 'test' })));
});

for (const mode of ['overlay', 'pointInTime']) {
  test(`a restore by ${mode} over this workspace leaves a hold, and a backup's released marker never replaces it`, (t) => {
    const { ws, pid, rid, intent } = releasedWithBackup(t, `m${mode}`);
    const b = X.createBackup(ws, { reason: 'manual' });
    assert.ok(fs.existsSync(ws.abs(`backups/snapshots/${b.name}/files/${MARK}`)), 'the backup holds a released marker');
    // A grant after the backup, then the restore.
    T.decide(ws, pid, { receipt_id: rid, action: 'approve', request_id: `req_hold_${mode}_a` });
    assert.ok(PT.intents(ws).length >= 1);
    const r = X.restoreBackup(ws, b.name, { [mode]: true, confirm: true });
    assert.notEqual(r.status, 'preview');
    assert.ok(RS.restoredHold(ws), 'held after the restore');
    assert.equal(JSON.parse(marker(ws)).from.name, b.name);
    settle(ws);
    // An overlay leaves later files in place: a venue file newer than the backup is
    // the book's own refusal, and the hold is under it either way.
    let got;
    try { got = TD.step(ws).problems.map((p) => p.code); } catch (e) { got = [e.code]; }
    assert.deepEqual(got, [mode === 'overlay' ? 'INTEGRITY' : 'RESTORE_HELD']);
    assert.ok(intent);
  });

  test(`a restore by ${mode} that dies part way leaves a hold`, (t) => {
    const { ws } = releasedWithBackup(t, `${mode}die`);
    const b = X.createBackup(ws, { reason: 'manual' });
    fs.appendFileSync(ws.abs('config/settings.json'), ' ');
    const inBackup = path.join('snapshots', b.name, 'files');
    const realRead = fs.readFileSync;
    let died = false;
    stub(t, fs, 'readFileSync', () => function read(p, ...a) {
      const s = String(p);
      if (!died && s.includes(inBackup) && s.endsWith('settings.json')) {
        const m = JSON.parse(realRead(ws.abs(MARK), 'utf8'));
        if (m.research_held === true) { died = true; throw new Error('died part way'); }
      }
      return realRead.call(fs, p, ...a);
    });
    assert.throws(() => X.restoreBackup(ws, b.name, { [mode]: true, confirm: true }), /died part way/);
    fs.readFileSync = realRead;
    assert.equal(died, true);
    assert.ok(RS.restoredHold(ws));
  });
}

test('a preview of a point-in-time restore changes nothing and leaves no hold', (t) => {
  const { ws } = releasedWithBackup(t, 'preview');
  const b = X.createBackup(ws, { reason: 'manual' });
  const r = X.restoreBackup(ws, b.name, { pointInTime: true });
  assert.equal(r.status, 'preview');
  assert.equal(RS.restoredHold(ws), null);
});

test('EXCLUDED a disk put back with no marker cannot be told from this one: the order goes, and the external refusal is what stops it', (t) => {
  const { ws, intent } = preCutoffGrant(t, 'snapshot');
  const real = process.env[VAR];
  // The refusal off the disk, set before the restore: a snapshot cannot undo it.
  process.env[VAR] = 'restore-hold';
  assert.throws(() => TD.step(ws), code('INTEGRITY'));
  assert.throws(() => TD.view(ws), code('INTEGRITY'));
  assert.equal(has(ws, intent), false);
  // The marker goes down while the anchor still refuses, and only then the hash goes back.
  assert.equal(RS.holdRestoredCopy(ws, { from: 'fictional disk restore' }).status, 'saved');
  process.env[VAR] = real;
  assert.equal(TD.view(ws).book_identity.anchor, 'established');
  assert.equal(TD.view(ws).restore_hold.held, true);
  TD.step(ws);
  assert.equal(has(ws, intent), false);
  assert.equal(TD.rulingsNeeded(ws)[0].opening_intent, intent);
  // A release cannot be made under the refusal.
  process.env[VAR] = 'restore-hold';
  assert.throws(() => RS.releaseRestoredCopy(ws), code('INTEGRITY'));
  assert.ok(RS.restoredHold(ws));
  // The limit, as it is: same first line, no marker, no refusal. It goes. Nothing detects this.
  process.env[VAR] = real;
  fs.rmSync(ws.abs(MARK));
  TD.step(ws);
  assert.equal(has(ws, intent), true, 'if this ever fails, automatic detection exists: say so in PAPER_BOOK_RESTORE.md');
});

// --- Requirement 8: the pause in stops

test('a stop in the gap is not settled while held; after the release the hour applies and it is', (t) => {
  const { ws, d, next } = liveOrder(t, { fill: true, tag: 'stop' });
  const at = iso(next + H + 60000);
  const crash = bar(next, { open: '0.84', high: '0.84', low: '0.60', close: '0.65' });
  hold(ws);
  const rows = TD.applyHours(ws, [crash], { now: at });
  assert.deepEqual(rows.map((r) => r.code), ['RESTORE_HELD']);
  const held = PT.results(ws, { now: at });
  assert.equal(held.open_positions.length, 1, 'the stop was crossed and the position still reads open: this is the pause');
  assert.equal(held.closed_positions.length, 0);
  assert.equal(RS.releaseRestoredCopy(ws, { accept: [d.decision_id] }).status, 'saved');
  const after = TD.applyHours(ws, [crash], { now: at });
  assert.notEqual(after[0].status, 'refused', JSON.stringify(after));
  const res = PT.results(ws, { now: at });
  assert.equal(res.open_positions.length, 0);
  assert.equal(res.closed_positions.length, 1, 'settled at the stop, from the hour it crossed');
});

// --- The command lines

test('the command lines: hold, status, refused release, a release naming the work', (t) => {
  const { ws, d } = liveOrder(t, { tag: 'cli' });
  const cli = (...a) => { const r = spawnSync(process.execPath, [path.join(CODE, 'cli.js'), ...a, '--workspace', ws.root], { encoding: 'utf8', env: process.env, timeout: 60000 }); return { code: r.status, out: `${r.stdout}${r.stderr}` }; };
  assert.notEqual(cli('restored-copy', 'hold').code, 0, 'words first');
  assert.notEqual(cli('restored-copy', 'hold', '--confirm').code, 0, 'says what was restored');
  assert.notEqual(cli('restored-copy', 'hold', '--from', 'fictional disk').code, 0, 'needs --confirm');
  assert.equal(RS.restoredHold(ws), null);
  assert.equal(cli('restored-copy', 'hold', '--confirm', '--from', 'fictional disk').code, 0);
  assert.ok(RS.restoredHold(ws));
  const status = cli('restored-copy', 'status');
  assert.equal(status.code, 0);
  assert.ok(status.out.includes(d.decision_id));
  assert.match(status.out, /rulings_needed/);
  assert.notEqual(cli('restored-copy', 'release').code, 0, 'needs --confirm');
  const unruled = cli('restored-copy', 'release', '--confirm');
  assert.notEqual(unruled.code, 0);
  assert.match(unruled.out, /Rule on each/);
  assert.ok(RS.restoredHold(ws));
  assert.equal(cli('restored-copy', 'release', '--confirm', '--accept', d.decision_id).code, 0);
  assert.equal(RS.restoredHold(ws), null);
});

test('a close is listed and, accepted, goes as a new sell under its own decision', (t) => {
  const { ws, pid, rid, d, next, intent } = liveOrder(t, { fill: true, tag: 'close' });
  // The buy ends on its own validity, with the position open.
  const at = iso(next + 3 * H + 60000);
  TD.applyHours(ws, [bar(next), bar(next + H), bar(next + 2 * H)], { now: at });
  assert.ok(!['ACKED', 'PARTIAL'].includes(PT.intents(ws).find((i) => i.intent_id === intent).state), 'the buy has ended, so the next thing is a sell');
  hold(ws);
  T.decide(ws, pid, { receipt_id: rid, action: 'undo', request_id: 'req_hold_close_undo' });
  assert.deepEqual(TD.rulingsNeeded(ws, { now: at }).map((x) => [x.kind, x.decision_id, x.may_accept]), [['close', d.decision_id, true]]);
  const sell = TD.intentIdOf(d, 'close-1');
  assert.equal(has(ws, sell), false);
  TD.step(ws, { now: at });
  assert.equal(has(ws, sell), false, 'not while held');
  assert.equal(RS.releaseRestoredCopy(ws, { accept: [d.decision_id] }).status, 'saved');
  TD.step(ws, { now: at });
  assert.equal(has(ws, sell), false, 'after the release, not the number the lost timeline may have used');
  const own = TD.intentIdOf(d, TD.closePurpose(1, TD.releaseEpochOf(marker(ws))));
  assert.equal(has(ws, own), true, 'its own ID, from this release');
  hold(ws);
  assert.equal(TD.rulingsNeeded(ws, { now: at }).some((x) => x.kind === 'unmatched_order'), false, 'its own sell is not unmatched');
});

// --- What the deliberate breaks asked for

// The marker changes, not held: a read taken before it must not write. A fresh fence
// at the write would see nothing wrong.
const released = (ws, n = 1) => { fs.mkdirSync(path.dirname(ws.abs(MARK)), { recursive: true }); fs.writeFileSync(ws.abs(MARK), JSON.stringify({ schema_version: 'cr.restored-copy.v1', research_held: false, released_at: `2026-11-05T00:00:0${n}.000Z` })); };

test('a marker that changed after the read refuses the fund, the order, the cancel and the hour', (t) => {
  // The order, with the marker read before the book is.
  const o = preCutoffGrant(t, 'staleorder');
  const sends = [];
  stub(t, PT, 'submitIntent', (real) => (...x) => { sends.push('submit'); return real(...x); });
  let orderOnce = false;
  const firstResults = PT.results;
  PT.results = (...x) => { if (!orderOnce) { orderOnce = true; released(o.ws); } return firstResults(...x); };
  const orderStep = TD.step(o.ws);
  PT.results = firstResults;
  assert.equal(orderOnce, true);
  assert.deepEqual(sends, [], 'no order from the stale read');
  assert.ok(orderStep.problems.some((p) => p.code === 'RESTORE_HELD'), JSON.stringify(orderStep.problems));
  // The fund.
  clean(t);
  const a = deskWith(t);
  settle(a.ws);
  const called = [];
  stub(t, PT, 'fund', (real) => (...x) => { called.push('fund'); return real(...x); });
  let fundOnce = false;
  const realResults = PT.results;
  PT.results = (...x) => { if (!fundOnce) { fundOnce = true; released(a.ws); } return realResults(...x); };
  const fundStep = TD.step(a.ws);
  PT.results = realResults;
  assert.equal(fundOnce, true);
  assert.deepEqual(called, [], 'nothing funded from the stale read');
  assert.ok(fundStep.problems.some((p) => p.code === 'RESTORE_HELD'), JSON.stringify(fundStep.problems));
  // The cancel.
  const b = liveOrder(t, { tag: 'stalecancel' });
  hold(b.ws);
  T.decide(b.ws, b.pid, { receipt_id: b.rid, action: 'undo', request_id: 'req_hold_stalecancel_u' });
  released(b.ws, 1);
  const cancels = [];
  stub(t, PT, 'cancelOrder', (real) => (...x) => { cancels.push('cancel'); return real(...x); });
  let cancelOnce = false;
  PT.results = (...x) => { if (!cancelOnce) { cancelOnce = true; released(b.ws, 2); } return realResults(...x); };
  const cancelStep = TD.step(b.ws);
  PT.results = realResults;
  assert.equal(cancelOnce, true);
  assert.deepEqual(cancels, [], 'nothing cancelled from the stale read');
  assert.ok(cancelStep.problems.some((p) => p.code === 'RESTORE_HELD'), JSON.stringify(cancelStep.problems));
  // The hour.
  const c = liveOrder(t, { fill: true, tag: 'stalehour' });
  const journal = fs.readFileSync(c.ws.abs(PT.JOURNAL));
  let hourOnce = false;
  const realIntents = PT.intents;
  PT.intents = (...x) => { const v = realIntents(...x); if (!hourOnce) { hourOnce = true; released(c.ws); } return v; };
  const rows = TD.applyHours(c.ws, [bar(c.next)], { now: iso(c.next + H + 60000) });
  PT.intents = realIntents;
  assert.equal(hourOnce, true);
  assert.ok(rows.some((x) => x.code === 'RESTORE_HELD'), JSON.stringify(rows));
  assert.ok(fs.readFileSync(c.ws.abs(PT.JOURNAL)).equals(journal), 'no hour from the stale read');
});

test('a marker that could not be read when the step began refuses its writes', (t) => {
  const { ws, intent } = preCutoffGrant(t, 'fenceread');
  const real = fs.readFileSync;
  let failed = false;
  stub(t, fs, 'readFileSync', () => function read(p, ...a) {
    if (!failed && String(p) === ws.abs(MARK)) { failed = true; throw Object.assign(new Error('no access'), { code: 'EACCES' }); }
    return real.call(fs, p, ...a);
  });
  const r = TD.step(ws);
  fs.readFileSync = real;
  assert.equal(failed, true);
  assert.equal(has(ws, intent), false, 'no order from a read that could not see the marker');
  assert.ok(r.problems.some((p) => p.code === 'RESTORE_HELD'), JSON.stringify(r.problems));
});

test('an open position with no decision is named, even when its order has ended', (t) => {
  const { ws, pid, next, intent } = liveOrder(t, { fill: true, tag: 'orphanpos' });
  const at = iso(next + 3 * H + 60000);
  TD.applyHours(ws, [bar(next), bar(next + H), bar(next + 2 * H)], { now: at });
  assert.ok(!['ACKED', 'PARTIAL'].includes(PT.intents(ws).find((i) => i.intent_id === intent).state), 'its order has ended');
  for (const r of find(ws, 'decisions.jsonl')) if (r.includes(pid)) fs.writeFileSync(ws.abs(r), '');
  hold(ws);
  assert.deepEqual(TD.rulingsNeeded(ws, { now: at }).map((x) => [x.id, x.kind, x.may_accept]), [[intent, 'unmatched_order', false]]);
});

test('a project that does not read and holds a grant blocks the release, and a history that does not read is not none', (t) => {
  const { ws, pid } = preCutoffGrant(t, 'broken');
  hold(ws);
  fs.writeFileSync(ws.abs(`projects/${pid}/project.json`), '{ not a project');
  assert.deepEqual(TD.rulingsNeeded(ws).map((x) => [x.id, x.kind, x.may_accept]), [[pid, 'broken_project', false]]);
  const before = marker(ws);
  assert.throws(() => RS.releaseRestoredCopy(ws), code('RULING_REQUIRED'));
  assert.throws(() => RS.releaseRestoredCopy(ws, { accept: [pid] }), code('RULING_REQUIRED'));
  assert.equal(marker(ws), before);
  fs.appendFileSync(ws.abs(find(ws, 'decisions.jsonl').find((r) => r.includes(pid))), '{ not a line\n');
  assert.throws(() => TD.rulingsNeeded(ws), (e) => e.code !== 'RULING_REQUIRED', 'unknown, not a list');
});

test('a release under the external refusal refuses: the anchor stops it too', (t) => {
  const { ws } = preCutoffGrant(t, 'extrelease');
  hold(ws);
  const before = marker(ws);
  process.env[VAR] = 'restore-hold';
  assert.throws(() => RS.releaseRestoredCopy(ws), code('INTEGRITY'));
  assert.equal(marker(ws), before);
});

test('a basis that reads unverified refuses the release; one rebuilt from before the basis existed does not', (t) => {
  const a = liveOrder(t, { tag: 'unverified' });
  hold(a.ws);
  const rel = DB.basisRel(a.pid, a.d.decision_id);
  const body = JSON.parse(fs.readFileSync(a.ws.abs(rel), 'utf8'));
  delete body.digest_ledger;
  fs.writeFileSync(a.ws.abs(rel), JSON.stringify(body));
  fs.rmSync(a.ws.abs(DB.digestRel(a.pid)));
  assert.equal(DB.viewOf(a.ws, a.pid, a.d.decision_id).label, 'unverified');
  const before = marker(a.ws);
  assert.throws(() => RS.releaseRestoredCopy(a.ws, { accept: [a.d.decision_id] }), code('RULING_REQUIRED'));
  assert.equal(marker(a.ws), before);
  const b = liveOrder(t, { tag: 'reconstructed' });
  hold(b.ws);
  fs.rmSync(b.ws.abs(DB.basisRel(b.pid, b.d.decision_id)));
  fs.rmSync(b.ws.abs(DB.digestRel(b.pid)));
  assert.equal(DB.viewOf(b.ws, b.pid, b.d.decision_id).label, 'reconstructed');
  assert.equal(RS.releaseRestoredCopy(b.ws, { accept: [b.d.decision_id] }).status, 'saved');
});

test('a marker that changes during the release refuses it', (t) => {
  clean(t);
  const { ws } = deskWith(t);
  hold(ws);
  const ops = require('../core/ops');
  stub(t, ops, 'runOp', (real) => (...a) => { fs.writeFileSync(ws.abs(MARK), JSON.stringify({ research_held: true, from: { kind: 'owner', words: 'a later hold' } })); return real(...a); });
  assert.throws(() => RS.releaseRestoredCopy(ws), code('CONFLICT'));
  assert.equal(RS.restoredHold(ws).from.words, 'a later hold');
});

test('a point-in-time restore never moves, replaces or brings back the marker', (t) => {
  // A backup with no marker, and a marker now: it is not quarantined as a later file.
  const a = preCutoffGrant(t, 'pitlater');
  const ba = X.createBackup(a.ws, { reason: 'manual' });
  hold(a.ws);
  assert.ok(!X.restoreBackup(a.ws, ba.name, { pointInTime: true }).files_to_quarantine.includes(MARK));
  X.restoreBackup(a.ws, ba.name, { pointInTime: true, confirm: true });
  assert.ok(RS.restoredHold(a.ws), 'a marker now, none in the backup');
  // A released marker in the backup, and a different one now.
  const b = releasedWithBackup(t, 'pitchanged');
  const bb = X.createBackup(b.ws, { reason: 'manual' });
  hold(b.ws);
  X.restoreBackup(b.ws, bb.name, { pointInTime: true, confirm: true });
  assert.ok(RS.restoredHold(b.ws), 'the backup does not replace it');
  // A released marker in the backup, and none now.
  const c = releasedWithBackup(t, 'pitgone');
  const bc = X.createBackup(c.ws, { reason: 'manual' });
  fs.rmSync(c.ws.abs(MARK));
  X.restoreBackup(c.ws, bc.name, { pointInTime: true, confirm: true });
  assert.ok(RS.restoredHold(c.ws), 'the backup does not bring it back');
});

test('an overlay of an older unsealed backup, whose whole folders carry a released marker, still leaves a hold', (t) => {
  const { ws } = releasedWithBackup(t, 'unsealed');
  const sealed = X.createBackup(ws, { reason: 'manual' });
  const name = `${sealed.name}-old`;
  fs.cpSync(ws.abs(`backups/snapshots/${sealed.name}/files`), ws.abs(`backups/snapshots/${name}`), { recursive: true });
  assert.ok(fs.existsSync(ws.abs(`backups/snapshots/${name}/${MARK}`)), 'it holds a released marker');
  const r = X.restoreBackup(ws, name, { overlay: true, confirm: true });
  assert.equal(r.mode, 'overlay');
  assert.ok(RS.restoredHold(ws));
});

// --- The hold through a restore that dies. These kill a real process at the point named:
// nothing after it runs, so no final write and no finally can help.

const KILLED_RESTORE = `
const [code, root, name, optsText, at, flag, dest] = process.argv.slice(1);
const fs = require('fs');
const path = require('path');
const opts = JSON.parse(optsText);
const die = () => { fs.writeFileSync(flag, at); process.kill(process.pid, 'SIGKILL'); };
const inside = (p) => String(p).split(path.sep).join('/');
const realCp = fs.cpSync;
fs.cpSync = (from, to, o) => {
  const filter = at === 'legacy_before_journal' ? (src, d) => { if (inside(src).includes('/paper/trader/') && fs.statSync(src).isFile()) die(); return o.filter(src, d); } : o.filter;
  const r = realCp(from, to, { ...o, filter });
  if (at === 'legacy_after_config' && path.basename(String(to)) === 'config') die();
  if (at === 'legacy_after_journal' && path.basename(String(to)) === 'paper') die();
  return r;
};
const realOpen = fs.openSync;
fs.openSync = (p, ...a) => {
  const s = inside(p);
  const writing = a[0] === 'w';
  if (writing && at === 'write_of_decisions' && s.endsWith('/decisions.jsonl') && !s.includes('/backups/')) die();
  if (writing && at === 'write_of_journal' && dest && s.startsWith(inside(dest)) && s.includes('/paper/trader/')) die();
  return realOpen(p, ...a);
};
const W = require(path.join(code, 'core', 'workspace.js'));
const realWs = W.openWorkspace;
if (at === 'after_every_file') W.openWorkspace = (o) => { if (dest && path.resolve(o.root) === path.resolve(dest)) die(); return realWs(o); };
const X = require(path.join(code, 'core', 'exporter.js'));
const ws = realWs({ root, actor: 'test' });
if (name === 'package') X.restorePackage(X.exportPackage(ws), dest);
else X.restoreBackup(ws, name, dest ? { to: dest } : opts);
`;
function killedRestore(t, ws, name, opts, at, dest = '') {
  const flag = path.join(path.dirname(ws.root), `${path.basename(ws.root)}-${at}-flag`);
  t.after(() => fs.rmSync(flag, { force: true }));
  const r = spawnSync(process.execPath, ['-e', KILLED_RESTORE, CODE, ws.root, name, JSON.stringify(opts), at, flag, dest], { encoding: 'utf8', env: process.env, timeout: 120000 });
  assert.ok(fs.existsSync(flag), `the process died where it was meant to (${at}): exit ${r.status} ${String(r.stderr).slice(0, 300)}`);
  assert.notEqual(r.status, 0);
}
// Held, research and all: no adapter write reaches the journal.
function holdsAfter(ws, journalBefore = null) {
  assert.ok(RS.restoredHold(ws), 'UNSAFE: the restore died and the copy is not on hold');
  assert.equal(RS.restoredHold(ws).research_held, true);
  const file = ws.abs(PT.JOURNAL);
  const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
  if (journalBefore) assert.ok(before.equals(journalBefore), 'the journal is as it was before the restore');
  settle(ws);
  const rows = TD.applyHours(ws, [bar(topHour())], { now: iso(topHour() + H + 60000) });
  assert.deepEqual(rows.map((x) => [x.status, x.code]), [['refused', 'RESTORE_HELD']], 'the hour');
  let stepCodes;
  try { stepCodes = TD.step(ws).problems.map((p) => p.code); } catch (err) { stepCodes = [err.code]; }
  assert.ok(stepCodes.includes('RESTORE_HELD') || stepCodes.includes('INTEGRITY'), `the step: ${stepCodes}`);
  const after = fs.existsSync(file) ? fs.readFileSync(file) : null;
  assert.ok(before === null ? after === null : before.equals(after), 'no adapter write reached the journal');
}
function legacyOf(ws, sealedName) {
  const name = `${sealedName}-old`;
  fs.cpSync(ws.abs(`backups/snapshots/${sealedName}/files`), ws.abs(`backups/snapshots/${name}`), { recursive: true });
  assert.equal(JSON.parse(fs.readFileSync(ws.abs(`backups/snapshots/${name}/${MARK}`), 'utf8')).research_held, false, 'the legacy backup says released');
  assert.equal(X.verifyBackup(ws, name).legacy, true, 'and it is an older unsealed one');
  return name;
}
// A released copy, its backup, and a later write, so that what is restored differs.
function backedThenChanged(t, tag) {
  const s = releasedWithBackup(t, tag);
  const b = X.createBackup(s.ws, { reason: 'manual' });
  T.decide(s.ws, s.pid, { receipt_id: s.rid, action: 'approve', request_id: `req_kill_${tag}` });
  assert.ok(fs.statSync(s.ws.abs(PT.JOURNAL)).size > 0);
  return { ...s, backup: b.name };
}

test('REGRESSION a legacy overlay killed after it copied config: still held, by the hold it wrote first, and the journal is untouched', (t) => {
  const a = backedThenChanged(t, 'lgcfg');
  const name = legacyOf(a.ws, a.backup);
  const held = fs.readFileSync(a.ws.abs(PT.JOURNAL));
  killedRestore(t, a.ws, name, { overlay: true, confirm: true }, 'legacy_after_config');
  holdsAfter(a.ws, held);
  assert.equal(JSON.parse(marker(a.ws)).from.mode, 'overlay', 'the destination\'s hold, not the backup\'s marker');
  assert.equal(JSON.parse(marker(a.ws)).released_at, undefined);
});

test('REGRESSION a legacy overlay killed mid-copy, before the journal: still held, and the journal is untouched', (t) => {
  const a = backedThenChanged(t, 'lgmid');
  const name = legacyOf(a.ws, a.backup);
  const held = fs.readFileSync(a.ws.abs(PT.JOURNAL));
  killedRestore(t, a.ws, name, { overlay: true, confirm: true }, 'legacy_before_journal');
  holdsAfter(a.ws, held);
});

test('REGRESSION a legacy overlay killed mid-copy, after the journal: still held, and nothing writes over what it copied', (t) => {
  const a = backedThenChanged(t, 'lgpaper');
  const name = legacyOf(a.ws, a.backup);
  killedRestore(t, a.ws, name, { overlay: true, confirm: true }, 'legacy_after_journal');
  holdsAfter(a.ws);
});

test('a legacy overlay holds at every step, not only at the end, and on success leaves the destination\'s hold with the records restored', (t) => {
  const a = backedThenChanged(t, 'lgok');
  const name = legacyOf(a.ws, a.backup);
  const backupJournal = fs.readFileSync(a.ws.abs(`backups/snapshots/${name}/${PT.JOURNAL}`));
  const seen = [];
  stub(t, fs, 'cpSync', (real) => (from, to, o) => { const r = real(from, to, o); seen.push([path.basename(String(to)), JSON.parse(marker(a.ws)).research_held]); return r; });
  const r = X.restoreBackup(a.ws, name, { overlay: true, confirm: true });
  assert.equal(r.mode, 'overlay');
  assert.ok(seen.length >= 3 && seen.some(([n]) => n === 'config'), JSON.stringify(seen));
  for (const [n, h] of seen) assert.equal(h, true, `held after copying ${n}`);
  const m = JSON.parse(marker(a.ws));
  assert.equal(m.research_held, true);
  assert.equal(m.from.mode, 'overlay');
  assert.equal(m.released_at, undefined, 'nothing of the backup\'s marker');
  assert.ok(fs.readFileSync(a.ws.abs(PT.JOURNAL)).equals(backupJournal), 'the records came back');
});

test('the supplied audit case: the copy of config fails in process after it wrote, and the hold and the journal stand', (t) => {
  const { ws } = releasedWithBackup(t, 'lgthrow');
  const sealed = X.createBackup(ws, { reason: 'manual' });
  const name = legacyOf(ws, sealed.name);
  let interrupted = false;
  stub(t, fs, 'cpSync', (real) => (src, dest, options) => {
    const result = real(src, dest, options);
    if (path.resolve(dest) === path.resolve(ws.abs('config'))) { interrupted = true; throw new Error('CRASH_AFTER_CONFIG_COPY'); }
    return result;
  });
  assert.throws(() => X.restoreBackup(ws, name, { overlay: true, confirm: true }), /CRASH_AFTER_CONFIG_COPY/);
  assert.equal(interrupted, true);
  holdsAfter(ws);
});

// Node 20 on Windows hands a copy's filter its children as \\\\?\\C:\\..., and Node 24 does not.
// The form is forced here so the pinned Node runs the same case.
test('the marker is kept out of an older backup copy under the long Windows path form too', (t) => {
  const { ws } = releasedWithBackup(t, 'lgform');
  const sealed = X.createBackup(ws, { reason: 'manual' });
  const name = legacyOf(ws, sealed.name);
  const asked = [];
  stub(t, fs, 'cpSync', (real) => (src, dest, options) => real(src, dest, { ...options, filter: (a, b) => { asked.push(path.basename(a)); return options.filter(path.toNamespacedPath(a), b); } }));
  X.restoreBackup(ws, name, { overlay: true, confirm: true });
  assert.ok(asked.includes('restored-copy.json'), 'the filter was asked about the marker');
  assert.ok(RS.restoredHold(ws), 'UNSAFE: the backup released marker replaced the hold');
  assert.equal(JSON.parse(marker(ws)).from.mode, 'overlay', 'and the hold is the one this restore wrote');
  holdsAfter(ws);
});

test('a path the older backup copy cannot place inside its backup stops the copy, and the hold stands', (t) => {
  const { ws } = releasedWithBackup(t, 'lgoutside');
  const sealed = X.createBackup(ws, { reason: 'manual' });
  const name = legacyOf(ws, sealed.name);
  stub(t, fs, 'cpSync', () => (src, dest, options) => { options.filter(ws.abs('workspace.json'), dest); });
  assert.throws(() => X.restoreBackup(ws, name, { overlay: true, confirm: true }), (e) => e.code === 'INTEGRITY' && /not inside/.test(e.message));
  assert.equal(JSON.parse(marker(ws)).from.mode, 'overlay');
  holdsAfter(ws);
});

for (const [mode, opts] of [['overlay', { overlay: true, confirm: true }], ['point-in-time', { pointInTime: true, confirm: true }]]) {
  test(`a sealed ${mode} restore killed mid-copy: still held, by the hold it wrote first`, (t) => {
    const a = backedThenChanged(t, `seal${mode.slice(0, 3)}`);
    assert.ok(fs.existsSync(a.ws.abs(`backups/snapshots/${a.backup}/files/${MARK}`)), 'its backup holds a released marker');
    const before = fs.readFileSync(a.ws.abs(PT.JOURNAL));
    killedRestore(t, a.ws, a.backup, opts, 'write_of_decisions');
    holdsAfter(a.ws, before);
    assert.equal(JSON.parse(marker(a.ws)).released_at, undefined);
  });
}

for (const at of ['write_of_journal', 'after_every_file']) {
  test(`REGRESSION a clean restore killed (${at}): the new folder is held, and never by the backup's marker`, (t) => {
    const a = backedThenChanged(t, `cl${at.slice(0, 5)}`);
    const dest = path.join(path.dirname(a.root), `${path.basename(a.root)}-clean-kill`);
    t.after(() => fs.rmSync(dest, { recursive: true, force: true }));
    killedRestore(t, a.ws, a.backup, {}, at, dest);
    const copy = openWorkspace({ root: dest, actor: 'test' });
    holdsAfter(copy);
    assert.equal(JSON.parse(fs.readFileSync(copy.abs(MARK), 'utf8')).released_at, undefined);
  });

  test(`REGRESSION a sealed package restored and killed (${at}): the new folder is held, and never by the package's marker`, (t) => {
    const a = backedThenChanged(t, `pk${at.slice(0, 5)}`);
    const dest = path.join(path.dirname(a.root), `${path.basename(a.root)}-pkg-kill`);
    t.after(() => fs.rmSync(dest, { recursive: true, force: true }));
    killedRestore(t, a.ws, 'package', {}, at, dest);
    const copy = openWorkspace({ root: dest, actor: 'test' });
    holdsAfter(copy);
    assert.equal(JSON.parse(fs.readFileSync(copy.abs(MARK), 'utf8')).released_at, undefined);
  });
}

test('a clean restore that completes: held by the restore, what it reports still matches, and its report is clean', (t) => {
  const { ws, root } = releasedWithBackup(t, 'clok');
  const b = X.createBackup(ws, { reason: 'manual' });
  const dest = path.join(path.dirname(root), `${path.basename(root)}-clean-ok`);
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }));
  const r = X.restoreBackup(ws, b.name, { to: dest });
  assert.deepEqual(r.mismatched_after_copy, [], JSON.stringify(r).slice(0, 400));
  assert.equal(r.status, 'restored_and_verified', JSON.stringify(r.reconciliation));
  const m = JSON.parse(fs.readFileSync(path.join(dest, MARK), 'utf8'));
  assert.equal(m.research_held, true);
  assert.equal(m.from.name, b.name);
  const p = path.join(path.dirname(root), `${path.basename(root)}-pkg-ok`);
  t.after(() => fs.rmSync(p, { recursive: true, force: true }));
  const q = X.restorePackage(X.exportPackage(ws), p);
  assert.equal(q.status, 'restored_and_verified', JSON.stringify(q.reconciliation));
  assert.equal(q.restored_copy.research_held, true);
  assert.deepEqual(q.mismatched_after_write, []);
});

test('a restore that fails and cannot finish cleaning up leaves its hold on what remains', (t) => {
  const { ws, root } = releasedWithBackup(t, 'clclean');
  const pkg = X.exportPackage(ws);
  const dest = path.join(path.dirname(root), `${path.basename(root)}-clean-fail`);
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }));
  // The last file's write fails, and removing the book's folder fails too.
  const last = path.join(dest, ...pkg.files[pkg.files.length - 1].path.split('/'));
  const realOpen = fs.openSync;
  const realRm = fs.rmSync;
  fs.openSync = (p, ...a) => { if (path.resolve(String(p)) === last) throw new Error('disk full (FICTIONAL)'); return realOpen(p, ...a); };
  fs.rmSync = (p, ...a) => { if (path.resolve(String(p)) === path.join(dest, 'paper')) throw new Error('in use (FICTIONAL)'); return realRm(p, ...a); };
  try { assert.throws(() => X.restorePackage(pkg, dest), /disk full/); } finally { fs.openSync = realOpen; fs.rmSync = realRm; }
  assert.ok(fs.existsSync(path.join(dest, 'paper')), 'the book is still there');
  assert.ok(RS.restoredHold(openWorkspace({ root: dest, actor: 'test', recover: false })), 'UNSAFE: what remains of a failed restore is not on hold');
});

test('a marker under another spelling in a backup never replaces the hold: sealed overlay, point in time, legacy', (t) => {
  for (const mode of ['overlay', 'pointInTime', 'legacy']) {
    const a = releasedWithBackup(t, `spell${mode.slice(0, 3)}`);
    const dir = path.dirname(a.ws.abs(MARK));
    const released = fs.readFileSync(a.ws.abs(MARK));
    fs.rmSync(a.ws.abs(MARK));
    const other = path.join(dir, 'RESTORED-COPY.JSON');
    fs.writeFileSync(other, released);
    const b = X.createBackup(a.ws, { reason: 'manual' });
    fs.rmSync(other);
    fs.writeFileSync(a.ws.abs(MARK), released);
    const name = mode === 'legacy' ? (() => { const n = `${b.name}-old`; fs.cpSync(a.ws.abs(`backups/snapshots/${b.name}/files`), a.ws.abs(`backups/snapshots/${n}`), { recursive: true }); return n; })() : b.name;
    X.restoreBackup(a.ws, name, mode === 'legacy' ? { overlay: true, confirm: true } : { [mode]: true, confirm: true });
    assert.ok(RS.restoredHold(a.ws), `${mode}: held`);
    assert.equal(JSON.parse(marker(a.ws)).released_at, undefined, `${mode}: not the backup's marker`);
  }
});

test('a release sealed but not applied when a restore takes its lock is finished first, so it cannot land on the new hold', (t) => {
  const a = backedThenChanged(t, 'stale');
  let sealed = false;
  const realOpen = fs.openSync;
  // In the pre-restore backup's last write, after it recovered, as another process could.
  fs.openSync = (p, ...x) => {
    if (!sealed && path.basename(String(p)) === 'BACKUP-INFO.json') {
      sealed = true;
      const op = new StagedOp(a.ws, 'update_settings', 'a release that dies after its seal');
      op.write(MARK, JSON.stringify({ schema_version: 'cr.restored-copy.v1', research_held: false, released_at: '2026-11-05T00:00:00.000Z' }));
      op.seal();
    }
    return realOpen(p, ...x);
  };
  try { X.restoreBackup(a.ws, a.backup, { pointInTime: true, confirm: true }); } finally { fs.openSync = realOpen; }
  assert.equal(sealed, true, 'the competing release was sealed');
  recover(a.ws);
  assert.ok(RS.restoredHold(a.ws), 'UNSAFE: a release from before the restore landed on its hold');
  assert.equal(JSON.parse(marker(a.ws)).from.mode, 'point_in_time');
});

// --- The PM Cohort book: a decision opens nothing in either book while held

const PM = require('../core/paper');
const notes = require('../core/notes');
const pmBytes = (ws) => { try { return fs.readFileSync(ws.abs(PM.REL)); } catch (_) { return null; } };
const pmOpens = (ws) => PM.readRecords(ws).filter((l) => l.event === 'open');
const same = (a, b) => (a === null ? b === null : b !== null && a.equals(b));
const journalOf = (ws) => fs.readFileSync(ws.abs(PT.JOURNAL));

for (const action of ['approve', 'halve']) {
  test(`REGRESSION a ${action} recorded during the hold adds nothing to either book, by any path`, (t) => {
    clean(t);
    const { ws, pid, rid } = deskWith(t);
    ready(ws);
    hold(ws);
    const pm = pmBytes(ws);
    const journal = journalOf(ws);
    const r = T.decide(ws, pid, { receipt_id: rid, action, request_id: `req_pm_${action}` }).result;
    assert.ok(r.decision, 'the decision is on record');
    assert.equal(r.paper.status, 'held', 'UNSAFE: the decision opened a PM Cohort position in a restored copy on hold');
    assert.equal(r.paper.code, 'RESTORE_HELD');
    assert.ok(r.trader.problems.some((p) => p.code === 'RESTORE_HELD'));
    // Asked again: the same request, the repair and its preview.
    T.decide(ws, pid, { receipt_id: rid, action, request_id: `req_pm_${action}` });
    const preview = T.reconcileDesk(ws, { dryRun: true });
    assert.deepEqual(preview.completed.filter((x) => x.step === 'paper').map((x) => x.status), ['held']);
    assert.match(preview.words, /1 held by the restored copy/);
    const repair = T.reconcileDesk(ws);
    assert.deepEqual(repair.completed.filter((x) => x.step === 'paper').map((x) => x.status), ['held']);
    assert.equal(repair.counts.held, 1);
    assert.ok(same(pmBytes(ws), pm), 'the PM Cohort book is unchanged');
    assert.ok(journalOf(ws).equals(journal), 'the Paper Book is unchanged');
    assert.deepEqual(PM.book(ws).positions || [], []);
    assert.equal(PT.results(ws, { now: iso(Date.now()) }).open_positions.length, 0);
    assert.equal(has(ws, TD.intentIdOf(r.decision, 'open')), false);
  });
}

test('a marker that does not read holds the PM Cohort book too', (t) => {
  clean(t);
  const { ws, pid, rid } = deskWith(t);
  ready(ws);
  fs.mkdirSync(path.dirname(ws.abs(MARK)), { recursive: true });
  fs.writeFileSync(ws.abs(MARK), '[]');
  const r = T.decide(ws, pid, { receipt_id: rid, action: 'approve', request_id: 'req_pm_unread' }).result;
  assert.equal(r.paper.status, 'held');
  assert.deepEqual(pmOpens(ws), []);
});

test('a hold that lands after the decision and before its PM Cohort write refuses the write', (t) => {
  clean(t);
  const { ws, pid, rid } = deskWith(t);
  ready(ws);
  let once = false;
  stub(t, notes, 'addJournal', (real) => (...x) => { if (!once) { once = true; hold(ws); } return real(...x); });
  const r = T.decide(ws, pid, { receipt_id: rid, action: 'approve', request_id: 'req_pm_race_hold' }).result;
  assert.equal(once, true, 'the competing hold ran');
  assert.equal(r.paper.status, 'held');
  assert.deepEqual(pmOpens(ws), []);
});

test('a release that lands after a decision began does not carry its PM Cohort write across', (t) => {
  clean(t);
  const { ws, pid, rid } = deskWith(t);
  ready(ws);
  hold(ws);
  let once = false;
  stub(t, notes, 'addJournal', (real) => (...x) => { if (!once) { once = true; released(ws); } return real(...x); });
  const r = T.decide(ws, pid, { receipt_id: rid, action: 'approve', request_id: 'req_pm_race_release' }).result;
  assert.equal(once, true, 'the competing release ran');
  assert.equal(RS.restoredHold(ws), null, 'no longer held at the write');
  assert.equal(r.paper.status, 'held', 'a fresh look at the marker alone would have opened it');
  assert.match(r.paper.words, /changed after this decision began/);
  assert.deepEqual(pmOpens(ws), []);
});

test('a hold sealed but not yet in place when a PM Cohort write comes: recovery completes it, then the write refuses', (t) => {
  clean(t);
  const { ws, pid, rid } = deskWith(t);
  ready(ws);
  stub(t, notes, 'addJournal', (real) => (...x) => {
    if (!fs.existsSync(ws.abs(MARK)) && !ws._sealed) {
      ws._sealed = true;
      const op = new StagedOp(ws, 'update_settings', 'a hold that dies after its seal');
      op.write(MARK, JSON.stringify({ research_held: true, restored_at: new Date().toISOString() }));
      op.seal();
    }
    return real(...x);
  });
  const r = T.decide(ws, pid, { receipt_id: rid, action: 'approve', request_id: 'req_pm_sealed' }).result;
  assert.equal(ws._sealed, true);
  assert.ok(RS.restoredHold(ws), 'recovery put it in place');
  assert.equal(r.paper.status, 'held');
  assert.deepEqual(pmOpens(ws), []);
});

test('Undo while held takes a position off the PM Cohort book and adds none; a released copy then opens only from a new decision', (t) => {
  clean(t);
  const { ws, pid, rid } = deskWith(t);
  ready(ws);
  const before = T.decide(ws, pid, { receipt_id: rid, action: 'approve', request_id: 'req_pm_before' }).result.decision;
  assert.equal(pmOpens(ws).length, 1, 'opened before the hold');
  hold(ws);
  T.decide(ws, pid, { receipt_id: rid, action: 'undo', request_id: 'req_pm_undo1' });
  assert.deepEqual(PM.readRecords(ws).filter((l) => l.event === 'void').map((l) => l.decision_id), [before.decision_id], 'voided while held');
  const during = T.decide(ws, pid, { receipt_id: rid, action: 'approve', request_id: 'req_pm_during' }).result;
  assert.equal(during.paper.status, 'held');
  assert.deepEqual(TD.rulingsNeeded(ws).filter((x) => x.decision_id === during.decision.decision_id).map((x) => [x.kind, x.may_accept]), [['opening', false]], 'on the list, and it cannot be accepted');
  const undo = T.decide(ws, pid, { receipt_id: rid, action: 'undo', request_id: 'req_pm_undo2' }).result;
  assert.equal(undo.paper.status, 'unchanged', 'nothing to void: it never opened');
  assert.equal(pmOpens(ws).length, 1);
  assert.equal(RS.releaseRestoredCopy(ws, { accept: TD.rulingsNeeded(ws).map((x) => x.id) }).status, 'saved');
  const repair = T.reconcileDesk(ws);
  assert.deepEqual(repair.completed.filter((x) => x.step === 'paper'), [], 'the repair opens nothing for a decision taken back');
  assert.equal(pmOpens(ws).length, 1);
  assert.equal(PT.results(ws, { now: iso(Date.now()) }).open_positions.length, 0);
  const fresh = T.decide(ws, pid, { receipt_id: rid, action: 'approve', request_id: 'req_pm_after' }).result;
  assert.equal(fresh.paper.status, 'saved', 'the control: released, a new decision opens');
  assert.equal(pmOpens(ws).length, 2);
  assert.ok(has(ws, TD.intentIdOf(fresh.decision, 'open')), 'in both books');
});

test('a grant whose PM Cohort position is not on record is listed, so the repair cannot open it unreviewed after the release', (t) => {
  const a = sellable(t, 'pmmissing');
  // The copy lost its PM Cohort line. With the position still open, the item says so.
  fs.rmSync(a.ws.abs(PM.REL));
  hold(a.ws);
  let need = TD.rulingsNeeded(a.ws, { now: a.at });
  assert.deepEqual(need.map((x) => [x.kind, x.pm_cohort_missing, x.reduces_only]), [['position', true, false]]);
  // A stop closes it in the book, and the PM Cohort position is then all that waits.
  released(a.ws);
  const after = iso(a.next + H + 60000);
  TD.applyHours(a.ws, [bar(a.next, { low: '0.60', close: '0.65' })], { now: after });
  hold(a.ws);
  need = TD.rulingsNeeded(a.ws, { now: after });
  assert.deepEqual(need.map((x) => [x.kind, x.may_accept, x.decision_id, x.reduces_only]), [['pm_cohort', true, a.d.decision_id, false]]);
  assert.throws(() => RS.releaseRestoredCopy(a.ws), code('RULING_REQUIRED'));
  assert.equal(pmBytes(a.ws), null);
  assert.equal(T.reconcileDesk(a.ws).counts.held, 1, 'not while held');
  assert.equal(RS.releaseRestoredCopy(a.ws, { accept: [a.d.decision_id] }).status, 'saved');
  assert.equal(T.reconcileDesk(a.ws).completed.filter((x) => x.step === 'paper' && x.status === 'saved').length, 1, 'ruled, the repair opens it at the decision');
});

test('a PM Cohort book that does not read refuses the release: unknown is not none', (t) => {
  const a = liveOrder(t, { fill: true, tag: 'pmbroken' });
  hold(a.ws);
  fs.writeFileSync(a.ws.abs(PM.REL), 'not a record\n');
  const before = marker(a.ws);
  assert.throws(() => RS.releaseRestoredCopy(a.ws, { accept: [a.d.decision_id] }), code('INTEGRITY'));
  assert.equal(marker(a.ws), before);
});

// --- The competing change itself, at each of the four writes a source check used to pin

const flipOnFirst = (t, obj, name, ws, n = 1) => {
  const seen = { flipped: false };
  stub(t, obj, name, (real) => (...x) => { const v = real(...x); if (!seen.flipped) { seen.flipped = true; released(ws, n); } return v; });
  return seen;
};
const midSend = (t, tag) => {
  clean(t);
  const s = deskWith(t);
  ready(s.ws);
  const real = PT.submitIntent;
  PT.submitIntent = (w, intent, ctx) => PT.reserveIntent(w, intent, ctx);
  try { s.d = T.decide(s.ws, s.pid, { receipt_id: s.rid, action: 'approve', request_id: `req_fence_${tag}` }).result.decision; } finally { PT.submitIntent = real; }
  return s;
};

test('a marker that changed after the read refuses the recovery of an order caught mid-send; the same step recovers it without the change', (t) => {
  const { ws } = midSend(t, 'recover');
  const called = [];
  stub(t, PT, 'recover', (real) => (...x) => { called.push('recover'); return real(...x); });
  const journal = journalOf(ws);
  const flip = flipOnFirst(t, PT, 'hours', ws);
  const r = TD.step(ws);
  assert.equal(flip.flipped, true, 'the competing change ran');
  assert.deepEqual(called, [], 'no recovery from the stale read');
  assert.ok(r.problems.some((p) => p.kind === 'recover' && p.code === 'RESTORE_HELD'), JSON.stringify(r.problems));
  assert.ok(journalOf(ws).equals(journal), 'the book is unchanged');
  const control = TD.step(ws);
  assert.deepEqual(called, ['recover'], 'the next read decides again, and recovers it');
  assert.ok(control.done.some((x) => x.kind === 'recover'));
});

test('a marker that changed after the read refuses the reconcile of an UNKNOWN order; the same step reaches it without the change', (t) => {
  const { ws } = midSend(t, 'reconcile');
  PT.recover(ws, { now: iso(Date.now()) });
  const orderOf = () => PT.results(ws, { now: iso(Date.now()) }).orders.find((o) => o.state === 'UNKNOWN');
  assert.ok(orderOf(), 'the order is UNKNOWN');
  const called = [];
  stub(t, PT, 'reconcile', (real) => (...x) => { called.push('reconcile'); return real(...x); });
  const journal = journalOf(ws);
  const flip = flipOnFirst(t, PT, 'hours', ws);
  const r = TD.step(ws);
  assert.equal(flip.flipped, true, 'the competing change ran');
  assert.deepEqual(called, [], 'no reconcile from the stale read');
  assert.ok(r.problems.some((p) => p.kind === 'reconcile' && p.code === 'RESTORE_HELD'), JSON.stringify(r.problems));
  assert.ok(journalOf(ws).equals(journal), 'the book is unchanged');
  TD.step(ws);
  assert.deepEqual(called, ['reconcile'], 'the next read decides again, and reaches it');
});

// A live buy whose grant is the mandate's and whose authority has ended, so the hour's
// first act is the mandate cancel.
const mandateBuy = (t, tag) => {
  const a = liveOrder(t, { tag });
  const rel = `projects/${a.pid}/tickets/decisions.jsonl`;
  const lines = fs.readFileSync(a.ws.abs(rel), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  fs.writeFileSync(a.ws.abs(rel), `${lines.map((l) => JSON.stringify(l.decision_id === a.d.decision_id ? { ...l, decided_by: 'mandate:cr-paper-mandate@1' } : l)).join('\n')}\n`);
  return a;
};

test('a marker that changed after the read refuses the mandate cancel: nothing is cancelled and the hour waits; without the change the cancel happens', (t) => {
  const a = mandateBuy(t, 'mandatecancel');
  const top = topHour();
  const cancels = [];
  stub(t, PT, 'cancelOrder', (real) => (...x) => { cancels.push(x[1]); return real(...x); });
  const journal = journalOf(a.ws);
  const flip = flipOnFirst(t, PT, 'intents', a.ws);
  const rows = TD.applyHours(a.ws, [bar(top, { low: '0.79' })], { now: iso(top + H + 60000) });
  assert.equal(flip.flipped, true, 'the competing change ran');
  assert.deepEqual(cancels, [], 'nothing cancelled from the stale read');
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.equal(rows[0].status, 'refused');
  assert.match(rows[0].words, /could not be cancelled after the paper mandate's authority ended.*restored-copy hold changed/, 'the hour waits, and says why');
  assert.ok(journalOf(a.ws).equals(journal), 'no cancel and no hour from the stale read');
  assert.ok(['ACKED', 'PARTIAL'].includes(PT.intents(a.ws).find((i) => i.intent_id === a.intent).state), 'the buy has not been filled by the hour');
  const control = TD.applyHours(a.ws, [bar(top, { low: '0.79' })], { now: iso(top + H + 60000) });
  assert.deepEqual(cancels.length, 1, 'read again, the cancel happens');
  assert.ok(control.some((x) => x.status === 'cancelled'), JSON.stringify(control));
  assert.equal(PT.intents(a.ws).find((i) => i.intent_id === a.intent).state, 'CANCELLED');
});

test('the rulings are read steadily: a book that changes during the read is read again, and one that keeps changing is refused', (t) => {
  const a = liveOrder(t, { tag: 'steady' });
  a.ws.hosted = true;
  anchorOn(a.ws);
  hold(a.ws);
  assert.deepEqual(TD.rulingsNeeded(a.ws).map((x) => x.kind), ['order']);
  // A write that competes with the read: the buy fills after the results were read and
  // before the rest. Read as one, this is a mix of two books.
  let reads = 0;
  const top = topHour();
  const at = iso(top + 2 * H + 60000);
  stub(t, PT, 'intents', (real) => (...x) => {
    reads += 1;
    if (reads === 1) { PT.applyBar(a.ws, bar(top), { now: at }); PT.applyBar(a.ws, bar(top + H), { now: at }); }
    return real(...x);
  });
  const need = TD.rulingsNeeded(a.ws, { now: at });
  assert.ok(reads >= 2, `the read was taken again (${reads})`);
  assert.deepEqual(need.map((x) => [x.kind, x.decision_id]), [['position', a.d.decision_id]], 'what it says is the book as it now stands');
  assert.ok(PT.results(a.ws, { now: at }).open_positions.length === 1);
  // One that never settles is refused, and the release with it.
  let hour = top + 2 * H;
  PT.intents = ((real) => (...x) => { const v = real(...x); PT.applyBar(a.ws, bar(hour), { now: iso(hour + H + 60000) }); hour += H; return v; })(PT.intents);
  assert.throws(() => TD.rulingsNeeded(a.ws, { now: at }), (e) => e.code === 'INTEGRITY' && /kept changing/.test(e.message));
});

// --- A sell after a restore: one intent ID is one order

const SNAP_DIRS = ['projects', 'paper'];
function cutoffCopy(t, ws) {
  const dir = fs.mkdtempSync(path.join(path.dirname(ws.root), 'cutoff-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const f of SNAP_DIRS) fs.cpSync(ws.abs(f), path.join(dir, f), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(dir, OPLOG_REL)), { recursive: true });
  fs.copyFileSync(ws.abs(OPLOG_REL), path.join(dir, OPLOG_REL));
  return dir;
}
function putBack(ws, dir, { keep = [] } = {}) {
  const kept = keep.map((r) => [r, fs.readFileSync(ws.abs(r))]);
  for (const f of SNAP_DIRS) { fs.rmSync(ws.abs(f), { recursive: true, force: true }); fs.cpSync(path.join(dir, f), ws.abs(f), { recursive: true }); }
  fs.copyFileSync(path.join(dir, OPLOG_REL), ws.abs(OPLOG_REL));
  for (const [r, b] of kept) fs.writeFileSync(ws.abs(r), b);
}
const reservedOf = (ws, id) => fs.readFileSync(ws.abs(PT.JOURNAL), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === 'reserved' && e.intent_id === id) || null;
// The buy has ended and the position is open, so the next thing is a sell.
function sellable(t, tag) {
  const a = liveOrder(t, { fill: true, tag });
  const at = iso(a.next + 3 * H + 60000);
  TD.applyHours(a.ws, [bar(a.next), bar(a.next + H), bar(a.next + 2 * H)], { now: at });
  return { ...a, at, next: a.next + 3 * H };
}
const settled = (ws, at) => {
  const r = PT.results(ws, { now: at });
  const realized = r.closed_positions.reduce((n, p) => n + Number(p.realized_pnl_usd), 0);
  return { r, realized };
};
const nearly = (x, y, msg) => assert.ok(Math.abs(Number(x) - Number(y)) < 1e-6, `${msg}: ${x} vs ${y}`);
const sellEpoch = (ws) => TD.releaseEpochOf(marker(ws));

test('REGRESSION a sell after a restore never reuses an ID the lost timeline may have sent with another body', (t) => {
  const { ws, pid, rid, d, next, at } = sellable(t, 'reuse');
  const cut = cutoffCopy(t, ws);
  const cash = PT.results(ws, { now: at }).cash_usd;
  // The lost timeline: the sell goes and fills.
  T.decide(ws, pid, { receipt_id: rid, action: 'undo', request_id: 'req_reuse_u1' });
  TD.step(ws, { now: at });
  const lostId = TD.intentIdOf(d, 'close-1');
  const lost = reservedOf(ws, lostId);
  assert.ok(lost, 'the sell went in the timeline to be lost');
  TD.applyHours(ws, [bar(next), bar(next + H)], { now: iso(next + 2 * H + 60000) });
  assert.equal(PT.results(ws, { now: iso(next + 2 * H + 60000) }).open_positions.length, 0);
  // The restore, the hold, the owner's Undo again and the release.
  putBack(ws, cut);
  assert.equal(has(ws, lostId), false, 'the copy does not know it');
  hold(ws);
  T.decide(ws, pid, { receipt_id: rid, action: 'undo', request_id: 'req_reuse_u2' });
  assert.equal(RS.releaseRestoredCopy(ws, { accept: [d.decision_id] }).status, 'saved');
  const later = iso(next + 3 * H + 60000);
  TD.applyHours(ws, [next, next + H, next + 2 * H].map((x) => bar(x, { high: '0.88', close: '0.87' })), { now: later });
  const step = TD.step(ws, { now: later });
  assert.deepEqual(step.problems, []);
  assert.equal(has(ws, lostId), false, 'UNSAFE: the same intent ID now names two different orders');
  const newId = TD.intentIdOf(d, TD.closePurpose(1, sellEpoch(ws)));
  const fresh = reservedOf(ws, newId);
  assert.ok(fresh, 'the sell goes under an ID from this release');
  assert.notEqual(fresh.intent_sha256, lost.intent_sha256, 'and it is a different body, which is why it needs its own ID');
  assert.equal(fresh.quantity, '2000', 'for the whole position, once');
  assert.deepEqual(TD.requests(ws, { now: later }).requests.filter((x) => x.decision_id === d.decision_id).map((x) => x.close && x.close.intent_id), [newId], 'the desk knows it as this position\'s sell');
  // It fills once; quantities and cash stand.
  const end = iso(next + 5 * H + 60000);
  TD.applyHours(ws, [bar(next + 3 * H, { high: '0.88', close: '0.87' }), bar(next + 4 * H, { high: '0.88', close: '0.87' })], { now: end });
  const { r, realized } = settled(ws, end);
  assert.deepEqual(r.open_positions, []);
  assert.equal(r.closed_positions.length, 1);
  assert.deepEqual(r.closed_positions[0].exits.map((e) => e.quantity), ['2000']);
  assert.notEqual(r.cash_usd, cash);
  nearly(r.cash_usd, Number(r.funded_usd) + realized, 'cash is the funding and what was realized');
  assert.equal(TD.step(ws, { now: end }).done.length, 0, 'nothing more goes');
  assert.equal(PT.intents(ws).filter((i) => i.side === 'CLOSE_LONG').length, 1);
});

test('one book: the same body again changes nothing, another body under its ID is refused, and nothing can oversell', (t) => {
  const { ws, pid, rid, d, next, at } = sellable(t, 'oversell');
  T.decide(ws, pid, { receipt_id: rid, action: 'undo', request_id: 'req_oversell_u' });
  TD.step(ws, { now: at });
  const id = TD.intentIdOf(d, 'close-1');
  const body = reservedOf(ws, id).intent;
  const s = TD.settingsOf(ws, { grants: [], projects: [], snap: { results: { funded_usd: '25000' }, list: [], open: new Map(), intents: new Map() } });
  const ctx = { now: at, rules: s.rules, venue: s.venue };
  const journal = journalOf(ws);
  assert.equal(PT.submitIntent(ws, body, ctx).status, 'unchanged');
  assert.ok(journalOf(ws).equals(journal), 'the same body writes nothing');
  assert.throws(() => PT.submitIntent(ws, { ...body, entry_price: '0.80' }, ctx), code('CONFLICT'));
  assert.ok(journalOf(ws).equals(journal), 'another body writes nothing');
  const second = PT.submitIntent(ws, { ...body, intent_id: TD.intentIdOf(d, 'close-2') }, ctx);
  assert.equal(second.status, 'refused', 'a second sell while one is live');
  assert.equal(second.refusals[0].rule, 'position');
  const after = iso(next + 2 * H + 60000);
  TD.applyHours(ws, [bar(next), bar(next + H)], { now: after });
  const { r, realized } = settled(ws, after);
  assert.deepEqual(r.closed_positions[0].exits.map((e) => e.quantity), ['2000']);
  const third = PT.submitIntent(ws, { ...body, intent_id: TD.intentIdOf(d, 'close-3'), created_at: after, reference_at: iso(next + H), valid_until: iso(next + 3 * H) }, { ...ctx, now: after });
  assert.equal(third.status, 'refused', 'a sell of a closed position');
  const again = settled(ws, after);
  assert.equal(again.r.cash_usd, r.cash_usd, 'no cash from it');
  assert.deepEqual(again.r.closed_positions[0].exits.map((e) => e.quantity), ['2000'], 'no fill from it');
  nearly(again.r.cash_usd, Number(r.funded_usd) + realized, 'cash is the funding and what was realized');
});

// A sell fills whole or not at all, and is cancelled if its position has grown past it
// (paper-trader.js), so what can differ across a restore is how much the position holds.
test('a buy part-filled at the cutoff: the lost timeline sold more than the copy holds; the sell here is its own ID, for only what the copy holds', (t) => {
  const { ws, pid, rid, d, intent, next } = liveOrder(t, { fill: true, tag: 'partial' });
  const firstAt = iso(next + 60000);
  assert.equal(PT.intents(ws).find((i) => i.intent_id === intent).state, 'PARTIAL');
  const held = PT.results(ws, { now: firstAt }).open_positions[0].quantity;
  const ordered = PT.intents(ws).find((i) => i.intent_id === intent).quantity;
  assert.ok(Number(held) < Number(ordered), `part of the buy: ${held} of ${ordered}`);
  const cut = cutoffCopy(t, ws);
  // Lost: the buy finished, and close-1 sold all of it.
  const lostAt = iso(next + 2 * H + 60000);
  TD.applyHours(ws, [bar(next), bar(next + H)], { now: lostAt });
  T.decide(ws, pid, { receipt_id: rid, action: 'undo', request_id: 'req_partial_u1' });
  TD.step(ws, { now: lostAt });
  const lostId = TD.intentIdOf(d, 'close-1');
  const lost = reservedOf(ws, lostId);
  assert.ok(lost, 'the sell went in the timeline to be lost');
  assert.ok(Number(lost.quantity) > Number(held), `it sold ${lost.quantity}; the copy holds ${held}`);
  putBack(ws, cut);
  hold(ws);
  T.decide(ws, pid, { receipt_id: rid, action: 'undo', request_id: 'req_partial_u2' });
  assert.equal(RS.releaseRestoredCopy(ws, { accept: [d.decision_id] }).status, 'saved');
  const step = TD.step(ws, { now: firstAt });
  assert.deepEqual(step.problems, []);
  assert.deepEqual(step.done.map((x) => x.kind), ['cancel', 'close'], 'what had not filled is cancelled, then the sell');
  assert.equal(has(ws, lostId), false, 'the ID that sold more is not reused');
  const fresh = reservedOf(ws, TD.intentIdOf(d, TD.closePurpose(1, sellEpoch(ws))));
  assert.equal(fresh.quantity, held, 'it sells what this book holds, not what the lost one did');
  assert.equal(PT.intents(ws).find((i) => i.intent_id === intent).state, 'CANCELLED');
  const fin = iso(next + 2 * H + 60000);
  TD.applyHours(ws, [bar(next), bar(next + H)], { now: fin });
  const { r, realized } = settled(ws, fin);
  assert.deepEqual(r.open_positions, []);
  assert.deepEqual(r.closed_positions[0].exits.map((e) => e.quantity), [held], 'sold exactly what was bought: not one more');
  for (const i of PT.intents(ws).filter((x) => x.side === 'CLOSE_LONG')) assert.ok(Number(i.filled) <= Number(i.quantity));
  nearly(r.cash_usd, Number(r.funded_usd) + realized, 'cash is the funding and what was realized');
  assert.equal(TD.step(ws, { now: fin }).done.length, 0, 'nothing more goes');
});

test('a venue record that survives from the lost timeline refuses the book as INTEGRITY: nothing is written over it', (t) => {
  const { ws, pid, rid, at } = sellable(t, 'venuekept');
  const cut = cutoffCopy(t, ws);
  T.decide(ws, pid, { receipt_id: rid, action: 'undo', request_id: 'req_venuekept_u1' });
  TD.step(ws, { now: at });
  putBack(ws, cut, { keep: [PT.VENUE] });
  assert.throws(() => PT.results(ws, { now: at }), code('INTEGRITY'));
  const journal = journalOf(ws);
  hold(ws);
  assert.throws(() => RS.releaseRestoredCopy(ws), code('INTEGRITY'));
  assert.ok(journalOf(ws).equals(journal));
});

test('a sell from an earlier release stays this position\'s sell after a second one: named, not unmatched, and no second sell goes', (t) => {
  const { ws, pid, rid, d, at } = sellable(t, 'second');
  hold(ws);
  T.decide(ws, pid, { receipt_id: rid, action: 'undo', request_id: 'req_second_u' });
  assert.equal(RS.releaseRestoredCopy(ws, { accept: [d.decision_id] }).status, 'saved');
  TD.step(ws, { now: at });
  const firstEpoch = sellEpoch(ws);
  const id = TD.intentIdOf(d, TD.closePurpose(1, firstEpoch));
  assert.ok(has(ws, id));
  hold(ws);
  assert.deepEqual(TD.rulingsNeeded(ws, { now: at }).map((x) => x.kind), ['position'], 'not unmatched');
  assert.equal(RS.releaseRestoredCopy(ws, { accept: [d.decision_id] }).status, 'saved');
  assert.notEqual(sellEpoch(ws), firstEpoch, 'each release is its own');
  assert.notEqual(TD.closePurpose(1, sellEpoch(ws)), TD.closePurpose(1, null));
  const step = TD.step(ws, { now: at });
  assert.deepEqual(step.done, [], 'it is live, so nothing more is sent');
  // A refused sell under the plain number from before any release keeps its owner too.
  const body = reservedOf(ws, id).intent;
  const s = TD.settingsOf(ws, { grants: [], projects: [], snap: { results: { funded_usd: '25000' }, list: [], open: new Map(), intents: new Map() } });
  const plain = TD.intentIdOf(d, 'close-1');
  assert.equal(PT.submitIntent(ws, { ...body, intent_id: plain }, { now: at, rules: s.rules, venue: s.venue }).status, 'refused');
  const view = TD.view(ws, { now: at });
  assert.equal(view.orders.find((o) => o.intent_id === id).decision_id, d.decision_id, 'and the view still says whose it is');
  assert.equal(view.refusals.find((o) => o.intent_id === plain).decision_id, d.decision_id);
});

test('a workspace that was never restored numbers its sells as before', (t) => {
  const { ws, pid, rid, d, at } = sellable(t, 'plain');
  T.decide(ws, pid, { receipt_id: rid, action: 'undo', request_id: 'req_plain_u' });
  TD.step(ws, { now: at });
  assert.equal(has(ws, TD.intentIdOf(d, 'close-1')), true);
  assert.equal(TD.releaseEpochOf(''), null);
  assert.equal(TD.releaseEpochOf('{"research_held":true}'), null);
  assert.equal(TD.releaseEpochOf('[]'), null);
});

// --- Eric's disposition of a basis that cannot be verified

const unverify = (a) => {
  const rel = DB.basisRel(a.pid, a.d.decision_id);
  const body = JSON.parse(fs.readFileSync(a.ws.abs(rel), 'utf8'));
  delete body.digest_ledger;
  fs.writeFileSync(a.ws.abs(rel), JSON.stringify(body));
  fs.rmSync(a.ws.abs(DB.digestRel(a.pid)));
  assert.equal(DB.viewOf(a.ws, a.pid, a.d.decision_id).label, 'unverified');
  return rel;
};
const statusItem = (a, at) => {
  const item = TD.rulingsNeeded(a.ws, at ? { now: at } : undefined).find((x) => x.decision_id === a.d.decision_id);
  return { item, basis: RS.basisRulingOf(a.ws, item) };
};

test('a position whose basis cannot be verified: release stays refused until Eric names it, and the ruling verifies nothing and rewrites nothing', (t) => {
  const a = liveOrder(t, { fill: true, tag: 'ruling' });
  const rel = unverify(a);
  hold(a.ws);
  const bytes = () => [rel, `projects/${a.pid}/tickets/decisions.jsonl`, PT.JOURNAL].map((r) => fs.readFileSync(a.ws.abs(r), 'utf8'));
  const before = bytes();
  const held = marker(a.ws);
  const { item, basis } = statusItem(a);
  assert.equal(item.kind, 'position');
  assert.equal(item.reduces_only, false, 'the buy behind it is still live');
  assert.match(basis.ruling, /Undo the decision first/);
  // Its buy ends, so nothing can add to the position any more.
  const at = iso(a.next + 3 * H + 60000);
  released(a.ws);
  TD.applyHours(a.ws, [bar(a.next), bar(a.next + H), bar(a.next + 2 * H)], { now: at });
  hold(a.ws);
  const journalNow = fs.readFileSync(a.ws.abs(PT.JOURNAL), 'utf8');
  const heldNow = marker(a.ws);
  const ready2 = statusItem(a, at);
  assert.equal(ready2.item.reduces_only, true);
  assert.equal(ready2.basis.label, 'unverified');
  const token = ready2.basis.ruling_token;
  assert.match(token, /^[0-9a-f]{32}$/);
  const release = (o) => RS.releaseRestoredCopy(a.ws, { accept: [a.d.decision_id], ...o });
  // Every way short of a named ruling refuses, and the hold stands.
  assert.throws(() => release({}), (e) => e.code === 'RULING_REQUIRED' && /--basis-ruling/.test(e.message), 'no ruling');
  assert.throws(() => release({ basisRulings: [`${a.d.decision_id}:${token}`] }), code('INVALID'), 'no reason');
  assert.throws(() => release({ basisRulings: [`${a.d.decision_id}:${token}`], because: '   ' }), code('INVALID'), 'an empty reason');
  assert.throws(() => release({ basisRulings: ['*'], because: 'all of it' }), code('INVALID'), 'no blanket ruling');
  assert.throws(() => release({ basisRulings: [`${a.d.decision_id}`], because: 'no token' }), code('INVALID'), 'no bare name');
  assert.throws(() => release({ basisRulings: [`${a.d.decision_id}:${'0'.repeat(32)}`], because: 'a wrong token' }), code('RULING_REQUIRED'), 'not these records');
  assert.throws(() => release({ basisRulings: [`td_00000000000000:${token}`], because: 'another decision' }), code('INVALID'), 'a stray name');
  assert.throws(() => RS.releaseRestoredCopy(a.ws, { basisRulings: [`${a.d.decision_id}:${token}`], because: 'ruled, not accepted' }), code('RULING_REQUIRED'), 'a ruling is not an acceptance');
  assert.equal(marker(a.ws), heldNow, 'the hold stands after each');
  assert.ok(RS.restoredHold(a.ws));
  // Named, the release goes, and it is on the record as what it is.
  const done = release({ basisRulings: [`${a.d.decision_id}:${token}`], because: 'FICTIONAL: from before the digest ledger; I checked the position by hand' });
  assert.equal(done.status, 'saved');
  const m = JSON.parse(marker(a.ws));
  assert.equal(m.research_held, false);
  assert.deepEqual(m.basis_rulings.map((x) => [x.decision_id, x.kind, x.label, x.token]), [[a.d.decision_id, 'position', 'unverified', token]]);
  assert.match(m.basis_rulings[0].because, /by hand/);
  assert.match(m.basis_rulings[0].meaning, /not verified/);
  // Nothing was fabricated or altered.
  const after = bytes();
  assert.equal(after[0], before[0], 'the basis has the same bytes');
  assert.equal(after[1], before[1], 'the decisions have the same bytes');
  assert.equal(after[2], journalNow, 'the journal has the same bytes');
  assert.equal(fs.existsSync(a.ws.abs(DB.digestRel(a.pid))), false, 'no digest was made for it');
  assert.equal(DB.viewOf(a.ws, a.pid, a.d.decision_id).label, 'unverified', 'and it still reads as unverified');
  assert.notEqual(held, marker(a.ws));
});

test('a buy whose basis cannot be verified takes no ruling: Undo it, then rule on the cancel, and nothing fills', (t) => {
  const a = liveOrder(t, { tag: 'rulingbuy' });
  unverify(a);
  hold(a.ws);
  const live = statusItem(a);
  assert.deepEqual([live.item.kind, live.item.reduces_only], ['order', false]);
  assert.equal(live.basis.ruling_token, undefined);
  const token = DB.rulingTokenOf(DB.viewOf(a.ws, a.pid, a.d.decision_id));
  const before = marker(a.ws);
  assert.throws(() => RS.releaseRestoredCopy(a.ws, { accept: [a.d.decision_id], basisRulings: [`${a.d.decision_id}:${token}`], because: 'let it fill' }), (e) => e.code === 'RULING_REQUIRED' && /can still add to a position/.test(e.message));
  assert.equal(marker(a.ws), before);
  T.decide(a.ws, a.pid, { receipt_id: a.rid, action: 'undo', request_id: 'req_rulingbuy_u' });
  const undone = statusItem(a);
  assert.deepEqual([undone.item.kind, undone.item.reduces_only], ['cancel', true]);
  assert.equal(undone.basis.ruling_token, token, 'the same records');
  assert.equal(RS.releaseRestoredCopy(a.ws, { accept: [a.d.decision_id], basisRulings: [`${a.d.decision_id}:${token}`], because: 'FICTIONAL: cancel it' }).status, 'saved');
  TD.step(a.ws);
  const buy = PT.intents(a.ws).find((i) => i.intent_id === a.intent);
  assert.equal(buy.state, 'CANCELLED');
  assert.equal(Number(buy.filled), 0);
});

test('an opening whose basis cannot be verified has no ruling either: Undo is the way on', (t) => {
  const { ws, pid, rid, d, intent } = preCutoffGrant(t, 'rulingopen');
  const a = { ws, pid, rid, d };
  unverify(a);
  hold(ws);
  const token = DB.rulingTokenOf(DB.viewOf(ws, pid, d.decision_id));
  assert.throws(() => RS.releaseRestoredCopy(ws, { accept: [d.decision_id], basisRulings: [`${d.decision_id}:${token}`], because: 'send it' }), code('RULING_REQUIRED'));
  T.decide(ws, pid, { receipt_id: rid, action: 'undo', request_id: 'req_rulingopen_u' });
  assert.equal(RS.releaseRestoredCopy(ws).status, 'saved');
  TD.step(ws);
  assert.equal(has(ws, intent), false);
});

test('no ruling for a basis that does not match its records, or one that stands, or for records changed since they were read', (t) => {
  const a = sellable(t, 'rulingbad');
  const rel = unverify(a);
  hold(a.ws);
  const token = statusItem(a, a.at).basis.ruling_token;
  const asked = { accept: [a.d.decision_id], basisRulings: [`${a.d.decision_id}:${token}`], because: 'FICTIONAL' };
  const original = fs.readFileSync(a.ws.abs(rel));
  const heldNow = marker(a.ws);
  // Changed since the token was read.
  fs.writeFileSync(a.ws.abs(rel), JSON.stringify({ ...JSON.parse(original), added_later: 'FICTIONAL' }));
  assert.throws(() => RS.releaseRestoredCopy(a.ws, asked), (e) => e.code === 'RULING_REQUIRED' && /other than the ones here now/.test(e.message));
  assert.equal(marker(a.ws), heldNow);
  fs.writeFileSync(a.ws.abs(rel), original);
  // A receipt that no longer matches is INTEGRITY, ruling or no ruling.
  const receipt = `projects/${a.pid}/tickets/receipts/${a.d.receipt_id}.json`;
  const r = fs.readFileSync(a.ws.abs(receipt));
  fs.appendFileSync(a.ws.abs(receipt), ' ');
  assert.equal(statusItem(a, a.at).basis.label, 'unreadable');
  assert.throws(() => RS.releaseRestoredCopy(a.ws, asked), code('INTEGRITY'));
  assert.equal(marker(a.ws), heldNow);
  fs.writeFileSync(a.ws.abs(receipt), r);
  // One that stands has nothing to rule on.
  const b = sellable(t, 'rulinggood');
  hold(b.ws);
  assert.equal(statusItem(b, b.at).basis.label, 'decision_time');
  assert.throws(() => RS.releaseRestoredCopy(b.ws, { accept: [b.d.decision_id], basisRulings: [`${b.d.decision_id}:${'a'.repeat(32)}`], because: 'FICTIONAL' }), code('INVALID'));
  assert.equal(RS.releaseRestoredCopy(b.ws, { accept: [b.d.decision_id] }).status, 'saved', 'and needs none');
});

test('a basis reading unavailable takes no ruling, and the token is bound to both the decision and its basis', (t) => {
  const a = sellable(t, 'rulinglabel');
  hold(a.ws);
  const real = DB.viewOf(a.ws, a.pid, a.d.decision_id);
  const unavailable = { ...real, label: 'unavailable', words: 'FICTIONAL', basis: null };
  stub(t, DB, 'viewOf', () => () => unavailable);
  const held = marker(a.ws);
  assert.equal(RS.basisRulingOf(a.ws, { project_id: a.pid, decision_id: a.d.decision_id, reduces_only: true }).ruling_token, undefined);
  assert.throws(() => RS.releaseRestoredCopy(a.ws, { accept: [a.d.decision_id], basisRulings: [`${a.d.decision_id}:${DB.rulingTokenOf(unavailable)}`], because: 'FICTIONAL' }), (e) => e.code === 'RULING_REQUIRED' && /reads as unavailable/.test(e.message));
  assert.equal(marker(a.ws), held);
  const v = { label: 'unverified', words: 'x', decision: { decision_id: 'a' }, basis: { research: [] } };
  const token = DB.rulingTokenOf(v);
  assert.equal(DB.rulingTokenOf({ ...v, later: ['not part of it'] }), token);
  assert.notEqual(DB.rulingTokenOf({ ...v, decision: { decision_id: 'b' } }), token);
  assert.notEqual(DB.rulingTokenOf({ ...v, basis: { research: [1] } }), token);
  assert.notEqual(DB.rulingTokenOf({ ...v, words: 'y' }), token);
});

test('the command line: status gives the token, the release takes it with a reason, and no route does', (t) => {
  const a = sellable(t, 'rulingcli');
  unverify(a);
  const cli = (...x) => { const r = spawnSync(process.execPath, [path.join(CODE, 'cli.js'), ...x, '--workspace', a.ws.root], { encoding: 'utf8', env: process.env, timeout: 60000 }); return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }; };
  assert.equal(cli('restored-copy', 'hold', '--confirm', '--from', 'fictional disk').code, 0);
  const status = cli('restored-copy', 'status');
  assert.equal(status.code, 0);
  const item = JSON.parse(status.out.slice(status.out.indexOf('{'))).rulings_needed.find((x) => x.decision_id === a.d.decision_id);
  assert.equal(item.basis.label, 'unverified');
  const refused = cli('restored-copy', 'release', '--confirm', '--accept', a.d.decision_id);
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /--basis-ruling/);
  assert.ok(RS.restoredHold(a.ws));
  const token = item.basis.ruling_token;
  assert.match(token, /^[0-9a-f]{32}$/, JSON.stringify(item));
  assert.notEqual(cli('restored-copy', 'release', '--confirm', '--accept', a.d.decision_id, '--basis-ruling', `${a.d.decision_id}:${token}`).code, 0, 'a reason is required');
  assert.ok(RS.restoredHold(a.ws));
  assert.equal(cli('restored-copy', 'release', '--confirm', '--accept', a.d.decision_id, '--basis-ruling', `${a.d.decision_id}:${token}`, '--because', 'FICTIONAL: checked by hand').code, 0);
  assert.equal(RS.restoredHold(a.ws), null);
  assert.equal(JSON.parse(marker(a.ws)).basis_rulings[0].token, token);
  const server = fs.readFileSync(path.join(CODE, 'server.js'), 'utf8');
  assert.equal(/basisRulings|basis_ruling/.test(server), false, 'on no route');
});
