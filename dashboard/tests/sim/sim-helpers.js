'use strict';
// Shared pieces for the scenario harness (backlog 19): a fictional workspace
// with Claude's reports, a Prosecutor's ticket as a model would write it, a
// measured exit, a stubbed portfolio and price paths replayed from
// dashboard/tests/fixtures/sim/*.json. No network is touched.

const fs = require('fs');
const path = require('path');
const { tempWorkspace, addFixtureProject, importAllFixtures, withExitReadings, freshPrice } = require('../helpers');
const T = require('../../core/tickets');
const { readJson, atomicWrite, jsonText } = require('../../core/fsx');

const H = 3600000;
const CG = 'example-payfi-fictional';

const AT = new Date().toISOString();
function answer(ticket, over = {}) {
  const b = {
    format: T.FORMAT,
    ticket_id: ticket.ticket_id,
    project_id: ticket.project_id,
    prompt_version: T.PROMPT_VERSION,
    role: 'prosecutor',
    model: 'claude',
    model_version: 'claude-test',
    as_of: AT,
    researcher_report_id: ticket.basis.researcher.report_id,
    researcher_report_sha256: ticket.basis.researcher.original.sha256,
    prosecution: {
      verdict: 'thesis_damaged',
      conviction_score: 38,
      tests: { mercenary_emissions: { result: 'fail', finding: 'Rewards exceed fees (FICTIONAL).', source_ids: ['S1'] }, tax_revenue: { result: 'pass', finding: '' }, exit_slippage: { result: 'unknown', finding: 'No reading.' }, unverified_claims: { result: 'fail', finding: 'Partner list unsourced.' } },
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
    ...over,
  };
  return `# Prosecution (FICTIONAL)\n\n${'The four tests and the flaws, written out for the test fixture. '.repeat(12)}\n\n\`\`\`json\n${JSON.stringify(b, null, 2)}\n\`\`\`\n`;
}


function stubHeld(t, pid, held) {
  const portfolio = require('../../core/portfolio');
  const real = portfolio.computePortfolio;
  portfolio.computePortfolio = (...a) => { const pf = real(...a); return { ...pf, positions: held ? [{ project_id: pid, closed: false }] : [] }; };
  t.after(() => { portfolio.computePortfolio = real; });
}

function workspace(t) {
  const w = tempWorkspace('sim');
  t.after(w.cleanup);
  const pid = addFixtureProject(w.ws).project_id;
  importAllFixtures(w.ws);
  return { ...w, pid };
}

// A saved ticket with a proven exit frozen into its packet and a fresh stored
// price for the admission check, so the gate allows risk.
function savedTicket(t, s, { cost = 1.5, refresh = false, over = {}, price = 0.85 } = {}) {
  stubHeld(t, s.pid, false);
  const tk = withExitReadings(cost, () => T.createTicket(s.ws, { project_id: s.pid, assistant: true, refresh })).ticket;
  if (price !== null) freshPrice(s.ws, CG, price);
  return T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: answer(T.loadTicket(s.ws, s.pid, tk.ticket_id), over) });
}

function loadPath(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'sim', `${name}.json`), 'utf8'));
}

// Replays a price path as hourly records at ref + h hours (price and BTC).
function replay(ws, name, refMs) {
  const dir = ws.abs('market-data/observations');
  fs.mkdirSync(dir, { recursive: true });
  const pts = loadPath(name).points;
  for (const p of pts) {
    const at = new Date(refMs + p.h * H).toISOString();
    fs.appendFileSync(path.join(dir, `${at.slice(0, 7)}.jsonl`), `${JSON.stringify({ fetched_at: at, provider: 'coingecko', assets: [{ id: CG, price_usd: p.price, source_last_updated_at: at, fetched_at: at }, { id: 'bitcoin', price_usd: p.btc, source_last_updated_at: at, fetched_at: at }] })}\n`);
  }
  return pts;
}

const priceCheck = (ws, pid, now) => T.view(ws, pid, { now }).ticket.invalidation.checks.find((c) => c.kind === 'price');

// One hourly observation of the price (and BTC) at an absolute time.
function observe(ws, atMs, price, btc = null) {
  const dir = ws.abs('market-data/observations');
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date(atMs).toISOString();
  const assets = [{ id: CG, price_usd: price, source_last_updated_at: at, fetched_at: at }];
  if (btc !== null) assets.push({ id: 'bitcoin', price_usd: btc, source_last_updated_at: at, fetched_at: at });
  fs.appendFileSync(path.join(dir, `${at.slice(0, 7)}.jsonl`), `${JSON.stringify({ fetched_at: at, provider: 'coingecko', assets })}\n`);
}

module.exports = { observe, H, CG, T, answer, stubHeld, workspace, savedTicket, loadPath, replay, priceCheck, readJson, atomicWrite, jsonText };
