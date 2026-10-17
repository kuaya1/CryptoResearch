// The Desk, Level 0 (#/watchlist; DESIGN_AND_IA_BLUEPRINT.md §3.1; Eric,
// 2026-10-17): the projects you follow as one ledger.
//   header      eyebrow, title, ⋯ (archived projects, density, reset), Refresh
//               prices, + Add project
//   KPI strip   Market · Total cap · Beat BTC (30d) · Needs review · Research
//               waiting, each a way in; what needs action always in view
//   views       Watching · Needs review · Waiting on a model · Held · Not
//               watching · All, each with its count
//   filter bar  search (/), Filters, the active filters as removable
//               "Label | Value" chips; Density, Columns and Sort on the right
//   ledger      the table (ProjectTable.jsx) with a sticky summary footer
// Choose a project (click, tap, Enter, Space) for its inspector (?p=<id>);
// J/K move the choice, R marks the open project reviewed. Nothing floats over
// the list. Live updates redraw in place and never reorder the rows you are
// reading (Re-sort offers it).
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Search, ListFilter, Columns3, ArrowUpDown, Plus, X, Ellipsis, Rows3 } from 'lucide-react';
import { announce, fmtPrice } from '../../../../public/ui.js';
import {
  COLUMNS, SORT_NAMES, DEFAULT_FILTERS, DEFAULT_COLUMNS, COVERAGE, RET30, BEAT, VIEWS, prefs as readPrefs, prefsToSave, nextSort, sortRows, matches,
  filterCount, sourcesOf, reviewKeyAllowed, inView, deskFooter,
} from '../../../../public/watchlist-model.js';
import { useDesk, useMedia } from '../../lib/hooks.js';
import { useAgendaRead } from '../../lib/agenda.js';
import { ui } from '../../lib/desk.js';
import { nav, pageReady, claimFocus, navigate } from '../../lib/router.js';
import { Menu, MenuItem, MenuLabel, MenuSep, MenuRadio, MenuCheck } from '../../components/Menu.jsx';
import { loadLegacy } from '../../components/Dom.jsx';
import { Boundary, ViewError, retryableLazy } from '../../components/Boundary.jsx';
import { legacyCtx } from '../../legacy/ctx.js';
import { KpiStrip, ActionBand, RefreshButton } from './StatusStrip.jsx';
import { ProjectTable } from './ProjectTable.jsx';
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
  const { a: agenda } = useAgendaRead();
  const route = nav.route;
  const pid = route.query.get('p');
  const wide = useMedia('(min-width: 1280px)');
  const phone = useMedia('(max-width: 767.98px)');
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
  const followed = live.filter((p) => p.on_watchlist || p.held).length;
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
      // Open the Desk's own menu (Radix opens on a key or a pointer, not a click).
      requestAnimationFrame(() => {
        const b = document.querySelector(`[data-key="${c.type === 'columns' ? 'menu-btn-columns' : 'menu-btn-filters'}"]`);
        if (!b) return;
        b.focus();
        b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
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
  const foot = deskFooter(d.index, rows);
  const footer = `${foot.projects} project${foot.projects === 1 ? '' : 's'} · ${foot.held} held${foot.priced !== null ? ` · ${fmtPrice(foot.priced)} priced value` : ''}${foot.unpriced ? ` · ${foot.unpriced} unpriced` : ''}`;

  let body;
  if (rows.length) {
    body = <ProjectTable d={d} rows={rows} columns={pf.columns} sort={pf.sort} onSort={setSort} selected={pid} recent={view.recent} onOpen={onOpen} onSector={onSector} onAction={onAction} sources={sources} density={pf.density} footer={footer} agenda={agenda} />;
  } else if (!live.length && !f.archived) {
    body = <div className="empty-state"><h2>Your Desk is empty</h2><p>Add a project to start, or ask for new research.</p><button type="button" className="btn btn-primary" data-key="empty-add" onClick={addProject}>Add project</button></div>;
  } else if (!q && !nFilters && !f.archived) {
    const name = (VIEWS.find(([v]) => v === f.owned) || [null, 'this view'])[1];
    body = <div className="empty-state"><h2>{`Nothing in ${name}`}</h2><p>{`${live.length} project${live.length === 1 ? ' is' : 's are'} saved.`}</p><button type="button" className="btn" data-key="empty-all" onClick={() => setView('all')}>Show all</button></div>;
  } else {
    body = <div className="empty-state"><h2>No projects match</h2><p>{`${total} project${total === 1 ? ' is' : 's are'} hidden by the current search or filters.`}</p><button type="button" className="btn" data-key="empty-clear" onClick={clearAll}>Clear search and filters</button></div>;
  }

  const sortOptions = Object.entries(SORT_NAMES).flatMap(([k, [label, a, z]]) => [[`${k}:asc`, `${label}, ${a}`], [`${k}:desc`, `${label}, ${z}`]]);
  const sortValue = `${pf.sort.key}:${pf.sort.dir}`;

  return (
    <div className={`wl${pid && wide ? ' has-inspector' : ''}`}>
      <div className="wl-main">
        <header className="page-head wl-head">
          <div className="ph-title">
            <p className="ph-eyebrow">CryptoResearch</p>
            <h1>Desk<span className="ph-count" title={`${followed} project${followed === 1 ? '' : 's'} you watch or hold`}>{followed}</span></h1>
          </div>
          <div className="ph-actions">
            <Menu
              label="Desk options"
              align="end"
              trigger={<button type="button" className="btn btn-ghost btn-icon" aria-label="Desk options" data-key="desk-more"><Ellipsis size={18} aria-hidden="true" /></button>}
            >
              <MenuCheck checked={f.archived} onChange={(v) => setFilter('archived', Boolean(v))}>{`Archived projects (${archivedCount})`}</MenuCheck>
              <MenuSep />
              <MenuItem data-key="desk-reset-cols" onSelect={() => save({ ...pf, columns: DEFAULT_COLUMNS.slice() })}>Reset columns</MenuItem>
              {reordered ? <MenuItem data-key="desk-resort" onSelect={() => { resetOrder(); announce('Re-sorted.'); }}>Re-sort now</MenuItem> : null}
              <MenuItem data-key="desk-new" href="#/new">New research from a link or screenshot</MenuItem>
            </Menu>
            {phone ? null : <RefreshButton d={d} />}
            <button type="button" className="btn btn-primary" id="add-project-btn" data-key="add-project" onClick={addProject}>
              <Plus size={15} strokeWidth={2} aria-hidden="true" />
              <span>Add project</span>
            </button>
          </div>
        </header>

        <KpiStrip d={d} agenda={agenda} sources={sources} filters={f} onView={setView} onBeat={() => setFilter('beat', f.beat === 'yes' ? 'any' : 'yes')} />
        <ActionBand d={d} />

        <nav className="views" aria-label="Views">
          {VIEWS.map(([v, text]) => (
            <button key={v} type="button" className="view-tab" aria-pressed={!f.archived && f.owned === v} data-key={`owned-${v}`} onClick={() => setView(v)}>
              <span>{text}</span><span className="view-count">{counts[v]}</span>
            </button>
          ))}
        </nav>

        <div className="toolbar" role="search" aria-label="Find and filter projects" data-nodirty="1">
          <div className="search wl-search">
            <Search className="search-ico" size={15} strokeWidth={1.9} aria-hidden="true" />
            <input
              ref={search}
              className="input"
              type="search"
              placeholder="Search name, ticker or sector"
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
            <kbd aria-hidden="true">/</kbd>
          </div>
          <Menu
            label="Filters"
            trigger={<button type="button" className={`btn${nFilters ? ' is-on' : ''}`} data-key="menu-btn-filters"><ListFilter size={15} strokeWidth={1.9} aria-hidden="true" /><span>Filter</span>{nFilters ? <span className="btn-count">{nFilters}<span className="sr-only"> active</span></span> : null}</button>}
          >
            <MenuRadio label="Sector" value={f.sector} onChange={(v) => setFilter('sector', v)} options={[['', 'All sectors', live.length], ...sectors.map((s) => [s.id, s.label, live.filter((p) => p.sector && p.sector.primary === s.id).length])]} />
            <MenuSep />
            <MenuRadio label="Model coverage" value={f.coverage} onChange={(v) => setFilter('coverage', v)} options={COVERAGE} />
            <MenuSep />
            <MenuRadio label="30-day change" value={f.ret30} onChange={(v) => setFilter('ret30', v)} options={RET30} />
            <MenuSep />
            <MenuRadio label="Against Bitcoin" value={f.beat || 'any'} onChange={(v) => setFilter('beat', v)} options={BEAT} />
            {nFilters ? <><MenuSep /><MenuItem onSelect={clearAll}>Clear filters</MenuItem></> : null}
          </Menu>
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
          <div className="tb-right">
            <Menu
              label="Density"
              align="end"
              trigger={<button type="button" className="btn btn-icon" data-key="menu-btn-density" aria-label={`Density: ${pf.density}`} title="Density"><Rows3 size={15} strokeWidth={1.9} aria-hidden="true" /></button>}
            >
              <MenuRadio label="Row density" value={pf.density} onChange={(v) => save({ ...pf, density: v })} options={[['comfortable', 'Comfortable'], ['compact', 'Compact']]} />
            </Menu>
            <Menu
              label="Columns"
              align="end"
              trigger={<button type="button" className="btn" data-key="menu-btn-columns"><Columns3 size={15} strokeWidth={1.9} aria-hidden="true" /><span className="tb-lbl">Columns</span></button>}
            >
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
              <MenuItem onSelect={() => save({ ...pf, columns: DEFAULT_COLUMNS.slice() })}>Reset columns</MenuItem>
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
          </div>
        </div>

        {reordered ? (
          <p className="reorder" role="status"><span>Values updated; order kept while you read.</span><button type="button" className="btn-link" data-key="resort" onClick={() => { resetOrder(); announce('Re-sorted.'); }}>Re-sort</button></p>
        ) : filtered ? <p className="results-line" role="status">{`${rows.length} of ${total} ${f.archived ? 'archived' : 'saved'} projects`}</p> : null}

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
