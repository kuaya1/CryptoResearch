// The outcome learning register (core/forensic-outcomes.js,
// cr-forensic-outcome-register@1): per receipt, each conditional estimate
// as frozen at its origin, what the stored readings show since, whether
// their coverage lets the row be read at all, the recorded checkpoint lines
// with their methods, and Eric's own note. Kept apart, never pooled; no
// probability, calibration, ranking or accuracy figure.
import { useState } from 'react';
import { fmtDate, fmtDateTime, toast } from '../../../../../public/ui.js';
import { api, refresh } from '../../../lib/desk.js';
import { enc, readable, words, requestId } from './fmt.js';

const KIND = { deterioration: 'Deterioration', stabilization: 'Stabilization', recovery: 'Recovery', no_new_delivery: 'No new delivery' };
const OUT = { occurred: 'Occurred', not_occurred: 'Did not occur', unresolved: 'Unresolved', not_established: 'Not established' };
const EV = { liquidity_impairment: 'Liquidity', operational_degradation: 'Operations', delivery_inactivity: 'Delivery', confirmed_discontinuation: 'Discontinuation' };
const TONE = { unevaluable: 'none', not_due: 'none', not_estimated: 'none' };

function Note({ pid, rid, row }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [req, setReq] = useState(() => requestId('fn'));
  const id = `fx-or-note-${row.row_id}`;
  return (
    <div className="fx-or-note">
      {row.owner ? <p><span className="faint">Your note: </span>{row.owner.note}<span className="faint">{` · ${fmtDate(row.owner.noted_at)}${row.owner.history.length > 1 ? ` · ${row.owner.history.length} notes` : ''}`}</span></p> : null}
      {open ? (
        <>
          <label className="fx-label" htmlFor={id}>Your interpretation (yours, not an observed outcome)</label>
          <textarea id={id} className="fx-textarea fx-textarea-s" rows={2} value={text} onChange={(e) => setText(e.target.value)} data-key={id} />
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy || text.trim().length < 3}
            aria-busy={busy || undefined}
            data-key={`${id}-save`}
            onClick={async () => {
              setBusy(true);
              try {
                const out = await api.post(`/api/projects/${enc(pid)}/forensics/outcome-notes`, { receipt_id: rid, row_id: row.row_id, note: text.trim(), request_id: req });
                toast((out.result && out.result.status) === 'unchanged' ? 'Already noted' : 'Note saved: yours, beside the row; nothing else changes');
                setText('');
                setOpen(false);
                setReq(requestId('fn'));
                await refresh();
              } catch (err) {
                toast(err.status === 401 ? 'Your session has ended. Sign in again to save the note.' : err.message, 'bad');
                if (err.status && err.status < 500) setReq(requestId('fn'));
              } finally {
                setBusy(false);
              }
            }}
          >
            Save note
          </button>
          <button type="button" className="btn btn-sm btn-ghost" data-key={`${id}-cancel`} onClick={() => setOpen(false)}>Cancel</button>
        </>
      ) : <button type="button" className="btn-link" data-key={`${id}-open`} aria-expanded="false" onClick={() => setOpen(true)}>{row.owner ? 'Add another note' : 'Add your note'}</button>}
    </div>
  );
}

function Row({ pid, rid, row }) {
  const f = row.frozen || {};
  const o = row.observed;
  return (
    <li className={`fx-or-row is-${TONE[row.evaluation.state] || 'read'}`}>
      <p className="fx-or-top"><b>{row.label}</b>{row.kind ? <span className="faint">{` · ${KIND[row.kind] || words(row.kind)}`}</span> : null}<span className={`fx-or-st is-${row.evaluation.state}`}>{row.evaluation.short}</span></p>
      <dl className="fx-ch-dl fx-or-dl">
        <div><dt>Frozen at the origin</dt><dd>{readable(f.words || '—')}{f.assumption ? <span className="faint">{` · ${f.assumption}`}</span> : null}</dd></div>
        <div><dt>Observed</dt><dd>{o ? `${o.readings} usable reading${o.readings === 1 ? '' : 's'}${o.unknown_readings ? `, ${o.unknown_readings} that could not say` : ''}; longest gap ${o.max_gap_days} days (at most ${o.max_gap_allowed_days})${o.first_beyond ? `; first past the level ${fmtDate(o.first_beyond.day)}` : ''}${o.first_within ? `; first within it ${fmtDate(o.first_within.day)}` : ''}` : '—'}</dd></div>
        <div><dt>Reading</dt><dd>{readable(row.evaluation.words)}</dd></div>
      </dl>
      <Note pid={pid} rid={rid} row={row} />
    </li>
  );
}

function Checkpoints({ cps }) {
  const rec = cps.filter((c) => c.events.length);
  if (!rec.length) return <p className="faint">No checkpoint outcome recorded yet.</p>;
  return (
    <ul className="fx-list">
      {rec.map((c) => (
        <li key={c.checkpoint}>
          <b>{c.label}</b><span className="faint">{` · ${fmtDate(c.deadline)}`}</span>
          <ul className="fx-list">
            {c.events.map((e) => <li key={e.event}>{`${EV[e.event] || words(e.event)}: `}{e.lines.map((l, i) => <span key={l.entry_id}>{i ? ' → ' : ''}<span title={l.reason || undefined}>{`${OUT[l.outcome] || words(l.outcome)} (${l.manual ? 'your correction' : l.method}${l.corrects ? `, corrects ${l.corrects}` : ''})`}</span></span>)}</li>)}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function Episodes({ e }) {
  const all = Object.entries(e || {}).flatMap(([k, list]) => (list || []).map((x) => ({ k, ...x })));
  if (!all.length) return <p className="faint">No episode on record.</p>;
  return <ul className="fx-list">{all.map((x, i) => <li key={i}>{`${EV[x.k] || words(x.k)}${x.check ? ` (${x.check})` : ''}: from ${fmtDateTime(x.start_at || x.first_at)}`}{x.confirmed_at ? `, confirmed ${fmtDateTime(x.confirmed_at)}` : ''}{x.recovered_at ? `, recovered ${fmtDateTime(x.recovered_at)}` : x.end_at ? `, ended ${fmtDateTime(x.end_at)} (${words(x.end_reason)})` : ', ongoing'}</li>)}</ul>;
}

export function OutcomeRegister({ v, pid }) {
  const r = v.outcomes;
  if (!r) return null;
  return (
    <div className="fx-or">
      {r.items.length ? r.items.map((it) => (
        <section key={it.receipt_id} className="fx-or-receipt" aria-label={`Receipt ${it.receipt_id}`}>
          <h4 className="fx-h4">{`${it.receipt_id} · origin ${fmtDateTime(it.origin)}${it.scenarios_version ? ` · ${it.scenarios_version}` : ''}`}</h4>
          {it.note ? <p className="faint">{it.note}</p> : <ul className="fx-or-rows">{it.rows.map((row) => <Row key={row.row_id} pid={pid} rid={it.receipt_id} row={row} />)}</ul>}
          <h4 className="fx-h4">{`Checkpoint outcomes recorded${it.methods_recorded.length ? ` (${it.methods_recorded.join(', ')}; kept apart)` : ''}`}</h4>
          <Checkpoints cps={it.checkpoints} />
        </section>
      )) : <p className="none">No assessment receipt to read yet.</p>}
      <h4 className="fx-h4">Episodes on record (overlapping outcomes, each its own)</h4>
      <Episodes e={r.episodes} />
      {r.tally.length ? <p className="faint">{`Coverage: ${r.tally.map((t) => `${t.version}: ${t.evaluable} readable, ${t.unevaluable} unevaluable, ${t.not_due} not due, ${t.not_estimated} not estimated`).join('; ')}.`}</p> : null}
      <p className="faint fx-act-note">{r.meaning}</p>
    </div>
  );
}

export const registerCount = (v) => (v.outcomes ? v.outcomes.items.reduce((n, it) => n + it.rows.length, 0) : 0);
