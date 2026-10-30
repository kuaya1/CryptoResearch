// The desk's frame (DESIGN_AND_IA_BLUEPRINT.md §3.0; the platform look,
// Eric, 2026-10-26): a transparent sidebar on the canvas, 260px with its
// words or 56px with its icons only (your choice, kept in this browser; the
// icons only from 1023px down): the 32px workspace row and the collapse
// toggle, the four daily places (Desk, Review, Portfolio, Research) as 36px
// rows with the current one's pill, and a count only where it means "needs
// you" (Review, caution; Portfolio, info); at its foot the command menu (⌘K),
// the Daily Brief, Preferences (⌘,) and the workspace block with the
// connection and Sign out (the online desk). On
// a phone: a top bar (the wordmark, the Test or Demo tag, search, the
// connection) and a tab bar (Desk, Review, Portfolio, More).
import { useEffect, useRef, useState } from 'react';
import { Ellipsis, LogOut, X, Search, Settings, PanelLeftClose, PanelLeftOpen, SquarePen, FlaskConical, Newspaper } from 'lucide-react';
import { store } from '../../../public/ui.js';
import { useDesk } from '../lib/hooks.js';
import { useAgendaRead } from '../lib/agenda.js';
import { liveStatus } from '../lib/desk.js';
import { nav } from '../lib/router.js';
import { visibleSections, navCounts, SECTIONS } from './sections.js';
import { openCommand, openPrefs, openBrief, prefsOf } from './overlays.js';
import { Mark } from '../components/Mark.jsx';

const mac = () => /Mac|iPhone|iPad/.test(navigator.platform || '');

function activeOf(route) {
  if (!route) return 'watchlist';
  if (route.name === 'project') return 'watchlist';
  if (route.name === 'updates' || route.name === 'agenda') return 'review';
  if (route.name === 'research' && route.query && route.query.get('tab') === 'outcomes') return 'outcomes';
  return route.name;
}

function NavItem({ s, active, count, compact = false, onClick, iconSize = 20 }) {
  const Icon = s.icon;
  const on = s.id === active;
  return (
    <a
      href={s.href || `#/${s.id}`}
      className={`nav-item${on ? ' is-active' : ''}`}
      aria-current={on ? 'page' : undefined}
      aria-label={`${s.label}${count ? `, ${count.title}` : ''}`}
      title={compact ? `${s.label}${count ? ` · ${count.title}` : ''}` : undefined}
      data-key={`nav-${s.id}`}
      onClick={onClick}
    >
      <Icon className="nav-ico" size={iconSize} strokeWidth={1.75} aria-hidden="true" />
      <span className="nav-label">{s.label}</span>
      {count ? <span className={`nav-count ${count.tone || 'is-info'}`} aria-hidden="true" title={count.title}>{count.n}</span> : null}
    </a>
  );
}

// The connection: a dot and its word; its tooltip carries the data's
// freshness (§3.5: "freshness also as the rail footer Live dot tooltip").
function LiveDot() {
  const d = useDesk();
  const st = liveStatus();
  const m = d.index && d.index.freshness && d.index.freshness.market;
  const fresh = m && m.last_success_at ? `Prices refreshed ${new Date(m.last_success_at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'Prices not fetched yet';
  return (
    <span className={`live live-${st.tone || 'idle'}`} title={`${st.title || 'Connection to the desk'} · ${fresh}`} data-mode={nav.route ? 'ok' : 'boot'}>
      <span className="live-dot" aria-hidden="true" />
      <span className="live-label">{st.label}</span>
    </span>
  );
}

function SignOut({ className = '' }) {
  return (
    <form method="post" action="/logout" className={`signout ${className}`.trim()}>
      <button type="submit" className="btn btn-ghost btn-sm signout-btn" data-key="nav-signout" title="Sign out">
        <LogOut size={15} strokeWidth={1.75} aria-hidden="true" />
        <span className="nav-label">Sign out</span>
      </button>
    </form>
  );
}

const RAIL_KEY = 'rail';
export function railCollapsed() {
  try { return store.get(RAIL_KEY, false) === true; } catch (_) { return false; }
}

export function Sidebar({ collapsed, onCollapse }) {
  const d = useDesk();
  const active = activeOf(nav.route);
  const { a: agenda, settled } = useAgendaRead();
  const counts = navCounts(d.index, agenda, { settled });
  const list = visibleSections(d, active);
  const ws = d.session && d.session.workspace;
  const kind = ws && ws.kind !== 'real' ? (ws.kind === 'demo' ? 'Demo' : 'Test') : null;
  const prefsOpen = Boolean(prefsOf());
  return (
    <aside className={`sidebar${collapsed ? ' is-collapsed' : ''}`} aria-label="Desk">
      <div className="sb-brand">
        <a className="brand sb-ws" href="#/watchlist" data-key="nav-brand" title="CryptoResearch: the Desk">
          <Mark className="brand-mark" />
          <span className="brand-word">CryptoResearch</span>
          {kind ? <span className="ws-tag" title={`${kind} workspace: fictional data`}>{kind}</span> : null}
        </a>
        <button type="button" className="btn btn-ghost btn-icon sb-collapse" data-key="nav-collapse" aria-label={collapsed ? 'Show the rail with its words' : 'Collapse the rail to its icons'} title={collapsed ? 'Expand' : 'Collapse'} onClick={onCollapse}>
          {collapsed ? <PanelLeftOpen size={18} aria-hidden="true" /> : <PanelLeftClose size={18} aria-hidden="true" />}
        </button>
      </div>
      {kind && !collapsed ? <p className="sb-demo">{`${ws.kind === 'demo' ? 'Fictional demo data' : 'Test workspace'}: not real research, prices or holdings`}</p> : null}
      <nav className="sb-nav" aria-label="Main">
        {list.map((s) => <NavItem key={s.id} s={s} active={active} count={counts[s.id]} compact={collapsed} />)}
      </nav>
      <div className="sb-foot">
        <button type="button" className="nav-item sb-util" data-key="nav-command" aria-keyshortcuts={mac() ? 'Meta+K' : 'Control+K'} title={collapsed ? `Search and commands (${mac() ? '⌘K' : 'Ctrl K'})` : undefined} onClick={() => openCommand()}>
          <Search className="nav-ico" size={20} strokeWidth={1.75} aria-hidden="true" />
          <span className="nav-label">Search</span>
          <kbd className="nav-kbd" aria-hidden="true">{mac() ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        <button type="button" className="nav-item sb-util" data-key="nav-brief" title={collapsed ? 'Daily Brief' : undefined} onClick={() => openBrief()}>
          <Newspaper className="nav-ico" size={20} strokeWidth={1.75} aria-hidden="true" />
          <span className="nav-label">Daily Brief</span>
        </button>
        <button type="button" className={`nav-item sb-util${prefsOpen ? ' is-on' : ''}`} data-key="nav-settings" aria-keyshortcuts={mac() ? 'Meta+Comma' : 'Control+Comma'} aria-expanded={prefsOpen} title={collapsed ? 'Preferences' : undefined} onClick={() => openPrefs('appearance')}>
          <Settings className="nav-ico" size={20} strokeWidth={1.75} aria-hidden="true" />
          <span className="nav-label">Preferences</span>
        </button>
        <div className="sb-status sb-org">
          <span className="sb-avatar" aria-hidden="true">{((ws && ws.name) || 'CryptoResearch').trim().charAt(0).toUpperCase()}</span>
          <span className="sb-org-text">
            <span className="sb-org-name" title={ws && ws.name ? ws.name : undefined}>{(ws && ws.name) || 'CryptoResearch'}</span>
            <LiveDot />
          </span>
          {d.session && d.session.hosted ? <SignOut /> : null}
        </div>
      </div>
    </aside>
  );
}

// The v3 rail (UI v3 parity, 2026-10-30, D4): the Desk from 1280px. A 150px
// text rail on the canvas: the CR tile, the five places as words with a 4px
// dot for the current one and a count only when something waits, then at its
// foot Search (⌘K), the Desk's Options (its menu is drawn by the Desk into
// #desk-options-slot), the Daily Brief and the connection. Preferences stays
// on ⌘, and in the command menu; Sign out sits under the connection online.
const TONE = { on: 'is-live', wait: 'is-warn', off: 'is-down' };
export function SidebarV3() {
  const d = useDesk();
  const active = activeOf(nav.route);
  const { a: agenda, settled } = useAgendaRead();
  const counts = navCounts(d.index, agenda, { settled });
  const ws = d.session && d.session.workspace;
  const st = liveStatus();
  const name = (ws && ws.name) || 'CryptoResearch';
  const word = st.label ? st.label.charAt(0).toLowerCase() + st.label.slice(1) : '';
  return (
    <aside className="sidebar v3" aria-label="Desk">
      <div className="v3-brand">
        <a className="v3-tile" href="#/watchlist" data-key="nav-brand" title="CryptoResearch: the Desk" aria-label="CryptoResearch: the Desk">CR</a>
        <WsTag />
      </div>
      <nav className="v3-nav" aria-label="Main">
        {visibleSections(d, active).map((s) => {
          const on = s.id === active;
          const c = counts[s.id];
          const n = c && typeof c.n === 'number' && c.n > 0 ? c : null;
          return (
            <a key={s.id} href={s.href || `#/${s.id}`} className={`v3-nav-item${on ? ' is-active' : ''}`} aria-current={on ? 'page' : undefined} aria-label={`${s.label}${n ? `, ${n.title}` : ''}`} data-key={`nav-${s.id}`}>
              <span className="v3-mark" aria-hidden="true" />
              <span>{s.label}</span>
              {n ? <span className="v3-count" aria-hidden="true" title={n.title}>{n.n}</span> : null}
            </a>
          );
        })}
      </nav>
      <span className="v3-spacer" />
      <div className="v3-foot">
        <button type="button" className="v3-foot-item" data-key="nav-command" aria-keyshortcuts={mac() ? 'Meta+K' : 'Control+K'} onClick={() => openCommand()}>
          <span>Search</span><kbd className="v3-kbd" aria-hidden="true">{mac() ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        <div className="v3-slot" id="desk-options-slot" />
        <button type="button" className="v3-foot-item" data-key="nav-brief" onClick={() => openBrief()}>Daily Brief</button>
        <span className={`v3-live ${TONE[st.tone] || ''}`.trim()} title={st.title || 'Connection to the desk'}>
          <span className="v3-live-dot" aria-hidden="true" />
          <span className="v3-live-label">{`${name} · ${word}`}</span>
        </span>
        {d.session && d.session.hosted ? (
          <form method="post" action="/logout" className="signout">
            <button type="submit" className="v3-foot-item" data-key="nav-signout">Sign out</button>
          </form>
        ) : null}
      </div>
    </aside>
  );
}

// A phone: the main places in a tab bar, the rest under More.
const MORE = [
  { id: 'research', label: 'Research', icon: FlaskConical },
  SECTIONS.find((s) => s.id === 'outcomes'),
  { id: 'new', label: 'New research', icon: SquarePen },
];
export function TabBar() {
  const d = useDesk();
  const [open, setOpen] = useState(false);
  const active = activeOf(nav.route);
  const { a: agenda, settled } = useAgendaRead();
  const counts = navCounts(d.index, agenda, { settled });
  const primary = ['watchlist', 'review', 'portfolio'];
  const moreActive = MORE.some((s) => s.id === active);
  const sheet = useRef(null);
  const btn = useRef(null);
  useEffect(() => {
    const dlg = sheet.current;
    if (!dlg) return;
    if (open && !dlg.open) dlg.showModal();
    if (!open && dlg.open) dlg.close();
  }, [open]);
  useEffect(() => { setOpen(false); }, [nav.route && nav.route.name]);
  return (
    <>
      <nav className="tabbar" aria-label="Main">
        {primary.map((id) => {
          const s = SECTIONS.find((x) => x.id === id);
          return s ? <NavItem key={id} s={s} active={active} count={counts[id]} compact /> : null;
        })}
        <button type="button" ref={btn} className={`nav-item tab-more${moreActive ? ' is-active' : ''}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} data-key="nav-more">
          <Ellipsis className="nav-ico" size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className="nav-label">More</span>
        </button>
      </nav>
      <dialog
        ref={sheet}
        className="msheet"
        aria-label="More pages"
        onClose={() => { setOpen(false); if (btn.current) btn.current.focus(); }}
        onClick={(e) => { if (e.target === sheet.current) setOpen(false); }}
      >
        <div className="msheet-head">
          <span className="msheet-title">More</span>
          <button type="button" className="btn btn-ghost btn-icon" aria-label="Close" onClick={() => setOpen(false)}><X size={18} aria-hidden="true" /></button>
        </div>
        <div className="msheet-list">
          {MORE.map((s) => <NavItem key={s.id} s={s} active={active} count={null} onClick={() => setOpen(false)} />)}
          <button type="button" className="nav-item" data-key="more-command" onClick={() => { setOpen(false); openCommand(); }}>
            <Search className="nav-ico" size={16} strokeWidth={1.75} aria-hidden="true" /><span className="nav-label">Search and commands</span>
          </button>
          <button type="button" className="nav-item" data-key="more-prefs" onClick={() => { setOpen(false); openPrefs('appearance'); }}>
            <Settings className="nav-ico" size={16} strokeWidth={1.75} aria-hidden="true" /><span className="nav-label">Preferences</span>
          </button>
        </div>
        <div className="msheet-foot">
          <LiveDot />
          {d.session && d.session.hosted ? <SignOut /> : null}
        </div>
      </dialog>
    </>
  );
}

// The Test or Demo tag of a workspace that is not real; on a phone it is the
// whole notice (no banner row above the work). Nothing for a real workspace.
export function WsTag() {
  const d = useDesk();
  const ws = d.session && d.session.workspace;
  const kind = ws && ws.kind !== 'real' ? (ws.kind === 'demo' ? 'Demo' : 'Test') : null;
  if (!kind) return null;
  const notice = `${ws.kind === 'demo' ? 'Fictional demo data' : 'Test workspace'}: not real research, prices or holdings`;
  return <span className="ws-tag" title={notice}><span aria-hidden="true">{kind}</span><span className="sr-only">{notice}</span></span>;
}

// A phone's top bar: the wordmark, search (the command menu) and the
// connection. A project opened from the inspector puts its back bar here
// instead (html.has-backbar).
export function TopBar() {
  return (
    <header className="topbar">
      <a className="brand" href="#/watchlist" data-key="top-brand">
        <Mark className="brand-mark" />
        <span className="brand-word">CryptoResearch</span>
      </a>
      <WsTag />
      <span className="spacer" />
      <button type="button" className="btn btn-ghost btn-icon topbar-search" data-key="top-search" aria-label="Search and commands" onClick={() => openCommand()}><Search size={18} aria-hidden="true" /></button>
      <button type="button" className="btn btn-ghost btn-icon topbar-brief" data-key="top-brief" aria-label="Daily Brief" onClick={() => openBrief()}><Newspaper size={18} aria-hidden="true" /></button>
      <LiveDot />
    </header>
  );
}

export function DemoBanner() {
  const d = useDesk();
  const ws = d.session && d.session.workspace;
  if (!ws || ws.kind === 'real') return null;
  return <div className="demo-banner">{ws.kind === 'demo' ? 'Fictional demo data' : 'Test workspace'}: not real research, prices or holdings</div>;
}

export function saveRail(on) {
  try { store.set(RAIL_KEY, Boolean(on)); } catch (_) { /* a private window */ }
}

// The command bar (the Architecture restyle, 2026-10-29): a floating glass
// bar at the foot of the page from 1024px, the same command menu as ⌘K and
// the rail's Search, with three ways in as chips (the Daily Brief, Review,
// Preferences). Review has its own decision bar there, so it is left out.
export function CommandBar() {
  const key = mac() ? '⌘K' : 'Ctrl K';
  return (
    <div className="cmdbar" role="toolbar" aria-label="Commands">
      <button type="button" className="cmdbar-open" data-key="cmdbar-open" aria-keyshortcuts={mac() ? 'Meta+K' : 'Control+K'} onClick={() => openCommand()}>
        <Search size={16} strokeWidth={1.75} aria-hidden="true" />
        <span className="cmdbar-t">Search projects, pages and commands</span>
        <kbd className="cmdbar-kbd" aria-hidden="true">{key}</kbd>
      </button>
      <span className="cmdbar-chips">
        <button type="button" className="cmdbar-chip" data-key="cmdbar-brief" onClick={() => openBrief()}>Daily Brief</button>
        <a className="cmdbar-chip" href="#/review" data-key="cmdbar-review">Review</a>
        <button type="button" className="cmdbar-chip" data-key="cmdbar-prefs" onClick={() => openPrefs('appearance')}>Preferences</button>
      </span>
    </div>
  );
}
