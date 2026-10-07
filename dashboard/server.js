'use strict';
// Dashboard server. On the PC it binds to 127.0.0.1 only. Hosted mode
// (dashboard/hosted.js, the private web app on Render) listens on Render's port
// behind its HTTPS proxy and adds a passphrase sign-in in front of everything:
// signed-out requests get the sign-in page (or 401 for the API); the host
// names and https origins it answers to come from Render's environment.
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
const intake = require('./core/intake');

const PUBLIC_DIR = path.join(__dirname, 'public');
// What the sign-in page itself needs before anyone is signed in.
const LOGIN_ASSETS = new Set(['/styles.css', '/position.css', '/favicon.svg']);
// A page that asked for anything in this long counts as open (hosted mode
// refreshes prices at the foreground interval only while a page is open).
const PAGE_OPEN_MS = 10 * 60000;
// How often a ChatGPT or Gemini request running in the background is checked
// (CR_BACKGROUND_CHECK_MS shortens it in tests).
const BACKGROUND_CHECK_MS = 30000;
const backgroundCheckMs = () => Math.max(100, Number(process.env.CR_BACKGROUND_CHECK_MS) || BACKGROUND_CHECK_MS);
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};
const WATCH_TOP = new Set(['projects', 'portfolio', 'market-data', 'inbox', 'config', 'templates', 'logs']);
// Beyond the desk's own origin, only the inspector's market views: the frames
// of its technical chart (TradingView's widget, DexScreener's pool chart;
// public/views/chart.js) and DexScreener's public API, which the browser asks
// on demand for the DEX liquidity card (public/views/dex.js). No third-party
// script runs in the page; each frame is isolated by its own origin and a
// sandbox.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://api.dexscreener.com; font-src 'self'; frame-src https://www.tradingview-widget.com https://dexscreener.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const MAX_BODY = 30 * 1024 * 1024;
// The Refresh button calls CoinGecko at most once a minute (POST /api/market/refresh).
const MANUAL_REFRESH_MIN_MS = 60000;
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
  if (patch.wallet_sync) {
    // Schedule and limits only; the Moralis key is never accepted from the page.
    const w = patch.wallet_sync;
    if (Object.keys(w).some((k) => /key|secret|token|address/i.test(k))) throw new OpError('REFUSED', 'Keys and addresses are never stored in settings. The Moralis key goes in Render > Environment (MORALIS_API_KEY); addresses are added as tracked wallets.');
    out.wallet_sync = {};
    if (w.enabled !== undefined) out.wallet_sync.enabled = Boolean(w.enabled);
    const whole = (v, lo, hi, label) => {
      const n = num(v, lo, hi, label);
      if (!Number.isInteger(n)) throw new OpError('INVALID', `${label} must be a whole number from ${lo} to ${hi}.`);
      return n;
    };
    if (w.interval_minutes !== undefined) out.wallet_sync.interval_minutes = whole(w.interval_minutes, 5, 1440, 'Sync interval (minutes)');
    if (w.balance_refresh_minutes !== undefined) out.wallet_sync.balance_refresh_minutes = whole(w.balance_refresh_minutes, 5, 1440, 'Balance refresh (minutes)');
    if (w.daily_cu_budget !== undefined) out.wallet_sync.daily_cu_budget = w.daily_cu_budget === null || w.daily_cu_budget === '' ? null : whole(w.daily_cu_budget, 500, 100000000, 'Daily compute-unit budget');
    if (w.dust_usd !== undefined) out.wallet_sync.dust_usd = num(w.dust_usd, 0, 1000, 'Dust threshold (USD)');
  }
  if (patch.research) {
    // Only limits and model choices; API keys are never accepted from the page.
    out.research = {};
    const r = patch.research;
    if (r.unattended_enabled !== undefined) out.research.unattended_enabled = Boolean(r.unattended_enabled);
    // A model on hold gets nothing new (research.heldProviders): null lifts
    // the hold; true puts it on hold from today, with a short reason.
    if (r.on_hold && typeof r.on_hold === 'object') {
      out.research.on_hold = {};
      for (const p of PROVIDERS) {
        if (r.on_hold[p] === undefined) continue;
        if (r.on_hold[p] === null || r.on_hold[p] === false) out.research.on_hold[p] = null;
        else out.research.on_hold[p] = { since: require('./core/dates').ymdInTz(), reason: typeof r.on_hold[p] === 'object' && typeof r.on_hold[p].reason === 'string' ? r.on_hold[p].reason.slice(0, 300) : 'Put on hold in Settings.' };
      }
    }
    if (r.background_deadline_minutes !== undefined) {
      const n = num(r.background_deadline_minutes, 5, 1440, 'Background time limit (minutes)');
      if (!Number.isInteger(n)) throw new OpError('INVALID', 'The background time limit is a whole number of minutes from 5 to 1440.');
      out.research.background_deadline_minutes = n;
    }
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
        if (Object.keys(c).some((k) => /key|secret|token/i.test(k))) throw new OpError('REFUSED', 'API keys are never stored in settings. On the online desk they go in Render > Environment; on the PC in ~/.cryptoresearch/secrets.json.');
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
        if (c.effort !== undefined) {
          // ChatGPT's reasoning effort and Gemini's thinking level ("off" sends none).
          const allowed = { chatgpt: ['low', 'medium', 'high', 'xhigh', 'max'], gemini: ['minimal', 'low', 'medium', 'high'] }[p];
          if (!allowed) throw new OpError('INVALID', 'Claude\'s effort is set once for research (research.effort).');
          if (![null, '', 'off', ...allowed].includes(c.effort)) throw new OpError('INVALID', `Effort must be one of ${allowed.join(', ')} or off.`);
          o.effort = c.effort || null;
        }
        if (c.api !== undefined) {
          // ChatGPT and Gemini run in the provider's background by default.
          const allowed = { chatgpt: ['background', 'blocking'], gemini: ['interactions', 'generate_content'] }[p];
          if (!allowed) throw new OpError('INVALID', 'Only ChatGPT and Gemini have a choice of API.');
          if (![null, '', ...allowed].includes(c.api)) throw new OpError('INVALID', `API must be one of ${allowed.join(', ')}.`);
          o.api = c.api || null;
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

async function start(ws, { port, open = false, host = '127.0.0.1', quiet = false, hosted = null } = {}) {
  if (hosted) {
    // Only through hosted.js, which refuses to start without a passphrase,
    // a persistent data folder and the host names to answer to.
    if (!hosted.password || !Array.isArray(hosted.hosts) || !hosted.hosts.length || !Number.isInteger(hosted.port)) throw new Error('Hosted mode needs a passphrase, host names and a port (see dashboard/hosted.js).');
    host = hosted.bind || '0.0.0.0';
  } else if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('Refusing to listen on a non-loopback address. Remote access needs authentication: use hosted mode (dashboard/hosted.js).');
  }
  const log = (...a) => {
    if (!quiet) console.log(...a);
  };
  const running = hosted ? null : await existingInstance(ws);
  if (running) {
    log(`Dashboard already running at ${running.url}`);
    if (open) openBrowser(running.url);
    return { already_running: true, url: running.url };
  }

  const token = crypto.randomBytes(24).toString('hex');
  const startPort = hosted ? hosted.port : port || ws.settings.server.port || 4729;
  const server = http.createServer();
  let boundPort = null;
  for (let p = startPort; p < startPort + (hosted ? 1 : 15); p++) {
    try {
      await listen(server, p, host);
      boundPort = server.address().port;
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || hosted) throw err;
    }
  }
  if (!boundPort) throw new Error(`No free port between ${startPort} and ${startPort + 14}`);
  const origin = hosted ? `https://${hosted.hosts[0]}` : `http://127.0.0.1:${boundPort}`;
  const allowedHosts = hosted ? new Set(hosted.hosts.flatMap((h) => [h, `${h}:443`])) : new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]);
  const allowedOrigins = hosted ? new Set(hosted.hosts.map((h) => `https://${h}`)) : new Set([`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`]);
  const auth = hosted ? require('./hosted').makeAuth(ws, hosted) : null;
  if (hosted) {
    // The only process on this disk (leases.js): what an earlier instance
    // held is free now, so research and prices resume at once after a deploy.
    const freed = require('./core/leases').releaseForeignLeases(ws);
    if (freed.length && !quiet) console.log(`Leases left by an earlier instance released: ${freed.join(', ')}.`);
  }
  // The connector for the assistants (Claude in Cowork and claude.ai, ChatGPT,
  // Gemini): OAuth sign-in that Eric approves with his passphrase, then the MCP
  // endpoint at /mcp. Their servers call it without an Origin header; one that
  // sends its own app's origin is accepted too (a bearer token is still needed).
  const oauth = hosted ? require('./oauth').makeOAuth(ws, { origin, auth, log: (...a) => { if (!quiet) console.log(...a); } }) : null;
  const mcpOrigins = new Set([...allowedOrigins, 'https://claude.ai', 'https://chatgpt.com', 'https://gemini.google.com']);
  // A research request from an assistant can queue paid API jobs (other
  // models): the runner picks them up at once instead of at its next tick.
  const mcp = hosted ? require('./mcp').makeMcp(ws, { version: require('./core/revision').revision().short || '1.0.0', rebuild: (areas) => rebuild(areas), log: (...a) => { if (!quiet) console.log(...a); }, kick: () => setTimeout(() => researchTick(), 300) }) : null;
  // The offsite package for this PC's daily pull (CR_BACKUP_KEY, read per request).
  const offsite = hosted ? require('./core/offsite').makeOffsiteRoute(ws, { env: process.env, log: (...a) => { if (!quiet) console.log(...a); } }) : null;
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
    // When a signed-in page last asked for anything (hosted mode).
    lastPageSeen: 0,
    hosted: Boolean(hosted),
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
      // The wallet sync's progress counter changes with every request; the
      // run itself redraws when it ends (walletTick).
      if (rel === 'portfolio/wallets/sync-state.json') return;
      const top = rel.split('/')[0];
      if (!WATCH_TOP.has(top)) return;
      if (top === 'logs' && !/^logs\/(operations\.jsonl|jobs-state\.json|ingestion-state\.json|review-findings\.json|requests\/)/.test(rel)) return;
      if (top === 'market-data' && /^market-data\/(observations|logos)\//.test(rel)) return;
      // Research requests (inbox/intake) are not report files to import.
      if (rel.startsWith(`${intake.DIR}/`)) return;
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
    ['logs/operations.jsonl', 'logs/jobs-state.json', 'logs/ingestion-state.json', 'market-data/status.json', 'market-data/latest.json', 'market-data/fundamentals/status.json', 'market-data/screening/status.json', 'config/settings.json', 'portfolio/transactions.json', 'portfolio/accounts.json', 'portfolio/limits.json', 'portfolio/events.json', 'portfolio/wallets/registry.json'].forEach(add);
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
  // On the PC the server runs only while Eric has it open. Hosted, it runs
  // all day: prices refresh at the foreground interval only while a page is
  // open, and hourly otherwise, so the CoinGecko call budget lasts the month.
  const pageOpen = () => !hosted || Date.now() - state.lastPageSeen < PAGE_OPEN_MS;
  async function marketTick(force = false) {
    if (!ws.settings.market_data.enabled) return null;
    try {
      if (force) return await market.refresh(ws, { trigger: 'dashboard', force: true });
      const foreground = pageOpen();
      if (!jobs.marketDue(ws, Date.now(), { foreground })) return null;
      return await jobs.runJob(ws, 'market', { trigger: foreground ? 'dashboard' : 'hosted' });
    } catch (err) {
      console.error('Market refresh failed:', err.message);
      return null;
    }
  }
  let researchRunning = false;
  let researchAgain = false;
  let researchSoon = null;
  async function researchTick() {
    if (researchRunning) {
      researchAgain = true;
      return;
    }
    researchRunning = true;
    try {
      do {
        researchAgain = false;
        const out = await jobs.runJob(ws, 'research', { trigger: 'dashboard', onlyDue: true });
        if (out && !['noop', 'not_due', 'busy'].includes(out.status)) rebuild(['research']);
        // Research requests follow their run: done, failed, or queued again.
        try {
          if (intake.settle(ws).length) rebuild(['intake']);
        } catch (err) {
          console.error('Research request update failed:', err.message);
        }
      } while (researchAgain);
    } catch (err) {
      console.error('Research jobs failed:', err.message);
    } finally {
      researchRunning = false;
    }
    // A ChatGPT or Gemini request running on the provider's side is checked
    // every 30 seconds, so its report appears soon after it is written.
    try {
      if (!researchSoon && research.hasBackgroundWork(ws)) {
        researchSoon = setTimeout(() => {
          researchSoon = null;
          researchTick();
        }, backgroundCheckMs());
        if (researchSoon.unref) researchSoon.unref();
      }
    } catch (_) { /* the 2-minute timer still runs */ }
  }
  // Identifying research requests, one at a time, in the background. Requests
  // still being identified when the server stopped are picked up again; an
  // interrupted paid screenshot read is held, never repeated (intake.js).
  const identifyQueue = new Set();
  let identifying = null;
  async function identifyTick() {
    if (identifying) return;
    try {
      for (;;) {
        const next = [...identifyQueue][0];
        if (!next) break;
        identifyQueue.delete(next);
        identifying = next;
        try {
          await intake.identify(ws, next);
        } catch (err) {
          console.error(`Identifying ${next} failed:`, err.message);
        }
        identifying = null;
      }
    } finally {
      identifying = null;
    }
  }
  function queueIdentify(id) {
    if (id !== identifying) identifyQueue.add(id);
    setTimeout(() => identifyTick(), 20);
  }
  function sweepIntake() {
    try {
      for (const id of intake.pendingIdentify(ws)) queueIdentify(id);
    } catch (err) {
      console.error('Research request check failed:', err.message);
    }
  }
  // Tracked wallets (walletsync.js): checked every minute, read only when a
  // network is due (its interval, or Sync now) and a Moralis key is set. One
  // run at a time in this process, one lease across processes; a request that
  // arrives while a run is going joins the next one. Viewing a page never
  // starts a sync.
  let walletRunning = false;
  let walletAgain = false;
  async function walletTick() {
    if (walletRunning) {
      walletAgain = true;
      return;
    }
    walletRunning = true;
    try {
      do {
        walletAgain = false;
        if (!jobs.isDue(ws, 'wallets', jobs.readJobState(ws))) break;
        const out = await jobs.runJob(ws, 'wallets', { trigger: hosted ? 'hosted' : 'dashboard', onlyDue: true });
        if (out && !['noop', 'not_due', 'busy', 'skipped'].includes(out.status)) rebuild(['portfolio']);
      } while (walletAgain);
    } catch (err) {
      console.error('Wallet sync failed:', err.message);
    } finally {
      walletRunning = false;
    }
  }
  const marketTimer = setInterval(() => marketTick(false), 60000);
  const walletTimer = setInterval(() => walletTick(), 60000);
  const researchTimer = setInterval(() => researchTick(), 2 * 60000);
  const intakeTimer = setInterval(() => sweepIntake(), 60000);
  // DefiLlama fundamentals ride along: due per project every 12 hours, under
  // the lease, gate and backoff they share with the scheduled task and the CLI.
  const dailyTimer = setInterval(() => jobs.runJobs(ws, ['snapshot', 'reviews', 'backup', 'fundamentals', 'screening'], { trigger: 'dashboard', onlyDue: true }).catch(() => {}), 30 * 60000);

  const api = makeApi({ ws, state, token, rebuild, marketTick, researchTick, walletTick, queueIdentify, clients, sockets, oauth });

  server.on('request', async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Hosted: same-origin, because under no-referrer a browser sends
    // "Origin: null" on a form post (sign-in, sign-out). No referrer ever
    // goes to another site either way.
    res.setHeader('Referrer-Policy', hosted ? 'same-origin' : 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', CSP);
    if (hosted) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      // Render's health check: that the process answers, and which deployed
      // revision it runs (a commit ID, nothing else), so a review can tell
      // the running code from the repository without signing in.
      if (hosted && req.url === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
        const rev = require('./core/revision').revision();
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(req.method === 'HEAD' ? undefined : `ok\nrevision ${rev.commit || 'unknown'}${rev.branch ? ` (${rev.branch})` : ''}\nstarted ${rev.started_at}\n`);
      }
      const hostHeader = String(req.headers.host || '').toLowerCase();
      if (!allowedHosts.has(hostHeader)) throw new HttpError(403, 'Host not allowed');
      const url = new URL(req.url, origin);
      const bucket = url.pathname.startsWith('/api/') ? (['/api/version', '/api/index', '/api/events', '/api/session', '/api/health'].includes(url.pathname) ? url.pathname : '/api/(other)') : '(static)';
      state.stats.requests[bucket] = (state.stats.requests[bucket] || 0) + 1;
      if (oauth) {
        // The connector has its own sign-in (OAuth) and never uses the
        // dashboard's session cookie.
        if (await oauth.handle(req, res, url)) return;
        if (url.pathname === '/mcp' || url.pathname === '/mcp/') {
          const o = req.headers.origin;
          if (o && !mcpOrigins.has(o)) {
            if (!quiet) console.log(`MCP request refused: Origin ${String(o).slice(0, 80)} is not allowed`);
            throw new HttpError(403, 'Origin not allowed');
          }
          const who = oauth.authenticate(req);
          if (!who) return oauth.challenge(res, { invalid: Boolean(req.headers.authorization) });
          return await mcp(req, res, who);
        }
      }
      // Offsite backup (core/offsite.js): the PC pulls a complete package with
      // the desk's own backup key, never the sign-in, and can change nothing.
      if (offsite && url.pathname === '/api/offsite/package') return offsite(req, res);
      if (auth) {
        // Sign-in comes before everything else in hosted mode.
        if (await auth.handle(req, res, url)) return;
        if (!auth.authorized(req)) {
          if (LOGIN_ASSETS.has(url.pathname)) return serveStatic(req, res, url);
          if (url.pathname.startsWith('/api/')) throw new HttpError(401, 'Signed out. Reload the page to sign in again.');
          return auth.redirectToLogin(res);
        }
        state.lastPageSeen = Date.now();
      }
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
  const serverInfo = { pid: process.pid, port: boundPort, url: `${origin}/`, started_at: new Date().toISOString(), workspace_id: ws.meta.workspace_id, host, host_name: os.hostname(), node: process.version, hosted: Boolean(hosted) };
  replaceFile(ws, ws.abs('.cr/server.json'), jsonText(serverInfo));
  scheduleInbox(200);
  const startupTimers = [
    setTimeout(() => marketTick(false), 1500),
    setTimeout(() => sweepIntake(), 2500),
    setTimeout(() => researchTick(), 5000),
    setTimeout(() => jobs.runJobs(ws, ['snapshot', 'reviews', 'backup', 'fundamentals', 'screening'], { trigger: 'dashboard', onlyDue: true }).catch(() => {}), 8000),
    setTimeout(() => walletTick(), 12000),
  ];

  const onSignal = () => stop(0);
  const shutdown = () => {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    startupTimers.forEach(clearTimeout);
    clearTimeout(inboxTimer);
    clearTimeout(rebuildTimer);
    clearTimeout(rebuildRetry);
    clearInterval(pollTimer);
    clearInterval(marketTimer);
    clearInterval(walletTimer);
    clearInterval(researchTimer);
    clearTimeout(researchSoon);
    clearInterval(intakeTimer);
    clearInterval(dailyTimer);
    if (watcher) watcher.close();
    try {
      const cur = readJson(ws.abs('.cr/server.json'), null);
      if (cur && cur.pid === process.pid) fs.unlinkSync(ws.abs('.cr/server.json'));
    } catch (_) { /* ignore */ }
    for (const c of clients) c.end();
    server.close();
  };
  // A deploy or restart stops the process. Work in progress is given a short
  // grace period: a research answer that arrives in time is captured and saved;
  // one that does not is held as uncertain on the next start, never resent.
  const stop = (code) => {
    shutdown();
    if (!hosted || (!researchRunning && !identifying)) process.exit(code);
    const until = Date.now() + 25000;
    const wait = setInterval(() => {
      if ((!researchRunning && !identifying) || Date.now() > until) {
        clearInterval(wait);
        process.exit(code);
      }
    }, 250);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  log('');
  if (hosted) {
    log(`CryptoResearch (hosted): ${origin}/`);
    log(`Data folder: ${ws.root}${ws.kind !== 'real' ? `  [${ws.kind.toUpperCase()} WORKSPACE - FICTIONAL DATA]` : ''}`);
    log(`Node ${process.version}. Listening on port ${boundPort} behind HTTPS; sign-in required for everything except /healthz.`);
  } else {
    log(`CryptoResearch dashboard: ${origin}/`);
    log(`Workspace: ${ws.root}${ws.kind !== 'real' ? `  [${ws.kind.toUpperCase()} WORKSPACE - FICTIONAL DATA]` : ''}`);
    log(`Node ${process.version}. Listening on 127.0.0.1 only. Close this window (or press Ctrl+C) to stop the dashboard.`);
  }
  if (open && !hosted) openBrowser(`${origin}/`);
  return { url: `${origin}/`, port: boundPort, token, server, shutdown, state, queueIdentify, researchTick };
}

function makeApi({ ws, state, token, rebuild, marketTick, researchTick, walletTick = () => {}, queueIdentify, clients, sockets, oauth = null }) {
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
  route('GET', '/api/projects/([^/]+)/research/([^/]+)/prompt', (m, req, res, body, url) => {
    const id = pid(m[1]);
    const run = research.loadRun(ws, id, runId(m[2]));
    if (!run) throw new HttpError(404, 'No such research run');
    const prompt = fs.readFileSync(ws.abs(run.prompt.path), 'utf8');
    // ?provider=chatgpt: what that model is given to paste by hand, its frozen
    // execution note first (core/execution.js), then the unchanged prompt.
    // Without a provider, or for a model with no note: the prompt alone.
    const who = url && url.searchParams ? url.searchParams.get('provider') : null;
    const note = who && PROVIDERS.includes(who) ? require('./core/execution').readNote(ws, run, who) : null;
    if (note && note.delivery.status !== 'verified') throw new HttpError(409, note.delivery.message);
    const text = note ? `${note.text}\n\n---\n\n${prompt}` : prompt;
    return { _raw: text, _type: 'text/plain; charset=utf-8' };
  });
  // The text an attempt's answer wrote before it stopped: read-only, checked
  // against the saved response, never a report.
  route('GET', '/api/projects/([^/]+)/research/([^/]+)/jobs/([a-z]+)/attempts/(\\d{1,3})/partial', (m) => {
    const out = research.partialOutput(ws, pid(m[1]), runId(m[2]), provider(m[3]), Number(m[4]));
    return { _raw: out.text, _type: 'text/plain; charset=utf-8' };
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
  route('GET', '/api/backup-status', () => require('./core/offsite').backupStatus(ws));
  route('GET', '/api/backups/([A-Za-z0-9_-]+)/verify', (m) => exporter.verifyBackup(ws, m[1]));
  // A status read writes nothing; the write test is its own explicit action.
  // The Research Explorer (core/explorer.js): this server reads Supabase with
  // a key the page never sees, behind the same sign-in and token as every
  // other route. A read only: it never writes, screens or starts research.
  route('GET', '/api/explorer', (m, req, res, body, url) => require('./core/explorer').read(ws, { refresh: url.searchParams.get('refresh') === '1' }));
  // Second opinion: one project's reports and category grades, every row.
  route('GET', '/api/explorer/compare', (m, req, res, body, url) => require('./core/explorer').compareData(ws, String(url.searchParams.get('project') || '')));
  route('GET', '/api/doctor', async () => require('./core/doctor').doctor(ws));
  route('POST', '/api/doctor/write-test', async () => require('./core/doctor').doctor(ws, { writeProbe: true }));
  route('GET', '/api/research/providers', () => coherent(() => ({ providers: research.providerStatus(ws), readiness: research.readiness(ws), budget: ws.settings.research.budget, spend: research.spendSoFar(ws), unattended_enabled: Boolean(ws.settings.research.unattended_enabled), keys_file: require('./core/providers').secretsFile() })));

  // Research requests: a link, name or screenshot plus optional instructions.
  // Saved first, identified in the background, researched once Eric confirms
  // the candidate. Progress comes from the request and its research run.
  const inId = (id) => {
    if (!intake.isIntakeId(id)) throw new HttpError(400, 'Invalid request ID');
    return id;
  };
  const deskStatus = () => {
    const st = research.providerStatus(ws).claude;
    const plan = research.callBounds(ws, 'claude');
    return {
      claude: { mode: st.mode, reason: st.reason || null, model: st.model || (ws.settings.research.providers.claude || {}).model || null, missing: st.missing || [] },
      budget: ws.settings.research.budget,
      spend: research.spendSoFar(ws),
      bounds: plan.ok ? { max_output_tokens: plan.max_output_tokens, max_searches: plan.search.limit, requests_max: plan.requests_max, effort: plan.effort } : null,
      screenshot_reservation_usd: intake.readReservation(ws),
      default_horizon: ws.settings.research.default_horizon,
    };
  };
  route('GET', '/api/intake', () => coherent(() => ({ intakes: intake.listIntakes(ws, { limit: 30 }).map((d) => intake.progressOf(ws, d)), desk: deskStatus() })));
  route('GET', '/api/intake/(in_[^/]+)', (m) => coherent(() => ({ intake: intake.progressOf(ws, intake.readIntake(ws, inId(m[1]))), desk: deskStatus() })));
  route('GET', '/api/intake/(in_[^/]+)/screenshot', (m) => {
    const doc = intake.readIntake(ws, inId(m[1]));
    if (!doc.input.screenshot) throw new HttpError(404, 'No screenshot');
    return { _raw: fs.readFileSync(ws.abs(doc.input.screenshot.file)), _type: doc.input.screenshot.media_type, _extra: { 'Cache-Control': 'private, max-age=3600' } };
  });
  route('POST', '/api/intake', (m, req, res, body) => {
    const shot = body.screenshot && typeof body.screenshot === 'object' ? { media_type: String(body.screenshot.media_type || ''), data_base64: String(body.screenshot.data_base64 || '') } : null;
    const out = once(body, () => intake.createIntake(ws, { link: typeof body.link === 'string' ? body.link : null, screenshot: shot, instructions: typeof body.instructions === 'string' ? body.instructions : null }));
    if (out.intake && out.intake.status === 'identifying') queueIdentify(out.intake.intake_id);
    return { status: out.status, message: out.message || null, intake: intake.progressOf(ws, out.intake) };
  });
  route('POST', '/api/intake/(in_[^/]+)/confirm', (m, req, res, body) => {
    const out = intake.confirmIntake(ws, inId(m[1]), { coingecko_id: String(body.coingecko_id || ''), sector: typeof body.sector === 'string' && body.sector ? body.sector : null, different_project: body.different_project === true });
    setTimeout(() => researchTick(), 300);
    return after({ status: out.status, project_id: out.project_id, run_id: out.run_id, intake: intake.progressOf(ws, out.intake) });
  });
  route('POST', '/api/intake/(in_[^/]+)/retry-identity', (m) => {
    const doc = intake.retryIdentify(ws, inId(m[1]));
    queueIdentify(doc.intake_id);
    return { status: 'saved', intake: intake.progressOf(ws, doc) };
  });
  route('POST', '/api/intake/(in_[^/]+)/retry-research', (m) => {
    const out = intake.retryResearch(ws, inId(m[1]));
    setTimeout(() => researchTick(), 300);
    return after({ status: out.status, message: out.message, intake: intake.progressOf(ws, out.intake) });
  });
  route('POST', '/api/intake/(in_[^/]+)/dismiss', (m) => ({ status: 'saved', intake: intake.progressOf(ws, intake.dismissIntake(ws, inId(m[1]))) }));

  // Settings > Connected apps: the Claude connections Eric approved.
  route('GET', '/api/connections', () => ({ available: Boolean(oauth), mcp_url: oauth ? oauth.resource : null, connections: oauth ? oauth.connections() : [] }));
  route('POST', '/api/connections/(grant_[A-Za-z0-9_-]{4,40})/revoke', (m) => {
    if (!oauth || !oauth.revoke(m[1])) throw new HttpError(404, 'No such connection');
    return { status: 'saved', message: 'Disconnected. Claude can no longer use the desk through that connection.' };
  });

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
  route('POST', '/api/projects/([^/]+)/archive', (m, req, res, body) => after(projects.archiveProject(ws, pid(m[1]), typeof body.reason === 'string' ? body.reason.slice(0, 300) : null)));
  route('POST', '/api/projects/([^/]+)/restore', (m) => after(projects.restoreProject(ws, pid(m[1]))));
  route('POST', '/api/projects/([^/]+)/fields', (m, req, res, body) => after(projects.updateProjectFields(ws, pid(m[1]), body)));
  route('POST', '/api/projects/([^/]+)/reviewed', (m, req, res, body) => after(projects.markReviewed(ws, pid(m[1]), { note: body.note || null })));
  // Undo of one mark-reviewed (the cursor it replaced, while it is still the latest).
  route('POST', '/api/projects/([^/]+)/reviewed/undo', (m, req, res, body) => after(projects.restoreReview(ws, pid(m[1]), { previous: body.previous === undefined ? null : body.previous, expect: body.expect || null })));
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
  route('POST', '/api/portfolio/transactions/([^/]+)/correct', (m, req, res, body) => after(portfolio.correctTransaction(ws, rid(m[1]), body.transaction && typeof body.transaction === 'object' ? body.transaction : {}, body.reason)));
  route('POST', '/api/portfolio/csv', (m, req, res, body) => after(portfolio.importCsv(ws, String(body.csv || ''), { filename: body.filename || 'dashboard.csv', defaultAccount: body.account_id || null, allowIdentical: Boolean(body.allow_identical) })));
  route('POST', '/api/portfolio/accounts', (m, req, res, body) => after(portfolio.addAccount(ws, body)));
  // Tracked wallets (core/wallets.js, core/walletsync.js): public addresses,
  // read-only. Reading never syncs; Sync now and a new wallet join the same
  // queue the one-minute check runs, under the same limits.
  const walletsCore = require('./core/wallets');
  route('GET', '/api/wallets', () => coherent(() => walletsCore.overview(ws, { market: market.readLatest(ws) })));
  route('POST', '/api/wallets', (m, req, res, body) => once(body, () => {
    const out = walletsCore.addWallet(ws, { label: body.label, address: body.address, networks: body.networks, account_id: typeof body.account_id === 'string' && body.account_id ? body.account_id : null });
    if (out.status === 'saved') setTimeout(() => walletTick(), 1000);
    return after(out);
  }));
  route('POST', '/api/wallets/(w_[a-z2-9]{10})/(pause|resume|remove|sync|networks)', (m, req, res, body) => {
    const id = m[1];
    if (m[2] === 'sync') {
      const out = require('./core/walletsync').requestSync(ws, id);
      if (out.status === 'queued') setTimeout(() => walletTick(), 300);
      return out;
    }
    if (m[2] === 'pause') return after(walletsCore.pauseWallet(ws, id));
    if (m[2] === 'resume') return after(walletsCore.resumeWallet(ws, id));
    if (m[2] === 'networks') return after(walletsCore.setWalletNetworks(ws, id, body.networks));
    return after(walletsCore.removeWallet(ws, id, typeof body.reason === 'string' ? body.reason : null));
  });
  // Eric's decision on a held wallet event, applied to the ledger at once (no
  // network involved).
  route('POST', '/api/wallets/events/resolve', (m, req, res, body) => {
    const out = walletsCore.resolveEvent(ws, { wallet_id: String(body.wallet_id || ''), network: String(body.network || ''), event_key: String(body.event_key || ''), decision: body.decision, note: typeof body.note === 'string' ? body.note : null });
    const ledger = walletsCore.importReady(ws);
    return after({ ...out, ledger: { status: ledger.status, recorded: ledger.recorded, held: ledger.held } });
  });
  route('POST', '/api/portfolio/limits', (m, req, res, body) => after(portfolio.setLimits(ws, body)));
  // A refresh within a minute of the last successful one returns the saved
  // status without calling CoinGecko, so repeated presses or reloads never
  // spend the call budget.
  route('POST', '/api/market/refresh', async () => {
    const st = market.freshness(ws);
    const last = st.last_success_at ? Date.parse(st.last_success_at) : NaN;
    if (Number.isFinite(last) && Date.now() - last < MANUAL_REFRESH_MIN_MS) {
      return { result: { status: 'noop', message: `Prices were refreshed ${Math.max(1, Math.round((Date.now() - last) / 1000))} s ago; not asked again within a minute.` }, status: st };
    }
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
      return send(res, 200, { token, hosted: state.hosted, revision: require('./core/revision').revision(), workspace: { name: ws.meta.name, kind: ws.kind, root: state.hosted ? null : ws.root, workspace_id: ws.meta.workspace_id }, explorer: require('./core/explorer').navInfo(ws, { hosted: Boolean(state.hosted) }) });
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
