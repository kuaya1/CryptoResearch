'use strict';
// The trader's Paper Book card in Research > Outcomes (public/trader-book-model.js,
// slot 12c): figures to the cent with the exact value kept, unknown said and
// never $0, phases and order states in words. Fictional values only.

const test = require('node:test');
const assert = require('node:assert/strict');

test('a book figure reads to the cent, keeps its exact value, and is "Unknown" with its reason, never $0', async () => {
  const M = await import('../public/trader-book-model.js');
  assert.deepEqual(M.usdWords('24994.9'), { text: '$24,994.90', exact: '24994.9', title: '24994.9 USD exactly', tone: '' });
  assert.equal(M.usdWords('-5.104').text, '−$5.10');
  for (const x of [null, undefined, '', 'abc', 0, '1e3']) assert.equal(M.usdWords(x, 'No hour.').text, 'Unknown', String(x));
  assert.equal(M.usdWords(null, 'No hour.').title, 'No hour.');
  assert.deepEqual([M.pnlWords('5.1').text, M.pnlWords('5.1').tone, M.pnlWords('-5.1').tone, M.pnlWords('0').tone], ['+$5.10', 'pos', 'neg', '']);
  assert.deepEqual(M.amountWords('1598.519131'), { text: '1,598.52', exact: '1598.519131' });
  assert.equal(M.amountWords('0.00012345').text, '0.0001235');
  assert.deepEqual(['0.7', '0.85', '1.4'].map((s) => M.amountWords(s).text), ['0.70', '0.85', '1.40'], 'prices read the desk\'s way: two decimals at least');
  assert.equal(M.amountWords(null).text, '—');
});

test('a sentence the book wrote reads with its long figures rounded; the sentence as written is its tooltip', async () => {
  const M = await import('../public/trader-book-model.js');
  const said = 'The notional 2717.48252355 is above the 2000 the exit measurement shows can be sold within the slippage limit.';
  assert.deepEqual(M.sentenceWords(said), { text: 'The notional 2,717.48 is above the 2000 the exit measurement shows can be sold within the slippage limit.', title: said });
  assert.equal(M.sentenceWords('Open: 1000 XMPL/USDC at $0.85, stop $0.7; 1000 of 1598.519131 filled.').text, 'Open: 1000 XMPL/USDC at $0.85, stop $0.7; 1000 of 1,598.52 filled.');
  assert.equal(M.sentenceWords('A sell at 0.8483 is ACKED.').text, 'A sell at 0.8483 is ACKED.', 'four significant digits under 1 are kept');
  assert.deepEqual(M.sentenceWords('Nothing to round, v1.2.345 stays.'), { text: 'Nothing to round, v1.2.345 stays.', title: null });
});

test('before funding every figure reads "Not funded"; once funded, an unknown NAV says why', async () => {
  const M = await import('../public/trader-book-model.js');
  const none = M.bookFacts({ results: { funded_usd: null, unknown: ['The book is not funded.'] } });
  assert.deepEqual(none.map((f) => f.label), ['Funded', 'NAV', 'Cash', 'Realized', 'Unrealized', 'Fees paid', 'Largest drawdown']);
  assert.ok(none.every((f) => f.text === 'Not funded'));
  const v = { results: { funded_usd: '25000', funded_at: '2026-10-28T12:00:00.000Z', nav_usd: null, cash_usd: '23641.25', realized_pnl_usd: '0', unrealized_pnl_usd: null, fees_usd: '4.07', max_drawdown_usd: null, unknown: ['XMPL/USDC has no hourly price within 120 minutes.'] } };
  const f = Object.fromEntries(M.bookFacts(v).map((x) => [x.label, x]));
  assert.equal(f.Funded.text, '$25,000.00');
  assert.equal(f.NAV.text, 'Unknown');
  assert.match(f.NAV.title, /no hourly price within 120 minutes/);
  assert.equal(f.Cash.text, '$23,641.25');
  assert.equal(f.Realized.text, '$0.00');
});

test('phases and order states are words; UNKNOWN stays unknown until the venue answers, never lost', async () => {
  const M = await import('../public/trader-book-model.js');
  assert.deepEqual(['waiting', 'order', 'open', 'closing', 'closed', 'refused', 'not_opened', 'ended'].map((p) => M.phaseWords(p).text), ['Waiting', 'Order placed', 'Open', 'Closing', 'Closed', 'Refused', 'Not opened', 'Ended unfilled']);
  assert.equal(M.orderStateWords('UNKNOWN').text, 'Unknown: asking the venue');
  assert.doesNotMatch(Object.values(['RESERVED', 'SENT', 'UNKNOWN', 'ACKED', 'PARTIAL', 'FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED', 'NOT_FOUND', 'REFUSED'].map((s) => M.orderStateWords(s).text)).join(' '), /lost/i);
  assert.deepEqual([M.sideWords('OPEN_LONG'), M.sideWords('CLOSE_LONG'), M.sideWords(null)], ['Buy', 'Sell', '—']);
  assert.equal(M.decisionWords({ action: 'halve', risk_usd: '250' }), 'Halve $250');
  assert.equal(M.ownerWords({ project: 'Example (FICTIONAL)', purpose: 'close' }), 'Example (FICTIONAL) · sell');
  assert.equal(M.ownerWords({ project: null }), 'Not tied to a decision on this desk');
  assert.equal(M.refusalWords({ refusals: [{ words: 'Above the exit cap.' }, { words: 'Outside the allowlist.' }] }), 'Above the exit cap. Outside the allowlist.');
  assert.equal(M.refusalWords({ refusals: [] }), 'No reason was recorded.');
});

test('NAV by the hour: newest first in the table, an unknown hour left out of the line, never drawn as 0', async () => {
  const M = await import('../public/trader-book-model.js');
  const v = { results: { nav_by_hour: [{ hour_end: '2026-10-28T10:00:00.000Z', nav_usd: '25000' }, { hour_end: '2026-10-28T11:00:00.000Z', nav_usd: null }, { hour_end: '2026-10-28T12:00:00.000Z', nav_usd: '24994.9' }] } };
  assert.deepEqual(M.navRows(v).map((r) => [r.hour_end.slice(11, 13), r.nav.text]), [['12', '$24,994.90'], ['11', 'Unknown'], ['10', '$25,000.00']]);
  assert.deepEqual(M.navLine(v), [25000, 24994.9]);
  assert.equal(M.summaryLine({ requests: [] }), 'No decision has asked the book yet.');
  assert.equal(M.summaryLine({ requests: [{ phase: 'closed' }, { phase: 'refused' }, { phase: 'waiting' }] }), '1 waiting · 1 closed · 1 refused');
  assert.match(M.candleWords({ held: false, last_run_at: null, requests_today: 0, daily_budget: 400, requests_this_month: 0, monthly_budget: 5000, wait_until: null }), /^Not read yet · 0 of 400 requests today, 0 of 5000 this month\.$/);
  assert.match(M.candleWords({ held: true }), /restored copy/);
});
