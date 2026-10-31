'use strict';
// Bounded automatic admission of scout leads (cr-lead-admission@1, readiness
// PR 2026-10-31). Off by default. When Eric arms it (Settings or arm-desk
// --admission-days), the `leads` job may admit at most `daily_limit` (0..3,
// default 1) ELIGIBLE leads per New York day, one at a time, and only while
// no earlier automatic admission's pipeline is still active. An admission is
// a research request, never a trade: ELIGIBLE means eligible for research.
// What it does is what Eric's "Confirm and request research" does (leads.js
// completeAdmission: the intake record, the project, the Claude run), plus
// the pilot enrollment (tickets.setPilot) and the project's exit-quote target
// (forensics.approvePrimaryExitQuote), under the actor `auto-admission`.
// Every gate after it stands: the Prosecutor, the contract gate, the exit
// cost, the paper mandate (which alone grants paper execution) and the book.
//
// Authority. automation.lead_admission {enabled, daily_limit, expires_at} is
// outside automation.mandate, so writing it never changes the mandate's hash,
// generation or grants. A write of this block that leaves it live records a
// new generation (authorityNext, called by server.applySettings, like the
// mandate's); one that leaves it off, zero or paused revokes the one in
// force. Resuming automation never re-arms it. An admission freezes the
// generation and the settings' hash it was reserved under; any later write
// (a new generation), a pause, the expiry or a revocation stops its remaining
// effects before they start (leads.js delegatedGate). Pausing automation
// revokes this and the mandate together, as pausing always did.
//
// Capacity. The slot is reserved under the workspace lock before any effect,
// at the lock's own clock: every automatic admission whose reservation names
// today's New York day counts, whatever its state (pending, failed, stopped,
// lapsed, complete), so a crash, a replay or a concurrent sweep never frees
// or doubles one. A slot is never recycled. The admission's ID derives from
// the eligibility receipt, so the same reading is never admitted twice.
//
// Budgets. Admission is held, with the reason, unless every downstream meter
// is readable, has its cap set and is under 85% of it (the 15% headroom
// supplements each meter's own reserve-before-send check at its dispatch
// boundary, which stays the enforcement): the pilot's daily sessions, the
// exit-quote monitor's monthly requests (counted and planned), CoinGecko's
// and GoPlus's monthly calls, the contract RPC's daily and monthly compute
// units and GeckoTerminal's candle calls. A meter never run reads as 0 used;
// one that cannot be read holds. An approved exit target is not a
// reservation, so its planned load is checked here too.
//
// Read only here, except reserve(), which writes the admission and the lead
// in one verified operation; the effects run after the lock (leads.js).

const { runOp } = require('./ops');
const { readJson, sha256 } = require('./fsx');
const { stableStringify } = require('./requests');
const { ymdInTz } = require('./dates');

const VERSION = 'cr-lead-admission@1';
const AUTHORITY_VERSION = 'cr-lead-admission-authority@1';
const ACTOR = 'auto-admission';
const ROUTE = 'pilot_worker';
const DAILY_MAX = 3;
const DAILY_DEFAULT = 1;
const MAX_DAYS = 30;
const MAX_ACTIVE = 1;
const HEADROOM = 0.15;
const MIN_SESSIONS = 2;
const FIELDS = Object.freeze(['enabled', 'daily_limit', 'expires_at']);
// The steps of an enrolled project's pipeline that are still moving (an agent
// or a collector has work); the others are where it rests.
const ACTIVE_STEPS = new Set(['research', 'ticket', 'ticket_failed', 'exit_evidence', 'contract_evidence']);

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const iso = (ms) => new Date(ms).toISOString();

// The admission settings as stored: unset is the default; a stored value out
// of bounds reads as 0 (off), never as a larger limit.
function valuesOf(automation) {
  const s = isObj(automation && automation.lead_admission) ? automation.lead_admission : {};
  const d = s.daily_limit;
  return {
    enabled: s.enabled === true,
    daily_limit: d === undefined || d === null ? DAILY_DEFAULT : Number.isInteger(d) && d >= 0 && d <= DAILY_MAX ? d : 0,
    expires_at: typeof s.expires_at === 'string' && Number.isFinite(Date.parse(s.expires_at)) ? s.expires_at : null,
  };
}
const policySha = (v) => sha256(stableStringify({ version: VERSION, enabled: v.enabled, daily_limit: v.daily_limit, expires_at: v.expires_at }));
const liveOf = (automation) => {
  const v = valuesOf(automation);
  return v.enabled && v.daily_limit >= 1 && !(automation && automation.paused === true);
};

// A settings patch's lead_admission block (server.validateSettingsPatch).
// Returns the values to save; throws INVALID naming the field. `saved` is the
// automation block on disk, for the cross-field rule: turning it on, or moving
// its expiry while on, needs a future expiry at most MAX_DAYS ahead.
function validatePatch(p, saved = {}, now = Date.now()) {
  const { OpError } = require('./ops');
  if (!isObj(p)) throw new OpError('INVALID', 'automation.lead_admission must be an object.');
  const unknown = Object.keys(p).filter((k) => !FIELDS.includes(k));
  if (unknown.length) throw new OpError('INVALID', `automation.lead_admission has no setting ${unknown.join(', ')}${unknown.includes('authority') ? ' (its authority is recorded by the desk, never sent)' : ''}.`);
  const o = {};
  if (p.enabled !== undefined) {
    if (typeof p.enabled !== 'boolean') throw new OpError('INVALID', 'automation.lead_admission.enabled must be true or false.');
    o.enabled = p.enabled;
  }
  if (p.daily_limit !== undefined) {
    if (!Number.isInteger(p.daily_limit) || p.daily_limit < 0 || p.daily_limit > DAILY_MAX) throw new OpError('INVALID', `automation.lead_admission.daily_limit must be a whole number from 0 to ${DAILY_MAX} (0 turns admission off).`);
    o.daily_limit = p.daily_limit;
  }
  if (p.expires_at !== undefined) {
    if (p.expires_at === null) o.expires_at = null;
    else {
      const t = typeof p.expires_at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(p.expires_at) ? Date.parse(p.expires_at) : NaN;
      if (!Number.isFinite(t)) throw new OpError('INVALID', 'automation.lead_admission.expires_at must be an ISO-8601 UTC time, or null.');
      if (t <= now) throw new OpError('INVALID', 'automation.lead_admission.expires_at must be in the future.');
      if (t - now > MAX_DAYS * 86400000) throw new OpError('INVALID', `automation.lead_admission.expires_at can be at most ${MAX_DAYS} days ahead.`);
      o.expires_at = iso(t);
    }
  }
  const was = valuesOf(saved);
  const on = o.enabled !== undefined ? o.enabled : was.enabled;
  if (on && (o.enabled === true || o.expires_at !== undefined)) {
    const exp = o.expires_at !== undefined ? o.expires_at : was.expires_at;
    if (!(Date.parse(exp) > now)) throw new OpError('INVALID', `Set automation.lead_admission.expires_at (at most ${MAX_DAYS} days ahead) to turn on automatic admission.`);
  }
  return o;
}

// The authority a settings write records (server.applySettings), or null
// for none. Only a write that names automation.lead_admission arms it; a
// write that leaves it off, zero or paused revokes the generation in force.
function authorityNext(cur, patch, merged, { now = Date.now(), actor = null } = {}) {
  const a0 = (cur && cur.automation) || {};
  const pa = (patch && patch.automation) || {};
  const a1 = (merged && merged.automation) || {};
  const prev = isObj(a0.lead_admission) && isObj(a0.lead_admission.authority) ? a0.lead_admission.authority : null;
  const prevGen = prev && Number.isSafeInteger(prev.generation) && prev.generation >= 1 ? prev.generation : 0;
  const sha = policySha(valuesOf(a1));
  if (pa.lead_admission !== undefined && liveOf(a1)) {
    if (prev && prevGen && !prev.revoked_at && liveOf(a0) && prev.policy_sha256 === sha) return null;
    return { version: AUTHORITY_VERSION, generation: prevGen + 1, armed_at: iso(now), armed_by: actor || null, policy_sha256: sha };
  }
  if (!liveOf(a1) && prev && prevGen && !prev.revoked_at) {
    const v = valuesOf(a1);
    return { ...prev, revoked_at: iso(now), revoked_by: actor || null, revoked_because: a1.paused === true ? 'paused' : !v.enabled ? 'off' : 'zero' };
  }
  return null;
}

// Whether automatic admission holds now: { on, code, why, values,
// policy_sha256, generation, authority }. Reads only.
function authorityOf(ws, now = Date.now()) {
  const a = (ws.settings && ws.settings.automation) || {};
  const v = valuesOf(a);
  const au = isObj(a.lead_admission) && isObj(a.lead_admission.authority) ? a.lead_admission.authority : null;
  const sha = policySha(v);
  const gen = au && Number.isSafeInteger(au.generation) ? au.generation : 0;
  const base = { version: VERSION, values: v, policy_sha256: sha, generation: gen, authority: au };
  const no = (code, why) => ({ ...base, on: false, code, why });
  if (!v.enabled) return no('off', 'Automatic admission is off (automation.lead_admission.enabled).');
  if (v.daily_limit < 1) return no('zero', 'The daily admission limit is 0.');
  if (a.paused === true) return no('paused', 'Automation is paused.');
  if (!v.expires_at) return no('no_expiry', 'Automatic admission has no expiry.');
  if (Date.parse(v.expires_at) <= now) return no('expired', `Automatic admission expired at ${v.expires_at}.`);
  if (!au || gen < 1) return no('not_armed', 'Automatic admission was never armed by a settings write that records its authority.');
  if (au.revoked_at) return no('revoked', `Automatic admission generation ${gen} was revoked at ${au.revoked_at} (${au.revoked_because || 'revoked'}).`);
  if (au.policy_sha256 !== sha) return no('changed', 'The admission settings differ from the ones armed; arm them again.');
  try { if (require('./research').restoredHold(ws)) return no('restored', 'This is a restored copy.'); } catch (_) { /* not held */ }
  return { ...base, on: true, code: null, why: null };
}

// Each downstream meter, readable, capped and under 85%, or why not.
// [{ meter, code, why }], empty when nothing holds. Reads only.
function budgetHolds(ws, now = Date.now()) {
  const out = [];
  const hold = (meter, code, why) => out.push({ meter, code, why });
  const over = (used, cap) => used > cap * (1 - HEADROOM);
  const day = ymdInTz(new Date(now));
  const month = day.slice(0, 7);
  const countsIn = (st, m = month, d = day) => {
    const c = st && isObj(st.calls) ? st.calls : null;
    return { month: c && c.month === m ? Number(c.month_count) || 0 : 0, day: c && c.day === d ? Number(c.day_count) || 0 : 0 };
  };
  // The pilot's sessions: a pipeline needs a Researcher and a Prosecutor.
  const s = require('./pilot-claims').sessionsView(ws, now);
  if (s.unreadable) hold('sessions', 'unreadable', 'The pilot\'s session count for today could not be read.');
  else if (!(s.ceiling >= MIN_SESSIONS)) hold('sessions', 'cap', `The pilot's daily session ceiling (${s.ceiling}) is below the ${MIN_SESSIONS} a pipeline needs.`);
  // The exit-quote monitor: what was sent this month and what is planned.
  const fm = require('./forensic-monitor').readStatus(ws);
  const qb = require('./forensics').quoteBudgetOf(ws);
  if (fm.unreadable) hold('exit_quotes', 'unreadable', 'The exit-quote monitor\'s request count could not be read.');
  else if (!(qb.budget > 0)) hold('exit_quotes', 'unset', 'The exit-quote monitor has no monthly request budget.');
  else {
    const sent = countsIn(fm).month;
    if (over(sent, qb.budget)) hold('exit_quotes', 'headroom', `The exit-quote monitor sent ${sent} of ${qb.budget} requests this month, past 85%.`);
    else if (over(qb.used + qb.per, qb.budget)) hold('exit_quotes', 'headroom', `About ${qb.per} more exit-quote requests a month would bring the planned load to ${qb.used + qb.per} of ${qb.budget}, past 85%.`);
  }
  // CoinGecko (its own month key, as market.callBudget counts it).
  const market = require('./market');
  let cg = null;
  try { cg = market.callBudget(ws, market.readStatus(ws)); } catch (_) { cg = null; }
  if (!cg) hold('coingecko', 'unreadable', 'CoinGecko\'s call count could not be read.');
  else if (!(cg.budget_monthly > 0)) hold('coingecko', 'unset', 'CoinGecko has no monthly call budget.');
  else if (over(cg.month_count, cg.budget_monthly)) hold('coingecko', 'headroom', `CoinGecko used ${cg.month_count} of ${cg.budget_monthly} calls this month, past 85%.`);
  // GoPlus.
  const screening = require('./screening');
  const gp = screening.readStatus(ws);
  const gpCap = { ...screening.DEFAULTS, ...((ws.settings && ws.settings.screening) || {}) }.monthly_request_budget;
  if (gp.unreadable) hold('goplus', 'unreadable', 'GoPlus\'s request count could not be read.');
  else if (!(gpCap > 0)) hold('goplus', 'unset', 'GoPlus has no monthly request budget.');
  else if (over(countsIn(gp).month, gpCap)) hold('goplus', 'headroom', `GoPlus used ${countsIn(gp).month} of ${gpCap} requests this month, past 85%.`);
  // The contract RPC's compute units (the contract gate's evidence).
  const rpc = require('./contract-rpc');
  const c = (ws.settings && ws.settings.contracts) || {};
  const caps = rpc.capsOf(ws);
  if (c.enabled !== true) hold('contract_rpc', 'off', 'Contract observations are off (contracts.enabled), so the contract gate would hold every new project.');
  else if (!caps.set) hold('contract_rpc', 'unset', caps.why);
  else {
    const st = rpc.readState(ws);
    const n = st.unreadable ? null : rpc.countsOf(st, now);
    if (!n) hold('contract_rpc', 'unreadable', rpc.UNREADABLE_WORDS);
    else if (n.unknown) hold('contract_rpc', 'unreadable', n.unknown);
    else if (over(n.day_cu, caps.daily) || over(n.month_cu, caps.monthly)) hold('contract_rpc', 'headroom', `Contract reads used ${n.day_cu} of ${caps.daily} compute units today and ${n.month_cu} of ${caps.monthly} this month, past 85%.`);
  }
  // GeckoTerminal's candles (the book's hours).
  const tc = require('./trader-candles');
  let cs = null;
  try { cs = readJson(ws.abs(tc.STATUS_REL), { state: 'never_run' }); } catch (_) { cs = null; }
  if (!cs) hold('candles', 'unreadable', 'GeckoTerminal\'s candle call count could not be read.');
  else {
    const k = countsIn(cs);
    if (over(k.day, tc.DAILY_BUDGET) || over(k.month, tc.MONTHLY_BUDGET)) hold('candles', 'headroom', `GeckoTerminal candle calls: ${k.day} of ${tc.DAILY_BUDGET} today and ${k.month} of ${tc.MONTHLY_BUDGET} this month, past 85%.`);
  }
  return out;
}

const isDelegated = (a) => Boolean(a && a.kind === 'delegated');

// Where one automatic admission's pipeline is: { active, stage }. An
// admission still finishing its effects is active; a stopped or lapsed one
// rests; a complete one follows its project's next step (an archived,
// unenrolled or suspended project rests). Unreadable counts as active.
function pipelineOf(ws, a, now = Date.now()) {
  if (a.state === 'lapsed' || a.state === 'stopped') return { active: false, stage: a.state };
  if (a.state !== 'complete') return { active: true, stage: a.state || 'pending' };
  try {
    const pid = a.project_id;
    const p = require('./projects').getProject(ws, pid);
    if (p.status === 'archived') return { active: false, stage: 'archived' };
    const T = require('./tickets');
    if (!T.readTicketProfile(ws, pid).pilot) return { active: false, stage: 'unenrolled' };
    const au = require('./mandate-authority').autonomyOf(ws, pid, { project: p });
    if (au.suspended && !au.unreadable) return { active: false, stage: 'suspended' };
    const s = T.nextStep(ws, pid, { now });
    return { active: ACTIVE_STEPS.has(s.step), stage: s.step };
  } catch (err) {
    return { active: true, stage: 'unreadable', why: String((err && err.message) || err).slice(0, 200) };
  }
}

// Whether one ELIGIBLE lead may be admitted automatically now, by the same
// checks Eric's confirm makes (leads.rowCheck: the receipt intact, unexpired,
// under the policy in force and still ELIGIBLE by its rules) and the ones a
// delegated admission adds: a chain every downstream evidence path covers, a
// listing that verifies an identity, and no project, ticker or candle binding
// it could collide with. { ok, code, why } or { ok, asset, receipt, listing }.
function candidateOf(ws, a, policy, now, op) {
  const L = require('./leads');
  const no = (code, why, extra = {}) => ({ ok: false, lead_key: a.asset_id, code, why, ...extra });
  const e = a.eligibility || {};
  const row = { lead_key: a.asset_id, eligibility_receipt_id: e.receipt_id, eligibility_sha256: e.eligibility_sha256, identity_revision: a.identity_revision, asset_revision: a.revision };
  const c = L.rowCheck(ws, op, row, policy, now);
  if (c.fields.length) return no('eligibility', `Its eligibility does not stand: ${c.fields.map((f) => `${f.field} ${f.now}`).join('; ')}.`, { fields: c.fields });
  const id = c.asset.identity;
  const known = L.knownProject(ws, id);
  if (known) return no('existing_project', `Project ${known.project_id} (${known.status}) already holds this contract.`);
  if (id.family !== 'evm' && id.family !== 'solana') return no('unsupported_chain', `${id.chain_label} is not a chain automatic admission covers.`);
  const gaps = [];
  if (!require('./exitquotes').providerFor(id.chain_id)) gaps.push('no exit-quote route');
  const rpc = require('./contract-rpc');
  if (!Object.prototype.hasOwnProperty.call(rpc.HOSTS, id.chain_id)) gaps.push('no contract read route');
  else {
    const ns = rpc.networkSupport(ws, id.chain_id);
    if (ns.reason === 'network_not_supported') gaps.push(ns.words);
  }
  if (!require('./trader-candles').NETWORKS[id.chain_id]) gaps.push('no candle source');
  if (gaps.length) return no('unsupported_chain', `${id.chain_label}: ${gaps.join(', ')}.`);
  const listing = L.listingOf(c.asset, c.receipt);
  const projects = require('./projects');
  if (!listing.coingecko_id || !listing.name) return no('listing', 'The reading names no CoinGecko coin.');
  if (!listing.symbol || !/^[A-Z0-9.]{1,24}$/.test(listing.symbol)) return no('listing', `Its ticker (${listing.symbol || 'none'}) cannot name a pair in the book.`);
  if (!listing.homepage || projects.isNonOfficialHost(listing.homepage)) return no('identity', 'CoinGecko lists no official website for it, so its identity would not verify.');
  const dup = projects.findDuplicates(ws, { name: listing.name, symbol: listing.symbol, official_website: listing.homepage, coingecko_id: listing.coingecko_id, assets: [{ chain: id.chain_id, contract_address: id.address }] });
  if (dup.strong.length) return no('existing_project', `It matches ${dup.strong.map((x) => `${x.project_id} (${x.reasons.join(', ')})`).join('; ')}.`);
  if (dup.possible.length) return no('ticker_collision', `Another project trades as ${listing.symbol}: ${dup.possible.map((x) => x.project_id).join(', ')}. Tickers are not unique; Eric decides.`);
  const TD = require('./trader-desk');
  const pair = TD.pairOf({ project_id: null, name: listing.name, symbol: listing.symbol, identity: { assets: [{ chain: id.chain_id, contract_address: id.address }] } }, projects.listProjects(ws), { sources: TD.sourceBindings(ws) });
  if (!pair.pair) return no('candle_source', pair.why);
  return { ok: true, lead_key: a.asset_id, asset: c.asset, receipt: c.receipt, listing, pair: pair.pair };
}

// What a sweep would do now: { status: off | idle | held | ready, code, why,
// day, ... }, with the first admissible candidate when ready and each lead's
// hold. Read only; reserve() runs it again inside the lock with its `op`.
function plan(ws, { now = Date.now(), op = null } = {}) {
  const L = require('./leads');
  const auth = authorityOf(ws, now);
  const day = ymdInTz(new Date(now));
  const base = { version: VERSION, day, generation: auth.generation, daily_limit: auth.values.daily_limit, expires_at: auth.values.expires_at };
  if (!auth.on) return { ...base, status: 'off', code: auth.code, why: auth.why };
  const held = (code, why, extra = {}) => ({ ...base, status: 'held', code, why, ...extra });
  const policy = L.policyOf(ws);
  if (!policy.values.enabled) return held('leads_off', 'Scout leads are off.');
  if (policy.missing.length) return held('leads_policy', `The lead policy is incomplete (${policy.missing.join(', ')}).`);
  const reader = op || { readJson: (rel, d) => readJson(ws.abs(rel), d) };
  const eligible = L.assets(ws).filter((a) => !a.integrity && a.state === 'ELIGIBLE')
    .sort((x, y) => String((x.eligibility || {}).decided_at || '').localeCompare(String((y.eligibility || {}).decided_at || '')) || String(x.asset_id).localeCompare(String(y.asset_id)));
  if (!eligible.length) return { ...base, status: 'idle', code: 'no_candidate', why: 'No ELIGIBLE lead is waiting.' };
  const mine = L.listAdmissions(ws).filter(isDelegated);
  const today = mine.filter((a) => a.reservation && a.reservation.day === day);
  const counts = { reserved_today: today.length, limit: auth.values.daily_limit };
  if (today.length >= auth.values.daily_limit) return held('daily_limit', `${today.length} of ${auth.values.daily_limit} automatic ${auth.values.daily_limit === 1 ? 'admission' : 'admissions'} reserved for ${day} (New York).`, { counts });
  const active = mine.map((a) => ({ admission_id: a.admission_id, project_id: a.project_id || null, ...pipelineOf(ws, a, now) })).filter((x) => x.active);
  counts.active = active.length;
  if (active.length >= MAX_ACTIVE) return held('backlog', `An automatic admission's pipeline is still active (${active.map((x) => `${x.admission_id}${x.project_id ? ` on ${x.project_id}` : ''}: ${x.stage}`).join('; ')}); the next waits until it rests.`, { counts, active });
  const budget = budgetHolds(ws, now);
  if (budget.length) return held('budget', budget.map((b) => b.why).join(' '), { counts, budget });
  const holds = [];
  for (const a of eligible) {
    const c = candidateOf(ws, a, policy, now, reader);
    if (c.ok) return { ...base, status: 'ready', counts, candidate: c, holds, policy, authority: auth };
    holds.push({ lead_key: c.lead_key, code: c.code, why: c.why });
  }
  return held('candidates', `${holds.length} ELIGIBLE ${holds.length === 1 ? 'lead is' : 'leads are'} held: ${holds.map((h) => h.why).join(' ')}`, { counts, holds });
}

// Under the lock: the plan again at the lock's clock, then the admission and
// the lead in one verified operation. { status: reserved | off | idle | held,
// admission_id?, plan }. The effects run after it (sweep).
function reserve(ws, { now = Date.now() } = {}) {
  const pre = plan(ws, { now });
  if (pre.status !== 'ready') return { status: pre.status, plan: pre };
  const L = require('./leads');
  const out = runOp(ws, { type: 'scout_lead_auto_admission', summary: `Automatic admission of scout lead ${pre.candidate.lead_key}` }, (op) => {
    const lockNow = Math.max(now, Date.now());
    const p = plan(ws, { now: lockNow, op });
    if (p.status !== 'ready') return { status: p.status, plan: strip(p) };
    const { asset, receipt, listing } = p.candidate;
    const id = L.admissionIdOf(`auto:${receipt.receipt_id}`, asset.asset_id);
    if (op.readJson(`${L.ADMISSIONS}/${id}.json`, null)) return { status: 'exists', admission_id: id, plan: strip(p) };
    const rec = L.delegatedAdmission({
      id, asset, receipt, listing, policy: p.policy, lockNow,
      admission_policy: { version: VERSION, values: p.authority.values, sha256: p.authority.policy_sha256 },
      authority: { version: AUTHORITY_VERSION, generation: p.authority.generation, armed_at: p.authority.authority.armed_at || null, armed_by: p.authority.authority.armed_by || null, policy_sha256: p.authority.policy_sha256 },
      reservation: { reservation_id: `lr_${sha256(`${id}|${p.day}`).slice(0, 14)}`, day: p.day, at: iso(lockNow), clock: 'lock' },
      envelope: { models: ['claude'], routes: { claude: ROUTE }, budget_scope: null },
      capacity: { day: p.day, limit: p.counts.limit, reserved_before: p.counts.reserved_today, active_before: p.counts.active },
    });
    op.writeJson(`${L.ADMISSIONS}/${id}.json`, rec, { mode: 'create' });
    op.writeJson(`${L.ASSETS}/${asset.asset_id}.json`, { ...asset, state: 'ADMITTED', revision: (Number(asset.revision) || 1) + 1, claim: null, next_attempt_at: null, admission_id: id });
    return { status: 'reserved', admission_id: id, plan: strip(p) };
  });
  return { ...out.result, verified: out.verified };
}

// A plan without the records it carries, for a job's answer.
function strip(p) {
  if (!p) return p;
  const { candidate, policy, authority, ...rest } = p;
  return candidate ? { ...rest, candidate: { lead_key: candidate.lead_key, receipt_id: candidate.receipt.receipt_id, coingecko_id: candidate.listing.coingecko_id, symbol: candidate.listing.symbol, chain: candidate.asset.identity.chain_label } } : rest;
}

// One sweep (the `leads` job, after eligibility): reserve, then the effects
// after the lock. Never throws for an admission's effect (leads.attempt).
function sweep(ws, { now = Date.now() } = {}) {
  const r = reserve(ws, { now });
  if (r.status !== 'reserved' && r.status !== 'exists') return { status: r.status, code: r.plan && r.plan.code, why: r.plan && r.plan.why, plan: strip(r.plan) };
  const admission = require('./leads').attempt(ws, r.admission_id, now);
  return { status: r.status, admission_id: r.admission_id, admission, plan: r.plan };
}

// What `leads auto-admission` and the review page show. Read only.
function statusView(ws, { now = Date.now() } = {}) {
  const L = require('./leads');
  const auth = authorityOf(ws, now);
  const p = plan(ws, { now });
  const mine = L.listAdmissions(ws).filter(isDelegated).sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
  return {
    version: VERSION,
    on: auth.on,
    code: auth.code,
    why: auth.why,
    values: auth.values,
    generation: auth.generation,
    authority: auth.authority ? { generation: auth.authority.generation, armed_at: auth.authority.armed_at, armed_by: auth.authority.armed_by, revoked_at: auth.authority.revoked_at || null, revoked_because: auth.authority.revoked_because || null } : null,
    plan: strip(p),
    admissions: mine.slice(0, 10).map((a) => ({ admission_id: a.admission_id, day: a.reservation && a.reservation.day, state: a.state, project_id: a.project_id || null, effects: a.effects, generation: a.authority && a.authority.generation, pipeline: pipelineOf(ws, a, now), words: a.words })),
  };
}

module.exports = { VERSION, AUTHORITY_VERSION, ACTOR, ROUTE, DAILY_MAX, DAILY_DEFAULT, MAX_DAYS, MAX_ACTIVE, HEADROOM, MIN_SESSIONS, FIELDS, valuesOf, policySha, liveOf, validatePatch, authorityNext, authorityOf, budgetHolds, isDelegated, pipelineOf, candidateOf, plan, reserve, sweep, statusView };
