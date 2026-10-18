'use strict';
// The inspector's top pool (Level 1 risk strip, 2026-10-17): the index row's
// screened contracts go through rowProject into dexTargets, which answers
// { state, targets }; the inspector looks up the targets and names the
// state when there are none. Found live on 2026-10-17: the inspector read
// the answer as a list and said "no contract" for every project.
// FICTIONAL rows; no request is made.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

let tmp;
async function load() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-inspector-pool-'));
  fs.cpSync(path.join(__dirname, '..', 'public'), tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{ "type": "module" }');
  const wl = await import(pathToFileURL(path.join(tmp, 'watchlist-model.js')).href);
  const dex = await import(pathToFileURL(path.join(tmp, 'views', 'dex.js')).href);
  return { wl, dex };
}
const mods = load();
test.after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

const row = (extra) => ({ project_id: 'fictional', name: 'Fictional (FICTIONAL)', symbol: 'FCT', identity_status: 'verified', ...extra });

test('inspector pool: a verified row\'s screened contract becomes a lookup target; each case without one is named', async () => {
  const { wl, dex } = await mods;
  const addr = `0x${'ab'.repeat(20)}`;
  const t = dex.dexTargets(wl.rowProject(row({ screening: { contracts: [{ chain: 'bsc', address: addr }] } })));
  assert.equal(t.state, 'contract');
  assert.equal(t.targets.length, 1);
  assert.equal(t.targets[0].slug, 'bsc');
  assert.equal(t.targets[0].address, addr);
  assert.equal(dex.dexTargets(wl.rowProject(row({ identity_status: 'pending', screening: { contracts: [{ chain: 'bsc', address: addr }] } }))).state, 'unverified');
  assert.equal(dex.dexTargets(wl.rowProject(row({ screening: { native_chain: true, contracts: [] } }))).state, 'native');
  assert.equal(dex.dexTargets(wl.rowProject(row({ screening: { contracts: [] } }))).state, 'none');
  assert.equal(dex.dexTargets(wl.rowProject(row({ screening: { contracts: [{ chain: 'not-a-listed-chain', address: addr }] } }))).state, 'unmatched');
});

test('inspector pool: the inspector reads dexTargets\' targets and names every state it can answer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'views', 'inspector', 'ModelPanel.jsx'), 'utf8');
  assert.match(src, /const \{ state, targets \} = L\.dexTargets\(rowProject\(p\)\);/);
  for (const state of ['unverified', 'native', 'none', 'unmatched']) assert.match(src, new RegExp(`\\b${state}: '`), `the inspector names "${state}"`);
});
