// The project page's addresses (#/project/<id>/<tab>) and where the former
// ones lead (Eric, 2026-10-05, D1; the brief's three views, 2026-10-07).
// Pure, for the app shell and the tests; views/project.js re-exports it.

// The brief's three views first (Overview keeps the address "brief", so every
// link to the Brief lands on it), then the report, the market and your notes.
export const PROJECT_TABS = [
  ['brief', 'Overview'],
  ['compare', 'Compare'],
  ['evidence', 'Evidence'],
  ['forensics', 'Forensics'],
  ['report', 'Full report'],
  ['market', 'Market'],
  ['notes', 'Notes'],
];

const MODELS = ['claude', 'chatgpt', 'gemini'];

// The opinion a project page has chosen, from its address (review
// 2026-10-08, F4): { model, report }, each null when not chosen. On Full
// report the model is the shown report's own, and the report counts as
// chosen only when it is not that model's latest eligible report (`latest`,
// the desk's own selector), so visiting a report never pins the latest.
export function selectionOf(tab, query, { latest = {}, providerOf = () => null } = {}) {
  const q = new URLSearchParams(query);
  let model = MODELS.includes(q.get('model')) ? q.get('model') : null;
  const report = q.get('report') || null;
  if (tab === 'report') {
    if (!report) return { model, report: null };
    const prov = providerOf(report) || model;
    return { model: prov, report: prov && latest[prov] === report ? null : report };
  }
  if (report && !model) model = providerOf(report);
  return { model, report: model ? report : null };
}

// A link to another section of the same project carrying that choice: the
// Overview and Evidence keep the model and a chosen report; Full report opens
// the chosen report, else the model's latest; Compare, Market and Notes carry
// it for the way back (Compare keeps its own pair apart). Nothing chosen: the
// plain address, as before.
export function sectionHref(pid, to, sel = {}, { latest = {} } = {}) {
  const q = new URLSearchParams();
  const model = MODELS.includes(sel.model) ? sel.model : null;
  if (to === 'report') {
    const rid = sel.report || (model ? latest[model] || null : null);
    if (rid) q.set('report', rid);
    if (model) q.set('model', model);
  } else {
    if (model) q.set('model', model);
    if (model && sel.report) q.set('report', sel.report);
  }
  const qs = q.toString();
  return `#/project/${encodeURIComponent(pid)}/${to}${qs ? `?${qs}` : ''}`;
}

// The review check-in's base (Overview, ?base=<receipt>): the review receipt
// its rows start from, so a reload, Back or a new tab draws the same
// comparison. Null for your latest review.
const RECEIPT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
export function baseOf(query) {
  const v = new URLSearchParams(query).get('base');
  return v && RECEIPT_RE.test(v) && !v.includes('..') ? v : null;
}

// The Overview's check-in from a given review receipt, keeping the model and
// report chosen on the page.
export function checkInHref(pid, base, sel = {}) {
  const q = new URLSearchParams();
  if (MODELS.includes(sel.model)) q.set('model', sel.model);
  if (MODELS.includes(sel.model) && sel.report) q.set('report', sel.report);
  if (base && RECEIPT_RE.test(base)) q.set('base', base);
  const qs = q.toString();
  return `#/project/${encodeURIComponent(pid)}/brief${qs ? `?${qs}` : ''}`;
}

// The project page's former tabs and the Claude Brief's own page, mapped to
// their new home. The hash to go to, or null.
export function projectRedirect(name, args, query) {
  const q = new URLSearchParams(query);
  const enc = encodeURIComponent;
  const pid = args[0];
  if (!pid) return null;
  const to = (tab, params) => {
    const qs = new URLSearchParams(params).toString();
    return `#/project/${enc(pid)}/${tab}${qs ? `?${qs}` : ''}`;
  };
  if (name === 'brief') return to('brief', { model: 'claude', ...(q.get('report') ? { report: q.get('report') } : {}) });
  if (name !== 'project') return null;
  const tab = args[1];
  const model = q.get('provider') || q.get('model');
  const run = q.get('run') ? { run: q.get('run') } : {};
  // The Brief's former folds now live on its other views (2026-10-07).
  if (tab === 'brief') {
    const open = q.get('open');
    if (open === 'compare') return to('compare', {});
    if (open === 'evidence') return to('evidence', { ...(model ? { model } : {}), open: 'claims' });
    if (open === 'runs' || (!open && q.get('run'))) return to('evidence', { open: 'runs', ...run });
    if (open === 'identity') return to('evidence', { open: 'identity' });
    return null;
  }
  switch (tab) {
    case undefined: case 'overview': return to('brief', {});
    case 'scorecards': return to('brief', { ...(model ? { model } : {}), open: 'scorecard' });
    case 'reports': return to('report', q.get('report') ? { report: q.get('report') } : {});
    case 'comparison': return to('compare', {});
    case 'research': return to('evidence', { open: 'runs', ...run });
    case 'history': return to('notes', {});
    default: return PROJECT_TABS.some(([t]) => t === tab) ? null : to('brief', {});
  }
}
