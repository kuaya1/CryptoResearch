// A part built by one of the views the app still hosts (a DOM node from
// dashboard/public), placed inside a React view with its scoped styles: the
// DEX liquidity card, the technical chart, the evidence checks. `build` runs
// again when `deps` change; a part that returns the same node (the chart
// keeps its frame) stays where it is.
//
// If the hosted views' code cannot be downloaded, or a part throws while it
// is built, the part says so in its place with Try again; the view around it
// keeps working (review 2026-10-08, F3).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isChunkError, retryingImport } from './Boundary.jsx';

let legacyMod = null;
let legacyPromise = null;
const getParts = retryingImport(() => import('../legacy/parts.js'));
export function loadLegacy() {
  if (legacyMod) return Promise.resolve(legacyMod);
  if (!legacyPromise) {
    legacyPromise = getParts().then(
      (m) => { legacyMod = m; return m; },
      (err) => { legacyPromise = null; throw err; },
    );
  }
  return legacyPromise;
}

// The hosted views' modules (and their stylesheets), once loaded; an error
// when they could not be, with retry() to ask again.
export function useLegacy() {
  const [state, setState] = useState({ mod: legacyMod, error: null, attempt: 0 });
  useEffect(() => {
    if (state.mod) return undefined;
    let alive = true;
    loadLegacy().then(
      (m) => { if (alive) setState((s) => ({ ...s, mod: m, error: null })); },
      (error) => { if (alive) setState((s) => ({ ...s, error })); },
    );
    return () => { alive = false; };
  }, [state.mod, state.attempt]);
  return { mod: state.mod, error: state.error, retry: () => setState((s) => ({ ...s, error: null, attempt: s.attempt + 1 })) };
}

export function Dom({ build, deps = [], className = '', as: Tag = 'div' }) {
  const ref = useRef(null);
  const { mod: L, error: loadError, retry } = useLegacy();
  const [buildError, setBuildError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !L) return;
    let node = null;
    try {
      node = build(L);
      if (buildError) setBuildError(null);
    } catch (err) {
      console.error(err);
      setBuildError(err);
      return;
    }
    const nodes = node ? (Array.isArray(node) ? node.filter(Boolean) : [node]) : [];
    if (nodes.length === root.childNodes.length && nodes.every((n, i) => root.childNodes[i] === n)) return;
    root.replaceChildren(...nodes);
  }, [L, attempt, ...deps]);
  const error = loadError || buildError;
  if (error) {
    const why = loadError && isChunkError(loadError) ? 'its code could not be downloaded' : (error.message || String(error));
    return (
      <div className={`lg-part-error ${className}`.trim()} role="alert">
        <span>{`This part could not be shown: ${why}.`}</span>
        <button type="button" className="btn btn-sm" onClick={() => { if (loadError) retry(); else { setBuildError(null); setAttempt((a) => a + 1); } }}>Try again</button>
      </div>
    );
  }
  return <Tag ref={ref} className={`lg lg-part ${className}`.trim()} />;
}
