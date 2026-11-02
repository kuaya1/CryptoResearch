'use strict';
// Input blindness through the desk's real paths (audit F8, 2026-11-02;
// blueprint 2026-11-02 §7, Constitution Q4). grade-input-blindness.test.js
// scans the files research and prosecution freeze, but on a desk whose grader
// is stubbed, so its rubric line proved nothing about the real rubric. Here no
// function under proof is replaced: the rubric (rubrics.gradeAssessment), the
// paper mandate's sweep (tickets.mandateSweep, with the grade the real rubric
// gave the receipt), the Claude API request the research runner sends
// (research.runDueJobs through providers.js, with only the network answered),
// the connector's handoffs (get_research, pending_tickets) and the
// Prosecutor's prompt as the pilot worker takes it (tickets.promptFor).
// Automatic admission's real path is proved in lead-admission.test.js, beside
// its own fixture.
//
// Each proof has a control that shows it can fail: the read spy catches an
// outcome read, the differential desks change their answer when the grade's
// own input changes, and the canary check catches a canary.
//
// The one seam stood in is tickets.mandateContractEvidence (R4's live
// contract read through the chain node), as in mandate.test.js: it reads the
// contract, never a grade, an outcome or another model.
//
// Not exercised here, and so not proved by this file:
// - the ChatGPT and Gemini API requests (providers.submitBackground): they
//   send the same frozen run prompt, plus ChatGPT's frozen execution note;
// - the ChatGPT ticket challenge (ticket-challenges.js renderPrompt), whose
//   target freezes the ticket receipt and its text by design;
// - the forensic investigator and challenge prompts (forensics.js), outside
//   research and prosecution;
// - the scout's and the leads' Grok prompts (grok-cron.js, frozen templates
//   with web search), upstream of any project;
// - copying a prompt from the dashboard or the CLI, and the Cowork request
//   queue (inbox/requests), which hand the same frozen files over;
// - what a model meets on the open web, which no code path can prove.
// FICTIONAL temporary workspaces only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const T = require('../core/tickets');
const TD = require('../core/trader-desk');
const research = require('../core/research');
const rubrics = require('../core/rubrics');
const { loadReports } = require('../core/reports');
const { withExitReadings, freshPrice, cancelOpenJobs } = require('./helpers');
const { mandateDesk, saveTicket, CONSISTENT } = require('./mandate-fixture');
const { H, iso, settle, bar, answer } = require('./trader-fixture');

const NOTE = 'CANARY-DECISION-NOTE-5b1e';
const OTHER_MODEL = 'CANARY-OTHER-MODEL-0d7c';
const OUTCOME_NOTE = 'CANARY-OUTCOME-NOTE-e8a2';
const ADDR = '0x00000000000000000000000000000000000a11ce';
const KEY = 'sk-ant-FICTIONAL-0000000000000000';

// --- Instruments ---------------------------------------------------------

// Every path the fs module is asked to read while fn runs, relative to the
// workspace (the spy passes each call through unchanged).
function readsDuring(root, fn) {
  const seen = [];
  const names = ['readFileSync', 'openSync', 'readdirSync', 'statSync', 'existsSync'];
  const orig = Object.fromEntries(names.map((n) => [n, fs[n]]));
  for (const n of names) fs[n] = function spy(p, ...a) { seen.push(p); return orig[n].call(fs, p, ...a); };
  let out;
  try { out = fn(); } finally { for (const n of names) fs[n] = orig[n]; }
  const rels = seen.filter((p) => typeof p === 'string' || p instanceof URL || Buffer.isBuffer(p)).map((p) => path.relative(root, String(p)).split(path.sep).join('/'));
  return { out, reads: rels };
}
// Where outcomes, decisions, books and opinions live in a workspace.
const OUTCOME_SOURCE = /^(paper|portfolio)\/|^projects\/[^/]+\/(tickets|forensics|reports|research|journal)/;

function canaryCheck(canaries) {
  const clean = (what, text) => { for (const c of canaries) assert.ok(!String(text).includes(c), `${what} carries ${c}`); };
  for (const c of canaries) assert.throws(() => clean('control', `x ${c} y`), 'the check catches a canary');
  return clean;
}

// --- Desks ---------------------------------------------------------------

const reportOf = (ws, pid, provider) => loadReports(ws, pid).find((r) => !r.broken && r.meta.provider === provider);
function editReport(ws, rep, fn) {
  const file = ws.abs(`${rep.dir}/report.json`);
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  fn(rec.assessment);
  fs.writeFileSync(file, JSON.stringify(rec, null, 2));
}
const scoreAll = (value) => (a) => { for (const c of Object.values(a.investment_components || {})) if (c && c.status === 'scored') c.value = value; };

function onBase(ws, pid) {
  const file = ws.abs(`projects/${pid}/project.json`);
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  p.identity.assets = [{ chain: 'base', contract_address: ADDR }];
  fs.writeFileSync(file, JSON.stringify(p, null, 2));
}
function pilotOn(ws, pid) {
  const file = ws.abs(`projects/${pid}/tickets/profile.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema_version: 'cr.ticket-profile.v1', project_id: pid, pilot: true, pilot_set_at: new Date().toISOString(), pilot_set_by: 'eric' }));
}
function contractEvidencePasses(t) {
  const real = T.mandateContractEvidence;
  T.mandateContractEvidence = () => null;
  t.after(() => { T.mandateContractEvidence = real; });
}

// The canaries where outcomes and opinions live: ChatGPT's report in its own
// words with a very different grade, Eric's approve with a note filled into
// both paper books and then undone, and a forensic outcome note.
function plantOutcomes(s) {
  const { ws, pid } = s;
  editReport(ws, reportOf(ws, pid, 'chatgpt'), (a) => {
    a.summary = `${OTHER_MODEL} ${a.summary || ''}`;
    a.verdict_reason = OTHER_MODEL;
    scoreAll(5)(a);
  });
  const r1 = saveTicket(ws, pid);
  settle(ws);
  const now0 = Date.now();
  const top = Math.floor(now0 / H) * H;
  TD.applyHours(ws, Array.from({ length: 16 }, (_, i) => bar(top - (16 - i) * H)), { now: iso(now0) });
  const ap = T.decide(ws, pid, { receipt_id: r1.receipt_id, action: 'approve', note: NOTE, by: 'eric' });
  const d1 = ap.result.decision;
  assert.equal(ap.result.paper.status, 'saved', 'a PM Cohort position opened');
  assert.equal(ap.result.trader.status, 'order', 'a Trader Sim order was reserved');
  TD.applyHours(ws, [bar(top), bar(top + H, { low: '0.80', volume: '1000000' })], { now: iso(top + 2 * H + 11 * 60000) });
  const notes = ws.abs(`projects/${pid}/forensics/outcome-notes.jsonl`);
  fs.mkdirSync(path.dirname(notes), { recursive: true });
  fs.appendFileSync(notes, `${JSON.stringify({ at: new Date().toISOString(), note: OUTCOME_NOTE })}\n`);
  const intentId = TD.intentIdOf(d1, 'open');
  const ids = [d1.decision_id, ap.result.paper.position_id, intentId, `cr2-${intentId}`, `pos-${intentId}`];
  const all = fs.readdirSync(ws.root, { recursive: true }).filter((f) => /\.(json|jsonl|md)$/.test(f)).map((f) => fs.readFileSync(path.join(ws.root, f), 'utf8')).join('\n');
  for (const c of [NOTE, OTHER_MODEL, OUTCOME_NOTE, ...ids]) assert.ok(all.includes(c), `planted: ${c}`);
  return { r1, d1, canaries: [NOTE, OTHER_MODEL, OUTCOME_NOTE, ...ids] };
}

// Eric's Undo of that grant, his rearm, and a new Prosecutor's ticket on the
// same report (the history the mandate then reads around).
function newTicketAfter(ws, pid, rid) {
  T.decide(ws, pid, { receipt_id: rid, action: 'undo', by: 'eric' });
  T.setAutonomy(ws, pid, { action: 'rearm', request_id: 'req_blind_rearm02', by: 'eric' });
  const created = withExitReadings(1.5, () => T.createTicket(ws, { project_id: pid, assistant: true, refresh: true }));
  assert.ok(created.ticket, `a new ticket opened: ${created.status} ${created.message || ''}`);
  freshPrice(ws, 'example-payfi-fictional', 0.85);
  const handed = T.loadTicket(ws, pid, created.ticket.ticket_id);
  return { ticket: handed, receipt: T.saveTicket(ws, { project_id: pid, ticket_id: handed.ticket_id, text: answer(handed, {}, CONSISTENT) }).receipt };
}

// --- The rubric -----------------------------------------------------------

test('the real rubric reads the report\'s own components and its rubric files only: outcomes, decisions and another model change nothing', (t) => {
  const s = mandateDesk(t, { grade: null });
  const { ws, pid } = s;
  const claude = () => reportOf(ws, pid, 'claude').assessment;
  ws._rubrics = null;
  const before = rubrics.gradeAssessment(ws, claude());
  assert.equal(before.status, 'firm');
  assert.equal(before.value, 60.5, 'the fixture\'s Claude report, graded by the real rubric');

  const { r1, canaries } = plantOutcomes(s);
  const clean = canaryCheck(canaries);
  assert.equal(r1.desk.gate.grade_used, before.value, 'the gate sized the ticket from that grade');

  ws._rubrics = null;
  const a = claude();
  const { out: after, reads } = readsDuring(ws.root, () => rubrics.gradeAssessment(ws, a));
  assert.deepEqual(after, before, 'the grade is the same with every outcome and opinion on record');
  clean('the rubric\'s grade', JSON.stringify(after));
  assert.ok(reads.length > 0, 'the spy sees the rubric reading its files');
  assert.deepEqual(reads.filter((r) => OUTCOME_SOURCE.test(r)), [], 'the rubric reads no outcome, decision, book or report');
  // Controls: the spy catches an outcome read, and the grade moves with its
  // own input.
  const caught = readsDuring(ws.root, () => fs.readFileSync(ws.abs(`projects/${pid}/tickets/decisions.jsonl`)));
  assert.ok(caught.reads.some((r) => OUTCOME_SOURCE.test(r)), 'control: an outcome read is caught');
  const lowered = structuredClone(a);
  scoreAll(52)(lowered);
  assert.equal(rubrics.gradeAssessment(ws, lowered).value, 52, 'control: the grade follows the report\'s own components');
});

// --- The paper mandate ------------------------------------------------------

// A pilot desk on Base with the mandate armed, the real rubric, and one
// Prosecutor's ticket ready for the sweep; with { outcomes } the canaries and
// a decided, filled and undone grant on record first; with { score } Claude's
// own components set to that value before any ticket.
function sweepReady(t, { outcomes = false, score = null } = {}) {
  const s = mandateDesk(t, { grade: null });
  const { ws, pid } = s;
  onBase(ws, pid);
  if (score !== null) editReport(ws, reportOf(ws, pid, 'claude'), scoreAll(score));
  let planted = null;
  let r;
  if (outcomes) {
    planted = plantOutcomes(s);
    r = newTicketAfter(ws, pid, planted.r1.receipt_id).receipt;
  } else r = saveTicket(ws, pid);
  pilotOn(ws, pid);
  return { ...s, r, planted };
}
const grantOf = (out) => {
  assert.equal(out.granted.length, 1, JSON.stringify(out.skipped));
  const g = out.granted[0];
  return { action: g.action, tier: g.tier, grade: g.grade, risk_usd: g.risk_usd, pair: g.pair };
};

test('the paper mandate\'s real sweep grants the same tier and size with or without outcomes and opinions on record, and moves with Claude\'s own grade', (t) => {
  contractEvidencePasses(t);
  const plain = sweepReady(t);
  const a = grantOf(T.mandateSweep(plain.ws));
  assert.deepEqual(a, { action: 'approve', tier: 'standard_55_plus', grade: 60.5, risk_usd: 500, pair: 'XMPL/USDC' });

  const busy = sweepReady(t, { outcomes: true });
  const clean = canaryCheck(busy.planted.canaries);
  const out = T.mandateSweep(busy.ws);
  assert.deepEqual(grantOf(out), a, 'outcomes, Eric\'s note and another model\'s opinion change nothing the mandate grants');
  clean('the sweep\'s answer', JSON.stringify(out));
  const line = T.readDecisions(busy.ws, busy.pid).find((l) => l.decision_id === out.granted[0].decision_id);
  assert.equal(line.mandate.grade_used, rubrics.gradeAssessment(busy.ws, reportOf(busy.ws, busy.pid, 'claude').assessment).value, 'the tier came from the real rubric\'s grade of Claude\'s report');
  clean('the mandate\'s decision line', JSON.stringify(line));

  // Control: the same sweep on a desk whose Claude components read 52.
  const lower = sweepReady(t, { score: 52 });
  assert.deepEqual(grantOf(T.mandateSweep(lower.ws)), { action: 'halve', tier: 'exploratory_50_54', grade: 52, risk_usd: 250, pair: 'XMPL/USDC' }, 'control: the grant follows Claude\'s own grade');
});

// --- Delivery to the models -----------------------------------------------

// The connector's handler, called as the server calls it (connector-handoff.test.js).
function connector(ws) {
  const handle = require('../mcp').makeMcp(ws, { log: () => {} });
  return async (assistant, name, args) => {
    const req = Readable.from([Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }))]);
    req.method = 'POST';
    let out = '';
    await handle(req, { writeHead() {}, end(s) { out = s || ''; } }, { assistant, client_name: `FICTIONAL ${assistant}`, grant_id: `grant_FICTIONAL_${assistant}`, client_id: `crc_FICTIONAL_${assistant}` });
    const res = JSON.parse(out).result;
    assert.ok(res && !res.isError, `${name} answered: ${out.slice(0, 300)}`);
    return JSON.stringify(res);
  };
}

test('what reaches a model carries no outcome or other opinion: the Claude API request, the connector\'s handoffs and the Prosecutor\'s prompt as the pilot worker takes it', async (t) => {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = KEY;
  t.after(() => { if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev; });
  const s = mandateDesk(t, { grade: null, settings: { research: { max_output_tokens: 48000, max_continuations: 0, providers: { claude: { model: 'claude-opus-5-5', input_usd_per_mtok: 4, output_usd_per_mtok: 20, search_usd_per_call: 0.01, max_searches: 8 } }, budget: { per_run_usd: 5, daily_usd: 10, monthly_usd: 40 } } } });
  const { ws, pid } = s;
  const { canaries, r1 } = plantOutcomes(s);
  const clean = canaryCheck(canaries);
  const call = connector(ws);

  // New research: the run, then the request the runner sends to Anthropic.
  cancelOpenJobs(ws, pid);
  assert.equal(research.providerStatus(ws).claude.mode, 'api', 'Claude runs on its API here');
  const run = research.createRun(ws, { project_id: pid, providers: ['claude', 'chatgpt'], channel: 'dashboard', force_new: true }).run;
  const prompt = fs.readFileSync(ws.abs(run.prompt.path), 'utf8');
  clean('the frozen research prompt', prompt);
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push({ url: String(url), body: String(init && init.body) });
    return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'FICTIONAL: stop here' } }), { status: 400, headers: { 'content-type': 'application/json', 'request-id': 'req_FICTIONAL' } });
  };
  await research.runDueJobs(ws, { fetchImpl });
  const sent = bodies.filter((b) => /anthropic/.test(b.url));
  assert.ok(sent.length >= 1, `the runner sent its request: ${bodies.map((b) => b.url).join(', ')}`);
  assert.ok(sent[0].body.includes(JSON.stringify(prompt).slice(1, 200)), 'control: the captured request is the run\'s own prompt');
  clean('the request sent to the Claude API', sent.map((b) => b.body).join('\n'));

  // The connector's handoffs: the run as ChatGPT and Claude read it.
  clean('pending_research for ChatGPT', await call('chatgpt', 'pending_research', { project: pid }));
  clean('get_research for ChatGPT', await call('chatgpt', 'get_research', { project_id: pid, run_id: run.run_id }));
  clean('get_research for Claude', await call('claude', 'get_research', { project_id: pid, run_id: run.run_id }));

  // A new Prosecutor's ticket, as the connector hands it to Claude and as the
  // pilot worker takes its prompt (pilot-worker.js prepare: tickets.promptFor).
  const created = withExitReadings(1.5, () => T.createTicket(ws, { project_id: pid, assistant: true, refresh: true }));
  assert.ok(created.ticket, `a new ticket opened: ${created.status} ${created.message || ''}`);
  const handoff = await call('claude', 'pending_tickets', { project: pid, include_prompt: true });
  assert.ok(handoff.includes(created.ticket.ticket_id), 'control: the handoff is this ticket');
  clean('pending_tickets for Claude', handoff);
  const p = T.promptFor(ws, T.loadTicket(ws, pid, created.ticket.ticket_id));
  assert.ok(p.text && p.text.length > 1000, 'the pilot worker\'s prompt was rendered');
  clean('the Prosecutor\'s prompt as the pilot worker takes it', p.text);
  assert.ok(r1.receipt_id, 'the earlier ticket stays on record');
});
