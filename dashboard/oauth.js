'use strict';
// Sign-in for the online desk's connector (remote MCP at /mcp), for the
// assistants Eric connects: Claude (claude.ai, Desktop, mobile, Cowork, Claude
// Code), ChatGPT (developer-mode apps) and Gemini (custom connected apps), as
// their connector clients document it:
//
//   protected resource metadata (RFC 9728)   /.well-known/oauth-protected-resource
//   authorization server metadata (RFC 8414) /.well-known/oauth-authorization-server
//   dynamic client registration (RFC 7591)   POST /oauth/register
//   authorization code + PKCE S256           GET/POST /oauth/authorize, POST /oauth/token
//   issuer in the authorization response     iss (RFC 9207)
//   rotating refresh tokens                  POST /oauth/token (grant_type=refresh_token)
//   token revocation (RFC 7009)              POST /oauth/revoke
//
// Eric approves a connection once, on the consent page, with his desk
// passphrase (the same rate-limited check as the sign-in page). The assistant
// then holds an access token (1 hour) and a refresh token (90 days, replaced
// on every use). Only SHA-256 hashes of tokens are stored, in .cr/oauth.json
// on the desk's disk, so connections survive restarts and deploys. Settings >
// Connected apps lists each connection and disconnects it.
//
// Each connection belongs to one assistant, and what it saves is filed under
// that model. The assistant follows from the only return address the
// connection could use: Claude's hosted callback, ChatGPT's connector
// callbacks, or Gemini's per-user custom-app relay. A program on this computer
// (a loopback return address: Claude Code, Codex, Gemini CLI) is whichever
// model Eric picks on the consent page. No other return address is accepted.

const crypto = require('crypto');
const path = require('path');
const { readJson, jsonText, mkdirp, atomicWrite } = require('./core/fsx');
const { PROVIDERS, PROVIDER_LABELS } = require('./core/workspace');

const STORE_REL = '.cr/oauth.json';
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_MS = 90 * 86400000;
const CODE_TTL_MS = 5 * 60000;
const PENDING_TTL_MS = 10 * 60000;
const MAX_CLIENTS = 50;
const MAX_REDIRECTS = 10;
const MAX_REGISTRATIONS_PER_HOUR = 30;
const SCOPE = 'desk';
const SCOPES = [SCOPE, 'offline_access'];

// Claude's hosted connector callback (claude.com/docs/connectors/building/authentication).
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
// ChatGPT (developers.openai.com/apps-sdk/build/auth): the stable callback when
// the server sends iss in the authorization response, otherwise one per app.
const CHATGPT_CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect';
const CHATGPT_APP_CALLBACK = /^\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/;
// Gemini custom apps: Google's OAuth relay, in its per-user custom-app form
// (/r/ or /a/ then user_bound_custom-mcp-<id>-<server host>; Gemini registers
// both, plus Google's sandbox and test relays, which are not accepted). A
// Google Cloud project ID cannot contain an underscore, so no other project's
// relay path matches.
const GEMINI_RELAY = 'https://oauth-redirect.googleusercontent.com';
const GEMINI_APP_CALLBACK = /^\/[ra]\/user_bound_custom-mcp-[A-Za-z0-9._-]{1,200}$/;
// Loopback callbacks of programs on this computer: Claude Code and Codex use
// /callback, Gemini CLI /oauth/callback.
const LOOPBACK_PATHS = new Set(['/callback', '/oauth/callback']);

const hashOf = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const newToken = (bytes = 32) => b64url(crypto.randomBytes(bytes));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function isLoopback(u) {
  return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
}

// Which assistant a return address belongs to: claude, chatgpt, gemini,
// local (a program on this computer; Eric says which), or null (refused).
function redirectKind(uri) {
  if (uri === CLAUDE_CALLBACK) return 'claude';
  if (uri === CHATGPT_CALLBACK) return 'chatgpt';
  let u;
  try {
    u = new URL(uri);
  } catch (_) {
    return null;
  }
  if (u.search || u.hash || u.username || u.password) return null;
  if (u.origin === 'https://chatgpt.com' && CHATGPT_APP_CALLBACK.test(u.pathname)) return 'chatgpt';
  if (u.origin === GEMINI_RELAY && GEMINI_APP_CALLBACK.test(u.pathname)) return 'gemini';
  if (isLoopback(u) && LOOPBACK_PATHS.has(u.pathname)) return 'local';
  return null;
}

function redirectAllowed(uri) {
  return redirectKind(uri) !== null;
}

// The model a program on this computer most likely is, from the name it gave.
function guessLocal(name) {
  const n = String(name || '');
  if (/gemini/i.test(n)) return 'gemini';
  if (/codex|openai|chatgpt|\bgpt/i.test(n)) return 'chatgpt';
  if (/claude/i.test(n)) return 'claude';
  return null;
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

// The sign-in pages open in a window the assistant's app started (Gemini's
// custom apps hand the result back through Google's relay to the Gemini page
// that opened it). Cross-Origin-Opener-Policy: same-origin, which every other
// page of the desk sends, would cut that link and the code would never reach
// the app, so these pages send unsafe-none. Framing stays forbidden.
const SIGN_IN_COOP = 'unsafe-none';

function page(res, status, html, { formAction = "'self'" } = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Cross-Origin-Opener-Policy': SIGN_IN_COOP,
    // The consent form posts to this site, which then redirects to the
    // assistant: browsers apply form-action to that redirect too.
    'Content-Security-Policy': `default-src 'self'; script-src 'none'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action ${formAction}`,
  });
  res.end(html);
}

function shell(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · CryptoResearch</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/position.css"></head><body><main class="login-wrap">${body}</main></body></html>`;
}

function makeOAuth(ws, { origin, auth, log = () => {} }) {
  const resource = `${origin}/mcp`;
  // The names a client may use for this one resource (some send the origin).
  const resourceNames = new Set([resource, `${resource}/`, origin, `${origin}/`]);
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource`;
  const storeFile = ws.abs(STORE_REL);
  let store = readJson(storeFile, null) || { schema_version: 'cr.oauth.v1', clients: {}, grants: {}, access: {}, refresh: {} };
  for (const k of ['clients', 'grants', 'access', 'refresh']) store[k] = store[k] || {};
  const pending = new Map(); // consent requests in progress (minutes)
  const used = new Map(); // consent requests already answered (minutes), to explain a second submit
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
    for (const [k, v] of used) if (v.expires < now) used.delete(k);
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
    // Every authorization response carries iss (RFC 9207); clients register
    // dynamically (no client ID metadata documents).
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false,
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
    const local = p.kind === 'local';
    const who = local ? 'a program on this computer' : PROVIDER_LABELS[p.kind];
    const msg = locked
      ? `<p class="callout bad" role="alert">Too many attempts. Wait a few minutes, then start the connection again from ${local ? 'the program' : esc(who)}.</p>`
      : error ? `<p class="callout bad" role="alert">${esc(error)}</p>` : '';
    const pick = local
      ? `<label class="field"><span class="field-label">Which model is it?</span><select name="assistant" required><option value=""${p.guess ? '' : ' selected'}>Choose…</option>${PROVIDERS.map((m) => `<option value="${m}"${p.guess === m ? ' selected' : ''}>${esc(PROVIDER_LABELS[m])}${m === 'claude' ? ' (Claude Code)' : m === 'chatgpt' ? ' (Codex)' : ' (Gemini CLI)'}</option>`).join('')}</select></label>
<p class="small muted">Its reports are filed under the model you choose here.</p>`
      : '';
    return shell(`Connect ${local ? 'a program' : who}`, `<form class="card login-card" method="post" action="/oauth/authorize"><h1>Connect ${local ? 'a program on this computer' : esc(who)} to your desk</h1>
<p><strong>${esc(p.client_name || who)}</strong> asks to use your CryptoResearch desk${local ? '' : ` as ${esc(who)}`}. After you approve, it can:</p>
<ul class="small"><li>read your watchlist, research and portfolio</li><li>add projects and save its own research reports, filed as ${local ? 'the model you choose below' : `${esc(who)}'s`}</li><li>record a purchase or sale only when you ask it to</li></ul>
<p class="small muted">It cannot trade, move money or reach any exchange or wallet. You can disconnect it any time in Settings &gt; Connected apps.</p>
<p class="small">After you approve, you go back to <strong>${esc(host)}</strong>.${local ? ' That is a program on this computer (Claude Code, Codex or Gemini CLI); approve only if you just started the connection yourself.' : ' Approve only if you just started this connection yourself.'}</p>
${msg}<input type="hidden" name="request" value="${esc(p.id)}">
${pick}<label class="field"><span class="field-label">Desk passphrase</span><input type="password" name="password" autocomplete="current-password" required autofocus></label>
<div class="btn-row"><button class="btn primary" type="submit" name="decision" value="allow">Approve</button><button class="btn" type="submit" name="decision" value="deny" formnovalidate>Deny</button></div></form>`);
  }

  function errorPage(res, status, text) {
    page(res, status, shell('Connection not possible', `<div class="card login-card"><h1>Connection not possible</h1><p class="callout bad">${esc(text)}</p><p class="small muted">Start the connection again from the assistant's connector or app settings.</p></div>`));
  }

  // The consent form posts here, and the redirect that follows goes to the
  // client's return address: browsers apply form-action to both.
  const formActionFor = (redirect) => {
    try {
      return `'self' ${new URL(redirect).origin}`;
    } catch (_) {
      return "'self'";
    }
  };

  function redirectTo(res, uri, params) {
    const u = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
    res.writeHead(303, { Location: u.toString(), 'Cache-Control': 'no-store', 'Cross-Origin-Opener-Policy': SIGN_IN_COOP });
    res.end();
  }

  // Where a return address goes, for the log (host and path; never a query).
  const where = (list) => list.map((x) => {
    try {
      const u = new URL(x);
      return `${u.host}${u.pathname.slice(0, 90)}`;
    } catch (_) {
      return '(unreadable)';
    }
  }).join(', ');
  const labelOf = (kind) => (kind === 'local' ? 'a program on this computer' : PROVIDER_LABELS[kind] || kind);

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
    const asked = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === 'string') : [];
    // Return addresses that are not an assistant's are dropped; one client
    // belongs to one assistant.
    const uris = asked.filter(redirectAllowed).slice(0, MAX_REDIRECTS);
    const kinds = [...new Set(uris.map(redirectKind))];
    if (!uris.length || kinds.length !== 1) {
      log(`OAuth: registration refused (return to ${where(asked.slice(0, 5)) || 'nothing'})`);
      return json(res, 400, { error: 'invalid_redirect_uri', error_description: `Only the assistants' own callbacks are accepted, all from one assistant: Claude (${CLAUDE_CALLBACK}), ChatGPT (${CHATGPT_CALLBACK} or https://chatgpt.com/connector/oauth/<id>), Gemini custom apps (${GEMINI_RELAY}/r/user_bound_custom-mcp-...), or a program on this computer (http://localhost or http://127.0.0.1, any port, /callback or /oauth/callback).` });
    }
    const grantTypes = Array.isArray(body.grant_types) && body.grant_types.length ? body.grant_types : ['authorization_code', 'refresh_token'];
    if (!grantTypes.every((g) => ['authorization_code', 'refresh_token'].includes(g))) return json(res, 400, { error: 'invalid_client_metadata', error_description: 'Only authorization_code and refresh_token grants are supported.' });
    registrations.push({ at: Date.now(), addr });
    const kind = kinds[0];
    const clientId = `crc_${newToken(16)}`;
    // Every client is public (PKCE, no secret). A client that asked for a
    // secret method (Gemini asks for client_secret_basic) is told "none".
    const client = {
      client_name: typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.slice(0, 100) : kind === 'local' ? 'A program on this computer' : PROVIDER_LABELS[kind],
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      created_at: new Date().toISOString(),
      kind,
    };
    store.clients[clientId] = client;
    pruneClients();
    save();
    const dropped = asked.length - uris.length;
    log(`OAuth: client registered (${client.client_name}; ${labelOf(kind)}; return to ${where(uris)}; asked for ${typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method.slice(0, 40) : 'no auth method'}, scope ${typeof body.scope === 'string' ? body.scope.slice(0, 80) : 'none'}${dropped ? `; ${dropped} other return address(es) dropped: ${where(asked.filter((u) => !uris.includes(u)).slice(0, 6))}` : ''})`);
    return json(res, 201, { client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), ...client, created_at: undefined, kind: undefined });
  }

  function authorizeGet(req, res, url) {
    sweep();
    const q = Object.fromEntries(url.searchParams);
    const client = q.client_id ? store.clients[q.client_id] : null;
    if (!client) return errorPage(res, 400, 'Unknown client. The assistant registers itself first; start the connection again from the assistant.');
    const redirect = q.redirect_uri || (client.redirect_uris.length === 1 ? client.redirect_uris[0] : null);
    const kind = redirect ? redirectKind(redirect) : null;
    if (!redirect || !client.redirect_uris.some((r) => redirectMatches(r, redirect)) || !kind) {
      return errorPage(res, 400, 'The return address is not one of the assistants\' own, so the connection was refused.');
    }
    // From here on, problems go back to the assistant as OAuth errors.
    if (q.response_type !== 'code') return redirectTo(res, redirect, { error: 'unsupported_response_type', state: q.state, iss: origin });
    if (!q.code_challenge || q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) return redirectTo(res, redirect, { error: 'invalid_request', error_description: 'PKCE with S256 is required.', state: q.state, iss: origin });
    if (q.resource && !resourceNames.has(q.resource)) return redirectTo(res, redirect, { error: 'invalid_target', error_description: `This server's resource is ${resource}.`, state: q.state, iss: origin });
    const scope = SCOPES.filter((s) => String(q.scope || SCOPE).split(/\s+/).includes(s)).join(' ') || SCOPE;
    const id = newToken(18);
    const p = { id, client_id: q.client_id, client_name: client.client_name, redirect_uri: redirect, kind, guess: kind === 'local' ? guessLocal(client.client_name) : null, code_challenge: q.code_challenge, state: q.state || null, scope, expires: Date.now() + PENDING_TTL_MS };
    pending.set(id, p);
    log(`OAuth: approval page shown (${client.client_name}; ${labelOf(kind)}; return to ${where([redirect])}; resource ${q.resource ? 'given' : 'not given'}; scope ${String(q.scope || 'not given').slice(0, 80)})`);
    return page(res, 200, consentPage(p), { formAction: formActionFor(redirect) });
  }

  async function authorizePost(req, res) {
    sweep();
    if (!auth.fromThisSite(req)) return errorPage(res, 403, 'Approval is only accepted from this site\'s own page.');
    const form = new URLSearchParams(await readBody(req, 4096));
    const rid = form.get('request') || '';
    const p = pending.get(rid);
    if (!p) {
      // A page submitted a second time (the back button, or a double click)
      // after its approval already went to the assistant.
      const done = used.get(rid);
      log(`OAuth: approval page submitted again (${done ? `already ${done.decision} at ${done.at}` : 'expired or unknown'})`);
      if (done) {
        const who = done.label;
        return errorPage(res, 400, `This approval was already ${done.decision === 'approved' ? 'given' : 'answered'} (${done.at.slice(11, 16)} UTC) and sent back to ${who}. If ${who.replace(/^the program on this computer \((.*)\)$/, '$1')} did not finish connecting, the problem came after that step: start the connection again from there.`);
      }
      return errorPage(res, 400, 'This approval page has expired. Start the connection again from the assistant.');
    }
    const formAction = formActionFor(p.redirect_uri);
    const answered = (decision, assistant = null) => {
      pending.delete(p.id);
      const label = p.kind !== 'local' ? PROVIDER_LABELS[p.kind] : assistant ? `the program on this computer (${PROVIDER_LABELS[assistant]})` : 'the program on this computer';
      used.set(p.id, { decision, label, at: new Date().toISOString(), expires: Date.now() + PENDING_TTL_MS });
    };
    if (form.get('decision') !== 'allow') {
      answered('denied');
      log(`OAuth: connection denied (${p.client_name})`);
      return redirectTo(res, p.redirect_uri, { error: 'access_denied', state: p.state, iss: origin });
    }
    // The model this connection files its work under: fixed by the return
    // address, or chosen by Eric for a program on this computer.
    const assistant = p.kind === 'local' ? form.get('assistant') : p.kind;
    if (!PROVIDERS.includes(assistant)) return page(res, 200, consentPage(p, { error: 'Choose which model this program is.' }), { formAction });
    const check = await auth.verifyPassphrase(req, form.get('password') || '');
    if (!check.ok) {
      log(`OAuth: approval refused (${check.locked ? 'locked after repeated attempts' : 'wrong passphrase'})`);
      return page(res, 200, consentPage(p, { error: check.locked ? null : 'That passphrase is not right.', locked: check.locked }), { formAction });
    }
    answered('approved', assistant);
    log(`OAuth: connection approved (${p.client_name}; ${PROVIDER_LABELS[assistant]}); sent back to ${where([p.redirect_uri])}, waiting for its token request`);
    const code = newToken();
    codes.set(hashOf(code), { client_id: p.client_id, redirect_uri: p.redirect_uri, code_challenge: p.code_challenge, scope: p.scope, assistant, expires: Date.now() + CODE_TTL_MS });
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
        log('OAuth: token request refused (a JSON body that could not be read)');
        return json(res, 400, { error: 'invalid_request', error_description: 'Unreadable body.' });
      }
    } else form = new URLSearchParams(raw);
    const grant = form.get('grant_type');
    // A client that registered for client_secret_basic may still send its ID
    // in a Basic header. No client has a secret: PKCE (and the rotating
    // refresh token) is what proves the caller.
    let clientId = form.get('client_id');
    const basic = String(req.headers.authorization || '').match(/^Basic\s+([A-Za-z0-9+/=]+)$/);
    if (!clientId && basic) {
      try {
        clientId = decodeURIComponent(Buffer.from(basic[1], 'base64').toString('utf8').split(':')[0]);
      } catch (_) {
        clientId = null;
      }
    }
    // Every token request is logged with its outcome (never a code, token or secret).
    const how = form.get('client_id') ? 'client_id in the body' : basic ? 'client_id in a Basic header' : 'no client_id';
    const refuse = (status, error, description) => {
      log(`OAuth: token request refused (${grant || 'no grant_type'}; ${store.clients[clientId] ? store.clients[clientId].client_name : 'unknown client'}; ${how}; ${type.split(';')[0] || 'no content type'}): ${error}: ${description}`);
      return json(res, status, { error, error_description: description });
    };
    if (!clientId || !store.clients[clientId]) return refuse(401, 'invalid_client', 'Unknown client.');
    if (grant === 'authorization_code') {
      const key = hashOf(form.get('code') || '');
      const c = codes.get(key);
      codes.delete(key); // single use, even when the exchange fails
      if (!c || c.expires < Date.now() || c.client_id !== clientId) return refuse(400, 'invalid_grant', 'The authorization code is invalid or expired.');
      if ((form.get('redirect_uri') || c.redirect_uri) !== c.redirect_uri) return refuse(400, 'invalid_grant', `redirect_uri does not match the authorization request (sent ${where([form.get('redirect_uri')])}).`);
      const verifier = form.get('code_verifier') || '';
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || b64url(crypto.createHash('sha256').update(verifier).digest()) !== c.code_challenge) return refuse(400, 'invalid_grant', `PKCE verification failed (${verifier ? 'wrong verifier' : 'no code_verifier'}).`);
      if (form.get('resource') && !resourceNames.has(form.get('resource'))) return refuse(400, 'invalid_target', `This server's resource is ${resource} (sent ${String(form.get('resource')).slice(0, 100)}).`);
      const grantId = `grant_${newToken(9)}`;
      store.grants[grantId] = { client_id: clientId, client_name: store.clients[clientId].client_name, assistant: c.assistant, created_at: new Date().toISOString(), last_used_at: null, revoked_at: null };
      log(`OAuth: tokens issued for a new connection (${store.clients[clientId].client_name}; ${PROVIDER_LABELS[c.assistant]})`);
      return json(res, 200, issue(grantId, clientId, c.scope));
    }
    if (grant === 'refresh_token') {
      const key = hashOf(form.get('refresh_token') || '');
      const r = store.refresh[key];
      if (!r || r.client_id !== clientId || Date.parse(r.expires_at) < Date.now() || !store.grants[r.grant_id] || store.grants[r.grant_id].revoked_at) {
        return refuse(400, 'invalid_grant', 'The refresh token is invalid, expired or revoked. Reconnect from the assistant.');
      }
      delete store.refresh[key]; // rotated: the old refresh token stops working now
      log(`OAuth: tokens refreshed (${store.clients[clientId].client_name})`);
      return json(res, 200, issue(r.grant_id, clientId, r.scope));
    }
    return refuse(400, 'unsupported_grant_type', 'Only authorization_code and refresh_token are supported.');
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
    // Connections made before ChatGPT and Gemini could connect were all Claude's.
    const assistant = PROVIDERS.includes(g.assistant) ? g.assistant : 'claude';
    return { grant_id: rec.grant_id, client_id: rec.client_id, client_name: g.client_name, assistant, scope: rec.scope };
  }

  function challenge(res, { invalid = false } = {}) {
    res.writeHead(401, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl}", scope="${SCOPE}"${invalid ? ', error="invalid_token"' : ''}`,
    });
    res.end(JSON.stringify({ error: invalid ? 'invalid_token' : 'unauthorized', error_description: 'Sign in to the CryptoResearch desk through the assistant\'s connector or app settings.' }));
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
        .map(([id, g]) => {
          const assistant = PROVIDERS.includes(g.assistant) ? g.assistant : 'claude';
          return { grant_id: id, client_name: g.client_name, assistant, assistant_label: PROVIDER_LABELS[assistant], created_at: g.created_at, last_used_at: g.last_used_at };
        })
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    },
    revoke: revokeGrant,
  };
}

module.exports = { makeOAuth, redirectAllowed, redirectKind, redirectMatches, guessLocal, CLAUDE_CALLBACK, CHATGPT_CALLBACK, STORE_REL };
