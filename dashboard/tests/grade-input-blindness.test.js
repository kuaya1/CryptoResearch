'use strict';
// Input blindness, scoped (blueprint 2026-11-02 §7, build plan row 11): the
// inputs to new research and to prosecution carry no evaluation or outcome
// material. Canaries are planted where outcomes and other opinions live (a
// decision's note and its basis, the PM Cohort position, the Trader Sim's
// orders, a forensic outcome note, another model's report) and none may reach
// a research prompt or packet, a Prosecutor prompt or packet, or the mandate,
// admission and rubric inputs the desk computes.
//
// This proves those code paths only. It cannot prove a model never meets an
// outcome on the open web. FICTIONAL temporary workspaces only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const T = require('../core/tickets');
const TD = require('../core/trader-desk');
const research = require('../core/research');
const { withExitReadings, freshPrice, cancelOpenJobs } = require('./helpers');
const { mandateDesk, saveTicket, mandateArgs } = require('./mandate-fixture');
const { H, iso, settle, bar } = require('./trader-fixture');

const NOTE = 'CANARY-DECISION-NOTE-7f3a';
const OTHER_MODEL = 'CANARY-OTHER-MODEL-91be';
const OUTCOME_NOTE = 'CANARY-OUTCOME-NOTE-c2d4';

function filesUnder(root, dir) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(abs);
  return out;
}
const textOf = (files) => files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

test('no outcome, evaluation or other model\'s opinion reaches a research or Prosecutor input, or the mandate, admission and rubric inputs', (t) => {
  const s = mandateDesk(t, { grade: 60 });
  const { ws, pid } = s;
  const root = ws.root;

  // --- Plant the canaries -------------------------------------------------
  // Another model's opinion: ChatGPT's report says the canary in its own words.
  const reports = require('../core/reports').loadReports(ws, pid);
  const gpt = reports.find((r) => !r.broken && r.meta.provider === 'chatgpt');
  assert.ok(gpt, 'the fixture has a ChatGPT report');
  const gptFile = ws.abs(`${gpt.dir}/report.json`);
  const gptRec = JSON.parse(fs.readFileSync(gptFile, 'utf8'));
  gptRec.assessment.summary = `${OTHER_MODEL} ${gptRec.assessment.summary || ''}`;
  gptRec.assessment.verdict_reason = OTHER_MODEL;
  fs.writeFileSync(gptFile, JSON.stringify(gptRec, null, 2));

  // A first ticket, Eric's approve with a note, filled into both paper books.
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

  // Outcome identifiers: the PM Cohort position, the trader's order and
  // position, the decision and its basis.
  const pmPosition = ap.result.paper.position_id;
  const intentId = TD.intentIdOf(d1, 'open');
  const outcomeIds = [d1.decision_id, pmPosition, intentId, `cr2-${intentId}`, `pos-${intentId}`];
  // A forensic outcome note (the outcome register's notes, Eric's words).
  const notesFile = ws.abs(`projects/${pid}/forensics/outcome-notes.jsonl`);
  fs.mkdirSync(path.dirname(notesFile), { recursive: true });
  fs.appendFileSync(notesFile, `${JSON.stringify({ at: new Date().toISOString(), note: OUTCOME_NOTE })}\n`);

  // Each canary is where it should be, so its absence below means something.
  const desk = textOf(filesUnder(root, 'projects').concat(filesUnder(root, 'paper')).filter((f) => !f.includes(`${path.sep}backups${path.sep}`)));
  for (const c of [NOTE, OTHER_MODEL, OUTCOME_NOTE, ...outcomeIds]) assert.ok(desk.includes(c), `planted: ${c}`);
  assert.ok(fs.existsSync(ws.abs(`projects/${pid}/tickets/basis/${d1.decision_id}.json`)), 'the decision basis is on record');
  const canaries = [NOTE, OTHER_MODEL, OUTCOME_NOTE, ...outcomeIds];
  const clean = (what, text) => { for (const c of canaries) assert.ok(!text.includes(c), `${what} carries ${c}`); };
  // The check itself catches a canary (a negative control).
  for (const c of canaries) assert.throws(() => clean('control', `x ${c} y`));

  // --- New research ---------------------------------------------------------
  cancelOpenJobs(ws, pid);
  const run = research.createRun(ws, { project_id: pid, providers: ['claude'], channel: 'dashboard', force_new: true }).run;
  const runDir = path.dirname(ws.abs(run.prompt.path));
  const runFiles = filesUnder(root, path.relative(root, runDir));
  assert.ok(runFiles.some((f) => /prompt/i.test(path.basename(f))) && runFiles.some((f) => /packet/i.test(path.basename(f))), `the run froze its prompt and packet: ${runFiles.map((f) => path.basename(f)).join(', ')}`);
  clean('the research prompt and packet', textOf(runFiles));
  clean('the research run record', JSON.stringify(run));

  // --- A new Prosecutor ticket on the same report ---------------------------
  const created = withExitReadings(1.5, () => T.createTicket(ws, { project_id: pid, assistant: true, refresh: true }));
  assert.ok(created.ticket, `a second ticket opened: ${created.status} ${created.message || ''}`);
  freshPrice(ws, 'example-payfi-fictional', 0.85);
  const tk2 = created.ticket;
  const tkFiles = filesUnder(root, `projects/${pid}/tickets/${tk2.ticket_id}`);
  assert.ok(tkFiles.some((f) => f.endsWith('prompt.md')) && tkFiles.some((f) => f.endsWith('packet.json')), 'the ticket froze its prompt and packet');
  clean('the Prosecutor prompt and packet', textOf(tkFiles));
  const handed = T.loadTicket(ws, pid, tk2.ticket_id);
  clean('the ticket as handed to the Prosecutor', JSON.stringify(handed));

  // --- Admission, rubric and mandate inputs ---------------------------------
  const { answer } = require('./trader-fixture');
  const r2 = T.saveTicket(ws, { project_id: pid, ticket_id: tk2.ticket_id, text: answer(handed, {}, require('./mandate-fixture').CONSISTENT) }).receipt;
  clean('the gate and admission the desk computed', JSON.stringify(r2.desk));
  clean('the researcher grade the gate read', JSON.stringify(r2.researcher));
  const { gradeAssessment } = require('../core/rubrics');
  clean('the rubric\'s grade', JSON.stringify(gradeAssessment(ws, reports.find((r) => r.report_id === r2.researcher.report_id).assessment)));
  // The mandate reads the receipt's own grade and the desk's caps.
  T.decide(ws, pid, { receipt_id: r1.receipt_id, action: 'undo', by: 'eric' });
  T.setAutonomy(ws, pid, { action: 'rearm', request_id: 'req_blind_rearm01', by: 'eric' });
  let mandateLine = null;
  try {
    mandateLine = T.decide(ws, pid, { receipt_id: r2.receipt_id, action: 'approve', request_id: `mandate_${r2.receipt_id}`, mandate: mandateArgs('standard_55_plus', 60) }).result.decision;
  } catch (err) {
    assert.fail(`the mandate could not be exercised: ${err.code} ${err.message}`);
  }
  assert.equal(mandateLine.mandate.grade_used, 60, 'the tier comes from the receipt\'s grade only');
  clean('the mandate\'s decision line', JSON.stringify(mandateLine));
});
