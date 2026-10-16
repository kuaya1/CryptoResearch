'use strict';
// The forensic monitor (job "forensics" in jobs.js): cheap, dated
// observations for projects whose monitoring Eric turned on, never a model
// call and never research.
//
//   product checks   one guarded HTTPS GET per approved check (netguard.js),
//                    every product_interval_hours: pass (the expected status
//                    and text), fail (no answer, an error status, the text
//                    missing) or not checkable (the guard refused the
//                    address: that says nothing about the product)
//   repositories     GitHub's public API for each approved repository, every
//                    repo_interval_hours: the repository (archived or not),
//                    the latest commit on the default branch and the latest
//                    published release. Three requests per repository.
//   resolutions      the checkpoint outcomes that came due (forensics.js
//                    recordDueResolutions), once a day
//
// Every runner shares one lease, the GitHub rate-limit gate (a 403 or 429 with
// its reset time is honored), the failure backoff and the monthly request
// budget; each request is counted on disk before it is sent. A restored copy
// sends nothing until Eric releases it. The optional GitHub token
// (CR_GITHUB_TOKEN, in the environment only) is never stored or logged.
//
// Files: market-data/forensics/status.json (gate, backoff, counts; holds no
// address or key). The observations themselves are records of the project
// (projects/<id>/forensics/observations/), appended through forensics.js.

const crypto = require('crypto');
const { readJson, jsonText, sha256 } = require('./fsx');
const { withLock, replaceFile } = require('./ops');
const { acquireLease, releaseLease } = require('./leases');
const { ymdInTz } = require('./dates');

const STATUS_REL = 'market-data/forensics/status.json';
const LEASE = 'forensics';
const GITHUB = 'https://api.github.com';
const HOUR = 3600000;
const isoOf = (ms) => new Date(ms).toISOString();

const cfgOf = (ws) => require('./forensics').monitorCfg(ws);

function readStatus(ws) {
  try {
    return readJson(ws.abs(STATUS_REL), { state: 'never_run' });
  } catch (_) {
    return { state: 'never_run', unreadable: true };
  }
}

function updateStatus(ws, fn) {
  withLock(ws, 'forensics_status', () => {
    const cur = readStatus(ws);
    replaceFile(ws, ws.abs(STATUS_REL), jsonText({ ...fn(cur), schema_version: 'cr.forensic-monitor-status.v1' }));
  });
}

function callCounts(status, now) {
  const today = ymdInTz(new Date(now));
  const month = today.slice(0, 7);
  const c = status.calls && status.calls.month === month ? { ...status.calls } : { month, month_count: 0, day: today, day_count: 0 };
  if (c.day !== today) {
    c.day = today;
    c.day_count = 0;
  }
  return c;
}

// Counts one request before it is sent; false when the month's budget is used.
function reserveRequest(ws, cfg, now) {
  return withLock(ws, 'forensics_status', () => {
    const cur = readStatus(ws);
    const c = callCounts(cur, now);
    if (cfg.monthly_request_budget && c.month_count >= cfg.monthly_request_budget) return false;
    replaceFile(ws, ws.abs(STATUS_REL), jsonText({ ...cur, calls: { ...c, month_count: c.month_count + 1, day_count: c.day_count + 1 }, schema_version: 'cr.forensic-monitor-status.v1' }));
    return true;
  });
}

function heldCopy(ws) {
  try {
    return require('./research').restoredHold(ws);
  } catch (_) {
    return null;
  }
}

function monitoredProjects(ws) {
  const F = require('./forensics');
  return require('./projects').listProjects(ws).filter((p) => {
    if (p.broken || p.status === 'archived') return false;
    const prof = F.readProfile(ws, p.project_id);
    return prof.monitoring && prof.monitoring.enabled && ((prof.targets.product_checks || []).length || (prof.targets.repositories || []).length);
  });
}

function lastObservedAt(obs, targetId) {
  for (let i = obs.length - 1; i >= 0; i--) if (obs[i].target_id === targetId) return Date.parse(obs[i].observed_at);
  return 0;
}

// The targets due now: { project, target, kind }.
function dueTargets(ws, now, cfg = cfgOf(ws)) {
  const F = require('./forensics');
  const out = [];
  for (const p of monitoredProjects(ws)) {
    const prof = F.readProfile(ws, p.project_id);
    const obs = F.readObservations(ws, p.project_id, { from: now - 7 * 24 * HOUR, to: now });
    for (const t of prof.targets.product_checks || []) if (now - lastObservedAt(obs, t.target_id) >= cfg.product_interval_hours * HOUR - 5 * 60000) out.push({ project: p, target: t, kind: 'product_check' });
    for (const t of prof.targets.repositories || []) if (now - lastObservedAt(obs, t.target_id) >= cfg.repo_interval_hours * HOUR - 5 * 60000) out.push({ project: p, target: t, kind: 'repository' });
  }
  return out;
}

function gate(status, now) {
  const until = status.github_retry_after_until ? Date.parse(status.github_retry_after_until) : 0;
  return until > now ? status.github_retry_after_until : null;
}

function isDue(ws, now = Date.now()) {
  const cfg = cfgOf(ws);
  if (!cfg.enabled || heldCopy(ws)) return false;
  const st = readStatus(ws);
  if (st.next_allowed_at && Date.parse(st.next_allowed_at) > now) return false;
  if (st.last_resolutions_day !== ymdInTz(new Date(now)) && hasReceipts(ws)) return true;
  return dueTargets(ws, now, cfg).length > 0;
}

function hasReceipts(ws) {
  const F = require('./forensics');
  return require('./projects').listProjects(ws).some((p) => !p.broken && F.listReceipts(ws, p.project_id).length > 0);
}

// ---------------------------------------------------------------------------
// One product check

const clean = (s, max = 240) => String(s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function excerptAround(text, needle, max = 240) {
  if (!needle) return null;
  const i = text.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return null;
  const start = Math.max(0, i - 80);
  return clean(text.slice(start, start + max), max);
}

async function productCheck(ws, target, { cfg, lookupImpl, transport, now }) {
  const netguard = require('./netguard');
  const r = await netguard.safeGet(target.url, { timeoutMs: cfg.timeout_seconds * 1000, maxBytes: cfg.max_bytes, lookupImpl, transport });
  const base = { kind: 'product_check', target_id: target.target_id, label: target.label || null, url: target.url, observed_at: isoOf(now()), expect: { status: target.expect_status || null, text: target.expect_text || null }, elapsed_ms: r.elapsed_ms ?? null, redirects: (r.redirects || []).length };
  if (r.error_class) {
    const notCheckable = ['refused_target', 'refused_address', 'refused_redirect'].includes(r.error_class);
    return { ...base, outcome: notCheckable ? 'not_checkable' : 'fail', error_class: r.error_class, error: clean(r.error, 300), http_status: r.status || null, final_url: r.final_url || null };
  }
  const body = r.body || Buffer.alloc(0);
  const text = body.toString('utf8');
  const statusOk = target.expect_status ? r.status === target.expect_status : r.status >= 200 && r.status < 400;
  const textOk = target.expect_text ? text.toLowerCase().includes(String(target.expect_text).toLowerCase()) : true;
  const outcome = statusOk && textOk ? 'pass' : 'fail';
  const why = !statusOk ? `Answered ${r.status}${target.expect_status ? `, expected ${target.expect_status}` : ''}.` : !textOk ? `The expected text was not found${r.truncated ? ` in the first ${Math.round(cfg.max_bytes / 1024)} KB` : ''}.` : null;
  return { ...base, outcome, http_status: r.status, final_url: r.final_url, content_type: r.content_type, bytes: r.bytes, truncated: Boolean(r.truncated), body_sha256: sha256(body), expect_met: { status: statusOk, text: target.expect_text ? textOk : null }, excerpt: target.expect_text ? excerptAround(text, target.expect_text) : null, error: why };
}

// ---------------------------------------------------------------------------
// One repository read (GitHub's public API, a fixed origin)

function ghHeaders() {
  const h = { accept: 'application/vnd.github+json', 'user-agent': 'CryptoResearch-desk/1', 'x-github-api-version': '2022-11-28' };
  const tok = process.env.CR_GITHUB_TOKEN;
  if (tok && /^[A-Za-z0-9_]{20,255}$/.test(tok)) h.authorization = `Bearer ${tok}`;
  return h;
}

async function ghGet(path, { fetchImpl, timeoutMs }) {
  const url = new URL(path, GITHUB);
  if (url.origin !== GITHUB) throw new Error('Unexpected origin');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url.toString(), { headers: ghHeaders(), signal: ctrl.signal, redirect: 'error' });
    let body = null;
    const text = await res.text();
    if (text.length > 2 * 1024 * 1024) throw new Error('Answer too large');
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
    return { status: res.status, body, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

function rateLimited(res) {
  if (!res) return null;
  if (res.status === 429 || (res.status === 403 && res.headers && res.headers.get && res.headers.get('x-ratelimit-remaining') === '0')) {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const ra = Number(res.headers.get('retry-after'));
    const until = Number.isFinite(reset) && reset > 0 ? reset * 1000 : Date.now() + (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 3600000);
    return Math.min(until, Date.now() + 24 * HOUR);
  }
  return null;
}

async function repositoryRead(ws, target, { cfg, fetchImpl, now, reserve }) {
  const o = encodeURIComponent(target.owner);
  const r = encodeURIComponent(target.repo);
  const timeoutMs = cfg.timeout_seconds * 1000;
  const base = { kind: 'repository_read', target_id: target.target_id, repository: `github.com/${target.owner}/${target.repo}` };
  const calls = [`/repos/${o}/${r}`, `/repos/${o}/${r}/commits?per_page=1`, `/repos/${o}/${r}/releases?per_page=5`];
  const answers = [];
  for (const path of calls) {
    if (!reserve()) return { stop: 'budget' };
    let res;
    try {
      res = await ghGet(path, { fetchImpl, timeoutMs });
    } catch (err) {
      return { obs: { ...base, observed_at: isoOf(now()), status: 'error', error: clean(`GitHub did not answer (${err.name === 'AbortError' ? 'timeout' : err.message})`, 200) } };
    }
    const limited = rateLimited(res);
    if (limited) return { stop: 'rate_limited', until: limited };
    if (res.status === 404 && answers.length === 0) return { obs: { ...base, observed_at: isoOf(now()), status: 'not_found', http_status: 404, error: 'GitHub answers 404: the repository is gone, renamed or private. That alone is not discontinuation.' } };
    if (res.status === 409 && path.includes('/commits')) { answers.push([]); continue; } // an empty repository
    if (res.status < 200 || res.status >= 300) return { obs: { ...base, observed_at: isoOf(now()), status: 'error', http_status: res.status, error: `GitHub answered ${res.status}.` } };
    answers.push(res.body);
  }
  const [repo, commits, releases] = answers;
  const c = Array.isArray(commits) && commits[0] ? commits[0] : null;
  const commitAt = c && c.commit && c.commit.committer && c.commit.committer.date ? new Date(c.commit.committer.date).toISOString() : null;
  const rel = Array.isArray(releases) ? releases.filter((x) => x && !x.draft && x.published_at).sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))[0] : null;
  const relAt = rel ? new Date(rel.published_at).toISOString() : null;
  const latest = [commitAt, relAt].filter(Boolean).sort().pop() || null;
  return {
    obs: {
      ...base,
      observed_at: isoOf(now()),
      status: 'ok',
      default_branch: repo && typeof repo.default_branch === 'string' ? clean(repo.default_branch, 100) : null,
      archived: Boolean(repo && repo.archived),
      latest_commit: c ? { sha: clean(c.sha, 40), at: commitAt, message: clean(c.commit && c.commit.message ? c.commit.message.split('\n')[0] : '', 120) } : null,
      latest_release: rel ? { tag: clean(rel.tag_name, 80), at: relAt, name: clean(rel.name, 120) } : null,
      latest_delivery_at: latest,
      note: 'The commit time is the committer date GitHub reports; a date can be set by whoever commits.',
    },
  };
}

// ---------------------------------------------------------------------------
// The run

async function refresh(ws, opts = {}) {
  const { trigger = 'manual', fetchImpl = fetch, lookupImpl, transport, force = false, projectIds = null } = opts;
  const now = () => (opts.now !== undefined ? opts.now : Date.now());
  const cfg = cfgOf(ws);
  if (!cfg.enabled) return { status: 'skipped', message: 'Forensic monitoring is turned off in settings.' };
  if (heldCopy(ws)) return { status: 'held', message: 'A restored copy: the forensic monitor sends nothing until the copy is released.' };
  const t0 = now();
  const st0 = readStatus(ws);
  if (!force && st0.next_allowed_at && Date.parse(st0.next_allowed_at) > t0) return { status: 'backoff', message: `Forensic monitor backing off until ${st0.next_allowed_at}.` };
  const lease = acquireLease(ws, LEASE, 30 * 60000, { label: trigger });
  if (!lease) return { status: 'busy', message: 'Another forensic monitor run is in progress.' };
  const F = require('./forensics');
  const counts = { checks: 0, reads: 0, failed: 0, not_checkable: 0, budget: false, rate_limited: null, resolutions: 0 };
  try {
    let due = dueTargets(ws, t0, cfg);
    if (Array.isArray(projectIds)) due = due.filter((d) => projectIds.includes(d.project.project_id));
    const perProject = new Map();
    for (const d of due) {
      if (!perProject.has(d.project.project_id) && perProject.size >= cfg.max_projects_per_run) continue;
      perProject.set(d.project.project_id, true);
      if (d.kind === 'product_check') {
        if (!reserveRequest(ws, cfg, now())) { counts.budget = true; break; }
        const obs = await productCheck(ws, d.target, { cfg, lookupImpl, transport, now });
        F.appendObservation(ws, d.project.project_id, obs);
        counts.checks += 1;
        if (obs.outcome === 'fail') counts.failed += 1;
        if (obs.outcome === 'not_checkable') counts.not_checkable += 1;
      } else {
        if (gate(readStatus(ws), now())) continue;
        const out = await repositoryRead(ws, d.target, { cfg, fetchImpl, now, reserve: () => reserveRequest(ws, cfg, now()) });
        if (out.stop === 'budget') { counts.budget = true; break; }
        if (out.stop === 'rate_limited') {
          counts.rate_limited = isoOf(out.until);
          updateStatus(ws, (s) => ({ ...s, github_retry_after_until: isoOf(out.until) }));
          continue;
        }
        F.appendObservation(ws, d.project.project_id, out.obs);
        counts.reads += 1;
      }
    }
    // Checkpoint outcomes that came due, once a day.
    const st = readStatus(ws);
    const today = ymdInTz(new Date(now()));
    if (st.last_resolutions_day !== today || force) {
      for (const p of require('./projects').listProjects(ws)) {
        if (p.broken) continue;
        try {
          counts.resolutions += F.recordDueResolutions(ws, p.project_id, { now: now() }).written;
        } catch (_) { /* one project's records never stop the others */ }
      }
    }
    const allFailed = counts.checks > 0 && counts.failed + counts.not_checkable === counts.checks && counts.reads === 0;
    updateStatus(ws, (s) => ({
      ...s,
      last_run_at: isoOf(now()),
      last_trigger: trigger,
      last_result: counts,
      last_resolutions_day: today,
      consecutive_failures: allFailed ? (s.consecutive_failures || 0) + 1 : 0,
      next_allowed_at: allFailed ? isoOf(now() + Math.min(cfg.backoff_max_minutes, cfg.backoff_initial_minutes * 2 ** Math.max(0, (s.consecutive_failures || 0))) * 60000 * (0.9 + crypto.randomInt(0, 200) / 1000)) : null,
    }));
    const did = counts.checks + counts.reads + counts.resolutions;
    return {
      status: !did ? 'noop' : counts.budget ? 'budget_paused' : counts.failed ? 'attention' : 'ok',
      message: !did ? 'No forensic observation was due.' : `${counts.checks} product check(s) (${counts.failed} failed, ${counts.not_checkable} not checkable), ${counts.reads} repository read(s), ${counts.resolutions} checkpoint outcome(s) recorded${counts.budget ? '; the monthly request budget is used up' : ''}${counts.rate_limited ? `; GitHub asked to wait until ${counts.rate_limited}` : ''}.`,
      counts,
    };
  } finally {
    releaseLease(ws, LEASE, lease);
  }
}

function statusView(ws, now = Date.now()) {
  const st = readStatus(ws);
  const cfg = cfgOf(ws);
  const c = callCounts(st, now);
  return {
    enabled: cfg.enabled,
    held: Boolean(heldCopy(ws)),
    last_run_at: st.last_run_at || null,
    last_result: st.last_result || null,
    github_wait_until: gate(st, now),
    next_allowed_at: st.next_allowed_at && Date.parse(st.next_allowed_at) > now ? st.next_allowed_at : null,
    requests_this_month: c.month_count,
    monthly_budget: cfg.monthly_request_budget,
    product_interval_hours: cfg.product_interval_hours,
    repo_interval_hours: cfg.repo_interval_hours,
    github_token: Boolean(process.env.CR_GITHUB_TOKEN),
  };
}

module.exports = { STATUS_REL, isDue, dueTargets, refresh, productCheck, repositoryRead, statusView, readStatus };
