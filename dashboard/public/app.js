// App shell: session, API client, routing, navigation, saved view state and
// live refresh. Views load on demand so one broken view never blanks the rest.
// A live refresh keeps focus, open sections, scroll positions and drafts; Back
// returns to the list position and the control that was used to leave it.
import { h, clear, toast, store, announce } from './ui.js';

const state = { token: null, session: null, index: null, projects: new Map(), dirty: false, live: false, route: null, ui: {}, renderSeq: 0, renderReason: 'nav' };

async function parse(res) {
  const type = res.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(body && body.error ? body.error : `Request failed (${res.status})`);
    err.code = body && body.code;
    err.saved = body && body.saved;
    throw err;
  }
  return body;
}

// The session token changes when the dashboard restarts. A 401 is refused
// before anything runs, so renewing the token and retrying once is safe.
async function call(path, init = {}) {
  const go = () => fetch(path, { ...init, headers: { ...(init.headers || {}), 'x-cr-token': state.token } });
  let res = await go();
  if (res.status === 401) {
    try {
      const s = await (await fetch('/api/session')).json();
      if (s && s.token && s.workspace && state.session && s.workspace.workspace_id === state.session.workspace.workspace_id) {
        state.token = s.token;
        res = await go();
      }
    } catch (_) { /* keep the 401 */ }
  }
  return res;
}

export const api = {
  async get(path) {
    return parse(await call(path));
  },
  async post(path, body) {
    return parse(await call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }));
  },
  async text(path) {
    const res = await call(path);
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return res.text();
  },
  async download(path, filename) {
    const res = await call(path);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },
};

async function loadIndex() {
  state.index = await api.get('/api/index');
  return state.index;
}

async function projectDetail(id, { fresh = false } = {}) {
  if (!fresh && state.projects.has(id)) return state.projects.get(id);
  const d = await api.get(`/api/projects/${encodeURIComponent(id)}`);
  state.projects.set(id, d);
  return d;
}

// After a write: reload data and redraw the current page in place.
async function refresh() {
  state.projects.clear();
  await loadIndex();
  state.dirty = false;
  await render({ reason: 'refresh' });
}

function navigate(hash, { replace = false } = {}) {
  if (location.hash === hash) render({ reason: 'refresh' });
  else if (replace) {
    history.replaceState(null, '', hash);
    render({ reason: 'nav' });
  } else location.hash = hash;
}

// Saved view preferences (columns, sort, filters): kept in the workspace's
// config/ui-state.json so they follow the folder, with a browser copy as a
// fallback when the server cannot be reached.
let uiTimer = null;
const ui = {
  get(key, fallback) {
    const v = state.ui[key];
    return v === undefined ? fallback : v;
  },
  set(key, value) {
    state.ui[key] = value;
    store.set('ui', state.ui);
    clearTimeout(uiTimer);
    uiTimer = setTimeout(() => api.post('/api/ui-state', state.ui).catch(() => {}), 600);
  },
};

function routeKey(route) {
  if (!route) return '';
  const q = new URLSearchParams(route.query);
  q.delete('p');
  return `${route.name}/${route.args.join('/')}?${q.toString()}`;
}

const ctx = {
  api,
  state,
  ui,
  refresh,
  navigate,
  projectDetail,
  routeKey,
  markDirty: () => {
    state.dirty = true;
  },
  // A view that moves focus on purpose (opening a panel) keeps it.
  claimFocus: () => {
    state.focusClaimed = true;
  },
  hrefWith(params) {
    const r = state.route;
    const q = new URLSearchParams(r.query);
    for (const [k, v] of Object.entries(params)) {
      if (v === null || v === undefined || v === '') q.delete(k);
      else q.set(k, v);
    }
    const qs = q.toString();
    return `#/${[r.name, ...r.args].map(encodeURIComponent).join('/')}${qs ? `?${qs}` : ''}`;
  },
};

const SECTIONS = [
  ['watchlist', 'Watchlist'],
  ['portfolio', 'Portfolio'],
  ['research', 'Research'],
  ['updates', 'Updates'],
  ['settings', 'Settings'],
];

const LOADERS = {
  watchlist: () => import('./views/watchlist.js').then((m) => m.renderWatchlist),
  project: () => import('./views/project.js').then((m) => m.renderProject),
  portfolio: () => import('./views/portfolio.js').then((m) => m.renderPortfolio),
  research: () => import('./views/research.js').then((m) => m.renderResearch),
  updates: () => import('./views/updates.js').then((m) => m.renderUpdates),
  settings: () => import('./views/settings.js').then((m) => m.renderSettings),
};

// Old addresses keep working.
const LEGACY = {
  overview: '#/watchlist',
  projects: '#/watchlist',
  holdings: '#/portfolio',
  compare: '#/research?tab=compare',
  evidence: '#/research?tab=evidence',
  calendar: '#/research?tab=calendar',
};
const LEGACY_IMPORT_TABS = { reports: '#/updates?tab=import', inbox: '#/updates?tab=inbox', portfolio: '#/portfolio?tab=record', settings: '#/settings?tab=general', data: '#/settings?tab=data', privacy: '#/settings?tab=system' };

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '') || 'watchlist';
  const [p, qs] = raw.split('?');
  let parts;
  try {
    parts = p.split('/').filter(Boolean).map(decodeURIComponent);
  } catch (_) {
    parts = ['watchlist'];
  }
  return { name: parts[0] || 'watchlist', args: parts.slice(1), query: new URLSearchParams(qs || '') };
}

function counts(index) {
  const projects = (index.projects || []).filter((p) => !p.broken && p.status !== 'archived');
  const changed = projects.filter((p) => p.changes && p.changes.item_count > 0).length;
  const pending = (index.imports.requests_pending || []).length + ((index.imports.inbox || {}).in_inbox || []).length;
  const running = projects.filter((p) => p.research && Object.values(p.research.providers || {}).some((j) => j && ['queued', 'running'].includes(j.state))).length;
  return {
    watchlist: projects.filter((p) => p.on_watchlist || p.held).length || '',
    research: running ? { n: running, title: `${running} project(s) with research in progress` } : '',
    updates: changed + pending ? { n: changed + pending, title: `${changed} project(s) changed since your last review${pending ? `; ${pending} item(s) waiting in the inbox or request queue` : ''}` } : '',
  };
}

function renderNav() {
  const nav = document.getElementById('nav');
  const r = state.route;
  const active = r ? (r.name === 'project' ? 'watchlist' : r.name) : 'watchlist';
  const c = state.index ? counts(state.index) : {};
  clear(nav);
  for (const [id, label] of SECTIONS) {
    const n = c[id];
    const num = n && typeof n === 'object' ? n.n : n;
    const desc = n && typeof n === 'object' ? n.title : n ? `${n} projects` : '';
    nav.appendChild(h('a', { href: `#/${id}`, class: id === active ? 'active' : null, 'aria-current': id === active ? 'page' : null, 'aria-label': `${label}${desc ? `, ${desc}` : ''}`, onclick: () => closeMenu(), dataset: { key: `nav-${id}` } },
      h('span', null, label), num ? h('span', { class: 'count', 'aria-hidden': 'true' }, String(num)) : null));
  }
}

function closeMenu() {
  const nav = document.getElementById('nav');
  nav.classList.remove('open');
  document.getElementById('menu-btn').setAttribute('aria-expanded', 'false');
}

function pageTitle(route) {
  if (route.name === 'project') {
    const p = state.index && state.index.projects.find((x) => x.project_id === route.args[0]);
    return `${p ? p.name : 'Project'} · CryptoResearch`;
  }
  const s = SECTIONS.find((x) => x[0] === route.name);
  return `${s ? s[1] : 'Watchlist'} · CryptoResearch`;
}

// ---- state kept across redraws ---------------------------------------------

const scrollMemory = new Map();     // routeKey -> { y, scrollers }
const activatorMemory = new Map();  // routeKey -> data-key of the control used to leave

function keyOf(el) {
  if (!el || el === document.body) return null;
  const k = el.closest && el.closest('[data-key]');
  if (k && k.dataset.key) return k.dataset.key;
  return el.id || null;
}

function findKey(key) {
  if (!key) return null;
  return document.querySelector(`[data-key="${CSS.escape(key)}"]`) || document.getElementById(key);
}

function captureScrollers() {
  return [...document.querySelectorAll('[data-keep-scroll]')].map((el) => [el.dataset.keepScroll, el.scrollLeft, el.scrollTop]);
}

function restoreScrollers(list) {
  for (const [key, left, top] of list || []) {
    const el = document.querySelector(`[data-keep-scroll="${CSS.escape(key)}"]`);
    if (el) {
      el.scrollLeft = left;
      el.scrollTop = top;
    }
  }
}

function captureState() {
  const details = {};
  for (const d of document.querySelectorAll('#main details[data-key]')) details[d.dataset.key] = d.open;
  const fields = [];
  for (const el of document.querySelectorAll('#main input[name], #main textarea[name], #main select[name]')) {
    if (el.closest('[data-nodirty]')) continue;
    const changed = el.type === 'checkbox' || el.type === 'radio' ? el.checked !== el.defaultChecked : el.tagName === 'SELECT' ? [...el.options].some((o) => o.selected !== o.defaultSelected) : el.value !== el.defaultValue;
    if (changed) fields.push({ name: el.name, form: el.form ? el.form.dataset.key || null : null, value: el.value, checked: el.checked });
  }
  return { y: window.scrollY, focus: keyOf(document.activeElement), details, scrollers: captureScrollers(), fields };
}

function restoreState(s, { focus = true } = {}) {
  for (const [key, open] of Object.entries(s.details || {})) {
    const d = findKey(key);
    if (d && d.tagName === 'DETAILS') d.open = open;
  }
  for (const f of s.fields || []) {
    const scope = f.form ? document.querySelector(`form[data-key="${CSS.escape(f.form)}"]`) : document.getElementById('main');
    const el = scope && scope.querySelector(`[name="${CSS.escape(f.name)}"]`);
    if (!el) continue;
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = f.checked;
    else el.value = f.value;
  }
  restoreScrollers(s.scrollers);
  window.scrollTo(0, s.y);
  if (!focus) return;
  const el = findKey(s.focus);
  if (el && typeof el.focus === 'function') el.focus({ preventScroll: true });
}

async function render({ reason = 'nav' } = {}) {
  const seq = ++state.renderSeq;
  let route = parseHash();
  if (LEGACY[route.name]) {
    // Keep old query parameters (for example #/compare?category=...).
    const extra = new URLSearchParams(route.query);
    extra.delete('tab');
    const target = LEGACY[route.name];
    const qs = extra.toString();
    return navigate(qs ? `${target}${target.includes('?') ? '&' : '?'}${qs}` : target, { replace: true });
  }
  if (route.name === 'imports') return navigate(LEGACY_IMPORT_TABS[route.query.get('tab')] || '#/updates?tab=import', { replace: true });
  if (route.name === 'updates' && route.query.get('tab') === 'activity') return navigate('#/settings?tab=activity', { replace: true });
  if (!LOADERS[route.name]) route = { name: 'watchlist', args: [], query: new URLSearchParams() };
  const prev = state.route;
  const samePage = prev && routeKey(prev) === routeKey(route);
  const keep = reason === 'live' || reason === 'refresh' || samePage;
  const snapshot = keep ? captureState() : null;
  state.route = route;
  state.renderReason = reason === 'live' ? 'live' : samePage ? 'same' : reason;
  state.focusClaimed = false;
  renderNav();
  if (route.name !== 'watchlist') closePanelChrome();
  const main = document.getElementById('main');
  try {
    const view = await LOADERS[route.name]();
    const node = await view(ctx, route);
    if (seq !== state.renderSeq) return; // a newer navigation won
    clear(main).appendChild(node);
    document.title = pageTitle(route);
    // Work that needs the page in the document (the summary panel, an open scorecard).
    if (typeof node.afterMount === 'function') {
      try {
        node.afterMount();
      } catch (err) {
        console.error(err);
      }
    }
  } catch (err) {
    if (seq !== state.renderSeq) return;
    clear(main).appendChild(h('div', { class: 'callout bad' }, `Could not show this page: ${err.message}. Your files are unchanged.`));
    console.error(err);
  }
  if (snapshot) {
    restoreState(snapshot, { focus: !state.focusClaimed });
  } else if (reason === 'pop' && scrollMemory.has(routeKey(route))) {
    const mem = scrollMemory.get(routeKey(route));
    restoreScrollers(mem.scrollers);
    window.scrollTo(0, mem.y);
    const back = findKey(activatorMemory.get(routeKey(route)));
    if (state.focusClaimed) { /* the view placed focus itself */ } else if (back && typeof back.focus === 'function') back.focus({ preventScroll: true });
    else main.focus({ preventScroll: true });
  } else {
    window.scrollTo(0, 0);
    if (prev && !state.focusClaimed) main.focus({ preventScroll: true });
  }
  state.renderReason = 'nav';
  state.dirty = false;
  const bar = document.querySelector('.update-bar');
  if (bar) bar.remove();
}

// Leaving the watchlist: remove the detail panel and anything that made it modal.
function closePanelChrome() {
  const root = document.getElementById('panel-root');
  clear(root);
  document.body.classList.remove('split', 'sheet-open');
  for (const el of document.querySelectorAll('[data-inert-by-sheet]')) {
    el.inert = false;
    el.removeAttribute('data-inert-by-sheet');
  }
  const bd = document.querySelector('.sheet-backdrop');
  if (bd) bd.remove();
}

function setLive(on) {
  state.live = on;
  const el = document.getElementById('live');
  el.className = `status-dot ${on ? 'on' : 'off'}`;
  document.getElementById('live-text').textContent = on ? 'Live' : 'Reconnecting…';
}

function showUpdatedBar() {
  if (document.querySelector('.update-bar')) return;
  const apply = h('button', { type: 'button', onclick: () => { render({ reason: 'refresh' }); } }, 'Show updates');
  const bar = h('div', { class: 'update-bar', role: 'status' }, h('span', null, 'New data is available. Your unsaved input is kept.'), apply);
  document.body.appendChild(bar);
}

// Browsers allow six connections per server and every open dashboard page holds
// one for live updates, so a hidden or cached page gives its connection back
// and catches up when it is shown again.
let events = null;
let hiddenTimer = null;

function closeEvents() {
  if (events) {
    events.close();
    events = null;
  }
}

async function catchUp() {
  try {
    const next = await api.get('/api/index');
    if (state.index && next.generated_at === state.index.generated_at) return;
    state.index = next;
    state.projects.clear();
    if (state.dirty) showUpdatedBar();
    else render({ reason: 'live' });
  } catch (_) { /* the stream reports connection problems itself */ }
}

function connectEvents({ catchUpOnOpen = false } = {}) {
  closeEvents();
  const es = new EventSource('/api/events');
  events = es;
  let pendingCatchUp = catchUpOnOpen;
  const opened = () => {
    setLive(true);
    if (pendingCatchUp) {
      pendingCatchUp = false;
      catchUp();
    }
  };
  es.addEventListener('hello', opened);
  es.onopen = opened;
  es.onerror = () => setLive(false);
  es.addEventListener('changed', async (e) => {
    let ev = {};
    try {
      ev = JSON.parse(e.data);
    } catch (_) { /* ignore */ }
    if (ev.error) toast(`Index rebuild problem: ${ev.error}`, 'bad');
    const before = state.index;
    try {
      state.index = await api.get('/api/index');
    } catch (_) {
      return;
    }
    const broad = (ev.areas || []).some((a) => ['portfolio', 'market-data', 'config', 'templates', 'all', 'poll', 'api', 'startup', 'logs'].includes(a));
    if (broad) state.projects.clear();
    for (const id of ev.projects || []) state.projects.delete(id);
    // Announce only meaningful events, never price ticks.
    const added = (state.index.projects || []).filter((p) => before && !before.projects.some((q) => q.project_id === p.project_id));
    if (added.length) announce(`${added.map((p) => p.name).join(', ')} added.`);
    if (state.dirty) showUpdatedBar();
    else render({ reason: 'live' });
  });
}

async function boot() {
  try {
    state.session = await (await fetch('/api/session')).json();
    state.token = state.session.token;
  } catch (err) {
    document.getElementById('main').textContent = 'Could not reach the local dashboard server. Start it with "Open Dashboard.cmd".';
    return;
  }
  const ws = state.session.workspace;
  const kindTag = document.getElementById('ws-kind');
  if (ws.kind !== 'real') {
    kindTag.textContent = ws.kind === 'demo' ? 'Demo' : 'Test';
    kindTag.classList.remove('hidden');
    const banner = document.getElementById('demo-banner');
    banner.textContent = `${ws.kind === 'demo' ? 'Fictional demo data' : 'Test workspace'}: not real research, prices or holdings`;
    banner.classList.remove('hidden');
  }
  const menu = document.getElementById('menu-btn');
  menu.addEventListener('click', () => {
    const nav = document.getElementById('nav');
    const open = !nav.classList.contains('open');
    nav.classList.toggle('open', open);
    menu.setAttribute('aria-expanded', String(open));
  });
  try {
    state.ui = await api.get('/api/ui-state');
  } catch (_) {
    state.ui = store.get('ui', {}) || {};
  }
  if (!state.ui || typeof state.ui !== 'object') state.ui = {};
  await loadIndex();
  let navType = 'nav';
  window.addEventListener('popstate', () => { navType = 'pop'; });
  window.addEventListener('hashchange', () => {
    const t = navType;
    navType = 'nav';
    render({ reason: t });
  });
  // Remember where each page was scrolled and which control was used last.
  let scrollTimer = null;
  window.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      if (state.route) scrollMemory.set(routeKey(state.route), { y: window.scrollY, scrollers: captureScrollers() });
    }, 120);
  }, { passive: true });
  document.addEventListener('click', (e) => {
    const k = keyOf(e.target);
    if (k && state.route) {
      activatorMemory.set(routeKey(state.route), k);
      scrollMemory.set(routeKey(state.route), { y: window.scrollY, scrollers: captureScrollers() });
    }
  }, true);
  const main = document.getElementById('main');
  main.addEventListener('input', (e) => {
    if (e.target && e.target.closest && e.target.closest('[data-nodirty]')) return;
    state.dirty = true;
  });
  await render();
  connectEvents();
  document.addEventListener('visibilitychange', () => {
    clearTimeout(hiddenTimer);
    if (document.hidden) hiddenTimer = setTimeout(closeEvents, 15000);
    else if (!events) connectEvents({ catchUpOnOpen: true });
  });
  window.addEventListener('pagehide', closeEvents);
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && !events) connectEvents({ catchUpOnOpen: true });
  });
}

boot();
