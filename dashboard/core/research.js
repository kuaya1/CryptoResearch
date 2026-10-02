'use strict';
// Research runs: one request to research a project with one or more providers.
//
// projects/<id>/research/<run_id>/
//   run.json             the run and one job per provider (states below)
//   prompt.md            the canonical prompt, identical for every provider (SHA-256 recorded)
//   evidence-packet.json dated public context given to every provider (no holdings, no notes)
//   responses/<provider>-attempt<n>.json   raw API response + metadata, saved BEFORE normalization
//
// Job states: queued (waiting for the runner), running, completed (a report is
// linked), failed, canceled, unconfigured (no paid API path set up; the prompt
// is ready to paste and the job completes when that answer is imported).
// Run status: queued, running, waiting (manual answers outstanding),
// completed, partially_completed, failed, canceled.
//
// Paid calls happen only when a provider has a key, a model, prices and a
// budget, and only for jobs you asked for (or a schedule you enabled). Each
// call is estimated against the per-run, daily and monthly caps first; if the
// cost cannot be bounded the call is refused. Price refreshes never start
// research. One provider failing never touches another provider's report.

const fs = require('fs');
const crypto = require('crypto');
const { runOp, OpError } = require('./ops');
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
const DEDUPE_MINUTES = 10;

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
  if (s.includes('running')) return 'running';
  if (s.includes('queued')) return 'queued';
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
// Provider configuration and budget

function providerConfig(ws, provider) {
  return (ws.settings.research.providers || {})[provider] || {};
}

// How each provider can run right now: api (paid, configured), mock (fictional
// demo/test fixtures only), or manual (prompt ready to paste), with the reason.
function providerStatus(ws) {
  const out = {};
  const budget = ws.settings.research.budget || {};
  const budgetSet = [budget.per_run_usd, budget.daily_usd, budget.monthly_usd].every((v) => typeof v === 'number' && v >= 0);
  for (const p of PROVIDERS) {
    const cfg = providerConfig(ws, p);
    if (cfg.mock && ws.kind !== 'real') {
      out[p] = { mode: 'mock', reason: `fictional fixture responses (${cfg.mock})`, model: 'fictional-fixture' };
      continue;
    }
    const key = providers.keyStatus(p);
    const missing = [];
    if (!key.present) missing.push('API key');
    if (!cfg.model) missing.push('model ID');
    if (![cfg.input_usd_per_mtok, cfg.output_usd_per_mtok].every((v) => typeof v === 'number' && v >= 0)) missing.push('token prices');
    if (!budgetSet) missing.push('spending budget');
    out[p] = missing.length
      ? { mode: 'manual', reason: `not configured: ${missing.join(', ')}`, missing, key: { present: key.present, how: key.how || null } }
      : { mode: 'api', reason: null, model: cfg.model, key: { present: true, source: key.source } };
  }
  return out;
}

function estimateCostUsd(ws, provider, promptText) {
  const cfg = providerConfig(ws, provider);
  const maxOut = ws.settings.research.max_output_tokens || 16000;
  const searches = typeof cfg.max_searches === 'number' ? cfg.max_searches : 20;
  const perSearchTokens = typeof cfg.search_result_tokens_estimate === 'number' ? cfg.search_result_tokens_estimate : 4000;
  if (![cfg.input_usd_per_mtok, cfg.output_usd_per_mtok].every((v) => typeof v === 'number')) return null;
  const inputTokens = Math.ceil(promptText.length / 3.5) + searches * perSearchTokens;
  const searchFee = typeof cfg.search_usd_per_call === 'number' ? cfg.search_usd_per_call * searches : 0;
  return Math.round(((inputTokens / 1e6) * cfg.input_usd_per_mtok + (maxOut / 1e6) * cfg.output_usd_per_mtok + searchFee) * 10000) / 10000;
}

function actualCostUsd(ws, provider, usage) {
  const cfg = providerConfig(ws, provider);
  if (!usage || usage.input_tokens === null || usage.output_tokens === null) return null;
  if (![cfg.input_usd_per_mtok, cfg.output_usd_per_mtok].every((v) => typeof v === 'number')) return null;
  const search = typeof cfg.search_usd_per_call === 'number' && typeof usage.search_calls === 'number' ? cfg.search_usd_per_call * usage.search_calls : 0;
  return Math.round(((usage.input_tokens / 1e6) * cfg.input_usd_per_mtok + (usage.output_tokens / 1e6) * cfg.output_usd_per_mtok + search) * 10000) / 10000;
}

// Spend per call: the actual cost when the provider reported usage, otherwise
// the estimate made before the call (so an unanswered call still counts).
function spendSoFar(ws, now = new Date()) {
  const day = ymdInTz(now);
  const month = day.slice(0, 7);
  const calls = new Map();
  for (const e of readJsonLines(ws.abs(SPEND_REL))) {
    const k = `${e.run_id}|${e.provider}|${e.attempt}`;
    const cur = calls.get(k) || { at: e.at, estimate: null, actual: null };
    if (typeof e.estimate_usd === 'number') cur.estimate = e.estimate_usd;
    if (typeof e.actual_usd === 'number') cur.actual = e.actual_usd;
    calls.set(k, cur);
  }
  let daily = 0;
  let monthly = 0;
  for (const c of calls.values()) {
    const amount = c.actual !== null ? c.actual : c.estimate || 0;
    const d = ymdInTz(new Date(c.at));
    if (d === day) daily += amount;
    if (d.slice(0, 7) === month) monthly += amount;
  }
  return { daily: Math.round(daily * 10000) / 10000, monthly: Math.round(monthly * 10000) / 10000, day, month, calls: calls.size };
}

function budgetCheck(ws, estimate) {
  const b = ws.settings.research.budget || {};
  if (estimate === null) return { ok: false, reason: 'The cost of this call cannot be bounded (token prices are not set), so it is not made.' };
  const spent = spendSoFar(ws);
  if (typeof b.per_run_usd !== 'number' || estimate > b.per_run_usd) return { ok: false, reason: `Estimated maximum $${estimate.toFixed(2)} is above the per-run limit${typeof b.per_run_usd === 'number' ? ` of $${b.per_run_usd}` : ' (not set)'}.` };
  if (typeof b.daily_usd !== 'number' || spent.daily + estimate > b.daily_usd) return { ok: false, reason: `Today's research spend ($${spent.daily.toFixed(2)}) plus this call would pass the daily limit${typeof b.daily_usd === 'number' ? ` of $${b.daily_usd}` : ' (not set)'}.` };
  if (typeof b.monthly_usd !== 'number' || spent.monthly + estimate > b.monthly_usd) return { ok: false, reason: `This month's research spend ($${spent.monthly.toFixed(2)}) plus this call would pass the monthly limit${typeof b.monthly_usd === 'number' ? ` of $${b.monthly_usd}` : ' (not set)'}.` };
  return { ok: true, estimate, spent };
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
      vs_btc: require('./cycle').assetVsBtc(latest, obs),
    } : { note: id ? 'No market observation stored yet.' : 'No verified token binding, so no market data.' },
    market_context: require('./cycle').packetContext(ws),
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
  // The position-cycle recipe: an exact calendar interval inside the planning
  // ceiling, or a long-term exception with the owner's reason (position.js).
  const horizon = require('./position').resolveRunHorizon(ws, { args, previous, project });
  const horizonText = horizon.text;
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
  const prompt = buildRunPrompt(ws, project, { runId, horizon, rubricRef, packet });
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
    horizon,
    prompt: { version: require('./prompts').promptVersionFor(horizon), path: `${dir}/prompt.md`, sha256: sha256(prompt), identical_for_all_providers: true },
    evidence_packet: { path: `${dir}/evidence-packet.json`, sha256: sha256(packetText), captured_at: packet.captured_at, market_snapshot_id: packet.market_context.snapshot_id || null },
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

function updateJob(ws, projectId, runId, provider, mutate, summary) {
  const rel = `${runDir(projectId, runId)}/run.json`;
  return runOp(ws, { type: 'research_job_update', summary: summary || `Update ${provider} job in ${runId}` }, (op) => {
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

function cancelJob(ws, projectId, runId, provider, reason = null) {
  const out = updateJob(ws, projectId, runId, provider, (job) => {
    if (TERMINAL.has(job.state)) return { message: `${PROVIDER_LABELS[provider]} job is already ${job.state}.` };
    if (job.state === 'running' && job.mode !== 'cowork') {
      job.cancel_requested = true;
      job.cancel_reason = reason;
      return { message: 'Cancel requested. A request that was already sent to the provider may still be billed; its answer will be discarded.' };
    }
    job.state = 'canceled';
    job.cancel_reason = reason;
    return { message: `${PROVIDER_LABELS[provider]} job canceled.` };
  }, `Cancel ${provider} in ${runId}`);
  return { status: out.result.noop ? 'unchanged' : 'saved', noop: Boolean(out.result.noop), message: out.result.message, files: out.files, verified: out.verified };
}

function retryJob(ws, projectId, runId, provider) {
  const st = providerStatus(ws)[provider];
  const out = updateJob(ws, projectId, runId, provider, (job) => {
    if (job.state === 'completed') return { message: 'Already completed; start a new run to research again.' };
    if (job.state === 'running') return { message: 'Still running.' };
    if (st.mode === 'manual') {
      job.state = 'unconfigured';
      return { message: `${PROVIDER_LABELS[provider]} API is ${st.reason}; the prompt is ready to paste.` };
    }
    job.state = 'queued';
    job.max_attempts = Math.max(job.max_attempts || 2, (job.attempts || []).length + 1);
    job.error = null;
    job.cancel_requested = false;
    return { message: `${PROVIDER_LABELS[provider]} job queued again.` };
  }, `Retry ${provider} in ${runId}`);
  return { status: out.result.noop ? 'unchanged' : 'saved', noop: Boolean(out.result.noop), message: out.result.message, files: out.files, verified: out.verified };
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

function hasDueWork(ws) {
  return allOpenJobs(ws).some(({ job }) => job.state === 'queued' || (job.state === 'running' && job.mode !== 'cowork')) || dueSchedules(ws).length > 0;
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

function saveResponse(ws, run, provider, n, payload) {
  const rel = `${runDir(run.project_id, run.run_id)}/responses/${provider}-attempt${n}.json`;
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  const out = runOp(ws, { type: 'research_response', summary: `Save ${provider} response ${run.run_id} #${n}` }, (op) => {
    if (!exists(ws.abs(rel))) op.write(rel, text, { mode: 'create' });
  });
  return { rel, sha256: sha256(text), verified: out.verified };
}

async function runOneJob(ws, { project_id: projectId, run, job }, { fetchImpl, trigger }) {
  const provider = job.provider;
  const timeoutMs = (ws.settings.research.timeout_seconds || 600) * 1000;
  const lease = acquireLease(ws, `research-${run.run_id}-${provider}`, timeoutMs + 60000, { label: trigger });
  if (!lease) return { provider, status: 'busy' };
  try {
    const fresh = loadRun(ws, projectId, run.run_id);
    const j = fresh && fresh.jobs[provider];
    if (!j) return { provider, status: 'missing' };
    // A job left "running" by a runner that died: the call may have been billed.
    if (j.state === 'running' && j.mode !== 'cowork') {
      const last = j.attempts[j.attempts.length - 1];
      const saved = last && last.response_path && exists(ws.abs(last.response_path));
      if (saved) return await importSaved(ws, fresh, provider, last);
      updateJob(ws, projectId, run.run_id, provider, (jj) => {
        if (last && !last.finished_at) Object.assign(last, { finished_at: new Date().toISOString(), outcome: 'interrupted', error: 'The runner stopped during this call; it may have been billed.' });
        const left = jj.attempts.length < jj.max_attempts;
        jj.state = jj.cancel_requested ? 'canceled' : left ? 'queued' : 'failed';
        jj.error = left ? null : 'Stopped during the last allowed attempt.';
        if (last) jj.attempts[jj.attempts.length - 1] = last;
      }, `Recover ${provider} job in ${run.run_id}`);
      return { provider, status: 'recovered' };
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
    let estimate = null;
    if (status.mode === 'api') {
      estimate = estimateCostUsd(ws, provider, prompt);
      const b = budgetCheck(ws, estimate);
      if (!b.ok) {
        updateJob(ws, projectId, run.run_id, provider, (jj) => { jj.state = 'failed'; jj.error = `Not sent: ${b.reason}`; jj.budget_refused = true; });
        return { provider, status: 'budget_refused', reason: b.reason };
      }
    }
    const n = j.attempts.length + 1;
    const startedAt = new Date().toISOString();
    updateJob(ws, projectId, run.run_id, provider, (jj) => {
      jj.state = 'running';
      jj.attempts.push({ n, started_at: startedAt, finished_at: null, outcome: null, model: status.model || null, cost_estimate_usd: estimate });
    }, `Start ${provider} attempt ${n} in ${run.run_id}`);
    if (status.mode === 'api') appendLine(ws.abs(SPEND_REL), { at: startedAt, run_id: run.run_id, project_id: projectId, provider, attempt: n, model: status.model, estimate_usd: estimate, actual_usd: null, note: 'estimate recorded before the call' });
    let result;
    let error = null;
    try {
      if (status.mode === 'mock') {
        result = await mockCall(ws, provider, fresh);
      } else {
        result = await providers.callProvider(provider, {
          model: status.model,
          prompt,
          maxOutputTokens: ws.settings.research.max_output_tokens || 16000,
          maxSearches: providerConfig(ws, provider).max_searches || 20,
          key: providers.apiKeyFor(provider),
          signal: AbortSignal.timeout(timeoutMs),
          fetchImpl,
        });
      }
    } catch (err) {
      error = err;
    }
    const finishedAt = new Date().toISOString();
    const actual = result && status.mode === 'api' ? actualCostUsd(ws, provider, result.usage) : null;
    if (status.mode === 'api' && actual !== null) appendLine(ws.abs(SPEND_REL), { at: finishedAt, run_id: run.run_id, project_id: projectId, provider, attempt: n, model: status.model, estimate_usd: null, actual_usd: actual, replaces_estimate: true, usage: result.usage });
    // Save the actual response (or error) before any normalization.
    const saved = saveResponse(ws, fresh, provider, n, {
      schema_version: 'cr.research-response.v1',
      run_id: run.run_id,
      provider,
      attempt: n,
      started_at: startedAt,
      finished_at: finishedAt,
      mode: status.mode,
      prompt_sha256: fresh.prompt.sha256,
      evidence_packet_sha256: fresh.evidence_packet.sha256,
      attested: result ? result.attested : error && error.attested ? error.attested : null,
      usage: result ? result.usage : null,
      cost_estimate_usd: estimate,
      cost_actual_usd: actual,
      error: error ? { kind: error.kind || 'error', message: error.message, http_status: error.httpStatus || null, request_id: error.requestId || null } : null,
      text: result ? result.text : null,
      raw_response: result ? result.raw : error && error.raw ? error.raw : null,
    });
    if (error) {
      const retryable = ['timeout', 'network'].includes(error.kind) || error.retryable;
      updateJob(ws, projectId, run.run_id, provider, (jj) => {
        const a = jj.attempts[jj.attempts.length - 1];
        Object.assign(a, { finished_at: finishedAt, outcome: error.kind || 'error', error: error.message, http_status: error.httpStatus || null, request_id: error.requestId || null, response_path: saved.rel, response_sha256: saved.sha256 });
        const left = jj.attempts.length < jj.max_attempts;
        jj.state = jj.cancel_requested ? 'canceled' : retryable && left ? 'queued' : 'failed';
        jj.error = error.message;
      }, `${provider} attempt ${n} failed in ${run.run_id}`);
      return { provider, status: 'failed', error: error.message, retry_queued: retryable };
    }
    updateJob(ws, projectId, run.run_id, provider, (jj) => {
      const a = jj.attempts[jj.attempts.length - 1];
      Object.assign(a, { finished_at: finishedAt, outcome: 'response_saved', request_id: result.attested.request_id || null, response_id: result.attested.response_id || null, model_attested: result.attested.model || null, usage: result.usage, cost_actual_usd: actual, response_path: saved.rel, response_sha256: saved.sha256 });
    }, `${provider} answered in ${run.run_id}`);
    const after = loadRun(ws, projectId, run.run_id);
    return await importSaved(ws, after, provider, after.jobs[provider].attempts[after.jobs[provider].attempts.length - 1]);
  } finally {
    releaseLease(ws, `research-${run.run_id}-${provider}`, lease);
  }
}

// Imports a saved response through the normal import path. Safe to repeat: the
// import is deduplicated by content hash and the job only completes once.
async function importSaved(ws, run, provider, attempt) {
  const saved = readJson(ws.abs(attempt.response_path), null);
  if (!saved || !saved.text) return { provider, status: 'failed', error: 'Saved response has no text.' };
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
      });
    }
    return { provider, status: 'completed', report_id: out.result.report_id };
  }
  updateJob(ws, run.project_id, run.run_id, provider, (jj) => {
    jj.state = 'failed';
    jj.error = `The answer was saved but not imported: ${out.result.message}`;
    const a = jj.attempts[jj.attempts.length - 1];
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
  // Scheduled refreshes: only when unattended paid research is enabled and budgeted.
  const created = [];
  const skippedSchedules = [];
  for (const due of dueSchedules(ws, now)) {
    const st = providerStatus(ws);
    const usable = normalizeProviders(due.schedule.providers || ws.settings.research.default_providers).filter((p) => st[p].mode === 'api' || st[p].mode === 'mock');
    if (!ws.settings.research.unattended_enabled || !usable.length) {
      skippedSchedules.push({ project_id: due.project_id, reason: !ws.settings.research.unattended_enabled ? 'unattended research is disabled' : 'no provider has a configured paid API' });
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
  const todo = allOpenJobs(ws).filter(({ job }) => job.state === 'queued' || (job.state === 'running' && job.mode !== 'cowork'));
  const results = [];
  for (let i = 0; i < todo.length; i += max) {
    const batch = todo.slice(i, i + max);
    results.push(...await Promise.all(batch.map((t) => runOneJob(ws, t, { fetchImpl, trigger }).catch((err) => ({ provider: t.job.provider, status: 'error', error: err.message })))));
  }
  const done = results.filter((r) => r.status === 'completed').length;
  const failed = results.filter((r) => ['failed', 'error', 'budget_refused'].includes(r.status)).length;
  return {
    status: !todo.length && !created.length ? 'noop' : failed ? 'attention' : 'ok',
    summary: todo.length || created.length ? `${done} research job(s) completed, ${failed} failed or refused, ${created.length} scheduled run(s) created${skippedSchedules.length ? `, ${skippedSchedules.length} schedule(s) waiting (${skippedSchedules[0].reason})` : ''}` : skippedSchedules.length ? `Research refresh due for ${skippedSchedules.length} project(s), not started: ${skippedSchedules[0].reason}` : 'No research jobs waiting',
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
  estimateCostUsd,
  budgetCheck,
  spendSoFar,
  evidencePacket,
  cancelJob,
  retryJob,
  stageReportLink,
  autoLinkReport,
  hasDueWork,
  dueSchedules,
  runDueJobs,
  researchStateFor,
  normalizeProviders,
};
