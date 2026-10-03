'use strict';
// One-time record repairs (core/repairs.js), against temporary workspaces that
// recreate the two records exactly as the live desk's start log showed them on
// 2026-10-03: "coinmarketcap" (a pasted CoinMarketCap link taken as the
// official website and its host as the name) and "sandbox" (added with its
// website only). The identity facts are the ones the repairs write; other
// identities are FICTIONAL.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempWorkspace, hashTree } = require('./helpers');
const projects = require('../core/projects');
const { runOp } = require('../core/ops');
const { readJson } = require('../core/fsx');
const { runRepairs } = require('../core/repairs');

const CMC_ID = '2026-10-03-coinmarketcap-duplicate';
const SANDBOX_ID = '2026-10-03-sandbox-identity';
const SAND = '0x3845badade8e6dff049820680d1f14bd3903a5d0';

// "coinmarketcap" as the dashboard's Add project form saved it before market
// listings were refused as websites: written as a record, since the desk no
// longer creates one like it.
function addLegacyCoinmarketcap(ws, { website = 'https://coinmarketcap.com/currencies/avantis/' } = {}) {
  const now = new Date().toISOString();
  const rec = {
    schema_version: 'cr.project.v1',
    project_id: 'coinmarketcap',
    name: 'Coinmarketcap',
    symbol: null,
    aliases: [],
    status: 'pending_identity',
    sector_profile: 'general-token@1',
    sector_note: null,
    identity: { status: 'pending', official_website: website, coingecko_id: null, assets: [], candidates: [], evidence: [], unknowns: ['Token not bound to a CoinGecko ID or contract.', 'No identity evidence URL recorded.'] },
    watchlist: { on_watchlist: true, added_at: now, removed_at: null },
    headline: null,
    tags: [],
    sector: null,
    review: null,
    research_defaults: null,
    created_at: now,
    updated_at: now,
    created_via: 'hosted',
    origin_request: null,
  };
  runOp(ws, { type: 'test_legacy_record', summary: 'recreate the live coinmarketcap record' }, (op) => {
    op.writeJson('projects/coinmarketcap/project.json', rec);
    op.writeJson('projects/coinmarketcap/events.json', { schema_version: 'cr.events.v1', events: [] });
  });
}

function addVeranta(ws, { coingeckoId = 'avantis' } = {}) {
  return projects.addProject(ws, {
    name: 'Veranta (formerly Avantis)',
    symbol: 'AVNT',
    official_website: 'https://www.veranta.xyz',
    coingecko_id: coingeckoId,
    assets: [{ chain: 'base', contract_address: '0x696f9436b67233384889472cd7cd58a6fb5df4f1' }],
    evidence: [{ url: 'https://www.veranta.xyz', note: 'test evidence' }],
  });
}

const addSandbox = (ws, website = 'https://www.sandbox.game/en/') => projects.addProject(ws, { name: 'Sandbox', official_website: website });

function setup(label, { cmc = true, veranta = 'avantis', sandbox = 'https://www.sandbox.game/en/' } = {}) {
  const t = tempWorkspace(label);
  if (veranta) addVeranta(t.ws, { coingeckoId: veranta });
  if (cmc) addLegacyCoinmarketcap(t.ws, typeof cmc === 'string' ? { website: cmc } : {});
  if (sandbox) addSandbox(t.ws, sandbox);
  return t;
}

const fileHash = (root, rel) => hashTree(path.join(root, path.dirname(rel)))[path.basename(rel)];

test('repairs: the two live records are fixed through the normal write paths, and only once', (t) => {
  const { ws, root, cleanup } = setup('repairs-live');
  t.after(cleanup);
  const verantaBefore = fileHash(root, 'projects/veranta-formerly-avantis/project.json');
  const lines = [];
  const results = runRepairs(ws, { log: (l) => lines.push(l) });
  assert.deepEqual(results.map((r) => [r.id, r.status]), [[CMC_ID, 'applied'], [SANDBOX_ID, 'applied']]);
  assert.deepEqual(lines, [
    `Repair ${CMC_ID}: applied (archived coinmarketcap as a duplicate of veranta-formerly-avantis)`,
    `Repair ${SANDBOX_ID}: applied (identity verified: the-sandbox)`,
  ]);

  // The duplicate is archived, with the reason; nothing is deleted.
  const cmc = projects.getProject(ws, 'coinmarketcap');
  assert.equal(cmc.status, 'archived');
  assert.match(cmc.archived_reason, /^Duplicate of Veranta \(formerly Avantis\): added from the CoinMarketCap link coinmarketcap\.com\/currencies\/avantis, which the Add project form took as the official website\. CoinGecko lists 'avantis' as Veranta \(AVNT\)\. Nothing was deleted; unarchive it on the project page if this is wrong\.$/);
  assert.equal(cmc.watchlist.on_watchlist, false);
  assert.equal(cmc.identity.official_website, 'https://coinmarketcap.com/currencies/avantis/', 'its identity is left as it was');
  assert.equal(fileHash(root, 'projects/veranta-formerly-avantis/project.json'), verantaBefore, 'Veranta untouched');

  // The Sandbox: verified with the binding and evidence the repair names.
  const sb = projects.getProject(ws, 'sandbox');
  assert.equal(sb.name, 'The Sandbox');
  assert.equal(sb.symbol, 'SAND');
  assert.equal(sb.status, 'active');
  assert.equal(sb.identity.status, 'verified');
  assert.equal(sb.identity.official_website, 'https://www.sandbox.game/en/');
  assert.equal(sb.identity.coingecko_id, 'the-sandbox');
  assert.deepEqual(sb.identity.assets.map((a) => [a.chain, a.contract_address, a.standard]), [['ethereum', SAND, 'ERC-20']]);
  assert.deepEqual(sb.identity.evidence.map((e) => [e.kind, e.url]), [['repair', 'https://www.coingecko.com/en/coins/the-sandbox'], ['repair', `https://etherscan.io/token/${SAND}`]]);
  assert.match(sb.identity.evidence[0].note, /checked 2026-10-03/);
  assert.ok(require('../core/market').trackedIds(ws).includes('the-sandbox'), 'now priced');

  // Recorded once, with the files each changed; attributed to the repair.
  const ledger = readJson(path.join(root, '.cr', 'repairs.json'));
  assert.ok(ledger.repairs[CMC_ID].applied_at);
  assert.ok(ledger.repairs[CMC_ID].files.includes('projects/coinmarketcap/project.json'));
  assert.equal(ledger.repairs[SANDBOX_ID].reason, 'identity verified: the-sandbox');
  assert.ok(ledger.repairs[SANDBOX_ID].files.includes('projects/sandbox/project.json'));
  const ops = fs.readFileSync(path.join(root, 'logs', 'operations.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(ops.some((o) => o.type === 'archive_project' && o.actor === 'repair'));

  // A second start does nothing at all.
  const before = hashTree(root);
  const lines2 = [];
  assert.deepEqual(runRepairs(ws, { log: (l) => lines2.push(l) }).map((r) => r.status), ['recorded_before', 'recorded_before']);
  assert.deepEqual(lines2, []);
  assert.deepEqual(hashTree(root), before);
});

test('repairs: the website variants the live record could have still match', (t) => {
  const { ws, cleanup } = setup('repairs-variants', { cmc: 'https://coinmarketcap.com/currencies/avantis', sandbox: 'https://sandbox.game/' });
  t.after(cleanup);
  assert.deepEqual(runRepairs(ws).map((r) => r.status), ['applied', 'applied']);
  assert.equal(projects.getProject(ws, 'coinmarketcap').status, 'archived');
  assert.equal(projects.getProject(ws, 'sandbox').identity.coingecko_id, 'the-sandbox');
});

test('repairs: a record in any other state is left untouched, and the repair is recorded as skipped', (t) => {
  // Veranta bound to another coin; Sandbox with another website.
  const { ws, root, cleanup } = setup('repairs-differ', { veranta: 'veranta-other-fictional', sandbox: 'https://sandbox-fictional.example/' });
  t.after(cleanup);
  const before = hashTree(path.join(root, 'projects'));
  const lines = [];
  const results = runRepairs(ws, { log: (l) => lines.push(l) });
  assert.deepEqual(results.map((r) => r.status), ['skipped', 'skipped']);
  assert.deepEqual(lines, [
    `Repair ${CMC_ID}: skipped: veranta-formerly-avantis is bound to CoinGecko "veranta-other-fictional", not "avantis"`,
    `Repair ${SANDBOX_ID}: skipped: sandbox's website is https://sandbox-fictional.example/, not sandbox.game`,
  ]);
  assert.deepEqual(hashTree(path.join(root, 'projects')), before, 'no record changed');
  const ledger = readJson(path.join(root, '.cr', 'repairs.json'));
  assert.ok(ledger.repairs[CMC_ID].skipped_at && !ledger.repairs[CMC_ID].applied_at);
  assert.deepEqual(ledger.repairs[SANDBOX_ID].files, []);
  // Skipped once means never tried again, even after the state changes.
  projects.updateIdentity(ws, 'veranta-formerly-avantis', { coingecko_id: 'avantis', evidence: [{ url: 'https://www.veranta.xyz', note: 'test' }] });
  assert.deepEqual(runRepairs(ws).map((r) => r.status), ['recorded_before', 'recorded_before']);
  assert.equal(projects.getProject(ws, 'coinmarketcap').status, 'pending_identity');
});

test('repairs: each precondition guards its record (reports, open research, archived, already verified, an identity already taken)', (t) => {
  const cases = [
    ['reports', (ws, root) => fs.mkdirSync(path.join(root, 'projects', 'coinmarketcap', 'reports', 'rep_fictional_0001'), { recursive: true }), CMC_ID, /coinmarketcap has reports/],
    ['open-run', (ws) => require('../core/research').createRun(ws, { project_id: 'coinmarketcap', providers: ['claude'], channel: 'dashboard' }), CMC_ID, /coinmarketcap has an open research run/],
    ['archived', (ws) => projects.archiveProject(ws, 'coinmarketcap', 'Eric archived it (FICTIONAL test)'), CMC_ID, /coinmarketcap is already archived/],
    ['veranta-missing', (ws, root) => fs.rmSync(path.join(root, 'projects', 'veranta-formerly-avantis'), { recursive: true }), CMC_ID, /veranta-formerly-avantis is not on the desk/],
    ['taken', (ws) => projects.addProject(ws, { name: 'Sandbox Copy (FICTIONAL)', official_website: 'https://copy-fictional.example/', coingecko_id: 'the-sandbox', evidence: [{ url: 'https://copy-fictional.example/' }] }), SANDBOX_ID, /sandbox-copy-fictional already has that identity \(same CoinGecko ID\)/],
    ['verified', (ws) => projects.updateIdentity(ws, 'sandbox', { coingecko_id: 'sandbox-fictional', evidence: [{ url: 'https://www.sandbox.game/en/' }] }), SANDBOX_ID, /sandbox's identity is already verified \(sandbox-fictional\)/],
  ];
  for (const [label, change, id, reason] of cases) {
    const { ws, root, cleanup } = setup(`repairs-${label}`);
    try {
      change(ws, root);
      const target = id === CMC_ID ? 'coinmarketcap' : 'sandbox';
      const before = fileHash(root, `projects/${target}/project.json`);
      const r = runRepairs(ws).find((x) => x.id === id);
      assert.equal(r.status, 'skipped', label);
      assert.match(r.reason, reason, label);
      assert.equal(fileHash(root, `projects/${target}/project.json`), before, `${label}: untouched`);
    } finally {
      cleanup();
    }
  }
});

test('repairs: on a workspace without those projects (the PC) nothing runs and nothing is recorded', (t) => {
  const { ws, root, cleanup } = setup('repairs-absent', { cmc: false, veranta: 'avantis', sandbox: false });
  t.after(cleanup);
  const lines = [];
  assert.deepEqual(runRepairs(ws, { log: (l) => lines.push(l) }).map((r) => r.status), ['not_here', 'not_here']);
  assert.deepEqual(lines, []);
  assert.equal(fs.existsSync(path.join(root, '.cr', 'repairs.json')), false);
});
