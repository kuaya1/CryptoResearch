// The investment grade as an institutional metric header (Eric, 2026-10-08:
// it replaces the half-circle gauge everywhere). One dense horizontal well:
// the model and its verdict on the left in bold ink; on the right the desk's
// calculated grade in large tabular figures with the rubric's word in a
// bordered tag (a range as its two ends, never a midpoint; withheld as the
// share of the weight scored, never a number); under them the analysis date
// and the horizon; then the grade's warnings. Nothing missing is drawn as a
// zero, and the grade is never the model's own total.
import { COVERAGE_MEANS } from '../../../public/ui.js';

export function MetricHeader({ who, model = null, verdict = null, grade, word = null, tier = null, caption = 'Investment grade', captionTitle = undefined, sub = null, chips = null, part = 'grade' }) {
  const g = grade || { status: 'none' };
  const scored = g.status === 'firm' || g.status === 'range';
  let score;
  if (scored) {
    score = (
      <div className="mh-score" data-part={`${part}-score`} role="img" aria-label={`Investment grade ${g.display} of 100${word ? `, ${word}` : ''}`}>
        <span className="mh-cap" aria-hidden="true" title={captionTitle}>{g.status === 'range' ? `${caption} · a range` : caption}</span>
        <span className={`mh-num${g.status === 'range' ? ' is-range' : ''}`} aria-hidden="true">{g.display}</span>
        {word ? <span className={`mh-tag tier-${tier || 3}`} aria-hidden="true">{word}</span> : null}
      </div>
    );
  } else if (g.status === 'withheld') {
    const pct = typeof g.coverage === 'number' ? g.coverage : null;
    score = (
      <div className="mh-score is-withheld" data-part={`${part}-score`}>
        <span className="mh-cap" title={captionTitle}>{caption}</span>
        <span className="mh-wh">Withheld</span>
        {pct !== null ? (
          <span className="mh-cov" title={COVERAGE_MEANS}>
            <span className="cov-track" aria-hidden="true"><span className="cov-fill" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} /></span>
            <span className="cov-lbl">{`${pct}% of the weight scored`}</span>
          </span>
        ) : g.reason ? <span className="cov-lbl">{g.reason}</span> : null}
      </div>
    );
  } else {
    score = (
      <div className="mh-score is-none" data-part={`${part}-score`}>
        <span className="mh-cap" title={captionTitle}>{caption}</span>
        <span className="mh-wh">{g.label || 'No grade'}</span>
        {g.reason ? <span className="cov-lbl">{g.reason}</span> : null}
      </div>
    );
  }
  return (
    <div className={`mh${scored ? '' : ' is-unscored'}`} data-part={part}>
      <div className="mh-main">
        <p className="mh-who">{who}{model ? <span className="mh-model">{` · ${model}`}</span> : null}</p>
        <p className="mh-verdict" title="The verdict as the report writes it">{verdict || <span className="faint">No verdict given</span>}</p>
      </div>
      {score}
      {sub ? <div className="mh-sub">{sub}</div> : null}
      {chips ? <div className="mh-chips">{chips}</div> : null}
    </div>
  );
}
