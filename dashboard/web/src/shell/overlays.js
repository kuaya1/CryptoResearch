// The two overlays every page can open (DESIGN_AND_IA_BLUEPRINT.md §3.6):
// the command menu (⌘K / Ctrl+K, the rail's ⌘K button, the phone's search
// button) and the Preferences drawer (⌘, / Ctrl+,, the rail's Preferences).
// Preferences is in the address (?prefs=<section> on the page under it), so
// Back closes it and a link can open a section (Forensics' "Your screening
// preferences · Edit"); opening it never redraws the page under it.
import { nav, navigate, hrefWith } from '../lib/router.js';
import { ui } from '../lib/desk.js';
import { prefs as readPrefs, prefsToSave } from '../../../public/watchlist-model.js';

export const PREF_SECTIONS = [
  ['appearance', 'Appearance'],
  ['screening', 'Screening'],
  ['models', 'Models & budget'],
  ['rubrics', 'Rubrics'],
  ['data', 'Data'],
  ['system', 'System'],
  ['activity', 'Activity'],
  ['developer', 'Developer'],
];

export const prefsOf = (route = nav.route) => {
  const v = route && route.query.get('prefs');
  return v ? (PREF_SECTIONS.some(([k]) => k === v) ? v : 'appearance') : null;
};

export function openPrefs(section = 'appearance') {
  if (!nav.route) return;
  if (prefsOf()) {
    navigate(hrefWith({ prefs: section }), { replace: true, state: history.state });
    return;
  }
  navigate(hrefWith({ prefs: section }), { state: { ...(history.state || {}), crPrefs: true } });
}

export function closePrefs() {
  if (history.state && history.state.crPrefs) history.back();
  else navigate(hrefWith({ prefs: null }), { replace: true, state: history.state });
}

// The command menu's opener. Asked before the menu's code has loaded, the
// request waits for it (pending) instead of being lost.
const listeners = new Set();
let pending = null;
export function onCommand(fn) {
  listeners.add(fn);
  if (pending !== null) {
    const text = pending;
    pending = null;
    fn(true, text);
  }
  return () => listeners.delete(fn);
}
export function openCommand(text = '') {
  if (!listeners.size) {
    pending = text;
    return;
  }
  for (const fn of [...listeners]) fn(true, text);
}

// The command menu's Desk commands (a view, the row density, Columns, Reset
// columns): carried out by the Desk itself; asked from another page, they
// wait until the Desk has opened.
const deskListeners = new Set();
let deskPending = [];
export function onDesk(fn) {
  deskListeners.add(fn);
  if (deskPending.length) {
    const queued = deskPending;
    deskPending = [];
    for (const c of queued) fn(c);
  }
  return () => deskListeners.delete(fn);
}
export function deskDo(cmd) {
  if (nav.route && nav.route.name === 'watchlist' && !nav.route.query.get('p') && deskListeners.size) {
    for (const fn of [...deskListeners]) fn(cmd);
    return;
  }
  deskPending.push(cmd);
  navigate('#/watchlist');
}

// The Desk's saved choices (density, the view, the columns) from Preferences >
// Appearance: the open Desk applies them at once; otherwise they are saved
// for the next time it opens.
export function deskPrefs(patch) {
  if (nav.route && nav.route.name === 'watchlist' && deskListeners.size) {
    for (const fn of [...deskListeners]) fn({ type: 'prefs', patch });
    return;
  }
  const cur = readPrefs({ ui });
  ui.set('watchlist', prefsToSave({ ...cur, ...patch, filters: { ...cur.filters, ...(patch.filters || {}) } }));
}
