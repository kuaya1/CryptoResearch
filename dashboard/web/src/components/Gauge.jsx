// The investment grade as a half-circle gauge on the one 0–100 spectrum:
// five muted segments (the grade's own a shade stronger), a marker at the
// grade or a span for a range (never a midpoint), the number and the
// rubric's word inside. Geometry from public/ui.js, so it matches the views
// the app still hosts.
import { gaugeArc, gaugePoint, scoreTier, TIER_EDGES } from '../../../public/ui.js';

export function Gauge({ grade, word = null, serious = false, size = 180 }) {
  if (!grade || !['firm', 'range'].includes(grade.status)) return null;
  const geo = { cx: 90, cy: 90, r: 76 };
  const low = grade.status === 'range' ? grade.low : grade.value;
  const high = grade.status === 'range' ? grade.high : grade.value;
  const tier = scoreTier(low);
  const gap = 3.2;
  const [x, y] = gaugePoint(Math.max(1.5, Math.min(98.5, low)), geo);
  return (
    <svg className={`gauge${serious ? ' ev-serious' : ''}`} width={size} height={size * (100 / 180)} viewBox="0 0 180 100" role="img" aria-label={`Investment grade ${grade.display} of 100${word ? `, ${word}` : ''}`}>
      {TIER_EDGES.map(([a, b], i) => (
        <path key={a} className={`gseg t${i + 1}${i + 1 === tier ? ' on' : ''}`} d={gaugeArc(a === 0 ? 1.5 : a + gap / 2, b === 100 ? 98.5 : b - gap / 2, geo)} />
      ))}
      {grade.status === 'range'
        ? <path className={`gspan t${tier}`} d={gaugeArc(Math.max(1.5, low), Math.min(98.5, Math.max(high, low + 0.8)), geo)} />
        : <circle className={`gdot t${tier}`} cx={x.toFixed(2)} cy={y.toFixed(2)} r="6.5" />}
      <text className={`gnum${String(grade.display).length > 6 ? ' is-long' : ''}`} x="90" y="76" textAnchor="middle">{grade.display}</text>
      {word ? <text className="gword" x="90" y="95" textAnchor="middle">{word}</text> : null}
    </svg>
  );
}

// A score on the 0–100 spectrum as a bar: a fill for a point, a span for a
// range, an empty dashed track for unknown (never read as zero).
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
