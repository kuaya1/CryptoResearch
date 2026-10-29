'use strict';
// One bounded opening per decision (cr-trader-desk@2; the cohesion audit's
// M2, M4 and M7 and brief 2, 2026-10-29): the adapter checks an opening as
// the book will check it before its one intent ID is spent, sizes it to the
// largest order every limit allows (never above Eric's approved risk), waits
// in words for what can change (a close still in flight, a short life), and
// opens nothing past the research horizon. Temporary workspaces and
// fictional tickets, pairs and hours only.

const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../core/tickets');
const TD = require('../core/trader-desk');
const PT = require('../core/paper-trader');
const risk = require('../core/trade-risk');
const { H, M, iso, PAIR, RULES, deskWith, settle, bar, mine } = require('./trader-fixture');

const { dec, str, mulCeil } = risk.exact;
const NOW = '2026-10-29T12:30:00.000Z';
const grant = { thesis_id: 'tr_2026-10-29T000000Z_fict2', project_id: 'fict-project', receipt_id: 'tr_2026-10-29T000000Z_fict2', decision_id: 'td_fict0000000001', suggested_risk_usd: '500', pm_approved_risk_usd: '500' };
const book = (over = {}) => ({
  now: NOW, nav_usd: '25000', cash_usd: '25000', available_cash_usd: '25000', drawdown_24h_usd: '0', open_risk_usd: '0', thesis_risk_usd: '0',
  price: '0.85', price_at: '2026-10-29T12:00:00.000Z', atr_14h: '0.02', lot: '0.000001', min_notional_usd: '10',
  fees: { maker_rate: '0.003', taker_rate: '0.003' }, stop_slippage_bps: 25, exit_max_usd: '2000', grant, positions: [], orders: [], ...over,
});
const intent = (over = {}) => ({
  version: risk.INTENT_VERSION, intent_id: '01JBXQ5R7Z8Y9W0V1T2S3R4Q5P', thesis_id: grant.thesis_id, project_id: grant.project_id, receipt_id: grant.receipt_id, decision_id: grant.decision_id,
  pair: PAIR, side: 'OPEN_LONG', order_type: 'LIMIT', created_at: NOW, reference_price: '0.85', reference_at: '2026-10-29T12:00:00.000Z',
  entry_price: '0.85', stop_loss_price: '0.7', take_profit_price: '1.4', risk_ceiling_usd: '500', max_slippage_bps: 20, valid_until: '2026-10-29T15:30:00.000Z',
  evidence: { catalyst: 'c (FICTIONAL)', metrics_evaluated: ['m'], negative_invalidation: 'n' }, ...over,
});
const rules = { ...RULES, price_stale_minutes: 90 };
const venue = { lot: '0.000001', min_notional_usd: '10', maker_rate: '0.003', taker_rate: '0.003' };
// The loss per unit at the stop, every cost in, as the engine computes it.
const PER_UNIT = dec('0.15639475');
const lot = dec('0.000001');
const plus = (q) => str(dec(q) + lot);
const notional = (q) => mulCeil(dec(q), dec('0.85'));

test('M4: approved risk is a ceiling; the order is the largest the exit size allows, and one lot more is over it', () => {
  const f = TD.fit(intent(), book(), rules, venue);
  assert.equal(f.ok, true);
  assert.deepEqual(f.binding, ['exit_cap']);
  assert.equal(f.sizing.quantity, '2352.941176');
  assert.ok(notional(f.sizing.quantity) <= dec('2000'));
  assert.ok(notional(plus(f.sizing.quantity)) > dec('2000'), 'one lot more is over the exit size');
  assert.ok(dec(f.intent.risk_ceiling_usd) <= dec('500') && dec(f.sizing.loss_at_stop_usd) <= dec(f.intent.risk_ceiling_usd), 'never above the approved risk');
  // The engine itself accepts what was fitted, and refuses the next lot's risk.
  assert.equal(risk.validateTradeIntent(f.intent, book(), rules).ok, true);
  const over = str(mulCeil(dec(plus(f.sizing.quantity)), PER_UNIT));
  assert.deepEqual(risk.validateTradeIntent(intent({ risk_ceiling_usd: over }), book(), rules).refusals.map((x) => x.rule), ['exit_cap']);
});

test('M4: the free cash, the notional cap and equality at a limit; a size below the venue\'s minimum is no order at all', () => {
  const cash = TD.fit(intent(), book({ available_cash_usd: '1000' }), rules, venue);
  assert.deepEqual(cash.binding, ['cash']);
  const need = (q) => { const n = notional(q); return n + mulCeil(n, dec('0.003')); };
  assert.ok(need(cash.sizing.quantity) <= dec('1000') && need(plus(cash.sizing.quantity)) > dec('1000'), 'the cash binds at the lot');
  const cap = TD.fit(intent(), book(), { ...rules, notional_max_pct: '0.05' }, venue);
  assert.deepEqual(cap.binding, ['notional_cap']);
  assert.ok(notional(cap.sizing.quantity) <= dec('1250') && notional(plus(cap.sizing.quantity)) > dec('1250'));
  // A notional exactly at the exit size is allowed (the engine refuses only above it).
  const exact = str(notional('2352.941176'));
  const eq = TD.fit(intent(), book({ exit_max_usd: exact }), rules, venue);
  assert.equal(eq.sizing.quantity, '2352.941176');
  assert.equal(notional(eq.sizing.quantity), dec(exact));
  // An approved risk that fits as written is asked as written.
  const fits = TD.fit(intent({ risk_ceiling_usd: '250' }), book(), rules, venue);
  assert.deepEqual([fits.ok, fits.binding, fits.intent.risk_ceiling_usd, fits.sizing.quantity], [true, [], '250', '1598.519131']);
  // Under $10 of notional at every allowed size: no order, in words.
  const tiny = TD.fit(intent(), book({ exit_max_usd: '9' }), rules, venue);
  assert.equal(tiny.ok, false);
  assert.ok(tiny.refusals.some((x) => x.rule === 'min_notional' || x.rule === 'exit_cap'));
  // A refusal no smaller size cures (here a stale price) is never sized around.
  const stale = TD.fit(intent(), book({ price_at: '2026-10-29T09:00:00.000Z' }), rules, venue);
  assert.equal(stale.ok, false);
  assert.ok(stale.refusals.some((x) => x.rule === 'stale_price'));
});

test('M2: a halve recorded while the undone one is still closing waits, keeps its one attempt, and opens once the ticket is flat', (t) => {
  const s = deskWith(t);
  const { ws, pid, rid } = s;
  settle(ws);
  const now0 = Date.now();
  const top = Math.floor(now0 / H) * H;
  TD.applyHours(ws, Array.from({ length: 16 }, (_, i) => bar(top - (16 - i) * H)), { now: iso(now0) });
  const h1 = T.decide(ws, pid, { receipt_id: rid, action: 'halve', request_id: 'req_m2_halve00001' }).result.decision;
  const fillHour = Math.ceil(Date.now() / H) * H;
  const pre = Array.from({ length: Math.round((fillHour - top) / H) }, (_, i) => bar(top + i * H));
  // The buy fills whole in its first hour (10% of 100,000 is more than it).
  const f = TD.applyHours(ws, [...pre, bar(fillHour, { volume: '100000' })], { now: iso(fillHour + H + 15 * M) });
  assert.ok(f.every((x) => x.status === 'saved'));
  assert.equal(PT.intents(ws).find((i) => i.intent_id === TD.intentIdOf(h1, 'open')).state, 'FILLED');

  // Undo: the next step sends a sell; Halve again before it fills.
  T.decide(ws, pid, { receipt_id: rid, action: 'undo', request_id: 'req_m2_undo000001' });
  const s1 = TD.step(ws, { now: iso(fillHour + H + 16 * M) });
  assert.ok(s1.done.some((d) => d.kind === 'close' && d.state === 'ACKED'));
  const h2 = T.decide(ws, pid, { receipt_id: rid, action: 'halve', request_id: 'req_m2_halve00002' }).result.decision;
  const r2 = mine(TD.step(ws, { now: iso(fillHour + H + 17 * M) }), h2.decision_id);
  assert.equal(r2.phase, 'waiting');
  assert.match(r2.words, /earlier order or position on this ticket is still open.*waits until the ticket is flat/);
  assert.equal(PT.intents(ws).filter((i) => i.side === 'OPEN_LONG').length, 1, 'the second halve spent nothing: no refusal is on record');

  // The sell fills in the next whole hour; the ticket is flat; the halve opens once.
  const sold = TD.applyHours(ws, [bar(fillHour + H, { high: '0.9' }), bar(fillHour + 2 * H, { high: '0.9' })], { now: iso(fillHour + 3 * H + 15 * M) });
  assert.ok(sold.some((x) => x.events.some((e) => e.type === 'exit')));
  const s3 = TD.step(ws, { now: iso(fillHour + 3 * H + 16 * M) });
  const open2 = s3.done.filter((d) => d.kind === 'open' && d.decision_id === h2.decision_id);
  assert.deepEqual(open2.map((d) => [d.status, d.state]), [['saved', 'ACKED']]);
  assert.equal(PT.intents(ws).find((i) => i.intent_id === TD.intentIdOf(h2, 'open')).quantity, '1598.519131', 'the full grant, not sized around the closed one');
  TD.step(ws, { now: iso(fillHour + 3 * H + 17 * M) });
  TD.step(ws, { now: iso(fillHour + 3 * H + 18 * M) });
  assert.equal(PT.intents(ws).filter((i) => i.side === 'OPEN_LONG').length, 2, 'repeated steps make no second opening');
});

test('M2: a grant whose research horizon has ended opens nothing and reserves nothing', (t) => {
  const s = deskWith(t);
  const { ws, pid, rid } = s;
  settle(ws);
  // The fixture report has no run, so its receipt names a horizon that ends
  // tomorrow (FICTIONAL; the horizon is not among the frozen packet's fields).
  const fs = require('fs');
  const rel = ws.abs(`projects/${pid}/tickets/receipts/${rid}.json`);
  const end = new Date(Date.now() + 24 * H).toISOString().slice(0, 10);
  const rc = JSON.parse(fs.readFileSync(rel, 'utf8'));
  rc.researcher.horizon = { end_date: end };
  fs.writeFileSync(rel, JSON.stringify(rc));
  const hv = T.decide(ws, pid, { receipt_id: rid, action: 'halve', request_id: 'req_m2_horizon001' }).result.decision;
  const h = TD.horizonOf(ws, pid, rc);
  assert.equal(h.day, end);
  const after = iso(h.ms + H);
  const r = mine(TD.step(ws, { now: after }), hv.decision_id);
  assert.equal(r.phase, 'not_opened');
  assert.match(r.words, new RegExp(`research horizon ended on ${h.day} before the book was asked`));
  assert.equal(PT.intents(ws).length, 0);
});

test('M7: an order whose life holds no whole hour after it is sent waits for one rather than expiring unfilled', (t) => {
  const s = deskWith(t);
  const { ws, pid, rid } = s;
  settle(ws, { rules: { max_validity_minutes: 60 } });
  // The next hour, so every time below is after the exit readings were taken.
  const top = Math.ceil(Date.now() / H) * H;
  TD.applyHours(ws, Array.from({ length: 16 }, (_, i) => bar(top - (16 - i) * H)), { now: iso(top + 5 * M) });
  const hv = T.decide(ws, pid, { receipt_id: rid, action: 'halve', request_id: 'req_m7_halve00001' }).result.decision;
  const r1 = mine(TD.step(ws, { now: iso(top + 10 * M) }), hv.decision_id);
  assert.equal(r1.phase, 'waiting');
  assert.match(r1.words, /longest life of an intent \(60 minutes\) would end before the first whole hour after now/);
  assert.equal(PT.intents(ws).length, 0);
  settle(ws, { rules: { max_validity_minutes: 90 } });
  assert.equal(mine(TD.requests(ws, { now: iso(top + 20 * M) }), hv.decision_id).phase, 'waiting', '40 minutes to the next hour: not yet');
  const r3 = mine(TD.step(ws, { now: iso(top + 40 * M) }), hv.decision_id);
  assert.equal(r3.phase, 'order');
});
