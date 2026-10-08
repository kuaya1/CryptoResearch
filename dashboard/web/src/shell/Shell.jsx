// The desk's frame: the navigation's home is a left sidebar on a wide screen,
// an icon rail on a tablet and a tab bar (with More) on a phone; the work
// sits on one white panel beside it. The connection's state and Sign out
// (the online desk) live at the sidebar's foot.
import { useEffect, useRef, useState } from 'react';
import { Ellipsis, LogOut, X } from 'lucide-react';
import { useDesk } from '../lib/hooks.js';
import { liveStatus } from '../lib/desk.js';
import { nav } from '../lib/router.js';
import { visibleSections, navCounts } from './sections.js';
import { Mark } from '../components/Mark.jsx';

function activeOf(route) {
  if (!route) return 'watchlist';
  return route.name === 'project' ? 'watchlist' : route.name;
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
      title={compact ? s.label : undefined}
      data-key={`nav-${s.id}`}
      onClick={onClick}
    >
      <Icon className="nav-ico" size={16} strokeWidth={1.75} aria-hidden="true" />
      <span className="nav-label">{s.label}</span>
      {count ? <span className="nav-count" aria-hidden="true" title={count.title}>{count.n}</span> : null}
    </a>
  );
}

function LiveDot() {
  const st = liveStatus();
  return (
    <span className={`live live-${st.tone || 'idle'}`} title={st.title || 'Connection to the desk'} data-mode={nav.route ? 'ok' : 'boot'}>
      <span className="live-dot" aria-hidden="true" />
      <span className="live-label">{st.label}</span>
    </span>
  );
}

function SignOut({ className = '' }) {
  return (
    <form method="post" action="/logout" className={`signout ${className}`.trim()}>
      <button type="submit" className="btn btn-ghost btn-sm signout-btn" data-key="nav-signout">
        <LogOut size={15} strokeWidth={1.75} aria-hidden="true" />
        <span>Sign out</span>
      </button>
    </form>
  );
}

export function Sidebar() {
  const d = useDesk();
  const active = activeOf(nav.route);
  const counts = navCounts(d.index);
  const list = visibleSections(d, active);
  const main = list.filter((s) => s.id !== 'settings' && s.id !== 'new');
  const settings = list.find((s) => s.id === 'settings');
  const ws = d.session && d.session.workspace;
  const kind = ws && ws.kind !== 'real' ? (ws.kind === 'demo' ? 'Demo' : 'Test') : null;
  return (
    <aside className="sidebar" aria-label="Desk">
      <div className="sb-brand">
        <a className="brand" href="#/watchlist" data-key="nav-brand">
          <Mark className="brand-mark" />
          <span className="brand-word">CryptoResearch</span>
        </a>
        {kind ? <span className="ws-tag" title={`${kind} workspace: fictional data`}>{kind}</span> : null}
      </div>
      {kind ? <p className="sb-demo">{`${ws.kind === 'demo' ? 'Fictional demo data' : 'Test workspace'}: not real research, prices or holdings`}</p> : null}
      <a className={`sb-new${active === 'new' ? ' is-active' : ''}`} href="#/new" data-key="nav-new" aria-current={active === 'new' ? 'page' : undefined}>
        <span className="sb-new-plus" aria-hidden="true">+</span>
        <span className="nav-label">New research</span>
      </a>
      <nav className="sb-nav" aria-label="Main">
        {main.map((s) => <NavItem key={s.id} s={s} active={active} count={counts[s.id]} />)}
      </nav>
      <div className="sb-foot">
        {settings ? <NavItem s={settings} active={active} /> : null}
        <div className="sb-status">
          <LiveDot />
          {d.session && d.session.hosted ? <SignOut /> : null}
        </div>
      </div>
    </aside>
  );
}

// A phone: the main pages in a tab bar, the rest under More.
export function TabBar() {
  const d = useDesk();
  const [open, setOpen] = useState(false);
  const active = activeOf(nav.route);
  const counts = navCounts(d.index);
  const list = visibleSections(d, active);
  const primary = ['watchlist', 'new', 'portfolio'];
  const more = list.filter((s) => !primary.includes(s.id));
  const moreActive = more.some((s) => s.id === active);
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
          const s = list.find((x) => x.id === id);
          return s ? <NavItem key={id} s={s} active={active} count={counts[id]} compact /> : null;
        })}
        <button type="button" ref={btn} className={`nav-item tab-more${moreActive ? ' is-active' : ''}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} data-key="nav-more">
          <Ellipsis className="nav-ico" size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className="nav-label">More</span>
          {more.some((s) => counts[s.id]) ? <span className="nav-dot" aria-hidden="true" /> : null}
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
          {more.map((s) => <NavItem key={s.id} s={s} active={active} count={counts[s.id]} onClick={() => setOpen(false)} />)}
        </div>
        <div className="msheet-foot">
          <LiveDot />
          {d.session && d.session.hosted ? <SignOut /> : null}
        </div>
      </dialog>
    </>
  );
}

// A phone's top bar: the wordmark and the connection.
export function TopBar() {
  const d = useDesk();
  const ws = d.session && d.session.workspace;
  const kind = ws && ws.kind !== 'real' ? (ws.kind === 'demo' ? 'Demo' : 'Test') : null;
  // On a phone the tag is the whole notice (no banner row above the work).
  const notice = kind ? `${ws.kind === 'demo' ? 'Fictional demo data' : 'Test workspace'}: not real research, prices or holdings` : null;
  return (
    <header className="topbar">
      <a className="brand" href="#/watchlist" data-key="top-brand">
        <Mark className="brand-mark" />
        <span className="brand-word">CryptoResearch</span>
      </a>
      {kind ? <span className="ws-tag" title={notice}><span aria-hidden="true">{kind}</span><span className="sr-only">{notice}</span></span> : null}
      <span className="spacer" />
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
