'use strict';
// FICTIONAL workspaces for the Claude Brief: every project, report, figure,
// source and URL here is invented (example.com and .example domains) to test
// the dashboard. Reports go through the real import path, so eligibility,
// grades, revisions, evidence checks and quarantine are the desk's own. Used by
// brief.test.js and by local screenshot checks; never by the real workspace.

const path = require('path');
const { tempWorkspace } = require('./helpers');
const { atomicWrite, jsonText } = require('../core/fsx');
const { addDays, ymdInTz } = require('../core/dates');

// Each case's CoinGecko ID stem (the project IDs come from the names).
const IDS = {
  complete: 'example-relay-fictional',
  withheld: 'example-ledger-fictional',
  ranges: 'example-range-fictional',
  sparse: 'example-sparse-fictional',
  quarantined: 'example-quarantine-fictional',
  waiting: 'example-waiting-fictional',
  none: 'example-none-fictional',
  long: 'example-long-fictional',
};

const LONG_NAME = 'Example Extraordinarily Long Decentralized Physical Infrastructure Compute, Storage and Bandwidth Marketplace Protocol (FICTIONAL)';
const HOSTILE = '<script>window.__briefPwned = 1</script><img src=x onerror="window.__briefPwned = 2">';

const score = (value, rationale, extra = {}) => ({ status: 'scored', value, low: null, high: null, rationale, evidence_refs: ['C1'], missing_data: null, ...extra });
const range = (low, high, rationale, extra = {}) => ({ status: 'range', value: null, low, high, rationale, evidence_refs: ['C1'], missing_data: null, ...extra });
const unknown = (missing, extra = {}) => ({ status: 'unknown', value: null, low: null, high: null, rationale: '', evidence_refs: [], missing_data: missing, ...extra });
const na = (why) => ({ status: 'not_applicable', value: null, low: null, high: null, rationale: why, evidence_refs: [], missing_data: null });
const cat = (value, conf, label, extra = {}) => score(value, `Fictional: ${label}.`, {
  confidence: conf,
  strongest_evidence: `Fictional strongest evidence for ${label}.`,
  main_weakness: `Fictional main weakness of ${label}.`,
  would_raise: `Fictional: what would raise ${label}.`,
  would_lower: `Fictional: what would lower ${label}.`,
  ...extra,
});

// A complete cr.report.v2 answer for one run (or none), as a model would write
// it: prose first, then the JSON block. `edit` changes the JSON.
function reportText({ project, symbol, profile, run = null, analysisAt, horizon, edit = null, prose = '' }) {
  const start = horizon.start;
  const end = horizon.end;
  const json = {
    schema_version: 'cr.report.v2',
    report_id: null,
    research_run_id: run ? run.run_id : null,
    project_id: project.project_id,
    project_name: project.name,
    project_symbol: symbol,
    provider: 'claude',
    model_self_identification: 'FICTIONAL test fixture labeled as Claude',
    model_version: null,
    model_version_note: 'Fixture: no model wrote this.',
    analysis_at: analysisAt,
    horizon: horizon.text,
    prompt_version: run ? run.prompt.version : 'cr-research-prompt@5',
    rubric_version: run ? run.rubric_version : 'cr-grading@1',
    sector_profile: profile,
    verdict: 'CONDITIONAL OPPORTUNITY',
    summary: 'Fictional: a working relay network with paid demand that is real but small; the token captures none of it until the fee switch, which is only announced. The opportunity depends on that vote landing inside this horizon.',
    diagnostic_scores: {
      legitimacy: cat(78, 'high', 'project legitimacy'),
      development_credibility: cat(72, 'medium', 'development credibility'),
      build_operational_quality: cat(66, 'medium', 'build and operational quality'),
      code_quality: cat(61, 'medium', 'code quality'),
      product_reality: cat(74, 'high', 'live product reality'),
      technology_usefulness: cat(69, 'medium', 'technology usefulness', { rationale: 'Fictional: relayed jobs settle in seconds at a fraction of the centralized default, and two independent integrators route production traffic through it; the moat is operator density, which a better-funded rival could copy.' }),
      organic_demand: cat(52, 'low', 'organic demand'),
      token_value_capture: cat(44, 'medium', 'token value capture'),
      valuation_supply_attractiveness: { ...range(48, 60, 'Fictional: two circulating-supply figures could not be reconciled.'), confidence: 'low', strongest_evidence: null, main_weakness: 'Fictional: supply figures disagree.', would_raise: null, would_lower: null },
      chart_structure: cat(57, 'medium', 'chart structure'),
      cycle_timing: cat(62, 'medium', 'cycle timing'),
      volume_liquidity: unknown('Fictional: no order-book depth could be read for the main venue.', { confidence: null }),
      btc_relative_opportunity: cat(55, 'low', 'BTC-relative opportunity'),
    },
    investment_components: {
      sustainable_business_demand: score(70, 'Fictional: paid relay demand grew for five straight months.'),
      token_value_capture: score(58, 'Fictional: fees go to operators today; the announced fee switch would route 20% to stakers, which is the whole case for the token.'),
      valuation_supply: score(62, 'Fictional: valuation is fair on current fees if the switch passes, rich if it does not.'),
      risk_resilience: score(72, 'Fictional: audited contracts and a working incident process.'),
      btc_relative_asymmetry: score(66, 'Fictional: a passed vote is not priced in; a failed one costs less than the upside of a pass.'),
      timing_executable_liquidity: score(60, 'Fictional: two venues carry most volume; depth is thin above $50K.'),
    },
    model_reported_overall_score: score(72, 'Fictional: the model\'s own total.'),
    risk_scores: {
      credit: na('Not applicable under this profile'),
      dilution: score(58, 'Fictional: an investor unlock falls inside the horizon.'),
      liquidity: score(46, 'Fictional: thin depth on two venues.'),
      overall_downside: score(52, 'Fictional: moderate.'),
    },
    sources: [
      { source_id: 'S1', url: 'https://docs.relay.example/fees', title: 'Fees and settlement (FICTIONAL docs)', publisher: 'relay.example', source_type: 'official', accessed_at: analysisAt },
      { source_id: 'S2', url: 'https://explorer.example/address/0xFICTIONAL', title: 'Fee contract on the explorer (FICTIONAL)', publisher: 'explorer.example', source_type: 'onchain_data', accessed_at: analysisAt },
      { source_id: 'S3', url: 'https://blog.relay.example/fee-switch', title: 'Fee switch proposal (FICTIONAL)', publisher: 'relay.example', source_type: 'official', accessed_at: analysisAt },
      { source_id: 'S4', url: 'https://docs.relay.example/token', title: 'Token and unlocks (FICTIONAL)', publisher: 'relay.example', source_type: 'official', accessed_at: analysisAt },
      { source_id: 'S5', url: 'https://research.example/relay-networks', title: 'Relay networks compared (FICTIONAL)', publisher: 'research.example', source_type: 'research', accessed_at: analysisAt },
      { source_id: 'S6', url: 'https://exchange.example/markets/XRLY-USDT', title: 'XRLY order book (FICTIONAL)', publisher: 'exchange.example', source_type: 'exchange', accessed_at: analysisAt },
      { source_id: 'S7', url: 'https://ai-summary.example/xrly', title: 'An AI-written summary page (FICTIONAL)', publisher: 'ai-summary.example', source_type: 'ai_summary', accessed_at: analysisAt },
    ],
    claims: [
      { claim_id: 'C1', text: 'Fictional: mainnet settles paid relay jobs and charges a fee per job.', evidence_tag: 'V', source_ids: ['S1'], as_of: analysisAt, excerpt: 'Fictional excerpt from the fee page.', critical_kind: null },
      { claim_id: 'C2', text: 'Fictional: 1.8M paid jobs in the last 30 days.', evidence_tag: 'V', source_ids: ['S2'], metric_id: 'paid_jobs', value: 1800000, unit: 'jobs', period: '30 days', as_of: analysisAt, query: 'Fictional explorer view of the fee contract, 30 days' },
      { claim_id: 'C3', text: 'Fictional: two enterprise integrators are in production.', evidence_tag: 'C', source_ids: ['S3'], as_of: analysisAt },
      { claim_id: 'C4', text: 'Fictional: an investor unlock of 6% of supply falls inside the horizon.', evidence_tag: 'V', source_ids: ['S4'], as_of: analysisAt, critical_kind: 'supply_change', excerpt: 'Fictional unlock table.' },
      { claim_id: 'C5', text: 'Fictional: operators, not token holders, receive the fees today.', evidence_tag: 'I', source_ids: ['S1', 'S2'], as_of: analysisAt },
      { claim_id: 'C6', text: 'Fictional: the fee switch would pass on current delegate votes.', evidence_tag: 'S', source_ids: ['S3'], as_of: analysisAt },
      { claim_id: 'C7', text: 'Fictional: the audit covered the fee contract.', evidence_tag: 'V', source_ids: ['S7'], as_of: analysisAt, critical_kind: 'audit' },
    ],
    bullish_facts: [
      { text: 'Fictional: paid demand is real: 1.8M settled jobs in 30 days, each paying a fee on mainnet.', claim_ids: ['C1', 'C2'] },
      { text: 'Fictional: two integrators route production traffic through the network.', claim_ids: ['C3'] },
      { text: 'Fictional: the fee switch vote, if it passes, gives the token its first cash flow.', claim_ids: ['C6', 'C99'] },
    ],
    bearish_facts: [
      { text: 'Fictional: the token captures none of the fees today; operators keep them.', claim_ids: ['C5'] },
      { text: 'Fictional: a 6% investor unlock lands inside the horizon.', claim_ids: ['C4'] },
      { text: 'Fictional: depth is thin: a $50K order moves the price on both venues.', claim_ids: [] },
    ],
    conviction_increases: [
      { text: 'Fictional: the fee switch passes on-chain, not just in the forum.', claim_ids: ['C3'] },
      { text: 'Fictional: paid jobs keep growing after the incentive campaign ends.', claim_ids: ['C2'] },
    ],
    invalidators: [
      { text: 'Fictional: the vote fails or is postponed past the horizon.', claim_ids: ['C3'] },
      { text: 'Fictional: unlocked investor tokens move to exchanges.', claim_ids: ['C4'] },
    ],
    catalysts: [
      { title: 'Fee switch vote (FICTIONAL)', date: null, date_precision: 'window', kind: 'governance', status: 'announced', claim_ids: ['C3'], window_start: addDays(start, 15), window_end: addDays(start, 22), certainty: 'source_documented', in_horizon: true },
      { title: 'Investor unlock, 6% of supply (FICTIONAL)', date: null, date_precision: 'window', kind: 'unlock', status: 'announced', claim_ids: ['C4'], window_start: addDays(start, 48), window_end: addDays(start, 48), certainty: 'source_documented', in_horizon: true },
      { title: 'Relay v2 upgrade (FICTIONAL)', date: null, date_precision: 'window', kind: 'launch', status: 'announced', claim_ids: ['C3'], window_start: addDays(start, 70), window_end: addDays(start, 100), certainty: 'project_claimed', in_horizon: true },
      { title: 'A second exchange listing (FICTIONAL)', date: null, date_precision: 'unknown', kind: 'listing', status: 'speculative', claim_ids: [], window_start: null, window_end: null, certainty: 'analyst_inferred', in_horizon: null },
      { title: 'Team unlock (FICTIONAL)', date: null, date_precision: 'window', kind: 'unlock', status: 'announced', claim_ids: ['C4'], window_start: addDays(end, 25), window_end: addDays(end, 25), certainty: 'source_documented', in_horizon: false },
    ],
    unlocks: [],
    tokenomics_changes: [{ description: 'Fictional: fee switch routing 20% of fees to stakers.', status: 'proposed', announced_at: start, effective_at: null, claim_ids: ['C3'] }],
    economics: {
      protocol_revenue: { status: 'reported', value: 412000, unit: 'USD', period: '30 days', definition: 'Fees paid by users', as_of: analysisAt, evidence_tag: 'V', claim_ids: ['C2'], note: null },
      network_usage: { status: 'reported', value: 1800000, unit: 'jobs', period: '30 days', definition: 'Paid relay jobs', as_of: analysisAt, evidence_tag: 'V', claim_ids: ['C2'], note: null },
      participant_rewards: { status: 'reported', value: 2900000, unit: 'USD', period: '30 days', definition: 'Operator rewards, mostly emissions', as_of: analysisAt, evidence_tag: 'I', claim_ids: ['C5'], note: 'Fictional: about 85% emissions.' },
      token_holder_distributions: { status: 'reported', value: 0, unit: 'USD', period: '30 days', definition: 'Distributions to holders', as_of: analysisAt, evidence_tag: 'V', claim_ids: ['C5'], note: null },
      staking_yield: { status: 'unknown', value: null, unit: null, period: null, definition: null, as_of: null, evidence_tag: null, claim_ids: [], note: 'Fictional: not published.' },
    },
    code_review: {
      source_access: 'public',
      repositories: [{ url: 'https://code.example/relay/node', role: 'Fictional relay node', commit: null, files_inspected: [], observations: 'Fictional: README and release notes only.' }],
      deployed_link: { status: 'unknown', note: 'Fictional: no release tag matched.' },
      limitations: 'Fictional: no implementation file was read at a named commit.',
    },
    chart_cycle: {
      data: { source: 'Fictional exchange data', venue: 'exchange.example (FICTIONAL)', pair: 'XRLY/USDT', timeframes: ['1W', '1D'], latest_observation_at: `${analysisAt}T00:00:00Z`, limitations: 'Fictional: one venue only; no depth history.' },
      phase: 'base_formation',
      phase_rationale: 'Fictional: eleven weeks of higher lows after a 70% drawdown.',
      alternative_reading: 'Fictional: a pause inside a longer decline.',
      trend_vs_usd: 'Fictional: sideways with higher lows.',
      trend_vs_btc: 'Fictional: flat against BTC for two months.',
      levels: [{ kind: 'support', price_usd: 0.84, timeframe: '1W', basis: 'Fictional: three weekly closes.' }, { kind: 'resistance', price_usd: 1.22, timeframe: '1D', basis: 'Fictional: two failed breakouts.' }],
      volume: { baseline: 'Fictional 30-day average daily volume on exchange.example', reading: 'Fictional: rising on up days.', confirms_price: true },
      liquidity: 'Fictional: thin above $50K.',
      confirmation: ['Fictional: a weekly close above $1.22 on rising volume.'],
      invalidation: ['Fictional: a weekly close below $0.84.'],
      evidence_refs: ['C1'],
    },
    scenarios: {
      btc_relative_definition: '(1 + XRLY return) / (1 + BTC return) − 1 over the horizon',
      probability_note: null,
      target_note: null,
      items: [
        { case: 'bull', probability_pct: 25, observations: ['Fictional: paid jobs are growing.'], business_outcome: 'Fictional: the fee switch passes and paid jobs keep growing.', token_capture_assumption: 'Fictional: 20% of fees go to stakers.', supply_assumption: 'Fictional: the unlock is absorbed.', btc_assumption: 'Fictional: altcoins participate.', price_range_usd: { low: 1.6, high: 2.2 }, relative_return_vs_btc_pct: { low: 40, high: 90 }, invalidation: 'Fictional: the vote fails.', claim_ids: ['C2'] },
        { case: 'base', probability_pct: 50, observations: ['Fictional: the vote is scheduled.'], business_outcome: 'Fictional: the switch passes late; demand flat.', token_capture_assumption: 'Fictional: capture starts near the horizon end.', supply_assumption: 'Fictional: unlock sold over weeks.', btc_assumption: 'Fictional: Bitcoin-led market.', price_range_usd: { low: 0.95, high: 1.3 }, relative_return_vs_btc_pct: { low: -5, high: 15 }, invalidation: 'Fictional: demand falls.', claim_ids: ['C3'] },
        { case: 'bear', probability_pct: 25, observations: ['Fictional: depth is thin.'], business_outcome: 'Fictional: the vote fails; operators keep all fees.', token_capture_assumption: 'Fictional: none.', supply_assumption: 'Fictional: unlocked tokens reach exchanges.', btc_assumption: 'Fictional: a contracting market.', price_range_usd: { low: 0.62, high: 0.85 }, relative_return_vs_btc_pct: { low: -35, high: -15 }, invalidation: 'Fictional: the vote passes.', claim_ids: ['C4'] },
      ],
    },
    independent_judgment: {
      market_misunderstanding: { view: 'Fictional: the market prices the token as if it already earns the fees.', label: 'judgment', supporting_evidence: ['C5'], disconfirming_test: 'Fictional: holders already receive fees.' },
      overlooked_bull_case: { view: 'Fictional: integrators could pay in the token after the switch.', label: 'speculation', supporting_evidence: ['C3'], disconfirming_test: 'Fictional: integrators pay in stablecoins only.' },
      overlooked_bear_case: { view: 'Fictional: operators may fork away from the fee switch.', label: 'speculation', supporting_evidence: ['C5'], disconfirming_test: 'Fictional: operators vote for it.' },
      technology_without_token: { view: 'Fictional: the network can thrive while the token earns nothing if the vote fails.', label: 'judgment', supporting_evidence: ['C5'], disconfirming_test: 'Fictional: the switch passes.' },
      within_holding_period: { view: 'Fictional: the fee switch vote in the third week is the single event that can re-rate the token inside this horizon; until it passes on-chain, the token is a call option on governance.', label: 'speculation', supporting_evidence: ['C3', 'C6'], disconfirming_test: 'Fictional: the vote is postponed past the horizon or fails.' },
      advantage_over_btc: { view: 'Fictional: only if the vote passes; otherwise BTC is the better hold.', label: 'judgment', supporting_evidence: ['C6'], disconfirming_test: 'Fictional: the token falls against BTC after a passed vote.' },
    },
    next_metric_to_monitor: { metric: 'Fictional: the on-chain result of the fee switch vote', why: 'Fictional: it decides whether the token earns anything.', threshold: 'Fictional: passes with quorum' },
    position_context: {
      recipe: 'position-cycle@1',
      horizon: { mode: horizon.mode || 'position', start_date: start, end_date: end },
      market: { state: 'bitcoin_led', rationale: 'Fictional: Bitcoin leads; breadth is narrow.', evidence_refs: ['C1'] },
      timing: { state: 'early', rationale: 'Fictional: the catalyst lies ahead; nothing is priced in yet.', evidence_refs: ['C3'], next_review_date: addDays(start, 30), review_trigger: 'Fictional: the vote result, or the unlock moving to exchanges.' },
      long_term_note: 'Fictional: relay demand could matter for years; kept apart from this horizon.',
    },
    final_take: 'Fictional: the network is real and used, and the team ships. The token is not yet a claim on that use: operators keep every fee. The trap is buying the network\'s growth through a token that captures none of it. The opportunity is the fee switch vote inside this horizon, which the price does not reflect. A passed on-chain vote upgrades the view; a failed or postponed vote, or the unlock reaching exchanges, downgrades it.',
    unresolved_questions: ['Fictional: which circulating-supply figure is right?', 'Fictional: will operators accept a 20% fee share?'],
    original_report_reference: { note: 'The written report above this JSON block is the original.' },
  };
  if (edit) edit(json);
  const body = [
    `# ${project.name}: research report`,
    '',
    '> FICTIONAL TEST FIXTURE. Every name, number and URL here is invented to test the dashboard. Not research.',
    '',
    `Analysis date: ${analysisAt} · Horizon: ${horizon.text}`,
    '',
    prose,
    '',
    '```json',
    JSON.stringify(json, null, 2),
    '```',
    '',
  ].join('\n');
  return body;
}

// ChatGPT's FICTIONAL report on the relay network, for the same run as
// Claude's: its own verdict, sources and claims (two sources shared with
// Claude's, one paid-jobs figure that differs), and category grades that
// differ in ways the comparison must keep apart: a gap each side explains,
// a range against a point, a grade with no reason and no evidence, a category
// only one side could grade, and grades that match.
function chatgptEdit(j) {
  const at = j.analysis_at;
  j.provider = 'chatgpt';
  j.model_self_identification = 'FICTIONAL test fixture labeled as ChatGPT';
  j.verdict = 'REAL PRODUCT, WEAK TOKEN';
  j.summary = 'Fictional: the relay network works and is paid for, but the token is an option on a fee switch that operators openly resist; today it earns nothing and an unlock lands inside the horizon.';
  j.sources = [
    { source_id: 'S1', url: 'https://docs.relay.example/fees', title: 'Fees and settlement (FICTIONAL docs)', publisher: 'relay.example', source_type: 'official', accessed_at: at },
    { source_id: 'S2', url: 'https://dashboard.relay.example/jobs', title: 'Relay jobs dashboard (FICTIONAL)', publisher: 'relay.example', source_type: 'official', accessed_at: at },
    { source_id: 'S3', url: 'https://blog.relay.example/fee-switch', title: 'Fee switch proposal (FICTIONAL)', publisher: 'relay.example', source_type: 'official', accessed_at: at },
    { source_id: 'S4', url: 'https://docs.relay.example/token', title: 'Token and unlocks (FICTIONAL)', publisher: 'relay.example', source_type: 'official', accessed_at: at },
    { source_id: 'S5', url: 'https://forum.relay.example/t/operators-fee-share', title: 'Operators on the fee share (FICTIONAL forum thread)', publisher: 'forum.relay.example', source_type: 'community', accessed_at: at },
  ];
  j.claims = [
    { claim_id: 'C1', text: 'Fictional: mainnet settles paid relay jobs and charges a fee per job.', evidence_tag: 'V', source_ids: ['S1'], as_of: at },
    { claim_id: 'C2', text: 'Fictional: 1.2M paid jobs in the last 30 days on the project dashboard.', evidence_tag: 'C', source_ids: ['S2'], metric_id: 'paid_jobs', value: 1200000, unit: 'jobs', period: '30 days', as_of: at },
    { claim_id: 'C3', text: 'Fictional: two enterprise integrators are in production.', evidence_tag: 'C', source_ids: ['S3'], as_of: at },
    { claim_id: 'C4', text: 'Fictional: an investor unlock of 6% of supply falls inside the horizon.', evidence_tag: 'V', source_ids: ['S4'], as_of: at, critical_kind: 'supply_change', excerpt: 'Fictional unlock table.' },
    { claim_id: 'C5', text: 'Fictional: the fee contract pays operators only; holders receive nothing.', evidence_tag: 'V', source_ids: ['S1'], as_of: at },
    { claim_id: 'C8', text: 'Fictional: operators in the governance forum oppose a 20% fee share.', evidence_tag: 'C', source_ids: ['S5'], as_of: at },
  ];
  const d = j.diagnostic_scores;
  d.token_value_capture = cat(30, 'medium', 'token value capture', { rationale: 'Fictional: operators keep every fee today and the forum shows them opposing the switch; a token with no cash flow and a contested path to one grades low.', evidence_refs: ['C5', 'C8'], strongest_evidence: 'Fictional: the fee contract pays operators only.', main_weakness: 'Fictional: one forum thread is a small sample of operators.' });
  d.organic_demand = cat(66, 'medium', 'organic demand', { rationale: 'Fictional: 1.2M paid jobs in 30 days with no incentive campaign running.', evidence_refs: ['C2'], main_weakness: 'Fictional: the dashboard is the project\'s own.' });
  d.valuation_supply_attractiveness = cat(38, 'medium', 'valuation and supply', { rationale: 'Fictional: on the token docs\' circulating supply the valuation is rich for a token with no cash flow, and the unlock adds 6%.', evidence_refs: ['C4'] });
  d.volume_liquidity = cat(48, 'low', 'volume and liquidity', { rationale: 'Fictional: aggregate volume is steady across two venues.', evidence_refs: [], strongest_evidence: null });
  d.cycle_timing = { status: 'scored', value: 50, low: null, high: null, confidence: 'low', rationale: '', evidence_refs: [], missing_data: null, strongest_evidence: null, main_weakness: null, would_raise: null, would_lower: null };
  d.chart_structure = cat(60, 'medium', 'chart structure');
  d.btc_relative_opportunity = range(40, 50, 'Fictional: depends on the vote; either way the token lags BTC until it passes.', { confidence: 'low', evidence_refs: ['C3'] });
  d.code_quality = unknown('Fictional: no implementation file was read at a named commit.', { confidence: null });
  const c = j.investment_components;
  c.token_value_capture = score(40, 'Fictional: no fee reaches holders today; the switch is contested.', { evidence_refs: ['C5', 'C8'] });
  c.valuation_supply = score(50, 'Fictional: rich on current fees, with an unlock inside the horizon.', { evidence_refs: ['C4'] });
  c.btc_relative_asymmetry = score(52, 'Fictional: the upside needs a vote the operators resist.', { evidence_refs: ['C8'] });
  j.model_reported_overall_score = unknown('Fictional: no total of its own.');
  j.bullish_facts = [
    { text: 'Fictional: paid demand is real and grows without incentives.', claim_ids: ['C1', 'C2'] },
    { text: 'Fictional: two integrators route production traffic through the network.', claim_ids: ['C3'] },
  ];
  j.bearish_facts = [
    { text: 'Fictional: operators oppose a 20% fee share, so the switch may not pass.', claim_ids: ['C8'] },
    { text: 'Fictional: the token captures none of the fees today.', claim_ids: ['C5'] },
    { text: 'Fictional: a 6% investor unlock lands inside the horizon.', claim_ids: ['C4'] },
  ];
  j.conviction_increases = [{ text: 'Fictional: a delegate count shows a majority for the fee switch before the vote.', claim_ids: ['C8'] }];
  j.invalidators = [{ text: 'Fictional: operators fork the relay client to keep every fee.', claim_ids: ['C8'] }];
  j.economics.network_usage = { status: 'reported', value: 1200000, unit: 'jobs', period: '30 days', definition: 'Paid relay jobs', as_of: at, evidence_tag: 'C', claim_ids: ['C2'], note: null };
  j.final_take = 'Fictional: a good network with a token that earns nothing. The fee switch is the whole case, and the operators who would pay for it are against it. Wait for the vote.';
  j.unresolved_questions = ['Fictional: how many operators would leave over a 20% fee share?'];
}

// Prices and market caps the index reads (market data is off in tests; these
// are FICTIONAL observations, labeled as demo data).
function writeMarket(ws, ids, now = Date.now()) {
  const iso = (ms) => new Date(now - ms).toISOString();
  const obs = (id, symbol, name, price, extra) => ({ id, symbol, name: `${name} (FICTIONAL)`, image_url: null, price_usd: price, rank_source: 'fictional-demo', source: 'FICTIONAL demo data', source_last_updated_at: iso(2 * 60000), fetched_at: iso(60000), ...extra });
  const assets = {
    [`${ids.complete}-cg`]: obs(`${ids.complete}-cg`, 'XRLY', 'Example Relay Network', 1.07, { market_cap_usd: 214e6, market_cap_rank: 233, fdv_usd: 535e6, volume_24h_usd: 9.4e6, change_24h_pct: 3.12, change_7d_pct: 8.4, change_30d_pct: 21.7 }),
    [`${ids.withheld}-cg`]: obs(`${ids.withheld}-cg`, 'XLDG', 'Example Ledger Credit', 0.31, { market_cap_usd: 61e6, market_cap_rank: 640, fdv_usd: 310e6, volume_24h_usd: 2.2e6, change_24h_pct: -1.84, change_7d_pct: -4.1, change_30d_pct: 2.2 }),
    [`${ids.long}-cg`]: obs(`${ids.long}-cg`, 'XLNG', 'Example Long', 0.0042, { market_cap_usd: 3.1e6, market_cap_rank: 2405, fdv_usd: 4.2e6, volume_24h_usd: 0.09e6, change_24h_pct: -3.4, change_7d_pct: -12.5, change_30d_pct: -28.1 }),
  };
  atomicWrite(ws.abs('market-data/latest.json'), jsonText({ schema_version: 'cr.market-latest.v2', provider: 'fictional-demo', rank_source: 'FICTIONAL demo rank', note: 'FICTIONAL prices for tests.', fetched_at: iso(60000), assets }));
  atomicWrite(ws.abs('market-data/status.json'), jsonText({ schema_version: 'cr.market-status.v2', state: 'ok', last_attempt_at: iso(60000), last_success_at: iso(60000), last_trigger: 'test', last_error: null, consecutive_failures: 0, note: 'FICTIONAL', calls: { month: iso(0).slice(0, 7), month_count: 0, day: iso(0).slice(0, 10), day_count: 0 } }));
}

// A failed build removes its temporary workspace before the error goes on.
function buildBriefWorkspace(label = 'brief') {
  const t = tempWorkspace(label);
  try {
    return build(t);
  } catch (err) {
    t.cleanup();
    throw err;
  }
}

function build(t) {
  const { ws } = t;
  const projects = require('../core/projects');
  const research = require('../core/research');
  const inbox = require('../core/inbox');
  const notes = require('../core/notes');
  const pids = {};
  const add = (key, name, symbol, profile, extra = {}) => {
    const res = projects.addProject(ws, {
      name, symbol, sector_profile: profile,
      official_website: `https://${symbol.toLowerCase()}.example/`,
      coingecko_id: `${IDS[key]}-cg`,
      assets: [{ chain: 'ethereum', contract_address: `0x${require('crypto').createHash('sha1').update(`FICTIONAL-${symbol}`).digest('hex')}` }],
      evidence: [{ url: `https://${symbol.toLowerCase()}.example/token`, note: 'FICTIONAL test evidence' }],
      ...extra,
    });
    if (res.status !== 'created') throw new Error(`fixture project not created: ${res.message}`);
    pids[key] = res.project_id;
    return { project_id: res.project_id, name };
  };
  const importAs = (provider, pid, text, opts = {}) => {
    const out = inbox.importContent(ws, provider, { content: text, projectId: pid, ...opts });
    if (out.result.status !== 'ingested') throw new Error(`fixture import failed: ${out.result.message}`);
    return out.result;
  };
  const importClaude = (pid, text, opts = {}) => importAs('claude', pid, text, opts);
  const runFor = (pid, providers = ['claude']) => research.createRun(ws, { project_id: pid, providers, channel: 'dashboard', force_new: true }).run;
  const hz = (run) => ({ start: run.horizon.start_date, end: run.horizon.end_date, text: run.horizon.text, mode: run.horizon.mode });
  const out = { ids: IDS, pids, reports: {} };

  // 1. Complete research: an earlier report outside any run, then the current
  //    run's report and its revision (the latest), with a differing own total,
  //    a serious evidence flag and a material category flag; a ChatGPT report too.
  const p1 = add('complete', 'Example Relay Network (FICTIONAL)', 'XRLY', 'network-infrastructure@2');
  const oldStart = addDays(ymdInTz(), -23);
  const oldHz = { start: oldStart, end: addDays(oldStart, 123), text: `4 months (${oldStart} to ${addDays(oldStart, 123)})`, mode: 'position' };
  out.reports.earlier = importClaude(p1.project_id, reportText({ project: p1, symbol: 'XRLY', profile: 'network-infrastructure@2', analysisAt: oldStart, horizon: oldHz,
    edit: (j) => { j.verdict = 'REAL PRODUCT, WEAK TOKEN'; j.investment_components.token_value_capture.value = 40; j.investment_components.btc_relative_asymmetry.value = 50; j.model_reported_overall_score = score(60, 'Fictional.'); } })).report_id;
  const run1 = runFor(p1.project_id, ['claude', 'chatgpt']);
  const day = run1.horizon.start_date;
  out.reports.first = importClaude(p1.project_id, reportText({ project: p1, symbol: 'XRLY', profile: run1.sector_profile, run: run1, analysisAt: day, horizon: hz(run1), edit: (j) => { j.investment_components.token_value_capture.value = 54; } }), { runId: run1.run_id }).report_id;
  out.reports.latest = importClaude(p1.project_id, reportText({ project: p1, symbol: 'XRLY', profile: run1.sector_profile, run: run1, analysisAt: day, horizon: hz(run1) }), { runId: run1.run_id, revision: { kind: 'reassessment', note: 'FICTIONAL: re-read the fee switch proposal; token value capture raised from 54 to 58.' } }).report_id;
  // ChatGPT's own report for the same run, written apart: grades that differ
  // with its own reasons and claims, a category Claude could not grade and
  // one Claude graded that ChatGPT could not, a grade ChatGPT gives no reason
  // or evidence for, and a paid-jobs figure that differs from Claude's.
  const gpt = importAs('chatgpt', p1.project_id, reportText({ project: p1, symbol: 'XRLY', profile: run1.sector_profile, run: run1, analysisAt: day, horizon: hz(run1), edit: chatgptEdit }), { runId: run1.run_id });
  out.reports.chatgpt = gpt.report_id;
  notes.setConvictionNote(ws, p1.project_id, 'FICTIONAL note: I like the network; I only want the token if the fee switch passes on-chain. Small size before the vote.', { conviction: 'medium' });
  out.runs = { complete: run1.run_id };

  // 2. Withheld: two components unknown; scenarios without probabilities or ranges.
  const p2 = add('withheld', 'Example Ledger Credit (FICTIONAL)', 'XLDG', 'payfi-credit@2');
  const run2 = runFor(p2.project_id);
  out.reports.withheld = importClaude(p2.project_id, reportText({ project: p2, symbol: 'XLDG', profile: run2.sector_profile, run: run2, analysisAt: run2.horizon.start_date, horizon: hz(run2),
    edit: (j) => {
      j.verdict = 'INSUFFICIENT EVIDENCE';
      j.summary = 'Fictional: loans are originated and repaid, but default data for the newest pools is not public, so neither the asymmetry against BTC nor the timing can be scored.';
      j.investment_components.btc_relative_asymmetry = unknown('Fictional: no defensible price range: default data for the newest pools is not published.');
      j.investment_components.timing_executable_liquidity = unknown('Fictional: no order-book depth could be read.');
      j.risk_scores.credit = score(64, 'Fictional: realized defaults are not public for the newest pools.');
      j.diagnostic_scores.code_quality = unknown('Fictional: the lending contracts are not open source.', { confidence: null });
      j.code_review.source_access = 'none';
      j.scenarios.items.forEach((s) => { s.probability_pct = null; s.price_range_usd = { low: null, high: null }; s.relative_return_vs_btc_pct = { low: null, high: null }; });
      j.scenarios.probability_note = 'Fictional: default data does not support probabilities.';
      j.scenarios.target_note = 'Fictional: no valuation evidence supports a price range.';
      j.model_reported_overall_score = score(58, 'Fictional: the model\'s own total.');
      j.economics = {};
    } }), { runId: run2.run_id }).report_id;

  // 3. Ranges and unknowns: two components as justified ranges (a range grade);
  //    an older eligible report stays the brief when the newest answer is quarantined.
  const p3 = add('ranges', 'Example Range Labs (FICTIONAL)', 'XRNG', 'general-token@2');
  const run3 = runFor(p3.project_id);
  out.reports.range = importClaude(p3.project_id, reportText({ project: p3, symbol: 'XRNG', profile: run3.sector_profile, run: run3, analysisAt: run3.horizon.start_date, horizon: hz(run3),
    edit: (j) => {
      j.verdict = 'UNFAVORABLE VALUATION';
      // A long strongest risk: on a phone its first lines, the rest one tap away.
      j.bearish_facts[0].text = 'Fictional: the token captures none of the fees today; operators keep them, the buyback has no date, and two unlocks inside the horizon add supply that the thin order books cannot absorb without a large discount.';
      j.investment_components.valuation_supply = range(40, 55, 'Fictional: two supply readings, both defensible.');
      j.investment_components.btc_relative_asymmetry = range(35, 60, 'Fictional: depends on whether the buyback is implemented.');
      j.diagnostic_scores.organic_demand = range(30, 45, 'Fictional: incentive share unknown.', { confidence: 'low' });
      j.diagnostic_scores.chart_structure = unknown('Fictional: no reliable chart data for the new pair.', { confidence: null });
      j.risk_scores.liquidity = range(55, 70, 'Fictional: depth unknown on one venue.');
      j.model_reported_overall_score = unknown('Fictional: no total of its own.');
      j.scenarios.items.forEach((s) => { s.probability_pct = s.case === 'base' ? 60 : null; });
      j.scenarios.probability_note = 'Fictional: only the base case is defensible.';
      j.catalysts = [];
      j.position_context.timing.next_review_date = null;
      j.economics = { business_revenue: { status: 'reported', value: 90000, unit: 'USD', period: '30 days', definition: 'Fees', as_of: run3.horizon.start_date, evidence_tag: 'C', claim_ids: ['C1'], note: null } };
    } }), { runId: run3.run_id }).report_id;
  const run3b = runFor(p3.project_id);
  out.reports.quarantinedLater = importClaude(p3.project_id, reportText({ project: p3, symbol: 'XRNG', profile: 'payfi-credit@1', run: run3b, analysisAt: run3b.horizon.start_date, horizon: hz(run3b),
    edit: (j) => { j.research_run_id = 'run_2026-09-30T120000Z_other'; } }), { runId: run3b.run_id, attested: { provider: 'anthropic', model: 'FICTIONAL', response_id: 'msg_fictional_q' }, channel: 'Claude API' }).report_id;

  // 4. Sparse: an older report with almost nothing beyond its scores.
  const p4 = add('sparse', 'Example Sparse Token (FICTIONAL)', 'XSPR', 'general-token@1');
  out.reports.sparse = importClaude(p4.project_id, [
    '# Example Sparse Token (FICTIONAL)', '', 'Fictional prose report.', '',
    '```json',
    JSON.stringify({
      schema_version: 'cr.report.v1', provider: 'claude', project_id: p4.project_id, analysis_at: '2026-08-20', horizon: '3 months', prompt_version: 'cr-research-prompt@2', rubric_version: 'cr-grading@1', sector_profile: 'general-token@1', verdict: 'INSUFFICIENT EVIDENCE',
      diagnostic_scores: { legitimacy: score(55, 'Fictional.'), token_value_capture: unknown('Fictional: no docs.') },
      investment_components: { sustainable_business_demand: score(40, 'Fictional.'), token_value_capture: score(35, 'Fictional.'), valuation_supply: score(45, 'Fictional.'), risk_resilience: score(50, 'Fictional.'), btc_relative_asymmetry: score(30, 'Fictional.'), timing_executable_liquidity: score(40, 'Fictional.') },
      model_reported_overall_score: score(41, 'Fictional.'),
      risk_scores: { credit: na('n/a'), dilution: score(70, 'Fictional.'), liquidity: score(75, 'Fictional.'), overall_downside: score(72, 'Fictional.') },
      sources: [], claims: [], bullish_facts: [], bearish_facts: [], catalysts: [],
    }, null, 2),
    '```', ''].join('\n')).report_id;

  // A ChatGPT report on it under a later prompt and scoring profile, outside
  // any run: the two are not scored on the same scale.
  const later = addDays(ymdInTz(), -6);
  out.reports.sparseChatgpt = importAs('chatgpt', p4.project_id, reportText({ project: p4, symbol: 'XSPR', profile: 'general-token@2', analysisAt: later, horizon: { start: later, end: addDays(later, 120), text: `4 months (${later} to ${addDays(later, 120)})`, mode: 'position' },
    edit: (j) => { j.provider = 'chatgpt'; j.model_self_identification = 'FICTIONAL test fixture labeled as ChatGPT'; j.verdict = 'INSUFFICIENT EVIDENCE'; } })).report_id;

  // 5. Only a quarantined answer.
  const p5 = add('quarantined', 'Example Quarantine Network (FICTIONAL)', 'XQRN', 'network-infrastructure@2');
  const run5 = runFor(p5.project_id);
  out.reports.quarantined = importClaude(p5.project_id, reportText({ project: p5, symbol: 'XQRN', profile: 'general-token@2', run: run5, analysisAt: run5.horizon.start_date, horizon: hz(run5) }),
    { runId: run5.run_id, attested: { provider: 'anthropic', model: 'FICTIONAL', response_id: 'msg_fictional_q5' }, channel: 'Claude API' }).report_id;

  // 6. No Claude report, its research waiting; 7. no Claude report and no job.
  const p6 = add('waiting', 'Example Waiting Protocol (FICTIONAL)', 'XWTG', 'general-token@2');
  runFor(p6.project_id);
  add('none', 'Example Unresearched Token (FICTIONAL)', 'XNON', 'general-token@2');

  // 8. A very long name and hostile text in every field a model writes.
  const p8 = add('long', LONG_NAME, 'XLNG', 'network-infrastructure@2');
  const run8 = runFor(p8.project_id);
  out.reports.long = importClaude(p8.project_id, reportText({ project: p8, symbol: 'XLNG', profile: run8.sector_profile, run: run8, analysisAt: run8.horizon.start_date, horizon: hz(run8),
    edit: (j) => {
      j.summary = `Fictional ${HOSTILE} summary with **markdown** and [a link](javascript:alert(1)) and an unbroken ${'x'.repeat(160)} string.`;
      j.final_take = `Fictional ${HOSTILE} final take.`;
      j.bullish_facts[0].text = `Fictional ${HOSTILE} positive.`;
      j.bearish_facts[0].text = `Fictional <b>bold?</b> risk ${'y'.repeat(120)}.`;
      j.diagnostic_scores.legitimacy.rationale = `Fictional ${HOSTILE} rationale.`;
      j.investment_components.token_value_capture.rationale = `Fictional ${HOSTILE} capture.`;
      j.sources.push({ source_id: 'S8', url: 'javascript:alert(1)', title: `Hostile ${HOSTILE} source`, publisher: 'x', source_type: 'news', accessed_at: null });
      j.catalysts[0].title = `Vote ${HOSTILE} (FICTIONAL)`;
      j.next_metric_to_monitor.metric = `Metric ${HOSTILE}`;
    } }), { runId: run8.run_id }).report_id;
  notes.setConvictionNote(ws, p8.project_id, `FICTIONAL note ${HOSTILE}`, {});

  writeMarket(ws, IDS);
  require('../core/indexer').rebuildIndex(ws);
  return { ...t, ...out, LONG_NAME };
}

module.exports = { buildBriefWorkspace, reportText, IDS, LONG_NAME, HOSTILE, FIXTURE_DIR: path.join(__dirname, '..', 'fixtures') };
