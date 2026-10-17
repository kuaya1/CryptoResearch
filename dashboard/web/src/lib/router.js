// Addresses and the way back. The desk keeps its hash addresses (#/watchlist,
// #/project/<id>/<tab>, …) so every saved link, bookmark and link the server
// builds keeps working; former addresses redirect.
//
// Ported from the former app shell (public/app.js), rules intact:
// - Back puts the page back where it was scrolled and focus on the control
//   that left it, only when that click left the page (2 s); otherwise focus
//   goes to the page itself (live test, 2026-10-08);
// - a redraw of the same page (a live update, a saved change, opening the
//   inspector) keeps scroll, focus and open sections;
// - history state marks entries a view added for itself (the inspector's
//   crPanel, the brief's crBrief and crDepth), so closing goes back to them.
import { desk, emit } from './desk.js';
import { projectRedirect } from '../../../public/project-routes.js';

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
export const ROUTE_NAMES = ['new', 'watchlist', 'project', 'portfolio', 'research', 'agenda', 'updates', 'settings', 'explorer'];

export function parseHash(hash = location.hash) {
  const raw = hash.replace(/^#\/?/, '') || 'watchlist';
  const [p, qs] = raw.split('?');
  let parts;
  try {
    parts = p.split('/').filter(Boolean).map(decodeURIComponent);
  } catch (_) {
    parts = ['watchlist'];
  }
  return { name: parts[0] || 'watchlist', args: parts.slice(1), query: new URLSearchParams(qs || '') };
}

// A page's identity: its address without the inspector's ?p=.
export function routeKey(route) {
  if (!route) return '';
  const q = new URLSearchParams(route.query);
  q.delete('p');
  return `${route.name}/${route.args.join('/')}?${q.toString()}`;
}

export const nav = {
  route: null,
  // Why the page is drawn: 'boot', 'nav' (a link), 'pop' (Back or Forward),
  // 'same' (the same page, another ?p= or a redraw).
  reason: 'boot',
  focusClaimed: false,
  focusSearch: false,
  pending: null,
};

const scrollMemory = new Map();
const activatorMemory = new Map();
let lastClick = null;
const LEAVE_CLICK_MS = 2000;

function keyOf(el) {
  if (!el || el === document.body) return null;
  const k = el.closest && el.closest('[data-key]');
  if (k && k.dataset.key) return k.dataset.key;
  return el.id || null;
}

export function findKey(key) {
  if (!key) return null;
  return document.querySelector(`[data-key="${CSS.escape(key)}"]`) || document.getElementById(key);
}

function captureScrollers() {
  return [...document.querySelectorAll('[data-keep-scroll]')].map((el) => [el.dataset.keepScroll, el.scrollLeft, el.scrollTop]);
}

export function restoreScrollers(list) {
  for (const [key, left, top] of list || []) {
    const el = document.querySelector(`[data-keep-scroll="${CSS.escape(key)}"]`);
    if (el) {
      el.scrollLeft = left;
      el.scrollTop = top;
    }
  }
}

function resolve() {
  let route = parseHash();
  if (LEGACY[route.name]) {
    const extra = new URLSearchParams(route.query);
    extra.delete('tab');
    const target = LEGACY[route.name];
    const qs = extra.toString();
    history.replaceState(history.state, '', qs ? `${target}${target.includes('?') ? '&' : '?'}${qs}` : target);
    route = parseHash();
  }
  if (route.name === 'imports') {
    history.replaceState(history.state, '', LEGACY_IMPORT_TABS[route.query.get('tab')] || '#/updates?tab=import');
    route = parseHash();
  }
  if (route.name === 'updates' && route.query.get('tab') === 'activity') {
    history.replaceState(history.state, '', '#/settings?tab=activity');
    route = parseHash();
  }
  if (route.name === 'brief' || route.name === 'project') {
    const to = projectRedirect(route.name, route.args, route.query);
    if (to) {
      history.replaceState(history.state, '', to);
      route = parseHash();
    }
  }
  if (!ROUTE_NAMES.includes(route.name)) route = { name: 'watchlist', args: [], query: new URLSearchParams() };
  return route;
}

// The address changed (or a view asked for a redraw of the same address).
export function routeChanged(reason = 'nav') {
  const route = resolve();
  const prev = nav.route;
  const samePage = Boolean(prev) && routeKey(prev) === routeKey(route);
  if (prev && !samePage) {
    // Leaving a page: remember the control that left it, only when the last
    // click was that control.
    const left = lastClick && lastClick.route === routeKey(prev) && Date.now() - lastClick.at < LEAVE_CLICK_MS ? lastClick.key : null;
    if (left) activatorMemory.set(routeKey(prev), left);
    else activatorMemory.delete(routeKey(prev));
    scrollMemory.set(routeKey(prev), { y: window.scrollY, scrollers: captureScrollers() });
  }
  nav.route = route;
  nav.reason = samePage ? 'same' : reason;
  nav.focusClaimed = false;
  nav.pending = samePage ? null : { reason, key: routeKey(route), hadPrev: Boolean(prev) };
  emit();
}

// `state` marks an entry a view added for itself (the inspector, the brief).
export function navigate(hash, { replace = false, state = null } = {}) {
  if (location.hash === hash && !replace && !state) {
    routeChanged('same');
    return;
  }
  if (replace) history.replaceState(state, '', hash);
  else if (state) history.pushState(state, '', hash);
  else {
    location.hash = hash;
    return; // hashchange follows
  }
  routeChanged('nav');
}

export function hrefWith(params, route = nav.route) {
  const q = new URLSearchParams(route.query);
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') q.delete(k);
    else q.set(k, v);
  }
  const qs = q.toString();
  return `#/${[route.name, ...route.args].map(encodeURIComponent).join('/')}${qs ? `?${qs}` : ''}`;
}

// A view that moves focus on purpose (opening a panel) keeps it.
export function claimFocus() {
  nav.focusClaimed = true;
}

// Called by a page once its content is in the document: Back puts it where
// it was and focus on the control that left it; a new page starts at its top
// with focus on the page.
export function pageReady() {
  const p = nav.pending;
  if (!p || p.key !== routeKey(nav.route)) return;
  nav.pending = null;
  const main = document.getElementById('main');
  if (p.reason === 'pop' && scrollMemory.has(p.key)) {
    const mem = scrollMemory.get(p.key);
    restoreScrollers(mem.scrollers);
    window.scrollTo(0, mem.y);
    const back = findKey(activatorMemory.get(p.key));
    if (nav.focusClaimed) { /* the view placed focus itself */ } else if (back && typeof back.focus === 'function') back.focus({ preventScroll: true });
    else if (main) main.focus({ preventScroll: true });
  } else {
    window.scrollTo(0, 0);
    if (p.hadPrev && !nav.focusClaimed && main) main.focus({ preventScroll: true });
  }
}

export function startRouter() {
  let navType = 'nav';
  window.addEventListener('popstate', () => { navType = 'pop'; });
  window.addEventListener('hashchange', () => {
    const t = navType;
    navType = 'nav';
    routeChanged(t);
  });
  let scrollTimer = null;
  window.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      if (nav.route) scrollMemory.set(routeKey(nav.route), { y: window.scrollY, scrollers: captureScrollers() });
    }, 120);
  }, { passive: true });
  document.addEventListener('click', (e) => {
    if (!nav.route) return;
    lastClick = { route: routeKey(nav.route), key: keyOf(e.target), at: Date.now() };
    scrollMemory.set(routeKey(nav.route), { y: window.scrollY, scrollers: captureScrollers() });
  }, true);
  routeChanged('boot');
}

// The document title for a route.
export function pageTitle(route, sections) {
  if (route.name === 'project') {
    const p = desk.index && desk.index.projects.find((x) => x.project_id === route.args[0]);
    return `${p ? p.name : 'Project'} · CryptoResearch`;
  }
  const s = sections.find((x) => x.id === route.name);
  return `${s ? s.label : 'Watchlist'} · CryptoResearch`;
}
