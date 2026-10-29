'use strict';
// The fictional desk the adapter's tests share (core/trader-desk.js): one
// project, Claude's fixture reports, a Prosecutor's ticket the gate sized at
// $500, Eric's trader rules and book, and quiet hours of XMPL/USDC. Temporary
// workspaces only: nothing here is a market, an account, a venue or an order.

const assert = require('node:assert/strict');
const { tempWorkspace, addFixtureProject, importAllFixtures, withExitReadings, freshPrice } = require('./helpers');
const T = require('../core/tickets');

const H = 3600000;
const M = 60000;
const iso = (ms) => new Date(ms).toISOString();
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const PAIR = 'XMPL/USDC';
const RULES = { stop_min_pct: '0.01', stop_min_atr: '1', notional_max_pct: '0.25', max_validity_minutes: 180, allowlist: [PAIR] };
const BOOK = { cash_usd: '25000', fee_rate: '0.003' };

// The Prosecutor's answer for a ticket, as a model would write it: an
// ACCUMULATE between $0.80 and $0.90, stop $0.70, target $1.40 (FICTIONAL).
const AT = new Date().toISOString();
function answer(ticket, proposal = {}) {
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
      ...proposal,
    },
    agent_disagreement_note: 'The researcher grades 60.5 on product reality; I score 38 on emissions.',
    sources: [{ source_id: 'S1', url: 'https://example.com/xmpl/emissions', publisher: 'Example (FICTIONAL)', retrieved_at: AT, excerpt: 'fictional' }],
  };
  return `# Prosecution (FICTIONAL)\n\n${'The four tests and the flaws, written out for the test fixture. '.repeat(12)}\n\n\`\`\`json\n${JSON.stringify(b, null, 2)}\n\`\`\`\n`;
}

// A fictional desk with a Prosecutor's ticket the gate sized at $500: exits
// within 5% at $100, $500 and $2,000 frozen into its packet, a fresh price.
function deskWith(t, { exitCost = 1.5, proposal = {} } = {}) {
  const w = tempWorkspace('trader-desk');
  t.after(w.cleanup);
  const pid = addFixtureProject(w.ws).project_id;
  importAllFixtures(w.ws);
  const portfolio = require('../core/portfolio');
  const real = portfolio.computePortfolio;
  portfolio.computePortfolio = (...a) => ({ ...real(...a), positions: [] });
  t.after(() => { portfolio.computePortfolio = real; });
  const tk = withExitReadings(exitCost, () => T.createTicket(w.ws, { project_id: pid, assistant: true })).ticket;
  freshPrice(w.ws, 'example-payfi-fictional', 0.85);
  const saved = T.saveTicket(w.ws, { project_id: pid, ticket_id: tk.ticket_id, text: answer(T.loadTicket(w.ws, pid, tk.ticket_id), proposal) });
  assert.equal(saved.receipt.desk.suggested_risk_usd, 500, 'the fixture ticket is sized at $500');
  return { ...w, pid, rid: saved.receipt_id };
}
const settle = (ws, { rules = {}, book = {} } = {}) => { ws.settings.trader = { rules: { ...RULES, ...rules }, book: { ...BOOK, ...book } }; };
// Quiet hours of XMPL/USDC: ranges of 0.02, so the 14-hour ATR is 0.02.
const bar = (start, over = {}) => ({ pair: PAIR, hour: iso(start), open: '0.85', high: '0.86', low: '0.84', close: '0.85', volume: '10000', ...over });
const mine = (r, did) => r.requests.find((x) => x.decision_id === did);

module.exports = { H, M, iso, ULID_RE, PAIR, RULES, BOOK, AT, answer, deskWith, settle, bar, mine };
