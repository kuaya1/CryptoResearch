'use strict';
// A Prosecutor's as_of ahead of the save (core/tickets.js AS_OF_AHEAD_MS,
// 2026-11-02): a model guesses its own clock, so up to 30 minutes ahead is
// saved, recorded as the time of saving, with what was written kept on the
// receipt (as_of_clamped) and named in the message; further ahead is refused
// and the text kept as the draft. Fictional workspaces and fixtures only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tempWorkspace, addFixtureProject, importAllFixtures } = require('./helpers');
const T = require('../core/tickets');

const MIN = 60000;

function ticketOf(t) {
  const w = tempWorkspace('ticket-as-of');
  t.after(w.cleanup);
  const pid = addFixtureProject(w.ws).project_id;
  importAllFixtures(w.ws);
  const tk = T.createTicket(w.ws, { project_id: pid, assistant: true }).ticket;
  return { ws: w.ws, pid, tk };
}

// The Prosecutor's answer, as a model would write it, with the as_of given.
function answer(ticket, asOf) {
  const b = {
    format: T.FORMAT,
    ticket_id: ticket.ticket_id,
    project_id: ticket.project_id,
    prompt_version: T.PROMPT_VERSION,
    role: 'prosecutor',
    model: 'claude',
    model_version: 'claude-test',
    as_of: asOf,
    researcher_report_id: ticket.basis.researcher.report_id,
    researcher_report_sha256: ticket.basis.researcher.original.sha256,
    prosecution: {
      verdict: 'fatal_flaw',
      conviction_score: 30,
      tests: { mercenary_emissions: { result: 'fail', finding: 'The treasury pays more than fees burn (FICTIONAL).', source_ids: ['S1'] }, tax_revenue: { result: 'pass', finding: '' }, exit_slippage: { result: 'pass', finding: 'Measured.' }, unverified_claims: { result: 'unknown', finding: 'Not checked.' } },
      fatal_flaws: [{ test: 'mercenary_emissions', severity: 'fatal', finding: 'Holders are net diluted (FICTIONAL).', source_ids: ['S1'] }],
      strongest_bull_rebuttal: 'Fee switch broadens next year.',
    },
    proposal: {
      proposal_type: 'WATCH_ONLY',
      non_consensus_thesis: 'The market reads the fee burn as accrual; the treasury grant outweighs it; two months of revenue above the grant would show otherwise.',
      invalidation_trigger: { statement: 'Upgrade on two months of revenue above the grant.' },
    },
    agent_disagreement_note: 'The researcher grades 60.5; I score 30 on dilution.',
    sources: [{ source_id: 'S1', url: 'https://example.com/xmpl/grant', publisher: 'Example (FICTIONAL)', retrieved_at: new Date().toISOString(), excerpt: 'fictional' }],
  };
  return `# Prosecution (FICTIONAL)\n\n${'The four tests and the flaws, written out for the test fixture. '.repeat(12)}\n\n\`\`\`json\n${JSON.stringify(b, null, 2)}\n\`\`\`\n`;
}

const ahead = (ms) => new Date(Math.floor((Date.now() + ms) / 1000) * 1000).toISOString();

test('an as_of 19 minutes ahead is saved as the time of saving; the receipt keeps what was written and the message says so', (t) => {
  const s = ticketOf(t);
  const written = ahead(19 * MIN);
  const out = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: s.tk.ticket_id, text: answer(s.tk, written) });
  assert.equal(out.status, 'saved');
  assert.equal(out.verified, true);
  const r = out.receipt;
  assert.match(r.receipt_id, /^tr_/);
  assert.equal(r.as_of, r.saved_at, 'recorded as the time of saving, never in the future');
  assert.deepEqual(r.as_of_clamped, { written, recorded: r.saved_at });
  assert.match(out.message, /was after the save; the receipt records the time of saving/);
  assert.equal(r.desk.proposal_type, 'WATCH_ONLY');
  const back = T.listReceipts(s.ws, s.pid).find((x) => x.receipt_id === r.receipt_id);
  assert.deepEqual(back.as_of_clamped, r.as_of_clamped, 'the note is on the saved receipt');
  assert.equal(T.nextStep(s.ws, s.pid).step, 'pm_review');
});

test('29 minutes ahead is still saved; a past as_of is kept as written with no clamp note', (t) => {
  const s = ticketOf(t);
  const out = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: s.tk.ticket_id, text: answer(s.tk, ahead(29 * MIN)) });
  assert.equal(out.status, 'saved');
  assert.ok(out.receipt.as_of_clamped);

  const p = ticketOf(t);
  const past = new Date(Math.floor(Date.now() / 1000) * 1000 - 1000).toISOString();
  const kept = T.saveTicket(p.ws, { project_id: p.pid, ticket_id: p.tk.ticket_id, text: answer(p.tk, past) });
  assert.equal(kept.status, 'saved');
  assert.equal(kept.receipt.as_of, past);
  assert.equal('as_of_clamped' in kept.receipt, false, 'no note when nothing was clamped');
  assert.doesNotMatch(kept.message, /was after the save/);
});

test('more than 30 minutes ahead is refused; nothing is saved, the text is kept as the draft and the refusal names as_of', (t) => {
  const s = ticketOf(t);
  const text = answer(s.tk, ahead(31 * MIN));
  assert.throws(() => T.saveTicket(s.ws, { project_id: s.pid, ticket_id: s.tk.ticket_id, text }), (e) => e.code === 'INVALID' && /after the time of saving by more than 30 minutes/.test(e.message));
  assert.equal(T.listReceipts(s.ws, s.pid).filter((r) => r.ticket_id === s.tk.ticket_id).length, 0, 'no receipt');
  const job = T.loadTicket(s.ws, s.pid, s.tk.ticket_id).job;
  assert.equal(job.last_refusal.field, 'as_of');
  assert.equal(fs.readFileSync(s.ws.abs(`projects/${s.pid}/tickets/${s.tk.ticket_id}/drafts/prosecutor.md`), 'utf8'), text, 'the draft is the text as sent');
  // The same answer within the window is then saved: the draft is not lost.
  const again = T.saveTicket(s.ws, { project_id: s.pid, ticket_id: s.tk.ticket_id, text: answer(s.tk, ahead(5 * MIN)) });
  assert.equal(again.status, 'saved');
});

test('the online worker saves a clamped ticket, releases the claim and says the clamp back to the runner', async (t) => {
  const PC = require('../core/pilot-claims');
  const PW = require('../core/pilot-worker');
  const TF = require('./trader-fixture');
  const { mandateDesk } = require('./mandate-fixture');
  const s = mandateDesk(t, { mandate: false });
  const prof = s.ws.abs(`projects/${s.pid}/tickets/profile.json`);
  fs.mkdirSync(require('path').dirname(prof), { recursive: true });
  fs.writeFileSync(prof, JSON.stringify({ schema_version: 'cr.ticket-profile.v1', project_id: s.pid, pilot: true }));
  const c = PW.claimStep(s.ws, s.pid, { owner: 'unit' });
  const p = await PW.prepare(s.ws, s.pid, c.token, { fetchImpl: async () => { throw new Error('FICTIONAL: no network'); } });
  assert.equal(p.status, 'prepared');
  const written = ahead(19 * MIN);
  const plain = TF.answer(T.loadTicket(s.ws, s.pid, p.ticket_id));
  const text = plain.replace(`"as_of": "${TF.AT}"`, `"as_of": "${written}"`);
  assert.notEqual(text, plain, 'the fixture\'s as_of was moved ahead');
  const done = PW.complete(s.ws, s.pid, c.token, { text, prompt_sha256: p.prompt_sha256 });
  assert.equal(done.status, 'saved');
  assert.equal(done.verified, true);
  assert.match(done.words, new RegExp(`as_of ${written} was after the save`));
  assert.equal(PC.read(s.ws, s.pid).released, true);
  const r = T.listReceipts(s.ws, s.pid).find((x) => x.receipt_id === done.receipt_id);
  assert.equal(r.as_of_clamped.written, written);
});
