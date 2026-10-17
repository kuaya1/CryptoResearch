// Review (#/review; DESIGN_AND_IA_BLUEPRINT.md §3.4; Eric, 2026-10-17): one
// place for "what needs me", replacing the Updates and Agenda pages, in three
// panes after Ramp's review mode:
//   left    the queue, grouped by reason (Changed since review · Review due ·
//           Waiting on you · Models differ · Imports to confirm), and the
//           Upcoming (calendar, invalidators, alerts) and Imports (report
//           import, inbox, requests) segments
//   centre  the chosen project at Level 1 and what changed since your review
//   right   the evidence behind the change: the new reports, the agenda's
//           reasons with their records, the models' differences, the price
//   bar     Prev/Next (K/J), Snooze and Done for the agenda item, Mark
//           reviewed (⌘↵ / Ctrl+↵)
// On a phone the queue is a single column of cards; the chosen card opens in
// place, a swipe moves to the next or previous one. Reading it writes nothing;
// every write is an explicit click (or ⌘↵) through the same paths as before.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ChevronDown, ExternalLink, Inbox, CalendarClock, FileInput } from 'lucide-react';
import { PROVIDER_LABELS, fmtDate, fmtDateTime, fmtSignedPct, fmtPrice, toast, submissionId } from '../../../../public/ui.js';
import { reviewQueue, upcomingOf, GROUPS } from '../../../../public/review-model.js';
import { useDesk, useProject, useMedia } from '../../lib/hooks.js';
import { api, refresh } from '../../lib/desk.js';
import { nav, navigate, hrefWith, pageReady } from '../../lib/router.js';
import { legacyCtx } from '../../legacy/ctx.js';
import { Logo } from '../../components/Logo.jsx';
import { Dom } from '../../components/Dom.jsx';
import { ModelPanel, DeepLink } from '../inspector/ModelPanel.jsx';
import { CheckIn } from '../project/CheckIn.jsx';
import { useAgenda, Act, Item } from '../agenda/Agenda.jsx';
import { usePager, Pager } from '../project/kit.jsx';
import '../../styles/review.css';

const enc = encodeURIComponent;
const SEGS = [['queue', 'Queue', Inbox], ['upcoming', 'Upcoming', CalendarClock], ['imports', 'Imports', FileInput]];
const typing = (el) => Boolean(el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)));
const setQuery = (params) => navigate(hrefWith(params), { replace: true, state: history.state });
const sentence = (s) => { const t = String(s || '').replace(/_/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); };
// A score as the digest names it (as Notes.jsx does); a range as its two ends.
const fmtScore = (s) => {
  if (s === null || s === undefined) return '—';
  if (typeof s === 'string' || typeof s === 'number') return String(s);
  if (Array.isArray(s)) return s[0] === s[1] ? String(s[0]) : `${s[0]}–${s[1]}`;
  if (s.status === 'scored') return String(s.value);
  if (s.status === 'range') return `${s.low}–${s.high}`;
  return s.status === 'not_applicable' ? 'N/A' : 'unknown';
};
const VERDICT = (v) => (v ? `${v.charAt(0)}${v.slice(1).toLowerCase()}` : 'No verdict');

// ---- the queue ------------------------------------------------------------------------

function QueueList({ d, q, sel, onPick }) {
  return (
    <div className="rv-queue">
      {q.groups.map((g) => (
        <section key={g.id} className="rv-group" aria-labelledby={`rv-g-${g.id}`}>
          <h2 className="rv-gh" id={`rv-g-${g.id}`}><span>{g.label}</span><span className="rv-gn">{g.count}</span></h2>
          {g.id === 'imports' ? (
            g.count ? (
              <ul className="rv-items">
                {q.imports.map((x) => (
                  <li key={x.key}><button type="button" className="rv-item" data-key={`rv-imp-${x.key}`} onClick={() => setQuery({ seg: 'imports', p: null })}><span className="rv-it">{x.words}</span>{x.detail ? <span className="rv-ir">{x.detail}</span> : null}</button></li>
                ))}
              </ul>
            ) : <p className="rv-none">Nothing to confirm</p>
          ) : g.items.length ? (
            <ul className="rv-items">
              {g.items.map((x) => {
                const p = d.index.projects.find((y) => y.project_id === x.pid);
                return (
                  <li key={x.pid}>
                    <button type="button" className={`rv-item${sel === x.pid ? ' is-on' : ''}`} aria-current={sel === x.pid ? 'true' : undefined} data-key={`rv-item-${x.pid}`} data-pid={x.pid} onClick={() => onPick(x.pid)}>
                      <span className="rv-it">{p ? <Logo p={p} size={20} /> : null}<span className="rv-name">{x.name}</span>{x.symbol ? <span className="ticker">{x.symbol}</span> : null}</span>
                      <span className="rv-ir">{x.reasons.map((r) => r.words).join(' · ')}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : <p className="rv-none">Nothing here</p>}
        </section>
      ))}
    </div>
  );
}

// ---- the evidence for the change ---------------------------------------------------------------

function Evidence({ d, p, detail, agendaRow }) {
  const pid = p.project_id;
  const ch = detail && detail.changes ? detail.changes : null;
  const items = agendaRow ? [...agendaRow.due, ...agendaRow.upcoming, ...agendaRow.undated] : [];
  const set = agendaRow ? [...agendaRow.snoozed, ...agendaRow.completed] : [];
  const flagged = p.comparison && Array.isArray(p.comparison.flagged) ? p.comparison.flagged : [];
  const report = (rid) => (detail ? detail.reports.find((r) => r.report_id === rid) : null);
  return (
    <div className="rv-ev">
      <h2 className="rv-ph">Evidence for the change</h2>
      {!detail ? <div className="part-loading" role="status"><span className="sr-only">Loading the record…</span><span className="skel w80" /><span className="skel w60" /></div> : null}
      {ch && ch.new_reports && ch.new_reports.length ? (
        <section className="rv-evs" aria-labelledby="rv-ev-reports">
          <h3 id="rv-ev-reports">{`New reports (${ch.new_reports.length})`}</h3>
          <ul className="rv-list">
            {ch.new_reports.map((r) => {
              const full = report(r.report_id);
              const e = full && full.evidence;
              const flags = e ? (e.high || 0) + (e.medium || 0) : 0;
              const claims = full && full.assessment && Array.isArray(full.assessment.claims) ? full.assessment.claims.length : null;
              return (
                <li key={r.report_id}>
                  <p className="rv-li-t"><strong>{PROVIDER_LABELS[r.provider] || r.provider}</strong>{` · ${VERDICT(r.verdict)}`}</p>
                  <p className="rv-li-m faint">{`Saved ${fmtDateTime(r.imported_at)}${r.analysis_at ? ` · analysis ${fmtDate(r.analysis_at)}` : ''}${full && full.grade && full.grade.display ? ` · grade ${full.grade.display}` : full && full.grade && full.grade.status === 'withheld' ? ' · grade withheld' : ''}${claims !== null ? ` · ${claims} claims` : ''}${flags ? ` · ${flags} evidence flag${flags === 1 ? '' : 's'}` : ''}`}</p>
                  <p className="rv-li-a">
                    <DeepLink pid={pid} href={`#/project/${enc(pid)}/evidence?model=${r.provider}&report=${enc(r.report_id)}`} dataKey={`rv-ev-${r.report_id}`}>Its evidence</DeepLink>
                    <DeepLink pid={pid} href={`#/project/${enc(pid)}/report?report=${enc(r.report_id)}&model=${r.provider}`} dataKey={`rv-rep-${r.report_id}`}>The report</DeepLink>
                  </p>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {ch && ch.provider_changes && ch.provider_changes.length ? (
        <section className="rv-evs" aria-labelledby="rv-ev-grades">
          <h3 id="rv-ev-grades">What moved</h3>
          <ul className="rv-list">
            {ch.provider_changes.map((c) => (
              <li key={c.provider}>
                <p className="rv-li-t"><strong>{PROVIDER_LABELS[c.provider]}</strong>{` · grade ${c.grade_from || 'none'} → ${c.grade_to || 'none'}`}</p>
                {c.verdict_from !== c.verdict_to ? <p className="rv-li-m">{`Verdict ${VERDICT(c.verdict_from)} → ${VERDICT(c.verdict_to)}`}</p> : null}
                {c.diff && c.diff.changes && c.diff.changes.length ? <p className="rv-li-m faint">{c.diff.changes.slice(0, 5).map((x) => `${x.id} ${fmtScore(x.from)}→${fmtScore(x.to)}`).join(' · ')}{c.diff.changes.length > 5 ? ` · +${c.diff.changes.length - 5}` : ''}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {items.length || set.length ? (
        <section className="rv-evs" aria-labelledby="rv-ev-agenda">
          <h3 id="rv-ev-agenda">On the agenda</h3>
          {items.map((i) => { const first = Boolean(agendaRow.primary && agendaRow.primary.item_id === i.item_id); return <Item key={i.item_id} pid={pid} item={i} primary={first} acts={!first} />; })}
          {set.length ? (
            <details className="fold ag-fold" data-key={`rv-set-${pid}`}>
              <summary>{`Snoozed or done (${set.length})`}</summary>
              {set.map((i) => <Item key={i.item_id} pid={pid} item={i} />)}
            </details>
          ) : null}
        </section>
      ) : null}
      {flagged.length ? (
        <section className="rv-evs" aria-labelledby="rv-ev-differ">
          <h3 id="rv-ev-differ">Where the models differ</h3>
          <ul className="rv-list">{flagged.map((f) => <li key={`${f.section}-${f.id}`}><span>{f.label}</span><span className="faint">{` · ${f.spread} points apart`}</span></li>)}</ul>
          <p className="rv-li-a"><DeepLink pid={pid} href={`#/project/${enc(pid)}/compare`} dataKey={`rv-compare-${pid}`}>Compare the models</DeepLink></p>
        </section>
      ) : null}
      {p.forensic && p.forensic.to_review ? (
        <section className="rv-evs" aria-labelledby="rv-ev-fx">
          <h3 id="rv-ev-fx">Forensic evidence changes</h3>
          <p>{`${p.forensic.to_review} change${p.forensic.to_review === 1 ? '' : 's'} in the monitored evidence wait for your look.`}</p>
          <p className="rv-li-a"><DeepLink pid={pid} href={`#/project/${enc(pid)}/forensics?open=start`} dataKey={`rv-fx-${pid}`}>Open Forensics</DeepLink></p>
        </section>
      ) : null}
      {ch && ch.price && typeof ch.price.change_pct === 'number' ? (
        <section className="rv-evs" aria-labelledby="rv-ev-price">
          <h3 id="rv-ev-price">Price since your review</h3>
          <p className="rv-price">{`${fmtPrice(ch.price.from)} → ${fmtPrice(ch.price.to)}, ${fmtSignedPct(ch.price.change_pct)}`}</p>
          <p className="faint">{`${fmtDateTime(ch.price.from_at)} to ${fmtDateTime(ch.price.to_at)}`}</p>
        </section>
      ) : null}
      {detail && !(ch && (ch.new_reports.length || ch.provider_changes.length)) && !items.length && !set.length && !flagged.length ? <p className="none">No new report, grade move or agenda record for this project since your review.</p> : null}
    </div>
  );
}

// ---- the chosen project and the action bar -------------------------------------------------------

function Centre({ d, p, item, onPrev, onNext, hasPrev, hasNext, phone }) {
  const pid = p.project_id;
  const { d: detail, current, error, retry } = useProject(pid);
  const markRef = useRef(null);
  const [, force] = useState(0);
  useEffect(() => { force((n) => n + 1); }, [detail, current]);
  const primary = item && item.agenda && item.agenda.primary && !item.agenda.primary.completed && !item.agenda.primary.snoozed ? item.agenda.primary : null;
  const can = markRef.current && markRef.current.can;
  // ⌘↵ or Ctrl+↵: Mark reviewed when there is something to mark, else Done.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      if (markRef.current && markRef.current.can && !markRef.current.busy) markRef.current.mark();
      else if (primary) { const b = document.querySelector(`[data-key="ag-${primary.item_id}-done"]`); if (b) b.click(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });
  return (
    <div className="rv-centre">
      <div className="rv-scroll" data-keep-scroll={`review:${pid}`}>
        <header className="rv-head">
          <Logo p={p} size={32} />
          <div className="rv-head-n">
            <h2 className="rv-title" id="rv-title" tabIndex={-1}>{p.name}{p.symbol ? <span className="ticker">{` ${p.symbol}`}</span> : null}</h2>
            <p className="faint">{item ? item.reasons.map((r) => r.words).join(' · ') : 'Nothing waits on this project'}</p>
          </div>
          <DeepLink pid={pid} href={`#/project/${enc(pid)}/brief`} className="btn btn-sm" dataKey={`rv-open-${pid}`}>Open full research<ExternalLink size={13} aria-hidden="true" /></DeepLink>
        </header>
        {error ? <div className="note note-warn" role="alert"><span>{`Could not load the record: ${error.message}`}</span><button type="button" className="btn btn-sm" onClick={retry}>Try again</button></div> : null}
        {detail ? <CheckIn key={pid} d={detail} current={current} row={p} pid={pid} markRef={markRef} hideButton startOpen /> : null}
        <ModelPanel d={d} p={p} detail={detail} current={current} failed={Boolean(error)} />
        {phone ? <Evidence d={d} p={p} detail={detail} agendaRow={item ? item.agenda : null} /> : null}
      </div>
      <div className="rv-bar" role="toolbar" aria-label="Review actions">
        <button type="button" className="btn btn-sm btn-icon" aria-label="Previous (K)" aria-keyshortcuts="K" title="Previous (K)" disabled={!hasPrev} data-key="rv-prev" onClick={onPrev}><ArrowLeft size={15} aria-hidden="true" /></button>
        <button type="button" className="btn btn-sm btn-icon" aria-label="Next (J)" aria-keyshortcuts="J" title="Next (J)" disabled={!hasNext} data-key="rv-next" onClick={onNext}><ArrowRight size={15} aria-hidden="true" /></button>
        <span className="rv-bar-sp" />
        {primary ? <Act pid={pid} item={primary} /> : null}
        <button
          type="button"
          className="btn btn-primary btn-sm"
          data-key="rv-mark"
          aria-keyshortcuts="Meta+Enter Control+Enter"
          title={can ? 'Mark reviewed (⌘↵ or Ctrl+↵): the reports drawn here, with your note' : 'Nothing new since your review'}
          disabled={!can || (markRef.current && markRef.current.busy)}
          onClick={() => { if (markRef.current && markRef.current.can) markRef.current.mark(); }}
        >
          {markRef.current ? markRef.current.label : 'Mark reviewed'}<kbd className="rv-kbd" aria-hidden="true">{/Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘↵' : 'Ctrl+Enter'}</kbd>
        </button>
      </div>
    </div>
  );
}

// ---- Upcoming: the calendar ----------------------------------------------------------------------

function DoneButton({ c }) {
  const [busy, setBusy] = useState(false);
  if (c.source !== 'you' || c.status !== 'open') return null;
  return (
    <button type="button" className="btn btn-sm" disabled={busy} data-key={`rv-done-${c.event_id}`} onClick={async () => {
      setBusy(true);
      try {
        await api.post(`/api/scopes/${enc(c.project_id || 'portfolio')}/events/${enc(c.event_id)}`, { status: 'done' });
        toast('Marked done');
        await refresh();
      } catch (err) {
        toast(err.message, 'bad');
      } finally {
        setBusy(false);
      }
    }}>Done</button>
  );
}

function CalTable({ rows, empty, label, cols = 'full' }) {
  const pager = usePager(rows, 25, label);
  if (!rows.length) return <p className="none">{empty}</p>;
  const who = (c) => (c.source === 'you' ? 'You' : PROVIDER_LABELS[c.provider] || c.provider);
  return (
    <div className="l2-table-wrap">
      <table className="l2-table" aria-label={label}>
        <thead><tr>{cols === 'full' ? <th scope="col">Date</th> : null}<th scope="col">Project</th><th scope="col">{cols === 'alert' ? 'Alert' : 'Item'}</th>{cols === 'full' ? <><th scope="col">Type</th><th scope="col">Status</th></> : null}<th scope="col">From</th><th scope="col"><span className="sr-only">Action</span></th></tr></thead>
        <tbody>
          {pager.slice.map((c, i) => (
            <tr key={`${c.event_id || c.report_id || ''}-${c.title}-${i}`}>
              {cols === 'full' ? <td className="nowrap">{c.date ? `${fmtDate(c.date)}${c.precision && c.precision !== 'day' ? ` (${c.precision})` : ''}` : '—'}</td> : null}
              <td>{c.project_id ? <a href={`#/project/${enc(c.project_id)}`}>{c.project_name}</a> : c.project_name}</td>
              <td>{c.title}{c.note ? <div className="faint">{c.note}</div> : null}</td>
              {cols === 'full' ? <><td className="nowrap">{sentence(c.type)}</td><td className="nowrap">{c.status ? sentence(c.status) : ''}</td></> : null}
              <td className="nowrap">{who(c)}</td>
              <td><DoneButton c={c} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pager pager={pager} label={`${label}: pages`} dataKey={`rv-pg-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`} />
    </div>
  );
}

function Upcoming({ d }) {
  const u = upcomingOf(d.index);
  const [scope, setScope] = useState('portfolio');
  const [due, setDue] = useState('');
  const [title, setTitle] = useState('Review thesis');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sid, setSid] = useState(submissionId);
  const projects = d.index.projects.filter((p) => !p.broken && p.status !== 'archived');
  const add = async () => {
    if (!due) { setErr('Pick a date.'); return; }
    setBusy(true);
    try {
      await api.post(`/api/scopes/${enc(scope)}/events`, { type: 'review', title, due, submission_id: sid });
      toast('Review added');
      setSid(submissionId());
      setDue('');
      await refresh();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rv-up l2-stack">
      <p className="faint" title="Your reviews and alerts plus catalysts, unlocks and invalidators from the latest reports">{`Today is ${fmtDate(u.today)} in America/New_York.`}</p>
      <section className="l2-panel" aria-labelledby="rv-up-overdue"><header className="l2-panel-head"><h2 className="l2-panel-t" id="rv-up-overdue" title="Your own reviews past their due date">Overdue</h2><span className="l2-panel-sub">{u.overdue.length}</span></header><div className="l2-panel-body"><CalTable rows={u.overdue} empty="Nothing overdue." label="Overdue" /></div></section>
      <section className="l2-panel" aria-labelledby="rv-up-dated"><header className="l2-panel-head"><h2 className="l2-panel-t" id="rv-up-dated" title="Unlocks are potential liquid supply, not demonstrated selling.">Upcoming</h2><span className="l2-panel-sub">{u.dated.length}</span></header><div className="l2-panel-body"><CalTable rows={u.dated} empty="No dated items ahead." label="Upcoming" /></div></section>
      <section className="l2-panel" aria-labelledby="rv-up-add">
        <header className="l2-panel-head"><h2 className="l2-panel-t" id="rv-up-add" title='Or ask Cowork: "set a review for HUMA next Friday".'>Add a review</h2></header>
        <div className="l2-panel-body">
          <form className="l2-form" data-key="rv-review-form" onSubmit={(e) => { e.preventDefault(); add(); }}>
            <div className="l2-row">
              <label>For<select className="input" value={scope} onChange={(e) => setScope(e.target.value)} data-key="rv-review-scope"><option value="portfolio">Portfolio (not one project)</option>{projects.map((p) => <option key={p.project_id} value={p.project_id}>{p.name}</option>)}</select></label>
              <label title="America/New_York calendar day">Due date<input className="input" type="date" value={due} onChange={(e) => { setDue(e.target.value); setErr(null); }} aria-invalid={err ? 'true' : undefined} data-key="rv-review-due" /></label>
              <label>Title<input className="input" type="text" value={title} onChange={(e) => setTitle(e.target.value)} data-key="rv-review-title" /></label>
            </div>
            {err ? <p className="l2-err" role="alert">{err}</p> : null}
            <div className="l2-actions"><button type="submit" className="btn btn-primary btn-sm" disabled={busy} data-key="rv-review-add">Add review</button></div>
          </form>
        </div>
      </section>
      <div className="l2-grid2">
        <section className="l2-panel" aria-labelledby="rv-up-inv"><header className="l2-panel-head"><h2 className="l2-panel-t" id="rv-up-inv">Thesis invalidators being monitored</h2><span className="l2-panel-sub">{u.invalidators.length}</span></header><div className="l2-panel-body"><CalTable rows={u.invalidators} empty="No invalidators in the latest reports." label="Invalidators" cols="short" /></div></section>
        <section className="l2-panel" aria-labelledby="rv-up-alerts"><header className="l2-panel-head"><h2 className="l2-panel-t" id="rv-up-alerts" title="Shown on the dashboard only. No external notifications are configured.">Price alerts</h2><span className="l2-panel-sub">{u.alerts.length}</span></header><div className="l2-panel-body"><CalTable rows={u.alerts} empty="No alerts. Add them on a project's Notes section." label="Price alerts" cols="alert" /></div></section>
      </div>
      {u.undated.length ? <section className="l2-panel" aria-labelledby="rv-up-undated"><header className="l2-panel-head"><h2 className="l2-panel-t" id="rv-up-undated">Catalysts without a date</h2></header><div className="l2-panel-body"><CalTable rows={u.undated} empty="" label="Catalysts without a date" /></div></section> : null}
      {u.pastReport.length ? <section className="l2-panel" aria-labelledby="rv-up-past"><header className="l2-panel-head"><h2 className="l2-panel-t" id="rv-up-past" title="Dates reported in earlier analyses that have passed. A new report should say what happened.">Past dates from reports</h2></header><div className="l2-panel-body"><CalTable rows={u.pastReport} empty="" label="Past dates from reports" /></div></section> : null}
    </div>
  );
}

// ---- Imports: the report import, the inbox, Cowork requests (this PC) -------------------------------

function Imports({ d, route }) {
  const imp = route.query.get('imp') || 'import';
  const hosted = Boolean(d.session && d.session.hosted);
  const tabs = [['import', 'Import report'], ['inbox', `Inbox${(((d.index.imports || {}).inbox || {}).in_inbox || []).length ? ` (${d.index.imports.inbox.in_inbox.length})` : ''}`], ...(hosted ? [] : [['requests', `Cowork requests${((d.index.imports || {}).requests_pending || []).length ? ` (${d.index.imports.requests_pending.length})` : ''}`]])];
  return (
    <div className="rv-imp">
      <nav className="tabs" aria-label="Imports">
        {tabs.map(([k, w]) => <a key={k} className="tab" href={hrefWith({ imp: k === 'import' ? null : k })} aria-current={imp === k ? 'page' : undefined} data-key={`rv-imp-tab-${k}`} onClick={(e) => { e.preventDefault(); setQuery({ imp: k === 'import' ? null : k }); }}>{w}</a>)}
      </nav>
      <div className="rv-imp-body">
        {imp === 'inbox' ? <Dom key="inbox" build={(L) => L.inboxTab(legacyCtx)} deps={[d.version]} />
          : imp === 'requests' && !hosted ? <Dom key="requests" build={(L) => L.requestsTab(legacyCtx)} deps={[d.version]} />
            : <Dom key="import" build={(L) => L.importTab(legacyCtx, nav.route)} deps={[route.query.get('project'), route.query.get('provider'), route.query.get('run')]} />}
      </div>
    </div>
  );
}

// ---- the page ----------------------------------------------------------------------------------

export default function Review() {
  const d = useDesk();
  const route = nav.route;
  const seg = SEGS.some(([k]) => k === route.query.get('seg')) ? route.query.get('seg') : 'queue';
  const want = route.query.get('p');
  const group = route.query.get('group');
  const phone = useMedia('(max-width: 767.98px)');
  const wide = useMedia('(min-width: 1280px)');
  const { a: agenda, error: agendaError } = useAgenda();
  const q = useMemo(() => reviewQueue(d.index, agenda), [d.index, agenda]);
  const ordered = useMemo(() => (group ? [...q.flat.filter((x) => x.group === group), ...q.flat.filter((x) => x.group !== group)] : q.flat), [q, group]);
  // The chosen project: the address's, else the first in the queue. A project
  // that leaves the queue (reviewed, done) gives its place to the next one.
  const lastPos = useRef(0);
  let sel = want && d.index.projects.some((p) => p.project_id === want) ? want : null;
  if (!sel && ordered.length && !phone) sel = ordered[Math.min(lastPos.current, ordered.length - 1)].pid;
  const pos = ordered.findIndex((x) => x.pid === sel);
  if (pos >= 0) lastPos.current = pos;
  const item = pos >= 0 ? ordered[pos] : null;
  const p = sel ? d.index.projects.find((x) => x.project_id === sel) : null;
  const pick = (pid) => setQuery({ p: pid, seg: null });
  const step = (dir) => {
    if (!ordered.length) return;
    const i = pos < 0 ? (dir > 0 ? 0 : ordered.length - 1) : pos + dir;
    if (i < 0 || i >= ordered.length) return;
    pick(ordered[i].pid);
    requestAnimationFrame(() => { const el = document.querySelector(`[data-key="rv-item-${CSS.escape(ordered[i].pid)}"]`); if (el && !phone) el.scrollIntoView({ block: 'nearest' }); });
  };
  useLayoutEffect(() => { pageReady(); });
  // J/K: next and previous; never while typing or with a dialog or menu open.
  useEffect(() => {
    const onKey = (e) => {
      if (!nav.route || nav.route.name !== 'review' || seg !== 'queue' || nav.route.query.get('prefs')) return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.isComposing || typing(e.target) || document.querySelector('dialog[open]') || document.querySelector('.menu')) return;
      if (e.key === 'j' || e.key === 'J') { e.preventDefault(); step(1); }
      else if (e.key === 'k' || e.key === 'K') { e.preventDefault(); step(-1); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });
  // A phone: a swipe left or right on the open card moves to the next or the
  // previous one (the actions stay buttons).
  const touch = useRef(null);
  const swipe = phone ? {
    onTouchStart: (e) => { if (e.touches.length === 1) touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() }; },
    onTouchEnd: (e) => {
      const t = touch.current;
      touch.current = null;
      if (!t || !e.changedTouches.length) return;
      const dx = e.changedTouches[0].clientX - t.x;
      const dy = e.changedTouches[0].clientY - t.y;
      if (Math.abs(dx) > 90 && Math.abs(dy) < 60 && Date.now() - t.t < 700) step(dx < 0 ? 1 : -1);
    },
  } : {};

  const head = (
    <header className="page-head rv-pagehead">
      <div className="ph-title"><p className="ph-eyebrow">CryptoResearch</p><h1>Review<span className="ph-count" title="Projects that need your review: one project counts once">{q.projects}</span></h1></div>
      <div className="l2-seg rv-segs" role="group" aria-label="Review">
        {SEGS.map(([k, w, Icon]) => <button key={k} type="button" aria-pressed={seg === k} data-key={`rv-seg-${k}`} onClick={() => setQuery({ seg: k === 'queue' ? null : k, p: k === 'queue' ? want : null })}><Icon size={14} aria-hidden="true" />{w}{k === 'queue' ? <span className="l2-count">{q.projects}</span> : k === 'imports' && q.imports.length ? <span className="l2-count">{q.imports.length}</span> : null}</button>)}
      </div>
    </header>
  );
  if (seg === 'upcoming') return <div className="rv rv-page">{head}<div className="rv-wide"><Upcoming d={d} /></div></div>;
  if (seg === 'imports') return <div className="rv rv-page">{head}<div className="rv-wide"><Imports d={d} route={route} /></div></div>;

  if (phone) {
    // One column: the queue's cards; the chosen one opens in place.
    return (
      <div className="rv rv-page is-phone">
        {head}
        {agendaError ? <p className="note note-warn" role="status">{`The agenda could not be read: ${agendaError.message}. The queue shows the rest.`}</p> : null}
        {p ? (
          <div className="rv-card-open" {...swipe}>
            <button type="button" className="btn btn-ghost btn-sm rv-back" data-key="rv-back" onClick={() => setQuery({ p: null })}><ArrowLeft size={15} aria-hidden="true" />Queue</button>
            <Centre d={d} p={p} item={item} onPrev={() => step(-1)} onNext={() => step(1)} hasPrev={pos > 0} hasNext={pos >= 0 && pos < ordered.length - 1} phone />
          </div>
        ) : <QueueList d={d} q={q} sel={null} onPick={pick} />}
      </div>
    );
  }
  return (
    <div className="rv rv-page">
      {head}
      {agendaError ? <p className="note note-warn rv-note" role="status">{`The agenda could not be read: ${agendaError.message}. The queue shows the rest.`}</p> : null}
      {agenda && agenda.failed && agenda.failed.length ? <p className="note note-warn rv-note" role="status">{`Could not read the agenda of ${agenda.failed.map((f) => f.name).join(', ')}.`}</p> : null}
      <div className={`rv-panes${wide ? '' : ' is-two'}`}>
        <aside className="rv-left" aria-label="The queue"><QueueList d={d} q={q} sel={sel} onPick={pick} /></aside>
        {p ? (
          <>
            <section className="rv-mid" aria-labelledby="rv-title"><Centre d={d} p={p} item={item} onPrev={() => step(-1)} onNext={() => step(1)} hasPrev={pos > 0} hasNext={pos >= 0 && pos < ordered.length - 1} phone={!wide} /></section>
            {wide ? <aside className="rv-right" aria-label="Evidence for the change"><EvidencePane d={d} p={p} item={item} /></aside> : null}
          </>
        ) : (
          <section className="rv-mid rv-empty"><h2>All caught up</h2><p className="faint">Nothing in the queue needs you. Upcoming dates and imports are in their segments.</p></section>
        )}
      </div>
    </div>
  );
}

function EvidencePane({ d, p, item }) {
  const { d: detail } = useProject(p.project_id);
  return <div className="rv-scroll"><Evidence d={d} p={p} detail={detail} agendaRow={item ? item.agenda : null} /></div>;
}
