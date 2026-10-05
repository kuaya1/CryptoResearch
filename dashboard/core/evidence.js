'use strict';
// Source types and read-time evidence checks on a report's claims
// (independent review, 2026-10-03). The checks flag; they never change a
// score, a grade, a stored record or the original report.
//
// Source types: the accepted list (SOURCE_TYPES, also in the report schema
// and the appendix of cr-research-prompt@4 and later). Words models use instead are read
// as their nearest type (SYNONYMS), and the source's host settles what the
// word leaves open: a block explorer is on-chain data, CoinGecko is a data
// aggregator. An AI-generated summary (CoinMarketCap's AI pages and the like)
// is an AI summary whatever type it was given.
//
// A primary source is the artifact itself: the project's own site, docs,
// repository or announcement; the contract, transaction or a query on chain;
// the audit report; an exchange's own listing or order book. Aggregators,
// news, research, social posts and AI summaries are secondary.
//
// Checks (each names the claim, why, and what would settle it):
//   ai_summary_as_verified    tagged [V], and its only support is an AI summary
//   critical_without_primary  an audit, deployment, supply change, live
//                             liquidity or dated catalyst tagged [V] without a
//                             primary source
//   critical_without_date     a critical claim without an as-of date
//   fees_not_reproducible     a fee or revenue figure without its period, or
//                             without a query, dashboard or explorer view that
//                             reproduces it
//   critical_without_excerpt  (reports from cr-research-prompt@4 on, which were asked
//                             for it) a critical [V] claim with neither an
//                             excerpt of the artifact nor the query used
//
// Category grades checked against the evidence the prompt asks for beside
// them (reports from cr-research-prompt@5 on, which were asked for the
// code_review and chart_cycle blocks). Each flag names the category it
// concerns, so it is shown beside that grade:
//   code_score_without_source       code quality is scored although the report
//                                   says the source could not be read
//   code_score_without_inspection   code quality is scored with no named
//                                   implementation file read at a stated
//                                   revision (a commit hash or release tag):
//                                   a branch name is not a revision, and
//                                   commit history, releases, test-file counts
//                                   or tests alone are repository activity,
//                                   not implementation read
//   chart_without_observation_date  a chart, cycle or volume grade is scored
//                                   and the chart reading gives no day for the
//                                   latest candle or quote it used
//   chart_observation_stale         that latest observation is more than
//                                   STALE_CHART_DAYS older than the report
//   chart_observation_after_report  it is dated after the report itself
//   liquidity_without_depth         volume and executable liquidity is scored
//                                   without a stated volume baseline and a
//                                   dated spread, depth or order-book figure:
//                                   a venue list, aggregate volume or a
//                                   statement that depth was not retrieved is
//                                   not one
//   executable_liquidity_unsupported  (low) the timing and executable
//                                   liquidity component is scored with no such
//                                   figure: its executable-liquidity part rests
//                                   on no measurement, while its timing
//                                   judgment can stand on the chart
// Older price history is context, never a flag: only the date of the latest
// observation behind a current reading is checked. A claim a dated catalyst
// cites is checked as catalyst evidence only when it is not a market
// observation (a past price, volume or chart reading). A report without these
// flags is not thereby verified; the checks are structural, and a claim tagged
// [V] is the researcher's own classification of its source, not the desk's.

// What [V] means on this desk, said wherever the tags are shown.
const TAG_NOTE = 'A claim tagged [V] is the researcher\'s own classification of its source; the desk does not verify it independently.';

const SOURCE_TYPES = ['official', 'onchain_data', 'data_aggregator', 'exchange', 'audit', 'news', 'research', 'social', 'ai_summary', 'other'];
const PRIMARY = new Set(['official', 'onchain_data', 'audit', 'exchange']);
const CRITICAL_KINDS = ['audit', 'deployment', 'realized_fees', 'supply_change', 'liquidity', 'catalyst'];
const KIND_LABEL = { audit: 'an audit', deployment: 'a deployment', realized_fees: 'a fee or revenue figure', supply_change: 'a supply change', liquidity: 'live liquidity', catalyst: 'a dated catalyst' };
const PRIMARY_HINT = {
  audit: 'the audit report itself (from the auditor or the project\'s repository)',
  deployment: 'the deployed contract or transaction on a block explorer',
  realized_fees: 'an on-chain query or the protocol\'s own fee dashboard, with the period',
  supply_change: 'the contract, the transaction or the official announcement, with its effective date',
  liquidity: 'the order book or pool itself, on a dated snapshot',
  catalyst: 'the official announcement with its date window',
};

const key = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const SYNONYMS = new Map(Object.entries({
  official: ['official', 'project', 'project_website', 'project_site', 'website', 'official_website', 'official_site', 'project_documentation', 'documentation', 'docs', 'project_docs', 'official_docs', 'official_documentation', 'whitepaper', 'litepaper', 'project_source', 'project_blog', 'official_blog', 'blog', 'governance', 'governance_forum', 'governance_proposal', 'github', 'code_repository', 'repository', 'source_code', 'official_announcement', 'announcement', 'project_announcement', 'press_release', 'tokenomics', 'official_x', 'official_twitter', 'primary'],
  onchain_data: ['onchain', 'on_chain', 'onchain_data', 'on_chain_data', 'block_explorer', 'blockchain_explorer', 'explorer', 'chain_explorer', 'chain_data', 'blockchain_data', 'dune', 'dune_dashboard', 'dune_query', 'onchain_analytics', 'on_chain_analytics', 'onchain_query', 'smart_contract', 'contract', 'transaction', 'subgraph'],
  data_aggregator: ['aggregator', 'data_aggregator', 'market_data', 'market_aggregator', 'price_aggregator', 'data_provider', 'analytics', 'analytics_platform', 'defi_analytics', 'tvl_aggregator', 'research_database', 'database', 'data_platform', 'market_snapshot', 'price_tracker', 'market_tracker', 'token_unlock_tracker', 'unlock_tracker'],
  exchange: ['exchange', 'centralized_exchange', 'cex', 'dex', 'decentralized_exchange', 'exchange_announcement', 'exchange_listing', 'order_book', 'trading_venue', 'exchange_page'],
  audit: ['audit', 'security_audit', 'audit_report', 'security_review', 'auditor', 'security', 'security_rating', 'security_score'],
  news: ['news', 'news_article', 'media', 'press', 'journalism', 'article', 'secondary_reporting', 'news_report', 'crypto_news', 'news_media'],
  research: ['research', 'independent_analysis', 'institutional_research', 'analysis', 'market_analysis', 'research_report', 'third_party_research', 'independent_research', 'academy', 'report', 'analyst_report', 'education'],
  social: ['social', 'social_media', 'twitter', 'x', 'tweet', 'x_post', 'discord', 'telegram', 'reddit', 'community', 'forum', 'youtube', 'podcast'],
  ai_summary: ['ai_summary', 'ai', 'ai_generated', 'ai_overview', 'ai_summary_page', 'llm', 'chatbot', 'cmc_ai', 'ai_research'],
  other: ['other', 'unknown', 'provided_context', 'context', 'dashboard_packet', 'packet'],
}).flatMap(([type, words]) => words.map((w) => [w, type])));

// Hosts and paths that settle a type. AI summaries win over any type given.
const AI_SUMMARY = [/(^|\.)coinmarketcap\.com\/cmc-ai(\/|$)/, /(^|\.)perplexity\.ai(\/|$)/, /(^|\.)chatgpt\.com(\/|$)/, /(^|\.)chat\.openai\.com(\/|$)/, /(^|\.)gemini\.google\.com(\/|$)/, /(^|\.)grok\.com(\/|$)/, /(^|\.)x\.com\/i\/grok/, /(^|\.)poe\.com(\/|$)/, /(^|\.)phind\.com(\/|$)/, /(^|\.)copilot\.microsoft\.com(\/|$)/];
const HOSTS = [
  ['onchain_data', /(^|\.)(etherscan\.io|bscscan\.com|basescan\.org|arbiscan\.io|polygonscan\.com|snowtrace\.io|ftmscan\.com|lineascan\.build|scrollscan\.com|blastscan\.io|solscan\.io|solana\.fm|explorer\.solana\.com|tronscan\.org|suiscan\.xyz|suivision\.xyz|aptoscan\.com|mintscan\.io|subscan\.io|statescan\.io|tonviewer\.com|tonscan\.org|dune\.com|flipsidecrypto\.xyz|blockchair\.com|mempool\.space)$/],
  ['onchain_data', /blockscout/],
  ['data_aggregator', /(^|\.)(coinmarketcap\.com|coingecko\.com|defillama\.com|tokenterminal\.com|artemis\.xyz|app\.artemis\.xyz|messari\.io|cryptorank\.io|dexscreener\.com|geckoterminal\.com|birdeye\.so|tokenomist\.ai|token\.unlocks\.app|tokenunlocks\.app|dropstab\.com|coincarp\.com|l2beat\.com|growthepie\.xyz|rwa\.xyz|dappradar\.com)$/],
  ['exchange', /(^|\.)(binance\.com|kucoin\.com|gate\.com|gate\.io|okx\.com|bybit\.com|coinbase\.com|kraken\.com|bitget\.com|mexc\.com|htx\.com|upbit\.com|bithumb\.com|bitstamp\.net|crypto\.com|uniswap\.org|app\.uniswap\.org|raydium\.io|jup\.ag|aerodrome\.finance|pancakeswap\.finance|curve\.fi|hyperliquid\.xyz)$/],
  ['audit', /(^|\.)(certik\.com|sherlock\.xyz|code4rena\.com|cantina\.xyz|openzeppelin\.com|trailofbits\.com|halborn\.com|peckshield\.com|slowmist\.com|hacken\.io|cyberscope\.io|spearbit\.com|zellic\.io|osec\.io|ottersec\.com|quantstamp\.com|chainsecurity\.com|consensys\.io|immunefi\.com|veridise\.com|sigmaprime\.io|mixbytes\.io|omniscia\.io|beosin\.com)$/],
  ['social', /(^|\.)(x\.com|twitter\.com|t\.me|discord\.com|discord\.gg|reddit\.com|youtube\.com|youtu\.be)$/],
];
// Words a model uses for "some source" that say nothing about its kind.
const VAGUE = new Set(['other', 'independent_source', 'third_party', 'secondary', 'source', 'web', 'website_other', 'unknown']);

function hostOf(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname.toLowerCase().replace(/^www\./, ''), path: u.pathname.toLowerCase() };
  } catch (_) {
    return null;
  }
}

function domainOf(url) {
  const h = hostOf(url);
  if (!h) return null;
  const parts = h.host.split('.');
  return parts.slice(-2).join('.');
}

// The accepted type of one source, how it was settled, and whether it is
// primary. officialDomain: the project's own website domain, if verified.
function normalizeSourceType(raw, url, { officialDomain = null } = {}) {
  const given = raw === null || raw === undefined || raw === '' ? null : String(raw);
  const k = key(given);
  const hp = url ? hostOf(url) : null;
  const where = hp ? `${hp.host}${hp.path}` : '';
  if (hp && AI_SUMMARY.some((re) => re.test(where))) return { type: 'ai_summary', given, how: 'host', primary: false };
  let type = SOURCE_TYPES.includes(k) ? k : SYNONYMS.get(k) || null;
  let how = type === null ? null : SOURCE_TYPES.includes(k) ? 'given' : 'synonym';
  if ((type === null || type === 'other' || VAGUE.has(k)) && hp) {
    const hit = HOSTS.find(([, re]) => re.test(hp.host));
    if (hit) {
      type = hit[0];
      how = 'host';
    } else if (officialDomain && (hp.host === officialDomain || hp.host.endsWith(`.${officialDomain}`))) {
      type = 'official';
      how = 'host';
    }
  }
  if (!type) {
    type = 'other';
    how = given ? 'unrecognized' : 'missing';
  }
  return { type, given, how, primary: PRIMARY.has(type) };
}

const has = (re, s) => re.test(String(s || ''));
const AUDIT_RE = /\baudit(s|ed|or|ors|ing)?\b|\bsecurity (review|assessment|score|rating)\b|\bcertik\b|\bbug bounty\b/i;
const DEPLOY_RE = /\b(deployed|deployment|mainnet (launch|live|went live)|launched on mainnet|went live on mainnet|contract (is )?verified|verified contract)\b/i;
const SUPPLY_RE = /\b(unlock(s|ed|ing)?|vesting|cliff|emission(s)?|burn(ed|s|t)?|buyback(s)?|minted|mint authority|inflation(ary)?|supply (cut|reduction|increase|change|expansion))\b/i;
const LIQ_RE = /\b(liquidity|order ?book|market depth|depth|slippage|bid[- ]ask|spread)\b/i;
const FEE_TEXT_RE = /\b(fees?|revenue|earnings)\b/i;
const FEE_METRIC_RE = /(fee|revenue|earning|income)/i;
const NUMBER_RE = /(\$\s?\d|\d[\d,.]*\s?(k|m|b|million|billion|usd|%))/i;

// ---- what the evidence says, not only whether a field holds text ----------

// Clauses of a free-text reading: split at semicolons, line breaks and full
// stops that end a sentence (never the point inside "0.3%").
const clauses = (t) => String(t || '').split(/[;\n]+|\.(?=\s|$)/).map((x) => x.trim()).filter(Boolean);

// A spread, depth, order-book or slippage term, or a band around the price.
const DEPTH_TERM_RE = /\b(depth|order ?books?|spreads?|slippage|bid[- ]ask|price impact)\b|±\s?\d|\bwithin\s+[±+]?\s?\d+(\.\d+)?\s?%|\bpool (liquidity|reserves?|tvl)\b/i;
// A measured figure: money, a percentage or basis points.
const MEASURE_RE = /(\$\s?\d|\d[\d,.]*\s?(k|m|bn?|million|billion|thousand|usd[ct]?|%|bps|bp|basis points)(?![a-z]))/i;
// A statement that the data is missing, aimed at the depth term it names.
const MISSING_DEPTH_RE = /\b(no|not|n\/a|without|unavailable|unknown|missing|lack\w*|could\s?n[o']t|cannot|can'?t|unable to|failed to|did\s?n[o']t|never)\b[^.;]{0,48}\b(depth|order ?books?|spreads?|slippage|bid[- ]ask|price impact|liquidity data)\b|\b(depth|order ?books?|spreads?|slippage|bid[- ]ask)\b[^.;]{0,40}\b((not|un)\s?(available|retrieved|known|accessible|measured|captured|obtained|found|read)|n\/a|unknown|missing)\b/i;
const MISSING_WORDS_RE = /^\s*(unknown|none|n\/a|null|not\b|no\b|unavailable|missing|could\s?n[o']t|cannot|unable|not available)/i;
const ISO_DAY_RE = /\b\d{4}-\d{2}-\d{2}\b/;

// What a liquidity reading holds: a spread, depth or order-book figure (not
// a venue list, aggregate volume or a statement that depth is missing), and
// whether that figure is dated (in the reading, or by the chart snapshot it
// belongs to).
function depthReading(cc) {
  const text = cc && typeof cc.liquidity === 'string' ? cc.liquidity.trim() : '';
  const parts = clauses(text);
  const measured = parts.filter((p) => DEPTH_TERM_RE.test(p) && MEASURE_RE.test(p) && !MISSING_DEPTH_RE.test(p));
  const says = !text ? 'none' : measured.length ? 'figure' : parts.some((p) => MISSING_DEPTH_RE.test(p)) || MISSING_WORDS_RE.test(text) ? 'missing' : 'no_figure';
  const dated = Boolean(measured.some((p) => ISO_DAY_RE.test(p) && dayOf(p.match(ISO_DAY_RE)[0]) !== null) || dayOf(cc && cc.data ? cc.data.latest_observation_at : null) !== null);
  return { text, says, dated };
}

// A volume baseline the reading states (not "unknown" or "not available").
const statedText = (v) => typeof v === 'string' && v.trim() !== '' && !MISSING_WORDS_RE.test(v);

// A stated revision: a commit hash or a release tag, never a branch name
// ("main", "HEAD", "latest") or a date alone.
const BRANCH_ONLY_RE = /^(the\s+)?(main|master|head|develop|dev|trunk|latest|default|default branch|current|tip|n\/a|unknown|none)(\s+branch)?$/i;
function statedRevision(v) {
  const t = typeof v === 'string' ? v.trim() : '';
  if (!t || BRANCH_ONLY_RE.test(t)) return false;
  const hashes = t.match(/\b[0-9a-f]{7,40}\b/gi) || [];
  if (hashes.some((x) => /[a-f]/i.test(x) && (x.length >= 12 || /\d/.test(x)))) return true;
  return /(^|[\s@:/(])v?\d+\.\d+(\.\d+)?([-+][0-9a-z.]+)?(?=$|[\s),;])/i.test(t);
}

// Implementation source files named in files_inspected. A test file, a
// document, or an entry that describes repository activity (commit history,
// releases, "38 test files") is not one.
const SOURCE_FILE_RE = /[\w@.\/-]*[\w-]\.(sol|vy|rs|go|ts|tsx|js|jsx|mjs|cjs|py|move|cairo|c|cc|cpp|h|hpp|java|kt|scala|swift|rb|ex|exs|erl|zig|hs|ml|fc|func|tact|circom|nr|huff|yul|cs|fs|dart|clar|aleo|leo|sw|sway)\b/i;
const TEST_FILE_RE = /(^|[\/])(tests?|__tests__|specs?|testing|fuzz|invariants?|mocks?)[\/]|\.t\.sol$|[._-](test|spec)\.[a-z]+$|_test\.[a-z]+$|(^|[\/])test_[\w-]+\.[a-z]+$|(^|[\/])\w*Tests?\.(java|kt|swift|cs)$/i;
function implementationFiles(files) {
  return (Array.isArray(files) ? files : []).map((x) => (typeof x === 'string' ? x.match(SOURCE_FILE_RE) : null)).filter(Boolean).map((m) => m[0]).filter((p) => !TEST_FILE_RE.test(p));
}

// Which critical kind a claim is, if any: the model's own label (asked for
// from cr-research-prompt@4 on) or, for older reports, what the claim says.
function criticalKind(claim, catalystClaims) {
  if (claim.critical_kind && CRITICAL_KINDS.includes(claim.critical_kind)) return claim.critical_kind;
  const text = claim.text || '';
  const metric = claim.metric_id || '';
  if (FEE_METRIC_RE.test(metric) || (FEE_TEXT_RE.test(text) && NUMBER_RE.test(text))) return 'realized_fees';
  if (AUDIT_RE.test(text)) return 'audit';
  if (SUPPLY_RE.test(text) || /unlock|emission|burn|buyback|vesting/i.test(metric)) return 'supply_change';
  // Live liquidity is a measurement: a figure, or a liquidity metric.
  if (((LIQ_RE.test(text) && NUMBER_RE.test(text)) || /liquidity|depth|spread|slippage/i.test(metric)) && !MISSING_DEPTH_RE.test(text)) return 'liquidity';
  if (DEPLOY_RE.test(text)) return 'deployment';
  if (catalystClaims.has(claim.claim_id) && !marketObservation(claim)) return 'catalyst';
  return null;
}

// A past market reading (a price, volume, market cap or chart observation)
// with no forward event in it. A dated catalyst may cite one as context; it
// is not evidence of the catalyst, so it is not checked as one.
const MARKET_TEXT_RE = /\b(price[sd]?|traded|trading (at|between|range)|closed?|candles?|chart|all[- ]time (high|low)|ath|atl|drawdown|fell|dropped|declined|rallied|rose|gained|down \d|up \d|market cap|fdv|volume|support|resistance|range[- ]bound|consolidat\w*|breakout|breakdown)\b/i;
const MARKET_METRIC_RE = /price|market_?cap|mcap|fdv|volume|return|change_|drawdown|\bath\b|\batl\b|ohlc|candle/i;
const FORWARD_RE = /\b(launch(es|ing)?|release[sd]?|upgrade|vote|proposal|listing|unlock(s|ing)?|mainnet|testnet|integration|partnership|announce[sd]?|scheduled|planned|roadmap|will|expected|deadline|hard ?fork|airdrop|tge|halving|burn|vesting|cliff|deploy\w*|go(es)? live)\b/i;
function marketObservation(claim) {
  const text = String(claim.text || '');
  const market = MARKET_METRIC_RE.test(String(claim.metric_id || '')) || MARKET_TEXT_RE.test(text);
  return market && !FORWARD_RE.test(text);
}

const tagOf = (t) => {
  const m = String(t || '').toUpperCase().match(/^\[?([VCIS])\]?$/);
  return m ? m[1] : null;
};
const shortUrl = (u) => {
  const hp = u ? hostOf(u) : null;
  if (!hp) return null;
  const p = hp.path.length > 32 ? `${hp.path.slice(0, 31)}…` : hp.path;
  return `${hp.host}${p === '/' ? '' : p}`;
};
// Reports written for cr-research-prompt@4 and later were asked for an
// excerpt of the source or the query used; from @5 on, for the code that was
// read and the dated data behind the chart reading.
const promptAtLeast = (v, n) => {
  const m = /^cr-research-prompt@(\d+)$/.exec(String(v || '').trim());
  return Boolean(m) && Number(m[1]) >= n;
};
const asksForExcerpt = (v) => promptAtLeast(v, 4);

const CHART_CATEGORIES = ['chart_structure', 'cycle_timing', 'volume_liquidity'];
const CATEGORY_LABEL = { code_quality: 'Code quality', chart_structure: 'Chart structure', cycle_timing: 'Cycle position and catalyst timing', volume_liquidity: 'Volume confirmation and executable liquidity' };
const STALE_CHART_DAYS = 7;
const DAY_MS = 86400000;

// A category grade given as a number (or a range), as text; null otherwise.
function scoredText(s) {
  if (!s || (s.status !== 'scored' && s.status !== 'range')) return null;
  return s.status === 'range' ? `${s.low}-${s.high}` : String(s.value);
}

// The calendar day a date or date-time names, as written (YYYY-MM-DD is what
// the prompt asks for), in ms at UTC midnight; null when it names no day.
function dayOf(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (m) {
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return new Date(t).getUTCDate() === Number(m[3]) ? t : null;
  }
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
const ymd = (t) => new Date(t).toISOString().slice(0, 10);
const names = (ids) => ids.map((id) => CATEGORY_LABEL[id] || id).join(', ').replace(/, ([^,]*)$/, ' and $1');

// The category checks of one assessment (see the header). Returns the flags
// and how many scored grades were checked.
function categoryChecks(a) {
  const flags = [];
  if (!promptAtLeast(a.prompt_version, 5)) return { flags, checked: 0 };
  const scores = a.diagnostic_scores || {};
  let checked = 0;
  const code = scoredText(scores.code_quality);
  if (code !== null) {
    checked += 1;
    const cr = a.code_review || null;
    const repos = cr && Array.isArray(cr.repositories) ? cr.repositories.filter(Boolean) : [];
    // Read means named implementation files at a stated revision; repository
    // activity (commit history, releases, test-file counts) is not reading.
    const withImpl = repos.filter((r) => implementationFiles(r.files_inspected).length);
    const read = withImpl.filter((r) => statedRevision(r.commit));
    const listed = repos.flatMap((r) => (Array.isArray(r.files_inspected) ? r.files_inspected.filter((x) => typeof x === 'string' && x.trim()) : []));
    const base = { claim_id: null, category: 'code_quality', categories: ['code_quality'], kind: null, source_ids: [] };
    if (cr && cr.source_access === 'none') {
      flags.push({ ...base, rule: 'code_score_without_source', severity: 'high', message: `Code quality is scored ${code}, but the report says the source could not be read (source access: none). The prompt asks for code quality to be unknown when the source cannot be read.` });
    } else if (!read.length) {
      const quote = (xs) => xs.slice(0, 3).map((x) => `"${String(x).trim().slice(0, 48)}"`).join(', ') + (xs.length > 3 ? ` and ${xs.length - 3} more` : '');
      const vague = withImpl.map((r) => r.commit).filter((c) => typeof c === 'string' && c.trim());
      const why = !cr ? 'the report has no account of the code it read'
        : !repos.length ? 'no repository is recorded as read'
          : withImpl.length && vague.length ? `its implementation files are recorded at ${quote(vague)}, a branch or description rather than a commit hash or release tag, so the code read cannot be pinned`
            : withImpl.length ? 'files are listed without the commit they were read at'
              : listed.length ? `what it lists as inspected (${quote(listed)}) is repository activity, tests or documents, not a named implementation file`
                : 'no inspected files are listed';
      flags.push({ ...base, rule: 'code_score_without_inspection', severity: 'medium', message: `Code quality is scored ${code}, but ${why}. The prompt asks for the repository, the commit and the implementation files read; commit history, releases and test counts are activity, not inspection. Without them code quality is unknown.` });
    }
  }
  const chart = CHART_CATEGORIES.filter((id) => scoredText(scores[id]) !== null);
  if (chart.length) {
    checked += chart.length;
    const cc = a.chart_cycle || null;
    const raw = cc && cc.data ? cc.data.latest_observation_at : null;
    const obs = dayOf(raw);
    const report = dayOf(a.analysis_at);
    const are = chart.length === 1 ? 'is' : 'are';
    const base = { claim_id: null, category: chart[0], categories: chart, kind: null, source_ids: [] };
    // message names every grade concerned (the evidence list shows it once);
    // beside says it for the one grade it is shown next to.
    if (obs === null) {
      const what = !cc ? 'the report has no chart reading' : raw ? `its chart reading dates the latest observation "${String(raw).slice(0, 40)}", which names no day` : 'its chart reading gives no date for the latest observation';
      const beside = !cc ? 'The report gives no chart reading behind this grade.' : raw ? `The chart reading behind this grade dates its latest observation "${String(raw).slice(0, 40)}", which names no day.` : 'The chart reading behind this grade gives no date for its latest observation.';
      flags.push({ ...base, rule: 'chart_without_observation_date', severity: 'medium', message: `${names(chart)} ${are} scored, but ${what}. A current chart assessment needs the date of the latest candle or quote it used.`, beside: `${beside} A current assessment needs the date of the latest candle or quote it used.` });
    } else if (report !== null) {
      const days = Math.round((report - obs) / DAY_MS);
      if (days > STALE_CHART_DAYS) {
        flags.push({ ...base, rule: 'chart_observation_stale', severity: 'medium', message: `${names(chart)} ${are} scored on a chart whose latest observation (${ymd(obs)}) is ${days} days older than the report (${ymd(report)}). Older price history is context; a current assessment needs current data.`, beside: `The chart behind this grade was last observed on ${ymd(obs)}, ${days} days before the report (${ymd(report)}). Older price history is context; a current assessment needs current data.` });
      } else if (days < -1) {
        flags.push({ ...base, rule: 'chart_observation_after_report', severity: 'medium', message: `${names(chart)} ${are} scored on a chart whose latest observation is dated ${ymd(obs)}, ${-days} days after the report itself (${ymd(report)}); the dates are inconsistent.`, beside: `The chart behind this grade is dated ${ymd(obs)}, ${-days} days after the report itself (${ymd(report)}); the dates are inconsistent.` });
      }
    }
  }
  // Liquidity is not a venue list: a volume and liquidity grade needs the
  // volume baseline it compared against and a spread, depth or order-book
  // reading (evidence rule 12: aggregate volume is not executable liquidity).
  // A depth reading must say something: a dated spread, depth or order-book
  // figure. "No depth retrieved" is an honest limitation, not a reading.
  const cc = a.chart_cycle || null;
  const depth = depthReading(cc);
  const undatedChart = flags.some((f) => f.rule === 'chart_without_observation_date');
  const depthGap = () => {
    const q = depth.text ? `"${depth.text.slice(0, 60)}${depth.text.length > 60 ? '…' : ''}"` : '';
    if (depth.says === 'none') return 'no spread, depth or order-book reading';
    if (depth.says === 'missing') return `only a statement that the depth data is missing (${q})`;
    if (depth.says === 'no_figure') return `a liquidity reading with no spread, depth or order-book figure (${q}; a venue list, aggregate volume or a description is not one)`;
    if (!depth.dated && !undatedChart) return 'a depth figure with no date';
    return null;
  };
  const liq = scoredText(scores.volume_liquidity);
  if (liq !== null) {
    const lacks = [statedText(cc && cc.volume ? cc.volume.baseline : null) ? null : 'no stated volume baseline', depthGap()].filter(Boolean);
    if (lacks.length) {
      const said = lacks.join(' and ');
      flags.push({ claim_id: null, category: 'volume_liquidity', categories: ['volume_liquidity'], kind: null, source_ids: [], rule: 'liquidity_without_depth', severity: 'medium', message: `Volume confirmation and executable liquidity is scored ${liq}, but the report has ${said}. Listing venues or aggregate volume is not executable liquidity. This concerns the liquidity grade; the chart and timing grades stand on their own evidence.`, beside: `The report has ${said}. Listing venues or aggregate volume is not executable liquidity.` });
    }
  }
  // The weighted timing and liquidity component: the timing judgment can
  // stand on the chart, but its executable-liquidity part needs a figure.
  const comp = (a.investment_components || {}).timing_executable_liquidity;
  const compText = scoredText(comp);
  // An undated figure is said once: by the chart date flag when there is one.
  if (compText !== null && (depth.says !== 'figure' || (!depth.dated && !undatedChart))) {
    flags.push({ claim_id: null, category: null, categories: [], component: 'timing_executable_liquidity', kind: null, source_ids: [], rule: 'executable_liquidity_unsupported', severity: 'low', message: `Timing and executable liquidity is scored ${compText}, and the report has ${depthGap() || 'a depth figure with no date'}: its executable-liquidity part rests on no measurement. Its timing judgment can still stand on the chart; this flag does not question it, and changes no score.` });
  }
  return { flags, checked };
}

// Scenario probabilities are subjective estimates; one given for a case that
// names no observation and cites no claim rests on nothing the report shows.
function scenarioChecks(a) {
  const flags = [];
  if (!promptAtLeast(a.prompt_version, 5)) return flags;
  const items = a.scenarios && Array.isArray(a.scenarios.items) ? a.scenarios.items : [];
  const bare = items.filter((s) => s && typeof s.probability_pct === 'number' && Number.isFinite(s.probability_pct)
    && !(Array.isArray(s.observations) && s.observations.some((o) => typeof o === 'string' && o.trim()))
    && !(Array.isArray(s.claim_ids) && s.claim_ids.length));
  if (bare.length) {
    const cases = bare.map((s) => s.case || '?').join(', ');
    flags.push({ claim_id: null, category: null, categories: [], kind: 'scenario', source_ids: [], rule: 'probability_without_support', severity: 'medium', message: `Scenario probabilities are given for the ${cases} case${bare.length === 1 ? '' : 's'} with no observation and no cited claim behind ${bare.length === 1 ? 'it' : 'them'}. A probability needs supporting evidence, or it stays null with the reason.` });
  }
  return flags;
}

// The checks for one assessment. officialWebsite: the project's verified site.
function evidenceChecks(assessment, { officialWebsite = null } = {}) {
  const a = assessment || {};
  const officialDomain = officialWebsite ? domainOf(officialWebsite) : null;
  const sources = new Map();
  const outside = new Map();
  for (const s of Array.isArray(a.sources) ? a.sources : []) {
    if (!s || !s.source_id) continue;
    const n = normalizeSourceType(s.source_type_raw !== undefined ? s.source_type_raw : s.source_type, s.url, { officialDomain });
    sources.set(String(s.source_id), { ...n, url: s.url || null, id: String(s.source_id) });
    if (n.given && !SOURCE_TYPES.includes(key(n.given))) outside.set(n.given, new Set([...(outside.get(n.given) || []), n.type]));
  }
  const catalystClaims = new Set((Array.isArray(a.catalysts) ? a.catalysts : []).filter((c) => c && (c.date || c.window_start || c.window_end)).flatMap((c) => (Array.isArray(c.claim_ids) ? c.claim_ids.map(String) : [])));
  const asked = asksForExcerpt(a.prompt_version);
  const flags = [];
  let critical = 0;
  const claims = Array.isArray(a.claims) ? a.claims : [];
  for (const c of claims) {
    if (!c || !c.claim_id) continue;
    const id = String(c.claim_id);
    const tag = tagOf(c.evidence_tag);
    const cited = (Array.isArray(c.source_ids) ? c.source_ids : []).map((x) => sources.get(String(x))).filter(Boolean);
    const primary = cited.filter((s) => s.primary);
    const ai = cited.filter((s) => s.type === 'ai_summary');
    const kind = criticalKind(c, catalystClaims);
    if (kind) critical += 1;
    const what = (s) => `${s.id}${s.url ? `: ${shortUrl(s.url)}` : ''}`;
    const types = cited.length ? [...new Set(cited.map((s) => s.type.replace(/_/g, ' ')))].join(', ') : 'none';
    if (tag === 'V' && ai.length && !primary.length) {
      flags.push({ rule: 'ai_summary_as_verified', severity: 'high', claim_id: id, kind, source_ids: ai.map((s) => s.id), message: `${id} is tagged verified, but its only support is an AI-generated summary (${ai.map(what).join('; ')}). An AI summary never verifies a claim${kind ? `; ${KIND_LABEL[kind]} needs ${PRIMARY_HINT[kind]}` : '; it needs the primary source'}.` });
    } else if (kind && kind !== 'realized_fees' && tag === 'V' && !primary.length) {
      flags.push({ rule: 'critical_without_primary', severity: 'medium', claim_id: id, kind, source_ids: cited.map((s) => s.id), message: `${id} (${KIND_LABEL[kind]}) is tagged verified without a primary source (its sources: ${types}). It needs ${PRIMARY_HINT[kind]}.` });
    }
    if (kind && tag !== 'S' && !c.as_of) {
      flags.push({ rule: 'critical_without_date', severity: 'low', claim_id: id, kind, source_ids: [], message: `${id} (${KIND_LABEL[kind]}) has no as-of date.` });
    }
    if (kind === 'realized_fees' && tag !== 'S') {
      const reproducible = Boolean(c.query) || cited.some((s) => s.url && (s.type === 'onchain_data' || s.type === 'data_aggregator'));
      if (!c.period || !reproducible) {
        const missing = [!c.period ? 'its measurement period' : null, !reproducible ? 'a query, dashboard or explorer view that reproduces it' : null].filter(Boolean).join(' and ');
        flags.push({ rule: 'fees_not_reproducible', severity: 'medium', claim_id: id, kind, source_ids: cited.map((s) => s.id), message: `${id} (${KIND_LABEL[kind]}${c.metric_id ? `: ${c.metric_id}` : ''}) cannot be reproduced: it lacks ${missing}${cited.length ? ` (its sources: ${types})` : ''}.` });
      }
    }
    if (asked && kind && tag === 'V' && !c.excerpt && !c.query) {
      flags.push({ rule: 'critical_without_excerpt', severity: 'low', claim_id: id, kind, source_ids: [], message: `${id} (${KIND_LABEL[kind]}) is tagged verified with neither an excerpt of the source nor the query used, which the prompt asked for.` });
    }
  }
  const cat = categoryChecks(a);
  flags.push(...cat.flags);
  const scen = scenarioChecks(a);
  flags.push(...scen);
  const rank = { high: 0, medium: 1, low: 2 };
  flags.sort((x, y) => rank[x.severity] - rank[y.severity]);
  const n = (sev) => flags.filter((f) => f.severity === sev).length;
  const flagged = new Set(flags.filter((f) => f.claim_id).map((f) => f.claim_id)).size;
  const flaggedCategories = new Set(flags.flatMap((f) => f.categories || [])).size;
  const said = [
    flagged ? `${flagged} of ${claims.length} claims need better evidence` : null,
    flaggedCategories ? `${flaggedCategories} category grade${flaggedCategories === 1 ? ' lacks' : 's lack'} the evidence the prompt asks for beside ${flaggedCategories === 1 ? 'it' : 'them'}` : null,
    scen.length ? 'scenario probabilities are given without supporting evidence' : null,
  ].filter(Boolean).join('; ');
  const comps = flags.filter((f) => f.component);
  const checkedGrades = cat.checked ? `, and ${cat.checked} category grade${cat.checked === 1 ? '' : 's'} against the code and chart evidence beside ${cat.checked === 1 ? 'it' : 'them'}` : '';
  // What these checks could not look at, said plainly: a report with nothing
  // to check is not a clean result.
  const gaps = [
    !claims.length ? 'the report lists no structured claims, so no claim was checked' : null,
    promptAtLeast(a.prompt_version, 5) ? null
      : a.prompt_version ? `its prompt (${String(a.prompt_version).slice(0, 40)}) did not ask for the code and chart evidence beside the category grades, so those grades were not checked`
        : 'its prompt version is not stated, so the category grades were not checked against code and chart evidence',
  ].filter(Boolean);
  const coverage = !claims.length && !cat.checked ? 'none' : gaps.length ? 'partial' : 'full';
  const gapText = gaps.length ? ` Coverage is partial: ${gaps.join('; ')}.` : '';
  const counts = [n('high') && `${n('high')} high`, n('medium') && `${n('medium')} medium`, n('low') && `${n('low')} low`].filter(Boolean).join(', ');
  const saidAll = [said, comps.length ? 'the timing and liquidity component has no depth figure behind its liquidity part' : null].filter(Boolean).join('; ');
  return {
    checked_claims: claims.length,
    critical_claims: critical,
    flagged_claims: flagged,
    checked_categories: cat.checked,
    flagged_categories: flaggedCategories,
    // Flags on neither a claim nor a category grade: scenario probabilities,
    // and weighted components (the timing and liquidity component).
    flagged_other: scen.length,
    flagged_components: new Set(comps.map((f) => f.component)).size,
    coverage: { status: coverage, gaps },
    high: n('high'),
    medium: n('medium'),
    low: n('low'),
    flags,
    source_types: {
      ai_summaries: [...sources.values()].filter((s) => s.type === 'ai_summary').map((s) => s.id),
      outside_list: [...outside.entries()].map(([given, readAs]) => ({ given, read_as: [...readAs].join(', ') })),
    },
    summary: flags.length
      ? `${saidAll.charAt(0).toUpperCase()}${saidAll.slice(1)} (${counts}).${gapText} These checks change no score.`
      : coverage === 'none'
        ? 'Coverage insufficient: the report has no structured claims and no category grade these checks apply to, so nothing was checked. No flag here is not a clean result. These checks change no score.'
        : `No inconsistencies detected by these checks: ${claims.length} claim${claims.length === 1 ? '' : 's'} checked${critical ? `, ${critical} of them critical` : ''}${checkedGrades}.${gapText} They test structure and consistency, not whether the facts are true. These checks change no score.`,
    tag_note: TAG_NOTE,
  };
}

module.exports = { TAG_NOTE, SOURCE_TYPES, PRIMARY_SOURCE_TYPES: [...PRIMARY], CRITICAL_KINDS, CHART_CATEGORIES, STALE_CHART_DAYS, normalizeSourceType, evidenceChecks, criticalKind, categoryChecks };
