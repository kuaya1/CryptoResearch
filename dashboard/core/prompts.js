'use strict';
// Builds research prompts and grading appendices from the templates and rubrics,
// so every provider receives identical instructions and the same JSON contract.
//
// Versions: cr-research-prompt@1 (original) stays readable for older reports;
// cr-research-prompt@2 added the research run ID, the dated evidence packet and
// the independence instruction. New prompts use cr-research-prompt@3, the
// position-cycle@1 recipe (position.js): an exact calendar horizon inside the
// planning ceiling, market-cycle, timing and review-plan sections, and a
// position_context block in the JSON contract. Scoring is unchanged.
// cr-research-prompt@4 (new runs; @3 stays readable) tightens the report
// contract only: the accepted source types with definitions, [V] only from a
// primary source with its date and an excerpt or query, primary sources and
// dates for critical claims (critical_kind), and optional scenario
// probabilities (all three or none, with the reason). Weights and scores are
// unchanged.
// cr-research-prompt@5 (new runs; @3 and @4 stay readable and reproducible) is
// the position thesis prompt: one decision question, six research sections
// (identity, development and code, product, demand and valuation, chart and
// cycle, independent judgment), a summary first, and thirteen category grades.
// It is written for the @2 scoring profiles (their categories and sector
// focus) and the cr.report.v2 format; a profile without a version written for
// it keeps @4. The six weighted components and their weights (cr-grading@1)
// are unchanged, and the category grades never enter the investment grade.
// A research run's prompt is byte-identical for Claude, ChatGPT and Gemini
// (the provider is set by the channel the answer comes back through), and its
// SHA-256 is recorded.

const path = require('path');
const { readText, sha256, listDir, fileInfo } = require('./fsx');
const { SKELETON_SENTINEL } = require('./reports');
const { PROVIDERS } = require('./workspace');
const { ymdInTz } = require('./dates');

const PROMPT_VERSION_V1 = 'cr-research-prompt@1';
const PROMPT_VERSION = 'cr-research-prompt@2';
const PROMPT_VERSION_V3 = 'cr-research-prompt@3';
const PROMPT_VERSION_V4 = 'cr-research-prompt@4';
const PROMPT_VERSION_V5 = 'cr-research-prompt@5';
// The prompts written for the position-cycle recipe.
const POSITION_PROMPTS = new Set([PROMPT_VERSION_V3, PROMPT_VERSION_V4, PROMPT_VERSION_V5]);
const isPositionPrompt = (v) => POSITION_PROMPTS.has(typeof v === 'string' ? v.trim() : v);
// Report-contract rules introduced with @4 (source types, critical claims,
// optional probabilities) hold for @4 and every later position prompt.
const hasV4Contract = (v) => v === PROMPT_VERSION_V4 || v === PROMPT_VERSION_V5;
// A scoring profile says which prompt it was written for. Only a profile
// written for @5 (its thirteen categories and sector focus) gets that prompt.
const writtenForV5 = (profile) => Boolean(profile) && profile.written_for === PROMPT_VERSION_V5;
const DEFAULT_HORIZON = '24 months';

function unknownScore() {
  return {
    status: 'unknown',
    value: null,
    low: null,
    high: null,
    rationale: '',
    evidence_refs: [],
    missing_data: `${SKELETON_SENTINEL}: replace with a score, or explain what is missing.`,
  };
}

// A category grade (cr-research-prompt@5): a score object that also shows its
// confidence, the strongest evidence, the main weakness and what would raise
// or lower it.
function unknownGrade() {
  return {
    status: 'unknown',
    value: null,
    low: null,
    high: null,
    confidence: null,
    rationale: '',
    strongest_evidence: null,
    main_weakness: null,
    would_raise: null,
    would_lower: null,
    evidence_refs: [],
    missing_data: `${SKELETON_SENTINEL}: replace with a score, or explain what is missing.`,
  };
}

function naScore(reason) {
  return { status: 'not_applicable', value: null, low: null, high: null, rationale: reason, evidence_refs: [], missing_data: null };
}

function gradingFor(ws, rubricRef) {
  return (rubricRef && ws.rubrics.gradingVersions[rubricRef]) || ws.rubrics.grading;
}

function buildSkeleton(ws, profile, { provider = null, projectId = null, project = null, horizon = DEFAULT_HORIZON, rubricRef = null, runId = null, promptVersion = PROMPT_VERSION, positionHorizon = null } = {}) {
  const grading = gradingFor(ws, rubricRef);
  const diagnostic = {};
  for (const c of profile.diagnostic_categories) {
    diagnostic[c.id] = c.applicable === false ? naScore(c.na_reason || `Not applicable under ${profile.profile_ref}`) : unknownScore();
  }
  const components = {};
  for (const c of grading.investment_components) components[c.id] = unknownScore();
  const risk = {};
  for (const r of grading.risk_scores) {
    const creditNa = r.id === 'credit' && profile.risk_applicability && profile.risk_applicability.credit === false;
    risk[r.id] = creditNa ? naScore(profile.risk_applicability.credit_na_reason || `Not applicable under ${profile.profile_ref}`) : unknownScore();
  }
  const economics = {};
  for (const f of profile.economics_fields || []) {
    economics[f.id] = { status: 'unknown', value: null, unit: null, period: null, definition: f.definition, as_of: null, evidence_tag: null, claim_ids: [], note: null };
  }
  const fact = () => ({ text: '', claim_ids: [] });
  const skeleton = {
    schema_version: 'cr.report.v1',
    report_id: null,
    project_id: projectId,
    project_name: project ? project.name : null,
    project_symbol: project ? project.symbol || null : null,
    provider,
    model_self_identification: null,
    model_version: null,
    model_version_note: null,
    analysis_at: null,
    horizon,
    prompt_version: promptVersion,
    rubric_version: grading.rubric_ref,
    sector_profile: profile.profile_ref,
    verdict: null,
    summary: null,
    diagnostic_scores: diagnostic,
    investment_components: components,
    model_reported_overall_score: unknownScore(),
    risk_scores: risk,
    sources: [{ source_id: 'S1', url: null, title: null, publisher: null, source_type: null, accessed_at: null }],
    claims: [{ claim_id: 'C1', text: '', evidence_tag: 'V', source_ids: [], metric_id: null, value: null, unit: null, definition: null, period: null, as_of: null, limitation: null, section: null }],
    bullish_facts: [fact(), fact(), fact()],
    bearish_facts: [fact(), fact(), fact()],
    conviction_increases: [fact(), fact(), fact()],
    invalidators: [fact(), fact(), fact()],
    catalysts: [{ title: '', date: null, date_precision: null, kind: null, status: null, claim_ids: [] }],
    unlocks: [{ date: null, amount_tokens: null, pct_of_supply: null, recipient_class: null, note: 'Potential liquid supply, not demonstrated sales.', claim_ids: [] }],
    tokenomics_changes: [{ description: '', status: null, announced_at: null, effective_at: null, claim_ids: [] }],
    economics,
    scenarios: {
      btc_relative_definition: null,
      items: ['bull', 'base', 'bear'].map((c) => ({
        case: c,
        probability_pct: null,
        business_outcome: null,
        token_capture_assumption: null,
        supply_assumption: null,
        price_range_usd: { low: null, high: null },
        btc_assumption: null,
        relative_return_vs_btc_pct: { low: null, high: null },
        invalidation: null,
      })),
    },
    next_metric_to_monitor: { metric: null, why: null, threshold: null },
    final_take: null,
    unresolved_questions: [],
    original_report_reference: { note: 'The written report above this JSON block is the original.' },
  };
  if (promptVersion === PROMPT_VERSION_V5) return positionSkeleton(contractV5(contractV4(skeleton), profile), { runId, horizon: positionHorizon });
  if (promptVersion === PROMPT_VERSION_V4) return positionSkeleton(contractV4(skeleton), { runId, horizon: positionHorizon });
  if (promptVersion === PROMPT_VERSION_V3) return positionSkeleton(skeleton, { runId, horizon: positionHorizon });
  if (promptVersion !== PROMPT_VERSION_V1) {
    return { schema_version: skeleton.schema_version, report_id: null, research_run_id: runId, ...skeleton };
  }
  return skeleton;
}

// cr-research-prompt@4: each claim also says what kind of critical claim it is
// and shows its excerpt or query; scenarios may leave probabilities null with
// the reason.
function contractV4(skeleton) {
  return {
    ...skeleton,
    claims: skeleton.claims.map((c) => ({ ...c, critical_kind: null, excerpt: null, query: null })),
    scenarios: { btc_relative_definition: skeleton.scenarios.btc_relative_definition, probability_note: null, items: skeleton.scenarios.items },
  };
}

// cr-research-prompt@5, in the cr.report.v2 format: every category grade
// carries its confidence, strongest evidence, main weakness and what would
// raise or lower it; the code_review, chart_cycle and independent_judgment
// blocks; each scenario lists the observations it builds on and the claims it
// cites, and price targets may stay null with the reason.
function contractV5(skeleton, profile) {
  const diagnostic = {};
  for (const c of profile.diagnostic_categories) diagnostic[c.id] = c.applicable === false ? skeleton.diagnostic_scores[c.id] : unknownGrade();
  const view = () => ({ view: null, label: null, supporting_evidence: [], disconfirming_test: null });
  const out = {};
  for (const [k, v] of Object.entries(skeleton)) {
    if (k === 'schema_version') {
      out.schema_version = 'cr.report.v2';
    } else if (k === 'diagnostic_scores') {
      out.diagnostic_scores = diagnostic;
    } else if (k === 'scenarios') {
      out.code_review = {
        source_access: 'unknown',
        repositories: [{ url: null, role: null, commit: null, files_inspected: [], observations: null }],
        deployed_link: { status: 'unknown', note: null },
        limitations: null,
      };
      out.chart_cycle = {
        data: { source: null, venue: null, pair: null, timeframes: [], latest_observation_at: null, limitations: null },
        phase: 'unknown',
        phase_rationale: null,
        alternative_reading: null,
        trend_vs_usd: null,
        trend_vs_btc: null,
        levels: [{ kind: null, price_usd: null, timeframe: null, basis: null }],
        volume: { baseline: null, reading: null, confirms_price: null },
        liquidity: null,
        confirmation: [],
        invalidation: [],
        evidence_refs: [],
      };
      out.scenarios = {
        btc_relative_definition: null,
        probability_note: null,
        target_note: null,
        items: ['bear', 'base', 'bull'].map((c) => ({
          case: c,
          probability_pct: null,
          observations: [],
          business_outcome: null,
          token_capture_assumption: null,
          supply_assumption: null,
          btc_assumption: null,
          price_range_usd: { low: null, high: null },
          relative_return_vs_btc_pct: { low: null, high: null },
          invalidation: null,
          claim_ids: [],
        })),
      };
      out.independent_judgment = Object.fromEntries(require('./thesis').JUDGMENT_KEYS.map(([key]) => [key, view()]));
    } else {
      out[k] = v;
    }
  }
  return out;
}

// cr-research-prompt@3: the same contract plus catalyst windows and the
// position_context block, placed before the closing fields.
function positionSkeleton(skeleton, { runId, horizon }) {
  const h = horizon || {};
  const out = { schema_version: skeleton.schema_version, report_id: null, research_run_id: runId };
  for (const [k, v] of Object.entries(skeleton)) {
    if (k === 'schema_version' || k === 'report_id') continue;
    if (k === 'catalysts') {
      out.catalysts = [{ title: '', date: null, date_precision: null, window_start: null, window_end: null, kind: null, status: null, certainty: 'unknown', in_horizon: null, claim_ids: [] }];
      continue;
    }
    if (k === 'final_take') {
      out.position_context = {
        recipe: require('./position').RECIPE_ID,
        horizon: { mode: h.mode || null, start_date: h.start_date || null, end_date: h.end_date || null },
        market: { state: 'unknown', rationale: '', evidence_refs: [] },
        timing: { state: 'unknown', rationale: '', evidence_refs: [], next_review_date: null, review_trigger: null },
        long_term_note: null,
      };
    }
    out[k] = v;
  }
  return out;
}

// Pretty-prints JSON but keeps small objects (each score object, each fact) on one
// line, which roughly halves the prompt length. `limit` is the longest object
// kept on one line: 220 for the prompts up to @4 (their bytes must not change),
// wider for @5, whose category grades carry more fields.
function compactJson(value, indent = '', limit = 220) {
  const flat = JSON.stringify(value);
  if (value === null || typeof value !== 'object' || flat.length <= limit) return flat;
  const next = `${indent}  `;
  if (Array.isArray(value)) return `[\n${value.map((v) => next + compactJson(v, next, limit)).join(',\n')}\n${indent}]`;
  return `{\n${Object.entries(value).map(([k, v]) => `${next}${JSON.stringify(k)}: ${compactJson(v, next, limit)}`).join(',\n')}\n${indent}}`;
}

function fill(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => (key in values ? values[key] : m));
}

function diagnosticList(profile) {
  return profile.diagnostic_categories
    .map((c) => (c.applicable === false
      ? `- \`${c.id}\` (${c.label}): **not_applicable** in ${profile.profile_ref}. ${c.na_reason || ''}`.trim()
      : `- \`${c.id}\` (${c.label}): ${c.definition}`))
    .join('\n');
}

// The prompts up to @4 repeat the risk-resilience note after the definition,
// which already carries it; their bytes must not change. @5 lists each
// definition once (repeatNote: false).
function componentList(grading, { repeatNote = true } = {}) {
  return grading.investment_components.map((c) => `- \`${c.id}\` (${c.label}): ${c.definition}${repeatNote && c.id === 'risk_resilience' ? ' This is a separate judgement and is NOT 100 minus overall downside risk.' : ''}`).join('\n');
}

// Original appendix (v1), kept for reproducing older prompts.
function buildAppendix(ws, profile, { provider = null, projectId = null, project = null, horizon = DEFAULT_HORIZON } = {}) {
  const template = readText(path.join(ws.root, 'templates', 'grading-appendix.v1.md'));
  const skeleton = buildSkeleton(ws, profile, { provider, projectId, project, horizon, promptVersion: PROMPT_VERSION_V1 });
  return fill(template, {
    PROVIDER_VALUE: provider
      ? `"${provider}"`
      : '`null` (the dashboard sets it from the inbox folder you drop the report into: claude, chatgpt or gemini)',
    PROJECT_ID_VALUE: projectId ? `"${projectId}"` : '`null` unless you were given one',
    SECTOR_PROFILE: profile.profile_ref,
    PROMPT_VERSION: project ? PROMPT_VERSION_V1 : 'the version of the prompt you were given, or null',
    HORIZON: horizon,
    DIAGNOSTIC_LIST: diagnosticList(profile),
    JSON_SKELETON: compactJson(skeleton),
  });
}

function buildAppendixV2(ws, profile, { provider = null, projectId = null, project = null, horizon = DEFAULT_HORIZON, rubricRef = null, runId = null } = {}) {
  const grading = gradingFor(ws, rubricRef);
  const template = readText(path.join(ws.root, 'templates', 'grading-appendix.v2.md'));
  const skeleton = buildSkeleton(ws, profile, { provider, projectId, project, horizon, rubricRef: grading.rubric_ref, runId, promptVersion: PROMPT_VERSION });
  return fill(template, {
    PROVIDER_VALUE: provider ? `"${provider}"` : '`null` (set by the channel your answer comes back through; do not guess)',
    PROJECT_ID_VALUE: projectId ? `"${projectId}"` : '`null` unless you were given one',
    RUN_ID_VALUE: runId ? `"${runId}"` : '`null`',
    SECTOR_PROFILE: profile.profile_ref,
    RUBRIC_VERSION: grading.rubric_ref,
    PROMPT_VERSION,
    HORIZON: horizon,
    DIAGNOSTIC_LIST: diagnosticList(profile),
    COMPONENT_LIST: componentList(grading),
    JSON_SKELETON: compactJson(skeleton),
  });
}

function assetList(project) {
  const assets = (project.identity && project.identity.assets) || [];
  if (!assets.length) return 'not recorded';
  return assets.map((a) => `${a.chain}${a.contract_address ? `: ${a.contract_address}` : ''}${a.standard ? ` (${a.standard})` : ''}`).join('; ');
}

function promptValues(ws, project, profile, { horizon, rubricRef, runId, packet, provider }) {
  const grading = gradingFor(ws, rubricRef);
  const identity = project.identity || {};
  const verified = identity.status === 'verified';
  const sections = profile.research_sections.map((s, i) => `${i + 1}. **${s.title}.** ${s.guidance}`).join('\n');
  return {
    PROJECT_NAME: project.name,
    SYMBOL: project.symbol || 'symbol not recorded',
    SECTOR_PROFILE: profile.profile_ref,
    RUBRIC_VERSION: grading.rubric_ref,
    PREPARED_DATE: ymdInTz(),
    RUN_ID: runId || 'none (general prompt)',
    HORIZON: horizon,
    OFFICIAL_WEBSITE: identity.official_website || 'not yet confirmed',
    ASSET_LIST: verified ? assetList(project) : 'NOT CONFIRMED. Do not assume a token; confirm the identity first.',
    COINGECKO_ID: verified ? identity.coingecko_id || 'none recorded' : 'not confirmed',
    IDENTITY_STATUS: verified ? 'verified from recorded evidence' : 'PENDING. The token identity has not been confirmed.',
    PACKET_DATE: packet ? String(packet.captured_at).slice(0, 10) : ymdInTz(),
    EVIDENCE_PACKET: packet ? JSON.stringify(packet, null, 2) : JSON.stringify({ note: 'No dated context packet for this general prompt. Research independently from current sources.' }, null, 2),
    SECTIONS: sections,
    GRADING_APPENDIX: buildAppendixV2(ws, profile, { provider, projectId: project.project_id, project, horizon, rubricRef: grading.rubric_ref, runId }),
  };
}

// The files a position-recipe prompt version is written from.
const POSITION_FILES = {
  [PROMPT_VERSION_V3]: { prompt: 'research-prompt.v3.md', appendix: 'grading-appendix.v3.md' },
  [PROMPT_VERSION_V4]: { prompt: 'research-prompt.v4.md', appendix: 'grading-appendix.v4.md' },
  [PROMPT_VERSION_V5]: { prompt: 'research-prompt.v5.md', appendix: 'grading-appendix.v5.md' },
};
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
// How many category grades a profile asks for, in words ("thirteen").
function categoryCount(profile) {
  const n = profile.diagnostic_categories.filter((c) => c.applicable !== false).length;
  return NUMBER_WORDS[n] || String(n);
}

function buildAppendixV3(ws, profile, { provider = null, projectId = null, project = null, horizon, rubricRef = null, runId = null, version = PROMPT_VERSION_V3 } = {}) {
  const grading = gradingFor(ws, rubricRef);
  const { RECIPE_ID } = require('./position');
  const template = readText(path.join(ws.root, 'templates', (POSITION_FILES[version] || POSITION_FILES[PROMPT_VERSION_V3]).appendix));
  const skeleton = buildSkeleton(ws, profile, { provider, projectId, project, horizon: horizon.text, rubricRef: grading.rubric_ref, runId, promptVersion: version, positionHorizon: horizon });
  return fill(template, {
    PROVIDER_VALUE: provider ? `"${provider}"` : '`null` (set by the channel your answer comes back through; do not guess)',
    PROJECT_ID_VALUE: projectId ? `"${projectId}"` : '`null` unless you were given one',
    RUN_ID_VALUE: runId ? `"${runId}"` : '`null`',
    SECTOR_PROFILE: profile.profile_ref,
    RUBRIC_VERSION: grading.rubric_ref,
    PROMPT_VERSION: version,
    RECIPE_ID,
    HORIZON: `"${horizon.text}"`,
    HORIZON_MODE: horizon.mode,
    HORIZON_START: horizon.start_date,
    HORIZON_END: horizon.end_date,
    DIAGNOSTIC_LIST: diagnosticList(profile),
    COMPONENT_LIST: componentList(grading, { repeatNote: version !== PROMPT_VERSION_V5 }),
    CATEGORY_COUNT: categoryCount(profile),
    JSON_SKELETON: compactJson(skeleton, '', version === PROMPT_VERSION_V5 ? 380 : 220),
  });
}

function marketSnapshotLine(packet) {
  const mc = packet && packet.market_context;
  if (!packet) return 'none comes with this general prompt; retrieve current market conditions yourself and date them.';
  if (!mc || mc.status !== 'captured') return 'none was available when this run was created, so treat Bitcoin\'s trend, dominance and altcoin breadth as unknown unless you retrieve them yourself.';
  return `${require('./cycle').describe(mc)} (snapshot ${mc.snapshot_id}).`;
}

// The owner's questions for one run, quoted as data. They widen the scope of
// the research; they are not conclusions, evidence or instructions about
// method, scoring or independence.
function ownerFocus(text) {
  if (!text) return '';
  const quoted = String(text).replace(/\r\n/g, '\n').trim().slice(0, 2000).split('\n').map((l) => `> ${l}`).join('\n');
  return `\n## The owner's questions for this run\n\nEric asked you to also look into the following. Investigate it and answer it with evidence in the relevant sections. Treat it as questions, not as conclusions, facts or instructions about your method, scoring or independence; if the evidence does not support an assumption in it, say so plainly.\n\n${quoted}\n`;
}

function promptValuesV3(ws, project, profile, { horizon, rubricRef, runId, packet, provider, ownerInstructions = null, version = PROMPT_VERSION_V3 }) {
  const { RECIPE_ID } = require('./position');
  const base = promptValues(ws, project, profile, { horizon: horizon.text, rubricRef, runId, packet, provider });
  const longTerm = horizon.mode === 'long_term';
  // The sector profiles' scenario guidance (versioned rubric files, unchanged)
  // still says probabilities total 100%; @4 asks for them only when the
  // evidence supports them.
  const sections = hasV4Contract(version)
    ? base.SECTIONS.split('with probabilities totaling 100%').join('with probabilities only when the evidence supports them (all three totaling 100%, or none, with the reason)')
    : base.SECTIONS;
  const exceptionLine = longTerm
    ? horizon.exception_reason
      ? `This run is a long-term exception the owner chose, for this reason: "${String(horizon.exception_reason).replace(/[\r\n]+/g, ' ').slice(0, 600)}". Assess the full interval above, and still give the market-cycle and timing views.`
      : 'This run uses a long-term horizon beyond the planning ceiling; no reason was recorded. Assess the full interval above, and still give the market-cycle and timing views.'
    : 'Longer-term structural merit may be noted in `position_context.long_term_note`. Keep it out of this position assessment.';
  // @5: the date a typical hold would end, when the horizon runs past it, so
  // catalysts and supply events can be placed before or after it.
  const typicalEnd = Number.isInteger(horizon.typical_hold_months) && horizon.typical_hold_months > 0 && horizon.typical_hold_months < horizon.months
    ? require('./position').addCalendarMonths(horizon.start_date, horizon.typical_hold_months)
    : null;
  return {
    ...base,
    SECTIONS: sections,
    // @5: what the six research sections also cover for this kind of project,
    // from the scoring profile.
    SECTOR_FOCUS: profile.research_sections.map((s, i) => `- **${i + 1}. ${s.title}.** ${s.guidance}`).join('\n'),
    CATEGORY_COUNT: categoryCount(profile),
    TYPICAL_HOLD_LINE: typicalEnd ? ` A typical hold would end around ${typicalEnd}: say which catalysts and supply events fall before that date, and which only before the end of the horizon.` : '',
    EXCEPTION_BULLET: longTerm ? `\n- ${exceptionLine}` : '',
    OWNER_FOCUS: ownerFocus(ownerInstructions),
    RECIPE_ID,
    TYPICAL_HOLD: String(horizon.typical_hold_months),
    CEILING: String(horizon.planning_ceiling_months),
    HORIZON_START: horizon.start_date,
    HORIZON_END: horizon.end_date,
    HORIZON_MONTHS: String(horizon.months),
    HORIZON_MODE_TEXT: longTerm ? `a long-term exception beyond the ${horizon.planning_ceiling_months}-month planning ceiling` : `a position horizon inside the ${horizon.planning_ceiling_months}-month planning ceiling`,
    EXCEPTION_LINE: exceptionLine,
    MARKET_SNAPSHOT_LINE: marketSnapshotLine(packet),
    GRADING_APPENDIX: buildAppendixV3(ws, profile, { provider, projectId: project.project_id, project, horizon, rubricRef: base.RUBRIC_VERSION, runId, version }),
  };
}

// Which prompt a horizon and a scoring profile call for: the position recipe's
// object gets the current prompt, @5, when the profile is written for it (the
// @2 profiles), and @4 otherwise; older text gets @2.
function promptVersionFor(horizon, profile = null) {
  if (!(horizon && typeof horizon === 'object' && horizon.recipe)) return PROMPT_VERSION;
  return writtenForV5(profile) ? PROMPT_VERSION_V5 : PROMPT_VERSION_V4;
}

// The template a position-recipe prompt version is written from.
const positionTemplate = (version) => (POSITION_FILES[version] || POSITION_FILES[PROMPT_VERSION_V3]).prompt;

// The scoring profile new research on a project uses: the current published
// version of the profile its record names (rubrics.currentProfileRef).
function researchProfile(ws, project) {
  const ref = require('./rubrics').currentProfileRef(ws, project.sector_profile);
  const profile = ws.rubrics.profiles[ref];
  if (!profile) throw new Error(`Unknown sector profile ${project.sector_profile}`);
  return profile;
}

// General per-provider prompt (projects/<id>/prompts/<provider>.md), dated the
// day it is written. A research run's own prompt is the one to use.
function buildProjectPrompt(ws, project, provider, { horizon = null } = {}) {
  const profile = researchProfile(ws, project);
  const pos = require('./position');
  let h;
  try {
    h = pos.resolveRunHorizon(ws, { args: { horizon }, project });
  } catch (_) {
    // A project default that needs a long-term reason never blocks its prompts.
    h = pos.resolveRunHorizon(ws, {});
  }
  const version = promptVersionFor(h, profile);
  const template = readText(path.join(ws.root, 'templates', positionTemplate(version)));
  return fill(template, promptValuesV3(ws, project, profile, { horizon: h, rubricRef: ws.rubrics.activeRef, runId: null, packet: null, provider, version }));
}

// The canonical prompt of a research run: identical bytes for every provider.
// A horizon object from position.js gets the current prompt for the run's
// scoring profile (@5 with a profile written for it, @4 otherwise; version: an
// older one to reproduce an older run's prompt); older text gets @2.
// profileRef: the run's scoring profile; without it, the project record's.
function buildRunPrompt(ws, project, { runId, horizon, rubricRef, packet, ownerInstructions = null, version = null, profileRef = null }) {
  const profile = ws.rubrics.profiles[profileRef || project.sector_profile];
  if (!profile) throw new Error(`Unknown sector profile ${profileRef || project.sector_profile}`);
  const v = version || promptVersionFor(horizon, profile);
  if (v === PROMPT_VERSION_V5 && !writtenForV5(profile)) throw new Error(`${PROMPT_VERSION_V5} needs a scoring profile written for it; ${profile.profile_ref} is not.`);
  if (isPositionPrompt(v)) {
    const template = readText(path.join(ws.root, 'templates', positionTemplate(v)));
    return fill(template, promptValuesV3(ws, project, profile, { horizon, rubricRef, runId, packet, provider: null, ownerInstructions, version: v }));
  }
  const template = readText(path.join(ws.root, 'templates', 'research-prompt.v2.md'));
  return fill(template, promptValues(ws, project, profile, { horizon, rubricRef, runId, packet, provider: null }));
}

// Stages prompts/<provider>.md for each provider into an open operation.
function stageProjectPrompts(ws, op, project, providers = PROVIDERS) {
  const written = [];
  for (const p of providers) {
    const rel = `projects/${project.project_id}/prompts/${p}.md`;
    op.write(rel, buildProjectPrompt(ws, project, p));
    written.push(rel);
  }
  return written;
}

// Every prompt file of a project with its version and hash (audit F22).
function listPromptFiles(ws, projectId) {
  const out = [];
  const walk = (rel) => {
    for (const name of listDir(ws.abs(rel), { dirs: null })) {
      const r = `${rel}/${name}`;
      const info = fileInfo(ws.abs(r));
      if (!info) continue;
      if (info.isDirectory) walk(r);
      else if (name.endsWith('.md')) {
        const text = readText(ws.abs(r), '');
        const m = text.match(/CR-PROMPT\s+(cr-research-prompt@\d+)/) || text.match(/Prompt version:\s*([A-Za-z0-9_.@-]+)/);
        out.push({ rel: r, name: r.replace(`projects/${projectId}/prompts/`, ''), sha256: sha256(text), bytes: info.size, updated_at: new Date(info.mtimeMs).toISOString(), prompt_version: m ? m[1] : null });
      }
    }
  };
  walk(`projects/${projectId}/prompts`);
  return out;
}

module.exports = { PROMPT_VERSION, PROMPT_VERSION_V1, PROMPT_VERSION_V3, PROMPT_VERSION_V4, PROMPT_VERSION_V5, isPositionPrompt, hasV4Contract, DEFAULT_HORIZON, buildSkeleton, buildAppendix, buildAppendixV2, buildAppendixV3, buildProjectPrompt, buildRunPrompt, promptVersionFor, researchProfile, stageProjectPrompts, listPromptFiles };
