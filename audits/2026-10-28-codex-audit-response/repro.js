'use strict';
// Reproductions of the 2026-10-28 Codex audit's findings (F1-F6) and of the
// missing-hour freeze (F9), against the real code, in temporary FICTIONAL
// workspaces built with the repository's own test helpers. Nothing here
// touches the real workspace, a network or a venue.
//
//   node audits/2026-10-28-codex-audit-response/repro.js .
const path = require('path');
const fs = require('fs');
const REPO = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const D = (p) => require(path.join(REPO, 'dashboard', p));
const { tempWorkspace, addFixtureProject, importAllFixtures, withExitReadings, freshPrice } = D('tests/helpers');
const T = D('core/tickets');
const TD = D('core/trader-desk');
const PT = D('core/paper-trader');
const { sha256 } = D('core/fsx');
const guard = D('scripts/pilot-role-guard');

const H = 3600000;
const M = 60000;
const iso = (ms) => new Date(ms).toISOString();
const PAIR = 'XMPL/USDC';
const RULES = { stop_min_pct: '0.01', stop_min_atr: '1', notional_max_pct: '0.25', max_validity_minutes: 180, allowlist: [PAIR, 'OTHR/USDC'] };
const BOOK = { cash_usd: '25000', fee_rate: '0.003' };
const AT = new Date().toISOString();

function answer(ticket, at = AT) {
  const b = {
    format: T.FORMAT, ticket_id: ticket.ticket_id, project_id: ticket.project_id, prompt_version: T.PROMPT_VERSION, role: 'prosecutor', model: 'claude', model_version: 'claude-test', as_of: at,
    researcher_report_id: ticket.basis.researcher.report_id, researcher_report_sha256: ticket.basis.researcher.original.sha256,
    prosecution: {
      verdict: 'thesis_damaged', conviction_score: 38,
      tests: { mercenary_emissions: { result: 'fail', finding: 'Rewards exceed fees (FICTIONAL).', source_ids: ['S1'] }, tax_revenue: { result: 'pass', finding: '' }, exit_slippage: { result: 'unknown', finding: 'No reading.' }, unverified_claims: { result: 'pass', finding: '' } },
      fatal_flaws: [{ test: 'mercenary_emissions', severity: 'fatal', finding: 'Activity is paid for by emissions (FICTIONAL).', source_ids: ['S1'] }],
      strongest_bull_rebuttal: 'Emissions taper next quarter.',
    },
    proposal: {
      proposal_type: 'ACCUMULATE',
      non_consensus_thesis: 'The market assumes organic demand; the evidence shows paid activity; the emission cut in Q1 makes the difference observable.',
      entry_zone: { low_usd: 0.8, high_usd: 0.9, basis: 'prior range' },
      upside_target: { price_usd: 1.4, basis: 'fees double' },
      invalidation_trigger: { price_usd: 0.7, metric: { key: 'fees', below_30d_usd: 100000 }, statement: 'Below $0.70 or fees under $100k a month.' },
    },
    agent_disagreement_note: 'The researcher grades 60.5 on product reality; I score 38 on emissions.',
    sources: [{ source_id: 'S1', url: 'https://example.com/xmpl/emissions', publisher: 'Example (FICTIONAL)', retrieved_at: at, excerpt: 'fictional' }],
  };
  return `# Prosecution (FICTIONAL)\n\n${'The four tests and the flaws, written out for the test fixture. '.repeat(12)}\n\n\`\`\`json\n${JSON.stringify(b, null, 2)}\n\`\`\`\n`;
}

const cleanups = [];
function desk(label) {
  const w = tempWorkspace(label);
  cleanups.push(w.cleanup);
  const pid = addFixtureProject(w.ws).project_id;
  importAllFixtures(w.ws);
  const portfolio = D('core/portfolio');
  const real = portfolio.computePortfolio;
  portfolio.computePortfolio = (...a) => ({ ...real(...a), positions: [] });
  cleanups.push(() => { portfolio.computePortfolio = real; });
  const tk = withExitReadings(1.5, () => T.createTicket(w.ws, { project_id: pid, assistant: true })).ticket;
  freshPrice(w.ws, 'example-payfi-fictional', 0.85);
  const saved = T.saveTicket(w.ws, { project_id: pid, ticket_id: tk.ticket_id, text: answer(T.loadTicket(w.ws, pid, tk.ticket_id)) });
  return { ws: w.ws, pid, rid: saved.receipt_id, receipt: saved.receipt };
}
const settle = (ws, rules = {}) => { ws.settings.trader = { rules: { ...RULES, ...rules }, book: { ...BOOK } }; };
const bar = (pair, start, over = {}) => ({ pair, hour: iso(start), open: '0.85', high: '0.86', low: '0.84', close: '0.85', volume: '100000', ...over });
const mine = (r, did) => r.requests.find((x) => x.decision_id === did);
const out = {};

// --- F1: a second pair's backfill writes NAV marks at historical hours.
{
  const { ws, pid, rid } = desk('f1');
  settle(ws);
  const now0 = Date.now();
  const top = Math.floor(now0 / H) * H;
  // A's history: 16 hours, the older ones at 0.95, the recent ones at 0.85.
  TD.applyHours(ws, Array.from({ length: 16 }, (_, i) => bar(PAIR, top - (16 - i) * H, i < 8 ? { open: '0.95', high: '0.96', low: '0.94', close: '0.95' } : {})), { now: iso(now0) });
  const hv = T.decide(ws, pid, { receipt_id: rid, action: 'halve', request_id: 'req_f1_halve0001' }).result.decision;
  const sent = Date.now();
  const fillHour = Math.ceil(sent / H) * H;
  const n1 = fillHour + H + M;
  TD.applyHours(ws, Array.from({ length: Math.round((fillHour - top) / H) + 1 }, (_, i) => bar(PAIR, top + i * H)), { now: iso(n1) });
  const before = PT.results(ws, { now: iso(n1) });
  // B arrives: 24 hours of history from before A's first hour.
  const bStart = top - 23 * H;
  const bHours = Array.from({ length: 22 }, (_, i) => bar('OTHR/USDC', bStart + i * H, { open: '2', high: '2.01', low: '1.99', close: '2' }));
  TD.applyHours(ws, bHours, { now: iso(n1 + M) });
  const after = PT.results(ws, { now: iso(n1 + M) });
  const marks = after.nav_by_hour;
  const ordered = marks.every((m, i) => i === 0 || Date.parse(m.hour_end) >= Date.parse(marks[i - 1].hour_end));
  const bookNow = PT.book(ws, PAIR, { now: iso(n1 + M), venue: TD.settingsOf(ws).venue });
  out.F1 = {
    halve_phase: mine(TD.requests(ws, { now: iso(n1) }), hv.decision_id).phase,
    before: { open_positions: before.open_positions.length, nav: before.nav_usd, drawdown_24h: before.drawdown_24h_usd, max_drawdown: before.max_drawdown_usd },
    after: { nav: after.nav_usd, drawdown_24h: after.drawdown_24h_usd, max_drawdown: after.max_drawdown_usd, null_marks: marks.filter((m) => m.nav_usd === null).length, nav_by_hour_in_time_order: ordered },
    phantom_marks: marks.filter((m) => m.nav_usd !== null && Date.parse(m.hour_end) < fillHour && m.nav_usd !== '25000').slice(0, 3),
    book_drawdown_now: bookNow.drawdown_24h_usd,
    wait_words: bookNow.unknown.filter((u) => /drawdown/.test(u)),
  };
}

// --- F2: Undo, then Halve again before Undo's sell fills.
{
  const { ws, pid, rid } = desk('f2');
  settle(ws);
  const now0 = Date.now();
  const top = Math.floor(now0 / H) * H;
  TD.applyHours(ws, Array.from({ length: 16 }, (_, i) => bar(PAIR, top - (16 - i) * H)), { now: iso(now0) });
  const h1 = T.decide(ws, pid, { receipt_id: rid, action: 'halve', request_id: 'req_f2_halve0001' }).result.decision;
  const sent = Date.now();
  const fillHour = Math.ceil(sent / H) * H;
  const n1 = fillHour + H + M;
  TD.applyHours(ws, Array.from({ length: Math.round((fillHour - top) / H) + 1 }, (_, i) => bar(PAIR, top + i * H)), { now: iso(n1) });
  const filled = PT.intents(ws).find((i) => i.intent_id === TD.intentIdOf(h1, 'open'));
  T.decide(ws, pid, { receipt_id: rid, action: 'undo', request_id: 'req_f2_undo00001' });
  const s1 = TD.step(ws, { now: iso(n1 + M) });
  const h2 = T.decide(ws, pid, { receipt_id: rid, action: 'halve', request_id: 'req_f2_halve0002' }).result.decision;
  const s2 = TD.step(ws, { now: iso(n1 + 2 * M) });
  const refused = mine(s2, h2.decision_id);
  // The sell fills on the next hours; the book is flat; ask again.
  const n2 = fillHour + 3 * H + M;
  TD.applyHours(ws, [bar(PAIR, fillHour + H), bar(PAIR, fillHour + 2 * H)], { now: iso(n2) });
  const flat = PT.results(ws, { now: iso(n2) }).open_positions.length;
  const s3 = TD.step(ws, { now: iso(n2 + M) });
  out.F2 = {
    first_buy: filled && filled.state,
    undo_sell: s1.done.map((x) => [x.kind, x.state]),
    second_halve: [refused.phase, (refused.refusals || []).map((x) => x.rule), (refused.words || '').slice(0, 160)],
    open_positions_after_sell: flat,
    after_flat: [mine(s3, h2.decision_id).phase, s3.done.length],
    resubmit_same_intent: (() => { const it = PT.intents(ws).find((i) => i.intent_id === TD.intentIdOf(h2, 'open')); return it && it.state; })(),
  };
}

// --- F3: a ticket whose frozen exit readings are past 72 hours.
{
  const { ws, pid, rid, receipt } = desk('f3');
  settle(ws);
  const pk = JSON.parse(fs.readFileSync(ws.abs(receipt.packet.path), 'utf8'));
  const asOf = Math.max(...pk.exits.map((x) => Date.parse(x.as_of)).filter(Number.isFinite));
  const later = asOf + 73 * H;
  const cap = PT.book(ws, PAIR, { now: iso(later), venue: TD.settingsOf(ws).venue, ticket: { project_id: pid, receipt_id: rid, decision_id: 'td_none' } });
  const again = T.createTicket(ws, { project_id: pid, assistant: true });
  const project = D('core/projects').getProject(ws, pid);
  out.F3 = {
    exit_why_after_73h: (cap.exit_why || '').slice(0, 160),
    create_without_refresh: again.status,
    reopen_reason: T.reopenReason ? T.reopenReason(ws, project, receipt, { now: later }) : 'not exported',
  };
}

// --- F5: a 60-minute life submitted at half past the hour.
{
  const { ws, pid, rid } = desk('f5');
  const hv = T.decide(ws, pid, { receipt_id: rid, action: 'halve', request_id: 'req_f5_halve0001' }).result.decision;
  settle(ws, { max_validity_minutes: 60 });
  const top = Math.floor(Date.now() / H) * H + 2 * H;
  const at = top + 30 * M;
  TD.applyHours(ws, Array.from({ length: 16 }, (_, i) => bar(PAIR, top - (16 - i) * H)), { now: iso(at) });
  const s = TD.step(ws, { now: iso(at) });
  const before = mine(s, hv.decision_id).phase;
  const r = TD.applyHours(ws, [bar(PAIR, top, { low: '0.80' }), bar(PAIR, top + H, { low: '0.80' })], { now: iso(top + 2 * H + 15 * M) });
  const o = PT.intents(ws).find((i) => i.intent_id === TD.intentIdOf(hv, 'open'));
  out.F5 = { submitted: before, hour_events: r.map((x) => [x.hour.slice(11, 16), (x.events || []).map((e) => e.type)]), order: [o.state, o.filled] };
}

// --- F6: lines after the head's line are read, then their removal is too.
{
  const { ws } = desk('f6');
  settle(ws);
  const now0 = Date.now();
  const top = Math.floor(now0 / H) * H;
  TD.applyHours(ws, [bar(PAIR, top - 2 * H), bar(PAIR, top - H)], { now: iso(now0) });
  const j = ws.abs(PT.JOURNAL);
  const text = fs.readFileSync(j, 'utf8');
  const ls = text.split('\n').filter(Boolean);
  const last = JSON.parse(ls[ls.length - 1]);
  // A chained line the head does not name: an hour of a pair the book never asked for.
  const extra = JSON.stringify({ seq: last.seq + 1, at: last.at, type: 'bar', pair: 'EXTRA/USDC', hour: iso(top - H), open: '1', high: '1', low: '1', close: '1', volume: '1', prev_sha256: sha256(ls[ls.length - 1]) });
  fs.writeFileSync(j, `${text}${extra}\n`);
  const withExtra = PT.hours(ws).length;
  fs.writeFileSync(j, text);
  const without = PT.hours(ws).length;
  out.F6 = { pairs_with_unanchored_line: withExtra, pairs_after_removing_it: without, both_reads_accepted: true };
}

// --- F4: the role guard on reads.
{
  const draft = path.join(REPO, 'projects', 'example', 'research', 'run', 'drafts', 'claude.md');
  out.F4 = {
    prosecutor_read_researcher_draft: guard.decide('prosecutor', { tool_name: 'Read', tool_input: { file_path: draft } }),
    prosecutor_grep_records: guard.decide('prosecutor', { tool_name: 'Grep', tool_input: { pattern: 'grade', path: path.join(REPO, 'projects') } }),
    prosecutor_bash_cat: guard.decide('prosecutor', { tool_name: 'Bash', tool_input: { command: `cat ${draft}` } }),
  };
}

// --- F9: one hour with no trade on a pair the book holds.
{
  const { ws, pid, rid } = desk('f9');
  settle(ws);
  const now0 = Date.now();
  const top = Math.floor(now0 / H) * H;
  TD.applyHours(ws, Array.from({ length: 16 }, (_, i) => bar(PAIR, top - (16 - i) * H)), { now: iso(now0) });
  const h1 = T.decide(ws, pid, { receipt_id: rid, action: 'halve', request_id: 'req_f9_halve0001' }).result.decision;
  const fillHour = Math.ceil(Date.now() / H) * H;
  TD.applyHours(ws, Array.from({ length: Math.round((fillHour - top) / H) + 1 }, (_, i) => bar(PAIR, top + i * H)), { now: iso(fillHour + H + M) });
  // GeckoTerminal leaves out fillHour+1h (no trade); the next hours arrive, the last one through the stop.
  const later = [2, 3, 4, 5].map((k) => bar(PAIR, fillHour + k * H, k === 5 ? { open: '0.72', high: '0.73', low: '0.60', close: '0.62' } : {}));
  const r = TD.applyHours(ws, later, { now: iso(fillHour + 6 * H + 15 * M) });
  const t2 = fillHour + 6 * H + 20 * M;
  const res = PT.results(ws, { now: iso(t2) });
  T.decide(ws, pid, { receipt_id: rid, action: 'undo', request_id: 'req_f9_undo00001' });
  const st = TD.step(ws, { now: iso(t2 + M) });
  out.F9 = {
    hours: r.map((x) => [x.status, x.code || null]),
    position_still_open_after_stop_traded: res.open_positions.length,
    nav: res.nav_usd,
    undo_close: mine(st, h1.decision_id).words.slice(0, 200),
    next_run_asks_after: TD.wanted(ws, { now: iso(t2 + M) }).map((w) => w.last_hour),
  };
}
// =====================================================================
// The second review's counterexamples (2026-10-28, C1-C6). Each shows what
// the code this script is pointed at does; none of them is fixed here.
const os = require('os');
const TR = D('core/trade-risk');
const C = D('core/trader-candles');
const hasMissing = typeof PT.applyMissingHour === 'function';

// A desk holding 1,598.519131 XMPL bought at $0.85 (Halve, $250 at the $0.70
// stop), its fill hour applied.
function heldDesk(label) {
  const s = desk(label);
  settle(s.ws);
  const now0 = Date.now();
  const top = Math.floor(now0 / H) * H;
  TD.applyHours(s.ws, Array.from({ length: 16 }, (_, i) => bar(PAIR, top - (16 - i) * H)), { now: iso(now0) });
  const d = T.decide(s.ws, s.pid, { receipt_id: s.rid, action: 'halve', request_id: `req_${label}_halve0001` }).result.decision;
  const fillHour = Math.ceil(Date.now() / H) * H;
  TD.applyHours(s.ws, Array.from({ length: Math.round((fillHour - top) / H) + 1 }, (_, i) => bar(PAIR, top + i * H)), { now: iso(fillHour + H + M) });
  return { ...s, d, fillHour };
}
const exitsOf = (applied) => applied.flatMap((x) => (x.events || []).filter((e) => e.type === 'exit').map((e) => [x.hour.slice(11, 16), e.reason, e.price]));

// --- C1: the hour after the fill trades down to $0.60, through the $0.70
// stop, and recovers; the hours after it are quiet at $0.84-0.86.
{
  // The complete history.
  const a = heldDesk('c1full');
  const ta = a.fillHour + 4 * H + 15 * M;
  const full = TD.applyHours(a.ws, [bar(PAIR, a.fillHour + H, { low: '0.60' }), bar(PAIR, a.fillHour + 2 * H), bar(PAIR, a.fillHour + 3 * H)], { now: iso(ta) });
  // GeckoTerminal's answer without that hour (incomplete history, or no
  // trade: the answer alone cannot say which), read by the hourly read.
  const b = heldDesk('c1hole');
  const tb = b.fillHour + 4 * H + 15 * M;
  const rows = [3, 2, 0].map((k) => [(b.fillHour + k * H) / 1000, 0.85, 0.86, 0.84, 0.85, 86000]);
  const read = C.barsOf(PAIR, rows, { t: tb, after: b.fillHour });
  const applied = TD.applyHours(b.ws, read.bars, { now: iso(tb) });
  const rb = PT.results(b.ws, { now: iso(tb) });
  const holeEnd = rb.nav_by_hour.find((x) => x.hour_end === iso(b.fillHour + 2 * H));
  out.C1 = {
    build: hasMissing ? 'records a missing hour (PR 2 worktree)' : 'no missing-hour event (main, PR 1)',
    complete_history: { exits: exitsOf(full), open_positions: PT.results(a.ws, { now: iso(ta) }).open_positions.length },
    without_that_hour: {
      handed_to_the_book: read.bars.map((x) => [x.hour.slice(11, 16), x.missing ? 'missing' : 'priced']),
      applied: applied.map((x) => [x.hour.slice(11, 16), x.status, x.code || null]),
      exits: exitsOf(applied),
      open_positions: rb.open_positions.length,
      nav_now: rb.nav_usd,
      nav_at_the_hole_end: holeEnd ? holeEnd.nav_usd : 'no entry',
    },
  };
}

// --- C3: one scratch root for both roles.
{
  const tmp = os.tmpdir();
  const draft = path.join(tmp, 'cr-pilot-research-draft-FICTIONAL.md');
  const ticket = path.join(tmp, 'cr-pilot-ticket-draft-FICTIONAL.md');
  const g = (role, tool, input) => guard.decide(role, { tool_name: tool, tool_input: input, cwd: REPO }).allow;
  out.C3 = {
    researcher_writes_draft: g('researcher', 'Write', { file_path: draft }),
    prosecutor_writes_same_path: g('prosecutor', 'Write', { file_path: draft }),
    prosecutor_reads_researcher_draft: g('prosecutor', 'Read', { file_path: draft }),
    researcher_reads_prosecutor_draft: g('researcher', 'Read', { file_path: ticket }),
    prosecutor_imports_researcher_draft: g('prosecutor', 'Bash', { command: `node dashboard/cli.js tickets import example tk_fict --text-file ${draft.replace(/\\/g, '/')}` }),
  };
}

// --- C4: sizing to a cap through the engine's own arithmetic.
{
  const TICKET = { project_id: 'fict-project', receipt_id: 'tr_2026-10-27T000000Z_fict2', decision_id: 'td_fict0000000001' };
  const ev = { catalyst: 'Fictional catalyst', metrics_evaluated: ['fictional metric'], negative_invalidation: 'Fictional invalidation' };
  const intent = (p, risk) => ({ version: 'cr.trade-intent.v3', intent_id: '01JBXQ5R7Z8Y9W0V1T2S3R4Q5P', thesis_id: TICKET.receipt_id, ...TICKET, pair: 'FICT/USDC', side: 'OPEN_LONG', order_type: 'LIMIT', created_at: '2026-10-27T11:58:00Z', reference_price: p.entry, reference_at: '2026-10-27T11:57:00Z', entry_price: p.entry, stop_loss_price: p.stop, take_profit_price: p.target, risk_ceiling_usd: risk, max_slippage_bps: 20, valid_until: '2026-10-27T13:00:00Z', evidence: ev });
  const book = (p, o = {}) => ({ now: '2026-10-27T12:00:00Z', nav_usd: '1000000', drawdown_24h_usd: '0', open_risk_usd: '0', thesis_risk_usd: '0', price: p.entry, price_at: '2026-10-27T11:59:00Z', atr_14h: p.atr, lot: TD.LOT, min_notional_usd: TD.MIN_NOTIONAL_USD, fees: { maker_rate: '0.003', taker_rate: '0.003' }, stop_slippage_bps: PT.STOP_SLIPPAGE_BPS, grant: { thesis_id: TICKET.receipt_id, ...TICKET, suggested_risk_usd: '500', pm_approved_risk_usd: '500' }, positions: [], orders: [], ...o });
  const rules = { stop_min_pct: '0.01', stop_min_atr: '1', notional_max_pct: '0.25', price_stale_minutes: 15, max_validity_minutes: 120, allowlist: ['FICT/USDC'] };
  const usd = (c) => { const w = BigInt(c) / 100n; const f = BigInt(c) % 100n; return f === 0n ? `${w}` : `${w}.${String(f).padStart(2, '0').replace(/0$/, '')}`; };
  const S = (x) => { const [w, f = ''] = String(x).split('.'); return BigInt(w) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18)); };
  const check = (p, bk, c) => TR.validateTradeIntent(intent(p, usd(c)), bk, rules);
  const brief = (r) => ({ ok: r.ok, rules: r.refusals.map((x) => x.rule), notional: r.sizing && r.sizing.notional_usd });
  // The largest risk in cents that no size-bound rule refuses, found with the
  // engine as the only arithmetic: each rule below only tightens as the risk
  // grows, so a bisection over cents is exact (about 16 checks for $500).
  const BOUND = ['risk_cap', 'drawdown', 'gate_cap', 'pm_cap', 'notional_cap', 'exit_cap'];
  const over = (r) => r.refusals.some((x) => BOUND.includes(x.rule));
  function largest(p, bk, max) {
    if (!over(check(p, bk, max))) return max;
    let lo = 0;
    let hi = max;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (over(check(p, bk, mid))) hi = mid;
      else lo = mid;
    }
    return lo;
  }
  const wide = { entry: '127690', stop: '117474', target: '150000', atr: '1000' };
  const bk2000 = book(wide, { exit_max_usd: '2000' });
  const asked = check(wide, bk2000, 50000);
  const prop = Number((50000n * S('2000')) / S(asked.sizing.notional_usd));
  const exact = largest(wide, bk2000, 50000);
  const tight = { entry: '100', stop: '90', target: '120', atr: '1' };
  // The same search where another bound binds first. NAV $20,000: the 2%
  // risk cap is $400 and the 25% notional cap $5,000. A 5% stop (entry $100,
  // stop $95) reaches the notional cap before the risk cap.
  const narrow = { entry: '100', stop: '95', target: '120', atr: '1' };
  const bound = (p, o) => {
    const bk = book(p, { nav_usd: '20000', ...o });
    const c = largest(p, bk, 50000);
    return { risk: usd(c), ...brief(check(p, bk, c)), one_cent_more: brief(check(p, bk, c + 1)).rules };
  };
  // Below the venue's minimum: exits proven only to $9, minimum $10.
  const tiny = book(wide, { exit_max_usd: '9' });
  const tinyAt = largest(wide, tiny, 50000);
  out.C4 = {
    asked_500: brief(asked),
    proportional: { risk: usd(prop), ...brief(check(wide, bk2000, prop)) },
    bisection: { risk: usd(exact), ...brief(check(wide, bk2000, exact)), one_cent_more: brief(check(wide, bk2000, exact + 1)) },
    readme_93_counterexample: { risk: '25', exit_cap: '500', ...brief(check(tight, book(tight, { exit_max_usd: '500' }), 2500)) },
    risk_cap_binds: bound(wide, { exit_max_usd: '6000' }),
    notional_cap_binds: bound(narrow, { exit_max_usd: '6000' }),
    exit_cap_binds: bound(narrow, { exit_max_usd: '4000' }),
    below_minimum: { risk: usd(tinyAt), ...brief(check(wide, tiny, tinyAt)) },
  };
}

// --- C5: an approval waits; its research horizon ends; the book is then
// ready. The run's horizon is set to end tomorrow in this temporary
// FICTIONAL workspace before the ticket freezes it.
{
  const { buildBriefWorkspace, IDS } = D('tests/brief-fixtures');
  const fx = buildBriefWorkspace('c5-horizon');
  cleanups.push(fx.cleanup);
  const ws = fx.ws;
  const pid = fx.pids.complete;
  ws.settings.tickets = { sizing: { min_grade_new_entry: 1, min_grade_any: 0 } };
  const portfolio = D('core/portfolio');
  const real = portfolio.computePortfolio;
  portfolio.computePortfolio = (...a) => ({ ...real(...a), positions: [] });
  cleanups.push(() => { portfolio.computePortfolio = real; });
  const runRel = `projects/${pid}/research/${fx.runs.complete}/run.json`;
  const run = JSON.parse(fs.readFileSync(ws.abs(runRel), 'utf8'));
  const endMs = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) + 24 * H;
  run.horizon = { ...run.horizon, end_date: iso(endMs).slice(0, 10) };
  fs.writeFileSync(ws.abs(runRel), JSON.stringify(run, null, 2));
  const tk = withExitReadings(1.5, () => T.createTicket(ws, { project_id: pid, assistant: true })).ticket;
  freshPrice(ws, `${IDS.complete}-cg`, 0.85);
  const saved = T.saveTicket(ws, { project_id: pid, ticket_id: tk.ticket_id, text: answer(T.loadTicket(ws, pid, tk.ticket_id)) });
  const projects = D('core/projects');
  const pair = TD.pairOf(projects.getProject(ws, pid), projects.listProjects(ws)).pair;
  const dec = T.decide(ws, pid, { receipt_id: saved.receipt_id, action: 'halve', request_id: 'req_c5_halve0001' }).result;
  const did = dec.decision.decision_id;
  const A = endMs + 20 * H;
  settle(ws, { allowlist: [pair] });
  const hourA = Math.floor(A / H) * H;
  TD.applyHours(ws, Array.from({ length: 16 }, (_, i) => bar(pair, hourA - (16 - i) * H)), { now: iso(A) });
  const before = mine(TD.requests(ws, { now: iso(A) }), did);
  const s1 = TD.step(ws, { now: iso(A) });
  const s2 = TD.step(ws, { now: iso(A + M) });
  out.C5 = {
    receipt_horizon_end: saved.receipt.researcher.horizon && saved.receipt.researcher.horizon.end_date,
    approved_at: dec.decision.decided_at,
    trader_when_approved: dec.trader.status,
    horizon_ended: iso(endMs),
    assessed_at: iso(A),
    phase_then: [before.phase, before.words.slice(0, 110)],
    first_step: s1.done.map((x) => [x.kind, x.status, x.state]),
    next_step: s2.done.map((x) => [x.kind, x.status, x.state]),
    phase_after: mine(TD.requests(ws, { now: iso(A + 2 * M) }), did).phase,
  };
}

async function asyncCases() {
  // --- C2: a full Claude connection labelled as the Prosecutor.
  {
    const w = tempWorkspace('c2');
    cleanups.push(w.cleanup);
    const pid = addFixtureProject(w.ws).project_id;
    importAllFixtures(w.ws);
    // The real /mcp handler, given what the OAuth layer would hand it.
    const handle = D('mcp').makeMcp(w.ws);
    const { Readable } = require('stream');
    const rpc = (msg, as) => new Promise((resolve, reject) => {
      const req = Readable.from([Buffer.from(JSON.stringify(msg))]);
      req.method = 'POST';
      req.headers = { 'content-type': 'application/json' };
      const res = { writeHead() { return res; }, end(b) { resolve(b ? JSON.parse(b) : null); } };
      handle(req, res, as).catch(reject);
    });
    const who = { assistant: 'claude', read_only: false, role: 'prosecutor', client_name: 'Prosecutor (FICTIONAL label)' };
    const listed = (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, who)).result.tools.map((t) => t.name);
    const call = async (as, name, args) => {
      const r = (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }, as)).result;
      const text = r.content[0].text;
      return { error: Boolean(r.isError), code: (text.match(/\(([A-Z_]+)\) \(ref/) || [])[1] || null, text: text.slice(0, 120) };
    };
    const research = await call(who, 'get_research', { project_id: pid });
    const readOnly = await call({ ...who, read_only: true }, 'get_research', { project_id: pid });
    out.C2 = {
      listed: ['get_research', 'save_research_draft', 'save_report', 'start_ticket', 'save_ticket'].filter((n) => listed.includes(n)),
      get_research_as_prosecutor: research,
      same_call_on_a_read_only_connection: [readOnly.error, readOnly.code],
    };
  }

  // --- C6: an expired ticket through the HTTP routes the card uses, with
  // this process's clock 73 hours after the exit readings.
  {
    const s = desk('c6');
    settle(s.ws);
    const pk = JSON.parse(fs.readFileSync(s.ws.abs(s.receipt.packet.path), 'utf8'));
    const asOf = Math.max(...pk.exits.map((x) => Date.parse(x.as_of)).filter(Number.isFinite));
    const RealDate = Date;
    const shift = asOf + 73 * H - RealDate.now();
    global.Date = class extends RealDate {
      constructor(...a) { super(...(a.length ? a : [RealDate.now() + shift])); }
      static now() { return RealDate.now() + shift; }
    };
    let srv = null;
    try {
      const now0 = Date.now();
      const top = Math.floor(now0 / H) * H;
      TD.applyHours(s.ws, Array.from({ length: 16 }, (_, i) => bar(PAIR, top - (16 - i) * H)), { now: iso(now0) });
      freshPrice(s.ws, 'example-payfi-fictional', 0.85);
      srv = await D('server').start(s.ws, { port: 49800 + Math.floor(Math.random() * 90), quiet: true });
      const http = require('http');
      const call = (method, p, token, body) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: srv.port, method, path: p, headers: { host: `127.0.0.1:${srv.port}`, ...(token ? { 'x-cr-token': token } : {}), ...(body ? { 'content-type': 'application/json', origin: `http://127.0.0.1:${srv.port}` } : {}) } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b || 'null') })); });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
      });
      const token = (await call('GET', '/api/session')).json.token;
      const cardOf = async () => {
        const t = ((await call('GET', `/api/projects/${s.pid}/tickets`, token)).json || {}).ticket || {};
        return { receipt: t.receipt_id === s.rid ? 'expired ticket' : 'renewed ticket', status: t.status, can_reopen: t.can_reopen, expiry_fields: Object.keys(t).filter((k) => /expir|valid_until/.test(k)) };
      };
      const said = (r) => [r.status, r.json && (r.json.code || r.json.status || (r.json.result && r.json.result.status)), String((r.json && (r.json.error || r.json.message)) || '').slice(0, 150)];
      const traderOf = (r) => { const j = r.json || {}; const x = j.trader || (j.result && j.result.trader) || null; return x && [x.status, String(x.words || '').slice(0, 110)]; };
      const card0 = await cardOf();
      const hv = await call('POST', `/api/projects/${s.pid}/tickets/decisions`, token, { receipt_id: s.rid, action: 'halve', request_id: 'req_c6_halve0001' });
      const ro = await call('POST', `/api/projects/${s.pid}/tickets/decisions`, token, { receipt_id: s.rid, action: 'reopen', request_id: 'req_c6_reopen001' });
      // Renewal through the API (the card has no control for it): a new
      // ticket on the same report, with fresh readings, answered and approved.
      const F = D('core/forensics');
      const realView = F.view;
      const at = new Date().toISOString();
      const row = (size, cost) => ({ size_usd: size, status: 'current', as_of: at, note: null, best: { cost_pct: cost, cost_complete: true, missing_costs: [], method: 'executable_quote', route_scope: 'aggregator', retrieved_at: at } });
      F.view = () => ({ liquidity: { exits: [row(100, 0.75), row(500, 1.5), row(2000, 3)] } });
      let renew;
      let imp;
      try {
        renew = await call('POST', `/api/projects/${s.pid}/tickets`, token, { refresh: true, request_id: 'req_c6_renew0001' });
        const tid = renew.json && (renew.json.ticket_id || (renew.json.ticket && renew.json.ticket.ticket_id));
        imp = tid ? await call('POST', `/api/projects/${s.pid}/tickets/${tid}/import`, token, { text: answer(T.loadTicket(s.ws, s.pid, tid), new Date().toISOString()) }) : null;
      } finally {
        F.view = realView;
      }
      const rid2 = imp && imp.json && imp.json.receipt_id;
      const hv2 = rid2 ? await call('POST', `/api/projects/${s.pid}/tickets/decisions`, token, { receipt_id: rid2, action: 'halve', request_id: 'req_c6_halve0002' }) : null;
      const book = (await call('GET', '/api/paper/trader', token)).json;
      out.C6 = {
        card_before: card0,
        halve_expired: [hv.status, traderOf(hv)],
        card_toast_reads: 'Risk granted: $250 (PMDecisionCard.jsx:266 reads only the decision)',
        reopen: said(ro),
        renew_via_api: renew && said(renew),
        import_new_answer: imp && said(imp),
        card_after: await cardOf(),
        halve_renewed: hv2 && [hv2.status, traderOf(hv2)],
        outcomes_requests: ((book && book.requests) || []).map((r) => [r.receipt_id === s.rid ? 'expired ticket' : 'renewed ticket', r.phase]),
      };
    } finally {
      if (srv) { try { srv.shutdown(); } catch (_) { /* stopped */ } }
      global.Date = RealDate;
    }
  }
}

asyncCases().catch((err) => { out.async_error = String(err && err.stack || err).slice(0, 600); }).finally(() => {
  for (const c of cleanups.reverse()) { try { c(); } catch (_) { /* best effort */ } }
  console.log(JSON.stringify(out, null, 1));
});
