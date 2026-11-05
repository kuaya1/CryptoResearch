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

test('what is not covered, on the record: a decision still writes the PM Cohort book while held', (t) => {
  clean(t);
  const { ws, pid, rid } = deskWith(t);
  ready(ws);
  hold(ws);
  const r = T.decide(ws, pid, { receipt_id: rid, action: 'approve', request_id: 'req_hold_pm' }).result;
  assert.ok(r.paper, 'the PM Cohort book is asked, hold or no hold');
  assert.notEqual(r.paper.status, 'failed', 'and it answers: the hold does not reach it; see PAPER_BOOK_RESTORE.md');
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
  assert.equal(has(ws, sell), true, 'after the release, its own ID, made now');
  hold(ws);
  assert.equal(TD.rulingsNeeded(ws, { now: at }).some((x) => x.kind === 'unmatched_order'), false, 'its own sell is not unmatched');
});

// --- What the deliberate breaks asked for

// The marker changes, not held: a read taken before it must not write. A fresh fence
// at the write would see nothing wrong.
const released = (ws, n = 1) => { fs.mkdirSync(path.dirname(ws.abs(MARK)), { recursive: true }); fs.writeFileSync(ws.abs(MARK), JSON.stringify({ schema_version: 'cr.restored-copy.v1', research_held: false, released_at: `2026-11-05T00:00:0${n}.000Z` })); };

test('every write of the book carries the fence of the read it came from, by construction', () => {
  const src = fs.readFileSync(path.join(CODE, 'core', 'trader-desk.js'), 'utf8').split('\n');
  const sites = src.filter((l) => /underAnchor\(ws, \(\) => PT\./.test(l));
  assert.equal(sites.length, 7);
  for (const l of sites) assert.match(l, /, (ctx|n)\.fence\)/, l);
});

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
