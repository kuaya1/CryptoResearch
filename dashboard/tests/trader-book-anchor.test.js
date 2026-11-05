'use strict';
// The book's anchor: Eric's record of which book a desk holds, kept off the disk
// the book, the operation log and the settings share. With all of them gone an
// anchored desk refuses, and no desk online starts a book by itself. Temporary
// workspaces and fictional projects, pairs and hours only. The network is stubbed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('../core/tickets');
const TD = require('../core/trader-desk');
const PT = require('../core/paper-trader');
const TR = require('../core/trader-rules');
const B = require('../core/brief-daily');
const J = require('../core/jobs');
const X = require('../core/exporter');
const { OPLOG_REL } = require('../core/ops');
const { tempWorkspace, hashTree } = require('./helpers');
const { H, M, iso, deskWith, settle, bar, mine } = require('./trader-fixture');

const VAR = TR.BOOK_ANCHOR_ENV;
const FUNDED_AT = '2026-10-01T00:00:00.000Z';
const AT = Date.parse('2026-10-05T00:00:00Z');
const NOW = iso(AT);
const BOOK = { cash_usd: '1000', fee_rate: '0.003' };

function env(t, vars) {
  for (const [k, v] of Object.entries(vars)) {
    const before = process.env[k];
    if (v === null) delete process.env[k]; else process.env[k] = v;
    t.after(() => { if (before === undefined) delete process.env[k]; else process.env[k] = before; });
  }
}
function quietNet(t) {
  const real = global.fetch;
  global.fetch = async () => ({ ok: false, status: 429, headers: { get: () => null }, text: async () => '', json: async () => ({}) });
  t.after(() => { global.fetch = real; });
}
function online(t, label = 'anchor') {
  const w = tempWorkspace(label);
  t.after(w.cleanup);
  w.ws.hosted = true;
  w.ws.settings.trader = { rules: {}, book: { ...BOOK } };
  return w;
}
const genesis = (ws) => TR.genesisOf(fs.readFileSync(ws.abs(PT.JOURNAL), 'utf8').split('\n')[0]);
const loseBookAndLog = (ws) => {
  fs.rmSync(ws.abs('paper/trader'), { recursive: true, force: true });
  fs.rmSync(ws.abs(OPLOG_REL), { force: true });
};
const refused = (fn, re = /lost, not new/) => assert.throws(fn, (e) => e.code === 'INTEGRITY' && re.test(e.message), 'refused');
const noBook = (ws) => assert.equal(fs.existsSync(ws.abs(PT.JOURNAL)), false, 'no new journal');
function saidInTheBrief(ws, at) {
  const a = B.attention(ws, { now: at });
  assert.ok(a.exceptions.items.some((e) => e.reason === 'trader_unreadable'), 'an exception');
  assert.equal(a.exceptions.count, null, 'unknown, never zero');
}

// A real history on a desk: funded, an order from Eric's grant, a fill, a position.
function history(t) {
  env(t, { [VAR]: null, CR_DATA_DIR: null });
  const s = deskWith(t);
  const { ws, pid, rid } = s;
  const decision = T.decide(ws, pid, { receipt_id: rid, action: 'approve', request_id: 'req_anchor_approve1' }).result.decision;
  settle(ws);
  const now0 = Date.now();
  const top = Math.floor(now0 / H) * H;
  TD.applyHours(ws, Array.from({ length: 16 }, (_, i) => bar(top - (16 - i) * H)), { now: iso(now0) });
  TD.step(ws);
  const fillHour = Math.ceil(Date.now() / H) * H;
  const at = fillHour + H + M;
  TD.applyHours(ws, Array.from({ length: Math.round((fillHour - top) / H) + 1 }, (_, i) => bar(top + i * H)), { now: iso(at) });
  assert.equal(TD.view(ws, { now: iso(at) }).results.open_positions.length, 1, 'the fixture holds a position');
  assert.equal(mine(TD.requests(ws, { now: iso(at) }), decision.decision_id).phase, 'open');
  ws.hosted = true;
  return { ...s, decision, at, top };
}

test('the book and its operation log both lost: every read and write refuses, said in the brief, nothing funded or ordered', async (t) => {
  quietNet(t);
  const { ws, at, top } = history(t);
  env(t, { [VAR]: genesis(ws) });
  loseBookAndLog(ws);
  const now = iso(at);
  refused(() => TD.view(ws, { now }));
  refused(() => TD.requests(ws, { now }));
  refused(() => TD.wanted(ws, { now }));
  refused(() => TD.pending(ws, { now }));
  refused(() => TD.step(ws, { now }));
  refused(() => TD.executionFor(ws, 'td_fictional'));
  saidInTheBrief(ws, at);
  assert.deepEqual(TD.applyHours(ws, [bar(top)], { now }).map((r) => [r.status, r.code]), [['refused', 'INTEGRITY']]);
  noBook(ws);
  const [job] = await J.runJobs(ws, ['trader'], { trigger: 'dashboard', onlyDue: true });
  assert.equal(job.status, 'failed', 'the timer path says so');
  assert.match(JSON.stringify(job), /lost, not new/);
  noBook(ws);
});

test('a decision after the loss runs no funding and no order', (t) => {
  env(t, { [VAR]: null, CR_DATA_DIR: null });
  const s = deskWith(t);
  const { ws, pid, rid } = s;
  ws.hosted = true;
  settle(ws);
  env(t, { [VAR]: 'new' });
  TD.step(ws);
  env(t, { [VAR]: genesis(ws) });
  loseBookAndLog(ws);
  const r = T.decide(ws, pid, { receipt_id: rid, action: 'approve', request_id: 'req_anchor_approve2' });
  assert.equal(r.result.trader.status, 'failed');
  assert.match(JSON.stringify(r.result.trader), /lost, not new/);
  noBook(ws);
});

test('the disk wholly replaced, settings gone too: the anchor still refuses', (t) => {
  const { ws, at } = history(t);
  env(t, { [VAR]: genesis(ws) });
  loseBookAndLog(ws);
  ws.settings.trader = undefined;
  refused(() => TD.view(ws, { now: iso(at) }));
  refused(() => TD.step(ws, { now: iso(at) }));
  noBook(ws);
});

test('the journal alone gone, or a different book in its place: refused, the book untouched', (t) => {
  const { root, ws } = online(t);
  env(t, { [VAR]: 'new' });
  assert.deepEqual(TD.step(ws, { now: FUNDED_AT }).done.map((d) => d.kind), ['fund']);
  env(t, { [VAR]: genesis(ws) });
  // Another book that reads as sound: its own funding and its own head.
  const other = online(t, 'other-book');
  PT.fund(other.ws, { cash_usd: '1000', now: '2026-10-02T00:00:00.000Z' });
  fs.copyFileSync(other.ws.abs(PT.JOURNAL), ws.abs(PT.JOURNAL));
  fs.copyFileSync(other.ws.abs(PT.HEAD), ws.abs(PT.HEAD));
  const before = hashTree(root);
  refused(() => TD.view(ws, { now: NOW }), /not the established book/);
  refused(() => TD.step(ws, { now: NOW }), /not the established book/);
  assert.deepEqual(TD.applyHours(ws, [], { now: NOW }).map((r) => r.code), ['INTEGRITY']);
  assert.deepEqual(hashTree(root), before, 'nothing written');
  fs.rmSync(ws.abs(PT.JOURNAL));
  refused(() => TD.view(ws, { now: NOW }));
});

test('ordinary operation: an anchored book reads, steps and takes hours as before, and losing only the log does not matter', (t) => {
  const { ws, at, decision } = history(t);
  env(t, { [VAR]: genesis(ws) });
  const v = TD.view(ws, { now: iso(at) });
  assert.equal(v.results.open_positions.length, 1);
  assert.deepEqual(v.continuity, { anchor: 'established', genesis_sha256: genesis(ws) });
  assert.equal(v.waits.some((w) => w.includes(VAR)), false);
  const lines = fs.readFileSync(ws.abs(PT.JOURNAL), 'utf8');
  assert.deepEqual(TD.step(ws, { now: iso(at) }).problems, []);
  const nextHour = Math.floor(at / H) * H;
  TD.applyHours(ws, [bar(nextHour)], { now: iso(nextHour + H + M) });
  assert.ok(fs.readFileSync(ws.abs(PT.JOURNAL), 'utf8').startsWith(lines), 'the book only grows');
  assert.equal(mine(TD.requests(ws, { now: iso(nextHour + H + M) }), decision.decision_id).phase, 'open', 'the same order, not a new one');
  fs.rmSync(ws.abs(OPLOG_REL), { force: true });
  assert.equal(TD.view(ws, { now: iso(nextHour + H + M) }).results.open_positions.length, 1);
});

test('authorized recovery: from a complete package in an isolated folder the book goes back and reads as it was, with no funding and no replay', (t) => {
  const { ws, at } = history(t);
  env(t, { [VAR]: genesis(ws) });
  const before = TD.view(ws, { now: iso(at) });
  const intentsBefore = PT.intents(ws).map((i) => i.intent_id).sort();
  const lines = fs.readFileSync(ws.abs(PT.JOURNAL), 'utf8');
  const pkg = JSON.parse(JSON.stringify(X.exportPackage(ws)));
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-restore-'));
  t.after(() => fs.rmSync(isolated, { recursive: true, force: true }));
  const target = path.join(isolated, 'target');
  X.restorePackage(pkg, target);
  loseBookAndLog(ws);
  refused(() => TD.step(ws, { now: iso(at) }));
  // Eric's restore: the book's files and the log back from the checked copy.
  fs.mkdirSync(path.dirname(ws.abs(PT.JOURNAL)), { recursive: true });
  for (const rel of [PT.JOURNAL, PT.HEAD, PT.VENUE, OPLOG_REL]) fs.copyFileSync(path.join(target, rel), ws.abs(rel));
  const after = TD.view(ws, { now: iso(at) });
  assert.deepEqual(after.results, before.results, 'the same results');
  assert.equal(after.results.open_positions.length, 1);
  const s = TD.step(ws, { now: iso(at) });
  assert.deepEqual(s.done.filter((d) => d.kind === 'fund' || d.kind === 'open'), [], 'no funding, no order again');
  assert.ok(fs.readFileSync(ws.abs(PT.JOURNAL), 'utf8').startsWith(lines), 'the journal continues the one restored');
  assert.deepEqual(PT.intents(ws).map((i) => i.intent_id).sort(), intentsBefore, 'the same orders');
});

test('a legitimate new book: online it starts only under "new", once, through either path, then the hash takes over', (t) => {
  for (const through of ['step', 'hours']) {
    const { ws } = online(t, `new-${through}`);
    env(t, { [VAR]: null, CR_DATA_DIR: null });
    // Not yet approved: nothing starts, in words, with no journal.
    const v = TD.view(ws, { now: NOW });
    assert.equal(v.results.funded_usd, null);
    assert.equal(v.continuity.anchor, 'unset_online');
    assert.ok(v.waits.some((w) => w.includes(VAR)));
    if (through === 'step') assert.deepEqual(TD.step(ws, { now: NOW }).problems.map((p) => p.code), ['INIT_REQUIRED']);
    else assert.deepEqual(TD.applyHours(ws, [bar(AT - 2 * H)], { now: NOW }).map((r) => r.code), ['INIT_REQUIRED']);
    noBook(ws);
    // Eric's "new".
    env(t, { [VAR]: 'new' });
    if (through === 'step') assert.deepEqual(TD.step(ws, { now: NOW }).done.map((d) => d.kind), ['fund']);
    else TD.applyHours(ws, [], { now: NOW });
    assert.equal(TD.view(ws, { now: NOW }).results.funded_usd, '1000');
    assert.deepEqual(TD.step(ws, { now: NOW }).done, [], 'once');
    const shown = TD.view(ws, { now: NOW }).continuity;
    assert.deepEqual(shown, { anchor: 'new', genesis_sha256: genesis(ws) });
    env(t, { [VAR]: shown.genesis_sha256 });
    assert.equal(TD.view(ws, { now: NOW }).results.funded_usd, '1000');
  }
});

test('with the anchor missing online, a lost book is not funded, no order goes, and it is said', (t) => {
  const { ws, at, top } = history(t);
  assert.equal(TD.view(ws, { now: iso(at) }).results.funded_usd, '25000', 'a funded book reads without an anchor');
  loseBookAndLog(ws);
  const v = TD.view(ws, { now: iso(at) });
  assert.equal(v.results.funded_usd, null);
  assert.ok(v.waits.some((w) => w.includes(VAR)));
  const s = TD.step(ws, { now: iso(at) });
  assert.deepEqual(s.done, []);
  assert.ok(s.problems.some((p) => p.code === 'INIT_REQUIRED'));
  assert.deepEqual(TD.applyHours(ws, [bar(top)], { now: iso(at) }).map((r) => r.code), ['INIT_REQUIRED']);
  noBook(ws);
});

test('a command in the shell of an online desk counts as online: CR_DATA_DIR, with no ws.hosted', (t) => {
  const w = tempWorkspace('shell');
  t.after(w.cleanup);
  w.ws.settings.trader = { rules: {}, book: { ...BOOK } };
  env(t, { [VAR]: null, CR_DATA_DIR: '/fictional/data' });
  assert.deepEqual(TD.step(w.ws, { now: NOW }).problems.map((p) => p.code), ['INIT_REQUIRED']);
  noBook(w.ws);
});

test('an anchor that does not read refuses, and refuses before any write', (t) => {
  const { ws } = online(t);
  for (const bad of ['NEW', 'yes', 'ABCDEF', 'a'.repeat(63), 'A'.repeat(64)]) {
    env(t, { [VAR]: bad });
    assert.equal(TR.bookAnchorOf(ws).state, 'invalid', bad);
    refused(() => TD.view(ws, { now: NOW }), /neither "new" nor/);
    refused(() => TD.step(ws, { now: NOW }), /neither "new" nor/);
    assert.deepEqual(TD.applyHours(ws, [], { now: NOW }).map((r) => r.code), ['INTEGRITY']);
    noBook(ws);
  }
  env(t, { [VAR]: `  ${'b'.repeat(64)}\n` });
  assert.equal(TR.bookAnchorOf(ws).state, 'established', 'spaces around a pasted value');
  assert.equal(TR.bookAnchorOf(ws).may_initialize, false, 'an established book never starts again');
});

test('on the PC with no anchor nothing changes: a workspace funds from its settings', (t) => {
  const w = tempWorkspace('pc');
  t.after(w.cleanup);
  w.ws.settings.trader = { rules: {}, book: { ...BOOK } };
  env(t, { [VAR]: null, CR_DATA_DIR: null });
  assert.equal(TR.bookAnchorOf(w.ws).state, 'unset');
  assert.deepEqual(TD.step(w.ws, { now: NOW }).done.map((d) => d.kind), ['fund']);
});

test('the limit, stated: while the anchor still says "new", losing the book and its log reads as new again', (t) => {
  const { ws } = online(t);
  env(t, { [VAR]: 'new' });
  TD.step(ws, { now: FUNDED_AT });
  fs.rmSync(ws.abs(PT.JOURNAL));
  fs.rmSync(ws.abs(PT.HEAD));
  refused(() => TD.view(ws, { now: NOW }));
  fs.rmSync(ws.abs(OPLOG_REL), { force: true });
  assert.equal(TD.view(ws, { now: NOW }).results.funded_usd, null, 'so "new" is replaced by the hash at once');
});
