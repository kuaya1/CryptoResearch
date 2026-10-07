// The project page's Compare view (#/project/<project>/compare[?a=<report>&
// b=<report>&order=profile]): two saved reports on the project, side by side,
// read from the project record the page already holds (compare-desk.js), with
// the Second opinion's own rules (compare-model.js). By default the desk's
// latest eligible Claude and ChatGPT reports; a model without one says why,
// and nothing is put in its place. Each report keeps its own grade: no
// consensus, no midpoint, no winner. The most meaningful comparable category
// differences come first, each with the basis each report stores for its own
// grade (reason, cited evidence with dates and sources, weakness), and where
// those records do not explain a difference the view says so. The research
// scope, dates and scoring versions that differ are said in words. Opening it,
// choosing reports and opening a basis are reads: nothing is written, fetched
// or asked of a model, and the Explorer's demo records are never read here.
import { h, details, fmtDate, fmtNum, scoreTier, verdictChip, icon, announce, PROVIDER_LABELS, COVERAGE_MEANS, TAG_TITLES } from '../ui.js';
import { MODEL_LABELS, NOTABLE_GAP, valueOf, valueText } from '../compare-model.js';
import { deskRecords, latestRecord, missingSide, basisOf, compareView, deskChoices, FIGURE_WORDS } from '../compare-desk.js';
import { TAG_WORDS } from '../brief-model.js';

const enc = encodeURIComponent;
const clampPct = (v) => Math.max(0, Math.min(100, Number(v)));
const CONFIDENCE = { high: 'high confidence', medium: 'medium confidence', low: 'low confidence' };
const REVISION_WORDS = { format_fix: 'format fix', reassessment: 'reassessment', new_evidence: 'new evidence', other: 'other reason', not_stated: 'reason not stated' };
const plainClick = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

// ---- small pieces ---------------------------------------------------------------

function bar(s) {
  const x = valueOf(s);
  if (x.kind === 'point') return h('span', { class: 'cbar' }, h('span', { class: `fill tier-${scoreTier(x.v)}`, style: { width: `${clampPct(x.v)}%` } }));
  if (x.kind === 'range') return h('span', { class: 'cbar' }, h('span', { class: `range tier-${scoreTier(x.lo)}`, style: { left: `${clampPct(x.lo)}%`, width: `${Math.max(2, clampPct(x.hi) - clampPct(x.lo))}%` } }));
  if (x.kind === 'na') return h('span', { class: 'cbar cmp-na' });
  return h('span', { class: 'cbar unknown' });
}

const gradeWords = (r) => (r.grade_status === 'firm' || r.grade_status === 'range' ? r.grade_display || '—'
  : r.grade_status === 'withheld' ? 'Withheld' : 'No grade');

function whereWords(r, all, d) {
  const parts = [];
  if (latestRecord(d, [r], r.model)) parts.push(`${MODEL_LABELS[r.model]}'s latest`);
  else parts.push('An earlier report');
  if (r.revision_of) parts.push(`revision · ${REVISION_WORDS[r.revision_kind] || 'reason not stated'}`);
  if (all.some((x) => x.revision_of === r.report_id)) parts.push('revised later');
  return parts.join(' · ');
}

// One report at the top: its name on this screen, the desk's grade (a figure,
// a range, or withheld with the share of the weight scored), its verdict, its
// research date, where it sits, and its evidence flags in words.
function sideCard(r, who, all, d) {
  const tier = r.grade_status === 'firm' ? scoreTier(r.grade_value) : r.grade_status === 'range' ? scoreTier(r.grade_low) : null;
  const flags = r.evidence_high ? `${r.evidence_high} serious evidence flag${r.evidence_high === 1 ? '' : 's'}` : r.evidence_medium ? `${r.evidence_medium} evidence flag${r.evidence_medium === 1 ? '' : 's'}` : null;
  return h('div', { class: 'cmp-side' },
    h('p', { class: 'cmp-who' }, who),
    h('div', { class: 'cmp-grade-row' },
      h('span', { class: `cmp-grade g-${r.grade_status}${tier ? ` tier-${tier}` : ''}`, title: r.grade_status === 'withheld' ? COVERAGE_MEANS : 'Calculated by the desk from this report\'s six weighted components; never the model\'s own total.' },
        gradeWords(r)),
      h('span', { class: 'cmp-grade-k' }, r.grade_status === 'withheld' && typeof r.grade_coverage_pct === 'number' ? `${r.grade_coverage_pct}% of the weight scored` : 'Investment grade')),
    h('p', { class: 'cmp-verdict' }, verdictChip(r.verdict)),
    h('p', { class: 'cmp-meta' }, `Analysis ${r.research_date ? fmtDate(r.research_date) : r.analysis_at || 'date not stated'}`, h('span', { class: 'bf-dot', 'aria-hidden': 'true' }, '·'), whereWords(r, all, d)),
    flags ? h('p', { class: `cmp-flag ${r.evidence_high ? 'serious' : 'material'}` }, icon(r.evidence_high ? 'warn-fill' : 'warn-line'), h('span', null, flags)) : null);
}

function emptyCard(miss, title = null) {
  return h('div', { class: 'cmp-side is-empty' },
    h('p', { class: 'cmp-who' }, title || miss.who),
    h('p', { class: 'cmp-none' }, miss.text));
}

// ---- the pickers ------------------------------------------------------------------

function optionLabel(c, d) {
  const r = c.report;
  const where = [latestRecord(d, [r], r.model) ? 'latest' : null, r.revision_of ? 'revision' : null, c.revisedBy.length ? 'revised later' : null].filter(Boolean).join(', ');
  return `${MODEL_LABELS[r.model]} · ${r.research_date ? fmtDate(r.research_date) : `saved ${fmtDate(r.saved_at)}`} · ${gradeWords(r)}${where ? ` · ${where}` : ''}`;
}

function picker(label, key, choices, selected, d, onPick) {
  const sel = h('select', { 'aria-label': label, dataset: { key } },
    h('option', { value: 'none', selected: !selected || null }, '— No report —'),
    ['claude', 'chatgpt', 'gemini'].filter((m) => choices.some((c) => c.model === m)).map((m) => h('optgroup', { label: MODEL_LABELS[m] },
      choices.filter((c) => c.model === m).map((c) => h('option', { value: c.report.report_id, selected: selected === c.report || null }, optionLabel(c, d))))));
  sel.addEventListener('change', () => onPick(sel.value));
  return h('label', { class: 'cmp-pick' }, h('span', { class: 'lbl' }, label), sel);
}

// ---- the status: scope, authorship, versions -------------------------------------------

function statusBlock(v) {
  const s = v.cmp.scope;
  const a = v.cmp.authorship;
  const ver = v.cmp.versions;
  const warn = !s.confirmed || !a.independent || !ver.compatible;
  const lines = [];
  if (!s.confirmed) lines.push(s.text);
  if (!a.independent) lines.push(`${a.label}: not an independent second opinion.`);
  if (!ver.compatible) lines.push(`${ver.label}: the category numbers are shown side by side and not compared.`);
  if (s.confirmed) lines.push(s.caveat);
  return h('div', { class: `cmp-status ${warn ? 'warn' : 'ok'}`, role: 'note' },
    h('p', { class: 'head' }, warn ? icon('warn-line') : null, h('strong', null, s.label), h('span', { class: 'bf-dot', 'aria-hidden': 'true' }, '·'), h('strong', null, a.label)),
    lines.map((t) => h('p', null, t)));
}

const factText = (v) => String(v).replace(/(\d{4}-\d{2}-\d{2})/g, (x) => fmtDate(x));

// The facts of the research scope that differ or are missing, in words, the
// research date apart; all of them stay in the details.
function scopeFacts(v) {
  const [na, nb] = v.names;
  const row = (f) => h('div', { class: f.differs ? 'differs' : f.missing ? 'missing' : null },
    h('dt', null, f.what),
    h('dd', null, f.a === f.b ? `${factText(f.a)}${f.missing ? ' by either' : ' · same'}` : [h('span', null, `${na}: ${factText(f.a)}`), h('span', { class: 'bf-dot', 'aria-hidden': 'true' }, '·'), h('span', null, `${nb}: ${factText(f.b)}`)]));
  const shown = v.scope_differences;
  return h('div', { class: 'cmp-scope' },
    shown.length ? h('dl', { class: 'cmp-facts' }, shown.map(row)) : null,
    details('Research scope, dates and versions', h('div', null,
      h('dl', { class: 'cmp-facts all' }, v.cmp.scope.facts.map(row)),
      h('p', { class: 'cmp-ver' }, h('strong', null, v.cmp.versions.label), `: ${v.cmp.versions.text}`),
      h('p', { class: 'cmp-ver' }, h('strong', null, v.cmp.authorship.label), `: ${v.cmp.authorship.text}`)), { id: 'cmp-scope-all' }));
}

// ---- the basis of a difference ----------------------------------------------------------

function citedItem(c) {
  const s = c.sources[0] || null;
  return h('li', null,
    h('span', { class: 'bf-ids' }, c.id),
    c.tag ? h('span', { class: `bf-tag t-${c.tag.toLowerCase()}`, title: TAG_TITLES[c.tag] }, TAG_WORDS[c.tag]) : null,
    c.as_of ? h('span', { class: 'bf-when' }, `as of ${fmtDate(c.as_of)}`) : null,
    c.text ? h('span', { class: 'cmp-ctext' }, c.text) : null,
    s ? h('span', { class: 'cmp-csrc' }, s.url ? h('a', { href: s.url, title: [s.publisher, s.accessed_at ? `accessed ${fmtDate(s.accessed_at)}` : null].filter(Boolean).join(' · ') || null }, s.title || s.url) : h('span', null, s.title || s.source_id),
      c.sources.length > 1 ? h('span', { class: 'faint' }, ` +${c.sources.length - 1}`) : null) : h('span', { class: 'bf-tag none' }, 'No source'));
}

function sideWords(b) {
  if (!b) return null;
  const line = (k, v, cls = null) => (v ? [h('dt', null, k), h('dd', { class: cls }, v)] : []);
  if (!b.graded) return h('div', { class: 'cmp-words' }, h('h4', null, b.who), h('p', { class: 'cmp-none' }, `${b.who}'s report gives no grade for this category.`));
  return h('div', { class: 'cmp-words' },
    h('h4', null, b.who, h('span', { class: 'cmp-wv' }, `${b.value}${b.confidence ? ` · ${CONFIDENCE[b.confidence]}` : ''}`)),
    h('dl', null,
      ...line(b.kind === 'unknown' ? 'Why unknown' : b.kind === 'na' ? 'Why not applicable' : 'Reason', b.reason || b.unknown_reason || h('span', { class: 'cmp-none' }, 'No reason given')),
      ...line('Strongest evidence', b.strongest_evidence),
      h('dt', null, 'Cites'), h('dd', null, b.cited.length ? h('ul', { class: 'cmp-cited' }, b.cited.map(citedItem)) : h('span', { class: 'cmp-none' }, 'No evidence cited'),
        b.dangling.length ? h('span', { class: 'bf-dangling' }, ` ${b.dangling.join(', ')} not listed in the report`) : null),
      ...line('Main weakness', b.main_weakness),
      ...line('Would raise it', b.would_raise),
      ...line('Would lower it', b.would_lower)),
    b.flags.map((f) => h('p', { class: `bf-flagline ${f.severity === 'high' ? 'serious' : 'material'}` }, h('strong', null, `Desk evidence check (${f.severity === 'high' ? 'serious' : f.severity === 'medium' ? 'material' : 'note'}): `), f.message)));
}

function figureLine(c, names) {
  const v = (x) => `${fmtNum(x.value)}${x.unit ? ` ${x.unit}` : ''}${x.period ? `, ${x.period}` : ''}${x.as_of ? `, as of ${fmtDate(x.as_of)}` : ''}`;
  return h('li', null, h('strong', null, c.metric.replace(/_/g, ' ')), `: ${names[0]} ${v(c.a)}; ${names[1]} ${v(c.b)}. `, h('span', { class: 'cmp-fig-k' }, `${FIGURE_WORDS[c.kind] || c.kind.replace(/_/g, ' ')}${c.kind === 'context_unstated' && c.missing ? ` (${c.missing})` : ''}.`));
}

function basisBlock(basis, names) {
  return h('div', { class: 'cmp-basis' },
    basis.unexplained.length ? h('p', { class: 'cmp-unexplained' }, icon('question'), h('span', null, `The stored records cannot explain this difference: ${basis.unexplained.join(' and ')} ${basis.unexplained.length === 1 ? 'gives' : 'give'} no reason and ${basis.unexplained.length === 1 ? 'cites' : 'cite'} no evidence for ${basis.unexplained.length === 1 ? 'its' : 'their'} grade.`)) : null,
    h('div', { class: 'cmp-words-pair' }, basis.sides.map(sideWords)),
    basis.shared.length ? h('p', { class: 'cmp-shared' }, h('strong', null, 'Cited by both: '), basis.shared.map((s, i) => [i ? ', ' : '', h('a', { href: s.url }, s.title)]), '. A shared source is not independent confirmation.') : null,
    basis.conflicts.length ? h('div', { class: 'cmp-figs' }, h('p', { class: 'cmp-figs-h' }, 'Figures the two cite'), h('ul', null, basis.conflicts.map((c) => figureLine(c, names)))) : null);
}

// ---- one category -------------------------------------------------------------------------

function modelLine(who, s) {
  return h('div', { class: 'cmp-line' },
    h('span', { class: 'model' }, who),
    h('span', { class: 'cmp-bar', 'aria-hidden': 'true' }, bar(s)),
    h('span', { class: `cmp-val${s && (s.status === 'scored' || s.status === 'range') ? '' : ' none'}` }, s ? valueText(s) : 'Not graded'),
    h('span', { class: 'cmp-conf' }, s && s.confidence ? s.confidence.charAt(0).toUpperCase() : ''));
}

function categoryRow(v, row, d, open) {
  const [na, nb] = v.names;
  const said = `${row.label}: ${na} ${row.a ? valueText(row.a) : 'not graded'}${row.a && row.a.confidence ? ` (${CONFIDENCE[row.a.confidence]})` : ''}${nb ? `; ${nb} ${row.b ? valueText(row.b) : 'not graded'}${row.b && row.b.confidence ? ` (${CONFIDENCE[row.b.confidence]})` : ''}. ${row.result ? row.result.label : ''}` : ''}`;
  const basis = v.second ? basisOf(row, v.first, v.second, v.names, d) : null;
  const words = v.second ? 'Basis of the difference' : 'The report\'s words';
  const body = v.second ? basisBlock(basis, v.names) : h('div', { class: 'cmp-basis' }, h('div', { class: 'cmp-words-pair one' }, basisOf({ a: row.a, b: null }, v.first, null, [na, null], d).sides.filter(Boolean).map(sideWords)));
  const det = h('details', { class: 'cmp-more', open: open || null, dataset: { key: `cmp-basis-${row.category_id}` } },
    h('summary', { 'aria-label': `${words}: ${row.label}` }, words, basis && basis.unexplained.length ? h('span', { class: 'cmp-q', title: 'The stored records cannot explain it' }, ' · not explained by the records') : null),
    body);
  return h('li', { class: `cmp-row g-${row.result ? row.result.group : 'one'}`, 'aria-label': said },
    h('div', { class: 'cmp-name' }, h('span', null, row.label), row.other_label ? h('span', { class: 'alt' }, `${nb}: ${row.other_label}`) : null,
      row.result ? h('span', { class: `cmp-label k-${row.result.kind}`, title: row.result.detail }, row.result.label) : null),
    h('div', { class: 'cmp-pair' }, modelLine(na, row.a), nb ? modelLine(nb, row.b) : null),
    det);
}

const GROUPS = [
  ['notable', 'Where they differ', `comparable differences of ${NOTABLE_GAP} points or more, largest first`],
  ['missing', 'Evidence missing', 'one or both could not grade it'],
  ['close', 'Close or the same', 'a smaller difference, or none; matching numbers do not mean the facts agree'],
  ['other', 'Not compared', 'not applicable, or not scored on the same scale'],
];

function categoriesBlock(v, d, st, setOrder) {
  const order = st.order;
  const seg = v.second ? h('div', { class: 'seg', role: 'group', 'aria-label': 'Order of the categories' },
    [['inspection', 'Differences first'], ['profile', 'Profile order']].map(([val, t]) => {
      const b = h('button', { type: 'button', 'aria-pressed': String(order === val), dataset: { key: `cmp-order-${val}` } }, t);
      b.addEventListener('click', () => setOrder(val));
      return b;
    })) : null;
  const head = h('div', { class: 'cmp-listhead' },
    h('h2', { class: 'bf-h', id: 'cmp-h-cats' }, 'Category grades', h('span', { class: 'bf-h-sub' }, v.second ? `${v.rows.length} categories · diagnostics, never averaged into either grade` : `${v.rows.length} categories`)),
    seg);
  if (!v.second || order === 'profile') {
    const rows = [...v.rows].sort((x, y) => x.position - y.position);
    return h('section', { class: 'bf-sec cmp-cats', 'aria-labelledby': 'cmp-h-cats' }, head, h('ol', { class: 'cmp-rows' }, rows.map((r) => categoryRow(v, r, d, false))));
  }
  // The first comparable difference opens with its basis, the first time, on
  // a wide screen (on a phone the list comes first).
  const wide = typeof matchMedia !== 'function' || matchMedia('(min-width: 761px)').matches;
  const firstNotable = st.open === null && wide ? v.rows.find((r) => r.result && r.result.group === 'notable') : null;
  return h('section', { class: 'bf-sec cmp-cats', 'aria-labelledby': 'cmp-h-cats' }, head,
    GROUPS.map(([g, title, sub]) => {
      const rows = v.rows.filter((r) => r.result && r.result.group === g);
      if (!rows.length) return null;
      return h('div', { class: `cmp-group g-${g}` },
        h('h3', { class: 'bf-h3' }, `${title} (${rows.length})`, h('span', { class: 'bf-h3-sub' }, sub)),
        h('ol', { class: 'cmp-rows' }, rows.map((r) => categoryRow(v, r, d, r === firstNotable))));
    }));
}

// ---- the grade inputs and downside risk -------------------------------------------------------

function rubricBlock(v, rows, { id, title, sub, risk = false, weights = null }) {
  const [na, nb] = v.names;
  return h('section', { class: `bf-sec cmp-rubric${risk ? ' risk' : ''}`, 'aria-labelledby': `cmp-h-${id}` },
    h('h2', { class: 'bf-h', id: `cmp-h-${id}` }, title, h('span', { class: 'bf-h-sub' }, sub)),
    h('table', { class: 'cmp-table' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, risk ? 'Risk' : 'Component'), h('th', { scope: 'col', class: 'n' }, na), h('th', { scope: 'col', class: 'n' }, nb), h('th', { scope: 'col' }, 'Comparison'))),
      h('tbody', null, rows.map((r) => h('tr', { class: r.result.group === 'notable' ? 'notable' : null },
        h('th', { scope: 'row' }, r.label, weights && weights[r.id] !== undefined ? h('span', { class: 'bf-w' }, ` ${weights[r.id]}%`) : null),
        h('td', { class: 'n', title: r.a ? r.a.rationale || r.a.unknown_reason || null : null }, r.a ? valueText(r.a) : '—'),
        h('td', { class: 'n', title: r.b ? r.b.rationale || r.b.unknown_reason || null : null }, r.b ? valueText(r.b) : '—'),
        h('td', { class: 'cmp-res', title: r.result.detail }, r.result.label))))));
}

// ---- the panel --------------------------------------------------------------------------------

// The pair and the order chosen on each project's Compare view, kept while
// the page is open (a live update or a return redraws the same choice). An
// address may seed it (?a=<report>&b=<report>, "none" for an empty side).
const STATE = new Map();

function stateFor(pid, query) {
  const seed = ['a', 'b', 'order'].map((k) => `${k}=${query.get(k) || ''}`).join('&');
  let st = STATE.get(pid);
  if (!st || (st.seed !== seed && (query.has('a') || query.has('b') || query.has('order')))) {
    st = { seed, a: query.get('a'), b: query.get('b'), order: query.get('order') === 'profile' ? 'profile' : 'inspection', picked: query.has('a') || query.has('b'), open: null };
    STATE.set(pid, st);
  }
  return st;
}

function build(ctx, { d, row, pid }, st, draw) {
  const idx = ctx.state.index;
  const hosted = Boolean(ctx.state.session && ctx.state.session.hosted);
  const { records, set_aside } = deskRecords(d, { profiles: idx.rubrics.profiles, grading: idx.rubrics.grading });
  // A side not chosen is the desk's own latest eligible report of its model.
  const pick = (val, model) => (val === 'none' ? null : val ? records.find((r) => r.report_id === val) || null : latestRecord(d, records, model));
  const a = pick(st.a, 'claude');
  const b = pick(st.b, 'chatgpt');
  const choices = deskChoices(records);
  const v = compareView(d, { a, b, records, set_aside, row, index: idx, hosted, picked: st.picked });
  const weights = Object.fromEntries((idx.rubrics.grading.investment_components || []).map((x) => [x.id, x.weight_bp / 100]));
  const setPair = (key) => (id) => {
    st[key] = id;
    st.picked = true;
    st.open = null;
    draw(`cmp-${key}`);
    const x = pick(st.a, 'claude');
    const y = pick(st.b, 'chatgpt');
    announce(x && y && x !== y ? `Comparing ${compareView(d, { a: x, b: y, records }).names.join(' and ')}` : 'One report shown');
  };
  const out = [];
  out.push(h('header', { class: 'bf-head' }, h('div', { class: 'bf-id' },
    h('h2', { id: 'bf-title', class: 'bf-eyebrow', tabindex: '-1' }, 'Compare the models', h('span', { class: 'sr-only' }, `: ${d.project.name}`)),
    h('p', { class: 'bf-id-r' }, 'Saved reports · each grade its own'))));
  out.push(h('div', { class: 'cmp-pickers' },
    picker('First report', 'cmp-a', choices, a, d, setPair('a')),
    picker('Second report', 'cmp-b', choices, b, d, setPair('b'))));
  // Each side: the report, or why there is none (only the opening pair names
  // the missing model; after a choice, a side asks for a report).
  const sideFor = (rec, model, name) => {
    if (rec) return sideCard(rec, name || MODEL_LABELS[rec.model], records, d);
    if (!st.picked) return emptyCard(missingSide(d, { row, index: idx, model, hosted }));
    return emptyCard({ who: 'No report chosen', text: 'Choose a report to compare.' });
  };
  const names = v.names || [];
  out.push(h('div', { class: 'cmp-sides' }, sideFor(a, 'claude', a && b ? names[0] : null), sideFor(b, 'chatgpt', a && b ? names[1] : null)));
  if (v.empty) {
    out.push(h('p', { class: 'cmp-none pad' }, records.length ? 'Choose a report to read.' : 'No saved report on this project can be compared yet.'));
  } else if (v.same) {
    out.push(h('p', { class: 'cmp-none pad' }, 'The same report is chosen twice. Choose a second, different report.'));
  } else {
    if (v.cmp) out.push(h('section', { class: 'bf-sec cmp-state', 'aria-label': 'Whether the two reports can be compared' }, statusBlock(v), scopeFacts(v)));
    out.push(categoriesBlock(v, d, st, (val) => { st.order = val; draw(`cmp-order-${val}`); }));
    if (v.cmp) {
      out.push(rubricBlock(v, v.components, { id: 'inputs', title: 'What each grade is calculated from', sub: 'six weighted components · each report\'s own grade, never combined', weights }));
      out.push(rubricBlock(v, v.risks, { id: 'risks', title: 'Downside risk', sub: 'higher is worse · never folded into a grade', risk: true }));
      if (!v.figures_checked) out.push(h('p', { class: 'cmp-note' }, 'Figures are checked against each other for each model\'s latest report only.'));
    }
  }
  // Reports the comparison cannot read, in words.
  const aside = set_aside.filter((x) => ['claude', 'chatgpt', 'gemini'].includes(x.model));
  if (aside.length) {
    const why = (x) => (x.why.kind === 'quarantined' ? 'quarantined: it does not match its research run' : x.why.kind === 'pdf' ? 'a PDF without a text copy' : x.why.kind === 'broken' ? 'could not be read' : `excluded${x.why.reason ? `: ${x.why.reason}` : ''}`);
    out.push(h('section', { class: 'bf-sec cmp-aside', 'aria-labelledby': 'cmp-h-aside' },
      h('h2', { class: 'bf-h', id: 'cmp-h-aside' }, 'Not compared', h('span', { class: 'bf-h-sub' }, `${aside.length} saved report${aside.length === 1 ? '' : 's'}`)),
      h('ul', { class: 'bf-limits' }, aside.map((x) => h('li', null, h('strong', null, `${PROVIDER_LABELS[x.model]}, saved ${fmtDate(x.saved_at)}: `), why(x), '. ',
        viewLink(ctx, pid, `#/project/${enc(pid)}/report?report=${enc(x.report_id)}`, 'The report', `cmp-aside-${x.report_id}`))))));
  }
  return out;
}

// The Compare view for one project: pickers, both reports, the status of the
// comparison, the categories with their basis, then the grade inputs and the
// downside-risk scores side by side, and the reports that cannot be compared.
// Choosing a report or the order redraws it in place (no new entry, the page
// keeps its place); open bases stay open.
export function comparePanel(ctx, { d, row, pid, query }) {
  const st = stateFor(pid, query);
  const article = h('article', { class: 'brief card bf-cmpview', id: 'brief-sheet', 'aria-labelledby': 'bf-title' });
  const draw = (focusKey = null) => {
    // Redrawn in place, the bases open now stay open (a new page is the
    // app's to restore).
    const open = article.childNodes.length && st.open !== null ? new Set([...article.querySelectorAll('details[open][data-key]')].map((x) => x.dataset.key)) : null;
    article.replaceChildren(...build(ctx, { d, row, pid }, st, draw).flat());
    if (open) for (const det of article.querySelectorAll('details[data-key]')) det.open = open.has(det.dataset.key);
    st.open = true;
    if (focusKey) {
      const el = article.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
      if (el) el.focus();
    }
  };
  draw();
  return article;
}

// A link to another view of the project page that keeps the way back to the
// inspector (as views/brief.js does).
function viewLink(ctx, pid, href, text, key) {
  const a = h('a', { href, dataset: { key } }, text);
  a.addEventListener('click', (e) => {
    const st = history.state;
    if (!plainClick(e) || !st || st.crBrief !== pid) return;
    e.preventDefault();
    ctx.navigate(href, { state: { ...st, crDepth: (Number(st.crDepth) || 1) + 1 } });
  });
  return a;
}
