// One attention contract (cr-attention@1, subtraction stage 3, 2026-10-29):
// what needs Eric, decided once over the desk's own index rows and read the
// same way by the Desk's PM cards, the Review queue, the Daily Brief and the
// CLI (core/brief-daily.js requires this file). Pure: no fetch, no write, no
// clock of its own.
//
// Three collections:
//   decisions   PM cards: a readable ticket waiting for Eric's decision
//               (pending_pm_review or re-opened, not yet decided). A desk gate
//               closed at $0 on a token he does not hold is not a card: it is
//               counted once under "Closed by the desk". A Trim / exit is
//               always a card. A low grade never hides a card.
//   exceptions  something broken or about to lapse, each with one identity
//               (project + record + reason) and one recovery action.
//   progress    one line of what the desk finished since yesterday.
// A count the desk could not read is null and says "Unknown", never 0.

export const VERSION = 'cr-attention@1';

const list = (v) => (Array.isArray(v) ? v : []);
const live = (p) => Boolean(p) && !p.broken && p.status !== 'archived';
const usable = (t) => (t && !t.unavailable ? t : null);
const words = (s) => String(s || '').replace(/_/g, ' ');

// One project's PM decision: 'card', 'closed' (a desk gate at $0 on a token
// not held), 'unreadable' (its ticket could not be read) or null.
export function pmDecision(p) {
  if (!live(p) || !p.ticket) return null;
  if (p.ticket.unavailable) return 'unreadable';
  const t = p.ticket;
  if (t.decision || !['pending_pm_review', 'reopened'].includes(t.status)) return null;
  if (t.proposal_type === 'TRIM_EXIT') return 'card';
  if (t.desk_gate && !(t.suggested_risk_usd > 0) && !p.held) return 'closed';
  return 'card';
}

// { cards, closed, unreadable, count } over the index rows. `count` is the
// number of cards, null when a ticket could not be read (the count is then
// unknown).
export function decisionsOf(rows) {
  const cards = [];
  const closed = [];
  const unreadable = [];
  for (const p of list(rows)) {
    const k = pmDecision(p);
    if (k === 'card') cards.push(p);
    else if (k === 'closed') closed.push(p);
    else if (k === 'unreadable') unreadable.push(p);
  }
  return { cards, closed, unreadable, count: unreadable.length ? null : cards.length };
}

// The digest's count that puts a project back in "Changed since review": new
// eligible reports and material external or forensic events only, never
// Eric's own notes or the research runs he started (core/digest.js
// review_count). An index older than review_count falls back to nothing.
export function reviewChanges(p) {
  const n = p && p.changes && p.changes.review_count;
  return typeof n === 'number' && n > 0 ? n : 0;
}

const exception = (project, record, reason, text, label, href) => ({
  key: `${project || 'desk'}:${record || '-'}:${reason}`,
  project_id: project || null,
  record: record || null,
  reason,
  words: text,
  action: { label, href },
});

// The exceptions over the index and the desk-wide reads core/brief-daily.js
// hands in (`extra`: jobs, restored, queue, trader, intake). Each list may be
// `null` when its record could not be read: that source is then one
// exception saying so, and the count is unknown.
export function exceptionsOf(index, extra = {}) {
  const rows = list(index && index.projects).filter(live);
  const name = new Map(rows.map((p) => [p.project_id, p.name]));
  const out = [];
  const unread = [];
  for (const p of rows) {
    const t = usable(p.ticket);
    if (p.ticket && p.ticket.unavailable) unread.push(exception(p.project_id, null, 'ticket_unreadable', `${p.name}: the ticket could not be read (${String(p.ticket.error || 'unknown error').replace(/\.$/, '')}).`, 'Open the project', `#/?p=${p.project_id}`));
    if (t && t.status === 'invalidated') out.push(exception(p.project_id, t.receipt_id, 'invalidated', `${p.name}: ${(t.invalidation && t.invalidation.words) || 'the ticket is invalidated'}`, 'Re-open or pass on the card', `#/?p=${p.project_id}`));
    if (t && t.decision && t.decision.paper === 'missing') out.push(exception(p.project_id, t.decision.decision_id, 'paper_missing', `${p.name}: the grant is recorded but its paper position is missing.`, 'Complete paper position', `#/?p=${p.project_id}`));
    const provs = (p.research && p.research.providers) || {};
    for (const [prov, job] of Object.entries(provs)) {
      if (!job) continue;
      if (job.state === 'uncertain') out.push(exception(p.project_id, job.run_id, `uncertain_${prov}`, `${p.name}: a paid ${prov} call may have been billed with no answer saved.`, 'Check usage, then reconcile', `#/project/${p.project_id}/evidence?open=runs`));
      if (job.budget_wait) out.push(exception(p.project_id, job.run_id, `budget_wait_${prov}`, `${p.name}: ${prov} research waits for the ${words(job.budget_wait.limit)} budget until ${job.budget_wait.until || job.budget_wait.resets_at || 'its reset'}.`, 'Models & budget', '#/?prefs=models'));
    }
  }
  const source = (key, items, fn) => {
    if (items === null) { unread.push(exception(null, key, `${key}_unreadable`, `The ${words(key)} record could not be read.`, 'Open Activity', '#/?prefs=activity')); return; }
    for (const x of list(items)) { const e = fn(x); if (e) out.push(e); }
  };
  source('queue', extra.queue, (q) => (q.step === 'ticket_failed' ? exception(q.project_id, q.ticket_id, 'ticket_failed', `${q.name || name.get(q.project_id) || q.project_id}: the Prosecutor's save was refused${q.refused_field ? ` (${q.refused_field})` : ''}.`, 'Run the Prosecutor again', `#/?p=${q.project_id}`) : null));
  source('jobs', extra.jobs, (j) => (j.failing ? exception(null, j.job, 'job_failing', `The ${j.job} job failed at ${j.at || 'an unknown time'}: ${j.error || 'no reason recorded'}.`, 'Open Activity', '#/?prefs=activity') : null));
  source('trader', extra.trader, (x) => exception(x.project_id, x.record, x.reason, x.words, x.reason === 'exit_expiring' ? 'Quote exits again' : 'Open the Paper Book', x.reason === 'exit_expiring' ? `#/project/${x.project_id}/forensics?fx=exits` : '#/research?tab=outcomes'));
  source('intake', extra.intake, (d) => exception(null, d.intake_id, 'intake_ambiguous', `A research request${d.label ? ` (${d.label})` : ''} matches more than one project.`, 'Choose the project', `#/new/${encodeURIComponent(d.intake_id)}`));
  if (extra.restored) out.push(exception(null, 'restored-copy', 'restored_copy', 'This is a restored copy: research asks no provider until it is released.', 'Release the copy', '#/?prefs=data'));
  const all = [...unread, ...out];
  return { items: all, count: unread.length ? null : all.length, unreadable: unread.length };
}

// "Unknown" for a count that could not be read; never 0.
export const countWords = (n) => (typeof n === 'number' ? String(n) : 'Unknown');
