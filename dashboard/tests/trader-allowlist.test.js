'use strict';
// The effective allowlist (autonomous paper playbook, Stage 9): the engine is
// handed Eric's saved list, the pair of every grant in force and every pair
// the book holds exposure in. Nothing writes trader.rules.allowlist. FICTIONAL
// temporary workspaces, pairs and hours only.

const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../core/tickets');
const TD = require('../core/trader-desk');
const TR = require('../core/trader-rules');
const PT = require('../core/paper-trader');
const { H, M, iso, PAIR, deskWith, settle, bar, mine } = require('./trader-fixture');

const UNSET_WAIT = /rules are not all set \(allowlist\)/;

// Sixteen quiet hours ending at the last whole hour: the 14-hour ATR is set.
function hours(ws) {
  const now0 = Date.now();
  const top = Math.floor(now0 / H) * H;
  TD.applyHours(ws, Array.from({ length: 16 }, (_, i) => bar(top - (16 - i) * H)), { now: iso(now0) });
  return top;
}

test('allowlistOf: a saved list, a grant in force and exposure join; a twin, a pair bound elsewhere, an undone grant never do', () => {
  const a = { project_id: 'a-fictional', name: 'A (FICTIONAL)', symbol: 'XAA', status: 'active' };
  const twin = { project_id: 'twin-fictional', name: 'Twin (FICTIONAL)', symbol: 'XAA', status: 'active' };
  const b = { project_id: 'b-fictional', name: 'B (FICTIONAL)', symbol: 'XBB', status: 'active' };
  const c = { project_id: 'c-fictional', name: 'C (FICTIONAL)', symbol: 'XCC', status: 'active' };
  const grant = (project, over = {}) => ({ project, in_force: true, decision: { decision_id: `td_${project.symbol}`, action: 'halve', decided_by: 'mandate:cr-paper-mandate@1', effects: { trader: 'open' } }, ...over });
  const sources = new Map([['XCC/USDC', { pair: 'XCC/USDC', project_id: 'someone-else', chain_id: '8453', contract_address: '0x1' }]]);
  const snap = {
    sources,
    open: new Map([['p1', { pair: 'XOPEN/USDC' }]]),
    list: [{ pair: 'XLIVE/USDC', state: 'ACKED' }, { pair: 'XDONE/USDC', state: 'CANCELLED' }, { pair: 'XFILL/USDC', state: 'FILLED' }],
  };
  const out = TD.allowlistOf(['XSAVED/USDC'], {
    grants: [grant(a), grant(b), grant(c), grant(b, { in_force: false }), { ...grant(b), decision: { ...grant(b).decision, decision_id: 'td_undo', action: 'undo' } }],
    projects: [a, twin, b, c],
    snap,
  });
  assert.deepEqual(out.list, ['XBB/USDC', 'XLIVE/USDC', 'XOPEN/USDC', 'XSAVED/USDC']);
  assert.deepEqual(out.basis, { settings: ['XSAVED/USDC'], grants: [{ pair: 'XBB/USDC', decision_id: 'td_XBB', by: 'mandate:cr-paper-mandate@1' }], exposure: ['XLIVE/USDC', 'XOPEN/USDC'] });
  // Without grants or a snapshot it is the saved list alone (or nothing).
  assert.deepEqual(TD.allowlistOf(undefined).list, []);
  assert.deepEqual(TD.allowlistOf(['XSAVED/USDC']).list, ['XSAVED/USDC']);
});

test('an empty saved allowlist and one grant: the grant\'s pair opens, and the view shows why it is on the list', (t) => {
  const s = deskWith(t);
  settle(s.ws, { rules: { allowlist: null } });
  assert.deepEqual(TR.rulesOf(s.ws).unset, ['allowlist'], 'Eric\'s saved list is unset');
  hours(s.ws);
  assert.match(TD.settingsOf(s.ws).waits.join(' '), UNSET_WAIT, 'with no grant the rules are not all set');
  const d = T.decide(s.ws, s.pid, { receipt_id: s.rid, action: 'halve', request_id: 'req_allow_halve01', by: 'eric' }).result.decision;
  const r = mine(TD.requests(s.ws), d.decision_id);
  assert.equal(r.phase, 'order', r.words);
  const buy = PT.intents(s.ws).find((i) => i.intent_id === TD.intentIdOf(d, 'open'));
  assert.deepEqual([buy.side, buy.pair, buy.state], ['OPEN_LONG', PAIR, 'ACKED']);
  const v = TD.view(s.ws);
  assert.ok(!v.waits.some((w) => UNSET_WAIT.test(w)), v.waits.join(' '));
  assert.deepEqual(v.allowlist_basis, { settings: [], grants: [{ pair: PAIR, decision_id: d.decision_id, by: 'eric' }], exposure: [PAIR] });
  assert.equal(s.ws.settings.trader.rules.allowlist, null, 'nothing writes the saved list');
});

test('after an undo the pair stays while the position is open, so the close goes through; once flat it drops', (t) => {
  const s = deskWith(t);
  settle(s.ws, { rules: { allowlist: null } });
  const top = hours(s.ws);
  const hv = T.decide(s.ws, s.pid, { receipt_id: s.rid, action: 'halve', request_id: 'req_allow_halve02', by: 'eric' }).result.decision;
  const open = TD.intentIdOf(hv, 'open');
  assert.equal(PT.intents(s.ws).find((i) => i.intent_id === open).state, 'ACKED');
  // An hour that starts after the order fills 1,000 of it.
  const sentAt = Date.now();
  const fillHour = Math.ceil(sentAt / H) * H;
  const n1 = fillHour + H + M;
  const h = TD.applyHours(s.ws, Array.from({ length: Math.round((fillHour - top) / H) + 1 }, (_, i) => bar(top + i * H)), { now: iso(n1) });
  assert.ok(h.every((x) => x.status === 'saved'));
  assert.equal(mine(TD.requests(s.ws, { now: iso(n1) }), hv.decision_id).phase, 'open');

  T.decide(s.ws, s.pid, { receipt_id: s.rid, action: 'undo', request_id: 'req_allow_undo002', by: 'eric' });
  const mid = TD.view(s.ws, { now: iso(n1) });
  assert.deepEqual(mid.allowlist_basis.grants, [], 'the undone grant no longer puts its pair on the list');
  assert.deepEqual(mid.allowlist_basis.exposure, [PAIR], 'the open position keeps it there');
  const s2 = TD.step(s.ws, { now: iso(n1 + M) });
  assert.deepEqual(s2.done.map((x) => [x.kind, x.status, x.state]), [['cancel', 'saved', 'CANCELLED'], ['close', 'saved', 'ACKED']]);

  // The next hours sell it; the book is flat and the pair drops.
  const n2 = fillHour + 3 * H + M;
  TD.applyHours(s.ws, [bar(fillHour + H), bar(fillHour + 2 * H)], { now: iso(n2) });
  assert.equal(mine(TD.requests(s.ws, { now: iso(n2) }), hv.decision_id).phase, 'closed');
  const flat = TD.view(s.ws, { now: iso(n2) });
  assert.deepEqual(flat.allowlist_basis, { settings: [], grants: [], exposure: [] });
  assert.ok(flat.waits.some((w) => UNSET_WAIT.test(w)), 'with nothing on the list the rules wait again');
});

test('a close never waits on the allowlist wait, even when the derived list is empty', () => {
  const src = require('fs').readFileSync(require.resolve('../core/trader-desk'), 'utf8');
  assert.match(src, /ctx\.s\.waits\.filter\(\(w\) => !\/not funded\/\.test\(w\) && !\/rules are not all set \\\(allowlist\\\)\/\.test\(w\)\)/);
});
