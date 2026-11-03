// Preferences > Desk controls in words (core/desk-controls.js,
// cr-desk-controls@1; blueprint 2026-11-02 row 2, §6.2). Pure: the panel and
// the tests draw from it. Each fact keeps its own row and its own state word;
// none is derived from another, so a STALE poll never hides a report saved
// since, and a fresh poll never stands in for one. Nothing here is fetched,
// stored or written.

const POLL_STATE = { fresh: ['Fresh', 'ok'], stale: ['STALE', 'warn'], never: ['Never seen', 'warn'], unknown: ['Unknown', 'warn'] };
const CLAIM_STATE = { none: ['No claim', 'quiet'], claimed: ['Claimed', 'work'], reconcile: ['Needs your check', 'warn'], expired: ['Expired', 'warn'], released: ['Released', 'quiet'], unreadable: ['Unknown', 'warn'] };
const MODEL_NAME = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };

// The desk-wide off switches, as the panel posts them to /api/settings. The
// server's view names the same bodies; the panel never posts one it was handed.
export const OFF_BODIES = Object.freeze({
  pause: { automation: { paused: true } },
  mandate_off: { automation: { autonomous_paper_loop: false } },
  admission_off: { automation: { lead_admission: { enabled: false } } },
});

const row = (key, label, state, tone, words, title = null) => ({ key, label, state, tone, words: words || null, title });

// The desk-wide facts: the poll, the sessions, freshness and authority.
export function deskRows(v) {
  if (!v || typeof v !== 'object') return [];
  const out = [];
  const [ps, pt] = POLL_STATE[v.poll && v.poll.state] || POLL_STATE.unknown;
  out.push(row('poll', 'Production poll', ps, pt, v.poll && v.poll.words, v.poll && v.poll.note));

  const s = v.dispatch && v.dispatch.sessions;
  if (!s || s.unreadable) out.push(row('sessions', 'Agent sessions today', 'Unknown', 'warn', 'The session ledger could not be read; no session starts.'));
  else out.push(row('sessions', 'Agent sessions today', `${s.used} of ${s.ceiling}`, s.left > 0 ? 'quiet' : 'warn', `${s.left} left today (${s.day}, New York).`));
  // Pilot research jobs released to manual (blueprint 2026-11-03 §4 PR 2).
  const rel = v.dispatch ? v.dispatch.released_pilot_jobs : null;
  if (rel === null || rel === undefined) out.push(row('released', 'Released to manual', 'Unknown', 'warn', 'Whether a pilot research job was released could not be read.'));
  else out.push(row('released', 'Released to manual', rel ? `${rel} job${rel === 1 ? '' : 's'}` : 'None', rel ? 'warn' : 'quiet', rel ? 'A pilot research job sat a day with no runner activity and went back to waiting for you or the pilot.' : null));

  const f = v.freshness || {};
  if (f.unreadable) out.push(row('freshness', 'Data freshness', 'Unknown', 'warn', f.words));
  else if ((f.book_waits || []).length) out.push(row('freshness', 'Data freshness', 'Waiting', 'warn', f.book_waits.join(' ')));
  else out.push(row('freshness', 'Data freshness', (f.waiting || []).length ? `${f.waiting.length} waiting` : 'Nothing waiting', (f.waiting || []).length ? 'warn' : 'ok', (f.waiting || []).map((w) => `${w.pair || w.project_id}: ${w.words}`).join(' ') || null));

  const a = v.authority || {};
  out.push(row('pause', 'Automation', a.paused ? 'Paused' : 'Running', a.paused ? 'warn' : 'ok', a.paused ? 'Nothing new is dispatched until you resume it in Models & budget.' : null));
  const m = a.mandate || {};
  if (m.on === null) out.push(row('mandate', 'Paper mandate', 'Unknown', 'warn', m.words));
  else if (m.on) out.push(row('mandate', 'Paper mandate', 'On', 'work', `Generation ${m.generation}${m.expires_at ? `, until ${m.expires_at}` : ''}.`));
  else out.push(row('mandate', 'Paper mandate', 'Off', 'quiet', m.loop_on ? m.why : null));
  const ad = a.admission || {};
  if (ad.on === null) out.push(row('admission', 'Automatic admission', 'Unknown', 'warn', ad.words));
  else if (ad.on) out.push(row('admission', 'Automatic admission', 'On', 'work', `Generation ${ad.generation}, up to ${ad.daily_limit} a day${ad.expires_at ? `, until ${ad.expires_at}` : ''}.`));
  else out.push(row('admission', 'Automatic admission', 'Off', 'quiet', ad.enabled ? ad.why : null));
  return out;
}

// One pilot project's facts: its claim, its reports' dates and its stop.
export function projectRows(p) {
  if (!p) return [];
  const out = [];
  const d = p.dispatch || {};
  const [cs, ct] = CLAIM_STATE[d.state] || CLAIM_STATE.unreadable;
  out.push(row('dispatch', 'Dispatch', cs, ct, d.words));
  const rr = p.research_release;
  if (rr && rr.unreadable) out.push(row('release', 'Research job', 'Unknown', 'warn', rr.words));
  else if (rr) out.push(row('release', 'Research job', 'Released to manual', 'warn', rr.words));
  const r = p.reports || {};
  if (r.unreadable) out.push(row('reports', 'Reports', 'Unknown', 'warn', r.words));
  else {
    const have = Object.entries(r).filter(([, x]) => x);
    if (!have.length) out.push(row('reports', 'Reports', 'None eligible', 'quiet', null));
    for (const [model, x] of have) {
      out.push(row(`report-${model}`, `${MODEL_NAME[model] || model} report`, `Saved ${x.imported_at || 'at an unrecorded time'}`, 'quiet', x.analysis_at ? `Analysis date ${x.analysis_at}.` : 'No analysis date on record.'));
    }
  }
  const st = p.stop || {};
  out.push(row('stop', 'Project stop', st.stopped ? (st.unreadable ? 'Held' : 'Stopped') : 'Not stopped', st.stopped ? 'warn' : 'quiet', st.words));
  return out;
}

// The off-only actions the view offers now: desk-wide, then per project.
export function offActions(v) {
  if (!v || !v.controls) return [];
  return ['pause', 'mandate_off', 'admission_off'].filter((k) => v.controls[k] && v.controls[k].available).map((k) => ({ id: k, project_id: null, ...v.controls[k] }));
}

// Find a control in a later read of the view, for its readback.
export function controlIn(v, id, projectId = null) {
  if (!v) return null;
  if (!projectId) return v.controls ? v.controls[id] || null : null;
  const p = (v.projects || []).find((x) => x.project_id === projectId);
  return p && p.controls ? p.controls[id] || null : null;
}

const DONE = { pause: 'automation is paused', mandate_off: 'the paper mandate is off', admission_off: 'automatic admission is off', stop: 'the project is stopped' };

// What the view read back after an action: { ok, words }.
// The body of a reconcile click: the attempt the panel shows, or nothing to
// post when none is shown (audit F4).
export function reconcileBody(rc) {
  return rc && typeof rc.attempt_id === 'string' && rc.attempt_id ? { reconciled: true, attempt_id: rc.attempt_id } : null;
}

// Eric's "I checked the desk" is about one attempt (N3, post-remediation audit
// 2026-11-02). It is kept under the project AND the attempt the panel showed,
// never the project alone: when the view reads back another attempt, or none,
// the box reads clear and Release is disabled until he checks again.
export function ackKey(projectId, rc) {
  const attempt = rc && rc.available === true && typeof rc.attempt_id === 'string' && rc.attempt_id ? rc.attempt_id : null;
  return projectId && attempt ? `${projectId}:${attempt}` : null;
}

// The acknowledgements that still name an attempt the view offers to
// reconcile; every other one is dropped as soon as the view is read, so an
// attempt that leaves and comes back is never shown as already checked.
export function pruneAcks(checked, v) {
  const live = new Set((v && v.projects ? v.projects : []).map((p) => ackKey(p.project_id, p.controls && p.controls.reconcile)).filter(Boolean));
  const out = {};
  for (const [k, on] of Object.entries(checked || {})) if (on === true && live.has(k)) out[k] = true;
  return out;
}

// What the panel draws for a project's reconcile control: the key its
// checkbox writes, whether it reads checked, and whether Release is enabled.
export function reconcileControl(checked, projectId, rc, busy = null) {
  const key = ackKey(projectId, rc);
  const acknowledged = Boolean(key && checked && checked[key] === true);
  return { key, acknowledged, enabled: acknowledged && busy === null && reconcileBody(rc) !== null };
}

export function readback(v, id, projectId = null, attemptId = null) {
  if (id === 'reconcile') {
    const p = v && (v.projects || []).find((x) => x.project_id === projectId);
    const d = p && p.dispatch;
    const ok = Boolean(attemptId && d && d.attempt_id === attemptId && d.state === 'released' && d.outcome === 'reconciled');
    return { ok, words: ok ? `Read back: attempt ${attemptId} released as reconciled.` : `The desk does not read attempt ${attemptId || '(none named)'} as reconciled${d && d.attempt_id && d.attempt_id !== attemptId ? `; it now shows attempt ${d.attempt_id}` : ''}. Check it again.` };
  }
  const c = controlIn(v, id, projectId);
  const ok = Boolean(c && c.done === true);
  const what = DONE[id] || 'the change';
  return { ok, words: ok ? `Read back: ${what}.` : `The desk does not read back that ${what} yet; check it again.` };
}
