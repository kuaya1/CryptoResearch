// Research across projects: research jobs, model comparison and evidence.
// The review calendar is Review > Upcoming, and each model's route, keys and
// limits are Preferences > Models & budget (DESIGN_AND_IA_BLUEPRINT.md §3.5).
import {
  h, card, table, stateText, tagChip, gradeBadge, fmtNum, fmtDate, fmtDateTime, fmtAgo, select, field, input, button, action, callout,
  tabStrip, safeSection, waitingInstruction, PROVIDERS, PROVIDER_LABELS, onHoldOf, link, plural, submissionId, details, priceSpark, fmtChangePct,
} from '../ui.js';
import { comparisonBlock } from './project.js';
import { stepWord, exitCell, deltaText } from '../pilot-board-model.js';
import { splitPositions, returnWords, excursionWords, summaryLine, shadowRows, shadowCounts, shadowCohortLines } from '../paper-model.js';
import * as TB from '../trader-book-model.js';

const TABS = [
  ['runs', 'Research jobs'],
  ['compare', 'Model comparison'],
  ['evidence', 'Evidence'],
  ['outcomes', 'Outcomes'],
  ['scout', 'Scout'],
];

export async function renderResearch(ctx, route) {
  const tab = TABS.some(([t]) => t === route.query.get('tab')) ? route.query.get('tab') : 'runs';
  const strip = tabStrip(TABS.map(([t, label]) => ({ id: t, label, href: `#/research?tab=${t}` })), tab, { label: 'Research sections' });
  const body = await safeSection(TABS.find(([t]) => t === tab)[1], () => ({ runs: runsTab, compare: compareTab, evidence: evidenceTab, outcomes: outcomesTab, scout: scoutTab })[tab](ctx, route));
  return h('div', null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Research'))),
    strip,
    h('div', { id: 'tabpanel', role: 'tabpanel', 'aria-labelledby': `tab-${tab}` }, body));
}

async function runsTab(ctx) {
  const idx = ctx.state.index;
  const r = idx.research || {};
  const projects = idx.projects.filter((p) => !p.broken && p.status !== 'archived');
  const runNow = button('Run queued jobs now', null, { kind: 'small' });
  runNow.onclick = action(runNow, async () => { await ctx.api.post('/api/research/run', {}); await ctx.refresh(); return true; }, 'Queued jobs processed (paid calls only within your budget)');
  const staleDays = idx.settings.freshness.research_stale_days || 90;
  const hosted = Boolean(ctx.state.session && ctx.state.session.hosted);
  // Each model's route in full is in Preferences > Models & budget; its
  // name, the spend, the limits and the queued jobs stay here.
  const routes = PROVIDERS.map((p) => `${PROVIDER_LABELS[p]}: ${routeWords(idx, p, (r.providers || {})[p] || { mode: 'manual', reason: 'unknown' }, { hosted }).route}`).join(' · ');
  const jobs = h('div', null,
    card('Latest research per project', h('div', { class: 'rs-latest' }, table([
      { label: 'Project', render: (p) => h('a', { href: `#/project/${encodeURIComponent(p.project_id)}/evidence?open=runs` }, p.name) },
      { label: 'Latest run', render: (p) => (p.research && p.research.latest_run ? h('div', null, stateText(sentence(p.research.latest_run.status), p.research.latest_run.status === 'completed' ? 'ok' : p.research.latest_run.status === 'failed' ? 'bad' : 'wait'), h('div', { class: 'small muted' }, `${fmtAgo(p.research.latest_run.created_at)} · ${p.research.latest_run.horizon ? p.research.latest_run.horizon.text : ''}`)) : h('span', { class: 'faint small' }, 'No run yet')) },
      { label: 'Models', render: (p) => h('div', { class: 'grades' }, PROVIDERS.map((prov) => gradeBadge(prov, p.providers && p.providers[prov], p.research && p.research.providers && p.research.providers[prov], { staleDays, hosted, onHold: Boolean(onHoldOf(ctx.state.index, prov)) }))) },
      { label: 'Reports', num: true, render: (p) => String(p.report_count || 0) },
    ], projects, { empty: 'No projects yet.' })), {
      note: `Each model's job is independent: a failure in one never erases another's result. Price refreshes never start research. ${routes}. Spend this month: $${(r.spend && r.spend.monthly) || 0} · today: $${(r.spend && r.spend.daily) || 0} · budget per run ${money(r.budget && r.budget.per_run_usd)}, day ${money(r.budget && r.budget.daily_usd)}, month ${money(r.budget && r.budget.monthly_usd)} · unattended runs ${r.unattended_enabled ? 'on' : 'off'}`,
      actions: [runNow, h('a', { class: 'btn small', href: ctx.hrefWith ? ctx.hrefWith({ prefs: 'models' }) : '#/settings?tab=research', dataset: { key: 'research-routes' } }, hosted ? 'Routes, API keys and limits' : 'Routes and API access')],
    }));
  // The two reads go together, so a busy desk costs one wait, not two (L3).
  const [pilot, exits] = await Promise.all([pilotBoard(ctx), exitMatrix(ctx)]);
  return h('div', null, jobs, pilot, exits);
}

// The Track 2 pilot queue (item 54, GET /api/tickets/candidates): each
// candidate's grade, the @5 to @6 change, the $500 and $2,000 exit readings,
// the pipeline step and Eric's pilot switch. Reading it writes nothing; only
// the toggle posts, from its own click.
async function pilotBoard(ctx) {
  let b;
  try {
    b = await ctx.api.get('/api/tickets/candidates');
  } catch (_) {
    return card('Track 2 Pilot Queue', h('p', { class: 'muted' }, 'The pilot queue could not be read.'));
  }
  const rows = b.rows || [];
  const cycleOut = h('div', { role: 'status', class: 'pilot-cycle' });
  const cycleButton = runCycleButton(ctx, cycleOut);
  let gates = [];
  try { gates = (await ctx.api.get('/api/tickets/desk-gates')).waiting || []; } catch (_) { gates = []; }
  return card(`Track 2 Pilot Queue (${rows.length})`, [pagedTable([
    { label: 'Project', render: (r) => h('a', { href: `#/project/${encodeURIComponent(r.project_id)}/forensics` }, r.name) },
    { label: 'Grade', num: true, render: (r) => h('span', { class: 'num' }, r.grade_display || '—') },
    { label: '@5 → @6', render: (r) => { const d = deltaText(r.report_delta); return h('span', { class: 'small', title: d.title }, d.text); } },
    { label: 'Exit readiness', render: (r) => h('div', { class: 'small' }, (r.exits || []).map((e) => { const c = exitCell(e); return h('div', { class: c.tone, title: c.title }, c.text); })) },
    { label: 'Step', render: (r) => h('span', { title: r.step_why || null }, stepWord(r.step)) },
    { label: 'Pilot', render: (r) => {
      const btn = button(r.in_pilot ? 'Turn off' : 'Turn on', null, { kind: 'small' });
      btn.dataset.key = `pilot-board-${r.project_id}`;
      btn.setAttribute('aria-pressed', String(Boolean(r.in_pilot)));
      btn.onclick = action(btn, async () => { await ctx.api.post(`/api/projects/${encodeURIComponent(r.project_id)}/tickets/pilot`, { on: !r.in_pilot }); await ctx.refresh(); return true; }, r.in_pilot ? 'Pilot off for this project' : 'Pilot on for this project');
      return btn;
    } },
  ], rows, { size: 25, label: 'Pilot candidates', empty: 'No verified, active projects yet.' }), deskGateBar(ctx, gates), cycleOut], { note: 'Verified, active projects: held first, then by grade. Reading this writes nothing.', actions: [cycleButton] });
}

// Run the pilot cycle from the desk (item 71, POST /api/tickets/run-cycle):
// the dry run's counts and names first (a read, nothing sent), then the run
// with `expect` (the counts shown), then the receipt's counts and the next
// steps for Agent 1, Agent 2 and Eric. It starts no research and calls no model.
const names = (list) => (list || []).map((x) => x.name || x.project_id);
function cycleLines(r) {
  const s = r.steps || {};
  return [
    ['Enter the pilot', names(s.auto_pilot_sync && s.auto_pilot_sync.opted_in)],
    ['Desk gates made', names(s.batch_gate && s.batch_gate.made)],
    ['Exit quotes asked', names(s.quote_candidates && s.quote_candidates.quoted)],
  ];
}
function runCycleButton(ctx, out) {
  const btn = button('Run pilot cycle', null, { kind: 'small' });
  btn.dataset.key = 'pilot-cycle';
  btn.onclick = action(btn, async () => {
    const plan = await ctx.api.post('/api/tickets/run-cycle', { dry_run: true });
    const c = plan.counts || {};
    const confirm = button('Run the cycle', null, { kind: 'primary', key: 'pilot-cycle-confirm' });
    confirm.onclick = action(confirm, async () => {
      const done = await ctx.api.post('/api/tickets/run-cycle', { expect: { opted_in: c.opted_in ?? 0, gates_made: c.gates_made ?? 0, quoted: c.quoted ?? 0 } });
      const n = done.next || {};
      const dc = done.counts || {};
      out.replaceChildren(
        h('p', null, `Entered the pilot: ${dc.opted_in ?? 'unknown'} · desk gates made: ${dc.gates_made ?? 'unknown'} · exit quotes: ${dc.quoted ?? 'unknown'}${dc.errors ? ` · ${plural(dc.errors, 'step')} could not run` : ''}.`),
        h('ul', null,
          h('li', null, `Agent 1 (research): ${names(n.agent1_research).join(', ') || 'none'}`),
          h('li', null, `Agent 2 (ticket): ${names(n.agent2_ticket).join(', ') || 'none'}`),
          h('li', null, `For you: ${names(n.for_eric).join(', ') || 'none'}`)),
        (done.errors || []).length ? callout((done.errors || []).map((e) => `${e.step}: ${e.message}`).join(' '), 'bad') : null);
      await ctx.refresh();
      return done;
    }, null);
    out.replaceChildren(
      h('p', null, 'The cycle would do this now. No research starts and no model is called.'),
      h('ul', null, cycleLines(plan).map(([label, list]) => h('li', null, `${label} (${list.length}): ${list.join(', ') || 'none'}`))),
      confirm);
    return undefined;
  }, null);
  return btn;
}

// Decide the desk's $0 gates together (item 70, POST
// /api/tickets/desk-gates/decide): each button shows the dry run's names
// first (a read), then posts with `expect` (the receipt IDs shown), then says
// each project's result. Every decision is the card's own: journal, Undo.
function deskGateBar(ctx, gates) {
  if (!gates.length) return null;
  const out = h('div', { role: 'status' });
  const start = (verb, act) => {
    const b = button(`${verb} all ${gates.length}`, null, { kind: 'small' });
    b.dataset.key = `desk-gates-${act}`;
    b.onclick = action(b, async () => {
      const plan = await ctx.api.post('/api/tickets/desk-gates/decide', { action: act, dry_run: true, expect: gates.map((g) => g.receipt_id) });
      const shown = plan.decided || [];
      const confirm = button(`${verb} ${shown.length} desk ${shown.length === 1 ? 'gate' : 'gates'}`, null, { kind: 'primary', key: `desk-gates-${act}-confirm` });
      const sid = submissionId();
      confirm.onclick = action(confirm, async () => {
        const done = await ctx.api.post('/api/tickets/desk-gates/decide', { action: act, expect: shown.map((d) => d.receipt_id), request_id: sid });
        out.replaceChildren(
          h('p', null, `${plural(done.decided.length, 'desk gate')} ${act === 'pass' ? 'passed' : 'kept on watch'}.`),
          h('ul', null, done.decided.map((d) => h('li', null, `${d.name}: ${d.status === 'saved' ? 'decided' : d.status}${act === 'pass' ? (d.archived ? ', archived' : ', not archived') : ''}`))),
          done.failed ? callout(`Stopped at ${done.failed.name}: ${done.failed.error}. Not yet decided: ${done.remaining.map((x) => x.name).join(', ') || 'none'}. Run it again to complete them.`, 'bad') : null);
        await ctx.refresh();
        return done;
      }, null);
      out.replaceChildren(
        h('p', null, `${verb} ${plural(shown.length, 'desk gate')}? Each is its own decision, with Undo.`),
        h('ul', null, shown.map((d) => h('li', null, act === 'pass' ? `${d.name}: ${d.would_archive ? 'would be archived' : d.held === true ? 'held, stays watched' : 'not archived'}` : d.name))),
        confirm);
      return undefined;
    }, null);
    return b;
  };
  return h('div', { class: 'desk-gates' }, h('div', { class: 'actions' }, start('Watch', 'watch'), start('Pass', 'pass')), out);
}

// The exit-liquidity matrix (item 61, GET /api/tickets/exit-matrix): every
// verified, active project's $500 and $2,000 exit cost with its completeness,
// chain, the quote's age and the native L1 status. Reading it writes nothing.
async function exitMatrix(ctx) {
  let m;
  try {
    m = await ctx.api.get('/api/tickets/exit-matrix');
  } catch (_) {
    return card('Exit Matrix', h('p', { class: 'muted' }, 'The exit matrix could not be read.'));
  }
  const rows = m.rows || [];
  const costCell = (r, size) => {
    if (r.native_l1_liquid) return h('span', { class: 'faint', title: 'Native L1: no DEX quote is needed.' }, 'Native L1');
    const e = (r.exits || []).find((x) => x.size_usd === size);
    if (!e || typeof e.cost_pct !== 'number') return h('span', { class: 'faint', title: (e && e.note) || 'No exit reading.' }, 'No reading');
    const missing = e.missing_costs && e.missing_costs.length ? `at least ${e.cost_pct}%` : `${e.cost_pct}%`;
    return h('span', { class: 'num', title: e.complete === false ? `Not complete: ${(e.missing_costs || []).join(', ') || 'a cost is unknown'}` : 'Complete' }, e.complete === false ? `≥ ${e.cost_pct}%` : missing);
  };
  const ageCell = (r) => {
    const ages = (r.exits || []).map((e) => e.quote_age_minutes).filter((x) => typeof x === 'number');
    if (r.native_l1_liquid || !ages.length) return h('span', { class: 'faint' }, '—');
    const a = Math.max(...ages);
    return h('span', { class: 'small' }, a >= 120 ? `${Math.round(a / 60)} h` : `${a} min`);
  };
  return card(`Exit Matrix (${rows.length})`, pagedTable([
    { label: 'Project', render: (r) => h('a', { href: `#/project/${encodeURIComponent(r.project_id)}/forensics?fx=exits` }, r.name) },
    { label: 'Grade', num: true, render: (r) => h('span', { class: 'num' }, r.grade_display || '—') },
    { label: 'Chain', render: (r) => h('span', { class: 'small' }, r.chain || '—') },
    ...((m.sizes_usd || [500, 2000]).map((sz) => ({ label: `$${sz.toLocaleString('en-US')} exit`, num: true, render: (r) => costCell(r, sz) }))),
    { label: 'Quote age', render: ageCell },
    { label: 'Native L1', render: (r) => h('span', { class: 'small' }, r.native_l1_liquid ? 'Liquid' : 'No') },
  ], rows, { size: 25, label: 'Exit matrix', empty: 'No verified, active projects yet.' }), { note: 'Verified, active projects by grade. A cost marked ≥ is a lower bound: a component is unknown. Reading this writes nothing.' });
}

// What happened after each report (core/report-outcomes.js): each model's
// counts at 30, 60, 90 and 120 days, a median against BTC only from enough
// matured reports, then every report's own row. Fixed model order; never a
// ranking or a winner.
const pctText = (x) => (typeof x === 'number' ? `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(2)}%` : '—');
function horizonCell(h) {
  if (!h) return h_('—');
  if (h.status === 'pending') return h_(`Due ${fmtDate(h.due)}`, 'faint', `Measured on ${fmtDate(h.due)}`);
  if (h.status === 'no_price') return h_('No price', 'faint', h.reason);
  return h_(pctText(h.vs_btc_pct), h.vs_btc_pct > 0 ? 'pos' : h.vs_btc_pct < 0 ? 'neg' : '', `${pctText(h.return_pct)} against BTC's ${pctText(h.btc_return_pct)}, ${fmtDate(h.at)}`);
}
function h_(text, cls = '', title = null) {
  return h('span', { class: `num ${cls}`.trim(), title }, text);
}
async function outcomesTab(ctx) {
  // The digest, the paper book and the outcomes are read together (L3), and
  // the paper book stays readable when the outcomes cannot be read (L7).
  const digest = digestBar(ctx);
  const paper = paperCard(ctx);
  const trader = traderCard(ctx);
  let o;
  try {
    o = await ctx.api.get('/api/research/outcomes');
  } catch (err) {
    return h('div', null, await digest, await paper, await trader, card('After each report', h('p', { class: 'muted' }, `The report outcomes could not be read: ${err.message}`)));
  }
  const days = o.horizons_days || [30, 60, 90, 120];
  const models = card('By model', table([
    { label: 'Model', render: (m) => h('strong', null, PROVIDER_LABELS[m.provider]) },
    { label: 'Reports', num: true, render: (m) => String(m.reports) },
    ...days.map((d) => ({ label: `${d} days`, render: (m) => {
      const x = m.horizons.find((y) => y.days === d);
      if (!x) return '—';
      return h('div', { title: x.note || `Median against BTC over ${x.matured} matured reports; ${x.beat_btc} beat BTC` },
        x.median_vs_btc_pct === null ? h('span', { class: 'faint' }, `${x.matured} matured${x.pending ? ` · ${x.pending} pending` : ''}`) : h('span', null, h('span', { class: 'num' }, pctText(x.median_vs_btc_pct)), h('span', { class: 'small muted' }, ` · ${x.beat_btc} of ${x.matured} beat BTC`)));
    } })),
  ], o.models), { note: o.meaning });
  const rows = o.reports.slice().sort((a, b) => String(b.start.at || '').localeCompare(String(a.start.at || '')) || a.name.localeCompare(b.name));
  const list = card('After each report', pagedTable([
    { label: 'Project', render: (r) => h('a', { href: `#/project/${encodeURIComponent(r.project_id)}/market` }, r.name) },
    { label: 'Model', render: (r) => PROVIDER_LABELS[r.provider] || r.provider },
    { label: 'Verdict', render: (r) => h('span', { class: 'small' }, r.verdict ? r.verdict.charAt(0) + r.verdict.slice(1).toLowerCase() : '—') },
    { label: 'Grade', render: (r) => h('span', { class: 'num', title: r.grade && r.grade.reason ? r.grade.reason : null }, r.grade ? (r.grade.display || (r.grade.status === 'withheld' ? 'Withheld' : '—')) : '—') },
    { label: 'Start', render: (r) => h('span', { class: 'small', title: r.note || (r.start.basis === 'run_packet' ? "When the research run's evidence packet was captured" : 'When the report was saved (it answers no run)') }, r.start.project ? `${fmtDate(r.start.at)}` : 'No price') },
    ...days.map((d) => ({ label: `${d}d vs BTC`, num: true, render: (r) => horizonCell(r.horizons.find((x) => x.days === d)) })),
  ], rows, { size: 50, label: 'Report outcomes', empty: 'No eligible reports yet.' }));
  return h('div', null, await digest, await paper, await trader, models, list);
}

// The seven-day desk telemetry (tickets.digest): @6 reports completed,
// Prosecutor tickets against desk-gate passes, invalidations fired and tickets
// waiting on a repair. A part the desk could not read is said, never zero.
async function digestBar(ctx) {
  let d;
  try {
    d = await ctx.api.get('/api/tickets/digest');
  } catch (_) {
    return card('7-Day Desk Telemetry', h('p', { class: 'muted' }, 'The digest could not be read.'));
  }
  const cell = (label, sec, value, title) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '140px' }, title: sec.status === 'ok' ? title : sec.why },
    h('span', { class: 'small muted' }, label), h('strong', { class: 'num' }, sec.status === 'ok' ? String(value) : 'Unreadable'));
  const r = d.reports_v6; const t = d.tickets; const i = d.invalidations; const rp = d.ticket_repairs || { status: 'unreadable', why: 'Not reported.' };
  return card('7-Day Desk Telemetry', h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '24px' } },
    cell(`${r.prompt || '@6'} reports completed`, r, r.completed, `${r.eligible} eligible`),
    cell('Prosecutor tickets', t, t.prosecutor_tickets, 'Saved in the window'),
    cell('Desk-gate passes', t, t.desk_gate_passes, 'Saved in the window'),
    cell('Invalidations fired', i, i.fired, i.note),
    cell('Ticket repairs', rp, rp.count, rp.note)));
}

// The paper book (core/paper.js): PM-approved tickets as paper positions,
// apart from the portfolio. No total or median before 20 have closed.
async function paperCard(ctx) {
  let b;
  try {
    b = await ctx.api.get('/api/paper');
  } catch (_) {
    return card('PM Cohort', h('p', { class: 'muted' }, 'The PM Cohort could not be read.'));
  }
  const ret = (x) => {
    const r = returnWords(x);
    return h('span', r.text === '—' ? { class: 'faint', title: r.title } : { class: `num ${r.tone}`.trim(), title: r.title }, r.text);
  };
  const excursionCell = (x, which) => {
    const e = excursionWords(x, which);
    return h('span', e.text === '—' ? { class: 'faint', title: e.title } : { class: `num ${e.tone}`.trim(), title: e.title }, e.text);
  };
  const stateWord = { open: 'Open', closed: 'Closed', voided: 'Voided' };
  const cols = [
    { label: 'Project', render: (x) => h('a', { href: `#/project/${encodeURIComponent(x.project_id)}/market` }, x.name || x.project_id) },
    { label: 'Risk', num: true, render: (x) => h('span', { class: 'num' }, `$${Number(x.risk_usd).toLocaleString('en-US')}`) },
    { label: 'Entry', render: (x) => x.entry.status === 'priced' ? h('span', { class: 'num', title: `Hourly reading ${fmtDate(x.entry.at)}; entry cost unknown` }, `$${x.entry.price_usd}`) : h('span', { class: 'faint', title: x.entry.reason }, 'No entry price') },
    { label: 'State', render: (x) => h('span', { title: x.close ? x.close.words : x.reason || null }, stateWord[x.state] || x.state) },
    { label: 'Return', num: true, render: ret },
    { label: 'MFE', num: true, render: (x) => excursionCell(x, 'mfe') },
    { label: 'MAE', num: true, render: (x) => excursionCell(x, 'mae') },
  ];
  const parts = splitPositions(b);
  const group = (title, rows, label) => h('div', null,
    h('h3', { class: 'small' }, `${title} (${rows.length})`),
    pagedTable(cols, rows, { size: 25, label, empty: `No ${title.toLowerCase()} positions.` }));
  const positions = h('div', null, group('Open', parts.open, 'Open paper positions'), group('Closed', parts.closed, 'Closed paper positions'),
    parts.voided.length ? h('details', null, h('summary', null, `Voided (${parts.voided.length})`), table(cols, parts.voided, { empty: '' })) : null);
  const sc = shadowCounts(b);
  const shadow = h('div', null,
    h('p', { class: 'small muted' }, `${sc.total} receipts took no risk · the price rose after ${sc.rose} of ${sc.measured} measured${sc.unknown ? ` · ${sc.unknown} unknown` : ''}. A fact about the price since each receipt, not a verdict on the gate.`),
    ...shadowCohortLines(b).map((line) => h('p', { class: 'small muted' }, line)),
    pagedTable([
      { label: 'Project', render: (x) => h('a', { href: `#/project/${encodeURIComponent(x.project_id)}/forensics` }, x.name) },
      { label: 'Receipt', render: (x) => h('span', { class: 'small', title: x.line }, `${x.kind === 'desk_gate' ? 'Desk gate' : 'Zero risk'}${x.proposal_type ? ` · ${x.proposal_type}` : ''} · ${fmtDate(x.saved_at)}`) },
      { label: 'Day 30', num: true, render: (x) => h('span', { class: `num ${x.day30_tone}`.trim(), title: x.day30_title }, x.day30_text) },
      { label: 'Day 30 vs BTC', num: true, render: (x) => h('span', { class: 'num', title: x.day30_title }, x.day30_vs_btc_text) },
      { label: 'Price since saved', num: true, render: (x) => h('span', { class: `num ${x.tone}`.trim(), title: x.title }, x.change_text) },
      { label: 'Against BTC', num: true, render: (x) => h('span', { class: 'num', title: x.title }, x.vs_btc_text) },
    ], shadowRows(b), { size: 25, label: 'Shadow gate', empty: 'No receipts without risk yet.' }));
  const body = h('div', null, positions);
  const toggle = button('Shadow ($0 gate passes)', null, { kind: 'small' });
  toggle.setAttribute('aria-pressed', 'false');
  toggle.onclick = () => {
    const on = toggle.getAttribute('aria-pressed') !== 'true';
    toggle.setAttribute('aria-pressed', String(on));
    body.replaceChildren(on ? shadow : positions);
  };
  return card('PM Cohort', h('div', null,
    h('p', { class: 'small muted' }, summaryLine(b)),
    body,
  ), { note: b.meaning, actions: [toggle] });
}

// The trader's Paper Book (slot 12c; trader-desk.js view through
// GET /api/paper/trader, its version named by the book): what an order
// would have done, with fills, fees, slippage and stops, beside the PM Paper
// Book above and never added to it.
// Read only: nothing here asks the book or the hourly read for anything.
async function traderCard(ctx) {
  const title = 'Trader Sim';
  let v;
  try {
    v = await ctx.api.get('/api/paper/trader');
  } catch (err) {
    return card(title, h('p', { class: 'muted' }, `The Trader Sim could not be read: ${err.message}`));
  }
  const usd = (w) => h('span', { class: `num ${w.tone || ''}`.trim(), title: w.title || null, dataset: w.exact ? { exact: w.exact } : null }, w.text);
  const amt = (s) => { const w = TB.amountWords(s); return h('span', { class: 'num', title: w.exact, dataset: w.exact ? { exact: w.exact } : null }, w.text); };
  const proj = (x) => (x.project_id ? h('a', { href: `#/project/${encodeURIComponent(x.project_id)}/market` }, x.project || x.project_id) : h('span', { class: 'faint' }, '—'));
  const state = (w, title = null) => h('span', { title }, stateText(w.text, w.tone));
  const said = (text) => { const w = TB.sentenceWords(text); return h('span', { class: 'small', title: w.title }, w.text); };
  const sub = (text, n) => h('h3', { class: 'small' }, `${text} (${n})`);

  // The NAV line scales to its own range, so its change is said beside it.
  const cell = (label, ...body) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '120px' } }, h('span', { class: 'small muted' }, label), ...body);
  const line = TB.navLine(v);
  const change = line.length > 1 && line[0] ? ((line[line.length - 1] - line[0]) / line[0]) * 100 : null;
  const spark = line.length > 1 ? cell(`NAV, ${plural(line.length, 'hour')}`,
    h('strong', { class: `num ${change > 0 ? 'pos' : change < 0 ? 'neg' : ''}`.trim() }, fmtChangePct(change)),
    priceSpark(line, change, { width: 160, height: 32, label: `NAV over ${plural(line.length, 'closed hour')}` })) : null;
  const facts = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '24px' } },
    ...TB.bookFacts(v).map((f) => cell(f.label, h('strong', null, usd(f)))), spark);
  const waits = v.waits && v.waits.length ? h('p', { class: 'small' }, v.waits.join(' '), ' ', link('Open Preferences > Screening', '#/research?tab=outcomes&prefs=screening')) : null;
  const st = TB.settlementWords(v);
  const unsettled = st.unsettled ? callout(`Unsettled: ${TB.sentenceWords(st.text).text} No new order is asked until it settles.`, 'warn') : null;

  const requests = v.requests.slice().sort((a, b) => String(b.decided_at || '').localeCompare(String(a.decided_at || '')));
  const reqTable = pagedTable([
    { label: 'Project', render: proj },
    { label: 'Decision', render: (r) => h('span', { title: `${r.in_force ? 'In force' : 'No longer in force'} · decided ${fmtDateTime(r.decided_at)}` }, `${TB.decisionWords(r)} · ${fmtDate(r.decided_at)}`) },
    { label: 'Pair', render: (r) => h('span', { class: 'small' }, r.pair || '—') },
    { label: 'State', render: (r) => state(TB.phaseWords(r.phase)) },
    { label: 'What happened', wrap: true, render: (r) => said(r.words) },
  ], requests, { size: 25, label: 'Trader requests', empty: 'No approve or halve has asked the book yet.' });

  const open = v.results.open_positions;
  const closed = v.results.closed_positions;
  const posTable = table([
    { label: 'Project', render: proj },
    { label: 'Pair', render: (p) => h('span', { class: 'small' }, p.pair) },
    { label: 'Quantity', num: true, render: (p) => amt(p.quantity) },
    { label: 'Entry (USD)', num: true, render: (p) => amt(p.entry_price) },
    { label: 'Stop (USD)', num: true, render: (p) => amt(p.stop_loss_price) },
    { label: 'Target (USD)', num: true, render: (p) => amt(p.take_profit_price) },
    { label: 'Value', num: true, render: (p) => usd(TB.usdWords(p.value_usd, 'No hourly price within the book\'s freshness, so its value is unknown.')) },
    { label: 'Unrealized', num: true, render: (p) => usd(TB.pnlWords(p.unrealized_pnl_usd, 'Its value is unknown.')) },
  ], open, { empty: 'No open positions.' });
  const closedTable = table([
    { label: 'Project', render: proj },
    { label: 'Pair', render: (p) => h('span', { class: 'small' }, p.pair) },
    { label: 'Exit', render: (p) => (p.exit_words ? said(p.exit_words) : h('span', { class: 'faint' }, '—')) },
    { label: 'Realized', num: true, render: (p) => usd(TB.pnlWords(p.realized_pnl_usd)) },
  ], closed, { empty: 'No closed positions.' });

  const ordTable = pagedTable([
    { label: 'Project', render: proj },
    { label: 'Side', render: (o) => TB.sideWords(o.side) },
    { label: 'Pair', render: (o) => h('span', { class: 'small' }, o.pair || '—') },
    { label: 'State', render: (o) => state(TB.orderStateWords(o.state), o.client_order_id) },
    { label: 'Filled', num: true, render: (o) => h('span', { class: 'num' }, amt(o.filled), ' of ', amt(o.quantity)) },
    { label: 'Notes', wrap: true, render: (o) => said(o.words || '') },
  ], v.orders.slice().reverse(), { size: 25, label: 'Trader orders', empty: 'No orders yet.' });

  const refTable = table([
    { label: 'Project', render: proj },
    { label: 'Order', render: (x) => h('span', { class: 'small' }, `${x.purpose === 'close' ? 'Sell' : 'Buy'}${x.request_pair ? ` ${x.request_pair}` : ''}`) },
    { label: 'Why the book refused it', wrap: true, render: (x) => said(TB.refusalWords(x)) },
  ], v.refusals, { empty: 'No refusals.' });

  const navTable = pagedTable([
    { label: 'Hour ending', render: (m) => h('span', { class: 'small' }, fmtDateTime(m.hour_end)) },
    { label: 'NAV', num: true, render: (m) => usd(m.nav) },
  ], TB.navRows(v), { size: 24, label: 'NAV by the hour', empty: 'No closed hour yet.' });

  const c = v.candles;
  const sources = c && c.sources && c.sources.length ? table([
    { label: 'Pair', key: 'pair' },
    { label: 'Pool', render: (s) => h('span', { class: 'small' }, `${s.pool_name || '—'}${s.dex ? ` · ${s.dex}` : ''}`) },
    { label: 'Network', render: (s) => h('span', { class: 'small' }, s.network) },
    { label: 'Chosen', render: (s) => h('span', { class: 'small' }, fmtDate(s.chosen_at)) },
  ], c.sources) : h('p', { class: 'small muted' }, 'No pool chosen yet.');
  const unknown = v.results.unknown && v.results.unknown.length ? details(`Not known (${v.results.unknown.length})`, h('ul', null, ...v.results.unknown.map((u) => h('li', null, said(u)))), { id: 'tb-unknown' }) : null;

  return card(title, h('div', null,
    h('p', { class: 'small muted' }, TB.summaryLine(v)),
    waits,
    unsettled,
    facts,
    sub('Your decisions', requests.length), reqTable,
    sub('Open positions', open.length), posTable,
    sub('Closed positions', closed.length), closedTable,
    sub('Orders', v.orders.length), ordTable,
    sub('Refusals', v.refusals.length), refTable,
    details(`NAV by the hour (${v.results.nav_by_hour.length})`, navTable, { id: 'tb-nav' }),
    details('Where the hours come from', h('div', null, h('p', { class: 'small muted' }, TB.candleWords(c)), sources), { id: 'tb-hours' }),
    unknown,
  ), { note: `${v.results.version}: what an order would have done, with fills, fees, slippage and stops. Kept apart from the PM Cohort above and from your Portfolio, and never added to either; nothing here is a real order. Lot ${v.venue.lot}, minimum order $${v.venue.min_notional_usd}. Reading this writes nothing.` });
}

// A long list a page at a time: the desk's claims are never drawn all at
// once (they ran to hundreds of thousands of characters on one page).
// The scout's list (core/scout.js view): what the morning sweep found, newest
// first, each item once however often it was seen. The items are the sweep's
// words, shown as text; a link only to an https address the desk accepted.
const SCOUT_LANES = { agents: 'Agents', onchain: 'On-chain', desk: 'Desk tools', security: 'Security' };
const scoutFilters = { lane: '', page: 0 };

async function scoutTab(ctx) {
  const v = await ctx.api.get('/api/scout');
  const out = (text, href, attrs = {}) => (/^https:\/\//.test(href || '') ? link(text, href, { rel: 'noopener noreferrer', target: '_blank', ...attrs }) : null);
  const last = v.last_brief;
  const fact = (label, value, title = null) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '140px' }, title },
    h('span', { class: 'small muted' }, label), h('strong', null, value));
  const status = card('Scout', h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '24px' } },
    fact('Ingest', v.ingest === 'ready' ? 'Ready' : 'Not set up', v.ingest === 'ready' ? 'The desk accepts briefs with its ingest key' : 'DESK_INGEST_KEY is not set on this desk'),
    fact('Last brief', last ? fmtAgo(last.received_at) : 'None yet', last ? `${last.brief_id} · ${fmtDate(last.received_at)}` : null),
    fact('Items', String(v.items.length), last ? `${plural(last.items, 'item')} in the last brief, ${last.items_new} new` : null),
    fact('Lanes missing', last ? (last.lanes_missing.length ? last.lanes_missing.map((l) => SCOUT_LANES[l] || l).join(', ') : 'No lane missing') : '—'),
    fact('Estimated cost', v.cost_usd_estimate_total === null ? '—' : `$${v.cost_usd_estimate_total.toFixed(2)}`,
      `${plural(v.briefs, 'brief')}${v.briefs_without_cost ? `, ${v.briefs_without_cost} without usage` : ''}; estimated from reported usage at ${v.prices}, not a bill`)));
  const laneSel = select([{ value: '', label: 'All lanes' }, ...v.lanes.map((l) => ({ value: l, label: SCOUT_LANES[l] || l }))], { 'aria-label': 'Lane', onchange: (e) => { scoutFilters.lane = e.target.value; scoutFilters.page = 0; draw(); } });
  laneSel.value = scoutFilters.lane;
  const holder = h('div');
  const draw = () => {
    const rows = v.items.filter((i) => !scoutFilters.lane || i.lane === scoutFilters.lane);
    holder.replaceChildren(pagedTable([
      { label: 'Item', render: (i) => h('div', null,
        out(i.title, i.url_primary, { title: i.summary }) || h('strong', { title: i.summary }, i.title),
        h('div', { class: 'small muted' }, i.creator || '—')) },
      { label: 'For the desk', render: (i) => h('span', { class: 'small' }, i.desk_leverage) },
      { label: 'Lane', render: (i) => h('span', { class: 'small' }, SCOUT_LANES[i.lane] || i.lane) },
      { label: 'Readiness', render: (i) => h('span', { class: 'small' }, i.readiness.charAt(0).toUpperCase() + i.readiness.slice(1)) },
      { label: 'Repository', render: (i) => out('Repository', i.url_repo, { class: 'small', title: i.url_repo }) || h('span', { class: 'faint' }, '—') },
      { label: 'Last seen', render: (i) => h('span', { class: 'small', title: `First seen ${fmtDate(i.first_seen)} · ${plural(i.times_seen, 'time')}` }, fmtDate(i.last_seen)) },
    ], rows, { size: 50, label: 'Scout items', empty: v.briefs ? 'Nothing in this lane yet.' : 'No brief yet.', st: scoutFilters }));
  };
  draw();
  return h('div', null, status, card('Found by the scout', holder, { actions: [laneSel] }));
}

function pagedTable(cols, rows, { size = 50, empty = '', label = 'Rows', st = { page: 0 } } = {}) {
  const holder = h('div');
  const slug = label.toLowerCase().replace(/[^a-z]+/g, '-');
  const draw = () => {
    const pages = Math.max(1, Math.ceil(rows.length / size));
    st.page = Math.max(0, Math.min(st.page || 0, pages - 1));
    const from = st.page * size;
    const prev = button('Previous', () => { st.page -= 1; draw(); holder.scrollIntoView({ block: 'nearest' }); }, { kind: 'small', key: `pg-${slug}-prev` });
    prev.disabled = st.page === 0;
    const next = button('Next', () => { st.page += 1; draw(); holder.scrollIntoView({ block: 'nearest' }); }, { kind: 'small', key: `pg-${slug}-next` });
    next.disabled = st.page >= pages - 1;
    // replaceChildren would write a missing pager as the word "null".
    holder.replaceChildren(...[
      table(cols, rows.slice(from, from + size), { empty }),
      pages > 1 ? h('nav', { class: 'pager', 'aria-label': `${label}: pages` }, h('span', { class: 'small muted', 'aria-live': 'polite' }, `${from + 1}–${Math.min(rows.length, from + size)} of ${rows.length} · page ${st.page + 1} of ${pages}`), prev, next) : null,
    ].filter(Boolean));
  };
  draw();
  return holder;
}

// A model's effective route in words, the way Settings says it: on hold
// (paused on this desk, so nothing says how to run it); automatic on its paid
// API (in the background, within your limits); or manual and ready (its own
// assistant when you ask on the online desk, or the pasted prompt on this
// PC), with the optional automatic route's missing setup as a quiet second
// line, never a warning. Pure, for the tests.
export function routeWords(index, p, s, { hosted = false } = {}) {
  const who = PROVIDER_LABELS[p];
  const hold = onHoldOf(index, p);
  if (hold) return { route: 'On hold', tone: '', setup: null, happens: `On hold on this desk${hold.since ? ` since ${hold.since}` : ''}: nothing new is assigned to ${who}. Its saved reports and waiting jobs are kept; lift the hold in Settings.` };
  const st = s || { mode: 'manual' };
  if (st.mode === 'api') return { route: `Automatic (API)${st.model ? ` · ${st.model}` : ''}`, tone: 'ok', setup: null, happens: `Runs by itself on the ${who} API in the background, within your limits. The report is saved when it finishes.` };
  if (st.mode === 'mock') return { route: 'Fictional demo adapter', tone: '', setup: null, happens: 'Returns fictional fixture reports in this demo workspace. No network call.' };
  const missing = (st.missing || []).join(', ') || st.reason || null;
  return {
    route: hosted ? 'Manual · ready through its assistant' : 'Manual · ready by paste and import',
    tone: '',
    setup: `Automatic route (optional): not set up${missing ? ` (${missing})` : ''}`,
    happens: hosted
      ? `Each run waits for you: ${waitingInstruction(p, { full: true })}. ${who} researches under its own plan and saves the report here, or paste the prompt and import the answer. Nothing is billed here.`
      : `Each run saves the prompt for you to paste into ${who}; the job completes when you import the answer. Nothing is billed here.`,
  };
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
      detail = card(`${d.project.name}: side by side`, comparisonBlock(ctx, d, { showMedian: Boolean(idx.settings.comparison.show_median) }), { actions: [h('a', { href: `#/project/${encodeURIComponent(projectId)}/compare` }, 'Open project')] });
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
      { label: category ? 'Spread' : 'Flagged items', wrap: true, render: (r) => (r.matching.length ? h('div', { class: 'chips' }, r.matching.map((m) => h('span', { class: 'chip' }, `${m.label} (${m.section}) ${m.spread === null || m.spread === undefined ? 'n/a' : m.spread}`, m.spread_flag ? h('span', { class: 'sr-only' }, ', above the threshold') : null))) : h('span', { class: 'faint small' }, 'Nothing flagged')) },
      { label: 'Not compared', wrap: true, render: (r) => (r.p.comparison.reasons.length ? h('span', { class: 'small muted' }, r.p.comparison.reasons.join('; ')) : null) },
    ], visible, { empty: category ? 'No comparable reports have a value for that item yet.' : 'No projects with reports yet.' })),
    detail);
}

const evFilters = { project: '', tag: '', check: '', staleOnly: false, page: 0 };

function evidenceTab(ctx) {
  const idx = ctx.state.index;
  const ev = idx.evidence;
  const projects = idx.projects.filter((p) => !p.broken);
  const projSel = select([{ value: '', label: 'All projects' }, ...projects.map((p) => ({ value: p.project_id, label: p.name }))], { onchange: (e) => { evFilters.project = e.target.value; evFilters.page = 0; draw(); } });
  projSel.value = evFilters.project;
  const tagSel = select([{ value: '', label: 'All tags' }, { value: 'V', label: '[V] checked in analyst session' }, { value: 'C', label: '[C] project-claimed' }, { value: 'I', label: '[I] analyst inference' }, { value: 'S', label: '[S] speculative forecast' }], { onchange: (e) => { evFilters.tag = e.target.value; evFilters.page = 0; draw(); } });
  tagSel.value = evFilters.tag;
  const checkSel = select([{ value: '', label: 'Any dashboard check' }, 'not_checked', 'source_reachable', 'source_matches_claim', 'source_contradicts_claim', 'source_unavailable'], { onchange: (e) => { evFilters.check = e.target.value; evFilters.page = 0; draw(); } });
  checkSel.value = evFilters.check;
  const stale = h('input', { type: 'checkbox', onchange: (e) => { evFilters.staleOnly = e.target.checked; evFilters.page = 0; draw(); } });
  stale.checked = evFilters.staleOnly;
  const claimsHolder = h('div');
  const draw = () => {
    const rows = ev.claims.filter((c) => (!evFilters.project || c.project_id === evFilters.project) && (!evFilters.tag || c.evidence_tag === evFilters.tag) && (!evFilters.check || c.dashboard_check.status === evFilters.check) && (!evFilters.staleOnly || c.stale));
    claimsHolder.replaceChildren(pagedTable([
      { label: 'Project', render: (c) => h('a', { href: `#/project/${encodeURIComponent(c.project_id)}/evidence?open=claims` }, c.project_name) },
      { label: 'From', render: (c) => PROVIDER_LABELS[c.provider] || c.provider },
      { label: 'Claim', wrap: true, render: (c) => h('div', null, c.text, c.limitation ? h('div', { class: 'small muted' }, `Limitation: ${c.limitation}`) : null) },
      { label: 'Analyst tag', render: (c) => tagChip(c.evidence_tag, c.evidence_tag_raw) },
      { label: 'Metric · period', render: (c) => (c.metric_id ? h('div', { class: 'small' }, h('code', null, c.metric_id), c.value !== null && c.value !== undefined ? ` ${fmtNum(c.value)} ${c.unit || ''}` : '', h('div', { class: 'muted' }, c.period || 'period unstated')) : null) },
      { label: 'As of', render: (c) => h('span', null, fmtDate(c.as_of), c.stale ? h('span', { class: 'freshness stale' }, ' · stale') : null) },
      { label: 'Sources', render: (c) => h('div', { class: 'small' }, c.sources.length ? c.sources.map((s) => h('div', null, s.url ? h('a', { href: s.url }, s.title || s.url) : s.source_id, s.source_type ? h('span', { class: 'faint' }, ` (${s.source_type})`) : null)) : h('span', { class: 'faint' }, 'none cited')) },
      { label: 'Your check', render: (c) => (c.dashboard_check.status === 'not_checked' ? h('span', { class: 'faint' }, 'Not checked') : stateText(sentence(c.dashboard_check.status), c.dashboard_check.status === 'source_matches_claim' ? 'ok' : c.dashboard_check.status === 'source_contradicts_claim' ? 'bad' : '')) },
      { label: 'Independent corroboration', render: (c) => (c.corroboration.status === 'none' ? h('span', { class: 'faint' }, 'None') : stateText(sentence(c.corroboration.status), c.corroboration.status === 'independently_corroborated' ? 'ok' : c.corroboration.status === 'contradicted' ? 'bad' : '')) },
    ], rows, { empty: 'No claims match. Claims come from the structured JSON block of each report.', label: 'Claims', size: 50, st: evFilters }));
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
    card('Contradictions and different measurement bases', pagedTable([
      { label: 'Project', render: (c) => h('a', { href: `#/project/${encodeURIComponent(c.project_id)}/compare` }, c.project_name) },
      { label: 'Metric', render: (c) => h('code', null, c.metric_id) },
      { label: 'Finding', render: (c) => (c.kind === 'contradiction' ? stateText('Contradiction', 'bad') : sentence(c.kind)) },
      { label: 'A', wrap: true, render: (c) => h('div', null, `${PROVIDER_LABELS[c.a.provider]}: ${fmtNum(c.a.value)} ${c.a.unit || ''}`, h('div', { class: 'small muted' }, c.a.period || 'period unstated')) },
      { label: 'B', wrap: true, render: (c) => h('div', null, `${PROVIDER_LABELS[c.b.provider]}: ${fmtNum(c.b.value)} ${c.b.unit || ''}`, h('div', { class: 'small muted' }, c.b.period || 'period unstated')) },
    ], ev.contradictions, { empty: 'No conflicting numbers between models.', label: 'Contradictions', size: 25 }), { note: 'A contradiction is the same metric, unit, period, definition and date with different values. Anything else is listed by its difference, not called a contradiction.' }),
    h('div', { class: 'grid two' },
      card('Sources cited by more than one model', pagedTable([
        { label: 'Project', render: (s) => h('a', { href: `#/project/${encodeURIComponent(s.project_id)}/evidence?open=claims` }, s.project_name) },
        { label: 'Source', wrap: true, render: (s) => h('a', { href: s.url }, s.title || s.url) },
        { label: 'Cited by', render: (s) => s.providers.map((p) => PROVIDER_LABELS[p]).join(', ') },
      ], ev.shared_sources, { empty: 'No shared sources.', label: 'Shared sources', size: 25 }), { note: 'Agreement built on the same source is not independent.' }),
      card('Unresolved questions', pagedTable([
        { label: 'Project', render: (q) => h('a', { href: `#/project/${encodeURIComponent(q.project_id)}` }, q.project_name) },
        { label: 'From', render: (q) => PROVIDER_LABELS[q.provider] || q.provider },
        { label: 'Question', wrap: true, key: 'question' },
      ], ev.unresolved, { empty: 'No open questions in the latest reports.', label: 'Unresolved questions', size: 25 }))),
    card('Claims', [h('div', { class: 'form-grid', style: { marginBottom: '12px' }, dataset: { nodirty: '1' } }, field('Project', projSel), field('Analyst tag', tagSel), field('Dashboard check', checkSel), h('label', { class: 'check' }, stale, `Only stale (older than ${idx.settings.freshness.claim_stale_days} days)`)), claimsHolder], { note: `${ev.claims.length} claims · ${ev.stale_claims} stale. Record checks on each project's Evidence tab.` }),
    card('Your dispute questions', [
      table([
        { label: 'Project', render: (x) => h('a', { href: `#/project/${encodeURIComponent(x.project_id)}/evidence?open=claims` }, x.project_name) },
        { label: 'Topic', render: (x) => (x.topic ? h('code', null, x.topic) : null) },
        { label: 'Question', wrap: true, key: 'question' },
        { label: 'Status', render: (x) => sentence(x.status) },
      ], ev.disputes, { empty: 'None yet.' }),
      projects.length ? h('div', { style: { marginTop: '12px' } }, disputeForm) : null,
    ]));
}

function sentence(s) {
  const t = String(s || '').replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
