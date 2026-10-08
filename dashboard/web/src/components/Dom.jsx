// A part built by one of the views the app still hosts (a DOM node from
// dashboard/public), placed inside a React view with its scoped styles: the
// DEX liquidity card, the technical chart, the evidence checks. `build` runs
// again when `deps` change; a part that returns the same node (the chart
// keeps its frame) stays where it is.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

let legacyMod = null;
let legacyPromise = null;
export function loadLegacy() {
  if (legacyMod) return Promise.resolve(legacyMod);
  if (!legacyPromise) legacyPromise = import('../legacy/parts.js').then((m) => { legacyMod = m; return m; });
  return legacyPromise;
}

// The hosted views' modules (and their stylesheets), once loaded.
export function useLegacy() {
  const [mod, setMod] = useState(legacyMod);
  useEffect(() => {
    if (mod) return undefined;
    let alive = true;
    loadLegacy().then((m) => { if (alive) setMod(m); });
    return () => { alive = false; };
  }, [mod]);
  return mod;
}

export function Dom({ build, deps = [], className = '', as: Tag = 'div' }) {
  const ref = useRef(null);
  const L = useLegacy();
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !L) return;
    let node = null;
    try {
      node = build(L);
    } catch (err) {
      console.error(err);
      node = null;
    }
    const nodes = node ? (Array.isArray(node) ? node.filter(Boolean) : [node]) : [];
    if (nodes.length === root.childNodes.length && nodes.every((n, i) => root.childNodes[i] === n)) return;
    root.replaceChildren(...nodes);
  }, [L, ...deps]);
  return <Tag ref={ref} className={`lg lg-part ${className}`.trim()} />;
}
