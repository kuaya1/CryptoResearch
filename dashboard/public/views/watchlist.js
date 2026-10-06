// Watchlist: the projects you follow, what moved, what each model thinks.
//   Select a project (click, tap, Enter, Space) -> the project inspector (?p=<id>)
//   Select a provider badge                      -> the inspector, on that provider
//   Open full research                           -> #/project/<id>/<tab>
// Nothing floats over the list: there is no hover card.
// The inspector is a pane that stays beside the list from 1280px (empty
// until a project is chosen, so the list never reflows), a drawer over the
// list on medium screens and full screen on a phone (modal). Back, Escape and its close button close it and return focus to the
// project. Live updates redraw only what changed, in place: the search box,
// open details, scroll positions and the row order you are reading stay put.
import {
  h, clear, button, select, input, changeCell, sparkline, priceSpark, logo, gradeBadge, badgeInfo, verdictChip,
  fmtPrice, fmtCompactUsd, fmtDate, fmtDateTime, fmtAgo, fmtAsOf, fmtSignedPct, freshnessText, priceStatus, stateText, toast, announce,
  researchState, withheldReason, unscoredList, jobKey, icon, evidenceLevel, evidenceText, gradeGauge, coverageMeter,
  withheldLabel, structureNotes, details, onHoldOf, copyText, anchorText, fmtRelDay, fmtChangePct, fmtMarketUsd, briefLink, marketFigure, fmtMarketFigure, unknownFigure,
  PROVIDERS, PROVIDER_LABELS, PROVIDER_SHORT,
} from '../ui.js';
import { openAddProjectDialog, openResearchDialog, openSectorDialog, waitingActions } from './dialogs.js';
import { marketStrip, positionFacts, vsBtcFacts } from '../position-ui.js';
import { dexLink, dexCard } from './dex.js';

// Column catalogue, in the CoinMarketCap order: # (rank, drawn before the
// name), price, 24h, 7d and 30d change, market cap, volume, the 7-day chart,
// then the three models. Optional columns (off at first) sit before the
// models. When the list is narrower than its columns, the least essential
// give way (FIT_ORDER); every value stays in the inspector.
const COLUMNS = [
  { id: 'rank', label: '#', title: 'Market-cap rank, as reported by CoinGecko', def: true, sort: 'rank', num: true, market: true },
  { id: 'price', label: 'Price', def: true, sort: 'price', num: true, market: true },
  { id: 'change24h', label: '24h %', title: 'Price change over the last 24 hours', def: true, sort: 'change24h', num: true, market: true },
  { id: 'change7d', label: '7d %', title: 'Price change over the last 7 days (rolling)', def: true, sort: 'change7d', num: true, market: true },
  { id: 'change30d', label: '30d %', title: 'Price change over the last 30 days (rolling)', def: true, sort: 'change30d', num: true, market: true },
  { id: 'mcap', label: 'Market Cap', title: 'Price × circulating supply, as reported by CoinGecko', def: true, sort: 'mcap', num: true, market: true },
  { id: 'mcapChange', label: 'Mkt cap 24h %', title: 'Market-cap change over 24 hours, as reported by CoinGecko', sort: 'mcapChange', num: true, market: true },
  { id: 'fdv', label: 'FDV', title: 'Fully diluted valuation: price × maximum (or total) supply', sort: 'fdv', num: true, market: true },
  { id: 'volume', label: 'Volume(24h)', title: 'Trading volume over the last 24 hours, in USD', def: true, sort: 'volume', num: true, market: true },
  { id: 'volChange', label: 'Volume change', title: 'Measured against our own stored observation from about 24 hours earlier', sort: 'volChange', num: true, market: true },
  { id: 'spark', label: '7D Chart', title: 'Price over the last 7 days (provider series)', def: true, market: true },
  { id: 'sector', label: 'Sector', sort: 'sector' },
  { id: 'lastResearch', label: 'Last research', title: 'Latest report analysis date', sort: 'lastResearch' },
  { id: 'liquidity', label: 'Liquidity', disabled: 'No liquidity source is configured (CoinGecko /coins/markets does not report liquidity).' },
  { id: 'research', label: 'Research', def: true },
];

const SORT_NAMES = {
  name: ['Project', 'A to Z', 'Z to A'], rank: ['Rank (CoinGecko)', 'highest first', 'lowest first'], price: ['Price', 'lowest first', 'highest first'],
  change24h: ['24H change', 'lowest first', 'highest first'], change7d: ['7D change', 'lowest first', 'highest first'], change30d: ['30D change', 'lowest first', 'highest first'],
  mcap: ['Market cap', 'smallest first', 'largest first'], mcapChange: ['Market cap 24H change', 'lowest first', 'highest first'], fdv: ['FDV', 'smallest first', 'largest first'],
  volume: ['Volume', 'smallest first', 'largest first'], volChange: ['Volume change', 'lowest first', 'highest first'], sector: ['Sector', 'A to Z', 'Z to A'],
  lastResearch: ['Last research', 'oldest first', 'newest first'], 'grade:claude': ['Claude grade', 'lowest first', 'highest first'],
  'grade:chatgpt': ['GPT grade', 'lowest first', 'highest first'], 'grade:gemini': ['Gemini grade', 'lowest first', 'highest first'],
};

// The list opens on what you follow: watched or held. Projects you stopped
// watching stay one choice away ("Not watching"); "All" shows everything.
// Holdings themselves live in Portfolio: there is no "held" view of grades.
const DEFAULT_FILTERS = { sector: '', owned: 'watching', coverage: 'any', ret30: 'any', archived: false };
const DEFAULT_SORT = { key: 'rank', dir: 'asc' };
const COVERAGE = [['any', 'Any coverage'], ['all3', 'Graded by all three models'], ['missing', 'Missing a model grade'], ['none', 'No research yet'], ['attention', 'Failed or withheld']];
const RET30 = [['any', 'Any'], ['pos', 'Positive'], ['neg', 'Negative']];
const OWNED = [['watching', 'Watching'], ['off', 'Not watching'], ['all', 'All']];
const PREFS_VERSION = 3;

const view = {
  q: '', order: null, orderKey: '', suppressFocus: false, returnFocus: null, focusProvider: null, focusOnRender: false, bound: false, menus: [],
  mounted: null, strip: null, panelPid: null, recent: null, inspectorTab: {}, focusTab: null, keptOpen: {}, briefReturn: null,
};

export function prefs(ctx) {
  const saved = ctx.ui.get('watchlist', {}) || {};
  // Columns saved before the CoinMarketCap layout (v3) start from its defaults;
  // sort and filters are kept.
  const keepCols = Array.isArray(saved.columns) && saved.v >= 3;
  const cols = keepCols ? COLUMNS.filter((x) => saved.columns.includes(x.id) && !x.disabled).map((x) => x.id) : COLUMNS.filter((c) => c.def).map((c) => c.id);
  if (!cols.includes('research')) cols.push('research');
  const filters = { ...DEFAULT_FILTERS, ...(saved.filters || {}) };
  // Saved before the list opened on what you follow, "all" was just the old
  // default, not a choice: start from the new one.
  // (Version 1 only: there, "all" was the old default, not a choice.)
  if (!(saved.v >= 2) && filters.owned === 'all') filters.owned = DEFAULT_FILTERS.owned;
  if (!OWNED.some(([v]) => v === filters.owned)) filters.owned = DEFAULT_FILTERS.owned;
  return { columns: cols, sort: saved.sort && SORT_NAMES[saved.sort.key] ? saved.sort : DEFAULT_SORT, filters };
}

function savePrefs(ctx, p) {
  ctx.ui.set('watchlist', { v: PREFS_VERSION, columns: p.columns, sort: p.sort, filters: p.filters });
}

// ---- values -----------------------------------------------------------------

function mkt(p) {
  return p.market && p.market.status !== 'invalid' && typeof p.market.price_usd === 'number' ? p.market : null;
}

function gradeSortValue(p, prov) {
  const r = p.providers && p.providers[prov];
  if (!r || !r.grade || r.needs_text) return null;
  if (r.grade.status === 'firm') return r.grade.value;
  if (r.grade.status === 'range') return r.grade.low; // ranges sort by their low end
  return null;
}

function sortValue(p, key) {
  const m = mkt(p);
  switch (key) {
    case 'name': return (p.name || '').toLowerCase();
    case 'rank': return m ? m.market_cap_rank ?? null : null;
    case 'price': return m ? m.price_usd : null;
    case 'change24h': return m ? m.change_24h_pct ?? null : null;
    case 'change7d': return m ? m.change_7d_pct ?? null : null;
    case 'change30d': return m ? m.change_30d_pct ?? null : null;
    case 'mcap': return m ? marketFigure(m.market_cap_usd) : null;
    case 'mcapChange': return m ? m.market_cap_change_24h_pct ?? null : null;
    case 'fdv': return m ? marketFigure(m.fdv_usd) : null;
    case 'volume': return m ? marketFigure(m.volume_24h_usd) : null;
    case 'volChange': return m ? m.volume_change_24h_pct ?? null : null;
    case 'sector': return p.sector ? p.sector.label.toLowerCase() : null;
    case 'lastResearch': return p.last_report_at || null;
    default: return key.startsWith('grade:') ? gradeSortValue(p, key.slice(6)) : null;
  }
}

// Unknown values always sort last, whichever direction is chosen.
export function sortRows(rows, sort) {
  const dir = sort.dir === 'desc' ? -1 : 1;
  return rows.slice().sort((a, b) => {
    const va = sortValue(a, sort.key);
    const vb = sortValue(b, sort.key);
    if (va === null && vb === null) return a.name.localeCompare(b.name);
    if (va === null) return 1;
    if (vb === null) return -1;
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return a.name.localeCompare(b.name);
  });
}

function graded(r) {
  return r && r.grade && !r.needs_text && ['firm', 'range'].includes(r.grade.status);
}

function coverageOf(p) {
  const reps = PROVIDERS.map((x) => p.providers && p.providers[x]);
  const jobs = PROVIDERS.map((x) => p.research && p.research.providers && p.research.providers[x]);
  return {
    gradedCount: reps.filter(graded).length,
    reportCount: reps.filter(Boolean).length,
    attention: jobs.some((j) => j && j.state === 'failed') || reps.some((r) => r && r.grade && r.grade.status === 'withheld'),
  };
}

export function matches(p, f, q) {
  if (p.broken) return false;
  if (!f.archived && p.status === 'archived') return false;
  if (f.archived && p.status !== 'archived') return false;
  if (f.sector && (!p.sector || p.sector.primary !== f.sector)) return false;
  // An archived project is never on the watchlist, so the Archived filter
  // lists every archived project whatever the watching filter says.
  if (!f.archived) {
    if (f.owned === 'held' && !p.held) return false;
    if (f.owned === 'watching' && !(p.on_watchlist || p.held)) return false;
    if (f.owned === 'off' && (p.on_watchlist || p.held)) return false;
  }
  const cov = coverageOf(p);
  if (f.coverage === 'all3' && cov.gradedCount < 3) return false;
  if (f.coverage === 'missing' && cov.gradedCount >= 3) return false;
  if (f.coverage === 'none' && cov.reportCount > 0) return false;
  if (f.coverage === 'attention' && !cov.attention) return false;
  if (f.ret30 !== 'any') {
    const m = mkt(p);
    const v = m ? m.change_30d_pct : null;
    if (v === null || v === undefined) return false;
    if (f.ret30 === 'pos' && !(v > 0)) return false;
    if (f.ret30 === 'neg' && !(v < 0)) return false;
  }
  if (q) {
    const hay = `${p.name} ${p.symbol || ''} ${p.project_id} ${p.sector ? p.sector.label : ''} ${((p.sector && p.sector.tags) || []).join(' ')}`.toLowerCase();
    if (!q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))) return false;
  }
  return true;
}

function noPriceReason(p) {
  if (p.identity_status !== 'verified') return 'Identity pending';
  if (!p.coingecko_id) return 'No market listing';
  if (!p.market || p.market.status === 'missing') return 'Not fetched yet';
  if (p.market.status === 'invalid') return 'Invalid data';
  return null;
}

// A change: the shared signed percent with two decimals (fmtChangePct), the
// same string the inspector shows; the words for a screen reader.
function deltaCell(n, label) {
  const text = fmtChangePct(n);
  if (text === null) return dash(`${label} change`);
  const dir = n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
  return h('span', { class: `dl ${dir}` },
    h('span', { 'aria-hidden': 'true' }, text),
    h('span', { class: 'sr-only' }, `${dir === 'flat' ? 'unchanged' : dir} ${Math.abs(n).toFixed(2)} percent, ${label}`));
}

// The strings the list and the inspector show for one market row, from the
// same formatters, so a value reads the same in both. Pure, for the tests.
export function marketStrings(m) {
  if (!m) return null;
  const mc = marketFigure(m.market_cap_usd);
  const fdv = marketFigure(m.fdv_usd);
  const ratio = mc !== null && fdv !== null ? fdv / mc : null;
  return {
    price: fmtPrice(m.price_usd),
    change24h: fmtChangePct(m.change_24h_pct),
    change7d: fmtChangePct(m.change_7d_pct),
    change30d: fmtChangePct(m.change_30d_pct),
    mcap: fmtMarketFigure(m.market_cap_usd),
    volume: fmtMarketFigure(m.volume_24h_usd),
    fdv: fmtMarketFigure(m.fdv_usd),
    // FDV over market cap: the only derived figure, from the two values shown.
    fdvMc: ratio === null || !Number.isFinite(ratio) ? null : `${ratio.toFixed(2)}×`,
  };
}

// The 7-day chart, kept per project and price observation, so a live redraw
// reuses it instead of building it again.
const sparkCache = new Map();
function sparkCell(p, m) {
  const series = m && m.sparkline_7d;
  const key = `${p.project_id}|${m ? m.as_of : ''}|${series ? series.length : 0}|${m ? m.change_7d_pct : ''}`;
  let el = sparkCache.get(key);
  if (!el) {
    if (sparkCache.size > 400) sparkCache.clear();
    el = priceSpark(series, m ? m.change_7d_pct : null, { width: 150, height: 42, label: `${p.symbol || p.name} 7-day price` });
    sparkCache.set(key, el);
  }
  return el.cloneNode(true);
}

const dash = (label) => h('span', { class: 'unknown' }, h('span', { 'aria-hidden': 'true' }, '—'), h('span', { class: 'sr-only' }, `${label} unknown`));

// ---- cells ------------------------------------------------------------------

// One line: logo, name, ticker, then small marks. A long name is cut with an
// ellipsis here (its full text is the button's label and title) and wraps on
// a phone.
function projectCell(ctx, p) {
  const nameBtn = h('button', { type: 'button', class: 'pname', title: p.name, dataset: { key: `pname-${p.project_id}` }, 'aria-label': `${p.name}${p.symbol ? ` (${p.symbol})` : ''}: open details`, onclick: (e) => { e.stopPropagation(); openPanel(ctx, p.project_id, e.currentTarget); } }, p.name);
  const marks = [];
  if (p.held) marks.push(h('span', { class: 'mark', title: 'You hold this: see Portfolio' }, 'Held'));
  if (p.identity_status !== 'verified') marks.push(h('span', { class: 'mark flag', title: (p.identity_unknowns || []).join(' ') || 'Identity not confirmed: no prices or holdings use it' }, 'Identity pending'));
  if (p.status === 'archived') marks.push(h('span', { class: 'mark' }, 'Archived'));
  // Changes since your last review are counted in the inspector, not on the logo.
  // Under the Archived filter: Restore, right on the row.
  let restore = null;
  if (p.status === 'archived') {
    restore = button('Restore', null, { kind: 'small', key: `row-restore-${p.project_id}` });
    restore.setAttribute('aria-label', `Restore ${p.name}`);
    restore.onclick = (e) => { e.stopPropagation(); restoreProject(ctx, p, restore); };
  }
  return h('div', { class: 'proj-cell' },
    h('span', { class: 'logo-wrap' }, logo(p, { size: 24 })),
    h('div', { class: 'names' }, nameBtn,
      p.symbol ? h('span', { class: 'tick' }, p.symbol) : null,
      marks.length ? h('span', { class: 'marks' }, marks) : null,
      restore));
}

function priceCell(p) {
  const reason = noPriceReason(p);
  // Without a price the cell stays quiet; the reason is in its label (and an
  // unconfirmed identity is already flagged beside the name).
  if (reason) return h('span', { class: 'unknown', title: reason }, h('span', { 'aria-hidden': 'true' }, '—'), h('span', { class: 'sr-only' }, reason));
  const m = p.market;
  const f = freshnessText(m.status, m.age_minutes);
  return h('div', { title: `Source: ${m.source || 'CoinGecko'}, as of ${fmtDateTime(m.as_of)}` },
    h('span', { class: 'price' }, fmtPrice(m.price_usd)),
    // The note's parts never break inside; it keeps one line unless the list
    // would otherwise drop an essential column (fitColumns, wrap-notes).
    m.status !== 'fresh' ? h('span', { class: 'price-note' }, String(f.text).split(' · ').flatMap((part, i) => (i ? [' · ', h('span', { class: 'pn' }, part)] : [h('span', { class: 'pn' }, part)]))) : null);
}

function cellFor(ctx, col, p) {
  const m = mkt(p);
  switch (col) {
    case 'rank': return m && m.market_cap_rank ? h('span', { class: 'num rk', title: m.rank_source_label || 'CoinGecko market-cap rank' }, String(m.market_cap_rank)) : dash('Rank');
    case 'price': return priceCell(p);
    case 'change24h': return m ? deltaCell(m.change_24h_pct, 'over 24 hours') : dash('24-hour change');
    case 'change7d': return m ? deltaCell(m.change_7d_pct, 'over 7 days') : dash('7-day change');
    case 'change30d': return m ? deltaCell(m.change_30d_pct, 'over 30 days') : dash('30-day change');
    case 'spark': return sparkCell(p, m);
    case 'mcap': return m && marketStrings(m).mcap ? h('span', { class: 'num', title: fmtPrice(m.market_cap_usd) }, marketStrings(m).mcap) : m ? unknownFigure('Market cap', m.market_cap_usd) : dash('Market cap');
    case 'mcapChange': return m ? deltaCell(m.market_cap_change_24h_pct, 'market cap over 24 hours') : dash('Market-cap change');
    case 'fdv': return m && marketStrings(m).fdv ? h('span', { class: 'num' }, marketStrings(m).fdv) : m ? unknownFigure('FDV', m.fdv_usd) : dash('FDV');
    case 'volume': return m && marketStrings(m).volume ? h('span', { class: 'num' }, marketStrings(m).volume) : m ? unknownFigure('Volume', m.volume_24h_usd) : dash('Volume');
    case 'volChange': return m && typeof m.volume_change_24h_pct === 'number' ? deltaCell(m.volume_change_24h_pct, 'volume') : h('span', { class: 'unknown', title: m ? m.volume_change_basis || '' : 'No market data' }, h('span', { 'aria-hidden': 'true' }, '—'), h('span', { class: 'sr-only' }, 'Volume change unknown'));
    case 'sector': return p.sector ? h('button', { type: 'button', class: 'chip', dataset: { key: `sector-${p.project_id}` }, 'aria-label': `Sector: ${p.sector.label}. Change sector`, title: 'Your label; change it here', onclick: (e) => { e.stopPropagation(); openSectorDialog(ctx, p); } }, p.sector.label) : dash('Sector');
    case 'lastResearch': return p.last_report_at ? h('span', { class: 'num', title: 'Latest report analysis date' }, fmtDate(p.last_report_at)) : dash('Last research');
    default: return null;
  }
}

const hostedDesk = (ctx) => Boolean(ctx.state.session && ctx.state.session.hosted);

// A model on hold on this desk (settings research.on_hold, any model): its
// header says so, and a cell where it has no report at all is a quiet dash.
// A saved report keeps its pill: its grade, Withheld (a grade deliberately
// not calculated) or PDF. Pure, for the tests.
export function holdCell(index, prov, rep) {
  const hold = Boolean(onHoldOf(index, prov));
  return { hold, dash: hold && !rep, label: `No ${PROVIDER_LABELS[prov] || prov} score` };
}

// One model's state for one project: its grade, or why there is none.
function providerCell(ctx, p, prov) {
  const rep = p.providers && p.providers[prov];
  // On hold with no report: a quiet dash, still a way into that model's tab.
  if (holdCell(ctx.state.index, prov, rep).dash) {
    return h('button', { type: 'button', class: 'gb-none', 'aria-label': `No ${PROVIDER_LABELS[prov]} score`, title: `No ${PROVIDER_LABELS[prov]} report yet: ${PROVIDER_LABELS[prov]} is on hold on this desk`, dataset: { key: `gb-${p.project_id}-${prov}`, provider: prov },
      onclick: (e) => { e.stopPropagation(); openPanel(ctx, p.project_id, e.currentTarget, prov); } },
    h('span', { class: 'p' }, PROVIDER_LABELS[prov]), h('span', { class: 'v' }, '—'));
  }
  const b = gradeBadge(prov, rep, p.research && p.research.providers && p.research.providers[prov], { ...badgeOpts(ctx, prov), button: true, key: `gb-${p.project_id}-${prov}` });
  // A long range (such as 38.3–100.0) takes a smaller figure to keep the width.
  if (rep && rep.grade && rep.grade.status === 'range' && String(rep.grade.display || '').length >= 10) b.classList.add('long');
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    openPanel(ctx, p.project_id, b, prov);
  });
  return b;
}

function mktSummaryCell(p) {
  const reason = noPriceReason(p);
  const m = mkt(p);
  if (reason || !m) return h('div', { class: 'mkt-summary' }, h('span', { class: 'none' }, reason || 'No price'));
  return h('div', { class: 'mkt-summary' }, h('span', { class: 'price' }, fmtPrice(m.price_usd)), deltaCell(m.change_7d_pct, 'over 7 days'), m.status !== 'fresh' ? h('span', { class: 'price-note' }, freshnessText(m.status, m.age_minutes).text) : null);
}

// A phone shows identity, price and the three models; the rest of the row is
// one tap away. Only values the desk has are shown as values.
function secondaryFacts(ctx, p) {
  const m = mkt(p);
  const f = (label, v) => h('div', null, h('dt', null, label), h('dd', null, v));
  return h('details', { class: 'row-more', dataset: { key: `more-${p.project_id}` } },
    h('summary', null, 'Market details'),
    h('dl', null,
      f('Rank', cellFor(ctx, 'rank', p)),
      f('24H', m ? deltaCell(m.change_24h_pct, 'over 24 hours') : dash('24-hour change')),
      f('30D', m ? deltaCell(m.change_30d_pct, 'over 30 days') : dash('30-day change')),
      f('Market cap', cellFor(ctx, 'mcap', p)),
      f('FDV', cellFor(ctx, 'fdv', p)),
      f('Volume, 24h', cellFor(ctx, 'volume', p)),
      f('Sector', p.sector ? p.sector.label : dash('Sector')),
      f('Last research', cellFor(ctx, 'lastResearch', p))));
}

// ---- table --------------------------------------------------------------------

// Columns give way, least essential first, until the table fits the space it
// has, so the three grades never scroll out of view. Every hidden value is
// still in the inspector, and the Columns menu says so.
// Optional columns first, then the defaults in the same order as the
// container-width rules in styles.css: 30d %, volume, the 7-day chart, market cap.
const FIT_ORDER = ['lastResearch', 'sector', 'volChange', 'mcapChange', 'fdv', 'change30d', 'volume', 'spark', 'mcap', 'change24h', 'rank', 'change7d', 'price'];

function fitColumns(root) {
  const sc = root && root.querySelector('.table-scroll');
  const table = sc && sc.querySelector('table.wl');
  if (!table || !table.isConnected) return;
  for (const el of table.querySelectorAll('.fit-hidden')) el.classList.remove('fit-hidden');
  table.classList.remove('wrap-notes');
  if (!table.tHead || getComputedStyle(table.tHead).display === 'none') return; // cards
  for (const id of FIT_ORDER) {
    if (sc.scrollWidth <= sc.clientWidth + 1) break;
    // Before an essential column (24h % onward) gives way, a stale price's
    // note may take two lines between its parts (12px type; Eric, 2026-10-06).
    if (id === 'change24h' && !table.classList.contains('wrap-notes')) {
      table.classList.add('wrap-notes');
      if (sc.scrollWidth <= sc.clientWidth + 1) break;
    }
    const cells = table.querySelectorAll(`.c-${id}`);
    if (!cells.length || getComputedStyle(cells[0]).display === 'none') continue;
    for (const el of cells) el.classList.add('fit-hidden');
  }
  // Still wider than its space (very long values, a narrow window): the table
  // scrolls sideways rather than being cut off. The header then scrolls with
  // it instead of sticking under the bar.
  sc.classList.toggle('xscroll', sc.scrollWidth > sc.clientWidth + 1);
  // A table that grows without the page resizing (a live update with longer
  // values) is fitted again.
  if (view.resizeObserver && view.fitTable !== table) {
    view.resizeObserver.observe(table);
    view.fitTable = table;
  }
}

// The status strip keeps one line: when its parts do not fit the space it
// has (the inspector open, a narrower window, a phone), the least needed
// figures step aside in this order, and their values stay in each part's
// details. Market breadth goes last; only after it does the strip wrap.
export const STRIP_FIT = ['ss-fit-kinds', 'ss-fit-total', 'ss-fit-refresh', 'ss-fit-tight', 'ss-fit-bar', 'ss-fit-chg', 'ss-fit-breadth'];
// A phone (V5, Eric, 2026-10-05): after the shared order, three labels step
// aside before the strip wraps: the prices' name, dominance, the word "items".
// Each part's accessible name keeps them, and warnings keep their words.
export const STRIP_FIT_PHONE = ['ss-fit-plabel', 'ss-fit-dom', 'ss-fit-qlabel'];

function fitStrip(strip) {
  if (!strip || !strip.isConnected) return;
  strip.classList.remove(...STRIP_FIT, ...STRIP_FIT_PHONE, 'ss-wrap');
  if (getComputedStyle(strip).flexWrap !== 'nowrap') return;
  const phone = window.matchMedia('(max-width: 640px)').matches;
  for (const step of phone ? [...STRIP_FIT, ...STRIP_FIT_PHONE] : STRIP_FIT) {
    if (strip.scrollWidth <= strip.clientWidth + 1) return;
    strip.classList.add(step);
  }
  strip.classList.toggle('ss-wrap', strip.scrollWidth > strip.clientWidth + 1);
}

// The sort direction as a drawn chevron (the header's aria-sort says it in words).
const arrow = (dir) => h('span', { class: `arrow ${dir === 'asc' ? 'asc' : 'desc'}`, 'aria-hidden': 'true' });

function providerHeaders(ctx, prefsObj, rerender) {
  return PROVIDERS.map((prov) => {
    const key = `grade:${prov}`;
    const on = prefsObj.sort.key === key;
    // On hold on this desk (settings research.on_hold, any model): said under its name.
    const hold = holdCell(ctx.state.index, prov, null).hold;
    return h('th', { class: `c-prov c-prov-${prov} c-research${hold ? ' is-hold' : ''}`, scope: 'col', 'aria-sort': on ? (prefsObj.sort.dir === 'asc' ? 'ascending' : 'descending') : null },
      h('button', { type: 'button', class: 'sort', dataset: { key: `sort-${key}` }, 'aria-label': `${PROVIDER_LABELS[prov]} grade, 0 to 100${hold ? ', on hold on this desk' : ''}. Sort${on ? `ed ${SORT_NAMES[key][prefsObj.sort.dir === 'asc' ? 1 : 2]}` : ''}`, onclick: () => setSort(ctx, prefsObj, key, rerender) },
        h('span', { class: 'lbl' }, PROVIDER_SHORT[prov], on ? arrow(prefsObj.sort.dir) : null),
        hold ? h('span', { class: 'hold', 'aria-hidden': 'true' }, 'on hold') : null));
  });
}

function sortHeader(ctx, prefsObj, col, rerender) {
  const c = COLUMNS.find((x) => x.id === col);
  if (col === 'research') return providerHeaders(ctx, prefsObj, rerender);
  const cls = [c.num ? 'num' : '', c.hide || '', `c-${col}`].join(' ').trim();
  const sub = col === 'rank' ? view.rankSource || c.sub : c.sub;
  const title = col === 'rank' && view.rankSource === 'Demo data' ? 'Fictional market-cap rank from the demo data' : c.title;
  const label = title ? h('abbr', { title }, c.label) : c.label;
  if (!c.sort) return h('th', { class: cls, scope: 'col' }, h('div', { class: 'th' }, h('span', { class: 'lbl' }, label), sub ? h('span', { class: 'src' }, sub) : null));
  const active = prefsObj.sort.key === c.sort;
  return h('th', { class: cls, scope: 'col', 'aria-sort': active ? (prefsObj.sort.dir === 'asc' ? 'ascending' : 'descending') : null },
    h('button', { type: 'button', class: 'sort', dataset: { key: `sort-${c.sort}` }, onclick: () => setSort(ctx, prefsObj, c.sort, rerender) },
      h('span', { class: 'lbl' }, label, active ? arrow(prefsObj.sort.dir) : null),
      sub ? h('span', { class: 'src' }, sub) : null));
}

function setSort(ctx, prefsObj, key, rerender) {
  if (prefsObj.sort.key === key) prefsObj.sort = { key, dir: prefsObj.sort.dir === 'asc' ? 'desc' : 'asc' };
  else prefsObj.sort = { key, dir: ['rank', 'name', 'sector'].includes(key) ? 'asc' : 'desc' };
  savePrefs(ctx, prefsObj);
  view.order = null;
  rerender();
  announce(`Sorted by ${SORT_NAMES[key][0]}, ${SORT_NAMES[key][prefsObj.sort.dir === 'asc' ? 1 : 2]}. Unknown values are listed last.`);
}

function sortDescription(sort) {
  const s = SORT_NAMES[sort.key] || [sort.key, 'ascending', 'descending'];
  if (sort.key === 'rank') return `Sorted by ${SORT_NAMES.rank[0].charAt(0).toLowerCase()}${SORT_NAMES.rank[0].slice(1)}, ${sort.dir === 'asc' ? 'highest rank first' : 'lowest rank first'}`;
  return `Sorted by ${s[0]}, ${s[sort.dir === 'asc' ? 1 : 2]}`;
}

function rowClass(ctx, pid) {
  const selected = ctx.state.route.query.get('p');
  return pid === selected ? 'selected' : !selected && pid === view.recent ? 'recent' : null;
}

function buildTable(ctx, prefsObj, rows, rerender) {
  const cols = COLUMNS.filter((c) => prefsObj.columns.includes(c.id)).map((c) => c.id);
  const nameActive = prefsObj.sort.key === 'name';
  const rankFirst = cols.includes('rank');
  const rest = cols.filter((c) => c !== 'rank');
  const thead = h('thead', null, h('tr', null,
    rankFirst ? sortHeader(ctx, prefsObj, 'rank', rerender) : null,
    h('th', { class: 'c-project', scope: 'col', 'aria-sort': nameActive ? (prefsObj.sort.dir === 'asc' ? 'ascending' : 'descending') : null },
      h('button', { type: 'button', class: 'sort', dataset: { key: 'sort-name' }, onclick: () => setSort(ctx, prefsObj, 'name', rerender) },
        h('span', { class: 'lbl' }, 'Name', nameActive ? arrow(prefsObj.sort.dir) : null))),
    rest.map((c) => sortHeader(ctx, prefsObj, c, rerender))));
  const tbody = h('tbody', null, rows.map((p) => {
    const tr = h('tr', { class: rowClass(ctx, p.project_id), dataset: { pid: p.project_id } },
      rankFirst ? h('td', { class: 'num c-rank' }, cellFor(ctx, 'rank', p)) : null,
      h('td', { class: 'c-project' }, projectCell(ctx, p)),
      rest.map((c) => {
        if (c === 'research') return PROVIDERS.map((prov) => h('td', { class: `c-prov c-prov-${prov} c-research` }, providerCell(ctx, p, prov)));
        const col = COLUMNS.find((x) => x.id === c);
        return h('td', { class: [col.num ? 'num' : '', c === 'price' ? 'price' : '', col.hide || '', `c-${c}`].join(' ').trim() }, cellFor(ctx, c, p));
      }),
      h('td', { class: 'c-mkt-summary' }, mktSummaryCell(p)),
      h('td', { class: 'c-more' }, secondaryFacts(ctx, p)));
    tr.addEventListener('click', (e) => {
      if (e.target.closest('button, a, input, select, label, summary, details')) return;
      openPanel(ctx, p.project_id, tr.querySelector('.pname'));
    });
    return tr;
  }));
  return h('div', { class: 'table-scroll', 'data-keep-scroll': 'watchlist' },
    h('table', { class: 'wl' }, h('caption', { class: 'sr-only' }, `Watchlist. ${sortDescription(prefsObj.sort)}. Choose a project name for its details; J and K or the arrow keys move between rows, Space or Enter opens and closes a project, R marks the open project reviewed and moves to the next one with changes to review.`), thead, tbody));
}

// ---- menus (filters, columns) ------------------------------------------------

function closeMenus(except = null) {
  for (const m of view.menus) if (m !== except) m.close(false);
}

function menu(label, { key, right = false, count = 0 }, build) {
  const wrap = h('div', { class: 'menu-wrap' });
  const id = `menu-${key}`;
  const btn = h('button', { type: 'button', 'aria-expanded': 'false', 'aria-controls': id, dataset: { key: `menu-btn-${key}` } }, label,
    count ? h('span', { class: 'chip', 'aria-hidden': 'true' }, String(count)) : null, count ? h('span', { class: 'sr-only' }, `, ${count} active`) : null);
  const panel = h('div', { class: `menu${right ? ' right' : ''} hidden`, id, role: 'group', 'aria-label': typeof label === 'string' ? label : key });
  const api = {
    open() {
      closeMenus(api);
      panel.replaceChildren(...build(api));
      panel.classList.remove('hidden');
      btn.setAttribute('aria-expanded', 'true');
      const first = panel.querySelector('input:checked, input, button');
      if (first) first.focus();
    },
    close(returnFocus = true) {
      if (panel.classList.contains('hidden')) return;
      panel.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
      if (returnFocus) btn.focus();
    },
  };
  btn.onclick = (e) => {
    e.stopPropagation();
    if (panel.classList.contains('hidden')) api.open();
    else api.close();
  };
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      api.close();
    }
  });
  view.menus.push(api);
  wrap.append(btn, panel);
  return wrap;
}

function radioGroup(name, legend, options, value, onPick) {
  return h('fieldset', null, h('legend', null, legend), options.map(([v, text, count]) => h('label', null,
    h('input', { type: 'radio', name, value: v, checked: v === value, onchange: () => onPick(v) }),
    h('span', null, text), count !== undefined ? h('span', { class: 'count' }, String(count)) : null)));
}

// ---- attention: problems in view, the rest in the review queue ------------------

// Never folded away: a paid call that may have been billed with no answer
// saved, research that failed or stalled, and records or saving that need
// recovery. Each states its kind in words.
export const ALWAYS_VISIBLE = {
  research_uncertain: 'Check charge',
  research_incomplete: 'Research incomplete',
  research_failed: 'Research failed',
  research_interrupted: 'Research paused',
  writes_blocked: 'Saving blocked',
  broken_record: 'Unreadable record',
  import_failed: 'Import problem',
};

export function splitAttention(items) {
  const critical = [];
  const rest = [];
  for (const a of items || []) {
    if (ALWAYS_VISIBLE[a.kind] || (a.kind === 'request_pending' && a.severity === 'high')) critical.push(a);
    else rest.push(a);
  }
  return { critical, rest };
}

function attentionHref(a) {
  return a.project_id && a.action === `#/project/${a.project_id}` ? `#/watchlist?p=${encodeURIComponent(a.project_id)}` : a.action;
}

// Every other kind in a word or two, so no item reads as a bare warning.
const KIND_WORDS = {
  request_pending: 'Request pending', research_waiting: 'Waiting for you', review_overdue: 'Review overdue', review_due: 'Review due',
  review_upcoming: 'Review soon', review_suggested: 'Review suggested', disagreement: 'Models differ', alert: 'Price alert',
  extraction: 'Check report', needs_text: 'Needs text', identity_price: 'No price', stale_research: 'Old research', grade_mismatch: 'Total differs',
  market_stale: 'Prices stale', scheduler_quiet: 'Task quiet', limit: 'Limit', research_refresh_due: 'Refresh due',
};

export function kindWord(a) {
  return ALWAYS_VISIBLE[a.kind] || KIND_WORDS[a.kind] || (String(a.kind || '').startsWith('portfolio_') ? 'Portfolio' : a.severity === 'high' ? 'Urgent' : 'Review');
}

// What the optional background API of a model still needs, in brief (the
// full list is in its title and in Settings). Manual research needs none of it.
export function setupShort(reason) {
  const r = String(reason || '');
  if (/API key/.test(r)) return 'Automatic: no API key (optional)';
  const n = r.replace(/^not configured:\s*/, '').split(/,\s*(?![^(]*\))/).filter(Boolean).length;
  return n ? `Automatic: ${n} setting${n === 1 ? '' : 's'} missing (optional)` : 'Automatic: not set up (optional)';
}

function alertStrips(items, keyPrefix) {
  if (!items.length) return null;
  return h('ul', { class: 'astrips', 'aria-label': 'Needs a look' }, items.map((a, i) => h('li', null,
    h('details', { class: `astrip ${a.severity}`, dataset: { key: `${keyPrefix}-d-${i}` } },
      h('summary', null, h('span', { class: 'kind' }, kindWord(a)), h('span', { class: 't' }, a.title)),
      a.detail || a.action ? h('div', { class: 'astrip-body' }, a.detail ? h('p', null, a.detail) : null,
        a.action ? h('a', { class: 'small', href: attentionHref(a), dataset: { key: `${keyPrefix}-${i}` } }, 'Open') : null) : null))));
}

function alertList(items, keyPrefix) {
  if (!items.length) return null;
  return h('ul', { class: 'alerts', 'aria-label': 'Needs action' }, items.map((a, i) => h('li', { class: `alert ${a.severity}` },
    h('span', { class: 'kind' }, kindWord(a)),
    h('span', { class: 't' }, a.title, a.detail ? h('span', { class: 'd' }, a.detail) : null),
    a.action ? h('a', { class: 'btn small', href: attentionHref(a), dataset: { key: `${keyPrefix}-${i}` } }, 'Open') : null)));
}

function reviewList(items) {
  return h('ol', { class: 'review-list' }, items.map((a, i) => h('li', null,
    h('span', { class: `sev ${a.severity}` }, a.severity === 'high' ? 'Urgent' : kindWord(a)),
    h('span', { class: 't' }, h('span', null, a.title), a.detail ? h('span', { class: 'd', title: a.detail }, a.detail) : null),
    a.action ? h('a', { class: 'btn small', href: attentionHref(a), dataset: { key: `att-${i}` } }, 'Open') : null)));
}

// ---- status strip --------------------------------------------------------------

// Each model's research route, counted: automatic (its paid API runs in the
// background), manual (its own assistant when you ask, or a pasted answer:
// nothing to set up), on hold (paused by you), or demo fixtures.
export function readinessSummary(providers, held = {}) {
  const list = PROVIDERS.map((p) => ({ provider: p, mode: held && held[p] ? 'hold' : providers && providers[p] ? providers[p].mode : null, reason: providers && providers[p] ? providers[p].reason || null : null, hold: (held && held[p]) || null }));
  const n = (mode) => list.filter((x) => x.mode === mode).length;
  const parts = [];
  if (n('api')) parts.push(n('api') === PROVIDERS.length ? 'all automatic' : `${n('api')} automatic`);
  if (n('manual')) parts.push(n('manual') === PROVIDERS.length ? 'all manual' : `${n('manual')} manual`);
  if (n('hold')) parts.push(`${list.filter((x) => x.mode === 'hold').map((x) => PROVIDER_LABELS[x.provider]).join(', ')} on hold`);
  if (n('mock')) parts.push(n('mock') === PROVIDERS.length ? 'demo adapters' : `${n('mock')} demo`);
  return { list, text: parts.join(' · ') || 'unknown', setup: 0 };
}

function stripItem(key, parts, { warn = false, bad = false, extra = null, ico = null, cls = '' } = {}) {
  const open = view.strip === key;
  return h('button', { type: 'button', class: `ss-item${warn ? ' warn' : ''}${bad ? ' bad' : ''}${cls ? ` ${cls}` : ''}`, 'aria-expanded': String(open), 'aria-controls': 'ss-panel', dataset: { key: `ss-${key}` }, onclick: () => toggleStrip(key) }, ico ? h('span', { class: `ico i-${ico}`, 'aria-hidden': 'true' }) : null, parts, extra ? h('span', { class: 'sr-only' }, `. ${extra}`) : null);
}

let toggleStrip = () => {};

// Time left until the price source's next try, as m:ss (h:mm:ss past an
// hour); "due" once it has passed. Pure, for the tests.
export function countdownText(until, now = Date.now()) {
  const t = Date.parse(until || '');
  if (Number.isNaN(t)) return null;
  const s = Math.ceil((t - now) / 1000);
  if (s <= 0) return 'due';
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

// Rate limited by the price source: a quiet amber badge beside Refresh with
// the time to the next try. The ticking figures are for the eye; the label
// says the clock time once, so a screen reader is not read a running clock.
function rateBadge(m) {
  if (!m || !m.rate_limited) return null;
  const left = countdownText(m.retry_at);
  return h('span', { class: 'rl-badge', role: 'note', title: `The price source is limiting requests${m.retry_at ? `; the next automatic try is after ${fmtAsOf(m.retry_at)}` : ''}. Prices keep their age until then.` },
    h('span', { class: 'rl-dot', 'aria-hidden': 'true' }),
    h('span', null, 'Rate limited'),
    left ? h('span', { class: 'rl-count fig', 'aria-hidden': 'true', dataset: { until: m.retry_at } }, left === 'due' ? 'retry due' : left) : null,
    m.retry_at ? h('span', { class: 'sr-only' }, `, next try after ${fmtAsOf(m.retry_at)}`) : null);
}

// One timer for every countdown on the page, only while one is shown; it
// stops itself when none is left.
function startCountdown() {
  if (view.countdown) return;
  const tick = () => {
    const els = [...document.querySelectorAll('.rl-count[data-until]')];
    if (!els.length) {
      clearInterval(view.countdown);
      view.countdown = null;
      return;
    }
    for (const el of els) {
      const left = countdownText(el.dataset.until);
      el.textContent = left === 'due' ? 'retry due' : left || '';
    }
  };
  if (!document.querySelector('.rl-count[data-until]')) return;
  view.countdown = setInterval(tick, 1000);
}

// Bitcoin and the market in one run of figures: BTC's price and its 7-day
// change, dominance, and the total market cap with its 24-hour change. The
// snapshot holds no 24-hour change for BTC, so each change names its window.
// Only what the captured snapshot holds.
function marketFigures(snap, mc) {
  const demo = snap.provider === 'fictional-demo';
  const dot = () => h('span', { class: 'ss-dot', 'aria-hidden': 'true' }, '·');
  const dom = snap.dominance && typeof snap.dominance.btc_pct === 'number' ? snap.dominance.btc_pct : null;
  const tm = snap.total_market || {};
  const chg = (n, win, label) => {
    const s = fmtChangePct(n);
    return s ? h('span', { class: `m-chg ${n < 0 ? 'down' : n > 0 ? 'up' : 'flat'}` }, h('span', { class: 'chg fig', 'aria-hidden': 'true' }, s), h('span', { class: 'k', 'aria-hidden': 'true' }, win), h('span', { class: 'sr-only' }, `${s.replace('−', 'minus ')} ${label}`)) : null;
  };
  return [
    h('span', { class: 'k' }, demo ? 'BTC (demo)' : 'BTC'),
    h('span', { class: 'v fig' }, `$${Math.round(snap.bitcoin.price_usd).toLocaleString('en-US')}`),
    chg(snap.bitcoin.change_7d_pct, '7d', 'over 7 days'),
    dom !== null ? [dot(), h('span', { class: 'k', title: 'Bitcoin dominance: its share of the total crypto market cap (CoinGecko /global)' }, 'Dom'), h('span', { class: 'v fig' }, `${dom.toFixed(1)}%`)] : null,
    typeof tm.market_cap_usd === 'number' ? h('span', { class: 'm-total' }, dot(), h('span', { class: 'k', title: 'Total crypto market cap (CoinGecko /global)' }, 'Total'), h('span', { class: 'v fig' }, fmtMarketUsd(tm.market_cap_usd)),
      chg(tm.market_cap_change_24h_pct, '24h', 'total market cap over 24 hours')) : null,
    mc.status === 'stale' ? h('span', { class: 'warn-word' }, 'stale') : null,
  ];
}

// Breadth over 30 days, as the snapshot computes it: of the 100 largest coins
// by CoinGecko market cap, less Bitcoin, stablecoins and other pegged, gold-
// backed, tokenized-fund and wrapped tokens, how many rose more than BTC.
export function breadthWords(b30) {
  if (!b30 || typeof b30.beating_btc !== 'number' || typeof b30.counted !== 'number') return null;
  return {
    text: `${b30.beating_btc} of ${b30.counted} beat BTC`,
    window: '30d',
    title: `${b30.beating_btc} of the ${b30.counted} counted coins rose more than Bitcoin over 30 days. Counted: the 100 largest by CoinGecko market cap, less Bitcoin, stablecoins and other pegged, gold-backed, tokenized-fund and wrapped tokens.`,
  };
}

// ---- project inspector ------------------------------------------------------------

const wide = () => window.matchMedia('(min-width: 1280px)').matches;

// Opening adds one history entry (so Back closes it); switching to another
// project while it is open replaces that entry. A peek (the keyboard, beside
// the list) leaves focus on the list, so J/K and Space keep working there.
function openPanel(ctx, pid, opener, provider = null, { peek = false } = {}) {
  view.returnFocus = opener && opener.dataset ? opener.dataset.key || null : null;
  view.focusProvider = provider;
  view.focusOnRender = !peek;
  const open = ctx.state.route.query.get('p');
  if (open === pid) {
    renderPanel(ctx, pid);
    return;
  }
  if (open) ctx.navigate(ctx.hrefWith({ p: pid }), { replace: true, state: history.state });
  else ctx.navigate(ctx.hrefWith({ p: pid }), { state: { crPanel: pid } });
}

// Closing goes back to the entry the inspector came from when it added one,
// so Back afterwards leaves the watchlist as expected.
function closePanel(ctx) {
  if (history.state && history.state.crPanel) history.back();
  else ctx.navigate(ctx.hrefWith({ p: null }), { replace: true });
}

function setSheetMode(on) {
  const targets = [document.getElementById('topbar'), document.getElementById('main'), document.getElementById('demo-banner'), document.querySelector('.skip-link')].filter(Boolean);
  for (const el of targets) {
    if (on) {
      el.inert = true;
      el.setAttribute('data-inert-by-sheet', '');
    } else if (el.hasAttribute('data-inert-by-sheet')) {
      el.inert = false;
      el.removeAttribute('data-inert-by-sheet');
    }
  }
  document.body.classList.toggle('sheet-open', on);
}

function evidenceLine(rep, prov) {
  const level = evidenceLevel(rep && rep.evidence);
  if (!level) return null;
  const text = evidenceText(rep.evidence);
  return h('p', { class: `ev-line compact ${level}` }, h('span', { class: `ev-dot ${level}`, 'aria-hidden': 'true' }),
    h('span', null, h('strong', null, level === 'serious' ? 'Serious flag' : 'Flag'), ` · ${text} · `,
      h('button', { type: 'button', class: 'link', dataset: { key: `ev-jump-${prov}` }, onclick: () => { const d = document.querySelector(`[data-key="insp-evd-${prov}"]`); if (d) { d.open = true; d.scrollIntoView({ block: 'start' }); } } }, 'See the flags')));
}

// The badge options for one model: staleness, the online desk, and whether
// Eric put the model on hold.
function badgeOpts(ctx, prov) {
  return { staleDays: ctx.state.index.settings.freshness.research_stale_days || 90, hosted: hostedDesk(ctx), onHold: Boolean(onHoldOf(ctx.state.index, prov)) };
}

// The latest report when it is a revision of an earlier save for the same
// run: what kind, on what evidence, the model's own reason, and which report
// the run itself links (revisions.js). Every original stays saved and listed.
function revisionLine(rep, pid, prov) {
  const rv = rep && rep.revision;
  if (!rv || rv.kind !== 'revision') return null;
  const who = PROVIDER_LABELS[prov];
  const head = rv.basis === 'existing_evidence' ? 'Revision using existing evidence'
    : rv.basis === 'new_sources' ? `Revision with ${rv.sources.added} new source${rv.sources.added === 1 ? '' : 's'}`
      : 'Re-saved with the same scores';
  const link = rep.run_link && rep.run_link.report_id && rep.run_link.report_id !== rep.report_id ? rep.run_link.report_id : null;
  return h('details', { class: 'rev-line', dataset: { key: `rev-${pid}-${prov}` } },
    h('summary', null, h('span', { class: 'rev-mark', 'aria-hidden': 'true' }, '↺'), h('span', null, h('strong', null, head), ` · ${who}, ${rv.minutes_after} min after the first save`)),
    h('div', { class: 'rev-body' },
      h('p', null, rep.revision_label),
      rv.declared ? null : h('p', { class: 'muted' }, 'No reason recorded.'),
      link ? h('p', { class: 'muted' }, `The run links the first save (${link}).`) : null,
      h('a', { class: 'small', href: `#/project/${encodeURIComponent(pid)}/report?report=${encodeURIComponent(rv.of)}`, dataset: { key: `rev-of-${pid}-${prov}` } }, 'Open the earlier report')));
}

// A stated analysis time after the save (or more than a day ahead) is shown
// as written, and the desk orders the report by its save time.
function timingNote(rep) {
  const t = rep && rep.analysis_timing;
  if (!t || !['after_save', 'future'].includes(t.status)) return null;
  const when = t.minutes_after_save !== null && t.minutes_after_save < 2880 ? `${t.minutes_after_save} min` : 'more than a day';
  return h('p', { class: 'newer-line' }, `Stated analysis time: ${when} after the save`);
}

// Resume research that stopped: the sentence for the model's own assistant,
// copied, and that assistant opened. Nothing changes here until the assistant
// itself saves a draft or its report.
const RESUME_WHERE = { claude: 'In Cowork (or a Claude chat with the CryptoResearch connector)', chatgpt: 'In a ChatGPT chat with the CryptoResearch app turned on' };
const RESUME_OPEN = { claude: 'https://claude.ai/new', chatgpt: 'https://chatgpt.com/' };
function resumeAction(ctx, p, prov, job, info) {
  if (!job || !RESUME_WHERE[prov] || onHoldOf(ctx.state.index, prov)) return null;
  const stalled = info.kind === 'interrupted' || info.job === 'interrupted';
  const released = job.state === 'unconfigured' && (job.released || job.draft_saved_at);
  if (!stalled && !released) return null;
  const sentence = `Resume my CryptoResearch research on ${p.name}`;
  const b = button('Resume', null, { kind: 'small', key: `resume-${p.project_id}-${prov}` });
  b.setAttribute('aria-label', `Resume ${PROVIDER_LABELS[prov]}'s research: copy the sentence and open ${PROVIDER_LABELS[prov]}`);
  b.onclick = async () => {
    try { await copyText(sentence); } catch (_) { /* shown below */ }
    if (hostedDesk(ctx)) window.open(RESUME_OPEN[prov], '_blank', 'noopener');
    toast(`Copied: “${sentence}”. ${RESUME_WHERE[prov]}, paste it. This job shows Working again only when ${PROVIDER_LABELS[prov]} saves a draft or its report.`);
  };
  const since = job.progress_at || job.draft_saved_at || job.updated_at;
  return h('div', { class: 'resume' }, b,
    h('span', { class: 'small muted' }, `${released ? 'Released back to waiting' : 'Paused'}${since ? ` · last activity ${fmtDateTime(since)}` : ''}${job.draft_saved_at ? ` · draft saved ${fmtDateTime(job.draft_saved_at)}` : ' · no draft saved'}`));
}

// ---- project inspector: the scorecard first --------------------------------------

// The model the inspector opens on: a calculated grade first, then any saved
// report, then Claude. Pure, for the tests.
export function defaultModel(providers) {
  const rep = (x) => providers && providers[x];
  return PROVIDERS.find((x) => rep(x) && !rep(x).needs_text && rep(x).grade && ['firm', 'range'].includes(rep(x).grade.status))
    || PROVIDERS.find((x) => rep(x))
    || PROVIDERS[0];
}

// The one you chose for this project, or the default.
function selectedModel(p) {
  const chosen = view.inspectorTab[p.project_id];
  return chosen && PROVIDERS.includes(chosen) ? chosen : defaultModel(p.providers);
}

function selectTab(ctx, pid, prov, { focus = true } = {}) {
  view.inspectorTab[pid] = prov;
  view.focusTab = focus ? prov : null;
  renderPanel(ctx, pid);
}

// One tab per model, each with that model's state as its badge shows it: the
// grade, Withheld, No report, or what its research is doing.
function modelTabs(ctx, p, sel) {
  const list = h('div', { class: 'mtabs', role: 'tablist', 'aria-label': 'Model' }, PROVIDERS.map((prov) => {
    const rep = p.providers && p.providers[prov];
    const job = p.research && p.research.providers && p.research.providers[prov];
    const info = badgeInfo(prov, rep, job, badgeOpts(ctx, prov));
    const on = prov === sel;
    return h('button', {
      type: 'button', role: 'tab', id: `insp-tab-${prov}`, class: 'mtab', 'aria-selected': String(on), 'aria-controls': 'insp-model', tabindex: on ? '0' : '-1',
      'aria-label': info.text.replace(/[.\s]+$/, ''), dataset: { key: `insp-tab-${prov}` }, onclick: () => selectTab(ctx, p.project_id, prov),
    }, h('span', { class: 'mt-name', 'aria-hidden': 'true' }, PROVIDER_LABELS[prov]),
    gradeBadge(prov, rep, job, badgeOpts(ctx, prov)));
  }));
  list.addEventListener('keydown', (e) => {
    const i = PROVIDERS.indexOf(sel);
    const to = e.key === 'ArrowRight' ? PROVIDERS[(i + 1) % 3] : e.key === 'ArrowLeft' ? PROVIDERS[(i + 2) % 3] : e.key === 'Home' ? PROVIDERS[0] : e.key === 'End' ? PROVIDERS[2] : null;
    if (!to) return;
    e.preventDefault();
    selectTab(ctx, p.project_id, to);
  });
  return list;
}

// The selected model's investment grade, kept apart from its category grades:
// the calculated grade on its ruler, or why there is none.
function modelHead(ctx, p, prov) {
  const rep = p.providers && p.providers[prov];
  const job = p.research && p.research.providers && p.research.providers[prov];
  const hosted = hostedDesk(ctx);
  const opts = badgeOpts(ctx, prov);
  const info = badgeInfo(prov, rep, job, opts);
  const pid = p.project_id;
  const who = PROVIDER_LABELS[prov];
  const anchors = ctx.state.index.rubrics.grading.favorable_anchors || [];
  const actions = [];
  const resume = resumeAction(ctx, p, prov, job, info);
  // A model on hold gets nothing new: no retry (the server refuses one too).
  if (job && job.state === 'failed' && !opts.onHold) {
    const retry = button('Retry', null, { kind: 'small', key: `retry-${pid}-${prov}` });
    retry.onclick = async () => {
      retry.disabled = true;
      try {
        const r = await ctx.api.post(`/api/projects/${encodeURIComponent(pid)}/research/${encodeURIComponent(job.run_id)}/jobs/${prov}/retry`, {});
        toast(r.message || 'Retry queued');
        await ctx.refresh();
      } catch (err) {
        toast(err.message, 'bad');
        retry.disabled = false;
      }
    };
    actions.push(retry);
  }
  // A waiting job (no API runs it): on the online desk, the sentence for its
  // assistant first; pasting by hand stays available. A model on hold gets
  // no prompt to act: its job is kept, not handed out.
  if (job && job.state === 'unconfigured' && !opts.onHold && !resume) actions.push(...waitingActions(ctx, { pid, runId: job.run_id, provider: prov, key: `${pid}-${prov}` }));
  if (job && ['interrupted', 'uncertain', 'incomplete', 'conflict', 'held'].includes(info.job || info.kind)) actions.push(h('a', { class: 'btn small', href: `#/project/${encodeURIComponent(pid)}/brief?open=runs`, dataset: { key: `runs-${pid}-${prov}` } }, 'Research runs'));
  if (!rep && !job && p.status !== 'archived' && !opts.onHold) actions.push(button(`Run ${who} research`, () => openResearchDialog(ctx, p, { providers: [prov] }), { kind: 'small', key: `run-${pid}-${prov}` }));
  // The report's verdict, analysis date and horizon, in one quiet line. The
  // age is in calendar days in New York ("yesterday", not "today").
  const rel = rep ? fmtRelDay(rep.analysis_at) : null;
  const facts = rep ? h('p', { class: 'ig-facts' },
    h('span', null, verdictChip(rep.verdict)),
    h('span', null, h('span', { class: 'k' }, 'Analysis'), fmtDate(rep.analysis_at), rel ? h('span', { class: 'faint' }, ` · ${rel}`) : null, info.stale ? h('span', { class: 'freshness stale' }, ' · stale') : null),
    h('span', null, h('span', { class: 'k' }, 'Horizon'), rep.horizon || 'not stated')) : null;
  const top = (extra = null) => h('div', { class: 'ig-top' }, h('span', { class: 'eyebrow' }, 'Investment grade'), extra);
  // The six weighted parts the grade is calculated from, one tap away
  // (filled from the full record); the category grades below are diagnostics.
  const parts = rep && !rep.needs_text ? h('details', { class: 'ig-parts', dataset: { key: `ig-parts-${pid}-${prov}` } },
    h('summary', { title: 'What the investment grade is calculated from: each component score times its weight. The diagnostic categories never enter it.' }, h('span', null, 'Six weighted components')),
    h('div', { dataset: { slot: `grade-${prov}` } }, skeleton('Loading the six weighted parts'))) : null;
  // The model's own total, when it differs from the grade calculated here from
  // the same report: by how much, the full sentence in its tooltip. It is not
  // a spread between models.
  const mt = rep && rep.model_total && rep.model_total.status === 'mismatch' ? rep.model_total : null;
  const delta = mt ? h('span', { class: 'delta-pill fig', title: mt.message, 'aria-label': mt.message }, `Own total differs by ${typeof mt.difference === 'number' ? mt.difference.toFixed(1) : '?'}`) : null;
  let body;
  if (rep && (info.kind === 'grade' || info.kind === 'range')) {
    const word = anchorText(anchors, rep.grade.status === 'range' ? { status: 'range', low: rep.grade.low, high: rep.grade.high } : { status: 'scored', value: rep.grade.value });
    body = h('div', { class: 'ig' },
      top(),
      h('div', { class: 'ig-row' },
        gradeGauge(rep.grade, { word, serious: info.ev === 'serious' }),
        h('div', { class: 'ig-side' }, facts, delta)),
      parts);
  } else if (rep && info.kind === 'pdf') {
    body = h('div', { class: 'ig' }, top(),
      h('div', { class: 'provider-grade' }, h('span', { class: 'state-text' }, 'PDF saved: needs a text copy')),
      h('p', { class: 'small', style: { margin: '4px 0 0' } }, h('a', { href: `#/updates?tab=import&project=${encodeURIComponent(pid)}&provider=${prov}`, dataset: { key: `pdf-import-${pid}-${prov}` } }, `Import ${who}'s text to grade it`)),
      facts);
  } else if (rep) {
    // A saved report whose grade is withheld: the state in words, its
    // coverage (the share of the weight scored, not progress and not a
    // score), what is missing in the model's own notes, the report one tap away.
    const pct = rep.grade ? rep.grade.coverage_pct : null;
    const why = rep.grade && rep.grade.status === 'withheld' ? withheldReason(prov, rep.grade, rep.unscored) : null;
    const checks = rep.structure && rep.structure.flagged && Array.isArray(rep.structure.flags) ? rep.structure.flags.length : 0;
    body = h('div', { class: 'ig withheld' }, top(),
      h('div', { class: 'provider-grade' }, h('span', { class: 'state-text' }, rep.grade && rep.grade.status === 'withheld' ? withheldLabel(pct) : 'No grade')),
      coverageMeter(pct, { compact: true }),
      why ? h('div', { class: 'ig-missing' }, h('h4', null, 'Not scored'), unscoredList(why)) : null,
      // Parts left unscored while the same report scores related ground.
      checks ? h('details', { class: 'ig-check', dataset: { key: `ig-check-${pid}-${prov}` } }, h('summary', null, h('span', null, h('strong', null, 'Check'), ` · ${checks} note${checks === 1 ? '' : 's'}`)), structureNotes(rep.structure)) : null,
      facts,
      parts);
  } else {
    const key = jobKey(job, null, { onHold: opts.onHold });
    const st = researchState(info.kind, { provider: prov, hosted });
    const hold = onHoldOf(ctx.state.index, prov);
    body = h('div', { class: 'ig none' }, top(),
      h('p', { class: 'ig-none-title' }, `No report from ${who}`),
      key ? h('p', { class: 'small', style: { margin: '4px 0 0' } }, stateText(info.kind === 'waiting' && hosted ? 'Waiting for you' : st.long, st.tone)) : h('p', { class: 'small muted', style: { margin: '4px 0 0' } }, hold ? `On hold${hold.since ? ` since ${fmtDate(hold.since)}` : ''}` : 'Not researched yet'),
      job && job.error ? h('p', { class: 'small', style: { margin: '6px 0 0', color: 'var(--neg)' } }, job.error) : null);
  }
  return h('div', { class: 'mhead' },
    body,
    rep ? evidenceLine(rep, prov) : null,
    rep ? revisionLine(rep, pid, prov) : null,
    rep ? timingNote(rep) : null,
    rep && info.newerText ? h('p', { class: `newer-line${info.problem ? ' problem' : ''}` }, info.newerText) : null,
    resume,
    actions.length ? h('div', { class: 'btn-row mhead-actions' }, actions) : null);
}

// The model's own timing view, risks and provenance: one tap away.
function timingFacts(ctx, p, prov) {
  const rep = p.providers && p.providers[prov];
  const riskLabels = Object.fromEntries((ctx.state.index.rubrics.grading.risk_scores || []).map((x) => [x.id, x.label]));
  const facts = [...positionFacts(ctx, p, prov, rep)];
  const risks = (rep.top_risks || []).filter((r) => r.status === 'scored' || r.status === 'range');
  if (risks.length) facts.push(['Top risks (higher is worse)', risks.map((r) => `${riskLabels[r.id] || r.id}: ${r.status === 'range' ? `${r.low}–${r.high}` : r.value}`).join(' · ')]);
  const channel = rep.provenance && rep.provenance.channel ? rep.provenance.channel : null;
  facts.push(['Report', [rep.model_version || 'model not stated', rep.provenance && rep.provenance.attested ? 'attested by the API' : /desk connector/i.test(channel || '') ? 'saved through its connection' : 'imported'].join(' · ')]);
  return h('dl', { class: 'facts' }, facts.map(([k, v]) => h('div', { class: 'wide' }, h('dt', null, k), h('dd', null, v))));
}

function catsSkeleton() {
  return h('div', { class: 'cats insp-loading', role: 'status' }, h('span', { class: 'sr-only' }, 'Loading the category grades…'),
    [80, 60, 72, 45, 66].map((w) => h('div', { class: 'skel-row' }, h('span', { class: 'skel', style: { width: `${w * 0.6}%` } }), h('span', { class: 'skel bar', style: { width: '100%' } }))));
}

// The selected model's panel, in reading order: the verdict (its investment
// grade and facts, its evidence flag), the project's review items right under
// it (models differ, total differs, …), the model's thesis, its category
// grades, then its strongest risks with one Downside line.
function modelPanel(ctx, p, prov) {
  const rep = p.providers && p.providers[prov];
  const graded = rep && !rep.needs_text;
  return h('div', { class: 'mpanel', id: 'insp-model', role: 'tabpanel', 'aria-labelledby': `insp-tab-${prov}` },
    modelHead(ctx, p, prov),
    // Scores the report's text states that differ from its data block,
    // filled from the full record (inspector.js textCheckPart).
    graded ? h('div', { dataset: { slot: `textcheck-${prov}` } }) : null,
    projectAlerts(ctx, p),
    h('section', { class: 'insp-sec insp-thesis', 'aria-labelledby': 'insp-sec-thesis' },
      h('h3', { class: 'sec-title', id: 'insp-sec-thesis' }, 'Thesis'),
      h('div', { dataset: { slot: 'thesis' } }, skeleton('Loading the thesis'))),
    graded ? h('div', { class: 'insp-sec', dataset: { slot: `cats-${prov}` } }, catsSkeleton()) : null,
    graded ? h('div', { class: 'insp-sec', dataset: { slot: `risks-${prov}` } }) : null);
}

// The project's own review items (models differ, total differs, review due…),
// right under the verdict rather than at the foot of the drawer.
function projectAlerts(ctx, p) {
  const list = alertStrips(splitAttention(projectItems(ctx, p)).rest, `previews-${p.project_id}`);
  return list ? h('div', { class: 'insp-alerts' }, list) : null;
}

function comparisonNote(ctx, p) {
  const c = p.comparison || {};
  const present = PROVIDERS.filter((x) => p.providers && p.providers[x] && !p.providers[x].needs_text);
  if (present.length < 2) return h('p', { class: 'small muted' }, 'Model differences appear once at least two models have graded this project.');
  const comparable = c.comparable_providers || [];
  if (comparable.length < 2) {
    return h('div', { class: 'small' }, h('p', { style: { margin: 0 } }, h('strong', null, 'Not directly comparable. '), (c.reasons || []).join('; ') || 'The reports use different rubrics, profiles, horizons or dates.'), h('p', { class: 'muted', style: { margin: '4px 0 0' } }, 'Values are shown side by side, but no difference is calculated.'));
  }
  const flagged = c.flagged || [];
  return h('div', { class: 'small' },
    h('p', { class: 'faint', style: { margin: '0 0 4px' } }, 'Computed by this desk from the saved reports; not a model\'s opinion.'),
    h('p', { style: { margin: 0 } }, `${comparable.map((x) => PROVIDER_LABELS[x]).join(', ')} used the same rubric, scoring profile and horizon, analyzed within the comparison window.`),
    flagged.length
      ? h('p', { style: { margin: '6px 0 0' } }, h('strong', null, `They differ by ${ctx.state.index.settings.comparison.spread_threshold}+ points on ${flagged.length} item(s): `), flagged.slice(0, 4).map((f) => `${f.label} (${f.spread})`).join(', '), flagged.length > 4 ? `, and ${flagged.length - 4} more.` : '.')
      : h('p', { style: { margin: '6px 0 0' } }, 'No item differs by the highlight threshold or more.'),
    h('p', { class: 'muted', style: { margin: '6px 0 0' } }, 'Agreement between models is not independent confirmation: they often read the same sources.'),
    h('a', { href: `#/project/${encodeURIComponent(p.project_id)}/brief?open=compare`, dataset: { key: `compare-${p.project_id}` } }, 'Compare in detail'));
}

// A few quiet lines where content will be; the words are for screen readers.
function skeleton(label) {
  return h('div', { class: 'insp-loading', role: 'status' }, h('span', { class: 'sr-only' }, `${label}…`), h('span', { class: 'skel w80' }), h('span', { class: 'skel w60' }), h('span', { class: 'skel w40' }));
}

// One model's way from prompt to grade, as four marks: done (filled), now
// (ringed), needs you or a check (amber), failed (red). The words beside it
// say the same; the marks are a glance.
const STEP_NAMES = ['Prompt', 'Research', 'Report', 'Grade'];
export function progressSteps(rep, key) {
  const graded = rep && rep.grade && ['firm', 'range'].includes(rep.grade.status) && !rep.needs_text;
  const research = !key ? (rep ? 'done' : 'todo')
    : key === 'completed' ? 'done'
      : ['queued', 'running', 'dispatching', 'cowork', 'connector'].includes(key) ? 'now'
        : key === 'failed' || key === 'incomplete' || key === 'conflict' ? 'bad'
          : ['waiting', 'interrupted', 'uncertain'].includes(key) ? 'warn' : 'todo';
  return [
    key || rep ? 'done' : 'todo',
    research,
    rep ? 'done' : 'todo',
    graded ? 'done' : rep ? 'warn' : 'todo',
  ];
}

function stepsTrack(states) {
  const words = { done: 'done', now: 'in progress', warn: 'needs attention', bad: 'failed', todo: 'not yet' };
  return h('ol', { class: 'steps', 'aria-label': STEP_NAMES.map((n, i) => `${n} ${words[states[i]]}`).join(', ') },
    states.map((st, i) => h('li', { class: st === 'todo' ? null : st, title: `${STEP_NAMES[i]}: ${words[st]}`, 'aria-hidden': 'true' }, i ? h('span', { class: 'bar' }) : null, h('span', { class: 'dot' }))));
}

// Research progress for this project, from the index: the latest run and
// each model's job in words, with what is missing where a model needs setup.
function researchProgress(ctx, p) {
  const idx = ctx.state.index;
  const hosted = hostedDesk(ctx);
  const run = p.research && p.research.latest_run;
  const ready = (idx.research && idx.research.providers) || {};
  const items = PROVIDERS.map((prov) => {
    const job = p.research && p.research.providers && p.research.providers[prov];
    const hold = onHoldOf(idx, prov);
    const key = jobKey(job, null, { onHold: Boolean(hold) });
    const st = key ? researchState(key, { provider: prov, hosted }) : null;
    const r = ready[prov];
    const rep = p.providers && p.providers[prov];
    // Manual research (its assistant, when you ask) is said apart from the
    // optional background API and from a model on hold.
    const how = hold && (key === 'on_hold' || !key) ? h('span', { class: 'how' }, `On hold on this desk${hold.since ? ` since ${fmtDate(hold.since)}` : ''}: nothing new is assigned to it`)
      : r && r.mode === 'manual' && (key === 'waiting' || (!key && !rep)) ? h('span', { class: 'how', title: r.reason || null }, hosted ? 'Manual: its own assistant does it when you ask' : 'Manual: paste the prompt, import the answer', ' · ', h('a', { href: '#/settings?tab=research', dataset: { key: `setup-${prov}` } }, setupShort(r.reason)))
        : r && r.mode === 'mock' && !key ? h('span', { class: 'how' }, 'Fictional demo adapter') : null;
    // A report saved outside a run (imported or pasted) still counts.
    const idle = rep ? stateText(`Report saved${rep.analysis_at ? ` (analysis ${fmtDate(rep.analysis_at)})` : ''}`, 'ok') : h('span', { class: 'faint' }, 'Not requested');
    return h('li', null, h('span', { class: 'who' }, PROVIDER_LABELS[prov]),
      h('span', null, st ? stateText(st.short === 'Saved' ? 'Saved as a report' : st.long, st.tone) : idle,
        job && job.error && key !== 'completed' ? h('span', { class: 'how' }, job.error) : null,
        how,
        stepsTrack(progressSteps(rep, key))));
  });
  return h('div', null,
    run ? h('p', { class: 'run-line' }, h('span', null, `Run of ${fmtDateTime(run.created_at)}`), h('span', null, String(run.status || '').replace(/_/g, ' ')), run.horizon && run.horizon.text ? h('span', null, `Horizon ${run.horizon.text}`) : null)
      : h('p', { class: 'run-line' }, 'No research run yet.'),
    h('ul', { class: 'job-list' }, items),
    h('div', { dataset: { slot: 'run' } }, skeleton('Loading the saved prompt')));
}

// Research that needs you stays in view above the scorecard, one line per
// model, with the tab it concerns one tap away: a possibly billed call, a
// failed or incomplete answer, an assistant that stopped. Then the project's
// other review items, and the identity when it is not confirmed.
// One short line per model, each opening its tab: the model's own tab says the
// rest (its badge and its card carry the same state in words).
const PROBLEM_WORDS = { uncertain: 'Check charge', failed: 'Research failed', incomplete: 'Research incomplete', conflict: 'Answer quarantined', interrupted: 'Research paused', held: 'Held by archive' };
const JOB_KINDS = new Set(['research_uncertain', 'research_failed', 'research_incomplete', 'research_conflict', 'research_interrupted', 'identity']);
const projectItems = (ctx, p) => (ctx.state.index.attention || []).filter((a) => a.project_id === p.project_id && !JOB_KINDS.has(a.kind));
function problemLines(ctx, p) {
  const items = [];
  for (const prov of PROVIDERS) {
    const job = p.research && p.research.providers && p.research.providers[prov];
    const key = jobKey(job, null, { onHold: Boolean(onHoldOf(ctx.state.index, prov)) });
    if (!PROBLEM_WORDS[key]) continue;
    items.push(h('li', null, h('button', { type: 'button', class: `pline ${key === 'uncertain' ? 'high' : 'medium'}`, dataset: { key: `insp-show-${prov}` }, onclick: () => selectTab(ctx, p.project_id, prov) },
      icon(key === 'uncertain' ? 'question' : key === 'failed' || key === 'conflict' ? 'alert' : key === 'held' ? 'minus' : key === 'incomplete' ? 'half' : 'pause'),
      h('span', null, h('strong', null, PROBLEM_WORDS[key]), ` · ${PROVIDER_LABELS[prov]}`),
      h('span', { class: 'go', 'aria-hidden': 'true' }, 'Show'))));
  }
  const others = alertStrips(splitAttention(projectItems(ctx, p)).critical, `palert-${p.project_id}`);
  const idNote = p.identity_status !== 'verified'
    ? h('p', { class: 'small insp-idnote' }, h('strong', null, 'Identity pending: '), (p.identity_unknowns || []).join(' ') || 'The token is not confirmed, so no prices or holdings use it.', ' ', h('a', { href: `#/project/${encodeURIComponent(p.project_id)}/brief?open=identity`, dataset: { key: `fix-identity-${p.project_id}` } }, 'Complete the identity'))
    : null;
  if (!items.length && !others && !idNote) return null;
  return h('div', { class: 'insp-problems' }, items.length ? h('ul', { class: 'plines', 'aria-label': 'Research that needs you' }, items) : null, others, idNote);
}

// Archived: said first, with Restore. Nothing was deleted.
function archivedBanner(ctx, p) {
  if (p.status !== 'archived') return null;
  const a = p.archive || {};
  const restore = button('Restore', null, { kind: 'small', key: `restore-${p.project_id}` });
  restore.onclick = () => restoreProject(ctx, p, restore);
  return h('div', { class: 'insp-archived', role: 'note' }, icon('minus'),
    h('span', null, h('strong', null, 'Archived'), a.archived_at ? ` ${fmtDate(a.archived_at)}` : '', a.reason ? `: ${a.reason}` : '', '. Off your lists; its reports, notes, runs and any holding are kept.'),
    restore);
}

async function restoreProject(ctx, p, btn = null) {
  if (btn) btn.disabled = true;
  try {
    const r = await ctx.api.post(`/api/projects/${encodeURIComponent(p.project_id)}/restore`, {});
    toast(`Restored ${p.name}${r.on_watchlist ? ', back on your watchlist' : ''}. Nothing was started or sent.${(r.held_jobs || []).length ? ' Research held while it was archived stays unsent until you send it.' : ''}`);
    await ctx.refresh();
  } catch (err) {
    toast(err.message, 'bad');
    if (btn) btn.disabled = false;
  }
}

// Archive: no confirmation, an Undo in the notice, Restore under the Archived
// filter. A request already sent to a paid model may still finish and be billed.
async function archiveProject(ctx, p) {
  try {
    const r = await ctx.api.post(`/api/projects/${encodeURIComponent(p.project_id)}/archive`, { reason: 'Archived from the dashboard' });
    const sent = (r.sent_jobs || []).length;
    toast(`Archived ${p.name}. It is off your watchlist; its reports, notes and any holding are kept.${sent ? ` ${sent} request${sent === 1 ? '' : 's'} already sent to a paid model may still finish and be billed.` : ''}`, '', { action: { label: 'Undo', key: `undo-archive-${p.project_id}`, onClick: () => restoreProject(ctx, p) } });
    await ctx.refresh();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

// The inspector's secondary actions in one menu (a button with a list of
// menu items): Up/Down move, Escape closes and returns to the button.
function inspectorMenu(ctx, p) {
  const pid = p.project_id;
  const archived = p.status === 'archived';
  const btn = h('button', { type: 'button', class: 'more quiet', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': `More actions for ${p.name}`, title: 'More actions', dataset: { key: 'panel-more' } }, icon('more'));
  const list = h('div', { class: 'insp-menu', role: 'menu', 'aria-label': `Actions for ${p.name}`, hidden: true });
  const item = (label, fn, { key, desc = null, href = null } = {}) => {
    const el = href
      ? h('a', { role: 'menuitem', href, tabindex: '-1', dataset: { key } }, h('span', null, label), desc ? h('span', { class: 'desc' }, desc) : null)
      : h('button', { type: 'button', role: 'menuitem', tabindex: '-1', dataset: { key } }, h('span', null, label), desc ? h('span', { class: 'desc' }, desc) : null);
    el.addEventListener('click', () => { close(false); if (fn) fn(); });
    return el;
  };
  const watch = async () => {
    try {
      await ctx.api.post(`/api/projects/${encodeURIComponent(pid)}/watchlist`, { on: !p.on_watchlist });
      await ctx.refresh();
    } catch (err) { toast(err.message, 'bad'); }
  };
  const reviewed = async () => {
    try {
      await ctx.api.post(`/api/projects/${encodeURIComponent(pid)}/reviewed`, {});
      toast('Marked reviewed. New changes are counted from now.');
      await ctx.refresh();
    } catch (err) { toast(err.message, 'bad'); }
  };
  const items = [
    item('Full research page', null, { key: `menu-full-${pid}`, href: `#/project/${encodeURIComponent(pid)}/brief` }),
    archived ? null : item('Run research…', () => openResearchDialog(ctx, p), { key: 'menu-research' }),
    archived ? null : item(p.on_watchlist ? 'Stop watching' : 'Watch', watch, { key: 'menu-watch', desc: p.on_watchlist ? 'On your watchlist now' : null }),
    p.sector ? item('Change sector', () => openSectorDialog(ctx, p), { key: 'menu-sector', desc: p.sector.label }) : null,
    item('Mark reviewed', reviewed, { key: 'menu-reviewed' }),
    p.held ? item('Holding in Portfolio', null, { key: 'menu-held', href: '#/portfolio' }) : null,
    archived
      ? item('Restore', () => restoreProject(ctx, p), { key: 'menu-restore', desc: 'Back as it was, with its history' })
      : item('Archive', () => archiveProject(ctx, p), { key: 'menu-archive', desc: 'Off your lists; nothing is deleted. Undo right after.' }),
  ].filter(Boolean);
  list.append(...items);
  const onDoc = (e) => { if (!list.contains(e.target) && e.target !== btn && !btn.contains(e.target)) close(false); };
  function open() {
    list.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    items[0].focus();
    setTimeout(() => document.addEventListener('click', onDoc), 0);
  }
  function close(focusBack = true) {
    if (list.hidden) return;
    list.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDoc);
    if (focusBack) btn.focus();
  }
  btn.onclick = (e) => { e.stopPropagation(); if (list.hidden) open(); else close(); };
  list.addEventListener('keydown', (e) => {
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
    else if (e.key === 'Tab') close(false);
  });
  return h('div', { class: 'insp-more-wrap' }, btn, list);
}

// The time a price line shows. The status bar shows when prices were last
// refreshed; a project's price was stored by that refresh, or kept from an
// earlier one when the refresh did not update it (not returned, invalid, or
// older than the stored price). Same refresh: the bar's own time, so the two
// never disagree. Kept: said so, with its own time. Pure, for the tests.
export function priceClock(assetFetchedAt, lastRefreshAt) {
  const a = Date.parse(assetFetchedAt || '');
  const r = Date.parse(lastRefreshAt || '');
  if (Number.isNaN(a)) return { text: Number.isNaN(r) ? null : fmtAgo(lastRefreshAt), kept: false };
  if (Number.isNaN(r) || a >= r - 60000) return { text: fmtAgo(Number.isNaN(r) ? assetFetchedAt : lastRefreshAt), kept: false };
  return { text: `Not refreshed · ${fmtAgo(assetFetchedAt)}`, kept: true };
}

// The price row under the name: the price, its 24-hour change as a pill and
// how fresh it is; missing data says why.
function headMarket(p, freshness = null) {
  const m = mkt(p);
  if (!m) return h('div', { class: 'ph-price none' }, h('span', { class: 'hm-none' }, `No price: ${(noPriceReason(p) || 'unknown').toLowerCase()}`));
  const f = freshnessText(m.status, m.age_minutes);
  const fresh = m.status === 'fresh';
  const c = m.change_24h_pct;
  const s = marketStrings(m);
  const clock = priceClock(m.fetched_at, freshness && freshness.last_success_at);
  const source = m.rank_source_label && /fictional/i.test(m.rank_source_label) ? 'Fictional demo data' : `Source: ${m.source || 'CoinGecko'}`;
  return h('div', { class: 'ph-price' },
    h('span', { class: 'hm-price fig' }, s.price),
    s.change24h ? h('span', { class: `hm-delta fig ${c < 0 ? 'down' : 'up'}`, title: 'Price change over 24 hours' },
      h('span', { 'aria-hidden': 'true' }, s.change24h),
      h('span', { class: 'sr-only' }, `${c < 0 ? 'down' : c > 0 ? 'up' : 'unchanged'} ${Math.abs(c).toFixed(2)} percent over 24 hours`)) : null,
    h('span', { class: `hm-fresh ${fresh && !clock.kept ? 'ok' : 'warn'}`, title: `${source}, as of ${fmtDateTime(m.as_of)}${clock.kept ? `. The last price refresh (${fmtAgo(freshness.last_success_at)}) did not update this asset, so its last valid price is kept.` : ''}` }, fresh ? clock.text || fmtAgo(m.fetched_at || m.as_of) : f.text));
}

// One of DefiLlama's 30-day totals for a tile, as saved (never fetched here):
// the total, or "—" with the reason. A partial month is not a total, so it
// stays "—" with what was observed in the label. Pure, for the tests.
const FUND_STATE = { unmapped: 'No DefiLlama entity is bound to this project', identity_pending: 'Identity pending: nothing is fetched until it is confirmed', never_run: 'Not fetched yet', pending: 'Not fetched yet', disabled: 'DefiLlama is turned off in settings', unavailable: 'The saved figures could not be read' };
export function fundamentalsTile(f, key) {
  const label = key === 'fees' ? 'fees' : 'revenue';
  if (!f || !f.metrics) return { text: null, title: (f && (FUND_STATE[f.state] || f.reason)) || 'No DefiLlama figures' };
  const x = f.metrics[key];
  const src = `DefiLlama ${f.scope ? `${f.scope} ` : ''}${f.slug || ''}`.trim();
  const when = f.window ? `, 30 days to ${f.window.end}` : '';
  const stale = f.state === 'stale';
  if (x && typeof x.total_30d_usd === 'number') return { text: x.total_30d_usd === 0 ? '$0' : fmtCompactUsd(x.total_30d_usd), title: `${src}${when}${stale ? ` (stale, ${Math.round(f.age_hours || 0)} h old)` : ''}`, stale };
  if (x && x.status === 'unsupported') return { text: null, title: `${src} reports no ${label}` };
  if (x && typeof x.observed_subtotal_usd === 'number') return { text: null, title: `Partial: ${x.observed_days ?? '?'} of 30 days reported (${fmtCompactUsd(x.observed_subtotal_usd)} observed); no 30-day total` };
  return { text: null, title: `${src}: no 30-day ${label} total` };
}

// The asset at a glance, one row of four: market cap, 24-hour volume, FDV, and
// FDV over market cap (the one derived figure, from the two values shown).
// Rank is in the table; DefiLlama's 30-day fees and revenue are under
// On-chain fundamentals. Unknown stays "—" with its reason in the label.
function overviewStats(p) {
  const m = mkt(p);
  const s = marketStrings(m) || {};
  const none = (label, v) => (m ? unknownFigure(label, v) : dash(label));
  const stat = (k, v, title) => h('div', { class: 'ov-stat', title }, h('dt', null, k), h('dd', { class: 'fig' }, v));
  return h('dl', { class: 'ov-strip', 'aria-label': 'Asset overview' },
    stat('MC', s.mcap || none('Market cap', m && m.market_cap_usd), 'Market cap (CoinGecko)'),
    stat('Vol 24h', s.volume || none('Volume', m && m.volume_24h_usd), 'Trading volume over 24 hours'),
    stat('FDV', s.fdv || none('FDV', m && m.fdv_usd), 'Fully diluted valuation'),
    stat('FDV/MC', s.fdvMc || dash('FDV over market cap'), 'Fully diluted valuation over market cap, from the two figures shown'));
}

// Whether a project is bound to a DefiLlama entity (fundamentals.js summary):
// not when nothing is bound or DefiLlama is turned off. Pure, for the tests.
export function defillamaBound(f) {
  return Boolean(f && f.state && !['unmapped', 'disabled'].includes(f.state));
}

// The index row as dex.js reads a project: the verified identity's contracts
// from the saved screen summary, so the DEX link and card are drawn with the
// header instead of waiting for the full record. Pure, for the tests.
export function rowProject(p) {
  const contracts = p && p.screening && Array.isArray(p.screening.contracts) ? p.screening.contracts : [];
  return {
    project_id: p.project_id,
    name: p.name,
    symbol: p.symbol,
    identity: {
      status: p.identity_status,
      native_chain: Boolean(p.screening && p.screening.native_chain),
      assets: contracts.filter((c) => c && c.address).map((c) => ({ chain: c.chain, contract_address: c.address })),
    },
  };
}

// GoPlus's answers as words: present Yes, absent No, unknown "—" (GoPlus gave
// no answer). Nothing is ever called safe.
export const FLAG_WORD = { present: 'Yes', absent: 'No', unknown: '—' };
const FLAG_SPOKEN = { present: 'yes', absent: 'no', unknown: 'unknown (GoPlus gave no answer)' };
const shortAddr = (a) => (a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '');

// Several contracts' answers as one: present when any says present, then
// unknown, and absent only when every one says absent.
function worstFlag(values) {
  const v = values.filter((x) => x === 'present' || x === 'absent' || x === 'unknown');
  if (!v.length) return null;
  return v.includes('present') ? 'present' : v.includes('unknown') ? 'unknown' : 'absent';
}

// Severe flags, worst first, as the screen names them.
const SEVERE_ORDER = ['Honeypot', 'Cannot sell the whole balance', 'Cannot be bought', 'Owner can change balances', 'Balances can be changed', 'Hidden owner', 'Self-destruct', 'Can be closed', 'Not transferable'];
const severeRank = (x) => (SEVERE_ORDER.indexOf(x) === -1 ? SEVERE_ORDER.length : SEVERE_ORDER.indexOf(x));

const ageText = (hours) => (typeof hours !== 'number' ? null : hours < 1 ? '<1h' : hours < 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`);

// The contract line under the tiles, from the index row's saved screen (never
// fetched here): the contracts on record, GoPlus's mint, blacklist (freeze on
// Solana) and proxy answers across them, the highest sell tax, a severe flag,
// a recent change, and the screen's age. A state without a screen names it.
// Pure, for the tests.
export function contractStrip(s) {
  const sc = s && typeof s === 'object' ? s : null;
  const all = sc && Array.isArray(sc.contracts) ? sc.contracts : [];
  const items = all.map((c) => ({ label: c.label || c.chain || null, address: c.address, status: c.status }));
  const out = { state: sc ? sc.state : null, items, text: null, title: null, badges: [], status: null, age: null, stale: false, ageTitle: null };
  if (!sc) return { ...out, text: '—', title: 'No contract screen in this index' };
  const reason = sc.reason || null;
  if (sc.state === 'native_chain') return { ...out, text: 'Native coin', title: reason };
  if (sc.state === 'no_contract') return { ...out, text: 'None on record', title: reason };
  if (sc.state === 'identity_pending') return { ...out, text: 'Identity pending', title: reason };
  const STATUS = {
    disabled: { word: 'Screening off', tone: 'none' },
    unsupported: { word: 'Not screenable', tone: 'none' },
    pending: { word: 'Not screened yet', tone: 'none' },
    unavailable: { word: 'Screen failed', tone: 'warn' },
  };
  if (STATUS[sc.state]) return { ...out, text: items.length ? null : 'None on record', status: { ...STATUS[sc.state], title: (sc.state === 'unavailable' && sc.last_error) || reason } };
  // A saved screen (fresh, fresh_last_failed, stale).
  const ok = all.filter((c) => c.status === 'ok');
  const when = sc.fetched_at ? `GoPlus Security, ${fmtDateTime(sc.fetched_at)}` : 'GoPlus Security';
  const many = ok.length > 1;
  const flag = (key, label, spoken, list, pick) => {
    const v = worstFlag(list.map(pick));
    if (!v) return null;
    return {
      key,
      label,
      value: FLAG_WORD[v],
      state: v,
      tone: v === 'present' ? 'watch' : v === 'unknown' ? 'unknown' : 'plain',
      title: [...list.map((c) => `${c.label || c.chain} ${shortAddr(c.address)}: ${FLAG_SPOKEN[pick(c)] || 'not reported'}`), when].join('\n'),
      aria: `${spoken}: ${FLAG_SPOKEN[v]}${many ? `, across ${list.length} contracts` : ''}, from GoPlus`,
    };
  };
  if (ok.length) {
    const sol = ok.every((c) => c.family === 'solana');
    const evm = ok.filter((c) => c.family !== 'solana');
    out.badges.push(
      flag('mint', 'Mint', sol ? 'Mint authority' : 'Mint function', ok, (c) => c.mint),
      flag('blacklist', sol ? 'Freeze' : 'Blacklist', sol ? 'Freeze authority' : evm.length < ok.length ? 'Blacklist (freeze authority on Solana)' : 'Blacklist', ok, (c) => c.blacklist),
      evm.length ? flag('proxy', 'Proxy', 'Upgradeable proxy', evm, (c) => c.proxy) : null);
    const taxes = ok.map((c) => c.sell_tax_pct).filter((x) => typeof x === 'number' && Number.isFinite(x));
    if (taxes.length) {
      const top = Math.max(...taxes);
      const txt = `${Math.round(top * 100) / 100}%`;
      out.badges.push({ key: 'tax', label: 'Tax', value: txt, state: null, tone: top > 10 ? 'severe' : top > 0 ? 'watch' : 'plain', title: [...ok.map((c) => `${c.label || c.chain} ${shortAddr(c.address)}: sell tax ${typeof c.sell_tax_pct === 'number' ? `${c.sell_tax_pct}%` : 'not reported'}`), when].join('\n'), aria: `Sell tax: ${txt}${many ? ', the highest across the contracts' : ''}, as GoPlus simulates it` });
    }
    const severe = [...new Set(ok.flatMap((c) => (Array.isArray(c.severe) ? c.severe : [])))].sort((a, b) => severeRank(a) - severeRank(b));
    if (severe.length) out.badges.push({ key: 'severe', label: severe[0], value: severe.length > 1 ? `+${severe.length - 1}` : null, state: 'present', tone: 'severe', title: [...severe, when].join('\n'), aria: `Severe flags from GoPlus: ${severe.join(', ')}` });
  } else if (all.length) {
    const nf = all.every((c) => c.status === 'not_found');
    out.status = { word: nf ? 'Not in GoPlus' : 'Not screened', tone: 'none', title: all.map((c) => `${c.label || c.chain} ${shortAddr(c.address)}: ${c.reason || c.status}`).join('\n') };
  }
  const alerts = Array.isArray(sc.alerts) ? sc.alerts : [];
  if (alerts.length) {
    const last = alerts.map((a) => a.at).filter(Boolean).sort().pop();
    out.badges.push({ key: 'alert', label: 'Changed', value: last ? fmtDate(last).replace(/, \d{4}$/, '') : null, state: 'present', tone: 'severe', title: alerts.map((a) => `${fmtDate(a.at)}: ${a.chain} ${shortAddr(a.address)} ${a.words}`).join('\n'), aria: `Contract changed: ${alerts.map((a) => a.words).join('; ')}` });
  }
  out.badges = out.badges.filter(Boolean);
  out.age = ageText(sc.age_hours);
  out.stale = sc.state === 'stale';
  out.ageTitle = `${when}${out.stale ? ' (stale)' : ''}${sc.last_error ? `\nLatest run failed: ${sc.last_error}` : ''}`;
  return out;
}

// Badges in the order that matters when the line is full: changes and severe
// flags, a high sell tax, then mint, blacklist and proxy, then the rest.
const BADGE_RANK = { alert: 0, severe: 1 };
const badgeRank = (b) => (BADGE_RANK[b.key] !== undefined ? BADGE_RANK[b.key] : b.key === 'tax' && b.tone === 'severe' ? 2 : b.key === 'tax' ? 6 : { mint: 3, blacklist: 4, proxy: 5 }[b.key] ?? 7);

// The contract chips under Market structure, from contractStrip: always Mint,
// Blacklist (Freeze on Solana), Proxy and Tax, each with a status dot (clean,
// risky, unknown), "n/a" for a native coin; then a severe flag or a change.
// Pure, for the tests.
const CHIP_KEYS = ['mint', 'blacklist', 'proxy', 'tax'];
export function contractChipModel(s) {
  const m = contractStrip(s);
  const native = m.state === 'native_chain';
  const byKey = Object.fromEntries(m.badges.map((b) => [b.key, b]));
  const solana = Boolean(byKey.blacklist && byKey.blacklist.label === 'Freeze');
  const label = { mint: 'Mint', blacklist: solana ? 'Freeze' : 'Blacklist', proxy: 'Proxy', tax: 'Tax' };
  const chips = CHIP_KEYS.map((key) => {
    if (native) return { key, label: label[key], value: 'n/a', dot: 'none', aria: `${label[key]}: not applicable to a native coin` };
    if (key === 'proxy' && solana && !byKey.proxy) return { key, label: 'Proxy', value: 'n/a', dot: 'none', aria: 'Proxy: not applicable on Solana' };
    const b = byKey[key];
    if (!b) return { key, label: label[key], value: '—', dot: 'unknown', aria: `${label[key]}: unknown, no screen answer`, title: m.status ? m.status.title || m.status.word : null };
    const dot = key === 'tax' ? (b.tone === 'plain' ? 'clean' : 'risky') : b.state === 'present' ? 'risky' : b.state === 'absent' ? 'clean' : 'unknown';
    return { key, label: b.label, value: b.value, dot, title: b.title, aria: b.aria };
  });
  return { ...m, chips, extra: m.badges.filter((b) => !CHIP_KEYS.includes(b.key)) };
}

function contractChipsEl(p) {
  const m = contractChipModel(p.screening);
  const first = m.items[0];
  const pid = p.project_id;
  let copy = null;
  if (first && first.address) {
    copy = h('button', { type: 'button', class: 'cc-copy quiet', 'aria-label': 'Copy contract address', title: first.address, dataset: { key: `copy-addr-${pid}` } }, icon('copy'));
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(first.address);
        copy.classList.add('done');
        copy.setAttribute('aria-label', 'Copied');
        copy.replaceChildren(h('span', null, 'Copied'));
        setTimeout(() => { copy.classList.remove('done'); copy.setAttribute('aria-label', 'Copy contract address'); copy.replaceChildren(icon('copy')); }, 1500);
      } catch (_) {
        toast('Could not copy: the browser refused the clipboard.', 'bad');
      }
    };
  }
  return h('div', { class: 'cchips' },
    h('div', { class: 'cc-line' },
      h('span', { class: 'cc-k' }, 'Contract'),
      first ? h('span', { class: 'cc-v', title: m.items.map((x) => `${x.label || 'chain?'}: ${x.address}`).join('\n') },
        first.label ? h('span', { class: 'cc-chain' }, first.label) : null,
        h('span', { class: 'mono' }, shortAddr(first.address)),
        m.items.length > 1 ? h('span', { class: 'faint' }, ` +${m.items.length - 1}`) : null) : h('span', { class: 'cc-v', title: m.title }, m.text || '—'),
      copy,
      m.status ? h('span', { class: `cs-badge${m.status.tone === 'warn' ? ' warn' : ''}`, title: m.status.title }, m.status.word) : null,
      m.age ? h('span', { class: `cs-age${m.stale ? ' stale' : ''}`, title: m.ageTitle, 'aria-label': `Screened by GoPlus ${m.age} ago${m.stale ? ', stale' : ''}` }, m.stale ? icon('clock') : null, h('span', { 'aria-hidden': 'true' }, `GoPlus ${m.age}`)) : null),
    h('ul', { class: 'cc-chips', 'aria-label': 'Contract checks from GoPlus' },
      m.chips.map((c) => h('li', { class: `cchip ${c.dot}`, title: c.title || null, 'aria-label': c.aria }, h('span', { class: 'cc-dot', 'aria-hidden': 'true' }), h('span', { class: 'cc-l', 'aria-hidden': 'true' }, c.label), h('span', { class: 'cc-val', 'aria-hidden': 'true' }, c.value))),
      [...m.extra].sort((a, b) => badgeRank(a) - badgeRank(b)).map((b) => h('li', { class: 'cchip risky severe', title: b.title, 'aria-label': b.aria }, h('span', { class: 'cc-dot', 'aria-hidden': 'true' }), h('span', { class: 'cc-l', 'aria-hidden': 'true' }, b.label), b.value !== null ? h('span', { class: 'cc-val', 'aria-hidden': 'true' }, b.value) : null))));
}


// Links out, on the price line: the project's CoinGecko listing, DexScreener
// and its official website, as small labeled pills. A link the desk does not hold
// is left out, never guessed. DexScreener is the verified contract's page
// (from the index row's screen summary), else a search for the ticker.
function headLinks(p) {
  const web = /^https?:\/\//i.test(String(p.official_website || '')) ? p.official_website : null;
  const host = web ? (() => { try { return new URL(web).hostname.replace(/^www\./, ''); } catch (_) { return null; } })() : null;
  const dex = dexLink(rowProject(p));
  const link = (cls, label, href, title, aria) => h('a', { class: `xlink ${cls}`, href, target: '_blank', rel: 'noopener noreferrer', title, 'aria-label': aria, dataset: { key: `x-${cls}-${p.project_id}` } }, label);
  return h('div', { class: 'ph-links' },
    p.coingecko_id ? link('cg', [icon('ext'), h('span', null, 'CG')], `https://www.coingecko.com/en/coins/${encodeURIComponent(p.coingecko_id)}`, `CoinGecko: ${p.coingecko_id}`, 'CoinGecko listing') : null,
    dex ? link('dex', [icon('ext'), h('span', null, 'DexScreener')], dex.href, dex.title, dex.aria) : null,
    web && host ? link('web', [icon('ext'), h('span', null, 'Web')], web, `Official website: ${host}`, `Official website, ${host}`) : null);
}

// On-chain fundamentals: DefiLlama's 30-day fees and revenue as saved, for a
// project bound to a DefiLlama entity (a partial month is not a total), then
// activity and TVL, which need an on-chain source such as Artemis: none is
// connected, so they say so and show no figures. Nothing is estimated.
const ONCHAIN = ['Daily active addresses', 'Transactions', 'TVL'];
function onchainPart(p) {
  const fund = (key, k) => { const x = fundamentalsTile(p.fundamentals, key); return h('div', { title: x.title }, h('dt', null, k), h('dd', { class: `fig${x.stale ? ' stale' : ''}` }, x.text || dash(k))); };
  return details('On-chain fundamentals', h('div', { class: 'small' },
    defillamaBound(p.fundamentals) ? h('dl', { class: 'facts onchain' }, fund('fees', '30D fees (DefiLlama)'), fund('revenue', '30D revenue (DefiLlama)')) : null,
    h('p', { class: 'onchain-note' }, h('span', { class: 'chip info', title: 'No on-chain data source (such as Artemis) is set up; nothing is estimated' }, 'Not connected')),
    h('dl', { class: 'facts onchain' }, ONCHAIN.map((k) => h('div', null, h('dt', null, k), h('dd', null, dash(k)))))), { id: `insp-onchain-${p.project_id}` });
}

// Detail state inside the inspector, kept across a redraw: scroll positions,
// open details and the focused control.
function capturePanel(root) {
  const out = { scroll: {}, open: {}, focus: null };
  for (const el of root.querySelectorAll('[data-keep-scroll]')) out.scroll[el.dataset.keepScroll] = el.scrollTop;
  for (const d of root.querySelectorAll('details[data-key]')) out.open[d.dataset.key] = d.open;
  const a = document.activeElement;
  if (a && root.contains(a)) {
    const keyed = a.closest('[data-key]');
    out.focus = keyed ? keyed.dataset.key : a.id || null;
  }
  return out;
}

function restorePanel(root, s, { focus = true } = {}) {
  for (const d of root.querySelectorAll('details[data-key]')) if (Object.prototype.hasOwnProperty.call(s.open, d.dataset.key)) d.open = s.open[d.dataset.key];
  for (const el of root.querySelectorAll('[data-keep-scroll]')) if (s.scroll[el.dataset.keepScroll]) el.scrollTop = s.scroll[el.dataset.keepScroll];
  if (focus && s.focus) {
    const el = root.querySelector(`[data-key="${CSS.escape(s.focus)}"]`) || root.querySelector(`#${CSS.escape(s.focus)}`);
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
  }
}

// Moves a filled-in part into its slot in the new panel. Node.moveBefore
// (between two parents in the page) keeps live state such as a loaded frame;
// without it the part is re-inserted, as before.
function moveInto(slot, nodes) {
  if (typeof slot.moveBefore === 'function' && slot.isConnected && nodes.every((n) => n.isConnected)) {
    try {
      slot.replaceChildren();
      for (const n of nodes) slot.moveBefore(n, null);
      return;
    } catch (_) { /* re-inserted below */ }
  }
  slot.replaceChildren(...nodes);
}

// The parts that need the full project record, filled in when it arrives
// (from the cache on a redraw, so nothing flickers).
async function fillDetail(ctx, pid, panel, saved, prov) {
  let d;
  let mod;
  try {
    [d, mod] = await Promise.all([ctx.projectDetail(pid), import('./inspector.js')]);
  } catch (err) {
    // The header's DEX pill keeps its ticker search, and no DEX card is shown.
    for (const slot of panel.querySelectorAll('[data-slot]')) if (slot.dataset.slot !== 'dex') slot.replaceChildren(h('p', { class: 'small muted' }, `Could not load the full record: ${err.message}. The summary above is current.`));
    return;
  }
  if (!panel.isConnected || ctx.state.route.query.get('p') !== pid) return;
  const row = ctx.state.index.projects.find((x) => x.project_id === pid) || {};
  const parts = mod.inspectorParts(ctx, d, row, prov);
  for (const slot of panel.querySelectorAll('[data-slot]')) {
    if (!Object.prototype.hasOwnProperty.call(parts, slot.dataset.slot)) continue;
    const part = parts[slot.dataset.slot];
    // A part already in its slot (the chart keeps its element) stays put.
    if (part && slot.childNodes.length === 1 && slot.firstChild === part) continue;
    slot.replaceChildren(...(part ? [part] : []));
  }
  restorePanel(panel, saved, { focus: !view.focusTab });
}

function renderPanel(ctx, pid) {
  const root = document.getElementById('panel-root');
  const p = ctx.state.index.projects.find((x) => x.project_id === pid);
  const saved = capturePanel(root);
  const reopened = view.panelPid !== pid;
  // Another project (J/K): it starts at its top, not where the last one was.
  if (reopened) saved.scroll = {};
  // Rows and sections you opened stay open across a model switch and a refresh.
  view.keptOpen = reopened ? {} : { ...view.keptOpen, ...saved.open };
  saved.open = view.keptOpen;
  const oldSlots = reopened ? {} : Object.fromEntries([...root.querySelectorAll('[data-slot]')].map((el) => [el.dataset.slot, [...el.childNodes]]));
  if (!p) {
    clear(root);
    document.body.classList.remove('split');
    setSheetMode(false);
    const bd = document.querySelector('.sheet-backdrop');
    if (bd) bd.remove();
    view.panelPid = null;
    return;
  }
  // Opened from a model's badge: that model's tab.
  if (view.focusOnRender && view.focusProvider) view.inspectorTab[pid] = view.focusProvider;
  const sel = selectedModel(p);
  const split = wide();
  const m = mkt(p);
  const closeBtn = h('button', { type: 'button', class: 'close quiet', 'aria-label': `Close ${p.name} details`, title: 'Close (Esc)', dataset: { key: 'panel-close' } }, '✕');
  closeBtn.onclick = () => closePanel(ctx);
  const reviewedBtn = button('Mark reviewed', null, { kind: 'small primary', key: 'panel-reviewed' });
  reviewedBtn.setAttribute('aria-keyshortcuts', 'R');
  reviewedBtn.title = 'Mark reviewed (R marks it and moves to the next project to review)';
  reviewedBtn.onclick = () => markReviewed(ctx, p, { advance: false, button: reviewedBtn });
  const ch = p.changes || {};
  const heading = h('h2', { id: 'panel-title', tabindex: '-1', title: p.name }, h('span', { class: 'pt-name' }, p.name), p.symbol ? h('span', { class: 'pt-sym' }, p.symbol) : null);
  const reports = PROVIDERS.filter((x) => p.providers && p.providers[x] && !p.providers[x].needs_text).length;
  const selRep = p.providers && p.providers[sel];
  const panel = h('aside', split
    ? { class: `panel${reopened ? ' entering' : ''}`, role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'panel-title' }
    : { class: `panel${reopened ? ' entering' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'panel-title' },
    h('div', { class: 'panel-head' },
      // The name has the whole top row (it wraps, never cut short); the links
      // out sit on the price line under it; then one row of four figures.
      h('div', { class: 'ph-row' }, logo(p, { size: 32 }),
        h('div', { class: 'names' }, heading),
        h('div', { class: 'ph-win' }, inspectorMenu(ctx, p), closeBtn)),
      h('div', { class: 'ph-sub' }, headMarket(p, ctx.state.index.freshness && ctx.state.index.freshness.market), headLinks(p)),
      overviewStats(p)),
    // Its scroll key names the project: the page's state restore (app.js)
    // then puts a redraw of the same project back where it was, and never
    // carries one project's place over to another.
    h('div', { class: 'panel-body', 'data-keep-scroll': `panel:${pid}` },
      archivedBanner(ctx, p),
      problemLines(ctx, p),
      // a–d: the verdict, its review items, the thesis, the category grades
      // and the strongest risks, all for the selected model.
      h('section', { class: 'scorecard', 'aria-labelledby': 'insp-sec-scores' },
        // The Claude Brief: Claude's latest report as one decision page.
        h('div', { class: 'sec-head' },
          h('h3', { class: 'sec-title sec-scores', id: 'insp-sec-scores' }, 'Verdict'),
          briefLink(ctx, p, { from: 'watchlist', cls: 'btn small brief-link', onOpen: () => { view.briefReturn = pid; } })),
        modelTabs(ctx, p, sel),
        modelPanel(ctx, p, sel)),
      // e: market structure: DEX liquidity, then the contract chips.
      h('section', { class: 'insp-sec insp-market', 'aria-labelledby': 'insp-sec-market' },
        h('h3', { class: 'sec-title', id: 'insp-sec-market' }, 'Market structure'),
        h('div', { class: 'dex-slot', dataset: { slot: 'dex' } }, dexCard(ctx, rowProject(p))),
        contractChipsEl(p)),
      // f: everything else, folded.
      h('div', { class: 'insp-more' },
        h('div', { class: 'chart-slot', dataset: { slot: 'chart' } }),
        selRep ? details('Evidence and sources', h('div', { dataset: { slot: `evidence-${sel}` } }, skeleton('Loading the evidence checks')), { id: `insp-evd-${sel}` }) : null,
        selRep ? details('Timing, risks and the report', timingFacts(ctx, p, sel), { id: `insp-timing-${sel}` }) : null,
        onchainPart(p),
        reports >= 2 ? details('Compare the models', h('div', null, comparisonNote(ctx, p), h('div', { dataset: { slot: 'compare' } })), { id: `insp-compare-${pid}` }) : null,
        m ? details('Market details', h('div', null,
          m.sparkline_7d ? h('div', { style: { margin: '4px 0 8px' } }, sparkline(m.sparkline_7d, { width: 300, height: 48, label: `${p.symbol || p.name} 7-day price` })) : null,
          h('dl', { class: 'facts' },
            h('div', null, h('dt', null, '7D, rolling'), h('dd', null, deltaCell(m.change_7d_pct, 'over 7 days'))),
            h('div', null, h('dt', null, '30D, rolling'), h('dd', null, deltaCell(m.change_30d_pct, 'over 30 days'))),
            h('div', null, h('dt', null, m.rank_source_label && /fictional/i.test(m.rank_source_label) ? 'Rank (demo data)' : 'Rank (CoinGecko)'), h('dd', null, m.market_cap_rank ? `#${m.market_cap_rank}` : 'Unranked')),
            h('div', null, h('dt', null, 'FDV'), h('dd', null, fmtMarketFigure(m.fdv_usd) || unknownFigure('FDV', m.fdv_usd))),
            ...vsBtcFacts(m),
            h('div', { class: 'wide' }, h('dt', null, 'Source'), h('dd', { class: 'small' }, `${m.rank_source_label && /fictional/i.test(m.rank_source_label) ? 'Fictional demo data' : 'CoinGecko'} · as of ${fmtDateTime(m.as_of)}`)))), { id: `insp-market-${pid}` }) : null,
        details('Research details', h('div', null, researchProgress(ctx, p)), { id: `insp-research-${pid}` }),
        // The contract checks in full (the chips above are the summary).
        h('div', { dataset: { slot: 'checks' } }),
        selRep ? h('div', { class: 'btn-row insp-links' },
          h('a', { class: 'btn small', href: `#/project/${encodeURIComponent(pid)}/brief?model=${sel}&open=scorecard`, dataset: { key: `scorecard-${pid}-${sel}` } }, 'Full scorecard')) : null)),
    // The foot: what changed since your review, the report, Mark reviewed.
    h('div', { class: 'panel-foot' },
      h('p', { class: 'pf-sum', title: p.next_review ? `Next review: ${fmtDate(p.next_review.date)}${p.next_review.overdue ? ' (overdue)' : ''}` : null },
        ch.item_count
          ? [`${ch.item_count} change${ch.item_count === 1 ? '' : 's'} since ${ch.cursor_source === 'project created' ? 'added' : 'your last review'}`, h('span', { class: 'pf-dot', 'aria-hidden': 'true' }, '·'), h('a', { href: `#/project/${encodeURIComponent(pid)}/notes`, dataset: { key: `history-${pid}` } }, 'What changed')]
          : h('span', { class: 'pf-ok' }, 'Reviewed')),
      h('div', { class: 'pf-act' },
        selRep ? h('a', { class: 'btn small', href: `#/project/${encodeURIComponent(pid)}/report?report=${encodeURIComponent(selRep.report_id)}`, dataset: { key: `report-${pid}-${sel}` } }, 'Open report') : null,
        ch.item_count ? reviewedBtn : null)));
  // The slide-in runs once; the class goes when it ends.
  if (reopened) panel.addEventListener('animationend', () => panel.classList.remove('entering'), { once: true });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.querySelector('dialog[open]')) {
      e.stopPropagation();
      closePanel(ctx);
    }
  });
  // The parts already filled in move over to the new panel, so nothing
  // flickers. Both panels are in the page for that moment: where the browser
  // can (Node.moveBefore), a part keeps its live state as it moves, so the
  // technical chart's frame does not reload on a redraw.
  const previous = [...root.children];
  root.appendChild(panel);
  for (const slot of panel.querySelectorAll('[data-slot]')) if (oldSlots[slot.dataset.slot] && oldSlots[slot.dataset.slot].length) moveInto(slot, oldSlots[slot.dataset.slot]);
  for (const el of previous) el.remove();
  view.panelPid = pid;
  document.body.classList.toggle('split', split);
  let bd = document.querySelector('.sheet-backdrop');
  if (!split) {
    if (!bd) {
      bd = h('div', { class: 'sheet-backdrop', 'aria-hidden': 'true', onclick: () => closePanel(ctx) });
      document.body.appendChild(bd);
    }
    setSheetMode(true);
  } else {
    if (bd) bd.remove();
    setSheetMode(false);
  }
  const opening = view.focusOnRender;
  // Back from the Claude Brief opened here: focus returns to its link.
  const fromBrief = view.briefReturn === pid ? panel.querySelector(`[data-key="brief-${CSS.escape(pid)}"]`) : null;
  view.briefReturn = null;
  if (!opening) restorePanel(panel, saved, { focus: true });
  // Another project (a click, J/K, R, a link): its top. The same project
  // redrawn (a price refresh, a new report): where you were.
  if (reopened) {
    const body = panel.querySelector('.panel-body');
    if (body) body.scrollTop = 0;
  }
  // Focus moves into the inspector only when you open it, never on a live refresh.
  if (view.focusTab) {
    const t = panel.querySelector(`#insp-tab-${view.focusTab}`);
    if (t) {
      t.focus({ preventScroll: true });
      ctx.claimFocus();
    }
    // A model chosen from further down: its selector comes back into view.
    const body = panel.querySelector('.panel-body');
    const list = panel.querySelector('.mtabs');
    if (body && list) {
      const above = body.getBoundingClientRect().top - list.getBoundingClientRect().top;
      if (above > 0) body.scrollTop -= above + 8;
      saved.scroll[`panel:${pid}`] = body.scrollTop;
    }
  } else if (opening) {
    const target = view.focusProvider ? panel.querySelector(`#insp-tab-${view.focusProvider}`) : heading;
    if (target) {
      target.focus({ preventScroll: false });
      ctx.claimFocus();
    }
    const row = document.querySelector(`tr[data-pid="${CSS.escape(pid)}"]`);
    if (row && split) row.scrollIntoView({ block: 'nearest' });
  } else if (fromBrief) {
    fromBrief.focus({ preventScroll: true });
    ctx.claimFocus();
  } else if (!split && !panel.contains(document.activeElement)) {
    heading.focus({ preventScroll: true });
    ctx.claimFocus();
  } else if (panel.contains(document.activeElement)) ctx.claimFocus();
  // A peek beside the list (J/K, Space): focus stays on the row; say what is shown.
  else if (reopened && split) announce(`Showing ${p.name} beside the list. Escape closes it.`);
  view.focusOnRender = false;
  view.focusProvider = null;
  fillDetail(ctx, pid, panel, opening ? { scroll: {}, open: {}, focus: null } : saved, sel).then(() => { view.focusTab = null; });
}

// With nothing chosen the list has the whole width (Eric, 2026-10-05): the
// inspector appears only when a project is clicked or opened.
function showEmptyPane() {
  const root = document.getElementById('panel-root');
  setSheetMode(false);
  const bd = document.querySelector('.sheet-backdrop');
  if (bd) bd.remove();
  clear(root);
  document.body.classList.remove('split');
}

// What R does with the selected project: mark it reviewed (only with changes
// to review), offer Undo for six seconds, and move to the next project in the
// list's order that has changes to review ("All caught up" when none).
// Pure parts, for the tests.
export const needsReview = (p) => Boolean(p && p.changes && p.changes.item_count > 0 && p.status !== 'archived');
export function nextToReview(order, projects, pid) {
  const byId = new Map(projects.map((x) => [x.project_id, x]));
  const i = order.indexOf(pid);
  for (let k = 1; k <= order.length; k++) {
    const id = order[(i + k) % order.length];
    if (id !== pid && needsReview(byId.get(id))) return id;
  }
  return null;
}
// R counts only as a plain key, outside fields, with no dialog or menu open,
// on a project with something to review.
export function reviewKeyAllowed(e, { busy = false, project = null } = {}) {
  if (!e || (e.key !== 'r' && e.key !== 'R') || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false;
  if (busy) return false;
  return needsReview(project);
}

async function markReviewed(ctx, p, { advance = false, button: btn = null } = {}) {
  if (!needsReview(p)) return;
  const pid = p.project_id;
  const order = [...document.querySelectorAll('table.wl tbody tr[data-pid]')].map((tr) => tr.dataset.pid);
  const next = advance ? nextToReview(order, ctx.state.index.projects, pid) : null;
  if (btn) btn.disabled = true;
  let out;
  try {
    out = await ctx.api.post(`/api/projects/${encodeURIComponent(pid)}/reviewed`, {});
  } catch (err) {
    toast(err.message, 'bad');
    if (btn) btn.disabled = false;
    return;
  }
  const res = (out && out.result) || {};
  toast(`Marked ${p.name} reviewed`, '', {
    ms: 6000,
    action: {
      label: 'Undo',
      key: 'undo-review',
      onClick: async () => {
        await ctx.api.post(`/api/projects/${encodeURIComponent(pid)}/reviewed/undo`, { previous: res.previous === undefined ? null : res.previous, expect: res.reviewed_at });
        toast(`${p.name}: review undone`);
        await ctx.refresh();
      },
    },
  });
  if (advance) {
    if (next) {
      const name = document.querySelector(`[data-key="pname-${CSS.escape(next)}"]`);
      openPanel(ctx, next, name, null, { peek: wide() });
    } else toast('All caught up');
  }
  await ctx.refresh();
}

// After the inspector closes (its button, Escape, Back): focus returns to the
// project it was opened from, the list stays where it was, and from 1280px
// the pane stays, empty.
function afterPanelClosed(ctx) {
  const pid = view.panelPid;
  view.panelPid = null;
  showEmptyPane();
  if (!pid) return;
  view.recent = pid;
  for (const tr of document.querySelectorAll('table.wl tbody tr')) tr.className = rowClass(ctx, tr.dataset.pid) || '';
  const key = view.returnFocus;
  const el = (key && document.querySelector(`[data-key="${CSS.escape(key)}"]`)) || document.querySelector(`[data-key="pname-${CSS.escape(pid)}"]`);
  if (el) {
    view.suppressFocus = true;
    el.focus({ preventScroll: true });
    view.suppressFocus = false;
    ctx.claimFocus();
  }
  view.returnFocus = null;
}

// ---- page ---------------------------------------------------------------------

// What a manual price refresh did, for its toast: anything but a full or
// partial update is a failure, said plainly, with the age of the prices still shown.
export function refreshToast(out) {
  const r = out && out.result;
  const st = (out && out.status) || {};
  if (r && ['ok', 'partial'].includes(r.status)) return [r.message || 'Prices refreshed', ''];
  const why = String((r && r.message) || st.note || st.last_error || 'the price source did not answer').replace(/^not refreshed:\s*/i, '').replace(/[.\s]+$/, '');
  const shown = st.last_success_at ? `Showing prices from ${fmtDateTime(st.last_success_at)}.` : 'There are no earlier prices to show.';
  return [`Prices not refreshed: ${why}. ${shown}`, 'bad'];
}

// Keys that never fire while typing or editing.
const typing = (el) => Boolean(el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)));

// J and K: the next or previous project in the order shown. With the
// inspector open it follows, showing that project (from the list it is a
// peek and focus stays on the row; from inside the inspector focus moves to
// the new project's name there). With it closed, the row's name is focused.
function stepProject(ctx, dir) {
  const rows = [...document.querySelectorAll('table.wl tbody tr[data-pid]')];
  if (!rows.length) return false;
  const open = ctx.state.route.query.get('p');
  const active = document.activeElement;
  const fromRow = active && active.closest ? active.closest('table.wl tbody tr[data-pid]') : null;
  const current = fromRow || (open ? rows.find((tr) => tr.dataset.pid === open) : null) || null;
  const i = current ? rows.indexOf(current) + dir : dir > 0 ? 0 : rows.length - 1;
  if (i < 0 || i >= rows.length) return true; // at the first or last project: stay
  const next = rows[i];
  const name = next.querySelector('.pname');
  const inList = Boolean(fromRow) || !open;
  if (inList && name) {
    view.suppressFocus = true;
    name.focus({ preventScroll: true });
    view.suppressFocus = false;
    next.scrollIntoView({ block: 'nearest' });
  }
  if ((open || wide()) && open !== next.dataset.pid) openPanel(ctx, next.dataset.pid, name, null, { peek: inList && wide() });
  return true;
}

function moveRow(e) {
  const from = e.target.closest && e.target.closest('table.wl tbody td');
  if (!from) return false;
  const tr = from.parentElement;
  const next = e.key === 'ArrowDown' ? tr.nextElementSibling : tr.previousElementSibling;
  if (!next) return true;
  const cell = next.cells[from.cellIndex];
  const target = (cell && cell.querySelector('button')) || next.querySelector('.pname');
  if (target) {
    target.focus();
    target.scrollIntoView({ block: 'nearest' });
  }
  return true;
}

export function renderWatchlist(ctx, route) {
  // A redraw of the page you are on (a live update, a saved change, opening
  // or closing the inspector) updates it in place.
  if (view.mounted && view.mounted.page.isConnected && ['live', 'same', 'refresh'].includes(ctx.state.renderReason)) {
    view.mounted.update(ctx.state.renderReason, route);
    return view.mounted.page;
  }
  const prefsObj = prefs(ctx);
  const all = () => ctx.state.index.projects.filter((p) => !p.broken);
  const head = h('div', { class: 'wl-head' });
  const strip = h('div', { class: 'status-strip', role: 'group', 'aria-label': 'Status' });
  const stripPanel = h('div', { class: 'ss-panel', id: 'ss-panel', role: 'region', 'aria-label': 'Status details', hidden: true });
  const holder = h('div');
  const resultsLine = h('div', { class: 'results-line', role: 'status' });
  const tokens = h('div', { class: 'active-filters' });
  const toolbar = h('div', { class: 'toolbar', role: 'search', 'aria-label': 'Find and filter projects', dataset: { nodirty: '1' } });
  view.menus = [];
  view.mounted = null;

  const filterCount = () => {
    const f = prefsObj.filters;
    return [f.sector, f.coverage !== 'any', f.ret30 !== 'any', f.archived].filter(Boolean).length;
  };

  const rerender = (reason = 'user') => {
    const f = prefsObj.filters;
    const list = all();
    const fresh = sortRows(list.filter((p) => matches(p, f, view.q)), prefsObj.sort);
    const key = JSON.stringify([prefsObj.sort, f, view.q]);
    let rows = fresh;
    let reordered = false;
    // A live update never reorders the rows you are looking at.
    if (reason === 'live' && view.order && view.orderKey === key) {
      const pos = new Map(view.order.map((id, i) => [id, i]));
      rows = fresh.slice().sort((a, b) => (pos.has(a.project_id) ? pos.get(a.project_id) : 1e9) - (pos.has(b.project_id) ? pos.get(b.project_id) : 1e9));
      reordered = rows.some((r, i) => r.project_id !== fresh[i].project_id);
    }
    view.order = rows.map((r) => r.project_id);
    view.orderKey = key;
    view.rowsIndex = ctx.state.index;
    const total = list.filter((p) => (f.archived ? p.status === 'archived' : p.status !== 'archived')).length;
    const filtered = Boolean(view.q) || filterCount() > 0 || f.owned !== DEFAULT_FILTERS.owned;
    // Only what the list itself does not show: a filtered count, or rows kept in place.
    resultsLine.replaceChildren(...[
      filtered ? h('span', null, `${rows.length} of ${total} ${f.archived ? 'archived' : 'saved'} projects`) : null,
      reordered ? h('span', { class: 'reorder' }, h('span', null, 'Values updated; order kept while you read.'), button('Re-sort', () => { view.order = null; rerender(); announce('Re-sorted.'); }, { kind: 'small', key: 'resort' })) : null,
    ].filter(Boolean));
    resultsLine.classList.toggle('hidden', !filtered && !reordered);
    drawTokens();
    if (rows.length) {
      holder.replaceChildren(buildTable(ctx, prefsObj, rows, () => rerender()));
      if (holder.isConnected) fitColumns(holder);
    } else if (!list.filter((p) => p.status !== 'archived').length && !f.archived) {
      holder.replaceChildren(h('div', { class: 'empty' }, h('h2', null, 'Your watchlist is empty'),
        h('div', { class: 'btn-row' }, button('Add project', () => openAddProjectDialog(ctx), { kind: 'primary', key: 'empty-add' }))));
    } else if (f.owned === 'watching' && !view.q && !filterCount()) {
      // Projects exist, but none is watched or held.
      holder.replaceChildren(h('div', { class: 'empty' }, h('h2', null, 'Nothing on your watchlist'),
        h('p', null, `${total} project${total === 1 ? ' is' : 's are'} saved but not watched.`),
        h('div', { class: 'btn-row' }, button('Show not watching', () => setFilter('owned', 'off'), { key: 'empty-off' }))));
    } else {
      holder.replaceChildren(h('div', { class: 'empty' }, h('h2', null, 'No projects match'),
        h('p', null, `${total} project${total === 1 ? ' is' : 's are'} hidden by the current search or filters.`),
        h('div', { class: 'btn-row' }, button('Clear search and filters', () => clearAll(), { key: 'empty-clear' }))));
    }
  };

  const setFilter = (k, v) => {
    prefsObj.filters = { ...prefsObj.filters, [k]: v };
    savePrefs(ctx, prefsObj);
    view.order = null;
    drawControls();
    rerender();
    announce(resultsLine.textContent || 'Filter applied.');
  };

  const clearAll = () => {
    view.q = '';
    search.value = '';
    prefsObj.filters = { ...DEFAULT_FILTERS };
    savePrefs(ctx, prefsObj);
    view.order = null;
    drawControls();
    rerender();
    announce('Search and filters cleared.');
  };

  const search = input({ type: 'search', placeholder: 'Search name, ticker or sector', 'aria-label': 'Search projects', 'aria-keyshortcuts': '/ Control+K Meta+K', value: view.q, dataset: { key: 'wl-search' } });
  search.addEventListener('input', () => {
    view.q = search.value;
    view.order = null;
    rerender();
  });
  // Down moves into the list; Enter opens the first match while searching.
  search.addEventListener('keydown', (e) => {
    if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const first = holder.querySelector('table.wl tbody .pname');
    if (e.key === 'ArrowDown' && first) {
      e.preventDefault();
      first.focus();
    } else if (e.key === 'Enter' && search.value.trim() && first) {
      e.preventDefault();
      openPanel(ctx, first.closest('tr').dataset.pid, first);
    }
  });
  const searchWrap = h('div', { class: 'search' }, search, h('kbd', { 'aria-hidden': 'true', title: `Also ${/Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘K' : 'Ctrl K'}` }, '/'));

  function drawTokens() {
    const f = prefsObj.filters;
    const list = [];
    const tok = (label, onRemove, key) => h('span', { class: 'token' }, label, h('button', { type: 'button', 'aria-label': `Remove filter: ${label}`, dataset: { key }, onclick: onRemove }, '×'));
    if (view.q) list.push(tok(`Search: “${view.q}”`, () => { view.q = ''; search.value = ''; view.order = null; rerender(); search.focus(); }, 'tok-q'));
    if (f.sector) list.push(tok(`Sector: ${((ctx.state.index.sectors || []).find((s) => s.id === f.sector) || { label: f.sector }).label}`, () => setFilter('sector', ''), 'tok-sector'));
    if (f.coverage !== 'any') list.push(tok(COVERAGE.find(([v]) => v === f.coverage)[1], () => setFilter('coverage', 'any'), 'tok-coverage'));
    if (f.ret30 !== 'any') list.push(tok(`30D ${f.ret30 === 'pos' ? 'positive' : 'negative'}`, () => setFilter('ret30', 'any'), 'tok-ret30'));
    if (f.archived) list.push(tok('Archived only', () => setFilter('archived', false), 'tok-archived'));
    if (list.length) list.push(button('Clear all', () => clearAll(), { kind: 'link small', key: 'tok-clear' }));
    tokens.replaceChildren(...list);
    tokens.classList.toggle('hidden', !list.length);
  }

  function drawControls() {
    const f = prefsObj.filters;
    view.menus = [];
    const filters = menu('Filters', { key: 'filters', count: filterCount() }, (api) => {
      const idx = ctx.state.index;
      const list = all().filter((p) => p.status !== 'archived');
      const sectorCounts = Object.fromEntries((idx.sectors || []).map((s) => [s.id, list.filter((p) => p.sector && p.sector.primary === s.id).length]));
      return [
        radioGroup('f-sector', 'Sector', [['', 'All sectors', list.length], ...(idx.sectors || []).map((s) => [s.id, s.label, sectorCounts[s.id]])], prefsObj.filters.sector, (v) => setFilter('sector', v)),
        radioGroup('f-coverage', 'Model coverage', COVERAGE, prefsObj.filters.coverage, (v) => setFilter('coverage', v)),
        radioGroup('f-ret30', '30-day change', RET30, prefsObj.filters.ret30, (v) => setFilter('ret30', v)),
        h('fieldset', null, h('legend', null, 'Archive'), h('label', null, h('input', { type: 'checkbox', checked: prefsObj.filters.archived, onchange: (e) => setFilter('archived', e.target.checked) }), h('span', null, 'Show archived projects only'))),
        h('div', { class: 'menu-foot' }, button('Clear filters', () => { clearAll(); api.close(); }, { kind: 'small quiet' }), button('Done', () => api.close(), { kind: 'small primary' })),
      ];
    });
    const columns = menu('Columns', { key: 'columns', right: true }, (api) => [
      h('fieldset', null, h('legend', null, 'Show columns'), COLUMNS.filter((c) => c.id !== 'research').map((c) => h('div', null,
        h('label', { title: c.title || null }, h('input', {
          type: 'checkbox', checked: prefsObj.columns.includes(c.id), disabled: Boolean(c.disabled),
          onchange: (e) => {
            prefsObj.columns = e.target.checked ? [...new Set([...prefsObj.columns, c.id])] : prefsObj.columns.filter((x) => x !== c.id);
            prefsObj.columns = COLUMNS.filter((x) => prefsObj.columns.includes(x.id) || x.id === 'research').map((x) => x.id);
            savePrefs(ctx, prefsObj);
            rerender();
          },
        }), h('span', null, c.label, c.sub ? h('span', { class: 'faint' }, ` · ${c.sub}`) : null)),
        c.disabled ? h('div', { class: 'disabled-note' }, c.disabled) : null))),
      h('p', { class: 'small muted', style: { margin: '0 0 8px' } }, 'Narrow windows hide some columns; every value stays in the project details.'),
      h('div', { class: 'menu-foot' }, button('Reset columns', () => { prefsObj.columns = COLUMNS.filter((c) => c.def).map((c) => c.id); savePrefs(ctx, prefsObj); rerender(); api.close(); }, { kind: 'small quiet' }), button('Done', () => api.close(), { kind: 'small primary' })),
    ]);
    columns.classList.add('columns-wide');
    const sortSel = select(Object.entries(SORT_NAMES).flatMap(([k, [label, a, d]]) => [{ value: `${k}:asc`, label: `${label}, ${a}` }, { value: `${k}:desc`, label: `${label}, ${d}` }]), {
      class: 'sort-compact', 'aria-label': 'Sort projects',
      onchange: (e) => { const v = e.target.value; const dir = v.split(':').pop(); prefsObj.sort = { key: v.slice(0, v.length - dir.length - 1), dir }; savePrefs(ctx, prefsObj); view.order = null; rerender(); },
    });
    sortSel.value = `${prefsObj.sort.key}:${prefsObj.sort.dir}`;
    toolbar.replaceChildren(
      searchWrap,
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' }, OWNED.map(([v, text]) => h('button', { type: 'button', 'aria-pressed': String(v === f.owned), dataset: { key: `owned-${v}` }, onclick: () => setFilter('owned', v) }, text))),
      filters, sortSel, columns);
  }

  const refreshBtn = h('button', { type: 'button', class: 'ss-icon', dataset: { key: 'refresh-prices' } }, h('span', { class: 'ico i-refresh', 'aria-hidden': 'true' }), h('span', { class: 'lbl' }, 'Refresh'));
  refreshBtn.setAttribute('aria-label', 'Refresh prices now');
  refreshBtn.onclick = async () => {
    const m = ctx.state.index.freshness.market;
    refreshBtn.disabled = true;
    refreshBtn.querySelector('.lbl').textContent = 'Refreshing…';
    try {
      const out = await ctx.api.post('/api/market/refresh', {});
      toast(...refreshToast(out));
      await ctx.refresh();
    } catch (err) {
      toast(...refreshToast({ result: { status: 'failed', message: err.message }, status: m }));
    } finally {
      if (refreshBtn.isConnected) {
        refreshBtn.disabled = false;
        refreshBtn.querySelector('.lbl').textContent = 'Refresh';
      }
    }
  };
  const addBtn = button('Add project', () => openAddProjectDialog(ctx), { kind: 'primary', key: 'add-project' });
  addBtn.id = 'add-project-btn';

  function drawHead() {
    // The nav's count and the results line say how many; New research is in the nav.
    head.replaceChildren(
      h('div', { class: 'title' }, h('h1', null, 'Watchlist')),
      h('div', { class: 'actions' }, addBtn));
  }

  // The status strip: one compact line under the title, in three groups with
  // one kind of separator: [prices, with a rate-limit badge and its countdown
  // beside Refresh] | [Bitcoin and the market, only with a captured snapshot]
  // | [breadth over 30 days, what needs action, the review queue]. The
  // models' routes are in Settings and each model's tab. Each part opens its
  // details below. What needs action (a call that may have been billed,
  // failed or stalled research, saving blocked) is always named in the strip
  // in words, never folded into a count alone.
  function drawStatus() {
    const idx = ctx.state.index;
    const { critical, rest } = splitAttention(idx.attention || []);
    const high = rest.filter((a) => a.severity === 'high').length;
    // The review queue stays a count in the strip (urgent ones named in
    // words) and opens when you ask; it remembers that you left it open.
    if (!view.stripReady && ctx.ui.get('reviewOpen', false)) view.strip = view.strip || 'review';
    view.stripReady = true;
    if (view.strip === 'review' && !rest.length) view.strip = null;
    if (view.strip === 'action' && !critical.length) view.strip = null;
    const m = idx.freshness.market;
    const ps = priceStatus(m);
    const items = [];
    const divider = () => h('span', { class: 'ss-div', 'aria-hidden': 'true' });
    const dot = () => h('span', { class: 'ss-dot', 'aria-hidden': 'true' }, '·');
    // 1. Prices and Refresh. Rate limited: said by the badge beside Refresh, not twice.
    const priceWord = ps.problem && !m.rate_limited ? h('span', { class: 'warn-word' }, ps.text) : null;
    items.push(h('span', { class: 'ss-group ss-g1' },
      stripItem('prices', [h('span', { class: 'k' }, view.priceSource === 'CoinGecko' ? 'Prices' : 'Prices (demo)'), h('span', { class: 'v' }, m.last_success_at ? fmtAgo(m.last_success_at) : 'not fetched'), priceWord], { warn: ps.problem, extra: m.last_success_at ? ps.asOf : null, ico: 'clock' }),
      rateBadge(m),
      refreshBtn));
    // 2. Bitcoin and the market.
    const mc = idx.market_context;
    const snap = mc && mc.snapshot;
    const hasSnap = Boolean(snap && snap.bitcoin && typeof snap.bitcoin.price_usd === 'number');
    if (hasSnap) {
      items.push(divider());
      items.push(stripItem('market', marketFigures(snap, mc), { warn: mc.status === 'stale', ico: 'coin', cls: 'ss-market' }));
    }
    // 3. Breadth, what needs action, the review queue.
    const third = [];
    const bw = hasSnap ? breadthWords(snap.breadth && snap.breadth.d30) : null;
    if (bw) {
      const b30 = snap.breadth.d30;
      third.push(stripItem('breadth', [h('span', { class: 'breadth' }, typeof b30.share_pct === 'number' ? h('span', { class: 'breadth-bar', 'aria-hidden': 'true' }, h('span', { style: { width: `${Math.max(0, Math.min(100, b30.share_pct))}%` } })) : null,
        h('span', { class: 'v fig' }, bw.text), h('span', { class: 'k' }, bw.window))], { cls: 'ss-breadth', extra: bw.title }));
      third[third.length - 1].title = bw.title;
    }
    if (critical.length) {
      const kinds = [...new Set(critical.map(kindWord))];
      const anyHigh = critical.some((a) => a.severity === 'high' || ['research_uncertain', 'research_failed', 'writes_blocked', 'broken_record'].includes(a.kind));
      third.push(stripItem('action', [h('span', { class: anyHigh ? 'bad-word' : 'warn-word' }, kinds.length === 1 ? kinds[0] : `${critical.length} need action`),
        critical.length > 1 && kinds.length === 1 ? h('span', { class: 'v fig' }, `×${critical.length}`) : null,
        kinds.length > 1 ? h('span', { class: 'k ss-kinds' }, kinds.join(' · ')) : null],
      { bad: anyHigh, warn: !anyHigh, ico: 'alert', extra: critical.map((a) => a.title).join('; ') }));
    }
    if (rest.length) {
      // Items in the review queue, not projects: one project can have several.
      third.push(stripItem('review', [h('span', { class: 'v' }, String(rest.length)), h('span', { class: 'k' }, rest.length === 1 ? 'item' : 'items'), high ? h('span', { class: 'bad-word' }, `${high} urgent`) : null], { warn: high > 0, ico: 'tray', extra: 'In the review queue; one project can have several' }));
      third[third.length - 1].title = 'Items in the review queue; one project can have several';
    }
    if (third.length) {
      items.push(divider());
      items.push(h('span', { class: 'ss-group ss-g3' }, third.flatMap((el, i) => (i ? [dot(), el] : [el]))));
    }
    strip.replaceChildren(...items);
    fitStrip(strip);
    drawStripPanel(rest, ps, m, critical);
    startCountdown();
  }

  function drawStripPanel(rest, ps, m, critical = []) {
    const idx = ctx.state.index;
    let body = null;
    if (view.strip === 'action') {
      body = [h('h2', null, `Needs action (${critical.length})`), alertList(critical, 'alert')];
    } else if (view.strip === 'prices') {
      body = [h('h2', null, 'Prices'),
        h('p', null, `${m.last_success_at ? ps.asOf : 'No prices fetched yet'} · source: ${view.priceSource}.`),
        ps.note ? h('p', null, h('span', { class: ps.problem ? 'warn-word' : null }, ps.problem ? 'Note: ' : ''), ps.note) : null,
        ps.retryAt ? h('p', null, `Next try after ${fmtAsOf(ps.retryAt)}.`) : null];
    } else if (view.strip === 'market' || view.strip === 'breadth') {
      body = [marketStrip(idx)];
    } else if (view.strip === 'models') {
      const rs = readinessSummary(idx.research && idx.research.providers, (idx.settings.research || {}).on_hold || {});
      const hosted = hostedDesk(ctx);
      body = [h('h2', null, 'Research models'),
        h('ul', { class: 'ready-list' }, rs.list.map((x) => h('li', null, h('span', { class: 'who' }, PROVIDER_LABELS[x.provider]),
          h('span', null, x.mode === 'api' ? stateText('Automatic (API)', 'ok')
            : x.mode === 'mock' ? stateText('Fictional demo adapter')
              : x.mode === 'hold' ? stateText(`On hold${x.hold.since ? ` since ${fmtDate(x.hold.since)}` : ''}`)
                : h('span', { title: x.reason || null }, stateText(hosted ? 'Manual (its assistant)' : 'Manual (paste and import)'), h('span', { class: 'block faint small' }, setupShort(x.reason))))))),
        h('p', { style: { marginTop: '8px' } }, h('a', { href: '#/settings?tab=research', dataset: { key: 'ss-settings' } }, 'Models and budget settings'))];
    } else if (view.strip === 'review') {
      body = [h('h2', null, `To review (${rest.length})`), reviewList(rest)];
    }
    stripPanel.hidden = !body;
    stripPanel.replaceChildren(...(body || []).filter(Boolean));
  }

  toggleStrip = (key) => {
    const idx = ctx.state.index;
    const { rest } = splitAttention(idx.attention || []);
    const was = view.strip;
    view.strip = was === key ? null : key;
    if ((was === 'review' || view.strip === 'review') && rest.length) ctx.ui.set('reviewOpen', view.strip === 'review');
    drawStatus();
    const again = strip.querySelector(`[data-key="ss-${key}"]`);
    if (again) again.focus();
  };

  function setSources() {
    const idx = ctx.state.index;
    const rankLabels = [...new Set(idx.projects.map((p) => p.market && p.market.rank_source_label).filter(Boolean))];
    const demoData = rankLabels.length > 0 && rankLabels.every((l) => /fictional/i.test(l));
    const demoWorkspace = Boolean(ctx.state.session && ctx.state.session.workspace && ctx.state.session.workspace.kind === 'demo');
    view.rankSource = demoData ? 'Demo data' : 'CoinGecko';
    view.priceSource = demoData || demoWorkspace ? 'fictional demo data' : 'CoinGecko';
    SORT_NAMES.rank[0] = demoData ? 'Rank (demo data)' : 'Rank (CoinGecko)';
  }

  // The inspector follows the address (?p=<id>), so Back and bookmarks restore
  // it. It is drawn once the page is in the document, so it finds the rows.
  const afterMount = () => {
    // The status strip is a full-width band under the bar, outside the
    // centered content (index.html #strip-root); without the band it stays
    // under the title.
    const band = document.getElementById('strip-root');
    if (band && strip.parentNode !== band) band.replaceChildren(strip, stripPanel);
    // The docked inspector fits the window under the strip's row (--band-h);
    // an open status panel pushes it down and the page scrolls.
    const fitBand = () => {
      const h = band && strip.parentNode === band ? Math.ceil(strip.getBoundingClientRect().bottom - band.getBoundingClientRect().top) : 0;
      document.documentElement.style.setProperty('--band-h', `${Math.max(0, h)}px`);
    };
    fitColumns(page);
    fitStrip(strip);
    fitBand();
    if (!view.resizeObserver || view.resizeFor !== page) {
      if (view.resizeObserver) view.resizeObserver.disconnect();
      view.resizeObserver = new ResizeObserver(() => requestAnimationFrame(() => {
        fitColumns(page);
        fitStrip(strip);
        fitBand();
      }));
      view.resizeObserver.observe(page);
      if (band) view.resizeObserver.observe(band);
      view.resizeFor = page;
    }
    const pid = ctx.state.route.query.get('p');
    if (pid) renderPanel(ctx, pid);
    else if (view.panelPid) afterPanelClosed(ctx);
    else showEmptyPane();
    if (ctx.state.focusSearch) {
      ctx.state.focusSearch = false;
      search.focus();
      search.select();
      ctx.claimFocus();
    }
  };

  if (!view.bound) {
    view.bound = true;
    window.matchMedia('(min-width: 1280px)').addEventListener('change', () => {
      const r = ctx.state.route;
      if (!r || r.name !== 'watchlist') return;
      const p = r.query.get('p');
      if (p) renderPanel(ctx, p);
      else showEmptyPane();
    });
    document.addEventListener('keydown', (e) => {
      const r = ctx.state.route;
      const onList = r && r.name === 'watchlist';
      // Up and Down move between projects in the same column (name or a
      // model's grade); Tab still walks every control.
      if (onList && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !typing(e.target) && moveRow(e)) {
        e.preventDefault();
        return;
      }
      const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.isComposing;
      const busy = typing(e.target) || document.querySelector('dialog[open]') || document.querySelector('.menu:not(.hidden), .insp-menu:not([hidden])');
      // J / K: next and previous project (the inspector follows when open).
      if (onList && plain && !busy && (e.key === 'j' || e.key === 'k' || e.key === 'J' || e.key === 'K')) {
        if (stepProject(ctx, e.key.toLowerCase() === 'j' ? 1 : -1)) e.preventDefault();
        return;
      }
      // R: mark the selected project reviewed and go to the next one to review.
      if (onList && !typing(e.target) && (e.key === 'r' || e.key === 'R')) {
        const pid = r.query.get('p');
        const project = pid ? ctx.state.index.projects.find((x) => x.project_id === pid) : null;
        if (reviewKeyAllowed(e, { busy: Boolean(busy), project })) {
          e.preventDefault();
          markReviewed(ctx, project, { advance: true });
        }
        return;
      }
      // Space or Enter on a project's name toggles its inspector. Beside the
      // list (wide screens) it opens as a peek and focus stays on the row;
      // narrower, it opens over the list and focus moves into it.
      if (onList && plain && (e.key === ' ' || e.key === 'Enter') && e.target.classList && e.target.classList.contains('pname')) {
        const tr = e.target.closest('tr[data-pid]');
        if (tr && r.query.get('p') === tr.dataset.pid) {
          e.preventDefault();
          closePanel(ctx);
          return;
        }
        if (tr && wide()) {
          e.preventDefault();
          openPanel(ctx, tr.dataset.pid, e.target, null, { peek: true });
          return;
        }
      }
      if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
      if (document.querySelector('.menu:not(.hidden)')) {
        closeMenus();
        return;
      }
      if (onList && r.query.get('p') && !typing(e.target)) closePanel(ctx);
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.menu-wrap')) closeMenus();
    });
  }

  setSources();
  drawHead();
  drawStatus();
  drawControls();
  // Only a fresh visit re-sorts; live updates, Back and opening the inspector keep the order you saw.
  rerender(['live', 'same', 'refresh', 'pop'].includes(ctx.state.renderReason) ? 'live' : 'user');

  const page = h('div', { class: 'wl-wrap' }, head, strip, stripPanel, toolbar, tokens, resultsLine, holder);
  page.afterMount = afterMount;

  // In-place redraw: the toolbar (and the search you may be typing in) stays;
  // the data parts are redrawn from the new index. Opening or closing the
  // inspector with unchanged data only moves the row highlight.
  const update = (reason) => {
    setSources();
    if (reason === 'same' && view.rowsIndex === ctx.state.index) {
      for (const tr of holder.querySelectorAll('table.wl tbody tr')) tr.className = rowClass(ctx, tr.dataset.pid) || '';
      return;
    }
    drawHead();
    drawStatus();
    rerender('live');
  };
  view.mounted = { page, update };
  return page;
}
