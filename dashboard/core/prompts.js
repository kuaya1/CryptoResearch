'use strict';
// Builds research prompts and grading appendices from the templates and rubrics,
// so every provider receives identical instructions and the same JSON contract.
//
// Versions: cr-research-prompt@1 (original) stays readable for older reports;
// new prompts use cr-research-prompt@2, which adds the research run ID, the
// dated evidence packet and the independence instruction. A research run's
// prompt is byte-identical for Claude, ChatGPT and Gemini (the provider is set
// by the channel the answer comes back through), and its SHA-256 is recorded.

const path = require('path');
const { readText, sha256, listDir, fileInfo } = require('./fsx');
const { SKELETON_SENTINEL } = require('./reports');
const { PROVIDERS } = require('./workspace');
const { ymdInTz } = require('./dates');

const PROMPT_VERSION_V1 = 'cr-research-prompt@1';
const PROMPT_VERSION = 'cr-research-prompt@2';
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

function buildSkeleton(ws, profile, { provider = null, projectId = null, project = null, horizon = DEFAULT_HORIZON, rubricRef = null, runId = null, promptVersion = PROMPT_VERSION } = {}) {
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
  if (promptVersion !== PROMPT_VERSION_V1) {
    return { schema_version: skeleton.schema_version, report_id: null, research_run_id: runId, ...skeleton };
  }
  return skeleton;
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

// General per-provider prompt (projects/<id>/prompts/<provider>.md).
function buildProjectPrompt(ws, project, provider, { horizon = null } = {}) {
  const profile = ws.rubrics.profiles[project.sector_profile];
  if (!profile) throw new Error(`Unknown sector profile ${project.sector_profile}`);
  const h = horizon || (project.research_defaults && project.research_defaults.horizon) || ws.settings.research.default_horizon || DEFAULT_HORIZON;
  const template = readText(path.join(ws.root, 'templates', 'research-prompt.v2.md'));
  return fill(template, promptValues(ws, project, profile, { horizon: h, rubricRef: ws.rubrics.activeRef, runId: null, packet: null, provider }));
}

// The canonical prompt of a research run: identical bytes for every provider.
function buildRunPrompt(ws, project, { runId, horizon, rubricRef, packet }) {
  const profile = ws.rubrics.profiles[project.sector_profile];
  if (!profile) throw new Error(`Unknown sector profile ${project.sector_profile}`);
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

module.exports = { PROMPT_VERSION, PROMPT_VERSION_V1, DEFAULT_HORIZON, buildSkeleton, buildAppendix, buildAppendixV2, buildProjectPrompt, buildRunPrompt, stageProjectPrompts, listPromptFiles };
