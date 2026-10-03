'use strict';
// Background jobs, each with its own timestamps in logs/jobs-state.json:
//   requests  apply queued requests                     every run
//   inbox     import new reports from inbox folders      every run
//   market    prices and supply metrics                  every 5 min while the dashboard is open, about hourly otherwise
//   research  run queued research jobs (explicit requests or configured schedules only)
//   snapshot  daily portfolio snapshot                   once per day (America/New_York)
//   reviews   daily review findings                      once per day
//   backup    sealed local backup                        once per day
//
// Every runner (dashboard, CLI, scheduled task) uses the same due rules, the
// same backoff and a cross-process lease per job, so concurrent runners do one
// run, not two (audit F17). Research never runs because prices changed.

const { readJson, jsonText, appendLine, fileInfo } = require('./fsx');
const { withLock, replaceFile } = require('./ops');
const { acquireLease, releaseLease } = require('./leases');
const { ymdInTz } = require('./dates');

const JOB_STATE_REL = 'logs/jobs-state.json';
const JOB_LOG_REL = 'logs/jobs.jsonl';
const FINDINGS_REL = 'logs/review-findings.json';
const JOB_NAMES = ['requests', 'inbox', 'market', 'research', 'snapshot', 'reviews', 'backup'];
const DAILY = new Set(['snapshot', 'reviews', 'backup']);
const OK_STATUSES = new Set(['ok', 'noop', 'attention', 'skipped', 'partial', 'busy', 'backoff', 'budget_paused', 'not_due']);

function readJobState(ws) {
  return readJson(ws.abs(JOB_STATE_REL), { schema_version: 'cr.jobs-state.v1', jobs: {}, runner: {} });
}

function marketDue(ws, now, { foreground = false } = {}) {
  const market = require('./market');
  const status = market.readStatus(ws);
  if (!market.nextAllowed(ws, status).allowed) return false;
  const lastOk = status.last_success_at ? Date.parse(status.last_success_at) : 0;
  const md = ws.settings.market_data;
  const minutes = foreground ? md.foreground_interval_minutes || 5 : md.background_interval_minutes || 60;
  const slack = foreground ? 15000 : 5 * 60000;
  return now - lastOk >= minutes * 60000 - slack;
}

function isDue(ws, name, state, now = Date.now(), opts = {}) {
  const s = state.jobs[name] || {};
  const today = ymdInTz(new Date(now));
  switch (name) {
    case 'requests':
    case 'inbox':
      return true;
    case 'market':
      return marketDue(ws, now, opts);
    case 'research':
      try {
        return require('./research').hasDueWork(ws, now);
      } catch (_) {
        return false;
      }
    case 'snapshot':
    case 'reviews':
    case 'backup':
      return s.last_success_day !== today;
    default:
      return false;
  }
}

function record(ws, name, trigger, started, finished, result) {
  const quiet = ['noop', 'busy', 'not_due', 'backoff'].includes(result.status) && trigger !== 'scheduler';
  if (!quiet) {
    const logAbs = ws.abs(JOB_LOG_REL);
    const info = fileInfo(logAbs);
    if (info && info.size > 2 * 1024 * 1024) {
      try { require('fs').renameSync(logAbs, ws.abs(`logs/jobs-${started.slice(0, 10)}-${Date.now()}.jsonl`)); } catch (_) { /* keep appending */ }
    }
    appendLine(logAbs, { job: name, trigger, started_at: started, finished_at: finished, status: result.status, summary: result.summary, error: result.error || null, host: require('os').hostname() });
  }
  if (['busy', 'not_due'].includes(result.status)) return;
  withLock(ws, 'job_state', () => {
    const state = readJobState(ws);
    const prev = state.jobs[name] || {};
    const ok = OK_STATUSES.has(result.status);
    state.jobs[name] = {
      ...prev,
      last_run_at: finished,
      last_trigger: trigger,
      last_status: result.status,
      last_summary: result.summary,
      ...(ok ? { last_success_at: finished, last_success_day: ymdInTz(new Date(finished)) } : { last_failure_at: finished, last_error: result.error || result.summary }),
    };
    if (trigger === 'scheduler') state.runner = { ...(state.runner || {}), last_scheduler_run_at: finished, last_scheduler_host: require('os').hostname(), last_scheduler_node: process.version };
    if (trigger === 'dashboard') state.runner = { ...(state.runner || {}), last_dashboard_run_at: finished };
    replaceFile(ws, ws.abs(JOB_STATE_REL), jsonText(state));
  });
}

async function runJobBody(ws, name, trigger) {
  switch (name) {
    case 'requests': {
      const r = require('./requests').processRequests(ws);
      const bad = r.results.filter((x) => ['rejected', 'failed', 'conflict'].includes(x.status)).length;
      return { status: !r.processed && !r.pending ? 'noop' : bad ? 'attention' : 'ok', summary: r.processed || r.pending ? `${r.processed} request(s) answered (${bad} not applied), ${r.pending} still pending` : 'No queued requests' };
    }
    case 'inbox': {
      const r = require('./inbox').scanInbox(ws);
      const c = r.counts;
      const failed = (c.failed || 0) + (c.needs_project || 0) + (c.prompt || 0) + (c.provider_mismatch || 0) + (c.error || 0);
      const imported = c.ingested || 0;
      return {
        status: failed ? 'attention' : imported || c.duplicate ? 'ok' : 'noop',
        summary: r.results.length ? `${imported} imported, ${c.duplicate || 0} duplicate, ${failed} need attention, ${c.skipped || 0} unchanged, ${c.waiting || 0} still being written` : 'Inbox empty',
      };
    }
    case 'market': {
      const r = await require('./market').refresh(ws, { trigger });
      // Market-cycle context rides along at its own, slower interval (cycle.js).
      // Its failure never changes the price result.
      let ctx = null;
      try {
        ctx = await require('./cycle').refreshContext(ws, { trigger, foreground: trigger === 'dashboard' });
      } catch (err) {
        ctx = { status: 'failed', message: `Market context: ${err.message}` };
      }
      const extra = ctx && !['not_due', 'skipped'].includes(ctx.status) ? ` ${ctx.message}` : '';
      return { status: r.status, summary: `${r.message}${extra}`, error: r.status === 'failed' ? r.message : null };
    }
    case 'research': {
      const r = await require('./research').runDueJobs(ws, { trigger });
      return { status: r.status, summary: r.summary, error: r.status === 'failed' ? r.summary : null };
    }
    case 'snapshot': {
      const r = require('./portfolio').snapshotIfDue(ws, require('./market').readLatest(ws));
      return { status: r.status, summary: r.message };
    }
    case 'reviews': {
      const r = buildReviewFindings(ws);
      return { status: 'ok', summary: `${r.findings.length} finding(s) for ${r.date}` };
    }
    case 'backup': {
      const r = require('./exporter').createBackup(ws, { reason: 'daily' });
      return { status: 'ok', summary: `Backup ${r.name} (${r.files} files, sealed)` };
    }
    default:
      throw new Error(`Unknown job ${name}`);
  }
}

async function runJob(ws, name, { trigger = 'cli', onlyDue = false, foreground = false } = {}) {
  const started = new Date().toISOString();
  let result;
  // Daily jobs and research take a cross-process lease; market has its own
  // lease inside refresh(). requests/inbox are serialized by the workspace lock.
  const leased = DAILY.has(name) || name === 'research';
  // A research pass can wait on a blocking provider call for the whole
  // research timeout, so its lease lasts at least that long.
  const ttl = name === 'research' ? Math.max(20 * 60000, ((ws.settings.research && ws.settings.research.timeout_seconds) || 600) * 1000 + 5 * 60000) : 20 * 60000;
  const token = leased ? acquireLease(ws, `job-${name}`, ttl, { label: trigger }) : null;
  if (leased && !token) {
    result = { status: 'busy', summary: 'Another runner is doing this job right now.' };
    record(ws, name, trigger, started, new Date().toISOString(), result);
    return { job: name, ...result };
  }
  try {
    if (onlyDue && !isDue(ws, name, readJobState(ws), Date.now(), { foreground })) {
      result = { status: 'not_due', summary: 'Not due yet' };
    } else {
      result = await runJobBody(ws, name, trigger);
    }
  } catch (err) {
    result = { status: 'failed', summary: err.message, error: err.message };
  } finally {
    if (token) releaseLease(ws, `job-${name}`, token);
  }
  record(ws, name, trigger, started, new Date().toISOString(), result);
  return { job: name, ...result };
}

async function runJobs(ws, names, { trigger = 'cli', onlyDue = false } = {}) {
  const list = names && names.length ? names : JOB_NAMES;
  const results = [];
  for (const name of list) results.push(await runJob(ws, name, { trigger, onlyDue }));
  return results;
}

function buildReviewFindings(ws) {
  const { buildIndex } = require('./indexer');
  const index = buildIndex(ws, { light: true });
  const findings = index.attention.filter((a) => a.severity !== 'low');
  const doc = {
    schema_version: 'cr.review-findings.v1',
    generated_at: new Date().toISOString(),
    date: ymdInTz(),
    timezone: 'America/New_York',
    note: 'Daily review findings. External notifications are not configured.',
    findings,
  };
  withLock(ws, 'findings', () => replaceFile(ws, ws.abs(FINDINGS_REL), jsonText(doc)));
  return doc;
}

module.exports = { JOB_NAMES, JOB_STATE_REL, JOB_LOG_REL, FINDINGS_REL, readJobState, runJob, runJobs, isDue, marketDue, buildReviewFindings };
