// The technical chart in the project inspector, from one of two sources:
//   TradingView  its Advanced Chart, embedded as the same frame TradingView's
//                own embed script creates
//                (https://www.tradingview-widget.com/embed-widget/advanced-chart/),
//                without running any TradingView script in this page
//   DexScreener  the chart of the recorded contract's deepest DEX pool
//                (https://dexscreener.com/<chain>/<pool>?embed=1), for a token
//                that trades mainly on DEXs (views/dex.js finds the pool)
// The page's Content-Security-Policy allows those two frame origins
// (server.js); a frame cannot reach this page, its sign-in or its records.
//
// Nothing is fetched from either until the section is opened. It stays open
// as you left it while you move between projects (J/K). At most one frame
// exists: it is removed when you close the section, move to another project,
// symbol or source, or close the inspector, however it closes. A live redraw
// keeps the same frame (watchlist.js moves it with Node.moveBefore where the
// browser can, so it does not reload).
//
// Which source:
//   1. the one you switched to for this project, in this page session
//   2. TradingView when the project record sets its symbol (chart_symbol,
//      EXCHANGE:PAIR as TradingView writes it)
//   3. DexScreener when the recorded contract has a DEX pool and at least
//      half of the token's 24h volume (CoinGecko's, CEXs and DEXs together)
//      is in its DEX pools, or CoinGecko has no volume for it
//   4. TradingView from a guess on the ticker (Binance against USDT), marked
//      as an unverified guess: the same ticker can belong to another token
import { h, button, toast } from '../ui.js';
import { dexTargets, peekLookup, lookupTargets, onLookup, sameTargets, topPool, deskPrice, DEX_CHAINS, DEX_MAIN_SHARE } from './dex.js';

const WIDGET = 'https://www.tradingview-widget.com/embed-widget/advanced-chart/';
// Quick J/K presses never load a frame for every project passed on the way.
const MOUNT_DELAY_MS = 200;
// The same rule as the project record's (core/projects.js).
export const CHART_SYMBOL_RE = /^[A-Z0-9_]{1,20}:[A-Z0-9_.!-]{1,40}$/;

// The symbol a project's TradingView chart shows, and where it comes from:
//   set      chart_symbol on the project record
//   ticker   guessed from the ticker on Binance against USDT
//   null     no ticker on record: no TradingView chart
export function chartSymbol(project) {
  const set = project && typeof project.chart_symbol === 'string' ? project.chart_symbol.trim().toUpperCase() : '';
  if (CHART_SYMBOL_RE.test(set)) return { symbol: set, source: 'set' };
  const ticker = project && project.symbol ? String(project.symbol).toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
  if (!ticker) return { symbol: null, source: null };
  return { symbol: `BINANCE:${ticker}USDT`, source: 'ticker' };
}

// The other usual pairs for a ticker, offered when setting the symbol.
export function symbolSuggestions(project) {
  const ticker = project && project.symbol ? String(project.symbol).toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
  return ticker ? [`BINANCE:${ticker}USDT`, `COINBASE:${ticker}USD`, `MEXC:${ticker}USDT`] : [];
}

// The widget's settings: a daily candlestick chart in UTC, on the desk's theme.
export function widgetSettings(symbol, { theme = 'light', toolbarBg = null } = {}) {
  return {
    autosize: true,
    symbol,
    interval: 'D',
    timezone: 'Etc/UTC',
    theme,
    style: '1',
    locale: 'en',
    ...(toolbarBg ? { toolbar_bg: toolbarBg } : {}),
    enable_publishing: false,
    hide_side_toolbar: false,
    allow_symbol_change: true,
    save_image: false,
  };
}

// The frame's address, built as TradingView's embed script builds it: the
// locale in the query, every other setting as JSON in the hash (never this
// page's address).
export function widgetUrl(settings) {
  const { locale = 'en', ...rest } = settings;
  const url = new URL(WIDGET);
  url.searchParams.set('locale', locale);
  url.hash = encodeURIComponent(JSON.stringify(rest));
  return url.toString();
}

// DexScreener's embedded chart of one pool, without its trades and info
// panels: daily candles like the TradingView chart, the page and the chart
// itself on the desk's theme (chartTheme; without it the chart is dark). Null
// for a pool it cannot be built for.
export function dexEmbedUrl(pool, theme = 'light') {
  if (!pool || typeof pool.pairAddress !== 'string' || !/^[A-Za-z0-9]{20,100}$/.test(pool.pairAddress) || !DEX_CHAINS.some((x) => x.slug === pool.slug)) return null;
  const t = theme === 'dark' ? 'dark' : 'light';
  const url = new URL(`https://dexscreener.com/${pool.slug}/${pool.pairAddress}`);
  url.searchParams.set('embed', '1');
  url.searchParams.set('theme', t);
  url.searchParams.set('trades', '0');
  url.searchParams.set('info', '0');
  url.searchParams.set('chartTheme', t);
  url.searchParams.set('interval', '1D');
  return url.toString();
}

// The share of the token's 24h volume in its DEX pools: every pool's 24h
// volume on DexScreener over CoinGecko's 24h volume, or null when either is
// unknown. Pure.
export function dexShare(pool, cgVolume) {
  if (!pool || typeof pool.volume24hAll !== 'number' || typeof cgVolume !== 'number' || !(cgVolume > 0)) return null;
  return pool.volume24hAll / cgVolume;
}

// Which source the chart shows (the order at the top of this file), or null
// when it has none. Pure.
export function chooseSource({ tv, pool = null, share = null, choice = null }) {
  const hasTv = Boolean(tv && tv.symbol);
  const hasDex = Boolean(pool && dexEmbedUrl(pool));
  if (choice === 'dexscreener' && hasDex) return 'dexscreener';
  if (choice === 'tradingview' && hasTv) return 'tradingview';
  if (hasTv && tv.source === 'set') return 'tradingview';
  if (hasDex && (share === null || share >= DEX_MAIN_SHARE)) return 'dexscreener';
  if (hasTv) return 'tradingview';
  return hasDex ? 'dexscreener' : null;
}

// The desk's theme as the chart takes it: dark only when the desk is dark.
function deskTheme() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'dark') return 'dark';
  if (t === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  return 'light';
}

// The desk's paper color (the --bg token) for TradingView's toolbar.
function deskPaper() {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || null;
  } catch (_) {
    return null;
  }
}

// The one chart that exists, whether you last left the section open, and
// the source you switched each project to in this page session.
let current = null;
let wantOpen = false;
let watcher = null;
const choices = new Map();

function unmount(c) {
  if (!c) return;
  clearTimeout(c.timer);
  c.timer = null;
  if (c.frame) {
    // Blank first, so the browser lets go of the chart's page at once.
    c.frame.setAttribute('src', 'about:blank');
    c.frame.remove();
    c.frame = null;
  }
}

// Drops the chart, its frame and its timer.
export function releaseChart() {
  unmount(current);
  current = null;
}

// The DEX pool lookup answered (the card at the top of the inspector asks
// it): the chart takes the pool, and the source it now has.
function takeAnswer(c, answer) {
  if (current !== c) return;
  const pool = topPool(answer, c.dex, { refPrice: c.refPrice });
  c.pool = pool && dexEmbedUrl(pool) ? pool : null;
  c.share = dexShare(c.pool, c.cgVolume);
  setSource(c, chooseSource({ tv: c.tv, pool: c.pool, share: c.share, choice: choices.get(c.pid) || null }));
}

onLookup((targets, answer) => {
  if (current && current.dex.length && sameTargets(current.dex, targets)) takeAnswer(current, answer);
});

function setSource(c, next) {
  if (c.source !== next) {
    unmount(c);
    c.source = next;
  }
  paint(c);
  if (c.el.open && !c.frame) schedule(c);
}

// Opening the section is a request for the chart: when the DEX lookup has
// not answered yet, it is asked now (once), and the chart waits for it.
function ask(c) {
  c.box.replaceChildren(h('p', { class: 'tv-wait' }, 'Looking up the DEX pool…'));
  if (c.asking) return;
  c.asking = true;
  lookupTargets(c.dex).then((answer) => takeAnswer(c, answer), () => {
    if (current !== c) return;
    c.pool = null;
    setSource(c, chooseSource({ tv: c.tv, choice: choices.get(c.pid) || null }));
  });
}

function mount(c) {
  if (current !== c || !c.el.open || c.frame) return;
  // Not in the page yet (its slot is still being filled): try again shortly,
  // for a few seconds at most.
  if (!c.el.isConnected) {
    if ((c.tries = (c.tries || 0) + 1) <= 25) schedule(c);
    return;
  }
  if (c.source === 'pending') {
    ask(c);
    return;
  }
  if (!c.source) {
    c.box.replaceChildren(h('p', { class: 'tv-wait' }, 'No chart: no DEX pool is indexed for this contract and there is no ticker.'));
    return;
  }
  const f = document.createElement('iframe');
  f.className = 'tv-frame';
  if (c.source === 'dexscreener') {
    f.title = `DexScreener chart of ${c.pool.pair} on ${c.pool.dex}`;
    f.setAttribute('src', dexEmbedUrl(c.pool, c.theme));
  } else {
    f.title = `TradingView chart of ${c.tv.symbol}`;
    f.setAttribute('src', widgetUrl(widgetSettings(c.tv.symbol, { theme: c.theme, toolbarBg: deskPaper() })));
  }
  f.setAttribute('referrerpolicy', 'no-referrer');
  f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  f.setAttribute('allowtransparency', 'true');
  f.setAttribute('frameborder', '0');
  f.setAttribute('scrolling', 'no');
  c.box.replaceChildren(f);
  c.frame = f;
}

function schedule(c) {
  clearTimeout(c.timer);
  c.timer = setTimeout(() => mount(c), MOUNT_DELAY_MS);
}

// The inspector closing (any way: its button, Escape, Back, another page)
// removes its panel: the chart goes with it.
function watchClose() {
  if (watcher || typeof MutationObserver === 'undefined') return;
  const root = document.getElementById('panel-root');
  if (!root) return;
  watcher = new MutationObserver(() => {
    if (current && !current.el.isConnected) releaseChart();
  });
  watcher.observe(root, { childList: true, subtree: true });
}

// Setting the symbol on the project record (or clearing it, back to the
// ticker guess). The redraw that follows shows the new chart.
function symbolForm(ctx, project, s) {
  const pid = project.project_id;
  const listId = `tv-sym-list-${pid}`;
  const input = h('input', { type: 'text', class: 'mono', value: project.chart_symbol || '', placeholder: symbolSuggestions(project)[0] || 'BINANCE:BTCUSDT', list: listId, title: 'Chart symbol, as TradingView writes it (EXCHANGE:PAIR)', 'aria-label': 'Chart symbol, as TradingView writes it (EXCHANGE:PAIR)', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'characters', dataset: { key: `tv-sym-${pid}` } });
  const save = async (value) => {
    const v = value ? String(value).trim().toUpperCase() : null;
    if (v && !CHART_SYMBOL_RE.test(v)) {
      toast('Write it as TradingView does: EXCHANGE:PAIR, for example BINANCE:ONDOUSDT.', 'bad');
      return;
    }
    try {
      await ctx.api.post(`/api/projects/${encodeURIComponent(pid)}/fields`, { chart_symbol: v });
      toast(v ? `Chart symbol set: ${v}.` : 'Chart symbol cleared; the chart guesses from the ticker again.');
      await ctx.refresh();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  const form = h('form', { class: 'tv-set', onsubmit: (e) => { e.preventDefault(); save(input.value); } },
    input,
    h('datalist', { id: listId }, symbolSuggestions(project).map((x) => h('option', { value: x }))),
    h('button', { type: 'submit', class: 'small', dataset: { key: `tv-save-${pid}` } }, 'Save'),
    s.source === 'set' ? button('Clear', () => save(null), { kind: 'small quiet', key: `tv-clear-${pid}` }) : null);
  form.hidden = true;
  const toggle = button(s.source === 'set' ? 'Change symbol' : 'Set symbol', () => {
    form.hidden = !form.hidden;
    if (!form.hidden) input.focus();
  }, { kind: 'link small', key: `tv-set-${pid}` });
  const reveal = () => {
    form.hidden = false;
    input.focus();
  };
  return { toggle, form, reveal };
}

// The summary and the source switch, for the source the chart now has.
const GUESS_TITLE = 'Unverified: guessed from the ticker on Binance, and the same ticker can be another token. Not research evidence. Set the symbol to confirm it.';
function paint(c) {
  const dex = c.source === 'dexscreener';
  const guess = !dex && c.tv.source === 'ticker';
  // The source beside the title; the pool as a label, or the TradingView
  // symbol as a badge that opens the symbol field.
  c.src.textContent = dex ? 'DexScreener' : c.source === 'pending' ? '' : 'TradingView';
  c.sym.textContent = dex ? `${c.pool.pair} · ${c.pool.dex}` : '';
  c.sym.hidden = !dex;
  c.symBtn.textContent = dex ? '' : c.tv.symbol || '…';
  c.symBtn.hidden = dex || !c.tv.symbol;
  c.symBtn.setAttribute('aria-label', `Chart symbol ${c.tv.symbol || ''}${guess ? ', an unverified guess from the ticker' : ''}. Change it`);
  c.guess.hidden = !guess;
  c.sum.title = dex ? 'DexScreener · the deepest pool of the recorded contract' : 'TradingView · daily candles, UTC';
  c.sum.setAttribute('aria-label', dex
    ? `Technical chart: the DexScreener pool ${c.pool.pair} on ${c.pool.dex}${c.pool.multiChain ? `, ${c.pool.chain}` : ''}. Opens a DexScreener chart.`
    : `Technical chart: ${c.tv.symbol || 'no symbol'}${guess ? ', an unverified guess from the ticker' : ''}. Opens a TradingView chart of daily candles, UTC.`);
  const other = dex ? (c.tv.symbol ? 'tradingview' : null) : (c.pool ? 'dexscreener' : null);
  c.switch.hidden = !other;
  c.switch.textContent = other === 'dexscreener' ? 'DEX pool chart' : 'TradingView chart';
  c.switch.setAttribute('aria-label', other === 'dexscreener' ? `Show the DexScreener chart of ${c.pool.pair} instead` : `Show the TradingView chart of ${c.tv.symbol || ''} instead`);
}

// The section for one project: the same element as long as the project, its
// symbol, its contracts and the theme are the same, so a redraw keeps its
// frame.
export function technicalChart(ctx, project) {
  const s = chartSymbol(project);
  const t = dexTargets(project);
  const dex = t.state === 'contract' ? t.targets : [];
  if (!s.symbol && !dex.length) {
    releaseChart();
    return null;
  }
  const pid = project.project_id;
  const row = ctx && ctx.state && ctx.state.index ? ctx.state.index.projects.find((x) => x.project_id === pid) : null;
  const cgVolume = row && row.market && typeof row.market.volume_24h_usd === 'number' ? row.market.volume_24h_usd : null;
  const theme = deskTheme();
  const key = `${pid}|${s.symbol || ''}|${s.source || ''}|${dex.map((x) => x.key).join(',')}|${theme}`;
  if (current && current.key === key) {
    current.cgVolume = cgVolume;
    return current.el;
  }
  releaseChart();
  watchClose();
  const box = h('div', { class: 'tv-box' });
  const src = h('span', { class: 'tv-src', 'aria-hidden': 'true' });
  const sym = h('span', { class: 'tv-sym', 'aria-hidden': 'true' });
  const symBtn = h('button', { type: 'button', class: 'tv-symbtn', title: 'Set the TradingView symbol (EXCHANGE:PAIR)', dataset: { key: `tv-symbtn-${pid}` } });
  // A ticker guess says so: "Auto-pair · unverified" (the full words in its tooltip).
  const guess = h('span', { class: 'tv-guess', 'aria-hidden': 'true', title: GUESS_TITLE }, 'Auto-pair · unverified');
  const sum = h('summary', null, h('span', { class: 'tv-title' }, 'Technical chart'), src, h('span', { class: 'tv-right' }, sym, symBtn, guess));
  const swap = button('', null, { kind: 'link small', key: `tv-src-${pid}` });
  const { toggle, form, reveal } = symbolForm(ctx, project, s);
  // No data-key: the inspector's redraw does not save and restore this
  // section's open state (a restore from before a click would close it, and
  // its frame with it); the element itself is kept, open or closed.
  const el = h('details', { class: 'disclosure tvchart' }, sum,
    h('div', { class: 'body' }, h('div', { class: 'tv-card' }, box),
      h('div', { class: 'tv-foot' }, h('div', { class: 'tv-foot-row' }, swap, toggle), form)));
  const c = { key, pid, el, box, sum, src, sym, symBtn, guess, switch: swap, tv: s, dex, theme, cgVolume, refPrice: deskPrice(ctx, pid), frame: null, timer: null, source: null, pool: null, share: null, asking: false };
  // The symbol badge opens the section and its symbol field, without the
  // summary's own toggle closing it again.
  symBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.open = true;
    reveal();
  };
  swap.onclick = () => {
    const next = c.source === 'dexscreener' ? 'tradingview' : 'dexscreener';
    choices.set(pid, next);
    setSource(c, chooseSource({ tv: c.tv, pool: c.pool, share: c.share, choice: next }));
  };
  el.addEventListener('toggle', () => {
    if (current !== c) return;
    wantOpen = el.open;
    if (el.open) schedule(c);
    else unmount(c);
  });
  current = c;
  // The source: decided now when it can be (no contract to look up, the
  // pool already known, or your own symbol), else when the lookup answers.
  const known = dex.length ? peekLookup(dex) : null;
  if (!dex.length) c.source = 'tradingview';
  else if (known) {
    const pool = topPool(known, dex, { refPrice: c.refPrice });
    c.pool = pool && dexEmbedUrl(pool) ? pool : null;
    c.share = dexShare(c.pool, cgVolume);
    c.source = chooseSource({ tv: s, pool: c.pool, share: c.share, choice: choices.get(pid) || null });
  } else if (s.symbol && (choices.get(pid) === 'tradingview' || (s.source === 'set' && choices.get(pid) !== 'dexscreener'))) c.source = 'tradingview';
  else c.source = 'pending';
  paint(c);
  // Left open on the last project: open here too, without waiting for the
  // toggle event (a browser may not send one before the section is in the page).
  if (wantOpen) {
    el.open = true;
    schedule(c);
  }
  return el;
}
