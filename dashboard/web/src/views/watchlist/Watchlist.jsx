// Watchlist: the projects you follow, what moved, what each model thinks.
//   choose a project (click, tap, Enter, Space) -> its inspector (?p=<id>)
//   choose a model's grade                       -> the inspector, on that model
// Nothing floats over the list: there is no hover card. The inspector docks
// beside the list from 1280px and is a drawer over it below (full screen on
// a phone). Live updates redraw in place and never reorder the rows you are
// reading (Re-sort offers it).
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Search, ListFilter, Columns3, ArrowUpDown, Plus, X } from 'lucide-react';
import { announce } from '../../../../public/ui.js';
import {
  COLUMNS, SORT_NAMES, DEFAULT_FILTERS, COVERAGE, RET30, OWNED, prefs as readPrefs, prefsToSave, nextSort, sortRows, matches,
  filterCount, sourcesOf, needsReview, reviewKeyAllowed,
} from '../../../../public/watchlist-model.js';
import { useDesk, useMedia } from '../../lib/hooks.js';
import { ui } from '../../lib/desk.js';
import { nav, pageReady, claimFocus } from '../../lib/router.js';
import { Menu, MenuItem, MenuLabel, MenuSep, MenuRadio, MenuCheck } from '../../components/Menu.jsx';
import { loadLegacy } from '../../components/Dom.jsx';
import { Boundary, ViewError, retryableLazy } from '../../components/Boundary.jsx';
import { legacyCtx } from '../../legacy/ctx.js';
import { StatusStrip } from './StatusStrip.jsx';
import { ProjectTable, ProjectCards } from './ProjectTable.jsx';
import { view, openPanel, closePanel, isWide, markReviewed } from './state.js';
// The inspector in its own boundary: if it cannot be drawn, it says so in
// its place with Try again and Close, and the list keeps working.
const Inspector = retryableLazy(() => import('../inspector/Inspector.jsx'));

const typing = (el) => Boolean(el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)));

function useWidth(ref) {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setW(el.clientWidth);
    if (typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return w;
}

export default function Watchlist() {
  const d = useDesk();
  const route = nav.route;
  const pid = route.query.get('p');
  const wide = useMedia('(min-width: 1280px)');
  const [pf, setPf] = useState(() => readPrefs({ ui }));
  const [q, setQ] = useState(view.q);
  const [, setOrderNonce] = useState(0);
  const mainRef = useRef(null);
  const search = useRef(null);
  const width = useWidth(mainRef);
  const cards = width > 0 && width < 720;
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
  const fresh = useMemo(() => sortRows(all.filter((p) => matches(p, pf.filters, q)), pf.sort), [d.index, key]);
  let rows = fresh;
  let reordered = false;
  if (view.order && view.orderKey === key) {
    const pos = new Map(view.order.map((id, i) => [id, i]));
    rows = fresh.slice().sort((a, b) => (pos.has(a.project_id) ? pos.get(a.project_id) : 1e9) - (pos.has(b.project_id) ? pos.get(b.project_id) : 1e9));
    reordered = rows.some((r, i) => r.project_id !== fresh[i].project_id);
  }
  view.order = rows.map((r) => r.project_id);
  view.orderKey = key;

  const total = all.filter((p) => (pf.filters.archived ? p.status === 'archived' : p.status !== 'archived')).length;
  const filtered = Boolean(q) || filterCount(pf.filters) > 0 || pf.filters.owned !== DEFAULT_FILTERS.owned;
  const followed = all.filter((p) => p.status !== 'archived' && (p.on_watchlist || p.held)).length;

  const setFilter = (k, v) => {
    resetOrder();
    save({ ...pf, filters: { ...pf.filters, [k]: v } });
  };
  const clearAll = () => {
    view.q = '';
    setQ('');
    resetOrder();
    save({ ...pf, filters: { ...DEFAULT_FILTERS } });
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

  useEffect(() => { if (filtered) announce(`${rows.length} of ${total} projects shown.`); }, [key]);

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
      if (!r || r.name !== 'watchlist') return;
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

  const f = pf.filters;
  const sectors = d.index.sectors || [];
  const live = all.filter((p) => p.status !== 'archived');
  const tokens = [];
  if (q) tokens.push({ label: `Search: “${q}”`, key: 'tok-q', clear: () => { view.q = ''; setQ(''); resetOrder(); if (search.current) search.current.focus(); } });
  if (f.sector) tokens.push({ label: `Sector: ${(sectors.find((s) => s.id === f.sector) || { label: f.sector }).label}`, key: 'tok-sector', clear: () => setFilter('sector', '') });
  if (f.coverage !== 'any') tokens.push({ label: COVERAGE.find(([v]) => v === f.coverage)[1], key: 'tok-coverage', clear: () => setFilter('coverage', 'any') });
  if (f.ret30 !== 'any') tokens.push({ label: `30D ${f.ret30 === 'pos' ? 'positive' : 'negative'}`, key: 'tok-ret30', clear: () => setFilter('ret30', 'any') });
  if (f.archived) tokens.push({ label: 'Archived only', key: 'tok-archived', clear: () => setFilter('archived', false) });

  const onOpen = (id, opener, provider = null) => openPanel(id, opener, provider);
  const selectedRow = pid && d.index.projects.find((x) => x.project_id === pid);
  const nFilters = filterCount(f);

  let body;
  if (rows.length) {
    body = cards
      ? <ProjectCards d={d} rows={rows} selected={pid} recent={view.recent} onOpen={onOpen} />
      : <ProjectTable d={d} rows={rows} columns={pf.columns} sort={pf.sort} onSort={setSort} selected={pid} recent={view.recent} onOpen={onOpen} onSector={onSector} sources={sources} />;
  } else if (!live.length && !f.archived) {
    body = <div className="empty-state"><h2>Your watchlist is empty</h2><p>Add a project to start, or ask for new research.</p><button type="button" className="btn btn-primary" data-key="empty-add" onClick={addProject}>Add project</button></div>;
  } else if (f.owned === 'watching' && !q && !nFilters) {
    body = <div className="empty-state"><h2>Nothing on your watchlist</h2><p>{`${total} project${total === 1 ? ' is' : 's are'} saved but not watched.`}</p><button type="button" className="btn" data-key="empty-off" onClick={() => setFilter('owned', 'off')}>Show not watching</button></div>;
  } else {
    body = <div className="empty-state"><h2>No projects match</h2><p>{`${total} project${total === 1 ? ' is' : 's are'} hidden by the current search or filters.`}</p><button type="button" className="btn" data-key="empty-clear" onClick={clearAll}>Clear search and filters</button></div>;
  }

  const sortOptions = Object.entries(SORT_NAMES).flatMap(([k, [label, a, z]]) => [[`${k}:asc`, `${label}, ${a}`], [`${k}:desc`, `${label}, ${z}`]]);
  const sortValue = `${pf.sort.key}:${pf.sort.dir}`;

  return (
    <div className={`wl${pid && wide ? ' has-inspector' : ''}`}>
      <div className="wl-main" ref={mainRef}>
        <header className="page-head wl-head">
          <div className="ph-title">
            <h1>Watchlist</h1>
            <span className="ph-count" title={`${followed} project${followed === 1 ? '' : 's'} you watch or hold`}>{followed}</span>
          </div>
          <div className="ph-actions">
            <button type="button" className="btn btn-primary" id="add-project-btn" data-key="add-project" onClick={addProject}>
              <Plus size={15} strokeWidth={2} aria-hidden="true" />
              <span>Add project</span>
            </button>
          </div>
        </header>

        <StatusStrip d={d} sources={sources} />

        <div className="toolbar" role="search" aria-label="Find and filter projects" data-nodirty="1">
          <div className="search wl-search">
            <Search className="search-ico" size={15} strokeWidth={1.9} aria-hidden="true" />
            <input
              ref={search}
              className="input"
              type="search"
              placeholder="Search name, ticker or sector"
              aria-label="Search projects"
              aria-keyshortcuts="/ Control+K Meta+K"
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
            <kbd aria-hidden="true" title={`Also ${/Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘K' : 'Ctrl K'}`}>/</kbd>
          </div>
          <div className="seg" role="group" aria-label="Show">
            {OWNED.map(([v, text]) => <button key={v} type="button" aria-pressed={v === f.owned} data-key={`owned-${v}`} onClick={() => setFilter('owned', v)}>{text}</button>)}
          </div>
          <div className="tb-right">
            <Menu
              label="Filters"
              trigger={<button type="button" className={`btn${nFilters ? ' is-on' : ''}`} data-key="menu-btn-filters"><ListFilter size={15} strokeWidth={1.9} aria-hidden="true" /><span>Filters</span>{nFilters ? <span className="btn-count">{nFilters}<span className="sr-only"> active</span></span> : null}</button>}
            >
              <MenuRadio label="Sector" value={f.sector} onChange={(v) => setFilter('sector', v)} options={[['', 'All sectors', live.length], ...sectors.map((s) => [s.id, s.label, live.filter((p) => p.sector && p.sector.primary === s.id).length])]} />
              <MenuSep />
              <MenuRadio label="Model coverage" value={f.coverage} onChange={(v) => setFilter('coverage', v)} options={COVERAGE} />
              <MenuSep />
              <MenuRadio label="30-day change" value={f.ret30} onChange={(v) => setFilter('ret30', v)} options={RET30} />
              <MenuSep />
              <MenuLabel>Archive</MenuLabel>
              <MenuCheck checked={f.archived} onChange={(v) => setFilter('archived', Boolean(v))}>Show archived projects only</MenuCheck>
              {nFilters ? <><MenuSep /><MenuItem onSelect={clearAll}>Clear filters</MenuItem></> : null}
            </Menu>
            <Menu
              label="Sort projects"
              align="end"
              trigger={<button type="button" className="btn" data-key="menu-btn-sort" aria-label={`Sort: ${SORT_NAMES[pf.sort.key][0]}, ${SORT_NAMES[pf.sort.key][pf.sort.dir === 'asc' ? 1 : 2]}`}><ArrowUpDown size={15} strokeWidth={1.9} aria-hidden="true" /><span className="tb-sort-lbl">{SORT_NAMES[pf.sort.key][0].replace(' (CoinGecko)', '').replace(' (demo data)', '')}</span></button>}
            >
              <MenuRadio
                label="Sort by"
                value={sortValue}
                onChange={(v) => { const dir = v.split(':').pop(); const k = v.slice(0, v.length - dir.length - 1); resetOrder(); save({ ...pf, sort: { key: k, dir } }); }}
                options={sortOptions.map(([v, text]) => [v, text.replace('Rank (CoinGecko)', sources.rankName)])}
              />
            </Menu>
            {cards ? null : (
              <Menu
                label="Columns"
                align="end"
                trigger={<button type="button" className="btn" data-key="menu-btn-columns"><Columns3 size={15} strokeWidth={1.9} aria-hidden="true" /><span>Columns</span></button>}
              >
                <MenuLabel>Show columns</MenuLabel>
                {COLUMNS.filter((c) => c.id !== 'research').map((c) => (
                  <MenuCheck
                    key={c.id}
                    checked={pf.columns.includes(c.id)}
                    disabled={Boolean(c.disabled)}
                    desc={c.disabled || null}
                    onChange={(on) => {
                      const set = on ? [...new Set([...pf.columns, c.id])] : pf.columns.filter((x) => x !== c.id);
                      save({ ...pf, columns: COLUMNS.filter((x) => set.includes(x.id) || x.id === 'research').map((x) => x.id) });
                    }}
                  >
                    {c.label}
                  </MenuCheck>
                ))}
                <p className="menu-note">Narrow windows hide some columns; every value stays in the project details.</p>
                <MenuSep />
                <MenuItem onSelect={() => save({ ...pf, columns: COLUMNS.filter((c) => c.def).map((c) => c.id) })}>Reset columns</MenuItem>
              </Menu>
            )}
          </div>
        </div>

        {tokens.length || filtered || reordered ? (
          <div className="results-line" role="status">
            {filtered ? <span className="rl-count">{`${rows.length} of ${total} ${f.archived ? 'archived' : 'saved'} projects`}</span> : null}
            {tokens.map((t) => (
              <span key={t.key} className="token">
                {t.label}
                <button type="button" aria-label={`Remove filter: ${t.label}`} data-key={t.key} onClick={t.clear}><X size={12} strokeWidth={2.2} aria-hidden="true" /></button>
              </span>
            ))}
            {tokens.length ? <button type="button" className="btn-link" data-key="tok-clear" onClick={clearAll}>Clear all</button> : null}
            {reordered ? <span className="reorder"><span>Values updated; order kept while you read.</span><button type="button" className="btn btn-sm" data-key="resort" onClick={() => { resetOrder(); announce('Re-sorted.'); }}>Re-sort</button></span> : null}
          </div>
        ) : null}

        <div className="wl-body">{body}</div>
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
