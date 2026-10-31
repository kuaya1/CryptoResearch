'use strict';
// The desk's front door (review N1, 2026-10-26): everything a request meets
// before sign-in, in one file, so a change to dashboard/server.js can no
// longer answer a request ahead of it. In order: the security headers,
// Render's health check, the host check, the connector's own sign-in and
// /mcp, the scout's ingest, the offsite package, the desk's sign-in and the
// files the sign-in page needs. Only then does a request reach server.js
// (`signedIn`), and on this PC (no sign-in) everything the stages above did
// not answer does.
//
// The front door builds its handlers itself (sign-in, connector, MCP,
// offsite) and hands server.js the ones its signed-in pages use, so none can
// be swapped from outside. It owns the server's only request listener:
// audit() says when another one answers beside it, and hosted.js refuses to
// start the online desk then. Static files come from dashboard/public only,
// as regular files: never a link (review N3).
//
// What it cannot do: code running in the same process (any module the desk
// loads) can still patch what this file relies on. The guard test
// (tests/frontdoor-guard.test.js) and audit() catch a route added the
// ordinary way, not a deliberate attack from inside.

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, 'public');
// The browser app: React components built by Vite (dashboard/web) into
// public/app and committed, so neither this PC nor Render runs a build. Its
// page is served at /; its hashed assets never change under one name.
const APP_PAGE = '/app/index.html';
const APP_ASSETS = '/app/assets/';
// What the sign-in page itself needs before anyone is signed in.
const LOGIN_ASSETS = new Set(['/tokens.css', '/styles.css', '/position.css', '/favicon.svg']);
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  // Geist and Geist Mono, served from this origin (font-src 'self').
  '.woff2': 'font/woff2',
};
// Beyond the desk's own origin, only the inspector's market views: the frames
// of its technical chart (TradingView's widget, DexScreener's pool chart;
// public/views/chart.js) and DexScreener's public API, which the browser asks
// on demand for the DEX liquidity card (public/views/dex.js). No third-party
// script runs in the page; each frame is isolated by its own origin and a
// sandbox.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://api.dexscreener.com; font-src 'self'; frame-src https://www.tradingview-widget.com https://dexscreener.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const READ_CODES = new Set(['READ_BUSY', 'READ_INTERRUPTED', 'READ_UNSAFE']);
// The events a request can arrive by; only the front door listens to them.
const REQUEST_EVENTS = ['request', 'checkContinue', 'checkExpectation', 'upgrade', 'connect'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// One answer for every refused or failed request, signed in or not. A read
// that met a save in progress, an interrupted save or an unverified commit is
// 503: nothing mixed is ever returned (V2-001). A new code takes its status
// from the error itself (err.status) rather than from these lists.
function sendError(req, res, err) {
  const readErr = READ_CODES.has(err.code);
  const status = err.status || (err.code === 'NOT_FOUND' ? 404 : ['INVALID', 'BAD_ID', 'BAD_PATH', 'CONFLICT', 'REFUSED', 'ALREADY_EXISTS', 'CONFIRM', 'AMBIGUOUS', 'IDEMPOTENCY_CONFLICT', 'UNSAFE_PATH'].includes(err.code) ? 400 : ['WORKSPACE_BUSY', 'WRITES_BLOCKED', 'NEWER_REPORT', 'INTEGRITY', 'INVALIDATED', 'BASIS_CHANGED', 'CHANGED', 'EXIT_EXPIRED', 'CONTRACT_CHANGED', 'CONTRACT_EVIDENCE_EXPIRED', 'CONTRACT_UNATTESTED'].includes(err.code) ? 409 : readErr ? 503 : 500);
  if (status >= 500 && !readErr) console.error(err);
  const retryMs = readErr && err.code !== 'READ_UNSAFE' ? (err.details && err.details.retry_after_ms) || 1000 : null;
  if (!res.headersSent) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(retryMs ? { 'Retry-After': String(Math.max(1, Math.ceil(retryMs / 1000))) } : {}) });
  }
  // A review refused for a newer report names it (model, report, time saved).
  // A scout-lead confirm refused for a change names each row and field (leads.js).
  const newer = err.code === 'NEWER_REPORT' && err.details && Array.isArray(err.details.newer) ? { newer: err.details.newer } : err.code === 'CHANGED' && err.details && Array.isArray(err.details.rows) ? { lead_changes: err.details } : ['INVALIDATED', 'BASIS_CHANGED', 'CHANGED', 'EXIT_EXPIRED', 'CONTRACT_CHANGED', 'CONTRACT_EVIDENCE_EXPIRED', 'CONTRACT_UNATTESTED'].includes(err.code) && err.details && Array.isArray(err.details.changed) ? { changed: err.details.changed } : {};
  res.end(JSON.stringify({ error: status >= 500 && !readErr ? `Server error: ${err.message}` : err.message, code: err.code || null, retry_after_ms: retryMs, saved: readErr && req.method === 'GET' ? false : ['INVALID', 'BAD_ID', 'BAD_PATH', 'NOT_FOUND', 'CONFLICT', 'REFUSED', 'ALREADY_EXISTS', 'CONFIRM', 'WORKSPACE_BUSY', 'WRITES_BLOCKED', 'NEWER_REPORT', 'INTEGRITY', 'INVALIDATED', 'BASIS_CHANGED', 'CHANGED', 'EXIT_EXPIRED', 'CONTRACT_CHANGED', 'CONTRACT_EVIDENCE_EXPIRED', 'CONTRACT_UNATTESTED', 'AMBIGUOUS', 'IDEMPOTENCY_CONFLICT', 'UNSAFE_PATH', 'GENERATION_UNWRITABLE'].includes(err.code) || err.status ? false : 'unknown', ...newer }));
}

// A regular file whose real path is inside dashboard/public, else null: a
// link, or a path through a linked folder, is never served (review N3).
const realRoots = new Map();
function publicFile(abs, root = PUBLIC_DIR) {
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile()) return null;
    if (!realRoots.has(root)) realRoots.set(root, fs.realpathSync(root));
    const back = path.relative(realRoots.get(root), fs.realpathSync(abs));
    if (!back || back.startsWith('..') || path.isAbsolute(back)) return null;
    return st;
  } catch (_) {
    return null;
  }
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (_) {
    throw new HttpError(400, 'Bad path');
  }
  if (pathname === '/' || pathname === '/index.html') pathname = APP_PAGE;
  if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some((s) => s === '..' || s === '.')) throw new HttpError(404, 'Not found');
  const abs = path.resolve(PUBLIC_DIR, `.${pathname}`);
  const back = path.relative(PUBLIC_DIR, abs);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) throw new HttpError(404, 'Not found');
  const type = STATIC_TYPES[path.extname(abs).toLowerCase()];
  if (!type || !publicFile(abs)) throw new HttpError(404, 'Not found');
  // A content-hashed asset never changes under its name; everything else is
  // checked with the server on each use.
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': pathname.startsWith(APP_ASSETS) ? 'private, max-age=31536000, immutable' : 'no-cache' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(abs).pipe(res);
}

// The server each front door listens on, and its listener.
const OWN = new WeakMap();

// Opens the front door on a listening server. server.js passes its port, its
// workspace, the hosted settings hosted.js checked, the state it reports
// requests in, the callbacks the desk connector uses (rebuild, kick) and its
// own handler for signed-in requests.
function openFrontDoor(server, { ws, hosted = null, port, quiet = false, state, rebuild = () => {}, kick = () => {}, signedIn }) {
  if (OWN.has(server)) throw new Error('The front door is already open on this server.');
  if (typeof signedIn !== 'function') throw new Error('openFrontDoor needs the signed-in handler.');
  const log = (...a) => { if (!quiet) console.log(...a); };
  const origin = hosted ? `https://${hosted.hosts[0]}` : `http://127.0.0.1:${port}`;
  const allowedHosts = hosted ? new Set(hosted.hosts.flatMap((h) => [h, `${h}:443`])) : new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = hosted ? new Set(hosted.hosts.map((h) => `https://${h}`)) : new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const version = require('./core/revision').revision().short || '1.0.0';
  const auth = hosted ? require('./hosted').makeAuth(ws, hosted) : null;
  // The connector for the assistants (Claude in Cowork and claude.ai, ChatGPT,
  // Gemini): OAuth sign-in that Eric approves with his passphrase, then the MCP
  // endpoint at /mcp. Their servers call it without an Origin header; one that
  // sends its own app's origin is accepted too (a bearer token is still needed).
  const oauth = hosted ? require('./oauth').makeOAuth(ws, { origin, auth, log }) : null;
  const mcpOrigins = new Set([...allowedOrigins, 'https://claude.ai', 'https://chatgpt.com', 'https://gemini.google.com']);
  // A research request from an assistant can queue paid API jobs (other
  // models): the runner picks them up at once instead of at its next tick.
  const mcp = hosted ? require('./mcp').makeMcp(ws, { version, rebuild: (areas) => rebuild(areas), log, kick: () => kick(), connections: () => oauth.connections().filter((c) => c.audience !== 'engineering') }) : null;
  // The scout's ingest (core/scout.js; DESK_INGEST_KEY, read per request).
  const scout = hosted ? require('./core/scout').makeScoutRoute(ws, { env: process.env, log }) : null;
  // The offsite package for this PC's daily pull (CR_BACKUP_KEY, read per request).
  const offsite = hosted ? require('./core/offsite').makeOffsiteRoute(ws, { env: process.env, log }) : null;
  // The pilot runner's zero-token pre-poll (core/pilot-poll.js;
  // CR_PILOT_POLL_TOKEN_SHA256, read per request; 404 without it).
  const pilotPoll = require('./core/pilot-poll').makePilotPollRoute(ws, { env: process.env, log });

  const listener = async (req, res) => {
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
      const bucket = url.pathname.startsWith('/api/') ? (['/api/version', '/api/index', '/api/session', '/api/health'].includes(url.pathname) ? url.pathname : '/api/(other)') : '(static)';
      state.stats.requests[bucket] = (state.stats.requests[bucket] || 0) + 1;
      // The pilot's pre-poll: its own bearer, before and apart from the
      // sign-in and the session token. Read-only names and IDs.
      if (url.pathname === '/api/pilot/queue') return pilotPoll(req, res);
      if (oauth) {
        // The connector has its own sign-in (OAuth) and never uses the
        // dashboard's session cookie.
        if (await oauth.handle(req, res, url)) return;
        if (url.pathname === '/mcp' || url.pathname === '/mcp/') {
          const o = req.headers.origin;
          if (o && !mcpOrigins.has(o)) {
            log(`MCP request refused: Origin ${String(o).slice(0, 80)} is not allowed`);
            throw new HttpError(403, 'Origin not allowed');
          }
          const who = oauth.authenticate(req);
          if (!who) {
            // Why, in words (no token is logged): a client signing in for the
            // first time, or one whose access expired and should refresh.
            log(`MCP sign-in needed: ${oauth.refusal(req)}`);
            return oauth.challenge(res, { invalid: Boolean(req.headers.authorization) });
          }
          return await mcp(req, res, who);
        }
      }
      // Grok Scout (audits/2026-10-26-grok-scout): the daily sweep checks its
      // key and posts its brief with the desk's own ingest key, never the
      // sign-in; its leads (core/leads.js) come the same way, with their
      // status at /api/ingest/scout-leads/<delivery_id>. Any other
      // /api/ingest/ path, the ping included, waits for it.
      if (scout && (url.pathname === '/api/ingest/scout-brief' || /^\/api\/ingest\/scout-leads(\/[a-z0-9-]{1,64})?$/.test(url.pathname))) return await scout(req, res, url);
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
      return await signedIn(req, res, url);
    } catch (err) {
      sendError(req, res, err);
    }
  };
  server.on('request', listener);
  OWN.set(server, listener);
  return { origin, allowedOrigins, auth, oauth, serveStatic };
}

// What answers requests beside the front door: nothing, or the reason in
// words. hosted.js refuses to start the online desk when this is not empty.
function audit(server) {
  const own = OWN.get(server);
  if (!own) return ['the front door is not open on this server'];
  const out = [];
  for (const ev of REQUEST_EVENTS) {
    const others = server.listeners(ev).filter((f) => f !== own);
    if (others.length) out.push(`${others.length} other ${others.length === 1 ? 'handler listens' : 'handlers listen'} for '${ev}' beside the front door`);
  }
  if (!server.listeners('request').includes(own)) out.push('the front door no longer listens for requests');
  return out;
}

module.exports = { openFrontDoor, audit, serveStatic, publicFile, sendError, HttpError, READ_CODES, CSP, LOGIN_ASSETS, PUBLIC_DIR };
