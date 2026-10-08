// A score on the 0–100 spectrum as a bar: a fill for a point, a span for a
// range, an empty dashed track for unknown (never read as zero). Used by the
// category grades, the six weighted components and the downside risks.
import { scoreTier } from '../../../public/ui.js';

export function ScoreBar({ score, risk = false }) {
  const clamp = (v) => Math.max(0, Math.min(100, Number(v)));
  const s = score;
  if (s && s.status === 'range') {
    const t = risk ? 'risk' : `tier-${scoreTier(s.low)}`;
    const style = risk ? { right: `${clamp(s.low)}%`, width: `${Math.max(2, clamp(s.high) - clamp(s.low))}%` } : { left: `${clamp(s.low)}%`, width: `${Math.max(2, clamp(s.high) - clamp(s.low))}%` };
    return <span className="bar" aria-hidden="true"><span className={`bar-span ${t}`} style={style} /></span>;
  }
  if (s && (s.status === 'scored' || typeof s.value === 'number') && typeof s.value === 'number') {
    const t = risk ? 'risk' : `tier-${scoreTier(s.value)}`;
    return <span className="bar" aria-hidden="true"><span className={`bar-fill ${t}${risk ? ' from-right' : ''}`} style={{ width: `${clamp(s.value)}%` }} /></span>;
  }
  return <span className="bar is-unknown" aria-hidden="true" />;
}
