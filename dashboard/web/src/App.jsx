import { Suspense, useEffect, useState } from 'react';
import { toast } from '../../public/ui.js';
import { useDesk, useMedia } from './lib/hooks.js';
import { nav, navigate, pageTitle, routeKey } from './lib/router.js';
import { start } from './lib/start.js';
import { Sidebar, TabBar, TopBar, DemoBanner } from './shell/Shell.jsx';
import { SECTIONS } from './shell/sections.js';
import { Boundary, ViewError, retryableLazy, retryingImport } from './components/Boundary.jsx';
import Watchlist from './views/watchlist/Watchlist.jsx';

const ProjectPage = retryableLazy(() => import('./views/project/ProjectPage.jsx'));
const LegacyView = retryableLazy(() => import('./legacy/LegacyView.jsx'));
const legacy = retryingImport(() => import('./legacy/views.js'));

// Once the first page is up and the browser is idle, the other views and the
// hosted views' parts are fetched ahead (nothing runs or is asked of the
// desk), so opening a project or another page needs no wait. A part that
// fails to download here is asked for again when it is opened.
function prefetch() {
  const go = () => {
    for (const load of [() => import('./views/project/ProjectPage.jsx'), () => import('./views/inspector/Inspector.jsx'), () => import('./legacy/parts.js')]) load().catch(() => {});
  };
  if ('requestIdleCallback' in window) window.requestIdleCallback(go, { timeout: 4000 });
  else setTimeout(go, 1500);
}

function Loading() {
  return <div className="page-loading" role="status"><span className="sr-only">Loading…</span><span className="skel w60" /><span className="skel w80" /><span className="skel w40" /></div>;
}

// Each page in its own boundary: a page that cannot be drawn says so in its
// place, and the sidebar, the tab bar and the other pages keep working.
function RouteView() {
  const route = nav.route;
  if (!route) return <Loading />;
  const key = route.name === 'project' ? `project/${route.args[0]}` : routeKey(route);
  const view = route.name === 'watchlist'
    ? <Watchlist />
    : route.name === 'project'
      ? <Suspense fallback={<Loading />}><ProjectPage key={route.args[0]} /></Suspense>
      : (
        <Suspense fallback={<Loading />}>
          <LegacyView key={route.name} name={route.name} load={() => legacy().then((m) => m.LEGACY_VIEWS[route.name]())} />
        </Suspense>
      );
  return (
    <Boundary
      resetKey={key}
      onRetry={() => { ProjectPage.retry(); LegacyView.retry(); }}
      fallback={(error, retry) => <ViewError error={error} retry={retry} what={route.name === 'project' ? 'This project' : 'This page'}><a className="btn btn-sm btn-ghost" href="#/watchlist">Watchlist</a></ViewError>}
    >
      {view}
    </Boundary>
  );
}

// "/" or Ctrl/Cmd+K: search the watchlist from anywhere; never while typing
// or with a dialog open.
function useSearchKeys() {
  useEffect(() => {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
    const onKey = (e) => {
      const slash = e.key === '/' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing;
      if (!slash && (e.key.toLowerCase() !== 'k' || e.altKey || e.shiftKey || (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey))) return;
      const t = e.target;
      const editing = t && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && (slash || t.dataset.key !== 'wl-search')));
      if (editing || document.querySelector('dialog[open]')) return;
      e.preventDefault();
      const box = document.querySelector('[data-key="wl-search"]');
      if (nav.route && nav.route.name === 'watchlist' && box && !document.querySelector('.inspector.is-modal')) {
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

export default function App() {
  const d = useDesk();
  const phone = useMedia('(max-width: 767.98px)');
  const rail = useMedia('(max-width: 1023.98px)');
  useSearchKeys();
  useAsyncErrors();
  useEffect(() => {
    if (nav.route) document.title = pageTitle(nav.route, SECTIONS);
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
  return (
    <div className="app">
      {phone ? null : <Sidebar />}
      <div className="app-main">
        {phone ? <TopBar /> : null}
        {/* On a wide screen the sidebar says it under the wordmark; on a phone
            the top bar's tag does. */}
        {rail && !phone ? <DemoBanner /> : null}
        <main id="main" tabIndex={-1} className={`page page-${nav.route.name}`}>
          <RouteView />
        </main>
      </div>
      {phone ? <TabBar /> : null}
    </div>
  );
}
