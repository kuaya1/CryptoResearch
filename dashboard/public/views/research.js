// Research across projects: research jobs, model comparison, evidence and the
// review calendar.
import {
  h, card, table, stateText, tagChip, gradeBadge, fmtNum, fmtDate, fmtAgo, select, field, fieldError, input, button, action, callout,
  tabStrip, safeSection, submissionId, waitingInstruction, PROVIDERS, PROVIDER_LABELS, onHoldOf,
} from '../ui.js';
import { comparisonBlock } from './project.js';

const TABS = [
  ['runs', 'Research jobs'],
  ['compare', 'Model comparison'],
  ['evidence', 'Evidence'],
  ['calendar', 'Calendar'],
];

export async function renderResearch(ctx, route) {
  const tab = TABS.some(([t]) => t === route.query.get('tab')) ? route.query.get('tab') : 'runs';
  const strip = tabStrip(TABS.map(([t, label]) => ({ id: t, label, href: `#/research?tab=${t}` })), tab, { label: 'Research sections' });
  const body = await safeSection(TABS.find(([t]) => t === tab)[1], () => ({ runs: runsTab, compare: compareTab, evidence: evidenceTab, calendar: calendarTab })[tab](ctx, route));
  return h('div', null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Research'), h('div', { class: 'sub' }, 'Independent Claude, ChatGPT and Gemini research, compared only where it is comparable.'))),
    strip,
    h('div', { id: 'tabpanel', role: 'tabpanel', 'aria-labelledby': `tab-${tab}` }, body));
}

function runsTab(ctx) {
  const idx = ctx.state.index;
  const r = idx.research || {};
  const projects = idx.projects.filter((p) => !p.broken && p.status !== 'archived');
  const runNow = button('Run queued jobs now', null, { kind: 'small' });
  runNow.onclick = action(runNow, async () => { await ctx.api.post('/api/research/run', {}); await ctx.refresh(); return true; }, 'Queued jobs processed (paid calls only within your budget)');
  const staleDays = idx.settings.freshness.research_stale_days || 90;
  const hosted = Boolean(ctx.state.session && ctx.state.session.hosted);
  // Three routes, in words: by itself on the API (in the background, within
  // your limits), through the model's own assistant (online desk), or by hand.
  const happens = (x) => {
    const who = PROVIDER_LABELS[x.p];
    if (x.s.mode === 'api') return `Runs by itself on the ${who} API in the background, within your limits. The report is saved when it finishes.`;
    if (x.s.mode === 'mock') return 'Returns fictional fixture reports in this demo workspace. No network call.';
    const missing = (x.s.missing || []).join(', ') || x.s.reason;
    return hosted
      ? `No API run (${missing}). Each run waits for you: ${waitingInstruction(x.p, { full: true })}. ${who} researches under its own plan and saves the report here. Or paste the prompt and import the answer.`
      : `No API set up (${missing}). Each run saves the prompt for you to paste into ${who}; the job completes when you import the answer.`;
  };
  return h('div', null,
    card('Research routes', table([
      { label: 'Model', render: (x) => h('strong', null, PROVIDER_LABELS[x.p]) },
      { label: 'Route', render: (x) => (x.s.mode === 'api' ? stateText(`API · ${x.s.model}`, 'ok') : x.s.mode === 'mock' ? stateText('Fictional demo adapter') : stateText(hosted ? 'Its assistant\'s connection' : 'By hand', 'warn')) },
      { label: 'What happens', wrap: true, render: (x) => h('span', { class: 'small' }, happens(x)) },
    ], PROVIDERS.map((p) => ({ p, s: (r.providers || {})[p] || { mode: 'manual', reason: 'unknown' } }))), {
      note: `Spend this month: $${(r.spend && r.spend.monthly) || 0} · today: $${(r.spend && r.spend.daily) || 0} · budget per run ${money(r.budget && r.budget.per_run_usd)}, day ${money(r.budget && r.budget.daily_usd)}, month ${money(r.budget && r.budget.monthly_usd)} · unattended runs ${r.unattended_enabled ? 'on' : 'off'}`,
      actions: [runNow, h('a', { class: 'btn small', href: '#/settings?tab=research' }, hosted ? 'API keys and limits' : 'Set up API access')],
    }),
    card('Latest research per project', table([
      { label: 'Project', render: (p) => h('a', { href: `#/project/${encodeURIComponent(p.project_id)}/research` }, p.name) },
      { label: 'Latest run', render: (p) => (p.research && p.research.latest_run ? h('div', null, stateText(sentence(p.research.latest_run.status), p.research.latest_run.status === 'completed' ? 'ok' : p.research.latest_run.status === 'failed' ? 'bad' : 'wait'), h('div', { class: 'small muted' }, `${fmtAgo(p.research.latest_run.created_at)} · ${p.research.latest_run.horizon ? p.research.latest_run.horizon.text : ''}`)) : h('span', { class: 'faint small' }, 'None')) },
      { label: 'Models', render: (p) => h('div', { class: 'grades' }, PROVIDERS.map((prov) => gradeBadge(prov, p.providers && p.providers[prov], p.research && p.research.providers && p.research.providers[prov], { staleDays, hosted, onHold: Boolean(onHoldOf(ctx.state.index, prov)) }))) },
      { label: 'Reports', num: true, render: (p) => String(p.report_count || 0) },
    ], projects, { empty: 'No projects yet.' }), { note: 'Each model\'s job is independent: a failure in one never erases another\'s result. Price refreshes never start research.' }));
}

function money(v) {
  return typeof v === 'number' ? `$${v}` : 'not set';
}

async function compareTab(ctx, route) {
  const idx = ctx.state.index;
  const category = route.query.get('category') || '';
  const projectId = route.query.get('project') || '';
  const opts = [{ value: '', label: 'All flagged items' }];
  const seen = new Set();
  for (const pr of idx.rubrics.profiles) for (const c of pr.diagnostic_categories) if (c.applicable !== false && !seen.has(c.id)) { seen.add(c.id); opts.push({ value: c.id, label: c.label }); }
  for (const c of idx.rubrics.grading.investment_components) if (!seen.has(c.id)) { seen.add(c.id); opts.push({ value: c.id, label: c.label }); }
  for (const r of idx.rubrics.grading.risk_scores) opts.push({ value: r.id, label: r.label });
  const sel = select(opts, { onchange: (e) => ctx.navigate(`#/research?tab=compare&category=${encodeURIComponent(e.target.value)}`) });
  sel.value = category;

  const rows = [];
  for (const p of idx.projects) {
    if (p.broken || !p.comparison) continue;
    const reports = Object.values(p.providers).filter(Boolean).length;
    if (reports < 1) continue;
    const matching = (p.comparison.rows || []).filter((r) => (category ? r.id === category : r.spread_flag));
    const flagged = matching.filter((r) => r.spread_flag);
    rows.push({ p, reports, matching, flagged });
  }
  rows.sort((a, b) => b.flagged.length - a.flagged.length || ((b.matching[0] && b.matching[0].spread) || 0) - ((a.matching[0] && a.matching[0].spread) || 0));
  const visible = category ? rows.filter((r) => r.matching.some((m) => m.spread !== null)) : rows;

  let detail = null;
  if (projectId) {
    try {
      const d = await ctx.projectDetail(projectId);
      detail = card(`${d.project.name}: side by side`, comparisonBlock(ctx, d, { showMedian: Boolean(idx.settings.comparison.show_median) }), { actions: [h('a', { href: `#/project/${encodeURIComponent(projectId)}/comparison` }, 'Open project')] });
    } catch (err) {
      detail = callout(err.message, 'bad');
    }
  }
  return h('div', null,
    card(null, h('div', { class: 'form-grid' }, field('Show disagreement on', sel, 'Token value capture appears as a diagnostic and as a component; both rows are shown'))),
    callout(`Only reports with the same rubric, profile and complete horizon interval, analyzed within ${idx.settings.comparison.date_window_days} days of each other, are compared. Three agreeing models are not three independent sources. Medians are descriptive, never a committee grade.`, 'info'),
    card('Projects', table([
      { label: 'Project', render: (r) => h('div', null, h('a', { href: `#/research?tab=compare&project=${encodeURIComponent(r.p.project_id)}${category ? `&category=${encodeURIComponent(category)}` : ''}` }, r.p.name), h('div', { class: 'small muted' }, `${r.reports} model${r.reports === 1 ? '' : 's'} with reports`)) },
      { label: 'Comparable', render: (r) => (r.p.comparison.comparable_providers.length >= 2 ? r.p.comparison.comparable_providers.map((x) => PROVIDER_LABELS[x]).join(', ') : h('span', { class: 'muted', title: r.p.comparison.reasons.join('\n') || 'Fewer than two comparable reports' }, 'Not comparable')) },
      { label: category ? 'Spread' : 'Flagged items', wrap: true, render: (r) => (r.matching.length ? h('div', { class: 'chips' }, r.matching.map((m) => h('span', { class: 'chip' }, `${m.label} (${m.section}) ${m.spread === null || m.spread === undefined ? 'n/a' : m.spread}`, m.spread_flag ? h('span', { class: 'sr-only' }, ', above the threshold') : null))) : h('span', { class: 'faint small' }, 'none')) },
      { label: 'Not compared', wrap: true, render: (r) => (r.p.comparison.reasons.length ? h('span', { class: 'small muted' }, r.p.comparison.reasons.join('; ')) : null) },
    ], visible, { empty: category ? 'No comparable reports have a value for that item yet.' : 'No projects with reports yet.' })),
    detail);
}

const evFilters = { project: '', tag: '', check: '', staleOnly: false };

function evidenceTab(ctx) {
  const idx = ctx.state.index;
  const ev = idx.evidence;
  const projects = idx.projects.filter((p) => !p.broken);
  const projSel = select([{ value: '', label: 'All projects' }, ...projects.map((p) => ({ value: p.project_id, label: p.name }))], { onchange: (e) => { evFilters.project = e.target.value; draw(); } });
  projSel.value = evFilters.project;
  const tagSel = select([{ value: '', label: 'All tags' }, { value: 'V', label: '[V] checked in analyst session' }, { value: 'C', label: '[C] project-claimed' }, { value: 'I', label: '[I] analyst inference' }, { value: 'S', label: '[S] speculative forecast' }], { onchange: (e) => { evFilters.tag = e.target.value; draw(); } });
  tagSel.value = evFilters.tag;
  const checkSel = select([{ value: '', label: 'Any dashboard check' }, 'not_checked', 'source_reachable', 'source_matches_claim', 'source_contradicts_claim', 'source_unavailable'], { onchange: (e) => { evFilters.check = e.target.value; draw(); } });
  checkSel.value = evFilters.check;
  const stale = h('input', { type: 'checkbox', onchange: (e) => { evFilters.staleOnly = e.target.checked; draw(); } });
  stale.checked = evFilters.staleOnly;
  const claimsHolder = h('div');
  const draw = () => {
    const rows = ev.claims.filter((c) => (!evFilters.project || c.project_id === evFilters.project) && (!evFilters.tag || c.evidence_tag === evFilters.tag) && (!evFilters.check || c.dashboard_check.status === evFilters.check) && (!evFilters.staleOnly || c.stale));
    claimsHolder.replaceChildren(table([
      { label: 'Project', render: (c) => h('a', { href: `#/project/${encodeURIComponent(c.project_id)}/evidence` }, c.project_name) },
      { label: 'From', render: (c) => PROVIDER_LABELS[c.provider] || c.provider },
      { label: 'Claim', wrap: true, render: (c) => h('div', null, c.text, c.limitation ? h('div', { class: 'small muted' }, `Limitation: ${c.limitation}`) : null) },
      { label: 'Analyst tag', render: (c) => tagChip(c.evidence_tag, c.evidence_tag_raw) },
      { label: 'Metric · period', render: (c) => (c.metric_id ? h('div', { class: 'small' }, h('code', null, c.metric_id), c.value !== null && c.value !== undefined ? ` ${fmtNum(c.value)} ${c.unit || ''}` : '', h('div', { class: 'muted' }, c.period || 'period unstated')) : null) },
      { label: 'As of', render: (c) => h('span', null, fmtDate(c.as_of), c.stale ? h('span', { class: 'freshness stale' }, ' · stale') : null) },
      { label: 'Sources', render: (c) => h('div', { class: 'small' }, c.sources.length ? c.sources.map((s) => h('div', null, s.url ? h('a', { href: s.url }, s.title || s.url) : s.source_id, s.source_type ? h('span', { class: 'faint' }, ` (${s.source_type})`) : null)) : h('span', { class: 'faint' }, 'none cited')) },
      { label: 'Your check', render: (c) => (c.dashboard_check.status === 'not_checked' ? h('span', { class: 'faint' }, 'Not checked') : stateText(sentence(c.dashboard_check.status), c.dashboard_check.status === 'source_matches_claim' ? 'ok' : c.dashboard_check.status === 'source_contradicts_claim' ? 'bad' : '')) },
      { label: 'Independent corroboration', render: (c) => (c.corroboration.status === 'none' ? h('span', { class: 'faint' }, 'None') : stateText(sentence(c.corroboration.status), c.corroboration.status === 'independently_corroborated' ? 'ok' : c.corroboration.status === 'contradicted' ? 'bad' : '')) },
    ], rows, { empty: 'No claims match. Claims come from the structured JSON block of each report.' }));
  };
  draw();
  const disputeProject = select(projects.map((p) => ({ value: p.project_id, label: p.name })));
  const disputeTopic = input({ placeholder: 'e.g. category:token_value_capture or metric:revenue_usd' });
  const disputeQ = input({ placeholder: 'The question that would settle it' });
  const disputeBtn = button('Add question', null, { kind: 'small', type: 'submit' });
  const disputeForm = h('form', { class: 'form-grid' }, field('Project', disputeProject), field('Topic', disputeTopic), field('Resolving question', disputeQ), h('div', { class: 'field' }, disputeBtn));
  disputeForm.onsubmit = action(disputeBtn, async () => { await ctx.api.post(`/api/projects/${encodeURIComponent(disputeProject.value)}/disputes`, { topic: disputeTopic.value || null, question: disputeQ.value }); await ctx.refresh(); return true; }, 'Question added');
  return h('div', null,
    callout('Three separate things: the analyst tag ([V] means the analyst checked it in their own session), your dashboard check (what you confirmed by opening the source), and independent corroboration (a different, independent source agrees). Opening an official statement is not verification of its substance.', 'info'),
    card('Contradictions and different measurement bases', table([
      { label: 'Project', render: (c) => h('a', { href: `#/project/${encodeURIComponent(c.project_id)}/comparison` }, c.project_name) },
      { label: 'Metric', render: (c) => h('code', null, c.metric_id) },
      { label: 'Finding', render: (c) => (c.kind === 'contradiction' ? stateText('Contradiction', 'bad') : sentence(c.kind)) },
      { label: 'A', wrap: true, render: (c) => h('div', null, `${PROVIDER_LABELS[c.a.provider]}: ${fmtNum(c.a.value)} ${c.a.unit || ''}`, h('div', { class: 'small muted' }, c.a.period || 'period unstated')) },
      { label: 'B', wrap: true, render: (c) => h('div', null, `${PROVIDER_LABELS[c.b.provider]}: ${fmtNum(c.b.value)} ${c.b.unit || ''}`, h('div', { class: 'small muted' }, c.b.period || 'period unstated')) },
    ], ev.contradictions, { empty: 'No conflicting numbers between models.' }), { note: 'A contradiction is the same metric, unit, period, definition and date with different values. Anything else is listed by its difference, not called a contradiction.' }),
    h('div', { class: 'grid two' },
      card('Sources cited by more than one model', table([
        { label: 'Project', render: (s) => h('a', { href: `#/project/${encodeURIComponent(s.project_id)}/evidence` }, s.project_name) },
        { label: 'Source', wrap: true, render: (s) => h('a', { href: s.url }, s.title || s.url) },
        { label: 'Cited by', render: (s) => s.providers.map((p) => PROVIDER_LABELS[p]).join(', ') },
      ], ev.shared_sources, { empty: 'No shared sources.' }), { note: 'Agreement built on the same source is not independent.' }),
      card('Unresolved questions', table([
        { label: 'Project', render: (q) => h('a', { href: `#/project/${encodeURIComponent(q.project_id)}` }, q.project_name) },
        { label: 'From', render: (q) => PROVIDER_LABELS[q.provider] || q.provider },
        { label: 'Question', wrap: true, key: 'question' },
      ], ev.unresolved, { empty: 'No open questions in the latest reports.' }))),
    card('Claims', [h('div', { class: 'form-grid', style: { marginBottom: '12px' }, dataset: { nodirty: '1' } }, field('Project', projSel), field('Analyst tag', tagSel), field('Dashboard check', checkSel), h('label', { class: 'check' }, stale, `Only stale (older than ${idx.settings.freshness.claim_stale_days} days)`)), claimsHolder], { note: `${ev.claims.length} claims · ${ev.stale_claims} stale. Record checks on each project's Evidence tab.` }),
    card('Your dispute questions', [
      table([
        { label: 'Project', render: (x) => h('a', { href: `#/project/${encodeURIComponent(x.project_id)}/evidence` }, x.project_name) },
        { label: 'Topic', render: (x) => (x.topic ? h('code', null, x.topic) : null) },
        { label: 'Question', wrap: true, key: 'question' },
        { label: 'Status', render: (x) => sentence(x.status) },
      ], ev.disputes, { empty: 'None yet.' }),
      projects.length ? h('div', { style: { marginTop: '12px' } }, disputeForm) : null,
    ]));
}

function whoCell(c) {
  return c.source === 'you' ? 'You' : PROVIDER_LABELS[c.provider] || c.provider;
}

function doneButton(ctx, c) {
  if (c.source !== 'you' || c.status !== 'open') return null;
  const b = button('Done', null, { kind: 'small' });
  b.onclick = action(b, async () => { await ctx.api.post(`/api/scopes/${encodeURIComponent(c.project_id || 'portfolio')}/events/${encodeURIComponent(c.event_id)}`, { status: 'done' }); await ctx.refresh(); return true; }, 'Marked done');
  return b;
}

function calendarTab(ctx) {
  const idx = ctx.state.index;
  const today = idx.today;
  const items = idx.calendar.filter((c) => c.status !== 'done' && c.status !== 'dismissed');
  const overdue = items.filter((c) => c.overdue);
  const dated = items.filter((c) => c.date && !c.overdue && c.type !== 'invalidator' && c.date >= today);
  const pastReport = items.filter((c) => c.date && c.date < today && c.source === 'report');
  const undated = items.filter((c) => !c.date && c.type !== 'invalidator');
  const invalidators = items.filter((c) => c.type === 'invalidator');
  const alerts = items.filter((c) => c.type === 'alert');
  const cols = [
    { label: 'Date', nowrap: true, render: (c) => (c.date ? `${fmtDate(c.date)}${c.precision && c.precision !== 'day' ? ` (${c.precision})` : ''}` : '—') },
    { label: 'Project', render: (c) => (c.project_id ? h('a', { href: `#/project/${encodeURIComponent(c.project_id)}` }, c.project_name) : c.project_name) },
    { label: 'Item', wrap: true, render: (c) => h('div', null, c.title, c.note ? h('div', { class: 'small muted' }, c.note) : null) },
    { label: 'Type', render: (c) => sentence(c.type) },
    { label: 'Status', render: (c) => (c.status ? sentence(c.status) : null) },
    { label: 'From', render: whoCell },
    { label: '', render: (c) => doneButton(ctx, c) },
  ];
  const scope = select([{ value: 'portfolio', label: 'Portfolio (not one project)' }, ...idx.projects.filter((p) => !p.broken && p.status !== 'archived').map((p) => ({ value: p.project_id, label: p.name }))]);
  const due = h('input', { type: 'date', 'aria-label': 'Due date' });
  const title = input({ value: 'Review thesis' });
  const btn = button('Add review', null, { kind: 'primary small', type: 'submit' });
  const form = h('form', { class: 'form-grid' }, field('For', scope), field('Due date', due, 'America/New_York calendar day'), field('Title', title), h('div', { class: 'field' }, btn));
  const sid = submissionId();
  const add = action(btn, async () => {
    await ctx.api.post(`/api/scopes/${encodeURIComponent(scope.value)}/events`, { type: 'review', title: title.value, due: due.value, submission_id: sid });
    await ctx.refresh();
    return true;
  }, 'Review added');
  due.addEventListener('input', () => fieldError(due, null));
  form.onsubmit = (e) => {
    e.preventDefault();
    if (!due.value) return fieldError(due, 'Pick a date.');
    return add();
  };
  return h('div', null,
    h('p', { class: 'small muted' }, `Today is ${fmtDate(today)} in America/New_York. Your reviews and alerts plus catalysts, unlocks and invalidators from the latest reports.`),
    overdue.length ? card('Overdue', table(cols, overdue), { note: 'Your own reviews past their due date.' }) : h('p', { class: 'small muted' }, 'Nothing overdue.'),
    card('Upcoming', table(cols, dated, { empty: 'No dated items ahead.' }), { note: 'Unlocks are potential liquid supply, not demonstrated selling.' }),
    card('Add a review', form, { note: 'Or ask Cowork: "set a review for HUMA next Friday".' }),
    h('div', { class: 'grid two' },
      card('Thesis invalidators being monitored', table([
        { label: 'Project', render: (c) => h('a', { href: `#/project/${encodeURIComponent(c.project_id)}` }, c.project_name) },
        { label: 'Invalidator', wrap: true, key: 'title' },
        { label: 'From', render: whoCell },
      ], invalidators, { empty: 'No invalidators in the latest reports.' })),
      card('Price alerts', table([
        { label: 'Project', render: (c) => (c.project_id ? h('a', { href: `#/project/${encodeURIComponent(c.project_id)}` }, c.project_name) : c.project_name) },
        { label: 'Alert', render: (c) => c.title },
        { label: '', render: (c) => doneButton(ctx, c) },
      ], alerts, { empty: 'No alerts. Add them on a project\'s Notes & history tab.' }), { note: 'Shown on the dashboard only. No external notifications are configured.' })),
    undated.length ? card('Catalysts without a date', table(cols, undated)) : null,
    pastReport.length ? card('Past dates from reports', table(cols, pastReport), { note: 'Dates reported in earlier analyses that have passed. A new report should say what happened.' }) : null);
}

function sentence(s) {
  const t = String(s || '').replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
