import { useEffect, useState, useSyncExternalStore } from 'react';
import { desk, subscribe, getVersion, projectDetail } from './desk.js';

// The desk, redrawn whenever it changes (a live update, a saved change, the
// connection's state, a route).
export function useDesk() {
  useSyncExternalStore(subscribe, getVersion);
  return desk;
}

// One project's full record (GET /api/projects/<id>), from the cache when it
// is there, fetched again when a change drops it. The last record stays shown
// while a newer one loads, so nothing flickers.
export function useProject(id) {
  useDesk();
  const cached = id ? desk.projects.get(id) : null;
  const gen = id ? desk.projectGen.get(id) || 0 : 0;
  const [state, setState] = useState({ id: null, d: null, error: null });
  useEffect(() => {
    if (!id || cached) return undefined;
    let alive = true;
    projectDetail(id).then(
      (d) => { if (alive) setState({ id, d, error: null }); },
      (error) => { if (alive) setState((s) => ({ id, d: s.id === id ? s.d : null, error })); },
    );
    return () => { alive = false; };
  }, [id, gen, Boolean(cached)]);
  if (cached) return { d: cached, error: null, loading: false };
  const d = state.id === id ? state.d : null;
  return { d, error: state.id === id ? state.error : null, loading: !d };
}

export function useMedia(query) {
  const get = () => (typeof window !== 'undefined' ? window.matchMedia(query).matches : false);
  const [on, setOn] = useState(get);
  useEffect(() => {
    const m = window.matchMedia(query);
    const fn = () => setOn(m.matches);
    fn();
    m.addEventListener('change', fn);
    return () => m.removeEventListener('change', fn);
  }, [query]);
  return on;
}
