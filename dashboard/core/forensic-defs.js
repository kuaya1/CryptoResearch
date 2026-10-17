'use strict';
// Forensics & Resilience: the versioned definitions a forensic receipt
// freezes by reference (forensics.js). Each one is published once and never
// edited in place: a change is the next version (cr-forensic-events@2 and so
// on), and a receipt is always read under the versions it names.
//
// Four outcomes are kept apart and can overlap. A working website does not
// establish healthy liquidity, and illiquidity does not establish fraud.
// Recovery is tracked as well as deterioration: crossing a threshold for a
// while never leaves a permanent label. A monitoring gap is Unknown, never
// continued failure or continued health.
//
// Thresholds marked as preferences are Eric's own screening choices (settings
// forensics.preferences), not universal rules, and the desk says so wherever
// it uses one.

const EVENTS_VERSION = 'cr-forensic-events@1';
const LIQUIDITY_VERSION = 'cr-forensic-liquidity@1';
const SCENARIOS_VERSION = 'cr-forensic-scenarios@1';
const PROBABILITY_GATE = 'cr-probability-gate@1';
const RUBRIC_VERSION = 'cr-forensic-rubric@1';
const PROMPT_VERSION = 'cr-forensic-prompt@1';
const CHALLENGE_VERSION = 'cr-forensic-challenge@1';
const REPORT_FORMAT = 'cr.forensic.v1';
const CHALLENGE_FORMAT = 'cr.forensic-challenge.v1';

// The timeline's fixed checkpoints, counted from a receipt's frozen origin.
const CHECKPOINTS = Object.freeze([
  { id: '72h', label: '72 hours', hours: 72 },
  { id: '7d', label: '7 days', hours: 7 * 24 },
  { id: '14d', label: '14 days', hours: 14 * 24 },
  { id: '30d', label: '30 days', hours: 30 * 24 },
  { id: '90d', label: '90 days', hours: 90 * 24 },
  { id: '120d', label: '120 days', hours: 120 * 24 },
]);
const CHECKPOINT_IDS = CHECKPOINTS.map((c) => c.id);
const HORIZON_HOURS = CHECKPOINTS[CHECKPOINTS.length - 1].hours;

// Eric's screening preferences (settings forensics.preferences). Defaults are
// starting points he can change; none is a universal rule.
const PREFERENCE_DEFAULTS = Object.freeze({
  exit_sizes_usd: [100, 500, 2000],
  exit_position_usd: 500,
  exit_cost_limit_pct: 5,
  delivery_window_days: 60,
  volume_review_fraction: 0.5,
  reported_liquidity_review_usd: null,
  volume_to_liquidity_review_ratio: null,
});
const PREFERENCE_NOTE = 'Your screening preferences (Settings, forensics), not universal rules. Change them and new receipts freeze the new values; saved receipts keep theirs.';

// cr-forensic-events@1. Hours are wall-clock hours. persistence: how long a
// reading must stay beyond the limit (and how many readings) before the event
// counts as occurred; recovery: the same for coming back within it;
// freshness: the oldest a latest reading may be for the state to be known.
const EVENTS = Object.freeze({
  liquidity_impairment: Object.freeze({
    id: 'liquidity_impairment',
    version: EVENTS_VERSION,
    label: 'Liquidity impairment',
    definition: 'The estimated cost of exiting a hypothetical position of your configured size (price impact plus fees) exceeds your configured limit, read from a supported executable quote or a reserve calculation that fits the pool\'s mechanism. A quote source that answers "no route" counts as beyond the limit; a provider error or a missing reading is unknown.',
    metric: 'exit_cost_pct',
    worse: 'higher',
    cadence: 'Each reading captured in an audit (executable quotes and constant-product reserves). This release has no automatic quote source, so readings arrive with audits.',
    cadence_hours: null,
    persistence: { hours: 72, min_readings: 2 },
    recovery: { hours: 72, min_readings: 2 },
    freshness_hours: 72,
    resolution: 'Occurred by a checkpoint when an episode was confirmed (beyond the limit in every reading for at least 72 hours, at least two readings) at or before it. Not occurred when readings cover the whole period from the origin to the checkpoint with no gap longer than the freshness window and no confirmed episode. Otherwise unresolved.',
    limits: 'An exit estimate is never a transaction. One pool or one route does not represent every route. Reported reserves are not depth. Illiquidity does not establish fraud.',
  }),
  operational_degradation: Object.freeze({
    id: 'operational_degradation',
    version: EVENTS_VERSION,
    label: 'Operational degradation',
    definition: 'A core product check that was previously observed passing fails in every reading for the persistence window: the endpoint is unavailable, or the advertised workflow stops completing.',
    metric: 'check_passes',
    worse: 'fail',
    cadence: 'Every 6 hours for each product check you approved, while monitoring is on; also readings captured in audits.',
    cadence_hours: 6,
    persistence: { hours: 72, min_readings: 3 },
    recovery: { hours: 12, min_readings: 2 },
    freshness_hours: 24,
    resolution: 'Occurred by a checkpoint when an episode was confirmed at or before it. Not occurred when readings cover the period with no gap longer than the freshness window. Otherwise unresolved.',
    limits: 'A check never observed passing establishes nothing (a wrong address, an unconfigured prototype). A single outage, a certificate problem or a slow answer is not degradation until it persists. A working website does not establish healthy liquidity or a working product workflow beyond what the check tests.',
  }),
  delivery_inactivity: Object.freeze({
    id: 'delivery_inactivity',
    version: EVENTS_VERSION,
    label: 'Delivery inactivity',
    definition: 'No qualifying public delivery was observed during your delivery window: no published release and no commit on the default branch of any public repository you approved for monitoring.',
    metric: 'days_since_delivery',
    worse: 'higher',
    cadence: 'Daily for each approved repository, while monitoring is on.',
    cadence_hours: 24,
    persistence: { hours: 0, min_readings: 1 },
    recovery: { hours: 0, min_readings: 1 },
    freshness_hours: 7 * 24,
    resolution: 'Occurred by a checkpoint when a reading at or before it saw no delivery within the window. Not occurred when readings cover the period with no gap longer than the freshness window. Otherwise unresolved.',
    limits: 'Private development, other hosts, off-chain work and quiet maintenance are not seen. A commit counts whatever its size; its substance is judged by the investigator at named commits, never by this check.',
  }),
  confirmed_discontinuation: Object.freeze({
    id: 'confirmed_discontinuation',
    version: EVENTS_VERSION,
    label: 'Confirmed discontinuation',
    definition: 'Direct, attributable evidence that the project has shut down or withdrawn support: an official announcement, the project\'s own documentation or governance record, or an on-chain action that ends the product, cited from a primary source in a saved assessment.',
    metric: 'attributable_evidence',
    worse: 'shutdown',
    cadence: 'Each saved assessment; never inferred by a monitor.',
    cadence_hours: null,
    persistence: null,
    recovery: null,
    freshness_hours: null,
    resolution: 'Occurred by a checkpoint when a saved assessment dated at or before it records attributable shutdown or withdrawal evidence that no later attributable reversal answers. Otherwise not established: absence of such evidence is never called health.',
    limits: 'A single outage, a silent social account, a certificate issue, a quiet repository or a price collapse does not establish discontinuation.',
  }),
});
const EVENT_IDS = Object.keys(EVENTS);

// cr-forensic-liquidity@1: which readings give an exit estimate.
const LIQUIDITY = Object.freeze({
  version: LIQUIDITY_VERSION,
  mechanisms: Object.freeze({
    aggregator: 'Executable quote from an aggregator or router (fees and price impact as the quote states them).',
    constant_product: 'Constant-product pool (x·y = k): the exit is calculated exactly from both reserves in token units and the pool fee.',
    concentrated: 'Concentrated liquidity (ticks): reported liquidity cannot be turned into depth without tick data; only an executable quote gives an estimate.',
    stable: 'Stable-swap curve: not calculated from reserves; only an executable quote gives an estimate.',
    orderbook: 'Order book: only a dated depth reading or an executable quote gives an estimate.',
    unknown: 'Mechanism not stated: no estimate from reserves.',
  }),
  quote_size_tolerance: 0.1,
  categories: Object.freeze({
    reported_reserves: 'Reported reserves: what a pool or a site says it holds. Not depth, and not what an exit would receive.',
    execution_estimates: 'Supported execution estimates: an executable quote at the size, or the exact constant-product calculation. Estimates, never transactions.',
    observed_volume: 'Observed trading volume: CoinGecko\'s 24-hour volume across the venues it tracks, as stored hourly by this desk. Volume is not exit capacity.',
    suspected_artificial: 'Suspected artificial activity: only findings that state the documented method behind them. The desk never calls volume organic or artificial by itself.',
  }),
  note: 'Never a transaction: estimates read quotes and reserves at one time. One pool does not represent every route, and a pool\'s base reserve is never assumed to be half its displayed USD liquidity.',
});

// cr-forensic-liquidity@2 (2026-10-16, after the independent review F08/F09):
// the same mechanisms as @1, read differently. The current reading of each
// route scope (chain, contract or pool, quote source, size) is its latest
// answer within the freshness window, never the cheapest answer of an hour.
// A cost is complete only when the network fee and the token's transfer tax
// are known (stated by the quote, or 0% or a figure in the contract screen);
// otherwise it is a lower bound ("at least"), which can show a cost over the
// limit but never a pass within it.
const LIQUIDITY_VERSION_2 = 'cr-forensic-liquidity@2';
const LIQUIDITY_2 = Object.freeze({
  ...LIQUIDITY,
  version: LIQUIDITY_VERSION_2,
  scope: 'A route scope is the chain, the contract or pool, the quote source or venue, and the size. Its current reading is its latest answer (a quote or "no route") within the freshness window; an earlier answer of the same scope is history.',
  completeness: 'A total cost needs the network fee (stated, or included in the quote) and the token\'s transfer tax (0% or a figure in the GoPlus contract screen). Without them the cost is "at least" that figure: it can show the exit over your limit, never within it.',
  one_way: 'Every estimate is a one-way sell into the quote currency; buying back is not included.',
});
// The derivation the tab and the checkpoint outcomes use now:
// cr-forensic-eligibility@1 (core/forensic-eligibility.js), liquidity@2, and
// lifecycle@2 (repository readings per observation batch with coverage; a
// valid zero is a reading; incomplete product reads are no reading).
const METHOD_2 = Object.freeze({
  version: 'cr-forensic-method@2',
  parts: Object.freeze(['cr-forensic-eligibility@1', LIQUIDITY_VERSION_2, 'cr-forensic-lifecycle@2', 'cr-forensic-scenarios@2']),
  previous: 'cr-forensic-method@1',
  note: 'Outcomes recorded under the earlier method stay on record; where this method reads a different outcome, a correction line names both methods and the reason.',
});
// cr-forensic-liquidity@3 (2026-10-17, re-audit R04): as @2, except that a
// positive transfer tax is never applied as a multiplier. Its mechanism and
// whether a quote includes it are not known, so with a positive tax the cost
// without it is a lower bound, and proceeds and cost share one basis
// (receives, less an external network fee).
const LIQUIDITY_VERSION_3 = 'cr-forensic-liquidity@3';
const LIQUIDITY_3 = Object.freeze({
  ...LIQUIDITY_2,
  version: LIQUIDITY_VERSION_3,
  completeness: 'A total cost needs the network fee (stated, or included in the quote) and a transfer tax known to be 0% (from the GoPlus contract screen within 7 days of the reading). With a positive tax, how it applies and whether the quote includes it are not known, so the cost shown, without it, is "at least" that figure: it can show the exit over your limit, never within it.',
});
// The derivation the tab and the checkpoint outcomes use now (method@3,
// 2026-10-17, after the re-audit R01-R07): cr-forensic-eligibility@2
// (exact official host, full chain references conferring no attribution,
// every cited source usable, explicit contracts, bound repositories),
// liquidity@3, lifecycle@3 (a receipt's projection must agree with its
// verified original before it feeds anything) and scenarios@3 (a day's
// readings count from when they were observed).
const METHOD_VERSION = 'cr-forensic-method@3';
const METHOD = Object.freeze({
  version: METHOD_VERSION,
  parts: Object.freeze(['cr-forensic-eligibility@2', LIQUIDITY_VERSION_3, 'cr-forensic-lifecycle@3', 'cr-forensic-scenarios@3']),
  previous: 'cr-forensic-method@2',
  note: 'Outcomes recorded under an earlier method stay on record; where this method reads a different outcome, a correction line names both methods and the reason.',
});

// cr-forensic-scenarios@1: conditional threshold estimates.
const SCENARIOS = Object.freeze({
  version: SCENARIOS_VERSION,
  label: 'Conditional threshold estimate—not a calibrated probability.',
  min_points: 7,
  min_span_days: 14,
  min_weekly_changes: 3,
  freshness_hours: 48,
  window_days: 60,
  kinds: Object.freeze({
    deterioration: 'The worst 7-day change observed in the window repeats every week.',
    stabilization: 'The latest observed level holds.',
    recovery: 'The best 7-day change observed in the window repeats every week.',
  }),
  invalidation: 'A reading outside the range seen in the window, a change of data source or definition, or a structural event (a listing or delisting, a migration, a new pool or route) invalidates the projection.',
  not_projected: Object.freeze({
    operational_degradation: 'Not projected: outages are not forecast from a trend. The state, its persistence and recovery are observed.',
    confirmed_discontinuation: 'Never projected: it is established only by attributable evidence.',
  }),
});
// cr-forensic-scenarios@2 (2026-10-16, review F07): the same assumptions and
// minimums; a valid zero is a reading. The latest valid reading, zero
// included, decides whether the level is already crossed; rates of change
// use the positive readings only, and from a zero no date is projected. A
// missing day stays missing, never zero.
const SCENARIOS_VERSION_2 = 'cr-forensic-scenarios@2';
const SCENARIOS_2 = Object.freeze({ ...SCENARIOS, version: SCENARIOS_VERSION_2, zero: 'A zero reading is a reading: it decides the current state. A rate of change cannot be projected from zero, so no date is estimated from it.' });
// cr-forensic-scenarios@3 (2026-10-17, re-audit R05): as @2; a day's
// readings count from the time they were observed (never hidden until a noon
// label passes), and today's point is labeled a partial day.
const SCENARIOS_VERSION_3 = 'cr-forensic-scenarios@3';
const SCENARIOS_3 = Object.freeze({ ...SCENARIOS_2, version: SCENARIOS_VERSION_3, partial_day: 'Today\'s point is the median of the readings so far today, labeled a partial day; future readings are never included.' });

// cr-probability-gate@1. A numerical probability is shown only for a method
// registered here with: historical data under the same event definitions,
// evaluation on later unseen periods, calibration results, uncertainty
// estimates and, for comparable-project cohorts, inclusion rules and sample
// sizes. No method is registered in this release, so no percentage is shown,
// whoever supplies it: a model's figure, or several models agreeing, is not
// calibration.
const PROBABILITY_METHODS = Object.freeze({});
const PROBABILITY = Object.freeze({
  version: PROBABILITY_GATE,
  requirements: Object.freeze([
    'A documented method with a registered ID and version.',
    'Historical outcomes under the same versioned event definitions.',
    'Evaluation on later, unseen periods (no fitting on the outcomes it is scored on).',
    'Calibration results and uncertainty estimates.',
    'For comparable-project cohorts: inclusion rules and sample sizes.',
    'Cumulative probability of an event by a deadline never decreases as the deadline extends; overlapping events are not forced to sum to 100%.',
  ]),
  registered: Object.keys(PROBABILITY_METHODS),
  note: 'No probability method meets the gate yet, so the timeline shows no percentage.',
});

// cr-forensic-rubric@1: integrity grades, 0-100, higher is better. Each is
// its own diagnostic: never averaged, never combined with the investment
// grade, and unknown is never zero.
const RUBRIC = Object.freeze({
  version: RUBRIC_VERSION,
  categories: Object.freeze([
    ['product_reality', 'Product reality', 'Advertised capabilities observed working, at the scale claimed.'],
    ['disclosure_consistency', 'Disclosure consistency', 'Public claims match the retrieved records.'],
    ['control_transparency', 'Control transparency', 'Mint, freeze, upgrade, treasury and fee-setting powers are disclosed, constrained and used as disclosed.'],
    ['incentive_alignment', 'Incentive alignment', 'Creator allocations, vesting, fee destinations and observed transfers are consistent with what was disclosed.'],
    ['liquidity_resilience', 'Liquidity resilience', 'A sized exit stays within limits on supported estimates.'],
    ['delivery_continuity', 'Delivery continuity', 'Substantive public delivery over time.'],
  ]),
  anchors: Object.freeze([
    [90, 'Strong evidence of soundness'],
    [75, 'Sound, with minor gaps'],
    [60, 'Mixed'],
    [40, 'Material concerns'],
    [0, 'Severe concerns'],
  ]),
  rule: 'A grade needs the findings it rests on and a confidence; without them it is unknown. Grades are diagnostics: never averaged into a total, never a truth score.',
});
const RUBRIC_IDS = RUBRIC.categories.map(([id]) => id);

// The seven evidence areas an assessment covers (its evidence coverage).
const AREAS = Object.freeze([
  ['product', 'Advertised capabilities versus observed product behaviour'],
  ['code', 'Substantive code and releases at identified commits'],
  ['controls', 'Mint, freeze, upgrade, treasury and fee-setting controls'],
  ['allocations', 'Creator allocations, vesting, fee destinations and disclosed funding'],
  ['wallets', 'Wallet funding, acquisitions, current holdings and later transfers'],
  ['liquidity', 'Liquidity, trading activity, executable exits and significant changes'],
  ['claims', 'Material discrepancies between public claims and retrieved records'],
]);
const AREA_IDS = AREAS.map(([id]) => id);

const FINDING_KINDS = ['observation', 'inference', 'hypothesis'];
const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'];
const CONFIDENCES = ['high', 'medium', 'low'];
// Wallet findings keep three things apart; inferred common control is never an observation.
const WALLET_RELATIONS = ['launch_acquisition', 'present_holding', 'inferred_common_control'];
// Bases that alone never establish common control.
const WEAK_CONTROL_BASES = ['shared_exchange_funder', 'similar_balances', 'zero_balance_deployer', 'similar_timing'];
const DISCONTINUATION = ['shutdown', 'support_withdrawn', 'reversal'];
const SOURCE_TYPES = ['primary', 'chain', 'repository', 'secondary', 'ai_summary', 'other'];
const COVERAGE = ['covered', 'partial', 'unknown'];
const VERDICTS = ['supported', 'overstated', 'unsupported', 'needs_evidence', 'not_checked'];

// Checks this release cannot do automatically, said in the tab.
const UNSUPPORTED = Object.freeze([
  ['executable_quotes', 'Automatic executable exit quotes only on the chains you approve per project, sold for USDC: Solana through Jupiter; Ethereum, Base, Arbitrum One, Optimism, Polygon, Avalanche C-Chain, Linea, Unichain and Sonic through KyberSwap. Other chains, other quote currencies, single venues and order books come from quotes and reserves captured in audits, with their source and time.'],
  ['dex_server', 'DexScreener data is read by your browser on demand and never stored, so the monitor does not use it.'],
  ['wallet_tracing', 'Automatic tracing of creator or treasury wallets: not in this release. Wallet findings come from the investigator\'s cited transactions.'],
  ['other_code_hosts', 'Repositories outside GitHub, and private repositories, are not monitored.'],
  ['browser_workflows', 'Product checks are single HTTPS requests (status and an expected text). A workflow that needs a browser, a wallet or a signature is checked by the investigator, never by the server.'],
  ['revenue_runway', 'Hosting bills, API spending, treasury runway, revenue and motives are not inferred from a technology stack. Unavailable data is not zero revenue.'],
]);

const HASH_NOTE = 'A SHA-256 shows that captured content has not changed since it was captured; it does not show that what it says is true.';

module.exports = {
  EVENTS_VERSION,
  LIQUIDITY_VERSION,
  LIQUIDITY_VERSION_2,
  LIQUIDITY_2,
  LIQUIDITY_VERSION_3,
  LIQUIDITY_3,
  METHOD_VERSION,
  METHOD,
  METHOD_2,
  SCENARIOS_VERSION,
  SCENARIOS_VERSION_2,
  SCENARIOS_2,
  SCENARIOS_VERSION_3,
  SCENARIOS_3,
  PROBABILITY_GATE,
  RUBRIC_VERSION,
  PROMPT_VERSION,
  CHALLENGE_VERSION,
  REPORT_FORMAT,
  CHALLENGE_FORMAT,
  CHECKPOINTS,
  CHECKPOINT_IDS,
  HORIZON_HOURS,
  PREFERENCE_DEFAULTS,
  PREFERENCE_NOTE,
  EVENTS,
  EVENT_IDS,
  LIQUIDITY,
  SCENARIOS,
  PROBABILITY,
  PROBABILITY_METHODS,
  RUBRIC,
  RUBRIC_IDS,
  AREAS,
  AREA_IDS,
  FINDING_KINDS,
  SEVERITIES,
  CONFIDENCES,
  WALLET_RELATIONS,
  WEAK_CONTROL_BASES,
  DISCONTINUATION,
  SOURCE_TYPES,
  COVERAGE,
  VERDICTS,
  UNSUPPORTED,
  HASH_NOTE,
};
