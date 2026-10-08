import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { desk, subscribe, getVersion, projectDetail } from './desk.js';

// The desk, redrawn whenever it changes (a live update, a saved change, the
// connection's state, a route).
export function useDesk() {
  useSyncExternalStore(subscribe, getVersion);
  return desk;
}

// One project's full record (GET /api/projects/<id>), from the cache when it
// is there, read again when a change drops it. Leaving the project (another
// project, another change) cancels this reader's request, and an answer that
// arrives for a project or a change no longer shown is ignored. While a newer
// record loads, the last one is returned with current: false: views draw an
// opinion from it only where it holds the very report the list names
// (lib/opinion.js), so nothing flickers and nothing is mixed (review
// 2026-10-08, F1). retry() reads again after an error.
export function useProject(id) {
  useDesk();
  const cached = id ? desk.projects.get(id) : null;
  const gen = id ? desk.projectGen.get(id) || 0 : 0;
  const [state, setState] = useState({ id: null, gen: -1, d: null, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!id || cached) return undefined;
    const ctrl = new AbortController();
    projectDetail(id, { signal: ctrl.signal }).then(
      (d) => { if (!ctrl.signal.aborted) setState({ id, gen, d, error: null }); },
      (error) => {
        if (ctrl.signal.aborted || (error && error.name === 'AbortError')) return;
        setState((s) => ({ id, gen, d: s.id === id ? s.d : null, error }));
      },
    );
    return () => ctrl.abort();
  }, [id, gen, Boolean(cached), attempt]);
  const retry = useCallback(() => {
    setState((s) => (s.id === id ? { ...s, error: null } : s));
    setAttempt((a) => a + 1);
  }, [id]);
  if (cached) return { d: cached, current: true, error: null, loading: false, retry };
  const mine = state.id === id;
  const d = mine ? state.d : null;
  const error = mine ? state.error : null;
  return { d, current: false, error, loading: !error, retry };
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
