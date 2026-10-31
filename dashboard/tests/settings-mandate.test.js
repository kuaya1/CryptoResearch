'use strict';
// The paper mandate's settings (automation.autonomous_paper_loop and
// automation.mandate): the validator in server.js and tickets.js mandateOf.
// FICTIONAL temporary workspaces; nothing is sent anywhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempWorkspace } = require('./helpers');
const { validateSettingsPatch, applySettings } = require('../server');
const T = require('../core/tickets');
const { sha256 } = require('../core/fsx');
const { stableStringify } = require('../core/requests');

const DAY = 86400000;
const inDays = (n) => new Date(Date.now() + n * DAY).toISOString();

function setup(t, settings = {}) {
  const w = tempWorkspace('mandate-settings', settings);
  t.after(w.cleanup);
  return w.ws;
}

const invalid = (fn, re) => assert.throws(fn, (e) => e.code === 'INVALID' && (!re || re.test(e.message)));

test('defaults: the loop is off, the mandate has its default limits and no expiry, and mandateOf says why it is off', (t) => {
  const ws = setup(t);
  const a = ws.settings.automation;
  assert.equal(a.autonomous_paper_loop, false);
  assert.deepEqual(a.mandate, { expires_at: null, max_grants_per_day: 1, max_open_grants: 2, allowed_chains: ['ethereum', 'base', 'arbitrum', 'optimism', 'solana'] });
  const m = T.mandateOf(ws);
  assert.equal(m.on, false);
  assert.match(m.why, /is off/);
  assert.equal(m.max_grants_per_day, 1);
  assert.equal(m.max_open_grants, 2);
});

test('autonomous_paper_loop is on only for a strict true', (t) => {
  const ws = setup(t);
  const exp = inDays(3);
  assert.equal(validateSettingsPatch({ automation: { autonomous_paper_loop: 'true', mandate: { expires_at: exp } } }, ws).automation.autonomous_paper_loop, false);
  assert.equal(validateSettingsPatch({ automation: { autonomous_paper_loop: 1, mandate: { expires_at: exp } } }, ws).automation.autonomous_paper_loop, false);
  assert.equal(validateSettingsPatch({ automation: { autonomous_paper_loop: true, mandate: { expires_at: exp } } }, ws).automation.autonomous_paper_loop, true);
});

test('expires_at: null, or an ISO time in the future at most 30 days ahead', (t) => {
  const ws = setup(t);
  assert.equal(validateSettingsPatch({ automation: { mandate: { expires_at: null } } }, ws).automation.mandate.expires_at, null);
  const ok = validateSettingsPatch({ automation: { mandate: { expires_at: inDays(29.9) } } }, ws).automation.mandate.expires_at;
  assert.ok(Date.parse(ok) > Date.now());
  invalid(() => validateSettingsPatch({ automation: { mandate: { expires_at: inDays(-0.01) } } }, ws), /in the future/);
  invalid(() => validateSettingsPatch({ automation: { mandate: { expires_at: inDays(30.01) } } }, ws), /at most 30 days ahead/);
  invalid(() => validateSettingsPatch({ automation: { mandate: { expires_at: 'next tuesday' } } }, ws), /ISO-8601/);
  invalid(() => validateSettingsPatch({ automation: { mandate: { expires_at: Date.now() + DAY } } }, ws), /ISO-8601/);
});

test('max_grants_per_day and max_open_grants are whole numbers from 1 to 5', (t) => {
  const ws = setup(t);
  for (const k of ['max_grants_per_day', 'max_open_grants']) {
    for (const bad of [0, 6, 1.5, '2', null, -1]) invalid(() => validateSettingsPatch({ automation: { mandate: { [k]: bad } } }, ws), new RegExp(k));
    for (const good of [1, 3, 5]) assert.equal(validateSettingsPatch({ automation: { mandate: { [k]: good } } }, ws).automation.mandate[k], good);
  }
});

test('allowed_chains: 1 to 10 unique chains the desk knows; an alias of a named chain counts as a repeat', (t) => {
  const ws = setup(t);
  assert.deepEqual(validateSettingsPatch({ automation: { mandate: { allowed_chains: ['Ethereum', 'base'] } } }, ws).automation.mandate.allowed_chains, ['ethereum', 'base']);
  invalid(() => validateSettingsPatch({ automation: { mandate: { allowed_chains: [] } } }, ws), /1 to 10/);
  invalid(() => validateSettingsPatch({ automation: { mandate: { allowed_chains: 'ethereum' } } }, ws), /1 to 10/);
  invalid(() => validateSettingsPatch({ automation: { mandate: { allowed_chains: ['ethereum', 'base', 'arbitrum', 'optimism', 'solana', 'polygon', 'linea', 'scroll', 'blast', 'mantle', 'gnosis'] } } }, ws), /1 to 10/);
  invalid(() => validateSettingsPatch({ automation: { mandate: { allowed_chains: ['ethereum', 'not-a-chain'] } } }, ws), /not a chain the desk knows/);
  invalid(() => validateSettingsPatch({ automation: { mandate: { allowed_chains: ['ethereum', 'eth'] } } }, ws), /twice/);
  invalid(() => validateSettingsPatch({ automation: { mandate: { wallet: 'x' } } }, ws), /no setting wallet/);
});

test('cross-field: turning the loop on needs a future expiry, this patch\'s or the one saved', (t) => {
  const ws = setup(t);
  const words = 'Set automation.mandate.expires_at (at most 30 days ahead) to turn on the paper mandate.';
  assert.throws(() => validateSettingsPatch({ automation: { autonomous_paper_loop: true } }, ws), (e) => e.code === 'INVALID' && e.message === words);
  assert.throws(() => validateSettingsPatch({ automation: { autonomous_paper_loop: true, mandate: { expires_at: null } } }, ws), (e) => e.code === 'INVALID' && e.message === words);
  // With an expiry in the same patch.
  applySettings(ws, { automation: { autonomous_paper_loop: true, mandate: { expires_at: inDays(2) } } });
  assert.equal(ws.settings.automation.autonomous_paper_loop, true);
  // The defaults the patch did not name are kept by the merge.
  assert.equal(ws.settings.automation.mandate.max_open_grants, 2);
  // Saved expiry: a second "on" passes; clearing the expiry while on does not.
  validateSettingsPatch({ automation: { autonomous_paper_loop: true } }, ws);
  assert.throws(() => validateSettingsPatch({ automation: { mandate: { expires_at: null } } }, ws), (e) => e.message === words);
  // Pausing, or turning the loop off, never needs an expiry.
  validateSettingsPatch({ automation: { paused: true } }, ws);
  validateSettingsPatch({ automation: { autonomous_paper_loop: false, mandate: { expires_at: null } } }, ws);
});

test('mandateOf: on with the loop on, not paused, a future expiry, readable limits and no restored hold', (t) => {
  const ws = setup(t);
  applySettings(ws, { automation: { autonomous_paper_loop: true, mandate: { expires_at: inDays(7), max_grants_per_day: 2 } } });
  const m = T.mandateOf(ws);
  assert.equal(m.on, true, m.why);
  assert.equal(m.why, null);
  assert.equal(m.version, 'cr-paper-mandate@1');
  assert.equal(m.max_grants_per_day, 2);
  assert.equal(m.max_open_grants, 2);
  assert.deepEqual(m.allowed_chains, ['ethereum', 'base', 'arbitrum', 'optimism', 'solana']);
  assert.equal(m.settings_sha256, sha256(stableStringify(ws.settings.automation.mandate)));
  // Expired by the clock.
  const later = T.mandateOf(ws, Date.now() + 8 * DAY);
  assert.equal(later.on, false);
  assert.match(later.why, /expired/);
});

test('mandateOf: paused, a restored copy on hold, or an unparsable limit keeps it off', (t) => {
  const ws = setup(t);
  applySettings(ws, { automation: { autonomous_paper_loop: true, mandate: { expires_at: inDays(7) } } });
  assert.equal(T.mandateOf(ws).generation, 1);
  applySettings(ws, { automation: { paused: true } });
  assert.match(T.mandateOf(ws).why, /paused/);
  // Pausing revoked generation 1; resuming does not arm it again.
  applySettings(ws, { automation: { paused: false } });
  assert.equal(T.mandateOf(ws).on, false);
  assert.match(T.mandateOf(ws).why, /generation 1 was revoked at .*arm it again/);
  // Only a new arming does, under a new generation.
  applySettings(ws, { automation: { mandate: { expires_at: inDays(7) } } });
  assert.deepEqual([T.mandateOf(ws).on, T.mandateOf(ws).generation], [true, 2]);
  // A hand-edited limit that does not read.
  const file = path.join(ws.root, 'config', 'settings.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.automation.mandate.max_open_grants = 'two';
  fs.writeFileSync(file, JSON.stringify(saved));
  ws.reloadSettings();
  const m = T.mandateOf(ws);
  assert.equal(m.on, false);
  assert.match(m.why, /max_open_grants/);
  saved.automation.mandate.max_open_grants = 2;
  saved.automation.mandate.expires_at = new Date(Date.now() + 45 * DAY).toISOString();
  fs.writeFileSync(file, JSON.stringify(saved));
  ws.reloadSettings();
  assert.match(T.mandateOf(ws).why, /more than 30 days ahead/);
  saved.automation.mandate.expires_at = inDays(7);
  fs.writeFileSync(file, JSON.stringify(saved));
  ws.reloadSettings();
  assert.equal(T.mandateOf(ws).on, true);
  // A restored copy on hold.
  fs.writeFileSync(path.join(ws.root, 'config', 'restored-copy.json'), JSON.stringify({ restored_at: new Date().toISOString(), research_held: true }));
  const held = T.mandateOf(ws);
  assert.equal(held.on, false);
  assert.match(held.why, /restored copy/);
});

test('the mandate tiers: halve from 50 up to 55, approve from 55, nothing under 50', () => {
  assert.equal(T.mandateTierOf(49.99), null);
  assert.equal(T.mandateTierOf(null), null);
  assert.deepEqual(T.mandateTierOf(50), { name: 'exploratory_50_54', action: 'halve' });
  assert.deepEqual(T.mandateTierOf(54.99), { name: 'exploratory_50_54', action: 'halve' });
  assert.deepEqual(T.mandateTierOf(55), { name: 'standard_55_plus', action: 'approve' });
  assert.equal(T.MANDATE_MIN_GRADE, 50);
});
