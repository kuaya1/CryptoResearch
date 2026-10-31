'use strict';
// Scout leads (intake plan rev. 2, audits/2026-10-29-intake-dialectic/PLAN.md
// §3): tokens Grok names in a fifth call of its daily sweep, delivered to the
// online desk's front door with the desk's ingest key and kept on its disk
// under scout/leads/. Stage A only: a delivery is checked as an envelope (any
// fault refuses it whole, nothing saved) and row by row (a bad row is
// recorded as refused at intake, the others go on), kept create-only, and
// acknowledged once it is on disk. A lead is identified by its chain and
// contract only, never a name or ticker. What Grok sends is web content: the
// signal and addresses are data, never an instruction, and never enter a
// prompt. Nothing here starts research, opens a ticket or asks a provider.
//
// Records (all in one verified save, backed up with scout/):
//   scout/leads/deliveries/<source>-<delivery_id>.json  create-only
//   scout/leads/assets/<asset_id>.json                  one per asset; its
//     identity is hashed again on every read and must name its file (B3)
//   scout/leads/index.json                               the deliveries, for
//     the daily count and the list

const { runOp, OpError } = require('./ops');
const { readJson, sha256 } = require('./fsx');
const { stableStringify } = require('./requests');
const chains = require('./chains');
const scout = require('./scout');
const { acquireLease, releaseLease } = require('./leases');
const { randomId, compactTs } = require('./ids');
const fs = require('fs');

const LEADS_SCHEMA = 'cr.scout-leads.v1';
const LEADS_PROMPT = 'cr-scout-leads-prompt@1';
const DELIVERY_SCHEMA = 'cr.scout-leads-delivery.v1';
const ASSET_SCHEMA = 'cr.scout-lead-asset.v1';
const INDEX_SCHEMA = 'cr.scout-leads-index.v1';
const LEADS_PATH = '/api/ingest/scout-leads';
const DIR = 'scout/leads';
const DELIVERIES = `${DIR}/deliveries`;
const ASSETS = `${DIR}/assets`;
const INDEX = `${DIR}/index.json`;
// The key's principal: who sent a delivery, never read from the body.
const SOURCE = 'grok-scout';
const MAX_LEADS_PER_DAY = 6;
const LIMITS = { leads: 10, signal: 280, urls: 5, url: 300, body: 64 * 1024, skew_ms: 24 * 3600000 };
const ENVELOPE_FIELDS = ['schema', 'prompt_version', 'delivery_id', 'generated_at', 'model', 'leads'];
const ROW_FIELDS = ['chain', 'contract', 'coingecko_id', 'signal', 'urls'];
const DELIVERY_ID = /^[a-z0-9-]{8,64}$/;
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const CG_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;
// Native coins are out of scope (D9): the placeholder addresses wallets and
// aggregators use for them are refused as a row.
const NATIVE = new Set(['0x0000000000000000000000000000000000000000', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '11111111111111111111111111111111']);
const SHAPES = { evm: 'an EVM address, 0x and 40 hex digits', tron: 'a Tron address, T and 33 base58 characters', solana: 'a Solana address, 32 to 44 base58 characters' };

// An OpError with the HTTP status the routes answer it with.
const opErr = (code, message, status, details) => Object.assign(new OpError(code, message, details), { status });
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

// The asset ID of an identity tuple (B3): hex, so a filesystem that ignores
// case never folds two base58 addresses into one file.
function assetId({ chain_id, address_key }) {
  return sha256(stableStringify([String(chain_id), String(address_key)])).slice(0, 32);
}

// The identity of a chain name and an address, or null when either is not
// one the desk knows. The address is kept as written.
function identityOf(chain, address) {
  const info = chains.chainInfo(chain);
  if (!info || typeof address !== 'string') return null;
  const a = address.trim();
  if (!chains.addressFits(info.family, a)) return null;
  return { chain_id: info.chain_id, chain_label: info.label, family: info.family, address: a, address_key: chains.addressKey(info.family, a) };
}

// A stored asset, checked: its identity must be a known chain's, fit its
// family, key the same way and hash to the file's name. Anything else is
// INTEGRITY (409) and the record is not returned.
function checkAsset(rec, id) {
  const i = isObj(rec) ? rec.identity : null;
  const again = i ? identityOf(i.chain_id, i.address) : null;
  const ok = again && rec.asset_id === id && again.chain_id === i.chain_id && again.family === i.family && again.address_key === i.address_key && assetId(again) === id;
  if (!ok) throw opErr('INTEGRITY', `The lead record ${id} does not match its identity; it is not shown.`, 409, { asset_id: id });
  return rec;
}
function getAsset(ws, id) {
  if (!/^[0-9a-f]{32}$/.test(String(id))) throw opErr('NOT_FOUND', 'No such lead.', 404);
  const rec = readJson(ws.abs(`${ASSETS}/${id}.json`), null);
  if (!rec) throw opErr('NOT_FOUND', `No lead ${id}.`, 404);
  return checkAsset(rec, id);
}

// The envelope, checked as a whole: { envelope, errors }.
function checkEnvelope(body, now) {
  const errors = [];
  if (!isObj(body)) return { envelope: null, errors: ['the delivery must be a JSON object'] };
  for (const k of Object.keys(body)) if (!ENVELOPE_FIELDS.includes(k)) errors.push(`${String(k).slice(0, 40)}: not a field of a leads delivery`);
  if (body.schema !== LEADS_SCHEMA) errors.push(`schema: must be ${LEADS_SCHEMA}`);
  if (body.prompt_version !== LEADS_PROMPT) errors.push(`prompt_version: must be ${LEADS_PROMPT}`);
  if (typeof body.delivery_id !== 'string' || !DELIVERY_ID.test(body.delivery_id)) errors.push('delivery_id: must be 8 to 64 lowercase letters, digits or hyphens');
  const g = body.generated_at;
  if (typeof g !== 'string' || !Number.isFinite(Date.parse(g))) errors.push('generated_at: not a date and time');
  else if (!UTC_TIME.test(g)) errors.push('generated_at: must be UTC (ending in Z)');
  else if (Math.abs(Date.parse(g) - now) > LIMITS.skew_ms) errors.push('generated_at: more than 24 hours from the time received');
  if (typeof body.model !== 'string' || !/^grok-[a-z0-9][a-z0-9.-]{0,40}$/.test(body.model)) errors.push('model: must be a Grok model name');
  if (!Array.isArray(body.leads) || body.leads.length < 1 || body.leads.length > LIMITS.leads) errors.push(`leads: must be a list of 1 to ${LIMITS.leads}`);
  return { envelope: errors.length ? null : body, errors };
}

// One row, checked on its own: { identity, fields, reasons }. Never throws.
function checkRow(raw) {
  const reasons = [];
  if (!isObj(raw)) return { identity: null, fields: null, reasons: ['the lead must be an object'] };
  for (const k of Object.keys(raw)) if (!ROW_FIELDS.includes(k)) reasons.push(`${String(k).slice(0, 40)}: not a field of a lead`);
  const info = chains.chainInfo(raw.chain);
  let identity = null;
  if (!info) reasons.push(`chain: "${String(raw.chain).slice(0, 40)}" is not a chain the desk knows`);
  else if (typeof raw.contract !== 'string' || !chains.addressFits(info.family, raw.contract)) reasons.push(`contract: does not fit ${String(raw.chain).trim().toLowerCase()} (${SHAPES[info.family]})`);
  else {
    identity = identityOf(raw.chain, raw.contract);
    if (NATIVE.has(identity.address_key.toLowerCase())) {
      reasons.push('contract: a native coin\'s placeholder address; native coins are not leads');
      identity = null;
    }
  }
  const cg = raw.coingecko_id;
  if (!(cg === null || cg === undefined || (typeof cg === 'string' && CG_ID.test(cg)))) reasons.push('coingecko_id: must be null or a CoinGecko ID (lowercase letters, digits and hyphens)');
  const signal = scout.plainLine(raw.signal, 'signal', LIMITS.signal, reasons);
  let urls = [];
  if (raw.urls !== undefined && raw.urls !== null) {
    if (!Array.isArray(raw.urls)) reasons.push('urls: must be a list');
    else if (raw.urls.length > LIMITS.urls) reasons.push(`urls: at most ${LIMITS.urls}`);
    else urls = raw.urls.map((u, i) => scout.httpsUrl(u, `urls[${i}]`, reasons));
  }
  if (reasons.length) return { identity: null, fields: null, reasons };
  return { identity, fields: { coingecko_id: cg || null, signal, urls }, reasons };
}

function indexOf(v) {
  return { schema_version: INDEX_SCHEMA, deliveries: isObj(v) && Array.isArray(v.deliveries) ? v.deliveries : [] };
}
const deliveryRel = (source, id) => `${DELIVERIES}/${source}-${id}.json`;
const receiptIdOf = (source, id) => `ld_${sha256(stableStringify([source, id])).slice(0, 14)}`;
const answerOf = (rec) => ({ delivery_id: rec.delivery_id, receipt_id: rec.receipt_id, payload_sha256: rec.payload_sha256, rows: rec.rows.map(({ index, lead_key, outcome, reasons }) => ({ index, lead_key, outcome, reasons })) });

// Saves one delivery: the delivery create-only, each new asset, a sighting on
// each asset seen before, and the index, in one verified save. The same
// delivery again is `unchanged` with its first receipt (looked up before the
// daily count); the same ID with another body is CONFLICT.
function ingest(ws, body, { now = Date.now(), source = SOURCE, raw = null } = {}) {
  const { envelope, errors } = checkEnvelope(body, now);
  if (errors.length) throw new OpError('INVALID', `The delivery was refused (${errors.length} ${errors.length === 1 ? 'problem' : 'problems'}); nothing was saved.`, { errors });
  const payloadSha = sha256(stableStringify(envelope));
  const rawSha = sha256(raw === null ? JSON.stringify(body) : raw);
  const at = new Date(now).toISOString();
  const id = envelope.delivery_id;
  const rel = deliveryRel(source, id);
  const out = runOp(ws, { type: 'scout_leads', summary: `Scout leads ${id}: ${envelope.leads.length} rows` }, (op) => {
    const prior = op.readJson(rel, null);
    if (prior) {
      if (prior.payload_sha256 === payloadSha) return { status: 'unchanged', ...answerOf(prior) };
      throw opErr('CONFLICT', `Delivery ${id} was already received with different content; the first is kept and nothing was saved.`, 409, { receipt_id: prior.receipt_id });
    }
    const idx = indexOf(op.readJson(INDEX, null));
    if (idx.deliveries.filter((x) => String(x.received_at || '').slice(0, 10) === dayOf(now)).length >= MAX_LEADS_PER_DAY) {
      throw new OpError('DAILY_LIMIT', `This desk takes at most ${MAX_LEADS_PER_DAY} lead deliveries a day (UTC); nothing was saved.`);
    }
    const receiptId = receiptIdOf(source, id);
    const seen = new Map();
    const rows = envelope.leads.map((rawRow, index) => {
      const { identity, fields, reasons } = checkRow(rawRow);
      if (!identity) return { index, lead_key: null, outcome: 'refused_at_intake', reasons };
      const key = assetId(identity);
      if (seen.has(key)) return { index, lead_key: key, outcome: 'refused_at_intake', reasons: [`duplicate of row ${seen.get(key)}`] };
      seen.set(key, index);
      const sighting = { delivery_id: id, receipt_id: receiptId, source, row: index, seen_at: at, declared_model: envelope.model, coingecko_id: fields.coingecko_id, signal: fields.signal, urls: fields.urls };
      const arel = `${ASSETS}/${key}.json`;
      const was = op.readJson(arel, null);
      if (was) {
        try {
          checkAsset(was, key);
        } catch (err) {
          return { index, lead_key: key, outcome: 'integrity_hold', reasons: [err.message] };
        }
        op.writeJson(arel, { ...was, sightings: [...(Array.isArray(was.sightings) ? was.sightings : []), sighting] });
        return { index, lead_key: key, outcome: 'sighting', reasons: [] };
      }
      op.writeJson(arel, {
        schema_version: ASSET_SCHEMA,
        asset_id: key,
        identity,
        identity_revision: 1,
        created_at: at,
        state: 'NEW',
        revision: 1,
        next_attempt_at: null,
        claim: null,
        eligibility: null,
        admission: null,
        dismissal: null,
        sightings: [sighting],
      }, { mode: 'create' });
      return { index, lead_key: key, outcome: 'new', reasons: [] };
    });
    const rec = {
      schema_version: DELIVERY_SCHEMA,
      receipt_id: receiptId,
      source,
      delivery_id: id,
      received_at: at,
      generated_at: envelope.generated_at,
      prompt_version: envelope.prompt_version,
      model: { declared: envelope.model, basis: 'declared by the sender' },
      raw_sha256: rawSha,
      payload_sha256: payloadSha,
      rows: rows.map((r) => ({ ...r, chain: isObj(envelope.leads[r.index]) ? envelope.leads[r.index].chain ?? null : null, contract: isObj(envelope.leads[r.index]) ? envelope.leads[r.index].contract ?? null : null })),
    };
    op.writeJson(rel, rec, { mode: 'create' });
    op.writeJson(INDEX, { schema_version: INDEX_SCHEMA, deliveries: [...idx.deliveries, { source, delivery_id: id, receipt_id: receiptId, received_at: at, rows: rows.length, new: rows.filter((r) => r.outcome === 'new').length, refused: rows.filter((r) => r.outcome === 'refused_at_intake').length }] });
    return { status: 'accepted', ...answerOf(rec) };
  });
  // Acknowledged only once it reads back as saved.
  const back = readJson(ws.abs(rel), null);
  if (!out.verified || !back || back.payload_sha256 !== payloadSha) throw new OpError('NOT_SAVED', `Delivery ${id} did not read back as saved; send it again with the same delivery_id.`);
  return { ...out.result, verified: out.verified };
}

// A delivery's stored outcome. Writes nothing.
function status(ws, source, id) {
  if (typeof id !== 'string' || !DELIVERY_ID.test(id)) throw opErr('NOT_FOUND', 'No such delivery.', 404);
  const rec = readJson(ws.abs(deliveryRel(source, id)), null);
  if (!rec) throw opErr('NOT_FOUND', `No delivery ${id}.`, 404);
  return { status: 'stored', source: rec.source, received_at: rec.received_at, generated_at: rec.generated_at, model: rec.model, ...answerOf(rec) };
}

function leadsToday(ws, now = Date.now()) {
  return indexOf(readJson(ws.abs(INDEX), null)).deliveries.filter((x) => String(x.received_at || '').slice(0, 10) === dayOf(now)).length;
}

// Every asset as the desk holds it; one that fails its check is named by ID
// only. Reading writes nothing.
function assets(ws) {
  const fs = require('fs');
  const dir = ws.abs(ASSETS);
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^[0-9a-f]{32}\.json$/.test(f)).sort() : [];
  return names.map((f) => {
    const id = f.slice(0, 32);
    try {
      return getAsset(ws, id);
    } catch (err) {
      if (err.code === 'INTEGRITY' || err.code === 'NOT_FOUND') return { asset_id: id, integrity: 'failed' };
      throw err;
    }
  });
}

function view(ws, { now = Date.now() } = {}) {
  const list = assets(ws).map((a) => (a.integrity ? a : {
    asset_id: a.asset_id,
    identity: a.identity,
    state: a.state,
    revision: a.revision,
    next_attempt_at: a.next_attempt_at,
    sightings: a.sightings.length,
    first_seen: a.sightings[0] ? a.sightings[0].seen_at : null,
    last_seen: a.sightings.length ? a.sightings[a.sightings.length - 1].seen_at : null,
    last_signal: a.sightings.length ? a.sightings[a.sightings.length - 1].signal : null,
  }));
  return { schema_version: 'cr.scout-leads-view.v1', deliveries: indexOf(readJson(ws.abs(INDEX), null)).deliveries.length, leads_today: leadsToday(ws, now), max_per_day: MAX_LEADS_PER_DAY, assets: list };
}

// ---------------------------------------------------------------------------
// Stage B: eligibility (§4), cr-lead-eligibility@1. A bounded worker, job
// `leads` on the server's 30-minute timer and `cli scout leads run`, under its
// own cross-process lease. One turn: claim at most five due assets under the
// lock; one network phase with at most ten requests and twenty seconds on a
// monotonic clock, shared by every request, token, retry and body read; then
// commit under the lock only where the claim still stands. Deterministic: no
// model is called. ELIGIBLE means only "may be shown to Eric for
// confirmation", never safe, attractive or approved. A missing fact is
// unknown, never a pass; a zero is a known value.

const ELIGIBILITY_VERSION = 'cr-lead-eligibility@1';
const POLICY_VERSION = 'cr-lead-policy@1';
const RECEIPT_SCHEMA = 'cr.lead-eligibility.v1';
const ELIGIBILITY = `${DIR}/eligibility`;
const LEASE = 'leads';
const LEASE_MS = 5 * 60000;
const TURN_ASSETS = 5;
const TURN_REQUESTS = 10;
const TURN_MS = 20000;
const CLAIM_STALE_MS = 10 * 60000;
const RETRY_FAILED_MS = 30 * 60000;
const BUDGET_RETRY_MS = 24 * 3600000;
const STATES = ['NEW', 'ELIGIBLE', 'REFUSED', 'KNOWN', 'POLICY_HOLD', 'RETRY_AT', 'NEEDS_REVIEW', 'INCOMPLETE', 'DISMISSED', 'ADMITTED'];
const TERMINAL = new Set(['KNOWN', 'DISMISSED', 'ADMITTED']);
// Eric's values (Preferences > Screening > Scout leads; server.js
// validateSettingsPatch keeps the same bounds). None has a default.
const POLICY_FIELDS = ['enabled', 'chains', 'min_market_cap_usd', 'min_volume_24h_usd', 'max_sell_tax_pct', 'eligibility_hours'];
const POLICY_BOUNDS = {
  chains: { min: 1, max: 40 },
  min_market_cap_usd: { min: 0, max: 1e12, whole: true },
  min_volume_24h_usd: { min: 0, max: 1e12, whole: true },
  max_sell_tax_pct: { min: 0, max: 100, decimals: 2 },
  eligibility_hours: { min: 1, max: 720, whole: true },
};
const POLICY_WORDS = { chains: 'the chains leads may come from', min_market_cap_usd: 'minimum market cap', min_volume_24h_usd: 'minimum 24-hour volume', max_sell_tax_pct: 'maximum sell tax', eligibility_hours: 'how long an eligibility reading lasts' };
// CoinGecko's asset platform for each chain the desk reads leads on. A chain
// without one is not checkable here and is said so, never guessed.
const CG_PLATFORM = Object.freeze({ 1: 'ethereum', 56: 'binance-smart-chain', 42161: 'arbitrum-one', 137: 'polygon-pos', 8453: 'base', 10: 'optimistic-ethereum', 43114: 'avalanche', 59144: 'linea', 130: 'unichain', 146: 'sonic', tron: 'tron', solana: 'solana' });

const isoOf = (ms) => new Date(ms).toISOString();
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const usdOf = (v) => (v && typeof v === 'object' ? finite(v.usd) : finite(v));

// Eric's lead policy as the settings hold it now: its values (unset is null),
// what is missing, and the hash a receipt freezes.
function policyOf(ws) {
  const l = isObj(ws.settings && ws.settings.leads) ? ws.settings.leads : {};
  const ids = Array.isArray(l.chains) ? [...new Set(l.chains.map((c) => chains.chainInfo(c)).filter(Boolean).map((i) => i.chain_id))].sort() : [];
  const values = {
    enabled: l.enabled === true,
    chains: ids.length ? ids : null,
    min_market_cap_usd: finite(l.min_market_cap_usd),
    min_volume_24h_usd: finite(l.min_volume_24h_usd),
    max_sell_tax_pct: finite(l.max_sell_tax_pct),
    eligibility_hours: finite(l.eligibility_hours),
  };
  const missing = POLICY_FIELDS.filter((k) => k !== 'enabled' && values[k] === null);
  return { version: POLICY_VERSION, values, sha256: sha256(stableStringify(values)), missing };
}

// One bounded network phase (B4): `requests` requests and `ms` milliseconds,
// measured on a monotonic clock from its start; every request takes one
// before it is sent, every signal ends with the turn, and every body read
// ends at the deadline.
function makeTurn({ ms = TURN_MS, requests = TURN_REQUESTS } = {}) {
  const { performance } = require('perf_hooks');
  const start = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('the turn reached its deadline'), { name: 'AbortError' })), ms);
  if (timer.unref) timer.unref();
  let left = requests;
  const remaining = () => Math.max(0, ms - (performance.now() - start));
  const ended = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(Object.assign(new Error('the turn reached its deadline'), { name: 'AbortError' })), { once: true }));
  ended.catch(() => {});
  return {
    controller,
    signal: controller.signal,
    remaining,
    left: () => left,
    sent: () => requests - left,
    spent: () => left <= 0 || remaining() <= 0 || controller.signal.aborted,
    take() {
      if (left <= 0 || remaining() <= 0 || controller.signal.aborted) return false;
      left -= 1;
      return true;
    },
    // When the turn ends first, its own signal cuts the call, so the turn
    // reads as spent before anything else is tried; a separate timer for the
    // same moment could fire a hair earlier and let one more request out.
    signalFor: (perCallMs) => (perCallMs < remaining() ? AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, Math.floor(perCallMs)))]) : controller.signal),
    canWait: (waitMs) => remaining() > waitMs + 250,
    // An answer over its cap fails that request only, never the whole turn.
    readBody: (res, max) => Promise.race([require('./netguard').readBodyBounded(res, max, null), ended]),
    close: () => clearTimeout(timer),
  };
}

// The receipt's canonical hash: its JSON without the hash itself.
const receiptSha = (r) => sha256(stableStringify({ ...r, eligibility_sha256: undefined }));

function readReceipt(ws, id) {
  if (!/^le_[0-9TZ-]+_[a-z2-9]{6}$/.test(String(id))) return null;
  const r = readJson(ws.abs(`${ELIGIBILITY}/${id}.json`), null);
  return r && r.eligibility_sha256 === receiptSha(r) ? r : null;
}

// The project that already holds this contract, active or archived, by its
// identity's assets. Read only.
function knownProject(ws, identity) {
  for (const p of require('./projects').listProjects(ws)) {
    if (p.broken) continue;
    for (const a of (p.identity && Array.isArray(p.identity.assets) ? p.identity.assets : [])) {
      const info = a && chains.chainInfo(a.chain_id || a.chain);
      if (info && info.chain_id === identity.chain_id && typeof a.contract_address === 'string' && chains.addressKey(info.family, a.contract_address) === identity.address_key) return { project_id: p.project_id, status: p.status || 'active' };
    }
  }
  return null;
}

// Whether an asset is due now (one predicate, read only; §4's table). With
// the workspace, an ELIGIBLE asset whose receipt no longer stands under the
// rules in force (stillEligible) is due at once: a receipt kept from before
// a stronger rule is read again, never confirmed (audit F5, upgrade).
function dueOf(a, now, policy, ws = null) {
  if (!a || a.integrity || TERMINAL.has(a.state)) return false;
  if (a.claim && Number.isFinite(Date.parse(a.claim.claimed_at)) && now - Date.parse(a.claim.claimed_at) < CLAIM_STALE_MS) return false;
  const e = a.eligibility;
  const changed = !e || e.policy_sha256 !== policy.sha256;
  const at = (iso) => !iso || !Number.isFinite(Date.parse(iso)) || Date.parse(iso) <= now;
  switch (a.state) {
    case 'NEW': return true;
    case 'RETRY_AT': return at(a.next_attempt_at);
    case 'ELIGIBLE': return changed || at(e.expires_at) || Boolean(ws && !standingOf(ws, a, policy).stands);
    case 'REFUSED':
    case 'NEEDS_REVIEW':
    case 'INCOMPLETE': return changed || at(a.next_attempt_at);
    case 'POLICY_HOLD': return changed;
    default: return false;
  }
}

// The due assets, those a turn left first, then the oldest. Read only.
function dueAssets(ws, now = Date.now(), policy = policyOf(ws)) {
  if (!policy.values.enabled || require('./research').restoredHold(ws)) return [];
  const t = (a) => Date.parse(a.next_attempt_at || a.created_at) || 0;
  return assets(ws).filter((a) => dueOf(a, now, policy, ws)).sort((x, y) => (x.released_at ? 0 : 1) - (y.released_at ? 0 : 1) || t(x) - t(y) || String(x.asset_id).localeCompare(String(y.asset_id)));
}

// Whether the `leads` job has work: not a restored copy, and either an
// admission with a pending effect, or leads on, CoinGecko's and GoPlus's gates
// open, and an asset due.
function isDue(ws, now = Date.now()) {
  const policy = policyOf(ws);
  if (require('./research').restoredHold(ws)) return false;
  if (listAdmissions(ws).some((a) => pendingOf(a).length)) return true;
  if (!policy.values.enabled) return false;
  // Automatic admission's work asks no provider (lead-admission.js plan reads
  // only the records), so a closed provider gate never holds it back.
  if (require('./lead-admission').plan(ws, { now }).status === 'ready') return true;
  if (!require('./market').rateLimitGate(ws, now).open) return false;
  const screening = require('./screening');
  if (screening.blockedBy(screening.readStatus(ws), now)) return false;
  return dueAssets(ws, now, policy).length > 0;
}

// Under the lock: stamp each picked asset with this turn's claim.
function stampClaims(ws, opId, policy, now) {
  return runOp(ws, { type: 'scout_leads_claim', summary: `Scout leads turn ${opId}` }, (op) => {
    const picked = dueAssets(ws, now, policy).slice(0, TURN_ASSETS);
    return picked.map((a) => {
      const rel = `${ASSETS}/${a.asset_id}.json`;
      const cur = checkAsset(op.readJson(rel, null), a.asset_id);
      const revision = (Number(cur.revision) || 1) + 1;
      const claim = { op_id: opId, claimed_at: isoOf(now), revision };
      op.writeJson(rel, { ...cur, revision, claim });
      return { asset_id: a.asset_id, revision, asset: { ...cur, revision, claim } };
    });
  }).result;
}

// The coin's facts from CoinGecko's contract answer. Pure.
function listingFacts(body, platform) {
  const b = isObj(body) ? body : {};
  const md = isObj(b.market_data) ? b.market_data : {};
  const dp = isObj(b.detail_platforms) ? b.detail_platforms[platform] : null;
  const home = isObj(b.links) && Array.isArray(b.links.homepage) ? b.links.homepage.find((u) => typeof u === 'string' && /^https?:\/\/\S+$/.test(u.trim())) : null;
  return {
    coingecko_id: typeof b.id === 'string' ? b.id : null,
    name: typeof b.name === 'string' ? b.name.slice(0, 120) : null,
    symbol: typeof b.symbol === 'string' ? b.symbol.toUpperCase().slice(0, 20) : null,
    homepage: home ? home.trim().slice(0, 300) : null,
    image: isObj(b.image) && typeof b.image.small === 'string' ? b.image.small.slice(0, 300) : null,
    market_cap_usd: usdOf(md.market_cap),
    volume_24h_usd: usdOf(md.total_volume),
    platform_entry: isObj(dp),
    platform_contract: isObj(dp) && typeof dp.contract_address === 'string' ? dp.contract_address.trim() : null,
  };
}

// The screen's critical facts from GoPlus's normalized answer. Pure. A
// Solana token keeps its scheduled fee, its transfer hook and whether it can
// be transferred at all (audit F5): each decides what selling it costs.
function screenFacts(n, family) {
  const t = n.taxes || {};
  const k = n.checks || {};
  const tri = (x) => (x === 'present' || x === 'absent' ? x : 'unknown');
  return family === 'solana'
    ? { transfer_fee_pct: finite(t.transfer_fee_pct), transfer_fee_scheduled_max_pct: finite(t.transfer_fee_scheduled_max_pct), transfer_hook: tri(k.transfer_hook), non_transferable: tri(k.non_transferable), severe: n.severe || [], watch: n.watch || [] }
    : { sell_tax_pct: finite(t.sell_pct), buy_tax_pct: finite(t.buy_pct), honeypot: k.honeypot, cannot_sell_all: k.cannot_sell_all, severe: n.severe || [], watch: n.watch || [] };
}

// A Solana token's selling cost (forensics.js solanaTaxPct, the same rule):
// the higher of its transfer fee now and every scheduled fee, only when both
// are known; else null.
function solanaFeePct(f) {
  const now = finite(f.transfer_fee_pct);
  const scheduled = finite(f.transfer_fee_scheduled_max_pct);
  return now === null || scheduled === null ? null : Math.max(now, scheduled);
}

// The decision from the observations and the policy. Pure: { state, reasons,
// criteria }. Identity conflicts first, then a fact that fails a floor, then
// a fact that is missing, then eligible.
function judge(identity, sightings, observations, policy) {
  const v = policy.values;
  const reasons = { review: [], refuse: [], missing: [] };
  const criteria = [];
  const cg = observations.find((o) => o.source === 'coingecko');
  const gp = observations.find((o) => o.source === 'goplus');
  const platform = CG_PLATFORM[identity.chain_id];
  if (!cg || cg.outcome === 'not_listed') reasons.refuse.push(`CoinGecko does not list this contract on ${platform || identity.chain_label}`);
  else {
    const f = cg.facts;
    const supplied = [...(sightings || [])].reverse().map((s) => s.coingecko_id).find(Boolean) || null;
    if (!f.platform_entry) reasons.missing.push(`CoinGecko gave no detail_platforms entry for ${platform}`);
    else if (!f.platform_contract || chains.addressKey(identity.family, f.platform_contract) !== identity.address_key) reasons.review.push(`CoinGecko's listing names another contract on ${identity.chain_label}`);
    if (supplied && f.coingecko_id && supplied !== f.coingecko_id) reasons.review.push(`the scout named ${supplied}, but CoinGecko lists this contract as ${f.coingecko_id}`);
    if (!f.homepage) reasons.review.push('CoinGecko lists no homepage');
    for (const [key, label, min] of [['market_cap_usd', 'market cap', v.min_market_cap_usd], ['volume_24h_usd', '24-hour volume', v.min_volume_24h_usd]]) {
      const val = f[key];
      criteria.push({ name: key, value: val, limit: min, basis: val === null ? 'unknown' : 'known', pass: val === null ? null : val >= min });
      if (val === null) reasons.missing.push(`CoinGecko gave no ${label}`);
      else if (val < min) reasons.refuse.push(`${label} $${Math.round(val).toLocaleString('en-US')} is under your floor of $${min.toLocaleString('en-US')}`);
    }
  }
  if (!gp || gp.outcome === 'not_found') reasons.missing.push('GoPlus has no record of this contract');
  else {
    const f = gp.facts;
    const tax = (name, label, val) => {
      criteria.push({ name, value: val, limit: v.max_sell_tax_pct, basis: val === null ? 'unknown' : 'known', pass: val === null ? null : val <= v.max_sell_tax_pct });
      if (val === null) reasons.missing.push(`GoPlus gave no ${label}`);
      else if (val > v.max_sell_tax_pct) reasons.refuse.push(`${label} ${val}% is above your limit of ${v.max_sell_tax_pct}%`);
    };
    if (identity.family === 'solana') {
      // The fee now and the highest one scheduled; an unknown schedule is
      // missing, never a zero. A token that cannot be transferred never
      // passes; a transfer hook runs its own program on every transfer, so its
      // cost cannot be read here and Eric looks at it himself.
      const fee = solanaFeePct(f);
      criteria.push({ name: 'transfer_fee_pct', value: fee, limit: v.max_sell_tax_pct, basis: fee === null ? 'unknown' : 'known', pass: fee === null ? null : fee <= v.max_sell_tax_pct });
      if (fee === null) reasons.missing.push(finite(f.transfer_fee_pct) === null ? 'GoPlus gave no transfer fee' : 'GoPlus gave no complete schedule of transfer fees');
      else if (fee > v.max_sell_tax_pct) reasons.refuse.push(`transfer fee ${fee}% (the highest of the fee now and every scheduled fee) is above your limit of ${v.max_sell_tax_pct}%`);
      const nt = f.non_transferable || 'unknown';
      const hook = f.transfer_hook || 'unknown';
      criteria.push({ name: 'non_transferable', value: nt, basis: nt === 'unknown' ? 'unknown' : 'known', pass: nt === 'unknown' ? null : nt === 'absent' });
      criteria.push({ name: 'transfer_hook', value: hook, basis: hook === 'unknown' ? 'unknown' : 'known', pass: hook === 'unknown' ? null : hook === 'absent' });
      if (nt === 'present') reasons.refuse.push('GoPlus reads the token as not transferable');
      else if (nt === 'unknown') reasons.missing.push('GoPlus gave no transferability reading');
      if (hook === 'present') reasons.review.push('the token has a transfer hook: its own program runs on every transfer, so its cost to sell is not known');
      else if (hook === 'unknown') reasons.missing.push('GoPlus gave no transfer hook reading');
    } else {
      tax('sell_tax_pct', 'sell tax', f.sell_tax_pct);
      for (const [key, label] of [['honeypot', 'honeypot'], ['cannot_sell_all', 'cannot-sell-all']]) {
        criteria.push({ name: key, value: f[key], basis: f[key] === 'unknown' ? 'unknown' : 'known', pass: f[key] === 'unknown' ? null : f[key] === 'absent' });
        if (f[key] === 'unknown') reasons.missing.push(`GoPlus gave no ${label} reading`);
        else if (f[key] === 'present') reasons.refuse.push(key === 'honeypot' ? 'GoPlus reads it as a honeypot' : 'GoPlus reads that the whole balance cannot be sold');
      }
    }
  }
  if (reasons.review.length) return { state: 'NEEDS_REVIEW', reasons: reasons.review, criteria };
  if (reasons.refuse.length) return { state: 'REFUSED', reasons: reasons.refuse, criteria };
  if (reasons.missing.length) return { state: 'INCOMPLETE', reasons: reasons.missing, criteria };
  return { state: 'ELIGIBLE', reasons: [], criteria };
}

// The facts the rules in force read, by source and family. A stored reading
// that lacks any of them was made under an earlier fact set (before audit F5
// a Solana reading kept no scheduled fee, hook or transferability).
const FACT_KEYS = {
  coingecko: Object.keys(listingFacts({}, null)),
  goplus: { evm: Object.keys(screenFacts({}, 'evm')), solana: Object.keys(screenFacts({}, 'solana')) },
};
function factsCurrent(observations, family) {
  return (observations || []).every((o) => {
    if (!o || !o.facts) return true;
    const keys = o.source === 'coingecko' ? FACT_KEYS.coingecko : o.source === 'goplus' ? FACT_KEYS.goplus[family === 'solana' ? 'solana' : 'evm'] : null;
    return !keys || keys.every((k) => Object.prototype.hasOwnProperty.call(o.facts, k));
  });
}

// Whether an ELIGIBLE receipt still stands under the rules in force: its
// stored facts carry every fact those rules read and judge() over them still
// says ELIGIBLE. Pure: { stands } or { stands: false, state, reasons }. A
// receipt's hash proves it unchanged, never that its decision meets a rule
// made after it (audit F5, upgrade).
function stillEligible(receipt, asset, policy) {
  const j = judge(asset.identity, asset.sightings, receipt.observations, policy);
  if (j.state !== 'ELIGIBLE') return { stands: false, state: j.state, reasons: j.reasons };
  if (!factsCurrent(receipt.observations, asset.identity.family)) return { stands: false, state: 'INCOMPLETE', reasons: ['the reading was made before the desk read every fact it reads now'] };
  return { stands: true };
}

// The same for an ELIGIBLE asset's receipt on file; a receipt that cannot be
// read is left to rowCheck, which refuses it. Read only.
function standingOf(ws, a, policy) {
  const r = a.eligibility ? readReceipt(ws, a.eligibility.receipt_id) : null;
  return r && r.state === 'ELIGIBLE' ? stillEligible(r, a, policy) : { stands: true };
}

// One claimed asset through the network phase: a decision with its
// observations, or `released` when the turn ran out first. Never throws for a
// source's answer.
async function evaluate(ws, claim, { policy, turn, fetchImpl, clock, retryDelayMs }) {
  const a = claim.asset;
  const id = a.identity;
  const base = { asset_id: a.asset_id, revision: claim.revision };
  const decided = (state, reasons, extra = {}) => ({ ...base, kind: 'receipt', state, reasons, observations: [], criteria: [], ...extra });
  const retry = (source, why, at, limited = false) => decided('RETRY_AT', [why], { retry: { source, at: isoOf(at), limited } });
  const known = knownProject(ws, id);
  if (known) return decided('KNOWN', [`project ${known.project_id} (${known.status}) already holds this contract`], { known_project_id: known.project_id });
  if (policy.missing.length) return decided('POLICY_HOLD', policy.missing.map((k) => `Held: ${POLICY_WORDS[k]} not set`));
  if (!policy.values.chains.includes(id.chain_id)) return decided('REFUSED', [`${id.chain_label} is not among the chains you allow for leads`]);
  // A changed policy re-reads the last observations while they are fresh,
  // with no request; a reading that lacks a fact the rules read now is never
  // reused as a complete one.
  const prev = a.eligibility ? readReceipt(ws, a.eligibility.receipt_id) : null;
  const hours = policy.values.eligibility_hours * 3600000;
  const now0 = clock();
  if (prev && prev.observations.length && prev.observations.every((o) => Date.parse(o.observed_at) + hours > now0) && prev.observations.some((o) => o.source === 'coingecko') && prev.observations.some((o) => o.source === 'goplus') && factsCurrent(prev.observations, id.family)) {
    const j = judge(id, a.sightings, prev.observations, policy);
    return { ...base, kind: 'receipt', ...j, observations: prev.observations, reused_from: prev.receipt_id };
  }
  const platform = CG_PLATFORM[id.chain_id];
  if (!platform) return decided('NEEDS_REVIEW', [`the desk has no CoinGecko platform for ${id.chain_label}, so the listing cannot be matched here`]);
  if (turn.spent()) return { ...base, kind: 'released' };
  const observations = [];
  // CoinGecko: the contract on its platform, no retry, within the turn.
  const market = require('./market');
  const gate = market.rateLimitGate(ws, now0);
  if (!gate.open) return retry('coingecko', `Retry at ${gate.until} (CoinGecko rate limit)`, Date.parse(gate.until), true);
  const address = id.family === 'evm' ? id.address_key : id.address;
  const cgPath = `/coins/${encodeURIComponent(platform)}/contract/${encodeURIComponent(address)}`;
  const sentAt = clock();
  let body;
  let bodySha = null;
  const cgTurn = { ...turn, readBody: async (res, max) => { const t = await turn.readBody(res, max); bodySha = sha256(t); return t; } };
  try {
    body = await require('./intake').cgGet(ws, cgPath, fetchImpl, { retries: 0, maxWaitMs: 0, turn: cgTurn });
  } catch (err) {
    if (err.code === 'TURN_SPENT' || turn.spent()) return { ...base, kind: 'released' };
    if (err.code === 'REFUSED') return retry('coingecko', 'CoinGecko\'s monthly call budget is used up', sentAt + BUDGET_RETRY_MS);
    const at = err.details && err.details.retry_at ? Date.parse(err.details.retry_at) : NaN;
    if (Number.isFinite(at)) return retry('coingecko', `Retry at ${isoOf(at)} (CoinGecko rate limit)`, at, true);
    return retry('coingecko', `CoinGecko could not be read (${String(err.message).slice(0, 120)})`, clock() + RETRY_FAILED_MS);
  }
  observations.push({ source: 'coingecko', method: `GET ${cgPath}`, observed_at: isoOf(sentAt), answer_sha256: bodySha, outcome: body === null ? 'not_listed' : 'ok', facts: body === null ? null : listingFacts(body, platform) });
  if (body === null) return { ...base, kind: 'receipt', ...judge(id, a.sightings, observations, policy), observations };
  // GoPlus: one address, sharing screening's lease, gate, budget and token.
  if (turn.spent()) return { ...base, kind: 'released' };
  const gpAt = clock();
  const g = await require('./screening').screenAddress(ws, id.chain_id, id.address, { turn, fetchImpl, now: gpAt, retryDelayMs });
  if (g.kind === 'turn' || (g.kind === 'failed' && turn.spent())) return { ...base, kind: 'released' };
  if (g.kind === 'rate_limited' || g.kind === 'blocked') return retry('goplus', `Retry at ${g.retry_at} (GoPlus ${g.kind === 'rate_limited' ? 'rate limit' : 'backoff'})`, Date.parse(g.retry_at) || clock() + RETRY_FAILED_MS, true);
  if (g.kind === 'busy') return { ...base, kind: 'released' };
  if (g.kind === 'budget') return retry('goplus', 'GoPlus\'s monthly request budget is used up', gpAt + BUDGET_RETRY_MS);
  if (g.kind === 'failed' || g.kind === 'refused' || g.kind === 'unscreenable') return retry('goplus', `GoPlus could not be read (${String(g.error).slice(0, 120)})`, clock() + RETRY_FAILED_MS);
  observations.push({ source: 'goplus', method: `GET ${g.endpoint ? new URL(g.endpoint).pathname : 'token_security'}`, observed_at: isoOf(gpAt), answer_sha256: g.raw_sha256, outcome: g.kind, facts: g.kind === 'ok' ? screenFacts(g.normalized, id.family) : null });
  return { ...base, kind: 'receipt', ...judge(id, a.sightings, observations, policy), observations };
}

// The receipt's expiry: the earliest send time among its observations plus
// the eligibility duration (the desk's own clock only), else the decision
// time plus it; null when it cannot be computed.
function expiryOf(observations, decidedAt, policy) {
  const hours = policy.values.eligibility_hours;
  if (!hours) return null;
  const times = observations.map((o) => Date.parse(o.observed_at));
  if (times.some((x) => !Number.isFinite(x))) return null;
  const from = times.length ? Math.min(...times) : decidedAt;
  return isoOf(from + hours * 3600000);
}

// Under the lock: each decision whose claim still stands becomes a receipt
// and the asset's new state; a released asset goes back with next attempt
// now; a stale claim writes nothing.
function commit(ws, opId, outcomes, policy, now) {
  return runOp(ws, { type: 'scout_leads_eligibility', summary: `Scout leads turn ${opId}: ${outcomes.length} assets` }, (op) => outcomes.map((o) => {
    const rel = `${ASSETS}/${o.asset_id}.json`;
    let cur;
    try {
      cur = checkAsset(op.readJson(rel, null), o.asset_id);
    } catch (_) {
      return { asset_id: o.asset_id, result: 'dropped', why: 'integrity' };
    }
    if (!cur.claim || cur.claim.op_id !== opId || Number(cur.revision) !== o.revision) return { asset_id: o.asset_id, result: 'dropped', why: 'the asset changed during the turn' };
    const revision = o.revision + 1;
    if (o.kind === 'released') {
      op.writeJson(rel, { ...cur, revision, claim: null, next_attempt_at: isoOf(now), released_at: isoOf(now), release_reason: 'this turn\'s request budget was used' });
      return { asset_id: o.asset_id, result: 'released' };
    }
    let state = o.state;
    let reasons = o.reasons;
    let expires = expiryOf(o.observations, now, policy);
    if (state === 'ELIGIBLE' && !expires) {
      state = 'INCOMPLETE';
      reasons = ['the reading\'s expiry could not be computed from the desk\'s send times'];
    }
    if (state === 'POLICY_HOLD' || state === 'KNOWN') expires = null;
    const receiptId = `le_${compactTs(new Date(now))}_${randomId(6)}`;
    const receipt = {
      schema_version: RECEIPT_SCHEMA,
      version: ELIGIBILITY_VERSION,
      receipt_id: receiptId,
      asset_id: o.asset_id,
      identity: cur.identity,
      identity_revision: cur.identity_revision,
      asset_revision: revision,
      turn: opId,
      decided_at: isoOf(now),
      state,
      reasons,
      criteria: o.criteria,
      observations: o.observations,
      reused_from: o.reused_from || null,
      retry: o.retry || null,
      known_project_id: o.known_project_id || null,
      policy: { version: policy.version, values: policy.values, sha256: policy.sha256 },
      expires_at: expires,
      words: 'Listing matched; on-chain deployment not independently checked.',
    };
    receipt.eligibility_sha256 = receiptSha(receipt);
    op.writeJson(`${ELIGIBILITY}/${receiptId}.json`, receipt, { mode: 'create' });
    const next = state === 'RETRY_AT' ? o.retry.at : ['REFUSED', 'NEEDS_REVIEW', 'INCOMPLETE'].includes(state) ? expires : null;
    op.writeJson(rel, {
      ...cur,
      state,
      revision,
      claim: null,
      next_attempt_at: next,
      released_at: null,
      release_reason: null,
      eligibility: { receipt_id: receiptId, eligibility_sha256: receipt.eligibility_sha256, state, reasons, expires_at: expires, policy_sha256: policy.sha256, decided_at: isoOf(now) },
      known_project_id: o.known_project_id || cur.known_project_id || null,
    });
    return { asset_id: o.asset_id, result: 'receipt', state, receipt_id: receiptId };
  })).result;
}

// What automatic admission did this turn, in words; null while it is off.
function autoWords(auto) {
  if (!auto || auto.status === 'off') return null;
  if (auto.status === 'reserved' || auto.status === 'exists') return `automatic admission ${auto.admission_id}: ${(auto.admission && auto.admission.words) || (auto.admission && auto.admission.state) || 'reserved'}`;
  if (auto.status === 'idle') return null;
  return `automatic admission held (${auto.code}): ${auto.why}`;
}

// One turn of the `leads` job. Returns { status, message, ... }.
async function refresh(ws, { trigger = 'manual', fetchImpl = globalThis.fetch, clock = Date.now, turnMs = TURN_MS, maxRequests = TURN_REQUESTS, retryDelayMs = 1000 } = {}) {
  const policy = policyOf(ws);
  if (require('./research').restoredHold(ws)) return { status: 'held', message: 'Scout leads are held in this restored copy; no provider is asked.' };
  if (!policy.values.enabled && !listAdmissions(ws).some((a) => pendingOf(a).length)) return { status: 'skipped', message: 'Scout leads are off (Preferences > Screening > Scout leads).' };
  const lease = acquireLease(ws, LEASE, LEASE_MS, { label: trigger });
  if (!lease) return { status: 'busy', message: 'Another runner is reading scout leads right now.' };
  try {
    // Recovery first: every admission Eric confirmed with an effect still
    // pending is finished (or lapses), whether or not leads are on.
    const recovered = completePending(ws, { now: clock() });
    if (!policy.values.enabled) return { status: 'skipped', message: `Scout leads are off; ${recovered.length} confirmed ${recovered.length === 1 ? 'admission' : 'admissions'} finished.`, recovered };
    // While CoinGecko's or GoPlus's gate is closed no lead is read (the turn
    // would only meet it); automatic admission, which asks no provider, still
    // runs (lead-admission.js).
    const gateShut = !require('./market').rateLimitGate(ws, clock()).open || Boolean(require('./screening').blockedBy(require('./screening').readStatus(ws), clock()));
    const opId = `lt_${compactTs(new Date(clock()))}_${randomId(6)}`;
    const claimed = gateShut ? [] : stampClaims(ws, opId, policy, clock());
    if (!claimed.length) {
      const auto = require('./lead-admission').sweep(ws, { now: clock() });
      const admitted = auto.status === 'reserved' || auto.status === 'exists';
      const said = [recovered.length ? `${recovered.length} ${recovered.length === 1 ? 'admission' : 'admissions'} finished` : null, gateShut ? 'a provider\'s gate is closed, so no lead was read' : 'no scout lead is due', autoWords(auto)].filter(Boolean).join('; ');
      return { status: recovered.length || admitted ? 'ok' : 'noop', message: `${said.charAt(0).toUpperCase()}${said.slice(1)}.`, results: [], recovered, auto_admission: auto };
    }
    const turn = makeTurn({ ms: turnMs, requests: maxRequests });
    const outcomes = [];
    try {
      // A rate limit ends the phase: the assets not read yet go back for the
      // next turn, which waits for the gate.
      let limited = false;
      for (const c of claimed) {
        if (limited) { outcomes.push({ asset_id: c.asset_id, revision: c.revision, kind: 'released' }); continue; }
        const o = await evaluate(ws, c, { policy, turn, fetchImpl, clock, retryDelayMs });
        limited = Boolean(o.retry && o.retry.limited);
        outcomes.push(o);
      }
    } finally {
      turn.close();
    }
    const results = commit(ws, opId, outcomes, policy, clock());
    const by = (pred) => results.filter(pred).length;
    // Automatic admission after the network phase, on the records it wrote.
    const auto = require('./lead-admission').sweep(ws, { now: clock() });
    const message = `Scout leads: ${by((r) => r.result === 'receipt')} read (${STATES.map((s) => [s, by((r) => r.state === s)]).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(', ') || 'none'}), ${by((r) => r.result === 'released')} left for the next turn, ${turn.sent()} requests.${autoWords(auto) ? ` ${autoWords(auto).charAt(0).toUpperCase()}${autoWords(auto).slice(1)}.` : ''}`;
    return { status: by((r) => r.state === 'RETRY_AT' || r.result === 'released') ? 'partial' : 'ok', message, requests: turn.sent(), results, recovered, auto_admission: auto };
  } finally {
    releaseLease(ws, LEASE, lease);
  }
}

// A settings patch for leads (POST /api/settings `leads`), checked with the
// bounds policyOf reads: chains stored as chain IDs, null unsets a value.
// Throws INVALID naming the field; returns the values to save.
function validatePolicyPatch(p) {
  if (!isObj(p)) throw new OpError('INVALID', 'The scout lead settings must be an object');
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (!POLICY_FIELDS.includes(k)) throw new OpError('INVALID', `"${k}" is not a scout lead setting (${POLICY_FIELDS.join(', ')})`);
    if (k === 'enabled') {
      if (typeof v !== 'boolean') throw new OpError('INVALID', 'Scout leads on or off must be true or false');
      out.enabled = v;
      continue;
    }
    if (v === null) { out[k] = null; continue; }
    const b = POLICY_BOUNDS[k];
    if (k === 'chains') {
      if (!Array.isArray(v) || v.length < b.min || v.length > b.max) throw new OpError('INVALID', `Choose between ${b.min} and ${b.max} chains for leads`);
      const ids = [];
      for (const c of v) {
        const info = chains.chainInfo(c);
        if (!info) throw new OpError('INVALID', `"${String(c).slice(0, 40)}" is not a chain the desk knows`);
        if (!ids.includes(info.chain_id)) ids.push(info.chain_id);
      }
      out.chains = ids.sort();
      continue;
    }
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
    if (!Number.isFinite(n) || n < b.min || n > b.max) throw new OpError('INVALID', `${POLICY_WORDS[k]} must be a number from ${b.min} to ${b.max}`);
    if (b.whole && !Number.isInteger(n)) throw new OpError('INVALID', `${POLICY_WORDS[k]} must be a whole number`);
    if (b.decimals !== undefined && Math.round(n * 10 ** b.decimals) !== n * 10 ** b.decimals) throw new OpError('INVALID', `${POLICY_WORDS[k]} takes at most ${b.decimals} decimals`);
    out[k] = n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stage C: admission by Eric's click, "Confirm and request research" (§5).
// A confirm names the rows Eric reviewed and the evidence he saw (each row's
// receipt and hash, the policy, the envelope); inside one lock every row is
// compared with the records and any difference is 409 CHANGED with nothing
// written. Then the batch and one admission per row are written create-only,
// and each admission's effects (the intake record, the project, the research
// run) run after the lock, each under its own key, so a replay, Complete or
// the next `leads` turn finishes what a crash left with the original IDs. The
// scout's signal and URLs stay on the lead: they never enter a project's
// instructions, a prompt or a ticket.

const ADMISSION_SCHEMA = 'cr.scout-lead-admission.v1';
const BATCH_SCHEMA = 'cr.scout-lead-batch.v1';
const BATCHES = `${DIR}/batches`;
const ADMISSIONS = `${DIR}/admissions`;
const REQUEST_ID = /^req_[A-Za-z0-9_-]{4,80}$/;
const ADMISSION_ID = /^la_[0-9a-f]{14}$/;
const START_WINDOW_MS = 24 * 3600000;
const MAX_BATCH = 50;
const EFFECTS = ['intake', 'project', 'research'];
// An automatic admission (lead-admission.js) adds the pilot enrollment and
// the project's exit-quote target.
const DELEGATED_EFFECTS = ['intake', 'project', 'research', 'pilot'];
const isDelegated = (a) => Boolean(a && a.kind === 'delegated');
const effectsOf = (a) => (isDelegated(a) ? DELEGATED_EFFECTS : EFFECTS);
const PROVIDER_ORDER = ['claude', 'chatgpt', 'gemini'];
const LABELS = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };

const admissionIdOf = (requestId, leadKey) => `la_${sha256(stableStringify([requestId, leadKey])).slice(0, 14)}`;
const namesOf = (models) => models.map((p) => LABELS[p]).join(', ').replace(/, ([^,]*)$/, ' and $1');

// The models and routes a confirm would request now, and the spending limits
// in force. Read only; computed when the page draws and again in the lock.
function envelope(ws) {
  const research = require('./research');
  const held = research.heldProviders(ws);
  const st = research.providerStatus(ws);
  // Claude only (subtraction stage 5.1): a lead is researched by the spine,
  // and a configured API no longer adds a model by itself.
  const models = PROVIDER_ORDER.filter((p) => !held[p] && p === 'claude');
  return {
    models,
    routes: Object.fromEntries(models.map((p) => [p, research.routeOf(st[p])])),
    budget_scope: research.budgetScope(ws),
  };
}

function readAdmission(ws, id) {
  if (!ADMISSION_ID.test(String(id))) throw opErr('BAD_ID', 'Invalid admission ID.', 400);
  const a = readJson(ws.abs(`${ADMISSIONS}/${id}.json`), null);
  if (!a) throw opErr('NOT_FOUND', `No admission ${id}.`, 404);
  return a;
}

function listAdmissions(ws) {
  const dir = ws.abs(ADMISSIONS);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => ADMISSION_ID.test(f.slice(0, -5)) && f.endsWith('.json')).sort().map((f) => readJson(`${dir}/${f}`, null)).filter(Boolean);
}

// Effects still to do: pending, or failed and tried again (a replay, Complete
// or the next turn) until the start deadline.
const pendingOf = (a) => effectsOf(a).filter((e) => a.effects[e] === 'pending' || a.effects[e] === 'failed');

// The listing a receipt matched, as admitListing takes it.
function listingOf(asset, receipt) {
  const cg = receipt.observations.find((o) => o.source === 'coingecko' && o.facts);
  const f = cg ? cg.facts : {};
  return {
    coingecko_id: f.coingecko_id,
    name: f.name || f.coingecko_id,
    symbol: f.symbol || null,
    homepage: f.homepage || null,
    coingecko_url: `https://www.coingecko.com/en/coins/${encodeURIComponent(f.coingecko_id || '')}`,
    platforms: [{ chain: asset.identity.chain_id, address: asset.identity.address }],
    categories: [],
    observed_at: cg ? cg.observed_at : null,
  };
}

// One reviewed row against the records now, field by field: { fields, asset,
// receipt }, fields [] when it still stands. Read inside the confirm's lock.
// The receipt itself is bound too (audit F6): the one on file must be the one
// Eric reviewed and the asset pins, intact, for this asset and identity at
// this asset revision, ELIGIBLE under this policy and unexpired now. A new
// sighting changes no revision, so it is never a change here.
function rowCheck(ws, op, row, policy, now) {
  const out = [];
  let a;
  try {
    a = checkAsset(op.readJson(`${ASSETS}/${row.lead_key}.json`, null), row.lead_key);
  } catch (err) {
    return { fields: [{ field: 'lead', now: err.code === 'INTEGRITY' ? 'fails its identity check' : 'missing' }], asset: null, receipt: null };
  }
  if (a.state !== 'ELIGIBLE') out.push({ field: 'state', reviewed: 'ELIGIBLE', now: a.state });
  const e = a.eligibility || {};
  if (e.receipt_id !== row.eligibility_receipt_id) out.push({ field: 'eligibility_receipt_id', reviewed: row.eligibility_receipt_id, now: e.receipt_id || null });
  if (e.eligibility_sha256 !== row.eligibility_sha256) out.push({ field: 'eligibility_sha256', reviewed: row.eligibility_sha256, now: e.eligibility_sha256 || null });
  if (a.identity_revision !== row.identity_revision) out.push({ field: 'identity_revision', reviewed: row.identity_revision, now: a.identity_revision });
  if (a.revision !== row.asset_revision) out.push({ field: 'asset_revision', reviewed: row.asset_revision === undefined ? null : row.asset_revision, now: a.revision });
  if (!e.expires_at || !(Date.parse(e.expires_at) > now)) out.push({ field: 'expires_at', now: e.expires_at ? `expired at ${e.expires_at}` : 'not computed' });
  if (e.policy_sha256 && e.policy_sha256 !== policy.sha256) out.push({ field: 'receipt_policy', now: 'the receipt was decided under another policy' });
  const r = e.receipt_id ? readReceipt(ws, e.receipt_id) : null;
  if (!r) out.push({ field: 'eligibility_receipt', now: 'missing, or its content does not match its own hash' });
  else {
    if (r.receipt_id !== row.eligibility_receipt_id || r.eligibility_sha256 !== row.eligibility_sha256 || r.eligibility_sha256 !== e.eligibility_sha256) out.push({ field: 'eligibility_receipt', reviewed: row.eligibility_sha256, now: r.eligibility_sha256, words: 'the receipt on file is not the one you reviewed' });
    if (r.asset_id !== a.asset_id || stableStringify(r.identity) !== stableStringify(a.identity) || r.identity_revision !== a.identity_revision) out.push({ field: 'receipt_identity', now: 'the receipt names another asset or identity' });
    if (r.asset_revision !== a.revision) out.push({ field: 'receipt_asset_revision', reviewed: a.revision, now: r.asset_revision === undefined ? null : r.asset_revision });
    if (r.state !== 'ELIGIBLE') out.push({ field: 'receipt_state', reviewed: 'ELIGIBLE', now: r.state });
    if ((!r.policy || r.policy.version !== policy.version || r.policy.sha256 !== policy.sha256) && !out.some((x) => x.field === 'receipt_policy')) out.push({ field: 'receipt_policy', now: 'the receipt was decided under another policy' });
    if (!r.expires_at || !(Date.parse(r.expires_at) > now)) out.push({ field: 'receipt_expires_at', now: r.expires_at ? `expired at ${r.expires_at}` : 'not computed' });
    // Its stored facts judged again under the rules in force (audit F5,
    // upgrade): a receipt kept from before a stronger rule is read again by
    // the next turn, never confirmed.
    if (r.state === 'ELIGIBLE') {
      const s = stillEligible(r, a, policy);
      if (!s.stands) out.push({ field: 'eligibility_rule', reviewed: 'ELIGIBLE', now: s.state, reasons: s.reasons, words: 'this reading does not meet the eligibility rule in force; the lead is read again before it can be confirmed' });
    }
  }
  return { fields: out, asset: a, receipt: r };
}

// Eric's confirm. Returns { status: admitted | unchanged, batch, admissions,
// since_shown }; throws 409 CHANGED, CONFLICT or NO_MODEL with nothing
// written, 400 INVALID for a malformed request.
function confirmLeads(ws, body, { now = Date.now() } = {}) {
  const b = isObj(body) ? body : {};
  const requestId = b.request_id;
  const expect = b.expect;
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw opErr('INVALID', 'The request ID must look like req_ followed by 4 to 80 letters, digits, - or _.', 400);
  if (!isObj(expect) || !isObj(expect.policy) || !isObj(expect.envelope) || !Array.isArray(expect.rows)) throw opErr('INVALID', 'The confirm must name the policy, the envelope and the rows you reviewed.', 400);
  if (!expect.rows.length || expect.rows.length > MAX_BATCH) throw opErr('INVALID', `A confirm names 1 to ${MAX_BATCH} rows.`, 400);
  const keys = expect.rows.map((r) => (isObj(r) ? r.lead_key : null));
  if (keys.some((k) => typeof k !== 'string' || !/^[0-9a-f]{32}$/.test(k)) || new Set(keys).size !== keys.length) throw opErr('INVALID', 'Each row names one lead once.', 400);
  const expectSha = sha256(stableStringify(expect));
  const batchRel = `${BATCHES}/${requestId}.json`;
  const out = runOp(ws, { type: 'scout_leads_confirm', summary: `Confirm ${keys.length} scout ${keys.length === 1 ? 'lead' : 'leads'} (${requestId})` }, (op) => {
    const prior = op.readJson(batchRel, null);
    if (prior) {
      if (prior.expect_sha256 !== expectSha) throw opErr('CONFLICT', `Request ${requestId} was already confirmed with different rows or evidence; nothing was written. Use a new request for a different confirm.`, 409);
      return { replay: true, batch: prior };
    }
    // The lock's own clock decides expiry (a confirm may wait for the lock).
    const lockNow = Math.max(now, Date.now());
    const policy = policyOf(ws);
    const env = envelope(ws);
    if (!env.models.length) throw opErr('NO_MODEL', 'Every model is on hold: nothing to request. Nothing was written.', 409);
    const changed = { rows: [], policy: null, envelope: null };
    if (expect.policy.version !== policy.version || expect.policy.sha256 !== policy.sha256) changed.policy = { reviewed: expect.policy, now: { version: policy.version, sha256: policy.sha256 } };
    if (stableStringify(expect.envelope) !== stableStringify(env)) changed.envelope = { reviewed: expect.envelope, now: env };
    const checked = new Map();
    for (const row of expect.rows) {
      const c = rowCheck(ws, op, row, policy, lockNow);
      checked.set(row.lead_key, c);
      if (c.fields.length) changed.rows.push({ lead_key: row.lead_key, fields: c.fields });
    }
    const sinceShown = assets(ws).filter((a) => a.state === 'ELIGIBLE' && !keys.includes(a.asset_id)).length;
    if (changed.rows.length || changed.policy || changed.envelope) {
      const parts = [...(changed.policy ? ['the lead policy'] : []), ...(changed.envelope ? ['the models, routes or budget'] : []), ...(changed.rows.length ? [`${changed.rows.length} ${changed.rows.length === 1 ? 'row' : 'rows'}`] : [])];
      throw opErr('CHANGED', `Changed since you looked: ${parts.join(', ')}. Nothing was written; look again.`, 409, { ...changed, since_shown: { eligible_new: sinceShown } });
    }
    const at = isoOf(lockNow);
    const ids = [];
    for (const row of expect.rows) {
      const rel = `${ASSETS}/${row.lead_key}.json`;
      // The asset and the receipt exactly as checked above.
      const { asset: a, receipt } = checked.get(row.lead_key);
      const admissionId = admissionIdOf(requestId, row.lead_key);
      ids.push(admissionId);
      op.writeJson(`${ADMISSIONS}/${admissionId}.json`, withKeys({
        schema_version: ADMISSION_SCHEMA,
        admission_id: admissionId,
        request_id: requestId,
        lead_key: row.lead_key,
        identity: a.identity,
        identity_revision: a.identity_revision,
        eligibility_receipt_id: receipt.receipt_id,
        eligibility_sha256: receipt.eligibility_sha256,
        policy: { version: policy.version, sha256: policy.sha256 },
        envelope: env,
        listing: listingOf(a, receipt),
        deliveries: [...new Set(a.sightings.map((s) => s.delivery_id).filter(Boolean))],
        batch_size: expect.rows.length,
        created_at: at,
        start_deadline: isoOf(lockNow + START_WINDOW_MS),
        state: 'pending',
        effects: { intake: 'pending', project: 'pending', research: 'pending' },
        intake_id: null,
        project_id: null,
        project_basis: null,
        run_id: null,
        run_basis: null,
        errors: [],
        words: null,
      }), { mode: 'create' });
      op.writeJson(rel, { ...a, state: 'ADMITTED', revision: (Number(a.revision) || 1) + 1, claim: null, next_attempt_at: null, admission_id: admissionId });
    }
    const batch = { schema_version: BATCH_SCHEMA, request_id: requestId, created_at: at, expect, expect_sha256: expectSha, words: `Confirmed by Eric, a batch of ${ids.length}.`, admission_ids: ids, since_shown: { eligible_new: sinceShown } };
    op.writeJson(batchRel, batch, { mode: 'create' });
    return { replay: false, batch };
  });
  const { batch } = out.result;
  // The effects, after the lock, each admission on its own: one that fails
  // leaves the others to run, and the committed batch is always answered
  // (audit F3).
  const admissions = batch.admission_ids.map((id) => attempt(ws, id, now));
  const sinceShown = out.result.replay ? { eligible_new: assets(ws).filter((a) => a.state === 'ELIGIBLE' && !keys.includes(a.asset_id)).length } : batch.since_shown;
  return { status: out.result.replay ? 'unchanged' : 'admitted', batch: { request_id: batch.request_id, created_at: batch.created_at, admission_ids: batch.admission_ids }, admissions, since_shown: sinceShown, verified: out.verified };
}

// An automatic admission's record (lead-admission.js reserve, inside its
// lock): the same shape as a confirmed one, with no request ID and no batch,
// its actor, the admission settings and authority it was reserved under, the
// day's reservation and the pilot effect. Its effect keys are frozen as a
// confirmed admission's are.
function delegatedAdmission({ id, asset, receipt, listing, policy, lockNow, admission_policy, authority, reservation, envelope: env, capacity }) {
  return withKeys({
    schema_version: ADMISSION_SCHEMA,
    admission_id: id,
    kind: 'delegated',
    actor: require('./lead-admission').ACTOR,
    request_id: null,
    lead_key: asset.asset_id,
    identity: asset.identity,
    identity_revision: asset.identity_revision,
    eligibility_receipt_id: receipt.receipt_id,
    eligibility_sha256: receipt.eligibility_sha256,
    policy: { version: policy.version, sha256: policy.sha256 },
    admission_policy,
    authority,
    reservation,
    capacity,
    envelope: env,
    listing,
    deliveries: [...new Set(asset.sightings.map((s) => s.delivery_id).filter(Boolean))],
    batch_size: 1,
    created_at: isoOf(lockNow),
    start_deadline: isoOf(lockNow + START_WINDOW_MS),
    state: 'pending',
    effects: { intake: 'pending', project: 'pending', research: 'pending', pilot: 'pending' },
    intake_id: null,
    project_id: null,
    project_basis: null,
    run_id: null,
    run_basis: null,
    enrollment: null,
    errors: [],
    words: null,
  });
}

const summaryOf = (a) => ({ admission_id: a.admission_id, kind: isDelegated(a) ? 'delegated' : 'confirmed', lead_key: a.lead_key, state: a.state, project_id: a.project_id, project_basis: a.project_basis, run_id: a.run_id, run_basis: a.run_basis, effects: a.effects, errors: a.errors, words: a.words, ...(isDelegated(a) ? { actor: a.actor, generation: a.authority && a.authority.generation, reservation: a.reservation, enrollment: a.enrollment || null } : {}) });

// One admission's effects, never thrown: its record as stored, and when this
// try failed before it could be written down, that failure marked
// `recorded: false`, so nothing unsaved reads as saved. The admission stays
// pending and the next turn, a replay or Complete finishes it.
function attempt(ws, id, now) {
  try {
    return summaryOf(completeAdmission(ws, id, { now }));
  } catch (err) {
    const e = { at: isoOf(now), code: err.code || 'FAILED', words: String(err.message).slice(0, 400), recorded: false };
    let stored = null;
    try { stored = readAdmission(ws, id); } catch (_) { /* reported below */ }
    if (!stored) return { admission_id: id, lead_key: null, state: 'unknown', project_id: null, project_basis: null, run_id: null, run_basis: null, effects: null, errors: [e], words: `Not finished, and its record could not be read: ${e.words}` };
    return { ...summaryOf(stored), errors: [...stored.errors, e], words: `Not finished: ${e.words} (this try was not recorded; the next turn or Complete finishes it)` };
  }
}

// The words a scout admission writes on its project's evidence. An automatic
// one says what admitted it and that no person reviewed the lead; it never
// reads as Eric's confirmation.
function evidenceNote(a) {
  if (isDelegated(a)) {
    return `Listed by Grok Scout (delivery ${a.deliveries.join(', ') || 'unknown'}); contract matched on CoinGecko at ${a.listing.observed_at || 'an unrecorded time'}; eligible under ${ELIGIBILITY_VERSION} (receipt ${a.eligibility_receipt_id}, policy ${a.policy.version} ${a.policy.sha256.slice(0, 12)}); admitted automatically by ${a.actor} under ${a.admission_policy.version} generation ${a.authority.generation} (settings ${a.admission_policy.sha256.slice(0, 12)}, reservation ${a.reservation.reservation_id} for ${a.reservation.day}); no person reviewed this lead; research requested from ${namesOf(a.envelope.models)} through the pilot worker.`;
  }
  return `Listed by Grok Scout (delivery ${a.deliveries.join(', ') || 'unknown'}); contract matched on CoinGecko at ${a.listing.observed_at || 'an unrecorded time'}; eligible under ${ELIGIBILITY_VERSION} (receipt ${a.eligibility_receipt_id}, policy ${a.policy.version} ${a.policy.sha256.slice(0, 12)}); confirmed by Eric in a batch of ${a.batch_size} (request ${a.request_id}); research requested from ${namesOf(a.envelope.models)}.`;
}

function keyFor(a, effect, payload) {
  return { key: `admission:${a.admission_id}#${effect}`, payload_sha256: sha256(stableStringify(payload)) };
}

// The payload hashes of the three effects, frozen into the admission when it
// is written (audit F1): a replay compares against these, never against a
// payload read again. The run's binds the project it lands on to the frozen
// base (the models, their routes and the limits Eric confirmed).
function effectKeysOf(a) {
  return {
    intake_sha256: sha256(stableStringify(intakeDocOf(a))),
    project_sha256: sha256(stableStringify({ admission_id: a.admission_id, listing: a.listing, note: evidenceNote(a) })),
    research_base_sha256: sha256(stableStringify({ admission_id: a.admission_id, providers: a.envelope.models, routes: a.envelope.routes, budget_scope: a.envelope.budget_scope, horizon: null })),
    // An automatic admission's enrollment, by its actor and generation.
    ...(isDelegated(a) ? { pilot_sha256: sha256(stableStringify({ admission_id: a.admission_id, by: pilotByOf(a) })) } : {}),
  };
}
const pilotByOf = (a) => `${a.actor} g${a.authority.generation}`;
const withKeys = (a) => ({ ...a, effect_keys: effectKeysOf(a) });

// The effects' keys: from the frozen hashes, or for an admission written
// before they were frozen, as it derived them then.
function keysOf(a) {
  const k = a.effect_keys;
  if (!k) {
    return {
      intake: keyFor(a, 'intake', intakeDocOf(a)),
      project: keyFor(a, 'project', { admission_id: a.admission_id, listing: a.listing, note: evidenceNote(a) }),
      research: (projectId) => keyFor(a, 'research', { admission_id: a.admission_id, project_id: projectId, providers: a.envelope.models, horizon: null }),
    };
  }
  const key = (e) => `admission:${a.admission_id}#${e}`;
  return {
    intake: { key: key('intake'), payload_sha256: k.intake_sha256 },
    project: { key: key('project'), payload_sha256: k.project_sha256 },
    research: (projectId) => ({ key: key('research'), payload_sha256: sha256(stableStringify({ base: k.research_base_sha256, project_id: projectId })) }),
  };
}

// The admission's intake record, the same shape a research request has, so
// the existing Research requests list follows its run. Deterministic: its ID
// and content derive from the admission alone.
function intakeDocOf(a) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const h = sha256(a.admission_id);
  const tail = Array.from({ length: 5 }, (_, i) => alphabet[parseInt(h.slice(i * 2, i * 2 + 2), 16) % alphabet.length]).join('');
  const id = `in_${compactTs(new Date(a.created_at))}_${tail}`;
  if (isDelegated(a)) {
    return {
      schema_version: 'cr.intake.v1',
      intake_id: id,
      created_at: a.created_at,
      updated_at: a.created_at,
      via: 'scout-leads',
      fingerprint: sha256(stableStringify(['scout-lead', a.admission_id])),
      input: { link: a.listing.coingecko_url, parsed: null, link_problem: null, screenshot: null, instructions: null },
      status: 'admitting',
      identity: null,
      confirmed: null,
      scout_admission: { admission_id: a.admission_id, lead_key: a.lead_key, eligibility_receipt_id: a.eligibility_receipt_id, request_id: null, kind: 'delegated', actor: a.actor, generation: a.authority.generation, reservation_id: a.reservation.reservation_id },
      events: [{ at: a.created_at, what: `Scout lead admitted automatically (${a.actor}, generation ${a.authority.generation}); no person reviewed it. Adding the project.` }],
      note: `Research request from a scout lead admitted automatically under ${a.admission_policy.version} (reservation ${a.reservation.reservation_id} for ${a.reservation.day}). No person reviewed this lead. The scout's words stay on the lead; they are never instructions.`,
    };
  }
  return {
    schema_version: 'cr.intake.v1',
    intake_id: id,
    created_at: a.created_at,
    updated_at: a.created_at,
    via: 'scout-leads',
    fingerprint: sha256(stableStringify(['scout-lead', a.admission_id])),
    input: { link: a.listing.coingecko_url, parsed: null, link_problem: null, screenshot: null, instructions: null },
    status: 'admitting',
    identity: null,
    confirmed: null,
    scout_admission: { admission_id: a.admission_id, lead_key: a.lead_key, eligibility_receipt_id: a.eligibility_receipt_id, request_id: a.request_id },
    events: [{ at: a.created_at, what: 'Scout lead confirmed by Eric; adding the project.' }],
    note: 'Research request from a scout lead Eric confirmed. The scout\'s words stay on the lead; they are never instructions.',
  };
}

// Writes the admission (and, when given, the intake record) in one verified
// operation; `fn` changes the admission read inside the lock.
function updateAdmission(ws, id, summary, fn) {
  return runOp(ws, { type: 'scout_lead_admission', summary }, (op) => {
    const cur = op.readJson(`${ADMISSIONS}/${id}.json`, null);
    if (!cur) throw opErr('NOT_FOUND', `No admission ${id}.`, 404);
    const next = fn(cur, op);
    op.writeJson(`${ADMISSIONS}/${id}.json`, next);
    return next;
  }).result;
}

function stateOf(a) {
  const list = effectsOf(a);
  if (list.every((e) => a.effects[e] === 'done')) return 'complete';
  if (list.some((e) => a.effects[e] === 'stopped')) return 'stopped';
  if (list.some((e) => a.effects[e] === 'lapsed')) return 'lapsed';
  if (list.some((e) => a.effects[e] === 'needs_consent')) return 'needs_consent';
  if (list.some((e) => a.effects[e] === 'failed')) return 'failed';
  return 'pending';
}

// An automatic admission's authority before each further effect: the arming
// it was reserved under still in force (not paused, expired, revoked or
// re-armed with other settings), and its project, once there, not archived,
// not suspended by Eric's intervention and not taken off the pilot. Null when
// it holds, else the words. Reads only.
function delegatedGate(ws, a, now) {
  const LA = require('./lead-admission');
  const auth = LA.authorityOf(ws, now);
  if (!auth.on) return `automatic admission no longer holds: ${auth.why}`;
  const au = a.authority || {};
  if (auth.generation !== au.generation || auth.policy_sha256 !== au.policy_sha256) return `it was admitted under generation ${au.generation}; generation ${auth.generation} is in force now, and a new arming never resumes an earlier admission`;
  if (!a.project_id) return null;
  try {
    const p = require('./projects').getProject(ws, a.project_id);
    if (p.status === 'archived') return `project ${a.project_id} was archived`;
    const st = require('./mandate-authority').autonomyOf(ws, a.project_id, { project: p });
    if (st.suspended) return st.words || `autonomy on ${a.project_id} is suspended`;
    const prof = require('./tickets').readTicketProfile(ws, a.project_id);
    if (prof.pilot_set_at && prof.pilot !== true) return `${a.project_id} was taken off the pilot (${prof.pilot_set_by || 'unknown'} at ${prof.pilot_set_at})`;
  } catch (err) {
    return `project ${a.project_id} could not be read (${String((err && err.message) || err).slice(0, 160)})`;
  }
  return null;
}

// Before an automatic admission creates its project: none in the records may
// hold this contract, match it strongly or share its ticker.
function delegatedDuplicate(ws, a) {
  const known = knownProject(ws, a.identity);
  if (known) return `project ${known.project_id} (${known.status}) already holds this contract`;
  const dup = require('./projects').findDuplicates(ws, { name: a.listing.name, symbol: a.listing.symbol, official_website: a.listing.homepage, coingecko_id: a.listing.coingecko_id, assets: [{ chain: a.identity.chain_id, contract_address: a.identity.address }] });
  if (dup.strong.length) return `it matches ${dup.strong.map((x) => `${x.project_id} (${x.reasons.join(', ')})`).join('; ')} in the records`;
  if (dup.possible.length) return `another project trades as ${a.listing.symbol} (${dup.possible.map((x) => x.project_id).join(', ')}); tickers are not unique and Eric decides`;
  return null;
}

// Stops an automatic admission: what was done stays done, the effects not
// done are marked stopped and never start.
function stopAdmission(ws, a, why, now) {
  return updateAdmission(ws, a.admission_id, `Admission ${a.admission_id} stopped`, (cur) => {
    const effects = Object.fromEntries(effectsOf(cur).map((e) => [e, cur.effects[e] === 'done' ? 'done' : 'stopped']));
    return { ...cur, effects, state: 'stopped', stopped_at: isoOf(now), stopped_because: String(why).slice(0, 400), words: `${doneWords(cur)}; the rest was not started: ${String(why).slice(0, 400)}.` };
  });
}

function doneWords(cur) {
  const project = cur.effects.project !== 'done' ? 'Nothing was added' : cur.project_basis === 'existing' ? 'Linked to the project already in your records' : 'Project added';
  const research = cur.effects.research === 'done' ? `; research ${cur.run_basis === 'existing_recent' ? 'linked to a run started a few minutes earlier' : `requested from ${namesOf(cur.envelope.models)}${isDelegated(cur) ? ' through the pilot worker' : ''}`}` : '';
  const pilot = isDelegated(cur) && cur.effects.pilot === 'done' ? `; enrolled in the pilot (exit target ${(cur.enrollment && cur.enrollment.exit_quote && cur.enrollment.exit_quote.status) || 'unknown'})` : '';
  return `${project}${research}${pilot}`;
}

// An automatic admission's last effect: the pilot enrollment through
// tickets.setPilot (idempotent: a no-op when already on) by its actor, then
// the project's primary exit-quote target (approved or already kept is done;
// anything else is failed and tried again until the start deadline).
function pilotEffect(ws, id, a, now) {
  const by = pilotByOf(a);
  let enroll;
  let exit;
  try {
    enroll = require('./tickets').setPilot(ws, a.project_id, true, { by });
    exit = enroll.exit_quote || require('./forensics').approvePrimaryExitQuote(ws, a.project_id, { by: 'pilot enrollment' });
  } catch (err) {
    return failStep(ws, id, err, now, ['pilot']);
  }
  const ok = Boolean(exit && (exit.status === 'approved' || exit.status === 'kept'));
  const enrollment = { at: isoOf(now), by, enrolled: true, already: Boolean(enroll.result && enroll.result.noop), exit_quote: { status: exit ? exit.status : 'unknown', chain: (exit && exit.chain) || null, reason: (exit && exit.reason) || null } };
  return updateAdmission(ws, id, `Enroll ${a.project_id} for admission ${id}`, (cur) => ({
    ...cur,
    enrollment: cur.enrollment && cur.enrollment.enrolled && !ok ? { ...cur.enrollment, exit_quote: enrollment.exit_quote, tried_at: enrollment.at } : { ...enrollment, ...(cur.enrollment && cur.enrollment.at ? { at: cur.enrollment.at, already: cur.enrollment.already } : {}) },
    effects: { ...cur.effects, pilot: ok ? 'done' : 'failed' },
    errors: ok ? cur.errors : [...cur.errors, { at: isoOf(now), code: 'EXIT_TARGET', words: `Enrolled, but the exit-quote target was not approved (${enrollment.exit_quote.status}): ${enrollment.exit_quote.reason || 'no reason given'}` }].slice(-10),
  }));
}

const errorOf = (err, now) => ({ at: isoOf(now), code: err.code || 'FAILED', words: String(err.message).slice(0, 400) });
// The project's basis as its key recorded it: linked to one already in the
// records, else created.
const basisOf = (rec) => (rec && rec.result && rec.result.basis === 'existing' ? 'existing' : 'created');

// Records a step's failure on the admission: the effects named become failed
// unless already done (pendingOf tries them again), with the error.
function failStep(ws, id, err, now, effects) {
  const a = updateAdmission(ws, id, `Admission ${id} failed`, (cur) => ({
    ...cur,
    effects: { ...cur.effects, ...Object.fromEntries(effects.filter((e) => cur.effects[e] !== 'done').map((e) => [e, 'failed'])) },
    errors: [...cur.errors, errorOf(err, now)].slice(-10),
  }));
  return finish(ws, a);
}

// Finishes an admission's pending effects, in order, each idempotent under its
// own key, each step's failure recorded on the admission rather than thrown
// (audit F3). Past the start deadline an effect that has not committed is not
// started: the admission reads lapsed and says what was done. A new run whose
// routes or limits differ from what Eric confirmed is not started either: the
// admission reads needs_consent until he requests research again (audit F2).
// A committed effect is never undone. Returns the admission.
function completeAdmission(ws, id, { now = Date.now() } = {}) {
  let a = readAdmission(ws, id);
  if (!pendingOf(a).length) return a;
  const lapsed = now > Date.parse(a.start_deadline);
  const { intake: intakeKey, project: projectKey, research: researchKey } = keysOf(a);
  const { readApplied } = require('./ops');
  const committed = (k) => readApplied(ws, k.key);
  // An automatic admission checks its authority before each further effect;
  // one that no longer holds stops the rest (what was done stays done).
  const delegated = isDelegated(a);
  const gate = () => (delegated ? delegatedGate(ws, a, now) : null);
  // 1. The intake record, written with its link in one operation.
  if (a.effects.intake !== 'done') {
    if (lapsed && !committed(intakeKey)) return lapse(ws, a, now);
    const why = committed(intakeKey) ? null : gate();
    if (why) return stopAdmission(ws, a, why, now);
    try {
      const doc = intakeDocOf(a);
      const r = runOp(ws, { type: 'scout_lead_admission_intake', summary: `Research request for admission ${id}`, idempotencyKey: intakeKey.key, payloadHash: intakeKey.payload_sha256 }, (op) => {
        if (!op.readJson(`inbox/intake/${doc.intake_id}.json`, null)) op.writeJson(`inbox/intake/${doc.intake_id}.json`, doc, { mode: 'create' });
        const cur = op.readJson(`${ADMISSIONS}/${id}.json`, null);
        op.writeJson(`${ADMISSIONS}/${id}.json`, { ...cur, intake_id: doc.intake_id, effects: { ...cur.effects, intake: 'done' } });
        return { intake_id: doc.intake_id };
      });
      if (r.replayed) a = updateAdmission(ws, id, `Link ${id}`, (cur) => ({ ...cur, intake_id: r.result.intake_id, effects: { ...cur.effects, intake: 'done' } }));
      else a = readAdmission(ws, id);
    } catch (err) {
      return failStep(ws, id, err, now, ['intake']);
    }
  }
  // 2 and 3. The project and the run, through the code intake shares.
  if (a.effects.project !== 'done' || a.effects.research !== 'done') {
    const projectDone = a.effects.project === 'done' ? { result: { project_id: a.project_id, basis: a.project_basis === 'existing' ? 'existing' : 'created' } } : committed(projectKey);
    const researchDone = projectDone ? committed(researchKey(projectDone.result.project_id)) : null;
    if (lapsed && (!projectDone || !researchDone)) {
      if (projectDone && a.effects.project !== 'done') a = updateAdmission(ws, id, `Link ${id}`, (cur) => ({ ...cur, project_id: projectDone.result.project_id, project_basis: basisOf(projectDone), effects: { ...cur.effects, project: 'done' } }));
      return lapse(ws, a, now);
    }
    if (delegated && !(projectDone && researchDone)) {
      // Its project, once created under its key, is read by the gate.
      const known = projectDone ? { ...a, project_id: projectDone.result.project_id } : a;
      const why = delegatedGate(ws, known, now) || (projectDone ? null : delegatedDuplicate(ws, a));
      if (why) {
        if (projectDone && a.effects.project !== 'done') a = updateAdmission(ws, id, `Link ${id}`, (cur) => ({ ...cur, project_id: projectDone.result.project_id, project_basis: basisOf(projectDone), effects: { ...cur.effects, project: 'done' } }));
        return stopAdmission(ws, a, why, now);
      }
    }
    let res;
    try {
      const sector = require('./intake').sectorGuess([]);
      // An automatic admission's run is Claude's, in assistant mode, for the
      // pilot worker to research: a configured API never changes its route,
      // and no API is asked (research.newJob). A confirmed one keeps the
      // routes and limits Eric confirmed (checkConsent).
      res = require('./intake').admitListing(ws, a.listing, {
        models: a.envelope.models,
        evidence: [{ url: a.listing.coingecko_url, note: evidenceNote(a), kind: delegated ? 'delegated_admission' : 'owner_confirmed' }],
        sector: { primary: sector, source: 'suggested' },
        utterance: delegated ? `scout lead ${a.lead_key} (automatic admission ${a.admission_id})` : `scout lead ${a.lead_key} (admission ${a.admission_id})`,
        run_utterance: null,
        owner_instructions: null,
        channel: delegated ? 'scout-leads (automatic admission)' : 'scout-leads',
        idempotency: { project: a.effects.project === 'done' ? null : projectKey, research: researchKey },
        consent: delegated ? null : { routes: a.envelope.routes, budget_scope: a.envelope.budget_scope },
        ...(delegated ? { assistant: 'claude' } : {}),
      });
    } catch (err) {
      const p = committed(projectKey);
      if (delegated && (err.code === 'AMBIGUOUS' || err.code === 'CONFLICT')) {
        if (p && a.effects.project !== 'done') a = updateAdmission(ws, id, `Link ${id}`, (cur) => ({ ...cur, project_id: p.result.project_id, project_basis: basisOf(p), effects: { ...cur.effects, project: 'done' } }));
        return stopAdmission(ws, a, String(err.message).slice(0, 300), now);
      }
      const consent = err.code === 'CONSENT_CHANGED';
      a = updateAdmission(ws, id, `Admission ${id} ${consent ? 'needs your word again' : 'failed'}`, (cur) => ({
        ...cur,
        project_id: cur.project_id || (p ? p.result.project_id : null),
        project_basis: cur.project_basis || (p ? basisOf(p) : null),
        effects: { ...cur.effects, project: cur.effects.project === 'done' || p ? 'done' : 'failed', research: consent ? 'needs_consent' : 'failed' },
        errors: [...cur.errors, errorOf(err, now)].slice(-10),
      }));
      return finish(ws, a);
    }
    const words = `${res.added.status === 'exists' ? 'Already in your records' : 'Added to your watchlist'}; ${res.run.status === 'exists' ? 'a research run you started a few minutes ago is linked' : `research requested from ${namesOf(a.envelope.models)}${delegated ? ' through the pilot worker' : ''}`}.`;
    try {
      a = linkEffects(ws, id, a, res, words, now);
    } catch (err) {
      // The project and the run are committed under their keys; the next try
      // replays both and links them.
      return failStep(ws, id, err, now, ['project', 'research']);
    }
  }
  // 4. An automatic admission's pilot enrollment and exit target, only on the
  // project it created itself.
  if (delegated && a.effects.pilot !== 'done') {
    if (lapsed) return lapse(ws, a, now);
    if (a.project_basis === 'existing') return stopAdmission(ws, a, `it linked ${a.project_id}, a project already in the records, which is never enrolled automatically`, now);
    const why = gate();
    if (why) return stopAdmission(ws, a, why, now);
    a = pilotEffect(ws, id, a, now);
  }
  return finish(ws, a);
}

// The project and the run linked on the admission and its intake record.
function linkEffects(ws, id, a, res, words, now) {
  return updateAdmission(ws, id, `Link ${id}`, (cur, op) => {
    const doc = cur.intake_id ? op.readJson(`inbox/intake/${cur.intake_id}.json`, null) : null;
    if (doc && doc.status === 'admitting') {
      op.writeJson(`inbox/intake/${cur.intake_id}.json`, {
        ...doc,
        status: 'researching',
        updated_at: isoOf(now),
        confirmed: { coingecko_id: a.listing.coingecko_id, name: a.listing.name, symbol: a.listing.symbol, at: cur.created_at, project_id: res.project_id, project_status: res.added.status, run_id: res.run.run_id, run_status: res.run.status, models: a.envelope.models, ...(isDelegated(a) ? { by: a.actor } : {}) },
        events: [...(doc.events || []), { at: isoOf(now), what: isDelegated(a) ? `${a.listing.name} admitted automatically from a scout lead (${a.actor}). ${words}` : `${a.listing.name} confirmed from a scout lead. ${words}` }].slice(-40),
      });
    }
    return {
      ...cur,
      project_id: res.project_id,
      project_basis: cur.project_basis || (res.added.status === 'exists' ? 'existing' : 'created'),
      run_id: res.run.run_id,
      run_basis: res.run.status === 'exists' ? 'existing_recent' : 'created',
      effects: { ...cur.effects, project: 'done', research: 'done' },
    };
  });
}

function finish(ws, a) {
  const state = stateOf(a);
  // A failure's words follow its latest error, even when it was failed before.
  if (state === a.state && state !== 'failed') return a;
  const last = a.errors.length ? a.errors[a.errors.length - 1].words : null;
  const project = !a.project_id ? 'Nothing was added' : a.project_basis === 'existing' ? 'Linked to the project already in your records' : 'Project added';
  if (isDelegated(a)) {
    const w = state === 'complete' ? `${doneWords(a)}. Admitted automatically; no person reviewed this lead. Pending evidence and research: the Prosecutor, the contract and exit-cost gates and the paper mandate decide everything after this.`
      : state === 'failed' ? `Not finished: ${last || 'an effect failed'} (tried again until ${a.start_deadline})` : null;
    if (state === a.state && w === a.words) return a;
    return updateAdmission(ws, a.admission_id, `Admission ${a.admission_id} ${state}`, (cur) => ({ ...cur, state, words: w }));
  }
  const words = state === 'complete'
    ? `${project}; research ${a.run_basis === 'existing_recent' ? 'linked to a run started a few minutes earlier' : `requested from ${namesOf(a.envelope.models)}`}.`
    : state === 'needs_consent' ? `${project}; research not requested: ${last || 'what you confirmed changed'}`
      : state === 'failed' ? `Not finished: ${last || 'an effect failed'}` : null;
  if (state === a.state && words === a.words) return a;
  return updateAdmission(ws, a.admission_id, `Admission ${a.admission_id} ${state}`, (cur) => ({ ...cur, state, words }));
}

function lapse(ws, a, now) {
  return updateAdmission(ws, a.admission_id, `Admission ${a.admission_id} lapsed`, (cur) => {
    const effects = Object.fromEntries(effectsOf(cur).map((e) => [e, cur.effects[e] === 'done' ? 'done' : 'lapsed']));
    if (isDelegated(cur)) return { ...cur, effects, state: 'lapsed', lapsed_at: isoOf(now), words: `${doneWords(cur)}; the rest was not started: the automatic admission lapsed at ${cur.start_deadline}.` };
    const done = cur.effects.project !== 'done' ? 'Nothing was added' : cur.project_basis === 'existing' ? 'Linked to the project already in your records' : 'Project added';
    return { ...cur, effects, state: 'lapsed', lapsed_at: isoOf(now), words: `${done}; research not requested: the confirmation lapsed at ${cur.start_deadline}.` };
  });
}

// Completes every admission with a pending effect (the worker's recovery
// step, and Complete on a row). Returns the admissions it touched.
function completePending(ws, { now = Date.now() } = {}) {
  const out = [];
  for (const a of listAdmissions(ws)) {
    if (!pendingOf(a).length) continue;
    out.push(attempt(ws, a.admission_id, now));
  }
  return out;
}

// "Request research" on a lapsed admission's project, or one whose routes or
// limits changed since Eric confirmed (needs_consent): a new admission with
// its own request ID and a fresh envelope Eric reviewed. The project is the
// existing one; nothing else is re-checked.
function requestAgain(ws, body, { now = Date.now() } = {}) {
  const b = isObj(body) ? body : {};
  if (typeof b.request_id !== 'string' || !REQUEST_ID.test(b.request_id)) throw opErr('INVALID', 'The request ID must look like req_ followed by 4 to 80 letters, digits, - or _.', 400);
  const prev = readAdmission(ws, b.admission_id);
  if (!['lapsed', 'needs_consent'].includes(prev.state) || !prev.project_id) throw opErr('INVALID', 'Only an admission whose project was added and whose research lapsed or needs your word again can request research again.', 400);
  const id = admissionIdOf(b.request_id, prev.lead_key);
  runOp(ws, { type: 'scout_lead_request_again', summary: `Request research again (${b.request_id})` }, (op) => {
    if (op.readJson(`${ADMISSIONS}/${id}.json`, null)) return;
    const later = listAdmissions(ws).find((a) => a.follows === prev.admission_id);
    if (later) throw opErr('CONFLICT', `Research was already requested again for this lead (${later.admission_id}). Nothing was written.`, 409, { admission_id: later.admission_id });
    const env = envelope(ws);
    if (!env.models.length) throw opErr('NO_MODEL', 'Every model is on hold: nothing to request. Nothing was written.', 409);
    if (stableStringify(b.expect_envelope) !== stableStringify(env)) throw opErr('CHANGED', 'Changed since you looked: the models, routes or budget. Nothing was written; look again.', 409, { envelope: { reviewed: b.expect_envelope || null, now: env } });
    // Eric's request: a confirmed admission, whatever admitted the lead first
    // (an automatic one's kind, authority and day's reservation stay on it).
    const { kind, actor, admission_policy, authority, reservation, capacity, enrollment, stopped_at, stopped_because, ...was } = prev;
    op.writeJson(`${ADMISSIONS}/${id}.json`, withKeys({
      ...was,
      admission_id: id,
      request_id: b.request_id,
      envelope: env,
      batch_size: 1,
      created_at: isoOf(now),
      start_deadline: isoOf(now + START_WINDOW_MS),
      state: 'pending',
      effects: { intake: 'done', project: 'done', research: 'pending' },
      run_id: null,
      run_basis: null,
      errors: [],
      words: null,
      lapsed_at: undefined,
      follows: prev.admission_id,
    }), { mode: 'create' });
  });
  return attempt(ws, id, now);
}

// Eric's dismissal: the lead stays dismissed; a new sighting is only
// appended. Idempotent by request ID.
function dismissLead(ws, body, { now = Date.now() } = {}) {
  const b = isObj(body) ? body : {};
  if (typeof b.request_id !== 'string' || !REQUEST_ID.test(b.request_id)) throw opErr('INVALID', 'The request ID must look like req_ followed by 4 to 80 letters, digits, - or _.', 400);
  if (typeof b.lead_key !== 'string' || !/^[0-9a-f]{32}$/.test(b.lead_key)) throw opErr('INVALID', 'Name the lead to dismiss.', 400);
  const reasonErrors = [];
  const reason = scout.plainLine(b.reason, 'reason', 280, reasonErrors, { required: false });
  if (reasonErrors.length) throw opErr('INVALID', `The reason was refused: ${reasonErrors.join('; ')}.`, 400);
  const out = runOp(ws, { type: 'scout_lead_dismiss', summary: `Dismiss scout lead ${b.lead_key}`, idempotencyKey: `dismiss:${b.request_id}`, payloadHash: sha256(stableStringify([b.lead_key, reason])) }, (op) => {
    const rel = `${ASSETS}/${b.lead_key}.json`;
    const a = checkAsset(op.readJson(rel, null), b.lead_key);
    if (a.state === 'ADMITTED') throw opErr('CONFLICT', 'This lead was already confirmed; it cannot be dismissed. Archive its project instead.', 409);
    if (a.state === 'DISMISSED') return { status: 'unchanged', lead_key: b.lead_key };
    op.writeJson(rel, { ...a, state: 'DISMISSED', revision: (Number(a.revision) || 1) + 1, claim: null, next_attempt_at: null, dismissal: { at: isoOf(now), reason, request_id: b.request_id } });
    return { status: 'dismissed', lead_key: b.lead_key };
  });
  return { ...out.result, verified: out.verified };
}

// What Review > Imports > Scout leads draws: the envelope and policy a confirm
// sends back, and each lead grouped by state with its receipt's facts. Read
// only.
function reviewView(ws, { now = Date.now() } = {}) {
  const policy = policyOf(ws);
  const env = envelope(ws);
  const admissions = listAdmissions(ws);
  // Each lead shows its current admission: the one no later request follows
  // (the files sort by ID, which says nothing about their order).
  const followed = new Set(admissions.map((a) => a.follows).filter(Boolean));
  const byLead = new Map();
  for (const a of admissions) {
    if (followed.has(a.admission_id)) continue;
    const was = byLead.get(a.lead_key);
    if (!was || String(a.created_at) > String(was.created_at)) byLead.set(a.lead_key, a);
  }
  const rows = assets(ws).map((a) => {
    if (a.integrity) return { lead_key: a.asset_id, state: 'INTEGRITY', reasons: ['This lead\'s record does not match its identity; it is not shown.'] };
    const r = a.eligibility ? readReceipt(ws, a.eligibility.receipt_id) : null;
    const cg = r ? r.observations.find((o) => o.source === 'coingecko' && o.facts) : null;
    const gp = r ? r.observations.find((o) => o.source === 'goplus' && o.facts) : null;
    const last = a.sightings.length ? a.sightings[a.sightings.length - 1] : null;
    const adm = byLead.get(a.asset_id) || null;
    // An ELIGIBLE reading that no longer stands is shown as being read again,
    // with the reasons in force, never as confirmable.
    const standing = a.state === 'ELIGIBLE' && r && r.state === 'ELIGIBLE' ? stillEligible(r, a, policy) : { stands: true };
    return {
      lead_key: a.asset_id,
      state: a.state,
      chain: a.identity.chain_label,
      chain_id: a.identity.chain_id,
      address: a.identity.address,
      identity_revision: a.identity_revision,
      asset_revision: a.revision,
      eligibility_receipt_id: a.eligibility ? a.eligibility.receipt_id : null,
      eligibility_sha256: a.eligibility ? a.eligibility.eligibility_sha256 : null,
      decided_at: a.eligibility ? a.eligibility.decided_at : null,
      expires_at: a.eligibility ? a.eligibility.expires_at : null,
      expired: Boolean(a.eligibility && a.eligibility.expires_at && Date.parse(a.eligibility.expires_at) <= now) || !standing.stands,
      rescreen_due: !standing.stands,
      reasons: standing.stands ? (a.eligibility ? a.eligibility.reasons : []) : standing.reasons,
      listing: cg ? { name: cg.facts.name, symbol: cg.facts.symbol, coingecko_id: cg.facts.coingecko_id, image: cg.facts.image, market_cap_usd: cg.facts.market_cap_usd, volume_24h_usd: cg.facts.volume_24h_usd } : null,
      screen: gp ? gp.facts : null,
      words: r ? r.words : null,
      scout_words: last ? last.signal : null,
      sightings: a.sightings.length,
      dismissal: a.dismissal || null,
      known_project_id: a.known_project_id || null,
      admission: adm ? summaryOf(adm) : null,
    };
  });
  let auto;
  try { auto = require('./lead-admission').statusView(ws, { now }); } catch (err) { auto = { on: false, code: 'unreadable', why: String((err && err.message) || err).slice(0, 200) }; }
  return { schema_version: 'cr.scout-leads-review.v1', policy: { version: policy.version, sha256: policy.sha256, missing: policy.missing, enabled: policy.values.enabled }, envelope: env, rows, admissions: admissions.map(summaryOf), auto_admission: auto };
}

// An eligibility receipt by its ID, checked against its hash. Read only.
function getReceipt(ws, id) {
  const r = readReceipt(ws, id);
  if (!r) throw opErr('NOT_FOUND', `No intact eligibility receipt ${id}.`, 404);
  return r;
}

module.exports = {
  LEADS_SCHEMA,
  LEADS_PROMPT,
  LEADS_PATH,
  DIR,
  DELIVERIES,
  ASSETS,
  INDEX,
  SOURCE,
  MAX_LEADS_PER_DAY,
  LIMITS,
  ENVELOPE_FIELDS,
  ROW_FIELDS,
  DELIVERY_ID,
  assetId,
  identityOf,
  checkAsset,
  getAsset,
  checkEnvelope,
  checkRow,
  ingest,
  status,
  leadsToday,
  assets,
  view,
  ELIGIBILITY_VERSION,
  POLICY_VERSION,
  RECEIPT_SCHEMA,
  ELIGIBILITY,
  STATES,
  POLICY_FIELDS,
  POLICY_BOUNDS,
  CG_PLATFORM,
  TURN_ASSETS,
  TURN_REQUESTS,
  TURN_MS,
  policyOf,
  validatePolicyPatch,
  makeTurn,
  receiptSha,
  knownProject,
  dueOf,
  stillEligible,
  factsCurrent,
  dueAssets,
  isDue,
  listingFacts,
  screenFacts,
  judge,
  refresh,
  getReceipt,
  ADMISSION_SCHEMA,
  BATCH_SCHEMA,
  BATCHES,
  ADMISSIONS,
  admissionIdOf,
  envelope,
  confirmLeads,
  completeAdmission,
  completePending,
  requestAgain,
  dismissLead,
  readAdmission,
  listAdmissions,
  reviewView,
  evidenceNote,
  // Automatic admission (lead-admission.js) reuses the confirm's checks and
  // effects through these.
  DELEGATED_EFFECTS,
  effectsOf,
  rowCheck,
  listingOf,
  delegatedAdmission,
  delegatedGate,
  attempt,
  intakeDocOf,
};
