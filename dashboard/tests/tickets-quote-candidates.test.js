'use strict';
// Exit quotes for pilot candidates (backlog item 25, tickets.js
// quoteCandidates): a candidate graded 40 or over with no current reading is
// quoted at both sizes through the approved chain; a current one is left; a
// native coin and a project with no approved chain are skipped in words; a 429
// stops the source; a dry run sends nothing. Stubbed network, FICTIONAL
// workspaces only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempWorkspace, importAllFixtures } = require('./helpers');
const F = require('../core/forensics');
const T = require('../core/tickets');
const FX = require('./forensic-fixtures');
const { atomicWrite, jsonText } = require('../core/fsx');

const TOKEN = '0x3333333333333333333333333333333333333333';
const CG = 'example-payfi-fictional';

function setup(t, { approve = true } = {}) {
  const w = tempWorkspace('quote-candidates');
  t.after(w.cleanup);
  const P = require('../core/projects');
  const pid = P.addProject(w.ws, { name: 'Example PayFi (FICTIONAL)', symbol: 'XMPL', official_website: 'https://example.com/xmpl', coingecko_id: CG, assets: [{ chain: 'base', contract_address: TOKEN }], evidence: [{ url: 'https://example.com/xmpl', note: 'fictional' }], sector_profile: 'payfi-credit@1' }).project_id;
  importAllFixtures(w.ws);
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
  return { ...w, pid, calls, fetchImpl, cgGetImpl, opts: { fetchImpl, cgGetImpl, sleep: async () => {} } };
}

test('a candidate graded 40+ with no reading is quoted at each screening size (cr-ticket-sizing@4); a second pass leaves it, current', async (t) => {
  const s = setup(t);
  const row = T.pilotCandidates(s.ws).find((r) => r.project_id === s.pid);
  assert.ok(row.grade >= 40, 'the fixture grades 40 or over');
  const out = await T.quoteCandidates(s.ws, s.opts);
  assert.deepEqual(out.quoted.map((r) => r.project_id), [s.pid]);
  assert.deepEqual(out.quoted[0].sizes.map((x) => [x.size_usd, x.status]), [[100, 'quoted'], [500, 'quoted'], [2000, 'quoted']]);
  assert.equal(s.calls.length, 3, 'one request per quote');
  const again = await T.quoteCandidates(s.ws, s.opts);
  assert.deepEqual(again.current.map((r) => r.project_id), [s.pid]);
  assert.equal(again.quoted.length, 0);
  assert.equal(s.calls.length, 3, 'nothing is asked twice');
});

test('no approved chain is named, never approved; a grade under 40 is left to the gate; nothing is approved by the pass', async (t) => {
  const s = setup(t, { approve: false });
  const out = await T.quoteCandidates(s.ws, s.opts);
  assert.match(out.skipped.find((r) => r.project_id === s.pid).reason, /Needs a chain approved \(Forensics > Exits\)/);
  assert.equal(s.calls.length, 0);
  assert.deepEqual(F.readProfile(s.ws, s.pid).targets.exit_quotes || [], []);
});

test('a native coin is skipped with words', async (t) => {
  const s = setup(t);
  const P = require('../core/projects');
  const nat = P.addProject(s.ws, { name: 'Native Example (FICTIONAL)', symbol: 'XNAT', official_website: 'https://native-fictional.test', coingecko_id: 'native-example-fictional', native_chain: true, evidence: [{ url: 'https://native-fictional.test', note: 'fictional' }] }).project_id;
  const out = await T.quoteCandidates(s.ws, { ...s.opts, dryRun: true });
  const row = out.skipped.find((r) => r.project_id === nat);
  assert.ok(row);
  assert.match(row.reason, /No firm grade|Native L1/);
});

test('a 429 stops that source for the pass and says so', async (t) => {
  const s = setup(t);
  const limited = async () => ({ status: 429, headers: { get: () => null }, text: async () => '{}' });
  const out = await T.quoteCandidates(s.ws, { ...s.opts, fetchImpl: limited });
  assert.deepEqual(out.quoted[0].sizes.map((x) => [x.size_usd, x.status]), [[100, 'refused']], 'the next size is not asked once the source says wait');
  assert.deepEqual(out.stopped.map((x) => x.source), ['kyberswap']);
  assert.match(out.stopped[0].reason, /asked this desk to wait/);
});

test('--dry-run sends nothing and writes nothing', async (t) => {
  const s = setup(t);
  const { hashTree } = require('./helpers');
  const tree = hashTree(s.root);
  const out = await T.quoteCandidates(s.ws, { ...s.opts, dryRun: true });
  assert.equal(out.dry_run, true);
  assert.deepEqual(out.quoted.map((r) => r.project_id), [s.pid]);
  assert.equal(out.quoted[0].sizes[0].status, 'would_ask');
  assert.equal(s.calls.length, 0);
  assert.deepEqual(hashTree(s.root), tree);
  await assert.rejects(() => T.quoteCandidates(s.ws, { limit: 0 }), (e) => e.code === 'INVALID');
});
