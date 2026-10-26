// The Desk's change window (Eric, 2026-10-26): 24h · 7d · 30d as one
// segmented control, the chosen segment a thumb that slides to it. It picks
// the change shown under each price and in the KPI strip; kept with the
// Desk's view preferences, saved only when you choose.
import { useRef } from 'react';
import { RANGES } from '../../../../public/watchlist-model.js';

export function RangeControl({ value, onChange }) {
  const ref = useRef(null);
  const i = Math.max(0, RANGES.findIndex(([k]) => k === value));
  const move = (to) => {
    const next = RANGES[(to + RANGES.length) % RANGES.length][0];
    onChange(next);
    requestAnimationFrame(() => { const b = ref.current && ref.current.querySelector(`[data-range="${next}"]`); if (b) b.focus(); });
  };
  const onKey = (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(i + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); move(0); }
    else if (e.key === 'End') { e.preventDefault(); move(RANGES.length - 1); }
  };
  return (
    <div ref={ref} className="range" role="radiogroup" aria-label="Change window" style={{ '--i': i, '--n': RANGES.length }} onKeyDown={onKey}>
      <span className="range-thumb" aria-hidden="true" />
      {RANGES.map(([k, label, words]) => (
        <button
          key={k}
          type="button"
          role="radio"
          className="range-opt"
          data-range={k}
          data-key={`range-${k}`}
          aria-checked={k === value}
          tabIndex={k === value ? 0 : -1}
          title={`Changes ${words}`}
          onClick={() => onChange(k)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
