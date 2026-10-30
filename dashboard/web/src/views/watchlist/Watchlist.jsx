// The Desk, Level 0 (#/watchlist; DESIGN_AND_IA_BLUEPRINT.md §3.1; Eric,
// 2026-10-17; UI v3 parity, 2026-10-30): the projects you follow as one ledger.
//   focal       the dark Focal block (FocalBlock.jsx): the date, Refresh, Add
//               project, the headline, the ticket to decide first and the
//               folds; it replaces the page head, the hero and the PM cards
//   options     the Desk's ⋯ menu, drawn into the v3 rail's Options slot (in
//               the Focal block below 1280px)
//   market      the market line (StatusStrip.jsx): Bitcoin, Total market,
//               Beat Bitcoin, Trader Sim, and the queues when they hold any;
//               what needs action always in view above it
//   ledger      one white card: the views (Watching · Needs review · Waiting
//               · Held · Not watching · All, an empty one hidden unless it
//               is chosen), search (/), 24h · 7d · 30d (the change under
//               each price), the active filters as removable chips, the
//               table (ProjectTable.jsx) and its footer. Filter, Columns,
//               Sort and Density are in the options menu (D11)
// Choose a project (click, tap, Enter, Space) for its inspector (?p=<id>);
// J/K move the choice, R marks the open project reviewed. Nothing floats over
// the list. Live updates redraw in place and never reorder the rows you are
// reading (Re-sort offers it).
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { announce } from '../../../../public/ui.js';
import {
  COLUMNS, SORT_NAMES, DEFAULT_FILTERS, DEFAULT_COLUMNS, COVERAGE, RET30, BEAT, VIEWS, prefs as readPrefs, prefsToSave, nextSort, sortRows, matches,
  filterCount, sourcesOf, reviewKeyAllowed, inView,
} from '../../../../public/watchlist-model.js';
import { useDesk, useMedia } from '../../lib/hooks.js';
import { useAgendaRead } from '../../lib/agenda.js';
import { ui } from '../../lib/desk.js';
import { nav, pageReady, claimFocus, navigate } from '../../lib/router.js';
import { Menu, MenuItem, MenuLabel, MenuSep, MenuRadio, MenuCheck, MenuSub } from '../../components/Menu.jsx';
import { loadLegacy } from '../../components/Dom.jsx';
import { Boundary, ViewError, retryableLazy } from '../../components/Boundary.jsx';
import { legacyCtx } from '../../legacy/ctx.js';
import { MarketLine, ActionBand } from './StatusStrip.jsx';
import { ProjectTable } from './ProjectTable.jsx';
import { RangeControl } from './RangeControl.jsx';
import { FocalBlock } from './FocalBlock.jsx';
import { view, openPanel, closePanel, isWide, markReviewed, restoreProject } from './state.js';
import { onDesk } from '../../shell/overlays.js';
// The inspector in its own boundary: if it cannot be drawn, it says so in
// its place with Try again and Close, and the list keeps working.
const Inspector = retryableLazy(() => import('../inspector/Inspector.jsx'));

const typing = (el) => Boolean(el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)));

export default function Watchlist() {
  const d = useDesk();
  // The agenda's due items count toward Needs review, as on the rail and the
  // Review page (D3: one project counts once).
  const { a: agenda, settled } = useAgendaRead();
  const route = nav.route;
  const pid = route.query.get('p');
  const wide = useMedia('(min-width: 1280px)');
  const [pf, setPf] = useState(() => readPrefs({ ui }));
  const [q, setQ] = useState(view.q);
  const [, setOrderNonce] = useState(0);
  const search = useRef(null);
  const sources = sourcesOf(d.index, d.session);
  const all = d.index.projects.filter((p) => !p.broken);
  const [reviewBusy, setReviewBusy] = useState(false);

  const save = (next) => {
    setPf(next);
    ui.set('watchlist', prefsToSave(next));
  };
  const resetOrder = () => {
    view.order = null;
    setOrderNonce((n) => n + 1);
  };

  // The rows: fresh on a visit, a sort, a filter or a search; a live update
  // keeps the order you are reading (new projects at the end).
  const key = JSON.stringify([pf.sort, pf.filters, q]);
  const fresh = useMemo(() => sortRows(all.filter((p) => matches(p, pf.filters, q, d.index, agenda)), pf.sort), [d.index, agenda, key]);
  let rows = fresh;
  let reordered = false;
  if (view.order && view.orderKey === key) {
    const pos = new Map(view.order.map((id, i) => [id, i]));
    rows = fresh.slice().sort((a, b) => (pos.has(a.project_id) ? pos.get(a.project_id) : 1e9) - (pos.has(b.project_id) ? pos.get(b.project_id) : 1e9));
    reordered = rows.some((r, i) => r.project_id !== fresh[i].project_id);
  }
  view.order = rows.map((r) => r.project_id);
  view.orderKey = key;

  const live = all.filter((p) => p.status !== 'archived');
  const archivedCount = all.length - live.length;
  const total = all.filter((p) => (pf.filters.archived ? p.status === 'archived' : p.status !== 'archived')).length;
  const f = pf.filters;
  const nFilters = filterCount(f);
  const filtered = Boolean(q) || nFilters > 0;
  const counts = Object.fromEntries(VIEWS.map(([v]) => [v, live.filter((p) => inView(p, v, d.index, agenda)).length]));

  const setFilter = (k, v) => {
    resetOrder();
    save({ ...pf, filters: { ...pf.filters, [k]: v } });
  };
  const setView = (v) => {
    resetOrder();
    save({ ...pf, filters: { ...pf.filters, owned: v, archived: false } });
    announce(`${(VIEWS.find(([x]) => x === v) || [null, v])[1]}: ${counts[v]} project${counts[v] === 1 ? '' : 's'}.`);
  };
  const clearAll = () => {
    view.q = '';
    setQ('');
    resetOrder();
    save({ ...pf, filters: { ...DEFAULT_FILTERS, owned: pf.filters.owned } });
    announce('Search and filters cleared.');
  };
  const setSort = (k) => {
    const sort = nextSort(pf.sort, k);
    resetOrder();
    save({ ...pf, sort });
    announce(`Sorted by ${SORT_NAMES[k][0]}, ${SORT_NAMES[k][sort.dir === 'asc' ? 1 : 2]}. Unknown values are listed last.`);
  };
  const onSector = async (p) => {
    const L = await loadLegacy();
    L.openSectorDialog(legacyCtx, p);
  };
  const addProject = async () => {
    const L = await loadLegacy();
    L.openAddProjectDialog(legacyCtx);
  };
  // The Action verb opens exactly one place.
  const onAction = async (p, a, el) => {
    const enc = encodeURIComponent;
    if (a.kind === 'review') navigate(`#/review?p=${enc(p.project_id)}`);
    else if (a.kind === 'research') { const L = await loadLegacy(); L.openResearchDialog(legacyCtx, p); }
    else if (a.kind === 'resume') navigate(`#/project/${enc(p.project_id)}/record?model=${a.provider}&open=runs`);
    else if (a.kind === 'identity') navigate(`#/project/${enc(p.project_id)}/contract?open=identity`);
    else if (a.kind === 'restore') restoreProject(p);
    else openPanel(p.project_id, el);
  };

  useEffect(() => { if (filtered) announce(`${rows.length} of ${total} projects shown.`); }, [key]);

  // The command menu's Desk commands (shell/overlays.js deskDo).
  useEffect(() => onDesk((c) => {
    if (c.type === 'view' && VIEWS.some(([v]) => v === c.value)) { setView(c.value); announce(`View: ${VIEWS.find(([v]) => v === c.value)[1]}`); }
    else if (c.type === 'density') save({ ...pf, density: c.value === 'compact' ? 'compact' : 'comfortable' });
    else if (c.type === 'reset-columns') save({ ...pf, columns: DEFAULT_COLUMNS.slice() });
    else if (c.type === 'prefs') { resetOrder(); save({ ...pf, ...c.patch, filters: { ...pf.filters, ...(c.patch.filters || {}) } }); }
    else if (c.type === 'columns' || c.type === 'filter') {
      // Open the options menu at that group, by state (§5.6), its first
      // choice focused.
      setMenu({ open: true, sub: c.type });
      setTimeout(() => {
        const menus = document.querySelectorAll('.menu');
        const last = menus[menus.length - 1];
        const first = last && last.querySelector('[role^="menuitem"]');
        if (first) first.focus();
      }, 60);
    }
  }));

  // Arriving: the page is in place; a search asked for from elsewhere.
  useLayoutEffect(() => {
    pageReady();
    if (nav.focusSearch && search.current) {
      nav.focusSearch = false;
      search.current.focus();
      search.current.select();
      claimFocus();
    }
  });

  // After the inspector closes (its button, Escape, Back): focus returns to
  // the project it was opened from; the list stays where it was.
  const lastPid = useRef(pid);
  useLayoutEffect(() => {
    const was = lastPid.current;
    lastPid.current = pid;
    if (was && !pid) {
      view.recent = was;
      const el = (view.returnFocus && document.querySelector(`[data-key="${CSS.escape(view.returnFocus)}"]`)) || document.querySelector(`[data-key="pname-${CSS.escape(was)}"]`);
      if (el) {
        el.focus({ preventScroll: true });
        claimFocus();
      }
      view.returnFocus = null;
    }
  }, [pid]);

  // The list's keys: J/K, Up/Down in a column, R, Space or Enter on a name,
  // Escape. Never while typing, with a dialog or a menu open.
  useEffect(() => {
    const onKey = (e) => {
      const r = nav.route;
      if (!r || r.name !== 'watchlist' || r.query.get('prefs')) return;
      const open = r.query.get('p');
      const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.isComposing;
      const busy = typing(e.target) || document.querySelector('dialog[open]') || document.querySelector('.menu, [role="menu"]');
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && plain && !typing(e.target)) {
        const from = e.target.closest && e.target.closest('.wl-table tbody td');
        if (from) {
          e.preventDefault();
          const tr = from.parentElement;
          const next = e.key === 'ArrowDown' ? tr.nextElementSibling : tr.previousElementSibling;
          if (next) {
            const cell = next.cells[from.cellIndex];
            const target = (cell && cell.querySelector('button')) || next.querySelector('.pname');
            if (target) { target.focus(); target.scrollIntoView({ block: 'nearest' }); }
          }
          return;
        }
      }
      if (plain && !busy && ['j', 'k', 'J', 'K'].includes(e.key)) {
        const ids = view.order || [];
        if (!ids.length) return;
        e.preventDefault();
        const active = document.activeElement;
        const fromRow = active && active.closest ? active.closest('[data-pid]') : null;
        const inInspector = Boolean(active && active.closest && active.closest('.inspector'));
        const cur = fromRow && !inInspector ? fromRow.dataset.pid : open;
        const i = cur ? ids.indexOf(cur) + (e.key.toLowerCase() === 'j' ? 1 : -1) : (e.key.toLowerCase() === 'j' ? 0 : ids.length - 1);
        if (i < 0 || i >= ids.length) return;
        const next = ids[i];
        const name = document.querySelector(`[data-key="pname-${CSS.escape(next)}"]`);
        const inList = !inInspector;
        if (inList && name) {
          name.focus({ preventScroll: true });
          name.closest('[data-pid]').scrollIntoView({ block: 'nearest' });
        }
        if ((open || isWide()) && open !== next) openPanel(next, name, null, { peek: inList && isWide() });
        return;
      }
      if (!typing(e.target) && (e.key === 'r' || e.key === 'R')) {
        const project = open ? d.index.projects.find((x) => x.project_id === open) : null;
        if (reviewKeyAllowed(e, { busy: Boolean(busy) || reviewBusy, project })) {
          e.preventDefault();
          markReviewed(project, { advance: true, onBusy: setReviewBusy });
        }
        return;
      }
      if (plain && (e.key === ' ' || e.key === 'Enter') && e.target.classList && e.target.classList.contains('pname')) {
        const row = e.target.closest('[data-pid]');
        if (row && open === row.dataset.pid) {
          e.preventDefault();
          closePanel();
          return;
        }
        if (row && isWide()) {
          e.preventDefault();
          openPanel(row.dataset.pid, e.target, null, { peek: true });
          announce(`Showing ${d.index.projects.find((x) => x.project_id === row.dataset.pid).name} beside the list. Escape closes it.`);
          return;
        }
      }
      if (e.key === 'Escape' && !document.querySelector('dialog[open]') && !document.querySelector('.menu') && open && !typing(e.target)) {
        closePanel();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const [menu, setMenu] = useState({ open: false, sub: null });
  const sectors = d.index.sectors || [];
  // The active filters as removable "Label | Value" chips (§3.1).
  const chips = [];
  if (q) chips.push({ k: 'Search', v: `“${q}”`, key: 'tok-q', clear: () => { view.q = ''; setQ(''); resetOrder(); if (search.current) search.current.focus(); } });
  if (f.sector) chips.push({ k: 'Sector', v: (sectors.find((s) => s.id === f.sector) || { label: f.sector }).label, key: 'tok-sector', clear: () => setFilter('sector', '') });
  if (f.coverage !== 'any') chips.push({ k: 'Coverage', v: COVERAGE.find(([v]) => v === f.coverage)[1], key: 'tok-coverage', clear: () => setFilter('coverage', 'any') });
  if (f.ret30 !== 'any') chips.push({ k: '30D change', v: f.ret30 === 'pos' ? 'Positive' : 'Negative', key: 'tok-ret30', clear: () => setFilter('ret30', 'any') });
  if (f.beat && f.beat !== 'any') chips.push({ k: 'Against BTC', v: f.beat === 'yes' ? 'Beat BTC (30d)' : 'Behind BTC (30d)', key: 'tok-beat', clear: () => setFilter('beat', 'any') });
  if (f.archived) chips.push({ k: 'View', v: 'Archived', key: 'tok-archived', clear: () => setFilter('archived', false) });

  const onOpen = (id, opener, provider = null) => openPanel(id, opener, provider);
  const selectedRow = pid && d.index.projects.find((x) => x.project_id === pid);
  const cg = d.index.settings && d.index.settings.tickets && d.index.settings.tickets.contract_gate;
  const footer = `${rows.length} of ${total} projects${sources.price !== 'CoinGecko' ? ' · sample data' : ''}${cg && cg.mode === 'enforce' ? ' · gate cr-contract-gate@1 enforced' : ' · gate observing'}`;

  let body;
  if (rows.length) {
    body = <ProjectTable d={d} rows={rows} columns={pf.columns} sort={pf.sort} onSort={setSort} selected={pid} recent={view.recent} onOpen={onOpen} onSector={onSector} onAction={onAction} sources={sources} density={pf.density} agenda={agenda} range={pf.range} />;
  } else if (!live.length && !f.archived) {
    body = <div className="empty-state v3-empty"><p>Your Desk is empty. Add a project to start, or ask for new research.</p><button type="button" className="btn-link" data-key="empty-add" onClick={addProject}>Add project</button></div>;
  } else if (!q && !nFilters && !f.archived) {
    const name = (VIEWS.find(([v]) => v === f.owned) || [null, 'this view'])[1];
    body = <div className="empty-state v3-empty"><p>Nothing here.</p><button type="button" className="btn-link" data-key="empty-all" title={`Nothing in ${name}; ${live.length} project${live.length === 1 ? ' is' : 's are'} saved`} onClick={() => setView('all')}>Show all</button></div>;
  } else {
    body = <div className="empty-state v3-empty"><p>{`Nothing here. ${total} project${total === 1 ? ' is' : 's are'} hidden by the current search or filters.`}</p><button type="button" className="btn-link" data-key="empty-clear" onClick={clearAll}>Clear search and filters</button></div>;
  }

  // The Desk's options (D7): the rail's Options from 1280px, the Focal
  // block's below. One menu, drawn where its trigger is.
  const [slot, setSlot] = useState(null);
  useLayoutEffect(() => {
    const el = document.getElementById('desk-options-slot');
    if (el !== slot) setSlot(el);
  });
  const sortOptions = Object.entries(SORT_NAMES).flatMap(([k, [label, a, z]]) => [[`${k}:asc`, `${label}, ${a}`], [`${k}:desc`, `${label}, ${z}`]]);
  const sortValue = `${pf.sort.key}:${pf.sort.dir}`;
  const subOf = (k) => ({ open: menu.open && menu.sub === k ? true : undefined, onOpenChange: (o) => setMenu((m) => ({ ...m, sub: o ? k : null })) });
  const optionsMenu = (
    <Menu
      label="Desk options"
      align={slot ? 'start' : 'end'}
      side={slot ? 'right' : 'bottom'}
      open={menu.open}
      onOpenChange={(o) => setMenu({ open: o, sub: null })}
      trigger={<button type="button" className={slot ? 'v3-foot-item' : 'v3-focal-link'} aria-label="Desk options" data-key="desk-more">Options</button>}
    >
      <MenuSub label={nFilters ? `Filter (${nFilters})` : 'Filter'} data-key="menu-btn-filters" {...subOf('filter')}>
        <MenuRadio label="Sector" value={f.sector} onChange={(v) => setFilter('sector', v)} options={[['', 'All sectors', live.length], ...sectors.map((x) => [x.id, x.label, live.filter((p) => p.sector && p.sector.primary === x.id).length])]} />
        <MenuSep />
        <MenuRadio label="Model coverage" value={f.coverage} onChange={(v) => setFilter('coverage', v)} options={COVERAGE} />
        <MenuSep />
        <MenuRadio label="30-day change" value={f.ret30} onChange={(v) => setFilter('ret30', v)} options={RET30} />
        <MenuSep />
        <MenuRadio label="Against Bitcoin" value={f.beat || 'any'} onChange={(v) => setFilter('beat', v)} options={BEAT} />
        {nFilters ? <><MenuSep /><MenuItem onSelect={clearAll}>Clear filters</MenuItem></> : null}
      </MenuSub>
      <MenuSub label="Columns" data-key="menu-btn-columns" {...subOf('columns')}>
        <MenuLabel>Show columns</MenuLabel>
        {COLUMNS.map((c) => (
          <MenuCheck
            key={c.id}
            checked={pf.columns.includes(c.id)}
            onChange={(on) => {
              const set = on ? [...new Set([...pf.columns, c.id])] : pf.columns.filter((x) => x !== c.id);
              save({ ...pf, columns: COLUMNS.filter((x) => set.includes(x.id)).map((x) => x.id) });
            }}
          >
            {c.label}
          </MenuCheck>
        ))}
        <p className="menu-note">Narrow windows hide some columns; every value stays in the project details.</p>
        <MenuSep />
        <MenuItem data-key="desk-reset-cols" onSelect={() => save({ ...pf, columns: DEFAULT_COLUMNS.slice() })}>Reset columns</MenuItem>
      </MenuSub>
      <MenuSub label="Sort" data-key="menu-btn-sort" {...subOf('sort')}>
        <MenuRadio
          label="Sort by"
          value={sortValue}
          onChange={(v) => { const dir = v.split(':').pop(); const k = v.slice(0, v.length - dir.length - 1); resetOrder(); save({ ...pf, sort: { key: k, dir } }); }}
          options={sortOptions.map(([v, text]) => [v, text.replace('Rank (CoinGecko)', sources.rankName)])}
        />
      </MenuSub>
      <MenuSub label="Density" data-key="menu-btn-density" {...subOf('density')}>
        <MenuRadio label="Row density" value={pf.density} onChange={(v) => save({ ...pf, density: v })} options={[['comfortable', 'Comfortable'], ['compact', 'Compact']]} />
      </MenuSub>
      <MenuSep />
      <MenuCheck checked={f.archived} onChange={(v) => setFilter('archived', Boolean(v))}>{`Archived projects (${archivedCount})`}</MenuCheck>
      {reordered ? <MenuItem data-key="desk-resort" onSelect={() => { resetOrder(); announce('Re-sorted.'); }}>Re-sort now</MenuItem> : null}
      <MenuItem data-key="desk-new" href="#/new">New research from a link or screenshot</MenuItem>
      <MenuItem data-key="desk-exit-quotes" onSelect={async () => { const L = await loadLegacy(); L.openExitQuotesDialog(legacyCtx); }}>Quote exits for every project…</MenuItem>
    </Menu>
  );

  return (
    <div className={`wl${pid && wide ? ' has-inspector' : ''}`}>
      <div className="wl-main">
        {slot ? createPortal(optionsMenu, slot) : null}
        <FocalBlock d={d} rows={live} agenda={agenda} onAdd={addProject} options={slot ? null : optionsMenu} />
        <ActionBand d={d} />
        <MarketLine d={d} agenda={agenda} settled={settled} sources={sources} filters={f} onView={setView} onBeat={() => setFilter('beat', f.beat === 'yes' ? 'any' : 'yes')} />

        <section className="v3-ledger" aria-label="Projects">
          <div className="v3-ledger-top">
            <nav className="views" aria-label="Views">
              {VIEWS.filter(([v]) => v === 'all' || counts[v] > 0 || (!f.archived && f.owned === v)).map(([v, text]) => (
                <button key={v} type="button" className="view-tab" aria-pressed={!f.archived && f.owned === v} data-key={`owned-${v}`} onClick={() => setView(v)}>
                  <span>{v === 'waiting' ? 'Waiting' : text}</span><span className="view-count">{counts[v]}</span>
                </button>
              ))}
            </nav>
            <div className="v3-ledger-right" role="search" aria-label="Find projects" data-nodirty="1">
              <input
                ref={search}
                className="v3-search"
                type="search"
                placeholder="Search  /"
                aria-label="Search projects"
                aria-keyshortcuts="/"
                data-key="wl-search"
                value={q}
                onChange={(e) => { view.q = e.target.value; setQ(e.target.value); resetOrder(); }}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
                  const first = document.querySelector('.wl .pname');
                  if (e.key === 'ArrowDown' && first) { e.preventDefault(); first.focus(); }
                  else if (e.key === 'Enter' && q.trim() && first) { e.preventDefault(); openPanel(first.closest('[data-pid]').dataset.pid, first); }
                }}
              />
              <RangeControl value={pf.range} onChange={(r) => { if (r !== pf.range) { save({ ...pf, range: r }); announce(`Changes over ${r}.`); } }} />
            </div>
          </div>
          {chips.length ? (
            <ul className="fchips" aria-label="Active filters">
              {chips.map((t) => (
                <li key={t.key} className="fchip">
                  <span className="fchip-k">{t.k}</span><span className="fchip-v">{t.v}</span>
                  <button type="button" aria-label={`Remove filter: ${t.k} ${t.v}`} data-key={t.key} onClick={t.clear}><X size={12} strokeWidth={2.2} aria-hidden="true" /></button>
                </li>
              ))}
              {chips.length > 1 ? <li><button type="button" className="btn-link" data-key="tok-clear" onClick={clearAll}>Clear all</button></li> : null}
            </ul>
          ) : null}
          {reordered ? (
            <p className="reorder" role="status"><span>Values updated; order kept while you read.</span><button type="button" className="btn-link" data-key="resort" onClick={() => { resetOrder(); announce('Re-sorted.'); }}>Re-sort</button></p>
          ) : filtered ? <p className="results-line" role="status">{`${rows.length} of ${total} ${f.archived ? 'archived' : 'saved'} projects`}</p> : null}
          <div className="wl-body">{body}</div>
          <p className="v3-ledger-foot"><span>{footer}</span><span aria-hidden="true">J K to move · R reviewed</span></p>
        </section>
      </div>
      {selectedRow ? (
        <Boundary
          resetKey={pid}
          onRetry={() => Inspector.retry()}
          fallback={(error, retry) => <aside className={`inspector ${wide ? 'is-docked' : 'is-modal'} is-error`} aria-label="Project details"><ViewError error={error} retry={retry} what="The project's details" compact><button type="button" className="btn btn-sm btn-ghost" data-key="panel-close" onClick={closePanel}>Close</button></ViewError></aside>}
        >
          <Suspense fallback={<div className={`inspector ${wide ? 'is-docked' : 'is-modal'} is-loading`} role="status"><span className="sr-only">Loading the project…</span></div>}><Inspector key="inspector" pid={pid} wide={wide} /></Suspense>
        </Boundary>
      ) : null}
    </div>
  );
}
