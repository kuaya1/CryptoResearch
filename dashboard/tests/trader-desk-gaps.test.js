'use strict';
// Missing hours in the trader's Paper Book (cr-trader-gap@1; the cohesion
// audit's M1 and brief 1, 2026-10-29): an hour GeckoTerminal leaves out for a
// pair the book holds or has a live order in is recorded once, with when it
// was first seen; until the book holds it, the record is unsettled: no new
// order anywhere in the book, the unfilled part of a buy is not cancelled
// over it, and the book's figures are said to be recorded balances. When the
// hour arrives it applies once, in order. Nothing is filled in or written
// off. Temporary workspaces and fictional pairs and hours only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const T = require('../core/tickets');
const TD = require('../core/trader-desk');
const PT = require('../core/paper-trader');
const { H, M, iso, PAIR, deskWith, settle, bar, mine } = require('./trader-fixture');

// A funded book with Eric's halve on the fixture ticket: its buy of
// 1,598.519131 XMPL at $0.85 is ACKED and nothing has filled. Returns the
// hour the buy can first fill in (the first that starts after it was sent).
function halved(t) {
  const s = deskWith(t);
  settle(s.ws);
  const now0 = Date.now();
  const top = Math.floor(now0 / H) * H;
  TD.applyHours(s.ws, Array.from({ length: 16 }, (_, i) => bar(top - (16 - i) * H)), { now: iso(now0) });
  const hv = T.decide(s.ws, s.pid, { receipt_id: s.rid, action: 'halve', request_id: 'req_gap_halve0001' });
  assert.equal(hv.result.trader.status, 'order');
  const halve = hv.result.decision;
  const sentAt = Date.now();
  const fillHour = Math.ceil(sentAt / H) * H;
  // The hours up to the one in progress when it was sent: none can fill it.
  const pre = Array.from({ length: Math.round((fillHour - top) / H) }, (_, i) => bar(top + i * H));
  if (pre.length) assert.ok(TD.applyHours(s.ws, pre, { now: iso(fillHour + M) }).every((x) => x.status === 'saved'));
  return { ...s, halve, open: TD.intentIdOf(halve, 'open'), fillHour };
}
const gapsOf = (ws) => (fs.existsSync(ws.abs(TD.GAPS_REL)) ? fs.readFileSync(ws.abs(TD.GAPS_REL), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('M1: an ACKED buy with nothing filled and a missing hour is unsettled, not a clean $25,000 book; nothing new opens; the hour, when it comes, applies once', (t) => {
  const s = halved(t);
  const { ws, fillHour } = s;
  // The hour the buy could fill in is left out; the one after it arrives.
  const seen = fillHour + 2 * H + 15 * M;
  const r = TD.applyHours(ws, [bar(fillHour + H)], { now: iso(seen) });
  assert.equal(r[0].status, 'refused');
  assert.equal(r[0].code, 'GAP');
  assert.deepEqual(r[0].gap, { pair: PAIR, missing_hour: iso(fillHour), detected_at: iso(seen), status: 'saved' });
  assert.deepEqual(gapsOf(ws).map((g) => [g.schema_version, g.pair, g.missing_hour, g.last_hour, g.later_hour, g.detected_at]), [[TD.GAP_VERSION, PAIR, iso(fillHour), iso(fillHour - H), iso(fillHour + H), iso(seen)]]);

  // The book's recorded figures still read $25,000 and a $0 drawdown, but
  // the view says they are recorded balances with an hour missing.
  const v = TD.view(ws, { now: iso(seen + M) });
  assert.equal(v.results.nav_usd, '25000');
  assert.equal(v.settlement.state, 'unsettled');
  assert.equal(v.settlement.settled_through, iso(fillHour));
  assert.deepEqual(v.settlement.pairs.map((p) => [p.pair, p.state, p.gap && p.gap.missing_hour, p.gap && p.gap.detected_at]), [[PAIR, 'unsettled', iso(fillHour), iso(seen)]]);
  assert.match(v.settlement.words, new RegExp(`${PAIR.replace('/', '\\/')} is missing the hour ${iso(fillHour)}.*first seen ${iso(seen)}.*may never arrive.*nothing is filled in`));
  assert.ok(v.results.unknown.some((u) => /recorded balances, not settled/.test(u)), 'Outcomes says the figures are recorded, not settled');
  assert.deepEqual(TD.requests(ws, { now: iso(seen + M) }).settlement, v.settlement, 'the requests carry the same settlement');

  // The same missing hour refused again (a later read) keeps its first sighting.
  const again = TD.applyHours(ws, [bar(fillHour + H), bar(fillHour + 2 * H)], { now: iso(seen + H) });
  assert.equal(again[0].gap.status, 'unchanged');
  assert.equal(again[1].status, 'skipped');
  assert.equal(gapsOf(ws).length, 1);
  assert.equal(gapsOf(ws)[0].detected_at, iso(seen), 'restarts and later reads keep the first detection time');

  // Undo: the unfilled buy is not cancelled over the missing hour (a fill in
  // it would be lost); Halve again: its buy waits while the book is unsettled.
  T.decide(ws, s.pid, { receipt_id: s.rid, action: 'undo', request_id: 'req_gap_undo00001' });
  const st = TD.step(ws, { now: iso(seen + H + M) });
  assert.deepEqual(st.done.filter((d) => d.kind !== 'fund'), [], 'nothing is cancelled or asked');
  assert.match(mine(st, s.halve.decision_id).words, new RegExp(`cancelled once ${PAIR.replace('/', '\\/')}'s missing hour ${iso(fillHour)} is on record`));
  const hv2 = T.decide(ws, s.pid, { receipt_id: s.rid, action: 'halve', request_id: 'req_gap_halve0002' });
  const r2 = mine(TD.requests(ws, { now: iso(seen + H + 2 * M) }), hv2.result.decision.decision_id);
  assert.equal(r2.phase, 'waiting');
  assert.match(r2.words, /No new order while the book's record is unsettled/);
  assert.equal(PT.intents(ws).length, 1, 'the second halve asked the book nothing');

  // The missing hour arrives (quiet: a fill, no stop), then the hours after:
  // each applies once and in order, and the gap is settled.
  const late = TD.applyHours(ws, [bar(fillHour), bar(fillHour + H), bar(fillHour + 2 * H)], { now: iso(fillHour + 3 * H + 15 * M) });
  assert.deepEqual(late.map((x) => x.status), ['saved', 'saved', 'saved']);
  assert.deepEqual(late[0].events.filter((e) => e.type === 'fill').map((e) => e.quantity), ['1000'], 'the missing hour\'s fill is on record');
  const v2 = TD.view(ws, { now: iso(fillHour + 3 * H + 16 * M) });
  assert.equal(v2.settlement.state, 'settled');
  assert.deepEqual(v2.settlement.gaps.map((g) => [g.missing_hour, g.state]), [[iso(fillHour), 'settled']]);
  assert.ok(!v2.results.unknown.some((u) => /recorded balances/.test(u)));
  // Now the undo goes through: the position is sold.
  const st2 = TD.step(ws, { now: iso(fillHour + 3 * H + 17 * M) });
  assert.ok(st2.done.some((d) => d.kind === 'close' && d.decision_id === s.halve.decision_id), 'the undone halve is closed once the hour is on record');
});

test('M1: a filled position with a missing hour holds its stop until the hour arrives; a late breach stops it out exactly once', (t) => {
  const s = halved(t);
  const { ws, fillHour } = s;
  // The buy fills 1,000 in its first hour; the next hour is left out.
  const f = TD.applyHours(ws, [bar(fillHour)], { now: iso(fillHour + H + 15 * M) });
  assert.equal(f[0].events.filter((e) => e.type === 'fill').length, 1);
  const r = TD.applyHours(ws, [bar(fillHour + 2 * H)], { now: iso(fillHour + 3 * H + 15 * M) });
  assert.equal(r[0].code, 'GAP');
  const v = TD.view(ws, { now: iso(fillHour + 3 * H + 16 * M) });
  assert.equal(v.settlement.state, 'unsettled');
  assert.match(v.settlement.pairs[0].words, /an open position/);
  assert.match(v.settlement.pairs[0].words, /a buy order PARTIAL/);
  // The missing hour arrives through the stop: out once, at 0.7 less 25 bps.
  const late = TD.applyHours(ws, [bar(fillHour + H, { low: '0.6' }), bar(fillHour + 2 * H)], { now: iso(fillHour + 3 * H + 20 * M) });
  assert.deepEqual(late.map((x) => x.status), ['saved', 'saved']);
  const exits = late.flatMap((x) => x.events.filter((e) => e.type === 'exit').map((e) => [e.reason, e.quantity, e.price]));
  assert.deepEqual(exits, [['stop', '1000', '0.69825']], 'the stop fires exactly once');
  assert.equal(TD.view(ws, { now: iso(fillHour + 3 * H + 21 * M) }).settlement.state, 'settled');
});

test('M1: a pair the book is exposed in with no hour on record for over two hours is unsettled too, and nothing new opens', (t) => {
  const s = halved(t);
  const { ws, fillHour } = s;
  const late = fillHour + 3 * H;
  const v = TD.view(ws, { now: iso(late) });
  assert.equal(v.settlement.state, 'unsettled');
  assert.equal(v.settlement.pairs[0].gap, null);
  assert.match(v.settlement.pairs[0].words, new RegExp(`has no hour on record since ${iso(fillHour)}`));
});

test('M1: a gaps record that does not read leaves the book unsettled, in words, and nothing new opens', (t) => {
  const s = halved(t);
  const { ws, fillHour } = s;
  fs.mkdirSync(require('path').dirname(ws.abs(TD.GAPS_REL)), { recursive: true });
  fs.writeFileSync(ws.abs(TD.GAPS_REL), '{"schema_version":"cr.trader-gap.v1","pair":"XMPL/US');
  const v = TD.view(ws, { now: iso(fillHour + 10 * M) });
  assert.equal(v.settlement.state, 'unsettled');
  assert.match(v.settlement.words, /line 1 does not read/);
  assert.equal(v.results.settlement.state, 'settled', 'the engine reads no gaps record: the adapter is the stricter here');
  T.decide(ws, s.pid, { receipt_id: s.rid, action: 'undo', request_id: 'req_gap_undo00009' });
  const hv2 = T.decide(ws, s.pid, { receipt_id: s.rid, action: 'halve', request_id: 'req_gap_halve0009' });
  const r2 = mine(TD.requests(ws, { now: iso(fillHour + 11 * M) }), hv2.result.decision.decision_id);
  assert.equal(r2.phase, 'waiting');
  assert.match(r2.words, /unsettled.*does not read/);
});

test('cr-paper@3: the engine holds the same gate; the adapter adds only the missing hour, which is stale by the time it is seen', (t) => {
  for (const kind of ['gap', 'stale']) {
    const s = halved(t);
    const { ws, fillHour } = s;
    const seen = fillHour + 2 * H + 15 * M;
    if (kind === 'gap') TD.applyHours(ws, [bar(fillHour + H)], { now: iso(seen) });
    const v = TD.view(ws, { now: iso(seen + M) });
    assert.equal(v.settlement.state, 'unsettled', kind);
    assert.equal(v.results.settlement.state, 'unsettled', `${kind}: the engine's own reading, without the gaps record`);
    const same = (p) => [p.pair, p.exposure, p.settled_through, p.state];
    assert.deepEqual(v.settlement.pairs.map(same), v.results.settlement.pairs.map(same), kind);
    assert.equal(v.settlement.settled_through, v.results.settlement.settled_through, kind);
    if (kind === 'gap') assert.equal(v.settlement.pairs[0].gap.missing_hour, iso(fillHour));
    else assert.equal(v.settlement.pairs[0].words, v.results.settlement.pairs[0].words, 'with no missing hour recorded, the engine\'s words');
  }
});

test('M1: reading an unsettled book writes nothing', (t) => {
  const s = halved(t);
  const { ws, fillHour } = s;
  TD.applyHours(ws, [bar(fillHour + H)], { now: iso(fillHour + 2 * H + 15 * M) });
  const tree = () => fs.readdirSync(ws.root, { recursive: true }).sort().map((p) => `${p}:${fs.statSync(require('path').join(ws.root, p)).mtimeMs}`).join('\n');
  const before = tree();
  TD.requests(ws, { now: iso(fillHour + 2 * H + 20 * M) });
  TD.wanted(ws, { now: iso(fillHour + 2 * H + 20 * M) });
  TD.view(ws, { now: iso(fillHour + 2 * H + 20 * M) });
  assert.equal(tree(), before);
  assert.deepEqual(TD.wanted(ws, { now: iso(fillHour + 2 * H + 20 * M) }).map((w) => w.pair), [PAIR], 'the pair with the missing hour is still asked for');
});
