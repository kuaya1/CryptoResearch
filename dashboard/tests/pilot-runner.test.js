'use strict';
// The pilot runner finds Claude Code without a shell (backlog item 6): plain
// `claude` off Windows, claude.exe on Windows from PATH or its install folders.
// Stubs only; nothing is run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { resolveClaude } = require('../scripts/pilot');

test('off Windows the command is claude', () => {
  assert.equal(resolveClaude({ platform: 'linux', env: {}, exists: () => false }), 'claude');
  assert.equal(resolveClaude({ platform: 'darwin', env: {}, exists: () => false }), 'claude');
});

test('on Windows claude.exe is found on PATH first, then in the usual folders', () => {
  const env = { PATH: 'C:\\Windows;C:\\Tools', USERPROFILE: 'C:\\Users\\eric', LOCALAPPDATA: 'C:\\Users\\eric\\AppData\\Local' };
  const seen = new Set(['C:\\Tools\\claude.exe', 'C:\\Users\\eric\\.local\\bin\\claude.exe']);
  assert.equal(resolveClaude({ platform: 'win32', env, exists: (f) => seen.has(f) }), 'C:\\Tools\\claude.exe');
  assert.equal(resolveClaude({ platform: 'win32', env, exists: (f) => f === 'C:\\Users\\eric\\.local\\bin\\claude.exe' }), 'C:\\Users\\eric\\.local\\bin\\claude.exe');
});

test('on Windows a missing claude.exe is a plain error, never a shell lookup', () => {
  assert.throws(() => resolveClaude({ platform: 'win32', env: { PATH: 'C:\\Windows' }, exists: () => false }), /claude\.exe was not found/);
});

test('the runner no longer spawns through a shell', () => {
  assert.ok(!/shell:\s*/.test(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pilot.js'), 'utf8')));
});

// Eric's override (2026-10-25): a Prosecutor on a closed pre-gate. Pure
// helpers only; nothing is run.
const { parse, forcedTicket, roleInstruction, roleTools, roleForStep, nextStepOf, runOnline, ROLE_TOOLS, FORCE_WORDS } = require('../scripts/pilot');

test('the override flag and owner words parse, an "=" inside the words kept', () => {
  const o = parse(['--project=velodrome-finance', '--desk=online', '--force-prosecution', '--owner-words=grade >= 50 = prosecute']);
  assert.equal(o.project, 'velodrome-finance');
  assert.equal(o.forceProsecution, true);
  assert.equal(o.ownerWords, 'grade >= 50 = prosecute');
  assert.equal(parse(['--project=olas']).forceProsecution, false);
});

test('the override turns the gate step and an undecided desk gate into a ticket, never a decided one', () => {
  const on = { forceProsecution: true };
  const gate = (status) => ({ desk_gate: true, status });
  assert.equal(forcedTicket({ step: 'gate_closed' }, null, { forceProsecution: false }), false);
  assert.equal(forcedTicket({ step: 'gate_closed' }, null, on), true);
  assert.equal(forcedTicket({ step: 'pm_review' }, gate('pending_pm_review'), on), true);
  assert.equal(forcedTicket({ step: 'pm_review' }, gate('passed'), on), false);
  assert.equal(forcedTicket({ step: 'pm_review' }, { desk_gate: false, status: 'pending_pm_review' }, on), false);
  assert.equal(forcedTicket({ step: 'done' }, gate('watching'), on), false);
  assert.equal(forcedTicket({ step: 'research' }, null, on), false);
});

test('the Prosecutor\'s online instruction asks for force_prosecution only with the override, in Eric\'s words', () => {
  const plain = roleInstruction('prosecutor', { project: 'olas', forceProsecution: false });
  assert.match(plain, /needs no Prosecutor/);
  assert.doesNotMatch(plain, /force_prosecution/);
  const forced = roleInstruction('prosecutor', { project: 'olas', forceProsecution: true, ownerWords: null });
  assert.match(forced, /force_prosecution: true/);
  assert.ok(forced.includes(JSON.stringify(FORCE_WORDS)));
  assert.match(forced, /Never on a desk gate Eric already decided/);
  assert.match(forced, /Never decide a ticket, never choose a dollar amount/);
  assert.doesNotMatch(roleInstruction('researcher', { project: 'olas', forceProsecution: true }), /force_prosecution|start_ticket|save_ticket/);
});

// Stage 2.1: online, as locally, the Researcher and the Prosecutor are two
// sessions with no shared transcript, each with only its own connector tools.
const O = (over = {}) => ({ project: 'olas', desk: 'online', connector: 'mcp__desk', model: null, timeoutMin: 1, forceProsecution: false, ownerWords: null, ...over });

test('online: each role\'s tools are its own; neither can call the other\'s', () => {
  const r = roleTools('researcher', O());
  const p = roleTools('prosecutor', O());
  for (const t of ['start_ticket', 'get_ticket', 'save_ticket']) assert.ok(!r.includes(`mcp__desk__${t}`), t);
  for (const t of ['start_research', 'get_research', 'save_research_draft', 'save_report']) assert.ok(!p.includes(`mcp__desk__${t}`), t);
  assert.ok(!r.includes('mcp__desk') && !p.includes('mcp__desk'), 'never the whole connector');
  assert.deepEqual(ROLE_TOOLS.researcher.filter((t) => ROLE_TOOLS.prosecutor.includes(t)), ['autonomous_pilot_queue'], 'only the read-only queue is shared');
});

test('online: research then a ticket are two separate sessions; nothing of the first reaches the second', () => {
  const calls = [];
  const answers = ['Saved report rp_FICTIONAL_1 after a long transcript about tokenomics.\nNEXT_STEP: ticket', 'Saved receipt tr_FICTIONAL_1.\nNEXT_STEP: pm_review'];
  const sessions = runOnline(O(), { run: (prompt, opts) => { calls.push({ prompt, opts }); return answers[calls.length - 1]; }, out: () => {} });
  assert.deepEqual(sessions.map((s) => s.role), ['researcher', 'prosecutor']);
  assert.equal(calls.length, 2, 'two claude -p sessions, no third');
  const [a, b] = calls;
  assert.match(a.prompt, /Agent 1, the Researcher/);
  assert.match(b.prompt, /Agent 2, the Prosecutor/);
  assert.ok(!b.prompt.includes('rp_FICTIONAL_1') && !b.prompt.includes('tokenomics'), 'the second session is given nothing the first said');
  assert.equal(b.prompt, roleInstruction('prosecutor', O()), 'the Prosecutor\'s prompt is fixed, whatever the Researcher answered');
  assert.deepEqual(a.opts.tools, roleTools('researcher', O()));
  assert.deepEqual(b.opts.tools, roleTools('prosecutor', O()));
});

test('online: the steps decide the roles; the override has one Prosecutor; a missing NEXT_STEP stops', () => {
  assert.equal(roleForStep(null, O()), 'researcher');
  assert.equal(roleForStep('research', O()), 'researcher');
  for (const s of ['ticket', 'ticket_failed', 'gate_closed']) assert.equal(roleForStep(s, O()), 'prosecutor', s);
  for (const s of ['pm_review', 'done', 'blocked', 'unknown']) assert.equal(roleForStep(s, O()), null, s);
  assert.equal(roleForStep('pm_review', O({ forceProsecution: true })), 'prosecutor');
  assert.equal(roleForStep('pm_review', O({ forceProsecution: true }), { forced: true }), null);
  assert.equal(nextStepOf('…\nNEXT_STEP: gate_closed\n'), 'gate_closed');
  assert.equal(nextStepOf('NEXT_STEP: ticket\nNEXT_STEP: pm_review'), 'pm_review', 'the last line counts');
  assert.equal(nextStepOf('NEXT_STEP: order_now'), null, 'only the queue\'s own steps');
  assert.equal(nextStepOf('no step line'), null);
  // A forced run asks one Prosecutor on the pending desk gate, then stops.
  const seen = [];
  runOnline(O({ forceProsecution: true }), { run: (prompt) => { seen.push(prompt); return seen.length === 1 ? 'NEXT_STEP: pm_review' : 'NEXT_STEP: pm_review'; }, out: () => {} });
  assert.equal(seen.length, 2, 'the researcher reads the queue, one forced Prosecutor, then the runner stops');
  assert.throws(() => runOnline(O(), { run: () => 'I did some things.', out: () => {} }), /did not end with a NEXT_STEP line/);
  assert.throws(() => runOnline(O(), { run: () => 'NEXT_STEP: research', out: () => {} }), /research step is still open/);
});

test('online: a paused desk dispatches no agent after the session that read the queue, and says why', () => {
  const { PAUSED_WORDS } = require('../scripts/pilot');
  assert.equal(nextStepOf('The queue is paused.\nNEXT_STEP: paused'), 'paused');
  for (const role of ['researcher', 'prosecutor']) assert.match(roleInstruction(role, O()), /answers "paused".*call nothing else.*NEXT_STEP: paused/, role);
  for (const over of [{}, { forceProsecution: true }]) {
    const lines = [];
    const prompts = [];
    const sessions = runOnline(O(over), { run: (prompt) => { prompts.push(prompt); return 'NEXT_STEP: paused'; }, out: (s) => lines.push(s) });
    assert.equal(prompts.length, 1, 'only the first session, which reads the queue');
    assert.deepEqual(sessions.map((s) => s.role), ['researcher']);
    assert.equal(lines[lines.length - 1], PAUSED_WORDS);
  }
  // Paused while the chain runs: the session that saw it is the last one.
  const roles = [];
  const lines = [];
  runOnline(O(), { run: (prompt) => { roles.push(/Agent 2/.test(prompt) ? 'prosecutor' : 'researcher'); return roles.length === 1 ? 'Saved.\nNEXT_STEP: ticket' : 'NEXT_STEP: paused'; }, out: (s) => lines.push(s) });
  assert.deepEqual(roles, ['researcher', 'prosecutor'], 'no session after the pause');
  assert.equal(lines[lines.length - 1], PAUSED_WORDS);
});

test('online --dry-run shows each role\'s session and runs none', () => {
  const lines = [];
  const sessions = runOnline(O({ dryRun: true }), { run: () => assert.fail('nothing runs'), out: (s) => lines.push(s) });
  assert.deepEqual(sessions, []);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /researcher/);
  assert.match(lines[1], /prosecutor/);
});
