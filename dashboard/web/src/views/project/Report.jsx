// The project page's Full report section (#/project/<id>/report): the saved
// reports grouped by model on the left (excluded and quarantined ones listed
// and said so); the chosen one's head, its summary in reading order (the
// verdict and the grade this app calculates, the category grades, positives
// and risks, the chart and cycle reading, catalysts, the model's judgment, the
// next review, the top downside risks, the scenarios, the code it read, its
// open questions and sources), the original as received (formatted, or its
// exact text), then its records (corrections, claims, the normalized data,
// extraction notes, the file and its provenance); from 1280px the report's
// contents beside it, the part in view marked.
//
// Drawing it writes nothing and asks no provider: the original and the
// normalized record are read only when shown (GETs, kept once read, kit.jsx).
// The one write is Add a correction, from its button. Port of
// public/views/project.js reportsTab and the parts it calls. Styles:
// styles/report.css.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TriangleAlert, Download } from 'lucide-react';
import {
  PROVIDERS, PROVIDER_LABELS, fmtDate, fmtDateTime, scoreTier, safeUrl,
  withheldReason, unscoredFrom, withheldLabel, COVERAGE_MEANS, toast,
} from '../../../../public/ui.js';
import { renderMarkdown } from '../../../../public/md.js';
import {
  profileOf, categoryRows, scorecardCounts, confidenceLine, statesConfidence, categoryFlags, hasDetail,
  scenarioRows, PHASE_LABELS, CONFIDENCE_LABELS,
} from '../../../../public/thesis-ui.js';
import { CERTAINTY_LABELS } from '../../../../public/position-ui.js';
import { api, refresh } from '../../lib/desk.js';
import { useDesk } from '../../lib/hooks.js';
import { navigate } from '../../lib/router.js';
import { ScoreBar } from '../../components/ScoreBar.jsx';
import { Fold, KV, ExtLink, LazyPre, useLazyText, enc, plural } from './kit.jsx';
import '../../styles/report.css';

// ---- small helpers ---------------------------------------------------------------------

const plain = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
// A report's free text as text: a value of another type is shown as written
// (JSON), never dropped and never interpreted.
const str = (v) => (v === null || v === undefined || v === '' ? null : typeof v === 'string' || typeof v === 'number' ? v : JSON.stringify(v));
const refsText = (refs) => (Array.isArray(refs) && refs.length ? refs.join(', ') : null);
const isScored = (s) => Boolean(s) && (s.status === 'scored' || s.status === 'range');
const isPdfFile = (r) => String((r.meta && r.meta.original_file) || '').toLowerCase().endsWith('.pdf');
const verdictWords = (v) => (v ? `${v.charAt(0)}${v.slice(1).toLowerCase()}` : null);
const dateOr = (s, none) => (s ? fmtDate(s) : none);
const reportHref = (pid, r) => `#/project/${enc(pid)}/report?report=${enc(r.report_id)}${r.meta && r.meta.provider ? `&model=${r.meta.provider}` : ''}`;

// The report's JSON block (the data the desk reads its grades from), set
// apart from the written report: only a fenced block holding the report's
// schema_version, the last one; the text itself is never changed. (The same
// rule as views/project.js splitDataBlock.)
function splitDataBlock(text) {
  const fence = /```[ \t]*[A-Za-z0-9_-]*[^\n]*\n([\s\S]*?)\n[ \t]*```/g;
  let last = null;
  let m;
  while ((m = fence.exec(text))) if (/"schema_version"/.test(m[1])) last = { start: m.index, end: m.index + m[0].length, body: m[1] };
  if (!last) return { prose: text, block: null };
  return { prose: `${text.slice(0, last.start)}${text.slice(last.end)}`, block: last.body };
}

// Where a report is among its model's reports, in one word.
function standing(r, latestIds) {
  const el = r.assessment && r.assessment.eligibility;
  const prov = r.meta && r.meta.provenance;
  if ((el && el.excluded && el.quarantined) || (prov && prov.quarantined)) return { word: 'Quarantined', reason: (el && el.reason) || null };
  if (!r.eligible) return { word: 'Excluded', reason: (el && el.reason) || null };
  return { word: latestIds.has(r.report_id) ? 'latest' : 'earlier', reason: null };
}

// A link to another report or view of the project; opened from the inspector
// it keeps that way back (one entry deeper), as the page's own links do.
function PageLink({ pid, href, children, ...rest }) {
  return (
    <a
      href={href}
      {...rest}
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

// Opens a fold named by its key, brings it into view and puts focus on it.
function openFold(key) {
  const el = document.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (!el) return;
  if (el.tagName === 'DETAILS' && !el.open) el.open = true;
  el.scrollIntoView({ block: 'start' });
  const s = el.querySelector(':scope > summary') || el;
  s.focus({ preventScroll: true });
}

// ---- scores --------------------------------------------------------------------------

// A score as the report gives it: its figure (a range as its two ends) and a
// bar; unknown and not applicable in words, never a zero.
function Score({ s, risk = false }) {
  const cls = `rp-score${risk ? ' is-risk' : ''}`;
  if (!s) return <span className={`${cls} is-unknown`} title="Not in this report"><span className="rp-score-v">—</span></span>;
  if (s.status === 'not_applicable') return <span className={`${cls} is-na`} title={s.rationale || 'Not applicable'}><span className="rp-score-v">N/A</span><span className="rp-score-w">not applicable</span></span>;
  const title = [s.rationale, s.extraction ? `Extracted from prose (line ${s.extraction.line}): ${s.extraction.excerpt}` : null, risk ? 'Higher means more risk' : 'Higher is better'].filter(Boolean).join('\n');
  if (s.status === 'range') {
    return <span className={cls} title={title}><span className="rp-score-v">{`${s.low}–${s.high}`}</span><ScoreBar score={s} risk={risk} /></span>;
  }
  if (s.status === 'scored' && typeof s.value === 'number') {
    return (
      <span className={cls} title={title}>
        <span className="rp-score-v">{String(s.value)}</span>
        <ScoreBar score={s} risk={risk} />
        {s.extraction ? <span className="rp-chip" title="Read from the prose, not a JSON block. Check against the original.">read from prose</span> : null}
      </span>
    );
  }
  return <span className={`${cls} is-unknown`} title={s.missing_data || 'Unknown'}><span className="rp-score-v">?</span><span className="rp-score-w">unknown</span></span>;
}

const CONFIDENCE_TITLES = {
  high: 'High confidence: the model says this grade rests on primary sources it opened and dated.',
  medium: 'Medium confidence: the model says this grade rests on a mix of primary evidence and secondary sources or project claims.',
  low: 'Low confidence: the model says this grade rests mostly on project claims, inference or thin data.',
};

// The model's stated confidence in one grade: the word carries the meaning,
// the three marks only repeat it.
function Conf({ s }) {
  if (!isScored(s)) return null;
  const c = s.confidence;
  if (!CONFIDENCE_LABELS[c]) return <span className="faint" title="The report states no confidence for this grade">not stated</span>;
  const filled = c === 'high' ? 3 : c === 'medium' ? 2 : 1;
  return (
    <span className={`rp-conf is-${c}`} title={CONFIDENCE_TITLES[c]}>
      <span className="rp-conf-marks" aria-hidden="true">{[1, 2, 3].map((n) => <span key={n} className={n <= filled ? 'on' : undefined} />)}</span>
      {CONFIDENCE_LABELS[c]}
    </span>
  );
}

// The desk's evidence flags on one category grade: a sign and a word, the
// reason in its label. The grade is still shown as the model gave it.
function FlagMark({ list }) {
  if (!list.length) return null;
  const serious = list.some((f) => f.severity === 'high');
  const text = list.map((f) => f.beside || f.message).join(' ');
  return (
    <span className={`rp-flag${serious ? ' is-serious' : ''}`} role="img" title={text} aria-label={`${serious ? 'Serious evidence flag' : 'Evidence flag'}: ${text}`}>
      <TriangleAlert size={12} strokeWidth={2} aria-hidden="true" />
      <span aria-hidden="true">{serious ? 'serious flag' : 'flag'}</span>
    </span>
  );
}

function VerdictChip({ v }) {
  if (!v) return <span className="faint" title="The report did not give one of the six verdict labels">No verdict</span>;
  return <span className="rp-verdict" title="Verdict as written by the report">{verdictWords(v)}</span>;
}

// The grade this app calculates from the report's six weighted scores.
function GradeFigure({ g }) {
  const tier = scoreTier(g.status === 'range' ? g.low : g.value) || 3;
  const title = g.status === 'range' ? `Range from justified component ranges: ${g.low} to ${g.high}` : `Full precision: ${g.value}. Calculated by this app from the six weighted components.`;
  return (
    <p className="rp-grade" title={title}>
      <span className="rp-grade-num">{g.display}</span>
      {g.label ? <span className={`rp-gtag tier-${tier}`}>{g.label}</span> : null}
      {g.status === 'range' ? <span className="faint">range</span> : null}
    </p>
  );
}

// The weighted parts a withheld grade is missing, each with the model's own note.
function Unscored({ reason, max = 400 }) {
  if (!reason || !reason.items.length) return null;
  return (
    <ul className="l2-list rp-unscored">
      {reason.items.map((x) => (
        <li key={x.label}>
          <strong>{x.label}</strong>{` · ${x.status}`}
          {x.note ? <span className="muted">{`: “${x.note.length > max ? `${x.note.slice(0, max - 1)}…` : x.note}”`}</span> : null}
        </li>
      ))}
    </ul>
  );
}

// The report's structure checks (core/consistency.js) as short notes.
function StructureNotes({ st, max = 3 }) {
  if (!st || !st.flagged || !Array.isArray(st.flags) || !st.flags.length) return null;
  return (
    <ul className="l2-list rp-structure">
      {st.flags.slice(0, max).map((f) => <li key={f.message}>{f.message}</li>)}
      {st.flags.length > max ? <li className="muted">{`${st.flags.length - max} more on the report's scorecard`}</li> : null}
    </ul>
  );
}

// ---- the summary's blocks, in reading order -------------------------------------------------

function Facts({ list, max = 5 }) {
  const items = (Array.isArray(list) ? list : []).filter((f) => f && f.text).slice(0, max);
  if (!items.length) return <p className="faint">None given.</p>;
  return <ul className="l2-list">{items.map((f, i) => <li key={i}>{str(f.text)}</li>)}</ul>;
}

// The category grades at a glance: every grade with its confidence and any
// evidence flag on it, and the counts. Never a total.
function CategoryGlance({ rows, href, pid, flags }) {
  const c = scorecardCounts(rows);
  const line = confidenceLine(c);
  const conf = statesConfidence(rows);
  const shown = rows.filter((r) => !(r.def && r.def.applicable === false));
  const flagged = shown.filter((r) => categoryFlags(flags, r.id).length);
  return (
    <div className="rp-block" id="rsec-scores">
      <h3 tabIndex={-1} data-key="rsec-scores-head">{`Category grades: ${c.scored} of ${c.total} scored`}</h3>
      <ul className={`rp-cats${conf ? '' : ' no-conf'}`} aria-label="Category grades of this report">
        {shown.map((r) => (
          <li key={r.id}>
            <span className="rp-cat-name" title={r.def ? r.def.definition : undefined}>{r.label}<FlagMark list={categoryFlags(flags, r.id)} /></span>
            <Score s={r.score} />
            {conf ? <span className="rp-cat-conf"><Conf s={r.score} /></span> : null}
          </li>
        ))}
      </ul>
      {flagged.length ? <p>{`Evidence flags on ${flagged.map((r) => r.label).join(', ')}: the grade is shown as the model gave it; the scorecard says why it is flagged.`}</p> : null}
      {line ? <p className="muted">{line}</p> : null}
      {c.unknown ? <p className="muted">{`Unknown, with no number: ${c.unknownLabels.join(', ')}.`}</p> : null}
      <p>
        <PageLink pid={pid} href={href} data-key="glance-scorecard">
          {rows.some((r) => hasDetail(r.score)) ? 'Open the scorecard: the evidence, the main weakness and what would change each grade' : 'Open the scorecard: the reason behind each grade'}
        </PageLink>
      </p>
    </div>
  );
}

function PositivesAndRisks({ a }) {
  const pos = a.bullish_facts || [];
  const neg = a.bearish_facts || [];
  if (!pos.length && !neg.length) return null;
  return (
    <div className="rp-block rp-two">
      <div><h3>Strongest positives</h3><Facts list={pos} /></div>
      <div><h3>Strongest risks</h3><Facts list={neg} /></div>
    </div>
  );
}

// The chart and cycle reading in brief: the phase, a competing reading, the
// two trends, and the data it was read from.
function ChartCycle({ a }) {
  const cc = a.chart_cycle;
  if (!cc) return null;
  const dd = cc.data || {};
  const tf = Array.isArray(dd.timeframes) ? dd.timeframes.map(str).filter(Boolean) : [];
  const dataLine = [dd.source, dd.venue, dd.pair, tf.length ? tf.join(', ') : null, dd.latest_observation_at ? `latest observation ${dd.latest_observation_at}` : null].filter(Boolean).map(str).join(' · ');
  const rows = [['Trend against USD', cc.trend_vs_usd], ['Trend against BTC', cc.trend_vs_btc]].filter(([, v]) => v);
  return (
    <div className="rp-block">
      <h3>Chart and cycle (the model's reading)</h3>
      <p>
        <span className="rp-chip">{PHASE_LABELS[cc.phase] || 'Unknown'}</span>
        {cc.phase_raw ? <span className="faint">{` written as "${str(cc.phase_raw)}"`}</span> : null}
        {cc.phase_rationale ? <span>{` ${str(cc.phase_rationale)}`}</span> : cc.phase === 'unknown' ? <span className="muted"> The report does not single out a phase.</span> : null}
      </p>
      {cc.alternative_reading ? <p><strong>Competing reading: </strong>{str(cc.alternative_reading)}</p> : null}
      {rows.length ? <dl className="rp-dl">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{str(v)}</dd></div>)}</dl> : null}
      <p className="faint">{dataLine ? `Data: ${dataLine}.` : 'No data source is named for this reading.'}{dd.limitations ? ` Limits: ${str(dd.limitations)}` : ''}</p>
    </div>
  );
}

function windowText(w) {
  const a = w.window_start || null;
  const b = w.window_end || null;
  if (a && b && a !== b) return `${fmtDate(a)} – ${fmtDate(b)}`;
  if (a || b) return fmtDate(a || b);
  return 'date unknown';
}

// Dated catalysts, what would confirm the opportunity and what would invalidate it.
function Catalysts({ a }) {
  const pc = a.position_context;
  const windows = pc && Array.isArray(pc.catalyst_windows) && pc.catalyst_windows.length
    ? pc.catalyst_windows
    : (a.catalysts || []).filter((c) => c && c.title).map((c) => ({ title: c.title, window_start: c.window_start || c.date || null, window_end: c.window_end || null, certainty: c.certainty || 'unknown', in_horizon: typeof c.in_horizon === 'boolean' ? c.in_horizon : null }));
  const confirm = a.conviction_increases || [];
  const invalid = a.invalidators || [];
  if (!windows.length && !confirm.length && !invalid.length) return null;
  return (
    <div className="rp-block">
      <h3>Catalysts, confirmation and invalidation</h3>
      {windows.length ? (
        <ul className="l2-list">
          {windows.slice(0, 8).map((w, i) => (
            <li key={i}>
              <strong>{str(w.title)}</strong>
              {` · ${windowText(w)} · ${CERTAINTY_LABELS[w.certainty] || 'certainty unknown'}${w.in_horizon === true ? ' · inside the horizon' : w.in_horizon === false ? ' · outside the horizon' : ''}`}
            </li>
          ))}
        </ul>
      ) : <p className="faint">No dated catalysts given.</p>}
      <div className="rp-two">
        <div><h4>Would confirm it</h4><Facts list={confirm} /></div>
        <div><h4>Would invalidate it</h4><Facts list={invalid} /></div>
      </div>
    </div>
  );
}

const JUDGMENT_QUESTIONS = [
  ['market_misunderstanding', 'What the market is likely misunderstanding'],
  ['overlooked_bull_case', 'Strongest overlooked bull case'],
  ['overlooked_bear_case', 'Strongest overlooked bear case'],
  ['technology_without_token', 'Could the technology succeed while the token performs poorly?'],
  ['within_holding_period', 'What could happen within the holding period'],
  ['advantage_over_btc', 'Advantage over holding BTC for the same period'],
  // cr-research-prompt@6's three tests (absent from earlier reports).
  ['payment_waterfall', 'If the price stops rising, who still pays, and how $1 reaches the holder'],
  ['per_token_cash_flow', 'Holder cash flow per token against supply growth'],
  ['falsifiable_thesis', 'One-sentence falsifiable thesis'],
];

// The model's final judgment, then its own views, each labeled judgment or
// speculation with the test that would disprove it.
function Judgment({ a, rid }) {
  const ij = a.independent_judgment;
  const metric = a.next_metric_to_monitor;
  const longTerm = a.position_context && a.position_context.long_term_note;
  if (!a.final_take && !ij && !(metric && metric.metric) && !longTerm) return null;
  const views = ij ? JUDGMENT_QUESTIONS.map(([key, q]) => ({ key, q, v: ij[key] })).filter((x) => x.v && x.v.view) : [];
  const label = (v) => (v.label === 'judgment' ? 'Judgment' : v.label === 'speculation' ? 'Speculation' : 'Not labeled');
  return (
    <div className="rp-block">
      <h3>Independent final judgment (the model's own)</h3>
      {a.final_take ? <p>{str(a.final_take)}</p> : <p className="faint">No final judgment given.</p>}
      {metric && metric.metric ? (
        <p>
          <strong>The one development to watch: </strong>{str(metric.metric)}{metric.threshold ? ` (${str(metric.threshold)})` : ''}
          {metric.why ? <span className="muted">{` ${str(metric.why)}`}</span> : null}
        </p>
      ) : null}
      {views.length ? (
        <Fold dataKey={`gl-judgment-${rid}`} title={`The model's own views (${views.length})`} note="Judgment and speculation, labeled by the model. Neither is a verified fact.">
          <dl className="rp-views">
            {views.map(({ key, q, v }) => (
              <div key={key}>
                <dt>{q} <span className="rp-chip">{label(v)}</span></dt>
                <dd>
                  {str(v.view)}
                  {v.disconfirming_test ? <span className="rp-sub muted">{`Would be wrong if: ${str(v.disconfirming_test)}`}</span> : null}
                  {refsText(v.supporting_evidence) ? <span className="rp-sub faint">{`Cites: ${refsText(v.supporting_evidence)}`}</span> : null}
                </dd>
              </div>
            ))}
          </dl>
        </Fold>
      ) : null}
      {longTerm ? <p><strong>Longer-term technology potential </strong><span className="faint">(kept apart from this holding-period assessment): </span>{str(longTerm)}</p> : null}
    </div>
  );
}

// The model's suggested review date and what should prompt a review sooner.
function NextReview({ a }) {
  const t = a.position_context && a.position_context.timing;
  if (!t || (!t.next_review_date && !t.review_trigger)) return null;
  return (
    <div className="rp-block">
      <h3>Next review (the model's suggestion)</h3>
      <p>{t.next_review_date ? <strong>{fmtDate(t.next_review_date)}</strong> : <span className="faint">No date given</span>}{t.review_trigger ? ` · sooner if: ${str(t.review_trigger)}` : ''}</p>
    </div>
  );
}

function Lines({ items }) {
  if (!items.length) return <span className="faint">none given</span>;
  return <ul className="l2-plain">{items.map((x, i) => <li key={i}>{x}</li>)}</ul>;
}

// Bear, base and bull: what is observed, what is assumed, what is forecast.
// Probabilities and price ranges are the model's subjective estimates.
function ScenarioCases({ sc, rows }) {
  const pc = sc.probability_check || {};
  const notes = [
    pc.status === 'ok' ? null : pc.message || null,
    sc.target_check && sc.target_check.status !== 'given' && sc.target_check.status !== 'none' ? sc.target_check.message : null,
    sc.btc_relative_definition ? `Return relative to BTC as the report defines it: ${sc.btc_relative_definition}` : 'The report does not define its return relative to BTC.',
  ].filter(Boolean);
  // Reports before cr-research-prompt@5 were not asked which observations a
  // case builds on; the row is shown once any case gives one.
  const observed = rows.some((x) => x.observations.length);
  return (
    <>
      <div className="rp-scns">
        {rows.map((x, i) => (
          <section key={`${x.id}-${i}`} className="rp-scn" aria-label={`${x.label} case`}>
            <h4>{`${x.label} case`}<span className="rp-scn-prob">{x.probability === null ? 'probability not given' : `${x.probability}% (the model's estimate)`}</span></h4>
            <dl className="rp-dl">
              {observed ? <div><dt>Observed today</dt><dd><Lines items={x.observations} /></dd></div> : null}
              <div><dt>Assumed</dt><dd><Lines items={x.assumptions.map(([k, v]) => `${k}: ${v}`)} /></dd></div>
              <div>
                <dt>Forecast</dt>
                <dd>
                  {x.outcome ? <div>{x.outcome}</div> : null}
                  <div>{'Price: '}{x.price || <span className="faint">no range given</span>}</div>
                  <div>{'Against BTC: '}{x.vsBtc || <span className="faint">no range given</span>}</div>
                </dd>
              </div>
              {x.invalidation ? <div><dt>Would invalidate it</dt><dd>{x.invalidation}</dd></div> : null}
            </dl>
          </section>
        ))}
      </div>
      {notes.length ? <ul className="l2-list muted">{notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
    </>
  );
}

const SOURCE_ACCESS = { public: 'Public source', partial: 'Partly public source', none: 'No public source', unknown: 'Source access not stated' };
const DEPLOYED_LINK = { verified: 'Connected to what is deployed', partial: 'Partly connected to what is deployed', not_verified: 'Not connected to what is deployed', not_applicable: 'Nothing deployed to connect to', unknown: 'Connection to what is deployed not stated' };

// Which code the model says it read, at which commit, and whether it could
// connect that code to what is deployed.
function CodeReview({ cr }) {
  const repos = Array.isArray(cr.repositories) ? cr.repositories.filter((r) => r && typeof r === 'object') : [];
  const link = cr.deployed_link || {};
  return (
    <>
      <dl className="rp-dl">
        <div><dt>Source</dt><dd>{SOURCE_ACCESS[cr.source_access] || SOURCE_ACCESS.unknown}</dd></div>
        <div><dt>Deployed product</dt><dd>{DEPLOYED_LINK[link.status] || DEPLOYED_LINK.unknown}{link.note ? <span className="rp-sub muted">{str(link.note)}</span> : null}</dd></div>
        {cr.limitations ? <div><dt>Not inspected</dt><dd>{str(cr.limitations)}</dd></div> : null}
      </dl>
      {repos.length ? (
        <ul className="l2-list">
          {repos.map((r, i) => {
            const url = safeUrl(r.url);
            const web = url && /^https?:/i.test(url) ? url : null;
            const files = Array.isArray(r.files_inspected) ? r.files_inspected.map(str).filter(Boolean) : [];
            return (
              <li key={i}>
                {web ? <ExtLink href={web}>{web.replace(/^https?:\/\//, '')}</ExtLink> : <span>{str(r.url_raw) || 'Repository without a usable link'}</span>}
                {r.role ? ` · ${str(r.role)}` : ''}
                <span className="rp-sub">
                  {r.commit ? <span>{'Read at '}<code className="l2-mono">{str(r.commit)}</code></span> : <span className="faint">No code read here (no commit given)</span>}
                  {files.length ? ` · ${plural(files.length, 'file')}: ${files.slice(0, 6).join(', ')}${files.length > 6 ? ', …' : ''}` : ''}
                </span>
                {r.observations ? <span className="rp-sub muted">{str(r.observations)}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : <p className="faint">No repository listed.</p>}
    </>
  );
}

// One cited source, with what is known about it.
function SourceItem({ s }) {
  const meta = [s.publisher, s.source_type ? String(s.source_type).replace(/_/g, ' ') : null, s.accessed_at ? `accessed ${fmtDate(s.accessed_at)}` : null].filter(Boolean).map(str);
  const url = safeUrl(s.url);
  const web = url && /^https?:/i.test(url) ? url : null;
  return (
    <li>
      {web ? <ExtLink href={web}>{str(s.title) || web}</ExtLink> : <span>{str(s.title) || s.source_id}<span className="faint"> (no usable link)</span></span>}
      {meta.length ? <span className="faint">{` · ${meta.join(' · ')}`}</span> : null}
    </li>
  );
}

// The summary above the original, in reading order. The grade is this app's
// calculation from the report's six weighted scores; everything else is the
// model's own. An older report shows the parts it has.
function Glance({ g, a, r, pid, withheld, rows, scen, risks }) {
  const rid = r.report_id;
  const isPdf = a.needs_text || isPdfFile(r);
  const questions = a.unresolved_questions || [];
  const sources = a.sources || [];
  const flags = (r.evidence && r.evidence.flags) || [];
  let grade;
  if (isPdf) grade = <p className="rp-state">PDF: needs a text copy</p>;
  else if (withheld) {
    grade = (
      <>
        <p className="rp-state">{withheld.short}</p>
        {withheld.coverage !== null ? <p className="muted rp-small">{COVERAGE_MEANS}</p> : null}
        <Unscored reason={withheld} />
        <StructureNotes st={r.structure} />
      </>
    );
  } else if (g && (g.status === 'firm' || g.status === 'range')) grade = <GradeFigure g={g} />;
  else grade = <p className="rp-state">No grade{g && g.reason ? <span className="muted rp-small">{` ${g.reason}`}</span> : null}</p>;
  // The scorecard of the model whose report this is; an earlier report is
  // named, so the Overview draws that one.
  const scorecard = `#/project/${enc(pid)}/brief?model=${r.meta.provider}${r.latest ? '' : `&report=${enc(rid)}`}&open=scorecard`;
  return (
    <section className="l2-panel rp-glance" id="rsec-summary" aria-labelledby="glance-title">
      <header className="l2-panel-head">
        <h2 className="l2-panel-t" id="glance-title" tabIndex={-1} data-key="rsec-summary-head" title="The investment grade is calculated by this app from the report's six weighted scores. Everything else here is the model's own: its verdict, category grades, chart reading, judgment, risks, questions and sources. The report below tags each claim as checked, project-claimed, inference or speculation.">Summary</h2>
      </header>
      <div className="l2-panel-body">
        <div className="rp-two rp-glance-top">
          <div>
            <p className="rp-k">Verdict for the holding period (the model's)</p>
            <p className="rp-v"><VerdictChip v={a.verdict} /></p>
            {a.summary ? <p>{str(a.summary)}</p> : null}
            <KV rows={[['Horizon', a.horizon || 'not stated', null, true]]} />
          </div>
          <div>
            <p className="rp-k">Investment grade (calculated by this app)</p>
            {grade}
          </div>
        </div>
        {rows.length ? <CategoryGlance rows={rows} href={scorecard} pid={pid} flags={flags} /> : null}
        <PositivesAndRisks a={a} />
        <ChartCycle a={a} />
        <Catalysts a={a} />
        <Judgment a={a} rid={rid} />
        <NextReview a={a} />
        <div className="rp-block" id="rsec-risks">
          <h3 tabIndex={-1} data-key="rsec-risks-head">Top downside risks (higher is worse)</h3>
          {risks.length ? (
            <ul className="rp-risks">
              {risks.map((x) => <li key={x.def.id}><span title={x.def.definition || undefined}>{x.def.label}</span><Score s={x.s} risk /></li>)}
            </ul>
          ) : <p className="faint">No downside risk was scored in this report.</p>}
        </div>
        {scen.length ? (
          <div className="rp-block" id="rsec-scenarios">
            <Fold dataKey={`gl-scenarios-${rid}`} title="Scenarios over the horizon: bear, base and bull" note="Probabilities and price ranges are the model's subjective estimates, not verified facts. A value the model could not defend is left unknown; nothing is filled in.">
              <ScenarioCases sc={a.scenarios} rows={scen} />
            </Fold>
          </div>
        ) : null}
        {a.code_review ? (
          <div className="rp-block">
            <Fold dataKey={`gl-code-${rid}`} title="Code that was read" note="The model's own account of what it read. A research assessment, not a security audit, and not checked by this dashboard.">
              <CodeReview cr={a.code_review} />
            </Fold>
          </div>
        ) : null}
        {questions.length ? (
          <div className="rp-block">
            <h3>{`Unresolved questions (${questions.length})`}</h3>
            <ul className="l2-list">{questions.map((q, i) => <li key={i}>{str(q)}</li>)}</ul>
          </div>
        ) : null}
        {sources.length ? (
          <div className="rp-block" id="rsec-sources">
            <Fold dataKey={`src-${rid}`} title={`${plural(sources.length, 'source')} cited`} defaultOpen={sources.length <= 5}>
              <ol className="l2-list rp-sources">{sources.map((s, i) => <SourceItem key={s.source_id || i} s={s} />)}</ol>
            </Fold>
          </div>
        ) : (
          <div className="rp-block" id="rsec-sources" tabIndex={-1} data-key="rsec-sources-head">
            <p className="faint">This report lists no sources.</p>
          </div>
        )}
      </div>
    </section>
  );
}

// ---- the original ------------------------------------------------------------------------

// The formatted report: md.js builds it with textContent only (no HTML from
// the report is ever read), mounted here as it is.
function Markdown({ text }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.replaceChildren(renderMarkdown(text));
  }, [text]);
  return <div ref={ref} className="rp-md" />;
}

// Until the original's text arrives the reader holds its place with a
// fixed-height placeholder, said to a screen reader.
function ReaderWaiting() {
  return (
    <div className="rp-wait" role="status">
      <span className="sr-only">Loading the report text</span>
      {['w80', '', 'w60', '', 'w80', 'w40', '', 'w60'].map((w, i) => <span key={i} className={`skel${w ? ` ${w}` : ''}`} aria-hidden="true" />)}
    </div>
  );
}

// Exact text or formatted, per report, for the page's life.
const rawChoice = new Map();

function Reader({ pid, r }) {
  const rid = r.report_id;
  const isPdf = isPdfFile(r);
  const path = `/api/projects/${enc(pid)}/reports/${enc(rid)}/original`;
  const { text, error } = useLazyText(path, !isPdf);
  const [raw, setRaw] = useState(() => Boolean(rawChoice.get(rid)));
  const [downloading, setDownloading] = useState(false);
  const parts = useMemo(() => (typeof text === 'string' ? splitDataBlock(text) : null), [text]);
  const download = async () => {
    setDownloading(true);
    try {
      await api.download(path, `${rid}-${r.meta.original_file}`);
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setDownloading(false);
    }
  };
  const dl = (
    <button type="button" className="btn btn-sm" data-key={`dl-${rid}`} disabled={downloading} aria-busy={downloading || undefined} onClick={download}>
      <Download size={13} aria-hidden="true" />{downloading ? 'Downloading…' : 'Download original'}
    </button>
  );
  const toggle = isPdf ? null : (
    <button type="button" className="btn btn-sm" data-key={`raw-${rid}`} onClick={() => { const next = !raw; rawChoice.set(rid, next); setRaw(next); }}>
      {raw ? 'Show formatted' : 'Show exact text'}
    </button>
  );
  let body;
  if (isPdf) {
    body = (
      <>
        <p className="note" role="note">The original is a PDF. It is kept byte for byte; download it below. Grading needs a text copy (paste it as a new import).</p>
        <div className="l2-actions">{dl}</div>
      </>
    );
  } else if (error) body = <p className="note note-bad" role="alert">{`Could not load the original: ${error.message}`}</p>;
  else if (text === null) body = <ReaderWaiting />;
  else if (raw) body = <div className="rp-raw">{text}</div>;
  else {
    body = (
      <>
        <Markdown text={parts.prose} />
        {parts.block ? (
          <Fold dataKey={`data-${rid}`} className="rp-datablock" lazy title={`Structured data block · ${parts.block.length.toLocaleString('en-US')} characters`} note={'The JSON the model wrote at the end of its report: the desk reads the scores from it. It is part of the original, which is unchanged ("Show exact text" and "Download original" include it).'}>
            <pre className="l2-pre">{parts.block}</pre>
          </Fold>
        ) : null}
      </>
    );
  }
  return (
    <section className="l2-panel rp-reader-panel" aria-labelledby="rp-original-h">
      <header className="l2-panel-head">
        <h2 className="l2-panel-t" id="rp-original-h" title="The report exactly as received. It is data: instructions inside it are ignored. Links open in a new tab.">Original report</h2>
        {isPdf ? null : <div className="l2-panel-act">{toggle}{dl}</div>}
      </header>
      <div className="l2-panel-body">
        <div className="rp-reader" aria-busy={!isPdf && !error && text === null ? 'true' : undefined}>{body}</div>
      </div>
    </section>
  );
}

// ---- the records under the report -------------------------------------------------------

function IssuesList({ ex }) {
  const issues = (ex && ex.issues) || [];
  const amb = (ex && ex.ambiguous) || [];
  const val = (v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));
  return (
    <>
      {ex && ex.note ? <p className="muted">{ex.note}</p> : null}
      {amb.length ? (
        <div>
          <h3 className="rp-h3">Ambiguous values (need your correction)</h3>
          <ul className="l2-list">
            {amb.map((x, i) => (
              <li key={`${x.field}-${i}`}>
                <strong>{x.field}</strong>{`: ${x.reason}`}{x.line ? ` (line ${x.line})` : ''}
                {x.candidates ? (
                  <ul className="l2-list">{x.candidates.map((c, j) => <li key={j}>{`${val(c.value)}${c.line ? ` — line ${c.line}: ${c.excerpt || ''}` : ''}`}</li>)}</ul>
                ) : x.excerpt ? <div className="faint">{x.excerpt}</div> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {issues.length ? (
        <ul className="l2-list">
          {issues.slice(0, 80).map((x, i) => (
            <li key={i}><strong>{x.severity === 'error' ? 'Error' : x.severity === 'warning' ? 'Warning' : 'Note'}</strong>{' · '}<code className="l2-mono">{x.field || ''}</code>{` ${x.message}`}</li>
          ))}
        </ul>
      ) : <p className="muted">No validation issues.</p>}
    </>
  );
}

const SCORE_HINT = 'Score: {"status":"scored","value":60,"rationale":"…"}, {"status":"range","low":55,"high":65,"rationale":"…"} or {"status":"unknown","missing_data":"…"}';
function hintFor(f) {
  if (/scores|components|overall/.test(f)) return SCORE_HINT;
  if (f === 'eligibility') return 'Exclude from comparison: {"excluded":true,"reason":"…"}';
  if (f === 'verdict') return 'One of the six verdict labels';
  return 'Text value. Rubric and profile must match exactly for reports to be compared.';
}

// Add a correction: a separate dated file; the original and its first
// extraction never change. The value is read as JSON when it parses (a score,
// the eligibility), else as text; empty is null.
function CorrectionForm({ pid, r }) {
  const rid = r.report_id;
  const a = r.assessment || {};
  const fields = [
    'analysis_at', 'horizon', 'rubric_version', 'sector_profile', 'verdict', 'model_version', 'eligibility', 'model_reported_overall_score',
    ...Object.keys(a.diagnostic_scores || {}).map((k) => `diagnostic_scores.${k}`),
    ...Object.keys(a.investment_components || {}).map((k) => `investment_components.${k}`),
    ...Object.keys(a.risk_scores || {}).map((k) => `risk_scores.${k}`),
  ];
  const [field, setField] = useState(fields[0]);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const reasonRef = useRef(null);
  const hint = hintFor(field);
  const ids = { field: `corr-f-${rid}`, value: `corr-v-${rid}`, hint: `corr-h-${rid}`, reason: `corr-r-${rid}`, err: `corr-e-${rid}` };
  const save = async () => {
    if (!reason.trim()) {
      setErr('Give a reason; corrections keep an audit trail.');
      if (reasonRef.current) reasonRef.current.focus();
      return;
    }
    setErr(null);
    let v = value.trim();
    try { v = JSON.parse(v); } catch (_) { /* plain text */ }
    if (v === '') v = null;
    setBusy(true);
    try {
      await api.post(`/api/projects/${enc(pid)}/reports/${enc(rid)}/corrections`, { field, value: v, reason });
      toast('Correction saved as a separate file. The original report is unchanged.');
      setValue('');
      setReason('');
      await refresh();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="l2-form rp-corr-form" data-key={`correct-${rid}`} noValidate onSubmit={(e) => { e.preventDefault(); if (!busy) save(); }}>
      <div className="l2-row">
        <label htmlFor={ids.field}>
          Field
          <select id={ids.field} className="input" name="correction-field" value={field} onChange={(e) => setField(e.target.value)}>
            {fields.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
        <label htmlFor={ids.value}>
          New value
          <input id={ids.value} className="input" name="correction-value" type="text" value={value} title={hint} aria-describedby={ids.hint} placeholder={'e.g. 2026-09-30, or {"status":"scored","value":60,"rationale":"…"}'} onChange={(e) => setValue(e.target.value)} />
          <span className="sr-only" id={ids.hint}>{hint}</span>
        </label>
      </div>
      <label htmlFor={ids.reason}>
        Reason
        <input id={ids.reason} ref={reasonRef} className="input" name="correction-reason" type="text" value={reason} placeholder="Why (required)" aria-invalid={err ? 'true' : undefined} aria-describedby={err ? ids.err : undefined} onChange={(e) => { setReason(e.target.value); if (err) setErr(null); }} />
        {err ? <span className="l2-err" id={ids.err} role="alert">{err}</span> : null}
      </label>
      <div className="l2-actions">
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy} aria-busy={busy || undefined}>{busy ? 'Saving…' : 'Save correction'}</button>
      </div>
    </form>
  );
}

function Records({ pid, r, errors, amb }) {
  const rid = r.report_id;
  const a = r.assessment || {};
  const meta = r.meta || {};
  const pv = r.provenance || {};
  const corrections = r.corrections || [];
  const claims = Array.isArray(a.claims) ? a.claims.length : 0;
  const recordPath = `/api/projects/${enc(pid)}/reports/${enc(rid)}/record`;
  const [downloading, setDownloading] = useState(false);
  const json = (v) => (v === undefined ? '—' : JSON.stringify(v));
  return (
    <section className="l2-panel rp-records" aria-labelledby={`rp-records-h-${rid}`}>
      <h2 className="sr-only" id={`rp-records-h-${rid}`}>The report's records</h2>
      <div className="l2-panel-body">
        <Fold dataKey={`corr-${rid}`} title={`Corrections (${corrections.length})`} defaultOpen={corrections.length > 0}>
          {corrections.length ? (
            <div className="l2-table-wrap">
              <table className="l2-table">
                <thead><tr><th scope="col">When</th><th scope="col">Field</th><th scope="col">Original (as written)</th><th scope="col">Your correction</th><th scope="col">Reason</th></tr></thead>
                <tbody>
                  {corrections.map((c, i) => (
                    <tr key={c.correction_id || i}>
                      <td className="nowrap">{fmtDateTime(c.created_at)}</td>
                      <td><code className="l2-mono">{c.field}</code></td>
                      <td><code className="l2-mono">{json(c.previous_value)}</code></td>
                      <td><code className="l2-mono">{json(c.new_value)}</code></td>
                      <td>{c.reason || <span className="faint">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="muted">No corrections. The original and its first extraction never change; corrections are separate dated files.</p>}
          <h3 className="rp-h3">Add a correction</h3>
          <CorrectionForm pid={pid} r={r} />
        </Fold>
        <Fold dataKey={`claims-${rid}`} title={`Claims and evidence (${claims})`}>
          <p>
            {claims ? `${plural(claims, 'structured claim')} in this report. ` : 'This report lists no structured claims. '}
            <PageLink pid={pid} href={`#/project/${enc(pid)}/evidence?model=${meta.provider}&report=${enc(rid)}&open=claims`} data-key={`claims-open-${rid}`}>Open the claims on the Evidence tab</PageLink>
          </p>
        </Fold>
        <Fold dataKey={`json-${rid}`} title="Normalized data (JSON)" note="The first extraction, as saved. Corrections are separate files and never edit this record." lazy>
          <div className="l2-actions">
            <button
              type="button"
              className="btn btn-sm"
              data-key={`json-dl-${rid}`}
              disabled={downloading}
              aria-busy={downloading || undefined}
              onClick={async () => {
                setDownloading(true);
                try {
                  await api.download(recordPath, `${rid}-report.json`);
                } catch (err) {
                  toast(err.message, 'bad');
                } finally {
                  setDownloading(false);
                }
              }}
            >
              <Download size={13} aria-hidden="true" />{downloading ? 'Downloading…' : 'Download JSON'}
            </button>
          </div>
          <LazyPre path={recordPath} loading="Loading the extracted record…" failed="The extracted record could not be loaded" keepScroll={`json-${rid}`} />
        </Fold>
        <Fold dataKey={`notes-${rid}`} title={`Extraction notes${errors || amb ? ` (${errors + amb})` : ''}`} defaultOpen={errors > 0 || amb > 0}>
          <IssuesList ex={r.extraction} />
        </Fold>
        <Fold dataKey={`file-${rid}`} title="File and provenance">
          <KV
            rows={[
              ['Original file', meta.original_filename || meta.original_file || 'Not recorded'],
              ['Stored at', meta.original_file ? <code className="l2-hash">{`projects/${pid}/reports/${rid}/${meta.original_file}`}</code> : 'Not recorded', null, true],
              ['SHA-256', meta.original_sha256 ? <code className="l2-hash">{meta.original_sha256}</code> : 'Not recorded', null, true],
              ['Imported', `${fmtDateTime(meta.imported_at)}${meta.imported_by ? ` by ${meta.imported_by}` : ''}`],
              ['Arrived via', `${pv.channel || meta.provider_source || '?'}${pv.declared_provider && pv.declared_provider !== meta.provider ? ` · the report says it is from ${pv.declared_provider}` : ''}`],
              ['Research run', pv.research_run_id || 'not part of a run'],
              ['Prompt · rubric · profile', `${a.prompt_version || '?'} · ${a.rubric_version || '?'} · ${a.sector_profile || '?'}`],
              ['Project matched by', meta.project_resolution || null],
            ]}
          />
        </Fold>
      </div>
    </section>
  );
}

// ---- the head ------------------------------------------------------------------------------

// A revision in one sentence: its basis, what changed, the model's reason.
function revisionText(rv) {
  const added = rv.sources && typeof rv.sources.added === 'number' ? rv.sources.added : 0;
  const head = rv.basis === 'existing_evidence' ? 'Revision using existing evidence (no source added)'
    : rv.basis === 'new_sources' ? `Revision with ${plural(added, 'new source')}`
      : 'Re-saved with the same scores';
  const parts = (rv.changed_components || []).map((c) => `${String(c.id).replace(/_/g, ' ')} ${c.from} → ${c.to}`);
  const what = parts.length ? parts.join('; ') : rv.changed_categories ? `${plural(rv.changed_categories, 'category grade')} changed` : 'no weighted part changed';
  return `${head}, ${rv.minutes_after} min after ${rv.of}: ${what}. ${rv.declared && rv.declared.note ? `The model's reason: ${rv.declared.note}` : 'No reason was recorded with this save.'}`;
}

function Head({ d, r, pid, withheld, st, errors, amb }) {
  const a = r.assessment || {};
  const pv = r.provenance || {};
  const P = PROVIDER_LABELS[r.meta.provider] || r.meta.provider;
  const g = r.grade;
  const rv = r.revision && r.revision.kind === 'revision' ? r.revision : null;
  // The desk's own sentence for a revision, with the components' names and
  // any narrowing, when the record carries it (core/revisions.js).
  const hist = rv && d.history && Array.isArray(d.history[r.meta.provider]) ? d.history[r.meta.provider].find((x) => x.report_id === r.report_id) : null;
  const timing = r.analysis_timing && ['after_save', 'future'].includes(r.analysis_timing.status) ? r.analysis_timing : null;
  const ts = r.text_scores && Array.isArray(r.text_scores.mismatches) && r.text_scores.mismatches.length ? r.text_scores : null;
  const status = st.word === 'latest' ? 'Latest eligible report' : st.word === 'earlier' ? 'Earlier report' : st.word === 'Quarantined' ? 'Quarantined: excluded from comparison' : 'Excluded from comparison';
  return (
    <header className="l2-panel rp-head">
      <div className="l2-panel-body">
        <h2 id="report-title" tabIndex={-1}>{`${P} report · ${dateOr(a.analysis_at, 'undated')}`}</h2>
        <p className="rp-meta">
          <span>{g && g.display ? `Grade ${g.display} ${g.label || ''}`.trim() : withheld ? withheld.short : 'No grade'}</span>
          <VerdictChip v={a.verdict} />
          <span>{`Horizon ${a.horizon || 'not stated'}`}</span>
          <span>{`${a.model_version || 'model not stated'}, ${pv.attested ? 'attested by the API' : 'self-reported'}`}</span>
          <span title={st.reason || undefined}>{status}</span>
        </p>
        {withheld ? <p className="rp-line">{withheld.sentence}</p> : null}
        {rv ? (
          <p className="rp-line">
            {(hist && hist.revision_label) || revisionText(rv)}{' '}
            <PageLink pid={pid} href={`#/project/${enc(pid)}/report?report=${enc(rv.of)}&model=${r.meta.provider}`} data-key={`rev-of-${r.report_id}`}>Open the earlier report</PageLink>
          </p>
        ) : null}
        {timing ? <p className="rp-line">{`The report states an analysis time ${timing.minutes_after_save !== null && timing.minutes_after_save < 2880 ? `${timing.minutes_after_save} min` : 'more than a day'} after it was saved (${fmtDateTime(r.meta.imported_at)}); shown as written, ordered by its save time.`}</p> : null}
        {ts ? <p className="rp-line is-problem"><TriangleAlert size={14} strokeWidth={2} aria-hidden="true" /><span>{ts.summary}</span></p> : null}
        {errors || amb ? (
          <p className="note note-warn" role="note">
            <TriangleAlert className="note-ico" size={15} aria-hidden="true" />
            <span>
              {[errors ? plural(errors, 'extraction error') : null, amb ? plural(amb, 'ambiguous value') : null].filter(Boolean).join(' and ')}
              {': see '}
              <button type="button" className="btn-link" data-key={`notes-jump-${r.report_id}`} onClick={() => openFold(`notes-${r.report_id}`)}>Extraction notes</button>
              {' below.'}
            </span>
          </p>
        ) : null}
      </div>
    </header>
  );
}

// ---- the list ------------------------------------------------------------------------------

function ReportList({ pid, good, sel, latestIds }) {
  return (
    <nav className="report-list" aria-label="Reports">
      {PROVIDERS.filter((p) => good.some((r) => r.meta.provider === p)).map((p) => (
        <div key={p} className="rl-group">
          <p className="group-label" id={`rl-g-${p}`}>{PROVIDER_LABELS[p]}</p>
          <ul aria-labelledby={`rl-g-${p}`}>
            {good.filter((r) => r.meta.provider === p).map((r) => {
              const g = r.grade;
              const a = r.assessment || {};
              const st = standing(r, latestIds);
              const rev = r.revision && r.revision.kind === 'revision'
                ? (r.revision.basis === 'existing_evidence' ? 'revision, same evidence' : r.revision.basis === 'new_sources' ? 'revision, new sources' : 're-saved')
                : null;
              const n = (r.corrections || []).length;
              const gradeWords = g && g.display ? `${g.display} ${g.label || ''}`.trim() : g && g.status === 'withheld' ? withheldLabel(g.coverage_pct) : isPdfFile(r) ? 'PDF' : 'No grade';
              return (
                <li key={r.report_id}>
                  <PageLink pid={pid} href={reportHref(pid, r)} aria-current={sel && r.report_id === sel.report_id ? 'true' : undefined} data-key={`rl-${r.report_id}`} title={st.reason ? `${st.word}: ${st.reason}` : undefined} className={st.word === 'Excluded' || st.word === 'Quarantined' ? 'is-out' : undefined}>
                    <span className="line1"><span>{dateOr(a.analysis_at, 'Undated')}</span><span className="num">{gradeWords}</span></span>
                    <span className="line2">{[verdictWords(a.verdict) || 'No verdict', st.word, rev, n ? plural(n, 'correction') : null].filter(Boolean).join(' · ')}</span>
                  </PageLink>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

// ---- the contents ----------------------------------------------------------------------------

// The part in view: the last one whose top has reached the line under the
// bar where a jump lands (the summary holds the others, so "intersecting"
// alone would always name it); at the end of the page, the last part.
function useCurrentPart(ids) {
  const key = ids.join(',');
  const [on, setOn] = useState(ids[0] || null);
  useEffect(() => {
    if (!ids.length) return undefined;
    let frame = 0;
    const mark = () => {
      frame = 0;
      const line = (parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0) + 12;
      let cur = ids[0];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= line) cur = id;
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) cur = ids[ids.length - 1];
      setOn((p) => (p === cur ? p : cur));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(mark); };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    mark();
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [key]);
  return on;
}

// A part of the report: its own fold (the scenarios, a long source list)
// opens first; the part comes into view with focus on its heading.
function goToPart(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const fold = el.querySelector(':scope > details');
  if (fold && !fold.open) fold.open = true;
  el.scrollIntoView({ block: 'start' });
  const head = el.querySelector('h2, h3, summary') || el;
  head.focus({ preventScroll: true });
}

// One button per part the report has, in its order (buttons, not links: an
// address here would be read as a route).
function Contents({ parts }) {
  const on = useCurrentPart(parts.map(([id]) => id));
  if (!parts.length) return null;
  return (
    <nav className="report-toc" aria-label="Report contents">
      <p className="toc-title" aria-hidden="true">Contents</p>
      <ul>
        {parts.map(([id, label]) => (
          <li key={id}>
            <button type="button" className="toc-item" data-key={`toc-${id}`} data-target={id} aria-current={on === id ? 'location' : undefined} onClick={() => goToPart(id)}>{label}</button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// ---- the section -----------------------------------------------------------------------------

function ReportMain({ d, r, pid, rubrics, latestIds }) {
  const a = r.assessment || {};
  const ex = r.extraction || {};
  const errors = (ex.issues || []).filter((i) => i.severity === 'error').length;
  const amb = (ex.ambiguous || []).length;
  const st = standing(r, latestIds);
  const withheld = r.grade && r.grade.status === 'withheld' ? withheldReason(r.meta.provider, r.grade, unscoredFrom(r.grade, a.investment_components)) : null;
  // The category grades of the profile this report declares; none for a
  // report that scored no category at all (a PDF, a short prose report).
  const rows = Object.keys(a.diagnostic_scores || {}).length ? categoryRows(profileOf(rubrics.profiles, a, d.profile), a) : [];
  const scen = scenarioRows(a.scenarios);
  const top = (s) => (s.status === 'range' ? s.high : s.value);
  const risks = ((rubrics.grading && rubrics.grading.risk_scores) || [])
    .map((def) => ({ def, s: (a.risk_scores || {})[def.id] }))
    .filter((x) => x.s && (x.s.status === 'scored' || x.s.status === 'range'))
    .sort((x, y) => top(y.s) - top(x.s))
    .slice(0, 4);
  const parts = [['rsec-summary', 'Summary'], rows.length ? ['rsec-scores', 'Scores'] : null, ['rsec-risks', 'Risks'], scen.length ? ['rsec-scenarios', 'Scenarios'] : null, ['rsec-sources', 'Sources']].filter(Boolean);
  const rr = { ...r, latest: latestIds.has(r.report_id) };
  return (
    <>
      <article className="report-main" aria-labelledby="report-title">
        <Head d={d} r={r} pid={pid} withheld={withheld} st={st} errors={errors} amb={amb} />
        <Glance g={r.grade} a={a} r={rr} pid={pid} withheld={withheld} rows={rows} scen={scen} risks={risks} />
        <Reader pid={pid} r={r} />
        <Records pid={pid} r={r} errors={errors} amb={amb} />
      </article>
      <Contents parts={parts} />
    </>
  );
}

export default function Report({ d, row, pid, prov, reportId, route }) {
  const dk = useDesk();
  const rubrics = (dk.index && dk.index.rubrics) || {};
  const reports = (d && d.reports) || [];
  if (!reports.length) return <p className="note rp-empty">No reports imported yet. Older analyses stay here as dated records once they exist.</p>;
  const good = reports.filter((r) => !r.broken);
  const broken = reports.filter((r) => r.broken);
  const latest = (d.comparison && d.comparison.latest) || {};
  const latestIds = new Set(PROVIDERS.map((p) => (latest[p] ? latest[p].report_id : null)).filter(Boolean));
  const latestOf = (p) => (latest[p] ? good.find((r) => r.report_id === latest[p].report_id) || null : null);
  const newestOf = (p) => good.find((r) => r.meta.provider === p) || null;
  const query = route && route.query ? route.query : new URLSearchParams();
  const namedModel = PROVIDERS.includes(query.get('model'));
  // The report the address names; else the chosen model's latest eligible
  // report, else its newest (an excluded or quarantined one, said so). A
  // model named in the address with no report of its own is said, and no
  // other model's report is opened in its place (review 2026-10-08, F4); a
  // bare address opens a latest report.
  const named = reportId ? good.find((r) => r.report_id === reportId) || null : null;
  let sel = named || latestOf(prov) || newestOf(prov);
  if (!sel && !namedModel) sel = PROVIDERS.map(latestOf).find(Boolean) || good[0] || null;
  const missing = reportId && !named ? reportId : null;
  return (
    <div className="rp">
      {broken.map((r) => <p key={r.report_id} className="note note-bad" role="alert">{`${r.report_id}: ${r.error}`}</p>)}
      {missing ? <p className="note note-warn" role="note">{`The report ${missing} is not among this project's readable reports.`}</p> : null}
      <div className={`rp-layout${sel ? ' has-report' : ''}`}>
        <ReportList pid={pid} good={good} sel={sel} latestIds={latestIds} />
        {sel ? (
          <ReportMain key={sel.report_id} d={d} r={sel} pid={pid} rubrics={rubrics} latestIds={latestIds} />
        ) : (
          <div className="report-main">
            <p className="note">{`No ${PROVIDER_LABELS[prov] || prov} report on this project yet. Pick another model's report from the list.`}</p>
          </div>
        )}
      </div>
    </div>
  );
}
