// App shell: session, API client, routing, navigation, saved view state and
// live refresh. Views load on demand so one broken view never blanks the rest.
// A live refresh keeps focus, open sections, scroll positions and drafts; Back
// returns to the list position and the control that was used to leave it.
import { h, clear, toast, store, announce, followedCount } from './ui.js';

const state = { token: null, session: null, index: null, projects: new Map(), dirty: false, live: false, route: null, ui: {}, renderSeq: 0, renderReason: 'nav' };

const GET_TIMEOUT_MS = 20000;
const WRITE_TIMEOUT_MS = 120000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function parse(res) {
  const type = res.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(body && body.error ? body.error : `Request failed (${res.status})`);
    err.code = body && body.code;
    err.saved = body && body.saved;
    err.status = res.status;
    err.retryAfterMs = body && typeof body.retry_after_ms === 'number' ? body.retry_after_ms : (Number(res.headers.get('retry-after')) * 1000 || null);
    throw err;
  }
  return body;
}

// Every request is bounded (audit V2-006): a read gives up after 20 seconds,
// a write after 120 seconds and then says its outcome is unknown. The session
// token changes when the dashboard restarts; a 401 is refused before anything
// runs, so renewing the token and retrying once is safe.
async function call(path, init = {}, read = (res) => res, { timeoutMs = null, signal = null } = {}) {
  const write = (init.method || 'GET') !== 'GET';
  const ms = timeoutMs || (write ? WRITE_TIMEOUT_MS : GET_TIMEOUT_MS);
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, ms);
  const relay = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', relay, { once: true });
  }
  const go = () => fetch(path, { ...init, signal: ctrl.signal, headers: { ...(init.headers || {}), 'x-cr-token': state.token } });
  try {
    let res = await go();
    if (res.status === 401) {
      try {
        const sres = await fetch('/api/session', { signal: ctrl.signal });
        // Online desk: signed out (the session cookie expired), so sign in again.
        if (sres.status === 401 && state.session && state.session.hosted) {
          location.assign('/login');
          return await read(res);
        }
        const s = await sres.json();
        if (s && s.token && s.workspace && state.session && s.workspace.workspace_id === state.session.workspace.workspace_id) {
          state.token = s.token;
          res = await go();
        }
        // Still refused: the online desk signs in again now; never a retry loop.
        if (res.status === 401 && state.session && state.session.hosted) {
          location.assign('/login');
          return await read(res);
        }
      } catch (err) {
        if (ctrl.signal.aborted) throw err;
        /* keep the 401 */
      }
    }
    return await read(res);
  } catch (err) {
    if (timedOut) {
      const e = new Error(write
        ? `No answer from the dashboard server within ${Math.round(ms / 1000)} seconds. The change may or may not have been saved: reload the page and check before trying again.`
        : `The dashboard server did not answer within ${Math.round(ms / 1000)} seconds.`);
      e.code = 'CLIENT_TIMEOUT';
      e.saved = write ? 'unknown' : false;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', relay);
  }
}

// A read that meets a save in progress is answered 503 (READ_BUSY) instead of
// with mixed records: wait as long as the server asks and try again, a few
// times, while the status line says a save is in progress.
async function getWithRetry(path, opts, read) {
  for (let i = 0; ; i++) {
    try {
      const out = await call(path, {}, read, opts);
      if (i) setSaving(false);
      return out;
    } catch (err) {
      if (!['READ_BUSY', 'READ_INTERRUPTED'].includes(err.code) || i >= 4 || (opts.signal && opts.signal.aborted)) {
        if (i) setSaving(false);
        throw err;
      }
      setSaving(true);
      await sleep(Math.min(Math.max(err.retryAfterMs || 1000, 250), 4000));
    }
  }
}

const readText = async (res) => {
  if (!res.ok) await parse(res);
  return res.text();
};

export const api = {
  get(path, opts = {}) {
    return getWithRetry(path, opts, parse);
  },
  post(path, body, opts = {}) {
    return call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }, parse, opts);
  },
  text(path, opts = {}) {
    return getWithRetry(path, opts, readText);
  },
  async download(path, filename) {
    const blob = await getWithRetry(path, { timeoutMs: WRITE_TIMEOUT_MS }, async (res) => {
      if (!res.ok) await parse(res);
      return res.blob();
    });
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
  // The index says which change it includes, so polling resumes after it.
  if (state.index.live) {
    live.seq = state.index.live.seq;
    live.instance = state.index.live.instance;
  }
  if (state.index.read_status) {
    live.read = state.index.read_status;
    showStatus();
  }
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

// `state` marks an entry a view added for itself (the project inspector), so
// it can close by going back to the entry it came from.
function navigate(hash, { replace = false, state = null } = {}) {
  if (location.hash === hash) render({ reason: 'refresh' });
  else if (replace) {
    history.replaceState(state, '', hash);
    render({ reason: 'nav' });
  } else if (state) {
    history.pushState(state, '', hash);
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
  ['new', 'New research'],
  ['watchlist', 'Watchlist'],
  ['portfolio', 'Portfolio'],
  ['research', 'Research'],
  ['updates', 'Updates'],
  // The optional Research Explorer (Supabase); in the nav only where the
  // server says to show it (set up, or on the PC), see renderNav.
  ['explorer', 'Explorer'],
  ['settings', 'Settings'],
];

const LOADERS = {
  new: () => import('./views/intake.js').then((m) => m.renderIntake),
  watchlist: () => import('./views/watchlist.js').then((m) => m.renderWatchlist),
  // One page per project (#/project/<id>/<tab>); its Brief tab is the default.
  project: () => import('./views/project.js').then((m) => m.renderProject),
  portfolio: () => import('./views/portfolio.js').then((m) => m.renderPortfolio),
  research: () => import('./views/research.js').then((m) => m.renderResearch),
  updates: () => import('./views/updates.js').then((m) => m.renderUpdates),
  settings: () => import('./views/settings.js').then((m) => m.renderSettings),
  explorer: () => import('./views/explorer.js').then((m) => m.renderExplorer),
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
  const running = projects.filter((p) => p.research && Object.values(p.research.providers || {}).some((j) => j && ['queued', 'running', 'dispatching'].includes(j.state))).length;
  const followed = followedCount(projects);
  return {
    // Projects you watch or hold (not archived): the list's default view.
    watchlist: followed ? { n: followed, title: `${followed} project${followed === 1 ? '' : 's'} you watch or hold` } : '',
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
    if (id === 'explorer' && !(state.session && state.session.explorer && state.session.explorer.show) && active !== 'explorer') continue;
    const n = c[id];
    const num = n && typeof n === 'object' ? n.n : n;
    const desc = n && typeof n === 'object' ? n.title : n ? `${n} projects` : '';
    nav.appendChild(h('a', { href: `#/${id}`, class: id === active ? 'active' : null, 'aria-current': id === active ? 'page' : null, 'aria-label': `${label}${desc ? `, ${desc}` : ''}`, onclick: () => closeMenu(), dataset: { key: `nav-${id}` } },
      h('span', null, label), num ? h('span', { class: 'count', 'aria-hidden': 'true', title: desc || null }, String(num)) : null));
  }
  // Online desk: signing out ends this browser's session on the server. A
  // quiet text button at the right of the top bar, not a section of the nav;
  // where the nav folds into Menu (a phone), the menu's last item instead
  // (V5, Eric, 2026-10-05). The stylesheet shows one of the two.
  const end = document.getElementById('topbar-end');
  if (end) clear(end);
  if (end && state.session && state.session.hosted) {
    end.appendChild(h('form', { method: 'post', action: '/logout', class: 'signout' }, h('button', { type: 'submit', class: 'quiet small', dataset: { key: 'nav-signout' } }, 'Sign out')));
    nav.appendChild(h('form', { method: 'post', action: '/logout', class: 'signout menu-signout' }, h('button', { type: 'submit', class: 'quiet', dataset: { key: 'menu-signout' } }, 'Sign out')));
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
// The last click, so a page change can tell whether that click left the page
// (its control is where focus returns on Back) or came earlier, such as a fold
// opened before leaving by a link without a key (live test, 2026-10-08).
let lastClick = null;               // { route, key, at }
const LEAVE_CLICK_MS = 2000;

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
  // The project page's former tabs and the Brief's own page (#/brief/<id>,
  // also from links the server builds) land on their new home, keeping the
  // entry's state (a brief opened from the inspector returns there).
  if (route.name === 'brief' || route.name === 'project') {
    const { projectRedirect } = await import('./views/project.js');
    const to = projectRedirect(route.name, route.args, route.query);
    if (to) {
      history.replaceState(history.state, '', to);
      route = parseHash();
    }
  }
  if (!LOADERS[route.name]) route = { name: 'watchlist', args: [], query: new URLSearchParams() };
  const prev = state.route;
  const samePage = prev && routeKey(prev) === routeKey(route);
  if (prev && !samePage && reason !== 'live' && reason !== 'refresh') {
    // Leaving a page: remember the control that left it, only when the last
    // click was that control; otherwise Back puts focus on the page itself.
    const left = lastClick && lastClick.route === routeKey(prev) && Date.now() - lastClick.at < LEAVE_CLICK_MS ? lastClick.key : null;
    if (left) activatorMemory.set(routeKey(prev), left);
    else activatorMemory.delete(routeKey(prev));
  }
  const keep = reason === 'live' || reason === 'refresh' || samePage;
  const snapshot = keep ? captureState() : null;
  state.route = route;
  state.renderReason = reason === 'live' ? 'live' : samePage ? 'same' : reason;
  state.focusClaimed = false;
  renderNav();
  if (route.name !== 'watchlist') {
    closePanelChrome();
    // The status strip band belongs to the watchlist.
    const band = document.getElementById('strip-root');
    if (band) clear(band);
    document.documentElement.style.removeProperty('--band-h');
  }
  const main = document.getElementById('main');
  try {
    const view = await LOADERS[route.name]();
    const node = await view(ctx, route);
    if (seq !== state.renderSeq) return; // a newer navigation won
    // A view that updated itself in place returns the page already shown:
    // leave it in the document, so focus, a caret and composition stay.
    if (main.firstChild !== node || main.childNodes.length !== 1) clear(main).appendChild(node);
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

function showUpdatedBar() {
  if (document.querySelector('.update-bar')) return;
  const apply = h('button', { type: 'button', onclick: () => { render({ reason: 'refresh' }); } }, 'Show updates');
  const bar = h('div', { class: 'update-bar', role: 'status' }, h('span', null, 'New data is available. Your unsaved input is kept.'), apply);
  document.body.appendChild(bar);
}

// ---- live updates ----------------------------------------------------------
//
// A visible page asks the server what changed (GET /api/version) every few
// seconds with one short, bounded request; a hidden or cached page asks
// nothing and checks once when it is shown again. No connection is held open,
// so any number of dashboard windows stay within the browser's per-server
// connection limit (audit V2-006: one event stream per window starved the
// seventh window). The status line says Live, Paused while hidden,
// Reconnecting (with the next try), or Saving in progress.
const POLL_MS = 2500;
const POLL_TIMEOUT_MS = 8000;
const BROAD_AREAS = ['portfolio', 'market-data', 'config', 'templates', 'all', 'poll', 'api', 'startup', 'logs', 'request'];
const live = { seq: null, instance: null, timer: null, ctrl: null, failures: 0, retryIn: null, mode: null, saving: false, read: null, readCode: null, polls: 0 };

function showStatus() {
  const el = document.getElementById('live');
  const text = document.getElementById('live-text');
  if (!el || !text) return;
  const read = live.read && live.read.status !== 'current' ? live.read : null;
  let label = 'Connecting';
  let tone = '';
  if (live.mode === 'paused') {
    label = 'Paused while hidden';
    tone = 'paused';
  } else if (live.mode === 'signed_out') {
    label = 'Signed out: reload';
    tone = 'off';
  } else if (live.mode === 'reconnecting') {
    label = live.retryIn ? `Reconnecting… next try in ${Math.round(live.retryIn / 1000)} s` : 'Reconnecting…';
    tone = 'off';
  } else if (live.saving || (read && ['READ_BUSY', 'READ_INTERRUPTED'].includes(read.code))) {
    label = 'Saving in progress';
    tone = 'wait';
  } else if (read) {
    label = read.status === 'stale' ? 'Showing the last verified view' : 'Not verified yet';
    tone = 'wait';
  } else if (live.mode === 'live') {
    label = 'Live';
    tone = 'on';
  }
  el.className = `status-dot ${tone}`.trim();
  el.dataset.mode = live.mode || 'connecting';
  el.dataset.polls = String(live.polls);
  el.title = read && read.reason ? `${label}. ${read.reason}` : 'Connection to the local dashboard server';
  if (text.textContent !== label) text.textContent = label;
  state.live = live.mode === 'live';
}

function setSaving(on) {
  live.saving = on;
  showStatus();
}

function stopPolling() {
  clearTimeout(live.timer);
  live.timer = null;
  const c = live.ctrl;
  live.ctrl = null;
  if (c) c.abort();
}

function schedulePoll(ms) {
  clearTimeout(live.timer);
  live.timer = null;
  if (document.hidden) {
    live.mode = 'paused';
    showStatus();
    return;
  }
  live.timer = setTimeout(pollVersion, ms);
}

function startPolling() {
  stopPolling();
  if (document.hidden) {
    live.mode = 'paused';
    showStatus();
    return;
  }
  pollVersion();
}

// Applies what changed: refetch the index, drop only the project caches that
// changed (everything after a broad or unknown change), then redraw in place
// or offer the update when you are typing.
async function applyChanges(changes) {
  const before = state.index;
  try {
    await loadIndex();
  } catch (_) {
    return false;
  }
  const broad = !changes || changes.some((c) => c.projects === null || (c.areas || []).some((a) => BROAD_AREAS.includes(a)));
  if (broad) state.projects.clear();
  else for (const c of changes) for (const id of c.projects || []) state.projects.delete(id);
  // Announce only meaningful events, never price ticks.
  const added = (state.index.projects || []).filter((p) => before && !before.projects.some((q) => q.project_id === p.project_id));
  if (added.length) announce(`${added.map((p) => p.name).join(', ')} added.`);
  if (state.dirty) showUpdatedBar();
  else render({ reason: 'live' });
  return true;
}

async function pollVersion() {
  live.timer = null;
  if (document.hidden) {
    live.mode = 'paused';
    showStatus();
    return;
  }
  if (live.ctrl) return;
  const ctrl = new AbortController();
  live.ctrl = ctrl;
  live.polls++;
  let v;
  try {
    v = await api.get(`/api/version${live.seq !== null ? `?since=${live.seq}` : ''}`, { signal: ctrl.signal, timeoutMs: POLL_TIMEOUT_MS });
  } catch (err) {
    if (live.ctrl !== ctrl) return; // stopped (hidden or leaving): no retry
    live.ctrl = null;
    // Signed out (a 401 the session could not renew): no retries. The online
    // desk has already gone to sign-in; this PC's dashboard says to reload.
    if (err && err.status === 401) {
      live.mode = 'signed_out';
      showStatus();
      if (!state.session || !state.session.hosted) toast('This dashboard was restarted with another session. Reload the page to continue.', 'bad');
      return;
    }
    live.failures++;
    live.retryIn = Math.min(POLL_MS * 2 ** live.failures, 30000);
    live.mode = 'reconnecting';
    showStatus();
    schedulePoll(live.retryIn);
    return;
  }
  if (live.ctrl !== ctrl) return;
  live.ctrl = null;
  live.failures = 0;
  live.retryIn = null;
  live.mode = 'live';
  live.read = v.read_status || null;
  const code = live.read && live.read.status !== 'current' ? live.read.code : null;
  if (code && code !== live.readCode && !['READ_BUSY', 'READ_INTERRUPTED'].includes(code)) toast(`The view may be out of date: ${live.read.reason}`, 'bad');
  live.readCode = code;
  showStatus();
  const restarted = live.instance !== null && v.instance !== live.instance;
  if (live.seq === null) {
    live.seq = v.seq;
    live.instance = v.instance;
  } else if (restarted || v.seq !== live.seq) {
    // live.seq moves on only when the change was applied (loadIndex sets it).
    if (!(await applyChanges(restarted ? null : v.changes))) {
      live.failures++;
    } else if (restarted) {
      live.instance = v.instance;
    }
  }
  schedulePoll(POLL_MS);
}

async function boot() {
  try {
    const sres = await fetch('/api/session');
    if (sres.status === 401) {
      location.assign('/login');
      return;
    }
    state.session = await sres.json();
    state.token = state.session.token;
  } catch (err) {
    document.getElementById('main').textContent = location.protocol === 'https:' ? 'Could not reach the research desk. Check your connection and reload.' : 'Could not reach the local dashboard server. Start it with "Open Dashboard.cmd".';
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
    if (!state.route) return;
    lastClick = { route: routeKey(state.route), key: keyOf(e.target), at: Date.now() };
    scrollMemory.set(routeKey(state.route), { y: window.scrollY, scrollers: captureScrollers() });
  }, true);
  const main = document.getElementById('main');
  main.addEventListener('input', (e) => {
    if (e.target && e.target.closest && e.target.closest('[data-nodirty]')) return;
    state.dirty = true;
  });
  // Ctrl+K (Cmd+K on a Mac), or / on its own: search the watchlist from
  // anywhere. Never while typing or editing, and never with a dialog open.
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
  document.addEventListener('keydown', (e) => {
    const slash = e.key === '/' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing;
    if (!slash && (e.key.toLowerCase() !== 'k' || e.altKey || e.shiftKey || (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey))) return;
    const t = e.target;
    // "/" is a character in every field, the search box included.
    const editing = t && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && (slash || t.dataset.key !== 'wl-search')));
    if (editing || document.querySelector('dialog[open]')) return;
    e.preventDefault();
    const r = state.route;
    const box = document.querySelector('[data-key="wl-search"]');
    // On the list (also beside a docked project inspector): straight to the box.
    if (r && r.name === 'watchlist' && box && !document.body.classList.contains('sheet-open')) {
      box.focus();
      box.select();
      return;
    }
    // Elsewhere, or under a modal inspector: back to the list first.
    state.focusSearch = true;
    if (r && r.name === 'watchlist') {
      if (history.state && history.state.crPanel) history.back();
      else navigate(ctx.hrefWith({ p: null }), { replace: true });
    } else navigate('#/watchlist');
  });
  await render();
  // An initially hidden page (a background tab) does not poll until shown.
  startPolling();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopPolling();
      live.mode = 'paused';
      showStatus();
    } else startPolling();
  });
  window.addEventListener('pagehide', stopPolling);
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) startPolling();
  });
  window.addEventListener('online', () => {
    if (live.mode === 'reconnecting') startPolling();
  });
}

boot();
