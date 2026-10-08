// One model's grade or state as a pill, from the desk's own vocabulary
// (public/ui.js badgeInfo): the figure in its tier of the one 0–100 spectrum,
// a range as its two ends, or the state as a word with its sign (Working
// blue with a pulse, Waiting amber with a pulse, Failed and Check rose,
// Withheld hatched with the share of the weight scored under it, no report
// a muted "—"). An evidence flag is a mark before the figure: solid for a
// serious flag, a ring for a material one. Never a combined score; the full
// sentence is the label.
import { forwardRef } from 'react';
import { Clock, Pause, CircleHelp, CircleAlert, FileText, CircleMinus, CircleSlash, CircleDashed } from 'lucide-react';
import { badgeInfo, scoreTier, PROVIDER_SHORT } from '../../../public/ui.js';

const ICONS = { queued: Clock, interrupted: Pause, uncertain: CircleHelp, conflict: CircleHelp, incomplete: CircleDashed, failed: CircleAlert, canceled: CircleSlash, pdf: FileText, on_hold: CircleMinus, held: CircleMinus };
const WORKING = new Set(['running', 'dispatching', 'cowork', 'connector']);

export function pillInfo(provider, report, job, opts) {
  const info = badgeInfo(provider, report, job, opts);
  const g = report && report.grade;
  const tier = info.kind === 'grade' ? scoreTier(g.value) : info.kind === 'range' ? scoreTier(g.low) : null;
  const tone = tier ? `tier-${tier}`
    : WORKING.has(info.kind) ? 'is-work'
      : info.kind === 'waiting' ? 'is-wait'
        : ['failed', 'uncertain', 'conflict', 'incomplete'].includes(info.kind) ? 'is-bad'
          : info.kind === 'withheld' ? 'is-withheld'
            : info.kind === 'none' ? 'is-none'
              : 'is-state';
  return { ...info, tier, tone };
}

export const GradePill = forwardRef(function GradePill({ provider, report, job, opts, asButton = false, showName = false, showSub = true, className = '', ...rest }, ref) {
  const info = pillInfo(provider, report, job, opts);
  const Icon = ICONS[info.kind] || null;
  const Tag = asButton ? 'button' : 'span';
  const mark = info.problem ? 'x' : info.refreshing ? 'r' : info.stale ? 'a' : null;
  const markTitle = info.problem || info.refreshing ? info.newerText : info.stale ? `Analysis ${info.age} old: stale` : null;
  const label = asButton ? `${info.text.replace(/[.\s]+$/, '')}. Open details` : info.text;
  return (
    <span className={`gp-wrap ${className}`.trim()}>
      <Tag
        ref={ref}
        type={asButton ? 'button' : undefined}
        className={`gp is-${info.kind} ${info.tone}${info.ev ? ` ev-${info.ev}` : ''}${String(info.value).length >= 9 ? ' is-long' : ''}`}
        aria-label={label}
        title={info.evText ? `Evidence checks: ${info.evText}` : undefined}
        data-provider={provider}
        {...rest}
      >
        {showName ? <span className="gp-name" aria-hidden="true">{PROVIDER_SHORT[provider]}</span> : null}
        <span className="gp-main" aria-hidden="true">
          {WORKING.has(info.kind) ? <span className="pulse" /> : info.kind === 'waiting' ? <span className="pulse wait" /> : Icon ? <Icon className="gp-ico" size={12} strokeWidth={2} /> : null}
          {info.ev ? <span className="gp-ev" /> : null}
          <span className="gp-v">{info.value}</span>
        </span>
        {mark ? <span className={`gp-mark m-${mark}`} title={markTitle || undefined} aria-hidden="true" /> : null}
      </Tag>
      {showSub && info.sub ? <span className="gp-sub" aria-hidden="true">{info.sub}</span> : null}
    </span>
  );
});
