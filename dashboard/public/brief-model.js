// The Claude Brief's content, read from one saved report: which report it
// reads, by the desk's own rules, and what each part of the page shows. Every
// value is the report's own words or the desk's own calculation from it, and
// it says which; nothing is summarized, averaged or filled in, and a missing
// value stays missing (never zero, never a midpoint). Nothing here fetches,
// saves or starts anything. No DOM: pure, for the tests.
import {
  PROVIDER_LABELS, anchorText, scoreTier, withheldReason, unscoredFrom, jobKey, onHoldOf, researchState, badgeInfo,
  fmtPrice, fmtChangePct, fmtMarketUsd, fmtMarketFigure, fmtNum,
} from './ui.js';
import { profileOf, categoryRows, scorecardCounts, categoryFlags, scenarioRows, CONFIDENCE_LABELS } from './thesis-ui.js';

// The brief's own format. It is drawn from the saved report each time it is
// opened and never stored, so it cannot drift from its report; the binding
// (project, report, run and the original's SHA-256) is shown with it.
export const BRIEF_FORMAT = 'cr-brief@1';

const TZ = 'America/New_York';
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const ymd = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
const list = (v) => (Array.isArray(v) ? v : []);
export const todayET = (now = Date.now()) => new Date(now).toLocaleDateString('en-CA', { timeZone: TZ });

// ---- which report -------------------------------------------------------------

const isPdf = (r) => Boolean(r && r.assessment && (r.assessment.needs_text || r.assessment.source_format === 'pdf'));

// Why a saved report cannot carry a brief, or null when it can: an answer
// quarantined because it does not match its research run, a report excluded
// from comparison, a PDF without a text copy, or a file that cannot be read.
export function ineligibleReason(r) {
  if (!r || r.broken) return { kind: 'broken', reason: (r && r.error) || 'The report could not be read.' };
  const el = r.assessment && r.assessment.eligibility;
  if (el && el.excluded) return { kind: el.quarantined ? 'quarantined' : 'excluded', reason: str(el.reason), conflicts: list(el.conflicts) };
  if (r.eligible === false) return { kind: 'excluded', reason: null, conflicts: [] };
  if (isPdf(r)) return { kind: 'pdf', reason: null, conflicts: [] };
  return null;
}

// The report a brief reads. Without a report ID: the model's latest eligible
// report, exactly the one the desk's comparison names (eligible, not a PDF,
// newest by the desk's sort key), so a quarantined or excluded answer is never
// picked and a run still in progress leaves the last saved report in place.
// With one: that report, if it is this model's and eligible; it stays bound
// to its own report however many newer ones exist.
export function selectBriefReport(d, { provider = 'claude', reportId = null } = {}) {
  const reports = list(d && d.reports);
  const meta = d && d.comparison && d.comparison.latest ? d.comparison.latest[provider] : null;
  const latestRaw = meta ? reports.find((r) => r && !r.broken && r.report_id === meta.report_id) || null : null;
  const latest = latestRaw && latestRaw.meta && latestRaw.meta.provider === provider && !ineligibleReason(latestRaw) ? latestRaw : null;
  const own = reports.filter((r) => r && !r.broken && r.meta && r.meta.provider === provider);
  const base = { latest, own, reportId: reportId || null };
  if (reportId) {
    const r = reports.find((x) => x && x.report_id === reportId) || null;
    if (!r) return { ...base, status: 'not_found', report: null };
    if (r.broken) return { ...base, status: 'broken', report: r, why: ineligibleReason(r) };
    if (!r.meta || r.meta.provider !== provider) return { ...base, status: 'other_provider', report: r };
    const why = ineligibleReason(r);
    if (why) return { ...base, status: 'ineligible', report: r, why };
    return { ...base, status: 'ok', report: r, isLatest: Boolean(latest && latest.report_id === r.report_id) };
  }
  if (latest) return { ...base, status: 'ok', report: latest, isLatest: true };
  return { ...base, status: 'none', report: null };
}

// ---- the project ---------------------------------------------------------------

const chainWords = (id) => String(id || '').replace(/[-_]+/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase()).trim();

// Name, ticker, the chains of the token on record (named as the contract
// screen names them) and whether the identity is verified.
export function identityOf(d, row = null) {
  const p = (d && d.project) || {};
  const id = p.identity || {};
  const screened = list(d && d.screening && d.screening.contracts).concat(list(row && row.screening && row.screening.contracts));
  const chains = [];
  for (const a of list(id.assets)) {
    if (!a || !a.chain) continue;
    const addr = a.contract_address ? String(a.contract_address) : null;
    const hit = screened.find((c) => c && c.address && addr && String(c.address).toLowerCase() === addr.toLowerCase());
    const label = (hit && hit.label) || chainWords(a.chain);
    const known = chains.find((c) => c.label === label);
    if (known) known.addresses.push(addr);
    else chains.push({ label, addresses: [addr].filter(Boolean) });
  }
  return {
    project_id: p.project_id || (row && row.project_id) || null,
    name: p.name || (row && row.name) || p.project_id || 'Project',
    symbol: p.symbol || (row && row.symbol) || null,
    verified: id.status === 'verified',
    status: id.status || 'unknown',
    native: id.native_chain === true,
    chains,
    website: /^https?:\/\//i.test(String(id.official_website || '')) ? id.official_website : null,
    archived: p.status === 'archived',
  };
}

// The market now, from the index row the watchlist already has (never
// fetched here), with its own time: kept apart from the research date.
export function marketNow(row) {
  const m = row && row.market;
  if (!m || m.status === 'invalid' || !num(m.price_usd)) return null;
  const demo = /fictional/i.test(`${m.rank_source_label || ''} ${m.source || ''}`);
  return {
    price: fmtPrice(m.price_usd),
    change24h: fmtChangePct(m.change_24h_pct),
    change: num(m.change_24h_pct) ? m.change_24h_pct : null,
    mcap: fmtMarketFigure(m.market_cap_usd),
    volume: fmtMarketFigure(m.volume_24h_usd),
    // The source's own values, for the reason an unknown figure gives.
    mcap_usd: m.market_cap_usd ?? null,
    volume_usd: m.volume_24h_usd ?? null,
    as_of: m.as_of || m.fetched_at || null,
    stale: m.status === 'stale',
    source: demo ? 'Fictional demo data' : m.source || 'CoinGecko',
  };
}

// ---- the verdict and the grade ---------------------------------------------------

export const VERDICT_WORDS = {
  'ATTRACTIVE ASYMMETRY': 'Attractive asymmetry',
  'CONDITIONAL OPPORTUNITY': 'Conditional opportunity',
  'REAL PRODUCT, WEAK TOKEN': 'Real product, weak token',
  'INCENTIVE-DEPENDENT': 'Incentive-dependent',
  'UNFAVORABLE VALUATION': 'Unfavorable valuation',
  'INSUFFICIENT EVIDENCE': 'Insufficient evidence',
};
export const TIMING_WORDS = { early: 'Early', developing: 'Developing', extended: 'Extended', thesis_impaired: 'Thesis impaired' };
export const MARKET_WORDS = { bitcoin_led: 'Bitcoin-led', broad_altcoin_participation: 'Broad altcoin participation', mixed: 'Mixed', contracting: 'Contracting' };

export function verdictOf(a) {
  const v = str(a.verdict);
  const pc = a.position_context || null;
  const view = (x, words) => (x && words[x.state] ? { word: words[x.state], rationale: str(x.rationale) } : null);
  return {
    label: v ? VERDICT_WORDS[v] || v.charAt(0) + v.slice(1).toLowerCase() : null,
    raw: v,
    summary: str(a.summary),
    final_take: str(a.final_take),
    timing: view(pc && pc.timing, TIMING_WORDS),
    market: view(pc && pc.market, MARKET_WORDS),
  };
}

// The investment grade exactly as the desk calculated it from the report's six
// weighted components (never the model's own total): its figure and the
// rubric's word, a range as its two ends, or withheld with what is missing.
export function gradeOf(r, grading, provider = 'claude') {
  const g = r && r.grade;
  const a = (r && r.assessment) || {};
  const anchors = (grading && grading.favorable_anchors) || [];
  if (!g) return { status: 'none', reason: 'No grade was calculated for this report.' };
  if (g.status === 'firm' || g.status === 'range') {
    const s = g.status === 'range' ? { status: 'range', low: g.low, high: g.high } : { status: 'scored', value: g.value };
    return { status: g.status, display: g.display, value: num(g.value) ? g.value : null, low: num(g.low) ? g.low : null, high: num(g.high) ? g.high : null, label: g.label || null, word: anchorText(anchors, s), tier: scoreTier(g.status === 'range' ? g.low : g.value), rubric: g.rubric || a.rubric_version || null, grade: g };
  }
  if (g.status === 'withheld') {
    return { status: 'withheld', coverage: num(g.coverage_pct) ? g.coverage_pct : null, why: withheldReason(provider, g, unscoredFrom(g, a.investment_components)), rubric_status: g.rubric_status || null, reason: str(g.reason), rubric: g.rubric || a.rubric_version || null, grade: g };
  }
  return { status: g.status || 'none', reason: str(g.reason) || 'No grade was calculated for this report.', grade: g };
}

// The six weighted components the grade is calculated from, in the rubric's
// order: weight, the score as given (a point, a range, or unknown with the
// model's reason) and, for a calculated point grade, the points it adds.
export function componentRows(r, grading) {
  const a = (r && r.assessment) || {};
  const parts = r && r.grade && Array.isArray(r.grade.parts) && r.grade.parts.length ? r.grade.parts : null;
  const defs = parts
    ? parts.map((p) => ({ id: p.id, label: p.label, weight_pct: p.weight_pct }))
    : list(grading && grading.investment_components).map((c) => ({ id: c.id, label: c.label, weight_pct: c.weight_bp / 100 }));
  return defs.map((def) => {
    const s = (a.investment_components || {})[def.id] || null;
    const part = parts ? parts.find((p) => p.id === def.id) : null;
    return {
      ...def,
      score: s,
      status: s ? s.status : 'missing',
      contribution: part && num(part.contribution) ? part.contribution : null,
      rationale: s ? str(s.rationale) : null,
      missing: s ? str(s.missing_data) : null,
    };
  });
}

// ---- the category grades -----------------------------------------------------------

// Grouped as the research is: the project and its build, the product and its
// demand, the token, the market. A category another profile defines that is
// not listed here falls under Other.
export const CATEGORY_GROUPS = [
  ['project', 'Project and build', ['legitimacy', 'development_credibility', 'build_operational_quality', 'code_quality', 'builder_operations', 'credit_risk_transparency', 'protocol_risk_transparency', 'technical_risk_transparency']],
  ['product', 'Product and demand', ['product_reality', 'technology_usefulness', 'organic_demand', 'product_usefulness', 'differentiation', 'category_potential']],
  ['token', 'Token and valuation', ['token_value_capture', 'valuation_supply_attractiveness']],
  ['market', 'Market and timing', ['chart_structure', 'cycle_timing', 'volume_liquidity', 'btc_relative_opportunity', 'chart_quality']],
];

const statusOf = (s, na) => (na ? 'na' : !s ? 'missing' : s.status === 'scored' || s.status === 'range' || s.status === 'unknown' ? s.status : s.status === 'not_applicable' ? 'na' : 'unknown');

export function categoryGroups(r, profiles, fallbackProfile = null, anchors = []) {
  const a = (r && r.assessment) || {};
  const profile = profileOf(profiles, a, fallbackProfile);
  const rows = categoryRows(profile, a);
  const flags = list(r && r.evidence && r.evidence.flags);
  const items = rows.map((x) => {
    const s = x.score;
    const na = Boolean(x.def && x.def.applicable === false);
    const status = statusOf(s, na);
    const scored = status === 'scored' || status === 'range';
    return {
      id: x.id,
      label: x.label,
      definition: x.def ? str(x.def.definition) : null,
      status,
      value: status === 'scored' && num(s.value) ? s.value : null,
      low: status === 'range' && num(s.low) ? s.low : null,
      high: status === 'range' && num(s.high) ? s.high : null,
      tier: status === 'scored' ? scoreTier(s.value) : status === 'range' ? scoreTier(s.low) : null,
      word: scored ? anchorText(anchors, s) : null,
      confidence: scored && CONFIDENCE_LABELS[s.confidence] ? s.confidence : null,
      rationale: s ? str(s.rationale) : null,
      missing: s ? str(s.missing_data) : null,
      na_reason: na ? str(x.def.na_reason) || (s ? str(s.rationale) : null) : null,
      strongest_evidence: s ? str(s.strongest_evidence) : null,
      main_weakness: s ? str(s.main_weakness) : null,
      would_raise: s ? str(s.would_raise) : null,
      would_lower: s ? str(s.would_lower) : null,
      from_prose: Boolean(s && s.extraction),
      flags: categoryFlags(flags, x.id).map((f) => ({ severity: f.severity, text: f.beside || f.message })),
    };
  });
  const known = new Set(CATEGORY_GROUPS.flatMap(([, , ids]) => ids));
  const groups = CATEGORY_GROUPS
    .map(([id, title, ids]) => ({ id, title, items: items.filter((x) => ids.includes(x.id)) }))
    .concat([{ id: 'other', title: 'Other', items: items.filter((x) => !known.has(x.id)) }])
    .filter((g) => g.items.length);
  return { profile_ref: a.sector_profile || (profile && profile.profile_ref) || null, groups, items, counts: scorecardCounts(rows) };
}

// ---- the thesis ---------------------------------------------------------------------

// Three questions the brief answers from the report's own reasoning, each
// from the first field that holds an answer, labeled with where it comes
// from. Nothing is written for the model: an unanswered question says so.
const MATTERS = ['technology_usefulness', 'product_reality', 'product_usefulness', 'category_potential', 'differentiation'];
export function thesisOf(a, categories, components) {
  const cat = (id) => categories.items.find((x) => x.id === id);
  const comp = (id) => components.find((x) => x.id === id);
  const view = (key) => {
    const v = a.independent_judgment && a.independent_judgment[key];
    return v && str(v.view) ? v : null;
  };
  // Only a graded category's reasoning: an unknown one says what is missing,
  // which is not an answer to the question.
  const fromCategory = (id) => {
    const c = cat(id);
    return c && c.rationale && (c.status === 'scored' || c.status === 'range') ? { text: c.rationale, from: 'category', label: c.label, status: c.status, value: c.value, low: c.low, high: c.high } : null;
  };
  const fromComponent = (id) => {
    const c = comp(id);
    return c && c.rationale ? { text: c.rationale, from: 'component', label: c.label, weight_pct: c.weight_pct, score: c.score } : null;
  };
  const fromView = (key, label) => {
    const v = view(key);
    return v ? { text: str(v.view), from: 'judgment', label, kind: v.label === 'judgment' || v.label === 'speculation' ? v.label : null, test: str(v.disconfirming_test) } : null;
  };
  const first = (...fns) => fns.reduce((found, fn) => found || fn(), null);
  return [
    { id: 'matters', title: 'Why it matters', answer: first(...MATTERS.map((id) => () => fromCategory(id))) },
    { id: 'capture', title: 'How the token could capture value', answer: first(() => fromComponent('token_value_capture'), () => fromCategory('token_value_capture')) },
    { id: 'asymmetry', title: 'What could make it asymmetric in this horizon', answer: first(() => fromView('within_holding_period', 'What could happen within the holding period'), () => fromComponent('btc_relative_asymmetry'), () => fromView('advantage_over_btc', 'Advantage over holding BTC'), () => fromCategory('btc_relative_opportunity')) },
  ];
}

// Where the value goes, in the three layers the research prompt keeps apart:
// business activity, income paid to participants, and what reaches token
// holders. Each figure as reported, with its period, date and tag; a layer
// the report does not quantify says so. Drawn only when the report reports
// figures in at least two layers, so the comparison is the report's own.
export const VALUE_LAYERS = [
  ['business', 'Business activity', ['business_revenue', 'usage_volume', 'protocol_revenue', 'network_usage', 'payment_volume', 'outstanding_credit', 'credit_losses']],
  ['participants', 'Paid to participants', ['user_yield', 'lp_yield', 'participant_rewards', 'staking_yield', 'incentive_spend']],
  ['holders', 'Reaches token holders', ['token_holder_distributions']],
];

export function metricText(m) {
  if (!m || !num(m.value)) return null;
  const unit = str(m.unit) || '';
  if (/^usd$|^\$$/i.test(unit)) return fmtMarketUsd(m.value);
  if (/^%$|percent|^pct$/i.test(unit)) return `${fmtNum(m.value, 2)}%`;
  return `${fmtNum(m.value, 2)}${unit ? ` ${unit}` : ''}`;
}

export function valueLayers(a, profile) {
  const ec = (a && a.economics) || {};
  const fields = list(profile && profile.economics_fields);
  const reported = (m) => Boolean(m) && m.status !== 'unknown' && m.status !== 'not_applicable' && num(m.value);
  const item = (id, label, definition) => {
    const m = ec[id] || null;
    return { id, label, definition: definition || (m && str(m.definition)) || null, reported: reported(m), text: reported(m) ? metricText(m) : null, period: m ? str(m.period) : null, as_of: m ? str(m.as_of) : null, tag: m && ['V', 'C', 'I', 'S'].includes(m.evidence_tag) ? m.evidence_tag : null, note: m ? str(m.note) : null };
  };
  const items = fields.map((f) => item(f.id, f.label, f.definition));
  for (const id of Object.keys(ec)) if (!items.some((x) => x.id === id)) items.push(item(id, chainWords(id), null));
  const layers = VALUE_LAYERS.map(([id, title, ids]) => ({ id, title, items: items.filter((x) => ids.includes(x.id)) }));
  const withFigures = layers.filter((l) => l.items.some((x) => x.reported)).length;
  return { layers, items, show: withFigures >= 2 };
}

// ---- what supports it, what threatens it -------------------------------------------

// [V] is the researcher's own classification of its source, never the
// desk's verification: the word says whose it is.
export const TAG_WORDS = { V: 'Researcher-verified', C: 'Project claim', I: 'Inference', S: 'Speculation' };
const TAG_ORDER = ['V', 'C', 'I', 'S'];

// Up to three of the report's strongest positives or risks, each with the
// claims it cites: their evidence tags (verified, project claim, inference,
// speculation: evidence, interpretation and forecast stay apart) and their
// sources. A fact that cites nothing says so.
export function factItems(facts, a, max = 3) {
  const claims = new Map(list(a && a.claims).map((c) => [c.claim_id, c]));
  const sources = new Map(list(a && a.sources).map((s) => [s.source_id, s]));
  return list(facts).filter((f) => f && str(f.text)).slice(0, max).map((f) => {
    const ids = list(f.claim_ids).map(String);
    const cited = ids.map((id) => claims.get(id)).filter(Boolean);
    const srcIds = [...new Set([...cited.flatMap((c) => list(c.source_ids)), ...ids.filter((id) => sources.has(id))])];
    return {
      text: str(f.text),
      claims: cited.map((c) => ({ id: c.claim_id, tag: TAG_ORDER.includes(c.evidence_tag) ? c.evidence_tag : null, as_of: str(c.as_of) })),
      tags: TAG_ORDER.filter((t) => cited.some((c) => c.evidence_tag === t)),
      sources: srcIds.map((id) => sources.get(id)).filter(Boolean),
      dangling: ids.filter((id) => !claims.has(id) && !sources.has(id)),
      from_prose: Boolean(f.extraction),
    };
  });
}

// The first view's three lines, before any category detail: the strongest
// risk the report backs with a cited source (the model lists its risks
// strongest first; when none cites a source, its first risk, said to be
// unsourced), and the first thing it says would confirm the thesis and the
// first that would break it. The report's own words; the full lists stay
// where they are.
export function keyPoints(a) {
  const risks = factItems(a && a.bearish_facts, a, 50);
  const sourced = risks.find((f) => f.sources.length) || null;
  const risk = sourced || risks[0] || null;
  const first = (v) => list(v).map((f) => (f && str(f.text)) || str(f)).filter(Boolean);
  const confirms = first(a && a.conviction_increases);
  const breaks = first(a && a.invalidators);
  return {
    risk: risk ? { ...risk, sourced: Boolean(sourced), rank: risks.indexOf(risk) + 1, of: risks.length } : null,
    confirm: confirms[0] || null,
    confirm_more: Math.max(0, confirms.length - 1),
    break: breaks[0] || null,
    break_more: Math.max(0, breaks.length - 1),
  };
}

// The downside-risk panel, higher meaning more risk: kept apart from the
// quality grades and never folded into them.
export function riskRows(a, grading) {
  return list(grading && grading.risk_scores).map((def) => {
    const s = (a.risk_scores || {})[def.id] || null;
    const status = statusOf(s, false);
    return { id: def.id, label: def.label, definition: str(def.definition), status, value: status === 'scored' && num(s.value) ? s.value : null, low: status === 'range' && num(s.low) ? s.low : null, high: status === 'range' && num(s.high) ? s.high : null, rationale: s ? str(s.rationale) || str(s.missing_data) : null };
  });
}

// ---- what to watch ---------------------------------------------------------------------

// The research run a report answers, from the project record.
export function runOf(d, r) {
  const id = (r && r.provenance && r.provenance.research_run_id) || (r && r.assessment && r.assessment.research_run_id) || null;
  return id ? list(d && d.research && d.research.runs).find((x) => x && x.run_id === id) || null : null;
}

// The horizon: the dates the report declares for its position, else its
// research run's; with neither, only the text the report gives.
export function horizonOf(a, run) {
  const pc = a && a.position_context;
  const own = pc && pc.horizon && ymd(pc.horizon.start_date) && ymd(pc.horizon.end_date) ? pc.horizon : null;
  const rh = run && run.horizon && ymd(run.horizon.start_date) && ymd(run.horizon.end_date) ? run.horizon : null;
  const h = own || rh;
  return {
    start: h ? ymd(h.start_date) : null,
    end: h ? ymd(h.end_date) : null,
    mode: h ? h.mode || null : null,
    months: rh && Number.isInteger(rh.months) ? rh.months : null,
    text: str(a && a.horizon) || (run && run.horizon && str(run.horizon.text)) || null,
    source: own ? 'report' : rh ? 'run' : null,
    matches_run: pc && pc.run_binding ? pc.run_binding.horizon_matches ?? null : null,
  };
}

const DAY_MS = 86400000;
const dayNum = (s) => Date.parse(`${s}T00:00:00Z`) / DAY_MS;

// Where a date sits on the horizon's track, 0 to 100; null outside it.
export function trackPos(date, start, end) {
  if (!ymd(date) || !ymd(start) || !ymd(end) || end <= start) return null;
  if (date < start || date > end) return null;
  return Math.round(((dayNum(date) - dayNum(start)) / (dayNum(end) - dayNum(start))) * 1000) / 10;
}

export const CERTAINTY_WORDS = { project_claimed: 'Project-claimed', source_documented: 'Source-documented', analyst_inferred: 'Analyst inference', unknown: 'Certainty unknown' };

// Dated catalysts inside the horizon and the suggested review date, numbered
// in date order (the track and the list share the numbers); undated catalysts
// and those outside the horizon listed apart. Nothing is dated for the model.
export function watchOf(a, run, { today }) {
  const hz = horizonOf(a, run);
  const pc = a.position_context || null;
  const windows = pc && list(pc.catalyst_windows).length
    ? pc.catalyst_windows
    : list(a.catalysts).filter((c) => c && str(c.title)).map((c) => ({ title: c.title, window_start: c.window_start || c.date || null, window_end: c.window_end || null, certainty: c.certainty || 'unknown', in_horizon: typeof c.in_horizon === 'boolean' ? c.in_horizon : null }));
  const dated = [];
  const undated = [];
  const outside = [];
  for (const w of windows) {
    const start = ymd(w.window_start) || ymd(w.window_end);
    const end = ymd(w.window_end) || start;
    const item = { kind: 'catalyst', title: str(w.title) || 'Untitled catalyst', start, end, certainty: CERTAINTY_WORDS[w.certainty] ? w.certainty : 'unknown', in_horizon: typeof w.in_horizon === 'boolean' ? w.in_horizon : null };
    if (!start) undated.push(item);
    else if (item.in_horizon === false || (hz.start && hz.end && (end < hz.start || start > hz.end))) outside.push(item);
    else dated.push(item);
  }
  const t = pc && pc.timing;
  const review = t && ymd(t.next_review_date) ? { kind: 'review', title: 'Suggested review', start: ymd(t.next_review_date), end: ymd(t.next_review_date), trigger: str(t.review_trigger) } : null;
  const items = [...dated, ...(review ? [review] : [])].sort((x, y) => x.start.localeCompare(y.start) || (x.kind === 'review') - (y.kind === 'review'));
  // On the track a window is drawn inside the horizon (one that began before
  // it starts at its start); the list keeps its own dates.
  const inside = (s) => (hz.start && s < hz.start ? hz.start : hz.end && s > hz.end ? hz.end : s);
  items.forEach((x, i) => {
    x.n = i + 1;
    x.pos = trackPos(x.kind === 'review' ? x.start : inside(x.start), hz.start, hz.end);
    x.pos_end = x.pos === null ? null : trackPos(x.kind === 'review' ? x.end : inside(x.end), hz.start, hz.end);
  });
  const metric = a.next_metric_to_monitor && str(a.next_metric_to_monitor.metric) ? { metric: str(a.next_metric_to_monitor.metric), threshold: str(a.next_metric_to_monitor.threshold), why: str(a.next_metric_to_monitor.why) } : null;
  const texts = (v) => list(v).map((f) => (f && str(f.text)) || str(f)).filter(Boolean);
  // Days into the horizon and days left, counted in New York calendar days.
  const total = hz.start && hz.end && hz.end > hz.start ? dayNum(hz.end) - dayNum(hz.start) : null;
  const days = total === null ? null : { total, elapsed: Math.max(0, Math.min(total, dayNum(today) - dayNum(hz.start))), left: Math.max(0, dayNum(hz.end) - dayNum(today)) };
  return {
    horizon: hz,
    today,
    today_pos: trackPos(today, hz.start, hz.end),
    ended: Boolean(hz.end && today > hz.end),
    days,
    analysis: ymd(a.analysis_at),
    items,
    review,
    review_trigger_only: !review && t && str(t.review_trigger) ? str(t.review_trigger) : null,
    undated,
    outside,
    confirms: texts(a.conviction_increases),
    breaks: texts(a.invalidators),
    metric,
  };
}

// ---- the scenarios ---------------------------------------------------------------------

// Bear, base and bull as the report gives them. The probability bar is drawn
// only for a complete set that totals 100; the price plot only when at least
// two cases give both ends of a range. Otherwise the words say what is given.
export function scenariosOf(a) {
  const sc = a && a.scenarios;
  const rows = scenarioRows(sc);
  if (!rows.length) return null;
  const items = list(sc.items);
  const caseOf = (id) => items.find((s) => s && String(s.case || '').toLowerCase() === id) || {};
  const out = rows.map((x) => {
    const it = caseOf(x.id);
    const pr = it.price_range_usd || {};
    return { ...x, range: num(pr.low) && num(pr.high) && pr.high >= pr.low ? { low: pr.low, high: pr.high } : null };
  });
  const check = sc.probability_check || null;
  return {
    rows: out,
    probability: check,
    targets: sc.target_check || null,
    definition: str(sc.btc_relative_definition),
    probability_note: str(sc.probability_note),
    target_note: str(sc.target_note),
    bar: Boolean(check && check.status === 'ok' && out.every((x) => num(x.probability))),
    plot: out.filter((x) => x.range).length >= 2,
  };
}

// ---- evidence and provenance -----------------------------------------------------------

// The report's claims by evidence tag, the desk's evidence checks, and the
// limits the report itself states (unknown grades with what is missing, the
// code and chart data it could not read, why scenario numbers are missing).
export function evidenceOf(r, categories) {
  const a = (r && r.assessment) || {};
  const claims = list(a.claims);
  const counts = { V: 0, C: 0, I: 0, S: 0, other: 0 };
  for (const c of claims) counts[TAG_ORDER.includes(c.evidence_tag) ? c.evidence_tag : 'other'] += 1;
  const ev = (r && r.evidence) || null;
  const flags = list(ev && ev.flags);
  const level = !flags.length ? null : ev.high > 0 ? 'serious' : ev.medium > 0 ? 'material' : 'minor';
  const limits = [];
  for (const x of categories.items.filter((c) => c.status === 'unknown' || c.status === 'missing')) limits.push({ label: x.label, text: x.missing || (x.status === 'missing' ? 'Not graded in this report.' : 'Unknown; the report does not say what is missing.') });
  if (a.code_review && str(a.code_review.limitations)) limits.push({ label: 'Code that was read', text: str(a.code_review.limitations) });
  if (a.chart_cycle && a.chart_cycle.data && str(a.chart_cycle.data.limitations)) limits.push({ label: 'Chart data', text: str(a.chart_cycle.data.limitations) });
  if (a.scenarios && str(a.scenarios.probability_note)) limits.push({ label: 'Scenario probabilities', text: str(a.scenarios.probability_note) });
  if (a.scenarios && str(a.scenarios.target_note)) limits.push({ label: 'Scenario price ranges', text: str(a.scenarios.target_note) });
  return {
    counts,
    total: claims.length,
    claims,
    checks: ev,
    flags,
    level,
    flagged_claims: ev ? ev.flagged_claims || 0 : 0,
    flagged_categories: ev ? ev.flagged_categories || 0 : 0,
    limits,
    questions: list(a.unresolved_questions).map(str).filter(Boolean),
    sources: list(a.sources),
    integrity: r && r.integrity ? r.integrity.status || null : null,
  };
}

// The exact records the brief is drawn from: project, report, run and the
// original's SHA-256, with the versions the report declares.
export function provenanceOf(r, d, run) {
  const a = (r && r.assessment) || {};
  const pv = (r && r.provenance) || {};
  const meta = (r && r.meta) || {};
  const issues = list(r && r.extraction && r.extraction.issues);
  return {
    format: BRIEF_FORMAT,
    project_id: (d && d.project && d.project.project_id) || null,
    report_id: r ? r.report_id : null,
    run_id: pv.research_run_id || a.research_run_id || null,
    run_found: Boolean(run),
    run_created_at: run ? run.created_at || null : null,
    analysis_at: str(a.analysis_at),
    saved_at: meta.imported_at || null,
    model: str(a.model_version),
    attested: Boolean(pv.attested),
    channel: str(pv.channel),
    prompt_version: str(a.prompt_version),
    rubric_version: str(a.rubric_version),
    sector_profile: str(a.sector_profile),
    horizon: str(a.horizon),
    sha256: str(meta.original_sha256),
    source_format: str(a.source_format),
    corrections: list(r && r.corrections).length,
    corrected_fields: list(a.corrected_fields),
    fields_from_run: list(a.fields_from_run),
    extraction_errors: issues.filter((i) => i && i.severity === 'error').length,
    ambiguous: list(r && r.extraction && r.extraction.ambiguous).length,
  };
}

// The model's reports on this project, newest first: each one's own brief (or
// why it has none), so an earlier brief stays bound to its own report.
export function historyOf(d, provider, currentId, latestId) {
  return list(d && d.history && d.history[provider]).slice().reverse().map((s) => ({
    report_id: s.report_id,
    analysis_at: s.analysis_at || null,
    saved_at: s.imported_at || null,
    grade: s.grade || null,
    verdict: s.verdict ? VERDICT_WORDS[s.verdict] || s.verdict : null,
    eligible: Boolean(s.eligible) && !s.needs_text,
    excluded: s.excluded_reason || null,
    needs_text: Boolean(s.needs_text),
    // Where it sits among the model's reports (revisions.js): a revision of an
    // earlier save for the same run says on what evidence; new research for
    // another run, and the first report, say so too.
    revision: s.revision_label || (s.revision && s.revision.kind === 'new_run' ? 'New research (another run)' : s.revision && s.revision.kind === 'first' ? 'First report' : null),
    current: s.report_id === currentId,
    latest: s.report_id === latestId,
  }));
}

// ---- notices -------------------------------------------------------------------------------

// What the reader must know before trusting the page, each in one line with
// its detail one tap away: an earlier report than the latest, a revision, the
// model's own total differing from the desk's, evidence flags, newer research,
// a horizon that differs from the run's, a report read from prose, your
// corrections, extraction problems, an analysis time after the save.
export function noticesOf({ r, sel, provider, row, index, history, ev, hz }) {
  const out = [];
  const a = r.assessment || {};
  const who = PROVIDER_LABELS[provider] || provider;
  if (!sel.isLatest && sel.latest) out.push({ kind: 'older', tone: 'info', latest_id: sel.latest.report_id, latest_at: sel.latest.assessment ? sel.latest.assessment.analysis_at || null : null });
  const rv = r.revision;
  if (rv && rv.kind === 'revision') {
    // What changed, from the stored revision record (revisions.js): the
    // weighted parts that moved, then the basis, then the model's own reason.
    const labels = Object.fromEntries(list(r.grade && r.grade.parts).map((p) => [p.id, p.label]));
    const changed = list(rv.changed_components).map((c) => `${labels[c.id] || String(c.id).replace(/_/g, ' ')} ${c.from} → ${c.to}`);
    out.push({
      kind: 'revision',
      tone: 'info',
      basis: rv.basis || null,
      added: rv.sources && num(rv.sources.added) ? rv.sources.added : 0,
      changed,
      categories: num(rv.changed_categories) ? rv.changed_categories : 0,
      of: rv.of || null,
      minutes: num(rv.minutes_after) ? rv.minutes_after : null,
      declared: rv.declared ? { label: str(rv.declared.label), note: str(rv.declared.note) } : null,
      narrowed: list(rv.narrowed).length,
      narrowed_mid: list(rv.narrowed).filter((x) => x && x.midpoint).length,
    });
  }
  const mt = r.model_total;
  if (mt && mt.status === 'mismatch') out.push({ kind: 'model_total', tone: 'warn', reported: mt.reported || null, calculated: mt.calculated || null, difference: num(mt.difference) ? mt.difference : null, message: str(mt.message) });
  else if (mt && mt.status === 'unverifiable') out.push({ kind: 'model_total_unchecked', tone: 'info', reported: mt.reported || null, message: str(mt.message) });
  // Scores the written text states that differ from the data block the grade
  // is calculated from (core/textscores.js): both shown, neither chosen.
  const tx = r.text_scores;
  if (tx && list(tx.mismatches).length) out.push({ kind: 'text_scores', tone: 'warn', items: list(tx.mismatches).map((m) => ({ label: str(m.label) || String(m.id || ''), text: list(m.text).map(String), data: str(m.data) || 'not given' })) });
  if (ev.level === 'serious' || ev.level === 'material') out.push({ kind: 'evidence', tone: 'warn', level: ev.level, claims: ev.flagged_claims, categories: ev.flagged_categories, high: ev.checks ? ev.checks.high || 0 : 0, medium: ev.checks ? ev.checks.medium || 0 : 0 });
  if (sel.isLatest && row) {
    const job = row.research && row.research.providers ? row.research.providers[provider] : null;
    const held = Boolean(onHoldOf(index, provider));
    const info = job ? badgeInfo(provider, { grade: r.grade, analysis_at: a.analysis_at, imported_at: r.meta && r.meta.imported_at, needs_text: false, evidence: null }, job, { onHold: held }) : null;
    if (info && info.newerText) out.push({ kind: 'newer', tone: info.problem ? 'warn' : 'info', text: info.newerText, working: Boolean(info.refreshing) });
  }
  if (hz.matches_run === false) out.push({ kind: 'horizon', tone: 'warn' });
  if (a.source_format === 'prose') out.push({ kind: 'prose', tone: 'info' });
  if (list(r.corrections).length) out.push({ kind: 'corrections', tone: 'info', count: list(r.corrections).length, fields: list(a.corrected_fields) });
  const issues = list(r.extraction && r.extraction.issues);
  const errors = issues.filter((i) => i && i.severity === 'error').length;
  const ambiguous = list(r.extraction && r.extraction.ambiguous).length;
  if (errors || ambiguous) out.push({ kind: 'extraction', tone: 'warn', errors, ambiguous });
  const t = r.analysis_timing;
  if (t && (t.status === 'after_save' || t.status === 'future')) out.push({ kind: 'timing', tone: 'info', minutes: num(t.minutes_after_save) ? t.minutes_after_save : null });
  return out.map((n) => ({ ...n, who }));
}

// ---- no brief ----------------------------------------------------------------------------------

// Why there is no brief to show, and what can be done from here: the model's
// research in words (working, waiting, failed...), a report the brief cannot
// read (a PDF, a quarantined or excluded answer), and whether the existing
// research action applies. Opening the brief never starts anything.
export function emptyOf(sel, { d, row, index, provider = 'claude', hosted = false }) {
  const who = PROVIDER_LABELS[provider] || provider;
  const p = (d && d.project) || {};
  const archived = p.status === 'archived';
  const hold = onHoldOf(index, provider);
  const job = row && row.research && row.research.providers ? row.research.providers[provider] || null : null;
  const key = jobKey(job, null, { onHold: Boolean(hold) });
  const state = key ? researchState(key, { provider, hosted }) : null;
  const own = sel.own || [];
  const newestFirst = (xs) => xs.slice().sort((x, y) => String((y.meta && y.meta.imported_at) || '').localeCompare(String((x.meta && x.meta.imported_at) || '')));
  const pdf = newestFirst(own.filter((r) => ineligibleReason(r) && ineligibleReason(r).kind === 'pdf'))[0] || null;
  const quarantined = newestFirst(own.filter((r) => ineligibleReason(r) && ineligibleReason(r).kind === 'quarantined'))[0] || null;
  const excluded = newestFirst(own.filter((r) => ineligibleReason(r) && ineligibleReason(r).kind === 'excluded'))[0] || null;
  return {
    kind: sel.status,
    who,
    archived,
    hold,
    job: key ? { key, short: state.short, long: state.long, tone: state.tone, error: job && job.error ? String(job.error) : null } : null,
    pdf: pdf ? { report_id: pdf.report_id, saved_at: pdf.meta ? pdf.meta.imported_at || null : null } : null,
    quarantined: quarantined ? { report_id: quarantined.report_id, reason: ineligibleReason(quarantined).reason } : null,
    excluded: excluded ? { report_id: excluded.report_id, reason: ineligibleReason(excluded).reason } : null,
    other: sel.status === 'other_provider' && sel.report ? PROVIDER_LABELS[sel.report.meta.provider] || sel.report.meta.provider : null,
    why: sel.why || null,
    report_id: sel.reportId,
    latest_id: sel.latest ? sel.latest.report_id : null,
    // The existing action, offered only where the inspector offers it: no
    // research job yet, the project not archived, the model not on hold.
    can_run: !archived && !hold && !job,
  };
}

// ---- the whole brief ----------------------------------------------------------------------------

export function briefModel({ detail, row = null, index, provider = 'claude', reportId = null, hosted = false, today = todayET() }) {
  const sel = selectBriefReport(detail, { provider, reportId });
  const identity = identityOf(detail, row);
  const base = { format: BRIEF_FORMAT, provider, who: PROVIDER_LABELS[provider] || provider, status: sel.status, identity, market: marketNow(row) };
  if (sel.status !== 'ok') return { ...base, empty: emptyOf(sel, { d: detail, row, index, provider, hosted }) };
  const r = sel.report;
  const a = r.assessment || {};
  const rubrics = (index && index.rubrics) || {};
  const grading = rubrics.grading || null;
  const anchors = (grading && grading.favorable_anchors) || [];
  const categories = categoryGroups(r, rubrics.profiles, detail.profile || null, anchors);
  const components = componentRows(r, grading);
  const run = runOf(detail, r);
  const history = historyOf(detail, provider, r.report_id, sel.latest ? sel.latest.report_id : null);
  const evidence = evidenceOf(r, categories);
  const watch = watchOf(a, run, { today });
  const profile = profileOf(rubrics.profiles, a, detail.profile || null);
  const current = detail.research_contract && detail.research_contract.sector_profile;
  return {
    ...base,
    report_id: r.report_id,
    is_latest: Boolean(sel.isLatest),
    latest_id: sel.latest ? sel.latest.report_id : null,
    verdict: verdictOf(a),
    grade: gradeOf(r, grading, provider),
    components,
    categories,
    older_profile: Boolean(current && a.sector_profile && a.sector_profile !== current) ? { report: a.sector_profile, current } : null,
    thesis: thesisOf(a, categories, components),
    value: valueLayers(a, profile),
    supports: factItems(a.bullish_facts, a),
    threatens: factItems(a.bearish_facts, a),
    key: keyPoints(a),
    risks: riskRows(a, grading),
    watch,
    scenarios: scenariosOf(a),
    chart: Boolean(a.chart_cycle),
    evidence,
    provenance: provenanceOf(r, detail, run),
    history,
    notices: noticesOf({ r, sel, provider, row, index, history, ev: evidence, hz: watch.horizon }),
    structure: r.structure && r.structure.flagged ? r.structure : null,
    report: r,
  };
}
