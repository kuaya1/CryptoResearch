'use strict';
// The case package of one forensic receipt (cr.forensic-case.v1): built from
// records already on the desk, verified and replayed offline. Fictional
// workspaces and stubbed providers only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { tempWorkspace, hashTree } = require('./helpers');
const F = require('../core/forensics');
const C = require('../core/forensic-case');
const monitor = require('../core/forensic-monitor');
const FX = require('./forensic-fixtures');
const { atomicWrite, jsonText } = require('../core/fsx');

const H = 3600000;
const DAY = 24 * H;
const at = (ms) => new Date(ms).toISOString();
const TOKEN = '0x1111111111111111111111111111111111111111';
const CG = 'fictional-case-token';

// A Base project with exit quotes approved, a 0% tax screen, and two
// monitor runs of stubbed KyberSwap quotes (FICTIONAL).
async function caseSetup(label, { taxPct = 0 } = {}) {
  const t = tempWorkspace(label);
  const P = require('../core/projects');
  const p = P.addProject(t.ws, { name: 'Case Example (FICTIONAL)', symbol: 'XCAS', official_website: 'https://case.example', coingecko_id: CG, assets: [{ chain: 'base', contract_address: TOKEN }], evidence: [{ url: 'https://case.example', note: 'fictional' }] });
  const pid = p.project_id;
  const a = F.createAudit(t.ws, { project_id: pid, assistant: 'claude' });
  const s = F.saveReport(t.ws, { project_id: pid, audit_id: a.audit_id, provider: 'claude', text: FX.reportText(a.audit) });
  const key = F.view(t.ws, pid).monitoring.proposed.exit_quotes.find((o) => o.chain === 'base').key;
  F.setMonitoring(t.ws, pid, { approve_quotes: [key], enabled: true });
  const S = require('../core/screening');
  const contracts = S.contractsOf(P.getProject(t.ws, pid).identity);
  const price = (ms, usd) => atomicWrite(path.join(t.ws.root, 'market-data', 'latest.json'), jsonText({ provider: 'coingecko', assets: { [CG]: { id: CG, price_usd: usd, source_last_updated_at: at(ms), fetched_at: at(ms) } } }));
  fs.mkdirSync(path.join(t.ws.root, 'market-data', 'screening'), { recursive: true });
  const now = Date.now();
  atomicWrite(path.join(t.ws.root, 'market-data', 'screening', `${pid}.json`), jsonText({ schema_version: 'cr.screening-project.v1', project_id: pid, contracts_key: S.contractsKey(contracts), snapshot: { fetched_at: at(now), contracts: contracts.filter((c) => c.screenable).map((c) => ({ chain: c.chain, chain_id: c.chain_id, label: c.label, family: c.family, address: c.address, status: 'ok', checked_at: at(now), checks: {}, taxes: { buy_pct: 0, sell_pct: taxPct }, severe: [], watch: [], unknown: [], notes: [] })) }, last_attempt: { at: at(now), outcome: 'ok' }, transitions: [] }));
  const fetchImpl = async (u) => {
    const url = new URL(u);
    const amountIn = url.searchParams.get('amountIn');
    const sold = (Number(amountIn) / 1e6) * 2;
    const body = { code: 0, data: { routeSummary: { tokenIn: url.searchParams.get('tokenIn'), tokenOut: url.searchParams.get('tokenOut'), amountIn, amountOut: String(Math.floor(sold * 0.98 * 1e6)), amountInUsd: String(sold), amountOutUsd: String(sold * 0.98), gasUsd: '0.05', route: [[{ exchange: 'fictional-dex' }]] } } };
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  const cgGetImpl = async () => ({ id: CG, detail_platforms: { base: { decimal_place: 6, contract_address: TOKEN } } });
  price(now - 60000, 2);
  await monitor.refresh(t.ws, { now, fetchImpl, cgGetImpl, sleep: async () => {} });
  return { ...t, pid, s, a, now };
}

test('case: a fictional package verifies and reproduces its exit offline; nothing is written or asked', async (t) => {
  const x = await caseSetup('case-ok');
  t.after(x.cleanup);
  const before = hashTree(path.join(x.root, 'projects'));
  const real = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; throw new Error('off'); };
  let pkg;
  try { pkg = C.buildCase(x.ws, x.pid, x.s.receipt_id); } finally { global.fetch = real; }
  assert.equal(calls, 0, 'building asks no provider or model');
  assert.deepEqual(hashTree(path.join(x.root, 'projects')), before, 'building writes nothing');
  const m = pkg.manifest;
  assert.equal(m.receipt.receipt_id, x.s.receipt_id);
  assert.deepEqual(m.artifacts.map((a) => a.role).sort(), ['evidence_packet', 'frozen_prompt', 'observation_log', 'original_report', 'receipt_record'].sort());
  assert.equal(m.pins.text_sha256, x.s.receipt.text.sha256);
  const calc = m.calculation;
  assert.equal(calc.status, 'supported');
  assert.equal(calc.inputs.chain_id, '8453');
  assert.equal(calc.inputs.contract_address, TOKEN);
  assert.equal(calc.inputs.token.decimals, 6);
  assert.equal(calc.inputs.amount_in, '250000000', '$500 at $2 is 250 tokens of 6 decimals');
  assert.equal(calc.inputs.tax.pct, 0);
  assert.equal(calc.result.cost_complete, true);
  assert.match(calc.basis.gas, /external/);
  assert.ok(m.missing.some((x) => /source S1/.test(x.what) && /not preserved/.test(x.reason)), 'missing source pages are listed, never shown as their hash');
  // Through a file, as a second reader would, with no workspace at all.
  const v = C.verifyCase(JSON.parse(JSON.stringify(pkg)));
  assert.equal(v.status, 'verified', JSON.stringify(v.problems.concat(v.corrupt)));
  assert.equal(v.calculation.status, 'reproduced');
  assert.equal(v.calculation.quantity.matches, true);
  assert.ok(v.missing.length >= 4);
});

test('case: an altered artifact, manifest, observation or calculation fails verification', async (t) => {
  const x = await caseSetup('case-alter');
  t.after(x.cleanup);
  const pkg = C.buildCase(x.ws, x.pid, x.s.receipt_id);
  const copy = () => JSON.parse(JSON.stringify(pkg));
  const a = copy();
  a.files.find((f) => f.path === 'original/report.md').content += ' ';
  const va = C.verifyCase(a);
  assert.equal(va.status, 'failed');
  assert.ok(va.corrupt.some((c) => c.path === 'original/report.md'));
  const b = copy();
  b.manifest.calculation.result.cost_pct = 0.01;
  assert.match(C.verifyCase(b).problems.join(' '), /manifest does not match/);
  const c = copy();
  const obs = JSON.parse(c.files.find((f) => f.path === 'observations/monitor.json').content);
  obs[0].size_usd = 99999;
  const f = c.files.find((y) => y.path === 'observations/monitor.json');
  f.content = JSON.stringify(obs);
  assert.equal(C.verifyCase(c).status, 'failed');
  // A receipt record whose stored assessment no longer matches its block.
  const d = copy();
  const rf = d.files.find((y) => y.path === 'receipt/receipt.json');
  const rec = JSON.parse(rf.content);
  rec.assessment.plain_assessment = 'FICTIONAL TAMPER';
  rf.content = JSON.stringify(rec);
  rf.sha256 = require('../core/fsx').sha256(rf.content);
  d.manifest.artifacts.find((y) => y.path === 'receipt/receipt.json').sha256 = rf.sha256;
  d.manifest_sha256 = C.manifestHash(d.manifest);
  assert.match(C.verifyCase(d).problems.join(' '), /stored assessment does not match its original block/);
});

test('case: an older receipt exports itself; unknown tax stays unknown; unbound identity stays unbound; no private markers', async (t) => {
  const x = await caseSetup('case-older', { taxPct: 10 });
  t.after(x.cleanup);
  // Private records that must never travel with a case (FICTIONAL).
  const pf = require('../core/portfolio');
  pf.addAccount(x.ws, { account_id: 'acct-fictional', name: 'Fictional exchange', kind: 'exchange' });
  const W = require('../core/wallets');
  W.addWallet(x.ws, { label: 'Fictional wallet', address: '0x00000000000000000000000000000000000c0ffe', networks: ['eth'] });
  const a2 = F.createAudit(x.ws, { project_id: x.pid, assistant: 'claude', refresh: true });
  const s2 = F.saveReport(x.ws, { project_id: x.pid, audit_id: a2.audit_id, provider: 'claude', text: FX.reportText(a2.audit, { plain_assessment: 'FICTIONAL. A later assessment.' }) });
  const pkg = C.buildCase(x.ws, x.pid, x.s.receipt_id);
  assert.equal(pkg.manifest.receipt.receipt_id, x.s.receipt_id, 'the selected older receipt, not the latest');
  assert.notEqual(pkg.manifest.receipt.receipt_id, s2.receipt_id);
  const report = pkg.files.find((f) => f.path === 'original/report.md').content;
  assert.ok(!report.includes('A later assessment'));
  assert.equal(C.verifyCase(pkg).status, 'verified');
  // 10% tax: the cost is a lower bound, never complete.
  assert.equal(pkg.manifest.calculation.result.cost_complete, false);
  assert.match(pkg.manifest.calculation.basis.tax, /not applied/);
  // The fixture's own liquidity readings are on another chain: unbound, listed.
  assert.ok(pkg.manifest.not_counted.some((n) => n.measure === 'liquidity' && /not a chain of this project's identity|names no token contract/.test(n.reason)));
  const text = JSON.stringify(pkg);
  for (const marker of ['0x00000000000000000000000000000000000c0ffe', 'acct-fictional', 'Fictional exchange', 'secrets', 'x-cr-token', 'portfolio/']) assert.ok(!text.includes(marker), `no ${marker} in a case package`);
  // A receipt that disagrees with its original makes no package.
  const file = x.ws.abs(F.receiptRel(x.pid, s2.receipt_id));
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  r.assessment.plain_assessment = 'FICTIONAL TAMPER';
  atomicWrite(file, jsonText(r));
  assert.throws(() => C.buildCase(x.ws, x.pid, s2.receipt_id), (e) => e.code === 'INTEGRITY');
});

test('case: no calculation without a bound reading is said, not invented', (t) => {
  const tw = tempWorkspace('case-none');
  t.after(tw.cleanup);
  const p = require('./helpers').addFixtureProject(tw.ws);
  const a = F.createAudit(tw.ws, { project_id: p.project_id, assistant: 'claude' });
  const s = F.saveReport(tw.ws, { project_id: p.project_id, audit_id: a.audit_id, provider: 'claude', text: FX.reportText(a.audit) });
  const pkg = C.buildCase(tw.ws, p.project_id, s.receipt_id);
  assert.equal(pkg.manifest.calculation.status, 'unavailable');
  assert.ok(pkg.manifest.missing.some((m) => m.what === 'an exit calculation'));
  const v = C.verifyCase(pkg);
  assert.equal(v.status, 'verified');
  assert.equal(v.calculation.status, 'unavailable');
});

test('case: the CLI builds a package into a file and verifies it offline', async (t) => {
  const x = await caseSetup('case-cli');
  t.after(x.cleanup);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-test-case-')), 'case.json');
  t.after(() => fs.rmSync(path.dirname(out), { recursive: true, force: true }));
  const cli = path.join(__dirname, '..', 'cli.js');
  const built = cp.spawnSync(process.execPath, [cli, 'forensics', 'case', x.pid, x.s.receipt_id, '--out', out, '--workspace', x.root, '--json'], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const ok = cp.spawnSync(process.execPath, [cli, 'forensics', 'case-verify', '--file', out, '--workspace', x.root, '--json'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr || ok.stdout);
  assert.match(ok.stdout, /"status": "verified"/);
  const pkg = JSON.parse(fs.readFileSync(out, 'utf8'));
  pkg.files[0].content += 'x';
  fs.writeFileSync(out, JSON.stringify(pkg));
  const bad = cp.spawnSync(process.execPath, [cli, 'forensics', 'case-verify', '--file', out, '--workspace', x.root, '--json'], { encoding: 'utf8' });
  assert.match(bad.stdout, /"status": "failed"/);
});
