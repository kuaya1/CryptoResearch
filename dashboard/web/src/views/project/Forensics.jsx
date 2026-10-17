// The Forensics tab (#/project/<id>/forensics[?receipt=<id>]): the forensic
// assessment of one project, read from GET /api/projects/<id>/forensics
// (core/forensics.js view, which writes nothing), in this order, the phone's
// first screen first (review F14):
//   1. the plain assessment, its age, the receipt shown, a one-line coverage
//   2. the strongest concern with its qualification (kind, references), then
//      the next useful action, then the strongest counterevidence
//   3. evidence changes to review (forensic-review.js)
//   4. the liquidity, operational, delivery and discontinuation states now
//   5. the resilience timeline from the receipt's frozen origin
//   6. what would worsen or improve the outlook
//   7. findings, grades, sources, observations, the challenge, receipts and
//      the methodology, folded
// then the audit and monitoring actions, each an explicit click. Observed
// facts are drawn apart from scenarios (dashed, labeled conditional); unknown
// is never zero; no probability is shown; grades are never averaged. A kind,
// a grade or a source is shown as the desk's eligibility checks read it
// (cr-forensic-eligibility@1), the report's own value beside it.
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, TriangleAlert, Copy, Play, Upload, ShieldCheck, FileText, Download, History } from 'lucide-react';
import { fmtDate, fmtDateTime, fmtAgo, fmtCompactUsd, fmtPrice, PROVIDER_LABELS, toast, copyText } from '../../../../public/ui.js';
import { desk, api, refresh } from '../../lib/desk.js';
import { useDesk } from '../../lib/hooks.js';
import { hrefWith } from '../../lib/router.js';
import { DiagnosticSegmentBar } from '../../components/ui/DiagnosticSegmentBar.jsx';

const enc = encodeURIComponent;
const EVENT_SHORT = { liquidity_impairment: 'Liquidity', operational_degradation: 'Operations', delivery_inactivity: 'Delivery', confirmed_discontinuation: 'Discontinuation' };
const EVENTS = Object.keys(EVENT_SHORT);
const STATE_WORDS = {
  unknown: 'Unknown',
  not_established: 'Not established',
  within: 'Within limit',
  watch: 'Watch',
  occurred: 'Occurred',
  recovered: 'Recovered',
  reversed: 'Reversed',
};
const DISC_WORDS = { not_established: 'No attributable evidence', occurred: 'Confirmed', reversed: 'Reversed' };
const OUTCOME_WORDS = { occurred: 'Occurred', not_occurred: 'Did not occur', unresolved: 'Unresolved', pending: 'Pending', not_established: 'Not established' };
const KIND_WORDS = { observation: 'Observation', inference: 'Inference', hypothesis: 'Hypothesis' };
const SCEN_WORDS = { deterioration: 'Deterioration', stabilization: 'Stabilization', recovery: 'Recovery', no_new_delivery: 'No new delivery' };
const METRIC_WORDS = { volume: 'Volume', exit_cost: 'Exit cost', delivery: 'Delivery window', reported_liquidity: 'Reported liquidity' };
const COV_WORDS = { covered: 'Covered', partial: 'Partial', unknown: 'Unknown' };
const VERDICT_WORDS = { supported: 'Supported', overstated: 'Overstated', unsupported: 'Unsupported', needs_evidence: 'Needs evidence', not_checked: 'Not checked' };
const JOB_WORDS = { waiting: 'Waiting', running: 'Working', paused: 'Paused', completed: 'Saved', canceled: 'Canceled', blocked: 'Opens after the assessment' };

const AREA_SHORT = { product: 'Product', code: 'Code and releases', controls: 'Controls', allocations: 'Allocations and funding', wallets: 'Wallet flows', liquidity: 'Liquidity and trading', claims: 'Claims against records' };
// The server's sentences carry exact times; they read as dates here.
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z/g;
const DAY_ONLY = /\b\d{4}-\d{2}-\d{2}\b(?!T)/g;
const readable = (s) => (typeof s === 'string' ? s.replace(ISO, (m) => fmtDateTime(m)).replace(DAY_ONLY, (m) => fmtDate(m)) : s);
const pct = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(d)}%` : '—');
const usd = (v) => (typeof v === 'number' && Number.isFinite(v) ? (Math.abs(v) >= 1000 ? fmtCompactUsd(v) : fmtPrice(v)) : '—');
const words = (s) => (s ? s.replace(/_/g, ' ') : '');
const shortHash = (h) => (h ? `${h.slice(0, 10)}…` : null);
const shortAddr = (a) => (a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '');

function openFold(key, anchor = null) {
  const d = document.querySelector(`[data-key="${key}"]`);
  if (!d) return;
  if (d.tagName === 'DETAILS') d.open = true;
  requestAnimationFrame(() => {
    const el = (anchor && document.getElementById(anchor)) || d;
    el.scrollIntoView({ block: anchor ? 'center' : 'start' });
    const f = anchor ? el : d.querySelector('summary') || d;
    if (f && !f.hasAttribute('tabindex') && f.tagName !== 'SUMMARY') f.setAttribute('tabindex', '-1');
    if (f) f.focus({ preventScroll: true });
  });
}

// GET /api/projects/<id>/forensics[?receipt=], read again when a live update
// or a save drops the project's record (desk.projectGen). The last answer is
// kept while a newer one loads, but only for the same project and the same
// receipt: a slow answer for another receipt is never shown (each read is
// cancelled when the choice changes, and an answer is checked against it).
function useForensics(pid, receipt) {
  useDesk();
  const gen = desk.projectGen.get(pid) || 0;
  const [attempt, setAttempt] = useState(0);
  const want = receipt || '';
  const key = `${pid}#${want}#${gen}#${attempt}`;
  const [st, setSt] = useState({ pid: null, want: null, key: null, v: null, error: null });
  useEffect(() => {
    const ctrl = new AbortController();
    api.get(`/api/projects/${enc(pid)}/forensics${want ? `?receipt=${enc(want)}` : ''}`, { signal: ctrl.signal }).then(
      (v) => {
        if (ctrl.signal.aborted) return;
        const shown = v && v.current ? v.current.receipt_id : null;
        if (want && shown !== want) return; // an answer for another receipt is never drawn
        setSt({ pid, want, key, v, error: null });
      },
      (error) => { if (!ctrl.signal.aborted && error.name !== 'AbortError') setSt((s) => ({ pid, want, key, v: s.pid === pid && s.want === want ? s.v : null, error })); },
    );
    return () => ctrl.abort();
  }, [key]);
  const mine = st.pid === pid && st.want === want;
  return { v: mine ? st.v : null, error: mine ? st.error : null, retry: () => setAttempt((a) => a + 1) };
}

const receiptHref = (rid) => hrefWith({ receipt: rid || null });

// ---- small parts --------------------------------------------------------------------

function StateWord({ state, disc = false, title }) {
  const w = (disc ? DISC_WORDS[state] : null) || STATE_WORDS[state] || words(state);
  return <span className={`fx-st is-${state}${disc ? ' is-disc' : ''}`} title={title}>{w}</span>;
}

function SourceChip({ id, idx }) {
  const s = idx && idx[id];
  if (!s) return <span className="fx-src is-missing" title="Not in the source list">{id}</span>;
  return (
    <span className="fx-src">
      {s.url ? <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" title={[s.publisher, s.retrieved_at ? `retrieved ${fmtDateTime(s.retrieved_at)}` : null, s.type].filter(Boolean).join(' · ')} data-key={`fx-src-link-${id}`}>{id}<ArrowUpRight size={11} aria-hidden="true" /></a> : <span>{id}</span>}
      <button type="button" className="fx-src-cap" aria-label={`Show what was captured from ${id}`} title="What was captured: excerpt, time, block or commit, hash" onClick={() => openFold('fx-sources', `fx-src-${id}`)}>captured</button>
    </span>
  );
}

function Sources({ ids, idx }) {
  if (!ids || !ids.length) return <span className="fx-src is-none">No source cited</span>;
  return <span className="fx-srcs">{ids.map((id) => <SourceChip key={id} id={id} idx={idx} />)}</span>;
}

// The kind as the desk reads it; the author's own kind kept beside it when
// it differs (review F03: the headline and the detail say the same).
function KindTag({ f }) {
  const k = f.shown_kind || f.kind;
  const differs = f.original_kind && f.original_kind !== k;
  return (
    <span className={`fx-kind k-${k}`} title={f.kind_note || undefined}>
      {k === 'hypothesis' && f.wallet_relation === 'inferred_common_control' ? 'Hypothesis, unestablished' : KIND_WORDS[k] || k}
      {differs ? <span className="fx-kind-orig">{` · stated as ${KIND_WORDS[f.original_kind] || f.original_kind}`}</span> : null}
    </span>
  );
}

// Whether a finding's references hold (resolved, dated, something preserved
// to re-read). Holding is not verification: the desk reads no meaning.
function Standing({ f }) {
  const e = f && f.eligibility;
  if (!e) return null;
  return e.eligible
    ? <span className="fx-stand is-holds" title="Every cited source exists, is dated and preserved something to re-read. The desk does not check that a source says what the finding says.">References hold</span>
    : <span className="fx-stand is-claim" title={e.reasons.join('; ')}>{`Report claim: ${e.reasons[0] || 'references do not hold'}`}</span>;
}

// One line by default (review F14); the seven areas behind Details.
function Coverage({ c, eligibility }) {
  return (
    <details className="fx-cov" data-key="fx-cov">
      <summary className="fx-cov-sum" title={c.note}>
        <b>{`${c.covered} of ${c.of}`}</b>{` evidence areas covered by findings whose references hold · ${c.partial} partial · ${c.unknown} unknown`}
        <span className="fx-cov-more">Details</span>
      </summary>
      {eligibility && eligibility.report_claims ? <p className="fx-cov-claims">{`${eligibility.report_claims} of ${eligibility.findings} findings are report claims only: their references do not resolve to dated, preserved sources, so they cover nothing.`}</p> : null}
      <ol className="fx-cov-areas" aria-label="Evidence coverage by area">
        {c.areas.map((a) => (
          <li key={a.area} className={`fx-cov-a is-${a.status}`} title={`${a.label}: ${COV_WORDS[a.status]} (declared ${COV_WORDS[a.declared] || a.declared})${a.note ? `. ${a.note}` : ''}`}>
            <span className="fx-cov-mark" aria-hidden="true" />
            <span className="fx-cov-n">{AREA_SHORT[a.area] || a.label}</span>
            <span className="fx-cov-w">{COV_WORDS[a.status]}</span>
          </li>
        ))}
      </ol>
      <p className="faint fx-cov-note">{c.note}</p>
    </details>
  );
}

// ---- 1. the assessment ----------------------------------------------------------------

function Assessment({ v, pid }) {
  const c = v.current;
  if (!c) {
    const open = v.audits.find((a) => a.audit_id === v.open_audit);
    return (
      <section className="fx-card fx-assess" aria-labelledby="fx-title">
        <div className="fx-head"><h2 id="fx-title" className="fx-h">Forensic assessment</h2></div>
        <div className="fx-empty">
          <ShieldCheck size={22} aria-hidden="true" />
          <p className="fx-empty-t">{open ? 'An audit is open; no assessment is saved yet.' : 'No forensic assessment yet.'}</p>
          <p className="faint">{open ? `Audit ${open.audit_id}: the investigator (${PROVIDER_LABELS.claude}) is ${(JOB_WORDS[open.jobs.investigator.state] || open.jobs.investigator.state).toLowerCase()}.` : 'The outcomes below read Unknown until there is evidence.'}</p>
        </div>
      </section>
    );
  }
  const asOf = c.assessment_as_of || c.origin;
  const ageDays = Math.floor(c.age_hours / 24);
  const flags = (c.checks || []).filter((f) => f.level !== 'note');
  return (
    <section className="fx-card fx-assess" aria-labelledby="fx-title">
      <div className="fx-head">
        <h2 id="fx-title" className="fx-h">{c.is_latest ? 'Forensic assessment' : 'Earlier forensic assessment'}</h2>
        <span className="fx-head-sub">{`${PROVIDER_LABELS[c.model.provider] || c.model.provider}${c.model.model_version ? ` (${c.model.model_version})` : ''} · ${c.versions.prompt}`}</span>
      </div>
      {!c.is_latest ? (
        <p className="fx-hist" role="note">
          <History size={14} aria-hidden="true" />
          <span>{`Showing receipt ${c.receipt_id}, saved ${fmtDate(c.saved_at)}: its findings, grades, sources and timeline. The states, exits and monitoring below are current. `}</span>
          <a href={receiptHref(null)} data-key="fx-latest">Show the latest assessment</a>
        </p>
      ) : null}
      <p className="fx-lead">{c.plain_assessment || <span className="faint">The assessment states no plain summary.</span>}</p>
      <p className="fx-meta">
        <span><b>{`Assessed ${fmtDate(asOf)}`}</b>{` · ${ageDays === 0 ? 'today' : ageDays === 1 ? 'yesterday' : `${ageDays} days ago`}`}</span>
        <span className="fx-mono" title="This receipt's ID: the findings, grades and sources shown are its own.">{c.receipt_id}</span>
      </p>
      {/* A consequential warning stays at the top; the rest of the receipt
          details and the coverage follow the concern (review F14). */}
      {flags.length ? (
        <ul className="fx-notes">
          <li className="fx-note is-warn"><TriangleAlert size={14} aria-hidden="true" /><span>{`The desk's checks flag ${flags.length} item${flags.length === 1 ? '' : 's'} in the findings (flags only; nothing is changed). `}<button type="button" className="btn-link" data-key="fx-flags-jump" onClick={() => openFold('fx-findings')}>See the findings</button></span></li>
        </ul>
      ) : null}
    </section>
  );
}

// The receipt's other facts and the evidence coverage, after the concern.
function AssessmentDetails({ v }) {
  const c = v.current;
  if (!c) return null;
  const ch = v.challenge;
  const formatNotes = (c.validation && c.validation.errors) || [];
  return (
    <section className="fx-card fx-assess-more" aria-label="The receipt and its evidence coverage">
      <p className="fx-meta">
        <span title="The timeline's checkpoints are counted from this frozen time and never move.">{c.origin_basis === 'inherited' ? `Timeline origin ${fmtDateTime(c.origin)}, kept from ${c.origin_of || 'the forecast it revises'}` : `Timeline origin ${fmtDateTime(c.origin)}`}</span>
        {c.revision_of ? <span title={c.revision ? c.revision.note : undefined}>{`A revision of ${c.revision_of} (${words(c.revision && c.revision.kind)})${c.evidence_added && c.evidence_added.length ? `, ${c.evidence_added.length} new source${c.evidence_added.length === 1 ? '' : 's'}` : ''}`}</span> : null}
        {c.predecessor ? <span>{`A new audit after ${c.predecessor.receipt_id} (origin ${fmtDate(c.predecessor.origin)})`}</span> : null}
        <span>{ch ? `ChatGPT challenge saved ${fmtDate(ch.saved_at)}` : v.earlier_challenge ? 'ChatGPT challenged an earlier receipt' : 'No ChatGPT challenge'}</span>
      </p>
      <Coverage c={c.coverage} eligibility={c.eligibility} />
      {formatNotes.length || (c.probability && c.probability.status === 'withheld') ? (
        <ul className="fx-notes">
          {formatNotes.length ? <li className="fx-note"><span>{`${formatNotes.length} format note${formatNotes.length === 1 ? '' : 's'} kept with the receipt: ${formatNotes.slice(0, 2).join('; ')}${formatNotes.length > 2 ? '…' : ''}`}</span></li> : null}
          {c.probability && c.probability.status === 'withheld' ? <li className="fx-note"><span>{c.probability.reason}</span></li> : null}
        </ul>
      ) : null}
    </section>
  );
}

// ---- 2. strongest concern, the next action, counterevidence ------------------------------

const LONG_CONCERN = 220;

// The essential part (the statement, its kind, whether its references hold,
// the warning on it and its source) is kept together first; a long statement
// reads as four lines on a phone with an explicit "Show the whole concern".
function KeyFinding({ title, tone, r, idx }) {
  const [full, setFull] = useState(false);
  const f = r && r.finding;
  const supported = f && f.eligibility && f.eligibility.eligible;
  const heading = tone === 'concern' ? (f && !supported ? 'Strongest concern, as the report states it' : title) : title;
  const text = r ? r.statement || (f && f.statement) || '' : '';
  const long = text.length > LONG_CONCERN;
  return (
    <div className={`fx-key is-${tone}`}>
      <div className="fx-key-core">
        <h3 className="fx-key-h">{heading}</h3>
        {!r || (!r.statement && !f) ? <p className="fx-key-none">Not stated in the assessment</p> : (
          <>
            <p className={`fx-key-t${long && !full ? ' is-clamped' : ''}`}>{text}</p>
            {long ? <button type="button" className="btn-link fx-key-whole" aria-expanded={full} data-key={`fx-whole-${tone}`} onClick={() => setFull((x) => !x)}>{full ? 'Show less' : 'Show the whole concern'}</button> : null}
            {f ? (
              <>
                <p className="fx-key-m">
                  <span className="fx-id">{f.finding_id}</span>
                  <KindTag f={f} />
                  <Standing f={f} />
                  <Sources ids={f.source_ids} idx={idx} />
                </p>
                {f.kind_note ? <p className="fx-key-q" role="note"><TriangleAlert size={13} aria-hidden="true" /><span>{f.kind_note}</span></p> : null}
              </>
            ) : <p className="fx-key-m"><span className="fx-src is-missing">{`${r.finding_id || 'No finding'}: not in the findings`}</span></p>}
          </>
        )}
      </div>
      {f && (f.severity || f.confidence) ? <p className="fx-key-m">{f.severity ? <span>{`Severity ${f.severity}`}</span> : null}{f.confidence ? <span>{`Evidence confidence ${f.confidence}`}</span> : null}</p> : null}
      {f && f.alternative_explanation ? <p className="fx-key-alt"><span className="k">Alternative explanation</span>{f.alternative_explanation}</p> : null}
      {f && f.missing_evidence && tone === 'concern' ? <p className="fx-key-alt"><span className="k">Not known yet</span>{f.missing_evidence}</p> : null}
    </div>
  );
}

// The next useful step, in one place: evidence changes waiting for a look,
// and the next evidence the assessment names.
function NextAction({ v }) {
  const q = v.evidence_changes;
  const c = v.current;
  const next = c && c.next_evidence && c.next_evidence[0];
  if (!(q && q.to_review) && !next) return null;
  return (
    <section className="fx-card fx-next" aria-labelledby="fx-next-h">
      <h2 id="fx-next-h" className="fx-next-h">Next</h2>
      <ul className="fx-next-list">
        {q && q.to_review ? <li><button type="button" className="btn-link" data-key="fx-next-queue" onClick={() => openFold('fx-queue', 'fx-queue-h')}>{`Review ${q.to_review} evidence change${q.to_review === 1 ? '' : 's'}`}</button>{q.unavailable ? <span className="faint">{` · ${q.unavailable} target${q.unavailable === 1 ? '' : 's'} not readable now`}</span> : null}</li> : null}
        {next ? <li><b>{next.evidence}</b>{next.how_to_get ? <span className="faint">{` · ${next.how_to_get}`}</span> : null}</li> : null}
      </ul>
    </section>
  );
}

// ---- 3. the states now ----------------------------------------------------------------------

function StateTile({ id, s }) {
  const disc = id === 'confirmed_discontinuation';
  const def = s.definition || {};
  return (
    <div className={`fx-tile is-${s.state}`}>
      <div className="fx-tile-top">
        <h3 className="fx-tile-h" title={def.definition}>{def.label || EVENT_SHORT[id]}</h3>
        <StateWord state={s.state} disc={disc} title={def.definition} />
      </div>
      <p className="fx-tile-why">{readable(s.why)}</p>
      {id === 'liquidity_impairment' && s.recent && s.recent.length && s.recent[s.recent.length - 1].note ? <p className="fx-tile-why">{readable(s.recent[s.recent.length - 1].note)}</p> : null}
      {disc && s.not_counted && s.not_counted.length ? <p className="fx-tile-why">{`Not counted: ${s.not_counted.slice(0, 2).map((x) => `${x.finding_id} (${x.why_not})`).join('; ')}${s.not_counted.length > 2 ? '…' : ''}`}</p> : null}
      <p className="fx-tile-m">
        {s.latest_at ? <span>{`Latest reading ${fmtAgo(s.latest_at)}`}</span> : null}
        {def.freshness_hours ? <span>{`Fresh for ${def.freshness_hours >= 48 ? `${Math.round(def.freshness_hours / 24)} days` : `${def.freshness_hours} h`}`}</span> : null}
        {id === 'liquidity_impairment' ? <span>{`$${s.position_usd} exit, your ${s.limit_pct}% limit`}</span> : null}
        {id === 'delivery_inactivity' ? <span>{`Your ${s.window_days}-day window${s.latest_delivery_at ? ` · last delivery ${fmtDate(s.latest_delivery_at)}` : ''}`}</span> : null}
        {id === 'operational_degradation' && s.checks ? <span>{`${s.checks.length} check${s.checks.length === 1 ? '' : 's'}`}</span> : null}
      </p>
    </div>
  );
}

// A cost as the estimate states it: complete, or "at least" with what is
// unknown (review F09; said in the cell, never only in a tooltip).
function CostCell({ b }) {
  if (b.cost_complete === false) return <><span className="fx-cost-lb">{`at least ${pct(b.cost_pct)}`}</span><span className="fx-cost-miss">{`${(b.missing_costs || []).join(' and ')} unknown`}</span></>;
  return pct(b.cost_pct);
}

const methodWords = (b) => (b.method === 'executable_quote' ? `${b.route_scope === 'aggregator' ? 'Aggregator' : 'Venue'} quote` : 'Calculated from one pool\'s reserves');

function ExitTable({ exits, oneWay }) {
  return (
    <div className="fx-exits" role="table" aria-label="Hypothetical exit estimates">
      <div className="fx-exit fx-exit-head" role="row">
        <span role="columnheader">Exit</span><span role="columnheader">Receives</span><span role="columnheader">Cost</span><span role="columnheader">Basis</span>
      </div>
      {exits.map((x) => {
        const b = x.best;
        const others = (x.routes || []).filter((r) => !b || r.obs_id !== b.obs_id || r.retrieved_at !== b.retrieved_at);
        return (
          <div key={x.size_usd} className={`fx-exit is-${x.status}`} role="row">
            <span role="cell" className="fx-exit-size">{`$${x.size_usd.toLocaleString('en-US')}`}</span>
            <span role="cell">{b ? usd(b.received_usd) : <span className="faint">—</span>}</span>
            <span role="cell" className="fx-exit-cost">{b ? <CostCell b={b} /> : <span className="faint">{x.status === 'no_route' ? 'No route' : x.status === 'stale' ? 'Stale' : 'Unknown'}</span>}</span>
            <span role="cell" className="fx-exit-basis">
              {b ? (
                <>
                  <span>{methodWords(b)}{b.venue ? ` · ${b.venue}` : ''}{b.chain ? ` · ${b.chain}` : ''}{b.captured_by === 'monitor' ? ' · monitor' : ' · captured in an audit'}</span>
                  <span className="faint">{[b.retrieved_at ? `${fmtDateTime(b.retrieved_at)} (${fmtAgo(b.retrieved_at)})` : null, b.basis && b.basis.amount_in ? `sells ${b.basis.amount_in} base units at $${b.basis.price_usd}` : null, b.route ? `route ${b.route}` : null, b.source_id, x.earlier ? `${x.earlier} earlier reading${x.earlier === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')}</span>
                  {b.included_costs && b.included_costs.length ? <span className="faint">{`Included: ${b.included_costs.join('; ')}`}</span> : null}
                  {(b.limitations || []).map((l, i) => <span key={i} className={i === 0 && b.cost_complete === false ? 'fx-exit-warn' : 'faint'}>{l}</span>)}
                  {others.length ? <span className="faint">{`Other current routes: ${others.map((r) => `${r.venue || methodWords(r)} ${r.status === 'no_route' ? 'no route' : r.status === 'estimated' ? `${r.cost_complete === false ? 'at least ' : ''}${pct(r.cost_pct)}` : words(r.status)} (${fmtDateTime(r.retrieved_at)}${r.stale ? ', stale' : ''})`).join('; ')}`}</span> : null}
                </>
              ) : <span className="faint">{x.status === 'no_route' && x.as_of ? `${x.note} ${fmtDateTime(x.as_of)}.` : x.note}</span>}
            </span>
          </div>
        );
      })}
      {oneWay ? <p className="fx-exit-foot faint" role="note">{oneWay}</p> : null}
    </div>
  );
}

function States({ v }) {
  const s = v.states;
  const L = v.liquidity;
  const vol = L.observed_volume;
  return (
    <section className="fx-card" aria-labelledby="fx-states-h">
      <div className="fx-head"><h2 id="fx-states-h" className="fx-h">Current states</h2><span className="fx-head-sub">Four outcomes, kept apart; they can overlap</span></div>
      <div className="fx-tiles">
        {EVENTS.map((e) => <StateTile key={e} id={e} s={s[e === 'liquidity_impairment' ? 'liquidity' : e === 'operational_degradation' ? 'operational' : e === 'delivery_inactivity' ? 'delivery' : 'discontinuation']} />)}
      </div>
      <h3 className="fx-h3" title={L.categories.execution_estimates}>Hypothetical exits <span className="fx-h3-sub">Estimates, never transactions</span></h3>
      <ExitTable exits={L.exits} oneWay={[L.one_way, L.completeness].filter(Boolean).join(' ')} />
      <div className="fx-liq">
        <div className="fx-liq-c">
          <h4 className="fx-h4" title={L.categories.reported_reserves}>Reported reserves</h4>
          {L.reported_reserves.length ? (
            <ul className="fx-list">{L.reported_reserves.map((r) => <li key={`${r.receipt_id}-${r.obs_id}`}><b>{usd(r.reported_liquidity_usd)}</b>{` · ${[r.venue, r.pool, r.chain].filter(Boolean).join(' · ')} · ${words(r.mechanism)}`}<span className="faint">{` · ${fmtDate(r.retrieved_at)}`}</span></li>)}</ul>
          ) : <p className="none">None captured</p>}
        </div>
        <div className="fx-liq-c">
          <h4 className="fx-h4" title={L.categories.observed_volume}>Observed volume</h4>
          {vol.latest ? <p><b>{fmtCompactUsd(vol.latest.value)}</b>{` 24-hour volume · ${fmtDate(vol.latest.day)}`}<span className="faint">{` · ${vol.days.length} days on record (CoinGecko)`}</span></p> : <p className="none">No volume on record</p>}
        </div>
        <div className="fx-liq-c">
          <h4 className="fx-h4" title={L.categories.suspected_artificial}>Suspected artificial activity</h4>
          {L.suspected_artificial.length ? <ul className="fx-list">{L.suspected_artificial.map((f) => <li key={f.finding_id}>{`${f.finding_id}: ${f.statement}`}{f.method_stated ? null : <span className="fx-flag"> No method stated</span>}</li>)}</ul> : <p className="none">None stated with a method</p>}
        </div>
      </div>
      {s.operational.checks && s.operational.checks.length ? (
        <>
          <h3 className="fx-h3">Product checks</h3>
          <ul className="fx-checks">
            {s.operational.checks.map((c) => (
              <li key={c.key} className="fx-check">
                <span className="fx-check-n">{c.label}<span className="faint">{c.source === 'audit' ? ' · captured in an audit' : ' · monitored'}</span></span>
                <StateWord state={c.state} title={readable(c.why)} />
                <span className="fx-check-r" aria-label="Recent readings">{(c.recent || []).map((r, i) => <span key={i} className={`fx-dot ${r.beyond === true ? 'is-fail' : r.beyond === false ? 'is-pass' : 'is-none'}`} title={`${fmtDateTime(r.at)}: ${r.beyond === true ? 'failed' : r.beyond === false ? 'passed' : 'said nothing'}`} />)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

// ---- 4. the timeline ----------------------------------------------------------------------

function Outcome({ o, past }) {
  if (!o) return <span className="fx-out is-pending">Pending</span>;
  const w = o.outcome === 'pending' && past ? 'Awaiting readings' : OUTCOME_WORDS[o.outcome] || words(o.outcome);
  const tip = [readable(o.reason), o.recorded ? `Recorded under ${o.method}` : 'Read now, not yet recorded', o.corrects ? `corrects ${o.corrects}${o.previous_method ? ` (recorded under ${o.previous_method})` : ''}` : null].filter(Boolean).join(' · ');
  return (
    <span className="fx-out-w">
      <span className={`fx-out is-${o.outcome}`} title={tip}>{w}</span>
      {o.differs_now ? <span className="fx-out-diff" title={readable(o.differs_now.reason) || undefined}>{`${o.differs_now.method} reads ${(OUTCOME_WORDS[o.differs_now.outcome] || words(o.differs_now.outcome)).toLowerCase()}`}</span> : null}
    </span>
  );
}

function Checkpoint({ c }) {
  const past = c.status === 'past';
  return (
    <li className={`fx-cp is-${c.status}`}>
      <div className="fx-cp-top">
        <span className="fx-cp-l">{c.label}</span>
        <span className="fx-cp-d">{fmtDate(c.at)}</span>
      </div>
      <dl className="fx-cp-obs" aria-label={`Observed by ${c.label}`}>
        {EVENTS.map((e) => (
          <div key={e}>
            <dt>{EVENT_SHORT[e]}</dt>
            <dd>{past || (c.observed[e] && c.observed[e].outcome !== 'pending') ? <Outcome o={c.observed[e]} past={past} /> : <span className="fx-out is-pending">Upcoming</span>}</dd>
          </div>
        ))}
      </dl>
      {c.conditional.length ? (
        <ul className="fx-cp-cond" aria-label="Conditional threshold estimates in this window">
          {c.conditional.map((x, i) => <li key={i}><span className="fx-cond-k">{`${SCEN_WORDS[x.scenario] || x.scenario} · ${METRIC_WORDS[x.metric] || x.metric}`}</span>{` ${readable(x.words)}`}</li>)}
        </ul>
      ) : null}
      {c.watch.length ? (
        <ul className="fx-cp-watch" aria-label="What to watch by this checkpoint">
          {c.watch.map((w, i) => <li key={i}><b>{w.signal}</b>{w.worsens_if ? ` · worse if ${w.worsens_if}` : ''}{w.improves_if ? ` · better if ${w.improves_if}` : ''}</li>)}
        </ul>
      ) : null}
    </li>
  );
}

function ScenarioBlock({ title, s }) {
  if (!s) return null;
  if (s.status === 'no_threshold') return <div className="fx-scn"><h4 className="fx-h4">{title}</h4><p className="none">{s.words}</p></div>;
  if (s.status === 'insufficient') return <div className="fx-scn"><h4 className="fx-h4">{title}</h4><p className="fx-insuff">{readable(s.words)}</p>{s.next_observation ? <p className="faint">{`Next useful observation: ${readable(s.next_observation)}`}</p> : null}</div>;
  if (s.status === 'estimated' && !s.scenarios) return <div className="fx-scn"><h4 className="fx-h4">{title}</h4><p className="fx-cond-line">{readable(s.words)}</p><p className="faint">{`Assumption: ${s.assumption}`}</p></div>;
  const b = s.basis || {};
  const fmtV = (x) => (s.unit === 'pct' ? pct(x) : usd(x));
  return (
    <div className="fx-scn">
      <h4 className="fx-h4">{title}</h4>
      <p className="faint">{`Level ${fmtV(s.threshold)} · latest ${fmtV(s.latest.value)} (${fmtDate(s.latest.day)}) · window ${fmtDate(b.window_from)} to ${fmtDate(b.window_to)}, ${b.points} days, ${b.weekly_changes} weekly changes · data ${Math.round(b.data_age_hours || 0)} h old`}</p>
      {s.projection === 'unavailable_at_zero' ? <p className="fx-scn-zero" role="note">{`The latest reading is zero. ${s.beyond_now ? 'It is past the level now. ' : ''}No date is projected from a zero.`}</p> : null}
      {b.rates_note ? <p className="faint">{b.rates_note}</p> : null}
      {s.cost_note ? <p className="faint">{s.cost_note}</p> : null}
      <ul className="fx-scn-list">
        {s.scenarios.map((x) => (
          <li key={x.kind} className={`fx-scn-r is-${x.kind}`}>
            <span className="fx-scn-k">{SCEN_WORDS[x.kind]}</span>
            <span className="fx-scn-a">{typeof x.rate_pct_per_week === 'number' ? `${x.assumption} (${x.rate_pct_per_week > 0 ? '+' : ''}${x.rate_pct_per_week}% a week)` : x.assumption}</span>
            <span className="fx-scn-w">{readable(x.words)}</span>
          </li>
        ))}
      </ul>
      <p className="faint fx-inval">{s.invalidation}</p>
    </div>
  );
}

function Timeline({ v }) {
  const t = v.timeline;
  const sc = v.scenarios;
  return (
    <section className="fx-card" aria-labelledby="fx-tl-h">
      <div className="fx-head">
        <h2 id="fx-tl-h" className="fx-h">Resilience timeline</h2>
        <span className="fx-head-sub">{t ? `From the frozen origin, ${fmtDateTime(t.origin)}` : 'Starts when an assessment is saved'}</span>
      </div>
      <p className="fx-legend"><span className="fx-leg is-obs">Observed outcome</span><span className="fx-leg is-cond">{t ? t.label : 'Conditional threshold estimate—not a calibrated probability.'}</span><span className="faint" title={v.definitions.probability.requirements.join(' ')}>No probability is shown: no calibrated method exists yet.</span></p>
      {t ? <ol className="fx-cps">{t.checkpoints.map((c) => <Checkpoint key={c.id} c={c} />)}</ol> : <p className="none">No timeline without a saved assessment: its checkpoints are counted from the assessment date.</p>}
      <div className="fx-scns">
        <ScenarioBlock title="Volume against your review level" s={sc.volume} />
        <ScenarioBlock title="Exit cost against your limit" s={sc.exit_cost} />
        {sc.reported_liquidity ? <ScenarioBlock title="Reported liquidity against your review level" s={sc.reported_liquidity} /> : null}
        <ScenarioBlock title="Delivery window" s={sc.delivery} />
        <div className="fx-scn"><h4 className="fx-h4">Not projected</h4><ul className="fx-list">{Object.entries(sc.not_projected).map(([k, w]) => <li key={k}><b>{EVENT_SHORT[k]}:</b>{` ${w}`}</li>)}</ul></div>
      </div>
    </section>
  );
}

// ---- 5. conditions -------------------------------------------------------------------------

function Conditions({ v }) {
  const c = v.current;
  const worse = c ? c.conditions.worsen : [];
  const better = c ? c.conditions.improve : [];
  return (
    <section className="fx-card" aria-labelledby="fx-cond-h">
      <div className="fx-head"><h2 id="fx-cond-h" className="fx-h">What would change the outlook</h2></div>
      <div className="fx-two">
        <div className="fx-cond is-worse">
          <h3 className="fx-h3">Worsens it</h3>
          {worse.length ? <ul className="fx-list">{worse.map((w, i) => <li key={i}>{w}</li>)}</ul> : <p className="none">None stated in the assessment</p>}
          <h4 className="fx-h4">The desk watches for</h4>
          <ul className="fx-list faint">{v.desk_triggers.worsen.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
        <div className="fx-cond is-better">
          <h3 className="fx-h3">Improves it</h3>
          {better.length ? <ul className="fx-list">{better.map((w, i) => <li key={i}>{w}</li>)}</ul> : <p className="none">None stated in the assessment</p>}
          <h4 className="fx-h4">The desk watches for</h4>
          <ul className="fx-list faint">{v.desk_triggers.improve.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      </div>
      {c && c.next_evidence.length ? (
        <>
          <h3 className="fx-h3">The next evidence that would change it</h3>
          <ul className="fx-list">{c.next_evidence.map((n, i) => <li key={i}><b>{n.evidence}</b>{n.would_change ? ` · would change ${n.would_change}` : ''}{n.how_to_get ? <span className="faint">{` · ${n.how_to_get}`}</span> : null}</li>)}</ul>
        </>
      ) : null}
      {c && c.scenarios.length ? (
        <>
          <h3 className="fx-h3">The investigator's scenarios</h3>
          <ul className="fx-iscn">
            {c.scenarios.map((s) => (
              <li key={s.scenario} className={`fx-iscn-r is-${s.scenario}`}>
                <b>{SCEN_WORDS[s.scenario]}</b>
                <span>{s.assumptions || <span className="faint">No assumption stated</span>}</span>
                {s.warning_signs.length ? <span className="faint">{`Warning signs: ${s.warning_signs.join('; ')}`}</span> : null}
                {s.would_invalidate ? <span className="faint">{`Invalidated by: ${s.would_invalidate}`}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

// ---- 6. the folded detail ----------------------------------------------------------------

function Findings({ c }) {
  return (
    <ul className="fx-findings">
      {c.findings.map((f) => (
        <li key={f.finding_id} className="fx-f" id={`fx-f-${f.finding_id}`}>
          <p className="fx-f-top"><span className="fx-id">{f.finding_id}</span><KindTag f={f} /><Standing f={f} />{f.area ? <span className="fx-area">{words(f.area)}</span> : null}{f.severity ? <span>{`Severity ${f.severity}`}</span> : null}{f.confidence ? <span>{`Confidence ${f.confidence}`}</span> : null}{f.wallet_relation ? <span className="fx-area">{words(f.wallet_relation)}</span> : null}</p>
          <p className="fx-f-t">{f.statement}</p>
          {f.kind_note ? <p className="fx-key-q" role="note"><TriangleAlert size={13} aria-hidden="true" /><span>{f.kind_note}</span></p> : null}
          <dl className="fx-f-dl">
            <div><dt>Sources</dt><dd><Sources ids={f.source_ids} idx={c.source_index} /></dd></div>
            {f.event_time || f.retrieved_at ? <div><dt>Times</dt><dd>{[f.event_time ? `event ${fmtDateTime(f.event_time)}` : null, f.retrieved_at ? `retrieved ${fmtDateTime(f.retrieved_at)}` : null].filter(Boolean).join(' · ')}</dd></div> : null}
            {f.block_or_commit ? <div><dt>Block or commit</dt><dd className="fx-mono">{f.block_or_commit}</dd></div> : null}
            {f.alternative_explanation ? <div><dt>Alternative</dt><dd>{f.alternative_explanation}</dd></div> : null}
            {f.missing_evidence ? <div><dt>Missing</dt><dd>{f.missing_evidence}</dd></div> : null}
            {f.would_confirm ? <div><dt>Would confirm</dt><dd>{f.would_confirm}</dd></div> : null}
            {f.would_overturn ? <div><dt>Would overturn</dt><dd>{f.would_overturn}</dd></div> : null}
            {f.basis && f.basis.length ? <div><dt>Basis</dt><dd>{f.basis.map(words).join(', ')}</dd></div> : null}
          </dl>
          {f.flags.length ? <ul className="fx-flags">{f.flags.map((x) => <li key={x.code} className={`fx-flag-r is-${x.level}`}><TriangleAlert size={13} aria-hidden="true" />{x.words}</li>)}</ul> : null}
        </li>
      ))}
    </ul>
  );
}

function Grades({ c, rubric }) {
  return (
    <div className="fx-grades">
      <p className="faint">{`${rubric.version}. ${rubric.rule}`}</p>
      <ul className="fx-grade-list">
        {rubric.categories.map(([id, name, def]) => {
          const g = c.category_grades[id];
          const scored = g && g.status === 'scored';
          // The report's grade is kept as saved; the desk uses it only when
          // the findings it rests on have references that hold.
          const used = scored && (!g.desk || g.desk.usable);
          const label = used ? `${g.score}, confidence ${g.confidence}` : scored ? `the report says ${g.score}; not used by the desk: ${g.desk.reason}` : 'unknown';
          return (
            <li key={id} aria-label={`${name}: ${label}`} title={`${def}${g && g.reason ? ` ${g.reason}` : ''}`}>
              <DiagnosticSegmentBar label={name} title={def} score={used ? { status: 'scored', value: g.score } : null} value={used ? String(g.score) : scored ? 'Withheld' : 'Unknown'} known={used} confidence={used ? { letter: g.confidence[0].toUpperCase(), title: `Confidence ${g.confidence}` } : null} />
              {scored && !used ? <p className="fx-grade-why fx-grade-held">{`The report's grade ${g.score} (${g.confidence}) is not used: ${g.desk.reason}.`}</p> : null}
              {g && g.reason ? <p className="fx-grade-why">{g.reason}{g.finding_ids && g.finding_ids.length ? <span className="faint">{` · ${g.finding_ids.join(', ')}`}</span> : null}</p> : null}
            </li>
          );
        })}
      </ul>
      <p className="faint">Integrity grades are diagnostics: not an investment grade, never averaged, and not a probability.</p>
    </div>
  );
}

const CAPTURE_WORDS = { excerpt: 'excerpt kept', hash: 'content hash kept', chain_reference: 'chain reference', commit_reference: 'commit reference', none: 'nothing kept to re-read' };
const ATTRIB_WORDS = { official_domain: 'on the project\'s own site', chain_reference: 'a chain record', repository: 'a code repository', not_established: 'not tied to the project' };

// What the desk could check about one source: never "verified".
function SourceCheck({ k }) {
  if (!k) return null;
  return (
    <p className={`fx-src-check ${k.usable ? 'is-ok' : 'is-no'}`}>
      <span>{k.usable ? 'Usable as evidence' : 'Not usable as evidence'}</span>
      <span className="faint">{[CAPTURE_WORDS[k.capture], k.dated ? 'dated' : 'undated', ATTRIB_WORDS[k.attribution]].filter(Boolean).join(' · ')}</span>
      {k.self_labelled_primary ? <span className="fx-flag">Labelled primary by the report; the label alone does not establish authority</span> : null}
      {!k.usable && k.reasons.length ? <span className="faint">{k.reasons.join('; ')}</span> : null}
    </p>
  );
}

function SourceList({ c, prefix = 'fx-src' }) {
  return (
    <ul className="fx-sources">
      {c.sources.map((s) => (
        <li key={s.source_id} id={`${prefix}-${s.source_id}`} tabIndex={-1} className="fx-source">
          <p className="fx-f-top"><span className="fx-id">{s.source_id}</span><span className="fx-area">{`${words(s.type)} (as the report labels it)`}</span>{s.publisher ? <span>{s.publisher}</span> : null}</p>
          <SourceCheck k={s.check} />
          {s.url ? <p><a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="wrap-anywhere">{s.url}<ArrowUpRight size={12} aria-hidden="true" /></a></p> : <p className="faint">{s.url_given ? `Address not opened by the desk: ${s.url_given}` : 'No address given'}</p>}
          <p className="faint">{[s.retrieved_at ? `Retrieved ${fmtDateTime(s.retrieved_at)}` : 'Retrieval time not stated', s.event_time ? `event ${fmtDateTime(s.event_time)}` : null, s.block_or_commit ? `at ${s.block_or_commit}` : null, s.tx_signature ? `tx ${s.tx_signature}` : null].filter(Boolean).join(' · ')}</p>
          {s.excerpt ? <blockquote className="fx-excerpt">{s.excerpt}</blockquote> : null}
          {s.content_sha256 ? <p className="faint fx-mono" title="A hash shows the captured content has not changed; it does not show that it is true.">{`SHA-256 ${s.content_sha256}`}</p> : null}
        </li>
      ))}
    </ul>
  );
}

// One exit quote in words: the size, what it would receive and its cost, or
// why it is no reading.
const QUOTE_WORDS = { no_route: 'no route', not_covered: 'token not listed by the quote source (no reading)', error: 'no answer (no reading)', not_quoted: 'not asked' };
function quoteLine(o) {
  const head = `${o.provider_label || 'Quote'}${o.chain ? ` on ${o.chain}` : ''}${o.size_usd ? `, sell $${o.size_usd.toLocaleString('en-US')}` : ''}`;
  if (o.outcome === 'quoted') return `${head}: receives ${usd(o.received_usd)}${typeof o.cost_pct === 'number' ? `, cost ${pct(o.cost_pct)}` : ''}`;
  return `${head}: ${QUOTE_WORDS[o.outcome] || words(o.outcome)}`;
}

function Observations({ v }) {
  const list = v.monitoring.recent;
  if (!list.length) return <p className="none">No monitor observation on record. Monitoring is off until you turn it on.</p>;
  return (
    <ul className="fx-obs">
      {list.map((o) => (
        <li key={o.obs_id} id={`fx-obs-${o.obs_id}`} tabIndex={-1}>
          <span className="fx-mono faint">{o.obs_id}</span>
          <span>{fmtDateTime(o.observed_at)}</span>
          <span>{o.kind === 'product_check' ? `${o.label || o.url}: ${o.outcome}${o.http_status ? ` (${o.http_status})` : ''}` : o.kind === 'executable_quote' ? quoteLine(o) : `${o.repository}: ${o.outcome}${o.latest_delivery_at ? `, last delivery ${fmtDate(o.latest_delivery_at)}` : ''}`}</span>
          {o.kind === 'executable_quote' && o.route ? <span className="faint">{`route ${o.route}`}</span> : null}
          {o.error ? <span className="faint">{o.error}</span> : null}
          {o.excerpt ? <blockquote className="fx-excerpt">{o.excerpt}</blockquote> : null}
          <span className="faint fx-mono" title="This observation's own SHA-256, written when it was recorded">{`SHA-256 ${shortHash(o.sha256)}`}</span>
        </li>
      ))}
    </ul>
  );
}

function Challenge({ v }) {
  const ch = v.challenge;
  if (!ch) return <p className="none">{v.earlier_challenge ? `ChatGPT challenged an earlier receipt (${v.earlier_challenge.challenges_receipt_id}).` : 'No ChatGPT challenge. Claude-only assessments are complete without one.'}</p>;
  const counts = {};
  for (const r of ch.finding_reviews) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  // The challenger's own sources, by receipt-qualified ID (review F13).
  const idx = Object.fromEntries((ch.sources || []).map((s) => [s.source_id, s]));
  const XChip = ({ id }) => (idx[id]
    ? <button type="button" className="fx-src fx-src-btn" data-key={`fx-xsrc-${id}`} title={`${ch.receipt_id} · ${id}: ${[idx[id].publisher, idx[id].retrieved_at ? `retrieved ${fmtDateTime(idx[id].retrieved_at)}` : null].filter(Boolean).join(' · ')}`} onClick={() => openFold('fx-challenge', `fx-xsrc-${id}`)}>{`${id}`}<span className="faint">{' · challenge'}</span></button>
    : <span className="fx-src is-missing" title="Not in the challenge's source list">{id}</span>);
  return (
    <div className="fx-chal">
      <p className="faint">{`${ch.receipt_id} · saved ${fmtDateTime(ch.saved_at)} · challenges ${ch.challenges_receipt_id}. Kept apart; it changes nothing in the assessment.`}</p>
      {ch.overall ? <p className="fx-lead-s">{ch.overall}</p> : null}
      <p className="fx-verdicts">{Object.entries(counts).map(([k, n]) => <span key={k} className={`fx-vd is-${k}`}>{`${VERDICT_WORDS[k] || k} ${n}`}</span>)}</p>
      <ul className="fx-list">
        {ch.finding_reviews.map((r, i) => <li key={i}><b>{`${r.finding_id}: ${VERDICT_WORDS[r.verdict] || r.verdict}`}</b>{[r.attribution_check, r.calculation_check, r.benign_explanation, r.omitted_evidence].filter(Boolean).map((t, j) => <span key={j} className="faint">{` · ${t}`}</span>)}{r.source_ids && r.source_ids.length ? <span className="fx-srcs">{' '}{r.source_ids.map((id) => <XChip key={id} id={id} />)}</span> : null}</li>)}
      </ul>
      {ch.calculation_checks && ch.calculation_checks.length ? <><h4 className="fx-h4">Calculation checks</h4><ul className="fx-list">{ch.calculation_checks.map((x, i) => <li key={i}><b>{`${x.subject}: ${x.result === 'agrees' ? 'agrees' : x.result === 'disagrees' ? 'disagrees' : 'cannot check'}`}</b>{x.detail ? <span className="faint">{` · ${x.detail}`}</span> : null}</li>)}</ul></> : null}
      {ch.omitted_evidence.length ? <><h4 className="fx-h4">Omitted evidence</h4><ul className="fx-list">{ch.omitted_evidence.map((o, i) => <li key={i}>{o.evidence}{o.why_it_matters ? <span className="faint">{` · ${o.why_it_matters}`}</span> : null}{o.source_id ? <> <XChip id={o.source_id} /></> : null}</li>)}</ul></> : null}
      {ch.benign_explanations.length ? <><h4 className="fx-h4">Benign explanations</h4><ul className="fx-list">{ch.benign_explanations.map((o, i) => <li key={i}>{`${o.for_finding_id ? `${o.for_finding_id}: ` : ''}${o.explanation}`}<span className="faint">{` · plausibility ${o.plausibility}`}</span></li>)}</ul></> : null}
      {ch.sources && ch.sources.length ? <><h4 className="fx-h4">{`The challenge's sources (${ch.receipt_id})`}</h4><SourceList c={ch} prefix="fx-xsrc" /></> : null}
      <p><TextButton pid={v.project_id} rid={ch.receipt_id} sha={ch.text_sha256} label="The challenge's full text as saved" /></p>
    </div>
  );
}

// What the desk projected when a receipt was saved, in one line per measure.
function atOrigin(s) {
  const one = (name, x) => {
    if (!x) return null;
    if (x.status === 'estimated' && x.scenarios) {
      const d = x.scenarios.find((y) => y.kind === 'deterioration');
      return `${name}: ${d && d.crosses_at ? `deterioration crosses the level around ${fmtDate(d.crosses_at)}` : 'no crossing under deterioration'}`;
    }
    if (x.status === 'estimated') return `${name}: ${readable(x.words)}`;
    return `${name}: ${x.status === 'insufficient' ? 'insufficient history' : 'no level set'}`;
  };
  return [one('volume', s.volume), one('exit cost', s.exit_cost), one('delivery', s.delivery)].filter(Boolean).join('; ');
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// The original text of a receipt, read through the signed-in client (no
// token in any address), shown here with its pin checked twice: by the
// server against the receipt, and here against the SHA-256 the list shows.
// The download is made from the same bytes. Review F12.
function TextViewer({ pid, rid, sha, onClose }) {
  const ref = useRef(null);
  const [st, setSt] = useState({ state: 'loading' });
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    const ctrl = new AbortController();
    api.get(`/api/projects/${enc(pid)}/forensics/receipts/${enc(rid)}/text`, { signal: ctrl.signal }).then(
      async (r) => {
        if (ctrl.signal.aborted) return;
        if (!r || r.receipt_id !== rid || typeof r.text !== 'string') return setSt({ state: 'error', message: 'The answer was not this receipt\'s text.' });
        const got = await sha256Hex(r.text);
        if (ctrl.signal.aborted) return;
        if (got !== r.sha256 || (sha && got !== sha)) return setSt({ state: 'error', message: `The text read does not match the receipt's SHA-256 (${(sha || r.sha256).slice(0, 12)}…); it is not shown.` });
        setSt({ state: 'ok', r, got });
      },
      (err) => { if (!ctrl.signal.aborted && err.name !== 'AbortError') setSt({ state: 'error', message: err.status === 401 ? 'Your session has ended. Sign in again to read the original.' : err.message }); },
    );
    return () => { ctrl.abort(); if (d && d.open) d.close(); };
  }, [pid, rid]);
  return (
    <dialog ref={ref} className="fx-dialog fx-viewer" aria-labelledby="fx-viewer-h" onClose={onClose}>
      <div className="fx-dialog-head"><h2 id="fx-viewer-h" className="fx-h">{`The full text as saved · ${rid}`}</h2></div>
      <div className="fx-dialog-body">
        {st.state === 'loading' ? <p role="status">Reading the saved text…</p> : null}
        {st.state === 'error' ? <p className="fx-error" role="alert">{st.message}</p> : null}
        {st.state === 'ok' ? (
          <>
            <p className="faint">{`${PROVIDER_LABELS[st.r.model && st.r.model.provider] || ''} · saved ${fmtDateTime(st.r.saved_at)} · ${st.r.chars.toLocaleString('en-US')} characters · SHA-256 ${st.got} (matches the receipt; the JSON block matches too)`}</p>
            <pre className="fx-viewer-text" tabIndex={0}>{st.r.text}</pre>
          </>
        ) : null}
      </div>
      <div className="fx-dialog-foot">
        {st.state === 'ok' ? (
          <button
            type="button"
            className="btn"
            data-key="fx-viewer-download"
            onClick={() => {
              const url = URL.createObjectURL(new Blob([st.r.text], { type: 'text/markdown;charset=utf-8' }));
              const a = document.createElement('a');
              a.href = url;
              a.download = `${rid}.md`;
              document.body.appendChild(a);
              a.click();
              a.remove();
              setTimeout(() => URL.revokeObjectURL(url), 2000);
            }}
          >
            <Download size={14} aria-hidden="true" />Download
          </button>
        ) : null}
        <button type="button" className="btn" data-key="fx-viewer-close" onClick={() => ref.current.close()}>Close</button>
      </div>
    </dialog>
  );
}

function TextButton({ pid, rid, sha, label = 'The full text as saved' }) {
  const [open, setOpen] = useState(false);
  const opener = useRef(null);
  return (
    <>
      <button ref={opener} type="button" className="btn-link fx-text-btn" data-key={`fx-text-${rid}`} onClick={() => setOpen(true)}><FileText size={13} aria-hidden="true" />{label}</button>
      {open ? <TextViewer pid={pid} rid={rid} sha={sha} onClose={() => { setOpen(false); requestAnimationFrame(() => { if (opener.current) opener.current.focus(); }); }} /> : null}
    </>
  );
}

function Receipts({ v, pid }) {
  return (
    <ul className="fx-receipts">
      {v.receipts.map((r) => {
        const out = {};
        for (const x of r.resolutions) out[`${x.checkpoint}:${x.event}`] = x;
        const recorded = Object.values(out);
        return (
          <li key={r.receipt_id} className={r.selected ? 'is-selected' : undefined} aria-current={r.selected ? 'true' : undefined}>
            <p className="fx-f-top">
              <span className="fx-id">{r.receipt_id}</span>
              <span>{`${PROVIDER_LABELS[r.model.provider] || r.model.provider} · assessed ${fmtDate(r.assessment_as_of || r.origin)} · origin ${fmtDateTime(r.origin)}${r.origin_basis === 'inherited' ? ' (kept)' : ''}`}</span>
              {r.revision_of ? <span className="fx-area">{`revision of ${r.revision_of}${r.revision ? ` · ${words(r.revision.kind)}` : ''}`}</span> : null}
              {r.latest ? <span className="fx-area">Latest</span> : null}
              {r.selected ? <span className="fx-area">Shown</span> : null}
            </p>
            {r.revision && r.revision.note ? <p className="faint">{`Why: ${r.revision.note}`}</p> : null}
            {r.plain_assessment ? <p className="fx-f-t">{r.plain_assessment}</p> : null}
            <p className="faint">{recorded.length ? `${recorded.length} checkpoint outcome${recorded.length === 1 ? '' : 's'} recorded: ${recorded.filter((x) => x.outcome === 'occurred').length} occurred, ${recorded.filter((x) => x.outcome === 'not_occurred').length} did not, ${recorded.filter((x) => x.outcome === 'unresolved').length} unresolved.` : 'No checkpoint outcome recorded yet.'}</p>
            {r.scenarios_at_origin ? <p className="faint">{`Projected at the origin (conditional): ${atOrigin(r.scenarios_at_origin)}`}</p> : null}
            <p className="fx-receipt-acts">
              {r.selected ? null : <a href={receiptHref(r.latest ? null : r.receipt_id)} data-key={`fx-show-${r.receipt_id}`}>{r.latest ? 'Show the latest' : 'Show this receipt'}</a>}
              <TextButton pid={pid} rid={r.receipt_id} sha={r.text_sha256} />
            </p>
          </li>
        );
      })}
    </ul>
  );
}

function Method({ v }) {
  const d = v.definitions;
  const p = v.preferences_in_use;
  return (
    <div className="fx-method">
      <h4 className="fx-h4">{`How the desk reads this now (${v.method.version})`}</h4>
      <p className="faint">{`${v.method.parts.join(', ')}. ${v.method.note}`}</p>
      <h4 className="fx-h4">{`Outcome definitions (${d.events.liquidity_impairment.version})`}</h4>
      <dl className="fx-f-dl">
        {EVENTS.map((e) => {
          const x = d.events[e];
          return <div key={e}><dt>{x.label}</dt><dd>{x.definition} <span className="faint">{`Cadence: ${(v.cadence_now && v.cadence_now[e]) || x.cadence} ${x.persistence ? `Persistence: ${x.persistence.hours} h, ${x.persistence.min_readings} reading(s). ` : ''}${x.recovery ? `Recovery: ${x.recovery.hours} h, ${x.recovery.min_readings} reading(s). ` : ''}${x.freshness_hours ? `Freshness: ${x.freshness_hours} h. ` : ''}Resolution: ${x.resolution} Limits: ${x.limits}`}</span></dd></div>;
        })}
      </dl>
      <h4 className="fx-h4">Your screening preferences</h4>
      <p className="faint">{p.note}</p>
      <ul className="fx-list">
        <li>{`Exit sizes ${p.exit_sizes_usd.map((s) => `$${s.toLocaleString('en-US')}`).join(', ')}; position $${p.exit_position_usd}; exit-cost limit ${p.exit_cost_limit_pct}%`}</li>
        <li>{`Delivery window ${p.delivery_window_days} days; volume review level ${p.volume_review_fraction} of the 30-day median before the origin`}</li>
        <li>{`Reported-liquidity review level: ${p.reported_liquidity_review_usd === null ? 'not set' : usd(p.reported_liquidity_review_usd)}; volume-to-liquidity review ratio: ${p.volume_to_liquidity_review_ratio === null ? 'not set' : p.volume_to_liquidity_review_ratio} (a review trigger, never a wash-trading test)`}</li>
      </ul>
      <h4 className="fx-h4">{`Liquidity (${d.liquidity.version})`}</h4>
      <ul className="fx-list">{Object.entries(d.liquidity.mechanisms).map(([k, w]) => <li key={k}><b>{words(k)}:</b>{` ${w}`}</li>)}</ul>
      <p className="faint">{[d.liquidity.scope, d.liquidity.completeness, d.liquidity.one_way, d.liquidity.note].filter(Boolean).join(' ')}</p>
      <h4 className="fx-h4">{`Scenarios (${d.scenarios.version})`}</h4>
      <ul className="fx-list">{Object.entries(d.scenarios.kinds).map(([k, w]) => <li key={k}><b>{SCEN_WORDS[k]}:</b>{` ${w}`}</li>)}</ul>
      <p className="faint">{`At least ${d.scenarios.min_points} daily readings over ${d.scenarios.min_span_days} days, ${d.scenarios.min_weekly_changes} weekly changes, the latest within ${d.scenarios.freshness_hours} h; otherwise "Insufficient history to estimate". ${d.scenarios.zero ? `${d.scenarios.zero} ` : ''}${d.scenarios.invalidation}`}</p>
      <h4 className="fx-h4">{`Probabilities (${d.probability.version})`}</h4>
      <p className="faint">{d.probability.note}</p>
      <ul className="fx-list faint">{d.probability.requirements.map((r, i) => <li key={i}>{r}</li>)}</ul>
      <h4 className="fx-h4">Not checked in this release</h4>
      <ul className="fx-list">{d.unsupported.map(([k, w]) => <li key={k}>{w}</li>)}</ul>
      <p className="faint">{d.hash_note}</p>
    </div>
  );
}

function Details({ v, pid }) {
  const c = v.current;
  const fold = (key, title, body, count = null) => (
    <details className="fold page-fold fx-fold" data-key={key}>
      <summary>{title}{count !== null ? <span className="fx-count">{count}</span> : null}</summary>
      <div className="fx-fold-body">{body}</div>
    </details>
  );
  return (
    <section className="fx-card fx-details" aria-label="Findings, sources and methodology">
      {c ? fold('fx-findings', 'Findings', <Findings c={c} />, c.findings.length) : null}
      {c ? fold('fx-grades', 'Integrity grades', <Grades c={c} rubric={v.definitions.rubric} />) : null}
      {c ? fold('fx-sources', 'Sources', <SourceList c={c} />, c.sources.length) : null}
      {fold('fx-observations', 'Monitor observations', <Observations v={v} />, v.monitoring.recent.length)}
      {fold('fx-challenge', 'ChatGPT challenge', <Challenge v={v} />)}
      {v.receipts.length ? fold('fx-receipts', 'Receipts and revisions', <Receipts v={v} pid={pid} />, v.receipts.length) : null}
      {fold('fx-method', 'Methodology', <Method v={v} />)}
    </section>
  );
}

// ---- 3. evidence changes to review (forensic-review.js) -------------------------------------

const when = (a, b) => (a && b && a !== b ? `${fmtDateTime(a)} to ${fmtDateTime(b)}` : fmtDateTime(a || b));

// What a monitored target bears on, as the records say; never inferred.
function Mapping({ m }) {
  if (!m) return null;
  if (m.status === 'mapped') {
    return (
      <p className="fx-th-map">
        <span>{`Bears on ${m.finding_ids.join(', ')} in ${m.receipt_id}, through source ${m.source_id}`}</span>
        {m.frozen ? <span className="faint">{`The receipt's capture is unchanged: ${[m.frozen.retrieved_at ? `retrieved ${fmtDateTime(m.frozen.retrieved_at)}` : 'retrieval time not stated', m.frozen.content_sha256 ? `SHA-256 ${shortHash(m.frozen.content_sha256)}` : null, m.frozen.excerpt ? 'excerpt kept' : null].filter(Boolean).join(' · ')}`}</span> : null}
        {m.current_receipt_id ? <span className="faint">{`Proposed in an earlier receipt; the latest assessment is ${m.current_receipt_id}.`}</span> : null}
      </p>
    );
  }
  return <p className="fx-th-map is-unmapped"><span>{m.status === 'unmapped' ? 'Unmapped' : m.status === 'source_only' ? 'No finding linked' : 'Receipt only'}</span><span className="faint">{m.reason}</span></p>;
}

function ChangeRow({ g }) {
  const span = g.class === 'read_failed' ? `${fmtDateTime(g.first_at)}${g.ended_at ? ` until ${fmtDateTime(g.ended_at)}` : ', still failing'}` : when(g.first_at, g.last_at);
  return (
    <li className={`fx-ch is-${g.class}`}>
      <p className="fx-ch-top"><b>{g.class_words}</b>{g.count > 1 ? <span className="faint">{` · ${g.count} ${g.class === 'read_failed' ? 'readings' : 'times'}`}</span> : null}<span className="faint">{` · ${span}`}</span></p>
      <dl className="fx-ch-dl">
        <div><dt>Before</dt><dd>{g.previous ? `${g.previous.words} (${fmtDateTime(g.previous.observed_at)})` : 'No earlier successful reading'}</dd></div>
        <div><dt>{g.class === 'read_failed' ? 'Then' : 'Now'}</dt><dd>{g.current ? `${g.current.words} (${fmtDateTime(g.current.observed_at)})` : '—'}</dd></div>
        {g.class === 'capture_changed' || g.class === 'cosmetic_only' ? <div><dt>Page</dt><dd className="fx-mono">{`SHA-256 ${shortHash(g.previous && g.previous.values && g.previous.values.body_sha256) || '—'} → ${shortHash(g.current && g.current.values && g.current.values.body_sha256) || '—'}`}</dd></div> : null}
      </dl>
    </li>
  );
}

function Thread({ t, pid }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const toReview = t.state === 'open' || t.state === 'reopened';
  const rows = toReview ? t.since_review : [];
  const noteId = `fx-th-note-${t.target_id}`;
  return (
    <article className={`fx-th is-${t.state}`} aria-labelledby={`fx-th-${t.target_id}`}>
      <p className="fx-th-top">
        <b id={`fx-th-${t.target_id}`}>{t.label}</b>
        <span className={`fx-th-st is-${t.state}`}>{t.state_words}</span>
        {t.unavailable ? <span className="fx-th-st is-unavailable">Not readable now</span> : null}
        {t.removed ? <span className="faint">Removed from monitoring</span> : null}
      </p>
      <Mapping m={t.mapping} />
      {rows.length ? <ul className="fx-chs">{rows.map((g) => <ChangeRow key={g.item_id} g={g} />)}</ul> : null}
      {!toReview ? <p className="faint">{t.latest ? `Latest reading ${fmtDateTime(t.latest.observed_at)}: ${t.latest.words}` : 'No successful reading yet.'}{t.items_total ? ` · ${t.items_total} change${t.items_total === 1 ? '' : 's'} on record` : ''}</p> : null}
      {toReview && t.latest_relevant ? (
        <div className="fx-th-ack">
          <label className="fx-label" htmlFor={noteId}>Your note (optional)</label>
          <textarea id={noteId} className="fx-textarea fx-textarea-s" rows={2} value={note} onChange={(e) => setNote(e.target.value)} data-key={`fx-th-note-${t.target_id}`} />
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            data-key={`fx-ack-${t.target_id}`}
            title="Records that you looked at this change. It does not make any claim true, resolve an allegation or change a grade."
            onClick={async () => {
              setBusy(true);
              try {
                const out = await api.post(`/api/projects/${enc(pid)}/forensics/reviews`, { target_id: t.target_id, item_id: t.latest_relevant.item_id, note: note.trim() || null, request_id: `fq${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}` });
                toast((out.result && out.result.status) === 'unchanged' ? 'Already marked reviewed' : 'Marked reviewed: you looked at it; nothing else changes');
                setNote('');
                await refresh();
              } catch (err) {
                toast(err.message, 'bad');
                await refresh();
              } finally {
                setBusy(false);
              }
            }}
          >
            {`Mark reviewed (latest change ${fmtDate(t.latest_relevant.at)})`}
          </button>
        </div>
      ) : null}
      {t.reviews.length ? (
        <details className="fx-th-hist" data-key={`fx-th-hist-${t.target_id}`}>
          <summary>{`Your reviews (${t.reviews.length})`}</summary>
          <ul className="fx-list">{[...t.reviews].reverse().map((r) => <li key={r.review_id}>{`${fmtDateTime(r.reviewed_at)} · ${words(r.item_class)}`}{r.note ? <span className="faint">{` · ${r.note}`}</span> : null}</li>)}</ul>
        </details>
      ) : null}
    </article>
  );
}

function EvidenceChanges({ v, pid }) {
  const q = v.evidence_changes;
  if (!q || !q.threads.length) return null;
  const toReview = q.threads.filter((t) => t.state === 'open' || t.state === 'reopened');
  const rest = q.threads.filter((t) => !(t.state === 'open' || t.state === 'reopened'));
  return (
    <section className="fx-card fx-queue" aria-labelledby="fx-queue-h" data-key="fx-queue">
      <div className="fx-head">
        <h2 id="fx-queue-h" className="fx-h" tabIndex={-1}>Evidence changes</h2>
        <span className="fx-head-sub">{toReview.length ? `${toReview.length} to review` : 'Nothing to review'}{q.unavailable ? ` · ${q.unavailable} not readable now` : ''}</span>
      </div>
      {toReview.length ? <div className="fx-ths">{toReview.map((t) => <Thread key={t.target_id} t={t} pid={pid} />)}</div> : <p className="none">No change waiting for your review.</p>}
      {rest.length ? (
        <details className="fold fx-fold" data-key="fx-queue-rest">
          <summary>Other monitored targets<span className="fx-count">{rest.length}</span></summary>
          <div className="fx-ths">{rest.map((t) => <Thread key={t.target_id} t={t} pid={pid} />)}</div>
        </details>
      ) : null}
      <p className="faint fx-act-note" title={`Compared under ${q.normalization}: whitespace only. Built from the monitor's existing observations.`}>{q.meaning}</p>
    </section>
  );
}

// ---- actions: audits and monitoring (explicit clicks only) ---------------------------------

const REVISION_KINDS = [
  ['format_fix', 'Format fix: the same assessment, corrected in form'],
  ['new_evidence', 'New evidence: a new source or a new capture of one'],
  ['reassessment', 'Reassessment: the same evidence, read again'],
  ['other', 'Other'],
];

// revisionOf: the receipt a revision would revise (an import into an audit
// whose job is already answered); the save keeps that receipt's origin and
// deadlines, and the original stays as it is.
function ImportDialog({ pid, audit, role, revisionOf = null, onClose }) {
  const ref = useRef(null);
  const [text, setText] = useState('');
  const [kind, setKind] = useState('format_fix');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => { if (d && d.open) d.close(); };
  }, []);
  const provider = role === 'challenge' ? 'chatgpt' : 'claude';
  const needNote = revisionOf && note.trim().length < 15;
  return (
    <dialog ref={ref} className="fx-dialog" aria-labelledby="fx-import-h" onClose={onClose}>
      <div className="fx-dialog-head"><h2 id="fx-import-h" className="fx-h">{revisionOf ? `Import a revision of ${revisionOf}` : `Import ${PROVIDER_LABELS[provider]}'s ${role === 'challenge' ? 'challenge' : 'assessment'}`}</h2></div>
      <div className="fx-dialog-body">
        {revisionOf ? (
          <>
            <p className="faint">{`A new receipt, linked to ${revisionOf}. It keeps that receipt's timeline origin and deadlines; the original and its text stay as they are. A new forecast is a new audit, never a revision.`}</p>
            <label className="fx-label" htmlFor="fx-rev-kind">What kind of revision</label>
            <select id="fx-rev-kind" className="fx-select" value={kind} onChange={(e) => setKind(e.target.value)} data-key="fx-rev-kind">
              {REVISION_KINDS.map(([k, w]) => <option key={k} value={k}>{w}</option>)}
            </select>
            <label className="fx-label" htmlFor="fx-rev-note">What changed and why (a sentence or two)</label>
            <textarea id="fx-rev-note" className="fx-textarea fx-textarea-s" value={note} onChange={(e) => setNote(e.target.value)} rows={3} data-key="fx-rev-note" />
          </>
        ) : null}
        <label className="fx-label" htmlFor="fx-import-text">{`The complete answer, with its JSON block (audit ${audit.audit_id})`}</label>
        <textarea id="fx-import-text" className="fx-textarea" value={text} onChange={(e) => setText(e.target.value)} rows={12} spellCheck={false} />
        {error ? <p className="fx-error" role="alert">{error}</p> : null}
      </div>
      <div className="fx-dialog-foot">
        <button type="button" className="btn" onClick={() => ref.current.close()}>Cancel</button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || text.trim().length < 50 || needNote}
          data-key="fx-import-save"
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const out = await api.post(`/api/projects/${enc(pid)}/forensics/audits/${enc(audit.audit_id)}/import`, revisionOf ? { provider, text, revision: { kind, note: note.trim() } } : { provider, text });
              toast(out.message || 'Saved');
              ref.current.close();
              await refresh();
            } catch (err) {
              setError(err.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Save
        </button>
      </div>
    </dialog>
  );
}

function Actions({ v, pid }) {
  const [challenge, setChallenge] = useState(false);
  const [busy, setBusy] = useState(null);
  const [importing, setImporting] = useState(null);
  const opener = useRef(null);
  const open = v.audits.find((a) => a.audit_id === v.open_audit) || null;
  const latestAudit = v.audits[0] || null;
  // A revision goes into the audit of the latest assessment, whose
  // investigator job is already answered.
  const latestRid = v.selected ? v.selected.latest_receipt_id : null;
  const latestRec = latestRid ? v.receipts.find((r) => r.receipt_id === latestRid) : null;
  const revAudit = latestRec ? v.audits.find((a) => a.audit_id === latestRec.audit_id && a.jobs.investigator && a.jobs.investigator.raw_state === 'completed') || null : null;
  const chalAudit = v.audits.find((a) => a.jobs.challenge && ['waiting', 'running', 'paused'].includes(a.jobs.challenge.state)) || null;
  const m = v.monitoring;
  const held = v.roles.challenge.on_hold;
  const proposedChecks = m.proposed.product_checks.filter((p) => !p.approved && p.allowed && p.allowed.ok);
  const proposedRepos = m.proposed.repositories.filter((p) => !p.approved);
  const blocked = m.proposed.product_checks.filter((p) => !p.approved && p.allowed && !p.allowed.ok);
  const quoteOptions = m.proposed.exit_quotes || [];
  const quotable = quoteOptions.filter((o) => o.supported && !o.approved);
  const notQuotable = quoteOptions.filter((o) => !o.supported);
  const quoteTargets = m.exit_quote_targets || [];
  const nTargets = m.targets.product_checks.length + m.targets.repositories.length + quoteTargets.length;
  const sizes = v.preferences.exit_sizes_usd.map((s) => `$${s.toLocaleString('en-US')}`).join(', ');
  const waits = (m.status.quote_providers || []).filter((p) => p.wait_until);
  // Every monitoring change is one explicit click, sent from here.
  const changeMonitoring = async (key, body, said) => {
    setBusy(key);
    try {
      const out = await api.post(`/api/projects/${enc(pid)}/forensics/monitoring`, body);
      const r = out.result || {};
      toast(said(r), (r.refused || []).length && !(r.added || []).length && !(r.removed || []).length && body.enabled === undefined ? 'bad' : undefined);
      await refresh();
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(null);
    }
  };
  const closeImport = () => {
    setImporting(null);
    requestAnimationFrame(() => { if (opener.current) opener.current.focus(); });
  };
  return (
    <section className="fx-card fx-actions" aria-labelledby="fx-act-h">
      <div className="fx-head"><h2 id="fx-act-h" className="fx-h">Audit and monitoring</h2><span className="fx-head-sub">Nothing here calls a paid model</span></div>
      <div className="fx-act-row">
        {open ? (
          <p className="fx-act-t">{`Open audit ${open.audit_id}: investigator ${(JOB_WORDS[open.jobs.investigator.state] || open.jobs.investigator.state).toLowerCase()}${open.jobs.challenge ? `; ChatGPT challenge ${(JOB_WORDS[open.jobs.challenge.state] || open.jobs.challenge.state).toLowerCase()}` : ''}.`}</p>
        ) : (
          <>
            <label className="fx-check-label" title={held ? 'ChatGPT is on hold on this desk' : 'ChatGPT checks attribution, calculations, omitted evidence and benign explanations once Claude\'s assessment is saved'}>
              <input type="checkbox" checked={challenge} disabled={held} onChange={(e) => setChallenge(e.target.checked)} data-key="fx-challenge-opt" />
              <span>{held ? 'ChatGPT challenge (on hold)' : 'Also ask ChatGPT to challenge it'}</span>
            </label>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy === 'start' || v.roles.investigator.on_hold}
              data-key="fx-start"
              onClick={async () => {
                setBusy('start');
                try {
                  const out = await api.post(`/api/projects/${enc(pid)}/forensics/audits`, { challenge, refresh: true, submission_id: `fx${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` });
                  toast(out.message || 'Audit opened');
                  await refresh();
                } catch (err) {
                  toast(err.message, 'bad');
                } finally {
                  setBusy(null);
                }
              }}
            >
              <Play size={14} aria-hidden="true" />{v.current ? 'Start a new forensic audit' : 'Start a forensic audit'}
            </button>
          </>
        )}
        {open || latestAudit ? (
          <button
            type="button"
            className="btn"
            data-key="fx-copy-prompt"
            onClick={async () => {
              try {
                const a = open || latestAudit;
                const text = await api.text(`/api/projects/${enc(pid)}/forensics/audits/${enc(a.audit_id)}/prompt`);
                await copyText(text);
              } catch (err) {
                toast(err.message, 'bad');
              }
            }}
          >
            <Copy size={14} aria-hidden="true" />Copy Claude's prompt
          </button>
        ) : null}
        {open ? <button type="button" className="btn" data-key="fx-import" onClick={(e) => { opener.current = e.currentTarget; setImporting({ audit: open, role: 'investigator' }); }}><Upload size={14} aria-hidden="true" />Import Claude's answer</button> : null}
        {!open && revAudit && latestRid ? <button type="button" className="btn" data-key="fx-import-revision" title={`A corrected or updated text for ${latestRid}: a new receipt that keeps its origin and deadlines`} onClick={(e) => { opener.current = e.currentTarget; setImporting({ audit: revAudit, role: 'investigator', revisionOf: latestRid }); }}><Upload size={14} aria-hidden="true" />{`Import a revision of ${latestRid}`}</button> : null}
        {chalAudit ? <button type="button" className="btn" data-key="fx-copy-chal" onClick={async () => { try { await copyText(await api.text(`/api/projects/${enc(pid)}/forensics/audits/${enc(chalAudit.audit_id)}/prompt?role=challenge`)); } catch (err) { toast(err.message, 'bad'); } }}><Copy size={14} aria-hidden="true" />Copy ChatGPT's challenge prompt</button> : null}
        {chalAudit ? <button type="button" className="btn" data-key="fx-import-chal" onClick={(e) => { opener.current = e.currentTarget; setImporting({ audit: chalAudit, role: 'challenge' }); }}><Upload size={14} aria-hidden="true" />Import ChatGPT's challenge</button> : null}
      </div>
      <p className="faint fx-act-note">{`In Cowork: "Do a forensic audit of ${v.name}". ChatGPT, when you asked for a challenge: "Do my waiting CryptoResearch forensic challenge". Gemini has no forensic role.`}</p>
      <h3 className="fx-h3">Monitoring <span className="fx-h3-sub">{m.enabled ? `On since ${fmtDate(m.since)}` : 'Off'}</span></h3>
      {nTargets ? (
        <ul className="fx-list">
          {m.targets.product_checks.map((t) => <li key={t.target_id}><b>{t.label}</b>{` · ${t.url}`}<span className="faint">{` · every ${m.status.product_interval_hours} h${t.expect_text ? ` · expects "${t.expect_text}"` : ''}`}</span></li>)}
          {m.targets.repositories.map((t) => <li key={t.target_id}><b>{`github.com/${t.owner}/${t.repo}`}</b><span className="faint">{` · every ${m.status.repo_interval_hours} h`}</span></li>)}
          {quoteTargets.map((t) => (
            <li key={t.target_id} className="fx-quote-target">
              <b title={`Asks ${t.provider_label} what selling ${sizes} of the token for ${t.quote_symbol} would receive. Quotes only: nothing is signed, approved or sent.`}>{`Exit quotes on ${t.chain_label}`}</b>
              {` · ${t.provider_label}, sold for ${t.quote_symbol}`}
              <span className="faint fx-mono" title={t.contract_address}>{` · ${shortAddr(t.contract_address)}`}</span>
              <span className="faint">{` · every ${m.status.quote_interval_hours} h · ${t.last_at ? `last asked ${fmtAgo(t.last_at)}` : 'not asked yet'}`}</span>
              <button type="button" className="btn-link fx-remove" disabled={busy === `rm-${t.target_id}`} data-key={`fx-remove-${t.target_id}`} aria-label={`Stop exit quotes on ${t.chain_label}`} onClick={() => changeMonitoring(`rm-${t.target_id}`, { remove: [t.target_id] }, (r) => ((r.removed || []).length ? `Exit quotes on ${t.chain_label} stopped` : 'Nothing changed'))}>Remove</button>
            </li>
          ))}
        </ul>
      ) : <p className="none">No target approved.</p>}
      {proposedChecks.length || proposedRepos.length ? (
        <div className="fx-proposed">
          <p>{`Proposed in ${m.proposed.receipt_id}: ${[...proposedChecks.map((p) => p.url), ...proposedRepos.map((p) => `github.com/${p.owner}/${p.repo}`)].join(', ')}`}</p>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy === 'approve'}
            data-key="fx-approve"
            onClick={() => changeMonitoring('approve', { approve: { receipt_id: m.proposed.receipt_id, product_checks: proposedChecks.map((p) => p.url), repositories: proposedRepos.map((p) => `${p.owner}/${p.repo}`) } }, (r) => `${(r.added || []).length} approved${(r.refused || []).length ? `, ${(r.refused || []).length} refused` : ''}`)}
          >
            Approve these targets
          </button>
        </div>
      ) : null}
      {blocked.length ? <p className="faint">{`Not checkable: ${blocked.map((p) => `${p.url} (${p.allowed.reason})`).join('; ')}`}</p> : null}
      {quotable.length ? (
        <div className="fx-proposed fx-quotes-proposed">
          <p>{`Exit quotes can be asked on ${quotable.map((o) => `${o.chain_label} (${o.provider_label})`).join(', ')}`}</p>
          {quotable.map((o) => (
            <button
              key={o.key}
              type="button"
              className="btn btn-sm"
              disabled={busy === `quote-${o.key}`}
              data-key={`fx-approve-quote-${o.chain_id}`}
              title={`Every ${m.status.quote_interval_hours} hours while monitoring is on, asks ${o.provider_label} what selling ${sizes} of ${shortAddr(o.contract_address)} for ${o.quote_symbol} would receive. Quotes only: nothing is signed, approved or sent.`}
              onClick={() => changeMonitoring(`quote-${o.key}`, { approve_quotes: [o.key] }, (r) => ((r.added || []).length ? `Exit quotes approved on ${o.chain_label}` : ((r.refused || [])[0] || {}).reason || 'Nothing changed'))}
            >
              {`Approve exit quotes on ${o.chain_label}`}
            </button>
          ))}
        </div>
      ) : null}
      {notQuotable.length ? <p className="faint">{`No exit quotes: ${notQuotable.map((o) => `${o.chain_label} (${o.reason})`).join('; ')}`}</p> : null}
      {nTargets ? (
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy === 'monitor'}
          data-key="fx-monitor-toggle"
          onClick={() => changeMonitoring('monitor', { enabled: !m.enabled }, () => (m.enabled ? 'Monitoring turned off' : 'Monitoring turned on'))}
        >
          {m.enabled ? 'Turn monitoring off' : 'Turn monitoring on'}
        </button>
      ) : null}
      <p className="faint fx-act-note">{`Monitor: ${m.status.held ? 'held in this restored copy' : m.status.enabled ? `${m.status.requests_this_month} of ${m.status.monthly_budget} requests this month${m.status.last_run_at ? ` · last run ${fmtAgo(m.status.last_run_at)}` : ''}${m.status.github_wait_until ? ` · GitHub asked to wait until ${fmtDateTime(m.status.github_wait_until)}` : ''}${waits.map((p) => ` · ${p.label} asked to wait until ${fmtDateTime(p.wait_until)}`).join('')}` : 'turned off in settings'}`}</p>
      {importing ? <ImportDialog pid={pid} audit={importing.audit} role={importing.role} revisionOf={importing.revisionOf || null} onClose={closeImport} /> : null}
    </section>
  );
}

// ---- the tab ---------------------------------------------------------------------------------

export default function Forensics({ pid, receipt = null }) {
  const { v, error, retry } = useForensics(pid, receipt);
  if (!v) {
    return error ? (
      <div className="note note-bad pp-error" role="alert">
        <span>{`Could not read the forensic records: ${error.message}`}</span>
        <button type="button" className="btn btn-sm" data-key="fx-retry" onClick={retry}>Try again</button>
      </div>
    ) : <div className="page-loading" role="status"><span className="sr-only">Loading the forensic records…</span><span className="skel w60" /><span className="skel w80" /><span className="skel w40" /></div>;
  }
  const c = v.current;
  return (
    <div className="fx">
      <Assessment v={v} pid={pid} />
      {c ? (
        <div className="fx-keys">
          <KeyFinding title="Strongest supported concern" tone="concern" r={c.strongest_concern} idx={c.source_index} />
          <NextAction v={v} />
          <KeyFinding title="Strongest counterevidence" tone="counter" r={c.strongest_counterevidence} idx={c.source_index} />
        </div>
      ) : <NextAction v={v} />}
      <AssessmentDetails v={v} />
      <EvidenceChanges v={v} pid={pid} />
      <States v={v} />
      <Timeline v={v} />
      <Conditions v={v} />
      <Details v={v} pid={pid} />
      <Actions v={v} pid={pid} />
    </div>
  );
}
