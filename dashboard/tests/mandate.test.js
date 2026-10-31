'use strict';
// The paper mandate's sweep (tickets.js mandateSweep, autonomous paper
// playbook Stage 7): what it grants, what it re-opens, what it skips and why,
// its caps and its lease, and its place in the trader job. The contract's
// live evidence (R4) is read through T.mandateContractEvidence, stubbed here
// to pass or to say why; its own logic is tested on its own below. FICTIONAL
// temporary workspaces, tickets, pairs and contracts only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const T = require('../core/tickets');
const TD = require('../core/trader-desk');
const F = require('../core/forensics');
const projects = require('../core/projects');
const leases = require('../core/leases');
const { withExitReadings } = require('./helpers');
const { mandateDesk, saveTicket, inDays } = require('./mandate-fixture');

const H = 3600000;
const BY = 'mandate:cr-paper-mandate@1';
const ADDR = '0x00000000000000000000000000000000000a11ce';

// The contract evidence R4 reads: null passes, words skip.
const REAL_EVIDENCE = T.mandateContractEvidence;
function contractEvidence(t, words = null) {
  T.mandateContractEvidence = () => (typeof words === 'function' ? words() : words);
  t.after(() => { T.mandateContractEvidence = REAL_EVIDENCE; });
}

function rewriteIdentity(ws, pid, fn) {
  const file = ws.abs(`projects/${pid}/project.json`);
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  fn(p.identity, p);
  fs.writeFileSync(file, JSON.stringify(p, null, 2));
}

function pilotOn(ws, pid) {
  const file = ws.abs(`projects/${pid}/tickets/profile.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema_version: 'cr.ticket-profile.v1', project_id: pid, pilot: true, pilot_set_at: new Date().toISOString(), pilot_set_by: 'eric' }));
}

// A pilot desk whose token is on Base (fictional address), the mandate on,
// the contract's evidence passing, and a Prosecutor's ticket saved.
function sweepDesk(t, { grade = 60, settings = {}, mandate = true, exits = true, evidence = null, pilot = true } = {}) {
  const s = mandateDesk(t, { grade, mandate, settings });
  rewriteIdentity(s.ws, s.pid, (id) => { id.assets = [{ chain: 'base', contract_address: ADDR }]; });
  if (pilot) pilotOn(s.ws, s.pid);
  contractEvidence(t, evidence);
  const r = saveTicket(s.ws, s.pid, { exits });
  return { ...s, r };
}

const linesOf = (ws, pid) => T.readDecisions(ws, pid);
const skippedBy = (out, rule) => out.skipped.filter((x) => x.rule === rule);

test('off, paused, expired or a restored copy: the sweep grants nothing and says why', (t) => {
  const off = sweepDesk(t, { mandate: false });
  const a = T.mandateSweep(off.ws);
  assert.equal(a.status, 'skipped');
  assert.match(a.why, /off/);
  assert.deepEqual(linesOf(off.ws, off.pid), []);

  const s = sweepDesk(t);
  s.ws.settings.automation.paused = true;
  assert.match(T.mandateSweep(s.ws).why, /paused/);
  s.ws.settings.automation.paused = false;
  s.ws.settings.automation.mandate.expires_at = new Date(Date.now() - 60000).toISOString();
  assert.match(T.mandateSweep(s.ws).why, /expired/);
  s.ws.settings.automation.mandate.expires_at = inDays(31);
  assert.match(T.mandateSweep(s.ws).why, /more than 30 days ahead/);
  s.ws.settings.automation.mandate.expires_at = inDays(7);
  const research = require('../core/research');
  const realHold = research.restoredHold;
  research.restoredHold = () => ({ restored_at: new Date().toISOString() });
  try { assert.match(T.mandateSweep(s.ws).why, /restored copy/); } finally { research.restoredHold = realHold; }
  assert.deepEqual(linesOf(s.ws, s.pid), [], 'nothing was recorded by any of them');
});

test('a grade of 55 is approved at 1.0R; the decision is the mandate\'s, with its tier and expiry', (t) => {
  const s = sweepDesk(t, { grade: 55 });
  const out = T.mandateSweep(s.ws);
  assert.equal(out.status, 'ok');
  assert.equal(out.granted.length, 1, JSON.stringify(out.skipped));
  const g = out.granted[0];
  assert.deepEqual([g.receipt_id, g.action, g.tier, g.grade, g.risk_usd, g.pair], [s.r.receipt_id, 'approve', 'standard_55_plus', 55, 500, 'XMPL/USDC']);
  const d = linesOf(s.ws, s.pid).find((l) => l.decision_id === g.decision_id);
  assert.equal(d.decided_by, BY);
  assert.equal(d.request_id, `mandate_${s.r.receipt_id}`);
  assert.deepEqual([d.mandate.tier, d.mandate.grade_used, d.mandate.expires_at], ['standard_55_plus', 55, s.ws.settings.automation.mandate.expires_at]);
  assert.equal(d.effects.paper, null, 'the PM Cohort book measures Eric\'s decisions only');
  assert.equal(d.effects.trader, 'open');
  assert.match(out.message, /1 granted, 0 re-opened/);
  // Again: the ticket has a decision now (R3), and nothing is recorded twice.
  const again = T.mandateSweep(s.ws);
  assert.equal(again.granted.length, 0);
  assert.equal(linesOf(s.ws, s.pid).length, 1);
});

test('grades 50.00 and 54.99 are halved (0.5R, exploratory)', (t) => {
  for (const grade of [50, 54.99]) {
    const s = sweepDesk(t, { grade });
    const out = T.mandateSweep(s.ws);
    assert.equal(out.granted.length, 1, `${grade}: ${JSON.stringify(out.skipped)}`);
    assert.deepEqual([out.granted[0].action, out.granted[0].tier, out.granted[0].risk_usd], ['halve', 'exploratory_50_54', 250], String(grade));
  }
});

test('a grade under 50 grants nothing, even with the desk\'s floor set to 40 (R2)', (t) => {
  const s = sweepDesk(t, { grade: 45, settings: { tickets: { sizing: { min_grade_new_entry: 40 } } } });
  assert.equal(s.r.desk.gate.risk_allowed, true, 'the desk itself would allow it');
  const out = T.mandateSweep(s.ws);
  assert.equal(out.granted.length, 0);
  assert.match(skippedBy(out, 'R2')[0].words, /grade is 45, under the paper mandate's floor of 50/);
});

test('a $0 ticket (no exit) is not granted (R2); a non-pilot project is not looked at', (t) => {
  const s = sweepDesk(t, { exits: false });
  const out = T.mandateSweep(s.ws);
  assert.equal(out.granted.length, 0);
  assert.match(skippedBy(out, 'R2')[0].words, /nothing to grant/);
  const quiet = sweepDesk(t, { pilot: false });
  const q = T.mandateSweep(quiet.ws);
  assert.deepEqual([q.granted.length, q.skipped.length], [0, 0]);
});

test('Eric\'s veto first, or his approve then undo: the mandate never grants that ticket (R3)', (t) => {
  const v = sweepDesk(t);
  T.decide(v.ws, v.pid, { receipt_id: v.r.receipt_id, action: 'veto', request_id: 'req_mandate_veto1', by: 'eric' });
  const a = T.mandateSweep(v.ws);
  assert.equal(a.granted.length, 0);
  assert.match(skippedBy(a, 'R3')[0].words, /already has a decision/);

  const u = sweepDesk(t);
  T.decide(u.ws, u.pid, { receipt_id: u.r.receipt_id, action: 'approve', request_id: 'req_mandate_appr1', by: 'eric' });
  T.decide(u.ws, u.pid, { receipt_id: u.r.receipt_id, action: 'undo', request_id: 'req_mandate_undo1', by: 'eric' });
  const b = T.mandateSweep(u.ws);
  assert.equal(b.granted.length, 0);
  assert.equal(skippedBy(b, 'R3').length, 1);
  assert.ok(!linesOf(u.ws, u.pid).some((l) => l.decided_by === BY));
});

test('the mandate grants an undone mandate grant\'s ticket never again', (t) => {
  const s = sweepDesk(t);
  const g = T.mandateSweep(s.ws).granted[0];
  T.decide(s.ws, s.pid, { receipt_id: g.receipt_id, action: 'undo', request_id: 'req_mandate_undo2', by: 'eric' });
  const out = T.mandateSweep(s.ws);
  assert.equal(out.granted.length, 0);
  assert.equal(skippedBy(out, 'R3').length, 1);
});

test('R4: a native L1, a chain off the list, a contract hold or one not observed is skipped', (t) => {
  const n = sweepDesk(t);
  rewriteIdentity(n.ws, n.pid, (id) => { id.native_chain = true; });
  assert.match(skippedBy(T.mandateSweep(n.ws), 'R4')[0].words, /native L1 coin stays Eric's own decision/);

  const c = sweepDesk(t, { settings: { automation: { autonomous_paper_loop: true, mandate: { expires_at: inDays(7), allowed_chains: ['ethereum'] } } } });
  assert.match(skippedBy(T.mandateSweep(c.ws), 'R4')[0].words, /exit chain \(Base\) is not among/);

  const h = sweepDesk(t, { evidence: 'The contract gate holds: the observation is older than its evidence life (CG-20, FICTIONAL).' });
  assert.match(skippedBy(T.mandateSweep(h.ws), 'R4')[0].words, /holds/);
  const none = sweepDesk(t, { evidence: 'The contract has no observation the desk can read now.' });
  const out = T.mandateSweep(none.ws);
  assert.equal(out.granted.length, 0);
  assert.match(skippedBy(out, 'R4')[0].words, /no observation/);
});

test('R4: the contract evidence itself, with no attestation, no verdict, a block, a hold or a changed identity', (t) => {
  const project = { project_id: 'x-fictional', identity: { status: 'verified' } };
  const sizing = T.sizingOf({ settings: {} });
  const rv = T.contractVerdictNow;
  const rc = T.contractCheckOf;
  t.after(() => { T.contractVerdictNow = rv; T.contractCheckOf = rc; });
  let verdict = { tier: 'pass', words: 'ok', findings: [] };
  let check = { status: 'holding', words: 'unchanged' };
  T.contractVerdictNow = () => verdict;
  T.contractCheckOf = () => check;
  const ev = (receipt) => T.mandateContractEvidence({}, project, receipt, sizing, Date.now());
  assert.match(ev({ desk: {} }), /carried no contract attestation/);
  const attested = { desk: { contract_gate: { tier: 'pass', identity_key: 'sha256:x' } } };
  assert.equal(ev(attested), null);
  verdict = null;
  assert.match(ev(attested), /no observation the desk can read now/);
  verdict = { tier: 'block', words: 'An owner can mint (FICTIONAL).' };
  assert.match(ev(attested), /blocks: An owner can mint/);
  verdict = { tier: 'hold', words: 'Stale (FICTIONAL).' };
  assert.match(ev(attested), /holds: Stale/);
  verdict = { tier: 'review', words: 'A finding to read (FICTIONAL).' };
  assert.equal(ev(attested), null, 'review is not a hold');
  check = { status: 'triggered', words: 'The contract\'s identity fingerprint changed after the ticket was saved (FICTIONAL).' };
  assert.match(ev(attested), /fingerprint changed/);
});

test('R5: a ticker twin on the desk, or a pair whose candles are bound to another token, is skipped', (t) => {
  const s = sweepDesk(t);
  projects.addProject(s.ws, { name: 'Twin (FICTIONAL)', symbol: 'XMPL', official_website: 'https://twin.example.org/', coingecko_id: 'twin-fictional', evidence: [{ url: 'https://twin.example.org/', note: 'fictional' }], assets: [{ chain: 'base', contract_address: '0x00000000000000000000000000000000000b0b00' }], allow_same_symbol: true });
  const tw = T.mandateSweep(s.ws);
  assert.match((skippedBy(tw, 'R5')[0] || {}).words || JSON.stringify(tw), /also trades as XMPL/);

  const b = sweepDesk(t);
  const file = b.ws.abs(TD.SOURCES_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ schema_version: 'cr.trader-candle-source.v1', pair: 'XMPL/USDC', project_id: 'another-fictional', chain_id: '8453', contract_address: '0x2222222222222222222222222222222222222222', pool: '0xpool' })}\n`);
  const out = T.mandateSweep(b.ws);
  assert.equal(out.granted.length, 0);
  assert.match(skippedBy(out, 'R5')[0].words, /bound to another-fictional/);
});

// A mandate grant recorded elsewhere on the desk, at `at`.
function otherGrant(ws, at) {
  const pid = projects.addProject(ws, { name: 'Other (FICTIONAL)', symbol: 'XOTH', official_website: 'https://oth.example.org/', coingecko_id: 'oth-fictional', evidence: [{ url: 'https://oth.example.org/', note: 'fictional' }], assets: [{ chain: 'base', contract_address: '0x00000000000000000000000000000000000c0c00' }] }).project_id;
  const file = ws.abs(`projects/${pid}/tickets/decisions.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = { schema_version: 'cr.ticket-decision.v1', decision_id: 'td_otherfict0001', project_id: pid, receipt_id: 'tr_2026-10-01T000000Z_aaaaa', action: 'halve', decided_at: at, decided_by: BY, effects: { trader: 'open' } };
  fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
  return line;
}

test('the day\'s cap stops a grant: one mandate grant today elsewhere, cap 1', (t) => {
  const s = sweepDesk(t);
  otherGrant(s.ws, new Date().toISOString());
  const out = T.mandateSweep(s.ws);
  assert.equal(out.grants_today, 1);
  assert.equal(out.granted.length, 0);
  assert.match(skippedBy(out, 'R5')[0].words, /1 grant for today \(New York\) are made/);
  // Yesterday's does not count.
  const y = sweepDesk(t);
  otherGrant(y.ws, new Date(Date.now() - 36 * H).toISOString());
  assert.equal(T.mandateSweep(y.ws).granted.length, 1);
});

test('the open cap stops a grant, and a trader book that does not read grants nothing', (t) => {
  const s = sweepDesk(t, { settings: { automation: { autonomous_paper_loop: true, mandate: { expires_at: inDays(7), max_open_grants: 1 } } } });
  const other = otherGrant(s.ws, new Date(Date.now() - 36 * H).toISOString());
  const real = TD.requests;
  t.after(() => { TD.requests = real; });
  TD.requests = () => ({ requests: [{ decision_id: other.decision_id, in_force: true, phase: 'open' }] });
  const out = T.mandateSweep(s.ws);
  assert.equal(out.open_grants, 1);
  assert.equal(out.granted.length, 0);
  assert.match(skippedBy(out, 'R5')[0].words, /holds 1 open grant, its limit/);
  TD.requests = () => { throw new Error('book unreadable (FICTIONAL)'); };
  const failed = T.mandateSweep(s.ws);
  assert.equal(failed.granted.length, 0);
  assert.match(failed.why, /could not be read .*grants nothing/);
  TD.requests = () => ({ requests: [{ decision_id: other.decision_id, in_force: true, phase: 'closed' }] });
  assert.equal(T.mandateSweep(s.ws).granted.length, 1, 'a closed grant frees the cap');
});

test('two sweeps at once: the second is busy', (t) => {
  const s = sweepDesk(t);
  const token = leases.acquireLease(s.ws, T.MANDATE_LEASE, 60000, { label: 'test' });
  assert.ok(token);
  try {
    const out = T.mandateSweep(s.ws);
    assert.equal(out.status, 'busy');
    assert.deepEqual(linesOf(s.ws, s.pid), []);
  } finally {
    leases.releaseLease(s.ws, T.MANDATE_LEASE, token);
  }
  assert.equal(T.mandateSweep(s.ws).granted.length, 1, 'free again once released');
});

// A reading at $500 of 1.5%, an hour old, for the duration of fn.
function withReading(fn) {
  const real = F.view;
  const at = new Date(Date.now() - H).toISOString();
  const row = (size, c) => ({ size_usd: size, status: 'current', as_of: at, note: null, best: { cost_pct: c, cost_complete: true, missing_costs: [], method: 'executable_quote', route_scope: 'aggregator', retrieved_at: at } });
  F.view = () => ({ liquidity: { exits: [row(100, 0.75), row(500, 1.5), row(2000, 3)] } });
  try { return fn(); } finally { F.view = real; }
}

test('a $0 ticket an exit reading arrived for is re-opened once; Agent 2\'s new ticket is then granted', (t) => {
  const s = sweepDesk(t, { exits: false });
  const a = withReading(() => T.mandateSweep(s.ws));
  assert.equal(a.reopened.length, 1, JSON.stringify(a.skipped));
  assert.equal(a.granted.length, 0);
  const line = linesOf(s.ws, s.pid).find((l) => l.decision_id === a.reopened[0].decision_id);
  assert.deepEqual([line.action, line.decided_by, line.reopen.kind], ['reopen', BY, 'exit_evidence_arrived']);
  // Again: it waits for Agent 2's new ticket, and is not re-opened twice.
  const b = withReading(() => T.mandateSweep(s.ws));
  assert.equal(b.reopened.length, 0);
  assert.match(skippedBy(b, 'R3')[0].words, /waits for Agent 2's new ticket/);
  // Agent 2's replacement freezes the reading; the next sweep grants it.
  const r2 = withExitReadings(1.5, () => saveTicket(s.ws, s.pid, { exits: true, reopen: true }));
  assert.equal(r2.desk.suggested_risk_usd, 500);
  const c = T.mandateSweep(s.ws);
  assert.equal(c.granted.length, 1, JSON.stringify(c.skipped));
  assert.equal(c.granted[0].receipt_id, r2.receipt_id);
});

test('one project\'s failure is listed and never stops the sweep', (t) => {
  const s = sweepDesk(t);
  contractEvidence(t, () => { throw new Error('evidence store unreadable (FICTIONAL)'); });
  const out = T.mandateSweep(s.ws);
  assert.equal(out.status, 'ok');
  assert.equal(out.skipped.length, 1);
  assert.match(out.skipped[0].words, /evidence store unreadable/);
});

test('the trader job sweeps first and never fails over the sweep', async (t) => {
  const s = sweepDesk(t);
  const jobs = require('../core/jobs');
  const TC = require('../core/trader-candles');
  const realRefresh = TC.refresh;
  t.after(() => { TC.refresh = realRefresh; });
  const order = [];
  TC.refresh = async () => { order.push('candles'); return { status: 'noop', message: 'The Paper Book needs no hours (FICTIONAL).' }; };
  const realSweep = T.mandateSweep;
  t.after(() => { T.mandateSweep = realSweep; });
  T.mandateSweep = (...a) => { order.push('sweep'); return realSweep(...a); };
  const r = await jobs.runJob(s.ws, 'trader', { trigger: 'test' });
  assert.deepEqual(order, ['sweep', 'candles']);
  assert.equal(r.status, 'noop');
  assert.match(r.summary, /^Paper mandate: 1 granted/);
  assert.equal(linesOf(s.ws, s.pid).filter((l) => l.decided_by === BY).length, 1);
  T.mandateSweep = () => { throw new Error('sweep broke (FICTIONAL)'); };
  const f = await jobs.runJob(s.ws, 'trader', { trigger: 'test' });
  assert.equal(f.status, 'noop', 'the trader job does not fail');
  assert.match(f.summary, /Paper mandate sweep failed: sweep broke/);
});
