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

// A measured exit at $100, $500 and $2,000 (the default screening ladder,
// cr-ticket-sizing@4) handed to a new ticket the way the
// Forensics projection hands it (tickets.js exitsOf reads forensics.view),
// for the duration of fn only, so it is frozen into the ticket's packet that
// the sizing gate reads. Fictional readings; nothing is fetched.
function withExitReadings(costPct, fn, { complete = true } = {}) {
  const F = require('../core/forensics');
  const real = F.view;
  const at = new Date().toISOString();
  const row = (size, cost) => ({ size_usd: size, status: 'current', as_of: at, note: null, best: { cost_pct: cost, cost_complete: complete, missing_costs: complete ? [] : ['network fee'], method: 'executable_quote', route_scope: 'aggregator', retrieved_at: at } });
  F.view = () => ({ liquidity: { exits: [row(100, costPct / 2), row(500, costPct), row(2000, costPct * 2)] } });
  try {
    return fn();
  } finally {
    F.view = real;
  }
}

// A stored price a minute old (market-data/latest.json), for a ticket's
// admission check at save. Fictional.
function freshPrice(ws, id, price, ageMs = 60000) {
  const file = ws.abs('market-data/latest.json');
  let cur = { assets: {} };
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* none yet */ }
  const at = new Date(Date.now() - ageMs).toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, jsonText({ ...cur, provider: 'coingecko', assets: { ...(cur.assets || {}), [id]: { id, price_usd: price, source_last_updated_at: at, fetched_at: at } } }));
}

// A model has one open research job on a project at a time (createRun's
// admission). A test that makes a later run for the same model first ends the
// earlier one's open jobs, as Eric would by canceling it.
function cancelOpenJobs(ws, projectId, providers = ['claude', 'chatgpt', 'gemini']) {
  const research = require('../core/research');
  for (const p of providers) for (const o of research.openJobsFor(ws, projectId, p)) research.cancelJob(ws, projectId, o.run.run_id, p, 'FICTIONAL: a later run for the same model');
}

// Records made before that rule can still hold several open jobs for one
// model. A test that needs that state makes its later runs with the earlier
// open jobs set aside on disk, then puts them back as they were.
const OPEN_JOB_STATES = ['unconfigured', 'queued', 'dispatching', 'running', 'uncertain'];
function withOpenJobsSetAside(ws, projectId, fn) {
  const research = require('../core/research');
  const aside = [];
  for (const r of research.listRuns(ws, projectId)) {
    const file = ws.abs(`projects/${projectId}/research/${r.run_id}/run.json`);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const open = Object.entries(doc.jobs || {}).filter(([, j]) => OPEN_JOB_STATES.includes(j.state));
    if (!open.length) continue;
    for (const [p, j] of open) { aside.push([file, p, j.state]); j.state = 'canceled'; }
    atomicWrite(file, jsonText(doc));
  }
  try {
    return fn();
  } finally {
    for (const [file, p, state] of aside) {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      doc.jobs[p].state = state;
      atomicWrite(file, jsonText(doc));
    }
  }
}

module.exports = { FIXTURES, tempWorkspace, addFixtureProject, dropFixture, dropText, hashTree, importAllFixtures, withExitReadings, freshPrice, cancelOpenJobs, withOpenJobsSetAside };
