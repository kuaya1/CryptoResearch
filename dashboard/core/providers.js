'use strict';
// Model-provider adapters for research jobs (Anthropic, OpenAI, Google Gemini).
//
// Each adapter sends ONE research prompt with the provider's own web-search tool
// enabled, so the model retrieves current sources itself, and returns the text
// plus the identifiers the provider reports (attested: request/response IDs,
// model) and token usage. Nothing here decides whether a call may be made; the
// research runner checks keys, models, prices and budget first.
//
// Secrets: API keys come from environment variables or
// ~/.cryptoresearch/secrets.json (outside the workspace). They are never written
// to the workspace, logs, exports or the browser.
//
// These adapters follow each provider's documented HTTP API. They were tested
// against recorded fixture responses, not live accounts.

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
    this.kind = kind; // timeout | http | network | empty | canceled
    Object.assign(this, extra);
  }
}

async function post(fetchImpl, url, headers, body, { signal }) {
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new ProviderError('timeout', 'The provider did not answer before the time limit. A request that was sent may still be billed.');
    if (err.name === 'AbortError') throw new ProviderError('canceled', 'Canceled. A request that was already sent may still be billed.');
    throw new ProviderError('network', `Network error: ${err.message}`);
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
async function callClaude({ model, prompt, maxOutputTokens, maxSearches, key, signal, fetchImpl }) {
  const body = {
    model,
    max_tokens: maxOutputTokens,
    messages: [{ role: 'user', content: prompt }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearches }],
  };
  const { json, raw, requestId } = await post(fetchImpl, 'https://api.anthropic.com/v1/messages', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body, { signal });
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
async function callChatgpt({ model, prompt, maxOutputTokens, key, signal, fetchImpl }) {
  const body = { model, input: prompt, tools: [{ type: 'web_search' }], max_output_tokens: maxOutputTokens, store: false };
  const { json, raw, requestId } = await post(fetchImpl, 'https://api.openai.com/v1/responses', { authorization: `Bearer ${key}` }, body, { signal });
  let text = '';
  if (json && typeof json.output_text === 'string') text = json.output_text;
  else if (json && Array.isArray(json.output)) {
    text = json.output.filter((o) => o.type === 'message').flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('\n');
  }
  const u = (json && json.usage) || {};
  const searches = json && Array.isArray(json.output) ? json.output.filter((o) => o.type === 'web_search_call').length : null;
  return {
    text: String(text || '').trim(),
    raw,
    attested: { provider: 'openai', model: json && json.model, response_id: json && json.id, request_id: requestId, status: json && json.status },
    usage: { input_tokens: u.input_tokens ?? null, output_tokens: u.output_tokens ?? null, search_calls: searches },
  };
}

// --- Gemini generateContent with Google Search grounding ------------------------
async function callGemini({ model, prompt, maxOutputTokens, key, signal, fetchImpl }) {
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { maxOutputTokens } };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const { json, raw, requestId } = await post(fetchImpl, url, { 'x-goog-api-key': key }, body, { signal });
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
  const out = await fn({ ...opts, fetchImpl: opts.fetchImpl || fetch });
  if (!out.text) throw new ProviderError('empty', 'The provider answered without any report text.', { raw: out.raw, attested: out.attested, usage: out.usage });
  return out;
}

module.exports = { PROVIDER_API, apiKeyFor, keyStatus, callProvider, ProviderError, secretsFile };
