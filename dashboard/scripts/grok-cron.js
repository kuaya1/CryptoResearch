#!/usr/bin/env node
'use strict';
// Grok Scout's daily sweep (Eric, 2026-10-26; audits/2026-10-26-grok-scout;
// run by .github/workflows/scout-cron.yml). One request per lane to xAI's
// Responses API with its web_search tool, under the frozen prompt
// cr-scout-prompt@1 (checked against templates/scout/LOCK.json before
// anything is sent), then one brief to the online desk's front door
// (core/scout.js). It holds the xAI key and makes the paid call.
//
// Before any paid call it checks its ingest key with the desk; a desk that
// refuses the key, is not set up or has taken its briefs for the day stops
// the sweep with nothing spent. One attempt per lane, never retried; a lane
// that fails is reported missing, with what it used. Only posting the brief
// (free, and the same brief again is `unchanged`) is tried again.
//
// What Grok returns is web content: each item is checked as the desk checks
// it and dropped when it does not pass, never fixed beyond collapsing spaces.
// The output names counts only (the repository is public, so are its logs):
// no item text, no address, no key and no desk address.
//
// `--dry-run` needs no key and sends nothing: it prints each request exactly
// as it would be sent and the estimated cost range (with --leads or SCOUT_LEADS
// on, the leads request and what it adds).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const S = require('../core/scout');

const MODEL = 'grok-4.3';
const XAI_URL = 'https://api.x.ai/v1/responses';
const PROMPT_ID = 'cr-scout-prompt@1';
const TEMPLATES = path.join(__dirname, '..', '..', 'templates', 'scout');
const PROMPT_FILE = 'scout-prompt.v1.md';
const MAX_OUTPUT_TOKENS = 8000;
const LANE_TIMEOUT_MS = 180000;
const DESK_TIMEOUT_MS = 30000;
const POST_WAITS_MS = [0, 5000, 15000];
// The plan's working assumptions (PLAN.md "xAI cost"), for the dry run.
const ASSUME = {
  typical: { input_tokens: 150000, cached_input_tokens: 100000, output_tokens: 8000, web_search_calls: 10 },
  heavy: { input_tokens: 190000, cached_input_tokens: 110000, output_tokens: 15000, web_search_calls: 25 },
};
const ITEM_FIELDS = ['title', 'creator', 'url_primary', 'url_repo', 'summary', 'desk_leverage', 'readiness'];
// Scout leads (intake plan rev. 2, PR 3): a fifth call under its own frozen
// prompt, only with SCOUT_LEADS 'true' (Eric's repository variable) or
// --leads, after the brief and apart from it, so the brief's requests and its
// POST are the same with leads on or off, and a leads failure never touches
// the brief or the run's result.
const LEADS_PROMPT_ID = 'cr-scout-leads-prompt@1';
const LEADS_PROMPT_FILE = 'leads-prompt.v1.md';
const LEADS_PATH = '/api/ingest/scout-leads';
const LEADS_MAX = 10;
const LEAD_FIELDS = ['chain', 'contract', 'coingecko_id', 'signal', 'urls'];

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const fmt = (n) => Number(n || 0).toLocaleString('en-US');

// The prompt text, only when it matches its pin.
function promptTemplate(dir = TEMPLATES, file = PROMPT_FILE, id = PROMPT_ID) {
  const buf = fs.readFileSync(path.join(dir, file));
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'LOCK.json'), 'utf8'));
  const want = lock && lock.sha256 ? lock.sha256[file] : null;
  if (sha256(buf) !== want) throw Object.assign(new Error(`${id} does not match its pinned SHA-256; nothing was sent.`), { code: 'INTEGRITY' });
  return buf.toString('utf8');
}

function render(template, lane, today) {
  return template.split('{{LANE}}').join(lane).split('{{TODAY}}').join(today).split('{{MAX_ITEMS}}').join(String(S.LIMITS.per_lane));
}

function requestFor(template, lane, today) {
  return {
    model: MODEL,
    input: [
      { role: 'system', content: render(template, lane, today) },
      { role: 'user', content: `Run today's sweep for the lane ${lane}. Answer with the JSON object only.` },
    ],
    tools: [{ type: 'web_search' }],
    max_output_tokens: MAX_OUTPUT_TOKENS,
    store: false,
  };
}

// The chains a lead may name: each chain's first name in the desk's table.
function chainNames() {
  return require('../core/chains').TABLE.map((row) => row[3]).join(', ');
}
function leadsRequestFor(template, today) {
  const text = template.split('{{TODAY}}').join(today).split('{{MAX_LEADS}}').join(String(LEADS_MAX)).split('{{CHAINS}}').join(chainNames());
  return {
    model: MODEL,
    input: [
      { role: 'system', content: text },
      { role: 'user', content: 'Name today\'s leads. Answer with the JSON object only.' },
    ],
    tools: [{ type: 'web_search' }],
    max_output_tokens: MAX_OUTPUT_TOKENS,
    store: false,
  };
}

// The leads from the answer: { leads, dropped } or a reason. Only the five
// fields go on, the signal's spaces collapsed; the desk checks every row.
function leadsFrom(text) {
  const s = String(text || '');
  const from = s.indexOf('{');
  const to = s.lastIndexOf('}');
  if (from < 0 || to <= from) return { reason: 'the answer had no JSON object' };
  let obj;
  try {
    obj = JSON.parse(s.slice(from, to + 1));
  } catch (_) {
    return { reason: 'the answer was not valid JSON' };
  }
  if (!obj || !Array.isArray(obj.leads)) return { reason: 'the answer had no leads list' };
  const leads = [];
  let dropped = 0;
  for (const raw of obj.leads) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || leads.length >= LEADS_MAX) {
      dropped += 1;
      continue;
    }
    const it = {};
    for (const k of LEAD_FIELDS) {
      const v = raw[k];
      if (v === undefined) continue;
      it[k] = typeof v === 'string' ? (k === 'signal' ? v.replace(/[ \t\r\n]+/g, ' ').trim() : v.trim()) : v;
    }
    leads.push(it);
  }
  return { leads, dropped };
}

// The delivery's ID, made before it is sent and kept for its own retries: the
// workflow run and its attempt, else a local one.
function deliveryIdOf(env, now) {
  const run = String(env.GITHUB_RUN_ID || '');
  if (/^\d{1,20}$/.test(run)) return `gh-${run}-${/^\d{1,6}$/.test(String(env.GITHUB_RUN_ATTEMPT || '')) ? env.GITHUB_RUN_ATTEMPT : '1'}`;
  return `local-${new Date(now).toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
}

// xAI's usage, as the desk counts it. Output includes reasoning when the
// total says reasoning was counted apart; web searches from the tool usage
// xAI reports, else the search calls in the output.
function usageOf(resp) {
  const u = (resp && resp.usage) || {};
  const input = Number.isInteger(u.input_tokens) ? u.input_tokens : 0;
  const cached = Number.isInteger(u.input_tokens_details && u.input_tokens_details.cached_tokens) ? u.input_tokens_details.cached_tokens : 0;
  const output = Number.isInteger(u.output_tokens) ? u.output_tokens : 0;
  const reasoning = Number.isInteger(u.output_tokens_details && u.output_tokens_details.reasoning_tokens) ? u.output_tokens_details.reasoning_tokens : 0;
  const apart = reasoning > 0 && Number.isInteger(u.total_tokens) && u.total_tokens >= input + output + reasoning;
  let searches = 0;
  const tools = u.server_side_tool_usage || (resp && resp.server_side_tool_usage);
  if (tools && typeof tools === 'object') {
    for (const [k, v] of Object.entries(tools)) if (/WEB_SEARCH/i.test(k) && Number.isInteger(v)) searches += v;
  }
  if (!searches) searches = ((resp && Array.isArray(resp.output)) ? resp.output : []).filter((o) => o && o.type === 'web_search_call').length;
  if (!searches && Number.isInteger(u.num_server_side_tools_used)) searches = u.num_server_side_tools_used;
  return { input_tokens: input, cached_input_tokens: Math.min(cached, input), output_tokens: apart ? output + reasoning : output, reasoning_tokens: reasoning, web_search_calls: searches };
}

// The answer's text: output_text, else the message parts.
function answerText(resp) {
  if (resp && typeof resp.output_text === 'string') return resp.output_text;
  const parts = [];
  for (const o of (resp && Array.isArray(resp.output) ? resp.output : [])) {
    if (o && o.type === 'message' && Array.isArray(o.content)) for (const c of o.content) if (c && typeof c.text === 'string') parts.push(c.text);
  }
  return parts.join('\n');
}

// The lane's items from the answer: { items, dropped } or a reason.
function itemsFrom(text, lane) {
  const s = String(text || '');
  const from = s.indexOf('{');
  const to = s.lastIndexOf('}');
  if (from < 0 || to <= from) return { reason: 'the answer had no JSON object' };
  let obj;
  try {
    obj = JSON.parse(s.slice(from, to + 1));
  } catch (_) {
    return { reason: 'the answer was not valid JSON' };
  }
  if (!obj || !Array.isArray(obj.items)) return { reason: 'the answer had no items list' };
  if (obj.lane !== undefined && obj.lane !== lane) return { reason: 'the answer named another lane' };
  const items = [];
  let dropped = 0;
  for (const raw of obj.items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      dropped += 1;
      continue;
    }
    const it = { lane };
    for (const k of ITEM_FIELDS) {
      const v = raw[k];
      if (v === undefined || v === null || v === '') continue;
      it[k] = typeof v === 'string' ? (k.startsWith('url_') ? v.trim() : v.replace(/[ \t\r\n]+/g, ' ').trim()) : v;
    }
    if (items.length >= S.LIMITS.per_lane || S.itemProblems(it, lane).length) dropped += 1;
    else items.push(it);
  }
  return { items, dropped };
}

function deskOrigin(v) {
  let u;
  try {
    u = new URL(String(v || ''));
  } catch (_) {
    return null;
  }
  return u.protocol === 'https:' && (u.pathname === '/' || u.pathname === '') && !u.search && !u.username ? u.origin : null;
}

async function timed(fetchFn, url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetchFn(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
async function jsonOf(r) {
  try {
    return await r.json();
  } catch (_) {
    return null;
  }
}

function costRange(lanes) {
  const per = (a) => S.usageCost(MODEL, a);
  const lines = [];
  for (const [name, a] of Object.entries(ASSUME)) {
    const lane = per(a);
    lines.push(`${name}: $${lane.toFixed(2)} a lane, $${(lane * lanes).toFixed(2)} a day, about $${Math.round(lane * lanes * 30)} a month (${fmt(a.input_tokens)} input tokens, ${fmt(a.cached_input_tokens)} cached, ${fmt(a.output_tokens)} output, ${a.web_search_calls} web searches a lane)`);
  }
  return lines;
}

// One sweep. Returns { ok, status, ... }; `out` takes each line printed.
async function run({ env = process.env, fetch: fetchFn = globalThis.fetch, now = Date.now(), out = (l) => process.stdout.write(`${l}\n`), dryRun = false, lanes = S.LANES, templateDir = TEMPLATES, postWaits = POST_WAITS_MS, leads = null } = {}) {
  const template = promptTemplate(templateDir);
  out(`${PROMPT_ID} matches its pin.`);
  const today = new Date(now).toISOString().slice(0, 10);
  const requests = lanes.map((lane) => ({ lane, body: requestFor(template, lane, today) }));
  // The leads prompt, only when leads are on and it matches its pin; a
  // mismatch skips the leads, never the brief.
  const leadsOn = leads === null ? env.SCOUT_LEADS === 'true' : Boolean(leads);
  let leadsTemplate = null;
  let leadsSkip = null;
  if (leadsOn) {
    try {
      leadsTemplate = promptTemplate(templateDir, LEADS_PROMPT_FILE, LEADS_PROMPT_ID);
      out(`${LEADS_PROMPT_ID} matches its pin.`);
    } catch (err) {
      if (err.code !== 'INTEGRITY' && err.code !== 'ENOENT') throw err;
      leadsSkip = err.code === 'INTEGRITY' ? `${LEADS_PROMPT_ID} does not match its pin` : `${LEADS_PROMPT_FILE} is missing`;
      out(`Leads skipped: ${leadsSkip}. Nothing will be sent for leads.`);
    }
  }
  if (dryRun) {
    for (const r of requests) out(`--- Request for lane ${r.lane} (POST ${XAI_URL}):\n${JSON.stringify(r.body, null, 2)}`);
    out(`--- Estimated cost with ${MODEL} under ${S.PRICES.id} (xAI's prices read ${S.PRICES.read_on}), ${lanes.length} ${lanes.length === 1 ? 'lane' : 'lanes'}:`);
    for (const l of costRange(lanes.length)) out(l);
    if (leadsTemplate) {
      out(`--- Request for leads (POST ${XAI_URL}), sent after the brief:\n${JSON.stringify(leadsRequestFor(leadsTemplate, today), null, 2)}`);
      out(`--- Leads add one request a day: ${Object.entries(ASSUME).map(([name, a]) => `${name} $${S.usageCost(MODEL, a).toFixed(2)} a day, about $${Math.round(S.usageCost(MODEL, a) * 30)} a month`).join('; ')}.`);
    }
    out('A request whose prompt reaches 200,000 tokens is billed at twice these rates. Your prepaid xAI balance is the ceiling. Nothing was sent.');
    return { ok: true, status: 'dry_run', requests: requests.length };
  }
  const xaiKey = env.XAI_API_KEY;
  const ingestKey = env.DESK_INGEST_KEY;
  const origin = deskOrigin(env.DESK_INGEST_URL);
  const missing = [!xaiKey && 'XAI_API_KEY', !ingestKey && 'DESK_INGEST_KEY', !origin && 'DESK_INGEST_URL (the desk\'s https origin)'].filter(Boolean);
  if (missing.length) {
    out(`Not set up: ${missing.join(', ')}. Nothing was sent.`);
    return { ok: false, status: 'not_set_up', missing };
  }
  const deskHeaders = { authorization: `Bearer ${ingestKey}` };
  // The key check costs nothing: no paid call before the desk accepts the key.
  let ping;
  try {
    const r = await timed(fetchFn, `${origin}${S.BRIEF_PATH}`, { method: 'GET', headers: deskHeaders }, DESK_TIMEOUT_MS);
    ping = { status: r.status, body: await jsonOf(r) };
  } catch (err) {
    out(`The desk did not answer the key check (${err.name === 'AbortError' ? 'timed out' : 'network error'}). Nothing was sent to xAI.`);
    return { ok: false, status: 'desk_unreachable' };
  }
  if (ping.status !== 200 || !ping.body || ping.body.key !== 'accepted') {
    out(`The desk refused the key check (HTTP ${ping.status}${ping.body && ping.body.code ? `, ${ping.body.code}` : ''}). Nothing was sent to xAI.`);
    return { ok: false, status: 'desk_refused', http: ping.status };
  }
  if (ping.body.briefs_today >= ping.body.max_per_day) {
    out(`The desk has taken its ${ping.body.max_per_day} briefs for today. Nothing was sent to xAI.`);
    return { ok: false, status: 'desk_full' };
  }
  out(`Desk: key accepted (${ping.body.briefs_today} of ${ping.body.max_per_day} briefs today).`);

  const brief = { schema_version: S.BRIEF_SCHEMA, generated_at: new Date(now).toISOString(), prompt: PROMPT_ID, model: MODEL, lanes_run: [], lanes_missing: [], items: [], usage: {} };
  for (const { lane, body } of requests) {
    let resp;
    try {
      const r = await timed(fetchFn, XAI_URL, { method: 'POST', headers: { authorization: `Bearer ${xaiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }, LANE_TIMEOUT_MS);
      resp = await jsonOf(r);
      if (r.status !== 200) {
        if (resp && resp.usage) brief.usage[lane] = usageOf(resp);
        brief.lanes_missing.push(lane);
        out(`Lane ${lane}: missing (xAI answered HTTP ${r.status}).`);
        continue;
      }
    } catch (err) {
      brief.lanes_missing.push(lane);
      out(`Lane ${lane}: missing (${err.name === 'AbortError' ? `no answer within ${LANE_TIMEOUT_MS / 1000} s` : 'network error'}).`);
      continue;
    }
    const usage = usageOf(resp);
    brief.usage[lane] = usage;
    const got = itemsFrom(answerText(resp), lane);
    const counts = `${usage.web_search_calls} web searches; ${fmt(usage.input_tokens)} input tokens (${fmt(usage.cached_input_tokens)} cached), ${fmt(usage.output_tokens)} output`;
    if (got.reason) {
      brief.lanes_missing.push(lane);
      out(`Lane ${lane}: missing (${got.reason}); ${counts}.`);
      continue;
    }
    brief.lanes_run.push(lane);
    brief.items.push(...got.items);
    out(`Lane ${lane}: ${got.items.length} ${got.items.length === 1 ? 'item' : 'items'} kept, ${got.dropped} dropped; ${counts}.`);
  }

  // The brief goes to the desk even when every lane failed, so what they
  // used is on record.
  let receipt = null;
  let last = null;
  for (const wait of postWaits) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const r = await timed(fetchFn, `${origin}${S.BRIEF_PATH}`, { method: 'POST', headers: { ...deskHeaders, 'content-type': 'application/json' }, body: JSON.stringify(brief) }, DESK_TIMEOUT_MS);
      const b = await jsonOf(r);
      last = `HTTP ${r.status}${b && b.code ? `, ${b.code}` : ''}`;
      if (r.status === 200 && b && (b.status === 'saved' || b.status === 'unchanged')) {
        receipt = b;
        break;
      }
      // A refusal is an answer; only no answer or a server error is tried again.
      if (r.status < 500) break;
    } catch (err) {
      last = err.name === 'AbortError' ? 'timed out' : 'network error';
    }
  }
  let result;
  if (!receipt) {
    out(`The desk did not save the brief (${last}). The xAI calls above were made.`);
    result = { ok: false, status: 'desk_not_saved', lanes_run: brief.lanes_run, lanes_missing: brief.lanes_missing };
  } else {
    out(`Desk: ${receipt.status} ${receipt.brief_id} (${receipt.items_new} new, ${receipt.items_updated} updated).`);
    if (brief.lanes_missing.length) out(`::warning::Scout lanes missing: ${brief.lanes_missing.join(', ')}.`);
    result = { ok: brief.lanes_run.length > 0, status: receipt.status, brief_id: receipt.brief_id, lanes_run: brief.lanes_run, lanes_missing: brief.lanes_missing };
  }
  if (leadsOn) result.leads = leadsTemplate ? await sendLeads({ env, fetchFn, now, out, template: leadsTemplate, today, origin, deskHeaders, xaiKey, postWaits }) : { status: 'skipped', reason: leadsSkip };
  return result;
}

// The leads, after the brief: the desk's key check for leads first (no paid
// call before it accepts), one xAI call never retried, then one delivery
// under an ID made before it is sent and reused on its own retries. A
// refusal is reported, never resent under a new ID.
async function sendLeads({ env, fetchFn, now, out, template, today, origin, deskHeaders, xaiKey, postWaits }) {
  let ping;
  try {
    const r = await timed(fetchFn, `${origin}${LEADS_PATH}`, { method: 'GET', headers: deskHeaders }, DESK_TIMEOUT_MS);
    ping = { status: r.status, body: await jsonOf(r) };
  } catch (err) {
    out(`Leads: the desk did not answer the key check (${err.name === 'AbortError' ? 'timed out' : 'network error'}). Nothing was sent to xAI for leads.`);
    return { status: 'desk_unreachable' };
  }
  if (ping.status !== 200 || !ping.body || ping.body.key !== 'accepted') {
    out(`Leads: the desk refused the key check (HTTP ${ping.status}${ping.body && ping.body.code ? `, ${ping.body.code}` : ''}). Nothing was sent to xAI for leads.`);
    return { status: 'desk_refused', http: ping.status };
  }
  if (ping.body.leads_today >= ping.body.max_per_day) {
    out(`Leads: the desk has taken its ${ping.body.max_per_day} lead deliveries for today. Nothing was sent to xAI for leads.`);
    return { status: 'desk_full' };
  }
  let resp;
  try {
    const r = await timed(fetchFn, XAI_URL, { method: 'POST', headers: { authorization: `Bearer ${xaiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(leadsRequestFor(template, today)) }, LANE_TIMEOUT_MS);
    resp = await jsonOf(r);
    if (r.status !== 200) {
      out(`Leads: none (xAI answered HTTP ${r.status}).`);
      return { status: 'xai_failed', http: r.status };
    }
  } catch (err) {
    out(`Leads: none (${err.name === 'AbortError' ? `no answer within ${LANE_TIMEOUT_MS / 1000} s` : 'network error'}).`);
    return { status: 'xai_failed' };
  }
  const usage = usageOf(resp);
  const counts = `${usage.web_search_calls} web searches; ${fmt(usage.input_tokens)} input tokens (${fmt(usage.cached_input_tokens)} cached), ${fmt(usage.output_tokens)} output`;
  const got = leadsFrom(answerText(resp));
  if (got.reason) {
    out(`Leads: none (${got.reason}); ${counts}.`);
    return { status: 'no_leads', reason: got.reason, usage };
  }
  if (!got.leads.length) {
    out(`Leads: none named; nothing delivered; ${counts}.`);
    return { status: 'no_leads', usage };
  }
  const deliveryId = deliveryIdOf(env, now);
  const body = JSON.stringify({ schema: 'cr.scout-leads.v1', prompt_version: LEADS_PROMPT_ID, delivery_id: deliveryId, generated_at: new Date(now).toISOString(), model: MODEL, leads: got.leads });
  let last = null;
  for (const wait of postWaits) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const r = await timed(fetchFn, `${origin}${LEADS_PATH}`, { method: 'POST', headers: { ...deskHeaders, 'content-type': 'application/json' }, body }, DESK_TIMEOUT_MS);
      const b = await jsonOf(r);
      last = `HTTP ${r.status}${b && b.code ? `, ${b.code}` : ''}`;
      if ((r.status === 202 || r.status === 200) && b && (b.status === 'accepted' || b.status === 'unchanged')) {
        const by = (o) => b.rows.filter((x) => x.outcome === o).length;
        out(`Leads: ${b.status} ${deliveryId} (${b.rows.length} rows: ${by('new')} new, ${by('sighting')} seen before, ${by('refused_at_intake')} refused at intake); ${counts}.`);
        return { status: b.status, delivery_id: deliveryId, receipt_id: b.receipt_id, rows: b.rows.length, dropped: got.dropped, usage };
      }
      if (r.status === 409) {
        out(`Leads: the desk holds another delivery under ${deliveryId} (${last}); not resent under a new ID.`);
        return { status: 'conflict', delivery_id: deliveryId };
      }
      // A refusal is an answer; only no answer or a server error is tried again.
      if (r.status < 500) break;
    } catch (err) {
      last = err.name === 'AbortError' ? 'timed out' : 'network error';
    }
  }
  out(`Leads: the desk did not save delivery ${deliveryId} (${last}). The xAI call for leads was made.`);
  return { status: 'desk_not_saved', delivery_id: deliveryId };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const laneArg = args.includes('--lane') ? args[args.indexOf('--lane') + 1] : null;
  if (laneArg && !S.LANES.includes(laneArg)) {
    process.stderr.write(`--lane must be one of ${S.LANES.join(', ')}\n`);
    process.exit(2);
  }
  run({ dryRun: args.includes('--dry-run'), lanes: laneArg ? [laneArg] : S.LANES, leads: args.includes('--leads') ? true : null }).then((r) => {
    process.exitCode = r.ok ? 0 : 1;
  }, (err) => {
    // Its name only: a message could carry an address.
    process.stdout.write(`The sweep stopped: ${err.code === 'INTEGRITY' ? err.message : `an unexpected error (${err.name})`}.\n`);
    process.exitCode = 1;
  });
}

module.exports = { run, requestFor, leadsRequestFor, promptTemplate, usageOf, answerText, itemsFrom, leadsFrom, deliveryIdOf, deskOrigin, MODEL, XAI_URL, PROMPT_ID, LEADS_PROMPT_ID, LEADS_PATH, ASSUME };
