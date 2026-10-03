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
  if ((LIQ_RE.test(text) && NUMBER_RE.test(text)) || /liquidity|depth|spread|slippage/i.test(metric)) return 'liquidity';
  if (DEPLOY_RE.test(text)) return 'deployment';
  if (catalystClaims.has(claim.claim_id)) return 'catalyst';
  return null;
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
// excerpt of the source or the query used.
const asksForExcerpt = (v) => {
  const m = /^cr-research-prompt@(\d+)$/.exec(String(v || '').trim());
  return Boolean(m) && Number(m[1]) >= 4;
};

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
  const rank = { high: 0, medium: 1, low: 2 };
  flags.sort((x, y) => rank[x.severity] - rank[y.severity]);
  const n = (sev) => flags.filter((f) => f.severity === sev).length;
  const flagged = new Set(flags.map((f) => f.claim_id)).size;
  return {
    checked_claims: claims.length,
    critical_claims: critical,
    flagged_claims: flagged,
    high: n('high'),
    medium: n('medium'),
    low: n('low'),
    flags,
    source_types: {
      ai_summaries: [...sources.values()].filter((s) => s.type === 'ai_summary').map((s) => s.id),
      outside_list: [...outside.entries()].map(([given, readAs]) => ({ given, read_as: [...readAs].join(', ') })),
    },
    summary: !claims.length
      ? 'No structured claims to check.'
      : flags.length
        ? `${flagged} of ${claims.length} claims need better evidence (${[n('high') && `${n('high')} high`, n('medium') && `${n('medium')} medium`, n('low') && `${n('low')} low`].filter(Boolean).join(', ')}). These checks change no score.`
        : `${claims.length} claims checked${critical ? `, ${critical} of them critical` : ''}; none flagged. These checks change no score.`,
  };
}

module.exports = { SOURCE_TYPES, PRIMARY_SOURCE_TYPES: [...PRIMARY], CRITICAL_KINDS, normalizeSourceType, evidenceChecks, criticalKind };
