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

// Whether an asset is due now (one predicate, read only; §4's table).
function dueOf(a, now, policy) {
  if (!a || a.integrity || TERMINAL.has(a.state)) return false;
  if (a.claim && Number.isFinite(Date.parse(a.claim.claimed_at)) && now - Date.parse(a.claim.claimed_at) < CLAIM_STALE_MS) return false;
  const e = a.eligibility;
  const changed = !e || e.policy_sha256 !== policy.sha256;
  const at = (iso) => !iso || !Number.isFinite(Date.parse(iso)) || Date.parse(iso) <= now;
  switch (a.state) {
    case 'NEW': return true;
    case 'RETRY_AT': return at(a.next_attempt_at);
    case 'ELIGIBLE': return changed || at(e.expires_at);
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
  return assets(ws).filter((a) => dueOf(a, now, policy)).sort((x, y) => (x.released_at ? 0 : 1) - (y.released_at ? 0 : 1) || t(x) - t(y) || String(x.asset_id).localeCompare(String(y.asset_id)));
}

// Whether the `leads` job has work: on, not a restored copy, CoinGecko's and
// GoPlus's gates open, and an asset due.
function isDue(ws, now = Date.now()) {
  const policy = policyOf(ws);
  if (!policy.values.enabled || require('./research').restoredHold(ws)) return false;
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

// The screen's critical facts from GoPlus's normalized answer. Pure.
function screenFacts(n, family) {
  const t = n.taxes || {};
  return family === 'solana'
    ? { transfer_fee_pct: finite(t.transfer_fee_pct), severe: n.severe || [], watch: n.watch || [] }
    : { sell_tax_pct: finite(t.sell_pct), buy_tax_pct: finite(t.buy_pct), honeypot: n.checks.honeypot, cannot_sell_all: n.checks.cannot_sell_all, severe: n.severe || [], watch: n.watch || [] };
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
    if (identity.family === 'solana') tax('transfer_fee_pct', 'transfer fee', f.transfer_fee_pct);
    else {
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
  // with no request.
  const prev = a.eligibility ? readReceipt(ws, a.eligibility.receipt_id) : null;
  const hours = policy.values.eligibility_hours * 3600000;
  const now0 = clock();
  if (prev && prev.observations.length && prev.observations.every((o) => Date.parse(o.observed_at) + hours > now0) && prev.observations.some((o) => o.source === 'coingecko') && prev.observations.some((o) => o.source === 'goplus')) {
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

// One turn of the `leads` job. Returns { status, message, ... }.
async function refresh(ws, { trigger = 'manual', fetchImpl = globalThis.fetch, clock = Date.now, turnMs = TURN_MS, maxRequests = TURN_REQUESTS, retryDelayMs = 1000 } = {}) {
  const policy = policyOf(ws);
  if (!policy.values.enabled) return { status: 'skipped', message: 'Scout leads are off (Preferences > Screening > Scout leads).' };
  if (require('./research').restoredHold(ws)) return { status: 'held', message: 'Scout leads are held in this restored copy; no provider is asked.' };
  const lease = acquireLease(ws, LEASE, LEASE_MS, { label: trigger });
  if (!lease) return { status: 'busy', message: 'Another runner is reading scout leads right now.' };
  try {
    const opId = `lt_${compactTs(new Date(clock()))}_${randomId(6)}`;
    const claimed = stampClaims(ws, opId, policy, clock());
    if (!claimed.length) return { status: 'noop', message: 'No scout lead is due.', results: [] };
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
    const message = `Scout leads: ${by((r) => r.result === 'receipt')} read (${STATES.map((s) => [s, by((r) => r.state === s)]).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(', ') || 'none'}), ${by((r) => r.result === 'released')} left for the next turn, ${turn.sent()} requests.`;
    return { status: by((r) => r.state === 'RETRY_AT' || r.result === 'released') ? 'partial' : 'ok', message, requests: turn.sent(), results };
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
  dueAssets,
  isDue,
  listingFacts,
  screenFacts,
  judge,
  refresh,
  getReceipt,
};
