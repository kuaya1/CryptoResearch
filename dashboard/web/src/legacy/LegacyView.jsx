// Runs a view the app has not rebuilt in React yet (dashboard/public/views)
// inside the shell, with the context it was written for and the former
// shell's rules: a live update or a saved change redraws it in place keeping
// focus, open sections, scroll positions and drafts; while you are typing in
// it, a bar offers the update instead. Its stylesheet is scoped under .lg.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useDesk } from '../lib/hooks.js';
import { nav, routeKey, pageReady, findKey, restoreScrollers } from '../lib/router.js';
import { legacyCtx, legacyState } from './ctx.js';
import { h } from '../../../public/ui.js';
import { isChunkError } from '../components/Boundary.jsx';

function captureState(root) {
  const details = {};
  for (const d of root.querySelectorAll('details[data-key]')) details[d.dataset.key] = d.open;
  const fields = [];
  for (const el of root.querySelectorAll('input[name], textarea[name], select[name]')) {
    if (el.closest('[data-nodirty]')) continue;
    const changed = el.type === 'checkbox' || el.type === 'radio' ? el.checked !== el.defaultChecked : el.tagName === 'SELECT' ? [...el.options].some((o) => o.selected !== o.defaultSelected) : el.value !== el.defaultValue;
    if (changed) fields.push({ name: el.name, form: el.form ? el.form.dataset.key || null : null, value: el.value, checked: el.checked });
  }
  const scrollers = [...root.querySelectorAll('[data-keep-scroll]')].map((el) => [el.dataset.keepScroll, el.scrollLeft, el.scrollTop]);
  const a = document.activeElement;
  const k = a && root.contains(a) ? (a.closest('[data-key]') || {}).dataset : null;
  return { y: window.scrollY, focus: k && k.key ? k.key : a && root.contains(a) ? a.id || null : null, details, scrollers, fields };
}

function restoreState(root, s, { focus = true } = {}) {
  for (const [key, open] of Object.entries(s.details || {})) {
    const d = root.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (d && d.tagName === 'DETAILS') d.open = open;
  }
  for (const f of s.fields || []) {
    const scope = f.form ? root.querySelector(`form[data-key="${CSS.escape(f.form)}"]`) : root;
    const el = scope && scope.querySelector(`[name="${CSS.escape(f.name)}"]`);
    if (!el) continue;
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = f.checked;
    else el.value = f.value;
  }
  restoreScrollers(s.scrollers);
  window.scrollTo(0, s.y);
  if (!focus) return;
  const el = findKey(s.focus);
  if (el && typeof el.focus === 'function' && root.contains(el)) el.focus({ preventScroll: true });
}

export default function LegacyView({ load, name }) {
  const d = useDesk();
  const host = useRef(null);
  const seq = useRef(0);
  const last = useRef({ key: null, version: -1 });
  const [stale, setStale] = useState(false);
  const route = nav.route;
  const key = route ? `${routeKey(route)}#${route.query.get('p') || ''}` : '';

  const draw = async (reason) => {
    const root = host.current;
    if (!root) return;
    const mine = ++seq.current;
    const keep = reason === 'live' || reason === 'refresh' || reason === 'same';
    const snapshot = keep && root.firstChild ? captureState(root) : null;
    legacyState.renderReason = reason;
    legacyState.focusClaimed = false;
    legacyState.dirty = false;
    setStale(false);
    let node;
    try {
      const view = await load();
      node = await view(legacyCtx, nav.route);
    } catch (err) {
      console.error(err);
      // Said in place with Try again (draws it once more, never a write);
      // the shell around it keeps working (review 2026-10-08, F3).
      const again = h('button', { type: 'button', class: 'btn btn-sm btn-primary', dataset: { key: 'view-retry' } }, 'Try again');
      again.addEventListener('click', () => draw('nav'));
      const reload = h('button', { type: 'button', class: 'btn btn-sm', dataset: { key: 'view-reload' } }, 'Reload the page');
      reload.addEventListener('click', () => location.reload());
      const why = isChunkError(err) ? 'Part of the desk could not be downloaded: the connection dropped, or the desk was updated since this page was opened (Reload gets the new version).' : `Something went wrong while drawing it: ${err.message}.`;
      node = h('div', { class: 'view-error', role: 'alert' }, h('p', { class: 've-title' }, 'This page could not be shown'), h('p', { class: 've-why' }, why), h('p', { class: 'faint' }, 'Your records are unchanged; nothing was saved or sent.'), h('div', { class: 've-actions' }, again, reload));
    }
    if (mine !== seq.current || !host.current) return;
    if (root.firstChild !== node || root.childNodes.length !== 1) root.replaceChildren(node);
    if (typeof node.afterMount === 'function') {
      try {
        node.afterMount();
      } catch (err) {
        console.error(err);
      }
    }
    if (snapshot) restoreState(root, snapshot, { focus: !legacyState.focusClaimed });
    else pageReady();
    legacyState.renderReason = 'nav';
  };

  // A new address (or the same one again): draw. A change on the server or
  // after a write: redraw in place, or offer it while you are typing.
  useLayoutEffect(() => {
    const prev = last.current;
    const sameKey = prev.key === key;
    last.current = { key, version: d.version };
    if (!sameKey) {
      draw(nav.reason === 'same' ? 'same' : nav.reason === 'pop' ? 'pop' : 'nav');
      return;
    }
    if (prev.version === d.version) return;
    if (d.reason === 'live' && legacyState.dirty) setStale(true);
    else if (d.reason === 'live' || d.reason === 'refresh') draw(d.reason);
  });

  useEffect(() => {
    const root = host.current;
    const onInput = (e) => {
      if (e.target && e.target.closest && e.target.closest('[data-nodirty]')) return;
      legacyState.dirty = true;
    };
    root.addEventListener('input', onInput);
    return () => root.removeEventListener('input', onInput);
  }, []);

  return (
    <>
      {stale ? (
        <div className="update-bar" role="status">
          <span>New data is available. Your unsaved input is kept.</span>
          <button type="button" className="btn" onClick={() => draw('live')}>Show updates</button>
        </div>
      ) : null}
      <div className={`lg lg-view lg-${name}`} ref={host} />
    </>
  );
}
