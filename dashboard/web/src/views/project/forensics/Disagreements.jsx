// The disagreement board (core/forensic-disagreements.js,
// cr-forensic-adjudication@1): each finding of the shown assessment that
// ChatGPT's challenge of that exact receipt reviewed as overstated,
// unsupported or needing evidence. Both positions as saved, their receipts
// and sources, what would resolve it, and Eric's judgment (unresolved,
// challenge accepted, challenge rejected) with his reason. A judgment is his
// workflow decision: no opinion, grade or holding changes. The judgment is
// sent only from its button, with one request ID per attempt kept until it
// is answered, so a retry after a lost answer is "unchanged".
import { useState } from 'react';
import { fmtDateTime, toast } from '../../../../../public/ui.js';
import { api, refresh } from '../../../lib/desk.js';
import { hrefWith } from '../../../lib/router.js';
import { enc, words, requestId } from './fmt.js';
import { TextButton } from './TextButton.jsx';

const VERDICT = { overstated: 'Overstated', unsupported: 'Unsupported', needs_evidence: 'Needs evidence' };
const STATE = { unjudged: 'No judgment yet', unresolved: 'Unresolved', challenge_accepted: 'Challenge accepted', challenge_rejected: 'Challenge rejected' };
const BY = { claude: 'Claude', chatgpt: 'ChatGPT' };

function SourceLinks({ ids, find }) {
  if (!ids || !ids.length) return <span className="faint">No source cited</span>;
  return (
    <span className="fx-srcs">
      {ids.map((id) => {
        const s = find(id);
        return s && s.url ? <a key={id} className="fx-src" href={s.url} target="_blank" rel="noopener noreferrer" title={[s.publisher, s.url].filter(Boolean).join(' · ')}>{id}</a> : <span key={id} className="fx-src is-missing" title="Not in this receipt's source list">{id}</span>;
      })}
    </span>
  );
}

function Judge({ pid, item }) {
  const [judgment, setJudgment] = useState(item.judgment ? item.judgment.judgment : 'unresolved');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  // One ID per attempt: kept across a retry, renewed once answered.
  const [rid, setRid] = useState(() => requestId('fj'));
  const base = `fx-dg-${item.disagreement_id}`;
  const short = reason.trim().length < 10;
  return (
    <form
      className="fx-dg-judge"
      aria-labelledby={`${base}-jh`}
      onSubmit={(e) => e.preventDefault()}
    >
      <fieldset className="fx-dg-choices">
        <legend id={`${base}-jh`} className="fx-label">Your judgment</legend>
        {Object.entries({ unresolved: STATE.unresolved, challenge_accepted: STATE.challenge_accepted, challenge_rejected: STATE.challenge_rejected }).map(([k, w]) => (
          <label key={k} className="fx-dg-choice">
            <input type="radio" name={`${base}-j`} value={k} checked={judgment === k} onChange={() => setJudgment(k)} data-key={`${base}-${k}`} />
            {w}
          </label>
        ))}
      </fieldset>
      <label className="fx-label" htmlFor={`${base}-reason`}>Why (a sentence, required)</label>
      <textarea id={`${base}-reason`} className="fx-textarea fx-textarea-s" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} data-key={`${base}-reason`} aria-describedby={`${base}-means`} />
      <p id={`${base}-means`} className="sr-only">A judgment is your workflow decision. It is not verification, and no grade, finding, report or holding changes.</p>
      <button
        type="button"
        className="btn btn-sm"
        disabled={busy || short}
        aria-busy={busy || undefined}
        data-key={`${base}-save`}
        title={short ? 'Write at least a sentence (10 characters).' : 'Records your judgment beside both opinions; neither opinion changes.'}
        onClick={async () => {
          setBusy(true);
          try {
            const out = await api.post(`/api/projects/${enc(pid)}/forensics/judgments`, { disagreement_id: item.disagreement_id, judgment, reason: reason.trim(), request_id: rid });
            toast((out.result && out.result.status) === 'unchanged' ? 'Already recorded: nothing changed' : `Judgment saved: ${STATE[judgment]}. Both opinions stay as saved.`);
            setReason('');
            setRid(requestId('fj'));
            await refresh();
          } catch (err) {
            toast(err.status === 401 ? 'Your session has ended. Sign in again to save the judgment.' : err.message, 'bad');
            if (err.status && err.status < 500) setRid(requestId('fj'));
            await refresh();
          } finally {
            setBusy(false);
          }
        }}
      >
        Save judgment
      </button>
    </form>
  );
}

function Item({ pid, item, v }) {
  const idx = (v.current && v.current.source_index) || {};
  const chSources = (v.challenge && v.challenge.sources) || [];
  const c = item.claude;
  const ch = item.challenge;
  const base = `fx-dg-${item.disagreement_id}`;
  // Each side's exact receipt: its original text (pin checked), and for a
  // revised assessment the receipt it revises.
  const cur = v.current && v.current.receipt_id === c.receipt_id ? v.current : null;
  const chal = v.challenge && v.challenge.receipt_id === ch.receipt_id ? v.challenge : null;
  return (
    <article className={`fx-dg is-${item.state}`} aria-labelledby={`${base}-h`} data-key={base}>
      <p className="fx-dg-top">
        <b id={`${base}-h`}>{`Finding ${item.finding_id}`}</b>
        <span className="fx-dg-v">{`Challenge: ${VERDICT[ch.verdict] || words(ch.verdict)}`}</span>
        <span className={`fx-th-st is-${item.state === 'unjudged' || item.state === 'unresolved' ? 'open' : 'reviewed'}`}>{STATE[item.state]}</span>
      </p>
      <div className="fx-dg-sides">
        <section className="fx-dg-side" aria-label={`Claude's finding, receipt ${c.receipt_id}`}>
          <h4 className="fx-h4">{`Claude · ${c.receipt_id}`}</h4>
          {c.missing ? <p className="faint">This finding is not in the assessment the challenge names.</p> : (
            <>
              <p className="fx-dg-text">{c.statement}</p>
              <p className="faint">{[c.shown_kind ? `Read as ${c.shown_kind}${c.original_kind && c.original_kind !== c.shown_kind ? ` (stated as ${c.original_kind})` : ''}` : null, c.standing ? words(c.standing) : null, c.confidence ? `${c.confidence} confidence` : null].filter(Boolean).join(' · ')}</p>
              {c.alternative_explanation ? <p className="faint">{`Alternative it names: ${c.alternative_explanation}`}</p> : null}
            </>
          )}
          <p className="fx-dg-src"><span className="faint">Sources </span><SourceLinks ids={c.source_ids} find={(id) => idx[id]} /></p>
          <p className="fx-dg-links">
            <TextButton pid={pid} rid={c.receipt_id} sha={cur ? cur.text_sha256 : null} label="Claude's original" dataKey={`${base}-text-claude`} />
            {cur && cur.revision_of ? <a href={hrefWith({ receipt: cur.revision_of })} data-key={`${base}-revises`}>{`Revises ${cur.revision_of}`}</a> : null}
          </p>
        </section>
        <section className="fx-dg-side" aria-label={`ChatGPT's challenge, receipt ${ch.receipt_id}`}>
          <h4 className="fx-h4">{`ChatGPT · ${ch.receipt_id}`}</h4>
          {[['Attribution', ch.attribution_check], ['Calculation', ch.calculation_check], ['Benign explanation', ch.benign_explanation], ['Omitted evidence', ch.omitted_evidence]].filter(([, t]) => t).map(([k, t]) => <p key={k} className="fx-dg-text"><span className="faint">{`${k}: `}</span>{t}</p>)}
          {ch.benign_explanations.map((b, i) => <p key={i} className="faint">{`Also offered: ${b.explanation} (plausibility ${b.plausibility})`}</p>)}
          <p className="fx-dg-src"><span className="faint">Sources </span><SourceLinks ids={ch.source_ids} find={(id) => chSources.find((s) => s.source_id === id)} /></p>
          <p className="fx-dg-links">
            <TextButton pid={pid} rid={ch.receipt_id} sha={chal ? chal.text_sha256 : null} label="ChatGPT's original" dataKey={`${base}-text-chatgpt`} />
            <span className="faint">{`Challenges ${c.receipt_id} exactly (its block ${String(c.block_sha256 || '').slice(0, 10)}…)`}</span>
          </p>
        </section>
      </div>
      <div className="fx-dg-resolve">
        <h4 className="fx-h4">What would resolve it</h4>
        {item.resolve_with.length ? <ul className="fx-list">{item.resolve_with.map((r, i) => <li key={i}><span className="faint">{`${BY[r.by]}, ${r.what.toLowerCase()}: `}</span>{r.text}</li>)}</ul> : <p className="faint">Neither report names the evidence that would settle it.</p>}
      </div>
      {item.judgment ? <p className="fx-dg-last">{`Your judgment: ${STATE[item.judgment.judgment]} · ${fmtDateTime(item.judgment.judged_at)}`}<span className="faint">{` · ${item.judgment.reason}`}</span></p> : null}
      <Judge pid={pid} item={item} />
      {item.history.length > 1 ? (
        <details className="fx-th-hist" data-key={`${base}-hist`}>
          <summary>{`Your judgments of this disagreement (${item.history.length})`}</summary>
          <ul className="fx-list">{[...item.history].reverse().map((j) => <li key={j.judgment_id}>{`${fmtDateTime(j.judged_at)} · ${STATE[j.judgment]}`}<span className="faint">{` · ${j.reason}`}</span></li>)}</ul>
        </details>
      ) : null}
      {item.earlier.length ? (
        <details className="fx-th-hist" data-key={`${base}-earlier`}>
          <summary>{`Earlier judgments of ${item.finding_id}, on other receipts (${item.earlier.length})`}</summary>
          <p className="faint">Judged on another assessment or challenge: not carried over to this one.</p>
          <ul className="fx-list">{item.earlier.map((j) => <li key={j.judgment_id}>{`${fmtDateTime(j.judged_at)} · ${STATE[j.judgment]} · ${j.assessment_receipt_id} and ${j.challenge_receipt_id}`}<span className="faint">{` · ${j.reason}`}</span></li>)}</ul>
        </details>
      ) : null}
    </article>
  );
}

export function Disagreements({ v, pid }) {
  const d = v.disagreements;
  if (!d || d.status !== 'compared' || !d.items.length) return null;
  return (
    <section className="fx-card fx-board" aria-labelledby="fx-board-h" data-key="fx-board">
      <div className="fx-head">
        <h2 id="fx-board-h" className="fx-h" tabIndex={-1}>Claude and ChatGPT disagree</h2>
        <span className="fx-head-sub">{`${d.open ? `${d.open} open` : 'All judged'} · ${d.items.length} disputed · ${d.supported} supported${d.unchecked.length ? ` · ${d.unchecked.length} not checked` : ''}`}</span>
      </div>
      <div className="fx-dgs">{d.items.map((i) => <Item key={i.disagreement_id} pid={pid} item={i} v={v} />)}</div>
      <p className="faint fx-act-note">{d.meaning}</p>
    </section>
  );
}
