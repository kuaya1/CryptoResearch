'use strict';
// The desk's adapter to the trader (core/trader-desk.js, blueprint slot 12a):
// Eric's Approve, Halve and Undo become orders in the trader's Paper Book
// (cr-paper@2) and nothing else does. Temporary workspaces and fictional
// projects, tickets, pairs and hours only: nothing here is a market, an
// account, a venue or an order.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const T = require('../core/tickets');
const TD = require('../core/trader-desk');
const TR = require('../core/trader-rules');
const PT = require('../core/paper-trader');
const { H, M, iso, ULID_RE, PAIR, BOOK, deskWith, settle, bar, mine } = require('./trader-fixture');

test('the order\'s identity and arithmetic: a ULID from the decision, plain decimals, a sell limit the engine never calls through the market', () => {
  const d = { decision_id: 'td_fict00000001', decided_at: '2026-10-28T12:00:00.000Z' };
  const a = TD.intentIdOf(d, 'open');
  assert.match(a, ULID_RE);
  assert.equal(a, TD.intentIdOf({ ...d }, 'open'), 'the same decision and purpose, the same ID');
  assert.notEqual(a, TD.intentIdOf(d, 'close-1'));
  assert.notEqual(a, TD.intentIdOf({ ...d, decision_id: 'td_fict00000002' }, 'open'));
  assert.equal(a.slice(0, 10), TD.intentIdOf({ decision_id: 'other', decided_at: d.decided_at }, 'open').slice(0, 10), 'its time part is the decision\'s');
  assert.deepEqual([0.1, 0.85, 1.4, 500, 1e-7, 2.5e-12, 1e21].map(TD.plain), ['0.1', '0.85', '1.4', '500', '0.0000001', '0.0000000000025', '1000000000000000000000']);
  assert.deepEqual([0, -1, NaN, Infinity, '0.85', null, 1e-19].map(TD.plain), [null, null, null, null, null, null, null], 'unknown is never 0, and nothing is read through a float');
  assert.equal(TD.closeLimit('0.85'), '0.8483');
  assert.equal(TD.closeLimit('100'), '99.8');
  // Raised, never lowered: 20 bps under 1/3 rounds up at the 18th place.
  assert.equal(TD.closeLimit('0.333333333333333333'), '0.332666666666666667');
});

test('a ticket becomes an order only from its own prices: ACCUMULATE and LIMIT_TRAP, never a stop invented', () => {
  const p = { non_consensus_thesis: 'Fictional thesis.', entry_zone: { low_usd: 0.8, high_usd: 0.9 }, upside_target: { price_usd: 1.4 }, invalidation_trigger: { price_usd: 0.7, metric: null, statement: '' } };
  const rc = (type, over = {}) => ({ desk: { proposal_type: type }, proposal: { ...p, ...over } });
  const d = { pm_approved_risk_usd: 250 };
  const acc = TD.planOf(rc('ACCUMULATE'), d, '0.95');
  assert.deepEqual([acc.entry, acc.stop, acc.target, acc.risk], ['0.9', '0.7', '1.4', '250'], 'ACCUMULATE: the zone\'s high under a higher price');
  assert.equal(TD.planOf(rc('ACCUMULATE'), d, '0.85').entry, '0.85', 'the price when it is lower: a buy never goes through the market');
  assert.equal(TD.planOf(rc('LIMIT_TRAP'), d, '0.85').entry, '0.8', 'LIMIT_TRAP: the zone\'s low');
  assert.equal(TD.planOf(rc('LIMIT_TRAP'), d, '0.75').entry, '0.75');
  assert.equal(acc.evidence.negative_invalidation, 'The price trades at or below $0.7.', 'the ticket\'s words, else the stop in words');
  assert.deepEqual(acc.evidence.metrics_evaluated, ['entry_zone.high_usd', 'upside_target.price_usd', 'invalidation_trigger.price_usd']);
  for (const type of ['TRIM_EXIT', 'WATCH_ONLY', 'HARD_PASS', null]) assert.match(TD.planOf(rc(type), d, '0.85').why, /only an ACCUMULATE or a LIMIT_TRAP opens/);
  assert.match(TD.planOf(rc('ACCUMULATE', { invalidation_trigger: { price_usd: null, metric: { key: 'fees', below_30d_usd: 1 }, statement: 'Fees fall.' } }), d, '0.85').why, /no an invalidation price for the stop \(a stop is never invented\)/);
  assert.match(TD.planOf(rc('LIMIT_TRAP', { entry_zone: { low_usd: null, high_usd: 0.9 }, upside_target: null }), d, '0.85').why, /no the entry zone's low, no an upside target/);
  assert.match(TD.planOf(rc('ACCUMULATE'), { pm_approved_risk_usd: 0 }, '0.85').why, /an approved risk above \$0/);
});

test('a pair is the ticker against USDC, refused while another unarchived project shares it', () => {
  const x = { project_id: 'xmpl', name: 'Example', symbol: 'xmpl' };
  assert.deepEqual(TD.pairOf(x, [x]), { pair: 'XMPL/USDC', why: null });
  assert.match(TD.pairOf(x, [x, { project_id: 'other', name: 'Other', symbol: 'XMPL' }]).why, /Other, also trades as XMPL/);
  assert.equal(TD.pairOf(x, [x, { project_id: 'other', symbol: 'XMPL', status: 'archived' }]).pair, 'XMPL/USDC', 'an archived project is not on the desk');
  assert.match(TD.pairOf({ project_id: 'n', name: 'No ticker' }, []).why, /no ticker/);
});

test('the Paper Book settings: funding and the venue fee, bounded, with no default', () => {
  assert.deepEqual(TR.validateBookPatch({ cash_usd: '25000', fee_rate: 0.003 }), { cash_usd: '25000', fee_rate: '0.003' });
  assert.deepEqual(TR.validateBookPatch({ cash_usd: null }), { cash_usd: null }, 'null unsets');
  for (const bad of [{ cash_usd: '0' }, { cash_usd: '-5' }, { cash_usd: '10000000.01' }, { fee_rate: '0' }, { fee_rate: '0.2' }, { fee_rate: '1e-3' }, { venue: 'x' }]) assert.throws(() => TR.validateBookPatch(bad), (e) => e.code === 'INVALID', JSON.stringify(bad));
  assert.deepEqual(TR.bookOf({ settings: {} }), { from: 'trader.book', book: {}, unset: ['cash_usd', 'fee_rate'] });
  assert.deepEqual(TR.bookOf({ settings: { trader: { book: { cash_usd: '25000', fee_rate: '5' } } } }).unset, ['fee_rate'], 'a saved value out of bounds reads as unset, never applied');
  const s = TD.settingsOf({ settings: { trader: { book: { fee_rate: '0.003' } } } });
  assert.deepEqual(s.venue, { lot: '0.000001', min_notional_usd: '10', maker_rate: '0.003', taker_rate: '0.003' });
  assert.match(s.waits.join(' '), /rules are not all set.*not funded/);
  // The server takes both homes in one patch and keeps them apart.
  const src = fs.readFileSync(require.resolve('../server'), 'utf8');
  assert.match(src, /out\.trader\.book = TR\.validateBookPatch\(patch\.trader\.book\)/);
});

test('12a end to end: Approve waits for the book, is refused by the exit cap, Halve opens, an hour fills part, Undo cancels the rest and closes: to the cent', (t) => {
  const s = deskWith(t);
  const { ws, pid, rid } = s;

  // 1. Approve $500 before anything is set: the decision is recorded, the
  // request waits, and the book is not touched.
  const ap = T.decide(ws, pid, { receipt_id: rid, action: 'approve', request_id: 'req_12a_approve1' });
  assert.equal(ap.result.status, 'saved');
  assert.deepEqual(ap.result.decision.effects, { archive: null, paper: 'open', journal: 'entry', trader: 'open' });
  assert.equal(ap.result.trader.status, 'waiting');
  assert.match(ap.result.trader.words, /rules are not all set.*not funded.*venue fee is not set/);
  assert.equal(fs.existsSync(ws.abs(PT.JOURNAL)), false, 'nothing is written to the book while it waits');
  assert.deepEqual(TD.wanted(ws), [], 'no hours are wanted before Eric funds the book');
  const approve = ap.result.decision;

  // 2. Eric sets his rules, the funding and the fee; sixteen closed hours
  // arrive. The book is funded first; NAV by the hour starts at the funding.
  settle(ws);
  assert.deepEqual(TD.wanted(ws), [{ pair: PAIR, project_id: pid, why: 'waiting', last_hour: null }]);
  const now0 = Date.now();
  const top = Math.floor(now0 / H) * H;
  const applied = TD.applyHours(ws, Array.from({ length: 16 }, (_, i) => bar(top - (16 - i) * H)), { now: iso(now0) });
  assert.deepEqual(applied.map((x) => x.status), Array(16).fill('saved'));
  assert.equal(PT.results(ws, { now: iso(now0) }).funded_usd, '25000');
  assert.equal(TD.wanted(ws, { now: iso(now0) })[0].last_hour, iso(top - H), 'the last hour the book holds, so the hourly read asks for what comes after');

  // 3. The next step asks the book once. $500 at a stop of $0.70 buys
  // 3,197.025 XMPL ($2,717.47) at $0.85, over the $2,000 the exits showed
  // selling within 5%: refused, finally, with the reason in words.
  const s1 = TD.step(ws);
  const r1 = mine(s1, approve.decision_id);
  assert.equal(r1.phase, 'refused');
  assert.deepEqual(r1.refusals.map((x) => [x.field, x.rule]), [['risk_ceiling_usd', 'exit_cap']]);
  assert.match(r1.words, /above the 2000 the exit measurement shows/);
  assert.equal(r1.open_intent_id, TD.intentIdOf(approve, 'open'));
  assert.deepEqual(TD.step(ws).done, [], 'the same step again asks nothing');

  // 4. Undo, then Halve: $250, the smaller of the starter and the suggestion.
  T.decide(ws, pid, { receipt_id: rid, action: 'undo', request_id: 'req_12a_undo0001' });
  assert.equal(mine(TD.requests(ws), approve.decision_id).phase, 'refused', 'a refusal stays the record of that decision');
  const hv = T.decide(ws, pid, { receipt_id: rid, action: 'halve', request_id: 'req_12a_halve001' });
  const halve = hv.result.decision;
  assert.equal(halve.pm_approved_risk_usd, 250);
  //   stop fill   = 0.7 × (1 − 25 bps)                              = 0.69825
  //   per unit    = 0.85 − 0.69825 + 0.00255 + 0.00209475            = 0.15639475
  //   quantity    = floor(250 / 0.15639475 to 0.000001)             = 1598.519131
  //   notional    = 1598.519131 × 0.85, raised                      = 1358.74126135
  assert.equal(hv.result.trader.status, 'order', 'the decision\'s own step asks the book at once');
  const open = TD.intentIdOf(halve, 'open');
  const ord = PT.intents(ws).find((i) => i.intent_id === open);
  assert.deepEqual([ord.state, ord.side, ord.pair, ord.quantity, ord.thesis_id], ['ACKED', 'OPEN_LONG', PAIR, '1598.519131', rid]);
  const sentAt = Date.now();
  const res0 = PT.results(ws, { now: iso(sentAt) });
  assert.equal(res0.orders.length, 1, 'one order in the book: the refused approve made none');

  // 5. The hour in progress ends, then the next: only an hour that starts
  // after the order was sent fills it, at most 10% of its 10,000 volume.
  // (The first such hour is read from the time it was sent, so the test
  // holds at any minute of the hour.)
  const fillHour = Math.ceil(sentAt / H) * H;
  const upTo = Array.from({ length: Math.round((fillHour - top) / H) + 1 }, (_, i) => bar(top + i * H));
  const n1 = fillHour + H + M;
  const h2 = TD.applyHours(ws, upTo, { now: iso(n1) });
  assert.ok(h2.every((x) => x.status === 'saved'));
  assert.deepEqual(h2.flatMap((x) => x.events.filter((e) => e.type === 'fill').map((e) => [x.hour, e.quantity, e.price])), [[iso(fillHour), '1000', '0.85']]);
  const rq = mine(TD.requests(ws, { now: iso(n1) }), halve.decision_id);
  assert.equal(rq.phase, 'open');
  assert.match(rq.words, /Open: 1000 XMPL\/USDC at \$0\.85, stop \$0\.7, target \$1\.4; the buy is still PARTIAL, 1000 of 1598\.519131 filled/);

  // 6. Eric undoes the halve. The decision is recorded whatever the book
  // says; here the decision's own step runs at the wall clock, before the
  // book's last hour, and the book refuses to go back in time: said, not lost.
  const un = T.decide(ws, pid, { receipt_id: rid, action: 'undo', request_id: 'req_12a_undo0002' });
  assert.equal(un.result.status, 'saved');
  assert.equal(un.result.decision.effects.trader, 'close');
  assert.ok(un.result.trader.problems.some((p) => p.code === 'TIME'), 'the book never goes back in time');
  // The next step cancels the rest of the buy, then sells the 1,000 at 20
  // bps under the last close: 0.85 × 0.998 = 0.8483.
  const s2 = TD.step(ws, { now: iso(n1 + M) });
  assert.deepEqual(s2.done.map((x) => [x.kind, x.status, x.state]), [['cancel', 'saved', 'CANCELLED'], ['close', 'saved', 'ACKED']]);
  const sell = PT.intents(ws).find((i) => i.intent_id === TD.intentIdOf(halve, 'close-1'));
  assert.deepEqual([sell.side, sell.quantity, sell.position_id], ['CLOSE_LONG', '1000', `pos-${open}`]);
  assert.match(mine(s2, halve.decision_id).words, /You undid the halve .*A sell order is ACKED/);
  assert.deepEqual(TD.step(ws, { now: iso(n1 + 2 * M) }).done, [], 'nothing is asked twice');

  // 7. The hour in progress ends unfilled for the sell (it started before
  // the sell was sent); the next trades above the limit: sold at its open,
  // $0.85. Proceeds 850, fee 2.55; cost 850 + 2.55: realized −5.10.
  const n2 = fillHour + 3 * H + M;
  const h3 = TD.applyHours(ws, [bar(fillHour + H), bar(fillHour + 2 * H)], { now: iso(n2) });
  assert.deepEqual(h3.map((x) => x.events.filter((e) => e.type === 'exit').map((e) => [e.reason, e.quantity, e.price])), [[], [['close', '1000', '0.85']]]);
  const done = mine(TD.requests(ws, { now: iso(n2) }), halve.decision_id);
  assert.equal(done.phase, 'closed');
  assert.match(done.words, /^Sold at \$0\.85: −\$5\.10 realized\.$/);
  const res = PT.results(ws, { now: iso(n2) });
  assert.deepEqual([res.nav_usd, res.cash_usd, res.realized_pnl_usd, res.fees_usd, res.open_positions.length], ['24994.9', '24994.9', '-5.1', '5.1', 0]);
  assert.deepEqual(TD.wanted(ws, { now: iso(n2) }), [], 'no hours are wanted once nothing is open or waiting');
  assert.equal(require('../core/portfolio').loadTransactions(ws).length, 0, 'Portfolio is untouched');

  // 8. Outcomes > Paper Book (slot 12c) reads it all through the adapter:
  // each decision with its phase, the refusal with its reason, each order
  // and position with the decision it belongs to, NAV by the hour.
  const v = TD.view(ws, { now: iso(n2) });
  assert.deepEqual(v.book, BOOK);
  assert.deepEqual(v.waits, []);
  assert.deepEqual(v.requests.map((r) => [r.decision_id, r.action, r.phase]), [[approve.decision_id, 'approve', 'refused'], [halve.decision_id, 'halve', 'closed']]);
  assert.deepEqual(v.refusals.map((x) => [x.project_id, x.decision_id, x.purpose, x.request_pair, x.refusals.map((y) => y.rule)]), [[pid, approve.decision_id, 'open', PAIR, ['exit_cap']]]);
  assert.match(v.refusals[0].refusals[0].words, /above the 2000 the exit measurement shows/);
  assert.deepEqual(v.orders.map((o) => [o.side, o.pair, o.state, o.decision_id, o.purpose]), [['OPEN_LONG', PAIR, 'CANCELLED', halve.decision_id, 'open'], ['CLOSE_LONG', PAIR, 'FILLED', halve.decision_id, 'close']]);
  assert.deepEqual(v.results.closed_positions.map((p) => [p.project_id, p.decision_id, p.realized_pnl_usd, p.exit_words]), [[pid, halve.decision_id, '-5.1', 'Sold at $0.85']]);
  assert.deepEqual(v.results.open_positions, []);
  // NAV by the hour runs from the funding: the hours read before it hold none.
  const navs = v.results.nav_by_hour;
  assert.equal(navs[0].hour_end, iso(Math.ceil(Date.parse(v.results.funded_at) / H) * H));
  assert.equal(navs[navs.length - 1].hour_end, iso(Math.floor(n2 / H) * H));
  assert.ok(navs.every((m) => m.nav_usd !== null));
  assert.equal(navs[navs.length - 1].nav_usd, '24994.9');
  assert.deepEqual(v.hours, PT.hours(ws));
});

test('only decisions that state the trader effect ask it: an older grant opens nothing; an unreadable receipt opens nothing, in words', (t) => {
  const s = deskWith(t);
  const { ws, pid, rid } = s;
  settle(ws);
  const rel = `projects/${pid}/tickets/decisions.jsonl`;
  const old = { schema_version: PT.DECISION_VERSION, decision_id: 'td_fictold000001', project_id: pid, receipt_id: rid, ticket_id: 'tk_x', action: 'approve', pm_approved_risk_usd: 500, suggested_risk_usd: 500, proposal_type: 'ACCUMULATE', effects: { archive: null, paper: 'open', journal: 'entry' }, decided_at: new Date().toISOString() };
  fs.writeFileSync(ws.abs(rel), `${JSON.stringify(old)}\n`);
  assert.deepEqual(TD.requests(ws).requests, [], 'a grant recorded before slot 12a is not the trader\'s');
  fs.writeFileSync(ws.abs(rel), `${JSON.stringify({ ...old, decision_id: 'td_fictnew000001', effects: { ...old.effects, trader: 'open' } })}\n`);
  assert.equal(TD.requests(ws).requests[0].phase, 'waiting');
  fs.writeFileSync(ws.abs(`projects/${pid}/tickets/receipts/${rid}.json`), '{ not json');
  const r = TD.requests(ws).requests[0];
  assert.equal(r.phase, 'not_opened');
  assert.match(r.words, /could not be read\. No order is made from it\./);
  assert.equal(TD.step(ws).done.filter((x) => x.kind !== 'fund').length, 0);
});

test('reads write nothing', (t) => {
  const s = deskWith(t);
  settle(s.ws);
  T.decide(s.ws, s.pid, { receipt_id: s.rid, action: 'approve', request_id: 'req_12a_reads001' });
  const tree = () => fs.readdirSync(s.ws.root, { recursive: true }).sort().map((p) => `${p}:${fs.statSync(require('path').join(s.ws.root, p)).mtimeMs}`).join('\n');
  const before = tree();
  TD.requests(s.ws);
  TD.wanted(s.ws);
  TD.view(s.ws);
  assert.equal(tree(), before);
});
