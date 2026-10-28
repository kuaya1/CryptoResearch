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

function answer(ticket) {
  const b = {
    format: T.FORMAT, ticket_id: ticket.ticket_id, project_id: ticket.project_id, prompt_version: T.PROMPT_VERSION, role: 'prosecutor', model: 'claude', model_version: 'claude-test', as_of: AT,
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
    sources: [{ source_id: 'S1', url: 'https://example.com/xmpl/emissions', publisher: 'Example (FICTIONAL)', retrieved_at: AT, excerpt: 'fictional' }],
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
for (const c of cleanups.reverse()) { try { c(); } catch (_) { /* best effort */ } }
console.log(JSON.stringify(out, null, 1));
