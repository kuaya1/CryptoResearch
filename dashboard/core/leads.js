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
};
