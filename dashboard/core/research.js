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
//   submitted   (ChatGPT, Gemini) the provider accepted the request to run in
//               the background and its ID is saved: the answer is collected by
//               that ID on later checks, also after a restart, never by
//               sending the request again.
//   responded   the answer and its usage were saved in the same write as the
//               pointer to them (a provider error answer is "errored").
//   imported    the answer became a report.
//   not_sent    provably never sent; the reservation is released.
//   uncertain   may have been sent and billed, and no answer was saved. Its
//               reservation keeps counting and it is never resent by itself:
//               you reconcile it or retry it.
//   reconciled  you recorded what the provider charged (or that it did not).
// The ambiguous window cannot be closed from this side: after the dispatch
// marker and before an answer (or, for a background request, its ID) is
// captured, a crash cannot tell "never left this PC" from "sent and billed".
// The provider APIs used here document no idempotency for these calls, so
// none is assumed. A 400-level refusal (bad request, key or model, rate
// limit) is an answer before any work and is not billed; a 500-level answer
// may come from a request that ran, so it is held as uncertain, not resent.
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
// Resumed turns are off unless settings allow them (research.max_continuations).
const DEFAULT_CONTINUATIONS = 0;
const CHARS_PER_TOKEN = 3.5;
const SEARCH_RESULT_TOKENS = 4000;
// The request parameter that caps searches, per provider. Gemini has none.
const SEARCH_CONTROL = { claude: 'max_uses', chatgpt: 'max_tool_calls', gemini: null };
const EFFORTS = { claude: ['low', 'medium', 'high', 'xhigh', 'max'], chatgpt: ['low', 'medium', 'high', 'xhigh', 'max'], gemini: ['minimal', 'low', 'medium', 'high'] };
// A background request (ChatGPT, Gemini) still running after this long is
// cancelled at the provider (research.background_deadline_minutes).
const DEFAULT_BACKGROUND_MINUTES = 60;
// One check of a background request holds its job only this long.
const POLL_LEASE_MS = 3 * 60000;
// How often a still-running background request's progress is written down.
const POLL_NOTE_MS = 5 * 60000;
// Rate limits: a request the provider refused with 429 is asked again after
// its Retry-After (or this wait), at most this many times per job.
const RATE_LIMIT_WAIT_MS = 2 * 60000;
const MAX_RATE_LIMITED = 5;
// Jobs a model's own assistant does through the desk connector (mcp.js):
// Claude in Cowork ("cowork"), ChatGPT or Gemini ("connector"). The runner
// never sends anything for them.
const ASSISTANT_MODES = new Set(['cowork', 'connector']);
const isAssistantJob = (job) => Boolean(job && ASSISTANT_MODES.has(job.mode));
const assistantMode = (provider) => (provider === 'claude' ? 'cowork' : 'connector');

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

// Models Eric put on hold (settings research.on_hold.<model>: { since,
// reason }; null lifts it). A model on hold gets nothing new: it is left out
// of "all three" and of the default models, its waiting jobs are kept but not
// handed out, and its jobs not yet sent to a paid API stay unsent. A request
// already sent is still collected and recovered, and its saved reports stay.
// Choosing it by name for one run (the dashboard's model boxes, the CLI) is
// Eric's own decision and is not refused.
function heldProviders(ws) {
  const h = ((ws.settings || {}).research || {}).on_hold || {};
  const out = {};
  for (const p of PROVIDERS) if (h[p] && typeof h[p] === 'object') out[p] = { since: h[p].since || null, reason: h[p].reason || null };
  return out;
}

// A restored copy (exporter.js writes config/restored-copy.json on a clean
// restore into a new folder): while it holds research, the runner asks no
// provider for anything, new or collected, and creates no scheduled run.
const RESTORED_REL = 'config/restored-copy.json';
function restoredHold(ws) {
  const m = readJson(ws.abs(RESTORED_REL), null);
  return m && typeof m === 'object' && m.research_held !== false ? m : null;
}

// Eric's release of a restored copy: queued jobs may then be sent and
// accepted requests collected by their ID, within the limits; an uncertain
// attempt is still never resent.
function releaseRestoredCopy(ws) {
  const cur = readJson(ws.abs(RESTORED_REL), null);
  if (!cur) return { status: 'unchanged', message: 'This workspace is not a restored copy; nothing is held.' };
  if (cur.research_held === false) return { status: 'unchanged', message: `Research was already released on ${cur.released_at || 'an earlier date'}.` };
  const out = require('./ops').runOp(ws, { type: 'update_settings', summary: 'Release research in a restored copy' }, (op) => {
    op.writeJson(RESTORED_REL, { ...cur, research_held: false, released_at: new Date().toISOString() });
  });
  return { status: 'saved', verified: out.verified, research_held: false, message: 'Research released in this restored copy. Uncertain attempts are still never resent.' };
}

// Jobs the runner never sends: queued for a model on hold, or held when their
// project was archived (job.hold). Both wait, unsent, for Eric.
const heldUnsent = (held, job) => job.state === 'queued' && Boolean(job.hold || held[job.provider]);

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
    // Gemini 3 bills every query the model runs and no request parameter caps
    // them: max searches is then the number the reservation assumes, an
    // estimate. Google's project spend cap is a second guard, not a hard
    // limit: Google applies it with about ten minutes of billing delay and
    // documents that long-running tasks can exceed it.
    else if (cfg.search_billing === 'per_query') billing = 'per_query';
    else problems.push('a bound on Gemini searches: the Gemini API has no per-request search limit, so set max searches to 0, declare per-request search billing if your model bills grounding per prompt (Gemini 2.5 and older), or declare per-query billing (Gemini 3: every search query is billed; the desk then reserves max searches as an estimate, and a search count the answer does not report is never assumed: the attempt keeps counting at its reservation until you reconcile it. A Google project spend cap is a useful second guard, but Google applies it with about ten minutes of delay, so it is not a hard limit)');
  }
  const perSearch = cfg.search_result_tokens_estimate === undefined || cfg.search_result_tokens_estimate === null ? SEARCH_RESULT_TOKENS : cfg.search_result_tokens_estimate;
  if (!Number.isInteger(perSearch) || perSearch < 0) problems.push('a search result token estimate (a whole number)');
  // Claude's search loop can pause mid-answer; the turn is resumed at most this
  // many times, and every resumed request is part of the same reservation.
  const cont = provider === 'claude' ? (r.max_continuations === undefined || r.max_continuations === null ? DEFAULT_CONTINUATIONS : r.max_continuations) : 0;
  if (!Number.isInteger(cont) || cont < 0 || cont > 5) problems.push('a continuation limit (a whole number from 0 to 5)');
  // How hard the model thinks: Claude's effort (research.effort), ChatGPT's
  // reasoning effort and Gemini's thinking level (per provider, "off" sends
  // none). Reasoning and thinking count toward the output limit.
  const effort = provider === 'claude' ? r.effort || 'high' : cfg.effort === 'off' ? null : cfg.effort || (provider === 'chatgpt' || provider === 'gemini' ? 'high' : null);
  if (effort && !EFFORTS[provider].includes(effort)) problems.push(`an effort level (${EFFORTS[provider].join(', ')}, or off)`);
  for (const k of ['cache_write_usd_per_mtok', 'cache_read_usd_per_mtok']) if (cfg[k] !== undefined && cfg[k] !== null && !isMoney(cfg[k])) problems.push(`a valid ${k.replace(/_/g, ' ')}`);
  // ChatGPT and Gemini research runs on the provider's side and is collected
  // by its ID (providers.backgroundRoute); it is cancelled if it has not
  // finished within this many minutes.
  const route = providers.backgroundRoute(provider, cfg);
  const deadline = r.background_deadline_minutes === undefined || r.background_deadline_minutes === null ? DEFAULT_BACKGROUND_MINUTES : r.background_deadline_minutes;
  if (route && (!Number.isInteger(deadline) || deadline < 5 || deadline > 24 * 60)) problems.push('a background time limit (research.background_deadline_minutes, 5 to 1440)');
  return {
    ok: !problems.length,
    problems,
    max_output_tokens: maxOut,
    max_continuations: Number.isInteger(cont) ? cont : 0,
    requests_max: 1 + (Number.isInteger(cont) ? cont : 0),
    effort,
    route,
    deadline_minutes: route ? deadline : null,
    search: { enabled, limit: enabled ? limit : 0, control: enabled ? SEARCH_CONTROL[provider] || null : null, billing },
    search_result_tokens: perSearch,
    prices: { input_usd_per_mtok: cfg.input_usd_per_mtok ?? null, output_usd_per_mtok: cfg.output_usd_per_mtok ?? null, search_usd_per_call: cfg.search_usd_per_call ?? null, cache_write_usd_per_mtok: cfg.cache_write_usd_per_mtok ?? null, cache_read_usd_per_mtok: cfg.cache_read_usd_per_mtok ?? null },
  };
}

// What the request itself enforces, and what is only estimated.
function describeBounds(b) {
  const enforced = [b.requests_max > 1
    ? `at most ${b.max_output_tokens} output tokens per request and at most ${b.requests_max} requests for one answer (the first and up to ${b.max_continuations} resumed turns)`
    : `at most ${b.max_output_tokens} output tokens (the output limit sent with the request)`];
  if (!b.search.enabled) enforced.push('web search off');
  else if (b.search.billing === 'per_request') enforced.push('one search fee per request (declared per-request billing; the Gemini API cannot cap the number of searches)');
  else if (b.search.billing !== 'per_query') enforced.push(`at most ${b.search.limit} searches (${b.search.control} sent with the request)`);
  const estimated = ['prompt tokens'];
  if (b.search.billing === 'per_query') estimated.push(`the search fee, reserved for about ${b.search.limit} searches (Gemini bills every query and cannot cap them; if the answer does not report the count, the attempt keeps counting at its reservation until reconciled)`);
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
      : { mode: 'api', reason: null, model: cfg.model, key: { present: true, source: key.source }, bounds: describeBounds(bounds), background: Boolean(bounds.route) };
  }
  return out;
}

// What a model's API route still needs, in words Eric can act on. A missing
// key names its environment variable: on the online desk Eric sets it in
// Render's environment himself (never through a chat or the connector).
function setupNeeds(ws, provider, st = providerStatus(ws)[provider]) {
  if (!st || st.mode === 'api' || st.mode === 'mock') return null;
  const spec = providers.PROVIDER_API[provider];
  const missing = st.missing || [];
  const keyMissing = missing.includes('API key');
  const parts = missing.map((m) => (m === 'API key'
    ? `no ${spec.vendor} API key ${ws.hosted ? 'on the desk' : 'on this PC'} (${spec.env[0]}${ws.hosted ? ', set in Render\'s environment' : `, or "${spec.secret}" in ${providers.secretsFile()}`})`
    : m === 'spending budget' ? 'no research spending limits (per run, per day and per month)'
      : m.startsWith('a bound on Gemini searches') ? 'a bound on Gemini searches (max searches 0, or declared per-request or per-query search billing)' : m));
  const rest = missing.length - (keyMissing ? 1 : 0);
  const short = keyMissing
    ? `no ${spec.vendor} API key: ${spec.env[0]}${rest ? `, and ${rest} more setting${rest === 1 ? '' : 's'}` : ''}`
    : `${missing.length} setting${missing.length === 1 ? '' : 's'} missing`;
  return { missing, text: parts.join('; ') || st.reason || 'not configured', short };
}

// A typical run prompt (template, grading appendix and the dated evidence
// packet) is about 24,000 characters; readiness previews reservations for this.
const TYPICAL_PROMPT_CHARS = 30000;

// Readiness and execution, for Eric (Settings), Cowork (desk_status and
// start_research) and the start log. Three things are kept apart:
//   manual research   the model's own assistant does it when Eric asks it
//                     (Claude in Cowork, ChatGPT through its desk connection),
//                     or he pastes the prompt; nothing to set up, nothing billed
//   background API    optional: the model's paid API runs research by itself
//                     within the desk's limits; it needs a key, a model,
//                     bounds and a budget ("needs setup" until then)
//   on hold           Eric paused the model: nothing new is assigned to it
// Per model, `status` is automatic (its API is set up), manual, on_hold or
// demo (fictional fixtures); `route` keeps its earlier values (automatic,
// setup_required for the API, demo). Never a key, only whether one is present.
function readiness(ws, now = new Date()) {
  const status = providerStatus(ws);
  const held = heldProviders(ws);
  const budget = (ws.settings.research || {}).budget || {};
  const bs = budgetStatus(ws);
  const spent = spendSoFar(ws, now);
  const open = allOpenJobs(ws).filter(({ job }) => OPEN_STATES.has(job.state));
  const names = (ps) => ps.map((p) => PROVIDER_LABELS[p]).join(', ').replace(/, ([^,]*)$/, ' and $1');
  const models = {};
  for (const p of PROVIDERS) {
    const st = status[p];
    const label = PROVIDER_LABELS[p];
    const spec = providers.PROVIDER_API[p];
    const mine = open.filter((o) => o.job.provider === p).map((o) => o.job);
    const count = (pred) => mine.filter(pred).length;
    const jobs = {
      waiting: count((j) => j.state === 'unconfigured'),
      queued: count((j) => j.state === 'queued'),
      on_api: count((j) => IN_FLIGHT.has(j.state) && !isAssistantJob(j)),
      with_assistant: count((j) => j.state === 'running' && isAssistantJob(j)),
      uncertain: count((j) => j.state === 'uncertain'),
    };
    const route = st.mode === 'api' ? 'automatic' : st.mode === 'mock' ? 'demo' : 'setup_required';
    const need = setupNeeds(ws, p, st);
    const plan = route === 'automatic' ? callPlan(ws, p, 'x'.repeat(TYPICAL_PROMPT_CHARS)) : null;
    const model = st.model && st.mode !== 'mock' ? st.model : providerConfig(ws, p).model || null;
    const jobText = [
      jobs.on_api && `${jobs.on_api} running on the API`,
      jobs.queued && `${jobs.queued} queued`,
      jobs.with_assistant && `${jobs.with_assistant} with ${label} itself`,
      jobs.waiting && `${jobs.waiting} waiting`,
      jobs.uncertain && `${jobs.uncertain} uncertain (may have been billed; never resent)`,
    ].filter(Boolean).join(', ');
    const hold = held[p] || null;
    const manualWho = p === 'claude' ? 'Claude in Cowork' : `${label} through its desk connection`;
    const sentence = hold
      ? `${label}: on hold${hold.since ? ` since ${hold.since}` : ''}${hold.reason ? ` (${hold.reason.replace(/\.$/, '')})` : ''}. Nothing new is assigned to it; its saved reports stay, and its ${jobs.waiting} waiting job${jobs.waiting === 1 ? ' is' : 's are'} kept but not handed out.${jobs.on_api ? ` ${jobs.on_api} request${jobs.on_api === 1 ? '' : 's'} already sent to its API ${jobs.on_api === 1 ? 'is' : 'are'} still collected.` : ''}`
      : route === 'automatic'
        ? `${label}: automatic. Runs on the ${spec.vendor} API (${model}) in the background${plan && plan.ok ? `; about ${usd(plan.total_usd)} reserved per attempt for a typical prompt` : ''}.`
        : route === 'demo'
          ? `${label}: demo fixtures (fictional; nothing is sent or billed).`
          : ws.hosted
            ? `${label}: manual. ${manualWho} researches when Eric asks it (or he pastes the prompt); nothing is billed here. Automatic background research is optional and not set up: ${need.text}.`
            : `${label}: manual. Eric pastes the prompt into ${label} and imports the answer; nothing is billed. Automatic background research is optional and not set up: ${need.text}.`;
    models[p] = {
      label,
      route,
      status: hold ? 'on_hold' : route === 'automatic' ? 'automatic' : route === 'demo' ? 'demo' : 'manual',
      on_hold: hold,
      model,
      key: { present: providers.keyStatus(p).present, env: spec.env[0] },
      missing: need ? need.missing : [],
      setup: need ? need.text : null,
      setup_short: need ? need.short : null,
      background: route === 'automatic' ? Boolean(st.background) : null,
      reservation_usd: plan && plan.ok ? plan.total_usd : null,
      jobs,
      sentence: jobText ? `${sentence} Open jobs: ${jobText}.` : sentence,
    };
  }
  const auto = PROVIDERS.filter((p) => models[p].route === 'automatic' && !held[p]);
  const setup = PROVIDERS.filter((p) => models[p].route === 'setup_required');
  const manual = PROVIDERS.filter((p) => models[p].status === 'manual');
  const onHold = PROVIDERS.filter((p) => held[p]);
  // Every model and attempt of one run counts against the per-run limit. A
  // request from Cowork leaves Claude's part to Cowork itself (no API cost);
  // a run started on the dashboard uses every automatic model's API.
  const reserve = (list) => (list.length ? round4(list.reduce((s, p) => s + (models[p].reservation_usd || 0), 0)) : null);
  const fitsRun = (x) => (x === null || !isMoney(budget.per_run_usd) ? null : units(x) <= units(budget.per_run_usd));
  const coworkApis = auto.filter((p) => p !== 'claude');
  const reservations = {
    cowork_request_usd: reserve(coworkApis),
    cowork_request_fits: fitsRun(reserve(coworkApis)),
    dashboard_run_usd: reserve(auto),
    dashboard_run_fits: fitsRun(reserve(auto)),
  };
  const against = (x, fits) => (fits === null ? '' : fits ? `, within the ${usd(budget.per_run_usd)} per-run limit` : `, more than the ${usd(budget.per_run_usd)} per-run limit, so the last model would be refused (not sent) until the limit is raised`);
  const left = (limit, used) => (isMoney(limit) ? round4(Math.max(0, limit - used)) : null);
  const summary = [
    manual.length ? `Manual research: ${manual.map((p) => (p === 'claude' && ws.hosted ? 'Claude in Cowork' : ws.hosted ? `${PROVIDER_LABELS[p]} through its desk connection` : PROVIDER_LABELS[p])).join(', ').replace(/, ([^,]*)$/, ' and $1')}, when Eric asks${ws.hosted ? '' : ' (paste the prompt, import the answer)'}; nothing is billed.` : '',
    auto.length ? `Automatic background research (paid API, within the limits): ${names(auto)}.` : `Automatic background research: not set up for any model (optional; each needs its API key${ws.hosted ? ' in Render\'s environment' : ''}).`,
    setup.filter((p) => !held[p]).length && auto.length ? `Background API not set up: ${setup.filter((p) => !held[p]).map((p) => `${PROVIDER_LABELS[p]} (${models[p].setup_short})`).join('; ')}.` : '',
    onHold.length ? `On hold: ${onHold.map((p) => `${PROVIDER_LABELS[p]}${held[p].since ? ` since ${held[p].since}` : ''} (${models[p].jobs.waiting} waiting job${models[p].jobs.waiting === 1 ? '' : 's'} kept, nothing new assigned)`).join('; ')}.` : '',
    coworkApis.length ? `A three-model request from Cowork reserves about ${usd(reservations.cowork_request_usd)} on the ${names(coworkApis)} API${coworkApis.length === 1 ? '' : 's'} (Claude researches in Cowork itself)${against(reservations.cowork_request_usd, reservations.cowork_request_fits)}.` : '',
    auto.includes('claude') ? `A run started on the dashboard with ${names(auto)} on the API${auto.length === 1 ? '' : 's'} reserves about ${usd(reservations.dashboard_run_usd)}${against(reservations.dashboard_run_usd, reservations.dashboard_run_fits)}.` : '',
    bs.ok ? '' : `Research limits not set: ${bs.missing.join(', ')}.`,
    spent.uncertain_attempts ? `${spent.uncertain_attempts} paid attempt(s) uncertain: never resent; Eric reconciles them on the dashboard.` : '',
  ].filter(Boolean).join(' ');
  return {
    checked_at: now.toISOString(),
    summary,
    automatic: auto,
    setup_required: setup,
    manual,
    on_hold: onHold,
    models,
    reservations,
    retries_note: `A failed attempt is retried at most ${(ws.settings.research.max_attempts || 2) - 1} time(s) and only when nothing may have been billed; each retry is a new reservation inside the same per-run limit. An uncertain request is never resent.`,
    budget: { per_run_usd: budget.per_run_usd ?? null, daily_usd: budget.daily_usd ?? null, monthly_usd: budget.monthly_usd ?? null, ok: bs.ok, missing: bs.missing },
    spend: {
      today_usd: spent.daily,
      month_usd: spent.monthly,
      left_today_usd: left(budget.daily_usd, spent.daily),
      left_month_usd: left(budget.monthly_usd, spent.monthly),
      reserved_open_usd: spent.open_reservations_usd,
      estimated_usd: spent.estimated_usd,
      estimated_attempts: spent.estimated_attempts,
      known_month_usd: spent.known_month_usd,
      uncertain_attempts: spent.uncertain_attempts,
    },
    limits_note: 'The desk counts reservations, estimates and uncertain attempts against its limits before it sends anything, and a request already sent cannot be un-sent. Provider spend caps are a second guard: they apply with billing delay and are not hard limits.',
  };
}

// What a run's not-yet-sent paid jobs would be sent with, before anything is
// sent: per model the route, model ID, bounds and the reservation for the
// run's own frozen prompt, and whether the limits admit all of them now.
// Read-only. A job already sent, done or with its assistant is listed with
// its state only.
function preflight(ws, projectId, runId = null) {
  const run = runId ? loadRun(ws, projectId, runId) : openRunOf(ws, projectId);
  if (!run || !run.jobs) return null;
  let prompt = null;
  try {
    prompt = fs.readFileSync(ws.abs(run.prompt.path), 'utf8');
  } catch (_) {
    prompt = null;
  }
  const st = providerStatus(ws);
  const jobs = {};
  const wouldSend = [];
  let total = 0;
  for (const p of PROVIDERS) {
    const job = run.jobs[p];
    if (!job) continue;
    const pending = (job.state === 'unconfigured' || job.state === 'queued') && !isAssistantJob(job);
    if (!pending) {
      jobs[p] = { state: job.state, mode: job.mode, attempts: (job.attempts || []).length, note: job.state === 'completed' ? `saved (${job.report_id})` : isAssistantJob(job) ? 'with its assistant' : 'already sent or finished: nothing new would be reserved' };
      continue;
    }
    if (st[p].mode !== 'api' && st[p].mode !== 'mock') {
      const need = setupNeeds(ws, p, st[p]);
      jobs[p] = { state: job.state, route: 'setup_required', setup: need ? need.short : st[p].reason, note: 'nothing would be sent' };
      continue;
    }
    // A job with an execution note sends it too (as instructions): it counts.
    const note = require('./execution').readNote(ws, run, p);
    const plan = prompt === null
      ? { ok: false, reason: 'the run\'s prompt file could not be read' }
      : note && note.delivery.status !== 'verified'
        ? { ok: false, reason: 'the job\'s execution notes no longer match their recorded hash' }
        : callPlan(ws, p, note ? `${note.text}\n\n${prompt}` : prompt);
    if (!plan.ok) {
      jobs[p] = { state: job.state, route: 'automatic', error: plan.reason, note: 'nothing would be sent' };
      continue;
    }
    const b = plan.bounds;
    jobs[p] = {
      state: job.state,
      route: 'automatic',
      model: providerConfig(ws, p).model || null,
      api: b.route,
      max_output_tokens: b.max_output_tokens,
      requests_max: b.requests_max,
      effort: b.effort,
      search: b.search.enabled ? { limit: b.search.limit, billing: b.search.billing, capped_by_request: b.search.billing !== 'per_query' && b.search.billing !== null } : 'off',
      deadline_minutes: b.deadline_minutes,
      reservation_usd: plan.total_usd,
      enforced_usd: plan.enforced_usd,
      estimated_usd: plan.estimated_usd,
      parts: plan.parts.map((x) => ({ part: x.part, basis: x.basis, usd: x.usd })),
    };
    wouldSend.push(p);
    total = round4(total + plan.total_usd);
  }
  const check = wouldSend.length ? budgetCheck(ws, total, { runId: run.run_id }) : { ok: true };
  return {
    run_id: run.run_id,
    prompt_version: run.prompt ? run.prompt.version : null,
    prompt_sha256: run.prompt ? run.prompt.sha256 : null,
    prompt_chars: prompt === null ? null : prompt.length,
    jobs,
    would_send: wouldSend,
    total_reservation_usd: wouldSend.length ? total : 0,
    admitted_now: Boolean(check.ok),
    budget_note: check.ok ? (wouldSend.length ? `Within the limits: per run ${usd(ws.settings.research.budget.per_run_usd)}, per day ${usd(ws.settings.research.budget.daily_usd)}, per month ${usd(ws.settings.research.budget.monthly_usd)}.` : 'Nothing would be sent.') : check.reason,
    note: 'A reservation is an estimate of the bounded cost, not a maximum bill; billed attempts are never retried automatically, and an uncertain one is never resent.',
  };
}

// The reservation for one call: enforced parts (limits sent with the request)
// plus estimated parts (what no request parameter caps). Not a maximum.
function callPlan(ws, provider, promptText) {
  const b = callBounds(ws, provider);
  if (!b.ok) return { ok: false, reason: `Not configured: ${b.problems.join(', ')}.` };
  const p = b.prices;
  const tok = (n, perM) => round4((n / 1e6) * perM);
  const promptTokens = Math.ceil(String(promptText).length / CHARS_PER_TOKEN);
  // A resumed turn is another request: every bound counts once per request.
  const n = b.requests_max;
  const per = n > 1 ? ` across up to ${n} requests` : '';
  const outTokens = b.max_output_tokens * n;
  const parts = [{ part: 'output_tokens', basis: 'enforced', tokens: outTokens, usd: tok(outTokens, p.output_usd_per_mtok), detail: `${outTokens} output tokens at most (${b.max_output_tokens}, the output limit sent with each request${per})` }];
  if (b.search.enabled) {
    parts.push(b.search.billing === 'per_request'
      ? { part: 'search_fee', basis: 'enforced', units: n, usd: round4(p.search_usd_per_call * n), detail: `one search fee per request (declared per-request billing)${per}` }
      : b.search.billing === 'per_query'
        ? { part: 'search_fee', basis: 'estimated', units: b.search.limit * n, usd: round4(p.search_usd_per_call * b.search.limit * n), detail: `about ${b.search.limit} searches per request at the per-query price${per}: an estimate, because Gemini bills every query the model runs and no request parameter caps them (the actual count is recorded from the answer)` }
        : { part: 'search_fee', basis: 'enforced', units: b.search.limit * n, usd: round4(p.search_usd_per_call * b.search.limit * n), detail: `${b.search.limit} searches at most per request (${b.search.control})${per}` });
  }
  parts.push({ part: 'prompt_tokens', basis: 'estimated', tokens: promptTokens * n, usd: tok(promptTokens * n, p.input_usd_per_mtok), detail: `about ${promptTokens} prompt tokens per request (${CHARS_PER_TOKEN} characters per token)${per}; counted at the full input price` });
  if (b.search.enabled) {
    const t = b.search.limit * n * b.search_result_tokens;
    parts.push({ part: 'search_result_tokens', basis: 'estimated', tokens: t, usd: tok(t, p.input_usd_per_mtok), detail: `about ${b.search_result_tokens} tokens of search results per search, billed as input; nothing caps them` });
  }
  const sum = (basis) => round4(parts.filter((x) => x.basis === basis).reduce((a, x) => a + x.usd, 0));
  const enforced = sum('enforced');
  const estimated = sum('estimated');
  return { ok: true, total_usd: round4(enforced + estimated), enforced_usd: enforced, estimated_usd: estimated, parts, bounds: { max_output_tokens: b.max_output_tokens, max_continuations: b.max_continuations, requests_max: n, effort: b.effort, route: b.route, deadline_minutes: b.deadline_minutes, search: b.search }, prices: p };
}

function estimateCostUsd(ws, provider, promptText) {
  const plan = callPlan(ws, provider, promptText);
  return plan.ok ? plan.total_usd : null;
}

// Cost from the usage the provider reported, at the prices the attempt was
// admitted with. null when usage is incomplete (the reservation then counts).
// Cost from the usage the provider reported, at the prices the attempt was
// admitted with:
//   complete    every billable quantity was reported: usd is the actual cost.
//   incomplete  tokens were reported but not everything billable (usually the
//               number of searches): usd is an ESTIMATE, the known part plus
//               the unknown part at what the attempt reserved for it (for
//               Gemini, which cannot cap searches, the reserved search
//               estimate; for a capped search, the cap). It is never presented
//               as the actual cost, and the attempt keeps counting at no less
//               than its reservation until the owner reconciles it.
//   unknown     no usable token counts: usd is null (the reservation counts).
function costFromUsage(ws, provider, usage, attempt = null) {
  const prices = (attempt && attempt.prices) || callBounds(ws, provider).prices;
  if (!usage || typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return { status: 'unknown', usd: null, known_usd: null, unknown: ['tokens'], held_usd: null };
  if (!isMoney(prices.input_usd_per_mtok) || !isMoney(prices.output_usd_per_mtok)) return { status: 'unknown', usd: null, known_usd: null, unknown: ['prices'], held_usd: null };
  const search = attempt && attempt.bounds ? attempt.bounds.search : null;
  const calls = typeof usage.search_calls === 'number' ? usage.search_calls : null;
  let fee = 0;
  let held = 0;
  const unknown = [];
  if (isMoney(prices.search_usd_per_call)) {
    if (calls !== null) fee = prices.search_usd_per_call * (search && search.billing === 'per_request' ? Math.min(1, calls) : calls);
    else if (search && search.enabled) {
      // The provider did not say how many searches ran.
      unknown.push('search_calls');
      if (search.billing === 'per_request') held = prices.search_usd_per_call;
      else if (search.billing === 'per_query') {
        const part = attempt && attempt.estimate && Array.isArray(attempt.estimate.parts) ? attempt.estimate.parts.find((p) => p.part === 'search_fee') : null;
        held = part && isMoney(part.usd) ? part.usd : prices.search_usd_per_call * search.limit;
      } else held = prices.search_usd_per_call * search.limit;
    }
  }
  const known = tokenCost(usage, prices) + fee;
  return unknown.length
    ? { status: 'incomplete', usd: round4(known + held), known_usd: round4(known), unknown, held_usd: round4(held) }
    : { status: 'complete', usd: round4(known), known_usd: round4(known), unknown, held_usd: 0 };
}

// The actual cost, only when every billable quantity was reported; otherwise
// null (the attempt then counts at its reservation, or its estimate if higher).
function actualCostUsd(ws, provider, usage, attempt = null) {
  const c = costFromUsage(ws, provider, usage, attempt);
  return c.status === 'complete' ? c.usd : null;
}

function tokenCost(usage, prices) {
  // Cached input (OpenAI) is part of input_tokens and billed at the cache-read
  // price where one is configured; otherwise at the full input price.
  const cachedIn = typeof usage.cached_input_tokens === 'number' && isMoney(prices.cache_read_usd_per_mtok) ? Math.min(usage.cached_input_tokens, usage.input_tokens) : 0;
  // Prompt-cache tokens (Claude): written at the cache-write price, read at the
  // cache-read price; without a configured price, 1.25x and 0.1x the input price.
  const cw = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0;
  const cr = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;
  const pcw = isMoney(prices.cache_write_usd_per_mtok) ? prices.cache_write_usd_per_mtok : prices.input_usd_per_mtok * 1.25;
  const pcr = isMoney(prices.cache_read_usd_per_mtok) ? prices.cache_read_usd_per_mtok : prices.input_usd_per_mtok * 0.1;
  const cachedCost = cachedIn ? (cachedIn / 1e6) * prices.cache_read_usd_per_mtok : 0;
  return ((usage.input_tokens - cachedIn) / 1e6) * prices.input_usd_per_mtok + cachedCost + (cw / 1e6) * pcw + (cr / 1e6) * pcr + (usage.output_tokens / 1e6) * prices.output_usd_per_mtok;
}

// What one attempt counts against the limits:
//   reconciled  what the owner recorded from the provider's billing
//   actual      complete usage, priced at the attempt's prices
//   estimated   usage reported but incomplete: the estimate, and never less
//               than the reservation, until it is reconciled
//   reserved    no usage yet (or none at all): the reservation
// A provably unsent attempt counts nothing.
function attemptCharge(a) {
  if (!a) return { usd: 0, basis: 'none' };
  if (a.phase === 'not_sent') return { usd: 0, basis: 'not_sent' };
  if (isMoney(a.reconciled_usd) && (a.phase === 'reconciled' || a.reconciled_at)) return { usd: a.reconciled_usd, basis: 'reconciled' };
  if (isMoney(a.cost_actual_usd)) return { usd: a.cost_actual_usd, basis: 'actual' };
  const reserved = isMoney(a.reserved_usd) ? a.reserved_usd : isMoney(a.cost_estimate_usd) ? a.cost_estimate_usd : null;
  if (isMoney(a.cost_usage_estimate_usd)) return { usd: round4(Math.max(a.cost_usage_estimate_usd, reserved || 0)), basis: 'estimated' };
  if (reserved !== null) return { usd: reserved, basis: 'reserved' };
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
            const cost = u ? costFromUsage(ws, job.provider, u, a) : null;
            if (cost && isMoney(cost.usd) && cost.usd > c.usd) c = { usd: cost.usd, basis: cost.status === 'complete' ? 'captured_actual' : 'captured_estimate' };
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
  let estimated = 0;
  let estimatedN = 0;
  let actual = 0;
  let uncertain = 0;
  for (const c of charges) {
    const t = c.at ? Date.parse(c.at) : NaN;
    const d = Number.isFinite(t) ? ymdInTz(new Date(t)) : day;
    if (d === day) daily += c.usd;
    if (d.slice(0, 7) === month) monthly += c.usd;
    if (runId && c.run_id === runId) run += c.usd;
    if (c.basis === 'reserved' || c.basis === 'ledger_estimate') open += c.usd;
    if (c.basis === 'estimated' || c.basis === 'captured_estimate') {
      estimated += c.usd;
      estimatedN += 1;
    }
    if (['actual', 'ledger_actual', 'captured_actual', 'reconciled'].includes(c.basis) && d.slice(0, 7) === month) actual += c.usd;
    if (c.phase === 'uncertain') uncertain += 1;
  }
  // What the totals are made of: reservations (calls not answered yet, or
  // uncertain), estimates (answers with incomplete usage, held at least at
  // their reservation) and known costs (actual or reconciled).
  const out = { daily: round4(daily), monthly: round4(monthly), day, month, calls: charges.length, open_reservations_usd: round4(open), estimated_usd: round4(estimated), estimated_attempts: estimatedN, known_month_usd: round4(actual), uncertain_attempts: uncertain };
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
// v2 (2026-10-04) adds `fundamentals`: DefiLlama's fee, revenue and holders-
// revenue series for the project's bound entity, read from the saved cache
// (fundamentals.js; never fetched here), or why there is none. A run keeps the
// packet it was created with: v1 packets and their prompts stay as they are.

// What the saved fundamentals say for this project. Research never waits for
// or depends on them: a cache that cannot be read is frozen as unavailable.
function fundamentalsBlock(ws, project) {
  try {
    return require('./fundamentals').packetBlock(ws, project);
  } catch (err) {
    return { schema_version: 'cr.fundamentals.v1', provider: 'DefiLlama', state: 'unavailable', reason: `The saved fundamentals could not be read: ${String(err.message).slice(0, 200)}`, binding: null };
  }
}

// profileRef: the run's scoring profile (the current version of the one the
// project record names); without it, the record's.
function evidencePacket(ws, project, { profileRef = null } = {}) {
  const latest = require('./market').readLatest(ws);
  const id = project.identity && project.identity.status === 'verified' ? project.identity.coingecko_id : null;
  const obs = id && latest.assets ? latest.assets[id] : null;
  return {
    schema_version: 'cr.evidence-packet.v2',
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
      scoring_profile: profileRef || project.sector_profile,
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
      vs_btc: require('./cycle').assetVsBtc(latest, obs),
    } : { note: id ? 'No market observation stored yet.' : 'No verified token binding, so no market data.' },
    market_context: require('./cycle').packetContext(ws),
    fundamentals: fundamentalsBlock(ws, project),
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

// One provider's job in a run: done by the assistant that asked for it
// (through the desk connector), run by the paid API when it is set up and
// bounded, or waiting: the prompt is ready, and the model's own assistant takes
// the job over when Eric asks it (or Eric pastes the prompt and imports the answer).
function newJob(ws, p, st, { assistant = null } = {}) {
  const at = new Date().toISOString();
  const base = { provider: p, attempts: [], max_attempts: ws.settings.research.max_attempts || 2, report_id: null, error: null, updated_at: at, cancel_requested: false };
  const label = PROVIDER_LABELS[p];
  if (p === assistant) {
    return {
      ...base,
      state: 'running',
      mode: assistantMode(p),
      progress_at: at,
      note: p === 'claude'
        ? 'Assigned to Claude in Cowork, which researches it with this run\'s prompt. It completes when Cowork saves its report (the desk connector\'s save_report, or import with --run).'
        : `Assigned to ${label}, which researches it with this run's prompt through its desk connection. It completes when ${label} saves its report.`,
    };
  }
  if (st.mode === 'api' || st.mode === 'mock') return { ...base, state: 'queued', mode: st.mode, model: st.model };
  // Only the online desk has connections for the assistants to come through.
  const note = ws.hosted
    ? `${label} API ${st.reason}. Waiting for ${label}: ask ${label} through its desk connection to do its waiting research, or paste the prompt into ${label} yourself and import the answer for this run; it completes then.`
    : `${label} API ${st.reason}. Paste the prompt into ${label} yourself and import the answer for this run; it completes then.`;
  return { ...base, state: 'unconfigured', mode: 'manual', fallback: 'manual', note };
}

function createRun(ws, args = {}) {
  const projectId = args.project_id;
  const project = getProject(ws, projectId);
  if (project.status === 'archived') throw new OpError('INVALID', `${project.name} is archived. Unarchive it before researching it.`);
  const explicit = Boolean(args.providers && (Array.isArray(args.providers) ? args.providers.length : String(args.providers).trim()));
  // The default models leave out a model on hold; one named for this run is Eric's choice.
  const held = heldProviders(ws);
  const list = explicit ? normalizeProviders(args.providers) : normalizeProviders(ws.settings.research.default_providers).filter((p) => !held[p]);
  if (!list.length) throw new OpError('INVALID', 'Choose at least one provider: claude, chatgpt or gemini.');
  const previous = listRuns(ws, projectId);
  // The position-cycle recipe: an exact calendar interval inside the planning
  // ceiling, or a long-term exception with the owner's reason (position.js).
  const horizon = require('./position').resolveRunHorizon(ws, { args, previous, project });
  const horizonText = horizon.text;
  // Eric's own questions for this run (scope, not conclusions), in his words.
  const ownerInstructions = typeof args.owner_instructions === 'string' && args.owner_instructions.trim() ? args.owner_instructions.replace(/\r\n/g, '\n').trim().slice(0, 2000) : null;
  const rubricRef = (args.same_as_last && previous[0] && previous[0].rubric_version) || ws.rubrics.activeRef;
  if (!ws.rubrics.gradingVersions[rubricRef]) throw new OpError('INVALID', `Rubric ${rubricRef} is not available.`);
  // Repeating the same request within a few minutes does not start a second run.
  const recent = previous.find((r) => !r.broken && !TERMINAL.has(r.status) && Date.now() - Date.parse(r.created_at) < DEDUPE_MINUTES * 60000 && r.horizon.text === horizonText && JSON.stringify(r.providers) === JSON.stringify(list) && (r.owner_instructions || null) === ownerInstructions);
  if (recent && !args.force_new) {
    return { status: 'exists', project_id: projectId, run_id: recent.run_id, run: recent, message: `A research run for ${project.name} with the same providers and horizon started ${Math.round((Date.now() - Date.parse(recent.created_at)) / 60000)} min ago (${recent.run_id}). No second run was created.` };
  }
  const runId = `run_${compactTs()}_${randomId(5)}`;
  // The run's scoring profile: the current published version of the profile
  // the project record names (payfi-credit@1 -> payfi-credit@2). The record is
  // not rewritten; this run's prompt and its reports declare this version, and
  // the profile decides the prompt (cr-research-prompt@5 for one written for
  // it). Earlier runs and reports keep the versions they were made under.
  const profileRef = require('./rubrics').currentProfileRef(ws, project.sector_profile);
  const packet = evidencePacket(ws, project, { profileRef });
  const packetText = `${JSON.stringify(packet, null, 2)}\n`;
  const prompt = buildRunPrompt(ws, project, { runId, horizon, rubricRef, packet, ownerInstructions, profileRef });
  const status = providerStatus(ws);
  const channel = args.channel || ws.actor || 'cli';
  // The model doing this run itself through the desk connector, if any.
  const fromCowork = /cowork/i.test(channel) || /cowork/i.test(ws.actor || '');
  const assistant = args.assistant !== undefined ? (PROVIDERS.includes(args.assistant) ? args.assistant : null) : fromCowork ? 'claude' : null;
  const jobs = {};
  for (const p of list) jobs[p] = newJob(ws, p, status[p], { assistant });
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
    sector_profile: profileRef,
    horizon,
    owner_instructions: ownerInstructions,
    prompt: { version: require('./prompts').promptVersionFor(horizon, ws.rubrics.profiles[profileRef]), path: `${dir}/prompt.md`, sha256: sha256(prompt), identical_for_all_providers: true },
    evidence_packet: { path: `${dir}/evidence-packet.json`, sha256: sha256(packetText), captured_at: packet.captured_at, market_snapshot_id: packet.market_context.snapshot_id || null, schema_version: packet.schema_version, fundamentals_state: packet.fundamentals.state },
    independence: 'Each provider gets the same prompt and dated context and never sees another model\'s conclusions.',
    jobs,
  };
  const out = runOp(ws, { type: 'research_run_create', summary: `Research ${projectId} with ${list.join(', ')}` }, (op) => {
    op.write(`${dir}/prompt.md`, prompt, { mode: 'create' });
    op.write(`${dir}/evidence-packet.json`, packetText, { mode: 'create' });
    // A model's execution note (ChatGPT's, execution.js), frozen with its job
    // next to the prompt; the prompt itself stays the same for every model.
    for (const p of list) {
      const note = require('./execution').freezeNote(op, ws, run, p, dir);
      if (note) run.jobs[p].execution = note;
    }
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
  const parts = Object.values(run.jobs).map((j) => `${PROVIDER_LABELS[j.provider]}: ${j.state}${j.mode === 'manual' ? ' (prompt ready to paste)' : j.mode === 'cowork' ? ' (this Claude session)' : j.mode === 'connector' ? ` (${PROVIDER_LABELS[j.provider]} through its desk connection)` : ''}`);
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
// changes the attempt, outside its atomic save. A save that fails after this
// line was written and is then retried (from a capture, say) would write it
// again, so the reservation, release and actual lines are recorded once per
// attempt. An actual cost that differs from the one already recorded for the
// same attempt is kept as an explicit adjustment that replaces it.
const ONCE_PER_ATTEMPT = new Set(['reservation', 'release', 'actual', 'usage_incomplete']);

function ledger(ws, run, job, a, entry) {
  if (job.mode !== 'api') return;
  if (ONCE_PER_ATTEMPT.has(entry.kind)) {
    const prior = readJsonLines(ws.abs(SPEND_REL)).filter((l) => l.run_id === run.run_id && l.provider === job.provider && l.attempt === a.n && (l.attempt_id || null) === (a.attempt_id || null));
    if (entry.kind === 'actual') {
      const costs = prior.filter((l) => l.kind === 'actual' || l.kind === 'adjustment');
      if (costs.length) {
        const recorded = costs[costs.length - 1].actual_usd;
        if (recorded === entry.actual_usd) return;
        entry = { ...entry, kind: 'adjustment', replaces_actual_usd: recorded, note: 'the same outcome was saved again with a different cost; this replaces the earlier figure' };
      }
    } else if (prior.some((l) => l.kind === entry.kind)) {
      return;
    }
  }
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
    if (IN_FLIGHT.has(job.state) && !isAssistantJob(job)) {
      if (job.cancel_requested) return { message: 'Cancel already requested.' };
      job.cancel_requested = true;
      job.cancel_reason = reason;
      const last = lastAttempt(job);
      if (last && last.phase === 'submitted') return { message: `Cancel requested. The desk asks ${(providers.PROVIDER_API[provider] || {}).vendor || 'the provider'} to stop the request at its next check (within a few minutes); work done so far may still be billed and is recorded.` };
      return { message: 'Cancel requested. A request that was already sent to the provider may still be billed; its answer will be kept but not imported.' };
    }
    const open = uncertainOf(job);
    job.state = 'canceled';
    job.cancel_reason = reason;
    return { message: `${PROVIDER_LABELS[provider]} job canceled.${open.length ? ` Attempt ${open.map((a) => `#${a.n}`).join(', ')} may still have been billed; it stays counted until you reconcile it.` : ''}` };
  }, `Cancel ${provider} in ${runId}`);
  return { status: out.result.noop ? 'unchanged' : 'saved', noop: Boolean(out.result.noop), message: out.result.message, files: out.files, verified: out.verified };
}

// A job about to be (re)queued for the paid API takes the route the API has
// now: every integrity rule (spend log, actual cost, uncertain handling,
// capture recovery) keys on job.mode, so a job created while the API was not
// set up must not go to the API still marked manual or as an assistant's job.
function switchToApiRoute(job, st) {
  if (job.mode === st.mode && (job.model || null) === (st.model || null)) return;
  job.route_changes = [...(job.route_changes || []), { at: new Date().toISOString(), from: job.mode || null, to: st.mode, model: st.model || null }];
  job.mode = st.mode;
  job.model = st.model || null;
  job.fallback = null;
  delete job.connector_client;
}

// A project archived with research queued for a paid API that was never sent:
// those jobs are held (job.hold) so the runner never sends them. A request
// already sent is not touched: it can finish, be saved and be billed. A hold
// is lifted only by Eric's explicit retry (retryJob), also after a restore.
function holdUnsentJobs(ws, projectId, why = 'archived') {
  const held = [];
  for (const run of listRuns(ws, projectId)) {
    if (run.broken) continue;
    for (const [p, job] of Object.entries(run.jobs || {})) {
      if (job.state !== 'queued' || job.hold) continue;
      const out = updateJob(ws, projectId, run.run_id, p, (j) => {
        if (j.state !== 'queued' || j.hold) return;
        j.hold = { at: new Date().toISOString(), why };
        j.note = `Held, not sent: the project was ${why} before this request was sent. It is sent only if you send it again (Retry).`;
      }, `Hold unsent ${p} job in ${run.run_id}`);
      if (!out.result || !out.result.noop) held.push({ run_id: run.run_id, provider: p });
    }
  }
  return held;
}

const heldJobsOf = (ws, projectId) => listRuns(ws, projectId).flatMap((r) => (r.broken ? [] : Object.values(r.jobs || {}).filter((j) => j.state === 'queued' && j.hold).map((j) => ({ run_id: r.run_id, provider: j.provider, held_at: j.hold.at, why: j.hold.why }))));

// An explicit retry by the owner. After an uncertain attempt this asks the
// provider again; the uncertain attempt keeps counting until reconciled.
function retryJob(ws, projectId, runId, provider) {
  const st = providerStatus(ws)[provider];
  const project = getProject(ws, projectId);
  if (project.status === 'archived') throw new OpError('INVALID', `${project.name} is archived. Restore it before sending its research.`);
  const out = updateJob(ws, projectId, runId, provider, (job) => {
    if (job.state === 'completed') return { message: 'Already completed; start a new run to research again.' };
    if (IN_FLIGHT.has(job.state)) return { message: 'Still running.' };
    // Your retry is the go-ahead for a job held while its project was archived.
    if (job.hold) delete job.hold;
    // A quarantined answer stays saved (quarantined_report_id); the job asks again.
    if (job.outcome) delete job.outcome;
    if (st.mode === 'manual') {
      job.state = 'unconfigured';
      job.mode = 'manual';
      return { message: `${PROVIDER_LABELS[provider]} API is ${st.reason}; the prompt is ready to paste.` };
    }
    const open = uncertainOf(job);
    switchToApiRoute(job, st);
    job.note = `Sent to the ${PROVIDER_LABELS[provider]} API (${st.model || st.mode}) by your retry.`;
    delete job.not_before;
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
  if (!a || a.reconciled_at) return false;
  // An answer whose usage was incomplete: its cost is only an estimate.
  if (a.cost_status === 'estimated' && ['responded', 'imported', 'errored'].includes(a.phase)) return true;
  if (['reconciled', 'not_sent', 'imported', 'responded', 'reserved', 'dispatched', 'submitted'].includes(a.phase)) return false;
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
    if (target.phase === 'reconciled' || target.reconciled_at) {
      if (units(target.reconciled_usd) === units(amount)) return { message: `Attempt #${target.n} is already reconciled at ${usd(amount)}.`, attempt: target.n };
      throw new OpError('CONFLICT', `Attempt #${target.n} was already reconciled at ${usd(target.reconciled_usd)} on ${target.reconciled_at}.`);
    }
    if (!reconcilable(target)) throw new OpError('CONFLICT', `Attempt #${target.n} is ${String(target.phase || target.outcome || 'in progress').replace(/_/g, ' ')}; only an uncertain attempt, a provider error without usage, or an answer whose usage was incomplete can be reconciled.`);
    const before = attemptCharge(target).usd;
    const at = new Date().toISOString();
    // An answer that became a report keeps its phase (and its link to the
    // report); only its cost becomes the reconciled amount.
    const keepPhase = target.cost_status === 'estimated' && ['responded', 'imported'].includes(target.phase);
    Object.assign(target, { ...(keepPhase ? {} : { phase_before_reconcile: target.phase || null, phase: 'reconciled' }), reconciled_usd: amount, reconciled_at: at, reconciled_by: ws.actor || null, reconcile_reason: why });
    if (target.cost_status === 'estimated' || target.cost_status === 'unknown') target.cost_status = 'reconciled';
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
  if (job.state === 'completed' && job.report_id) {
    // The model's own assistant saved its report again for this run (after
    // fixing a format slip, say): the run follows its newest report, and the
    // earlier one stays saved and listed. A paid API answer keeps its link.
    if (!isAssistantJob(job) || job.report_id === reportId) return;
    const at = new Date().toISOString();
    job.previous_report_ids = [...(job.previous_report_ids || []), job.report_id];
    Object.assign(job, { report_id: reportId, linked_at: at, link_method: `${method}; replaces the earlier report from the same model`, updated_at: at });
    op.writeJson(rel, run);
    return;
  }
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

// A paid answer that does not match the run it was sent for (binding.js,
// mode record): saved as its own report, excluded from grades (inbox.js), and
// its job is not completed. The job fails with the reason, so it is in front
// of Eric and never back in the queue: a retry is his call. Its attempt keeps
// the answer, receipt and cost. A job that already has its report keeps it.
// Called inside the import operation, like stageReportLink.
function stageQuarantine(ws, op, { projectId, runId, provider, reportId, reason }) {
  if (!RUN_ID_RE.test(runId)) return;
  const rel = `${runDir(projectId, runId)}/run.json`;
  const run = op.readJson(rel, null);
  if (!run || !run.jobs || !run.jobs[provider]) return;
  const job = run.jobs[provider];
  if (job.state === 'completed' && job.report_id) return;
  const at = new Date().toISOString();
  Object.assign(job, {
    state: 'failed',
    outcome: 'contract_conflict',
    quarantined_report_id: reportId,
    error: `${PROVIDER_LABELS[provider]}'s answer was saved as report ${reportId} but quarantined: ${String(reason || 'it does not match this run').slice(0, 900)} Retry only if you want this run asked again.`,
    updated_at: at,
  });
  const last = (job.attempts || [])[(job.attempts || []).length - 1];
  if (last && last.phase === 'responded') Object.assign(last, { phase: 'imported', report_id: reportId, quarantined: true });
  op.writeJson(rel, run);
}

// A report imported without a run ID is linked to an open job for the same
// project and provider, if exactly one such job exists.
function autoLinkReport(ws, { projectId, provider, reportId, importedAt, json = null }) {
  const open = listRuns(ws, projectId).filter((r) => !r.broken && r.jobs[provider] && ['unconfigured', 'running', 'queued', 'failed'].includes(r.jobs[provider].state) && Date.parse(r.created_at) <= Date.parse(importedAt));
  if (open.length !== 1) return null;
  const run = open[0];
  // Never a report that states another prompt, profile or horizon than that
  // run's (binding.js): it stays saved on its own.
  if (json && !require('./binding').checkBinding(ws, { projectId, runId: run.run_id, provider, json, mode: 'declared' }).ok) return null;
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

// Queued jobs (once a rate limit's wait is over), background requests to
// check, and jobs a runner left in flight (their recovery never sends). A job
// an assistant is doing through the connector is never the runner's.
function isDueJob(job, now = Date.now()) {
  if (job.state === 'queued') return !job.not_before || !(Date.parse(job.not_before) > now);
  return IN_FLIGHT.has(job.state) && !isAssistantJob(job);
}

function hasDueWork(ws, now = Date.now()) {
  const held = heldProviders(ws);
  return allOpenJobs(ws).some(({ job }) => isDueJob(job, now) && !heldUnsent(held, job)) || dueSchedules(ws, now).length > 0 || staleAssistantJobs(ws, now).length > 0;
}

// A ChatGPT or Gemini request is running on the provider's side: the runner
// should check on it again soon.
function hasBackgroundWork(ws) {
  return allOpenJobs(ws).some(({ job }) => job.state === 'dispatching' && lastAttempt(job) && lastAttempt(job).phase === 'submitted');
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
function admitAttempt(ws, projectId, runId, provider, { mode, model, plan, delivered = null }) {
  const rel = `${runDir(projectId, runId)}/run.json`;
  const out = runOp(ws, { type: 'research_admit', summary: `Reserve a ${provider} attempt in ${runId}` }, (op) => {
    const run = op.readJson(rel, null);
    const job = run && run.jobs ? run.jobs[provider] : null;
    if (!job) throw new OpError('NOT_FOUND', `${runId} has no ${provider} job`);
    const now = new Date();
    const at = now.toISOString();
    if (job.state !== 'queued') return { admitted: false, status: 'skipped', state: job.state };
    // Held since the runner picked it (its project archived, its model put on
    // hold): checked again here, under the lock, before anything is reserved.
    if (job.hold || heldProviders(ws)[provider]) return { admitted: false, status: 'skipped', state: 'held' };
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
    if (delivered) attempt.delivered = delivered;
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
  // A 500-level answer: the provider may have run (and billed) the request.
  if (error.kind === 'http' && error.ambiguous && job.mode === 'api') return 'uncertain';
  // An answer arrived, even if refused, cut off or declined: a known outcome
  // (a 400-level refusal is known and not billed).
  if (['http', 'empty', 'incomplete', 'refused', 'failed', 'cancelled'].includes(error.kind)) return 'errored';
  return job.mode === 'api' ? 'uncertain' : 'errored';
}

// Usage seen before an answer stopped is a floor, never the bill.
const PARTIAL_USAGE_NOTE = 'Counted before the answer stopped: a lower bound, not the billed total. The attempt counts at its reservation until you reconcile it from the provider\'s billing.';

// What an answer that stopped early leaves to recover from, as kept in the
// response file and on the attempt: the text written before it stopped (in
// the file only; the attempt says how long it is), why it stopped and the
// usage seen so far. Never a report, never graded.
function partialOf(error) {
  if (!error) return {};
  const text = typeof error.partial_text === 'string' && error.partial_text ? error.partial_text : null;
  return {
    partial_usage: error.partial_usage || null,
    usage_status: error.partial_usage && !error.usage ? 'incomplete' : null,
    partial_text: text,
    partial_text_sha256: text ? sha256(text) : null,
    termination: error.termination || null,
  };
}

// Records an outcome on the attempt and moves the job on (inside an operation).
function applyOutcome(ws, run, job, a, { result, error, finishedAt, rel, fileSha, phase, actual, cost = null }) {
  Object.assign(a, { phase, finished_at: finishedAt, outcome: result ? 'response_saved' : phase === 'not_sent' ? 'not_sent' : error.kind || 'error', response_path: rel, response_sha256: fileSha });
  if (result) {
    const at = result.attested || {};
    Object.assign(a, { request_id: at.request_id || null, response_id: at.response_id || null, model_attested: at.model || null, usage: result.usage || null, cost_actual_usd: actual });
  } else {
    const at = error.attested || {};
    Object.assign(a, { error: error.message, http_status: error.httpStatus || null, request_id: error.requestId || at.request_id || null, usage: error.usage || null, cost_actual_usd: actual });
    // The provider's IDs for an answer that stopped (a background request
    // keeps the ID it is collected by).
    if (at.response_id && !a.response_id) a.response_id = at.response_id;
    if (at.model) a.model_attested = at.model;
    if (Array.isArray(at.request_ids) && at.request_ids.length > 1) a.request_ids = at.request_ids;
    const p = partialOf(error);
    if (p.partial_usage) a.partial_usage = p.partial_usage;
    if (p.usage_status) Object.assign(a, { usage_status: p.usage_status, usage_note: PARTIAL_USAGE_NOTE });
    if (p.termination) a.termination = p.termination;
    if (p.partial_text) a.partial_output = { chars: p.partial_text.length, sha256: p.partial_text_sha256, note: 'Text written before the answer stopped, kept in the response file for reading. Never saved as a report or graded.' };
  }
  // How certain the cost is: actual (complete usage), estimated (usage
  // reported but incomplete: never released below the reservation), or not
  // known (no usage: the reservation counts).
  if (actual !== null) a.cost_status = 'actual';
  else if (cost && cost.status === 'incomplete') {
    Object.assign(a, { cost_status: 'estimated', cost_usage_estimate_usd: cost.usd, cost_known_part_usd: cost.known_usd, cost_unknown: cost.unknown, cost_held_for_unknown_usd: cost.held_usd });
    a.cost_note = `The provider did not report ${cost.unknown.map((u) => (u === 'search_calls' ? 'how many searches ran' : u)).join(' or ')}: the cost is an estimate (${usd(cost.usd)}: ${usd(cost.known_usd)} from the reported usage plus ${usd(cost.held_usd)} kept for what was not reported), and it counts at no less than its reservation until you reconcile it from the provider's billing.`;
  } else if (phase !== 'not_sent' && job.mode === 'api') a.cost_status = 'unknown';
  if (actual !== null && isMoney(a.reserved_usd) && units(actual) > units(a.reserved_usd)) a.overrun_usd = round4(actual - a.reserved_usd);
  if (error && error.rejected && actual === 0) a.not_billed = 'refused by the provider before any work (400-level answer), which is not billed';
  const left = job.attempts.length < job.max_attempts;
  if (job.state === 'completed' && job.report_id) {
    // A report reached this job another way (imported by hand) while this
    // attempt was out: the job keeps its report; the outcome stays on the attempt.
    a.note = `The job already had report ${job.report_id} when this outcome arrived; it is kept on the attempt only.`;
  } else if (phase === 'errored' && error.rateLimited && !job.cancel_requested) {
    // A rate limit is a refusal before any work: ask again after the
    // provider's Retry-After, a few times, without using up the attempts.
    job.rate_limited = (job.rate_limited || 0) + 1;
    const label = PROVIDER_LABELS[job.provider];
    if (job.rate_limited <= MAX_RATE_LIMITED) {
      const wait = Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0 ? Math.min(error.retryAfterMs, 60 * 60000) : RATE_LIMIT_WAIT_MS * job.rate_limited;
      job.not_before = new Date(Date.parse(finishedAt) + wait).toISOString();
      job.max_attempts = Math.max(job.max_attempts || 2, job.attempts.length + 1);
      job.state = 'queued';
      job.error = `The ${label} API asked to slow down (rate limit); it was not billed. Asking again after ${job.not_before}.`;
    } else {
      job.state = 'failed';
      job.error = `The ${label} API refused the request for its rate limit ${job.rate_limited} times; it was not billed. Retry later, or check the account's limits.`;
    }
  } else if (phase === 'uncertain') {
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
  else if (actual !== null) ledger(ws, run, job, a, { actual_usd: actual, replaces_estimate: true, kind: 'actual', usage: a.usage || null, ...(a.not_billed ? { note: a.not_billed } : {}) });
  // Incomplete usage is not an actual cost: the log records the conservative
  // figure the limits count (never below the reservation) as an estimate.
  else if (a.cost_status === 'estimated') ledger(ws, run, job, a, { estimate_usd: attemptCharge(a).usd, kind: 'usage_incomplete', usage: a.usage || null, unknown: a.cost_unknown, note: 'usage reported but incomplete; counted as an estimate, not released below the reservation, until reconciled' });
}

// One verified write for the outcome: the response file (answer or error
// record) together with the attempt's pointer, phase, usage and cost.
// Applies once: an attempt that is no longer waiting for its outcome (another
// runner, or a rolled-forward commit, already recorded it) is left unchanged,
// so a capture recovered twice is committed and accounted once.
const awaitingOutcome = (a) => a.phase === 'dispatched' || a.phase === 'submitted' || (!a.phase && !a.finished_at);

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
    // A 400-level refusal without usage was answered before any work: not
    // billed. Otherwise the cost is actual only when the usage is complete.
    const cost = job.mode === 'api' && usage ? costFromUsage(ws, provider, usage, a) : null;
    const actual = cost ? (cost.status === 'complete' ? cost.usd : null) : job.mode === 'api' && error && error.rejected && phase === 'errored' ? 0 : null;
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
      cost_status: actual !== null ? 'actual' : cost && cost.status === 'incomplete' ? 'estimated' : job.mode === 'api' ? 'unknown' : null,
      cost_usage_estimate_usd: cost && cost.status === 'incomplete' ? cost.usd : null,
      error: error ? { kind: error.kind || 'error', message: error.message, http_status: error.httpStatus || null, request_id: error.requestId || (error.attested && error.attested.request_id) || null, code: error.code || null } : null,
      // An answer that stopped early: usage seen so far (incomplete), the
      // text written before it stopped and why. Not a report.
      ...(error ? { ...partialOf(error), usage_note: error.partial_usage && !error.usage ? PARTIAL_USAGE_NOTE : null } : {}),
      text: result ? result.text : null,
      text_sha256: result ? sha256(result.text) : null,
      raw_response: result ? result.raw : error && error.raw ? error.raw : null,
    };
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    // Never write over a file already at this attempt's path: it is evidence.
    let rel = responseRel(doc, provider, a.n);
    if (exists(ws.abs(rel))) rel = rel.replace(/\.json$/, `.${a.attempt_id}.json`);
    op.write(rel, text, { mode: 'create' });
    applyOutcome(ws, doc, job, a, { result, error, finishedAt, rel, fileSha: sha256(text), phase, actual, cost });
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
async function commitCaptured(ws, projectId, run, provider, attempt, { fetchImpl } = {}) {
  if (!attempt || !attempt.attempt_id) return null;
  const cap = captures.readCapture(ws, attempt.attempt_id);
  if (cap.missing) return null;
  // Another program has the file open without sharing reads (Windows): the
  // capture is not unusable, so the next run tries again.
  if (!cap.ok && cap.code === 'EBUSY') return { ok: false, busy: true, reason: `${cap.rel} ${cap.reason}`, rel: cap.rel };
  const bound = cap.ok ? captures.bindCapture(cap, run, provider, attempt) : { ok: false, reason: `${cap.rel} ${cap.reason}` };
  if (!bound.ok) return { ok: false, reason: bound.reason, rel: cap.rel };
  if (bound.submission) {
    // The provider accepted it in the background and its ID was captured,
    // but run.json never recorded the ID: record it now and collect the
    // answer by it. Nothing is sent again.
    const saved = recordSubmitted(ws, run, provider, attempt.attempt_id, { ...bound.submission, recoveredFrom: 'background request ID captured but not saved when the runner stopped; recorded afterwards, not sent again' });
    if (saved.verified) captures.removeCapture(ws, attempt.attempt_id, cap.sha256);
    const after = loadRun(ws, projectId, run.run_id);
    const a = (after.jobs[provider].attempts || []).find((x) => x.attempt_id === attempt.attempt_id);
    return { ok: true, out: await pollAttempt(ws, projectId, after, provider, a, { fetchImpl }) };
  }
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
    if (captures.isSubmissionOnly(b)) {
      // A background request's ID: spent once run.json has it (or has the
      // outcome); still needed while the attempt is only marked dispatched.
      if (a.phase === 'dispatched') out.pending.push({ rel: c.rel, run_id: b.run_id, project_id: b.project_id, provider: b.provider, attempt: a.n, kind: 'background request ID' });
      else if ((a.phase === 'submitted' && a.response_id === b.submission.response_id) || !awaitingOutcome(a)) {
        if (remove && captures.removeCapture(ws, c.attempt_id, c.sha256)) out.removed += 1;
        else out.committed += 1;
      } else out.unmatched.push({ rel: c.rel, reason: `attempt #${a.n} has a different background request ID` });
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

// The text an attempt's answer wrote before it stopped (cut off, out of its
// output limit, cancelled), read from its saved response file after checking
// that file against the attempt. Read-only: it is never imported, saved as a
// report or graded.
function partialOutput(ws, projectId, runId, provider, n) {
  const run = loadRun(ws, projectId, runId);
  const job = run && run.jobs ? run.jobs[provider] : null;
  const a = job ? (job.attempts || []).find((x) => x.n === n) : null;
  if (!a) throw new OpError('NOT_FOUND', `${runId} has no ${PROVIDER_LABELS[provider] || provider} attempt #${n}.`);
  if (!a.response_path) throw new OpError('NOT_FOUND', `Attempt #${n} has no saved response.`);
  const check = validateSaved(ws, run, provider, a, a.response_path);
  if (!check.ok) throw new OpError('CONFLICT', `The saved response of attempt #${n} cannot be shown: ${check.reason}.`);
  const text = check.payload.partial_text;
  if (typeof text !== 'string' || !text) throw new OpError('NOT_FOUND', `Attempt #${n} kept no partial answer.`);
  if (check.payload.partial_text_sha256 && sha256(text) !== check.payload.partial_text_sha256) throw new OpError('CONFLICT', `The partial answer of attempt #${n} does not match its recorded hash.`);
  return { text, chars: text.length, attempt: n, termination: check.payload.termination || null, response_path: a.response_path };
}

// A job left in flight by a runner that stopped. Nothing is sent from here: a
// provably unsent attempt is released and requeued, a saved answer is
// validated and imported, and anything that may have been sent is held as
// uncertain. Older records (no phases) are read the same way.
async function recoverJob(ws, projectId, run, provider, { fetchImpl } = {}) {
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
  // An answer kept but quarantined (it does not match this run): never
  // completed, never requeued, so never sent again.
  if (last && last.quarantined) {
    updateJob(ws, projectId, runId, provider, (jj) => {
      jj.state = 'failed';
      jj.outcome = 'contract_conflict';
      jj.quarantined_report_id = jj.quarantined_report_id || last.report_id || null;
    }, `Recover ${provider} job in ${runId}`, 'research_recover');
    return { provider, status: 'failed', recovered: true, quarantined: true };
  }
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
  // Running on the provider's side: collect it by its ID; never send it again.
  if (phase === 'submitted') return pollAttempt(ws, projectId, run, provider, last, { fetchImpl });
  // Dispatched: an answer (or a background request ID) captured but never
  // committed comes first (audit F1).
  const cap = job.mode === 'api' ? await commitCaptured(ws, projectId, run, provider, last, { fetchImpl }) : null;
  if (cap && cap.ok) return cap.out;
  if (cap && cap.busy) return { provider, status: 'captured', error: `The provider's answer was captured (${cap.rel}), but another program has that file open, so it could not be saved into the records yet. It will be saved by the next research run, without asking the provider again.` };
  // Dispatched, or an older attempt still marked in progress: look for its answer.
  const rel = last.response_path || responseRel(run, provider, last.n);
  const found = exists(ws.abs(rel)) ? validateSaved(ws, run, provider, last, rel) : { ok: false, missing: true };
  if (found.ok) {
    const p = found.payload;
    const res = typeof p.text === 'string' && p.text ? { text: p.text, attested: p.attested || {}, usage: p.usage || null, raw: p.raw_response } : null;
    const err = res ? null : Object.assign(new Error((p.error && p.error.message) || 'The saved response has no answer text.'), { kind: (p.error && p.error.kind) || 'empty', httpStatus: p.error ? p.error.http_status : null, requestId: p.error ? p.error.request_id : null, notSent: p.outcome === 'not_sent', usage: p.usage || null, partial_usage: p.partial_usage || null, partial_text: p.partial_text || null, termination: p.termination || null, attested: p.attested || null });
    updateJob(ws, projectId, runId, provider, (jj, r) => {
      const a = lastAttempt(jj);
      const ph = outcomePhase(jj, res, err);
      const u = res ? res.usage : err.usage;
      const cost = jj.mode === 'api' && u ? costFromUsage(ws, provider, u, a) : null;
      const actual = cost && cost.status === 'complete' ? cost.usd : null;
      applyOutcome(ws, r, jj, a, { result: res, error: err, finishedAt: p.finished_at || at, rel, fileSha: found.sha256, phase: ph, actual, cost });
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
  // Checking on a background request is short, so it holds the job briefly.
  const last0 = lastAttempt(job);
  const polling = job.state === 'dispatching' && last0 && last0.phase === 'submitted';
  const lease = acquireLease(ws, leaseName, polling ? POLL_LEASE_MS : timeoutMs + 60000, { label: trigger });
  if (!lease) return { provider, status: 'busy' };
  try {
    let fresh = loadRun(ws, projectId, run.run_id);
    let j = fresh && fresh.jobs[provider];
    if (!j) return { provider, status: 'missing' };
    if (IN_FLIGHT.has(j.state) && !isAssistantJob(j)) {
      const rec = await recoverJob(ws, projectId, fresh, provider, { fetchImpl });
      if (rec.status !== 'requeued') return rec;
      fresh = loadRun(ws, projectId, run.run_id);
      j = fresh.jobs[provider];
    }
    if (j.state !== 'queued') return { provider, status: 'skipped', state: j.state };
    if (j.not_before && Date.parse(j.not_before) > Date.now()) return { provider, status: 'waiting', until: j.not_before };
    if (j.cancel_requested) {
      updateJob(ws, projectId, run.run_id, provider, (jj) => { jj.state = 'canceled'; });
      return { provider, status: 'canceled' };
    }
    const status = providerStatus(ws)[provider];
    if (status.mode === 'manual') {
      updateJob(ws, projectId, run.run_id, provider, (jj) => { jj.state = 'unconfigured'; jj.mode = 'manual'; jj.note = `${PROVIDER_LABELS[provider]} API ${status.reason}.`; });
      return { provider, status: 'unconfigured' };
    }
    if (status.mode === 'api' && j.mode !== 'api') {
      // Queued without taking the API's route (a job made while the API was
      // not set up): every integrity rule keys on the route, so set it first.
      updateJob(ws, projectId, run.run_id, provider, (jj) => switchToApiRoute(jj, status), `Route ${provider} in ${run.run_id} to its API`);
      fresh = loadRun(ws, projectId, run.run_id);
      j = fresh.jobs[provider];
    }
    const prompt = fs.readFileSync(ws.abs(fresh.prompt.path), 'utf8');
    if (sha256(prompt) !== fresh.prompt.sha256) {
      updateJob(ws, projectId, run.run_id, provider, (jj) => { jj.state = 'failed'; jj.error = 'The saved prompt no longer matches its recorded hash; not sent.'; });
      return { provider, status: 'failed' };
    }
    // The job's execution note (ChatGPT's), checked against its frozen hash and
    // sent apart from the prompt (the API's instructions), so the input stays
    // the run's prompt byte for byte. A job made before notes existed has none.
    const note = require('./execution').readNote(ws, fresh, provider);
    if (note && note.delivery.status !== 'verified') {
      updateJob(ws, projectId, run.run_id, provider, (jj) => { jj.state = 'failed'; jj.error = 'The saved execution notes no longer match their recorded hash; not sent.'; });
      return { provider, status: 'failed' };
    }
    const instructions = note ? note.text : null;
    let plan = null;
    if (status.mode === 'api') {
      plan = callPlan(ws, provider, instructions ? `${instructions}\n\n${prompt}` : prompt);
      if (!plan.ok) {
        updateJob(ws, projectId, run.run_id, provider, (jj) => { jj.state = 'failed'; jj.error = `Not sent: ${plan.reason}`; });
        return { provider, status: 'refused', reason: plan.reason };
      }
    }
    // What this attempt sends, recorded on it: the prompt's hash and, for a
    // model with one, its execution note's version and hash.
    const delivered = { prompt_sha256: fresh.prompt.sha256, execution: note ? { ref: note.delivery.ref, sha256: note.delivery.sha256 } : null };
    const adm = admitAttempt(ws, projectId, run.run_id, provider, { mode: status.mode, model: status.model || null, plan, delivered });
    if (!adm.admitted) return { provider, status: adm.status, reason: adm.reason, state: adm.state };
    const attemptId = adm.attempt.attempt_id;
    if (!markDispatched(ws, projectId, run.run_id, provider, attemptId).send) return { provider, status: 'canceled' };
    // ChatGPT and Gemini: the provider runs it in the background; its ID is
    // saved and the answer is collected by later checks.
    if (status.mode === 'api' && plan.bounds.route) return await submitAttempt(ws, projectId, fresh, provider, adm.attempt, { plan, status, prompt, instructions, fetchImpl });
    let result = null;
    let error = null;
    try {
      if (status.mode === 'mock') {
        result = await mockCall(ws, provider, fresh);
      } else {
        result = await providers.callProvider(provider, {
          model: status.model,
          prompt,
          instructions,
          maxOutputTokens: plan.bounds.max_output_tokens,
          maxSearches: plan.bounds.search.limit,
          maxContinuations: plan.bounds.max_continuations,
          effort: plan.bounds.effort,
          key: providers.apiKeyFor(provider),
          signal: AbortSignal.timeout(timeoutMs),
          timeoutMs,
          fetchImpl,
        });
      }
    } catch (err) {
      error = err;
    }
    return await finishAttempt(ws, projectId, fresh, provider, adm.attempt, { result, error, finishedAt: new Date().toISOString(), mode: status.mode });
  } finally {
    releaseLease(ws, leaseName, lease);
  }
}

// Saves a finished outcome (an answer or a provider error) and imports an
// answer: capture first, without the workspace lock (audit F1), so a paid
// answer is never only in memory while this runner waits for the lock; then
// the one verified commit; then the import.
async function finishAttempt(ws, projectId, run, provider, attempt, { result = null, error = null, finishedAt, mode }) {
  const attemptId = attempt.attempt_id;
  const background = attempt.phase === 'submitted';
  let capture = null;
  let captureError = null;
  if (mode === 'api') {
    try {
      capture = captures.writeCapture(ws, { run, provider, attempt, result, error, finishedAt, mode: 'api' });
    } catch (err) {
      captureError = err;
      try { logOp(ws, { phase: 'research_capture_failed', run_id: run.run_id, provider, attempt_id: attemptId, error: err.message }); } catch (_) { /* the commit below still tries */ }
    }
  }
  let rec;
  try {
    rec = recordOutcome(ws, run, provider, attemptId, { result, error, finishedAt, capture, captureError });
  } catch (err) {
    // The commit could not run. With a capture, the answer is safe and the
    // next runner commits it without a new request. A background request is
    // still on the provider's side and is simply collected again. Otherwise
    // the attempt stays "dispatched": recovery holds it as uncertain, never
    // resends it.
    const what = result ? 'answer' : 'outcome';
    if (capture) return { provider, status: 'captured', error: `The provider's ${what} was captured (${capture.rel}) but could not be saved into the records yet (${err.message}). It will be saved by the next research run, without asking the provider again.` };
    if (background) return { provider, status: 'running', error: `The provider's ${what} could not be saved yet (${err.message}); it is collected again by its ID at the next check.` };
    return { provider, status: 'unsaved', error: `The provider's ${what} could not be captured${captureError ? ` (${captureError.message})` : ''} or saved (${err.message}). It is not resent automatically: the attempt will be held as uncertain until you reconcile or retry it.` };
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
}

// The verified write that turns a dispatched attempt into a background
// request with a saved ID (and the time it is cancelled if still running).
function recordSubmitted(ws, run, provider, attemptId, sub) {
  const out = updateJob(ws, run.project_id, run.run_id, provider, (job) => {
    const a = (job.attempts || []).find((x) => x.attempt_id === attemptId);
    if (!a) throw new OpError('NOT_FOUND', `Attempt ${attemptId} is missing from ${run.run_id}`);
    if (a.phase === 'submitted' && a.response_id === sub.response_id) return { already: true };
    if (a.phase !== 'dispatched') throw new OpError('CONFLICT', `Attempt ${attemptId} is ${a.phase || 'finished'}; its background request ID ${sub.response_id} was not recorded.`);
    const at = sub.submitted_at || new Date().toISOString();
    const minutes = sub.deadline_minutes || (a.bounds && a.bounds.deadline_minutes) || DEFAULT_BACKGROUND_MINUTES;
    Object.assign(a, {
      phase: 'submitted',
      response_id: sub.response_id,
      provider_route: sub.route || (a.bounds && a.bounds.route) || null,
      submitted_at: at,
      deadline_at: new Date(Date.parse(at) + minutes * 60000).toISOString(),
      provider_status: sub.status || null,
      request_id: sub.request_id || null,
      polled_at: null,
    });
    if (sub.recoveredFrom) a.recovered_from = sub.recoveredFrom;
    job.progress_at = at;
    job.note = `Running on the ${PROVIDER_LABELS[provider]} API in the background; its answer is collected by its ID, also after a restart.`;
    return null;
  }, `${provider} accepted in the background in ${run.run_id}`, 'research_submitted');
  return { verified: out.verified, already: Boolean(out.result && out.result.already) };
}

// Sends one attempt to run in the provider's background and saves its ID:
// first as a capture without the lock, then in run.json. A create that
// fails is an outcome like any other (refused, uncertain, not sent).
async function submitAttempt(ws, projectId, run, provider, attempt, { plan, status, prompt, instructions = null, fetchImpl }) {
  const label = PROVIDER_LABELS[provider];
  const submittedAt = new Date().toISOString();
  let sub = null;
  let error = null;
  try {
    sub = await providers.submitBackground(provider, {
      model: status.model,
      prompt,
      instructions,
      maxOutputTokens: plan.bounds.max_output_tokens,
      maxSearches: plan.bounds.search.limit,
      effort: plan.bounds.effort,
      key: providers.apiKeyFor(provider),
      fetchImpl,
      clientRequestId: attempt.attempt_id,
      metadata: { run_id: run.run_id, attempt_id: attempt.attempt_id, project_id: run.project_id },
    });
  } catch (err) {
    error = err;
  }
  if (!sub) return finishAttempt(ws, projectId, run, provider, attempt, { result: null, error, finishedAt: new Date().toISOString(), mode: 'api' });
  const info = { response_id: sub.response_id, status: sub.status, request_id: sub.request_id, route: plan.bounds.route, submitted_at: submittedAt, deadline_minutes: plan.bounds.deadline_minutes };
  let capture = null;
  try {
    capture = captures.writeCapture(ws, { run, provider, attempt, result: null, error: null, finishedAt: null, mode: 'api', submission: info });
  } catch (err) {
    try { logOp(ws, { phase: 'research_capture_failed', run_id: run.run_id, provider, attempt_id: attempt.attempt_id, response_id: sub.response_id, error: err.message }); } catch (_) { /* the commit below still tries */ }
  }
  let saved;
  try {
    saved = recordSubmitted(ws, run, provider, attempt.attempt_id, info);
  } catch (err) {
    return capture
      ? { provider, status: 'submitted', response_id: sub.response_id, note: `${label} accepted the request (${sub.response_id}); its ID was captured and the next research run records it and collects the answer (${err.message}).` }
      : { provider, status: 'unsaved', error: `${label} accepted the request (${sub.response_id}), but its ID could not be captured or saved (${err.message}). It is not resent automatically: the attempt will be held as uncertain until you reconcile or retry it.` };
  }
  if (capture && saved.verified) captures.removeCapture(ws, attempt.attempt_id, capture.sha256);
  if (sub.final) {
    // Already finished when it was accepted (rare): collect it now.
    const after = loadRun(ws, projectId, run.run_id);
    const a = (after.jobs[provider].attempts || []).find((x) => x.attempt_id === attempt.attempt_id);
    return finishAttempt(ws, projectId, after, provider, a, { result: sub.final.result || null, error: sub.final.error || null, finishedAt: new Date().toISOString(), mode: 'api' });
  }
  return { provider, status: 'submitted', response_id: sub.response_id };
}

// Holds a background request as uncertain when its answer can no longer be
// collected: it may have run and been billed, and it is never resent.
function holdUncollectable(ws, projectId, run, provider, attempt, reason) {
  updateJob(ws, projectId, run.run_id, provider, (jj) => {
    const a = (jj.attempts || []).find((x) => x.attempt_id === attempt.attempt_id);
    if (!a || a.phase !== 'submitted') return;
    Object.assign(a, { phase: 'uncertain', finished_at: new Date().toISOString(), outcome: 'uncollectable', uncertain_reason: reason });
    jj.state = jj.cancel_requested ? 'canceled' : 'uncertain';
    jj.error = reason;
  }, `Hold uncollectable ${provider} attempt in ${run.run_id}`, 'research_recover');
  return { provider, status: 'uncertain', recovered: true };
}

// One check on a background request: still running, finished (saved and
// imported like any answer), or stopped. A request asked to cancel (by you,
// or past its time limit) is cancelled at the provider and its outcome, with
// the usage so far, is recorded. Asking for the answer creates nothing and
// costs nothing, so a failed check only means asking again later.
async function pollAttempt(ws, projectId, run, provider, attempt, { fetchImpl } = {}) {
  const label = PROVIDER_LABELS[provider];
  const vendor = (providers.PROVIDER_API[provider] || {}).vendor || label;
  const job = run.jobs[provider];
  const now = Date.now();
  const deadline = attempt.deadline_at ? Date.parse(attempt.deadline_at) : Infinity;
  const minutes = attempt.bounds && attempt.bounds.deadline_minutes ? attempt.bounds.deadline_minutes : DEFAULT_BACKGROUND_MINUTES;
  const stopping = job.cancel_requested ? 'canceled' : now > deadline ? 'deadline' : null;
  // Progress is written when the provider's status or the problem changes,
  // or every few minutes: not on every check.
  const note = (fields) => {
    const last = attempt.polled_at ? Date.parse(attempt.polled_at) : 0;
    const changed = (fields.provider_status !== undefined && fields.provider_status !== attempt.provider_status) || (fields.poll_error !== undefined && fields.poll_error !== (attempt.poll_error || null)) || Boolean(fields.cancel_sent_at && !attempt.cancel_sent_at);
    if (!changed && now - last < POLL_NOTE_MS) return;
    updateJob(ws, projectId, run.run_id, provider, (jj) => {
      const a = (jj.attempts || []).find((x) => x.attempt_id === attempt.attempt_id);
      if (!a || a.phase !== 'submitted') return;
      a.polled_at = new Date(now).toISOString();
      if (fields.provider_status) a.provider_status = fields.provider_status;
      if (fields.poll_error !== undefined) a.poll_error = fields.poll_error;
      if (fields.cancel_sent_at && !a.cancel_sent_at) a.cancel_sent_at = fields.cancel_sent_at;
      jj.progress_at = a.polled_at;
    }, `Check ${provider} in ${run.run_id}`, 'research_poll');
  };
  const key = providers.apiKeyFor(provider);
  if (!key) {
    if (now > deadline) return holdUncollectable(ws, projectId, run, provider, attempt, `The ${label} API key is no longer set, so request ${attempt.response_id} could neither be collected nor stopped before its time limit. It may have run and been billed. It is not resent automatically: reconcile it or retry it yourself.`);
    note({ poll_error: `The ${label} API key is not set, so the answer cannot be collected yet.` });
    return { provider, status: 'running', error: 'API key missing' };
  }
  let out;
  try {
    out = stopping
      ? await providers.cancelBackground(provider, { responseId: attempt.response_id, key, fetchImpl })
      : await providers.pollBackground(provider, { responseId: attempt.response_id, key, fetchImpl });
  } catch (err) {
    if (err.kind === 'http' && err.httpStatus === 404) {
      return holdUncollectable(ws, projectId, run, provider, attempt, `${vendor} no longer has request ${attempt.response_id} (HTTP 404), so its answer cannot be collected. It may have run and been billed. It is not resent automatically: reconcile it or retry it yourself.`);
    }
    if (now > deadline + 30 * 60000) {
      return holdUncollectable(ws, projectId, run, provider, attempt, `The desk could not reach ${vendor} to collect or stop request ${attempt.response_id} for half an hour past its time limit (${err.message}). It may have run and been billed. It is not resent automatically: reconcile it or retry it yourself.`);
    }
    note({ poll_error: String(err.message || err).slice(0, 300) });
    return { provider, status: 'running', error: err.message };
  }
  if (!out.done) {
    note({ provider_status: out.status, poll_error: null, ...(stopping ? { cancel_sent_at: new Date(now).toISOString() } : {}) });
    return { provider, status: 'running', provider_status: out.status };
  }
  const error = out.error || null;
  if (error && error.kind === 'cancelled' && stopping === 'deadline') {
    error.message = `${label} had not finished after ${minutes} minutes, so the desk cancelled the request. The usage so far is recorded; nothing was saved as a report. You can retry.`;
  }
  return finishAttempt(ws, projectId, run, provider, attempt, { result: out.result || null, error, finishedAt: new Date().toISOString(), mode: 'api' });
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
  // Kept, but it does not answer this run (inbox.js quarantine): the job was
  // failed with the reason inside the import; nothing is sent again.
  if (st === 'ingested' && out.result.quarantined) return { provider, status: 'failed', quarantined: true, report_id: out.result.report_id, error: out.result.message };
  if (st === 'duplicate') {
    // The same text is already saved: it completes this job only when it
    // answers this run's frozen contract, as a first import would.
    const cls = require('./reports').classify(saved.text);
    const json = cls.json && cls.json.obj ? cls.json.obj : null;
    const b = require('./binding').checkBinding(ws, { projectId: run.project_id, runId: run.run_id, provider, json, mode: 'record', promptSha256: saved.prompt_sha256, evidenceSha256: saved.evidence_packet_sha256 });
    if (!b.ok) {
      const dupId = out.result.report_id || null;
      updateJob(ws, run.project_id, run.run_id, provider, (jj) => {
        if (jj.state === 'completed' && jj.report_id) return;
        Object.assign(jj, { state: 'failed', outcome: 'contract_conflict', quarantined_report_id: dupId, error: `${PROVIDER_LABELS[provider]}'s answer is already saved as report ${dupId}, and it does not answer this run: ${b.message}` });
        const a = lastAttempt(jj);
        if (a && a.phase === 'responded') Object.assign(a, { phase: 'imported', report_id: dupId, quarantined: true });
      }, `${provider} answer in ${run.run_id} quarantined`);
      return { provider, status: 'failed', quarantined: true, report_id: dupId, error: b.message };
    }
  }
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
  // A restored copy sends and collects nothing until Eric releases it.
  const restored = restoredHold(ws);
  if (restored) {
    return { status: 'held', restored_copy: true, summary: `Restored copy (${restored.restored_at || 'date unknown'}): research is held, so no provider was asked for anything. Release it with node dashboard/cli.js restored-copy release --confirm.`, results: [], created: [], released: [], skipped_schedules: [] };
  }
  // Scheduled refreshes: only when unattended paid research is enabled and
  // every bound and price it needs is set (providerStatus api).
  const created = [];
  const skippedSchedules = [];
  try { sweepCaptures(ws); } catch (_) { /* housekeeping only */ }
  // Assistant claims idle for a day go back to waiting (drafts kept).
  let released = [];
  try { released = releaseStaleAssistantJobs(ws, now); } catch (_) { /* housekeeping only */ }
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
  // A small pool: each worker takes the next due job as soon as it is free,
  // so one long call never holds up the others. Checks on background
  // requests are short.
  const max = Math.max(1, ws.settings.research.max_concurrent || 1);
  // Never sent while held (a model on hold, an archived project); a request
  // already sent is still collected and recovered.
  const held = heldProviders(ws);
  const todo = allOpenJobs(ws).filter(({ job }) => isDueJob(job, now) && !heldUnsent(held, job));
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const t = todo[next++];
      results.push(await runOneJob(ws, t, { fetchImpl, trigger }).catch((err) => ({ provider: t.job.provider, status: 'error', error: err.message })));
    }
  };
  await Promise.all(Array.from({ length: Math.min(max, todo.length) }, worker));
  const done = results.filter((r) => r.status === 'completed').length;
  const failed = results.filter((r) => ['failed', 'error', 'budget_refused', 'refused'].includes(r.status)).length;
  const uncertain = results.filter((r) => r.status === 'uncertain' || r.status === 'unsaved').length;
  const captured = results.filter((r) => r.status === 'captured').length;
  const background = results.filter((r) => r.status === 'submitted' || r.status === 'running').length;
  const quiet = !created.length && results.every((r) => ['running', 'waiting', 'busy', 'skipped'].includes(r.status));
  return {
    status: !todo.length && !created.length ? (released.length ? 'ok' : 'noop') : failed || uncertain || captured ? 'attention' : quiet && !released.length ? 'noop' : 'ok',
    summary: `${todo.length || created.length ? `${done} research job(s) completed, ${failed} failed or refused${background ? `, ${background} running in the background` : ''}${uncertain ? `, ${uncertain} uncertain (may have been billed; reconcile or retry)` : ''}${captured ? `, ${captured} answer(s) captured and waiting to be saved by the next run` : ''}, ${created.length} scheduled run(s) created${skippedSchedules.length ? `, ${skippedSchedules.length} schedule(s) waiting (${skippedSchedules[0].reason})` : ''}` : skippedSchedules.length ? `Research refresh due for ${skippedSchedules.length} project(s), not started: ${skippedSchedules[0].reason}` : 'No research jobs waiting'}${released.length ? `; ${released.length} idle assistant claim(s) released back to waiting (drafts kept)` : ''}`,
    results,
    created,
    released,
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
    const last = run ? lastAttempt(run.jobs[p]) : null;
    byProvider[p] = run ? { run_id: run.run_id, state: run.jobs[p].state, mode: run.jobs[p].mode, error: run.jobs[p].error || null, report_id: run.jobs[p].report_id || null, updated_at: run.jobs[p].updated_at, progress_at: run.jobs[p].progress_at || null, run_created_at: run.created_at, background: Boolean(last && last.phase === 'submitted'), provider_status: last && last.phase === 'submitted' ? last.provider_status || null : null, not_before: run.jobs[p].not_before || null, outcome: run.jobs[p].outcome || (last && last.outcome ? last.outcome : null), quarantined_report_id: run.jobs[p].quarantined_report_id || null, hold: run.jobs[p].hold || null, draft_saved_at: run.jobs[p].draft_saved_at || null, released: run.jobs[p].released || null } : null;
  }
  return { latest_run: latest ? { run_id: latest.run_id, status: latest.status, created_at: latest.created_at, providers: latest.providers, horizon: latest.horizon } : null, providers: byProvider, runs: runs.length };
}

// A spend-log line for a paid call outside a research run (reading a research
// request's screenshot). The daily and monthly totals count it like any other.
function spendLine(ws, entry) {
  appendLine(ws.abs(SPEND_REL), { at: new Date().toISOString(), project_id: null, ...entry });
}

// ---------------------------------------------------------------------------
// Research done by a model's own assistant through the desk connector:
// Claude in Cowork, ChatGPT, Gemini (mcp.js)
//
// The assistant researches with its own tools, under its own plan, and saves
// the report itself; the desk calls no model for it. Its job is "running"
// (mode cowork for Claude, connector for ChatGPT and Gemini) from the moment it
// takes the job until it saves the report. A draft saved as it goes also says
// it is still working. A job with no sign of life for ASSISTANT_IDLE_MINUTES
// is shown as interrupted: Eric can ask that assistant to resume it (the
// prompt and the draft are kept) or restart it (this run is canceled and a new
// one starts). A job no API runs is "unconfigured": its prompt is ready, and
// the model's assistant takes it over when Eric asks it to.

const ASSISTANT_IDLE_MINUTES = 30;
const COWORK_IDLE_MINUTES = ASSISTANT_IDLE_MINUTES;
const MAX_DRAFT_BYTES = 400 * 1024;
// Jobs still open: waiting for an assistant, queued, in flight, or held as uncertain.
const OPEN_STATES = new Set(['unconfigured', 'queued', 'dispatching', 'running', 'uncertain']);

function assistantActivity(job, run, now = Date.now()) {
  if (!isAssistantJob(job)) return null;
  const open = job.state === 'running';
  const last = job.progress_at || job.updated_at || (run && run.created_at) || null;
  const idle = last ? Math.max(0, Math.round((now - Date.parse(last)) / 60000)) : null;
  return { open, last_activity_at: last, idle_minutes: idle, interrupted: open && idle !== null && idle >= ASSISTANT_IDLE_MINUTES, progress_note: job.progress_note || null, draft_saved_at: job.draft_saved_at || null, draft_chars: job.draft_chars || null };
}

// Open jobs a provider's assistant is doing for a project, newest run first.
function openAssistantJobs(ws, projectId, provider = 'claude') {
  return listRuns(ws, projectId)
    .filter((r) => !r.broken && r.jobs && r.jobs[provider] && isAssistantJob(r.jobs[provider]) && r.jobs[provider].state === 'running')
    .map((r) => ({ run: r, job: r.jobs[provider] }));
}

// A provider's jobs waiting for an answer (no API runs them), newest first.
// The provider's assistant can do exactly that job, so it takes the job over
// instead of starting a second run.
function waitingJobs(ws, projectId, provider = 'claude') {
  return listRuns(ws, projectId)
    .filter((r) => !r.broken && r.jobs && r.jobs[provider] && r.jobs[provider].state === 'unconfigured')
    .map((r) => ({ run: r, job: r.jobs[provider] }));
}

// Every job of a provider still open on a project, whoever runs it.
function openJobsFor(ws, projectId, provider) {
  return listRuns(ws, projectId)
    .filter((r) => !r.broken && r.jobs && r.jobs[provider] && OPEN_STATES.has(r.jobs[provider].state))
    .map((r) => ({ run: r, job: r.jobs[provider] }));
}

// The newest run of a project that still has an open job.
function openRunOf(ws, projectId) {
  return listRuns(ws, projectId).find((r) => !r.broken && r.jobs && Object.values(r.jobs).some((j) => OPEN_STATES.has(j.state))) || null;
}

// Stale sessions. A job an assistant took (Claude in Cowork, ChatGPT or Gemini
// through its connection) and then left for a day with no sign of life is
// released back to waiting: the claim ends, its draft and history stay, and
// the same model (or Eric by hand) can take it again and continue from the
// draft. Only assistant jobs: a request sent to a paid API is never touched,
// resent or released by this.
const ASSISTANT_RELEASE_HOURS = 24;

function staleAssistantJobs(ws, now = Date.now()) {
  return allOpenJobs(ws).filter(({ run, job }) => {
    const act = assistantActivity(job, run, now);
    return act && act.open && act.idle_minutes !== null && act.idle_minutes >= ASSISTANT_RELEASE_HOURS * 60;
  });
}

function releaseStaleAssistantJobs(ws, now = Date.now()) {
  const released = [];
  for (const { project_id: projectId, run, job } of staleAssistantJobs(ws, now)) {
    const label = PROVIDER_LABELS[job.provider];
    const out = updateJob(ws, projectId, run.run_id, job.provider, (j, r) => {
      const act = assistantActivity(j, r, now);
      if (!act || !act.open || act.idle_minutes < ASSISTANT_RELEASE_HOURS * 60) return;
      const at = new Date(now).toISOString();
      j.released = [...(j.released || []), { at, from_mode: j.mode, idle_hours: Math.round(act.idle_minutes / 60), last_activity_at: act.last_activity_at, draft_saved_at: j.draft_saved_at || null, client: j.connector_client || null }];
      j.state = 'unconfigured';
      j.mode = 'manual';
      j.fallback = 'manual';
      delete j.connector_client;
      j.note = `Released back to waiting at ${at}: ${label} showed no activity for ${Math.round(act.idle_minutes / 60)} hours and saved no report.${j.draft_saved_at ? ` Its draft from ${j.draft_saved_at} is kept and comes back when ${label} takes the job again.` : ''} Nothing was sent anywhere.`;
    }, `Release stale ${job.provider} claim in ${run.run_id}`);
    if (!out.result || !out.result.noop) released.push({ project_id: projectId, run_id: run.run_id, provider: job.provider });
  }
  return released;
}

function adoptJob(ws, projectId, runId, provider = 'claude', { client = null } = {}) {
  const label = PROVIDER_LABELS[provider];
  const out = updateJob(ws, projectId, runId, provider, (job) => {
    if (job.state !== 'unconfigured') throw new OpError('CONFLICT', `This run's ${label} job is ${job.state}, not waiting for an answer.`);
    const at = new Date().toISOString();
    Object.assign(job, {
      state: 'running',
      mode: assistantMode(provider),
      fallback: null,
      progress_at: at,
      note: provider === 'claude' ? 'Taken over by Claude in Cowork (desk connector); it completes when Cowork saves its report.' : `Taken over by ${label} through its desk connection; it completes when ${label} saves its report.`,
    });
    if (client) job.connector_client = String(client).slice(0, 100);
  }, provider === 'claude' ? `Cowork takes over the Claude job in ${runId}` : `${label} takes over its job in ${runId}`);
  return { status: 'saved', verified: out.verified };
}

// More models for a run that is still open (Eric asked for all three after one
// had started): the run's own prompt and dated context, one new job each. A
// provider the run already has keeps its job.
function addProviders(ws, projectId, runId, providers, { assistant = null, channel = null } = {}) {
  const list = normalizeProviders(providers);
  const status = providerStatus(ws);
  const rel = `${runDir(projectId, runId)}/run.json`;
  const out = runOp(ws, { type: 'research_run_add_providers', summary: `Add ${list.join(', ')} to ${runId}` }, (op) => {
    const run = op.readJson(rel, null);
    if (!run) throw new OpError('NOT_FOUND', `No research run ${runId} in ${projectId}`);
    const added = list.filter((p) => !run.jobs[p]);
    if (!added.length) return { added: [] };
    for (const p of added) {
      run.jobs[p] = newJob(ws, p, status[p], { assistant });
      // A model added now gets its execution note now, frozen with its job.
      const note = require('./execution').freezeNote(op, ws, run, p, runDir(projectId, runId));
      if (note) run.jobs[p].execution = note;
    }
    run.providers = PROVIDERS.filter((p) => run.jobs[p]);
    run.providers_added = [...(run.providers_added || []), { at: new Date().toISOString(), providers: added, by: ws.actor || null, channel }];
    op.writeJson(rel, run);
    return { added };
  });
  return { added: out.result.added, verified: out.verified };
}

// Jobs of a run still waiting for a model's assistant (made while that
// model's API was not set up) go to the API once it is: Eric's new request
// for the run is the go-ahead. A job an assistant has taken stays with it.
// Returns the providers sent.
function sendWaitingToApi(ws, projectId, runId, list = PROVIDERS) {
  const st = providerStatus(ws);
  const run = loadRun(ws, projectId, runId);
  if (!run || !run.jobs) return [];
  const held = heldProviders(ws);
  const sent = [];
  for (const p of normalizeProviders(list)) {
    if (held[p]) continue;
    const job = run.jobs[p];
    if (!job || job.state !== 'unconfigured' || isAssistantJob(job) || !st[p] || (st[p].mode !== 'api' && st[p].mode !== 'mock')) continue;
    const out = updateJob(ws, projectId, runId, p, (jj) => {
      if (jj.state !== 'unconfigured' || isAssistantJob(jj)) return;
      switchToApiRoute(jj, st[p]);
      jj.state = 'queued';
      jj.note = `Sent to the ${PROVIDER_LABELS[p]} API (${st[p].model || st[p].mode}): its key and limits are set now.`;
    }, `Send waiting ${p} job in ${runId} to its API`);
    if (!out.result || !out.result.noop) sent.push(p);
  }
  return sent;
}

// After a model saved its report for one run, its jobs in other runs on the
// same project keep waiting. Each run froze its own contract (prompt and hash,
// rubric, profile, horizon, evidence packet), and its prompt names the run, so
// a report answers only the run it was written for: no report completes
// another run (REVIEW F1, 2026-10-04; before, a matching horizon and owner
// questions were enough). Read-only: the other runs still waiting for this
// model, so the reply can say so.
function otherWaitingRuns(ws, projectId, provider, { runId }) {
  return waitingJobs(ws, projectId, provider).map(({ run }) => run.run_id).filter((id) => id !== runId);
}

// Research waiting for one model across the desk: jobs no API runs (they wait
// for that model's assistant) and jobs its assistant took and has not finished.
function pendingFor(ws, provider) {
  const out = [];
  for (const p of listProjects(ws)) {
    if (p.broken || p.status === 'archived') continue;
    for (const r of listRuns(ws, p.project_id)) {
      if (r.broken || !r.jobs || !r.jobs[provider]) continue;
      const j = r.jobs[provider];
      const open = isAssistantJob(j) && j.state === 'running';
      if (j.state !== 'unconfigured' && !open) continue;
      out.push({ project_id: p.project_id, name: p.name, run_id: r.run_id, created_at: r.created_at, state: open ? 'started' : 'waiting', activity: assistantActivity(j, r), requested_by: r.created_by || null, owner_request: r.utterance || null, owner_instructions: r.owner_instructions || null, models: r.providers });
    }
  }
  return out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

const draftName = (provider) => (provider === 'claude' ? 'cowork-draft.md' : `${provider}-draft.md`);

function draftRel(projectId, runId, provider = 'claude') {
  return `${runDir(projectId, runId)}/${draftName(provider)}`;
}

function readAssistantDraft(ws, projectId, runId, provider = 'claude') {
  try {
    return fs.readFileSync(ws.abs(draftRel(projectId, runId, provider)), 'utf8');
  } catch (_) {
    return null;
  }
}

// Saves (replaces) an assistant's working draft for its open job, in the same
// verified save as the job's "still working" marker.
function saveAssistantDraft(ws, projectId, runId, { text, note = null, provider = 'claude' }) {
  const body = typeof text === 'string' ? text : '';
  const label = PROVIDER_LABELS[provider];
  if (!body.trim()) throw new OpError('INVALID', 'The draft is empty.');
  if (Buffer.byteLength(body) > MAX_DRAFT_BYTES) throw new OpError('INVALID', `The draft is larger than ${MAX_DRAFT_BYTES / 1024} KB.`);
  const rel = `${runDir(projectId, runId)}/run.json`;
  const out = runOp(ws, { type: provider === 'claude' ? 'research_cowork_draft' : 'research_assistant_draft', summary: `${provider === 'claude' ? 'Cowork' : label} draft for ${runId}` }, (op) => {
    const run = op.readJson(rel, null);
    const job = run && run.jobs ? run.jobs[provider] : null;
    if (!job || !isAssistantJob(job)) throw new OpError('NOT_FOUND', provider === 'claude' ? `${runId} has no Claude job assigned to Cowork.` : `${runId} has no ${label} job taken by ${label}.`);
    if (job.state !== 'running') throw new OpError('CONFLICT', `This run's ${label} job is ${job.state}; start or resume research to get an open run.`);
    const at = new Date().toISOString();
    op.write(draftRel(projectId, runId, provider), body);
    Object.assign(job, { progress_at: at, progress_note: note ? String(note).slice(0, 300) : job.progress_note || null, draft_saved_at: at, draft_chars: body.length, updated_at: at });
    op.writeJson(rel, run);
    return { at, chars: body.length };
  });
  return { status: 'saved', ...out.result, files: out.files, verified: out.verified };
}

// The names Claude's connector has always used.
const coworkActivity = assistantActivity;
const openCoworkJobs = (ws, projectId) => openAssistantJobs(ws, projectId, 'claude');
const waitingClaudeJobs = (ws, projectId) => waitingJobs(ws, projectId, 'claude');
const adoptForCowork = (ws, projectId, runId) => adoptJob(ws, projectId, runId, 'claude');
const readCoworkDraft = (ws, projectId, runId) => readAssistantDraft(ws, projectId, runId, 'claude');
const saveCoworkDraft = (ws, projectId, runId, opts) => saveAssistantDraft(ws, projectId, runId, { ...opts, provider: 'claude' });

module.exports = {
  RESTORED_REL,
  restoredHold,
  releaseRestoredCopy,
  RUN_ID_RE,
  createRun,
  spendLine,
  COWORK_IDLE_MINUTES,
  ASSISTANT_IDLE_MINUTES,
  ASSISTANT_RELEASE_HOURS,
  staleAssistantJobs,
  releaseStaleAssistantJobs,
  OPEN_STATES,
  isAssistantJob,
  assistantActivity,
  openAssistantJobs,
  waitingJobs,
  openJobsFor,
  openRunOf,
  adoptJob,
  addProviders,
  sendWaitingToApi,
  hasBackgroundWork,
  otherWaitingRuns,
  pendingFor,
  readAssistantDraft,
  saveAssistantDraft,
  coworkActivity,
  openCoworkJobs,
  waitingClaudeJobs,
  adoptForCowork,
  readCoworkDraft,
  saveCoworkDraft,
  listRuns,
  loadRun,
  runStatus,
  providerStatus,
  heldProviders,
  readiness,
  preflight,
  setupNeeds,
  callBounds,
  callPlan,
  estimateCostUsd,
  actualCostUsd,
  costFromUsage,
  attemptCharge,
  budgetCheck,
  spendSoFar,
  evidencePacket,
  cancelJob,
  retryJob,
  holdUnsentJobs,
  heldJobsOf,
  reconcileAttempt,
  stageReportLink,
  stageQuarantine,
  autoLinkReport,
  hasDueWork,
  dueSchedules,
  runDueJobs,
  sweepCaptures,
  commitCaptured,
  partialOutput,
  researchStateFor,
  normalizeProviders,
};
