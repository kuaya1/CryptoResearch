import { lazy, Suspense, useEffect } from 'react';
import { useDesk, useMedia } from './lib/hooks.js';
import { nav, navigate, pageTitle } from './lib/router.js';
import { Sidebar, TabBar, TopBar, DemoBanner } from './shell/Shell.jsx';
import { SECTIONS } from './shell/sections.js';
import Watchlist from './views/watchlist/Watchlist.jsx';

const ProjectPage = lazy(() => import('./views/project/ProjectPage.jsx'));
const LegacyView = lazy(() => import('./legacy/LegacyView.jsx'));
const legacy = () => import('./legacy/views.js');

// Once the first page is up and the browser is idle, the other views and the
// hosted views' parts are fetched ahead (nothing runs or is asked of the
// desk), so opening a project or another page needs no wait.
function prefetch() {
  const go = () => {
    import('./views/project/ProjectPage.jsx');
    import('./views/inspector/Inspector.jsx');
    import('./legacy/parts.js');
  };
  if ('requestIdleCallback' in window) window.requestIdleCallback(go, { timeout: 4000 });
  else setTimeout(go, 1500);
}

function Loading() {
  return <div className="page-loading" role="status"><span className="sr-only">Loading…</span><span className="skel w60" /><span className="skel w80" /><span className="skel w40" /></div>;
}

function RouteView() {
  const route = nav.route;
  if (!route) return <Loading />;
  if (route.name === 'watchlist') return <Watchlist />;
  if (route.name === 'project') return <Suspense fallback={<Loading />}><ProjectPage key={route.args[0]} /></Suspense>;
  return (
    <Suspense fallback={<Loading />}>
      <LegacyView key={route.name} name={route.name} load={() => legacy().then((m) => m.LEGACY_VIEWS[route.name]())} />
    </Suspense>
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

export default function App() {
  const d = useDesk();
  const phone = useMedia('(max-width: 767.98px)');
  const rail = useMedia('(max-width: 1023.98px)');
  useSearchKeys();
  useEffect(() => {
    if (nav.route) document.title = pageTitle(nav.route, SECTIONS);
  });
  const ready = Boolean(d.index && nav.route);
  useEffect(() => { if (ready) prefetch(); }, [ready]);
  if (d.error) {
    return (
      <div className="boot-error" role="alert">
        <h1>CryptoResearch</h1>
        <p>{d.error}</p>
      </div>
    );
  }
  if (!d.index || !nav.route) return <div className="boot" role="status"><span className="sr-only">Loading your workspace…</span></div>;
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
