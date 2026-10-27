'use strict';
// Deterministic pre-trade risk engine (cr-trade-risk@1, backlog item 73).
// A pure check of one trade intent against fixed limits: it reads no file,
// clock or network (the time is portfolioState.now), lists every failed check,
// and never trims or adjusts an intent. Nothing calls it yet; it moves no money.

const VERSION = 'cr-trade-risk@1';
const INTENT_VERSION = 'cr.trade-intent.v1';
const RISK_PER_TRADE_MAX = 0.02;
const DAILY_DRAWDOWN_MAX = 0.04;
const SLIPPAGE_BPS_MAX = 20;
const EVIDENCE_FIELDS = ['report_id', 'claim', 'source'];
const EPS = 1e-9;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isPos = (x) => isNum(x) && x > 0;
const present = (x) => typeof x === 'string' && x.trim() !== '';
const timeOf = (t) => (isNum(t) ? t : typeof t === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(t) ? Date.parse(t) : NaN);

// A limit may only be tightened; anything looser or not a number is a rule error.
function limitsOf(rules, refuse) {
  const out = { risk: RISK_PER_TRADE_MAX, drawdown: DAILY_DRAWDOWN_MAX, slippage: SLIPPAGE_BPS_MAX };
  const src = rules && typeof rules === 'object' ? rules : {};
  for (const [key, name, max] of [['risk', 'risk_per_trade_max', RISK_PER_TRADE_MAX], ['drawdown', 'daily_drawdown_max', DAILY_DRAWDOWN_MAX], ['slippage', 'slippage_bps_max', SLIPPAGE_BPS_MAX]]) {
    if (src[name] === undefined) continue;
    if (!isPos(src[name]) || src[name] > max) refuse(`riskRules.${name}`, 'rule_error', `The rule ${name} must be a number above 0 and at most ${max}; a looser limit is never applied.`);
    else out[key] = src[name];
  }
  return out;
}

function validateTradeIntent(intent, portfolioState, riskRules) {
  const refusals = [];
  const refuse = (field, rule, words) => refusals.push({ field, rule, words });
  const limits = limitsOf(riskRules, refuse);
  const it = intent && typeof intent === 'object' ? intent : {};
  const ps = portfolioState && typeof portfolioState === 'object' ? portfolioState : {};
  if (!intent || typeof intent !== 'object') refuse('intent', 'shape', 'No trade intent was given.');

  if (it.version !== INTENT_VERSION) refuse('version', 'shape', `The intent version must be ${INTENT_VERSION}.`);
  if (it.action !== 'BUY' && it.action !== 'SELL') refuse('action', 'shape', 'The action must be BUY or SELL.');
  if (it.order_type !== 'LIMIT' && it.order_type !== 'POST_ONLY') refuse('order_type', 'shape', 'The order type must be LIMIT or POST_ONLY.');
  for (const f of ['target_price', 'stop_loss_price', 'take_profit_price', 'allocated_risk_usd']) {
    if (!isPos(it[f])) refuse(f, 'shape', `${f} must be a finite number above 0.`);
  }
  if (!present(it.thesis_id)) refuse('thesis_id', 'shape', 'thesis_id is missing.');
  if (!present(it.pair)) refuse('pair', 'shape', 'pair is missing.');
  const ev = it.evidence && typeof it.evidence === 'object' ? it.evidence : {};
  for (const f of EVIDENCE_FIELDS) if (!present(ev[f])) refuse(`evidence.${f}`, 'shape', `evidence.${f} is missing.`);
  if (!isPos(it.max_slippage_bps) || it.max_slippage_bps > limits.slippage) refuse('max_slippage_bps', 'slippage', `max_slippage_bps must be above 0 and at most ${limits.slippage}.`);

  const now = timeOf(ps.now);
  const until = typeof it.valid_until === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(it.valid_until) ? Date.parse(it.valid_until) : NaN;
  if (!Number.isFinite(until)) refuse('valid_until', 'shape', 'valid_until must be an ISO-8601 UTC time.');
  if (!Number.isFinite(now)) refuse('portfolioState.now', 'unknown', 'The current time is unknown, so valid_until cannot be checked.');
  else if (Number.isFinite(until) && until <= now) refuse('valid_until', 'expired', 'valid_until is not after the current time.');

  const balanceOk = isPos(ps.paper_balance_usd);
  const valueOk = isPos(ps.paper_value_usd);
  const drawOk = isNum(ps.drawdown_24h_usd) && ps.drawdown_24h_usd >= 0;
  if (!balanceOk) refuse('portfolioState.paper_balance_usd', 'unknown', 'The paper balance is unknown or not above 0; it is never taken as 0.');
  if (!valueOk) refuse('portfolioState.paper_value_usd', 'unknown', 'The paper portfolio value is unknown or not above 0.');
  if (!drawOk) refuse('portfolioState.drawdown_24h_usd', 'unknown', 'The 24-hour drawdown is unknown or negative; it is never taken as 0.');

  if (isPos(it.allocated_risk_usd)) {
    if (balanceOk && it.allocated_risk_usd > limits.risk * ps.paper_balance_usd + EPS) refuse('allocated_risk_usd', 'risk_cap', `allocated_risk_usd is above ${limits.risk * 100}% of the paper balance.`);
    if (valueOk && drawOk && ps.drawdown_24h_usd + it.allocated_risk_usd > limits.drawdown * ps.paper_value_usd + EPS) refuse('allocated_risk_usd', 'drawdown', `The 24-hour drawdown plus this risk is above ${limits.drawdown * 100}% of the paper value.`);
  }

  if (isPos(it.target_price) && (it.action === 'BUY' || it.action === 'SELL')) {
    const buy = it.action === 'BUY';
    if (isPos(it.stop_loss_price) && (buy ? it.stop_loss_price >= it.target_price : it.stop_loss_price <= it.target_price)) refuse('stop_loss_price', 'stop_loss', `The stop-loss must be ${buy ? 'below' : 'above'} the entry for a ${it.action}.`);
    if (isPos(it.take_profit_price) && (buy ? it.take_profit_price <= it.target_price : it.take_profit_price >= it.target_price)) refuse('take_profit_price', 'take_profit', `The take-profit must be ${buy ? 'above' : 'below'} the entry for a ${it.action}.`);
  }

  const allow = riskRules && Array.isArray(riskRules.allowlist) ? riskRules.allowlist : [];
  if (present(it.pair) && !allow.includes(it.pair)) refuse('pair', 'allowlist', 'The pair is not in the allowlist.');

  return { ok: refusals.length === 0, version: VERSION, refusals };
}

module.exports = { VERSION, INTENT_VERSION, RISK_PER_TRADE_MAX, DAILY_DRAWDOWN_MAX, SLIPPAGE_BPS_MAX, EVIDENCE_FIELDS, validateTradeIntent };
