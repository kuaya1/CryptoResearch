'use strict';
// The fictional desk the paper-mandate tests share: one project with Claude's
// fixture reports, Claude's grade stubbed to a chosen figure, the floor for a
// new entry at 50 (arm-desk's), and the mandate on for a week. A Prosecutor's
// ticket is saved with exits frozen (sized $500) or without any (sized $0,
// as every online ticket was before pilot enrollment approved exit targets).
// Temporary workspaces only: nothing here is a market, a venue or an order.
//
// The mandate is armed as the desk records an arming (mandate-authority.js):
// generation 1. The default ticket is consistent (its worst finding is
// serious); CONTRADICTORY is the audit's fatal-finding ticket for the tests
// that need it.

const assert = require('node:assert/strict');
const { tempWorkspace, addFixtureProject, importAllFixtures, withExitReadings, freshPrice } = require('./helpers');
const { answer } = require('./trader-fixture');
const T = require('../core/tickets');

const DAY = 86400000;
const inDays = (n) => new Date(Date.now() + n * DAY).toISOString();
const ARMED = (generation = 1) => ({ version: 'cr-mandate-authority@1', generation, armed_at: new Date().toISOString(), armed_by: 'eric' });
// A consistent prosecution (a serious finding, no fatal one) and the audit's
// contradictory one (a fatal finding beside an ACCUMULATE).
const CONSISTENT = Object.freeze({ verdict: 'thesis_damaged', fatal_flaws: [{ test: 'mercenary_emissions', severity: 'serious', finding: 'Activity is partly paid for by emissions (FICTIONAL).', source_ids: ['S1'] }] });
const CONTRADICTORY = Object.freeze({ verdict: 'fatal_flaw', fatal_flaws: [{ test: 'mercenary_emissions', severity: 'fatal', finding: 'Activity is paid for by emissions (FICTIONAL).', source_ids: ['S1'] }] });

// Claude's grade, as the rubric would give it, for the whole test.
function stubGrade(t, value) {
  const rubrics = require('../core/rubrics');
  const real = rubrics.gradeAssessment;
  const set = (v) => { rubrics.gradeAssessment = () => ({ status: 'firm', value: v, display: String(v) }); };
  set(value);
  t.after(() => { rubrics.gradeAssessment = real; });
  return set;
}

// No position held, so the gate reads a new entry.
function noHoldings(t) {
  const portfolio = require('../core/portfolio');
  const real = portfolio.computePortfolio;
  portfolio.computePortfolio = (...a) => ({ ...real(...a), positions: [] });
  t.after(() => { portfolio.computePortfolio = real; });
}

function mandateDesk(t, { grade = 52, mandate = true, settings = {} } = {}) {
  const w = tempWorkspace('mandate', {
    tickets: { sizing: { min_grade_new_entry: 50 } },
    automation: { autonomous_paper_loop: mandate, mandate: { expires_at: mandate ? inDays(7) : null, ...(mandate ? { authority: ARMED() } : {}) } },
    ...settings,
  });
  t.after(w.cleanup);
  // grade: null leaves the desk's own rubric in place (audit F8: the
  // input-blindness tests must exercise the real grader, not a stand-in).
  const setGrade = grade === null ? null : stubGrade(t, grade);
  noHoldings(t);
  const pid = addFixtureProject(w.ws).project_id;
  importAllFixtures(w.ws);
  freshPrice(w.ws, 'example-payfi-fictional', 0.85);
  return { ...w, pid, setGrade };
}

// A Prosecutor's ticket saved on Claude's current report: with exits (the
// gate sizes $500) or with none (the gate caps it, $0). Returns the receipt.
function saveTicket(ws, pid, { exits = true, exitCost = 1.5, reopen = false, proposal = {}, prosecution = CONSISTENT } = {}) {
  const make = () => T.createTicket(ws, { project_id: pid, assistant: true, ...(reopen ? { reopen: true } : {}) });
  const created = exits ? withExitReadings(exitCost, make) : make();
  assert.ok(created.ticket, `a ticket was opened: ${created.status} ${created.message || ''}`);
  const tk = created.ticket;
  const saved = T.saveTicket(ws, { project_id: pid, ticket_id: tk.ticket_id, text: answer(T.loadTicket(ws, pid, tk.ticket_id), proposal, prosecution) });
  return saved.receipt;
}

const mandateArgs = (tier, grade) => ({ version: T.MANDATE_VERSION, tier, grade_used: grade });

module.exports = { DAY, inDays, ARMED, CONSISTENT, CONTRADICTORY, stubGrade, noHoldings, mandateDesk, saveTicket, mandateArgs };
