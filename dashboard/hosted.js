'use strict';
// Hosted mode: the same dashboard as a private web app on Render, reachable
// from Eric's phone.
//
// It refuses to start (fails closed) unless all of this is true:
//   CR_DATA_DIR          an absolute folder on a persistent disk, outside the code
//                        (Render: a disk mounted at /var/data, CR_DATA_DIR=/var/data/cryptoresearch)
//   CR_ACCESS_PASSWORD   Eric's passphrase, at least 12 characters (set in Render's
//                        Environment page; never in the code or the browser)
//   PORT                 set by Render
//   RENDER_EXTERNAL_HOSTNAME or CR_ALLOWED_HOSTS   the host names the app answers to
// Research keys come from the environment too (ANTHROPIC_API_KEY); they are
// never written to the disk, logs, exports or the page.
//
// Access: one passphrase, a signed-in session cookie (HttpOnly, Secure,
// SameSite=Strict, 30 days, kept across restarts in .cr/sessions.json as
// hashes only), failed sign-ins limited per address. Every API call still needs
// the page's session token and a same-origin request, as on the PC.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJson, jsonText, mkdirp, atomicWrite } = require('./core/fsx');

const CODE_DIR = path.resolve(__dirname, '..');
const SESSIONS_REL = '.cr/sessions.json';
const SESSION_DAYS = 30;
const FAIL_WINDOW_MS = 15 * 60000;
const MAX_FAILS_PER_ADDRESS = 8;
// Bounds guessing spread over many addresses (the forwarded address is only
// what the client claims), at the cost of a short lockout for everyone.
const MAX_FAILS_TOTAL = 100;

// Proposed starting limits and model settings for the hosted desk, written once
// on first boot; Eric changes them in Settings afterwards. Prices are Anthropic's
// list prices for claude-opus-5-5 (Claude API documentation, October 2026):
// $4 / $20 per million input / output tokens, $5 per million 5-minute cache
// writes, $0.20 per million cache reads, and $10 per 1,000 web searches.
const HOSTED_DEFAULTS_VERSION = 2;
const HOSTED_DEFAULTS = {
  market_data: { enabled: true },
  research: {
    default_providers: ['claude'],
    // A full report is about 16,000 tokens of text, plus Claude's thinking,
    // which counts toward the same limit; each request is streamed.
    max_output_tokens: 48000,
    max_continuations: 2,
    effort: 'high',
    timeout_seconds: 1500,
    providers: {
      claude: { model: 'claude-opus-5-5', input_usd_per_mtok: 4, output_usd_per_mtok: 20, cache_write_usd_per_mtok: 5, cache_read_usd_per_mtok: 0.2, search_usd_per_call: 0.01, max_searches: 8 },
    },
    // One attempt reserves about $3.80 at these bounds (most of it the output
    // ceiling); a typical run costs far less, and its recorded cost replaces
    // the reservation.
    budget: { per_run_usd: 5, daily_usd: 10, monthly_usd: 40 },
  },
};
const DEFAULTS_NOTE = 'Proposed limits for the online desk: claude-opus-5-5 with web search, up to 48,000 output tokens per request, $5 per run, $10 per day, $40 per month. Change them in Settings > Research models & budget.';

// Defaults that an earlier version wrote are moved to the current ones on
// start, but only where the value is still exactly what that version wrote:
// anything Eric changed stays as he set it.
const DEFAULT_UPGRADES = {
  // v1 (2026-10-02) capped output at 16,000 tokens, too little for a full report.
  2: [
    ['research.max_output_tokens', 16000, 48000],
    ['research.timeout_seconds', undefined, 1500],
    ['research.providers.claude.max_searches', 10, 8],
    ['research.budget.per_run_usd', 4, 5],
    ['research.budget.daily_usd', 8, 10],
    ['research.budget.monthly_usd', 30, 40],
  ],
};

const getPath = (o, p) => p.split('.').reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), o);
function setPath(o, p, v) {
  const keys = p.split('.');
  let x = o;
  for (const k of keys.slice(0, -1)) {
    if (!x[k] || typeof x[k] !== 'object') x[k] = {};
    x = x[k];
  }
  x[keys[keys.length - 1]] = v;
}

// The mount that holds a path, from the kernel's mount table (Linux): the
// longest mount point that contains it. null when the table cannot be read.
function containingMount(target, mountsText = null) {
  let text = mountsText;
  if (text === null) {
    try {
      text = fs.readFileSync('/proc/self/mounts', 'utf8');
    } catch (_) {
      return null;
    }
  }
  const abs = path.posix.resolve(String(target).replace(/\\/g, '/'));
  let best = null;
  for (const line of text.split('\n')) {
    const f = line.split(' ');
    if (f.length < 3 || !f[1].startsWith('/')) continue;
    const point = f[1].replace(/\\040/g, ' ').replace(/\\011/g, '\t').replace(/\\134/g, '\\');
    const rel = path.posix.relative(point, abs);
    const inside = rel === '' || (!rel.startsWith('..') && !path.posix.isAbsolute(rel));
    if (inside && (!best || point.length > best.point.length)) best = { point, type: f[2], source: f[0] };
  }
  return best;
}

// Records need a disk that survives deploys: on Render, a persistent disk
// mounted at its own mount point (for example /var/data). A folder that is
// merely present (Render's free instances have /var/data too) is the
// container's own filesystem, which every deploy and restart replaces.
function persistentDiskProblem(dataDir, { platform = process.platform, mountsText = null, codeDir = CODE_DIR } = {}) {
  if (platform !== 'linux') return null;
  const m = containingMount(dataDir, mountsText);
  if (!m) return 'The mount table (/proc/self/mounts) could not be read, so the persistent disk cannot be confirmed.';
  const code = containingMount(codeDir, mountsText);
  if (m.point === '/' || ['overlay', 'tmpfs', 'ramfs', 'devtmpfs', 'proc', 'sysfs'].includes(m.type) || (code && code.point === m.point)) {
    return `${dataDir} is not on a persistent disk (it is on ${m.point}, ${m.type}). Add a disk in Render with mount path ${path.posix.dirname(dataDir)}; the desk does not start until records would survive a deploy.`;
  }
  return null;
}

function hostedConfig(env = process.env, { platform = process.platform, mountsText = null } = {}) {
  const problems = [];
  const dataDir = env.CR_DATA_DIR ? path.resolve(env.CR_DATA_DIR) : null;
  let disk = null;
  if (!dataDir) problems.push('CR_DATA_DIR is not set. Add a persistent disk (for example mounted at /var/data) and set CR_DATA_DIR=/var/data/cryptoresearch.');
  else {
    if (!path.isAbsolute(env.CR_DATA_DIR)) problems.push('CR_DATA_DIR must be an absolute path on the persistent disk.');
    const rel = path.relative(CODE_DIR, dataDir);
    if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) problems.push('CR_DATA_DIR is inside the code folder, which is replaced on every deploy. Use the persistent disk instead.');
    const mount = path.dirname(dataDir);
    if (!fs.existsSync(mount)) problems.push(`The persistent disk is not mounted: ${mount} does not exist. Add a disk in Render (mount path ${mount}).`);
    else {
      const p = persistentDiskProblem(dataDir, { platform, mountsText });
      if (p) problems.push(p);
      else if (platform === 'linux') disk = containingMount(dataDir, mountsText);
    }
  }
  const password = env.CR_ACCESS_PASSWORD || '';
  if (password.length < 12) problems.push('CR_ACCESS_PASSWORD is missing or shorter than 12 characters. Set a passphrase in Render\'s Environment page.');
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('PORT is not set (Render sets it).');
  const hosts = [...new Set([env.RENDER_EXTERNAL_HOSTNAME, ...String(env.CR_ALLOWED_HOSTS || '').split(',')].map((h) => String(h || '').trim().toLowerCase()).filter((h) => /^[a-z0-9.-]{3,253}$/.test(h)))];
  if (!hosts.length) problems.push('No host name: RENDER_EXTERNAL_HOSTNAME (set by Render) or CR_ALLOWED_HOSTS is needed.');
  return { dataDir, password, port, hosts, problems, disk };
}

// Copies the code's templates into the data folder (prompts, rubrics, schemas),
// so a deploy updates them. Files that exist only on the disk are kept.
function syncTemplates(dataDir) {
  const from = path.join(CODE_DIR, 'templates');
  const to = path.join(dataDir, 'templates');
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(from, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) {
        const src = fs.readFileSync(path.join(from, r));
        const dest = path.join(to, r);
        let same = false;
        try { same = fs.readFileSync(dest).equals(src); } catch (_) { same = false; }
        if (!same) {
          mkdirp(path.dirname(dest));
          atomicWrite(dest, src);
        }
      }
    }
  };
  walk('');
}

function mergeMissing(target, defaults) {
  const out = { ...target };
  for (const [k, v] of Object.entries(defaults)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = mergeMissing(target && typeof target[k] === 'object' ? target[k] : {}, v);
    else if (out[k] === undefined || out[k] === null) out[k] = v;
  }
  return out;
}

function prepareWorkspace(cfg) {
  const { initWorkspace, openWorkspace } = require('./core/workspace');
  mkdirp(cfg.dataDir);
  const fresh = !fs.existsSync(path.join(cfg.dataDir, 'workspace.json'));
  if (fresh) initWorkspace(cfg.dataDir, { kind: 'real', name: 'CryptoResearch', templatesFrom: path.join(CODE_DIR, 'templates') });
  syncTemplates(cfg.dataDir);
  const settingsFile = path.join(cfg.dataDir, 'config', 'settings.json');
  let doc = readJson(settingsFile, { schema_version: 1 });
  const now = new Date().toISOString();
  let changed = false;
  if (!doc.hosted_defaults_applied_at) {
    doc = { ...mergeMissing(doc, HOSTED_DEFAULTS), hosted_defaults_applied_at: now, hosted_defaults_version: HOSTED_DEFAULTS_VERSION, hosted_defaults_note: DEFAULTS_NOTE };
    changed = true;
  } else {
    for (let v = (doc.hosted_defaults_version || 1) + 1; v <= HOSTED_DEFAULTS_VERSION; v++) {
      const moved = [];
      for (const [p, from, to] of DEFAULT_UPGRADES[v] || []) {
        if (getPath(doc, p) === from) {
          setPath(doc, p, to);
          moved.push({ setting: p, from: from === undefined ? null : from, to });
        }
      }
      doc.hosted_defaults_version = v;
      doc.hosted_defaults_upgrades = [...(doc.hosted_defaults_upgrades || []), { version: v, at: now, changed: moved }];
      doc.hosted_defaults_note = DEFAULTS_NOTE;
      changed = true;
    }
  }
  if (changed) {
    mkdirp(path.dirname(settingsFile));
    atomicWrite(settingsFile, jsonText(doc));
  }
  return openWorkspace({ root: cfg.dataDir, actor: 'hosted' });
}

// ---------------------------------------------------------------------------
// Sign-in

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();
const hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function clientAddress(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function readForm(req, max = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(Object.assign(new Error('Too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

function loginPage({ error = null, locked = false } = {}) {
  const msg = locked
    ? '<p class="callout bad" role="alert">Too many attempts. Wait a few minutes, then try again.</p>'
    : error ? '<p class="callout bad" role="alert">That passphrase is not right.</p>' : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in · CryptoResearch</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/position.css"></head><body><main class="login-wrap"><form class="card login-card" method="post" action="/login"><h1>CryptoResearch</h1><p class="muted">Private research desk. Sign in with your passphrase.</p>${msg}<label class="field"><span class="field-label">Passphrase</span><input type="password" name="password" autocomplete="current-password" required autofocus></label><div class="btn-row"><button class="btn primary" type="submit">Sign in</button></div></form></main></body></html>`;
}

function makeAuth(ws, { password, hosts, failDelayMs = 600 }) {
  const want = hash(password);
  const origins = new Set(hosts.map((h) => `https://${h}`));
  const fails = [];
  let sessions = readJson(ws.abs(SESSIONS_REL), { schema_version: 'cr.sessions.v1', sessions: {} });
  const save = () => {
    const now = Date.now();
    for (const [k, s] of Object.entries(sessions.sessions)) if (Date.parse(s.expires_at) < now) delete sessions.sessions[k];
    mkdirp(path.dirname(ws.abs(SESSIONS_REL)));
    atomicWrite(ws.abs(SESSIONS_REL), jsonText(sessions));
  };
  const recentFails = (addr) => {
    const cut = Date.now() - FAIL_WINDOW_MS;
    while (fails.length && fails[0].at < cut) fails.shift();
    return { address: fails.filter((f) => f.addr === addr).length, total: fails.length };
  };
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  };
  const cookie = (token, maxAge) => `cr_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
  // A form post from this site's own pages. Browsers send the page's origin,
  // or "null" when that page had a no-referrer policy (sign-in pages served
  // before 2026-10-03 did); then the browser's fetch metadata decides
  // (Sec-Fetch-Site: same-origin). Anything that says it comes from another
  // site is refused. The passphrase itself is the real protection.
  const fromThisSite = (req) => {
    const o = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin') return false;
    if (o && o !== 'null') return origins.has(o);
    return true;
  };

  function sessionOf(req) {
    const token = parseCookies(req.headers.cookie).cr_session;
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const s = sessions.sessions[hex(token)];
    if (!s || Date.parse(s.expires_at) < Date.now()) return null;
    return s;
  }

  // One passphrase check for every page that asks for it (sign-in, approving
  // a Claude connection), with one shared limit on failed attempts.
  async function verifyPassphrase(req, given) {
    const addr = clientAddress(req);
    const n = recentFails(addr);
    if (n.address >= MAX_FAILS_PER_ADDRESS || n.total >= MAX_FAILS_TOTAL) return { ok: false, locked: true };
    if (crypto.timingSafeEqual(hash(given || ''), want)) return { ok: true, locked: false };
    fails.push({ at: Date.now(), addr });
    await new Promise((r) => setTimeout(r, failDelayMs));
    return { ok: false, locked: false };
  }

  return {
    authorized(req) {
      return Boolean(sessionOf(req));
    },
    fromThisSite,
    verifyPassphrase,
    redirectToLogin(res) {
      send(res, 303, '', { Location: '/login' });
    },
    // Handles /login and /logout; returns true when it answered the request.
    async handle(req, res, url) {
      if (url.pathname === '/login' && req.method === 'GET') {
        if (sessionOf(req)) { send(res, 303, '', { Location: '/' }); return true; }
        send(res, 200, loginPage({ error: url.searchParams.get('e') === '1', locked: url.searchParams.get('e') === 'locked' }));
        return true;
      }
      if (url.pathname === '/login' && req.method === 'POST') {
        if (!fromThisSite(req)) { send(res, 403, 'Sign-in is only accepted from this site\'s own sign-in page. Open /login on this site and try again.'); return true; }
        const n = recentFails(clientAddress(req));
        if (n.address >= MAX_FAILS_PER_ADDRESS || n.total >= MAX_FAILS_TOTAL) { send(res, 303, '', { Location: '/login?e=locked' }); return true; }
        const form = await readForm(req);
        const check = await verifyPassphrase(req, form.get('password') || '');
        if (!check.ok) {
          send(res, 303, '', { Location: check.locked ? '/login?e=locked' : '/login?e=1' });
          return true;
        }
        const token = crypto.randomBytes(32).toString('hex');
        const now = new Date();
        sessions.sessions[hex(token)] = { created_at: now.toISOString(), expires_at: new Date(now.getTime() + SESSION_DAYS * 86400000).toISOString(), user_agent: String(req.headers['user-agent'] || '').slice(0, 160) };
        save();
        send(res, 303, '', { Location: '/', 'Set-Cookie': cookie(token, SESSION_DAYS * 86400) });
        return true;
      }
      if (url.pathname === '/logout' && req.method === 'POST') {
        if (!fromThisSite(req)) { send(res, 403, 'Sign-out is only accepted from this site.'); return true; }
        const token = parseCookies(req.headers.cookie).cr_session;
        if (token && /^[a-f0-9]{64}$/.test(token) && sessions.sessions[hex(token)]) {
          delete sessions.sessions[hex(token)];
          save();
        }
        send(res, 303, '', { Location: '/login', 'Set-Cookie': cookie('', 0) });
        return true;
      }
      return false;
    },
  };
}

// While the desk is not configured, the service answers with a page that says
// what is missing, and nothing else: no records exist, no input is accepted.
// The app itself never starts without a passphrase and a persistent disk.
function setupPage(problems) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const items = problems.map((p) => `<li>${esc(p)}</li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Setup required · CryptoResearch</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px;background:#f6f7f9;color:#1b1f24}main{max-width:560px;margin:0 auto;background:#fff;border:1px solid #dde1e6;border-radius:10px;padding:20px}h1{font-size:20px;margin:0 0 8px}li{margin:6px 0}@media (prefers-color-scheme:dark){body{background:#111418;color:#e6e9ee}main{background:#1a1f25;border-color:#2c333b}}</style></head><body><main><h1>CryptoResearch: setup required</h1><p>The private research desk is deployed but has not started, because it is not configured yet. Nothing is stored or exposed here.</p><ul>${items}</ul><p>After these are set in the Render dashboard, Render restarts the service and this page is replaced by the sign-in page.</p></main></body></html>`;
}

function serveSetupPage(port, problems) {
  const http = require('http');
  const body = setupPage(problems);
  const server = http.createServer((req, res) => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" };
    if (req.url === '/healthz') {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('setup required');
    }
    res.writeHead(503, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '300' });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  server.listen(port, '0.0.0.0');
  return server;
}

async function main(env = process.env) {
  const cfg = hostedConfig(env);
  if (cfg.dataDir && process.platform === 'linux') {
    const m = containingMount(cfg.dataDir);
    console.log(`Data folder ${cfg.dataDir}: on mount ${m ? `${m.point} (${m.type})` : 'unknown (mount table unreadable)'}.`);
  }
  if (cfg.problems.length) {
    console.error('CryptoResearch (hosted) did not start the desk, so no records are exposed:');
    for (const p of cfg.problems) console.error(`  - ${p}`);
    if (!Number.isInteger(cfg.port)) process.exit(1);
    console.error(`Serving a setup-required page on port ${cfg.port} until this is fixed.`);
    return { setup: serveSetupPage(cfg.port, cfg.problems), problems: cfg.problems };
  }
  const ws = prepareWorkspace(cfg);
  console.log(researchSummary(ws));
  console.log(recordsSummary(ws));
  const { start } = require('./server');
  return start(ws, { hosted: { port: cfg.port, hosts: cfg.hosts, password: cfg.password } });
}

// One line for the start log: what the desk holds (counts and the newest
// report, no content), so a restart or deploy can be checked against the
// line before it.
function recordsSummary(ws) {
  const { listDir } = require('./core/fsx');
  const list = require('./core/projects').listProjects(ws).filter((p) => !p.broken);
  let reports = 0;
  let newest = null;
  for (const p of list) {
    for (const rid of listDir(ws.abs(`projects/${p.project_id}/reports`), { dirs: true })) {
      reports++;
      const meta = readJson(ws.abs(`projects/${p.project_id}/reports/${rid}/meta.json`), null);
      const at = meta && meta.imported_at ? meta.imported_at : '';
      if (!newest || at > newest.at) newest = { at, ref: `${p.project_id}/${rid}` };
    }
  }
  const txs = require('./core/portfolio').loadTransactions(ws).filter((t) => !t.voided).length;
  const oauth = readJson(ws.abs('.cr/oauth.json'), null);
  const apps = oauth && oauth.grants ? Object.values(oauth.grants).filter((g) => !g.revoked_at).length : 0;
  const watched = list.filter((p) => p.watchlist && p.watchlist.on_watchlist).length;
  return `Records: ${list.length} project${list.length === 1 ? '' : 's'} (${watched} on the watchlist), ${reports} report${reports === 1 ? '' : 's'}${newest ? `, newest ${newest.ref} (saved ${newest.at})` : ''}, ${txs} transaction${txs === 1 ? '' : 's'}; ${apps} connected app${apps === 1 ? '' : 's'}.`;
}

// One line for the start log: the bounds research would be sent with, and
// whether a Claude key is present (never the key itself).
function researchSummary(ws) {
  const research = require('./core/research');
  const providers = require('./core/providers');
  const b = research.callBounds(ws, 'claude');
  const r = ws.settings.research;
  const budget = r.budget || {};
  const st = research.providerStatus(ws).claude;
  const upg = readJson(path.join(ws.root, 'config', 'settings.json'), {}).hosted_defaults_upgrades || [];
  const last = upg[upg.length - 1];
  return `Research: ${(r.providers.claude || {}).model || 'no model'}; ${b.max_output_tokens} output tokens per request, up to ${b.requests_max} requests, ${b.search.limit} searches per request, ${r.timeout_seconds || 600} s per call; limits $${budget.per_run_usd} per run, $${budget.daily_usd} per day, $${budget.monthly_usd} per month; Claude key ${providers.keyStatus('claude').present ? 'present' : 'missing'}; route ${st.mode}${st.mode === 'api' ? '' : ` (${st.reason})`}.${last ? ` Defaults v${last.version} applied ${last.at}: ${last.changed.length ? last.changed.map((c) => `${c.setting} ${c.from === null ? 'unset' : c.from} -> ${c.to}`).join(', ') : 'nothing to change'}.` : ''}`;
}

module.exports = { hostedConfig, prepareWorkspace, syncTemplates, makeAuth, main, HOSTED_DEFAULTS, loginPage, setupPage, containingMount, persistentDiskProblem, researchSummary, recordsSummary };
