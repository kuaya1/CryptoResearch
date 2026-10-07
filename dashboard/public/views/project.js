// Project page: one page per project (Eric, 2026-10-05, D1) with addressable
// tabs (#/project/<id>/<tab>). The project brief's three views (Eric,
// 2026-10-07): Overview (the default, at the address "brief": one model's
// brief under model tabs, the review digest above, the full scorecard and
// your headline folded under it), Compare (two saved reports side by side,
// views/brief-compare.js) and Evidence (one model's flags, claims, sources and
// provenance, with your checks, the research runs and the token identity
// folded under it); then Full report, Market and Notes. The header names the
// project and the market now, with its own time. Each tab is rendered only
// when opened and in its own error boundary, all from one read of the project
// record. Report text is cached so a live refresh redraws instantly and keeps
// your reading position. Old tab addresses redirect (projectRedirect).
import {
  h, card, table, gradeView, verdictChip, scoreView, tagChip, badgeInfo, gradeBadge, logo, sparkline, changeCell,
  fmtPrice, fmtCompactUsd, fmtNum, fmtDate, fmtDateTime, fmtAgo, fmtSignedPct, freshnessText, kv, details, field, input, select, button,
  action, callout, copyText, tabStrip, safeSection, submissionId, stateText, fieldError, PROVIDERS, PROVIDER_LABELS, link,
  jobKey, coworkIdleMinutes, isAssistantJob, researchState, withheldReason, unscoredFrom, unscoredList,
  withheldLabel, COVERAGE_MEANS, structureNotes, toast, onHoldOf, fmtMarketFigure, unknownFigure, fmtAsOf,
} from '../ui.js';
import { renderMarkdown } from '../md.js';
import { openResearchDialog, openSectorDialog, waitingActions, waitingStep } from './dialogs.js';
import { briefPanel, evidencePanel, bindBriefKeys, topBar } from './brief.js';
import { comparePanel } from './brief-compare.js';
import { marketNow } from '../brief-model.js';
import { positionCard } from '../position-ui.js';
import {
  profileOf, categoryRows, scorecardCounts, confidenceLine, categoryTable, categoryGlance, positivesAndRisks, chartCycleBlock, catalystsBlock,
  judgmentBlock, reviewBlock, scenariosBlock, codeReviewBlock,
} from '../thesis-ui.js';

// The brief's three views first (Overview keeps the address "brief", so every
// link to the Brief lands on it), then the report, the market and your notes.
const TABS = [
  ['brief', 'Overview'],
  ['compare', 'Compare'],
  ['evidence', 'Evidence'],
  ['report', 'Full report'],
  ['market', 'Market'],
  ['notes', 'Notes'],
];
// The views drawn as a brief: opened from the inspector, they keep its Back bar.
const BRIEF_VIEWS = ['brief', 'compare', 'evidence'];

// Each view's folded sections, by the name an address opens them with
// (?open=<name>), and the evidence checks the Overview's flags point to.
const FOLDS = {
  brief: { scorecard: 'pb-scorecard', headline: 'pb-headline' },
  evidence: { checks: 'brief-ev-checks', claims: 'pb-claims', technical: 'pb-technical', runs: 'pb-runs', identity: 'pb-identity' },
};

// The project page's former tabs and the Claude Brief's own page, mapped to
// their new home (Eric, 2026-10-05, D1). Pure: the hash to go to, or null.
export function projectRedirect(name, args, query) {
  const q = new URLSearchParams(query);
  const enc = encodeURIComponent;
  const pid = args[0];
  if (!pid) return null;
  const to = (tab, params) => {
    const qs = new URLSearchParams(params).toString();
    return `#/project/${enc(pid)}/${tab}${qs ? `?${qs}` : ''}`;
  };
  if (name === 'brief') return to('brief', { model: 'claude', ...(q.get('report') ? { report: q.get('report') } : {}) });
  if (name !== 'project') return null;
  const tab = args[1];
  const model = q.get('provider') || q.get('model');
  const run = q.get('run') ? { run: q.get('run') } : {};
  // The Brief's former folds now live on its other views (2026-10-07).
  if (tab === 'brief') {
    const open = q.get('open');
    if (open === 'compare') return to('compare', {});
    if (open === 'evidence') return to('evidence', { ...(model ? { model } : {}), open: 'claims' });
    if (open === 'runs' || (!open && q.get('run'))) return to('evidence', { open: 'runs', ...run });
    if (open === 'identity') return to('evidence', { open: 'identity' });
    return null;
  }
  switch (tab) {
    case undefined: case 'overview': return to('brief', {});
    case 'scorecards': return to('brief', { ...(model ? { model } : {}), open: 'scorecard' });
    case 'reports': return to('report', q.get('report') ? { report: q.get('report') } : {});
    case 'comparison': return to('compare', {});
    case 'research': return to('evidence', { open: 'runs', ...run });
    case 'history': return to('notes', {});
    default: return TABS.some(([t]) => t === tab) ? null : to('brief', {});
  }
}

const viewState = { raw: {}, focusTab: null };
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
  const tab = TABS.some(([t]) => t === route.args[1]) ? route.args[1] : 'brief';
  let d;
  try {
    d = await ctx.projectDetail(id);
  } catch (err) {
    return h('div', null, h('div', { class: 'crumbs' }, h('a', { href: '#/watchlist' }, 'Watchlist')), callout(`Could not load project "${id}": ${err.message}`, 'bad'));
  }
  bindBriefKeys(ctx);
  const row = ctx.state.index.projects.find((p) => p.project_id === id) || {};
  const latest = latestReports(d);
  const counts = { report: d.reports.length };
  const strip = tabStrip(TABS.map(([t, label]) => ({ id: t, label, href: `#/project/${encodeURIComponent(id)}/${t}`, count: counts[t] || null, countLabel: t === 'report' && counts[t] ? `${counts[t]} report${counts[t] === 1 ? '' : 's'}` : null })), tab, { label: 'Project sections' });
  // Opened from the inspector: the project's tabs keep that way back (its
  // history state, one entry deeper each time), so Escape and the Back bar
  // still return to the inspector after Full report and back (Eric, 2026-10-06).
  const st = history.state;
  if (st && st.crBrief === id) {
    for (const a of strip.querySelectorAll('a[role="tab"]')) {
      a.addEventListener('click', (e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        if (a.getAttribute('aria-selected') === 'true') return;
        const now = history.state && history.state.crBrief === id ? history.state : st;
        ctx.navigate(a.getAttribute('href'), { state: { ...now, crDepth: (Number(now.crDepth) || 1) + 1 } });
      });
    }
  }
  let sheet = null;
  const body = await safeSection(TABS.find(([t]) => t === tab)[1], () => ({
    brief: () => {
      const out = briefTab(ctx, d, row, latest, route);
      sheet = out.m;
      return out.node;
    },
    compare: () => compareTab(ctx, d, row, route),
    evidence: () => {
      const out = evidenceTab(ctx, d, row, latest, route);
      sheet = out.m;
      return out.node;
    },
    report: () => reportsTab(ctx, d, route),
    market: () => marketTab(ctx, d),
    notes: () => historyTab(ctx, d),
  })[tab]());
  // Opened from the inspector (ui.js briefLink): the brief's own bar, whose
  // Back (and Escape) returns there, on each of the brief's three views.
  const fromInspector = BRIEF_VIEWS.includes(tab) && history.state && history.state.crBrief === id;
  const barLabel = tab === 'compare' ? 'Compare' : tab === 'evidence' ? `${PROVIDER_LABELS[sheet && sheet.provider] || 'Claude'}'s evidence` : undefined;
  const page = h('div', { class: `project-page${BRIEF_VIEWS.includes(tab) ? ' pb-view' : ''}` },
    fromInspector ? topBar(ctx, sheet || { identity: { name: d.project.name }, report_id: null }, id, barLabel ? { label: barLabel } : {}) : null,
    h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, h('a', { href: `#/watchlist?p=${encodeURIComponent(id)}`, dataset: { key: 'crumb-watchlist' } }, 'Watchlist'), h('span', { 'aria-hidden': 'true' }, '/'), h('span', { 'aria-current': 'page' }, d.project.name)),
    header(ctx, d, row),
    strip,
    h('div', { id: 'tabpanel', role: 'tabpanel', 'aria-labelledby': `tab-${tab}` }, body));
  // An address that names a folded section (?open=, ?run=) brings it into
  // view once, when the page opens; a brief opened from the inspector puts
  // focus on its title, so a screen reader starts there.
  const open = FOLDS[tab] ? FOLDS[tab][route.query.get('open') || (tab === 'evidence' && route.query.get('run') ? 'runs' : '')] : null;
  const run = tab === 'evidence' ? route.query.get('run') : null;
  page.afterMount = () => {
    const toc = page.querySelector('.report-toc');
    if (toc && typeof toc.watch === 'function') toc.watch();
    const t = page.querySelector('#bf-title');
    const b = page.querySelector('.bf-bar');
    if (t && b && typeof IntersectionObserver === 'function') {
      const io = new IntersectionObserver(([en]) => {
        if (!t.isConnected) { io.disconnect(); return; }
        b.classList.toggle('scrolled', !en.isIntersecting && en.boundingClientRect.top < 0);
      }, { rootMargin: '-96px 0px 0px 0px' });
      io.observe(t);
    }
    // A model tab chosen with a key or a click keeps focus on the new tab
    // (and the brief's title does not take it back below).
    let onTab = false;
    if (viewState.focusTab) {
      const el = page.querySelector(`#pb-tab-${viewState.focusTab}`);
      viewState.focusTab = null;
      if (el) {
        el.focus({ preventScroll: true });
        ctx.claimFocus();
        onTab = true;
      }
    }
    // A redraw of the same page (a live update, a refresh) keeps its place.
    // Any other arrival goes to the section the address names: a link inside
    // the app arrives as 'pop' too (the browser fires popstate for a hash
    // link), so the reason alone cannot tell a link from Back.
    if (['live', 'same', 'refresh'].includes(ctx.state.renderReason)) return;
    const target = () => (run && page.querySelector(`#run-card-${CSS.escape(run)}`)) || (open && page.querySelector(`[data-key="${open}"]`)) || null;
    if (target()) {
      // Focus goes with the section, so the router leaves it alone.
      ctx.claimFocus();
      // After the router's own scroll reset (it runs once this returns) and
      // once the section is laid out.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const el = target();
        if (!el || !el.isConnected) return;
        el.scrollIntoView({ block: 'start' });
        const head = (run && el.querySelector(`[data-key="run-${CSS.escape(run)}"] > summary`)) || el.querySelector(':scope > summary') || el;
        if (head === el && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
        head.focus({ preventScroll: true });
      }));
    } else if (ctx.state.renderReason === 'nav' && fromInspector && t && !onTab) {
      t.focus({ preventScroll: true });
      ctx.claimFocus();
    }
  };
  return page;
}

export function latestReports(d) {
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
  // Archive needs no confirmation: nothing is deleted, the notice offers
  // Undo, and an archived project shows Restore here and in the inspector.
  const archived = p.status === 'archived';
  const restore = async () => {
    const r = await ctx.api.post(`/api/projects/${p.project_id}/restore`, {});
    toast(`Restored ${p.name}${r.on_watchlist ? ', back on your watchlist' : ''}. Nothing was started or sent.`);
    await ctx.refresh();
  };
  const archive = button(archived ? 'Restore' : 'Archive', null, { kind: 'quiet', key: archived ? 'project-restore' : 'project-archive' });
  archive.title = archived ? 'Bring it back as it was, with its history' : 'Off your lists; nothing is deleted. Undo right after.';
  archive.onclick = async () => {
    archive.disabled = true;
    try {
      if (archived) await restore();
      else {
        const r = await ctx.api.post(`/api/projects/${p.project_id}/archive`, { reason: 'Archived from the dashboard' });
        const sent = (r.sent_jobs || []).length;
        toast(`Archived ${p.name}. It is off your watchlist; its reports, notes and any holding are kept.${sent ? ` ${sent} request${sent === 1 ? '' : 's'} already sent to a paid model may still finish and be billed.` : ''}`, '', { action: { label: 'Undo', key: `undo-archive-${p.project_id}`, onClick: restore } });
        await ctx.refresh();
      }
    } catch (err) {
      toast(err.message, 'bad');
      archive.disabled = false;
    }
  };
  return h('div', { class: 'page-head pb-head' },
    h('div', { class: 'pb-head-id' },
      h('div', { class: 'pb-head-name' }, logo({ ...row, project_id: p.project_id, name: p.name, symbol: p.symbol }, { size: 36 }), h('h1', null, p.name, p.symbol ? h('span', { class: 'pb-ticker' }, ` ${p.symbol}`) : null)),
      marketFacts(row),
      h('div', { class: 'meta-line', style: { marginTop: '8px' } },
        sector ? h('button', { type: 'button', class: 'link', dataset: { key: 'project-sector' }, 'aria-label': `Sector: ${sector.label || sector.primary}. Change sector`, onclick: () => openSectorDialog(ctx, { ...row, ...p, sector }) }, sector.label || sector.primary) : null,
        h('a', { href: `#/project/${encodeURIComponent(p.project_id)}/evidence?open=identity`, title: (id.unknowns || []).join(' ') || 'Token identity, contracts and evidence', dataset: { key: 'project-identity' } }, id.status === 'verified' ? 'Identity verified' : `Identity ${id.status}`),
        // Watching or researching never suggests a holding; only an open position says Held.
        d.position && !d.position.closed ? h('span', null, 'Held') : null,
        id.official_website ? h('a', { href: id.official_website, class: 'wrap-anywhere' }, id.official_website.replace(/^https?:\/\//, '').replace(/\/$/, '')) : null)),
    h('div', { class: 'actions' }, archived ? null : research, archived ? null : watch, archive));
}

// The market now, under the project's name: price and its 24-hour change,
// market cap and 24-hour volume, from the index row the watchlist already has
// (never fetched here), with their own time and source, apart from any
// research date. A stale price says so in words; an unknown figure stays
// "—" with its reason.
function marketFacts(row) {
  const mk = marketNow(row);
  if (!mk) return h('p', { class: 'pb-mk none' }, h('span', { class: 'pb-mk-when' }, 'No market data for this project'));
  const dir = mk.change === null ? null : mk.change > 0 ? 'up' : mk.change < 0 ? 'down' : 'flat';
  const fig = (label, v, unknown) => h('span', { class: 'pb-mk-f' }, h('span', { class: 'k' }, label), v ? h('span', { class: 'v' }, v) : unknown);
  const when = mk.as_of ? fmtAgo(mk.as_of) : 'time not recorded';
  return h('p', { class: 'pb-mk', title: `${mk.source}${mk.as_of ? `, as of ${fmtDateTime(mk.as_of)}` : ''}. A market observation, not part of the research.` },
    h('span', { class: 'pb-mk-f' }, h('span', { class: 'v price' }, mk.price),
      mk.change24h ? h('span', { class: `chg ${dir}` }, h('span', { 'aria-hidden': 'true' }, mk.change24h), h('span', { class: 'sr-only' }, ` ${dir === 'down' ? 'down' : dir === 'up' ? 'up' : 'unchanged'} ${Math.abs(mk.change).toFixed(2)} percent over 24 hours`)) : null),
    fig('Market cap', mk.mcap, unknownFigure('Market cap', mk.mcap_usd)),
    fig('Volume 24h', mk.volume, unknownFigure('Volume', mk.volume_usd)),
    h('span', { class: `pb-mk-when${mk.stale ? ' stale' : ''}` }, mk.stale ? `Stale price · ${when}` : `${mk.source} · ${when}`, mk.as_of ? h('span', { class: 'sr-only' }, `, at ${fmtAsOf(mk.as_of)}`) : null));
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
function withheldBlock(prov, g, a, structure = null) {
  const why = withheldReason(prov, g, unscoredFrom(g, a.investment_components));
  return h('div', { class: 'why-withheld' },
    h('p', { style: { margin: '6px 0 0' } }, why.sentence),
    typeof why.coverage === 'number' ? h('p', { class: 'small muted', style: { margin: '2px 0 0' } }, COVERAGE_MEANS) : null,
    unscoredList(why, { max: 400 }),
    structureNotes(structure));
}

function routeText(rep) {
  const pv = rep.provenance || {};
  return `${rep.assessment ? rep.assessment.model_version || 'model not stated' : rep.model_version || 'model not stated'} · ${pv.attested ? 'attested by the API' : 'self-reported'}${pv.channel ? ` · via ${pv.channel}` : ''}`;
}

// ---------------------------------------------------------------------------
// Brief: model tabs, the review digest, one model's brief, then the folded
// sections that hold what the Overview, Scorecards, Comparison, Evidence and
// Research runs tabs held (Eric, 2026-10-05, D1).

// A folded section of a view, opened by its address (?open=<name>).
function foldFor(tab, route) {
  const open = route.query.get('open') || (tab === 'evidence' && route.query.get('run') ? 'runs' : null);
  return (key, title, body, note = null) => {
    const el = details(title, body, { id: FOLDS[tab][key], open: open === key });
    el.classList.add('page-fold');
    if (note) el.querySelector('summary').title = note;
    return el;
  };
}

const modelOf = (route) => (PROVIDERS.includes(route.query.get('model')) ? route.query.get('model') : 'claude');

// Overview: what changed since your review (one line until opened), the model
// tabs, the chosen model's brief; its full scorecard and your headline folded.
function briefTab(ctx, d, row, latest, route) {
  const pid = d.project.project_id;
  const prov = modelOf(route);
  const { m, sheet } = briefPanel(ctx, { d, row, pid, provider: prov, reportId: route.query.get('report') || null });
  const fold = foldFor('brief', route);
  return { m, node: h('div', null,
    reviewDigest(ctx, d),
    briefModelTabs(ctx, row, prov),
    h('div', { id: 'pb-model', role: 'tabpanel', 'aria-labelledby': `pb-tab-${prov}` },
      modelStatus(ctx, d, row, prov, latest, { route: false }),
      sheet),
    fold('scorecard', `Full scorecard · ${PROVIDER_LABELS[prov]}`, latest[prov] ? scorecardBody(ctx, d, latest, prov) : h('p', { class: 'small muted' }, `No gradable ${PROVIDER_LABELS[prov]} report yet.`), SCORECARD_NOTE),
    fold('headline', 'Your headline', headlineBody(ctx, d), 'The headline is your choice: one report, or one of your own decisions.')) };
}

// Compare: two saved reports side by side (views/brief-compare.js).
function compareTab(ctx, d, row, route) {
  return h('div', null, comparePanel(ctx, { d, row, pid: d.project.project_id, query: route.query }));
}

// Evidence: the model tabs, the chosen model's evidence; then, folded, your
// own checks of its claims and your questions, its technical records, the
// research runs and the token identity.
function evidenceTab(ctx, d, row, latest, route) {
  const pid = d.project.project_id;
  const prov = modelOf(route);
  const { m, sheet } = evidencePanel(ctx, { d, row, pid, provider: prov, reportId: route.query.get('report') || null });
  const fold = foldFor('evidence', route);
  const runs = researchParts(ctx, d, row, route);
  const r = m.status === 'ok' ? m.report : null;
  return { m, node: h('div', null,
    briefModelTabs(ctx, row, prov),
    h('div', { id: 'pb-model', role: 'tabpanel', 'aria-labelledby': `pb-tab-${prov}` },
      modelStatus(ctx, d, row, prov, latest),
      sheet),
    fold('claims', `Check the claims yourself${r ? ` · ${PROVIDER_LABELS[prov]}` : ''}`, claimsBody(ctx, d, r), EVIDENCE_NOTE),
    r ? fold('technical', 'Technical records', technicalBody(ctx, d, r, prov), 'How the report was read and saved: citation structure, extraction notes, the binding to its run, corrections, and the normalized data as saved.') : null,
    fold('runs', `Research runs${(d.research.runs || []).length ? ` (${d.research.runs.length})` : ''}`, runs.runs),
    fold('identity', `Token identity · ${d.project.identity.status === 'verified' ? 'verified' : d.project.identity.status}`, runs.identity)) };
}

// Your own checks of one report's claims, your dispute questions, and every
// open question on the project (each model's and yours).
function claimsBody(ctx, d, r) {
  const pid = d.project.project_id;
  const latest = latestReports(d);
  const disputeTopic = input({ placeholder: 'e.g. category:token_value_capture or metric:revenue_usd' });
  const disputeQ = input({ placeholder: 'The question that would settle it' });
  const disputeBtn = button('Add question', null, { kind: 'small', type: 'submit' });
  const disputeForm = h('form', { class: 'form-grid', dataset: { key: 'dispute-form' } }, field('Topic', disputeTopic), field('Resolving question', disputeQ), h('div', { class: 'field', style: { justifyContent: 'flex-end' } }, disputeBtn));
  disputeForm.onsubmit = action(disputeBtn, async () => { await ctx.api.post(`/api/projects/${pid}/disputes`, { topic: disputeTopic.value || null, question: disputeQ.value }); await ctx.refresh(); return true; }, 'Question added');
  const unresolved = [
    ...PROVIDERS.flatMap((p) => (latest[p] ? (latest[p].assessment.unresolved_questions || []).map((q) => ({ provider: p, q })) : [])),
    ...d.disputes.filter((x) => x.status === 'open').map((x) => ({ provider: 'you', q: x.question })),
  ];
  return h('div', null,
    r ? card(`${PROVIDER_LABELS[r.meta.provider]} · ${fmtDate(r.assessment.analysis_at)}`, claimsTable(ctx, d, r)) : callout('No report to check here yet.', 'info'),
    card('Your dispute questions', [
      d.disputes.length ? (table([
        { label: 'Topic', render: (x) => (x.topic ? h('code', null, x.topic) : null) },
        { label: 'Question', wrap: true, key: 'question' },
        { label: 'Status', render: (x) => x.status },
      ], d.disputes)) : h('p', { class: 'small muted' }, 'None yet.'),
      h('div', { style: { marginTop: '12px' } }, disputeForm),
    ]),
    unresolved.length ? card('Unresolved questions', h('ul', { class: 'list' }, unresolved.map((u) => h('li', null, h('span', { class: 'faint' }, `${u.provider === 'you' ? 'You' : PROVIDER_LABELS[u.provider]}: `), u.q)))) : null);
}

// How the report was read and saved, for when something looks wrong: the
// citation structure, extraction notes, the binding to its run, your
// corrections, how this model's reports changed, and the normalized data as
// saved (loaded only when opened).
function technicalBody(ctx, d, r, prov) {
  const integ = r.integrity || {};
  const issues = (r.extraction && r.extraction.issues) || [];
  const mp = (r.meta && r.meta.provenance) || {};
  const binding = mp.binding || null;
  const diffs = (d.diffs[prov] || []).filter((x) => x.to === r.report_id || x.from === r.report_id);
  return h('div', null,
    h('dl', { class: 'facts' },
      h('div', null, h('dt', null, 'Citation structure'), h('dd', null, integ.status === 'valid' ? 'References resolve to listed sources (a structural check only)' : `Citation issues: ${integ.status || 'not checked'}`)),
      h('div', null, h('dt', null, 'Read from'), h('dd', null, r.assessment.source_format === 'prose' ? 'The written report (no data block)' : r.assessment.source_format || 'Not recorded')),
      h('div', null, h('dt', null, 'Binding to its run'), h('dd', null, binding ? `${binding.status === 'bound' ? 'Bound to its run' : String(binding.status || 'not bound').replace(/_/g, ' ')}${(binding.conflicts || []).length ? ` · ${binding.conflicts.length} conflict${binding.conflicts.length === 1 ? '' : 's'}` : ''}${binding.fields ? ` · ${Object.entries(binding.fields).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ')}` : ''}` : mp.research_run_id ? 'Saved for its run' : 'Not part of a run')),
      h('div', null, h('dt', null, 'Your corrections'), h('dd', null, (r.corrections || []).length ? `${r.corrections.length}; the original is unchanged` : 'None')),
      h('div', null, h('dt', null, 'Original file'), h('dd', null, r.meta.original_filename || r.meta.original_file || 'Not recorded'))),
    (integ.issues || []).length ? h('ul', { class: 'list small' }, integ.issues.map((i) => h('li', null, h('code', null, i.path || i.field || ''), ` ${i.message}`))) : null,
    issues.length ? h('div', null, h('h3', { class: 'compare-h' }, 'Extraction notes'), issuesList(r.extraction)) : null,
    diffs.length ? h('div', null, h('h3', { class: 'compare-h' }, `How ${PROVIDER_LABELS[prov]}'s reports changed`), diffs.map((x) => h('div', { style: { marginBottom: '10px' } },
      h('p', { class: 'small', style: { margin: '0 0 4px' } }, `${x.from} → ${x.to}`, x.comparable ? null : h('span', { class: 'muted', title: x.note }, ' · different rubric, profile or horizon')),
      x.changes.length ? h('ul', { class: 'list small' }, x.changes.map((chg) => h('li', null, `${chg.section} · ${chg.id}: ${fmtScore(chg.from)} → ${fmtScore(chg.to)}${chg.delta !== null && chg.delta !== undefined ? ` (${chg.delta > 0 ? '+' : ''}${chg.delta})` : ''}`))) : h('p', { class: 'small muted', style: { margin: 0 } }, 'No score changes.')))) : null,
    normalizedView(ctx, d, r));
}

// Claude, ChatGPT and Gemini, Claude first: each tab names the model, its
// grade or state (the desk's own pill) and its verdict; each brief is drawn
// from that model's own report. Choosing one keeps the entry (and its way
// back to the inspector).
function briefModelTabs(ctx, row, sel) {
  const staleDays = ctx.state.index.settings.freshness.research_stale_days || 90;
  const hosted = Boolean(ctx.state.session && ctx.state.session.hosted);
  const go = (prov) => {
    viewState.focusTab = prov;
    ctx.navigate(ctx.hrefWith({ model: prov, report: null, open: null, run: null }), { replace: true, state: history.state });
  };
  const list = h('div', { class: 'mtabs pb-mtabs', role: 'tablist', 'aria-label': 'Model' }, PROVIDERS.map((prov) => {
    const rep = row.providers && row.providers[prov];
    const job = row.research && row.research.providers && row.research.providers[prov];
    const opts = { staleDays, hosted, onHold: Boolean(onHoldOf(ctx.state.index, prov)) };
    const info = badgeInfo(prov, rep, job, opts);
    const on = prov === sel;
    const verdict = rep && rep.verdict ? `${rep.verdict.charAt(0)}${rep.verdict.slice(1).toLowerCase().replace(/_/g, ' ')}` : null;
    return h('button', {
      type: 'button', role: 'tab', id: `pb-tab-${prov}`, class: 'mtab', 'aria-selected': String(on), 'aria-controls': 'pb-model', tabindex: on ? '0' : '-1',
      'aria-label': `${info.text.replace(/[.\s]+$/, '')}${verdict ? `. Verdict: ${verdict}` : ''}`, dataset: { key: `pb-tab-${prov}` }, onclick: () => { if (!on) go(prov); },
    }, h('span', { class: 'mt-name', 'aria-hidden': 'true' }, PROVIDER_LABELS[prov]),
    gradeBadge(prov, rep, job, opts),
    verdict ? h('span', { class: 'mt-verdict', 'aria-hidden': 'true' }, verdict) : null);
  }));
  list.addEventListener('keydown', (e) => {
    const i = PROVIDERS.indexOf(sel);
    const to = e.key === 'ArrowRight' ? PROVIDERS[(i + 1) % 3] : e.key === 'ArrowLeft' ? PROVIDERS[(i + 2) % 3] : e.key === 'Home' ? PROVIDERS[0] : e.key === 'End' ? PROVIDERS[2] : null;
    if (!to) return;
    e.preventDefault();
    if (to !== sel) go(to);
  });
  return list;
}

// The chosen model's report age, staleness and route, and the waiting job's
// actions (copy the prompt, import the answer) when a run waits for it.
function modelStatus(ctx, d, row, prov, latest, { route = true } = {}) {
  const pid = d.project.project_id;
  const staleDays = ctx.state.index.settings.freshness.research_stale_days || 90;
  const hosted = Boolean(ctx.state.session && ctx.state.session.hosted);
  const r = latest[prov];
  const sum = row.providers && row.providers[prov];
  const job = row.research && row.research.providers && row.research.providers[prov];
  const onHold = Boolean(onHoldOf(ctx.state.index, prov));
  const info = badgeInfo(prov, sum, job, { staleDays, hosted, onHold });
  const waiting = job && job.state === 'unconfigured' && !onHold ? waitingActions(ctx, { pid, runId: job.run_id, provider: prov, key: `pb-${prov}` }) : null;
  if ((!r || !route) && !waiting) return null;
  return h('div', { class: 'pb-status' },
    r && route ? h('p', { class: 'small faint' }, info.age ? `Analysis ${info.age} · ` : '', info.stale ? h('span', { class: 'freshness stale' }, 'stale · ') : null, routeText(r)) : null,
    waiting ? h('div', { class: 'btn-row' }, waiting) : null);
}

// What changed since your last review, with Mark reviewed: one line that
// names the changes in words, the list one tap away (the full history is on
// the Notes tab), so the verdict and its risk stay in the first view.
function reviewDigest(ctx, d) {
  const pid = d.project.project_id;
  const ch = d.changes || {};
  const n = (k, one, many = `${one}s`) => (k ? `${k} ${k === 1 ? one : many}` : null);
  const grades = (ch.provider_changes || []).filter((c) => c.from_report);
  const words = [n((ch.new_reports || []).length, 'new report'), n(grades.length, 'grade change'), n((ch.research_runs || []).length, 'research run'), ch.price && typeof ch.price.change_pct === 'number' ? `price ${fmtSignedPct(ch.price.change_pct)}` : null].filter(Boolean);
  const since = ch.since ? `Since ${ch.cursor_source === 'project created' ? 'the project was added' : fmtDateTime(ch.since)}. A digest never changes grades, reports or your headline.` : null;
  const list = ch.item_count ? h('ul', { class: 'list small' },
    (ch.new_reports || []).map((r) => h('li', null, `New ${PROVIDER_LABELS[r.provider]} report (${fmtDate(r.analysis_at)}): ${r.verdict || 'no verdict'}`)),
    grades.map((c) => h('li', null, `${PROVIDER_LABELS[c.provider]} grade ${c.grade_from || 'none'} → ${c.grade_to || 'none'}${c.verdict_from !== c.verdict_to ? `; verdict ${c.verdict_from || 'none'} → ${c.verdict_to || 'none'}` : ''}`)),
    (ch.research_runs || []).map((r) => h('li', null, `Research run ${r.status.replace(/_/g, ' ')} (${r.providers.map((p) => PROVIDER_LABELS[p]).join(', ')})`)),
    ch.price && typeof ch.price.change_pct === 'number' ? h('li', null, `Price ${fmtSignedPct(ch.price.change_pct)} since then`) : null,
    h('li', { class: 'pb-digest-all' }, h('a', { href: `#/project/${encodeURIComponent(pid)}/notes`, dataset: { key: 'pb-all-changes' } }, 'All changes'), reviewedButton(ctx, pid, 'ov-reviewed-in'))) : null;
  const head = h('span', { class: 'pb-digest-t' }, h('strong', { id: 'pb-digest-h' }, 'Since your last review'), h('span', { class: 'pb-digest-w' }, words.length ? ` · ${words.join(', ')}` : ' · nothing new'));
  return h('section', { class: `pb-digest${ch.item_count ? ' has' : ''}`, 'aria-labelledby': 'pb-digest-h', title: since },
    list ? h('details', { class: 'pb-digest-d', dataset: { key: 'pb-digest' } }, h('summary', null, head), list) : h('p', { class: 'pb-digest-d none' }, head),
    ch.item_count ? reviewedButton(ctx, pid) : null);
}

// Your headline: one report, or one of your own decisions.
function headlineBody(ctx, d) {
  const pid = d.project.project_id;
  const hl = d.headline;
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
  return h('div', null, h('p', { class: 'small', style: { margin: '0 0 8px' } }, headlineText), details('Change the headline', h('div', { class: 'actions' }, sel, save, clearBtn), { id: 'ov-headline' }));
}

function reviewedButton(ctx, pid, key = 'ov-reviewed') {
  const b = button('Mark reviewed', null, { kind: 'small', key });
  b.onclick = action(b, async () => { await ctx.api.post(`/api/projects/${pid}/reviewed`, {}); await ctx.refresh(); return true; }, 'Marked reviewed. New changes are counted from now.');
  return b;
}

// ---------------------------------------------------------------------------
// The full scorecard: one model at a time, under the rubric its report declares.

const SCORECARD_NOTE = 'Three separate panels, never mixed: the category grades (higher is better) are diagnostics and are never averaged into the grade; the grade comes from six weighted components (20/25/20/15/10/10); the four downside-risk scores are higher-is-worse. A missing input withholds the grade and shows how much weight was scored.';

function scorecardBody(ctx, d, latest, prov) {
  const pid = d.project.project_id;
  const r = latest[prov];
  const a = r.assessment;
  const grading = ctx.state.index.rubrics.grading;
  const g = (d.comparison.grades[prov] && d.comparison.grades[prov].grade) || r.grade;
  const parts = (g && g.parts) || [];
  // The categories of the scoring profile this report declares, not of the
  // project's current one: an older report keeps the categories it was graded
  // under, a report written for cr-research-prompt@5 has the thirteen.
  const rows = categoryRows(profileOf(ctx.state.index.rubrics.profiles, a, d.profile), a);
  const counts = scorecardCounts(rows);
  const integ = r.integrity || {};
  return h('div', null,
    card(h('span', { class: 'pill-row' }, h('span', null, `${PROVIDER_LABELS[prov]} · ${fmtDate(a.analysis_at)}`), verdictChip(a.verdict)), [
      h('div', { class: 'grid two' },
        h('div', null, h('div', { class: 'small muted' }, 'Grade calculated by this app'), gradeView(g),
          r.model_total ? h('p', { class: 'small', style: { marginTop: '8px' } }, r.model_total.status === 'mismatch' ? h('strong', null, 'Model total differs. ') : null, r.model_total.message) : null,
          g && g.status === 'withheld' ? withheldBlock(prov, g, a, r.structure) : null),
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
      h('h3', { style: { marginTop: '20px' } }, 'Category grades (higher is better, never averaged into the grade)'),
      h('p', { class: 'small muted', style: { margin: '0 0 8px' } }, `${counts.scored} of ${counts.total} scored${counts.unknown ? `; ${counts.unknown} unknown, with no number` : ''}. Scoring profile ${a.sector_profile || 'not declared'}.${confidenceLine(counts) ? ` ${confidenceLine(counts)}` : ''}`),
      categoryTable(rows, { corrected: (cid) => originalOf(r, `diagnostic_scores.${cid}`), flags: (r.evidence && r.evidence.flags) || [] }),
      h('h3', { style: { marginTop: '20px' } }, 'Downside risk (higher means more risk)'),
      (table([
        { label: 'Risk', render: (x) => h('span', { title: x.definition }, x.label) },
        { label: 'Score', render: (x) => scoreView(a.risk_scores[x.id], 'risk', { corrected: originalOf(r, `risk_scores.${x.id}`) }) },
        { label: 'Rationale', wrap: true, render: (x) => { const s = a.risk_scores[x.id]; return s ? h('span', { class: 'small' }, s.rationale || s.missing_data || '') : null; } },
      ], grading.risk_scores)),
      h('div', { class: 'btn-row', style: { marginTop: '16px' } }, h('a', { class: 'btn', href: `#/project/${encodeURIComponent(pid)}/report?report=${encodeURIComponent(r.report_id)}`, dataset: { key: `sc-report-${prov}` } }, 'Open the full report')),
    ]),
    positionCard(a, prov),
    thesisCards(a, prov));
}

// What a report written for cr-research-prompt@5 also says, each in its own
// card: the chart and cycle reading, the scenarios, the model's own judgment
// and the code it read. An older report shows the parts it has.
function thesisCards(a, prov) {
  const who = PROVIDER_LABELS[prov] || prov;
  const one = (title, body) => (body ? h('div', { class: 'card thesis-card' }, h('h3', null, `${title} · ${who}`), body) : null);
  const chart = chartCycleBlock(a, { full: true });
  const judgment = judgmentBlock(a, { open: true, id: `sc-judgment-${prov}`, withLongTerm: false });
  return [
    chart ? h('div', { class: 'card thesis-card' }, chart) : null,
    one('Scenarios over the horizon', scenariosBlock(a)),
    judgment ? h('div', { class: 'card thesis-card' }, judgment) : null,
    one('Code that was read', codeReviewBlock(a)),
  ];
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

// How many claims and category grades the evidence checks flagged, in words.
export function flaggedText(ev) {
  const claims = ev.flagged_claims || ev.flagged || 0;
  const cats = ev.flagged_categories || 0;
  return [claims ? `${claims} claim${claims === 1 ? '' : 's'}` : null, cats ? `${cats} category grade${cats === 1 ? '' : 's'}` : null].filter(Boolean).join(' and ') || 'nothing';
}

// The desk's evidence checks on one report's claims and category grades
// (core/evidence.js): flags with the reason and what would settle each;
// never a score change.
const SEVERITY_TONE = { high: 'bad', medium: 'warn', low: '' };
// A clean result in words that claim no more than the checks do: they found
// no inconsistency, they did not verify the facts, and with too little to
// check they say so.
export function checksWord(ev) {
  if (!ev) return 'not run';
  const cov = ev.coverage && typeof ev.coverage === 'object' ? ev.coverage.status : ev.coverage;
  if (cov === 'none') return 'coverage insufficient';
  return cov === 'partial' ? 'no inconsistencies detected · partial coverage' : 'no inconsistencies detected';
}
export function evidenceChecksBlock(ev) {
  if (!ev) return null;
  const cov = ev.coverage && typeof ev.coverage === 'object' ? ev.coverage.status : ev.coverage;
  const head = ev.flags.length ? `${flaggedText(ev)} flagged`
    : cov === 'none' ? 'Evidence checks: coverage insufficient' : 'No inconsistencies detected by these checks';
  return h('div', { class: 'small', style: { margin: '0 0 10px' } },
    h('p', { style: { margin: '0 0 4px' } },
      stateText(head, ev.high ? 'bad' : ev.flags.length || cov === 'none' ? 'warn' : ''),
      ' ', h('span', { class: 'muted' }, ev.summary)),
    ev.flags.length ? h('ul', { class: 'list small' }, ev.flags.map((x) => h('li', null, stateText(x.severity, SEVERITY_TONE[x.severity]), ' ', x.message))) : null,
    h('p', { class: 'small faint', style: { margin: '4px 0 0' } }, ev.tag_note || 'A claim tagged [V] is the researcher\'s own classification of its source; the desk does not verify it independently.'),
    ev.source_types && ev.source_types.outside_list.length
      ? h('p', { class: 'small muted', style: { margin: '4px 0 0' } }, `Source types written outside the accepted list, read as: ${ev.source_types.outside_list.map((x) => `${x.given} as ${x.read_as}`).join(', ')}.`)
      : null);
}

function claimsTable(ctx, d, r) {
  const reviews = d.claim_reviews || {};
  const sources = new Map((r.assessment.sources || []).map((s) => [s.source_id, s]));
  // The worst desk flag on each claim, shown next to its text.
  const worst = new Map();
  for (const x of (r.evidence && r.evidence.flags) || []) if (x.claim_id && !worst.has(x.claim_id)) worst.set(x.claim_id, x);
  return (table([
    { label: 'Claim', wrap: true, render: (c) => h('div', null, h('span', { class: 'faint small' }, `${c.claim_id} `), c.text, c.limitation ? h('div', { class: 'small muted' }, `Limitation: ${c.limitation}`) : null, worst.has(c.claim_id) ? h('div', { class: 'small' }, stateText(`Desk check: ${worst.get(c.claim_id).severity}`, SEVERITY_TONE[worst.get(c.claim_id).severity]), ' ', h('span', { class: 'muted' }, worst.get(c.claim_id).message)) : null) },
    { label: 'Analyst tag', render: (c) => tagChip(c.evidence_tag, c.evidence_tag_raw) },
    { label: 'Metric', render: (c) => (c.metric_id ? h('div', { class: 'small' }, h('code', null, c.metric_id), c.value !== null && c.value !== undefined ? ` ${fmtNum(c.value)} ${c.unit || ''}` : '', h('div', { class: 'muted' }, [c.period, c.as_of ? `as of ${c.as_of}` : null].filter(Boolean).join(' · '))) : null) },
    { label: 'Sources', render: (c) => h('div', { class: 'small' }, (c.source_ids || []).map((sid) => { const s = sources.get(sid); return h('div', null, s && s.url ? h('a', { href: s.url }, s.title || s.url) : `${sid} (not in the source list)`); })) },
    { label: 'Your check · corroboration', render: (c) => claimReviewControls(ctx, d, r, c, reviews[`${r.report_id}#${c.claim_id}`]) },
  ], r.assessment.claims || [], { empty: 'This report lists no structured claims.' }));
}

// The report's JSON block (the data the desk reads its grades from), set
// apart from the written report. Only a fenced block holding the report's
// schema_version, the last one; the text itself is never changed.
export function splitDataBlock(text) {
  const fence = /```[ \t]*[A-Za-z0-9_-]*[^\n]*\n([\s\S]*?)\n[ \t]*```/g;
  let last = null;
  let m;
  while ((m = fence.exec(text))) if (/"schema_version"/.test(m[1])) last = { start: m.index, end: m.index + m[0].length, body: m[1] };
  if (!last) return { prose: text, block: null };
  return { prose: `${text.slice(0, last.start)}${text.slice(last.end)}`, block: last.body };
}

// The data block, one tap away and loaded only when opened.
function dataBlockView(r, block) {
  const pre = h('pre', { class: 'raw data-block' });
  const det = h('details', { class: 'disclosure data-block-wrap', dataset: { key: `data-${r.report_id}` } },
    h('summary', null, `Structured data block · ${block.length.toLocaleString('en-US')} characters`),
    h('div', { class: 'body' }, h('p', { class: 'small muted', style: { margin: '0 0 8px' } }, 'The JSON the model wrote at the end of its report: the desk reads the scores from it. It is part of the original, which is unchanged ("Show exact text" and "Download original" include it).'), pre));
  det.addEventListener('toggle', () => { if (det.open && !pre.textContent) pre.textContent = block; });
  return det;
}

// Until the original's text arrives the reader holds its place with a
// fixed-height placeholder, said to a screen reader; the tab itself is drawn
// at once (Eric, 2026-10-06), so a click never waits on a slow link.
function readerWaiting() {
  return h('div', { class: 'reader-wait', role: 'status' },
    h('span', { class: 'sr-only' }, 'Loading the report text'),
    ...['w80', '', 'w60', '', 'w80', 'w40', '', 'w60'].map((w) => h('span', { class: `skel${w ? ` ${w}` : ''}`, 'aria-hidden': 'true' })));
}

function reportReader(ctx, d, r) {
  const holder = h('div', { class: 'reader', 'aria-busy': 'true' }, readerWaiting());
  const pid = d.project.project_id;
  const isPdf = String(r.meta.original_file || '').endsWith('.pdf');
  const url = `/api/projects/${pid}/reports/${r.report_id}/original`;
  // Formatted: the written report, then its data block folded away. Exact
  // text: the original as received, byte for byte.
  const draw = (text) => {
    holder.removeAttribute('aria-busy');
    if (viewState.raw[r.report_id]) return holder.replaceChildren(h('div', { class: 'raw' }, text));
    const { prose, block } = splitDataBlock(text);
    return holder.replaceChildren(renderMarkdown(prose), block ? dataBlockView(r, block) : null);
  };
  if (isPdf) {
    holder.removeAttribute('aria-busy');
    holder.replaceChildren(callout('The original is a PDF. It is kept byte for byte; download it below. Grading needs a text copy (paste it as a new import).', 'info'));
  } else if (textCache.has(url)) draw(textCache.get(url));
  else {
    cachedText(ctx, url).then(draw).catch((err) => {
      holder.removeAttribute('aria-busy');
      holder.replaceChildren(callout(`Could not load the original: ${err.message}`, 'bad'));
    });
  }
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

// One cited source, with what is known about it (also used by the inspector).
export function sourceItem(s) {
  const meta = [s.publisher, s.source_type ? s.source_type.replace(/_/g, ' ') : null, s.accessed_at ? `accessed ${fmtDate(s.accessed_at)}` : null].filter(Boolean);
  return h('li', null, s.url ? h('a', { href: s.url }, s.title || s.url) : h('span', null, s.title || s.source_id, h('span', { class: 'faint' }, ' (no usable link)')), meta.length ? h('span', { class: 'faint' }, ` · ${meta.join(' · ')}`) : null);
}

// The summary above the original, in reading order: the verdict for the
// holding period; the investment grade, or why it is withheld; the category
// grades with their confidence; the strongest positives and risks; the chart
// and cycle reading; dated catalysts and what would confirm or invalidate the
// opportunity; the model's final judgment; the next review. The grade is this
// app's calculation from the report's six weighted scores (a withheld grade
// lists the unscored parts and the model's own notes); everything else is the
// model's. An older report shows the parts it has.
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
      h('div', { class: 'provider-grade' }, h('span', { class: 'state-text' }, withheld.short)),
      withheld.coverage !== null ? h('p', { class: 'small muted', style: { margin: '2px 0 0' } }, COVERAGE_MEANS) : null,
      unscoredList(withheld, { max: 400 }),
      structureNotes(r.structure));
  } else if (g && (g.status === 'firm' || g.status === 'range')) gradeEl = gradeView(g);
  else gradeEl = h('div', { class: 'provider-grade' }, h('span', { class: 'state-text' }, 'No grade'), g && g.reason ? h('span', { class: 'small muted' }, g.reason) : null);
  // The category grades of the profile this report declares; none for a
  // report that scored no category at all (a PDF, a short prose report).
  const rows = Object.keys(a.diagnostic_scores || {}).length ? categoryRows(profileOf(ctx.state.index.rubrics.profiles, a, d.profile), a) : [];
  const pid = d.project.project_id;
  const scenarios = scenariosBlock(a);
  const code = codeReviewBlock(a);
  const scores = categoryGlance(rows, `#/project/${pid}/scorecards?provider=${r.meta.provider}`, { flags: (r.evidence && r.evidence.flags) || [] });
  if (scores) scores.id = 'rsec-scores';
  return h('section', { class: 'card glance', id: 'rsec-summary', 'aria-labelledby': 'glance-title' },
    h('div', { class: 'card-head' }, h('div', null, h('h2', { id: 'glance-title' }, 'Summary'),
      h('div', { class: 'note' }, 'The investment grade is calculated by this app from the report\'s six weighted scores. Everything else here is the model\'s own: its verdict, category grades, chart reading, judgment, risks, questions and sources. The report below tags each claim as checked, project-claimed, inference or speculation.'))),
    h('div', { class: 'glance-grid' },
      h('div', null,
        h('div', { class: 'small muted' }, 'Verdict for the holding period (the model\'s)'),
        h('div', { style: { margin: '4px 0' } }, verdictChip(a.verdict)),
        a.summary ? h('p', { class: 'small', style: { margin: '0 0 4px' } }, a.summary) : null,
        h('dl', { class: 'facts' }, h('div', { class: 'wide' }, h('dt', null, 'Horizon'), h('dd', null, a.horizon || 'not stated')))),
      h('div', null,
        h('div', { class: 'small muted' }, 'Investment grade (calculated by this app)'), gradeEl)),
    scores,
    positivesAndRisks(a),
    chartCycleBlock(a),
    catalystsBlock(a),
    judgmentBlock(a, { id: `gl-judgment-${r.report_id}` }),
    reviewBlock(a),
    h('div', { class: 'glance-block', id: 'rsec-risks' },
      h('h3', null, 'Top downside risks (higher is worse)'),
      risks.length
        ? h('ul', { class: 'glance-risks' }, risks.map((x) => h('li', null, h('span', { title: x.def.definition || '' }, x.def.label), scoreView(x.s, 'risk'))))
        : h('p', { class: 'small faint', style: { margin: '6px 0 0' } }, 'No downside risk was scored in this report.')),
    scenarios ? h('div', { class: 'glance-block', id: 'rsec-scenarios' }, details('Scenarios over the horizon: bear, base and bull', scenarios, { id: `gl-scenarios-${r.report_id}` })) : null,
    code ? h('div', { class: 'glance-block' }, details('Code that was read', code, { id: `gl-code-${r.report_id}` })) : null,
    questions.length ? h('div', { class: 'glance-block' }, h('h3', null, `Unresolved questions (${questions.length})`), h('ul', { class: 'list small' }, questions.map((q) => h('li', null, q)))) : null,
    h('div', { class: 'glance-block', id: 'rsec-sources' }, sources.length
      ? details(`${sources.length} source${sources.length === 1 ? '' : 's'} cited`, h('ol', { class: 'list small' }, sources.map(sourceItem)), { id: `src-${r.report_id}`, open: sources.length <= 5 })
      : h('p', { class: 'small faint', style: { margin: 0 } }, 'This report lists no sources.')));
}

// A revision in one sentence: its basis, what changed, the model's reason.
function revisionText(rv) {
  const head = rv.basis === 'existing_evidence' ? 'Revision using existing evidence (no source added)'
    : rv.basis === 'new_sources' ? `Revision with ${rv.sources.added} new source${rv.sources.added === 1 ? '' : 's'}`
      : 'Re-saved with the same scores';
  const parts = (rv.changed_components || []).map((c) => `${c.id.replace(/_/g, ' ')} ${c.from} → ${c.to}`);
  const what = parts.length ? parts.join('; ') : rv.changed_categories ? `${rv.changed_categories} category grade(s) changed` : 'no weighted part changed';
  return `${head}, ${rv.minutes_after} min after ${rv.of}: ${what}. ${rv.declared && rv.declared.note ? `The model's reason: ${rv.declared.note}` : 'No reason was recorded with this save.'}`;
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
      good.filter((r) => r.meta.provider === p).map((r) => {
        const g = r.grade;
        return h('a', { href: `#/project/${encodeURIComponent(pid)}/report?report=${encodeURIComponent(r.report_id)}`, 'aria-current': sel && r.report_id === sel.report_id ? 'true' : null, dataset: { key: `rl-${r.report_id}` } },
          h('div', { class: 'line1' }, h('span', null, fmtDate(r.assessment.analysis_at) || 'Undated'), h('span', { class: 'num' }, g && g.display ? `${g.display} ${g.label || ''}`.trim() : g && g.status === 'withheld' ? withheldLabel(g.coverage_pct) : r.meta.original_file.endsWith('.pdf') ? 'PDF' : 'No grade')),
          h('div', { class: 'line2' }, [r.assessment.verdict ? r.assessment.verdict.charAt(0) + r.assessment.verdict.slice(1).toLowerCase() : 'No verdict', latestIds.has(r.report_id) ? 'latest' : 'earlier', r.revision && r.revision.kind === 'revision' ? (r.revision.basis === 'existing_evidence' ? 'revision, same evidence' : r.revision.basis === 'new_sources' ? 'revision, new sources' : 're-saved') : null, r.corrections.length ? `${r.corrections.length} correction(s)` : null].filter(Boolean).join(' · ')));
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
        // A revision of an earlier save for the same run: what changed, on
        // what evidence and why, from the stored records (revisions.js).
        sel.revision && sel.revision.kind === 'revision' ? h('p', { class: 'newer-line' }, revisionText(sel.revision), ' ', h('a', { href: `#/project/${encodeURIComponent(pid)}/report?report=${encodeURIComponent(sel.revision.of)}`, dataset: { key: `rev-of-${sel.report_id}` } }, 'Open the earlier report')) : null,
        sel.analysis_timing && ['after_save', 'future'].includes(sel.analysis_timing.status) ? h('p', { class: 'newer-line' }, `The report states an analysis time ${sel.analysis_timing.minutes_after_save !== null && sel.analysis_timing.minutes_after_save < 2880 ? `${sel.analysis_timing.minutes_after_save} min` : 'more than a day'} after it was saved (${fmtDateTime(sel.meta.imported_at)}); shown as written, ordered by its save time.`) : null,
        // Scores the text states that differ from the data block (core/textscores.js).
        sel.text_scores && Array.isArray(sel.text_scores.mismatches) && sel.text_scores.mismatches.length ? h('p', { class: 'newer-line problem' }, sel.text_scores.summary) : null,
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
    h('div', { class: 'report-layout' }, list, main, sel ? reportContents(main) : null));
}

// The report's contents, beside it from 1280px (V4, Eric, 2026-10-05): one
// button per part the report has, in its order; the part in view is marked.
// Buttons, not links: an address here would be read as a route.
const CONTENTS = [['rsec-summary', 'Summary'], ['rsec-scores', 'Scores'], ['rsec-risks', 'Risks'], ['rsec-scenarios', 'Scenarios'], ['rsec-sources', 'Sources']];

function reportContents(main) {
  const items = CONTENTS.filter(([id]) => main.querySelector(`#${id}`));
  if (!items.length) return null;
  // Each part's heading can take focus and has a stable key, set when the
  // report is drawn, so focus put there survives a live redraw.
  const headOf = (el) => el.querySelector('h2, h3, summary') || el;
  for (const [id] of items) {
    const head = headOf(main.querySelector(`#${id}`));
    if (head.tagName !== 'SUMMARY' && !head.hasAttribute('tabindex')) head.setAttribute('tabindex', '-1');
    if (!head.dataset.key) head.dataset.key = `${id}-head`;
  }
  const buttons = items.map(([id, label]) => {
    const b = h('button', { type: 'button', class: 'toc-item', dataset: { key: `toc-${id}`, target: id } }, label);
    b.addEventListener('click', () => {
      const el = document.getElementById(id);
      if (!el) return;
      // A folded part (the scenarios, a long source list) opens first.
      const fold = el.querySelector('details');
      if (fold) fold.open = true;
      el.scrollIntoView({ block: 'start' });
      headOf(el).focus({ preventScroll: true });
    });
    return b;
  });
  const nav = h('nav', { class: 'report-toc', 'aria-label': 'Report contents' }, h('p', { class: 'toc-title', 'aria-hidden': 'true' }, 'Contents'), h('ul', null, buttons.map((b) => h('li', null, b))));
  // The part in view, marked as you scroll (set up once the page is shown):
  // the last part whose top has reached the line under the bar where a jump
  // lands (the summary holds the others, so "intersecting" alone would always
  // name it).
  nav.watch = () => {
    let frame = 0;
    const mark = () => {
      frame = 0;
      if (!nav.isConnected) { window.removeEventListener('scroll', onScroll); return; }
      // Where a jump lands (the page's scroll padding under the bar), and a little more.
      const line = (parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0) + 12;
      let on = items[0][0];
      for (const [id] of items) { const el = document.getElementById(id); if (el && el.getBoundingClientRect().top <= line) on = id; }
      // At the end of the page the last parts cannot reach the line.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) on = items[items.length - 1][0];
      for (const b of buttons) {
        if (b.dataset.target === on) b.setAttribute('aria-current', 'location');
        else b.removeAttribute('aria-current');
      }
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(mark); };
    window.addEventListener('scroll', onScroll, { passive: true });
    mark();
  };
  return nav;
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

// ---------------------------------------------------------------------------
// Evidence

const EVIDENCE_NOTE = 'Separate things: the analyst tag ([V] means the analyst says it checked a primary source in its own session), the desk\'s evidence checks (a [V] resting only on an AI summary or a secondary source, a critical claim without a primary source or date, a fee figure nobody could reproduce), your check (what you confirmed by opening the source), and independent corroboration (a different, independent source agrees). Citation integrity only means the references resolve. Model agreement is not corroboration. None of these changes a score.';

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
        ['Market cap', fmtMarketFigure(m.market_cap_usd, fmtCompactUsd) ? h('span', { title: 'Price × circulating supply, as reported by the provider' }, `${fmtCompactUsd(m.market_cap_usd)} ($${fmtNum(m.market_cap_usd, 0)})`) : unknownFigure('Market cap', m.market_cap_usd)],
        ['Market cap, 24H change', changeCell(m.market_cap_change_24h_pct, { label: 'market cap over 24 hours' })],
        ['Fully diluted valuation', fmtMarketFigure(m.fdv_usd, fmtCompactUsd) || unknownFigure('Fully diluted valuation', m.fdv_usd)],
        ['Volume, last 24h', fmtMarketFigure(m.volume_24h_usd, fmtCompactUsd) || unknownFigure('Volume', m.volume_24h_usd)],
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

function jobRow(ctx, pid, run, prov, projectName = pid, d = null) {
  const j = run.jobs[prov];
  const onHold = Boolean(onHoldOf(ctx.state.index, prov));
  const key = jobKey(j, run.created_at, { onHold });
  const hosted = Boolean(ctx.state.session && ctx.state.session.hosted);
  const st = researchState(key, { provider: prov, hosted });
  const actions = [];
  // A waiting job leads with its next step: on the online desk the sentence
  // for that model's assistant (in the state column, so it shows first even
  // where the table scrolls), with pasting by hand tucked under it.
  if (j.state === 'unconfigured' && !onHold) actions.push(...waitingActions(ctx, { pid, runId: run.run_id, provider: prov, key: `rt-${run.run_id}-${prov}`, instruction: false }));
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
  // A model on hold gets nothing new, so no retry is offered (the server
  // refuses one too).
  if (!onHold && (j.state === 'failed' || j.state === 'canceled')) {
    const b = button('Retry', null, { kind: 'small' });
    b.onclick = action(b, async () => { const r = await ctx.api.post(`/api/projects/${pid}/research/${run.run_id}/jobs/${prov}/retry`, {}); await ctx.refresh(); return r; }, (r) => r.message || 'Retry queued');
    actions.push(b);
  }
  if (!onHold && j.state === 'uncertain') {
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
  // A completed job keeps its first save apart from a later save for the same
  // run (the run follows the latest; both stay saved).
  const saves = jobSaves(j, d ? d.reports : []);
  const reportHref = (id) => `#/project/${encodeURIComponent(pid)}/report?report=${encodeURIComponent(id)}`;
  if (saves) actions.push(h('a', { class: 'btn small', href: reportHref(saves.original), dataset: { key: `job-orig-${run.run_id}-${prov}` } }, 'Open the original'), h('a', { class: 'btn small', href: reportHref(saves.latest), dataset: { key: `job-latest-${run.run_id}-${prov}` } }, 'Open the latest revision'));
  else if (j.report_id) actions.push(h('a', { class: 'btn small', href: reportHref(j.report_id) }, 'Open report'));
  const attempts = j.attempts || [];
  for (const a of attempts) if (reconcilable(j, a)) actions.push(reconcileForm(ctx, pid, run, prov, a));
  return {
    prov,
    state: key === 'waiting' && hosted ? h('div', { class: 'job-state' }, stateText('Waiting for you', st.tone), waitingStep(prov)) : stateText(st.long, st.tone),
    mode: h('span', { class: 'small' }, j.mode === 'manual' ? (hosted ? 'Its assistant\'s connection, or by hand' : 'By hand: paste the prompt, import the answer') : j.mode === 'cowork' ? 'Claude in Cowork' : j.mode === 'connector' ? `${PROVIDER_LABELS[prov]} through its desk connection` : j.mode === 'mock' ? 'Fictional demo adapter' : `API, in the background${j.model ? ` · ${j.model}` : ''}`),
    attempts: attempts.length ? h('div', { class: 'small' }, attempts.map((a) => attemptLine(a))) : h('span', { class: 'faint small' }, 'None'),
    error: j.error ? h('span', { class: 'small', style: { color: 'var(--neg)' } }, j.error) : saves ? h('span', { class: 'small' }, saves.text) : j.note ? h('span', { class: 'small muted' }, j.note) : null,
    actions: actions.length ? h('div', { class: 'btn-row' }, actions) : null,
  };
}

// A completed job whose model saved again for the same run: the first save
// completed the job (the original), the run now links the latest, and the
// revision record says what kind of save that was (revisions.js). Null for a
// job with one save. Pure, for the tests.
const REVISION_BASIS = { existing_evidence: 'a revision using existing evidence (no source added)', new_sources: 'a revision with new sources', scores_unchanged: 'a re-save with the same scores' };
export function jobSaves(j, reports = []) {
  const earlier = j && j.state === 'completed' && j.report_id && Array.isArray(j.previous_report_ids) ? j.previous_report_ids.filter(Boolean) : [];
  if (!earlier.length) return null;
  const latest = (reports || []).find((r) => r && r.report_id === j.report_id);
  const rv = latest && latest.revision && latest.revision.kind === 'revision' ? latest.revision : null;
  const kind = rv ? REVISION_BASIS[rv.basis] || 'a revision' : 'a later save';
  const between = earlier.length > 1 ? ` (${earlier.length - 1} more save${earlier.length === 2 ? '' : 's'} in between)` : '';
  return { original: earlier[0], latest: j.report_id, basis: rv ? rv.basis : null, text: `Completed by its first save, ${earlier[0]}. The run now links ${j.report_id}, ${kind}${between}. Both are kept.` };
}

// Why an answer stopped early, in words (research.js termination codes).
const TERMINATION_TEXT = {
  ended_before_message_stop: 'the connection ended before the answer was complete',
  stream_unreadable: 'the answer stream could not be read',
  max_tokens: 'it ran out of its output limit',
  pause_turn: 'it was still researching after the most requests allowed',
  pause_turn_not_resumable: 'it paused and could not be resumed exactly',
  refusal: 'the model declined',
  timeout: 'the time limit ran out',
  canceled: 'it was canceled',
  cancelled: 'it was cancelled',
  'incomplete: max_output_tokens': 'it ran out of its output limit',
};
const terminationText = (t) => TERMINATION_TEXT[t] || (/^error_event/.test(t) ? `the provider reported an error mid-answer${t.includes(':') ? ` (${t.split(': ')[1]})` : ''}` : String(t).replace(/_/g, ' '));

// One attempt: what happened, the usage the provider reported (or, for an
// answer that stopped early, what was seen before it stopped, labeled
// incomplete: a lower bound, never the bill), its cost, and whether it kept a
// partial answer (shown below the table, full width, by partialView).
function attemptLine(a) {
  const cost = attemptCost(a);
  const usage = a.usage
    ? h('span', { class: 'faint' }, ` · ${a.usage.input_tokens ?? '?'} in / ${a.usage.output_tokens ?? '?'} out tokens`)
    : a.partial_usage
      ? h('span', { class: 'faint', title: a.usage_note || '' }, ` · incomplete usage: at least ${a.partial_usage.input_tokens ?? '?'} in / ${a.partial_usage.output_tokens ?? '?'} out tokens before it stopped`)
      : null;
  return h('div', null,
    `#${a.n} ${PHASE_TEXT[a.phase] || String(a.phase || a.outcome || 'in progress').replace(/_/g, ' ')}`,
    usage,
    cost ? h('span', { class: a.phase === 'uncertain' ? null : 'faint' }, ` · ${cost}`) : null,
    a.response_sha256 ? h('span', { class: 'faint', title: `Raw response saved before normalization: ${a.response_path}${a.request_id ? ` · request ${a.request_id}` : ''}${a.response_id ? ` · response ${a.response_id}` : ''}` }, ` · response saved`) : null,
    a.partial_output ? h('span', null, ' · partial answer kept (below the table)') : null);
}

// The text an answer wrote before it stopped, loaded only when opened. Kept
// for reading only: it is never imported, graded or compared.
function partialView(ctx, pid, run, prov, a) {
  const url = `/api/projects/${pid}/research/${run.run_id}/jobs/${prov}/attempts/${a.n}/partial`;
  const key = `partial-${run.run_id}-${prov}-${a.n}`;
  const cached = textCache.has(url);
  const box = h('pre', { class: 'prompt-text pre small', 'data-keep-scroll': key, dataset: cached ? { loaded: '1' } : null }, cached ? textCache.get(url) : 'Loading the partial answer…');
  const view = h('details', { class: 'prompt-view', dataset: { key } },
    h('summary', null, `Partial answer kept: ${PROVIDER_LABELS[prov]}, attempt #${a.n} (${fmtNum(a.partial_output.chars)} characters; not a report, not graded)`),
    h('p', { class: 'small muted', style: { margin: '6px 0' } }, `What ${PROVIDER_LABELS[prov]} wrote before the answer stopped${a.termination ? ` (${terminationText(a.termination)})` : ''}. Kept for reading only: never saved as a report, graded or compared.`),
    box);
  const load = () => {
    if (!view.open || box.dataset.loaded) return;
    cachedText(ctx, url).then((t) => { box.textContent = t; box.dataset.loaded = '1'; }).catch((err) => { box.textContent = `The partial answer could not be loaded: ${err.message}`; });
  };
  view.addEventListener('toggle', load);
  // Opened again after a redraw: load at once.
  queueMicrotask(load);
  return view;
}

// The exact prompt every model got, readable on the page (a phone has no
// easy way to look at copied text), loaded only when opened.
// provider: what that model is given, its frozen execution note first (only
// ChatGPT's jobs have one), then the same prompt.
export function promptView(ctx, pid, run, { provider = null, label = 'Show the exact prompt' } = {}) {
  const promptUrl = `/api/projects/${pid}/research/${run.run_id}/prompt${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`;
  const key = provider ? `prompt-${run.run_id}-${provider}` : `prompt-${run.run_id}`;
  // Already read once: shown at once, so a redraw keeps its scroll position.
  const cached = textCache.has(promptUrl);
  const promptBox = h('pre', { class: 'prompt-text pre small', 'data-keep-scroll': key, dataset: cached ? { loaded: '1' } : null }, cached ? textCache.get(promptUrl) : 'Loading the prompt…');
  const view = h('details', { class: 'prompt-view', dataset: { key } }, h('summary', null, label), promptBox);
  const load = () => {
    if (!view.open || promptBox.dataset.loaded) return;
    cachedText(ctx, promptUrl).then((t) => { promptBox.textContent = t; promptBox.dataset.loaded = '1'; }).catch((err) => { promptBox.textContent = `The prompt could not be loaded: ${err.message}`; });
  };
  view.addEventListener('toggle', load);
  // Opened again after a redraw: load at once.
  queueMicrotask(load);
  return view;
}

// The models in a run whose jobs carry an execution note (ChatGPT's, from
// 2026-10-03 on).
const noted = (run) => (run.providers || []).filter((p) => run.jobs[p] && run.jobs[p].execution && run.jobs[p].execution.ref);

// The research runs (with the standing prompt files) and the token identity,
// two folded sections of the Brief.
function researchParts(ctx, d, row, route = null) {
  const pid = d.project.project_id;
  const runs = d.research.runs || [];
  const wantRun = route ? route.query.get('run') : null;
  const runCards = runs.map((run) => {
    const promptUrl = `/api/projects/${pid}/research/${run.run_id}/prompt`;
    const copy = button('Copy prompt', null, { kind: 'small' });
    copy.onclick = action(copy, async () => { await copyText(await cachedText(ctx, promptUrl)); return undefined; });
    return card(h('span', { class: 'pill-row' }, h('span', null, `Run of ${fmtDateTime(run.created_at)}`), h('span', { class: 'small muted' }, (run.status || '').replace(/_/g, ' '))), [
      (table([
        { label: 'Model', render: (x) => PROVIDER_LABELS[x.prov] },
        { label: 'State', render: (x) => x.state },
        { label: 'Route', render: (x) => x.mode },
        { label: 'Attempts', render: (x) => x.attempts },
        { label: 'Note', wrap: true, render: (x) => x.error },
        { label: '', render: (x) => x.actions },
      ], run.providers.filter((p) => run.jobs[p]).map((p) => jobRow(ctx, pid, run, p, d.project.name, d)))),
      ...run.providers.filter((p) => run.jobs[p]).flatMap((p) => (run.jobs[p].attempts || []).filter((a) => a.partial_output).map((a) => partialView(ctx, pid, run, p, a))),
      details('Run details', kv([
        ['Run ID', h('code', null, run.run_id)],
        ['Started by', `${run.created_by || '?'} via ${run.channel || '?'}`],
        run.utterance ? ['Request', `“${run.utterance}”`] : null,
        ['Rubric · profile · horizon', `${run.rubric_version} · ${run.sector_profile} · ${run.horizon ? run.horizon.text : '?'}`],
        ['Prompt', h('span', null, `${run.prompt.version}, identical for every model · SHA-256 ${run.prompt.sha256.slice(0, 12)}… `, copy)],
        // A model's own execution note (ChatGPT's), frozen with its job.
        noted(run).length ? ['Execution notes', noted(run).map((p) => `${PROVIDER_LABELS[p]}: ${run.jobs[p].execution.ref} · SHA-256 ${String(run.jobs[p].execution.sha256).slice(0, 12)}…, given before the same prompt`).join(' · ')] : null,
        ['Evidence packet', `captured ${fmtDateTime(run.evidence_packet.captured_at)} · SHA-256 ${run.evidence_packet.sha256.slice(0, 12)}… · no holdings, notes or other models' conclusions`],
      ]), { id: `run-${run.run_id}`, open: run.run_id === wantRun }),
      promptView(ctx, pid, run),
      ...noted(run).map((p) => promptView(ctx, pid, run, { provider: p, label: `Show what ${PROVIDER_LABELS[p]} gets: its execution note, then the same prompt` })),
    ], { id: `run-card-${run.run_id}` });
  });
  const legacy = d.prompt_files || [];
  // What a new run would use, and the standing prompt files rebuilt to it.
  const rc = d.research_contract || null;
  const stale = rc ? legacy.filter((f) => /^(claude|chatgpt|gemini)\.md$/.test(f.name) && f.prompt_version && f.prompt_version !== rc.prompt_version) : [];
  const rebuild = button('Rebuild with the current prompt', null, { kind: 'small', key: 'rt-rebuild-prompts' });
  rebuild.onclick = action(rebuild, async () => { await ctx.api.post(`/api/projects/${pid}/prompts`, {}); await ctx.refresh(); return true; }, 'Prompt files rebuilt');
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
  return {
    runs: h('div', null,
    card('Research runs', [
      h('p', { class: 'small muted', style: { margin: 0 } }, 'Each run sends every chosen model the same prompt, rubric, horizon and dated evidence packet. Jobs are independent: one failure never erases another model\'s result. Pending means not saved yet.'),
      rc ? h('p', { class: 'small', style: { margin: '8px 0 0' } }, `A new run uses ${rc.prompt_version} with the scoring profile ${rc.sector_profile}${rc.category_grades ? ` (${rc.category_grades} category grades)` : ''} and ${rc.rubric_version}. Earlier runs and their reports keep the prompt, profile and rubric they were made with.`) : null,
    ], { actions: [button(runs.length ? 'Run research again' : 'Run research', () => openResearchDialog(ctx, { ...row, ...d.project, research: row.research, report_count: d.reports.length }), { kind: 'small primary', key: 'rt-run' })] }),
    runs.length ? runCards : callout('No research runs yet.', 'info'),
      card('Standing prompt files', [
        h('p', { class: 'small muted' }, 'The general prompt for this project, one file per model, without a run\'s dated context. Each research run keeps its own exact prompt.'),
        stale.length ? h('p', { class: 'small' }, `These files were written with ${stale[0].prompt_version}; a new run uses ${rc.prompt_version}. Rebuild them to read the current prompt here.`) : null,
        h('div', { class: 'btn-row', style: { marginBottom: '8px' } }, rebuild),
        (table([
          { label: 'File', render: (f) => h('code', { class: 'small' }, f.name) },
          { label: 'Version', render: (f) => h('span', { class: 'small' }, f.prompt_version || '?') },
          { label: 'Updated', render: (f) => fmtAgo(f.updated_at) },
          { label: '', render: (f) => { const b = button('Copy', null, { kind: 'small' }); b.setAttribute('aria-label', `Copy ${f.name}`); b.onclick = action(b, async () => { await copyText(await ctx.api.text(`/api/projects/${pid}/prompt-file?name=${encodeURIComponent(f.name)}`)); return undefined; }); return b; } },
        ], legacy, { empty: 'No prompt files.' })),
      ])),
    identity: card(null, [
      id.status === 'verified' ? callout('Verified: bound to the token below. Prices and holdings use this identity.', 'ok') : callout(`Pending: ${(id.unknowns || []).join(' ')} No prices or holdings use a pending identity.`, 'warn'),
      (id.evidence || []).length ? h('ul', { class: 'list small' }, id.evidence.map((e) => h('li', null, h('a', { href: e.url }, e.url), e.note ? ` — ${e.note}` : '', h('span', { class: 'faint' }, ` (checked ${fmtDate(e.checked_at)})`)))) : null,
      idForm,
    ]),
  };
}
