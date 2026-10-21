'use strict';
// Report blocks added by cr-research-prompt@5 (report format cr.report.v2):
//
//   code_review           which code was read, at which commit, and whether it
//                         can be connected to what is deployed
//   chart_cycle           the token's chart, volume and cycle reading, with the
//                         data source it rests on
//   independent_judgment  the model's own view, each part labeled judgment or
//                         speculation, with the test that would disprove it
//
// They are read as written, bounded and never completed: a missing value
// stays null, and a word outside an accepted list is read as unknown and
// kept. A reading given without what the prompt asks beside it (a level
// without a named data source, a volume reading without its baseline, files
// without a commit) is noted, not removed. Nothing here changes a score or a
// grade. Older reports have none of these blocks; nothing is inferred for them.

const PHASES = ['unknown', 'launch', 'decline', 'base_formation', 'possible_accumulation', 'breakout', 'expansion', 'distribution', 'renewed_decline'];
const PHASE_LABELS = {
  unknown: 'Unknown',
  launch: 'Launch',
  decline: 'Decline',
  base_formation: 'Base formation',
  possible_accumulation: 'Possible accumulation',
  breakout: 'Breakout',
  expansion: 'Expansion',
  distribution: 'Distribution',
  renewed_decline: 'Renewed decline',
};
const SOURCE_ACCESS = ['unknown', 'public', 'partial', 'none'];
const DEPLOYED_LINK = ['unknown', 'verified', 'partial', 'not_verified', 'not_applicable'];
const LEVEL_KINDS = ['support', 'resistance'];
const JUDGMENT_LABELS = ['judgment', 'speculation'];
// The questions of the prompt's "Independent judgment and asymmetry" section.
const JUDGMENT_KEYS = [
  ['market_misunderstanding', 'What the market is likely misunderstanding'],
  ['overlooked_bull_case', 'Strongest overlooked bull case'],
  ['overlooked_bear_case', 'Strongest overlooked bear case'],
  ['technology_without_token', 'Could the technology succeed while the token performs poorly'],
  ['within_holding_period', 'What could happen within the holding period'],
  ['advantage_over_btc', 'Advantage over holding BTC for the same period'],
  // cr-research-prompt@6 adds section 4's two tests and the one-sentence
  // thesis (Eric, 2026-10-21). Read wherever a report gives them; a report
  // without them (every earlier prompt) keeps its block exactly as before.
  ['payment_waterfall', 'Who still pays if the price stops rising, and how $1 reaches the holder'],
  ['per_token_cash_flow', 'Holder cash flow per token against supply growth'],
  ['falsifiable_thesis', 'One-sentence falsifiable thesis'],
];
const V6_JUDGMENT_KEYS = new Set(['payment_waterfall', 'per_token_cash_flow', 'falsifiable_thesis']);
// The judgment parts a prompt version asks for.
function judgmentKeysFor(promptVersion) {
  const m = /^cr-research-prompt@(\d+)$/.exec(String(promptVersion || '').trim());
  return JUDGMENT_KEYS.filter(([key]) => !V6_JUDGMENT_KEYS.has(key) || (Boolean(m) && Number(m[1]) >= 6));
}
const MAX_TEXT = 4000;

// cr-research-prompt@5 and later ask for these blocks.
function asksFor(promptVersion) {
  const m = /^cr-research-prompt@(\d+)$/.exec(String(promptVersion || '').trim());
  return Boolean(m) && Number(m[1]) >= 5;
}

const str = (v, max = MAX_TEXT) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const texts = (v, { max = 12, each = 600 } = {}) => (Array.isArray(v) ? v.map((x) => str(x, each)).filter(Boolean).slice(0, max) : str(v, each) ? [str(v, each)] : []);
const refs = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(x)))] : []);

function httpUrl(u) {
  if (typeof u !== 'string' || !u.trim()) return null;
  try {
    const url = new URL(u.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch (_) {
    return null;
  }
}

function enumOf(value, allowed, field, issues, fallback = 'unknown') {
  if (value === undefined || value === null || value === '') return { state: fallback, raw: null };
  const v = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (allowed.includes(v)) return { state: v, raw: null };
  issues.push({ severity: 'warning', field, message: `"${String(value).slice(0, 60)}" is not one of ${allowed.join(', ')}; read as ${fallback === null ? 'not given' : fallback} and kept as written.` });
  return { state: fallback, raw: String(value).slice(0, 120) };
}

function missing(name, what, asked) {
  return { block: null, issues: asked ? [{ severity: 'warning', field: name, message: `The prompt asked for the ${name} block (${what}) and the report has none, so it is unknown.` }] : [] };
}

// Which code was read. Files named without the commit they were read at are
// noted: the prompt asks for an identified commit.
function normalizeCodeReview(raw, { asked = false } = {}) {
  if (!isObj(raw)) return missing('code_review', 'which code was read, at which commit, and whether it matches what is deployed', asked);
  const issues = [];
  const access = enumOf(raw.source_access, SOURCE_ACCESS, 'code_review.source_access', issues);
  const repositories = (Array.isArray(raw.repositories) ? raw.repositories : []).filter(isObj).slice(0, 12).map((r, i) => {
    const url = httpUrl(r.url);
    if (r.url && !url) issues.push({ severity: 'warning', field: `code_review.repositories[${i}].url`, message: `Not a usable http(s) URL: ${String(r.url).slice(0, 80)}` });
    const files = texts(r.files_inspected, { max: 40, each: 300 });
    const commit = str(r.commit, 120);
    if (files.length && !commit) issues.push({ severity: 'warning', field: `code_review.repositories[${i}].commit`, message: 'Files are listed as inspected without the commit they were read at.' });
    return { url, url_raw: r.url && !url ? String(r.url).slice(0, 300) : undefined, role: str(r.role, 300), commit, files_inspected: files, observations: str(r.observations) };
  }).filter((r) => r.url || r.url_raw || r.role || r.commit || r.files_inspected.length || r.observations);
  const dl = isObj(raw.deployed_link) ? raw.deployed_link : {};
  const link = enumOf(dl.status, DEPLOYED_LINK, 'code_review.deployed_link.status', issues);
  if (link.state === 'verified' && !str(dl.note)) issues.push({ severity: 'warning', field: 'code_review.deployed_link.note', message: 'The code is said to match what is deployed, without saying how that was checked.' });
  return {
    block: {
      schema_version: 'cr.code-review.v1',
      source_access: access.state,
      source_access_raw: access.raw,
      repositories,
      deployed_link: { status: link.state, status_raw: link.raw, note: str(dl.note) },
      limitations: str(raw.limitations),
      note: 'What the model says it read. A research assessment, not a security audit; it changes no score.',
    },
    issues,
  };
}

// The token's chart, volume and cycle reading. Levels, a phase or a volume
// reading given without the data they rest on are noted, never removed.
function normalizeChartCycle(raw, { asked = false } = {}) {
  if (!isObj(raw)) return missing('chart_cycle', 'the chart, volume and cycle reading with its data source', asked);
  const issues = [];
  const d = isObj(raw.data) ? raw.data : {};
  const data = {
    source: str(d.source, 300),
    venue: str(d.venue, 200),
    pair: str(d.pair, 60),
    timeframes: texts(d.timeframes, { max: 8, each: 40 }),
    latest_observation_at: str(d.latest_observation_at, 60),
    limitations: str(d.limitations),
  };
  const phase = enumOf(raw.phase, PHASES, 'chart_cycle.phase', issues);
  const levels = (Array.isArray(raw.levels) ? raw.levels : []).filter(isObj).slice(0, 16).map((l, i) => {
    const kind = enumOf(l.kind, LEVEL_KINDS, `chart_cycle.levels[${i}].kind`, issues, null);
    const price = typeof l.price_usd === 'number' && Number.isFinite(l.price_usd) && l.price_usd > 0 ? l.price_usd : null;
    if (l.price_usd !== null && l.price_usd !== undefined && price === null) issues.push({ severity: 'warning', field: `chart_cycle.levels[${i}].price_usd`, message: `${JSON.stringify(l.price_usd).slice(0, 40)} is not a positive number; not used.` });
    return { kind: kind.state, kind_raw: kind.raw, price_usd: price, timeframe: str(l.timeframe, 40), basis: str(l.basis, 600) };
  }).filter((l) => l.price_usd !== null || l.basis);
  const v = isObj(raw.volume) ? raw.volume : {};
  const volume = { baseline: str(v.baseline, 600), reading: str(v.reading, 1200), confirms_price: typeof v.confirms_price === 'boolean' ? v.confirms_price : null };
  if (!data.source) {
    if (levels.some((l) => l.price_usd !== null)) issues.push({ severity: 'warning', field: 'chart_cycle.data.source', message: 'Price levels are given without a named data source.' });
    else if (phase.state !== 'unknown') issues.push({ severity: 'warning', field: 'chart_cycle.data.source', message: 'A cycle phase is given without a named data source.' });
  }
  if ((volume.reading || volume.confirms_price !== null) && !volume.baseline) issues.push({ severity: 'warning', field: 'chart_cycle.volume.baseline', message: 'A volume reading is given without the baseline it was compared against.' });
  return {
    block: {
      schema_version: 'cr.chart-cycle.v1',
      data,
      phase: phase.state,
      phase_raw: phase.raw,
      phase_rationale: str(raw.phase_rationale),
      alternative_reading: str(raw.alternative_reading),
      trend_vs_usd: str(raw.trend_vs_usd, 1200),
      trend_vs_btc: str(raw.trend_vs_btc, 1200),
      levels,
      volume,
      liquidity: str(raw.liquidity, 1200),
      confirmation: texts(raw.confirmation, { max: 8 }),
      invalidation: texts(raw.invalidation, { max: 8 }),
      evidence_refs: refs(raw.evidence_refs),
      note: 'The model\'s own chart and cycle reading. It changes no score.',
    },
    issues,
  };
}

// The model's own view. A part given as plain text is kept as its view; a
// label outside judgment / speculation is not guessed.
function normalizeJudgment(raw, { asked = false } = {}) {
  if (!isObj(raw)) return missing('independent_judgment', 'the model\'s own view, labeled judgment or speculation', asked);
  const issues = [];
  const out = {};
  let unlabeled = 0;
  for (const [key] of JUDGMENT_KEYS) {
    const item = raw[key];
    const later = V6_JUDGMENT_KEYS.has(key);
    if (item === undefined || item === null || item === '') {
      if (!later) out[key] = null;
      continue;
    }
    const o = isObj(item) ? item : { view: item };
    const view = str(o.view) || str(o.text);
    if (!view) {
      if (!later) out[key] = null;
      continue;
    }
    const label = enumOf(o.label, JUDGMENT_LABELS, `independent_judgment.${key}.label`, issues, null);
    if (!label.state) unlabeled += 1;
    out[key] = { view, label: label.state, label_raw: label.raw, supporting_evidence: refs(o.supporting_evidence), disconfirming_test: str(o.disconfirming_test, 1200) };
  }
  if (unlabeled) issues.push({ severity: 'warning', field: 'independent_judgment', message: `${unlabeled} view(s) are not labeled judgment or speculation; shown without a label.` });
  if (!Object.values(out).some(Boolean)) return { block: null, issues: asked ? [{ severity: 'warning', field: 'independent_judgment', message: 'The independent_judgment block is empty, so the model\'s own view is unknown.' }] : issues };
  return {
    block: { schema_version: Object.keys(out).some((k) => V6_JUDGMENT_KEYS.has(k)) ? 'cr.independent-judgment.v2' : 'cr.independent-judgment.v1', ...out, note: 'The model\'s own judgment and speculation. Neither is a verified fact, and neither changes a score.' },
    issues,
  };
}

// Every evidence reference inside the blocks, for the citation check.
function blockRefs(a) {
  const out = [];
  const cc = a && a.chart_cycle;
  if (cc && Array.isArray(cc.evidence_refs)) cc.evidence_refs.forEach((id, j) => out.push({ path: `chart_cycle.evidence_refs[${j}]`, id }));
  const ij = a && a.independent_judgment;
  if (ij) {
    for (const [key] of JUDGMENT_KEYS) {
      const item = ij[key];
      if (item && Array.isArray(item.supporting_evidence)) item.supporting_evidence.forEach((id, j) => out.push({ path: `independent_judgment.${key}.supporting_evidence[${j}]`, id }));
    }
  }
  return out;
}

// The category grades of one report in brief: how many are scored or
// unknown, and how strong their evidence is. Counts only; never a total, an
// average or a grade.
function scorecardBrief(a, profile) {
  const scores = (a && a.diagnostic_scores) || {};
  const defs = profile && Array.isArray(profile.diagnostic_categories) ? profile.diagnostic_categories.filter((c) => c.applicable !== false) : Object.keys(scores).map((id) => ({ id, label: id }));
  const out = { total: defs.length, scored: 0, unknown: 0, confidence: { high: 0, medium: 0, low: 0, not_given: 0 }, unknown_labels: [] };
  for (const c of defs) {
    const s = scores[c.id];
    if (s && (s.status === 'scored' || s.status === 'range')) {
      out.scored += 1;
      out.confidence[s.confidence || 'not_given'] += 1;
    } else if (!s || s.status !== 'not_applicable') {
      out.unknown += 1;
      out.unknown_labels.push(c.label || c.id);
    }
  }
  return out;
}

module.exports = {
  PHASES,
  PHASE_LABELS,
  SOURCE_ACCESS,
  DEPLOYED_LINK,
  JUDGMENT_KEYS,
  judgmentKeysFor,
  JUDGMENT_LABELS,
  asksFor,
  normalizeCodeReview,
  normalizeChartCycle,
  normalizeJudgment,
  blockRefs,
  scorecardBrief,
};
