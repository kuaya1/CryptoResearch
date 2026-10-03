// Project page: addressable tabs (#/project/<id>/<tab>), each rendered only
// when opened and each in its own error boundary. Report text is cached so a
// live refresh redraws instantly and keeps your reading position.
import {
  h, card, table, gradeView, verdictChip, scoreView, tagChip, badgeInfo, bandClass, logo, sparkline, changeCell,
  fmtPrice, fmtCompactUsd, fmtNum, fmtDate, fmtDateTime, fmtAgo, fmtSignedPct, freshnessText, kv, details, field, input, select, button,
  action, callout, copyText, tabStrip, safeSection, submissionId, stateText, fieldError, PROVIDERS, PROVIDER_LABELS, link,
  jobKey, coworkIdleMinutes, isAssistantJob, researchState, withheldReason, unscoredFrom, unscoredList,
} from '../ui.js';
import { renderMarkdown } from '../md.js';
import { openResearchDialog, openSectorDialog, waitingActions, waitingStep } from './dialogs.js';
import { positionCard, previewTiming } from '../position-ui.js';

const TABS = [
  ['overview', 'Overview'],
  ['scorecards', 'Scorecards'],
  ['reports', 'Reports'],
  ['comparison', 'Comparison'],
  ['evidence', 'Evidence'],
  ['market', 'Market'],
  ['history', 'Notes & history'],
  ['research', 'Research runs'],
];

const viewState = { median: null, raw: {} };
const textCache = new Map();

async function cachedText(ctx, url) {
  if (textCache.has(url)) return textCache.get(url);
  const t = await ctx.api.text(url);
  textCache.set(url, t);
  return t;
}

export async function renderProject(ctx, route) {
  const id = route.args[0];
  if (!id) return callout('No project selected.', 'warn');
  const tab = TABS.some(([t]) => t === route.args[1]) ? route.args[1] : 'overview';
  let d;
  try {
    d = await ctx.projectDetail(id);
  } catch (err) {
    return h('div', null, h('div', { class: 'crumbs' }, h('a', { href: '#/watchlist' }, 'Watchlist')), callout(`Could not load project "${id}": ${err.message}`, 'bad'));
  }
  if (viewState.median === null) viewState.median = Boolean(ctx.state.index.settings.comparison.show_median);
  const row = ctx.state.index.projects.find((p) => p.project_id === id) || {};
  const latest = latestReports(d);
  const counts = { reports: d.reports.length, research: (d.research.runs || []).length };
  const strip = tabStrip(TABS.map(([t, label]) => ({ id: t, label, href: `#/project/${encodeURIComponent(id)}/${t}`, count: counts[t] || null })), tab, { label: 'Project sections' });
  const body = await safeSection(TABS.find(([t]) => t === tab)[1], () => ({
    overview: () => overviewTab(ctx, d, row, latest),
    scorecards: () => scorecardsTab(ctx, d, latest, route),
    reports: () => reportsTab(ctx, d, route),
    comparison: () => comparisonTab(ctx, d),
    evidence: () => evidenceTab(ctx, d, latest),
    market: () => marketTab(ctx, d),
    history: () => historyTab(ctx, d),
    research: () => researchTab(ctx, d, row),
  })[tab]());
  return h('div', null,
    h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, h('a', { href: `#/watchlist?p=${encodeURIComponent(id)}`, dataset: { key: 'crumb-watchlist' } }, 'Watchlist'), h('span', { 'aria-hidden': 'true' }, '/'), h('span', { 'aria-current': 'page' }, d.project.name)),
    header(ctx, d, row),
    strip,
    h('div', { id: 'tabpanel', role: 'tabpanel', 'aria-labelledby': `tab-${tab}` }, body));
}

function latestReports(d) {
  const out = {};
  for (const prov of PROVIDERS) {
    const meta = d.comparison.latest[prov];
    out[prov] = meta ? d.reports.find((r) => r.report_id === meta.report_id) || null : null;
  }
  return out;
}

function header(ctx, d, row) {
  const p = d.project;
  const id = p.identity;
  const sector = d.sector || p.sector;
  const research = button('Run research', () => openResearchDialog(ctx, { ...row, ...p, research: row.research, report_count: d.reports.length }), { kind: 'primary', key: 'project-research' });
  research.id = 'project-research-btn';
  const watch = button(p.watchlist.on_watchlist ? 'Watching' : 'Watch', null, { key: 'project-watch' });
  watch.setAttribute('aria-pressed', String(Boolean(p.watchlist.on_watchlist)));
  watch.title = p.watchlist.on_watchlist ? 'On your watchlist. Click to stop watching.' : 'Add to your watchlist';
  watch.onclick = action(watch, async () => { await ctx.api.post(`/api/projects/${p.project_id}/watchlist`, { on: !p.watchlist.on_watchlist }); await ctx.refresh(); return true; }, 'Watchlist updated');
  const archive = button(p.status === 'archived' ? 'Archived' : 'Archive', null, { kind: 'quiet', key: 'project-archive' });
  archive.disabled = p.status === 'archived';
  if (archive.disabled) archive.title = 'Already archived';
  archive.onclick = action(archive, async () => {
    if (!window.confirm(`Archive ${p.name}? Its files stay in the folder; it is hidden from active lists.`)) return undefined;
    await ctx.api.post(`/api/projects/${p.project_id}/archive`, { reason: 'Archived from the dashboard' });
    await ctx.refresh();
    return true;
  }, 'Archived');
  return h('div', { class: 'page-head' },
    h('div', null,
      h('div', { class: 'pill-row', style: { gap: '12px' } }, logo({ ...row, project_id: p.project_id, name: p.name, symbol: p.symbol }, { size: 36 }), h('h1', null, p.name, p.symbol ? h('span', { class: 'faint', style: { fontWeight: 500 } }, ` ${p.symbol}`) : null)),
      h('div', { class: 'meta-line', style: { marginTop: '8px' } },
        sector ? h('button', { type: 'button', class: 'link', dataset: { key: 'project-sector' }, 'aria-label': `Sector: ${sector.label || sector.primary}. Change sector`, onclick: () => openSectorDialog(ctx, { ...row, ...p, sector }) }, sector.label || sector.primary) : null,
        h('a', { href: `#/project/${encodeURIComponent(p.project_id)}/research`, title: (id.unknowns || []).join(' ') || 'Token identity, contracts and evidence', dataset: { key: 'project-identity' } }, id.status === 'verified' ? 'Identity verified' : `Identity ${id.status}`),
        // Watching or researching never suggests a holding; only an open position says Held.
        d.position && !d.position.closed ? h('span', null, 'Held') : null,
        id.official_website ? h('a', { href: id.official_website, class: 'wrap-anywhere' }, id.official_website.replace(/^https?:\/\//, '').replace(/\/$/, '')) : null)),
    h('div', { class: 'actions' }, research, watch, archive));
}

function fmtScore(s) {
  if (s === null || s === undefined) return '—';
  if (typeof s === 'string' || typeof s === 'number') return String(s);
  if (s.status === 'scored') return String(s.value);
  if (s.status === 'range') return `${s.low}–${s.high}`;
  return s.status === 'not_applicable' ? 'N/A' : 'unknown';
}

function originalOf(r, path) {
  const ov = (r && r.assessment && r.assessment.original_values) || {};
  return Object.prototype.hasOwnProperty.call(ov, path) ? fmtScore(ov[path]) : null;
}

// Why a grade is withheld, from the report itself: the parts not scored and
// the model's own notes on them. The share of the weight that was scored is
// shown; nothing is renormalized or filled in.
function withheldBlock(prov, g, a) {
  const why = withheldReason(prov, g, unscoredFrom(g, a.investment_components));
  return h('div', { class: 'why-withheld' }, h('p', { style: { margin: '6px 0 0' } }, why.sentence), unscoredList(why, { max: 400 }));
}

function routeText(rep) {
  const pv = rep.provenance || {};
  return `${rep.assessment ? rep.assessment.model_version || 'model not stated' : rep.model_version || 'model not stated'} · ${pv.attested ? 'attested by the API' : 'self-reported'}${pv.channel ? ` · via ${pv.channel}` : ''}`;
}

// ---------------------------------------------------------------------------
// Overview

function modelCard(ctx, d, row, prov, latest) {
  const pid = d.project.project_id;
  const staleDays = ctx.state.index.settings.freshness.research_stale_days || 90;
  const hosted = Boolean(ctx.state.session && ctx.state.session.hosted);
  const r = latest[prov];
  const sum = row.providers && row.providers[prov];
  const job = row.research && row.research.providers && row.research.providers[prov];
  const info = badgeInfo(prov, sum, job, { staleDays, hosted });
  // A newer run's waiting job: the sentence for its assistant (online desk) or the pasted prompt.
  const waiting = job && job.state === 'unconfigured' ? waitingActions(ctx, { pid, runId: job.run_id, provider: prov, key: `ov-${prov}` }) : null;
  const newer = sum && info.newerText ? h('p', { class: `newer-line${info.problem ? ' problem' : ''}` }, info.newerText) : null;
  let main;
  if (r) {
    const g = sum ? sum.grade : r.grade;
    const graded = g && (g.status === 'firm' || g.status === 'range');
    const why = g && g.status === 'withheld' ? withheldReason(prov, g, sum && sum.unscored ? sum.unscored : unscoredFrom(r.grade, r.assessment.investment_components)) : null;
    main = h('div', null,
      graded ? h('div', { class: `provider-grade${bandClass(g)}` }, h('span', { class: 'big' }, g.display), g.label ? h('span', { class: 'lab' }, g.label) : null, h('span', { class: 'small muted' }, g.status === 'range' ? 'range, 0–100' : 'grade, 0–100'))
        : h('div', { class: 'provider-grade' }, h('span', { class: 'state-text' }, 'Grade withheld'), g && g.coverage_pct !== null && g.coverage_pct !== undefined ? h('span', { class: 'small muted' }, `${g.coverage_pct}% of the weight scored`) : null),
      why ? h('p', { class: 'why-withheld' }, `${why.why.charAt(0).toUpperCase()}${why.why.slice(1)}.`) : null,
      h('dl', { class: 'facts' },
        h('div', { class: 'wide' }, h('dt', null, 'Verdict'), h('dd', null, verdictChip(r.assessment.verdict))),
        h('div', null, h('dt', null, 'Analysis'), h('dd', null, fmtDate(r.assessment.analysis_at), info.age ? h('span', { class: 'faint' }, ` · ${info.age}`) : null, info.stale ? h('span', { class: 'freshness stale' }, ' · stale') : null)),
        h('div', null, h('dt', null, 'Horizon'), h('dd', null, r.assessment.horizon || 'not stated')),
        previewTiming(sum) ? h('div', { class: 'wide' }, h('dt', null, 'Timing (the model\'s view)'), h('dd', null, previewTiming(sum))) : null),
      r.assessment.summary ? h('p', { class: 'small', style: { margin: '10px 0 0' } }, r.assessment.summary) : null,
      r.evidence && r.evidence.flags.length
        ? h('p', { class: 'small', style: { margin: '8px 0 0' } }, stateText(`Evidence checks: ${r.evidence.flagged_claims} claim${r.evidence.flagged_claims === 1 ? '' : 's'} flagged`, r.evidence.high ? 'bad' : 'warn'), ' ', h('a', { href: `#/project/${pid}/evidence`, dataset: { key: `ov-evidence-${prov}` } }, 'see why'), h('span', { class: 'muted' }, ' (no score changes)'))
        : null,
      h('p', { class: 'small faint', style: { margin: '8px 0 0' } }, routeText(r)),
      newer,
      h('div', { class: 'btn-row', style: { marginTop: '10px' } },
        h('a', { class: 'btn small', href: `#/project/${pid}/reports?report=${encodeURIComponent(r.report_id)}`, dataset: { key: `ov-report-${prov}` } }, 'Open report'),
        h('a', { class: 'btn small', href: `#/project/${pid}/scorecards?provider=${prov}`, dataset: { key: `ov-score-${prov}` } }, 'Scorecard'),
        waiting));
  } else if (sum && sum.needs_text) {
    // A PDF-only report: saved, but no grade can be read from it offline.
    main = h('div', null,
      h('div', { class: 'provider-grade' }, h('span', { class: 'state-text' }, 'PDF saved: needs a text copy')),
      h('p', { class: 'small muted', style: { margin: '4px 0 0' } }, `The PDF from ${fmtDate(sum.analysis_at || sum.imported_at)} is kept byte for byte. Paste its text as a new import for ${PROVIDER_LABELS[prov]} to grade it; until then it is not compared.`),
      newer,
      h('div', { class: 'btn-row', style: { marginTop: '10px' } },
        h('a', { class: 'btn small', href: `#/project/${pid}/reports?report=${encodeURIComponent(sum.report_id)}`, dataset: { key: `ov-report-${prov}` } }, 'Open the PDF report'),
        h('a', { class: 'btn small', href: `#/updates?tab=import&project=${encodeURIComponent(pid)}&provider=${prov}`, dataset: { key: `ov-paste-${prov}` } }, 'Import the text'),
        waiting));
  } else {
    const st = researchState(info.kind, { provider: prov, hosted });
    const next = waiting || (!job ? button('Run research', () => openResearchDialog(ctx, { ...row, ...d.project, research: row.research }, { providers: [prov] }), { kind: 'small', key: `ov-run-${prov}` }) : null);
    main = h('div', null,
      h('div', { class: 'provider-grade' }, stateText(info.kind === 'waiting' && hosted ? 'Waiting for you' : st.long, st.tone)),
      job && job.error ? h('p', { class: 'small', style: { color: 'var(--neg)' } }, job.error) : null,
      next ? h('div', { class: 'btn-row', style: { marginTop: '8px' } }, next) : null);
  }
  return h('div', { class: 'card' }, h('h3', null, PROVIDER_LABELS[prov]), main);
}

function overviewTab(ctx, d, row, latest) {
  const pid = d.project.project_id;
  const hl = d.headline;
  const ch = d.changes || {};
  const riskSources = PROVIDERS.map((p) => latest[p]).filter(Boolean);
  const grading = ctx.state.index.rubrics.grading;
  const riskTable = riskSources.length ? table([
    { label: 'Downside risk (higher means more risk)', render: (r) => h('span', { title: r.def.definition }, r.def.label) },
    ...riskSources.map((rep) => ({ label: `${PROVIDER_LABELS[rep.meta.provider]} · ${fmtDate(rep.assessment.analysis_at)}`, render: (r) => scoreView(rep.assessment.risk_scores[r.def.id], 'risk', { corrected: originalOf(rep, `risk_scores.${r.def.id}`) }) })),
  ], grading.risk_scores.map((def) => ({ def }))) : h('p', { class: 'small muted' }, 'No reports yet.');
  const unresolved = [
    ...PROVIDERS.flatMap((p) => (latest[p] ? (latest[p].assessment.unresolved_questions || []).map((q) => ({ provider: p, q })) : [])),
    ...d.disputes.filter((x) => x.status === 'open').map((x) => ({ provider: 'you', q: x.question })),
  ];
  const options = [{ value: '', label: 'Choose a report or decision…' }];
  for (const r of d.reports) if (!r.broken) options.push({ value: `report:${r.report_id}`, label: `${PROVIDER_LABELS[r.meta.provider]} · ${r.assessment.analysis_at || 'undated'} · ${r.grade ? r.grade.display || r.grade.status : 'no grade'}` });
  for (const j of d.journal) if (j.type === 'decision') options.push({ value: `decision:${j.entry_id}`, label: `Your decision · ${fmtDate(j.created_at)} · ${j.decision || ''}` });
  const sel = select(options, { 'aria-label': 'Headline source' });
  const save = button('Set headline', null, { kind: 'small' });
  save.onclick = action(save, async () => {
    if (!sel.value) throw new Error('Choose a report or a decision first.');
    const [type, val] = sel.value.split(/:(.+)/);
    await ctx.api.post(`/api/projects/${pid}/headline`, type === 'report' ? { report_id: val } : { entry_id: val });
    await ctx.refresh();
    return true;
  }, 'Headline updated');
  const clearBtn = button('Clear', null, { kind: 'small quiet' });
  clearBtn.onclick = action(clearBtn, async () => { await ctx.api.post(`/api/projects/${pid}/headline`, { clear: true }); await ctx.refresh(); return true; }, 'Headline cleared');
  const headlineText = !hl ? 'No headline chosen. A median across models is never used as the headline.'
    : hl.type === 'missing' ? hl.message
      : hl.type === 'decision' ? `Your decision: ${hl.decision || 'no label'}${hl.conviction ? `, conviction ${hl.conviction}` : ''} (${fmtDate(hl.created_at)})`
        : `${PROVIDER_LABELS[hl.provider]} report of ${fmtDate(hl.analysis_at)}: ${hl.grade && hl.grade.display ? `${hl.grade.display} ${hl.grade.label || ''}` : 'no grade'} · ${hl.verdict || 'no verdict'}`;
  return h('div', null,
    h('section', { class: 'section', 'aria-labelledby': 'ov-models' }, h('h2', { id: 'ov-models' }, 'Model scorecards'),
      h('div', { class: 'grid three' }, PROVIDERS.map((prov) => modelCard(ctx, d, row, prov, latest)))),
    card('How the models compare', modelsCompared(ctx, d), {
      note: 'Computed by this desk from the saved reports, not a model\'s opinion. Each model keeps its own grade; they are never merged into one.',
      actions: [h('a', { class: 'small', href: `#/project/${encodeURIComponent(pid)}/comparison`, dataset: { key: 'ov-compare' } }, 'Open the full comparison')],
    }),
    h('div', { class: 'grid two' },
      card('Since your last review', [
        ch.item_count ? h('ul', { class: 'list small' },
          (ch.new_reports || []).map((r) => h('li', null, `New ${PROVIDER_LABELS[r.provider]} report (${fmtDate(r.analysis_at)}): ${r.verdict || 'no verdict'}`)),
          (ch.provider_changes || []).filter((c) => c.from_report).map((c) => h('li', null, `${PROVIDER_LABELS[c.provider]} grade ${c.grade_from || 'none'} → ${c.grade_to || 'none'}${c.verdict_from !== c.verdict_to ? `; verdict ${c.verdict_from || 'none'} → ${c.verdict_to || 'none'}` : ''}`)),
          (ch.research_runs || []).map((r) => h('li', null, `Research run ${r.status.replace(/_/g, ' ')} (${r.providers.map((p) => PROVIDER_LABELS[p]).join(', ')})`)),
          ch.price && typeof ch.price.change_pct === 'number' ? h('li', null, `Price ${fmtSignedPct(ch.price.change_pct)} since then`) : null)
          : h('p', { class: 'small muted' }, 'Nothing new since your last review.'),
        h('div', { class: 'btn-row', style: { marginTop: '8px' } }, reviewedButton(ctx, pid), h('a', { class: 'small', href: `#/project/${pid}/history` }, 'All changes')),
      ], { note: ch.since ? `Since ${ch.cursor_source === 'project created' ? 'the project was added' : fmtDateTime(ch.since)}. A digest never changes grades, reports or your headline.` : null }),
      card('Your headline', [h('p', { class: 'small', style: { margin: '0 0 8px' } }, headlineText), details('Change the headline', h('div', { class: 'actions' }, sel, save, clearBtn), { id: 'ov-headline' })], { note: 'The headline is your choice: one report, or one of your own decisions.' })),
    card('Material risks', [h('div', { class: 'legend' }, h('span', null, h('span', { class: 'swatch risk' }), 'Risk bars grow from the right: longer means more risk')), riskTable]),
    unresolved.length ? card('Unresolved questions', h('ul', { class: 'list' }, unresolved.map((u) => h('li', null, h('span', { class: 'faint' }, `${u.provider === 'you' ? 'You' : PROVIDER_LABELS[u.provider]}: `), u.q)))) : null);
}

const SECTION_NOTE = { component: ' (weighted into the grade)', risk: ' (downside risk: higher is worse)', diagnostic: '' };

// How the models compare, from the comparison the desk computed over the
// saved reports: each model's verdict and grade side by side (a withheld
// grade stays withheld), differences at or above the highlight threshold,
// figures that conflict, and the questions that would settle them. No
// combined grade, and agreement is never presented as confirmation.
function modelsCompared(ctx, d) {
  const c = d.comparison;
  const comp = c.comparability;
  const present = PROVIDERS.filter((p) => c.latest[p]);
  if (!present.length) return h('p', { class: 'small muted', style: { margin: 0 } }, 'No gradable reports yet. Differences appear once at least two models have one.');
  const side = table([
    { label: 'Model', render: (p) => h('strong', null, PROVIDER_LABELS[p]) },
    { label: 'Grade (this app)', render: (p) => gradeView(c.grades[p] && c.grades[p].grade, { compact: true }) },
    { label: 'Verdict (the model\'s)', render: (p) => verdictChip(c.latest[p].verdict) },
    { label: 'Analysis', nowrap: true, render: (p) => fmtDate(c.latest[p].analysis_at) },
  ], present, { caption: 'Each model\'s grade and verdict, side by side' });
  const out = [side];
  const pairs = c.claim_conflicts.flatMap((m) => m.pairs.map((pair) => ({ metric: m.metric_id, ...pair })));
  const contradictions = pairs.filter((x) => x.kind === 'contradiction');
  const otherBasis = pairs.filter((x) => !['contradiction', 'agreement', 'agreement_shared_source'].includes(x.kind));
  if (present.length < 2) {
    out.push(h('p', { class: 'small muted', style: { margin: '10px 0 0' } }, 'Differences appear once a second model has a gradable report.'));
    return out;
  }
  if (!comp.comparable) {
    out.push(h('p', { class: 'small', style: { margin: '10px 0 0' } }, h('strong', null, 'Not directly comparable: '), `${comp.reasons.join('; ')}. The values can be read side by side, but no difference is calculated.`));
  } else {
    const rows = c.rows.filter((r) => r.spread_flag);
    const cell = (s) => (!s ? '—' : s.status === 'scored' ? String(s.value) : s.status === 'range' ? `${s.low}–${s.high}` : s.status === 'not_applicable' ? 'N/A' : 'unknown');
    out.push(h('p', { class: 'small', style: { margin: '10px 0 4px' } }, `${comp.comparable_providers.map((p) => PROVIDER_LABELS[p]).join(', ')} used the same rubric, scoring profile and horizon, analyzed ${comp.date_span_days ?? '?'} day(s) apart.`));
    out.push(rows.length
      ? h('div', null, h('h3', { class: 'compare-h' }, `Where they differ by ${c.threshold} points or more`),
        h('ul', { class: 'list small' }, rows.slice(0, 6).map((r) => h('li', null, h('strong', null, r.label), SECTION_NOTE[r.section] || '', ': ',
          comp.comparable_providers.map((p) => `${PROVIDER_LABELS[p]} ${cell(r.cells[p])}`).join(' · '), h('span', { class: 'faint' }, ` (${r.spread} points apart)`)))),
        rows.length > 6 ? h('p', { class: 'small muted', style: { margin: 0 } }, `${rows.length - 6} more in the full comparison.`) : null)
      : h('p', { class: 'small muted', style: { margin: 0 } }, `No score differs by ${c.threshold} points or more.`));
  }
  if (contradictions.length || otherBasis.length) {
    out.push(h('div', null, h('h3', { class: 'compare-h' }, 'Figures that conflict'),
      contradictions.length ? h('ul', { class: 'list small' }, contradictions.slice(0, 4).map((x) => h('li', null, h('code', null, x.metric), `: ${PROVIDER_LABELS[x.a.provider]} ${fmtNum(x.a.value)} ${x.a.unit || ''} vs ${PROVIDER_LABELS[x.b.provider]} ${fmtNum(x.b.value)} ${x.b.unit || ''}`, typeof x.diff_pct === 'number' ? h('span', { class: 'faint' }, ` (${x.diff_pct}% apart)`) : null))) : h('p', { class: 'small muted', style: { margin: 0 } }, 'No figure contradicts another on the same basis.'),
      otherBasis.length ? h('p', { class: 'small muted', style: { margin: '4px 0 0' } }, `${otherBasis.length} more figure${otherBasis.length === 1 ? ' differs' : 's differ'} in unit, period, definition or date, so ${otherBasis.length === 1 ? 'it is' : 'they are'} not called a contradiction.`) : null));
  }
  const questions = c.resolving_questions || [];
  if (questions.length) {
    out.push(h('div', null, h('h3', { class: 'compare-h' }, 'Open questions that would settle it'),
      h('ul', { class: 'list small' }, questions.slice(0, 4).map((q) => h('li', null, h('strong', null, q.label), `: ${q.question}`)))));
  }
  const shared = (c.shared_sources && c.shared_sources.shared) || [];
  out.push(h('p', { class: 'small muted', style: { margin: '10px 0 0' } }, `Agreement between models is not independent confirmation: they may read the same sources (${shared.length} cited by more than one here), share training data, and get the same prompt.`));
  return out;
}

function reviewedButton(ctx, pid) {
  const b = button('Mark reviewed', null, { kind: 'small', key: 'ov-reviewed' });
  b.onclick = action(b, async () => { await ctx.api.post(`/api/projects/${pid}/reviewed`, {}); await ctx.refresh(); return true; }, 'Marked reviewed. New changes are counted from now.');
  return b;
}

// ---------------------------------------------------------------------------
// Scorecards: one model at a time, under the rubric its report declares.

function scorecardsTab(ctx, d, latest, route) {
  const present = PROVIDERS.filter((p) => latest[p]);
  const pid = d.project.project_id;
  if (!present.length) return callout('No gradable reports yet. Use Run research above, or import a report from the Updates page.', 'info');
  const want = route.query.get('provider');
  const prov = present.includes(want) ? want : present[0];
  const r = latest[prov];
  const a = r.assessment;
  const grading = ctx.state.index.rubrics.grading;
  const g = (d.comparison.grades[prov] && d.comparison.grades[prov].grade) || r.grade;
  const parts = (g && g.parts) || [];
  const profileCats = new Map(((d.profile && d.profile.diagnostic_categories) || []).map((c) => [c.id, c]));
  const integ = r.integrity || {};
  const switcher = h('div', { class: 'seg-wrap' }, h('div', { class: 'seg', role: 'group', 'aria-label': 'Choose a model' },
    PROVIDERS.map((p) => (present.includes(p)
      ? h('a', { href: `#/project/${pid}/scorecards?provider=${p}`, 'aria-current': p === prov ? 'true' : null, dataset: { key: `sc-${p}` } }, PROVIDER_LABELS[p])
      : h('span', { class: 'seg-off', title: `No gradable ${PROVIDER_LABELS[p]} report yet` }, PROVIDER_LABELS[p], h('span', { class: 'sr-only' }, ', no gradable report'))))));
  return h('div', null,
    switcher,
    callout('Three separate panels, never mixed: the 11 diagnostics (higher is better) are never averaged into the grade; the grade comes from six weighted components (20/25/20/15/10/10); the four downside-risk scores are higher-is-worse. A missing input withholds the grade and shows how much weight was scored.', 'info'),
    card(h('span', { class: 'pill-row' }, h('span', null, `${PROVIDER_LABELS[prov]} · ${fmtDate(a.analysis_at)}`), verdictChip(a.verdict)), [
      h('div', { class: 'grid two' },
        h('div', null, h('div', { class: 'small muted' }, 'Grade calculated by this app'), gradeView(g),
          r.model_total ? h('p', { class: 'small', style: { marginTop: '8px' } }, r.model_total.status === 'mismatch' ? h('strong', null, 'Model total differs. ') : null, r.model_total.message) : null,
          g && g.status === 'withheld' ? withheldBlock(prov, g, a) : null),
        h('div', null,
          kv([
            ['Model', `${a.model_version || 'not stated'} (${r.provenance && r.provenance.attested ? 'attested by the API' : 'self-reported'})`],
            ['Horizon', `${a.horizon || 'not stated'}${a.horizon_interval && a.horizon_interval.kind !== 'unknown' ? ` (${a.horizon_interval.low_months}–${a.horizon_interval.high_months} months)` : ''}`],
            g && g.rubric_status && g.rubric_status !== 'ok' ? ['Rubric', h('span', { class: 'freshness stale' }, `${g.rubric_status}: no authoritative grade`)] : null,
            ['Citations', h('span', null, integ.status === 'valid' ? 'References resolve' : `Citation issues (${integ.status || 'unknown'})`, integ.counts ? h('span', { class: 'faint' }, ` · ${integ.counts.claims} claims, ${integ.counts.sources} sources`) : null)],
          ]),
          details('Rubric and provenance', kv([
            ['Rubric', a.rubric_version || 'not declared'],
            ['Scoring profile', a.sector_profile || 'not declared'],
            ['Prompt', a.prompt_version || 'not stated'],
            ['Arrived via', `${(r.provenance && r.provenance.channel) || '?'}${r.provenance && r.provenance.research_run_id ? ` · run ${r.provenance.research_run_id}` : ''}`],
          ]), { id: `sc-prov-${r.report_id}` }))),
      h('h3', { style: { marginTop: '20px' } }, 'Investment grade components (weighted)'),
      (table([
        { label: 'Component', render: (x) => x.label },
        { label: 'Weight', num: true, render: (x) => `${x.weight_pct}%` },
        { label: 'Score (higher is better)', render: (x) => scoreView(a.investment_components[x.id], 'fav', { corrected: originalOf(r, `investment_components.${x.id}`) }) },
        { label: 'Contribution', num: true, render: (x) => (typeof x.contribution === 'number' ? x.contribution.toFixed(2) : h('span', { class: 'faint' }, '—')) },
      ], parts.length ? parts : grading.investment_components.map((c) => ({ id: c.id, label: c.label, weight_pct: c.weight_bp / 100 })))),
      h('h3', { style: { marginTop: '20px' } }, 'Diagnostic scorecard (higher is better, never averaged)'),
      (table([
        { label: 'Category', render: (x) => h('span', { title: x.def ? x.def.definition : '' }, x.def ? x.def.label : x.id) },
        { label: 'Score', render: (x) => (x.def && x.def.applicable === false ? h('span', { class: 'faint', title: x.def.na_reason || '' }, 'Not applicable to this profile') : scoreView(a.diagnostic_scores[x.id], 'fav', { corrected: originalOf(r, `diagnostic_scores.${x.id}`) })) },
        { label: 'Rationale', wrap: true, render: (x) => { const s = a.diagnostic_scores[x.id]; return s ? h('span', { class: 'small' }, s.rationale || s.missing_data || '') : null; } },
      ], [...new Set([...profileCats.keys(), ...Object.keys(a.diagnostic_scores || {})])].map((cid) => ({ id: cid, def: profileCats.get(cid) })))),
      h('h3', { style: { marginTop: '20px' } }, 'Downside risk (higher means more risk)'),
      (table([
        { label: 'Risk', render: (x) => h('span', { title: x.definition }, x.label) },
        { label: 'Score', render: (x) => scoreView(a.risk_scores[x.id], 'risk', { corrected: originalOf(r, `risk_scores.${x.id}`) }) },
        { label: 'Rationale', wrap: true, render: (x) => { const s = a.risk_scores[x.id]; return s ? h('span', { class: 'small' }, s.rationale || s.missing_data || '') : null; } },
      ], grading.risk_scores)),
      h('div', { class: 'btn-row', style: { marginTop: '16px' } }, h('a', { class: 'btn', href: `#/project/${pid}/reports?report=${encodeURIComponent(r.report_id)}` }, 'Open the full report')),
    ]),
    positionCard(a, prov));
}

// ---------------------------------------------------------------------------
// Reports: choose a report on the left, read the original on the right.

function issuesList(ex) {
  const issues = (ex && ex.issues) || [];
  const amb = (ex && ex.ambiguous) || [];
  return h('div', null,
    ex && ex.note ? h('p', { class: 'small muted' }, ex.note) : null,
    amb.length ? h('div', null, h('h3', null, 'Ambiguous values (need your correction)'), h('ul', { class: 'list small' }, amb.map((a) => h('li', null, h('strong', null, a.field), `: ${a.reason}`, a.line ? ` (line ${a.line})` : '', a.candidates ? h('ul', null, a.candidates.map((c) => h('li', null, `${typeof c.value === 'object' ? JSON.stringify(c.value) : c.value}${c.line ? ` — line ${c.line}: ${c.excerpt || ''}` : ''}`))) : a.excerpt ? h('div', { class: 'faint' }, a.excerpt) : null)))) : null,
    issues.length ? h('ul', { class: 'list small' }, issues.slice(0, 80).map((i) => h('li', null, h('strong', null, i.severity === 'error' ? 'Error' : i.severity === 'warning' ? 'Warning' : 'Note'), ' · ', h('code', null, i.field), ` ${i.message}`))) : h('p', { class: 'small muted' }, 'No validation issues.'));
}

function correctionForm(ctx, d, r) {
  const fields = [
    'analysis_at', 'horizon', 'rubric_version', 'sector_profile', 'verdict', 'model_version', 'eligibility', 'model_reported_overall_score',
    ...Object.keys(r.assessment.diagnostic_scores || {}).map((k) => `diagnostic_scores.${k}`),
    ...Object.keys(r.assessment.investment_components || {}).map((k) => `investment_components.${k}`),
    ...Object.keys(r.assessment.risk_scores || {}).map((k) => `risk_scores.${k}`),
  ];
  const fieldSel = select(fields);
  const value = input({ placeholder: 'e.g. 2026-09-30, or {"status":"scored","value":60,"rationale":"…"}' });
  const reason = input({ placeholder: 'Why (required)' });
  const btn = button('Save correction', null, { kind: 'small primary', type: 'submit' });
  const hint = h('div', { class: 'small muted' });
  const updateHint = () => {
    const f = fieldSel.value;
    hint.textContent = /scores|components|overall/.test(f)
      ? 'Score: {"status":"scored","value":60,"rationale":"…"}, {"status":"range","low":55,"high":65,"rationale":"…"} or {"status":"unknown","missing_data":"…"}'
      : f === 'eligibility' ? 'Exclude from comparison: {"excluded":true,"reason":"…"}' : f === 'verdict' ? 'One of the six verdict labels' : 'Text value. Rubric and profile must match exactly for reports to be compared.';
  };
  fieldSel.onchange = updateHint;
  updateHint();
  const form = h('form', { class: 'form-grid', dataset: { key: `correct-${r.report_id}` } }, field('Field', fieldSel), field('New value', value), field('Reason', reason), h('div', { class: 'field', style: { justifyContent: 'flex-end' } }, h('span', { class: 'field-label', 'aria-hidden': 'true' }, ' '), btn), h('div', { class: 'field wide' }, hint));
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!reason.value.trim()) {
      fieldError(reason, 'Give a reason; corrections keep an audit trail.');
      return;
    }
    let v = value.value.trim();
    try {
      v = JSON.parse(v);
    } catch (_) { /* plain text */ }
    if (v === '') v = null;
    const run = action(btn, async () => {
      await ctx.api.post(`/api/projects/${d.project.project_id}/reports/${r.report_id}/corrections`, { field: fieldSel.value, value: v, reason: reason.value });
      await ctx.refresh();
      return true;
    }, 'Correction saved as a separate file. The original report is unchanged.', { busyLabel: 'Saving…' });
    await run();
  };
  return form;
}

function claimReviewControls(ctx, d, r, c, rev) {
  const check = select(['not_checked', 'source_reachable', 'source_matches_claim', 'source_contradicts_claim', 'source_unavailable'].map((v) => ({ value: v, label: v.replace(/_/g, ' ') })), { 'aria-label': `Your check of claim ${c.claim_id}` });
  check.value = rev && rev.dashboard_check ? rev.dashboard_check.status : 'not_checked';
  const corr = select(['none', 'single_source_only', 'independently_corroborated', 'contradicted'].map((v) => ({ value: v, label: v.replace(/_/g, ' ') })), { 'aria-label': `Independent corroboration of claim ${c.claim_id}` });
  corr.value = rev && rev.corroboration ? rev.corroboration.status : 'none';
  const btn = button('Save', null, { kind: 'small' });
  btn.onclick = action(btn, async () => {
    await ctx.api.post(`/api/projects/${d.project.project_id}/claims`, { report_id: r.report_id, claim_id: c.claim_id, dashboard_check: check.value, corroboration: corr.value });
    await ctx.refresh();
    return true;
  }, 'Claim review saved');
  return h('div', { style: { display: 'grid', gap: '6px', minWidth: '210px' } }, check, corr, btn);
}

// The desk's evidence checks on one report's claims (core/evidence.js):
// flags with the reason and what would settle each; never a score change.
const SEVERITY_TONE = { high: 'bad', medium: 'warn', low: '' };
function evidenceChecksBlock(ev) {
  if (!ev) return null;
  return h('div', { class: 'small', style: { margin: '0 0 10px' } },
    h('p', { style: { margin: '0 0 4px' } },
      stateText(ev.flags.length ? `${ev.flagged_claims} claim${ev.flagged_claims === 1 ? '' : 's'} need better evidence` : 'Evidence checks: nothing flagged', ev.high ? 'bad' : ev.flags.length ? 'warn' : 'ok'),
      ' ', h('span', { class: 'muted' }, ev.summary)),
    ev.flags.length ? h('ul', { class: 'list small' }, ev.flags.map((x) => h('li', null, stateText(x.severity, SEVERITY_TONE[x.severity]), ' ', x.message))) : null,
    ev.source_types && ev.source_types.outside_list.length
      ? h('p', { class: 'small muted', style: { margin: '4px 0 0' } }, `Source types written outside the accepted list, read as: ${ev.source_types.outside_list.map((x) => `${x.given} as ${x.read_as}`).join(', ')}.`)
      : null);
}

function claimsTable(ctx, d, r) {
  const reviews = d.claim_reviews || {};
  const sources = new Map((r.assessment.sources || []).map((s) => [s.source_id, s]));
  // The worst desk flag on each claim, shown next to its text.
  const worst = new Map();
  for (const x of (r.evidence && r.evidence.flags) || []) if (!worst.has(x.claim_id)) worst.set(x.claim_id, x);
  return (table([
    { label: 'Claim', wrap: true, render: (c) => h('div', null, h('span', { class: 'faint small' }, `${c.claim_id} `), c.text, c.limitation ? h('div', { class: 'small muted' }, `Limitation: ${c.limitation}`) : null, worst.has(c.claim_id) ? h('div', { class: 'small' }, stateText(`Desk check: ${worst.get(c.claim_id).severity}`, SEVERITY_TONE[worst.get(c.claim_id).severity]), ' ', h('span', { class: 'muted' }, worst.get(c.claim_id).message)) : null) },
    { label: 'Analyst tag', render: (c) => tagChip(c.evidence_tag, c.evidence_tag_raw) },
    { label: 'Metric', render: (c) => (c.metric_id ? h('div', { class: 'small' }, h('code', null, c.metric_id), c.value !== null && c.value !== undefined ? ` ${fmtNum(c.value)} ${c.unit || ''}` : '', h('div', { class: 'muted' }, [c.period, c.as_of ? `as of ${c.as_of}` : null].filter(Boolean).join(' · '))) : null) },
    { label: 'Sources', render: (c) => h('div', { class: 'small' }, (c.source_ids || []).map((sid) => { const s = sources.get(sid); return h('div', null, s && s.url ? h('a', { href: s.url }, s.title || s.url) : `${sid} (not in the source list)`); })) },
    { label: 'Your check · corroboration', render: (c) => claimReviewControls(ctx, d, r, c, reviews[`${r.report_id}#${c.claim_id}`]) },
  ], r.assessment.claims || [], { empty: 'This report lists no structured claims.' }));
}

function reportReader(ctx, d, r) {
  const holder = h('div', { class: 'reader' }, h('p', { class: 'small muted' }, 'Loading the original…'));
  const pid = d.project.project_id;
  const isPdf = String(r.meta.original_file || '').endsWith('.pdf');
  const url = `/api/projects/${pid}/reports/${r.report_id}/original`;
  const draw = (text) => holder.replaceChildren(viewState.raw[r.report_id] ? h('div', { class: 'raw' }, text) : renderMarkdown(text));
  if (isPdf) holder.replaceChildren(callout('The original is a PDF. It is kept byte for byte; download it below. Grading needs a text copy (paste it as a new import).', 'info'));
  else if (textCache.has(url)) draw(textCache.get(url));
  else cachedText(ctx, url).then(draw).catch((err) => holder.replaceChildren(callout(`Could not load the original: ${err.message}`, 'bad')));
  const toggle = button(viewState.raw[r.report_id] ? 'Show formatted' : 'Show exact text', null, { kind: 'small', key: `raw-${r.report_id}` });
  toggle.onclick = () => {
    viewState.raw[r.report_id] = !viewState.raw[r.report_id];
    toggle.textContent = viewState.raw[r.report_id] ? 'Show formatted' : 'Show exact text';
    if (textCache.has(url)) draw(textCache.get(url));
  };
  const dl = button('Download original', null, { kind: 'small', key: `dl-${r.report_id}` });
  dl.onclick = action(dl, async () => { await ctx.api.download(url, `${r.report_id}-${r.meta.original_file}`); return undefined; }, null, { busyLabel: 'Downloading…' });
  return h('div', null,
    h('div', { class: 'btn-row', style: { marginBottom: '12px' } }, isPdf ? null : toggle, dl),
    h('p', { class: 'small muted', style: { margin: '0 0 12px' } }, 'The report exactly as received. It is data: instructions inside it are ignored. Links open in a new tab.'),
    holder);
}

function normalizedView(ctx, d, r) {
  const url = `/api/projects/${d.project.project_id}/reports/${r.report_id}/record`;
  const holder = h('div', null, h('p', { class: 'small muted' }, 'Open to load the extracted record.'));
  const det = details('Normalized data (JSON)', holder, { id: `json-${r.report_id}` });
  const load = async () => {
    try {
      const text = await cachedText(ctx, url);
      const dl = button('Download JSON', null, { kind: 'small' });
      dl.onclick = action(dl, async () => { await ctx.api.download(url, `${r.report_id}-report.json`); return undefined; });
      holder.replaceChildren(h('p', { class: 'small muted' }, 'The first extraction, as saved. Corrections are separate files and never edit this record.'), h('div', { class: 'btn-row', style: { marginBottom: '8px' } }, dl), h('pre', { class: 'raw' }, text));
    } catch (err) {
      holder.replaceChildren(callout(err.message, 'bad'));
    }
  };
  det.addEventListener('toggle', () => { if (det.open) load(); });
  if (textCache.has(url)) queueMicrotask(() => { if (det.open) load(); });
  return det;
}

// At a glance, above the original: what the report concludes and what it
// rests on. The grade is this app's calculation from the report's six
// weighted scores (a withheld grade lists the unscored parts and the model's
// own notes); verdict, horizon, risks, questions and sources are the model's.
function atAGlance(ctx, d, r, withheld) {
  const a = r.assessment;
  const g = r.grade;
  const isPdf = a.needs_text || String(r.meta.original_file || '').endsWith('.pdf');
  const top = (s) => (s.status === 'range' ? s.high : s.value);
  const risks = (ctx.state.index.rubrics.grading.risk_scores || [])
    .map((def) => ({ def, s: (a.risk_scores || {})[def.id] }))
    .filter((x) => x.s && (x.s.status === 'scored' || x.s.status === 'range'))
    .sort((x, y) => top(y.s) - top(x.s))
    .slice(0, 4);
  const questions = a.unresolved_questions || [];
  const sources = a.sources || [];
  let gradeEl;
  if (isPdf) gradeEl = h('div', { class: 'provider-grade' }, h('span', { class: 'state-text' }, 'PDF: needs a text copy'));
  else if (withheld) {
    gradeEl = h('div', null,
      h('div', { class: 'provider-grade' }, h('span', { class: 'state-text' }, 'Withheld'), withheld.coverage !== null ? h('span', { class: 'small muted' }, `${withheld.coverage}% of the weight scored`) : null),
      unscoredList(withheld, { max: 400 }));
  } else if (g && (g.status === 'firm' || g.status === 'range')) gradeEl = gradeView(g);
  else gradeEl = h('div', { class: 'provider-grade' }, h('span', { class: 'state-text' }, 'No grade'), g && g.reason ? h('span', { class: 'small muted' }, g.reason) : null);
  const sourceItem = (s) => {
    const meta = [s.publisher, s.source_type ? s.source_type.replace(/_/g, ' ') : null, s.accessed_at ? `accessed ${fmtDate(s.accessed_at)}` : null].filter(Boolean);
    return h('li', null, s.url ? h('a', { href: s.url }, s.title || s.url) : h('span', null, s.title || s.source_id, h('span', { class: 'faint' }, ' (no usable link)')), meta.length ? h('span', { class: 'faint' }, ` · ${meta.join(' · ')}`) : null);
  };
  return h('section', { class: 'card glance', 'aria-labelledby': 'glance-title' },
    h('div', { class: 'card-head' }, h('div', null, h('h2', { id: 'glance-title' }, 'At a glance'),
      h('div', { class: 'note' }, 'The grade is calculated by this app from the report\'s six weighted scores. The verdict, risks, questions and sources are the model\'s own; the report below tags each claim as checked, project-claimed, inference or speculation.'))),
    h('div', { class: 'glance-grid' },
      h('div', null,
        h('div', { class: 'small muted' }, 'Grade'), gradeEl,
        h('dl', { class: 'facts' },
          h('div', null, h('dt', null, 'Verdict (the model\'s)'), h('dd', null, verdictChip(a.verdict))),
          h('div', null, h('dt', null, 'Horizon'), h('dd', null, a.horizon || 'not stated')))),
      h('div', null,
        h('div', { class: 'small muted' }, 'Top downside risks (higher is worse)'),
        risks.length
          ? h('ul', { class: 'glance-risks' }, risks.map((x) => h('li', null, h('span', { title: x.def.definition || '' }, x.def.label), scoreView(x.s, 'risk'))))
          : h('p', { class: 'small faint', style: { margin: '6px 0 0' } }, 'No downside risk was scored in this report.'))),
    questions.length ? h('div', { class: 'glance-block' }, h('h3', null, `Unresolved questions (${questions.length})`), h('ul', { class: 'list small' }, questions.map((q) => h('li', null, q)))) : null,
    h('div', { class: 'glance-block' }, sources.length
      ? details(`${sources.length} source${sources.length === 1 ? '' : 's'} cited`, h('ol', { class: 'list small' }, sources.map(sourceItem)), { id: `src-${r.report_id}`, open: sources.length <= 5 })
      : h('p', { class: 'small faint', style: { margin: 0 } }, 'This report lists no sources.')));
}

function reportsTab(ctx, d, route) {
  const pid = d.project.project_id;
  if (!d.reports.length) return callout('No reports imported yet. Older analyses stay here as dated records once they exist.', 'info');
  const good = d.reports.filter((r) => !r.broken);
  const broken = d.reports.filter((r) => r.broken);
  const latestIds = new Set(Object.values(d.comparison.latest).filter(Boolean).map((x) => x.report_id));
  const want = route.query.get('report');
  const sel = good.find((r) => r.report_id === want) || good.find((r) => latestIds.has(r.report_id)) || good[0];
  const list = h('nav', { class: 'report-list', 'aria-label': 'Reports' },
    PROVIDERS.filter((p) => good.some((r) => r.meta.provider === p)).map((p) => [
      h('div', { class: 'group-label' }, PROVIDER_LABELS[p]),
      good.filter((r) => r.meta.provider === p).sort((a, b) => String(b.assessment.analysis_at || '').localeCompare(String(a.assessment.analysis_at || ''))).map((r) => {
        const g = r.grade;
        return h('a', { href: `#/project/${pid}/reports?report=${encodeURIComponent(r.report_id)}`, 'aria-current': sel && r.report_id === sel.report_id ? 'true' : null, dataset: { key: `rl-${r.report_id}` } },
          h('div', { class: 'line1' }, h('span', null, fmtDate(r.assessment.analysis_at) || 'Undated'), h('span', { class: 'num' }, g && g.display ? `${g.display} ${g.label || ''}`.trim() : g && g.status === 'withheld' ? `Withheld${typeof g.coverage_pct === 'number' ? ` · ${g.coverage_pct}%` : ''}` : r.meta.original_file.endsWith('.pdf') ? 'PDF' : 'No grade')),
          h('div', { class: 'line2' }, [r.assessment.verdict ? r.assessment.verdict.charAt(0) + r.assessment.verdict.slice(1).toLowerCase() : 'No verdict', latestIds.has(r.report_id) ? 'latest' : 'earlier', r.corrections.length ? `${r.corrections.length} correction(s)` : null].filter(Boolean).join(' · ')));
      }),
    ]));
  let main = h('div', null);
  if (sel) {
    const a = sel.assessment;
    const ex = sel.extraction || {};
    const errors = (ex.issues || []).filter((i) => i.severity === 'error').length;
    const amb = (ex.ambiguous || []).length;
    const pv = sel.provenance || {};
    const withheld = sel.grade && sel.grade.status === 'withheld' ? withheldReason(sel.meta.provider, sel.grade, unscoredFrom(sel.grade, a.investment_components)) : null;
    main = h('article', { class: 'report-main', 'aria-labelledby': 'report-title' },
      h('div', { class: 'head' },
        h('h2', { id: 'report-title' }, `${PROVIDER_LABELS[sel.meta.provider]} report · ${fmtDate(a.analysis_at) || 'undated'}`),
        h('div', { class: 'meta-line', style: { marginTop: '6px' } },
          h('span', null, sel.grade && sel.grade.display ? `Grade ${sel.grade.display} ${sel.grade.label || ''}`.trim() : withheld ? withheld.short : 'No grade'),
          verdictChip(a.verdict),
          h('span', null, `Horizon ${a.horizon || '?'}`),
          h('span', null, `${a.model_version || 'model not stated'}, ${pv.attested ? 'attested by the API' : 'self-reported'}`),
          h('span', null, latestIds.has(sel.report_id) ? 'Latest eligible report' : sel.eligible ? 'Earlier report' : 'Excluded from comparison')),
        withheld ? h('p', { class: 'why-withheld' }, withheld.sentence) : null,
        errors || amb ? h('div', { style: { marginTop: '12px' } }, callout(`${errors ? `${errors} extraction error(s)` : ''}${errors && amb ? ' and ' : ''}${amb ? `${amb} ambiguous value(s)` : ''}: see Extraction notes below.`, 'warn')) : null),
      atAGlance(ctx, d, sel, withheld),
      reportReader(ctx, d, sel),
      h('div', { style: { marginTop: '24px' } },
        details(`Corrections (${sel.corrections.length})`, h('div', null,
          sel.corrections.length ? (table([
            { label: 'When', render: (c) => fmtDateTime(c.created_at) },
            { label: 'Field', render: (c) => h('code', null, c.field) },
            { label: 'Original (as written)', render: (c) => h('code', { class: 'small' }, JSON.stringify(c.previous_value)) },
            { label: 'Your correction', render: (c) => h('code', { class: 'small' }, JSON.stringify(c.new_value)) },
            { label: 'Reason', wrap: true, key: 'reason' },
          ], sel.corrections)) : h('p', { class: 'small muted' }, 'No corrections. The original and its first extraction never change; corrections are separate dated files.'),
          h('h3', { style: { margin: '16px 0 8px' } }, 'Add a correction'),
          correctionForm(ctx, d, sel)), { id: `corr-${sel.report_id}`, open: sel.corrections.length > 0 }),
        details(`Claims and evidence (${a.claims ? a.claims.length : 0})`, claimsTable(ctx, d, sel), { id: `claims-${sel.report_id}` }),
        normalizedView(ctx, d, sel),
        details(`Extraction notes${errors || amb ? ` (${errors + amb})` : ''}`, issuesList(ex), { id: `notes-${sel.report_id}`, open: errors > 0 || amb > 0 }),
        details('File and provenance', kv([
          ['Original file', `${sel.meta.original_filename}`],
          ['Stored at', h('code', null, `projects/${pid}/reports/${sel.report_id}/${sel.meta.original_file}`)],
          ['SHA-256', h('code', null, sel.meta.original_sha256 || '')],
          ['Imported', `${fmtDateTime(sel.meta.imported_at)} by ${sel.meta.imported_by}`],
          ['Arrived via', `${pv.channel || sel.meta.provider_source || '?'}${pv.declared_provider && pv.declared_provider !== sel.meta.provider ? ` · the report says it is from ${pv.declared_provider}` : ''}`],
          ['Research run', pv.research_run_id || 'not part of a run'],
          ['Prompt · rubric · profile', `${a.prompt_version || '?'} · ${a.rubric_version || '?'} · ${a.sector_profile || '?'}`],
          ['Project matched by', sel.meta.project_resolution],
        ]), { id: `file-${sel.report_id}` })));
  }
  return h('div', null,
    broken.length ? broken.map((r) => callout(`${r.report_id}: ${r.error}`, 'bad')) : null,
    h('div', { class: 'report-layout' }, list, main));
}

// ---------------------------------------------------------------------------
// Comparison

export function comparisonBlock(ctx, d, { showMedian }) {
  const c = d.comparison;
  const comp = c.comparability;
  const present = PROVIDERS.filter((p) => c.latest[p]);
  const ctxt = comp.context || {};
  const banner = !present.length
    ? callout('No reports yet.', 'info')
    : comp.comparable
      ? callout(`Compared: ${comp.comparable_providers.map((p) => PROVIDER_LABELS[p]).join(', ')}. Same rubric (${ctxt.rubric_version || '?'}), profile (${ctxt.sector_profile || '?'}) and horizon (${ctxt.horizon ? `${ctxt.horizon.raw}, ${ctxt.horizon.low_months}–${ctxt.horizon.high_months} months` : '?'}); analyses ${comp.date_span_days ?? '?'} day(s) apart, within the ${c.window_days}-day window.${comp.reasons.length ? ` Not compared: ${comp.reasons.join('; ')}.` : ''} Agreement between models is not independent confirmation, especially when they cite the same sources.`, 'info')
      : callout(`Not directly comparable: ${comp.reasons.join('; ')}. Values are shown side by side; no difference or median is calculated.`, 'warn');
  const comparable = new Set(comp.comparable_providers);
  const rows = [];
  const groups = [['diagnostic', 'Diagnostic scorecard: higher is better (never averaged into the grade)'], ['component', 'Investment components: higher is better (weighted into the grade)'], ['risk', 'Downside risk: higher means more risk']];
  for (const [section, title] of groups) {
    rows.push({ _group: title });
    for (const r of c.rows.filter((x) => x.section === section)) rows.push(r);
  }
  const weights = Object.fromEntries(ctx.state.index.rubrics.grading.investment_components.map((x) => [x.id, x.weight_bp / 100]));
  const columns = [
    { label: 'Item', render: (r) => h('span', { title: r.resolving_question || '' }, r.label, r.section === 'component' ? h('span', { class: 'faint small' }, ` · ${weights[r.id]}%`) : null) },
    ...present.map((p) => ({ label: h('span', null, PROVIDER_LABELS[p], comparable.has(p) ? null : h('span', { class: 'faint small' }, ' (not compared)')), render: (r) => (r.applicable === false ? h('span', { class: 'faint', title: r.na_reason || '' }, 'N/A') : scoreView(r.cells[p], r.direction === 'higher_is_more_risk' ? 'risk' : 'fav')) })),
    { label: 'Difference', num: true, title: `Highlighted at ${c.threshold} points or more`, render: (r) => (r.spread === null || r.spread === undefined ? null : r.spread_flag ? h('strong', null, String(r.spread), h('span', { class: 'sr-only' }, ', above the threshold')) : String(r.spread)) },
  ];
  if (showMedian) columns.push({ label: 'Median (descriptive)', num: true, title: 'Descriptive median of comparable single scores. Not a committee grade.', render: (r) => (r.median === null || r.median === undefined ? null : String(r.median)) });
  const gradeRow = present.length ? table([
    { label: '', srLabel: 'Measure', render: (x) => h('strong', null, x.label) },
    ...present.map((p) => ({ label: PROVIDER_LABELS[p], render: (x) => x.render(p) })),
  ], [
    { label: 'Grade (this app)', render: (p) => gradeView(c.grades[p] && c.grades[p].grade, { compact: true }) },
    { label: "Model's own total", render: (p) => { const m = c.grades[p] && c.grades[p].model_total; if (!m) return null; return h('span', { title: m.message }, m.reported ? `${m.reported} · ` : '', m.status === 'mismatch' ? h('strong', null, 'differs') : m.status); } },
    { label: 'Verdict', render: (p) => verdictChip(c.latest[p].verdict) },
    { label: 'Analysis date', render: (p) => fmtDate(c.latest[p].analysis_at) },
    { label: 'Model', render: (p) => c.latest[p].model_version || h('span', { class: 'faint' }, 'not stated') },
    { label: 'Horizon · rubric · profile', render: (p) => h('span', { class: 'small' }, `${c.latest[p].horizon || '?'} · ${c.latest[p].rubric_version || '?'} · ${c.latest[p].sector_profile || '?'}`) },
  ]) : null;
  const shared = c.shared_sources;
  const conflicts = c.claim_conflicts.flatMap((m) => m.pairs.map((pair) => ({ metric: m.metric_id, ...pair })));
  return h('div', null,
    banner,
    h('div', { class: 'legend' }, h('span', null, h('span', { class: 'swatch fav' }), 'Favorable: longer is better'), h('span', null, h('span', { class: 'swatch risk' }), 'Risk: grows from the right, longer is worse'), h('span', null, `Differences of ${c.threshold}+ are marked and bold`), h('span', null, 'N/A not applicable · ? unknown')),
    present.length ? (table(columns, rows, { rowClass: (r) => (r.spread_flag ? 'flag' : null) })) : null,
    gradeRow ? h('div', { style: { marginTop: '16px' } }, gradeRow) : null,
    present.length > 1 ? h('div', { class: 'grid two', style: { marginTop: '16px' } },
      h('div', null, h('h3', null, 'Shared sources'), shared.shared.length
        ? h('div', null, h('p', { class: 'small muted' }, shared.note), h('ul', { class: 'list' }, shared.shared.map((s) => h('li', null, h('a', { href: s.url }, s.title || s.url), h('span', { class: 'faint small' }, ` · ${s.providers.map((p) => PROVIDER_LABELS[p]).join(', ')}`)))),
          h('p', { class: 'small muted' }, Object.entries(shared.overlap).map(([p, o]) => `${PROVIDER_LABELS[p]}: ${o.shared} of ${o.sources} sources shared`).join(' · ')))
        : h('p', { class: 'muted small' }, 'No source is cited by more than one model.')),
      h('div', null, h('h3', null, 'Questions that would settle the differences'), c.resolving_questions.length
        ? h('ul', { class: 'list' }, c.resolving_questions.map((q) => h('li', null, h('strong', null, q.label), ': ', q.question, h('div', { class: 'small muted' }, `${q.reason} (${q.source === 'rubric' ? 'question from the rubric' : q.source === 'conflict' ? 'conflicting numbers' : 'different measurement basis'})`))))
        : h('p', { class: 'muted small' }, 'No flagged differences.'))) : null,
    conflicts.length ? h('div', { style: { marginTop: '16px' } }, h('h3', null, 'Numbers across reports'), (table([
      { label: 'Metric', render: (x) => h('code', null, x.metric) },
      { label: 'Finding', render: (x) => h('span', null, x.kind.replace(/_/g, ' ')) },
      { label: 'A', wrap: true, render: (x) => h('div', null, `${PROVIDER_LABELS[x.a.provider]} `, tagChip(x.a.evidence_tag), ` ${fmtNum(x.a.value)} ${x.a.unit || ''}`, h('div', { class: 'small muted' }, `${x.a.period || 'period unstated'}${x.a.as_of ? ` · as of ${x.a.as_of}` : ''}${x.a.definition ? ` · ${x.a.definition}` : ''}`)) },
      { label: 'B', wrap: true, render: (x) => h('div', null, `${PROVIDER_LABELS[x.b.provider]} `, tagChip(x.b.evidence_tag), ` ${fmtNum(x.b.value)} ${x.b.unit || ''}`, h('div', { class: 'small muted' }, `${x.b.period || 'period unstated'}${x.b.as_of ? ` · as of ${x.b.as_of}` : ''}${x.b.definition ? ` · ${x.b.definition}` : ''}`)) },
      { label: 'Gap', num: true, title: 'Only meaningful for the same metric, unit, period, definition and date', render: (x) => (['contradiction', 'agreement', 'agreement_shared_source'].includes(x.kind) ? `${x.diff_pct}%` : h('span', { class: 'faint small' }, 'not comparable')) },
    ], conflicts))) : null);
}

function comparisonTab(ctx, d) {
  const holder = h('div');
  const draw = () => holder.replaceChildren(comparisonBlock(ctx, d, { showMedian: viewState.median }));
  const toggle = h('input', { type: 'checkbox', checked: viewState.median });
  toggle.onchange = () => { viewState.median = toggle.checked; draw(); };
  draw();
  const diffs = PROVIDERS.flatMap((p) => (d.diffs[p] || []).map((x) => ({ p, ...x })));
  return h('div', null,
    card('Model comparison', holder, { note: 'Latest eligible report from each model. Earlier reports are under Reports.', actions: [h('label', { class: 'check small', dataset: { nodirty: '1' } }, toggle, 'Show descriptive median')] }),
    card('How each model changed over time', diffs.length ? diffs.map((x) => h('div', { style: { marginBottom: '12px' } },
      h('div', { class: 'pill-row' }, h('strong', null, PROVIDER_LABELS[x.p]), h('span', { class: 'small' }, `${x.from} → ${x.to}`), x.comparable ? null : h('span', { class: 'small muted', title: x.note }, 'different rubric, profile or horizon')),
      x.changes.length ? h('ul', { class: 'list small' }, x.changes.map((chg) => h('li', null, `${chg.section} · ${chg.id}: ${fmtScore(chg.from)} → ${fmtScore(chg.to)}${chg.delta !== null && chg.delta !== undefined ? ` (${chg.delta > 0 ? '+' : ''}${chg.delta})` : ''}`))) : h('div', { class: 'small muted' }, 'No score changes.'))) : h('p', { class: 'small muted' }, 'Only one report per model so far.')));
}

// ---------------------------------------------------------------------------
// Evidence

function evidenceTab(ctx, d, latest) {
  const pid = d.project.project_id;
  const present = PROVIDERS.filter((p) => latest[p]);
  const disputeTopic = input({ placeholder: 'e.g. category:token_value_capture or metric:revenue_usd' });
  const disputeQ = input({ placeholder: 'The question that would settle it' });
  const disputeBtn = button('Add question', null, { kind: 'small', type: 'submit' });
  const disputeForm = h('form', { class: 'form-grid', dataset: { key: 'dispute-form' } }, field('Topic', disputeTopic), field('Resolving question', disputeQ), h('div', { class: 'field', style: { justifyContent: 'flex-end' } }, disputeBtn));
  disputeForm.onsubmit = action(disputeBtn, async () => { await ctx.api.post(`/api/projects/${pid}/disputes`, { topic: disputeTopic.value || null, question: disputeQ.value }); await ctx.refresh(); return true; }, 'Question added');
  return h('div', null,
    callout('Separate things: the analyst tag ([V] means the analyst says it checked a primary source in its own session), the desk\'s evidence checks (a [V] resting only on an AI summary or a secondary source, a critical claim without a primary source or date, a fee figure nobody could reproduce), your check (what you confirmed by opening the source), and independent corroboration (a different, independent source agrees). Citation integrity only means the references resolve. Model agreement is not corroboration. None of these changes a score.', 'info'),
    present.length ? present.map((p) => {
      const r = latest[p];
      const integ = r.integrity || {};
      return card(`${PROVIDER_LABELS[p]} · ${fmtDate(r.assessment.analysis_at)}`, [
        h('p', { class: 'small', style: { margin: '0 0 8px' } }, integ.status === 'valid' ? 'References resolve to listed sources (structural check only).' : `Citation issues: ${integ.status}.`),
        (integ.issues || []).length ? h('ul', { class: 'list small' }, integ.issues.map((i) => h('li', null, h('code', null, i.path || i.field || ''), ` ${i.message}`))) : null,
        evidenceChecksBlock(r.evidence),
        claimsTable(ctx, d, r),
      ]);
    }) : callout('No reports yet.', 'info'),
    card('Your dispute questions', [
      d.disputes.length ? (table([
        { label: 'Topic', render: (x) => (x.topic ? h('code', null, x.topic) : null) },
        { label: 'Question', wrap: true, key: 'question' },
        { label: 'Status', render: (x) => x.status },
      ], d.disputes)) : h('p', { class: 'small muted' }, 'None yet.'),
      h('div', { style: { marginTop: '12px' } }, disputeForm),
    ]));
}

// ---------------------------------------------------------------------------
// Market data

function marketTab(ctx, d) {
  const m = d.market;
  const pos = d.position;
  let body;
  if (!m) {
    body = callout(d.project.identity.status === 'verified' ? 'No CoinGecko listing is recorded, so there is no price source.' : 'Identity pending: no token is bound, so no prices are fetched. Another token\'s prices are never used.', 'info');
  } else if (m.status === 'missing') {
    body = callout(`No observation for ${m.coingecko_id} yet. Prices refresh every few minutes while the dashboard is open and hourly through the scheduled task.`, 'info');
  } else {
    const f = freshnessText(m.status, m.age_minutes);
    body = h('div', { class: 'grid two' },
      h('div', null,
        h('div', { class: 'pill-row' }, h('span', { class: 'price-big' }, fmtPrice(m.price_usd)), stateText(m.status === 'fresh' ? `Updated ${fmtAgo(m.fetched_at || m.as_of)}` : f.text, f.tone)),
        h('div', { style: { margin: '12px 0' } }, sparkline(m.sparkline_7d, { width: 420, height: 90, label: `${d.project.symbol || d.project.name} 7-day price` })),
        h('p', { class: 'small muted' }, '7-day series from the provider. Prices never change stored grades or report conclusions.')),
      kv([
        ['24H change', changeCell(m.change_24h_pct, { label: 'over 24 hours' })],
        ['7D change (rolling)', changeCell(m.change_7d_pct, { label: 'over 7 days' })],
        ['30D change (rolling)', changeCell(m.change_30d_pct, { label: 'over 30 days' })],
        ['Rank', m.market_cap_rank ? `#${m.market_cap_rank} · ${m.rank_source_label || 'CoinGecko market-cap rank'}` : 'Unranked'],
        ['Market cap', h('span', { title: 'Price × circulating supply, as reported by the provider' }, `${fmtCompactUsd(m.market_cap_usd)} (${typeof m.market_cap_usd === 'number' ? `$${fmtNum(m.market_cap_usd, 0)}` : '—'})`)],
        ['Market cap, 24H change', changeCell(m.market_cap_change_24h_pct, { label: 'market cap over 24 hours' })],
        ['Fully diluted valuation', fmtCompactUsd(m.fdv_usd)],
        ['Volume, last 24h', fmtCompactUsd(m.volume_24h_usd)],
        ['Volume vs ~24h ago', typeof m.volume_change_24h_pct === 'number' ? changeCell(m.volume_change_24h_pct, { label: 'volume' }) : h('span', { class: 'unknown' }, `Unknown: ${m.volume_change_basis || 'no earlier observation'}`)],
        ['Circulating / total / max supply', `${fmtNum(m.circulating_supply, 0)} / ${fmtNum(m.total_supply, 0)} / ${fmtNum(m.max_supply, 0)}`],
        ['Source timestamp', `${fmtDateTime(m.as_of)} (${m.source || 'CoinGecko'})`],
        ['Fetched', fmtDateTime(m.fetched_at)],
      ]));
  }
  return h('div', null,
    card('Market data', body),
    pos && !pos.closed ? card('Your position', h('p', null, 'You hold ', h('strong', null, `${fmtNum(pos.quantity)} ${pos.symbol}`), pos.value_usd !== null ? ` worth ${fmtPrice(pos.value_usd)}` : ' (value unknown: no usable price)', '. ', link('Portfolio', '#/portfolio'))) : null);
}

// ---------------------------------------------------------------------------
// Notes and history

function historyTab(ctx, d) {
  const pid = d.project.project_id;
  const note = h('textarea', { name: 'conviction-note', placeholder: 'Your conviction note in your own words…', 'aria-label': 'Conviction note' }, d.conviction ? d.conviction.text : '');
  const conv = select([{ value: '', label: 'Conviction (optional)' }, 'low', 'medium', 'high'], { 'aria-label': 'Conviction', name: 'conviction' });
  const saveNote = button('Save note', null, { kind: 'primary small', key: 'save-note' });
  saveNote.onclick = action(saveNote, async () => { const r = await ctx.api.post(`/api/projects/${pid}/note`, { text: note.value, conviction: conv.value || null }); await ctx.refresh(); return r; }, (r) => (r && r.status === 'unchanged' ? 'Note unchanged' : 'Conviction note saved'), { busyLabel: 'Saving…' });

  const decision = select(['watch', 'research_more', 'accumulate', 'hold', 'trim', 'exit', 'avoid'].map((v) => ({ value: v, label: v.replace('_', ' ') })));
  const dconv = select(['low', 'medium', 'high']);
  const dtext = input({ placeholder: 'Decision and reasoning' });
  const dreasons = input({ placeholder: 'Reasons, separated by ;' });
  const saveDecision = button('Record decision', null, { kind: 'small', type: 'submit' });
  const decisionForm = h('form', { class: 'form-grid', dataset: { key: 'decision-form' } }, field('Decision', decision), field('Conviction', dconv), field('Text', dtext), field('Reasons', dreasons), h('div', { class: 'field', style: { justifyContent: 'flex-end' } }, saveDecision));
  const decisionSid = submissionId();
  decisionForm.onsubmit = action(saveDecision, async () => {
    await ctx.api.post(`/api/projects/${pid}/journal`, { type: 'decision', decision: decision.value, conviction: dconv.value, text: dtext.value, reasons: dreasons.value.split(';').map((s) => s.trim()).filter(Boolean), submission_id: decisionSid });
    await ctx.refresh();
    return true;
  }, 'Decision recorded. It is yours, separate from any model report.', { busyLabel: 'Saving…' });

  const due = h('input', { type: 'date', 'aria-label': 'Due date' });
  const rtitle = input({ placeholder: 'What to review', value: 'Review thesis' });
  const addReview = button('Add review', null, { kind: 'small', type: 'submit' });
  const reviewForm = h('form', { class: 'form-grid', dataset: { key: 'review-form' } }, field('Due (America/New_York)', due), field('Title', rtitle), h('div', { class: 'field', style: { justifyContent: 'flex-end' } }, addReview));
  const reviewSid = submissionId();
  reviewForm.onsubmit = async (e) => {
    e.preventDefault();
    if (!due.value) {
      fieldError(due, 'Pick a date.');
      return;
    }
    await action(addReview, async () => {
      await ctx.api.post(`/api/scopes/${pid}/events`, { type: 'review', title: rtitle.value, due: due.value, submission_id: reviewSid });
      await ctx.refresh();
      return true;
    }, 'Review added')();
  };

  const akind = select([{ value: 'price_below', label: 'Price below' }, { value: 'price_above', label: 'Price above' }]);
  const ath = input({ type: 'number', step: 'any', min: '0', placeholder: 'USD' });
  const addAlert = button('Add alert', null, { kind: 'small', type: 'submit' });
  const alertForm = h('form', { class: 'form-grid', dataset: { key: 'alert-form' } }, field('Alert', akind), field('Threshold (USD)', ath), h('div', { class: 'field', style: { justifyContent: 'flex-end' } }, addAlert));
  const alertSid = submissionId();
  alertForm.onsubmit = action(addAlert, async () => {
    await ctx.api.post(`/api/scopes/${pid}/events`, { type: 'alert', title: `${akind.value === 'price_below' ? 'Price below' : 'Price above'} $${ath.value}`, alert_kind: akind.value, threshold_usd: Number(ath.value), submission_id: alertSid });
    await ctx.refresh();
    return true;
  }, 'Alert added. It shows on the dashboard; no external notification is sent.');

  const ch = d.changes || {};
  const eventRows = d.events.slice().sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')));
  return h('div', null,
    card('What changed since your last review', [
      ch.item_count ? h('div', null,
        (ch.provider_changes || []).length ? (table([
          { label: 'Model', render: (c) => PROVIDER_LABELS[c.provider] },
          { label: 'Grade', render: (c) => `${c.grade_from || (c.from_report ? 'none' : 'new')} → ${c.grade_to || 'none'}` },
          { label: 'Verdict', wrap: true, render: (c) => (c.verdict_from === c.verdict_to ? c.verdict_to || '—' : `${c.verdict_from || 'none'} → ${c.verdict_to || 'none'}`) },
          { label: 'Score changes', wrap: true, render: (c) => (c.diff && c.diff.changes && c.diff.changes.length ? h('span', { class: 'small' }, c.diff.changes.slice(0, 6).map((x) => `${x.id} ${fmtScore(x.from)}→${fmtScore(x.to)}`).join(', ')) : null) },
        ], ch.provider_changes)) : null,
        (ch.research_runs || []).length ? h('p', { class: 'small' }, `Research runs: ${ch.research_runs.map((r) => `${r.run_id} ${r.status.replace(/_/g, ' ')}`).join('; ')}`) : null,
        (ch.journal_entries || []).length ? h('p', { class: 'small' }, `${ch.journal_entries.length} journal entr${ch.journal_entries.length === 1 ? 'y' : 'ies'}`) : null,
        (ch.events || []).length ? h('p', { class: 'small' }, `${ch.events.length} review or alert change(s)`) : null,
        ch.price && typeof ch.price.change_pct === 'number' ? h('p', { class: 'small' }, `Price ${fmtSignedPct(ch.price.change_pct)} (${fmtPrice(ch.price.from)} on ${fmtDateTime(ch.price.from_at)} → ${fmtPrice(ch.price.to)})`) : null)
        : h('p', { class: 'small muted' }, 'Nothing new since your last review.'),
      h('p', { class: 'small faint' }, ch.note || 'A digest proposes what to look at. It never changes grades, reports or your headline.'),
      h('div', { class: 'btn-row' }, reviewedButton(ctx, pid)),
    ], { note: ch.since ? `Since ${ch.cursor_source === 'project created' ? 'the project was added' : fmtDateTime(ch.since)}` : null }),
    h('div', { class: 'grid two' },
      card('Your conviction note and journal', [
        note, h('div', { class: 'actions', style: { marginTop: '8px' } }, conv, saveNote, d.conviction ? h('span', { class: 'small muted' }, `Last saved ${fmtAgo(d.conviction.updated_at)}`) : null),
        h('hr', { class: 'soft' }),
        h('h3', { style: { marginBottom: '8px' } }, 'Record a decision'),
        decisionForm,
        h('hr', { class: 'soft' }),
        d.journal.length ? h('ul', { class: 'list', style: { listStyle: 'none', padding: 0 } }, d.journal.map((j) => h('li', { style: { padding: '8px 0', borderBottom: '1px solid var(--separator)' } },
          h('div', { class: 'small muted' }, `${j.type.replace(/_/g, ' ')} · ${fmtDateTime(j.created_at)} · via ${j.via || '?'}`),
          j.decision ? h('strong', null, `${j.decision.replace('_', ' ')}${j.conviction ? ` (${j.conviction})` : ''} `) : null, j.text ? h('span', null, j.text) : null,
          j.reasons && j.reasons.length ? h('div', { class: 'small muted' }, `Reasons: ${j.reasons.join('; ')}`) : null,
          j.source_request_text ? h('div', { class: 'small faint' }, `From request: “${j.source_request_text}”`) : null))) : h('p', { class: 'small muted' }, 'No journal entries yet. Every note change and decision is kept as a dated entry.'),
      ], { note: 'Private: never sent to a model by default.' }),
      card('Reviews, catalysts and alerts', [
        eventRows.length ? (table([
          { label: 'Due', nowrap: true, render: (e) => (e.due_date ? h('span', null, fmtDate(e.due_date), e.status === 'open' && e.due_date < ctx.state.index.today ? h('strong', null, ' · overdue') : null) : '—') },
          { label: 'Type', key: 'type' },
          { label: 'Title', wrap: true, render: (e) => h('div', null, e.title, e.source_request_text ? h('div', { class: 'small faint' }, `“${e.source_request_text}”`) : null) },
          { label: 'Status', key: 'status' },
          { label: '', render: (e) => { if (e.status !== 'open') return null; const b = button('Done', null, { kind: 'small' }); b.onclick = action(b, async () => { await ctx.api.post(`/api/scopes/${pid}/events/${e.event_id}`, { status: 'done' }); await ctx.refresh(); return true; }, 'Marked done'); return b; } },
        ], eventRows)) : h('p', { class: 'small muted' }, 'No reviews or alerts yet.'),
        h('hr', { class: 'soft' }), h('h3', { style: { marginBottom: '8px' } }, 'Add a review'), reviewForm, h('hr', { class: 'soft' }), h('h3', { style: { marginBottom: '8px' } }, 'Add a price alert'), alertForm,
      ], { note: 'Dates are calendar days in America/New_York.' })));
}

// ---------------------------------------------------------------------------
// Research runs, prompts and identity

// Mirrors the server: an uncertain paid attempt, or a provider error without
// usage, can be reconciled by the owner.
function reconcilable(j, a) {
  if (j.mode !== 'api' || !a || a.reconciled_at) return false;
  // An answer whose usage was incomplete: its cost is only an estimate.
  if (a.cost_status === 'estimated' && ['responded', 'imported', 'errored'].includes(a.phase)) return true;
  if (a.phase === 'uncertain') return true;
  if (a.phase === 'errored') return typeof a.cost_actual_usd !== 'number';
  return !a.phase && Boolean(a.finished_at) && a.outcome !== 'response_saved' && typeof a.cost_actual_usd !== 'number' && typeof a.cost_estimate_usd === 'number';
}

function money(n) {
  return `$${n > 0 && n < 0.1 ? n.toFixed(4) : n.toFixed(2)}`;
}

// What an attempt counts against the limits, in words: never "up to", because
// a reservation is an estimate, not a maximum.
// What an attempt cost, and how sure that figure is: reconciled (you recorded
// it from the provider's billing), actual (the provider reported all usage),
// estimated (usage incomplete: counted at no less than the reservation until
// reconciled) or reserved (no usage yet).
export function attemptCost(a) {
  if (a.phase === 'not_sent') return 'not sent, $0';
  if (typeof a.reconciled_usd === 'number' && (a.phase === 'reconciled' || a.reconciled_at)) return `${money(a.reconciled_usd)} reconciled (you recorded it)`;
  if (typeof a.cost_actual_usd === 'number') return `${money(a.cost_actual_usd)} actual${a.not_billed ? ' (refused before any work, not billed)' : ''}${typeof a.overrun_usd === 'number' && a.overrun_usd > 0 ? ` (${money(a.overrun_usd)} above its reservation)` : ''}`;
  const r = typeof a.reserved_usd === 'number' ? a.reserved_usd : a.cost_estimate_usd;
  if (typeof a.cost_usage_estimate_usd === 'number') {
    const counted = Math.max(a.cost_usage_estimate_usd, typeof r === 'number' ? r : 0);
    return `${money(a.cost_usage_estimate_usd)} estimated (the provider did not report ${(a.cost_unknown || []).includes('search_calls') ? 'how many searches ran' : 'all usage'}); counted at ${money(counted)} until reconciled`;
  }
  if (typeof r !== 'number') return null;
  if (a.phase === 'uncertain') return `${money(r)} reserved, counted until reconciled`;
  if (a.phase === 'submitted' || a.phase === 'dispatched') return `${money(r)} reserved (an estimate made before sending)`;
  return `${money(r)} reserved (estimate)`;
}

function reconcileForm(ctx, pid, run, prov, a) {
  const key = `rec-${run.run_id}-${prov}-${a.n}`;
  const amount = input({ inputmode: 'decimal', name: `${key}-amount`, placeholder: 'USD charged, e.g. 0.42', 'aria-label': `Amount charged for attempt ${a.n}` });
  const none = h('input', { type: 'checkbox', name: `${key}-none` });
  const reason = input({ name: `${key}-reason`, placeholder: 'How you know (e.g. provider usage page)', 'aria-label': `How you know what attempt ${a.n} cost` });
  const save = button('Record', null, { kind: 'small primary', type: 'submit' });
  const form = h('form', { class: 'reconcile', dataset: { key: `${key}-form` } },
    amount,
    h('label', { class: 'check small' }, none, 'Not charged'),
    reason,
    h('div', null, save));
  form.onsubmit = action(save, async () => {
    const body = { attempt: a.attempt_id || a.n, reason: reason.value.trim() };
    if (none.checked) body.not_charged = true;
    else body.charged_usd = amount.value.trim();
    const r = await ctx.api.post(`/api/projects/${pid}/research/${run.run_id}/jobs/${prov}/reconcile`, body);
    await ctx.refresh();
    return r;
  }, (r) => r.message || 'Recorded');
  return details(`Reconcile attempt #${a.n}`, h('div', null,
    h('p', { class: 'small muted', style: { margin: '0 0 6px' } }, 'Check the provider\'s usage page, then record what this attempt was charged. It counts against your limits at its reservation until you do.'),
    form), { id: key });
}

// An attempt's phase in words; "submitted" means the provider accepted the
// request and the desk is checking on it in the background.
const PHASE_TEXT = { reserved: 'reserved, about to be sent', submitted: 'accepted by the provider, running in the background', uncertain: 'uncertain: may have been billed', errored: 'error', not_sent: 'not sent' };

function jobRow(ctx, pid, run, prov, projectName = pid) {
  const j = run.jobs[prov];
  const key = jobKey(j, run.created_at);
  const hosted = Boolean(ctx.state.session && ctx.state.session.hosted);
  const st = researchState(key, { provider: prov, hosted });
  const actions = [];
  // A waiting job leads with its next step: on the online desk the sentence
  // for that model's assistant (in the state column, so it shows first even
  // where the table scrolls), with pasting by hand tucked under it.
  if (j.state === 'unconfigured') actions.push(...waitingActions(ctx, { pid, runId: run.run_id, provider: prov, key: `rt-${run.run_id}-${prov}`, instruction: false }));
  const say = (text) => {
    const b = button(`Copy: “${text}”`, null, { kind: 'small' });
    b.onclick = action(b, async () => { await copyText(text); return undefined; });
    return b;
  };
  if (isAssistantJob(j) && j.state === 'running') {
    // The model's own assistant (Claude in Cowork, ChatGPT, Gemini) does this
    // research; the desk cannot reach it, so resuming or restarting is
    // something to tell that assistant, in these words.
    const who = j.mode === 'cowork' ? 'Cowork' : PROVIDER_LABELS[prov];
    const idle = coworkIdleMinutes(j, run.created_at);
    actions.push(h('div', { class: 'small', style: { flexBasis: '100%' } },
      key === 'interrupted'
        ? `No activity from ${who} for ${idle >= 120 ? `${Math.round(idle / 60)} hours` : `${idle} minutes`}${j.draft_saved_at ? `; its draft from ${fmtDateTime(j.draft_saved_at)} is kept` : ''}. Tell ${who} to resume it (it continues this run and its draft) or to restart it (this run is canceled and a new one starts).`
        : `${who} is working on it${idle !== null ? ` (last activity ${idle < 1 ? 'just now' : `${idle} min ago`})` : ''}${j.progress_note ? `: ${j.progress_note}` : ''}.`));
    actions.push(say(`Resume the research on ${projectName}`), say(`Restart the research on ${projectName}`));
    if (key === 'interrupted') {
      const b = button('Cancel this run', null, { kind: 'small quiet' });
      b.setAttribute('aria-label', `Cancel the interrupted ${who} research for ${projectName}`);
      b.onclick = action(b, async () => {
        if (!window.confirm('Cancel this research run? Its draft is kept; nothing is deleted.')) return undefined;
        const r = await ctx.api.post(`/api/projects/${pid}/research/${run.run_id}/jobs/${prov}/cancel`, {});
        await ctx.refresh();
        return r;
      }, (r) => r.message || 'Canceled');
      actions.push(b);
    }
  }
  if (j.state === 'failed' || j.state === 'canceled') {
    const b = button('Retry', null, { kind: 'small' });
    b.onclick = action(b, async () => { const r = await ctx.api.post(`/api/projects/${pid}/research/${run.run_id}/jobs/${prov}/retry`, {}); await ctx.refresh(); return r; }, (r) => r.message || 'Retry queued');
    actions.push(b);
  }
  if (j.state === 'uncertain') {
    const b = button('Retry anyway', null, { kind: 'small', title: 'Sends a new request. The uncertain attempt may already have been billed and keeps counting until you reconcile it.' });
    b.setAttribute('aria-label', `Send a new ${PROVIDER_LABELS[prov]} request despite the uncertain attempt`);
    b.onclick = action(b, async () => {
      if (!window.confirm(`Send a new ${PROVIDER_LABELS[prov]} request? The earlier attempt may already have been billed; it keeps counting against your limits until you reconcile it, and the new attempt is reserved separately.`)) return undefined;
      const r = await ctx.api.post(`/api/projects/${pid}/research/${run.run_id}/jobs/${prov}/retry`, {});
      await ctx.refresh();
      return r;
    }, (r) => r.message || 'Retry queued');
    actions.push(b);
  }
  if (['queued', 'running', 'dispatching', 'uncertain', 'unconfigured'].includes(j.state) && !isAssistantJob(j)) {
    const b = button('Cancel', null, { kind: 'small quiet', title: 'Stops this job and its retries. A request already sent may still be billed.' });
    b.setAttribute('aria-label', `Cancel the ${PROVIDER_LABELS[prov]} job`);
    b.onclick = action(b, async () => {
      if (!window.confirm(`Cancel the ${PROVIDER_LABELS[prov]} job? A request already sent to the provider may still be billed.`)) return undefined;
      const r = await ctx.api.post(`/api/projects/${pid}/research/${run.run_id}/jobs/${prov}/cancel`, {});
      await ctx.refresh();
      return r;
    }, (r) => r.message || 'Canceled');
    actions.push(b);
  }
  if (j.report_id) actions.push(h('a', { class: 'btn small', href: `#/project/${pid}/reports?report=${encodeURIComponent(j.report_id)}` }, 'Open report'));
  const attempts = j.attempts || [];
  for (const a of attempts) if (reconcilable(j, a)) actions.push(reconcileForm(ctx, pid, run, prov, a));
  return {
    prov,
    state: key === 'waiting' && hosted ? h('div', { class: 'job-state' }, stateText('Waiting for you', st.tone), waitingStep(prov)) : stateText(st.long, st.tone),
    mode: h('span', { class: 'small' }, j.mode === 'manual' ? (hosted ? 'Its assistant\'s connection, or by hand' : 'By hand: paste the prompt, import the answer') : j.mode === 'cowork' ? 'Claude in Cowork' : j.mode === 'connector' ? `${PROVIDER_LABELS[prov]} through its desk connection` : j.mode === 'mock' ? 'Fictional demo adapter' : `API, in the background${j.model ? ` · ${j.model}` : ''}`),
    attempts: attempts.length ? h('div', { class: 'small' }, attempts.map((a) => {
      const cost = attemptCost(a);
      return h('div', null, `#${a.n} ${PHASE_TEXT[a.phase] || String(a.phase || a.outcome || 'in progress').replace(/_/g, ' ')}`, a.usage ? h('span', { class: 'faint' }, ` · ${a.usage.input_tokens ?? '?'} in / ${a.usage.output_tokens ?? '?'} out tokens`) : null, cost ? h('span', { class: a.phase === 'uncertain' ? null : 'faint' }, ` · ${cost}`) : null, a.response_sha256 ? h('span', { class: 'faint', title: `Raw response saved before normalization: ${a.response_path}` }, ` · response saved`) : null);
    })) : h('span', { class: 'faint small' }, 'None'),
    error: j.error ? h('span', { class: 'small', style: { color: 'var(--neg)' } }, j.error) : j.note ? h('span', { class: 'small muted' }, j.note) : null,
    actions: actions.length ? h('div', { class: 'btn-row' }, actions) : null,
  };
}

function researchTab(ctx, d, row) {
  const pid = d.project.project_id;
  const runs = d.research.runs || [];
  const runCards = runs.map((run) => {
    const copy = button('Copy prompt', null, { kind: 'small' });
    copy.onclick = action(copy, async () => { await copyText(await ctx.api.text(`/api/projects/${pid}/research/${run.run_id}/prompt`)); return undefined; });
    return card(h('span', { class: 'pill-row' }, h('span', null, `Run of ${fmtDateTime(run.created_at)}`), h('span', { class: 'small muted' }, (run.status || '').replace(/_/g, ' '))), [
      (table([
        { label: 'Model', render: (x) => PROVIDER_LABELS[x.prov] },
        { label: 'State', render: (x) => x.state },
        { label: 'Route', render: (x) => x.mode },
        { label: 'Attempts', render: (x) => x.attempts },
        { label: 'Note', wrap: true, render: (x) => x.error },
        { label: '', render: (x) => x.actions },
      ], run.providers.filter((p) => run.jobs[p]).map((p) => jobRow(ctx, pid, run, p, d.project.name)))),
      details('Run details', kv([
        ['Run ID', h('code', null, run.run_id)],
        ['Started by', `${run.created_by || '?'} via ${run.channel || '?'}`],
        run.utterance ? ['Request', `“${run.utterance}”`] : null,
        ['Rubric · profile · horizon', `${run.rubric_version} · ${run.sector_profile} · ${run.horizon ? run.horizon.text : '?'}`],
        ['Prompt', h('span', null, `${run.prompt.version}, identical for every model · SHA-256 ${run.prompt.sha256.slice(0, 12)}… `, copy)],
        ['Evidence packet', `captured ${fmtDateTime(run.evidence_packet.captured_at)} · SHA-256 ${run.evidence_packet.sha256.slice(0, 12)}… · no holdings, notes or other models' conclusions`],
      ]), { id: `run-${run.run_id}` }),
    ]);
  });
  const legacy = d.prompt_files || [];
  const id = d.project.identity;
  const website = input({ type: 'url', value: id.official_website || '', placeholder: 'https://…' });
  const cg = input({ value: id.coingecko_id || ((id.candidates || [])[0] || {}).coingecko_id || '', placeholder: 'CoinGecko listing ID' });
  const chain = input({ value: ((id.assets || [])[0] || {}).chain || '', placeholder: 'chain' });
  const contract = input({ value: ((id.assets || [])[0] || {}).contract_address || '', placeholder: 'contract / mint' });
  const ev = input({ type: 'url', placeholder: 'https://… official page that names the token' });
  const evNote = input({ placeholder: 'What it confirms' });
  const saveId = button('Save identity', null, { kind: 'small primary', type: 'submit' });
  const idForm = h('form', { class: 'form-grid', dataset: { key: 'identity-form' } }, field('Official website', website), field('CoinGecko listing ID', cg), field('Chain', chain), field('Contract / mint', contract), field('Evidence URL', ev), field('Evidence note', evNote), h('div', { class: 'field', style: { justifyContent: 'flex-end' } }, saveId));
  idForm.onsubmit = action(saveId, async () => {
    const r = await ctx.api.post(`/api/projects/${pid}/identity`, {
      official_website: website.value.trim() || null,
      coingecko_id: cg.value.trim() || null,
      assets: chain.value.trim() ? [{ chain: chain.value.trim(), contract_address: contract.value.trim() || null }] : [],
      evidence: ev.value.trim() ? [{ url: ev.value.trim(), note: evNote.value.trim() || null, kind: 'user' }] : [],
    });
    await ctx.refresh();
    return r;
  }, (r) => (r && r.identity_status === 'verified' ? 'Identity verified and bound' : 'Saved; identity still pending (needs website, token binding and evidence)'), { busyLabel: 'Saving…' });
  return h('div', null,
    card('Research runs', [
      h('p', { class: 'small muted', style: { margin: 0 } }, 'Each run sends every chosen model the same prompt, rubric, horizon and dated evidence packet. Jobs are independent: one failure never erases another model\'s result. Pending means not saved yet.'),
    ], { actions: [button(runs.length ? 'Run research again' : 'Run research', () => openResearchDialog(ctx, { ...row, ...d.project, research: row.research, report_count: d.reports.length }), { kind: 'small primary', key: 'rt-run' })] }),
    runs.length ? runCards : callout('No research runs yet.', 'info'),
    h('div', { class: 'grid two' },
      card('Token identity', [
        id.status === 'verified' ? callout('Verified: bound to the token below. Prices and holdings use this identity.', 'ok') : callout(`Pending: ${(id.unknowns || []).join(' ')} No prices or holdings use a pending identity.`, 'warn'),
        (id.evidence || []).length ? h('ul', { class: 'list small' }, id.evidence.map((e) => h('li', null, h('a', { href: e.url }, e.url), e.note ? ` — ${e.note}` : '', h('span', { class: 'faint' }, ` (checked ${fmtDate(e.checked_at)})`)))) : null,
        idForm,
      ]),
      card('Standing prompt files', [
        h('p', { class: 'small muted' }, 'Rebuilt when the scoring profile changes. Each research run also keeps its own exact prompt.'),
        (table([
          { label: 'File', render: (f) => h('code', { class: 'small' }, f.name) },
          { label: 'Version', render: (f) => h('span', { class: 'small' }, f.prompt_version || '?') },
          { label: 'Updated', render: (f) => fmtAgo(f.updated_at) },
          { label: '', render: (f) => { const b = button('Copy', null, { kind: 'small' }); b.setAttribute('aria-label', `Copy ${f.name}`); b.onclick = action(b, async () => { await copyText(await ctx.api.text(`/api/projects/${pid}/prompt-file?name=${encodeURIComponent(f.name)}`)); return undefined; }); return b; } },
        ], legacy, { empty: 'No prompt files.' })),
      ])));
}
