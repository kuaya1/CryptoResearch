'use strict';
// Audit F4 (audit-blueprint-implementation-2026-11-02.md): reconciliation was
// not bound to the attempt Eric checked. The panel showed attempt A but
// posted only {"reconciled":true}, and pilot-claims.release released
// whichever expired claim was current. A click about A, made after A was
// settled elsewhere and a new attempt B had expired, released B unchecked.
//
// Now the attempt Eric checked travels with the click, and release compares
// it with the current claim inside its own lock: any other attempt is 409
// CHANGED with nothing written; the readback confirms that same attempt.
//
// FICTIONAL temporary workspaces; a real desk server on 127.0.0.1, signed in.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const DC = require('../core/desk-controls');
const PC = require('../core/pilot-claims');
const T = require('../core/tickets');
const { mandateDesk } = require('./mandate-fixture');

function desk(t) {
  const s = mandateDesk(t, { mandate: false });
  T.setPilot(s.ws, s.pid, true);
  return s;
}

async function startDesk(t, ws) {
  const { start } = require('../server');
  const srv = await start(ws, { port: 49900 + Math.floor(Math.random() * 90), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } });
  return srv;
}

function request(port, p, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === null ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), origin: `http://127.0.0.1:${port}` } : {}), ...headers } }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(c).toString() || 'null') }); } catch (err) { reject(err); } });
    });
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data || undefined);
  });
}

// An attempt dispatched long ago whose outcome is unknown: it reads reconcile.
function expiredDispatch(s, owner) {
  const past = Date.now() - 3 * PC.TTL_MS;
  const c = PC.claim(s.ws, s.pid, { owner, now: past });
  assert.equal(c.status, 'claimed_now', JSON.stringify(c));
  PC.bind(s.ws, s.pid, c.token, { now: past + 1000 });
  return c.claim.attempt_id;
}

const loadModel = () => import('../public/desk-controls-model.js');

test('F4: a stale reconcile of attempt A, sent after A was settled and B expired, releases nothing; B stays for Eric to check', async (t) => {
  const M = await loadModel();
  const s = desk(t);
  const srv = await startDesk(t, s.ws);
  const signed = { 'x-cr-token': srv.token };
  const read = async () => (await request(srv.port, '/api/desk/controls', { headers: signed })).json;

  // Attempt A is displayed: Eric checks the desk for A's report or ticket.
  const A = expiredDispatch(s, 'FICTIONAL-runner-A');
  const shown = (await read()).projects[0].controls.reconcile;
  assert.equal(shown.available, true);
  assert.equal(shown.attempt_id, A);
  // The click names the attempt shown (the panel's body is checked below
  // and in the third test).
  const staleBody = { reconciled: true, attempt_id: A };

  // A is settled elsewhere (another tab, the same check), then B is created
  // and expires with no known outcome.
  const elsewhere = await request(srv.port, shown.path, { method: 'POST', body: staleBody, headers: signed });
  assert.equal(elsewhere.status, 200, JSON.stringify(elsewhere.json));
  assert.equal(PC.read(s.ws, s.pid).outcome, 'reconciled');
  const B = expiredDispatch(s, 'FICTIONAL-runner-B');
  assert.notEqual(B, A);
  const before = JSON.stringify(PC.read(s.ws, s.pid));

  // The stale click about A arrives.
  const stale = await request(srv.port, shown.path, { method: 'POST', body: staleBody, headers: signed });
  const hit = PC.read(s.ws, s.pid);
  assert.ok(!(hit.attempt_id === B && hit.released), `the click about ${A} released ${B} (HTTP ${stale.status}, outcome ${hit.outcome})`);
  assert.equal(stale.status, 409, `the stale click is refused: ${JSON.stringify(stale.json)}`);
  assert.equal(stale.json.code, 'CHANGED');
  assert.match(stale.json.error, new RegExp(`${A}.*${B}`, 's'), 'it names the attempt checked and the one now current');
  const now = PC.read(s.ws, s.pid);
  assert.equal(now.attempt_id, B);
  assert.equal(now.released, false, 'B is not released');
  assert.equal(JSON.stringify(now), before, 'nothing about B was written');

  // The old body without an attempt is refused at the route; nothing changes.
  const bare = await request(srv.port, shown.path, { method: 'POST', body: { reconciled: true }, headers: signed });
  assert.equal(bare.status, 400, JSON.stringify(bare.json));
  assert.equal(JSON.stringify(PC.read(s.ws, s.pid)), before);

  // The panel's readback for the stale click does not claim success, even
  // though the desk shows some attempt as released earlier.
  const after = await read();
  assert.equal(after.projects[0].dispatch.attempt_id, B);
  assert.equal(M.readback(after, 'reconcile', s.pid, A).ok, false, 'no readback of A from B\'s row');

  // Eric checks B, the attempt now shown, and releases exactly it.
  const shownB = after.projects[0].controls.reconcile;
  assert.equal(shownB.attempt_id, B);
  const ok = await request(srv.port, shownB.path, { method: 'POST', body: M.reconcileBody(shownB), headers: signed });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const done = await read();
  const rb = M.readback(done, 'reconcile', s.pid, B);
  assert.equal(rb.ok, true, rb.words);
  assert.match(rb.words, new RegExp(B));
  assert.equal(PC.read(s.ws, s.pid).outcome, 'reconciled');
  // Clicking B again is unchanged, never a second release.
  const again = await request(srv.port, shownB.path, { method: 'POST', body: M.reconcileBody(shownB), headers: signed });
  assert.equal(again.status, 200);
  assert.equal(again.json.status, 'unchanged');
});

test('F4: release compares the attempt inside its own operation: another attempt is CHANGED, the same released one is unchanged, none named is refused', (t) => {
  const s = desk(t);
  const A = expiredDispatch(s, 'FICTIONAL-runner-A');
  const later = Date.now();
  assert.throws(() => PC.release(s.ws, s.pid, { reconciled: true, now: later }), (e) => e.code === 'INVALID' && /attempt/.test(e.message), 'an attempt must be named');
  assert.throws(() => PC.release(s.ws, s.pid, { reconciled: true, attempt_id: 'pa_0000000000000000', now: later }), (e) => e.code === 'CHANGED');
  assert.equal(PC.read(s.ws, s.pid).released, false, 'nothing written by either refusal');
  assert.equal(PC.release(s.ws, s.pid, { reconciled: true, attempt_id: A, now: later }).claim.outcome, 'reconciled');
  assert.equal(PC.release(s.ws, s.pid, { reconciled: true, attempt_id: A, now: later }).status, 'unchanged');
  const B = expiredDispatch(s, 'FICTIONAL-runner-B');
  assert.throws(() => PC.release(s.ws, s.pid, { reconciled: true, attempt_id: A, now: later }), (e) => e.code === 'CHANGED' && e.details.checked === A && e.details.current === B);
  assert.equal(PC.read(s.ws, s.pid).released, false);
  // A live attempt is still refused as live, whatever is named.
  PC.release(s.ws, s.pid, { reconciled: true, attempt_id: B, now: later });
  const live = PC.claim(s.ws, s.pid, { owner: 'FICTIONAL-live' });
  assert.throws(() => PC.release(s.ws, s.pid, { reconciled: true, attempt_id: live.claim.attempt_id, now: later }), /still live/);
});

test('F4: the view hands the panel the attempt in the body it names, and the readback needs that same attempt released as reconciled', async (t) => {
  const M = await loadModel();
  const s = desk(t);
  const A = expiredDispatch(s, 'FICTIONAL-runner-A');
  const rc = DC.view(s.ws).projects[0].controls.reconcile;
  assert.deepEqual(rc.body, { reconciled: true, attempt_id: A }, 'the view names the attempt in the body');
  assert.deepEqual(M.reconcileBody(rc), { reconciled: true, attempt_id: A });
  assert.equal(M.reconcileBody({ ...rc, attempt_id: null }), null, 'no attempt shown, nothing to post');
  PC.release(s.ws, s.pid, { reconciled: true, attempt_id: A });
  const v = DC.view(s.ws);
  assert.equal(M.readback(v, 'reconcile', s.pid, A).ok, true);
  assert.equal(M.readback(v, 'reconcile', s.pid, 'pa_0000000000000000').ok, false);
  assert.equal(M.readback(v, 'reconcile', s.pid).ok, false, 'a readback names the attempt it checks');
});
