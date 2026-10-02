'use strict';
// Report parsing and normalization.
// A report arrives as Markdown/TXT (optionally ending with the cr.report.v1 JSON
// block from the grading appendix), as a bare JSON file, or as a PDF (preserved,
// flagged "needs text"). Nothing here invents content: anything not found is
// recorded as unknown with an explanation, and ambiguous extractions are listed
// for correction instead of guessed.

const path = require('path');
const { normalizeScore, emptyScore } = require('./scoring');
const { validate, loadSchema } = require('./schema');
const { readJson, listDir } = require('./fsx');
const { isRecordId } = require('./ids');

const VERDICTS = [
  'ATTRACTIVE ASYMMETRY',
  'CONDITIONAL OPPORTUNITY',
  'REAL PRODUCT, WEAK TOKEN',
  'INCENTIVE-DEPENDENT',
  'UNFAVORABLE VALUATION',
  'INSUFFICIENT EVIDENCE',
];
const EVIDENCE_TAGS = {
  V: "Checked in that analyst's session",
  C: 'Project-claimed',
  I: 'Analyst inference',
  S: 'Speculative forecast',
};
const SKELETON_SENTINEL = 'Not assessed yet';
const LIST_FIELDS = ['bullish_facts', 'bearish_facts', 'conviction_increases', 'invalidators'];

function normVerdictText(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z]+/g, ' ').trim();
}
const VERDICT_NORM = VERDICTS.map((v) => [normVerdictText(v), v]);

function matchVerdict(s) {
  const n = normVerdictText(s);
  const hit = VERDICT_NORM.find(([norm]) => norm === n);
  return hit ? hit[1] : null;
}

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Finding the JSON block

function isReportObj(o) {
  return Boolean(o) && typeof o === 'object' && !Array.isArray(o) && o.schema_version === 'cr.report.v1';
}

function balancedFrom(text, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function findReportJson(text) {
  const parseErrors = [];
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      if (isReportObj(obj)) return { obj, method: 'json_file', line: 1, parseErrors };
    } catch (err) {
      parseErrors.push(err.message);
    }
  }
  const fence = /```[ \t]*([A-Za-z0-9_-]*)[^\n]*\n([\s\S]*?)\n[ \t]*```/g;
  let found = null;
  let m;
  while ((m = fence.exec(text))) {
    if (!/cr\.report\.v1/.test(m[2])) continue;
    try {
      const obj = JSON.parse(m[2]);
      if (isReportObj(obj)) found = { obj, method: 'appendix_json', line: lineOf(text, m.index), parseErrors };
    } catch (err) {
      parseErrors.push(`JSON block at line ${lineOf(text, m.index)}: ${err.message}`);
    }
  }
  if (found) return found;
  // Unfenced JSON pasted at the end of a report.
  const idx = text.lastIndexOf('"cr.report.v1"');
  if (idx !== -1) {
    for (let start = text.lastIndexOf('{', idx); start !== -1; start = text.lastIndexOf('{', start - 1)) {
      const candidate = balancedFrom(text, start);
      if (candidate && start + candidate.length > idx) {
        try {
          const obj = JSON.parse(candidate);
          if (isReportObj(obj)) return { obj, method: 'appendix_json_unfenced', line: lineOf(text, start), parseErrors };
        } catch (err) {
          parseErrors.push(`Unfenced JSON at line ${lineOf(text, start)}: ${err.message}`);
          break;
        }
      }
      if (text.length - start > 400000) break;
    }
  }
  return { obj: null, parseErrors };
}

function isUntouchedSkeleton(obj) {
  const groups = [obj.diagnostic_scores, obj.investment_components, obj.risk_scores];
  const scores = groups
    .flatMap((g) => (g && typeof g === 'object' ? Object.values(g) : []))
    .filter((s) => !(s && s.status === 'not_applicable'));
  return (
    !obj.verdict &&
    scores.length > 0 &&
    scores.every((s) => s && s.status === 'unknown' && String(s.missing_data || '').startsWith(SKELETON_SENTINEL))
  );
}

// ---------------------------------------------------------------------------
// Prompt versus report

function promptSignals(text) {
  const reasons = [];
  const marker = /CR-PROMPT\b|CR-APPENDIX\b/.test(text);
  if (marker) reasons.push('contains the CR-PROMPT / CR-APPENDIX marker used in prompt templates');
  const placeholders = /\{\{\s*[A-Z][A-Z0-9_]*\s*\}\}/.test(text);
  if (placeholders) reasons.push('contains unfilled {{PLACEHOLDERS}}');
  const norm = normVerdictText(text);
  const verdictsListed = VERDICT_NORM.filter(([n]) => norm.includes(n)).length;
  if (verdictsListed >= 4) reasons.push(`lists ${verdictsListed} of the 6 verdict labels (a menu of options, not a verdict)`);
  const imperative = (text.match(/^\s*(?:[-*•]|\d+[.)])?\s*(?:you are|you're|act as|your task|analy[sz]e|evaluate|assess|provide|produce|output|respond|return|do not|don't|never|always|include|tag every|use the following|write)\b/gim) || []).length;
  if (imperative >= 8) reasons.push(`${imperative} lines are instructions addressed to an analyst`);
  const scoreLike = (text.match(/\b\d{1,3}\s*\/\s*100\b/g) || []).length;
  const isPrompt = marker || placeholders || ((verdictsListed >= 4 || imperative >= 8) && scoreLike === 0);
  return { isPrompt, marker, reasons };
}

function classify(text) {
  const t = text || '';
  if (!t.trim()) return { kind: 'empty', reasons: ['the file is empty'] };
  const json = findReportJson(t);
  const signals = promptSignals(t);
  if (json.obj) {
    if (signals.isPrompt && isUntouchedSkeleton(json.obj)) {
      return { kind: 'prompt', reasons: [...signals.reasons, 'its JSON block is the unfilled skeleton'] };
    }
    return { kind: 'report', format: json.method, json };
  }
  if (signals.isPrompt) return { kind: 'prompt', reasons: signals.reasons };
  if (t.trim().length < 400) return { kind: 'too_short', reasons: ['under 400 characters; does not look like a full report'] };
  return { kind: 'report', format: 'prose', json };
}

// ---------------------------------------------------------------------------
// Prose extraction (conservative)

const LABELS = [
  ['diagnostic', 'legitimacy', ['legitimacy']],
  ['diagnostic', 'builder_operations', ['builder and operational quality', 'builder & operational quality', 'builder/operational quality', 'builder and operations', 'builder quality', 'operational quality']],
  ['diagnostic', 'product_usefulness', ['product usefulness', 'product utility']],
  ['diagnostic', 'organic_demand', ['organic demand']],
  ['diagnostic', 'credit_risk_transparency', ['credit-risk transparency', 'credit risk transparency']],
  ['diagnostic', 'technical_risk_transparency', ['technical-risk transparency', 'technical risk transparency']],
  ['diagnostic', 'protocol_risk_transparency', ['protocol-risk transparency', 'protocol risk transparency']],
  ['diagnostic', 'differentiation', ['competitive differentiation', 'differentiation']],
  ['diagnostic', 'category_potential', ['category potential']],
  ['shared', 'token_value_capture', ['token value capture', 'token value-capture']],
  ['diagnostic', 'valuation_supply_attractiveness', ['valuation and supply attractiveness', 'valuation & supply attractiveness', 'valuation/supply attractiveness']],
  ['diagnostic', 'chart_quality', ['chart quality']],
  ['diagnostic', 'evidence_confidence', ['evidence confidence']],
  ['component', 'sustainable_business_demand', ['sustainable business demand']],
  ['component', 'valuation_supply', ['valuation and supply', 'valuation & supply', 'valuation/supply']],
  ['component', 'risk_resilience', ['risk resilience']],
  ['component', 'btc_relative_asymmetry', ['btc-relative asymmetry', 'btc relative asymmetry', 'asymmetry vs btc', 'asymmetry vs. btc', 'asymmetry versus btc']],
  ['component', 'timing_executable_liquidity', ['timing and executable liquidity', 'timing & executable liquidity', 'timing/executable liquidity']],
  ['risk', 'credit', ['credit risk']],
  ['risk', 'dilution', ['dilution risk']],
  ['risk', 'liquidity', ['liquidity risk']],
  ['risk', 'overall_downside', ['overall downside risk', 'downside risk']],
  ['overall', 'overall', ['overall investment grade', 'overall score', 'overall grade', 'final score', 'final grade', 'composite score', 'weighted total', 'weighted score', 'total score', 'investment grade']],
];
const PHRASES = LABELS.flatMap(([panel, id, phrases]) => phrases.map((p) => ({ panel, id, phrase: p })))
  .sort((a, b) => b.phrase.length - a.phrase.length);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const PHRASE_RES = PHRASES.map((p) => ({ ...p, re: new RegExp(`(^|[^a-z0-9])(${escapeRe(p.phrase)})(?=$|[^a-z0-9])`, 'g') }));

function findLabels(line) {
  const lower = line.toLowerCase();
  const taken = new Array(lower.length).fill(false);
  const hits = [];
  for (const p of PHRASE_RES) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(lower))) {
      const start = m.index + m[1].length;
      const end = start + m[2].length;
      if (taken.slice(start, end).some(Boolean)) continue;
      for (let i = start; i < end; i++) taken[i] = true;
      hits.push({ panel: p.panel, id: p.id, start, end });
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

const NUM = '(\\d{1,3}(?:\\.\\d+)?)';
const AFTER_LABEL = new RegExp(`^\\s*(?:score|rating|grade)?\\s*(?:[:=|]|[–—-]|\\bis\\b)?\\s*${NUM}(?:\\s*(?:–|—|-|to)\\s*${NUM})?\\s*(\\/\\s*100(?!\\d)|\\/\\s*10(?!\\d)|out of 100|%)?`, 'i');
const CELL_SCORE = new RegExp(`^${NUM}(?:\\s*(?:–|—|-|to)\\s*${NUM})?\\s*(\\/\\s*100|\\/\\s*10|out of 100|%)?$`, 'i');

function toCandidate(m) {
  if (!m) return null;
  const suffix = (m[3] || '').replace(/\s+/g, '').toLowerCase();
  if (suffix === '%') return { skip: true };
  const a = Number(m[1]);
  const b = m[2] !== undefined ? Number(m[2]) : null;
  if (suffix === '/10') return { scale10: true, raw: m[0].trim() };
  if (a < 1 || a > 100 || (b !== null && (b < 1 || b > 100 || b < a))) return null;
  return b === null ? { status: 'scored', value: a } : { status: 'range', low: a, high: b };
}

function stripEmphasis(s) {
  return s.replace(/[*_`]/g, '');
}

function isTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
}

function isHeading(line, next) {
  if (/^\s{0,3}#{1,6}\s+\S/.test(line)) return true;
  if (/^\s*\*\*[^*]{3,90}\*\*\s*:?\s*$/.test(line)) return true;
  if (/^\s*[A-Z][A-Za-z0-9 ,&/()'-]{2,70}:\s*$/.test(line)) return true;
  if (isTableRow(line) && next !== undefined && isTableSeparator(next)) return true;
  return false;
}

function headingContext(line) {
  const h = line.toLowerCase();
  if (/(downside|risk panel|risk score|risk assessment|risk rating)/.test(h) && !/resilience/.test(h)) return 'risk';
  if (/(investment grade|investment component|weighted|six component|components|composite)/.test(h)) return 'component';
  if (/(diagnostic|scorecard|category score|categories|project score)/.test(h)) return 'diagnostic';
  return null;
}

function excerpt(line) {
  const t = line.trim();
  return t.length > 160 ? `${t.slice(0, 157)}...` : t;
}

const LIST_HEADINGS = [
  ['bullish_facts', /(strongest bullish|bullish facts|top bullish|bullish points|bull points)/],
  ['bearish_facts', /(strongest bearish|bearish facts|top bearish|bearish points|bear points)/],
  ['conviction_increases', /(increase (my |your )?conviction|conviction increase|raise conviction|would increase conviction)/],
  ['invalidators', /(invalidat)/],
  ['unresolved_questions', /(unresolved|open questions|key questions|unknowns)/],
];

function extractProse(text) {
  const lines = text.split(/\r?\n/);
  const candidates = new Map(); // key panel:id -> [{score, line, excerpt, context}]
  const ambiguous = [];
  const lists = {};
  let context = null;
  let listField = null;
  let finalTake = null;
  let nextMetric = null;
  let paragraphTarget = null;

  const add = (panel, id, cand, lineNo, raw) => {
    const key = `${panel}:${id}`;
    if (!candidates.has(key)) candidates.set(key, []);
    candidates.get(key).push({ cand, line: lineNo, excerpt: excerpt(raw) });
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripEmphasis(raw);
    if (isHeading(raw, lines[i + 1])) {
      const ctx = headingContext(line);
      const lower = line.toLowerCase();
      if (!isTableRow(raw)) {
        context = ctx;
        listField = null;
        paragraphTarget = null;
        for (const [field, re] of LIST_HEADINGS) if (re.test(lower)) listField = field;
        if (/(final take|independent take|bottom line)/.test(lower)) paragraphTarget = 'final_take';
        if (/(next metric|single metric|metric to monitor)/.test(lower)) paragraphTarget = 'next_metric';
      } else if (ctx) {
        context = ctx;
      }
    } else if (listField) {
      const b = raw.match(/^\s*(?:[-*•]|\d+[.)])\s+(.+)$/);
      if (b) {
        lists[listField] = lists[listField] || [];
        if (lists[listField].length < 10) lists[listField].push({ text: stripEmphasis(b[1]).trim(), line: i + 1 });
      }
    } else if (paragraphTarget && raw.trim()) {
      const value = stripEmphasis(raw.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')).trim();
      if (paragraphTarget === 'final_take' && !finalTake) finalTake = { text: value, line: i + 1 };
      if (paragraphTarget === 'next_metric' && !nextMetric) nextMetric = { text: value, line: i + 1 };
      paragraphTarget = null;
    }
    const inlineFinal = raw.match(/^\s*(?:[-*]\s*)?\**\s*(final take|independent final take|next metric to monitor|single next metric)\s*\**\s*[:–—-]\s*(.+)$/i);
    if (inlineFinal) {
      const value = stripEmphasis(inlineFinal[2]).trim();
      if (/final/i.test(inlineFinal[1]) && !finalTake) finalTake = { text: value, line: i + 1 };
      if (/metric/i.test(inlineFinal[1]) && !nextMetric) nextMetric = { text: value, line: i + 1 };
    }

    const labels = findLabels(line);
    if (!labels.length) continue;
    if (isTableRow(raw) && !isTableSeparator(raw)) {
      const cells = raw.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => stripEmphasis(c).trim());
      for (const lab of labels) {
        const cellIndex = cells.findIndex((c) => findLabels(c).some((h) => h.id === lab.id && h.panel === lab.panel));
        if (cellIndex === -1) continue;
        let picked = null;
        for (let k = cellIndex + 1; k < Math.min(cells.length, cellIndex + 4); k++) {
          const c = toCandidate(cells[k].match(CELL_SCORE));
          if (!c) continue;
          if (c.skip) continue;
          picked = c;
          break;
        }
        if (picked) handleCandidate(lab, picked, i + 1, raw);
      }
    } else {
      // Prose line: only trust a number directly after each label.
      for (const lab of labels) {
        const rest = line.slice(lab.end, lab.end + 80).replace(/^\s*\((?:\s*weight\s*)?\d{1,3}(?:\.\d+)?\s*%\s*\)/i, '');
        const c = toCandidate(rest.match(AFTER_LABEL));
        if (c && !c.skip) handleCandidate(lab, c, i + 1, raw);
      }
    }
  }

  function handleCandidate(lab, cand, lineNo, raw) {
    let panel = lab.panel;
    if (panel === 'shared') {
      if (context === 'diagnostic' || context === 'component') panel = context;
      else {
        ambiguous.push({ field: `token_value_capture`, reason: 'Appears without a clear diagnostic or investment-component section', line: lineNo, excerpt: excerpt(raw) });
        return;
      }
    }
    if (cand.scale10) {
      ambiguous.push({ field: `${panel}.${lab.id}`, reason: `Score appears to use a 10-point scale (${cand.raw}); not converted`, line: lineNo, excerpt: excerpt(raw) });
      return;
    }
    add(panel, lab.id, cand, lineNo, raw);
  }

  const scores = { diagnostic: {}, component: {}, risk: {}, overall: {} };
  for (const [key, list] of candidates) {
    const [panel, id] = key.split(':');
    const distinct = new Map();
    for (const c of list) distinct.set(JSON.stringify(c.cand), c);
    if (distinct.size === 1) {
      const c = list[0];
      scores[panel][id] = { ...c.cand, line: c.line, excerpt: c.excerpt };
    } else {
      ambiguous.push({
        field: `${panel}.${id}`,
        reason: `Found ${distinct.size} different values`,
        candidates: [...distinct.values()].map((c) => ({ value: c.cand, line: c.line, excerpt: c.excerpt })),
      });
    }
  }

  // Verdict: exactly one distinct label, or exactly one on lines that mention "verdict".
  const verdictHits = [];
  lines.forEach((l, i) => {
    const n = normVerdictText(l);
    for (const [norm, v] of VERDICT_NORM) if (n.includes(norm)) verdictHits.push({ verdict: v, line: i + 1, mentionsVerdict: /verdict/i.test(l), excerpt: excerpt(l) });
  });
  let verdict = null;
  const distinctVerdicts = [...new Set(verdictHits.map((h) => h.verdict))];
  if (distinctVerdicts.length === 1) verdict = verdictHits[0];
  else if (distinctVerdicts.length > 1) {
    const onVerdictLines = [...new Set(verdictHits.filter((h) => h.mentionsVerdict).map((h) => h.verdict))];
    if (onVerdictLines.length === 1) verdict = verdictHits.find((h) => h.mentionsVerdict);
    else ambiguous.push({ field: 'verdict', reason: `Mentions ${distinctVerdicts.length} different verdict labels`, candidates: distinctVerdicts.map((v) => ({ value: v })) });
  }

  // Header facts in the first 40 lines: analysis date, horizon, model.
  const head = lines.slice(0, 40);
  const dates = new Map();
  const horizonHits = new Map();
  let model = null;
  head.forEach((l, i) => {
    const plain = stripEmphasis(l);
    const d = plain.match(/(analysis date|date of analysis|date|as of|as-of|prepared|dated)\s*[:\-–]?\s*(\d{4}-\d{2}-\d{2})/i);
    if (d) dates.set(d[2], { value: d[2], line: i + 1, excerpt: excerpt(l) });
    const h = plain.match(/(horizon|holding period)\s*[:\-–]\s*([^\n.;|]{2,40})/i);
    if (h) horizonHits.set(h[2].trim().toLowerCase(), { value: h[2].trim(), line: i + 1, excerpt: excerpt(l) });
    const mv = plain.match(/^\s*(?:[-*]\s*)?(model|model version|generated by)\s*[:\-–]\s*(.{2,60})$/i);
    if (mv && !model) model = { value: mv[2].trim(), line: i + 1, excerpt: excerpt(l) };
  });
  const single = (map, field) => {
    if (map.size === 1) return [...map.values()][0];
    if (map.size > 1) ambiguous.push({ field, reason: `Found ${map.size} different values`, candidates: [...map.values()] });
    return null;
  };

  return {
    scores,
    ambiguous,
    verdict,
    analysis_at: single(dates, 'analysis_at'),
    horizon: single(horizonHits, 'horizon'),
    model_version: model,
    lists,
    final_take: finalTake,
    next_metric: nextMetric,
  };
}

// ---------------------------------------------------------------------------
// Normalization against the rubric

// Horizon as an interval in months (audit F12). "12-24 months" stays a range and
// is never collapsed to its upper end; "up to 24 months" is 0-24. Text that
// cannot be read is kept raw and is not comparable.
const H_NUM = '(\\d+(?:\\.\\d+)?)';
const H_UNIT = '(years?|yrs?|y|months?|mos?|mo|m|weeks?|wks?|w|days?|d)\\b';

function monthsPer(unit) {
  if (/^y/.test(unit)) return 12;
  if (/^w/.test(unit)) return 12 / 52;
  if (/^d/.test(unit)) return 12 / 365;
  return 1;
}

function roundMonths(x) {
  return Math.round(x * 10) / 10;
}

function parseHorizon(h) {
  if (!h || typeof h !== 'string' || !h.trim()) return null;
  const raw = h.trim();
  const s = raw.toLowerCase().replace(/[–—]/g, '-');
  let m = s.match(new RegExp(`${H_NUM}\\s*(?:${H_UNIT})?\\s*(?:-|to)\\s*${H_NUM}\\s*${H_UNIT}`));
  if (m) {
    const u2 = m[4];
    const u1 = m[2] || u2;
    const lo = roundMonths(Number(m[1]) * monthsPer(u1));
    const hi = roundMonths(Number(m[3]) * monthsPer(u2));
    if (lo <= hi) return { raw, low_months: lo, high_months: hi, kind: lo === hi ? 'point' : 'range' };
  }
  m = s.match(new RegExp(`(?:up to|within|at most|max(?:imum)?|<=?)\\s*${H_NUM}\\s*${H_UNIT}`));
  if (m) return { raw, low_months: 0, high_months: roundMonths(Number(m[1]) * monthsPer(m[2])), kind: 'up_to' };
  m = s.match(new RegExp(`${H_NUM}\\s*-?\\s*${H_UNIT}`));
  if (m) {
    const v = roundMonths(Number(m[1]) * monthsPer(m[2]));
    return { raw, low_months: v, high_months: v, kind: 'point' };
  }
  return { raw, low_months: null, high_months: null, kind: 'unknown' };
}

function horizonKey(p) {
  if (!p || p.low_months === null || p.low_months === undefined) return null;
  return p.low_months === p.high_months ? `${p.low_months}m` : `${p.low_months}-${p.high_months}m`;
}

function normalizeHorizon(h) {
  const p = parseHorizon(h);
  if (!p) return null;
  return horizonKey(p) || p.raw.toLowerCase().replace(/\s+/g, ' ');
}

// Structural citation check (audit F14): every reference must resolve to a
// listed source or claim, and IDs must be unique. This says nothing about
// whether a source supports a claim; that is corroboration, tracked separately.
function citationIntegrity(a) {
  const issues = [];
  if (!a || typeof a !== 'object') return { status: 'none', issues, counts: { sources: 0, claims: 0, dangling: 0, duplicates: 0 } };
  const sources = Array.isArray(a.sources) ? a.sources : [];
  const claims = Array.isArray(a.claims) ? a.claims : [];
  const ids = (arr, key, label) => {
    const seen = new Map();
    arr.forEach((x, i) => {
      const k = x && x[key];
      if (!k) return;
      if (seen.has(k)) issues.push({ kind: 'duplicate_id', path: `${label}[${i}].${key}`, id: k, first: `${label}[${seen.get(k)}]` });
      else seen.set(k, i);
    });
    return new Set(seen.keys());
  };
  const sourceIds = ids(sources, 'source_id', 'sources');
  const claimIds = ids(claims, 'claim_id', 'claims');
  claims.forEach((c, i) => (Array.isArray(c.source_ids) ? c.source_ids : []).forEach((sid, j) => {
    if (!sourceIds.has(sid)) issues.push({ kind: 'dangling_source_ref', path: `claims[${i}].source_ids[${j}]`, id: sid });
  }));
  for (const group of ['diagnostic_scores', 'investment_components', 'risk_scores']) {
    for (const [k, s] of Object.entries(a[group] || {})) {
      ((s && s.evidence_refs) || []).forEach((ref, j) => {
        if (!claimIds.has(ref) && !sourceIds.has(ref)) issues.push({ kind: 'dangling_evidence_ref', path: `${group}.${k}.evidence_refs[${j}]`, id: ref });
      });
    }
  }
  const listRefs = ['bullish_facts', 'bearish_facts', 'conviction_increases', 'invalidators', 'catalysts', 'unlocks', 'tokenomics_changes'];
  for (const list of listRefs) {
    (Array.isArray(a[list]) ? a[list] : []).forEach((f, i) => ((f && f.claim_ids) || []).forEach((cid, j) => {
      if (!claimIds.has(cid)) issues.push({ kind: 'dangling_claim_ref', path: `${list}[${i}].claim_ids[${j}]`, id: cid });
    }));
  }
  for (const [k, m] of Object.entries(a.economics || {})) {
    ((m && m.claim_ids) || []).forEach((cid, j) => {
      if (!claimIds.has(cid)) issues.push({ kind: 'dangling_claim_ref', path: `economics.${k}.claim_ids[${j}]`, id: cid });
    });
  }
  for (const ref of require('./position').contextRefs(a.position_context)) {
    if (!claimIds.has(ref.id) && !sourceIds.has(ref.id)) issues.push({ kind: 'dangling_evidence_ref', path: ref.path, id: ref.id });
  }
  const uncited = claims.filter((c) => ['V', 'C'].includes(c.evidence_tag) && !(c.source_ids || []).length).length;
  const dangling = issues.filter((x) => x.kind !== 'duplicate_id').length;
  const duplicates = issues.filter((x) => x.kind === 'duplicate_id').length;
  return {
    status: !claims.length && !sources.length ? 'none' : issues.length ? 'issues' : 'valid',
    issues,
    counts: { sources: sources.length, claims: claims.length, dangling, duplicates, uncited_checked_or_claimed: uncited },
    note: 'Structural check only: references resolve to listed sources and claims. It does not mean the sources support the claims.',
  };
}

// Provider identity claims written in the content itself (audit F15).
function detectProviderClaim(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return null;
  const hits = [];
  if (/claude|anthropic/.test(s)) hits.push('claude');
  if (/chatgpt|openai|\bgpt[-\s]?\d|\bgpt\b/.test(s)) hits.push('chatgpt');
  if (/gemini|google deepmind|\bbard\b/.test(s)) hits.push('gemini');
  return hits.length === 1 ? hits[0] : null;
}

function declaredProviderClaims(text) {
  const head = String(text || '').split(/\r?\n/).slice(0, 60);
  const hits = [];
  head.forEach((l, i) => {
    const plain = l.replace(/[*_`]/g, '');
    const m = plain.match(/^\s*(?:[-*•]\s*)?(?:model|model version|ai model|generated by|provider|assistant|written by|analysis by|analyst|produced by|prepared by)\s*[:\-–—]\s*(.{2,100})$/i);
    if (!m) return;
    const p = detectProviderClaim(m[1]);
    if (p) hits.push({ provider: p, line: i + 1, excerpt: plain.trim().slice(0, 160) });
  });
  return hits;
}

function asList(arr, issues, field) {
  if (arr === undefined || arr === null) return [];
  if (!Array.isArray(arr)) {
    issues.push({ severity: 'warning', field, message: 'expected a list' });
    return [];
  }
  return arr
    .map((x) => (typeof x === 'string' ? { text: x, claim_ids: [] } : x))
    .filter((x) => x && typeof x.text === 'string' && x.text.trim())
    .map((x) => ({ text: x.text.trim(), claim_ids: Array.isArray(x.claim_ids) ? x.claim_ids.filter((c) => typeof c === 'string') : [] }));
}

function normTag(t) {
  const s = String(t || '').replace(/[[\]\s]/g, '').toUpperCase();
  return EVIDENCE_TAGS[s] ? s : null;
}

function safeUrl(u) {
  if (typeof u !== 'string' || !u.trim()) return null;
  try {
    const url = new URL(u.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch (_) {
    return null;
  }
}

function normalizeAssessment(ws, raw, { prose = null, format, provider }) {
  const issues = [];
  const { profiles } = ws.rubrics;
  const r = raw || {};
  const declaredProfile = typeof r.sector_profile === 'string' ? r.sector_profile.trim() : null;
  const profile = declaredProfile ? profiles[declaredProfile] || null : null;
  if (format !== 'prose' && !declaredProfile) issues.push({ severity: 'warning', field: 'sector_profile', message: 'No sector profile declared; this report cannot be compared until one is set.' });
  if (declaredProfile && !profile) issues.push({ severity: 'warning', field: 'sector_profile', message: `Unknown sector profile "${declaredProfile}"; kept as written, not comparable with known profiles.` });
  const rubricVersion = typeof r.rubric_version === 'string' ? r.rubric_version.trim() : null;
  if (format !== 'prose' && !rubricVersion) issues.push({ severity: 'warning', field: 'rubric_version', message: 'No rubric version declared; not comparable and no app grade until set.' });
  // Components and risk scores are read against the rubric the report declares.
  // An unknown rubric keeps its raw scores but never gets an app grade (F05).
  const declaredGrading = rubricVersion ? ws.rubrics.gradingVersions[rubricVersion] || null : null;
  if (rubricVersion && !declaredGrading) {
    issues.push({ severity: 'warning', field: 'rubric_version', message: `Rubric "${rubricVersion}" is not a known rubric version. Its scores are kept as written; no app grade is calculated and it is only compared with reports using the same rubric.` });
  }
  const grading = declaredGrading || ws.rubrics.grading;

  const take = (rawScore, field) => {
    const { score, errors, warnings } = normalizeScore(rawScore, field);
    for (const e of errors) issues.push({ severity: 'error', field, message: e });
    for (const w of warnings) issues.push({ severity: 'warning', field, message: w });
    return score;
  };

  // Diagnostic panel
  const diagnostic = {};
  const diagnosticExtra = {};
  const rawDiag = r.diagnostic_scores && typeof r.diagnostic_scores === 'object' ? r.diagnostic_scores : {};
  const proseDiag = prose ? prose.scores.diagnostic : {};
  const fromProse = (p) => ({
    status: p.status,
    value: p.value ?? null,
    low: p.low ?? null,
    high: p.high ?? null,
    rationale: null,
    evidence_refs: [],
    missing_data: null,
    extraction: { method: 'prose', line: p.line, excerpt: p.excerpt },
  });
  if (profile) {
    for (const cat of profile.diagnostic_categories) {
      const field = `diagnostic_scores.${cat.id}`;
      let s = rawDiag[cat.id] !== undefined ? take(rawDiag[cat.id], field) : null;
      if (!s && proseDiag[cat.id]) s = take(fromProse(proseDiag[cat.id]), field);
      if (!s) {
        s = cat.applicable === false ? emptyScore('not_applicable', cat.na_reason || `Not applicable under ${profile.profile_ref}`) : emptyScore('unknown', 'Not provided in the report; not inferred.');
        if (cat.applicable !== false) issues.push({ severity: 'warning', field, message: 'not provided' });
      } else if (cat.applicable === false && s.status !== 'not_applicable') {
        issues.push({ severity: 'warning', field, message: `Scored, but ${cat.label} is not applicable under ${profile.profile_ref}; shown, excluded from comparison.` });
      }
      diagnostic[cat.id] = s;
    }
    for (const [k, v] of Object.entries(rawDiag)) {
      if (!profile.diagnostic_categories.some((c) => c.id === k)) {
        diagnosticExtra[k] = take(v, `diagnostic_scores.${k}`);
        issues.push({ severity: 'warning', field: `diagnostic_scores.${k}`, message: `Not a category of ${profile.profile_ref}; kept, not compared.` });
      }
    }
  } else {
    const keys = new Set([...Object.keys(rawDiag), ...Object.keys(proseDiag)]);
    for (const k of keys) {
      const field = `diagnostic_scores.${k}`;
      diagnostic[k] = rawDiag[k] !== undefined ? take(rawDiag[k], field) : take(fromProse(proseDiag[k]), field);
    }
  }

  // Investment components (always the six from the grading rubric)
  const components = {};
  const rawComp = r.investment_components && typeof r.investment_components === 'object' ? r.investment_components : {};
  const proseComp = prose ? prose.scores.component : {};
  for (const c of grading.investment_components) {
    const field = `investment_components.${c.id}`;
    let s = rawComp[c.id] !== undefined ? take(rawComp[c.id], field) : null;
    if (!s && proseComp[c.id]) s = take(fromProse(proseComp[c.id]), field);
    if (!s) {
      s = emptyScore('unknown', 'Not provided in the report; not inferred from prose or diagnostic scores.');
      issues.push({ severity: 'warning', field, message: 'not provided' });
    }
    components[c.id] = s;
  }
  for (const k of Object.keys(rawComp)) {
    if (grading.investment_components.some((c) => c.id === k)) continue;
    if (!declaredGrading && rubricVersion) {
      // Unknown rubric: keep its own components as written (not graded).
      components[k] = take(rawComp[k], `investment_components.${k}`);
    } else {
      issues.push({ severity: 'warning', field: `investment_components.${k}`, message: `Not a component of ${grading.rubric_ref}; ignored.` });
    }
  }

  // Risk panel (higher = more risk)
  const risk = {};
  const rawRisk = r.risk_scores && typeof r.risk_scores === 'object' ? r.risk_scores : {};
  const proseRisk = prose ? prose.scores.risk : {};
  for (const rd of grading.risk_scores) {
    const field = `risk_scores.${rd.id}`;
    let s = rawRisk[rd.id] !== undefined ? take(rawRisk[rd.id], field) : null;
    if (!s && proseRisk[rd.id]) s = take(fromProse(proseRisk[rd.id]), field);
    if (!s) {
      const creditNa = rd.id === 'credit' && profile && profile.risk_applicability && profile.risk_applicability.credit === false;
      s = creditNa ? emptyScore('not_applicable', profile.risk_applicability.credit_na_reason || `Not applicable under ${profile.profile_ref}`) : emptyScore('unknown', 'Not provided in the report.');
      if (!creditNa) issues.push({ severity: 'warning', field, message: 'not provided' });
    }
    risk[rd.id] = s;
  }

  let overall = r.model_reported_overall_score !== undefined ? take(r.model_reported_overall_score, 'model_reported_overall_score') : null;
  if (!overall && prose && prose.scores.overall.overall) overall = take(fromProse(prose.scores.overall.overall), 'model_reported_overall_score');
  if (!overall) overall = emptyScore('unknown', 'The report gives no overall score of its own.');

  // Verdict
  let verdict = null;
  let verdictRaw = r.verdict ?? null;
  if (verdictRaw) {
    verdict = matchVerdict(verdictRaw);
    if (!verdict) issues.push({ severity: 'error', field: 'verdict', message: `"${verdictRaw}" is not one of the six verdict labels; kept as written.` });
  } else if (prose && prose.verdict) {
    verdict = prose.verdict.verdict;
    verdictRaw = prose.verdict.verdict;
  }

  // Sources and claims
  const sources = (Array.isArray(r.sources) ? r.sources : []).filter((s) => s && typeof s === 'object').map((s, i) => {
    const url = safeUrl(s.url);
    if (s.url && !url) issues.push({ severity: 'warning', field: `sources[${i}].url`, message: `Not a usable http(s) URL: ${String(s.url).slice(0, 80)}` });
    return {
      source_id: String(s.source_id || `S${i + 1}`),
      url,
      url_raw: s.url && !url ? String(s.url) : undefined,
      title: s.title || null,
      publisher: s.publisher || null,
      source_type: s.source_type || null,
      accessed_at: s.accessed_at || null,
    };
  });
  const claims = (Array.isArray(r.claims) ? r.claims : []).filter((c) => c && typeof c === 'object' && c.text).map((c, i) => {
    const tag = normTag(c.evidence_tag);
    if (!tag) issues.push({ severity: 'warning', field: `claims[${i}].evidence_tag`, message: `Unknown evidence tag ${JSON.stringify(c.evidence_tag)}; kept as written.` });
    return {
      claim_id: String(c.claim_id || `C${i + 1}`),
      text: String(c.text),
      evidence_tag: tag,
      evidence_tag_raw: c.evidence_tag ?? null,
      source_ids: Array.isArray(c.source_ids) ? c.source_ids.map(String) : [],
      metric_id: c.metric_id || null,
      value: typeof c.value === 'number' && Number.isFinite(c.value) ? c.value : null,
      unit: c.unit || null,
      definition: c.definition || null,
      period: c.period || null,
      as_of: c.as_of || null,
      limitation: c.limitation || null,
      section: c.section || null,
    };
  });

  // Scenarios
  let scenarios = null;
  if (r.scenarios && typeof r.scenarios === 'object') {
    const items = (Array.isArray(r.scenarios.items) ? r.scenarios.items : []).filter((s) => s && typeof s === 'object');
    const probs = items.map((s) => s.probability_pct);
    const allProbs = items.length > 0 && probs.every((p) => typeof p === 'number' && Number.isFinite(p));
    const total = allProbs ? Math.round(probs.reduce((a, b) => a + b, 0) * 100) / 100 : null;
    const check = !items.length
      ? { status: 'none', message: 'No scenarios given.' }
      : !allProbs
        ? { status: 'incomplete', message: 'Not every scenario has a probability.' }
        : Math.abs(total - 100) <= 0.01
          ? { status: 'ok', total, message: 'Probabilities total 100%.' }
          : { status: 'invalid', total, message: `Probabilities total ${total}%, not 100%. Shown as given; not corrected.` };
    if (check.status === 'invalid' || check.status === 'incomplete') issues.push({ severity: 'error', field: 'scenarios', message: check.message });
    if (items.length && !r.scenarios.btc_relative_definition) issues.push({ severity: 'warning', field: 'scenarios.btc_relative_definition', message: 'No definition of BTC-relative return; relative returns are not compared across reports.' });
    scenarios = { btc_relative_definition: r.scenarios.btc_relative_definition || null, items, probability_check: check, label: 'Speculative forecast' };
  }

  const lists = {};
  for (const f of LIST_FIELDS) {
    lists[f] = asList(r[f], issues, f);
    if (!lists[f].length && prose && prose.lists[f]) lists[f] = prose.lists[f].map((x) => ({ text: x.text, claim_ids: [], extraction: { method: 'prose', line: x.line } }));
  }
  let unresolved = Array.isArray(r.unresolved_questions) ? r.unresolved_questions.filter((q) => typeof q === 'string' && q.trim()) : [];
  if (!unresolved.length && prose && prose.lists.unresolved_questions) unresolved = prose.lists.unresolved_questions.map((x) => x.text);

  const economics = {};
  if (r.economics && typeof r.economics === 'object') {
    for (const [k, v] of Object.entries(r.economics)) {
      if (!v || typeof v !== 'object') continue;
      economics[k] = { ...v, evidence_tag: v.evidence_tag ? normTag(v.evidence_tag) : null };
    }
  }

  let analysisAt = typeof r.analysis_at === 'string' && r.analysis_at.trim() ? r.analysis_at.trim() : null;
  let horizon = typeof r.horizon === 'string' && r.horizon.trim() ? r.horizon.trim() : null;
  let modelVersion = typeof r.model_version === 'string' && r.model_version.trim() ? r.model_version.trim() : null;
  const provenance = {};
  if (prose) {
    if (!analysisAt && prose.analysis_at) {
      analysisAt = prose.analysis_at.value;
      provenance.analysis_at = prose.analysis_at;
    }
    if (!horizon && prose.horizon) {
      horizon = prose.horizon.value;
      provenance.horizon = prose.horizon;
    }
    if (!modelVersion && prose.model_version) {
      modelVersion = prose.model_version.value;
      provenance.model_version = prose.model_version;
    }
    if (prose.verdict && !r.verdict) provenance.verdict = { line: prose.verdict.line, excerpt: prose.verdict.excerpt };
  }
  if (analysisAt && Number.isNaN(Date.parse(analysisAt))) {
    issues.push({ severity: 'warning', field: 'analysis_at', message: `"${analysisAt}" is not a readable date; kept as written.` });
  }
  if (!analysisAt) issues.push({ severity: 'warning', field: 'analysis_at', message: 'Analysis date unknown (the import date is not used in its place).' });

  const nextMetric = r.next_metric_to_monitor && typeof r.next_metric_to_monitor === 'object'
    ? r.next_metric_to_monitor
    : prose && prose.next_metric
      ? { metric: prose.next_metric.text, why: null, threshold: null, extraction: { method: 'prose', line: prose.next_metric.line } }
      : null;
  const finalTake = typeof r.final_take === 'string' && r.final_take.trim() ? r.final_take.trim() : prose && prose.final_take ? prose.final_take.text : null;

  // Position-cycle recipe (cr-research-prompt@3): the model's market and timing
  // views, catalyst windows and suggested review date. Scores are untouched.
  const pos = require('./position');
  const position = pos.normalizePositionContext(r.position_context, { catalysts: r.catalysts, promptVersion: typeof r.prompt_version === 'string' ? r.prompt_version.trim() : null, analysisAt, ceiling: pos.policy(ws).planning_ceiling_months });
  for (const i of position.issues) issues.push(i);

  const integrity = citationIntegrity({ sources, claims, diagnostic_scores: diagnostic, investment_components: components, risk_scores: risk, economics, ...lists, catalysts: r.catalysts, unlocks: r.unlocks, tokenomics_changes: r.tokenomics_changes, position_context: position.context });
  for (const i of integrity.issues.slice(0, 60)) {
    issues.push({ severity: 'warning', field: i.path, message: i.kind === 'duplicate_id' ? `Duplicate ID "${i.id}" (first used at ${i.first}).` : `Reference "${i.id}" does not match any listed ${i.kind === 'dangling_source_ref' ? 'source' : 'claim or source'}.` });
  }

  return {
    assessment: {
      research_run_id: typeof r.research_run_id === 'string' ? r.research_run_id : null,
      schema_version: 'cr.assessment.v1',
      source_format: format,
      provider,
      model_self_identification: r.model_self_identification || null,
      model_version: modelVersion,
      model_version_note: r.model_version_note || (modelVersion ? null : 'Not stated in the report.'),
      analysis_at: analysisAt,
      horizon,
      horizon_normalized: normalizeHorizon(horizon),
      horizon_interval: parseHorizon(horizon),
      prompt_version: r.prompt_version || null,
      rubric_version: rubricVersion,
      sector_profile: declaredProfile,
      verdict,
      verdict_raw: verdictRaw,
      summary: typeof r.summary === 'string' ? r.summary : null,
      diagnostic_scores: diagnostic,
      diagnostic_extra: diagnosticExtra,
      investment_components: components,
      model_reported_overall_score: overall,
      risk_scores: risk,
      sources,
      claims,
      ...lists,
      catalysts: Array.isArray(r.catalysts) ? r.catalysts.filter((c) => c && c.title) : [],
      unlocks: Array.isArray(r.unlocks)
        ? r.unlocks.filter((u) => u && typeof u === 'object' && (u.date || u.amount_tokens != null || u.pct_of_supply != null))
        : [],
      tokenomics_changes: Array.isArray(r.tokenomics_changes) ? r.tokenomics_changes.filter((c) => c && c.description) : [],
      economics,
      scenarios,
      next_metric_to_monitor: nextMetric,
      final_take: finalTake,
      unresolved_questions: unresolved,
      sections: r.sections && typeof r.sections === 'object' ? r.sections : null,
      position_context: position.context,
    },
    issues,
    provenance,
  };
}

// Builds the structured record for a classified report.
function buildFromText(ws, { text, classification, provider }) {
  let raw = null;
  let format = classification.format;
  const issues = [];
  let schemaErrors = [];
  if (classification.json && classification.json.obj) {
    raw = classification.json.obj;
    const res = validate(loadSchema(ws, 'report.v1'), raw);
    schemaErrors = res.errors;
    for (const e of res.errors.slice(0, 40)) issues.push({ severity: 'warning', field: 'schema', message: e });
  } else if (classification.json && classification.json.parseErrors && classification.json.parseErrors.length) {
    issues.push({ severity: 'error', field: 'json', message: `A JSON block was present but could not be read: ${classification.json.parseErrors[0]}. Fell back to reading the prose.` });
  }
  const prose = format === 'prose' ? extractProse(text) : null;
  const norm = normalizeAssessment(ws, raw, { prose, format, provider });
  const extraction = {
    method: format,
    schema_valid: raw ? schemaErrors.length === 0 : null,
    issues: [...issues, ...norm.issues],
    ambiguous: prose ? prose.ambiguous : [],
    provenance: norm.provenance,
    note: format === 'prose'
      ? 'Prose report: only explicitly labeled scores directly followed by a number were extracted. Nothing was inferred. Rubric and sector profile are unknown until you set them.'
      : 'Structured JSON block (cr.report.v1).',
  };
  return { raw, assessment: norm.assessment, extraction };
}

// ---------------------------------------------------------------------------
// Corrections (immutable audit entries layered over the original extraction)

const CORRECTABLE = /^(analysis_at|horizon|prompt_version|rubric_version|sector_profile|verdict|summary|model_version|final_take|eligibility|model_reported_overall_score|(diagnostic_scores|investment_components|risk_scores)\.[a-z_]{2,60})$/;

function validateCorrectionValue(ws, field, value, { rubricRef = null } = {}) {
  if (!CORRECTABLE.test(field)) throw new Error(`Field "${field}" cannot be corrected. Allowed: metadata, verdict, eligibility and score fields.`);
  if (/^(diagnostic_scores|investment_components|risk_scores)\./.test(field) || field === 'model_reported_overall_score') {
    const { score, errors } = normalizeScore(value, field);
    if (errors.length || !score) throw new Error(`Invalid score: ${errors.join('; ') || 'empty'}`);
    // Checked against the report's own rubric version, not the active one.
    const grading = (rubricRef && ws.rubrics.gradingVersions[rubricRef]) || ws.rubrics.grading;
    if (field.startsWith('investment_components.')) {
      const id = field.split('.')[1];
      if (!grading.investment_components.some((c) => c.id === id)) throw new Error(`Unknown investment component ${id} in ${grading.rubric_ref}`);
    }
    if (field.startsWith('risk_scores.')) {
      const id = field.split('.')[1];
      if (!grading.risk_scores.some((c) => c.id === id)) throw new Error(`Unknown risk score ${id} in ${grading.rubric_ref}`);
    }
    return score;
  }
  if (field === 'verdict') {
    if (value === null) return null;
    const v = matchVerdict(value);
    if (!v) throw new Error(`Verdict must be one of: ${VERDICTS.join(' / ')}`);
    return v;
  }
  if (field === 'eligibility') {
    if (!value || typeof value !== 'object' || typeof value.excluded !== 'boolean') throw new Error('eligibility must be {"excluded": true|false, "reason": "..."}');
    return { excluded: value.excluded, reason: String(value.reason || '') };
  }
  if (field === 'analysis_at' && value !== null && Number.isNaN(Date.parse(value))) throw new Error('analysis_at must be a date (YYYY-MM-DD)');
  if (value !== null && typeof value !== 'string') throw new Error(`${field} must be text or null`);
  return value;
}

function setPath(obj, field, value) {
  const parts = field.split('.');
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

function getPath(obj, field) {
  return field.split('.').reduce((n, k) => (n && typeof n === 'object' ? n[k] : undefined), obj);
}

// Supported shape for every stored assessment, including PDFs and older
// records, so no view has to guess which fields exist (audit F08).
function completeShape(a) {
  const out = a;
  for (const k of ['sources', 'claims', 'bullish_facts', 'bearish_facts', 'conviction_increases', 'invalidators', 'catalysts', 'unlocks', 'tokenomics_changes', 'unresolved_questions']) {
    if (!Array.isArray(out[k])) out[k] = [];
  }
  for (const k of ['diagnostic_scores', 'investment_components', 'risk_scores', 'economics', 'diagnostic_extra']) {
    if (!out[k] || typeof out[k] !== 'object' || Array.isArray(out[k])) out[k] = {};
  }
  for (const c of out.claims) if (!Array.isArray(c.source_ids)) c.source_ids = [];
  if (out.model_reported_overall_score === undefined) out.model_reported_overall_score = null;
  if (out.scenarios === undefined) out.scenarios = null;
  if (out.verdict === undefined) out.verdict = null;
  if (out.position_context === undefined) out.position_context = null;
  return out;
}

function applyCorrections(assessment, corrections) {
  const out = completeShape(JSON.parse(JSON.stringify(assessment || {})));
  const corrected = [];
  const original = {};
  for (const c of corrections) {
    if (!(c.field in original)) original[c.field] = getPath(assessment || {}, c.field);
    setPath(out, c.field, c.new_value);
    corrected.push(c.field);
  }
  // Horizon is always derived from the (possibly corrected) text.
  out.horizon_normalized = normalizeHorizon(out.horizon);
  out.horizon_interval = parseHorizon(out.horizon);
  out.corrected_fields = [...new Set(corrected)];
  out.original_values = original;
  return out;
}

// ---------------------------------------------------------------------------
// Loading stored reports

function loadReports(ws, projectId) {
  const base = `projects/${projectId}/reports`;
  const out = [];
  for (const id of listDir(ws.abs(base), { dirs: true })) {
    if (!isRecordId(id)) continue;
    const dir = `${base}/${id}`;
    try {
      const meta = readJson(ws.abs(`${dir}/meta.json`), null);
      const record = readJson(ws.abs(`${dir}/report.json`), null);
      if (!meta || !record) {
        out.push({ report_id: id, broken: true, error: 'meta.json or report.json missing' });
        continue;
      }
      const corrections = listDir(ws.abs(`${dir}/corrections`), { dirs: false })
        .filter((f) => f.endsWith('.json'))
        .map((f) => readJson(ws.abs(`${dir}/corrections/${f}`)))
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      const assessment = applyCorrections(record.assessment, corrections);
      const integrity = citationIntegrity(assessment);
      out.push({ report_id: id, dir, meta, record, corrections, assessment, integrity, provenance: provenanceOf(meta, record) });
    } catch (err) {
      out.push({ report_id: id, broken: true, error: err.message });
    }
  }
  return out;
}

// Where a report came from, kept apart from what it says about itself (F15).
// "attested" is only set when an API response carried the provider/model.
function provenanceOf(meta, record) {
  const p = meta.provenance || {};
  const a = (record && record.assessment) || {};
  return {
    inbox_provider: meta.provider,
    channel: p.channel || (meta.provider_source && /assigned/.test(meta.provider_source) ? 'inbox (project assigned by you)' : 'inbox'),
    declared_provider: p.declared_provider !== undefined ? p.declared_provider : (a.model_self_identification ? detectProviderClaim(a.model_self_identification) : null),
    declared_model: p.declared_model !== undefined ? p.declared_model : a.model_version || null,
    attested: p.attested || null,
    self_reported: !p.attested,
    research_run_id: p.research_run_id || a.research_run_id || null,
    prompt_sha256: p.prompt_sha256 || null,
  };
}

function isEligible(r) {
  return !r.broken && !(r.assessment.eligibility && r.assessment.eligibility.excluded);
}

function reportSortKey(r) {
  return `${r.assessment.analysis_at || ''}|${r.meta.imported_at || ''}`;
}

module.exports = {
  VERDICTS,
  EVIDENCE_TAGS,
  SKELETON_SENTINEL,
  matchVerdict,
  classify,
  findReportJson,
  extractProse,
  normalizeAssessment,
  normalizeHorizon,
  parseHorizon,
  horizonKey,
  citationIntegrity,
  detectProviderClaim,
  declaredProviderClaims,
  completeShape,
  provenanceOf,
  buildFromText,
  validateCorrectionValue,
  applyCorrections,
  getPath,
  loadReports,
  isEligible,
  reportSortKey,
  promptSignals,
  safeUrl,
};
