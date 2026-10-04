// The technical chart in the project inspector: TradingView's Advanced Chart,
// embedded as the same frame TradingView's own embed script creates
// (https://www.tradingview-widget.com/embed-widget/advanced-chart/), without
// running any TradingView script in this page. The page's
// Content-Security-Policy allows that one frame origin (server.js); the frame
// cannot reach this page, its sign-in or its records.
//
// Nothing is fetched from TradingView until the section is opened. It stays
// open as you left it while you move between projects (J/K). At most one frame
// exists: it is removed when you close the section, move to another project or
// symbol, or close the inspector, however it closes. A live redraw keeps the
// same frame (watchlist.js moves it with Node.moveBefore where the browser can,
// so it does not reload).
//
// Symbol: the one set on the project record (chart_symbol, EXCHANGE:PAIR as
// TradingView writes it), else a guess from the ticker on Binance against
// USDT, marked as a guess: the same ticker can belong to another token.
import { h, button, toast } from '../ui.js';

const WIDGET = 'https://www.tradingview-widget.com/embed-widget/advanced-chart/';
// Quick J/K presses never load a frame for every project passed on the way.
const MOUNT_DELAY_MS = 200;
// The same rule as the project record's (core/projects.js).
export const CHART_SYMBOL_RE = /^[A-Z0-9_]{1,20}:[A-Z0-9_.!-]{1,40}$/;

// The symbol a project's chart shows, and where it comes from:
//   set      chart_symbol on the project record
//   ticker   guessed from the ticker on Binance against USDT
//   null     no ticker on record: no chart
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

// The desk's theme as the chart takes it: dark only when the desk is dark.
function deskTheme() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'dark') return 'dark';
  if (t === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  return 'light';
}

// The desk's paper color (the --bg token) for the chart's toolbar.
function deskPaper() {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || null;
  } catch (_) {
    return null;
  }
}

// The one chart that exists, and whether you last left the section open.
let current = null;
let wantOpen = false;
let watcher = null;

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

function mount(c) {
  if (current !== c || !c.el.open || c.frame) return;
  // Not in the page yet (its slot is still being filled): try again shortly,
  // for a few seconds at most.
  if (!c.el.isConnected) {
    if ((c.tries = (c.tries || 0) + 1) <= 25) schedule(c);
    return;
  }
  const f = document.createElement('iframe');
  f.className = 'tv-frame';
  f.title = `TradingView chart of ${c.symbol}`;
  f.setAttribute('src', widgetUrl(widgetSettings(c.symbol, { theme: c.theme, toolbarBg: deskPaper() })));
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
  return h('div', { class: 'tv-foot' }, h('div', { class: 'tv-foot-row' }, toggle), form);
}

// The section for one project: the same element as long as the project,
// symbol and theme are the same, so a redraw keeps its frame.
export function technicalChart(ctx, project) {
  const s = chartSymbol(project);
  if (!s.symbol) {
    releaseChart();
    return null;
  }
  const theme = deskTheme();
  const key = `${project.project_id}|${s.symbol}|${theme}`;
  if (current && current.key === key) return current.el;
  releaseChart();
  watchClose();
  const guess = s.source === 'ticker';
  const box = h('div', { class: 'tv-box' });
  const el = h('details', { class: 'disclosure tvchart', dataset: { key: 'insp-chart' } },
    h('summary', { title: 'TradingView · daily candles, UTC', 'aria-label': `Technical chart: ${s.symbol}${guess ? ', guessed from the ticker' : ''}. Opens a TradingView chart of daily candles, UTC.` },
      h('span', null, 'Technical chart'),
      h('span', { class: 'tv-sym mono', 'aria-hidden': 'true' }, s.symbol),
      guess ? h('span', { class: 'tv-guess', 'aria-hidden': 'true', title: 'Guessed from the ticker on Binance; the same ticker can be another token. Set the symbol to confirm it.' }, 'guess') : null),
    h('div', { class: 'body' }, h('div', { class: 'tv-card' }, box), symbolForm(ctx, project, s)));
  const c = { key, el, box, symbol: s.symbol, theme, frame: null, timer: null };
  el.addEventListener('toggle', () => {
    if (current !== c) return;
    wantOpen = el.open;
    if (el.open) schedule(c);
    else unmount(c);
  });
  current = c;
  // Left open on the last project: open here too, without waiting for the
  // toggle event (a browser may not send one before the section is in the page).
  if (wantOpen) {
    el.open = true;
    schedule(c);
  }
  return el;
}
