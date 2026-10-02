'use strict';
// Model-provider adapters for research jobs (Anthropic, OpenAI, Google Gemini).
//
// Each adapter sends ONE research prompt, with the provider's own web-search
// tool when maxSearches > 0, so the model retrieves current sources itself, and
// returns the text plus the identifiers the provider reports (attested:
// request/response IDs, model) and token usage. Nothing here decides whether a
// call may be made; the research runner checks keys, models, prices, bounds and
// budget first.
//
// Search bounds (audit V2-005), as each provider documents them:
//   Claude   web_search tool max_uses: a hard cap on searches in the request.
//   ChatGPT  max_tool_calls: a cap on all built-in tool calls in the response.
//   Gemini   google_search has no request parameter that caps searches; the
//            runner refuses search for Gemini unless per-request billing is
//            declared. Nothing here invents a cap.
// maxSearches 0 sends no search tool at all. No default replaces it here.
//
// Secrets: API keys come from environment variables or
// ~/.cryptoresearch/secrets.json (outside the workspace). They are never written
// to the workspace, logs, exports or the browser.
//
// These adapters follow each provider's documented HTTP API. They were tested
// against recorded fixture responses, not live accounts.
//
// Transport timeouts (audit F2, 2026-10-02 review). Node's built-in fetch is
// Undici, whose connection pool waits at most 300 s for response headers and
// 300 s between body chunks unless told otherwise (Undici Client options
// headersTimeout / bodyTimeout). A non-streaming research call answers only
// when the whole report is written, so a call taking longer than 5 minutes
// failed with UND_ERR_HEADERS_TIMEOUT even though the configured research
// timeout (default 600 s) allowed it, and that failure is an "uncertain"
// outcome: probably billed, no answer. Each call therefore goes through a
// dispatcher whose transport limits sit just above the research timeout, so
// the research timeout (an AbortSignal) is the one that ends a slow call. No
// dependency is added: the dispatcher is Node's own bundled Undici Agent,
// reached through the documented global-dispatcher symbol. If it cannot be
// reached, nothing is sent.

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROVIDER_API = {
  claude: { vendor: 'Anthropic', env: ['ANTHROPIC_API_KEY'], secret: 'anthropic_api_key', docs: 'https://docs.anthropic.com/en/api/messages' },
  chatgpt: { vendor: 'OpenAI', env: ['OPENAI_API_KEY'], secret: 'openai_api_key', docs: 'https://platform.openai.com/docs/api-reference/responses' },
  gemini: { vendor: 'Google', env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], secret: 'gemini_api_key', docs: 'https://ai.google.dev/api/generate-content' },
};

function secretsFile() {
  return path.join(os.homedir(), '.cryptoresearch', 'secrets.json');
}

function readSecrets() {
  try {
    return JSON.parse(fs.readFileSync(secretsFile(), 'utf8'));
  } catch (_) {
    return {};
  }
}

// Returns the key itself (server-side use only).
function apiKeyFor(provider) {
  const spec = PROVIDER_API[provider];
  if (!spec) return null;
  for (const e of spec.env) if (process.env[e]) return process.env[e];
  const s = readSecrets();
  return s[spec.secret] || null;
}

// Safe to show: where a key would come from and whether one is present.
function keyStatus(provider) {
  const spec = PROVIDER_API[provider];
  const env = spec.env.find((e) => process.env[e]);
  if (env) return { present: true, source: `environment variable ${env}` };
  const s = readSecrets();
  if (s[spec.secret]) return { present: true, source: `${secretsFile()} (${spec.secret})` };
  return { present: false, source: null, how: `Put "${spec.secret}" in ${secretsFile()} or set ${spec.env.join(' or ')}` };
}

class ProviderError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind; // timeout | http | network | empty | canceled | config
    Object.assign(this, extra);
  }
}

// Connection errors raised before any request bytes could be sent (refused,
// no route, name not resolved, connect timeout). Anything else after the
// request started may have reached the provider.
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'ENETUNREACH', 'EHOSTUNREACH']);

function causeCode(err) {
  const c = err && err.cause;
  if (c && c.code) return c.code;
  if (c && Array.isArray(c.errors) && c.errors[0] && c.errors[0].code) return c.errors[0].code;
  return err && err.code ? err.code : null;
}

const GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');
const TRANSPORT_MARGIN_MS = 30000;
const agents = new Map();

// Node's bundled Undici Agent with header and body limits above the research
// timeout, or null when this Node does not expose it.
function transportFor(timeoutMs) {
  const ms = Math.ceil(timeoutMs) + TRANSPORT_MARGIN_MS;
  if (agents.has(ms)) return agents.get(ms);
  if (!globalThis[GLOBAL_DISPATCHER]) {
    // Building a Request loads fetch's dispatcher without any network access.
    try { new Request('http://127.0.0.1/'); } catch (_) { /* checked below */ }
  }
  const g = globalThis[GLOBAL_DISPATCHER];
  const Agent = g && g.constructor;
  if (typeof Agent !== 'function' || Agent.name !== 'Agent') return null;
  let agent;
  try {
    agent = new Agent({ headersTimeout: ms, bodyTimeout: ms });
  } catch (_) {
    return null;
  }
  agents.set(ms, agent);
  return agent;
}

function transportInfo(timeoutMs) {
  const a = transportFor(timeoutMs);
  return { node: process.version, undici: process.versions.undici || null, dispatcher: a ? 'bundled Undici Agent' : null, headers_timeout_ms: a ? Math.ceil(timeoutMs) + TRANSPORT_MARGIN_MS : null, body_timeout_ms: a ? Math.ceil(timeoutMs) + TRANSPORT_MARGIN_MS : null, research_timeout_ms: timeoutMs };
}

async function post(fetchImpl, url, headers, body, { signal, dispatcher }) {
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal, dispatcher });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new ProviderError('timeout', 'The provider did not answer before the time limit. A request that was sent may still be billed.');
    if (err.name === 'AbortError') throw new ProviderError('canceled', 'Canceled. A request that was already sent may still be billed.');
    const code = causeCode(err);
    if (code && NOT_SENT_CODES.has(code)) throw new ProviderError('network', `Could not connect (${code}); the request was not sent.`, { code, notSent: true });
    throw new ProviderError('network', `Network error${code ? ` (${code})` : ''}: ${err.message}`, { code });
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) { /* keep raw */ }
  const requestId = res.headers && typeof res.headers.get === 'function' ? res.headers.get('request-id') || res.headers.get('x-request-id') || null : null;
  if (!res.ok) {
    const msg = json && json.error ? (json.error.message || JSON.stringify(json.error)).slice(0, 300) : text.slice(0, 300);
    throw new ProviderError('http', `HTTP ${res.status}: ${msg}`, { httpStatus: res.status, requestId, raw: json || text, retryable: res.status === 429 || res.status >= 500 });
  }
  return { json, raw: text, requestId };
}

// --- Anthropic Messages API with the server-side web search tool -------------
async function callClaude({ model, prompt, maxOutputTokens, maxSearches, key, signal, fetchImpl, dispatcher }) {
  const body = {
    model,
    max_tokens: maxOutputTokens,
    messages: [{ role: 'user', content: prompt }],
  };
  if (maxSearches > 0) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearches }];
  const { json, raw, requestId } = await post(fetchImpl, 'https://api.anthropic.com/v1/messages', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body, { signal, dispatcher });
  const text = (json && Array.isArray(json.content) ? json.content : []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const u = (json && json.usage) || {};
  return {
    text,
    raw,
    attested: { provider: 'anthropic', model: json && json.model, response_id: json && json.id, request_id: requestId, stop_reason: json && json.stop_reason },
    usage: { input_tokens: u.input_tokens ?? null, output_tokens: u.output_tokens ?? null, search_calls: u.server_tool_use ? u.server_tool_use.web_search_requests ?? null : null },
  };
}

// --- OpenAI Responses API with the web search tool -------------------------------
async function callChatgpt({ model, prompt, maxOutputTokens, maxSearches, key, signal, fetchImpl, dispatcher }) {
  const body = { model, input: prompt, max_output_tokens: maxOutputTokens, store: false };
  if (maxSearches > 0) {
    body.tools = [{ type: 'web_search' }];
    body.max_tool_calls = maxSearches;
  }
  const { json, raw, requestId } = await post(fetchImpl, 'https://api.openai.com/v1/responses', { authorization: `Bearer ${key}` }, body, { signal, dispatcher });
  let text = '';
  if (json && typeof json.output_text === 'string') text = json.output_text;
  else if (json && Array.isArray(json.output)) {
    text = json.output.filter((o) => o.type === 'message').flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('\n');
  }
  const u = (json && json.usage) || {};
  // Every web_search_call counts toward max_tool_calls; the search fee is for
  // search actions (open_page and find_in_page are not search queries). An item
  // without an action type is counted as a search.
  const calls = json && Array.isArray(json.output) ? json.output.filter((o) => o.type === 'web_search_call') : null;
  const searches = calls ? calls.filter((o) => !o.action || !o.action.type || o.action.type === 'search').length : null;
  return {
    text: String(text || '').trim(),
    raw,
    attested: { provider: 'openai', model: json && json.model, response_id: json && json.id, request_id: requestId, status: json && json.status },
    usage: { input_tokens: u.input_tokens ?? null, output_tokens: u.output_tokens ?? null, search_calls: searches, tool_calls: calls ? calls.length : null },
  };
}

// --- Gemini generateContent with Google Search grounding ------------------------
async function callGemini({ model, prompt, maxOutputTokens, maxSearches, key, signal, fetchImpl, dispatcher }) {
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens } };
  // google_search has no parameter that limits searches (see the header).
  if (maxSearches > 0) body.tools = [{ google_search: {} }];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const { json, raw, requestId } = await post(fetchImpl, url, { 'x-goog-api-key': key }, body, { signal, dispatcher });
  const cand = json && Array.isArray(json.candidates) ? json.candidates[0] : null;
  const text = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts.map((p) => p.text || '').join('\n').trim() : '';
  const u = (json && json.usageMetadata) || {};
  const grounding = cand && cand.groundingMetadata ? (cand.groundingMetadata.webSearchQueries || []).length : null;
  return {
    text,
    raw,
    attested: { provider: 'google', model: (json && json.modelVersion) || model, response_id: json && json.responseId, request_id: requestId, finish_reason: cand && cand.finishReason },
    usage: { input_tokens: u.promptTokenCount ?? null, output_tokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) || null, search_calls: grounding },
  };
}

const CALLS = { claude: callClaude, chatgpt: callChatgpt, gemini: callGemini };

async function callProvider(provider, opts) {
  const fn = CALLS[provider];
  if (!fn) throw new ProviderError('config', `Unknown provider ${provider}`);
  // Bounds are checked before anything is sent; nothing substitutes a default.
  if (!Number.isInteger(opts.maxOutputTokens) || opts.maxOutputTokens < 1) throw new ProviderError('config', 'No valid output token limit; not sent.');
  if (!Number.isInteger(opts.maxSearches) || opts.maxSearches < 0) throw new ProviderError('config', 'No valid search limit (0 turns search off); not sent.');
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) throw new ProviderError('config', 'No valid research timeout; not sent.');
  const dispatcher = transportFor(opts.timeoutMs);
  if (!dispatcher) throw new ProviderError('config', `This Node.js (${process.version}) does not expose the fetch dispatcher needed to raise its 300-second transport limits to the research timeout; not sent.`);
  const out = await fn({ ...opts, dispatcher, fetchImpl: opts.fetchImpl || fetch });
  if (!out.text) throw new ProviderError('empty', 'The provider answered without any report text.', { raw: out.raw, attested: out.attested, usage: out.usage });
  return out;
}

module.exports = { PROVIDER_API, apiKeyFor, keyStatus, callProvider, ProviderError, secretsFile, transportFor, transportInfo, TRANSPORT_MARGIN_MS };
