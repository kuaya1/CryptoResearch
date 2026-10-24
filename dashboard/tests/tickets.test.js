'use strict';
// PM trade tickets (core/tickets.js, 2026-10-24): the desk sizes by Eric's
// rules and never by a model's number; the Prosecutor's ticket is checked
// against the ticket it answers, saved once and never rewritten; the two
// agents are never averaged; a decision records Eric's choice and nothing
// else; invalidation is read against prices without touching the record;
// reading writes nothing. Fictional workspaces and fixtures only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempWorkspace, addFixtureProject, importAllFixtures, hashTree } = require('./helpers');
const T = require('../core/tickets');
const { sha256, readJson, atomicWrite, jsonText } = require('../core/fsx');

function setup(t) {
  const w = tempWorkspace('tickets');
  t.after(w.cleanup);
  const pid = addFixtureProject(w.ws).project_id;
  return { ...w, pid };
}

function withReport(t) {
  const s = setup(t);
  importAllFixtures(s.ws);
  return s;
}

// The Prosecutor's answer for a ticket, as a model would write it (one fixed
// time, so the same answer is the same text).
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

// A measured exit at $500 in the ticket's basis (the job record, not the
// frozen packet), for the paths that need a proven exit.
function withExit(ws, pid, tid, costPct, complete = true) {
  const rel = `projects/${pid}/tickets/${tid}/ticket.json`;
  const t = readJson(ws.abs(rel));
  t.basis.exits = [{ size_usd: 500, status: 'current', cost_pct: costPct, cost_complete: complete, missing_costs: complete ? [] : ['network fee'] }, { size_usd: 2000, status: 'current', cost_pct: costPct * 2, cost_complete: complete }];
  atomicWrite(ws.abs(rel), jsonText(t));
}

test('the sizing gate: $500 only with a proven exit within 5% and a grade of 55; nothing new under 40, or under 55 unless held', () => {
  const s = T.sizingOf({ settings: {} });
  assert.deepEqual([s.standard_risk_usd, s.starter_risk_usd, s.max_exit_cost_pct, s.min_grade_new_entry, s.min_grade_any], [500, 250, 5, 55, 40]);
  const basis = (grade, exit, held = false) => ({ researcher: { grade: typeof grade === 'number' ? { status: 'firm', value: grade } : grade }, held, exits: exit ? [{ size_usd: 500, ...exit }] : [] });
  const ok = T.gate(basis(62, { cost_pct: 3.1, cost_complete: true }), s, 'ACCUMULATE');
  assert.equal(ok.proposal_type, 'ACCUMULATE');
  assert.equal(ok.suggested_risk_usd, 500);
  const lower = T.gate(basis(62, { cost_pct: 3.1, cost_complete: false, missing_costs: ['network fee'] }), s, 'ACCUMULATE');
  assert.equal(lower.suggested_risk_usd, 0, 'a lower bound under the limit proves nothing');
  assert.equal(lower.capped.from, 'ACCUMULATE');
  assert.equal(lower.proposal_type, 'WATCH_ONLY');
  assert.match(lower.reasons.join(' '), /lower bound/);
  assert.equal(T.gate(basis(62, { cost_pct: 6, cost_complete: true }), s, 'LIMIT_TRAP').suggested_risk_usd, 0);
  assert.equal(T.gate(basis(62, null), s, 'ACCUMULATE').suggested_risk_usd, 0, 'no reading is no proof');
  const newEntry = T.gate(basis(50, { cost_pct: 1, cost_complete: true }), s, 'ACCUMULATE');
  assert.equal(newEntry.proposal_type, 'WATCH_ONLY');
  assert.match(newEntry.reasons.join(' '), /under 55 for a new entry/);
  const lowHeld = T.gate(basis(35, { cost_pct: 1, cost_complete: true }, true), s, 'TRIM_EXIT');
  assert.equal(lowHeld.proposal_type, 'TRIM_EXIT', 'trimming a held position takes no new risk');
  assert.equal(lowHeld.suggested_risk_usd, 0);
  assert.equal(T.gate(basis(35, { cost_pct: 1, cost_complete: true }), s, 'TRIM_EXIT').proposal_type, 'WATCH_ONLY', 'nothing held to trim');
  assert.equal(T.gate(basis({ status: 'withheld', value: null }, { cost_pct: 1, cost_complete: true }), s, 'ACCUMULATE').suggested_risk_usd, 0);
  assert.equal(T.gate(basis({ status: 'range', low: 52, high: 70 }, { cost_pct: 1, cost_complete: true }), s, 'ACCUMULATE').suggested_risk_usd, 0, 'a range is read by its low end');
});

test('the published Prosecutor prompt is pinned', () => {
  const dir = path.join(__dirname, '..', '..', 'templates', 'tickets');
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'LOCK.json'), 'utf8'));
  for (const [file, want] of Object.entries(lock.sha256)) assert.equal(sha256(fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n')), want, `${file} changed: publish the next version instead`);
});

test('a ticket needs Agent 1: no Claude report, nothing opened; with one, the prompt and packet are frozen and pinned', (t) => {
  const s = setup(t);
  assert.equal(T.createTicket(s.ws, { project_id: s.pid }).status, 'needs_research');
  importAllFixtures(s.ws);
  const out = T.createTicket(s.ws, { project_id: s.pid });
  assert.equal(out.status, 'created');
  const tk = out.ticket;
  assert.equal(tk.job.state, 'waiting');
  const p = T.promptFor(s.ws, tk);
  assert.equal(sha256(p.text), tk.prompt.sha256);
  assert.match(p.text, /short-seller/);
  assert.match(p.text, /Never average/);
  assert.ok(p.text.includes(`BEGIN REPORT ${tk.basis.researcher.report_id}`), 'the report text is in the prompt, fenced as evidence');
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(p.text), 'every placeholder is filled');
  assert.equal(T.createTicket(s.ws, { project_id: s.pid }).status, 'resumed', 'the open ticket is resumed, not doubled');
  // A changed frozen prompt is an integrity refusal, never rebuilt.
  fs.appendFileSync(s.ws.abs(tk.prompt.path), 'tampered');
  assert.equal(T.promptFor(s.ws, T.loadTicket(s.ws, s.pid, tk.ticket_id)).code, 'INTEGRITY');
});

test('save: the block must answer this ticket; the desk caps an unproven ACCUMULATE to $0; both agents kept side by side', (t) => {
  const s = withReport(t);
  const tk = T.createTicket(s.ws, { project_id: s.pid, assistant: true }).ticket;
  assert.throws(() => T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: answer(tk, { researcher_report_id: 'another-report' }) }), (e) => e.code === 'CONFLICT' && /researcher_report_id/.test(e.message));
  const out = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: answer(tk) });
  assert.equal(out.status, 'saved');
  assert.equal(out.verified, true);
  const r = out.receipt;
  assert.equal(r.desk.model_proposal_type, 'ACCUMULATE');
  assert.equal(r.desk.proposal_type, 'WATCH_ONLY', 'the fixture has no exit reading, so no risk');
  assert.equal(r.desk.suggested_risk_usd, 0);
  assert.equal(r.desk.exit_cost_500_usd_pct, null);
  assert.equal(r.agent_disagreement.researcher.grade, 60.5);
  assert.equal(r.agent_disagreement.prosecutor.conviction_score, 38);
  assert.equal(r.agent_disagreement.spread_points, 22.5, 'the difference, never an average');
  assert.equal(T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: answer(tk) }).status, 'unchanged', 'the same text twice is one receipt');
  assert.throws(() => T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: answer(tk, { agent_disagreement_note: 'changed' }) }), /revision/);
  const v = T.view(s.ws, s.pid);
  assert.equal(v.ticket.status, 'pending_pm_review');
  assert.equal(T.nextStep(s.ws, s.pid).step, 'pm_review');
});

test('decisions: approve gives the suggested $500, halve the $250 starter, veto nothing; undo takes the last back; a $0 ticket cannot be approved', (t) => {
  const s = withReport(t);
  const tk0 = T.createTicket(s.ws, { project_id: s.pid, assistant: true }).ticket;
  const zero = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk0.ticket_id, text: answer(tk0) });
  assert.throws(() => T.decide(s.ws, s.pid, { receipt_id: zero.receipt_id, action: 'approve' }), (e) => e.code === 'REFUSED');
  const tk = T.createTicket(s.ws, { project_id: s.pid, assistant: true, refresh: true }).ticket;
  withExit(s.ws, s.pid, tk.ticket_id, 2.4);
  const saved = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: answer(T.loadTicket(s.ws, s.pid, tk.ticket_id)) });
  assert.equal(saved.receipt.desk.proposal_type, 'ACCUMULATE');
  assert.equal(saved.receipt.desk.suggested_risk_usd, 500);
  assert.throws(() => T.decide(s.ws, s.pid, { receipt_id: zero.receipt_id, action: 'veto' }), (e) => e.code === 'NEWER_REPORT', 'an older ticket is not decided past a newer one');
  const a = T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'approve' });
  assert.equal(a.result.decision.pm_approved_risk_usd, 500);
  assert.equal(T.view(s.ws, s.pid).ticket.status, 'risk_granted');
  T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'undo' });
  assert.equal(T.view(s.ws, s.pid).ticket.status, 'pending_pm_review');
  assert.equal(T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'halve' }).result.decision.pm_approved_risk_usd, 250);
  T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'undo' });
  assert.equal(T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'veto' }).result.decision.pm_approved_risk_usd, 0);
  assert.equal(T.view(s.ws, s.pid).ticket.status, 'vetoed');
  const lines = T.readDecisions(s.ws, s.pid);
  assert.equal(lines.length, 5, 'append-only: every decision and undo is a line');
  assert.ok(lines.every((l) => /places no order/.test(l.meaning)));
});

test('invalidation is read on every read against the hourly prices; the stored ticket is never rewritten; reading writes nothing', (t) => {
  const s = withReport(t);
  const tk = T.createTicket(s.ws, { project_id: s.pid, assistant: true }).ticket;
  withExit(s.ws, s.pid, tk.ticket_id, 1.5);
  const saved = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: answer(T.loadTicket(s.ws, s.pid, tk.ticket_id)) });
  const cg = 'example-payfi-fictional';
  const obs = (price, atMs) => {
    const at = new Date(atMs).toISOString();
    const dir = s.ws.abs('market-data/observations');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${at.slice(0, 7)}.jsonl`), `${JSON.stringify({ fetched_at: at, provider: 'coingecko', assets: [{ id: cg, price_usd: price, source_last_updated_at: at, fetched_at: at }] })}\n`);
  };
  const t0 = Date.parse(saved.receipt.saved_at);
  obs(0.85, t0 + 3600000);
  let v = T.view(s.ws, s.pid, { now: t0 + 2 * 3600000 });
  assert.equal(v.ticket.status, 'pending_pm_review');
  assert.equal(v.ticket.invalidation.checks.find((c) => c.kind === 'price').status, 'holding');
  assert.equal(v.ticket.invalidation.checks.find((c) => c.kind === 'metric').status, 'not_bound', 'no DefiLlama binding: not checked, never "holding"');
  obs(0.69, t0 + 3 * 3600000);
  const receiptFile = s.ws.abs(`projects/${s.pid}/tickets/receipts/${saved.receipt_id}.json`);
  const before = fs.readFileSync(receiptFile, 'utf8');
  const tree = hashTree(s.root);
  v = T.view(s.ws, s.pid, { now: t0 + 4 * 3600000 });
  assert.equal(v.ticket.status, 'invalidated');
  assert.match(v.ticket.invalidation.words, /0\.69/);
  assert.deepEqual(hashTree(s.root), tree, 'reading writes nothing');
  assert.equal(fs.readFileSync(receiptFile, 'utf8'), before);
});

test('the pilot queue walks Agent 1, then Agent 2, then Eric', (t) => {
  const s = setup(t);
  T.setPilot(s.ws, s.pid, true);
  assert.equal(T.pilotQueue(s.ws)[0].step, 'research');
  importAllFixtures(s.ws);
  assert.equal(T.pilotQueue(s.ws)[0].step, 'ticket');
  const tk = T.createTicket(s.ws, { project_id: s.pid, assistant: true }).ticket;
  assert.equal(T.pilotQueue(s.ws)[0].ticket_id, tk.ticket_id);
  T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: answer(tk) });
  assert.equal(T.pilotQueue(s.ws)[0].step, 'pm_review');
  T.setPilot(s.ws, s.pid, false);
  assert.equal(T.pilotQueue(s.ws).length, 0);
});

test('connector: only Claude prosecutes; the tools hand out the frozen prompt and save through the same checks', async (t) => {
  const s = withReport(t);
  const { makeMcp, TOOLS } = require('../mcp');
  for (const n of ['autonomous_pilot_queue', 'start_ticket', 'pending_tickets', 'save_ticket']) assert.ok(TOOLS.some((x) => x.name === n), n);
  const handle = makeMcp(s.ws);
  const callAs = async (assistant, name, args) => {
    let body = '';
    const req = require('stream').Readable.from([Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }))]);
    req.method = 'POST';
    const res = { writeHead() {}, end(b) { body = b || ''; } };
    await handle(req, res, { assistant });
    return JSON.parse(body).result;
  };
  const refused = await callAs('chatgpt', 'start_ticket', { project_id: s.pid, owner_request: 'test' });
  assert.equal(refused.isError, true);
  const started = await callAs('claude', 'start_ticket', { project_id: s.pid, owner_request: 'autonomous pilot' });
  assert.equal(started.isError, false);
  const run = started.structuredContent.run;
  assert.equal(run.prompt_delivery.status, 'verified');
  assert.equal(sha256(run.prompt), run.prompt_delivery.sha256);
  const tk = T.loadTicket(s.ws, s.pid, run.run_id);
  const saved = await callAs('claude', 'save_ticket', { project_id: s.pid, ticket_id: tk.ticket_id, ticket_markdown: answer(tk) });
  assert.equal(saved.structuredContent.status, 'saved');
  assert.equal(saved.structuredContent.receipt.suggested_risk_usd, 0);
  const q = await callAs('claude', 'autonomous_pilot_queue', { project: s.pid });
  assert.equal(q.structuredContent.steps[0].step, 'pm_review');
});

test('a $0 ticket is passed (archiving the project, Undo restores it) or kept on watch; approve, halve and veto are for tickets that suggest risk', (t) => {
  const s = withReport(t);
  const projects = require('../core/projects');
  const tk = T.createTicket(s.ws, { project_id: s.pid, assistant: true }).ticket;
  const saved = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: answer(tk) });
  assert.equal(saved.receipt.desk.suggested_risk_usd, 0);
  assert.throws(() => T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'trim' }), (e) => e.code === 'REFUSED', 'a trim needs a TRIM_EXIT proposal');
  const pass = T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'pass' });
  assert.equal(pass.result.project_archived, true);
  assert.equal(projects.getProject(s.ws, s.pid).status, 'archived');
  assert.equal(T.view(s.ws, s.pid).ticket.status, 'passed');
  const undo = T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'undo' });
  assert.equal(undo.result.project_restored, true);
  assert.equal(projects.getProject(s.ws, s.pid).status, 'active');
  T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'watch' });
  assert.equal(T.view(s.ws, s.pid).ticket.status, 'watching');
  // A ticket that suggests risk is not "passed" or "watched".
  const tk2 = T.createTicket(s.ws, { project_id: s.pid, assistant: true, refresh: true }).ticket;
  withExit(s.ws, s.pid, tk2.ticket_id, 2);
  const risky = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk2.ticket_id, text: answer(T.loadTicket(s.ws, s.pid, tk2.ticket_id)) });
  assert.throws(() => T.decide(s.ws, s.pid, { receipt_id: risky.receipt_id, action: 'pass' }), (e) => e.code === 'REFUSED');
});

test('the pilot queue names whether a project named outright is in the pilot', async (t) => {
  const s = withReport(t);
  assert.equal(T.nextStep(s.ws, s.pid).pilot, false);
  const { makeMcp } = require('../mcp');
  const handle = makeMcp(s.ws);
  const ask = async () => {
    let body = '';
    const req = require('stream').Readable.from([Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'autonomous_pilot_queue', arguments: { project: s.pid } } }))]);
    req.method = 'POST';
    await handle(req, { writeHead() {}, end(b) { body = b || ''; } }, { assistant: 'claude' });
    return JSON.parse(body).result.structuredContent.message;
  };
  assert.match(await ask(), /pilot off/);
  assert.doesNotMatch(await ask(), /in the pilot/);
  T.setPilot(s.ws, s.pid, true);
  assert.match(await ask(), /pilot on/);
});

test('native L1 exemption (cr-ticket-sizing@2): the chain\'s own coin at $10B+ passes the exit check without a DEX quote; a smaller coin, a token, or a ticket frozen under @1 does not', (t) => {
  const s = T.sizingOf({ settings: {} });
  assert.equal(s.version, 'cr-ticket-sizing@2');
  assert.equal(s.native_l1_min_market_cap_usd, 10e9);
  const basis = (native, cap) => ({ researcher: { grade: { status: 'firm', value: 60 } }, held: true, exits: [], native: { native_chain: native, market_cap_usd: cap } });
  const eth = T.gate(basis(true, 280e9), s, 'ACCUMULATE');
  assert.equal(eth.exit_basis, 'native_l1_liquid');
  assert.equal(eth.suggested_risk_usd, 500);
  const small = T.gate(basis(true, 2e9), s, 'ACCUMULATE');
  assert.equal(small.exit_basis, 'measured');
  assert.equal(small.suggested_risk_usd, 0);
  assert.equal(T.gate(basis(false, 280e9), s, 'ACCUMULATE').suggested_risk_usd, 0, 'a token always needs a measured exit');
  assert.equal(T.gate({ ...basis(true, 280e9), native: undefined }, s, 'ACCUMULATE').suggested_risk_usd, 0, 'no native record (an @1 basis) is no exemption');
  const v1 = { ...s, version: 'cr-ticket-sizing@1' };
  delete v1.native_l1_min_market_cap_usd;
  assert.equal(T.gate(basis(true, 280e9), v1, 'ACCUMULATE').suggested_risk_usd, 0, 'a ticket frozen under @1 keeps its rules');
  assert.equal(T.gate(basis(true, 280e9), v1, 'ACCUMULATE').version, 'cr-ticket-sizing@1');
  const lowGrade = T.gate({ ...basis(true, 280e9), researcher: { grade: { status: 'firm', value: 30 } } }, s, 'ACCUMULATE');
  assert.equal(lowGrade.suggested_risk_usd, 0, 'the exemption covers the exit only, never the grade floors');
});

test('a new ticket freezes whether the coin is native and its market cap, and the prompt states the exemption', (t) => {
  const s = withReport(t);
  const tk = T.createTicket(s.ws, { project_id: s.pid }).ticket;
  assert.deepEqual(tk.basis.native, { native_chain: false, market_cap_usd: null });
  assert.equal(tk.sizing.version, 'cr-ticket-sizing@2');
  assert.match(T.promptFor(s.ws, tk).text, /native L1 coin/);
});
