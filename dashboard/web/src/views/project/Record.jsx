// The Record section (#/project/<id>/record; DESIGN_AND_IA_BLUEPRINT.md §3.3):
// the project's audit trail. The latest research run's details (its prompt's
// SHA-256 in full, the exact prompt only when opened), then, folded and drawn
// only when opened: every research run with its jobs, attempts, costs and
// prompts (?open=runs, ?run=<id>), your headline (Pin as headline), the
// report history with revisions and why a report is excluded or quarantined,
// the technical records of the chosen report, and the forensic receipts and
// challenges. Ported from views/project.js (researchParts, jobRow,
// headlineBody, technicalBody, normalizedView). Drawing it writes nothing and
// asks no provider; every write is an explicit button.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Copy, Download, Pin, Play } from 'lucide-react';
import {
  PROVIDERS, PROVIDER_LABELS, WAITING_SENTENCE, fmtDate, fmtDateTime, fmtAgo, fmtNum, toast, copyText, onHoldOf,
  researchState, jobKey, isAssistantJob, coworkIdleMinutes, waitingInstruction, withheldLabel,
} from '../../../../public/ui.js';
import { ineligibleReason } from '../../../../public/brief-model.js';
import { sectionHref } from '../../../../public/project-routes.js';
import { desk, api, refresh, hosted } from '../../lib/desk.js';
import { useDesk } from '../../lib/hooks.js';
import { legacyCtx } from '../../legacy/ctx.js';
import { loadLegacy } from '../../components/Dom.jsx';
import { Panel, Fold, KV, None, LazyPre, useLazyText, readText, CopyButton, enc, plural } from './kit.jsx';
import { TextButton } from './forensics/TextButton.jsx';
import { CaseButton } from './forensics/CaseButton.jsx';
import '../../styles/record.css';

const words = (s) => (s === null || s === undefined || s === '' ? '' : String(s).replace(/_/g, ' '));
const short12 = (s) => `${String(s || '').slice(0, 12)}…`;

// ---- pure rules, as views/project.js has them -------------------------------------

function money(n) {
  return `$${n > 0 && n < 0.1 ? n.toFixed(4) : n.toFixed(2)}`;
}

// What an attempt cost, and how sure that figure is: reconciled (you recorded
// it from the provider's billing), actual (the provider reported all usage),
// estimated (usage incomplete: counted at no less than the reservation until
// reconciled) or reserved (no usage yet). Never "up to".
function attemptCost(a) {
  if (a.phase === 'not_sent') return 'not sent, $0';
  if (typeof a.reconciled_usd === 'number' && (a.phase === 'reconciled' || a.reconciled_at)) return `${money(a.reconciled_usd)} reconciled (you recorded it)`;
  if (typeof a.cost_actual_usd === 'number') return `${money(a.cost_actual_usd)} actual${a.not_billed ? ' (refused before any work, not billed)' : ''}${typeof a.overrun_usd === 'number' && a.overrun_usd > 0 ? ` (${money(a.overrun_usd)} above its reservation)` : ''}`;
  const r = typeof a.reserved_usd === 'number' ? a.reserved_usd : a.cost_estimate_usd;
  if (typeof a.cost_usage_estimate_usd === 'number') {
    const counted = Math.max(a.cost_usage_estimate_usd, typeof r === 'number' ? r : 0);
    return `${money(a.cost_usage_estimate_usd)} estimated (the provider did not report ${(a.cost_unknown || []).includes('search_calls') ? 'how many searches ran' : 'all usage'}); counted at ${money(counted)} until reconciled`;
  }
  if (typeof r !== 'number') return null;
  if (a.phase === 'uncertain') return `${money(r)} reserved, counted until reconciled`;
  if (a.phase === 'submitted' || a.phase === 'dispatched') return `${money(r)} reserved (an estimate made before sending)`;
  return `${money(r)} reserved (estimate)`;
}

// Mirrors the server: an uncertain paid attempt, or a provider error without
// usage, can be reconciled by the owner.
function reconcilable(j, a) {
  if (j.mode !== 'api' || !a || a.reconciled_at) return false;
  if (a.cost_status === 'estimated' && ['responded', 'imported', 'errored'].includes(a.phase)) return true;
  if (a.phase === 'uncertain') return true;
  if (a.phase === 'errored') return typeof a.cost_actual_usd !== 'number';
  return !a.phase && Boolean(a.finished_at) && a.outcome !== 'response_saved' && typeof a.cost_actual_usd !== 'number' && typeof a.cost_estimate_usd === 'number';
}

// An attempt's phase in words; "submitted" means the provider accepted the
// request and the desk is checking on it in the background.
const PHASE_TEXT = { reserved: 'reserved, about to be sent', submitted: 'accepted by the provider, running in the background', uncertain: 'uncertain: may have been billed', errored: 'error', not_sent: 'not sent' };

// Why an answer stopped early, in words (research.js termination codes).
const TERMINATION_TEXT = {
  ended_before_message_stop: 'the connection ended before the answer was complete',
  stream_unreadable: 'the answer stream could not be read',
  max_tokens: 'it ran out of its output limit',
  pause_turn: 'it was still researching after the most requests allowed',
  pause_turn_not_resumable: 'it paused and could not be resumed exactly',
  refusal: 'the model declined',
  timeout: 'the time limit ran out',
  canceled: 'it was canceled',
  cancelled: 'it was cancelled',
  'incomplete: max_output_tokens': 'it ran out of its output limit',
};
const terminationText = (t) => TERMINATION_TEXT[t] || (/^error_event/.test(t) ? `the provider reported an error mid-answer${t.includes(':') ? ` (${t.split(': ')[1]})` : ''}` : words(t));

// A completed job whose model saved again for the same run: the first save
// completed the job (the original), the run now links the latest, and the
// revision record says what kind of save that was. Null for one save.
const REVISION_BASIS = { existing_evidence: 'a revision using existing evidence (no source added)', new_sources: 'a revision with new sources', scores_unchanged: 'a re-save with the same scores' };
function jobSaves(j, reports = []) {
  const earlier = j && j.state === 'completed' && j.report_id && Array.isArray(j.previous_report_ids) ? j.previous_report_ids.filter(Boolean) : [];
  if (!earlier.length) return null;
  const latest = (reports || []).find((r) => r && r.report_id === j.report_id);
  const rv = latest && latest.revision && latest.revision.kind === 'revision' ? latest.revision : null;
  const kind = rv ? REVISION_BASIS[rv.basis] || 'a revision' : 'a later save';
  const between = earlier.length > 1 ? ` (${earlier.length - 1} more save${earlier.length === 2 ? '' : 's'} in between)` : '';
  return { original: earlier[0], latest: j.report_id, basis: rv ? rv.basis : null, text: `Completed by its first save, ${earlier[0]}. The run now links ${j.report_id}, ${kind}${between}. Both are kept.` };
}

function fmtScore(s) {
  if (s === null || s === undefined) return '—';
  if (typeof s === 'string' || typeof s === 'number') return String(s);
  if (s.status === 'scored') return String(s.value);
  if (s.status === 'range') return `${s.low}–${s.high}`;
  return s.status === 'not_applicable' ? 'N/A' : 'unknown';
}

// A grade in words: its figure and word, withheld with the share scored, a
// PDF, or none. A range is its two ends (the desk's own display).
function gradeWords(g, needsText = false) {
  if (g && g.display) return `${g.display} ${g.label || ''}`.trim();
  if (g && g.status === 'withheld') return withheldLabel(g.coverage_pct);
  if (needsText) return 'PDF';
  return 'No grade';
}
const verdictWords = (v) => (v ? `${v.charAt(0)}${v.slice(1).toLowerCase().replace(/_/g, ' ')}` : 'No verdict');

const providersOf = (run) => (Array.isArray(run.providers) ? run.providers : Object.keys(run.jobs || {})).filter((p) => run.jobs && run.jobs[p]);
// The models in a run whose jobs carry an execution note (ChatGPT's, from
// 2026-10-03 on).
const noted = (run) => providersOf(run).filter((p) => run.jobs[p].execution && run.jobs[p].execution.ref);

const TONE = { ok: 'is-ok', bad: 'is-bad', warn: 'is-warn', wait: 'is-warn', work: 'is-work' };
function StateWords({ text, tone }) {
  return <span className={`rc-state ${TONE[tone] || ''}`.trim()}>{text}</span>;
}

// A copy button named for what it copies (several sit side by side).
function CopyText({ text = null, getText = null, label, aria = null, dataKey }) {
  return (
    <button
      type="button"
      className="btn btn-sm"
      aria-label={aria || undefined}
      data-key={dataKey}
      onClick={async () => {
        let t = text;
        if (getText) {
          try {
            t = await getText();
          } catch (err) {
            toast(err.message, 'bad');
            return;
          }
        }
        await copyText(t);
      }}
    >
      <Copy size={13} aria-hidden="true" />{label}
    </button>
  );
}

// A run's prompt as one model gets it. With ?provider= the server may refuse
// (409) while that note's delivery is not verified: its words are shown.
function PromptText({ path, keep }) {
  const { text, error } = useLazyText(path);
  if (error) {
    return error.status === 409
      ? <p className="note note-warn" role="note">{error.message}</p>
      : <p className="l2-err" role="alert">{`The prompt could not be loaded: ${error.message}`}</p>;
  }
  return (
    <pre className="l2-pre" data-keep-scroll={keep} tabIndex={0} aria-busy={text === null ? 'true' : undefined}>
      {text === null ? 'Loading the prompt…' : text}
    </pre>
  );
}

// ---- 1. research details ------------------------------------------------------------

function horizonText(h) {
  if (!h) return null;
  const base = h.text || (typeof h.months === 'number' ? `${h.months} months` : null);
  if (!base) return null;
  const span = h.start_date && h.end_date && !String(base).includes(h.start_date) ? ` · ${fmtDate(h.start_date)} to ${fmtDate(h.end_date)}` : '';
  return `${base}${span}`;
}

function ResearchDetails({ d, pid }) {
  const runs = (d.research && d.research.runs) || [];
  const run = runs.find((r) => r && !r.broken) || null;
  if (!run) {
    return (
      <Panel id="rc-details" title="Research details">
        <None>{runs.length ? 'No research run could be read.' : 'No research run yet.'}</None>
      </Panel>
    );
  }
  const path = `/api/projects/${enc(pid)}/research/${enc(run.run_id)}/prompt`;
  const pr = run.prompt || {};
  const h = run.horizon || null;
  return (
    <Panel id="rc-details" title="Research details" sub={`Latest run${run.status ? ` · ${words(run.status)}` : ''}`}>
      <KV
        label="The latest research run"
        rows={[
          ['Run ID', <span className="l2-mono">{run.run_id}</span>],
          ['Prompt version', pr.version || 'Not recorded'],
          ['Prompt SHA-256', pr.sha256 ? (
            <span className="rc-hashline">
              <span className="l2-hash">{pr.sha256}</span>
              <CopyText text={pr.sha256} label="Copy" aria="Copy the prompt's SHA-256" dataKey={`copy-sha-${run.run_id}`} />
            </span>
          ) : 'Not recorded', null, true],
          ['Rubric · profile', `${run.rubric_version || '?'} · ${run.sector_profile || '?'}`],
          ['Horizon', horizonText(h) || 'Not recorded', h && h.text ? h.text : null],
          h && h.mode === 'long_term' ? ['Long-term reason', h.exception_reason || 'No reason recorded'] : null,
          ['Started', `${fmtDateTime(run.created_at)} via ${run.channel || '?'} by ${run.created_by || '?'}`],
          run.utterance ? ['Request', `“${run.utterance}”`, null, true] : null,
        ]}
      />
      <Fold dataKey={`prompt-${run.run_id}`} lazy title="Show exact prompt" note="The run's prompt exactly as frozen when it started, identical for every model.">
        <div className="l2-actions">
          <CopyButton getText={() => readText(path)} label="Copy prompt" dataKey={`copy-prompt-${run.run_id}`} />
        </div>
        <LazyPre path={path} loading="Loading the prompt…" failed="The prompt could not be loaded" keepScroll={`prompt-${run.run_id}`} />
      </Fold>
    </Panel>
  );
}

// ---- 2. research runs ---------------------------------------------------------------

function AttemptLine({ a }) {
  const cost = attemptCost(a);
  return (
    <div className="rc-attempt">
      {`#${a.n} ${PHASE_TEXT[a.phase] || words(a.phase || a.outcome || 'in progress')}`}
      {a.usage
        ? <span className="faint">{` · ${a.usage.input_tokens ?? '?'} in / ${a.usage.output_tokens ?? '?'} out tokens`}</span>
        : a.partial_usage
          ? <span className="faint" title={a.usage_note || undefined}>{` · incomplete usage: at least ${a.partial_usage.input_tokens ?? '?'} in / ${a.partial_usage.output_tokens ?? '?'} out tokens before it stopped`}</span>
          : null}
      {cost ? <span className={a.phase === 'uncertain' ? 'rc-warn' : 'faint'}>{` · ${cost}`}</span> : null}
      {a.response_sha256 ? <span className="faint" title={`Raw response saved before normalization: ${a.response_path}${a.request_id ? ` · request ${a.request_id}` : ''}${a.response_id ? ` · response ${a.response_id}` : ''}`}>{' · response saved'}</span> : null}
      {a.partial_output ? <span>{' · partial answer kept (below the table)'}</span> : null}
    </div>
  );
}

// A waiting job's next step. On the online desk: the sentence for that
// model's assistant, with pasting by hand under it; on this PC: copy the
// prompt (with its execution note first, when the job has one) and import
// the answer. (dialogs.js waitingActions, instruction: false.)
function WaitingActions({ pid, runId, prov, k, hostedOn }) {
  const who = PROVIDER_LABELS[prov];
  const copy = (
    <CopyText
      getText={() => readText(`/api/projects/${enc(pid)}/research/${enc(runId)}/prompt?provider=${enc(prov)}`)}
      label="Copy prompt"
      aria={`Copy the research prompt for ${who}`}
      dataKey={`copy-${k}`}
    />
  );
  const imp = <a className="btn btn-sm" href={`#/updates?tab=import&project=${enc(pid)}&provider=${prov}&run=${enc(runId)}`} data-key={`import-${k}`}>Import report</a>;
  if (!hostedOn) return <>{copy}{imp}</>;
  return (
    <>
      <CopyText text={WAITING_SENTENCE} label={`Copy: “${WAITING_SENTENCE}”`} aria={`Copy the sentence for ${who}: ${WAITING_SENTENCE}`} dataKey={`say-${k}`} />
      <Fold dataKey={`by-hand-${k}`} title="Do it by hand" className="rc-byhand">
        <p className="rc-step">{`Paste the prompt into ${who} yourself, then import its answer for this run.`}</p>
        <div className="rc-acts">{copy}{imp}</div>
      </Fold>
    </>
  );
}

function routeWords(j, prov, hostedOn) {
  if (j.mode === 'manual') return hostedOn ? 'Its assistant\'s connection, or by hand' : 'By hand: paste the prompt, import the answer';
  if (j.mode === 'cowork') return 'Claude in Cowork';
  if (j.mode === 'connector') return `${PROVIDER_LABELS[prov]} through its desk connection`;
  if (j.mode === 'mock') return 'Fictional demo adapter';
  return `API, in the background${j.model ? ` · ${j.model}` : ''}`;
}

function JobRow({ d, pid, run, prov, onHold, hostedOn }) {
  const [busy, setBusy] = useState(false);
  const j = run.jobs[prov];
  const runId = run.run_id;
  const who = PROVIDER_LABELS[prov];
  const name = (d.project && d.project.name) || pid;
  const key = jobKey(j, run.created_at, { onHold });
  const st = researchState(key, { provider: prov, hosted: hostedOn });
  const saves = jobSaves(j, d.reports);
  const attempts = j.attempts || [];
  const assistant = isAssistantJob(j);
  const helper = j.mode === 'cowork' ? 'Cowork' : who;
  const idle = assistant ? coworkIdleMinutes(j, run.created_at) : null;
  const k = `rt-${runId}-${prov}`;
  const reportHref = (id) => sectionHref(pid, 'report', { model: prov, report: id });
  const canCancel = ['queued', 'running', 'dispatching', 'uncertain', 'unconfigured'].includes(j.state) && !assistant;
  return (
    <tr data-key={`job-${runId}-${prov}`}>
      <td><strong>{who}</strong></td>
      <td>
        {key === 'waiting' && hostedOn ? (
          <>
            <StateWords text="Waiting for you" tone={st.tone} />
            <p className="rc-step">{`${waitingInstruction(prov, { full: true })}. It researches under its own plan and saves the report here.`}</p>
          </>
        ) : <StateWords text={st.long} tone={st.tone} />}
      </td>
      <td>{routeWords(j, prov, hostedOn)}</td>
      <td>{attempts.length ? attempts.map((a, i) => <AttemptLine key={`${a.n}-${i}`} a={a} />) : <span className="faint">None</span>}</td>
      <td>{j.error ? <span className="rc-err">{j.error}</span> : saves ? saves.text : j.note ? <span className="muted">{j.note}</span> : null}</td>
      <td>
        <div className="rc-acts">
          {j.state === 'unconfigured' && !onHold ? <WaitingActions pid={pid} runId={runId} prov={prov} k={k} hostedOn={hostedOn} /> : null}
          {assistant && j.state === 'running' ? (
            <>
              <p className="rc-step">
                {key === 'interrupted'
                  ? `No activity from ${helper} for ${idle >= 120 ? `${Math.round(idle / 60)} hours` : `${idle} minutes`}${j.draft_saved_at ? `; its draft from ${fmtDateTime(j.draft_saved_at)} is kept` : ''}. Tell ${helper} to resume it (it continues this run and its draft) or to restart it (this run is canceled and a new one starts).`
                  : `${helper} is working on it${idle !== null ? ` (last activity ${idle < 1 ? 'just now' : `${idle} min ago`})` : ''}${j.progress_note ? `: ${j.progress_note}` : ''}.`}
              </p>
              <CopyText text={`Resume the research on ${name}`} label={`Copy: “Resume the research on ${name}”`} dataKey={`say-resume-${runId}-${prov}`} />
              <CopyText text={`Restart the research on ${name}`} label={`Copy: “Restart the research on ${name}”`} dataKey={`say-restart-${runId}-${prov}`} />
              {key === 'interrupted' ? (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  aria-label={`Cancel the interrupted ${helper} research for ${name}`}
                  data-key={`cancel-run-${runId}-${prov}`}
                  disabled={busy}
                  onClick={async () => {
                    if (busy || !window.confirm('Cancel this research run? Its draft is kept; nothing is deleted.')) return;
                    setBusy(true);
                    try {
                      const r = await api.post(`/api/projects/${enc(pid)}/research/${enc(runId)}/jobs/${prov}/cancel`, {});
                      toast((r && r.message) || 'Canceled');
                      await refresh();
                    } catch (err) {
                      toast(err.message, 'bad');
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Cancel this run
                </button>
              ) : null}
            </>
          ) : null}
          {/* A model on hold gets nothing new: no retry is offered (the server refuses one too). */}
          {!onHold && (j.state === 'failed' || j.state === 'canceled') ? (
            <button
              type="button"
              className="btn btn-sm"
              aria-label={`Retry the ${who} job`}
              data-key={`retry-${runId}-${prov}`}
              disabled={busy}
              onClick={async () => {
                if (busy) return;
                setBusy(true);
                try {
                  const r = await api.post(`/api/projects/${enc(pid)}/research/${enc(runId)}/jobs/${prov}/retry`, {});
                  toast((r && r.message) || 'Retry queued');
                  await refresh();
                } catch (err) {
                  toast(err.message, 'bad');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Retry
            </button>
          ) : null}
          {!onHold && j.state === 'uncertain' ? (
            <button
              type="button"
              className="btn btn-sm"
              title="Sends a new request. The uncertain attempt may already have been billed and keeps counting until you reconcile it."
              aria-label={`Send a new ${who} request despite the uncertain attempt`}
              data-key={`retry-anyway-${runId}-${prov}`}
              disabled={busy}
              onClick={async () => {
                if (busy || !window.confirm(`Send a new ${who} request? The earlier attempt may already have been billed; it keeps counting against your limits until you reconcile it, and the new attempt is reserved separately.`)) return;
                setBusy(true);
                try {
                  const r = await api.post(`/api/projects/${enc(pid)}/research/${enc(runId)}/jobs/${prov}/retry`, {});
                  toast((r && r.message) || 'Retry queued');
                  await refresh();
                } catch (err) {
                  toast(err.message, 'bad');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Retry anyway
            </button>
          ) : null}
          {canCancel ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              title="Stops this job and its retries. A request already sent may still be billed."
              aria-label={`Cancel the ${who} job`}
              data-key={`cancel-${runId}-${prov}`}
              disabled={busy}
              onClick={async () => {
                if (busy || !window.confirm(`Cancel the ${who} job? A request already sent to the provider may still be billed.`)) return;
                setBusy(true);
                try {
                  const r = await api.post(`/api/projects/${enc(pid)}/research/${enc(runId)}/jobs/${prov}/cancel`, {});
                  toast((r && r.message) || 'Canceled');
                  await refresh();
                } catch (err) {
                  toast(err.message, 'bad');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Cancel
            </button>
          ) : null}
          {saves ? (
            <>
              <a className="btn btn-sm" href={reportHref(saves.original)} data-key={`job-orig-${runId}-${prov}`}>Open the original</a>
              <a className="btn btn-sm" href={reportHref(saves.latest)} data-key={`job-latest-${runId}-${prov}`}>Open the latest revision</a>
            </>
          ) : j.report_id ? <a className="btn btn-sm" href={reportHref(j.report_id)} data-key={`job-report-${runId}-${prov}`}>Open report</a> : null}
        </div>
      </td>
    </tr>
  );
}

// Record what an uncertain or unbilled-looking paid attempt cost, from the
// provider's usage page. It counts at its reservation until you do.
function ReconcileForm({ pid, run, prov, a }) {
  const key = `rec-${run.run_id}-${prov}-${a.n}`;
  const [amount, setAmount] = useState('');
  const [none, setNone] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const record = async () => {
    if (busy) return;
    const body = { attempt: a.attempt_id || a.n, reason: reason.trim() };
    if (none) body.not_charged = true;
    else body.charged_usd = amount.trim();
    setBusy(true);
    try {
      const r = await api.post(`/api/projects/${enc(pid)}/research/${enc(run.run_id)}/jobs/${prov}/reconcile`, body);
      toast((r && r.message) || 'Recorded');
      await refresh();
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Fold dataKey={key} title={`Reconcile attempt #${a.n} · ${PROVIDER_LABELS[prov]}`} note="Check the provider's usage page, then record what this attempt was charged. It counts against your limits at its reservation until you do.">
      <form className="rc-reconcile" data-key={`${key}-form`} onSubmit={(e) => { e.preventDefault(); record(); }}>
        <label>
          <span>Charged (USD)</span>
          <input className="input" inputMode="decimal" name={`${key}-amount`} placeholder="USD charged, e.g. 0.42" aria-label={`Amount charged for attempt ${a.n}`} value={amount} disabled={none} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="rc-check">
          <input type="checkbox" name={`${key}-none`} checked={none} onChange={(e) => setNone(e.target.checked)} />
          <span>Not charged</span>
        </label>
        <label>
          <span>How you know</span>
          <input className="input" name={`${key}-reason`} placeholder="How you know (e.g. provider usage page)" aria-label={`How you know what attempt ${a.n} cost`} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy} aria-busy={busy || undefined}>{busy ? 'Working…' : 'Record'}</button>
      </form>
    </Fold>
  );
}

// The text an answer wrote before it stopped, read only when opened. Kept for
// reading only: never imported, graded or compared.
function PartialView({ pid, run, prov, a }) {
  const who = PROVIDER_LABELS[prov];
  const key = `partial-${run.run_id}-${prov}-${a.n}`;
  const path = `/api/projects/${enc(pid)}/research/${enc(run.run_id)}/jobs/${prov}/attempts/${a.n}/partial`;
  return (
    <Fold dataKey={key} lazy title={`Partial answer kept: ${who}, attempt #${a.n} (${fmtNum(a.partial_output.chars)} characters; not a report, not graded)`}>
      <p className="rc-step">{`What ${who} wrote before the answer stopped${a.termination ? ` (${terminationText(a.termination)})` : ''}. Kept for reading only: never saved as a report, graded or compared.`}</p>
      <LazyPre path={path} loading="Loading the partial answer…" failed="The partial answer could not be loaded" keepScroll={key} />
    </Fold>
  );
}

function RunCard({ d, pid, run, wantRun, hostedOn }) {
  const runId = run.run_id;
  const promptPath = `/api/projects/${enc(pid)}/research/${enc(runId)}/prompt`;
  const provs = providersOf(run);
  const notes = noted(run);
  const hid = `run-card-${runId}-h`;
  const pr = run.prompt || null;
  const ep = run.evidence_packet || null;
  const partials = provs.flatMap((p) => (run.jobs[p].attempts || []).filter((a) => a && a.partial_output).map((a) => ({ p, a })));
  const reconciles = provs.flatMap((p) => (run.jobs[p].attempts || []).filter((a) => reconcilable(run.jobs[p], a)).map((a) => ({ p, a })));
  return (
    <section className="rc-run" id={`run-card-${runId}`} aria-labelledby={hid}>
      <header className="rc-run-head">
        <h3 id={hid} className="rc-h3">{`Run of ${fmtDateTime(run.created_at)}`}</h3>
        {run.status ? <span className="faint">{words(run.status)}</span> : null}
      </header>
      {provs.length ? (
        <div className="l2-table-wrap">
          <table className="l2-table rc-jobs">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">State</th>
                <th scope="col">Route</th>
                <th scope="col">Attempts</th>
                <th scope="col">Note</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {provs.map((p) => <JobRow key={p} d={d} pid={pid} run={run} prov={p} onHold={Boolean(onHoldOf(desk.index, p))} hostedOn={hostedOn} />)}
            </tbody>
          </table>
        </div>
      ) : <None>No model jobs in this run.</None>}
      {partials.map(({ p, a }) => <PartialView key={`${p}-${a.n}`} pid={pid} run={run} prov={p} a={a} />)}
      {reconciles.map(({ p, a }) => <ReconcileForm key={`${p}-${a.n}`} pid={pid} run={run} prov={p} a={a} />)}
      <Fold dataKey={`run-${runId}`} title="Run details" defaultOpen={runId === wantRun}>
        <KV
          rows={[
            ['Run ID', <span className="l2-mono">{runId}</span>],
            ['Started by', `${run.created_by || '?'} via ${run.channel || '?'}`],
            run.utterance ? ['Request', `“${run.utterance}”`, null, true] : null,
            ['Rubric · profile · horizon', `${run.rubric_version || '?'} · ${run.sector_profile || '?'} · ${run.horizon && run.horizon.text ? run.horizon.text : '?'}`, null, true],
            ['Prompt', pr ? (
              <span className="rc-hashline">
                <span>{`${pr.version || '?'}, identical for every model · SHA-256 ${short12(pr.sha256)}`}</span>
                <CopyButton getText={() => readText(promptPath)} label="Copy prompt" dataKey={`copy-run-prompt-${runId}`} />
              </span>
            ) : 'Not recorded', pr && pr.sha256 ? `SHA-256 ${pr.sha256}` : null, true],
            // A model's own execution note (ChatGPT's), frozen with its job.
            notes.length ? ['Execution notes', notes.map((p) => `${PROVIDER_LABELS[p]}: ${run.jobs[p].execution.ref} · SHA-256 ${short12(run.jobs[p].execution.sha256)}, given before the same prompt`).join(' · '), null, true] : null,
            ['Evidence packet', ep ? `captured ${fmtDateTime(ep.captured_at)} · SHA-256 ${short12(ep.sha256)} · no holdings, notes or other models' conclusions` : 'Not recorded', ep && ep.sha256 ? `SHA-256 ${ep.sha256}` : null, true],
          ]}
        />
      </Fold>
      <Fold dataKey={`run-prompt-${runId}`} lazy title="Show the exact prompt">
        <PromptText path={promptPath} keep={`run-prompt-${runId}`} />
      </Fold>
      {notes.map((p) => (
        <Fold key={p} dataKey={`run-prompt-${runId}-${p}`} lazy title={`Show what ${PROVIDER_LABELS[p]} gets: its execution note, then the same prompt`}>
          <PromptText path={`${promptPath}?provider=${enc(p)}`} keep={`run-prompt-${runId}-${p}`} />
        </Fold>
      ))}
    </section>
  );
}

// The general prompt for this project, one file per model, without a run's
// dated context; rebuilt to the current prompt on request.
function StandingPrompts({ d, pid }) {
  const [busy, setBusy] = useState(false);
  const files = d.prompt_files || [];
  const rc = d.research_contract || null;
  const stale = rc ? files.filter((f) => /^(claude|chatgpt|gemini)\.md$/.test(f.name) && f.prompt_version && f.prompt_version !== rc.prompt_version) : [];
  return (
    <section className="rc-sub" aria-labelledby="rc-prompts-h">
      <h3 id="rc-prompts-h" className="rc-h3" title="The general prompt for this project, one file per model, without a run's dated context. Each research run keeps its own exact prompt.">Standing prompt files</h3>
      {stale.length ? <p className="rc-line">{`These files were written with ${stale[0].prompt_version}; a new run uses ${rc.prompt_version}. Rebuild them to read the current prompt here.`}</p> : null}
      <div className="l2-actions">
        <button
          type="button"
          className="btn btn-sm"
          data-key="rt-rebuild-prompts"
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={async () => {
            if (busy) return;
            setBusy(true);
            try {
              await api.post(`/api/projects/${enc(pid)}/prompts`, {});
              toast('Prompt files rebuilt');
              await refresh();
            } catch (err) {
              toast(err.message, 'bad');
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Working…' : 'Rebuild with the current prompt'}
        </button>
      </div>
      {files.length ? (
        <div className="l2-table-wrap">
          <table className="l2-table">
            <thead>
              <tr><th scope="col">File</th><th scope="col">Version</th><th scope="col">Updated</th><th scope="col"><span className="sr-only">Copy</span></th></tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.name}>
                  <td><code>{f.name}</code></td>
                  <td>{f.prompt_version || '?'}</td>
                  <td title={f.updated_at ? fmtDateTime(f.updated_at) : undefined}>{fmtAgo(f.updated_at)}</td>
                  <td><CopyText getText={() => api.text(`/api/projects/${enc(pid)}/prompt-file?name=${enc(f.name)}`)} label="Copy" aria={`Copy ${f.name}`} dataKey={`copy-file-${f.name}`} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <None>No prompt files.</None>}
    </section>
  );
}

function Runs({ d, row, pid, wantRun, hostedOn }) {
  const runs = (d.research && d.research.runs) || [];
  const rc = d.research_contract || null;
  const archived = d.project && d.project.status === 'archived';
  return (
    <>
      <div className="rc-top">
        {rc ? <p className="rc-line" title="Earlier runs and their reports keep the prompt, profile and rubric they were made with.">{`A new run uses ${rc.prompt_version} with the scoring profile ${rc.sector_profile}${rc.category_grades ? ` (${rc.category_grades} category grades)` : ''} and ${rc.rubric_version}.`}</p> : null}
        {archived ? null : (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            data-key="rt-run"
            onClick={async () => {
              try {
                const L = await loadLegacy();
                L.openResearchDialog(legacyCtx, { ...row, ...d.project, research: row.research, report_count: d.reports.length });
              } catch (err) {
                toast(err.message, 'bad');
              }
            }}
          >
            <Play size={14} aria-hidden="true" />{runs.length ? 'Run research again' : 'Run research'}
          </button>
        )}
      </div>
      {runs.length ? runs.map((run) => (run && run.broken
        ? <p key={run.run_id} id={`run-card-${run.run_id}`} className="note note-bad rc-broken" role="note">{`Run ${run.run_id} could not be read: ${run.error || 'unknown error'}`}</p>
        : <RunCard key={run.run_id} d={d} pid={pid} run={run} wantRun={wantRun} hostedOn={hostedOn} />)) : <None>No research runs yet.</None>}
      <StandingPrompts d={d} pid={pid} />
    </>
  );
}

// ---- 3. your headline ---------------------------------------------------------------

function headlineText(hl) {
  if (!hl) return 'No headline chosen. A median across models is never used as the headline.';
  if (hl.type === 'missing') return hl.message;
  if (hl.type === 'decision') return `Your decision: ${hl.decision || 'no label'}${hl.conviction ? `, conviction ${hl.conviction}` : ''} (${fmtDate(hl.created_at)})`;
  return `${PROVIDER_LABELS[hl.provider] || hl.provider} report of ${fmtDate(hl.analysis_at)}: ${hl.grade && hl.grade.display ? `${hl.grade.display} ${hl.grade.label || ''}`.trim() : 'no grade'} · ${hl.verdict || 'no verdict'}`;
}

// Why a report is not compared, in the desk's words; null when it is.
function standingOf(r) {
  const why = ineligibleReason(r);
  if (!why) return null;
  if (why.kind === 'quarantined') return { text: 'Quarantined: it does not match its research run', tone: 'bad' };
  if (why.kind === 'excluded') return { text: `Excluded from comparison${why.reason ? `: ${why.reason}` : ''}`, tone: 'warn' };
  if (why.kind === 'pdf') return { text: 'PDF without a text copy', tone: 'warn' };
  return { text: 'Could not be read', tone: 'bad' };
}

function Headline({ d, pid }) {
  const [busy, setBusy] = useState(false);
  const hl = d.headline || null;
  const isSet = Boolean(hl) || Boolean(d.project && d.project.headline);
  const reports = (d.reports || []).filter((r) => r && !r.broken && r.meta);
  const decisions = (d.journal || []).filter((j) => j && j.type === 'decision');
  const latestIds = new Set(Object.values((d.comparison && d.comparison.latest) || {}).filter(Boolean).map((x) => x.report_id));
  const pinnedReport = hl && hl.type === 'report' ? hl.report_id : null;
  const pinnedEntry = hl && hl.type === 'decision' ? hl.entry_id : null;
  return (
    <>
      <div className="rc-top">
        <p className="rc-line" data-key="hl-now">{headlineText(hl)}</p>
        {isSet ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            data-key="hl-clear"
            disabled={busy}
            onClick={async () => {
              if (busy) return;
              setBusy(true);
              try {
                await api.post(`/api/projects/${enc(pid)}/headline`, { clear: true });
                toast('Headline cleared');
                await refresh();
              } catch (err) {
                toast(err.message, 'bad');
              } finally {
                setBusy(false);
              }
            }}
          >
            Clear
          </button>
        ) : null}
      </div>
      {reports.length ? (
        <section className="rc-sub" aria-labelledby="hl-reports-h">
          <h3 id="hl-reports-h" className="rc-h3">Reports</h3>
          <ul className="l2-rows rc-pins">
            {reports.map((r) => {
              const a = r.assessment || {};
              const who = PROVIDER_LABELS[r.meta.provider] || r.meta.provider;
              const when = a.analysis_at ? fmtDate(a.analysis_at) : 'Undated';
              const standing = standingOf(r);
              const pinned = pinnedReport === r.report_id;
              return (
                <li key={r.report_id} data-key={`hl-report-${r.report_id}`}>
                  <div className="rc-pin-t">
                    <p><strong>{who}</strong>{` · ${when} · ${gradeWords(r.grade, Boolean(a.needs_text))} · ${verdictWords(a.verdict)}`}{latestIds.has(r.report_id) ? <span className="faint">{' · latest'}</span> : null}</p>
                    {standing ? <p className={`rc-standing is-${standing.tone}`}>{standing.text}</p> : null}
                    <p className="faint l2-mono">{r.report_id}</p>
                  </div>
                  {pinned ? <span className="badge is-accent">Headline</span> : (
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-label={`Pin the ${who} report of ${when} as headline`}
                      data-key={`hl-pin-${r.report_id}`}
                      disabled={busy}
                      onClick={async () => {
                        if (busy) return;
                        setBusy(true);
                        try {
                          await api.post(`/api/projects/${enc(pid)}/headline`, { report_id: r.report_id });
                          toast('Headline updated');
                          await refresh();
                        } catch (err) {
                          toast(err.message, 'bad');
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      <Pin size={13} aria-hidden="true" />Pin as headline
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {decisions.length ? (
        <section className="rc-sub" aria-labelledby="hl-decisions-h">
          <h3 id="hl-decisions-h" className="rc-h3">Your decisions</h3>
          <ul className="l2-rows rc-pins">
            {decisions.map((j) => {
              const when = fmtDate(j.created_at);
              const pinned = pinnedEntry === j.entry_id;
              return (
                <li key={j.entry_id} data-key={`hl-decision-${j.entry_id}`}>
                  <div className="rc-pin-t">
                    <p><strong>Your decision</strong>{` · ${when} · ${words(j.decision) || 'no label'}${j.conviction ? ` (${j.conviction})` : ''}`}</p>
                    {j.text ? <p className="muted">{j.text}</p> : null}
                  </div>
                  {pinned ? <span className="badge is-accent">Headline</span> : (
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-label={`Pin your decision of ${when} as headline`}
                      data-key={`hl-pin-${j.entry_id}`}
                      disabled={busy}
                      onClick={async () => {
                        if (busy) return;
                        setBusy(true);
                        try {
                          await api.post(`/api/projects/${enc(pid)}/headline`, { entry_id: j.entry_id });
                          toast('Headline updated');
                          await refresh();
                        } catch (err) {
                          toast(err.message, 'bad');
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      <Pin size={13} aria-hidden="true" />Pin as headline
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {!reports.length && !decisions.length ? <None>No report or decision to pin yet.</None> : null}
    </>
  );
}

// ---- 4. report history and revisions -------------------------------------------------

function historyStanding(s, latestId) {
  if (!s || s.broken) return { text: 'Could not be read', tone: 'bad' };
  if (s.quarantined) return { text: 'Quarantined: it does not match its research run', tone: 'bad' };
  if (s.excluded_reason) return { text: `Excluded from comparison: ${s.excluded_reason}`, tone: 'warn' };
  if (s.eligible === false) return { text: 'Excluded from comparison', tone: 'warn' };
  if (s.needs_text) return { text: 'PDF without a text copy', tone: 'warn' };
  return { text: s.report_id === latestId ? 'Latest eligible report' : 'Eligible', tone: '' };
}

function DiffList({ diffs, who }) {
  return (
    <section className="rc-sub" aria-label={`How ${who}'s reports changed`}>
      <h4 className="rc-h4">{`How ${who}'s reports changed`}</h4>
      <ul className="l2-rows">
        {diffs.map((x) => (
          <li key={`${x.from}-${x.to}`}>
            <p className="rc-line"><span className="l2-mono">{x.from}</span>{' → '}<span className="l2-mono">{x.to}</span>{x.comparable ? null : <span className="muted" title={x.note || undefined}>{' · different rubric, profile or horizon'}</span>}</p>
            {(x.changes || []).length ? (
              <ul className="l2-list rc-changes">
                {x.changes.map((chg, i) => <li key={`${chg.section}-${chg.id}-${i}`}>{`${chg.section} · ${chg.id}: ${fmtScore(chg.from)} → ${fmtScore(chg.to)}${chg.delta !== null && chg.delta !== undefined ? ` (${chg.delta > 0 ? '+' : ''}${chg.delta})` : ''}`}</li>)}
              </ul>
            ) : <p className="muted rc-line">No score changes.</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function History({ d, pid }) {
  const groups = PROVIDERS.map((p) => ({
    p,
    list: ((d.history && d.history[p]) || []).slice().reverse(),
    diffs: ((d.diffs && d.diffs[p]) || []).slice().reverse(),
    latest: d.comparison && d.comparison.latest && d.comparison.latest[p] ? d.comparison.latest[p].report_id : null,
  })).filter((g) => g.list.length || g.diffs.length);
  if (!groups.length) return <None>No reports imported yet.</None>;
  return (
    <>
      {groups.map(({ p, list, diffs, latest }) => {
        const who = PROVIDER_LABELS[p];
        return (
          <section key={p} className="rc-sub" aria-labelledby={`rc-hist-${p}-h`}>
            <h3 id={`rc-hist-${p}-h`} className="rc-h3">{`${who} · ${plural(list.length, 'report')}`}</h3>
            <ul className="l2-rows rc-hist">
              {list.map((s) => {
                const when = s.analysis_at ? fmtDate(s.analysis_at) : 'Undated';
                const standing = historyStanding(s, latest);
                return (
                  <li key={s.report_id} data-key={`hist-${s.report_id}`}>
                    <p className="rc-line">
                      <strong>{when}</strong>
                      {` · ${gradeWords(s.grade, s.needs_text)} · ${verdictWords(s.verdict)} · `}
                      <a href={`#/project/${enc(pid)}/report?report=${enc(s.report_id)}&model=${p}`} aria-label={`The ${who} report of ${when}`} data-key={`hist-open-${s.report_id}`}>The report</a>
                    </p>
                    <p className={`rc-standing${standing.tone ? ` is-${standing.tone}` : ''}`}>{standing.text}</p>
                    {s.revision_label ? <p className="muted rc-line">{s.revision_label}</p> : null}
                    <p className="faint l2-mono">{s.report_id}</p>
                  </li>
                );
              })}
            </ul>
            {diffs.length ? <DiffList diffs={diffs} who={who} /> : null}
          </section>
        );
      })}
    </>
  );
}

// ---- 5. technical records ---------------------------------------------------------

function IssuesList({ ex }) {
  const issues = (ex && ex.issues) || [];
  const amb = (ex && ex.ambiguous) || [];
  return (
    <div className="rc-issues">
      {ex && ex.note ? <p className="muted rc-line">{ex.note}</p> : null}
      {amb.length ? (
        <>
          <h4 className="rc-h4">Ambiguous values (need your correction)</h4>
          <ul className="l2-list">
            {amb.map((x, i) => (
              <li key={`${x.field}-${i}`}>
                <strong>{x.field}</strong>{`: ${x.reason}`}{x.line ? ` (line ${x.line})` : ''}
                {x.candidates ? (
                  <ul className="l2-list">
                    {x.candidates.map((c, k) => <li key={k}>{`${typeof c.value === 'object' ? JSON.stringify(c.value) : c.value}${c.line ? ` — line ${c.line}: ${c.excerpt || ''}` : ''}`}</li>)}
                  </ul>
                ) : x.excerpt ? <div className="faint">{x.excerpt}</div> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {issues.length ? (
        <>
          <ul className="l2-list">
            {issues.slice(0, 80).map((i, k) => (
              <li key={`${i.field}-${k}`}><strong>{i.severity === 'error' ? 'Error' : i.severity === 'warning' ? 'Warning' : 'Note'}</strong>{' · '}<code>{i.field}</code>{` ${i.message}`}</li>
            ))}
          </ul>
          {issues.length > 80 ? <p className="faint rc-line">{`80 of ${issues.length} shown.`}</p> : null}
        </>
      ) : <p className="muted rc-line">No validation issues.</p>}
    </div>
  );
}

// The normalized record as saved (the first extraction), read only when
// opened; downloaded from the same address.
function Normalized({ pid, rid }) {
  const [busy, setBusy] = useState(false);
  const path = `/api/projects/${enc(pid)}/reports/${enc(rid)}/record`;
  return (
    <Fold dataKey={`json-${rid}`} lazy title="Normalized data (JSON)" note="The first extraction, as saved. Corrections are separate files and never edit this record.">
      <div className="l2-actions">
        <button
          type="button"
          className="btn btn-sm"
          data-key={`json-dl-${rid}`}
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={async () => {
            setBusy(true);
            try {
              await api.download(path, `${rid}-report.json`);
            } catch (err) {
              toast(err.message, 'bad');
            } finally {
              setBusy(false);
            }
          }}
        >
          <Download size={13} aria-hidden="true" />Download JSON
        </button>
      </div>
      <LazyPre path={path} loading="Loading the extracted record…" failed="The record could not be loaded" keepScroll={`json-${rid}`} />
    </Fold>
  );
}

function bindingText(binding, mp) {
  if (binding) {
    const head = binding.status === 'bound' ? 'Bound to its run' : words(binding.status || 'not bound');
    const conflicts = (binding.conflicts || []).length ? ` · ${binding.conflicts.length} conflict${binding.conflicts.length === 1 ? '' : 's'}` : '';
    const fields = binding.fields ? ` · ${Object.entries(binding.fields).map(([k, v]) => `${words(k)} ${v}`).join(', ')}` : '';
    return `${head}${conflicts}${fields}`;
  }
  return mp.research_run_id ? 'Saved for its run' : 'Not part of a run';
}

function Technical({ d, pid, prov, reportId }) {
  const latest = d.comparison && d.comparison.latest && d.comparison.latest[prov] ? d.comparison.latest[prov].report_id : null;
  const rid = reportId || latest;
  if (!rid) return <None>{`No ${PROVIDER_LABELS[prov]} report to show here yet.`}</None>;
  const r = (d.reports || []).find((x) => x && x.report_id === rid) || null;
  if (!r) return <None>{`Report ${rid} is not in this project's record.`}</None>;
  if (r.broken) return <p className="l2-err" role="alert">{`${r.report_id}: ${r.error || 'the report could not be read'}`}</p>;
  const a = r.assessment || {};
  const meta = r.meta || {};
  const integ = r.integrity || {};
  const ex = r.extraction || {};
  const mp = meta.provenance || {};
  const hasNotes = (ex.issues || []).length || (ex.ambiguous || []).length || ex.note;
  return (
    <>
      <p className="rc-line rc-which">
        <strong>{PROVIDER_LABELS[meta.provider] || meta.provider}</strong>
        {` · ${a.analysis_at ? fmtDate(a.analysis_at) : 'Undated'} · `}
        <span className="l2-mono">{r.report_id}</span>
      </p>
      <KV
        label="How the report was read and saved"
        rows={[
          ['Citation structure', integ.status === 'valid' ? 'References resolve to listed sources (a structural check only)' : `Citation issues: ${integ.status || 'not checked'}`, null, true],
          ['Read from', a.source_format === 'prose' ? 'The written report (no data block)' : a.source_format || 'Not recorded'],
          ['Binding to its run', bindingText(mp.binding || null, mp), null, true],
          ['Your corrections', (r.corrections || []).length ? `${r.corrections.length}; the original is unchanged` : 'None'],
          ['Original file', meta.original_filename || meta.original_file || 'Not recorded'],
        ]}
      />
      {(integ.issues || []).length ? (
        <ul className="l2-list">
          {integ.issues.map((i, k) => <li key={k}><code>{i.path || i.field || ''}</code>{` ${i.message}`}</li>)}
        </ul>
      ) : null}
      {hasNotes ? (
        <section className="rc-sub" aria-labelledby={`rc-notes-${r.report_id}-h`}>
          <h3 id={`rc-notes-${r.report_id}-h`} className="rc-h3">Extraction notes</h3>
          <IssuesList ex={ex} />
        </section>
      ) : null}
      <Normalized pid={pid} rid={r.report_id} />
    </>
  );
}

// ---- 6. forensic receipts and challenges ------------------------------------------

// GET /api/projects/<id>/forensics (a read; it writes nothing), asked for
// when this fold is first opened and again when the project's record changes;
// cancelled when the reader leaves.
function useForensicReceipts(pid) {
  useDesk();
  const gen = desk.projectGen.get(pid) || 0;
  const key = `${pid}#${gen}`;
  const [st, setSt] = useState({ pid: null, v: null, error: null });
  useEffect(() => {
    const ctrl = new AbortController();
    api.get(`/api/projects/${enc(pid)}/forensics`, { signal: ctrl.signal }).then(
      (v) => { if (!ctrl.signal.aborted) setSt({ pid, v, error: null }); },
      (error) => { if (!ctrl.signal.aborted && error.name !== 'AbortError') setSt((s) => ({ pid, v: s.pid === pid ? s.v : null, error })); },
    );
    return () => ctrl.abort();
  }, [key]);
  return st.pid === pid ? st : { v: null, error: null };
}

const forensicsHref = (pid, rid) => `#/project/${enc(pid)}/forensics?receipt=${enc(rid)}&fx=receipts`;

function ForensicReceipts({ pid }) {
  const { v, error } = useForensicReceipts(pid);
  if (error && !v) return <p className="l2-err" role="alert">{`The forensic receipts could not be read: ${error.message}`}</p>;
  if (!v) return <p className="faint" role="status">Reading the forensic receipts…</p>;
  const receipts = Array.isArray(v.receipts) ? v.receipts : [];
  const challenges = Array.isArray(v.challenges) ? v.challenges.slice().reverse() : [];
  if (!receipts.length && !challenges.length) return <None>No forensic receipt yet.</None>;
  const model = (m) => (m ? `${PROVIDER_LABELS[m.provider] || m.label || m.provider || '?'}${m.model_version ? ` · ${m.model_version}` : ''}` : '?');
  return (
    <>
      {error ? <p className="l2-err" role="alert">{`Could not read them again: ${error.message}`}</p> : null}
      {receipts.length ? (
        <section className="rc-sub" aria-labelledby="rc-fx-receipts-h">
          <h3 id="rc-fx-receipts-h" className="rc-h3">{`Assessment receipts · ${receipts.length}`}</h3>
          <div className="l2-table-wrap">
            <table className="l2-table rc-fx">
              <thead>
                <tr>
                  <th scope="col">Receipt</th>
                  <th scope="col">Model</th>
                  <th scope="col">Assessed</th>
                  <th scope="col">Origin</th>
                  <th scope="col">Saved</th>
                  <th scope="col">Method</th>
                  <th scope="col">Revision</th>
                  <th scope="col">Predecessor</th>
                  <th scope="col">Original</th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {receipts.map((r) => (
                  <tr key={r.receipt_id} data-key={`rc-fx-${r.receipt_id}`}>
                    <td><span className="l2-mono">{r.receipt_id}</span>{r.latest ? <span className="faint">{' · latest'}</span> : null}</td>
                    <td>{model(r.model)}</td>
                    <td>{fmtDate(r.assessment_as_of || r.origin)}</td>
                    <td>{`${fmtDateTime(r.origin)}${r.origin_basis === 'inherited' ? ' (kept)' : ''}`}</td>
                    <td>{fmtDateTime(r.saved_at)}</td>
                    <td><span className="l2-mono">{r.method || '—'}</span></td>
                    <td>
                      {r.revision_of ? <span>{`revision of ${r.revision_of}${r.revision && r.revision.kind ? ` · ${words(r.revision.kind)}` : ''}`}</span> : <span className="faint">—</span>}
                      {r.revision && r.revision.note ? <span className="muted">{` · Why: ${r.revision.note}`}</span> : null}
                    </td>
                    <td>{r.predecessor && r.predecessor.receipt_id ? <span className="l2-mono">{r.predecessor.receipt_id}</span> : <span className="faint">—</span>}</td>
                    <td>{r.integrity_ok ? 'Agrees with its original' : <span className="rc-err">Does not agree with its original</span>}</td>
                    <td>
                      <div className="rc-acts">
                        <a href={forensicsHref(pid, r.receipt_id)} data-key={`rc-fx-open-${r.receipt_id}`}>Open in Forensics</a>
                        <TextButton pid={pid} rid={r.receipt_id} sha={r.text_sha256} label="Read the original" dataKey={`rc-fx-text-${r.receipt_id}`} />
                        {r.integrity_ok ? <CaseButton pid={pid} rid={r.receipt_id} /> : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {challenges.length ? (
        <section className="rc-sub" aria-labelledby="rc-fx-challenges-h">
          <h3 id="rc-fx-challenges-h" className="rc-h3">{`Challenge receipts · ${challenges.length}`}</h3>
          <div className="l2-table-wrap">
            <table className="l2-table rc-fx">
              <thead>
                <tr>
                  <th scope="col">Receipt</th>
                  <th scope="col">Challenges</th>
                  <th scope="col">Model</th>
                  <th scope="col">Saved</th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {challenges.map((c) => (
                  <tr key={c.receipt_id} data-key={`rc-fxc-${c.receipt_id}`}>
                    <td><span className="l2-mono">{c.receipt_id}</span></td>
                    <td>{c.challenges_receipt_id ? <a href={forensicsHref(pid, c.challenges_receipt_id)} className="l2-mono" data-key={`rc-fxc-of-${c.receipt_id}`}>{c.challenges_receipt_id}</a> : <span className="faint">—</span>}</td>
                    <td>{model(c.model)}</td>
                    <td>{fmtDateTime(c.saved_at)}</td>
                    <td><TextButton pid={pid} rid={c.receipt_id} sha={c.text_sha256} label="Read the original" dataKey={`rc-fxc-text-${c.receipt_id}`} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  );
}

// ---- the section --------------------------------------------------------------------

export default function Record({ d, row, pid, prov, reportId, route }) {
  useDesk();
  const ref = useRef(null);
  const q = route && route.query ? route.query : new URLSearchParams();
  const wantRun = q.get('run') || null;
  const openParam = q.get('open') || null;
  const hostedOn = hosted();
  const runs = (d.research && d.research.runs) || [];
  const p = prov || 'claude';
  const rowSafe = row || {};

  // An address naming a run (?run=<id>) opens the runs and that run's details
  // before the page brings its card into view (the run cards are drawn at
  // once then, so the page finds #run-card-<id>).
  useLayoutEffect(() => {
    if (!wantRun && openParam !== 'runs') return;
    const root = ref.current;
    if (!root) return;
    const runsFold = root.querySelector('details[data-key="pb-runs"]');
    if (runsFold && !runsFold.open) runsFold.open = true;
    if (wantRun) {
      const det = root.querySelector(`details[data-key="run-${CSS.escape(wantRun)}"]`);
      if (det && !det.open) det.open = true;
    }
  }, [wantRun, openParam]);

  // The report the technical records are of: the one chosen on the page, else
  // the chosen model's latest eligible report.
  const tech = reportId || (d.comparison && d.comparison.latest && d.comparison.latest[p] ? d.comparison.latest[p].report_id : null);
  const techReport = tech ? (d.reports || []).find((x) => x && x.report_id === tech) || null : null;
  const techWho = techReport && techReport.meta ? PROVIDER_LABELS[techReport.meta.provider] || techReport.meta.provider : null;
  return (
    <div className="l2-stack rc" ref={ref}>
      <ResearchDetails d={d} pid={pid} />
      <Panel className="rc-folds">
        <Fold
          dataKey="pb-runs"
          title="Research runs"
          count={runs.length || null}
          lazy={!wantRun}
          defaultOpen={Boolean(wantRun) || openParam === 'runs'}
          note="Each run sends every chosen model the same prompt, rubric, horizon and dated evidence packet. Jobs are independent: one failure never erases another model's result. Pending means not saved yet."
        >
          <Runs d={d} row={rowSafe} pid={pid} wantRun={wantRun} hostedOn={hostedOn} />
        </Fold>
        <Fold dataKey="pb-headline" title="Your headline" lazy note="The headline is your choice: one report, or one of your own decisions.">
          <Headline d={d} pid={pid} />
        </Fold>
        <Fold dataKey="rec-history" title="Report history and revisions" count={(d.reports || []).length || null} lazy note="Every saved report per model, newest first, with its revision and why a report is excluded or quarantined.">
          <History d={d} pid={pid} />
        </Fold>
        <Fold dataKey="pb-technical" title={`Technical records${techWho ? ` · ${techWho}` : ''}`} lazy note="How the report was read and saved: citation structure, extraction notes, the binding to its run, corrections, and the normalized data as saved.">
          <Technical d={d} pid={pid} prov={p} reportId={reportId} />
        </Fold>
        <Fold dataKey="rec-forensic" title="Forensic receipts and challenges" lazy note="Each forensic assessment and ChatGPT challenge as saved: create-only receipts, each with its original text and case package.">
          <ForensicReceipts pid={pid} />
        </Fold>
      </Panel>
    </div>
  );
}
