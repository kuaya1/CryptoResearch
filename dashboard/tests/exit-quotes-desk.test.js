'use strict';
// Exit quotes on every project in one click (2026-10-21): each verified
// project's first quotable contract is approved as its exit-quote target and
// monitoring turned on, exactly as the Forensics tab approves one; a project
// with a monitoring choice of Eric's is left as it is. Fictional projects and
// addresses; nothing is fetched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { tempWorkspace } = require('./helpers');
const forensics = require('../core/forensics');
const projects = require('../core/projects');

const hex = (s) => `0x${require('crypto').createHash('sha1').update(s).digest('hex')}`;

function desk(t) {
  const d = tempWorkspace('xq-desk');
  t.after(d.cleanup);
  const add = (name, symbol, extra) => projects.addProject(d.ws, { name, symbol, official_website: `https://${symbol.toLowerCase()}.example.org/`, evidence: [{ url: `https://${symbol.toLowerCase()}.example.org/`, note: 'fictional' }], ...extra }).project_id;
  return {
    ...d,
    base: add('Base Token (FICTIONAL)', 'XBT', { coingecko_id: 'base-token-fictional', assets: [{ chain: 'base', contract_address: hex('FICTIONAL-BASE') }] }),
    native: add('Native Chain (FICTIONAL)', 'XNC', { coingecko_id: 'native-chain-fictional', native_chain: true }),
    odd: add('Odd Chain (FICTIONAL)', 'XOC', { coingecko_id: 'odd-chain-fictional', assets: [{ chain: 'example-chain', contract_address: 'FICTIONAL-ODD' }] }),
    off: add('Switched Off (FICTIONAL)', 'XSO', { coingecko_id: 'switched-off-fictional', assets: [{ chain: 'ethereum', contract_address: hex('FICTIONAL-OFF') }] }),
  };
}

test('exit quotes for the desk: the plan names what it adds, what it leaves and why the rest cannot be quoted', (t) => {
  const d = desk(t);
  // Eric approved and then turned off monitoring on one project: it stays off.
  const offKey = require('../core/exitquotes').quoteOptions(projects.getProject(d.ws, d.off)).find((o) => o.supported).key;
  forensics.setMonitoring(d.ws, d.off, { enabled: true, approve_quotes: [offKey], by: 'test' });
  forensics.setMonitoring(d.ws, d.off, { enabled: false, by: 'test' });
  const plan = forensics.exitQuotePlan(d.ws);
  assert.deepEqual(plan.add.map((x) => [x.project_id, x.chain, x.source]), [[d.base, 'Base', 'KyberSwap']]);
  assert.deepEqual(plan.kept.map((x) => x.project_id), [d.off]);
  const none = Object.fromEntries(plan.none.map((x) => [x.project_id, x.reason]));
  assert.match(none[d.native], /native coin/);
  assert.match(none[d.odd], /not a chain this desk recognizes/);
  // Reading the plan writes nothing.
  assert.equal(fs.existsSync(path.join(d.root, 'projects', d.base, 'forensics')), false);
});

test('exit quotes for the desk: approving adds one quote target and turns monitoring on, nothing else; again it changes nothing', (t) => {
  const d = desk(t);
  forensics.setMonitoring(d.ws, d.off, { enabled: true, approve_quotes: [require('../core/exitquotes').quoteOptions(projects.getProject(d.ws, d.off)).find((o) => o.supported).key], by: 'test' });
  forensics.setMonitoring(d.ws, d.off, { enabled: false, by: 'test' });
  const out = forensics.approveAllExitQuotes(d.ws, { by: 'test' });
  assert.deepEqual(out.added.map((x) => x.project_id), [d.base]);
  const prof = forensics.readProfile(d.ws, d.base);
  assert.equal(prof.monitoring.enabled, true);
  assert.equal(prof.targets.exit_quotes.length, 1);
  assert.equal(prof.targets.exit_quotes[0].provider, 'kyberswap');
  assert.deepEqual([prof.targets.product_checks.length, prof.targets.repositories.length], [0, 0], 'no product check or repository is ever added');
  // The project Eric switched off stays off.
  assert.equal(forensics.readProfile(d.ws, d.off).monitoring.enabled, false);
  // A second click adds nothing.
  const again = forensics.approveAllExitQuotes(d.ws, { by: 'test' });
  assert.deepEqual(again.added, []);
  assert.ok(again.kept.some((x) => x.project_id === d.base && x.quoted));
});

let tmp;
async function load() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-xq-ui-'));
  fs.cpSync(path.join(__dirname, '..', 'public'), tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{ "type": "module" }');
  return import(pathToFileURL(path.join(tmp, 'watchlist-model.js')).href);
}
const wlMod = load();
test.after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test('exit cell: the figure says its basis, a quote or a pool\'s reserves; unknown stays unknown', async () => {
  const wl = await wlMod;
  const quoted = wl.exitCell({ forensic: { exit: { size_usd: 500, status: 'current', cost_pct: 1.234, cost_complete: true, method: 'executable_quote', route_scope: 'aggregator', limit_pct: 5, beyond: false, as_of: '2026-10-21T12:00:00Z' } } });
  assert.equal(quoted.text, '1.23%');
  assert.equal(quoted.basis, 'Quote');
  assert.match(quoted.title, /from an aggregator's executable quote/);
  const reserves = wl.exitCell({ forensic: { exit: { size_usd: 500, status: 'current', cost_pct: 7.5, cost_complete: false, missing_costs: ['network fee'], method: 'constant_product', limit_pct: 5, beyond: true } } });
  assert.equal(reserves.text, '≥ 7.50%');
  assert.equal(reserves.basis, 'Reserve est.');
  assert.equal(reserves.tone, 'bad');
  const none = wl.exitCell({});
  assert.equal(none.text, 'Unknown');
  assert.equal(none.basis, undefined);
});

test('tax note: a sell tax above zero beside bound DefiLlama revenue is said as two facts, never as a share', async () => {
  const wl = await wlMod;
  const bound = { state: 'fresh', metrics: {} };
  const taxed = { contracts: [{ chain: 'base', sell_tax_pct: 0 }, { chain: 'ethereum', sell_tax_pct: 4.5 }] };
  assert.match(wl.taxRevenueNote(taxed, bound), /^GoPlus reports a 4\.5% sell tax on this token: part of the revenue DefiLlama reports may be that tax/);
  assert.equal(wl.taxRevenueNote({ contracts: [{ sell_tax_pct: 0 }] }, bound), null, 'no tax');
  assert.equal(wl.taxRevenueNote(taxed, { state: 'unmapped' }), null, 'no DefiLlama entity');
  assert.equal(wl.taxRevenueNote(null, bound), null);
});
