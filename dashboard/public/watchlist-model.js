// The watchlist's rules, apart from any drawing: its columns and sort names,
// the saved preferences, which projects a filter shows and in what order,
// the strings every market figure reads as, each model's cell, what needs
// action and what waits for review, the contract checks in brief, and the
// review order. Pure: the React watchlist and inspector (dashboard/web) draw
// from it and the tests check it.
import {
  PROVIDERS, PROVIDER_LABELS, PROVIDER_SHORT, RESEARCH_STATE, marketFigure, fmtPrice, fmtChangePct, fmtMarketFigure, fmtCompactUsd,
  fmtDate, fmtDateTime, fmtAgo, onHoldOf, jobKey, anchorText, scoreTier,
} from './ui.js';

// The Desk's column catalogue (Level 0, DESIGN_AND_IA_BLUEPRINT.md §3.1; Eric,
// 2026-10-17): the project (frozen, always shown), then seven by default:
// Price / 24h, 7D, Grade (the canonical grade, D1, with the three-model
// consensus glyph), Risk (one waterfall: forensic state, else the downside
// score, else a GoPlus flag, else "Not audited"), Last research, and the
// pinned Action that appears on hover. Everything else stays one choice away
// in the Columns picker, nothing removed: Exit @ $500 (off by default, D2),
// the market columns, the sector and each model's own grade. When the list
// is narrower than its columns, the least essential give way (the phone keeps
// Project, Price / 24h, Grade and Risk); every value stays in the inspector.
// The former Liquidity column was dead UI (no source is configured) and is
// gone until a source is set.
export const COLUMNS = [
  { id: 'rank', label: '#', title: 'Market-cap rank, as reported by CoinGecko', sort: 'rank', num: true, market: true },
  { id: 'priceStack', label: 'Price / 24h', title: 'The price, with its change over 24 hours under it', def: true, sort: 'price', num: true, market: true },
  { id: 'spark', label: '7D', title: 'Price over the last 7 days (provider series); the 7-day change on hover', def: true, sort: 'change7d', market: true },
  { id: 'grade', label: 'Grade', title: 'Your pinned headline report\'s grade, else Claude\'s current eligible report; the dots are Claude, GPT and Gemini. Never an average.', def: true, sort: 'grade' },
  { id: 'risk', label: 'Risk', title: 'The highest-severity signal available: a forensic outcome, else the report\'s top downside score, else a GoPlus contract flag; "Not audited" when none exists', def: true, sort: 'risk' },
  { id: 'exit', label: 'Exit @ $500', title: 'Estimated cost of selling your exit size, against your exit-cost limit (Preferences, Screening)', sort: 'exit', num: true },
  { id: 'lastResearch', label: 'Last research', title: 'Age of the latest report\'s analysis; amber once a suggested review date has passed', def: true, sort: 'lastResearch' },
  { id: 'price', label: 'Price', sort: 'price', num: true, market: true },
  { id: 'change24h', label: '24h %', title: 'Price change over the last 24 hours', sort: 'change24h', num: true, market: true },
  { id: 'change7d', label: '7d %', title: 'Price change over the last 7 days (rolling)', sort: 'change7d', num: true, market: true },
  { id: 'change30d', label: '30d %', title: 'Price change over the last 30 days (rolling)', sort: 'change30d', num: true, market: true },
  { id: 'mcap', label: 'Market cap', title: 'Price × circulating supply, as reported by CoinGecko', sort: 'mcap', num: true, market: true },
  { id: 'mcapChange', label: 'Mkt cap 24h %', title: 'Market-cap change over 24 hours, as reported by CoinGecko', sort: 'mcapChange', num: true, market: true },
  { id: 'fdv', label: 'FDV', title: 'Fully diluted valuation: price × maximum (or total) supply', sort: 'fdv', num: true, market: true },
  { id: 'volume', label: 'Volume 24h', title: 'Trading volume over the last 24 hours, in USD', sort: 'volume', num: true, market: true },
  { id: 'volChange', label: 'Volume change', title: 'Measured against our own stored observation from about 24 hours earlier', sort: 'volChange', num: true, market: true },
  { id: 'sector', label: 'Sector', sort: 'sector' },
  { id: 'research', label: 'Model grades', title: 'Each model\'s own grade in its own column: Claude, GPT, Gemini. Never combined.' },
];
export const DEFAULT_COLUMNS = COLUMNS.filter((c) => c.def).map((c) => c.id);

export const SORT_NAMES = {
  name: ['Project', 'A to Z', 'Z to A'], rank: ['Rank (CoinGecko)', 'highest first', 'lowest first'], price: ['Price', 'lowest first', 'highest first'],
  change24h: ['24H change', 'lowest first', 'highest first'], change7d: ['7D change', 'lowest first', 'highest first'], change30d: ['30D change', 'lowest first', 'highest first'],
  mcap: ['Market cap', 'smallest first', 'largest first'], mcapChange: ['Market cap 24H change', 'lowest first', 'highest first'], fdv: ['FDV', 'smallest first', 'largest first'],
  volume: ['Volume', 'smallest first', 'largest first'], volChange: ['Volume change', 'lowest first', 'highest first'], sector: ['Sector', 'A to Z', 'Z to A'],
  lastResearch: ['Last research', 'oldest first', 'newest first'], grade: ['Grade', 'lowest first', 'highest first'], risk: ['Risk', 'least first', 'most first'],
  exit: ['Exit cost', 'lowest first', 'highest first'], 'grade:claude': ['Claude grade', 'lowest first', 'highest first'],
  'grade:chatgpt': ['GPT grade', 'lowest first', 'highest first'], 'grade:gemini': ['Gemini grade', 'lowest first', 'highest first'],
};

// The views (underline tabs with counts, §3.1): what you follow (watched or
// held), what needs your review (D3: one project counts once), what waits on
// a model, what you hold, what you stopped watching, everything. Archived
// projects are a view of the ⋯ menu (the archived filter). Holdings
// themselves live in Portfolio.
export const DEFAULT_FILTERS = { sector: '', owned: 'watching', coverage: 'any', ret30: 'any', beat: 'any', archived: false };
export const DEFAULT_SORT = { key: 'rank', dir: 'asc' };
export const COVERAGE = [['any', 'Any coverage'], ['all3', 'Graded by all three models'], ['missing', 'Missing a model grade'], ['none', 'No research yet'], ['attention', 'Failed or withheld']];
export const RET30 = [['any', 'Any'], ['pos', 'Positive'], ['neg', 'Negative']];
export const BEAT = [['any', 'Any'], ['yes', 'Beat BTC over 30 days'], ['no', 'Behind BTC over 30 days']];
export const VIEWS = [['watching', 'Watching'], ['review', 'Needs review'], ['waiting', 'Waiting on a model'], ['held', 'Held'], ['off', 'Not watching'], ['all', 'All']];
export const OWNED = VIEWS;
export const PREFS_VERSION = 4;

// The saved preferences (config/ui-state.json, key "watchlist"), read through
// ctx.ui.get. Columns saved before the Desk's layout (v4) start from its
// defaults; sort and filters are kept.
export function prefs(ctx) {
  const saved = ctx.ui.get('watchlist', {}) || {};
  const keepCols = Array.isArray(saved.columns) && saved.v >= 4;
  const cols = keepCols ? COLUMNS.filter((x) => saved.columns.includes(x.id)).map((x) => x.id) : DEFAULT_COLUMNS.slice();
  const filters = { ...DEFAULT_FILTERS, ...(saved.filters || {}) };
  // Version 1 only: there, "all" was the old default, not a choice.
  if (!(saved.v >= 2) && filters.owned === 'all') filters.owned = DEFAULT_FILTERS.owned;
  if (!VIEWS.some(([v]) => v === filters.owned)) filters.owned = DEFAULT_FILTERS.owned;
  if (!BEAT.some(([v]) => v === filters.beat)) filters.beat = 'any';
  const density = saved.density === 'compact' ? 'compact' : 'comfortable';
  return { columns: cols, sort: saved.sort && SORT_NAMES[saved.sort.key] ? saved.sort : DEFAULT_SORT, filters, density };
}

export function prefsToSave(p) {
  return { v: PREFS_VERSION, columns: p.columns, sort: p.sort, filters: p.filters, density: p.density || 'comfortable' };
}

// A new sort: the same key flips its direction; a new key starts ascending for
// rank, name and sector, descending for the rest.
export function nextSort(sort, key) {
  if (sort.key === key) return { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: ['rank', 'name', 'sector'].includes(key) ? 'asc' : 'desc' };
}

export function sortDescription(sort) {
  const s = SORT_NAMES[sort.key] || [sort.key, 'ascending', 'descending'];
  if (sort.key === 'rank') return `Sorted by ${SORT_NAMES.rank[0].charAt(0).toLowerCase()}${SORT_NAMES.rank[0].slice(1)}, ${sort.dir === 'asc' ? 'highest rank first' : 'lowest rank first'}`;
  return `Sorted by ${s[0]}, ${s[sort.dir === 'asc' ? 1 : 2]}`;
}

// ---- values ---------------------------------------------------------------------

// A usable market row, or null (none, invalid, or no price).
export function mkt(p) {
  return p.market && p.market.status !== 'invalid' && typeof p.market.price_usd === 'number' ? p.market : null;
}

export function gradeSortValue(p, prov) {
  const r = p.providers && p.providers[prov];
  if (!r || !r.grade || r.needs_text) return null;
  if (r.grade.status === 'firm') return r.grade.value;
  if (r.grade.status === 'range') return r.grade.low; // ranges sort by their low end
  return null;
}

export function sortValue(p, key) {
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
    case 'grade': return canonicalGrade(p, null).sort;
    case 'risk': { const r = riskCell(p, null); return r.kind === 'none' ? null : r.rank; }
    case 'exit': return exitCell(p).sort;
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

export function coverageOf(p) {
  const reps = PROVIDERS.map((x) => p.providers && p.providers[x]);
  const jobs = PROVIDERS.map((x) => p.research && p.research.providers && p.research.providers[x]);
  return {
    gradedCount: reps.filter(graded).length,
    reportCount: reps.filter(Boolean).length,
    attention: jobs.some((j) => j && j.state === 'failed') || reps.some((r) => r && r.grade && r.grade.status === 'withheld'),
  };
}

export function matches(p, f, q, index = null, agenda = null) {
  if (p.broken) return false;
  if (!f.archived && p.status === 'archived') return false;
  if (f.archived && p.status !== 'archived') return false;
  if (f.sector && (!p.sector || p.sector.primary !== f.sector)) return false;
  // An archived project is never on the watchlist, so the Archived filter
  // lists every archived project whatever the view says.
  if (!f.archived && !inView(p, f.owned, index, agenda)) return false;
  if (f.beat && f.beat !== 'any') {
    const m = mkt(p);
    const v = m && m.vs_btc ? m.vs_btc.vs_btc_30d_pct : null;
    if (typeof v !== 'number') return false;
    if (f.beat === 'yes' && !(v > 0)) return false;
    if (f.beat === 'no' && !(v < 0)) return false;
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

// Whether a project is in one of the Desk's views (the archived filter aside).
export function inView(p, view, index = null, agenda = null) {
  if (!p || p.broken) return false;
  switch (view) {
    case 'held': return Boolean(p.held);
    case 'watching': return Boolean(p.on_watchlist || p.held);
    case 'off': return !(p.on_watchlist || p.held);
    case 'review': return reviewReasons(p, index, agendaRowOf(agenda, p.project_id)).length > 0;
    case 'waiting': return waitingJobs(p, index).length > 0;
    default: return true;
  }
}

// How many filters are on, beyond the view.
export function filterCount(f) {
  return [f.sector, f.coverage !== 'any', f.ret30 !== 'any', f.beat && f.beat !== 'any', f.archived].filter(Boolean).length;
}

// Why a project shows no price, in words.
export function noPriceReason(p) {
  if (p.identity_status !== 'verified') return 'Identity pending';
  if (!p.coingecko_id) return 'No market listing';
  if (!p.market || p.market.status === 'missing') return 'Not fetched yet';
  if (p.market.status === 'invalid') return 'Invalid data';
  return null;
}

// The strings the list and the inspector show for one market row, from the
// same formatters, so a value reads the same in both.
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

// A model on hold on this desk (settings research.on_hold, any model): its
// header says so, and a cell where it has no report at all is a quiet dash.
// A saved report keeps its pill: its grade, Withheld or PDF.
export function holdCell(index, prov, rep) {
  const hold = Boolean(onHoldOf(index, prov));
  return { hold, dash: hold && !rep, label: `No ${PROVIDER_LABELS[prov] || prov} score` };
}

// The model the inspector opens on: a calculated grade first, then any saved
// report, then Claude.
export function defaultModel(providers) {
  const rep = (x) => providers && providers[x];
  return PROVIDERS.find((x) => rep(x) && !rep(x).needs_text && rep(x).grade && ['firm', 'range'].includes(rep(x).grade.status))
    || PROVIDERS.find((x) => rep(x))
    || PROVIDERS[0];
}

// One model's way from prompt to grade, as four marks: done, now, needs you
// or a check, failed.
export const STEP_NAMES = ['Prompt', 'Research', 'Report', 'Grade'];
export function progressSteps(rep, key) {
  const done = rep && rep.grade && ['firm', 'range'].includes(rep.grade.status) && !rep.needs_text;
  const research = !key ? (rep ? 'done' : 'todo')
    : key === 'completed' ? 'done'
      : ['queued', 'running', 'dispatching', 'cowork', 'connector'].includes(key) ? 'now'
        : key === 'failed' || key === 'incomplete' || key === 'conflict' ? 'bad'
          : ['waiting', 'interrupted', 'uncertain'].includes(key) ? 'warn' : 'todo';
  return [
    key || rep ? 'done' : 'todo',
    research,
    rep ? 'done' : 'todo',
    done ? 'done' : rep ? 'warn' : 'todo',
  ];
}

// ---- attention: problems in view, the rest in the review queue -----------------

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

export function attentionHref(a) {
  return a.project_id && a.action === `#/project/${a.project_id}` ? `#/watchlist?p=${encodeURIComponent(a.project_id)}` : a.action;
}

// Every other kind in a word or two, so no item reads as a bare warning.
export const KIND_WORDS = {
  request_pending: 'Request pending', research_waiting: 'Waiting for you', review_overdue: 'Review overdue', review_due: 'Review due',
  review_upcoming: 'Review soon', review_suggested: 'Review suggested', disagreement: 'Models differ', alert: 'Price alert',
  extraction: 'Check report', needs_text: 'Needs text', identity_price: 'No price', stale_research: 'Old research', grade_mismatch: 'Total differs',
  market_stale: 'Prices stale', scheduler_quiet: 'Task quiet', limit: 'Limit', research_refresh_due: 'Refresh due',
};

export function kindWord(a) {
  return ALWAYS_VISIBLE[a.kind] || KIND_WORDS[a.kind] || (String(a.kind || '').startsWith('portfolio_') ? 'Portfolio' : a.severity === 'high' ? 'Urgent' : 'Review');
}

// What the optional background API of a model still needs, in brief.
export function setupShort(reason) {
  const r = String(reason || '');
  if (/API key/.test(r)) return 'Automatic: no API key (optional)';
  const n = r.replace(/^not configured:\s*/, '').split(/,\s*(?![^(]*\))/).filter(Boolean).length;
  return n ? `Automatic: ${n} setting${n === 1 ? '' : 's'} missing (optional)` : 'Automatic: not set up (optional)';
}

// Each model's research route, counted.
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

// ---- the status strip -------------------------------------------------------------

// Time left until the price source's next try, as m:ss (h:mm:ss past an
// hour); "due" once it has passed.
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

// Breadth over 30 days, as the snapshot computes it.
export function breadthWords(b30) {
  if (!b30 || typeof b30.beating_btc !== 'number' || typeof b30.counted !== 'number') return null;
  return {
    text: `${b30.beating_btc} of ${b30.counted} beat BTC`,
    window: '30d',
    title: `${b30.beating_btc} of the ${b30.counted} counted coins rose more than Bitcoin over 30 days. Counted: the 100 largest by CoinGecko market cap, less Bitcoin, stablecoins and other pegged, gold-backed, tokenized-fund and wrapped tokens.`,
  };
}

// What a manual price refresh did, for its notice: anything but a full or
// partial update is a failure, said plainly, with the age of the prices still shown.
export function refreshToast(out) {
  const r = out && out.result;
  const st = (out && out.status) || {};
  if (r && ['ok', 'partial'].includes(r.status)) return [r.message || 'Prices refreshed', ''];
  const why = String((r && r.message) || st.note || st.last_error || 'the price source did not answer').replace(/^not refreshed:\s*/i, '').replace(/[.\s]+$/, '');
  const shown = st.last_success_at ? `Showing prices from ${fmtDateTime(st.last_success_at)}.` : 'There are no earlier prices to show.';
  return [`Prices not refreshed: ${why}. ${shown}`, 'bad'];
}

// ---- the inspector's header -----------------------------------------------------------

// The time a price line shows: the status bar's refresh time when that refresh
// stored the price; kept from an earlier one, said so with its own time.
export function priceClock(assetFetchedAt, lastRefreshAt) {
  const a = Date.parse(assetFetchedAt || '');
  const r = Date.parse(lastRefreshAt || '');
  if (Number.isNaN(a)) return { text: Number.isNaN(r) ? null : fmtAgo(lastRefreshAt), kept: false };
  if (Number.isNaN(r) || a >= r - 60000) return { text: fmtAgo(Number.isNaN(r) ? assetFetchedAt : lastRefreshAt), kept: false };
  return { text: `Not refreshed · ${fmtAgo(assetFetchedAt)}`, kept: true };
}

// One of DefiLlama's 30-day totals, as saved (never fetched here): the total,
// or null with the reason. A partial month is not a total.
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

// Whether a project is bound to a DefiLlama entity.
export function defillamaBound(f) {
  return Boolean(f && f.state && !['unmapped', 'disabled'].includes(f.state));
}

// A token that taxes its own sales, beside the revenue DefiLlama reports for
// it: part of that revenue may be the tax its sellers pay, not use of the
// product. Said as the two facts side by side; no share is computed, since
// no source here measures the tax collected. null when GoPlus reports no tax
// above zero or no DefiLlama entity is bound.
export function taxRevenueNote(screening, fundamentals) {
  if (!defillamaBound(fundamentals)) return null;
  const taxes = (screening && Array.isArray(screening.contracts) ? screening.contracts : []).map((c) => c && c.sell_tax_pct).filter((x) => typeof x === 'number' && Number.isFinite(x) && x > 0);
  if (!taxes.length) return null;
  const top = Math.max(...taxes);
  return `GoPlus reports a ${top}% sell tax on this token: part of the revenue DefiLlama reports may be that tax, paid by holders who sell, rather than use of the product. The desk does not split the two.`;
}

// The index row as dex.js reads a project: the verified identity's contracts
// from the saved screen summary.
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

// ---- contract checks in brief -----------------------------------------------------------

// GoPlus's answers as words: present Yes, absent No, unknown "—" (GoPlus gave
// no answer). Nothing is ever called safe.
export const FLAG_WORD = { present: 'Yes', absent: 'No', unknown: '—' };
const FLAG_SPOKEN = { present: 'yes', absent: 'no', unknown: 'unknown (GoPlus gave no answer)' };
export const shortAddr = (a) => (a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '');

// Several contracts' answers as one: present when any says present, then
// unknown, and absent only when every one says absent.
function worstFlag(values) {
  const v = values.filter((x) => x === 'present' || x === 'absent' || x === 'unknown');
  if (!v.length) return null;
  return v.includes('present') ? 'present' : v.includes('unknown') ? 'unknown' : 'absent';
}

const SEVERE_ORDER = ['Honeypot', 'Cannot sell the whole balance', 'Cannot be bought', 'Owner can change balances', 'Balances can be changed', 'Hidden owner', 'Self-destruct', 'Can be closed', 'Not transferable'];
const severeRank = (x) => (SEVERE_ORDER.indexOf(x) === -1 ? SEVERE_ORDER.length : SEVERE_ORDER.indexOf(x));
const ageText = (hours) => (typeof hours !== 'number' ? null : hours < 1 ? '<1h' : hours < 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`);

// The contract line from the index row's saved screen (never fetched here).
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
export const badgeRank = (b) => (BADGE_RANK[b.key] !== undefined ? BADGE_RANK[b.key] : b.key === 'tax' && b.tone === 'severe' ? 2 : b.key === 'tax' ? 6 : { mint: 3, blacklist: 4, proxy: 5 }[b.key] ?? 7);

// The contract chips under Market structure: always Mint, Blacklist (Freeze on
// Solana), Proxy and Tax, each with a status dot (clean, risky, unknown),
// "n/a" for a native coin; then a severe flag or a change.
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

// ---- the review order ------------------------------------------------------------------

// What R does with the selected project: mark it reviewed (only with changes
// to review), offer Undo for six seconds, and move to the next project in the
// list's order that has changes to review ("All caught up" when none).
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
// The reports a list row names, one per model, as Mark reviewed sends them
// (`seen`): each model's latest eligible report, or null where the row has
// none (no report, or only one without text, which the desk never selects).
export function seenFromRow(p) {
  const out = {};
  for (const m of ['claude', 'chatgpt', 'gemini']) {
    const s = p && p.providers ? p.providers[m] : null;
    out[m] = s && s.report_id && !s.broken && !s.needs_text && s.latest_eligible !== false ? s.report_id : null;
  }
  return out;
}

// The words for a review the desk refused because a newer report arrived
// (409 newer_report): each model, and when its report was saved.
export function newerReportWords(newer, when = (s) => s) {
  const labels = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };
  const parts = (Array.isArray(newer) ? newer : []).map((n) => (n.report_id
    ? `A newer ${labels[n.provider] || n.provider} report arrived while you were reading${n.saved_at ? ` (saved ${when(n.saved_at)})` : ''}.`
    : `The ${labels[n.provider] || n.provider} report you were reading is no longer current.`));
  return `${parts.length ? parts.join(' ') : 'A newer report arrived while you were reading.'} Nothing was marked.`;
}

// R counts only as a plain key, outside fields, with no dialog or menu open,
// on a project with something to review.
export function reviewKeyAllowed(e, { busy = false, project = null } = {}) {
  if (!e || (e.key !== 'r' && e.key !== 'R') || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false;
  if (busy) return false;
  return needsReview(project);
}

// The sources the list's figures come from: demo data says so.
export function sourcesOf(index, session) {
  const rankLabels = [...new Set((index.projects || []).map((p) => p.market && p.market.rank_source_label).filter(Boolean))];
  const demoData = rankLabels.length > 0 && rankLabels.every((l) => /fictional/i.test(l));
  const demoWorkspace = Boolean(session && session.workspace && session.workspace.kind === 'demo');
  return {
    rank: demoData ? 'Demo data' : 'CoinGecko',
    price: demoData || demoWorkspace ? 'fictional demo data' : 'CoinGecko',
    rankName: demoData ? 'Rank (demo data)' : 'Rank (CoinGecko)',
  };
}

// ---- every contract check, in words -------------------------------------------------

// GoPlus's checks by key, as the screen saves them: label and weight (severe:
// it can take holders' funds or trap them; watch: an owner power worth
// knowing; info: context). The order is the order shown.
export const CHECKS = [
  ['honeypot', 'Honeypot', 'severe'],
  ['cannot_sell_all', 'Cannot sell the whole balance', 'severe'],
  ['cannot_buy', 'Cannot be bought', 'severe'],
  ['owner_change_balance', 'Owner can change balances', 'severe'],
  ['hidden_owner', 'Hidden owner', 'severe'],
  ['selfdestruct', 'Self-destruct', 'severe'],
  ['balance_mutable', 'Balances can be changed', 'severe'],
  ['closable', 'Can be closed', 'severe'],
  ['non_transferable', 'Not transferable', 'severe'],
  ['mint', 'Mint', 'watch'],
  ['proxy', 'Upgradeable proxy', 'watch'],
  ['blacklist', 'Blacklist', 'watch'],
  ['freeze', 'Freeze authority', 'watch'],
  ['take_back_ownership', 'Ownership can be reclaimed', 'watch'],
  ['transfer_pausable', 'Transfers can be paused', 'watch'],
  ['tax_modifiable', 'Tax can be changed', 'watch'],
  ['personal_tax', 'Tax can differ per address', 'watch'],
  ['transfer_hook', 'Transfer hook', 'watch'],
  ['transfer_hook_upgradable', 'Transfer hook can change', 'watch'],
  ['transfer_fee_upgradable', 'Transfer fee can change', 'watch'],
  ['whitelist', 'Whitelist', 'info'],
  ['trading_cooldown', 'Trading cooldown', 'info'],
  ['external_call', 'Calls external contracts', 'info'],
  ['anti_whale', 'Anti-whale limit', 'info'],
  ['metadata_mutable', 'Metadata can change', 'info'],
];
const CHECK_WORD = { present: 'Yes', absent: 'No', unknown: '—' };
const OWNER = { none: 'No owner', renounced: 'Renounced' };
const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${v}%` : '—');

// Every check of every screened contract, in words, from the saved screen in
// the project record (never fetched here): present flags first, then absent
// ones, severe before watch before info; the checks GoPlus did not answer are
// named on one line.
export function contractChecks(s) {
  if (!s || !Array.isArray(s.contracts) || !s.fetched_at) return null;
  const contracts = s.contracts.map((c) => {
    const base = { label: c.label || c.chain || 'chain?', address: c.address, status: c.status };
    if (c.status !== 'ok') return { ...base, reason: c.reason || null };
    const order = { present: 0, absent: 1 };
    const weight = { severe: 0, watch: 1, info: 2 };
    const all = CHECKS
      .filter(([key]) => c.checks && typeof c.checks[key] === 'string')
      .map(([key, label, level]) => ({ key, label: key === 'mint' ? (c.family === 'solana' ? 'Mint authority' : 'Mint function') : label, level, state: CHECK_WORD[c.checks[key]] ? c.checks[key] : 'unknown', value: CHECK_WORD[c.checks[key]] || '—' }));
    const rows = all.filter((r) => r.state !== 'unknown').sort((a, b) => order[a.state] - order[b.state] || weight[a.level] - weight[b.level]);
    const unknown = all.filter((r) => r.state === 'unknown').sort((a, b) => weight[a.level] - weight[b.level]).map((r) => r.label);
    const t = c.taxes || {};
    const facts = [];
    if (c.family === 'solana') facts.push(['Transfer fee', pct(t.transfer_fee_pct)]);
    else facts.push(['Buy / sell tax', `${pct(t.buy_pct)} / ${pct(t.sell_pct)}`]);
    if (c.owner && c.owner.state !== 'unknown') facts.push(['Owner', OWNER[c.owner.state] || shortAddr(c.owner.address) || 'On record', c.owner.address || null]);
    if (c.source && c.source !== 'unknown') facts.push(['Source code', c.source === 'open' ? 'Open' : 'Not open']);
    if (c.facts && typeof c.facts.holder_count === 'number') facts.push(['Holders', c.facts.holder_count.toLocaleString('en-US')]);
    const notes = [c.notes && c.notes.other_potential_risks, c.notes && c.notes.note].filter(Boolean);
    return { ...base, partial: Boolean(c.partial), checked_at: c.checked_at || s.fetched_at, rows, unknown, facts, notes };
  });
  const labelOf = (a) => (s.contracts.find((c) => c.address === a.address && (!a.chain_id || c.chain_id === a.chain_id)) || {}).label || a.chain;
  const alerts = (Array.isArray(s.alerts) ? s.alerts : []).map((a) => ({ at: a.at, label: labelOf(a), address: a.address, words: a.words }));
  return { fetched_at: s.fetched_at, state: s.state, contracts, alerts };
}

// ---- the Desk (Level 0) and the inspector (Level 1): DESIGN_AND_IA_BLUEPRINT.md §3.1, §3.2 ----

const ymd = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
function daysFrom(a, b) {
  const x = Date.parse(`${ymd(a)}T00:00:00Z`);
  const y = Date.parse(`${ymd(b)}T00:00:00Z`);
  return Number.isNaN(x) || Number.isNaN(y) ? null : Math.round((y - x) / 86400000);
}
const todayOf = (index) => (index && index.today) || new Date().toISOString().slice(0, 10);
const anchorsOf = (index) => (index && index.rubrics && index.rubrics.grading && index.rubrics.grading.favorable_anchors) || [];
const holdOf = (index, prov) => Boolean(index && onHoldOf(index, prov));

// D1, the canonical grade (Eric, 2026-10-17): your pinned headline report when
// you pinned one, else Claude's current eligible report. Never an average of
// the models; the consensus glyph beside it shows each model apart.
export function canonicalOf(p) {
  const h = p && p.headline;
  if (h && h.type === 'report' && h.report_id && !h.broken) {
    return { source: 'headline', provider: h.provider || null, report: h, note: `Your pinned headline: the ${PROVIDER_LABELS[h.provider] || 'chosen'} report` };
  }
  const c = p && p.providers ? p.providers.claude : null;
  if (c && !c.broken && !c.needs_text && c.latest_eligible !== false) return { source: 'claude', provider: 'claude', report: c, note: "Claude's current eligible report" };
  return { source: 'none', provider: 'claude', report: c && !c.broken ? c : null, note: c && c.needs_text ? "Claude's report is a PDF without a text copy" : 'No Claude report yet' };
}

const JOB_WAITING = new Set(['queued', 'dispatching', 'running', 'cowork', 'connector', 'waiting', 'interrupted']);
const JOB_PROBLEM = new Set(['failed', 'uncertain', 'incomplete', 'conflict']);

// The Grade cell: the canonical report's grade (a range as its two ends), its
// rubric word and tier; withheld, PDF, no grade or the research state in words.
export function canonicalGrade(p, index = null) {
  const c = canonicalOf(p);
  const r = c.report;
  const g = r ? r.grade : null;
  const base = { ...c, word: null, tier: null, sort: null, coverage: null, job: null };
  if (r && !r.needs_text && g && (g.status === 'firm' || g.status === 'range')) {
    const s = g.status === 'range' ? { status: 'range', low: g.low, high: g.high } : { status: 'scored', value: g.value };
    return { ...base, kind: g.status === 'range' ? 'range' : 'grade', value: g.display, word: anchorText(anchorsOf(index), s), tier: scoreTier(g.status === 'range' ? g.low : g.value), sort: g.status === 'range' ? g.low : g.value };
  }
  if (r && r.needs_text) return { ...base, kind: 'pdf', value: 'PDF' };
  if (r && g && g.status === 'withheld') return { ...base, kind: 'withheld', value: 'Withheld', coverage: typeof g.coverage_pct === 'number' ? g.coverage_pct : null };
  if (r) return { ...base, kind: 'nograde', value: 'No grade' };
  const prov = c.provider || 'claude';
  const job = p && p.research && p.research.providers ? p.research.providers[prov] : null;
  const key = jobKey(job, null, { onHold: holdOf(index, prov) });
  if (key && RESEARCH_STATE[key]) return { ...base, kind: 'job', job: key, value: RESEARCH_STATE[key].short };
  if (holdOf(index, prov)) return { ...base, kind: 'hold', value: 'On hold' };
  return { ...base, kind: 'none', value: 'Not researched' };
}

// The three-model consensus (Claude, GPT, Gemini): a mark each (graded,
// waiting, withheld, a problem, on hold or none), the words, and the spread
// between the firm grades. Agreement is not independent confirmation, and
// nothing here is averaged.
export function consensusOf(p, index = null) {
  const models = PROVIDERS.map((prov) => {
    const r = p && p.providers ? p.providers[prov] : null;
    const job = p && p.research && p.research.providers ? p.research.providers[prov] : null;
    const hold = holdOf(index, prov);
    const key = jobKey(job, null, { onHold: hold });
    const g = r && !r.broken && !r.needs_text ? r.grade : null;
    const out = { provider: prov, label: PROVIDER_SHORT[prov], name: PROVIDER_LABELS[prov], value: null, low: null, high: null, report_id: r && !r.broken ? r.report_id : null };
    if (g && g.status === 'firm') return { ...out, mark: 'graded', words: g.display, value: g.value };
    if (g && g.status === 'range') return { ...out, mark: 'graded', words: g.display, low: g.low, high: g.high };
    if (g && g.status === 'withheld') return { ...out, mark: 'withheld', words: `withheld${typeof g.coverage_pct === 'number' ? ` (${g.coverage_pct}% scored)` : ''}` };
    if (r && r.needs_text) return { ...out, mark: 'withheld', words: 'PDF only' };
    if (r && !r.broken) return { ...out, mark: 'withheld', words: 'no grade' };
    if (key && JOB_WAITING.has(key)) return { ...out, mark: 'waiting', words: key === 'waiting' ? 'waiting for you' : key === 'interrupted' ? 'paused' : RESEARCH_STATE[key].short.toLowerCase() };
    if (key && JOB_PROBLEM.has(key)) return { ...out, mark: 'problem', words: RESEARCH_STATE[key].short.toLowerCase() };
    if (hold || key === 'on_hold') return { ...out, mark: 'hold', words: 'on hold' };
    return { ...out, mark: 'none', words: 'no report' };
  });
  const firm = models.filter((m) => typeof m.value === 'number').map((m) => m.value);
  const spread = firm.length >= 2 ? Math.round((Math.max(...firm) - Math.min(...firm)) * 10) / 10 : null;
  const ranged = models.some((m) => m.low !== null);
  const text = `${models.map((m) => `${m.label} ${m.words}`).join(' · ')}${spread !== null ? ` · spread ${spread.toFixed(1)}${ranged ? ' (firm grades only)' : ''}` : ''}`;
  return { models, spread, text };
}

// The Risk cell (one waterfall, §3.1): the highest-severity signal available
// (a forensic outcome when an audit exists, the canonical report's top
// downside score, a GoPlus contract flag), ties broken in that order; "Not
// audited" when none exists. Never blank, never green by default. Every
// signal found is in its title, so the one shown hides none.
const FX_WORDS = { liquidity_impairment: 'Liquidity impaired', operational_degradation: 'Operations degraded', delivery_inactivity: 'Delivery inactive', confirmed_discontinuation: 'Discontinued' };
const FX_SHORT = { liquidity_impairment: 'liquidity', operational_degradation: 'operations', delivery_inactivity: 'delivery', confirmed_discontinuation: 'discontinuation' };
const SEV = { bad: 3, warn: 2, neutral: 1 };
export function riskSignals(p, index = null) {
  const out = [];
  const f = p && p.forensic;
  if (f && f.audited && f.states) {
    const states = Object.entries(f.states);
    const occurred = states.filter(([, s]) => s === 'occurred');
    const watch = states.filter(([, s]) => s === 'watch');
    if (occurred.length) out.push({ kind: 'forensic', tone: 'bad', text: FX_WORDS[occurred[0][0]], more: occurred.length - 1, title: `Forensic outcome now: ${occurred.map(([k]) => FX_WORDS[k].toLowerCase()).join(', ')}` });
    else if (watch.length) out.push({ kind: 'forensic', tone: 'warn', text: `Watch: ${FX_SHORT[watch[0][0]]}`, more: watch.length - 1, title: `Forensic outcome on watch: ${watch.map(([k]) => FX_SHORT[k]).join(', ')}` });
    else out.push({ kind: 'forensic', tone: 'neutral', text: 'Audited · no outcome now', more: 0, title: `Forensic states: ${states.map(([k, s]) => `${FX_SHORT[k]} ${String(s).replace(/_/g, ' ')}`).join(', ')}` });
  } else if (f && f.open_audit) {
    out.push({ kind: 'forensic', tone: 'neutral', text: 'Audit open', more: 0, title: `Forensic audit ${f.open_audit.audit_id}: investigator ${f.open_audit.investigator || 'waiting'}; no assessment saved yet` });
  }
  const c = canonicalOf(p);
  const risks = c.report && Array.isArray(c.report.top_risks) ? c.report.top_risks.filter((r) => r && (r.status === 'scored' || r.status === 'range')) : [];
  if (risks.length) {
    const labels = Object.fromEntries(((index && index.rubrics && index.rubrics.grading && index.rubrics.grading.risk_scores) || []).map((x) => [x.id, x.label]));
    const hi = (r) => (r.status === 'range' ? r.high : r.value);
    const top = risks.slice().sort((a, b) => hi(b) - hi(a))[0];
    const v = hi(top);
    out.push({ kind: 'downside', tone: v >= 70 ? 'bad' : v >= 50 ? 'warn' : 'neutral', text: `Downside ${top.status === 'range' ? `${top.low}–${top.high}` : top.value}`, value: top.status === 'range' ? `${top.low}–${top.high}` : String(top.value), label: labels[top.id] || top.id, more: 0, title: `${labels[top.id] || top.id}: ${top.status === 'range' ? `${top.low} to ${top.high}` : top.value} of 100 (higher is worse), from ${c.source === 'headline' ? 'your headline report' : "Claude's report"}` });
  }
  const m = contractChipModel(p && p.screening);
  if (m.state !== 'native_chain') {
    const byKey = Object.fromEntries(m.badges.map((b) => [b.key, b]));
    const severe = byKey.severe || byKey.alert;
    const watchFlags = ['mint', 'blacklist', 'proxy'].filter((k) => byKey[k] && byKey[k].state === 'present').map((k) => byKey[k].label);
    const tax = byKey.tax && byKey.tax.tone !== 'plain' ? byKey.tax : null;
    if (severe) out.push({ kind: 'goplus', tone: 'bad', text: severe.key === 'alert' ? 'Contract changed' : severe.label, more: 0, title: `GoPlus: ${severe.title || severe.label}` });
    else if (tax && tax.tone === 'severe') out.push({ kind: 'goplus', tone: 'bad', text: `Tax ${tax.value}`, more: 0, title: `GoPlus: sell tax ${tax.value}` });
    else if (watchFlags.length || tax) out.push({ kind: 'goplus', tone: 'warn', text: [...watchFlags, tax ? `Tax ${tax.value}` : null].filter(Boolean).slice(0, 2).join(' · '), more: Math.max(0, watchFlags.length + (tax ? 1 : 0) - 2), title: `GoPlus: ${[...watchFlags.map((w) => `${w}: yes`), tax ? `sell tax ${tax.value}` : null].filter(Boolean).join(', ')}` });
  }
  return out;
}

export function riskCell(p, index = null) {
  const all = riskSignals(p, index);
  if (!all.length) return { kind: 'none', tone: 'unknown', text: 'Not audited', more: 0, rank: 0, title: 'No forensic audit, no downside score in the report and no GoPlus flag on record. Nothing here means safe.', signals: [] };
  const order = { forensic: 0, downside: 1, goplus: 2 };
  const top = all.slice().sort((a, b) => (SEV[b.tone] - SEV[a.tone]) || (order[a.kind] - order[b.kind]))[0];
  return { ...top, rank: SEV[top.tone] * 10 + (2 - order[top.kind]), title: all.map((s) => s.title).join('\n'), signals: all };
}

// The "Exit @ $500" cell (D2: in the Columns picker, off by default): the
// estimated cost of selling your exit size against your limit, from the
// forensic monitor's quotes or pool reserves. A lower bound ("at least") over
// the limit counts as over; under it, it says nothing. Unknown is the norm.
export function exitCell(p) {
  const f = p && p.forensic;
  const x = f && f.exit;
  const size = (x && x.size_usd) || (f && f.position_usd) || 500;
  const limit = (x && x.limit_pct) || (f && f.limit_pct) || 5;
  if (!x) return { text: 'Unknown', tone: 'unknown', sort: null, size, limit, title: f ? `No exit estimate at $${size}` : 'Not audited: no exit quote or pool reserves on record' };
  if (x.status === 'no_route') return { text: 'No route', tone: 'bad', sort: 1000, size, limit, title: `No route for a $${size} exit${x.as_of ? ` (${fmtDateTime(x.as_of)})` : ''}` };
  if (typeof x.cost_pct !== 'number') return { text: 'Unknown', tone: 'unknown', sort: null, size, limit, title: x.note || `No supported estimate at $${size}` };
  const pct = `${x.cost_complete === false ? '≥ ' : ''}${x.cost_pct.toFixed(2)}%`;
  const tone = x.beyond === true ? 'bad' : x.beyond === false ? 'ok' : 'unknown';
  const stale = x.status === 'stale';
  // The figure's basis in a word: an executable quote at that size, or a
  // constant-product pool's own reserves (never a USD liquidity figure).
  const basis = x.method === 'executable_quote' ? { word: 'Quote', long: x.route_scope === 'aggregator' ? 'an aggregator\'s executable quote' : 'an executable quote at one venue' } : x.method === 'constant_product' ? { word: 'Reserve est.', long: 'a constant-product pool\'s reserves' } : null;
  return { text: pct, tone: stale && tone !== 'bad' ? 'unknown' : tone, sort: x.cost_pct, size, limit, stale, basis: basis ? basis.word : null, title: `$${size} exit: ${x.cost_complete === false ? `at least ${x.cost_pct.toFixed(2)}% (${(x.missing_costs || []).join(' and ') || 'some costs'} unknown)` : `${x.cost_pct.toFixed(2)}%`} against your ${limit}% limit${basis ? `, from ${basis.long}` : ''}${x.as_of ? `, ${fmtDateTime(x.as_of)}` : ''}${stale ? ' (stale)' : ''}` };
}

// Jobs in progress or waiting on a model (or on you, for manual research);
// a model on hold has none.
export function waitingJobs(p, index = null) {
  const out = [];
  for (const prov of PROVIDERS) {
    const job = p && p.research && p.research.providers ? p.research.providers[prov] : null;
    if (!job) continue;
    const key = jobKey(job, null, { onHold: holdOf(index, prov) });
    if (key && JOB_WAITING.has(key)) out.push({ provider: prov, key });
  }
  return out;
}

// D3, the one "Needs review" unit (Eric, 2026-10-17): projects. A project
// counts once when anything needs you: changes since your last review, a
// review of yours due or overdue, or research waiting for you.
export function reviewReasons(p, index = null, agendaRow = null) {
  if (!p || p.broken || p.status === 'archived') return [];
  const out = [];
  const n = p.changes && p.changes.item_count;
  if (n > 0) out.push({ kind: 'changed', words: `${n} change${n === 1 ? '' : 's'} since ${p.changes.cursor_source === 'project created' ? 'added' : 'your last review'}` });
  const nr = p.next_review;
  if (nr && nr.date && (nr.overdue || nr.date <= todayOf(index))) out.push({ kind: 'due', words: nr.overdue ? `Review overdue since ${fmtDate(nr.date)}` : 'Review due today' });
  // The agenda's primary item when it is due (GET /api/agenda); without the
  // agenda, the forensic evidence changes the index counts stand in for it.
  const f = p.forensic;
  const ag = agendaRow && agendaRow.primary && agendaRow.primary.due && !agendaRow.primary.completed && !agendaRow.primary.snoozed ? agendaRow.primary : null;
  if (ag && !(ag.kind === 'owner_review' && out.some((r) => r.kind === 'due'))) out.push({ kind: 'due', words: ag.title, item: ag });
  else if (!agendaRow && f && f.to_review) out.push({ kind: 'due', words: `${f.to_review} forensic evidence change${f.to_review === 1 ? '' : 's'} to review` });
  const mine = waitingJobs(p, index).filter((j) => j.key === 'waiting');
  if (mine.length) out.push({ kind: 'waiting', words: `${mine.map((j) => PROVIDER_LABELS[j.provider]).join(', ')} research waiting for you` });
  if (f && f.open_audit && f.open_audit.investigator === 'waiting') out.push({ kind: 'waiting', words: 'Forensic audit waiting for Claude' });
  const differ = ((index && index.attention) || []).find((a) => a.project_id === p.project_id && a.kind === 'disagreement');
  if (differ) out.push({ kind: 'differ', words: String(differ.title).replace(`${p.name}: `, '') });
  return out;
}

// One project's row in the agenda (GET /api/agenda), or null.
const agendaMaps = new WeakMap();
export function agendaRowOf(agenda, pid) {
  if (!agenda || !Array.isArray(agenda.rows)) return null;
  let m = agendaMaps.get(agenda);
  if (!m) { m = new Map(agenda.rows.map((r) => [r.project_id, r])); agendaMaps.set(agenda, m); }
  return m.get(pid) || null;
}

// The Action verb (pinned, on hover): one verb for the state the project is in.
export function actionOf(p, index = null, agenda = null) {
  if (!p) return null;
  if (p.status === 'archived') return { verb: 'Restore', kind: 'restore' };
  if (p.identity_status !== 'verified') return { verb: 'Complete identity', kind: 'identity' };
  const paused = waitingJobs(p, index).find((j) => j.key === 'interrupted');
  if (paused) return { verb: 'Resume', kind: 'resume', provider: paused.provider };
  if (reviewReasons(p, index, agendaRowOf(agenda, p.project_id)).length) return { verb: 'Review', kind: 'review' };
  const any = PROVIDERS.some((x) => (p.providers && p.providers[x]) || (p.research && p.research.providers && p.research.providers[x]));
  if (!any) return { verb: 'Research', kind: 'research' };
  return { verb: 'Open', kind: 'open' };
}

// The Last research cell: the age of the latest report's analysis, amber once
// a suggested review date (yours or the canonical report's) has passed.
export function lastResearchCell(p, index = null) {
  const at = p && p.last_report_at;
  if (!at) return { text: 'Never', tone: 'unknown', sort: null, title: 'No report saved yet' };
  const today = todayOf(index);
  const days = daysFrom(at, today);
  const c = canonicalOf(p).report;
  const suggested = c && c.position && c.position.next_review_date ? c.position.next_review_date : null;
  const passed = Boolean((suggested && suggested < today) || (p.next_review && p.next_review.overdue));
  const text = days === null ? fmtDate(at) : days <= 0 ? 'Today' : days < 60 ? `${days}d` : `${Math.round(days / 30)}mo`;
  return { text, tone: passed ? 'warn' : '', sort: at, title: `Latest analysis ${fmtDate(at)}${suggested ? `; suggested review ${fmtDate(suggested)}${suggested < today ? ' (passed)' : ''}` : ''}${p.next_review ? `; your review ${fmtDate(p.next_review.date)}${p.next_review.overdue ? ' (overdue)' : ''}` : ''}` };
}

// The Desk's KPI strip (§3.1): one panel split by hairlines into five cells.
export function deskKpis(index, agenda = null) {
  const live = ((index && index.projects) || []).filter((p) => !p.broken && p.status !== 'archived');
  const mc = index && index.market_context;
  const snap = mc && mc.snapshot && mc.snapshot.bitcoin && typeof mc.snapshot.bitcoin.price_usd === 'number' ? mc.snapshot : null;
  const b30 = snap && snap.breadth ? snap.breadth.d30 : null;
  const review = live.filter((p) => reviewReasons(p, index, agendaRowOf(agenda, p.project_id)).length);
  const jobs = live.flatMap((p) => waitingJobs(p, index).map((j) => ({ ...j, project_id: p.project_id })));
  return {
    market: snap ? { btc: snap.bitcoin.price_usd, change_7d: snap.bitcoin.change_7d_pct ?? null, dominance: snap.dominance && typeof snap.dominance.btc_pct === 'number' ? snap.dominance.btc_pct : null, stale: mc.status === 'stale', demo: snap.provider === 'fictional-demo' } : null,
    total: snap && snap.total_market && typeof snap.total_market.market_cap_usd === 'number' ? { usd: snap.total_market.market_cap_usd, change_24h: snap.total_market.market_cap_change_24h_pct ?? null } : null,
    beat: b30 && typeof b30.beating_btc === 'number' ? { n: b30.beating_btc, of: b30.counted, share: typeof b30.share_pct === 'number' ? b30.share_pct : null, words: breadthWords(b30) } : null,
    review: { projects: review.length, ids: review.map((p) => p.project_id) },
    waiting: { jobs: jobs.length, projects: new Set(jobs.map((j) => j.project_id)).size },
  };
}

// The sticky footer: "48 projects · 2 held · $17,294 priced value".
export function deskFooter(index, shown) {
  const pf = index && index.portfolio && index.portfolio.totals;
  const held = shown.filter((p) => p.held).length;
  const priced = pf && typeof pf.value_priced_usd === 'number' ? pf.value_priced_usd : null;
  return { projects: shown.length, held, priced, unpriced: pf ? pf.unpriced_count || 0 : 0 };
}
