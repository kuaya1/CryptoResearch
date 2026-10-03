'use strict';
// Research intake: the one entry point for "research this project".
//
//   1. Eric submits a CoinMarketCap or CoinGecko link, a project name, and/or a
//      screenshot, plus optional plain-language instructions. The request is
//      saved first (inbox/intake/<intake_id>.json, the screenshot beside it), so
//      leaving the page never loses it.
//   2. The project is identified from evidence: the link's slug or contract,
//      or what the screenshot visibly shows (read by Claude when the API is set
//      up), matched against CoinGecko's listing. Every candidate is shown with
//      its network, contract and homepage. Nothing is chosen silently: research
//      starts only after Eric confirms one candidate.
//   3. Confirming creates the watchlist project (or reuses the existing one) and
//      one research run, carrying the instructions: Claude, plus ChatGPT and
//      Gemini where their API is set up on this desk (or when the instructions
//      ask for all three models). Progress, cost and the saved reports come
//      from that run.
//
// Screenshots, pages and links are evidence, never instructions. A project in a
// screenshot is never treated as a holding, and nothing here touches the
// portfolio. CoinMarketCap pages are not fetched: only the link's own text (its
// slug or contract) is used, and CoinGecko's public API supplies the listing.
//
// Paid calls: reading a screenshot is one small Claude call. It is admitted
// against the same research limits as research runs, recorded in the same spend
// log, and marked as dispatched before it is sent, so an interrupted read is
// never repeated by itself (it keeps counting at its reservation until Eric
// asks to read the screenshot again).

const fs = require('fs');
const { runOp, OpError, withLock, replaceFile } = require('./ops');
const { readJson, listDir, jsonText, sha256 } = require('./fsx');
const { compactTs, randomId, slugify } = require('./ids');
const { parseSector } = require('./sectors');

const DIR = 'inbox/intake';
const ID_RE = /^in_\d{4}-\d{2}-\d{2}T\d{6}Z_[a-z2-9]{5}$/;
const MEDIA = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_INSTRUCTIONS = 2000;
const DEDUPE_MINUTES = 10;
const IDENTIFY_MODEL_DEFAULT = 'claude-opus-5-5';
// The most one screenshot read may cost is reserved from these bounds: a phone
// screenshot is at most about 1,600 input tokens after Anthropic's resizing,
// plus a short instruction; the answer is capped at 4,000 output tokens.
const READ_INPUT_TOKENS = 3000;
const READ_OUTPUT_TOKENS = 4000;
// CoinMarketCap DEX-scan network names mapped to CoinGecko asset platforms.
const CMC_CHAINS = {
  ethereum: 'ethereum', eth: 'ethereum', base: 'base', solana: 'solana', bsc: 'binance-smart-chain', 'bnb-chain': 'binance-smart-chain', bnb: 'binance-smart-chain',
  arbitrum: 'arbitrum-one', 'arbitrum-one': 'arbitrum-one', polygon: 'polygon-pos', 'polygon-pos': 'polygon-pos', optimism: 'optimistic-ethereum', avalanche: 'avalanche',
  sui: 'sui', aptos: 'aptos', ton: 'the-open-network', tron: 'tron', blast: 'blast', linea: 'linea', zksync: 'zksync', scroll: 'scroll', sonic: 'sonic', hyperevm: 'hyperevm',
};
const OPEN = new Set(['identifying', 'needs_confirmation', 'identity_failed']);

const isIntakeId = (s) => typeof s === 'string' && ID_RE.test(s);
const rel = (id) => `${DIR}/${id}.json`;
const nowIso = () => new Date().toISOString();
const round4 = (x) => Math.round(x * 10000) / 10000;

// ---------------------------------------------------------------------------
// What the link says (no network)

function parseLink(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  let url = null;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : /^(www\.)?(coinmarketcap|coingecko)\.com\//i.test(raw) ? `https://${raw}` : '');
  } catch (_) {
    url = null;
  }
  if (!url) {
    if (raw.length > 80 || /[<>{}]/.test(raw)) return { source: 'invalid', raw, error: 'Paste a CoinMarketCap or CoinGecko link, or type the project name or ticker.' };
    return { source: 'text', raw, query: raw };
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let parts;
  try {
    parts = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p).toLowerCase());
  } catch (_) {
    return { source: 'invalid', raw, error: 'That link could not be read. Paste it again, or type the project name.' };
  }
  if (host === 'coinmarketcap.com') {
    const ci = parts.indexOf('currencies');
    if (ci >= 0 && parts[ci + 1] && /^[a-z0-9][a-z0-9-]{0,100}$/.test(parts[ci + 1])) return { source: 'coinmarketcap', raw, slug: parts[ci + 1], query: parts[ci + 1].replace(/-/g, ' ') };
    const di = parts.indexOf('dexscan');
    if (di >= 0 && parts[di + 1] && parts[di + 2]) {
      const chain = parts[di + 1];
      const address = url.pathname.split('/').filter(Boolean)[di + 2];
      if (/^[A-Za-z0-9]{20,80}$/.test(address)) return { source: 'coinmarketcap_dexscan', raw, chain, platform: CMC_CHAINS[chain] || null, address };
    }
    return { source: 'invalid', raw, error: 'That CoinMarketCap link does not point to a coin page (coinmarketcap.com/currencies/<name>/).' };
  }
  if (host === 'coingecko.com') {
    const ci = parts.indexOf('coins');
    if (ci >= 0 && parts[ci + 1] && /^[a-z0-9][a-z0-9-]{0,100}$/.test(parts[ci + 1])) return { source: 'coingecko', raw, coingecko_id: parts[ci + 1], query: parts[ci + 1].replace(/-/g, ' ') };
    return { source: 'invalid', raw, error: 'That CoinGecko link does not point to a coin page (coingecko.com/en/coins/<id>).' };
  }
  return { source: 'invalid', raw, error: `Links from ${host} are not used to identify projects. Paste a CoinMarketCap or CoinGecko link, or type the project name.` };
}

// ---------------------------------------------------------------------------
// Records

function readIntake(ws, id) {
  if (!isIntakeId(id)) throw new OpError('BAD_ID', 'Invalid intake ID');
  const doc = readJson(ws.abs(rel(id)), null);
  if (!doc) throw new OpError('NOT_FOUND', `No research request ${id}`);
  return doc;
}

function listIntakes(ws, { limit = 30 } = {}) {
  return listDir(ws.abs(DIR), { dirs: false })
    .filter((f) => f.endsWith('.json') && isIntakeId(f.slice(0, -5)))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((f) => {
      try {
        return readJson(ws.abs(`${DIR}/${f}`));
      } catch (err) {
        return { intake_id: f.slice(0, -5), broken: true, error: err.message };
      }
    });
}

// One verified write of the request; returns the updated record.
function mutate(ws, id, summary, fn) {
  const out = runOp(ws, { type: 'intake_update', summary }, (op) => {
    const doc = op.readJson(rel(id), null);
    if (!doc) throw new OpError('NOT_FOUND', `No research request ${id}`);
    fn(doc, op);
    doc.updated_at = nowIso();
    op.writeJson(rel(id), doc);
    return doc;
  });
  return out.replayed ? readIntake(ws, id) : out.result;
}

function event(doc, what) {
  doc.events = [...(doc.events || []), { at: nowIso(), what }].slice(-40);
}

function cleanInstructions(s) {
  const t = typeof s === 'string' ? s.replace(/\r\n/g, '\n').trim() : '';
  return t ? t.slice(0, MAX_INSTRUCTIONS) : null;
}

// Saves a new request. A repeat of the same link/screenshot and instructions
// within a few minutes returns the earlier request instead of a second one.
function createIntake(ws, { link = null, screenshot = null, instructions = null } = {}) {
  const parsed = link ? parseLink(link) : null;
  if (parsed && parsed.source === 'invalid' && !screenshot) throw new OpError('INVALID', parsed.error);
  let image = null;
  if (screenshot) {
    const type = String(screenshot.media_type || '').toLowerCase();
    if (!MEDIA[type]) throw new OpError('INVALID', 'The screenshot must be a PNG, JPEG, WebP or GIF image (on an iPhone, a normal screenshot is PNG).');
    const buf = Buffer.from(String(screenshot.data_base64 || ''), 'base64');
    if (!buf.length) throw new OpError('INVALID', 'The screenshot is empty.');
    if (buf.length > MAX_IMAGE_BYTES) throw new OpError('INVALID', `The screenshot is larger than ${MAX_IMAGE_BYTES / 1048576} MB. Crop it or send a smaller one.`);
    image = { buf, type, sha256: sha256(buf) };
  }
  if (!parsed && !image) throw new OpError('INVALID', 'Paste a CoinMarketCap link, type a project name, or add a screenshot.');
  const note = cleanInstructions(instructions);
  const fingerprint = sha256(JSON.stringify({ link: parsed ? parsed.raw.toLowerCase() : null, image: image ? image.sha256 : null, note }));
  const recent = listIntakes(ws, { limit: 20 }).find((d) => !d.broken && d.fingerprint === fingerprint && d.status !== 'canceled' && Date.now() - Date.parse(d.created_at) < DEDUPE_MINUTES * 60000);
  if (recent) return { status: 'exists', intake: recent, message: 'This request was already submitted a few minutes ago; it is the same one.' };
  const id = `in_${compactTs()}_${randomId(5)}`;
  const doc = {
    schema_version: 'cr.intake.v1',
    intake_id: id,
    created_at: nowIso(),
    updated_at: nowIso(),
    via: ws.actor,
    fingerprint,
    input: {
      link: parsed ? parsed.raw : null,
      parsed: parsed && parsed.source !== 'invalid' ? parsed : null,
      link_problem: parsed && parsed.source === 'invalid' ? parsed.error : null,
      screenshot: image ? { file: `${DIR}/${id}.${MEDIA[image.type]}`, media_type: image.type, bytes: image.buf.length, sha256: image.sha256 } : null,
      instructions: note,
    },
    status: 'identifying',
    identity: null,
    confirmed: null,
    events: [{ at: nowIso(), what: 'Request saved.' }],
    note: 'Research request. Identity is confirmed by Eric before any paid research; a screenshot never records a holding.',
  };
  const out = runOp(ws, { type: 'intake_create', summary: `Research request ${id}` }, (op) => {
    if (image) op.write(doc.input.screenshot.file, image.buf, { mode: 'create' });
    op.writeJson(rel(id), doc, { mode: 'create' });
    return { intake_id: id };
  });
  const saved = out.replayed ? readIntake(ws, out.result.intake_id) : doc;
  return { status: 'created', intake: saved, files: out.files, verified: out.verified };
}

// Requests whose identification has not finished (resumed after a restart).
function pendingIdentify(ws) {
  return listIntakes(ws, { limit: 50 }).filter((d) => !d.broken && d.status === 'identifying').map((d) => d.intake_id);
}

// ---------------------------------------------------------------------------
// CoinGecko lookups (free public API; every attempted call counts in the same
// monthly budget as prices)

// n requests sent (counted before each is sent), answered: those that came
// back with a usable answer (counted after).
function countCalls(ws, n, answered = 0) {
  const market = require('./market');
  withLock(ws, 'market_status', () => {
    const status = market.readStatus(ws);
    const calls = market.addCalls(market.callBudget(ws, status), n, answered);
    replaceFile(ws, ws.abs(market.STATUS_REL), jsonText({ ...status, schema_version: status.schema_version || 'cr.market-status.v2', calls }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One CoinGecko lookup through the shared rate-limit gate (market.js): a 429
// here makes prices and market context wait too, and a 429 they saw makes this
// wait. The keyless public API allows only a few calls a minute, so a short
// wait (Retry-After up to maxWaitMs) is sat out once; a longer one fails at
// once with the time to try again, instead of asking a busy provider again.
async function cgGet(ws, pathAndQuery, fetchImpl, { retries = 1, maxWaitMs = 20000 } = {}) {
  const market = require('./market');
  const md = ws.settings.market_data;
  const base = process.env.CR_MARKET_API_BASE || md.api_base;
  const headers = { accept: 'application/json', 'user-agent': 'CryptoResearch-desk' };
  const key = market.apiKey();
  if (key) headers['x-cg-demo-api-key'] = key;
  const limited = (gate) => new OpError('LOOKUP_FAILED', `CoinGecko is rate-limiting this server. ${gate.until ? `Try again after ${market.clock(gate.until)}.` : 'Try again in a few minutes.'}`, { retry_at: gate.until || null });
  let waits = retries;
  let sent = 0;
  for (;;) {
    const gate = market.rateLimitGate(ws);
    if (!gate.open) {
      if (waits <= 0 || gate.wait_ms > maxWaitMs) throw limited(gate);
      waits--;
      await sleep(gate.wait_ms + 25);
      continue; // checked again: another caller may have made the wait longer
    }
    const budget = market.callBudget(ws, market.readStatus(ws));
    if (budget.budget_monthly && budget.month_count + 1 > budget.budget_monthly) throw new OpError('REFUSED', `The monthly CoinGecko call budget is used up (${budget.month_count} of ${budget.budget_monthly}).`);
    countCalls(ws, 1);
    sent++;
    let res;
    try {
      res = await fetchImpl(`${base}${pathAndQuery}`, { headers, signal: AbortSignal.timeout((md.timeout_seconds || 20) * 1000) });
    } catch (err) {
      throw new OpError('LOOKUP_FAILED', err.name === 'TimeoutError' || err.name === 'AbortError' ? 'CoinGecko did not answer in time. Try again in a minute.' : `CoinGecko could not be reached (${err.message}).`);
    }
    if (res.status === 404) return null;
    if (res.status === 429) {
      const gateNow = market.noteRateLimit(ws, { retryAfterMs: market.retryAfterMs(res), source: 'research intake', httpStatus: 429 });
      // Never more than retries + 1 requests, even when Retry-After is zero.
      if (sent > retries) throw limited(gateNow.open ? { until: null } : gateNow);
      continue;
    }
    if (!res.ok) throw new OpError('LOOKUP_FAILED', `CoinGecko answered HTTP ${res.status}.`);
    let body;
    try {
      body = await res.json();
    } catch (_) {
      throw new OpError('LOOKUP_FAILED', 'CoinGecko answered with unreadable data.');
    }
    countCalls(ws, 0, 1);
    return body;
  }
}

const GUESS = [
  ['payments', /payment|payfi|remittance|real world assets|\brwa\b|credit|lending protocol/i],
  ['ai_data', /artificial intelligence|\bai\b|machine learning|data|inference/i],
  ['gaming', /gaming|gamefi|metaverse|play to earn|nft game/i],
  ['infrastructure', /layer 1|layer 2|\bl1\b|\bl2\b|infrastructure|oracle|depin|interoperab|bridge|storage|zero knowledge|rollup|modular|smart contract platform/i],
  ['defi', /decentralized finance|\bdefi\b|decentralized exchange|\bdex\b|yield|liquid staking|derivatives|lending|borrowing/i],
];

function sectorGuess(categories) {
  const text = (categories || []).join(' | ');
  for (const [id, re] of GUESS) if (re.test(text)) return id;
  return 'other';
}

function candidateFrom(coin) {
  if (!coin || typeof coin.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,100}$/.test(coin.id)) return null;
  const homepage = coin.links && Array.isArray(coin.links.homepage) ? coin.links.homepage.find((u) => typeof u === 'string' && /^https?:\/\//.test(u)) || null : null;
  const platforms = Object.entries(coin.platforms || {})
    .filter(([chain, addr]) => chain && typeof addr === 'string' && addr.trim())
    .map(([chain, addr]) => ({ chain, address: addr.trim() }))
    .slice(0, 12);
  const categories = (Array.isArray(coin.categories) ? coin.categories : []).filter((c) => typeof c === 'string').slice(0, 12);
  return {
    coingecko_id: coin.id,
    name: coin.name ? String(coin.name).slice(0, 120) : coin.id,
    symbol: coin.symbol ? String(coin.symbol).toUpperCase().slice(0, 20) : null,
    market_cap_rank: Number.isInteger(coin.market_cap_rank) ? coin.market_cap_rank : null,
    homepage,
    platforms,
    native: platforms.length === 0,
    categories,
    sector_guess: sectorGuess(categories),
    coingecko_url: `https://www.coingecko.com/en/coins/${coin.id}`,
    score: 0,
    reasons: [],
  };
}

const DETAIL_Q = '?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false';

// Candidates for what the request names, best first, each with its reasons.
// An exact CoinGecko link or contract is looked up directly; names and slugs
// are searched, and the best three are shown with their details.
async function findCandidates(ws, hints, { fetchImpl = fetch, cg = cgGet } = {}) {
  const out = new Map();
  const add = (cand, points, reason) => {
    if (!cand) return;
    const cur = out.get(cand.coingecko_id) || cand;
    cur.score += points;
    if (reason && !cur.reasons.includes(reason)) cur.reasons.push(reason);
    out.set(cand.coingecko_id, cur);
  };
  if (hints.coingecko_id) {
    add(candidateFrom(await cg(ws, `/coins/${encodeURIComponent(hints.coingecko_id)}${DETAIL_Q}`, fetchImpl)), 100, 'The CoinGecko link names this coin.');
  }
  if (hints.platform && hints.address) {
    add(candidateFrom(await cg(ws, `/coins/${encodeURIComponent(hints.platform)}/contract/${encodeURIComponent(hints.address)}`, fetchImpl)), 120, `CoinGecko lists this exact contract on ${hints.platform}.`);
  }
  const exact = out.size > 0;
  const queries = exact ? [] : [...new Set([hints.slug && hints.slug.replace(/-/g, ' '), hints.name, hints.symbol].filter(Boolean))].slice(0, 2);
  for (const q of queries) {
    const body = await cg(ws, `/search?query=${encodeURIComponent(q.slice(0, 80))}`, fetchImpl);
    const coins = (body && Array.isArray(body.coins) ? body.coins : []).slice(0, 6);
    for (const c of coins) {
      if (!c || typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,100}$/.test(c.id)) continue;
      const exactSlug = hints.slug && c.id === hints.slug;
      const sameName = c.name && hints.slug && slugify(c.name) === hints.slug;
      const nameMatch = c.name && hints.name && slugify(c.name) === slugify(hints.name);
      const symMatch = c.symbol && hints.symbol && String(c.symbol).toLowerCase() === String(hints.symbol).toLowerCase();
      let points = 10;
      const why = [];
      if (exactSlug) { points += 60; why.push('Its CoinGecko ID equals the name in the CoinMarketCap link.'); }
      if (sameName) { points += 40; why.push('Its name matches the CoinMarketCap link.'); }
      if (nameMatch) { points += 40; why.push(hints.name_from === 'screenshot' ? 'Its name matches the screenshot.' : 'Its name matches what you typed.'); }
      if (symMatch) { points += 25; why.push('Its ticker matches.'); }
      if (Number.isInteger(c.market_cap_rank)) points += 5;
      const existing = out.get(c.id);
      if (existing) { existing.score += points - 10; for (const w of why) if (!existing.reasons.includes(w)) existing.reasons.push(w); continue; }
      out.set(c.id, { coingecko_id: c.id, name: c.name || c.id, symbol: c.symbol ? String(c.symbol).toUpperCase() : null, market_cap_rank: Number.isInteger(c.market_cap_rank) ? c.market_cap_rank : null, score: points, reasons: why.length ? why : ['A CoinGecko search result for the name.'], partial: true });
    }
  }
  // Details (homepage, networks, contracts) for the best three, so Eric sees
  // exactly what he confirms. A candidate without details is not offered.
  const ranked = [...out.values()].sort((a, b) => b.score - a.score).slice(0, 3);
  const detailed = [];
  for (const c of ranked) {
    const full = c.partial ? candidateFrom(await cg(ws, `/coins/${encodeURIComponent(c.coingecko_id)}${DETAIL_Q}`, fetchImpl)) : c;
    if (!full) continue;
    if (c.partial) {
      full.score = c.score;
      full.reasons = c.reasons;
    }
    if (hints.address && !full.reasons.some((r) => /exact contract/.test(r)) && full.platforms.some((p) => p.address.toLowerCase() === String(hints.address).toLowerCase())) {
      full.score += 80;
      full.reasons.push('Its contract address matches the one in the request.');
    }
    detailed.push(full);
  }
  return detailed.sort((a, b) => b.score - a.score);
}

// Two candidates close in score, or sharing a ticker, are shown as ambiguous.
function isAmbiguous(cands) {
  if (cands.length < 2) return false;
  const [a, b] = cands;
  return b.score >= a.score - 20 || Boolean(a.symbol && b.symbol && a.symbol === b.symbol);
}

// ---------------------------------------------------------------------------
// Identification (runs after the request is saved; safe to repeat)

function readPrices(ws) {
  const cfg = (ws.settings.research.providers || {}).claude || {};
  const money = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  return {
    model: ws.settings.research.identify_model || cfg.model || IDENTIFY_MODEL_DEFAULT,
    prices: { input_usd_per_mtok: money(cfg.input_usd_per_mtok), output_usd_per_mtok: money(cfg.output_usd_per_mtok), cache_write_usd_per_mtok: money(cfg.cache_write_usd_per_mtok), cache_read_usd_per_mtok: money(cfg.cache_read_usd_per_mtok) },
  };
}

// The most one screenshot read may cost, or null without Claude's prices.
function readReservation(ws) {
  const { prices } = readPrices(ws);
  if (prices.input_usd_per_mtok === null || prices.output_usd_per_mtok === null) return null;
  return round4((READ_INPUT_TOKENS / 1e6) * prices.input_usd_per_mtok + (READ_OUTPUT_TOKENS / 1e6) * prices.output_usd_per_mtok);
}

async function readScreenshot(ws, doc, { fetchImpl, identifyImpl = null }) {
  const research = require('./research');
  const providers = require('./providers');
  const key = providers.apiKeyFor('claude');
  if (!key) return { ok: false, reason: 'Reading a screenshot needs the Claude API key, which is not set up yet. Type the name or paste the CoinMarketCap link instead.' };
  const { model, prices } = readPrices(ws);
  const reservation = readReservation(ws);
  if (reservation === null) return { ok: false, reason: 'Reading a screenshot is a paid Claude call, and Claude\'s token prices are not set in Settings yet.' };
  const runId = `intake_${doc.intake_id}`;
  // Admission against the research limits and the dispatch marker in one
  // locked save, written before anything is sent.
  let refused = null;
  let n = 0;
  mutate(ws, doc.intake_id, `Read screenshot for ${doc.intake_id}`, (d) => {
    const check = research.budgetCheck(ws, reservation, {});
    if (!check.ok) {
      refused = check.reason;
      d.identity = { ...(d.identity || {}), screenshot_read: { phase: 'refused', at: nowIso(), reason: check.reason } };
      event(d, `Screenshot not read: ${check.reason}`);
      return;
    }
    n = ((d.identity && d.identity.screenshot_attempts) || 0) + 1;
    d.identity = { ...(d.identity || {}), screenshot_attempts: n, screenshot_read: { phase: 'dispatched', n, at: nowIso(), model, reserved_usd: reservation } };
    event(d, 'Reading the screenshot with Claude.');
    research.spendLine(ws, { run_id: runId, provider: 'claude', attempt: n, kind: 'reservation', model, estimate_usd: reservation, actual_usd: null, note: 'screenshot identification; reserved before the call, counts until the actual cost is known' });
  });
  if (refused) return { ok: false, reason: `Not read: ${refused}` };
  const image = fs.readFileSync(ws.abs(doc.input.screenshot.file));
  const call = identifyImpl || providers.identifyImage;
  let res;
  try {
    res = await call({ model, imageBase64: image.toString('base64'), mediaType: doc.input.screenshot.media_type, key, signal: AbortSignal.timeout(120000), fetchImpl });
  } catch (err) {
    const usage = err.usage || null;
    const actual = usage ? research.actualCostUsd(ws, 'claude', usage, { prices }) : null;
    const notSent = err.kind === 'config' || Boolean(err.notSent);
    const answered = ['http', 'empty', 'incomplete', 'refused'].includes(err.kind);
    const phase = notSent ? 'not_sent' : answered ? 'failed' : 'uncertain';
    if (notSent) research.spendLine(ws, { run_id: runId, provider: 'claude', attempt: n, kind: 'release', model, actual_usd: 0, note: `screenshot identification not sent: ${err.message}` });
    else if (actual !== null) research.spendLine(ws, { run_id: runId, provider: 'claude', attempt: n, kind: 'actual', model, actual_usd: actual, usage, note: `screenshot identification failed: ${err.message}` });
    // Otherwise the reservation keeps counting: a timeout may have been billed.
    mutate(ws, doc.intake_id, `Screenshot read failed for ${doc.intake_id}`, (d) => {
      d.identity.screenshot_read = { ...d.identity.screenshot_read, phase, error: err.message, cost_actual_usd: actual, finished_at: nowIso() };
      event(d, phase === 'uncertain' ? 'The screenshot read was interrupted; it may have been billed and is not repeated by itself.' : `The screenshot could not be read: ${err.message}`);
    });
    return { ok: false, reason: phase === 'uncertain' ? `The screenshot read did not finish (${err.message}). It may have been billed, so it is not repeated by itself; use Try again to read it once more.` : `The screenshot could not be read: ${err.message}` };
  }
  const actual = research.actualCostUsd(ws, 'claude', res.usage, { prices });
  research.spendLine(ws, { run_id: runId, provider: 'claude', attempt: n, kind: 'actual', model, actual_usd: actual, usage: res.usage, note: 'screenshot identification' });
  const f = res.fields || {};
  const clean = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const fields = {
    project_name: clean(f.project_name, 120),
    symbol: clean(f.symbol, 20),
    chain: clean(f.chain, 60),
    contract_address: clean(f.contract_address, 100),
    website: clean(f.website, 200),
    coinmarketcap_url: clean(f.coinmarketcap_url, 300),
    coingecko_url: clean(f.coingecko_url, 300),
    confidence: ['high', 'medium', 'low'].includes(f.confidence) ? f.confidence : 'low',
    visible_text: clean(f.visible_text, 600),
    notes: clean(f.notes, 400),
  };
  mutate(ws, doc.intake_id, `Screenshot read for ${doc.intake_id}`, (d) => {
    d.identity.screenshot_read = { ...d.identity.screenshot_read, phase: 'read', fields, cost_actual_usd: actual, model_attested: (res.attested && res.attested.model) || null, finished_at: nowIso() };
    event(d, `Screenshot read: ${fields.project_name || 'no project name visible'}${fields.symbol ? ` (${fields.symbol})` : ''}.`);
  });
  return { ok: true, fields, cost_actual_usd: actual };
}

async function identify(ws, id, { fetchImpl = fetch, identifyImpl = null, cg = cgGet } = {}) {
  let doc = readIntake(ws, id);
  if (doc.status !== 'identifying') return doc;
  const hints = {};
  const p = doc.input.parsed;
  if (p) {
    if (p.slug) hints.slug = p.slug;
    if (p.coingecko_id) hints.coingecko_id = p.coingecko_id;
    if (p.address) hints.address = p.address;
    if (p.platform && p.address) hints.platform = p.platform;
    if (p.source === 'text') { hints.name = p.query; hints.name_from = 'typed'; }
  }
  const notes = [];
  if (p && p.source === 'coinmarketcap_dexscan' && !p.platform) notes.push(`The network "${p.chain}" in the link is not mapped to CoinGecko yet; the contract is matched by search instead.`);
  if (doc.input.link_problem) notes.push(doc.input.link_problem);
  if (doc.input.screenshot) {
    let prev = doc.identity && doc.identity.screenshot_read;
    if (prev && prev.phase === 'dispatched') {
      // A read was marked as sent and never finished (the server stopped):
      // it may have been billed, so it is held, never repeated by itself.
      doc = mutate(ws, id, `Hold interrupted screenshot read for ${id}`, (d) => {
        d.identity.screenshot_read = { ...d.identity.screenshot_read, phase: 'uncertain', error: 'Interrupted before an answer was saved.', finished_at: nowIso() };
        event(d, 'An earlier screenshot read was interrupted; it may have been billed and is not repeated by itself.');
      });
      prev = doc.identity.screenshot_read;
    }
    let read = prev && prev.phase === 'read' ? { ok: true, fields: prev.fields } : null;
    if (prev && prev.phase === 'uncertain') read = { ok: false, reason: 'An earlier screenshot read was interrupted and may have been billed; it is not repeated by itself. Use Try again to read it once more.' };
    if (prev && prev.phase === 'failed') read = { ok: false, reason: `The screenshot could not be read: ${prev.error}` };
    if (!read) read = await readScreenshot(ws, doc, { fetchImpl, identifyImpl });
    if (read.ok) {
      const f = read.fields;
      if (f.project_name && !hints.name) { hints.name = f.project_name; hints.name_from = 'screenshot'; }
      if (f.symbol) hints.symbol = f.symbol;
      if (f.contract_address && !hints.address) hints.address = f.contract_address;
      const fromCmc = f.coinmarketcap_url ? parseLink(f.coinmarketcap_url) : null;
      if (fromCmc && fromCmc.slug && !hints.slug) hints.slug = fromCmc.slug;
      const fromCg = f.coingecko_url ? parseLink(f.coingecko_url) : null;
      if (fromCg && fromCg.coingecko_id && !hints.coingecko_id) hints.coingecko_id = fromCg.coingecko_id;
      if (f.confidence === 'low') notes.push('The screenshot does not clearly name one project.');
    } else {
      notes.push(read.reason);
    }
  }
  if (!hints.slug && !hints.coingecko_id && !hints.name && !hints.symbol && !hints.address) {
    return mutate(ws, id, `Identity not found for ${id}`, (d) => {
      d.status = 'identity_failed';
      d.identity = { ...(d.identity || {}), hints, candidates: [], ambiguous: false, notes, error: notes.join(' ') || 'Nothing in the request names a project.', looked_up_at: nowIso() };
      event(d, 'No project could be identified from this request.');
    });
  }
  let candidates;
  try {
    candidates = await findCandidates(ws, hints, { fetchImpl, cg });
  } catch (err) {
    return mutate(ws, id, `Identity lookup failed for ${id}`, (d) => {
      d.status = 'identity_failed';
      d.identity = { ...(d.identity || {}), candidates: [], hints, notes, error: err.message, looked_up_at: nowIso() };
      event(d, `Lookup failed: ${err.message}`);
    });
  }
  doc = mutate(ws, id, `Identity candidates for ${id}`, (d) => {
    d.status = candidates.length ? 'needs_confirmation' : 'identity_failed';
    d.identity = {
      ...(d.identity || {}),
      hints,
      candidates: candidates.slice(0, 3),
      ambiguous: isAmbiguous(candidates),
      notes,
      error: candidates.length ? null : 'CoinGecko lists no coin for this request. Check the link or name, or add the project by hand.',
      looked_up_at: nowIso(),
    };
    event(d, candidates.length ? `${candidates.length} candidate${candidates.length === 1 ? '' : 's'} found; waiting for your confirmation.` : 'No CoinGecko listing found.');
  });
  return doc;
}

// ---------------------------------------------------------------------------
// Confirmation: project + one Claude research run

// The models a confirmed request is researched with: Claude always; ChatGPT
// and Gemini as well when their paid API is set up on this desk (they then run
// by themselves in the background), or when Eric's instructions ask for all
// three models (a model without an API then waits for its assistant).
const ALL_THREE_WORDS = /\b(all (three|3)|three|3)\s+(of the\s+)?(models|ais?|assistants|llms)\b|\bclaude\b.{0,40}\b(chat\s?gpt|gpt)\b.{0,40}\bgemini\b/i;

function intakeModels(ws, doc) {
  const st = require('./research').providerStatus(ws);
  const askedAll = ALL_THREE_WORDS.test(String((doc.input && doc.input.instructions) || ''));
  return ['claude', ...['chatgpt', 'gemini'].filter((p) => askedAll || (st[p] && (st[p].mode === 'api' || st[p].mode === 'mock')))];
}

function confirmIntake(ws, id, { coingecko_id: chosen, sector = null, different_project = false } = {}) {
  const doc = readIntake(ws, id);
  if (doc.status !== 'needs_confirmation') {
    if (doc.confirmed && doc.confirmed.coingecko_id === chosen) return { status: 'unchanged', intake: doc, project_id: doc.confirmed.project_id, run_id: doc.confirmed.run_id };
    throw new OpError('INVALID', doc.status === 'identifying' ? 'The project is still being identified.' : `This request is ${doc.status.replace(/_/g, ' ')}, not waiting for a confirmation.`);
  }
  const cand = (doc.identity.candidates || []).find((c) => c.coingecko_id === chosen);
  if (!cand) throw new OpError('INVALID', 'Choose one of the candidates shown for this request.');
  const sectorId = sector ? parseSector(sector) : cand.sector_guess;
  if (sector && !sectorId) throw new OpError('INVALID', 'Unknown sector.');
  const projects = require('./projects');
  const evidence = [{ url: cand.coingecko_url, note: `CoinGecko listing for ${cand.name}${cand.symbol ? ` (${cand.symbol})` : ''}, chosen and confirmed by Eric from a research request`, kind: 'owner_confirmed' }];
  if (doc.input.link && /^https?:\/\//.test(doc.input.link)) evidence.push({ url: doc.input.link, note: 'The link Eric submitted', kind: 'user' });
  const assets = cand.platforms.map((x) => ({ chain: x.chain, contract_address: x.address }));
  const added = projects.addProject(ws, {
    name: cand.name,
    symbol: cand.symbol,
    official_website: cand.homepage,
    coingecko_id: cand.coingecko_id,
    assets,
    evidence,
    sector: { primary: sectorId, tags: cand.categories.slice(0, 8), source: sector ? 'owner' : 'suggested' },
    unknowns: cand.homepage ? [] : ['CoinGecko lists no official website for this coin.'],
    utterance: doc.input.instructions || doc.input.link || 'research request',
    allow_same_symbol: Boolean(different_project),
  });
  if (added.status === 'possible_duplicate') {
    const names = (added.candidates || []).map((c) => `${c.name} (${c.project_id})`).join(', ');
    throw new OpError('AMBIGUOUS', `Your records already have a project with the ticker ${cand.symbol}: ${names}. Tickers are not unique. If ${cand.name} is a different project, confirm again with "This is a different project".`, { same_symbol: added.candidates || [] });
  }
  const projectId = added.project_id;
  if (added.status === 'exists') {
    // The same project by name, website, contract or CoinGecko ID. A binding
    // to another coin is never replaced from here.
    const p = projects.getProject(ws, projectId);
    const idn = p.identity || {};
    if (idn.status === 'verified' && idn.coingecko_id && idn.coingecko_id !== chosen) {
      throw new OpError('CONFLICT', `${cand.name} matches ${p.name} (${projectId}) in your records (${(added.matched_on || []).join(', ') || 'same project'}), which is bound to the CoinGecko coin "${idn.coingecko_id}", not "${chosen}". Nothing was researched. Check which one you mean on the project page.`);
    }
    if (idn.status !== 'verified') {
      // A market listing stored as the website (an older record) is not the
      // project's own site: CoinGecko's homepage for the chosen coin is.
      const site = idn.official_website && !projects.isNonOfficialHost(idn.official_website) ? idn.official_website : cand.homepage;
      projects.updateIdentity(ws, projectId, { coingecko_id: chosen, official_website: site, assets, evidence });
    }
  }
  const research = require('./research');
  const models = intakeModels(ws, doc);
  const run = research.createRun(ws, { project_id: projectId, providers: models, channel: 'intake', utterance: doc.input.instructions || doc.input.link || null, owner_instructions: doc.input.instructions || null });
  const { PROVIDER_LABELS } = require('./workspace');
  const named = models.map((p) => PROVIDER_LABELS[p]).join(', ').replace(/, ([^,]*)$/, ' and $1');
  const out = mutate(ws, id, `Confirm ${chosen} for ${id}`, (d) => {
    d.status = 'researching';
    d.confirmed = { coingecko_id: chosen, name: cand.name, symbol: cand.symbol, at: nowIso(), project_id: projectId, project_status: added.status, run_id: run.run_id, run_status: run.status, models };
    event(d, `${cand.name} confirmed. ${added.status === 'exists' ? 'It was already in your records.' : 'Added to your watchlist.'} ${run.status === 'exists' ? 'A research run for it had already started a few minutes ago.' : `Research requested from ${named}.`}`);
  });
  return { status: 'confirmed', intake: out, project_id: projectId, project_status: added.status, run_id: run.run_id, run: run.run };
}

function dismissIntake(ws, id) {
  return mutate(ws, id, `Dismiss ${id}`, (d) => {
    if (!OPEN.has(d.status)) throw new OpError('INVALID', 'Research has already started for this request; cancel the research job on the project page instead.');
    d.status = 'canceled';
    event(d, 'Dismissed.');
  });
}

function retryIdentify(ws, id) {
  return mutate(ws, id, `Retry identity for ${id}`, (d) => {
    if (!['identity_failed', 'needs_confirmation'].includes(d.status)) throw new OpError('INVALID', `This request is ${d.status.replace(/_/g, ' ')}.`);
    d.status = 'identifying';
    // A screenshot that was not read (or whose read may have been billed) is
    // read once more only because Eric asked; a finished read is reused.
    if (d.identity && d.identity.screenshot_read && d.identity.screenshot_read.phase !== 'read') d.identity.screenshot_read = null;
    event(d, 'Identifying again.');
  });
}

// Asks Claude again for a request whose research failed or is uncertain.
function retryResearch(ws, id) {
  const doc = readIntake(ws, id);
  if (!doc.confirmed) throw new OpError('INVALID', 'Research has not started for this request.');
  const out = require('./research').retryJob(ws, doc.confirmed.project_id, doc.confirmed.run_id, 'claude');
  settle(ws, { only: id });
  return { ...out, intake: readIntake(ws, id) };
}

// ---------------------------------------------------------------------------
// Progress, for the page: the request plus its research job's live state.

function progressOf(ws, doc) {
  if (!doc || doc.broken) return doc;
  const view = { ...doc };
  delete view.fingerprint;
  const sr = doc.identity && doc.identity.screenshot_read;
  view.screenshot_cost_usd = sr && typeof sr.cost_actual_usd === 'number' ? sr.cost_actual_usd : sr && ['dispatched', 'uncertain'].includes(sr.phase) ? null : sr ? 0 : null;
  if (!doc.confirmed) return view;
  const c = doc.confirmed;
  let run = null;
  try {
    run = require('./research').loadRun(ws, c.project_id, c.run_id);
  } catch (_) {
    run = null;
  }
  const job = run && run.jobs ? run.jobs.claude : null;
  if (!job) return { ...view, research: { state: 'missing', message: 'The research run could not be read.' } };
  const attempts = job.attempts || [];
  const last = attempts[attempts.length - 1] || null;
  const charge = (a) => (a.phase === 'not_sent' ? 0 : typeof a.reconciled_usd === 'number' && a.phase === 'reconciled' ? a.reconciled_usd : typeof a.cost_actual_usd === 'number' ? a.cost_actual_usd : typeof a.reserved_usd === 'number' ? a.reserved_usd : 0);
  const known = attempts.filter((a) => a.phase === 'not_sent' || typeof a.cost_actual_usd === 'number' || a.phase === 'reconciled');
  view.research = {
    run_id: run.run_id,
    project_id: run.project_id,
    // Every model in the run (Claude's job below is the request's own).
    models: Object.fromEntries(Object.entries(run.jobs).map(([p, j]) => [p, { state: j.state, mode: j.mode || null, report_id: j.report_id || null, error: j.error || null }])),
    state: job.state,
    mode: job.mode,
    error: job.error || null,
    note: job.note || null,
    report_id: job.report_id || null,
    attempts: attempts.length,
    max_attempts: job.max_attempts || null,
    phase: last ? last.phase || null : null,
    started_at: last ? last.dispatched_at || last.started_at || null : null,
    finished_at: last ? last.finished_at || null : null,
    model: last ? last.model_attested || last.model || null : job.model || null,
    usage: last && last.usage ? last.usage : null,
    cost: {
      reserved_usd: round4(attempts.reduce((s, a) => s + (a.phase !== 'not_sent' && typeof a.reserved_usd === 'number' ? a.reserved_usd : 0), 0)),
      counted_usd: round4(attempts.reduce((s, a) => s + charge(a), 0)),
      recorded_usd: known.length === attempts.length && attempts.length ? round4(attempts.reduce((s, a) => s + charge(a), 0)) : null,
      all_recorded: known.length === attempts.length,
      note: 'Reserved is the most each attempt was allowed to cost before it was sent; recorded is what Anthropic reported for it. Until every attempt is recorded, the limits count the reservation.',
    },
    horizon: run.horizon ? run.horizon.text : null,
    horizon_window: run.horizon && run.horizon.start_date ? `${run.horizon.start_date} to ${run.horizon.end_date}` : null,
    instructions: run.owner_instructions || null,
  };
  return view;
}

const STATE_TO_STATUS = { completed: 'done', failed: 'failed', canceled: 'failed', queued: 'researching', dispatching: 'researching', running: 'researching', uncertain: 'researching', unconfigured: 'researching' };

// Keeps each confirmed request's status in step with its research job
// (called by the server after research work and when a page asks).
function settle(ws, { only = null } = {}) {
  const changed = [];
  for (const d of listIntakes(ws, { limit: 50 })) {
    if (d.broken || !d.confirmed || (only && d.intake_id !== only)) continue;
    // Done is final: a completed job is never reopened.
    if (!['researching', 'failed'].includes(d.status)) continue;
    const v = progressOf(ws, d);
    const st = v.research && v.research.state;
    const next = STATE_TO_STATUS[st];
    if (!next || next === d.status) continue;
    mutate(ws, d.intake_id, `${next} ${d.intake_id}`, (x) => {
      x.status = next;
      if (next === 'done') { x.report_id = v.research.report_id; event(x, 'Report saved.'); }
      else if (next === 'failed') event(x, `Research ${st}: ${v.research.error || 'no detail'}`);
      else event(x, 'Research queued again.');
    });
    changed.push(d.intake_id);
  }
  return changed;
}

module.exports = { DIR, intakeModels, isIntakeId, parseLink, createIntake, readIntake, listIntakes, pendingIdentify, identify, findCandidates, confirmIntake, dismissIntake, retryIdentify, retryResearch, progressOf, settle, sectorGuess, isAmbiguous, readReservation, cgGet, MEDIA, MAX_IMAGE_BYTES };
