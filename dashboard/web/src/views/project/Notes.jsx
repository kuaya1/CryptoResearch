// The project page's Notes section (#/project/<id>/notes): the review
// check-in band (CheckIn.jsx, the only Mark reviewed here), what changed since
// your last review, your conviction note and journal (your decisions with
// their reasons, each check-in's receipt), and your reviews, catalysts and
// price alerts. Everything here is yours, never sent to a model by default.
//
// Drawing it writes nothing. The writes are explicit buttons: Save note,
// Record decision, Add review, Add alert and Done. Each form keeps its own
// submission ID (the desk applies a repeated one once), renewed after a
// success; drafts live in the component, so a live update never clears them.
// Port of public/views/project.js historyTab. Styles: styles/report.css.
import { useEffect, useRef, useState } from 'react';
import { PROVIDER_LABELS, fmtDate, fmtDateTime, fmtAgo, fmtPrice, fmtSignedPct, submissionId, toast } from '../../../../public/ui.js';
import { checkInHref } from '../../../../public/project-routes.js';
import { api, refresh } from '../../lib/desk.js';
import { useDesk } from '../../lib/hooks.js';
import { CheckIn } from './CheckIn.jsx';
import { ViewLink } from './Overview.jsx';
import { Panel, usePager, Pager, enc } from './kit.jsx';
import '../../styles/report.css';

const words = (s) => String(s || '').replace(/_/g, ' ');
const DECISIONS = ['watch', 'research_more', 'accumulate', 'hold', 'trim', 'exit', 'avoid'];
const CONVICTIONS = ['low', 'medium', 'high'];

// A score as the digest names it (the legacy view's fmtScore).
function fmtScore(s) {
  if (s === null || s === undefined) return '—';
  if (typeof s === 'string' || typeof s === 'number') return String(s);
  if (s.status === 'scored') return String(s.value);
  if (s.status === 'range') return `${s.low}–${s.high}`;
  return s.status === 'not_applicable' ? 'N/A' : 'unknown';
}

// ---- what changed ----------------------------------------------------------------------

function Changes({ d }) {
  const ch = d.changes || {};
  const since = ch.since ? `Since ${ch.cursor_source === 'project created' ? 'the project was added' : fmtDateTime(ch.since)}` : null;
  const pc = ch.provider_changes || [];
  const runs = ch.research_runs || [];
  const journal = ch.journal_entries || [];
  const events = ch.events || [];
  const price = ch.price && typeof ch.price.change_pct === 'number' ? ch.price : null;
  return (
    <Panel id="nt-changes" title="What changed since your last review" sub={since} note={ch.note || 'A digest proposes what to look at. It never changes grades, reports or your headline.'}>
      {ch.item_count ? (
        <>
          {pc.length ? (
            <div className="l2-table-wrap">
              <table className="l2-table">
                <thead><tr><th scope="col">Model</th><th scope="col">Grade</th><th scope="col">Verdict</th><th scope="col">Score changes</th></tr></thead>
                <tbody>
                  {pc.map((c, i) => (
                    <tr key={`${c.provider}-${i}`}>
                      <td className="nowrap">{PROVIDER_LABELS[c.provider] || c.provider}</td>
                      <td className="nowrap">{`${c.grade_from || (c.from_report ? 'none' : 'new')} → ${c.grade_to || 'none'}`}</td>
                      <td>{c.verdict_from === c.verdict_to ? c.verdict_to || '—' : `${c.verdict_from || 'none'} → ${c.verdict_to || 'none'}`}</td>
                      <td>{c.diff && c.diff.changes && c.diff.changes.length ? c.diff.changes.slice(0, 6).map((x) => `${x.id} ${fmtScore(x.from)}→${fmtScore(x.to)}`).join(', ') : <span className="faint">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {runs.length ? <p>{`Research runs: ${runs.map((r) => `${r.run_id} ${words(r.status)}`).join('; ')}`}</p> : null}
          {journal.length ? <p>{`${journal.length} journal entr${journal.length === 1 ? 'y' : 'ies'}`}</p> : null}
          {events.length ? <p>{`${events.length} review or alert change${events.length === 1 ? '' : 's'}`}</p> : null}
          {price ? <p>{`Price ${fmtSignedPct(price.change_pct)} (${fmtPrice(price.from)} on ${fmtDateTime(price.from_at)} → ${fmtPrice(price.to)})`}</p> : null}
        </>
      ) : <p className="none">Nothing new since your last review.</p>}
    </Panel>
  );
}

// ---- your note and journal --------------------------------------------------------------

// Your conviction note: prefilled with the saved text and conviction; a draft
// you are writing is kept when the saved note changes underneath it.
function ConvictionNote({ d, pid }) {
  const saved = d.conviction || null;
  const savedText = saved ? saved.text || '' : '';
  const savedConv = saved && CONVICTIONS.includes(saved.conviction) ? saved.conviction : '';
  const [text, setText] = useState(savedText);
  const [conv, setConv] = useState(savedConv);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (dirty) return;
    setText(savedText);
    setConv(savedConv);
  }, [saved && saved.updated_at, savedText, savedConv]);
  const saveNote = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/api/projects/${enc(pid)}/note`, { text, conviction: conv || null });
      toast(r && r.status === 'unchanged' ? 'Note unchanged' : 'Note saved');
      setDirty(false);
      await refresh();
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="nt-note">
      <textarea
        className="input nt-textarea"
        name="conviction-note"
        data-key="conviction-note"
        aria-label="Conviction note"
        placeholder="Your conviction note in your own words…"
        value={text}
        onChange={(e) => { setText(e.target.value); setDirty(true); }}
      />
      <div className="l2-actions">
        <select className="input nt-conv" name="conviction" aria-label="Conviction" value={conv} onChange={(e) => { setConv(e.target.value); setDirty(true); }}>
          <option value="">Conviction (optional)</option>
          {CONVICTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <button type="button" className="btn btn-sm btn-primary" data-key="save-note" disabled={busy} aria-busy={busy || undefined} onClick={saveNote}>{busy ? 'Saving…' : 'Save note'}</button>
        {saved && saved.updated_at ? <span className="nt-saved" title={fmtDateTime(saved.updated_at)}>{`Last saved ${fmtAgo(saved.updated_at)}`}</span> : null}
      </div>
    </div>
  );
}

function DecisionForm({ pid }) {
  const [decision, setDecision] = useState(DECISIONS[0]);
  const [conviction, setConviction] = useState(CONVICTIONS[0]);
  const [text, setText] = useState('');
  const [reasons, setReasons] = useState('');
  const [sid, setSid] = useState(() => submissionId());
  const [busy, setBusy] = useState(false);
  const record = async () => {
    setBusy(true);
    try {
      await api.post(`/api/projects/${enc(pid)}/journal`, { type: 'decision', decision, conviction, text, reasons: reasons.split(';').map((s) => s.trim()).filter(Boolean), submission_id: sid });
      toast('Decision recorded. It is yours, separate from any model report.');
      setDecision(DECISIONS[0]);
      setConviction(CONVICTIONS[0]);
      setText('');
      setReasons('');
      setSid(submissionId());
      await refresh();
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="l2-form" data-key="decision-form" aria-labelledby="nt-decision-h" onSubmit={(e) => { e.preventDefault(); if (!busy) record(); }}>
      <div className="l2-row">
        <label>
          Decision
          <select className="input" name="decision" value={decision} onChange={(e) => setDecision(e.target.value)}>
            {DECISIONS.map((v) => <option key={v} value={v}>{words(v)}</option>)}
          </select>
        </label>
        <label>
          Conviction
          <select className="input" name="decision-conviction" value={conviction} onChange={(e) => setConviction(e.target.value)}>
            {CONVICTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
      </div>
      <label>
        Text
        <input className="input" name="decision-text" type="text" placeholder="Decision and reasoning" value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <label>
        Reasons
        <input className="input" name="decision-reasons" type="text" placeholder="Reasons, separated by ;" value={reasons} onChange={(e) => setReasons(e.target.value)} />
      </label>
      <div className="l2-actions">
        <button type="submit" className="btn btn-sm" data-key="record-decision" disabled={busy} aria-busy={busy || undefined}>{busy ? 'Saving…' : 'Record decision'}</button>
      </div>
    </form>
  );
}

function JournalItem({ j, pid }) {
  if (j.broken) return <li className="l2-err">{`${j.entry_id}: this journal entry could not be read (${j.error})`}</li>;
  const seen = Array.isArray(j.linked_report_ids) ? j.linked_report_ids : [];
  const reasons = Array.isArray(j.reasons) ? j.reasons : [];
  return (
    <li className="nt-entry">
      <p className="nt-entry-meta">{`${words(j.type) || 'entry'} · ${fmtDateTime(j.created_at)} · via ${j.via || '?'}`}</p>
      {j.decision || j.text ? (
        <p className="nt-entry-t">
          {j.decision ? <strong>{`${words(j.decision)}${j.conviction ? ` (${j.conviction})` : ''} `}</strong> : null}
          {j.text ? <span>{j.text}</span> : null}
        </p>
      ) : null}
      {seen.length && (j.type === 'review_completed' || j.type === 'note') ? (
        <p className="nt-entry-sub">
          {`Reports seen: ${seen.join(', ')}`}
          {j.type === 'review_completed' ? <>{' · '}<ViewLink pid={pid} href={checkInHref(pid, j.entry_id)} dataKey={`checkin-${j.entry_id}`}>Check-in from this review</ViewLink></> : null}
        </p>
      ) : null}
      {reasons.length ? <p className="nt-entry-sub">{`Reasons: ${reasons.join('; ')}`}</p> : null}
      {j.source_request_text ? <p className="nt-entry-sub faint">{`From request: “${j.source_request_text}”`}</p> : null}
    </li>
  );
}

function Journal({ d, pid }) {
  const entries = Array.isArray(d.journal) ? d.journal : [];
  const pager = usePager(entries, 25);
  return (
    <Panel id="nt-journal" title="Your conviction note and journal" note="Private: never sent to a model by default.">
      <ConvictionNote d={d} pid={pid} />
      <div className="nt-part">
        <h3 className="nt-h3" id="nt-decision-h">Record a decision</h3>
        <DecisionForm pid={pid} />
      </div>
      <div className="nt-part">
        {entries.length ? (
          <>
            <ul className="l2-rows nt-journal" aria-label="Journal">{pager.slice.map((j, i) => <JournalItem key={j.entry_id || i} j={j} pid={pid} />)}</ul>
            <Pager pager={pager} label="Journal pages" dataKey="journal" />
          </>
        ) : <p className="none">No journal entries yet. Every note change and decision is kept as a dated entry.</p>}
      </div>
    </Panel>
  );
}

// ---- reviews, catalysts and alerts ------------------------------------------------------

function ReviewForm({ pid }) {
  const [due, setDue] = useState('');
  const [title, setTitle] = useState('Review thesis');
  const [err, setErr] = useState(null);
  const [sid, setSid] = useState(() => submissionId());
  const [busy, setBusy] = useState(false);
  const dueRef = useRef(null);
  const add = async () => {
    if (!due) {
      setErr('Pick a date.');
      if (dueRef.current) dueRef.current.focus();
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      await api.post(`/api/scopes/${enc(pid)}/events`, { type: 'review', title, due, submission_id: sid });
      toast('Review added');
      setDue('');
      setTitle('Review thesis');
      setSid(submissionId());
      await refresh();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="l2-form" data-key="review-form" aria-labelledby="nt-review-h" noValidate onSubmit={(e) => { e.preventDefault(); if (!busy) add(); }}>
      <div className="l2-row">
        <label>
          Due (America/New_York)
          <input ref={dueRef} className="input" name="review-due" type="date" value={due} aria-invalid={err ? 'true' : undefined} aria-describedby={err ? 'nt-review-err' : undefined} onChange={(e) => { setDue(e.target.value); if (err) setErr(null); }} />
          {err ? <span className="l2-err" id="nt-review-err" role="alert">{err}</span> : null}
        </label>
        <label>
          Title
          <input className="input" name="review-title" type="text" placeholder="What to review" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
      </div>
      <div className="l2-actions">
        <button type="submit" className="btn btn-sm" data-key="add-review" disabled={busy} aria-busy={busy || undefined}>{busy ? 'Saving…' : 'Add review'}</button>
      </div>
    </form>
  );
}

function AlertForm({ pid }) {
  const [kind, setKind] = useState('price_below');
  const [threshold, setThreshold] = useState('');
  const [err, setErr] = useState(null);
  const [sid, setSid] = useState(() => submissionId());
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  const add = async () => {
    if (String(threshold).trim() === '') {
      setErr('Give a threshold in USD.');
      if (ref.current) ref.current.focus();
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      await api.post(`/api/scopes/${enc(pid)}/events`, { type: 'alert', title: `${kind === 'price_below' ? 'Price below' : 'Price above'} $${threshold}`, alert_kind: kind, threshold_usd: Number(threshold), submission_id: sid });
      toast('Alert added. It shows on the dashboard; no external notification is sent.');
      setThreshold('');
      setSid(submissionId());
      await refresh();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="l2-form" data-key="alert-form" aria-labelledby="nt-alert-h" noValidate onSubmit={(e) => { e.preventDefault(); if (!busy) add(); }}>
      <div className="l2-row">
        <label>
          Alert
          <select className="input" name="alert-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="price_below">Price below</option>
            <option value="price_above">Price above</option>
          </select>
        </label>
        <label>
          Threshold (USD)
          <input ref={ref} className="input" name="alert-threshold" type="number" step="any" min="0" inputMode="decimal" placeholder="USD" value={threshold} aria-invalid={err ? 'true' : undefined} aria-describedby={err ? 'nt-alert-err' : undefined} onChange={(e) => { setThreshold(e.target.value); if (err) setErr(null); }} />
          {err ? <span className="l2-err" id="nt-alert-err" role="alert">{err}</span> : null}
        </label>
      </div>
      <div className="l2-actions">
        <button type="submit" className="btn btn-sm" data-key="add-alert" disabled={busy} aria-busy={busy || undefined}>{busy ? 'Saving…' : 'Add alert'}</button>
      </div>
    </form>
  );
}

function Events({ d, pid }) {
  const dk = useDesk();
  const today = dk.index ? dk.index.today : null;
  const [doing, setDoing] = useState(null);
  // By due date; an item without one last.
  const rows = (Array.isArray(d.events) ? d.events : []).slice().sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')));
  return (
    <Panel id="nt-events" title="Reviews, catalysts and alerts" note="Dates are calendar days in America/New_York.">
      {rows.length ? (
        <div className="l2-table-wrap">
          <table className="l2-table nt-events">
            <thead><tr><th scope="col">Due</th><th scope="col">Type</th><th scope="col">Title</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {rows.map((e, i) => {
                const overdue = e.status === 'open' && e.due_date && today && e.due_date < today;
                return (
                  <tr key={e.event_id || i}>
                    <td className="nowrap">{e.due_date ? <>{fmtDate(e.due_date)}{overdue ? <strong>{' · overdue'}</strong> : null}</> : <span className="faint">—</span>}</td>
                    <td>{words(e.type) || <span className="faint">—</span>}</td>
                    <td>{e.title || <span className="faint">—</span>}{e.source_request_text ? <span className="nt-entry-sub faint nt-block">{`“${e.source_request_text}”`}</span> : null}</td>
                    <td>{words(e.status) || <span className="faint">—</span>}</td>
                    <td className="nowrap">
                      {e.status === 'open' && e.event_id ? (
                        <button
                          type="button"
                          className="btn btn-sm"
                          data-key={`event-done-${e.event_id}`}
                          aria-label={`Mark ${e.title || 'this item'} done`}
                          disabled={doing === e.event_id}
                          aria-busy={doing === e.event_id || undefined}
                          onClick={async () => {
                            setDoing(e.event_id);
                            try {
                              await api.post(`/api/scopes/${enc(pid)}/events/${enc(e.event_id)}`, { status: 'done' });
                              toast('Marked done');
                              await refresh();
                            } catch (err) {
                              toast(err.message, 'bad');
                            } finally {
                              setDoing(null);
                            }
                          }}
                        >
                          Done
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <p className="none">No reviews or alerts yet.</p>}
      <div className="nt-part">
        <h3 className="nt-h3" id="nt-review-h">Add a review</h3>
        <ReviewForm pid={pid} />
      </div>
      <div className="nt-part">
        <h3 className="nt-h3" id="nt-alert-h">Add a price alert</h3>
        <AlertForm pid={pid} />
      </div>
    </Panel>
  );
}

export default function Notes({ d, row, pid, current }) {
  // Keyed by the project: another project's page starts with its own forms,
  // never this one's drafts.
  return (
    <div className="l2-stack nt" key={pid}>
      <CheckIn d={d} current={current} row={row} pid={pid} />
      <Changes d={d} />
      <div className="l2-grid2">
        <Journal d={d} pid={pid} />
        <Events d={d} pid={pid} />
      </div>
    </div>
  );
}
