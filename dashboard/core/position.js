'use strict';
// Position-cycle research recipe (position-cycle@1).
//
// Eric's style is position trading: usually a couple of months, with a planning
// ceiling of four calendar months. So a research run's horizon is an exact
// calendar interval anchored to the research date (America/New_York), for
// example "4 months (2026-10-02 to 2027-02-02)". A longer horizon is an
// explicit long-term exception and needs the owner's reason; nothing here turns
// a ceiling into a sale or a trade.
//
// Reports written for this recipe (cr-research-prompt@3 and @4) carry a
// `position_context` block: the model's reading of market conditions, its
// qualitative timing view, catalyst windows and a suggested review date. It is
// validated here and bound to the research run on import. It adds to the report
// contract only: no score, weight or grade changes because of it, and the
// existing timing_executable_liquidity component stays the only timing score.
// Older reports simply have no position context; nothing is inferred for them.

const { OpError } = require('./ops');
const { ymdInTz, isYmd, daysBetween } = require('./dates');

const RECIPE_ID = 'position-cycle@1';
// The 4-month ceiling and the long-term reason come from Eric's Foundation brief
// and Implementation Architecture (2026-10-02), not from the agreed mission
// document, so requiring a reason is OFF until he decides
// (settings: research.horizon_policy.require_long_term_reason).
const DEFAULT_POLICY = Object.freeze({ planning_ceiling_months: 4, typical_hold_months: 2, default_months: 4, require_long_term_reason: false });
const MARKET_STATES = ['unknown', 'bitcoin_led', 'broad_altcoin_participation', 'mixed', 'contracting'];
const TIMING_STATES = ['unknown', 'early', 'developing', 'extended', 'thesis_impaired'];
const CERTAINTY = ['unknown', 'project_claimed', 'source_documented', 'analyst_inferred'];
const MARKET_LABELS = { unknown: 'Unknown', bitcoin_led: 'Bitcoin-led', broad_altcoin_participation: 'Broad altcoin participation', mixed: 'Mixed', contracting: 'Contracting' };
const TIMING_LABELS = { unknown: 'Unknown', early: 'Early', developing: 'Developing', extended: 'Extended', thesis_impaired: 'Thesis impaired' };
const MAX_TEXT = 4000;

function policy(ws) {
  const p = (ws && ws.settings && ws.settings.research && ws.settings.research.horizon_policy) || {};
  const int = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
  const ceiling = int(p.planning_ceiling_months, 1, 24, DEFAULT_POLICY.planning_ceiling_months);
  return {
    recipe: RECIPE_ID,
    planning_ceiling_months: ceiling,
    typical_hold_months: int(p.typical_hold_months, 1, ceiling, Math.min(DEFAULT_POLICY.typical_hold_months, ceiling)),
    default_months: int(p.default_months, 1, ceiling, Math.min(DEFAULT_POLICY.default_months, ceiling)),
    require_long_term_reason: p.require_long_term_reason === true,
  };
}

// Calendar months, clamped to the end of a shorter month (Oct 31 + 4 = Feb 28/29).
function addCalendarMonths(ymd, months) {
  if (!isYmd(ymd)) throw new Error(`Not a calendar date: ${ymd}`);
  if (!Number.isInteger(months) || months < 0 || months > 240) throw new Error(`Not a month count: ${months}`);
  const [y, m, d] = ymd.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

function horizonText(h) {
  return h.mode === 'long_term'
    ? `${h.months} months, long-term exception (${h.start_date} to ${h.end_date})`
    : `${h.months} months (${h.start_date} to ${h.end_date})`;
}

// Whole calendar months from a typed horizon ("3 months", "1 year", "2-4 months"
// uses its end). Weeks and days are not calendar months, so they are refused.
function monthsFrom(text) {
  const { parseHorizon } = require('./reports');
  const p = parseHorizon(String(text || ''));
  if (!p || p.kind === 'unknown' || p.high_months === null) return { error: `Horizon "${text}" is not readable. Use whole calendar months, for example "4 months".` };
  const months = p.high_months;
  if (!Number.isInteger(months) || months < 1) return { error: `Horizon "${text}" is not a whole number of calendar months. Use for example "3 months" or "4 months".` };
  if (months > 120) return { error: `Horizon "${text}" is longer than ten years.` };
  return { months, typed: String(text).trim(), kind: p.kind };
}

function cleanReason(r) {
  const s = typeof r === 'string' ? r.trim() : '';
  return s ? s.slice(0, 2000) : null;
}

function build(ws, { months, startDate, reason, source, typed = null }) {
  const pol = policy(ws);
  const longTerm = months > pol.planning_ceiling_months;
  if (longTerm && !reason && pol.require_long_term_reason) {
    throw new OpError('INVALID', `A ${months}-month horizon is longer than your ${pol.planning_ceiling_months}-month planning ceiling, so it is a long-term exception and needs your reason (CLI: --long-term-reason "..."; dashboard: the reason field in Run research). Leave the horizon out for the usual ${pol.default_months}-month position horizon.`);
  }
  const h = {
    recipe: RECIPE_ID,
    mode: longTerm ? 'long_term' : 'position',
    months,
    start_date: startDate,
    end_date: addCalendarMonths(startDate, months),
    exception_reason: longTerm ? reason || null : null,
    typical_hold_months: pol.typical_hold_months,
    planning_ceiling_months: pol.planning_ceiling_months,
    source,
    typed,
  };
  h.text = horizonText(h);
  // The legacy fields every older reader of run.json understands.
  h.low_months = months;
  h.high_months = months;
  return h;
}

// The horizon of a new research run, in this order: what the request says;
// "same as last" (re-anchored to today); the project's default; Settings; the
// policy default. A typed horizon above the ceiling needs a long-term reason.
function resolveRunHorizon(ws, { args = {}, previous = [], project = null, today = ymdInTz() } = {}) {
  const pol = policy(ws);
  const reason = cleanReason(args.long_term_reason);
  const fromText = (text, source, fallbackReason = null) => {
    const m = monthsFrom(text);
    if (m.error) throw new OpError('INVALID', m.error);
    return build(ws, { months: m.months, startDate: today, reason: reason || fallbackReason, source, typed: m.typed });
  };
  if (args.horizon) return fromText(args.horizon, 'request');
  const last = args.same_as_last && previous[0] && !previous[0].broken ? previous[0] : null;
  if (last && last.horizon) {
    if (last.horizon.recipe === RECIPE_ID && Number.isInteger(last.horizon.months)) {
      return build(ws, { months: last.horizon.months, startDate: today, reason: reason || last.horizon.exception_reason || null, source: 'same_as_last', typed: last.horizon.typed || null });
    }
    // A run from before this recipe: its length, re-anchored, under today's policy.
    const m = monthsFrom(last.horizon.text);
    if (!m.error) return build(ws, { months: m.months, startDate: today, reason, source: 'same_as_last', typed: last.horizon.text });
  }
  const pd = project && project.research_defaults;
  if (pd && pd.horizon) return fromText(pd.horizon, 'project_default', cleanReason(pd.long_term_reason));
  const sd = ws.settings.research && ws.settings.research.default_horizon;
  if (sd) {
    const m = monthsFrom(sd);
    if (!m.error && m.months <= pol.planning_ceiling_months) return build(ws, { months: m.months, startDate: today, reason: null, source: 'settings_default', typed: String(sd) });
  }
  return build(ws, { months: pol.default_months, startDate: today, reason: null, source: 'policy_default' });
}

// Checks a typed horizon for a form or a project default without creating
// anything. Returns { ok, horizon? , message? }.
function checkHorizon(ws, text, reason = null, today = ymdInTz()) {
  try {
    const m = monthsFrom(text);
    if (m.error) return { ok: false, message: m.error };
    return { ok: true, horizon: build(ws, { months: m.months, startDate: today, reason: cleanReason(reason), source: 'check', typed: m.typed }) };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

// ---------------------------------------------------------------------------
// The position_context block of a report

const str = (v, max = MAX_TEXT) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const refs = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(x)))] : []);

function enumOf(value, allowed, field, issues) {
  if (value === undefined || value === null || value === '') return { state: 'unknown', raw: null };
  const v = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (allowed.includes(v)) return { state: v, raw: null };
  issues.push({ severity: 'warning', field, message: `"${String(value).slice(0, 60)}" is not one of ${allowed.join(', ')}; read as unknown and kept as written.` });
  return { state: 'unknown', raw: String(value).slice(0, 120) };
}

function dateOf(value, field, issues) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim().slice(0, 10);
  if (isYmd(s)) return s;
  issues.push({ severity: 'warning', field, message: `"${String(value).slice(0, 40)}" is not a calendar date (YYYY-MM-DD); not used.` });
  return null;
}

// Normalizes the raw block. `catalysts` are the report's own catalyst items,
// which this recipe extends with a window and a certainty. Never throws: a
// malformed block is kept as far as it is readable, with warnings.
function normalizePositionContext(raw, { catalysts = [], promptVersion = null, analysisAt = null, ceiling = DEFAULT_POLICY.planning_ceiling_months } = {}) {
  const issues = [];
  const asked = require('./prompts').isPositionPrompt(promptVersion);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (asked) issues.push({ severity: 'warning', field: 'position_context', message: 'The prompt asked for a position_context block (market view, timing view, review date) and the report has none. Its position and timing views are unknown.' });
    return { context: null, issues };
  }
  const h = raw.horizon && typeof raw.horizon === 'object' ? raw.horizon : {};
  const mode = ['position', 'long_term'].includes(h.mode) ? h.mode : null;
  if (h.mode !== undefined && !mode) issues.push({ severity: 'warning', field: 'position_context.horizon.mode', message: `"${String(h.mode).slice(0, 40)}" is not position or long_term.` });
  const start = dateOf(h.start_date, 'position_context.horizon.start_date', issues);
  const end = dateOf(h.end_date, 'position_context.horizon.end_date', issues);
  if (start && end && end <= start) issues.push({ severity: 'warning', field: 'position_context.horizon', message: `The horizon ends (${end}) on or before it starts (${start}).` });
  if (mode === 'position' && start && end && end > addCalendarMonths(start, ceiling)) issues.push({ severity: 'warning', field: 'position_context.horizon', message: `A position horizon from ${start} to ${end} is longer than the ${ceiling}-month planning ceiling.` });

  const m = raw.market && typeof raw.market === 'object' ? raw.market : {};
  const marketState = enumOf(m.state, MARKET_STATES, 'position_context.market.state', issues);
  const market = { state: marketState.state, state_raw: marketState.raw, rationale: str(m.rationale), evidence_refs: refs(m.evidence_refs) };
  if (market.state !== 'unknown' && !market.evidence_refs.length) issues.push({ severity: 'warning', field: 'position_context.market.evidence_refs', message: 'A market reading without evidence references: shown, but not backed by a cited claim or source.' });

  const tm = raw.timing && typeof raw.timing === 'object' ? raw.timing : {};
  const timingState = enumOf(tm.state, TIMING_STATES, 'position_context.timing.state', issues);
  const review = dateOf(tm.next_review_date, 'position_context.timing.next_review_date', issues);
  const timing = { state: timingState.state, state_raw: timingState.raw, rationale: str(tm.rationale), evidence_refs: refs(tm.evidence_refs), next_review_date: review, review_trigger: str(tm.review_trigger, 1000) };
  if (timing.state !== 'unknown' && !timing.evidence_refs.length) issues.push({ severity: 'warning', field: 'position_context.timing.evidence_refs', message: 'A timing view without evidence references: shown, but not backed by a cited claim or source.' });
  const analysisDay = analysisAt && isYmd(String(analysisAt).slice(0, 10)) ? String(analysisAt).slice(0, 10) : null;
  if (review && analysisDay && review < analysisDay) issues.push({ severity: 'warning', field: 'position_context.timing.next_review_date', message: `The suggested review date ${review} is before the analysis date ${analysisDay}.` });
  if (review && end && review > end) issues.push({ severity: 'warning', field: 'position_context.timing.next_review_date', message: `The suggested review date ${review} is after the horizon ends (${end}).` });

  const windows = [];
  (Array.isArray(catalysts) ? catalysts : []).forEach((c, i) => {
    if (!c || typeof c !== 'object' || !c.title) return;
    const ws_ = dateOf(c.window_start, `catalysts[${i}].window_start`, issues);
    const we = dateOf(c.window_end, `catalysts[${i}].window_end`, issues);
    if (ws_ && we && we < ws_) issues.push({ severity: 'warning', field: `catalysts[${i}]`, message: `The window of "${String(c.title).slice(0, 60)}" ends before it starts.` });
    const cert = enumOf(c.certainty, CERTAINTY, `catalysts[${i}].certainty`, issues);
    const point = !ws_ && !we && c.date && isYmd(String(c.date).slice(0, 10)) ? String(c.date).slice(0, 10) : null;
    const from = ws_ || point;
    const to = we || ws_ || point;
    let inHorizon = typeof c.in_horizon === 'boolean' ? c.in_horizon : null;
    // The app's own reading, from the dates, beside what the report says.
    const datesSay = start && end && from && to ? !(to < start || from > end) : null;
    if (inHorizon !== null && datesSay !== null && inHorizon !== datesSay) issues.push({ severity: 'warning', field: `catalysts[${i}].in_horizon`, message: `"${String(c.title).slice(0, 60)}" says in_horizon ${inHorizon}, but its dates say ${datesSay}.` });
    if (inHorizon === null) inHorizon = datesSay;
    windows.push({ title: String(c.title).slice(0, 300), window_start: from, window_end: to, certainty: cert.state, certainty_raw: cert.raw, in_horizon: inHorizon, claim_ids: refs(c.claim_ids) });
  });

  return {
    context: {
      schema_version: 'cr.position-context.v1',
      recipe: str(raw.recipe, 64),
      horizon: { mode, start_date: start, end_date: end },
      market,
      timing,
      catalyst_windows: windows,
      long_term_note: str(raw.long_term_note),
      run_binding: null,
      note: 'The model\'s own position and timing views. They change no score or grade; timing_executable_liquidity stays the only timing score.',
    },
    issues,
  };
}

// Every evidence reference inside the block, for the citation check.
function contextRefs(pc) {
  if (!pc) return [];
  const out = [];
  pc.market.evidence_refs.forEach((id, j) => out.push({ path: `position_context.market.evidence_refs[${j}]`, id }));
  pc.timing.evidence_refs.forEach((id, j) => out.push({ path: `position_context.timing.evidence_refs[${j}]`, id }));
  return out;
}

// Binds the block to the research run it answers, on import: the horizon and
// recipe must be the run's. A mismatch is recorded and shown; it never moves
// the report into another run or changes the run's horizon.
function bindToRun(ws, projectId, runId, assessment) {
  const issues = [];
  const pc = assessment && assessment.position_context;
  if (!runId) return { binding: null, issues };
  let run = null;
  try {
    run = require('./research').loadRun(ws, projectId, runId);
  } catch (_) {
    run = null;
  }
  if (!run) return { binding: { run_id: runId, run_found: false }, issues };
  const rh = run.horizon || {};
  const runIsRecipe = rh.recipe === RECIPE_ID;
  const binding = { run_id: runId, run_found: true, run_recipe: rh.recipe || null, run_horizon: runIsRecipe ? { mode: rh.mode, start_date: rh.start_date, end_date: rh.end_date } : { text: rh.text || null } };
  if (!runIsRecipe) return { binding, issues };
  if (!pc) {
    binding.horizon_matches = null;
    return { binding, issues };
  }
  const h = pc.horizon;
  binding.horizon_matches = h.mode === rh.mode && h.start_date === rh.start_date && h.end_date === rh.end_date;
  if (!binding.horizon_matches) {
    issues.push({ severity: 'warning', field: 'position_context.horizon', message: `The report's horizon (${h.mode || '?'}, ${h.start_date || '?'} to ${h.end_date || '?'}) is not the run's (${rh.mode}, ${rh.start_date} to ${rh.end_date}). Its timing views are shown as written; compare them with care.` });
  }
  binding.recipe_matches = !pc.recipe || pc.recipe === RECIPE_ID;
  if (!binding.recipe_matches) issues.push({ severity: 'warning', field: 'position_context.recipe', message: `The report names recipe "${pc.recipe}", not ${RECIPE_ID}.` });
  return { binding, issues };
}

// Compact form for the index, the scorecard preview and the summary panel.
function compactContext(assessment, { today = ymdInTz() } = {}) {
  const pc = assessment && assessment.position_context;
  if (!pc) return { status: assessment && require('./prompts').isPositionPrompt(assessment.prompt_version) ? 'missing' : 'not_in_recipe' };
  const windows = pc.catalyst_windows || [];
  const upcoming = windows
    .filter((w) => w.in_horizon !== false && (w.window_end || w.window_start || '') >= today)
    .sort((a, b) => String(a.window_start || a.window_end || '9999').localeCompare(String(b.window_start || b.window_end || '9999')));
  const review = pc.timing.next_review_date;
  return {
    status: 'provided',
    horizon: pc.horizon,
    market_state: pc.market.state,
    market_label: MARKET_LABELS[pc.market.state],
    timing_state: pc.timing.state,
    timing_label: TIMING_LABELS[pc.timing.state],
    timing_rationale: pc.timing.rationale ? pc.timing.rationale.slice(0, 400) : null,
    market_rationale: pc.market.rationale ? pc.market.rationale.slice(0, 400) : null,
    next_review_date: review,
    review_in_days: review ? daysBetween(today, review) : null,
    review_trigger: pc.timing.review_trigger,
    catalysts_in_horizon: windows.filter((w) => w.in_horizon === true).length,
    next_catalyst: upcoming[0] ? { title: upcoming[0].title, window_start: upcoming[0].window_start, window_end: upcoming[0].window_end, certainty: upcoming[0].certainty } : null,
    horizon_matches_run: pc.run_binding ? pc.run_binding.horizon_matches ?? null : null,
  };
}

module.exports = {
  RECIPE_ID,
  DEFAULT_POLICY,
  MARKET_STATES,
  TIMING_STATES,
  CERTAINTY,
  MARKET_LABELS,
  TIMING_LABELS,
  policy,
  addCalendarMonths,
  horizonText,
  monthsFrom,
  resolveRunHorizon,
  checkHorizon,
  normalizePositionContext,
  contextRefs,
  bindToRun,
  compactContext,
};
