'use strict';
// ChatGPT's challenge of a saved PM ticket (core/ticket-challenges.js,
// intake dialectic PR 6): frozen against the ticket receipt byte for byte,
// ChatGPT only, held back while its own research is open, refused field by
// field with the text kept as the draft, a verdict that must fit the tests,
// advisory only (the ticket, the decision and get_ticket unchanged), and
// ticket_failed in the queue. Fictional workspaces and fixtures only; no model
// or provider is asked anything.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempWorkspace, addFixtureProject, importAllFixtures, hashTree } = require('./helpers');
const { openWorkspace } = require('../core/workspace');
const { sha256, jsonText } = require('../core/fsx');
const T = require('../core/tickets');
const C = require('../core/ticket-challenges');
const research = require('../core/research');

const AT = new Date().toISOString();

// A project with Claude's report and one saved Prosecutor ticket ($0, so no
// exit reading is needed).
function desk(t, settings = {}) {
  const w = tempWorkspace('challenge', settings);
  t.after(w.cleanup);
  const pid = addFixtureProject(w.ws).project_id;
  importAllFixtures(w.ws);
  const tk = T.createTicket(w.ws, { project_id: pid, assistant: true }).ticket;
  const saved = T.saveTicket(w.ws, { project_id: pid, ticket_id: tk.ticket_id, text: prosecution(tk) });
  assert.equal(saved.status, 'saved');
  return { ...w, pid, tk, rid: saved.receipt_id, receipt: saved.receipt };
}

function prosecution(tk, over = {}) {
  const b = {
    format: T.FORMAT,
    ticket_id: tk.ticket_id,
    project_id: tk.project_id,
    prompt_version: T.PROMPT_VERSION,
    role: 'prosecutor',
    model: 'claude',
    model_version: 'claude-test',
    as_of: AT,
    researcher_report_id: tk.basis.researcher.report_id,
    researcher_report_sha256: tk.basis.researcher.original.sha256,
    prosecution: {
      verdict: 'thesis_damaged',
      conviction_score: 38,
      tests: { mercenary_emissions: { result: 'fail', finding: 'Rewards exceed fees (FICTIONAL).', source_ids: ['S1'] }, tax_revenue: { result: 'pass', finding: '' }, exit_slippage: { result: 'unknown', finding: 'No reading.' }, unverified_claims: { result: 'fail', finding: 'Partner list unsourced.' } },
      fatal_flaws: [],
      strongest_bull_rebuttal: 'Emissions taper next quarter.',
    },
    proposal: {
      proposal_type: 'ACCUMULATE',
      non_consensus_thesis: 'The market assumes organic demand; the evidence shows paid activity; the emission cut in Q1 makes the difference observable.',
      entry_zone: { low_usd: 0.8, high_usd: 0.9, basis: 'prior range' },
      upside_target: { price_usd: 1.4, basis: 'fees double' },
      invalidation_trigger: { price_usd: 0.7, metric: null, statement: 'Below $0.70.' },
    },
    agent_disagreement_note: 'Fictional.',
    sources: [{ source_id: 'S1', url: 'https://example.com/xmpl/emissions', publisher: 'Example (FICTIONAL)', retrieved_at: AT, excerpt: 'fictional' }],
    ...over,
  };
  return `# Prosecution (FICTIONAL)\n\n${'The four tests and the flaws, written out for the test fixture. '.repeat(12)}\n\n\`\`\`json\n${JSON.stringify(b, null, 2)}\n\`\`\`\n`;
}

const TESTS = ['mercenary_emissions', 'tax_revenue', 'exit_slippage', 'unverified_claims'];
const all = (assessment) => Object.fromEntries(TESTS.map((k) => [k, { assessment, reason: `Fictional reason for ${k}.`, source_ids: assessment === 'cannot_assess' ? [] : ['X1'] }]));

// ChatGPT's answer for a challenge job, as the model would write it.
function challengeText(job, target, over = {}) {
  const b = {
    format: C.FORMAT,
    challenge_id: job.challenge_id,
    project_id: job.project_id,
    receipt_id: target.receipt_id,
    receipt_sha256: target.receipt_sha256,
    prompt_version: C.PROMPT_VERSION,
    role: 'challenger',
    model: 'chatgpt',
    model_version: 'gpt-test',
    as_of: AT,
    tests: { ...all('agree'), exit_slippage: { assessment: 'disagree', reason: 'The exit reading is a lower bound (FICTIONAL).', source_ids: ['X1'] } },
    trade_plan_critique: 'The entry zone sits above the last range (FICTIONAL).',
    challenge_verdict: 'material_objection',
    verdict_reason: 'The exit is not proven (FICTIONAL).',
    sources: [{ source_id: 'X1', url: 'https://example.com/xmpl/pool', publisher: 'Example (FICTIONAL)', retrieved_at: AT, excerpt: 'fictional' }],
    ...over,
  };
  return `# Challenge (FICTIONAL)\n\n${'Each test checked against the sources, written out for the fixture. '.repeat(8)}\n\n\`\`\`json\n${JSON.stringify(b, null, 2)}\n\`\`\`\n`;
}

function start(s) {
  const out = C.startChallenge(s.ws, { project_id: s.pid });
  return { out, job: C.loadJob(s.ws, s.pid, out.challenge_id), target: { receipt_id: out.receipt_id, receipt_sha256: out.target.receipt_sha256 } };
}

function connector(ws) {
  const handle = require('../mcp').makeMcp(ws);
  return async (assistant, name, args, who = {}) => {
    let body = '';
    const req = require('stream').Readable.from([Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }))]);
    req.method = 'POST';
    const res = { writeHead() {}, end(b) { body = b || ''; } };
    await handle(req, res, { assistant, ...who });
    return JSON.parse(body).result;
  };
}

const challengeFiles = (s) => {
  const dir = s.ws.abs(`projects/${s.pid}/tickets`);
  return ['challenges', 'challenge-receipts'].filter((d) => fs.existsSync(path.join(dir, d)));
};

test('the challenge prompt and schema are published and pinned; the schema has no proposal, size, risk, grade or price', () => {
  const dir = path.join(__dirname, '..', '..', 'templates');
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'tickets', 'LOCK.json'), 'utf8'));
  assert.ok(lock.sha256['challenge-prompt.v1.md']);
  assert.equal(sha256(fs.readFileSync(path.join(dir, 'tickets', 'challenge-prompt.v1.md'), 'utf8').replace(/\r\n/g, '\n')), lock.sha256['challenge-prompt.v1.md']);
  assert.equal(lock.sha256['ticket-prompt.v1.md'], '2bbd6a60e571aed13e60813535af623ee00e0da16b75e326bb308e293350e06c', 'the Prosecutor prompt is untouched');
  const schema = JSON.parse(fs.readFileSync(path.join(dir, 'schemas', 'ticket-challenge.v1.schema.json'), 'utf8'));
  assert.equal(schema.$id, C.FORMAT);
  assert.equal(schema.additionalProperties, false);
  for (const k of ['proposal_type', 'proposal', 'size', 'risk', 'suggested_risk_usd', 'grade', 'price', 'price_usd', 'conviction_score']) assert.ok(!(k in schema.properties), k);
  assert.deepEqual(schema.properties.challenge_verdict.enum, C.VERDICTS);
});

test('opening freezes the ticket receipt, its text, the packet and the report byte for byte; the prompt is frozen with every placeholder filled', (t) => {
  const s = desk(t);
  const { out, job } = start(s);
  assert.equal(out.status, 'created');
  const target = JSON.parse(fs.readFileSync(s.ws.abs(`projects/${s.pid}/tickets/challenges/${job.challenge_id}/target.json`), 'utf8'));
  assert.equal(sha256(fs.readFileSync(s.ws.abs(`projects/${s.pid}/tickets/challenges/${job.challenge_id}/target.json`))), job.target_sha256);
  assert.equal(target.receipt.sha256, sha256(fs.readFileSync(s.ws.abs(`projects/${s.pid}/tickets/receipts/${s.rid}.json`))), 'the receipt\'s bytes');
  assert.equal(target.receipt.text_sha256, s.receipt.text.sha256);
  assert.equal(target.packet.sha256, sha256(fs.readFileSync(s.ws.abs(s.receipt.packet.path))), 'the packet\'s bytes');
  assert.equal(target.packet.path, s.receipt.packet.path, 'the same packet file the ticket froze');
  assert.equal(target.report.sha256, s.tk.basis.researcher.original.sha256);
  assert.equal(sha256(out.prompt.text), job.prompt.sha256);
  assert.ok(!/\{\{[A-Z_0-9]+\}\}/.test(out.prompt.text), 'every placeholder is filled');
  assert.ok(out.prompt.text.includes(`BEGIN TICKET ${s.rid}`));
  assert.ok(out.prompt.text.includes(target.receipt.sha256));
  assert.equal(C.startChallenge(s.ws, { project_id: s.pid }).status, 'resumed', 'the open challenge is resumed, not doubled');
  assert.equal(C.listChallenges(s.ws, s.pid).length, 1);
  assert.equal(T.listReceipts(s.ws, s.pid).length, 1, 'nothing joins the ticket receipts');
});

test('an altered packet or ticket receipt is INTEGRITY with nothing written, at the opening and at the save', (t) => {
  const s = desk(t);
  const packet = s.ws.abs(s.receipt.packet.path);
  const was = fs.readFileSync(packet);
  fs.appendFileSync(packet, ' ');
  let tree = hashTree(s.root);
  assert.throws(() => C.startChallenge(s.ws, { project_id: s.pid }), (e) => e.code === 'INTEGRITY');
  assert.deepEqual(hashTree(s.root), tree, 'nothing written');
  fs.writeFileSync(packet, was);
  const { job, target } = start(s);
  const receiptFile = s.ws.abs(`projects/${s.pid}/tickets/receipts/${s.rid}.json`);
  const rwas = fs.readFileSync(receiptFile);
  fs.writeFileSync(receiptFile, jsonText({ ...JSON.parse(rwas), proposal: null }));
  tree = hashTree(s.root);
  assert.throws(() => C.saveChallenge(s.ws, { project_id: s.pid, challenge_id: job.challenge_id, text: challengeText(job, target) }), (e) => e.code === 'INTEGRITY');
  assert.throws(() => C.startChallenge(s.ws, { project_id: s.pid }), (e) => e.code === 'INTEGRITY');
  assert.deepEqual(hashTree(s.root), tree, 'nothing written: no draft, no receipt');
  assert.equal(C.rowFor(s.ws, s.pid, s.rid).state, 'integrity');
});

test('an altered saved challenge, or a ticket receipt changed after it, shows no verdict on the card or the route', (t) => {
  const s = desk(t);
  const { job, target } = start(s);
  const saved = C.saveChallenge(s.ws, { project_id: s.pid, challenge_id: job.challenge_id, text: challengeText(job, target) });
  assert.equal(saved.status, 'saved');
  assert.equal(C.rowFor(s.ws, s.pid, s.rid).verdict, 'material_objection');
  const md = s.ws.abs(saved.receipt.text.path);
  fs.appendFileSync(md, 'tampered');
  for (const row of [C.rowFor(s.ws, s.pid, s.rid), C.challengesView(s.ws, s.pid).row]) {
    assert.equal(row.state, 'integrity');
    assert.equal(row.words, C.NOT_SHOWN);
    assert.equal(row.verdict, null);
    assert.equal(row.tests, null);
  }
  const listed = C.challengesView(s.ws, s.pid).challenges[0];
  assert.equal(listed.holds, false);
  assert.equal(listed.verdict, undefined, 'no verdict for a record that does not hold');
  fs.writeFileSync(md, fs.readFileSync(md, 'utf8').replace(/tampered$/, ''));
  assert.equal(C.rowFor(s.ws, s.pid, s.rid).state, 'saved');
  const receiptFile = s.ws.abs(`projects/${s.pid}/tickets/receipts/${s.rid}.json`);
  fs.appendFileSync(receiptFile, '\n');
  assert.equal(C.rowFor(s.ws, s.pid, s.rid).state, 'integrity', 'the ticket receipt as it stands on disk');
});

test('roles: Claude is refused; Gemini has no role, held or not; a held ChatGPT gets on_hold and refusals', async (t) => {
  const s = desk(t);
  const call = connector(s.ws);
  for (const name of ['pending_challenges', 'start_challenge', 'save_challenge']) {
    const out = await call('claude', name, { project_id: s.pid, owner_request: 'test', challenge_id: 'tc_2026-10-29T000000Z_aaaaa', challenge_markdown: 'x' });
    assert.equal(out.isError, true, `Claude: ${name}`);
  }
  const gemini = async () => {
    for (const name of ['pending_challenges', 'start_challenge', 'save_challenge']) {
      const out = await call('gemini', name, { project_id: s.pid, owner_request: 'test', challenge_id: 'tc_2026-10-29T000000Z_aaaaa', challenge_markdown: 'x' });
      assert.equal(out.isError, false, `Gemini: ${name}`);
      assert.equal(out.structuredContent.status, 'no_role', `Gemini: ${name}`);
    }
  };
  await gemini();
  s.ws.settings.research = { ...s.ws.settings.research, on_hold: { gemini: { since: '2026-10-06' } } };
  await gemini();
  assert.deepEqual(challengeFiles(s), [], 'nothing opened for Claude or Gemini');
  s.ws.settings.research = { ...s.ws.settings.research, on_hold: { chatgpt: { since: '2026-10-29' } } };
  const pending = await call('chatgpt', 'pending_challenges', {});
  assert.equal(pending.structuredContent.status, 'on_hold');
  assert.deepEqual(pending.structuredContent.pending, []);
  assert.equal((await call('chatgpt', 'start_challenge', { project_id: s.pid, owner_request: 'test' })).isError, true);
  assert.equal((await call('chatgpt', 'save_challenge', { project_id: s.pid, challenge_id: 'tc_2026-10-29T000000Z_aaaaa', challenge_markdown: 'x' })).isError, true);
  assert.deepEqual(challengeFiles(s), []);
  assert.equal(C.rowFor(s.ws, s.pid, s.rid).words, 'No ChatGPT challenge: ChatGPT is on hold');
});

test('with ChatGPT\'s own research open, start and save are refused with nothing written and pending lists it blocked without content; then the challenge opens', async (t) => {
  const s = desk(t);
  const call = connector(s.ws);
  const { job, target } = start(s);
  const run = research.createRun(s.ws, { project_id: s.pid, providers: ['chatgpt'], force_new: true }).run;
  const tree = hashTree(s.root);
  const started = await call('chatgpt', 'start_challenge', { project_id: s.pid, owner_request: 'challenge it' });
  assert.equal(started.isError, true);
  assert.match(started.content[0].text, /your own research on it is open/);
  const saved = await call('chatgpt', 'save_challenge', { project_id: s.pid, challenge_id: job.challenge_id, challenge_markdown: challengeText(job, target) });
  assert.equal(saved.isError, true);
  assert.deepEqual(hashTree(s.root), tree, 'no job, draft or receipt written');
  const pending = (await call('chatgpt', 'pending_challenges', {})).structuredContent;
  assert.equal(pending.status, 'blocked');
  assert.equal(pending.next, null, 'never the next task');
  const item = pending.pending[0];
  assert.match(item.blocked, new RegExp(run.run_id));
  for (const k of ['prompt', 'target', 'draft', 'run']) assert.equal(item[k], undefined, k);
  assert.ok(!JSON.stringify(pending).includes(target.receipt_sha256), 'no target in the listing');
  // ChatGPT's report saved: its job is no longer open (the save's effect on the run).
  const rel = `projects/${s.pid}/research/${run.run_id}/run.json`;
  const r = JSON.parse(fs.readFileSync(s.ws.abs(rel), 'utf8'));
  r.jobs.chatgpt.state = 'completed';
  fs.writeFileSync(s.ws.abs(rel), jsonText(r));
  const again = await call('chatgpt', 'start_challenge', { project_id: s.pid, owner_request: 'challenge it' });
  assert.equal(again.isError, false);
  assert.equal(again.structuredContent.run.kind, 'ticket_challenge');
  assert.equal(sha256(again.structuredContent.run.prompt), job.prompt.sha256);
  const ok = await call('chatgpt', 'save_challenge', { project_id: s.pid, challenge_id: job.challenge_id, challenge_markdown: challengeText(job, target) });
  assert.equal(ok.structuredContent.status, 'saved');
});

test('the card says ChatGPT\'s own research is open before anything is started', (t) => {
  const s = desk(t);
  research.createRun(s.ws, { project_id: s.pid, providers: ['chatgpt'], force_new: true });
  const row = C.rowFor(s.ws, s.pid, s.rid);
  assert.equal(row.state, 'blocked');
  assert.equal(row.words, 'No ChatGPT challenge yet: its own research on this project is open');
});

test('a read-only connection cannot call the two write tools; pending_challenges is a read tool', async (t) => {
  const s = desk(t);
  const { READ_ONLY_TOOLS, TOOLS } = require('../mcp');
  assert.ok(READ_ONLY_TOOLS.includes('pending_challenges'));
  for (const n of ['start_challenge', 'save_challenge']) {
    assert.ok(!READ_ONLY_TOOLS.includes(n), n);
    assert.equal(TOOLS.find((x) => x.name === n).annotations.readOnlyHint, false, n);
  }
  const call = connector(s.ws);
  const out = await call('chatgpt', 'start_challenge', { project_id: s.pid, owner_request: 'test' }, { read_only: true });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /READ_ONLY/);
  assert.deepEqual(challengeFiles(s), []);
  const listed = await call('chatgpt', 'pending_challenges', {}, { read_only: true });
  assert.equal(listed.isError, false);
  assert.equal(listed.structuredContent.next.project_id, s.pid);
});

test('an invalid block is refused field by field and kept as the draft; the corrected save resumes from it; the same text is unchanged; a different text needs a revision and keeps the first', (t) => {
  const s = desk(t);
  const { job, target } = start(s);
  const tests = all('agree');
  delete tests.exit_slippage;
  const bad = challengeText(job, target, { tests, proposal_type: 'ACCUMULATE', trade_plan_critique: '' });
  assert.throws(() => C.saveChallenge(s.ws, { project_id: s.pid, challenge_id: job.challenge_id, text: bad }), (e) => {
    const fields = e.details.fields.map((f) => f.field);
    return e.code === 'INVALID' && fields.includes('tests.exit_slippage') && fields.includes('proposal_type') && fields.includes('trade_plan_critique');
  });
  assert.deepEqual(C.listChallengeReceipts(s.ws, s.pid), [], 'no receipt');
  const j = C.loadJob(s.ws, s.pid, job.challenge_id);
  assert.equal(j.job.state, 'running');
  assert.ok(j.job.last_refusal.fields.some((f) => f.field === 'tests.exit_slippage'));
  const row = C.rowFor(s.ws, s.pid, s.rid);
  assert.equal(row.state, 'refused');
  assert.match(row.words, /^ChatGPT challenge refused: .*tests\.exit_slippage missing/);
  // A restart (a new desk process over the same folder) keeps the state and the draft.
  const ws2 = openWorkspace({ root: s.root, actor: 'test' });
  const resumed = C.startChallenge(ws2, { project_id: s.pid });
  assert.equal(resumed.status, 'resumed');
  assert.equal(resumed.draft.text, bad, 'the refused text is the draft');
  assert.equal(resumed.challenge_id, job.challenge_id);
  const good = challengeText(job, target);
  const saved = C.saveChallenge(ws2, { project_id: s.pid, challenge_id: job.challenge_id, text: good });
  assert.equal(saved.status, 'saved');
  assert.equal(C.loadJob(ws2, s.pid, job.challenge_id).job.last_refusal, null);
  const same = C.saveChallenge(ws2, { project_id: s.pid, challenge_id: job.challenge_id, text: good });
  assert.equal(same.status, 'unchanged');
  assert.equal(same.challenge_receipt_id, saved.challenge_receipt_id);
  assert.equal(C.listChallengeReceipts(ws2, s.pid).length, 1, 'one receipt');
  const other = challengeText(job, target, { verdict_reason: 'A different reason (FICTIONAL).' });
  assert.throws(() => C.saveChallenge(ws2, { project_id: s.pid, challenge_id: job.challenge_id, text: other }), (e) => e.code === 'INVALID' && e.details.fields[0].field === 'revision');
  const first = fs.readFileSync(ws2.abs(`projects/${s.pid}/tickets/challenge-receipts/${saved.challenge_receipt_id}.json`), 'utf8');
  const rev = C.saveChallenge(ws2, { project_id: s.pid, challenge_id: job.challenge_id, text: other, revision: { kind: 'reassessment', note: 'Read the pool again and changed the reason.' } });
  assert.equal(rev.status, 'saved');
  assert.equal(rev.receipt.revision_of, saved.challenge_receipt_id);
  assert.equal(fs.readFileSync(ws2.abs(`projects/${s.pid}/tickets/challenge-receipts/${saved.challenge_receipt_id}.json`), 'utf8'), first, 'the first receipt is never rewritten');
  assert.equal(C.listChallengeReceipts(ws2, s.pid).length, 2);
});

test('the verdict must fit the tests: nothing turns a missing or unknown test into agreement, a refusal or a zero', (t) => {
  const s = desk(t);
  const { job, target } = start(s);
  const save = (over) => C.saveChallenge(s.ws, { project_id: s.pid, challenge_id: job.challenge_id, text: challengeText(job, target, over) });
  const verdictRefused = (e) => e.code === 'INVALID' && e.details.fields.some((f) => f.field === 'challenge_verdict');
  assert.throws(() => save({ tests: all('cannot_assess'), challenge_verdict: 'concur' }), verdictRefused, 'all cannot_assess with concur');
  assert.throws(() => save({ tests: all('cannot_assess'), challenge_verdict: 'material_objection' }), verdictRefused);
  assert.throws(() => save({ tests: { ...all('agree'), tax_revenue: { assessment: 'disagree', reason: 'Fictional.', source_ids: [] } }, challenge_verdict: 'concur' }), verdictRefused, 'concur with one disagree');
  assert.throws(() => save({ tests: all('agree'), challenge_verdict: 'fatal_objection' }), verdictRefused, 'an objection needs a disagree');
  assert.throws(() => save({ tests: { ...all('agree'), unverified_claims: { assessment: 'unknown', reason: 'x', source_ids: [] } }, challenge_verdict: 'concur' }), (e) => e.details.fields.some((f) => f.field === 'tests.unverified_claims.assessment'), 'an unknown word is refused, not read as agree');
  assert.throws(() => save({ verdict_reason: '' }), (e) => e.details.fields.some((f) => f.field === 'verdict_reason'));
  assert.deepEqual(C.listChallengeReceipts(s.ws, s.pid), []);
  const ok = save({ tests: all('cannot_assess'), challenge_verdict: 'insufficient_evidence', verdict_reason: 'No source could be read (FICTIONAL).' });
  assert.equal(ok.status, 'saved');
  assert.equal(ok.receipt.assessed, 0);
  const row = C.rowFor(s.ws, s.pid, s.rid);
  assert.equal(row.state, 'saved');
  assert.equal(row.assessed_words, '0 of 4 tests assessed');
  assert.equal(row.words, 'ChatGPT: insufficient evidence (0 of 4 tests assessed): No source could be read (FICTIONAL).');
  assert.deepEqual(row.tests.map((x) => x.assessment), ['cannot_assess', 'cannot_assess', 'cannot_assess', 'cannot_assess']);
  for (const k of ['score', 'coverage', 'average', 'majority']) assert.equal(row[k], undefined, k);
});

test('a challenge saved after Eric decided says so and changes neither the decision, the ticket nor get_ticket\'s answer', async (t) => {
  const s = desk(t);
  const now = Date.now();
  const call = connector(s.ws);
  const d = T.decide(s.ws, s.pid, { receipt_id: s.rid, action: 'watch' });
  assert.ok(d);
  const viewBefore = JSON.stringify(T.view(s.ws, s.pid, { now }));
  const readBefore = JSON.stringify(T.read(s.ws, s.pid, { includeText: true, now }));
  const decisions = fs.readFileSync(s.ws.abs(`projects/${s.pid}/tickets/decisions.jsonl`), 'utf8');
  const receipts = fs.readdirSync(s.ws.abs(`projects/${s.pid}/tickets/receipts`)).sort();
  const ticketBefore = (await call('claude', 'get_ticket', { project_id: s.pid })).structuredContent;
  await new Promise((r) => setTimeout(r, 5));
  const { job, target } = start(s);
  const saved = C.saveChallenge(s.ws, { project_id: s.pid, challenge_id: job.challenge_id, text: challengeText(job, target) });
  assert.equal(saved.status, 'saved');
  const row = C.rowFor(s.ws, s.pid, s.rid);
  assert.equal(row.after_decision, true);
  assert.match(row.after_decision_words, /^Arrived after your decision, \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(JSON.stringify(T.view(s.ws, s.pid, { now })), viewBefore, 'the ticket reads as before');
  assert.equal(JSON.stringify(T.read(s.ws, s.pid, { includeText: true, now })), readBefore, 'get_ticket\'s read is unchanged');
  assert.equal(fs.readFileSync(s.ws.abs(`projects/${s.pid}/tickets/decisions.jsonl`), 'utf8'), decisions, 'the decision stands');
  assert.deepEqual(fs.readdirSync(s.ws.abs(`projects/${s.pid}/tickets/receipts`)).sort(), receipts, 'nothing joins receipts/');
  const ticketAfter = (await call('claude', 'get_ticket', { project_id: s.pid })).structuredContent;
  assert.deepEqual(Object.keys(ticketAfter).sort(), Object.keys(ticketBefore).sort());
  assert.equal(ticketAfter.ticket.status, ticketBefore.ticket.status);
  assert.ok(!/challenge/i.test(JSON.stringify(ticketAfter)), 'no challenge in any model-facing ticket read');
  assert.equal(T.summary(s.ws, s.pid).challenge, undefined, 'nor in the index row');
});

test('reading the card\'s row, the route\'s view and pending_challenges writes nothing', async (t) => {
  const s = desk(t);
  const { job, target } = start(s);
  C.saveChallenge(s.ws, { project_id: s.pid, challenge_id: job.challenge_id, text: challengeText(job, target) });
  const tree = hashTree(s.root);
  C.rowFor(s.ws, s.pid, s.rid);
  const v = C.challengesView(s.ws, s.pid, { receiptId: s.rid });
  assert.equal(v.row.state, 'saved');
  assert.equal(v.challenges.length, 1);
  assert.throws(() => C.challengesView(s.ws, s.pid, { receiptId: 'nonsense' }), (e) => e.code === 'BAD_ID');
  await connector(s.ws)('chatgpt', 'pending_challenges', {});
  assert.deepEqual(hashTree(s.root), tree);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /route\('GET', '\/api\/projects\/\(\[\^\/\]\+\)\/tickets\/challenges'/);
});

test('the card row says each state in words: not started, started, refused, saved', (t) => {
  const s = desk(t);
  assert.equal(C.rowFor(s.ws, s.pid, s.rid).words, 'No ChatGPT challenge: not started');
  const { job, target } = start(s);
  assert.equal(C.rowFor(s.ws, s.pid, s.rid).state, 'draft');
  C.saveChallenge(s.ws, { project_id: s.pid, challenge_id: job.challenge_id, text: challengeText(job, target) });
  const row = C.rowFor(s.ws, s.pid, s.rid);
  assert.equal(row.words, 'ChatGPT challenge: material objection (4 of 4 tests assessed)');
  assert.deepEqual(row.tests.map((x) => `${x.label}: ${x.assessment}`), ['Mercenary emissions: agree', 'Tax revenue: agree', 'Exit slippage: disagree', 'Unverified claims: agree']);
  assert.equal(row.after_decision, false);
});

test('ticket_failed: a refused Prosecutor save names the refused field in the queue, keeps the text as the draft, and a new draft clears it', async (t) => {
  const w = tempWorkspace('ticket-failed');
  t.after(w.cleanup);
  const pid = addFixtureProject(w.ws).project_id;
  importAllFixtures(w.ws);
  const tk = T.createTicket(w.ws, { project_id: pid, assistant: true }).ticket;
  assert.equal(T.nextStep(w.ws, pid).step, 'ticket');
  const base = JSON.parse(prosecution(tk).match(/```json\n([\s\S]*)\n```/)[1]);
  const bad = prosecution(tk, { proposal: { ...base.proposal, proposal_type: 'BUY_NOW' } });
  assert.throws(() => T.saveTicket(w.ws, { project_id: pid, ticket_id: tk.ticket_id, text: bad }), (e) => e.code === 'INVALID');
  const step = T.nextStep(w.ws, pid);
  assert.equal(step.step, 'ticket_failed');
  assert.equal(step.refused_field, 'proposal.proposal_type');
  assert.match(step.why, /^Prosecutor: save refused, proposal\.proposal_type: /);
  assert.equal(T.readDraft(w.ws, pid, tk.ticket_id), bad, 'the refused text is kept as the draft');
  const conflict = prosecution(tk, { researcher_report_id: 'another-report' });
  assert.throws(() => T.saveTicket(w.ws, { project_id: pid, ticket_id: tk.ticket_id, text: conflict }), (e) => e.code === 'CONFLICT');
  assert.equal(T.nextStep(w.ws, pid).refused_field, 'researcher_report_id');
  T.setPilot(w.ws, pid, true);
  const q = (await connector(w.ws)('claude', 'autonomous_pilot_queue', { project: pid })).structuredContent;
  assert.equal(q.next.step, 'ticket_failed');
  assert.match(q.next.next_action, /start_ticket/);
  T.saveDraft(w.ws, pid, tk.ticket_id, { text: 'A new attempt (FICTIONAL).' });
  assert.equal(T.nextStep(w.ws, pid).step, 'ticket', 'a new attempt');
  assert.equal(T.saveTicket(w.ws, { project_id: pid, ticket_id: tk.ticket_id, text: prosecution(tk) }).status, 'saved');
  assert.equal(T.nextStep(w.ws, pid).step, 'pm_review');
});

// Audit F4 (audits/2026-10-29-intake-dialectic/POST_IMPLEMENTATION_AUDIT.md):
// what the card shows is pinned and derived from the verified text, so an
// altered receipt JSON is never shown, even with its pin rewritten to match.
test('a receipt JSON altered in its verdict, tests, count or reason shows no verdict, its pin rewritten or not; reading writes nothing', (t) => {
  const s = desk(t);
  const { job, target } = start(s);
  const saved = C.saveChallenge(s.ws, { project_id: s.pid, challenge_id: job.challenge_id, text: challengeText(job, target) });
  const crid = saved.challenge_receipt_id;
  const rel = s.ws.abs(`projects/${s.pid}/tickets/challenge-receipts/${crid}.json`);
  const jobRel = s.ws.abs(`projects/${s.pid}/tickets/challenges/${job.challenge_id}/challenge.json`);
  const original = fs.readFileSync(rel, 'utf8');
  const originalJob = fs.readFileSync(jobRel, 'utf8');
  assert.equal(JSON.parse(originalJob).job.receipt_sha256[crid], sha256(original), 'the receipt\'s bytes are pinned in its job by the save');
  assert.equal(C.rowFor(s.ws, s.pid, s.rid).verdict, 'material_objection');
  const edits = {
    verdict: (r) => { r.challenge_verdict = 'concur'; },
    tests: (r) => { r.tests.exit_slippage.assessment = 'agree'; },
    assessed: (r) => { r.assessed = 2; },
    reason: (r) => { r.verdict_reason = 'A reason never in the saved answer (FICTIONAL).'; },
  };
  for (const [name, edit] of Object.entries(edits)) {
    for (const repin of [false, true]) {
      const r = JSON.parse(original);
      edit(r);
      const text = jsonText(r);
      fs.writeFileSync(rel, text);
      if (repin) {
        const j = JSON.parse(originalJob);
        j.job.receipt_sha256[crid] = sha256(text);
        fs.writeFileSync(jobRel, jsonText(j));
      }
      const before = hashTree(s.root);
      const row = C.rowFor(s.ws, s.pid, s.rid);
      const view = C.challengesView(s.ws, s.pid);
      assert.deepEqual(hashTree(s.root), before, `${name}: reading writes nothing`);
      for (const x of [row, view.row]) {
        assert.equal(x.state, 'integrity', `${name}${repin ? ' (pin rewritten)' : ''}`);
        assert.equal(x.verdict, null);
        assert.equal(x.tests, null);
      }
      assert.equal(view.challenges[0].holds, false);
      assert.equal(view.challenges[0].verdict, undefined);
      fs.writeFileSync(rel, original);
      fs.writeFileSync(jobRel, originalJob);
    }
  }
  assert.equal(fs.readFileSync(rel, 'utf8'), original, 'nothing rewrote the receipt');
  assert.equal(C.rowFor(s.ws, s.pid, s.rid).state, 'saved', 'restored, it holds again');
  // A receipt with no pin in its job is not shown.
  const j = JSON.parse(originalJob);
  delete j.job.receipt_sha256;
  fs.writeFileSync(jobRel, jsonText(j));
  assert.equal(C.rowFor(s.ws, s.pid, s.rid).state, 'integrity');
  fs.writeFileSync(jobRel, originalJob);
  // The same text again is refused while its saved record does not hold.
  const r = JSON.parse(original);
  r.challenge_verdict = 'concur';
  fs.writeFileSync(rel, jsonText(r));
  const before = hashTree(s.root);
  assert.throws(() => C.saveChallenge(s.ws, { project_id: s.pid, challenge_id: job.challenge_id, text: challengeText(job, target) }), (e) => e.code === 'INTEGRITY');
  assert.deepEqual(hashTree(s.root), before);
});
