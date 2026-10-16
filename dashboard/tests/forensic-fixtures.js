'use strict';
// FICTIONAL forensic reports for the tests and the dev desk. Every name,
// address, figure and URL here is invented (example.com / example.org
// hosts, a fictional project); none describes a real project.

const D = require('../core/forensic-defs');

function block(audit, over = {}) {
  const now = over.assessment_as_of || new Date().toISOString();
  return {
    format: D.REPORT_FORMAT,
    forensic_audit_id: audit.audit_id,
    project_id: audit.project_id,
    prompt_version: D.PROMPT_VERSION,
    role: 'investigator',
    model: 'claude',
    model_version: null,
    assessment_as_of: now,
    plain_assessment: 'FICTIONAL. The advertised payment API answers and settles test transfers; the team holds an upgrade key it disclosed. Exit liquidity at $500 is within the limit on one aggregator quote. Delivery is regular.',
    evidence_coverage: { areas: { product: 'covered', code: 'partial', controls: 'covered', allocations: 'partial', wallets: 'unknown', liquidity: 'covered', claims: 'partial' }, notes: 'Wallet tracing not attempted.' },
    strongest_concern: { finding_id: 'F2', statement: 'An upgrade key held by a 2-of-3 multisig can change the token contract.' },
    strongest_counterevidence: { finding_id: 'F1', statement: 'The payment API completed a test transfer end to end.' },
    explanations_compared: [{ explanation: 'The upgrade key exists for scheduled migrations, as disclosed.', supported_by: ['F2'], weakened_by: [], assessment: 'more_likely' }],
    sources: [
      { source_id: 'S1', url: 'https://example.com/xmpl/docs/api', publisher: 'Example PayFi (FICTIONAL)', type: 'primary', retrieved_at: now, excerpt: 'POST /v1/transfers settles within one block.' },
      { source_id: 'S2', url: 'https://example.org/explorer/contract/FICTIONAL', publisher: 'Example explorer', type: 'chain', retrieved_at: now, block_or_commit: 'block 1234567', excerpt: 'Proxy admin: 2-of-3 multisig.' },
      { source_id: 'S3', url: 'https://example.org/aggregator/quote?sell=500', publisher: 'Example aggregator', type: 'secondary', retrieved_at: now, excerpt: 'Sell $500 XMPL: receive 491.20 USDC, route A > B.' },
      { source_id: 'S4', url: 'https://example.com/xmpl/github', publisher: 'Example PayFi', type: 'repository', retrieved_at: now, block_or_commit: 'abc1234', excerpt: 'Release v2.1.0.' },
    ],
    claims: [{ claim_id: 'C1', claim: 'Transfers settle within one block.', made_by_source_id: 'S1' }],
    findings: [
      { finding_id: 'F1', claim_id: 'C1', area: 'product', kind: 'observation', statement: 'A test transfer through the public API settled in one block.', source_ids: ['S1'], retrieved_at: now, severity: 'info', confidence: 'medium', alternative_explanation: null, missing_evidence: 'Volume at scale.', would_confirm: 'Repeated settlement under load.', would_overturn: 'Failed settlements.' },
      { finding_id: 'F2', area: 'controls', kind: 'observation', statement: 'The token is an upgradeable proxy whose admin is a 2-of-3 multisig, disclosed in the docs.', source_ids: ['S2'], retrieved_at: now, block_or_commit: 'block 1234567', severity: 'medium', confidence: 'high', alternative_explanation: 'Scheduled migrations.', missing_evidence: 'Signer identities.', would_confirm: 'An undisclosed upgrade.', would_overturn: 'A renounced admin.' },
      { finding_id: 'F3', area: 'code', kind: 'inference', statement: 'Releases are regular; the settlement module at abc1234 is substantive.', source_ids: ['S4'], block_or_commit: 'abc1234', severity: 'low', confidence: 'medium', missing_evidence: 'Test coverage.', would_confirm: 'A tagged audit.', would_overturn: 'Stub implementations.' },
    ],
    category_grades: {
      product_reality: { score: 72, confidence: 'medium', finding_ids: ['F1'], reason: 'Works at small scale.' },
      disclosure_consistency: { score: 80, confidence: 'medium', finding_ids: ['F2'], reason: 'Upgrade key disclosed.' },
      control_transparency: { score: 65, confidence: 'high', finding_ids: ['F2'], reason: 'Multisig, disclosed.' },
      incentive_alignment: { score: null, confidence: null, finding_ids: [], reason: 'Allocations not traced.' },
      liquidity_resilience: { score: 70, confidence: 'low', finding_ids: ['F1'], reason: 'One quote.' },
      delivery_continuity: { score: 78, confidence: 'medium', finding_ids: ['F3'], reason: 'Regular releases.' },
    },
    liquidity: {
      observations: [
        { obs_id: 'L1', kind: 'executable_quote', source_id: 'S3', venue: 'Example aggregator', chain: 'example-chain', mechanism: 'aggregator', route_scope: 'aggregator', retrieved_at: now, quote: { sell_usd: 500, received_usd: 491.2, fees_usd: 1.5, price_impact_pct: 1.2, gas_usd: 0.4, gas_included: false, route: 'A > B', no_route: false } },
        { obs_id: 'L2', kind: 'pool_reserves', source_id: 'S3', venue: 'Example DEX', chain: 'example-chain', pool: 'XMPL/USDC', mechanism: 'constant_product', retrieved_at: now, base_reserve: 1000000, quote_reserve: 30000, quote_token: 'USDC', quote_usd_price: 1, fee_bps: 30, reported_liquidity_usd: 60000 },
        { obs_id: 'L3', kind: 'pool_reserves', source_id: 'S3', venue: 'Example CL DEX', chain: 'example-chain', pool: 'XMPL/USDC 0.3%', mechanism: 'concentrated', retrieved_at: now, reported_liquidity_usd: 250000 },
      ],
      notes: 'FICTIONAL.',
    },
    operational: { observations: [{ obs_id: 'P1', check: 'Transfer API status', url: 'https://example.com/xmpl/status', observed_at: now, outcome: 'worked', source_id: 'S1' }] },
    delivery: { observations: [{ obs_id: 'R1', repository: 'github.com/example/xmpl', observed_at: now, latest_commit_at: now, latest_commit: 'abc1234', latest_release_at: null, source_id: 'S4' }] },
    scenarios: [
      { scenario: 'deterioration', assumptions: 'The aggregator route thins as the larger pool migrates.', warning_signs: ['Quote received under $475'], would_invalidate: 'A new deep pool.' },
      { scenario: 'stabilization', assumptions: 'Routes stay as they are.', warning_signs: [], would_invalidate: 'A pool migration.' },
      { scenario: 'recovery', assumptions: 'A second venue lists the pair.', warning_signs: [], would_invalidate: 'No listing.' },
    ],
    watch_items: [{ by: '7d', signal: 'Quote at $500', worsens_if: 'Received under $475', improves_if: 'Received over $495', source_or_check: 'S3' }, { by: '30d', signal: 'Release cadence', worsens_if: 'No release', improves_if: 'v2.2', source_or_check: 'S4' }],
    conditions: { worsen: ['The multisig upgrades without notice.'], improve: ['The admin key is time-locked.'] },
    next_evidence: [{ evidence: 'Signer identities of the multisig', would_change: 'Control transparency', how_to_get: 'Governance forum' }],
    monitoring_targets: { product_checks: [{ label: 'Transfer API status', url: 'https://example.com/xmpl/status', expect_status: 200, expect_text: 'operational', capability: 'The transfer API is up', source_id: 'S1' }], repositories: [{ host: 'github', owner: 'example', repo: 'xmpl', source_id: 'S4' }] },
    forecast: { probabilities: null },
    ...over,
  };
}

function reportText(audit, over = {}, { prose = null } = {}) {
  const b = block(audit, over);
  const intro = prose || `# Forensic audit (FICTIONAL)\n\n${b.plain_assessment}\n\n## Facts by area\n\n${'The fictional product and its fictional controls are described here in enough words to be a full report for the tests. '.repeat(14)}\n`;
  return `${intro}\n\`\`\`json\n${JSON.stringify(b, null, 2)}\n\`\`\`\n`;
}

function challengeText(audit, receipt, over = {}) {
  const b = {
    format: D.CHALLENGE_FORMAT,
    forensic_audit_id: audit.audit_id,
    project_id: audit.project_id,
    prompt_version: D.CHALLENGE_VERSION,
    role: 'challenge',
    model: 'chatgpt',
    challenges_receipt_id: receipt.receipt_id,
    assessment_sha256: receipt.block_sha256,
    as_of: new Date().toISOString(),
    overall: 'FICTIONAL. The control finding holds; the liquidity grade rests on one quote.',
    finding_reviews: [{ finding_id: 'F1', verdict: 'supported', attribution_check: 'The docs are the project\'s own.', source_ids: ['S1'] }, { finding_id: 'F3', verdict: 'overstated', attribution_check: 'Substance not shown.', source_ids: ['X1'] }],
    calculation_checks: [{ subject: 'Constant-product exit at $500', result: 'agrees', detail: 'Same within rounding.' }],
    omitted_evidence: [{ evidence: 'A second pool on another chain', why_it_matters: 'Another exit route.', source_id: 'X1' }],
    benign_explanations: [{ for_finding_id: 'F2', explanation: 'Disclosed migrations.', plausibility: 'high' }],
    sources: [{ source_id: 'X1', url: 'https://example.org/second-pool', publisher: 'Example', type: 'secondary', retrieved_at: new Date().toISOString() }],
    ...over,
  };
  return `# Challenge (FICTIONAL)\n\n${'A fictional challenger reviews each fictional finding here, in enough words for the tests. '.repeat(16)}\n\n\`\`\`json\n${JSON.stringify(b, null, 2)}\n\`\`\`\n`;
}

module.exports = { block, reportText, challengeText };
