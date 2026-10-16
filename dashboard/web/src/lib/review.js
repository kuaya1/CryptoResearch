// Mark reviewed, the one way every control in the app does it (the
// inspector's button, its menu and R; the Overview's check-in): it sends the
// opinions drawn on screen, each model's report ID by the identity rule in
// opinion.js, never just the clock. The desk refuses, writing nothing, when a
// newer report arrived since the view was drawn (409 newer_report), and
// answers "unchanged" for the same reports or the same request again. One
// request ID per click, kept for Try again, so a lost answer applies once.
import { PROVIDERS, fmtDateTime } from '../../../public/ui.js';
import { newerReportWords } from '../../../public/watchlist-model.js';
import { api } from './desk.js';
import { opinionOf } from './opinion.js';

// Each model's report as drawn: { ready, seen }. A model whose list row
// names a report the record does not hold yet (still loading, or out of step
// with the list) is not ready, so Mark reviewed waits ("Still loading"). A
// model with no eligible report (none, or only one without text) is null.
export function seenOf(p, detail) {
  const seen = {};
  for (const m of PROVIDERS) {
    const s = p && p.providers ? p.providers[m] : null;
    if (!s || !s.report_id || s.broken || s.needs_text || s.latest_eligible === false) {
      seen[m] = null;
      continue;
    }
    const o = opinionOf(p, m, detail);
    if (o.status !== 'ok') return { ready: false, seen: null };
    seen[m] = o.report_id;
  }
  return { ready: true, seen };
}

export function newRequestId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return `rv_${c.randomUUID().replace(/-/g, '')}`;
  return `rv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

// A time on the clock today, else its date too.
export function fmtWhen(s) {
  const t = Date.parse(s);
  if (Number.isNaN(t)) return s || 'an unknown time';
  const opts = { timeZone: 'America/New_York' };
  const day = (x) => new Date(x).toLocaleDateString('en-US', opts);
  if (day(t) !== day(Date.now())) return fmtDateTime(s);
  return new Date(t).toLocaleTimeString('en-US', { ...opts, hour: 'numeric', minute: '2-digit' });
}

export const STILL_LOADING = 'Still loading';
export const NO_ANSWER = 'Not marked: the desk did not answer.';

// One attempt. Resolves to { kind, ... }:
//   reviewed  { result }   the receipt was written
//   unchanged { result, message }  "Already reviewed at <time>"
//   newer     { newer, message }   nothing was marked; "Show it"
//   no_answer { message }  the desk may or may not have written: Try again
//                          with the same request ID
//   refused   { message }  any other refusal, in the desk's words
//   signed_out             the page is leaving for sign-in
export async function sendReview(pid, { seen, note = null, requestId }) {
  try {
    const out = await api.post(`/api/projects/${encodeURIComponent(pid)}/reviewed`, { seen, note: note && note.trim() ? note.trim().slice(0, 2000) : null, request_id: requestId });
    const result = (out && out.result) || {};
    if (result.status === 'unchanged') return { kind: 'unchanged', result, message: `Already reviewed at ${fmtWhen(result.reviewed_at)}` };
    return { kind: 'reviewed', result };
  } catch (err) {
    if (err && err.status === 409 && err.code === 'NEWER_REPORT') return { kind: 'newer', newer: err.newer || [], message: newerReportWords(err.newer, fmtWhen) };
    if (err && err.status === 401) return { kind: 'signed_out', message: err.message };
    if (!err || !err.status || err.status >= 500 || err.code === 'CLIENT_TIMEOUT') return { kind: 'no_answer', message: NO_ANSWER };
    return { kind: 'refused', message: err.message };
  }
}

// Undo of one mark: puts back the review it replaced while it is the latest.
export function undoReview(pid, result) {
  return api.post(`/api/projects/${encodeURIComponent(pid)}/reviewed/undo`, { previous: result.previous === undefined ? null : result.previous, expect: result.reviewed_at });
}
