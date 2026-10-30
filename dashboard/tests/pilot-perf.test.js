'use strict';
// The pilot perf pass: the candidates path reads the portfolio once per call
// (tickets.js pilotCandidates, candidateBoard, nextStep) instead of once per
// project, and the Daily Brief's pilot-exit section scans only the projects
// opted into the pilot (profile.json pilot: true). Neither changes a result.
// Counts come from wrapping the modules' functions in a temporary FICTIONAL
// workspace; nothing is fetched and no real record is read.

const test = require('node:test');
const assert = require('node:assert/strict');
const { tempWorkspace, addFixtureProject, importAllFixtures, withExitReadings, freshPrice } = require('./helpers');
const T = require('../core/tickets');
const B = require('../core/brief-daily');
const projects = require('../core/projects');
const portfolio = require('../core/portfolio');
const reports = require('../core/reports');
const forensics = require('../core/forensics');
const { readJson, atomicWrite, jsonText } = require('../core/fsx');

// The fixture project (three models' reports) and `bare` projects with an
// identity and no report, so the desk has `1 + bare` candidates.
function setup(t, bare = 3) {
  const w = tempWorkspace('pilot-perf');
  t.after(w.cleanup);
  const pid = addFixtureProject(w.ws).project_id;
  importAllFixtures(w.ws);
  const others = [];
  for (let n = 1; n <= bare; n += 1) {
    others.push(projects.addProject(w.ws, { name: `Bare ${n} Example (FICTIONAL)`, symbol: `B${n}`, official_website: `https://bare${n}-fictional.test`, coingecko_id: `bare-${n}-fictional`, assets: [{ chain: 'other-chain', contract_address: `FICTIONAL-CONTRACT-B${n}` }], evidence: [{ url: `https://bare${n}-fictional.test`, note: 'fictional' }], sector_profile: 'payfi-credit@1' }).project_id);
  }
  return { ...w, pid, others };
}

// Wrap mod[key]; `seen` collects each call's arguments. Restored after the test.
function spy(t, mod, key, seen) {
  const real = mod[key];
  mod[key] = (...a) => { seen.push(a); return real(...a); };
  t.after(() => { mod[key] = real; });
}

// The ledger's answer stubbed: these project IDs hold an open position, a
// closed one is listed for `closedId`. `seen` counts the reads.
function stubPortfolio(t, { heldIds = [], closedId = null, fail = false }, seen) {
  const real = portfolio.computePortfolio;
  portfolio.computePortfolio = (...a) => {
    seen.push(a);
    if (fail) throw new Error('the ledger could not be read (FICTIONAL)');
    return { positions: [...heldIds.map((id) => ({ closed: false, project_id: id })), ...(closedId ? [{ closed: true, project_id: closedId }] : [])] };
  };
  t.after(() => { portfolio.computePortfolio = real; });
}

// What the old path decided for one project: the ledger read for that project
// alone, then "an open position of this project".
function oldHeld(positions, pid) {
  return positions.some((p) => !p.closed && p.project_id === pid);
}

test('pilot perf: the portfolio is read once for the whole candidate list, and each project is held or not as the per-project read said', (t) => {
  const s = setup(t, 3);
  const [a, b, c] = s.others;
  const reads = [];
  stubPortfolio(t, { heldIds: [b], closedId: c }, reads);
  const ledger = portfolio.computePortfolio().positions;
  reads.length = 0;

  const rows = T.pilotCandidates(s.ws);
  assert.equal(rows.length, 4, 'the fixture project and three bare ones');
  assert.equal(reads.length, 1, 'one read of the portfolio for four projects');
  for (const r of rows) assert.equal(r.held, oldHeld(ledger, r.project_id), `${r.project_id}: held as the per-project read said`);
  assert.equal(rows.find((r) => r.project_id === b).held, true);
  assert.equal(rows.find((r) => r.project_id === c).held, false, 'a closed position is not a holding');
  assert.equal(rows[0].project_id, b, 'the order is unchanged: held first');
  assert.ok(rows[0].gate.allowed_types.includes('TRIM_EXIT'), 'the gate saw the holding');
  // The rest of the order is the old one: by grade (no report last), then ID.
  assert.deepEqual(rows.slice(1).map((r) => r.project_id), [s.pid, a, c].sort((x, y) => (x === s.pid ? -1 : y === s.pid ? 1 : x.localeCompare(y))));
});

test('pilot perf: a portfolio handed in is used as given, and no read is made', (t) => {
  const s = setup(t, 2);
  const reads = [];
  stubPortfolio(t, { heldIds: [] }, reads);
  const rows = T.pilotCandidates(s.ws, { heldSet: new Set([s.others[0]]) });
  assert.equal(reads.length, 0);
  assert.equal(rows.find((r) => r.project_id === s.others[0]).held, true);
  assert.equal(rows.find((r) => r.project_id === s.pid).held, false);
  // null is a read that failed: nothing is held, and nothing is read again.
  const unknown = T.pilotCandidates(s.ws, { heldSet: null });
  assert.equal(reads.length, 0);
  assert.ok(unknown.every((r) => r.held === false));
});

test('pilot perf: the candidate board reads the portfolio once, its rows and order are the candidates\' own', (t) => {
  const s = setup(t, 3);
  const reads = [];
  stubPortfolio(t, { heldIds: [s.others[1]] }, reads);
  const board = T.candidateBoard(s.ws);
  assert.equal(reads.length, 1, 'one read for the candidates and for every next step');
  reads.length = 0;
  const cands = T.pilotCandidates(s.ws);
  assert.equal(reads.length, 1);
  assert.deepEqual(board.map((r) => r.project_id), cands.map((r) => r.project_id));
  for (const row of board) {
    const c = cands.find((x) => x.project_id === row.project_id);
    assert.equal(row.held, c.held);
    assert.deepEqual(row.gate, c.gate);
    assert.equal(row.in_pilot, c.in_pilot);
    // The step is what nextStep alone says for that project.
    assert.equal(row.step, T.nextStep(s.ws, row.project_id).step, row.project_id);
  }
  // The fixture project has a report and no ticket, the case that asked the ledger a second time.
  assert.ok(board.some((r) => r.project_id === s.pid && r.report_id));
});

test('pilot perf: holdings that cannot be read are read once, and nobody is held (not held stays unknown to the gate)', (t) => {
  const s = setup(t, 3);
  const reads = [];
  stubPortfolio(t, { fail: true }, reads);
  const rows = T.pilotCandidates(s.ws);
  assert.equal(reads.length, 1, 'one failed read, not one per project');
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.held === false));
  reads.length = 0;
  const board = T.candidateBoard(s.ws);
  assert.equal(reads.length, 1);
  assert.deepEqual(board.map((r) => r.project_id), rows.map((r) => r.project_id));
  // The gate's own rule: an unreadable ledger opens no desk gate (a known "not held" only).
  const fixtureStep = board.find((r) => r.project_id === s.pid).step;
  assert.notEqual(fixtureStep, 'gate_closed');
});

test('pilot perf: a desk with no verified project reads no portfolio at all', (t) => {
  const w = tempWorkspace('pilot-perf-empty');
  t.after(w.cleanup);
  const reads = [];
  stubPortfolio(t, {}, reads);
  assert.deepEqual(T.pilotCandidates(w.ws), []);
  assert.equal(reads.length, 0);
});

test('pilot perf: pilotOnly gives the pilot\'s rows exactly as the full read does, and never reads a project outside it', (t) => {
  const s = setup(t, 3);
  const [a, b] = s.others;
  T.setPilot(s.ws, s.pid, true, { by: 'test' });
  T.setPilot(s.ws, a, true, { by: 'test' });

  const full = T.pilotCandidates(s.ws);
  const asked = { reports: [], forensics: [], projects: [] };
  spy(t, reports, 'loadReports', asked.reports);
  spy(t, forensics, 'view', asked.forensics);
  spy(t, projects, 'getProject', asked.projects);
  const only = T.pilotCandidates(s.ws, { pilotOnly: true });

  assert.deepEqual(only, full.filter((r) => r.in_pilot), 'the same rows, in the same order');
  assert.deepEqual(only.map((r) => r.project_id).sort(), [s.pid, a].sort());
  // Each of these is called as fn(ws, projectId, ...): the second argument names the project.
  for (const [what, calls] of [['loadReports', asked.reports], ['forensics.view', asked.forensics], ['getProject', asked.projects]]) {
    const ids = [...new Set(calls.map((x) => x[1]))];
    assert.ok(ids.length > 0, `${what} was used for the pilot`);
    for (const id of ids) assert.ok([s.pid, a].includes(id), `${what} read ${id}, which is not in the pilot`);
    assert.ok(!ids.includes(b), `${what} never read a project outside the pilot`);
  }

  // Nobody in the pilot: nothing at all is read.
  T.setPilot(s.ws, s.pid, false, { by: 'test' });
  T.setPilot(s.ws, a, false, { by: 'test' });
  asked.reports.length = 0; asked.forensics.length = 0; asked.projects.length = 0;
  assert.deepEqual(T.pilotCandidates(s.ws, { pilotOnly: true }), []);
  assert.equal(asked.reports.length + asked.forensics.length + asked.projects.length, 0);
});

test('pilot perf: the Daily Brief scans only the pilot for its exit section, and every section reads exactly as it did', (t) => {
  const s = setup(t, 3);
  const [a] = s.others;
  const now = Date.now();
  const sameBrief = (o) => ({ sections: o.sections, text: o.text.split('\n').slice(1).join('\n') });

  for (const pilot of [[], [s.pid, a]]) {
    for (const id of [s.pid, a, ...s.others.slice(1)]) T.setPilot(s.ws, id, pilot.includes(id), { by: 'test' });
    // The new scan: what the section asks for, and what it reads.
    const real = T.pilotCandidates;
    const asked = [];
    const readBy = [];
    T.pilotCandidates = (ws, o = {}) => {
      asked.push(o);
      const seen = [];
      const realLoad = reports.loadReports;
      reports.loadReports = (w, id, ...rest) => { seen.push(id); return realLoad(w, id, ...rest); };
      try { return real(ws, o); } finally { reports.loadReports = realLoad; readBy.push(seen); }
    };
    let now1;
    try { now1 = B.brief(s.ws, { now }); } finally { T.pilotCandidates = real; }
    assert.equal(asked.length, 1);
    assert.equal(asked[0].pilotOnly, true, 'the section asks for the pilot only');
    assert.deepEqual([...new Set(readBy[0])].sort(), pilot.slice().sort(), `the exit scan read ${pilot.length} pilot project(s) and no other`);

    // The old scan: every candidate read, the section picking out the pilot's.
    T.pilotCandidates = (ws, o = {}) => real(ws, { ...o, pilotOnly: false });
    let old;
    try { old = B.brief(s.ws, { now }); } finally { T.pilotCandidates = real; }
    assert.deepEqual(sameBrief(now1), sameBrief(old), `the brief reads the same with ${pilot.length} in the pilot`);
    assert.equal(now1.text_sha256, old.text_sha256);
    assert.equal(now1.sections.map((x) => x.id).join(), 'pm_cards,exceptions,invalidated,near_invalidation,stale_basis,ticket_repairs,pilot_exits,held,horizons,research_waiting,models_differ,spread,freshness,progress');
  }
  // The exit section's own words, both ways.
  for (const id of [s.pid, a]) T.setPilot(s.ws, id, false, { by: 'test' });
  const none = B.brief(s.ws, { now }).sections.find((x) => x.id === 'pilot_exits');
  assert.equal(none.lines[0].text, 'No project is in the pilot, so no exit reading is expected.');
  assert.equal(none.count, 0);
  T.setPilot(s.ws, a, true, { by: 'test' });
  const one = B.brief(s.ws, { now }).sections.find((x) => x.id === 'pilot_exits');
  assert.equal(one.count, 1);
  assert.match(one.lines[0].text, /^Bare 1 Example \(FICTIONAL\): no current exit reading at \$500\./);
});

// A saved, waiting ticket on the fixture project (as the brief's own tests make one).
function answerFor(ticket) {
  const at = new Date().toISOString();
  const b = {
    format: T.FORMAT, ticket_id: ticket.ticket_id, project_id: ticket.project_id, prompt_version: T.PROMPT_VERSION, role: 'prosecutor', model: 'claude', model_version: 'claude-test', as_of: at,
    researcher_report_id: ticket.basis.researcher.report_id, researcher_report_sha256: ticket.basis.researcher.original.sha256,
    prosecution: { verdict: 'thesis_damaged', conviction_score: 38, tests: { mercenary_emissions: { result: 'fail', finding: 'x (FICTIONAL).', source_ids: ['S1'] }, tax_revenue: { result: 'pass', finding: '' }, exit_slippage: { result: 'unknown', finding: 'No reading.' }, unverified_claims: { result: 'fail', finding: 'y' } }, fatal_flaws: [{ test: 'mercenary_emissions', severity: 'fatal', finding: 'z (FICTIONAL).', source_ids: ['S1'] }], strongest_bull_rebuttal: 'Emissions taper.' },
    proposal: { proposal_type: 'ACCUMULATE', non_consensus_thesis: 'The market assumes organic demand; the evidence shows paid activity; the emission cut in Q1 makes the difference observable.', entry_zone: { low_usd: 0.8, high_usd: 0.9, basis: 'prior range' }, upside_target: { price_usd: 1.4, basis: 'fees double' }, invalidation_trigger: { price_usd: 0.7, statement: 'Below $0.70.' } },
    agent_disagreement_note: 'I score 38.',
    sources: [{ source_id: 'S1', url: 'https://example.com/xmpl/emissions', publisher: 'Example (FICTIONAL)', retrieved_at: at, excerpt: 'fictional' }],
  };
  return `# Prosecution (FICTIONAL)\n\n${'The four tests and the flaws, written out for the test fixture. '.repeat(12)}\n\n\`\`\`json\n${JSON.stringify(b, null, 2)}\n\`\`\`\n`;
}

test('pilot perf (review A07): a pilot project\'s unreadable ticket still makes each ticket section partial, its count unknown', (t) => {
  const s = setup(t, 2);
  const real = portfolio.computePortfolio;
  portfolio.computePortfolio = (...a) => ({ ...real(...a), positions: [{ project_id: s.pid, closed: false, quantity: '10', value_usd: null, price: { status: 'missing' } }] });
  t.after(() => { portfolio.computePortfolio = real; });
  const tk = withExitReadings(1.5, () => T.createTicket(s.ws, { project_id: s.pid, assistant: true })).ticket;
  freshPrice(s.ws, 'example-payfi-fictional', 0.85);
  const saved = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: answerFor(T.loadTicket(s.ws, s.pid, tk.ticket_id)) });
  T.setPilot(s.ws, s.pid, true, { by: 'test' });
  const now = Date.parse(saved.receipt.saved_at) + 3600000;

  const healthy = B.brief(s.ws, { now });
  assert.equal(healthy.sections.find((x) => x.id === 'pm_cards').state, 'ok');
  assert.equal(healthy.sections.find((x) => x.id === 'pm_cards').count, 1);

  const rel = `projects/${s.pid}/tickets/receipts/${saved.receipt_id}.json`;
  const r = readJson(s.ws.abs(rel));
  r.researcher = null;
  atomicWrite(s.ws.abs(rel), jsonText(r));
  const out = B.brief(s.ws, { now });
  for (const id of ['pm_cards', 'invalidated', 'near_invalidation', 'stale_basis']) {
    const sec = out.sections.find((x) => x.id === id);
    assert.equal(sec.state, 'partial', id);
    assert.equal(sec.count, null, `${id}: the count is unknown`);
    assert.equal(sec.unreadable_count, 1, id);
    assert.ok(!sec.lines.some((l) => l.text === 'None right now.'), id);
  }
});
