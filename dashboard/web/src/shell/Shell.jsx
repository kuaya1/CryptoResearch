// The desk's frame (DESIGN_AND_IA_BLUEPRINT.md §3.0; Eric, 2026-10-17): a
// sand rail on the left, 208px with its words or 56px with its icons only
// (your choice, kept in this browser; the icons only from 1023px down), with
// the four daily places (Desk, Review, Portfolio, Research) and a count only
// where it means "needs you" (Review, Portfolio); at its foot the command menu
// (⌘K), Preferences (⌘,), the connection and Sign out (the online desk). On
// a phone: a top bar (the wordmark, the Test or Demo tag, search, the
// connection) and a tab bar (Desk, Review, Portfolio, More).
import { useEffect, useRef, useState } from 'react';
import { Ellipsis, LogOut, X, Search, Settings, PanelLeftClose, PanelLeftOpen, SquarePen, FlaskConical } from 'lucide-react';
import { store } from '../../../public/ui.js';
import { useDesk } from '../lib/hooks.js';
import { useAgendaRead } from '../lib/agenda.js';
import { liveStatus } from '../lib/desk.js';
import { nav } from '../lib/router.js';
import { visibleSections, navCounts, SECTIONS } from './sections.js';
import { openCommand, openPrefs, prefsOf } from './overlays.js';
import { Mark } from '../components/Mark.jsx';

const mac = () => /Mac|iPhone|iPad/.test(navigator.platform || '');

function activeOf(route) {
  if (!route) return 'watchlist';
  if (route.name === 'project') return 'watchlist';
  if (route.name === 'updates' || route.name === 'agenda') return 'review';
  return route.name;
}

function NavItem({ s, active, count, compact = false, onClick }) {
  const Icon = s.icon;
  const on = s.id === active;
  return (
    <a
      href={`#/${s.id}`}
      className={`nav-item${on ? ' is-active' : ''}`}
      aria-current={on ? 'page' : undefined}
      aria-label={`${s.label}${count ? `, ${count.title}` : ''}`}
      title={compact ? `${s.label}${count ? ` · ${count.title}` : ''}` : undefined}
      data-key={`nav-${s.id}`}
      onClick={onClick}
    >
      <Icon className="nav-ico" size={16} strokeWidth={1.75} aria-hidden="true" />
      <span className="nav-label">{s.label}</span>
      {count ? <span className="nav-count" aria-hidden="true" title={count.title}>{count.n}</span> : null}
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
  const { a: agenda } = useAgendaRead();
  const counts = navCounts(d.index, agenda);
  const list = visibleSections(d, active);
  const ws = d.session && d.session.workspace;
  const kind = ws && ws.kind !== 'real' ? (ws.kind === 'demo' ? 'Demo' : 'Test') : null;
  const prefsOpen = Boolean(prefsOf());
  return (
    <aside className={`sidebar${collapsed ? ' is-collapsed' : ''}`} aria-label="Desk">
      <div className="sb-brand">
        <a className="brand" href="#/watchlist" data-key="nav-brand" title="CryptoResearch: the Desk">
          <Mark className="brand-mark" />
          <span className="brand-word">CryptoResearch</span>
        </a>
        {kind ? <span className="ws-tag" title={`${kind} workspace: fictional data`}>{kind}</span> : null}
      </div>
      {kind && !collapsed ? <p className="sb-demo">{`${ws.kind === 'demo' ? 'Fictional demo data' : 'Test workspace'}: not real research, prices or holdings`}</p> : null}
      <nav className="sb-nav" aria-label="Main">
        {list.map((s) => <NavItem key={s.id} s={s} active={active} count={counts[s.id]} compact={collapsed} />)}
      </nav>
      <div className="sb-foot">
        <button type="button" className="nav-item sb-util" data-key="nav-command" aria-keyshortcuts={mac() ? 'Meta+K' : 'Control+K'} title={collapsed ? `Search and commands (${mac() ? '⌘K' : 'Ctrl K'})` : undefined} onClick={() => openCommand()}>
          <Search className="nav-ico" size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className="nav-label">Search</span>
          <kbd className="nav-kbd" aria-hidden="true">{mac() ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        <button type="button" className={`nav-item sb-util${prefsOpen ? ' is-on' : ''}`} data-key="nav-settings" aria-keyshortcuts={mac() ? 'Meta+Comma' : 'Control+Comma'} aria-expanded={prefsOpen} title={collapsed ? 'Preferences' : undefined} onClick={() => openPrefs('appearance')}>
          <Settings className="nav-ico" size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className="nav-label">Preferences</span>
        </button>
        <div className="sb-status">
          <LiveDot />
          {d.session && d.session.hosted ? <SignOut /> : null}
        </div>
        <button type="button" className="btn btn-ghost btn-sm btn-icon sb-collapse" data-key="nav-collapse" aria-label={collapsed ? 'Show the rail with its words' : 'Collapse the rail to its icons'} title={collapsed ? 'Expand' : 'Collapse'} onClick={onCollapse}>
          {collapsed ? <PanelLeftOpen size={16} aria-hidden="true" /> : <PanelLeftClose size={16} aria-hidden="true" />}
        </button>
      </div>
    </aside>
  );
}

// A phone: the main places in a tab bar, the rest under More.
const MORE = [
  { id: 'research', label: 'Research', icon: FlaskConical },
  { id: 'new', label: 'New research', icon: SquarePen },
];
export function TabBar() {
  const d = useDesk();
  const [open, setOpen] = useState(false);
  const active = activeOf(nav.route);
  const { a: agenda } = useAgendaRead();
  const counts = navCounts(d.index, agenda);
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
