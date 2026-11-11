'use strict';
// The opening receipt (cr.opening-guard.v1, 2026-11-10; design:
// B1-DECISION-RECEIPT, the "record inside the order").
//
// What it is. When the trader's adapter asks the Paper Book for a new
// opening, the contract guard's final reading for exactly that order goes on
// the intent: which observation and block the guard evaluated, the pool that
// proved the exit and at what unrounded cost, the limits and the rule's
// versions it was read under, the quantity the risk sized and the quantity
// asked for, and, when the order was sized down to a saved quote, the pool
// and reference rung that quote came from. The book copies the whole intent,
// hashes it and writes it on the reservation's own journal line
// (paper-trader.js reserveIntent), so:
// - a receipt cannot exist without its reservation, nor outlive it: they are
//   one write, and the line's intent_sha256 covers the receipt;
// - a retry writes nothing new for an order already reserved (the book takes
//   one intent per intent_id), so the reservation keeps the receipt it has.
//
// How it rides. As one more item of evidence.metrics_evaluated: the key, "="
// and the record as canonical JSON (contract-gate.js canonicalJson). The
// published cr.trade-intent.v3 schema fixes `evidence` at three properties
// and is never edited; its metrics are a list of non-empty strings, and this
// is one. The engine keeps evidence for the record and reads none of it for a
// decision, so no protected file changes.
//
// What it does not repeat. The project, the ticket receipt and the decision
// are the intent's own fields; the grant, the reserved quantity, the order
// and the position are the reservation line's; the pools, their quotes, the
// quote asset's setting and stored value are the observation's, which is
// immutable and named here by ID and SHA-256.
//
// verify() is the independent check: from one reservation line it reads the
// receipt, compares it with what the book reserved, reads the named
// observation by its hash, makes the guard's reading again from that
// observation with the receipt's own inputs, and compares every figure. An
// order with no receipt (one reserved before this existed) is `missing`,
// said as such, never guessed at.

const G = require('./contract-gate');

// Plain decimal strings as integers at 18 places (the scale the trader's
// engine works at). This module is not one of the trader's callers
// (tests/trader-boundary.test.js), so it restates the two operations it
// needs instead of requiring the engine's.
const PLACES = 18n;
const SCALE = 10n ** PLACES;
const dec = (s) => {
  if (typeof s !== 'string' || !/^\d+(\.\d{1,18})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole) * SCALE + BigInt(frac.padEnd(18, '0'));
};
const mulFloor = (a, b) => (a * b) / SCALE;
const mulCeil = (a, b) => (a * b + SCALE - 1n) / SCALE;

const VERSION = 'cr.opening-guard.v1';
const CHECK_VERSION = 'cr-opening-guard-check@1';
const KEY = 'contract_gate.opening_guard';
const PREFIX = `${KEY}=`;

const DEC = /^\d+(\.\d{1,18})?$/;
const SIGNED = /^-?\d+(\.\d+)?$/;
const OBS_ID = /^co_[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => typeof v === 'string' && v !== '';

// The record as the item of evidence.metrics_evaluated that carries it.
function textOf(record) {
  return `${PREFIX}${G.canonicalJson(record)}`;
}

// Why a record is not a whole cr.opening-guard.v1, in words; [] when it is.
function problemsOf(rec) {
  const bad = [];
  const need = (ok, words) => { if (!ok) bad.push(words); };
  if (!isObj(rec)) return ['it is not an object'];
  need(rec.version === VERSION, `its version is not ${VERSION}`);
  need(G.MODES.includes(rec.gate_mode), 'its gate mode is not one the gate has');
  need(G.utcMs(rec.checked_at) !== null, 'its time is not a UTC instant');
  need(rec.result === 'pass' || rec.result === 'not_checked', 'its result is neither pass nor not_checked');
  const q = rec.quantity;
  need(isObj(q) && q.unit === 'token' && DEC.test(q.risk_sized) && DEC.test(q.final) && ['risk', 'quote'].includes(q.sized_by), 'its quantities are not the risk-sized and final token quantities');
  if (!isObj(q)) return bad;
  if (rec.result === 'not_checked') {
    need(['gate_not_enforced', 'no_contract_read'].includes(rec.why), 'it does not say why the guard did not run');
    need(rec.size === null && q.sized_by === 'risk', 'an order the guard did not check names a sizing quote');
    return bad;
  }
  if (rec.result !== 'pass') return bad;
  need(rec.gate_mode === 'enforce', 'a pass is recorded with the gate not enforced');
  need(rec.rule_id === 'CG-14', 'its rule is not CG-14');
  need(isObj(rec.gate) && text(rec.gate.version) && text(rec.gate.exit), 'it does not name the gate\'s and the valuation\'s versions');
  const o = rec.observation;
  need(isObj(o) && OBS_ID.test(o.observation_id) && HEX64.test(o.sha256) && text(o.chain_id) && Number.isSafeInteger(o.block_number) && text(o.block_hash) && G.utcMs(o.block_time) !== null, 'it does not name the observation by ID, SHA-256, chain and pinned block');
  need(Number.isInteger(q.decimals) && q.decimals >= 0 && /^[1-9]\d*$/.test(String(q.final_base_units)) && typeof q.final_base_units === 'string', 'its final quantity has no exact base units');
  const e = rec.exit;
  need(isObj(e) && text(e.pool) && SIGNED.test(e.cost_pct) && DEC.test(e.value_usd) && ['entry', 'observation', 'pool'].includes(e.value_basis) && DEC.test(e.notional_usd) && DEC.test(e.entry_usd), 'it does not name the pool that proved the exit with its unrounded cost and basis');
  if (isObj(e)) need((e.quote_basis === undefined && e.quote_usd === undefined) || (['stored', 'setting'].includes(e.quote_basis) && DEC.test(e.quote_usd)), 'its quote-asset value is not a stored or configured figure');
  const l = rec.limits;
  need(isObj(l) && typeof l.exit_cost_pct === 'number' && l.exit_cost_pct > 0 && DEC.test(l.network_fee_usd) && Number.isSafeInteger(l.price_stale_minutes) && l.price_stale_minutes > 0, 'it does not state the exit-cost limit, the network fee and the price freshness limit it was read under');
  const p = rec.price_check;
  need(isObj(p) && p.state === 'ok' && Number.isSafeInteger(p.limit_minutes) && Number.isSafeInteger(p.gap_ms) && p.gap_ms >= 0 && G.utcMs(p.as_of) !== null, 'it does not carry the stored price\'s passing freshness check');
  if (q.sized_by === 'quote') need(isObj(rec.size) && text(rec.size.pool) && text(rec.size.reference_usd) && ['recorded', 'rebuilt'].includes(rec.size.quote_input) && OBS_ID.test(rec.size.observation_id), 'it does not name the pool, reference rung and observation of the quote that set the size');
  else need(rec.size === null, 'an order kept at its risk-sized quantity names a sizing quote');
  return bad;
}

// The record for one order, from the guard's final reading (tickets.js
// contractOpenReading `guard`) and the adapter's sizing: the quantity the
// risk sized, the quantity the book is asked for, and the saved quote the
// order was sized down to, if it was. Throws, in words, when a whole record
// cannot be made: under enforce the adapter then does not ask the book.
function build(guard, { riskSized, final, snapped = null } = {}) {
  if (!isObj(guard)) throw new Error('the guard gave no reading to record');
  const { evaluated, ...reading } = guard;
  const quantity = { unit: 'token', risk_sized: riskSized, final, sized_by: snapped ? 'quote' : 'risk' };
  let rec;
  if (reading.result === 'pass') {
    if (!isObj(evaluated) || evaluated.quantity !== final) throw new Error(`the guard read ${evaluated && evaluated.quantity ? evaluated.quantity : 'no quantity'}, not the ${final} the order asks for`);
    const base = G.baseUnits(final, evaluated.token_decimals);
    if (base === null) throw new Error(`${final} is not a whole number of the token's base units`);
    rec = {
      ...reading,
      quantity: { ...quantity, decimals: evaluated.token_decimals, final_base_units: base.toString() },
      size: snapped ? { pool: snapped.pool, reference_usd: String(snapped.reference_usd), quote_input: snapped.quote_input, observation_id: snapped.observation_id === undefined ? null : snapped.observation_id } : null,
    };
  } else rec = { ...reading, quantity, size: null };
  const bad = problemsOf(rec);
  if (bad.length) throw new Error(bad.join('; '));
  return rec;
}

// The intent with its receipt: one more item after the ticket's own metrics.
function attach(intent, record) {
  return { ...intent, evidence: { ...intent.evidence, metrics_evaluated: [...intent.evidence.metrics_evaluated, textOf(record)] } };
}

// The receipt on an intent: null when it carries none (an order made before
// the receipt existed, or a close); { unreadable, words } when it carries
// more than one, or one that is not a whole record of this version in
// canonical form.
function readFrom(intent) {
  const list = intent && intent.evidence && Array.isArray(intent.evidence.metrics_evaluated) ? intent.evidence.metrics_evaluated : [];
  const found = list.filter((m) => typeof m === 'string' && m.startsWith(PREFIX));
  if (!found.length) return null;
  if (found.length > 1) return { unreadable: true, words: 'The intent carries more than one opening receipt.' };
  const body = found[0].slice(PREFIX.length);
  let rec = null;
  try { rec = JSON.parse(body); } catch (_) { rec = null; }
  if (!isObj(rec) || rec.version !== VERSION || G.canonicalJson(rec) !== body) return { unreadable: true, words: `The opening receipt on the intent does not read as ${VERSION} in canonical form.` };
  const bad = problemsOf(rec);
  if (bad.length) return { unreadable: true, words: `The opening receipt on the intent is not a whole ${VERSION}: ${bad.join('; ')}.` };
  return rec;
}

const same = (a, b) => { const x = dec(a); const y = dec(b); return x !== null && y !== null && x === y; };

// One reservation line of the book's journal (type `reserved`), checked
// against its own receipt. `readObservation(project_id, observation_id)`,
// `ticketReceipt(project_id, receipt_id)` and `decisionOf(project_id,
// decision_id)` are the caller's reads of the immutable records
// (contract-forensics.js readObservation, which checks the observation's
// SHA-256; the ticket receipt; the decision's own line, which says whether
// Eric or the paper mandate granted it). Reads only.
//
// status:
//   bound         the receipt, the reservation and the guard's reading made
//                 again from the named observation agree in every figure
//   not_checked   the receipt says the guard did not run (the gate was not
//                 enforced, or the project has no contract the desk reads)
//   missing       the order carries no receipt (reserved before it existed)
//   unreadable    the intent's receipt is malformed, or there are two
//   mismatch      something differs; each difference is named
//   unverifiable  the named observation is not on file, or the receipt was
//                 made under another version of the rule
//   not_an_opening  a close: the guard runs on openings only
function verify(line, { readObservation, ticketReceipt, decisionOf } = {}) {
  const it = isObj(line && line.intent) ? line.intent : {};
  const reservation = {
    project_id: it.project_id || null, receipt_id: it.receipt_id || null, decision_id: it.decision_id || null,
    intent_id: (line && line.intent_id) || null, intent_sha256: (line && line.intent_sha256) || null,
    client_order_id: (line && line.client_order_id) || null, position_id: (line && line.position_id) || null,
    reserved_at: (line && line.at) || null, quantity: (line && line.quantity) || null, entry_price: it.entry_price || null,
    // The grant: the decision the intent names, as the project's own record holds it.
    grant: null,
  };
  const decision = typeof decisionOf === 'function' && reservation.project_id && reservation.decision_id ? decisionOf(reservation.project_id, reservation.decision_id) || null : undefined;
  if (decision) reservation.grant = { decision_id: decision.decision_id, action: decision.action || null, decided_at: decision.decided_at || null, decided_by: decision.decided_by || null, by_mandate: typeof decision.decided_by === 'string' && decision.decided_by.startsWith('mandate:') };
  const out = (status, words, more = {}) => ({ version: CHECK_VERSION, status, words, differences: [], reservation, record: null, ...more });
  if (it.side !== 'OPEN_LONG') return out('not_an_opening', 'A close carries no opening receipt: the guard runs on openings only.');
  const rec = readFrom(it);
  if (rec === null) return out('missing', `This order carries no opening receipt: it was reserved before ${VERSION} existed, or by code that does not write one. Nothing is inferred for it.`);
  if (rec.unreadable) return out('unreadable', rec.words);
  const diff = [];
  const differ = (field, recorded, found, words) => diff.push({ field, receipt: recorded === undefined ? null : recorded, found: found === undefined ? null : found, words });
  const done = (status, words, more = {}) => ({ ...out(status, words, more), differences: diff, record: rec });

  // The grant the order names: on the project's record, for this ticket, and the one the book read.
  if (decision === null) differ('grant', reservation.decision_id, null, 'The decision this order names is not on the record of its project.');
  else if (decision && decision.receipt_id !== reservation.receipt_id) differ('grant', reservation.receipt_id, decision.receipt_id, 'The decision this order names is on another ticket than the one the order acts on.');
  if (isObj(line.grant) && line.grant.decision_id !== reservation.decision_id) differ('grant', reservation.decision_id, line.grant.decision_id, 'The grant the book read is not the decision the order names.');
  // The receipt against its own reservation.
  if (rec.quantity.final !== reservation.quantity) differ('quantity.final', rec.quantity.final, reservation.quantity, `The receipt is for ${rec.quantity.final}; the book reserved ${reservation.quantity}.`);
  if (rec.checked_at !== it.created_at) differ('checked_at', rec.checked_at, it.created_at, 'The receipt was not made in the step that wrote the intent.');
  if (dec(rec.quantity.final) !== null && dec(rec.quantity.risk_sized) !== null && dec(rec.quantity.final) > dec(rec.quantity.risk_sized)) differ('quantity.risk_sized', rec.quantity.risk_sized, rec.quantity.final, 'The final quantity is above the quantity the risk sized.');
  if (rec.quantity.sized_by === 'risk' && rec.quantity.final !== rec.quantity.risk_sized) differ('quantity.sized_by', 'risk', null, 'The receipt says the order kept its risk-sized quantity, and its two quantities differ.');
  if (rec.result === 'not_checked') {
    if (diff.length) return done('mismatch', diff.map((d) => d.words).join(' '));
    return done('not_checked', rec.why === 'gate_not_enforced' ? 'The contract gate was not enforced when this order was asked for (observe mode): the guard did not run, and the receipt says so.' : 'The project has no contract the desk reads, so the guard had nothing to check, and the receipt says so.');
  }
  if (!same(rec.exit.entry_usd, it.entry_price)) differ('exit.entry_usd', rec.exit.entry_usd, it.entry_price, `The guard valued the sale at an entry of ${rec.exit.entry_usd}; the order's limit is ${it.entry_price}.`);
  const q = dec(rec.quantity.final);
  const entry = dec(rec.exit.entry_usd);
  const notional = dec(rec.exit.notional_usd);
  if (q !== null && entry !== null && (notional === null || notional < mulFloor(q, entry) || notional > mulCeil(q, entry))) differ('exit.notional_usd', rec.exit.notional_usd, null, 'The notional the guard read is not the final quantity at the entry price.');
  const base = G.baseUnits(rec.quantity.final, rec.quantity.decimals);
  if (base === null || base.toString() !== rec.quantity.final_base_units) differ('quantity.final_base_units', rec.quantity.final_base_units, base === null ? null : base.toString(), 'The base units on the receipt are not the final quantity at the token\'s decimals.');

  // The limit it was read under, against the ticket's own frozen sizing.
  const tr = typeof ticketReceipt === 'function' ? ticketReceipt(reservation.project_id, reservation.receipt_id) : null;
  const frozen = tr && tr.desk && tr.desk.sizing ? tr.desk.sizing.max_exit_cost_pct : undefined;
  if (frozen === undefined) differ('limits.exit_cost_pct', rec.limits.exit_cost_pct, null, 'The ticket receipt this order acts on, or its frozen exit-cost limit, does not read.');
  else if (frozen !== rec.limits.exit_cost_pct) differ('limits.exit_cost_pct', rec.limits.exit_cost_pct, frozen, `The receipt was read under a ${rec.limits.exit_cost_pct}% limit; the ticket's frozen limit is ${frozen}%.`);

  // The observation the guard evaluated, by its ID and SHA-256.
  const back = typeof readObservation === 'function' ? readObservation(reservation.project_id, rec.observation.observation_id) : { ok: false, words: 'No observation reader was given.' };
  if (!back || !back.ok) {
    const words = String((back && back.words) || 'does not read');
    if (/does not match its SHA-256/.test(words)) { differ('observation.sha256', rec.observation.sha256, null, `The observation the receipt names ${words.replace(/^Observation \S+ /, '')}`); return done('mismatch', diff.map((d) => d.words).join(' ')); }
    return done('unverifiable', `The observation the receipt names (${rec.observation.observation_id}) is not readable now: ${words} Nothing is recomputed without it.${diff.length ? ` Also: ${diff.map((d) => d.words).join(' ')}` : ''}`);
  }
  const o = back.observation;
  if (o.sha256 !== rec.observation.sha256) differ('observation.sha256', rec.observation.sha256, o.sha256, 'The observation on file under that ID has another SHA-256 than the receipt names.');
  const subj = isObj(o.subject) ? o.subject : {};
  const blk = isObj(o.block) ? o.block : {};
  if (subj.project_id !== reservation.project_id) differ('observation.project', reservation.project_id, subj.project_id, 'The named observation is another project\'s.');
  if (String(subj.chain_id) !== rec.observation.chain_id) differ('observation.chain_id', rec.observation.chain_id, subj.chain_id, 'The named observation is on another chain than the receipt says.');
  if (blk.number !== rec.observation.block_number || blk.hash !== rec.observation.block_hash || blk.timestamp !== rec.observation.block_time) differ('observation.block', `${rec.observation.block_number} ${rec.observation.block_hash}`, `${blk.number} ${blk.hash}`, 'The named observation is pinned to another block than the receipt says.');
  if (!o.token || o.token.decimals !== rec.quantity.decimals) differ('quantity.decimals', rec.quantity.decimals, o.token ? o.token.decimals : null, 'The token\'s decimals on the receipt are not the observation\'s.');

  // The rule it was read under. Another version is not recomputed as if it were this one.
  if (rec.gate.exit !== G.EXIT_VERSION || rec.gate.version !== G.GATE_VERSION) {
    return done(diff.length ? 'mismatch' : 'unverifiable', `${diff.map((d) => d.words).join(' ')}${diff.length ? ' ' : ''}The receipt was made under ${rec.gate.version} and ${rec.gate.exit}; this code reads ${G.GATE_VERSION} and ${G.EXIT_VERSION}, so its reading is not made again here.`);
  }

  // The guard's reading, made again from that observation with the receipt's own inputs.
  const fx = G.fittedExit(o, { notionalUsd: rec.exit.notional_usd, priceUsd: rec.exit.entry_usd, quantity: rec.quantity.final, networkFeeUsd: rec.limits.network_fee_usd, limitPct: rec.limits.exit_cost_pct, priceStaleMinutes: rec.limits.price_stale_minutes });
  const pc = fx.price_check || {};
  const recomputed = { ok: fx.ok, pool: fx.pool || null, cost_pct: fx.cost_pct === undefined ? null : fx.cost_pct, value_usd: fx.value_usd || null, value_basis: fx.value_basis || null, quote_usd: fx.quote_usd || null, quote_basis: fx.quote_basis || null, price_check: { state: pc.state || null, limit_minutes: pc.limit_minutes === undefined ? null : pc.limit_minutes, gap_ms: pc.gap_ms === undefined ? null : pc.gap_ms, as_of: pc.as_of || null }, words: fx.words || null };
  if (fx.ok !== true) differ('result', 'pass', 'hold', `Made again from the named observation, the guard does not pass: ${fx.words}`);
  if (recomputed.pool !== rec.exit.pool) differ('exit.pool', rec.exit.pool, recomputed.pool, `The receipt names ${rec.exit.pool} as the pool that proved the exit; made again, it is ${recomputed.pool || 'none'}.`);
  if (recomputed.cost_pct !== rec.exit.cost_pct) differ('exit.cost_pct', rec.exit.cost_pct, recomputed.cost_pct, `The receipt records an exit cost of ${rec.exit.cost_pct}%; made again, it is ${recomputed.cost_pct === null ? 'not measured' : `${recomputed.cost_pct}%`}.`);
  if (recomputed.value_basis !== rec.exit.value_basis || recomputed.value_usd !== rec.exit.value_usd) differ('exit.value', `${rec.exit.value_basis} ${rec.exit.value_usd}`, `${recomputed.value_basis} ${recomputed.value_usd}`, 'The value the sale was measured against is not the one the receipt records.');
  if ((rec.exit.quote_basis || null) !== recomputed.quote_basis || (rec.exit.quote_usd || null) !== recomputed.quote_usd) differ('exit.quote', `${rec.exit.quote_basis || null} ${rec.exit.quote_usd || null}`, `${recomputed.quote_basis} ${recomputed.quote_usd}`, 'The quote asset\'s dollar value is not the one the receipt records.');
  for (const k of ['state', 'limit_minutes', 'gap_ms', 'as_of']) if (recomputed.price_check[k] !== rec.price_check[k]) differ(`price_check.${k}`, rec.price_check[k], recomputed.price_check[k], `The stored price's freshness check (${k}) is not the one the receipt records.`);

  // The saved quote the order was sized down to: in the observation the sizing read, in the pool and at the rung named, for exactly the final quantity.
  if (rec.quantity.sized_by === 'quote') {
    const sized = rec.size.observation_id === rec.observation.observation_id ? back : typeof readObservation === 'function' ? readObservation(reservation.project_id, rec.size.observation_id) : null;
    if (!sized || !sized.ok) differ('size.observation_id', rec.size.observation_id, null, `The observation the sizing quote came from (${rec.size.observation_id}) is not readable now.`);
    else {
      const quote = G.quotedQuantities(sized.observation).find((x) => x.pool === rec.size.pool && x.label === rec.size.reference_usd);
      if (!quote) differ('size', `${rec.size.pool} $${rec.size.reference_usd}`, null, 'The pool named as the source of the size has no saved quote at that reference rung.');
      else {
        if (quote.base.toString() !== rec.quantity.final_base_units) differ('size.quantity', rec.quantity.final_base_units, quote.base.toString(), `The $${rec.size.reference_usd} quote of the pool named as the source of the size was asked for ${G.tokensText(quote.base, sized.observation.token.decimals)}, not the final quantity.`);
        if ((quote.recorded ? 'recorded' : 'rebuilt') !== rec.size.quote_input) differ('size.quote_input', rec.size.quote_input, quote.recorded ? 'recorded' : 'rebuilt', 'The sizing quote\'s input is not recorded as the receipt says.');
      }
    }
  }
  if (diff.length) return done('mismatch', diff.map((d) => d.words).join(' '), { recomputed });
  return done('bound', `The receipt is bound to this reservation: ${rec.quantity.final} tokens${rec.quantity.sized_by === 'quote' ? `, sized down from ${rec.quantity.risk_sized} to the $${rec.size.reference_usd} quote of ${rec.size.pool}` : ', the risk-sized quantity'}; the exit proven in ${rec.exit.pool} at ${rec.exit.cost_pct}% within ${rec.limits.exit_cost_pct}%, on observation ${rec.observation.observation_id} at block ${rec.observation.block_number}; made again from that observation, every figure agrees.`, { recomputed });
}

// What a list row shows of a check (the trader view's order rows): the
// verdict, its words, and the receipt's own headline figures.
function summaryOf(check) {
  const r = check.record;
  return {
    version: check.version, status: check.status, words: check.words, differences: check.differences.map((d) => d.field),
    decision_id: check.reservation.decision_id, granted_by: check.reservation.grant ? (check.reservation.grant.by_mandate ? 'mandate' : 'owner') : null, intent_id: check.reservation.intent_id, intent_sha256: check.reservation.intent_sha256, reserved_quantity: check.reservation.quantity,
    ...(r ? { result: r.result, gate_mode: r.gate_mode, quantity: r.quantity, size: r.size || null, ...(r.result === 'pass' ? { observation_id: r.observation.observation_id, observation_sha256: r.observation.sha256, chain_id: r.observation.chain_id, block_number: r.observation.block_number, exit_pool: r.exit.pool, cost_pct: r.exit.cost_pct, limit_pct: r.limits.exit_cost_pct, valuation: r.gate.exit } : { why: r.why }) } : {}),
  };
}

module.exports = { VERSION, CHECK_VERSION, KEY, textOf, problemsOf, build, attach, readFrom, verify, summaryOf };
