'use strict';
// Sign-in for the online desk's Claude connector (remote MCP), as Claude's
// connector client requires it (claude.com/docs/connectors/building/authentication):
//
//   protected resource metadata (RFC 9728)   /.well-known/oauth-protected-resource
//   authorization server metadata (RFC 8414) /.well-known/oauth-authorization-server
//   dynamic client registration (RFC 7591)   POST /oauth/register
//   authorization code + PKCE S256           GET/POST /oauth/authorize, POST /oauth/token
//   rotating refresh tokens                  POST /oauth/token (grant_type=refresh_token)
//   token revocation (RFC 7009)              POST /oauth/revoke
//
// Eric approves a connection once, on the consent page, with his desk
// passphrase (the same rate-limited check as the sign-in page). Claude then
// holds an access token (1 hour) and a refresh token (90 days, replaced on
// every use). Only SHA-256 hashes of tokens are stored, in .cr/oauth.json on
// the desk's disk, so connections survive restarts and deploys. Settings >
// Connected apps lists each connection and disconnects it.
//
// Only Claude's own redirect URIs are accepted: the hosted apps' callback
// (claude.ai, Desktop, mobile, Cowork) and Claude Code's loopback callback.

const crypto = require('crypto');
const path = require('path');
const { readJson, jsonText, mkdirp, atomicWrite } = require('./core/fsx');

const STORE_REL = '.cr/oauth.json';
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_MS = 90 * 86400000;
const CODE_TTL_MS = 5 * 60000;
const PENDING_TTL_MS = 10 * 60000;
const MAX_CLIENTS = 50;
const MAX_REGISTRATIONS_PER_HOUR = 30;
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const SCOPE = 'desk';
const SCOPES = [SCOPE, 'offline_access'];

const hashOf = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const newToken = (bytes = 32) => b64url(crypto.randomBytes(bytes));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function isLoopback(u) {
  return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
}

// A redirect URI Claude uses: the hosted callback exactly, or a loopback
// /callback on any port (Claude Code).
function redirectAllowed(uri) {
  if (uri === CLAUDE_CALLBACK) return true;
  let u;
  try {
    u = new URL(uri);
  } catch (_) {
    return false;
  }
  return isLoopback(u) && u.pathname === '/callback' && !u.search && !u.hash && !u.username && !u.password;
}

// Registered vs presented: exact, except that a loopback port may differ
// (RFC 8252 section 7.3; Claude Code picks a new port each session).
function redirectMatches(registered, presented) {
  if (registered === presented) return true;
  try {
    const a = new URL(registered);
    const b = new URL(presented);
    return isLoopback(a) && isLoopback(b) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
  } catch (_) {
    return false;
  }
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(Object.assign(new Error('Request too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Pragma: 'no-cache', ...headers });
  res.end(JSON.stringify(body));
}

function page(res, status, html, { formAction = "'self'" } = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    // The consent form posts to this site, which then redirects to Claude:
    // browsers apply form-action to that redirect too.
    'Content-Security-Policy': `default-src 'self'; script-src 'none'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action ${formAction}`,
  });
  res.end(html);
}

function shell(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · CryptoResearch</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/position.css"></head><body><main class="login-wrap">${body}</main></body></html>`;
}

function makeOAuth(ws, { origin, auth }) {
  const resource = `${origin}/mcp`;
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource`;
  const storeFile = ws.abs(STORE_REL);
  let store = readJson(storeFile, null) || { schema_version: 'cr.oauth.v1', clients: {}, grants: {}, access: {}, refresh: {} };
  for (const k of ['clients', 'grants', 'access', 'refresh']) store[k] = store[k] || {};
  const pending = new Map(); // consent requests in progress (minutes)
  const codes = new Map(); // hash(code) -> authorization (minutes)
  const registrations = []; // { at, addr } for the hourly limit
  let lastUseSave = 0;

  function save() {
    const now = Date.now();
    for (const [k, v] of Object.entries(store.access)) if (Date.parse(v.expires_at) < now) delete store.access[k];
    for (const [k, v] of Object.entries(store.refresh)) if (Date.parse(v.expires_at) < now) delete store.refresh[k];
    mkdirp(path.dirname(storeFile));
    atomicWrite(storeFile, jsonText(store));
  }

  function sweep() {
    const now = Date.now();
    for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
    for (const [k, v] of codes) if (v.expires < now) codes.delete(k);
  }

  // Too many registered clients (Claude registers a new one for each fresh
  // connection): drop the oldest that hold no live connection.
  function pruneClients() {
    const live = new Set(Object.values(store.grants).filter((g) => !g.revoked_at).map((g) => g.client_id));
    const ids = Object.keys(store.clients).filter((id) => !live.has(id)).sort((a, b) => String(store.clients[a].created_at).localeCompare(String(store.clients[b].created_at)));
    while (Object.keys(store.clients).length > MAX_CLIENTS && ids.length) delete store.clients[ids.shift()];
  }

  function issue(grantId, clientId, scope) {
    const access = newToken();
    const refresh = newToken();
    const now = Date.now();
    store.access[hashOf(access)] = { grant_id: grantId, client_id: clientId, scope, expires_at: new Date(now + ACCESS_TTL_S * 1000).toISOString() };
    store.refresh[hashOf(refresh)] = { grant_id: grantId, client_id: clientId, scope, expires_at: new Date(now + REFRESH_TTL_MS).toISOString() };
    store.grants[grantId].last_used_at = new Date(now).toISOString();
    save();
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope };
  }

  const protectedResource = () => ({
    resource,
    authorization_servers: [origin],
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'CryptoResearch desk',
  });
  const serverMetadata = () => ({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: SCOPES,
    service_documentation: `${origin}/login`,
  });

  function consentPage(p, { error = null, locked = false } = {}) {
    const host = (() => {
      try {
        return new URL(p.redirect_uri).host;
      } catch (_) {
        return p.redirect_uri;
      }
    })();
    const loopback = !p.redirect_uri.startsWith('https://');
    const msg = locked
      ? '<p class="callout bad" role="alert">Too many attempts. Wait a few minutes, then start the connection again from Claude.</p>'
      : error ? `<p class="callout bad" role="alert">${esc(error)}</p>` : '';
    return shell('Connect Claude', `<form class="card login-card" method="post" action="/oauth/authorize"><h1>Connect Claude to your desk</h1>
<p><strong>${esc(p.client_name || 'Claude')}</strong> asks to use your CryptoResearch desk. After you approve, it can:</p>
<ul class="small"><li>read your watchlist, research and portfolio</li><li>add projects and save research reports</li><li>record a purchase or sale only when you ask it to</li></ul>
<p class="small muted">It cannot trade, move money or reach any exchange or wallet. You can disconnect it any time in Settings &gt; Connected apps.</p>
<p class="small">After you approve, you go back to <strong>${esc(host)}</strong>.${loopback ? ' That is a program on this computer (Claude Code); approve only if you just started the connection yourself.' : ''}</p>
${msg}<input type="hidden" name="request" value="${esc(p.id)}">
<label class="field"><span class="field-label">Desk passphrase</span><input type="password" name="password" autocomplete="current-password" required autofocus></label>
<div class="btn-row"><button class="btn primary" type="submit" name="decision" value="allow">Approve</button><button class="btn" type="submit" name="decision" value="deny" formnovalidate>Deny</button></div></form>`);
  }

  function errorPage(res, status, text) {
    page(res, status, shell('Connection not possible', `<div class="card login-card"><h1>Connection not possible</h1><p class="callout bad">${esc(text)}</p><p class="small muted">Start the connection again from Claude (Settings &gt; Connectors).</p></div>`));
  }

  function redirectTo(res, uri, params) {
    const u = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
    res.writeHead(303, { Location: u.toString(), 'Cache-Control': 'no-store' });
    res.end();
  }

  async function register(req, res) {
    const addr = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown';
    const hourAgo = Date.now() - 3600000;
    while (registrations.length && registrations[0].at < hourAgo) registrations.shift();
    if (registrations.filter((r) => r.addr === addr).length >= MAX_REGISTRATIONS_PER_HOUR) return json(res, 429, { error: 'too_many_requests', error_description: 'Too many client registrations; try again later.' });
    let body;
    try {
      body = JSON.parse(await readBody(req, 16384) || '{}');
    } catch (_) {
      return json(res, 400, { error: 'invalid_client_metadata', error_description: 'Body must be JSON.' });
    }
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === 'string') : [];
    if (!uris.length || uris.length > 5 || !uris.every(redirectAllowed)) {
      return json(res, 400, { error: 'invalid_redirect_uri', error_description: `Only Claude's callbacks are accepted: ${CLAUDE_CALLBACK}, or http://localhost/callback and http://127.0.0.1/callback on any port.` });
    }
    const grantTypes = Array.isArray(body.grant_types) && body.grant_types.length ? body.grant_types : ['authorization_code', 'refresh_token'];
    if (!grantTypes.every((g) => ['authorization_code', 'refresh_token'].includes(g))) return json(res, 400, { error: 'invalid_client_metadata', error_description: 'Only authorization_code and refresh_token grants are supported.' });
    registrations.push({ at: Date.now(), addr });
    const clientId = `crc_${newToken(16)}`;
    const client = {
      client_name: typeof body.client_name === 'string' ? body.client_name.slice(0, 100) : 'Claude',
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      created_at: new Date().toISOString(),
    };
    store.clients[clientId] = client;
    pruneClients();
    save();
    return json(res, 201, { client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), ...client, created_at: undefined });
  }

  function authorizeGet(req, res, url) {
    sweep();
    const q = Object.fromEntries(url.searchParams);
    const client = q.client_id ? store.clients[q.client_id] : null;
    if (!client) return errorPage(res, 400, 'Unknown client. Claude registers itself first; start the connection again from Claude.');
    const redirect = q.redirect_uri || (client.redirect_uris.length === 1 ? client.redirect_uris[0] : null);
    if (!redirect || !client.redirect_uris.some((r) => redirectMatches(r, redirect)) || !redirectAllowed(redirect)) {
      return errorPage(res, 400, 'The return address is not one of Claude\'s, so the connection was refused.');
    }
    // From here on, problems go back to Claude as OAuth errors.
    if (q.response_type !== 'code') return redirectTo(res, redirect, { error: 'unsupported_response_type', state: q.state, iss: origin });
    if (!q.code_challenge || q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) return redirectTo(res, redirect, { error: 'invalid_request', error_description: 'PKCE with S256 is required.', state: q.state, iss: origin });
    if (q.resource && q.resource !== resource) return redirectTo(res, redirect, { error: 'invalid_target', error_description: `This server's resource is ${resource}.`, state: q.state, iss: origin });
    const scope = SCOPES.filter((s) => String(q.scope || SCOPE).split(/\s+/).includes(s)).join(' ') || SCOPE;
    const id = newToken(18);
    const p = { id, client_id: q.client_id, client_name: client.client_name, redirect_uri: redirect, code_challenge: q.code_challenge, state: q.state || null, scope, expires: Date.now() + PENDING_TTL_MS };
    pending.set(id, p);
    return page(res, 200, consentPage(p), { formAction: "'self' https://claude.ai http://localhost:* http://127.0.0.1:*" });
  }

  async function authorizePost(req, res) {
    sweep();
    if (!auth.fromThisSite(req)) return errorPage(res, 403, 'Approval is only accepted from this site\'s own page.');
    const form = new URLSearchParams(await readBody(req, 4096));
    const p = pending.get(form.get('request') || '');
    if (!p) return errorPage(res, 400, 'This approval page has expired. Start the connection again from Claude.');
    const formAction = "'self' https://claude.ai http://localhost:* http://127.0.0.1:*";
    if (form.get('decision') !== 'allow') {
      pending.delete(p.id);
      return redirectTo(res, p.redirect_uri, { error: 'access_denied', state: p.state, iss: origin });
    }
    const check = await auth.verifyPassphrase(req, form.get('password') || '');
    if (!check.ok) return page(res, 200, consentPage(p, { error: check.locked ? null : 'That passphrase is not right.', locked: check.locked }), { formAction });
    pending.delete(p.id);
    const code = newToken();
    codes.set(hashOf(code), { client_id: p.client_id, redirect_uri: p.redirect_uri, code_challenge: p.code_challenge, scope: p.scope, expires: Date.now() + CODE_TTL_MS });
    return redirectTo(res, p.redirect_uri, { code, state: p.state, iss: origin });
  }

  async function tokenPost(req, res) {
    sweep();
    const type = String(req.headers['content-type'] || '');
    const raw = await readBody(req, 8192);
    let form;
    if (type.startsWith('application/json')) {
      try {
        form = new URLSearchParams(Object.entries(JSON.parse(raw || '{}')).map(([k, v]) => [k, String(v)]));
      } catch (_) {
        return json(res, 400, { error: 'invalid_request', error_description: 'Unreadable body.' });
      }
    } else form = new URLSearchParams(raw);
    const grant = form.get('grant_type');
    const clientId = form.get('client_id');
    if (!clientId || !store.clients[clientId]) return json(res, 401, { error: 'invalid_client', error_description: 'Unknown client.' });
    if (grant === 'authorization_code') {
      const key = hashOf(form.get('code') || '');
      const c = codes.get(key);
      codes.delete(key); // single use, even when the exchange fails
      if (!c || c.expires < Date.now() || c.client_id !== clientId) return json(res, 400, { error: 'invalid_grant', error_description: 'The authorization code is invalid or expired.' });
      if ((form.get('redirect_uri') || c.redirect_uri) !== c.redirect_uri) return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri does not match the authorization request.' });
      const verifier = form.get('code_verifier') || '';
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || b64url(crypto.createHash('sha256').update(verifier).digest()) !== c.code_challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed.' });
      if (form.get('resource') && form.get('resource') !== resource) return json(res, 400, { error: 'invalid_target', error_description: `This server's resource is ${resource}.` });
      const grantId = `grant_${newToken(9)}`;
      store.grants[grantId] = { client_id: clientId, client_name: store.clients[clientId].client_name, created_at: new Date().toISOString(), last_used_at: null, revoked_at: null };
      return json(res, 200, issue(grantId, clientId, c.scope));
    }
    if (grant === 'refresh_token') {
      const key = hashOf(form.get('refresh_token') || '');
      const r = store.refresh[key];
      if (!r || r.client_id !== clientId || Date.parse(r.expires_at) < Date.now() || !store.grants[r.grant_id] || store.grants[r.grant_id].revoked_at) {
        return json(res, 400, { error: 'invalid_grant', error_description: 'The refresh token is invalid, expired or revoked. Reconnect from Claude.' });
      }
      delete store.refresh[key]; // rotated: the old refresh token stops working now
      return json(res, 200, issue(r.grant_id, clientId, r.scope));
    }
    return json(res, 400, { error: 'unsupported_grant_type' });
  }

  async function revokePost(req, res) {
    const form = new URLSearchParams(await readBody(req, 4096));
    const key = hashOf(form.get('token') || '');
    const rec = store.access[key] || store.refresh[key];
    if (rec) revokeGrant(rec.grant_id);
    res.writeHead(200, { 'Cache-Control': 'no-store' });
    res.end();
  }

  function revokeGrant(grantId) {
    const g = store.grants[grantId];
    if (!g) return false;
    g.revoked_at = g.revoked_at || new Date().toISOString();
    for (const t of ['access', 'refresh']) for (const [k, v] of Object.entries(store[t])) if (v.grant_id === grantId) delete store[t][k];
    save();
    return true;
  }

  // The connection behind a request's bearer token, or null.
  function authenticate(req) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+([A-Za-z0-9._~+/=-]{20,200})$/);
    if (!m) return null;
    const rec = store.access[hashOf(m[1])];
    if (!rec || Date.parse(rec.expires_at) < Date.now()) return null;
    const g = store.grants[rec.grant_id];
    if (!g || g.revoked_at) return null;
    const now = Date.now();
    g.last_used_at = new Date(now).toISOString();
    if (now - lastUseSave > 10 * 60000) {
      lastUseSave = now;
      save();
    }
    return { grant_id: rec.grant_id, client_id: rec.client_id, client_name: g.client_name, scope: rec.scope };
  }

  function challenge(res, { invalid = false } = {}) {
    res.writeHead(401, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl}", scope="${SCOPE}"${invalid ? ', error="invalid_token"' : ''}`,
    });
    res.end(JSON.stringify({ error: invalid ? 'invalid_token' : 'unauthorized', error_description: 'Sign in to the CryptoResearch desk through Claude\'s connector settings.' }));
  }

  return {
    resource,
    // Answers the OAuth and discovery routes; returns true when it did.
    async handle(req, res, url) {
      const p = url.pathname;
      if (req.method === 'GET' && (p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp')) return json(res, 200, protectedResource(), { 'Cache-Control': 'max-age=300' }), true;
      if (req.method === 'GET' && (p === '/.well-known/oauth-authorization-server' || p === '/.well-known/oauth-authorization-server/mcp')) return json(res, 200, serverMetadata(), { 'Cache-Control': 'max-age=300' }), true;
      if (p === '/oauth/register' && req.method === 'POST') return await register(req, res), true;
      if (p === '/oauth/authorize' && req.method === 'GET') return authorizeGet(req, res, url), true;
      if (p === '/oauth/authorize' && req.method === 'POST') return await authorizePost(req, res), true;
      if (p === '/oauth/token' && req.method === 'POST') return await tokenPost(req, res), true;
      if (p === '/oauth/revoke' && req.method === 'POST') return await revokePost(req, res), true;
      return false;
    },
    authenticate,
    challenge,
    // For Settings > Connected apps.
    connections() {
      return Object.entries(store.grants)
        .filter(([, g]) => !g.revoked_at)
        .map(([id, g]) => ({ grant_id: id, client_name: g.client_name, created_at: g.created_at, last_used_at: g.last_used_at }))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    },
    revoke: revokeGrant,
  };
}

module.exports = { makeOAuth, redirectAllowed, redirectMatches, CLAUDE_CALLBACK, STORE_REL };
