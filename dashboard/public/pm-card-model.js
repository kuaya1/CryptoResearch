// What the PM Decision Card says about rules and reports (backlog item 33):
// the ticket's "made under a newer rule" note (core/tickets.js newerRuleOf,
// item 13) and the change since Claude's earlier report (core/report-delta.js,
// item 26) as a badge that names the two prompt versions. Pure, for the card
// and the tests; both are read from the index row on every draw and nothing
// here is stored, fetched or written.

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const signed = (n) => `${n < 0 ? '−' : '+'}${Math.abs(Math.round(n * 100) / 100).toFixed(1)}`;
// "cr-research-prompt@5" → "@5"; a version without "@" is shown whole.
const shortVersion = (v) => (typeof v === 'string' && v ? (v.includes('@') ? `@${v.split('@').pop()}` : v) : null);

// The rule note in words, or null when the ticket was made under rules this
// desk knows.
export function ruleNoteOf(ticket) {
  return ticket && typeof ticket.rule_note === 'string' && ticket.rule_note ? ticket.rule_note : null;
}

// The delta badge: { text, title, tone, versions } or null when there is no
// comparison to show. A figure reads "+4.2 vs previous @5"; without one the
// desk's own words stand ("Grade change not given: ..."). A change of prompt
// version is said in the title and tones the badge, never hidden.
export function deltaBadgeOf(delta) {
  if (!delta || delta.status !== 'ok') return null;
  const pv = delta.prompt_versions || {};
  const before = shortVersion(pv.previous);
  const now = shortVersion(pv.new);
  const changed = Boolean(before && now && pv.previous !== pv.new);
  const versionWords = before || now
    ? `Prompt ${pv.previous || 'version not stated'} then, ${pv.new || 'version not stated'} now${changed ? ': a different prompt' : ''}.`
    : 'Prompt versions not stated.';
  const text = isNum(delta.grade_delta)
    ? `${signed(delta.grade_delta)} vs previous${before ? ` ${before}` : ''}${delta.verdict_changed ? `; verdict ${delta.previous_verdict} → ${delta.new_verdict}` : ''}`
    : String(delta.line || delta.grade_note || 'Change not given');
  const title = [delta.grade_note, delta.category_note, versionWords].filter(Boolean).join(' ');
  const tone = changed || !isNum(delta.grade_delta) ? 'is-warn' : delta.grade_delta < 0 ? 'is-bad' : delta.grade_delta > 0 ? 'is-ok' : '';
  return { text, title, tone, versions: { previous: pv.previous || null, new: pv.new || null } };
}

// Item 56: the deep link from a disagreement to Compare at the category where
// Claude and another model differ most. Read from the index row's spread
// alerts (core/spread.js): only a model_spread alert that names a category
// counts; the widest gap wins, ties by model name. Null when the project has
// none, never a guessed category.
export function widestCategoryLink(spread) {
  const alerts = spread && Array.isArray(spread.alerts) ? spread.alerts : [];
  const named = alerts.filter((a) => a && a.kind === 'model_spread' && a.category && a.category.id && typeof a.link === 'string');
  if (!named.length) return null;
  named.sort((a, b) => (b.category.gap - a.category.gap) || String(a.other).localeCompare(String(b.other)));
  const a = named[0];
  const name = a.category.id.replace(/_/g, ' ');
  return { href: a.link, text: `Widest category: ${name}`, title: `Claude ${a.category.claude} and ${a.other} ${a.category.other} (${a.category.gap} points apart); opens Compare` };
}

// The suggested risk in words (L2, 2026-10-26): a figure, "$0" with why the
// desk sized it so (held by the admission check, capped by the gate, or a
// proposal that takes no new risk), or "—" when the ticket gives none. Never
// "None": a sized $0 and a missing value are different facts.
// { text, why (a few words or null), title (the full reason) }.
const TAKES_RISK = new Set(['ACCUMULATE', 'LIMIT_TRAP']);
const usd0 = (n) => `$${n.toLocaleString('en-US', { maximumFractionDigits: n < 100 ? 2 : 0 })}`;
export function riskWords(ticket) {
  const t = ticket || {};
  const n = t.suggested_risk_usd;
  if (!isNum(n) || n < 0) return { text: '—', why: null, title: 'This ticket gives no suggested risk.' };
  if (n > 0) return { text: usd0(n), why: null, title: `The desk's sizing gate suggests ${usd0(n)} of risk.` };
  const held = t.admission && t.admission.held_risk;
  if (held) return { text: '$0', why: 'Held', title: `Held at $0 by the admission check${isNum(held.risk_usd) ? ` (sized ${usd0(held.risk_usd)} before it)` : ''}: ${held.reason || 'no reason recorded'}.` };
  const capped = t.capped;
  const reason = (capped && capped.reason) || (Array.isArray(t.gate_reasons) && t.gate_reasons[0]) || null;
  if (capped || TAKES_RISK.has(t.proposal_type)) return { text: '$0', why: 'Capped', title: `Capped at $0 by the desk's gate: ${reason || 'no reason recorded'}.` };
  return { text: '$0', why: 'No new risk', title: `This proposal takes no new risk${reason ? `: ${reason}` : '.'}` };
}
