'use strict';
// One guarded HTTPS GET, for the forensic product checks (forensic-monitor.js):
// the addresses come from an assessment and Eric's approval, so they are
// treated as untrusted. The guard:
// - accepts https URLs on port 443 only, by domain name (no IP literal, no
//   user name or password, no localhost, .local, .internal or single-label
//   host);
// - checks every address the name resolves to at connect time (the socket's
//   own lookup), so a name that resolves to a private, loopback, link-local,
//   shared, documentation, multicast or reserved address is refused, also
//   when it changes between checks (DNS rebinding);
// - follows at most a few redirects, checking each target the same way;
// - reads at most maxBytes of the body (the rest is not read), decompresses
//   gzip, deflate or brotli within the same cap, and gives up after timeoutMs
//   overall;
// - sends no cookie, no credential and no referrer, and runs no script.
// The body is returned for the caller to hash and search; it is page text,
// never an instruction.

const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const zlib = require('zlib');

const USER_AGENT = 'CryptoResearch-desk/1 (read-only product availability check)';
const BLOCKED_HOST = /(^localhost$)|(\.localhost$)|(\.local$)|(\.internal$)|(\.home\.arpa$)|(\.lan$)|(\.intranet$)|(\.corp$)/i;

const BLOCK = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) BLOCK.addSubnet(a, p, 'ipv4');
// IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are judged by the IPv4 rules
// above (BlockList applies them to mapped addresses); a ::ffff:0:0/96 rule
// would match every IPv4 address, so there is none.
for (const [a, p] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) BLOCK.addSubnet(a, p, 'ipv6');

// Whether an address is a public unicast address the desk may connect to.
function addressAllowed(address) {
  const v = net.isIP(String(address || ''));
  if (!v) return false;
  return !BLOCK.check(String(address), v === 4 ? 'ipv4' : 'ipv6');
}

// Whether a URL may be checked at all, before any lookup. Pure.
function validateUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch (_) {
    return { ok: false, reason: 'Not a valid address.' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'Only https addresses are checked.' };
  if (u.username || u.password) return { ok: false, reason: 'An address with a user name or password is not checked.' };
  if (u.port && u.port !== '443') return { ok: false, reason: 'Only the standard https port (443) is checked.' };
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(host)) return { ok: false, reason: 'An address by IP number is not checked; use the product\'s domain name.' };
  if (!host.includes('.') || BLOCKED_HOST.test(host)) return { ok: false, reason: 'A local or internal host name is not checked.' };
  if (u.href.length > 2000) return { ok: false, reason: 'The address is too long.' };
  u.hash = '';
  return { ok: true, url: u.toString(), host };
}

// The socket's lookup: every resolved address must be public.
function guardedLookup(lookupImpl) {
  return (hostname, options, cb) => {
    const opts = typeof options === 'object' && options ? options : {};
    lookupImpl(hostname, { all: true, verbatim: true, family: opts.family || 0 }, (err, addrs) => {
      if (err) return cb(err);
      const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: net.isIP(addrs) }];
      const ok = list.filter((a) => addressAllowed(a.address));
      if (!ok.length || ok.length !== list.length) {
        const e = new Error(`${hostname} resolves to an address the desk does not connect to (private, local or reserved).`);
        e.code = 'CR_REFUSED_ADDRESS';
        return cb(e);
      }
      if (opts.all) return cb(null, ok);
      return cb(null, ok[0].address, ok[0].family);
    });
  };
}

// The real transport: one request, the guarded lookup on its socket.
function defaultTransport(url, { lookup, headers, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, { method: 'GET', headers, lookup, timeout: timeoutMs, agent: false }, (res) => resolve({ status: res.statusCode, headers: res.headers, stream: res, abort: () => req.destroy() }));
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

function errorClass(err) {
  const c = err && err.code;
  if (c === 'CR_REFUSED_ADDRESS') return 'refused_address';
  if (c === 'ETIMEDOUT' || c === 'CR_TIMEOUT') return 'timeout';
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN' || c === 'ENODATA') return 'dns';
  if (c === 'ECONNREFUSED' || c === 'ECONNRESET' || c === 'EHOSTUNREACH' || c === 'ENETUNREACH' || c === 'EPIPE') return 'connect';
  if (typeof c === 'string' && (/^ERR_TLS|CERT|SSL/.test(c) || c === 'DEPTH_ZERO_SELF_SIGNED_CERT' || c === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')) return 'tls';
  return 'network';
}

// Reads a response body up to maxBytes (decompressed), then stops reading.
function readCapped(resp, maxBytes, deadline) {
  return new Promise((resolve) => {
    const enc = String((resp.headers && resp.headers['content-encoding']) || '').toLowerCase().trim();
    let src = resp.stream;
    let decoder = null;
    if (enc === 'gzip' || enc === 'x-gzip') decoder = zlib.createGunzip();
    else if (enc === 'deflate') decoder = zlib.createInflate();
    else if (enc === 'br') decoder = zlib.createBrotliDecompress();
    if (decoder) {
      src.on('error', () => decoder.destroy());
      src = src.pipe(decoder);
    }
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (truncated, error = null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (resp.abort) resp.abort(); } catch (_) { /* closed */ }
      resolve({ body: Buffer.concat(chunks), truncated, error, encoding: enc || null });
    };
    const timer = setTimeout(() => finish(true, 'timeout'), Math.max(1, deadline - Date.now()));
    src.on('data', (c) => {
      if (done) return;
      const room = maxBytes - size;
      if (c.length >= room) {
        chunks.push(c.subarray(0, room));
        size = maxBytes;
        finish(true);
        return;
      }
      chunks.push(c);
      size += c.length;
    });
    src.on('end', () => finish(false));
    src.on('error', (e) => finish(false, e && e.code === 'Z_DATA_ERROR' ? 'bad_encoding' : 'read_error'));
  });
}

// GET one URL under the guard. Never throws: the result says what happened.
//   { ok, status, final_url, redirects, content_type, bytes, truncated, body,
//     elapsed_ms, error_class, error }
async function safeGet(raw, { timeoutMs = 10000, maxBytes = 256 * 1024, maxRedirects = 3, lookupImpl = dns.lookup, transport = defaultTransport, now = Date.now } = {}) {
  const started = now();
  const deadline = started + timeoutMs;
  const redirects = [];
  const first = validateUrl(raw);
  if (!first.ok) return { ok: false, error_class: 'refused_target', error: first.reason, redirects, elapsed_ms: 0 };
  let current = new URL(first.url);
  const lookup = guardedLookup(lookupImpl);
  const headers = { 'user-agent': USER_AGENT, accept: 'text/html,application/json;q=0.9,*/*;q=0.5', 'accept-encoding': 'identity', connection: 'close' };
  for (let hop = 0; ; hop++) {
    const left = deadline - now();
    if (left <= 0) return { ok: false, error_class: 'timeout', error: `No answer within ${Math.round(timeoutMs / 1000)} seconds.`, redirects, elapsed_ms: now() - started };
    let resp;
    try {
      resp = await Promise.race([
        transport(current, { lookup, headers, timeoutMs: left }),
        new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'CR_TIMEOUT' })), left)),
      ]);
    } catch (err) {
      const cls = errorClass(err);
      return { ok: false, error_class: cls, error: cls === 'refused_address' ? err.message : `${cls === 'timeout' ? 'No answer in time' : 'The request failed'} (${String(err.code || err.message).slice(0, 80)}).`, final_url: current.toString(), redirects, elapsed_ms: now() - started };
    }
    const status = resp.status;
    if ([301, 302, 303, 307, 308].includes(status) && resp.headers && resp.headers.location) {
      try { if (resp.abort) resp.abort(); } catch (_) { /* closed */ }
      if (hop >= maxRedirects) return { ok: false, error_class: 'too_many_redirects', error: `More than ${maxRedirects} redirects.`, status, final_url: current.toString(), redirects, elapsed_ms: now() - started };
      let next;
      try {
        next = new URL(String(resp.headers.location), current);
      } catch (_) {
        return { ok: false, error_class: 'bad_redirect', error: 'A redirect to an unreadable address.', status, final_url: current.toString(), redirects, elapsed_ms: now() - started };
      }
      const v = validateUrl(next.toString());
      if (!v.ok) return { ok: false, error_class: 'refused_redirect', error: `A redirect to an address the desk does not check: ${v.reason}`, status, final_url: current.toString(), redirects, elapsed_ms: now() - started };
      redirects.push({ status, to: v.url });
      current = new URL(v.url);
      continue;
    }
    const read = await readCapped(resp, maxBytes, deadline);
    return {
      ok: !read.error || read.error === 'timeout',
      status,
      final_url: current.toString(),
      redirects,
      content_type: resp.headers ? String(resp.headers['content-type'] || '').slice(0, 120) || null : null,
      bytes: read.body.length,
      truncated: read.truncated,
      body: read.body,
      read_error: read.error,
      elapsed_ms: now() - started,
      error_class: null,
      error: null,
    };
  }
}

// A fetch() answer's body as text, read while counting bytes: over maxBytes
// the read stops and the request is aborted, so an oversized answer is never
// buffered whole (the quote and GitHub readers; review P3). A declared
// Content-Length over the cap is refused before reading. An answer object
// without a stream (a test stub) is read with text() and checked after.
async function readBodyBounded(res, maxBytes, ctrl = null) {
  const tooLarge = () => Object.assign(new Error(`Answer too large (over ${Math.round(maxBytes / 1024)} KB)`), { code: 'CR_TOO_LARGE' });
  const h = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : null;
  if (h !== null && h !== undefined && Number(h) > maxBytes) {
    try { if (ctrl) ctrl.abort(); } catch (_) { /* closed */ }
    throw tooLarge();
  }
  if (res && res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        try { await reader.cancel(); } catch (_) { /* closed */ }
        try { if (ctrl) ctrl.abort(); } catch (_) { /* closed */ }
        throw tooLarge();
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const text = await res.text();
  if (Buffer.byteLength(text) > maxBytes) throw tooLarge();
  return text;
}

module.exports = { addressAllowed, validateUrl, guardedLookup, safeGet, readBodyBounded, errorClass, USER_AGENT };
