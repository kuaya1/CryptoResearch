'use strict';
// The trader adapter at opening (autonomous paper playbook, Stage 8): a pair
// whose candles are bound to another token is refused, and a paper mandate
// grant reads the contract again before its order (block or a changed
// identity: nothing; hold: it waits). Eric's own grants keep the enforce-only
// guard. Temporary workspaces and fictional tickets, pairs and hours only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const T = require('../core/tickets');
const TD = require('../core/trader-desk');
const PT = require('../core/paper-trader');
const { H, iso, PAIR, deskWith, settle, bar, mine } = require('./trader-fixture');
const { mandateDesk, saveTicket, mandateArgs } = require('./mandate-fixture');

const ADDR = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const own = { project_id: 'own-fictional', name: 'Own (FICTIONAL)', symbol: 'XOW', status: 'active', identity: { status: 'verified', assets: [{ chain: 'base', contract_address: ADDR }] } };
const binding = (over = {}) => ({ schema_version: 'cr.trader-candle-source.v1', pair: 'XOW/USDC', project_id: 'own-fictional', chain_id: '8453', network: 'base', contract_address: ADDR.toLowerCase(), pool: '0xpool', ...over });

function bindPair(ws, rec) {
  const file = ws.abs(TD.SOURCES_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
}

// Hours enough for the 14-hour ATR, ending at the last whole hour.
function hours(ws) {
  const now0 = Date.now();
  const top = Math.floor(now0 / H) * H;
  TD.applyHours(ws, Array.from({ length: 16 }, (_, i) => bar(top - (16 - i) * H)), { now: iso(now0) });
}

function stubContract(t, verdict, check = { status: 'holding', words: 'unchanged' }) {
  const rv = T.contractVerdictNow;
  const rc = T.contractCheckOf;
  const calls = [];
  T.contractVerdictNow = (...a) => { calls.push('verdict'); return typeof verdict === 'function' ? verdict() : verdict; };
  T.contractCheckOf = () => (typeof check === 'function' ? check() : check);
  t.after(() => { T.contractVerdictNow = rv; T.contractCheckOf = rc; });
  return calls;
}

test('pairOf: a binding to this project\'s own contract stands; another project, another contract or an unreadable file refuses', () => {
  const m = (...recs) => new Map(recs.map((r) => [r.pair, r]));
  assert.deepEqual(TD.pairOf(own, [own], { sources: m(binding()) }), { pair: 'XOW/USDC', why: null });
  assert.deepEqual(TD.pairOf(own, [own], { sources: new Map() }), { pair: 'XOW/USDC', why: null }, 'not yet bound');
  const other = TD.pairOf(own, [own], { sources: m(binding({ project_id: 'someone-else' })) });
  assert.equal(other.pair, null);
  assert.equal(other.why, `XOW/USDC's hourly candles are bound to someone-else (${ADDR.toLowerCase()}) for good, so XOW/USDC would not price this token.`);
  const wrongContract = TD.pairOf(own, [own], { sources: m(binding({ contract_address: '0x1111111111111111111111111111111111111111' })) });
  assert.equal(wrongContract.pair, null);
  assert.match(wrongContract.why, /bound to own-fictional \(0x1111/);
  const wrongChain = TD.pairOf(own, [own], { sources: m(binding({ chain_id: '1' })) });
  assert.equal(wrongChain.pair, null);
  const unreadable = new Map();
  unreadable.unreadable = true;
  assert.match(TD.pairOf(own, [own], { sources: unreadable }).why, /could not be read/);
  // Without sources the old rule stands (the ticker twin check only).
  assert.equal(TD.pairOf(own, [own]).pair, 'XOW/USDC');
});

test('a pair whose candles are bound to another project refuses the opening: no order is made', (t) => {
  const s = deskWith(t);
  settle(s.ws);
  bindPair(s.ws, { schema_version: 'cr.trader-candle-source.v1', pair: PAIR, project_id: 'another-fictional', chain_id: '8453', contract_address: '0x2222222222222222222222222222222222222222', pool: '0xpool' });
  assert.equal(TD.sourceBindingOf(s.ws, PAIR).project_id, 'another-fictional');
  hours(s.ws);
  const d = T.decide(s.ws, s.pid, { receipt_id: s.rid, action: 'halve', request_id: 'req_src_conflict1', by: 'eric' }).result.decision;
  const r = mine(TD.step(s.ws, { now: iso(Date.now()) }), d.decision_id);
  assert.equal(r.phase, 'not_opened');
  assert.match(r.words, /bound to another-fictional .* for good, so XMPL\/USDC would not price this token\. No order is made\./);
  assert.equal(PT.intents(s.ws).length, 0);
  assert.ok(!TD.wanted(s.ws, { now: iso(Date.now()) }).some((w) => w.pair === PAIR), 'no candles are fetched for it');
});

function mandateGrant(t, verdict, check) {
  const s = mandateDesk(t, { grade: 60 });
  const r = saveTicket(s.ws, s.pid);
  settle(s.ws);
  hours(s.ws);
  const calls = stubContract(t, verdict, check);
  const d = T.decide(s.ws, s.pid, { receipt_id: r.receipt_id, action: 'approve', request_id: `mandate_${r.receipt_id}`, mandate: mandateArgs('standard_55_plus', 60) }).result.decision;
  return { ...s, r, d, calls };
}

test('a mandate grant whose contract now blocks, or has no readable observation, never opens', (t) => {
  const s = mandateGrant(t, { tier: 'block', words: 'An owner can mint without limit (FICTIONAL).', findings: [] });
  const a = mine(TD.step(s.ws, { now: iso(Date.now()) }), s.d.decision_id);
  assert.equal(a.phase, 'not_opened');
  assert.match(a.words, /^The paper mandate's grant opens nothing: the contract gate now blocks/);
  assert.equal(a.contract.rule_id, 'MANDATE_RECHECK');
  assert.equal(PT.intents(s.ws).length, 0);
  T.contractVerdictNow = () => null;
  const b = mine(TD.step(s.ws, { now: iso(Date.now()) }), s.d.decision_id);
  assert.equal(b.phase, 'not_opened');
  assert.match(b.words, /no observation the desk can read now/);
  assert.equal(PT.intents(s.ws).length, 0);
});

test('a mandate grant whose contract identity changed (or sell tax spiked) since the save never opens', (t) => {
  const s = mandateGrant(t, { tier: 'pass', words: 'ok', findings: [] }, { status: 'triggered', words: 'The contract\'s identity fingerprint changed after the ticket was saved (FICTIONAL).' });
  const a = mine(TD.step(s.ws, { now: iso(Date.now()) }), s.d.decision_id);
  assert.equal(a.phase, 'not_opened');
  assert.match(a.words, /identity fingerprint changed/);
  assert.equal(PT.intents(s.ws).length, 0);
});

test('a mandate grant whose contract observation went stale (hold) waits, then opens once it is current again', (t) => {
  let tier = 'hold';
  const s = mandateGrant(t, () => ({ tier, words: 'The contract observation is older than its evidence life (CG-20, FICTIONAL).', findings: [] }));
  const a = mine(TD.step(s.ws, { now: iso(Date.now()) }), s.d.decision_id);
  assert.equal(a.phase, 'waiting');
  assert.match(a.words, /^The paper mandate's grant waits: the contract gate holds/);
  assert.equal(PT.intents(s.ws).length, 0);
  tier = 'pass';
  const step = TD.step(s.ws, { now: iso(Date.now()) });
  assert.ok(step.done.some((x) => x.kind === 'open' && x.decision_id === s.d.decision_id && x.status === 'saved'), JSON.stringify(mine(step, s.d.decision_id)));
});

test('Eric\'s own grant in observe mode is not held by the mandate\'s re-check', (t) => {
  const s = deskWith(t);
  settle(s.ws);
  hours(s.ws);
  const calls = stubContract(t, null);
  const d = T.decide(s.ws, s.pid, { receipt_id: s.rid, action: 'halve', request_id: 'req_human_obs001', by: 'eric' }).result.decision;
  const step = TD.step(s.ws, { now: iso(Date.now()) });
  const opened = step.done.some((x) => x.kind === 'open' && x.decision_id === d.decision_id && x.status === 'saved') || PT.intents(s.ws).some((i) => i.intent_id === TD.intentIdOf(d, 'open'));
  assert.ok(opened, JSON.stringify(mine(step, d.decision_id)));
  assert.equal(calls.length, 0, 'the re-check is never read for a human grant');
});
