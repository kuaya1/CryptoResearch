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
const { tempWorkspace, addFixtureProject, importAllFixtures, hashTree, withExitReadings, freshPrice } = require('./helpers');
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

// A ticket opened with a measured exit frozen into its packet (the path a real
// reading takes: exitsOf, then the packet the gate reads) and a fresh stored
// price above the answer's $0.70 trigger, for the paths that need risk.
function riskTicket(s, costPct, opts = {}, { complete = true, price = 0.85 } = {}) {
  const out = withExitReadings(costPct, () => T.createTicket(s.ws, { project_id: s.pid, assistant: true, ...opts }), { complete });
  if (price !== null) freshPrice(s.ws, 'example-payfi-fictional', price);
  return out.ticket;
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
  const tk = riskTicket(s, 2.4, { refresh: true });
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
  const tk = riskTicket(s, 1.5);
  const saved = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: answer(T.loadTicket(s.ws, s.pid, tk.ticket_id)) });
  const cg = 'example-payfi-fictional';
  const obs = (price, atMs) => {
    const at = new Date(atMs).toISOString();
    const dir = s.ws.abs('market-data/observations');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${at.slice(0, 7)}.jsonl`), `${JSON.stringify({ fetched_at: at, provider: 'coingecko', assets: [{ id: cg, price_usd: price, source_last_updated_at: at, fetched_at: at }] })}\n`);
  };
  const t0 = Date.parse(saved.receipt.saved_at);
  obs(0.86, t0 + 1000);
  obs(0.85, t0 + 3600000);
  let v = T.view(s.ws, s.pid, { now: t0 + 2 * 3600000 - 1000 });
  assert.equal(v.ticket.status, 'pending_pm_review');
  assert.equal(v.ticket.invalidation.checks.find((c) => c.kind === 'price').status, 'holding');
  assert.equal(v.ticket.invalidation.checks.find((c) => c.kind === 'metric').status, 'not_bound', 'no DefiLlama binding: not checked, never "holding"');
  obs(0.84, t0 + 2 * 3600000);
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
  const tk2 = riskTicket(s, 2, { refresh: true });
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

test('ticket sizing in Preferences: the server takes it within the same bounds as sizingOf; new tickets freeze it, saved tickets keep theirs', (t) => {
  const { validateSettingsPatch } = require('../server');
  const ok = validateSettingsPatch({ tickets: { sizing: { standard_risk_usd: 400, starter_risk_usd: 200, exit_size_usd: 400, max_exit_cost_pct: 4, min_grade_new_entry: 60, min_grade_any: 45, native_l1_min_market_cap_usd: 20e9 } } });
  assert.deepEqual(ok.tickets.sizing, { standard_risk_usd: 400, starter_risk_usd: 200, exit_size_usd: 400, max_exit_cost_pct: 4, min_grade_new_entry: 60, min_grade_any: 45, native_l1_min_market_cap_usd: 20e9 });
  const bad = (sizing, re) => assert.throws(() => validateSettingsPatch({ tickets: { sizing } }), (e) => e.code === 'INVALID' && re.test(e.message));
  bad({ standard_risk_usd: 0 }, /more than 0/);
  bad({ standard_risk_usd: -5 }, /between/);
  bad({ max_exit_cost_pct: 101 }, /between 0 and 100/);
  bad({ min_grade_any: 120 }, /between 0 and 100/);
  bad({ standard_risk_usd: 100, starter_risk_usd: 300 }, /starter tranche/);
  bad({ min_grade_new_entry: 40, min_grade_any: 50 }, /minimum grade/);
  bad({ native_l1_min_market_cap_usd: 'x' }, /between/);
  // Saved values are read by sizingOf; out of bounds falls back to the defaults.
  const s = withReport(t);
  const before = T.createTicket(s.ws, { project_id: s.pid }).ticket;
  assert.equal(before.sizing.standard_risk_usd, 500);
  const file = path.join(s.root, 'config', 'settings.json');
  const cfg = readJson(file);
  cfg.tickets = { sizing: { standard_risk_usd: 400, starter_risk_usd: 999, min_grade_any: 140 } };
  atomicWrite(file, jsonText(cfg));
  const ws2 = require('../core/workspace').openWorkspace({ root: s.root, actor: 'test' });
  const now = T.sizingOf(ws2);
  assert.equal(now.standard_risk_usd, 400);
  assert.equal(now.starter_risk_usd, 400, 'the starter tranche never exceeds standard risk');
  assert.equal(now.min_grade_any, 40, 'out of bounds reads as the default');
  assert.equal(T.loadTicket(ws2, s.pid, before.ticket_id).sizing.standard_risk_usd, 500, 'a saved ticket keeps the values it froze');
  const after = T.createTicket(ws2, { project_id: s.pid, restart: true }).ticket;
  assert.equal(after.sizing.standard_risk_usd, 400, 'a new ticket freezes the values in force');
});
test('each PM decision and its undo also appears in the journal, and a journal failure keeps the decision', (t) => {
  const s = withReport(t);
  const tk = riskTicket(s, 2);
  const saved = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: answer(T.loadTicket(s.ws, s.pid, tk.ticket_id)) });
  const notes = require('../core/notes');
  const a = T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'halve', note: 'half first' });
  assert.equal(a.result.journal.status, 'saved');
  let j = notes.loadJournal(s.ws, s.pid).filter((e) => e.type === 'decision');
  assert.equal(j.length, 1);
  assert.ok(j[0].reasons.includes('pm_action: halve'));
  assert.ok(j[0].reasons.includes(`receipt: ${saved.receipt_id}`));
  assert.ok(j[0].reasons.some((r) => /^approved_risk_usd: 250$/.test(r)));
  // The same decision again writes nothing new.
  assert.equal(T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'halve' }).result.status, 'unchanged');
  assert.equal(notes.loadJournal(s.ws, s.pid).filter((e) => e.type === 'decision').length, 1);
  T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'undo' });
  j = notes.loadJournal(s.ws, s.pid).filter((e) => e.type === 'decision');
  assert.equal(j.length, 2);
  assert.ok(j.some((e) => e.reasons.includes('pm_action: undo')));
  // A journal failure never loses the decision.
  const orig = notes.addJournal;
  notes.addJournal = () => { throw new Error('disk full'); };
  try {
    const v = T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'veto' });
    assert.equal(v.result.status, 'saved');
    assert.equal(v.result.journal.status, 'failed');
  } finally { notes.addJournal = orig; }
  assert.equal(T.view(s.ws, s.pid).ticket.decision.action, 'veto');
});

test('missing exit quotes are named in the packet, the receipt and the view, with the Exits tab address', (t) => {
  const s = withReport(t);
  const tk = T.createTicket(s.ws, { project_id: s.pid, assistant: true }).ticket;
  const frozen = JSON.parse(fs.readFileSync(s.ws.abs(tk.packet.path), 'utf8'));
  assert.deepEqual(frozen.exits_missing.map((m) => m.size_usd), [500, 2000], 'both sizes have no reading in the fixture');
  for (const m of frozen.exits_missing) {
    assert.ok(m.reason && m.reason.length > 10, "a reason in words");
    assert.equal(m.link, `#/project/${encodeURIComponent(s.pid)}/forensics?fx=exits`);
  }
  const saved = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: answer(tk) });
  assert.deepEqual(saved.receipt.desk.exits_missing.map((m) => m.size_usd), [500, 2000]);
  assert.deepEqual(T.view(s.ws, s.pid).ticket.exits_missing.map((m) => m.size_usd), [500, 2000]);
});

test('pilot candidates: held first, then by grade, no report last; the gate with no proposal; nothing written, nothing opted in', (t) => {
  const s = withReport(t);
  const projects = require('../core/projects');
  const bare = projects.addProject(s.ws, { name: 'Bare Example (FICTIONAL)', symbol: 'BARE', official_website: 'https://bare-fictional.test', coingecko_id: 'bare-example-fictional', assets: [{ chain: 'other-chain', contract_address: 'FICTIONAL-CONTRACT-BARE' }], evidence: [{ url: 'https://bare-fictional.test', note: 'fictional' }], sector_profile: 'payfi-credit@1' }).project_id;
  const tree = hashTree(s.root);
  const rows = T.pilotCandidates(s.ws);
  assert.deepEqual(hashTree(s.root), tree, 'reading writes nothing');
  const ids = rows.map((r) => r.project_id);
  assert.ok(ids.includes(s.pid));
  // A verified project is listed only when its identity is verified.
  const withR = rows.find((r) => r.project_id === s.pid);
  const without = rows.find((r) => r.project_id === bare);
  assert.equal(without.grade, null);
  assert.equal(without.report_id, null);
  assert.ok(ids.indexOf(s.pid) < ids.indexOf(bare), 'a project without a report comes after one with a grade');
  assert.equal(withR.in_pilot, false);
  assert.equal(withR.gate.risk_allowed, false, 'no exit reading, so no new risk');
  assert.equal(withR.exit_reading.present, false);
  assert.equal(withR.exit_reading.size_usd, 500);
  assert.ok(withR.report_id);
  assert.ok(withR.report_age_days === null || withR.report_age_days >= 0);
  assert.ok('report_prompt_version' in withR);
  assert.equal(T.pilotQueue(s.ws).length, 0, 'nothing was opted into the pilot');
});

test('pilot candidates: a held project comes before a better-graded one', (t) => {
  const s = withReport(t);
  const projects = require('../core/projects');
  const other = projects.addProject(s.ws, { name: 'Other Example (FICTIONAL)', symbol: 'OTHR', official_website: 'https://othr-fictional.test', coingecko_id: 'other-example-fictional', assets: [{ chain: 'other-chain', contract_address: 'FICTIONAL-CONTRACT-OTHR' }], evidence: [{ url: 'https://othr-fictional.test', note: 'fictional' }], sector_profile: 'payfi-credit@1' }).project_id;
  const portfolio = require('../core/portfolio');
  const real = portfolio.computePortfolio;
  portfolio.computePortfolio = () => ({ positions: [{ closed: false, project_id: other }] });
  t.after(() => { portfolio.computePortfolio = real; });
  const rows = T.pilotCandidates(s.ws);
  assert.equal(rows[0].project_id, other);
  assert.equal(rows[0].held, true);
  assert.ok(rows[0].gate.allowed_types.includes('TRIM_EXIT'));
  assert.equal(rows.find((r) => r.project_id === s.pid).held, false);
});

// Invalidation coverage (cr-ticket-invalidation@2).
function coverageSetup(t) {
  const s = withReport(t);
  const tk = riskTicket(s, 1.5);
  const saved = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: answer(T.loadTicket(s.ws, s.pid, tk.ticket_id)) });
  const t0 = Date.parse(saved.receipt.saved_at);
  const obs = (price, atMs) => {
    const at = new Date(atMs).toISOString();
    const dir = s.ws.abs('market-data/observations');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${at.slice(0, 7)}.jsonl`), `${JSON.stringify({ fetched_at: at, provider: 'coingecko', assets: [{ id: 'example-payfi-fictional', price_usd: price, source_last_updated_at: at, fetched_at: at }] })}\n`);
  };
  const price = (now) => T.view(s.ws, s.pid, { now }).ticket.invalidation.checks.find((c) => c.kind === 'price');
  return { ...s, saved, t0, obs, price };
}
const H = 3600000;

test('invalidation@2: a 12 h gap with the low inside reads unknown, not holding; full coverage reads holding', (t) => {
  const c = coverageSetup(t);
  assert.equal(c.saved.receipt.desk.invalidation_version, T.INVALIDATION_VERSION);
  for (const h of [0.5, 1, 2, 3, 16, 17, 18, 19, 20]) c.obs(0.9, c.t0 + h * H);
  const thin = c.price(c.t0 + 20.5 * H);
  assert.equal(thin.status, 'unknown');
  assert.ok(thin.coverage.coverage_pct < 90);
  assert.equal(thin.coverage.gaps.length, 1);
  assert.equal(thin.coverage.gaps[0].hours, 13);
  assert.match(thin.words, /gaps over 6 h/);
  const v = T.view(c.ws, c.pid, { now: c.t0 + 20.5 * H });
  assert.equal(v.ticket.invalidation.invalidated, false);
  assert.equal(v.ticket.status, 'pending_pm_review');
  for (const h of [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) c.obs(0.9, c.t0 + h * H);
  const full = c.price(c.t0 + 20.5 * H);
  assert.equal(full.status, 'holding');
  assert.equal(full.coverage.coverage_pct, 100);
  assert.deepEqual(full.coverage.gaps, []);
});

test('invalidation@2: a reading at or below the threshold still triggers inside a gap; the threshold is Eric\'s setting', (t) => {
  const c = coverageSetup(t);
  c.obs(0.69, c.t0 + 2 * H);
  assert.equal(c.price(c.t0 + 20 * H).status, 'triggered');
  const d = coverageSetup(t);
  d.obs(0.9, d.t0 + 1 * H);
  d.obs(0.9, d.t0 + 2 * H);
  assert.equal(d.price(d.t0 + 4 * H).status, 'unknown', '2 of 4 hours is under 90%');
  d.ws.settings = { ...d.ws.settings, tickets: { invalidation: { min_coverage_pct: 40 } } };
  assert.equal(d.price(d.t0 + 4 * H).status, 'holding');
});

test('invalidation@2: a superseded or stale basis is said and the status is unchanged; an @1 receipt reads as before', (t) => {
  const c = coverageSetup(t);
  for (let h = 1; h <= 3; h++) c.obs(0.9, c.t0 + h * H);
  const fresh = T.view(c.ws, c.pid, { now: c.t0 + 3.5 * H });
  assert.equal(fresh.ticket.invalidation.basis_stale, undefined);
  const stale = T.view(c.ws, c.pid, { now: c.t0 + 400 * 86400000 });
  assert.match(stale.ticket.invalidation.basis_stale.why, /days old/);
  assert.notEqual(stale.ticket.status, undefined);
  // The same receipt without a version is read under @1: one reading, no coverage rule.
  const project = require('../core/projects').getProject(c.ws, c.pid);
  const receipt = JSON.parse(JSON.stringify(c.saved.receipt));
  delete receipt.desk.invalidation_version;
  const old = T.invalidationOf(c.ws, project, receipt, { now: c.t0 + 400 * 86400000 });
  assert.equal(old.version, T.INVALIDATION_V1);
  assert.equal(old.basis_stale, undefined);
  assert.equal(old.checks.find((x) => x.kind === 'price').coverage, undefined);
  assert.equal(old.checks.find((x) => x.kind === 'price').status, 'holding');
});

test('settings: tickets.invalidation.min_coverage_pct is bounded by the server', () => {
  const { validateSettingsPatch } = require('../server');
  assert.deepEqual(validateSettingsPatch({ tickets: { invalidation: { min_coverage_pct: 80 } } }).tickets.invalidation, { min_coverage_pct: 80 });
  const both = validateSettingsPatch({ tickets: { sizing: { standard_risk_usd: 400 }, invalidation: { min_coverage_pct: 75 } } });
  assert.equal(both.tickets.sizing.standard_risk_usd, 400);
  assert.equal(both.tickets.invalidation.min_coverage_pct, 75);
  for (const v of [0, -1, 101, 'x']) assert.throws(() => validateSettingsPatch({ tickets: { invalidation: { min_coverage_pct: v } } }), (e) => e.code === 'INVALID');
  assert.equal(T.sizingOf({ settings: {} }).version, T.SIZING_VERSION);
});

// ---------------------------------------------------------------------------
// The desk's pre-gate (cr-ticket-pregate@1, Eric 2026-10-24)

// Floors high enough that the fixture's grade is under them, so the grade
// alone rules out new risk. min_grade_any stays low: WATCH_ONLY, not HARD_PASS.
function gradeClosed(ws, floors = { min_grade_new_entry: 99, pregate_max_grade: 99, min_grade_any: 5 }) {
  ws.settings.tickets = { sizing: floors };
}

function stubHeld(t, pid, held) {
  const portfolio = require('../core/portfolio');
  const real = portfolio.computePortfolio;
  portfolio.computePortfolio = (...a) => { const pf = real(...a); return { ...pf, positions: held ? [{ project_id: pid, closed: false }] : [] }; };
  t.after(() => { portfolio.computePortfolio = real; });
}

test('pre-gate: a grade under the new-entry floor on an asset not held gets the desk\'s own receipt, no prompt and no model text', (t) => {
  const s = withReport(t);
  gradeClosed(s.ws);
  stubHeld(t, s.pid, false);
  const out = T.createTicket(s.ws, { project_id: s.pid, assistant: true });
  assert.equal(out.status, 'gate_closed');
  assert.equal(out.gate_closed, true);
  const r = out.receipt;
  assert.match(r.receipt_id, T.RECEIPT_RE);
  assert.equal(r.kind, 'desk_gate');
  assert.equal(r.pregate_version, 'cr-ticket-pregate@2');
  assert.equal(r.prosecution, null);
  assert.equal(r.proposal, null);
  assert.equal(r.agent_disagreement, null);
  assert.equal(r.desk.proposal_type, 'WATCH_ONLY');
  assert.equal(r.desk.suggested_risk_usd, 0);
  assert.match(r.desk.gate.reasons.join(' '), /for a new entry/);
  const packetText = fs.readFileSync(s.ws.abs(r.packet.path), 'utf8');
  assert.equal(sha256(packetText), r.packet.sha256, 'the frozen packet is kept beside the receipt');
  assert.equal(T.listTickets(s.ws, s.pid).length, 0, 'no ticket job, so no prompt file');
  assert.equal(T.pendingFor(s.ws).length, 0, 'nothing waits for a Prosecutor');
  assert.throws(() => T.receiptText(s.ws, s.pid, r.receipt_id), (e) => e.code === 'INVALID', 'there is no model text');
  // Under min_grade_any it is a HARD_PASS.
  const s2 = withReport(t);
  gradeClosed(s2.ws, { min_grade_new_entry: 99, pregate_max_grade: 99, min_grade_any: 98 });
  stubHeld(t, s2.pid, false);
  assert.equal(T.createTicket(s2.ws, { project_id: s2.pid }).receipt.desk.proposal_type, 'HARD_PASS');
});

test('pre-gate @2 (item 48): pregate_max_grade defaults to 48, is bounded by the new-entry floor, and a near miss opens a Prosecutor ticket capped at $0', (t) => {
  const { validateSettingsPatch } = require('../server');
  assert.equal(T.sizingOf({ settings: {} }).pregate_max_grade, 48);
  assert.equal(T.sizingOf({ settings: { tickets: { sizing: { min_grade_new_entry: 30 } } } }).pregate_max_grade, 30, 'never above the new-entry floor');
  assert.equal(T.sizingOf({ settings: { tickets: { sizing: { pregate_max_grade: 20 } } } }).pregate_max_grade, 20);
  assert.throws(() => validateSettingsPatch({ tickets: { sizing: { pregate_max_grade: 60, min_grade_new_entry: 55 } } }), (e) => e.code === 'INVALID');
  assert.deepEqual(validateSettingsPatch({ tickets: { sizing: { pregate_max_grade: 48 } } }).tickets.sizing, { pregate_max_grade: 48 });
  const sz = (o) => ({ ...T.sizingOf({ settings: {} }), ...o });
  const rep = (grade) => ({ grade });
  assert.equal(T.pregateReason(rep({ status: 'firm', value: 47 }), false, sz()) !== null, true, '47 is under 48: closed');
  assert.equal(T.pregateReason(rep({ status: 'firm', value: 48 }), false, sz()), null, '48 opens a ticket');
  assert.equal(T.pregateReason(rep({ status: 'firm', value: 54 }), false, sz()), null, 'a near miss opens a ticket');
  assert.equal(T.pregateReason(rep({ status: 'range', low: 40, high: 58 }), false, sz()), null, 'a range reaching the floor opens a ticket');
  assert.notEqual(T.pregateReason(rep({ status: 'range', low: 40, high: 50 }), false, sz()), null, 'a range under the floor and under 48 at its low end stays closed');
  assert.notEqual(T.pregateReason(rep({ status: 'withheld' }), false, sz()), null, 'withheld stays closed');
  assert.equal(T.pregateReason(rep({ status: 'firm', value: 47 }), true, sz()), null, 'a held project is never pre-gated');
  // The gate itself still caps risk at $0 for a near miss.
  const g = T.gate({ researcher: rep({ status: 'firm', value: 52 }), held: false, exits: [], native: null }, sz());
  assert.equal(g.suggested_risk_usd, 0);
  assert.equal(g.proposal_type, 'WATCH_ONLY');
});

test('pre-gate: the same report again is unchanged with the same receipt; a held project, a grade over the floor and force_prosecution open a normal ticket', (t) => {
  const s = withReport(t);
  gradeClosed(s.ws);
  stubHeld(t, s.pid, false);
  const first = T.createTicket(s.ws, { project_id: s.pid });
  const again = T.createTicket(s.ws, { project_id: s.pid });
  assert.equal(again.status, 'unchanged');
  assert.equal(again.receipt_id, first.receipt_id);
  assert.equal(T.createTicket(s.ws, { project_id: s.pid, refresh: true }).receipt_id, first.receipt_id, 'refresh alone does not run a Prosecutor');
  assert.equal(fs.readdirSync(s.ws.abs(`projects/${s.pid}/tickets/receipts`)).filter((f) => /^tr_.*\.json$/.test(f) && !f.includes('packet')).length, 1);
  const forced = T.createTicket(s.ws, { project_id: s.pid, force_prosecution: true });
  assert.equal(forced.status, 'created', 'force_prosecution opens the normal ticket');
  assert.ok(forced.ticket.prompt.sha256);
  // Held: a normal ticket although the grade is under the floor.
  const h = withReport(t);
  gradeClosed(h.ws);
  stubHeld(t, h.pid, true);
  assert.equal(T.createTicket(h.ws, { project_id: h.pid }).status, 'created');
  // A grade over the floor: a normal ticket.
  const g = withReport(t);
  gradeClosed(g.ws, { min_grade_new_entry: 1, min_grade_any: 0 });
  stubHeld(t, g.pid, false);
  assert.equal(T.createTicket(g.ws, { project_id: g.pid }).status, 'created');
  // An unreadable portfolio is not "not held": a normal ticket.
  const u = withReport(t);
  gradeClosed(u.ws);
  const portfolio = require('../core/portfolio');
  const realPf = portfolio.computePortfolio;
  portfolio.computePortfolio = () => { throw new Error('unreadable'); };
  t.after(() => { portfolio.computePortfolio = realPf; });
  assert.equal(T.createTicket(u.ws, { project_id: u.pid }).status, 'created');
});

test('pre-gate: nextStep goes gate_closed, then pm_review; the view, summary and invalidation read the desk receipt', (t) => {
  const s = withReport(t);
  gradeClosed(s.ws);
  stubHeld(t, s.pid, false);
  T.setPilot(s.ws, s.pid, true);
  const step = T.pilotQueue(s.ws)[0];
  assert.equal(step.step, 'gate_closed');
  assert.match(step.reasons[0], /for a new entry/);
  const out = T.createTicket(s.ws, { project_id: s.pid });
  const after = T.pilotQueue(s.ws)[0];
  assert.equal(after.step, 'pm_review');
  assert.equal(after.receipt_id, out.receipt_id);
  const v = T.view(s.ws, s.pid);
  assert.equal(v.ticket.desk_gate, true);
  assert.equal(v.ticket.status, 'pending_pm_review');
  assert.equal(v.ticket.prosecution, null);
  assert.equal(v.ticket.agent_disagreement, null);
  assert.equal(v.ticket.invalidation.invalidated, false);
  assert.match(v.ticket.invalidation.words, /the desk's gate, not a Prosecutor/);
  assert.equal(v.ticket.researcher.report_id, out.receipt.researcher.report_id);
  assert.equal(T.summary(s.ws, s.pid).desk_gate, true);
  assert.equal(v.history.length, 1);
});

test('pre-gate: pass and watch and undo are accepted on the desk\'s receipt; approve, halve and trim are refused; pass archives and undo restores', (t) => {
  const s = withReport(t);
  gradeClosed(s.ws);
  stubHeld(t, s.pid, false);
  const projects = require('../core/projects');
  const rid = T.createTicket(s.ws, { project_id: s.pid }).receipt_id;
  for (const action of ['approve', 'halve', 'trim']) assert.throws(() => T.decide(s.ws, s.pid, { receipt_id: rid, action }), (e) => e.code === 'REFUSED' && /desk's gate/.test(e.message), action);
  const pass = T.decide(s.ws, s.pid, { receipt_id: rid, action: 'pass' });
  assert.equal(pass.result.project_archived, true);
  assert.equal(projects.getProject(s.ws, s.pid).status, 'archived');
  assert.equal(T.view(s.ws, s.pid).ticket.status, 'passed');
  const undo = T.decide(s.ws, s.pid, { receipt_id: rid, action: 'undo' });
  assert.equal(undo.result.project_restored, true);
  assert.equal(projects.getProject(s.ws, s.pid).status, 'active');
  T.decide(s.ws, s.pid, { receipt_id: rid, action: 'watch' });
  assert.equal(T.view(s.ws, s.pid).ticket.status, 'watching');
});

test('pre-gate: an existing Prosecutor receipt reads as before, and the index row builds with the desk receipt', (t) => {
  const s = withReport(t);
  stubHeld(t, s.pid, false);
  const tk = T.createTicket(s.ws, { project_id: s.pid, assistant: true }).ticket;
  const saved = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: answer(tk) });
  const v = T.view(s.ws, s.pid);
  assert.equal(v.ticket.desk_gate, false);
  assert.equal(v.ticket.kind, 'prosecutor');
  assert.equal(v.ticket.prosecution.verdict, 'thesis_damaged');
  assert.equal(v.ticket.agent_disagreement.prosecutor.conviction_score, 38);
  assert.equal(T.receiptText(s.ws, s.pid, saved.receipt_id).verified, true);
  // A later desk receipt (the grade floor now closes it) is read beside it.
  gradeClosed(s.ws);
  T.createTicket(s.ws, { project_id: s.pid, refresh: true });
  assert.equal(T.view(s.ws, s.pid).history.length, 2);
  assert.equal(T.view(s.ws, s.pid).ticket.desk_gate, true);
  const index = require('../core/indexer').buildIndex(s.ws);
  const row = index.projects.find((p) => p.project_id === s.pid);
  assert.equal(row.ticket.desk_gate, true);
  assert.equal(row.ticket.status, 'pending_pm_review');
});

// ---------------------------------------------------------------------------
// get_ticket (connector, read-only) and `tickets view`

test('get_ticket: an invalidated ticket names the trigger and the reading that fired; a named receipt and its text are read; a missing project is NOT_FOUND; nothing is written', async (t) => {
  const s = withReport(t);
  stubHeld(t, s.pid, false);
  const tk = riskTicket(s, 1.5);
  const saved = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: answer(T.loadTicket(s.ws, s.pid, tk.ticket_id)) });
  const t0 = Date.parse(saved.receipt.saved_at);
  const dir = s.ws.abs('market-data/observations');
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date(t0).toISOString();
  fs.appendFileSync(path.join(dir, `${at.slice(0, 7)}.jsonl`), `${JSON.stringify({ fetched_at: at, provider: 'coingecko', assets: [{ id: 'example-payfi-fictional', price_usd: 0.69, source_last_updated_at: at, fetched_at: at }] })}\n`);

  const { makeMcp, TOOLS } = require('../mcp');
  const def = TOOLS.find((x) => x.name === 'get_ticket');
  assert.ok(def && def.annotations.readOnlyHint === true);
  const handle = makeMcp(s.ws);
  const callAs = async (assistant, name, args) => {
    let body = '';
    const req = require('stream').Readable.from([Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }))]);
    req.method = 'POST';
    const res = { writeHead() {}, end(b) { body = b || ''; } };
    await handle(req, res, { assistant });
    return JSON.parse(body).result;
  };
  const tree = hashTree(s.root);
  for (const who of ['claude', 'chatgpt']) {
    const out = await callAs(who, 'get_ticket', { project_id: s.pid });
    assert.equal(out.isError, false, who);
    const v = out.structuredContent;
    assert.equal(v.ticket.status, 'invalidated');
    assert.equal(v.ticket.latest, true);
    assert.equal(v.ticket.invalidation.by, 'price');
    assert.match(v.ticket.invalidation.words, /0\.69/);
    assert.equal(v.ticket.invalidation.fired.lowest_usd, 0.69, 'the reading that fired');
    assert.ok(v.ticket.invalidation.checks.length >= 2, 'every check is listed');
    assert.equal(v.history[0].receipt_id, saved.receipt_id);
    assert.ok(Array.isArray(v.ticket.exits_missing));
    assert.equal(v.text, undefined, 'no text unless asked');
  }
  const withText = (await callAs('claude', 'get_ticket', { project_id: s.pid, receipt_id: saved.receipt_id, include_text: true })).structuredContent;
  assert.equal(withText.text.verified, true);
  assert.equal(sha256(withText.text.text), withText.text.sha256);
  assert.equal((await callAs('claude', 'get_ticket', { project_id: s.pid, receipt_id: 'tr_2020-01-01T000000Z_aaaaa' })).isError, true, 'an unknown receipt is NOT_FOUND');
  assert.equal((await callAs('claude', 'get_ticket', { project_id: 'no-such-project' })).isError, true);
  assert.throws(() => T.read(s.ws, 'no-such-project'), (e) => e.code === 'NOT_FOUND');
  assert.throws(() => T.read(s.ws, s.pid, { receiptId: 'tr_2020-01-01T000000Z_aaaaa' }), (e) => e.code === 'NOT_FOUND');
  assert.throws(() => T.read(s.ws, s.pid, { receiptId: 'nonsense' }), (e) => e.code === 'BAD_ID');
  assert.deepEqual(hashTree(s.root), tree, 'get_ticket writes nothing');

  // The saved text's pin is checked: a changed text is an INTEGRITY refusal.
  const textFile = s.ws.abs(`projects/${s.pid}/tickets/receipts/${saved.receipt_id}.md`);
  fs.appendFileSync(textFile, 'tampered');
  assert.throws(() => T.read(s.ws, s.pid, { includeText: true }), (e) => e.code === 'INTEGRITY');
  assert.equal(T.read(s.ws, s.pid).ticket.status, 'invalidated', 'without the text, the ticket still reads');
});

test('get_ticket: a project with no ticket says so; an earlier receipt reads as not the latest; a desk gate has no text', async (t) => {
  const s = withReport(t);
  assert.equal(T.read(s.ws, s.pid).ticket, null);
  stubHeld(t, s.pid, false);
  const tk = T.createTicket(s.ws, { project_id: s.pid, assistant: true }).ticket;
  const first = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: answer(tk) });
  gradeClosed(s.ws);
  const gated = T.createTicket(s.ws, { project_id: s.pid, refresh: true });
  assert.equal(gated.status, 'gate_closed');
  assert.equal(T.read(s.ws, s.pid, { receiptId: first.receipt_id }).ticket.latest, false);
  const g = T.read(s.ws, s.pid, { includeText: true });
  assert.equal(g.ticket.receipt_id, gated.receipt_id);
  assert.equal(g.text.text, null);
  assert.match(g.text.note, /no Prosecutor ran/);
});

// ---------------------------------------------------------------------------
// No born-invalidated tickets (item 22)

function stubPrice(t, id, price) {
  const market = require('../core/market');
  const real = market.readLatest.real || market.readLatest;
  const stub = (...a) => { const m = real(...a); return { ...m, assets: { ...(m.assets || {}), [id]: { price_usd: price, source_last_updated_at: '2026-10-24T10:00:00.000Z' } } }; };
  stub.real = real;
  market.readLatest = stub;
  t.after(() => { market.readLatest = real; });
}
const withTrigger = (tk, trig, type = 'ACCUMULATE') => { const base = JSON.parse(answer(tk).match(/```json\n([\s\S]*)\n```/)[1]); return answer(tk, { proposal: { ...base.proposal, proposal_type: type, invalidation_trigger: { ...base.proposal.invalidation_trigger, metric: null, ...trig } } }); };
const openTicket = (t, s) => { stubHeld(t, s.pid, false); return riskTicket(s, 1.5); };
const CG = 'example-payfi-fictional';

test('a price trigger at or above the price now is refused and writes nothing; one below is saved', (t) => {
  const s = withReport(t);
  const tk = openTicket(t, s);
  stubPrice(t, CG, 0.65);
  const before = hashTree(s.root);
  assert.throws(() => T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: withTrigger(tk, { price_usd: 0.7 }) }), (e) => e.code === 'INVALID' && /at or above the price now \(\$0\.65/.test(e.message) && /Set a threshold below the current price/.test(e.message));
  assert.throws(() => T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: withTrigger(tk, { price_usd: 0.65 }) }), (e) => e.code === 'INVALID', 'equal is at or above');
  assert.deepEqual(hashTree(s.root), before, 'a refusal writes nothing');
  const ok = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: withTrigger(tk, { price_usd: 0.5 }) });
  assert.equal(ok.status, 'saved');
  assert.equal(ok.receipt.desk.trigger_breached_at_save, undefined);
});

test('a metric floor above the packet\'s complete 30-day total is refused, naming the total', (t) => {
  const s = withReport(t);
  const f = require('../core/fundamentals');
  const real = f.summary;
  f.summary = () => ({ state: 'ok', fetched_at: '2026-10-20T00:00:00.000Z', metrics: { fees: { status: 'complete', total_30d_usd: 50000 } } });
  t.after(() => { f.summary = real; });
  const tk = openTicket(t, s);
  const block = (floor) => answer(tk, { proposal: { ...JSON.parse(answer(tk).match(/```json\n([\s\S]*)\n```/)[1]).proposal, invalidation_trigger: { price_usd: 0.5, metric: { key: 'fees', below_30d_usd: floor }, statement: 'x' } } });
  assert.throws(() => T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: block(100000) }), (e) => e.code === 'INVALID' && /50000/.test(e.message) && /2026-10-20/.test(e.message));
  assert.equal(T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: block(40000) }).status, 'saved');
});

test('HARD_PASS and TRIM_EXIT with a breached trigger are saved and labeled', (t) => {
  for (const type of ['HARD_PASS', 'TRIM_EXIT']) {
    const s = withReport(t);
    const tk = openTicket(t, s);
    stubPrice(t, CG, 0.65);
    const out = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: withTrigger(tk, { price_usd: 0.7 }, type) });
    assert.equal(out.status, 'saved', type);
    assert.equal(out.receipt.desk.trigger_breached_at_save.kind, 'price');
    assert.match(out.receipt.desk.trigger_breached_at_save.words, /0\.65/);
  }
});

test('with no price on file the check is skipped, never refused', (t) => {
  const s = withReport(t);
  const tk = openTicket(t, s);
  const market = require('../core/market');
  const real = market.readLatest.real || market.readLatest;
  market.readLatest = (...a) => ({ ...real(...a), assets: {} });
  t.after(() => { market.readLatest = real; });
  assert.equal(tk.basis.market.price_usd ?? null, null, 'the fixture packet holds no price');
  assert.equal(T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: withTrigger(tk, { price_usd: 0.7 }) }).status, 'saved');
});

// ---------------------------------------------------------------------------
// Re-open after invalidation or a rules upgrade (item 23)

function savedTicket(t, s) {
  stubHeld(t, s.pid, false);
  const tk = riskTicket(s, 1.5);
  return T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: answer(T.loadTicket(s.ws, s.pid, tk.ticket_id)) });
}
function dropPrice(ws, at0, price) {
  const dir = ws.abs('market-data/observations');
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date(at0).toISOString();
  fs.appendFileSync(path.join(dir, `${at.slice(0, 7)}.jsonl`), `${JSON.stringify({ fetched_at: at, provider: 'coingecko', assets: [{ id: 'example-payfi-fictional', price_usd: price, source_last_updated_at: at, fetched_at: at }] })}\n`);
}

test('reopen: refused on a pending ticket and by tickets start --reopen; allowed on an invalidated one, which gets a new ticket and keeps the old receipt; undo restores done', (t) => {
  const s = withReport(t);
  const saved = savedTicket(t, s);
  assert.equal(T.view(s.ws, s.pid).ticket.can_reopen, null);
  assert.throws(() => T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'reopen' }), (e) => e.code === 'REFUSED' && /invalidated|older rules/.test(e.message));
  assert.throws(() => T.createTicket(s.ws, { project_id: s.pid, reopen: true }), (e) => e.code === 'REFUSED');
  assert.equal(T.nextStep(s.ws, s.pid).step, 'pm_review');
  dropPrice(s.ws, Date.parse(saved.receipt.saved_at), 0.69);
  const v = T.view(s.ws, s.pid);
  assert.equal(v.ticket.status, 'invalidated');
  assert.equal(v.ticket.can_reopen.kind, 'invalidated');
  const done = T.nextStep(s.ws, s.pid);
  assert.equal(done.step, 'done');
  assert.match(done.why, /Invalidated: Re-open ticket on the card \(or tickets start --reopen\)/);
  const dec = T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'reopen' });
  assert.equal(dec.result.status, 'saved');
  assert.equal(dec.result.journal.status, 'saved');
  assert.equal(T.view(s.ws, s.pid).ticket.status, 'reopened');
  const next = T.nextStep(s.ws, s.pid);
  assert.equal(next.step, 'ticket');
  assert.equal(next.refresh, true);
  const again = T.createTicket(s.ws, { project_id: s.pid, assistant: true, reopen: true });
  assert.equal(again.status, 'created');
  assert.notEqual(again.ticket_id, saved.ticket_id);
  const kept = T.listReceipts(s.ws, s.pid).filter((r) => !r.broken);
  assert.equal(kept.length, 1, 'the old receipt is kept');
  assert.equal(kept[0].receipt_id, saved.receipt_id);
  // Undo of the reopen puts the ticket back to invalidated.
  T.cancelTicket(s.ws, s.pid, again.ticket_id, 'test');
  T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'undo' });
  assert.equal(T.view(s.ws, s.pid).ticket.status, 'invalidated');
  assert.equal(T.nextStep(s.ws, s.pid).step, 'done');
});

test('reopen: a ticket sized under @1 while @2 is in force can be re-opened; nothing re-opens by itself', (t) => {
  const s = withReport(t);
  const saved = savedTicket(t, s);
  const rel = `projects/${s.pid}/tickets/receipts/${saved.receipt_id}.json`;
  const file = fs.existsSync(s.ws.abs(rel)) ? rel : null;
  assert.ok(file, 'receipt file found');
  const r = readJson(s.ws.abs(file));
  assert.equal(r.versions.sizing, T.SIZING_VERSION);
  assert.equal(T.nextStep(s.ws, s.pid).step, 'pm_review', 'nothing re-opens automatically');
  r.versions.sizing = 'cr-ticket-sizing@1';
  atomicWrite(s.ws.abs(file), jsonText(r));
  assert.equal(T.view(s.ws, s.pid).ticket.can_reopen.kind, 'rules_upgrade');
  assert.equal(T.nextStep(s.ws, s.pid).step, 'pm_review');
  assert.equal(T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'reopen' }).result.status, 'saved');
  assert.equal(T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'reopen' }).result.status, 'unchanged');
  assert.equal(T.nextStep(s.ws, s.pid).refresh, true);
});

// ---------------------------------------------------------------------------
// Rollback-safe records (item 13): a receipt from a newer rules version
test('a receipt made under a newer sizing or invalidation version (@9) is shown as saved, not re-read; the view, summary, next step and index do not throw', (t) => {
  const s = withReport(t);
  const saved = savedTicket(t, s);
  const rel = `projects/${s.pid}/tickets/receipts/${saved.receipt_id}.json`;
  const before = T.view(s.ws, s.pid).ticket;
  const r = readJson(s.ws.abs(rel));
  r.versions.sizing = 'cr-ticket-sizing@9';
  r.desk.invalidation_version = 'cr-ticket-invalidation@9';
  atomicWrite(s.ws.abs(rel), jsonText(r));
  // Even a price far under the trigger is not read against the newer rule.
  dropPrice(s.ws, Date.parse(saved.receipt.saved_at), 0.1);
  const v = T.view(s.ws, s.pid).ticket;
  assert.match(v.rule_note, /newer rule \(cr-ticket-sizing@9, cr-ticket-invalidation@9\): shown as saved, not re-read/);
  assert.equal(v.invalidation.unread, true);
  assert.deepEqual(v.invalidation.checks, []);
  assert.notEqual(v.status, 'invalidated');
  assert.equal(v.can_reopen, null, 'a newer rule is not an upgrade');
  assert.equal(v.suggested_risk_usd, before.suggested_risk_usd, 'the saved figures are as they are');
  assert.equal(v.proposal_type, before.proposal_type);
  assert.throws(() => T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'reopen' }), (e) => e.code === 'REFUSED');
  assert.doesNotThrow(() => T.nextStep(s.ws, s.pid));
  const sum = T.summary(s.ws, s.pid);
  assert.equal(sum.unavailable, undefined);
  assert.match(sum.rule_note, /newer rule/);
  const row = require('../core/indexer').buildIndex(s.ws).projects.find((p) => p.project_id === s.pid);
  assert.match(row.ticket.rule_note, /newer rule/);
  // An older or current version carries no note.
  r.versions.sizing = 'cr-ticket-sizing@1';
  delete r.desk.invalidation_version;
  atomicWrite(s.ws.abs(rel), jsonText(r));
  assert.equal(T.view(s.ws, s.pid).ticket.rule_note, null);
});

test('a desk-gate receipt from a newer pre-gate version is shown as saved', (t) => {
  const s = withReport(t);
  stubHeld(t, s.pid, false);
  gradeClosed(s.ws);
  const made = T.createTicket(s.ws, { project_id: s.pid, assistant: true });
  const rel = `projects/${s.pid}/tickets/receipts/${made.receipt.receipt_id}.json`;
  const r = readJson(s.ws.abs(rel));
  r.pregate_version = 'cr-ticket-pregate@9';
  atomicWrite(s.ws.abs(rel), jsonText(r));
  const v = T.view(s.ws, s.pid).ticket;
  assert.equal(v.desk_gate, true);
  assert.match(v.rule_note, /cr-ticket-pregate@9/);
  assert.doesNotThrow(() => require('../core/indexer').buildIndex(s.ws));
});

// ---------------------------------------------------------------------------
// The paper book, cr-paper@1 (item 18)

function bothPrices(ws, atMs, price, btc) {
  const dir = ws.abs('market-data/observations');
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date(atMs).toISOString();
  fs.appendFileSync(path.join(dir, `${at.slice(0, 7)}.jsonl`), `${JSON.stringify({ fetched_at: at, provider: 'coingecko', assets: [{ id: 'example-payfi-fictional', price_usd: price, source_last_updated_at: at, fetched_at: at }, { id: 'bitcoin', price_usd: btc, source_last_updated_at: at, fetched_at: at }] })}\n`);
}
const HOURMS = 3600000;

test('paper: a granting decision opens a position at the hourly price at or before it; it closes at the first reading at or below the invalidation price; return against BTC; entry cost unknown; the portfolio is untouched', (t) => {
  const P = require('../core/paper');
  const s = withReport(t);
  const saved = savedTicket(t, s);
  const now0 = Date.now();
  bothPrices(s.ws, now0 - 2 * HOURMS, 1.0, 100);
  bothPrices(s.ws, now0 + 1 * HOURMS, 0.95, 105);
  bothPrices(s.ws, now0 + 2 * HOURMS, 0.69, 110);
  bothPrices(s.ws, now0 + 3 * HOURMS, 0.5, 110);
  const dec = T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'approve' });
  assert.equal(dec.result.paper.status, 'saved');
  assert.equal(T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'approve' }).result.status, 'unchanged');
  assert.equal(P.readRecords(s.ws).length, 1);
  const before = hashTree(s.root);
  const b = P.book(s.ws, { now: now0 + 5 * HOURMS });
  assert.deepEqual(hashTree(s.root), before, 'reading the book writes nothing');
  assert.equal(b.positions.length, 1);
  const p = b.positions[0];
  assert.equal(p.risk_usd, 500);
  assert.equal(p.entry.status, 'priced');
  assert.equal(p.entry.price_usd, 1.0, 'the reading before the decision, never a later one');
  assert.deepEqual(p.entry_cost, { status: 'unknown', usd: null, note: 'Fees and slippage are unknown; not taken as 0.' });
  assert.equal(p.state, 'closed');
  assert.equal(p.close.kind, 'invalidated');
  assert.equal(p.close.price_usd, 0.69, 'that reading, not the lower one after it');
  assert.equal(p.return.status, 'realized');
  assert.equal(p.return.return_pct, -31);
  assert.equal(p.return.btc_return_pct, 10);
  assert.equal(p.return.vs_btc_pct, -37.27);
  assert.equal(p.return.pnl_usd, -155);
  assert.match(b.summary.note, /Too few to judge: 1 of 20/);
  assert.equal(b.summary.median_vs_btc_pct, undefined, 'no median before 20 have closed');
  assert.equal(require('../core/portfolio').loadTransactions(s.ws).length, 0, 'no ledger entry');
  assert.equal(P.REL, 'paper/positions.jsonl');
  // Open, before the invalidation reading exists.
  const early = P.book(s.ws, { now: now0 + 90 * 60000 });
  assert.equal(early.positions[0].state, 'open');
  assert.equal(early.positions[0].return.status, 'unrealized');
});

test('paper (item 55): MFE and MAE are the best and worst hourly price against the entry up to the close; unknown, never 0, without a priced entry or readings', async (t) => {
  const P = require('../core/paper');
  const s = withReport(t);
  const saved = savedTicket(t, s);
  const now0 = Date.now();
  bothPrices(s.ws, now0 - 2 * HOURMS, 1.0, 100);
  bothPrices(s.ws, now0 + 0.5 * HOURMS, 1.2, 101);
  bothPrices(s.ws, now0 + 1 * HOURMS, 0.95, 105);
  bothPrices(s.ws, now0 + 2 * HOURMS, 0.69, 110);
  bothPrices(s.ws, now0 + 3 * HOURMS, 0.3, 110);
  T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'approve' });
  const before = hashTree(s.root);
  const closed = P.book(s.ws, { now: now0 + 5 * HOURMS }).positions[0];
  assert.deepEqual(hashTree(s.root), before, 'reading writes nothing');
  assert.equal(closed.state, 'closed');
  assert.equal(closed.max_favorable_pct, 20);
  assert.equal(closed.max_adverse_pct, -31, 'the close reading, not the lower one after it');
  assert.equal(closed.excursion.status, 'known');
  assert.equal(closed.excursion.readings, 4);
  const open = P.book(s.ws, { now: now0 + 90 * 60000 }).positions[0];
  assert.equal(open.state, 'open');
  assert.equal(open.max_favorable_pct, 20);
  assert.equal(open.max_adverse_pct, -5, 'the 0.95 reading at +1 h, before the later ones exist');
  // A close long ago still reads from the same span.
  const far = P.book(s.ws, { now: now0 + 400 * HOURMS }).positions[0];
  assert.equal(far.state, 'closed');
  assert.equal(far.max_adverse_pct, -31);
  // The model words it.
  const M = await import('../public/paper-model.js');
  assert.equal(M.excursionWords(closed, 'mfe').text, '+20.00%');
  assert.equal(M.excursionWords(closed, 'mae').text, '−31.00%');
  assert.equal(M.excursionWords({ excursion: { status: 'unknown', why: 'No entry price' } }, 'mfe').text, '—');
  assert.equal(M.excursionWords(null, 'mae').text, '—');
});

test('paper (item 55): without a priced entry the excursion is unknown with the reason', (t) => {
  const P = require('../core/paper');
  const s = withReport(t);
  const saved = savedTicket(t, s);
  T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'approve' });
  const p = P.book(s.ws, { now: Date.now() + HOURMS }).positions[0];
  if (p.entry.status !== 'priced') {
    assert.equal(p.max_favorable_pct, null);
    assert.equal(p.max_adverse_pct, null);
    assert.equal(p.excursion.status, 'unknown');
    assert.match(p.excursion.why, /No entry price/);
  } else {
    assert.ok(['known', 'unknown'].includes(p.excursion.status));
  }
});

test('paper: no hourly price at or before the decision is "no entry price", never a later one; undo voids the position and keeps it on record', (t) => {
  const P = require('../core/paper');
  const s = withReport(t);
  const saved = savedTicket(t, s);
  const now0 = Date.now();
  bothPrices(s.ws, now0 - 8 * HOURMS, 1.0, 100); // outside 6 h
  bothPrices(s.ws, now0 + 1 * HOURMS, 0.9, 100); // after the decision
  T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'halve' });
  let p = P.book(s.ws, { now: now0 + 2 * HOURMS }).positions[0];
  assert.equal(p.risk_usd, 250);
  assert.equal(p.entry.status, 'no_entry_price');
  assert.equal(p.return.status, 'unknown');
  assert.match(p.return.why, /No entry price/);
  T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'undo' });
  const lines = P.readRecords(s.ws);
  assert.deepEqual(lines.map((l) => l.event), ['open', 'void']);
  assert.match(lines[1].reason, /undone/);
  const b = P.book(s.ws, { now: now0 + 2 * HOURMS });
  p = b.positions[0];
  assert.equal(p.state, 'voided');
  assert.equal(b.counts.voided, 1);
  assert.equal(b.counts.positions, 0);
});

test('paper: a trim acknowledged by the PM, or the end of the horizon, closes it; the earliest close wins; a $0 ticket is a shadow line, not a position', (t) => {
  const P = require('../core/paper');
  const s = withReport(t);
  const saved = savedTicket(t, s);
  const now0 = Date.now();
  bothPrices(s.ws, now0 - HOURMS, 1.0, 100);
  bothPrices(s.ws, now0 + 4 * HOURMS, 1.2, 100);
  T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'approve' });
  const file = s.ws.abs(P.REL);
  const open = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  // Horizon ends 12 hours after the decision (fictional end date written into the record).
  open.horizon_end = new Date(now0 + 12 * HOURMS).toISOString();
  fs.writeFileSync(file, `${JSON.stringify(open)}\n`);
  let p = P.book(s.ws, { now: now0 + 20 * HOURMS }).positions[0];
  assert.equal(p.close.kind, 'horizon_end');
  assert.equal(p.close.price_usd, null, 'no reading within 6 hours before the horizon end: the exit price is unknown');
  assert.equal(p.return.status, 'unknown');
  // A trim before the horizon wins.
  const decFile = s.ws.abs(`projects/${s.pid}/tickets/decisions.jsonl`);
  fs.appendFileSync(decFile, `${JSON.stringify({ decision_id: 'td_fictional_trim', receipt_id: 'tr_2099-01-01T000000Z_aaaaa', action: 'trim', decided_at: new Date(now0 + 2 * HOURMS).toISOString() })}\n`);
  bothPrices(s.ws, now0 + 2 * HOURMS - 60000, 1.1, 100);
  p = P.book(s.ws, { now: now0 + 20 * HOURMS }).positions[0];
  assert.equal(p.close.kind, 'trim_acknowledged');
  assert.equal(p.close.price_usd, 1.1);
  assert.equal(p.return.return_pct, 10);
  assert.equal(p.return.btc_return_pct, 0);
});

test('paper: a ticket that grants no risk shows "Shadow: not taken" and opens no position; a decision without risk opens none', (t) => {
  const P = require('../core/paper');
  const s = withReport(t);
  const tk = T.createTicket(s.ws, { project_id: s.pid, assistant: true }).ticket;
  const zero = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: answer(tk) });
  assert.equal(zero.receipt.desk.suggested_risk_usd, 0);
  T.decide(s.ws, s.pid, { receipt_id: zero.receipt_id, action: 'watch' });
  const b = P.book(s.ws);
  assert.equal(b.positions.length, 0);
  assert.equal(b.shadow.length, 1);
  assert.equal(b.shadow[0].line, 'Shadow: not taken');
  assert.equal(b.shadow[0].receipt_id, zero.receipt_id);
  assert.equal(fs.existsSync(s.ws.abs(P.REL)), false, 'nothing was written');
});

test('paper: from twenty closed positions a median and a hit count appear; the book is part of the export and the package', (t) => {
  const P = require('../core/paper');
  const s = withReport(t);
  const base = Date.now() - 40 * 86400000;
  const lines = [];
  for (let i = 0; i < 20; i++) {
    lines.push(JSON.stringify({ schema_version: 'cr.paper.v1', event: 'open', position_id: `pp_f${i}`, project_id: s.pid, receipt_id: 'tr_x', decision_id: `td_f${i}`, decided_at: new Date(base + i * 3600000).toISOString(), risk_usd: 100, invalidation_price_usd: null, horizon_end: new Date(base + 30 * 86400000).toISOString(), entry: { status: 'priced', price_usd: 1, at: new Date(base + i * 3600000).toISOString() }, entry_cost: { status: 'unknown', usd: null } }));
  }
  fs.mkdirSync(s.ws.abs('paper'), { recursive: true });
  fs.writeFileSync(s.ws.abs(P.REL), `${lines.join('\n')}\n`);
  bothPrices(s.ws, base - HOURMS, 1, 100);
  for (let i = 0; i < 40; i++) bothPrices(s.ws, base + i * 6 * HOURMS + 3600000, 1 + i * 0.01, 100);
  bothPrices(s.ws, base + 30 * 86400000 - HOURMS, 1.2, 100);
  const b = P.book(s.ws, { now: Date.now() });
  assert.equal(b.counts.measured_closed, 20);
  assert.equal(b.summary.closed, 20);
  assert.ok(typeof b.summary.median_vs_btc_pct === 'number');
  assert.equal(b.summary.of, 20);
  const ex = require('../core/exporter');
  assert.ok(ex.exportJson(s.ws).paper.positions.length === 20);
});

// ---------------------------------------------------------------------------
// Batch gate (backlog item 24)

test('batch gate: an unheld grade under the filter gets a desk receipt; held, high, no report, archived and unverified are skipped; a second run is all unchanged; dry run writes nothing', (t) => {
  const s = withReport(t);
  gradeClosed(s.ws);
  stubHeld(t, s.pid, false);
  const projects = require('../core/projects');
  const bare = projects.addProject(s.ws, { name: 'Bare Example (FICTIONAL)', symbol: 'BARE', official_website: 'https://bare-fictional.test', coingecko_id: 'bare-example-fictional', assets: [{ chain: 'other-chain', contract_address: 'FICTIONAL-CONTRACT-BARE' }], evidence: [{ url: 'https://bare-fictional.test', note: 'fictional' }], sector_profile: 'payfi-credit@1' }).project_id;
  const tree = hashTree(s.root);
  const dry = T.batchGate(s.ws, { below: 90, dryRun: true });
  assert.deepEqual(hashTree(s.root), tree, 'a dry run writes nothing');
  assert.deepEqual(dry.made.map((r) => r.project_id), [s.pid]);
  assert.equal(dry.made[0].receipt_id, null);
  assert.ok(dry.skipped.some((r) => r.project_id === bare && /No eligible Claude report/.test(r.reason)));
  const run = T.batchGate(s.ws, { below: 90 });
  assert.equal(run.made.length, 1);
  assert.match(run.made[0].receipt_id, T.RECEIPT_RE);
  assert.equal(T.listReceipts(s.ws, s.pid)[0].kind, 'desk_gate');
  assert.equal(T.pendingFor(s.ws).length, 0, 'no Prosecutor job, no model');
  const again = T.batchGate(s.ws, { below: 90 });
  assert.equal(again.made.length, 0);
  assert.deepEqual(again.unchanged.map((r) => r.receipt_id), [run.made[0].receipt_id]);
  // Over the filter: the default 40 leaves the fixture's grade alone.
  const s2 = withReport(t);
  gradeClosed(s2.ws);
  stubHeld(t, s2.pid, false);
  const hi = T.batchGate(s2.ws, {});
  assert.equal(hi.below, 40);
  assert.equal(hi.made.length, 0);
  assert.ok(hi.skipped.some((r) => r.project_id === s2.pid && /not under 40/.test(r.reason)));
  // Held.
  const h = withReport(t);
  gradeClosed(h.ws);
  stubHeld(t, h.pid, true);
  assert.ok(T.batchGate(h.ws, { below: 90 }).skipped.some((r) => r.project_id === h.pid && /Held/.test(r.reason)));
  // Archived.
  const a = withReport(t);
  gradeClosed(a.ws);
  stubHeld(t, a.pid, false);
  require('../core/projects').archiveProject(a.ws, a.pid);
  assert.ok(T.batchGate(a.ws, { below: 90 }).skipped.some((r) => r.project_id === a.pid && /Archived/.test(r.reason)));
  // An open Prosecutor job.
  const o = withReport(t);
  gradeClosed(o.ws);
  stubHeld(t, o.pid, false);
  T.createTicket(o.ws, { project_id: o.pid, force_prosecution: true });
  assert.ok(T.batchGate(o.ws, { below: 90 }).skipped.some((r) => r.project_id === o.pid && /open/.test(r.reason)));
});

test('batch gate: --below may lower Eric\'s filter, never raise it past the new-entry floor', (t) => {
  const s = withReport(t);
  assert.equal(T.batchGate(s.ws, { dryRun: true }).below, 40);
  assert.equal(T.batchGate(s.ws, { below: 20, dryRun: true }).below, 20);
  assert.throws(() => T.batchGate(s.ws, { below: 56, dryRun: true }), (e) => e.code === 'INVALID');
  assert.throws(() => T.batchGate(s.ws, { below: -1, dryRun: true }), (e) => e.code === 'INVALID');
});

// ---------------------------------------------------------------------------
// Auto-pilot sync (backlog item 30)

// Claude's current report as a given prompt version and grade (the stored
// fixture is @1 and 60.5), for the cases the fixtures do not hold.
function stubClaudeReport(t, { version = 'cr-research-prompt@6', grade = { status: 'firm', value: 62, display: '62' } } = {}) {
  const compare = require('../core/compare');
  const rubrics = require('../core/rubrics');
  const realLatest = compare.latestByProvider;
  const realGrade = rubrics.gradeAssessment;
  compare.latestByProvider = (...a) => {
    const l = realLatest(...a);
    return l.claude ? { ...l, claude: { ...l.claude, assessment: { ...l.claude.assessment, prompt_version: version } } } : l;
  };
  rubrics.gradeAssessment = () => grade;
  t.after(() => { compare.latestByProvider = realLatest; rubrics.gradeAssessment = realGrade; });
}

test('auto-pilot sync: a verified @6 project graded 45+ is opted in; 44, a low end under 45, withheld, @5, no report, archived and unverified are skipped with words; a second run is unchanged; dry run writes nothing', (t) => {
  const s = withReport(t);
  stubClaudeReport(t);
  const projects = require('../core/projects');
  const bare = projects.addProject(s.ws, { name: 'Bare Example (FICTIONAL)', symbol: 'BARE', official_website: 'https://bare-fictional.test', coingecko_id: 'bare-example-fictional', assets: [{ chain: 'other-chain', contract_address: 'FICTIONAL-CONTRACT-BARE' }], evidence: [{ url: 'https://bare-fictional.test', note: 'fictional' }], sector_profile: 'payfi-credit@1' }).project_id;
  const tree = hashTree(s.root);
  const dry = T.autoPilotSync(s.ws, { dryRun: true });
  assert.deepEqual(hashTree(s.root), tree, 'a dry run writes nothing');
  assert.deepEqual(dry.opted_in.map((r) => r.project_id), [s.pid]);
  assert.ok(dry.skipped.some((r) => r.project_id === bare && /No eligible Claude report/.test(r.reason)));
  assert.equal(T.pilotQueue(s.ws).length, 0);
  const run = T.autoPilotSync(s.ws);
  assert.deepEqual(run.opted_in.map((r) => r.project_id), [s.pid]);
  assert.equal(T.pilotQueue(s.ws).length, 1);
  const again = T.autoPilotSync(s.ws);
  assert.equal(again.opted_in.length, 0);
  assert.deepEqual(again.unchanged.map((r) => r.project_id), [s.pid]);
  // The floor is the default 45, adjustable.
  assert.equal(T.autoPilotSync(s.ws, { dryRun: true }).min, 45);
  assert.throws(() => T.autoPilotSync(s.ws, { min: 101 }), /--min/);
});

test('auto-pilot sync: below the floor, a range by its low end, withheld, an older prompt and an archived project are skipped', (t) => {
  const check = (stub, setupFn) => {
    const s = withReport(t);
    stubClaudeReport(t, stub);
    if (setupFn) setupFn(s);
    const r = T.autoPilotSync(s.ws);
    assert.equal(r.opted_in.length, 0);
    assert.equal(T.pilotQueue(s.ws).length, 0, 'nothing opted in');
    return r.skipped.find((x) => x.project_id === s.pid);
  };
  assert.match(check({ grade: { status: 'firm', value: 44, display: '44' } }).reason, /Grade 44 is under 45/);
  assert.match(check({ grade: { status: 'range', low: 40, high: 60, display: '40–60' } }).reason, /Grade 40 is under 45/);
  assert.match(check({ grade: { status: 'withheld', display: 'Withheld' } }).reason, /withheld/i);
  assert.match(check({ version: 'cr-research-prompt@5' }).reason, /@5/);
  assert.match(check({}, (s) => require('../core/projects').archiveProject(s.ws, s.pid)).reason, /Archived/);
  // A range whose low end is 45 or more qualifies.
  const q = withReport(t);
  stubClaudeReport(t, { grade: { status: 'range', low: 46, high: 60, display: '46–60' } });
  assert.equal(T.autoPilotSync(q.ws).opted_in.length, 1);
});

test('auto-pilot sync: never opts a project out', (t) => {
  const s = withReport(t);
  stubClaudeReport(t, { version: 'cr-research-prompt@5' });
  T.setPilot(s.ws, s.pid, true);
  const r = T.autoPilotSync(s.ws);
  assert.equal(r.opted_in.length, 0);
  assert.equal(T.pilotQueue(s.ws).length, 1, 'still in the pilot');
});

test('paper: the shadow gate lists a desk gate and a $0 ticket with what the price did since; an unknown price is said, never 0; nothing is written', (t) => {
  const P = require('../core/paper');
  const s = withReport(t);
  gradeClosed(s.ws);
  stubHeld(t, s.pid, false);
  const gate = T.createTicket(s.ws, { project_id: s.pid });
  assert.equal(gate.status, 'gate_closed');
  const savedAt = Date.parse(gate.receipt.saved_at);
  const bare = P.book(s.ws, { now: savedAt + 10 * HOURMS });
  assert.equal(bare.shadow_gate.length, 1);
  assert.equal(bare.shadow_gate[0].kind, 'desk_gate');
  assert.equal(bare.shadow_gate[0].since.status, 'unknown', 'no hourly price: unknown, not 0');
  assert.equal(bare.positions.length, 0);
  bothPrices(s.ws, savedAt - HOURMS, 1.0, 100);
  bothPrices(s.ws, savedAt + 9 * HOURMS, 1.5, 110);
  const tree = hashTree(s.root);
  const b = P.book(s.ws, { now: savedAt + 10 * HOURMS });
  assert.deepEqual(hashTree(s.root), tree, 'reading writes nothing');
  const since = b.shadow_gate[0].since;
  assert.equal(since.status, 'measured');
  assert.equal(since.change_pct, 50);
  assert.equal(since.btc_change_pct, 10);
  assert.equal(since.vs_btc_pct, 36.36);
  assert.equal(b.shadow.length, 0, 'the older shadow list keeps only tickets that proposed');
});

test('paper model: positions split open, closed and voided; the shadow rows say the price since in words; the rose count is a count, not a rate', async () => {
  const M = await import('../public/paper-model.js');
  const book = {
    counts: { open: 1, closed: 1, voided: 1 },
    summary: { closed: 1, note: 'Too few to judge: 1 of 20 closed positions needed for a total, median or hit rate.' },
    positions: [
      { position_id: 'a', state: 'open', decided_at: '2026-10-01T00:00:00Z', return: { status: 'unrealized', return_pct: 5, btc_return_pct: null, btc_note: 'No BTC price on record at one of the two times.' } },
      { position_id: 'b', state: 'closed', decided_at: '2026-10-02T00:00:00Z', return: { status: 'realized', return_pct: -3, btc_return_pct: 1, vs_btc_pct: -3.96 } },
      { position_id: 'c', state: 'voided', decided_at: '2026-10-03T00:00:00Z', return: null },
    ],
    shadow_gate: [
      { project_id: 'p', name: 'P', receipt_id: 'r1', saved_at: '2026-10-05T00:00:00Z', kind: 'desk_gate', line: 'Desk gate: no Prosecutor run', since: { status: 'measured', from_price_usd: 1, from_at: 'x', to_price_usd: 1.5, to_at: 'y', change_pct: 50, btc_change_pct: 10, vs_btc_pct: 36.36 } },
      { project_id: 'q', name: 'Q', receipt_id: 'r2', saved_at: '2026-10-06T00:00:00Z', kind: 'zero_risk', line: 'Shadow: not taken', since: { status: 'unknown', why: 'No hourly price.' } },
    ],
  };
  const parts = M.splitPositions(book);
  assert.deepEqual([parts.open.length, parts.closed.length, parts.voided.length], [1, 1, 1]);
  assert.equal(M.returnWords(parts.open[0]).text, '+5.00%');
  assert.match(M.returnWords(parts.open[0]).title, /No BTC price/);
  assert.equal(M.returnWords(parts.closed[0]).text, '−3.00%');
  assert.equal(M.returnWords(parts.voided[0]).text, '—');
  assert.match(M.summaryLine(book), /1 open · 1 closed · 1 voided · Too few to judge/);
  assert.doesNotMatch(M.summaryLine(book), /median \+|hit rate \d/);
  const rows = M.shadowRows(book);
  assert.deepEqual(rows.map((r) => r.receipt_id), ['r2', 'r1']);
  assert.equal(rows[0].change_text, '—');
  assert.equal(rows[0].title, 'No hourly price.');
  assert.equal(rows[1].change_text, '+50.00%');
  assert.equal(rows[1].vs_btc_text, '+36.36%');
  assert.deepEqual(M.shadowCounts(book), { total: 2, measured: 1, rose: 1, unknown: 1 });
  assert.deepEqual(M.splitPositions(null), { open: [], closed: [], voided: [] });
});

// ---------------------------------------------------------------------------
// Independent review 2026-10-25 (audits/2026-10-25-codex-autonomy-review):
// A03 admission at the commit, A04 a grant against the ticket as it is now,
// A05 the run's horizon in the paper book, A06 one live exposure and replayed
// consequences, A08 sizing from the verified packet.

const decisionLines = (s) => T.readDecisions(s.ws, s.pid);
const blockOf = (text) => JSON.parse(text.match(/```json\n([\s\S]*)\n```/)[1]);

test('A03: a price stored after the text is checked and before the lock is taken is read at the commit; the born-invalidated ticket is refused and nothing is written', (t) => {
  const s = withReport(t);
  const tk = openTicket(t, s);
  const market = require('../core/market');
  const real = market.readLatest;
  // A read outside the save's lock sees $0.85; the commit, under the lock,
  // sees the $0.65 a price update stored in between.
  market.readLatest = (ws, ...a) => { const m = real(ws, ...a); return ws._lockHeld ? { ...m, assets: { ...m.assets, [CG]: { ...m.assets[CG], price_usd: 0.65 } } } : m; };
  t.after(() => { market.readLatest = real; });
  const before = hashTree(s.root);
  assert.throws(() => T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: withTrigger(tk, { price_usd: 0.7 }) }), (e) => e.code === 'INVALID' && /price now \(\$0\.65/.test(e.message));
  assert.deepEqual(hashTree(s.root), before, 'a refusal at the commit writes nothing');
  assert.equal(T.listReceipts(s.ws, s.pid).length, 0);
  market.readLatest = real;
  const ok = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: withTrigger(tk, { price_usd: 0.7 }) });
  assert.equal(ok.receipt.desk.suggested_risk_usd, 500, 'a valid, fresh case is admitted');
  assert.equal(ok.receipt.desk.admission.version, T.ADMISSION_VERSION);
  assert.equal(ok.receipt.desk.admission.price.status, 'clear');
  assert.equal(ok.receipt.desk.admission.price.price_usd, 0.85);
  assert.match(ok.receipt.desk.admission.limit, /not proof the market did not move/);
});

test('A03: no stored price, a stale price or an unusable trigger is unchecked and holds a risk-taking ticket to $0, said as a cap; the receipt is kept', (t) => {
  const cases = [
    ['no price', (s) => fs.rmSync(s.ws.abs('market-data/latest.json')), {}, /No stored price/],
    ['stale price', (s) => freshPrice(s.ws, CG, 0.85, 3 * HOURMS), {}, /past your 90-minute freshness limit/],
    ['malformed trigger', () => {}, { price_usd: 'nonsense' }, /No usable invalidation price/],
    ['no trigger', () => {}, { price_usd: null }, /No usable invalidation price/],
  ];
  for (const [label, prep, trig, re] of cases) {
    const s = withReport(t);
    const tk = openTicket(t, s);
    prep(s);
    const out = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: withTrigger(tk, trig) });
    assert.equal(out.status, 'saved', label);
    const d = out.receipt.desk;
    assert.equal(d.suggested_risk_usd, 0, `${label}: unknown is never a pass`);
    assert.equal(d.proposal_type, 'WATCH_ONLY', label);
    assert.equal(d.gate.capped.from, 'ACCUMULATE', label);
    assert.match(d.gate.capped.reason, re, label);
    assert.equal(d.admission.price.status, 'unchecked', label);
    assert.deepEqual(d.admission.held_risk && d.admission.held_risk.risk_usd, 500, label);
    assert.throws(() => T.decide(s.ws, s.pid, { receipt_id: out.receipt_id, action: 'approve' }), (e) => e.code === 'REFUSED', `${label}: nothing to approve`);
  }
});

test('A03: the metric floor is checked against the complete 30-day total on file at the commit, not only the frozen packet\'s', (t) => {
  const s = withReport(t);
  const f = require('../core/fundamentals');
  const real = f.summary;
  let total = 200000;
  f.summary = () => ({ state: 'ok', fetched_at: '2026-10-25T00:00:00.000Z', metrics: { fees: { status: 'complete', total_30d_usd: total } } });
  t.after(() => { f.summary = real; });
  const tk = openTicket(t, s);
  total = 50000;
  const text = answer(tk, { proposal: { ...blockOf(answer(tk)).proposal, invalidation_trigger: { price_usd: 0.5, metric: { key: 'fees', below_30d_usd: 100000 }, statement: 'x' } } });
  assert.throws(() => T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text }), (e) => e.code === 'INVALID' && /50000/.test(e.message));
});

test('A08: the desk sizes from the verified packet: an exit, holding or grade changed only in the job record is an INTEGRITY refusal with nothing written', (t) => {
  for (const [field, mutate] of [
    ['exits', (job) => { job.basis.exits = [{ size_usd: 500, status: 'current', cost_pct: 1, cost_complete: true, missing_costs: [] }, { size_usd: 2000, status: 'current', cost_pct: 2, cost_complete: true }]; }],
    ['held', (job) => { job.basis.held = true; }],
    ['researcher.grade', (job) => { job.basis.researcher.grade = { status: 'firm', value: 99, display: '99' }; }],
  ]) {
    const s = withReport(t);
    stubHeld(t, s.pid, false);
    const tk = T.createTicket(s.ws, { project_id: s.pid, assistant: true }).ticket;
    freshPrice(s.ws, CG, 0.85);
    const frozen = JSON.parse(fs.readFileSync(s.ws.abs(tk.packet.path), 'utf8'));
    assert.equal(frozen.exits[0].cost_pct, null, 'the packet holds no exit reading');
    const rel = `projects/${s.pid}/tickets/${tk.ticket_id}/ticket.json`;
    const job = readJson(s.ws.abs(rel));
    mutate(job);
    atomicWrite(s.ws.abs(rel), jsonText(job));
    const before = hashTree(s.root);
    assert.throws(() => T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: answer(T.loadTicket(s.ws, s.pid, tk.ticket_id)) }), (e) => e.code === 'INTEGRITY' && e.details.fields.includes(field), field);
    assert.deepEqual(hashTree(s.root), before, `${field}: nothing written`);
  }
  // The same reading frozen into the packet the real way is sized.
  const s = withReport(t);
  stubHeld(t, s.pid, false);
  const tk = riskTicket(s, 1);
  const frozen = JSON.parse(fs.readFileSync(s.ws.abs(tk.packet.path), 'utf8'));
  assert.equal(frozen.exits[0].cost_pct, 1);
  const out = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: answer(tk) });
  assert.equal(out.receipt.desk.suggested_risk_usd, 500);
  assert.equal(out.receipt.desk.exit_cost_500_usd_pct, 1);
  assert.equal(out.receipt.desk.exit_cost_500_as_of, frozen.exits[0].as_of, 'the cost keeps its time');
});

test('A04: an approval is refused once the ticket is invalidated (409 INVALIDATED, nothing written, no paper position); a veto is still recorded', (t) => {
  const P = require('../core/paper');
  const s = withReport(t);
  const saved = savedTicket(t, s);
  assert.equal(saved.receipt.desk.suggested_risk_usd, 500);
  dropPrice(s.ws, Date.parse(saved.receipt.saved_at), 0.69);
  assert.equal(T.view(s.ws, s.pid).ticket.status, 'invalidated');
  for (const action of ['approve', 'halve']) {
    assert.throws(() => T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action, request_id: `req_a04_${action}` }), (e) => e.code === 'INVALIDATED' && /0\.69/.test(e.message) && e.details.changed[0].kind === 'invalidated', action);
  }
  assert.equal(decisionLines(s).length, 0);
  assert.equal(P.readRecords(s.ws).length, 0, 'no paper position');
  // A veto takes no risk: it is recorded although the card still showed the
  // ticket pending.
  assert.equal(T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'veto', seen: { status: 'pending_pm_review', suggested_risk_usd: 500, superseded_by_report: null } }).result.status, 'saved');
});

test('A04: a grant on a ticket whose report is superseded is refused, naming the newer report; the card\'s seen state must match the ticket now', (t) => {
  const s = withReport(t);
  const saved = savedTicket(t, s);
  const compare = require('../core/compare');
  const real = compare.latestByProvider;
  compare.latestByProvider = (...a) => { const l = real(...a); return { ...l, claude: { ...l.claude, report_id: 'r-newer-fictional' } }; };
  t.after(() => { compare.latestByProvider = real; });
  assert.throws(() => T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'approve' }), (e) => e.code === 'BASIS_CHANGED' && /superseded by r-newer-fictional/.test(e.message));
  compare.latestByProvider = real;
  // The card's seen state: a different status or suggested risk is CHANGED.
  assert.throws(() => T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'approve', seen: { status: 'pending_pm_review', suggested_risk_usd: 250, superseded_by_report: null } }), (e) => e.code === 'CHANGED' && /Suggested risk: you saw 250, it is now 500/.test(e.message));
  assert.equal(decisionLines(s).length, 0);
  const seen = { status: 'pending_pm_review', suggested_risk_usd: 500, superseded_by_report: null };
  const ok = T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'approve', request_id: 'req_a04_seen01', seen });
  assert.equal(ok.result.status, 'saved');
  assert.equal(T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'approve', request_id: 'req_a04_seen01', seen }).result.status, 'unchanged', 'its replay still works');
});

test('A04: the server answers a refused grant with 409 and the named change', async (t) => {
  const s = withReport(t);
  const saved = savedTicket(t, s);
  dropPrice(s.ws, Date.parse(saved.receipt.saved_at), 0.69);
  const { start } = require('../server');
  const http = require('http');
  const srv = await start(s.ws, { port: 49800 + Math.floor(Math.random() * 90), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } });
  const call =(method, p, token, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, method, path: p, headers: { host: `127.0.0.1:${srv.port}`, ...(token ? { 'x-cr-token': token } : {}), ...(body ? { 'content-type': 'application/json', origin: `http://127.0.0.1:${srv.port}` } : {}) } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b || 'null') })); });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
  const token = (await call('GET', '/api/session')).json.token;
  const r = await call('POST', `/api/projects/${s.pid}/tickets/decisions`, token, { receipt_id: saved.receipt_id, action: 'approve', request_id: 'req_a04_http01', seen: { status: 'pending_pm_review', suggested_risk_usd: 500, superseded_by_report: null } });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'INVALIDATED');
  assert.equal(r.json.saved, false);
  assert.equal(r.json.changed[0].kind, 'invalidated');
});

test('A05: a report made under a research run carries the run and its horizon from the ticket to the paper position, which closes at the horizon end with nothing edited', (t) => {
  const { buildBriefWorkspace, IDS } = require('./brief-fixtures');
  const P = require('../core/paper');
  const fx = buildBriefWorkspace('a05-horizon');
  t.after(fx.cleanup);
  const ws = fx.ws;
  const pid = fx.pids.complete;
  const run = require('../core/research').loadRun(ws, pid, fx.runs.complete);
  ws.settings.tickets = { sizing: { min_grade_new_entry: 1, min_grade_any: 0 } };
  stubHeld(t, pid, false);
  const tk = withExitReadings(1, () => T.createTicket(ws, { project_id: pid, assistant: true })).ticket;
  assert.equal(tk.basis.researcher.run_id, run.run_id, 'the report names its run');
  freshPrice(ws, `${IDS.complete}-cg`, 1.2);
  const saved = T.saveTicket(ws, { project_id: pid, ticket_id: tk.ticket_id, text: answer(tk) });
  assert.equal(saved.receipt.desk.suggested_risk_usd, 500);
  assert.equal(saved.receipt.researcher.run_id, run.run_id, 'the receipt keeps the run');
  assert.equal(saved.receipt.researcher.horizon.end_date, run.horizon.end_date);
  T.decide(ws, pid, { receipt_id: saved.receipt_id, action: 'approve' });
  const [open] = P.readRecords(ws);
  assert.equal(open.horizon_end, `${run.horizon.end_date}T00:00:00.000Z`);
  assert.equal(open.horizon_source, 'receipt');
  const paperFile = fs.readFileSync(ws.abs(P.REL), 'utf8');
  const end = Date.parse(open.horizon_end);
  const before = P.book(ws, { now: end - 86400000 }).positions[0];
  assert.equal(before.state, 'open');
  const after = P.book(ws, { now: end + 86400000 }).positions[0];
  assert.equal(after.state, 'closed');
  assert.equal(after.close.kind, 'horizon_end');
  assert.equal(fs.readFileSync(ws.abs(P.REL), 'utf8'), paperFile, 'the paper file was not edited');
  // A position opened before receipts carried the run reads its horizon from
  // the ticket's frozen packet, labeled, and writes nothing.
  const rRel = `projects/${pid}/tickets/receipts/${saved.receipt_id}.json`;
  const r = readJson(ws.abs(rRel));
  delete r.researcher.run_id;
  delete r.researcher.horizon;
  atomicWrite(ws.abs(rRel), jsonText(r));
  fs.writeFileSync(ws.abs(P.REL), `${JSON.stringify({ ...open, horizon_end: null, horizon_source: null })}\n`);
  const tree = hashTree(fx.root);
  const old = P.book(ws, { now: end + 86400000 }).positions[0];
  assert.deepEqual(hashTree(fx.root), tree, 'reading writes nothing');
  assert.equal(old.horizon_end, open.horizon_end);
  assert.match(old.horizon_source, /packet_run, read for this position \(cr-paper-horizon@1\)/);
  assert.equal(old.close.kind, 'horizon_end');
});

test('A05: a position whose receipt names no run says its horizon is missing, never a default length', (t) => {
  const P = require('../core/paper');
  const s = withReport(t);
  const saved = savedTicket(t, s);
  assert.equal(saved.receipt.researcher.run_id, null, 'the fixture report names no run');
  assert.equal(saved.receipt.researcher.horizon, null);
  T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'approve' });
  const [open] = P.readRecords(s.ws);
  assert.equal(open.horizon_end, null);
  assert.match(open.horizon_note, /no horizon/);
  const p = P.book(s.ws, { now: Date.now() + 400 * 86400000 }).positions[0];
  assert.equal(p.state, 'open');
  assert.match(p.horizon_missing, /no horizon/);
});

test('A06: a grant in force is undone before another grant or a veto replaces it; Approve then Halve leaves one live position', (t) => {
  const P = require('../core/paper');
  const s = withReport(t);
  const saved = savedTicket(t, s);
  T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'approve', request_id: 'req_a06_appr01' });
  for (const action of ['halve', 'veto']) assert.throws(() => T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action, request_id: `req_a06_${action}01` }), (e) => e.code === 'CONFLICT' && /Undo it first/.test(e.message), action);
  assert.equal(P.book(s.ws).counts.positions, 1);
  T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'undo', request_id: 'req_a06_undo01' });
  T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'halve', request_id: 'req_a06_halv02' });
  const b = P.book(s.ws);
  assert.equal(b.counts.positions, 1, 'one live exposure');
  assert.equal(b.counts.voided, 1, 'the approve\'s position is kept, voided');
  assert.equal(b.positions.find((x) => x.state !== 'voided').risk_usd, 250);
  assert.equal(T.view(s.ws, s.pid).ticket.pm_approved_risk_usd, 250);
  assert.equal(require('../core/portfolio').loadTransactions(s.ws).length, 0, 'the portfolio is untouched');
});

test('A06: a paper or archive step that failed after the decision is completed by replaying the same request, once; nothing is duplicated', (t) => {
  const P = require('../core/paper');
  const notes = require('../core/notes');
  const s = withReport(t);
  const saved = savedTicket(t, s);
  const realOpen = P.openForDecision;
  P.openForDecision = () => { throw new Error('disk full (FICTIONAL)'); };
  const first = T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'approve', request_id: 'req_a06_paper01' });
  P.openForDecision = realOpen;
  assert.equal(first.result.status, 'saved');
  assert.equal(first.result.paper.status, 'failed');
  assert.equal(T.view(s.ws, s.pid).ticket.decision.paper, 'missing', 'the missing position is said');
  const again = T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'approve', request_id: 'req_a06_paper01' });
  assert.equal(again.result.status, 'unchanged');
  assert.equal(again.result.paper.status, 'saved');
  T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'approve', request_id: 'req_a06_paper01' });
  T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'approve', request_id: 'req_a06_paper02' });
  assert.equal(P.readRecords(s.ws).filter((l) => l.event === 'open').length, 1, 'one position');
  assert.equal(T.view(s.ws, s.pid).ticket.decision.paper, 'open');
  assert.equal(notes.loadJournal(s.ws, s.pid).filter((e) => e.type === 'decision').length, 1, 'one journal entry');
  assert.equal(decisionLines(s).length, 1, 'one decision');
  assert.deepEqual(decisionLines(s)[0].effects, { archive: null, paper: 'open', journal: 'entry' }, 'the consequences are stated with the decision');
  // An undone grant is never re-opened by replaying its request.
  T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'undo', request_id: 'req_a06_undo02' });
  T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'approve', request_id: 'req_a06_paper01' });
  assert.equal(P.book(s.ws).counts.positions, 0);

  // A $0 ticket's pass whose archive failed is archived on replay.
  const z = withReport(t);
  const tk = T.createTicket(z.ws, { project_id: z.pid, assistant: true }).ticket;
  const zero = T.saveTicket(z.ws, { project_id: z.pid, ticket_id: tk.ticket_id, text: answer(tk) });
  const projects = require('../core/projects');
  const realArchive = projects.archiveProject;
  projects.archiveProject = () => { throw new Error('busy (FICTIONAL)'); };
  const pass = T.decide(z.ws, z.pid, { receipt_id: zero.receipt_id, action: 'pass', request_id: 'req_a06_pass01' });
  projects.archiveProject = realArchive;
  assert.equal(pass.result.archive.status, 'failed');
  assert.equal(projects.getProject(z.ws, z.pid).status, 'active');
  const replay = T.decide(z.ws, z.pid, { receipt_id: zero.receipt_id, action: 'pass', request_id: 'req_a06_pass01' });
  assert.equal(replay.result.project_archived, true);
  assert.equal(projects.getProject(z.ws, z.pid).status, 'archived');
  assert.equal(notes.loadJournal(z.ws, z.pid).filter((e) => e.type === 'decision').length, 1);
});

// ---------------------------------------------------------------------------
// tickets reconcile (backlog item 36, review A06)

test('reconcile: a grant whose paper and journal steps failed is completed once; the second run is all unchanged; the decision line is untouched', (t) => {
  const P = require('../core/paper');
  const notes = require('../core/notes');
  const s = withReport(t);
  const saved = savedTicket(t, s);
  const origOpen = P.openForDecision;
  const origJ = notes.addJournal;
  P.openForDecision = () => { throw new Error('disk full'); };
  notes.addJournal = () => { throw new Error('disk full'); };
  let dec;
  try { dec = T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'approve' }); } finally { P.openForDecision = origOpen; notes.addJournal = origJ; }
  assert.equal(dec.result.paper.status, 'failed');
  assert.equal(P.readRecords(s.ws).length, 0);
  const decFile = s.ws.abs(`projects/${s.pid}/tickets/decisions.jsonl`);
  const decBefore = fs.readFileSync(decFile, 'utf8');
  const dry = T.reconcileEffects(s.ws, { dryRun: true });
  assert.deepEqual(dry.completed.map((c) => c.step).sort(), ['journal', 'paper']);
  assert.equal(P.readRecords(s.ws).length, 0, 'a dry run writes nothing');
  assert.equal(notes.loadJournal(s.ws, s.pid).filter((e) => e.type === 'decision').length, 0);
  const r1 = T.reconcileEffects(s.ws, { project: s.pid });
  assert.deepEqual(r1.completed.map((c) => `${c.step}:${c.status}`).sort(), ['journal:saved', 'paper:saved']);
  assert.equal(P.readRecords(s.ws).length, 1);
  const j = notes.loadJournal(s.ws, s.pid).filter((e) => e.type === 'decision');
  assert.equal(j.length, 1);
  assert.match(j[0].text, new RegExp(dec.result.decision.decided_at));
  const r2 = T.reconcileEffects(s.ws);
  assert.equal(r2.completed.length, 0);
  assert.equal(r2.already_complete.length, 2);
  assert.equal(P.readRecords(s.ws).length, 1);
  assert.equal(fs.readFileSync(decFile, 'utf8'), decBefore, 'decisions.jsonl never changes');
});

test('reconcile: an undone grant gets no paper position; a failed archive is named and left', (t) => {
  const P = require('../core/paper');
  const projects = require('../core/projects');
  const s = withReport(t);
  const saved = savedTicket(t, s);
  T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'approve' });
  T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'undo' });
  const r = T.reconcileEffects(s.ws);
  assert.equal(r.completed.length, 0);
  assert.ok(!r.completed.some((c) => c.step === 'paper'));
  // A pass whose archive step failed.
  const s2 = withReport(t);
  const tk = T.createTicket(s2.ws, { project_id: s2.pid, assistant: true }).ticket;
  const zero = T.saveTicket(s2.ws, { project_id: s2.pid, ticket_id: tk.ticket_id, text: answer(T.loadTicket(s2.ws, s2.pid, tk.ticket_id)) });
  const orig = projects.archiveProject;
  projects.archiveProject = () => { throw new Error('locked'); };
  try { T.decide(s2.ws, s2.pid, { receipt_id: zero.receipt_id, action: 'pass' }); } finally { projects.archiveProject = orig; }
  const r2 = T.reconcileEffects(s2.ws);
  assert.equal(r2.named.length, 1);
  assert.equal(r2.named[0].step, 'archive');
  assert.notEqual(projects.getProject(s2.ws, s2.pid).status, 'archived', 'reconcile never archives');
});

// ---------------------------------------------------------------------------
// Older receipts sized from a job record: integrity-limited (backlog item 37)

test('integrity: a normal receipt reads ok; a receipt whose figures differ from its frozen packet reads limited and cannot be approved or halved, but can be vetoed; a missing packet reads unverified; reading writes nothing', (t) => {
  const s = withReport(t);
  const saved = savedTicket(t, s);
  assert.equal(T.view(s.ws, s.pid).ticket.integrity.status, 'ok');
  assert.equal(T.integrityOf(s.ws, saved.receipt).status, 'ok');
  // An older receipt, as if sized from a job record with another exit cost.
  const rel = `projects/${s.pid}/tickets/receipts/${saved.receipt_id}.json`;
  const r = readJson(s.ws.abs(rel), null);
  r.desk.exit_cost_500_usd_pct = 0.5;
  atomicWrite(s.ws.abs(rel), jsonText(r));
  const before = hashTree(s.root);
  const v = T.view(s.ws, s.pid).ticket.integrity;
  assert.equal(v.status, 'limited');
  assert.deepEqual(v.fields.map((f) => f.field), ['exit_cost_500_usd_pct']);
  assert.match(v.words, /cannot be approved or halved/);
  assert.deepEqual(hashTree(s.root), before, 'reading writes nothing');
  for (const action of ['approve', 'halve']) assert.throws(() => T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action }), (e) => e.code === 'INTEGRITY' && /exit_cost_500_usd_pct/.test(e.message), action);
  assert.equal(T.decide(s.ws, s.pid, { receipt_id: saved.receipt_id, action: 'veto' }).result.status, 'saved');
  // A packet that cannot be verified.
  fs.appendFileSync(s.ws.abs(r.packet.path), ' ');
  const u = T.view(s.ws, s.pid).ticket.integrity;
  assert.equal(u.status, 'unverified');
  assert.match(u.words, /veto, pass or watch/);
});

test('invalidation@2: a triggered price check under the coverage rule is "sampled" and says so; full coverage is not; the status stays triggered (backlog item 38)', (t) => {
  const c = coverageSetup(t);
  c.obs(0.9, c.t0 + 1 * H);
  c.obs(0.69, c.t0 + 20 * H);
  const thin = c.price(c.t0 + 24 * H);
  assert.equal(thin.status, 'triggered');
  assert.equal(thin.sampled, true);
  assert.equal(thin.source, 'hourly observation');
  assert.match(thin.words, /A sampled reading: 2 of 24 hours had one; this one is from /);
  assert.match(thin.words, /hourly observation/);
  const v = T.view(c.ws, c.pid, { now: c.t0 + 24 * H });
  assert.equal(v.ticket.status, 'invalidated', 'the published rule decides');
  assert.equal(v.ticket.invalidation.sampled, true);
  assert.match(v.ticket.invalidation.words, /sampled reading/);
  const f = coverageSetup(t);
  for (let h = 0; h < 4; h++) f.obs(h === 3 ? 0.69 : 0.9, f.t0 + (h + 0.5) * H);
  const full = f.price(f.t0 + 4.5 * H);
  assert.equal(full.status, 'triggered');
  assert.equal(full.sampled, false);
  assert.equal(full.source, 'hourly observation');
  assert.doesNotMatch(full.words, /sampled/);
  assert.match(full.words, /\(hourly observation\)/);
});

test('invalidation@2: a breach read from latest.json names it', (t) => {
  const c = coverageSetup(t);
  freshPrice(c.ws, 'example-payfi-fictional', 0.69, 0);
  const p = c.price(Date.now() + 60000);
  assert.equal(p.status, 'triggered');
  assert.equal(p.source, 'latest.json');
  assert.match(p.words, /\(latest\.json\)/);
});

test('pre-gate reason kind (item 40): an under-floor grade reads grade_low; a withheld grade reads grade_withheld with its scored share and unscored components; an older receipt reads not recorded; the override opens a normal ticket', (t) => {
  const s = withReport(t);
  gradeClosed(s.ws);
  stubHeld(t, s.pid, false);
  const lowStep = T.nextStep(s.ws, s.pid);
  assert.equal(lowStep.reason_kind, 'grade_low');
  assert.match(lowStep.why, /the grade is under the floor/);
  const low = T.createTicket(s.ws, { project_id: s.pid });
  assert.equal(low.receipt.desk.gate.reason_kind, 'grade_low');
  assert.equal(low.receipt.desk.gate.withheld, undefined);
  assert.equal(T.view(s.ws, s.pid).ticket.gate_reason_kind, 'grade_low');

  // An older receipt (no reason_kind recorded) reads null.
  const rel = low.receipt.packet.path.replace(/[^/]+$/, `${low.receipt_id}.json`);
  const old = JSON.parse(fs.readFileSync(s.ws.abs(rel), 'utf8'));
  delete old.desk.gate.reason_kind;
  fs.writeFileSync(s.ws.abs(rel), JSON.stringify(old, null, 2));
  assert.equal(T.view(s.ws, s.pid).ticket.gate_reason_kind, null);

  // A withheld grade from a retrieval gap.
  const w = withReport(t);
  stubHeld(t, w.pid, false);
  const rubrics = require('../core/rubrics');
  const real = rubrics.gradeAssessment;
  rubrics.gradeAssessment = (...a) => {
    const g = real(...a);
    return g ? { ...g, status: 'withheld', value: null, low: null, high: null, display: null, coverage_pct: 80, missing: [{ id: 'liquidity', label: 'Timing and liquidity', status: 'unknown', reason: 'unknown' }] } : g;
  };
  t.after(() => { rubrics.gradeAssessment = real; });
  const whStep = T.nextStep(w.ws, w.pid);
  assert.equal(whStep.reason_kind, 'grade_withheld');
  assert.match(whStep.why, /withheld \(a component was not scored\), not a weak score/);
  const wh = T.createTicket(w.ws, { project_id: w.pid });
  assert.equal(wh.status, 'gate_closed');
  assert.equal(wh.receipt.desk.gate.reason_kind, 'grade_withheld');
  assert.equal(wh.receipt.desk.gate.withheld.scored_pct, 80);
  assert.deepEqual(wh.receipt.desk.gate.withheld.unscored.map((c) => c.id), ['liquidity']);
  const v = T.view(w.ws, w.pid).ticket;
  assert.equal(v.gate_reason_kind, 'grade_withheld');
  assert.equal(v.gate_withheld.unscored[0].label, 'Timing and liquidity');
  // The override (the route's force_prosecution) opens a normal ticket.
  const forced = T.createTicket(w.ws, { project_id: w.pid, force_prosecution: true });
  assert.equal(forced.status, 'created');
});

test('shadow gate day 30 (item 41): a fixed 30-day result that does not follow the latest price; immature and unevaluable read so; an archived project is listed; cohort counts; nothing is written', async (t) => {
  const P = require('../core/paper');
  const DAY = 24 * HOURMS;
  const s = withReport(t);
  gradeClosed(s.ws);
  stubHeld(t, s.pid, false);
  const gate = T.createTicket(s.ws, { project_id: s.pid });
  const at = Date.parse(gate.receipt.saved_at);
  // Before day 30 and no start price: unevaluable, never 0.
  assert.equal(P.book(s.ws, { now: at + 10 * HOURMS }).shadow_gate[0].day30.status, 'unevaluable');
  bothPrices(s.ws, at - HOURMS, 1.0, 100);
  const young = P.book(s.ws, { now: at + 10 * DAY }).shadow_gate[0];
  assert.equal(young.day30.status, 'immature');
  assert.equal(young.day30.change_pct, undefined);
  // The probe: +100% at day 30, +200% at day 35.
  bothPrices(s.ws, at + 30 * DAY - HOURMS, 2.0, 110);
  bothPrices(s.ws, at + 35 * DAY, 3.0, 120);
  const tree = hashTree(s.root);
  const b = P.book(s.ws, { now: at + 35 * DAY });
  assert.deepEqual(hashTree(s.root), tree, 'reading writes nothing');
  const row = b.shadow_gate[0];
  assert.equal(row.since.change_pct, 200);
  assert.equal(row.day30.status, 'matured');
  assert.equal(row.day30.change_pct, 100);
  assert.equal(row.day30.btc_change_pct, 10);
  assert.equal(row.day30.vs_btc_pct, 81.82);
  // Once matured it never changes, however the price moves later.
  bothPrices(s.ws, at + 60 * DAY, 9.0, 300);
  assert.deepEqual(P.book(s.ws, { now: at + 60 * DAY }).shadow_gate[0].day30, row.day30);
  // One hour after day 30 it is matured at the reading within 24 h before it.
  assert.equal(P.book(s.ws, { now: at + 30 * DAY + HOURMS }).shadow_gate[0].day30.status, 'matured');
  // Cohorts: counts per receipt month, no rate.
  const month = gate.receipt.saved_at.slice(0, 7);
  assert.deepEqual(b.shadow_cohorts, [{ month, matured: 1, immature: 0, unevaluable: 0, total: 1 }]);
  assert.equal(b.shadow_min_matured, 20);
  // An archived project's receipt is still listed.
  require('../core/projects').archiveProject(s.ws, s.pid);
  assert.equal(P.book(s.ws, { now: at + 35 * DAY }).shadow_gate.length, 1);
  // The model words.
  const M = await import('../public/paper-model.js');
  const rows = M.shadowRows(b);
  assert.equal(rows[0].day30_text, '+100.00%');
  assert.equal(rows[0].day30_vs_btc_text, '+81.82%');
  assert.deepEqual(M.shadowCohortLines(b), [`${month}: 1 matured · 0 immature · 0 unevaluable`]);
  assert.equal(M.shadowRows({ shadow_gate: [{ saved_at: 'x', day30: { status: 'immature', why: 'w' } }] })[0].day30_text, 'Not yet');
});

// ---------------------------------------------------------------------------
// Trade Plan geometry (item 49, cr-ticket-geometry@1)

test('trade plan geometry: position, distances and reward:risk are arithmetic on the receipt and a fresh stored price, and missing numbers stay unknown', () => {
  const NOW = Date.parse('2026-10-25T12:00:00Z');
  const fresh = (price) => ({ price_usd: price, as_of: '2026-10-25T11:30:00Z' });
  const plan = { entry_zone: { low_usd: 0.9, high_usd: 1.1 }, upside_target: { price_usd: 2 }, invalidation_trigger: { price_usd: 0.8 } };
  const g = T.tradePlanGeometry(plan, fresh(1), { now: NOW });
  assert.equal(g.version, 'cr-ticket-geometry@1');
  assert.equal(g.position, 'in_zone');
  assert.equal(g.to_upside_pct, 100);
  assert.equal(g.to_stop_pct, -20);
  assert.equal(g.reward_risk_ratio, 5, '(2 - 1) / (1 - 0.8)');
  assert.equal(T.tradePlanGeometry(plan, fresh(1.21), { now: NOW }).position, 'above_zone');
  assert.equal(T.tradePlanGeometry(plan, fresh(1.21), { now: NOW }).position_pct, 10);
  const below = T.tradePlanGeometry(plan, fresh(0.85), { now: NOW });
  assert.equal(below.position, 'below_zone');
  assert.equal(below.position_pct, 5.88);
  // No ratio when the price is outside the stop-to-target span.
  assert.equal(T.tradePlanGeometry(plan, fresh(2.5), { now: NOW }).reward_risk_ratio, null);
  assert.equal(T.tradePlanGeometry(plan, fresh(0.7), { now: NOW }).reward_risk_ratio, null);
  // A stale, unknown-aged or missing price is not used.
  const stale = T.tradePlanGeometry(plan, { price_usd: 1, as_of: '2026-10-25T08:00:00Z' }, { now: NOW });
  assert.equal(stale.price.status, 'stale');
  assert.equal(stale.position, 'unknown');
  assert.equal(stale.reward_risk_ratio, null);
  assert.equal(T.tradePlanGeometry(plan, { price_usd: 1 }, { now: NOW }).price.status, 'unknown');
  const none = T.tradePlanGeometry(plan, { price_usd: null, note: 'No stored price' }, { now: NOW });
  assert.equal(none.price.status, 'unknown');
  assert.match(none.words, /unknown/);
  // Missing plan numbers are never invented.
  const partial = T.tradePlanGeometry({ entry_zone: null, upside_target: null, invalidation_trigger: { price_usd: 0.8 } }, fresh(1), { now: NOW });
  assert.equal(partial.position, 'unknown');
  assert.equal(partial.to_upside_pct, null);
  assert.equal(partial.to_stop_pct, -20);
  assert.equal(partial.reward_risk_ratio, null);
  assert.match(partial.words, /reward:risk unknown/);
});

test('trade plan geometry: view() carries it on a saved Prosecutor ticket, unknown without a fresh price', (t) => {
  const s = withReport(t);
  const tk = T.createTicket(s.ws, { project_id: s.pid, assistant: true }).ticket;
  T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: answer(tk) });
  const g = T.view(s.ws, s.pid).ticket.trade_plan_geometry;
  assert.equal(g.version, 'cr-ticket-geometry@1');
  assert.ok(['unknown', 'stale', 'fresh'].includes(g.price.status));
  if (g.price.status !== 'fresh') {
    assert.equal(g.position, 'unknown');
    assert.equal(g.reward_risk_ratio, null);
    assert.match(g.words, /unknown/);
  }
});

test('view() carries the four tests and the strongest bull rebuttal for the card (item 52)', (t) => {
  const s = withReport(t);
  const tk = T.createTicket(s.ws, { project_id: s.pid, assistant: true }).ticket;
  T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: answer(tk) });
  const pr = T.view(s.ws, s.pid).ticket.prosecution;
  assert.equal(pr.strongest_bull_rebuttal, 'Emissions taper next quarter.');
  for (const k of ['mercenary_emissions', 'tax_revenue', 'exit_slippage', 'unverified_claims']) assert.ok(['pass', 'fail', 'unknown'].includes(pr.tests[k].result), k);
});

test('near invalidation (item 53): within 10% above the stop only, never on a stale or missing price, an invalidated or vetoed ticket', () => {
  const geo = (price, status = 'fresh', stop = 0.7) => ({ price: { status, price_usd: price }, stop_usd: stop });
  const n = T.nearInvalidation('pending_pm_review', geo(0.75));
  assert.equal(n.distance_pct, 7.14);
  assert.equal(n.threshold_usd, 0.7);
  assert.equal(n.price_usd, 0.75);
  assert.match(n.words, /7\.14% above/);
  assert.equal(T.nearInvalidation('pending_pm_review', geo(0.77)).distance_pct, 10);
  assert.equal(T.nearInvalidation('pending_pm_review', geo(0.78)), null);
  assert.equal(T.nearInvalidation('pending_pm_review', geo(0.75, 'stale')), null);
  assert.equal(T.nearInvalidation('pending_pm_review', geo(0.69)), null, 'at or below the stop is the invalidation rule, not this one');
  assert.equal(T.nearInvalidation('pending_pm_review', geo(0.75, 'fresh', null)), null);
  assert.equal(T.nearInvalidation('invalidated', geo(0.75)), null);
  assert.equal(T.nearInvalidation('vetoed', geo(0.75)), null);
  assert.equal(T.nearInvalidation('risk_granted', null), null);
});

test('near invalidation (item 53): view() attaches it from a fresh stored price', (t) => {
  const s = withReport(t);
  const tk = T.createTicket(s.ws, { project_id: s.pid, assistant: true }).ticket;
  T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: answer(tk) });
  const v = T.view(s.ws, s.pid).ticket;
  const g = v.trade_plan_geometry;
  assert.deepEqual(v.near_invalidation, T.nearInvalidation(v.status, g));
});

test('candidate board (item 54): rows carry step, delta and the $500 and $2,000 readings; a read writes nothing', (t) => {
  const s = withReport(t);
  const tree = hashTree(s.root);
  const rows = T.candidateBoard(s.ws);
  assert.deepEqual(hashTree(s.root), tree, 'reading writes nothing');
  const row = rows.find((r) => r.project_id === s.pid);
  assert.ok(row);
  assert.deepEqual(row.exits.map((e) => e.size_usd), [500, 2000]);
  for (const e of row.exits) assert.ok(e.ready === true || e.ready === false || e.ready === null);
  assert.ok(['research', 'ticket', 'gate_closed', 'pm_review', 'done', 'blocked', 'unknown'].includes(row.step), row.step);
  assert.ok('report_delta' in row && 'in_pilot' in row);
  assert.deepEqual(rows.map((r) => r.project_id), T.pilotCandidates(s.ws).map((r) => r.project_id), 'the same order as the candidates');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /route\('GET', '\/api\/tickets\/candidates'/);
  assert.doesNotMatch(server.match(/route\('GET', '\/api\/tickets\/candidates'.*/)[0], /setPilot|\.post\(|writeJson/);
});

test('candidate board (item 54): the model words step, exits and the @5 to @6 change', async (t) => {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pilot-board-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(path.join(__dirname, '..', 'public', 'pilot-board-model.js'), path.join(dir, 'm.mjs'));
  const m = await import(require('url').pathToFileURL(path.join(dir, 'm.mjs')).href);
  assert.equal(m.stepWord('gate_closed'), 'Gate closed');
  assert.equal(m.stepWord('pm_review'), 'PM review');
  assert.equal(m.exitCell({ size_usd: 2000, ready: true, cost_pct: 1.2, cost_complete: true }).text, '$2,000 ready');
  assert.equal(m.exitCell({ size_usd: 500, ready: false, cost_pct: null, note: 'none' }).text, '$500 missing');
  assert.equal(m.exitCell({ size_usd: 500, ready: null }).text, '$500 native');
  assert.equal(m.deltaText({ status: 'ok', grade_delta: 4.2, prompt_versions: { previous: 'cr-research-prompt@5', new: 'cr-research-prompt@6' } }).text, '+4.2 @5 → @6');
  assert.equal(m.deltaText({ status: 'none', line: 'No earlier eligible Claude report to compare.' }).text, '—');
  assert.equal(m.deltaText(null).text, '—');
});

// ---------------------------------------------------------------------------
// run-cycle (backlog item 51)

test('run-cycle: auto-pilot-sync, batch-gate, quotes and the queue in one receipt with next steps for Agent 1 and Agent 2; a dry run writes nothing; a second run opts in nobody', async (t) => {
  const s = withReport(t);
  stubClaudeReport(t);
  stubHeld(t, s.pid, false);
  await assert.rejects(() => T.runCycle(s.ws, { limit: 0 }), (e) => e.code === 'INVALID');
  const tree = hashTree(s.root);
  const dry = await T.runCycle(s.ws, { dryRun: true });
  assert.deepEqual(hashTree(s.root), tree, 'a dry run writes nothing');
  assert.equal(dry.format, 'cr-run-cycle@1');
  assert.equal(dry.dry_run, true);
  assert.equal(dry.counts.opted_in, 1, 'would opt in the qualifying project');
  assert.deepEqual(dry.errors, []);
  assert.equal(dry.steps.pilot_queue.steps, 0, 'nothing is in the pilot yet in a dry run');

  const run = await T.runCycle(s.ws, { limit: 5 });
  assert.equal(run.limit, 5);
  assert.deepEqual(run.errors, []);
  assert.deepEqual(run.steps.auto_pilot_sync.opted_in.map((r) => r.project_id), [s.pid]);
  assert.equal(run.counts.gates_made, 0, 'a grade over the filter of 40 is not batch-gated');
  assert.equal(run.counts.quoted, 0, 'no chain is approved, so no quote is asked for');
  assert.equal(run.steps.pilot_queue.steps, 1);
  assert.equal(run.counts.agent1_research + run.counts.agent2_ticket + run.counts.waiting_for_eric + (run.counts.queue.gate_closed || 0) + (run.counts.queue.done || 0), 1);
  const next = [...run.next.agent1_research, ...run.next.agent2_ticket, ...run.next.for_eric];
  for (const n of next) assert.equal(n.project_id, s.pid);
  assert.equal(T.pendingFor(s.ws).length, 0, 'no Prosecutor job is made by the cycle');

  const again = await T.runCycle(s.ws);
  assert.equal(again.counts.opted_in, 0);
  assert.equal(again.steps.auto_pilot_sync.unchanged, 1);
});

test('run-cycle: the CLI answers the same receipt, and --limit must be a whole number', async (t) => {
  const s = withReport(t);
  stubClaudeReport(t);
  stubHeld(t, s.pid, false);
  const cli = require('../cli');
  const r = await cli.run(['tickets', 'run-cycle', '--dry-run', '--limit', '3', '--workspace', s.ws.root]);
  assert.equal(r.format, 'cr-run-cycle@1');
  assert.equal(r.limit, 3);
  assert.equal(r.dry_run, true);
  await assert.rejects(() => cli.run(['tickets', 'run-cycle', '--limit', 'x', '--workspace', s.ws.root]), /whole number/);
});

test('item 57: a holding metric floor carries its headroom over the floor, one decimal; a triggered one carries none', (t) => {
  const s = withReport(t);
  const f = require('../core/fundamentals');
  const real = f.summary;
  f.summary = () => ({ state: 'ok', fetched_at: '2026-10-25T00:00:00.000Z', metrics: { fees: { status: 'complete', total_30d_usd: 200000 } } });
  t.after(() => { f.summary = real; });
  const tk = openTicket(t, s);
  const text = answer(tk, { proposal: { ...blockOf(answer(tk)).proposal, invalidation_trigger: { price_usd: 0.5, metric: { key: 'fees', below_30d_usd: 100000 }, statement: 'x' } } });
  T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text });
  const at = (total) => ({ state: 'ok', fetched_at: new Date(Date.now() + 3600000).toISOString(), metrics: { fees: { status: 'complete', total_30d_usd: total } } });
  const holding = T.view(s.ws, s.pid, { fundamentals: at(123456) }).ticket.invalidation.checks.find((c) => c.kind === 'metric');
  assert.equal(holding.status, 'holding');
  assert.equal(holding.headroom_pct, 23.5);
  const hit = T.view(s.ws, s.pid, { fundamentals: at(90000) }).ticket.invalidation.checks.find((c) => c.kind === 'metric');
  assert.equal(hit.status, 'triggered');
  assert.equal(hit.headroom_pct, undefined);
});
