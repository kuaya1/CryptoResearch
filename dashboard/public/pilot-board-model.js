// The Track 2 pilot board (backlog item 54): pure words for the rows of
// GET /api/tickets/candidates (core/tickets.js candidateBoard). Nothing here
// is fetched or written; an unknown figure is said unknown, never a default.

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export const STEP_WORDS = {
  research: 'Research',
  ticket: 'Ticket',
  gate_closed: 'Gate closed',
  pm_review: 'PM review',
  done: 'Done',
  blocked: 'Blocked',
  unknown: 'Unknown',
};

export const stepWord = (step) => STEP_WORDS[step] || String(step || 'Unknown');

// "$500 ready" / "$2,000 missing" / "$500 native"; the cost in the title.
export function exitCell(e) {
  const size = isNum(e && e.size_usd) ? `$${e.size_usd.toLocaleString('en-US')}` : '—';
  if (!e) return { text: `${size} unknown`, tone: 'faint', title: '' };
  if (e.ready === null) return { text: `${size} native`, tone: 'faint', title: e.note || '' };
  if (e.ready) return { text: `${size} ready`, tone: '', title: `${e.cost_complete === false ? 'At least ' : ''}${e.cost_pct}% to exit` };
  return { text: `${size} missing`, tone: 'neg', title: e.note || 'No current exit reading' };
}

// The @5 to @6 change: the desk's own words, "—" without a comparison.
export function deltaText(delta) {
  if (!delta || delta.status !== 'ok') return { text: '—', title: delta && delta.line ? delta.line : 'No earlier eligible Claude report to compare' };
  const pv = delta.prompt_versions || {};
  const short = (v) => (typeof v === 'string' && v.includes('@') ? `@${v.split('@').pop()}` : v);
  const fig = isNum(delta.grade_delta) ? `${delta.grade_delta < 0 ? '−' : '+'}${Math.abs(Math.round(delta.grade_delta * 10) / 10).toFixed(1)}` : null;
  const span = pv.previous && pv.new ? `${short(pv.previous)} → ${short(pv.new)}` : null;
  return { text: [fig, span].filter(Boolean).join(' ') || (delta.line || '—'), title: delta.line || '' };
}
