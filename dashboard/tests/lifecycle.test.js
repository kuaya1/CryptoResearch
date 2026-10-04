'use strict';
// Project lifecycle (archive, Undo/Restore), a model on hold, and manual
// research that stalls (2026-10-04, from the Codex and Fable reviews).
// Fictional workspaces only; no model or market API is called.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { tempWorkspace, addFixtureProject, hashTree } = require('./helpers');
const { makeMcp } = require('../mcp');
const projects = require('../core/projects');
const research = require('../core/research');
const portfolio = require('../core/portfolio');
const market = require('../core/market');
const indexer = require('../core/indexer');
const inbox = require('../core/inbox');
const { runOp } = require('../core/ops');
const { mockReport } = require('../core/demo');
const { readJson, atomicWrite, jsonText } = require('../core/fsx');
const { openWorkspace } = require('../core/workspace');

const PID = 'example-payfi-fictional';

async function call(ws, assistant, name, args) {
  const handle = makeMcp(ws, {});
  const req = Readable.from([Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }))]);
  req.method = 'POST';
  let body = '';
  await handle(req, { writeHead() {}, end(s) { body = s || ''; } }, { assistant, client_name: `FICTIONAL ${assistant}` });
  const r = JSON.parse(body).result;
  return { ...r, data: r.structuredContent || null, text: r.content.map((c) => c.text).join('\n') };
}

function patchJob(ws, runId, provider, patch) {
  runOp(ws, { type: 'test_job_state', summary: 'FICTIONAL job state' }, (op) => {
    const rel = `projects/${PID}/research/${runId}/run.json`;
    const r = op.readJson(rel);
    Object.assign(r.jobs[provider], patch);
    op.writeJson(rel, r);
  });
}

test('archive: hides the project, keeps everything; unsent work is held, sent work can finish; a held token keeps its price; Restore brings back the same project as it was and sends nothing', async (t) => {
  const { ws, cleanup } = tempWorkspace('life-archive');
  t.after(cleanup);
  addFixtureProject(ws);
  // Two reports, eight fictional transactions holding 9,490 XMPL, a queued
  // (never sent) API job and one already sent and running in the background.
  const run = research.createRun(ws, { project_id: PID, providers: ['claude', 'chatgpt', 'gemini'], channel: 'dashboard' }).run;
  for (const p of ['claude', 'chatgpt']) assert.equal(inbox.importContent(ws, p, { content: mockReport(ws, p, run), projectId: PID, runId: run.run_id }).result.status, 'ingested');
  const run2 = research.createRun(ws, { project_id: PID, providers: ['chatgpt', 'gemini'], channel: 'dashboard', force_new: true }).run;
  patchJob(ws, run2.run_id, 'chatgpt', { state: 'queued', mode: 'api', model: 'FICTIONAL' });
  patchJob(ws, run2.run_id, 'gemini', { state: 'dispatching', mode: 'api', model: 'FICTIONAL', attempts: [{ n: 1, attempt_id: 'att_fictional', phase: 'submitted', provider_request_id: 'FICTIONAL-sent' }] });
  portfolio.addAccount(ws, { name: 'FICTIONAL exchange', kind: 'exchange' });
  const acct = portfolio.loadAccounts(ws)[0].account_id;
  const txs = [1000, 2000, 1500, 990, 3000, 500, 300, 200].map((q, i) => ({ type: 'buy', date: `2026-09-${String(10 + i).padStart(2, '0')}`, account_id: acct, asset_id: 'example-payfi-fictional', quantity: String(q), price_usd: '0.01' }));
  portfolio.addTransactions(ws, txs, { source: 'test' });
  const txBefore = fs.readFileSync(ws.abs('portfolio/transactions.json'), 'utf8');
  const reportsBefore = hashTree(ws.abs(`projects/${PID}/reports`));
  assert.ok(market.trackedIds(ws).includes('example-payfi-fictional'));

  const out = projects.archiveProject(ws, PID, 'FICTIONAL: not following it now');
  assert.equal(out.status, 'archived');
  assert.deepEqual(out.held_jobs, [{ run_id: run2.run_id, provider: 'chatgpt' }]);
  assert.deepEqual(out.sent_jobs, [{ run_id: run2.run_id, provider: 'gemini', state: 'dispatching' }]);
  const p = projects.getProject(ws, PID);
  assert.equal(p.status, 'archived');
  assert.equal(p.watchlist.on_watchlist, false);
  assert.deepEqual([p.archive.prior_status, p.archive.prior_on_watchlist, p.archive.reason], ['active', true, 'FICTIONAL: not following it now']);
  // Nothing removed: reports byte for byte, transactions unchanged, the holding in Portfolio, its price still fetched.
  assert.deepEqual(hashTree(ws.abs(`projects/${PID}/reports`)), reportsBefore);
  assert.equal(fs.readFileSync(ws.abs('portfolio/transactions.json'), 'utf8'), txBefore);
  const pos = portfolio.computePortfolio(ws, { market: market.readLatest(ws) }).positions.find((x) => x.asset_id === 'example-payfi-fictional');
  assert.equal(pos.quantity_exact, '9490');
  assert.ok(market.trackedIds(ws).includes('example-payfi-fictional'), 'a held token keeps getting prices');
  // Never-sent work is held: not due, never sent. Sent work is still collected.
  const job = research.loadRun(ws, PID, run2.run_id).jobs.chatgpt;
  assert.deepEqual([job.state, job.hold.why], ['queued', 'archived']);
  assert.equal(research.hasBackgroundWork(ws), true, 'the request already sent is still checked and collected');
  const due = [];
  await research.runDueJobs(ws, { fetchImpl: async (url) => { due.push(String(url)); throw new Error('FICTIONAL: no network'); } });
  assert.equal(research.loadRun(ws, PID, run2.run_id).jobs.chatgpt.state, 'queued', 'the held job was not sent');
  assert.ok(!due.some((u) => /openai/.test(u)), 'nothing sent for the held job');
  // Out of the watchlist and the waiting queues; its research reminders stop,
  // but a possibly billed request stays in view.
  assert.deepEqual(research.pendingFor(ws, 'gemini').filter((x) => x.project_id === PID), []);
  assert.throws(() => research.createRun(ws, { project_id: PID, providers: ['claude'] }), /archived/);
  assert.throws(() => research.retryJob(ws, PID, run2.run_id, 'chatgpt'), /archived\. Restore it/);
  patchJob(ws, run2.run_id, 'gemini', { state: 'uncertain' });
  const idx = indexer.buildIndex(ws);
  assert.ok(idx.attention.some((a) => a.kind === 'research_uncertain' && a.project_id === PID && /archived project/.test(a.title)), 'billing obligations stay visible');
  assert.ok(!idx.attention.some((a) => a.kind === 'research_waiting' && a.project_id === PID));
  // Re-adding the same identity offers restoration; nothing duplicated or quietly changed.
  const again = projects.addProject(ws, { name: 'Example PayFi (FICTIONAL)', official_website: 'https://example.com/xmpl', coingecko_id: 'example-payfi-fictional', evidence: [{ url: 'https://example.com/xmpl' }] });
  assert.equal(again.status, 'archived');
  assert.equal(again.project_id, PID);
  assert.match(again.message, /archived on \d{4}-\d{2}-\d{2}\. Nothing was added or changed\. Restore it/);
  assert.equal(projects.getProject(ws, PID).watchlist.on_watchlist, false);
  assert.equal(projects.listProjects(ws).length, 1);
  // Restore: the same ID and history, watching again as before, nothing sent.
  const back = projects.restoreProject(ws, PID);
  assert.equal(back.status, 'restored');
  assert.equal(back.on_watchlist, true);
  assert.deepEqual(back.held_jobs.map((j) => j.provider), ['chatgpt']);
  const r2 = projects.getProject(ws, PID);
  assert.deepEqual([r2.status, r2.watchlist.on_watchlist, r2.archive], ['active', true, undefined]);
  assert.equal(r2.archive_history.length, 1);
  assert.equal(r2.archive_history[0].reason, 'FICTIONAL: not following it now');
  assert.equal(research.loadRun(ws, PID, run2.run_id).jobs.chatgpt.state, 'queued');
  assert.ok(research.loadRun(ws, PID, run2.run_id).jobs.chatgpt.hold, 'still held after the restore: nothing restarts by itself');
  assert.deepEqual(hashTree(ws.abs(`projects/${PID}/reports`)), reportsBefore);
  assert.equal(projects.restoreProject(ws, PID).status, 'unchanged', 'a repeated Restore changes nothing');
  // Eric's explicit retry is the go-ahead (here without an API: back to waiting).
  research.retryJob(ws, PID, run2.run_id, 'chatgpt');
  const retried = research.loadRun(ws, PID, run2.run_id).jobs.chatgpt;
  assert.equal(retried.hold, undefined);
  // A project archived while not watched comes back not watched.
  projects.setWatchlist(ws, PID, false);
  projects.archiveProject(ws, PID, 'FICTIONAL again');
  assert.equal(projects.restoreProject(ws, PID).on_watchlist, false);
  assert.equal(projects.getProject(ws, PID).archive_history.length, 2);
});

test('archive and restore through the connector: Cowork can do both when Eric asks; an archived project starts nothing', async (t) => {
  const { ws, cleanup } = tempWorkspace('life-mcp');
  t.after(cleanup);
  addFixtureProject(ws);
  const run = research.createRun(ws, { project_id: PID, providers: ['chatgpt'], channel: 'dashboard' }).run;
  patchJob(ws, run.run_id, 'chatgpt', { state: 'dispatching', mode: 'api', model: 'FICTIONAL', attempts: [{ n: 1, attempt_id: 'att_f', phase: 'submitted' }] });
  const a = await call(ws, 'claude', 'archive_project', { project_id: PID, owner_request: 'archive Example PayFi (FICTIONAL)' });
  assert.equal(a.data.status, 'archived', a.text);
  assert.match(a.data.message, /ChatGPT \(dispatching\) was already sent to a paid model: it may still finish, be saved and be billed\./);
  assert.equal((await call(ws, 'claude', 'archive_project', { project_id: PID, owner_request: 'again' })).data.status, 'unchanged');
  const s = await call(ws, 'claude', 'start_research', { project_id: PID, owner_request: 'research it' });
  assert.equal(s.isError, true);
  assert.match(s.text, /is archived\. Ask Eric whether to restore it/);
  const add = await call(ws, 'claude', 'add_project', { name: 'Example PayFi (FICTIONAL)', official_website: 'https://example.com/xmpl', evidence: [{ url: 'https://example.com/xmpl' }], owner_request: 'add it' });
  assert.equal(add.data.status, 'archived');
  assert.match(add.data.message, /call restore_project/);
  const r = await call(ws, 'claude', 'restore_project', { project_id: PID, owner_request: 'bring it back' });
  assert.equal(r.data.status, 'restored', r.text);
  assert.match(r.data.message, /back on the watchlist\. Nothing was started or sent\./);
  const missing = await call(ws, 'claude', 'archive_project', { project_id: PID });
  assert.equal(missing.isError, true, 'only when Eric asked, in his words');
});

test('a model on hold, through the connector: "all three" leaves it out and says so; its own connection gets nothing new; a job it already took can still be saved', async (t) => {
  const { ws: w0, root, cleanup } = tempWorkspace('life-hold');
  t.after(cleanup);
  addFixtureProject(w0);
  // Gemini took a job before the hold.
  const before = research.createRun(w0, { project_id: PID, providers: ['gemini'], channel: 'dashboard' }).run;
  research.adoptJob(w0, PID, before.run_id, 'gemini');
  const file = path.join(root, 'config', 'settings.json');
  const s = readJson(file);
  s.research = { ...(s.research || {}), on_hold: { gemini: { since: '2026-10-04', reason: 'FICTIONAL milestone hold.' } } };
  atomicWrite(file, jsonText(s));
  const ws = openWorkspace({ root, actor: 'test' });
  const all = await call(ws, 'claude', 'start_research', { project_id: PID, owner_request: 'Research it with all three models (FICTIONAL)', models: 'all', refresh: true });
  assert.equal(all.data.status, 'created', all.text);
  assert.deepEqual(Object.keys(all.data.run.jobs).sort(), ['chatgpt', 'claude'], 'no Gemini job in the new run');
  assert.deepEqual(all.data.on_hold, ['gemini']);
  assert.match(all.data.message, /Gemini is on hold on this desk and was not added; nothing new is assigned to it\./);
  assert.equal(all.data.readiness.models.gemini.status, 'on_hold');
  const pend = await call(ws, 'gemini', 'pending_research', {});
  assert.equal(pend.data.status, 'on_hold');
  assert.deepEqual(pend.data.pending, []);
  assert.match(pend.data.message, /Gemini is on hold on this desk since 2026-10-04/);
  // Its own job, taken before the hold, is saved normally (work is not lost).
  const saved = await call(ws, 'gemini', 'save_report', { project_id: PID, run_id: before.run_id, report_markdown: mockReport(ws, 'gemini', before) });
  assert.equal(saved.data.status, 'saved', saved.text);
});

test('Settings: a hold is put on with today\'s date and a reason, and lifted with null; nothing else is accepted for it', () => {
  const { validateSettingsPatch } = require('../server');
  const lift = validateSettingsPatch({ research: { on_hold: { gemini: null } } });
  assert.deepEqual(lift.research.on_hold, { gemini: null });
  const put = validateSettingsPatch({ research: { on_hold: { chatgpt: { reason: 'FICTIONAL pause' } } } });
  assert.match(put.research.on_hold.chatgpt.since, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(put.research.on_hold.chatgpt.reason, 'FICTIONAL pause');
  assert.deepEqual(validateSettingsPatch({ research: { on_hold: { someone: true } } }).research.on_hold, {}, 'only the three models');
});

test('stale manual claims: after a day without activity the claim is released back to waiting, drafts and history kept, nothing sent; the same model resumes from its draft', async (t) => {
  const { ws, cleanup } = tempWorkspace('life-stale');
  t.after(cleanup);
  addFixtureProject(ws);
  const run = research.createRun(ws, { project_id: PID, providers: ['chatgpt'], channel: 'dashboard' }).run;
  research.adoptJob(ws, PID, run.run_id, 'chatgpt', { client: 'FICTIONAL ChatGPT' });
  research.saveAssistantDraft(ws, PID, run.run_id, { text: '## 1. Legitimacy\nFICTIONAL draft.\n', note: 'section 1', provider: 'chatgpt' });
  const draftAt = research.loadRun(ws, PID, run.run_id).jobs.chatgpt.draft_saved_at;
  // 30 minutes idle: paused (interrupted), not released.
  const t0 = Date.parse(draftAt);
  assert.equal(research.assistantActivity(research.loadRun(ws, PID, run.run_id).jobs.chatgpt, run, t0 + 31 * 60000).interrupted, true);
  assert.deepEqual(research.releaseStaleAssistantJobs(ws, t0 + 2 * 3600000), []);
  // A day idle: released, with its draft and history.
  assert.equal(research.hasDueWork(ws, t0 + 25 * 3600000), true, 'the runner picks it up');
  const sent = [];
  const out = await research.runDueJobs(ws, { now: t0 + 25 * 3600000, fetchImpl: async (u) => { sent.push(u); throw new Error('FICTIONAL'); } });
  assert.deepEqual(out.released, [{ project_id: PID, run_id: run.run_id, provider: 'chatgpt' }]);
  assert.equal(sent.length, 0, 'nothing sent anywhere');
  const job = research.loadRun(ws, PID, run.run_id).jobs.chatgpt;
  assert.deepEqual([job.state, job.mode], ['unconfigured', 'manual']);
  assert.equal(job.released.length, 1);
  assert.equal(job.released[0].draft_saved_at, draftAt);
  assert.equal(job.draft_saved_at, draftAt);
  assert.match(job.note, /Released back to waiting .* Its draft from .* is kept/);
  assert.equal(research.readAssistantDraft(ws, PID, run.run_id, 'chatgpt'), '## 1. Legitimacy\nFICTIONAL draft.\n');
  // ChatGPT asked to resume: its waiting job with the draft, the same run.
  const view = await call(ws, 'chatgpt', 'get_research', { project_id: PID, run_id: run.run_id });
  assert.equal(view.data.run.draft, '## 1. Legitimacy\nFICTIONAL draft.\n');
  assert.equal(view.data.run.jobs.chatgpt.state, 'unconfigured');
  // A paid API job is never released, whatever its age.
  const api = research.createRun(ws, { project_id: PID, providers: ['gemini'], channel: 'dashboard', force_new: true }).run;
  patchJob(ws, api.run_id, 'gemini', { state: 'dispatching', mode: 'api', updated_at: '2026-01-01T00:00:00Z', attempts: [{ n: 1, attempt_id: 'att_old', phase: 'submitted' }] });
  assert.deepEqual(research.releaseStaleAssistantJobs(ws, Date.now() + 30 * 86400000).filter((x) => x.provider === 'gemini'), []);
});
