import { ScoreBar } from '../ScoreBar.jsx';

// One diagnostic grade as a terminal row: the name in a fixed column, a thin
// 6px track on the 0–100 spectrum filled in the grade's own tier (a range is a
// span between its two ends, unknown an empty dashed track, never a zero), and
// the figure right-aligned in tabular digits with the model's stated
// confidence beside it. The words are the caller's accessible name; the row
// itself is drawn for the eye (aria-hidden).
export function DiagnosticSegmentBar({ label, title = null, score, value, known = true, mark = null, confidence = null }) {
  return (
    <span className={`dsb${known ? '' : ' is-unknown'}`} aria-hidden="true">
      <span className="dsb-name" title={title || label}>
        <span className="dsb-label">{label}</span>
        {mark}
      </span>
      <ScoreBar score={score} />
      <span className="dsb-score">
        <span className="dsb-v">{value}</span>
        {confidence ? <span className="dsb-conf" title={confidence.title}>{confidence.letter}</span> : null}
      </span>
    </span>
  );
}
