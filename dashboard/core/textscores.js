'use strict';
// The written report against its own data block (read-time, 2026-10-06).
// A model may revise its data block and leave older numbers in its text: a
// summary line that still reads "Timing and executable liquidity 45–60"
// while the data block says 53. Where the report's own text gives a score
// for one of the six weighted components or a category grade that differs
// from its data block (a range in one and a point in the other, another
// number, unknown in one and a score in the other), the desk says so.
//
// It changes nothing and chooses nothing: the grade is calculated from the
// data block as saved (and your corrections), the text stays as written, and
// both are shown. Only clear statements are read: the item's own name, as
// the rubric or profile labels it or as its ID, followed directly by its
// score, as in a score table ("| Token value capture | 47 |") or a line
// ("BTC-relative asymmetry 35–50;"). Prose that discusses an item, a score
// followed by anything but punctuation ("53 → 60", "30 days"), a number
// outside 1 to 100, and a sentence about a revision ("previously 45–60")
// are never read as a score; a range followed by the data block's own point
// in brackets ("45–60 (central 53)") agrees with it. A name shared by a
// component and a category (token value capture) is a mismatch only when it
// matches neither. Nothing found to compare is said as nothing compared,
// never as a clean result.

const NUM = '(\\d{1,3}(?:\\.\\d+)?)';
// Between the name and its score: spaces, emphasis, a colon, an equals sign,
// a table bar or a dash, and the word "score". Nothing else.
const LEAD = '^(?:[\\s*_:=|]|—|–|-)*(?:score\\s*(?:of\\s*)?(?:[\\s*_:=|]|—|–)*)?';
// After the score: an optional "/100", emphasis, then punctuation or the end.
const TAIL = '(?:\\s*\\/\\s*100)?[*_]*(?=\\s*(?:$|[;,|()\\]]|\\.(?:\\s|$)))';
const VALUE_RE = new RegExp(`${LEAD}(?:${NUM}\\s*(?:–|—|-|to)\\s*${NUM}|${NUM}|(unknown|n\\/a|not applicable))${TAIL}`, 'i');

// The prose: the text before the data block (the last fenced block holding
// a schema_version), the way the report reader splits it.
function proseOf(text) {
  const fence = /```[ \t]*[A-Za-z0-9_-]*[^\n]*\n([\s\S]*?)\n[ \t]*```/g;
  let last = null;
  let m;
  while ((m = fence.exec(text))) if (/"schema_version"/.test(m[1])) last = m.index;
  return last === null ? text : text.slice(0, last);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const spaced = (id) => String(id).replace(/_/g, ' ');

// Every name an item may be written under, longest first, each with the
// items it names (a component and a category may share one).
function namesOf(grading, profile, a) {
  const byName = new Map();
  const add = (name, target) => {
    const k = String(name || '').trim().toLowerCase();
    if (k.length < 5) return;
    const list = byName.get(k) || [];
    if (!list.some((x) => x.group === target.group && x.id === target.id)) list.push(target);
    byName.set(k, list);
  };
  ((grading && grading.investment_components) || []).forEach((c, i) => {
    const t = { group: 'investment_components', id: c.id, label: c.label || spaced(c.id), order: i };
    [c.label, spaced(c.id), c.id].forEach((n) => add(n, t));
  });
  const cats = new Map(((profile && profile.diagnostic_categories) || []).map((c) => [c.id, c.label]));
  for (const id of Object.keys((a && a.diagnostic_scores) || {})) if (!cats.has(id)) cats.set(id, null);
  [...cats].forEach(([id, label], i) => {
    const t = { group: 'diagnostic_scores', id, label: label || spaced(id), order: 100 + i };
    [label, spaced(id), id].forEach((n) => add(n, t));
  });
  return [...byName.entries()].sort((x, y) => y[0].length - x[0].length);
}

const inRange = (v) => v >= 1 && v <= 100;
// Numbers in a bracket right after a range: "45–60 (central 53)".
const BRACKET_RE = /^\s*\(([^)]{0,40})\)/;
function parseValue(rest) {
  const m = VALUE_RE.exec(rest);
  if (!m) return null;
  if (m[1] !== undefined) {
    const low = Number(m[1]);
    const high = Number(m[2]);
    const b = BRACKET_RE.exec(rest.slice(m[0].length));
    const alt = b ? (b[1].match(/\d{1,3}(?:\.\d+)?/g) || []).map(Number).filter(inRange) : [];
    return inRange(low) && inRange(high) && low < high ? { kind: 'range', low, high, alt } : null;
  }
  if (m[3] !== undefined) {
    const v = Number(m[3]);
    return inRange(v) ? { kind: 'point', value: v } : null;
  }
  return { kind: 'none', word: m[4].toLowerCase() };
}

const fmt = (x) => (x.kind === 'range' ? `${x.low}–${x.high}` : x.kind === 'point' ? String(x.value) : x.word === 'n/a' || x.word === 'not applicable' ? 'N/A' : 'unknown');
const dataText = (s) => (!s ? 'not given' : s.status === 'scored' ? String(s.value) : s.status === 'range' ? `${s.low}–${s.high}` : s.status === 'not_applicable' ? 'N/A' : 'unknown');
const close = (x, y) => typeof x === 'number' && typeof y === 'number' && Math.abs(x - y) <= 0.5;

// Whether the text's value agrees with the data block's score: true, false,
// or null when the data block has nothing to compare (not given).
function agrees(t, s) {
  if (!s || !s.status) return null;
  const scored = s.status === 'scored' && typeof s.value === 'number';
  const range = s.status === 'range' && typeof s.low === 'number' && typeof s.high === 'number';
  if (t.kind === 'none') return !scored && !range;
  if (t.kind === 'point') return scored ? close(t.value, s.value) : range ? t.value >= s.low - 0.5 && t.value <= s.high + 0.5 : false;
  if (range) return close(t.low, s.low) && close(t.high, s.high);
  return scored ? (t.alt || []).some((v) => close(v, s.value)) : false;
}

// A sentence about a revision states an earlier score on purpose.
const REVISION_WORDS_RE = /\b(previous(ly)?|prior|earlier|formerly|revis(ed|ion)|narrowed|replaced|superseded)\b|→|->|⇒/i;
function sentenceAround(prose, at, end) {
  const before = prose.slice(0, at);
  const start = Math.max(before.lastIndexOf('\n'), ...['. ', '! ', '? '].map((p) => before.lastIndexOf(p))) + 1;
  const after = prose.slice(end);
  const stops = [after.indexOf('\n'), ...['. ', '! ', '? '].map((p) => after.indexOf(p))].filter((i) => i >= 0);
  return prose.slice(start, stops.length ? end + Math.min(...stops) : prose.length);
}

// The comparison for one report: what was read from the text, and every item
// whose text score differs from its data block. Pure.
function textScoreChecks(text, assessment, { grading = null, profile = null } = {}) {
  const a = assessment || {};
  if (typeof text !== 'string' || !text) return null;
  const prose = proseOf(text);
  const taken = [];
  const free = (from, to) => !taken.some(([x, y]) => from < y && to > x);
  const mentions = [];
  for (const [name, targets] of namesOf(grading, profile, a)) {
    const re = new RegExp(`(?<![\\w-])${esc(name)}(?![\\w-])`, 'gi');
    let m;
    while ((m = re.exec(prose))) {
      const at = m.index;
      const end = at + m[0].length;
      if (!free(at, end)) continue;
      taken.push([at, end]);
      const lineEnd = prose.indexOf('\n', end);
      const value = parseValue(prose.slice(end, lineEnd === -1 ? undefined : lineEnd));
      if (!value || REVISION_WORDS_RE.test(sentenceAround(prose, at, end))) continue;
      const line = prose.slice(0, at).split('\n').length;
      mentions.push({ targets, value, line });
    }
  }
  const scores = (t) => ((a[t.group] || {})[t.id]) || null;
  const byItem = new Map();
  let compared = 0;
  for (const x of mentions) {
    const verdicts = x.targets.map((t) => agrees(x.value, scores(t)));
    if (verdicts.every((v) => v === null)) continue;
    compared += 1;
    if (verdicts.some((v) => v === true)) continue;
    // A mismatch, said against the item whose data it contradicts (the
    // component first where a name is shared).
    const t = x.targets.find((tt, i) => verdicts[i] === false);
    const key = `${t.group}.${t.id}`;
    const item = byItem.get(key) || { group: t.group, id: t.id, label: t.label, order: t.order, text: [], lines: [], data: dataText(scores(t)) };
    if (!item.text.includes(fmt(x.value))) item.text.push(fmt(x.value));
    if (!item.lines.includes(x.line)) item.lines.push(x.line);
    byItem.set(key, item);
  }
  // In the rubric's order: the six components, then the categories.
  const mismatches = [...byItem.values()].sort((x, y) => x.order - y.order).map(({ order, ...rest }) => rest);
  const one = (m) => `${m.label} ${m.text.join(' and ')} in the text, ${m.data} in the data block`;
  return {
    compared,
    mismatches,
    summary: !compared
      ? null
      : mismatches.length
        ? `The written report gives ${mismatches.length === 1 ? 'a score' : `${mismatches.length} scores`} that differ${mismatches.length === 1 ? 's' : ''} from its data block: ${mismatches.map(one).join('; ')}. The grade is calculated from the data block as saved; the text is kept as written, and neither is changed.`
        : `The scores the written report states match its data block (${compared} compared).`,
  };
}

module.exports = { textScoreChecks, proseOf };
