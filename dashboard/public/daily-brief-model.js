// The Daily Brief drawer (core/brief-daily.js, cr-daily-brief@1; GET
// /api/brief/daily): the sections as the desk read them, each line with its
// #/ deep link, a section it could not read said so, and the text hash. Pure,
// for the drawer and the tests; it never fetches or writes.

const list = (v) => (Array.isArray(v) ? v : []);

// Only the desk's own in-app addresses are links; anything else is plain text.
export function safeLink(link) {
  return typeof link === 'string' && /^#\/[^\s]*$/.test(link) ? link : null;
}

// The sections that ask for Eric's attention first: a PM card waiting and an
// invalidated ticket. Everything else follows in the desk's own order.
const FIRST = ['pm_cards', 'invalidated'];

export function briefView(brief) {
  if (!brief || !Array.isArray(brief.sections)) {
    return { ok: false, sections: [], hash: null, hash_short: null, as_of: null, since: null, unreadable: 0, why: 'The daily brief could not be read.' };
  }
  // A partial section (one project's record could not be read) has no count:
  // what was read and what was not are said instead, never a number that
  // looks complete.
  const sections = brief.sections.map((s) => {
    const unreadable = s.state === 'unreadable';
    const partial = s.state === 'partial';
    const lines = list(s.lines).map((l) => ({ text: String(l.text || ''), href: safeLink(l.link), unreadable: l.unreadable === true }));
    return {
      id: s.id,
      title: String(s.title || s.id || ''),
      unreadable,
      partial,
      why: unreadable || partial ? String(s.error || 'Unknown error') : null,
      count: unreadable || partial ? null : (typeof s.count === 'number' ? s.count : 0),
      count_words: partial ? `${typeof s.count_read === 'number' ? s.count_read : '?'} read, ${typeof s.unreadable_count === 'number' ? s.unreadable_count : '?'} could not be read` : null,
      empty: !unreadable && !partial && lines.length === 1 && !lines[0].href && /^None right now\.?$/.test(lines[0].text),
      lines,
    };
  });
  const rank = (s) => { const i = FIRST.indexOf(s.id); return i < 0 ? FIRST.length : i; };
  const ordered = sections.map((s, i) => [s, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([s]) => s);
  return {
    ok: true,
    sections: ordered,
    hash: brief.text_sha256 || null,
    hash_short: brief.text_sha256 ? String(brief.text_sha256).slice(0, 12) : null,
    as_of: brief.generated_at || null,
    since: brief.since || null,
    unreadable: ordered.filter((s) => s.unreadable).length,
    partial: ordered.filter((s) => s.partial).length,
    waiting: (ordered.find((s) => s.id === 'pm_cards') || {}).count ?? null,
    invalidated: (ordered.find((s) => s.id === 'invalidated') || {}).count ?? null,
    why: null,
  };
}

// The Desk hero's readiness (Eric, 2026-10-26): three circles read from the
// same brief, each a count with its word. A section the desk could not read
// is "Unknown", one read in part "Partial", never a clear mark.
const READINESS = [
  ['research', 'research_waiting', 'Research', 'waiting', 'Nothing waiting'],
  ['forensics', 'pilot_exits', 'Forensics', 'missing an exit', 'Exits read'],
  ['tickets', 'pm_cards', 'Tickets', 'wait for you', 'None waiting'],
];
export function readiness(view) {
  return READINESS.map(([key, id, title, some, none]) => {
    const s = view && view.ok ? view.sections.find((x) => x.id === id) : null;
    if (!s) return { key, title, state: 'unknown', n: null, words: 'Unknown' };
    if (s.unreadable) return { key, title, state: 'unknown', n: null, words: 'Unknown', why: s.why };
    if (s.partial) return { key, title, state: 'partial', n: null, words: 'Partial', why: s.count_words };
    const n = s.empty ? 0 : (typeof s.count === 'number' && s.count > 0 ? s.count : s.lines.filter((l) => l.href).length);
    return { key, title, state: n ? 'some' : 'clear', n, words: n ? `${n} ${some}` : none };
  });
}
