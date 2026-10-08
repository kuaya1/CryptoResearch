'use strict';
// The browser app's store (dashboard/web/src/lib/desk.js) and its pure rules
// (lib/opinion.js, public/project-routes.js), run in Node with a fake fetch:
// the review of 2026-10-08 (audits/2026-10-08-codex-react-review) F1 report
// identity, F2 startup recovery and sign-out, F4 the chosen opinion carried
// between the project's sections. FICTIONAL data only; nothing is written.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WEB = path.join(__dirname, '..', 'web', 'src', 'lib');
const PUBLIC = path.join(__dirname, '..', 'public');
let n = 0;

// A fresh copy of desk.js (its state is module-level) with browser stand-ins.
async function freshDesk({ hidden = true } = {}) {
  const assigned = [];
  const listeners = {};
  global.document = { hidden, addEventListener: (k, fn) => { listeners[k] = fn; }, removeEventListener() {}, createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } };
  global.window = { addEventListener: (k, fn) => { listeners[`w:${k}`] = fn; }, removeEventListener() {} };
  global.location = { protocol: 'http:', assign: (u) => assigned.push(u), reload: () => assigned.push('reload') };
  const m = await import(`${pathToFileURL(path.join(WEB, 'desk.js')).href}?case=${++n}`);
  return { m, assigned, listeners };
}

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const SESSION = { token: 'fictional-token', workspace: { workspace_id: 'ws_fictional', kind: 'test' }, hosted: false };
const index = (report) => ({ projects: [{ project_id: 'fictional', name: 'FICTIONAL', providers: { claude: { report_id: report } } }], live: { seq: 1, instance: 'fixture' } });

test('F1: a late first read that a broad refresh made obsolete never becomes the cached record', async () => {
  const { m } = await freshDesk();
  let answer = null;
  let reads = 0;
  global.fetch = async (url) => {
    if (url.startsWith('/api/projects/')) {
      reads += 1;
      if (reads === 1) return new Promise((r) => { answer = r; });
      return json({ project: { project_id: 'fictional' }, reports: [{ report_id: 'NEW' }] });
    }
    return json(index('NEW'));
  };
  const first = m.projectDetail('fictional').catch((e) => e);
  await new Promise((r) => setImmediate(r));
  await m.refresh();
  answer(json({ project: { project_id: 'fictional' }, reports: [{ report_id: 'OLD' }] }));
  const got = await first;
  const cached = m.desk.projects.get('fictional');
  assert.ok(!cached || cached.reports[0].report_id === 'NEW', `the cache holds ${cached && cached.reports[0].report_id}`);
  assert.ok(!(got && got.reports && got.reports[0].report_id === 'OLD'), 'the caller is not handed the obsolete record as current');
});

test('F1: concurrent readers share one request; a reader that leaves does not cancel the others', async () => {
  const { m } = await freshDesk();
  let answer = null;
  let calls = 0;
  global.fetch = async (url, init) => {
    calls += 1;
    return new Promise((resolve, reject) => {
      answer = resolve;
      if (init && init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  };
  const leaving = new AbortController();
  const a = m.projectDetail('fictional', { signal: leaving.signal }).catch((e) => e);
  const b = m.projectDetail('fictional');
  leaving.abort();
  answer(json({ project: { project_id: 'fictional' }, reports: [] }));
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.equal(ra && ra.name, 'AbortError', 'the reader that left is told so');
  assert.equal(rb.project.project_id, 'fictional', 'the other reader still gets the record');
});

test('F2: an HTML 503 from the session ends in a retryable error, never an endless start', async () => {
  const { m } = await freshDesk();
  global.fetch = async () => new Response('<h1>503 FICTIONAL upstream</h1>', { status: 503, headers: { 'content-type': 'text/html' } });
  const ok = await m.boot();
  assert.equal(ok, false);
  assert.ok(m.desk.error, 'an error is shown');
  assert.equal(m.desk.error.retry, true);
  assert.match(m.desk.error.message, /503/);
  assert.equal(m.desk.index, null);
});

test('F2: a session that never answers ends within its bound', async () => {
  const { m } = await freshDesk();
  global.fetch = (url, init) => new Promise((_, reject) => {
    if (init && init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const t0 = Date.now();
  const ok = await m.boot({ timeoutMs: 150 });
  assert.equal(ok, false);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(m.desk.error.kind, 'timeout');
  assert.equal(m.desk.error.retry, true);
  assert.equal(m.SESSION_TIMEOUT_MS, 20000, 'the real bound is 20 s');
});

test('F2: an unreadable session (no token) is an error, not a half-started desk', async () => {
  const { m } = await freshDesk();
  let indexReads = 0;
  global.fetch = async (url) => {
    if (url === '/api/session') return json({ hello: 'not a session' });
    indexReads += 1;
    return json(index('X'));
  };
  assert.equal(await m.boot(), false);
  assert.equal(m.desk.error.kind, 'invalid');
  assert.equal(indexReads, 0, 'nothing else is asked with no session');
});

test('F2: a failed network and a failed workspace read are retryable errors; Try again recovers', async () => {
  const { m } = await freshDesk();
  global.fetch = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal(await m.boot(), false);
  assert.equal(m.desk.error.kind, 'network');
  let fail = true;
  global.fetch = async (url) => {
    if (url === '/api/session') return json(SESSION);
    if (url === '/api/ui-state') return json({});
    if (url === '/api/index' && fail) return json({ error: 'FICTIONAL index unavailable' }, 503);
    return json(index('X'));
  };
  assert.equal(await m.boot(), false);
  assert.equal(m.desk.error.retry, true);
  fail = false;
  assert.equal(await m.boot(), true, 'Try again (boot once more) recovers');
  assert.equal(m.desk.error, null);
  assert.ok(m.desk.index);
});

test('F2: a 401 from the session follows the sign-in contract, with no error shown', async () => {
  const { m, assigned } = await freshDesk();
  global.fetch = async () => json({ error: 'FICTIONAL expired' }, 401);
  assert.equal(await m.boot(), false);
  assert.deepEqual(assigned, ['/login']);
  assert.equal(m.desk.error, null);
});

test('F2: on the online desk a 401 while open clears protected data before sign-in', async () => {
  const { m, assigned } = await freshDesk({ hidden: false });
  let out = false;
  global.fetch = async (url) => {
    if (out) return json({ error: 'FICTIONAL signed out' }, 401);
    if (url === '/api/session') return json({ ...SESSION, hosted: true });
    if (url === '/api/ui-state') return json({});
    if (url.startsWith('/api/version')) return json({ seq: 1, instance: 'fixture' });
    return json(index('X'));
  };
  assert.equal(await m.boot(), true);
  assert.ok(m.desk.index);
  out = true;
  await m.api.get('/api/index').catch(() => null);
  m.stopLive();
  assert.equal(m.desk.index, null, 'the index is gone from memory');
  assert.equal(m.desk.projects.size, 0);
  assert.equal(m.desk.signedOut, true);
  assert.ok(assigned.includes('/login'));
});

test('F1: an opinion is drawn from the one report the summary names, or not at all', async () => {
  const { opinionOf, opinionsAgree } = await import(pathToFileURL(path.join(WEB, 'opinion.js')).href);
  const grade = (v) => ({ status: 'firm', value: v, display: String(v), low: null, high: null, coverage_pct: 100 });
  const p = { project_id: 'x', providers: { claude: { report_id: 'NEW', grade: grade(90.4), verdict: 'AVOID', analysis_at: '2026-10-08' } } };
  const rep = (id, g, verdict) => ({ report_id: id, meta: { provider: 'claude' }, grade: grade(g), assessment: { verdict, analysis_at: '2026-10-08' } });
  const older = { reports: [rep('OLD', 64.3, 'CONDITIONAL OPPORTUNITY')], comparison: { latest: { claude: { report_id: 'OLD' } } } };
  const o = opinionOf(p, 'claude', older);
  assert.equal(o.status, 'pending', 'the record does not hold the summary\'s report yet');
  assert.equal(o.report, null, 'never another report in its place');
  assert.equal(o.report_id, 'NEW');
  const same = { reports: [rep('OLD', 64.3, 'CONDITIONAL OPPORTUNITY'), rep('NEW', 90.4, 'AVOID')], comparison: { latest: { claude: { report_id: 'NEW' } } } };
  const ok = opinionOf(p, 'claude', same);
  assert.equal(ok.status, 'ok');
  assert.equal(ok.report.report_id, 'NEW');
  const drift = { reports: [rep('NEW', 70, 'AVOID')], comparison: { latest: { claude: { report_id: 'NEW' } } } };
  assert.equal(opinionOf(p, 'claude', drift).status, 'pending', 'the same ID with another grade is not the same snapshot');
  assert.equal(opinionOf(p, 'chatgpt', same).status, 'none');
  assert.equal(opinionOf(p, 'claude', null).status, 'loading');
  assert.equal(opinionsAgree(p, same), true);
  assert.equal(opinionsAgree(p, older), false, 'a comparison is drawn only when every model agrees');
});

test('F4: the chosen model and report are carried between the project\'s sections', async () => {
  const { sectionHref, selectionOf } = await import(pathToFileURL(path.join(PUBLIC, 'project-routes.js')).href);
  const latest = { claude: 'C2', chatgpt: 'G1', gemini: null };
  const providerOf = (id) => ({ C1: 'claude', C2: 'claude', G1: 'chatgpt' }[id] || null);
  const q = (s) => new URLSearchParams(s);
  // From the Overview with ChatGPT's latest.
  const gpt = selectionOf('brief', q('model=chatgpt'), { latest, providerOf });
  assert.deepEqual(gpt, { model: 'chatgpt', report: null });
  assert.equal(sectionHref('p', 'evidence', gpt, { latest }), '#/project/p/evidence?model=chatgpt');
  assert.equal(sectionHref('p', 'report', gpt, { latest }), '#/project/p/report?report=G1&model=chatgpt');
  assert.equal(sectionHref('p', 'compare', gpt, { latest }), '#/project/p/compare?model=chatgpt');
  // An earlier report chosen explicitly stays chosen.
  const old = selectionOf('brief', q('model=claude&report=C1'), { latest, providerOf });
  assert.equal(sectionHref('p', 'evidence', old, { latest }), '#/project/p/evidence?model=claude&report=C1');
  assert.equal(sectionHref('p', 'report', old, { latest }), '#/project/p/report?report=C1&model=claude');
  // From Full report: the report's own model; the latest is never pinned.
  assert.deepEqual(selectionOf('report', q('report=C2'), { latest, providerOf }), { model: 'claude', report: null });
  assert.deepEqual(selectionOf('report', q('report=C1'), { latest, providerOf }), { model: 'claude', report: 'C1' });
  // A model with no report stays that model.
  const gem = selectionOf('evidence', q('model=gemini'), { latest, providerOf });
  assert.equal(sectionHref('p', 'report', gem, { latest }), '#/project/p/report?model=gemini');
  assert.deepEqual(selectionOf('report', q('model=gemini'), { latest, providerOf }), { model: 'gemini', report: null });
  // No selection given: links stay as before.
  assert.deepEqual(selectionOf('brief', q(''), { latest, providerOf }), { model: null, report: null });
  assert.equal(sectionHref('p', 'market', selectionOf('brief', q(''), { latest, providerOf }), { latest }), '#/project/p/market');
  assert.equal(sectionHref('p', 'evidence', selectionOf('brief', q(''), { latest, providerOf }), { latest }), '#/project/p/evidence');
});
