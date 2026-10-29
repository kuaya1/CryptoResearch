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
  // --- C10 (third review): min_notional after sizing is not terminal when a
  // temporary bound binds. NAV $25,000, so the 4% ceiling is $1,000; entry
  // $100, stop $90, exits proven to $5,000; Eric approved $500.
  const c10 = { entry: '100', stop: '90', target: '140', atr: '1' };
  const c10Case = (dd) => {
    const bk = book(c10, { nav_usd: '25000', drawdown_24h_usd: dd, exit_max_usd: '5000' });
    const c = largest(c10, bk, 50000);
    return { drawdown_24h: dd, largest_risk: usd(c), ...brief(check(c10, bk, c)) };
  };
  out.C10 = { drawdown_binding: c10Case('999.21'), drawdown_cleared: c10Case('0') };
  // --- C13 (fourth review): the write-off keeps capital but not the
  // drawdown breaker. Cash $9,900 and one held token last worth $100; its two
  // missing closes were $1,000 then $100, crossing neither stop nor target.
  // The held token's own risk at its stop is counted $0 on both sides, which
  // only favours the recovered history.
  const c13 = (nav, dd) => ({ nav_usd: nav, drawdown_24h_usd: dd, ...brief(check(c10, book(c10, { nav_usd: nav, drawdown_24h_usd: dd, exit_max_usd: '5000' }), 10000)) });
  out.C13 = { write_off: c13('9900', '100'), recovered_history: c13('10000', '900') };
  // --- C14 (fourth review): below the minimum under the frozen bounds alone
  // still depends on the fee, which is Eric's setting (trader.book.fee_rate).
  const c14 = (fee) => {
    const bk = book(c10, { nav_usd: '25000', exit_max_usd: '5000', fees: { maker_rate: fee, taker_rate: fee }, grant: { ...book(c10).grant, suggested_risk_usd: '1.07', pm_approved_risk_usd: '1.07' } });
    return { fee, ...brief(check(c10, bk, 107)) };
  };
  out.C14 = { grant_usd: '1.07', fee_0_3_pct: c14('0.003'), fee_0_1_pct: c14('0.001') };
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

// =====================================================================
// The third review's counterexamples (2026-10-28, C7-C12; C10 is beside C4).

// --- C7: hour H is missing, H+1 arrives first and is held back, then H
// arrives late: once with a stop breach in it, once quiet.
{
  const late = (label, hOver) => {
    const s = heldDesk(label);
    const t1 = s.fillHour + 3 * H + 15 * M;
    const first = TD.applyHours(s.ws, [bar(PAIR, s.fillHour + 2 * H)], { now: iso(t1) });
    const t2 = t1 + 30 * M;
    const second = TD.applyHours(s.ws, [bar(PAIR, s.fillHour + H, hOver), bar(PAIR, s.fillHour + 2 * H)], { now: iso(t2) });
    const r = PT.results(s.ws, { now: iso(t2) });
    const rows = (a) => a.map((x) => [x.hour.slice(11, 16), x.status, x.code || null]);
    return { h_plus_1_alone: rows(first), then_h_and_h_plus_1: rows(second), exits: exitsOf(second), open_positions: r.open_positions.length, nav_now: r.nav_usd };
  };
  out.C7 = { breach_in_late_h: late('c7breach', { low: '0.60' }), quiet_late_h: late('c7quiet', {}) };
}

// --- C8: a close at the next open ($0.85) against the stop the complete
// history takes ($0.69825), for C1's 1,598.519131 XMPL, 0.3% exit fee, with
// the engine's own decimal helpers.
{
  const { dec, str, mulFloor, mulCeil } = TR.exact;
  const q = dec('1598.519131');
  const net = (price) => { const p = mulFloor(q, dec(price)); return p - mulCeil(p, dec('0.003')); };
  out.C8 = { stop_net_usd: str(net('0.69825')), next_open_net_usd: str(net('0.85')), difference_usd: str(net('0.85') - net('0.69825')) };
}

// --- C9: when a missing hour can be seen. 10:00 is missing; 11:00's row is
// settled (closed 10 minutes) only at 12:10.
{
  const day = Date.parse('2026-10-27T00:00:00Z');
  const rows = [11, 9].map((h) => [(day + h * H) / 1000, 0.85, 0.86, 0.84, 0.85, 86000]);
  const seen = (hh, mm) => C.barsOf(PAIR, rows, { t: day + hh * H + mm * M, after: day + 8 * H }).bars.map((b) => b.hour.slice(11, 16));
  out.C9 = { hours_read_at_12_09: seen(12, 9), hours_read_at_12_10: seen(12, 10), gap_seen_at: '12:10', next_open_the_withdrawn_policy_sold_at: '11:00' };
}

// The trader's Paper Book alone, as its tests set it up: funded with
// $10,000, fifteen hours on record, Eric's approve of $250 and the ticket's
// exit readings (cap $5,000).
const bookFixture = (() => {
  const T0 = Date.parse('2026-10-27T00:00:00Z');
  const NOW = T0 + 15 * H;
  const PID = 'fict-project';
  const RID = 'tr_2026-10-27T000000Z_fict2';
  const DID = 'td_fict0000000001';
  const TID = 'tk_2026-10-27T000000Z_fict2';
  const TICKET = { project_id: PID, receipt_id: RID, decision_id: DID };
  const VENUE = { lot: '0.001', min_notional_usd: '10', maker_rate: '0.001', taker_rate: '0.002' };
  const rules = { stop_min_pct: '0.01', stop_min_atr: '1', notional_max_pct: '0.25', price_stale_minutes: 15, max_validity_minutes: 180, allowlist: ['FICT/USDC'] };
  const ctx = (now = NOW) => ({ now: iso(now), rules, venue: VENUE, ticket: TICKET });
  const intent = (c, over = {}, now = NOW) => ({
    version: 'cr.trade-intent.v3', intent_id: `01JBXQ5R7Z8Y9W0V1T2S3R4Q5${c}`, thesis_id: RID, ...TICKET, pair: 'FICT/USDC', side: 'OPEN_LONG', order_type: 'LIMIT',
    created_at: iso(now - 2 * M), reference_price: '100', reference_at: iso(now - 3 * M), entry_price: '100', stop_loss_price: '95', take_profit_price: '115',
    risk_ceiling_usd: '100', max_slippage_bps: 20, valid_until: iso(now + 175 * M),
    evidence: { catalyst: 'Fictional catalyst', metrics_evaluated: ['fictional metric'], negative_invalidation: 'Fictional invalidation' }, ...over,
  });
  function make(label) {
    const w = tempWorkspace(label);
    cleanups.push(w.cleanup);
    const ws = w.ws;
    const PACKET = `projects/${PID}/tickets/${TID}/packet.json`;
    fs.mkdirSync(ws.abs(`projects/${PID}/tickets/${TID}`), { recursive: true });
    fs.mkdirSync(ws.abs(`projects/${PID}/tickets/receipts`), { recursive: true });
    fs.writeFileSync(ws.abs(`projects/${PID}/tickets/decisions.jsonl`), `${JSON.stringify({ schema_version: 'cr.ticket-decision.v1', decision_id: DID, project_id: PID, receipt_id: RID, ticket_id: TID, action: 'approve', pm_approved_risk_usd: 250, suggested_risk_usd: 250, proposal_type: 'ACCUMULATE', note: null, decided_at: iso(T0), decided_by: 'eric', request_id: null })}\n`);
    const exits = [[500, 0.4], [5000, 1.2], [20000, 7.5]].map(([size, cost]) => ({ size_usd: size, status: 'measured', cost_pct: cost, cost_complete: true, missing_costs: [], method: 'executable_quote', route_scope: 'aggregator', as_of: iso(T0), note: null }));
    const packet = `${JSON.stringify({ project_id: PID, exits }, null, 2)}\n`;
    fs.writeFileSync(ws.abs(PACKET), packet);
    fs.writeFileSync(ws.abs(`projects/${PID}/tickets/receipts/${RID}.json`), `${JSON.stringify({ schema_version: 'cr.ticket-receipt.v1', receipt_id: RID, project_id: PID, ticket_id: TID, packet: { path: PACKET, sha256: sha256(packet), captured_at: iso(T0) }, desk: { sizing: { max_exit_cost_pct: 5 } } }, null, 2)}\n`);
    PT.fund(ws, { cash_usd: '10000', now: iso(T0) });
    for (let i = 0; i < 15; i++) PT.applyBar(ws, { pair: 'FICT/USDC', hour: iso(T0 + i * H), open: '100', high: '101', low: '99.5', close: '100', volume: '1000000' }, { now: iso(T0 + (i + 1) * H) });
    return ws;
  }
  return { make, ctx, intent, rules, NOW };
})();
const said = (r) => ({ status: r.status, state: r.state || null, rules: (r.refusals || []).map((x) => x.rule) });

// --- C11: the unresolved-order halt counts ACKED and PARTIAL as resolved, so
// the book takes a second live buy for the same decision under another ID.
{
  const { make, ctx, intent } = bookFixture;
  const ws = make('c11');
  const a = PT.submitIntent(ws, intent('A'), ctx());
  const b = PT.submitIntent(ws, intent('B'), ctx());
  const c = PT.submitIntent(ws, intent('C'), ctx());
  const bk = PT.book(ws, 'FICT/USDC', ctx());
  out.C11 = {
    resolved_states_in_trade_risk: ['ACKED', 'PARTIAL'].filter((s) => !['RESERVED', 'SENT', 'UNKNOWN'].includes(s)),
    first_buy: said(a),
    second_buy_same_decision: said(b),
    third_buy_same_decision: said(c),
    thesis_risk_held_usd: bk.thesis_risk_usd,
    live_buys: PT.results(ws, { now: iso(bookFixture.NOW) }).orders.filter((o) => o.state === 'ACKED').length,
  };
}

// --- C12: a size solved on one read of the book, then reserved after the
// book changed. The refusal is recorded under the intent's ID, and the same
// intent stays refused after the change is undone.
{
  const { make, ctx, intent, rules } = bookFixture;
  const ws = make('c12');
  const snapshot = PT.book(ws, 'FICT/USDC', ctx());
  // A wide stop ($85), so Eric's $250 grant is what binds, not the notional cap.
  const A = (risk) => intent('A', { stop_loss_price: '85', risk_ceiling_usd: risk });
  const SIZING = ['risk_cap', 'drawdown', 'gate_cap', 'pm_cap', 'notional_cap', 'exit_cap'];
  const fits = (cents) => !TR.validateTradeIntent(A((cents / 100).toFixed(2)), snapshot, rules).refusals.some((x) => SIZING.includes(x.rule));
  let lo = 0;
  let hi = 25000;
  if (fits(hi)) lo = hi;
  else while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (fits(mid)) lo = mid; else hi = mid; }
  const solved = (lo / 100).toFixed(2);
  const binds = TR.validateTradeIntent(A(((lo + 1) / 100).toFixed(2)), snapshot, rules).refusals.map((x) => x.rule).filter((r) => SIZING.includes(r));
  // Another writer takes $100 of the same thesis between the read and the reservation.
  const other = PT.submitIntent(ws, intent('B'), ctx());
  const first = PT.submitIntent(ws, A(solved), ctx());
  PT.cancelOrder(ws, other.client_order_id, { now: iso(bookFixture.NOW + M) });
  const again = PT.submitIntent(ws, A(solved), ctx(bookFixture.NOW + 2 * M));
  out.C12 = { solved_on_the_read_usd: solved, a_cent_more_refused_by: binds, other_writer: said(other), reserve_after_the_change: said(first), other_cancelled_then_same_intent_again: said(again), thesis_risk_now_usd: PT.book(ws, 'FICT/USDC', ctx(bookFixture.NOW + 2 * M)).thesis_risk_usd };
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
