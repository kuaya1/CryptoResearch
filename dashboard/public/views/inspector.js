// The parts of the project inspector that need the full project record
// (GET /api/projects/<id>), built from the project page's own components:
//   run        the latest run's exact saved prompt, its version, rubric and
//              holding horizon
//   breakdown  each model's weighted components and downside risks side by
//              side, the category grades one tap away; never a combined score
//   evidence   per model: the desk's evidence checks, the sources it cited and
//              its original report
// Every model keeps its own numbers. Unknown stays unknown; not applicable
// says so; a difference is computed only between comparable reports.
import { h, details, fmtDate, fmtDateTime, PROVIDERS, PROVIDER_LABELS, PROVIDER_SHORT, evidenceLevel } from '../ui.js';
import { evidenceChecksBlock, latestReports, promptView, sourceItem } from './project.js';

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

function breakdownPart(ctx, d) {
  const c = d.comparison;
  const present = PROVIDERS.filter((p) => c.latest[p]);
  if (!present.length) return h('p', { class: 'small muted', style: { margin: 0 } }, 'No gradable reports yet.');
  const comparable = new Set(c.comparability.comparable_providers || []);
  const weights = Object.fromEntries(ctx.state.index.rubrics.grading.investment_components.map((x) => [x.id, x.weight_bp / 100]));
  const of = (section) => c.rows.filter((r) => r.section === section);
  const diag = of('diagnostic');
  return h('div', null,
    h('h4', null, 'Weighted components (higher is better)'),
    breakdownTable(of('component'), present, { weights, comparable }),
    h('h4', null, 'Downside risk (higher means more risk)'),
    breakdownTable(of('risk'), present, { comparable }),
    diag.length ? details(`Category grades (${diag.length}; never averaged into the grade)`, breakdownTable(diag, present, { comparable }), { id: `insp-diag-${d.project.project_id}` }) : null,
    h('p', { class: 'breakdown-note' },
      comparable.size >= 2
        ? `Gap: points between comparable models; ${c.threshold}+ is marked. ${present.some((p) => !comparable.has(p)) ? '* not compared (different rubric, profile, horizon or date). ' : ''}`
        : `Not directly comparable${(c.comparability.reasons || []).length ? `: ${c.comparability.reasons.join('; ')}` : ''}. Values side by side, no gap calculated. `,
      '? unknown · N/A not applicable · hover a score for its reason. Each model keeps its own grade.'));
}

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

function evidencePart(ctx, d) {
  const pid = d.project.project_id;
  const latest = latestReports(d);
  const present = PROVIDERS.filter((p) => latest[p]);
  if (!present.length) return h('p', { class: 'small muted', style: { margin: 0 } }, 'No reports yet.');
  return h('div', null, present.map((p) => {
    const r = latest[p];
    const a = r.assessment || {};
    const sources = a.sources || [];
    const level = evidenceLevel(r.evidence ? { flagged: r.evidence.flagged_claims, high: r.evidence.high, medium: r.evidence.medium } : null);
    return h('div', { class: 'ev-model', id: `insp-ev-${p}`, tabindex: '-1' },
      h('div', { class: 'head' },
        h('strong', null, PROVIDER_LABELS[p]),
        h('span', { class: 'faint' }, `${fmtDate(a.analysis_at)}${level === 'serious' ? ' · serious flag' : level === 'material' ? ' · material flag' : ''}`)),
      evidenceQuality(a.claims),
      evidenceChecksBlock(r.evidence),
      sources.length
        ? details(`${sources.length} source${sources.length === 1 ? '' : 's'} cited`, h('ol', { class: 'src-list' }, sources.map(sourceItem)), { id: `insp-src-${pid}-${p}` })
        : h('p', { class: 'small faint', style: { margin: '0 0 6px' } }, 'This report lists no sources.'),
      h('div', { class: 'btn-row' },
        h('a', { class: 'btn small', href: `#/project/${encodeURIComponent(pid)}/reports?report=${encodeURIComponent(r.report_id)}`, dataset: { key: `insp-report-${p}` } }, 'Original report'),
        h('a', { class: 'small', href: `#/project/${encodeURIComponent(pid)}/evidence`, dataset: { key: `insp-claims-${p}` } }, 'Claims and your checks')));
  }));
}

export function inspectorParts(ctx, d, row) {
  return { run: runPart(ctx, d), breakdown: breakdownPart(ctx, d), evidence: evidencePart(ctx, d, row) };
}
