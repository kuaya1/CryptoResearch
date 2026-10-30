// The Review queue (DESIGN_AND_IA_BLUEPRINT.md §3.4; Eric, 2026-10-17): one
// queue for "what needs me", replacing the Updates and Agenda pages. Pure:
// the React Review page draws from it and the tests check it.
//
// Groups, in this order: Changed since review, Review due, Waiting on you,
// Models differ, Imports to confirm. A project counts once (D3): it sits in
// the first group it qualifies for, with every reason it has named beside it,
// so the groups add up to the Desk's "Needs review" count plus the imports.
import { PROVIDER_LABELS, fmtDate } from './ui.js';
import { reviewReasons, lowGradeHidden } from './watchlist-model.js';
import { reviewChanges } from './attention-model.js';

export const GROUPS = [
  ['changed', 'Changed since review'],
  ['due', 'Review due'],
  ['waiting', 'Waiting on you'],
  ['differ', 'Models differ'],
  ['imports', 'Imports to confirm'],
];

// Each project's reasons (watchlist-model.js reviewReasons, the Desk's own
// rule, with the agenda's due item), each named with its group.
export function projectReasons(p, index, agendaRow = null, opts = {}) {
  return reviewReasons(p, index, agendaRow, opts).map((r) => ({ ...r, group: r.kind }));
}

// The queue: { groups: [{ id, label, items: [{ pid, name, symbol, reasons, agenda }] }], imports: [...], total }.
// Projects graded under 40 that Eric does not hold are left out unless
// includeLow; hidden_low counts those that would have been in it.
export function reviewQueue(index, agenda = null, { includeLow = false } = {}) {
  const rows = new Map(((agenda && agenda.rows) || []).map((r) => [r.project_id, r]));
  const order = GROUPS.map(([id]) => id);
  const byGroup = Object.fromEntries(order.map((id) => [id, []]));
  let hiddenLow = 0;
  for (const p of (index.projects || [])) {
    if (!p || p.broken || p.status === 'archived') continue;
    const row = rows.get(p.project_id) || null;
    const low = lowGradeHidden(p, index);
    const reasons = projectReasons(p, index, row, { includeLow });
    if (!includeLow && low && projectReasons(p, index, row, { includeLow: true }).length) hiddenLow += 1;
    if (!reasons.length) continue;
    const first = order.find((g) => reasons.some((r) => r.group === g));
    byGroup[first].push({ pid: p.project_id, name: p.name, symbol: p.symbol || null, reasons, agenda: row, changes: reviewChanges(p), due: row && row.primary && row.primary.due ? row.primary.due_at || null : null });
  }
  byGroup.changed.sort((a, b) => b.changes - a.changes || a.name.localeCompare(b.name));
  byGroup.due.sort((a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999')) || a.name.localeCompare(b.name));
  for (const g of ['waiting', 'differ']) byGroup[g].sort((a, b) => a.name.localeCompare(b.name));
  const inbox = (index.imports && index.imports.inbox && index.imports.inbox.in_inbox) || [];
  const pending = (index.imports && index.imports.requests_pending) || [];
  const imports = [
    ...inbox.map((f) => ({ kind: 'file', key: f.key, words: `${PROVIDER_LABELS[f.provider] || f.provider || 'A model'} file ${f.filename}: ${String(f.status || 'waiting').replace(/_/g, ' ')}`, detail: f.error || null })),
    ...pending.map((r) => ({ kind: 'request', key: r.request_id || r.file, words: `Request ${r.action || ''} waiting since ${fmtDate(r.waiting_since)}`.replace(/\s+/g, ' '), detail: r.utterance || null })),
  ];
  const groups = GROUPS.map(([id, label]) => ({ id, label, items: id === 'imports' ? [] : byGroup[id], count: id === 'imports' ? imports.length : byGroup[id].length }));
  const flat = groups.flatMap((g) => g.items.map((x) => ({ ...x, group: g.id })));
  return { groups, imports, flat, projects: flat.length, total: flat.length + imports.length, hidden_low: hiddenLow, include_low: includeLow };
}

// The calendar, as the Review page's Upcoming segment draws it (it was the
// Research page's Calendar tab): what is overdue, dated ahead, the review
// form's choices, the invalidators being monitored, the price alerts, the
// catalysts without a date and the dates from reports that have passed.
export function upcomingOf(index) {
  const today = index.today;
  const items = (index.calendar || []).filter((c) => c.status !== 'done' && c.status !== 'dismissed');
  return {
    today,
    overdue: items.filter((c) => c.overdue),
    dated: items.filter((c) => c.date && !c.overdue && c.type !== 'invalidator' && c.date >= today),
    pastReport: items.filter((c) => c.date && c.date < today && c.source === 'report'),
    undated: items.filter((c) => !c.date && c.type !== 'invalidator' && c.type !== 'alert'),
    invalidators: items.filter((c) => c.type === 'invalidator'),
    alerts: items.filter((c) => c.type === 'alert'),
  };
}

// Record IDs in words (L6, 2026-10-26): the agenda's sentences name reports
// (2026-10-26_claude_2472be7f), receipts and runs (fr_2026-10-27T022608Z_…)
// by ID; Review shows each as its date ("Claude's report of Oct 26",
// "receipt of Oct 27") and keeps the exact IDs for the tooltip. A long hash
// keeps its first eight characters. { text, ids }.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (y, m, d) => `${MON[Number(m) - 1]} ${Number(d)}`;
const ID_RE = /\b(\d{4})-(\d{2})-(\d{2})_(?:claude|chatgpt|gemini)_[0-9a-f]{8}\b|\b[a-z]{1,8}_(\d{4})-(\d{2})-(\d{2})T\d{6}Z(?:_[a-z0-9-]{2,24})?\b|\b([0-9a-f]{8})[0-9a-f]{32,56}\b/g;
export function plainIds(text) {
  const ids = [];
  const out = String(text == null ? '' : text).replace(ID_RE, (m, y, mo, d, y2, mo2, d2, hex) => {
    ids.push(m);
    if (hex) return `${hex}…`;
    return `of ${y ? day(y, mo, d) : day(y2, mo2, d2)}`;
  });
  return { text: out, ids };
}
