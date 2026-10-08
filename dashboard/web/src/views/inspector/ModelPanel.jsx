// The selected model's panel in the inspector, in reading order: its verdict
// (the investment grade as the desk calculated it, or why there is none;
// the verdict, analysis date and horizon), its evidence flag and revision,
// the project's review items, the thesis (the take in three lines, the
// strongest risk the report backs with a source, what would confirm and
// break it, your note), the 13 diagnostic category grades, and the rest of
// its risks. Every model keeps its own numbers; unknown stays unknown and is
// never drawn as zero; nothing missing is filled in.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUpRight, RotateCcw, TriangleAlert, Copy } from 'lucide-react';
import {
  PROVIDER_LABELS, fmtDate, fmtDateTime, fmtRelDay, anchorText, withheldReason, withheldLabel, researchState, jobKey, onHoldOf,
  copyText, toast, TAG_TITLES, COVERAGE_MEANS, evidenceLevel, evidenceText,
} from '../../../../public/ui.js';
import { splitAttention, kindWord, attentionHref } from '../../../../public/watchlist-model.js';
import { keyPoints, TAG_WORDS } from '../../../../public/brief-model.js';
import { profileOf, categoryRows, scorecardCounts, statesConfidence, categoryFlags, CONFIDENCE_LABELS } from '../../../../public/thesis-ui.js';
import { api, refresh, hosted } from '../../lib/desk.js';
import { legacyCtx } from '../../legacy/ctx.js';
import { Gauge, ScoreBar } from '../../components/Gauge.jsx';
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

export function latestOf(d, prov, sum) {
  if (!d || !sum) return null;
  const meta = d.comparison && d.comparison.latest ? d.comparison.latest[prov] : null;
  return d.reports.find((x) => x.report_id === sum.report_id) || (meta ? d.reports.find((x) => x.report_id === meta.report_id) : null) || null;
}

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

function GradeBlock({ d, p, prov, detail, opened }) {
  const rep = p.providers && p.providers[prov];
  const job = p.research && p.research.providers && p.research.providers[prov];
  const opts = badgeOpts(d, prov);
  const info = pillInfo(prov, rep, job, opts);
  const pid = p.project_id;
  const who = PROVIDER_LABELS[prov];
  const grading = d.index.rubrics.grading;
  const anchors = grading.favorable_anchors || [];
  const full = latestOf(detail, prov, rep);
  const resume = <Resume d={d} p={p} prov={prov} job={job} info={info} />;
  const hasResume = Boolean(job && RESUME_WHERE[prov] && !onHoldOf(d.index, prov) && (info.kind === 'interrupted' || info.job === 'interrupted' || (job.state === 'unconfigured' && (job.released || job.draft_saved_at))));
  const rel = rep ? fmtRelDay(rep.analysis_at) : null;
  const facts = rep ? (
    <dl className="vfacts">
      <div><dt>Verdict</dt><dd className="v-verdict">{rep.verdict ? `${rep.verdict.charAt(0)}${rep.verdict.slice(1).toLowerCase()}` : <span className="faint">No verdict</span>}</dd></div>
      <div><dt>Analysis</dt><dd>{fmtDate(rep.analysis_at)}{rel ? <span className="faint">{` · ${rel}`}</span> : null}{info.stale ? <span className="v-stale"> · stale</span> : null}</dd></div>
      <div><dt>Horizon</dt><dd>{rep.horizon || 'not stated'}</dd></div>
    </dl>
  ) : null;
  const mt = rep && rep.model_total && rep.model_total.status === 'mismatch' ? rep.model_total : null;
  const delta = mt ? <span className="pill pill-warn" title={mt.message} aria-label={mt.message}>{`Own total differs by ${typeof mt.difference === 'number' ? mt.difference.toFixed(1) : '?'}`}</span> : null;
  const parts = rep && !rep.needs_text ? (
    <details className="fold fold-parts" data-key={`ig-parts-${pid}-${prov}`} open={opened.get(`parts-${prov}`)} onToggle={(e) => opened.set(`parts-${prov}`, e.currentTarget.open)}>
      <summary title="What the investment grade is calculated from: each component score times its weight. The diagnostic categories never enter it.">Six weighted components</summary>
      {detail ? (full ? <Components d={d} rep={full} grading={grading} /> : <p className="faint">The report could not be read.</p>) : <Loading label="the six weighted parts" />}
    </details>
  ) : null;
  let body;
  if (rep && (info.kind === 'grade' || info.kind === 'range')) {
    const word = anchorText(anchors, rep.grade.status === 'range' ? { status: 'range', low: rep.grade.low, high: rep.grade.high } : { status: 'scored', value: rep.grade.value });
    body = (
      <div className="vblock">
        <div className="vrow">
          <div className="vgauge"><Gauge grade={rep.grade} word={word} serious={info.ev === 'serious'} /></div>
          <div className="vside">{facts}{delta}</div>
        </div>
        {parts}
      </div>
    );
  } else if (rep && info.kind === 'pdf') {
    body = (
      <div className="vblock vstate">
        <p className="vstate-title">PDF saved: needs a text copy</p>
        <p><a href={`#/updates?tab=import&project=${encodeURIComponent(pid)}&provider=${prov}`} data-key={`pdf-import-${pid}-${prov}`}>{`Import ${who}'s text to grade it`}</a></p>
        {facts}
      </div>
    );
  } else if (rep) {
    const pct = rep.grade ? rep.grade.coverage_pct : null;
    const why = rep.grade && rep.grade.status === 'withheld' ? withheldReason(prov, rep.grade, rep.unscored) : null;
    const checks = rep.structure && rep.structure.flagged && Array.isArray(rep.structure.flags) ? rep.structure.flags.length : 0;
    body = (
      <div className="vblock vwithheld">
        <div className="vw-head">
          <span className="vw-word">{rep.grade && rep.grade.status === 'withheld' ? withheldLabel(pct) : 'No grade'}</span>
        </div>
        {typeof pct === 'number' ? (
          <div className="cov" title={COVERAGE_MEANS}>
            <div className="cov-track" aria-hidden="true"><div className="cov-fill" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} /></div>
            <div className="cov-lbl">{`${pct}% of the investment weight scored`}</div>
          </div>
        ) : null}
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
        {facts}
        {parts}
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
  const level = rep ? evidenceLevel(rep.evidence) : null;
  const rv = rep && rep.revision && rep.revision.kind === 'revision' ? rep.revision : null;
  const t = rep && rep.analysis_timing;
  return (
    <div className="mhead">
      {body}
      {level ? (
        <p className={`evline ev-${level}`}>
          <span className={`ev-dot ${level}`} aria-hidden="true" />
          <span><strong>{level === 'serious' ? 'Serious flag' : 'Flag'}</strong>{` · ${evidenceText(rep.evidence)} · `}
            <button type="button" className="btn-link" data-key={`ev-jump-${prov}`} onClick={() => { const el = document.querySelector(`[data-key="insp-evd-${prov}"]`); if (el) { el.open = true; el.scrollIntoView({ block: 'start', behavior: 'smooth' }); } }}>See the flags</button>
          </span>
        </p>
      ) : null}
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

// ---- the thesis ------------------------------------------------------------------------

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

function Thesis({ d, p, prov, detail }) {
  const pid = p.project_id;
  const note = detail && detail.conviction ? String(detail.conviction.text || '').trim() : '';
  const sum = p.providers && p.providers[prov];
  const r = latestOf(detail, prov, sum);
  const a = r && !r.broken ? r.assessment || {} : null;
  let model = null;
  if (!detail) model = <Loading label="the thesis" />;
  else if (a && !a.needs_text && !(sum && sum.needs_text)) {
    const metric = a.next_metric_to_monitor;
    const list = (items) => (Array.isArray(items) ? items : []).filter((f) => f && f.text).slice(0, 2);
    const confirm = list(a.conviction_increases);
    const invalid = list(a.invalidators);
    const risk = keyPoints(a).risk;
    const any = a.final_take || (metric && metric.metric) || confirm.length || invalid.length;
    const nr = (k) => <div className="tl"><span className="tl-k">{k}</span><span className="tl-nr">Not reported</span></div>;
    const src = risk && risk.sources[0];
    const srcName = src ? src.title || src.publisher || src.url || src.source_id : null;
    model = (
      <>
        {!any && !risk ? <p className="faint">{`No thesis in ${PROVIDER_LABELS[prov]}'s data block.`}</p> : null}
        {a.final_take ? <Take text={a.final_take} id={`take-${pid}-${prov}`} /> : null}
        {risk ? (
          <div className="tl tl-risk">
            <span className="tl-k" title={risk.sourced ? 'The strongest risk the report backs with a cited source' : 'No listed risk cites a source'}>Risk</span>
            <div className="tl-body">
              <p className="tl-risk-text">{risk.text}</p>
              <p className="tl-cite">
                {risk.tags.map((tg) => <span key={tg} className={`etag t-${tg.toLowerCase()}`} title={TAG_TITLES[tg]}>{TAG_WORDS[tg]}</span>)}
                {src && src.url ? <a href={src.url} target="_blank" rel="noopener noreferrer nofollow" data-key={`th-risk-src-${pid}-${prov}`}>{srcName}<ArrowUpRight size={12} aria-hidden="true" /></a> : src ? <span>{srcName}</span> : <span className="faint">No source cited</span>}
                {risk.sources.length > 1 ? <span className="faint">{` +${risk.sources.length - 1}`}</span> : null}
              </p>
            </div>
          </div>
        ) : nr('Risk')}
        {metric && metric.metric ? <div className="tl"><span className="tl-k">Watch</span><span>{metric.metric}{metric.threshold ? ` (${metric.threshold})` : ''}</span></div> : null}
        {confirm.length ? <div className="tl tl-confirm"><span className="tl-k">Confirms</span><ul>{confirm.map((x) => <li key={x.text}>{x.text}</li>)}</ul></div> : nr('Confirms')}
        {invalid.length ? <div className="tl tl-break"><span className="tl-k">Breaks</span><ul>{invalid.map((x) => <li key={x.text}>{x.text}</li>)}</ul></div> : nr('Breaks')}
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

function Categories({ d, p, prov, detail, opened }) {
  const sum = p.providers && p.providers[prov];
  if (!sum) return null;
  if (!detail) return <section className="insp-sec"><Loading label="the category grades" /></section>;
  const r = latestOf(detail, prov, sum);
  if (!r || r.broken) return <p className="faint">The report could not be read.</p>;
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
    <section className="insp-sec cats" aria-labelledby={`insp-cats-${prov}`}>
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
                <span className="cat-name" title={x.label}>{name}</span>
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
                  <span className="cat-name" title={x.label} aria-hidden="true">
                    {name}
                    {fl.length ? <span className={`ev-dot ${serious ? 'serious' : 'material'}`} title={fl.map((f) => f.beside || f.message).join(' ')} /> : null}
                  </span>
                  <ScoreBar score={s} />
                  <span className="cat-score" aria-hidden="true">
                    <span className="cat-v">{scored ? value : '?'}</span>
                    {conf && scored && CONF_LETTER[s.confidence] ? <span className="cat-conf" title={`${CONFIDENCE_LABELS[s.confidence]} confidence, as the model states it`}>{CONF_LETTER[s.confidence]}</span> : null}
                  </span>
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

function Risks({ d, p, prov, detail }) {
  const sum = p.providers && p.providers[prov];
  if (!sum || !detail) return null;
  const r = latestOf(detail, prov, sum);
  if (!r || r.broken) return null;
  const a = r.assessment || {};
  const shown = keyPoints(a).risk;
  const facts = (a.bearish_facts || []).filter((f) => f && f.text && !(shown && f.text.trim() === shown.text)).slice(0, 3);
  const defs = d.index.rubrics.grading.risk_scores || [];
  const top = (s) => (s.status === 'range' ? s.high : s.value);
  const scores = defs.map((def) => ({ def, s: (a.risk_scores || {})[def.id] })).filter((x) => isScored(x.s)).sort((x, y) => top(y.s) - top(x.s));
  const title = shown ? 'More risks' : 'Strongest risks';
  if (!facts.length && !scores.length) return shown ? null : <section className="insp-sec risks"><h3 className="sec-title">{title}</h3><p className="faint">No risks listed.</p></section>;
  return (
    <section className="insp-sec risks" aria-label={`${PROVIDER_LABELS[prov]}'s ${title.toLowerCase()}`}>
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

function TextCheck({ p, prov, detail }) {
  const sum = p.providers && p.providers[prov];
  if (!sum || !detail) return null;
  const r = latestOf(detail, prov, sum);
  const tx = r && !r.broken ? r.text_scores : null;
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

export function ModelPanel({ d, p, prov, detail, opened }) {
  const graded = Boolean(p.providers && p.providers[prov] && !p.providers[prov].needs_text);
  return (
    <div className="mpanel">
      <GradeBlock d={d} p={p} prov={prov} detail={detail} opened={opened} />
      {graded ? <TextCheck p={p} prov={prov} detail={detail} /> : null}
      <ReviewItems d={d} p={p} />
      <Thesis d={d} p={p} prov={prov} detail={detail} />
      {graded ? <Categories d={d} p={p} prov={prov} detail={detail} opened={opened} /> : null}
      {graded ? <Risks d={d} p={p} prov={prov} detail={detail} /> : null}
    </div>
  );
}
