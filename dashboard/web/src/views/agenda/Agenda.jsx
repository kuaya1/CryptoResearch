// The review agenda (#/agenda; GET /api/agenda, core/forensic-agenda.js,
// cr-review-agenda@1): one primary next action per project, with why it is
// due, the receipt, report or record behind it, and its basis in words
// (sourced, a conditional estimate, or your choice). Reading it writes
// nothing and asks nothing; it is read again when the desk's index changes.
// Done, Snooze and Reopen are explicit clicks, each with one request ID kept
// until it is answered, so a retry after a lost answer is "unchanged". No
// notification, no research, no grade or monitoring change.
import { useRef, useState } from 'react';
import { fmtDate, toast } from '../../../../public/ui.js';
import { api, refresh } from '../../lib/desk.js';
import { useAgendaRead } from '../../lib/agenda.js';
import '../../styles/agenda.css';

const enc = encodeURIComponent;
const rid = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
export const SUPPORT = {
  receipt: (s) => `Receipt ${s.receipt_id}${s.checkpoint ? `, ${s.checkpoint} checkpoint` : ''}${s.metric ? `, ${s.metric.replace(/_/g, ' ')}` : ''}`,
  challenge: (s) => `Challenge ${s.receipt_id} of ${s.assessment_receipt_id}, finding ${s.finding_id}`,
  observation: (s) => `Observation ${s.obs_id || '—'}`,
  report: (s) => `Report ${s.report_id}`,
  event: () => 'Your review on the Notes tab',
};

// GET /api/agenda, read again when the index changes (one read shared with
// the rail and the Desk, lib/agenda.js); an answer that a newer read replaced
// is never drawn.
export function useAgenda() {
  return useAgendaRead();
}

export function Act({ pid, item }) {
  const [snoozing, setSnoozing] = useState(false);
  const [until, setUntil] = useState(() => ymd(Date.now() + 7 * 86400000));
  const [busy, setBusy] = useState(false);
  const [req, setReq] = useState(() => rid('ag'));
  const opener = useRef(null);
  const base = `ag-${item.item_id}`;
  const path = `/api/projects/${enc(pid)}/agenda`;
  // After an answer: say it, renew the request ID, read the desk again. A
  // refusal (4xx) changed nothing, so its ID is renewed too; a lost answer
  // (no status, 5xx) keeps it, so the retry is "unchanged".
  const answered = async (out, said) => {
    toast((out.result && out.result.status) === 'unchanged' ? 'Already recorded' : said);
    setReq(rid('ag'));
    setSnoozing(false);
    await refresh();
  };
  const failed = (err) => {
    toast(err.status === 401 ? 'Your session has ended. Sign in again.' : err.message, 'bad');
    if (err.status && err.status < 500) setReq(rid('ag'));
  };
  if (item.completed || item.snoozed) {
    return (
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        disabled={busy}
        data-key={`${base}-reopen`}
        onClick={async () => {
          setBusy(true);
          try { await answered(await api.post(path, { item_id: item.item_id, action: 'reopen', request_id: req }), 'Back on the agenda'); } catch (err) { failed(err); } finally { setBusy(false); }
        }}
      >
        Reopen
      </button>
    );
  }
  return (
    <div className="ag-acts">
      <button
        type="button"
        className="btn btn-sm"
        disabled={busy}
        data-key={`${base}-done`}
        title="Records that you dealt with it. No research, grade or monitoring changes."
        onClick={async () => {
          setBusy(true);
          try { await answered(await api.post(path, { item_id: item.item_id, action: 'complete', request_id: req }), 'Marked done'); } catch (err) { failed(err); } finally { setBusy(false); }
        }}
      >
        Done
      </button>
      {snoozing ? (
        <span className="ag-snooze" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setSnoozing(false); requestAnimationFrame(() => opener.current && opener.current.focus()); } }}>
          <label className="sr-only" htmlFor={`${base}-until`}>Snooze until</label>
          <input id={`${base}-until`} type="date" className="ag-date" value={until} min={ymd(Date.now())} onChange={(e) => setUntil(e.target.value)} data-key={`${base}-until`} autoFocus />
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy || !until}
            data-key={`${base}-snooze-save`}
            onClick={async () => {
              setBusy(true);
              try { await answered(await api.post(path, { item_id: item.item_id, action: 'snooze', until, request_id: req }), `Snoozed until ${fmtDate(until)}`); } catch (err) { failed(err); } finally { setBusy(false); }
            }}
          >
            Snooze
          </button>
          <button type="button" className="btn btn-sm btn-ghost" data-key={`${base}-snooze-cancel`} onClick={() => { setSnoozing(false); requestAnimationFrame(() => opener.current && opener.current.focus()); }}>Cancel</button>
        </span>
      ) : <button ref={opener} type="button" className="btn btn-sm btn-ghost" disabled={busy} data-key={`${base}-snooze`} aria-expanded="false" onClick={() => setSnoozing(true)}>Snooze…</button>}
    </div>
  );
}

export function Item({ pid, item, primary = false, acts = true }) {
  const s = item.support || {};
  return (
    <div className={`ag-item${primary ? ' is-primary' : ''}${item.due ? ' is-due' : ''}`}>
      <p className="ag-item-top">
        {primary ? <a className="ag-title" href={item.href} data-key={`ag-open-${item.item_id}`}>{item.title}</a> : <a href={item.href}>{item.title}</a>}
        <span className={`ag-when${item.due ? ' is-due' : ''}`}>{item.when}</span>
        <span className={`ag-basis is-${item.basis}`} title={item.basis === 'conditional' ? 'A conditional threshold estimate frozen at a receipt\'s origin: not a forecast.' : item.basis === 'owner' ? 'A date you set.' : 'A date or state a stored record gives.'}>{item.basis_words}</span>
      </p>
      <p className="ag-why">{item.why}</p>
      <p className="ag-src faint">{(SUPPORT[s.kind] || (() => ''))(s)}{item.snoozed ? ` · snoozed until ${fmtDate(item.snoozed.until)}` : ''}{item.completed ? ` · done ${fmtDate(item.completed.at)}` : ''}</p>
      {acts ? <Act pid={pid} item={item} /> : null}
    </div>
  );
}

function Row({ row }) {
  const p = row.primary;
  const rest = [...row.due, ...row.upcoming].filter((x) => !p || x.item_id !== p.item_id);
  const set = [...row.snoozed, ...row.completed];
  return (
    <article className="ag-card" aria-labelledby={`ag-h-${row.project_id}`}>
      <div className="ag-head">
        <h2 id={`ag-h-${row.project_id}`} className="ag-name"><a href={`#/project/${enc(row.project_id)}`}>{row.name}</a>{row.symbol ? <span className="ag-sym">{row.symbol}</span> : null}</h2>
        <span className="ag-count">{row.due.length ? `${row.due.length} due` : 'Nothing due'}</span>
      </div>
      {p ? <Item pid={row.project_id} item={p} primary /> : <p className="none">{row.upcoming.length ? `Next: ${row.upcoming[0].title} (${row.upcoming[0].when.toLowerCase()})` : 'Nothing dated on record.'}</p>}
      {rest.length || row.undated.length ? (
        <details className="fold ag-fold" data-key={`ag-more-${row.project_id}`}>
          <summary>{`Also on the agenda (${rest.length + row.undated.length})`}</summary>
          {rest.map((i) => <Item key={i.item_id} pid={row.project_id} item={i} />)}
          {row.undated.map((i) => <Item key={i.item_id} pid={row.project_id} item={i} />)}
        </details>
      ) : null}
      {set.length ? (
        <details className="fold ag-fold" data-key={`ag-set-${row.project_id}`}>
          <summary>{`Snoozed or done (${set.length})`}</summary>
          {set.map((i) => <Item key={i.item_id} pid={row.project_id} item={i} />)}
        </details>
      ) : null}
    </article>
  );
}

export default function Agenda() {
  const { a, error, retry } = useAgenda();
  const head = (
    <header className="page-head">
      <div className="ph-title"><h1>Agenda</h1>{a ? <span className="ph-count" title={`${a.due} project${a.due === 1 ? '' : 's'} with something due`}>{a.due}</span> : null}</div>
    </header>
  );
  if (!a) {
    return (
      <div className="ag">
        {head}
        {error ? <div className="note note-bad ag-error" role="alert"><span>{`Could not read the agenda: ${error.message}`}</span><button type="button" className="btn btn-sm" data-key="ag-retry" onClick={retry}>Try again</button></div> : <div className="page-loading" role="status"><span className="sr-only">Loading the agenda…</span><span className="skel w60" /><span className="skel w80" /></div>}
      </div>
    );
  }
  const withItems = a.rows.filter((r) => r.primary || r.snoozed.length || r.completed.length);
  const quiet = a.rows.filter((r) => !withItems.includes(r));
  return (
    <div className="ag">
      {head}
      {error ? <p className="note note-warn ag-error" role="status">{`Showing the agenda as last read: ${error.message}`}</p> : null}
      <div className="ag-list">
        {withItems.length ? withItems.map((r) => <Row key={r.project_id} row={r} />) : <p className="none ag-empty">Nothing on the agenda.</p>}
      </div>
      {quiet.length ? <p className="faint ag-quiet">{`Nothing dated for ${quiet.map((r) => r.name).join(', ')}.`}</p> : null}
      {a.failed.length ? <p className="note note-warn ag-error" role="status">{`Could not read ${a.failed.map((f) => f.name).join(', ')}.`}</p> : null}
    </div>
  );
}
