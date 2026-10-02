// Watchlist: the projects you follow, what moved, what each model thinks.
//   Hover or keyboard-focus a grade badge  -> compact scorecard (hoverable, Esc dismisses)
//   Select a project (click, tap, Enter)   -> persistent summary panel (?p=<id>)
//   Select a provider badge                -> the same panel, focused on that provider
//   Open full research                     -> #/project/<id>/<tab>
// Wide screens show the panel as a side column (non-modal); narrower screens
// show it as a modal sheet (focus stays inside until it is closed).
import {
  h, clear, button, select, input, callout, changeCell, sparkline, logo, gradeBadge, badgeInfo, gradeView, verdictChip,
  fmtPrice, fmtCompactUsd, fmtDate, fmtDateTime, fmtAgo, fmtSignedPct, freshnessText, stateText, toast, announce, copyText,
  PROVIDERS, PROVIDER_LABELS, PROVIDER_SHORT, RESEARCH_STATE,
} from '../ui.js';
import { openAddProjectDialog, openResearchDialog, openSectorDialog } from './dialogs.js';

// Column catalogue. `hide` names the width below which a column steps aside
// (its value stays in the summary panel).
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

const DEFAULT_FILTERS = { sector: '', owned: 'all', coverage: 'any', ret30: 'any', archived: false };
const DEFAULT_SORT = { key: 'rank', dir: 'asc' };
const COVERAGE = [['any', 'Any coverage'], ['all3', 'Graded by all three models'], ['missing', 'Missing a model grade'], ['none', 'No research yet'], ['attention', 'Failed or withheld']];
const RET30 = [['any', 'Any'], ['pos', 'Positive'], ['neg', 'Negative']];
const OWNED = [['all', 'All'], ['held', 'Held'], ['watching', 'Watching']];

const view = {
  q: '', order: null, orderKey: '', preview: null, previewFor: null, previewKey: null, showTimer: null, hideTimer: null,
  dismissedKey: null, suppressFocus: false, returnFocus: null, focusProvider: null, focusOnRender: false, bound: false, menus: [],
};

function prefs(ctx) {
  const saved = ctx.ui.get('watchlist', {}) || {};
  const cols = Array.isArray(saved.columns) ? saved.columns.filter((c) => COLUMNS.some((x) => x.id === c && !x.disabled)) : COLUMNS.filter((c) => c.def).map((c) => c.id);
  if (!cols.includes('research')) cols.push('research');
  return { columns: cols, sort: saved.sort && SORT_NAMES[saved.sort.key] ? saved.sort : DEFAULT_SORT, filters: { ...DEFAULT_FILTERS, ...(saved.filters || {}) } };
}

function savePrefs(ctx, p) {
  ctx.ui.set('watchlist', { columns: p.columns, sort: p.sort, filters: p.filters });
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

function matches(p, f, q) {
  if (p.broken) return false;
  if (!f.archived && p.status === 'archived') return false;
  if (f.archived && p.status !== 'archived') return false;
  if (f.sector && (!p.sector || p.sector.primary !== f.sector)) return false;
  if (f.owned === 'held' && !p.held) return false;
  if (f.owned === 'watching' && !(p.on_watchlist && !p.held)) return false;
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

function projectCell(ctx, p) {
  const nameBtn = h('button', { type: 'button', class: 'pname', dataset: { key: `pname-${p.project_id}` }, 'aria-label': `${p.name}${p.symbol ? ` (${p.symbol})` : ''}: show summary`, onclick: (e) => { e.stopPropagation(); openPanel(ctx, p.project_id, e.currentTarget); } }, p.name);
  const sub = [p.symbol || null];
  const marks = [];
  if (p.held) marks.push(h('span', { class: 'held-mark', title: 'You hold this (Portfolio)' }, 'Held'));
  if (p.identity_status !== 'verified') marks.push(h('span', { class: 'flag', title: (p.identity_unknowns || []).join(' ') || 'Identity not confirmed: no prices or holdings use it' }, 'Identity pending'));
  if (p.status === 'archived') marks.push(h('span', null, 'Archived'));
  if (p.changes && p.changes.item_count > 0) marks.push(h('span', { title: `${p.changes.item_count} change(s) since ${p.changes.cursor_source === 'project created' ? 'the project was added' : 'your last review'}` }, `${p.changes.item_count} new`));
  return h('div', { class: 'proj-cell' }, logo(p),
    h('div', { class: 'names' }, nameBtn, h('span', { class: 'sub' }, sub.filter(Boolean).length ? h('span', null, sub[0]) : null, marks)));
}

function priceCell(p) {
  const reason = noPriceReason(p);
  if (reason) return h('span', { class: 'unknown' }, reason);
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
    case 'spark': return m && m.sparkline_7d ? sparkline(m.sparkline_7d, { label: `${p.symbol || p.name} 7-day price` }) : dash('7-day chart');
    case 'mcap': return m && typeof m.market_cap_usd === 'number' ? h('span', { class: 'num', title: fmtPrice(m.market_cap_usd) }, fmtCompactUsd(m.market_cap_usd)) : dash('Market cap');
    case 'mcapChange': return m ? changeCell(m.market_cap_change_24h_pct, { label: 'market cap over 24 hours' }) : dash('Market-cap change');
    case 'fdv': return m && typeof m.fdv_usd === 'number' ? h('span', { class: 'num' }, fmtCompactUsd(m.fdv_usd)) : dash('FDV');
    case 'volume': return m && typeof m.volume_24h_usd === 'number' ? h('span', { class: 'num' }, fmtCompactUsd(m.volume_24h_usd)) : dash('Volume');
    case 'volChange': return m && typeof m.volume_change_24h_pct === 'number' ? changeCell(m.volume_change_24h_pct, { label: 'volume' }) : h('span', { class: 'unknown', title: m ? m.volume_change_basis || '' : 'No market data' }, h('span', { 'aria-hidden': 'true' }, '—'), h('span', { class: 'sr-only' }, 'Volume change unknown'));
    case 'sector': return p.sector ? h('button', { type: 'button', class: 'chip', dataset: { key: `sector-${p.project_id}` }, 'aria-label': `Sector: ${p.sector.label}. Change sector`, title: 'Your label; change it here', onclick: (e) => { e.stopPropagation(); openSectorDialog(ctx, p); } }, p.sector.label) : dash('Sector');
    case 'research': return researchCell(ctx, p);
    case 'lastResearch': return p.last_report_at ? h('span', { title: 'Latest report analysis date' }, fmtDate(p.last_report_at)) : dash('Last research');
    default: return null;
  }
}

function researchCell(ctx, p) {
  const staleDays = ctx.state.index.settings.freshness.research_stale_days || 90;
  return h('div', { class: 'grades' }, PROVIDERS.map((prov) => {
    const b = gradeBadge(prov, p.providers && p.providers[prov], p.research && p.research.providers && p.research.providers[prov], { staleDays, button: true, key: `gb-${p.project_id}-${prov}` });
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
  }));
}

function mktSummaryCell(p) {
  const reason = noPriceReason(p);
  const m = mkt(p);
  if (reason || !m) return h('div', { class: 'mkt-summary' }, h('span', { class: 'none' }, reason || 'No price'));
  return h('div', { class: 'mkt-summary' }, h('span', { class: 'price' }, fmtPrice(m.price_usd)), changeCell(m.change_7d_pct, { label: 'over 7 days' }), m.status !== 'fresh' ? h('span', { class: 'price-note' }, freshnessText(m.status, m.age_minutes).text) : null);
}

// ---- table --------------------------------------------------------------------

// Columns give way, least essential first, until the table fits the space it
// has, so the three grades never scroll out of view. Every hidden value is
// still in the summary panel, and the Columns menu says so.
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

function sortHeader(ctx, prefsObj, col, rerender) {
  const c = COLUMNS.find((x) => x.id === col);
  const cls = [c.num ? 'num' : '', c.hide || '', `c-${col}`].join(' ').trim();
  if (col === 'research') {
    const active = prefsObj.sort.key.startsWith('grade:');
    return h('th', { class: cls, scope: 'col', 'aria-sort': active ? (prefsObj.sort.dir === 'asc' ? 'ascending' : 'descending') : null },
      h('span', { class: 'th-title' }, h('span', { class: 'lbl' }, 'Research'), h('span', { class: 'src' }, 'grade 0–100')),
      h('div', { class: 'provider-sorts', role: 'group', 'aria-label': 'Sort by a model\'s grade' }, PROVIDERS.map((prov) => {
        const key = `grade:${prov}`;
        const on = prefsObj.sort.key === key;
        return h('button', { type: 'button', class: 'sort', 'aria-pressed': String(on), dataset: { key: `sort-${key}` }, 'aria-label': `Sort by ${PROVIDER_LABELS[prov]} grade${on ? `, ${SORT_NAMES[key][prefsObj.sort.dir === 'asc' ? 1 : 2]}` : ''}`, onclick: () => setSort(ctx, prefsObj, key, rerender) },
          PROVIDER_SHORT[prov], on ? h('span', { class: 'arrow', 'aria-hidden': 'true' }, prefsObj.sort.dir === 'asc' ? '▲' : '▼') : null);
      })));
  }
  const sub = col === 'rank' ? view.rankSource || c.sub : c.sub;
  const title = col === 'rank' && view.rankSource === 'Demo data' ? 'Fictional market-cap rank from the demo data' : c.title;
  const label = title ? h('abbr', { title }, c.label) : c.label;
  if (!c.sort) return h('th', { class: cls, scope: 'col' }, h('div', { class: 'th' }, h('span', { class: 'lbl' }, label), sub ? h('span', { class: 'src' }, sub) : null));
  const active = prefsObj.sort.key === c.sort;
  return h('th', { class: cls, scope: 'col', 'aria-sort': active ? (prefsObj.sort.dir === 'asc' ? 'ascending' : 'descending') : null },
    h('button', { type: 'button', class: 'sort', dataset: { key: `sort-${c.sort}` }, onclick: () => setSort(ctx, prefsObj, c.sort, rerender) },
      h('span', { class: 'lbl' }, label, active ? h('span', { class: 'arrow', 'aria-hidden': 'true' }, prefsObj.sort.dir === 'asc' ? '▲' : '▼') : null),
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

function buildTable(ctx, prefsObj, rows, rerender) {
  const cols = COLUMNS.filter((c) => prefsObj.columns.includes(c.id)).map((c) => c.id);
  const selected = ctx.state.route.query.get('p');
  const nameActive = prefsObj.sort.key === 'name';
  const thead = h('thead', null, h('tr', null,
    h('th', { class: 'c-project', scope: 'col', 'aria-sort': nameActive ? (prefsObj.sort.dir === 'asc' ? 'ascending' : 'descending') : null },
      h('button', { type: 'button', class: 'sort', dataset: { key: 'sort-name' }, onclick: () => setSort(ctx, prefsObj, 'name', rerender) },
        h('span', { class: 'lbl' }, 'Project', nameActive ? h('span', { class: 'arrow', 'aria-hidden': 'true' }, prefsObj.sort.dir === 'asc' ? '▲' : '▼') : null),
        h('span', { class: 'src' }, 'name · ticker'))),
    cols.map((c) => sortHeader(ctx, prefsObj, c, rerender))));
  const tbody = h('tbody', null, rows.map((p) => {
    const tr = h('tr', { class: p.project_id === selected ? 'selected' : null, dataset: { pid: p.project_id } },
      h('td', { class: 'c-project' }, projectCell(ctx, p)),
      cols.map((c) => {
        const col = COLUMNS.find((x) => x.id === c);
        return h('td', { class: [col.num ? 'num' : '', col.hide || '', `c-${c}`].join(' ').trim() }, cellFor(ctx, c, p));
      }),
      h('td', { class: 'c-mkt-summary' }, mktSummaryCell(p)));
    tr.addEventListener('click', (e) => {
      if (e.target.closest('button, a, input, select, label, summary')) return;
      openPanel(ctx, p.project_id, tr.querySelector('.pname'));
    });
    return tr;
  }));
  return h('div', { class: 'table-scroll', 'data-keep-scroll': 'watchlist' },
    h('table', { class: 'wl' }, h('caption', { class: 'sr-only' }, `Watchlist. ${sortDescription(prefsObj.sort)}. Choose a project name for its summary; grade badges show a scorecard on hover or keyboard focus.`), thead, tbody));
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

// ---- review queue -------------------------------------------------------------

function attentionBlock(ctx) {
  const items = ctx.state.index.attention || [];
  if (!items.length) return null;
  const high = items.filter((a) => a.severity === 'high').length;
  const open = Boolean(ctx.ui.get('queueOpen', false));
  const first = items[0];
  const det = h('details', { class: 'attention', open: open || null, dataset: { key: 'attention' } },
    h('summary', null,
      h('span', { class: `sev ${high ? 'high' : 'medium'}`, 'aria-hidden': 'true' }),
      h('span', null, h('span', { class: 'count' }, String(items.length)), ` ${items.length === 1 ? 'item needs' : 'items need'} review`, high ? h('span', { class: 'sr-only' }, `, ${high} urgent`) : null),
      h('span', { class: 'peek' }, first.title),
      h('span', { class: 'toggle', 'aria-hidden': 'true' }, open ? 'Hide' : 'Show')),
    h('ol', null, items.slice(0, 8).map((a, i) => h('li', null,
      h('span', { class: `sev ${a.severity}`, role: 'img', 'aria-label': `${a.severity} priority` }),
      h('span', { class: 't' }, h('span', null, a.title), a.detail ? h('span', { class: 'd', title: a.detail }, a.detail) : null),
      a.action ? h('a', { class: 'btn small', href: a.project_id && a.action === `#/project/${a.project_id}` ? `#/watchlist?p=${encodeURIComponent(a.project_id)}` : a.action, dataset: { key: `att-${i}` } }, 'Open') : null))),
    items.length > 8 ? h('p', { class: 'small muted', style: { padding: '0 16px 12px', margin: 0 } }, `${items.length - 8} more in Updates.`) : null);
  det.addEventListener('toggle', () => {
    const t = det.querySelector('summary .toggle');
    if (t) t.textContent = det.open ? 'Hide' : 'Show';
    if (det.open !== Boolean(ctx.ui.get('queueOpen', false))) ctx.ui.set('queueOpen', det.open);
  });
  return det;
}

// ---- hover / focus scorecard (WCAG 1.4.13: hoverable, dismissible, persistent) --

function previewContent(ctx, p, prov) {
  const rep = p.providers && p.providers[prov];
  const job = p.research && p.research.providers && p.research.providers[prov];
  const staleDays = ctx.state.index.settings.freshness.research_stale_days || 90;
  const info = badgeInfo(prov, rep, job, { staleDays });
  const riskLabels = Object.fromEntries((ctx.state.index.rubrics.grading.risk_scores || []).map((x) => [x.id, x.label.replace(/ risk$/i, '')]));
  const rows = [];
  const add = (k, v) => { if (v !== null && v !== undefined && v !== '') rows.push(h('dt', null, k), h('dd', null, v)); };
  let gradeEl;
  if (rep) {
    const g = rep.grade || {};
    if (info.kind === 'grade' || info.kind === 'range') gradeEl = h('div', { class: 'pv-grade' }, h('span', { class: 'big' }, g.display), g.label ? h('span', { class: 'lab' }, g.label) : null, h('span', { class: 'what' }, info.kind === 'range' ? 'grade range, 0–100' : 'grade, 0–100'));
    else gradeEl = h('div', { class: 'pv-grade' }, h('span', { class: 'state-text' }, info.kind === 'pdf' ? 'PDF: needs a text copy' : 'Grade withheld'), g.coverage_pct !== null && g.coverage_pct !== undefined ? h('span', { class: 'what' }, `${g.coverage_pct}% of the weight scored`) : null);
    add('Verdict', verdictChip(rep.verdict));
    add('Horizon', rep.horizon || 'not stated');
    if (info.kind === 'grade' || info.kind === 'range') add('Coverage', `${g.coverage_pct ?? 100}% of the weight scored`);
    const risks = (rep.top_risks || []).filter((r) => r.status === 'scored' || r.status === 'range');
    if (risks.length) add('Top risks', h('span', null, risks.map((r) => `${riskLabels[r.id] || r.id} ${r.status === 'range' ? `${r.low}–${r.high}` : r.value}`).join(' · '), h('span', { class: 'faint' }, ' (higher is worse)')));
    add('Source', `${rep.model_version || 'model not stated'} · ${rep.provenance && rep.provenance.attested ? 'attested by the API' : 'self-reported'}${rep.provenance && rep.provenance.channel ? ` · via ${rep.provenance.channel}` : ''}`);
    if (rep.model_total && rep.model_total.status === 'mismatch') add('Check', 'The model\'s own total differs from this grade');
    if (info.refreshing) add('Newer', RESEARCH_STATE[info.job] ? RESEARCH_STATE[info.job].long : 'research in progress');
  } else {
    gradeEl = h('div', { class: 'pv-grade' }, h('span', { class: 'state-text' }, info.value === 'None' ? 'No research yet' : RESEARCH_STATE[info.kind] ? RESEARCH_STATE[info.kind].short : info.value));
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
    h('div', { class: 'pv-foot' }, 'Click or press Enter for the summary panel · Esc closes'));
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

// ---- persistent summary panel -------------------------------------------------

const wide = () => window.matchMedia('(min-width: 1280px)').matches;

function openPanel(ctx, pid, opener, provider = null) {
  view.returnFocus = opener && opener.dataset ? opener.dataset.key || null : null;
  view.focusProvider = provider;
  view.focusOnRender = true;
  hidePreview();
  ctx.navigate(ctx.hrefWith({ p: pid }));
}

function closePanel(ctx) {
  const key = view.returnFocus;
  const pid = ctx.state.route.query.get('p');
  ctx.navigate(ctx.hrefWith({ p: null }));
  setTimeout(() => {
    const el = (key && document.querySelector(`[data-key="${CSS.escape(key)}"]`)) || (pid && document.querySelector(`[data-key="pname-${CSS.escape(pid)}"]`));
    if (el) {
      view.suppressFocus = true;
      el.focus();
      view.suppressFocus = false;
    }
  }, 30);
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

function providerSection(ctx, p, prov) {
  const rep = p.providers && p.providers[prov];
  const job = p.research && p.research.providers && p.research.providers[prov];
  const staleDays = ctx.state.index.settings.freshness.research_stale_days || 90;
  const info = badgeInfo(prov, rep, job, { staleDays });
  const pid = p.project_id;
  const riskLabels = Object.fromEntries((ctx.state.index.rubrics.grading.risk_scores || []).map((x) => [x.id, x.label]));
  const links = [];
  const actions = [];
  if (rep) {
    links.push(h('a', { href: `#/project/${encodeURIComponent(pid)}/reports?report=${encodeURIComponent(rep.report_id)}`, dataset: { key: `report-${pid}-${prov}` } }, 'Open report'));
    links.push(h('a', { href: `#/project/${encodeURIComponent(pid)}/scorecards?provider=${prov}`, dataset: { key: `scorecard-${pid}-${prov}` } }, 'Scorecard'));
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
  if (job && ['unconfigured', 'waiting'].includes(job.state)) {
    const cp = button('Copy prompt', null, { kind: 'small', key: `copy-${pid}-${prov}` });
    cp.setAttribute('aria-label', `Copy the research prompt for ${PROVIDER_LABELS[prov]}`);
    cp.onclick = async () => {
      try {
        await copyText(await ctx.api.text(`/api/projects/${encodeURIComponent(pid)}/research/${encodeURIComponent(job.run_id)}/prompt`));
      } catch (err) {
        toast(err.message, 'bad');
      }
    };
    actions.push(cp, h('a', { class: 'btn small', href: `#/updates?tab=import&project=${encodeURIComponent(pid)}&provider=${prov}&run=${encodeURIComponent(job.run_id)}`, dataset: { key: `import-${pid}-${prov}` } }, 'Import report'));
  }
  if (!rep && !job) {
    const run = button('Run research', () => openResearchDialog(ctx, p, { providers: [prov] }), { kind: 'small', key: `run-${pid}-${prov}` });
    actions.push(run);
  }
  let gradeLine;
  if (rep && (info.kind === 'grade' || info.kind === 'range')) {
    gradeLine = h('div', { class: 'provider-grade' }, h('span', { class: 'big' }, rep.grade.display), rep.grade.label ? h('span', { class: 'lab', 'aria-label': `letter ${rep.grade.label}` }, rep.grade.label) : null, h('span', { class: 'small muted' }, info.kind === 'range' ? 'grade range, 0–100' : 'grade, 0–100'));
  } else if (rep) {
    gradeLine = h('div', { class: 'provider-grade' }, h('span', { class: 'state-text' }, info.kind === 'pdf' ? 'PDF saved: needs a text copy' : 'Grade withheld'), rep.grade && rep.grade.coverage_pct !== null && rep.grade.coverage_pct !== undefined ? h('span', { class: 'small muted' }, `${rep.grade.coverage_pct}% of the weight scored`) : null);
  } else {
    const st = RESEARCH_STATE[info.kind] || RESEARCH_STATE.none;
    gradeLine = h('div', { class: 'provider-grade' }, stateText(st.long, st.tone));
  }
  const facts = [];
  if (rep) {
    facts.push(['Verdict', verdictChip(rep.verdict)]);
    facts.push(['Analysis date', h('span', null, fmtDate(rep.analysis_at), info.age ? h('span', { class: 'faint' }, ` · ${info.age} ago`.replace('today ago', 'today')) : null, info.stale ? h('span', { class: 'freshness stale' }, ' · stale') : null)]);
    facts.push(['Horizon', rep.horizon || 'not stated']);
    const risks = (rep.top_risks || []).filter((r) => r.status === 'scored' || r.status === 'range');
    if (risks.length) facts.push(['Top risks (higher is worse)', risks.map((r) => `${riskLabels[r.id] || r.id}: ${r.status === 'range' ? `${r.low}–${r.high}` : r.value}`).join(' · ')]);
    if (rep.grade && rep.grade.status === 'withheld' && rep.grade.reason) facts.push(['Why withheld', rep.grade.reason]);
    if (rep.model_total && rep.model_total.status === 'mismatch') facts.push(['Check', rep.model_total.message]);
  } else if (job && job.error) {
    facts.push(['Last error', job.error]);
  }
  const route = rep
    ? `${rep.model_version || 'Model not stated'} · ${rep.provenance && rep.provenance.attested ? 'attested by the API' : 'imported, self-reported'}`
    : job ? (job.mode === 'manual' ? 'Manual: paste the prompt into this model, then import' : job.mode === 'cowork' ? 'Claude Cowork session' : job.mode === 'mock' ? 'Fictional demo adapter' : 'API') : 'Not requested';
  return h('div', { class: 'provider', id: `panel-prov-${prov}`, tabindex: '-1', 'aria-label': `${PROVIDER_LABELS[prov]} scorecard` },
    h('div', { class: 'provider-top' }, h('span', { class: 'name' }, PROVIDER_LABELS[prov]), h('span', { class: 'route' }, route)),
    gradeLine,
    facts.length ? h('dl', { class: 'facts' }, facts.map(([k, v]) => h('div', { class: 'wide' }, h('dt', null, k), h('dd', null, v)))) : null,
    rep && info.refreshing ? h('p', { class: 'small muted', style: { margin: '6px 0 0' } }, `Newer research: ${(RESEARCH_STATE[info.job] || { long: 'in progress' }).long}`) : null,
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
    h('p', { style: { margin: 0 } }, `${comparable.map((x) => PROVIDER_LABELS[x]).join(', ')} used the same rubric, scoring profile and horizon, analyzed within the comparison window.`),
    flagged.length
      ? h('p', { style: { margin: '6px 0 0' } }, h('strong', null, `They differ by ${ctx.state.index.settings.comparison.spread_threshold}+ points on ${flagged.length} item(s): `), flagged.slice(0, 4).map((f) => `${f.label} (${f.spread})`).join(', '), flagged.length > 4 ? ', …' : '', '.')
      : h('p', { style: { margin: '6px 0 0' } }, 'No item differs by the highlight threshold or more.'),
    h('p', { class: 'muted', style: { margin: '6px 0 0' } }, 'Agreement between models is not independent confirmation: they often read the same sources.'),
    h('a', { href: `#/project/${encodeURIComponent(p.project_id)}/comparison`, dataset: { key: `compare-${p.project_id}` } }, 'Compare in detail'));
}

function renderPanel(ctx, pid) {
  const root = document.getElementById('panel-root');
  const p = ctx.state.index.projects.find((x) => x.project_id === pid);
  const oldBody = root.querySelector('.panel-body');
  const oldScroll = oldBody ? oldBody.scrollTop : 0;
  if (!p) {
    clear(root);
    document.body.classList.remove('split');
    setSheetMode(false);
    const bd = document.querySelector('.sheet-backdrop');
    if (bd) bd.remove();
    return;
  }
  const split = wide();
  const m = mkt(p);
  const closeBtn = h('button', { type: 'button', class: 'close quiet', 'aria-label': 'Close summary', dataset: { key: 'panel-close' } }, '×');
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
  const heading = h('h2', { id: 'panel-title', tabindex: '-1' }, p.name);
  const f = m ? freshnessText(m.status, m.age_minutes) : null;
  const panel = h('aside', split
    ? { class: 'panel', 'aria-labelledby': 'panel-title' }
    : { class: 'panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'panel-title' },
    h('div', { class: 'panel-head' }, logo(p, { size: 32 }),
      h('div', { class: 'names' }, heading,
        h('div', { class: 'meta-line', style: { marginTop: '4px' } },
          p.symbol ? h('span', null, p.symbol) : null,
          p.sector ? h('button', { type: 'button', class: 'link', dataset: { key: 'panel-sector' }, 'aria-label': `Sector: ${p.sector.label}. Change sector`, onclick: () => openSectorDialog(ctx, p) }, p.sector.label) : null,
          h('span', null, p.identity_status === 'verified' ? 'Identity verified' : 'Identity pending'),
          h('span', null, p.held ? 'Held' : p.on_watchlist ? 'Watching' : 'Not watching'))),
      closeBtn),
    h('div', { class: 'panel-body', 'data-keep-scroll': 'panel' },
      h('section', null,
        h('div', { class: 'btn-row' }, h('a', { class: 'btn primary', href: `#/project/${encodeURIComponent(pid)}/overview`, dataset: { key: `open-research-${pid}` } }, 'Open full research'), researchBtn, watchBtn)),
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
            h('div', { class: 'wide' }, h('dt', null, 'Source'), h('dd', { class: 'small' }, `${m.rank_source_label && /fictional/i.test(m.rank_source_label) ? 'Fictional demo data' : 'CoinGecko'} · as of ${fmtDateTime(m.as_of)}`))))
          : h('p', { class: 'small muted' }, `No market data: ${(noPriceReason(p) || 'unknown').toLowerCase()}.`, p.identity_status !== 'verified' ? ' Prices appear once the token\'s identity is confirmed.' : '')),
      h('section', { 'aria-labelledby': 'panel-models' }, h('h3', { id: 'panel-models' }, 'Model scorecards'),
        PROVIDERS.map((prov) => providerSection(ctx, p, prov)),
        h('details', { class: 'explain', dataset: { key: 'panel-explain' } }, h('summary', null, 'How to read these grades'),
          h('p', { style: { marginTop: '6px' } }, 'Each model writes its own report. This app calculates a 0–100 grade from that report\'s six weighted component scores (20/25/20/15/10/10) under the rubric the report declares. Letters: A 90+, B 80+, C 70+, D 60+, F below 60.'),
          h('p', null, 'A range means the model gave score ranges. "Withheld" means a component was missing; the share of the weight that was scored is shown instead of a guess. Downside-risk scores are separate: higher means more risk.'))),
      h('section', { 'aria-labelledby': 'panel-compare' }, h('h3', { id: 'panel-compare' }, 'How the models compare'), comparisonNote(ctx, p)),
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
  clear(root).appendChild(panel);
  const body = panel.querySelector('.panel-body');
  if (body && oldScroll && !view.focusOnRender) body.scrollTop = oldScroll;
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
  // Focus moves into the panel only when you open it, never on a live refresh.
  if (view.focusOnRender) {
    const target = view.focusProvider ? panel.querySelector(`#panel-prov-${view.focusProvider}`) : heading;
    if (target) {
      target.focus({ preventScroll: false });
      ctx.claimFocus();
    }
    const row = document.querySelector(`tr[data-pid="${CSS.escape(pid)}"]`);
    if (row && split) row.scrollIntoView({ block: 'nearest' });
  } else if (!split && !panel.contains(document.activeElement)) {
    heading.focus({ preventScroll: true });
  }
  view.focusOnRender = false;
  view.focusProvider = null;
}

// ---- page ---------------------------------------------------------------------

export function renderWatchlist(ctx, route) {
  const idx = ctx.state.index;
  const rankLabels = [...new Set(idx.projects.map((p) => p.market && p.market.rank_source_label).filter(Boolean))];
  const demoData = rankLabels.length > 0 && rankLabels.every((l) => /fictional/i.test(l));
  const demoWorkspace = Boolean(ctx.state.session && ctx.state.session.workspace && ctx.state.session.workspace.kind === 'demo');
  view.rankSource = demoData ? 'Demo data' : 'CoinGecko';
  view.priceSource = demoData || demoWorkspace ? 'fictional demo data' : 'CoinGecko';
  SORT_NAMES.rank[0] = demoData ? 'Rank (demo data)' : 'Rank (CoinGecko)';
  const prefsObj = prefs(ctx);
  const all = idx.projects.filter((p) => !p.broken);
  const holder = h('div');
  const resultsLine = h('div', { class: 'results-line' });
  const tokens = h('div', { class: 'active-filters' });
  const toolbar = h('div', { class: 'toolbar', role: 'search', 'aria-label': 'Find and filter projects', dataset: { nodirty: '1' } });
  view.menus = [];

  const filterCount = () => {
    const f = prefsObj.filters;
    return [f.sector, f.coverage !== 'any', f.ret30 !== 'any', f.archived].filter(Boolean).length;
  };

  const rerender = (reason = 'user') => {
    const f = prefsObj.filters;
    const fresh = sortRows(all.filter((p) => matches(p, f, view.q)), prefsObj.sort);
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
    const total = all.filter((p) => (f.archived ? p.status === 'archived' : p.status !== 'archived')).length;
    const filtered = Boolean(view.q) || filterCount() > 0 || f.owned !== 'all';
    resultsLine.replaceChildren(...[
      h('span', null, filtered ? `${rows.length} of ${total} ${f.archived ? 'archived ' : ''}projects` : `${total} ${f.archived ? 'archived ' : ''}project${total === 1 ? '' : 's'}`),
      h('span', null, sortDescription(prefsObj.sort)),
      reordered ? h('span', { class: 'reorder' }, h('span', null, 'Values updated; order kept while you look.'), button('Re-sort', () => { view.order = null; rerender(); }, { kind: 'small', key: 'resort' })) : null,
    ].filter(Boolean));
    drawTokens();
    if (rows.length) {
      holder.replaceChildren(buildTable(ctx, prefsObj, rows, () => rerender()));
      if (holder.isConnected) fitColumns(holder);
    }
    else if (!all.filter((p) => p.status !== 'archived').length && !f.archived) {
      holder.replaceChildren(h('div', { class: 'empty' }, h('h2', null, 'Your watchlist is empty'),
        h('p', null, 'Add a project by name or official website. Research and prices follow from there.'),
        h('div', { class: 'btn-row' }, button('Add project', () => openAddProjectDialog(ctx), { kind: 'primary', key: 'empty-add' })),
        h('p', { class: 'small muted', style: { marginTop: '12px' } }, 'Or ask Cowork: "Add [project name and official URL] to my crypto watchlist and research it with Claude, ChatGPT, and Gemini."')));
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
    announce(resultsLine.textContent);
  };

  const clearAll = () => {
    view.q = '';
    prefsObj.filters = { ...DEFAULT_FILTERS };
    savePrefs(ctx, prefsObj);
    view.order = null;
    drawControls();
    rerender();
    announce('Search and filters cleared.');
  };

  const search = input({ type: 'search', placeholder: 'Search name, ticker or sector', 'aria-label': 'Search projects', value: view.q, dataset: { key: 'wl-search' } });
  search.addEventListener('input', () => {
    view.q = search.value;
    view.order = null;
    rerender();
  });

  function drawTokens() {
    const f = prefsObj.filters;
    const list = [];
    const tok = (label, onRemove, key) => h('span', { class: 'token' }, label, h('button', { type: 'button', 'aria-label': `Remove filter: ${label}`, dataset: { key }, onclick: onRemove }, '×'));
    if (view.q) list.push(tok(`Search: “${view.q}”`, () => { view.q = ''; search.value = ''; view.order = null; rerender(); search.focus(); }, 'tok-q'));
    if (f.owned !== 'all') list.push(tok(OWNED.find(([v]) => v === f.owned)[1], () => setFilter('owned', 'all'), 'tok-owned'));
    if (f.sector) list.push(tok(`Sector: ${(idx.sectors.find((s) => s.id === f.sector) || { label: f.sector }).label}`, () => setFilter('sector', ''), 'tok-sector'));
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
    const sectorCounts = Object.fromEntries((idx.sectors || []).map((s) => [s.id, all.filter((p) => p.status !== 'archived' && p.sector && p.sector.primary === s.id).length]));
    const filters = menu('Filters', { key: 'filters', count: filterCount() }, (api) => [
      radioGroup('f-sector', 'Sector', [['', 'All sectors', all.filter((p) => p.status !== 'archived').length], ...(idx.sectors || []).map((s) => [s.id, s.label, sectorCounts[s.id]])], f.sector, (v) => setFilter('sector', v)),
      radioGroup('f-coverage', 'Model coverage', COVERAGE, f.coverage, (v) => setFilter('coverage', v)),
      radioGroup('f-ret30', '30-day change', RET30, f.ret30, (v) => setFilter('ret30', v)),
      h('fieldset', null, h('legend', null, 'Archive'), h('label', null, h('input', { type: 'checkbox', checked: f.archived, onchange: (e) => setFilter('archived', e.target.checked) }), h('span', null, 'Show archived projects only'))),
      h('div', { class: 'menu-foot' }, button('Clear filters', () => { clearAll(); api.close(); }, { kind: 'small quiet' }), button('Done', () => api.close(), { kind: 'small primary' })),
    ]);
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
      h('p', { class: 'small muted', style: { margin: '0 0 8px' } }, 'Narrow windows hide some columns; every value stays in the summary panel.'),
      h('div', { class: 'menu-foot' }, button('Reset columns', () => { prefsObj.columns = COLUMNS.filter((c) => c.def).map((c) => c.id); savePrefs(ctx, prefsObj); rerender(); api.close(); }, { kind: 'small quiet' }), button('Done', () => api.close(), { kind: 'small primary' })),
    ]);
    columns.classList.add('columns-wide');
    const sortSel = select(Object.entries(SORT_NAMES).flatMap(([k, [label, a, d]]) => [{ value: `${k}:asc`, label: `${label}, ${a}` }, { value: `${k}:desc`, label: `${label}, ${d}` }]), {
      class: 'sort-compact', 'aria-label': 'Sort projects',
      onchange: (e) => { const v = e.target.value; const dir = v.split(':').pop(); prefsObj.sort = { key: v.slice(0, v.length - dir.length - 1), dir }; savePrefs(ctx, prefsObj); view.order = null; rerender(); },
    });
    sortSel.value = `${prefsObj.sort.key}:${prefsObj.sort.dir}`;
    toolbar.replaceChildren(
      h('div', { class: 'search' }, search),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' }, OWNED.map(([v, text]) => h('button', { type: 'button', 'aria-pressed': String(v === f.owned), dataset: { key: `owned-${v}` }, onclick: () => setFilter('owned', v) }, text))),
      filters, sortSel, columns);
  }

  const m = idx.freshness.market;
  const fr = freshnessText(m.freshness, m.age_minutes);
  const refreshBtn = button('Refresh prices', null, { kind: 'small', key: 'refresh-prices' });
  refreshBtn.onclick = async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Refreshing…';
    try {
      const out = await ctx.api.post('/api/market/refresh', {});
      toast(out.result && out.result.message ? out.result.message : 'Prices refreshed');
      await ctx.refresh();
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      if (refreshBtn.isConnected) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'Refresh prices';
      }
    }
  };
  const held = all.filter((p) => p.held && p.status !== 'archived').length;
  const addBtn = button('Add project', () => openAddProjectDialog(ctx), { kind: 'primary', key: 'add-project' });
  addBtn.id = 'add-project-btn';
  drawControls();
  // Only a fresh visit re-sorts; live updates, Back and opening a panel keep the order you saw.
  rerender(['live', 'same', 'refresh', 'pop'].includes(ctx.state.renderReason) ? 'live' : 'user');

  // The summary panel follows the address (?p=<id>), so Back and bookmarks restore it.
  // It is drawn once the page is in the document, so it finds the new rows.
  const pid = route.query.get('p');
  const afterMount = () => {
    fitColumns(page);
    if (view.resizeObserver) view.resizeObserver.disconnect();
    view.resizeObserver = new ResizeObserver(() => requestAnimationFrame(() => fitColumns(page)));
    view.resizeObserver.observe(page);
    if (pid) renderPanel(ctx, pid);
    else {
      clear(document.getElementById('panel-root'));
      document.body.classList.remove('split');
      setSheetMode(false);
      const bd = document.querySelector('.sheet-backdrop');
      if (bd) bd.remove();
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
      if (ctx.state.route && ctx.state.route.name === 'watchlist' && ctx.state.route.query.get('p')) closePanel(ctx);
    });
    document.addEventListener('pointermove', (e) => {
      if (view.dismissedKey) {
        const el = document.querySelector(`[data-key="${CSS.escape(view.dismissedKey)}"]`);
        if (!el || !el.matches(':hover')) view.dismissedKey = null;
      }
      if (!previewOpen()) return;
      const inside = (el) => {
        if (!el || !el.isConnected) return false;
        const r = el.getBoundingClientRect();
        return e.clientX >= r.left - 4 && e.clientX <= r.right + 4 && e.clientY >= r.top - 4 && e.clientY <= r.bottom + 4;
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

  const page = h('div', { class: 'wl-wrap' },
    h('div', { class: 'wl-head' },
      h('div', null,
        h('h1', null, 'Watchlist'),
        h('div', { class: 'sub' },
          h('span', null, ((n) => `${n} project${n === 1 ? '' : 's'}`)(all.filter((p) => p.status !== 'archived').length), held ? ` · ${held} held` : ''),
          h('span', { class: `freshness ${['stale', 'stale_failed', 'failed'].includes(m.freshness) ? 'stale' : ''}`.trim() },
            `Prices: ${view.priceSource} · ${m.last_success_at ? `updated ${fmtAgo(m.last_success_at)}` : 'never fetched'}${m.freshness !== 'fresh' && m.freshness !== 'never_run' ? ` · ${fr.text}` : ''}`),
          refreshBtn)),
      h('div', { class: 'actions' }, addBtn)),
    attentionBlock(ctx),
    toolbar,
    tokens,
    resultsLine,
    holder,
    h('p', { class: 'legend-line' },
      h('span', null, view.rankSource === 'Demo data' ? 'Rank: fictional demo rank' : 'Rank: CoinGecko market-cap rank'),
      h('span', null, '7D and 30D: rolling price change'),
      h('span', null, 'Volume: last 24 hours, USD'),
      h('span', null, 'Grades: 0–100, calculated by this app from each model\'s own report; hover or focus one for its date and details'),
      h('span', null, `A month count on a grade (like 4mo) means the analysis is older than ${idx.settings.freshness.research_stale_days || 90} days`),
      h('span', null, '— unknown or not available')));
  page.afterMount = afterMount;
  return page;
}
