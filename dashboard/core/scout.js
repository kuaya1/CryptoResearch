'use strict';
// Grok Scout (Eric, 2026-10-26; audits/2026-10-26-grok-scout): a daily sweep
// by Grok (dashboard/scripts/grok-cron.js, run by .github/workflows/
// scout-cron.yml) of tools, repositories and write-ups in four fixed lanes,
// delivered to the online desk and kept on its own disk under scout/. No
// Supabase. The front door serves
// its two routes before sign-in, with the desk's own ingest key
// (DESK_INGEST_KEY, read from the environment on every request).
//
// A delivered brief is kept whole and never rewritten (scout/briefs/); the
// current list (scout/items.json) is replaced in the same verified save: one
// item per repository (else per page), its first sighting kept, nothing
// deleted. What Grok sends is web content: data, never an instruction. It
// starts no research, task or backlog item. The checks are of shape (plain
// lines, https addresses, known lanes and readiness), never of truth, and one
// bad field refuses the whole brief with nothing saved.

const crypto = require('crypto');
const { runOp, OpError } = require('./ops');
const { readJson, jsonText, sha256 } = require('./fsx');

const ITEMS_REL = 'scout/items.json';
const BRIEFS = 'scout/briefs';
const BRIEF_SCHEMA = 'cr.scout-brief.v1';
const ITEMS_SCHEMA = 'cr.scout-items.v1';
const RECORD_SCHEMA = 'cr.scout-brief-record.v1';
const BRIEF_PATH = '/api/ingest/scout-brief';
// Eric's four lanes (2026-10-26); their scope is in the frozen prompt
// (templates/scout/scout-prompt.v1.md).
const LANES = ['agents', 'onchain', 'desk', 'security'];
const READINESS = ['production', 'beta', 'experimental', 'research'];
const PROMPTS = ['cr-scout-prompt@1'];
const LIMITS = { title: 120, creator: 80, summary: 600, desk_leverage: 280, url: 300, items: 40, per_lane: 10, body: 64 * 1024 };
const USAGE_FIELDS = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_tokens', 'web_search_calls', 'x_search_posts'];
const MAX_PER_DAY = 6;
const MIN_KEY_CHARS = 32;
const LOCK_FAILURES = 10;
const LOCK_WINDOW_MS = 15 * 60000;
// xAI's prices as read from docs.x.ai on 2026-10-26 (USD per million tokens;
// tools per call or per post). A request whose prompt reaches 200,000 tokens
// is billed at twice these rates. Frozen: new prices are a new version. The
// desk's figure is an estimate from xAI's own usage counts; xAI's Usage page
// is the bill.
const PRICES = {
  id: 'cr-scout-prices@1',
  read_on: '2026-10-26',
  source: 'https://docs.x.ai/docs/models',
  models: {
    'grok-4.3': { input: 1.25, cached: 0.2, output: 2.5 },
    'grok-4.7': { input: 2, cached: 0.5, output: 6 },
  },
  web_search_per_call: 0.005,
  x_search_per_post: 0.005,
  long_prompt_tokens: 200000,
};
// Hosts whose first two path segments name a repository.
const REPO_HOSTS = new Set(['github.com']);
// Control characters, line breaks, and the zero-width and text-direction
// marks that display text in another order than it is stored (review N10).
// eslint-disable-next-line no-control-regex
const NOT_PLAIN = /[\u0000-\u001f\u007f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const chars = (s) => [...s].length;

function plainLine(v, name, max, errors, { required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) errors.push(`${name}: missing`);
    return null;
  }
  if (typeof v !== 'string') {
    errors.push(`${name}: must be text`);
    return null;
  }
  const s = v.trim();
  if (!s) {
    if (required) errors.push(`${name}: missing`);
    return null;
  }
  if (NOT_PLAIN.test(s)) errors.push(`${name}: must be one plain line (no line break, control, invisible or text-direction character)`);
  if (chars(s) > max) errors.push(`${name}: longer than ${max} characters`);
  return s;
}

function httpsUrl(v, name, errors, { required = true } = {}) {
  const s = plainLine(v, name, LIMITS.url, errors, { required });
  if (s === null) return null;
  if (/\s/.test(s)) {
    errors.push(`${name}: a web address has no spaces`);
    return null;
  }
  let u;
  try {
    u = new URL(s);
  } catch (_) {
    errors.push(`${name}: not a web address`);
    return null;
  }
  if (u.protocol !== 'https:') errors.push(`${name}: must start with https://`);
  if (u.username || u.password) errors.push(`${name}: carries a user name or password`);
  const host = u.hostname;
  if (!host.includes('.') || host.startsWith('[') || /^[\d.]+$/.test(host)) errors.push(`${name}: needs a host name, not an IP address`);
  if (u.port) errors.push(`${name}: names a port`);
  return s;
}

function uniqueLanes(v, name, errors) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    errors.push(`${name}: must be a list of lanes`);
    return [];
  }
  const out = [];
  for (const x of v) {
    if (!LANES.includes(x)) errors.push(`${name}: "${String(x).slice(0, 40)}" is not a lane (${LANES.join(', ')})`);
    else if (out.includes(x)) errors.push(`${name}: ${x} is listed twice`);
    else out.push(x);
  }
  return out;
}

const ITEM_FIELDS = ['lane', 'title', 'creator', 'url_primary', 'url_repo', 'summary', 'desk_leverage', 'readiness'];
function checkItem(raw, at, lanesRun, errors) {
  if (!isObj(raw)) {
    errors.push(`${at}: must be an object`);
    return null;
  }
  for (const k of Object.keys(raw)) if (!ITEM_FIELDS.includes(k)) errors.push(`${at}.${String(k).slice(0, 40)}: not a field of a scout item`);
  const lane = raw.lane;
  if (!LANES.includes(lane)) errors.push(`${at}.lane: not one of ${LANES.join(', ')}`);
  else if (lanesRun && !lanesRun.includes(lane)) errors.push(`${at}.lane: ${lane} is not in lanes_run`);
  const readiness = raw.readiness;
  if (!READINESS.includes(readiness)) errors.push(`${at}.readiness: not one of ${READINESS.join(', ')}`);
  return {
    lane,
    title: plainLine(raw.title, `${at}.title`, LIMITS.title, errors),
    creator: plainLine(raw.creator, `${at}.creator`, LIMITS.creator, errors, { required: false }),
    url_primary: httpsUrl(raw.url_primary, `${at}.url_primary`, errors),
    url_repo: httpsUrl(raw.url_repo, `${at}.url_repo`, errors, { required: false }),
    summary: plainLine(raw.summary, `${at}.summary`, LIMITS.summary, errors),
    desk_leverage: plainLine(raw.desk_leverage, `${at}.desk_leverage`, LIMITS.desk_leverage, errors),
    readiness,
  };
}

// One item as the sweep would send it: its problems, or none. The sweep drops
// an item with problems before posting, so the desk never refuses a brief
// for one bad item it could have left out.
function itemProblems(raw, lane) {
  const errors = [];
  checkItem(raw, 'item', lane ? [lane] : null, errors);
  return errors;
}

const BRIEF_FIELDS = ['schema_version', 'generated_at', 'prompt', 'model', 'lanes_run', 'lanes_missing', 'items', 'usage'];
// The brief as delivered, checked field by field: { brief, errors }. Nothing
// is fixed up; any error refuses the whole brief.
function checkBrief(body) {
  const errors = [];
  if (!isObj(body)) return { brief: null, errors: ['the brief must be a JSON object'] };
  for (const k of Object.keys(body)) if (!BRIEF_FIELDS.includes(k)) errors.push(`${String(k).slice(0, 40)}: not a field of a scout brief`);
  if (body.schema_version !== BRIEF_SCHEMA) errors.push(`schema_version: must be ${BRIEF_SCHEMA}`);
  const generated = plainLine(body.generated_at, 'generated_at', 40, errors);
  if (generated && !Number.isFinite(Date.parse(generated))) errors.push('generated_at: not a date and time');
  if (!PROMPTS.includes(body.prompt)) errors.push(`prompt: must be one of ${PROMPTS.join(', ')}`);
  if (typeof body.model !== 'string' || !/^grok-[a-z0-9][a-z0-9.-]{0,40}$/.test(body.model)) errors.push('model: must be a Grok model name');
  const lanesRun = uniqueLanes(body.lanes_run, 'lanes_run', errors);
  const lanesMissing = uniqueLanes(body.lanes_missing, 'lanes_missing', errors);
  for (const l of lanesMissing) if (lanesRun.includes(l)) errors.push(`lanes_missing: ${l} is also in lanes_run`);
  if (!lanesRun.length && !lanesMissing.length) errors.push('lanes_run: names no lane');
  let items = [];
  if (!Array.isArray(body.items)) errors.push('items: must be a list');
  else if (body.items.length > LIMITS.items) errors.push(`items: more than ${LIMITS.items}`);
  else {
    items = body.items.map((it, i) => checkItem(it, `items[${i}]`, lanesRun, errors));
    for (const l of lanesRun) if (items.filter((it) => it && it.lane === l).length > LIMITS.per_lane) errors.push(`items: more than ${LIMITS.per_lane} in lane ${l}`);
  }
  const usage = {};
  if (body.usage !== undefined && body.usage !== null) {
    if (!isObj(body.usage)) errors.push('usage: must be an object by lane');
    else {
      for (const [lane, u] of Object.entries(body.usage)) {
        if (!lanesRun.includes(lane) && !lanesMissing.includes(lane)) {
          errors.push(`usage.${String(lane).slice(0, 40)}: not a lane of this brief`);
          continue;
        }
        if (!isObj(u)) {
          errors.push(`usage.${lane}: must be an object`);
          continue;
        }
        const row = {};
        for (const [k, v] of Object.entries(u)) {
          if (!USAGE_FIELDS.includes(k)) errors.push(`usage.${lane}.${String(k).slice(0, 40)}: not a usage field`);
          else if (!Number.isInteger(v) || v < 0 || v > 1e9) errors.push(`usage.${lane}.${k}: must be a whole number from 0`);
          else row[k] = v;
        }
        usage[lane] = row;
      }
    }
  }
  if (errors.length) return { brief: null, errors };
  return {
    brief: { schema_version: BRIEF_SCHEMA, generated_at: generated, prompt: body.prompt, model: body.model, lanes_run: lanesRun, lanes_missing: lanesMissing, items, usage },
    errors,
  };
}

// The address an item is known by: its repository (on GitHub, owner and
// name without case), else its page. Host lower case without www., no .git,
// trailing slash or fragment; a page keeps its query.
function normUrl(s, { keepQuery = false } = {}) {
  const u = new URL(s);
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  let segs = u.pathname.split('/').filter(Boolean);
  const cut = segs.indexOf('-');
  if (cut >= 0) segs = segs.slice(0, cut);
  if (segs.length) segs[segs.length - 1] = segs[segs.length - 1].replace(/\.git$/i, '');
  segs = segs.filter(Boolean);
  if (REPO_HOSTS.has(host)) segs = segs.slice(0, 2).map((x) => x.toLowerCase());
  return `${host}${segs.length ? `/${segs.join('/')}` : ''}${keepQuery ? u.search : ''}`;
}
function itemKey(item) {
  return item.url_repo ? `repo:${normUrl(item.url_repo)}` : `page:${normUrl(item.url_primary, { keepQuery: true })}`;
}

const round4 = (x) => Math.round(x * 1e4) / 1e4;
// One request's estimated cost from xAI's own usage counts, or null when the
// model has no price here.
function usageCost(model, u) {
  const p = PRICES.models[model];
  if (!p || !u) return null;
  const input = u.input_tokens || 0;
  const cached = Math.min(u.cached_input_tokens || 0, input);
  const rate = input >= PRICES.long_prompt_tokens ? 2 : 1;
  const tokens = (((input - cached) * p.input) + (cached * p.cached) + ((u.output_tokens || 0) * p.output)) * rate / 1e6;
  return round4(tokens + (u.web_search_calls || 0) * PRICES.web_search_per_call + (u.x_search_posts || 0) * PRICES.x_search_per_post);
}
function briefCost(brief) {
  const lanes = Object.keys(brief.usage || {});
  if (!lanes.length) return { usd: null, basis: 'no usage reported' };
  if (!PRICES.models[brief.model]) return { usd: null, basis: `no price for ${brief.model} in ${PRICES.id}` };
  return { usd: round4(lanes.reduce((a, l) => a + usageCost(brief.model, brief.usage[l]), 0)), basis: PRICES.id };
}

function emptyState() {
  return { schema_version: ITEMS_SCHEMA, updated_at: null, briefs: [], items: [] };
}
function stateOf(v) {
  if (!isObj(v)) return emptyState();
  return { ...emptyState(), ...v, briefs: Array.isArray(v.briefs) ? v.briefs : [], items: Array.isArray(v.items) ? v.items : [] };
}
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
function briefsOn(state, t) {
  const d = dayOf(t);
  return state.briefs.filter((b) => String(b.received_at || '').slice(0, 10) === d).length;
}
function briefsToday(ws, t = Date.now()) {
  return briefsOn(stateOf(readJson(ws.abs(ITEMS_REL), null)), t);
}
const receiptOf = (e) => ({ brief_id: e.brief_id, received_at: e.received_at, items_new: e.items_new, items_updated: e.items_updated });

// Saves one delivered brief: the brief whole, and the list it updates, in one
// verified save. The same brief again is `unchanged` with its first receipt.
function ingest(ws, body, { now = Date.now() } = {}) {
  const { brief, errors } = checkBrief(body);
  if (errors.length) throw new OpError('INVALID', `The brief was refused (${errors.length} ${errors.length === 1 ? 'problem' : 'problems'}); nothing was saved.`, { errors });
  const sha = sha256(jsonText(brief));
  const at = new Date(now).toISOString();
  const out = runOp(ws, { type: 'scout_brief', summary: `Scout brief: ${brief.items.length} items` }, (op) => {
    const cur = stateOf(op.readJson(ITEMS_REL, null));
    const prior = cur.briefs.find((b) => b.sha256 === sha);
    if (prior) return { status: 'unchanged', ...receiptOf(prior) };
    if (briefsOn(cur, now) >= MAX_PER_DAY) throw new OpError('DAILY_LIMIT', `This desk takes at most ${MAX_PER_DAY} scout briefs a day (UTC); nothing was saved.`);
    const id = `sb-${at.slice(0, 10).replace(/-/g, '')}-${sha.slice(0, 10)}`;
    const byKey = new Map(cur.items.map((x) => [x.key, x]));
    const inBrief = new Set();
    let created = 0;
    let updated = 0;
    let duplicates = 0;
    for (const it of brief.items) {
      const key = itemKey(it);
      if (inBrief.has(key)) {
        duplicates += 1;
        continue;
      }
      inBrief.add(key);
      const was = byKey.get(key);
      const fields = { lane: it.lane, title: it.title, creator: it.creator, url_primary: it.url_primary, url_repo: it.url_repo, summary: it.summary, desk_leverage: it.desk_leverage, readiness: it.readiness };
      if (was) {
        byKey.set(key, { ...was, ...fields, key, last_seen: at, last_brief: id, times_seen: (Number(was.times_seen) || 1) + 1 });
        updated += 1;
      } else {
        byKey.set(key, { key, ...fields, first_seen: at, first_brief: id, last_seen: at, last_brief: id, times_seen: 1 });
        created += 1;
      }
    }
    const cost = briefCost(brief);
    const entry = {
      brief_id: id,
      sha256: sha,
      received_at: at,
      generated_at: brief.generated_at,
      prompt: brief.prompt,
      model: brief.model,
      lanes_run: brief.lanes_run,
      lanes_missing: brief.lanes_missing,
      items: brief.items.length,
      items_new: created,
      items_updated: updated,
      duplicates_in_brief: duplicates,
      cost_usd_estimate: cost.usd,
      cost_basis: cost.basis,
    };
    op.writeJson(`${BRIEFS}/${id}.json`, { schema_version: RECORD_SCHEMA, brief_id: id, received_at: at, sha256: sha, brief }, { mode: 'create' });
    op.writeJson(ITEMS_REL, { schema_version: ITEMS_SCHEMA, updated_at: at, briefs: [...cur.briefs, entry], items: [...byKey.values()] });
    return { status: 'saved', ...receiptOf(entry) };
  });
  return { ...out.result, verified: out.verified };
}

function deskKey(env = process.env) {
  const k = env.DESK_INGEST_KEY;
  return typeof k === 'string' && k.length >= MIN_KEY_CHARS ? k : null;
}
function keyProblem(env = process.env) {
  const k = env.DESK_INGEST_KEY;
  if (deskKey(env)) return null;
  return typeof k === 'string' && k.length ? `DESK_INGEST_KEY on the desk is ${k.length} characters; it needs at least ${MIN_KEY_CHARS}` : 'no DESK_INGEST_KEY on the desk';
}

// What the Research page and `scout list` show. Reading writes nothing.
function view(ws, { env = process.env } = {}) {
  const cur = stateOf(readJson(ws.abs(ITEMS_REL), null));
  const priced = cur.briefs.filter((b) => typeof b.cost_usd_estimate === 'number');
  const last = cur.briefs[cur.briefs.length - 1] || null;
  return {
    schema_version: 'cr.scout-view.v1',
    ingest: deskKey(env) ? 'ready' : 'not_set_up',
    lanes: LANES,
    readiness: READINESS,
    prices: PRICES.id,
    briefs: cur.briefs.length,
    last_brief: last,
    cost_usd_estimate_total: priced.length ? round4(priced.reduce((a, b) => a + b.cost_usd_estimate, 0)) : null,
    briefs_without_cost: cur.briefs.length - priced.length,
    items: cur.items.slice().sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)) || String(a.title).localeCompare(String(b.title))),
  };
}

// One line for the start log and doctor.
function statusLine(ws, { env = process.env, now = Date.now() } = {}) {
  const v = view(ws, { env });
  const key = keyProblem(env);
  const head = key ? `not set up (${key})` : 'ready';
  if (!v.last_brief) return `${head}; no brief yet`;
  const hours = Math.max(0, Math.round((now - Date.parse(v.last_brief.received_at)) / 3600000));
  const cost = v.cost_usd_estimate_total === null ? 'no cost reported' : `about $${v.cost_usd_estimate_total.toFixed(2)} estimated in total`;
  const n = v.last_brief.items;
  return `${head}; last brief ${v.last_brief.brief_id} ${hours} h ago (${n} ${n === 1 ? 'item' : 'items'}); ${v.briefs} ${v.briefs === 1 ? 'brief' : 'briefs'}, ${cost}`;
}

const keyHash = (k) => crypto.createHash('sha256').update(String(k), 'utf8').digest();

// A body read whole up to max bytes; past it, reading stops and the answer
// is 413 on a closed connection.
function readBounded(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks = [];
    const fail = (status, code, message) => {
      if (done) return;
      done = true;
      reject(Object.assign(new Error(message), { status, code }));
    };
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > max) {
        req.pause();
        return fail(413, 'TOO_LARGE', `The brief is larger than ${Math.round(max / 1024)} KB.`);
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        reject(Object.assign(new Error('The body is not JSON.'), { status: 400, code: 'INVALID' }));
      }
    });
    req.on('error', (e) => fail(400, 'READ_FAILED', e.message));
  });
}

// The one path the front door serves before sign-in, online only:
// /api/ingest/scout-brief. GET checks the key and today's count, costing
// nothing; POST delivers the brief. Both need the ingest key, never from a
// browser; ten refused keys in 15 minutes lock both. /api/ingest/ping is the
// desk's signed-in ping (backlog item 66), not this route.
function makeScoutRoute(ws, { env = process.env, log = () => {}, now = () => Date.now() } = {}) {
  const failures = [];
  const send = (req, res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(req.method === 'POST' && status !== 200 ? { Connection: 'close' } : {}) });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
  };
  const locked = () => {
    const t = now();
    while (failures.length && t - failures[0] > LOCK_WINDOW_MS) failures.shift();
    return failures.length >= LOCK_FAILURES;
  };
  const accepted = (req, key) => {
    const m = String(req.headers.authorization || '').match(/^Bearer (\S+)$/);
    return Boolean(m) && crypto.timingSafeEqual(keyHash(m[1]), keyHash(key));
  };
  const NOT_SET_UP = () => ({ error: `Scout ingest is not set up on this desk: ${keyProblem(env)}.`, code: 'NOT_SET_UP' });
  const LOCKED = { error: 'Too many refused ingest keys; try again in 15 minutes.', code: 'LOCKED' };
  const REFUSED = { error: 'The ingest key was refused.', code: 'REFUSED' };
  // True when it has answered (not set up, locked or refused).
  const refused = (req, res, key, what) => {
    if (!key) send(req, res, 404, NOT_SET_UP());
    else if (locked()) send(req, res, 429, LOCKED);
    else if (!accepted(req, key)) {
      failures.push(now());
      log(`Scout ${what} refused: wrong or missing ingest key.`);
      send(req, res, 401, REFUSED);
    } else return false;
    return true;
  };
  return async function handle(req, res, url) {
    if (req.headers.origin) return send(req, res, 403, { error: 'Not accepted from a browser.', code: 'REFUSED' });
    const key = deskKey(env);
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (refused(req, res, key, 'key check')) return undefined;
      return send(req, res, 200, { ok: true, key: 'accepted', briefs_today: briefsToday(ws, now()), max_per_day: MAX_PER_DAY });
    }
    if (req.method !== 'POST') return send(req, res, 405, { error: 'Method not allowed' });
    if (refused(req, res, key, 'brief')) return undefined;
    if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) return send(req, res, 415, { error: 'The brief must be sent as application/json.', code: 'INVALID' });
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > LIMITS.body) return send(req, res, 413, { error: `The brief is larger than ${Math.round(LIMITS.body / 1024)} KB.`, code: 'TOO_LARGE' });
    if (briefsToday(ws, now()) >= MAX_PER_DAY) return send(req, res, 429, { error: `This desk takes at most ${MAX_PER_DAY} scout briefs a day (UTC).`, code: 'DAILY_LIMIT' });
    let body;
    try {
      body = await readBounded(req, LIMITS.body);
    } catch (err) {
      return send(req, res, err.status || 400, { error: err.message, code: err.code || 'INVALID', saved: false });
    }
    try {
      const r = ingest(ws, body, { now: now() });
      log(`Scout brief ${r.status} (${r.brief_id}): ${r.items_new} new, ${r.items_updated} updated.`);
      return send(req, res, 200, r);
    } catch (err) {
      if (err.code === 'INVALID') {
        log(`Scout brief refused: ${err.details.errors.length} problems.`);
        return send(req, res, 400, { error: err.message, code: 'INVALID', errors: err.details.errors, saved: false });
      }
      if (err.code === 'DAILY_LIMIT') return send(req, res, 429, { error: err.message, code: 'DAILY_LIMIT', saved: false });
      throw err;
    }
  };
}

module.exports = {
  LANES,
  READINESS,
  PROMPTS,
  LIMITS,
  PRICES,
  MAX_PER_DAY,
  MIN_KEY_CHARS,
  BRIEF_SCHEMA,
  ITEMS_REL,
  BRIEFS,
  BRIEF_PATH,
  checkBrief,
  itemProblems,
  normUrl,
  itemKey,
  usageCost,
  briefCost,
  ingest,
  view,
  statusLine,
  deskKey,
  keyProblem,
  makeScoutRoute,
};
