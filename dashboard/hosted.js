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
// Research keys come from the environment too (OPENAI_API_KEY, GEMINI_API_KEY,
// ANTHROPIC_API_KEY, and COINGECKO_API_KEY for prices); they are never written
// to the disk, logs, exports or the page.
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
// on first boot; Eric changes them in Settings afterwards. A model's paid API
// is used only once its key is in Render's environment (entered by Eric);
// without one its jobs wait for its assistant or a pasted answer. List prices
// as published in October 2026:
//   claude-opus-5-5 (Claude API documentation): $4 / $20 per million input /
//     output tokens, $5 per million 5-minute cache writes, $0.20 per million
//     cache reads, $10 per 1,000 web searches.
//   gpt-6.1-sol (OpenAI API pricing): $2 / $10 per million input / output
//     tokens; web search $10 per 1,000 calls, plus the search content it reads
//     billed as input tokens. max_tool_calls caps the calls.
//   gemini-3.1-pro-preview (Gemini API pricing checked 2026-10-03, prompts up
//     to 200k tokens): $2 / $12 per million input / output tokens. Gemini 3
//     bills every Google Search query the model runs (5,000 free a month
//     across Gemini 3 models, then $14 per 1,000) and no request parameter
//     caps them, so max searches is the number the reservation assumes (an
//     estimate). A Google project spend cap is a second guard, not a hard
//     limit: Google applies it with about ten minutes of billing delay.
//     gemini-2.5-pro (the v3 proposal) is now limited to earlier users.
// ChatGPT and Gemini run in the provider's background (Responses background
// mode, Interactions background execution) and are collected by ID, so a
// deploy or restart never strands a paid request.
const HOSTED_DEFAULTS_VERSION = 5;
// Gemini is on hold for the 2026-10-04 milestone (Eric's decision): nothing
// new is assigned to it; its saved reports and waiting jobs stay. Lifted in
// Settings (research.on_hold.gemini set to null), and never put back then.
const GEMINI_HOLD = { since: '2026-10-04', reason: 'On hold for this milestone (Eric, 2026-10-04): Gemini\'s connector route has not completed a job since Oct 3, and it is not being troubleshot now.' };
const CHATGPT_DEFAULTS = { model: 'gpt-6.1-sol', input_usd_per_mtok: 2, output_usd_per_mtok: 10, search_usd_per_call: 0.01, max_searches: 10, search_result_tokens_estimate: 8000, effort: 'high' };
const GEMINI_DEFAULTS = { model: 'gemini-3.1-pro-preview', input_usd_per_mtok: 2, output_usd_per_mtok: 12, search_usd_per_call: 0.014, search_billing: 'per_query', max_searches: 20, effort: 'high' };
// What v3 proposed, to recognize settings nobody has changed since.
const CHATGPT_DEFAULTS_V3 = { model: 'gpt-6.1-sol', input_usd_per_mtok: 2, output_usd_per_mtok: 10, search_usd_per_call: 0.01, max_searches: 10, search_result_tokens_estimate: 8000 };
const GEMINI_DEFAULTS_V3 = { model: 'gemini-2.5-pro', input_usd_per_mtok: 1.25, output_usd_per_mtok: 10, search_usd_per_call: 0.035, search_billing: 'per_request', max_searches: 1 };
const HOSTED_DEFAULTS = {
  // Prices every 15 minutes while a page is open (hourly otherwise): a
  // 4-month horizon gains nothing from 5-minute prices, and fewer calls from
  // Render's shared addresses mean fewer CoinGecko rate limits.
  market_data: { enabled: true, foreground_interval_minutes: 15 },
  research: {
    default_providers: ['claude'],
    // A full report is about 16,000 tokens of text, plus Claude's thinking,
    // which counts toward the same limit; each request is streamed.
    max_output_tokens: 48000,
    max_continuations: 2,
    effort: 'high',
    timeout_seconds: 1500,
    // ChatGPT and Gemini in the background run side by side.
    max_concurrent: 2,
    // A background request still running after an hour is cancelled.
    background_deadline_minutes: 60,
    providers: {
      claude: { model: 'claude-opus-5-5', input_usd_per_mtok: 4, output_usd_per_mtok: 20, cache_write_usd_per_mtok: 5, cache_read_usd_per_mtok: 0.2, search_usd_per_call: 0.01, max_searches: 8 },
      chatgpt: CHATGPT_DEFAULTS,
      gemini: GEMINI_DEFAULTS,
    },
    // A Claude API attempt reserves about $3.60 at these bounds (most of it
    // the output ceiling), a ChatGPT one about $0.75 and a Gemini one about
    // $1.05; a typical run costs far less, and its recorded cost replaces the
    // reservation.
    budget: { per_run_usd: 5, daily_usd: 10, monthly_usd: 40 },
  },
};
const DEFAULTS_NOTE = 'Proposed limits for the online desk: claude-opus-5-5, gpt-6.1-sol and gemini-3.1-pro-preview with web search, used only for a model whose API key is set (ChatGPT and Gemini run in the provider\'s background and are collected by ID); up to 48,000 output tokens per request, $5 per run, $10 per day, $40 per month. Change them in Settings > Research models & budget.';

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
  // v3 (2026-10-03): proposed ChatGPT and Gemini API settings, inert until a key is set.
  3: [
    ['research.providers.chatgpt', undefined, CHATGPT_DEFAULTS_V3],
    ['research.providers.gemini', undefined, GEMINI_DEFAULTS_V3],
    ['research.max_concurrent', undefined, 2],
  ],
  // v4 (2026-10-03): background research for ChatGPT and Gemini; Gemini 3.1
  // Pro on the Interactions API (2.5 Pro is limited to earlier users).
  4: [
    ['research.providers.chatgpt', CHATGPT_DEFAULTS_V3, CHATGPT_DEFAULTS],
    ['research.providers.gemini', GEMINI_DEFAULTS_V3, GEMINI_DEFAULTS],
    ['research.background_deadline_minutes', undefined, 60],
    ['market_data.foreground_interval_minutes', undefined, 15],
    ['market_data.foreground_interval_minutes', 5, 15],
  ],
  // v5 (2026-10-04): Gemini on hold on the desk that has its backlog. A desk
  // set up later starts without a hold.
  5: [
    ['research.on_hold.gemini', undefined, GEMINI_HOLD],
  ],
};
// A setting still exactly as an earlier version wrote it (objects compared by value).
const sameSetting = (a, b) => (a === undefined || b === undefined ? a === b : JSON.stringify(a) === JSON.stringify(b));

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
        if (sameSetting(getPath(doc, p), from)) {
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
  const ws = openWorkspace({ root: cfg.dataDir, actor: 'hosted' });
  // The online desk: the models' own assistants can connect to it (mcp.js).
  ws.hosted = true;
  return ws;
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in · CryptoResearch</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/position.css"></head><body><main class="login-wrap"><form class="card login-card" method="post" action="/login"><div class="brandline"><svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><circle cx="16" cy="16" r="10.5" fill="none" stroke="currentColor" stroke-width="2" opacity="0.4"/><circle cx="16" cy="16" r="3.8" fill="currentColor"/><circle cx="16" cy="5.5" r="3.1" fill="currentColor"/><circle cx="6.9" cy="21.3" r="3.1" fill="currentColor"/><circle cx="25.1" cy="21.3" r="3.1" fill="currentColor"/></svg><h1>CryptoResearch</h1></div><p class="muted">Private research desk. Sign in with your passphrase.</p>${msg}<label class="field"><span class="field-label">Passphrase</span><input type="password" name="password" autocomplete="current-password" required autofocus></label><div class="btn-row"><button class="btn primary" type="submit">Sign in</button></div></form><p class="login-foot">Only you hold the passphrase. This desk keeps its own records and never connects a wallet or an exchange.</p></main></body></html>`;
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
  console.log(`Revision: ${require('./core/revision').revisionLine()}.`);
  if (cfg.problems.length) {
    console.error('CryptoResearch (hosted) did not start the desk, so no records are exposed:');
    for (const p of cfg.problems) console.error(`  - ${p}`);
    if (!Number.isInteger(cfg.port)) process.exit(1);
    console.error(`Serving a setup-required page on port ${cfg.port} until this is fixed.`);
    return { setup: serveSetupPage(cfg.port, cfg.problems), problems: cfg.problems };
  }
  const ws = prepareWorkspace(cfg);
  // One-time fixes of known records (core/repairs.js); a failure never stops the desk.
  try {
    require('./core/repairs').runRepairs(ws, { log: (line) => console.log(line) });
  } catch (err) {
    console.log(`Record repairs could not run: ${err.message}`);
  }
  console.log(researchSummary(ws));
  console.log(`Readiness: ${require('./core/research').readiness(ws).summary}`);
  console.log(recordsSummary(ws));
  try {
    for (const line of healthLines(ws)) console.log(line);
  } catch (err) {
    console.log(`Records check could not run: ${err.message}`);
  }
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
  const ids = list.slice(0, 10).map((p) => p.project_id).join(', ');
  return `Records: ${list.length} project${list.length === 1 ? '' : 's'} (${watched} on the watchlist${ids ? `: ${ids}${list.length > 10 ? ', ...' : ''}` : ''}), ${reports} report${reports === 1 ? '' : 's'}${newest ? `, newest ${newest.ref} (saved ${newest.at})` : ''}, ${txs} transaction${txs === 1 ? '' : 's'}; ${apps} connected app${apps === 1 ? '' : 's'}.`;
}

// Start-log lines for what needs attention, so a problem seen on the phone can
// be traced from Render's log without signing in: projects whose identity is
// not verified, reports whose grade is withheld (which parts, and why), and the
// last price refresh. IDs, statuses and validation messages only: no report
// text, notes, holdings or keys.
function healthLines(ws) {
  const { loadReports } = require('./core/reports');
  const { gradeAssessment } = require('./core/rubrics');
  const market = require('./core/market');
  const out = [];
  const cut = (s, n = 100) => {
    const t = String(s === undefined ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  const host = (u) => {
    try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return null; }
  };
  const f = market.freshness(ws);
  const notReturned = new Set(f.missing_ids || []);
  for (const p of require('./core/projects').listProjects(ws).filter((x) => !x.broken && x.status !== 'archived')) {
    const id = p.identity || {};
    if (id.status === 'verified' && id.coingecko_id && notReturned.has(id.coingecko_id)) out.push(`Identity: ${p.project_id} verified, but CoinGecko returned no price for its ID "${id.coingecko_id}" in the last refresh (the ID may be wrong).`);
    if (id.status !== 'verified') {
      const cands = (id.candidates || []).map((c) => c.coingecko_id).filter(Boolean);
      const ev = [...new Set((id.evidence || []).map((e) => host(e.url)).filter(Boolean))];
      out.push(`Identity: ${p.project_id} "${cut(p.name, 40)}"${p.symbol ? ` (${p.symbol})` : ''} ${id.status || 'unknown'}; website ${id.official_website ? cut(id.official_website, 80) : 'none'}; candidates ${cands.length ? cands.join(', ') : 'none'}; evidence ${ev.length ? ev.join(', ') : 'none'}; via ${p.created_via || '?'}; asked "${cut(p.origin_request || '', 100)}".`);
    }
    for (const r of loadReports(ws, p.project_id)) {
      if (r.broken) {
        out.push(`Report: ${p.project_id}/${r.report_id} unreadable (${cut(r.error, 80)}).`);
        continue;
      }
      const g = gradeAssessment(ws, r.assessment);
      if (!g || g.status === 'firm' || g.status === 'range') continue;
      const issues = require('./core/reports').effectiveIssues((r.record.extraction || {}).issues);
      const comp = Object.entries(r.assessment.investment_components || {})
        .filter(([, s]) => !s || !['scored', 'range'].includes(s.status) || (s.status === 'range' && !s.rationale))
        .map(([k, s]) => `${k}=${s ? s.status : 'missing'}${s && s.invalid_source !== undefined ? ` (given ${cut(JSON.stringify(s.invalid_source), 90)})` : s && s.missing_data ? ` (${cut(s.missing_data, 70)})` : ''}`);
      const ignored = issues.filter((i) => /ignored/.test(i.message || '') && /^investment_components\./.test(i.field || '')).map((i) => i.field.split('.')[1]);
      const errs = issues.filter((i) => i.severity === 'error').slice(0, 3).map((i) => cut(i.message, 100));
      out.push(`Grade: ${p.project_id}/${r.report_id} (${r.meta.provider}, ${r.assessment.source_format || '?'}, rubric ${r.assessment.rubric_version || 'none'}) ${g.status}${g.coverage_pct !== null && g.coverage_pct !== undefined ? ` at ${g.coverage_pct}% of the weight` : ''}; ${comp.length ? comp.join('; ') : cut(g.reason || '', 120)}${ignored.length ? `; keys not in the rubric: ${ignored.join(', ')}` : ''}${errs.length ? `; errors: ${errs.join(' | ')}` : ''}.`);
    }
  }
  out.push(`Prices: ${f.freshness}${f.note ? ` (${cut(f.note, 160)})` : ''}; last success ${f.last_success_at || 'never'}; last attempt ${f.last_attempt_at || 'never'}${f.last_error ? `; last error "${cut(f.last_error, 120)}"` : ''}; failures in a row ${f.consecutive_failures || 0}${f.rate_limited ? `; rate-limited until ${f.retry_at}` : ''}; requests this month ${f.calls ? `${f.calls.month_count}${typeof f.calls.month_answered === 'number' ? ` (${f.calls.month_answered} answered)` : ''}` : '?'}; CoinGecko key ${market.apiKey() ? 'present' : 'none'}; tracked ${(f.tracked_ids || []).length}; not returned ${notReturned.size ? [...notReturned].join(', ') : 'none'}.`);
  try {
    const fo = require('./core/fundamentals').overview(ws);
    const states = Object.entries(fo.states).filter(([s]) => s !== 'unmapped').map(([s, n]) => `${s} ${n}`).join(', ');
    out.push(`Fundamentals: ${fo.enabled ? `${fo.bound} bound to DefiLlama${states ? ` (${states})` : ''}; last refresh ${fo.last_run ? `${fo.last_run.at} ${fo.last_run.status}` : 'never'}; requests this month ${fo.calls.month_count} (${fo.calls.month_answered || 0} answered)${fo.rate_limited ? `; rate-limited until ${fo.retry_at}` : ''}` : 'turned off in settings'}.`);
  } catch (_) { /* fundamentals module optional */ }
  try {
    const so = require('./core/screening').overview(ws);
    const states = Object.entries(so.states).map(([s, n]) => `${s} ${n}`).join(', ');
    out.push(`Contract screening: ${so.enabled ? `${so.screened} screened${states ? ` (${states})` : ''}; alerts ${so.alerts}; last run ${so.last_run ? `${so.last_run.at} ${so.last_run.status}` : 'never'}; requests this month ${so.calls.month_count}${so.rate_limited ? `; rate-limited until ${so.retry_at}` : ''}; packets ${so.packet_mode}; ${so.credential === 'app_key' ? 'GoPlus key present' : `GoPlus keyless${so.credential_note ? ` (${so.credential_note})` : ''}`}` : 'turned off in settings'}.`);
  } catch (_) { /* screening module optional */ }
  try {
    // Tracked wallets: counts and states only, never an address or a label.
    const tracked = require('./core/wallets').listWallets(ws).filter((w) => w.status !== 'removed');
    const st = require('./core/walletsync').statusOf(ws);
    const states = {};
    for (const n of Object.values(st.networks)) if (n.state !== 'removed') states[n.state] = (states[n.state] || 0) + 1;
    out.push(`Wallets: ${tracked.length ? `${tracked.length} tracked (${Object.entries(states).map(([k, v]) => `${k} ${v}`).join(', ')}); Moralis key ${st.summary.key_present ? 'present' : 'missing'}; last run ${st.summary.last_run ? `${st.summary.last_run.at} ${st.summary.last_run.status}` : 'never'}; compute units today ${st.summary.calls.day_cu || 0}${st.summary.daily_cu_budget ? ` of ${st.summary.daily_cu_budget}` : ''}` : 'none tracked; nothing is read'}.`);
  } catch (_) { /* wallet module optional */ }
  out.push(`Offsite: ${require('./core/offsite').deskKey() ? 'backup key set (CR_BACKUP_KEY); a PC can pull verified copies' : `not set up (${require('./core/offsite').deskKeyProblem()}): the records exist only on this disk and in Render's disk snapshots`}.`);
  // The optional Research Explorer (core/explorer.js): its state and where
  // its settings come from, never the key. Nothing is asked of Supabase here.
  try {
    const xs = require('./core/explorer').status(ws);
    const why = [...xs.problems, ...xs.missing.map((m) => `missing ${m.replace(/ \(.*$/, '')}`)].join('; ');
    out.push(`Explorer: ${xs.state === 'configured' ? `set up (URL from ${xs.url_source}; ${xs.key_kind} key from ${xs.key_source})` : xs.state === 'off' ? 'switched off' : `not set up (${why}; set CR_SUPABASE_URL and CR_SUPABASE_SECRET_KEY in Render's environment)`}; nothing else on the desk depends on it.`);
  } catch (_) { /* explorer module optional */ }
  return out;
}

// One line for the start log: the bounds research would be sent with, and
// whether each model's key is present (never a key itself).
function researchSummary(ws) {
  const research = require('./core/research');
  const providers = require('./core/providers');
  const { PROVIDER_LABELS } = require('./core/workspace');
  const b = research.callBounds(ws, 'claude');
  const r = ws.settings.research;
  const budget = r.budget || {};
  const status = research.providerStatus(ws);
  const st = status.claude;
  const doc = readJson(path.join(ws.root, 'config', 'settings.json'), {});
  const upg = doc.hosted_defaults_upgrades || [];
  // Every upgrade applied on the latest boot.
  const at = upg.length ? upg[upg.length - 1].at : null;
  const latest = upg.filter((u) => u.at === at);
  const last = latest.length ? { version: latest.map((u) => u.version).join(', v'), at, changed: latest.flatMap((u) => u.changed) } : null;
  const show = (v) => (v && typeof v === 'object' ? v.model || 'set' : v);
  const others = ['chatgpt', 'gemini'].map((p) => `${PROVIDER_LABELS[p]} ${(r.providers[p] || {}).model || 'no model'} (key ${providers.keyStatus(p).present ? 'present' : 'missing'}; route ${status[p].mode})`).join(', ');
  return `Research: ${(r.providers.claude || {}).model || 'no model'}; ${b.max_output_tokens} output tokens per request, up to ${b.requests_max} requests, ${b.search.limit} searches per request, ${r.timeout_seconds || 600} s per call; limits $${budget.per_run_usd} per run, $${budget.daily_usd} per day, $${budget.monthly_usd} per month; Claude key ${providers.keyStatus('claude').present ? 'present' : 'missing'}; route ${st.mode}${st.mode === 'api' ? '' : ` (${st.reason})`}; ${others}; ${r.max_concurrent || 1} at a time.${last ? ` Defaults v${last.version} applied ${last.at}: ${last.changed.length ? last.changed.map((c) => `${c.setting} ${c.from === null ? 'unset' : show(c.from)} -> ${show(c.to)}`).join(', ') : 'nothing to change'}.` : ''}`;
}

module.exports = { hostedConfig, prepareWorkspace, syncTemplates, makeAuth, main, HOSTED_DEFAULTS, loginPage, setupPage, containingMount, persistentDiskProblem, researchSummary, recordsSummary, healthLines };
