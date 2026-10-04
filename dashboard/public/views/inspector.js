// The parts of the project inspector that need the full project record
// (GET /api/projects/<id>), built from the project page's own components:
//   cats-<model>      that model's category grades as bars on one 0–100 scale,
//                     each opening to why, the evidence, the main weakness and
//                     what would raise or lower it (the report's own words)
//   evidence-<model>  that model's evidence checks, claims by tag and sources
//   compare           the models side by side where their reports compare;
//                     never a combined score
//   thesis            your own conviction note, then the selected model's
//                     thesis in its report's words
//   contract          the token's contract on record and its screening state
//   run               the latest run's exact saved prompt, version, rubric,
//                     profile and holding horizon
//   chart             the technical chart below the category bars, closed
//                     until opened (views/chart.js); the same element on a
//                     redraw, so its frame is kept
// Every model keeps its own numbers. Unknown stays unknown and is never drawn
// as zero; not applicable says so; nothing missing is filled in.
import { h, details, fmtDateTime, PROVIDERS, PROVIDER_LABELS, PROVIDER_SHORT, icon, anchorText, scoreTier } from '../ui.js';
import { evidenceChecksBlock, latestReports, promptView, sourceItem } from './project.js';
import { profileOf, categoryRows, scorecardCounts, statesConfidence, confidenceChip, categoryFlags, CONFIDENCE_LABELS } from '../thesis-ui.js';
import { technicalChart } from './chart.js';

const fact = (k, v, wide = false) => h('div', { class: wide ? 'wide' : null }, h('dt', null, k), h('dd', null, v));

function runPart(ctx, d) {
  const run = (d.research.runs || []).find((r) => r.prompt) || null;
  if (!run) return h('p', { class: 'small muted', style: { margin: '8px 0 0' } }, 'No research run yet.');
  return h('div', { style: { marginTop: '10px' } },
    h('dl', { class: 'facts' },
      fact('Prompt version', h('span', { class: 'mono' }, run.prompt.version || 'not stated')),
      fact('Prompt SHA-256', h('span', { class: 'mono', title: run.prompt.sha256 }, `${String(run.prompt.sha256 || '').slice(0, 12)}…`)),
      fact('Holding horizon', run.horizon && run.horizon.text ? run.horizon.text : 'not stated', true),
      run.horizon && run.horizon.exception_reason ? fact('Long-term reason (yours)', run.horizon.exception_reason, true) : null,
      fact('Rubric · profile', h('span', { class: 'mono' }, `${run.rubric_version || '?'} · ${run.sector_profile || '?'}`), true),
      fact('Started', `${fmtDateTime(run.created_at)} via ${run.channel || '?'}`, true)),
    promptView(ctx, d.project.project_id, run));
}

// ---- category grades ----------------------------------------------------------

const isScored = (s) => Boolean(s) && (s.status === 'scored' || s.status === 'range');
const clamp = (v) => Math.max(0, Math.min(100, Number(v)));

// The bar on the one 0–100 scale: a fill for a score, a span for a range, an
// empty dashed track for unknown (it must never read as zero).
function scoreBar(s) {
  // Each fill on the one 0–100 spectrum (a range by its low end).
  if (isScored(s) && s.status === 'range') return h('span', { class: 'cbar' }, h('span', { class: `range tier-${scoreTier(s.low)}`, style: { left: `${clamp(s.low)}%`, width: `${Math.max(2, clamp(s.high) - clamp(s.low))}%` } }));
  if (isScored(s)) return h('span', { class: 'cbar' }, h('span', { class: `fill tier-${scoreTier(s.value)}`, style: { width: `${clamp(s.value)}%` } }));
  return h('span', { class: 'cbar unknown' });
}

const scoreWords = (s) => (s.status === 'range' ? `${s.low} to ${s.high} out of 100 (a range)` : `${s.value} out of 100`);

// Short names for a phone row; the full name is the row's title, its label
// for screen readers, and the first line of its detail.
const SHORT = {
  legitimacy: 'Legitimacy', development_credibility: 'Development', build_operational_quality: 'Build quality', code_quality: 'Code quality',
  product_reality: 'Live product', technology_usefulness: 'Technology', organic_demand: 'Organic demand', token_value_capture: 'Value capture',
  valuation_supply_attractiveness: 'Valuation & supply', chart_structure: 'Chart', cycle_timing: 'Cycle & catalysts', volume_liquidity: 'Volume & liquidity',
  btc_relative_opportunity: 'Against BTC', builder_operations: 'Builders & ops', product_usefulness: 'Product use', credit_risk_transparency: 'Credit-risk clarity',
  protocol_risk_transparency: 'Protocol-risk clarity', technical_risk_transparency: 'Tech-risk clarity', differentiation: 'Differentiation',
  category_potential: 'Category potential', chart_quality: 'Chart quality', evidence_confidence: 'Evidence confidence',
};

// One category: its name, score and bar in one row; an unknown says why right
// there; the report's reasons, evidence and anchor are one tap away. Older
// reports give only a reason, and that is all that is shown.
function categoryRow(prov, x, flags, conf, anchors = []) {
  const s = x.score;
  const name = SHORT[x.id] || x.label;
  const na = (x.def && x.def.applicable === false) || (s && s.status === 'not_applicable');
  if (na) {
    return h('li', { class: 'crow-na' },
      h('span', { class: 'cr-name', title: x.label }, name),
      h('span', { class: 'cr-na', title: (x.def && x.def.na_reason) || (s && s.rationale) || '' }, 'Not applicable'));
  }
  const scored = isScored(s);
  const fl = categoryFlags(flags, x.id);
  const serious = fl.some((f) => f.severity === 'high');
  const value = !s ? 'Not in report' : scored ? (s.status === 'range' ? `${s.low}–${s.high}` : String(s.value)) : 'Unknown';
  const word = scored ? anchorText(anchors, s) : null;
  // Only an unknown (or a missing grade) carries a line in the row: why.
  const short = !s ? 'Not graded in this report'
    : scored ? null
      : s.missing_data || null;
  const item = (k, v) => (v ? [h('dt', null, k), h('dd', null, v)] : []);
  const body = h('div', { class: 'cdetail' },
    h('p', { class: 'cd-name' }, x.label, word ? h('span', { class: 'faint' }, ` · ${word}`) : null),
    fl.map((f) => h('p', { class: `ev-line ${f.severity === 'high' ? 'serious' : 'material'}` }, icon(f.severity === 'high' ? 'warn-fill' : 'warn-line'),
      h('span', null, h('strong', null, f.severity === 'high' ? 'Serious evidence flag. ' : 'Evidence flag. '), f.beside || f.message))),
    h('dl', null,
      ...item(scored ? 'Why this grade' : 'Why unknown', scored ? s.rationale || h('span', { class: 'faint' }, 'No reason given.') : (s && s.missing_data) || h('span', { class: 'faint' }, 'Not stated.')),
      ...item('Strongest evidence', s && s.strongest_evidence),
      ...item('Confidence', scored && CONFIDENCE_LABELS[s.confidence] ? confidenceChip(s) : null),
      ...item('Main weakness', s && s.main_weakness),
      ...item('Would raise it', s && s.would_raise),
      ...item('Would lower it', s && s.would_lower),
      ...item('Cites', s && Array.isArray(s.evidence_refs) && s.evidence_refs.length ? s.evidence_refs.join(', ') : null)),
  );
  return h('li', null, h('details', { class: `crow${scored ? '' : ' is-unknown'}${fl.length ? (serious ? ' has-serious' : ' has-flag') : ''}`, dataset: { key: `cat-${prov}-${x.id}` } },
    h('summary', { 'aria-label': `${x.label}: ${scored ? `${scoreWords(s)}${word ? `, ${word}` : ''}${conf && CONFIDENCE_LABELS[s.confidence] ? `, confidence ${CONFIDENCE_LABELS[s.confidence].toLowerCase()}` : ''}` : value}${fl.length ? `; ${serious ? 'serious evidence flag' : 'evidence flag'}` : ''}. Open for the reasons` },
      h('span', { class: 'cr-name', title: x.label, 'aria-hidden': 'true' }, name,
        fl.length ? h('span', { class: `cr-flag ev-dot ${serious ? 'serious' : 'material'}`, title: fl.map((f) => f.beside || f.message).join(' ') }, h('span', { class: 'sr-only' }, serious ? 'serious flag' : 'flag')) : null),
      h('span', { class: 'cr-bar', 'aria-hidden': 'true' }, scoreBar(s)),
      h('span', { class: 'cr-score', 'aria-hidden': 'true' }, h('span', { class: 'v' }, scored ? value : '?'), conf && scored ? h('span', { class: 'cr-conf' }, confidenceChip(s)) : null),
      short ? h('span', { class: 'cr-why' }, short) : null),
    body));
}

// The model's category grades for its latest report, in the profile's order.
function categoriesPart(ctx, d, row, prov) {
  const sum = row.providers && row.providers[prov];
  if (!sum) return null;
  const r = d.reports.find((x) => x.report_id === sum.report_id) || latestReports(d)[prov];
  if (!r || r.broken) return h('p', { class: 'small muted' }, 'The report could not be read.');
  const a = r.assessment || {};
  if (a.needs_text || sum.needs_text) return h('p', { class: 'small muted' }, 'The saved report is a PDF: its category grades can be read once a text copy is imported.');
  const profile = profileOf(ctx.state.index.rubrics.profiles, a, d.profile);
  const rows = categoryRows(profile, a);
  if (!rows.length) return h('p', { class: 'small muted' }, 'This report grades no categories.');
  const counts = scorecardCounts(rows);
  const conf = statesConfidence(rows);
  const flags = (r.evidence && r.evidence.flags) || [];
  const anchors = ctx.state.index.rubrics.grading.favorable_anchors || [];
  return h('div', { class: 'cats' },
    h('div', { class: 'cats-head' },
      h('h3', null, 'Category grades'),
      h('span', { class: 'cats-count' }, `${counts.scored} of ${counts.total} scored${counts.unknown ? ` · ${counts.unknown} unknown` : ''}`)),
    h('ul', { class: 'cat-rows', 'aria-label': `${PROVIDER_LABELS[prov]}'s category grades, 0 to 100, higher is better` }, rows.map((x) => categoryRow(prov, x, flags, conf, anchors))),
  );
}

// ---- the six weighted parts of the investment grade ----------------------------

// What the investment grade is calculated from: the six weighted components
// of the report's own rubric, each as given (a point, a range, or unknown with
// the model's reason), its weight, and the rubric's word. Never a midpoint.
function componentsPart(ctx, d, row, prov) {
  const sum = row.providers && row.providers[prov];
  if (!sum) return null;
  const r = d.reports.find((x) => x.report_id === sum.report_id) || latestReports(d)[prov];
  if (!r || r.broken) return h('p', { class: 'small muted' }, 'The report could not be read.');
  const a = r.assessment || {};
  const grading = ctx.state.index.rubrics.grading;
  const anchors = grading.favorable_anchors || [];
  const comps = grading.investment_components;
  return h('div', { class: 'parts' },
    h('ul', { class: 'part-rows', 'aria-label': 'The six weighted parts of the investment grade' }, comps.map((c) => {
      const s = (a.investment_components || {})[c.id];
      const scored = isScored(s);
      const value = !s ? 'not given' : scored ? (s.status === 'range' ? `${s.low}–${s.high}` : String(s.value)) : s.status === 'not_applicable' ? 'N/A' : 'unknown';
      const word = scored ? anchorText(anchors, s) : null;
      const why = scored ? s.rationale : s ? s.missing_data || s.rationale : null;
      return h('li', null,
        h('div', { class: 'pr-top' },
          h('span', { class: 'pr-name' }, c.label, h('span', { class: 'w' }, `${c.weight_bp / 100}%`)),
          h('span', { class: 'pr-v' }, h('strong', null, value), word ? h('span', { class: 'faint' }, ` · ${word}`) : null)),
        h('span', { class: 'cr-bar', role: 'img', 'aria-label': scored ? scoreWords(s) : 'Unknown, no score' }, scoreBar(s)),
        why ? h('p', { class: 'pr-why' }, why) : null);
    })));
}

// ---- the model's strongest risks ---------------------------------------------

// Right after the category bars: the model's own three strongest risks, then
// its downside-risk scores (higher means more risk). Never folded away.
function risksPart(ctx, d, row, prov) {
  const sum = row.providers && row.providers[prov];
  if (!sum) return null;
  const r = d.reports.find((x) => x.report_id === sum.report_id) || latestReports(d)[prov];
  if (!r || r.broken) return null;
  const a = r.assessment || {};
  const facts = (a.bearish_facts || []).slice(0, 3);
  const defs = ctx.state.index.rubrics.grading.risk_scores || [];
  const top = (s) => (s.status === 'range' ? s.high : s.value);
  const scores = defs.map((def) => ({ def, s: (a.risk_scores || {})[def.id] })).filter((x) => isScored(x.s)).sort((x, y) => top(y.s) - top(x.s));
  if (!facts.length && !scores.length) return h('div', { class: 'risks' }, h('h3', null, 'Strongest risks'), h('p', { class: 'small faint' }, 'No risks listed.'));
  return h('section', { class: 'risks', 'aria-label': `${PROVIDER_LABELS[prov]}'s strongest risks` },
    h('h3', null, 'Strongest risks'),
    facts.length ? h('ol', { class: 'risk-list' }, facts.map((f) => h('li', null, f.text))) : null,
    scores.length ? h('p', { class: 'risk-scores' }, h('span', { class: 'k' }, 'Downside, higher is worse'),
      scores.map((x, i) => h('span', { class: 'rs' }, i ? ' · ' : '', `${x.def.label.replace(/ risk$/i, '')} `, h('strong', null, x.s.status === 'range' ? `${x.s.low}–${x.s.high}` : String(x.s.value))))) : null);
}

// ---- evidence and sources, per model ------------------------------------------

// How the report's claims are supported, by its own tags: verified in the
// model's session [V], project-claimed [C], inference [I], speculative [S].
// Counts and words; the bar's textures only repeat them.
const TAGS = [['V', 't-v', 'verified'], ['C', 't-c', 'claimed'], ['I', 't-i', 'inference'], ['S', 't-s', 'speculative']];
export function evidenceQuality(claims) {
  const list = Array.isArray(claims) ? claims : [];
  if (!list.length) return h('p', { class: 'small faint', style: { margin: '0 0 6px' } }, 'No structured claims in this report.');
  const n = Object.fromEntries(TAGS.map(([t]) => [t, list.filter((c) => c.evidence_tag === t).length]));
  const other = list.length - TAGS.reduce((sum, [t]) => sum + n[t], 0);
  return h('div', null,
    h('div', { class: 'evbar', 'aria-hidden': 'true' }, TAGS.filter(([t]) => n[t]).map(([t, cls]) => h('span', { class: cls, style: { width: `${(n[t] / list.length) * 100}%` } }))),
    h('p', { class: 'ev-legend' },
      TAGS.map(([t, cls, word]) => h('span', null, h('i', { class: cls, 'aria-hidden': 'true' }), h('strong', null, String(n[t])), ` ${word} [${t}]`)),
      other ? h('span', null, h('strong', null, String(other)), ' untagged') : null,
      h('span', { class: 'faint' }, `of ${list.length} claims`)));
}

function evidencePart(ctx, d, row, prov) {
  const pid = d.project.project_id;
  const sum = row.providers && row.providers[prov];
  if (!sum) return null;
  const r = d.reports.find((x) => x.report_id === sum.report_id) || latestReports(d)[prov];
  if (!r || r.broken) return null;
  const a = r.assessment || {};
  const sources = a.sources || [];
  return h('div', { class: 'ev-model', id: `insp-ev-${prov}`, tabindex: '-1' },
    evidenceQuality(a.claims),
    evidenceChecksBlock(r.evidence),
    sources.length
      ? details(`${sources.length} source${sources.length === 1 ? '' : 's'} cited`, h('ol', { class: 'src-list' }, sources.map(sourceItem)), { id: `insp-src-${pid}-${prov}` })
      : h('p', { class: 'small faint', style: { margin: '0 0 6px' } }, 'This report lists no sources.'),
    h('p', { class: 'small', style: { margin: '6px 0 0' } }, h('a', { href: `#/project/${encodeURIComponent(pid)}/evidence`, dataset: { key: `insp-claims-${prov}` } }, 'Claims and your checks')));
}

// ---- the models side by side ---------------------------------------------------

// A score in a few characters, its rationale in the title.
function scoreText(s) {
  if (!s) return h('span', { class: 'faint', title: 'Not in this report' }, '—');
  const title = s.rationale || s.missing_data || null;
  if (s.status === 'scored') return h('span', { title }, String(s.value));
  if (s.status === 'range') return h('span', { title }, `${s.low}–${s.high}`);
  if (s.status === 'not_applicable') return h('span', { class: 'faint', title: title || 'Not applicable' }, 'N/A');
  return h('span', { class: 'faint', title: title || 'Unknown' }, '?', h('span', { class: 'sr-only' }, ' unknown'));
}

function breakdownTable(rows, present, { weights = null, comparable }) {
  const showGap = comparable.size >= 2;
  return h('div', { class: 'table-wrap' }, h('table', { class: 'breakdown' },
    h('thead', null, h('tr', null,
      h('th', { scope: 'col' }, 'Item'),
      present.map((p) => h('th', { class: 'n', scope: 'col', title: comparable.has(p) ? null : 'Not compared: a different rubric, profile, horizon or date' }, PROVIDER_SHORT[p], comparable.has(p) || !showGap ? null : h('span', { class: 'faint' }, '*'))),
      showGap ? h('th', { class: 'n', scope: 'col', title: 'Points between the highest and lowest comparable score' }, 'Gap') : null)),
    h('tbody', null, rows.map((r) => h('tr', { class: r.spread_flag ? 'flag' : null },
      h('td', null, r.label, weights && weights[r.id] !== undefined ? h('span', { class: 'w' }, `${weights[r.id]}%`) : null),
      present.map((p) => h('td', { class: 'n' }, r.applicable === false ? h('span', { class: 'faint', title: r.na_reason || '' }, 'N/A') : scoreText(r.cells[p]))),
      showGap ? h('td', { class: 'n' }, r.spread === null || r.spread === undefined ? h('span', { class: 'faint' }, '—') : r.spread_flag ? h('strong', null, String(r.spread), h('span', { class: 'sr-only' }, ', at or above the highlight threshold')) : String(r.spread)) : null)))));
}

function comparePart(ctx, d) {
  const c = d.comparison;
  const present = PROVIDERS.filter((p) => c.latest[p]);
  if (present.length < 2) return null;
  const comparable = new Set(c.comparability.comparable_providers || []);
  const weights = Object.fromEntries(ctx.state.index.rubrics.grading.investment_components.map((x) => [x.id, x.weight_bp / 100]));
  const of = (section) => c.rows.filter((r) => r.section === section);
  const diag = of('diagnostic');
  return h('div', { style: { marginTop: '10px' } },
    h('h4', null, 'Weighted components'),
    breakdownTable(of('component'), present, { weights, comparable }),
    h('h4', null, 'Downside risk', h('span', { class: 'faint' }, ' · higher = worse')),
    breakdownTable(of('risk'), present, { comparable }),
    diag.length ? details(`Category grades side by side (${diag.length})`, breakdownTable(diag, present, { comparable }), { id: `insp-diag-${d.project.project_id}` }) : null,
    // Only a fact the table cannot show: these reports do not compare.
    comparable.size < 2 ? h('p', { class: 'breakdown-note' }, `Not directly comparable${(c.comparability.reasons || []).length ? `: ${c.comparability.reasons.join('; ')}` : ''}.`) : null);
}

// ---- thesis notes ---------------------------------------------------------------

// Your own conviction note first, in your words (written on the project's
// Notes page), then the selected model's thesis as its report states it: its
// final take, the one development to watch, and what would confirm or
// invalidate it. Each stays apart: nothing is summarized or merged.
function thesisPart(ctx, d, row, prov) {
  const pid = d.project.project_id;
  const note = d.conviction ? String(d.conviction.text || '').trim() : '';
  const mine = h('div', { class: 'th-block' },
    h('div', { class: 'th-head' }, h('span', { class: 'th-who' }, 'Your note'), note && d.conviction.updated_at ? h('span', { class: 'faint' }, `saved ${fmtDateTime(d.conviction.updated_at)}`) : null),
    note ? h('p', { class: 'th-text' }, note) : h('p', { class: 'th-none' }, 'No conviction note yet.'),
    h('a', { class: 'small', href: `#/project/${encodeURIComponent(pid)}/history`, dataset: { key: `note-edit-${pid}` } }, note ? 'Edit your note' : 'Write your note'));
  const sum = prov && row.providers && row.providers[prov];
  const r = sum ? d.reports.find((x) => x.report_id === sum.report_id) || latestReports(d)[prov] : null;
  const a = r && !r.broken ? r.assessment || {} : null;
  let model = null;
  if (a && !a.needs_text && !sum.needs_text) {
    const metric = a.next_metric_to_monitor;
    const list = (items) => (Array.isArray(items) ? items : []).filter((f) => f && f.text).slice(0, 2);
    const confirm = list(a.conviction_increases);
    const invalid = list(a.invalidators);
    const any = a.final_take || (metric && metric.metric) || confirm.length || invalid.length;
    model = h('div', { class: 'th-block' },
      h('div', { class: 'th-head' }, h('span', { class: 'th-who' }, `${PROVIDER_LABELS[prov]}'s thesis`)),
      !any ? h('p', { class: 'th-none' }, 'No thesis in the data block.') : null,
      a.final_take ? h('p', { class: 'th-text' }, a.final_take) : null,
      metric && metric.metric ? h('p', { class: 'th-line' }, h('span', { class: 'k' }, 'Watch'), h('span', null, metric.metric, metric.threshold ? ` (${metric.threshold})` : '')) : null,
      confirm.length ? h('div', { class: 'th-line' }, h('span', { class: 'k' }, 'Confirms'), h('ul', null, confirm.map((f) => h('li', null, f.text)))) : null,
      invalid.length ? h('div', { class: 'th-line' }, h('span', { class: 'k' }, 'Breaks'), h('ul', null, invalid.map((f) => h('li', null, f.text)))) : null);
  }
  return h('div', { class: 'thesis' }, mine, model);
}

// ---- the contract on record ------------------------------------------------------

// The token's contracts as the identity records them, and whether they have
// been screened. No contract-security source (such as GoPlus) runs on this
// desk, so nothing is ever called safe, flagged or verified here: the line
// says what is on record and that it is not screened. Pure, for the tests.
export function contractLine(identity) {
  const id = identity || {};
  const items = (Array.isArray(id.assets) ? id.assets : [])
    .filter((a) => a && typeof a.contract_address === 'string' && a.contract_address.trim())
    .map((a) => ({ chain: a.chain ? String(a.chain) : null, address: a.contract_address.trim() }));
  return { kind: items.length ? 'contracts' : 'none', items, verified: id.status === 'verified', screened: false };
}

const shortAddr = (a) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

function contractPart(d) {
  const c = contractLine(d.project && d.project.identity);
  const k = h('span', { class: 'cs-k' }, 'Contract');
  if (c.kind === 'none') {
    return h('div', { class: 'cstrip' }, k, h('span', { class: 'cs-v' }, c.verified ? 'None on record' : 'None on record · identity pending'));
  }
  const first = c.items[0];
  return h('div', { class: 'cstrip' }, k,
    h('span', { class: 'cs-v', title: c.items.map((x) => `${x.chain || 'chain?'}: ${x.address}`).join('\n') },
      first.chain ? h('span', { class: 'cs-chain' }, first.chain) : null,
      h('span', { class: 'mono' }, shortAddr(first.address)),
      c.items.length > 1 ? h('span', { class: 'faint' }, ` +${c.items.length - 1}`) : null),
    c.verified ? null : h('span', { class: 'cs-badge warn' }, 'Unconfirmed'),
    h('span', { class: 'cs-badge', title: 'No contract-security source (such as GoPlus) runs on this desk; mint, blacklist and proxy checks are not run' }, 'Not screened'));
}

// The parts for the inspector of one project, for the selected model.
export function inspectorParts(ctx, d, row, prov) {
  const out = { run: runPart(ctx, d), compare: comparePart(ctx, d), thesis: thesisPart(ctx, d, row, prov), contract: contractPart(d), chart: technicalChart(ctx, d.project) };
  if (prov) {
    out[`cats-${prov}`] = categoriesPart(ctx, d, row, prov);
    out[`grade-${prov}`] = componentsPart(ctx, d, row, prov);
    out[`risks-${prov}`] = risksPart(ctx, d, row, prov);
    out[`evidence-${prov}`] = evidencePart(ctx, d, row, prov);
  }
  return out;
}
