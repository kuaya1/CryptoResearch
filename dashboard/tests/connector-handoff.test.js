'use strict';
// The research handoff for the assistants that work through their own desk
// connection (ChatGPT and Gemini, and Claude where it shares the path), tried
// adversarially on 2026-10-08 against the desk's real handlers: the next task
// and the project Eric names, drafts and claims, interruption and resume, a
// model on hold, saves whose answer is lost, concurrent calls, cut-off and
// mismatched reports, read-only tools, the prompt's delivery, what desk_status
// says per assistant, the connector's log lines, and an access token that
// expires in the middle of a session. Fictional workspaces and reports only;
// no model, market or network is called.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Readable } = require('stream');
const { tempWorkspace, hashTree } = require('./helpers');
const { makeMcp, redactLog } = require('../mcp');
const projects = require('../core/projects');
const research = require('../core/research');
const inbox = require('../core/inbox');
const indexer = require('../core/indexer');
const { runOp } = require('../core/ops');
const { mockReport } = require('../core/demo');
const { readJson, atomicWrite, jsonText } = require('../core/fsx');
const { openWorkspace } = require('../core/workspace');

const KEY_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];
function noKeys(t) {
  const saved = Object.fromEntries(KEY_VARS.map((k) => [k, process.env[k]]));
  for (const k of KEY_VARS) delete process.env[k];
  t.after(() => { for (const k of KEY_VARS) if (saved[k] !== undefined) process.env[k] = saved[k]; });
}

// The connector's handler, called the way the server calls it, for one
// workspace. Each call is one HTTP request from the given model's connection.
function harness(ws, opts = {}) {
  const logs = [];
  const handle = makeMcp(ws, { log: (s) => logs.push(s), ...opts });
  async function rpc(assistant, method, params, body = null) {
    const req = Readable.from([Buffer.from(body !== null ? body : JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))]);
    req.method = 'POST';
    let out = '';
    let status = null;
    await handle(req, { writeHead(s) { status = s; }, end(s) { out = s || ''; } }, { assistant, client_name: `FICTIONAL ${assistant}`, grant_id: `grant_FICTIONAL_${assistant}`, client_id: `crc_FICTIONAL_${assistant}` });
    return { status, json: out ? JSON.parse(out) : null };
  }
  async function call(assistant, name, args) {
    const r = await rpc(assistant, 'tools/call', { name, arguments: args });
    const res = r.json.result;
    return { ...res, data: res.structuredContent || null, text: res.content.map((c) => c.text).join('\n') };
  }
  return { logs, rpc, call };
}

function addProject(ws, n, name, symbol) {
  const out = projects.addProject(ws, {
    name,
    symbol,
    official_website: `https://fictional-${n}.example/`,
    coingecko_id: `fictional-coin-${n}`,
    assets: [{ chain: 'example-chain', contract_address: `FICTIONAL-CONTRACT-${n}` }],
    evidence: [{ url: `https://fictional-${n}.example/docs`, note: 'fictional test evidence' }],
  });
  assert.equal(out.status, 'created', `${name}: ${out.message}`);
  return out.project_id;
}

function patchRun(ws, pid, runId, fn) {
  runOp(ws, { type: 'test_patch_run', summary: 'FICTIONAL run state' }, (op) => {
    const rel = `projects/${pid}/research/${runId}/run.json`;
    const r = op.readJson(rel);
    fn(r);
    op.writeJson(rel, r);
  });
}

function idle(ws, pid, runId, provider, hours) {
  patchRun(ws, pid, runId, (r) => {
    r.jobs[provider].progress_at = new Date(Date.now() - hours * 3600000).toISOString();
    r.jobs[provider].updated_at = r.jobs[provider].progress_at;
  });
}

function setHold(root, provider) {
  const file = path.join(root, 'config', 'settings.json');
  const s = readJson(file);
  s.research = { ...(s.research || {}), on_hold: { [provider]: { since: '2026-10-04', reason: 'FICTIONAL hold for this milestone.' } } };
  atomicWrite(file, jsonText(s));
  return openWorkspace({ root, actor: 'test' });
}

// Three projects, each with a ChatGPT job waiting from the dashboard, oldest first.
function threeWaiting(t, label) {
  noKeys(t);
  const { ws, root, cleanup } = tempWorkspace(label);
  t.after(cleanup);
  const ids = [addProject(ws, 1, 'Alpha Ledger (FICTIONAL)', 'ALPH'), addProject(ws, 2, 'Beta Rails (FICTIONAL)', 'BETA'), addProject(ws, 3, 'Gamma Grid (FICTIONAL)', 'GAMM')];
  const runs = ids.map((pid, i) => {
    const run = research.createRun(ws, { project_id: pid, providers: ['chatgpt'], channel: 'dashboard' }).run;
    patchRun(ws, pid, run.run_id, (r) => { r.created_at = `2026-10-0${6 + i}T10:00:00.000Z`; });
    return research.loadRun(ws, pid, run.run_id);
  });
  return { ws, root, ids, runs };
}

test('handoff: "on <project>" hands ChatGPT that project\'s job and never another; with no project the next task names the exact project, model, run, execution note, prompt and the calls to make; reading writes nothing', async (t) => {
  const { ws, root, ids, runs } = threeWaiting(t, 'handoff-next');
  const h = harness(ws);
  const before = hashTree(root);
  const all = await h.call('chatgpt', 'pending_research', {});
  assert.equal(all.data.status, 'ok', all.text);
  assert.deepEqual(all.data.pending.map((x) => x.project_id), ids, 'every waiting job, oldest first');
  const next = all.data.next;
  assert.equal(next.project_id, ids[0]);
  assert.equal(next.name, 'Alpha Ledger (FICTIONAL)');
  assert.equal(next.model, 'chatgpt');
  assert.equal(next.run_id, runs[0].run_id);
  assert.equal(next.state, 'waiting');
  assert.deepEqual([next.prompt.version, next.prompt.sha256], [runs[0].prompt.version, runs[0].prompt.sha256]);
  assert.deepEqual([next.execution_note.ref, next.execution_note.sha256], ['cr-execution-chatgpt@2', runs[0].jobs.chatgpt.execution.sha256]);
  assert.equal(next.draft, null);
  assert.match(next.next_action, new RegExp(`get_research with project_id "${ids[0]}" and run_id "${runs[0].run_id}".*save_report once with the same project_id and run_id`));
  assert.match(next.say_first, /Alpha Ledger \(FICTIONAL\)/);
  assert.match(all.data.message, /Beta Rails \(FICTIONAL\).*Gamma Grid \(FICTIONAL\)/, 'the others are named, so Eric can pick one');
  // ChatGPT keeps the tool list it read when it connected (until Eric
  // refreshes the app), so it may not know the project parameter: the reply
  // itself says how to do the project Eric named.
  assert.match(all.data.message, /If Eric named a project, do that project instead: call pending_research again with project set to it, or take its project_id and run_id from pending; if it is not in pending, nothing is waiting for it, so say so and do no other project\./);
  // Eric names a project, by name, ticker or ID: that one, only that one.
  for (const q of ['Beta Rails', 'beta', ids[1]]) {
    const one = await h.call('chatgpt', 'pending_research', { project: q });
    assert.equal(one.data.status, 'ok', `${q}: ${one.text}`);
    assert.equal(one.data.next.project_id, ids[1], q);
    assert.deepEqual(one.data.pending.map((x) => x.project_id), [ids[1]], q);
  }
  // A project with nothing waiting for this model, or no such project:
  // nothing is substituted.
  const fourth = addProject(ws, 4, 'Delta Done (FICTIONAL)', 'DELT');
  const before2 = hashTree(root);
  for (const [q, status] of [['Delta Done', 'none_for_project'], ['Omega Nowhere', 'no_match']]) {
    const miss = await h.call('chatgpt', 'pending_research', { project: q });
    assert.equal(miss.data.status, status, miss.text);
    assert.equal(miss.data.next, null, `${q}: no other project is handed out instead`);
    assert.deepEqual(miss.data.pending, []);
    assert.match(miss.data.message, /Alpha Ledger \(FICTIONAL\)/, 'it says what is waiting instead');
  }
  assert.ok(fourth);
  assert.deepEqual(hashTree(root), before2, 'pending_research writes nothing');
  assert.notDeepEqual(before, before2, '(the fourth project was added in between)');
});

test('handoff: a draft from ChatGPT claims its waiting job in one verified save; the desk shows it working, then paused; the next task resumes it with its draft before any older job; the draft is never a report', async (t) => {
  const { ws, ids, runs } = threeWaiting(t, 'handoff-draft');
  const h = harness(ws);
  const pid = ids[2];
  const runId = runs[2].run_id;
  // Reading the prompt takes nothing over.
  const view = await h.call('chatgpt', 'get_research', { project_id: pid, run_id: runId });
  assert.equal(view.isError, false, view.text);
  assert.equal(research.loadRun(ws, pid, runId).jobs.chatgpt.state, 'unconfigured');
  // The first draft claims the job, in the same save.
  const d1 = await h.call('chatgpt', 'save_research_draft', { project_id: pid, run_id: runId, draft_markdown: '## 1. Identity\nFICTIONAL draft, sources dated 2026-10-08.\n', note: 'section 1' });
  assert.equal(d1.isError, false, d1.text);
  assert.equal(d1.data.status, 'draft_saved');
  assert.deepEqual([d1.data.report_saved, d1.data.claimed, d1.data.job_state, d1.data.verified], [false, true, 'running', true]);
  assert.match(d1.data.message, /not a report/i);
  let job = research.loadRun(ws, pid, runId).jobs.chatgpt;
  assert.deepEqual([job.state, job.mode], ['running', 'connector']);
  assert.equal(research.readAssistantDraft(ws, pid, runId, 'chatgpt'), '## 1. Identity\nFICTIONAL draft, sources dated 2026-10-08.\n');
  // A second draft replaces the first; nothing is claimed twice.
  const d2 = await h.call('chatgpt', 'save_research_draft', { project_id: pid, run_id: runId, draft_markdown: '## 1-2\nFICTIONAL longer draft.\n', note: 'sections 1-2' });
  assert.deepEqual([d2.data.status, d2.data.claimed], ['draft_saved', false]);
  // Claude, reading the run, sees ChatGPT working, then paused.
  const cl = await h.call('claude', 'get_research', { project_id: pid, run_id: runId, include_prompt: false });
  assert.match(cl.data.run.jobs.chatgpt.progress, /ChatGPT is researching it/);
  idle(ws, pid, runId, 'chatgpt', 2);
  const paused = await h.call('claude', 'get_research', { project_id: pid, run_id: runId, include_prompt: false });
  assert.match(paused.data.run.jobs.chatgpt.progress, /interrupted \(no activity for \d+ min\)/);
  // The next task is the interrupted one, with its draft, ahead of the older waiting jobs.
  const pend = await h.call('chatgpt', 'pending_research', {});
  assert.equal(pend.data.next.run_id, runId);
  assert.equal(pend.data.next.state, 'interrupted');
  assert.equal(pend.data.next.draft.chars, '## 1-2\nFICTIONAL longer draft.\n'.length);
  assert.match(pend.data.next.next_action, /continue from your draft/i);
  // Resume: get_research without a run gives this run and the draft.
  const resume = await h.call('chatgpt', 'get_research', { project_id: pid });
  assert.equal(resume.data.run.run_id, runId);
  assert.equal(resume.data.run.draft, '## 1-2\nFICTIONAL longer draft.\n');
  // The finished report completes the job; nothing else was started.
  const saved = await h.call('chatgpt', 'save_report', { project_id: pid, run_id: runId, report_markdown: mockReport(ws, 'chatgpt', research.loadRun(ws, pid, runId)) });
  assert.equal(saved.data.status, 'saved', saved.text);
  job = research.loadRun(ws, pid, runId).jobs.chatgpt;
  assert.deepEqual([job.state, job.report_id], ['completed', saved.data.report.report_id]);
  assert.equal(research.listRuns(ws, pid).length, 1, 'no second run');
  assert.equal((await h.call('chatgpt', 'pending_research', {})).data.pending.some((x) => x.run_id === runId), false);
  // A draft for a finished job is refused, and says why.
  const late = await h.call('chatgpt', 'save_research_draft', { project_id: pid, run_id: runId, draft_markdown: 'FICTIONAL late draft' });
  assert.equal(late.isError, true);
  assert.match(late.text, /completed/);
});

test('handoff: a model on hold claims nothing (a draft on a waiting job is refused), its kept jobs are named with the one it had started, and nothing is handed out', async (t) => {
  noKeys(t);
  const { ws: w0, root, cleanup } = tempWorkspace('handoff-hold');
  t.after(cleanup);
  const a = addProject(w0, 1, 'Alpha Ledger (FICTIONAL)', 'ALPH');
  const b = addProject(w0, 2, 'Beta Rails (FICTIONAL)', 'BETA');
  const started = research.createRun(w0, { project_id: a, providers: ['gemini'], channel: 'dashboard' }).run;
  research.adoptJob(w0, a, started.run_id, 'gemini');
  research.saveAssistantDraft(w0, a, started.run_id, { text: '## 1\nFICTIONAL Gemini draft before the hold.\n', provider: 'gemini' });
  idle(w0, a, started.run_id, 'gemini', 3);
  const waiting = research.createRun(w0, { project_id: b, providers: ['gemini'], channel: 'dashboard' }).run;
  const ws = setHold(root, 'gemini');
  const h = harness(ws);
  const pend = await h.call('gemini', 'pending_research', {});
  assert.equal(pend.data.status, 'on_hold');
  assert.deepEqual(pend.data.pending, []);
  assert.equal(pend.data.next, null);
  assert.deepEqual(pend.data.held.map((x) => [x.project_id, x.run_id, x.state]).sort(), [[a, started.run_id, 'interrupted'], [b, waiting.run_id, 'waiting']].sort());
  assert.match(pend.data.message, /Gemini is on hold on this desk since 2026-10-04.*Alpha Ledger \(FICTIONAL\).*draft.*lift the hold in Settings/s);
  const refused = await h.call('gemini', 'save_research_draft', { project_id: b, run_id: waiting.run_id, draft_markdown: '## 1\nFICTIONAL.\n' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /on hold/);
  assert.equal(research.loadRun(ws, b, waiting.run_id).jobs.gemini.state, 'unconfigured', 'nothing claimed');
  // Its own job, taken before the hold, keeps working (nothing new is assigned by it).
  const own = await h.call('gemini', 'save_research_draft', { project_id: a, run_id: started.run_id, draft_markdown: '## 1-2\nFICTIONAL.\n' });
  assert.equal(own.data.status, 'draft_saved', own.text);
  assert.equal((await h.call('gemini', 'start_research', { project_id: b, owner_request: 'research Beta (FICTIONAL)' })).data.status, 'on_hold');
});

test('save: a lost acknowledgement retried returns the same receipt; concurrent identical saves store one report and complete the job once', async (t) => {
  const { ws, ids, runs } = threeWaiting(t, 'handoff-idem');
  const h = harness(ws);
  const pid = ids[0];
  const runId = runs[0].run_id;
  const text = mockReport(ws, 'chatgpt', runs[0]);
  const [x, y] = await Promise.all([
    h.call('chatgpt', 'save_report', { project_id: pid, run_id: runId, report_markdown: text }),
    h.call('chatgpt', 'save_report', { project_id: pid, run_id: runId, report_markdown: text }),
  ]);
  assert.deepEqual([x.data.status, y.data.status].sort(), ['saved', 'unchanged'], `${x.text}\n${y.text}`);
  assert.equal(x.data.report.report_id, y.data.report.report_id);
  const first = x.data.status === 'saved' ? x : y;
  const retry = await h.call('chatgpt', 'save_report', { project_id: pid, run_id: runId, report_markdown: text });
  assert.equal(retry.data.status, 'unchanged');
  const strip = (r) => ({ ...r, status: null });
  assert.deepEqual(strip(retry.data.receipt), strip(first.data.receipt), 'the same receipt');
  assert.deepEqual(retry.data.validation.warnings, first.data.validation.warnings, 'its warnings, not zero');
  const rc = first.data.receipt;
  assert.deepEqual([rc.report_id, rc.run_id, rc.project_id, rc.model, rc.completes_job, rc.job_state, rc.eligible, rc.verified], [first.data.report.report_id, runId, pid, 'chatgpt', true, 'completed', true, true]);
  assert.ok(rc.grade && rc.grade.status, 'its grade or why it is withheld');
  assert.equal(typeof rc.warnings, 'number');
  assert.deepEqual(rc.remaining.other_runs_waiting_for_you.map((r) => r.project_id).sort(), [ids[1], ids[2]].sort(), 'what is still waiting');
  assert.equal(indexer.projectDetail(ws, pid).history.chatgpt.length, 1, 'one report');
  assert.equal(research.loadRun(ws, pid, runId).jobs.chatgpt.report_id, rc.report_id, 'one completion');
});

test('claims: simultaneous start_research calls and simultaneous drafts take a waiting job once, in the same run; a retry resumes it; nothing is sent', async (t) => {
  noKeys(t);
  const { ws, cleanup } = tempWorkspace('handoff-claims');
  t.after(cleanup);
  const pid = addProject(ws, 1, 'Alpha Ledger (FICTIONAL)', 'ALPH');
  const run = research.createRun(ws, { project_id: pid, providers: ['claude', 'chatgpt'], channel: 'dashboard' }).run;
  const h = harness(ws);
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; throw new Error('FICTIONAL: no network'); };
  t.after(() => { globalThis.fetch = realFetch; });
  const both = await Promise.all([1, 2].map(() => h.call('claude', 'start_research', { project_id: pid, owner_request: 'research Alpha (FICTIONAL)' })));
  assert.deepEqual(both.map((r) => r.data.status), ['resumed', 'resumed'], both.map((r) => r.text).join('\n'));
  assert.deepEqual(both.map((r) => r.data.run.run_id), [run.run_id, run.run_id]);
  const retry = await h.call('claude', 'start_research', { project_id: pid, owner_request: 'research Alpha (FICTIONAL)' });
  assert.deepEqual([retry.data.status, retry.data.run.run_id], ['resumed', run.run_id]);
  const drafts = await Promise.all([1, 2].map((n) => h.call('chatgpt', 'save_research_draft', { project_id: pid, run_id: run.run_id, draft_markdown: `## draft ${n}\nFICTIONAL.\n` })));
  assert.deepEqual(drafts.map((r) => r.data.claimed).sort(), [false, true], drafts.map((r) => r.text).join('\n'));
  assert.equal(research.listRuns(ws, pid).length, 1, 'one run');
  assert.deepEqual(Object.values(research.loadRun(ws, pid, run.run_id).jobs).map((j) => j.state), ['running', 'running']);
  assert.equal(fetched, 0);
});

test('save: a report cut off inside its JSON block, one without a JSON block, one naming another run and one for another project\'s run are refused; malformed arguments are refused; nothing is saved and the job stays open', async (t) => {
  const { ws, root, ids, runs } = threeWaiting(t, 'handoff-refuse');
  const h = harness(ws);
  const pid = ids[0];
  const runId = runs[0].run_id;
  const good = mockReport(ws, 'chatgpt', runs[0]);
  const at = good.indexOf('```json');
  const cut = at + Math.floor((good.length - at) / 2);
  assert.ok(at > 0 && cut > 2000);
  const prose = `${good.slice(0, at)}${'FICTIONAL further analysis, sources dated 2026-10-08.\n'.repeat(60)}`;
  const before = hashTree(path.join(root, 'projects'));
  const cases = [
    ['cut inside the JSON block', { project_id: pid, run_id: runId, report_markdown: good.slice(0, cut) }, /JSON|block|research_run_id/i],
    ['no JSON block', { project_id: pid, run_id: runId, report_markdown: prose }, /JSON|block|research_run_id/i],
    ['names another run', { project_id: pid, run_id: runId, report_markdown: mockReport(ws, 'chatgpt', runs[1]) }, /research_run_id|run/],
    ['another project\'s run', { project_id: pid, run_id: runs[1].run_id, report_markdown: good }, /No research run/],
    ['bad run ID', { project_id: pid, run_id: 'run_../../x', report_markdown: good }, /not a research run ID/],
    ['bad project ID', { project_id: 'Not An ID', run_id: runId, report_markdown: good }, /not a project ID/],
    ['text not a string', { project_id: pid, run_id: runId, report_markdown: 12345 }, /too short/],
  ];
  for (const [what, args, re] of cases) {
    const r = await h.call('chatgpt', 'save_report', args);
    assert.equal(r.isError, true, `${what}: ${r.text}`);
    assert.match(r.text, re, what);
  }
  for (const args of ['"a string"', '[1,2]', 'null']) {
    const r = await h.rpc('chatgpt', null, null, `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"save_report","arguments":${args}}}`);
    assert.equal(r.json.result.isError, true, args);
  }
  const unknown = await h.call('chatgpt', 'drop_everything', {});
  assert.equal(unknown.isError, true);
  const bad = await h.rpc('chatgpt', null, null, '{"jsonrpc":"2.0","id":8,"method":"tools/call",');
  assert.deepEqual([bad.status, bad.json.error.code], [400, -32700]);
  assert.deepEqual(hashTree(path.join(root, 'projects')), before, 'nothing saved or linked');
  assert.equal(research.loadRun(ws, pid, runId).jobs.chatgpt.state, 'unconfigured', 'the job stays open');
});

test('history: a report imported for no run completes no job, however many are open', (t) => {
  const { ws, ids, runs } = threeWaiting(t, 'handoff-history');
  const out = inbox.importContent(ws, 'chatgpt', { content: mockReport(ws, 'chatgpt', runs[0]).replace(/"research_run_id":\s*"[^"]+",?/, ''), projectId: ids[0] });
  assert.equal(out.result.status, 'ingested', JSON.stringify(out.result));
  assert.equal(research.loadRun(ws, ids[0], runs[0].run_id).jobs.chatgpt.state, 'unconfigured');
  assert.equal(research.pendingFor(ws, 'chatgpt').length, 3);
});

test('read-only tools write nothing and start nothing, for every model, on hold or not', async (t) => {
  noKeys(t);
  const { ws: w0, root, cleanup } = tempWorkspace('handoff-readonly');
  t.after(cleanup);
  const pid = addProject(w0, 1, 'Alpha Ledger (FICTIONAL)', 'ALPH');
  const run = research.createRun(w0, { project_id: pid, providers: ['claude', 'chatgpt', 'gemini'], channel: 'dashboard' }).run;
  inbox.importContent(w0, 'claude', { content: mockReport(w0, 'claude', run), projectId: pid, runId: run.run_id });
  const ws = setHold(root, 'gemini');
  const h = harness(ws);
  // Discovery first: the session's own bookkeeping is in memory only.
  for (const m of ['claude', 'chatgpt', 'gemini']) {
    await h.rpc(m, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'FICTIONAL', version: '1' } });
    await h.rpc(m, 'tools/list', {});
  }
  const before = hashTree(root);
  const reads = [
    ['find_projects', {}], ['find_projects', { query: 'alpha' }], ['pending_research', {}], ['pending_research', { project: 'Alpha' }],
    ['desk_status', {}], ['desk_status', { project_id: pid }], ['get_research', { project_id: pid }], ['get_research', { project_id: pid, run_id: run.run_id, include_prompt: false }],
    ['get_report', { project_id: pid }], ['get_report', { project_id: pid, model: 'claude' }], ['compare_reports', { project_id: pid }], ['list_accounts', {}], ['portfolio_overview', {}],
  ];
  for (const m of ['claude', 'chatgpt', 'gemini']) for (const [name, args] of reads) await h.call(m, name, args);
  assert.deepEqual(hashTree(root), before, 'no file changed');
  assert.deepEqual(Object.fromEntries(Object.entries(research.loadRun(ws, pid, run.run_id).jobs).map(([p, j]) => [p, j.state])), { claude: 'completed', chatgpt: 'unconfigured', gemini: 'unconfigured' });
  assert.equal(research.listRuns(ws, pid).length, 1);
});

test('prompt delivery: the text form closes with an end-of-prompt line naming its length and hash, so a cut-off answer is detectable; a template edited after the run started never changes what is delivered', async (t) => {
  const { ws, root, ids, runs } = threeWaiting(t, 'handoff-prompt');
  const h = harness(ws);
  const run = runs[0];
  const prompt = fs.readFileSync(path.join(root, run.prompt.path), 'utf8');
  // A template changed after the run started: the run keeps its frozen prompt.
  const tpl = path.join(root, 'templates', 'research-prompt.v5.md');
  fs.writeFileSync(tpl, `${fs.readFileSync(tpl, 'utf8')}\nFICTIONAL: the template changed after the run started.\n`);
  const view = await h.call('chatgpt', 'get_research', { project_id: ids[0], run_id: run.run_id });
  assert.equal(view.data.run.prompt, prompt);
  assert.equal(view.data.run.prompt_delivery.status, 'verified');
  const blocks = view.content.map((c) => c.text);
  const at = blocks.findIndex((b) => b.startsWith(`--- Research prompt for ${run.run_id}`));
  assert.equal(blocks[at].slice(blocks[at].indexOf('\n') + 1), prompt, 'the prompt block is the frozen bytes');
  assert.equal(blocks[blocks.length - 1], `--- End of the research prompt for ${run.run_id}: ${prompt.length} characters, SHA-256 ${run.prompt.sha256} ---`);
  assert.equal(at, blocks.length - 2);
  assert.match(JSON.parse(blocks[0]).run.prompt, /^\(the run's frozen prompt is the text block below that starts "--- Research prompt for run_\S+", followed by the end-of-prompt line: \d+ characters, SHA-256 [0-9a-f]{64}\)$/);
  assert.match(view.data.run.prompt_delivery.note, /end-of-prompt line/);
  assert.ok(!view.text.includes('FICTIONAL: the template changed'));
});

test('desk_status says, per assistant, what it can do now and what Eric does next; a connection that called no tool is shown as such, never as research started; no secret is given out', async (t) => {
  noKeys(t);
  const { ws: w0, root, cleanup } = tempWorkspace('handoff-status');
  t.after(cleanup);
  const pid = addProject(w0, 1, 'Alpha Ledger (FICTIONAL)', 'ALPH');
  research.createRun(w0, { project_id: pid, providers: ['claude', 'chatgpt'], channel: 'dashboard' });
  const ws = setHold(root, 'gemini');
  const connections = () => [
    { grant_id: 'grant_SECRET_chatgpt', client_name: 'ChatGPT', assistant: 'chatgpt', assistant_label: 'ChatGPT', created_at: '2026-10-03T00:00:00Z', last_used_at: '2026-10-08T10:15:41Z' },
    { grant_id: 'grant_SECRET_gemini', client_name: 'Google', assistant: 'gemini', assistant_label: 'Gemini', created_at: '2026-10-03T00:00:00Z', last_used_at: '2026-10-08T10:40:35Z' },
  ];
  const h = harness(ws, { connections });
  for (const m of ['gemini', 'chatgpt']) {
    await h.rpc(m, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'FICTIONAL', version: '1' } });
    await h.rpc(m, 'tools/list', {});
  }
  await h.call('chatgpt', 'get_research', { project_id: pid });
  const st = await h.call('claude', 'desk_status', {});
  const a = st.data.assistants;
  assert.deepEqual(Object.keys(a), ['claude', 'chatgpt', 'gemini']);
  assert.equal(a.claude.connected, false);
  assert.match(a.claude.action, /Settings > Connectors/);
  assert.equal(a.chatgpt.connected, true);
  assert.equal(a.chatgpt.waiting, 1);
  assert.match(a.chatgpt.says, /1 job waiting: Alpha Ledger \(FICTIONAL\)/);
  assert.match(a.chatgpt.action, /Do my waiting CryptoResearch research on Alpha Ledger \(FICTIONAL\)/);
  assert.equal(a.chatgpt.since_restart.tool_calls, 1);
  assert.equal(a.gemini.connected, true);
  assert.equal(a.gemini.on_hold, true);
  assert.deepEqual([a.gemini.since_restart.sessions, a.gemini.since_restart.tool_calls], [1, 0]);
  assert.match(a.gemini.says, /on hold since 2026-10-04/);
  assert.match(a.gemini.says, /opened 1 session since the desk restarted \([^)]+\) and called no tool, so nothing was researched or saved through it/);
  assert.match(a.gemini.action, /lift the hold in Settings/);
  assert.match(a.gemini.fallback, /Copy prompt.*Import report/);
  assert.doesNotMatch(st.data.assistants.chatgpt.says, /\b(working|researching|started)\b/i, 'a read is not research started');
  assert.match(a.chatgpt.says, /called 1 tool since the desk restarted .*last get_research/);
  assert.equal(research.loadRun(ws, pid, research.listRuns(ws, pid)[0].run_id).jobs.chatgpt.state, 'unconfigured');
  assert.ok(!/grant_SECRET|crc_|passphrase|Bearer/.test(st.text), 'no connection secret or ID');
  assert.match(st.data.message, /Assistants: /);
});

test('logs: each call is logged once with a reference, its connection and its handoff stage; an error names the same reference; tokens, addresses and report text never appear in the log', async (t) => {
  const { ws, ids, runs } = threeWaiting(t, 'handoff-logs');
  const h = harness(ws);
  const pid = ids[0];
  const runId = runs[0].run_id;
  await h.call('chatgpt', 'get_research', { project_id: pid, run_id: runId });
  const delivered = h.logs.find((l) => l.startsWith('MCP get_research:'));
  assert.match(delivered, new RegExp(`^MCP get_research: ok \\(ChatGPT: FICTIONAL chatgpt\\) \\[${runId}: ChatGPT unconfigured; handoff: prompt delivered \\d+ chars, sha256 [0-9a-f]{12}, execution note cr-execution-chatgpt@2\\] ref m[0-9a-f]{10} conn [0-9a-f]{8}$`));
  await h.call('chatgpt', 'save_research_draft', { project_id: pid, run_id: runId, draft_markdown: 'FICTIONAL-SENTINEL-DRAFT body text' });
  assert.match(h.logs.at(-1), /^MCP save_research_draft: draft_saved .*claimed; draft \d+ chars\] ref m[0-9a-f]{10} conn [0-9a-f]{8}$/);
  const addr = '0x1111111111111111111111111111111111111111';
  const tokenish = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tV9wX1yZ3aB5cD7eF9';
  const bad = await h.call('chatgpt', 'get_research', { project_id: addr });
  const ref = bad.text.match(/\(ref (m[0-9a-f]{10})\)/);
  assert.ok(ref, bad.text);
  const line = h.logs.at(-1);
  assert.ok(line.includes(`ref ${ref[1]}`), line);
  assert.ok(!line.includes(addr), `address redacted: ${line}`);
  await h.call('chatgpt', 'get_research', { project_id: tokenish });
  assert.ok(!h.logs.at(-1).includes(tokenish), `token-like text redacted: ${h.logs.at(-1)}`);
  const text = mockReport(ws, 'chatgpt', runs[0]).replace('FICTIONAL', 'FICTIONAL-SENTINEL-REPORT');
  await h.call('chatgpt', 'save_report', { project_id: pid, run_id: runId, report_markdown: text });
  assert.match(h.logs.at(-1), /^MCP save_report: saved .*save: report \S+ completes the job.*\] ref m[0-9a-f]{10} conn [0-9a-f]{8}$/);
  assert.ok(!h.logs.some((l) => /SENTINEL/.test(l)), 'no report or draft text in the log');
  assert.equal(redactLog(`Bearer ${tokenish} ${addr} 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq run_2026-10-08T095427Z_ct8kd`), 'Bearer [redacted] 0x1111…1111 [redacted] bc1… run_2026-10-08T095427Z_ct8kd');
});

// ---------------------------------------------------------------------------
// Over HTTP, with the desk's own sign-in: an access token that expires during
// a long research session.

const PASS = 'test-passphrase-not-real';
const HOST = 'desk.test';
const ORIGIN = `https://${HOST}`;
const CHATGPT_APP_CALLBACK = 'https://chatgpt.com/connector/oauth/cb_fictional123';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}
function req(port, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: HOST, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const form = (o) => new URLSearchParams(o).toString();
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function desk(t, label) {
  const hosted = require('../hosted');
  const { start } = require('../server');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `cr-handoff-${label}-`));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 }));
  const port = await freePort();
  const cfg = hosted.hostedConfig({ CR_DATA_DIR: path.join(base, 'data'), CR_ACCESS_PASSWORD: PASS, PORT: String(port), RENDER_EXTERNAL_HOSTNAME: HOST });
  const ws = hosted.prepareWorkspace(cfg);
  const file = path.join(ws.root, 'config', 'settings.json');
  const s = readJson(file);
  s.market_data = { ...(s.market_data || {}), enabled: false };
  fs.writeFileSync(file, JSON.stringify(s));
  ws.reloadSettings();
  const opts = { quiet: true, hosted: { port, hosts: cfg.hosts, password: cfg.password, bind: '127.0.0.1', failDelayMs: 0 } };
  let srv = await start(ws, opts);
  t.after(() => srv && srv.shutdown());
  return {
    ws,
    get port() { return opts.hosted.port; },
    async restart() { srv.shutdown(); opts.hosted.port = await freePort(); srv = await start(ws, opts); },
  };
}

async function connect(d, { redirect, clientName }) {
  const reg = await req(d.port, { method: 'POST', path: '/oauth/register', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: clientName, redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
  assert.equal(reg.status, 201, reg.text);
  const clientId = reg.json.client_id;
  const verifier = b64url(crypto.randomBytes(40));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const q = form({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 's', scope: 'desk offline_access', resource: `${ORIGIN}/mcp` });
  const consent = await req(d.port, { path: `/oauth/authorize?${q}` });
  const requestId = consent.text.match(/name="request" value="([^"]+)"/)[1];
  const approve = await req(d.port, { method: 'POST', path: '/oauth/authorize', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN }, body: form({ request: requestId, password: PASS, decision: 'allow' }) });
  const code = new URL(approve.headers.location).searchParams.get('code');
  const tok = await req(d.port, { method: 'POST', path: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier, client_id: clientId, resource: `${ORIGIN}/mcp` }) });
  assert.equal(tok.status, 200, tok.text);
  return { clientId, access: tok.json.access_token, refresh: tok.json.refresh_token };
}

let nextId = 1;
async function tool(d, access, name, args) {
  const r = await req(d.port, { method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${access}` }, body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }) });
  if (r.status !== 200) return { status: r.status, headers: r.headers, json: r.json };
  const res = r.json.result;
  return { status: 200, ...res, data: res.structuredContent || null, text: res.content.map((c) => c.text).join('\n') };
}

test('auth: an access token that expires during a long session gets a 401 invalid_token challenge naming the resource metadata; the refreshed token continues the same claimed job with its draft, across a restart; one run, one report', async (t) => {
  noKeys(t);
  const d = await desk(t, 'expiry');
  const claude = await connect(d, { redirect: 'https://claude.ai/api/mcp/auth_callback', clientName: 'Claude' });
  const gpt = await connect(d, { redirect: CHATGPT_APP_CALLBACK, clientName: 'ChatGPT' });
  const pid = (await tool(d, claude.access, 'add_project', { name: 'Examplecoin (FICTIONAL)', symbol: 'XMC', official_website: 'https://examplecoin.example/', contracts: [{ chain: 'base', address: '0x2222222222222222222222222222222222222222' }], evidence: [{ url: 'https://examplecoin.example/docs/token' }], sector: 'payments', owner_request: 'add it (FICTIONAL)' })).data.project.project_id;
  const runId = (await tool(d, claude.access, 'start_research', { project_id: pid, owner_request: 'Research Examplecoin with all three models (FICTIONAL)', models: 'all' })).data.run.run_id;
  const next = await tool(d, gpt.access, 'pending_research', { project: 'Examplecoin' });
  assert.equal(next.data.next.run_id, runId);
  await tool(d, gpt.access, 'get_research', { project_id: pid, run_id: runId });
  assert.equal((await tool(d, gpt.access, 'save_research_draft', { project_id: pid, run_id: runId, draft_markdown: '## 1\nFICTIONAL long session draft.\n' })).data.status, 'draft_saved');
  // An hour later the access token has expired; the desk is also redeployed.
  const file = path.join(d.ws.root, '.cr', 'oauth.json');
  const store = readJson(file);
  for (const rec of Object.values(store.access)) rec.expires_at = new Date(Date.now() - 60000).toISOString();
  atomicWrite(file, jsonText(store));
  await d.restart();
  const expired = await tool(d, gpt.access, 'pending_research', {});
  assert.equal(expired.status, 401);
  assert.match(expired.headers['www-authenticate'], /^Bearer resource_metadata="https:\/\/desk\.test\/\.well-known\/oauth-protected-resource", scope="desk", error="invalid_token"$/);
  const refreshed = await req(d.port, { method: 'POST', path: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'refresh_token', refresh_token: gpt.refresh, client_id: gpt.clientId, resource: `${ORIGIN}/mcp` }) });
  assert.equal(refreshed.status, 200, refreshed.text);
  const access = refreshed.json.access_token;
  const resume = await tool(d, access, 'pending_research', {});
  assert.equal(resume.data.next.run_id, runId);
  assert.equal(resume.data.next.state, 'started');
  assert.ok(resume.data.next.draft && resume.data.next.draft.chars > 0);
  const run = research.loadRun(d.ws, pid, runId);
  const saved = await tool(d, access, 'save_report', { project_id: pid, run_id: runId, report_markdown: mockReport(d.ws, 'chatgpt', run) });
  assert.equal(saved.data.status, 'saved', saved.text);
  assert.equal(research.listRuns(d.ws, pid).length, 1);
  assert.equal(indexer.projectDetail(d.ws, pid).history.chatgpt.length, 1);
  // No token at all: a challenge without an error, so the client signs in.
  const none = await req(d.port, { method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(none.status, 401);
  assert.doesNotMatch(none.headers['www-authenticate'], /error=/);
});
