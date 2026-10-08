// Figures as the desk shows them: one formatter for the list and the
// inspector (public/ui.js), a sign and a color for a change, "—" with its
// reason for an unknown value. The words are for screen readers; color is
// never the only signal.
import { fmtChangePct, sparkPath, marketFigureReason } from '../../../public/ui.js';

export function Unknown({ label, reason = null }) {
  const why = reason || `${label} unknown`;
  return (
    <span className="unknown" title={reason || undefined}>
      <span aria-hidden="true">—</span>
      <span className="sr-only">{why}</span>
    </span>
  );
}

// An unknown market figure: "—" with why (not reported, or reported as 0).
export function UnknownFigure({ label, value }) {
  return <Unknown label={label} reason={marketFigureReason(label, value)} />;
}

export function Change({ value, label, className = '' }) {
  const text = fmtChangePct(value);
  if (text === null) return <Unknown label={`${label} change`} />;
  const dir = value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
  return (
    <span className={`chg ${dir} ${className}`.trim()}>
      <span aria-hidden="true">{text}</span>
      <span className="sr-only">{`${dir === 'flat' ? 'unchanged' : dir} ${Math.abs(value).toFixed(2)} percent, ${label}`}</span>
    </span>
  );
}

// The 7-day chart: one SVG path (public/ui.js sparkPath), green when the
// 7-day change is up or flat, red when down; a faint dashed line without a
// series. The label says the change.
export function Spark({ values, change, width = 120, height = 36, label = '7-day price' }) {
  const d = sparkPath(values, { width, height });
  if (!d) {
    return (
      <svg className="spark none" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label}: no series from the provider`}>
        <line x1="1" y1={height / 2} x2={width - 1} y2={height / 2} strokeWidth="1.5" strokeDasharray="3 4" strokeLinecap="round" />
      </svg>
    );
  }
  const up = !(typeof change === 'number' && change < 0);
  return (
    <svg className={`spark ${up ? 'up' : 'down'}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label}${typeof change === 'number' ? `, ${change >= 0 ? 'up' : 'down'} ${Math.abs(change).toFixed(2)} percent` : ''}`} fill="none">
      <path d={d} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
