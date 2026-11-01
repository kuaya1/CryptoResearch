// The trader's Paper Book card in Research > Outcomes (cr-paper@2, slot 12c;
// GET /api/paper/trader, core/trader-desk.js view): the book's figures,
// Eric's decisions with their phase in words, positions, orders, refusals and
// NAV by the hour, apart from the PM Paper Book (cr-paper@1) and never added
// to it. Pure, for the view and the tests; it never fetches or writes. An
// unknown figure is "Unknown" with its reason, never $0.

import { fmtAmount } from './ui.js';

const plainRe = /^-?\d+(\.\d+)?$/;

// A book figure (a plain decimal string) in dollars to the cent, with the
// exact figure kept for the tooltip; unknown said with why.
export function usdWords(s, why = 'Not known.') {
  if (typeof s !== 'string' || !plainRe.test(s)) return { text: 'Unknown', exact: null, title: why, tone: 'faint' };
  const n = Number(s);
  const text = `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return { text, exact: s, title: `${s} USD exactly`, tone: '' };
}

// A result: signed, its tone from its sign.
export function pnlWords(s, why) {
  const w = usdWords(s, why);
  if (!w.exact) return w;
  const n = Number(s);
  return { ...w, text: n > 0 ? `+${w.text}` : w.text, tone: n > 0 ? 'pos' : n < 0 ? 'neg' : '' };
}

// A quantity or price as the book holds it: rounded for reading the desk's
// way (ui.js fmtAmount), exact kept.
export function amountWords(s) {
  if (typeof s !== 'string' || !plainRe.test(s)) return { text: '—', exact: null };
  return { text: fmtAmount(s), exact: s };
}

// A sentence the book or the adapter wrote, its long figures rounded for
// reading; the sentence as written is the tooltip.
export function sentenceWords(s) {
  const text = String(s || '');
  const rounded = text.replace(/(?<![\w.])\d+\.\d{3,}(?![\w.])/g, (m) => fmtAmount(m));
  return { text: rounded, title: rounded === text ? null : text };
}

// The book's figures, in order. Before funding, every figure but the funding
// reads "Not funded". While the book's record is unsettled (an hour missing
// for a pair it holds or has an order in), each figure is a recorded balance:
// its label says so and its tooltip says why.
export function bookFacts(v) {
  const r = (v && v.results) || {};
  const funded = r.funded_usd !== null && r.funded_usd !== undefined;
  const nf = { text: 'Not funded', exact: null, title: 'The book is funded once from your Preferences setting, before its first hour.', tone: 'faint' };
  const unknownWhy = (r.unknown || []).join(' ') || 'Not known.';
  const st = settlementWords(v);
  const rec = (label, w) => (st.unsettled && w.exact ? [`${label} (recorded)`, { ...w, title: `${w.title} · Recorded, not settled: ${st.text}` }] : [label, w]);
  return [
    ['Funded', funded ? { ...usdWords(r.funded_usd), title: `Funded ${r.funded_at || ''} with ${r.funded_usd} USD`.trim() } : nf],
    rec('NAV', funded ? usdWords(r.nav_usd, unknownWhy) : nf),
    rec('Cash', funded ? usdWords(r.cash_usd) : nf),
    rec('Realized', funded ? pnlWords(r.realized_pnl_usd) : nf),
    rec('Unrealized', funded ? pnlWords(r.unrealized_pnl_usd, unknownWhy) : nf),
    ['Fees paid', funded ? usdWords(r.fees_usd) : nf],
    rec('Largest drawdown', funded ? usdWords(r.max_drawdown_usd, unknownWhy) : nf),
  ].map(([label, w]) => ({ label, ...w }));
}

// Whether the book's record is settled (trader-desk.js settlementOf): an
// hour missing for a pair the book is exposed in, or no recent hour, leaves
// it unsettled, said in words with what settles it.
export function settlementWords(v) {
  const s = v && v.settlement;
  if (!s || s.state !== 'unsettled') return { unsettled: false, text: null, missing: [] };
  const missing = (s.pairs || []).filter((p) => p.gap).map((p) => ({ pair: p.pair, hour: p.gap.missing_hour, seen: p.gap.detected_at }));
  return { unsettled: true, text: s.words || 'The book\'s record is unsettled.', missing };
}

// A request's phase (trader-desk.js assess) in words and tone.
const PHASES = {
  waiting: ['Waiting', 'wait'],
  ready: ['Ready', ''],
  order: ['Order placed', ''],
  open: ['Open', ''],
  closing: ['Closing', 'warn'],
  closed: ['Closed', ''],
  refused: ['Refused', 'bad'],
  not_opened: ['Not opened', ''],
  ended: ['Ended unfilled', ''],
};
export function phaseWords(phase) {
  const [text, tone] = PHASES[phase] || [String(phase || 'Unknown'), ''];
  return { text, tone };
}

// An order's state (cr-paper@2) in words and tone. UNKNOWN stays unknown
// until the venue answers (invariant 4), never "lost".
const STATES = {
  RESERVED: ['Reserved', 'wait'],
  SENT: ['Sent', 'wait'],
  UNKNOWN: ['Unknown: asking the venue', 'wait'],
  ACKED: ['Accepted', ''],
  PARTIAL: ['Partly filled', ''],
  FILLED: ['Filled', 'ok'],
  CANCELLED: ['Cancelled', ''],
  EXPIRED: ['Expired', ''],
  REJECTED: ['Rejected', 'bad'],
  NOT_FOUND: ['Not found at the venue', 'bad'],
  REFUSED: ['Refused', 'bad'],
};
export function orderStateWords(state) {
  const [text, tone] = STATES[state] || [String(state || 'Unknown'), ''];
  return { text, tone };
}

export const sideWords = (side) => (side === 'OPEN_LONG' ? 'Buy' : side === 'CLOSE_LONG' ? 'Sell' : '—');

// Eric's decision on a request: "Halve $250", "Approve $500".
export function decisionWords(r) {
  const act = r && r.action ? r.action.charAt(0).toUpperCase() + r.action.slice(1) : 'Decision';
  const risk = r && typeof r.risk_usd === 'string' && plainRe.test(r.risk_usd) ? ` $${Number(r.risk_usd).toLocaleString('en-US')}` : '';
  return `${act}${risk}`;
}

// What an order or a refusal belongs to: its project and whether it was the
// buy or a sell.
export function ownerWords(x) {
  if (!x || !x.project) return 'Not tied to a decision on this desk';
  return `${x.project} · ${x.purpose === 'close' ? 'sell' : 'buy'}`;
}

// A refusal's reasons, one sentence each, as the engine gave them.
export const refusalWords = (x) => ((x && x.refusals) || []).map((r) => r.words).filter(Boolean).join(' ') || 'No reason was recorded.';

// NAV by the hour, newest first, and the numbers for a sparkline (oldest
// first; an unknown hour is left out of the line, never drawn as 0).
export function navRows(v) {
  const list = (v && v.results && Array.isArray(v.results.nav_by_hour)) ? v.results.nav_by_hour : [];
  return list.slice().reverse().map((m) => ({ hour_end: m.hour_end, nav: usdWords(m.nav_usd, 'An open position had no recent hour, so NAV is unknown at this hour.') }));
}
export const navLine = (v) => ((v && v.results && v.results.nav_by_hour) || []).map((m) => (typeof m.nav_usd === 'string' && plainRe.test(m.nav_usd) ? Number(m.nav_usd) : null)).filter((x) => x !== null);

// The counts in the card's head: requests by phase, in a fixed order.
export function summaryLine(v) {
  const reqs = (v && v.requests) || [];
  if (!reqs.length) return 'No decision has asked the book yet.';
  const order = ['waiting', 'ready', 'order', 'open', 'closing', 'closed', 'refused', 'not_opened', 'ended'];
  const n = (p) => reqs.filter((r) => r.phase === p).length;
  return order.filter((p) => n(p)).map((p) => `${n(p)} ${phaseWords(p).text.toLowerCase()}`).join(' · ');
}

// The hourly read's state (core/trader-candles.js statusView) in words.
export function candleWords(c) {
  if (!c) return 'Where the hours come from is not known.';
  if (c.held) return 'A restored copy: the hourly read sends nothing until the copy is released.';
  const parts = [
    c.last_run_at ? `Last read ${c.last_run_at}` : 'Not read yet',
    // An unreadable request count is said as unknown, never as 0.
    c.accounting_unknown ? `Request count unknown: ${c.accounting_unknown}` : `${c.requests_today} of ${c.daily_budget} requests today, ${c.requests_this_month} of ${c.monthly_budget} this month`,
    c.wait_until ? `GeckoTerminal asked to wait until ${c.wait_until}` : null,
  ].filter(Boolean);
  return `${parts.join(' · ')}.`;
}
