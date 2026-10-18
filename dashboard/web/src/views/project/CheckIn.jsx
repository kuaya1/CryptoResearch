// The review check-in, the Overview's top band: "Since your last review" in
// one line naming the changes in words, Mark reviewed beside it, and folded
// under it one row per model (public/checkin-model.js): the report your last
// review saw (Then), the latest eligible report (Now), the reports saved
// between, and what moved. Its base is in the address (?base=<receipt>,
// default your latest review), so a reload, Back or a new tab draws the same
// comparison.
//
// Mark reviewed sends the opinions drawn on screen (lib/review.js), never the
// clock: nothing while an opinion is loading ("Still loading"); a newer
// report than the one drawn is said and nothing is marked ("Show it"); a lost
// answer offers Try again with the same request, which the desk applies once.
// The note draft stays until a review is saved.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Plus } from 'lucide-react';
import { fmtDate, fmtDateTime, fmtSignedPct, fmtPrice, toast } from '../../../../public/ui.js';
import { checkInModel } from '../../../../public/checkin-model.js';
import { baseOf, sectionHref } from '../../../../public/project-routes.js';
import { api, refresh } from '../../lib/desk.js';
import { nav, navigate, hrefWith } from '../../lib/router.js';
import { seenOf, sendReview, undoReview, newRequestId, STILL_LOADING } from '../../lib/review.js';
import { useDesk } from '../../lib/hooks.js';
import { CiteLine } from './Overview.jsx';

const enc = encodeURIComponent;
const NOTE_MAX = 2000;
// Note drafts by project, in memory only: they survive a redraw (a live
// update, Show it) and leave with the page; a saved review clears its own.
const drafts = new Map();

function reportHref(pid, prov, id) {
  return sectionHref(pid, 'report', { model: prov, report: id });
}

function Then({ label, then, now }) {
  return (
    <div className="ci-mv">
      <dt>{label}</dt>
      <dd><span className="ci-k">Then</span>{then}</dd>
      <dd><span className="ci-k">Now</span>{now}</dd>
    </div>
  );
}

function Moved({ mv, who }) {
  const none = <span className="faint">{`Not reported in ${who}'s report`}</span>;
  const risk = (r) => (r ? <><span className="ci-t">{r.text}</span>{r.sources.length || r.tags.length ? <CiteLine f={r} /> : null}</> : none);
  return (
    <dl className="ci-moved">
      {mv.grade.changed ? <Then label="Grade" then={mv.grade.then} now={mv.grade.now} /> : <div className="ci-mv"><dt>Grade</dt><dd>{`${mv.grade.now} (unchanged)`}</dd></div>}
      {mv.verdict.changed ? <Then label="Verdict" then={mv.verdict.then || 'None'} now={mv.verdict.now || 'None'} /> : null}
      {mv.risk.changed ? <Then label="Strongest sourced risk" then={risk(mv.risk.then)} now={risk(mv.risk.now)} /> : null}
      {mv.confirm.changed ? <Then label="Would confirm" then={mv.confirm.then || none} now={mv.confirm.now || none} /> : null}
      {mv.break.changed ? <Then label="Would break it" then={mv.break.then || none} now={mv.break.now || none} /> : null}
      {mv.categories.length ? (
        <div className="ci-mv">
          <dt>Categories moved 5 or more</dt>
          <dd><ul className="ci-cats">{mv.categories.map((c) => <li key={c.id}>{`${c.label}: ${c.then} → ${c.now}`}</li>)}</ul></dd>
        </div>
      ) : null}
      {mv.revision ? <div className="ci-mv"><dt>Revision</dt><dd>{mv.revision.kind}{mv.revision.note ? `: ${mv.revision.note}` : ''}</dd></div> : null}
    </dl>
  );
}

// A report named by its analysis date; its ID is the tooltip (raw IDs never
// stand in the text, the 2026-10-18 polish pass).
function RepLink({ s, pid, prov, label }) {
  const when = s.analysis_at ? fmtDate(s.analysis_at) : s.saved_at ? `Saved ${fmtDate(s.saved_at)}` : 'Undated report';
  return <a href={reportHref(pid, prov, s.report_id)} data-key={`ci-${label}-${prov}`} data-report={s.report_id} title={`Report ${s.report_id}`}>{when}</a>;
}

// One model as a card: its name, the grade then and now, its verdict now,
// and the two reports by their dates.
function Row({ r, pid }) {
  const from = r.then ? r.then.grade_words : 'None';
  const to = r.now ? r.now.grade_words : 'None';
  return (
    <li className="ci-row ci-card" data-key={`ci-row-${r.provider}`} data-same={r.same ? 'true' : 'false'}>
      <p className="ci-model">
        <strong>{r.who}</strong>
        {r.on_hold ? <span className="faint"> · on hold</span> : null}
        {r.same ? <span className="ci-same"> · Same report</span> : null}
      </p>
      <p className="ci-move" aria-label={r.same ? `Grade ${to}, unchanged` : `Grade ${from} then, ${to} now`}>
        {r.same ? <span className="ci-to">{to}</span> : <><span className="ci-from">{from}</span><ArrowRight size={14} aria-hidden="true" className="ci-arrow" /><span className="ci-to">{to}</span></>}
      </p>
      {r.now && r.now.verdict ? <p className="ci-verdict">{r.now.verdict}</p> : r.now_note ? <p className="ci-verdict is-none">{r.now_note}</p> : null}
      {r.newer ? <p className="ci-newer" data-key={`ci-newer-${r.provider}`}>{`A newer ${r.who} report exists · `}<a href={reportHref(pid, r.provider, r.now.report_id)} title={`Report ${r.now.report_id}`}>{`Open the ${r.now.analysis_at ? fmtDate(r.now.analysis_at) : 'newer'} report`}</a></p> : null}
      {r.same ? (
        r.now ? <p className="ci-reps"><span className="ci-k">Report</span><RepLink s={r.now} pid={pid} prov={r.provider} label="now" /></p> : null
      ) : (
        <dl className="ci-reps">
          <div><dt className="ci-k">Then</dt><dd>{r.then ? <RepLink s={r.then} pid={pid} prov={r.provider} label="then" /> : <span className="ci-none">{r.then_note}</span>}</dd></div>
          <div><dt className="ci-k">Now</dt><dd>{r.now ? <RepLink s={r.now} pid={pid} prov={r.provider} label="now" /> : <span className="ci-none">{r.now_note}</span>}</dd></div>
        </dl>
      )}
      {r.between_words ? (
        <p className="ci-between" data-key={`ci-between-${r.provider}`}>
          {`${r.between_words}: `}
          {r.between.map((b, i) => <span key={b.report_id}>{i ? ', ' : ''}<a href={reportHref(pid, r.provider, b.report_id)} title={`Report ${b.report_id}`}>{b.analysis_at ? fmtDate(b.analysis_at) : 'undated'}</a></span>)}
        </p>
      ) : null}
      {r.not_comparable ? <p className="ci-nc" data-key={`ci-nc-${r.provider}`}>{r.not_comparable}</p> : null}
      {r.moved ? <Moved mv={r.moved} who={r.who} /> : null}
    </li>
  );
}

// The digest the rows start from: the project record's (your latest review),
// or, for an earlier receipt named in the address, the desk's digest from it
// (a read; nothing is written).
function useChanges(d, pid, base) {
  const own = d && d.changes ? d.changes : null;
  const ownBase = own && own.review ? own.review.receipt_id : null;
  const need = Boolean(base && own && base !== ownBase);
  const [got, setGot] = useState({ key: null, ch: null, error: null });
  const key = need ? `${pid}|${base}|${own.since}|${(d.reports || []).length}` : null;
  useEffect(() => {
    if (!need) return undefined;
    const ctrl = new AbortController();
    api.get(`/api/projects/${enc(pid)}/changes?base=${enc(base)}`, { signal: ctrl.signal }).then(
      (ch) => { if (!ctrl.signal.aborted) setGot({ key, ch, error: null }); },
      (error) => { if (!ctrl.signal.aborted && error.name !== 'AbortError') setGot({ key, ch: null, error }); },
    );
    return () => ctrl.abort();
  }, [key]);
  if (!need) return { ch: own, loading: false, error: null };
  if (got.key !== key) return { ch: null, loading: true, error: null };
  return { ch: got.ch, loading: false, error: got.error };
}

// markRef (the Review page's action bar): set on every draw to { can, busy,
// run } so its "Mark reviewed (⌘↵)" uses this same mark, note included;
// hideButton leaves the button to that bar. startOpen opens the rows.
export function CheckIn({ d, current, row, pid, markRef = null, hideButton = false, startOpen = false }) {
  const dk = useDesk();
  const base = baseOf(nav.route.query);
  const { ch: changes, loading, error } = useChanges(d, pid, base);
  const ch = changes || (d && d.changes) || {};
  const [busy, setBusy] = useState(false);
  const [note, setNoteState] = useState(() => drafts.get(pid) || '');
  const setNote = (v) => {
    if (v) drafts.set(pid, v);
    else drafts.delete(pid);
    setNoteState(v);
  };
  // The note is one quiet line until you add one (a kept draft opens it).
  const [noteOpen, setNoteOpen] = useState(() => Boolean(drafts.get(pid)));
  const [msg, setMsg] = useState(null); // { text, tone, action }
  const retry = useRef(null); // the request a Try again resends
  const model = useMemo(() => checkInModel(ch, d, dk.index, { when: fmtDateTime }), [ch, d, dk.index]);
  const drawn = seenOf(row, current ? d : null);
  const n = (k, one, many = `${one}s`) => (k ? `${k} ${k === 1 ? one : many}` : null);
  const grades = (ch.provider_changes || []).filter((c) => c.from_report);
  const words = [n((ch.new_reports || []).length, 'new report'), n(grades.length, 'grade change'), n((ch.research_runs || []).length, 'research run'), ch.price && typeof ch.price.change_pct === 'number' ? `price ${fmtSignedPct(ch.price.change_pct)}` : null].filter(Boolean);
  const canMark = Boolean(ch.item_count) || Boolean(model.rows.length && ch.review && ch.review.basis !== 'receipt');

  const mark = async (again = null) => {
    const seen = again ? again.seen : drawn.seen;
    if (!again && !drawn.ready) {
      setMsg({ text: STILL_LOADING, tone: '' });
      return;
    }
    const requestId = again ? again.requestId : newRequestId();
    retry.current = { seen, requestId };
    setBusy(true);
    setMsg(null);
    let out;
    try {
      out = await sendReview(pid, { seen, note, requestId });
    } finally {
      setBusy(false);
    }
    if (out.kind === 'signed_out') return;
    if (out.kind === 'no_answer') {
      setMsg({ text: out.message, tone: 'bad', action: { label: 'Try again', key: 'ci-retry', run: () => mark(retry.current) } });
      return;
    }
    if (out.kind === 'refused') {
      setMsg({ text: out.message, tone: 'bad' });
      return;
    }
    if (out.kind === 'newer') {
      setMsg({ text: out.message, tone: 'bad', action: { label: 'Show it', key: 'ci-show', run: async () => { setMsg(null); const det = document.querySelector('[data-key="pb-digest"]'); if (det) det.open = true; await refresh(); } } });
      return;
    }
    retry.current = null;
    const res = out.result;
    if (out.kind === 'unchanged') setMsg({ text: out.message, tone: '' });
    else {
      setNote('');
      setMsg(null);
      toast('Marked reviewed', '', {
        ms: 6000,
        action: {
          label: 'Undo',
          key: 'undo-review',
          onClick: async () => {
            await undoReview(pid, res);
            toast('Review undone');
            await refresh();
          },
        },
      });
    }
    if (base && base !== res.receipt_id) navigate(hrefWith({ base: null }), { replace: true, state: history.state });
    await refresh();
  };

  if (markRef) markRef.current = { can: canMark && drawn.ready, busy, mark: () => mark(), label: drawn.ready ? 'Mark reviewed' : STILL_LOADING };
  // On a phone the line is just the changes (the label stays for screen
  // readers), so it keeps to one line beside Mark reviewed.
  const head = <span className="dg-t"><strong id="pb-digest-h" className="dg-label">Since your last review</strong><span className="faint"><span className="dg-sep">{' · '}</span>{words.length ? words.join(', ') : 'nothing new'}</span></span>;
  const label = drawn.ready ? 'Mark reviewed' : STILL_LOADING;
  return (
    <section className={`digest${ch.item_count ? ' has' : ''}`} aria-labelledby="pb-digest-h" title={ch.since ? `Since ${ch.cursor_source === 'project created' ? 'the project was added' : fmtDateTime(ch.since)}. A digest never changes grades, reports or your headline.` : undefined}>
      <details className="dg-d" data-key="pb-digest" open={Boolean(base) || startOpen || undefined}>
        <summary>{head}</summary>
        <div className="ci">
          <p className={`ci-head${model.head.inferred ? ' is-inferred' : ''}`} data-key="ci-head">{loading ? 'Loading that review…' : model.head.text}</p>
          {model.head.lost ? <p className="ci-lost" role="note">{model.head.lost}</p> : null}
          {error ? <p className="ci-lost" role="alert">{`Could not read that review: ${error.message}`}</p> : null}
          {loading ? null : <ol className="ci-rows">{model.rows.map((r) => <Row key={r.provider} r={r} pid={pid} />)}</ol>}
          {ch.price && typeof ch.price.change_pct === 'number' ? <p className="ci-price">{`Price ${fmtPrice(ch.price.from)} (${fmtDateTime(ch.price.from_at)}) → ${fmtPrice(ch.price.to)} (${fmtDateTime(ch.price.to_at)}), ${fmtSignedPct(ch.price.change_pct)}`}</p> : null}
          {(ch.journal_entries || []).length ? (
            <ul className="ci-notes plain-list" aria-label="Your notes since">
              {ch.journal_entries.map((j) => <li key={j.entry_id}>{`${String(j.type).replace(/_/g, ' ')} · ${fmtDateTime(j.created_at)}${j.text ? `: ${j.text}` : ''}`}</li>)}
            </ul>
          ) : null}
          {noteOpen || note ? (
            <label className="ci-note">
              <span>Review note (optional)</span>
              <textarea data-key="ci-note" maxLength={NOTE_MAX} rows={2} value={note} autoFocus={noteOpen && !note} onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))} />
            </label>
          ) : <button type="button" className="btn-link ci-note-add" data-key="ci-note-add" onClick={() => setNoteOpen(true)}><Plus size={14} aria-hidden="true" />Add review note</button>}
          <p className="dg-all"><a href={`#/project/${enc(pid)}/notes`} data-key="pb-all-changes">All changes</a></p>
        </div>
      </details>
      {canMark && !hideButton ? <button type="button" className="btn btn-sm" data-key="ov-reviewed" title={drawn.ready ? undefined : STILL_LOADING} disabled={busy || !drawn.ready} onClick={() => mark()}>{label}</button> : null}
      {msg ? (
        <p className={`dg-msg${msg.tone ? ` is-${msg.tone}` : ''}`} role="status" data-key="ci-msg">
          <span>{msg.text}</span>
          {msg.action ? <button type="button" className="btn btn-sm" data-key={msg.action.key} disabled={busy} onClick={msg.action.run}>{msg.action.label}</button> : null}
        </p>
      ) : null}
    </section>
  );
}

