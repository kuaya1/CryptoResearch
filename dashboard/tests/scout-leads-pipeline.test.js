'use strict';
// The intake dialectic end to end (audits/2026-10-29-intake-dialectic/PLAN.md
// §8, "Integration test, once PR 6 is in"): a delivery, eligibility over a fake
// fetch, Eric's reviewed batch, the durable admission, the run's jobs as the
// frozen envelope says, a cr.ticket.v1 receipt the trader's readers take as
// before, and ChatGPT's optional challenge, with a restart (a new desk process
// over the same folder) between each step. Passing it establishes the code,
// not the deployed configuration, the production records or provider access.
// FICTIONAL temporary desk; nothing reaches the network or a model.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { openWorkspace } = require('../core/workspace');
const { sha256 } = require('../core/fsx');
const { mockReport } = require('../core/demo');
const L = require('../core/leads');
const T = require('../core/tickets');
const C = require('../core/ticket-challenges');
const research = require('../core/research');
const PT = require('../core/paper-trader');
const { EVM, workspace, eligibleLeads } = require('./leads-fixtures');

const restart = (root) => openWorkspace({ root, actor: 'test' });

function connector(ws) {
  const handle = require('../mcp').makeMcp(ws);
  return async (assistant, name, args) => {
    let body = '';
    const req = require('stream').Readable.from([Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }))]);
    req.method = 'POST';
    const res = { writeHead() {}, end(b) { body = b || ''; } };
    await handle(req, res, { assistant });
    return JSON.parse(body).result;
  };
}

function expectFor(ws, keys) {
  const v = L.reviewView(ws);
  return {
    policy: { version: v.policy.version, sha256: v.policy.sha256 },
    envelope: v.envelope,
    rows: keys.map((k) => {
      const r = v.rows.find((x) => x.lead_key === k);
      return { lead_key: k, eligibility_receipt_id: r.eligibility_receipt_id, eligibility_sha256: r.eligibility_sha256, identity_revision: r.identity_revision, asset_revision: r.asset_revision };
    }),
  };
}

const AT = new Date().toISOString();
function prosecution(tk) {
  const b = {
    format: T.FORMAT, ticket_id: tk.ticket_id, project_id: tk.project_id, prompt_version: T.PROMPT_VERSION, role: 'prosecutor', model: 'claude', model_version: 'claude-test', as_of: AT,
    researcher_report_id: tk.basis.researcher.report_id, researcher_report_sha256: tk.basis.researcher.original.sha256,
    prosecution: { verdict: 'thesis_damaged', conviction_score: 40, tests: { mercenary_emissions: { result: 'unknown', finding: 'Fictional.' }, tax_revenue: { result: 'pass', finding: 'Fictional.' }, exit_slippage: { result: 'unknown', finding: 'No reading.' }, unverified_claims: { result: 'fail', finding: 'Fictional.' } }, fatal_flaws: [], strongest_bull_rebuttal: 'Fictional.' },
    proposal: { proposal_type: 'WATCH_ONLY', non_consensus_thesis: 'The market assumes demand; the evidence shows little; a listing within the horizon makes the difference observable.', entry_zone: null, upside_target: null, invalidation_trigger: { price_usd: null, metric: null, statement: 'None while watching.' } },
    agent_disagreement_note: 'Fictional.',
    sources: [],
  };
  return `# Prosecution (FICTIONAL)\n\n${'Each test written out for the integration fixture. '.repeat(14)}\n\n\`\`\`json\n${JSON.stringify(b, null, 2)}\n\`\`\`\n`;
}
function challenge(run) {
  const b = {
    format: C.FORMAT, challenge_id: run.run_id, project_id: run.project_id, receipt_id: run.receipt_id, receipt_sha256: run.receipt_sha256, prompt_version: C.PROMPT_VERSION, role: 'challenger', model: 'chatgpt', model_version: 'gpt-test', as_of: AT,
    tests: Object.fromEntries(['mercenary_emissions', 'tax_revenue', 'exit_slippage', 'unverified_claims'].map((k) => [k, { assessment: k === 'exit_slippage' ? 'cannot_assess' : 'agree', reason: `Fictional reason for ${k}.`, source_ids: [] }])),
    trade_plan_critique: 'Watching is consistent with the missing exit reading (FICTIONAL).',
    challenge_verdict: 'concur',
    verdict_reason: 'The ticket holds on what could be checked (FICTIONAL).',
    sources: [],
  };
  return `# Challenge (FICTIONAL)\n\n${'Each test checked for the integration fixture. '.repeat(12)}\n\n\`\`\`json\n${JSON.stringify(b, null, 2)}\n\`\`\`\n`;
}

// What paper-trader.js reads of a ticket (its exit cap): the receipt by its
// own pattern and version, and the packet it names, checked by SHA-256.
function traderReads(ws, pid) {
  const dir = ws.abs(`projects/${pid}/tickets/receipts`);
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    const rid = f.slice(0, -5);
    assert.ok(PT.RECEIPT_RE.test(rid), `${f} is a ticket receipt by the trader's own pattern`);
    const rc = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'));
    assert.equal(rc.schema_version, 'cr.ticket-receipt.v1');
    assert.equal(rc.receipt_id, rid);
    assert.equal(sha256(fs.readFileSync(ws.abs(rc.packet.path), 'utf8')), rc.packet.sha256);
    return rid;
  }).sort();
}

test('delivery → eligibility → reviewed batch → admission → the envelope\'s jobs → a v1 ticket the trader reads → an optional challenge, with a restart between each step', async (t) => {
  // ChatGPT has the desk's mock route, so the envelope gives it a queued job;
  // Claude has none, so its job waits for its assistant.
  const { ws: ws0, root } = workspace(t, 'pipeline', { research: { providers: { chatgpt: { mock: true } } } });
  const [key] = await eligibleLeads(ws0, [EVM(500)]);

  let ws = restart(root);
  assert.equal(L.getAsset(ws, key).state, 'ELIGIBLE', 'eligibility survives a restart');
  const expect = expectFor(ws, [key]);
  assert.deepEqual(expect.envelope.models, ['claude', 'chatgpt']);
  const confirmed = L.confirmLeads(ws, { request_id: `req_pipeline_${process.pid}`, expect });
  assert.equal(confirmed.status, 'admitted');
  const adm = confirmed.admissions[0];
  assert.equal(adm.state, 'complete');

  ws = restart(root);
  const pid = adm.project_id;
  const run = research.loadRun(ws, pid, adm.run_id);
  assert.deepEqual(Object.keys(run.jobs).sort(), ['chatgpt', 'claude'], 'the run\'s jobs are the frozen envelope\'s models');
  assert.equal(run.jobs.claude.state, 'unconfigured', 'no route: it waits for Claude');
  assert.equal(run.jobs.chatgpt.state, 'queued', 'a route: queued for the runner');
  assert.ok(research.hasDueWork(ws));
  assert.equal(L.confirmLeads(ws, { request_id: `req_pipeline_${process.pid}`, expect }).status, 'unchanged', 'a replay after the restart changes nothing');
  assert.equal(research.listRuns(ws, pid).length, 1);

  // Agent 1: Claude's report, saved through the connector.
  ws = restart(root);
  const call = connector(ws);
  const saved = await call('claude', 'save_report', { project_id: pid, run_id: run.run_id, report_markdown: mockReport(ws, 'claude', research.loadRun(ws, pid, run.run_id)) });
  assert.equal(saved.isError, false, saved.content && saved.content[0].text);
  assert.equal(research.loadRun(ws, pid, run.run_id).jobs.claude.state, 'completed');

  // Agent 2: the Prosecutor's ticket (Eric's override, so a ticket opens
  // whatever the grade), a cr.ticket.v1 receipt.
  ws = restart(root);
  const tk = T.createTicket(ws, { project_id: pid, assistant: true, force_prosecution: true }).ticket;
  ws = restart(root);
  const receipt = T.saveTicket(ws, { project_id: pid, ticket_id: tk.ticket_id, text: prosecution(tk) });
  assert.equal(receipt.status, 'saved');

  ws = restart(root);
  assert.deepEqual(traderReads(ws, pid), [receipt.receipt_id], 'the trader reads the receipt as before');
  const desk = require('../core/trader-desk');
  const now = Date.now();
  const at = new Date(now).toISOString();
  const bookBefore = JSON.stringify(desk.view(ws, { now: at }));
  const ticketBefore = JSON.stringify(T.read(ws, pid, { now }));

  // ChatGPT's challenge waits for its own research, which the runner does.
  const pending = (await connector(ws)('chatgpt', 'pending_challenges', { project: pid })).structuredContent;
  assert.equal(pending.status, 'blocked');
  assert.equal((await connector(ws)('chatgpt', 'start_challenge', { project_id: pid, owner_request: 'challenge it' })).isError, true);
  await research.runDueJobs(ws, { fetchImpl: async () => { throw new Error('no network in tests'); } });
  assert.equal(research.loadRun(ws, pid, run.run_id).jobs.chatgpt.state, 'completed', 'the mock route completed ChatGPT\'s research');

  ws = restart(root);
  const started = (await connector(ws)('chatgpt', 'start_challenge', { project_id: pid, owner_request: 'challenge it' })).structuredContent;
  assert.equal(started.status, 'created');
  ws = restart(root);
  const job = C.loadJob(ws, pid, started.challenge_id);
  const out = (await connector(ws)('chatgpt', 'save_challenge', { project_id: pid, challenge_id: job.challenge_id, challenge_markdown: challenge({ run_id: job.challenge_id, project_id: pid, receipt_id: receipt.receipt_id, receipt_sha256: started.target.receipt_sha256 }) })).structuredContent;
  assert.equal(out.status, 'saved');

  ws = restart(root);
  const row = C.rowFor(ws, pid, receipt.receipt_id);
  assert.equal(row.words, 'ChatGPT challenge: concurs (3 of 4 tests assessed)');
  assert.deepEqual(traderReads(ws, pid), [receipt.receipt_id], 'the challenge never joins the trader\'s receipts');
  assert.equal(JSON.stringify(desk.view(ws, { now: at })), bookBefore, 'the trader desk reads the same book');
  assert.equal(JSON.stringify(T.read(ws, pid, { now })), ticketBefore, 'the ticket reads the same');
});
