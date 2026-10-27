// The Daily Brief drawer (cr-daily-brief@1; the top bar's and the rail's
// button): GET /api/brief/daily rendered as it is. Each line is a #/ deep link
// to its card or project; a section the desk could not read says so, never
// "nothing". Opening it reads the brief and writes nothing.
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../lib/desk.js';
import { nav } from '../lib/router.js';
import { briefView } from '../../../public/daily-brief-model.js';
import { onBrief } from './overlays.js';
import '../styles/overlays.css';

// The brief is read within this bound (L3, 2026-10-26): a desk too busy to
// answer is said with Try again, never an endless "Reading the brief…".
export const BRIEF_WAIT_MS = 12000;

export default function DailyBrief() {
  const dlg = useRef(null);
  const opener = useRef(null);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ loading: false, error: null, view: null });
  const [fix, setFix] = useState({ busy: false, words: null, bad: false });
  const [tick, setTick] = useState(0);
  useEffect(() => onBrief(() => { opener.current = document.activeElement; setOpen(true); }), []);
  useEffect(() => {
    const el = dlg.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    setState({ loading: true, error: null, view: null });
    api.get('/api/brief/daily', { timeoutMs: BRIEF_WAIT_MS }).then(
      (b) => { if (live) setState({ loading: false, error: null, view: briefView(b) }); },
      (e) => { if (live) setState({ loading: false, error: (e && e.message) || 'The daily brief could not be read.', view: null }); },
    );
    return () => { live = false; };
  }, [open, tick]);
  // A route change (a deep link, Back) closes it.
  const routeKey = nav.route ? `${nav.route.name}/${nav.route.args.join('/')}${nav.route.query ? nav.route.query.toString() : ''}` : '';
  // Only a change: on mount it would close a drawer asked for while its code
  // was still downloading (L3, 2026-10-26).
  const lastRoute = useRef(routeKey);
  useEffect(() => {
    if (lastRoute.current === routeKey) return;
    lastRoute.current = routeKey;
    setOpen(false);
  }, [routeKey]);
  const v = state.view;
  // Item 60: complete what a recorded decision left undone (a paper position
  // or a journal entry), desk-wide. Idempotent; it never archives.
  const reconcile = async () => {
    setFix({ busy: true, words: null, bad: false });
    try {
      const r = await api.post('/api/tickets/reconcile', {});
      setFix({ busy: false, words: r && r.words ? r.words : 'Done.', bad: Boolean(r && r.counts && r.counts.failed) });
      setTick((n) => n + 1);
    } catch (e) {
      setFix({ busy: false, words: (e && e.message) || 'Reconcile failed.', bad: true });
    }
  };
  return (
    <dialog
      ref={dlg}
      className="dbrief"
      aria-label="Daily Brief"
      onClose={() => { setOpen(false); const o = opener.current; opener.current = null; if (o && o.isConnected && typeof o.focus === 'function') o.focus(); }}
      onClick={(e) => { if (e.target === dlg.current) setOpen(false); }}
    >
      {open ? (
        <div className="dbrief-in">
          <div className="dbrief-head">
            <h2 className="dbrief-h">Daily Brief</h2>
            <button type="button" className="btn btn-ghost btn-icon" aria-label="Close Daily Brief" data-key="brief-close" onClick={() => setOpen(false)}><X size={18} aria-hidden="true" /></button>
          </div>
          <div className="dbrief-body" aria-busy={state.loading}>
            {state.loading ? <p role="status" className="dbrief-none">Reading the brief…</p> : null}
            {state.error ? (
              <div role="alert" className="dbrief-err">
                <p className="dbrief-bad">{state.error}</p>
                <p><button type="button" className="btn btn-sm btn-primary" data-key="brief-retry" onClick={() => setTick((n) => n + 1)}>Try again</button></p>
              </div>
            ) : null}
            {v && !v.ok ? <p role="alert" className="dbrief-bad">{v.why}</p> : null}
            {v && v.ok ? (
              <>
                <p className="dbrief-meta" title={v.hash}>{`cr-daily-brief@1 · as of ${v.as_of} · text SHA-256 ${v.hash_short}…`}{v.unreadable ? ` · ${v.unreadable} ${v.unreadable === 1 ? 'section' : 'sections'} could not be read` : ''}{v.partial ? ` · ${v.partial} ${v.partial === 1 ? 'section' : 'sections'} read in part` : ''}</p>
                {v.sections.map((s) => (
                  <section key={s.id} className="dbrief-sec" aria-labelledby={`dbrief-${s.id}`}>
                    <h3 id={`dbrief-${s.id}`}>{s.title}{s.count !== null ? ` (${s.count})` : s.count_words ? ` (${s.count_words})` : ''}</h3>
                    <ul>
                      {s.lines.map((l, i) => (
                        <li key={i} className={`dbrief-line${s.unreadable || l.unreadable ? ' dbrief-bad' : s.empty ? ' dbrief-none' : ''}`}>
                          {l.href ? <a href={l.href}>{l.text}</a> : l.text}
                        </li>
                      ))}
                    </ul>
                    {s.id === 'ticket_repairs' && s.count > 0 ? (
                      <p>
                        <button type="button" className="btn" data-key="brief-reconcile" disabled={fix.busy} title="Completes a recorded decision's missing paper position or journal entry. It never archives a project." onClick={reconcile}>{fix.busy ? 'Reconciling…' : 'Reconcile desk'}</button>
                        {fix.words ? <span role="status" className={fix.bad ? 'dbrief-bad' : 'dbrief-none'}>{` ${fix.words}`}</span> : null}
                      </p>
                    ) : null}
                  </section>
                ))}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
