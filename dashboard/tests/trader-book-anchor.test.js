'use strict';
// The book-identity anchor: Eric's record of which book a desk holds, kept off the
// disk the book, the operation log and the settings share. With all of them gone an
// anchored desk refuses. Nothing routine starts a book, on any desk: a first funding
// is Eric's own command. Temporary workspaces and fictional projects, pairs and hours
// only. The network is stubbed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const T = require('../core/tickets');
const TD = require('../core/trader-desk');
const PT = require('../core/paper-trader');
const TR = require('../core/trader-rules');
const B = require('../core/brief-daily');
const J = require('../core/jobs');
const X = require('../core/exporter');
const { OPLOG_REL, withLock } = require('../core/ops');
const { atomicWrite, jsonText } = require('../core/fsx');
const { initWorkspace, openWorkspace, DEFAULT_ROOT } = require('../core/workspace');
const { tempWorkspace, hashTree } = require('./helpers');
const { H, M, iso, deskWith, settle, bar, mine } = require('./trader-fixture');

const VAR = TR.BOOK_ANCHOR_ENV;
const AT = Date.parse('2026-10-05T00:00:00Z');
const NOW = iso(AT);
const BOOK = { cash_usd: '1000', fee_rate: '0.003' };
const CODE = path.join(__dirname, '..');

function env(t, vars) {
  for (const [k, v] of Object.entries(vars)) {
    const before = process.env[k];
    if (v === null) delete process.env[k]; else process.env[k] = v;
    t.after(() => { if (before === undefined) delete process.env[k]; else process.env[k] = before; });
  }
}
function stub(t, obj, name, fn) {
  const real = obj[name];
  obj[name] = fn(real);
  const restore = () => { obj[name] = real; };
  t.after(restore);
  return restore;
}
function quietNet(t) {
  stub(t, global, 'fetch', () => async () => ({ ok: false, status: 429, headers: { get: () => null }, text: async () => '', json: async () => ({}) }));
}
function online(t, label = 'anchor') {
  env(t, { [VAR]: null, CR_DATA_DIR: null });
  const w = tempWorkspace(label);
  t.after(w.cleanup);
  w.ws.hosted = true;
  w.ws.settings.trader = { rules: {}, book: { ...BOOK } };
  return w;
}
const started = (ws, cash = '1000') => TD.bootstrapBook(ws, { cash_usd: cash, confirm: TD.bootstrapWords(cash), now: '2026-10-01T00:00:00.000Z' });
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
// A second sound book, to put in the first one's place.
function otherBook(t) {
  const o = tempWorkspace('other-book');
  t.after(o.cleanup);
  PT.fund(o.ws, { cash_usd: '1000', now: '2026-10-02T00:00:00.000Z' });
  return { journal: fs.readFileSync(o.ws.abs(PT.JOURNAL)), head: fs.readFileSync(o.ws.abs(PT.HEAD)) };
}
const putBook = (ws, b) => { fs.writeFileSync(ws.abs(PT.JOURNAL), b.journal); fs.writeFileSync(ws.abs(PT.HEAD), b.head); };

// A real history on a desk: funded, an order from Eric's grant, a fill, a position.
// It starts on the fictional workspace's own exemption, then becomes an online desk.
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
  return { ...s, decision, at, top, fillHour };
}

// --- Refusal

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
  const { ws, pid, rid } = deskWith(t);
  ws.hosted = true;
  settle(ws);
  started(ws, '25000');
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
  started(ws);
  const anchor = genesis(ws);
  const other = otherBook(t);
  env(t, { [VAR]: anchor });
  putBook(ws, other);
  const before = hashTree(root);
  refused(() => TD.view(ws, { now: NOW }), /not the established book/);
  refused(() => TD.step(ws, { now: NOW }), /not the established book/);
  assert.deepEqual(TD.applyHours(ws, [], { now: NOW }).map((r) => r.code), ['INTEGRITY']);
  assert.deepEqual(hashTree(root), before, 'nothing written');
  fs.rmSync(ws.abs(PT.JOURNAL));
  refused(() => TD.view(ws, { now: NOW }));
});

test('only the first line counts, however long it is, and an empty journal is no book', (t) => {
  const { ws } = online(t);
  fs.mkdirSync(ws.abs('paper/trader'), { recursive: true });
  const long = `{"fictional":"${'é'.repeat(5000)}"}`;
  fs.writeFileSync(ws.abs(PT.JOURNAL), `${long}\nanother line\n`);
  env(t, { [VAR]: TR.genesisOf(long) });
  assert.throws(() => TD.view(ws, { now: NOW }), (e) => !/not the established book|lost, not new/.test(e.message), 'the anchor holds; the book keeps its own refusal');
  env(t, { [VAR]: TR.genesisOf(long.slice(0, 2000)) });
  refused(() => TD.view(ws, { now: NOW }), /not the established book/);
  fs.writeFileSync(ws.abs(PT.JOURNAL), '');
  refused(() => TD.view(ws, { now: NOW }));
});

test('an anchor that does not read refuses, "new" among them: it is no permission', (t) => {
  const { ws } = online(t);
  for (const bad of ['new', 'NEW', 'yes', 'ABCDEF', 'a'.repeat(63), 'A'.repeat(64)]) {
    env(t, { [VAR]: bad });
    assert.equal(TR.bookAnchorOf(ws).state, 'invalid', bad);
    assert.equal(TR.bookAnchorOf(ws).may_auto_fund, false, bad);
    refused(() => TD.view(ws, { now: NOW }), /is not a book's hash/);
    refused(() => TD.step(ws, { now: NOW }), /is not a book's hash/);
    assert.deepEqual(TD.applyHours(ws, [], { now: NOW }).map((r) => r.code), ['INTEGRITY']);
    assert.throws(() => started(ws), (e) => e.code === 'INTEGRITY', 'and it does not start a book');
    noBook(ws);
  }
  env(t, { [VAR]: `  ${'b'.repeat(64)}\n` });
  assert.equal(TR.bookAnchorOf(ws).state, 'established', 'spaces around a pasted value');
  assert.equal(TR.bookAnchorOf(ws).may_auto_fund, false, 'an established book never starts again');
});

// --- Starting a book

test('after a first funding, with journal, head and log lost and the anchor unset or stale at "new", no routine path funds', async (t) => {
  quietNet(t);
  for (const value of [null, 'new']) {
    env(t, { [VAR]: null, CR_DATA_DIR: null });
    const { ws, pid, rid } = deskWith(t);
    ws.hosted = true;
    settle(ws);
    assert.equal(started(ws, '25000').status, 'saved');
    env(t, { [VAR]: value });
    loseBookAndLog(ws);
    const top = Math.floor(Date.now() / H) * H;
    if (value === null) {
      assert.deepEqual(TD.step(ws).done, []);
      assert.deepEqual(TD.applyHours(ws, [bar(top - H)], { now: iso(top + H) }).map((r) => r.code), ['INIT_REQUIRED']);
    } else {
      refused(() => TD.step(ws), /is not a book's hash/);
      assert.deepEqual(TD.applyHours(ws, [bar(top - H)], { now: iso(top + H) }).map((r) => r.code), ['INTEGRITY']);
    }
    await J.runJobs(ws, ['trader'], { trigger: 'dashboard', onlyDue: true });
    noBook(ws);
    T.decide(ws, pid, { receipt_id: rid, action: 'approve', request_id: `req_anchor_app_${value || 'unset'}` });
    await J.runJobs(ws, ['trader'], { trigger: 'dashboard', onlyDue: true });
    noBook(ws);
  }
});

test('a missing setting is no permission: only a fictional workspace, named so on its marker, off any online desk, funds by itself', (t) => {
  env(t, { [VAR]: null, CR_DATA_DIR: null });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-kinds-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const templatesFrom = path.join(DEFAULT_ROOT, 'templates');
  const real = path.join(dir, 'real');
  initWorkspace(real, { kind: 'real', name: 'a PC workspace (FICTIONAL)', templatesFrom });
  const unnamed = path.join(dir, 'unnamed');
  initWorkspace(unnamed, { kind: 'real', name: 'no kind (FICTIONAL)', templatesFrom });
  const marker = fs.readdirSync(unnamed).find((f) => /workspace/i.test(f) && f.endsWith('.json'));
  const m = JSON.parse(fs.readFileSync(path.join(unnamed, marker), 'utf8'));
  delete m.kind;
  fs.writeFileSync(path.join(unnamed, marker), JSON.stringify(m));
  for (const root of [real, unnamed]) {
    const ws = openWorkspace({ root, actor: 'test' });
    ws.settings.trader = { rules: {}, book: { ...BOOK } };
    assert.equal(TR.bookAnchorOf(ws).may_auto_fund, false, root);
    assert.deepEqual(TD.step(ws, { now: NOW }).problems.map((p) => p.code), ['INIT_REQUIRED']);
    assert.deepEqual(TD.applyHours(ws, [bar(AT - 2 * H)], { now: NOW }).map((r) => r.code), ['INIT_REQUIRED']);
    noBook(ws);
  }
  // The exemption needs every part of its name.
  const w = tempWorkspace('exempt');
  t.after(w.cleanup);
  w.ws.settings.trader = { rules: {}, book: { ...BOOK } };
  assert.equal(TR.bookAnchorOf(w.ws).may_auto_fund, true, 'a test workspace');
  assert.equal(TR.bookAnchorOf({ ...w.ws, hosted: true }).may_auto_fund, false, 'not hosted');
  assert.equal(TR.bookAnchorOf(w.ws, { CR_DATA_DIR: '/fictional/data' }).may_auto_fund, false, 'not on a data disk');
  assert.equal(TR.bookAnchorOf(w.ws, { [VAR]: 'c'.repeat(64) }).may_auto_fund, false, 'not under an anchor');
  assert.equal(TR.bookAnchorOf(null).may_auto_fund, false, 'not without a workspace');
  assert.deepEqual(TD.step(w.ws, { now: NOW }).done.map((d) => d.kind), ['fund']);
});

test('an online desk with no anchor: a funded book operates; a lost one is not funded, no order goes, and the view says so', (t) => {
  const { ws, at, top } = history(t);
  assert.equal(TD.view(ws, { now: iso(at) }).results.funded_usd, '25000', 'a funded book reads without an anchor');
  loseBookAndLog(ws);
  const v = TD.view(ws, { now: iso(at) });
  assert.equal(v.results.funded_usd, null);
  assert.ok(v.waits.some((w) => w.includes('trader bootstrap')));
  const s = TD.step(ws, { now: iso(at) });
  assert.deepEqual(s.done, []);
  assert.ok(s.problems.some((p) => p.code === 'INIT_REQUIRED'));
  assert.deepEqual(TD.applyHours(ws, [bar(top)], { now: iso(at) }).map((r) => r.code), ['INIT_REQUIRED']);
  noBook(ws);
});

test('Eric\'s command starts a new book once, in words, and gives the hash; then the hash takes over', (t) => {
  const { ws } = online(t);
  const w = TD.view(ws, { now: NOW });
  assert.equal(w.results.funded_usd, null);
  assert.deepEqual(w.book_identity, { anchor: 'unset', genesis_sha256: null });
  assert.throws(() => TD.bootstrapBook(ws, { cash_usd: '1000', confirm: 'yes' }), (e) => e.code === 'INVALID');
  assert.throws(() => TD.bootstrapBook(ws, { cash_usd: '1000' }), (e) => e.code === 'INVALID');
  assert.throws(() => TD.bootstrapBook(ws, {}), (e) => e.code === 'INVALID');
  assert.throws(() => TD.bootstrapBook(ws, { cash_usd: '2000', confirm: TD.bootstrapWords('2000') }), (e) => e.code === 'INVALID', 'not the settings');
  noBook(ws);
  const r = started(ws);
  assert.equal(r.status, 'saved');
  assert.equal(r.genesis_sha256, genesis(ws));
  assert.throws(() => started(ws), (e) => e.code === 'INIT_REFUSED', 'once');
  assert.equal(fs.readFileSync(ws.abs(PT.JOURNAL), 'utf8').split('\n').filter(Boolean).length, 1);
  assert.deepEqual(TD.step(ws, { now: NOW }).done, [], 'nothing to fund');
  assert.deepEqual(TD.view(ws, { now: NOW }).book_identity, { anchor: 'unset', genesis_sha256: r.genesis_sha256 });
  env(t, { [VAR]: r.genesis_sha256 });
  assert.deepEqual(TD.view(ws, { now: NOW }).book_identity, { anchor: 'established', genesis_sha256: r.genesis_sha256 });
  assert.equal(TD.view(ws, { now: NOW }).results.funded_usd, '1000');
});

test('the command refuses when anything remembers a book: the anchor, a file, the log', (t) => {
  const a = online(t, 'cmd-anchor');
  env(t, { [VAR]: 'd'.repeat(64) });
  assert.throws(() => started(a.ws), (e) => e.code === 'INTEGRITY', 'the anchor names a book that is not here');
  noBook(a.ws);
  env(t, { [VAR]: null });
  started(a.ws);
  env(t, { [VAR]: genesis(a.ws) });
  assert.throws(() => started(a.ws), (e) => e.code === 'INIT_REFUSED', 'the anchor names this book');
  env(t, { [VAR]: null });
  const b = online(t, 'cmd-head');
  started(b.ws);
  fs.rmSync(b.ws.abs(PT.JOURNAL));
  assert.throws(() => started(b.ws), (e) => e.code === 'INIT_REFUSED', 'a head alone');
  noBook(b.ws);
  const c = online(t, 'cmd-log');
  started(c.ws);
  fs.rmSync(c.ws.abs('paper/trader'), { recursive: true });
  assert.throws(() => started(c.ws), (e) => e.code === 'INTEGRITY' && /lost, not new/.test(e.message), 'the log remembers it');
  noBook(c.ws);
});

test('nothing routine can reach the command: it is called from the command line alone', () => {
  const callers = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!['tests', 'node_modules', 'public', 'fixtures'].includes(e.name)) walk(p); } else if (e.name.endsWith('.js') && fs.readFileSync(p, 'utf8').includes('bootstrapBook(')) callers.push(path.relative(CODE, p).split(path.sep).join('/'));
    }
  };
  walk(CODE);
  assert.deepEqual(callers.sort(), ['cli.js', 'core/trader-desk.js']);
});

test('the command line: wrong words refuse, right words fund once and print the hash', (t) => {
  env(t, { [VAR]: null, CR_DATA_DIR: null });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  initWorkspace(dir, { kind: 'real', name: 'CLI bootstrap (FICTIONAL)', templatesFrom: path.join(DEFAULT_ROOT, 'templates') });
  const file = path.join(dir, 'config', 'settings.json');
  atomicWrite(file, jsonText({ ...JSON.parse(fs.readFileSync(file, 'utf8')), trader: { rules: {}, book: { ...BOOK } } }));
  const run = (...args) => spawnSync(process.execPath, [path.join(CODE, 'cli.js'), 'trader', 'bootstrap', '--workspace', dir, ...args], { encoding: 'utf8', timeout: 60000 });
  const wrong = run('--cash-usd', '1000', '--confirm', 'yes');
  assert.notEqual(wrong.status, 0);
  assert.match(`${wrong.stdout}${wrong.stderr}`, /FUND NEW PAPER BOOK 1000/);
  assert.equal(fs.existsSync(path.join(dir, PT.JOURNAL)), false);
  const right = run('--cash-usd', '1000', '--confirm', 'FUND NEW PAPER BOOK 1000');
  assert.equal(right.status, 0, right.stderr);
  const hash = TR.genesisOf(fs.readFileSync(path.join(dir, PT.JOURNAL), 'utf8').split('\n')[0]);
  assert.ok(right.stdout.includes(hash), 'the hash, to set as the anchor');
  assert.notEqual(run('--cash-usd', '1000', '--confirm', 'FUND NEW PAPER BOOK 1000').status, 0, 'once');
});

// --- The exact book a read or a write used

test('every write of the book in the desk goes through the anchor under the lock, by construction', () => {
  const src = fs.readFileSync(path.join(CODE, 'core', 'trader-desk.js'), 'utf8').split('\n');
  const writes = src.filter((l) => /\bPT\.(fund|recover|reconcile|cancelOrder|submitIntent|applyBar|reserveIntent|markSent|venueSend|recordAnswer)\(/.test(l));
  const direct = writes.filter((l) => !/underAnchor\(ws, \(\) => PT\./.test(l));
  assert.equal(direct.length, 1, direct.join('\n'));
  assert.match(direct[0], /const f = PT\.fund\(ws, \{ cash_usd, now: n\.now \}\);/, 'the one other is the command, inside its own lock');
  assert.equal(writes.length, 8);
});

test('a write sees the lock held and the anchor checked; another operation cannot come between', (t) => {
  const { ws, root, at, top, fillHour } = history(t);
  env(t, { [VAR]: genesis(ws) });
  const second = openWorkspace({ root, actor: 'other' });
  let calls = 0;
  stub(t, PT, 'applyBar', (real) => (...a) => {
    calls += 1;
    assert.equal(ws._lockHeld, true, 'under the lock');
    assert.throws(() => withLock(second, 'contender', () => { throw new Error('it got in'); }, { timeoutMs: 40 }), (e) => e.code === 'WORKSPACE_BUSY');
    return real(...a);
  });
  const h = fillHour + H;
  assert.equal(TD.applyHours(ws, [bar(h)], { now: iso(h + H + M) })[0].status !== 'refused', true);
  assert.equal(calls, 1);
  assert.ok(top && at);
});

test('the book replaced between the read and the write: refused, nothing sent, the book in its place untouched', (t) => {
  env(t, { [VAR]: null, CR_DATA_DIR: null });
  const { ws, pid, rid } = deskWith(t);
  T.decide(ws, pid, { receipt_id: rid, action: 'approve', request_id: 'req_anchor_race1' });
  settle(ws);
  const top = Math.floor(Date.now() / H) * H;
  TD.applyHours(ws, Array.from({ length: 16 }, (_, i) => bar(top - (16 - i) * H)), { now: iso(Date.now()) });
  ws.hosted = true;
  env(t, { [VAR]: genesis(ws) });
  const other = otherBook(t);
  ws.hosted = true;
  let swapped = false;
  // The engine's book for the request is the last read before the write.
  stub(t, PT, 'book', (real) => (...a) => { const v = real(...a); if (!swapped) { swapped = true; putBook(ws, other); } return v; });
  let sent = 0;
  stub(t, PT, 'submitIntent', (real) => (...a) => { sent += 1; return real(...a); });
  let out = null;
  let thrown = null;
  try { out = TD.step(ws); } catch (err) { thrown = err; }
  assert.equal(swapped, true, 'the swap happened');
  assert.equal(sent, 0, 'no order reached the engine');
  assert.ok((thrown && thrown.code === 'INTEGRITY') || out.problems.some((p) => p.code === 'INTEGRITY'), 'refused');
  assert.ok(fs.readFileSync(ws.abs(PT.JOURNAL)).equals(other.journal), 'nothing written to it');
});

test('the book replaced during any read, at either end of it: refused, never shown as the anchored book', (t) => {
  // The snapshot's last read, on a book with a position.
  for (const read of ['view', 'requests', 'wanted', 'pending']) {
    const { ws, at } = history(t);
    env(t, { [VAR]: genesis(ws) });
    const other = otherBook(t);
    ws.hosted = true;
    let once = false;
    const restore = stub(t, PT, 'hours', (real) => (...a) => { const v = real(...a); if (!once) { once = true; putBook(ws, other); } return v; });
    refused(() => TD[read](ws, { now: iso(at) }), /not the established book/);
    assert.equal(once, true, `${read}: the swap happened`);
    restore();
  }
  // The engine's book for a waiting request, after the snapshot.
  for (const read of ['view', 'requests', 'pending']) {
    env(t, { [VAR]: null, CR_DATA_DIR: null });
    const { ws, pid, rid } = deskWith(t);
    T.decide(ws, pid, { receipt_id: rid, action: 'approve', request_id: `req_anchor_read_${read}` });
    settle(ws);
    const top = Math.floor(Date.now() / H) * H;
    TD.applyHours(ws, Array.from({ length: 16 }, (_, i) => bar(top - (16 - i) * H)), { now: iso(Date.now()) });
    ws.hosted = true;
    env(t, { [VAR]: genesis(ws) });
    const other = otherBook(t);
    ws.hosted = true;
    let once = false;
    const restore = stub(t, PT, 'book', (real) => (...a) => { const v = real(...a); if (!once) { once = true; putBook(ws, other); } return v; });
    refused(() => TD[read](ws), /not the established book/);
    assert.equal(once, true, `${read}: the swap happened`);
    restore();
  }
});

test('a step whose reads saw the book replaced does not answer as though it held: refused, nothing written', (t) => {
  env(t, { [VAR]: null, CR_DATA_DIR: null });
  const { ws, pid, rid } = deskWith(t);
  T.decide(ws, pid, { receipt_id: rid, action: 'approve', request_id: 'req_anchor_race2' });
  settle(ws);
  const top = Math.floor(Date.now() / H) * H;
  TD.applyHours(ws, Array.from({ length: 16 }, (_, i) => bar(top - (16 - i) * H)), { now: iso(Date.now()) });
  ws.hosted = true;
  env(t, { [VAR]: genesis(ws) });
  const other = otherBook(t);
  ws.hosted = true;
  // The rules are read after the snapshot; the engine then reads the other book.
  stub(t, TR, 'rulesOf', (real) => (...a) => { putBook(ws, other); return real(...a); });
  refused(() => TD.step(ws), /not the established book/);
  assert.ok(fs.readFileSync(ws.abs(PT.JOURNAL)).equals(other.journal), 'nothing written to it');
});

test('a commit during a read reads again and gives the book as it stands, never a mix', (t) => {
  const { ws, at, fillHour } = history(t);
  env(t, { [VAR]: genesis(ws) });
  const h = fillHour + H;
  const later = iso(h + H + M);
  let reads = 0;
  const restore = stub(t, PT, 'results', (real) => (...a) => {
    reads += 1;
    const v = real(...a);
    if (reads === 1) PT.applyBar(ws, bar(h), { now: later });
    return v;
  });
  const v = TD.view(ws, { now: later });
  assert.ok(reads >= 2, 'read again');
  restore();
  assert.deepEqual(v, TD.view(ws, { now: later }));
  assert.ok(at);
});

test('a book that will not hold still refuses in words', (t) => {
  const { ws, at } = history(t);
  env(t, { [VAR]: genesis(ws) });
  const text = fs.readFileSync(ws.abs(PT.JOURNAL));
  stub(t, PT, 'results', (real) => (...a) => {
    const v = real(...a);
    fs.rmSync(ws.abs(PT.JOURNAL));
    fs.writeFileSync(ws.abs(PT.JOURNAL), text);
    return v;
  });
  refused(() => TD.view(ws, { now: iso(at) }), /kept changing/);
});

test('the execution read checks the exact bytes it uses', (t) => {
  const { ws } = history(t);
  env(t, { [VAR]: genesis(ws) });
  const other = otherBook(t);
  ws.hosted = true;
  const good = fs.readFileSync(ws.abs(PT.JOURNAL));
  // The file is the anchored book when any fresh look is taken at the first line, and
  // the bytes in use are another's: only a check of those bytes can see it.
  const realRead = fs.readFileSync;
  stub(t, fs, 'readFileSync', () => function read(p, ...a) {
    if (/paper[\\/]trader[\\/]journal\.jsonl$/.test(String(p))) return other.journal;
    return realRead.call(this, p, ...a);
  });
  refused(() => TD.executionFor(ws, 'td_fictional'), /not the established book/);
  assert.ok(good.length);
});

// --- Ordinary operation, recovery, and the stated limit

test('ordinary operation: an anchored book reads, steps and takes hours as before, and losing only the log does not matter', (t) => {
  const { ws, at, decision, fillHour } = history(t);
  env(t, { [VAR]: genesis(ws) });
  const v = TD.view(ws, { now: iso(at) });
  assert.equal(v.results.open_positions.length, 1);
  assert.deepEqual(v.book_identity, { anchor: 'established', genesis_sha256: genesis(ws) });
  assert.equal(v.waits.some((w) => w.includes(VAR)), false);
  const lines = fs.readFileSync(ws.abs(PT.JOURNAL), 'utf8');
  assert.deepEqual(TD.step(ws, { now: iso(at) }).problems, []);
  const h = fillHour + H;
  const later = iso(h + H + M);
  assert.notEqual(TD.applyHours(ws, [bar(h)], { now: later })[0].status, 'refused');
  assert.ok(fs.readFileSync(ws.abs(PT.JOURNAL), 'utf8').length > lines.length, 'the hour went in');
  assert.ok(fs.readFileSync(ws.abs(PT.JOURNAL), 'utf8').startsWith(lines), 'the book only grows');
  assert.equal(mine(TD.requests(ws, { now: later }), decision.decision_id).phase, 'open', 'the same order, not a new one');
  fs.rmSync(ws.abs(OPLOG_REL), { force: true });
  assert.equal(TD.view(ws, { now: later }).results.open_positions.length, 1);
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
  // Eric's restore: the book's files and the log back from the checked copy, the journal
  // last, because it is what lifts the refusal.
  fs.mkdirSync(path.dirname(ws.abs(PT.JOURNAL)), { recursive: true });
  for (const rel of [OPLOG_REL, PT.VENUE, PT.HEAD]) {
    fs.copyFileSync(path.join(target, rel), ws.abs(rel));
    refused(() => TD.view(ws, { now: iso(at) }));
  }
  fs.copyFileSync(path.join(target, PT.JOURNAL), ws.abs(PT.JOURNAL));
  const after = TD.view(ws, { now: iso(at) });
  assert.deepEqual(after.results, before.results, 'the same results');
  assert.equal(after.results.open_positions.length, 1);
  const s = TD.step(ws, { now: iso(at) });
  assert.deepEqual(s.done.filter((d) => d.kind === 'fund' || d.kind === 'open'), [], 'no funding, no order again');
  assert.ok(fs.readFileSync(ws.abs(PT.JOURNAL), 'utf8').startsWith(lines), 'the journal continues the one restored');
  assert.deepEqual(PT.intents(ws).map((i) => i.intent_id).sort(), intentsBefore, 'the same orders');
});

test('the limit, stated: this names the book, not its progress, so an older copy of the same book passes', (t) => {
  const { ws, pid, rid } = (() => { env(t, { [VAR]: null, CR_DATA_DIR: null }); return deskWith(t); })();
  ws.hosted = true;
  settle(ws);
  started(ws, '25000');
  const anchor = genesis(ws);
  const older = { journal: fs.readFileSync(ws.abs(PT.JOURNAL)), head: fs.readFileSync(ws.abs(PT.HEAD)) };
  env(t, { [VAR]: anchor });
  const top = Math.floor(Date.now() / H) * H;
  TD.applyHours(ws, Array.from({ length: 16 }, (_, i) => bar(top - (16 - i) * H)), { now: iso(Date.now()) });
  const decision = T.decide(ws, pid, { receipt_id: rid, action: 'approve', request_id: 'req_anchor_limit1' }).result.decision;
  TD.step(ws);
  const intent = TD.intentIdOf(decision, 'open');
  assert.ok(PT.intents(ws).some((i) => i.intent_id === intent));
  putBook(ws, older);
  fs.rmSync(ws.abs(PT.VENUE), { force: true });
  assert.equal(TD.view(ws).book_identity.anchor, 'established', 'the anchor passes');
  assert.equal(PT.intents(ws).some((i) => i.intent_id === intent), false, 'the order is gone from the older copy');
});
