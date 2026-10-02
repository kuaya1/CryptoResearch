'use strict';
// Research runs: one request to research a project with one or more providers.
//
// projects/<id>/research/<run_id>/
//   run.json             the run and one job per provider (states below)
//   prompt.md            the canonical prompt, identical for every provider (SHA-256 recorded)
//   evidence-packet.json dated public context given to every provider (no holdings, no notes)
//   responses/<provider>-attempt<n>.json   raw API response + metadata, saved BEFORE normalization
//
// Job states: queued (waiting for the runner), dispatching (a paid API attempt
// is reserved or in flight), running (a fictional mock attempt, or the job of
// the Cowork session that created the run), uncertain (a paid request may have
// been sent and billed but no answer was saved: held for you, never resent by
// itself), completed (a report is linked), failed, canceled, unconfigured (no
// paid API path set up; the prompt is ready to paste and the job completes
// when that answer is imported).
// Run status: queued, running, needs_attention (an uncertain attempt),
// waiting (manual answers outstanding), completed, partially_completed,
// failed, canceled.
//
// Paid attempts (audit V2-003). Each step is a verified write to run.json made
// BEFORE the step it announces, so a crash anywhere leaves a state that says
// what may have happened:
//   reserved    admitted under the workspace lock; its reservation counts
//               against the limits. Provably not sent yet.
//   dispatched  written immediately before the request leaves this PC.
//   (captured)  not a phase: the moment an answer (or a provider error) comes
//               back, it is written to .cr/captures/<attempt_id>.json WITHOUT
//               the workspace lock (captures.js). The locked commit below
//               comes second, so a busy lock, blocked writes or a crash after
//               the capture never lose a paid answer: the next runner commits
//               the capture without asking the provider again (audit F1).
//   responded   the answer and its usage were saved in the same write as the
//               pointer to them (a provider error answer is "errored").
//   imported    the answer became a report.
//   not_sent    provably never sent; the reservation is released.
//   uncertain   may have been sent and billed, and no answer was saved. Its
//               reservation keeps counting and it is never resent by itself:
//               you reconcile it or retry it.
//   reconciled  you recorded what the provider charged (or that it did not).
// The ambiguous window cannot be closed from this side: after the dispatch
// marker and before an answer is captured, a crash cannot tell "never left
// this PC" from "sent and billed". The provider APIs used here document no
// idempotency for these calls, so none is assumed.
//
// Spending (audit V2-004/005). The per-run limit covers the whole run: every
// model and every attempt. Admission runs under the workspace lock and counts,
// for every attempt in the workspace, the reconciled amount, else the actual
// cost, else its reservation (an unanswered call may still be billed); the
// daily and monthly limits use the same figures. A reservation adds enforced
// bounds (the output-token limit and search limit sent with the request, or a
// declared per-request search fee) and estimates (prompt tokens, and search
// results billed as input, which no request parameter caps). It is not a
// maximum: actual usage can exceed it, and is recorded when the provider
// reports it. logs/research-spend.jsonl is still appended so the history, and
// older code reading it after a rollback, count the same money.
// Price refreshes never start research. One provider failing never touches
// another provider's report.

const fs = require('fs');
const crypto = require('crypto');
const { runOp, OpError, logOp } = require('./ops');
const captures = require('./captures');
const { readJson, listDir, appendLine, readJsonLines, sha256, exists } = require('./fsx');
const { compactTs, randomId } = require('./ids');
const { PROVIDERS, PROVIDER_LABELS } = require('./workspace');
const { getProject, listProjects } = require('./projects');
const { buildRunPrompt, PROMPT_VERSION } = require('./prompts');
const { parseHorizon } = require('./reports');
const { ymdInTz } = require('./dates');
const { acquireLease, releaseLease } = require('./leases');
const providers = require('./providers');

const RUN_ID_RE = /^run_[A-Za-z0-9_-]{4,80}$/;
const SPEND_REL = 'logs/research-spend.jsonl';
const TERMINAL = new Set(['completed', 'failed', 'canceled']);
const IN_FLIGHT = new Set(['dispatching', 'running']);
const DEDUPE_MINUTES = 10;
const MAX_SEARCHES = 200;
const DEFAULT_SEARCHES = 20;
const DEFAULT_OUTPUT_TOKENS = 16000;
const CHARS_PER_TOKEN = 3.5;
const SEARCH_RESULT_TOKENS = 4000;
// The request parameter that caps searches, per provider. Gemini has none.
const SEARCH_CONTROL = { claude: 'max_uses', chatgpt: 'max_tool_calls', gemini: null };

const round4 = (x) => Math.round(x * 10000) / 10000;
const units = (x) => Math.round(x * 10000);
const isMoney = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const usd = (x) => `$${x > 0 && x < 0.1 ? x.toFixed(4) : x.toFixed(2)}`;

function runDir(projectId, runId) {
  if (!RUN_ID_RE.test(runId)) throw new OpError('BAD_ID', 'Invalid research run ID');
  return `projects/${projectId}/research/${runId}`;
}

function loadRun(ws, projectId, runId) {
  return readJson(ws.abs(`${runDir(projectId, runId)}/run.json`), null);
}

function listRuns(ws, projectId) {
  return listDir(ws.abs(`projects/${projectId}/research`), { dirs: true })
    .filter((d) => RUN_ID_RE.test(d))
    .map((d) => {
      try {
        const r = readJson(ws.abs(`projects/${projectId}/research/${d}/run.json`), null);
        return r ? withStatus(r) : null;
      } catch (err) {
        return { run_id: d, broken: true, error: err.message };
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

function runStatus(run) {
  const jobs = Object.values(run.jobs || {});
  if (!jobs.length) return 'empty';
  const s = jobs.map((j) => j.state);
  if (s.some((x) => IN_FLIGHT.has(x))) return 'running';
  if (s.includes('queued')) return 'queued';
  if (s.includes('uncertain')) return 'needs_attention';
  const completed = s.filter((x) => x === 'completed').length;
  if (s.includes('unconfigured')) return completed ? 'partially_completed' : 'waiting';
  if (completed === s.length) return 'completed';
  if (completed) return 'partially_completed';
  if (s.every((x) => x === 'canceled')) return 'canceled';
  return 'failed';
}

function withStatus(run) {
  return { ...run, status: runStatus(run) };
}

// ---------------------------------------------------------------------------
// Provider configuration, bounds and budget

function providerConfig(ws, provider) {
  return (ws.settings.research.providers || {})[provider] || {};
}

// The bounds and prices a paid call would be sent with. A value that is set
// but invalid is a configuration problem; it is never replaced by a default.
// Zero searches stays zero and turns web search off (audit V2-005).
function callBounds(ws, provider) {
  const r = ws.settings.research || {};
  const cfg = providerConfig(ws, provider);
  const problems = [];
  const maxOut = r.max_output_tokens === undefined || r.max_output_tokens === null ? DEFAULT_OUTPUT_TOKENS : r.max_output_tokens;
  if (!Number.isInteger(maxOut) || maxOut < 1 || maxOut > 1000000) problems.push('an output token limit (a whole number from 1 to 1,000,000)');
  const limit = cfg.max_searches === undefined || cfg.max_searches === null ? DEFAULT_SEARCHES : cfg.max_searches;
  const limitOk = Number.isInteger(limit) && limit >= 0 && limit <= MAX_SEARCHES;
  if (!limitOk) problems.push(`max searches (a whole number from 0 to ${MAX_SEARCHES})`);
  if (!isMoney(cfg.input_usd_per_mtok) || !isMoney(cfg.output_usd_per_mtok)) problems.push('token prices');
  const enabled = limitOk && limit > 0;
  let billing = null;
  if (enabled) {
    if (!isMoney(cfg.search_usd_per_call)) problems.push('a search price (or max searches 0 to turn web search off)');
    if (provider !== 'gemini') billing = 'per_search';
    else if (cfg.search_billing === 'per_request') billing = 'per_request';
    else problems.push('a bound on Gemini searches: the Gemini API has no per-request search limit and Gemini 3 bills every search query, so set max searches to 0, or declare per-request search billing if your model bills grounding per prompt (Gemini 2.5 and older)');
  }
  const perSearch = cfg.search_result_tokens_estimate === undefined || cfg.search_result_tokens_estimate === null ? SEARCH_RESULT_TOKENS : cfg.search_result_tokens_estimate;
  if (!Number.isInteger(perSearch) || perSearch < 0) problems.push('a search result token estimate (a whole number)');
  return {
    ok: !problems.length,
    problems,
    max_output_tokens: maxOut,
    search: { enabled, limit: enabled ? limit : 0, control: enabled ? SEARCH_CONTROL[provider] || null : null, billing },
    search_result_tokens: perSearch,
    prices: { input_usd_per_mtok: cfg.input_usd_per_mtok ?? null, output_usd_per_mtok: cfg.output_usd_per_mtok ?? null, search_usd_per_call: cfg.search_usd_per_call ?? null },
  };
}

// What the request itself enforces, and what is only estimated.
function describeBounds(b) {
  const enforced = [`at most ${b.max_output_tokens} output tokens (the output limit sent with the request)`];
  if (!b.search.enabled) enforced.push('web search off');
  else if (b.search.billing === 'per_request') enforced.push('one search fee per request (declared per-request billing; the Gemini API cannot cap the number of searches)');
  else enforced.push(`at most ${b.search.limit} searches (${b.search.control} sent with the request)`);
  const estimated = ['prompt tokens'];
  if (b.search.enabled) estimated.push('search results billed as input tokens (no request parameter caps them)');
  return { enforced, estimated };
}

function budgetStatus(ws) {
  const b = (ws.settings.research || {}).budget || {};
  const missing = ['per_run_usd', 'daily_usd', 'monthly_usd'].filter((k) => !isMoney(b[k]));
  return { ok: !missing.length, missing };
}

// How each provider can run right now: api (paid, configured and bounded),
// mock (fictional demo/test fixtures only), or manual (prompt ready to paste),
// with the reason. Unattended dispatch is only possible in api mode.
function providerStatus(ws) {
  const out = {};
  const budget = budgetStatus(ws);
  for (const p of PROVIDERS) {
    const cfg = providerConfig(ws, p);
    if (cfg.mock && ws.kind !== 'real') {
      out[p] = { mode: 'mock', reason: `fictional fixture responses (${cfg.mock})`, model: 'fictional-fixture' };
      continue;
    }
    const key = providers.keyStatus(p);
    const bounds = callBounds(ws, p);
    const missing = [];
    if (!key.present) missing.push('API key');
    if (!cfg.model) missing.push('model ID');
    missing.push(...bounds.problems);
    if (!budget.ok) missing.push('spending budget');
    // The transport must allow the research timeout (audit F2).
    if (!providers.transportFor((ws.settings.research.timeout_seconds || 600) * 1000)) missing.push(`a fetch transport whose 300-second limits can be raised (not available in Node ${process.version})`);
    out[p] = missing.length
      ? { mode: 'manual', reason: `not configured: ${missing.join(', ')}`, missing, key: { present: key.present, how: key.how || null } }
      : { mode: 'api', reason: null, model: cfg.model, key: { present: true, source: key.source }, bounds: describeBounds(bounds) };
  }
  return out;
}

// The reservation for one call: enforced parts (limits sent with the request)
// plus estimated parts (what no request parameter caps). Not a maximum.
function callPlan(ws, provider, promptText) {
  const b = callBounds(ws, provider);
  if (!b.ok) return { ok: false, reason: `Not configured: ${b.problems.join(', ')}.` };
  const p = b.prices;
  const tok = (n, perM) => round4((n / 1e6) * perM);
  const promptTokens = Math.ceil(String(promptText).length / CHARS_PER_TOKEN);
  const parts = [{ part: 'output_tokens', basis: 'enforced', tokens: b.max_output_tokens, usd: tok(b.max_output_tokens, p.output_usd_per_mtok), detail: `${b.max_output_tokens} output tokens at most (the output limit sent with the request)` }];
  if (b.search.enabled) {
    parts.push(b.search.billing === 'per_request'
      ? { part: 'search_fee', basis: 'enforced', units: 1, usd: round4(p.search_usd_per_call), detail: 'one search fee for the request (declared per-request billing)' }
      : { part: 'search_fee', basis: 'enforced', units: b.search.limit, usd: round4(p.search_usd_per_call * b.search.limit), detail: `${b.search.limit} searches at most (${b.search.control})` });
  }
  parts.push({ part: 'prompt_tokens', basis: 'estimated', tokens: promptTokens, usd: tok(promptTokens, p.input_usd_per_mtok), detail: `about ${promptTokens} prompt tokens (${CHARS_PER_TOKEN} characters per token)` });
  if (b.search.enabled) {
    const t = b.search.limit * b.search_result_tokens;
    parts.push({ part: 'search_result_tokens', basis: 'estimated', tokens: t, usd: tok(t, p.input_usd_per_mtok), detail: `about ${b.search_result_tokens} tokens of search results per search, billed as input; nothing caps them` });
  }
  const sum = (basis) => round4(parts.filter((x) => x.basis === basis).reduce((a, x) => a + x.usd, 0));
  const enforced = sum('enforced');
  const estimated = sum('estimated');
  return { ok: true, total_usd: round4(enforced + estimated), enforced_usd: enforced, estimated_usd: estimated, parts, bounds: { max_output_tokens: b.max_output_tokens, search: b.search }, prices: p };
}

function estimateCostUsd(ws, provider, promptText) {
  const plan = callPlan(ws, provider, promptText);
  return plan.ok ? plan.total_usd : null;
}

// Cost from the usage the provider reported, at the prices the attempt was
// admitted with. null when usage is incomplete (the reservation then counts).
function actualCostUsd(ws, provider, usage, attempt = null) {
  const prices = (attempt && attempt.prices) || callBounds(ws, provider).prices;
  if (!usage || typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return null;
  if (!isMoney(prices.input_usd_per_mtok) || !isMoney(prices.output_usd_per_mtok)) return null;
  const search = attempt && attempt.bounds ? attempt.bounds.search : null;
  const calls = typeof usage.search_calls === 'number' ? usage.search_calls : null;
  let fee = 0;
  if (isMoney(prices.search_usd_per_call)) {
    if (search && search.billing === 'per_request') fee = prices.search_usd_per_call * (calls === null ? 1 : Math.min(1, calls));
    else if (search && search.enabled) fee = prices.search_usd_per_call * (calls === null ? search.limit : calls);
    else if (calls !== null) fee = prices.search_usd_per_call * calls;
  }
  return round4((usage.input_tokens / 1e6) * prices.input_usd_per_mtok + (usage.output_tokens / 1e6) * prices.output_usd_per_mtok + fee);
}

// What one attempt counts against the limits: the reconciled amount, else the
// actual cost, else its reservation. A provably unsent attempt counts nothing.
function attemptCharge(a) {
  if (!a) return { usd: 0, basis: 'none' };
  if (a.phase === 'not_sent') return { usd: 0, basis: 'not_sent' };
  if (a.phase === 'reconciled' && isMoney(a.reconciled_usd)) return { usd: a.reconciled_usd, basis: 'reconciled' };
  if (isMoney(a.cost_actual_usd)) return { usd: a.cost_actual_usd, basis: 'actual' };
  if (isMoney(a.reserved_usd)) return { usd: a.reserved_usd, basis: 'reserved' };
  if (isMoney(a.cost_estimate_usd)) return { usd: a.cost_estimate_usd, basis: 'reserved' };
  return { usd: 0, basis: 'none' };
}

// Every paid attempt the workspace knows about. run.json attempts are
// authoritative; ledger lines with no readable attempt (older records, an
// unreadable run.json, a reservation whose write never committed) still count,
// and an actual cost the ledger recorded for an attempt that run.json still
// counts at its reservation (an older runner stopped between pricing the
// answer and recording it) replaces that reservation.
function allCharges(ws) {
  const out = [];
  const seen = new Set();
  const ledger = new Map();
  // Answers captured but not yet committed (audit F1): their reported usage is
  // known, so they count at the larger of that cost and the reservation.
  const captured = new Map();
  for (const c of captures.listCaptures(ws)) if (c.ok && c.body) captured.set(c.attempt_id, c.body);
  for (const e of readJsonLines(ws.abs(SPEND_REL))) {
    if (!e.run_id) continue;
    const key = `${e.run_id}|${e.provider}|${e.attempt}`;
    const cur = ledger.get(key) || { at: e.at, estimate: null, actual: null, run_id: e.run_id, provider: e.provider, n: e.attempt };
    if (typeof e.estimate_usd === 'number') cur.estimate = e.estimate_usd;
    if (typeof e.actual_usd === 'number') cur.actual = e.actual_usd;
    ledger.set(key, cur);
  }
  for (const pid of listDir(ws.abs('projects'), { dirs: true })) {
    for (const d of listDir(ws.abs(`projects/${pid}/research`), { dirs: true })) {
      if (!RUN_ID_RE.test(d)) continue;
      let run = null;
      try {
        run = readJson(ws.abs(`projects/${pid}/research/${d}/run.json`), null);
      } catch (_) {
        run = null;
      }
      if (!run || !run.jobs) continue;
      const runId = run.run_id || d;
      for (const job of Object.values(run.jobs)) {
        for (const a of job.attempts || []) {
          const paid = job.mode === 'api' || [a.cost_estimate_usd, a.cost_actual_usd, a.reconciled_usd].some(isMoney);
          if (!paid) continue;
          const key = `${runId}|${job.provider}|${a.n}`;
          seen.add(key);
          let c = attemptCharge(a);
          const l = ledger.get(key);
          if (c.basis === 'reserved' && l && l.actual !== null) c = { usd: l.actual, basis: 'ledger_actual' };
          const cap = c.basis === 'reserved' && a.attempt_id ? captured.get(a.attempt_id) : null;
          if (cap && cap.run_id === runId) {
            const u = cap.result ? cap.result.usage : cap.error ? cap.error.usage : null;
            const actual = u ? actualCostUsd(ws, job.provider, u, a) : null;
            if (isMoney(actual) && actual > c.usd) c = { usd: actual, basis: 'captured_actual' };
          }
          out.push({ key, run_id: runId, project_id: pid, provider: job.provider, n: a.n, attempt_id: a.attempt_id || null, at: a.started_at || null, phase: a.phase || null, usd: c.usd, basis: c.basis });
        }
      }
    }
  }
  for (const [key, c] of ledger) {
    if (seen.has(key)) continue;
    out.push({ key, run_id: c.run_id, project_id: null, provider: c.provider, n: c.n, attempt_id: null, at: c.at, phase: null, usd: c.actual !== null ? c.actual : c.estimate || 0, basis: c.actual !== null ? 'ledger_actual' : 'ledger_estimate' });
  }
  return out;
}

function spendSoFar(ws, now = new Date(), { runId = null } = {}) {
  const day = ymdInTz(now);
  const month = day.slice(0, 7);
  const charges = allCharges(ws);
  let daily = 0;
  let monthly = 0;
  let run = 0;
  let open = 0;
  let uncertain = 0;
  for (const c of charges) {
    const t = c.at ? Date.parse(c.at) : NaN;
    const d = Number.isFinite(t) ? ymdInTz(new Date(t)) : day;
    if (d === day) daily += c.usd;
    if (d.slice(0, 7) === month) monthly += c.usd;
    if (runId && c.run_id === runId) run += c.usd;
    if (c.basis === 'reserved' || c.basis === 'ledger_estimate') open += c.usd;
    if (c.phase === 'uncertain') uncertain += 1;
  }
  const out = { daily: round4(daily), monthly: round4(monthly), day, month, calls: charges.length, open_reservations_usd: round4(open), uncertain_attempts: uncertain };
  if (runId) out.run = round4(run);
  return out;
}

// Admission check for one reservation against all three limits. The per-run
// limit covers every model and attempt in the run (audit V2-004).
function budgetCheck(ws, reservation, { runId = null, now = new Date() } = {}) {
  const b = ws.settings.research.budget || {};
  if (!isMoney(reservation)) return { ok: false, reason: 'The cost of this call cannot be estimated (prices or limits are missing), so it is not made.' };
  if (!isMoney(b.per_run_usd)) return { ok: false, reason: 'The per-run limit is not set.' };
  if (!isMoney(b.daily_usd)) return { ok: false, reason: 'The daily limit is not set.' };
  if (!isMoney(b.monthly_usd)) return { ok: false, reason: 'The monthly limit is not set.' };
  const spent = spendSoFar(ws, now, { runId });
  const runSoFar = runId ? spent.run : 0;
  if (units(runSoFar) + units(reservation) > units(b.per_run_usd)) {
    return { ok: false, reason: `This call's reservation of ${usd(reservation)} plus ${usd(runSoFar)} already counted for this run (every model and attempt) would pass the per-run limit of ${usd(b.per_run_usd)}.` };
  }
  if (units(spent.daily) + units(reservation) > units(b.daily_usd)) {
    return { ok: false, reason: `Today's research spend (${usd(spent.daily)}, counting reservations of calls whose cost is not known yet) plus this call's reservation of ${usd(reservation)} would pass the daily limit of ${usd(b.daily_usd)}.` };
  }
  if (units(spent.monthly) + units(reservation) > units(b.monthly_usd)) {
    return { ok: false, reason: `This month's research spend (${usd(spent.monthly)}, counting reservations of calls whose cost is not known yet) plus this call's reservation of ${usd(reservation)} would pass the monthly limit of ${usd(b.monthly_usd)}.` };
  }
  return { ok: true, reservation, spent };
}

// ---------------------------------------------------------------------------
// Evidence packet: dated, neutral, public context. Never holdings or notes.

function evidencePacket(ws, project) {
  const latest = require('./market').readLatest(ws);
  const id = project.identity && project.identity.status === 'verified' ? project.identity.coingecko_id : null;
  const obs = id && latest.assets ? latest.assets[id] : null;
  return {
    schema_version: 'cr.evidence-packet.v1',
    captured_at: new Date().toISOString(),
    note: 'Dated public context captured by the dashboard. Starting point only: verify what you rely on. Contains no holdings, private notes, or other models\' conclusions.',
    project: {
      name: project.name,
      symbol: project.symbol || null,
      official_website: project.identity ? project.identity.official_website || null : null,
      identity_status: project.identity ? project.identity.status : 'unknown',
      coingecko_id: id,
      chains_and_contracts: project.identity && project.identity.status === 'verified' ? (project.identity.assets || []).map((a) => ({ chain: a.chain, contract_address: a.contract_address || null, standard: a.standard || null })) : [],
      identity_evidence_urls: ((project.identity && project.identity.evidence) || []).map((e) => e.url).slice(0, 10),
      sector: project.sector ? project.sector.primary : null,
      scoring_profile: project.sector_profile,
    },
    market: obs ? {
      source: obs.source || 'CoinGecko /coins/markets',
      source_last_updated_at: obs.source_last_updated_at,
      price_usd: obs.price_usd,
      market_cap_usd: obs.market_cap_usd,
      market_cap_rank: obs.market_cap_rank ?? null,
      rank_source: 'CoinGecko market-cap rank',
      fdv_usd: obs.fdv_usd,
      volume_24h_usd: obs.volume_24h_usd,
      change_7d_pct: obs.change_7d_pct ?? null,
      change_30d_pct: obs.change_30d_pct ?? null,
      circulating_supply: obs.circulating_supply,
      total_supply: obs.total_supply,
      max_supply: obs.max_supply,
    } : { note: id ? 'No market observation stored yet.' : 'No verified token binding, so no market data.' },
    excluded: ['your holdings and transactions', 'your notes and journal', 'other models\' reports and scores'],
  };
}

// ---------------------------------------------------------------------------
// Creating runs

function normalizeProviders(list) {
  const raw = Array.isArray(list) ? list : String(list || '').split(',');
  const map = { gpt: 'chatgpt', openai: 'chatgpt', chatgpt: 'chatgpt', claude: 'claude', anthropic: 'claude', gemini: 'gemini', google: 'gemini' };
  const out = [...new Set(raw.map((s) => map[String(s).trim().toLowerCase()]).filter(Boolean))];
  return out.filter((p) => PROVIDERS.includes(p));
}

function createRun(ws, args = {}) {
  const projectId = args.project_id;
  const project = getProject(ws, projectId);
  if (project.status === 'archived') throw new OpError('INVALID', `${project.name} is archived. Unarchive it before researching it.`);
  const list = normalizeProviders(args.providers && (Array.isArray(args.providers) ? args.providers.length : String(args.providers).trim()) ? args.providers : ws.settings.research.default_providers);
  if (!list.length) throw new OpError('INVALID', 'Choose at least one provider: claude, chatgpt or gemini.');
  const previous = listRuns(ws, projectId);
  const horizonText = String(args.horizon || (args.same_as_last && previous[0] ? previous[0].horizon.text : null) || (project.research_defaults && project.research_defaults.horizon) || ws.settings.research.default_horizon || '24 months');
  const horizon = parseHorizon(horizonText);
  if (!horizon || horizon.kind === 'unknown') throw new OpError('INVALID', `Horizon "${horizonText}" is not readable. Use for example "24 months" or "12-24 months".`);
  const rubricRef = (args.same_as_last && previous[0] && previous[0].rubric_version) || ws.rubrics.activeRef;
  if (!ws.rubrics.gradingVersions[rubricRef]) throw new OpError('INVALID', `Rubric ${rubricRef} is not available.`);
  // Repeating the same request within a few minutes does not start a second run.
  const recent = previous.find((r) => !r.broken && !TERMINAL.has(r.status) && Date.now() - Date.parse(r.created_at) < DEDUPE_MINUTES * 60000 && r.horizon.text === horizonText && JSON.stringify(r.providers) === JSON.stringify(list));
  if (recent && !args.force_new) {
    return { status: 'exists', project_id: projectId, run_id: recent.run_id, run: recent, message: `A research run for ${project.name} with the same providers and horizon started ${Math.round((Date.now() - Date.parse(recent.created_at)) / 60000)} min ago (${recent.run_id}). No second run was created.` };
  }
  const runId = `run_${compactTs()}_${randomId(5)}`;
  const packet = evidencePacket(ws, project);
  const packetText = `${JSON.stringify(packet, null, 2)}\n`;
  const prompt = buildRunPrompt(ws, project, { runId, horizon: horizonText, rubricRef, packet });
  const status = providerStatus(ws);
  const channel = args.channel || ws.actor || 'cli';
  const fromCowork = /cowork/i.test(channel) || /cowork/i.test(ws.actor || '');
  const jobs = {};
  for (const p of list) {
    const st = status[p];
    const base = { provider: p, attempts: [], max_attempts: ws.settings.research.max_attempts || 2, report_id: null, error: null, updated_at: new Date().toISOString(), cancel_requested: false };
    if (p === 'claude' && fromCowork) {
      jobs[p] = { ...base, state: 'running', mode: 'cowork', note: 'Assigned to the Claude Cowork session that created this run. It completes when that session imports its report with --run.' };
    } else if (st.mode === 'api' || st.mode === 'mock') {
      jobs[p] = { ...base, state: 'queued', mode: st.mode, model: st.model };
    } else {
      jobs[p] = { ...base, state: 'unconfigured', mode: 'manual', fallback: 'manual', note: `${PROVIDER_LABELS[p]} API ${st.reason}. Paste the prompt into ${PROVIDER_LABELS[p]} yourself and import the answer for this run; it completes then.` };
    }
  }
  const dir = runDir(projectId, runId);
  const run = {
    schema_version: 'cr.research-run.v1',
    run_id: runId,
    project_id: projectId,
    kind: args.kind || (previous.length ? 'refresh' : 'initial'),
    created_at: new Date().toISOString(),
    created_by: ws.actor,
    channel,
    utterance: args.utterance || null,
    providers: list,
    rubric_version: rubricRef,
    sector_profile: project.sector_profile,
    horizon: { text: horizonText, low_months: horizon.low_months, high_months: horizon.high_months },
    prompt: { version: PROMPT_VERSION, path: `${dir}/prompt.md`, sha256: sha256(prompt), identical_for_all_providers: true },
    evidence_packet: { path: `${dir}/evidence-packet.json`, sha256: sha256(packetText), captured_at: packet.captured_at },
    independence: 'Each provider gets the same prompt and dated context and never sees another model\'s conclusions.',
    jobs,
  };
  const out = runOp(ws, { type: 'research_run_create', summary: `Research ${projectId} with ${list.join(', ')}` }, (op) => {
    op.write(`${dir}/prompt.md`, prompt, { mode: 'create' });
    op.write(`${dir}/evidence-packet.json`, packetText, { mode: 'create' });
    op.writeJson(`${dir}/run.json`, run, { mode: 'create' });
    return { run_id: runId, project_id: projectId };
  });
  const runOut = out.replayed ? loadRun(ws, projectId, out.result.run_id) : run;
  return {
    status: 'created',
    project_id: projectId,
    run_id: runOut.run_id,
    run: withStatus(runOut),
    message: summarizeRun(withStatus(runOut), project),
    files: out.files,
    verified: out.verified,
    op_id: out.op_id,
  };
}

function summarizeRun(run, project) {
  const parts = Object.values(run.jobs).map((j) => `${PROVIDER_LABELS[j.provider]}: ${j.state}${j.mode === 'manual' ? ' (prompt ready to paste)' : j.mode === 'cowork' ? ' (this Claude session)' : ''}`);
  return `Research run ${run.run_id} for ${project ? project.name : run.project_id} — ${parts.join('; ')}.`;
}

// ---------------------------------------------------------------------------
// Job updates (each a single verified operation on run.json)

function updateJob(ws, projectId, runId, provider, mutate, summary, type = 'research_job_update') {
  const rel = `${runDir(projectId, runId)}/run.json`;
  return runOp(ws, { type, summary: summary || `Update ${provider} job in ${runId}` }, (op) => {
    const run = op.readJson(rel, null);
    if (!run) throw new OpError('NOT_FOUND', `No research run ${runId} in ${projectId}`);
    const job = run.jobs[provider];
    if (!job) throw new OpError('NOT_FOUND', `${runId} has no ${provider} job`);
    const before = JSON.stringify(job);
    const extra = mutate(job, run, op);
    if (JSON.stringify(job) === before) return { noop: true, ...(extra || {}) };
    job.updated_at = new Date().toISOString();
    op.writeJson(rel, run);
    return { job, ...(extra || {}) };
  });
}

// One line in logs/research-spend.jsonl. Written inside the operation that
// changes the attempt, so a failed commit can only overcount.
function ledger(ws, run, job, a, entry) {
  if (job.mode !== 'api') return;
  appendLine(ws.abs(SPEND_REL), {
    at: new Date().toISOString(),
    run_id: run.run_id,
    project_id: run.project_id,
    provider: job.provider,
    attempt: a.n,
    attempt_id: a.attempt_id || null,
    model: a.model || null,
    estimate_usd: null,
    actual_usd: null,
    ...entry,
  });
}

const uncertainOf = (job) => (job.attempts || []).filter((a) => a.phase === 'uncertain');

function cancelJob(ws, projectId, runId, provider, reason = null) {
  const out = updateJob(ws, projectId, runId, provider, (job) => {
    if (TERMINAL.has(job.state)) return { message: `${PROVIDER_LABELS[provider]} job is already ${job.state}.` };
    if (IN_FLIGHT.has(job.state) && job.mode !== 'cowork') {
      if (job.cancel_requested) return { message: 'Cancel already requested.' };
      job.cancel_requested = true;
      job.cancel_reason = reason;
      return { message: 'Cancel requested. A request that was already sent to the provider may still be billed; its answer will be kept but not imported.' };
    }
    const open = uncertainOf(job);
    job.state = 'canceled';
    job.cancel_reason = reason;
    return { message: `${PROVIDER_LABELS[provider]} job canceled.${open.length ? ` Attempt ${open.map((a) => `#${a.n}`).join(', ')} may still have been billed; it stays counted until you reconcile it.` : ''}` };
  }, `Cancel ${provider} in ${runId}`);
  return { status: out.result.noop ? 'unchanged' : 'saved', noop: Boolean(out.result.noop), message: out.result.message, files: out.files, verified: out.verified };
}

// An explicit retry by the owner. After an uncertain attempt this asks the
// provider again; the uncertain attempt keeps counting until reconciled.
function retryJob(ws, projectId, runId, provider) {
  const st = providerStatus(ws)[provider];
  const out = updateJob(ws, projectId, runId, provider, (job) => {
    if (job.state === 'completed') return { message: 'Already completed; start a new run to research again.' };
    if (IN_FLIGHT.has(job.state)) return { message: 'Still running.' };
    if (st.mode === 'manual') {
      job.state = 'unconfigured';
      return { message: `${PROVIDER_LABELS[provider]} API is ${st.reason}; the prompt is ready to paste.` };
    }
    const open = uncertainOf(job);
    job.state = 'queued';
    job.max_attempts = Math.max(job.max_attempts || 2, (job.attempts || []).length + 1);
    job.error = null;
    job.cancel_requested = false;
    if (!open.length) return { message: `${PROVIDER_LABELS[provider]} job queued again.` };
    const held = round4(open.reduce((s, a) => s + attemptCharge(a).usd, 0));
    job.note = `Retried by you after an uncertain attempt (${open.map((a) => `#${a.n}`).join(', ')}), which stays counted until reconciled.`;
    return { message: `${PROVIDER_LABELS[provider]} job queued for a new attempt. Attempt ${open.map((a) => `#${a.n}`).join(', ')} may already have been billed: it stays counted (${usd(held)}) until you reconcile it, and the new attempt is reserved separately.` };
  }, `Retry ${provider} in ${runId}`);
  return { status: out.result.noop ? 'unchanged' : 'saved', noop: Boolean(out.result.noop), message: out.result.message, files: out.files, verified: out.verified };
}

function reconcilable(a) {
  if (!a || ['reconciled', 'not_sent', 'imported', 'responded', 'reserved', 'dispatched'].includes(a.phase)) return false;
  if (a.phase === 'uncertain') return true;
  if (a.phase === 'errored') return !isMoney(a.cost_actual_usd);
  // An older attempt that ended without a known cost.
  return !a.phase && Boolean(a.finished_at) && a.outcome !== 'response_saved' && !isMoney(a.cost_actual_usd);
}

// The owner records what the provider charged for an attempt whose cost the
// dashboard cannot know: an uncertain attempt, or a provider error without
// usage. Either a charged amount or "not charged", with how they know.
function reconcileAttempt(ws, projectId, runId, provider, { attempt = null, charged_usd: charged = undefined, not_charged: notCharged = false, reason = '' } = {}) {
  const why = String(reason || '').trim();
  if (!why) throw new OpError('INVALID', 'Say how you know, for example "checked the provider usage page".');
  if (why.length > 500) throw new OpError('INVALID', 'Keep the reason under 500 characters.');
  const given = charged !== undefined && charged !== null && charged !== '';
  if (notCharged && given) throw new OpError('INVALID', 'Give either the charged amount or "not charged", not both.');
  const amount = notCharged ? 0 : Number(charged);
  if (!notCharged && (!given || !Number.isFinite(amount) || amount < 0 || amount > 10000)) throw new OpError('INVALID', 'The charged amount must be a number of US dollars from 0 to 10000, or mark it not charged.');
  const out = updateJob(ws, projectId, runId, provider, (job, run) => {
    const list = job.attempts || [];
    const target = attempt === null || attempt === undefined || attempt === ''
      ? [...list].reverse().find(reconcilable)
      : list.find((a) => a.attempt_id === attempt || String(a.n) === String(attempt));
    if (!target) throw new OpError('NOT_FOUND', attempt ? `${runId} has no ${provider} attempt ${attempt}.` : `No ${PROVIDER_LABELS[provider]} attempt in ${runId} needs reconciling.`);
    if (target.phase === 'reconciled') {
      if (units(target.reconciled_usd) === units(amount)) return { message: `Attempt #${target.n} is already reconciled at ${usd(amount)}.`, attempt: target.n };
      throw new OpError('CONFLICT', `Attempt #${target.n} was already reconciled at ${usd(target.reconciled_usd)} on ${target.reconciled_at}.`);
    }
    if (!reconcilable(target)) throw new OpError('CONFLICT', `Attempt #${target.n} is ${String(target.phase || target.outcome || 'in progress').replace(/_/g, ' ')}; only an uncertain attempt, or a provider error without usage, can be reconciled.`);
    const before = attemptCharge(target).usd;
    const at = new Date().toISOString();
    Object.assign(target, { phase_before_reconcile: target.phase || null, phase: 'reconciled', reconciled_usd: amount, reconciled_at: at, reconciled_by: ws.actor || null, reconcile_reason: why });
    if (job.state === 'uncertain' && !uncertainOf(job).length) {
      job.state = 'failed';
      job.error = `No answer was saved for attempt #${target.n}; you recorded ${amount ? `a charge of ${usd(amount)}` : 'no charge'}. Retry to ask again.`;
    }
    ledger(ws, run, job, target, { actual_usd: amount, kind: 'reconciled', reason: why, note: 'reconciled by the owner' });
    return { message: `Attempt #${target.n} reconciled: ${amount ? `charged ${usd(amount)}` : 'not charged'} (was counted at ${usd(before)}).`, attempt: target.n, counted_before_usd: before, counted_now_usd: amount };
  }, `Reconcile ${provider} attempt in ${runId}`, 'research_reconcile');
  return { status: out.result.noop ? 'unchanged' : 'saved', noop: Boolean(out.result.noop), message: out.result.message, attempt: out.result.attempt, counted_before_usd: out.result.counted_before_usd, counted_now_usd: out.result.counted_now_usd, files: out.files, verified: out.verified };
}

// Called inside the import operation, so linking a report to its job is atomic
// with the import itself.
function stageReportLink(ws, op, { projectId, runId, provider, reportId, method }) {
  if (!RUN_ID_RE.test(runId)) return;
  const rel = `${runDir(projectId, runId)}/run.json`;
  const run = op.readJson(rel, null);
  if (!run || !run.jobs || !run.jobs[provider]) return;
  const job = run.jobs[provider];
  if (job.state === 'completed' && job.report_id) return;
  job.state = 'completed';
  job.report_id = reportId;
  job.linked_at = new Date().toISOString();
  job.link_method = method;
  job.updated_at = job.linked_at;
  const last = (job.attempts || [])[(job.attempts || []).length - 1];
  if (last && last.phase === 'responded') {
    last.phase = 'imported';
    last.report_id = reportId;
  }
  op.writeJson(rel, run);
}

// A report imported without a run ID is linked to an open job for the same
// project and provider, if exactly one such job exists.
function autoLinkReport(ws, { projectId, provider, reportId, importedAt }) {
  const open = listRuns(ws, projectId).filter((r) => !r.broken && r.jobs[provider] && ['unconfigured', 'running', 'queued', 'failed'].includes(r.jobs[provider].state) && Date.parse(r.created_at) <= Date.parse(importedAt));
  if (open.length !== 1) return null;
  const run = open[0];
  return runOp(ws, { type: 'research_job_link', summary: `Link ${reportId} to ${run.run_id}` }, (op) => {
    stageReportLink(ws, op, { projectId, runId: run.run_id, provider, reportId, method: 'same project and provider, imported after the run started' });
  });
}

// ---------------------------------------------------------------------------
// Runner

function allOpenJobs(ws) {
  const out = [];
  for (const p of listProjects(ws)) {
    if (p.broken) continue;
    for (const r of listRuns(ws, p.project_id)) {
      if (r.broken) continue;
      for (const j of Object.values(r.jobs)) out.push({ project_id: p.project_id, run: r, job: j });
    }
  }
  return out;
}

// Queued jobs, and jobs a runner left in flight (their recovery never sends).
function isDueJob(job) {
  return job.state === 'queued' || (IN_FLIGHT.has(job.state) && job.mode !== 'cowork');
}

function hasDueWork(ws) {
  return allOpenJobs(ws).some(({ job }) => isDueJob(job)) || dueSchedules(ws).length > 0;
}

function dueSchedules(ws, now = Date.now()) {
  const out = [];
  for (const s of ws.settings.research.schedules || []) {
    if (!s || !s.enabled) continue;
    const days = Number(s.every_days);
    if (!Number.isFinite(days) || days < 1) continue;
    const targets = s.project_id ? [s.project_id] : listProjects(ws).filter((p) => !p.broken && p.status !== 'archived' && p.watchlist && p.watchlist.on_watchlist).map((p) => p.project_id);
    for (const pid of targets) {
      const last = listRuns(ws, pid)[0];
      if (!last || now - Date.parse(last.created_at) >= days * 86400000) out.push({ schedule: s, project_id: pid });
    }
  }
  return out;
}

function responseRel(run, provider, n) {
  return `${runDir(run.project_id, run.run_id)}/responses/${provider}-attempt${n}.json`;
}

const lastAttempt = (job) => (job && job.attempts && job.attempts.length ? job.attempts[job.attempts.length - 1] : null);

// Admission: under the workspace lock, count every attempt in the workspace
// and reserve this one, or record why it was refused. Nothing is sent here.
function admitAttempt(ws, projectId, runId, provider, { mode, model, plan }) {
  const rel = `${runDir(projectId, runId)}/run.json`;
  const out = runOp(ws, { type: 'research_admit', summary: `Reserve a ${provider} attempt in ${runId}` }, (op) => {
    const run = op.readJson(rel, null);
    const job = run && run.jobs ? run.jobs[provider] : null;
    if (!job) throw new OpError('NOT_FOUND', `${runId} has no ${provider} job`);
    const now = new Date();
    const at = now.toISOString();
    if (job.state !== 'queued') return { admitted: false, status: 'skipped', state: job.state };
    if (job.cancel_requested) {
      job.state = 'canceled';
      job.updated_at = at;
      op.writeJson(rel, run);
      return { admitted: false, status: 'canceled' };
    }
    if (mode === 'api') {
      const check = budgetCheck(ws, plan.total_usd, { runId, now });
      if (!check.ok) {
        job.state = 'failed';
        job.error = `Not sent: ${check.reason}`;
        job.budget_refused = true;
        job.updated_at = at;
        op.writeJson(rel, run);
        return { admitted: false, status: 'budget_refused', reason: check.reason };
      }
    }
    const attempt = {
      n: job.attempts.length + 1,
      attempt_id: `att_${compactTs(now)}_${randomId(6)}`,
      phase: 'reserved',
      started_at: at,
      finished_at: null,
      outcome: null,
      model: model || null,
      cost_estimate_usd: mode === 'api' ? plan.total_usd : null,
      reserved_usd: mode === 'api' ? plan.total_usd : 0,
    };
    if (mode === 'api') Object.assign(attempt, { estimate: { enforced_usd: plan.enforced_usd, estimated_usd: plan.estimated_usd, parts: plan.parts }, bounds: plan.bounds, prices: plan.prices });
    job.attempts.push(attempt);
    job.state = mode === 'api' ? 'dispatching' : 'running';
    job.error = null;
    delete job.budget_refused;
    job.updated_at = at;
    op.writeJson(rel, run);
    ledger(ws, run, job, attempt, { at, estimate_usd: plan ? plan.total_usd : null, kind: 'reservation', note: 'reserved before the call; counts until the actual cost is known' });
    return { admitted: true, attempt };
  });
  return out.result;
}

// The durable "about to send" marker, written immediately before the request.
function markDispatched(ws, projectId, runId, provider, attemptId) {
  const out = updateJob(ws, projectId, runId, provider, (job, run) => {
    const a = (job.attempts || []).find((x) => x.attempt_id === attemptId);
    if (!a || a.phase !== 'reserved') throw new OpError('CONFLICT', `Attempt ${attemptId} is no longer reserved; nothing was sent.`);
    const at = new Date().toISOString();
    if (job.cancel_requested) {
      Object.assign(a, { phase: 'not_sent', finished_at: at, outcome: 'not_sent', note: 'Canceled before it was sent; the reservation was released.' });
      job.state = 'canceled';
      ledger(ws, run, job, a, { actual_usd: 0, kind: 'release', note: 'not sent; reservation released' });
      return { send: false };
    }
    a.phase = 'dispatched';
    a.dispatched_at = at;
    return { send: true };
  }, `Send ${provider} attempt in ${runId}`, 'research_dispatch');
  return out.result;
}

// Which phase an outcome puts the attempt in. A request that never connected
// (or never passed validation) was not sent. A provider answer, even an error,
// is a known outcome. Anything else after the dispatch marker may have been
// sent and billed: uncertain (fictional mock attempts are never billed).
function outcomePhase(job, result, error) {
  if (result) return 'responded';
  if (error.kind === 'config' || error.notSent) return 'not_sent';
  if (['http', 'empty'].includes(error.kind)) return 'errored';
  return job.mode === 'api' ? 'uncertain' : 'errored';
}

// Records an outcome on the attempt and moves the job on (inside an operation).
function applyOutcome(ws, run, job, a, { result, error, finishedAt, rel, fileSha, phase, actual }) {
  Object.assign(a, { phase, finished_at: finishedAt, outcome: result ? 'response_saved' : phase === 'not_sent' ? 'not_sent' : error.kind || 'error', response_path: rel, response_sha256: fileSha });
  if (result) {
    const at = result.attested || {};
    Object.assign(a, { request_id: at.request_id || null, response_id: at.response_id || null, model_attested: at.model || null, usage: result.usage || null, cost_actual_usd: actual });
  } else {
    Object.assign(a, { error: error.message, http_status: error.httpStatus || null, request_id: error.requestId || null, usage: error.usage || null, cost_actual_usd: actual });
  }
  if (actual !== null && isMoney(a.reserved_usd) && units(actual) > units(a.reserved_usd)) a.overrun_usd = round4(actual - a.reserved_usd);
  const left = job.attempts.length < job.max_attempts;
  if (phase === 'uncertain') {
    a.uncertain_reason = `${error.message} The request may have reached ${(providers.PROVIDER_API[job.provider] || {}).vendor || 'the provider'} and been billed, and no answer was saved. It is not resent automatically: reconcile it or retry it yourself.`;
    job.state = job.cancel_requested ? 'canceled' : 'uncertain';
    job.error = a.uncertain_reason;
  } else if (phase === 'not_sent') {
    job.state = job.cancel_requested ? 'canceled' : left && error.kind !== 'config' ? 'queued' : 'failed';
    job.error = `Not sent: ${error.message}`;
  } else if (phase === 'errored') {
    const retryable = job.mode === 'api' ? Boolean(error.retryable) : ['timeout', 'network'].includes(error.kind) || Boolean(error.retryable);
    job.state = job.cancel_requested ? 'canceled' : retryable && left ? 'queued' : 'failed';
    job.error = error.message;
  }
  if (phase === 'not_sent') ledger(ws, run, job, a, { actual_usd: 0, kind: 'release', note: 'not sent; reservation released' });
  else if (actual !== null) ledger(ws, run, job, a, { actual_usd: actual, replaces_estimate: true, kind: 'actual', usage: a.usage || null });
}

// One verified write for the outcome: the response file (answer or error
// record) together with the attempt's pointer, phase, usage and cost.
// Applies once: an attempt that is no longer waiting for its outcome (another
// runner, or a rolled-forward commit, already recorded it) is left unchanged,
// so a capture recovered twice is committed and accounted once.
const awaitingOutcome = (a) => a.phase === 'dispatched' || (!a.phase && !a.finished_at);

function recordOutcome(ws, run, provider, attemptId, { result = null, error = null, finishedAt, capture = null, captureError = null, recoveredFrom = null }) {
  const runRel = `${runDir(run.project_id, run.run_id)}/run.json`;
  const out = runOp(ws, { type: 'research_response', summary: `Save ${provider} outcome in ${run.run_id}` }, (op) => {
    const doc = op.readJson(runRel, null);
    const job = doc && doc.jobs ? doc.jobs[provider] : null;
    const a = job ? (job.attempts || []).find((x) => x.attempt_id === attemptId) : null;
    if (!a) throw new OpError('NOT_FOUND', `Attempt ${attemptId} is missing from ${run.run_id}`);
    if (!awaitingOutcome(a)) return { phase: a.phase, state: job.state, error: job.error, n: a.n, already: true, capture_sha256: a.capture_sha256 || null };
    const phase = outcomePhase(job, result, error);
    const usage = result ? result.usage : error && error.usage ? error.usage : null;
    const actual = job.mode === 'api' && usage ? actualCostUsd(ws, provider, usage, a) : null;
    const payload = {
      schema_version: 'cr.research-response.v1',
      run_id: doc.run_id,
      provider,
      attempt: a.n,
      attempt_id: a.attempt_id,
      started_at: a.started_at,
      dispatched_at: a.dispatched_at || null,
      finished_at: finishedAt,
      mode: job.mode,
      outcome: phase,
      prompt_sha256: doc.prompt.sha256,
      evidence_packet_sha256: doc.evidence_packet.sha256,
      attested: result ? result.attested : error && error.attested ? error.attested : null,
      usage: usage || null,
      cost_estimate_usd: a.cost_estimate_usd ?? null,
      cost_actual_usd: actual,
      error: error ? { kind: error.kind || 'error', message: error.message, http_status: error.httpStatus || null, request_id: error.requestId || null, code: error.code || null } : null,
      text: result ? result.text : null,
      text_sha256: result ? sha256(result.text) : null,
      raw_response: result ? result.raw : error && error.raw ? error.raw : null,
    };
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    // Never write over a file already at this attempt's path: it is evidence.
    let rel = responseRel(doc, provider, a.n);
    if (exists(ws.abs(rel))) rel = rel.replace(/\.json$/, `.${a.attempt_id}.json`);
    op.write(rel, text, { mode: 'create' });
    applyOutcome(ws, doc, job, a, { result, error, finishedAt, rel, fileSha: sha256(text), phase, actual });
    if (capture) Object.assign(a, { capture_id: capture.id, capture_sha256: capture.sha256 });
    if (captureError) a.capture_error = captureError.message || String(captureError);
    if (recoveredFrom) a.recovered_from = recoveredFrom;
    job.updated_at = finishedAt;
    op.writeJson(runRel, doc);
    return { phase, state: job.state, error: job.error, n: a.n, capture_sha256: capture ? capture.sha256 : null };
  });
  return { ...out.result, verified: out.verified };
}

// A capture can go once run.json records the same capture hash in a verified
// commit (or a commit made earlier already did).
function releaseCapture(ws, attemptId, capture, rec) {
  if (!capture || !rec || !rec.verified || rec.capture_sha256 !== capture.sha256) return false;
  return captures.removeCapture(ws, attemptId, capture.sha256);
}

// Commits an answer that was captured but never committed (a busy lock,
// blocked writes or a crash came between the two). Nothing is sent. Returns
// null when there is no capture for the attempt.
async function commitCaptured(ws, projectId, run, provider, attempt) {
  if (!attempt || !attempt.attempt_id) return null;
  const cap = captures.readCapture(ws, attempt.attempt_id);
  if (cap.missing) return null;
  // Another program has the file open without sharing reads (Windows): the
  // capture is not unusable, so the next run tries again.
  if (!cap.ok && cap.code === 'EBUSY') return { ok: false, busy: true, reason: `${cap.rel} ${cap.reason}`, rel: cap.rel };
  const bound = cap.ok ? captures.bindCapture(cap, run, provider, attempt) : { ok: false, reason: `${cap.rel} ${cap.reason}` };
  if (!bound.ok) return { ok: false, reason: bound.reason, rel: cap.rel };
  const capture = { id: attempt.attempt_id, sha256: cap.sha256, rel: cap.rel };
  const rec = recordOutcome(ws, run, provider, attempt.attempt_id, { result: bound.result || null, error: bound.error || null, finishedAt: bound.finishedAt || new Date().toISOString(), capture, recoveredFrom: 'captured answer committed after the runner could not save it; not sent again' });
  releaseCapture(ws, attempt.attempt_id, capture, rec);
  const after = loadRun(ws, projectId, run.run_id);
  const a = (after.jobs[provider].attempts || []).find((x) => x.attempt_id === attempt.attempt_id);
  if (a && a.phase === 'responded') return { ok: true, out: await importSaved(ws, after, provider, a) };
  return { ok: true, out: { provider, status: after.jobs[provider].state, recovered: true } };
}

// Removes captures whose answer is already committed (a runner stopped after
// the commit and before removing its capture). Leaves everything else.
function sweepCaptures(ws, { remove = true } = {}) {
  const out = { removed: 0, committed: 0, pending: [], unmatched: [], busy: [] };
  if (remove) captures.removeStaleTemps(ws);
  for (const c of captures.listCaptures(ws)) {
    if (!c.ok && c.code === 'EBUSY') {
      out.busy.push({ rel: c.rel });
      continue;
    }
    if (!c.ok || !c.body) {
      out.unmatched.push({ rel: c.rel, reason: c.reason });
      continue;
    }
    const b = c.body;
    const run = RUN_ID_RE.test(String(b.run_id)) && /^[a-z0-9][a-z0-9-]*$/.test(String(b.project_id)) ? loadRun(ws, b.project_id, b.run_id) : null;
    const job = run && run.jobs ? run.jobs[b.provider] : null;
    const a = job ? (job.attempts || []).find((x) => x.attempt_id === c.attempt_id) : null;
    if (!a) {
      out.unmatched.push({ rel: c.rel, reason: 'no attempt with this ID' });
      continue;
    }
    if (awaitingOutcome(a)) {
      out.pending.push({ rel: c.rel, run_id: b.run_id, project_id: b.project_id, provider: b.provider, attempt: a.n });
      continue;
    }
    if (a.capture_sha256 && a.capture_sha256 === c.sha256) {
      if (remove && captures.removeCapture(ws, c.attempt_id, c.sha256)) out.removed += 1;
      else out.committed += 1;
      continue;
    }
    out.unmatched.push({ rel: c.rel, reason: `attempt #${a.n} is ${a.phase || 'finished'} with a different or no capture` });
  }
  return out;
}

// Checks a saved response file against the attempt it claims to answer.
function validateSaved(ws, run, provider, attempt, rel) {
  let raw;
  try {
    raw = fs.readFileSync(ws.abs(rel));
  } catch (err) {
    return { ok: false, missing: err.code === 'ENOENT', reason: `${rel} cannot be read (${err.code || err.message})` };
  }
  const fileSha = sha256(raw);
  if (attempt.response_sha256 && fileSha !== attempt.response_sha256) return { ok: false, reason: `${rel} differs from the copy recorded when it was saved (SHA-256 mismatch)` };
  let p;
  try {
    p = JSON.parse(raw.toString('utf8'));
  } catch (_) {
    return { ok: false, reason: `${rel} is not valid JSON` };
  }
  const bad = [];
  if (!p || p.run_id !== run.run_id) bad.push('run');
  if (!p || p.provider !== provider) bad.push('provider');
  if (!p || p.attempt !== attempt.n) bad.push('attempt number');
  if (attempt.attempt_id && (!p || p.attempt_id !== attempt.attempt_id)) bad.push('attempt ID');
  if (!p || p.prompt_sha256 !== run.prompt.sha256) bad.push('prompt hash');
  if (!p || p.evidence_packet_sha256 !== run.evidence_packet.sha256) bad.push('evidence packet hash');
  if (p && p.text !== null && p.text !== undefined) {
    if (typeof p.text !== 'string') bad.push('text');
    else if (p.text_sha256 ? sha256(p.text) !== p.text_sha256 : Boolean(attempt.attempt_id)) bad.push('text hash');
  }
  if (bad.length) return { ok: false, reason: `${rel} does not match this attempt (${bad.join(', ')})`, payload: p };
  return { ok: true, payload: p, sha256: fileSha };
}

// A job left in flight by a runner that stopped. Nothing is sent from here: a
// provably unsent attempt is released and requeued, a saved answer is
// validated and imported, and anything that may have been sent is held as
// uncertain. Older records (no phases) are read the same way.
async function recoverJob(ws, projectId, run, provider) {
  const job = run.jobs[provider];
  const last = lastAttempt(job);
  const phase = !last ? null : last.phase || (last.outcome === 'response_saved' && last.response_path ? 'responded' : !last.finished_at ? 'dispatched' : 'ended');
  const runId = run.run_id;
  const at = new Date().toISOString();
  const settle = (jj) => {
    jj.state = jj.cancel_requested ? 'canceled' : jj.attempts.length < jj.max_attempts ? 'queued' : 'failed';
    if (jj.state === 'failed') jj.error = jj.error || 'Stopped during the last allowed attempt.';
  };
  const result = (out) => {
    const j = out.job || ((loadRun(ws, projectId, runId) || {}).jobs || {})[provider] || {};
    return { provider, status: j.state === 'queued' ? 'requeued' : j.state || 'missing', recovered: true };
  };
  if (phase === 'imported' && last.report_id) {
    updateJob(ws, projectId, runId, provider, (jj) => { jj.state = 'completed'; jj.report_id = jj.report_id || last.report_id; }, `Recover ${provider} job in ${runId}`, 'research_recover');
    return { provider, status: 'completed', recovered: true };
  }
  if (!last || ['not_sent', 'errored', 'reconciled', 'ended', 'imported'].includes(phase)) {
    return result(updateJob(ws, projectId, runId, provider, settle, `Recover ${provider} job in ${runId}`, 'research_recover').result);
  }
  if (phase === 'uncertain') {
    updateJob(ws, projectId, runId, provider, (jj) => { jj.state = 'uncertain'; }, `Recover ${provider} job in ${runId}`, 'research_recover');
    return { provider, status: 'uncertain', recovered: true };
  }
  if (phase === 'reserved') {
    // Admitted, but the dispatch marker was never written: provably not sent.
    const out = updateJob(ws, projectId, runId, provider, (jj, r) => {
      const a = lastAttempt(jj);
      Object.assign(a, { phase: 'not_sent', finished_at: at, outcome: 'not_sent', note: 'The runner stopped before sending it; nothing was sent and the reservation was released.' });
      ledger(ws, r, jj, a, { actual_usd: 0, kind: 'release', note: 'not sent (runner stopped before the dispatch marker); reservation released' });
      settle(jj);
    }, `Release unsent ${provider} attempt in ${runId}`, 'research_recover');
    return result(out.result);
  }
  if (phase === 'responded' && last.response_path) return importSaved(ws, run, provider, last);
  // Dispatched: an answer captured but never committed comes first (audit F1).
  const cap = job.mode === 'api' ? await commitCaptured(ws, projectId, run, provider, last) : null;
  if (cap && cap.ok) return cap.out;
  if (cap && cap.busy) return { provider, status: 'captured', error: `The provider's answer was captured (${cap.rel}), but another program has that file open, so it could not be saved into the records yet. It will be saved by the next research run, without asking the provider again.` };
  // Dispatched, or an older attempt still marked in progress: look for its answer.
  const rel = last.response_path || responseRel(run, provider, last.n);
  const found = exists(ws.abs(rel)) ? validateSaved(ws, run, provider, last, rel) : { ok: false, missing: true };
  if (found.ok) {
    const p = found.payload;
    const res = typeof p.text === 'string' && p.text ? { text: p.text, attested: p.attested || {}, usage: p.usage || null, raw: p.raw_response } : null;
    const err = res ? null : Object.assign(new Error((p.error && p.error.message) || 'The saved response has no answer text.'), { kind: (p.error && p.error.kind) || 'empty', httpStatus: p.error ? p.error.http_status : null, requestId: p.error ? p.error.request_id : null, notSent: p.outcome === 'not_sent', usage: p.usage || null });
    updateJob(ws, projectId, runId, provider, (jj, r) => {
      const a = lastAttempt(jj);
      const ph = outcomePhase(jj, res, err);
      const actual = jj.mode === 'api' && (res ? res.usage : err.usage) ? actualCostUsd(ws, provider, res ? res.usage : err.usage, a) : null;
      applyOutcome(ws, r, jj, a, { result: res, error: err, finishedAt: p.finished_at || at, rel, fileSha: found.sha256, phase: ph, actual });
      a.recovered_from = 'saved response found after the runner stopped; not sent again';
    }, `Recover saved ${provider} response in ${runId}`, 'research_recover');
    const after = loadRun(ws, projectId, runId);
    const a = lastAttempt(after.jobs[provider]);
    if (a.phase === 'responded') return importSaved(ws, after, provider, a);
    return { provider, status: after.jobs[provider].state, recovered: true };
  }
  if (job.mode !== 'api') {
    // Fictional mock attempts are never billed: requeue as before.
    const out = updateJob(ws, projectId, runId, provider, (jj) => {
      const a = lastAttempt(jj);
      Object.assign(a, { phase: 'errored', finished_at: at, outcome: 'interrupted', error: 'The runner stopped during this attempt.' });
      settle(jj);
    }, `Recover ${provider} job in ${runId}`, 'research_recover');
    return result(out.result);
  }
  const capNote = cap && !cap.ok ? ` A captured answer was found but not used: ${cap.reason}; it is kept for inspection.` : '';
  const reason = (found.missing
    ? 'The runner stopped after this request was marked as sent and before an answer was captured or saved. It may have reached the provider and been billed. It is not resent automatically: reconcile it or retry it yourself.'
    : `The runner stopped after this request was marked as sent, and ${found.reason}; that file was not imported. The request may have been billed. Reconcile it or retry it yourself.`) + capNote;
  updateJob(ws, projectId, runId, provider, (jj) => {
    const a = lastAttempt(jj);
    Object.assign(a, { phase: 'uncertain', finished_at: at, outcome: 'interrupted', uncertain_reason: reason });
    if (!found.missing) a.unmatched_response_path = rel;
    if (cap && !cap.ok) a.unmatched_capture_path = cap.rel;
    jj.state = jj.cancel_requested ? 'canceled' : 'uncertain';
    jj.error = reason;
  }, `Hold uncertain ${provider} attempt in ${runId}`, 'research_recover');
  return { provider, status: 'uncertain', recovered: true };
}

async function runOneJob(ws, { project_id: projectId, run, job }, { fetchImpl, trigger }) {
  const provider = job.provider;
  const timeoutMs = (ws.settings.research.timeout_seconds || 600) * 1000;
  const leaseName = `research-${run.run_id}-${provider}`;
  const lease = acquireLease(ws, leaseName, timeoutMs + 60000, { label: trigger });
  if (!lease) return { provider, status: 'busy' };
  try {
    let fresh = loadRun(ws, projectId, run.run_id);
    let j = fresh && fresh.jobs[provider];
    if (!j) return { provider, status: 'missing' };
    if (IN_FLIGHT.has(j.state) && j.mode !== 'cowork') {
      const rec = await recoverJob(ws, projectId, fresh, provider);
      if (rec.status !== 'requeued') return rec;
      fresh = loadRun(ws, projectId, run.run_id);
      j = fresh.jobs[provider];
    }
    if (j.state !== 'queued') return { provider, status: 'skipped', state: j.state };
    if (j.cancel_requested) {
      updateJob(ws, projectId, run.run_id, provider, (jj) => { jj.state = 'canceled'; });
      return { provider, status: 'canceled' };
    }
    const status = providerStatus(ws)[provider];
    if (status.mode === 'manual') {
      updateJob(ws, projectId, run.run_id, provider, (jj) => { jj.state = 'unconfigured'; jj.mode = 'manual'; jj.note = `${PROVIDER_LABELS[provider]} API ${status.reason}.`; });
      return { provider, status: 'unconfigured' };
    }
    const prompt = fs.readFileSync(ws.abs(fresh.prompt.path), 'utf8');
    if (sha256(prompt) !== fresh.prompt.sha256) {
      updateJob(ws, projectId, run.run_id, provider, (jj) => { jj.state = 'failed'; jj.error = 'The saved prompt no longer matches its recorded hash; not sent.'; });
      return { provider, status: 'failed' };
    }
    let plan = null;
    if (status.mode === 'api') {
      plan = callPlan(ws, provider, prompt);
      if (!plan.ok) {
        updateJob(ws, projectId, run.run_id, provider, (jj) => { jj.state = 'failed'; jj.error = `Not sent: ${plan.reason}`; });
        return { provider, status: 'refused', reason: plan.reason };
      }
    }
    const adm = admitAttempt(ws, projectId, run.run_id, provider, { mode: status.mode, model: status.model || null, plan });
    if (!adm.admitted) return { provider, status: adm.status, reason: adm.reason, state: adm.state };
    const attemptId = adm.attempt.attempt_id;
    if (!markDispatched(ws, projectId, run.run_id, provider, attemptId).send) return { provider, status: 'canceled' };
    let result = null;
    let error = null;
    try {
      if (status.mode === 'mock') {
        result = await mockCall(ws, provider, fresh);
      } else {
        result = await providers.callProvider(provider, {
          model: status.model,
          prompt,
          maxOutputTokens: plan.bounds.max_output_tokens,
          maxSearches: plan.bounds.search.limit,
          key: providers.apiKeyFor(provider),
          signal: AbortSignal.timeout(timeoutMs),
          timeoutMs,
          fetchImpl,
        });
      }
    } catch (err) {
      error = err;
    }
    const finishedAt = new Date().toISOString();
    // Capture first, without the workspace lock (audit F1). A paid answer is
    // then never only in memory while this runner waits for the lock.
    let capture = null;
    let captureError = null;
    if (status.mode === 'api') {
      try {
        capture = captures.writeCapture(ws, { run: fresh, provider, attempt: adm.attempt, result, error, finishedAt, mode: 'api' });
      } catch (err) {
        captureError = err;
        try { logOp(ws, { phase: 'research_capture_failed', run_id: fresh.run_id, provider, attempt_id: attemptId, error: err.message }); } catch (_) { /* the commit below still tries */ }
      }
    }
    let rec;
    try {
      rec = recordOutcome(ws, fresh, provider, attemptId, { result, error, finishedAt, capture, captureError });
    } catch (err) {
      // The commit could not run. With a capture, the answer is safe and the
      // next runner commits it without a new request. Without one, the attempt
      // stays "dispatched": recovery holds it as uncertain, never resends it.
      const what = result ? 'answer' : 'outcome';
      return capture
        ? { provider, status: 'captured', error: `The provider's ${what} was captured (${capture.rel}) but could not be saved into the records yet (${err.message}). It will be saved by the next research run, without asking the provider again.` }
        : { provider, status: 'unsaved', error: `The provider's ${what} could not be captured${captureError ? ` (${captureError.message})` : ''} or saved (${err.message}). It is not resent automatically: the attempt will be held as uncertain until you reconcile or retry it.` };
    }
    releaseCapture(ws, attemptId, capture, rec);
    if (rec.already) {
      const now = loadRun(ws, projectId, run.run_id);
      return { provider, status: now.jobs[provider].state, already: true };
    }
    if (rec.phase !== 'responded') {
      const status2 = rec.phase === 'uncertain' ? 'uncertain' : rec.phase === 'not_sent' ? 'not_sent' : 'failed';
      return { provider, status: status2, error: rec.error, retry_queued: rec.state === 'queued' };
    }
    const after = loadRun(ws, projectId, run.run_id);
    return await importSaved(ws, after, provider, lastAttempt(after.jobs[provider]));
  } finally {
    releaseLease(ws, leaseName, lease);
  }
}

// Imports a saved response through the normal import path, after checking it
// still matches its attempt. Safe to repeat: the import is deduplicated by
// content hash and the job only completes once.
async function importSaved(ws, run, provider, attempt) {
  const check = validateSaved(ws, run, provider, attempt, attempt.response_path);
  if (!check.ok) {
    updateJob(ws, run.project_id, run.run_id, provider, (jj) => {
      jj.state = 'failed';
      jj.error = `The saved answer was not imported: ${check.reason}.`;
      const a = lastAttempt(jj);
      if (a) a.import_error = check.reason;
    }, `${provider} saved answer rejected in ${run.run_id}`);
    return { provider, status: 'failed', error: check.reason };
  }
  const saved = check.payload;
  if (!saved.text) return { provider, status: 'failed', error: 'Saved response has no text.' };
  if (run.jobs[provider].cancel_requested) {
    updateJob(ws, run.project_id, run.run_id, provider, (jj) => { jj.state = 'canceled'; jj.note = 'Canceled; the answer that arrived was kept in responses/ but not imported.'; });
    return { provider, status: 'canceled' };
  }
  const inbox = require('./inbox');
  const out = inbox.importContent(ws, provider, {
    content: saved.text,
    filename: `${run.project_id}__${run.run_id}_${provider}.md`,
    projectId: run.project_id,
    runId: run.run_id,
    channel: saved.mode === 'mock' ? 'mock adapter (fictional)' : `${providers.PROVIDER_API[provider].vendor} API`,
    attested: saved.mode === 'mock' ? null : saved.attested,
    promptSha256: saved.prompt_sha256,
    evidenceSha256: saved.evidence_packet_sha256,
  });
  const st = out.result.status;
  if (st === 'ingested' || st === 'duplicate') {
    if (st === 'duplicate') {
      updateJob(ws, run.project_id, run.run_id, provider, (jj) => {
        jj.state = 'completed';
        jj.report_id = out.result.report_id || jj.report_id;
        jj.link_method = 'same content already imported';
        const a = lastAttempt(jj);
        if (a && a.phase === 'responded') {
          a.phase = 'imported';
          a.report_id = jj.report_id;
        }
      });
    }
    return { provider, status: 'completed', report_id: out.result.report_id };
  }
  updateJob(ws, run.project_id, run.run_id, provider, (jj) => {
    jj.state = 'failed';
    jj.error = `The answer was saved but not imported: ${out.result.message}`;
    const a = lastAttempt(jj);
    if (a) a.outcome = 'invalid_output';
  }, `${provider} output rejected in ${run.run_id}`);
  return { provider, status: 'failed', error: out.result.message };
}

// Fictional responses for the labeled demo/test workspaces only.
async function mockCall(ws, provider, run) {
  if (ws.kind === 'real') throw new OpError('REFUSED', 'Mock providers are never used in the real workspace.');
  const mode = providerConfig(ws, provider).mock;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  await delay(20);
  if (mode === 'timeout') throw new providers.ProviderError('timeout', 'FICTIONAL mock: the provider did not answer before the time limit.');
  if (mode === 'http_500') throw new providers.ProviderError('http', 'FICTIONAL mock: HTTP 500', { httpStatus: 500, retryable: true });
  if (mode === 'invalid') return { text: 'FICTIONAL mock answer that is far too short.', attested: { provider: 'mock', model: 'fictional-fixture', response_id: `mock_${randomId(6)}` }, usage: { input_tokens: 10, output_tokens: 10, search_calls: 0 }, raw: '{}' };
  const fixtures = require('./demo').mockReport;
  const text = fixtures(ws, provider, run);
  return { text, attested: { provider: 'mock', model: 'fictional-fixture', response_id: `mock_${randomId(6)}`, request_id: null }, usage: { input_tokens: 1000, output_tokens: 2000, search_calls: 3 }, raw: JSON.stringify({ fictional: true }) };
}

async function runDueJobs(ws, { trigger = 'cli', fetchImpl = undefined, now = Date.now() } = {}) {
  // Scheduled refreshes: only when unattended paid research is enabled and
  // every bound and price it needs is set (providerStatus api).
  const created = [];
  const skippedSchedules = [];
  try { sweepCaptures(ws); } catch (_) { /* housekeeping only */ }
  for (const due of dueSchedules(ws, now)) {
    const st = providerStatus(ws);
    const usable = normalizeProviders(due.schedule.providers || ws.settings.research.default_providers).filter((p) => st[p].mode === 'api' || st[p].mode === 'mock');
    if (!ws.settings.research.unattended_enabled || !usable.length) {
      skippedSchedules.push({ project_id: due.project_id, reason: !ws.settings.research.unattended_enabled ? 'unattended research is disabled' : 'no provider has a configured, bounded paid API' });
      continue;
    }
    try {
      const r = createRun(ws, { project_id: due.project_id, providers: usable, channel: 'schedule', same_as_last: true, kind: 'refresh' });
      created.push(r.run_id);
    } catch (err) {
      skippedSchedules.push({ project_id: due.project_id, reason: err.message });
    }
  }
  const max = Math.max(1, ws.settings.research.max_concurrent || 1);
  const todo = allOpenJobs(ws).filter(({ job }) => isDueJob(job));
  const results = [];
  for (let i = 0; i < todo.length; i += max) {
    const batch = todo.slice(i, i + max);
    results.push(...await Promise.all(batch.map((t) => runOneJob(ws, t, { fetchImpl, trigger }).catch((err) => ({ provider: t.job.provider, status: 'error', error: err.message })))));
  }
  const done = results.filter((r) => r.status === 'completed').length;
  const failed = results.filter((r) => ['failed', 'error', 'budget_refused', 'refused'].includes(r.status)).length;
  const uncertain = results.filter((r) => r.status === 'uncertain' || r.status === 'unsaved').length;
  const captured = results.filter((r) => r.status === 'captured').length;
  return {
    status: !todo.length && !created.length ? 'noop' : failed || uncertain || captured ? 'attention' : 'ok',
    summary: todo.length || created.length ? `${done} research job(s) completed, ${failed} failed or refused${uncertain ? `, ${uncertain} uncertain (may have been billed; reconcile or retry)` : ''}${captured ? `, ${captured} answer(s) captured and waiting to be saved by the next run` : ''}, ${created.length} scheduled run(s) created${skippedSchedules.length ? `, ${skippedSchedules.length} schedule(s) waiting (${skippedSchedules[0].reason})` : ''}` : skippedSchedules.length ? `Research refresh due for ${skippedSchedules.length} project(s), not started: ${skippedSchedules[0].reason}` : 'No research jobs waiting',
    results,
    created,
    skipped_schedules: skippedSchedules,
  };
}

// Compact per-provider research state for a project (watchlist and panels).
function researchStateFor(ws, projectId) {
  const runs = listRuns(ws, projectId).filter((r) => !r.broken);
  const latest = runs[0] || null;
  const byProvider = {};
  for (const p of PROVIDERS) {
    const run = runs.find((r) => r.jobs[p]);
    byProvider[p] = run ? { run_id: run.run_id, state: run.jobs[p].state, mode: run.jobs[p].mode, error: run.jobs[p].error || null, report_id: run.jobs[p].report_id || null, updated_at: run.jobs[p].updated_at, run_created_at: run.created_at } : null;
  }
  return { latest_run: latest ? { run_id: latest.run_id, status: latest.status, created_at: latest.created_at, providers: latest.providers, horizon: latest.horizon } : null, providers: byProvider, runs: runs.length };
}

module.exports = {
  RUN_ID_RE,
  createRun,
  listRuns,
  loadRun,
  runStatus,
  providerStatus,
  callBounds,
  callPlan,
  estimateCostUsd,
  actualCostUsd,
  attemptCharge,
  budgetCheck,
  spendSoFar,
  evidencePacket,
  cancelJob,
  retryJob,
  reconcileAttempt,
  stageReportLink,
  autoLinkReport,
  hasDueWork,
  dueSchedules,
  runDueJobs,
  sweepCaptures,
  commitCaptured,
  researchStateFor,
  normalizeProviders,
};
