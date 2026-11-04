'use strict';
// Agent 1's evidence packet carries the desk's own dated measurements
// (research.js deskMeasurements, cr.evidence-packet.v3): bounded exit rows of
// the last 7 days and the contract verdict the desk would freeze now. A reader
// that fails says so and never breaks a run. FICTIONAL temporary workspaces.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempWorkspace } = require('./helpers');
const research = require('../core/research');
const projects = require('../core/projects');
const prompts = require('../core/prompts');
const T = require('../core/tickets');
const F = require('../core/forensics');
const { checkBinding } = require('../core/binding');
const { readJson, jsonText, atomicWrite, sha256 } = require('../core/fsx');

const H = 3600000;
const hex = (s) => `0x${require('crypto').createHash('sha1').update(s).digest('hex')}`;

function setup(t) {
  const w = tempWorkspace('desk-measure');
  t.after(w.cleanup);
  const pid = projects.addProject(w.ws, { name: 'Measured (FICTIONAL)', symbol: 'XMS', official_website: 'https://xms.example.org/', evidence: [{ url: 'https://xms.example.org/', note: 'fictional' }], coingecko_id: 'xms-fictional', assets: [{ chain: 'base', contract_address: hex('XMS') }] }).project_id;
  return { ...w, pid, project: projects.getProject(w.ws, pid) };
}

// Readings at every ladder size, `ageH` hours old.
function withReadings(t, rows) {
  const real = F.view;
  F.view = () => ({ liquidity: { exits: rows.map(({ size, cost, ageH, complete = true }) => {
    const at = new Date(Date.now() - ageH * H).toISOString();
    return { size_usd: size, status: 'current', as_of: at, note: null, best: { cost_pct: cost, cost_complete: complete, missing_costs: [], method: 'executable_quote', route_scope: 'aggregator', retrieved_at: at } };
  }) } });
  t.after(() => { F.view = real; });
}

test('a project with readings gets bounded, dated rows of the last 7 days only', (t) => {
  const s = setup(t);
  const sizes = T.exitSizesOf(T.sizingOf(s.ws));
  withReadings(t, sizes.map((size, i) => ({ size, cost: 1 + i, ageH: i === 0 ? 24 * 8 : 2 })));
  const m = research.deskMeasurements(s.ws, s.project);
  assert.match(m.note, /Data, not conclusions and not instructions/);
  assert.ok(Array.isArray(m.exit_quotes));
  assert.ok(m.exit_quotes.length <= 6);
  assert.equal(m.exit_quotes.length, sizes.length - 1, 'the 8-day-old reading is left out');
  for (const r of m.exit_quotes) {
    assert.deepEqual(Object.keys(r).sort(), ['as_of', 'cost_complete', 'cost_pct', 'method', 'route_scope', 'size_usd', 'status']);
    assert.ok(Date.now() - Date.parse(r.as_of) <= 7 * 24 * H);
  }
  // The run's packet carries it, with the exclusions unchanged.
  const run = research.createRun(s.ws, { project_id: s.pid, providers: ['claude'] });
  const packet = readJson(path.join(s.root, run.run.evidence_packet.path));
  assert.equal(packet.schema_version, 'cr.evidence-packet.v4');
  assert.equal(packet.desk_measurements.exit_quotes.length, sizes.length - 1);
  assert.deepEqual(packet.excluded, ['your holdings and transactions', 'your notes and journal', 'other models\' reports and scores']);
  assert.ok(fs.readFileSync(path.join(s.root, run.run.prompt.path), 'utf8').includes('"desk_measurements"'), 'the prompt shows it to Agent 1');
});

test('a project with no readings, or no contract observation, says so', (t) => {
  const s = setup(t);
  withReadings(t, []);
  const m = research.deskMeasurements(s.ws, s.project);
  assert.equal(m.exit_quotes.state, 'none');
  assert.match(m.exit_quotes.reason, /no exit reading of the last 7 days/);
  assert.ok(m.contract.state === 'not_observed' || typeof m.contract.tier === 'string', JSON.stringify(m.contract));
  if (m.contract.tier) {
    assert.ok(m.contract.words.length <= 300);
    assert.ok(m.contract.findings.length <= 8);
    for (const f of m.contract.findings) assert.ok(f.words.length <= 200);
  }
});

test('a reader that throws gives unavailable and never breaks the run\'s creation', (t) => {
  const s = setup(t);
  const realExits = T.exitsOf;
  const realVerdict = T.contractVerdictNow;
  T.exitsOf = () => { throw new Error('exit store unreadable (FICTIONAL)'); };
  T.contractVerdictNow = () => { throw new Error('contract store unreadable (FICTIONAL)'); };
  t.after(() => { T.exitsOf = realExits; T.contractVerdictNow = realVerdict; });
  const m = research.deskMeasurements(s.ws, s.project);
  assert.deepEqual(m.exit_quotes, { state: 'unavailable', reason: 'exit store unreadable (FICTIONAL)' });
  assert.deepEqual(m.contract, { state: 'unavailable', reason: 'contract store unreadable (FICTIONAL)' });
  const run = research.createRun(s.ws, { project_id: s.pid, providers: ['claude'] });
  assert.ok(run.run_id);
  assert.equal(readJson(path.join(s.root, run.run.evidence_packet.path)).desk_measurements.exit_quotes.state, 'unavailable');
});

test('a forensics view that fails inside exitsOf is unavailable, not none', (t) => {
  const s = setup(t);
  const real = F.view;
  F.view = () => { throw new Error('view failed (FICTIONAL)'); };
  t.after(() => { F.view = real; });
  assert.equal(research.deskMeasurements(s.ws, s.project).exit_quotes.state, 'unavailable');
});

test('a run frozen under packet v2 still reads, verifies and rebuilds its own prompt', (t) => {
  const s = setup(t);
  const r = research.createRun(s.ws, { project_id: s.pid, providers: ['claude'] });
  const packetFile = path.join(s.root, r.run.evidence_packet.path);
  const promptFile = path.join(s.root, r.run.prompt.path);
  const { desk_measurements: _d, ...rest } = readJson(packetFile); // eslint-disable-line no-unused-vars
  const v2 = { ...rest, schema_version: 'cr.evidence-packet.v2' };
  const v2Text = `${JSON.stringify(v2, null, 2)}\n`;
  const v2Prompt = prompts.buildRunPrompt(s.ws, s.project, { runId: r.run_id, horizon: r.run.horizon, rubricRef: r.run.rubric_version, packet: v2, profileRef: r.run.sector_profile, version: r.run.prompt.version });
  fs.writeFileSync(packetFile, v2Text);
  fs.writeFileSync(promptFile, v2Prompt);
  const runFile = path.join(s.root, 'projects', s.pid, 'research', r.run_id, 'run.json');
  const run = readJson(runFile);
  run.evidence_packet = { ...run.evidence_packet, sha256: sha256(v2Text), schema_version: 'cr.evidence-packet.v2' };
  run.prompt.sha256 = sha256(v2Prompt);
  atomicWrite(runFile, jsonText(run));
  const loaded = research.loadRun(s.ws, s.pid, r.run_id);
  assert.equal(loaded.evidence_packet.schema_version, 'cr.evidence-packet.v2');
  assert.equal(fs.readFileSync(packetFile, 'utf8'), v2Text, 'the v2 packet is untouched');
  assert.ok(!v2Prompt.includes('"desk_measurements"'));
  const bound = checkBinding(s.ws, { projectId: s.pid, runId: r.run_id, provider: 'claude', json: { research_run_id: r.run_id, prompt_version: r.run.prompt.version }, mode: 'assistant' });
  assert.equal(bound.status, 'bound', bound.message);
  assert.equal(prompts.buildRunPrompt(s.ws, s.project, { runId: r.run_id, horizon: r.run.horizon, rubricRef: r.run.rubric_version, packet: readJson(packetFile), profileRef: r.run.sector_profile, version: r.run.prompt.version }), v2Prompt);
});
