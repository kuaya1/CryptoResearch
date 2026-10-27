'use strict';
// Paper trade execution harness (cr-paper-fill@1, backlog item 74), beside
// paper.js. simulateFill is pure: only an intent the risk engine passed gets a
// fill, charged against the trader (a BUY at the ask plus slippage, a SELL at
// the bid less it). recordFill appends a filled result to its own create-only
// paper/fills.jsonl. Fills never enter paper/positions.jsonl, the Paper Book's
// counts or Portfolio; this moves no money and calls no provider.

const { runOp } = require('./ops');
const { sha256 } = require('./fsx');
const { compactTs, randomId } = require('./ids');

const VERSION = 'cr-paper-fill@1';
const REL = 'paper/fills.jsonl';
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isoMs = (t) => (typeof t === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(t) ? Date.parse(t) : NaN);
const FEES = { status: 'unknown', usd: null, note: 'Fees are unknown; not taken as 0.' };

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
const intentHash = (intent) => sha256(canonical(intent));

const notFilled = (status, reason, extra = {}) => ({ schema_version: 'cr.paper-fill.v1', fill_version: VERSION, status, reason, ...extra });

function simulateFill(intent, validation, quote) {
  if (!validation || validation.ok !== true) {
    return notFilled('not_filled', 'The risk check did not pass, so nothing is filled.', { refusals: validation && Array.isArray(validation.refusals) ? validation.refusals : [] });
  }
  if (!intent || typeof intent !== 'object') return notFilled('not_filled', 'No trade intent was given.');
  const q = quote && typeof quote === 'object' ? quote : {};
  const missing = ['bid', 'ask', 'slippage_bps'].filter((f) => !isNum(q[f]) || q[f] < 0 || (f !== 'slippage_bps' && q[f] === 0));
  if (missing.length) return notFilled('not_filled', `The quote has no usable ${missing.join(', ')}; no fill is made at a guessed price.`);
  if (q.ask < q.bid) return notFilled('not_filled', 'The quote is crossed (ask below bid).');
  const at = isoMs(q.at);
  const until = isoMs(intent.valid_until);
  if (!Number.isFinite(at) || !Number.isFinite(until)) return notFilled('not_filled', 'The quote time or the intent expiry is unreadable.');
  if (at >= until) return notFilled('expired', 'The quote is at or after the intent\'s valid_until.');
  if (q.slippage_bps > intent.max_slippage_bps) return notFilled('not_filled', `Slippage of ${q.slippage_bps} bps is above the intent's ${intent.max_slippage_bps} bps.`);

  const buy = intent.action === 'BUY';
  if (intent.order_type === 'POST_ONLY' && (buy ? intent.target_price >= q.ask : intent.target_price <= q.bid)) {
    return notFilled('not_filled', 'A post-only order that would cross the spread is not filled.');
  }
  const base = buy ? q.ask : q.bid;
  const price = buy ? base * (1 + q.slippage_bps / 1e4) : base * (1 - q.slippage_bps / 1e4);
  if (buy ? price > intent.target_price : price < intent.target_price) {
    return notFilled('not_filled', 'The limit price was not reached after spread and slippage.');
  }
  const distance = Math.abs(price - intent.stop_loss_price);
  if (!(distance > 0)) return notFilled('not_filled', 'The stop is at the fill price, so no quantity can be sized.');
  const quantity = intent.allocated_risk_usd / distance;
  return {
    schema_version: 'cr.paper-fill.v1',
    fill_version: VERSION,
    status: 'filled',
    intent_sha256: intentHash(intent),
    thesis_id: intent.thesis_id,
    pair: intent.pair,
    action: intent.action,
    order_type: intent.order_type,
    fill_price: price,
    quantity,
    quote: { bid: q.bid, ask: q.ask, at: q.at, slippage_bps: q.slippage_bps },
    costs: {
      spread_usd: quantity * (q.ask - q.bid) / 2,
      slippage_usd: quantity * Math.abs(price - base),
      fees: FEES,
    },
    meaning: 'A simulated paper fill: it moves no money and is no record of holdings or cost.',
  };
}

function recordFill(ws, fill) {
  if (!fill || fill.status !== 'filled' || typeof fill.intent_sha256 !== 'string') return { status: 'not_recorded', reason: 'Only a filled result is recorded.' };
  const out = runOp(ws, { type: 'paper_fill', summary: `Record a paper fill for intent ${fill.intent_sha256.slice(0, 12)}` }, (op) => {
    const cur = op.readText(REL, '');
    const lines = cur.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const prior = lines.find((l) => l.intent_sha256 === fill.intent_sha256);
    if (prior) return { status: 'unchanged', fill_id: prior.fill_id };
    const recorded = new Date();
    const rec = { ...fill, fill_id: `pf_${compactTs(recorded)}_${randomId(5)}`, recorded_at: recorded.toISOString() };
    op.write(REL, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${JSON.stringify(rec)}\n`);
    return { status: 'saved', fill_id: rec.fill_id };
  });
  return out.result;
}

function readFills(ws) {
  let text = '';
  try { text = require('fs').readFileSync(ws.abs(REL), 'utf8'); } catch (_) { return []; }
  return text.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

module.exports = { VERSION, REL, intentHash, simulateFill, recordFill, readFills };
