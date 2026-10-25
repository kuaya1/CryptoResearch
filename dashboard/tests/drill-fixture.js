'use strict';
// A FICTIONAL workspace for the rollback drill (scripts/rollback-drill.js) and
// its tests, built with the test helpers and this checkout's code: a desk gate,
// an admission-held Prosecutor receipt, a sized receipt with a granting
// decision and its paper position. Never the real workspace.

const { tempWorkspace, addFixtureProject, importAllFixtures, withExitReadings, freshPrice } = require('./helpers');
const { readJson, atomicWrite, jsonText } = require('../core/fsx');

const CG = 'example-payfi-fictional';

function answer(T, ticket) {
  const at = new Date().toISOString();
  const b = {
    format: T.FORMAT, ticket_id: ticket.ticket_id, project_id: ticket.project_id, prompt_version: T.PROMPT_VERSION, role: 'prosecutor', model: 'claude', model_version: 'claude-test', as_of: at,
    researcher_report_id: ticket.basis.researcher.report_id, researcher_report_sha256: ticket.basis.researcher.original.sha256,
    prosecution: {
      verdict: 'thesis_damaged', conviction_score: 38,
      tests: { mercenary_emissions: { result: 'fail', finding: 'Rewards exceed fees (FICTIONAL).', source_ids: ['S1'] }, tax_revenue: { result: 'pass', finding: '' }, exit_slippage: { result: 'unknown', finding: 'No reading.' }, unverified_claims: { result: 'fail', finding: 'Partner list unsourced.' } },
      fatal_flaws: [{ test: 'mercenary_emissions', severity: 'fatal', finding: 'Activity is paid for by emissions (FICTIONAL).', source_ids: ['S1'] }],
      strongest_bull_rebuttal: 'Emissions taper next quarter.',
    },
    proposal: { proposal_type: 'ACCUMULATE', non_consensus_thesis: 'The market assumes organic demand; the evidence shows paid activity; the emission cut in Q1 makes the difference observable.', entry_zone: { low_usd: 0.8, high_usd: 0.9, basis: 'prior range' }, upside_target: { price_usd: 1.4, basis: 'fees double' }, invalidation_trigger: { price_usd: 0.7, statement: 'Below $0.70.' } },
    agent_disagreement_note: 'The researcher grades 60.5; I score 38.',
    sources: [{ source_id: 'S1', url: 'https://example.com/xmpl/emissions', publisher: 'Example (FICTIONAL)', retrieved_at: at, excerpt: 'fictional' }],
  };
  return `# Prosecution (FICTIONAL)\n\n${'The four tests and the flaws, written out for the drill fixture. '.repeat(12)}\n\n\`\`\`json\n${JSON.stringify(b, null, 2)}\n\`\`\`\n`;
}

function buildDrillWorkspace() {
  const w = tempWorkspace('rollback-drill');
  const { ws } = w;
  try {
    const T = require('../core/tickets');
    const pid = addFixtureProject(ws).project_id;
    importAllFixtures(ws);
    const portfolio = require('../core/portfolio');
    const realPf = portfolio.computePortfolio;
    const held = (on) => { portfolio.computePortfolio = (...a) => { const pf = realPf(...a); return { ...pf, positions: on ? [{ project_id: pid, closed: false }] : [] }; }; };
    try {
      // 1. The desk's own gate: the grade alone rules out new risk.
      ws.settings.tickets = { sizing: { min_grade_new_entry: 99, min_grade_any: 5 } };
      held(false);
      const gate = T.createTicket(ws, { project_id: pid, assistant: true });
      if (gate.status !== 'gate_closed') throw new Error('The fixture could not make a desk gate.');
      delete ws.settings.tickets;
      held(true);
      // 2. A Prosecutor receipt saved with no stored price: admission holds it at $0.
      const noPrice = withExitReadings(1.5, () => T.createTicket(ws, { project_id: pid, assistant: true, refresh: true })).ticket;
      T.saveTicket(ws, { project_id: pid, ticket_id: noPrice.ticket_id, text: answer(T, T.loadTicket(ws, pid, noPrice.ticket_id)) });
      // 3. A sized receipt, approved: a decision and a paper position.
      const sized = withExitReadings(1.5, () => T.createTicket(ws, { project_id: pid, assistant: true, refresh: true })).ticket;
      freshPrice(ws, CG, 0.85);
      const saved = T.saveTicket(ws, { project_id: pid, ticket_id: sized.ticket_id, text: answer(T, T.loadTicket(ws, pid, sized.ticket_id)) });
      T.decide(ws, pid, { receipt_id: saved.receipt_id, action: 'approve' });
      // The receipt that "newer rules" are stamped on.
      const receiptFile = `projects/${pid}/tickets/receipts/${saved.receipt_id}.json`;
      const stampNewer = (n = 99) => {
        const r = readJson(ws.abs(receiptFile));
        r.versions.sizing = `cr-ticket-sizing@${n}`;
        r.desk.invalidation_version = `cr-ticket-invalidation@${n}`;
        atomicWrite(ws.abs(receiptFile), jsonText(r));
      };
      return { root: w.root, ws, pid, receipt_id: saved.receipt_id, stampNewer, cleanup: w.cleanup };
    } finally { portfolio.computePortfolio = realPf; }
  } catch (err) { w.cleanup(); throw err; }
}

module.exports = { buildDrillWorkspace };
