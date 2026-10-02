'use strict';
// Test helpers: every test runs against a throwaway TEST workspace in the OS temp
// folder, never against your real records.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { initWorkspace, openWorkspace, DEFAULT_ROOT } = require('../core/workspace');
const { atomicWrite, jsonText } = require('../core/fsx');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

function tempWorkspace(label = 't', settings = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cr-test-${label}-`));
  initWorkspace(root, { kind: 'test', name: `test ${label}`, templatesFrom: path.join(DEFAULT_ROOT, 'templates') });
  atomicWrite(path.join(root, 'config', 'settings.json'), jsonText({ schema_version: 1, market_data: { enabled: false }, inbox: { settle_seconds: 0 }, requests: { settle_seconds: 0 }, ...settings }));
  const ws = openWorkspace({ root, actor: 'test' });
  return { root, ws, cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }) };
}

function addFixtureProject(ws) {
  const projects = require('../core/projects');
  return projects.addProject(ws, {
    name: 'Example PayFi (FICTIONAL)',
    symbol: 'XMPL',
    official_website: 'https://example.com/xmpl',
    coingecko_id: 'example-payfi-fictional',
    assets: [{ chain: 'example-chain', contract_address: 'FICTIONAL-CONTRACT-XMPL' }],
    evidence: [{ url: 'https://example.com/xmpl', note: 'fictional test evidence' }],
    sector_profile: 'payfi-credit@1',
  });
}

function dropFixture(ws, provider, fixtureName, asName = null) {
  const dest = path.join(ws.root, 'inbox', provider, asName || fixtureName);
  fs.copyFileSync(path.join(FIXTURES, 'reports', fixtureName), dest);
  return dest;
}

function dropText(ws, provider, name, text) {
  const dest = path.join(ws.root, 'inbox', provider, name);
  fs.writeFileSync(dest, text);
  return dest;
}

function hashTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

function importAllFixtures(ws) {
  const inbox = require('../core/inbox');
  dropFixture(ws, 'claude', 'example-payfi-fictional__claude.md');
  dropFixture(ws, 'chatgpt', 'example-payfi-fictional__chatgpt.md');
  dropFixture(ws, 'gemini', 'example-payfi-fictional__gemini.md');
  return inbox.scanInbox(ws, { force: true });
}

module.exports = { FIXTURES, tempWorkspace, addFixtureProject, dropFixture, dropText, hashTree, importAllFixtures };
