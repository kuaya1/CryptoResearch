'use strict';
// The contract gate (cr-contract-gate@1): a pure, deterministic reading of
// contract observations (contract-forensics.js), the desk's own on-chain exit
// physics and the value-capture tests. No file, no clock, no network: the
// same inputs give the same bytes.
//
// - Exit physics (cr-contract-exit@1): constant-product proceeds in exact
//   integer arithmetic from the reserves at the pinned block; the cost is
//   (S − received + network fee) / S × 100, kept as a decimal ceiled at 18
//   places; taxes and pool fees are inside the proceeds, never counted twice.
//   The depth to a limit c is R_in × [γ(1−t) − (1−c)] / [(1−c) γ (1−t)].
// - The legacy projection (cr-forensic-exit-legacy@1) rounds a cost UP to
//   three decimals, the shape `packet.exits` has always had.
// - Value capture (cr-value-capture@1): holder yield against dilution and
//   whether taxes on observed volume could be the revenue. Never a share of
//   revenue, never a probability.
// - The verdict: each rule of the table (CG-01 … CG-48) with its tier,
//   block > hold > review > none. Observe mode records it and changes nothing.
// Nothing here calls anything safe.

const crypto = require('crypto');

const GATE_VERSION = 'cr-contract-gate@1';
const ATTESTATION_VERSION = 'cr-contract-attestation@1';
const VALUE_CAPTURE_VERSION = 'cr-value-capture@1';
const EXIT_VERSION = 'cr-contract-exit@1';
const EXIT_LEGACY_VERSION = 'cr-forensic-exit-legacy@1';
const JSON_VERSION = 'cr-forensic-json@1';
const PACKET_V2 = 'cr.ticket-packet.v2';
const MODES = Object.freeze(['observe', 'enforce']);
const PARAMS_DEFAULT = Object.freeze({ ttl_hours: 24, min_timelock_hours: 48, recent_change_days: 30, exit_cost_limit_pct: 5, exit_size_usd: 500 });
const TIER_RANK = Object.freeze({ none: 0, review: 1, hold: 2, block: 3 });

// ---------------------------------------------------------------------------
// Canonical JSON (cr-forensic-json@1): sorted keys, no undefined, no spaces.

function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const hashOf = (v) => sha256(canonicalJson(v));

// ---------------------------------------------------------------------------
// Exact rationals { n, d } over BigInt (d > 0).

function ratio(x) {
  if (typeof x === 'bigint') return { n: x, d: 1n };
  if (x === null || x === undefined || x === '') return null;
  let s = typeof x === 'number' ? (Number.isFinite(x) ? String(x) : null) : String(x).trim();
  if (s === null) return null;
  if (/e/i.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    s = n.toFixed(Math.min(100, Math.max(0, 20 - Math.floor(Math.log10(Math.abs(n) || 1)))));
  }
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const frac = m[3] || '';
  const n = BigInt(`${m[1]}${m[2]}${frac}`);
  return { n, d: 10n ** BigInt(frac.length) };
}
const rAdd = (a, b) => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
const rSub = (a, b) => ({ n: a.n * b.d - b.n * a.d, d: a.d * b.d });
const rMul = (a, b) => ({ n: a.n * b.n, d: a.d * b.d });
const rDiv = (a, b) => (b.n < 0n ? { n: -a.n * b.d, d: a.d * -b.n } : { n: a.n * b.d, d: a.d * b.n });
const rCmp = (a, b) => { const x = a.n * b.d - b.n * a.d; return x > 0n ? 1 : x < 0n ? -1 : 0; };
const floorDiv = (a, b) => (a >= 0n ? a / b : -((-a + b - 1n) / b));
const ceilDiv = (a, b) => -floorDiv(-a, b);

// A rational as a decimal string with `places` decimals: 'ceil', 'floor' or
// 'half_up'; trailing zeros kept when `pad`, else trimmed.
function fixed(r, places, mode = 'ceil', pad = true) {
  const scale = 10n ** BigInt(places);
  const num = r.n * scale;
  let q;
  if (mode === 'ceil') q = ceilDiv(num, r.d);
  else if (mode === 'floor') q = floorDiv(num, r.d);
  else q = floorDiv(num * 2n + r.d, 2n * r.d);
  const neg = q < 0n;
  const digits = (neg ? -q : q).toString().padStart(places + 1, '0');
  let out = places ? `${digits.slice(0, -places)}.${digits.slice(-places)}` : digits;
  if (!pad && places) out = out.replace(/\.?0+$/, '');
  return `${neg ? '-' : ''}${out}`;
}

// ---------------------------------------------------------------------------
// Exit physics

// Tokens (base units) for a USD size at a reference price, floored, in exact
// integer arithmetic (the rule exitquotes.js sizes with).
function tokensFor(sizeUsd, priceUsd, decimals) {
  const s = ratio(sizeUsd);
  const p = ratio(priceUsd);
  if (!s || !p || p.n <= 0n || !Number.isInteger(decimals) || decimals < 0) return null;
  return (s.n * p.d * 10n ** BigInt(decimals)) / (s.d * p.n);
}

// A token quantity (decimal string) in base units, exactly; null when it is
// not a positive whole number of them (never rounded: CG-14 compares it).
function baseUnits(quantity, decimals) {
  const r = ratio(quantity);
  if (!r || r.n <= 0n || !Number.isInteger(decimals) || decimals < 0) return null;
  const num = r.n * 10n ** BigInt(decimals);
  return num % r.d === 0n ? num / r.d : null;
}

// Base units as a decimal token quantity, trailing zeros trimmed.
function tokensText(base, decimals) {
  const s = BigInt(base).toString().padStart(decimals + 1, '0');
  return decimals ? `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, '') : s;
}

// The smallest whole number of lots that is also a whole number of base
// units (the trader's lot, trader-desk.js LOT, at the token's decimals); a
// quantity is a valid order quantity exactly when it is a multiple of it.
function lotStep(lot, decimals) {
  const r = ratio(lot);
  if (!r || r.n <= 0n || !Number.isInteger(decimals) || decimals < 0) return null;
  const num = r.n * 10n ** BigInt(decimals);
  let a = num;
  let b = r.d;
  while (b) [a, b] = [b, a % b];
  return num / a;
}

// The token base units a concentrated pool's quote at `label` was asked for:
// as recorded (`quoted_in`, lot-aligned capture, audit 2026-11-08), or for a
// pool recorded before it, rebuilt from the observation's stored price the
// way quotePools sized it. Null when it cannot be proven.
// A pool's quote inputs are 'recorded' (`quoted_in` is a plain map),
// 'legacy' (the field is absent: only then may an input be rebuilt) or
// 'invalid' (present but null, a scalar, an array or another object: no quote
// of the pool is eligible). Within a recorded map, only a canonical positive
// integer string is an input; any other value makes that quote ineligible
// (audit round 5).
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function quoteRecord(pool) {
  if (!pool || typeof pool !== 'object' || !own(pool, 'quoted_in') || pool.quoted_in === undefined) return 'legacy';
  const m = pool.quoted_in;
  return m !== null && typeof m === 'object' && Object.getPrototypeOf(m) === Object.prototype ? 'recorded' : 'invalid';
}
function quoteInput(pool, label, quotePriceUsd, decimals) {
  const how = quoteRecord(pool);
  if (how === 'invalid') return null;
  if (how === 'recorded') {
    const v = own(pool.quoted_in, label) ? pool.quoted_in[label] : undefined;
    return typeof v === 'string' && /^[1-9]\d*$/.test(v) ? BigInt(v) : null;
  }
  return quotePriceUsd === null || quotePriceUsd === undefined ? null : tokensFor(label, quotePriceUsd, decimals);
}

const storedPrice = (o) => (o && o.price_ref && typeof o.price_ref.usd === 'string' && o.price_ref.usd ? o.price_ref.usd : null);

// Every provable quote of an observation's counted concentrated pools: the
// quantity it was asked for and the quoter's answer.
function quotedQuantities(observation) {
  const dec = observation && observation.token ? observation.token.decimals : null;
  const price = storedPrice(observation);
  const out = [];
  for (const p of Array.isArray(observation && observation.pools) ? observation.pools : []) {
    if (p.counted !== true || p.mechanism !== 'concentrated' || !p.quoted) continue;
    for (const [label, v] of Object.entries(p.quoted)) {
      if (v === null || v === undefined) continue;
      const base = quoteInput(p, label, price, dec);
      if (base !== null && base > 0n) out.push({ pool: p.pool, label, base, out: String(v), recorded: quoteRecord(p) === 'recorded' });
    }
  }
  return out;
}

// The mechanisms whose sale CG-14 values at no less than the sold quantity
// at the observation's stored price (audit round 5). A fixed quoter answer,
// or reserves read at that price, measured against quantity x a lower entry
// would look cheaper than the same sale measured where it was read. A
// constant-product pool's reserves are read at that price too (the same
// arithmetic on the base path, reproduced in round 5), so it is valued the
// same way; its ladder rows, sized at the ticket's price, are unchanged.
const VALUED_AT_OBSERVATION = new Set(['concentrated', 'constant_product']);

// Constant-product output for an input already net of the token's tax.
function cpOut({ rIn, rOut, feeBps, qIn }) {
  const g = BigInt(10000 - feeBps);
  return (BigInt(qIn) * g * BigInt(rOut)) / (BigInt(rIn) * 10000n + BigInt(qIn) * g);
}

// One size's exit from one pool. `pool`: { mechanism, reserves: { token,
// quote } (base-unit strings), fee_bps, quote_decimals, quote_usd, quoted }
// where `quoted` maps a size to the quoter's output for a concentrated pool.
// taxBps null is an unknown tax; networkFeeUsd null an unknown fee: either
// leaves the cost a lower bound ("at least"). With `sellBase` (CG-14 only:
// the fitted order's own quantity in base units), that quantity is sold, and
// a concentrated pool's quote counts only when the quantity it was asked for
// (quoteInput: recorded, or its size at the observation's stored price,
// `quotePriceUsd`) is that one. A ladder row of a pool that records its
// inputs sells the quantity the quote was asked for.
// Valuation (audit round 5): with `sellBase`, a VALUED_AT_OBSERVATION pool's
// cost is measured against the larger of `sizeUsd` (the fitted notional,
// quantity x entry) and the sold quantity at the observation's stored price
// (`valuePriceUsd`); with no stored price the sale is not valued, so it is
// not proven. A ladder row selling a recorded quote input is valued at that
// quantity at the stored price, the basis the guard uses, not at its label.
function exitAt({ sizeUsd, priceUsd, tokenDecimals, taxBps, pool, networkFeeUsd, sellBase, quotePriceUsd, valuePriceUsd }) {
  const fitted = sellBase !== undefined;
  const how = pool.mechanism === 'concentrated' ? quoteRecord(pool) : null;
  const asked = !fitted && how === 'recorded' ? quoteInput(pool, String(sizeUsd), null, tokenDecimals) : null;
  // A ladder row is never read off a quote whose recorded input is malformed
  // or missing: its quantity is unknown, so the row is not a reading.
  const answered = Boolean(pool.quoted) && pool.quoted[String(sizeUsd)] !== undefined && pool.quoted[String(sizeUsd)] !== null;
  if (!fitted && (how === 'invalid' || (how === 'recorded' && asked === null && answered))) return { size_usd: sizeUsd, status: 'unavailable', words: 'The quote\'s recorded input is missing or malformed, so the quote is not used.' };
  const q = fitted ? sellBase : asked !== null ? asked : tokensFor(sizeUsd, priceUsd, tokenDecimals);
  const missing = [];
  if (q === null) return { size_usd: sizeUsd, status: 'unavailable', words: fitted ? 'The fitted quantity is not a whole number of the token\'s base units.' : 'No usable price or decimals to size the sale.' };
  const tax = Number.isInteger(taxBps) && taxBps >= 0 && taxBps <= 10000 ? taxBps : null;
  if (tax === null) missing.push('transfer_tax');
  const qIn = (q * BigInt(10000 - (tax || 0))) / 10000n;
  const valued = VALUED_AT_OBSERVATION.has(pool.mechanism) && (fitted || asked !== null);
  const vp = valued ? ratio(valuePriceUsd) : null;
  if (valued && fitted && (!vp || vp.n <= 0n)) return { size_usd: sizeUsd, status: 'unavailable', words: 'The observation has no stored price, so the sale cannot be valued at it.' };
  let out;
  if (pool.mechanism === 'constant_product') {
    if (!Number.isInteger(pool.fee_bps)) return { size_usd: sizeUsd, status: 'unavailable', words: 'The pool\'s fee is not stated.' };
    out = cpOut({ rIn: pool.reserves.token, rOut: pool.reserves.quote, feeBps: pool.fee_bps, qIn });
  } else if (pool.mechanism === 'concentrated') {
    if (how === 'invalid') return { size_usd: sizeUsd, status: 'unavailable', words: 'The pool\'s recorded quote inputs are malformed, so none of its quotes is used.' };
    const k = !pool.quoted ? undefined : fitted ? Object.keys(pool.quoted).find((x) => quoteInput(pool, x, quotePriceUsd, tokenDecimals) === q) : String(sizeUsd);
    const v = k === undefined ? undefined : pool.quoted[k];
    if (v === undefined || v === null) return { size_usd: sizeUsd, status: 'unavailable', words: fitted ? 'The quoter gave no answer for this token quantity.' : 'The quoter gave no answer at this size.' };
    out = BigInt(v);
  } else return { size_usd: sizeUsd, status: 'unavailable', words: `A ${pool.mechanism} pool is not computed by the desk.` };
  const qUsd = ratio(pool.quote_usd);
  if (!qUsd) return { size_usd: sizeUsd, status: 'unavailable', words: 'The quote asset has no stated USD value.' };
  const received = rDiv(rMul({ n: out, d: 1n }, qUsd), { n: 10n ** BigInt(pool.quote_decimals), d: 1n });
  const fee = ratio(networkFeeUsd);
  if (!fee) missing.push('network_fee');
  let S = ratio(sizeUsd);
  let basis = fitted ? 'entry' : 'size';
  if (vp && vp.n > 0n) {
    const v = rDiv(rMul({ n: q, d: 1n }, vp), { n: 10n ** BigInt(tokenDecimals), d: 1n });
    if (!fitted || rCmp(v, S) > 0) { S = v; basis = 'observation'; }
  }
  const cost = rMul(rDiv(rAdd(rSub(S, received), fee || { n: 0n, d: 1n }), S), { n: 100n, d: 1n });
  return {
    size_usd: sizeUsd,
    value_usd: fixed(S, 2, 'ceil', false),
    value_basis: basis,
    status: 'ok',
    q: q.toString(),
    q_in: qIn.toString(),
    out: out.toString(),
    received_usd: fixed(received, 6, 'floor', false),
    cost_pct: fixed(cost, 18, 'ceil', false),
    cost_pct_3: fixed(cost, 3, 'half_up'),
    cost_complete: missing.length === 0,
    missing_costs: missing,
    network_fee: fee ? 'ceiling' : 'unknown',
  };
}

// The largest sale (token base units) within the limit in one constant-product
// pool, before the network fee; null when no size can pass.
function depthToLimit({ rIn, feeBps, taxBps, limitPct }) {
  const c = ratio(limitPct);
  if (!c || !Number.isInteger(feeBps) || !Number.isInteger(taxBps)) return { tokens: null, words: 'Fee, tax or limit unknown.' };
  const cBps = (c.n * 10000n) / (c.d * 100n); // limit in bps of the sale
  const gt = BigInt(10000 - feeBps) * BigInt(10000 - taxBps); // γ(1−t) × 1e8
  const keep = (10000n - cBps) * 10000n; // (1−c) × 1e8
  if (gt <= keep) return { tokens: null, words: `No size passes: the pool's fee and the tax alone take ${fixed({ n: 100000000n - gt, d: 1000000n }, 3, 'half_up', false)}%, at or over the ${fixed(c, 2, 'half_up', false)}% limit.` };
  return { tokens: (BigInt(rIn) * (gt - keep) * 10000n) / ((10000n - cBps) * gt), words: null };
}

// The legacy packet row (cr-forensic-exit-legacy@1): the cost rounded UP to
// three decimals, so the projection is never cheaper than the reading.
function legacyExit(row, asOf) {
  if (!row || row.status !== 'ok') return { size_usd: row ? row.size_usd : null, status: 'no_reading', cost_pct: null, cost_complete: null, missing_costs: [], method: 'desk_onchain', route_scope: 'desk_onchain', as_of: asOf || null, note: row && row.words ? row.words : null };
  return { size_usd: row.size_usd, status: 'current', cost_pct: Number(fixed(ratio(row.cost_pct), 3, 'ceil')), cost_complete: row.cost_complete, missing_costs: row.missing_costs, method: 'desk_onchain', route_scope: 'desk_onchain', as_of: asOf || null, note: null, projection: EXIT_LEGACY_VERSION };
}

// Every verified pool of an observation priced at each size; the cheapest
// complete reading per size, else the cheapest.
function exitLadder(observation, { sizes, priceUsd, networkFeeUsd, limitPct, sellBase, quotePriceUsd }) {
  const pools = Array.isArray(observation && observation.pools) ? observation.pools : [];
  const tp = observation && observation.transfer_probe;
  const taxBps = tp && tp.status === 'ok' && tp.sell_path ? tp.sell_path.tax_bps : null;
  const dec = observation && observation.token ? observation.token.decimals : null;
  const usable = pools.filter((p) => p.counted === true);
  const valuePriceUsd = storedPrice(observation);
  const per = usable.map((p) => ({
    pool: p.pool,
    mechanism: p.mechanism,
    rows: sizes.map((s) => exitAt({ sizeUsd: s, priceUsd, tokenDecimals: dec, taxBps, pool: p, networkFeeUsd, sellBase, quotePriceUsd, valuePriceUsd })),
    depth: p.mechanism === 'constant_product' && taxBps !== null ? depthToLimit({ rIn: p.reserves.token, feeBps: p.fee_bps, taxBps, limitPct }) : null,
  }));
  const best = sizes.map((s) => {
    const rows = per.map((p) => ({ ...p.rows.find((r) => r.size_usd === s), pool: p.pool })).filter((r) => r.status === 'ok');
    const complete = rows.filter((r) => r.cost_complete);
    const pick = (list) => list.slice().sort((a, b) => rCmp(ratio(a.cost_pct), ratio(b.cost_pct)) || (a.pool < b.pool ? -1 : 1))[0] || null;
    return { size_usd: s, best: pick(complete) || pick(rows) };
  });
  return { version: EXIT_VERSION, tax_bps: taxBps, pools: per, best, excluded: pools.filter((p) => p.counted !== true).map((p) => ({ pool: p.pool, reason: p.excluded })) };
}

// Price freshness (audit round 6). CG-14 values a sale at the observation's
// stored price, so that price must belong to the block the quotes and
// reserves were read at. Its time (`price_ref.as_of`) and the block's time
// must be no further apart, either way, than the lower of the desk's
// `freshness.price_stale_minutes` (resolved by the caller) and 90 minutes;
// exactly at the limit passes. The price may not be dated more than 10
// minutes after the capture finished (the market read's own allowance for a
// source clock). Times are read only as the desk writes them
// (Date#toISOString: UTC with milliseconds) and must be real instants. The
// rule compares the record with itself, never with the clock: how old the
// observation is now is CG-20's. A missing stored price keeps its own hold.
const PRICE_GAP_CAP_MINUTES = 90;
const PRICE_AFTER_CAPTURE_MS = 10 * 60000;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function utcMs(s) {
  if (typeof s !== 'string' || !ISO_UTC.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) && new Date(t).toISOString() === s ? t : null;
}
function priceFreshness(observation, staleMinutes) {
  if (!(Number.isSafeInteger(staleMinutes) && staleMinutes > 0)) return { ok: false, state: 'no_limit', limit_minutes: null, words: 'the desk\'s price freshness limit (freshness.price_stale_minutes) is not a positive whole number of minutes' };
  const limit = Math.min(staleMinutes, PRICE_GAP_CAP_MINUTES);
  const pr = observation && observation.price_ref;
  const blk = observation && observation.block && typeof observation.block === 'object' ? observation.block.timestamp : undefined;
  const fin = observation && observation.retrieved && typeof observation.retrieved === 'object' ? observation.retrieved.finished_at : undefined;
  const out = { limit_minutes: limit, as_of: pr && typeof pr === 'object' && pr.as_of !== undefined ? pr.as_of : null, block_time: blk === undefined ? null : blk, finished_at: fin === undefined ? null : fin };
  const absent = (v) => v === undefined || v === null;
  if (!pr || typeof pr !== 'object' || absent(pr.as_of)) return { ...out, ok: false, state: 'no_time', words: 'its stored price carries no time' };
  const at = utcMs(pr.as_of);
  if (at === null) return { ...out, ok: false, state: 'malformed_time', words: 'its stored price\'s time is not a valid UTC time' };
  const block = utcMs(blk);
  if (block === null) return { ...out, ok: false, state: absent(blk) ? 'no_block_time' : 'malformed_block_time', words: absent(blk) ? 'its block carries no time to compare the stored price with' : 'its block\'s time is not a valid UTC time' };
  const done = utcMs(fin);
  if (done === null) return { ...out, ok: false, state: absent(fin) ? 'no_capture_time' : 'malformed_capture_time', words: absent(fin) ? 'its capture carries no finish time to check the stored price against' : 'its capture\'s finish time is not a valid UTC time' };
  if (at > done + PRICE_AFTER_CAPTURE_MS) return { ...out, ok: false, state: 'after_capture', words: `its stored price is dated ${pr.as_of}, more than 10 minutes after the capture finished (${fin})` };
  const gap = Math.abs(block - at);
  if (gap > limit * 60000) return { ...out, gap_ms: gap, ok: false, state: 'stale', words: `its stored price (${pr.as_of}) is ${(gap / 60000).toFixed(3)} minutes ${at < block ? 'before' : 'after'} its block (${blk}), past the ${limit}-minute limit` };
  return { ...out, gap_ms: gap, ok: true, state: 'ok', words: null };
}

// The exit at the trader's fitted notional (CG-14, F08): a grant is the loss
// at the stop, so the position is the risk over the stop distance, and its
// exit is checked at that size, not at the reference tranche. Only a cost
// known in full and within the limit passes; no pool that prices the size
// (a concentrated pool is quoted at the ladder's sizes only) is not a pass.
// The sale is the order's own `quantity` (the trader's sizing), in base
// units: a quote counts only when it was asked for exactly that many, never
// for a quantity rebuilt from a dollar figure (audit 2026-11-08).
// `priceStaleMinutes`: the desk's resolved freshness.price_stale_minutes; the
// stored price must pass priceFreshness, or the order holds (audit round 6).
function fittedExit(observation, { notionalUsd, priceUsd, networkFeeUsd, limitPct, quantity, priceStaleMinutes }) {
  const n = ratio(notionalUsd);
  const lim = ratio(limitPct);
  const size = n ? fixed(n, 2, 'ceil', false) : null;
  const base = { rule_id: 'CG-14', notional_usd: size, quantity: quantity === undefined ? null : quantity, limit_pct: limitPct };
  if (!n || n.n <= 0n || !lim) return { ...base, ok: false, cost_pct: null, words: 'The fitted notional or the exit-cost limit is unknown.' };
  const dec = observation && observation.token ? observation.token.decimals : null;
  const sellBase = quantity === undefined || quantity === null ? null : baseUnits(quantity, dec);
  if (sellBase === null) return { ...base, ok: false, cost_pct: null, words: `The fitted quantity ${quantity === undefined || quantity === null ? 'is unknown' : `${quantity} is not a whole number of the token's base units`}, so the exit at the fitted notional $${size} is not proven within ${limitPct}%.` };
  const quotePriceUsd = storedPrice(observation);
  const fresh = priceFreshness(observation, priceStaleMinutes);
  if (!fresh.ok && (quotePriceUsd !== null || fresh.state === 'no_limit')) return { ...base, ok: false, cost_pct: null, price_check: fresh, words: `The observation's stored price cannot value this sale: ${fresh.words}, so the exit at the fitted notional $${size} is not proven within ${limitPct}%.` };
  const b = exitLadder(observation, { sizes: [notionalUsd], priceUsd, networkFeeUsd, limitPct, sellBase, quotePriceUsd }).best[0].best;
  const why = quotePriceUsd === null && Array.isArray(observation && observation.pools) && observation.pools.some((p) => p.counted === true && VALUED_AT_OBSERVATION.has(p.mechanism)) ? ' (the observation has no stored price, so the sale cannot be valued at it, nor a quote tied to a token quantity)' : '';
  if (!b) return { ...base, ok: false, cost_pct: null, words: `No verified pool prices a sale of $${size} on chain${why}, so the exit at the fitted notional is not proven within ${limitPct}%.` };
  // The basis, said only when it is the observation's (the stricter one).
  const at = b.value_basis === 'observation' ? `, measured against the ${quantity} tokens at the observation price $${quotePriceUsd} ($${b.value_usd}),` : '';
  const got = { ...base, cost_pct: b.cost_pct, cost_pct_3: b.cost_pct_3, pool: b.pool, value_usd: b.value_usd, value_basis: b.value_basis, price_check: fresh };
  if (!b.cost_complete) return { ...got, ok: false, words: `The exit cost at the fitted notional $${size}${at} is at least ${b.cost_pct_3}% (${b.missing_costs.join(', ').replace(/_/g, ' ')} unknown): not proven within ${limitPct}%.` };
  if (rCmp(ratio(b.cost_pct), lim) > 0) return { ...got, ok: false, words: `The exit cost at the fitted notional $${size}${at} is ${b.cost_pct_3}%, over the ${limitPct}% limit.` };
  return { ...got, ok: true, words: `The exit cost at the fitted notional $${size}${at} is ${b.cost_pct_3}%, within ${limitPct}%.` };
}

// ---------------------------------------------------------------------------
// Value capture (cr-value-capture@1)

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pct = (v) => `${(v * 100).toFixed(1)}%`;

// Inputs: { holders_revenue_30d_usd, revenue_30d_usd, market_cap_usd,
// onchain_supply_growth_annual, circulating_supply_growth_annual,
// buy_tax_pct, sell_tax_pct, volume_30d_usd } with null for unknown.
function valueCapture(inputs) {
  const i = inputs || {};
  const hr = num(i.holders_revenue_30d_usd);
  const rev = num(i.revenue_30d_usd);
  const mc = num(i.market_cap_usd);
  const y = hr !== null && mc !== null && mc > 0 ? (hr * (365 / 30)) / mc : null;
  const growths = [num(i.onchain_supply_growth_annual), num(i.circulating_supply_growth_annual)].filter((v) => v !== null);
  const g = growths.length ? Math.max(...growths) : null;
  const taxes = [num(i.buy_tax_pct), num(i.sell_tax_pct)];
  const tax = taxes.some((v) => v === null) ? (taxes.some((v) => v !== null && v > 0) ? Math.max(...taxes.filter((v) => v !== null)) : null) : Math.max(...taxes);
  let vc3;
  let needed = null;
  if (tax === null) vc3 = 'unknown';
  else if (tax === 0) vc3 = 'not_applicable';
  else if (rev === null) vc3 = 'unknown';
  else {
    needed = rev / (tax / 100);
    const vol = num(i.volume_30d_usd);
    vc3 = vol === null ? 'unknown' : vol >= needed ? 'yes' : 'no';
  }
  const vc4 = y !== null && g !== null ? y - g : null;
  const classes = [];
  if (vc3 === 'yes') classes.push('tax_entangled');
  if (y === 0 && g !== null && g <= 0) classes.push('no_holder_flow');
  else if (y !== null && g !== null && g >= y) classes.push('diluted');
  if (y !== null && g !== null && y > g && (vc3 === 'no' || vc3 === 'not_applicable')) classes.push('usage_bound');
  if (!classes.length) classes.push('unknown');
  const said = [];
  if (y !== null) said.push(`holder yield ${pct(y)} a year of market cap`);
  if (g !== null) said.push(`supply growth ${pct(g)} a year`);
  if (vc3 === 'yes') said.push('taxes on the observed volume could produce the stated revenue');
  if (vc3 === 'no') said.push('taxes on the observed volume could not produce the stated revenue');
  return {
    version: VALUE_CAPTURE_VERSION,
    classes: classes.sort(),
    organic_demand: 'not_proven',
    tests: {
      VC1: { holder_yield_annual: y },
      VC2: { dilution_annual: g },
      VC3: { state: vc3, volume_needed_30d_usd: needed },
      VC4: { net_holder_accrual_annual: vc4 },
    },
    words: `${classes.map((c) => c.replace(/_/g, ' ')).join(', ')}${said.length ? `: ${said.join('; ')}` : ': the inputs are not all known'}.`,
  };
}

// ---------------------------------------------------------------------------
// The verdict

const CAP_RULE = Object.freeze({ C1: 'CG-03', C2: 'CG-04', C3: 'CG-05', C4: 'CG-06', C5: 'CG-07', C6: 'CG-08' });
const CAP_WORDS = Object.freeze({ C1: 'upgrade the code', C2: 'mint supply', C3: 'move or destroy others\' balances', C4: 'pause, blacklist or freeze', C5: 'change fees or taxes', C6: 'change the transfer hook', C7: 'self-destruct' });
const UPGRADEABLE = new Set(['erc1967_transparent', 'erc1967_uups', 'erc1967_beacon', 'eip1822', 'oz_legacy']);

function ageHours(iso, now) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (now - t) / 3600000 : null;
}

// subjects: [{ role: 'exit_chain' | 'other_chain', chain_id, address,
// observation | null, reason (when null), transitions }]. vendor: { severe:
// [words], watch: [words] }. exits: an exitLadder of the exit chain.
function verdict({ subjects = [], vendor = null, exits = null, valueCapture: vc = null, params = {}, now }) {
  const P = { ...PARAMS_DEFAULT, ...params };
  const limitBps = Math.round(P.exit_cost_limit_pct * 100);
  const F = [];
  const add = (rule_id, tier, chain_id, words) => F.push({ rule_id, tier, chain_id: chain_id || null, words });
  for (const s of subjects) {
    const o = s.observation;
    const cid = s.chain_id;
    if (!o) {
      if (s.reason === 'reorged') add('CG-27', 'hold', cid, 'The pinned block was replaced twice in a row; nothing was kept.');
      else if (s.role === 'exit_chain') add('CG-26', 'hold', cid, `The exit chain's contract is not observed (${String(s.reason || 'not observed').replace(/_/g, ' ')}).`);
      else add('CG-48', 'review', cid, `A secondary chain's contract is not observed (${String(s.reason || 'not observed').replace(/_/g, ' ')}).`);
      continue;
    }
    const age = ageHours(o.block && o.block.timestamp ? o.block.timestamp : o.retrieved && o.retrieved.finished_at, now);
    if (age === null || age > P.ttl_hours) {
      if (s.role === 'exit_chain') add('CG-20', 'hold', cid, `The latest observation is older than ${P.ttl_hours} hours.`);
      else add('CG-48', 'review', cid, `A secondary chain's observation is older than ${P.ttl_hours} hours.`);
    }
    const t = o.token || {};
    if (t.code_kind === 'empty') add('CG-01', 'block', cid, 'No contract code at the token address at the finalized block.');
    if (t.code_kind === 'eip7702_delegated') add('CG-02', 'block', cid, 'The token address is an EIP-7702 delegated account.');
    if (o.flags && (o.flags.non_transferable || o.flags.default_frozen)) add('CG-12', 'block', cid, o.flags.non_transferable ? 'The mint is non-transferable.' : 'New token accounts start frozen.');
    const p = o.proxy;
    if (p && p.supported === false) add('CG-21', 'hold', cid, p.words || `A ${String(p.kind).replace(/_/g, ' ')} proxy is not one the desk reads.`);
    const fns = (o.surface && Array.isArray(o.surface.functions) ? o.surface.functions : []).filter((f) => /^C[1-6]$/.test(f.capability));
    const srcOk = o.source && ['verified_full', 'verified_partial'].includes(o.source.status);
    if (o.source && !srcOk && ((p && UPGRADEABLE.has(p.kind)) || fns.length)) add('CG-22', 'hold', cid, 'The code that holds these powers has no verified source.');
    for (const a of Array.isArray(o.authorities) ? o.authorities : []) {
      const rule = CAP_RULE[a.capability];
      const what = CAP_WORDS[a.capability] || a.capability;
      if (a.capability === 'C7') { add('CG-44', 'review', cid, 'SELFDESTRUCT appears in the code.'); continue; }
      if (!rule) continue;
      if ((a.capability === 'C2' || a.capability === 'C3') && a.random_caller === 'succeeded') { add(rule, 'block', cid, `Any caller can ${what}: an unguarded call succeeded.`); continue; }
      if (a.capability === 'C3' && a.class !== 'K1') { add(rule, 'block', cid, `A live controller (${a.class}) can ${what} without an allowance.`); continue; }
      if (a.class === 'K4' || a.class === 'K5') add(rule, 'block', cid, `One key can ${what} (${a.class}).`);
      else if (a.class === 'K6') add('CG-23', 'hold', cid, `Who can ${what} is not established: ${a.words || 'unknown controller'}`);
      else if (a.class === 'K3') add('CG-40', 'review', cid, `A multisig can ${what}.`);
      else if (a.class === 'K2') add('CG-41', 'review', cid, `A timelock of ${a.delay_hours} hours can ${what}.`);
    }
    if (o.block && o.block.latest_slots_match === false) add('CG-24', 'hold', cid, 'The proxy state at latest differs from the finalized block: a change is in flight.');
    if (o.supply && o.supply.explained === false) add('CG-25', 'hold', cid, 'Supply moved more than its own mint and burn events account for.');
    if (o.surface && Array.isArray(o.surface.unclassified_mutators) && o.surface.unclassified_mutators.length) add('CG-44', 'review', cid, `${o.surface.unclassified_mutators.length} state-changing function${o.surface.unclassified_mutators.length === 1 ? '' : 's'} the desk does not classify.`);
    const tp = o.transfer_probe;
    if (tp && (tp.status === 'reverted' || tp.status === 'returned_false')) add('CG-09', 'block', cid, `A sale to the pool ${tp.status === 'reverted' ? 'reverted' : 'returned false'} at the pinned block.`);
    if (tp && tp.status === 'ok' && tp.sell_path) {
      if (tp.sell_path.tax_bps >= limitBps) add('CG-10', 'block', cid, `The measured sell tax (${tp.sell_path.tax_bps / 100}%) is at or over the ${P.exit_cost_limit_pct}% exit-cost limit.`);
      else if (tp.sell_path.tax_bps > 0) add('CG-43', 'review', cid, `A sell tax of ${tp.sell_path.tax_bps / 100}% was measured.`);
    }
    for (const tr of Array.isArray(s.transitions) ? s.transitions : []) {
      const ch = Array.isArray(tr.changes) ? tr.changes : [];
      const recent = (() => { const h = ageHours(tr.at, now); return h !== null && h <= P.recent_change_days * 24; })();
      if (ch.some((c) => c.field === 'token.code_hash') && !(p && p.kind !== 'none')) add('CG-13', 'block', cid, 'The token\'s runtime code changed without a proxy.');
      if (recent && ch.some((c) => c.field === 'proxy.implementation' || c.field === 'proxy.implementation_code_hash')) add('CG-42', 'review', cid, `The implementation changed within ${P.recent_change_days} days.`);
    }
  }
  if (exits && Array.isArray(exits.best)) {
    const ref = exits.best.find((b) => b.size_usd === P.exit_size_usd);
    if (ref && ref.best && ref.best.cost_complete && rCmp(ratio(ref.best.cost_pct), ratio(P.exit_cost_limit_pct)) > 0) add('CG-10', 'block', subjects.find((s) => s.role === 'exit_chain') ? subjects.find((s) => s.role === 'exit_chain').chain_id : null, `The complete on-chain exit cost at $${P.exit_size_usd} is ${ref.best.cost_pct_3}%, over the ${P.exit_cost_limit_pct}% limit.`);
  }
  for (const w of vendor && Array.isArray(vendor.severe) ? vendor.severe : []) add('CG-11', 'block', null, `GoPlus severe flag: ${w}.`);
  if (vc && Array.isArray(vc.classes)) for (const c of vc.classes.filter((x) => ['diluted', 'tax_entangled', 'no_holder_flow'].includes(x))) add('CG-46', 'review', null, `Value capture: ${c.replace(/_/g, ' ')}.`);
  const seen = new Set();
  const findings = F.filter((f) => { const k = canonicalJson(f); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : String(a.chain_id) < String(b.chain_id) ? -1 : String(a.chain_id) > String(b.chain_id) ? 1 : a.words < b.words ? -1 : a.words > b.words ? 1 : 0));
  const tier = findings.reduce((t, f) => (TIER_RANK[f.tier] > TIER_RANK[t] ? f.tier : t), 'none');
  return { version: GATE_VERSION, tier, findings, findings_sha256: hashOf(findings), words: verdictWords(tier, findings) };
}

function verdictWords(tier, findings) {
  const n = (t) => findings.filter((f) => f.tier === t).length;
  if (tier === 'none') return 'No finding by these checks. Not covered: LP removal.';
  const parts = [['block', 'blocking'], ['hold', 'holding'], ['review', 'for review']].filter(([t]) => n(t)).map(([t, w]) => `${n(t)} ${w}`);
  const first = findings.find((f) => f.tier === tier);
  return `${parts.join(', ')}: ${first.words}`;
}

const tierOf = (v) => (v && TIER_RANK[v.tier] !== undefined ? v.tier : 'none');

module.exports = {
  GATE_VERSION, ATTESTATION_VERSION, VALUE_CAPTURE_VERSION, EXIT_VERSION, EXIT_LEGACY_VERSION, JSON_VERSION, PACKET_V2, MODES, PARAMS_DEFAULT, TIER_RANK, CAP_RULE,
  canonicalJson, hashOf, ratio, fixed, tokensFor, baseUnits, tokensText, lotStep, quoteRecord, quoteInput, quotedQuantities, cpOut, exitAt, depthToLimit, legacyExit, exitLadder, utcMs, priceFreshness, PRICE_GAP_CAP_MINUTES, fittedExit, valueCapture, verdict, tierOf,
};
