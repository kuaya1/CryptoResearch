// The project page's addresses (#/project/<id>/<tab>) and where the former
// ones lead (Eric, 2026-10-05, D1; the brief's three views, 2026-10-07).
// Pure, for the app shell and the tests; views/project.js re-exports it.

// The brief's three views first (Overview keeps the address "brief", so every
// link to the Brief lands on it), then the report, the market and your notes.
export const PROJECT_TABS = [
  ['brief', 'Overview'],
  ['compare', 'Compare'],
  ['evidence', 'Evidence'],
  ['report', 'Full report'],
  ['market', 'Market'],
  ['notes', 'Notes'],
];

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
