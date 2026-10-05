'use strict';
// Workflow wording and the status path (review of fa05f99, 2026-10-05):
//   - an ordinary status read (GET /api/doctor, the Settings page) writes
//     nothing; the write test runs only when asked for (POST, or the CLI's
//     doctor command);
//   - a revision that turns an earlier range into a point inside it, on the
//     same evidence, is labeled a narrowing, not new research; the earlier
//     save stays as it was;
//   - readiness keeps manual research (ready), the optional paid API and a
//     model on hold apart.
// FICTIONAL throwaway workspaces; no provider is called.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const { tempWorkspace } = require('./helpers');
const { start } = require('../server');
const { doctor } = require('../core/doctor');
const { revisionOf, revisionLabel } = require('../core/revisions');
const research = require('../core/research');

function request(port, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('status reads never run the write probe; the explicit write test does', async (t) => {
  const { ws, cleanup } = tempWorkspace('doctor-read');
  const probe = ws.abs('.cr/doctor.probe');
  const plain = await doctor(ws);
  assert.equal(fs.existsSync(probe), false, 'doctor() without the write test writes no probe');
  assert.equal(plain.write_test, 'not_run');
  assert.equal(plain.verified_write, null);
  assert.equal(plain.checks.find((c) => c.name === 'Write test').status, 'info');
  assert.notEqual(plain.status, 'fail', 'a write test that did not run is not a problem');

  const srv = await start(ws, { port: 47600 + Math.floor(Math.random() * 300), quiet: true });
  t.after(() => {
    try { srv.shutdown(); } catch (_) { /* already stopped */ }
    cleanup();
  });
  const port = srv.port;
  const token = JSON.parse((await request(port, { path: '/api/session' })).body).token;
  const auth = { 'x-cr-token': token };
  const read = JSON.parse((await request(port, { path: '/api/doctor', headers: auth })).body);
  assert.equal(read.write_test, 'not_run');
  assert.equal(fs.existsSync(probe), false, 'GET /api/doctor writes nothing');
  // The write test is a write: same-origin POST only.
  assert.equal((await request(port, { method: 'POST', path: '/api/doctor/write-test', headers: { ...auth, 'content-type': 'application/json', origin: 'https://evil.example' }, body: {} })).status, 403);
  assert.equal(fs.existsSync(probe), false);
  const ran = JSON.parse((await request(port, { method: 'POST', path: '/api/doctor/write-test', headers: { ...auth, 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` }, body: {} })).body);
  assert.equal(ran.write_test, 'run');
  assert.equal(ran.verified_write, true);
  assert.ok(fs.existsSync(probe));
  // The CLI's doctor (Cowork's session check) is the explicit diagnostic.
  const cli = await doctor(ws, { writeProbe: true });
  assert.equal(cli.verified_write, true);
  assert.equal(cli.checks.find((c) => c.name === 'Write test').status, 'ok');
});

const rep = (id, at, a, extra = {}) => ({ report_id: id, meta: { provider: 'claude', imported_at: at, provenance: { research_run_id: 'run_FICTIONAL', ...extra } }, assessment: a });
const comp = (s) => ({ investment_components: { timing_executable_liquidity: s, valuation_supply: { status: 'scored', value: 40 } }, sources: [{ url: 'https://docs.example/a' }] });

test('a range turned into a point inside it on the same evidence is labeled a narrowing, not new research; the earlier save is untouched', () => {
  const first = rep('r1', '2026-10-05T10:00:00Z', comp({ status: 'range', low: 50, high: 70 }));
  const second = rep('r2', '2026-10-05T10:12:00Z', comp({ status: 'scored', value: 60 }));
  const before = JSON.stringify(first);
  const rev = revisionOf([first, second], second);
  assert.equal(rev.kind, 'revision');
  assert.equal(rev.basis, 'existing_evidence');
  assert.deepEqual(rev.narrowed, [{ id: 'timing_executable_liquidity', group: 'investment_components', from: '50–70', to: '60', midpoint: true }]);
  const label = revisionLabel(rev, { labels: { timing_executable_liquidity: 'Timing and executable liquidity' } });
  assert.match(label, /^Revision using existing evidence \(no source added\), 12 min after r1: Timing and executable liquidity 50–70 → 60\. 1 range became a point inside the same range \(at its midpoint\) with no new source: a narrowing of the earlier judgment, not new research\. No reason was recorded with this save\.$/);
  assert.equal(JSON.stringify(first), before, 'the earlier save is read, never changed');
  // A point outside the earlier range is a changed judgment, not a narrowing.
  const outside = rep('r3', '2026-10-05T10:20:00Z', comp({ status: 'scored', value: 80 }));
  assert.deepEqual(revisionOf([first, outside], outside).narrowed, []);
  // With new sources the narrowing is said without "not new research".
  const sourced = rep('r4', '2026-10-05T10:30:00Z', { ...comp({ status: 'scored', value: 55 }), sources: [{ url: 'https://docs.example/a' }, { url: 'https://docs.example/new' }] });
  const r4 = revisionOf([first, sourced], sourced);
  assert.equal(r4.basis, 'new_sources');
  assert.match(revisionLabel(r4), /1 range became a point inside the same range\. No reason/);
});

test('readiness: manual research is ready without a key; the paid API is optional; a held model is on hold, not manual', (t) => {
  const { ws, cleanup } = tempWorkspace('ready-words', { research: { on_hold: { gemini: { since: '2026-10-04', reason: 'FICTIONAL milestone hold' } } } });
  t.after(cleanup);
  const r = research.readiness(ws);
  assert.equal(r.models.chatgpt.status, 'manual');
  assert.match(r.models.chatgpt.sentence, /^ChatGPT: manual\. .*nothing is billed\. Automatic background research is optional and not set up:/);
  assert.equal(r.models.gemini.status, 'on_hold');
  assert.match(r.models.gemini.sentence, /^Gemini: on hold since 2026-10-04 .*Nothing new is assigned to it/);
  assert.ok(!r.manual.includes('gemini'), 'a held model is never listed as manual research');
  assert.match(r.summary, /^Manual research: Claude and ChatGPT, when Eric asks/);
  assert.match(r.summary, /Automatic background research: not set up for any model \(optional;/);
  assert.match(r.summary, /On hold: Gemini since 2026-10-04/);
  assert.doesNotMatch(r.summary, /Gemini, when Eric asks|Claude, ChatGPT and Gemini, when/);
});
