'use strict';
// The paper book, cr-paper@1 (backlog 18, blueprint W4.1, 2026-10-25).
//
// A PM decision that grants risk (approve or halve) opens a paper position of
// pm_approved_risk_usd, so the desk can later say what its tickets would have
// done. It is never money: it lives apart from portfolio/ (no ledger entry, no
// Portfolio count, no wallet) in the append-only paper/positions.jsonl, which
// is backed up and exported with the other records.
//
//   open  one per granting decision (create-only; the same decision again is
//         unchanged): the receipt, the risk, the invalidation price, the end
//         of the run's horizon, and the entry.
//   void  Undo of the decision: the position stays on record, voided with the
//         reason, never deleted.
//
// The entry is the hourly price reading nearest the decision within 6 hours
// and never later than it, else "no entry price" (nothing later stands in).
// The entry cost (fees, slippage) is unknown and said so, never 0. A position
// closes, computed on read from the hourly records and the decisions and never
// stored, at the first of: the first hourly reading at or below the
// invalidation price (that reading), the PM's trim_acknowledged decision
// after it was opened, or the end of the horizon. Its return is set against
// BTC's over the same two times, (1 + return) / (1 + BTC) - 1, the definition
// the outcomes use. A ticket that grants no risk gets a shadow line ("Shadow:
// not taken"). No total, median or hit rate is shown before MIN_CLOSED
// positions have closed. It changes no grade, ticket or decision.

const { runOp, OpError } = require('./ops');
const { sha256 } = require('./fsx');
const { compactTs, randomId } = require('./ids');
const outcomes = require('./report-outcomes');

const VERSION = 'cr-paper@1';
const REL = 'paper/positions.jsonl';
const HOUR = 3600000;
const ENTRY_TOLERANCE_MS = 6 * HOUR;
const MIN_CLOSED = 20;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const round = (x, d = 2) => (isNum(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const iso = (ms) => new Date(ms).toISOString();

function readRecords(ws) {
  let text = '';
  try {
    text = require('fs').readFileSync(ws.abs(REL), 'utf8');
  } catch (_) {
    return [];
  }
  return text.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

function append(ws, summary, build) {
  return runOp(ws, { type: 'paper_position', summary }, (op) => {
    const cur = op.readText(REL, '');
    const lines = cur.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const rec = build(lines);
    if (!rec) return { status: 'unchanged' };
    op.write(REL, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${JSON.stringify(rec)}\n`);
    return { status: 'saved', record: rec };
  });
}

// Hourly readings of the given assets over [fromMs, toMs], by asset, sorted.
function readings(ws, ids, fromMs, toMs) {
  const by = new Map(ids.map((id) => [id, []]));
  for (const month of outcomes.monthsBetween(fromMs, toMs)) {
    outcomes.scanMonth(ws, month, new Set(ids), (id, t, price) => {
      if (t >= fromMs && t <= toMs) by.get(id).push({ t, price_usd: price });
    });
  }
  for (const list of by.values()) list.sort((a, b) => a.t - b.t);
  return by;
}

// The latest reading at or before ms and within the tolerance; never a later one.
function atOrBefore(list, ms, tolerance = ENTRY_TOLERANCE_MS) {
  let best = null;
  for (const r of list) {
    if (r.t > ms) break;
    best = r;
  }
  return best && ms - best.t <= tolerance ? best : null;
}

const dayIso = (end) => {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(String(end || '')) ? Date.parse(`${end}T00:00:00Z`) : NaN;
  return Number.isFinite(ms) ? iso(ms) : null;
};

// The end of the research run's horizon, and where it was read: the horizon
// the receipt froze (receipts from 2026-10-25 on), else the run the receipt
// names, else the run named in the ticket's verified frozen packet (receipts
// saved before the run was carried over, review A05). Never a default length:
// with none of these, null and the reason.
function horizonOf(ws, receipt) {
  const pid = receipt.project_id;
  const r = receipt.researcher || {};
  if (r.horizon && dayIso(r.horizon.end_date)) return { end: dayIso(r.horizon.end_date), source: 'receipt', run_id: r.horizon.run_id || r.run_id || null };
  const fromRun = (runId, source) => {
    if (!runId) return null;
    try {
      const run = require('./research').loadRun(ws, pid, runId);
      const end = dayIso(run && run.horizon && run.horizon.end_date);
      return end ? { end, source, run_id: runId } : null;
    } catch (_) {
      return null;
    }
  };
  const named = fromRun(r.run_id, 'run');
  if (named) return named;
  try {
    if (receipt.packet && receipt.packet.path && receipt.packet.sha256) {
      const pk = JSON.parse(require('./forensics').verifiedFrozen(ws, receipt.packet.path, receipt.packet.sha256, 'The frozen ticket packet'));
      const viaPacket = fromRun(pk.researcher && pk.researcher.run_id, 'packet_run');
      if (viaPacket) return viaPacket;
    }
  } catch (_) { /* an unreadable packet names no run */ }
  return { end: null, source: null, run_id: null, why: 'The report this ticket answers names no research run with a horizon end on record: the position has no horizon and stays open until another close.' };
}

// A granting decision opens a position. Never blocks or loses the decision:
// the caller treats a failure as a note.
function openForDecision(ws, project, receipt, decision) {
  if (!decision || !isNum(decision.pm_approved_risk_usd) || !(decision.pm_approved_risk_usd > 0)) return { status: 'skipped', reason: 'The decision grants no risk.' };
  const cg = project.identity && project.identity.coingecko_id;
  const at = Date.parse(decision.decided_at);
  let entry;
  if (!cg) entry = { status: 'no_entry_price', reason: 'No CoinGecko listing is bound, so no price is on record.' };
  else {
    const r = atOrBefore(readings(ws, [cg], at - ENTRY_TOLERANCE_MS, at).get(cg), at);
    entry = r ? { status: 'priced', price_usd: r.price_usd, at: iso(r.t), gap_hours: round((at - r.t) / HOUR, 1) } : { status: 'no_entry_price', reason: 'No hourly price within 6 hours at or before the decision; a later reading is never used.' };
  }
  const inv = receipt.proposal && receipt.proposal.invalidation_trigger;
  const horizon = horizonOf(ws, { ...receipt, project_id: decision.project_id });
  const out = append(ws, `Open a paper position for ${decision.receipt_id}`, (lines) => {
    if (lines.some((l) => l.event === 'open' && l.decision_id === decision.decision_id)) return null;
    const opened = new Date().toISOString();
    return {
      schema_version: 'cr.paper.v1',
      paper_version: VERSION,
      event: 'open',
      position_id: `pp_${compactTs(new Date(opened))}_${randomId(5)}`,
      project_id: decision.project_id,
      receipt_id: decision.receipt_id,
      ticket_id: decision.ticket_id || receipt.ticket_id || null,
      decision_id: decision.decision_id,
      decided_at: decision.decided_at,
      risk_usd: decision.pm_approved_risk_usd,
      proposal_type: decision.proposal_type || (receipt.desk && receipt.desk.proposal_type) || null,
      invalidation_price_usd: inv && isNum(inv.price_usd) ? inv.price_usd : null,
      horizon_end: horizon.end,
      horizon_source: horizon.source,
      run_id: horizon.run_id,
      ...(horizon.end ? {} : { horizon_note: horizon.why }),
      entry,
      entry_cost: { status: 'unknown', usd: null, note: 'Fees and slippage are unknown; not taken as 0.' },
      opened_at: opened,
      meaning: 'A paper position: it moves no money and is no record of holdings or cost.',
    };
  });
  return { status: out.result.status, position_id: out.result.record ? out.result.record.position_id : null };
}

const HORIZON_ENRICHMENT = 'cr-paper-horizon@1';

function receiptOf(ws, open) {
  try {
    return require('./tickets').listReceipts(ws, open.project_id).find((r) => !r.broken && r.receipt_id === open.receipt_id) || null;
  } catch (_) {
    return null;
  }
}

// Undo of the granting decision voids the position, with the reason.
function voidForDecision(ws, decisionId, reason) {
  const out = append(ws, `Void the paper position of ${decisionId}`, (lines) => {
    const open = lines.find((l) => l.event === 'open' && l.decision_id === decisionId);
    if (!open || lines.some((l) => l.event === 'void' && l.position_id === open.position_id)) return null;
    return { schema_version: 'cr.paper.v1', paper_version: VERSION, event: 'void', position_id: open.position_id, decision_id: decisionId, reason: String(reason || 'The decision was undone.').slice(0, 300), voided_at: new Date().toISOString() };
  });
  return { status: out.result.status };
}

// One position, read: its close (if any) from the hourly records and the
// decisions, its return against BTC, or why there is none.
// Item 55: how far the hourly price went for and against the position between
// its entry reading and its close (or now). The highest and lowest hourly
// readings in that span, each against the entry price. Known only when the
// entry is priced and the series covers the span: at least one reading after
// the entry, the latest within `tolerance` of the end. Otherwise unknown with
// the reason, never 0. Computed on read; nothing is stored.
function excursionOf(series, entry, endMs, tolerance) {
  const none = (why) => ({ status: 'unknown', why, max_favorable_pct: null, max_adverse_pct: null });
  if (!entry || entry.status !== 'priced' || !isNum(entry.price_usd) || !(entry.price_usd > 0)) return none('No entry price: the excursion cannot be measured.');
  const startMs = Date.parse(entry.at);
  if (!Number.isFinite(startMs)) return none('The entry has no reading time.');
  const span = (series || []).filter((r) => r.t >= startMs && r.t <= endMs);
  if (!span.length) return none('No hourly readings between the entry and the end.');
  if (endMs - span[span.length - 1].t > tolerance) return none('The hourly readings stop well before the end of the position: the series does not cover it.');
  let hi = span[0];
  let lo = span[0];
  for (const r of span) {
    if (r.price_usd > hi.price_usd) hi = r;
    if (r.price_usd < lo.price_usd) lo = r;
  }
  const vs = (p) => round((p / entry.price_usd - 1) * 100, 2);
  return { status: 'known', max_favorable_pct: vs(hi.price_usd), max_favorable_at: iso(hi.t), max_adverse_pct: vs(lo.price_usd), max_adverse_at: iso(lo.t), readings: span.length };
}

function readPosition(ws, open, voided, project, decisions, now) {
  const row = {
    position_id: open.position_id, project_id: open.project_id, name: project ? project.name : null, symbol: project ? project.symbol || null : null,
    receipt_id: open.receipt_id, decision_id: open.decision_id, decided_at: open.decided_at, risk_usd: open.risk_usd, proposal_type: open.proposal_type,
    invalidation_price_usd: open.invalidation_price_usd, horizon_end: open.horizon_end, horizon_source: open.horizon_source || null, entry: open.entry, entry_cost: open.entry_cost,
  };
  if (voided) return { ...row, state: 'voided', voided_at: voided.voided_at, reason: voided.reason, close: null, return: null, max_favorable_pct: null, max_adverse_pct: null, excursion: null };
  // A position opened before its receipt carried the run (review A05) has no
  // stored horizon: it is read from the receipt's frozen packet when that run
  // proves one (cr-paper-horizon@1, said so, nothing written), else said
  // missing; never a default length.
  if (!open.horizon_end) {
    const receipt = receiptOf(ws, open);
    const h = receipt ? horizonOf(ws, { ...receipt, project_id: open.project_id }) : { end: null, why: 'The receipt this position came from could not be read: the position has no horizon.' };
    if (h.end) Object.assign(row, { horizon_end: h.end, horizon_source: `${h.source}, read for this position (${HORIZON_ENRICHMENT})` });
    else row.horizon_missing = h.why;
  }
  const cg = project && project.identity && project.identity.coingecko_id;
  const openMs = Date.parse(open.decided_at);
  const horizonMs = row.horizon_end ? Date.parse(row.horizon_end) : null;
  const trim = decisions
    .filter((d) => d.action === 'trim' && Date.parse(d.decided_at) > openMs)
    .sort((a, b) => a.decided_at.localeCompare(b.decided_at))[0] || null;
  const undoneIds = new Set(decisions.filter((d) => d.action === 'undo').map((d) => d.undoes));
  const trimLive = trim && !undoneIds.has(trim.decision_id) ? trim : null;
  const ids = cg ? [cg, 'bitcoin'] : [];
  const rd = cg ? readings(ws, ids, openMs - ENTRY_TOLERANCE_MS, now) : new Map();
  const mine = cg ? rd.get(cg) : [];
  const btc = cg ? rd.get('bitcoin') : [];
  // The first close among the three.
  const candidates = [];
  if (isNum(open.invalidation_price_usd)) {
    const hit = mine.find((r) => r.t > openMs && r.price_usd <= open.invalidation_price_usd);
    if (hit) candidates.push({ kind: 'invalidated', at: hit.t, price_usd: hit.price_usd, words: `First hourly reading at or below the invalidation price $${open.invalidation_price_usd}: $${hit.price_usd} at ${iso(hit.t)}.` });
  }
  if (trimLive) candidates.push({ kind: 'trim_acknowledged', at: Date.parse(trimLive.decided_at), words: `Trim acknowledged by the PM at ${trimLive.decided_at}.` });
  if (horizonMs !== null && horizonMs <= now) candidates.push({ kind: 'horizon_end', at: horizonMs, words: `The horizon ended on ${row.horizon_end.slice(0, 10)}.` });
  candidates.sort((a, b) => a.at - b.at);
  const first = candidates[0] || null;
  let close = null;
  let state = 'open';
  if (first) {
    state = 'closed';
    let price = first.price_usd;
    let reading = null;
    if (!isNum(price)) {
      reading = atOrBefore(mine, first.at);
      price = reading ? reading.price_usd : null;
    }
    close = { kind: first.kind, at: iso(first.at), price_usd: isNum(price) ? price : null, words: first.words, ...(isNum(price) ? {} : { note: 'No hourly price within 6 hours at or before this time; the exit price is unknown.' }) };
  }
  const entryPrice = open.entry && open.entry.status === 'priced' ? open.entry.price_usd : null;
  const endMs = close ? Date.parse(close.at) : now;
  const endPrice = close ? close.price_usd : (atOrBefore(mine, now, 48 * HOUR) || {}).price_usd;
  let ret = null;
  if (!isNum(entryPrice)) ret = { status: 'unknown', why: 'No entry price: the position has no return.' };
  else if (!isNum(endPrice)) ret = { status: 'unknown', why: close ? 'No exit price on record.' : 'No recent price on record.' };
  else {
    const r = endPrice / entryPrice - 1;
    const b0 = atOrBefore(btc, Date.parse(open.entry.at), ENTRY_TOLERANCE_MS);
    const b1 = atOrBefore(btc, endMs, close ? ENTRY_TOLERANCE_MS : 48 * HOUR);
    const b = b0 && b1 ? b1.price_usd / b0.price_usd - 1 : null;
    ret = { status: close ? 'realized' : 'unrealized', return_pct: round(r * 100, 2), pnl_usd: round(open.risk_usd * r, 2), btc_return_pct: b === null ? null : round(b * 100, 2), vs_btc_pct: b === null ? null : round(((1 + r) / (1 + b) - 1) * 100, 2), ...(b === null ? { btc_note: 'No BTC price on record at one of the two times.' } : {}), basis: 'Return on the entry price to the exit (or the latest reading); the paper amount is the approved risk, taken as the amount at entry. Fees and slippage are unknown and not included.' };
  }
  const exc = excursionOf(mine, open.entry, endMs, close ? ENTRY_TOLERANCE_MS : 48 * HOUR);
  return { ...row, state, close, return: ret, max_favorable_pct: exc.max_favorable_pct, max_adverse_pct: exc.max_adverse_pct, excursion: exc };
}

// Tickets that granted no risk: a shadow line each, never a position.
function shadows(ws, projects) {
  const tickets = require('./tickets');
  const out = [];
  for (const p of projects) {
    let receipts = [];
    try {
      receipts = tickets.listReceipts(ws, p.project_id).filter((r) => !r.broken);
    } catch (_) { continue; }
    const decisions = tickets.readDecisions(ws, p.project_id);
    for (const r of receipts) {
      const d = r.desk || {};
      if (r.kind === 'desk_gate' || !d.proposal_type || (d.suggested_risk_usd || 0) > 0) continue;
      out.push({ project_id: p.project_id, name: p.name, receipt_id: r.receipt_id, saved_at: r.saved_at, proposal_type: d.proposal_type, line: 'Shadow: not taken', decided: Boolean(decisions.find((x) => x.receipt_id === r.receipt_id)) });
    }
  }
  return out;
}

// The shadow gate (backlog 31): every receipt that took no risk, the pre-gate's
// desk_gate and a $0 Prosecutor ticket, with what the price did since it was
// saved, so Eric can see whether the gate turned away winners. The price at
// save is the hourly reading at or before the receipt (within 6 hours), the
// price now the latest reading (within 48 hours); an unknown is said, never 0.
// It is a view of the records: nothing here is a position or changes a ticket.
function shadowGate(ws, projects, now) {
  const tickets = require('./tickets');
  const out = [];
  for (const p of projects) {
    let receipts = [];
    try {
      receipts = tickets.listReceipts(ws, p.project_id).filter((r) => !r.broken);
    } catch (_) { continue; }
    const taken = receipts.filter((r) => r.kind === 'desk_gate' || ((r.desk || {}).proposal_type && !((r.desk.suggested_risk_usd || 0) > 0)));
    if (!taken.length) continue;
    const project = require('./projects').getProject(ws, p.project_id);
    const cg = project && project.identity && project.identity.coingecko_id;
    const starts = taken.map((r) => Date.parse(r.saved_at)).filter(Number.isFinite);
    const rd = cg && starts.length ? readings(ws, [cg, 'bitcoin'], Math.min(...starts) - ENTRY_TOLERANCE_MS, now) : new Map();
    const mine = (cg && rd.get(cg)) || [];
    const btc = (cg && rd.get('bitcoin')) || [];
    for (const r of taken) {
      const d = r.desk || {};
      const at = Date.parse(r.saved_at);
      const p0 = Number.isFinite(at) ? atOrBefore(mine, at) : null;
      const p1 = atOrBefore(mine, now, 48 * HOUR);
      const b0 = Number.isFinite(at) ? atOrBefore(btc, at) : null;
      const b1 = atOrBefore(btc, now, 48 * HOUR);
      let since;
      if (!p0) since = { status: 'unknown', why: cg ? 'No hourly price within 6 hours at or before the receipt.' : 'No CoinGecko ID on the project: no hourly records.' };
      else if (!p1) since = { status: 'unknown', why: 'No recent hourly price on record.' };
      else {
        const ret = p1.price_usd / p0.price_usd - 1;
        const bret = b0 && b1 ? b1.price_usd / b0.price_usd - 1 : null;
        since = { status: 'measured', from_price_usd: p0.price_usd, from_at: iso(p0.t), to_price_usd: p1.price_usd, to_at: iso(p1.t), change_pct: round(ret * 100, 2), btc_change_pct: bret === null ? null : round(bret * 100, 2), vs_btc_pct: bret === null ? null : round(((1 + ret) / (1 + bret) - 1) * 100, 2), ...(bret === null ? { btc_note: 'No BTC price on record at one of the two times.' } : {}) };
      }
      // The fixed 30-day result (backlog 41): the reading at or before the
      // receipt (within 6 h) to the one at or before receipt + 30 days (within
      // 24 h). Unlike `since` it never follows the latest price, so once
      // matured it does not change. A missing price is unevaluable, never 0.
      let day30;
      const target = at + 30 * 24 * HOUR;
      if (!p0) day30 = { status: 'unevaluable', why: cg ? 'No hourly price within 6 hours at or before the receipt.' : 'No CoinGecko ID on the project: no hourly records.' };
      else if (!(now >= target)) day30 = { status: 'immature', matures_at: iso(target), why: 'Fewer than 30 days since the receipt.' };
      else {
        const p30 = atOrBefore(mine, target, 24 * HOUR);
        if (!p30) day30 = { status: 'unevaluable', why: 'No hourly price within 24 hours at or before day 30.' };
        else {
          const ret30 = p30.price_usd / p0.price_usd - 1;
          const b30 = atOrBefore(btc, target, 24 * HOUR);
          const bret30 = b0 && b30 ? b30.price_usd / b0.price_usd - 1 : null;
          day30 = { status: 'matured', from_price_usd: p0.price_usd, from_at: iso(p0.t), to_price_usd: p30.price_usd, to_at: iso(p30.t), change_pct: round(ret30 * 100, 2), btc_change_pct: bret30 === null ? null : round(bret30 * 100, 2), vs_btc_pct: bret30 === null ? null : round(((1 + ret30) / (1 + bret30) - 1) * 100, 2), ...(bret30 === null ? { btc_note: 'No BTC price on record at one of the two times.' } : {}) };
        }
      }
      out.push({ project_id: p.project_id, name: p.name, receipt_id: r.receipt_id, saved_at: r.saved_at, kind: r.kind === 'desk_gate' ? 'desk_gate' : 'zero_risk', proposal_type: d.proposal_type || null, line: r.kind === 'desk_gate' ? 'Desk gate: no Prosecutor run' : 'Shadow: not taken', since, day30 });
    }
  }
  return out;
}

// One line per receipt month: how many day-30 results matured, are still
// immature or cannot be evaluated. Counts only: no median, hit rate or "the
// gate was right" is computed, and never a probability.
const SHADOW_MIN_MATURED = 20;
function shadowCohorts(rows) {
  const by = new Map();
  for (const x of rows) {
    const month = String(x.saved_at || '').slice(0, 7) || 'unknown';
    const c = by.get(month) || { month, matured: 0, immature: 0, unevaluable: 0, total: 0 };
    const st = x.day30 && x.day30.status;
    c[st === 'matured' ? 'matured' : st === 'immature' ? 'immature' : 'unevaluable'] += 1;
    c.total += 1;
    by.set(month, c);
  }
  return [...by.values()].sort((a, b) => a.month.localeCompare(b.month));
}

function book(ws, { now = Date.now() } = {}) {
  const lines = readRecords(ws);
  const voids = new Map(lines.filter((l) => l.event === 'void').map((l) => [l.position_id, l]));
  const projects = require('./projects');
  const all = projects.listProjects(ws).filter((p) => !p.broken);
  const byId = new Map(all.map((p) => [p.project_id, p]));
  const tickets = require('./tickets');
  const decCache = new Map();
  const decisionsOf = (pid) => {
    if (!decCache.has(pid)) decCache.set(pid, tickets.readDecisions(ws, pid));
    return decCache.get(pid);
  };
  const positions = lines.filter((l) => l.event === 'open').map((o) => readPosition(ws, o, voids.get(o.position_id) || null, byId.get(o.project_id) || null, decisionsOf(o.project_id), now));
  const live = positions.filter((x) => x.state !== 'voided');
  const closedWith = live.filter((x) => x.state === 'closed' && x.return && x.return.status === 'realized');
  const enough = closedWith.length >= MIN_CLOSED;
  const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const vs = closedWith.map((x) => x.return.vs_btc_pct).filter(isNum);
  const shadowRowsOnce = shadowGate(ws, all, now);
  return {
    schema_version: 'cr.paper-book.v1',
    paper_version: VERSION,
    as_of: iso(now),
    meaning: `A paper book: what the PM-approved tickets would have done, kept apart from the portfolio (no money, no ledger). Entry is the hourly price at or before the decision; fees and slippage are unknown. No total, median or hit rate appears before ${MIN_CLOSED} positions have closed. It is not a forecast or an accuracy figure and it changes no grade or ticket.`,
    counts: { positions: live.length, open: live.filter((x) => x.state === 'open').length, closed: live.filter((x) => x.state === 'closed').length, voided: positions.length - live.length, measured_closed: closedWith.length },
    summary: enough
      ? { closed: closedWith.length, median_vs_btc_pct: round(median(vs), 2), beat_btc: vs.filter((x) => x > 0).length, of: vs.length, total_pnl_usd: round(closedWith.reduce((s, x) => s + x.return.pnl_usd, 0), 2) }
      : { closed: closedWith.length, note: `Too few to judge: ${closedWith.length} of ${MIN_CLOSED} closed positions needed for a total, median or hit rate.` },
    positions,
    shadow: shadows(ws, all),
    shadow_gate: shadowRowsOnce,
    shadow_cohorts: shadowCohorts(shadowRowsOnce),
    shadow_min_matured: SHADOW_MIN_MATURED,
  };
}

module.exports = { VERSION, REL, MIN_CLOSED, readRecords, openForDecision, voidForDecision, book };
