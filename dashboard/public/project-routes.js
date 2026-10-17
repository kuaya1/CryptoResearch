// The project page's addresses (#/project/<id>/<tab>) and where the former
// ones lead (Eric, 2026-10-05, D1; the brief's three views, 2026-10-07).
// Pure, for the app shell and the tests; views/project.js re-exports it.

// The deep audit's sections (Level 2, DESIGN_AND_IA_BLUEPRINT.md §3.3; Eric,
// 2026-10-17): Brief (the address "brief", so every link to the Brief lands
// on it), Evidence, Forensics, Market, Contract (split out of Market), Report,
// Record (the run, its exact prompt, history and receipts) and Notes. Compare
// is no longer a section: it is a mode of the model switcher (Claude |
// ChatGPT | Gemini | Compare) at its own address, "compare".
export const PROJECT_TABS = [
  ['brief', 'Brief'],
  ['evidence', 'Evidence'],
  ['forensics', 'Forensics'],
  ['market', 'Market'],
  ['contract', 'Contract'],
  ['report', 'Report'],
  ['record', 'Record'],
  ['notes', 'Notes'],
];
// Every address a project page answers: the sections and the Compare mode.
export const PROJECT_VIEWS = [...PROJECT_TABS.map(([t]) => t), 'compare'];
// The sections that show the model switcher (each draws one model's report).
export const MODEL_VIEWS = ['brief', 'compare', 'evidence', 'report'];

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
  const keep = (k) => (q.get(k) ? { [k]: q.get(k) } : {});
  const open = q.get('open');
  // The Brief's former folds live on its other views (2026-10-07); the run,
  // the technical records and the headline on Record, the token identity on
  // Contract (2026-10-17).
  if (tab === 'brief') {
    if (open === 'compare') return to('compare', {});
    if (open === 'evidence') return to('evidence', { ...(model ? { model } : {}), open: 'claims' });
    if (open === 'runs' || (!open && q.get('run'))) return to('record', { ...(model ? { model } : {}), open: 'runs', ...run });
    if (open === 'identity') return to('contract', { open: 'identity' });
    if (open === 'headline') return to('record', { open: 'headline' });
    return null;
  }
  if (tab === 'evidence') {
    if (open === 'runs' || (!open && q.get('run'))) return to('record', { ...keep('model'), open: 'runs', ...run });
    if (open === 'identity') return to('contract', { open: 'identity' });
    if (open === 'technical') return to('record', { ...keep('model'), ...keep('report'), open: 'technical' });
    return null;
  }
  switch (tab) {
    case undefined: case 'overview': return to('brief', {});
    case 'scorecards': return to('brief', { ...(model ? { model } : {}), open: 'scorecard' });
    case 'reports': return to('report', q.get('report') ? { report: q.get('report') } : {});
    case 'comparison': return to('compare', {});
    case 'research': return to('record', { open: 'runs', ...run });
    case 'history': return to('notes', {});
    case 'identity': return to('contract', { open: 'identity' });
    default: return PROJECT_VIEWS.includes(tab) ? null : to('brief', {});
  }
}
