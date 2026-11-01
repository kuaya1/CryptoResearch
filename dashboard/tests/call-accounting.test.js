'use strict';
// Fail-closed provider meters (core/call-accounting.js; bounded paper
// readiness A2). One matrix of stored states (tests/meter-cases.js) is run
// through every affected reader and its outbound boundary: CoinGecko
// (market.js, cycle.js, intake.js), GoPlus (screening.js), the exit-quote
// monitor (forensic-monitor.js) and, in trader-candles.test.js, GeckoTerminal's
// candles. An unusable count holds admission, refuses the reservation, sends
// nothing and leaves the stored bytes as they were; a legitimate one (never
// run, legacy, rolled over, current) still reads and counts. Temporary
// FICTIONAL workspaces, fixed clocks and spies only: nothing leaves the test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { tempWorkspace, addFixtureProject } = require('./helpers');
const A = require('../core/call-accounting');
const market = require('../core/market');
const screening = require('../core/screening');
const FM = require('../core/forensic-monitor');
const F = require('../core/forensics');
const C = require('../core/trader-candles');
const LA = require('../core/lead-admission');
const projects = require('../core/projects');
const FX = require('./forensic-fixtures');
const MC = require('./meter-cases');
const { readJson, atomicWrite, jsonText } = require('../core/fsx');

// Mid-afternoon in New York on a fixed day, so "today", "ended" and "after
// today" are the same at any outer clock.
const NOW = Date.parse('2027-01-15T15:20:00Z');

const METERS = {
  coingecko: {
    rel: market.STATUS_REL,
    reserve: (ws, now) => market.reserveCall(ws, now),
    hold: (ws, now) => market.accountingHold(ws, now),
    counts: (ws, now) => market.callBudget(ws, market.readStatus(ws), now),
  },
  goplus: {
    rel: screening.STATUS_REL,
    reserve: (ws, now) => screening.reserveRequest(ws, { ...screening.DEFAULTS, ...((ws.settings && ws.settings.screening) || {}) }, now),
    hold: (ws, now) => screening.accountingHold(ws, now),
    counts: (ws, now) => screening.callCounts(screening.readStatus(ws), now),
  },
  exit_quotes: {
    rel: FM.STATUS_REL,
    reserve: (ws, now) => FM.reserveRequest(ws, F.monitorCfg(ws), now),
    hold: (ws, now) => FM.accountingHold(ws, now),
    counts: (ws, now) => FM.callCounts(FM.readStatus(ws), now),
  },
  candles: {
    rel: C.STATUS_REL,
    reserve: (ws, now) => C.reserve(ws, now),
    hold: (ws, now) => C.accountingHold(ws, now),
    counts: (ws, now) => C.callCounts(C.readStatus(ws), now),
  },
};

function workspace(t, label, settings) {
  const w = tempWorkspace(label, settings);
  t.after(w.cleanup);
  // Nothing in these tests may reach the network.
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network access is not allowed in tests'); });
  return w;
}

// A fetch that counts and answers with `answer(url)` (default: refused).
function spy(answer = () => { throw new Error('refused (test)'); }) {
  const calls = [];
  const f = async (url, init) => { calls.push(String(url)); return answer(String(url), init, calls); };
  f.calls = calls;
  return f;
}
const reply = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => payload,
  text: async () => JSON.stringify(payload),
});
const meterHold = (ws, id, now) => LA.budgetHolds(ws, now).find((h) => h.meter === id);
// What the case's file reads as through call-accounting alone.
function classified(c) {
  if (c.absent) return A.classify('coingecko', () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); });
  return null;
}

// ---------------------------------------------------------------------------
// The validator alone

test('the validator: every case in the matrix is unknown, never zero; every legitimate state reads with its counts', () => {
  for (const id of Object.keys(A.METERS)) {
    for (const c of MC.invalidCases(id, NOW)) {
      const r = A.classify(id, () => {
        if (c.dir) throw Object.assign(new Error('is a directory'), { code: 'EISDIR' });
        return c.text;
      });
      const why = r.unknown || A.countsOf(id, r.status, NOW).unknown;
      assert.ok(why, `${id}: ${c.name} must be unknown`);
      assert.equal(r.absent, false, `${id}: ${c.name} is not a meter never run`);
      assert.match(A.words(id, why), /cannot be used: .+\. Nothing more is sent to .+ until it is inspected and repaired; the file is kept as it is\.$/);
    }
    for (const c of MC.validCases(id, NOW)) {
      const r = c.absent ? classified(c) : A.classify(id, () => c.text);
      assert.equal(r.unknown, null, `${id}: ${c.name} reads`);
      const k = A.countsOf(id, r.absent ? A.initial({ state: 'never_run' }) : r.status, NOW);
      assert.equal(k.unknown, undefined, `${id}: ${c.name}: ${k.unknown}`);
      assert.equal(k.month_count, c.month, `${id}: ${c.name} month`);
      assert.equal(k.day_count, c.day, `${id}: ${c.name} day`);
      assert.equal(k.day, MC.nyDay(NOW), `${id}: ${c.name} is read for New York's day`);
    }
  }
  // An in-memory default cannot be forged by a file: the marker is a symbol.
  assert.equal(JSON.stringify(A.initial({ state: 'never_run' })), '{"state":"never_run"}');
  assert.ok(A.countsOf('goplus', { state: 'never_run' }, NOW).unknown, 'a schema-less object read from disk is not "never run"');
  assert.ok(A.countsOf('goplus', A.initial({}), Number.NaN).unknown, 'no clock, no count');
});

// ---------------------------------------------------------------------------
// Readers, reservations and admission, against the stored file

test('every meter: an unusable count holds admission, refuses the reservation and keeps the file byte for byte; a legitimate one reads and counts', (t) => {
  const { ws } = workspace(t, 'meters');
  for (const [id, m] of Object.entries(METERS)) {
    for (const c of MC.invalidCases(id, NOW)) {
      MC.put(ws, m.rel, c);
      const before = MC.stored(ws, m.rel);
      const hold = m.hold(ws, NOW);
      assert.ok(typeof hold === 'string' && hold.includes('cannot be used'), `${id}: ${c.name} holds (${hold})`);
      assert.ok(m.counts(ws, NOW).unknown, `${id}: ${c.name}: counts are unknown`);
      const ah = meterHold(ws, id, NOW);
      assert.ok(ah && ah.code === 'unreadable', `${id}: ${c.name}: admission holds on this meter (${JSON.stringify(ah)})`);
      assert.equal(m.reserve(ws, NOW), false, `${id}: ${c.name}: nothing is reserved`);
      assert.equal(MC.stored(ws, m.rel), before, `${id}: ${c.name}: the file is kept as it is`);
    }
    for (const c of MC.validCases(id, NOW)) {
      MC.put(ws, m.rel, c);
      assert.equal(m.hold(ws, NOW), null, `${id}: ${c.name} reads`);
      const k = m.counts(ws, NOW);
      assert.deepEqual([k.month_count, k.day_count], [c.month, c.day], `${id}: ${c.name}`);
      assert.equal(meterHold(ws, id, NOW), undefined, `${id}: ${c.name}: no admission hold`);
      assert.equal(m.reserve(ws, NOW), true, `${id}: ${c.name}: reserved`);
      const after = m.counts(ws, NOW);
      assert.deepEqual([after.month_count, after.day_count], [c.month + 1, c.day + 1], `${id}: ${c.name}: one request counted`);
      // What the writer left passes the validator it is read with.
      const written = A.classify(id, () => fs.readFileSync(ws.abs(m.rel), 'utf8'));
      assert.equal(written.unknown, null, `${id}: ${c.name}: the writer's output reads`);
      assert.equal(written.status.schema_version, A.METERS[id].schema);
    }
    MC.put(ws, m.rel, { absent: true });
  }
});

test('the budgets still stop a valid meter at its cap, and a meter at 85% holds admission as headroom, not as unknown', (t) => {
  const { ws } = workspace(t, 'meters-cap', { market_data: { enabled: false, monthly_call_budget: 10 } });
  MC.put(ws, METERS.coingecko.rel, { text: `${JSON.stringify(MC.valid('coingecko', NOW, { month_count: 10, day_count: 2 }))}\n` });
  assert.equal(market.reserveCall(ws, NOW), false);
  assert.equal(market.accountingHold(ws, NOW), null, 'a used-up budget is not unknown accounting');
  assert.equal(meterHold(ws, 'coingecko', NOW).code, 'headroom');
  MC.put(ws, METERS.candles.rel, { text: `${JSON.stringify(MC.valid('candles', NOW, { month_count: C.DAILY_BUDGET, day_count: C.DAILY_BUDGET }))}\n` });
  assert.equal(C.reserve(ws, NOW), false);
  assert.equal(C.accountingHold(ws, NOW), null);
  assert.equal(meterHold(ws, 'candles', NOW).code, 'headroom');
});

// ---------------------------------------------------------------------------
// The outbound boundaries: zero requests while the count cannot be used

function marketDesk(t) {
  const w = workspace(t, 'meters-cg');
  addFixtureProject(w.ws);
  const s = readJson(path.join(w.root, 'config', 'settings.json'));
  s.market_data = { enabled: true };
  atomicWrite(path.join(w.root, 'config', 'settings.json'), jsonText(s));
  w.ws.reloadSettings();
  return w;
}

test('CoinGecko: search, prices, market context and intake send nothing while the count cannot be used; a valid count sends', async (t) => {
  const { ws } = marketDesk(t);
  const intake = require('../core/intake');
  const cycle = require('../core/cycle');
  // CoinGecko's senders read the real clock; the cases are built at it, two
  // days either side of today, so no midnight passes between.
  const now = Date.now();
  const f = spy((url) => (url.includes('/search') ? reply(200, { coins: [] }) : reply(500, {})));
  for (const c of MC.invalidCases('coingecko', now)) {
    MC.put(ws, market.STATUS_REL, c);
    const before = MC.stored(ws, market.STATUS_REL);
    const s = await market.searchCoins(ws, 'xmpl', { fetchImpl: f });
    assert.equal(s.status, 'held', `${c.name}: search held (${s.message})`);
    assert.equal(s.accounting_unknown, true);
    const p = await market.refresh(ws, { fetchImpl: f, force: true });
    assert.equal(p.status, 'held', `${c.name}: prices held (${p.message})`);
    assert.match(p.message, /^Prices not refreshed: CoinGecko's request count \(market-data\/status\.json\) cannot be used: /);
    const x = await cycle.refreshContext(ws, { fetchImpl: f, force: true });
    assert.equal(x.status, 'held', `${c.name}: market context held (${x.message})`);
    await assert.rejects(intake.cgGet(ws, '/search?query=xmpl', f), (err) => err.code === 'REFUSED' && /cannot be used/.test(err.message), `${c.name}: intake refused`);
    assert.equal(f.calls.length, 0, `${c.name}: nothing was sent`);
    assert.equal(MC.stored(ws, market.STATUS_REL), before, `${c.name}: the file is kept as it is`);
  }
  // The same desk with a valid count does send: the matrix above held for its count alone.
  MC.put(ws, market.STATUS_REL, { text: `${JSON.stringify(MC.valid('coingecko', now))}\n` });
  const ok = await market.searchCoins(ws, 'xmpl', { fetchImpl: f });
  assert.equal(ok.status, 'none', ok.message);
  assert.equal(f.calls.length, 1);
  const written = A.classify('coingecko', () => fs.readFileSync(ws.abs(market.STATUS_REL), 'utf8'));
  assert.equal(written.unknown, null);
  assert.deepEqual([written.status.calls.month_count, written.status.calls.month_answered], [4, 4]);
});

test('CoinGecko: a count that goes bad while a request is out is kept as it is, and nothing more is sent', async (t) => {
  const { ws } = marketDesk(t);
  const bad = '{"schema_version": "cr.market-status.v2", "calls": "edited by hand"}\n';
  const f = spy(() => { fs.writeFileSync(ws.abs(market.STATUS_REL), bad); return reply(200, { coins: [] }); });
  await market.searchCoins(ws, 'xmpl', { fetchImpl: f });
  assert.equal(fs.readFileSync(ws.abs(market.STATUS_REL), 'utf8'), bad, 'finalizing the answer did not overwrite it');
  const again = await market.searchCoins(ws, 'xmpl', { fetchImpl: f });
  assert.equal(again.status, 'held');
  assert.equal(f.calls.length, 1);
  assert.equal(fs.readFileSync(ws.abs(market.STATUS_REL), 'utf8'), bad);
});

const EVM_A = '0x00000000000000000000000000000000000fc001';
function goplusDesk(t) {
  const w = workspace(t, 'meters-gp');
  const out = projects.addProject(w.ws, {
    name: 'Example Token (FICTIONAL)', symbol: 'XTKN', official_website: 'https://xtkn.example/', coingecko_id: 'xtkn-fictional',
    assets: [{ chain: 'ethereum', contract_address: EVM_A }], evidence: [{ url: 'https://xtkn.example/docs', note: 'fictional test evidence' }], sector: 'defi',
  });
  assert.equal(out.status, 'created', out.message);
  return w;
}
const CLEAN = { is_mintable: '0', is_proxy: '0', is_blacklisted: '0', is_honeypot: '0', buy_tax: '0', sell_tax: '0', is_open_source: '1' };
const goplusAnswer = () => reply(200, { code: 1, message: 'OK', result: { [EVM_A]: CLEAN } });
const turn = () => ({ take: () => true, remaining: () => 60000, signalFor: (ms) => AbortSignal.timeout(ms), readBody: (res) => res.text(), canWait: () => true });

test('GoPlus: the scheduled screen and a lead\'s screen send nothing while the count cannot be used; a valid count sends', async (t) => {
  const { ws } = goplusDesk(t);
  const f = spy(goplusAnswer);
  for (const c of MC.invalidCases('goplus', NOW)) {
    MC.put(ws, screening.STATUS_REL, c);
    const before = MC.stored(ws, screening.STATUS_REL);
    const r = await screening.refresh(ws, { fetchImpl: f, now: NOW, force: true, retryDelayMs: 0, pauseMs: 0 });
    assert.equal(r.status, 'held', `${c.name}: ${r.message}`);
    assert.equal(r.accounting_unknown, true);
    assert.match(r.message, /^Contracts not screened: GoPlus's request count \(market-data\/screening\/status\.json\) cannot be used: /);
    const one = await screening.screenAddress(ws, 'ethereum', EVM_A, { turn: turn(), fetchImpl: f, now: NOW, retryDelayMs: 0 });
    assert.equal(one.kind, 'blocked', `${c.name}: a lead's screen is blocked`);
    assert.equal(f.calls.length, 0, `${c.name}: nothing was sent`);
    assert.equal(MC.stored(ws, screening.STATUS_REL), before, `${c.name}: the file is kept as it is`);
    assert.ok(screening.overview(ws, NOW).accounting_unknown, `${c.name}: the overview says so`);
  }
  MC.put(ws, screening.STATUS_REL, { text: `${JSON.stringify(MC.valid('goplus', NOW))}\n` });
  const ok = await screening.refresh(ws, { fetchImpl: f, now: NOW, force: true, retryDelayMs: 0, pauseMs: 0 });
  assert.equal(ok.status, 'ok', ok.message);
  assert.equal(f.calls.length, 1);
  const written = A.classify('goplus', () => fs.readFileSync(ws.abs(screening.STATUS_REL), 'utf8'));
  assert.equal(written.unknown, null);
  assert.deepEqual([written.status.calls.month_count, written.status.calls.month_answered], [4, 4]);
});

test('GoPlus: a count that goes bad while a request is out is kept as it is; the run ends held and sends nothing more', async (t) => {
  const { ws } = goplusDesk(t);
  const bad = '{"schema_version": "cr.screening-status.v1", "calls": {"month": "2027-01", "month_count": -4}}\n';
  const f = spy(() => { fs.writeFileSync(ws.abs(screening.STATUS_REL), bad); return goplusAnswer(); });
  const r = await screening.refresh(ws, { fetchImpl: f, now: NOW, force: true, retryDelayMs: 0, pauseMs: 0 });
  assert.equal(r.status, 'held', r.message);
  assert.equal(fs.readFileSync(ws.abs(screening.STATUS_REL), 'utf8'), bad, 'finalizing the run did not overwrite it');
  assert.equal((await screening.refresh(ws, { fetchImpl: f, now: NOW, force: true, retryDelayMs: 0, pauseMs: 0 })).status, 'held');
  assert.equal(f.calls.length, 1);
  assert.equal(fs.readFileSync(ws.abs(screening.STATUS_REL), 'utf8'), bad);
});

// A monitored project: one approved product check and one repository read.
function monitoredDesk(t) {
  const w = workspace(t, 'meters-fm');
  const pid = addFixtureProject(w.ws).project_id;
  const a = F.createAudit(w.ws, { project_id: pid, assistant: 'claude' });
  const s = F.saveReport(w.ws, { project_id: pid, audit_id: a.audit_id, provider: 'claude', text: FX.reportText(a.audit) });
  F.setMonitoring(w.ws, pid, { approve: { receipt_id: s.receipt_id }, enabled: true });
  return { ...w, pid };
}
const publicLookup = (host, opts, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]);
function transportSpy(onCall = () => {}) {
  const calls = [];
  const f = async (url, { lookup }) => {
    await new Promise((resolve, reject) => lookup(url.hostname, {}, (err) => (err ? reject(err) : resolve())));
    calls.push(url.toString());
    onCall();
    return { status: 200, headers: { 'content-type': 'text/html' }, stream: Readable.from([Buffer.from('<p>All systems operational</p>')]), abort() {} };
  };
  f.calls = calls;
  return f;
}

test('the exit-quote monitor sends nothing while its count cannot be used; a valid count sends', async (t) => {
  const { ws } = monitoredDesk(t);
  // The monitor's targets were approved now; its clock is the real one.
  const now = Date.now();
  const f = spy(() => reply(404, {}));
  const tr = transportSpy();
  for (const c of MC.invalidCases('exit_quotes', now)) {
    MC.put(ws, FM.STATUS_REL, c);
    const before = MC.stored(ws, FM.STATUS_REL);
    const r = await FM.refresh(ws, { fetchImpl: f, lookupImpl: publicLookup, transport: tr, now, force: true });
    assert.equal(r.status, 'held', `${c.name}: ${r.message}`);
    assert.match(r.message, /^Forensic monitor not run: The exit-quote monitor's request count \(market-data\/forensics\/status\.json\) cannot be used: /);
    assert.equal(f.calls.length + tr.calls.length, 0, `${c.name}: nothing was sent`);
    assert.equal(MC.stored(ws, FM.STATUS_REL), before, `${c.name}: the file is kept as it is`);
    const v = FM.statusView(ws, now);
    assert.ok(v.accounting_unknown, `${c.name}: the view says so`);
    assert.equal(v.requests_this_month, null, `${c.name}: never shown as 0`);
  }
  MC.put(ws, FM.STATUS_REL, { absent: true });
  const ok = await FM.refresh(ws, { fetchImpl: f, lookupImpl: publicLookup, transport: tr, now, force: true });
  assert.notEqual(ok.status, 'held', ok.message);
  assert.ok(f.calls.length + tr.calls.length >= 1, 'the same desk sends with a count it can use');
  const written = A.classify('exit_quotes', () => fs.readFileSync(ws.abs(FM.STATUS_REL), 'utf8'));
  assert.equal(written.unknown, null);
  assert.equal(written.status.calls.month_count, f.calls.length + tr.calls.length);
});

test('the exit-quote monitor: a count that goes bad while a check is out is kept as it is, and nothing more is sent', async (t) => {
  const { ws } = monitoredDesk(t);
  const now = Date.now();
  const bad = '{"schema_version": "cr.forensic-monitor-status.v1", "calls": {"month": "2026-13"}}\n';
  const corrupt = () => fs.writeFileSync(ws.abs(FM.STATUS_REL), bad);
  const f = spy(() => { corrupt(); return reply(404, {}); });
  const tr = transportSpy(corrupt);
  const r = await FM.refresh(ws, { fetchImpl: f, lookupImpl: publicLookup, transport: tr, now, force: true });
  assert.equal(r.status, 'held', r.message);
  assert.equal(f.calls.length + tr.calls.length, 1, 'the request out was the last one');
  assert.equal(fs.readFileSync(ws.abs(FM.STATUS_REL), 'utf8'), bad, 'finalizing the run did not overwrite it');
});

// ---------------------------------------------------------------------------
// Simultaneous reservations from separate processes

function child(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'children', 'child-meter-reserve.js'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`child exited ${code}: ${err}`))));
  });
}

test('simultaneous reservations from four processes never pass a meter\'s cap, and every one granted is counted once', async (t) => {
  const CAP = 7;
  const { ws, root } = workspace(t, 'meters-race', { market_data: { enabled: false, monthly_call_budget: CAP } });
  // Candles' cap is its fixed daily budget: start 7 short of it.
  MC.put(ws, C.STATUS_REL, { text: `${JSON.stringify(MC.valid('candles', NOW, { month_count: C.DAILY_BUDGET - CAP, day_count: C.DAILY_BUDGET - CAP }))}\n` });
  for (const id of Object.keys(METERS)) {
    const start = METERS[id].counts(ws, NOW);
    const results = await Promise.all([1, 2, 3, 4].map(() => child([root, id, '4', String(NOW), String(CAP)])));
    const granted = results.reduce((n, r) => n + r.ok, 0);
    assert.equal(granted, CAP, `${id}: 16 attempts, ${CAP} granted`);
    const end = METERS[id].counts(ws, NOW);
    assert.equal(end.month_count - start.month_count, CAP, `${id}: each granted request counted once`);
    assert.equal(A.classify(id, () => fs.readFileSync(ws.abs(METERS[id].rel), 'utf8')).unknown, null);
  }
});
