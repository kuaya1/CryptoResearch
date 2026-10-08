// The selected model's panel in the inspector, in reading order: its verdict
// (the investment grade as the desk calculated it, or why there is none; the
// verdict, analysis date and horizon; the grade's warnings as chips), then at
// once the strongest sourced risk and what would confirm and break it (review
// 2026-10-08, F7), then the six weighted components, the revision, what a
// withheld grade is missing, the project's review items, the take, what to
// watch and your note, the 13 diagnostic category grades and the rest of its
// risks.
//
// Every part drawn from the report comes from one report: the one the list's
// summary names, found in the project record with the same grade, verdict
// and date (lib/opinion.js). While the record does not hold it (loading, kept
// from before a change), those parts say so instead of showing another
// report's words; the grade, verdict and "Open report" stay the summary's
// own, the same report (review 2026-10-08, F1). Every model keeps its own
// numbers; unknown stays unknown and is never drawn as zero; nothing missing
// is filled in.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUpRight, RotateCcw, TriangleAlert, Copy } from 'lucide-react';
import {
  PROVIDER_LABELS, fmtDate, fmtDateTime, fmtRelDay, anchorText, withheldReason, researchState, jobKey, onHoldOf,
  copyText, toast, TAG_TITLES, COVERAGE_MEANS, evidenceLevel, evidenceText,
} from '../../../../public/ui.js';
import { splitAttention, kindWord, attentionHref } from '../../../../public/watchlist-model.js';
import { keyPoints, TAG_WORDS } from '../../../../public/brief-model.js';
import { profileOf, categoryRows, scorecardCounts, statesConfidence, categoryFlags, CONFIDENCE_LABELS } from '../../../../public/thesis-ui.js';
import { api, refresh, hosted, resyncOnce, wasResynced } from '../../lib/desk.js';
import { opinionOf } from '../../lib/opinion.js';
import { legacyCtx } from '../../legacy/ctx.js';
import { ScoreBar } from '../../components/ScoreBar.jsx';
import { MetricHeader } from '../../components/MetricHeader.jsx';
import { DiagnosticSegmentBar } from '../../components/ui/DiagnosticSegmentBar.jsx';
import { Dom, loadLegacy } from '../../components/Dom.jsx';
import { pillInfo } from '../../components/GradePill.jsx';
import { badgeOpts } from '../watchlist/ProjectTable.jsx';

const isScored = (s) => Boolean(s) && (s.status === 'scored' || s.status === 'range');
const scoreText = (s) => (s.status === 'range' ? `${s.low}–${s.high}` : String(s.value));
const scoreWords = (s) => (s.status === 'range' ? `${s.low} to ${s.high} out of 100 (a range)` : `${s.value} out of 100`);
const CONF_LETTER = { high: 'H', medium: 'M', low: 'L' };

// Short names for a narrow row; the full name is the row's title and label.
const SHORT = {
  legitimacy: 'Legitimacy', development_credibility: 'Development', build_operational_quality: 'Build quality', code_quality: 'Code quality',
  product_reality: 'Live product', technology_usefulness: 'Technology', organic_demand: 'Organic demand', token_value_capture: 'Value capture',
  valuation_supply_attractiveness: 'Valuation & supply', chart_structure: 'Chart', cycle_timing: 'Cycle & catalysts', volume_liquidity: 'Volume & liquidity',
  btc_relative_opportunity: 'Against BTC', builder_operations: 'Builders & ops', product_usefulness: 'Product use', credit_risk_transparency: 'Credit-risk clarity',
  protocol_risk_transparency: 'Protocol-risk clarity', technical_risk_transparency: 'Tech-risk clarity', differentiation: 'Differentiation',
  category_potential: 'Category potential', chart_quality: 'Chart quality', evidence_confidence: 'Evidence confidence',
};

// The report the panel's report-derived parts are drawn from, or null.
const fullOf = (op) => (op.status === 'ok' && op.report && !op.report.broken ? op.report : null);

// ---- the verdict ---------------------------------------------------------------------

const RESUME_WHERE = { claude: 'In Cowork (or a Claude chat with the CryptoResearch connector)', chatgpt: 'In a ChatGPT chat with the CryptoResearch app turned on' };
const RESUME_OPEN = { claude: 'https://claude.ai/new', chatgpt: 'https://chatgpt.com/' };

function Resume({ d, p, prov, job, info }) {
  if (!job || !RESUME_WHERE[prov] || onHoldOf(d.index, prov)) return null;
  const stalled = info.kind === 'interrupted' || info.job === 'interrupted';
  const released = job.state === 'unconfigured' && (job.released || job.draft_saved_at);
  if (!stalled && !released) return null;
  const sentence = `Resume my CryptoResearch research on ${p.name}`;
  const since = job.progress_at || job.draft_saved_at || job.updated_at;
  return (
    <div className="mp-resume">
      <button
        type="button"
        className="btn btn-sm"
        data-key={`resume-${p.project_id}-${prov}`}
        aria-label={`Resume ${PROVIDER_LABELS[prov]}'s research: copy the sentence and open ${PROVIDER_LABELS[prov]}`}
        onClick={async () => {
          try { await copyText(sentence); } catch (_) { /* said below */ }
          if (hosted()) window.open(RESUME_OPEN[prov], '_blank', 'noopener');
          toast(`Copied: “${sentence}”. ${RESUME_WHERE[prov]}, paste it. This job shows Working again only when ${PROVIDER_LABELS[prov]} saves a draft or its report.`);
        }}
      >
        <Copy size={13} aria-hidden="true" />Resume
      </button>
      <span className="faint">{`${released ? 'Released back to waiting' : 'Paused'}${since ? ` · last activity ${fmtDateTime(since)}` : ''}${job.draft_saved_at ? ` · draft saved ${fmtDateTime(job.draft_saved_at)}` : ' · no draft saved'}`}</span>
    </div>
  );
}

function Actions({ d, p, prov, job, info, opts, rep, resume }) {
  const pid = p.project_id;
  const [busy, setBusy] = useState(false);
  const who = PROVIDER_LABELS[prov];
  const out = [];
  // A model on hold gets nothing new: no retry (the server refuses one too).
  if (job && job.state === 'failed' && !opts.onHold) {
    out.push(
      <button key="retry" type="button" className="btn btn-sm" data-key={`retry-${pid}-${prov}`} disabled={busy} onClick={async () => {
        setBusy(true);
        try {
          const r = await api.post(`/api/projects/${encodeURIComponent(pid)}/research/${encodeURIComponent(job.run_id)}/jobs/${prov}/retry`, {});
          toast(r.message || 'Retry queued');
          await refresh();
        } catch (err) {
          toast(err.message, 'bad');
          setBusy(false);
        }
      }}><RotateCcw size={13} aria-hidden="true" />Retry</button>,
    );
  }
  // A waiting job (no API runs it): the sentence for its assistant, or the
  // prompt to paste by hand. A model on hold gets no prompt to act.
  if (job && job.state === 'unconfigured' && !opts.onHold && !resume) {
    out.push(<Dom key="waiting" className="mp-waiting" build={(L) => L.waitingActions(legacyCtx, { pid, runId: job.run_id, provider: prov, key: `${pid}-${prov}` })} deps={[pid, prov, job.run_id]} />);
  }
  if (job && ['interrupted', 'uncertain', 'incomplete', 'conflict', 'held'].includes(info.job || info.kind)) out.push(<a key="runs" className="btn btn-sm" href={`#/project/${encodeURIComponent(pid)}/evidence?open=runs`} data-key={`runs-${pid}-${prov}`}>Research runs</a>);
  if (!rep && !job && p.status !== 'archived' && !opts.onHold) {
    out.push(<button key="run" type="button" className="btn btn-sm" data-key={`run-${pid}-${prov}`} onClick={async () => { const L = await loadLegacy(); L.openResearchDialog(legacyCtx, p, { providers: [prov] }); }}>{`Run ${who} research`}</button>);
  }
  return out.length ? <div className="mp-actions">{out}</div> : null;
}

function Components({ d, rep, grading }) {
  const a = (rep && rep.assessment) || {};
  const anchors = grading.favorable_anchors || [];
  return (
    <ul className="parts" aria-label="The six weighted parts of the investment grade">
      {grading.investment_components.map((c) => {
        const s = (a.investment_components || {})[c.id];
        const scored = isScored(s);
        const value = !s ? 'not given' : scored ? scoreText(s) : s.status === 'not_applicable' ? 'N/A' : 'unknown';
        const word = scored ? anchorText(anchors, s) : null;
        const why = scored ? s.rationale : s ? s.missing_data || s.rationale : null;
        return (
          <li key={c.id}>
            <div className="part-top">
              <span className="part-name">{c.label}<span className="part-w">{`${c.weight_bp / 100}%`}</span></span>
              <span className="part-v"><strong>{value}</strong>{word ? <span className="faint">{` · ${word}`}</span> : null}</span>
            </div>
            <span role="img" aria-label={scored ? scoreWords(s) : 'Unknown, no score'}><ScoreBar score={s} /></span>
            {why ? <p className="part-why">{why}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}

// The verdict: the grade (or why there is none) with the verdict, analysis
// date and horizon, and the grade's warnings as chips beside it. Everything
// here is the list's summary of the one report the panel shows.
function Verdict({ d, p, prov, op }) {
  const rep = op.summary;
  const job = p.research && p.research.providers && p.research.providers[prov];
  const opts = badgeOpts(d, prov);
  const info = pillInfo(prov, rep, job, opts);
  const pid = p.project_id;
  const who = PROVIDER_LABELS[prov];
  const anchors = d.index.rubrics.grading.favorable_anchors || [];
  const rel = rep ? fmtRelDay(rep.analysis_at) : null;
  const verdictWords = rep && rep.verdict ? `${rep.verdict.charAt(0)}${rep.verdict.slice(1).toLowerCase()}` : null;
  // Under the header: when the model analysed it (with the research age) and
  // the horizon; the price's own time stays in the inspector's head.
  const sub = rep ? (
    <>
      <span><b>{`Analyzed ${rep.analysis_at ? fmtDate(rep.analysis_at) : 'date not stated'}`}</b>{rel ? ` · ${rel}` : ''}{info.stale ? <span className="v-stale"> · stale</span> : null}</span>
      <span>{`Horizon ${rep.horizon || 'not stated'}`}</span>
    </>
  ) : null;
  const mt = rep && rep.model_total && rep.model_total.status === 'mismatch' ? rep.model_total : null;
  const level = rep ? evidenceLevel(rep.evidence) : null;
  const chips = mt || level ? (
    <>
      {mt ? <span className="pill pill-warn" title={mt.message} aria-label={mt.message}>{`Own total differs by ${typeof mt.difference === 'number' ? mt.difference.toFixed(1) : '?'}`}</span> : null}
      {level ? (
        <button
          type="button"
          className={`pill ev-chip ev-${level}`}
          data-key={`ev-jump-${prov}`}
          title={`${evidenceText(rep.evidence)}. Open the flags.`}
          aria-label={`${level === 'serious' ? 'Serious evidence flag' : 'Evidence flag'}: ${evidenceText(rep.evidence)}. Open the flags`}
          onClick={() => { const el = document.querySelector(`[data-key="insp-evd-${prov}"]`); if (el) { el.open = true; el.scrollIntoView({ block: 'start', behavior: 'smooth' }); } }}
        >
          <span className={`ev-dot ${level}`} aria-hidden="true" />{level === 'serious' ? 'Serious evidence flag' : 'Evidence flag'}
        </button>
      ) : null}
    </>
  ) : null;
  const captionTitle = `Calculated by the desk from ${who}'s six weighted component scores; never ${who}'s own total`;
  // The metric header (no gauge; Eric, 2026-10-08): the model and its
  // verdict, the desk's grade with its rubric word, the analysis and horizon.
  const header = (grade, word = null) => <MetricHeader who={who} model={rep.model_version || null} verdict={verdictWords} grade={grade} word={word} tier={info.tier} captionTitle={captionTitle} sub={sub} chips={chips} />;
  let body;
  if (rep && (info.kind === 'grade' || info.kind === 'range')) {
    const word = anchorText(anchors, rep.grade.status === 'range' ? { status: 'range', low: rep.grade.low, high: rep.grade.high } : { status: 'scored', value: rep.grade.value });
    body = <div className="vblock">{header(rep.grade, word)}</div>;
  } else if (rep && info.kind === 'pdf') {
    body = (
      <div className="vblock vstate">
        {header({ status: 'none', label: 'PDF saved', reason: 'Needs a text copy to be graded' })}
        <p><a href={`#/updates?tab=import&project=${encodeURIComponent(pid)}&provider=${prov}`} data-key={`pdf-import-${pid}-${prov}`}>{`Import ${who}'s text to grade it`}</a></p>
      </div>
    );
  } else if (rep) {
    const pct = rep.grade ? rep.grade.coverage_pct : null;
    const withheld = Boolean(rep.grade && rep.grade.status === 'withheld');
    body = (
      <div className="vblock vwithheld">
        {header(withheld ? { status: 'withheld', coverage: typeof pct === 'number' ? pct : null, reason: rep.grade.reason || null } : { status: 'none', label: 'No grade' })}
      </div>
    );
  } else {
    const key = jobKey(job, null, { onHold: opts.onHold });
    const st = researchState(info.kind, { provider: prov, hosted: hosted() });
    const hold = onHoldOf(d.index, prov);
    body = (
      <div className="vblock vnone">
        <p className="vstate-title">{`No report from ${who}`}</p>
        {key ? <p className={`state-word tone-${st.tone || 'none'}`}>{info.kind === 'waiting' && hosted() ? 'Waiting for you' : st.long}</p> : <p className="faint">{hold ? `On hold${hold.since ? ` since ${fmtDate(hold.since)}` : ''}` : 'Not researched yet'}</p>}
        {job && job.error ? <p className="v-error">{job.error}</p> : null}
      </div>
    );
  }
  return <div className="mhead" data-report={op.report_id || ''}>{body}</div>;
}

// What waits for the report itself: loading, or a record out of step with
// the list (read once more, then said with a way to read both again).
function ReportWait({ p, prov, op, current, failed, label }) {
  const who = PROVIDER_LABELS[prov];
  if (failed) return <p className="faint mp-wait">{`${who}'s report could not be loaded; the grade above is from the list.`}</p>;
  if (op.status === 'pending' && current && wasResynced(p.project_id, op.report_id)) {
    return (
      <div className="note note-warn mp-wait" role="status">
        <span>{`The list names ${who}'s report ${op.report_id}, which this project's record does not hold yet. Nothing from another report is shown in its place.`}</span>
        <button type="button" className="btn btn-sm" data-key={`resync-${p.project_id}-${prov}`} onClick={() => refresh().catch((err) => toast(err.message, 'bad'))}>Read again</button>
      </div>
    );
  }
  return <Loading label={label || `${who}'s report`} />;
}

// Right after the verdict: the strongest risk the report backs with a cited
// source (else its first risk, said as unsourced), what would confirm it and
// what would break it, each "Not reported" when the report gives none.
function KeyPoints({ p, prov, full, wait }) {
  const pid = p.project_id;
  const who = PROVIDER_LABELS[prov];
  if (!full) return <div className="ikeys is-wait" data-part="keypoints">{wait}</div>;
  const a = full.assessment || {};
  if (a.needs_text) return null;
  const k = keyPoints(a);
  const risk = k.risk;
  const src = risk && risk.sources[0];
  const srcName = src ? src.title || src.publisher || src.url || src.source_id : null;
  const list = (items) => (Array.isArray(items) ? items : []).map((f) => (f && f.text ? String(f.text).trim() : typeof f === 'string' ? f.trim() : '')).filter(Boolean).slice(0, 2);
  const confirm = list(a.conviction_increases);
  const breaks = list(a.invalidators);
  const nr = <span className="tl-nr">Not reported</span>;
  return (
    <dl className="ikeys" data-part="keypoints" data-report={full.report_id} aria-label={`${who}'s strongest risk, and what would confirm or break the view`}>
      <div className="ik ik-risk">
        <dt title={risk && risk.sourced ? 'The strongest risk the report backs with a cited source' : 'No listed risk cites a source'}>{risk && risk.sourced ? 'Strongest sourced risk' : 'Strongest risk'}</dt>
        <dd>
          {risk ? (
            <>
              <p className="ik-t" data-part="risk-text">{risk.text}</p>
              <p className="tl-cite">
                {risk.tags.map((tg) => <span key={tg} className={`etag t-${tg.toLowerCase()}`} title={TAG_TITLES[tg]}>{TAG_WORDS[tg]}</span>)}
                {src && src.url ? <a href={src.url} target="_blank" rel="noopener noreferrer nofollow" data-key={`th-risk-src-${pid}-${prov}`}>{srcName}<ArrowUpRight size={12} aria-hidden="true" /></a> : src ? <span>{srcName}</span> : <span className="faint">No source cited</span>}
                {risk.sources.length > 1 ? <span className="faint">{` +${risk.sources.length - 1}`}</span> : null}
              </p>
            </>
          ) : nr}
        </dd>
      </div>
      <div className="ik ik-confirm">
        <dt>Would confirm</dt>
        <dd>{confirm.length ? <ul>{confirm.map((x) => <li key={x}>{x}</li>)}</ul> : nr}</dd>
      </div>
      <div className="ik ik-break">
        <dt>Would break it</dt>
        <dd>{breaks.length ? <ul>{breaks.map((x) => <li key={x}>{x}</li>)}</ul> : nr}</dd>
      </div>
    </dl>
  );
}

// After the key points: the six weighted components, the revision, what a
// withheld grade is missing, timing notes, and the research actions.
function VerdictMore({ d, p, prov, op, full, wait, opened }) {
  const rep = op.summary;
  const job = p.research && p.research.providers && p.research.providers[prov];
  const opts = badgeOpts(d, prov);
  const info = pillInfo(prov, rep, job, opts);
  const pid = p.project_id;
  const who = PROVIDER_LABELS[prov];
  const grading = d.index.rubrics.grading;
  const resume = <Resume d={d} p={p} prov={prov} job={job} info={info} />;
  const hasResume = Boolean(job && RESUME_WHERE[prov] && !onHoldOf(d.index, prov) && (info.kind === 'interrupted' || info.job === 'interrupted' || (job.state === 'unconfigured' && (job.released || job.draft_saved_at))));
  const parts = rep && !rep.needs_text ? (
    <details className="fold fold-parts" data-key={`ig-parts-${pid}-${prov}`} open={opened.get(`parts-${prov}`)} onToggle={(e) => opened.set(`parts-${prov}`, e.currentTarget.open)}>
      <summary title="What the investment grade is calculated from: each component score times its weight. The diagnostic categories never enter it.">Six weighted components</summary>
      {full ? <Components d={d} rep={full} grading={grading} /> : <Loading label="the six weighted parts" />}
    </details>
  ) : null;
  const why = rep && rep.grade && rep.grade.status === 'withheld' ? withheldReason(prov, rep.grade, rep.unscored) : null;
  const checks = rep && rep.structure && rep.structure.flagged && Array.isArray(rep.structure.flags) ? rep.structure.flags.length : 0;
  const rv = rep && rep.revision && rep.revision.kind === 'revision' ? rep.revision : null;
  const t = rep && rep.analysis_timing;
  return (
    <div className="mmore">
      {why && why.items.length ? (
        <div className="vw-missing">
          <h4>Not scored</h4>
          <ul>{why.items.map((x) => <li key={x.label}><strong>{x.label}</strong>{` · ${x.status}`}{x.note ? <span className="faint">{`: “${x.note.length > 200 ? `${x.note.slice(0, 199)}…` : x.note}”`}</span> : null}</li>)}</ul>
        </div>
      ) : null}
      {checks ? (
        <details className="fold" data-key={`ig-check-${pid}-${prov}`}>
          <summary><span><strong>Check</strong>{` · ${checks} note${checks === 1 ? '' : 's'}`}</span></summary>
          <ul className="plain-list">{rep.structure.flags.slice(0, 3).map((fl) => <li key={fl.message}>{fl.message}</li>)}</ul>
        </details>
      ) : null}
      {parts}
      {rv ? (
        <details className="fold rev" data-key={`rev-${pid}-${prov}`}>
          <summary><RotateCcw size={13} aria-hidden="true" /><span><strong>{rv.basis === 'existing_evidence' ? 'Revision using existing evidence' : rv.basis === 'new_sources' ? `Revision with ${rv.sources.added} new source${rv.sources.added === 1 ? '' : 's'}` : 'Re-saved with the same scores'}</strong>{` · ${who}, ${rv.minutes_after} min after the first save`}</span></summary>
          <div className="fold-body">
            <p>{rep.revision_label}</p>
            {rv.declared ? null : <p className="faint">No reason recorded.</p>}
            {rep.run_link && rep.run_link.report_id && rep.run_link.report_id !== rep.report_id ? <p className="faint">{`The run links the first save (${rep.run_link.report_id}).`}</p> : null}
            <a href={`#/project/${encodeURIComponent(pid)}/report?report=${encodeURIComponent(rv.of)}`} data-key={`rev-of-${pid}-${prov}`}>Open the earlier report</a>
          </div>
        </details>
      ) : null}
      {t && ['after_save', 'future'].includes(t.status) ? <p className="newer-line">{`Stated analysis time: ${t.minutes_after_save !== null && t.minutes_after_save < 2880 ? `${t.minutes_after_save} min` : 'more than a day'} after the save`}</p> : null}
      {rep && info.newerText ? <p className={`newer-line${info.problem ? ' is-problem' : ''}`}>{info.newerText}</p> : null}
      {resume}
      <Actions d={d} p={p} prov={prov} job={job} info={info} opts={opts} rep={rep} resume={hasResume} />
    </div>
  );
}

function Loading({ label }) {
  return <div className="part-loading" role="status"><span className="sr-only">{`Loading ${label}…`}</span><span className="skel w80" /><span className="skel w60" /></div>;
}

// ---- the take, what to watch, your note ----------------------------------------------------

function Take({ text, id }) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [text, open]);
  return (
    <div className="take">
      <p ref={ref} id={id} className={`take-text${open ? '' : ' clamp-3'}`}>{text}</p>
      {long || open ? <button type="button" className="btn-link take-more" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{open ? 'Show less' : 'Show more'}</button> : null}
    </div>
  );
}

function Thesis({ p, prov, detail, full, wait }) {
  const pid = p.project_id;
  const note = detail && detail.conviction ? String(detail.conviction.text || '').trim() : '';
  const sum = p.providers && p.providers[prov];
  const a = full ? full.assessment || {} : null;
  let model = null;
  if (sum && !a) model = wait;
  else if (a && !a.needs_text && !(sum && sum.needs_text)) {
    const metric = a.next_metric_to_monitor;
    model = (
      <>
        {a.final_take ? <Take text={a.final_take} id={`take-${pid}-${prov}`} /> : <p className="faint">{`No final take in ${PROVIDER_LABELS[prov]}'s data block.`}</p>}
        {metric && metric.metric ? <div className="tl"><span className="tl-k">Watch</span><span>{metric.metric}{metric.threshold ? ` (${metric.threshold})` : ''}</span></div> : null}
      </>
    );
  }
  return (
    <section className="insp-sec thesis" aria-labelledby="insp-sec-thesis">
      <h3 className="sec-title" id="insp-sec-thesis">Thesis</h3>
      {model}
      <p className="tl-note" title={note && detail.conviction.updated_at ? `Your note, saved ${fmtDateTime(detail.conviction.updated_at)}` : undefined}>
        <span className="tl-k">Your note</span>
        {note ? <span className="tl-note-text">{note}</span> : <span className="faint">{detail ? 'No conviction note yet' : '…'}</span>}
        <span className="tl-dot" aria-hidden="true">·</span>
        <a href={`#/project/${encodeURIComponent(pid)}/notes`} data-key={`note-edit-${pid}`}>{note ? 'Edit' : 'Write your note'}</a>
      </p>
    </section>
  );
}

// ---- the 13 diagnostic categories ---------------------------------------------------------

function Categories({ d, p, prov, detail, full, wait, opened }) {
  const sum = p.providers && p.providers[prov];
  if (!sum) return null;
  if (!full) return null;
  const r = full;
  const a = r.assessment || {};
  if (a.needs_text || sum.needs_text) return <p className="faint">The saved report is a PDF: its category grades can be read once a text copy is imported.</p>;
  const profile = profileOf(d.index.rubrics.profiles, a, detail.profile);
  const rows = categoryRows(profile, a);
  if (!rows.length) return <p className="faint">This report grades no categories.</p>;
  const counts = scorecardCounts(rows);
  const conf = statesConfidence(rows);
  const flags = (r.evidence && r.evidence.flags) || [];
  const anchors = d.index.rubrics.grading.favorable_anchors || [];
  const current = detail.research_contract && detail.research_contract.sector_profile;
  const older = Boolean(current && a.sector_profile && a.sector_profile !== current);
  return (
    <section className="insp-sec cats" aria-labelledby={`insp-cats-${prov}`} data-report={r.report_id}>
      <div className="sec-head">
        <h3 className="sec-title" id={`insp-cats-${prov}`} title="The report's category grades: diagnostics shown beside the investment grade, never averaged into it">Diagnostic categories</h3>
        <span className="sec-meta">{`${counts.scored} of ${counts.total} scored${counts.unknown ? ` · ${counts.unknown} unknown` : ''}`}{older ? <span title={`This report used ${a.sector_profile}; new research uses ${current}`}>{` · ${a.sector_profile}`}</span> : null}</span>
      </div>
      <ul className="cat-rows" aria-label={`${PROVIDER_LABELS[prov]}'s category grades, 0 to 100, higher is better`}>
        {rows.map((x) => {
          const s = x.score;
          const name = SHORT[x.id] || x.label;
          const na = (x.def && x.def.applicable === false) || (s && s.status === 'not_applicable');
          if (na) {
            return (
              <li key={x.id} className="cat-na">
                <span className="dsb-name" title={x.label}><span className="dsb-label">{name}</span></span>
                <span className="cat-na-word" title={(x.def && x.def.na_reason) || (s && s.rationale) || ''}>Not applicable</span>
              </li>
            );
          }
          const scored = isScored(s);
          const fl = categoryFlags(flags, x.id);
          const serious = fl.some((f) => f.severity === 'high');
          const value = !s ? 'Not in report' : scored ? scoreText(s) : 'Unknown';
          const word = scored ? anchorText(anchors, s) : null;
          const short = !s ? 'Not graded in this report' : scored ? null : s.missing_data || null;
          const item = (k, v) => (v ? [<dt key={`${k}-t`}>{k}</dt>, <dd key={`${k}-d`}>{v}</dd>] : []);
          const okey = `cat-${prov}-${x.id}`;
          return (
            <li key={x.id}>
              <details className={`cat${scored ? '' : ' is-unknown'}${fl.length ? (serious ? ' has-serious' : ' has-flag') : ''}`} data-key={okey} open={opened.get(okey)} onToggle={(e) => opened.set(okey, e.currentTarget.open)}>
                <summary aria-label={`${x.label}: ${scored ? `${scoreWords(s)}${word ? `, ${word}` : ''}${conf && CONFIDENCE_LABELS[s.confidence] ? `, confidence ${CONFIDENCE_LABELS[s.confidence].toLowerCase()}` : ''}` : value}${fl.length ? `; ${serious ? 'serious evidence flag' : 'evidence flag'}` : ''}. Open for the reasons`}>
                  <DiagnosticSegmentBar
                    label={name}
                    title={x.label}
                    score={s}
                    value={scored ? value : '?'}
                    known={scored}
                    mark={fl.length ? <span className={`ev-dot ${serious ? 'serious' : 'material'}`} title={fl.map((f) => f.beside || f.message).join(' ')} /> : null}
                    confidence={conf && scored && CONF_LETTER[s.confidence] ? { letter: CONF_LETTER[s.confidence], title: `${CONFIDENCE_LABELS[s.confidence]} confidence, as the model states it` } : null}
                  />
                  {short ? <span className="cat-why">{short}</span> : null}
                </summary>
                <div className="cat-detail">
                  <p className="cat-full">{x.label}{word ? <span className="faint">{` · ${word}`}</span> : null}</p>
                  {fl.map((f) => (
                    <p key={f.message} className={`evline ev-${f.severity === 'high' ? 'serious' : 'material'}`}><TriangleAlert size={13} aria-hidden="true" /><span><strong>{f.severity === 'high' ? 'Serious evidence flag. ' : 'Evidence flag. '}</strong>{f.beside || f.message}</span></p>
                  ))}
                  <dl>
                    {item(scored ? 'Why this grade' : 'Why unknown', scored ? s.rationale || 'No reason given.' : (s && s.missing_data) || 'Not stated.')}
                    {item('Strongest evidence', s && s.strongest_evidence)}
                    {item('Confidence', scored && CONFIDENCE_LABELS[s.confidence] ? CONFIDENCE_LABELS[s.confidence] : null)}
                    {item('Main weakness', s && s.main_weakness)}
                    {item('Would raise it', s && s.would_raise)}
                    {item('Would lower it', s && s.would_lower)}
                    {item('Cites', s && Array.isArray(s.evidence_refs) && s.evidence_refs.length ? s.evidence_refs.join(', ') : null)}
                  </dl>
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---- the rest of its risks ------------------------------------------------------------------

function Risks({ d, p, prov, full }) {
  const sum = p.providers && p.providers[prov];
  if (!sum || !full) return null;
  const a = full.assessment || {};
  const shown = keyPoints(a).risk;
  const facts = (a.bearish_facts || []).filter((f) => f && f.text && !(shown && f.text.trim() === shown.text)).slice(0, 3);
  const defs = d.index.rubrics.grading.risk_scores || [];
  const top = (s) => (s.status === 'range' ? s.high : s.value);
  const scores = defs.map((def) => ({ def, s: (a.risk_scores || {})[def.id] })).filter((x) => isScored(x.s)).sort((x, y) => top(y.s) - top(x.s));
  const title = shown ? 'More risks' : 'Strongest risks';
  if (!facts.length && !scores.length) return shown ? null : <section className="insp-sec risks"><h3 className="sec-title">{title}</h3><p className="faint">No risks listed.</p></section>;
  return (
    <section className="insp-sec risks" aria-label={`${PROVIDER_LABELS[prov]}'s ${title.toLowerCase()}`} data-report={full.report_id}>
      <h3 className="sec-title">{title}</h3>
      {facts.length ? <ol className="risk-list">{facts.map((f) => <li key={f.text}>{f.text}</li>)}</ol> : null}
      {scores.length ? (
        <p className="risk-scores">
          <span className="tl-k">Downside, higher is worse</span>
          {scores.map((x, i) => <span key={x.def.id} className="rs">{i ? ' · ' : ''}{`${x.def.label.replace(/ risk$/i, '')} `}<strong>{scoreText(x.s)}</strong></span>)}
        </p>
      ) : null}
    </section>
  );
}

// ---- review items for this project --------------------------------------------------------------

const JOB_KINDS = new Set(['research_uncertain', 'research_failed', 'research_incomplete', 'research_conflict', 'research_interrupted', 'identity']);
export const projectItems = (d, p) => (d.index.attention || []).filter((a) => a.project_id === p.project_id && !JOB_KINDS.has(a.kind));

function ReviewItems({ d, p }) {
  const items = splitAttention(projectItems(d, p)).rest;
  if (!items.length) return null;
  return (
    <ul className="insp-items" aria-label="Needs a look">
      {items.map((a, i) => (
        <li key={`${a.kind}-${i}`}>
          <details className={`item-fold sev-${a.severity || 'low'}`} data-key={`previews-${p.project_id}-d-${i}`}>
            <summary><span className="item-kind">{kindWord(a)}</span><span className="item-title">{a.title}</span></summary>
            {a.detail || a.action ? (
              <div className="fold-body">
                {a.detail ? <p>{a.detail}</p> : null}
                {a.action ? <a href={attentionHref(a)} data-key={`previews-${p.project_id}-${i}`}>Open</a> : null}
              </div>
            ) : null}
          </details>
        </li>
      ))}
    </ul>
  );
}

// ---- text and data block differ ----------------------------------------------------------------

function TextCheck({ p, prov, full }) {
  const tx = full ? full.text_scores : null;
  if (!tx || !Array.isArray(tx.mismatches) || !tx.mismatches.length) return null;
  const n = tx.mismatches.length;
  return (
    <details className="fold text-check" data-key={`text-check-${p.project_id}-${prov}`}>
      <summary><TriangleAlert size={13} aria-hidden="true" /><span><strong>Text and data block differ</strong>{` · ${n} score${n === 1 ? '' : 's'}`}</span></summary>
      <div className="fold-body">
        <ul className="plain-list">{tx.mismatches.map((m) => <li key={m.label}>{`${m.label}: ${m.text.join(' and ')} in the text, ${m.data} in the data block`}</li>)}</ul>
        <p className="faint">The grade uses the data block as saved; the text is kept as written, and neither is changed.</p>
      </div>
    </details>
  );
}

export function ModelPanel({ d, p, prov, detail, current = true, failed = false, opened }) {
  const op = opinionOf(p, prov, detail);
  const full = fullOf(op);
  const graded = Boolean(op.summary && !op.summary.needs_text);
  // A current record that does not hold the list's report: read it once more.
  useEffect(() => {
    if (op.status === 'pending' && current) resyncOnce(p.project_id, op.report_id);
  }, [op.status, current, p.project_id, op.report_id]);
  const wait = op.summary && !full ? <ReportWait p={p} prov={prov} op={op} current={current} failed={failed && !detail} /> : null;
  return (
    <div className="mpanel" data-report={op.report_id || ''} data-opinion={op.status}>
      <Verdict d={d} p={p} prov={prov} op={op} />
      {graded ? <KeyPoints p={p} prov={prov} full={full} wait={wait} /> : null}
      <VerdictMore d={d} p={p} prov={prov} op={op} full={full} wait={wait} opened={opened} />
      {graded ? <TextCheck p={p} prov={prov} full={full} /> : null}
      <ReviewItems d={d} p={p} />
      <Thesis p={p} prov={prov} detail={detail} full={full} wait={graded ? null : wait} />
      {graded ? <Categories d={d} p={p} prov={prov} detail={detail} full={full} wait={wait} opened={opened} /> : null}
      {graded ? <Risks d={d} p={p} prov={prov} full={full} /> : null}
    </div>
  );
}
