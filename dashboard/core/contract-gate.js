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

// Constant-product output for an input already net of the token's tax.
function cpOut({ rIn, rOut, feeBps, qIn }) {
  const g = BigInt(10000 - feeBps);
  return (BigInt(qIn) * g * BigInt(rOut)) / (BigInt(rIn) * 10000n + BigInt(qIn) * g);
}

// One size's exit from one pool. `pool`: { mechanism, reserves: { token,
// quote } (base-unit strings), fee_bps, quote_decimals, quote_usd, quoted }
// where `quoted` maps a size to the quoter's output for a concentrated pool.
// taxBps null is an unknown tax; networkFeeUsd null an unknown fee: either
// leaves the cost a lower bound ("at least").
function exitAt({ sizeUsd, priceUsd, tokenDecimals, taxBps, pool, networkFeeUsd }) {
  const q = tokensFor(sizeUsd, priceUsd, tokenDecimals);
  const missing = [];
  if (q === null) return { size_usd: sizeUsd, status: 'unavailable', words: 'No usable price or decimals to size the sale.' };
  const tax = Number.isInteger(taxBps) && taxBps >= 0 && taxBps <= 10000 ? taxBps : null;
  if (tax === null) missing.push('transfer_tax');
  const qIn = (q * BigInt(10000 - (tax || 0))) / 10000n;
  let out;
  if (pool.mechanism === 'constant_product') {
    if (!Number.isInteger(pool.fee_bps)) return { size_usd: sizeUsd, status: 'unavailable', words: 'The pool\'s fee is not stated.' };
    out = cpOut({ rIn: pool.reserves.token, rOut: pool.reserves.quote, feeBps: pool.fee_bps, qIn });
  } else if (pool.mechanism === 'concentrated') {
    const v = pool.quoted && pool.quoted[String(sizeUsd)];
    if (v === undefined || v === null) return { size_usd: sizeUsd, status: 'unavailable', words: 'The quoter gave no answer at this size.' };
    out = BigInt(v);
  } else return { size_usd: sizeUsd, status: 'unavailable', words: `A ${pool.mechanism} pool is not computed by the desk.` };
  const qUsd = ratio(pool.quote_usd);
  if (!qUsd) return { size_usd: sizeUsd, status: 'unavailable', words: 'The quote asset has no stated USD value.' };
  const received = rDiv(rMul({ n: out, d: 1n }, qUsd), { n: 10n ** BigInt(pool.quote_decimals), d: 1n });
  const fee = ratio(networkFeeUsd);
  if (!fee) missing.push('network_fee');
  const S = ratio(sizeUsd);
  const cost = rMul(rDiv(rAdd(rSub(S, received), fee || { n: 0n, d: 1n }), S), { n: 100n, d: 1n });
  return {
    size_usd: sizeUsd,
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
function exitLadder(observation, { sizes, priceUsd, networkFeeUsd, limitPct }) {
  const pools = Array.isArray(observation && observation.pools) ? observation.pools : [];
  const tp = observation && observation.transfer_probe;
  const taxBps = tp && tp.status === 'ok' && tp.sell_path ? tp.sell_path.tax_bps : null;
  const dec = observation && observation.token ? observation.token.decimals : null;
  const usable = pools.filter((p) => p.counted === true);
  const per = usable.map((p) => ({
    pool: p.pool,
    mechanism: p.mechanism,
    rows: sizes.map((s) => exitAt({ sizeUsd: s, priceUsd, tokenDecimals: dec, taxBps, pool: p, networkFeeUsd })),
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
  canonicalJson, hashOf, ratio, fixed, tokensFor, cpOut, exitAt, depthToLimit, legacyExit, exitLadder, valueCapture, verdict, tierOf,
};
