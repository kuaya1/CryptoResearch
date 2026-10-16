'use strict';
// Forensics & Resilience: the pure rules (no files, no network, no clock
// unless given). forensics.js reads the records and calls these; the tests
// call them directly.
//
//   evaluateEvent      an event's state from dated readings: unknown, not
//                      established, within, watch, occurred, recovered; its
//                      episodes and monitoring gaps
//   resolveAt          what happened by a checkpoint: occurred, not occurred,
//                      unresolved (a gap or no readings), or pending
//   exitEstimate       a hypothetical exit at one size, by the pool's own
//                      mechanism (executable quote, exact constant product)
//   scenarioEstimates  conditional threshold estimates: deterioration,
//                      stabilization, recovery, or "Insufficient history"
//   normalizeAssessment / normalizeChallenge   the JSON blocks, cleaned
//   findingChecks      the desk's checks on findings (flags, never edits)
//   timeline           the checkpoints from a frozen origin
//
// Unknown is never zero, never healthy and never failed: a reading that says
// nothing (a provider error, a guard refusal) is no reading, and a gap longer
// than an event's freshness window makes its state unknown.

const D = require('./forensic-defs');

const HOUR = 3600000;
const DAY = 24 * HOUR;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => {
  if (isNum(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const tOf = (iso) => (typeof iso === 'string' ? Date.parse(iso) : NaN);
const iso = (ms) => new Date(ms).toISOString();
const round = (x, d = 2) => (isNum(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const hoursText = (h) => (h >= 48 ? `${Math.round(h / 24)} days` : `${Math.round(h)} hours`);

// Text from a model or a page is data: control characters out, whitespace
// collapsed, length capped.
function str(v, max = 600) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ').replace(/[ \t]+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
const oneOf = (v, list) => (typeof v === 'string' && list.includes(v.trim().toLowerCase()) ? v.trim().toLowerCase() : null);
const isoOrNull = (v) => {
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = Date.parse(v.trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const ids = (v, max = 30) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,40}$/.test(x.trim())).map((x) => x.trim()))].slice(0, max) : []);
const safeUrl = (v) => {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString().slice(0, 2000) : null;
  } catch (_) {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Checkpoints

function deadlinesFrom(origin) {
  const o = tOf(origin);
  if (!Number.isFinite(o)) return [];
  return D.CHECKPOINTS.map((c) => ({ id: c.id, label: c.label, hours: c.hours, at: iso(o + c.hours * HOUR) }));
}

// ---------------------------------------------------------------------------
// Event states

// How each outcome's states read (display words; the definitions decide).
const PHRASE = {
  liquidity_impairment: { beyond: 'Over your exit-cost limit', back: 'Back within your exit-cost limit', within: 'Within your exit-cost limit' },
  operational_degradation: { beyond: 'Failing', back: 'Passing again', within: 'Passing' },
  delivery_inactivity: { beyond: 'Past your delivery window with no new delivery', back: 'A new delivery', within: 'Within your delivery window' },
};
const phraseOf = (id) => PHRASE[id] || { beyond: 'Beyond the limit', back: 'Back within the limit', within: 'Within the limit' };

// readings: [{ at, beyond: true | false | null, ... }]. beyond null is a
// reading that says nothing (an error, a refused check): it is kept for the
// record and counts as no reading.
function evaluateEvent(def, readings, { now = Date.now() } = {}) {
  const fresh = def.freshness_hours ? def.freshness_hours * HOUR : Infinity;
  const persist = def.persistence || { hours: 0, min_readings: 1 };
  const recover = def.recovery || { hours: 0, min_readings: 1 };
  const list = (Array.isArray(readings) ? readings : [])
    .map((r) => ({ ...r, t: tOf(r && r.at) }))
    .filter((r) => Number.isFinite(r.t) && r.t <= now)
    .sort((a, b) => a.t - b.t);
  const known = list.filter((r) => r.beyond === true || r.beyond === false);
  const needsPass = def.id === 'operational_degradation';
  const out = { event: def.id, version: def.version, readings: list.length, known: known.length, unknown_readings: list.length - known.length, episodes: [], gaps: [], established: !needsPass, established_at: null, first_at: known.length ? known[0].at : null, latest_at: null, latest_beyond: null };
  let run = null;
  let episode = null;
  let prev = null;
  for (const r of known) {
    if (prev && r.t - prev.t > fresh) {
      out.gaps.push({ from: prev.at, to: r.at, hours: round((r.t - prev.t) / HOUR, 1) });
      // A gap ends what was known: an open episode closes as interrupted,
      // never as continued failure, and a new run starts after it.
      if (episode) {
        out.episodes.push({ ...episode, end_at: prev.at, end_reason: 'monitoring_gap' });
        episode = null;
      }
      run = null;
    }
    prev = r;
    if (!out.established) {
      if (r.beyond !== false) continue; // failures before a first pass establish nothing
      out.established = true;
      out.established_at = r.at;
    }
    const kind = r.beyond ? 'beyond' : 'within';
    if (!run || run.kind !== kind) run = { kind, start_t: r.t, start_at: r.at, n: 0 };
    run.n += 1;
    const span = r.t - run.start_t;
    if (kind === 'beyond') {
      if (episode) episode.readings += 1;
      else if (span >= persist.hours * HOUR && run.n >= persist.min_readings) {
        episode = { start_at: run.start_at, confirmed_at: r.at, readings: run.n, end_at: null, recovered_at: null, end_reason: null };
      }
    } else if (episode && span >= recover.hours * HOUR && run.n >= recover.min_readings) {
      out.episodes.push({ ...episode, end_at: run.start_at, recovered_at: r.at, end_reason: 'recovered' });
      episode = null;
    }
  }
  if (episode) out.episodes.push({ ...episode });
  const latest = known[known.length - 1] || null;
  out.latest_at = latest ? latest.at : null;
  out.latest_beyond = latest ? latest.beyond : null;
  out.latest_age_hours = latest ? round((now - latest.t) / HOUR, 1) : null;
  const open = episode;
  const P = phraseOf(def.id);
  let state;
  let why;
  if (!latest) {
    state = 'unknown';
    why = list.length ? 'Readings on record say nothing (errors or refused checks): the state is unknown.' : 'No reading on record: the state is unknown.';
  } else if (!out.established) {
    state = 'not_established';
    why = 'This check was never observed passing, so a failure establishes nothing (a wrong address, or a product not set up yet).';
  } else if (now - latest.t > fresh) {
    state = 'unknown';
    why = `The latest reading is ${hoursText((now - latest.t) / HOUR)} old, past the ${hoursText(fresh / HOUR)} freshness window: the state is unknown, not continued ${latest.beyond ? 'failure' : 'health'}.`;
    out.last_known = open ? 'occurred' : latest.beyond ? 'watch' : 'within';
  } else if (open) {
    state = 'occurred';
    why = `${P.beyond} in every reading since ${open.start_at}${open.confirmed_at !== open.start_at ? ` (confirmed ${open.confirmed_at})` : ''}.`;
    out.since = open.confirmed_at;
  } else if (run && run.kind === 'beyond') {
    state = 'watch';
    why = `${P.beyond} since ${run.start_at}; not yet for the persistence window (${hoursText(persist.hours)}, ${persist.min_readings} readings).`;
    out.since = run.start_at;
  } else if (out.episodes.length && out.episodes[out.episodes.length - 1].end_reason === 'recovered') {
    state = 'recovered';
    const e = out.episodes[out.episodes.length - 1];
    why = `${P.back} since ${e.end_at}${e.recovered_at !== e.end_at ? ` (recovery confirmed ${e.recovered_at})` : ''}, after an episode from ${e.start_at}.`;
    out.since = e.end_at;
  } else {
    state = 'within';
    why = `${P.within} in the latest readings.`;
  }
  out.state = state;
  out.why = why;
  return out;
}

// What happened by a checkpoint, from the readings up to it. Not due until
// the checkpoint plus a grace period for late readings.
function resolveAt(def, readings, { origin, deadline, now = Date.now(), graceHours = null, windowDays = null } = {}) {
  const O = tOf(origin);
  const T = tOf(deadline);
  const fresh = def.freshness_hours ? def.freshness_hours * HOUR : null;
  const grace = (graceHours !== null ? graceHours : Math.max(24, def.freshness_hours || 24)) * HOUR;
  const base = { event: def.id, version: def.version, deadline, origin };
  if (!Number.isFinite(O) || !Number.isFinite(T)) return { ...base, outcome: 'unresolved', reason: 'The receipt has no readable origin.' };
  if (now < T) return { ...base, outcome: 'pending', reason: 'Not due yet.' };
  if (now < T + grace) return { ...base, outcome: 'pending', reason: `Due; waiting ${hoursText(grace / HOUR)} after the checkpoint for late readings.` };
  const upto = (Array.isArray(readings) ? readings : []).filter((r) => tOf(r && r.at) <= T);
  const ev = evaluateEvent(def, upto, { now: T });
  const hit = ev.episodes.find((e) => tOf(e.confirmed_at) <= T && (!e.end_at || tOf(e.end_at) >= O));
  if (hit) return { ...base, outcome: 'occurred', at: hit.confirmed_at, already_active_at_origin: tOf(hit.confirmed_at) <= O, readings: ev.known };
  if (!fresh) return { ...base, outcome: 'unresolved', reason: 'This event has no monitoring window.' };
  const known = upto.filter((r) => (r.beyond === true || r.beyond === false) && tOf(r.at) >= O - fresh).sort((a, b) => tOf(a.at) - tOf(b.at));
  if (!known.length) return { ...base, outcome: 'unresolved', reason: 'No reading between the origin and the checkpoint: missing follow-up is unresolved, not a success.' };
  if (!ev.established) return { ...base, outcome: 'unresolved', reason: 'The check was never observed passing, so nothing is established.' };
  if (tOf(known[0].at) > O + fresh) return { ...base, outcome: 'unresolved', reason: `Readings start ${hoursText((tOf(known[0].at) - O) / HOUR)} after the origin.` };
  if (tOf(known[known.length - 1].at) < T - fresh) return { ...base, outcome: 'unresolved', reason: `No reading in the ${hoursText(fresh / HOUR)} before the checkpoint.` };
  for (let i = 1; i < known.length; i++) {
    const gap = tOf(known[i].at) - tOf(known[i - 1].at);
    if (gap > fresh && tOf(known[i].at) >= O) return { ...base, outcome: 'unresolved', reason: `A monitoring gap of ${hoursText(gap / HOUR)} (${known[i - 1].at} to ${known[i].at}).` };
  }
  // A delivery window that passes between the last reading and the
  // checkpoint cannot be called either way: a delivery in between was not seen.
  const lastKnown = known[known.length - 1];
  if (windowDays && lastKnown.latest_delivery_at && T - tOf(lastKnown.latest_delivery_at) > windowDays * DAY) {
    return { ...base, outcome: 'unresolved', reason: 'The delivery window passes between the last reading and the checkpoint; a delivery in between would not have been seen.' };
  }
  return { ...base, outcome: 'not_occurred', readings: known.length, first_at: known[0].at, last_at: lastKnown.at };
}

// Confirmed discontinuation from attributable evidence in saved assessments.
// entries: [{ at, kind: shutdown | support_withdrawn | reversal, primary, receipt_id, finding_id }]
function discontinuationState(entries, { at = null } = {}) {
  const cut = at ? tOf(at) : Infinity;
  const all = (Array.isArray(entries) ? entries : []).filter((e) => e && D.DISCONTINUATION.includes(e.kind) && tOf(e.at) <= cut).sort((a, b) => tOf(a.at) - tOf(b.at));
  const attributable = all.filter((e) => e.primary);
  const unattributed = all.length - attributable.length;
  const latest = attributable[attributable.length - 1] || null;
  if (!latest) {
    return { event: 'confirmed_discontinuation', version: D.EVENTS_VERSION, state: 'not_established', why: `No attributable shutdown or withdrawal evidence on record.${unattributed ? ` ${unattributed} mention${unattributed === 1 ? '' : 's'} without a primary source ${unattributed === 1 ? 'does' : 'do'} not count.` : ''} Absence of such evidence is not called health.`, unattributed };
  }
  if (latest.kind === 'reversal') {
    return { event: 'confirmed_discontinuation', version: D.EVENTS_VERSION, state: 'reversed', since: latest.at, why: `An attributable reversal (${latest.finding_id || 'finding'}) answers the earlier shutdown evidence.`, evidence: latest, unattributed };
  }
  return { event: 'confirmed_discontinuation', version: D.EVENTS_VERSION, state: 'occurred', since: latest.at, why: `Attributable ${latest.kind === 'shutdown' ? 'shutdown' : 'withdrawal of support'} evidence (${latest.finding_id || 'finding'}, receipt ${latest.receipt_id || '?'}).`, evidence: latest, unattributed };
}

function resolveDiscontinuationAt(entries, { origin, deadline, now = Date.now() } = {}) {
  const T = tOf(deadline);
  const base = { event: 'confirmed_discontinuation', version: D.EVENTS_VERSION, deadline, origin };
  if (!Number.isFinite(T)) return { ...base, outcome: 'unresolved', reason: 'The receipt has no readable origin.' };
  if (now < T) return { ...base, outcome: 'pending', reason: 'Not due yet.' };
  const s = discontinuationState(entries, { at: deadline });
  if (s.state === 'occurred') return { ...base, outcome: 'occurred', at: s.since };
  return { ...base, outcome: 'not_established', reason: 'No attributable shutdown evidence by the checkpoint. That is not a finding of health.' };
}

// The overall state of several checks of one event: the most concerning
// known state, with how many checks are unknown.
const STATE_ORDER = ['occurred', 'watch', 'recovered', 'within', 'not_established', 'unknown'];
function combineStates(list) {
  const items = (Array.isArray(list) ? list : []).filter(Boolean);
  if (!items.length) return { state: 'unknown', why: 'Nothing is monitored or captured for this outcome.', checks: 0, unknown: 0 };
  const known = items.filter((x) => x.state !== 'unknown');
  const unknown = items.length - known.length;
  const worst = known.sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state))[0];
  if (!worst) return { state: 'unknown', why: items.length === 1 ? items[0].why : `All ${items.length} checks are unknown.`, checks: items.length, unknown };
  return { state: worst.state, why: `${worst.why}${unknown ? ` ${unknown} of ${items.length} checks unknown.` : ''}`, checks: items.length, unknown, since: worst.since || null };
}

// ---------------------------------------------------------------------------
// Liquidity: exit estimates by mechanism (cr-forensic-liquidity@1)

// One reading's hypothetical exit at one size, or null when the reading does
// not speak to that size. Never a transaction.
function exitEstimate(obs, sizeUsd, { marketPriceUsd = null } = {}) {
  if (!obs || !isNum(sizeUsd) || sizeUsd <= 0) return null;
  const base = { obs_id: obs.obs_id || null, size_usd: sizeUsd, venue: obs.venue || null, chain: obs.chain || null, retrieved_at: obs.retrieved_at || null, source_id: obs.source_id || null, captured_by: obs.source === 'monitor' ? 'monitor' : 'audit', version: D.LIQUIDITY_VERSION };
  if (obs.kind === 'executable_quote') {
    const q = obs.quote || {};
    const sell = num(q.sell_usd);
    const scope = obs.route_scope === 'aggregator' ? 'aggregator' : 'single_venue';
    if (sell === null || sell <= 0 || Math.abs(sell - sizeUsd) / sizeUsd > D.LIQUIDITY.quote_size_tolerance) return null;
    if (q.no_route === true) {
      return { ...base, method: 'executable_quote', route_scope: scope, status: 'no_route', quoted_usd: sell, received_usd: null, cost_pct: null, limitations: [scope === 'aggregator' ? 'The quote source found no route at this size.' : 'This venue found no route at this size; other venues were not asked.'] };
    }
    const recv = num(q.received_usd);
    if (recv === null || recv < 0) return null;
    const gas = num(q.gas_usd);
    const extra = gas !== null && gas > 0 && q.gas_included !== true ? gas : 0;
    const cost = ((sell - recv + extra) / sell) * 100;
    const limitations = ['A quote at one moment; it can change by the time an order is sent.'];
    if (scope !== 'aggregator') limitations.push('One venue: other routes were not asked, so the cost through the best route may be lower.');
    if (gas === null) limitations.push('Network fee not stated.');
    if (typeof q.valuation_note === 'string') limitations.push(str(q.valuation_note, 300));
    return { ...base, method: 'executable_quote', route_scope: scope, status: 'estimated', quoted_usd: round(sell), received_usd: round(recv, 4), cost_pct: round(Math.max(-100, cost), 3), fees_usd: num(q.fees_usd), price_impact_pct: num(q.price_impact_pct), gas_usd: gas, route: str(q.route, 300), limitations };
  }
  if (obs.kind === 'pool_reserves') {
    const mech = D.LIQUIDITY.mechanisms[obs.mechanism] ? obs.mechanism : 'unknown';
    if (mech !== 'constant_product') return { ...base, method: 'not_estimated', mechanism: mech, status: 'not_estimated', reason: D.LIQUIDITY.mechanisms[mech] };
    const Rb = num(obs.base_reserve);
    const Rq = num(obs.quote_reserve);
    const qUsd = num(obs.quote_usd_price);
    const feeBps = num(obs.fee_bps);
    if (!(Rb > 0 && Rq > 0 && qUsd > 0) || feeBps === null || feeBps < 0 || feeBps >= 10000) {
      return { ...base, method: 'not_estimated', mechanism: mech, status: 'not_estimated', reason: 'A constant-product exit needs both reserves in token units, the quote token\'s USD price and the pool fee; a USD liquidity figure is never split in half to guess them.' };
    }
    const mid = (Rq * qUsd) / Rb; // USD per project token, the pool's own price
    const baseIn = sizeUsd / mid;
    const f = feeBps / 10000;
    const inEff = baseIn * (1 - f);
    const out = (inEff * Rq) / (Rb + inEff);
    const recv = out * qUsd;
    const cost = (1 - recv / sizeUsd) * 100;
    const impact = (inEff / (Rb + inEff)) * 100;
    const limitations = ['One pool at one moment: other routes were not considered, so the cost through the best route may be lower.', 'Valued at the pool\'s own price.'];
    if (isNum(marketPriceUsd) && marketPriceUsd > 0) {
      const dev = (mid / marketPriceUsd - 1) * 100;
      if (Math.abs(dev) > 10) limitations.push(`The pool's price differs from the market price by ${round(dev, 1)}%: the pool may be stale or thin.`);
    }
    return { ...base, method: 'constant_product', mechanism: mech, route_scope: 'single_pool', status: 'estimated', received_usd: round(recv, 4), cost_pct: round(cost, 3), fee_pct: round(feeBps / 100, 3), price_impact_pct: round(impact, 3), pool_price_usd: mid, limitations };
  }
  return null;
}

// The exit estimates of a set of readings at each size: every supported
// estimate, and the current one per size. Current is the latest hour with a
// reading at that size (an estimate or "no route"); within it, the cheapest
// route. An older, cheaper reading is history, never the current best.
function exitTable(observations, sizes, opts = {}) {
  const obs = Array.isArray(observations) ? observations : [];
  const hour = (r) => (isoOrNull(r.retrieved_at) || '').slice(0, 13);
  return sizes.map((size) => {
    const rows = obs.map((o) => exitEstimate(o, size, opts)).filter(Boolean);
    const speaking = rows.filter((r) => r.status === 'estimated' || r.status === 'no_route');
    const latest = speaking.map(hour).sort().pop();
    const current = latest === undefined ? [] : speaking.filter((r) => hour(r) === latest);
    const estimated = current.filter((r) => r.status === 'estimated').sort((a, b) => a.cost_pct - b.cost_pct);
    const noRoute = current.filter((r) => r.status === 'no_route');
    return {
      size_usd: size,
      estimates: rows,
      best: estimated[0] || null,
      as_of: current.length ? current.map((r) => r.retrieved_at).filter(Boolean).sort()[0] || null : null,
      earlier: speaking.length - current.length,
      status: estimated.length ? 'estimated' : noRoute.length ? 'no_route' : 'no_supported_estimate',
      note: estimated.length ? null : noRoute.length ? 'No route found at this size by the quote source asked.' : 'No supported estimate at this size: no executable quote at it and no constant-product reserves.',
    };
  });
}

// Readings for liquidity impairment at your position size and limit. A
// reading over the limit counts only when the quote considered routes (an
// aggregator): one pool or one venue over the limit says nothing about the
// best route. A reading within the limit through any one route counts.
function liquidityReadings(observations, { positionUsd, limitPct, marketPriceUsd = null }) {
  const byTime = new Map();
  for (const o of Array.isArray(observations) ? observations : []) {
    const at = isoOrNull(o && o.retrieved_at);
    if (!at) continue;
    const e = exitEstimate(o, positionUsd, { marketPriceUsd });
    if (!e) continue;
    const key = at.slice(0, 13);
    const list = byTime.get(key) || [];
    list.push({ ...e, at });
    byTime.set(key, list);
  }
  const out = [];
  for (const list of byTime.values()) {
    const at = list.map((x) => x.at).sort()[0];
    const within = list.filter((x) => x.status === 'estimated' && x.cost_pct <= limitPct);
    const aggOver = list.filter((x) => x.route_scope === 'aggregator' && (x.status === 'no_route' || (x.status === 'estimated' && x.cost_pct > limitPct)));
    const best = list.filter((x) => x.status === 'estimated').sort((a, b) => a.cost_pct - b.cost_pct)[0] || null;
    let beyond = null;
    let note = null;
    if (within.length) beyond = false;
    else if (aggOver.length) beyond = true;
    else if (list.some((x) => x.status === 'estimated' || x.status === 'no_route')) note = 'Over your limit through one pool or venue only; other routes were not read, so this reading is not counted.';
    else note = 'No supported estimate at your position size.';
    out.push({ at, beyond, cost_pct: best ? best.cost_pct : null, method: best ? best.method : null, obs_ids: list.map((x) => x.obs_id).filter(Boolean), note });
  }
  return out.sort((a, b) => tOf(a.at) - tOf(b.at));
}

// ---------------------------------------------------------------------------
// Series and scenarios (cr-forensic-scenarios@1)

function median(values) {
  const v = values.filter(isNum).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Hourly or irregular readings as one median per UTC day.
function dailySeries(points) {
  const days = new Map();
  for (const p of Array.isArray(points) ? points : []) {
    const t = tOf(p && p.at);
    const v = num(p && p.value);
    if (!Number.isFinite(t) || v === null) continue;
    const day = iso(t).slice(0, 10);
    const list = days.get(day) || [];
    list.push(v);
    days.set(day, list);
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, list]) => ({ day, t: Date.parse(`${day}T12:00:00Z`), value: median(list), n: list.length }));
}

// The baseline a review level is set from: the median daily value over the
// 30 days up to the origin, or null with the reason.
function baselineAt(series, origin, { days = 30, minPoints = D.SCENARIOS.min_points } = {}) {
  const O = tOf(origin);
  const pts = (series || []).filter((p) => p.t <= O && p.t > O - days * DAY && p.value > 0);
  if (pts.length < minPoints) return { value: null, points: pts.length, reason: `Only ${pts.length} daily readings in the ${days} days before the origin (at least ${minPoints} are needed).` };
  return { value: median(pts.map((p) => p.value)), points: pts.length, from: pts[0].day, to: pts[pts.length - 1].day };
}

// Conditional threshold estimates for one series. worse: 'lower' (volume,
// reserves) or 'higher' (exit cost). Each scenario states its assumption; the
// date is when the series would cross the level under it, never a probability.
function scenarioEstimates(series, { threshold, worse = 'lower', origin, now = Date.now(), metric = 'value', unit = 'usd' } = {}) {
  const S = D.SCENARIOS;
  const out = { version: S.version, label: S.label, metric, unit, threshold: isNum(threshold) ? threshold : null, worse, origin: origin || null, invalidation: S.invalidation };
  const O = tOf(origin);
  const horizonEnd = Number.isFinite(O) ? O + D.HORIZON_HOURS * HOUR : now + D.HORIZON_HOURS * HOUR;
  if (!isNum(threshold) || threshold <= 0) return { ...out, status: 'no_threshold', words: 'No level is set for this measure, so no crossing is estimated.' };
  const start = now - S.window_days * DAY;
  const all = (Array.isArray(series) ? series : []).filter((p) => isNum(p.t) && p.t >= start && p.t <= now);
  const zeros = all.filter((p) => !(p.value > 0)).length;
  const pts = all.filter((p) => p.value > 0).sort((a, b) => a.t - b.t);
  const insufficient = (words, next) => ({ ...out, status: 'insufficient', words: `Insufficient history to estimate: ${words}`, next_observation: next, basis: { points: pts.length, excluded_zero: zeros } });
  if (pts.length < S.min_points) {
    const need = S.min_points - pts.length;
    return insufficient(`${pts.length} daily reading${pts.length === 1 ? '' : 's'} in the window (${S.min_points} needed).`, `${need} more daily reading${need === 1 ? '' : 's'}, through about ${iso(Math.max(now, pts.length ? pts[pts.length - 1].t : now) + need * DAY).slice(0, 10)}.`);
  }
  const first = pts[0];
  const last = pts[pts.length - 1];
  const spanDays = (last.t - first.t) / DAY;
  if (spanDays < S.min_span_days) return insufficient(`the readings span ${Math.round(spanDays)} days (${S.min_span_days} needed).`, `Daily readings through about ${iso(first.t + S.min_span_days * DAY).slice(0, 10)}.`);
  const ageH = (now - (last.t + 12 * HOUR)) / HOUR;
  if (ageH > S.freshness_hours) return insufficient(`the latest daily reading (${last.day}) is ${hoursText(ageH)} old.`, 'A new reading of this measure.');
  // Weekly changes, each between two readings 6 to 8 days apart, scaled to 7 days.
  const weekly = [];
  for (const p of pts) {
    let best = null;
    for (const q of pts) {
      const dt = (p.t - q.t) / DAY;
      if (dt < 6 || dt > 8) continue;
      if (!best || Math.abs(dt - 7) < Math.abs((p.t - best.t) / DAY - 7)) best = q;
    }
    if (best) weekly.push({ to: p.day, from: best.day, g: (Math.log(p.value / best.value) * 7 * DAY) / (p.t - best.t) });
  }
  if (weekly.length < S.min_weekly_changes) return insufficient(`only ${weekly.length} week-on-week change${weekly.length === 1 ? '' : 's'} can be measured (${S.min_weekly_changes} needed).`, 'More daily readings without gaps.');
  const toward = (g) => (worse === 'lower' ? g < 0 : g > 0);
  const gs = weekly.map((w) => w.g);
  const worst = worse === 'lower' ? Math.min(...gs) : Math.max(...gs);
  const bestG = worse === 'lower' ? Math.max(...gs) : Math.min(...gs);
  const latest = last.value;
  const beyondNow = worse === 'lower' ? latest < threshold : latest > threshold;
  const pct = (g) => round((Math.exp(g) - 1) * 100, 1);
  const crossing = (g, want) => {
    // value(weeks) = latest * exp(g * weeks); want 'beyond' or 'back'
    if (!g) return null;
    const weeks = Math.log(threshold / latest) / g;
    if (!Number.isFinite(weeks) || weeks <= 0) return null;
    if (want === 'beyond' && !toward(g)) return null;
    if (want === 'back' && toward(g)) return null;
    return last.t + weeks * 7 * DAY;
  };
  const make = (kind, g, note) => {
    const base = { kind, assumption: S.kinds[kind], rate_pct_per_week: g ? pct(g) : 0, note: note || null };
    if (beyondNow) {
      if (kind !== 'recovery') return { ...base, crosses_at: null, direction: null, within_horizon: false, words: `Already past the level (latest ${round(latest, 4)} against ${round(threshold, 4)}); ${kind === 'stabilization' ? 'it stays past it under this assumption' : 'it stays past it'}.` };
      const t = crossing(g, 'back');
      if (!t) return { ...base, crosses_at: null, direction: 'back', within_horizon: false, words: 'Does not come back within the level under this assumption.' };
      return { ...base, crosses_at: iso(t).slice(0, 10), direction: 'back', within_horizon: t <= horizonEnd, words: t <= horizonEnd ? `Back within the level around ${iso(t).slice(0, 10)}.` : 'Back within the level only after the 120-day horizon.' };
    }
    const t = kind === 'recovery' ? null : crossing(g, 'beyond');
    if (!t) return { ...base, crosses_at: null, direction: 'beyond', within_horizon: false, words: 'No crossing under this assumption.' };
    return { ...base, crosses_at: iso(t).slice(0, 10), direction: 'beyond', within_horizon: t <= horizonEnd, words: t <= horizonEnd ? `Crosses the level around ${iso(t).slice(0, 10)}.` : 'Crosses the level only after the 120-day horizon.' };
  };
  const scenarios = [
    make('deterioration', toward(worst) ? worst : 0, toward(worst) ? null : 'No week in the window moved toward the level; the stress case repeats no decline.'),
    make('stabilization', 0),
    make('recovery', !toward(bestG) ? bestG : 0, !toward(bestG) ? null : 'No week in the window moved away from the level.'),
  ];
  return {
    ...out,
    status: 'estimated',
    beyond_now: beyondNow,
    latest: { day: last.day, value: latest },
    scenarios,
    basis: { window_from: first.day, window_to: last.day, points: pts.length, weekly_changes: weekly.length, worst_week_pct: pct(worst), best_week_pct: pct(bestG), data_age_hours: round(Math.max(0, ageH), 1), excluded_zero: zeros },
  };
}

// The delivery window's conditional date: when the window passes if no new
// delivery is observed.
function deliveryCrossing(latestDeliveryAt, windowDays, { origin } = {}) {
  const t = tOf(latestDeliveryAt);
  if (!Number.isFinite(t)) return { status: 'insufficient', words: 'Insufficient history to estimate: no delivery observed on record.', next_observation: 'A repository reading.' };
  const at = t + windowDays * DAY;
  const O = tOf(origin);
  const horizonEnd = Number.isFinite(O) ? O + D.HORIZON_HOURS * HOUR : Infinity;
  return { status: 'estimated', label: D.SCENARIOS.label, assumption: 'No new release or default-branch commit is observed.', crosses_at: iso(at).slice(0, 10), within_horizon: at <= horizonEnd, words: `If no new delivery is observed, your ${windowDays}-day window passes on ${iso(at).slice(0, 10)}.` };
}

// ---------------------------------------------------------------------------
// The assessment and challenge blocks

const RE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,39}$/;

function normSource(s, i, errors) {
  if (!s || typeof s !== 'object') return null;
  const id = typeof s.source_id === 'string' && RE_ID.test(s.source_id.trim()) ? s.source_id.trim() : null;
  if (!id) {
    errors.push(`sources[${i}]: no valid source_id`);
    return null;
  }
  return {
    source_id: id,
    url: safeUrl(s.url),
    url_given: s.url && !safeUrl(s.url) ? str(String(s.url), 200) : null,
    publisher: str(s.publisher, 160),
    type: oneOf(s.type, D.SOURCE_TYPES) || 'other',
    retrieved_at: isoOrNull(s.retrieved_at),
    event_time: isoOrNull(s.event_time),
    block_or_commit: str(s.block_or_commit, 120),
    tx_signature: str(s.tx_signature, 160),
    excerpt: str(s.excerpt, 1200),
    content_sha256: typeof s.content_sha256 === 'string' && /^[0-9a-f]{64}$/i.test(s.content_sha256.trim()) ? s.content_sha256.trim().toLowerCase() : null,
  };
}

function normFinding(f, i, errors) {
  if (!f || typeof f !== 'object') return null;
  const id = typeof f.finding_id === 'string' && RE_ID.test(f.finding_id.trim()) ? f.finding_id.trim() : null;
  if (!id) {
    errors.push(`findings[${i}]: no valid finding_id`);
    return null;
  }
  const statement = str(f.statement, 1500);
  if (!statement) errors.push(`${id}: no statement`);
  const kind = oneOf(f.kind, D.FINDING_KINDS);
  if (!kind) errors.push(`${id}: kind must be observation, inference or hypothesis`);
  return {
    finding_id: id,
    claim_id: typeof f.claim_id === 'string' && RE_ID.test(f.claim_id.trim()) ? f.claim_id.trim() : null,
    area: oneOf(f.area, D.AREA_IDS),
    kind: kind || 'hypothesis',
    kind_given: kind ? null : str(String(f.kind || ''), 40),
    statement: statement || '',
    source_ids: ids(f.source_ids),
    event_time: isoOrNull(f.event_time),
    retrieved_at: isoOrNull(f.retrieved_at),
    block_or_commit: str(f.block_or_commit, 120),
    severity: oneOf(f.severity, D.SEVERITIES),
    confidence: oneOf(f.confidence, D.CONFIDENCES),
    alternative_explanation: str(f.alternative_explanation, 800),
    missing_evidence: str(f.missing_evidence, 800),
    would_confirm: str(f.would_confirm, 600),
    would_overturn: str(f.would_overturn, 600),
    wallet_relation: oneOf(f.wallet_relation, D.WALLET_RELATIONS),
    basis: Array.isArray(f.basis) ? f.basis.map((b) => str(String(b), 60)).filter(Boolean).slice(0, 10) : [],
    discontinuation: oneOf(f.discontinuation, D.DISCONTINUATION),
  };
}

function normLiquidityObs(o, i) {
  if (!o || typeof o !== 'object') return null;
  const kind = oneOf(o.kind, ['executable_quote', 'pool_reserves', 'reported_liquidity', 'volume']);
  if (!kind) return null;
  const q = o.quote && typeof o.quote === 'object' ? o.quote : {};
  return {
    obs_id: typeof o.obs_id === 'string' && RE_ID.test(o.obs_id.trim()) ? o.obs_id.trim() : `L${i + 1}`,
    kind,
    source_id: typeof o.source_id === 'string' ? o.source_id.trim().slice(0, 40) : null,
    venue: str(o.venue, 120),
    chain: str(o.chain, 60),
    pool: str(o.pool, 120),
    mechanism: oneOf(o.mechanism, Object.keys(D.LIQUIDITY.mechanisms)) || 'unknown',
    route_scope: oneOf(o.route_scope, ['aggregator', 'single_venue']) || 'single_venue',
    retrieved_at: isoOrNull(o.retrieved_at),
    base_reserve: num(o.base_reserve),
    quote_reserve: num(o.quote_reserve),
    quote_token: str(o.quote_token, 40),
    quote_usd_price: num(o.quote_usd_price),
    fee_bps: num(o.fee_bps),
    reported_liquidity_usd: num(o.reported_liquidity_usd),
    volume_24h_usd: num(o.volume_24h_usd),
    quote: kind === 'executable_quote' ? { sell_usd: num(q.sell_usd), received_usd: num(q.received_usd), fees_usd: num(q.fees_usd), price_impact_pct: num(q.price_impact_pct), gas_usd: num(q.gas_usd), gas_included: q.gas_included === true, route: str(q.route, 300), no_route: q.no_route === true } : null,
    method_note: str(o.method_note, 400),
  };
}

const CHECKPOINT_SET = new Set(D.CHECKPOINT_IDS);

// The investigator's block, cleaned. errors: what is wrong with it (kept with
// the receipt and shown); the binding fields are checked by forensics.js.
function normalizeAssessment(obj) {
  const errors = [];
  const o = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  const sources = (Array.isArray(o.sources) ? o.sources : []).slice(0, 200).map((s, i) => normSource(s, i, errors)).filter(Boolean);
  const findings = (Array.isArray(o.findings) ? o.findings : []).slice(0, 120).map((f, i) => normFinding(f, i, errors)).filter(Boolean);
  const dup = (list, key) => list.map((x) => x[key]).filter((v, i, a) => a.indexOf(v) !== i);
  for (const d of dup(sources, 'source_id')) errors.push(`Source ID ${d} is used twice`);
  for (const d of dup(findings, 'finding_id')) errors.push(`Finding ID ${d} is used twice`);
  const ref = (x) => (x && typeof x === 'object' ? { finding_id: typeof x.finding_id === 'string' ? x.finding_id.trim().slice(0, 40) : null, statement: str(x.statement, 1200) } : null);
  const grades = {};
  const g = o.category_grades && typeof o.category_grades === 'object' ? o.category_grades : {};
  for (const id of D.RUBRIC_IDS) {
    const c = g[id] && typeof g[id] === 'object' ? g[id] : {};
    const score = num(c.score);
    const fids = ids(c.finding_ids);
    const conf = oneOf(c.confidence, D.CONFIDENCES);
    const scored = score !== null && score >= 0 && score <= 100 && fids.length > 0 && conf;
    if (score !== null && !scored) errors.push(`${id}: a score needs 0-100, the findings it rests on and a confidence; read as unknown`);
    grades[id] = scored ? { status: 'scored', score: Math.round(score), confidence: conf, finding_ids: fids, reason: str(c.reason, 600) } : { status: 'unknown', score: null, confidence: null, finding_ids: fids, reason: str(c.reason, 600) || 'Not assessed.' };
  }
  const areas = {};
  const cov = o.evidence_coverage && typeof o.evidence_coverage === 'object' && o.evidence_coverage.areas && typeof o.evidence_coverage.areas === 'object' ? o.evidence_coverage.areas : {};
  for (const id of D.AREA_IDS) areas[id] = oneOf(cov[id], D.COVERAGE) || 'unknown';
  const liq = o.liquidity && typeof o.liquidity === 'object' ? o.liquidity : {};
  const ops = o.operational && typeof o.operational === 'object' ? o.operational : {};
  const del = o.delivery && typeof o.delivery === 'object' ? o.delivery : {};
  const mt = o.monitoring_targets && typeof o.monitoring_targets === 'object' ? o.monitoring_targets : {};
  const list = (v, max, fn) => (Array.isArray(v) ? v.slice(0, max).map(fn).filter(Boolean) : []);
  const out = {
    plain_assessment: str(o.plain_assessment, 2000),
    assessment_as_of: isoOrNull(o.assessment_as_of),
    model_version: str(o.model_version, 80),
    evidence_coverage: { areas, notes: str(o.evidence_coverage && o.evidence_coverage.notes, 800) },
    strongest_concern: ref(o.strongest_concern),
    strongest_counterevidence: ref(o.strongest_counterevidence),
    explanations_compared: list(o.explanations_compared, 12, (x) => (x && typeof x === 'object' && str(x.explanation, 400) ? { explanation: str(x.explanation, 400), supported_by: ids(x.supported_by), weakened_by: ids(x.weakened_by), assessment: oneOf(x.assessment, ['more_likely', 'less_likely', 'cannot_tell']) || 'cannot_tell' } : null)),
    sources,
    claims: list(o.claims, 60, (c) => (c && typeof c === 'object' && typeof c.claim_id === 'string' && RE_ID.test(c.claim_id.trim()) ? { claim_id: c.claim_id.trim(), claim: str(c.claim, 600), made_by_source_id: typeof c.made_by_source_id === 'string' ? c.made_by_source_id.trim().slice(0, 40) : null } : null)),
    findings,
    category_grades: grades,
    liquidity: { observations: list(liq.observations, 60, normLiquidityObs), notes: str(liq.notes, 1000) },
    operational: { observations: list(ops.observations, 40, (x, i) => (x && typeof x === 'object' ? { obs_id: typeof x.obs_id === 'string' && RE_ID.test(x.obs_id.trim()) ? x.obs_id.trim() : `P${i + 1}`, check: str(x.check, 300), url: safeUrl(x.url), observed_at: isoOrNull(x.observed_at), outcome: oneOf(x.outcome, ['worked', 'failed', 'partial', 'not_tested']) || 'not_tested', source_id: typeof x.source_id === 'string' ? x.source_id.trim().slice(0, 40) : null, note: str(x.note, 400) } : null)) },
    delivery: { observations: list(del.observations, 20, (x, i) => (x && typeof x === 'object' ? { obs_id: typeof x.obs_id === 'string' && RE_ID.test(x.obs_id.trim()) ? x.obs_id.trim() : `R${i + 1}`, repository: str(x.repository, 200), observed_at: isoOrNull(x.observed_at), latest_commit_at: isoOrNull(x.latest_commit_at), latest_commit: str(x.latest_commit, 80), latest_release_at: isoOrNull(x.latest_release_at), latest_release: str(x.latest_release, 80), source_id: typeof x.source_id === 'string' ? x.source_id.trim().slice(0, 40) : null } : null)) },
    scenarios: list(o.scenarios, 6, (x) => (x && typeof x === 'object' && oneOf(x.scenario, ['deterioration', 'stabilization', 'recovery']) ? { scenario: oneOf(x.scenario, ['deterioration', 'stabilization', 'recovery']), assumptions: str(x.assumptions, 800), warning_signs: Array.isArray(x.warning_signs) ? x.warning_signs.map((w) => str(String(w), 300)).filter(Boolean).slice(0, 8) : [], would_invalidate: str(x.would_invalidate, 500) } : null)),
    watch_items: list(o.watch_items, 30, (x) => (x && typeof x === 'object' && str(x.signal, 300) ? { by: CHECKPOINT_SET.has(String(x.by)) ? String(x.by) : null, signal: str(x.signal, 300), worsens_if: str(x.worsens_if, 300), improves_if: str(x.improves_if, 300), source_or_check: str(x.source_or_check, 300) } : null)),
    conditions: {
      worsen: Array.isArray(o.conditions && o.conditions.worsen) ? o.conditions.worsen.map((w) => str(String(w), 400)).filter(Boolean).slice(0, 12) : [],
      improve: Array.isArray(o.conditions && o.conditions.improve) ? o.conditions.improve.map((w) => str(String(w), 400)).filter(Boolean).slice(0, 12) : [],
    },
    next_evidence: list(o.next_evidence, 12, (x) => (x && typeof x === 'object' && str(x.evidence, 400) ? { evidence: str(x.evidence, 400), would_change: str(x.would_change, 400), how_to_get: str(x.how_to_get, 300) } : null)),
    monitoring_targets: {
      product_checks: list(mt.product_checks, 5, (x) => (x && typeof x === 'object' && safeUrl(x.url) ? { label: str(x.label, 120) || 'Product check', url: safeUrl(x.url), expect_status: Number.isInteger(x.expect_status) && x.expect_status >= 200 && x.expect_status < 400 ? x.expect_status : null, expect_text: str(x.expect_text, 120), capability: str(x.capability, 300), source_id: typeof x.source_id === 'string' ? x.source_id.trim().slice(0, 40) : null } : null)),
      repositories: list(mt.repositories, 3, (x) => (x && typeof x === 'object' && (x.host === 'github' || x.host === undefined) && typeof x.owner === 'string' && typeof x.repo === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(x.owner.trim()) && /^[A-Za-z0-9._-]{1,100}$/.test(x.repo.trim()) && !x.repo.includes('..') ? { host: 'github', owner: x.owner.trim(), repo: x.repo.trim(), source_id: typeof x.source_id === 'string' ? x.source_id.trim().slice(0, 40) : null } : null)),
    },
    forecast: { probabilities: o.forecast && o.forecast.probabilities !== undefined && o.forecast.probabilities !== null ? o.forecast.probabilities : null },
  };
  if (!out.plain_assessment) errors.push('plain_assessment is missing');
  if (!findings.length) errors.push('No findings');
  return { assessment: out, errors };
}

function normalizeChallenge(obj) {
  const errors = [];
  const o = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  const list = (v, max, fn) => (Array.isArray(v) ? v.slice(0, max).map(fn).filter(Boolean) : []);
  const sources = (Array.isArray(o.sources) ? o.sources : []).slice(0, 100).map((s, i) => normSource(s, i, errors)).filter(Boolean);
  const out = {
    overall: str(o.overall, 2000),
    as_of: isoOrNull(o.as_of),
    model_version: str(o.model_version, 80),
    finding_reviews: list(o.finding_reviews, 120, (x) => (x && typeof x === 'object' && typeof x.finding_id === 'string' ? { finding_id: x.finding_id.trim().slice(0, 40), verdict: oneOf(x.verdict, D.VERDICTS) || 'not_checked', attribution_check: str(x.attribution_check, 800), calculation_check: str(x.calculation_check, 800), benign_explanation: str(x.benign_explanation, 800), omitted_evidence: str(x.omitted_evidence, 800), source_ids: ids(x.source_ids) } : null)),
    calculation_checks: list(o.calculation_checks, 40, (x) => (x && typeof x === 'object' && str(x.subject, 300) ? { subject: str(x.subject, 300), result: oneOf(x.result, ['agrees', 'disagrees', 'cannot_check']) || 'cannot_check', detail: str(x.detail, 800) } : null)),
    omitted_evidence: list(o.omitted_evidence, 30, (x) => (x && typeof x === 'object' && str(x.evidence, 400) ? { evidence: str(x.evidence, 400), why_it_matters: str(x.why_it_matters, 600), source_id: typeof x.source_id === 'string' ? x.source_id.trim().slice(0, 40) : null } : null)),
    benign_explanations: list(o.benign_explanations, 30, (x) => (x && typeof x === 'object' && str(x.explanation, 600) ? { for_finding_id: typeof x.for_finding_id === 'string' ? x.for_finding_id.trim().slice(0, 40) : null, explanation: str(x.explanation, 600), plausibility: oneOf(x.plausibility, ['high', 'medium', 'low']) || 'low' } : null)),
    sources,
  };
  if (!out.overall) errors.push('overall is missing');
  if (!out.finding_reviews.length) errors.push('No finding reviews');
  return { challenge: out, errors };
}

// ---------------------------------------------------------------------------
// The desk's checks on findings: flags only, the assessment is never changed.

function findingChecks(a) {
  const flags = [];
  const sourceIds = new Set((a.sources || []).map((s) => s.source_id));
  const findingIds = new Set((a.findings || []).map((f) => f.finding_id));
  const add = (finding_id, code, level, words) => flags.push({ finding_id, code, level, words });
  for (const f of a.findings || []) {
    if (f.kind === 'observation' && !f.source_ids.length) add(f.finding_id, 'observation_without_source', 'material', 'Stated as an observation with no source: read it as an unsupported statement.');
    const missing = f.source_ids.filter((s) => !sourceIds.has(s));
    if (missing.length) add(f.finding_id, 'unknown_source', 'material', `Cites ${missing.join(', ')}, which the source list does not have.`);
    if (f.wallet_relation === 'inferred_common_control' && f.kind === 'observation') add(f.finding_id, 'common_control_as_observation', 'serious', 'Common control of wallets is an inference, never an observation: the desk reads this finding as an inference.');
    if (f.wallet_relation === 'inferred_common_control' && f.basis.length && f.basis.every((b) => D.WEAK_CONTROL_BASES.includes(b))) add(f.finding_id, 'weak_common_control_basis', 'serious', 'A shared exchange funder, similar balances, a zero-balance deployer or similar timing does not on its own establish common control.');
    if (f.discontinuation && f.discontinuation !== 'reversal' && !f.source_ids.some((s) => (a.sources || []).some((x) => x.source_id === s && (x.type === 'primary' || x.type === 'chain')))) add(f.finding_id, 'discontinuation_without_primary', 'serious', 'Shutdown or withdrawal needs a primary, attributable source; without one it does not count as confirmed discontinuation.');
    const text = `${f.statement} ${f.alternative_explanation || ''}`;
    if (/\b(zero|no|nil)\s+revenue\b/i.test(text) && !f.source_ids.length) add(f.finding_id, 'zero_revenue_from_missing', 'material', 'Unavailable revenue data is not zero revenue.');
    if (/\b(hosting|server|cloud|api)\s+(bill|bills|cost|costs|spend|spending)\b|\brunway\b|\bmotive/i.test(text) && f.kind === 'observation') add(f.finding_id, 'private_cost_inferred', 'material', 'Hosting bills, API spending, runway and motives cannot be observed from a technology stack.');
    if (/\bhash(es)?\b[^.]{0,40}\b(prove|proves|confirm|confirms|verif)/i.test(text)) add(f.finding_id, 'hash_as_truth', 'note', D.HASH_NOTE);
    if (f.kind === 'observation' && !f.retrieved_at && !f.event_time) add(f.finding_id, 'undated_observation', 'note', 'An observation without an event or retrieval time.');
  }
  for (const k of ['strongest_concern', 'strongest_counterevidence']) {
    const r = a[k];
    if (r && r.finding_id && !findingIds.has(r.finding_id)) add(r.finding_id, `${k}_unknown`, 'material', `The ${k === 'strongest_concern' ? 'strongest concern' : 'strongest counterevidence'} names ${r.finding_id}, which is not a finding.`);
  }
  for (const [id, g] of Object.entries(a.category_grades || {})) {
    const missing = (g.finding_ids || []).filter((x) => !findingIds.has(x));
    if (g.status === 'scored' && missing.length) add(null, 'grade_unknown_finding', 'material', `${id} rests on ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not a finding.`);
  }
  return flags;
}

// Probabilities: shown only for a registered method (none in this release);
// a cumulative series that falls as the deadline extends is refused.
function probabilityGate(p) {
  if (p === null || p === undefined) return { status: 'none', shown: null };
  const method = p && typeof p === 'object' && typeof p.method_id === 'string' ? p.method_id : null;
  if (!method || !D.PROBABILITY_METHODS[method]) {
    return { status: 'withheld', shown: null, reason: `A probability was supplied but is not shown: ${method ? `method ${method} is not registered under ${D.PROBABILITY_GATE}` : 'it names no registered method'}. A model's figure, or several models agreeing, is not calibration.` };
  }
  return { status: 'withheld', shown: null, reason: 'Registered methods are not enabled in this release.' };
}

// Cumulative probabilities by deadline must not fall as the deadline extends.
function monotonicByDeadline(series) {
  const order = D.CHECKPOINT_IDS;
  const vals = order.map((id) => (series && isNum(series[id]) ? series[id] : null)).filter((v) => v !== null);
  for (let i = 1; i < vals.length; i++) if (vals[i] < vals[i - 1]) return false;
  return vals.every((v) => v >= 0 && v <= 1);
}

// Evidence coverage: the seven areas as declared, held to the findings that
// back them. A share of areas, never a score or progress.
function coverageOf(a) {
  const out = [];
  for (const [id, label] of D.AREAS) {
    const declared = (a.evidence_coverage && a.evidence_coverage.areas && a.evidence_coverage.areas[id]) || 'unknown';
    const sourced = (a.findings || []).filter((f) => f.area === id && f.source_ids.length).length;
    let status = declared;
    let note = null;
    if (declared === 'covered' && !sourced) {
      status = 'partial';
      note = 'Declared covered, but no sourced finding in this area.';
    }
    if (declared === 'unknown' && sourced) {
      status = 'partial';
      note = 'Declared unknown, with sourced findings in this area.';
    }
    out.push({ area: id, label, declared, status, sourced_findings: sourced, note });
  }
  return { of: out.length, covered: out.filter((x) => x.status === 'covered').length, partial: out.filter((x) => x.status === 'partial').length, unknown: out.filter((x) => x.status === 'unknown').length, areas: out, note: 'The share of the seven evidence areas this assessment backs with sourced findings. Not a score and not research progress.' };
}

// ---------------------------------------------------------------------------
// The timeline

// receipt: { origin, deadlines }; perEvent: { [eventId]: { resolve(deadline) } };
// conditional: [{ event, metric, scenario, crosses_at }]; watch: watch items.
function timeline({ origin, deadlines, now = Date.now(), resolve, conditional = [], watch = [] }) {
  const cps = (deadlines && deadlines.length ? deadlines : deadlinesFrom(origin));
  let prevT = tOf(origin);
  return {
    origin,
    label: D.SCENARIOS.label,
    checkpoints: cps.map((c) => {
      const T = tOf(c.at);
      const cond = conditional.filter((x) => x.crosses_at && tOf(`${x.crosses_at}T12:00:00Z`) > prevT && tOf(`${x.crosses_at}T12:00:00Z`) <= T);
      const row = {
        id: c.id,
        label: c.label,
        at: c.at,
        status: now >= T ? 'past' : 'upcoming',
        observed: Object.fromEntries(D.EVENT_IDS.map((e) => [e, resolve(e, c)])),
        conditional: cond,
        watch: watch.filter((w) => w.by === c.id),
      };
      prevT = T;
      return row;
    }),
  };
}

module.exports = {
  HOUR,
  DAY,
  str,
  safeUrl,
  isoOrNull,
  deadlinesFrom,
  evaluateEvent,
  resolveAt,
  discontinuationState,
  resolveDiscontinuationAt,
  combineStates,
  exitEstimate,
  exitTable,
  liquidityReadings,
  median,
  dailySeries,
  baselineAt,
  scenarioEstimates,
  deliveryCrossing,
  normalizeAssessment,
  normalizeChallenge,
  findingChecks,
  probabilityGate,
  monotonicByDeadline,
  coverageOf,
  timeline,
};
