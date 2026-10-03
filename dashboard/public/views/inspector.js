// The parts of the project inspector that need the full project record
// (GET /api/projects/<id>), built from the project page's own components:
//   cats-<model>      that model's category grades as bars on one 0–100 scale,
//                     each opening to why, the evidence, the main weakness and
//                     what would raise or lower it (the report's own words)
//   evidence-<model>  that model's evidence checks, claims by tag and sources
//   compare           the models side by side where their reports compare;
//                     never a combined score
//   run               the latest run's exact saved prompt, version, rubric,
//                     profile and holding horizon
// Every model keeps its own numbers. Unknown stays unknown and is never drawn
// as zero; not applicable says so; nothing missing is filled in.
import { h, details, fmtDateTime, PROVIDERS, PROVIDER_LABELS, PROVIDER_SHORT, icon } from '../ui.js';
import { evidenceChecksBlock, latestReports, promptView, sourceItem } from './project.js';
import { profileOf, categoryRows, scorecardCounts, statesConfidence, confidenceChip, categoryFlags, CONFIDENCE_LABELS } from '../thesis-ui.js';

const fact = (k, v, wide = false) => h('div', { class: wide ? 'wide' : null }, h('dt', null, k), h('dd', null, v));

function runPart(ctx, d) {
  const run = (d.research.runs || []).find((r) => r.prompt) || null;
  if (!run) return h('p', { class: 'small muted', style: { margin: '8px 0 0' } }, 'No research run yet. Each run saves the exact prompt, the same for every model.');
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
  if (isScored(s) && s.status === 'range') return h('span', { class: 'cbar' }, h('span', { class: 'range', style: { left: `${clamp(s.low)}%`, width: `${Math.max(2, clamp(s.high) - clamp(s.low))}%` } }));
  if (isScored(s)) return h('span', { class: 'cbar' }, h('span', { class: 'fill', style: { width: `${clamp(s.value)}%` } }));
  return h('span', { class: 'cbar unknown' });
}

const scoreWords = (s) => (s.status === 'range' ? `${s.low} to ${s.high} out of 100 (a range)` : `${s.value} out of 100`);

// One category: its name, score and bar in the row; the report's reasons one
// tap away. Older reports give only a reason, and that is all that is shown.
function categoryRow(prov, x, flags, conf) {
  const s = x.score;
  const na = (x.def && x.def.applicable === false) || (s && s.status === 'not_applicable');
  if (na) {
    return h('li', { class: 'crow-na' },
      h('span', { class: 'cr-name', title: x.def ? x.def.definition || '' : '' }, x.label),
      h('span', { class: 'cr-na', title: (x.def && x.def.na_reason) || (s && s.rationale) || '' }, 'Not applicable'));
  }
  const scored = isScored(s);
  const fl = categoryFlags(flags, x.id);
  const serious = fl.some((f) => f.severity === 'high');
  const value = !s ? 'Not in report' : scored ? (s.status === 'range' ? `${s.low}–${s.high}` : String(s.value)) : 'Unknown';
  const short = !s ? 'This report does not grade this category.'
    : scored ? s.rationale || ''
      : s.missing_data ? `Why unknown: ${s.missing_data}` : 'The report does not say what is missing.';
  const item = (k, v) => (v ? [h('dt', null, k), h('dd', null, v)] : []);
  const anyDetail = s && (s.strongest_evidence || s.main_weakness || s.would_raise || s.would_lower);
  const body = h('div', { class: 'cdetail' },
    fl.map((f) => h('p', { class: `ev-line ${f.severity === 'high' ? 'serious' : 'material'}` }, icon(f.severity === 'high' ? 'warn-fill' : 'warn-line'),
      h('span', null, h('strong', null, f.severity === 'high' ? 'Serious evidence flag. ' : 'Evidence flag. '), f.beside || f.message, ' ', h('span', { class: 'muted' }, 'The grade is shown as the model gave it.')))),
    h('dl', null,
      ...item(scored ? 'Why this grade' : 'Why unknown', scored ? s.rationale || h('span', { class: 'faint' }, 'No reason given.') : (s && s.missing_data) || h('span', { class: 'faint' }, 'Not stated.')),
      ...item('Strongest evidence', s && s.strongest_evidence),
      ...item('Confidence', scored && CONFIDENCE_LABELS[s.confidence] ? h('span', null, confidenceChip(s), h('span', { class: 'faint' }, ' as the model states it')) : null),
      ...item('Main weakness', s && s.main_weakness),
      ...item('Would raise it', s && s.would_raise),
      ...item('Would lower it', s && s.would_lower),
      ...item('Cites', s && Array.isArray(s.evidence_refs) && s.evidence_refs.length ? s.evidence_refs.join(', ') : null)),
    !anyDetail && s ? h('p', { class: 'faint small', style: { margin: '6px 0 0' } }, 'This report gives the reason only; reports on the newer prompt add the evidence, the main weakness and what would change the grade.') : null);
  return h('li', null, h('details', { class: `crow${scored ? '' : ' is-unknown'}${fl.length ? (serious ? ' has-serious' : ' has-flag') : ''}`, dataset: { key: `cat-${prov}-${x.id}` } },
    h('summary', null,
      h('span', { class: 'cr-top' },
        h('span', { class: 'cr-name', title: x.def ? x.def.definition || '' : '' }, x.label,
          fl.length ? h('span', { class: 'cr-flag', title: fl.map((f) => f.beside || f.message).join(' ') }, icon(serious ? 'warn-fill' : 'warn-line'), h('span', null, serious ? 'serious flag' : 'flag')) : null),
        h('span', { class: 'cr-score' }, h('span', { class: 'v' }, value), scored ? h('span', { class: 'of' }, '/100') : null)),
      h('span', { class: 'cr-bar', role: 'img', 'aria-label': scored ? scoreWords(s) : 'Unknown, no score' }, scoreBar(s)),
      h('span', { class: 'cr-sub' },
        conf && scored ? confidenceChip(s) : null,
        short ? h('span', { class: 'cr-why' }, short) : null)),
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
  const confLine = conf ? [counts.high ? `${counts.high} high` : null, counts.medium ? `${counts.medium} medium` : null, counts.low ? `${counts.low} low` : null].filter(Boolean).join(' · ') : null;
  return h('div', { class: 'cats' },
    h('div', { class: 'cats-head' },
      h('h3', null, 'Category grades'),
      h('span', { class: 'cats-count' }, `${counts.scored} of ${counts.total} scored${counts.unknown ? ` · ${counts.unknown} unknown` : ''}`)),
    confLine ? h('p', { class: 'cats-conf' }, `Confidence, as ${PROVIDER_LABELS[prov]} states it: ${confLine}`) : null,
    h('div', { class: 'cats-scale', 'aria-hidden': 'true' }, ['0', '25', '50', '75', '100'].map((n) => h('span', null, n))),
    h('ul', { class: 'cat-rows', 'aria-label': `${PROVIDER_LABELS[prov]}'s category grades, 0 to 100, higher is better` }, rows.map((x) => categoryRow(prov, x, flags, conf))),
    h('p', { class: 'cats-note' }, `${PROVIDER_LABELS[prov]}'s own diagnostic grades, higher is better. They are never averaged into the investment grade or with another model's. Scoring profile ${a.sector_profile || 'not declared'}${profile ? '' : ' (not on this desk)'}.`));
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
    h('h4', null, 'Weighted components (higher is better)'),
    breakdownTable(of('component'), present, { weights, comparable }),
    h('h4', null, 'Downside risk (higher means more risk)'),
    breakdownTable(of('risk'), present, { comparable }),
    diag.length ? details(`Category grades side by side (${diag.length})`, breakdownTable(diag, present, { comparable }), { id: `insp-diag-${d.project.project_id}` }) : null,
    h('p', { class: 'breakdown-note' },
      comparable.size >= 2
        ? `Gap: points between comparable models; ${c.threshold}+ is marked. ${present.some((p) => !comparable.has(p)) ? '* not compared (different rubric, profile, horizon or date). ' : ''}`
        : `Not directly comparable${(c.comparability.reasons || []).length ? `: ${c.comparability.reasons.join('; ')}` : ''}. Values side by side, no gap calculated. `,
      '? unknown · N/A not applicable · hover a score for its reason. Each model keeps its own grade.'));
}

// The parts for the inspector of one project, for the selected model.
export function inspectorParts(ctx, d, row, prov) {
  const out = { run: runPart(ctx, d), compare: comparePart(ctx, d) };
  if (prov) {
    out[`cats-${prov}`] = categoriesPart(ctx, d, row, prov);
    out[`evidence-${prov}`] = evidencePart(ctx, d, row, prov);
  }
  return out;
}
