'use strict';
// Pilot enrollment approves the project's primary exit-quote target
// (forensics.js approvePrimaryExitQuote, tickets.js setPilot), and the
// standing policy can be run at once (POST /api/forensics/exit-quotes/auto).
// FICTIONAL temporary workspaces; no request is sent to any provider.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { tempWorkspace } = require('./helpers');
const T = require('../core/tickets');
const F = require('../core/forensics');
const projects = require('../core/projects');

const hex = (s) => `0x${require('crypto').createHash('sha1').update(s).digest('hex')}`;

function setup(t, settings = {}) {
  const w = tempWorkspace('pilot-xt', settings);
  t.after(w.cleanup);
  const add = (name, symbol, extra = {}) => projects.addProject(w.ws, {
    name,
    symbol,
    official_website: `https://${symbol.toLowerCase()}.example.org/`,
    evidence: [{ url: `https://${symbol.toLowerCase()}.example.org/`, note: 'fictional' }],
    coingecko_id: `${symbol.toLowerCase()}-fictional`,
    ...(extra.native ? { native_chain: true } : { assets: [{ chain: 'base', contract_address: hex(symbol) }] }),
  }).project_id;
  return { ws: w.ws, root: w.root, add };
}

const quotes = (ws, pid) => F.readProfile(ws, pid).targets.exit_quotes || [];
const setBudget = (ws, n) => { ws.settings = { ...ws.settings, forensics: { ...ws.settings.forensics, monitor: { ...ws.settings.forensics.monitor, monthly_request_budget: n } } }; };

test('enrolling a project in the pilot approves its primary exit-quote target and turns monitoring on', (t) => {
  const s = setup(t);
  const pid = s.add('Enrolled (FICTIONAL)', 'XEN');
  assert.equal(quotes(s.ws, pid).length, 0);
  const out = T.setPilot(s.ws, pid, true, { by: 'test' });
  assert.equal(out.exit_quote.status, 'approved', JSON.stringify(out.exit_quote));
  assert.equal(out.exit_quote.project_id, pid);
  assert.ok(out.exit_quote.chain);
  assert.ok(out.exit_quote.source);
  assert.equal(quotes(s.ws, pid).length, 1);
  assert.equal(F.readProfile(s.ws, pid).monitoring.enabled, true);
  assert.equal(T.readTicketProfile(s.ws, pid).pilot, true);
});

test('a second enrollment keeps the target; turning the pilot off approves nothing', (t) => {
  const s = setup(t);
  const pid = s.add('Twice (FICTIONAL)', 'XTW');
  T.setPilot(s.ws, pid, true);
  const off = T.setPilot(s.ws, pid, false);
  assert.equal(off.exit_quote, undefined);
  const again = T.setPilot(s.ws, pid, true);
  assert.equal(again.exit_quote.status, 'kept');
  assert.equal(quotes(s.ws, pid).length, 1);
  // An enrollment that changes nothing (already on) approves nothing either.
  assert.equal(T.setPilot(s.ws, pid, true).exit_quote, undefined);
});

test('paused: enrollment stands, no target is approved', (t) => {
  const s = setup(t, { automation: { paused: true } });
  const pid = s.add('Paused (FICTIONAL)', 'XPS');
  const out = T.setPilot(s.ws, pid, true);
  assert.equal(out.exit_quote.status, 'paused');
  assert.equal(quotes(s.ws, pid).length, 0);
  assert.equal(T.readTicketProfile(s.ws, pid).pilot, true, 'the enrollment is never undone');
});

test('over the monitor\'s monthly budget: no target, and the numbers say why', (t) => {
  const s = setup(t);
  const a = s.add('First (FICTIONAL)', 'XFA');
  const b = s.add('Second (FICTIONAL)', 'XFB');
  const { per } = F.quoteBudgetOf(s.ws);
  setBudget(s.ws, per);
  assert.equal(T.setPilot(s.ws, a, true).exit_quote.status, 'approved');
  const out = T.setPilot(s.ws, b, true);
  assert.equal(out.exit_quote.status, 'over_budget');
  assert.equal(out.exit_quote.needed, per);
  assert.equal(out.exit_quote.used, per);
  assert.equal(quotes(s.ws, b).length, 0);
});

test('a native coin has no contract to quote: none, with the reason', (t) => {
  const s = setup(t);
  const pid = s.add('Native Coin (FICTIONAL)', 'XNC', { native: true });
  const out = T.setPilot(s.ws, pid, true);
  assert.equal(out.exit_quote.status, 'none');
  assert.match(out.exit_quote.reason, /native coin/i);
  assert.equal(quotes(s.ws, pid).length, 0);
});

test('POST /api/forensics/exit-quotes/auto runs the standing policy on pilot projects only, never the whole plan', async (t) => {
  const s = setup(t, { automation: { exit_quotes_auto: true, paused: true } });
  const inPilot = s.add('In Pilot (FICTIONAL)', 'XIP');
  const outside = s.add('Outside (FICTIONAL)', 'XOP');
  // Enrolled while paused: no target yet.
  assert.equal(T.setPilot(s.ws, inPilot, true).exit_quote.status, 'paused');
  const jobs = require('../core/jobs');
  const real = jobs.runJob;
  const ran = [];
  jobs.runJob = async (ws, name, opts) => { ran.push([name, opts && opts.trigger]); return {}; };
  t.after(() => { jobs.runJob = real; });
  const { start, applySettings } = require('../server');
  const srv = await start(s.ws, { port: 49600 + Math.floor(Math.random() * 90), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } });
  const post = (p, body) => new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: p, method: 'POST', headers: { host: `127.0.0.1:${srv.port}`, origin: `http://127.0.0.1:${srv.port}`, 'x-cr-token': srv.token, 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
    });
    req.on('error', reject);
    req.end(data);
  });
  // Paused: nothing.
  let r = await post('/api/forensics/exit-quotes/auto', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'unchanged');
  applySettings(s.ws, { automation: { paused: false } });
  r = await post('/api/forensics/exit-quotes/auto', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'saved');
  assert.deepEqual(r.body.added.map((x) => x.project_id), [inPilot]);
  assert.equal(quotes(s.ws, inPilot).length, 1);
  assert.equal(quotes(s.ws, outside).length, 0, 'a project outside the pilot is never approved');
  await new Promise((res) => setTimeout(res, 450));
  assert.deepEqual(ran, [['forensics', 'dashboard']], 'the first quotes are asked for at once');
  // Off: nothing, whatever the pilot holds.
  applySettings(s.ws, { automation: { exit_quotes_auto: false } });
  r = await post('/api/forensics/exit-quotes/auto', {});
  assert.equal(r.body.status, 'unchanged');
});

test('POST /api/projects/<id>/tickets/pilot returns the exit target and asks for the first quote', async (t) => {
  const s = setup(t);
  const pid = s.add('Route Enroll (FICTIONAL)', 'XRE');
  const jobs = require('../core/jobs');
  const real = jobs.runJob;
  const ran = [];
  jobs.runJob = async (ws, name) => { ran.push(name); return {}; };
  t.after(() => { jobs.runJob = real; });
  const { start } = require('../server');
  const srv = await start(s.ws, { port: 49700 + Math.floor(Math.random() * 90), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } });
  const res = await new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify({ on: true }));
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: `/api/projects/${pid}/tickets/pilot`, method: 'POST', headers: { host: `127.0.0.1:${srv.port}`, origin: `http://127.0.0.1:${srv.port}`, 'x-cr-token': srv.token, 'content-type': 'application/json', 'content-length': data.length } }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(data);
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.exit_quote.status, 'approved');
  await new Promise((r) => setTimeout(r, 450));
  assert.deepEqual(ran, ['forensics']);
});
