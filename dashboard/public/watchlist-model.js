// The watchlist's rules, apart from any drawing: its columns and sort names,
// the saved preferences, which projects a filter shows and in what order,
// the strings every market figure reads as, each model's cell, what needs
// action and what waits for review, the contract checks in brief, and the
// review order. Pure: the React watchlist and inspector (dashboard/web) draw
// from it and the tests check it.
import {
  PROVIDERS, PROVIDER_LABELS, marketFigure, fmtPrice, fmtChangePct, fmtMarketFigure, fmtCompactUsd,
  fmtDate, fmtDateTime, fmtAgo, onHoldOf,
} from './ui.js';

// Column catalogue, in the CoinMarketCap order: # (rank, drawn before the
// name), price, 24h, 7d and 30d change, market cap, volume, the 7-day chart,
// then the three models. Optional columns (off at first) sit before the
// models. When the list is narrower than its columns, the least essential
// give way; every value stays in the inspector.
export const COLUMNS = [
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

export const SORT_NAMES = {
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
export const DEFAULT_FILTERS = { sector: '', owned: 'watching', coverage: 'any', ret30: 'any', archived: false };
export const DEFAULT_SORT = { key: 'rank', dir: 'asc' };
export const COVERAGE = [['any', 'Any coverage'], ['all3', 'Graded by all three models'], ['missing', 'Missing a model grade'], ['none', 'No research yet'], ['attention', 'Failed or withheld']];
export const RET30 = [['any', 'Any'], ['pos', 'Positive'], ['neg', 'Negative']];
export const OWNED = [['watching', 'Watching'], ['off', 'Not watching'], ['all', 'All']];
export const PREFS_VERSION = 3;

// The saved preferences (config/ui-state.json, key "watchlist"), read through
// ctx.ui.get. Columns saved before the CoinMarketCap layout (v3) start from
// its defaults; sort and filters are kept.
export function prefs(ctx) {
  const saved = ctx.ui.get('watchlist', {}) || {};
  const keepCols = Array.isArray(saved.columns) && saved.v >= 3;
  const cols = keepCols ? COLUMNS.filter((x) => saved.columns.includes(x.id) && !x.disabled).map((x) => x.id) : COLUMNS.filter((c) => c.def).map((c) => c.id);
  if (!cols.includes('research')) cols.push('research');
  const filters = { ...DEFAULT_FILTERS, ...(saved.filters || {}) };
  // Version 1 only: there, "all" was the old default, not a choice.
  if (!(saved.v >= 2) && filters.owned === 'all') filters.owned = DEFAULT_FILTERS.owned;
  if (!OWNED.some(([v]) => v === filters.owned)) filters.owned = DEFAULT_FILTERS.owned;
  return { columns: cols, sort: saved.sort && SORT_NAMES[saved.sort.key] ? saved.sort : DEFAULT_SORT, filters };
}

export function prefsToSave(p) {
  return { v: PREFS_VERSION, columns: p.columns, sort: p.sort, filters: p.filters };
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

// How many filters are on, beyond the watching choice.
export function filterCount(f) {
  return [f.sector, f.coverage !== 'any', f.ret30 !== 'any', f.archived].filter(Boolean).length;
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
