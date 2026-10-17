'use strict';
// The review agenda (cr-review-agenda@1): one primary next action per
// project with why it is due, its source and its basis; Eric's complete,
// snooze and reopen, replay-safe. Fictional workspaces only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempWorkspace, hashTree, FIXTURES } = require('./helpers');
const { openWorkspace } = require('../core/workspace');
const F = require('../core/forensics');
const A = require('../core/forensic-agenda');
const B = require('../core/forensic-disagreements');
const FX = require('./forensic-fixtures');

const DAY = 86400000;
const NET = 'example-network-fictional';
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

// A fictional project with a v5 Claude report (it suggests a review on
// 2026-11-21, horizon to 2027-02-03), and a forensic assessment that
// ChatGPT challenged (one disagreement, on F3).
function agendaSetup(label) {
  const t = tempWorkspace(label);
  require('../core/projects').addProject(t.ws, { name: 'Example Network (FICTIONAL)', symbol: 'XNET', official_website: 'https://example.net/xnet', assets: [{ chain: 'example-chain', contract_address: 'FICTIONAL-CONTRACT-XNET' }], evidence: [{ url: 'https://example.net/xnet/docs', note: 'fictional test evidence' }], sector: 'ai_data' });
  const imp = require('../core/inbox').importContent(t.ws, 'claude', { content: fs.readFileSync(path.join(FIXTURES, 'reports', `${NET}__claude.v5.md`), 'utf8'), projectId: NET });
  assert.equal(imp.result.status, 'ingested', imp.result.message);
  const a = F.createAudit(t.ws, { project_id: NET, assistant: 'claude', challenge: true });
  const s = F.saveReport(t.ws, { project_id: NET, audit_id: a.audit_id, provider: 'claude', text: FX.reportText(a.audit) });
  const c = F.saveReport(t.ws, { project_id: NET, audit_id: a.audit_id, provider: 'chatgpt', text: FX.challengeText(F.loadAudit(t.ws, NET, a.audit_id), s.receipt) });
  return { ...t, s, c, report_id: imp.result.report_id };
}

const rowFor = (ag) => ag.rows.find((r) => r.project_id === NET);
const all = (row) => [...row.due, ...row.upcoming, ...row.undated];

test('agenda: one primary action with why, its source and basis; reading writes nothing and asks nothing', (t) => {
  const x = agendaSetup('ag-read');
  t.after(x.cleanup);
  const before = hashTree(path.join(x.root, 'projects'));
  const real = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; throw new Error('off'); };
  let ag;
  try { ag = A.agenda(x.ws); } finally { global.fetch = real; }
  assert.equal(calls, 0, 'no provider, model or notification');
  assert.deepEqual(hashTree(path.join(x.root, 'projects')), before, 'reading the agenda writes nothing');
  assert.equal(ag.read_only, true);
  const row = rowFor(ag);
  const p = row.primary;
  assert.equal(p.kind, 'disagreement', 'what waits on Eric\'s judgment comes before dated reviews');
  assert.equal(p.due, true);
  assert.equal(p.basis, 'sourced');
  assert.equal(p.basis_words, 'Sourced');
  assert.equal(p.support.receipt_id, x.c.receipt_id);
  assert.equal(p.support.assessment_receipt_id, x.s.receipt_id);
  assert.match(p.why, /reviewed finding F3 as overstated/);
  const review = all(row).find((i) => i.kind === 'model_review');
  assert.equal(review.support.report_id, x.report_id);
  assert.match(review.title, /2026-11-21/);
  assert.match(review.why, /not your calendar/);
  const end = all(row).find((i) => i.kind === 'horizon_end');
  assert.match(end.title, /2027-02-03/);
  const cp = all(row).filter((i) => i.kind === 'checkpoint');
  assert.ok(cp.length >= 1 && cp.every((i) => i.support.receipt_id === x.s.receipt_id && i.basis === 'sourced'));
  for (const i of all(row)) assert.ok(['sourced', 'conditional', 'owner'].includes(i.basis), i.kind);
});

test('agenda: judging the disagreement moves the agenda on; Eric\'s own review date is his choice', (t) => {
  const x = agendaSetup('ag-judge');
  t.after(x.cleanup);
  const id = F.view(x.ws, NET).disagreements.items[0].disagreement_id;
  B.judge(x.ws, NET, { disagreement_id: id, judgment: 'unresolved', reason: 'Waiting for the tagged audit (FICTIONAL).' });
  assert.equal(rowFor(A.agenda(x.ws)).primary.kind, 'disagreement', 'unresolved is still open');
  B.judge(x.ws, NET, { disagreement_id: id, judgment: 'challenge_accepted', reason: 'The substance is not shown (FICTIONAL).' });
  const row = rowFor(A.agenda(x.ws));
  assert.ok(!all(row).some((i) => i.kind === 'disagreement'));
  require('../core/notes').addEvent(x.ws, NET, { type: 'review', title: 'Recheck the thesis (FICTIONAL)', due: ymd(Date.now() + 5 * DAY) });
  const own = all(rowFor(A.agenda(x.ws))).find((i) => i.kind === 'owner_review');
  assert.equal(own.basis, 'owner');
  assert.equal(own.basis_words, 'Your choice');
  assert.match(own.why, /You set this review/);
});

test('agenda: a snooze survives a reload and ends on its date; completion is replay-safe and stays', (t) => {
  const x = agendaSetup('ag-act');
  t.after(x.cleanup);
  const first = rowFor(A.agenda(x.ws)).primary;
  const until = ymd(Date.now() + 3 * DAY);
  assert.throws(() => A.act(x.ws, NET, { item_id: first.item_id, action: 'snooze', until: '2020-01-01' }), (e) => e.code === 'INVALID');
  assert.throws(() => A.act(x.ws, NET, { item_id: 'ag_0000000000000000', action: 'complete' }), (e) => e.code === 'NOT_FOUND');
  assert.equal(A.act(x.ws, NET, { item_id: first.item_id, action: 'snooze', until, request_id: 'req-fictional-ag-1' }).result.status, 'saved');
  // A fresh process reading the same folder.
  const again = openWorkspace({ root: x.root, actor: 'test' });
  const row = rowFor(A.agenda(again));
  assert.notEqual(row.primary && row.primary.item_id, first.item_id, 'the snoozed item steps aside');
  assert.equal(row.snoozed[0].item_id, first.item_id);
  assert.equal(row.snoozed[0].snoozed.until, until);
  assert.equal(rowFor(A.agenda(again, { now: Date.parse(`${until}T23:59:59Z`) + 1000 })).primary.item_id, first.item_id, 'back once the snooze ends');
  // Complete the next one, a lost response retried and a double click.
  const next = row.primary;
  assert.equal(A.act(again, NET, { item_id: next.item_id, action: 'complete', request_id: 'req-fictional-ag-2' }).result.status, 'saved');
  assert.equal(A.act(again, NET, { item_id: next.item_id, action: 'complete', request_id: 'req-fictional-ag-2' }).result.status, 'unchanged');
  assert.equal(A.act(again, NET, { item_id: next.item_id, action: 'complete', request_id: 'req-fictional-ag-3' }).result.status, 'unchanged');
  assert.equal(A.readActions(again, NET).length, 2);
  const done = rowFor(A.agenda(again));
  assert.ok(done.completed.some((i) => i.item_id === next.item_id));
  assert.ok(!all(done).some((i) => i.item_id === next.item_id));
  // Reopen puts it back; the lines stay.
  A.act(again, NET, { item_id: next.item_id, action: 'reopen' });
  assert.ok(!rowFor(A.agenda(again)).completed.some((i) => i.item_id === next.item_id));
  assert.equal(A.readActions(again, NET).length, 3);
  const proj = require('../core/exporter').exportJson(again).projects.find((p) => p.project.project_id === NET);
  assert.equal(proj.forensics.agenda_actions.length, 3);
});

test('agenda: browsing an earlier receipt does not change it; it reads the latest receipt', (t) => {
  const x = agendaSetup('ag-history');
  t.after(x.cleanup);
  const a2 = F.createAudit(x.ws, { project_id: NET, assistant: 'claude', refresh: true });
  const s2 = F.saveReport(x.ws, { project_id: NET, audit_id: a2.audit_id, provider: 'claude', text: FX.reportText(a2.audit, { plain_assessment: 'FICTIONAL. A later assessment.' }) });
  const strip = (ag) => JSON.stringify({ ...ag, generated_at: null });
  const now = Date.now();
  const before = strip(A.agenda(x.ws, { now }));
  F.view(x.ws, NET, { receipt: x.s.receipt_id, now });
  assert.equal(strip(A.agenda(x.ws, { now })), before);
  const cps = all(rowFor(A.agenda(x.ws, { now }))).filter((i) => i.kind === 'checkpoint');
  assert.ok(cps.length && cps.every((i) => i.support.receipt_id === s2.receipt_id), 'the checkpoints of the latest receipt');
  assert.ok(!all(rowFor(A.agenda(x.ws, { now }))).some((i) => i.kind === 'disagreement'), 'the latest receipt has no challenge yet');
});

test('agenda: a receipt that disagrees with its original is the first thing to check', (t) => {
  const x = agendaSetup('ag-integrity');
  t.after(x.cleanup);
  const file = x.ws.abs(F.receiptRel(NET, x.s.receipt_id));
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  r.assessment.plain_assessment = 'FICTIONAL TAMPER';
  require('../core/fsx').atomicWrite(file, require('../core/fsx').jsonText(r));
  const p = rowFor(A.agenda(x.ws)).primary;
  assert.equal(p.kind, 'integrity');
  assert.match(p.why, /does not agree with its verified original/);
});
