// Second opinion (Explorer → Compare opinions): two saved reports on one
// project, side by side, category by category. It reads one project's
// records through the desk's own server (GET /api/explorer/compare) and
// compares them in the page (compare-model.js). Opening it, choosing
// reports and expanding rows are reads: nothing is written, no research is
// started and no model is asked anything.
// Order on screen: who and what (models, dates, versions, grades), whether
// the two answered the same request and, apart, who wrote them (two models,
// or one model's original and revision), then the categories, then each
// model's own words on demand. Gemini's saved reports can be chosen; it is
// never the default.
import { h, clear, logo, scoreTier, fmtDate, fmtDateTime, openDialog, announce, verdictChip } from '../ui.js';
import { MODEL_LABELS, compareReports, defaultPair, namesFor, reportChoices, valueOf, valueText, NOTABLE_GAP } from '../compare-model.js';

const NOT_STORED = 'Not stored in the Explorer';

const REVISION_WORDS = { format_fix: 'format fix', reassessment: 'reassessment', new_evidence: 'new evidence', other: 'other reason', not_stated: 'reason not stated' };
const CONFIDENCE = { high: 'high confidence', medium: 'medium confidence', low: 'low confidence' };
const NOT_IN_EXPLORER = 'Not available in Explorer';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clampPct = (v) => Math.max(0, Math.min(100, Number(v)));
const trunc1 = (v) => (Math.floor(v * 10 + 1e-9) / 10).toFixed(1);
const name = (r) => (r ? MODEL_LABELS[r.model] || r.model : '');

function gradeText(r) {
  if (r.grade_status === 'firm' && isNum(r.grade_value)) return `Grade ${trunc1(r.grade_value)}`;
  if (r.grade_status === 'range' && isNum(r.grade_low) && isNum(r.grade_high)) return `Grade ${trunc1(r.grade_low)}–${trunc1(r.grade_high)}`;
  if (r.grade_status === 'withheld') return isNum(r.grade_coverage_pct) ? `Grade withheld · ${r.grade_coverage_pct}% coverage` : 'Grade withheld';
  return 'No grade';
}

const dayText = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s)) ? fmtDate(s) : s);
const factText = (v) => String(v).replace(/(\d{4}-\d{2}-\d{2})/g, (d) => fmtDate(d));

function bar(s) {
  const x = valueOf(s);
  if (x.kind === 'point') return h('span', { class: 'cbar' }, h('span', { class: `fill tier-${scoreTier(x.v)}`, style: { width: `${clampPct(x.v)}%` } }));
  if (x.kind === 'range') return h('span', { class: 'cbar' }, h('span', { class: `range tier-${scoreTier(x.lo)}`, style: { left: `${clampPct(x.lo)}%`, width: `${Math.max(2, clampPct(x.hi) - clampPct(x.lo))}%` } }));
  if (x.kind === 'na') return h('span', { class: 'cbar xp-na' });
  return h('span', { class: 'cbar unknown' });
}

function valueCell(s) {
  const x = valueOf(s);
  const tier = scoreTier(x.kind === 'point' ? x.v : x.kind === 'range' ? x.lo : null);
  return h('span', { class: `xp-val${tier ? ` tier-${tier}` : ' none'}` }, valueText(s));
}

function whereLabel(choice) {
  if (!choice) return null;
  const parts = [];
  if (choice.latest) parts.push('latest');
  if (choice.revision) parts.push(`revision · ${REVISION_WORDS[choice.revision.kind] || 'reason not stated'}`);
  if (choice.revisedBy.length) parts.push('revised later');
  return parts.join(' · ');
}

function optionLabel(c) {
  const r = c.report;
  return `${name(r)} · ${r.research_date ? fmtDate(r.research_date) : `saved ${fmtDate(r.saved_at)}`} · ${r.profile_version || 'profile not stated'}${whereLabel(c) ? ` · ${whereLabel(c)}` : ''}`;
}

function picker(label, key, choices, selected, onPick) {
  const sel = h('select', { 'aria-label': label, dataset: { key } },
    h('option', { value: '', selected: !selected || null }, '— No report —'),
    ['claude', 'chatgpt', 'gemini'].filter((m) => choices.some((c) => c.model === m)).map((m) => h('optgroup', { label: MODEL_LABELS[m] },
      choices.filter((c) => c.model === m).map((c) => h('option', { value: c.report.report_id, selected: selected === c.report || null }, optionLabel(c))))));
  sel.addEventListener('change', () => onPick(sel.value || null));
  return h('label', { class: 'xp-cmp-pick' }, h('span', { class: 'lbl' }, label), sel);
}

// One report's identity card in the summary. `who` is its name on this
// screen: the model, or "Claude (first)" when both reports are Claude's.
function side(r, choice, empty = null, who = name(r)) {
  if (!r) {
    return h('div', { class: 'xp-cmp-side empty' },
      h('div', { class: 'who' }, h('span', { class: 'model' }, empty.title)),
      h('p', { class: 'none' }, empty.text));
  }
  const where = whereLabel(choice);
  return h('div', { class: 'xp-cmp-side' },
    h('div', { class: 'who' }, h('span', { class: 'model' }, who), where ? h('span', { class: 'where' }, where) : null),
    h('dl', { class: 'xp-kv' },
      h('dt', null, 'Analyzed'), h('dd', null, r.research_date ? fmtDate(r.research_date) : 'Not stated'),
      h('dt', null, 'Saved'), h('dd', null, fmtDateTime(r.saved_at)),
      h('dt', null, 'Scoring'), h('dd', null, `${r.profile_version || 'Not stated'} · ${r.rubric_version || 'Not stated'}`),
      h('dt', null, 'Prompt'), h('dd', null, r.prompt_version || 'Not stated'),
      h('dt', null, 'Horizon'), h('dd', null, r.horizon_start && r.horizon_end ? `${fmtDate(r.horizon_start)} to ${fmtDate(r.horizon_end)}` : r.horizon_text || 'Not stated'),
      r.revision_of ? [h('dt', null, 'Revises'), h('dd', { class: 'id' }, r.revision_of)] : null),
    h('div', { class: 'grade-line' },
      h('span', { class: `xp-grade g-${r.grade_status}`, title: r.grade_reason || 'Calculated by the desk from the six weighted components; never the model\'s own total.' }, gradeText(r)),
      verdictChip(r.verdict)),
    r.grade_status === 'withheld' && r.grade_unscored.length ? h('p', { class: 'unscored' }, `Not scored: ${r.grade_unscored.join(', ')}`) : null);
}

// One stored fact of the research scope, for both reports: the same, two
// values that differ, a value one or both do not state, or not stored here.
function factCell(f, [na, nb]) {
  if (f.differs) return h('dd', { class: 'differs' }, h('span', null, factText(f.a)), h('span', { class: 'vs', 'aria-hidden': 'true' }, ' ≠ '), h('span', null, factText(f.b)), h('span', { class: 'sr-only' }, ' (differs)'));
  if (f.missing) {
    return h('dd', { class: 'missing' }, f.a === f.b ? `${f.a} by either` : [h('span', null, `${na}: ${factText(f.a)}`), h('span', { class: 'sep', 'aria-hidden': 'true' }, ' · '), h('span', null, `${nb}: ${factText(f.b)}`)], h('span', { class: 'sr-only' }, ' (missing)'));
  }
  if (f.a === NOT_STORED && f.b === NOT_STORED) return h('dd', { class: 'none' }, `${NOT_STORED} · not compared`);
  return h('dd', null, h('span', null, factText(f.a)), h('span', { class: 'same' }, ' · same'));
}

// Two separate facts: whether both answered the same frozen request (the
// scope, with the scoring versions), and who wrote them (the authorship).
function scopeBlock(cmp) {
  const s = cmp.scope;
  const a = cmp.authorship;
  return h('div', { class: 'xp-cmp-facts-pair' },
    h('div', { class: `xp-cmp-scope ${s.confirmed ? 'ok' : 'warn'}` },
      h('p', { class: 'head' }, h('strong', null, s.label), ' ', s.text),
      h('dl', { class: 'xp-cmp-facts' }, s.facts.flatMap((f) => [h('dt', { class: f.apart ? 'apart' : null }, f.what), factCell(f, cmp.names)])),
      h('p', { class: `versions ${cmp.versions.compatible ? 'ok' : 'warn'}` }, h('strong', null, cmp.versions.label), ': ', cmp.versions.text),
      s.confirmed ? h('p', { class: 'caveat' }, s.caveat) : null),
    h('div', { class: `xp-cmp-author ${a.independent ? 'ok' : 'warn'}` },
      h('p', null, h('strong', null, a.label), ' ', a.text)));
}

function countsLine(cmp) {
  const c = cmp.counts;
  const parts = [
    c.notable ? `${c.notable} difference${c.notable === 1 ? '' : 's'} of ${NOTABLE_GAP}+ points` : null,
    c.missing ? `${c.missing} with evidence missing` : null,
    c.close ? `${c.close} close or matching` : null,
    c.other ? `${c.other} N/A or not compared` : null,
  ].filter(Boolean);
  return h('p', { class: 'xp-cmp-counts' }, `${c.categories} categories${parts.length ? ` · ${parts.join(' · ')}` : ''}`);
}

// The model's own words for one category, as exported; what was not
// exported says so, what the report did not give says that.
function wordsBlock(who, s) {
  if (!s) return h('div', { class: 'xp-cmp-words' }, h('h4', null, who), h('p', { class: 'none' }, `${who}'s report gives no grade for this category.`));
  const line = (k, v, { missing = 'Not given in this report', id = false } = {}) => [h('dt', null, k), h('dd', { class: v ? (id ? 'id' : null) : 'none' }, v || missing)];
  const x = valueOf(s);
  return h('div', { class: 'xp-cmp-words' },
    h('h4', null, `${who}, as written`),
    h('dl', { class: 'xp-kv' },
      line('Grade', `${valueText(s)}${s.confidence ? ` · ${CONFIDENCE[s.confidence]}` : ''}`),
      line(x.kind === 'na' ? 'Why not applicable' : 'Reason', s.rationale),
      x.kind === 'unknown' ? line('Why unknown', s.unknown_reason) : null,
      line('Evidence references', s.evidence_refs.length ? s.evidence_refs.join(', ') : null, { missing: 'None listed', id: true }),
      line('Main weakness', s.main_weakness),
      line('What would change it', null, { missing: NOT_IN_EXPLORER })),
    s.evidence_flags.length ? h('div', { class: 'xp-cmp-flags' }, s.evidence_flags.map((f) => h('p', null, h('strong', null, `Desk evidence check (${f.severity === 'high' ? 'serious' : f.severity === 'medium' ? 'material' : 'note'}): `), f.message))) : null);
}

function modelLine(who, s) {
  return h('div', { class: 'xp-cmp-line' },
    h('span', { class: 'model' }, who),
    h('span', { class: 'xp-bar', 'aria-hidden': 'true' }, bar(s)),
    s ? valueCell(s) : h('span', { class: 'xp-val none' }, 'Not graded'),
    h('span', { class: 'conf' }, s && s.confidence ? CONFIDENCE[s.confidence] : ''));
}

function categoryRow(row, [na, nb], open, toggle) {
  const id = `xp-cmp-${row.category_id}`;
  const said = `${row.label}: ${na} ${row.a ? valueText(row.a) : 'not graded'}${row.a && row.a.confidence ? ` (${CONFIDENCE[row.a.confidence]})` : ''}; ${nb ? `${nb} ${row.b ? valueText(row.b) : 'not graded'}${row.b && row.b.confidence ? ` (${CONFIDENCE[row.b.confidence]})` : ''}. ${row.result ? row.result.label : ''}` : ''}`;
  const btn = h('button', { type: 'button', class: 'quiet small xp-toggle', 'aria-expanded': String(open), 'aria-controls': id, dataset: { key: `${id}-btn` } }, open ? 'Hide' : 'Evidence');
  btn.setAttribute('aria-label', `${open ? 'Hide' : 'Show'} each model's own words for ${row.label}`);
  btn.addEventListener('click', () => toggle(row.category_id));
  return h('li', { class: `xp-cmp-row g-${row.result ? row.result.group : 'one'}`, 'aria-label': said },
    h('div', { class: 'name' }, h('span', null, row.label), row.other_label ? h('span', { class: 'alt' }, `${nb}: ${row.other_label}`) : null),
    h('div', { class: 'pair' }, modelLine(na, row.a), nb ? modelLine(nb, row.b) : null),
    h('div', { class: 'verdict' }, row.result ? h('span', { class: `xp-cmp-label k-${row.result.kind}`, title: row.result.detail }, row.result.label) : h('span', { class: 'xp-cmp-label k-one' }, 'No second report'), btn),
    h('div', { class: 'more', id, hidden: !open || null }, open ? [
      row.result ? h('p', { class: 'detail' }, row.result.detail) : null,
      h('div', { class: 'xp-cmp-words-pair' }, wordsBlock(na, row.a), nb ? wordsBlock(nb, row.b) : null),
    ] : null));
}

// A single report's categories, when there is no second one to compare.
function oneSidedRows(r) {
  return (r.category_scores || []).map((s) => ({ category_id: s.category_id, label: s.category_label, position: s.position, a: s, b: null, result: null }));
}

function drawBody(st, ui) {
  const { data } = st;
  const choices = reportChoices(data.reports);
  const pick = (id) => (id ? data.reports.find((r) => r.report_id === id) || null : null);
  const a = st.a;
  const b = st.b;
  const choiceOf = (r) => choices.find((c) => c.report === r) || null;
  const p = data.project;
  const out = [];
  out.push(h('div', { class: 'xp-cmp-head' },
    logo({ project_id: p.project_id, name: p.name, symbol: p.ticker }, { size: 28 }),
    h('div', { class: 'names' }, h('span', { class: 'pname' }, p.name), p.ticker ? h('span', { class: 'tick' }, p.ticker) : null),
    data.demo ? h('span', { class: 'xp-demo' }, 'Demo data') : null));
  out.push(h('div', { class: 'xp-cmp-pickers' },
    picker('First report', 'xp-cmp-a', choices, a, (id) => ui.setPair(pick(id), st.b, 'xp-cmp-a')),
    picker('Second report', 'xp-cmp-b', choices, b, (id) => ui.setPair(st.a, pick(id), 'xp-cmp-b'))));
  if (!a && !b) {
    out.push(h('div', { class: 'callout info' }, data.reports.length ? 'Choose a report to read.' : 'No saved report for this project in the Explorer.'));
    return out;
  }
  if (a && b && a === b) {
    out.push(h('div', { class: 'callout info' }, 'The same report is chosen twice. Choose a second, different report.'));
    return out;
  }
  const first = a || b;
  const second = a ? b : null;
  // A missing side says why: the model has no report here, or none is chosen.
  const wanted = a ? 'chatgpt' : 'claude';
  const has = data.reports.some((r) => r.model === wanted && r !== first);
  const empty = has
    ? { title: 'Second report', text: 'No second report chosen. Choose one above to read it beside the first.' }
    : { title: MODEL_LABELS[wanted], text: `No ${MODEL_LABELS[wanted]} report for this project. Nothing else is put in its place; choose another report above to read it beside this one.` };
  const cmp = second ? compareReports(first, second, data.reports) : null;
  const names = cmp ? cmp.names : [name(first), null];
  out.push(h('div', { class: 'xp-cmp-sides' }, side(first, choiceOf(first), null, names[0]), side(second, choiceOf(second), empty, names[1])));
  let rows;
  if (cmp) {
    out.push(scopeBlock(cmp));
    out.push(countsLine(cmp));
    rows = cmp.rows[st.order];
  } else {
    rows = oneSidedRows(first).sort((x, y) => x.position - y.position);
  }
  const orderSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Order' },
    [['inspection', 'For inspection'], ['profile', 'Profile order']].map(([v, t]) => {
      const btn = h('button', { type: 'button', 'aria-pressed': String(st.order === v), disabled: !second || null, dataset: { key: `xp-cmp-order-${v}` } }, t);
      btn.addEventListener('click', () => ui.setOrder(v));
      return btn;
    }));
  out.push(h('div', { class: 'xp-cmp-listhead' },
    h('h3', null, 'Diagnostic categories'),
    second ? orderSeg : null,
    h('p', { class: 'note' }, second && st.order === 'inspection'
      ? `Ordered for inspection: comparable differences of ${NOTABLE_GAP}+ points first, then missing evidence. Not an investment ranking.`
      : 'In the scoring profile\'s order.')));
  out.push(h('ol', { class: `xp-cmp-rows${cmp && first.model === second.model ? ' same-model' : ''}` }, rows.map((row) => categoryRow(row, names, st.open.has(row.category_id), ui.toggle))));
  out.push(h('p', { class: 'xp-cmp-foot' }, 'A difference describes two judgments, not which one is right; matching numbers do not mean the facts agree. These are the diagnostic categories only: the six weighted components behind each grade are not compared here, and nothing is averaged or combined.'));
  return out;
}

// Opens the comparison for one project; the opener gets focus back on close.
export async function openCompare(ctx, project) {
  const body = h('div', { class: 'xp-cmp', 'aria-busy': 'true' }, h('p', { class: 'xp-cmp-loading', role: 'status' }, `Reading ${project.name}…`));
  const dlg = openDialog(`Compare opinions`, body);
  dlg.dlg.classList.add('xp-cmp-dlg');
  let data;
  try {
    data = await ctx.api.get(`/api/explorer/compare?project=${encodeURIComponent(project.project_id)}`);
  } catch (err) {
    data = { state: 'unavailable', reason: `The desk did not answer: ${err.message}`, reports: [] };
  }
  if (!dlg.dlg.isConnected) return;
  body.removeAttribute('aria-busy');
  if (data.state !== 'ok') {
    clear(body).appendChild(h('div', { class: `callout ${data.state === 'unavailable' ? 'bad' : 'info'}`, role: 'status' }, data.reason || 'The comparison is not available.'));
    body.appendChild(h('p', { class: 'xp-cmp-foot' }, 'The rest of the desk is not affected.'));
    return;
  }
  const pair = defaultPair(data.reports);
  const st = { data, a: pair.a, b: pair.b, order: 'inspection', open: new Set() };
  const redraw = (focusKey = null) => {
    clear(body).append(...drawBody(st, ui).flat());
    if (focusKey) {
      const el = body.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
      if (el) el.focus();
    }
  };
  const ui = {
    setPair(a, b, key) {
      st.a = a;
      st.b = b;
      st.open.clear();
      redraw(key);
      announce(a && b && a !== b ? `Comparing ${namesFor(a, b, st.data.reports).join(' and ')}` : 'One report shown');
    },
    setOrder(v) {
      st.order = v;
      redraw(`xp-cmp-order-${v}`);
    },
    toggle(id) {
      if (st.open.has(id)) st.open.delete(id);
      else st.open.add(id);
      redraw(`xp-cmp-${id}-btn`);
    },
  };
  redraw();
  announce(`${data.project.name}: ${st.a && st.b ? `comparing ${namesFor(st.a, st.b, data.reports).join(' and ')}` : 'one model report'}`);
}
