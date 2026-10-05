// The Claude Brief (#/brief/<project>[?report=<report>]): one page that reads
// one saved Claude report as a decision brief for the position horizon. The
// verdict and the desk's calculated grade first, then the thesis, the
// scorecard, what supports and what threatens it, what to watch, the
// scenarios, and the evidence and records it is drawn from; your own note
// last, apart from Claude's.
//
// It reads the saved project record (cached from the inspector) and the index
// the page already has: opening or closing it never refreshes prices, never
// screens a contract, never asks DexScreener or TradingView, and never starts
// research. Report text is data, shown as text. Back, Escape and its Back
// control return to where it was opened (the watchlist keeps its inspector,
// filters and place). A phone gets the whole screen.
import {
  h, details, logo, gradeGauge, coverageMeter, unscoredList, structureNotes, fmtDate, fmtDateTime, fmtAsOf, fmtRelDay,
  icon, stateText, button, callout, scoreTier, PROVIDER_LABELS, COVERAGE_MEANS,
} from '../ui.js';
import { briefModel, TAG_WORDS, CERTAINTY_WORDS } from '../brief-model.js';
import { evidenceChecksBlock, sourceItem } from './project.js';
import { evidenceQuality } from './inspector.js';
import { chartCycleBlock, CONFIDENCE_LABELS } from '../thesis-ui.js';
import { openResearchDialog } from './dialogs.js';

const PROVIDER = 'claude';
const WHO = PROVIDER_LABELS[PROVIDER];
const enc = encodeURIComponent;
const briefHref = (pid, rid = null) => `#/brief/${enc(pid)}${rid ? `?report=${enc(rid)}` : ''}`;
const reportHref = (pid, rid) => `#/project/${enc(pid)}/reports?report=${enc(rid)}`;
const runHref = (pid, runId) => `#/project/${enc(pid)}/research${runId ? `?run=${enc(runId)}` : ''}`;
const plainClick = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

// Leaving the brief: back to the entry it was opened from (the watchlist with
// its inspector, or the project page), else to the project in the watchlist.
export function closeBrief(ctx, pid) {
  const st = history.state;
  if (st && st.crBrief === pid) history.back();
  else ctx.navigate(`#/watchlist?p=${enc(pid)}`, { replace: true });
}

// A link that changes which report the brief reads, without a new entry. (The
// links that open the brief are ui.js briefLink.)
function inBrief(ctx, href, text, key, cls = null) {
  const a = h('a', { href, class: cls, dataset: { key } }, text);
  a.addEventListener('click', (e) => {
    if (!plainClick(e)) return;
    e.preventDefault();
    ctx.navigate(href, { replace: true, state: history.state });
  });
  return a;
}

// ---- small pieces ----------------------------------------------------------------

const scoreWords = (x) => (x.status === 'scored' ? String(x.value) : x.status === 'range' ? `${x.low}–${x.high}` : x.status === 'na' ? 'N/A' : x.status === 'missing' ? 'Not graded' : 'Unknown');
const clampPct = (v) => Math.max(0, Math.min(100, Number(v)));

// A quality bar on the one 0–100 spectrum: a fill in its tier, a hatched span
// for a range (never a midpoint), an empty dashed track for unknown.
function qualityBar(x) {
  if (x.status === 'scored') return h('span', { class: 'cbar' }, h('span', { class: `fill tier-${x.tier}`, style: { width: `${clampPct(x.value)}%` } }));
  if (x.status === 'range') return h('span', { class: 'cbar' }, h('span', { class: `range tier-${x.tier}`, style: { left: `${clampPct(x.low)}%`, width: `${Math.max(2, clampPct(x.high) - clampPct(x.low))}%` } }));
  return h('span', { class: 'cbar unknown' });
}

// A downside-risk bar: it grows from the right edge (higher is more risk), in
// the risk colour, so it never reads like a quality bar.
function riskBar(x) {
  if (x.status === 'scored') return h('span', { class: 'bf-rbar' }, h('span', { class: 'fill', style: { width: `${clampPct(x.value)}%` } }));
  if (x.status === 'range') return h('span', { class: 'bf-rbar' }, h('span', { class: 'fill range', style: { right: `${clampPct(x.low)}%`, width: `${Math.max(2, clampPct(x.high) - clampPct(x.low))}%` } }));
  return h('span', { class: 'bf-rbar unknown' });
}

const CONF_LETTER = { high: 'H', medium: 'M', low: 'L' };
const confMark = (c) => (c && CONF_LETTER[c] ? h('span', { class: 'bf-conf', title: `${CONFIDENCE_LABELS[c]} confidence, as ${WHO} states it` }, CONF_LETTER[c]) : null);

function tagChips(tags) {
  if (!tags.length) return [h('span', { class: 'bf-tag none' }, 'No claim cited')];
  return tags.map((t) => h('span', { class: `bf-tag t-${t.toLowerCase()}`, title: `[${t}] ${TAG_WORDS[t]}` }, TAG_WORDS[t]));
}

// "Oct 20 – 27, 2026", "Oct 20 – Nov 19, 2026", "Oct 20, 2026", or the year
// on both ends.
function windowWords(start, end) {
  if (!start) return 'Date unknown';
  if (!end || end === start) return fmtDate(start);
  const a = fmtDate(start);
  const b = fmtDate(end);
  if (start.slice(0, 7) === end.slice(0, 7)) return `${a.replace(/, \d{4}$/, '')} – ${b.replace(/^[A-Za-z]+ /, '')}`;
  return start.slice(0, 4) === end.slice(0, 4) ? `${a.replace(/, \d{4}$/, '')} – ${b}` : `${a} – ${b}`;
}

function sec(id, title, ...children) {
  return h('section', { class: `bf-sec bf-${id}`, id: `bf-${id}`, 'aria-labelledby': `bf-h-${id}` },
    h('h2', { class: 'bf-h', id: `bf-h-${id}` }, title), ...children);
}

const none = (text) => h('p', { class: 'bf-none' }, text);

// ---- the bar and the header ------------------------------------------------------------

function topBar(ctx, m, pid) {
  const from = history.state && history.state.crBrief === pid ? history.state.from : null;
  const back = h('a', { class: 'bf-back', href: `#/watchlist?p=${enc(pid)}`, dataset: { key: 'brief-back' }, 'aria-label': `Close the brief and return to ${from === 'project' ? `the ${m.identity.name} page` : 'the watchlist'}`, title: 'Back (Esc)' },
    h('span', { class: 'bf-chev', 'aria-hidden': 'true' }), h('span', null, from === 'project' ? 'Project' : 'Watchlist'));
  back.addEventListener('click', (e) => {
    if (!plainClick(e)) return;
    e.preventDefault();
    closeBrief(ctx, pid);
  });
  return h('div', { class: 'bf-bar' },
    back,
    h('p', { class: 'bf-bar-title', 'aria-hidden': 'true' }, h('span', { class: 'bf-bar-k' }, `${WHO} Brief`), h('span', { class: 'bf-bar-name' }, m.identity.name)),
    h('div', { class: 'bf-bar-act' },
      m.report_id ? h('a', { class: 'btn small', href: reportHref(pid, m.report_id), dataset: { key: 'brief-report' } }, 'Full report') : null));
}

function chainLine(id) {
  const parts = [];
  if (id.native) parts.push(h('span', { class: 'bf-chip' }, 'Native coin'));
  for (const c of id.chains) parts.push(h('span', { class: 'bf-chip', title: c.addresses.join('\n') || null }, c.label));
  parts.push(h('span', { class: `bf-idstate${id.verified ? ' ok' : ' warn'}`, title: id.verified ? 'The token identity is verified: these are the chains and contracts on record' : 'The token identity is not verified yet' }, id.verified ? 'Verified identity' : 'Identity pending'));
  if (id.website) {
    let host = id.website;
    try { host = new URL(id.website).hostname.replace(/^www\./, ''); } catch (_) { /* as given */ }
    parts.push(h('a', { class: 'bf-web', href: id.website, title: `Official website: ${host}` }, host));
  }
  return h('p', { class: 'bf-chain' }, parts);
}

function marketLine(mk) {
  if (!mk) return null;
  const dir = mk.change === null ? null : mk.change > 0 ? 'up' : mk.change < 0 ? 'down' : 'flat';
  return h('p', { class: 'bf-market', title: `${mk.source}${mk.as_of ? `, as of ${fmtDateTime(mk.as_of)}` : ''}. A market observation, not part of the research.` },
    h('span', { class: 'k' }, 'Market now'),
    h('span', { class: 'fig' }, mk.price),
    mk.change24h ? h('span', { class: `fig bf-chg ${dir}` }, h('span', { 'aria-hidden': 'true' }, mk.change24h), h('span', { class: 'sr-only' }, `${dir === 'down' ? 'down' : dir === 'up' ? 'up' : 'unchanged'} ${Math.abs(mk.change).toFixed(2)} percent over 24 hours`)) : null,
    mk.mcap ? h('span', null, h('span', { class: 'k2' }, 'MC '), h('span', { class: 'fig' }, mk.mcap)) : null,
    mk.volume ? h('span', null, h('span', { class: 'k2' }, 'Vol 24h '), h('span', { class: 'fig' }, mk.volume)) : null,
    h('span', { class: `bf-when${mk.stale ? ' stale' : ''}` }, `${mk.source}${mk.as_of ? ` · ${fmtAsOf(mk.as_of)}` : ''}${mk.stale ? ' · stale' : ''}`));
}

function header(ctx, m, row, pid) {
  const id = m.identity;
  const lg = logo({ ...(row || {}), project_id: pid, name: id.name, symbol: id.symbol }, { size: 44 });
  const facts = [];
  if (m.report_id) {
    const a = m.report.assessment || {};
    const rel = fmtRelDay(a.analysis_at);
    facts.push(h('div', null, h('dt', null, 'Analysis'), h('dd', null, a.analysis_at ? fmtDate(a.analysis_at) : 'Date not stated', rel ? h('span', { class: 'faint' }, ` · ${rel}`) : null)));
    const hz = m.watch.horizon;
    facts.push(h('div', null, h('dt', null, 'Horizon'), h('dd', null,
      hz.start && hz.end ? windowWords(hz.start, hz.end) : hz.text || 'Not stated',
      hz.months ? h('span', { class: 'faint' }, ` · ${hz.months} month${hz.months === 1 ? '' : 's'}${hz.mode === 'long_term' ? ', long-term exception' : ''}`) : null)));
    facts.push(h('div', null, h('dt', null, 'Report'), h('dd', null, m.is_latest ? `${WHO}'s latest` : 'An earlier report', h('span', { class: 'faint' }, ` · saved ${fmtDate(m.provenance.saved_at)}`))));
  }
  return h('header', { class: 'bf-head' },
    h('div', { class: 'bf-id' }, lg,
      h('div', { class: 'bf-id-text' },
        h('p', { class: 'bf-eyebrow' }, `${WHO} Brief`),
        h('h1', { id: 'bf-title', tabindex: '-1' }, h('span', { class: 'bf-name' }, id.name), id.symbol ? h('span', { class: 'bf-sym' }, id.symbol) : null),
        chainLine(id))),
    facts.length ? h('dl', { class: 'bf-meta' }, facts) : null,
    marketLine(m.market));
}

// ---- the verdict ---------------------------------------------------------------------------

function gradeBlock(m) {
  const g = m.grade;
  const cap = (text) => h('p', { class: 'bf-gcap', title: `Calculated by the desk from ${WHO}'s six weighted component scores under ${g.rubric || 'its rubric'}; never ${WHO}'s own total` }, text);
  if (g.status === 'firm' || g.status === 'range') {
    return h('div', { class: 'bf-grade' }, gradeGauge(g.grade, { word: g.word, serious: m.evidence.level === 'serious' }), cap(g.status === 'range' ? 'Investment grade · a range' : 'Investment grade'));
  }
  if (g.status === 'withheld') {
    const w = g.why;
    return h('div', { class: 'bf-grade withheld' },
      h('p', { class: 'bf-wh' }, 'Grade withheld'),
      typeof g.coverage === 'number' ? h('div', { title: COVERAGE_MEANS }, coverageMeter(g.coverage, { compact: true })) : h('p', { class: 'bf-none' }, g.reason || 'No grade is calculated.'),
      cap('Investment grade'));
  }
  return h('div', { class: 'bf-grade withheld' }, h('p', { class: 'bf-wh' }, 'No grade'), h('p', { class: 'bf-none' }, g.reason || 'No grade was calculated.'), cap('Investment grade'));
}

const NOTICE_ICON = { older: 'clock', revision: 'refresh', model_total: 'warn-line', model_total_unchecked: 'question', evidence: 'warn-line', newer: 'refresh', horizon: 'warn-line', prose: 'file', corrections: 'file', extraction: 'warn-line', timing: 'clock' };

function noticeItem(ctx, n, m, pid) {
  let main;
  let more = null;
  if (n.kind === 'older') {
    main = [h('strong', null, 'An earlier report. '), `${WHO}'s latest is from ${fmtDate(n.latest_at)}. `, inBrief(ctx, briefHref(pid), 'Open the latest brief', 'brief-latest')];
  } else if (n.kind === 'revision') {
    const what = n.changed.length ? n.changed.join('; ') : n.categories ? `${n.categories} category grade${n.categories === 1 ? '' : 's'} changed` : 'no score changed';
    const basis = n.basis === 'existing_evidence' ? 'using existing evidence' : `with ${n.added} new source${n.added === 1 ? '' : 's'}`;
    main = n.basis === 'scores_unchanged'
      ? [h('strong', null, 'A re-save'), ' of an earlier save for the same run, with the same scores.']
      : [h('strong', null, 'A revision'), ` of an earlier save for the same run, ${basis}: ${what}.`];
    more = h('div', null,
      h('p', null, n.declared && n.declared.note ? `${WHO}'s reason${n.declared.label ? ` (${n.declared.label.split(':')[0].toLowerCase()})` : ''}: ${n.declared.note}` : 'No reason was recorded with this save.'),
      n.minutes !== null ? h('p', null, `Saved ${n.minutes} min after the first save; both are kept.`) : null,
      n.of ? h('p', null, h('a', { href: reportHref(pid, n.of), dataset: { key: 'brief-rev-of' } }, 'Open the earlier save')) : null);
  } else if (n.kind === 'model_total') {
    main = [h('strong', null, `${WHO}'s own total differs`), n.difference !== null ? ` by ${n.difference.toFixed(1)}` : '', `: it wrote ${n.reported || '?'}, the desk calculates ${n.calculated || '?'}. The grade shown is the desk's.`];
    more = n.message ? h('p', null, n.message) : null;
  } else if (n.kind === 'model_total_unchecked') {
    main = [`${WHO} wrote its own total of ${n.reported || '?'}; with the grade withheld it cannot be checked.`];
  } else if (n.kind === 'evidence') {
    const what = [n.claims ? `${n.claims} claim${n.claims === 1 ? '' : 's'}` : null, n.categories ? `${n.categories} category grade${n.categories === 1 ? '' : 's'}` : null].filter(Boolean).join(' and ') || 'parts of the report';
    // A jump inside the page, so a button (a "#..." link would be read as a route).
    const jump = h('button', { type: 'button', class: 'link', dataset: { key: 'brief-ev-jump' } }, 'See the flags');
    jump.addEventListener('click', () => {
      const d = document.querySelector('[data-key="brief-checks"]');
      if (d) {
        d.open = true;
        d.scrollIntoView({ block: 'start' });
        const s = d.querySelector('summary');
        if (s) s.focus({ preventScroll: true });
      }
    });
    main = [h('strong', null, n.level === 'serious' ? 'Serious evidence flag' : 'Evidence flag'), ` · ${what} flagged by the desk's evidence checks. No score is changed. `, jump];
  } else if (n.kind === 'newer') {
    main = [h('strong', null, n.text), '. This brief stays on the saved report until a new one is saved.'];
  } else if (n.kind === 'horizon') {
    main = ['This report\'s horizon differs from its research run\'s: read its timing views with care.'];
  } else if (n.kind === 'prose') {
    main = ['Read from the written report, without a data block: only labeled scores were read.'];
  } else if (n.kind === 'corrections') {
    main = [`Your ${n.count} correction${n.count === 1 ? ' is' : 's are'} applied`, n.fields.length ? `: ${n.fields.join(', ')}` : '', '. The original is unchanged.'];
  } else if (n.kind === 'extraction') {
    main = [[n.errors ? `${n.errors} extraction error${n.errors === 1 ? '' : 's'}` : null, n.ambiguous ? `${n.ambiguous} ambiguous value${n.ambiguous === 1 ? '' : 's'}` : null].filter(Boolean).join(' and '), ' in this report. ', h('a', { href: reportHref(pid, m.report_id), dataset: { key: 'brief-extraction' } }, 'Open the report')];
  } else if (n.kind === 'timing') {
    main = [`The report states an analysis time ${n.minutes !== null && n.minutes < 2880 ? `${n.minutes} min` : 'more than a day'} after it was saved; it is ordered by its save time.`];
  } else return null;
  const body = h('span', { class: 'bf-ntext' }, main);
  const li = h('li', { class: `bf-notice tone-${n.tone}${n.kind === 'evidence' ? ` ev-${n.level}` : ''}` }, icon(NOTICE_ICON[n.kind] || 'alert'), body);
  if (more) {
    const d = h('details', { class: 'bf-nmore', dataset: { key: `brief-n-${n.kind}` } }, h('summary', null, 'Why'), h('div', { class: 'bf-nbody' }, more));
    body.append(' ', d);
  }
  return li;
}

function verdictSection(ctx, m, pid) {
  const v = m.verdict;
  // The next dated event still ahead and the suggested review, from What to
  // watch, so the dates that matter are in the first view.
  const w = m.watch;
  const next = w.items.find((x) => x.kind === 'catalyst' && (x.end || x.start) >= w.today) || null;
  const review = w.review && w.review.start >= w.today ? w.review : null;
  const views = [
    v.timing ? h('span', { class: 'bf-view', title: v.timing.rationale || null }, h('span', { class: 'k' }, 'Timing'), v.timing.word) : null,
    v.market ? h('span', { class: 'bf-view', title: v.market.rationale || null }, h('span', { class: 'k' }, 'Market'), v.market.word) : null,
    next ? h('span', { class: 'bf-view', title: `${next.title} · ${CERTAINTY_WORDS[next.certainty]}` }, h('span', { class: 'k' }, 'Next'), h('span', { class: 'bf-view-t' }, next.title), h('span', { class: 'bf-dot', 'aria-hidden': 'true' }, '·'), h('span', { class: 'fig' }, windowWords(next.start, next.end))) : null,
    review ? h('span', { class: 'bf-view', title: review.trigger ? `Sooner if: ${review.trigger}` : null }, h('span', { class: 'k' }, 'Review'), h('span', { class: 'fig' }, fmtDate(review.start))) : null,
  ].filter(Boolean);
  // The summary is the verdict's reason in a few sentences; without one, the
  // final judgment takes its place (and is then not repeated below).
  const lead = v.summary || v.final_take;
  const notices = m.notices.map((n) => noticeItem(ctx, n, m, pid)).filter(Boolean);
  return sec('verdict', `${WHO}'s verdict`,
    h('div', { class: 'bf-vgrid' },
      gradeBlock(m),
      h('div', { class: 'bf-vtext' },
        h('p', { class: 'bf-vlabel', title: 'The verdict as the report writes it' }, v.label || h('span', { class: 'faint' }, 'No verdict given')),
        lead ? h('p', { class: 'bf-lead' }, lead) : none(`No summary in ${WHO}'s data block.`),
        views.length ? h('p', { class: 'bf-views', title: `${WHO}'s own views for this horizon; they change no score` }, views) : null)),
    m.grade.status === 'withheld' && m.grade.why.items.length ? h('div', { class: 'bf-missing' }, h('h3', null, 'Not scored'), unscoredList(m.grade.why, { max: 320 }),
      m.structure ? details(`Check · ${m.structure.flags.length} note${m.structure.flags.length === 1 ? '' : 's'}`, structureNotes(m.structure, { max: 6 }), { id: 'brief-structure' }) : null) : null,
    notices.length ? h('ul', { class: 'bf-notices', 'aria-label': 'Before you rely on this brief' }, notices) : null);
}

// ---- the thesis -------------------------------------------------------------------------------

function sourceWord(ans) {
  if (ans.from === 'category') return `${WHO}'s reasoning for its ${ans.label.toLowerCase()} grade (${ans.status === 'range' ? `${ans.low}–${ans.high}` : ans.value})`;
  if (ans.from === 'component') {
    const s = ans.score;
    const sc = !s ? 'not scored' : s.status === 'scored' ? String(s.value) : s.status === 'range' ? `${s.low}–${s.high}` : s.status === 'not_applicable' ? 'N/A' : 'unknown';
    return `${WHO}'s reasoning for the ${ans.label.toLowerCase()} component (${ans.weight_pct}% of the grade, ${sc})`;
  }
  return `${WHO}'s ${ans.kind || 'view'}: ${ans.label.toLowerCase()}`;
}

function valueFlow(v) {
  if (!v.show) return null;
  return h('div', { class: 'bf-flow', role: 'group', 'aria-label': 'Where the value goes, as the report quantifies it' },
    v.layers.map((l, i) => [
      i ? h('span', { class: 'bf-flow-sep', 'aria-hidden': 'true' }) : null,
      h('div', { class: `bf-layer${l.items.some((x) => x.reported) ? '' : ' none'}` },
        h('p', { class: 'bf-layer-t' }, l.title),
        l.items.length ? h('dl', null, l.items.map((x) => h('div', { title: x.definition || null },
          h('dt', null, x.label),
          h('dd', null, x.reported ? [h('span', { class: 'fig' }, x.text), x.tag ? h('span', { class: `bf-tag t-${x.tag.toLowerCase()}`, title: `[${x.tag}] ${TAG_WORDS[x.tag]}` }, TAG_WORDS[x.tag]) : null,
            [x.period, x.as_of ? `as of ${x.as_of}` : null].filter(Boolean).length ? h('span', { class: 'bf-when' }, [x.period, x.as_of ? `as of ${x.as_of}` : null].filter(Boolean).join(' · ')) : null]
            : h('span', { class: 'faint' }, 'Not reported'))))) : h('p', { class: 'bf-none' }, 'Not part of this profile')),
    ]));
}

function thesisSection(m) {
  const v = m.verdict;
  const items = m.thesis.map((t) => h('div', { class: 'bf-q' },
    h('h3', null, t.title),
    t.answer ? [
      h('p', { class: 'bf-qtext' }, t.answer.text),
      t.answer.from === 'judgment' && t.answer.test ? h('p', { class: 'bf-qtest' }, h('span', { class: 'k' }, 'Would be wrong if'), t.answer.test) : null,
      h('p', { class: 'bf-qsrc' }, sourceWord(t.answer)),
    ] : none(`Not stated in ${WHO}'s report.`),
    t.id === 'capture' ? valueFlow(m.value) : null));
  // The final judgment, unless it already stands in for a missing summary.
  const final = v.summary && v.final_take ? h('div', { class: 'bf-final' }, h('h3', null, `${WHO}'s final judgment`), h('p', { class: 'bf-qtext' }, v.final_take)) : null;
  // An older or prose report may answer none of it: one line says so.
  if (!m.thesis.some((t) => t.answer) && !final && !m.value.show) return sec('thesis', 'The thesis', none(`${WHO}'s report has no thesis fields to draw from; the full report has its reasoning.`));
  return sec('thesis', 'The thesis', h('div', { class: 'bf-qs' }, items), final);
}

// ---- the scorecard ------------------------------------------------------------------------------

function componentsBlock(m) {
  const g = m.grade;
  const rows = m.components.map((c) => {
    const x = { status: c.status === 'not_applicable' ? 'na' : ['scored', 'range', 'missing'].includes(c.status) ? c.status : 'unknown', value: c.score ? c.score.value : null, low: c.score ? c.score.low : null, high: c.score ? c.score.high : null };
    x.tier = scoreTier(x.status === 'range' ? x.low : x.value);
    const why = c.rationale || c.missing;
    return h('li', { class: `bf-comp${x.status === 'scored' || x.status === 'range' ? '' : ' is-unknown'}` },
      h('details', { dataset: { key: `brief-comp-${c.id}` } },
        h('summary', { 'aria-label': `${c.label}, ${c.weight_pct} percent of the grade: ${scoreWords(x)}${c.contribution !== null ? `, adds ${c.contribution.toFixed(1)} points` : ''}. Open for the reason` },
          h('span', { class: 'bf-cname', 'aria-hidden': 'true' }, c.label, h('span', { class: 'bf-w' }, `${c.weight_pct}%`)),
          h('span', { class: 'bf-cbar', 'aria-hidden': 'true' }, qualityBar(x)),
          h('span', { class: 'bf-cv', 'aria-hidden': 'true' }, scoreWords(x)),
          h('span', { class: 'bf-pts', 'aria-hidden': 'true' }, c.contribution !== null ? `+${c.contribution.toFixed(1)}` : '')),
        h('div', { class: 'bf-cbody' }, why ? h('p', null, why) : none('No reason given.'))));
  });
  const total = g.status === 'firm' ? g.display : g.status === 'range' ? g.display : null;
  const how = details('How the grade is calculated', h('div', { class: 'bf-how' },
    h('p', null, `Each component's score is multiplied by its weight and the results are added${total ? `: together ${total}` : ''}. The weights come from ${g.rubric || 'the report\'s rubric'} and are never adjusted.`),
    h('p', null, `A range stays a range: the grade then runs from the low ends to the high ends. If any component is unknown, no grade is calculated and the scored share of the weight is shown instead.`),
    h('p', null, `The category grades and the downside-risk scores are shown apart and never averaged in; ${WHO}'s own total, if it wrote one, is kept beside the grade, never in its place.`)), { id: 'brief-how' });
  return h('div', { class: 'bf-block' },
    h('h3', { class: 'bf-h3' }, 'What the grade is calculated from', h('span', { class: 'bf-h3-sub' }, 'six weighted components')),
    h('ul', { class: 'bf-comps', 'aria-label': 'The six weighted components of the investment grade, 0 to 100, higher is better' }, rows),
    how);
}

function categoryItem(x) {
  if (x.status === 'na') {
    return h('li', { class: 'bf-cat na' }, h('div', { class: 'bf-catrow' }, h('span', { class: 'bf-cname', title: x.na_reason || x.label }, x.label), h('span', { class: 'bf-cv faint' }, 'N/A')));
  }
  const scored = x.status === 'scored' || x.status === 'range';
  const serious = x.flags.some((f) => f.severity === 'high');
  const flag = x.flags.length ? h('span', { class: `bf-flag ${serious ? 'serious' : 'material'}`, title: x.flags.map((f) => f.text).join(' ') }, h('span', { class: 'sr-only' }, serious ? 'serious evidence flag' : 'evidence flag')) : null;
  const item = (k, val) => (val ? [h('dt', null, k), h('dd', null, val)] : []);
  return h('li', { class: `bf-cat${scored ? '' : ' is-unknown'}` },
    h('details', { dataset: { key: `brief-cat-${x.id}` } },
      h('summary', { 'aria-label': `${x.label}: ${scored ? `${scoreWords(x)} out of 100${x.word ? `, ${x.word}` : ''}${x.confidence ? `, ${CONFIDENCE_LABELS[x.confidence].toLowerCase()} confidence` : ''}` : scoreWords(x)}${x.flags.length ? `; ${serious ? 'serious evidence flag' : 'evidence flag'}` : ''}. Open for the reasons` },
        h('span', { class: 'bf-cname', 'aria-hidden': 'true', title: x.definition || null }, x.label, flag),
        h('span', { class: 'bf-cbar', 'aria-hidden': 'true' }, qualityBar(x)),
        h('span', { class: 'bf-cv', 'aria-hidden': 'true' }, scoreWords(x), confMark(x.confidence))),
      h('div', { class: 'bf-cbody' },
        x.word ? h('p', { class: 'bf-word' }, x.word) : null,
        x.flags.map((f) => h('p', { class: `bf-flagline ${f.severity === 'high' ? 'serious' : 'material'}` }, h('strong', null, f.severity === 'high' ? 'Serious evidence flag. ' : 'Evidence flag. '), f.text, ' The grade is shown as written.')),
        h('dl', null,
          ...item(scored ? 'Why this grade' : 'Why unknown', scored ? x.rationale || 'No reason given.' : x.status === 'missing' ? 'Not graded in this report.' : x.missing || 'Not stated.'),
          ...item('Strongest evidence', x.strongest_evidence),
          ...item('Main weakness', x.main_weakness),
          ...item('Would raise it', x.would_raise),
          ...item('Would lower it', x.would_lower)))));
}

function scorecardSection(m) {
  const c = m.categories;
  const counts = c.counts;
  const groups = c.groups.map((g) => {
    const graded = g.items.filter((x) => x.status === 'scored' || x.status === 'range').length;
    const total = g.items.filter((x) => x.status !== 'na').length;
    return h('div', { class: 'bf-group' },
      h('h4', null, g.title, h('span', { class: 'bf-gn' }, total ? `${graded} of ${total} graded` : 'not applicable')),
      h('ul', { class: 'bf-cats', 'aria-label': `${g.title}: category grades, 0 to 100, higher is better` }, g.items.map(categoryItem)));
  });
  return sec('scorecard', 'Scorecard',
    componentsBlock(m),
    h('div', { class: 'bf-block' },
      h('h3', { class: 'bf-h3' }, 'Category grades',
        h('span', { class: 'bf-h3-sub' }, `${counts.scored} of ${counts.total} graded${counts.unknown ? ` · ${counts.unknown} unknown` : ''} · diagnostics, never averaged into the grade`),
        m.older_profile ? h('span', { class: 'bf-h3-sub', title: `This report used ${m.older_profile.report}; new research uses ${m.older_profile.current}` }, ` · ${m.older_profile.report}`) : null),
      groups.length ? h('div', { class: 'bf-groups' }, groups) : none('This report grades no categories.')));
}

// ---- what supports it, what threatens it ------------------------------------------------------------

function factList(items, label) {
  if (!items.length) return none('None given in the report.');
  return h('ol', { class: 'bf-facts', 'aria-label': label }, items.map((f) => h('li', null,
    h('p', { class: 'bf-fact' }, f.text),
    h('p', { class: 'bf-cite' },
      tagChips(f.tags),
      f.sources.length ? [h('span', { class: 'bf-dot', 'aria-hidden': 'true' }, '·'), f.sources[0].url ? h('a', { href: f.sources[0].url, title: [f.sources[0].publisher, f.sources[0].accessed_at ? `accessed ${f.sources[0].accessed_at}` : null].filter(Boolean).join(' · ') || null }, f.sources[0].title || f.sources[0].publisher || f.sources[0].url) : h('span', null, f.sources[0].title || f.sources[0].source_id), f.sources.length > 1 ? h('span', { class: 'faint', title: f.sources.slice(1).map((s) => s.title || s.url || s.source_id).join('\n') }, `+${f.sources.length - 1} more`) : null] : null,
      f.claims.length ? h('span', { class: 'bf-ids', title: f.claims.map((c) => `${c.id}${c.as_of ? ` (as of ${c.as_of})` : ''}`).join(', ') }, f.claims.map((c) => c.id).join(' ')) : null,
      f.dangling.length ? h('span', { class: 'bf-dangling', title: 'These references are not in the report\'s claim or source list' }, `${f.dangling.join(', ')} not listed`) : null))));
}

function risksBlock(m) {
  const rows = m.risks.filter((x) => x.status !== 'na');
  if (!rows.length) return null;
  return h('div', { class: 'bf-risks' },
    h('h3', { class: 'bf-h3' }, 'Downside risk', h('span', { class: 'bf-h3-sub' }, 'higher is worse')),
    h('ul', { 'aria-label': 'Downside-risk scores, 0 to 100, higher means more risk' }, rows.map((x) => h('li', { class: `bf-risk${x.status === 'scored' || x.status === 'range' ? '' : ' is-unknown'}`, title: x.rationale || x.definition || null },
      h('span', { class: 'bf-cname' }, x.label.replace(/ risk$/i, '')),
      h('span', { class: 'bf-cbar', 'aria-hidden': 'true' }, riskBar(x)),
      h('span', { class: 'bf-cv' }, h('span', { 'aria-hidden': 'true' }, scoreWords(x)), h('span', { class: 'sr-only' }, x.status === 'scored' || x.status === 'range' ? ` out of 100, higher is more risk` : ''))))));
}

function forAgainstSection(m) {
  return h('div', { class: 'bf-two' },
    sec('supports', 'What supports it', factList(m.supports, `${WHO}'s strongest positives`)),
    sec('threatens', 'What threatens it', factList(m.threatens, `${WHO}'s strongest risks`), risksBlock(m)));
}

// ---- what to watch ---------------------------------------------------------------------------------

// The horizon as a track: the time gone by, today, each dated catalyst window
// and the suggested review, numbered as in the list under it (the list says
// everything the track shows).
function lanes(items) {
  const last = [];
  for (const x of items) {
    if (x.pos === null) continue;
    let lane = 0;
    while (last[lane] !== undefined && x.pos - last[lane] < 7) lane += 1;
    x.lane = Math.min(lane, 2);
    last[x.lane] = Math.max(x.pos_end ?? x.pos, x.pos);
  }
}

function horizonTrack(w) {
  const hz = w.horizon;
  if (!hz.start || !hz.end) return null;
  const onTrack = w.items.filter((x) => x.pos !== null);
  lanes(onTrack);
  const top = Math.max(0, ...onTrack.map((x) => x.lane || 0));
  const elapsed = w.ended ? 100 : w.today_pos === null ? (w.today < hz.start ? 0 : 100) : w.today_pos;
  const caption = w.ended ? 'The horizon has ended' : w.days ? `${w.days.left} of ${w.days.total} days left` : null;
  return h('div', { class: `bf-track l${top}${w.ended ? ' ended' : ''}` },
    h('div', { class: 'bf-lanes', 'aria-hidden': 'true' },
      h('div', { class: 'bf-rail' }, h('span', { class: 'bf-elapsed', style: { width: `${elapsed}%` } })),
      onTrack.map((x) => (x.kind === 'review'
        ? h('span', { class: `bf-pin lane-${x.lane || 0}`, style: { left: `${x.pos}%` } }, h('span', { class: 'bf-num' }, String(x.n)))
        : h('span', { class: `bf-win lane-${x.lane || 0}`, style: { left: `${x.pos}%`, width: `${Math.max(0, (x.pos_end ?? x.pos) - x.pos)}%` } }, h('span', { class: 'bf-num' }, String(x.n))))),
      w.today_pos !== null && !w.ended ? h('span', { class: 'bf-today', style: { left: `${w.today_pos}%` } }) : null),
    h('div', { class: 'bf-ends' },
      h('span', { class: 'fig' }, fmtDate(hz.start)),
      caption ? h('span', { class: 'bf-days' }, caption) : null,
      h('span', { class: 'fig' }, fmtDate(hz.end))));
}

function watchList(w) {
  if (!w.items.length) return null;
  return h('ol', { class: 'bf-events', 'aria-label': 'Dated catalysts and the suggested review, in date order' }, w.items.map((x) => h('li', { class: x.kind },
    h('span', { class: 'bf-num', 'aria-hidden': 'true' }, String(x.n)),
    h('div', null,
      h('p', { class: 'bf-ev-t' }, x.kind === 'review' ? `${WHO} suggests a review` : x.title),
      h('p', { class: 'bf-ev-m' },
        h('span', { class: 'fig' }, windowWords(x.start, x.end)),
        x.kind === 'catalyst' ? [h('span', { class: 'bf-dot', 'aria-hidden': 'true' }, '·'), h('span', null, CERTAINTY_WORDS[x.certainty])] : null,
        x.kind === 'catalyst' && x.pos === null && x.in_horizon !== false ? [h('span', { class: 'bf-dot', 'aria-hidden': 'true' }, '·'), h('span', { class: 'faint' }, 'horizon dates unknown')] : null),
      x.kind === 'review' && x.trigger ? h('p', { class: 'bf-ev-x' }, h('span', { class: 'k' }, 'Sooner if'), x.trigger) : null))));
}

function condList(items, kind) {
  return h('div', { class: `bf-cond ${kind}` },
    h('h3', { class: 'bf-h3' }, kind === 'confirm' ? 'Would strengthen it' : 'Would invalidate it'),
    items.length ? h('ul', null, items.slice(0, 5).map((t) => h('li', null, h('span', { class: `bf-cmark ${kind}`, 'aria-hidden': 'true' }), h('span', null, t)))) : none('None given in the report.'));
}

function watchSection(m) {
  const w = m.watch;
  const a = m.report.assessment || {};
  const tv = m.verdict.timing;
  const chart = m.chart ? chartCycleBlock(a, { full: true }) : null;
  return sec('watch', 'What to watch',
    tv && tv.rationale ? h('p', { class: 'bf-timing' }, h('span', { class: 'k' }, `${WHO}'s timing view · ${tv.word}`), tv.rationale) : null,
    horizonTrack(w),
    watchList(w) || (w.horizon.start ? none('No dated catalyst or review date in the report.') : null),
    w.review_trigger_only ? h('p', { class: 'bf-ev-x' }, h('span', { class: 'k' }, 'Review sooner if'), w.review_trigger_only) : null,
    w.undated.length ? h('div', { class: 'bf-aside' }, h('h3', { class: 'bf-h3' }, 'Date unknown'), h('ul', null, w.undated.map((x) => h('li', null, x.title, h('span', { class: 'faint' }, ` · ${CERTAINTY_WORDS[x.certainty]}`))))) : null,
    w.outside.length ? h('div', { class: 'bf-aside' }, h('h3', { class: 'bf-h3' }, 'Outside the horizon'), h('ul', null, w.outside.map((x) => h('li', null, x.title, h('span', { class: 'faint' }, ` · ${windowWords(x.start, x.end)} · ${CERTAINTY_WORDS[x.certainty]}`))))) : null,
    h('div', { class: 'bf-two tight' }, condList(w.confirms, 'confirm'), condList(w.breaks, 'break')),
    w.metric ? h('div', { class: 'bf-metric' }, h('h3', { class: 'bf-h3' }, 'The one development to watch'),
      h('p', null, h('strong', null, w.metric.metric), w.metric.threshold ? h('span', { class: 'fig' }, ` · ${w.metric.threshold}`) : null),
      w.metric.why ? h('p', { class: 'bf-qsrc' }, w.metric.why) : null) : null,
    chart ? details(`${WHO}'s chart and cycle reading`, chart, { id: 'brief-chart' }) : null);
}

// ---- the scenarios ----------------------------------------------------------------------------------

function scenariosSection(m) {
  const s = m.scenarios;
  if (!s) return null;
  const order = ['bear', 'base', 'bull'];
  const rows = s.rows.slice().sort((x, y) => (order.indexOf(x.id) + 1 || 9) - (order.indexOf(y.id) + 1 || 9));
  const bar = s.bar ? h('div', { class: 'bf-pbar', role: 'img', 'aria-label': `${WHO}'s probabilities: ${rows.map((x) => `${x.label} ${x.probability}%`).join(', ')}` },
    rows.map((x) => h('span', { class: `seg ${x.id}`, style: { width: `${x.probability}%` } }, x.probability >= 12 ? h('span', null, `${x.label} ${x.probability}%`) : null))) : null;
  let plot = null;
  if (s.plot) {
    const ranged = rows.filter((x) => x.range);
    const lo = Math.min(...ranged.map((x) => x.range.low));
    const hi = Math.max(...ranged.map((x) => x.range.high));
    const span = hi - lo || hi || 1;
    const at = (v) => clampPct(((v - lo) / span) * 100);
    plot = h('div', { class: 'bf-plot', role: 'img', 'aria-label': `${WHO}'s price ranges: ${ranged.map((x) => `${x.label} ${x.price}`).join('; ')}` },
      ranged.map((x) => h('div', { class: 'bf-prow' },
        h('span', { class: 'bf-plab' }, x.label),
        h('span', { class: 'bf-ptrack' }, h('span', { class: `bf-prange ${x.id}`, style: { left: `${at(x.range.low)}%`, width: `${Math.max(1.5, at(x.range.high) - at(x.range.low))}%` } })),
        h('span', { class: 'bf-pval fig' }, x.price))));
  }
  const card = (x) => h('div', { class: `bf-scn ${x.id}` },
    h('div', { class: 'bf-scn-head' }, h('h3', null, `${x.label} case`),
      x.probability !== null ? h('span', { class: 'bf-prob fig', title: `${WHO}'s subjective estimate` }, `${x.probability}%`) : h('span', { class: 'bf-prob none' }, 'No probability')),
    h('dl', null,
      x.outcome ? [h('dt', null, 'Outcome'), h('dd', null, x.outcome)] : null,
      h('dt', null, 'Price'), h('dd', null, x.price ? h('span', { class: 'fig' }, x.price) : h('span', { class: 'faint' }, 'No range given')),
      h('dt', null, 'Against BTC'), h('dd', null, x.vsBtc ? h('span', { class: 'fig' }, x.vsBtc) : h('span', { class: 'faint' }, 'No range given')),
      x.assumptions.length ? [h('dt', null, 'Assumes'), h('dd', null, h('ul', null, x.assumptions.map(([k, val]) => h('li', null, h('span', { class: 'bf-ak' }, `${k}: `), val))))] : null,
      x.invalidation ? [h('dt', null, 'Breaks if'), h('dd', null, x.invalidation)] : null));
  const notes = [
    s.probability && s.probability.status !== 'ok' ? s.probability.message : null,
    s.targets && !['given', 'none'].includes(s.targets.status) ? s.targets.message : null,
    s.definition ? `Against BTC: ${s.definition}` : null,
  ].filter(Boolean);
  return sec('scenarios', 'Scenarios',
    h('p', { class: 'bf-label' }, `Forecasts: ${WHO}'s own estimates, not facts`),
    bar, plot,
    h('div', { class: 'bf-scns' }, rows.map(card)),
    notes.length ? h('ul', { class: 'bf-notes' }, notes.map((n) => h('li', null, n))) : null);
}

// ---- evidence and records ----------------------------------------------------------------------------

function evidenceSection(ctx, m, pid) {
  const e = m.evidence;
  const pv = m.provenance;
  const r = m.report;
  const flagsWord = e.flags.length ? `${e.flags.length} flag${e.flags.length === 1 ? '' : 's'}${e.checks && e.checks.high ? ` · ${e.checks.high} serious` : ''}` : 'nothing flagged';
  const checks = e.checks ? details(`Desk evidence checks · ${flagsWord}`, evidenceChecksBlock(e.checks), { id: 'brief-checks', open: e.level === 'serious' }) : null;
  const shownSources = e.sources.slice(0, 5);
  const restSources = e.sources.slice(5);
  const limits = e.limits.slice(0, 4);
  const moreLimits = e.limits.slice(4);
  const limitItem = (x) => h('li', null, h('strong', null, `${x.label}: `), x.text);
  const prov = (k, val, title = null) => h('div', { title }, h('dt', null, k), h('dd', null, val));
  const short = (s, n = 12) => (s && s.length > n + 2 ? `${s.slice(0, n)}…` : s || '—');
  const others = m.history.filter((x) => !x.current);
  return sec('evidence', 'Evidence and sources',
    h('div', { class: 'bf-two tight' },
      h('div', null,
        h('h3', { class: 'bf-h3' }, 'Claims by evidence tag'),
        evidenceQuality(e.claims),
        checks),
      h('div', null,
        h('h3', { class: 'bf-h3' }, 'Key limitations'),
        limits.length ? h('ul', { class: 'bf-limits' }, limits.map(limitItem)) : none('The report states no limitation.'),
        moreLimits.length ? details(`${moreLimits.length} more`, h('ul', { class: 'bf-limits' }, moreLimits.map(limitItem)), { id: 'brief-limits' }) : null,
        e.questions.length ? details(`Open questions (${e.questions.length})`, h('ul', { class: 'bf-limits' }, e.questions.map((q) => h('li', null, q))), { id: 'brief-questions' }) : null)),
    h('div', { class: 'bf-block' },
      h('h3', { class: 'bf-h3' }, `Sources${e.sources.length ? ` (${e.sources.length})` : ''}`),
      shownSources.length ? h('ol', { class: 'src-list bf-src' }, shownSources.map(sourceItem)) : none('This report lists no sources.'),
      restSources.length ? details(`All ${e.sources.length} sources`, h('ol', { class: 'src-list bf-src', start: '6' }, restSources.map(sourceItem)), { id: 'brief-sources' }) : null),
    h('div', { class: 'bf-block bf-records' },
      h('h3', { class: 'bf-h3' }, 'Drawn from'),
      h('dl', { class: 'bf-prov' },
        prov('Report', h('a', { class: 'mono', href: reportHref(pid, pv.report_id), dataset: { key: 'brief-rec-report' } }, pv.report_id)),
        prov('Research run', pv.run_id ? h('a', { class: 'mono', href: runHref(pid, pv.run_id), dataset: { key: 'brief-rec-run' } }, pv.run_id) : h('span', { class: 'faint' }, 'Not part of a run')),
        prov('Analysis · saved', `${pv.analysis_at ? fmtDate(pv.analysis_at) : 'not stated'} · ${fmtDateTime(pv.saved_at)}`),
        prov('Model', `${pv.model || 'not stated'} · ${pv.attested ? 'attested by the API' : /connector/i.test(pv.channel || '') ? 'saved through its connection' : 'self-reported'}`),
        prov('Prompt · rubric · profile', `${pv.prompt_version || '?'} · ${pv.rubric_version || '?'} · ${pv.sector_profile || '?'}`),
        prov('Original SHA-256', h('span', { class: 'mono' }, short(pv.sha256, 16)), pv.sha256),
        prov('Brief', `${pv.format}, drawn from this report when opened`)),
      h('p', { class: 'bf-links' },
        h('a', { class: 'btn small', href: reportHref(pid, pv.report_id), dataset: { key: 'brief-open-report' } }, 'Open the full report'),
        pv.run_id ? h('a', { class: 'btn small', href: runHref(pid, pv.run_id), dataset: { key: 'brief-open-run' } }, 'Research run') : null,
        h('a', { class: 'btn small', href: `#/project/${enc(pid)}/overview`, dataset: { key: 'brief-open-project' } }, 'Full research page'))),
    others.length ? details(`${WHO}'s other reports (${others.length})`, h('ul', { class: 'bf-hist' }, others.map((x) => h('li', null,
      h('span', { class: 'bf-hist-d' }, x.analysis_at ? fmtDate(x.analysis_at) : 'Undated'),
      h('span', { class: 'bf-hist-g fig' }, x.grade && x.grade.display ? x.grade.display : x.needs_text ? 'PDF' : x.grade && x.grade.status === 'withheld' ? 'Withheld' : 'No grade'),
      h('span', { class: 'bf-hist-v' }, [x.verdict, x.revision, x.latest ? 'latest' : null, x.excluded ? `excluded: ${x.excluded}` : null].filter(Boolean).join(' · ')),
      x.eligible ? inBrief(ctx, briefHref(pid, x.report_id), 'Its brief', `brief-hist-${x.report_id}`) : h('a', { href: reportHref(pid, x.report_id), dataset: { key: `brief-hist-r-${x.report_id}` } }, 'The report')))), { id: 'brief-history' }) : null);
}

// ---- your note --------------------------------------------------------------------------------------

function noteSection(d, row, pid) {
  const c = d.conviction;
  const text = c ? String(c.text || '').trim() : '';
  const review = row && row.next_review;
  return h('section', { class: 'bf-sec bf-yours', 'aria-labelledby': 'bf-h-yours' },
    h('h2', { class: 'bf-h', id: 'bf-h-yours' }, 'Your note', h('span', { class: 'bf-h-sub' }, `yours, not ${WHO}'s`)),
    text ? h('p', { class: 'bf-yours-text' }, text) : none('No conviction note yet.'),
    h('p', { class: 'bf-yours-m' },
      c && c.updated_at ? h('span', null, `Saved ${fmtDate(c.updated_at)}${c.conviction ? ` · conviction ${c.conviction}` : ''}`) : null,
      review ? h('span', null, `Your next review ${fmtDate(review.date)}${review.overdue ? ' (overdue)' : ''}`) : null,
      h('a', { href: `#/project/${enc(pid)}/history`, dataset: { key: 'brief-note-edit' } }, text ? 'Edit your note' : 'Write your note')));
}

// ---- no brief to show -------------------------------------------------------------------------------

function emptySection(ctx, m, d, row, pid) {
  const e = m.empty;
  const lines = [];
  let title = `No ${WHO} report yet`;
  if (e.kind === 'not_found') title = 'This report is not on this project';
  else if (e.kind === 'other_provider') title = `This is ${e.other}'s report`;
  else if (e.kind === 'broken') title = 'This report could not be read';
  else if (e.kind === 'ineligible' && e.why) title = e.why.kind === 'quarantined' ? `${WHO}'s answer was quarantined` : e.why.kind === 'pdf' ? 'A PDF without a text copy' : 'This report is excluded';
  if (e.kind === 'ineligible' && e.why && e.why.kind === 'quarantined') {
    lines.push(h('p', null, 'It does not match the research run it was saved for, so it is kept but not graded, and no brief is drawn from it.'),
      e.why.reason ? details('Why', h('p', { class: 'bf-why' }, e.why.reason), { id: 'brief-q-why' }) : null);
  }
  if (e.kind === 'ineligible' && e.why && e.why.kind === 'excluded') lines.push(h('p', null, `It is excluded from comparison${e.why.reason ? `: ${e.why.reason}` : ''}, so no brief is drawn from it.`));
  if (e.kind === 'ineligible' && e.why && e.why.kind === 'pdf') lines.push(h('p', null, 'No scores were read from it, so no brief is drawn from it until a text copy is imported.'));
  if (e.kind === 'broken' && e.why) lines.push(h('p', null, e.why.reason));
  if (e.kind === 'other_provider') lines.push(h('p', null, `The ${WHO} Brief reads ${WHO}'s reports only.`));
  if (e.kind === 'none') {
    // A quarantined answer is said once, with its reason one tap away; the
    // job's own words would only repeat it.
    if (e.quarantined) title = `${WHO}'s answer was quarantined`;
    if (e.quarantined) {
      lines.push(h('p', null, 'It does not match the research run it was saved for, so it is kept but not graded, and no brief is drawn from it.'),
        e.quarantined.reason ? details('Why', h('p', { class: 'bf-why' }, e.quarantined.reason), { id: 'brief-q-why' }) : null);
    } else if (e.job) {
      lines.push(h('p', null, stateText(e.job.long, e.job.tone)), e.job.error && e.job.key === 'failed' ? h('p', { class: 'bf-err' }, e.job.error) : null);
    } else if (e.hold) lines.push(h('p', null, `${WHO} is on hold on this desk${e.hold.since ? ` since ${fmtDate(e.hold.since)}` : ''}: nothing new is assigned to it.`));
    else if (e.archived) lines.push(h('p', null, 'The project is archived: its records are kept, and no research is offered here.'));
    if (e.pdf) lines.push(h('p', null, `A PDF report from ${fmtDate(e.pdf.saved_at)} is saved and needs a text copy before it can be read. `, h('a', { href: `#/updates?tab=import&project=${enc(pid)}&provider=${PROVIDER}`, dataset: { key: 'brief-pdf-import' } }, 'Import the text')));
    if (e.excluded) lines.push(h('p', null, `A report is excluded from comparison${e.excluded.reason ? `: ${e.excluded.reason}` : ''}.`));
  }
  const acts = [];
  if (e.kind === 'none' && e.can_run) {
    const p = row ? { ...row } : { ...d.project, research: null };
    acts.push(button(`Run ${WHO} research…`, () => openResearchDialog(ctx, { ...p, report_count: (d.reports || []).length }, { providers: [PROVIDER] }), { kind: 'primary small', key: 'brief-run' }));
  }
  if (e.latest_id && e.kind !== 'none') acts.push(inBrief(ctx, briefHref(pid), `${WHO}'s latest brief`, 'brief-latest-empty', 'btn small'));
  if (e.report_id && ['ineligible', 'other_provider'].includes(e.kind)) acts.push(h('a', { class: 'btn small', href: reportHref(pid, e.report_id), dataset: { key: 'brief-empty-report' } }, 'Open the report'));
  if (e.job || e.quarantined || (e.why && e.why.kind === 'quarantined')) acts.push(h('a', { class: 'btn small', href: runHref(pid, null), dataset: { key: 'brief-empty-runs' } }, 'Research runs'));
  acts.push(h('a', { class: 'btn small', href: `#/project/${enc(pid)}/overview`, dataset: { key: 'brief-empty-project' } }, 'Full research page'));
  return h('section', { class: 'bf-sec bf-empty', 'aria-labelledby': 'bf-h-empty' },
    h('div', { class: 'bf-empty-mark', 'aria-hidden': 'true' }, icon('brief')),
    h('h2', { class: 'bf-empty-t', id: 'bf-h-empty' }, title),
    lines,
    h('p', { class: 'bf-links' }, acts));
}

// ---- the page --------------------------------------------------------------------------------------

let keysBound = false;
function bindKeys(ctx) {
  if (keysBound) return;
  keysBound = true;
  // Escape leaves the brief, never while typing or with a dialog open.
  document.addEventListener('keydown', (e) => {
    const r = ctx.state.route;
    if (!r || r.name !== 'brief' || e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
    const t = e.target;
    if (document.querySelector('dialog[open]') || (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)))) return;
    e.preventDefault();
    closeBrief(ctx, r.args[0]);
  });
}

export async function renderBrief(ctx, route) {
  bindKeys(ctx);
  const pid = route.args[0];
  const wrap = (bar, ...body) => {
    // The sheet is the desk's own card, so it follows the desk's card style.
    const page = h('div', { class: 'brief-page' }, bar, h('article', { class: 'brief card', 'aria-labelledby': 'bf-title' }, ...body));
    // Opened (not redrawn): the title takes focus, so a screen reader starts
    // there; a live redraw keeps where you were. The bar names the project
    // once the header has scrolled away.
    page.afterMount = () => {
      const t = page.querySelector('#bf-title');
      const b = page.querySelector('.bf-bar');
      if (t && b && typeof IntersectionObserver === 'function') {
        const io = new IntersectionObserver(([en]) => {
          if (!t.isConnected) { io.disconnect(); return; }
          b.classList.toggle('scrolled', !en.isIntersecting && en.boundingClientRect.top < 0);
        }, { rootMargin: '-96px 0px 0px 0px' });
        io.observe(t);
      }
      if (ctx.state.renderReason !== 'nav' || !t) return;
      t.focus({ preventScroll: true });
      ctx.claimFocus();
    };
    return page;
  };
  if (!pid) return wrap(null, callout('No project chosen.', 'warn'));
  let d;
  try {
    d = await ctx.projectDetail(pid);
  } catch (err) {
    const bar = topBar(ctx, { identity: { name: pid }, report_id: null }, pid);
    return wrap(bar, h('h1', { id: 'bf-title', tabindex: '-1', class: 'sr-only' }, `${WHO} Brief`), callout(`Could not load the project "${pid}": ${err.message}. Nothing was changed.`, 'bad'));
  }
  const row = (ctx.state.index.projects || []).find((x) => x.project_id === pid) || null;
  const m = briefModel({ detail: d, row, index: ctx.state.index, provider: PROVIDER, reportId: route.query.get('report') || null, hosted: Boolean(ctx.state.session && ctx.state.session.hosted) });
  const bar = topBar(ctx, m, pid);
  if (m.status !== 'ok') return wrap(bar, header(ctx, m, row, pid), emptySection(ctx, m, d, row, pid), noteSection(d, row, pid));
  return wrap(bar,
    header(ctx, m, row, pid),
    verdictSection(ctx, m, pid),
    thesisSection(m),
    scorecardSection(m),
    forAgainstSection(m),
    watchSection(m),
    scenariosSection(m),
    evidenceSection(ctx, m, pid),
    noteSection(d, row, pid));
}
