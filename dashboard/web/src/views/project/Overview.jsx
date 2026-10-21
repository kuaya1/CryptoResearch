// The Overview: one model's saved report read as a decision brief for the
// position horizon (public/brief-model.js briefModel, the same model the tests
// check). In order: the desk's calculated grade (or why it is withheld) with
// the verdict, the research age and the warnings that bear on it; the
// strongest risk the report backs with a source and what would confirm or
// break the thesis; the 13 category grades; apart, the six weighted
// components the grade is calculated from; the thesis, what supports and
// threatens it, what to watch, the scenarios; your own note last. Every value
// is the report's own or the desk's own calculation from it; nothing is
// averaged, nothing missing is filled in. Drawing it fetches, writes and
// starts nothing.
import { useLayoutEffect, useRef, useState } from 'react';
import { TriangleAlert, Clock, RotateCcw, FileText, ArrowUpRight, ChevronDown } from 'lucide-react';
import { fmtDate, fmtDateTime, daysSince, scoreTier, PROVIDER_LABELS, COVERAGE_MEANS, TAG_TITLES, safeUrl } from '../../../../public/ui.js';
import { TAG_WORDS, CERTAINTY_WORDS, checksWord } from '../../../../public/brief-model.js';
import { CONFIDENCE_LABELS } from '../../../../public/thesis-ui.js';
import { navigate } from '../../lib/router.js';
import { legacyCtx } from '../../legacy/ctx.js';
import { ScoreBar } from '../../components/ScoreBar.jsx';
import { MetricHeader } from '../../components/MetricHeader.jsx';
import { Dom, loadLegacy } from '../../components/Dom.jsx';

const enc = encodeURIComponent;
const plain = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
const scoreWords = (x) => (x.status === 'scored' ? String(x.value) : x.status === 'range' ? `${x.low}–${x.high}` : x.status === 'na' ? 'N/A' : x.status === 'missing' ? 'Not graded' : 'Unknown');
const asScore = (x) => (x.status === 'scored' ? { status: 'scored', value: x.value } : x.status === 'range' ? { status: 'range', low: x.low, high: x.high } : null);
const CONF_LETTER = { high: 'H', medium: 'M', low: 'L' };

// "Oct 20 – 27, 2026", "Oct 20 – Nov 19, 2026", "Oct 20, 2026".
export function windowWords(start, end) {
  if (!start) return 'Date unknown';
  if (!end || end === start) return fmtDate(start);
  const a = fmtDate(start);
  const b = fmtDate(end);
  if (start.slice(0, 7) === end.slice(0, 7)) return `${a.replace(/, \d{4}$/, '')} – ${b.replace(/^[A-Za-z]+ /, '')}`;
  return start.slice(0, 4) === end.slice(0, 4) ? `${a.replace(/, \d{4}$/, '')} – ${b}` : `${a} – ${b}`;
}

// A link to another view of the project page; opened from the inspector it
// keeps that way back (one entry deeper).
export function ViewLink({ pid, href, children, className, dataKey }) {
  return (
    <a
      href={href}
      className={className}
      data-key={dataKey}
      onClick={(e) => {
        const st = history.state;
        if (!plain(e) || !st || st.crBrief !== pid) return;
        e.preventDefault();
        navigate(href, { state: { ...st, crDepth: (Number(st.crDepth) || 1) + 1 } });
      }}
    >
      {children}
    </a>
  );
}

export function TagChips({ tags }) {
  if (!tags.length) return <span className="etag none">No claim cited</span>;
  return tags.map((t) => <span key={t} className={`etag t-${t.toLowerCase()}`} title={TAG_TITLES[t]}>{TAG_WORDS[t]}</span>);
}

export function CiteLine({ f }) {
  const s0 = f.sources[0];
  // A report's link is data: http(s) only (ui.js safeUrl).
  const u0 = s0 && s0.url ? safeUrl(s0.url) : null;
  const href0 = u0 && /^https?:/i.test(u0) ? u0 : null;
  return (
    <p className="cite">
      <TagChips tags={f.tags} />
      {f.sources.length ? (
        <>
          {href0 ? <a href={href0} target="_blank" rel="noopener noreferrer nofollow" title={[s0.publisher, s0.accessed_at ? `accessed ${s0.accessed_at}` : null].filter(Boolean).join(' · ') || undefined}>{s0.title || s0.publisher || s0.url}<ArrowUpRight size={12} aria-hidden="true" /></a> : <span>{s0.title || s0.source_id}</span>}
          {f.sources.length > 1 ? <span className="faint" title={f.sources.slice(1).map((s) => s.title || s.url || s.source_id).join('\n')}>{`+${f.sources.length - 1} more`}</span> : null}
        </>
      ) : null}
      {f.claims.length ? <span className="cite-ids" title={f.claims.map((c) => `${c.id}${c.as_of ? ` (as of ${c.as_of})` : ''}`).join(', ')}>{f.claims.map((c) => c.id).join(' ')}</span> : null}
      {f.dangling.length ? <span className="cite-dangling" title="These references are not in the report's claim or source list">{`${f.dangling.join(', ')} not listed`}</span> : null}
    </p>
  );
}

function jumpTo(key) {
  const el = document.querySelector(`[data-key="${key}"]`);
  if (!el) return;
  if (el.tagName === 'DETAILS') el.open = true;
  el.scrollIntoView({ block: 'center' });
  const f = el.tagName === 'DETAILS' ? el.querySelector('summary') : el;
  if (f) f.focus({ preventScroll: true });
}

// ---- notices ------------------------------------------------------------------------

const GRADE_NOTICES = ['evidence', 'model_total', 'text_scores', 'extraction'];
const NOTICE_ICON = { older: Clock, revision: RotateCcw, newer: RotateCcw, prose: FileText, corrections: FileText, timing: Clock };

function gradeFlagWords(n) {
  if (n.kind === 'evidence') return n.level === 'serious' ? 'Serious evidence flag' : 'Evidence flag';
  if (n.kind === 'model_total') return `Own total differs${n.difference !== null ? ` by ${n.difference.toFixed(1)}` : ''}`;
  if (n.kind === 'text_scores') return 'Text and data block differ';
  return [n.errors ? `${n.errors} extraction error${n.errors === 1 ? '' : 's'}` : null, n.ambiguous ? `${n.ambiguous} ambiguous value${n.ambiguous === 1 ? '' : 's'}` : null].filter(Boolean).join(', ');
}

// Each chip jumps to its sentence below. On the Overview the evidence flag has
// no sentence there (the chip says it already): it opens the Evidence view at
// the desk's checks instead.
export function GradeFlags({ m, pid = null, view = 'evidence' }) {
  const ns = m.notices.filter((n) => GRADE_NOTICES.includes(n.kind));
  if (!ns.length) return null;
  const evidenceHref = pid ? `#/project/${enc(pid)}/evidence?model=${m.provider}${m.is_latest ? '' : `&report=${enc(m.report_id)}`}&open=checks` : null;
  return (
    <ul className="gflags" aria-label="Warnings about this grade">
      {ns.map((n) => {
        const cls = `gflag tone-${n.tone}${n.kind === 'evidence' ? ` ev-${n.level}` : ''}`;
        const inner = <><TriangleAlert size={13} strokeWidth={2} aria-hidden="true" /><span>{gradeFlagWords(n)}</span></>;
        return (
          <li key={n.kind}>
            {n.kind === 'evidence' && view === 'overview' && evidenceHref
              ? <ViewLink pid={pid} href={evidenceHref} className={cls} dataKey={`brief-gflag-${n.kind}`}>{inner}</ViewLink>
              : <button type="button" className={cls} data-key={`brief-gflag-${n.kind}`} onClick={() => jumpTo(`brief-notice-${n.kind}`)}>{inner}</button>}
          </li>
        );
      })}
    </ul>
  );
}

const textScoreLine = (x) => `${x.label} ${x.text.join(' and ')} in the text, ${x.data} in the data block`;

function Notice({ n, m, pid, who, view }) {
  const reportHref = (rid) => `#/project/${enc(pid)}/report?report=${enc(rid)}`;
  const evidenceHref = `#/project/${enc(pid)}/evidence?model=${m.provider}${m.is_latest ? '' : `&report=${enc(m.report_id)}`}`;
  let main;
  let more = null;
  if (n.kind === 'older') {
    main = <><strong>An earlier report. </strong>{`${who}'s latest is from ${fmtDate(n.latest_at)}. `}<a href={`#/project/${enc(pid)}/brief?model=${m.provider}`} data-key="brief-latest" onClick={(e) => { if (!plain(e)) return; e.preventDefault(); navigate(`#/project/${enc(pid)}/brief?model=${m.provider}`, { replace: true, state: history.state }); }}>Open the latest brief</a></>;
  } else if (n.kind === 'revision') {
    const what = n.changed.length ? n.changed.join('; ') : n.categories ? `${n.categories} category grade${n.categories === 1 ? '' : 's'} changed` : 'no score changed';
    const basis = n.basis === 'existing_evidence' ? 'using existing evidence' : `with ${n.added} new source${n.added === 1 ? '' : 's'}`;
    const nar = n.narrowed ? ` ${n.narrowed} range${n.narrowed === 1 ? '' : 's'} became a point inside it${n.narrowed_mid ? (n.narrowed_mid === n.narrowed ? ' (the midpoint)' : ` (${n.narrowed_mid} at the midpoint)`) : ''}${n.basis === 'new_sources' ? '' : ': a narrowing, not new research'}.` : '';
    main = n.basis === 'scores_unchanged' ? <><strong>A re-save</strong> of an earlier save for the same run, with the same scores.</> : <><strong>A revision</strong>{` of an earlier save for the same run, ${basis}: ${what}.${nar}`}</>;
    more = (
      <>
        <p>{n.declared && n.declared.note ? `${who}'s reason${n.declared.label ? ` (${n.declared.label.split(':')[0].toLowerCase()})` : ''}: ${n.declared.note}` : 'No reason was recorded with this save.'}</p>
        {n.minutes !== null ? <p>{`Saved ${n.minutes} min after the first save; both are kept.`}</p> : null}
        {n.of ? <p><a href={reportHref(n.of)} data-key="brief-rev-of">Open the earlier save</a></p> : null}
      </>
    );
  } else if (n.kind === 'model_total') {
    main = <><strong>{`${who}'s own total differs`}</strong>{`${n.difference !== null ? ` by ${n.difference.toFixed(1)}` : ''}: it wrote ${n.reported || '?'}, the desk calculates ${n.calculated || '?'}. The grade shown is the desk's.`}</>;
    more = n.message ? <p>{n.message}</p> : null;
  } else if (n.kind === 'model_total_unchecked') {
    main = `${who} wrote its own total of ${n.reported || '?'}; with the grade withheld it cannot be checked.`;
  } else if (n.kind === 'text_scores') {
    main = <><strong>The text and the data block differ</strong>{`: ${n.items.slice(0, 2).map(textScoreLine).join('; ')}${n.items.length > 2 ? `; and ${n.items.length - 2} more` : ''}. The grade uses the data block as saved; neither is changed. `}<a href={reportHref(m.report_id)} data-key="brief-text-scores">Open the report</a></>;
    more = n.items.length > 2 ? <ul>{n.items.map((x) => <li key={x.label}>{textScoreLine(x)}</li>)}</ul> : null;
  } else if (n.kind === 'evidence') {
    const what = [n.claims ? `${n.claims} claim${n.claims === 1 ? '' : 's'}` : null, n.categories ? `${n.categories} category grade${n.categories === 1 ? '' : 's'}` : null].filter(Boolean).join(' and ') || 'parts of the report';
    main = <><strong>{n.level === 'serious' ? 'Serious evidence flag' : 'Evidence flag'}</strong>{` · ${what} flagged by the desk's evidence checks. No score is changed. `}{view === 'evidence' ? <button type="button" className="btn-link" data-key="brief-ev-jump" onClick={() => jumpTo('brief-ev-checks')}>See the flags</button> : <ViewLink pid={pid} href={`${evidenceHref}&open=checks`} dataKey="brief-ev-jump">See the flags</ViewLink>}</>;
  } else if (n.kind === 'newer') {
    main = <><strong>{n.text}</strong>. This brief stays on the saved report until a new one is saved.</>;
  } else if (n.kind === 'horizon') {
    main = 'This report\'s horizon differs from its research run\'s: read its timing views with care.';
  } else if (n.kind === 'prose') {
    main = 'Read from the written report, without a data block: only labeled scores were read.';
  } else if (n.kind === 'corrections') {
    main = `Your ${n.count} correction${n.count === 1 ? ' is' : 's are'} applied${n.fields.length ? `: ${n.fields.join(', ')}` : ''}. The original is unchanged.`;
  } else if (n.kind === 'extraction') {
    main = <>{[n.errors ? `${n.errors} extraction error${n.errors === 1 ? '' : 's'}` : null, n.ambiguous ? `${n.ambiguous} ambiguous value${n.ambiguous === 1 ? '' : 's'}` : null].filter(Boolean).join(' and ')} in this report. <a href={reportHref(m.report_id)} data-key="brief-extraction">Open the report</a></>;
  } else if (n.kind === 'timing') {
    main = `The report states an analysis time ${n.minutes !== null && n.minutes < 2880 ? `${n.minutes} min` : 'more than a day'} after it was saved; it is ordered by its save time.`;
  } else return null;
  const Icon = NOTICE_ICON[n.kind] || TriangleAlert;
  return (
    <li className={`notice tone-${n.tone}${n.kind === 'evidence' ? ` ev-${n.level}` : ''}`} tabIndex={-1} data-key={`brief-notice-${n.kind}`}>
      <Icon className="notice-ico" size={15} strokeWidth={1.9} aria-hidden="true" />
      <span className="notice-text">
        {main}
        {more ? <details className="notice-more" data-key={`brief-n-${n.kind}`}><summary>Why</summary><div className="notice-body">{more}</div></details> : null}
      </span>
    </li>
  );
}

export function Notices({ list, m, pid, who, label, view = 'overview' }) {
  const items = list.filter(Boolean);
  if (!items.length) return null;
  return <ul className="notices" aria-label={label}>{items.map((n) => <Notice key={n.kind} n={n} m={m} pid={pid} who={who} view={view} />)}</ul>;
}

// ---- the verdict ----------------------------------------------------------------------

// The grade as the metric header (no gauge; Eric, 2026-10-08): the model and
// its verdict, the desk's calculated grade (never the model's own total) with
// the rubric's word, withheld as the share of the weight scored.
function GradeBlock({ m, pid, who, verdict, sub }) {
  const g = m.grade;
  const a = (m.report && m.report.assessment) || {};
  const captionTitle = `Calculated by the desk from ${who}'s six weighted component scores under ${g.rubric || 'its rubric'}; never ${who}'s own total`;
  const scored = g.status === 'firm' || g.status === 'range';
  const grade = scored ? { status: g.status, display: g.grade.display }
    : g.status === 'withheld' ? { status: 'withheld', coverage: typeof g.coverage === 'number' ? g.coverage : null, reason: g.reason || 'No grade is calculated.' }
      : { status: 'none', label: 'No grade', reason: g.reason || 'No grade was calculated.' };
  const tier = scored ? scoreTier(g.status === 'range' ? g.grade.low : g.grade.value) : null;
  return <MetricHeader who={who} model={a.model_version || null} verdict={verdict} grade={grade} word={scored ? g.word : null} tier={tier} captionTitle={captionTitle} sub={sub} chips={<GradeFlags m={m} pid={pid} view="overview" />} />;
}

function ageWords(at, staleDays) {
  const d = daysSince(at);
  if (d === null) return { text: at || 'date not stated', rel: null, stale: false };
  const rel = d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
  return { text: fmtDate(at), rel, stale: Boolean(staleDays && d > staleDays) };
}

const RISK_SHORT = 160;
function RiskText({ text }) {
  const [open, setOpen] = useState(false);
  if (text.length <= RISK_SHORT) return <p className="key-t">{text}</p>;
  return (
    <>
      <p className={`key-t clamp-phone${open ? ' is-open' : ''}`} id="bf-risk-text">{text}</p>
      <button type="button" className="btn-link key-more-btn" aria-expanded={open} aria-controls="bf-risk-text" data-key="brief-risk-more" onClick={() => setOpen(!open)}>{open ? 'Show less' : 'Show the full risk'}</button>
    </>
  );
}

// One trigger: the report's first, the rest one click away (the whole list
// lives here only; the Apple HIG pass, 2026-10-18, removed its repeat under
// What to watch).
function Trigger({ first, rest, missing, id }) {
  const [open, setOpen] = useState(false);
  if (!first) return missing;
  return (
    <>
      <p className="key-t">{first}</p>
      {rest.length ? (
        <>
          <ul className="key-rest" id={id} hidden={!open}>{rest.map((t) => <li key={t}>{t}</li>)}</ul>
          <button type="button" className="btn-link key-rest-btn" aria-expanded={open} aria-controls={id} data-key={id} onClick={() => setOpen(!open)}>{open ? 'Show less' : `+${rest.length} more`}</button>
        </>
      ) : null}
    </>
  );
}

// Key triggers: the strongest sourced risk, then what would confirm the
// thesis beside what would invalidate it. Neutral cards; an 8px dot carries
// the sign and the label says it.
function KeyPoints({ m, who }) {
  const k = m.key;
  if (!k) return null;
  const missing = <p className="key-t key-none">{`Not reported in ${who}'s report`}</p>;
  return (
    <div className="keys-wrap">
      <h3 className="keys-h">Key triggers</h3>
      <dl className="keys" aria-label="Key triggers from the report">
        <div className="key key-risk">
          <dt>{k.risk && k.risk.sourced ? 'Strongest sourced risk' : 'Strongest risk'}</dt>
          <dd>
            {k.risk ? <RiskText text={k.risk.text} /> : missing}
            {k.risk ? (k.risk.sourced ? <CiteLine f={k.risk} /> : <p className="cite"><span className="etag none">No source cited for any listed risk</span></p>) : null}
          </dd>
        </div>
        <div className="key key-confirm">
          <dt>Would confirm</dt>
          <dd><Trigger first={k.confirm} rest={m.watch.confirms.slice(1)} missing={missing} id="bf-confirm-rest" /></dd>
        </div>
        <div className="key key-break">
          <dt>Would invalidate</dt>
          <dd><Trigger first={k.break} rest={m.watch.breaks.slice(1)} missing={missing} id="bf-break-rest" /></dd>
        </div>
      </dl>
    </div>
  );
}

function Verdict({ m, pid, who, staleDays }) {
  const v = m.verdict;
  const a = m.report.assessment || {};
  const age = ageWords(a.analysis_at, staleDays);
  const hz = m.watch.horizon;
  const w = m.watch;
  const next = w.items.find((x) => x.kind === 'catalyst' && (x.end || x.start) >= w.today) || null;
  const review = w.review && w.review.start >= w.today ? w.review : null;
  const lead = v.summary || v.final_take;
  const first = (n) => GRADE_NOTICES.includes(n.kind);
  // The evidence flag is the chip in the header (it opens the Evidence view);
  // its full sentence is on that view, not repeated here.
  const gradeNotices = m.notices.filter((n) => first(n) && n.kind !== 'evidence');
  return (
    <section className={`ov-verdict${m.report_id && m.is_latest ? ' is-latest' : ''}`} id="bf-verdict" aria-label={`${who}'s verdict`}>
      <GradeBlock
        m={m}
        pid={pid}
        who={who}
        sub={(
          <>
            <span><b>{`Analyzed ${age.text}`}</b>{age.rel ? ` · ${age.rel}` : ''}{age.stale ? <span className="v-stale"> · stale</span> : null}</span>
            <span className={hz.months && hz.end ? 'has-short' : undefined}>
              <span className="hz-full">{`Horizon ${hz.start && hz.end ? windowWords(hz.start, hz.end) : hz.text || 'not stated'}`}{hz.months ? ` · ${hz.months} month${hz.months === 1 ? '' : 's'}${hz.mode === 'long_term' ? ', long-term exception' : ''}` : ''}</span>
              {hz.months && hz.end ? <span className="hz-short">{`Horizon ${hz.months} month${hz.months === 1 ? '' : 's'} · to ${fmtDate(hz.end)}`}</span> : null}
            </span>
          </>
        )}
        verdict={v.label}
      />
      <KeyPoints m={m} who={who} />
      {m.grade.status === 'withheld' && m.grade.why.items.length ? (
        <div className="ov-missing">
          <h3>Not scored</h3>
          <ul>{m.grade.why.items.map((x) => <li key={x.label}><strong>{x.label}</strong>{` · ${x.status}`}{x.note ? <span className="faint">{`: “${x.note.length > 320 ? `${x.note.slice(0, 319)}…` : x.note}”`}</span> : null}</li>)}</ul>
          {m.structure ? (
            <details className="fold" data-key="brief-structure">
              <summary>{`Check · ${m.structure.flags.length} note${m.structure.flags.length === 1 ? '' : 's'}`}</summary>
              <ul className="plain-list">{m.structure.flags.slice(0, 6).map((f) => <li key={f.message}>{f.message}</li>)}</ul>
            </details>
          ) : null}
        </div>
      ) : null}
      {lead ? <div className="ov-why"><h3 className="ov-h3">{`${who}'s summary`}</h3><p className="ov-lead">{lead}</p></div> : <p className="none">{`No summary in ${who}'s data block.`}</p>}
      {v.falsifiable ? (
        <div className="ov-why" data-key="brief-falsifiable">
          <h3 className="ov-h3" title={`${who}'s own ${v.falsifiable.label || 'judgment'}, not a verified fact`}>Falsifiable thesis</h3>
          <p className="ov-lead">{v.falsifiable.text}</p>
          {v.falsifiable.test ? <p className="faint">{`Would disprove it: ${v.falsifiable.test}`}</p> : null}
        </div>
      ) : null}
      {v.timing || v.market || next || review ? (
        <p className="ov-views" title={`${who}'s own views for this horizon; they change no score`}>
          {v.timing ? <span className="ov-view" title={v.timing.rationale || undefined}><span className="k">Timing</span>{v.timing.word}</span> : null}
          {v.market ? <span className="ov-view" title={v.market.rationale || undefined}><span className="k">Market</span>{v.market.word}</span> : null}
          {next ? <span className="ov-view" title={`${next.title} · ${CERTAINTY_WORDS[next.certainty]}`}><span className="k">Next</span><span className="ov-view-t">{next.title}</span><span className="faint"> · </span>{windowWords(next.start, next.end)}</span> : null}
          {review ? <span className="ov-view" title={review.trigger ? `Sooner if: ${review.trigger}` : undefined}><span className="k">Review</span>{fmtDate(review.start)}</span> : null}
        </p>
      ) : null}
      <Notices list={gradeNotices} m={m} pid={pid} who={who} label="Warnings about this grade" />
      <Notices list={m.notices.filter((n) => !first(n))} m={m} pid={pid} who={who} label="Before you rely on this brief" />
    </section>
  );
}

// ---- the category grades --------------------------------------------------------------

function CategoryItem({ x, who }) {
  if (x.status === 'na') {
    return <li className="ocat is-na"><div className="ocat-row"><span className="ocat-name" title={x.na_reason || x.label}>{x.label}</span><span className="faint">N/A</span></div></li>;
  }
  const scored = x.status === 'scored' || x.status === 'range';
  const serious = x.flags.some((f) => f.severity === 'high');
  const item = (k, v) => (v ? [<dt key={`${k}t`}>{k}</dt>, <dd key={`${k}d`}>{v}</dd>] : []);
  return (
    <li className={`ocat${scored ? '' : ' is-unknown'}`}>
      <details data-key={`brief-cat-${x.id}`}>
        <summary aria-label={`${x.label}: ${scored ? `${scoreWords(x)} out of 100${x.word ? `, ${x.word}` : ''}${x.confidence ? `, ${CONFIDENCE_LABELS[x.confidence].toLowerCase()} confidence` : ''}` : scoreWords(x)}${x.flags.length ? `; ${serious ? 'serious evidence flag' : 'evidence flag'}` : ''}. Open for the reasons`}>
          <span className="ocat-name" aria-hidden="true" title={x.definition || undefined}>
            {x.label}
            {x.flags.length ? <span className={`ev-dot ${serious ? 'serious' : 'material'}`} title={x.flags.map((f) => f.text).join(' ')} /> : null}
          </span>
          <ScoreBar score={asScore(x)} />
          <span className="ocat-v" aria-hidden="true">
            <span className={`ocat-num${scored ? '' : ' is-unknown'}`}>{scoreWords(x)}</span>
            {x.confidence && CONF_LETTER[x.confidence] ? <span className="ocat-conf" title={`${CONFIDENCE_LABELS[x.confidence]} confidence, as ${who} states it`}>{CONF_LETTER[x.confidence]}</span> : null}
          </span>
        </summary>
        <div className="ocat-body">
          {x.word ? <p className="ocat-word">{x.word}</p> : null}
          {x.flags.map((f) => <p key={f.text} className={`evline ev-${f.severity === 'high' ? 'serious' : 'material'}`}><TriangleAlert size={13} aria-hidden="true" /><span><strong>{f.severity === 'high' ? 'Serious evidence flag. ' : 'Evidence flag. '}</strong>{f.text} The grade is shown as written.</span></p>)}
          <dl>
            {item(scored ? 'Why this grade' : 'Why unknown', scored ? x.rationale || 'No reason given.' : x.status === 'missing' ? 'Not graded in this report.' : x.missing || 'Not stated.')}
            {item('Strongest evidence', x.strongest_evidence)}
            {item('Main weakness', x.main_weakness)}
            {item('Would raise it', x.would_raise)}
            {item('Would lower it', x.would_lower)}
          </dl>
        </div>
      </details>
    </li>
  );
}

function Section({ id, title, sub = null, children, className = '' }) {
  return (
    <section className={`ov-sec ov-${id} ${className}`.trim()} id={`bf-${id}`} aria-labelledby={`bf-h-${id}`}>
      <h2 className="ov-h" id={`bf-h-${id}`}>{title}{sub ? <span className="ov-h-sub">{sub}</span> : null}</h2>
      {children}
    </section>
  );
}

function Categories({ m, who }) {
  const c = m.categories;
  const counts = c.counts;
  return (
    <Section id="categories" title="Category grades" sub={<>{`${c.items.length} diagnostics · ${counts.scored} of ${counts.total} graded${counts.unknown ? ` · ${counts.unknown} unknown` : ''} · never averaged into the grade`}{m.older_profile ? <span title={`This report used ${m.older_profile.report}; new research uses ${m.older_profile.current}`}>{` · ${m.older_profile.report}`}</span> : null}</>}>
      {c.groups.length ? (
        <div className="ocat-groups">
          {c.groups.map((g) => {
            const graded = g.items.filter((x) => x.status === 'scored' || x.status === 'range').length;
            const total = g.items.filter((x) => x.status !== 'na').length;
            return (
              <div key={g.id} className="ocat-group">
                <h3>{g.title}<span className="ocat-gn">{total ? `${graded} of ${total} graded` : 'not applicable'}</span></h3>
                <ul aria-label={`${g.title}: category grades, 0 to 100, higher is better`}>{g.items.map((x) => <CategoryItem key={x.id} x={x} who={who} />)}</ul>
              </div>
            );
          })}
        </div>
      ) : <p className="none">This report grades no categories.</p>}
    </Section>
  );
}

function Inputs({ m, who }) {
  const g = m.grade;
  const total = g.status === 'firm' || g.status === 'range' ? g.display : null;
  return (
    <Section id="inputs" title="What the grade is calculated from" sub="six weighted components · the only inputs to the grade">
      <div className="ov-well">
        <ul className="ocomps" aria-label="The six weighted components of the investment grade, 0 to 100, higher is better">
          {m.components.map((c) => {
            const x = { status: c.status === 'not_applicable' ? 'na' : ['scored', 'range', 'missing'].includes(c.status) ? c.status : 'unknown', value: c.score ? c.score.value : null, low: c.score ? c.score.low : null, high: c.score ? c.score.high : null };
            const why = c.rationale || c.missing;
            return (
              <li key={c.id} className={`ocomp${x.status === 'scored' || x.status === 'range' ? '' : ' is-unknown'}`}>
                <details data-key={`brief-comp-${c.id}`}>
                  <summary aria-label={`${c.label}, ${c.weight_pct} percent of the grade: ${scoreWords(x)}${c.contribution !== null ? `, adds ${c.contribution.toFixed(1)} points` : ''}. Open for the reason`}>
                    <span className="ocomp-name" aria-hidden="true">{c.label}<span className="ocomp-w">{`${c.weight_pct}%`}</span></span>
                    <ScoreBar score={asScore(x)} />
                    <span className="ocomp-v" aria-hidden="true">{scoreWords(x)}</span>
                    <span className="ocomp-pts" aria-hidden="true">{c.contribution !== null ? `+${c.contribution.toFixed(1)}` : ''}</span>
                  </summary>
                  <div className="ocomp-body">{why ? <p>{why}</p> : <p className="none">No reason given.</p>}</div>
                </details>
              </li>
            );
          })}
        </ul>
        <details className="fold" data-key="brief-how">
          <summary>How the grade is calculated</summary>
          <div className="fold-body">
            <p>{`Each component's score is multiplied by its weight and the results are added${total ? `: together ${total}` : ''}. The weights come from ${g.rubric || 'the report\'s rubric'} and are never adjusted.`}</p>
            <p>A range stays a range: the grade then runs from the low ends to the high ends. If any component is unknown, no grade is calculated and the scored share of the weight is shown instead.</p>
            <p>{`The category grades and the downside-risk scores are shown apart and never averaged in; ${who}'s own total, if it wrote one, is kept beside the grade, never in its place.`}</p>
          </div>
        </details>
      </div>
    </Section>
  );
}

// ---- the thesis and what supports or threatens it ------------------------------------------

function sourceWord(ans, who) {
  if (ans.from === 'category') return `${who}'s reasoning for its ${ans.label.toLowerCase()} grade (${ans.status === 'range' ? `${ans.low}–${ans.high}` : ans.value})`;
  if (ans.from === 'component') {
    const s = ans.score;
    const sc = !s ? 'not scored' : s.status === 'scored' ? String(s.value) : s.status === 'range' ? `${s.low}–${s.high}` : s.status === 'not_applicable' ? 'N/A' : 'unknown';
    return `${who}'s reasoning for the ${ans.label.toLowerCase()} component (${ans.weight_pct}% of the grade, ${sc})`;
  }
  return `${who}'s ${ans.kind || 'view'}: ${ans.label.toLowerCase()}`;
}

function ValueFlow({ v }) {
  if (!v.show) return null;
  return (
    <div className="vflow" role="group" aria-label="Where the value goes, as the report quantifies it">
      {v.layers.map((l) => (
        <div key={l.id} className={`vlayer${l.items.some((x) => x.reported) ? '' : ' none'}`}>
          <p className="vlayer-t">{l.title}</p>
          {l.items.length ? (
            <dl>
              {l.items.map((x) => (
                <div key={x.id} title={x.definition || undefined}>
                  <dt>{x.label}</dt>
                  <dd>{x.reported ? <><span className="fig">{x.text}</span>{x.tag ? <span className={`etag t-${x.tag.toLowerCase()}`} title={TAG_TITLES[x.tag]}>{TAG_WORDS[x.tag]}</span> : null}{[x.period, x.as_of ? `as of ${x.as_of}` : null].filter(Boolean).length ? <span className="faint">{` ${[x.period, x.as_of ? `as of ${x.as_of}` : null].filter(Boolean).join(' · ')}`}</span> : null}</> : <span className="faint">Not reported</span>}</dd>
                </div>
              ))}
            </dl>
          ) : <p className="none">Not part of this profile</p>}
        </div>
      ))}
    </div>
  );
}

function Thesis({ m, who }) {
  const v = m.verdict;
  const final = v.summary && v.final_take ? <div className="oq"><h3>{`${who}'s final judgment`}</h3><p className="oq-text">{v.final_take}</p></div> : null;
  if (!m.thesis.some((t) => t.answer) && !final && !m.value.show) return <Section id="thesis" title="The thesis"><p className="none">{`${who}'s report has no thesis fields to draw from; the full report has its reasoning.`}</p></Section>;
  return (
    <Section id="thesis" title="The thesis">
      <div className="oqs">
        {m.thesis.map((t) => (
          <div key={t.id} className="oq">
            <h3>{t.title}</h3>
            {t.answer ? (
              <>
                <p className="oq-text">{t.answer.text}</p>
                {t.answer.from === 'judgment' && t.answer.test ? <p className="oq-test"><span className="k">Would be wrong if</span>{t.answer.test}</p> : null}
                <p className="oq-src">{sourceWord(t.answer, who)}</p>
              </>
            ) : <p className="none">{`Not stated in ${who}'s report.`}</p>}
            {t.id === 'capture' ? <ValueFlow v={m.value} /> : null}
          </div>
        ))}
      </div>
      {final}
    </Section>
  );
}

function FactList({ items, label }) {
  if (!items.length) return <p className="none">None given in the report.</p>;
  return (
    <ol className="facts-list" aria-label={label}>
      {items.map((f) => <li key={f.text}><p className="fact">{f.text}</p><CiteLine f={f} /></li>)}
    </ol>
  );
}

function RiskBars({ m }) {
  const rows = m.risks.filter((x) => x.status !== 'na');
  if (!rows.length) return null;
  return (
    <div className="orisks">
      <h3 className="ov-h3">Downside risk<span className="ov-h-sub">higher is worse</span></h3>
      <ul aria-label="Downside-risk scores, 0 to 100, higher means more risk">
        {rows.map((x) => (
          <li key={x.id} className={`orisk${x.status === 'scored' || x.status === 'range' ? '' : ' is-unknown'}`} title={x.rationale || x.definition || undefined}>
            <span className="orisk-name">{x.label.replace(/ risk$/i, '')}</span>
            <ScoreBar score={asScore(x)} risk />
            <span className="orisk-v"><span aria-hidden="true">{scoreWords(x)}</span><span className="sr-only">{x.status === 'scored' || x.status === 'range' ? ' out of 100, higher is more risk' : ''}</span></span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Thesis pillars: what supports it beside what threatens it, once. The
// strongest sourced risk already leads the Key triggers, so it is not
// repeated here; the line says where it is.
function ForAgainst({ m, who }) {
  const lead = m.key && m.key.risk ? m.key.risk.text : null;
  const threatens = m.threatens.filter((f) => f.text !== lead);
  const moved = threatens.length < m.threatens.length;
  return (
    <Section id="pillars" title="Thesis pillars">
      <div className="pillars">
        <div className="pillar is-pos">
          <h3 className="pillar-h">Supports</h3>
          <FactList items={m.supports} label={`${who}'s strongest positives`} />
        </div>
        <div className="pillar is-neg">
          <h3 className="pillar-h">Threatens</h3>
          {threatens.length || !moved ? <FactList items={threatens} label={`${who}'s strongest risks`} /> : null}
          {moved ? <p className="pillar-note">The strongest sourced risk is under Key triggers.</p> : null}
        </div>
      </div>
    </Section>
  );
}

// The scorecards first, side by side at desktop width (§3.3): the 13
// diagnostic categories in their four groups beside the six weighted
// components the grade is calculated from and the downside-risk scores. Three
// separate panels, never mixed or averaged.
function Scorecards({ m, who }) {
  return (
    <div className="ov-scorecards">
      <Categories m={m} who={who} />
      <div className="ov-score-side">
        <Inputs m={m} who={who} />
        <RiskBars m={m} />
      </div>
    </div>
  );
}

// What code the report says it read (code_review): kept with the brief, the
// Build and code category's detail.
function CodeRead({ m, who }) {
  const cr = m.report && m.report.assessment ? m.report.assessment.code_review : null;
  if (!cr || (typeof cr === 'object' && !Object.keys(cr).length)) return null;
  return (
    <details className="fold ov-code" data-key="brief-code">
      <summary>{`Code that was read · ${who}`}</summary>
      <Dom build={(L) => L.codeReviewBlock(m.report.assessment)} deps={[m.report_id]} />
    </details>
  );
}

// ---- what to watch -----------------------------------------------------------------------

function lanes(items) {
  const last = [];
  for (const x of items) {
    if (x.pos === null) continue;
    let lane = 0;
    while (last[lane] !== undefined && x.pos - last[lane] < 7) lane += 1;
    x.lane = Math.min(lane, 2);
    last[x.lane] = Math.max(x.pos_end ?? x.pos, x.pos);
  }
}

function Track({ w }) {
  const hz = w.horizon;
  if (!hz.start || !hz.end) return null;
  const onTrack = w.items.filter((x) => x.pos !== null);
  lanes(onTrack);
  const top = Math.max(0, ...onTrack.map((x) => x.lane || 0));
  const elapsed = w.ended ? 100 : w.today_pos === null ? (w.today < hz.start ? 0 : 100) : w.today_pos;
  const caption = w.ended ? 'The horizon has ended' : w.days ? `${w.days.left} of ${w.days.total} days left` : null;
  return (
    <div className={`htrack l${top}${w.ended ? ' is-ended' : ''}`}>
      <div className="htrack-lanes" aria-hidden="true">
        <div className="htrack-rail"><span className="htrack-elapsed" style={{ width: `${elapsed}%` }} /></div>
        {onTrack.map((x) => (x.kind === 'review'
          ? <span key={`r${x.n}`} className={`htrack-pin lane-${x.lane || 0}`} style={{ left: `${x.pos}%` }}><span className="htrack-num">{x.n}</span></span>
          : <span key={`c${x.n}`} className={`htrack-win lane-${x.lane || 0}`} style={{ left: `${x.pos}%`, width: `${Math.max(0, (x.pos_end ?? x.pos) - x.pos)}%` }}><span className="htrack-num">{x.n}</span></span>))}
        {w.today_pos !== null && !w.ended ? <span className="htrack-today" style={{ left: `${w.today_pos}%` }} /> : null}
      </div>
      <div className="htrack-ends">
        <span>{fmtDate(hz.start)}</span>
        {caption ? <span className="htrack-days">{caption}</span> : null}
        <span>{fmtDate(hz.end)}</span>
      </div>
    </div>
  );
}

function Watch({ m, who, pid }) {
  const w = m.watch;
  const tv = m.verdict.timing;
  return (
    <Section id="watch" title="What to watch">
      {tv && tv.rationale ? <p className="ow-timing"><span className="k">{`${who}'s timing view · ${tv.word}`}</span>{tv.rationale}</p> : null}
      <Track w={w} />
      {w.items.length ? (
        <ol className="ow-events" aria-label="Dated catalysts and the suggested review, in date order">
          {w.items.map((x) => (
            <li key={`${x.kind}-${x.n}`} className={`ow-ev is-${x.kind}`}>
              <span className="htrack-num" aria-hidden="true">{x.n}</span>
              <div>
                <p className="ow-ev-t">{x.kind === 'review' ? `${who} suggests a review` : x.title}</p>
                <p className="ow-ev-m">
                  <span>{windowWords(x.start, x.end)}</span>
                  {x.kind === 'catalyst' ? <><span className="faint"> · </span><span>{CERTAINTY_WORDS[x.certainty]}</span></> : null}
                  {x.kind === 'catalyst' && x.pos === null && x.in_horizon !== false ? <span className="faint"> · horizon dates unknown</span> : null}
                </p>
                {x.kind === 'review' && x.trigger ? <p className="ow-ev-x"><span className="k">Sooner if</span>{x.trigger}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      ) : (w.horizon.start ? <p className="none">No dated catalyst or review date in the report.</p> : null)}
      {w.review_trigger_only ? <p className="ow-ev-x"><span className="k">Review sooner if</span>{w.review_trigger_only}</p> : null}
      {w.undated.length ? <div className="ow-aside"><h3 className="ov-h3">Date unknown</h3><ul>{w.undated.map((x) => <li key={x.title}>{x.title}<span className="faint">{` · ${CERTAINTY_WORDS[x.certainty]}`}</span></li>)}</ul></div> : null}
      {w.outside.length ? <div className="ow-aside"><h3 className="ov-h3">Outside the horizon</h3><ul>{w.outside.map((x) => <li key={x.title}>{x.title}<span className="faint">{` · ${windowWords(x.start, x.end)} · ${CERTAINTY_WORDS[x.certainty]}`}</span></li>)}</ul></div> : null}
      {w.metric ? (
        <div className="ow-metric">
          <h3 className="ov-h3">The one development to watch</h3>
          <p><strong>{w.metric.metric}</strong>{w.metric.threshold ? <span className="fig">{` · ${w.metric.threshold}`}</span> : null}</p>
          {w.metric.why ? <p className="oq-src">{w.metric.why}</p> : null}
        </div>
      ) : null}
      {m.chart ? (
        <details className="fold" data-key="brief-chart">
          <summary>{`${who}'s chart and cycle reading`}</summary>
          <Dom build={(L) => L.chartCycleBlock(m.report.assessment || {}, { full: true })} deps={[m.report_id]} />
        </details>
      ) : null}
    </Section>
  );
}

// ---- the scenarios -------------------------------------------------------------------------

// Bear, base and bull as three cards (the Apple HIG pass, 2026-10-18: the
// probability bar and the price plot only repeated them): the case and its
// probability, the price range large, the range against BTC as a badge, the
// assumptions as bullets, then the outcome and what breaks it.
function Scenarios({ m, who }) {
  const s = m.scenarios;
  if (!s) return null;
  const order = ['bear', 'base', 'bull'];
  const rows = s.rows.slice().sort((x, y) => (order.indexOf(x.id) + 1 || 9) - (order.indexOf(y.id) + 1 || 9));
  const notes = [
    s.probability && s.probability.status !== 'ok' ? s.probability.message : null,
    s.targets && !['given', 'none'].includes(s.targets.status) ? s.targets.message : null,
    s.definition ? `Against BTC: ${s.definition}` : null,
  ].filter(Boolean);
  return (
    <Section id="scenarios" title="Scenarios" sub={`Forecasts: ${who}'s own estimates, not facts`}>
      <div className="scns">
        {rows.map((x) => (
          <article key={x.id} className={`scn is-${x.id}`} aria-labelledby={`bf-scn-${x.id}`}>
            <h3 className="scn-head" id={`bf-scn-${x.id}`}>
              <span className="scn-name">{x.label}</span>
              {x.probability !== null ? <span className="scn-prob" title={`${who}'s subjective estimate`}>{`${x.probability}%`}</span> : <span className="scn-prob none">No probability</span>}
            </h3>
            <p className="scn-price">{x.price ? <span className="fig">{x.price}</span> : <span className="none">No price range given</span>}</p>
            <p className="scn-btc-row">{x.vsBtc ? <span className="scn-btc fig">{`${x.vsBtc} vs BTC`}</span> : <span className="none">No range against BTC</span>}</p>
            {x.assumptions.length ? <ul className="scn-as" aria-label="Assumes">{x.assumptions.map(([k, val]) => <li key={k}><span className="faint">{`${k}: `}</span>{val}</li>)}</ul> : null}
            {x.outcome ? <p className="scn-out"><span className="k">Outcome</span>{x.outcome}</p> : null}
            {x.invalidation ? <p className="scn-out"><span className="k">Breaks if</span>{x.invalidation}</p> : null}
          </article>
        ))}
      </div>
      {notes.length ? <ul className="scn-notes">{notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
    </Section>
  );
}

// ---- evidence line and your note --------------------------------------------------------------

function EvidenceLine({ m, pid }) {
  const e = m.evidence;
  const n = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  const flags = e.flags.length ? `${n(e.flags.length, 'evidence flag')}${e.checks && e.checks.high ? `, ${e.checks.high} serious` : ''}` : `evidence checks: ${checksWord(e.checks)}`;
  return (
    <section className="ov-sec ov-evlink" aria-labelledby="bf-h-evlink">
      <div>
        <h2 className="ov-h" id="bf-h-evlink">Evidence and sources</h2>
        <p className="faint">{[n(e.sources.length, 'source'), n(e.total, 'claim'), flags].join(' · ')}</p>
      </div>
      <ViewLink pid={pid} href={`#/project/${enc(pid)}/evidence?model=${m.provider}${m.is_latest ? '' : `&report=${enc(m.report_id)}`}`} className="btn btn-sm" dataKey="brief-open-evidence">Open the evidence</ViewLink>
    </section>
  );
}

export function YourNote({ d, row, pid, who }) {
  const c = d.conviction;
  const text = c ? String(c.text || '').trim() : '';
  const review = row && row.next_review;
  return (
    <section className="ov-sec ov-yours" aria-labelledby="bf-h-yours">
      <h2 className="ov-h" id="bf-h-yours">Your note<span className="ov-h-sub">{`yours, not ${who}'s`}</span></h2>
      {text ? <p className="ov-yours-text">{text}</p> : <p className="none">No conviction note yet.</p>}
      <p className="ov-yours-m">
        {c && c.updated_at ? <span>{`Saved ${fmtDate(c.updated_at)}${c.conviction ? ` · conviction ${c.conviction}` : ''}`}</span> : null}
        {review ? <span>{`Your next review ${fmtDate(review.date)}${review.overdue ? ' (overdue)' : ''}`}</span> : null}
        <a href={`#/project/${enc(pid)}/notes`} data-key="brief-note-edit">{text ? 'Edit your note' : 'Write your note'}</a>
      </p>
    </section>
  );
}

// ---- no brief to show -------------------------------------------------------------------------

export function EmptyBrief({ m, d, row, pid, who }) {
  const e = m.empty;
  let title = `No ${who} report yet`;
  const lines = [];
  if (e.kind === 'not_found') title = 'This report is not on this project';
  else if (e.kind === 'other_provider') title = `This is ${e.other}'s report`;
  else if (e.kind === 'broken') title = 'This report could not be read';
  else if (e.kind === 'ineligible' && e.why) title = e.why.kind === 'quarantined' ? `${who}'s answer was quarantined` : e.why.kind === 'pdf' ? 'A PDF without a text copy' : 'This report is excluded';
  const quarantineLines = (reason) => [
    <p key="q">It does not match the research run it was saved for, so it is kept but not graded, and no brief is drawn from it.</p>,
    reason ? <details key="qw" className="fold" data-key="brief-q-why"><summary>Why</summary><p className="fold-body">{reason}</p></details> : null,
  ];
  if (e.kind === 'ineligible' && e.why && e.why.kind === 'quarantined') lines.push(...quarantineLines(e.why.reason));
  if (e.kind === 'ineligible' && e.why && e.why.kind === 'excluded') lines.push(<p key="x">{`It is excluded from comparison${e.why.reason ? `: ${e.why.reason}` : ''}, so no brief is drawn from it.`}</p>);
  if (e.kind === 'ineligible' && e.why && e.why.kind === 'pdf') lines.push(<p key="p">No scores were read from it, so no brief is drawn from it until a text copy is imported.</p>);
  if (e.kind === 'broken' && e.why) lines.push(<p key="b">{e.why.reason}</p>);
  if (e.kind === 'other_provider') lines.push(<p key="o">{`The ${who} Brief reads ${who}'s reports only.`}</p>);
  if (e.kind === 'none') {
    if (e.quarantined) {
      title = `${who}'s answer was quarantined`;
      lines.push(...quarantineLines(e.quarantined.reason));
    } else if (e.job) {
      lines.push(<p key="j" className={`state-word tone-${e.job.tone || 'none'}`}>{e.job.long}</p>);
      if (e.job.error && e.job.key === 'failed') lines.push(<p key="je" className="v-error">{e.job.error}</p>);
    } else if (e.hold) lines.push(<p key="h">{`${who} is on hold on this desk${e.hold.since ? ` since ${fmtDate(e.hold.since)}` : ''}: nothing new is assigned to it.`}</p>);
    else if (e.archived) lines.push(<p key="a">The project is archived: its records are kept, and no research is offered here.</p>);
    if (e.pdf) lines.push(<p key="pdf">{`A PDF report from ${fmtDate(e.pdf.saved_at)} is saved and needs a text copy before it can be read. `}<a href={`#/review?seg=imports&project=${enc(pid)}&provider=${m.provider}`} data-key="brief-pdf-import">Import the text</a></p>);
    if (e.excluded) lines.push(<p key="ex">{`A report is excluded from comparison${e.excluded.reason ? `: ${e.excluded.reason}` : ''}.`}</p>);
  }
  const runHref = `#/project/${enc(pid)}/record?model=${m.provider}&open=runs`;
  return (
    <section className="ov-sec ov-empty" aria-labelledby="bf-h-empty">
      <div className="ov-empty-mark" aria-hidden="true"><FileText size={22} /></div>
      <h2 className="ov-empty-t" id="bf-h-empty">{title}</h2>
      {lines}
      <p className="ov-links">
        {e.kind === 'none' && e.can_run ? (
          <button type="button" className="btn btn-primary btn-sm" data-key="brief-run" onClick={async () => { const L = await loadLegacy(); const p = row ? { ...row } : { ...d.project, research: null }; L.openResearchDialog(legacyCtx, { ...p, report_count: (d.reports || []).length }, { providers: [m.provider] }); }}>{`Run ${who} research…`}</button>
        ) : null}
        {e.latest_id && e.kind !== 'none' ? <a className="btn btn-sm" href={`#/project/${enc(pid)}/brief?model=${m.provider}`} data-key="brief-latest-empty">{`${who}'s latest brief`}</a> : null}
        {e.report_id && ['ineligible', 'other_provider'].includes(e.kind) ? <a className="btn btn-sm" href={`#/project/${enc(pid)}/report?report=${enc(e.report_id)}`} data-key="brief-empty-report">Open the report</a> : e.pdf ? <a className="btn btn-sm" href={`#/project/${enc(pid)}/report?report=${enc(e.pdf.report_id)}`} data-key="brief-pdf-report">Open the PDF report</a> : null}
        {e.job || e.quarantined || (e.why && e.why.kind === 'quarantined') ? <a className="btn btn-sm" href={runHref} data-key="brief-empty-runs">Research runs</a> : null}
      </p>
    </section>
  );
}

// ---- the sheet -----------------------------------------------------------------------------

export function SheetHead({ m, title }) {
  return (
    <header className={`sheet-head${m.report_id && m.is_latest ? ' is-latest' : ''}`}>
      <h2 id="bf-title" className="sheet-title" tabIndex={-1}>{title}<span className="sr-only">{`: ${m.identity.name}`}</span></h2>
      {m.report_id ? <p className="sheet-sub">{m.is_latest ? 'Latest report' : 'An earlier report'}<span className="faint">{` · saved ${fmtDate(m.provenance.saved_at)}`}</span></p> : null}
    </header>
  );
}

export default function Overview({ m, d, row, pid, staleDays }) {
  const who = m.who;
  if (m.status !== 'ok') {
    return (
      <article className="sheet" id="brief-sheet" aria-labelledby="bf-title">
        <SheetHead m={m} title={`${who} Brief`} />
        <EmptyBrief m={m} d={d} row={row} pid={pid} who={who} />
        <YourNote d={d} row={row} pid={pid} who={who} />
      </article>
    );
  }
  return (
    <article className="sheet" id="brief-sheet" aria-labelledby="bf-title">
      <SheetHead m={m} title={`${who} Brief`} />
      <Verdict m={m} pid={pid} who={who} staleDays={staleDays} />
      <Scorecards m={m} who={who} />
      <Thesis m={m} who={who} />
      <ForAgainst m={m} who={who} />
      <Watch m={m} who={who} pid={pid} />
      <Scenarios m={m} who={who} />
      <CodeRead m={m} who={who} />
      <EvidenceLine m={m} pid={pid} />
      <YourNote d={d} row={row} pid={pid} who={who} />
    </article>
  );
}
