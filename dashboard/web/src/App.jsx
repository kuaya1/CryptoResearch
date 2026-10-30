import { Suspense, useEffect, useState } from 'react';
import { toast } from '../../public/ui.js';
import { useDesk, useMedia } from './lib/hooks.js';
import { nav, navigate, pageTitle, routeKey } from './lib/router.js';
import { start } from './lib/start.js';
import { Sidebar, SidebarV3, TabBar, TopBar, DemoBanner, CommandBar, railCollapsed, saveRail } from './shell/Shell.jsx';
import { SECTIONS, PAGE_TITLES } from './shell/sections.js';
import { openCommand, openPrefs, closePrefs, prefsOf } from './shell/overlays.js';
import { Boundary, ViewError, retryableLazy, retryingImport } from './components/Boundary.jsx';
import Watchlist from './views/watchlist/Watchlist.jsx';

const ProjectPage = retryableLazy(() => import('./views/project/ProjectPage.jsx'));
const Review = retryableLazy(() => import('./views/review/Review.jsx'));
const CommandMenu = retryableLazy(() => import('./shell/CommandMenu.jsx'));
const DailyBrief = retryableLazy(() => import('./shell/DailyBrief.jsx'));
const Preferences = retryableLazy(() => import('./shell/Preferences.jsx'));
const LegacyView = retryableLazy(() => import('./legacy/LegacyView.jsx'));
const legacy = retryingImport(() => import('./legacy/views.js'));

// Once the first page is up and the browser is idle, the other views and the
// hosted views' parts are fetched ahead (nothing runs or is asked of the
// desk), so opening a project or another page needs no wait. A part that
// fails to download here is asked for again when it is opened.
function prefetch() {
  const go = () => {
    for (const load of [() => import('./views/project/ProjectPage.jsx'), () => import('./views/inspector/Inspector.jsx'), () => import('./views/review/Review.jsx'), () => import('./shell/CommandMenu.jsx'), () => import('./legacy/parts.js')]) load().catch(() => {});
  };
  if ('requestIdleCallback' in window) window.requestIdleCallback(go, { timeout: 4000 });
  else setTimeout(go, 1500);
}

function Loading() {
  return <div className="page-loading" role="status"><span className="sr-only">Loading…</span><span className="skel w60" /><span className="skel w80" /><span className="skel w40" /></div>;
}

// Each page in its own boundary: a page that cannot be drawn says so in its
// place, and the rail, the tab bar and the other pages keep working.
function RouteView() {
  const route = nav.route;
  if (!route) return <Loading />;
  const key = route.name === 'project' ? `project/${route.args[0]}` : route.name === 'review' ? 'review' : routeKey(route);
  const view = route.name === 'watchlist'
    ? <Watchlist />
    : route.name === 'project'
      ? <Suspense fallback={<Loading />}><ProjectPage key={route.args[0]} /></Suspense>
      : route.name === 'review'
        ? <Suspense fallback={<Loading />}><Review /></Suspense>
        : (
        <Suspense fallback={<Loading />}>
          <LegacyView key={route.name} name={route.name} load={() => legacy().then((m) => m.LEGACY_VIEWS[route.name]())} />
        </Suspense>
      );
  return (
    <Boundary
      resetKey={key}
      onRetry={() => { ProjectPage.retry(); Review.retry(); LegacyView.retry(); }}
      fallback={(error, retry) => <ViewError error={error} retry={retry} what={route.name === 'project' ? 'This project' : 'This page'}><a className="btn btn-sm btn-ghost" href="#/watchlist">Desk</a></ViewError>}
    >
      {view}
    </Boundary>
  );
}

// The keyboard's ways in (§3.6): "/" searches the Desk's list (it stays the
// table search); ⌘K or Ctrl+K opens the command menu; ⌘, or Ctrl+, opens
// Preferences. Never while typing or with a dialog open.
function useGlobalKeys() {
  useEffect(() => {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
    const onKey = (e) => {
      const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      const t = e.target;
      const editing = t && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.tagName === 'INPUT');
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        if (document.querySelector('dialog[open]:not(.cmdk)')) return;
        e.preventDefault();
        openCommand();
        return;
      }
      if (mod && !e.altKey && !e.shiftKey && e.key === ',') {
        if (document.querySelector('dialog[open]:not(.prefs)')) return;
        e.preventDefault();
        if (prefsOf()) closePrefs();
        else openPrefs('appearance');
        return;
      }
      const slash = e.key === '/' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing;
      if (!slash || editing || document.querySelector('dialog[open]')) return;
      e.preventDefault();
      const box = document.querySelector('[data-key="wl-search"]');
      if (nav.route && nav.route.name === 'watchlist' && box && !document.querySelector('.inspector.is-modal') && !prefsOf()) {
        box.focus();
        box.select();
        return;
      }
      nav.focusSearch = true;
      navigate('#/watchlist');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

// An error no handler caught (a promise nobody awaited, an event handler
// that threw) is said in words instead of failing silently; the page keeps
// working and nothing is retried by itself.
function useAsyncErrors() {
  useEffect(() => {
    const said = new Map();
    const say = (err) => {
      if (!err || err.name === 'AbortError') return;
      const msg = String(err.message || err).slice(0, 240);
      const now = Date.now();
      if (said.has(msg) && now - said.get(msg) < 10000) return;
      said.set(msg, now);
      toast(`Something did not finish: ${msg}. The page still works; check before trying it again.`, 'bad');
    };
    const onRejection = (e) => say(e.reason);
    const onError = (e) => { if (e.error) say(e.error); };
    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('error', onError);
    return () => {
      window.removeEventListener('unhandledrejection', onRejection);
      window.removeEventListener('error', onError);
    };
  }, []);
}

// Startup that did not finish: what happened, Try again (asks the desk once
// more; never a write) and Reload. No automatic retry or reload.
function StartError({ error }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="boot-error" role="alert">
      <h1>CryptoResearch</h1>
      <p className="be-why">{error.message}</p>
      <p className="faint">{error.kind === 'timeout' ? 'Nothing was changed. The desk may be starting or busy.' : 'Nothing was changed.'}</p>
      <div className="be-actions">
        <button type="button" className="btn btn-primary" data-key="boot-retry" disabled={busy} onClick={async () => { setBusy(true); await start(); setBusy(false); }}>{busy ? 'Trying…' : 'Try again'}</button>
        <button type="button" className="btn" data-key="boot-reload" onClick={() => location.reload()}>Reload the page</button>
      </div>
    </div>
  );
}

// While the Preferences drawer's code downloads (L3, 2026-10-26): the
// drawer, its title and a loading line at once, never an empty white panel;
// a download past CHUNK_WAIT_MS is said by the boundary with Try again.
function PrefsLoading() {
  return (
    <aside className="prefs is-open is-loading" aria-label="Preferences">
      <div className="prefs-in">
        <header className="prefs-head">
          <h2 className="prefs-h">Preferences</h2>
          <button type="button" className="btn btn-sm btn-ghost" data-key="prefs-close" onClick={closePrefs}>Close</button>
        </header>
        <p className="view-loading" role="status" data-key="prefs-loading">Loading Preferences…</p>
      </div>
    </aside>
  );
}

export default function App() {
  const d = useDesk();
  const phone = useMedia('(max-width: 767.98px)');
  const rail = useMedia('(max-width: 1023.98px)');
  const wide = useMedia('(min-width: 1280px)');
  const [collapsed, setCollapsed] = useState(railCollapsed);
  useGlobalKeys();
  useAsyncErrors();
  useEffect(() => {
    if (nav.route) document.title = prefsOf() ? 'Preferences · CryptoResearch' : pageTitle(nav.route, SECTIONS, PAGE_TITLES);
  });
  const ready = Boolean(d.index && nav.route);
  useEffect(() => { if (ready) prefetch(); }, [ready]);
  if (d.signedOut) {
    return (
      <div className="boot-error" role="status">
        <h1>CryptoResearch</h1>
        <p>Signed out. Opening the sign-in page…</p>
        <p><a className="btn" href="/login">Sign in</a></p>
      </div>
    );
  }
  if (d.error) return <StartError error={d.error} />;
  if (d.checking || !d.index || !nav.route) return <div className="boot" role="status"><span className="sr-only">{d.checking ? 'Checking your session…' : 'Loading your workspace…'}</span></div>;
  const prefs = prefsOf();
  // UI v3 (2026-10-30, §3): the Desk from 1280px is the v3 frame, the page
  // centred on the canvas at 1560px with the text rail inside it; no top bar
  // and no command bar. The command bar stays on the other pages (D12).
  const v3 = wide && nav.route.name === 'watchlist';
  const cmdbar = !rail && !phone && nav.route.name !== 'review' && nav.route.name !== 'watchlist';
  const frame = v3 ? (
    <div className="v3-page">
      <SidebarV3 />
      <main id="main" tabIndex={-1} className="page page-watchlist v3-main">
        <RouteView />
      </main>
    </div>
  ) : (
    <>
      {phone ? null : <Sidebar collapsed={collapsed || rail} onCollapse={() => { const next = !collapsed; setCollapsed(next); saveRail(next); }} />}
      <div className="app-main">
        {phone ? <TopBar /> : null}
        {/* On a wide screen the rail says it under the wordmark; on a phone
            the top bar's tag does. */}
        {rail && !phone ? <DemoBanner /> : null}
        <main id="main" tabIndex={-1} className={`page page-${nav.route.name}`}>
          <RouteView />
        </main>
        {cmdbar ? <CommandBar /> : null}
      </div>
      {phone ? <TabBar /> : null}
    </>
  );
  return (
    <div className={`app${v3 ? ' is-v3' : ''}${collapsed && !phone && !v3 ? ' rail-collapsed' : ''}${cmdbar ? ' has-cmdbar' : ''}`}>
      {frame}
      <Boundary resetKey={prefs || 'none'} onRetry={() => Preferences.retry()} fallback={(error, retry) => <aside className="prefs is-open is-error" aria-label="Preferences"><ViewError error={error} retry={retry} what="Preferences" compact><button type="button" className="btn btn-sm btn-ghost" onClick={closePrefs}>Close</button></ViewError></aside>}>
        {prefs ? <Suspense fallback={<PrefsLoading />}><Preferences section={prefs} /></Suspense> : null}
      </Boundary>
      <Boundary resetKey="cmdk" fallback={() => null}>
        <Suspense fallback={null}><CommandMenu /></Suspense>
      </Boundary>
      <Boundary resetKey="brief" fallback={() => null}>
        <Suspense fallback={null}><DailyBrief /></Suspense>
      </Boundary>
    </div>
  );
}
