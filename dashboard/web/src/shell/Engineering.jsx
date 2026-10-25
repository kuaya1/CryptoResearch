// Preferences > Developer > Engineering (Connected Engineering v1,
// 2026-10-25; audits/2026-10-25-connected-engineering): Eric's own decisions
// on the engineering inbox. Pausing everything, activating or revoking a
// delegation, and authorizing, pausing, resuming, cancelling or reopening one
// task, each its own button. On the online desk activating a delegation and
// authorizing a task take the passphrase again. Opening it reads
// GET /api/engineering and writes nothing.
import { useEffect, useState } from 'react';
import { toast } from '../../../public/ui.js';
import { api } from '../lib/desk.js';

const STATUS_WORDS = {
  prepared: 'Draft',
  awaiting_authorization: 'Waiting for you',
  admitted: 'Admitted',
  queued: 'Queued',
  claimed: 'Claimed',
  implementing: 'Building',
  verifying: 'Verifying',
  review_pending: 'Review pending',
  ready_for_promotion: 'Ready to merge',
  merged: 'Merged',
  blocked: 'Blocked',
  paused: 'Paused',
  cancelled: 'Cancelled',
  superseded: 'Superseded',
};
const ago = (iso) => (iso ? String(iso).slice(0, 16).replace('T', ' ') : '—');

export default function Engineering({ hosted }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const [pass, setPass] = useState('');
  const [tpl, setTpl] = useState('eng-docs@1');
  const [goalId, setGoalId] = useState('');
  const [goal, setGoal] = useState('');
  const [days, setDays] = useState('');
  const load = () => api.get('/api/engineering').then((x) => { setD(x); setErr(null); }, (e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const decide = async (key, path, body = {}, said = 'Saved') => {
    setBusy(key);
    try {
      const r = await api.post(path, body);
      toast(r.says || said);
      setPass('');
      await load();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(null);
    }
  };
  if (err && !d) return <section className="l2-panel"><div className="l2-panel-body"><p className="l2-err" role="alert">{err}</p><button type="button" className="btn btn-sm" onClick={load}>Try again</button></div></section>;
  if (!d) return <section className="l2-panel"><div className="l2-panel-body"><p className="l2-note">Loading…</p></div></section>;
  const template = d.templates.find((t) => t.template === tpl) || d.templates[0];
  const active = d.policies.filter((p) => p.active);
  const needPass = hosted && !pass;
  return (
    <section className="l2-panel" aria-labelledby="prefs-dev-eng" data-key="prefs-engineering">
      <header className="l2-panel-head"><h3 className="l2-panel-t" id="prefs-dev-eng" title="Tasks ChatGPT prepares from your direction and Claude builds. Nothing outside an active delegation is built until you authorize that exact version here.">Engineering</h3></header>
      <div className="l2-panel-body l2-stack">
        <dl className="l2-kv">
          <div><dt>State</dt><dd>{d.paused ? `Paused${d.paused_reason ? ` (${d.paused_reason})` : ''}` : 'Running'}</dd></div>
          <div><dt>Connector address</dt><dd>{d.mcp_url ? <code className="wrap-anywhere">{d.mcp_url}</code> : 'On the online desk only'}</dd></div>
          <div><dt>Connections</dt><dd>{d.connections.length ? d.connections.map((c) => `${c.assistant_label} (${c.client_name}, last used ${c.last_used_at ? ago(c.last_used_at) : 'never'})`).join('; ') : 'None'}</dd></div>
        </dl>
        <div className="l2-actions">
          <button type="button" className={`btn btn-sm${d.paused ? ' btn-primary' : ''}`} disabled={busy === 'pause'} data-key="eng-pause-all" onClick={() => decide('pause', '/api/engineering/pause', { paused: !d.paused, reason: d.paused ? null : 'paused by Eric' }, d.paused ? 'Engineering resumed' : 'Engineering paused: nothing is claimed, admitted or promoted')}>{d.paused ? 'Resume engineering' : 'Pause all engineering'}</button>
        </div>
        {hosted ? (
          <label className="prefs-field" title="Needed to activate a delegation or authorize a task. It is checked and never stored.">
            <span>Desk passphrase</span>
            <input className="input" type="password" autoComplete="current-password" value={pass} data-key="eng-passphrase" onChange={(e) => setPass(e.target.value)} />
          </label>
        ) : null}

        <h4 className="eng-sub">Delegations</h4>
        {active.length ? (
          <ul className="l2-list" data-key="eng-policies">
            {active.map((p) => (
              <li key={p.policy_id} title={`${p.says} Paths: ${p.allowed_paths.join(', ')}. Review: ${p.required_review}.`}>
                <strong>{p.title}</strong> · {p.policy_id}{p.goal ? ` · ${p.goal}` : ''} · until {ago(p.expires_at)}
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy === p.policy_id} data-key={`eng-revoke-${p.policy_id}`} onClick={() => decide(p.policy_id, `/api/engineering/policies/${p.policy_id}/revoke`, { reason: 'revoked by Eric' }, 'Delegation revoked')}>Revoke</button>
              </li>
            ))}
          </ul>
        ) : <p className="l2-note">No delegation is active: every task waits for you.</p>}
        <form className="l2-form prefs-form" data-key="eng-activate" onSubmit={(e) => { e.preventDefault(); decide('activate', '/api/engineering/policies', { template: tpl, goal_id: goalId || null, goal: goal || null, days: days ? Number(days) : null, password: pass }, 'Delegation activated'); }}>
          <label className="prefs-field" title={template ? `${template.says} Paths: ${template.allowed_paths.join(', ')}. Review: ${template.required_review}. At most ${template.limits.max_open_tasks} open tasks and ${template.limits.max_admissions_per_day} admissions a day.` : ''}>
            <span>Template</span>
            <select className="input" value={tpl} data-key="eng-template" onChange={(e) => setTpl(e.target.value)}>
              {d.templates.map((t) => <option key={t.template} value={t.template}>{t.title} ({t.template})</option>)}
            </select>
          </label>
          {template && template.requires_goal ? (
            <>
              <label className="prefs-field" title="Lower-case letters, digits and hyphens."><span>Goal ID</span><input className="input" value={goalId} data-key="eng-goal-id" onChange={(e) => setGoalId(e.target.value)} /></label>
              <label className="prefs-field"><span>Goal</span><input className="input" value={goal} maxLength={300} data-key="eng-goal" onChange={(e) => setGoal(e.target.value)} /></label>
            </>
          ) : null}
          <label className="prefs-field" title={template ? `1 to ${template.max_days}; empty for ${template.max_days}.` : ''}><span>Days</span><input className="input" inputMode="numeric" value={days} data-key="eng-days" onChange={(e) => setDays(e.target.value)} /></label>
          <div className="l2-actions"><button type="submit" className="btn btn-sm" disabled={busy === 'activate' || needPass} data-key="eng-activate-go">Activate delegation</button></div>
        </form>

        <h4 className="eng-sub">Tasks</h4>
        {d.tasks.length ? (
          <ul className="l2-list" data-key="eng-tasks">
            {d.tasks.map((t) => (t.unsupported ? <li key={t.task_id}>{t.task_id}: {t.says || 'unsupported record'}</li> : (
              <li key={t.task_id} title={t.next_action}>
                <strong>{t.title}</strong> · {STATUS_WORDS[t.status] || t.status}{t.admission && t.admission.number ? ` · item ${t.admission.number}` : ''} · v{t.version} <code title={t.content_sha256}>{t.content_sha256.slice(0, 12)}</code>
                {t.status_reason ? <div className="l2-note">{t.status_reason}</div> : null}
                <div className="l2-actions">
                  {t.status === 'awaiting_authorization' ? <button type="button" className="btn btn-primary btn-sm" disabled={busy === t.task_id || needPass} data-key={`eng-authorize-${t.task_id}`} onClick={() => decide(t.task_id, `/api/engineering/tasks/${t.task_id}/authorize`, { version: t.version, content_sha256: t.content_sha256, password: pass }, 'Authorized')}>Authorize version {t.version}</button> : null}
                  {!['paused', 'merged', 'cancelled', 'superseded'].includes(t.status) ? <button type="button" className="btn btn-sm" disabled={busy === t.task_id} data-key={`eng-pause-${t.task_id}`} onClick={() => decide(t.task_id, `/api/engineering/tasks/${t.task_id}/pause`, { reason: 'paused by Eric' }, 'Paused')}>Pause</button> : null}
                  {t.status === 'paused' ? <button type="button" className="btn btn-sm" disabled={busy === t.task_id} data-key={`eng-resume-${t.task_id}`} onClick={() => decide(t.task_id, `/api/engineering/tasks/${t.task_id}/resume`, {}, 'Resumed')}>Resume</button> : null}
                  {t.status === 'blocked' ? <button type="button" className="btn btn-sm" disabled={busy === t.task_id} data-key={`eng-reopen-${t.task_id}`} onClick={() => decide(t.task_id, `/api/engineering/tasks/${t.task_id}/reopen`, {}, 'Reopened with three more attempts')}>Reopen</button> : null}
                  {!['merged', 'cancelled', 'superseded'].includes(t.status) ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy === t.task_id} data-key={`eng-cancel-${t.task_id}`} onClick={() => { if (window.confirm(`Cancel ${t.title}? Its backlog number is released; nothing already merged changes.`)) decide(t.task_id, `/api/engineering/tasks/${t.task_id}/cancel`, { reason: 'cancelled by Eric' }, 'Cancelled'); }}>Cancel</button> : null}
                </div>
              </li>
            )))}
          </ul>
        ) : <p className="l2-note">No engineering tasks yet.</p>}
      </div>
    </section>
  );
}
