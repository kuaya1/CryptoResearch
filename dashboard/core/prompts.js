'use strict';
// Builds research prompts and grading appendices from the templates and rubrics,
// so every provider receives identical instructions and the same JSON contract.
//
// Versions: cr-research-prompt@1 (original) stays readable for older reports;
// cr-research-prompt@2 added the research run ID, the dated evidence packet and
// the independence instruction. New prompts use cr-research-prompt@3, the
// position-cycle@1 recipe (position.js): an exact calendar horizon inside the
// planning ceiling, market-cycle, timing and review-plan sections, and a
// position_context block in the JSON contract. Scoring is unchanged. A research
// run's prompt is byte-identical for Claude, ChatGPT and Gemini (the provider is
// set by the channel the answer comes back through), and its SHA-256 is recorded.

const path = require('path');
const { readText, sha256, listDir, fileInfo } = require('./fsx');
const { SKELETON_SENTINEL } = require('./reports');
const { PROVIDERS } = require('./workspace');
const { ymdInTz } = require('./dates');

const PROMPT_VERSION_V1 = 'cr-research-prompt@1';
const PROMPT_VERSION = 'cr-research-prompt@2';
const PROMPT_VERSION_V3 = 'cr-research-prompt@3';
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
  if (promptVersion === PROMPT_VERSION_V3) return positionSkeleton(skeleton, { runId, horizon: positionHorizon });
  if (promptVersion !== PROMPT_VERSION_V1) {
    return { schema_version: skeleton.schema_version, report_id: null, research_run_id: runId, ...skeleton };
  }
  return skeleton;
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
// line, which roughly halves the prompt length.
function compactJson(value, indent = '') {
  const flat = JSON.stringify(value);
  if (value === null || typeof value !== 'object' || flat.length <= 220) return flat;
  const next = `${indent}  `;
  if (Array.isArray(value)) return `[\n${value.map((v) => next + compactJson(v, next)).join(',\n')}\n${indent}]`;
  return `{\n${Object.entries(value).map(([k, v]) => `${next}${JSON.stringify(k)}: ${compactJson(v, next)}`).join(',\n')}\n${indent}}`;
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

function componentList(grading) {
  return grading.investment_components.map((c) => `- \`${c.id}\` (${c.label}): ${c.definition}${c.id === 'risk_resilience' ? ' This is a separate judgement and is NOT 100 minus overall downside risk.' : ''}`).join('\n');
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

function buildAppendixV3(ws, profile, { provider = null, projectId = null, project = null, horizon, rubricRef = null, runId = null } = {}) {
  const grading = gradingFor(ws, rubricRef);
  const { RECIPE_ID } = require('./position');
  const template = readText(path.join(ws.root, 'templates', 'grading-appendix.v3.md'));
  const skeleton = buildSkeleton(ws, profile, { provider, projectId, project, horizon: horizon.text, rubricRef: grading.rubric_ref, runId, promptVersion: PROMPT_VERSION_V3, positionHorizon: horizon });
  return fill(template, {
    PROVIDER_VALUE: provider ? `"${provider}"` : '`null` (set by the channel your answer comes back through; do not guess)',
    PROJECT_ID_VALUE: projectId ? `"${projectId}"` : '`null` unless you were given one',
    RUN_ID_VALUE: runId ? `"${runId}"` : '`null`',
    SECTOR_PROFILE: profile.profile_ref,
    RUBRIC_VERSION: grading.rubric_ref,
    PROMPT_VERSION: PROMPT_VERSION_V3,
    RECIPE_ID,
    HORIZON: `"${horizon.text}"`,
    HORIZON_MODE: horizon.mode,
    HORIZON_START: horizon.start_date,
    HORIZON_END: horizon.end_date,
    DIAGNOSTIC_LIST: diagnosticList(profile),
    COMPONENT_LIST: componentList(grading),
    JSON_SKELETON: compactJson(skeleton),
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

function promptValuesV3(ws, project, profile, { horizon, rubricRef, runId, packet, provider, ownerInstructions = null }) {
  const { RECIPE_ID } = require('./position');
  const base = promptValues(ws, project, profile, { horizon: horizon.text, rubricRef, runId, packet, provider });
  const longTerm = horizon.mode === 'long_term';
  return {
    ...base,
    OWNER_FOCUS: ownerFocus(ownerInstructions),
    RECIPE_ID,
    TYPICAL_HOLD: String(horizon.typical_hold_months),
    CEILING: String(horizon.planning_ceiling_months),
    HORIZON_START: horizon.start_date,
    HORIZON_END: horizon.end_date,
    HORIZON_MONTHS: String(horizon.months),
    HORIZON_MODE_TEXT: longTerm ? `a long-term exception beyond the ${horizon.planning_ceiling_months}-month planning ceiling` : `a position horizon inside the ${horizon.planning_ceiling_months}-month planning ceiling`,
    EXCEPTION_LINE: longTerm
      ? horizon.exception_reason
        ? `This run is a long-term exception the owner chose, for this reason: "${String(horizon.exception_reason).replace(/[\r\n]+/g, ' ').slice(0, 600)}". Assess the full interval above, and still give the market-cycle and timing views.`
        : 'This run uses a long-term horizon beyond the planning ceiling; no reason was recorded. Assess the full interval above, and still give the market-cycle and timing views.'
      : 'Longer-term structural merit may be noted in `position_context.long_term_note`. Keep it out of this position assessment.',
    MARKET_SNAPSHOT_LINE: marketSnapshotLine(packet),
    GRADING_APPENDIX: buildAppendixV3(ws, profile, { provider, projectId: project.project_id, project, horizon, rubricRef: base.RUBRIC_VERSION, runId }),
  };
}

// Which prompt a horizon calls for: the position recipe's object, or older text.
function promptVersionFor(horizon) {
  return horizon && typeof horizon === 'object' && horizon.recipe ? PROMPT_VERSION_V3 : PROMPT_VERSION;
}

// General per-provider prompt (projects/<id>/prompts/<provider>.md), dated the
// day it is written. A research run's own prompt is the one to use.
function buildProjectPrompt(ws, project, provider, { horizon = null } = {}) {
  const profile = ws.rubrics.profiles[project.sector_profile];
  if (!profile) throw new Error(`Unknown sector profile ${project.sector_profile}`);
  const pos = require('./position');
  let h;
  try {
    h = pos.resolveRunHorizon(ws, { args: { horizon }, project });
  } catch (_) {
    // A project default that needs a long-term reason never blocks its prompts.
    h = pos.resolveRunHorizon(ws, {});
  }
  const template = readText(path.join(ws.root, 'templates', 'research-prompt.v3.md'));
  return fill(template, promptValuesV3(ws, project, profile, { horizon: h, rubricRef: ws.rubrics.activeRef, runId: null, packet: null, provider }));
}

// The canonical prompt of a research run: identical bytes for every provider.
// A horizon object from position.js gets cr-research-prompt@3; older text gets @2.
function buildRunPrompt(ws, project, { runId, horizon, rubricRef, packet, ownerInstructions = null }) {
  const profile = ws.rubrics.profiles[project.sector_profile];
  if (!profile) throw new Error(`Unknown sector profile ${project.sector_profile}`);
  if (promptVersionFor(horizon) === PROMPT_VERSION_V3) {
    const template = readText(path.join(ws.root, 'templates', 'research-prompt.v3.md'));
    return fill(template, promptValuesV3(ws, project, profile, { horizon, rubricRef, runId, packet, provider: null, ownerInstructions }));
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

module.exports = { PROMPT_VERSION, PROMPT_VERSION_V1, PROMPT_VERSION_V3, DEFAULT_HORIZON, buildSkeleton, buildAppendix, buildAppendixV2, buildAppendixV3, buildProjectPrompt, buildRunPrompt, promptVersionFor, stageProjectPrompts, listPromptFiles };
