'use strict';
// The fixed-token exit comparison (cr-forensic-exit-compare@1, 2026-10-17,
// the re-audit's ranked improvement #3). Hypothetical, never a transaction.
//
// Two ways to read the same exit over time, side by side, per approved
// exit-quote chain:
//   - fixed dollars: the monitor's quotes at your position size. The token
//     quantity sold changes whenever the price changes;
//   - fixed tokens: the same token quantity at each reading: the quantity
//     your position size bought at the first quote after the assessment.
//     Only quotes for exactly that quantity count: they come from explicit
//     requests Eric makes (forensic-monitor.js quoteFixedToken), never from
//     scaling a dollar quote.
// Each row keeps the quantity (exact, from base units and the decimals for
// this exact chain and contract), the valuation price and its time, the
// route, the quote's age and the cost's completeness. Reading writes nothing
// and asks nothing.

const VERSION = 'cr-forensic-exit-compare@1';

function rowOf(o, { M, XQ, tax, now, mode }) {
  const decimals = o.token && Number.isInteger(o.token.decimals) ? o.token.decimals : null;
  const tokens = o.amount_in && decimals !== null ? XQ.unitsText(o.amount_in, decimals) : null;
  const size = o.quote && typeof o.quote.sell_usd === 'number' ? o.quote.sell_usd : o.size_usd;
  const e = o.quote ? M.exitEstimate(o, mode === 'fixed_token' ? size : o.size_usd, { tax: tax(o) }) : null;
  return {
    obs_id: o.obs_id,
    sha256: o.sha256 || null,
    at: o.observed_at,
    age_hours: Math.round(((now - Date.parse(o.observed_at)) / 3600000) * 10) / 10,
    mode,
    amount_in: o.amount_in || null,
    tokens,
    decimals,
    chain: o.chain || null,
    chain_id: o.chain_id || null,
    contract_address: o.contract_address || null,
    price_usd: o.price ? o.price.usd : null,
    price_as_of: o.price ? o.price.as_of : null,
    value_usd: size ?? null,
    status: o.status,
    route: o.quote ? o.quote.route || null : null,
    received_usd: e && e.status === 'estimated' ? e.received_usd : null,
    net_received_usd: e && e.status === 'estimated' ? e.net_received_usd : null,
    cost_pct: e && e.status === 'estimated' ? e.cost_pct : null,
    cost_complete: e ? e.cost_complete ?? null : null,
    missing_costs: e ? e.missing_costs || [] : [],
    error: o.error || null,
  };
}

// observations: the project's (forensics.readObservations); receipt: the
// shown assessment receipt (its origin anchors the reference quantity).
function comparison({ targets = [], observations = [], receipt = null, prefs, tax = () => null, now = Date.now() }) {
  const M = require('./forensic-model');
  const XQ = require('./exitquotes');
  if (!targets.length) return { version: VERSION, status: 'unavailable', reason: 'No exit-quote chain is approved for this project: approve one under Monitoring to compare exits.', items: [] };
  const size = prefs.exit_position_usd;
  const origin = receipt ? Date.parse(receipt.origin) : null;
  const items = targets.map((t) => {
    const mine = observations.filter((o) => o.target_id === t.target_id && o.kind === 'executable_quote');
    const dollars = mine.filter((o) => o.source === 'monitor' && o.size_usd === size && o.amount_in).sort((a, b) => String(a.observed_at).localeCompare(String(b.observed_at)));
    const anchor = dollars.find((o) => origin === null || Date.parse(o.observed_at) >= origin) || null;
    const head = { target_id: t.target_id, chain: t.chain_label || t.chain, chain_id: t.chain_id, contract_address: t.contract_address, provider: t.provider, quote_symbol: t.quote_symbol };
    if (!anchor) return { ...head, status: 'unavailable', reason: dollars.length ? 'No quote at your position size since this assessment yet.' : 'No quote at your position size yet: the monitor has not asked, or the quote source did not answer.', fixed_usd: [], fixed_token: [], reference: null };
    const decimals = anchor.token ? anchor.token.decimals : null;
    const reference = { amount_in: anchor.amount_in, tokens: XQ.unitsText(anchor.amount_in, decimals), decimals, platform: anchor.token ? anchor.token.platform || null : null, set_from_obs_id: anchor.obs_id, set_at: anchor.observed_at, price_usd: anchor.price ? anchor.price.usd : null, basis: `What $${size} bought at the first quote after the assessment (${anchor.observed_at}).` };
    const fixedUsd = dollars.filter((o) => Date.parse(o.observed_at) >= Date.parse(anchor.observed_at)).slice(-20).map((o) => rowOf(o, { M, XQ, tax, now, mode: 'fixed_usd' }));
    const fixedToken = mine.filter((o) => o.basis_kind === 'fixed_token' && o.amount_in === reference.amount_in).sort((a, b) => String(a.observed_at).localeCompare(String(b.observed_at))).slice(-20).map((o) => rowOf(o, { M, XQ, tax, now, mode: 'fixed_token' }));
    return { ...head, status: 'compared', reference, fixed_usd: fixedUsd, fixed_token: fixedToken, note: fixedToken.length ? null : 'No quote for this exact quantity yet: ask one with "Quote this quantity now".' };
  });
  return { version: VERSION, status: 'compared', size_usd: size, items, note: 'Hypothetical exits: quotes at one moment, never transactions. Fixed dollars sell a different token quantity whenever the price moves; fixed tokens sell the same quantity, whatever it is worth.' };
}

// The quantities an explicit fixed-token quote may ask for on one target:
// the reference quantity of each intact assessment receipt (and of the
// project before any), never any other amount.
function referenceAmounts(ws, pid, target) {
  const F = require('./forensics');
  const observations = F.readObservations(ws, pid, { from: 0, to: Date.now() + 3600000 });
  const receipts = F.investigatorReceipts(F.listReceipts(ws, pid)).filter((r) => F.receiptIntegrity(ws, pid, r).ok);
  const out = new Set();
  for (const r of [null, ...receipts]) {
    const prefs = r ? r.preferences : F.prefsOf(ws);
    const c = comparison({ targets: [target], observations, receipt: r, prefs });
    const ref = c.items && c.items[0] && c.items[0].reference;
    if (ref && ref.amount_in) out.add(ref.amount_in);
  }
  return out;
}

module.exports = { VERSION, comparison, referenceAmounts };
