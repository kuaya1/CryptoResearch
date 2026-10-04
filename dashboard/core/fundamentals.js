'use strict';
// DefiLlama fundamentals: the fees, revenue and holders revenue DefiLlama
// reports for the entity bound to a project, over the previous 30 completed
// UTC days. Dated research evidence that research.js freezes into each new
// run's evidence packet; never a price tick, a valuation ratio or a grade.
//
// Binding (the project identity's `defillama`, set through projects.js):
//   slug         the exact DefiLlama slug (defillama.com/protocol/<slug>)
//   scope        product: one protocol or version; parent: DefiLlama's parent
//                entity including its child protocols (DefiLlama's own
//                aggregate); chain: a chain's own fees
//   source_url   where the relationship to this project was verified
//   verified_at, verified_by
// Nothing is matched by ticker or name, and a successful answer does not prove
// the match: the entity type each answer reports is checked against the bound
// scope, and a different one is refused (never a parent or a chain in place of
// a product, never a parent summed with its children). A project without a
// binding has no fundamentals ("unmapped").
//
// Refresh: GET https://api.llama.fi/summary/fees/<slug>?dataType=<type> for
// dailyFees, dailyRevenue and dailyHoldersRevenue, separately (fixed origin
// and data types; the slug is validated, then encoded; the per-chain breakdown
// is excluded, which only shrinks the answer). Every runner (dashboard, online
// desk, scheduled task, CLI, connector) shares one lease, one rate-limit gate
// that honors a valid Retry-After, the failure backoff and the request counts.
// Requests time out, and one that may have failed transiently is tried once
// more. Network waits never hold the workspace save lock: it is taken only to
// replace a cache file. A failed refresh keeps the last good snapshot, with its
// age and the failure.
//
// Window: the previous 30 completed UTC calendar days (the current, incomplete
// day is left out), the same for all three metrics. A total is a 30-day total
// only when DefiLlama reported all 30 days; otherwise the metric is partial
// (the subtotal of the reported days, labeled as such) or unknown. A reported
// zero stays zero, a negative value stays negative, and a missing day is never
// filled. A metric DefiLlama does not publish for the entity (it answers 400)
// is unsupported and leaves the others as they are.
//
// Files (derived and refetchable, kept with the market data and backed up):
//   market-data/fundamentals/status.json         gate, backoff, request counts
//   market-data/fundamentals/<project_id>.json   the current binding's last good
//                                                snapshot and its last attempt
// A run's evidence packet keeps its own frozen copy, so later refreshes or
// binding changes never touch research that has started.

const crypto = require('crypto');
const { readJson, jsonText, sha256 } = require('./fsx');
const { withLock, replaceFile, OpError } = require('./ops');
const { acquireLease, releaseLease } = require('./leases');
const { isProjectId } = require('./ids');
const { ymdInTz } = require('./dates');

const ORIGIN = 'https://api.llama.fi';
const ENDPOINT = `${ORIGIN}/summary/fees/{slug}?dataType={type}`;
const DIR = 'market-data/fundamentals';
const STATUS_REL = `${DIR}/status.json`;
const LEASE = 'fundamentals';
const WINDOW_DAYS = 30;
const DAY_MS = 86400000;
// DefiLlama publishes the day that just ended during the first hours of the
// next one. A project that already has a snapshot is not refreshed on schedule
// in those hours; a first fetch never waits.
const SETTLE_HOURS = 3;
// A 429 without a usable Retry-After closes the gate this long, doubled for
// each further 429 within an hour of the last wait ending. Never shorter than a
// minute, never longer than backoff_max_minutes.
const RATE_LIMIT_DEFAULT_MS = 10 * 60000;
const RATE_LIMIT_MIN_MS = 60000;
const MAX_BODY_CHARS = 4 * 1024 * 1024;
const EARLIEST_MS = Date.UTC(2015, 0, 1);
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,119}$/;
const SCOPES = {
  product: 'an individual product (one protocol or version)',
  parent: 'a parent entity including its child protocols, as DefiLlama aggregates them',
  chain: 'a chain (its own fees)',
};
const METRICS = [
  { key: 'fees', type: 'dailyFees', methodology: 'Fees', field: 'fees_30d_usd', label: 'Fees' },
  { key: 'revenue', type: 'dailyRevenue', methodology: 'Revenue', field: 'revenue_30d_usd', label: 'Revenue' },
  { key: 'holders_revenue', type: 'dailyHoldersRevenue', methodology: 'HoldersRevenue', field: 'holders_revenue_30d_usd', label: 'Holders revenue' },
];
const DEFAULTS = {
  enabled: true,
  refresh_hours: 12,
  stale_hours: 36,
  timeout_seconds: 20,
  max_attempts: 2,
  monthly_request_budget: 6000,
  max_projects_per_run: 10,
  backoff_initial_minutes: 5,
  backoff_max_minutes: 360,
};
const NOTE = 'DefiLlama\'s own daily series for the bound entity, captured by the dashboard from a data aggregator (not checked in your session). Fees, revenue and holders revenue are three separate DefiLlama measurements, each as DefiLlama defines it (see each metric\'s definition and the methodology links): revenue is not net profit, holders revenue is reported by DefiLlama and never derived from the others, and protocol activity does not necessarily accrue to the token. A total is a 30-day total only when all 30 days were reported; otherwise the metric is partial (a subtotal of the reported days) or unknown. No valuation ratio is supplied.';
const FAILURE_STATES = { failed: 'unavailable', rate_limited: 'unavailable', not_found: 'not_found', scope_mismatch: 'scope_mismatch', entity_mismatch: 'entity_mismatch' };
const BINDING_PROBLEMS = new Set(['not_found', 'scope_mismatch', 'entity_mismatch']);

const isoOf = (ms) => new Date(ms).toISOString();
const dayOf = (ms) => isoOf(ms).slice(0, 10);
const round2 = (n) => Math.round(n * 100) / 100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cfgOf(ws) {
  return { ...DEFAULTS, ...((ws.settings && ws.settings.fundamentals) || {}) };
}

// Text from DefiLlama (names, definitions) is data: control characters out,
// whitespace collapsed, length capped.
function cleanText(v, max = 120) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function cleanUrl(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch (_) {
    return null;
  }
}

const checkSlug = (slug) => (typeof slug === 'string' && SLUG_RE.test(slug) ? slug : null);

// The one URL a metric is fetched from: the fixed origin and path, the
// validated slug encoded, one of the three data types.
function metricUrl(slug, type) {
  if (!checkSlug(slug)) throw new OpError('INVALID', `Not a DefiLlama slug: ${JSON.stringify(String(slug).slice(0, 80))}`);
  if (!METRICS.some((m) => m.type === type)) throw new OpError('INVALID', `Not a supported DefiLlama data type: ${type}`);
  const path = `/summary/fees/${encodeURIComponent(slug)}`;
  const url = new URL(`${ORIGIN}${path}`);
  url.searchParams.set('dataType', type);
  url.searchParams.set('excludeTotalDataChartBreakdown', 'true');
  if (url.origin !== ORIGIN || url.pathname !== path) throw new OpError('INVALID', 'The DefiLlama request did not stay on its fixed endpoint.');
  return url.toString();
}

// ---------------------------------------------------------------------------
// Binding

// A binding as given: validated, never completed or guessed. The time it was
// verified is now unless given (never in the future).
function normalizeBinding(input, { actor = null, now = Date.now() } = {}) {
  if (!input || typeof input !== 'object') throw new OpError('INVALID', 'A DefiLlama binding needs a slug, a scope and the URL where it was verified.');
  const raw = typeof input.slug === 'string' ? input.slug.trim() : '';
  if (!checkSlug(raw)) {
    throw new OpError('INVALID', `${JSON.stringify(String(input.slug === undefined ? '' : input.slug).slice(0, 80))} is not a DefiLlama slug. Give the exact slug as DefiLlama writes it (lowercase letters, digits, hyphens, dots), for example the last part of defillama.com/protocol/<slug>; never a name, a ticker or a URL.`);
  }
  const scope = typeof input.scope === 'string' ? input.scope.trim().toLowerCase() : '';
  if (!SCOPES[scope]) throw new OpError('INVALID', 'The DefiLlama scope must be product (one protocol or version), parent (DefiLlama\'s parent entity including its child protocols) or chain (a chain\'s own fees).');
  const source = cleanUrl(input.source_url);
  if (!source) throw new OpError('INVALID', 'A DefiLlama binding needs the http(s) URL where you verified that this entity is this project.');
  let verifiedAt = isoOf(now);
  if (input.verified_at !== undefined && input.verified_at !== null) {
    const t = Date.parse(input.verified_at);
    if (Number.isNaN(t) || t > now + 5 * 60000) throw new OpError('INVALID', 'verified_at must be a readable date and time, not in the future.');
    verifiedAt = isoOf(t);
  }
  const note = cleanText(input.note, 300);
  return { slug: raw, scope, source_url: source, verified_at: verifiedAt, verified_by: cleanText(input.verified_by, 80) || actor || null, ...(note ? { note } : {}) };
}

// Two bindings that name the same entity, scope and source (the time it was
// verified aside): repeating a binding changes nothing.
function sameBinding(a, b) {
  return Boolean(a && b) && a.slug === b.slug && a.scope === b.scope && a.source_url === b.source_url && (a.note || null) === (b.note || null);
}

// A stored binding complete enough to use, or null.
function storedBinding(identity) {
  const b = identity && identity.defillama;
  if (!b || typeof b !== 'object' || !checkSlug(b.slug) || !SCOPES[b.scope] || !cleanUrl(b.source_url) || Number.isNaN(Date.parse(b.verified_at))) return null;
  return b;
}

// Ties a cache file to the binding it was fetched for: any change of slug,
// scope, source or verification makes the saved snapshot unusable.
function bindingKey(b) {
  return b ? sha256(JSON.stringify([b.slug, b.scope, b.source_url, b.verified_at])).slice(0, 16) : null;
}

function bindingView(b) {
  return b ? { slug: b.slug, scope: b.scope, scope_meaning: SCOPES[b.scope], source_url: b.source_url, verified_at: b.verified_at, verified_by: b.verified_by || null, ...(b.note ? { note: b.note } : {}) } : null;
}

// ---------------------------------------------------------------------------
// The window and one metric's series

function windowFor(now) {
  const todayMs = Math.floor(now / DAY_MS) * DAY_MS;
  const endMs = todayMs - DAY_MS;
  const startMs = endMs - (WINDOW_DAYS - 1) * DAY_MS;
  return {
    start: dayOf(startMs),
    end: dayOf(endMs),
    days: WINDOW_DAYS,
    starts_at: isoOf(startMs),
    ends_before: isoOf(todayMs),
    basis: `The ${WINDOW_DAYS} completed UTC calendar days before ${dayOf(todayMs)}, the day in progress when this was fetched, which is left out.`,
  };
}

function windowDates(win) {
  const out = [];
  for (let t = Date.parse(win.starts_at); t < Date.parse(win.ends_before); t += DAY_MS) out.push(dayOf(t));
  return out;
}

function definitionOf(body, m) {
  const meth = body && body.methodology && typeof body.methodology === 'object' && !Array.isArray(body.methodology) ? body.methodology : null;
  return meth ? cleanText(meth[m.methodology], 600) : null;
}

// One metric from DefiLlama's answer: the reported days inside the window,
// coverage, and a total only when every day was reported.
function metricFrom(m, body, url, win, now) {
  const today = win.ends_before.slice(0, 10);
  const base = { data_type: m.type, label: m.label, source_url: url, http_status: 200, definition: definitionOf(body, m) };
  const chart = Array.isArray(body.totalDataChart) ? body.totalDataChart : null;
  if (!chart) {
    return { ...base, status: 'unknown', total_30d_usd: null, observed_subtotal_usd: null, daily: {}, coverage: null, reason: 'DefiLlama\'s answer carries no daily series.', issues: ['no totalDataChart in the answer'] };
  }
  const byDate = new Map();
  const conflicting = new Set();
  const counts = { malformed: 0, nonFinite: 0, future: 0, repeated: 0 };
  let first = null;
  let last = null;
  for (const row of chart) {
    if (!Array.isArray(row) || row.length < 2) {
      counts.malformed++;
      continue;
    }
    const [ts, value] = row;
    // Daily points are UTC day starts in whole seconds.
    if (!Number.isInteger(ts) || ts % 86400 !== 0 || ts * 1000 < EARLIEST_MS || ts * 1000 > now + 366 * DAY_MS) {
      counts.malformed++;
      continue;
    }
    const ms = ts * 1000;
    if (ms > now) {
      counts.future++;
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      counts.nonFinite++;
      continue;
    }
    const date = dayOf(ms);
    if (date >= today) continue; // the day in progress: incomplete, left out
    if (!first || date < first) first = date;
    if (!last || date > last) last = date;
    if (conflicting.has(date)) continue;
    if (byDate.has(date)) {
      if (byDate.get(date) === value) counts.repeated++;
      else {
        conflicting.add(date);
        byDate.delete(date);
      }
      continue;
    }
    byDate.set(date, value);
  }
  const dates = windowDates(win);
  const daily = {};
  const missing = [];
  let sum = 0;
  for (const d of dates) {
    if (byDate.has(d)) {
      daily[d] = byDate.get(d);
      sum += byDate.get(d);
    } else missing.push(d);
  }
  const observed = dates.length - missing.length;
  const latest = observed ? Object.keys(daily).sort().pop() : null;
  const conflictsIn = dates.filter((d) => conflicting.has(d));
  const issues = [];
  if (counts.malformed) issues.push(`${counts.malformed} row(s) with an unreadable or misaligned timestamp were ignored`);
  if (counts.nonFinite) issues.push(`${counts.nonFinite} row(s) without a finite number were ignored`);
  if (counts.future) issues.push(`${counts.future} row(s) dated after the current day were ignored`);
  if (counts.repeated) issues.push(`${counts.repeated} repeated row(s) with the same value were counted once`);
  if (conflicting.size) issues.push(`${conflicting.size} date(s) reported twice with different values were left out`);
  const status = observed === dates.length ? 'complete' : observed === 0 ? 'unknown' : 'partial';
  const reasons = [];
  if (status !== 'complete') {
    if (!first) reasons.push('DefiLlama reports no completed day for this metric');
    else if (first > win.end) reasons.push(`DefiLlama's series starts on ${first}, after the window`);
    else if (first > win.start) reasons.push(`DefiLlama's series starts on ${first}, so fewer than ${WINDOW_DAYS} completed days exist`);
    if (last && last < win.start) reasons.push(`DefiLlama's latest reported day is ${last}, before the window`);
    const unpublished = latest ? missing.filter((d) => d > latest && !conflicting.has(d)) : [];
    if (unpublished.length) reasons.push(`no value yet for ${unpublished.length === 1 ? unpublished[0] : `${unpublished[0]} to ${unpublished[unpublished.length - 1]}`} (the latest reported day is ${latest})`);
    const gaps = missing.filter((d) => first && d > first && latest && d < latest && !conflicting.has(d));
    if (gaps.length) reasons.push(`no value for ${gaps.length} day(s) inside the window: ${gaps.slice(0, 6).join(', ')}${gaps.length > 6 ? ', …' : ''}`);
    if (conflictsIn.length) reasons.push(`${conflictsIn.length} day(s) left out because DefiLlama reported two different values: ${conflictsIn.join(', ')}`);
  }
  return {
    ...base,
    status,
    total_30d_usd: status === 'complete' ? round2(sum) : null,
    observed_subtotal_usd: status === 'partial' ? round2(sum) : null,
    ...(status === 'partial' ? { observed_subtotal_note: `The sum of the ${observed} reported day(s) only; not a ${WINDOW_DAYS}-day total.` } : {}),
    daily,
    coverage: { expected_days: dates.length, observed_days: observed, missing_dates: missing, conflicting_dates: conflictsIn, history_starts: first, latest_observation_date: latest },
    reason: status === 'complete' ? null : `${reasons.join('; ') || 'not every day of the window was reported'}.`,
    issues,
  };
}

function unsupportedMetric(m, r) {
  return {
    data_type: m.type,
    label: m.label,
    source_url: r.url,
    http_status: r.http_status,
    definition: null,
    status: 'unsupported',
    total_30d_usd: null,
    observed_subtotal_usd: null,
    daily: {},
    coverage: null,
    reason: `DefiLlama does not publish ${m.type} for this entity (HTTP ${r.http_status}${r.message ? `: "${r.message}"` : ''}).`,
    issues: [],
  };
}

// ---------------------------------------------------------------------------
// The entity an answer describes

function reportedScope(body) {
  const id = body.defillamaId === undefined || body.defillamaId === null ? '' : String(body.defillamaId);
  if (body.protocolType === 'chain' || id.startsWith('chain#')) return 'chain';
  if (id.startsWith('parent#') || (Array.isArray(body.childProtocols) && body.childProtocols.length)) return 'parent';
  return 'product';
}

function entityOf(body) {
  const children = Array.isArray(body.childProtocols) ? body.childProtocols.filter((c) => c && typeof c === 'object') : [];
  const idText = (v) => (v === undefined || v === null ? null : cleanText(String(v), 80));
  return {
    slug: cleanText(body.slug, 120),
    name: cleanText(body.displayName, 120) || cleanText(body.name, 120),
    defillama_id: idText(body.defillamaId),
    protocol_type: cleanText(body.protocolType, 40),
    category: cleanText(body.category, 60),
    parent_protocol: cleanText(body.parentProtocol, 80),
    reported_scope: reportedScope(body),
    child_protocol_count: children.length,
    child_protocols: children.slice(0, 25).map((c) => ({ name: cleanText(c.displayName, 120) || cleanText(c.name, 120), defillama_id: idText(c.defillamaId), methodology_url: cleanUrl(c.methodologyURL) })),
    methodology_url: cleanUrl(body.methodologyURL),
    gecko_id: cleanText(body.gecko_id, 120),
  };
}

function describeScope(e) {
  if (e.reported_scope === 'chain') return 'a chain';
  if (e.reported_scope === 'parent') {
    const names = e.child_protocols.map((c) => c.name).filter(Boolean).slice(0, 5);
    return `a parent with ${e.child_protocol_count} child protocol(s)${names.length ? ` (${names.join(', ')}${e.child_protocol_count > names.length ? ', …' : ''})` : ''}`;
  }
  return `an individual product${e.parent_protocol ? ` (its parent is ${e.parent_protocol})` : ''}`;
}

// The snapshot of one refresh, or why nothing from it can be used.
function buildSnapshot(binding, fetched, win, now, at) {
  const answered = METRICS.filter((m) => fetched[m.key] && fetched[m.key].kind === 'ok');
  if (!answered.length) {
    const f = fetched.fees || {};
    return { outcome: 'not_found', http_status: f.http_status || null, message: `DefiLlama has no fee data for "${binding.slug}" (HTTP ${f.http_status || '?'}${f.message ? `: "${f.message}"` : ''}). Check the slug on defillama.com and bind the entity you mean.` };
  }
  const entities = answered.map((m) => entityOf(fetched[m.key].body));
  const entity = entities[0];
  if (entities.some((e) => e.defillama_id !== entity.defillama_id || e.slug !== entity.slug)) {
    return { outcome: 'entity_mismatch', entity, message: `DefiLlama answered the series for "${binding.slug}" with different entities; nothing was used.` };
  }
  if (entity.slug && entity.slug !== binding.slug) {
    return { outcome: 'entity_mismatch', entity, message: `Bound to "${binding.slug}", but DefiLlama answers for "${entity.slug}"${entity.name ? ` (${entity.name})` : ''}. It may have been renamed or merged: confirm the entity and bind its current slug. Nothing was used.` };
  }
  if (entity.reported_scope !== binding.scope) {
    return { outcome: 'scope_mismatch', entity, message: `Bound as ${binding.scope} (${SCOPES[binding.scope]}), but DefiLlama reports "${binding.slug}" as ${describeScope(entity)}. Nothing was used: bind the scope DefiLlama reports, or the slug of the entity you mean.` };
  }
  const metrics = {};
  for (const m of METRICS) {
    const r = fetched[m.key];
    metrics[m.key] = r.kind === 'ok' ? metricFrom(m, r.body, r.url, win, now) : unsupportedMetric(m, r);
    if (entity.reported_scope === 'parent' && r.kind === 'ok' && !metrics[m.key].definition) {
      metrics[m.key].definition_note = 'DefiLlama publishes its definitions per child protocol for a parent entity: see each child protocol\'s methodology link.';
    }
  }
  const latest = METRICS.map((m) => metrics[m.key].coverage && metrics[m.key].coverage.latest_observation_date).filter(Boolean).sort().pop() || null;
  return {
    outcome: 'ok',
    snapshot: {
      schema_version: 'cr.fundamentals-snapshot.v1',
      provider: 'DefiLlama',
      endpoint: ENDPOINT,
      entity,
      ...(entity.reported_scope === 'parent' ? { scope_note: `DefiLlama's own aggregate for the parent entity, which includes ${entity.child_protocol_count} child protocol(s). The desk does not add the children to it or fetch them separately.` } : {}),
      window: win,
      fetched_at: at,
      latest_observation_date: latest,
      fees_30d_usd: metrics.fees.total_30d_usd,
      revenue_30d_usd: metrics.revenue.total_30d_usd,
      holders_revenue_30d_usd: metrics.holders_revenue.total_30d_usd,
      metrics,
    },
  };
}

// ---------------------------------------------------------------------------
// Requests

function retryAfterMs(res) {
  return require('./market').retryAfterMs(res);
}

const HEADERS = { accept: 'application/json', 'user-agent': 'CryptoResearch-desk' };

// One metric, with a bounded retry for a failure that may be transient (no
// answer, a timeout, a 5xx, an unreadable answer). Every request sent counts;
// a 400 or 404 is a definite answer (the metric is not published for the
// entity); a 429 stops at once.
async function getMetric(url, { fetchImpl, timeoutMs, maxAttempts, retryDelayMs, counts }) {
  let failure = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1 && retryDelayMs) await sleep(retryDelayMs);
    counts.sent++;
    let res;
    let text;
    try {
      res = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429) {
        try {
          if (res.body && typeof res.body.cancel === 'function') await res.body.cancel();
        } catch (_) { /* nothing to release */ }
        return { kind: 'rate_limited', http_status: 429, retry_after_ms: retryAfterMs(res), attempts: attempt };
      }
      text = await res.text();
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      const cause = err && err.cause && err.cause.code ? ` (${err.cause.code})` : '';
      failure = { kind: 'failed', error: timedOut ? `no answer within ${Math.round(timeoutMs / 1000)} s` : `the request failed: ${cleanText(String((err && err.message) || err), 160)}${cause}`, attempts: attempt };
      continue;
    }
    if (res.status === 400 || res.status === 404) {
      counts.answered++;
      return { kind: 'unsupported', http_status: res.status, message: cleanText(text, 200), attempts: attempt };
    }
    if (!res.ok) {
      failure = { kind: 'failed', http_status: res.status, error: `DefiLlama answered HTTP ${res.status}`, attempts: attempt };
      if (res.status >= 500) continue;
      return failure;
    }
    if (typeof text !== 'string' || !text || text.length > MAX_BODY_CHARS) {
      failure = { kind: 'failed', http_status: res.status, error: 'the answer was empty or too large', attempts: attempt };
      continue;
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch (_) {
      failure = { kind: 'failed', http_status: res.status, error: 'the answer was not valid JSON', attempts: attempt };
      continue;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      failure = { kind: 'failed', http_status: res.status, error: 'the answer was not a DefiLlama summary', attempts: attempt };
      continue;
    }
    counts.answered++;
    return { kind: 'ok', http_status: res.status, body, attempts: attempt };
  }
  return failure;
}

// ---------------------------------------------------------------------------
// Status, gate, backoff, request counts

function readStatus(ws) {
  try {
    return readJson(ws.abs(STATUS_REL), { state: 'never_run' });
  } catch (_) {
    return { state: 'never_run', unreadable: true };
  }
}

function laterIso(iso, t) {
  return iso && Date.parse(iso) > t ? iso : isoOf(t);
}

function gateOf(status, now) {
  const until = status.retry_after_until ? Date.parse(status.retry_after_until) : 0;
  return until > now ? { open: false, until: status.retry_after_until } : { open: true, until: null };
}

function rateLimitFields(cfg, status, retryAfter, now) {
  const maxMs = cfg.backoff_max_minutes * 60000;
  const given = typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null;
  const prev = status.rate_limit || null;
  const prevEnd = prev && prev.until ? Date.parse(prev.until) : NaN;
  const strikes = !Number.isNaN(prevEnd) && now - prevEnd < 3600000 ? (prev.strikes || 1) + 1 : 1;
  const waitMs = Math.min(maxMs, Math.max(RATE_LIMIT_MIN_MS, given !== null ? given : RATE_LIMIT_DEFAULT_MS * 2 ** (strikes - 1)));
  const until = laterIso(status.retry_after_until, now + waitMs);
  return { retry_after_until: until, rate_limit: { at: isoOf(now), http_status: 429, retry_after_ms: given, wait_ms: waitMs, strikes, until } };
}

function backoffMs(cfg, failures) {
  const base = cfg.backoff_initial_minutes * 60000;
  const max = cfg.backoff_max_minutes * 60000;
  const raw = Math.min(max, base * 2 ** Math.max(0, failures - 1));
  const jitter = raw * 0.2 * (crypto.randomInt(0, 1000) / 1000 - 0.5) * 2;
  return Math.max(base / 2, Math.round(raw + jitter));
}

// This month's and today's requests (America/New_York, like the price
// counts): sent counts every request, retries included; answered counts the
// ones that came back with a definite answer.
function callCounts(status, now) {
  const today = ymdInTz(new Date(now));
  const month = today.slice(0, 7);
  const c = status.calls && status.calls.month === month ? { ...status.calls } : { month, month_count: 0, month_answered: 0, day: today, day_count: 0, day_answered: 0 };
  if (c.day !== today) {
    c.day = today;
    c.day_count = 0;
    c.day_answered = 0;
  }
  return c;
}

function addCalls(c, sent, answered) {
  return { ...c, month_count: (c.month_count || 0) + sent, day_count: (c.day_count || 0) + sent, month_answered: (c.month_answered || 0) + answered, day_answered: (c.day_answered || 0) + answered };
}

function updateStatus(ws, fn) {
  withLock(ws, 'fundamentals_status', () => {
    const cur = readStatus(ws);
    replaceFile(ws, ws.abs(STATUS_REL), jsonText({ ...fn(cur), schema_version: 'cr.fundamentals-status.v1', provider: 'defillama' }));
  });
}

// Why a refresh may not call now: a rate limit (never skipped) or, unless
// forced, a failure backoff.
function blockedBy(status, now, { force = false } = {}) {
  const clock = require('./market').clock;
  const gate = gateOf(status, now);
  if (!gate.open) return { status: 'backoff', rate_limited: true, retry_at: gate.until, message: `Fundamentals not refreshed: DefiLlama asked this server to wait (HTTP 429); next try ${clock(gate.until, now)}.` };
  if (!force && status.next_allowed_at && Date.parse(status.next_allowed_at) > now) {
    return { status: 'backoff', rate_limited: false, retry_at: status.next_allowed_at, message: `Fundamentals not refreshed: backing off after ${status.consecutive_failures || 1} failed refresh(es); next try ${clock(status.next_allowed_at, now)}.` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cache files

function projectRel(id) {
  if (!isProjectId(id)) throw new OpError('BAD_ID', `Not a valid project ID: ${JSON.stringify(id)}`);
  return `${DIR}/${id}.json`;
}

function readProjectDoc(ws, id) {
  try {
    return readJson(ws.abs(projectRel(id)), null);
  } catch (_) {
    return null; // an unreadable cache file is refetched
  }
}

function writeProjectDoc(ws, id, doc) {
  withLock(ws, 'fundamentals', () => replaceFile(ws, ws.abs(projectRel(id)), jsonText(doc)));
}

// Projects whose fundamentals the desk keeps: a verified identity with a
// usable binding, not archived.
function boundProjects(ws) {
  return require('./projects').listProjects(ws).filter((p) => !p.broken && p.status !== 'archived' && p.identity && p.identity.status === 'verified' && storedBinding(p.identity));
}

const settling = (now) => now - Math.floor(now / DAY_MS) * DAY_MS < SETTLE_HOURS * 3600000;

function projectDue(ws, project, now) {
  const doc = readProjectDoc(ws, project.project_id);
  if (!doc || doc.binding_key !== bindingKey(storedBinding(project.identity))) return true;
  if (doc.next_attempt_at && Date.parse(doc.next_attempt_at) > now) return false;
  return !doc.snapshot || !settling(now);
}

// For every runner (jobs.isDue): whether a scheduled refresh has work now.
function isDue(ws, now = Date.now()) {
  if (!cfgOf(ws).enabled) return false;
  if (blockedBy(readStatus(ws), now)) return false;
  return boundProjects(ws).some((p) => projectDue(ws, p, now));
}

// ---------------------------------------------------------------------------
// Refresh

// Refreshes the bound projects that are due (all of them, or the ones named,
// when forced: a manual refresh skips the failure backoff, never a rate
// limit). Returns { status: ok | partial | attention | failed | backoff |
// busy | noop | budget_paused | skipped, message, ... }.
async function refresh(ws, opts = {}) {
  const { trigger = 'manual', fetchImpl = fetch, force = false, projectIds = null, retryDelayMs = 1500, pauseMs = 200 } = opts;
  const clock = () => (opts.now !== undefined ? opts.now : Date.now());
  const cfg = cfgOf(ws);
  if (!cfg.enabled) return { status: 'skipped', message: 'DefiLlama fundamentals are turned off in settings.' };
  const now0 = clock();
  const blocked = blockedBy(readStatus(ws), now0, { force });
  if (blocked) return blocked;
  let list = boundProjects(ws);
  if (Array.isArray(projectIds)) list = list.filter((p) => projectIds.includes(p.project_id));
  if (!force) list = list.filter((p) => projectDue(ws, p, now0));
  if (!list.length) {
    return { status: 'noop', message: Array.isArray(projectIds) ? 'Nothing to refresh: none of those projects has a DefiLlama binding on a verified, active identity.' : 'No DefiLlama fundamentals are due.', refreshed: [], problems: [] };
  }
  const budget = cfg.monthly_request_budget || null;
  if (budget) {
    const used = callCounts(readStatus(ws), now0).month_count;
    const room = Math.floor((budget - used) / METRICS.length);
    if (room <= 0) return { status: 'budget_paused', message: `Monthly DefiLlama request budget reached (${used} of ${budget}). Saved fundamentals stay as they are.` };
    list = list.slice(0, room);
  }
  list = list.slice(0, Math.max(1, cfg.max_projects_per_run || 1));
  const timeoutMs = Math.max(1, cfg.timeout_seconds) * 1000;
  const ttl = list.length * METRICS.length * (timeoutMs * cfg.max_attempts + retryDelayMs + pauseMs) + 60000;
  const lease = acquireLease(ws, LEASE, ttl, { label: trigger });
  if (!lease) return { status: 'busy', message: 'Another fundamentals refresh is running; its result will be used.' };
  try {
    // Another runner may have been rate-limited while this one waited.
    const again = blockedBy(readStatus(ws), clock(), { force });
    if (again) return again;
    return await refreshLeased(ws, list, { trigger, fetchImpl, cfg, clock, retryDelayMs, pauseMs, timeoutMs });
  } finally {
    releaseLease(ws, LEASE, lease);
  }
}

async function refreshLeased(ws, list, { trigger, fetchImpl, cfg, clock, retryDelayMs, pauseMs, timeoutMs }) {
  const counts = { sent: 0, answered: 0 };
  const results = [];
  let limited = null;
  let sentAny = false;
  for (const p of list) {
    if (limited) {
      results.push({ project_id: p.project_id, slug: storedBinding(p.identity).slug, outcome: 'not_attempted', error: 'not attempted: DefiLlama rate-limited this refresh' });
      continue;
    }
    const binding = storedBinding(p.identity);
    const key = bindingKey(binding);
    const fetched = {};
    let failure = null;
    for (const m of METRICS) {
      if (sentAny && pauseMs) await sleep(pauseMs);
      sentAny = true;
      const url = metricUrl(binding.slug, m.type);
      const r = await getMetric(url, { fetchImpl, timeoutMs, maxAttempts: Math.max(1, cfg.max_attempts), retryDelayMs, counts });
      if (r.kind === 'rate_limited') {
        limited = r;
        failure = { outcome: 'rate_limited', error: `${m.type}: DefiLlama answered HTTP 429 (rate limited)`, http_status: 429 };
        break;
      }
      if (r.kind === 'failed') {
        failure = { outcome: 'failed', error: `${m.type}: ${r.error}${r.attempts > 1 ? ` (after ${r.attempts} attempts)` : ''}`, http_status: r.http_status || null };
        break;
      }
      fetched[m.key] = { ...r, url };
    }
    const now = clock();
    const at = isoOf(now);
    const prev = readProjectDoc(ws, p.project_id);
    const same = prev && prev.binding_key === key ? prev : null;
    const base = { schema_version: 'cr.fundamentals-project.v1', project_id: p.project_id, binding_key: key, binding: { ...binding } };
    // A failure keeps the last good snapshot of this binding (never another's).
    const kept = { snapshot: same && same.snapshot ? same.snapshot : null, last_good_at: same ? same.last_good_at || null : null };
    let doc;
    if (failure) {
      const fails = ((same && same.consecutive_failures) || 0) + 1;
      doc = { ...base, ...kept, last_attempt: { at, trigger, outcome: failure.outcome, error: failure.error, http_status: failure.http_status }, consecutive_failures: fails, next_attempt_at: isoOf(now + Math.min(cfg.refresh_hours * 3600000, backoffMs(cfg, fails))) };
    } else {
      const built = buildSnapshot(binding, fetched, windowFor(now), now, at);
      const next = isoOf(now + cfg.refresh_hours * 3600000);
      doc = built.outcome === 'ok'
        ? { ...base, snapshot: built.snapshot, last_good_at: at, last_attempt: { at, trigger, outcome: 'ok', error: null, http_status: 200 }, consecutive_failures: 0, next_attempt_at: next }
        : { ...base, ...kept, last_attempt: { at, trigger, outcome: built.outcome, error: built.message, http_status: built.http_status || 200, ...(built.entity ? { entity: built.entity } : {}) }, consecutive_failures: 0, next_attempt_at: next };
    }
    let outcome = doc.last_attempt.outcome;
    let error = doc.last_attempt.error;
    try {
      writeProjectDoc(ws, p.project_id, doc);
    } catch (err) {
      outcome = 'failed';
      error = `fetched, but the cache could not be saved: ${err.message}`;
    }
    results.push({ project_id: p.project_id, slug: binding.slug, outcome, error });
  }

  const now = clock();
  const ok = results.filter((r) => r.outcome === 'ok');
  const problems = results.filter((r) => BINDING_PROBLEMS.has(r.outcome));
  const transient = results.filter((r) => ['failed', 'rate_limited', 'not_attempted'].includes(r.outcome));
  const status = transient.length ? (ok.length ? 'partial' : 'failed') : problems.length ? 'attention' : 'ok';
  // Every attempted project failed without an answer: back off before the
  // next scheduled try (a rate limit has its own gate).
  const offline = !ok.length && !problems.length && results.some((r) => r.outcome === 'failed');
  const listOf = (rs) => rs.map((r) => `${r.project_id} (${r.error})`).join('; ');
  const message = [
    `DefiLlama fundamentals: ${ok.length} of ${results.length} bound project(s) refreshed${ok.length ? ` (window ${windowFor(now).start} to ${windowFor(now).end})` : ''}.`,
    problems.length ? `Binding needs checking: ${listOf(problems)}.` : '',
    transient.length ? `Not refreshed: ${listOf(transient)}.` : '',
  ].filter(Boolean).join(' ');
  updateStatus(ws, (cur) => {
    const failures = offline ? (cur.consecutive_failures || 0) + 1 : ok.length || problems.length ? 0 : cur.consecutive_failures || 0;
    const next = {
      ...cur,
      state: status,
      last_run: { at: isoOf(now), trigger, status, refreshed: ok.length, problems: problems.length, not_refreshed: transient.length, requests: counts.sent, summary: message.slice(0, 600) },
      ...(ok.length ? { last_success_at: isoOf(now) } : {}),
      consecutive_failures: failures,
      next_allowed_at: offline ? laterIso(cur.next_allowed_at, now + backoffMs(cfg, failures)) : ok.length || problems.length ? null : cur.next_allowed_at || null,
      calls: addCalls(callCounts(cur, now), counts.sent, counts.answered),
    };
    return limited ? { ...next, ...rateLimitFields(cfg, cur, limited.retry_after_ms, now) } : next;
  });
  const gate = gateOf(readStatus(ws), now);
  return {
    status,
    message,
    refreshed: ok.map((r) => r.project_id),
    problems: problems.map((r) => ({ project_id: r.project_id, outcome: r.outcome, error: r.error })),
    not_refreshed: transient.map((r) => ({ project_id: r.project_id, outcome: r.outcome, error: r.error })),
    requests: counts.sent,
    ...(limited ? { rate_limited: true, retry_at: gate.until } : {}),
  };
}

// ---------------------------------------------------------------------------
// Reading what was saved (never fetches)

// The state of one project's fundamentals:
//   unmapped           no (usable) DefiLlama binding
//   identity_pending   bound, but the project's identity is not verified
//   disabled           fundamentals are turned off in settings
//   pending            bound, not fetched yet for this binding
//   unavailable        no snapshot for this binding; the last try failed (a
//                      network error, a timeout, a 5xx or a rate limit)
//   not_found          no snapshot; DefiLlama has no fee data for the slug
//   scope_mismatch     no snapshot; DefiLlama reports another kind of entity
//   entity_mismatch    no snapshot; DefiLlama answers for another slug
//   fresh              a snapshot of this binding, fetched within stale_hours
//   fresh_last_failed  the same, but the latest refresh failed (shown)
//   stale              a snapshot older than stale_hours (with any failure)
function stateFor(ws, project, now = Date.now()) {
  const cfg = cfgOf(ws);
  const id = (project && project.identity) || {};
  const binding = storedBinding(id);
  if (!binding) {
    return id.defillama
      ? { state: 'unmapped', binding: null, reason: 'The DefiLlama binding on file is incomplete (it needs a slug, a scope, the source URL and when it was verified), so it is not used. Bind it again.' }
      : { state: 'unmapped', binding: null, reason: 'No DefiLlama entity is bound to this project, so no fee, revenue or holders-revenue series is supplied.' };
  }
  if (id.status !== 'verified') return { state: 'identity_pending', binding, reason: 'The project\'s identity is not verified, so its DefiLlama binding is not used yet.' };
  if (!cfg.enabled) return { state: 'disabled', binding, reason: 'DefiLlama fundamentals are turned off in settings.' };
  const doc = isProjectId(project.project_id) ? readProjectDoc(ws, project.project_id) : null;
  const mine = doc && doc.binding_key === bindingKey(binding) ? doc : null;
  const last = mine ? mine.last_attempt || null : null;
  const snap = mine && mine.snapshot ? mine.snapshot : null;
  const failed = last && last.outcome !== 'ok' ? last : null;
  if (!snap) {
    if (!last) {
      return { state: 'pending', binding, reason: doc ? `The binding changed after the last fetch; "${binding.slug}" has not been fetched yet.` : `Bound to "${binding.slug}"; not fetched yet.`, last_attempt: null, next_attempt_at: null };
    }
    return { state: FAILURE_STATES[last.outcome] || 'unavailable', binding, reason: last.error, last_attempt: last, next_attempt_at: mine.next_attempt_at || null };
  }
  const fetchedMs = Date.parse(snap.fetched_at);
  const ageHours = Number.isNaN(fetchedMs) ? null : Math.max(0, Math.round(((now - fetchedMs) / 3600000) * 10) / 10);
  const stale = ageHours === null || ageHours > cfg.stale_hours;
  const state = stale ? 'stale' : failed ? 'fresh_last_failed' : 'fresh';
  const reason = stale
    ? `The saved snapshot is ${ageHours === null ? 'of unknown age' : `${Math.round(ageHours)} h old`}, older than ${cfg.stale_hours} h.${failed ? ` The latest refresh failed: ${failed.error}` : ''}`
    : failed
      ? `The latest refresh failed (${failed.error}); this is the snapshot fetched ${snap.fetched_at}.`
      : null;
  return { state, binding, reason, snapshot: snap, age_hours: ageHours, last_attempt: last, next_attempt_at: mine.next_attempt_at || null };
}

// The block a new research run freezes into its evidence packet (research.js):
// the binding and its scope, the window, every reported day, the definitions,
// methodology links, coverage, source URLs and times, or why there is none.
function packetBlock(ws, project, { now = Date.now() } = {}) {
  const s = stateFor(ws, project, now);
  const block = { schema_version: 'cr.fundamentals.v1', provider: 'DefiLlama', state: s.state, reason: s.reason || null, binding: bindingView(s.binding), note: NOTE };
  if (s.last_attempt && s.last_attempt.outcome !== 'ok') block.last_refresh_failure = { at: s.last_attempt.at, outcome: s.last_attempt.outcome, error: s.last_attempt.error };
  if (s.snapshot) {
    const { schema_version: _v, provider: _p, ...snap } = s.snapshot;
    Object.assign(block, { age_hours: s.age_hours }, snap);
    const cg = project.identity && project.identity.coingecko_id;
    const theirs = snap.entity && snap.entity.gecko_id;
    if (cg && theirs && theirs !== cg) block.token_link_note = `DefiLlama links this entity to CoinGecko ID "${theirs}", while this project's token is "${cg}"; the binding's source explains how they relate.`;
  }
  return block;
}

// The project page and the connector: the packet block plus when the next
// refresh may run.
function view(ws, project, { now = Date.now() } = {}) {
  const s = stateFor(ws, project, now);
  return { ...packetBlock(ws, project, { now }), last_attempt: s.last_attempt || null, next_attempt_at: s.next_attempt_at || null };
}

// One project's line in the dashboard index: state, totals and coverage only.
function summary(ws, project, now = Date.now()) {
  const s = stateFor(ws, project, now);
  const snap = s.snapshot || null;
  return {
    state: s.state,
    reason: s.reason || null,
    slug: s.binding ? s.binding.slug : null,
    scope: s.binding ? s.binding.scope : null,
    fetched_at: snap ? snap.fetched_at : null,
    age_hours: snap ? s.age_hours : null,
    window: snap ? { start: snap.window.start, end: snap.window.end } : null,
    latest_observation_date: snap ? snap.latest_observation_date : null,
    metrics: snap ? Object.fromEntries(METRICS.map((m) => {
      const x = snap.metrics[m.key];
      return [m.key, { status: x.status, total_30d_usd: x.total_30d_usd, observed_subtotal_usd: x.observed_subtotal_usd, observed_days: x.coverage ? x.coverage.observed_days : null }];
    })) : null,
    last_error: s.last_attempt && s.last_attempt.outcome !== 'ok' ? s.last_attempt.error : null,
    binding_problem: Boolean(s.last_attempt && BINDING_PROBLEMS.has(s.last_attempt.outcome)),
  };
}

// The whole desk (doctor, start log): states, the last run, the gate and the
// request counts.
function overview(ws, now = Date.now()) {
  const cfg = cfgOf(ws);
  const st = readStatus(ws);
  const states = {};
  for (const p of require('./projects').listProjects(ws).filter((x) => !x.broken && x.status !== 'archived')) {
    const s = stateFor(ws, p, now).state;
    states[s] = (states[s] || 0) + 1;
  }
  const gate = gateOf(st, now);
  return {
    enabled: cfg.enabled,
    bound: Object.entries(states).filter(([k]) => k !== 'unmapped').reduce((a, [, n]) => a + n, 0),
    states,
    last_run: st.last_run || null,
    last_success_at: st.last_success_at || null,
    consecutive_failures: st.consecutive_failures || 0,
    rate_limited: !gate.open,
    retry_at: gate.until || (st.next_allowed_at && Date.parse(st.next_allowed_at) > now ? st.next_allowed_at : null),
    calls: callCounts(st, now),
    budget_monthly: cfg.monthly_request_budget || null,
    refresh_hours: cfg.refresh_hours,
  };
}

module.exports = {
  ORIGIN,
  ENDPOINT,
  DIR,
  STATUS_REL,
  LEASE,
  WINDOW_DAYS,
  SCOPES,
  METRICS,
  DEFAULTS,
  SETTLE_HOURS,
  normalizeBinding,
  sameBinding,
  storedBinding,
  bindingKey,
  metricUrl,
  windowFor,
  readStatus,
  readProjectDoc,
  isDue,
  refresh,
  stateFor,
  packetBlock,
  view,
  summary,
  overview,
};
