// Preferences > Desk controls (cr-desk-controls@1; blueprint 2026-11-02 row
// 2, §6.2). The five facts apart, from GET /api/desk/controls, and the
// controls that only turn things off: pause, mandate off, admission off and
// each pilot project's stop. Each action posts a fixed route and body (the
// settings write with OFF_BODIES, the project's autonomy stop, the claim's
// release as reconciled), then reads the view again and says what it read back. Reconcile is
// offered only for an expired claim, after Eric says he checked the desk, and
// goes through the release route as {"reconciled":true} with the attempt the
// panel shows, read back as that same attempt (audit F4); nothing retries.
// His check is kept per project and attempt (N3): a read that shows another
// attempt, or none, clears it and disables Release until he checks again.
// Opening it reads only.
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '../../../public/ui.js';
import { api, refresh } from '../lib/desk.js';
import { deskRows, projectRows, offActions, readback, reconcileBody, reconcileControl, pruneAcks, OFF_BODIES } from '../../../public/desk-controls-model.js';

const WAIT_MS = 12000;
const enc = encodeURIComponent;

function FactRows({ rows, idPrefix }) {
  return (
    <dl className="dc-facts">
      {rows.map((r) => (
        <div key={r.key} className="dc-fact" data-key={`${idPrefix}-${r.key}`} title={r.title || undefined}>
          <dt>{r.label}</dt>
          <dd>
            <span className={`dc-state tone-${r.tone}`}>{r.state}</span>
            {r.words ? <span className="dc-words">{r.words}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default function DeskControls() {
  const [v, setV] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const [said, setSaid] = useState(null);
  const [checked, setChecked] = useState({});
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    setErr(null);
    let timer;
    try {
      const got = await Promise.race([
        api.get('/api/desk/controls'),
        new Promise((_, no) => { timer = setTimeout(() => no(new Error('The desk controls are taking too long to read.')), WAIT_MS); }),
      ]);
      if (alive.current) {
        // Eric's check is about the attempt shown (N3): any acknowledgement
        // for an attempt this read no longer offers clears at once.
        setChecked((x) => pruneAcks(x, got));
        setV(got);
      }
      return got;
    } catch (e) {
      if (alive.current) setErr(e.message);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (id, projectId, rc = null) => {
    setBusy(`${projectId || 'desk'}:${id}`);
    setSaid(null);
    try {
      // Fixed routes and bodies only: the desk-wide switches turn off through
      // the settings write, a project stops through its autonomy route, and a
      // claim is released only as reconciled. Nothing here turns anything on.
      if (id === 'stop') await api.post(`/api/projects/${enc(projectId)}/autonomy`, { action: 'stop' });
      else if (id === 'reconcile') {
        // The attempt shown and checked is the one released (F4, N3).
        const body = reconcileBody(rc);
        if (!body || !reconcileControl(checked, projectId, rc).acknowledged) throw new Error('No attempt you checked is shown to reconcile.');
        await api.post(`/api/projects/${enc(projectId)}/pilot-claim/release`, body);
      }
      else if (OFF_BODIES[id]) await api.post('/api/settings', OFF_BODIES[id]);
      else throw new Error('That control is not an off switch.');
      const after = await load();
      const rb = readback(after, id, projectId, rc ? rc.attempt_id : null);
      if (alive.current) setSaid(rb);
      toast(rb.words, rb.ok ? undefined : 'bad');
      if (id === 'reconcile') setChecked((x) => pruneAcks(x, after));
      await refresh();
    } catch (e) {
      if (alive.current) setSaid({ ok: false, words: e.message });
      toast(e.message, 'bad');
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  if (err && !v) {
    return (
      <section className="l2-panel" aria-labelledby="prefs-dc-h">
        <header className="l2-panel-head"><h3 className="l2-panel-t" id="prefs-dc-h">Desk controls</h3></header>
        <div className="l2-panel-body">
          <p className="l2-err" role="alert">{err}</p>
          <div className="l2-actions"><button type="button" className="btn btn-sm" data-key="prefs-dc-retry" onClick={load}>Try again</button></div>
        </div>
      </section>
    );
  }
  if (!v) return <p className="dc-loading" role="status">Loading desk controls…</p>;

  const actions = offActions(v);
  return (
    <>
      <section className="l2-panel" aria-labelledby="prefs-dc-h" data-key="prefs-dc-desk">
        <header className="l2-panel-head">
          <h3 className="l2-panel-t" id="prefs-dc-h" title={`Read at ${v.at}. Each fact comes from its own record; none is inferred from another.`}>The desk</h3>
        </header>
        <div className="l2-panel-body">
          <FactRows rows={deskRows(v)} idPrefix="prefs-dc" />
          {actions.length ? (
            <div className="l2-actions" role="group" aria-label="Turn off">
              {actions.map((c) => (
                <button key={c.id} type="button" className={`btn btn-sm${c.id === 'pause' ? ' btn-danger' : ''}`} disabled={busy !== null} data-key={`prefs-dc-${c.id}`} onClick={() => act(c.id, null)}>
                  {busy === `desk:${c.id}` ? 'Saving…' : c.label}
                </button>
              ))}
            </div>
          ) : null}
          {said ? <p className={`dc-said tone-${said.ok ? 'ok' : 'warn'}`} role="status" data-key="prefs-dc-readback">{said.words}</p> : null}
        </div>
      </section>
      {v.dispatch && v.dispatch.projects_unreadable ? <p className="l2-err" role="alert">{v.dispatch.projects_unreadable}</p> : null}
      {(v.projects || []).map((p) => {
        const rc = p.controls && p.controls.reconcile;
        const st = p.controls && p.controls.stop;
        const ack = reconcileControl(checked, p.project_id, rc, busy);
        return (
          <section key={p.project_id} className="l2-panel" aria-labelledby={`prefs-dc-p-${p.project_id}`} data-key={`prefs-dc-project-${p.project_id}`}>
            <header className="l2-panel-head">
              <h3 className="l2-panel-t" id={`prefs-dc-p-${p.project_id}`} title={`Next step: ${p.next_step}`}>{p.name}</h3>
            </header>
            <div className="l2-panel-body">
              <FactRows rows={projectRows(p)} idPrefix={`prefs-dc-${p.project_id}`} />
              <div className="l2-actions">
                {st && st.available ? (
                  <button type="button" className="btn btn-sm btn-danger" disabled={busy !== null} data-key={`prefs-dc-stop-${p.project_id}`} onClick={() => act('stop', p.project_id)}>
                    {busy === `${p.project_id}:stop` ? 'Stopping…' : 'Stop this project'}
                  </button>
                ) : null}
                {rc && rc.available ? (
                  <>
                    <label className="dc-check">
                      <input type="checkbox" checked={ack.acknowledged} data-key={`prefs-dc-checked-${p.project_id}`} data-attempt={rc.attempt_id} onChange={(e) => { const k = ack.key; if (k) setChecked((x) => ({ ...x, [k]: e.target.checked })); }} />
                      <span>I checked the desk for attempt {rc.attempt_id}'s report or ticket</span>
                    </label>
                    <button type="button" className="btn btn-sm" disabled={!ack.enabled} data-key={`prefs-dc-reconcile-${p.project_id}`} onClick={() => act('reconcile', p.project_id, rc)}>
                      {busy === `${p.project_id}:reconcile` ? 'Releasing…' : 'Release as reconciled'}
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          </section>
        );
      })}
    </>
  );
}
