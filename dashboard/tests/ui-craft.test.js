'use strict';
// UI craft fixes L2 and L6 (2026-10-26, Eric's vision-auditor brief): an
// unknown value is never "None" and never a false $0.00, and Review never
// prints a raw report ID or hash. Pure rules in public/, FICTIONAL values.

const test = require('node:test');
const assert = require('node:assert/strict');

const pm = import('../public/pm-card-model.js');
const pfm = import('../public/portfolio-model.js');
const rv = import('../public/review-model.js');
const usd = (v) => `$${Number(v).toFixed(2)}`;

test('L2 suggested risk: a missing value is "—", never "None" and never $0; a zero says why', async () => {
  const { riskWords } = await pm;
  const missing = riskWords({ suggested_risk_usd: null });
  assert.equal(missing.text, '—');
  assert.match(missing.title, /no suggested risk/);
  assert.notEqual(missing.text, '$0', 'unknown is not zero');
  for (const t of [{}, { suggested_risk_usd: undefined }, { suggested_risk_usd: 'x' }]) {
    const w = riskWords(t);
    assert.equal(w.text, '—');
    assert.doesNotMatch(`${w.text} ${w.why || ''}`, /\bnone\b/i);
  }
  assert.equal(riskWords({ suggested_risk_usd: 500 }).text, '$500');
  const held = riskWords({ suggested_risk_usd: 0, admission: { held_risk: true } });
  assert.equal(held.text, '$0');
  assert.equal(held.why, 'Held');
  const capped = riskWords({ suggested_risk_usd: 0, capped: { reason: 'Exit cost unknown' } });
  assert.equal(capped.why, 'Capped');
  assert.match(capped.title, /Exit cost unknown/);
  const plain = riskWords({ suggested_risk_usd: 0 });
  assert.equal(plain.why, 'No new risk');
  for (const w of [held, capped, plain]) assert.doesNotMatch(`${w.text} ${w.why} ${w.title || ''}`, /\bnone\b/i);
});

test('L2 realized: no sale is "No sales", never $0.00; an unknown result is "Unknown"; a sold break-even stays $0.00', async () => {
  const { soldAssets, realizedWords } = await pfm;
  const sold = soldAssets([
    { type: 'buy', asset_id: 'fict-a' },
    { type: 'sell', asset_id: 'fict-b' },
    { type: 'sell', asset_id: 'fict-c', voided: true },
  ]);
  assert.deepEqual([...sold], ['fict-b'], 'a voided sale is not a sale');
  const none = realizedWords({ asset_id: 'fict-a', realized_known_usd: 0 }, sold, usd);
  assert.equal(none.text, 'No sales');
  assert.notEqual(none.text, '$0.00');
  assert.equal(realizedWords({ asset_id: 'fict-c', realized_known_usd: 0 }, sold, usd).text, 'No sales');
  assert.equal(realizedWords({ asset_id: 'fict-b', realized_known_usd: 0 }, sold, usd).text, '$0.00', 'a real sale at cost is a known zero');
  assert.equal(realizedWords({ asset_id: 'fict-b', realized_known_usd: 12.5 }, sold, usd).tone, 'pos');
  assert.equal(realizedWords({ asset_id: 'fict-b', realized_known_usd: null }, sold, usd).text, 'Unknown');
  assert.equal(realizedWords({ asset_id: 'fict-a', realized_known_usd: 0, realized_unknown_quantity: 3 }, sold, usd).text, '$0.00', 'sold units with unknown cost are a sale');
  assert.equal(realizedWords({ asset_id: 'fict-a', realized_known_usd: 0 }, null, usd).text, '$0.00', 'ledger unread: the figure as saved');
  for (const w of [none, realizedWords({ asset_id: 'fict-b', realized_known_usd: null }, sold, usd)]) assert.doesNotMatch(w.text, /\bnone\b/i);
});

test('L6 Review: report IDs and hashes become dates and short forms; the originals are kept for the tooltip', async () => {
  const { plainIds } = await rv;
  const raw = 'Claude report rpt_2026-10-26T101500Z_ab12 differs from rpt_2026-10-27T090000Z_cd34 (receipt 3f9a2b7c1d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4)';
  const out = plainIds(raw);
  assert.doesNotMatch(out.text, /rpt_2026/);
  assert.doesNotMatch(out.text, /[0-9a-f]{40,}/);
  assert.match(out.text, /Oct 26/);
  assert.match(out.text, /Oct 27/);
  assert.match(out.text, /3f9a2b7c…/);
  assert.ok(out.ids.length >= 3, 'every replaced ID is kept');
  assert.deepEqual(plainIds('Nothing to replace here'), { text: 'Nothing to replace here', ids: [] });
});
