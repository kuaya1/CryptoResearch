'use strict';
// Fixed-size quote before sizing (tickets.js prepareExitQuote, backlog item 5):
// when a verified, quotable token has no reading at the exit size, one quote
// is asked through the approved adapter; a failed or refused quote falls back
// to "no reading" with its reason. Stubbed network, FICTIONAL workspaces only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempWorkspace } = require('./helpers');
const F = require('../core/forensics');
const T = require('../core/tickets');
const FX = require('./forensic-fixtures');
const { atomicWrite, jsonText } = require('../core/fsx');

const TOKEN = '0x2222222222222222222222222222222222222222';
const CG = 'fictional-ticket-token';

function setup(t, { approve = true } = {}) {
  const w = tempWorkspace('ticket-exit-quote');
  t.after(w.cleanup);
  const P = require('../core/projects');
  const pid = P.addProject(w.ws, { name: 'Ticket Quote Example (FICTIONAL)', symbol: 'XTQ', official_website: 'https://tq.example', coingecko_id: CG, assets: [{ chain: 'base', contract_address: TOKEN }], evidence: [{ url: 'https://tq.example', note: 'fictional' }] }).project_id;
  const a = F.createAudit(w.ws, { project_id: pid, assistant: 'claude' });
  F.saveReport(w.ws, { project_id: pid, audit_id: a.audit_id, provider: 'claude', text: FX.reportText(a.audit) });
  if (approve) {
    const key = F.view(w.ws, pid).monitoring.proposed.exit_quotes.find((o) => o.chain === 'base').key;
    F.setMonitoring(w.ws, pid, { approve_quotes: [key], enabled: true });
  }
  const now = Date.now();
  fs.mkdirSync(path.join(w.ws.root, 'market-data'), { recursive: true });
  atomicWrite(path.join(w.ws.root, 'market-data', 'latest.json'), jsonText({ provider: 'coingecko', assets: { [CG]: { id: CG, price_usd: 2, source_last_updated_at: new Date(now - 60000).toISOString(), fetched_at: new Date(now - 60000).toISOString() } } }));
  const calls = [];
  const fetchImpl = async (u) => {
    calls.push(String(u));
    const url = new URL(u);
    const amountIn = url.searchParams.get('amountIn');
    const sold = (Number(amountIn) / 1e6) * 2;
    const body = { code: 0, data: { routeSummary: { tokenIn: url.searchParams.get('tokenIn'), tokenOut: url.searchParams.get('tokenOut'), amountIn, amountOut: String(Math.floor(sold * 0.98 * 1e6)), amountInUsd: String(sold), amountOutUsd: String(sold * 0.98), gasUsd: '0.05', route: [[{ exchange: 'fictional-dex' }]] } } };
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  const cgGetImpl = async () => ({ id: CG, detail_platforms: { base: { decimal_place: 6, contract_address: TOKEN } } });
  return { ...w, pid, calls, fetchImpl, cgGetImpl, now };
}

test('no reading at the exit size: one fixed-size quote is asked, then the reading exists and nothing more is asked', async (t) => {
  const s = setup(t);
  const out = await T.prepareExitQuote(s.ws, s.pid, { fetchImpl: s.fetchImpl, cgGetImpl: s.cgGetImpl, sleep: async () => {} });
  assert.equal(out.status, 'quoted');
  assert.equal(out.size_usd, T.sizingOf(s.ws).exit_size_usd);
  assert.equal(s.calls.length, 1);
  const again = await T.prepareExitQuote(s.ws, s.pid, { fetchImpl: s.fetchImpl, cgGetImpl: s.cgGetImpl, sleep: async () => {} });
  assert.equal(again, null, 'a current reading means no second request');
  assert.equal(s.calls.length, 1);
});

test('no approved exit-quote chain: nothing is sent and the reason is in words', async (t) => {
  const s = setup(t, { approve: false });
  const out = await T.prepareExitQuote(s.ws, s.pid, { fetchImpl: s.fetchImpl, cgGetImpl: s.cgGetImpl, sleep: async () => {} });
  assert.equal(out.status, 'no_target');
  assert.match(out.reason, /No exit-quote chain is approved/);
  assert.equal(s.calls.length, 0);
});

test('a failed quote falls back to no reading and the ticket packet says why', async (t) => {
  const s = setup(t);
  const bad = async () => { throw new Error('network down (FICTIONAL)'); };
  const out = await T.prepareExitQuote(s.ws, s.pid, { fetchImpl: bad, cgGetImpl: s.cgGetImpl, sleep: async () => {} });
  assert.notEqual(out.status, 'quoted');
  assert.ok(out.reason, 'a reason is given');
  assert.ok(!s.calls.length || out.status !== 'quoted');
});

test('createTicket freezes the attempt in the packet and the exit stays "no reading"', (t) => {
  const w = tempWorkspace('ticket-exit-attempt');
  t.after(w.cleanup);
  const { addFixtureProject, importAllFixtures } = require('./helpers');
  const pid = addFixtureProject(w.ws).project_id;
  importAllFixtures(w.ws);
  const attempt = { size_usd: 500, status: 'refused', reason: 'Forensic quoting is turned off in settings.', asked_at: new Date().toISOString() };
  const out = T.createTicket(w.ws, { project_id: pid, exit_quote: attempt });
  assert.equal(out.status, 'created');
  const packet = JSON.parse(fs.readFileSync(w.ws.abs(out.ticket.packet.path), 'utf8'));
  assert.deepEqual(packet.exit_quote_attempt, attempt);
  assert.equal(packet.exits[0].cost_pct, null);
});

test('a held restored copy asks no quote', async (t) => {
  const s = setup(t);
  atomicWrite(path.join(s.ws.root, 'config', 'restored-copy.json'), jsonText({ schema_version: 'cr.restored-copy.v1', held: true, restored_at: new Date().toISOString() }));
  const out = await T.prepareExitQuote(s.ws, s.pid, { fetchImpl: s.fetchImpl, cgGetImpl: s.cgGetImpl, sleep: async () => {} });
  assert.notEqual(out.status, 'quoted');
  assert.equal(s.calls.length, 0);
});
