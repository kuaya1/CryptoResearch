// Second opinion: two saved reports on one project, category by category
// (views/explorer-compare.js draws it). Pure functions, no DOM, so every rule
// is tested directly (tests/explorer.test.js).
// - Numbers are compared only when both reports state the same scoring-profile
//   version and rubric version and define the category the same way (its
//   stored ID and label), so a category means the same thing in both.
// - Two points: their absolute difference. A point and a range: inside or
//   outside, and by how much. Two ranges: overlapping or separated.
// - Unknown and N/A keep their meaning; nothing becomes 0; a range is never
//   a midpoint; nothing is averaged; there is no consensus and no winner.
// - A difference describes two judgments, not which is right, and the same
//   number does not mean the facts behind it agree.
// - Two separate facts: the research scope (did both answer the same frozen
//   request: run, prompt, scoring versions, horizon, and the frozen prompt
//   and evidence hashes where stored) and the authorship (two models, or one
//   model's original and its revision, or one model twice). Missing metadata
//   leaves the scope unconfirmed. A matching scope never certifies accuracy.
// - Latest is the desk's own rule (reports.js reportSortKey), computed on the
//   server and sent with each report as order_key.

// A comparable difference at least this large is listed first for inspection.
export const NOTABLE_GAP = 5;
export const MODEL_LABELS = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };
const MODELS = ['claude', 'chatgpt', 'gemini'];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const fmt = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));
const points = (n) => `${fmt(n)} point${n === 1 ? '' : 's'}`;
const modelName = (r) => (r ? MODEL_LABELS[r.model] || r.model : '');

// How two reports relate, from the stored records only, and what each is
// called on screen: two models ("Claude", "ChatGPT"); one model's original
// and its revision, either way round and through any chain of revisions in
// `all` ("Claude (original)", "Claude (revision)"); or two separate reports
// by one model ("Claude (first)", "Claude (second)", the pickers' order).
export function relationOf(a, b, all = []) {
  if (!a || !b) return { kind: 'one', names: [modelName(a), modelName(b)] };
  const m = modelName(a);
  if (a.model !== b.model) return { kind: 'models', names: [m, modelName(b)] };
  const byId = new Map([...(all || []), a, b].map((r) => [r.report_id, r]));
  const reaches = (later, earlier) => {
    const seen = new Set();
    for (let r = later; r && r.revision_of && !seen.has(r.report_id); r = byId.get(r.revision_of)) {
      seen.add(r.report_id);
      if (r.revision_of === earlier.report_id) return true;
    }
    return false;
  };
  const older = (r) => `${m} (${r.revision_of ? 'earlier revision' : 'original'})`;
  const newer = (o) => `${m} (${o.revision_of ? 'later revision' : 'revision'})`;
  if (reaches(b, a)) return { kind: 'revision', original: 0, names: [older(a), newer(a)] };
  if (reaches(a, b)) return { kind: 'revision', original: 1, names: [newer(b), older(b)] };
  return { kind: 'same_model', names: [`${m} (first)`, `${m} (second)`] };
}

export function namesFor(a, b, all = []) {
  return relationOf(a, b, all).names;
}

// Who wrote the two reports: a fact apart from the research scope. Only two
// different models are independent authors; a revision, or a second report
// by the same model, is that model's judgment again.
export function authorshipOf(rel) {
  const [na, nb] = rel.names;
  if (rel.kind === 'models') return { independent: true, label: 'Independent authorship', text: `Two different models, ${na} and ${nb}, each wrote its own report.` };
  const m = na.replace(/ \(.*\)$/, '');
  if (rel.kind === 'revision') {
    const role = (i) => rel.names[i].replace(/^.* \((.*)\)$/, '$1');
    return { independent: false, label: 'Original and revision', text: `Both reports are ${m}'s: the ${role(1 - rel.original)} revises the ${role(rel.original)} for the same research run. A revision is the same model's judgment again, not an independent second opinion.` };
  }
  return { independent: false, label: 'Same model', text: `Both reports are ${m}'s, from separate saves: not an independent second opinion.` };
}

// What a stored category grade is: a point, a range, unknown, N/A, or absent.
export function valueOf(s) {
  if (!s) return { kind: 'missing' };
  if (s.status === 'scored' && isNum(s.score)) return { kind: 'point', v: s.score };
  if (s.status === 'range' && isNum(s.score_low) && isNum(s.score_high)) return { kind: 'range', lo: s.score_low, hi: s.score_high };
  if (s.status === 'not_applicable') return { kind: 'na' };
  return { kind: 'unknown' };
}

export function valueText(s) {
  const x = valueOf(s);
  if (x.kind === 'point') return fmt(x.v);
  if (x.kind === 'range') return `${fmt(x.lo)}–${fmt(x.hi)}`;
  if (x.kind === 'na') return 'N/A';
  if (x.kind === 'missing') return 'Not in report';
  return 'Unknown';
}

// One category, two grades. comparable: the reports share the scoring
// profile and rubric versions and define the category the same way; why:
// the label and sentence for two grades that are not compared. Returns the kind, a short label, a detail
// sentence, the gap in points where one is defined, and the inspection group:
// notable (comparable gap of NOTABLE_GAP or more), missing (evidence missing),
// close (a smaller gap, or none), other (N/A, not comparable, not graded).
const VERSIONS_DIFFER = { label: 'Different scoring versions', detail: 'The two reports use different scoring versions, so their numbers are shown side by side and not compared.' };

export function compareScores(a, b, { comparable = true, nameA = 'A', nameB = 'B', why = VERSIONS_DIFFER } = {}) {
  const x = valueOf(a);
  const y = valueOf(b);
  const out = (kind, label, detail, group, gap = null) => ({ kind, label, detail, group, gap });
  if (x.kind === 'missing' || y.kind === 'missing') {
    const who = x.kind === 'missing' ? nameA : nameB;
    return comparable
      ? out('not_in_report', `Not graded by ${who}`, `${who}'s report gives no grade for this category.`, 'missing')
      : out('not_in_profile', `Not in ${who}'s scoring profile`, `${who}'s report was scored under a profile without this category.`, 'other');
  }
  if (x.kind === 'na' || y.kind === 'na') {
    if (x.kind === 'na' && y.kind === 'na') return out('both_na', 'Not applicable to both', 'Both reports say this category does not apply.', 'other');
    const who = x.kind === 'na' ? nameA : nameB;
    const other = x.kind === 'na' ? y : x;
    return out('one_na', `N/A for ${who}`, `${who} says this category does not apply; the other report ${other.kind === 'unknown' ? 'leaves it unknown' : 'grades it'}.`, 'other');
  }
  if (x.kind === 'unknown' || y.kind === 'unknown') {
    if (x.kind === 'unknown' && y.kind === 'unknown') return out('both_unknown', 'Evidence missing', 'Unknown in both reports: neither found the evidence to grade it.', 'missing');
    const who = x.kind === 'unknown' ? nameA : nameB;
    return out('one_unknown', 'Evidence missing', `Unknown for ${who}: no number was given, so there is nothing to compare.`, 'missing');
  }
  if (!comparable) return out('not_comparable', why.label, why.detail, 'other');
  const group = (gap) => (gap >= NOTABLE_GAP ? 'notable' : 'close');
  if (x.kind === 'point' && y.kind === 'point') {
    const gap = Math.abs(x.v - y.v);
    if (gap === 0) return out('same', 'Same score', 'The same number in both reports. Matching numbers do not mean the facts behind them agree.', 'close', 0);
    return out('difference', `${fmt(gap)}-point difference`, `${nameA} ${fmt(x.v)}, ${nameB} ${fmt(y.v)}: a difference between two judgments, not a measure of which is right.`, group(gap), gap);
  }
  if (x.kind === 'range' && y.kind === 'range') {
    if (x.lo <= y.hi && y.lo <= x.hi) {
      return out('overlap', 'Scores overlap', `Both ranges include ${fmt(Math.max(x.lo, y.lo))}–${fmt(Math.min(x.hi, y.hi))}. Overlapping ranges do not mean the facts behind them agree.`, 'close', 0);
    }
    const gap = Math.max(y.lo - x.hi, x.lo - y.hi);
    return out('separated', `Separated by ${points(gap)}`, `The ranges do not overlap: ${points(gap)} lie between them.`, group(gap), gap);
  }
  // One point, one range.
  const p = x.kind === 'point' ? x : y;
  const r = x.kind === 'range' ? x : y;
  const pName = x.kind === 'point' ? nameA : nameB;
  const rName = x.kind === 'range' ? nameA : nameB;
  if (p.v >= r.lo && p.v <= r.hi) return out('inside', 'Inside the range', `${pName}'s ${fmt(p.v)} is inside ${rName}'s ${fmt(r.lo)}–${fmt(r.hi)}.`, 'close', 0);
  const gap = p.v < r.lo ? r.lo - p.v : p.v - r.hi;
  return out('outside', `Outside the range by ${points(gap)}`, `${pName}'s ${fmt(p.v)} is ${points(gap)} ${p.v < r.lo ? 'below' : 'above'} ${rName}'s ${fmt(r.lo)}–${fmt(r.hi)}.`, group(gap), gap);
}

// Same scoring-profile and rubric versions, both stated: the categories can
// mean the same (each row still checks its own definition).
export function versionsOf(a, b, names = namesFor(a, b)) {
  const stated = Boolean(a.profile_version && a.rubric_version && b.profile_version && b.rubric_version);
  const compatible = stated && a.profile_version === b.profile_version && a.rubric_version === b.rubric_version;
  const v = (r) => `${r.profile_version || 'profile not stated'} · ${r.rubric_version || 'rubric not stated'}`;
  const [na, nb] = names;
  return {
    compatible,
    label: compatible ? 'Same scoring version' : stated ? 'Different scoring versions' : 'Scoring version not stated',
    text: compatible ? v(a) : `${na}: ${v(a)}; ${nb}: ${v(b)}. Numbers are shown side by side and not compared.`,
  };
}

const horizonOf = (r) => (r.horizon_start && r.horizon_end ? `${r.horizon_start} to ${r.horizon_end}` : null);
const NOT_STORED = 'Not stored in the Explorer';

// What makes two reports answers to the same frozen research request. The
// required facts must be stated by both; the frozen prompt and evidence
// packet hashes are compared where stored (the Explorer does not store them
// yet: then they are listed as not stored, never assumed to match).
const SCOPE = [
  { what: 'Research run', noun: 'a research run', many: 'research runs', of: (r) => r.research_run_id, required: true },
  { what: 'Prompt', noun: 'a prompt version', many: 'prompt versions', of: (r) => r.prompt_version, required: true },
  { what: 'Frozen prompt hash', noun: 'the frozen prompt hash', many: 'frozen prompts', of: (r) => r.prompt_sha256, required: false },
  { what: 'Evidence packet hash', noun: 'the evidence packet hash', many: 'evidence packets', of: (r) => r.evidence_packet_sha256, required: false },
  { what: 'Scoring profile', noun: 'a scoring profile', many: 'scoring profiles', of: (r) => r.profile_version, required: true },
  { what: 'Rubric', noun: 'a rubric version', many: 'rubric versions', of: (r) => r.rubric_version, required: true },
  { what: 'Horizon', noun: 'a horizon', many: 'horizons', of: horizonOf, required: true },
];

// Whether the stored metadata shows both reports answered the same frozen
// request: "Research scope matches" (every fact stated by both and the same),
// "Research scope differs" (a fact both state differs), or "Scope not
// confirmed" (nothing differs, but a fact is missing). Research dates are
// listed apart: models in one run may finish on different days. Scope says
// nothing about accuracy, and nothing about who wrote the reports
// (authorshipOf).
export function scopeOf(a, b, names = namesFor(a, b)) {
  const [na, nb] = names;
  const differs = [];
  const missing = [];
  const facts = SCOPE.map((f) => {
    const x = f.of(a) || null;
    const y = f.of(b) || null;
    if (x && y && x !== y) differs.push(`different ${f.many}`);
    else if (f.required && (!x || !y)) missing.push(!x && !y ? `neither states ${f.noun}` : `${!x ? na : nb} states no ${f.noun.replace(/^an? /, '')}`);
    else if (!f.required && Boolean(x) !== Boolean(y)) missing.push(`${f.noun} is stored for ${x ? na : nb} only`);
    const none = f.required ? 'Not stated' : NOT_STORED;
    return { what: f.what, a: x || none, b: y || none, differs: Boolean(x && y && x !== y), missing: f.required ? !x || !y : Boolean(x) !== Boolean(y) };
  });
  facts.push({ what: 'Research date', a: a.research_date || 'Not stated', b: b.research_date || 'Not stated', differs: Boolean(a.research_date && b.research_date && a.research_date !== b.research_date), missing: false, apart: true });
  const hashes = SCOPE.filter((f) => !f.required);
  const hashesCompared = hashes.every((f) => f.of(a) && f.of(b));
  const hashesAbsent = hashes.every((f) => !f.of(a) && !f.of(b));
  const status = differs.length ? 'differs' : missing.length ? 'unconfirmed' : 'matches';
  const cap = (t) => t.replace(/^./, (c) => c.toUpperCase());
  let text;
  if (status === 'matches') {
    text = `Same research run, prompt, scoring profile, rubric and horizon${hashesCompared ? ', and the same frozen prompt and evidence packet' : ''}: both reports answered the same frozen request.`;
    if (hashesAbsent) text += ' The frozen prompt and evidence packet hashes are not stored in the Explorer, so they are not compared.';
  } else if (status === 'differs') {
    text = `${cap([...differs, ...missing].join('; '))}. Read side by side; this is not a controlled comparison.`;
  } else {
    text = `${cap(missing.join('; '))}. Missing metadata leaves the scope unconfirmed: read side by side; this is not a controlled comparison.`;
  }
  return {
    status,
    confirmed: status === 'matches',
    label: status === 'matches' ? 'Research scope matches' : status === 'differs' ? 'Research scope differs' : 'Scope not confirmed',
    text,
    caveat: 'A matching scope means the same request, not a correct answer: it does not certify that either report is accurate.',
    facts,
  };
}

// The desk's latest-report rule, computed by the desk's own code on the
// server (core/explorer.js orderKey, which calls reports.js reportSortKey)
// and sent with each report; the largest key is the latest. Without one (an
// answer from an older server), the save time.
export function sortKey(r) {
  return r.order_key ? String(r.order_key) : `|${String(r.saved_at || '')}|${r.report_id}`;
}

export function latestFor(reports, model) {
  return (reports || []).filter((r) => r.model === model).sort((x, y) => sortKey(y).localeCompare(sortKey(x)))[0] || null;
}

// Every report of the project, newest first per model (models in desk order),
// with where it sits: latest (the desk's rule), a revision, or an earlier
// save revised later. The revision link is the desk's own (revisions.js
// revisionOf, stored at export): a later save of the same model for the same
// research run.
export function reportChoices(reports) {
  const list = reports || [];
  return MODELS.filter((m) => list.some((r) => r.model === m)).flatMap((m) => {
    const latest = latestFor(list, m);
    return list.filter((r) => r.model === m).sort((x, y) => sortKey(y).localeCompare(sortKey(x))).map((r) => ({
      report: r,
      model: m,
      latest: r === latest,
      revision: r.revision_of ? { of: r.revision_of, kind: r.revision_kind, basis: r.revision_basis, note: r.revision_note } : null,
      revisedBy: list.filter((x) => x.revision_of === r.report_id).map((x) => x.report_id),
    }));
  });
}

// Claude and ChatGPT by default, each its own latest report. A model with no
// report stays empty: nothing earlier or from another model is put in its place.
export function defaultPair(reports) {
  return { a: latestFor(reports, 'claude'), b: latestFor(reports, 'chatgpt') };
}

const GROUP_ORDER = { notable: 0, missing: 1, close: 2, other: 3 };

// Every category either report grades (13 under the @2 profiles), each with
// both grades and the comparison, in two orders: for inspection (comparable
// differences of NOTABLE_GAP or more, largest first; then missing evidence;
// then smaller or no differences; then N/A and not comparable) and the
// profile's own order. The inspection order is for reading, not a ranking.
// A number is compared only under the same stated profile and rubric
// versions and when both reports define the category the same way (the same
// stored ID and label). `all`: the project's reports, to follow a chain of
// revisions.
export function compareReports(a, b, all = []) {
  const relation = relationOf(a, b, all);
  const [nameA, nameB] = relation.names;
  const versions = versionsOf(a, b, relation.names);
  const byId = (r) => new Map((r.category_scores || []).map((s) => [s.category_id, s]));
  const sa = byId(a);
  const sb = byId(b);
  const ids = [...sa.keys(), ...[...sb.keys()].filter((k) => !sa.has(k))];
  const rows = ids.map((id) => {
    const x = sa.get(id) || null;
    const y = sb.get(id) || null;
    const sameDefinition = !x || !y || x.category_label === y.category_label;
    const why = versions.compatible
      ? { label: 'Category definitions differ', detail: `Under the same scoring version the two reports define this category differently (“${x && x.category_label}” and “${y && y.category_label}”), so the numbers are shown side by side and not compared.` }
      : { label: versions.label, detail: versions.label === 'Scoring version not stated' ? 'A report does not state its scoring profile or rubric version, so the numbers are shown side by side and not compared.' : VERSIONS_DIFFER.detail };
    return {
      category_id: id,
      label: (x || y).category_label,
      other_label: x && y && x.category_label !== y.category_label ? y.category_label : null,
      position: x ? x.position : 100 + (y ? y.position : 0),
      a: x,
      b: y,
      result: compareScores(x, y, { comparable: versions.compatible && sameDefinition, nameA, nameB, why }),
    };
  });
  const profile = [...rows].sort((p, q) => p.position - q.position);
  const inspection = [...rows].sort((p, q) => GROUP_ORDER[p.result.group] - GROUP_ORDER[q.result.group]
    || (q.result.gap ?? -1) - (p.result.gap ?? -1)
    || p.position - q.position);
  const count = (g) => rows.filter((r) => r.result.group === g).length;
  return {
    names: [nameA, nameB],
    relation: relation.kind,
    authorship: authorshipOf(relation),
    versions,
    scope: scopeOf(a, b, relation.names),
    rows: { inspection, profile },
    counts: { categories: rows.length, notable: count('notable'), missing: count('missing'), close: count('close'), other: count('other') },
  };
}
