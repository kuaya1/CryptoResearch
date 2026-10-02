'use strict';
// Local dashboard server. Binds to 127.0.0.1 only.
// Security:
// - Host header must be 127.0.0.1:<port> or localhost:<port> (blocks DNS rebinding)
// - every /api call except health/session needs the per-launch token header
// - writes also need a same-origin Origin header and a JSON body
// - cross-site requests (Sec-Fetch-Site) are refused; no CORS headers are sent
// - strict Content-Security-Policy; static files come only from dashboard/public
// - the API takes record IDs, never file paths; API keys never reach the page
// Live refresh: the workspace folder is watched (plus a 5-second poll fallback);
// on change the index is rebuilt. Open pages ask GET /api/version every few
// seconds while visible (a short request; no connection is held open, so any
// number of windows fit the browser's per-server limit) and refetch what
// changed. /api/events (server-sent events) is kept for older pages.
// Reads (audit V2-001): the server keeps the last verified index and serves it
// with read_status (current / stale / unverified). A read that meets a save in
// progress waits briefly, then answers 503 with Retry-After; an interrupted
// save is recovered first. Nothing is ever served from a half-applied save.
// Background work while open: prices every few minutes (shared lease, backoff
// and call budget with the scheduled task), queued requests and inbox files,
// queued research jobs (only ones you started), and the daily jobs.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { readJson, jsonText, fileInfo, listDir, toPosix, sha256 } = require('./core/fsx');
const { isProjectId, isRecordId } = require('./core/ids');
const { PROVIDERS } = require('./core/workspace');
const { runOp, OpError, replaceFile, readConsistent, recover } = require('./core/ops');
const { buildIndex, writeIndex, projectDetail } = require('./core/indexer');
const projects = require('./core/projects');
const notes = require('./core/notes');
const inbox = require('./core/inbox');
const portfolio = require('./core/portfolio');
const market = require('./core/market');
const jobs = require('./core/jobs');
const exporter = require('./core/exporter');
const requests = require('./core/requests');
const research = require('./core/research');

const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};
const WATCH_TOP = new Set(['projects', 'portfolio', 'market-data', 'inbox', 'config', 'templates', 'logs']);
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const MAX_BODY = 30 * 1024 * 1024;
const UI_STATE_REL = 'config/ui-state.json';
// How long a server read waits for a save in progress before answering 503
// (the page retries); the CLI's own reads wait READ_WAIT_MS.
const SERVER_READ_WAIT_MS = 250;
const CHANGE_LOG_MAX = 200;
const READ_CODES = new Set(['READ_BUSY', 'READ_INTERRUPTED', 'READ_UNSAFE']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch (_) { /* the URL is printed anyway */ }
}

async function existingInstance(ws) {
  const info = readJson(ws.abs('.cr/server.json'), null);
  if (!info || !info.port) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/health`, { signal: AbortSignal.timeout(1200) });
    const body = await res.json();
    return body.workspace_id === ws.meta.workspace_id ? info : null;
  } catch (_) {
    return null;
  }
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        reject(new HttpError(400, 'Body must be JSON'));
      }
    });
    req.on('error', reject);
  });
}

function validateSettingsPatch(patch, ws = null) {
  const out = {};
  const num = (v, lo, hi, label) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new OpError('INVALID', `${label} must be between ${lo} and ${hi}`);
    return n;
  };
  if (patch.comparison) {
    out.comparison = {};
    if (patch.comparison.spread_threshold !== undefined) out.comparison.spread_threshold = num(patch.comparison.spread_threshold, 1, 99, 'Spread threshold');
    if (patch.comparison.date_window_days !== undefined) out.comparison.date_window_days = num(patch.comparison.date_window_days, 0, 365, 'Date window');
    if (patch.comparison.show_median !== undefined) out.comparison.show_median = Boolean(patch.comparison.show_median);
  }
  if (patch.grading) {
    out.grading = {};
    if (patch.grading.discrepancy_tolerance !== undefined) out.grading.discrepancy_tolerance = num(patch.grading.discrepancy_tolerance, 0, 20, 'Discrepancy tolerance');
    if (patch.grading.labels !== undefined) {
      const labels = patch.grading.labels;
      if (labels !== null) {
        if (!Array.isArray(labels) || !labels.length) throw new OpError('INVALID', 'Labels must be a list');
        for (const l of labels) {
          if (!l || typeof l.label !== 'string' || !l.label.trim() || l.label.length > 4) throw new OpError('INVALID', 'Each label needs a short name');
          num(l.min, 0, 100, `Label ${l.label} minimum`);
        }
        if (!labels.some((l) => Number(l.min) === 0)) throw new OpError('INVALID', 'One label must start at 0 so every grade gets a label');
        out.grading.labels = labels.map((l) => ({ label: l.label.trim(), min: Number(l.min) }));
      } else out.grading.labels = null;
    }
  }
  if (patch.freshness) {
    out.freshness = {};
    if (patch.freshness.price_stale_minutes !== undefined) out.freshness.price_stale_minutes = num(patch.freshness.price_stale_minutes, 5, 10080, 'Price stale minutes');
    if (patch.freshness.claim_stale_days !== undefined) out.freshness.claim_stale_days = num(patch.freshness.claim_stale_days, 1, 3650, 'Claim stale days');
    if (patch.freshness.report_stale_days !== undefined) out.freshness.report_stale_days = num(patch.freshness.report_stale_days, 1, 3650, 'Report stale days');
    if (patch.freshness.research_stale_days !== undefined) out.freshness.research_stale_days = num(patch.freshness.research_stale_days, 1, 3650, 'Research stale days');
  }
  if (patch.market_data) {
    out.market_data = {};
    if (patch.market_data.enabled !== undefined) out.market_data.enabled = Boolean(patch.market_data.enabled);
    if (patch.market_data.foreground_interval_minutes !== undefined) out.market_data.foreground_interval_minutes = num(patch.market_data.foreground_interval_minutes, 2, 240, 'Refresh interval');
    if (patch.market_data.monthly_call_budget !== undefined) out.market_data.monthly_call_budget = num(patch.market_data.monthly_call_budget, 100, 1000000, 'Monthly call budget');
  }
  if (patch.research) {
    // Only limits and model choices; API keys are never accepted from the page.
    out.research = {};
    const r = patch.research;
    if (r.unattended_enabled !== undefined) out.research.unattended_enabled = Boolean(r.unattended_enabled);
    if (r.budget) {
      out.research.budget = {};
      for (const k of ['per_run_usd', 'daily_usd', 'monthly_usd']) {
        if (r.budget[k] !== undefined) out.research.budget[k] = r.budget[k] === null || r.budget[k] === '' ? null : num(r.budget[k], 0, 10000, `Research ${k}`);
      }
    }
    if (r.default_horizon !== undefined) {
      // The default is a position horizon; longer ones are per-run exceptions with a reason.
      const pos = require('./core/position');
      const m = pos.monthsFrom(String(r.default_horizon));
      if (m.error) throw new OpError('INVALID', m.error);
      const pol = pos.policy(ws);
      if (m.months > pol.planning_ceiling_months && pol.require_long_term_reason) throw new OpError('INVALID', `The default horizon must be within your ${pol.planning_ceiling_months}-month planning ceiling. A longer horizon is a long-term exception, chosen per run with a reason.`);
      out.research.default_horizon = String(r.default_horizon);
    }
    if (r.providers) {
      out.research.providers = {};
      for (const p of PROVIDERS) {
        const c = r.providers[p];
        if (!c) continue;
        if (Object.keys(c).some((k) => /key|secret|token/i.test(k))) throw new OpError('REFUSED', 'API keys are never stored in settings. Put them in ~/.cryptoresearch/secrets.json.');
        const o = {};
        if (c.model !== undefined) {
          if (c.model !== null && !/^[A-Za-z0-9._:\-/]{1,100}$/.test(String(c.model))) throw new OpError('INVALID', 'Model ID looks wrong.');
          o.model = c.model || null;
        }
        for (const k of ['input_usd_per_mtok', 'output_usd_per_mtok', 'search_usd_per_call']) if (c[k] !== undefined) o[k] = c[k] === null || c[k] === '' ? null : num(c[k], 0, 10000, k);
        if (c.max_searches !== undefined) {
          // 0 is kept as 0 and turns web search off; empty means not set
          // (audit V2-005).
          if (c.max_searches === null || c.max_searches === '') o.max_searches = null;
          else {
            const n = num(c.max_searches, 0, 200, 'max_searches');
            if (!Number.isInteger(n)) throw new OpError('INVALID', 'Max searches must be a whole number from 0 to 200 (0 turns web search off).');
            o.max_searches = n;
          }
        }
        if (c.search_billing !== undefined) {
          // Gemini only: the API cannot cap searches, so search is used only
          // when the owner declares that the model bills grounding per request.
          if (p !== 'gemini') throw new OpError('INVALID', 'Search billing is only declared for Gemini.');
          if (![null, '', 'per_request', 'per_query'].includes(c.search_billing)) throw new OpError('INVALID', 'Gemini search billing must be per_request or per_query.');
          o.search_billing = c.search_billing || null;
        }
        out.research.providers[p] = o;
      }
    }
  }
  return out;
}

function mergeDeep(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? mergeDeep(a[k] || {}, v) : v;
  return out;
}

async function start(ws, { port, open = false, host = '127.0.0.1', quiet = false } = {}) {
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('Refusing to listen on a non-loopback address. Remote access needs authentication and is out of scope.');
  }
  const log = (...a) => {
    if (!quiet) console.log(...a);
  };
  const running = await existingInstance(ws);
  if (running) {
    log(`Dashboard already running at ${running.url}`);
    if (open) openBrowser(running.url);
    return { already_running: true, url: running.url };
  }

  const token = crypto.randomBytes(24).toString('hex');
  const startPort = port || ws.settings.server.port || 4729;
  const server = http.createServer();
  let boundPort = null;
  for (let p = startPort; p < startPort + 15; p++) {
    try {
      await listen(server, p, host);
      boundPort = p;
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  if (!boundPort) throw new Error(`No free port between ${startPort} and ${startPort + 14}`);
  const origin = `http://127.0.0.1:${boundPort}`;
  const allowedHosts = new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`]);
  const clients = new Set();
  const sockets = new Set();
  const state = {
    index: null,
    lastError: null,
    rebuilds: 0,
    // What the served index is: current (the latest verified generation),
    // stale (an older verified one, with the reason), unverified (none yet).
    read: { status: 'unverified', reason: 'Not read yet.', code: null, since: null, generation: null, checked_at: null, retry_after_ms: null },
    // Change log for polling pages: seq grows when the served index changes.
    seq: 0,
    changes: [],
    indexSig: null,
    instance: crypto.randomBytes(6).toString('hex'),
    stats: { started_at: new Date().toISOString(), sockets_total: 0, requests: {} },
  };
  server.on('connection', (sock) => {
    state.stats.sockets_total++;
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });

  function broadcast(event) {
    const data = `event: changed\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) res.write(data);
  }

  function projectSigs(index) {
    const m = new Map();
    for (const p of index.projects) m.set(p.project_id, JSON.stringify(p));
    return m;
  }

  function noteChange(areas, projects) {
    state.seq++;
    state.changes.push({ seq: state.seq, at: new Date().toISOString(), areas, projects });
    if (state.changes.length > CHANGE_LOG_MAX) state.changes.splice(0, state.changes.length - CHANGE_LOG_MAX);
  }

  // One verified generation of the index; an interrupted save is recovered
  // (rolled forward) first, a save in progress is waited for briefly.
  function readIndex() {
    try {
      return buildIndex(ws, { waitMs: SERVER_READ_WAIT_MS });
    } catch (err) {
      if (err.code !== 'READ_INTERRUPTED') throw err;
      recover(ws);
      return buildIndex(ws, { waitMs: SERVER_READ_WAIT_MS });
    }
  }

  let rebuildRetry = null;
  let retryDelay = 250;
  function rebuild(areas = []) {
    clearTimeout(rebuildRetry);
    rebuildRetry = null;
    try {
      if (areas.includes('config') || areas.includes('templates')) ws.reloadSettings();
      const prev = state.index;
      const next = readIndex();
      state.index = next;
      state.lastError = null;
      state.rebuilds++;
      state.read = { status: 'current', reason: null, code: null, since: next.generated_at, generation: next.read_generation ? next.read_generation.generation : null, checked_at: new Date().toISOString(), retry_after_ms: null };
      retryDelay = 250;
      writeIndex(ws, next);
      const changedProjects = [];
      if (prev) {
        const a = projectSigs(prev);
        const b = projectSigs(next);
        for (const [id, sig] of b) if (a.get(id) !== sig) changedProjects.push(id);
        for (const id of a.keys()) if (!b.has(id)) changedProjects.push(id);
      }
      const sig = crypto.createHash('sha1').update(JSON.stringify({ ...next, generated_at: null, read_generation: null })).digest('hex');
      if (sig !== state.indexSig) {
        state.indexSig = sig;
        noteChange(areas, prev ? changedProjects : null);
      }
      broadcast({ areas, projects: changedProjects, index_built_at: next.generated_at });
    } catch (err) {
      // Keep serving the last verified index, saying why it may be behind.
      const transient = err.code === 'READ_BUSY' || err.code === 'READ_INTERRUPTED';
      state.lastError = err.message;
      state.read = {
        status: state.index ? 'stale' : 'unverified',
        reason: transient ? 'A save is in progress.' : err.message,
        code: err.code || 'REBUILD_FAILED',
        since: state.index ? state.index.generated_at : null,
        generation: state.index && state.index.read_generation ? state.index.read_generation.generation : null,
        checked_at: new Date().toISOString(),
        retry_after_ms: transient ? retryDelay : null,
      };
      broadcast({ areas, error: err.message, code: err.code || null, read_status: state.read });
      if (transient) {
        rebuildRetry = setTimeout(() => rebuild(areas), retryDelay);
        retryDelay = Math.min(retryDelay * 2, 5000);
      } else {
        if (err.code === 'READ_UNSAFE') rebuildRetry = setTimeout(() => rebuild(areas), 30000);
        console.error('Index rebuild failed:', err.message);
      }
    }
  }

  let rebuildTimer = null;
  const pendingAreas = new Set();
  function scheduleRebuild(area) {
    pendingAreas.add(area);
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      const areas = [...pendingAreas];
      pendingAreas.clear();
      rebuild(areas);
    }, 300);
  }

  let inboxTimer = null;
  let jobsRunning = false;
  function scheduleInbox(delay = 1500) {
    clearTimeout(inboxTimer);
    inboxTimer = setTimeout(async () => {
      if (jobsRunning) return scheduleInbox(2000);
      jobsRunning = true;
      try {
        const results = await jobs.runJobs(ws, ['requests', 'inbox'], { trigger: 'dashboard' });
        if (results.some((r) => /still being written|still pending/.test(r.summary || '') && !/ 0 still/.test(r.summary))) scheduleInbox(3000);
      } catch (err) {
        console.error('Inbox processing failed:', err.message);
      } finally {
        jobsRunning = false;
      }
    }, delay);
  }

  // Watch the workspace; fall back to polling a cheap signature every 5 seconds.
  let watcher = null;
  try {
    watcher = fs.watch(ws.root, { recursive: true }, (evt, filename) => {
      if (!filename) return scheduleRebuild('all');
      const rel = toPosix(String(filename));
      if (/\.tmp-\d+-|[\\/]?\.cr[\\/]|^\.cr/.test(rel) || rel === UI_STATE_REL) return;
      const top = rel.split('/')[0];
      if (!WATCH_TOP.has(top)) return;
      if (top === 'logs' && !/^logs\/(operations\.jsonl|jobs-state\.json|ingestion-state\.json|review-findings\.json|requests\/)/.test(rel)) return;
      if (top === 'market-data' && /^market-data\/(observations|logos)\//.test(rel)) return;
      if (top === 'inbox' && !/\/processed\/|\/failed\//.test(rel)) scheduleInbox();
      scheduleRebuild(top);
    });
  } catch (err) {
    console.error('File watching unavailable, using polling only:', err.message);
  }
  const hash = (parts) => crypto.createHash('sha1').update(parts.join('\n')).digest('hex');
  function inboxSignature() {
    const parts = PROVIDERS.map((p) => `inbox/${p}:${listDir(ws.abs(`inbox/${p}`), { dirs: false }).join('|')}`);
    parts.push(`requests:${listDir(ws.abs('inbox/requests'), { dirs: false }).join('|')}`);
    return hash(parts);
  }
  function recordSignature() {
    const parts = [];
    const add = (rel) => {
      const i = fileInfo(ws.abs(rel));
      parts.push(`${rel}:${i ? `${i.size}:${i.mtimeMs}` : '-'}`);
    };
    ['logs/operations.jsonl', 'logs/jobs-state.json', 'logs/ingestion-state.json', 'market-data/status.json', 'market-data/latest.json', 'config/settings.json', 'portfolio/transactions.json', 'portfolio/accounts.json', 'portfolio/limits.json', 'portfolio/events.json'].forEach(add);
    for (const id of listDir(ws.abs('projects'), { dirs: true })) {
      for (const f of ['project.json', 'events.json', 'claim-reviews.json', 'disputes.json', 'notes/conviction.md']) add(`projects/${id}/${f}`);
      parts.push(`${id}/reports:${listDir(ws.abs(`projects/${id}/reports`), { dirs: true }).join('|')}`);
      parts.push(`${id}/journal:${listDir(ws.abs(`projects/${id}/journal`), { dirs: false }).length}`);
      for (const r of listDir(ws.abs(`projects/${id}/research`), { dirs: true })) add(`projects/${id}/research/${r}/run.json`);
    }
    return hash(parts);
  }
  let lastInboxSig = inboxSignature();
  let lastRecordSig = recordSignature();
  const pollTimer = setInterval(() => {
    try {
      const inboxSig = inboxSignature();
      const recordSig = recordSignature();
      let changed = false;
      if (inboxSig !== lastInboxSig) {
        lastInboxSig = inboxSig;
        scheduleInbox(500);
        changed = true;
      }
      if (recordSig !== lastRecordSig) {
        lastRecordSig = recordSig;
        changed = true;
      }
      if (changed) scheduleRebuild('poll');
    } catch (_) { /* transient */ }
  }, 5000);

  // Background work while the dashboard is open, under the same due rules,
  // leases and backoff as the scheduled task.
  async function marketTick(force = false) {
    if (!ws.settings.market_data.enabled) return null;
    try {
      if (force) return await market.refresh(ws, { trigger: 'dashboard', force: true });
      if (!jobs.marketDue(ws, Date.now(), { foreground: true })) return null;
      return await jobs.runJob(ws, 'market', { trigger: 'dashboard' });
    } catch (err) {
      console.error('Market refresh failed:', err.message);
      return null;
    }
  }
  let researchRunning = false;
  async function researchTick() {
    if (researchRunning) return;
    researchRunning = true;
    try {
      await jobs.runJob(ws, 'research', { trigger: 'dashboard', onlyDue: true });
    } catch (err) {
      console.error('Research jobs failed:', err.message);
    } finally {
      researchRunning = false;
    }
  }
  const marketTimer = setInterval(() => marketTick(false), 60000);
  const researchTimer = setInterval(() => researchTick(), 2 * 60000);
  const dailyTimer = setInterval(() => jobs.runJobs(ws, ['snapshot', 'reviews', 'backup'], { trigger: 'dashboard', onlyDue: true }).catch(() => {}), 30 * 60000);

  const api = makeApi({ ws, state, token, rebuild, marketTick, researchTick, clients, sockets });

  server.on('request', async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', CSP);
    try {
      const hostHeader = String(req.headers.host || '').toLowerCase();
      if (!allowedHosts.has(hostHeader)) throw new HttpError(403, 'Host not allowed');
      const url = new URL(req.url, origin);
      const bucket = url.pathname.startsWith('/api/') ? (['/api/version', '/api/index', '/api/events', '/api/session', '/api/health'].includes(url.pathname) ? url.pathname : '/api/(other)') : '(static)';
      state.stats.requests[bucket] = (state.stats.requests[bucket] || 0) + 1;
      if (url.pathname.startsWith('/api/')) {
        const site = req.headers['sec-fetch-site'];
        if (site && !['same-origin', 'none'].includes(site)) throw new HttpError(403, 'Cross-site request refused');
        if (url.pathname === '/api/events') return sse(req, res);
        return await api(req, res, url, { allowedOrigins });
      }
      return serveStatic(req, res, url);
    } catch (err) {
      // A read that met a save in progress, an interrupted save or an
      // unverified commit is 503: nothing mixed is ever returned (V2-001).
      const readErr = READ_CODES.has(err.code);
      const status = err.status || (err.code === 'NOT_FOUND' ? 404 : ['INVALID', 'BAD_ID', 'BAD_PATH', 'CONFLICT', 'REFUSED', 'ALREADY_EXISTS', 'CONFIRM', 'AMBIGUOUS', 'IDEMPOTENCY_CONFLICT', 'UNSAFE_PATH'].includes(err.code) ? 400 : ['WORKSPACE_BUSY', 'WRITES_BLOCKED'].includes(err.code) ? 409 : readErr ? 503 : 500);
      if (status >= 500 && !readErr) console.error(err);
      const retryMs = readErr && err.code !== 'READ_UNSAFE' ? (err.details && err.details.retry_after_ms) || 1000 : null;
      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(retryMs ? { 'Retry-After': String(Math.max(1, Math.ceil(retryMs / 1000))) } : {}) });
      }
      res.end(JSON.stringify({ error: status >= 500 && !readErr ? `Server error: ${err.message}` : err.message, code: err.code || null, retry_after_ms: retryMs, saved: readErr && req.method === 'GET' ? false : ['INVALID', 'BAD_ID', 'BAD_PATH', 'NOT_FOUND', 'CONFLICT', 'REFUSED', 'ALREADY_EXISTS', 'CONFIRM', 'WORKSPACE_BUSY', 'WRITES_BLOCKED', 'AMBIGUOUS', 'IDEMPOTENCY_CONFLICT', 'UNSAFE_PATH', 'GENERATION_UNWRITABLE'].includes(err.code) || err.status ? false : 'unknown' }));
    }
  });

  function sse(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ index_built_at: state.index ? state.index.generated_at : null })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch (_) {
      throw new HttpError(400, 'Bad path');
    }
    if (pathname === '/') pathname = '/index.html';
    if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some((s) => s === '..' || s === '.')) throw new HttpError(404, 'Not found');
    const abs = path.resolve(PUBLIC_DIR, `.${pathname}`);
    const back = path.relative(PUBLIC_DIR, abs);
    if (!back || back.startsWith('..') || path.isAbsolute(back)) throw new HttpError(404, 'Not found');
    const type = STATIC_TYPES[path.extname(abs).toLowerCase()];
    const info = fileInfo(abs);
    if (!type || !info || !info.isFile) throw new HttpError(404, 'Not found');
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(abs).pipe(res);
  }

  rebuild(['startup']);
  const serverInfo = { pid: process.pid, port: boundPort, url: `${origin}/`, started_at: new Date().toISOString(), workspace_id: ws.meta.workspace_id, host, host_name: os.hostname(), node: process.version };
  replaceFile(ws, ws.abs('.cr/server.json'), jsonText(serverInfo));
  scheduleInbox(200);
  const startupTimers = [
    setTimeout(() => marketTick(false), 1500),
    setTimeout(() => researchTick(), 5000),
    setTimeout(() => jobs.runJobs(ws, ['snapshot', 'reviews', 'backup'], { trigger: 'dashboard', onlyDue: true }).catch(() => {}), 8000),
  ];

  const shutdown = () => {
    startupTimers.forEach(clearTimeout);
    clearTimeout(inboxTimer);
    clearTimeout(rebuildTimer);
    clearTimeout(rebuildRetry);
    clearInterval(pollTimer);
    clearInterval(marketTimer);
    clearInterval(researchTimer);
    clearInterval(dailyTimer);
    if (watcher) watcher.close();
    try {
      const cur = readJson(ws.abs('.cr/server.json'), null);
      if (cur && cur.pid === process.pid) fs.unlinkSync(ws.abs('.cr/server.json'));
    } catch (_) { /* ignore */ }
    for (const c of clients) c.end();
    server.close();
  };
  process.once('SIGINT', () => {
    shutdown();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    shutdown();
    process.exit(0);
  });

  log('');
  log(`CryptoResearch dashboard: ${origin}/`);
  log(`Workspace: ${ws.root}${ws.kind !== 'real' ? `  [${ws.kind.toUpperCase()} WORKSPACE - FICTIONAL DATA]` : ''}`);
  log(`Node ${process.version}. Listening on 127.0.0.1 only. Close this window (or press Ctrl+C) to stop the dashboard.`);
  if (open) openBrowser(`${origin}/`);
  return { url: `${origin}/`, port: boundPort, token, server, shutdown, state };
}

function makeApi({ ws, state, token, rebuild, marketTick, researchTick, clients, sockets }) {
  const send = (res, status, body, type = 'application/json; charset=utf-8', extra = {}) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const pid = (id) => {
    if (!isProjectId(id)) throw new HttpError(400, 'Invalid project ID');
    return id;
  };
  const rid = (id) => {
    if (!isRecordId(id)) throw new HttpError(400, 'Invalid ID');
    return id;
  };
  const runId = (id) => {
    if (!research.RUN_ID_RE.test(id)) throw new HttpError(400, 'Invalid run ID');
    return id;
  };
  const provider = (p) => {
    if (!PROVIDERS.includes(p)) throw new HttpError(400, 'Unknown provider');
    return p;
  };
  const after = (result) => {
    rebuild(['api']);
    return result;
  };
  // A form submission carries a one-time ID, so a double click or a retry
  // after a lost response applies once.
  const once = (body, fn) => {
    const sid = body && typeof body.submission_id === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(body.submission_id) ? body.submission_id : null;
    if (!sid) return fn();
    const { submission_id: _s, ...payload } = body;
    ws._idem = { requestId: `sub_${sid}`, payloadHash: sha256(JSON.stringify(payload)) };
    try {
      return fn();
    } finally {
      ws._idem = null;
    }
  };

  // A read against one verified generation of the records (audit V2-001). An
  // interrupted save is recovered first; a save in progress is a bounded wait,
  // then READ_BUSY (503 with Retry-After).
  const coherent = (fn) => {
    try {
      return readConsistent(ws, fn, { waitMs: SERVER_READ_WAIT_MS });
    } catch (err) {
      if (err.code !== 'READ_INTERRUPTED') throw err;
      recover(ws);
      return readConsistent(ws, fn, { waitMs: SERVER_READ_WAIT_MS });
    }
  };

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler });

  // The last verified index, with what it is (current or stale, and why).
  // With nothing verified yet, 503 and Retry-After instead of a guess.
  route('GET', '/api/index', () => {
    if (!state.index) rebuild(['request']);
    if (!state.index) {
      throw new OpError(state.read.code && READ_CODES.has(state.read.code) ? state.read.code : 'READ_BUSY', `Nothing verified to show yet: ${state.read.reason || 'the records could not be read'}`, { retry_after_ms: state.read.retry_after_ms || 1000 });
    }
    return { ...state.index, read_status: state.read, live: { seq: state.seq, instance: state.instance } };
  });
  // What changed since a page's last look: polled by visible pages (V2-006).
  route('GET', '/api/version', (m, req, res, body, url) => {
    const since = Number(url.searchParams.get('since'));
    const known = Number.isInteger(since) && since >= 0 && since <= state.seq && (since === state.seq || (state.changes.length && since >= state.changes[0].seq - 1));
    return {
      instance: state.instance,
      seq: state.seq,
      index_built_at: state.index ? state.index.generated_at : null,
      read_status: state.read,
      changes: known ? state.changes.filter((c) => c.seq > since) : null,
    };
  });
  // Counts for checking that open pages stay within bounds (no records).
  route('GET', '/api/server-stats', () => ({ instance: state.instance, started_at: state.stats.started_at, sockets_open: sockets.size, sockets_total: state.stats.sockets_total, event_streams_open: clients.size, requests: state.stats.requests, seq: state.seq, rebuilds: state.rebuilds, read_status: state.read }));
  route('GET', '/api/projects/([^/]+)', (m) => {
    const id = pid(m[1]);
    try {
      return projectDetail(ws, id, { waitMs: SERVER_READ_WAIT_MS });
    } catch (err) {
      if (err.code !== 'READ_INTERRUPTED') throw err;
      recover(ws);
      return projectDetail(ws, id, { waitMs: SERVER_READ_WAIT_MS });
    }
  });
  route('GET', '/api/projects/([^/]+)/reports/([^/]+)/original', (m) => {
    const id = pid(m[1]);
    const r = rid(m[2]);
    const meta = readJson(ws.abs(`projects/${id}/reports/${r}/meta.json`), null);
    if (!meta) throw new HttpError(404, 'No such report');
    const file = ws.abs(`projects/${id}/reports/${r}/${meta.original_file}`);
    if (meta.original_file.endsWith('.pdf')) {
      return { _raw: fs.readFileSync(file), _type: 'application/pdf', _extra: { 'Content-Disposition': `attachment; filename="${r}.pdf"` } };
    }
    return { _raw: fs.readFileSync(file, 'utf8'), _type: 'text/plain; charset=utf-8' };
  });
  route('GET', '/api/projects/([^/]+)/reports/([^/]+)/record', (m) => {
    const id = pid(m[1]);
    const r = rid(m[2]);
    const rec = readJson(ws.abs(`projects/${id}/reports/${r}/report.json`), null);
    if (!rec) throw new HttpError(404, 'No such report');
    return { _raw: JSON.stringify(rec, null, 2), _type: 'application/json; charset=utf-8' };
  });
  route('GET', '/api/projects/([^/]+)/prompts/([a-z]+)', (m) => {
    const id = pid(m[1]);
    provider(m[2]);
    const abs = ws.abs(`projects/${id}/prompts/${m[2]}.md`);
    if (!fileInfo(abs)) throw new HttpError(404, 'Prompt not generated yet');
    return { _raw: fs.readFileSync(abs, 'utf8'), _type: 'text/plain; charset=utf-8' };
  });
  route('GET', '/api/projects/([^/]+)/prompt-file', (m, req, res, body, url) => {
    const id = pid(m[1]);
    const name = String(url.searchParams.get('name') || '');
    const file = require('./core/prompts').listPromptFiles(ws, id).find((f) => f.name === name);
    if (!file) throw new HttpError(404, 'No such prompt file');
    return { _raw: fs.readFileSync(ws.abs(file.rel), 'utf8'), _type: 'text/plain; charset=utf-8' };
  });
  route('GET', '/api/projects/([^/]+)/research/([^/]+)/prompt', (m) => {
    const id = pid(m[1]);
    const run = research.loadRun(ws, id, runId(m[2]));
    if (!run) throw new HttpError(404, 'No such research run');
    return { _raw: fs.readFileSync(ws.abs(run.prompt.path), 'utf8'), _type: 'text/plain; charset=utf-8' };
  });
  route('GET', '/api/projects/([^/]+)/changes', (m, req, res, body, url) => {
    const id = pid(m[1]);
    return coherent(() => require('./core/digest').changesSince(ws, id, { since: url.searchParams.get('since') || null, latestMarket: market.readLatest(ws) }));
  });
  route('GET', '/api/portfolio/ledger', () => coherent(() => {
    const reg = portfolio.assetRegistry(ws);
    return { transactions: portfolio.loadTransactions(ws), accounts: portfolio.loadAccounts(ws), assets: Array.from(reg instanceof Map ? reg.values() : Object.values(reg || {})).map((a) => ({ asset_id: a.asset_id, symbol: a.symbol || null, name: a.name || null, kind: a.kind || null, decimals: a.decimals, project_id: a.project_id || null })) };
  }));
  route('GET', '/api/market/lookup', (m, req, res, body, url) => market.searchCoins(ws, String(url.searchParams.get('q') || '')));
  route('GET', '/api/inbox/text', (m, req, res, body, url) => inbox.readInboxText(ws, String(url.searchParams.get('key') || '')));
  route('GET', '/api/ui-state', () => readJson(ws.abs(UI_STATE_REL), {}));
  route('GET', '/api/export.json', () => ({ _raw: JSON.stringify(exporter.exportJson(ws), null, 2), _type: 'application/json; charset=utf-8', _extra: { 'Content-Disposition': 'attachment; filename="cryptoresearch-portable-export.json"' } }));
  route('GET', '/api/export/package', () => ({ _raw: JSON.stringify(exporter.exportPackage(ws)), _type: 'application/json; charset=utf-8', _extra: { 'Content-Disposition': 'attachment; filename="cryptoresearch-complete-package.json"' } }));
  route('GET', '/api/export/inventory', () => ({ portable: exporter.EXPORT_INVENTORY }));
  route('GET', '/api/export/([a-z]+)\\.csv', (m) => ({ _raw: exporter.csvTable(ws, m[1]), _type: 'text/csv; charset=utf-8', _extra: { 'Content-Disposition': `attachment; filename="${m[1]}.csv"` } }));
  route('GET', '/api/schedule', () => require('./core/schedule').status(ws));
  route('GET', '/api/backups', () => exporter.listBackups(ws));
  route('GET', '/api/backups/([A-Za-z0-9_-]+)/verify', (m) => exporter.verifyBackup(ws, m[1]));
  route('GET', '/api/doctor', async () => require('./core/doctor').doctor(ws));
  route('GET', '/api/research/providers', () => coherent(() => ({ providers: research.providerStatus(ws), budget: ws.settings.research.budget, spend: research.spendSoFar(ws), unattended_enabled: Boolean(ws.settings.research.unattended_enabled), keys_file: require('./core/providers').secretsFile() })));

  route('POST', '/api/projects', (m, req, res, body) => once(body, () => {
    const r = projects.addProject(ws, { ...body, utterance: body.utterance || null });
    let run = null;
    if (body.research && Array.isArray(body.research_providers) && body.research_providers.length && ['created', 'exists'].includes(r.status)) {
      run = research.createRun(ws, { project_id: r.project_id, providers: body.research_providers, horizon: body.horizon || null, long_term_reason: body.long_term_reason || null, channel: 'dashboard', utterance: body.utterance || null });
      setTimeout(() => researchTick(), 500);
    }
    return after({ ...r, research: run ? { status: run.status, run_id: run.run_id, message: run.message } : null });
  }));
  route('POST', '/api/projects/([^/]+)/identity', (m, req, res, body) => after(projects.updateIdentity(ws, pid(m[1]), body)));
  route('POST', '/api/projects/([^/]+)/watchlist', (m, req, res, body) => after(projects.setWatchlist(ws, pid(m[1]), Boolean(body.on))));
  route('POST', '/api/projects/([^/]+)/headline', (m, req, res, body) => after(projects.setHeadline(ws, pid(m[1]), body)));
  route('POST', '/api/projects/([^/]+)/archive', (m, req, res, body) => after(projects.archiveProject(ws, pid(m[1]), body.reason)));
  route('POST', '/api/projects/([^/]+)/fields', (m, req, res, body) => after(projects.updateProjectFields(ws, pid(m[1]), body)));
  route('POST', '/api/projects/([^/]+)/reviewed', (m, req, res, body) => after(projects.markReviewed(ws, pid(m[1]), { note: body.note || null })));
  route('POST', '/api/projects/([^/]+)/prompts', (m, req, res, body) => after(projects.generatePrompts(ws, pid(m[1]), body.providers || PROVIDERS)));
  route('POST', '/api/projects/([^/]+)/research', (m, req, res, body) => once(body, () => {
    const out = research.createRun(ws, { project_id: pid(m[1]), providers: body.providers, horizon: body.horizon || null, long_term_reason: body.long_term_reason || null, same_as_last: Boolean(body.same_as_last), channel: 'dashboard', utterance: body.utterance || null });
    setTimeout(() => researchTick(), 500);
    return after({ status: out.status, run_id: out.run_id, message: out.message, run: out.run });
  }));
  route('POST', '/api/projects/([^/]+)/research/([^/]+)/jobs/([a-z]+)/(cancel|retry)', (m) => {
    const id = pid(m[1]);
    const out = m[4] === 'cancel' ? research.cancelJob(ws, id, runId(m[2]), provider(m[3]), 'canceled from the dashboard') : research.retryJob(ws, id, runId(m[2]), provider(m[3]));
    if (m[4] === 'retry') setTimeout(() => researchTick(), 500);
    return after(out);
  });
  // The owner records what the provider charged for an attempt whose outcome
  // is uncertain (or an error without usage): an amount, or not charged.
  route('POST', '/api/projects/([^/]+)/research/([^/]+)/jobs/([a-z]+)/reconcile', (m, req, res, body) => after(research.reconcileAttempt(ws, pid(m[1]), runId(m[2]), provider(m[3]), {
    attempt: body.attempt === undefined ? null : body.attempt,
    charged_usd: body.charged_usd,
    not_charged: body.not_charged === true,
    reason: body.reason,
  })));
  route('POST', '/api/projects/([^/]+)/note', (m, req, res, body) => after(notes.setConvictionNote(ws, pid(m[1]), body.text, { conviction: body.conviction || null })));
  route('POST', '/api/projects/([^/]+)/journal', (m, req, res, body) => once(body, () => after(notes.addJournal(ws, pid(m[1]), body))));
  route('POST', '/api/scopes/([^/]+)/events', (m, req, res, body) => once(body, () => after(notes.addEvent(ws, m[1] === 'portfolio' ? 'portfolio' : pid(m[1]), body))));
  route('POST', '/api/scopes/([^/]+)/events/([^/]+)', (m, req, res, body) => after(notes.updateEventStatus(ws, m[1] === 'portfolio' ? 'portfolio' : pid(m[1]), rid(m[2]), body.status)));
  route('POST', '/api/projects/([^/]+)/claims', (m, req, res, body) => after(notes.reviewClaim(ws, pid(m[1]), rid(body.report_id), String(body.claim_id || ''), body)));
  route('POST', '/api/projects/([^/]+)/disputes', (m, req, res, body) => after(notes.addDispute(ws, pid(m[1]), body)));
  route('POST', '/api/projects/([^/]+)/reports/([^/]+)/corrections', (m, req, res, body) => after(notes.addCorrection(ws, pid(m[1]), rid(m[2]), body.field, body.value, body.reason)));
  // A paste or upload carries a submission ID derived from its exact content,
  // so a double click or a resubmission saves one inbox copy, not two.
  route('POST', '/api/import/text', (m, req, res, body) => {
    if (!PROVIDERS.includes(body.provider)) throw new HttpError(400, 'Choose Claude, ChatGPT or Gemini');
    if (body.run_id) runId(body.run_id);
    return once(body, () => after(inbox.importContent(ws, body.provider, { content: body.text, filename: body.filename || null, projectId: body.project_id || null, runId: body.run_id || null, channel: 'dashboard paste' })));
  });
  route('POST', '/api/import/file', (m, req, res, body) => {
    if (!PROVIDERS.includes(body.provider)) throw new HttpError(400, 'Choose Claude, ChatGPT or Gemini');
    if (body.run_id) runId(body.run_id);
    const buf = Buffer.from(String(body.base64 || ''), 'base64');
    return once(body, () => after(inbox.importContent(ws, body.provider, { content: buf, filename: body.filename || 'upload.md', projectId: body.project_id || null, runId: body.run_id || null, channel: 'dashboard upload' })));
  });
  route('POST', '/api/inbox/scan', () => after(inbox.scanInbox(ws, { force: true })));
  route('POST', '/api/inbox/retry', (m, req, res, body) => {
    if (body.run_id) runId(body.run_id);
    return after(inbox.assignAndRetry(ws, String(body.key || ''), body.project_id || null, { allowProviderMismatch: Boolean(body.allow_provider_mismatch), runId: body.run_id || null }));
  });
  route('POST', '/api/inbox/set-aside', (m, req, res, body) => after(inbox.setAside(ws, String(body.key || ''), body.reason || null)));
  route('POST', '/api/requests/process', () => after(requests.processRequests(ws)));
  route('POST', '/api/portfolio/transactions', (m, req, res, body) => once(body, () => after(portfolio.addTransactions(ws, Array.isArray(body.transactions) ? body.transactions : [body], { source: 'dashboard' }))));
  route('POST', '/api/portfolio/transactions/([^/]+)/void', (m, req, res, body) => after(portfolio.voidTransaction(ws, rid(m[1]), body.reason)));
  route('POST', '/api/portfolio/csv', (m, req, res, body) => after(portfolio.importCsv(ws, String(body.csv || ''), { filename: body.filename || 'dashboard.csv', defaultAccount: body.account_id || null, allowIdentical: Boolean(body.allow_identical) })));
  route('POST', '/api/portfolio/accounts', (m, req, res, body) => after(portfolio.addAccount(ws, body)));
  route('POST', '/api/portfolio/limits', (m, req, res, body) => after(portfolio.setLimits(ws, body)));
  route('POST', '/api/market/refresh', async () => {
    const r = await marketTick(true);
    return after({ result: r, status: market.freshness(ws) });
  });
  route('POST', '/api/research/run', async () => {
    await researchTick();
    return after({ status: 'ok' });
  });
  route('POST', '/api/jobs/reviews', () => after(jobs.buildReviewFindings(ws)));
  route('POST', '/api/backups', () => exporter.createBackup(ws, { reason: 'manual' }));
  route('POST', '/api/ui-state', (m, req, res, body) => {
    // A per-workspace view preference (columns, sort, filters). Not a record.
    const text = JSON.stringify(body || {});
    if (text.length > 20000) throw new HttpError(413, 'Too large');
    replaceFile(ws, ws.abs(UI_STATE_REL), `${JSON.stringify(body, null, 2)}\n`);
    return { status: 'saved' };
  });
  route('POST', '/api/settings', (m, req, res, body) => {
    const patch = validateSettingsPatch(body || {}, ws);
    const out = runOp(ws, { type: 'update_settings', summary: 'Update dashboard settings' }, (op) => {
      const cur = op.readJson('config/settings.json', { schema_version: 1 });
      op.writeJson('config/settings.json', mergeDeep(cur, patch));
    });
    ws.reloadSettings();
    rebuild(['config']);
    return { status: 'saved', files: out.files };
  });

  return async function handle(req, res, url, { allowedOrigins }) {
    if (url.pathname === '/api/health') {
      const p = url.searchParams.get('project');
      return send(res, 200, {
        ok: true,
        workspace_id: ws.meta.workspace_id,
        kind: ws.kind,
        index_built_at: state.index ? state.index.generated_at : null,
        project_present: p && state.index ? state.index.projects.some((x) => x.project_id === p) : undefined,
      });
    }
    if (url.pathname === '/api/session') {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      return send(res, 200, { token, workspace: { name: ws.meta.name, kind: ws.kind, root: ws.root, workspace_id: ws.meta.workspace_id } });
    }
    // Logos are public CoinGecko images. An <img> cannot send the session token;
    // Cross-Origin-Resource-Policy: same-origin keeps other sites from loading them.
    const logo = req.method === 'GET' ? url.pathname.match(/^\/api\/logos\/([a-z0-9-]{1,100})$/) : null;
    if (logo) {
      const f = market.logoFile(ws, logo[1]);
      if (!f) throw new HttpError(404, 'No logo');
      return send(res, 200, fs.readFileSync(f.abs), f.type, { 'Cache-Control': 'max-age=86400' });
    }
    if (req.headers['x-cr-token'] !== token) throw new HttpError(401, 'Missing or wrong session token. Reload the page.');
    if (req.method === 'POST') {
      const o = req.headers.origin;
      if (!o || !allowedOrigins.has(o)) throw new HttpError(403, 'Writes are only accepted from the dashboard page itself.');
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'JSON required');
    } else if (req.method !== 'GET') {
      throw new HttpError(405, 'Method not allowed');
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const body = req.method === 'POST' ? await readBody(req) : null;
      const out = await r.handler(m, req, res, body, url);
      if (out && out._raw !== undefined) return send(res, 200, out._raw, out._type, out._extra || {});
      return send(res, 200, out === undefined ? { ok: true } : out);
    }
    throw new HttpError(404, 'Unknown API route');
  };
}

module.exports = { start, validateSettingsPatch };
