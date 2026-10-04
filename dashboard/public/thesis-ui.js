// Views for what a report says beyond its six weighted scores: the category
// grades with their confidence and the evidence behind them, the summary in
// reading order, the chart and cycle reading, the scenarios, the model's own
// judgment and the code it read (cr-research-prompt@5; older reports show the
// parts they have). Everything here is the report's own content, shown as
// written: nothing is a verdict of this app, nothing is averaged, and a
// missing value is said in words, never shown as zero.
import { h, scoreView, details, fmtDate, fmtPrice, fmtSignedPct, safeUrl, icon } from './ui.js';
import { CERTAINTY_LABELS } from './position-ui.js';

export const CONFIDENCE_LABELS = { high: 'High', medium: 'Medium', low: 'Low' };
const CONFIDENCE_TITLES = {
  high: 'High confidence: the model says this grade rests on primary sources it opened and dated.',
  medium: 'Medium confidence: the model says this grade rests on a mix of primary evidence and secondary sources or project claims.',
  low: 'Low confidence: the model says this grade rests mostly on project claims, inference or thin data.',
};
export const PHASE_LABELS = {
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
const JUDGMENT_QUESTIONS = [
  ['market_misunderstanding', 'What the market is likely misunderstanding'],
  ['overlooked_bull_case', 'Strongest overlooked bull case'],
  ['overlooked_bear_case', 'Strongest overlooked bear case'],
  ['technology_without_token', 'Could the technology succeed while the token performs poorly?'],
  ['within_holding_period', 'What could happen within the holding period'],
  ['advantage_over_btc', 'Advantage over holding BTC for the same period'],
];
const SOURCE_ACCESS = { public: 'Public source', partial: 'Partly public source', none: 'No public source', unknown: 'Source access not stated' };
const DEPLOYED_LINK = { verified: 'Connected to what is deployed', partial: 'Partly connected to what is deployed', not_verified: 'Not connected to what is deployed', not_applicable: 'Nothing deployed to connect to', unknown: 'Connection to what is deployed not stated' };
const CASES = [['bear', 'Bear'], ['base', 'Base'], ['bull', 'Bull']];

// ---- reading a report's categories (no DOM) ---------------------------------

// The scoring profile a report was graded under: the one it declares. Only a
// report that declares none (a prose report) falls back to the project's.
export function profileOf(profiles, assessment, fallback = null) {
  const ref = assessment && assessment.sector_profile;
  if (!ref) return fallback || null;
  return (profiles || []).find((p) => p.profile_ref === ref) || null;
}

// One row per category of that profile, then anything else the report scored.
export function categoryRows(profile, assessment) {
  const scores = (assessment && assessment.diagnostic_scores) || {};
  const defs = new Map(((profile && profile.diagnostic_categories) || []).map((c) => [c.id, c]));
  return [...new Set([...defs.keys(), ...Object.keys(scores)])].map((id) => {
    const def = defs.get(id) || null;
    return { id, def, label: def ? def.label : id, score: scores[id] || null };
  });
}

const isScored = (s) => Boolean(s) && (s.status === 'scored' || s.status === 'range');

// How many category grades are scored or unknown, and how strong the model
// says their evidence is. Counts only: never a total or an average.
export function scorecardCounts(rows) {
  const out = { total: 0, scored: 0, unknown: 0, high: 0, medium: 0, low: 0, unstated: 0, unknownLabels: [] };
  for (const r of rows) {
    if ((r.def && r.def.applicable === false) || (r.score && r.score.status === 'not_applicable')) continue;
    out.total += 1;
    if (isScored(r.score)) {
      out.scored += 1;
      out[CONFIDENCE_LABELS[r.score.confidence] ? r.score.confidence : 'unstated'] += 1;
    } else {
      out.unknown += 1;
      out.unknownLabels.push(r.label);
    }
  }
  return out;
}

// "Evidence confidence: 3 high · 6 medium · 2 low", or null when the report
// states no confidence at all (reports before cr-research-prompt@5).
export function confidenceLine(c) {
  if (!c || !(c.high || c.medium || c.low)) return null;
  const parts = [c.high ? `${c.high} high` : null, c.medium ? `${c.medium} medium` : null, c.low ? `${c.low} low` : null, c.unstated ? `${c.unstated} not stated` : null].filter(Boolean);
  return `Evidence confidence, as the model states it: ${parts.join(' · ')}.`;
}

export const hasDetail = (s) => Boolean(s) && Boolean(s.strongest_evidence || s.main_weakness || s.would_raise || s.would_lower);

// Whether a report states a confidence for any grade at all. Reports written
// before cr-research-prompt@5 state none, so no confidence column is shown.
export const statesConfidence = (rows) => rows.some((r) => isScored(r.score) && Boolean(CONFIDENCE_LABELS[r.score.confidence]));

const num = (v) => typeof v === 'number' && Number.isFinite(v);

// A low/high pair as text, or null when neither end is given.
export function rangeText(r, fmt) {
  if (!r || typeof r !== 'object') return null;
  const lo = num(r.low) ? fmt(r.low) : null;
  const hi = num(r.high) ? fmt(r.high) : null;
  if (lo && hi) return lo === hi ? lo : `${lo} to ${hi}`;
  if (lo) return `from ${lo}`;
  if (hi) return `up to ${hi}`;
  return null;
}

// The scenarios in bear, base, bull order, each split into what is observed,
// what is assumed and what is forecast. A probability or a range that was not
// given is null here and said in words by the view.
export function scenarioRows(scenarios) {
  const items = scenarios && Array.isArray(scenarios.items) ? scenarios.items.filter((s) => s && typeof s === 'object') : [];
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const known = CASES.map(([id, label]) => ({ id, label, item: items.find((s) => String(s.case || '').toLowerCase() === id) })).filter((x) => x.item);
  const other = items.filter((s) => !CASES.some(([id]) => String(s.case || '').toLowerCase() === id)).map((s) => ({ id: String(s.case || 'case'), label: String(s.case || 'Case'), item: s }));
  return [...known, ...other].map(({ id, label, item }) => ({
    id,
    label,
    probability: num(item.probability_pct) ? item.probability_pct : null,
    observations: (Array.isArray(item.observations) ? item.observations : []).map(text).filter(Boolean),
    assumptions: [['Token value capture', text(item.token_capture_assumption)], ['Supply', text(item.supply_assumption)], ['Bitcoin and the market', text(item.btc_assumption)]].filter(([, v]) => v),
    outcome: text(item.business_outcome),
    price: rangeText(item.price_range_usd, fmtPrice),
    vsBtc: rangeText(item.relative_return_vs_btc_pct, (n) => fmtSignedPct(n)),
    invalidation: text(item.invalidation),
  }));
}

// ---- small pieces -----------------------------------------------------------

// The model's stated confidence in one grade. The word carries the meaning;
// the three marks only repeat it.
export function confidenceChip(s) {
  if (!isScored(s)) return null;
  const c = s.confidence;
  if (!CONFIDENCE_LABELS[c]) return h('span', { class: 'faint small', title: 'The report states no confidence for this grade' }, 'not stated');
  const filled = c === 'high' ? 3 : c === 'medium' ? 2 : 1;
  return h('span', { class: `conf conf-${c}`, title: CONFIDENCE_TITLES[c] },
    h('span', { class: 'conf-marks', 'aria-hidden': 'true' }, [1, 2, 3].map((n) => h('span', { class: n <= filled ? 'on' : null }))),
    CONFIDENCE_LABELS[c]);
}

const refsText = (refs) => (Array.isArray(refs) && refs.length ? refs.join(', ') : null);

function block(title, ...children) {
  return h('div', { class: 'glance-block' }, h('h3', null, title), ...children);
}

function plainList(items, { cls = 'list small' } = {}) {
  return h('ul', { class: cls }, items.map((x) => h('li', null, x)));
}

function factList(list, max = 5) {
  const items = (Array.isArray(list) ? list : []).filter((f) => f && f.text).slice(0, max);
  return items.length ? plainList(items.map((f) => f.text)) : h('p', { class: 'small faint', style: { margin: 0 } }, 'None given.');
}

function windowText(w) {
  const a = w.window_start || null;
  const b = w.window_end || null;
  if (a && b && a !== b) return `${fmtDate(a)} – ${fmtDate(b)}`;
  if (a || b) return fmtDate(a || b);
  return 'date unknown';
}

// ---- scorecard: the category grades of one report ---------------------------

// The desk's evidence flags that concern one category grade (a scored code
// quality with no code read, a chart grade on undated or stale data). They
// flag; the grade is still shown as the model gave it.
export function categoryFlags(flags, id) {
  return (Array.isArray(flags) ? flags : []).filter((f) => Array.isArray(f.categories) && f.categories.includes(id));
}

const flagWord = (f) => (f.severity === 'high' ? 'Serious evidence flag' : 'Evidence flag');

function categoryFlagLine(f) {
  const serious = f.severity === 'high';
  return h('p', { class: `ev-line ${serious ? 'serious' : 'material'}` }, icon(serious ? 'warn-fill' : 'warn-line'),
    h('span', null, h('strong', null, `${flagWord(f)}. `), f.beside || f.message, ' ', h('span', { class: 'muted' }, 'The grade is shown as the model gave it.')));
}

// A compact mark for a list of grades: the sign and the word, the reason in
// its label.
function categoryFlagMark(list) {
  if (!list.length) return null;
  const serious = list.some((f) => f.severity === 'high');
  const text = list.map((f) => f.beside || f.message).join(' ');
  return h('span', { class: 'cat-flag-mark', role: 'img', title: text, 'aria-label': `${serious ? 'Serious evidence flag' : 'Evidence flag'}: ${text}` }, icon(serious ? 'warn-fill' : 'warn-line'), h('span', { 'aria-hidden': 'true' }, serious ? 'serious flag' : 'flag'));
}

// One entry per category: its name, score and confidence on one line, the
// short explanation under it, any evidence flag on it, and the strongest
// evidence, the main weakness and what would raise or lower the grade one tap
// away. A list, not a table, so it reads without sideways scrolling on a phone.
export function categoryTable(rows, { corrected = () => null, flags = [] } = {}) {
  const more = (x) => {
    const s = x.score;
    if (!hasDetail(s) && !refsText(s && s.evidence_refs)) return null;
    const item = (k, v) => (v ? [h('dt', null, k), h('dd', null, v)] : []);
    return h('details', { class: 'cat-more', dataset: { key: `cat-${x.id}` } },
      h('summary', null, 'Evidence and what would change it'),
      h('dl', { class: 'cat-detail' },
        ...item('Strongest evidence', s.strongest_evidence),
        ...item('Main weakness', s.main_weakness),
        ...item('Would raise it', s.would_raise),
        ...item('Would lower it', s.would_lower),
        ...item('Cites', refsText(s.evidence_refs))));
  };
  const why = (s) => {
    if (!s) return 'Not in this report.';
    if (s.status === 'unknown') return s.missing_data ? `Unknown: ${s.missing_data}` : 'Unknown; the report does not say what is missing.';
    return s.rationale || s.missing_data || '';
  };
  if (!rows.length) return h('div', { class: 'empty' }, 'This report grades no categories.');
  const conf = statesConfidence(rows);
  return h('ul', { class: `cat-list${conf ? '' : ' no-conf'}`, 'aria-label': 'Category grades of this report' }, rows.map((x) => {
    const na = x.def && x.def.applicable === false;
    const flagged = na ? [] : categoryFlags(flags, x.id);
    return h('li', null,
      h('div', { class: 'cat-head' },
        h('span', { class: 'cat-name', title: x.def ? x.def.definition : '' }, x.label),
        na ? h('span', { class: 'faint small', title: x.def.na_reason || '' }, 'Not applicable to this profile') : scoreView(x.score, 'fav', { corrected: corrected(x.id) }),
        conf ? h('span', { class: 'cat-conf' }, na ? null : confidenceChip(x.score)) : null),
      na ? null : h('div', { class: 'cat-why small' }, why(x.score)),
      ...flagged.map(categoryFlagLine),
      na ? null : more(x));
  }));
}

// ---- report summary blocks, in reading order --------------------------------

// The category grades at a glance: every grade with its confidence and any
// evidence flag on it, and the counts. Never a total.
export function categoryGlance(rows, href, { flags = [] } = {}) {
  if (!rows.length) return null;
  const c = scorecardCounts(rows);
  const line = confidenceLine(c);
  const conf = statesConfidence(rows);
  const shown = rows.filter((r) => !(r.def && r.def.applicable === false));
  const flagged = shown.filter((r) => categoryFlags(flags, r.id).length);
  return block(`Category grades: ${c.scored} of ${c.total} scored`,
    h('ul', { class: `cat-grid${conf ? '' : ' no-conf'}` }, shown.map((r) => h('li', null,
      h('span', { class: 'cat-name', title: r.def ? r.def.definition : '' }, r.label, categoryFlagMark(categoryFlags(flags, r.id))),
      scoreView(r.score, 'fav'),
      conf ? h('span', { class: 'cat-conf' }, confidenceChip(r.score)) : null))),
    flagged.length ? h('p', { class: 'small', style: { margin: '8px 0 0' } }, `Evidence flags on ${flagged.map((r) => r.label).join(', ')}: the grade is shown as the model gave it; the scorecard says why it is flagged.`) : null,
    line ? h('p', { class: 'small muted', style: { margin: '8px 0 0' } }, line) : null,
    c.unknown ? h('p', { class: 'small muted', style: { margin: '4px 0 0' } }, `Unknown, with no number: ${c.unknownLabels.join(', ')}.`) : null,
    href ? h('p', { class: 'small', style: { margin: '6px 0 0' } }, h('a', { href, dataset: { key: 'glance-scorecard' } }, rows.some((r) => hasDetail(r.score)) ? 'Open the scorecard: the evidence, the main weakness and what would change each grade' : 'Open the scorecard: the reason behind each grade')) : null);
}

export function positivesAndRisks(a) {
  const pos = a.bullish_facts || [];
  const neg = a.bearish_facts || [];
  if (!pos.length && !neg.length) return null;
  return h('div', { class: 'glance-block glance-grid' },
    h('div', null, h('h3', null, 'Strongest positives'), factList(pos)),
    h('div', null, h('h3', null, 'Strongest risks'), factList(neg)));
}

// The chart and cycle reading in brief; `full` adds levels, volume, liquidity
// and the conditions that would confirm or invalidate an advance.
export function chartCycleBlock(a, { full = false } = {}) {
  const cc = a.chart_cycle;
  if (!cc) return null;
  const d = cc.data || {};
  const dataLine = [d.source, d.venue, d.pair, (d.timeframes || []).length ? d.timeframes.join(', ') : null, d.latest_observation_at ? `latest observation ${d.latest_observation_at}` : null].filter(Boolean).join(' · ');
  const vol = cc.volume || {};
  const rows = [];
  const add = (k, v) => { if (v) rows.push(h('dt', null, k), h('dd', null, v)); };
  add('Trend against USD', cc.trend_vs_usd);
  add('Trend against BTC', cc.trend_vs_btc);
  if (full) {
    if ((cc.levels || []).length) add('Levels', plainList(cc.levels.map((l) => `${l.kind === 'support' ? 'Support' : l.kind === 'resistance' ? 'Resistance' : 'Level'}${l.price_usd !== null && l.price_usd !== undefined ? ` ${fmtPrice(l.price_usd)}` : ''}${l.timeframe ? ` (${l.timeframe})` : ''}${l.basis ? `: ${l.basis}` : ''}`), { cls: 'plain small' }));
    if (vol.baseline || vol.reading) add('Volume', h('span', null, vol.reading || 'No reading given.', vol.baseline ? h('span', { class: 'block faint small' }, `Compared against: ${vol.baseline}`) : h('span', { class: 'block faint small' }, 'No baseline stated.'), vol.confirms_price === true ? h('span', { class: 'block small' }, 'The model reads volume as supporting the price move.') : vol.confirms_price === false ? h('span', { class: 'block small' }, 'The model reads volume as contradicting the price move.') : null));
    add('Liquidity', cc.liquidity);
    if ((cc.confirmation || []).length) add('Would confirm an advance', plainList(cc.confirmation, { cls: 'plain small' }));
    if ((cc.invalidation || []).length) add('Would invalidate it', plainList(cc.invalidation, { cls: 'plain small' }));
    add('Cites', refsText(cc.evidence_refs));
  }
  return block('Chart and cycle (the model\'s reading)',
    h('p', { style: { margin: '0 0 4px' } }, h('span', { class: 'tl-chip' }, PHASE_LABELS[cc.phase] || 'Unknown'), cc.phase_raw ? h('span', { class: 'faint small' }, ` written as "${cc.phase_raw}"`) : null, cc.phase_rationale ? h('span', { class: 'small' }, ` ${cc.phase_rationale}`) : cc.phase === 'unknown' ? h('span', { class: 'small muted' }, ' The report does not single out a phase.') : null),
    cc.alternative_reading ? h('p', { class: 'small', style: { margin: '0 0 4px' } }, h('strong', null, 'Competing reading: '), cc.alternative_reading) : null,
    rows.length ? h('dl', { class: 'kv small', style: { margin: '6px 0' } }, rows) : null,
    h('p', { class: 'small faint', style: { margin: '4px 0 0' } }, dataLine ? `Data: ${dataLine}.` : 'No data source is named for this reading.', d.limitations ? ` Limits: ${d.limitations}` : ''));
}

// Dated catalysts, what would confirm the opportunity and what would
// invalidate it.
export function catalystsBlock(a) {
  const pc = a.position_context;
  const windows = pc && Array.isArray(pc.catalyst_windows) && pc.catalyst_windows.length
    ? pc.catalyst_windows
    : (a.catalysts || []).filter((c) => c && c.title).map((c) => ({ title: c.title, window_start: c.window_start || c.date || null, window_end: c.window_end || null, certainty: c.certainty || 'unknown', in_horizon: typeof c.in_horizon === 'boolean' ? c.in_horizon : null }));
  const confirm = a.conviction_increases || [];
  const invalid = a.invalidators || [];
  if (!windows.length && !confirm.length && !invalid.length) return null;
  return h('div', { class: 'glance-block' },
    h('h3', null, 'Catalysts, confirmation and invalidation'),
    windows.length
      ? plainList(windows.slice(0, 8).map((w) => h('span', null, h('strong', null, w.title), ` · ${windowText(w)} · ${CERTAINTY_LABELS[w.certainty] || 'certainty unknown'}`, w.in_horizon === true ? ' · inside the horizon' : w.in_horizon === false ? ' · outside the horizon' : '')))
      : h('p', { class: 'small faint', style: { margin: '0 0 6px' } }, 'No dated catalysts given.'),
    h('div', { class: 'glance-grid', style: { marginTop: '10px' } },
      h('div', null, h('h3', null, 'Would confirm it'), factList(confirm)),
      h('div', null, h('h3', null, 'Would invalidate it'), factList(invalid))));
}

// The model's final judgment, then its own views, each labeled judgment or
// speculation with the test that would disprove it.
export function judgmentBlock(a, { open = false, id = 'judgment', withLongTerm = true } = {}) {
  const ij = a.independent_judgment;
  const metric = a.next_metric_to_monitor;
  // Where the position card is shown beside it, the longer-term view is there.
  const longTerm = withLongTerm ? a.position_context && a.position_context.long_term_note : null;
  if (!a.final_take && !ij && !(metric && metric.metric) && !longTerm) return null;
  const views = ij ? JUDGMENT_QUESTIONS.map(([key, q]) => ({ q, v: ij[key] })).filter((x) => x.v && x.v.view) : [];
  return block('Independent final judgment (the model\'s own)',
    a.final_take ? h('p', { style: { margin: '0 0 6px' } }, a.final_take) : h('p', { class: 'small faint', style: { margin: '0 0 6px' } }, 'No final judgment given.'),
    metric && metric.metric ? h('p', { class: 'small', style: { margin: '0 0 6px' } }, h('strong', null, 'The one development to watch: '), metric.metric, metric.threshold ? ` (${metric.threshold})` : '', metric.why ? h('span', { class: 'muted' }, ` ${metric.why}`) : null) : null,
    views.length ? details(`The model's own views (${views.length})`, h('div', null,
      h('p', { class: 'small muted', style: { margin: '0 0 8px' } }, 'Judgment and speculation, labeled by the model. Neither is a verified fact.'),
      h('dl', { class: 'views' }, views.flatMap(({ q, v }) => [
        h('dt', null, q, ' ', h('span', { class: 'tl-chip' }, v.label === 'judgment' ? 'Judgment' : v.label === 'speculation' ? 'Speculation' : 'Not labeled')),
        h('dd', null, v.view,
          v.disconfirming_test ? h('span', { class: 'block small muted' }, `Would be wrong if: ${v.disconfirming_test}`) : null,
          refsText(v.supporting_evidence) ? h('span', { class: 'block small faint' }, `Cites: ${refsText(v.supporting_evidence)}`) : null),
      ]))), { id, open }) : null,
    longTerm ? h('p', { class: 'small', style: { margin: '8px 0 0' } }, h('strong', null, 'Longer-term technology potential '), h('span', { class: 'faint' }, '(kept apart from this holding-period assessment): '), longTerm) : null);
}

// The model's suggested review date and what should prompt a review sooner.
export function reviewBlock(a) {
  const t = a.position_context && a.position_context.timing;
  if (!t || (!t.next_review_date && !t.review_trigger)) return null;
  return block('Next review (the model\'s suggestion)',
    h('p', { class: 'small', style: { margin: 0 } }, t.next_review_date ? h('strong', null, fmtDate(t.next_review_date)) : h('span', { class: 'faint' }, 'No date given'), t.review_trigger ? ` · sooner if: ${t.review_trigger}` : ''));
}

// Bear, base and bull: what is observed, what is assumed, what is forecast.
// Probabilities and price ranges are the model's subjective estimates.
export function scenariosBlock(a) {
  const sc = a.scenarios;
  const rows = scenarioRows(sc);
  if (!rows.length) return null;
  const pc = sc.probability_check || {};
  const notes = [
    pc.status === 'ok' ? null : pc.message || null,
    sc.target_check && sc.target_check.status !== 'given' && sc.target_check.status !== 'none' ? sc.target_check.message : null,
    sc.btc_relative_definition ? `Return relative to BTC as the report defines it: ${sc.btc_relative_definition}` : 'The report does not define its return relative to BTC.',
  ].filter(Boolean);
  const lines = (items) => (items.length ? plainList(items, { cls: 'plain' }) : h('span', { class: 'faint' }, 'none given'));
  // Reports written before cr-research-prompt@5 were not asked which
  // observations a case builds on; the row is shown once any case gives one.
  const observed = rows.some((x) => x.observations.length);
  // One block per case, so it reads without sideways scrolling on a phone.
  return h('div', null,
    h('p', { class: 'small muted', style: { margin: '0 0 8px' } }, 'Probabilities and price ranges are the model\'s subjective estimates, not verified facts. A value the model could not defend is left unknown; nothing is filled in.'),
    h('div', { class: 'scn-list' }, rows.map((x) => h('section', { class: 'scn', 'aria-label': `${x.label} case` },
      h('h4', null, `${x.label} case`, h('span', { class: 'scn-prob' }, x.probability === null ? 'probability not given' : `${x.probability}% (the model's estimate)`)),
      h('dl', { class: 'cat-detail small' },
        observed ? [h('dt', null, 'Observed today'), h('dd', null, lines(x.observations))] : null,
        h('dt', null, 'Assumed'), h('dd', null, lines(x.assumptions.map(([k, v]) => `${k}: ${v}`))),
        h('dt', null, 'Forecast'), h('dd', null,
          x.outcome ? h('div', null, x.outcome) : null,
          h('div', null, 'Price: ', x.price || h('span', { class: 'faint' }, 'no range given')),
          h('div', null, 'Against BTC: ', x.vsBtc || h('span', { class: 'faint' }, 'no range given'))),
        x.invalidation ? [h('dt', null, 'Would invalidate it'), h('dd', null, x.invalidation)] : null)))),
    notes.length ? h('ul', { class: 'list small muted', style: { marginTop: '8px' } }, notes.map((n) => h('li', null, n))) : null);
}

// Which code the model says it read, at which commit, and whether it could
// connect that code to what is deployed.
export function codeReviewBlock(a) {
  const cr = a.code_review;
  if (!cr) return null;
  const repos = cr.repositories || [];
  const link = cr.deployed_link || {};
  return h('div', null,
    h('p', { class: 'small muted', style: { margin: '0 0 8px' } }, 'The model\'s own account of what it read. A research assessment, not a security audit, and not checked by this dashboard.'),
    h('dl', { class: 'kv' },
      h('dt', null, 'Source'), h('dd', null, SOURCE_ACCESS[cr.source_access] || SOURCE_ACCESS.unknown),
      h('dt', null, 'Deployed product'), h('dd', null, DEPLOYED_LINK[link.status] || DEPLOYED_LINK.unknown, link.note ? h('span', { class: 'block small muted' }, link.note) : null),
      cr.limitations ? [h('dt', null, 'Not inspected'), h('dd', null, cr.limitations)] : null),
    repos.length
      ? h('ul', { class: 'list small', style: { marginTop: '10px' } }, repos.map((r) => {
        const url = safeUrl(r.url);
        return h('li', null,
          url ? h('a', { href: url }, url.replace(/^https?:\/\//, '')) : h('span', null, r.url_raw || 'Repository without a usable link'),
          r.role ? ` · ${r.role}` : '',
          h('span', { class: 'block' }, r.commit ? h('span', null, 'Read at ', h('code', null, r.commit)) : h('span', { class: 'faint' }, 'No code read here (no commit given)'), (r.files_inspected || []).length ? ` · ${r.files_inspected.length} file${r.files_inspected.length === 1 ? '' : 's'}: ${r.files_inspected.slice(0, 6).join(', ')}${r.files_inspected.length > 6 ? ', …' : ''}` : ''),
          r.observations ? h('span', { class: 'block muted' }, r.observations) : null);
      }))
      : h('p', { class: 'small faint', style: { margin: '10px 0 0' } }, 'No repository listed.'));
}
