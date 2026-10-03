// Watchlist: the projects you follow, what moved, what each model thinks.
//   Hover or keyboard-focus a grade badge  -> compact scorecard (hoverable, Esc dismisses)
//   Select a project (click, tap, Enter)   -> the project inspector (?p=<id>)
//   Select a provider badge                -> the inspector, focused on that provider
//   Open full research                     -> #/project/<id>/<tab>
// The inspector is a dialog: docked beside the list on wide screens
// (non-modal), a drawer over it on medium ones and full screen on a phone
// (modal). Back, Escape and its close button close it and return focus to the
// project. Live updates redraw only what changed, in place: the search box,
// open details, scroll positions and the row order you are reading stay put.
import {
  h, clear, button, select, input, changeCell, sparkline, logo, gradeBadge, badgeInfo, verdictChip, bandClass,
  fmtPrice, fmtCompactUsd, fmtDate, fmtDateTime, fmtAgo, fmtAsOf, fmtSignedPct, freshnessText, priceStatus, stateText, toast, announce,
  followedCount, researchState, withheldReason, unscoredList, jobKey, icon, evidenceLevel, evidenceText,
  PROVIDERS, PROVIDER_LABELS, PROVIDER_SHORT,
} from '../ui.js';
import { openAddProjectDialog, openResearchDialog, openSectorDialog, waitingActions } from './dialogs.js';
import { marketStrip, positionFacts, previewTiming, vsBtcFacts } from '../position-ui.js';

// Column catalogue. `hide` names the width below which a column steps aside
// (its value stays in the inspector). "research" is the three model columns.
const COLUMNS = [
  { id: 'rank', label: 'Rank', sub: 'CoinGecko', title: 'Market-cap rank, as reported by CoinGecko', def: true, sort: 'rank', num: true, market: true, hide: 'hide-md' },
  { id: 'price', label: 'Price', sub: 'USD', def: true, sort: 'price', num: true, market: true },
  { id: 'change24h', label: '24H', sub: 'rolling', title: 'Price change over the last 24 hours', sort: 'change24h', num: true, market: true, hide: 'hide-lg' },
  { id: 'change7d', label: '7D', sub: 'rolling', title: 'Price change over the last 7 days (rolling)', def: true, sort: 'change7d', num: true, market: true },
  { id: 'change30d', label: '30D', sub: 'rolling', title: 'Price change over the last 30 days (rolling)', def: true, sort: 'change30d', num: true, market: true, hide: 'hide-sm' },
  { id: 'spark', label: '7D chart', sub: 'price', title: 'Price over the last 7 days (provider series)', market: true, hide: 'hide-lg' },
  { id: 'mcap', label: 'Market cap', sub: 'USD', title: 'Price × circulating supply, as reported by CoinGecko', def: true, sort: 'mcap', num: true, market: true, hide: 'hide-md' },
  { id: 'mcapChange', label: 'Mkt cap 24H', sub: 'change', title: 'Market-cap change over 24 hours, as reported by CoinGecko', sort: 'mcapChange', num: true, market: true, hide: 'hide-lg' },
  { id: 'fdv', label: 'FDV', sub: 'USD', title: 'Fully diluted valuation: price × maximum (or total) supply', sort: 'fdv', num: true, market: true, hide: 'hide-lg' },
  { id: 'volume', label: 'Volume', sub: '24h, USD', title: 'Trading volume over the last 24 hours, in USD', def: true, sort: 'volume', num: true, market: true, hide: 'hide-lg' },
  { id: 'volChange', label: 'Volume change', sub: 'vs ~24h ago', title: 'Measured against our own stored observation from about 24 hours earlier', sort: 'volChange', num: true, market: true, hide: 'hide-lg' },
  { id: 'liquidity', label: 'Liquidity', disabled: 'No liquidity source is configured (CoinGecko /coins/markets does not report liquidity).' },
  { id: 'sector', label: 'Sector', sub: 'your label', def: true, sort: 'sector', hide: 'hide-lg' },
  { id: 'research', label: 'Research', def: true },
  { id: 'lastResearch', label: 'Last research', sub: 'analysis date', sort: 'lastResearch', hide: 'hide-lg' },
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
const PREFS_VERSION = 2;

const view = {
  q: '', order: null, orderKey: '', preview: null, previewFor: null, previewKey: null, showTimer: null, hideTimer: null,
  dismissedKey: null, suppressFocus: false, returnFocus: null, focusProvider: null, focusOnRender: false, bound: false, menus: [],
  mounted: null, strip: null, panelPid: null, recent: null,
};

export function prefs(ctx) {
  const saved = ctx.ui.get('watchlist', {}) || {};
  const cols = Array.isArray(saved.columns) ? saved.columns.filter((c) => COLUMNS.some((x) => x.id === c && !x.disabled)) : COLUMNS.filter((c) => c.def).map((c) => c.id);
  if (!cols.includes('research')) cols.push('research');
  const filters = { ...DEFAULT_FILTERS, ...(saved.filters || {}) };
  // Saved before the list opened on what you follow, "all" was just the old
  // default, not a choice: start from the new one.
  if (saved.v !== PREFS_VERSION && filters.owned === 'all') filters.owned = DEFAULT_FILTERS.owned;
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
    case 'mcap': return m ? m.market_cap_usd ?? null : null;
    case 'mcapChange': return m ? m.market_cap_change_24h_pct ?? null : null;
    case 'fdv': return m ? m.fdv_usd ?? null : null;
    case 'volume': return m ? m.volume_24h_usd ?? null : null;
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
  if (f.owned === 'held' && !p.held) return false;
  if (f.owned === 'watching' && !(p.on_watchlist || p.held)) return false;
  if (f.owned === 'off' && (p.on_watchlist || p.held)) return false;
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
  // Changes since the last review: a small dot on the logo, the count in its label.
  const changed = p.changes && p.changes.item_count > 0 ? `${p.changes.item_count} change${p.changes.item_count === 1 ? '' : 's'} since ${p.changes.cursor_source === 'project created' ? 'the project was added' : 'your last review'}` : null;
  return h('div', { class: 'proj-cell' },
    h('span', { class: 'logo-wrap' }, logo(p, { size: 20 }), changed ? h('span', { class: 'new-dot', role: 'img', 'aria-label': changed, title: changed }) : null),
    h('div', { class: 'names' }, nameBtn,
      p.symbol ? h('span', { class: 'tick' }, p.symbol) : null,
      marks.length ? h('span', { class: 'marks' }, marks) : null));
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
    m.status !== 'fresh' ? h('span', { class: 'price-note' }, f.text) : null);
}

function cellFor(ctx, col, p) {
  const m = mkt(p);
  switch (col) {
    case 'rank': return m && m.market_cap_rank ? h('span', { class: 'num', title: m.rank_source_label || 'CoinGecko market-cap rank' }, `#${m.market_cap_rank}`) : dash('Rank');
    case 'price': return priceCell(p);
    case 'change24h': return m ? changeCell(m.change_24h_pct, { label: 'over 24 hours' }) : dash('24-hour change');
    case 'change7d': return m ? changeCell(m.change_7d_pct, { label: 'over 7 days' }) : dash('7-day change');
    case 'change30d': return m ? changeCell(m.change_30d_pct, { label: 'over 30 days' }) : dash('30-day change');
    case 'spark': return m && m.sparkline_7d ? sparkline(m.sparkline_7d, { width: 80, height: 22, label: `${p.symbol || p.name} 7-day price` }) : dash('7-day chart');
    case 'mcap': return m && typeof m.market_cap_usd === 'number' ? h('span', { class: 'num', title: fmtPrice(m.market_cap_usd) }, fmtCompactUsd(m.market_cap_usd)) : dash('Market cap');
    case 'mcapChange': return m ? changeCell(m.market_cap_change_24h_pct, { label: 'market cap over 24 hours' }) : dash('Market-cap change');
    case 'fdv': return m && typeof m.fdv_usd === 'number' ? h('span', { class: 'num' }, fmtCompactUsd(m.fdv_usd)) : dash('FDV');
    case 'volume': return m && typeof m.volume_24h_usd === 'number' ? h('span', { class: 'num' }, fmtCompactUsd(m.volume_24h_usd)) : dash('Volume');
    case 'volChange': return m && typeof m.volume_change_24h_pct === 'number' ? changeCell(m.volume_change_24h_pct, { label: 'volume' }) : h('span', { class: 'unknown', title: m ? m.volume_change_basis || '' : 'No market data' }, h('span', { 'aria-hidden': 'true' }, '—'), h('span', { class: 'sr-only' }, 'Volume change unknown'));
    case 'sector': return p.sector ? h('button', { type: 'button', class: 'chip', dataset: { key: `sector-${p.project_id}` }, 'aria-label': `Sector: ${p.sector.label}. Change sector`, title: 'Your label; change it here', onclick: (e) => { e.stopPropagation(); openSectorDialog(ctx, p); } }, p.sector.label) : dash('Sector');
    case 'lastResearch': return p.last_report_at ? h('span', { class: 'num', title: 'Latest report analysis date' }, fmtDate(p.last_report_at)) : dash('Last research');
    default: return null;
  }
}

const hostedDesk = (ctx) => Boolean(ctx.state.session && ctx.state.session.hosted);

// One model's state for one project: its grade, or why there is none.
function providerCell(ctx, p, prov) {
  const staleDays = ctx.state.index.settings.freshness.research_stale_days || 90;
  const b = gradeBadge(prov, p.providers && p.providers[prov], p.research && p.research.providers && p.research.providers[prov], { staleDays, hosted: hostedDesk(ctx), button: true, key: `gb-${p.project_id}-${prov}` });
  b.addEventListener('mouseenter', () => schedulePreview(ctx, p.project_id, prov, b));
  b.addEventListener('mouseleave', () => scheduleHide());
  b.addEventListener('focus', () => {
    if (view.suppressFocus) return;
    if (b.matches(':focus-visible')) showPreview(ctx, p.project_id, prov, b);
  });
  b.addEventListener('blur', () => scheduleHide(150));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    hidePreview();
    openPanel(ctx, p.project_id, b, prov);
  });
  return b;
}

function mktSummaryCell(p) {
  const reason = noPriceReason(p);
  const m = mkt(p);
  if (reason || !m) return h('div', { class: 'mkt-summary' }, h('span', { class: 'none' }, reason || 'No price'));
  return h('div', { class: 'mkt-summary' }, h('span', { class: 'price' }, fmtPrice(m.price_usd)), changeCell(m.change_7d_pct, { label: 'over 7 days' }), m.status !== 'fresh' ? h('span', { class: 'price-note' }, freshnessText(m.status, m.age_minutes).text) : null);
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
      f('24H', m ? changeCell(m.change_24h_pct, { label: 'over 24 hours' }) : dash('24-hour change')),
      f('30D', m ? changeCell(m.change_30d_pct, { label: 'over 30 days' }) : dash('30-day change')),
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
const FIT_ORDER = ['lastResearch', 'volChange', 'mcapChange', 'fdv', 'spark', 'change24h', 'volume', 'sector', 'mcap', 'rank', 'change30d', 'change7d', 'price'];

function fitColumns(root) {
  const sc = root && root.querySelector('.table-scroll');
  const table = sc && sc.querySelector('table.wl');
  if (!table || !table.isConnected) return;
  for (const el of table.querySelectorAll('.fit-hidden')) el.classList.remove('fit-hidden');
  if (!table.tHead || getComputedStyle(table.tHead).display === 'none') return; // cards
  for (const id of FIT_ORDER) {
    if (sc.scrollWidth <= sc.clientWidth + 1) break;
    const cells = table.querySelectorAll(`.c-${id}`);
    if (!cells.length || getComputedStyle(cells[0]).display === 'none') continue;
    for (const el of cells) el.classList.add('fit-hidden');
  }
}

const arrow = (dir) => h('span', { class: 'arrow', 'aria-hidden': 'true' }, dir === 'asc' ? '▲' : '▼');

function providerHeaders(ctx, prefsObj, rerender) {
  return PROVIDERS.map((prov) => {
    const key = `grade:${prov}`;
    const on = prefsObj.sort.key === key;
    return h('th', { class: `c-prov c-prov-${prov} c-research`, scope: 'col', 'aria-sort': on ? (prefsObj.sort.dir === 'asc' ? 'ascending' : 'descending') : null },
      h('button', { type: 'button', class: 'sort', dataset: { key: `sort-${key}` }, 'aria-label': `${PROVIDER_LABELS[prov]} grade, 0 to 100. Sort${on ? `ed ${SORT_NAMES[key][prefsObj.sort.dir === 'asc' ? 1 : 2]}` : ''}`, onclick: () => setSort(ctx, prefsObj, key, rerender) },
        h('span', { class: 'lbl' }, PROVIDER_SHORT[prov], on ? arrow(prefsObj.sort.dir) : null)));
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
  const thead = h('thead', null, h('tr', null,
    h('th', { class: 'c-project', scope: 'col', 'aria-sort': nameActive ? (prefsObj.sort.dir === 'asc' ? 'ascending' : 'descending') : null },
      h('button', { type: 'button', class: 'sort', dataset: { key: 'sort-name' }, onclick: () => setSort(ctx, prefsObj, 'name', rerender) },
        h('span', { class: 'lbl' }, 'Project', nameActive ? arrow(prefsObj.sort.dir) : null),
        h('span', { class: 'src' }, 'name · ticker'))),
    cols.map((c) => sortHeader(ctx, prefsObj, c, rerender))));
  const tbody = h('tbody', null, rows.map((p) => {
    const tr = h('tr', { class: rowClass(ctx, p.project_id), dataset: { pid: p.project_id } },
      h('td', { class: 'c-project' }, projectCell(ctx, p)),
      cols.map((c) => {
        if (c === 'research') return PROVIDERS.map((prov) => h('td', { class: `c-prov c-prov-${prov} c-research` }, providerCell(ctx, p, prov)));
        const col = COLUMNS.find((x) => x.id === c);
        return h('td', { class: [col.num ? 'num' : '', col.hide || '', `c-${c}`].join(' ').trim() }, cellFor(ctx, c, p));
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
    h('table', { class: 'wl' }, h('caption', { class: 'sr-only' }, `Watchlist. ${sortDescription(prefsObj.sort)}. Choose a project name for its details; arrow keys move between rows. Grade badges show a scorecard on hover or keyboard focus.`), thead, tbody));
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

// A model's missing setup, in brief (the full list is in its title and in Settings).
export function setupShort(reason) {
  const r = String(reason || '');
  if (/API key/.test(r)) return 'Setup required: no API key';
  const n = r.replace(/^not configured:\s*/, '').split(/,\s*(?![^(]*\))/).filter(Boolean).length;
  return n ? `Setup required: ${n} setting${n === 1 ? '' : 's'} missing` : 'Setup required';
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

// Each model's research route, counted: automatic (an API key and limits are
// set), setup required (its research waits for its assistant or a pasted
// answer) or demo fixtures.
export function readinessSummary(providers) {
  const list = PROVIDERS.map((p) => ({ provider: p, mode: providers && providers[p] ? providers[p].mode : null, reason: providers && providers[p] ? providers[p].reason || null : null }));
  const n = (mode) => list.filter((x) => x.mode === mode).length;
  const parts = [];
  if (n('api')) parts.push(n('api') === PROVIDERS.length ? 'all automatic' : `${n('api')} automatic`);
  if (n('manual')) parts.push(`${n('manual')} need${n('manual') === 1 ? 's' : ''} setup`);
  if (n('mock')) parts.push(n('mock') === PROVIDERS.length ? 'demo adapters' : `${n('mock')} demo`);
  return { list, text: parts.join(' · ') || 'unknown', setup: n('manual') };
}

function stripItem(key, parts, { warn = false, extra = null } = {}) {
  const open = view.strip === key;
  return h('button', { type: 'button', class: `ss-item${warn ? ' warn' : ''}`, 'aria-expanded': String(open), 'aria-controls': 'ss-panel', dataset: { key: `ss-${key}` }, onclick: () => toggleStrip(key) }, parts, extra ? h('span', { class: 'sr-only' }, `. ${extra}`) : null);
}

let toggleStrip = () => {};

// ---- hover / focus scorecard (WCAG 1.4.13: hoverable, dismissible, persistent) --

function previewContent(ctx, p, prov) {
  const rep = p.providers && p.providers[prov];
  const job = p.research && p.research.providers && p.research.providers[prov];
  const staleDays = ctx.state.index.settings.freshness.research_stale_days || 90;
  const hosted = hostedDesk(ctx);
  const info = badgeInfo(prov, rep, job, { staleDays, hosted });
  const riskLabels = Object.fromEntries((ctx.state.index.rubrics.grading.risk_scores || []).map((x) => [x.id, x.label.replace(/ risk$/i, '')]));
  const rows = [];
  const add = (k, v) => { if (v !== null && v !== undefined && v !== '') rows.push(h('dt', null, k), h('dd', null, v)); };
  let gradeEl;
  if (rep) {
    const g = rep.grade || {};
    if (info.kind === 'grade' || info.kind === 'range') gradeEl = h('div', { class: `pv-grade${bandClass(g)}` }, h('span', { class: 'big' }, g.display), g.label ? h('span', { class: 'lab' }, g.label) : null, h('span', { class: 'what' }, info.kind === 'range' ? 'grade range, 0–100' : 'grade, 0–100'));
    else gradeEl = h('div', { class: 'pv-grade' }, h('span', { class: 'state-text' }, info.kind === 'pdf' ? 'PDF: needs a text copy' : 'Grade withheld'), g.coverage_pct !== null && g.coverage_pct !== undefined ? h('span', { class: 'what' }, `${g.coverage_pct}% of the weight scored`) : null);
    if (info.evText) add('Evidence', h('span', { class: 'ev-word' }, `${info.evText.charAt(0).toUpperCase()}${info.evText.slice(1)}`));
    if (g.status === 'withheld' && info.kind !== 'pdf') {
      const why = withheldReason(prov, g, rep.unscored);
      add('Why', h('span', null, `${why.why.charAt(0).toUpperCase()}${why.why.slice(1)}.`, unscoredList(why, { max: 110 })));
    }
    add('Verdict', verdictChip(rep.verdict));
    add('Horizon', rep.horizon || 'not stated');
    add('Timing', previewTiming(rep));
    if (info.kind === 'grade' || info.kind === 'range') add('Coverage', `${g.coverage_pct ?? 100}% of the weight scored`);
    const risks = (rep.top_risks || []).filter((r) => r.status === 'scored' || r.status === 'range');
    if (risks.length) add('Top risks', h('span', null, risks.map((r) => `${riskLabels[r.id] || r.id} ${r.status === 'range' ? `${r.low}–${r.high}` : r.value}`).join(' · '), h('span', { class: 'faint' }, ' (higher is worse)')));
    add('Source', `${rep.model_version || 'model not stated'} · ${rep.provenance && rep.provenance.attested ? 'attested by the API' : 'self-reported'}${rep.provenance && rep.provenance.channel ? ` · via ${rep.provenance.channel}` : ''}`);
    if (rep.model_total && rep.model_total.status === 'mismatch') add('Check', 'The model\'s own total differs from this grade');
    if (info.newerText) add('Newer', info.newerText);
  } else {
    gradeEl = h('div', { class: 'pv-grade' }, h('span', { class: 'state-text' }, info.value === 'None' ? 'No research yet' : researchState(info.kind).short));
    if (info.kind === 'none') add('Next', 'Select the project, then Run research');
    else add('Status', info.text.replace(`${PROVIDER_LABELS[prov]}: `, ''));
  }
  const comp = p.comparison || {};
  if (rep && (comp.flagged || []).length && (comp.comparable_providers || []).includes(prov)) {
    add('Models differ', `${comp.flagged.length} item(s) by ${ctx.state.index.settings.comparison.spread_threshold}+ points, e.g. ${comp.flagged.slice(0, 2).map((f) => f.label).join(', ')}`);
  }
  return h('div', null,
    h('div', { class: 'pv-head' }, h('span', { class: 'who' }, `${PROVIDER_LABELS[prov]} · ${p.name}`), rep ? h('span', { class: 'when' }, `${fmtDate(rep.analysis_at)}${info.age ? ` · ${info.age}` : ''}${info.stale ? ' · stale' : ''}`) : null),
    gradeEl,
    rows.length ? h('dl', { class: 'pv-rows' }, rows) : null,
    h('div', { class: 'pv-foot' }, 'Click or press Enter for details · Esc closes'));
}

function ensurePreview() {
  if (view.preview && view.preview.isConnected) return view.preview;
  view.preview = h('div', { class: 'preview', hidden: true, 'aria-hidden': 'true' });
  view.preview.addEventListener('mouseenter', () => clearTimeout(view.hideTimer));
  view.preview.addEventListener('mouseleave', () => scheduleHide());
  document.body.appendChild(view.preview);
  return view.preview;
}

function previewOpen() {
  return Boolean(view.preview && !view.preview.hidden);
}

function schedulePreview(ctx, pid, prov, anchor) {
  // Matched by key: a live redraw replaces the badge element, not the dismissal.
  if (view.dismissedKey && anchor.dataset.key === view.dismissedKey) return;
  clearTimeout(view.showTimer);
  clearTimeout(view.hideTimer);
  // While a scorecard is open, switching needs a longer pause, so moving
  // diagonally across another badge does not flip it.
  const wait = previewOpen() && view.previewFor !== anchor ? 380 : 220;
  view.pendingFor = anchor;
  view.showTimer = setTimeout(() => showPreview(ctx, pid, prov, anchor), wait);
}

function showPreview(ctx, pid, prov, anchor) {
  clearTimeout(view.showTimer);
  clearTimeout(view.hideTimer);
  view.pendingFor = null;
  if (!anchor.isConnected) return;
  const p = ctx.state.index.projects.find((x) => x.project_id === pid);
  if (!p) return;
  const el = ensurePreview();
  el.replaceChildren(previewContent(ctx, p, prov));
  el.hidden = false;
  view.previewFor = anchor;
  view.previewKey = anchor.dataset.key;
  view.previewArgs = { pid, prov };
  placePreview(anchor);
}

function placePreview(anchor) {
  const el = view.preview;
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  const left = Math.min(window.innerWidth - w - 12, Math.max(12, r.left + r.width / 2 - w / 2));
  let top = r.bottom + 8;
  if (top + hgt > window.innerHeight - 8 && r.top - hgt - 8 > 8) top = r.top - hgt - 8;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(Math.max(8, Math.min(top, window.innerHeight - hgt - 8)))}px`;
}

function scheduleHide(delay = 300) {
  clearTimeout(view.showTimer);
  clearTimeout(view.hideTimer);
  view.pendingFor = null;
  view.hideTimer = setTimeout(() => {
    // Keep it while the pointer is over the scorecard or keyboard focus is on its badge.
    if (view.preview && view.preview.matches(':hover')) return;
    if (view.previewFor && document.activeElement === view.previewFor && view.previewFor.matches(':focus-visible')) return;
    hidePreview();
  }, delay);
}

function hidePreview() {
  clearTimeout(view.showTimer);
  clearTimeout(view.hideTimer);
  view.pendingFor = null;
  if (view.preview) view.preview.hidden = true;
  view.previewFor = null;
  view.previewKey = null;
}

// ---- project inspector ------------------------------------------------------------

const wide = () => window.matchMedia('(min-width: 1280px)').matches;

// Opening adds one history entry (so Back closes it); switching to another
// project while it is open replaces that entry.
function openPanel(ctx, pid, opener, provider = null) {
  view.returnFocus = opener && opener.dataset ? opener.dataset.key || null : null;
  view.focusProvider = provider;
  view.focusOnRender = true;
  hidePreview();
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
  return h('p', { class: `ev-line ${level}` }, icon(level === 'serious' ? 'warn-fill' : 'warn-line'),
    h('span', null, h('strong', null, level === 'serious' ? 'Serious evidence flag. ' : 'Evidence flag. '),
      `${text.charAt(0).toUpperCase()}${text.slice(1)}. The grade stands as calculated; read the flags before relying on it. `,
      h('button', { type: 'button', class: 'link', dataset: { key: `ev-jump-${prov}` }, onclick: () => { const t = document.getElementById(`insp-ev-${prov}`); if (t) t.scrollIntoView({ block: 'start' }); } }, 'See the flags')));
}

function providerSection(ctx, p, prov) {
  const rep = p.providers && p.providers[prov];
  const job = p.research && p.research.providers && p.research.providers[prov];
  const staleDays = ctx.state.index.settings.freshness.research_stale_days || 90;
  const hosted = hostedDesk(ctx);
  const info = badgeInfo(prov, rep, job, { staleDays, hosted });
  const pid = p.project_id;
  const riskLabels = Object.fromEntries((ctx.state.index.rubrics.grading.risk_scores || []).map((x) => [x.id, x.label]));
  const links = [];
  const actions = [];
  if (rep) {
    links.push(h('a', { href: `#/project/${encodeURIComponent(pid)}/reports?report=${encodeURIComponent(rep.report_id)}`, dataset: { key: `report-${pid}-${prov}` } }, 'Original report'));
    links.push(h('a', { href: `#/project/${encodeURIComponent(pid)}/scorecards?provider=${prov}`, dataset: { key: `scorecard-${pid}-${prov}` } }, 'Scorecard'));
  }
  if (job && ['interrupted', 'uncertain'].includes(info.job || info.kind)) {
    links.push(h('a', { href: `#/project/${encodeURIComponent(pid)}/research`, dataset: { key: `runs-${pid}-${prov}` } }, 'Research runs'));
  }
  if (job && job.state === 'failed') {
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
  // assistant first; pasting by hand stays available.
  if (job && job.state === 'unconfigured') actions.push(...waitingActions(ctx, { pid, runId: job.run_id, provider: prov, key: `${pid}-${prov}` }));
  if (!rep && !job) {
    const run = button('Run research', () => openResearchDialog(ctx, p, { providers: [prov] }), { kind: 'small', key: `run-${pid}-${prov}` });
    actions.push(run);
  }
  let gradeLine;
  if (rep && (info.kind === 'grade' || info.kind === 'range')) {
    gradeLine = h('div', { class: `provider-grade${bandClass(rep.grade)}${info.ev === 'serious' ? ' ev-serious' : ''}` }, h('span', { class: 'big' }, rep.grade.display), rep.grade.label ? h('span', { class: 'lab', 'aria-label': `letter ${rep.grade.label}` }, rep.grade.label) : null, h('span', { class: 'small muted' }, info.kind === 'range' ? 'grade range, 0–100' : 'grade, 0–100'));
  } else if (rep) {
    gradeLine = h('div', { class: 'provider-grade' }, h('span', { class: 'state-text' }, info.kind === 'pdf' ? 'PDF saved: needs a text copy' : 'Grade withheld'), rep.grade && rep.grade.coverage_pct !== null && rep.grade.coverage_pct !== undefined ? h('span', { class: 'small muted' }, `${rep.grade.coverage_pct}% of the weight scored`) : null);
  } else {
    const st = researchState(info.kind, { provider: prov, hosted });
    // On the online desk the sentence for the assistant follows below.
    gradeLine = h('div', { class: 'provider-grade' }, stateText(info.kind === 'waiting' && hosted ? 'Waiting for you' : st.long, st.tone));
  }
  const facts = [];
  if (rep) {
    if (rep.grade && rep.grade.status === 'withheld' && info.kind !== 'pdf') {
      const why = withheldReason(prov, rep.grade, rep.unscored);
      facts.push(['Why withheld', h('span', null, `${why.why.charAt(0).toUpperCase()}${why.why.slice(1)}. No grade is calculated from part of the weight.`, unscoredList(why))]);
    }
    facts.push(['Verdict', verdictChip(rep.verdict)]);
    facts.push(['Analysis date', h('span', null, fmtDate(rep.analysis_at), info.age ? h('span', { class: 'faint' }, ` · ${info.age} ago`.replace('today ago', 'today')) : null, info.stale ? h('span', { class: 'freshness stale' }, ' · stale') : null)]);
    facts.push(['Horizon', rep.horizon || 'not stated']);
    facts.push(...positionFacts(ctx, p, prov, rep));
    const risks = (rep.top_risks || []).filter((r) => r.status === 'scored' || r.status === 'range');
    if (risks.length) facts.push(['Top risks (higher is worse)', risks.map((r) => `${riskLabels[r.id] || r.id}: ${r.status === 'range' ? `${r.low}–${r.high}` : r.value}`).join(' · ')]);
    if (rep.model_total && rep.model_total.status === 'mismatch') facts.push(['Check', rep.model_total.message]);
  } else if (job && job.error) {
    facts.push(['Last error', job.error]);
  }
  // Where the report came from, briefly (the full provenance is on the report).
  const channel = rep && rep.provenance && rep.provenance.channel ? rep.provenance.channel : null;
  const route = rep
    ? [rep.model_version || null, rep.provenance && rep.provenance.attested ? 'attested by the API' : /desk connector/i.test(channel || '') ? 'saved through its connection' : 'imported'].filter(Boolean).join(' · ')
    : job ? (job.mode === 'manual' ? (hosted ? 'Waits for its assistant (no API key)' : 'By hand (no API set up)') : job.mode === 'cowork' ? 'Claude in Cowork' : job.mode === 'connector' ? `${PROVIDER_LABELS[prov]} through its desk connection` : job.mode === 'mock' ? 'Fictional demo adapter' : 'API, in the background') : 'Not requested';
  return h('div', { class: 'provider', id: `panel-prov-${prov}`, tabindex: '-1', 'aria-label': `${PROVIDER_LABELS[prov]} scorecard` },
    h('div', { class: 'provider-top' }, h('span', { class: 'name' }, PROVIDER_LABELS[prov]), h('span', { class: 'route' }, route)),
    gradeLine,
    rep ? evidenceLine(rep, prov) : null,
    facts.length ? h('dl', { class: 'facts' }, facts.map(([k, v]) => h('div', { class: 'wide' }, h('dt', null, k), h('dd', null, v)))) : null,
    // A newer run on a saved grade: in progress, waiting, failed, needs a check or paused.
    rep && info.newerText ? h('p', { class: `newer-line${info.problem ? ' problem' : ''}` }, info.newerText) : null,
    links.length || actions.length ? h('div', { class: 'links' }, links, actions) : null);
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
      ? h('p', { style: { margin: '6px 0 0' } }, h('strong', null, `They differ by ${ctx.state.index.settings.comparison.spread_threshold}+ points on ${flagged.length} item(s): `), flagged.slice(0, 4).map((f) => `${f.label} (${f.spread})`).join(', '), flagged.length > 4 ? ', …' : '', '.')
      : h('p', { style: { margin: '6px 0 0' } }, 'No item differs by the highlight threshold or more.'),
    h('p', { class: 'muted', style: { margin: '6px 0 0' } }, 'Agreement between models is not independent confirmation: they often read the same sources.'),
    h('a', { href: `#/project/${encodeURIComponent(p.project_id)}/comparison`, dataset: { key: `compare-${p.project_id}` } }, 'Compare in detail'));
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
    const key = jobKey(job);
    const st = key ? researchState(key, { provider: prov, hosted }) : null;
    const r = ready[prov];
    const rep = p.providers && p.providers[prov];
    // What is missing matters only where research waits for it.
    const how = r && r.mode === 'manual' && (key === 'waiting' || (!key && !rep)) ? h('span', { class: 'how', title: r.reason || null }, setupShort(r.reason), ' · ', h('a', { href: '#/settings?tab=research', dataset: { key: `setup-${prov}` } }, 'Settings'))
      : r && r.mode === 'mock' && !key ? h('span', { class: 'how' }, 'Fictional demo adapter') : null;
    // A report saved outside a run (imported or pasted) still counts.
    const idle = rep ? stateText(`Report saved${rep.analysis_at ? ` (analysis ${fmtDate(rep.analysis_at)})` : ''}`, 'ok') : h('span', { class: 'faint' }, 'Not requested');
    return h('li', null, h('span', { class: 'who' }, PROVIDER_LABELS[prov]),
      h('span', null, st ? stateText(st.short === 'Saved' ? 'Saved as a report' : st.long, st.tone) : idle,
        job && job.error && key !== 'completed' ? h('span', { class: 'how' }, job.error) : null,
        how));
  });
  return h('div', null,
    run ? h('p', { class: 'run-line' }, h('span', null, `Run of ${fmtDateTime(run.created_at)}`), h('span', null, String(run.status || '').replace(/_/g, ' ')), run.horizon && run.horizon.text ? h('span', null, `Horizon ${run.horizon.text}`) : null)
      : h('p', { class: 'run-line' }, 'No research run yet.'),
    h('ul', { class: 'job-list' }, items),
    h('div', { dataset: { slot: 'run' } }, h('p', { class: 'insp-loading' }, 'Loading the saved prompt…')));
}

function projectAlerts(ctx, p) {
  const items = (ctx.state.index.attention || []).filter((a) => a.project_id === p.project_id && a.kind !== 'identity');
  const list = alertList(items, `palert-${p.project_id}`);
  const idNote = p.identity_status !== 'verified'
    ? h('p', { class: 'small', style: { margin: items.length ? '8px 0 0' : 0 } }, h('span', { class: 'idn pending' }, 'Identity pending'), ' ', (p.identity_unknowns || []).join(' ') || 'The token is not confirmed, so no prices or holdings use it.', ' ', h('a', { href: `#/project/${encodeURIComponent(p.project_id)}/research`, dataset: { key: `fix-identity-${p.project_id}` } }, 'Complete the identity'))
    : null;
  if (!list && !idNote) return null;
  return h('section', { 'aria-labelledby': 'panel-attn' }, h('h3', { id: 'panel-attn' }, 'Needs your attention'), list, idNote);
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

// The parts that need the full project record, filled in when it arrives
// (from the cache on a redraw, so nothing flickers).
async function fillDetail(ctx, pid, panel, saved) {
  let d;
  let mod;
  try {
    [d, mod] = await Promise.all([ctx.projectDetail(pid), import('./inspector.js')]);
  } catch (err) {
    for (const slot of panel.querySelectorAll('[data-slot]')) slot.replaceChildren(h('p', { class: 'small muted' }, `Could not load the full record: ${err.message}. The summary above is current.`));
    return;
  }
  if (!panel.isConnected || ctx.state.route.query.get('p') !== pid) return;
  const row = ctx.state.index.projects.find((x) => x.project_id === pid) || {};
  const parts = mod.inspectorParts(ctx, d, row);
  for (const slot of panel.querySelectorAll('[data-slot]')) {
    const part = parts[slot.dataset.slot];
    slot.replaceChildren(...(part ? [part] : []));
  }
  restorePanel(panel, saved, { focus: true });
}

function renderPanel(ctx, pid) {
  const root = document.getElementById('panel-root');
  const p = ctx.state.index.projects.find((x) => x.project_id === pid);
  const saved = capturePanel(root);
  const reopened = view.panelPid !== pid;
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
  const split = wide();
  const m = mkt(p);
  const closeBtn = h('button', { type: 'button', class: 'close quiet', 'aria-label': `Close ${p.name} details`, title: 'Close (Esc)', dataset: { key: 'panel-close' } }, '×');
  closeBtn.onclick = () => closePanel(ctx);
  const watchBtn = button(p.on_watchlist ? 'Watching' : 'Watch', null, { kind: 'small', key: 'panel-watch' });
  watchBtn.setAttribute('aria-pressed', String(Boolean(p.on_watchlist)));
  watchBtn.title = p.on_watchlist ? 'On your watchlist. Click to stop watching.' : 'Add to your watchlist';
  watchBtn.onclick = async () => {
    watchBtn.disabled = true;
    try {
      await ctx.api.post(`/api/projects/${encodeURIComponent(pid)}/watchlist`, { on: !p.on_watchlist });
      await ctx.refresh();
    } catch (err) {
      toast(err.message, 'bad');
      watchBtn.disabled = false;
    }
  };
  const researchBtn = button('Run research', () => openResearchDialog(ctx, p), { kind: 'small', key: 'panel-research' });
  const reviewedBtn = button('Mark reviewed', null, { kind: 'small', key: 'panel-reviewed' });
  reviewedBtn.onclick = async () => {
    reviewedBtn.disabled = true;
    try {
      await ctx.api.post(`/api/projects/${encodeURIComponent(pid)}/reviewed`, {});
      toast('Marked reviewed. New changes are counted from now.');
      await ctx.refresh();
    } catch (err) {
      toast(err.message, 'bad');
      reviewedBtn.disabled = false;
    }
  };
  const ch = p.changes || {};
  const heading = h('h2', { id: 'panel-title', tabindex: '-1' }, p.name, p.symbol ? h('span', { class: 'tick' }, p.symbol) : null);
  const f = m ? freshnessText(m.status, m.age_minutes) : null;
  const panel = h('aside', split
    ? { class: `panel${reopened ? ' entering' : ''}`, role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'panel-title' }
    : { class: `panel${reopened ? ' entering' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'panel-title' },
    h('div', { class: 'panel-head' }, logo(p, { size: 28 }),
      h('div', { class: 'names' }, heading,
        h('div', { class: 'meta-chips' },
          h('span', { class: `idn ${p.identity_status === 'verified' ? 'ok' : 'pending'}`, title: (p.identity_unknowns || []).join(' ') || null }, p.identity_status === 'verified' ? 'Identity verified' : 'Identity pending'),
          p.sector ? h('button', { type: 'button', class: 'link', dataset: { key: 'panel-sector' }, 'aria-label': `Sector: ${p.sector.label}. Change sector`, onclick: () => openSectorDialog(ctx, p) }, p.sector.label) : null,
          h('span', { class: 'faint' }, p.on_watchlist || p.held ? 'Watching' : 'Not watching'),
          p.held ? h('a', { href: '#/portfolio', class: 'small', dataset: { key: 'panel-held' } }, 'Held: see Portfolio') : null)),
      closeBtn),
    h('div', { class: 'panel-body', 'data-keep-scroll': 'panel' },
      h('section', null,
        h('div', { class: 'btn-row' }, h('a', { class: 'btn primary small', href: `#/project/${encodeURIComponent(pid)}/overview`, dataset: { key: `open-research-${pid}` } }, 'Open full research'), researchBtn, watchBtn)),
      projectAlerts(ctx, p),
      h('section', { 'aria-labelledby': 'panel-progress' }, h('h3', { id: 'panel-progress' }, 'Research'), researchProgress(ctx, p)),
      h('section', { 'aria-labelledby': 'panel-models' }, h('h3', { id: 'panel-models' }, 'Model grades'),
        PROVIDERS.map((prov) => providerSection(ctx, p, prov)),
        h('details', { class: 'explain', dataset: { key: 'panel-explain' } }, h('summary', null, 'How to read these grades'),
          h('p', { style: { marginTop: '6px' } }, 'Each model writes its own report. This app calculates a 0–100 grade from that report\'s six weighted component scores (20/25/20/15/10/10) under the rubric the report declares. Letters: A 90+, B 80+, C 70+, D 60+, F below 60.'),
          h('p', null, 'A range means the model gave score ranges. "Withheld" means a component was missing; the share of the weight that was scored is shown instead of a guess. Downside-risk scores are separate: higher means more risk. A warning sign beside a grade means the desk\'s evidence checks flagged claims in that report: filled for a serious flag, outlined for a material one. Flags never change a score.'))),
      h('section', { 'aria-labelledby': 'panel-breakdown' }, h('h3', { id: 'panel-breakdown' }, 'Category breakdown'), h('div', { dataset: { slot: 'breakdown' } }, h('p', { class: 'insp-loading' }, 'Loading each model\'s scores…'))),
      h('section', { 'aria-labelledby': 'panel-evidence' }, h('h3', { id: 'panel-evidence' }, 'Evidence and sources'), h('div', { dataset: { slot: 'evidence' } }, h('p', { class: 'insp-loading' }, 'Loading the evidence checks…'))),
      h('section', { 'aria-labelledby': 'panel-compare' }, h('h3', { id: 'panel-compare' }, 'How the models compare'), comparisonNote(ctx, p)),
      h('section', { 'aria-labelledby': 'panel-market' }, h('h3', { id: 'panel-market' }, 'Market'),
        m ? h('div', null,
          h('div', { class: 'pill-row' }, h('span', { class: 'price-big' }, fmtPrice(m.price_usd)), stateText(m.status === 'fresh' ? `Updated ${fmtAgo(m.fetched_at || m.as_of)}` : f.text, f.tone)),
          m.sparkline_7d ? h('div', { style: { margin: '10px 0 4px' } }, sparkline(m.sparkline_7d, { width: 300, height: 52, label: `${p.symbol || p.name} 7-day price` })) : null,
          h('dl', { class: 'facts' },
            h('div', null, h('dt', null, '7D, rolling'), h('dd', null, changeCell(m.change_7d_pct, { label: 'over 7 days' }))),
            h('div', null, h('dt', null, '30D, rolling'), h('dd', null, changeCell(m.change_30d_pct, { label: 'over 30 days' }))),
            h('div', null, h('dt', null, m.rank_source_label && /fictional/i.test(m.rank_source_label) ? 'Rank (demo data)' : 'Rank (CoinGecko)'), h('dd', null, m.market_cap_rank ? `#${m.market_cap_rank}` : 'Unranked')),
            h('div', null, h('dt', null, 'Market cap'), h('dd', null, fmtCompactUsd(m.market_cap_usd))),
            h('div', null, h('dt', null, 'Volume, 24h'), h('dd', null, fmtCompactUsd(m.volume_24h_usd))),
            h('div', null, h('dt', null, 'FDV'), h('dd', null, fmtCompactUsd(m.fdv_usd))),
            ...vsBtcFacts(m),
            h('div', { class: 'wide' }, h('dt', null, 'Source'), h('dd', { class: 'small' }, `${m.rank_source_label && /fictional/i.test(m.rank_source_label) ? 'Fictional demo data' : 'CoinGecko'} · as of ${fmtDateTime(m.as_of)}`))))
          : h('p', { class: 'small muted' }, `No market data: ${(noPriceReason(p) || 'unknown').toLowerCase()}.`, p.identity_status !== 'verified' ? ' Prices appear once the token\'s identity is confirmed.' : '')),
      h('section', { 'aria-labelledby': 'panel-review' }, h('h3', { id: 'panel-review' }, 'Since your last review'),
        ch.item_count ? h('p', { class: 'small' }, `${ch.item_count} change(s) since ${ch.cursor_source === 'project created' ? 'the project was added' : fmtDateTime(ch.since)}`, ch.new_reports ? `: ${ch.new_reports} new report(s)` : '', typeof ch.price_change_pct === 'number' ? `, price ${fmtSignedPct(ch.price_change_pct)}` : '', '.') : h('p', { class: 'small muted' }, 'Nothing new since your last review.'),
        h('div', { class: 'btn-row' }, reviewedBtn, h('a', { class: 'small', href: `#/project/${encodeURIComponent(pid)}/history`, dataset: { key: `history-${pid}` } }, 'What changed')),
        p.next_review ? h('p', { class: 'small', style: { marginTop: '8px' } }, `Next review: ${fmtDate(p.next_review.date)}${p.next_review.overdue ? ' (overdue)' : ''}`) : null)));
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.querySelector('dialog[open]')) {
      e.stopPropagation();
      closePanel(ctx);
    }
  });
  for (const slot of panel.querySelectorAll('[data-slot]')) if (oldSlots[slot.dataset.slot] && oldSlots[slot.dataset.slot].length) slot.replaceChildren(...oldSlots[slot.dataset.slot]);
  clear(root).appendChild(panel);
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
  if (!opening) restorePanel(panel, saved, { focus: true });
  // Focus moves into the inspector only when you open it, never on a live refresh.
  if (opening) {
    const target = view.focusProvider ? panel.querySelector(`#panel-prov-${view.focusProvider}`) : heading;
    if (target) {
      target.focus({ preventScroll: false });
      ctx.claimFocus();
    }
    const row = document.querySelector(`tr[data-pid="${CSS.escape(pid)}"]`);
    if (row && split) row.scrollIntoView({ block: 'nearest' });
  } else if (!split && !panel.contains(document.activeElement)) {
    heading.focus({ preventScroll: true });
    ctx.claimFocus();
  } else if (panel.contains(document.activeElement)) ctx.claimFocus();
  view.focusOnRender = false;
  view.focusProvider = null;
  fillDetail(ctx, pid, panel, opening ? { scroll: {}, open: {}, focus: null } : saved);
}

// After the inspector closes (its button, Escape, Back): focus returns to the
// project it was opened from, and the list stays where it was.
function afterPanelClosed(ctx) {
  const pid = view.panelPid;
  view.panelPid = null;
  clear(document.getElementById('panel-root'));
  document.body.classList.remove('split');
  setSheetMode(false);
  const bd = document.querySelector('.sheet-backdrop');
  if (bd) bd.remove();
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
  const alerts = h('div');
  const holder = h('div');
  const resultsLine = h('div', { class: 'results-line', role: 'status' });
  const tokens = h('div', { class: 'active-filters' });
  const toolbar = h('div', { class: 'toolbar', role: 'search', 'aria-label': 'Find and filter projects', dataset: { nodirty: '1' } });
  const legend = h('p', { class: 'legend-line' });
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
      filtered ? h('span', null, `${rows.length} of ${total} ${f.archived ? 'archived ' : ''}projects`) : null,
      reordered ? h('span', { class: 'reorder' }, h('span', null, 'Values updated; order kept while you read.'), button('Re-sort', () => { view.order = null; rerender(); announce('Re-sorted.'); }, { kind: 'small', key: 'resort' })) : null,
    ].filter(Boolean));
    resultsLine.classList.toggle('hidden', !filtered && !reordered);
    drawTokens();
    if (rows.length) {
      holder.replaceChildren(buildTable(ctx, prefsObj, rows, () => rerender()));
      if (holder.isConnected) fitColumns(holder);
    } else if (!list.filter((p) => p.status !== 'archived').length && !f.archived) {
      holder.replaceChildren(h('div', { class: 'empty' }, h('h2', null, 'Your watchlist is empty'),
        h('p', null, 'Add a project by name or official website. Research and prices follow from there.'),
        h('div', { class: 'btn-row' }, button('Add project', () => openAddProjectDialog(ctx), { kind: 'primary', key: 'empty-add' })),
        h('p', { class: 'small muted', style: { marginTop: '12px' } }, 'Or ask Cowork: "Add [project name and official URL] to my crypto watchlist and research it with Claude, ChatGPT, and Gemini."')));
    } else if (f.owned === 'watching' && !view.q && !filterCount()) {
      // Projects exist, but none is watched or held.
      holder.replaceChildren(h('div', { class: 'empty' }, h('h2', null, 'Nothing on your watchlist'),
        h('p', null, `${total} project${total === 1 ? ' is' : 's are'} saved but not watched. Watching a project never records a holding.`),
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

  const search = input({ type: 'search', placeholder: 'Search name, ticker or sector', 'aria-label': 'Search projects', 'aria-keyshortcuts': 'Control+K Meta+K', value: view.q, dataset: { key: 'wl-search' } });
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
  const searchWrap = h('div', { class: 'search' }, search, h('kbd', { 'aria-hidden': 'true' }, /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘K' : 'Ctrl K'));

  function drawTokens() {
    const f = prefsObj.filters;
    const list = [];
    const tok = (label, onRemove, key) => h('span', { class: 'token' }, label, h('button', { type: 'button', 'aria-label': `Remove filter: ${label}`, dataset: { key }, onclick: onRemove }, '×'));
    if (view.q) list.push(tok(`Search: “${view.q}”`, () => { view.q = ''; search.value = ''; view.order = null; rerender(); search.focus(); }, 'tok-q'));
    if (f.owned !== DEFAULT_FILTERS.owned) list.push(tok(f.owned === 'all' ? 'All projects, watched or not' : OWNED.find(([v]) => v === f.owned)[1], () => setFilter('owned', DEFAULT_FILTERS.owned), 'tok-owned'));
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

  const refreshBtn = button('Refresh', null, { kind: 'ss-icon', key: 'refresh-prices' });
  refreshBtn.setAttribute('aria-label', 'Refresh prices now');
  refreshBtn.onclick = async () => {
    const m = ctx.state.index.freshness.market;
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Refreshing…';
    try {
      const out = await ctx.api.post('/api/market/refresh', {});
      toast(...refreshToast(out));
      await ctx.refresh();
    } catch (err) {
      toast(...refreshToast({ result: { status: 'failed', message: err.message }, status: m }));
    } finally {
      if (refreshBtn.isConnected) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'Refresh';
      }
    }
  };
  const addBtn = button('Add project', () => openAddProjectDialog(ctx), { kind: 'primary', key: 'add-project' });
  addBtn.id = 'add-project-btn';

  function drawHead() {
    const followed = followedCount(all());
    head.replaceChildren(
      h('div', { class: 'title' }, h('h1', null, 'Watchlist'), h('span', { class: 'count' }, `${followed} watching`)),
      h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#/new', dataset: { key: 'new-research' } }, 'New research'), addBtn));
  }

  // The status strip: prices, Bitcoin context (only with a captured
  // snapshot), each model's route, and the review queue; each opens its
  // details below. Problems that need action are listed under it, always.
  function drawStatus() {
    const idx = ctx.state.index;
    const { critical, rest } = splitAttention(idx.attention || []);
    const high = rest.filter((a) => a.severity === 'high').length;
    // The review queue stays a count in the strip (urgent ones named in
    // words) and opens when you ask; it remembers that you left it open.
    // What needs action now is listed below the strip, never folded away.
    if (!view.stripReady && ctx.ui.get('reviewOpen', false)) view.strip = view.strip || 'review';
    view.stripReady = true;
    if (view.strip === 'review' && !rest.length) view.strip = null;
    const m = idx.freshness.market;
    const ps = priceStatus(m);
    const items = [];
    const priceWord = ps.problem ? h('span', { class: 'warn-word' }, m.rate_limited ? 'Rate limited' : ps.text) : null;
    items.push(h('span', { class: 'ss-group' },
      stripItem('prices', [h('span', { class: 'k' }, view.priceSource === 'CoinGecko' ? 'Prices' : 'Prices (demo)'), h('span', { class: 'v' }, m.last_success_at ? fmtAgo(m.last_success_at) : 'not fetched'), priceWord], { warn: ps.problem, extra: m.last_success_at ? ps.asOf : null }),
      refreshBtn));
    const mc = idx.market_context;
    const snap = mc && mc.snapshot;
    if (snap && snap.bitcoin && typeof snap.bitcoin.price_usd === 'number') {
      const demo = snap.provider === 'fictional-demo';
      items.push(stripItem('market', [h('span', { class: 'k' }, demo ? 'BTC (demo)' : 'BTC'), h('span', { class: 'v' }, `$${Math.round(snap.bitcoin.price_usd).toLocaleString('en-US')}`), changeCell(snap.bitcoin.change_7d_pct, { label: 'Bitcoin over 7 days' }), h('span', { class: 'k' }, '7D'), mc.status === 'stale' ? h('span', { class: 'warn-word' }, 'stale') : null], { warn: mc.status === 'stale' }));
    }
    if (idx.research && idx.research.providers) {
      const rs = readinessSummary(idx.research.providers);
      items.push(stripItem('models', [h('span', { class: 'k' }, 'Models'), h('span', { class: 'v' }, rs.text)], {}));
    }
    if (rest.length) {
      items.push(stripItem('review', [h('span', { class: 'v' }, `${rest.length} to review`), high ? h('span', { class: 'bad-word' }, `${high} urgent`) : null], { warn: high > 0 }));
    }
    strip.replaceChildren(...items);
    drawStripPanel(rest, ps, m);
    alerts.replaceChildren(...[alertList(critical, 'alert')].filter(Boolean));
  }

  function drawStripPanel(rest, ps, m) {
    const idx = ctx.state.index;
    let body = null;
    if (view.strip === 'prices') {
      body = [h('h2', null, 'Prices'),
        h('p', null, `${m.last_success_at ? ps.asOf : 'No prices fetched yet'} · source: ${view.priceSource}.`),
        ps.note ? h('p', null, h('span', { class: ps.problem ? 'warn-word' : null }, ps.problem ? 'Note: ' : ''), ps.note) : null,
        ps.retryAt ? h('p', null, `The next automatic try is after ${fmtAsOf(ps.retryAt)}.`) : null,
        h('p', { class: 'faint' }, 'Missing prices stay marked unavailable; a stale price shows its age. Prices never change stored grades.')];
    } else if (view.strip === 'market') {
      body = [marketStrip(idx)];
    } else if (view.strip === 'models') {
      const rs = readinessSummary(idx.research && idx.research.providers);
      const hosted = hostedDesk(ctx);
      body = [h('h2', null, 'Research models'),
        h('ul', { class: 'ready-list' }, rs.list.map((x) => h('li', null, h('span', { class: 'who' }, PROVIDER_LABELS[x.provider]),
          h('span', null, x.mode === 'api' ? stateText('Automatic: runs on its API in the background, within your limits', 'ok')
            : x.mode === 'mock' ? stateText('Fictional demo adapter')
              : h('span', { title: x.reason || null }, stateText(`${setupShort(x.reason)}. Its research ${hosted ? 'waits for its assistant or a pasted answer' : 'waits for a pasted answer'}`, 'warn')))))),
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

  function drawLegend() {
    legend.replaceChildren(
      h('span', { class: 'bands', 'aria-hidden': 'true' }, ['a', 'b', 'c', 'd', 'f'].map((b) => h('span', { class: `band-key band-${b}` }, b.toUpperCase()))),
      h('span', null, `Grades 0–100, calculated by this app from each model's own report. Withheld means a weighted part was not scored. A month count (4mo) means older than ${ctx.state.index.settings.freshness.research_stale_days || 90} days.`),
      h('span', { class: 'ev' }, h('span', { class: 'ev-ico' }, icon('warn-fill')), 'serious evidence flag'),
      h('span', { class: 'ev' }, h('span', { class: 'ev-ico' }, icon('warn-line')), 'material evidence flag'));
  }

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
    fitColumns(page);
    if (!view.resizeObserver || view.resizeFor !== page) {
      if (view.resizeObserver) view.resizeObserver.disconnect();
      view.resizeObserver = new ResizeObserver(() => requestAnimationFrame(() => fitColumns(page)));
      view.resizeObserver.observe(page);
      view.resizeFor = page;
    }
    const pid = ctx.state.route.query.get('p');
    if (pid) renderPanel(ctx, pid);
    else if (view.panelPid) afterPanelClosed(ctx);
    else {
      clear(document.getElementById('panel-root'));
      document.body.classList.remove('split');
      setSheetMode(false);
      const bd = document.querySelector('.sheet-backdrop');
      if (bd) bd.remove();
    }
    if (ctx.state.focusSearch) {
      ctx.state.focusSearch = false;
      search.focus();
      search.select();
      ctx.claimFocus();
    }
    // Keep an open scorecard attached to its redrawn badge.
    if (previewOpen() && view.previewKey) {
      const again = document.querySelector(`[data-key="${CSS.escape(view.previewKey)}"]`);
      if (again && view.previewArgs) {
        view.previewFor = again;
        view.preview.replaceChildren(previewContent(ctx, ctx.state.index.projects.find((x) => x.project_id === view.previewArgs.pid) || {}, view.previewArgs.prov));
        placePreview(again);
      } else hidePreview();
    }
  };

  if (!view.bound) {
    view.bound = true;
    document.addEventListener('keydown', (e) => {
      const r = ctx.state.route;
      const onList = r && r.name === 'watchlist';
      // Up and Down move between projects in the same column (name or a
      // model's grade); Tab still walks every control.
      if (onList && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !typing(e.target) && moveRow(e)) {
        e.preventDefault();
        return;
      }
      if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
      if (document.querySelector('.menu:not(.hidden)')) {
        closeMenus();
        return;
      }
      if (previewOpen() || view.pendingFor) {
        // Dismiss without moving the pointer or focus (WCAG 1.4.13).
        const target = view.previewFor || view.pendingFor;
        view.dismissedKey = target && target.dataset ? target.dataset.key || null : null;
        hidePreview();
        e.preventDefault();
        return;
      }
      if (onList && r.query.get('p') && !typing(e.target)) closePanel(ctx);
    });
    document.addEventListener('pointermove', (e) => {
      if (view.dismissedKey) {
        const el = document.querySelector(`[data-key="${CSS.escape(view.dismissedKey)}"]`);
        if (!el || !el.matches(':hover')) view.dismissedKey = null;
      }
      if (!previewOpen()) return;
      const inside = (el) => {
        if (!el || !el.isConnected) return false;
        const rc = el.getBoundingClientRect();
        return e.clientX >= rc.left - 4 && e.clientX <= rc.right + 4 && e.clientY >= rc.top - 4 && e.clientY <= rc.bottom + 4;
      };
      if (e.target && e.target.closest && e.target.closest('button.gb')) return;
      if (!inside(view.preview) && !inside(view.previewFor) && !(view.previewFor && document.activeElement === view.previewFor)) scheduleHide();
    }, { passive: true });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.menu-wrap')) closeMenus();
    });
    window.addEventListener('scroll', () => { if (previewOpen() && document.activeElement !== view.previewFor) hidePreview(); else if (previewOpen()) placePreview(view.previewFor); }, { passive: true });
    window.matchMedia('(min-width: 1280px)').addEventListener('change', () => {
      const r = ctx.state.route;
      if (r && r.name === 'watchlist' && r.query.get('p')) renderPanel(ctx, r.query.get('p'));
    });
  }

  setSources();
  drawHead();
  drawStatus();
  drawControls();
  drawLegend();
  // Only a fresh visit re-sorts; live updates, Back and opening the inspector keep the order you saw.
  rerender(['live', 'same', 'refresh', 'pop'].includes(ctx.state.renderReason) ? 'live' : 'user');

  const page = h('div', { class: 'wl-wrap' }, head, strip, stripPanel, alerts, toolbar, tokens, resultsLine, holder, legend);
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
    drawLegend();
    rerender('live');
  };
  view.mounted = { page, update };
  return page;
}
