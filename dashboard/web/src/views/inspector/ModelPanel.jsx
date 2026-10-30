// The inspector's body, Level 1 (UI_MASTER_PLAYBOOK.md §4.5, 2026-10-30):
// what this is, what the call is, what could break it, what to do:
//   C. the PM Cohort: the canonical grade (D1: your pinned headline report,
//      else Claude's current eligible report) with its rubric word and the
//      verdict, the spread, and each model's grade as a bar;
//   then bull and bear: the strongest sourced risk and the top "would
//      confirm", with "would break it" under the risk;
//   E. the signals: forensic status, downside, the exit at your size, the
//      top pool and GoPlus, the most severe first, the rest one click away;
//   F. the changes since your review, one line, only when there are some;
//   the thesis in three lines (Read full brief) and the watch item, the PM
//   ticket, what needs you (only when something does) and your note.
// Everything else (the 13 categories, the six components, the downside
// panel, the DEX card, the contract checks, the chart, the evidence, the
// research details and the exact prompt) lives on the project page (Level 2).
//
// Every part drawn from the report comes from one report: the canonical one,
// found in the project record with the same grade, verdict and date
// (lib/opinion.js), or your pinned headline report by its ID. While the record
// does not hold it, those parts say so instead of showing another report's
// words (review 2026-10-08, F1). Unknown stays unknown; nothing is averaged.
import { useEffect, useState } from 'react';
import { ArrowUpRight, ArrowRight, RotateCcw, TriangleAlert } from 'lucide-react';
import {
  PROVIDER_LABELS, fmtDate, fmtDateTime, fmtRelDay, fmtCompactUsd, researchState, onHoldOf, jobKey, toast, TAG_TITLES, evidenceLevel, evidenceText, submissionId, safeUrl,
} from '../../../../public/ui.js';
import { canonicalOf, canonicalGrade, consensusOf, exitCell, reviewReasons, agendaRowOf, riskSignals, contractChipModel, kindWord, attentionHref, rowProject } from '../../../../public/watchlist-model.js';
import { useAgendaRead } from '../../lib/agenda.js';
import { keyPoints, TAG_WORDS, verdictOf, falsifiableOf } from '../../../../public/brief-model.js';
import { api, refresh, resyncOnce, wasResynced } from '../../lib/desk.js';
import { navigate } from '../../lib/router.js';
import { opinionOf } from '../../lib/opinion.js';
import { MetricHeader } from '../../components/MetricHeader.jsx';
import { loadLegacy } from '../../components/Dom.jsx';
import { PMDecisionCard } from './PMDecisionCard.jsx';

const enc = encodeURIComponent;
const plain = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

// A link into the project page that keeps the way back to this inspector
// (Back, Escape and the back bar return here).
export function DeepLink({ pid, href, children, className = '', dataKey, title = null, ariaLabel = null }) {
  return (
    <a
      href={href}
      className={className || undefined}
      data-key={dataKey}
      title={title || undefined}
      aria-label={ariaLabel || undefined}
      onClick={(e) => {
        if (!plain(e)) return;
        e.preventDefault();
        navigate(href, { state: { crBrief: pid, from: 'watchlist' } });
      }}
    >
      {children}
    </a>
  );
}

// The report the inspector's report-derived parts come from: the canonical
// one, or null while the record does not hold it.
export function canonicalReport(p, detail) {
  const c = canonicalOf(p);
  if (c.source === 'headline') {
    if (!detail) return { status: 'loading', c, report: null, report_id: c.report.report_id };
    const r = (detail.reports || []).find((x) => x && x.report_id === c.report.report_id && !x.broken) || null;
    return { status: r ? 'ok' : 'pending', c, report: r, report_id: c.report.report_id };
  }
  const op = opinionOf(p, 'claude', detail);
  return { status: op.status, c, report: op.status === 'ok' ? op.report : null, report_id: op.report_id };
}

function Loading({ label }) {
  return <div className="part-loading" role="status"><span className="sr-only">{`Loading ${label}…`}</span><span className="skel w80" /><span className="skel w60" /></div>;
}

// ---- 1. the executive verdict -------------------------------------------------------------

// Block C: the PM Cohort. The canonical grade, its band and verdict, the
// spread between the firm grades, and one bar per model (a range draws its
// middle; a model with no grade draws no fill and says why). Each model's
// name opens its Brief. Nothing is averaged.
const COHORT_FILL = { claude: 'is-claude', chatgpt: 'is-gpt', gemini: 'is-gemini' };
const midOf = (m) => (typeof m.value === 'number' ? m.value : m.low !== null && m.high !== null ? (m.low + m.high) / 2 : null);

function Cohort({ d, p, cr }) {
  const pid = p.project_id;
  const g = canonicalGrade(p, d.index);
  const cs = consensusOf(p, d.index);
  const c = cr.c;
  const rep = c.report;
  const vw = rep && rep.verdict ? verdictOf({ verdict: rep.verdict }) : null;
  const verdict = vw && vw.label ? vw.label : rep && rep.verdict ? `${rep.verdict.charAt(0)}${rep.verdict.slice(1).toLowerCase()}` : null;
  const graded = g.kind === 'grade' || g.kind === 'range';
  const shown = graded ? g.value : g.kind === 'job' ? researchState(g.job, { provider: c.provider || 'claude' }).short : g.value;
  const line = [graded ? g.word : null, verdict].filter(Boolean).join(' · ');
  const level = rep && !rep.needs_text ? evidenceLevel(rep.evidence) : null;
  const flags = rep && rep.evidence ? (rep.evidence.high || 0) + (rep.evidence.medium || 0) : 0;
  const firm = cs.models.filter((m) => typeof m.value === 'number').length;
  return (
    <section className="iv-cohort" aria-labelledby="iv-h" data-part="verdict" data-provider={c.provider || 'claude'} data-report={rep ? rep.report_id || '' : ''} data-source={c.source}>
      <h3 className="iv-k" id="iv-h">PM Cohort</h3>
      <div className="iv-grade-row">
        <p className="iv-grade" title={`${c.note}. Calculated by the desk from the six weighted component scores; never the model's own total, never an average of the models.`}>
          {graded
            ? <span className="iv-grade-v" data-part="grade-score" role="img" aria-label={`Investment grade ${g.value} of 100${g.word ? `, ${g.word}` : ''}`}>{shown}</span>
            : <span className="iv-grade-v is-none">{shown}</span>}
          {line ? <span className="iv-grade-w" title={line}>{graded && g.word ? g.word : null}{graded && g.word && verdict ? ' · ' : null}{verdict ? <span className="mh-verdict">{verdict}</span> : null}</span> : null}
        </p>
        {firm >= 2 && cs.spread !== null ? <span className="iv-spread" title="Points between the highest and lowest firm grade. Agreement is not independent confirmation.">{`spread ${cs.spread.toFixed(1)}`}</span> : null}
      </div>
      <ul className="iv-models" aria-label={`Each model's own grade: ${cs.text}`}>
        {cs.models.map((m) => {
          const v = midOf(m);
          return (
            <li key={m.provider} className="iv-model">
              <DeepLink pid={pid} href={`#/project/${enc(pid)}/brief?model=${m.provider}`} className="iv-model-n" dataKey={`iv-model-${m.provider}`} ariaLabel={`${m.name}: ${m.words}. Open ${m.name}'s Brief`}>{m.label}</DeepLink>
              <span className="iv-bar" aria-hidden="true"><span className={`iv-bar-fill ${COHORT_FILL[m.provider] || ''}`} style={{ width: `${v === null ? 0 : Math.max(0, Math.min(100, v))}%` }} /></span>
              <span className="iv-model-v" title={m.words}>{v !== null ? m.words : m.mark === 'none' ? '—' : m.words}</span>
            </li>
          );
        })}
      </ul>
      {level ? (
        <DeepLink pid={pid} href={`#/project/${enc(pid)}/evidence?model=${c.provider || 'claude'}&open=checks`} className="iv-ev" dataKey={`iv-ev-${pid}`} title={`${evidenceText(rep.evidence)}. Open the flags.`} ariaLabel={`${level === 'serious' ? 'Serious evidence flag' : 'Evidence flag'}: ${evidenceText(rep.evidence)}. Open the flags`}>
          <TriangleAlert size={12} aria-hidden="true" />{`${level === 'serious' ? 'Serious evidence flag' : 'Evidence flag'}${flags > 1 ? ` · ${flags}` : ''}`}
        </DeepLink>
      ) : null}
    </section>
  );
}

function VerdictCard({ d, p, cr }) {
  const pid = p.project_id;
  const g = canonicalGrade(p, d.index);
  const c = cr.c;
  const rep = c.report;
  const who = c.source === 'headline' ? `Your headline · ${PROVIDER_LABELS[c.provider] || 'report'}` : PROVIDER_LABELS[c.provider || 'claude'];
  const vw = rep && rep.verdict ? verdictOf({ verdict: rep.verdict }) : null;
  const verdict = vw && vw.label ? vw.label : rep && rep.verdict ? `${rep.verdict.charAt(0)}${rep.verdict.slice(1).toLowerCase()}` : null;
  const rel = rep ? fmtRelDay(rep.analysis_at) : null;
  // Claude's change since its own earlier report (core/report-delta.js), shown only on Claude's current report.
  const rd = rep && c.provider !== 'chatgpt' && c.provider !== 'gemini' && c.source !== 'headline' && p.report_delta && p.report_delta.status === 'ok' && p.report_delta.new_report_id === rep.report_id ? p.report_delta : null;
  const sub = rep ? (
    <>
      <span><b>{`Analyzed ${rep.analysis_at ? fmtDate(rep.analysis_at) : 'date not stated'}`}</b>{rel ? ` · ${rel}` : ''}</span>
      <span>{`Horizon ${rep.horizon || 'not stated'}`}</span>
      {rd ? <span data-key={`iv-delta-${pid}`} title={rd.grade_note || rd.category_note || undefined}>{rd.line}</span> : null}
    </>
  ) : null;
  const level = rep && !rep.needs_text ? evidenceLevel(rep.evidence) : null;
  const flags = rep && rep.evidence ? (rep.evidence.high || 0) + (rep.evidence.medium || 0) : 0;
  const chips = level ? (
    <DeepLink pid={pid} href={`#/project/${enc(pid)}/evidence?model=${c.provider || 'claude'}&open=checks`} className={`badge iv-ev ev-${level} is-warn`} dataKey={`iv-ev-${pid}`} title={`${evidenceText(rep.evidence)}. Open the flags.`} ariaLabel={`${level === 'serious' ? 'Serious evidence flag' : 'Evidence flag'}: ${evidenceText(rep.evidence)}. Open the flags`}>
      <TriangleAlert size={12} aria-hidden="true" />{`${level === 'serious' ? 'Serious evidence flag' : 'Evidence flag'}${flags > 1 ? ` · ${flags}` : ''}`}
    </DeepLink>
  ) : null;
  const grade = g.kind === 'grade' || g.kind === 'range'
    ? { status: g.kind === 'range' ? 'range' : 'firm', display: g.value }
    : g.kind === 'withheld' ? { status: 'withheld', coverage: g.coverage, reason: rep && rep.grade ? rep.grade.reason || null : null }
      : { status: 'none', label: g.kind === 'job' ? researchState(g.job, { provider: c.provider || 'claude' }).short : g.value, reason: g.kind === 'pdf' ? 'Needs a text copy to be graded' : g.kind === 'job' ? null : c.note };
  return (
    <section className="iv-card" aria-labelledby="iv-h" data-part="verdict" data-provider={c.provider || 'claude'} data-report={rep ? rep.report_id || '' : ''} data-source={c.source}>
      <h3 className="sr-only" id="iv-h">Verdict</h3>
      <MetricHeader
        who={who}
        model={rep && rep.model_version ? rep.model_version : null}
        verdict={verdict}
        grade={grade}
        word={g.word}
        tier={g.tier}
        caption={c.source === 'headline' ? 'Headline grade' : 'Grade'}
        captionTitle={`${c.note}. Calculated by the desk from the six weighted component scores; never the model's own total, never an average of the models.`}
        sub={sub}
        chips={chips}
      />
    </section>
  );
}

// ---- 2. bull and bear -------------------------------------------------------------------------

function Triggers({ p, cr, wait }) {
  const pid = p.project_id;
  const [more, setMore] = useState(false);
  if (!cr.c.report || cr.c.report.needs_text) return null;
  const full = cr.report;
  if (!full) return <div className="ikeys is-wait" data-part="keypoints">{wait}</div>;
  const a = full.assessment || {};
  if (a.needs_text) return null;
  const k = keyPoints(a);
  const risk = k.risk;
  const src = risk && risk.sources[0];
  const srcName = src ? src.title || src.publisher || src.url || src.source_id : null;
  const srcUrl = src && src.url && /^https?:/i.test(safeUrl(src.url) || '') ? safeUrl(src.url) : null;
  const list = (items) => (Array.isArray(items) ? items : []).map((f) => (f && f.text ? String(f.text).trim() : typeof f === 'string' ? f.trim() : '')).filter(Boolean);
  const confirm = list(a.conviction_increases);
  const breaks = list(a.invalidators);
  const nr = <span className="tl-nr">Not reported</span>;
  const extra = confirm.length - 1 + (breaks.length - 1 > 0 ? breaks.length - 1 : 0);
  return (
    <dl className="ikeys iv-tr" data-part="keypoints" data-report={full.report_id} aria-label="The strongest risk, and what would confirm or break the view">
      <div className="ik ik-risk">
        <dt title={risk && risk.sourced ? 'The strongest risk the report backs with a cited source' : 'No listed risk cites a source'}>{risk && risk.sourced ? 'Bear · strongest sourced risk' : 'Bear · strongest risk'}</dt>
        <dd>
          {risk ? (
            <>
              <p className="ik-t clamp-3" data-part="risk-text" title={risk.text.length > 280 ? risk.text : undefined}>{risk.text}</p>
              <p className="tl-cite">
                {risk.tags.filter((tg) => tg !== 'V').map((tg) => <span key={tg} className={`etag t-${tg.toLowerCase()}`} title={TAG_TITLES[tg]}>{TAG_WORDS[tg]}</span>)}
                {srcUrl ? <a href={srcUrl} target="_blank" rel="noopener noreferrer nofollow" data-key={`th-risk-src-${pid}`}>{srcName}<ArrowUpRight size={12} aria-hidden="true" /></a> : src ? <span>{srcName}</span> : <span className="faint">No source cited</span>}
              </p>
            </>
          ) : nr}
        </dd>
      </div>
      <div className="ik ik-confirm">
        <dt>Bull · would confirm</dt>
        <dd>
          {confirm.length ? <p className="ik-t">{confirm[0]}</p> : nr}
          {more && confirm.length > 1 ? <ul className="ik-more">{confirm.slice(1).map((x) => <li key={x}>{x}</li>)}</ul> : null}
        </dd>
      </div>
      <div className="ik ik-break">
        <dt>Would break it</dt>
        <dd>
          {breaks.length ? <p className="ik-t">{breaks[0]}</p> : nr}
          {more && breaks.length > 1 ? <ul className="ik-more">{breaks.slice(1).map((x) => <li key={x}>{x}</li>)}</ul> : null}
        </dd>
      </div>
      {extra > 0 ? (
        <div className="ik-foot">
          <button type="button" className="btn-link" aria-expanded={more} data-key={`iv-more-${pid}`} onClick={() => setMore(!more)}>{more ? 'Show less' : `+${extra} more`}</button>
        </div>
      ) : null}
    </dl>
  );
}

// ---- E. the signals (UI v3, 2026-10-30): forensic status, downside risk, the
// exit at your size, the top pool and the contract, one line each -----------------------------

const FX_STATE_WORDS = { occurred: 'Occurred', watch: 'Watch', recovered: 'Recovered', within: 'Within', not_established: 'Not established', unknown: 'Unknown', reversed: 'Reversed' };
const FX_LABELS = { liquidity_impairment: 'Liquidity', operational_degradation: 'Operations', delivery_inactivity: 'Delivery', confirmed_discontinuation: 'Discontinuation' };
const toneOf = (s) => (s === 'occurred' ? 'is-bad' : s === 'watch' ? 'is-warn' : s === 'unknown' || s === 'not_established' ? 'is-unknown' : '');

// The deepest DEX pool, asked of DexScreener by this browser only once the
// inspector has rested 250 ms on this project (dex.js; chain-scoped, for the
// verified identity's contracts only, never stored).
// Why there is no pool to look up, by dexTargets' state.
const NO_POOL = {
  unverified: 'Identity not verified: no contract to look up',
  native: 'Native coin: no token contract',
  none: 'No contract recorded to look up',
  unmatched: 'Its chain is not one DexScreener lists',
};

function useTopPool(p) {
  const [st, setSt] = useState({ pid: null, pool: undefined, error: null });
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const L = await loadLegacy();
        // dexTargets answers { state, targets }: the verified identity's
        // contracts on chains DexScreener lists, or why there are none.
        const { state, targets } = L.dexTargets(rowProject(p));
        if (!targets.length) { if (alive) setSt({ pid: p.project_id, pool: null, error: null, none: state }); return; }
        const answer = L.peekLookup(targets) || await L.lookupTargets(targets);
        const ref = p.market && typeof p.market.price_usd === 'number' ? p.market.price_usd : null;
        if (alive) setSt({ pid: p.project_id, pool: L.topPool(answer, targets, { refPrice: ref }), error: null, thin: L.THIN_USD });
      } catch (error) {
        if (alive) setSt({ pid: p.project_id, pool: null, error });
      }
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [p.project_id]);
  return st.pid === p.project_id ? st : { pid: null, pool: undefined, error: null };
}

function Signals({ d, p }) {
  const pid = p.project_id;
  const f = p.forensic;
  const ex = exitCell(p, d.index);
  const pool = useTopPool(p);
  const [more, setMore] = useState(false);
  const m = contractChipModel(p.screening);
  const risky = m.chips.filter((x) => x.dot === 'risky');
  const severe = m.extra.filter((b) => b.tone === 'severe');
  const fxHref = `#/project/${enc(pid)}/forensics`;
  const audited = f && f.audited;
  const states = audited ? Object.entries(f.states) : [];
  const signals = riskSignals(p, d.index);
  const fx = signals.find((x) => x.kind === 'forensic');
  // The canonical report's top downside score (risk_scores; the Desk's Risk
  // column falls back to it); the full panel is on the Brief.
  const down = signals.find((x) => x.kind === 'downside');
  const tone = (t) => (t === 'bad' ? 'is-bad' : t === 'warn' ? 'is-warn' : t === 'ok' ? 'is-ok' : '');
  // GoPlus in words: the severe flags first, then the risky checks; nothing
  // here ever reads as safe.
  const contract = m.state === 'native_chain' ? { text: 'Native coin · no contract', tone: '', title: m.title || undefined }
    : severe.length ? { text: severe.map((b) => `${b.label}${b.value ? ` ${b.value}` : ''}`).join(' · '), tone: 'bad', title: severe.map((b) => b.title || b.label).join('\n') }
      : risky.length ? { text: risky.map((x) => `${x.label}: ${x.value}`).join(' · '), tone: 'warn', title: risky.map((x) => x.title || x.aria).join('\n') }
        : m.chips.every((x) => x.dot === 'unknown') ? { text: (m.status && m.status.word) || 'GoPlus: no answer', tone: 'unknown', title: (m.status && (m.status.title || m.status.word)) || m.title || 'No GoPlus answer on record' }
          : { text: 'GoPlus: no flag', tone: '', title: 'GoPlus answered no mint, blacklist, proxy or tax flag. Nothing here means safe.' };
  const tone3 = (t) => (t === 'bad' ? 'bad' : t === 'warn' ? 'warn' : t === 'ok' || t === 'neutral' ? 'ok' : 'unknown');
  const list = [
    {
      key: 'forensic',
      tone: audited ? tone3(fx && fx.tone) : 'unknown',
      title: fx ? fx.title : 'No forensic audit on record',
      name: audited ? fx.text : f && f.open_audit ? 'Audit open' : 'Not audited',
      note: audited ? states.map(([k, st]) => `${FX_LABELS[k]} ${(FX_STATE_WORDS[st] || st).toLowerCase()}`).join(' · ') : f && f.open_audit ? 'No assessment saved yet' : null,
      action: audited
        ? <DeepLink pid={pid} href={fxHref} className="iv-link" dataKey={`iv-fx-${pid}`}>Open Forensics</DeepLink>
        : <DeepLink pid={pid} href={`${fxHref}?open=start`} className="iv-link" dataKey={`iv-fx-start-${pid}`}>{f && f.open_audit ? 'Open the audit' : 'Start audit'}</DeepLink>,
    },
    {
      key: 'downside',
      tone: down ? tone3(down.tone) : 'unknown',
      title: down ? down.title : 'The report gives no downside score',
      name: down ? <>{`Downside ${down.value}`}<span className="v3-sig-of"> / 100</span><span className="sr-only">{` · ${down.label}, higher is worse`}</span></> : 'Downside not scored',
      note: down ? down.label : null,
    },
    {
      key: 'exit',
      tone: ex.tone === 'bad' ? 'bad' : ex.tone === 'ok' ? 'ok' : 'unknown',
      title: ex.title,
      name: `Exit at $${ex.size} · ${ex.text}`,
      note: `${ex.basis ? `${ex.basis} · ` : ''}${ex.limit}% limit`,
    },
    {
      key: 'pool',
      tone: pool.pool ? (pool.pool.thin ? 'warn' : 'ok') : 'unknown',
      title: pool.pool ? `${pool.pool.chain}${pool.pool.pairAddress ? ` · ${pool.pool.pairAddress}` : ''} · DexScreener, asked by this browser` : pool.error ? pool.error.message : null,
      name: pool.pool === undefined ? <span aria-busy="true">Top pool …</span>
        : pool.error ? 'DexScreener unread'
          : !pool.pool ? (NO_POOL[pool.none] ? 'Pool not looked up' : 'No pool indexed')
            : `Top pool ${pool.pool.liquidity === null ? '—' : fmtCompactUsd(pool.pool.liquidity)}${pool.pool.thin ? ' · Thin' : ''}`,
      note: pool.pool ? `${pool.pool.dex} · ${pool.pool.pair}${pool.pool.multiChain ? ` · ${pool.pool.chain}` : ''}` : pool.error ? `DexScreener could not be read: ${pool.error.message}` : pool.pool === null && NO_POOL[pool.none] ? NO_POOL[pool.none] : pool.pool === null ? 'DexScreener lists no pool for this contract' : null,
    },
    {
      key: 'contract',
      tone: contract.tone === 'bad' ? 'bad' : contract.tone === 'warn' ? 'warn' : 'unknown',
      title: contract.title,
      name: contract.text,
      note: null,
    },
  ];
  // The most severe first, so what could break it is never folded away.
  const rank = { bad: 0, warn: 1, unknown: 2, ok: 3 };
  const sorted = list.map((x, i) => ({ ...x, i })).sort((x, y) => rank[x.tone] - rank[y.tone] || x.i - y.i);
  const shown = more ? sorted : sorted.slice(0, 1);
  return (
    <section className="iv-signals" aria-labelledby="iv-sig-h">
      <h3 className="sr-only" id="iv-sig-h">Signals</h3>
      <ul className="v3-sigs">
        {shown.map((x) => (
          <li key={x.key} className={`v3-sig is-${x.tone}`} data-part={x.key}>
            <span className="v3-sig-dot" aria-hidden="true" />
            <span className="v3-sig-t">
              <span className="v3-sig-name" title={x.title || undefined}>{x.name}</span>
              {x.note || x.action ? <span className="v3-sig-note">{x.note}{x.note && x.action ? ' · ' : null}{x.action || null}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      {sorted.length > 1 ? <button type="button" className="iv-fold" aria-expanded={more} data-key={`iv-signals-${pid}`} onClick={() => setMore(!more)}>{more ? 'Fewer signals' : `${sorted.length - 1} more signal${sorted.length - 1 === 1 ? '' : 's'}`}</button> : null}
    </section>
  );
}

// Block F: the changes since your last review, one quiet line, only when
// there are some.
function Changes({ p }) {
  const ch = p.changes || {};
  const pid = p.project_id;
  if (!ch.item_count) return null;
  return (
    <p className="iv-changes" title={p.next_review ? `Next review: ${fmtDate(p.next_review.date)}${p.next_review.overdue ? ' (overdue)' : ''}` : undefined}>
      {`${ch.item_count} change${ch.item_count === 1 ? '' : 's'} since ${ch.cursor_source === 'project created' ? 'added' : 'your last review'}`}
      <span aria-hidden="true">{' · '}</span>
      <DeepLink pid={pid} href={`#/project/${enc(pid)}/notes`} dataKey={`what-changed-${pid}`}>What changed</DeepLink>
    </p>
  );
}

// ---- 4. thesis and watch -----------------------------------------------------------------------

function Take({ text, id }) {
  return <p id={id} className="take-text clamp-3" title={text.length > 280 ? text : undefined}>{text}</p>;
}

function Thesis({ p, cr, wait }) {
  const pid = p.project_id;
  const prov = cr.c.provider || 'claude';
  const a = cr.report ? cr.report.assessment || {} : null;
  let body;
  if (cr.c.report && !a && !cr.c.report.needs_text) body = wait;
  else if (a && !a.needs_text) {
    const metric = a.next_metric_to_monitor;
    const ft = falsifiableOf(a);
    body = (
      <>
        {a.final_take ? <Take text={a.final_take} id={`take-${pid}`} /> : <p className="faint">{`No final take in ${PROVIDER_LABELS[prov]}'s data block.`}</p>}
        {ft ? <p className="tl iv-watch" title={ft.test ? `Would disprove it: ${ft.test}` : undefined}><span className="tl-k">Test</span><span className="iv-watch-t">{ft.text}</span></p> : null}
        {metric && metric.metric ? <p className="tl iv-watch"><span className="tl-k">Watch</span><span className="iv-watch-t">{metric.metric}{metric.threshold ? ` (${metric.threshold})` : ''}</span></p> : null}
      </>
    );
  } else body = <p className="faint">No report to draw a thesis from.</p>;
  return (
    <section className="insp-sec thesis iv-thesis" aria-labelledby="insp-sec-thesis">
      <div className="sec-head">
        <h3 className="iv-h" id="insp-sec-thesis">Thesis</h3>
        <DeepLink pid={pid} href={`#/project/${enc(pid)}/brief?model=${prov}`} className="iv-link" dataKey={`iv-brief-${pid}`}>Read full brief<ArrowRight size={13} aria-hidden="true" /></DeepLink>
      </div>
      {body}
    </section>
  );
}

// ---- 5. what needs you -------------------------------------------------------------------------

const PROBLEM_WORDS = { uncertain: 'Check charge', failed: 'Research failed', incomplete: 'Research incomplete', conflict: 'Answer quarantined', interrupted: 'Research paused', held: 'Held by archive' };

function NeedsYou({ d, p, detail }) {
  const { a: agenda } = useAgendaRead();
  const pid = p.project_id;
  const [busy, setBusy] = useState(null);
  const [all, setAll] = useState(false);
  const lines = [];
  const att = (d.index.attention || []).filter((a) => a.project_id === p.project_id);
  const cg = canonicalGrade(p, d.index);
  const quietResearch = Boolean(p.ticket && p.ticket.status) || ((cg.kind === 'grade' || cg.kind === 'range') && typeof cg.sort === 'number' && cg.sort < 40);
  // Research that needs you, per model (a held model is never retried).
  for (const prov of ['claude', 'chatgpt', 'gemini']) {
    const job = p.research && p.research.providers && p.research.providers[prov];
    if (!job) continue;
    const hold = Boolean(onHoldOf(d.index, prov));
    const key = jobKey(job, null, { onHold: hold });
    if (key === 'waiting') {
      // In the autonomous pilot Claude's research is the chain's Agent 1, run
      // by the pilot (the PM Decision Card says where it stands), not by hand.
      if (prov === 'claude' && p.ticket && p.ticket.pilot) continue;
      // A project with a PM ticket (open or decided), or graded under 40, does
      // not nag for any model's manual research (Eric, 2026-10-24).
      if (quietResearch) continue;
      lines.push({ key: `wait-${prov}`, sev: 'medium', kind: 'Waiting for you', text: `${PROVIDER_LABELS[prov]} research is ready when you ask its assistant`, action: <DeepLink pid={pid} href={`#/project/${enc(pid)}/record?open=runs`} className="btn btn-sm" dataKey={`iv-wait-${prov}`}>Open the prompt</DeepLink> });
    } else if (PROBLEM_WORDS[key]) {
      const canRetry = job.state === 'failed' && !hold && job.run_id;
      lines.push({
        key: `job-${prov}`,
        sev: key === 'uncertain' ? 'high' : 'medium',
        kind: PROBLEM_WORDS[key],
        text: `${PROVIDER_LABELS[prov]}${job.error ? `: ${job.error}` : ''}`,
        action: canRetry ? (
          <button type="button" className="btn btn-sm" data-key={`retry-${pid}-${prov}`} disabled={busy === `retry-${prov}`} onClick={async () => {
            setBusy(`retry-${prov}`);
            try {
              const r = await api.post(`/api/projects/${encodeURIComponent(pid)}/research/${encodeURIComponent(job.run_id)}/jobs/${prov}/retry`, {});
              toast(r.message || 'Retry queued');
              await refresh();
            } catch (err) {
              toast(err.message, 'bad');
            } finally {
              setBusy(null);
            }
          }}><RotateCcw size={13} aria-hidden="true" />Retry</button>
        ) : <DeepLink pid={pid} href={`#/project/${enc(pid)}/record?open=runs`} className="btn btn-sm" dataKey={`iv-runs-${prov}`}>Research runs</DeepLink>,
      });
    }
  }
  for (const a of att.filter((x) => ['writes_blocked', 'broken_record', 'import_failed'].includes(x.kind))) lines.push({ key: a.kind, sev: 'high', kind: kindWord(a), text: a.title, action: null });
  // What changed and your reviews due (D3).
  for (const [i, r] of reviewReasons(p, d.index, agendaRowOf(agenda, pid)).entries()) {
    if (r.kind === 'changed') lines.push({ key: 'changed', sev: 'low', kind: 'Review suggested', text: r.words, action: <DeepLink pid={pid} href={`#/project/${enc(pid)}/notes`} className="btn btn-sm" dataKey={`history-${pid}`}>What changed</DeepLink> });
    if (r.kind === 'due') lines.push({ key: `due-${i}`, sev: 'medium', kind: 'Review due', text: r.words, action: r.item ? <DeepLink pid={pid} href={`#/review?p=${enc(pid)}`} className="btn btn-sm" dataKey={`iv-review-${pid}`}>Review</DeepLink> : <DeepLink pid={pid} href={`#/project/${enc(pid)}/notes`} className="btn btn-sm" dataKey={`iv-due-${pid}`}>Your reviews</DeepLink> });
  }
  // A model's suggested review date not on your calendar yet: add it.
  const sug = att.find((a) => a.kind === 'review_suggested');
  if (sug) {
    const pc = ['claude', 'chatgpt', 'gemini'].map((prov) => ({ prov, s: p.providers && p.providers[prov] && p.providers[prov].position })).find((x) => x.s && x.s.next_review_date);
    lines.push({
      key: 'suggested',
      sev: 'low',
      kind: 'Review suggested',
      text: sug.title.replace(`${p.name}: `, ''),
      action: pc ? (
        <button type="button" className="btn btn-sm" data-key={`iv-add-review-${pid}`} disabled={busy === 'add-review'} onClick={async () => {
          setBusy('add-review');
          try {
            const r = await api.post(`/api/scopes/${encodeURIComponent(pid)}/events`, { type: 'review', title: `Review thesis (${PROVIDER_LABELS[pc.prov]} suggested this date)`, due: pc.s.next_review_date, note: pc.s.review_trigger || null, submission_id: submissionId() });
            toast(r && r.status === 'exists' ? 'Already on your reviews' : `Review added for ${fmtDate(pc.s.next_review_date)}`);
            await refresh();
          } catch (err) {
            toast(err.message, 'bad');
          } finally {
            setBusy(null);
          }
        }}>Add to my reviews</button>
      ) : null,
    });
  }
  const differ = att.find((a) => a.kind === 'disagreement');
  if (differ) lines.push({ key: 'differ', sev: 'medium', kind: 'Models differ', text: differ.detail || differ.title, action: <DeepLink pid={pid} href={`#/project/${enc(pid)}/compare`} className="btn btn-sm" dataKey={`iv-compare-${pid}`}>Compare</DeepLink> });
  for (const a of att.filter((x) => ['grade_mismatch', 'extraction', 'needs_text', 'identity_price', 'contract_change', 'alert', 'stale_research', 'fundamentals_binding', 'spread'].includes(x.kind))) {
    lines.push({ key: `${a.kind}-${lines.length}`, sev: a.severity || 'low', kind: kindWord(a), text: a.title.replace(`${p.name}: `, ''), action: a.action ? <a className="btn btn-sm" href={attentionHref(a)} data-key={`iv-att-${a.kind}-${pid}`}>Open</a> : null });
  }
  if (p.identity_status !== 'verified') lines.push({ key: 'identity', sev: 'medium', kind: 'Identity pending', text: (p.identity_unknowns || []).join(' ') || 'The token is not confirmed, so no prices or holdings use it.', action: <DeepLink pid={pid} href={`#/project/${enc(pid)}/contract?open=identity`} className="btn btn-sm" dataKey={`fix-identity-${pid}`}>Complete the identity</DeepLink> });
  if (!lines.length) return null;
  const order = { high: 0, medium: 1, low: 2 };
  const sorted = lines.sort((x, y) => order[x.sev] - order[y.sev]);
  const shown = all ? sorted : sorted.slice(0, 3);
  return (
    <section className="iv-needs" aria-labelledby="iv-needs-h">
      <h3 className="iv-h" id="iv-needs-h">Needs you</h3>
      <ul className="iv-lines">
        {shown.map((l) => (
          <li key={l.key} className={`iv-line sev-${l.sev}`}>
            <span className="iv-line-dot" aria-hidden="true" />
            <span className="iv-line-t"><strong>{l.kind}</strong><span className="iv-line-d" title={l.text}>{` · ${l.text}`}</span></span>
            {l.action}
          </li>
        ))}
      </ul>
      {sorted.length > 3 ? <button type="button" className="btn-link iv-all" aria-expanded={all} data-key={`iv-needs-all-${pid}`} onClick={() => setAll(!all)}>{all ? 'Show fewer' : `${sorted.length - 3} more`}</button> : null}
    </section>
  );
}

// ---- 6. your note --------------------------------------------------------------------------------

function YourNote({ p, detail }) {
  const pid = p.project_id;
  const note = detail && detail.conviction ? String(detail.conviction.text || '').trim() : '';
  return (
    <p className="tl-note iv-note" title={note && detail.conviction.updated_at ? `Your note, saved ${fmtDateTime(detail.conviction.updated_at)}` : undefined}>
      <span className="tl-k">Your note</span>
      {note ? <span className="tl-note-text">{note}</span> : <span className="faint">{detail ? 'None yet' : '…'}</span>}
      <span className="tl-dot" aria-hidden="true">·</span>
      <DeepLink pid={pid} href={`#/project/${enc(pid)}/notes`} dataKey={`note-edit-${pid}`}>{note ? 'Edit' : 'Add a note'}</DeepLink>
    </p>
  );
}

// ---- the body --------------------------------------------------------------------------------

function ReportWait({ p, cr, current, failed }) {
  const who = PROVIDER_LABELS[cr.c.provider || 'claude'];
  if (failed) return <p className="faint mp-wait">{`${who}'s report could not be loaded; the grade above is from the list.`}</p>;
  if (cr.status === 'pending' && current && wasResynced(p.project_id, cr.report_id)) {
    return (
      <div className="note note-warn mp-wait" role="status">
        <span title={cr.report_id || undefined}>{`The list names a report of ${who}'s that this project's record does not hold yet. Nothing from another report is shown in its place.`}</span>
        <button type="button" className="btn btn-sm" data-key={`resync-${p.project_id}`} onClick={() => refresh().catch((err) => toast(err.message, 'bad'))}>Read again</button>
      </div>
    );
  }
  return <Loading label={`${who}'s report`} />;
}

// mode "review": the Review page's centre, the verdict and bull and bear only
// (the model cards above it are the check-in's; the rest is one click away).
export function ModelPanel({ d, p, detail, current = true, failed = false, mode = 'inspector' }) {
  const cr = canonicalReport(p, detail);
  // A current record that does not hold the list's report: read it once more.
  useEffect(() => {
    if (cr.status === 'pending' && current && cr.c.source !== 'headline') resyncOnce(p.project_id, cr.report_id);
  }, [cr.status, current, p.project_id, cr.report_id]);
  const wait = cr.c.report && !cr.report ? <ReportWait p={p} cr={cr} current={current} failed={failed && !detail} /> : null;
  return (
    <div className="mpanel iv" data-report={cr.report_id || ''} data-opinion={cr.status} data-provider={cr.c.provider || 'claude'}>
      {mode === 'review' ? <VerdictCard d={d} p={p} cr={cr} /> : <Cohort d={d} p={p} cr={cr} />}
      <Triggers p={p} cr={cr} wait={wait} />
      {mode === 'review' ? null : (
        <>
          <Signals d={d} p={p} />
          <Changes p={p} />
          <Thesis p={p} cr={cr} wait={wait} />
          <PMDecisionCard p={p} />
          <NeedsYou d={d} p={p} detail={detail} />
          <YourNote p={p} detail={detail} />
        </>
      )}
    </div>
  );
}
