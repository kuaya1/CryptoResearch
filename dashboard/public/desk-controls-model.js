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
export function readback(v, id, projectId = null) {
  if (id === 'reconcile') {
    const p = v && (v.projects || []).find((x) => x.project_id === projectId);
    const ok = Boolean(p && p.dispatch && p.dispatch.state === 'released' && p.dispatch.outcome === 'reconciled');
    return { ok, words: ok ? `Read back: attempt ${p.dispatch.attempt_id} released as reconciled.` : 'The desk does not read the claim as reconciled yet; check it again.' };
  }
  const c = controlIn(v, id, projectId);
  const ok = Boolean(c && c.done === true);
  const what = DONE[id] || 'the change';
  return { ok, words: ok ? `Read back: ${what}.` : `The desk does not read back that ${what} yet; check it again.` };
}
