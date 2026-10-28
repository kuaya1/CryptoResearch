// The command menu (DESIGN_AND_IA_BLUEPRINT.md §3.6; ⌘K or Ctrl+K, the
// rail's Search, the phone's search button): one box to go anywhere and do
// the desk's everyday things.
//   Go to   a project (its page), a project's section ("caldera forensics"),
//           a page, a Preferences section
//   Do      research a project (the research dialog, which asks before
//           anything starts), add a project, start a forensic audit (its
//           tab, where you confirm), mark reviewed (the page's own button),
//           refresh prices, import a report, exports and backups
//   Toggle  the theme, the Desk's density, columns, filters and views, the rail
// Choosing a command is the click: nothing runs while you type, and every
// write goes through the same button or dialog as before.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, CornerDownLeft } from 'lucide-react';
import { store } from '../../../public/ui.js';
import { PROJECT_TABS } from '../../../public/project-routes.js';
import { VIEWS } from '../../../public/watchlist-model.js';
import { useDesk } from '../lib/hooks.js';
import { nav, navigate } from '../lib/router.js';
import { legacyCtx } from '../legacy/ctx.js';
import { loadLegacy } from '../components/Dom.jsx';
import { refreshPrices } from '../views/watchlist/StatusStrip.jsx';
import { archiveProject } from '../views/watchlist/state.js';
import { onCommand, openPrefs, deskDo, PREF_SECTIONS } from './overlays.js';
import '../styles/overlays.css';

const enc = encodeURIComponent;
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const THEMES = [['light', 'Light'], ['dark', 'Dark'], ['system', 'Match this device']];
const PAGES = [
  ['#/watchlist', 'Desk', 'watchlist home list projects'],
  ['#/review', 'Review', 'queue changed due waiting agenda updates'],
  ['#/review?seg=upcoming', 'Review · Upcoming', 'calendar catalysts unlocks invalidators alerts dates'],
  ['#/review?seg=imports', 'Review · Imports', 'import inbox requests cowork paste report'],
  ['#/portfolio', 'Portfolio', 'holdings wallets ledger positions transactions'],
  ['#/research', 'Research', 'runs jobs evidence sources'],
  ['#/new', 'New research', 'add link screenshot ticker'],
  ['#/explorer', 'Explorer', 'developer supabase demo'],
];

// The visible "Mark reviewed" button of the page under the menu, if any.
function reviewButton() {
  for (const k of ['rv-mark', 'panel-reviewed', 'ov-reviewed']) {
    const b = document.querySelector(`[data-key="${k}"]`);
    if (b && !b.disabled && b.offsetParent !== null) return b;
  }
  return null;
}

function setTheme(v) {
  store.set('theme', v === 'light' ? null : v);
  if (v === 'light') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', v);
}

function commands(d) {
  const out = [];
  // The project on screen (its page, or the inspector on the Desk or Review).
  const r = nav.route;
  const current = r ? (r.name === 'project' ? r.args[0] : r.query.get('p')) : null;
  const add = (group, label, words, run, hint = null) => {
    const c = { id: `${group}:${label}`, group, label, hay: norm(`${label} ${words}`), run, hint };
    out.push(c);
    return c;
  };
  const projects = ((d.index && d.index.projects) || []).filter((p) => !p.broken);
  for (const p of projects) {
    const name = `${p.name}${p.symbol ? ` ${p.symbol}` : ''}`;
    const c = add('Go to', p.name, `${p.symbol || ''} ${p.project_id} project${p.status === 'archived' ? ' archived' : ''}`, () => navigate(`#/project/${enc(p.project_id)}/brief`), p.symbol || null);
    c.id = `p:${p.project_id}`;
    c.project = p;
    for (const [t, label] of PROJECT_TABS) {
      if (t === 'brief') continue;
      out.push({ id: `tab:${p.project_id}:${t}`, group: 'Go to', label: `${p.name} · ${label}`, hay: norm(`${name} ${label} ${t}`), run: () => navigate(`#/project/${enc(p.project_id)}/${t}`), hint: null, tab: true, project: p });
    }
    out.push({ id: `tab:${p.project_id}:compare`, group: 'Go to', label: `${p.name} · Compare`, hay: norm(`${name} compare models`), run: () => navigate(`#/project/${enc(p.project_id)}/compare`), hint: null, tab: true, project: p });
    if (p.status !== 'archived') {
      const here = p.project_id === current;
      out.push({ id: `do:research:${p.project_id}`, group: 'Do', label: here ? `Run research on ${p.name}` : `Research ${p.name}`, hay: norm(`research run ${name} models${here ? ' current this' : ''}`), run: async () => { const L = await loadLegacy(); L.openResearchDialog(legacyCtx, p); }, hint: 'Asks before it starts', tab: !here, project: p });
      out.push({ id: `do:forensic:${p.project_id}`, group: 'Do', label: `Start forensic audit · ${p.name}`, hay: norm(`start forensic audit ${name}${here ? ' current this' : ''}`), run: () => navigate(`#/project/${enc(p.project_id)}/forensics?open=start`), hint: null, tab: !here, project: p });
      out.push({ id: `do:sector:${p.project_id}`, group: 'Do', label: `Change sector · ${p.name}`, hay: norm(`change sector ${name}`), run: async () => { const L = await loadLegacy(); L.openSectorDialog(legacyCtx, p); }, hint: null, tab: true, project: p });
      out.push({ id: `do:archive:${p.project_id}`, group: 'Do', label: `Archive ${p.name}`, hay: norm(`archive ${name}`), run: () => archiveProject(p), hint: 'Undo in the toast', tab: true, project: p });
    }
  }
  for (const [href, label, words] of PAGES) add('Go to', label, `page ${words}`, () => navigate(href));
  for (const [k, label] of PREF_SECTIONS) add('Go to', `Preferences · ${label}`, `settings preferences ${k}`, () => openPrefs(k));
  add('Do', 'New research', 'research a project add link screenshot ticker', () => navigate('#/new'));
  add('Do', 'Add project', 'add project watch', async () => { const L = await loadLegacy(); L.openAddProjectDialog(legacyCtx); });
  if (reviewButton()) add('Do', 'Mark reviewed', 'mark reviewed review done seen', () => { const b = reviewButton(); if (b) b.click(); }, 'This page');
  add('Do', 'Refresh prices', 'refresh prices market coingecko', () => refreshPrices(), 'Uses the price budget');
  add('Do', 'Import a report', 'import paste report inbox', () => navigate('#/review?seg=imports'));
  add('Do', 'Run queued jobs…', 'run queued jobs research budget', () => navigate('#/research'), 'On Research, within your limits');
  add('Do', 'Record a transaction', 'record transaction buy sell deposit ledger portfolio', () => navigate('#/portfolio?tab=record'));
  add('Do', 'Import a CSV of transactions', 'import csv transactions ledger portfolio', () => navigate('#/portfolio?tab=record'));
  add('Do', 'Exports and backups', 'export backup download data', () => openPrefs('data'));
  const cur = THEMES.some(([v]) => v === store.get('theme')) ? store.get('theme') : 'light';
  for (const [v, label] of THEMES) if (v !== cur) add('Toggle', `Theme: ${label}`, 'theme dark light appearance colour color', () => setTheme(v));
  add('Toggle', 'Density: Comfortable', 'density rows comfortable', () => deskDo({ type: 'density', value: 'comfortable' }));
  add('Toggle', 'Density: Compact', 'density rows compact dense', () => deskDo({ type: 'density', value: 'compact' }));
  add('Toggle', 'Columns…', 'columns desk table picker exit', () => deskDo({ type: 'columns' }));
  add('Toggle', 'Reset columns', 'columns default reset', () => deskDo({ type: 'reset-columns' }));
  add('Toggle', 'Filter…', 'filter desk sector coverage', () => deskDo({ type: 'filter' }));
  for (const [v, label] of VIEWS) add('Toggle', `View: ${label}`, `view desk ${v}`, () => deskDo({ type: 'view', value: v }));
  add('Toggle', 'Collapse or expand the rail', 'rail sidebar collapse expand', () => { const b = document.querySelector('[data-key="nav-collapse"]'); if (b) b.click(); });
  return out;
}

// Every word of the query in the command; a word at the start of a word
// counts more, the project itself before its sections.
function rank(list, q) {
  const words = norm(q).split(/\s+/).filter(Boolean);
  if (!words.length) return list.filter((c) => c.project && !c.tab && c.group === 'Do').concat(list.filter((c) => !c.tab && !c.project), list.filter((c) => c.project && !c.tab && c.group === 'Go to').slice(0, 6));
  const scored = [];
  for (const c of list) {
    let s = 0;
    let ok = true;
    for (const w of words) {
      const i = c.hay.indexOf(w);
      if (i < 0) { ok = false; break; }
      s += i === 0 ? 6 : c.hay[i - 1] === ' ' ? 4 : 1;
    }
    if (!ok) continue;
    if (c.tab) s -= 1;
    scored.push([s, c]);
  }
  return scored.sort((a, b) => b[0] - a[0] || a[1].label.localeCompare(b[1].label)).slice(0, 40).map(([, c]) => c);
}

export default function CommandMenu() {
  const d = useDesk();
  const dlg = useRef(null);
  const box = useRef(null);
  const list = useRef(null);
  const opener = useRef(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  useEffect(() => onCommand((on, text) => {
    if (!on) return;
    opener.current = document.activeElement;
    setQ(text || '');
    setAt(0);
    setOpen(true);
  }), []);
  useEffect(() => {
    const el = dlg.current;
    if (!el) return;
    if (open && !el.open) { el.showModal(); requestAnimationFrame(() => box.current && box.current.focus()); }
    if (!open && el.open) el.close();
  }, [open]);
  // A route change (a link, Back) closes it.
  const routeKey = nav.route ? `${nav.route.name}/${nav.route.args.join('/')}` : '';
  useEffect(() => { setOpen(false); }, [routeKey]);
  const all = useMemo(() => (open ? commands(d) : []), [open, d.index]);
  const shown = useMemo(() => rank(all, q), [all, q]);
  const pick = Math.min(at, Math.max(0, shown.length - 1));
  useEffect(() => {
    const el = list.current && list.current.querySelector(`[data-i="${pick}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [pick, shown]);
  const run = (c) => {
    setOpen(false);
    // After the dialog has closed and given focus back.
    requestAnimationFrame(() => { Promise.resolve(c.run()).catch(() => {}); });
  };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt((pick + 1) % Math.max(1, shown.length)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((pick - 1 + shown.length) % Math.max(1, shown.length)); }
    else if (e.key === 'Home' && e.ctrlKey) { e.preventDefault(); setAt(0); }
    else if (e.key === 'End' && e.ctrlKey) { e.preventDefault(); setAt(shown.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (shown[pick]) run(shown[pick]); }
  };
  let last = null;
  return (
    <dialog
      ref={dlg}
      className="cmdk"
      aria-label="Search and commands"
      onClose={() => { setOpen(false); const o = opener.current; opener.current = null; if (o && o.isConnected && typeof o.focus === 'function') o.focus(); }}
      onClick={(e) => { if (e.target === dlg.current) setOpen(false); }}
    >
      {open ? (
        <div className="cmdk-in">
          <div className="cmdk-field">
            <Search size={16} aria-hidden="true" />
            <input
              ref={box}
              className="cmdk-input"
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls="cmdk-list"
              aria-autocomplete="list"
              aria-activedescendant={shown[pick] ? `cmdk-opt-${pick}` : undefined}
              aria-label="Search projects, pages and commands"
              placeholder="Go to a project or page, or type a command"
              value={q}
              data-key="cmdk-input"
              onChange={(e) => { setQ(e.target.value); setAt(0); }}
              onKeyDown={onKey}
              spellCheck={false}
              autoComplete="off"
            />
            <kbd className="cmdk-esc" aria-hidden="true">Esc</kbd>
          </div>
          <ul className="cmdk-list" id="cmdk-list" role="listbox" ref={list} aria-label="Results">
            {shown.length ? shown.map((c, i) => {
              const head = c.group !== last ? c.group : null;
              last = c.group;
              return [
                head ? <li key={`h-${head}-${i}`} role="presentation" className="cmdk-group">{head}</li> : null,
                <li
                  key={c.id}
                  id={`cmdk-opt-${i}`}
                  role="option"
                  aria-selected={i === pick}
                  className={`cmdk-opt${i === pick ? ' is-on' : ''}`}
                  data-i={i}
                  data-key={`cmdk-${c.id}`}
                  onMouseMove={() => { if (i !== pick) setAt(i); }}
                  onClick={() => run(c)}
                >
                  <span className="cmdk-label">{c.label}</span>
                  {c.hint ? <span className="cmdk-hint">{c.hint}</span> : null}
                  {i === pick ? <CornerDownLeft className="cmdk-enter" size={13} aria-hidden="true" /> : null}
                </li>,
              ];
            }) : <li role="presentation" className="cmdk-none">{`Nothing matches “${q}”`}</li>}
          </ul>
        </div>
      ) : null}
    </dialog>
  );
}
