'use strict';
// The pilot runner's execution claim (cr-pilot-claim@1, subtraction stage 5.4)
// and the automation switches of stage 5.3. FICTIONAL temporary workspaces;
// no provider, model or agent is asked for anything.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const { tempWorkspace, addFixtureProject, importAllFixtures } = require('./helpers');
const T = require('../core/tickets');
const C = require('../core/pilot-claims');
const research = require('../core/research');
const jobs = require('../core/jobs');

const CLI = path.join(__dirname, '..', 'cli.js');
const HOUR = 3600000;

function setup(t, settings) {
  const w = tempWorkspace('pilot-claims', settings);
  t.after(w.cleanup);
  const pid = addFixtureProject(w.ws).project_id;
  T.setPilot(w.ws, pid, true);
  return { ...w, pid };
}

// One CLI process, its JSON answer.
function cliRun(root, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CLI, ...args, '--json', '--workspace', root], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      try { resolve(JSON.parse(out)); } catch (_) { reject(new Error(`exit ${code}: ${err || out}`)); }
    });
  });
}

test('two runners started together: exactly one claims the step, binds one run and dispatches', async (t) => {
  const s = setup(t);
  assert.equal(T.pilotQueue(s.ws, { project: s.pid })[0].step, 'research');
  const answers = await Promise.all([
    cliRun(s.root, ['tickets', 'claim', s.pid, '--owner', 'runner A']),
    cliRun(s.root, ['tickets', 'claim', s.pid, '--owner', 'runner B']),
  ]);
  const won = answers.filter((a) => a.status === 'claimed_now');
  assert.equal(won.length, 1, JSON.stringify(answers.map((a) => a.status)));
  assert.equal(answers.filter((a) => a.status === 'claimed').length, 1, 'the other runner is told the project is held');
  const winner = won[0];
  assert.equal(winner.key, 'research:-');
  // The winner opens the run and binds it before any agent runs.
  const run = research.createRun(s.ws, { project_id: s.pid, providers: ['claude'], channel: 'cowork', utterance: 'FICTIONAL pilot test' });
  const runId = run.run_id || run.run.run_id;
  const bound = await cliRun(s.root, ['tickets', 'bind', s.pid, '--token', winner.token, '--run', runId]);
  assert.equal(bound.status, 'bound');
  assert.equal(C.read(s.ws, s.pid).run_id, runId, 'the run is on record before the dispatch');
  assert.equal(C.read(s.ws, s.pid).state, 'dispatched');
  assert.equal(research.listRuns(s.ws, s.pid).length, 1, 'one linked run');
  // The loser cannot bind or release with a token it never held.
  const refused = await cliRun(s.root, ['tickets', 'bind', s.pid, '--token', 'not-the-token', '--run', runId]);
  assert.equal(refused.code, 'CHANGED');
  assert.equal(C.read(s.ws, s.pid).token, winner.token, 'the claim is unchanged');
});

test('an expired dispatch with no known outcome waits to be reconciled, never dispatched again', (t) => {
  const s = setup(t);
  const now = Date.now();
  const a = C.claim(s.ws, s.pid, { owner: 'A', now });
  assert.equal(a.status, 'claimed_now');
  C.bind(s.ws, s.pid, a.token, { run_id: 'run_fictional', now });
  // The run never landed a report; the claim expired.
  const later = now + C.TTL_MS + 1000;
  const b = C.claim(s.ws, s.pid, { owner: 'B', now: later });
  assert.equal(b.status, 'reconcile');
  assert.match(b.words, /not dispatched again/);
  assert.throws(() => C.release(s.ws, s.pid, { reconciled: true, now: now + 1000 }), /still live/);
  assert.equal(C.release(s.ws, s.pid, { reconciled: true, now: later }).claim.outcome, 'reconciled');
  assert.equal(C.claim(s.ws, s.pid, { owner: 'B', now: later }).status, 'claimed_now', 'after Eric reconciles it, the next runner may claim');
});

// Audit H1: binding a real run moves the desk's key from research:- to
// research:run_…; the expired dispatch is still the same attempt.
test('a real run bound under a provisional claim, then expired, waits to be reconciled though the desk\'s key changed', (t) => {
  const s = setup(t);
  const now = Date.now();
  const a = C.claim(s.ws, s.pid, { owner: 'A', now });
  assert.equal(a.status, 'claimed_now');
  assert.equal(a.key, 'research:-');
  assert.match(a.claim.attempt_id, /^pa_[0-9a-f]{16}$/);
  const run = research.createRun(s.ws, { project_id: s.pid, providers: ['claude'], channel: 'cowork', utterance: 'FICTIONAL pilot test' });
  const runId = run.run_id || run.run.run_id;
  const bound = C.bind(s.ws, s.pid, a.token, { run_id: runId, now }).claim;
  assert.equal(bound.key, 'research:-', 'the claim keeps its first key');
  assert.equal(bound.bound_key, `research:${runId}`);
  assert.equal(bound.attempt_id, a.claim.attempt_id, 'the same attempt');
  const later = now + C.TTL_MS + 1000;
  assert.equal(C.transitionKey(T.pilotQueue(s.ws, { project: s.pid, now: later })[0]), `research:${runId}`, 'the desk now names the run');
  const b = C.claim(s.ws, s.pid, { owner: 'B', now: later });
  assert.equal(b.status, 'reconcile', 'never claimed_now on an unresolved dispatch');
  assert.equal(b.claim.attempt_id, a.claim.attempt_id);
  assert.equal(C.read(s.ws, s.pid).token, a.token, 'nothing was written');
  C.release(s.ws, s.pid, { reconciled: true, now: later });
  const c = C.claim(s.ws, s.pid, { owner: 'B', now: later });
  assert.equal(c.status, 'claimed_now');
  assert.notEqual(c.claim.attempt_id, a.claim.attempt_id, 'a new attempt after Eric reconciles');
});

test('bind is refused once the claim has expired or automation was paused after it; nothing is dispatched', (t) => {
  const s = setup(t);
  const now = Date.now();
  const a = C.claim(s.ws, s.pid, { now });
  assert.throws(() => C.bind(s.ws, s.pid, a.token, { run_id: 'run_fictional', now: now + C.TTL_MS }), (err) => err.code === 'CHANGED' && /expired/.test(err.message));
  assert.equal(C.read(s.ws, s.pid).state, 'claimed');
  const b = C.claim(s.ws, s.pid, { now: now + C.TTL_MS + 1000 });
  assert.equal(b.status, 'claimed_now', 'an expired claim that never dispatched is taken over');
  s.ws.settings = { ...s.ws.settings, automation: { ...s.ws.settings.automation, paused: true } };
  assert.throws(() => C.bind(s.ws, s.pid, b.token, { run_id: 'run_fictional', now: now + C.TTL_MS + 2000 }), (err) => err.code === 'PAUSED');
  assert.equal(C.read(s.ws, s.pid).state, 'claimed');
  // Already-dispatched work may still settle: release is never paused.
  assert.equal(C.release(s.ws, s.pid, { token: b.token, outcome: 'stopped' }).status, 'released');
});

test('an expired claim that never dispatched is taken over; one whose work landed is a new transition', (t) => {
  const s = setup(t);
  const now = Date.now();
  const a = C.claim(s.ws, s.pid, { now });
  assert.equal(C.claim(s.ws, s.pid, { now: now + 1000 }).status, 'claimed', 'live: held');
  assert.equal(C.claim(s.ws, s.pid, { now: now + C.TTL_MS + 1000 }).status, 'claimed_now', 'never bound: safe to take over');
  C.release(s.ws, s.pid, { reconciled: true, now: now + 3 * C.TTL_MS });
  // The research landed: the step moves on, so a dispatched claim on the old step does not block it.
  const c = C.claim(s.ws, s.pid, { now: now + 3 * C.TTL_MS });
  C.bind(s.ws, s.pid, c.token, { run_id: 'run_fictional' });
  importAllFixtures(s.ws);
  const d = C.claim(s.ws, s.pid, { now: now + 5 * C.TTL_MS });
  assert.equal(d.status, 'claimed_now');
  assert.match(d.key, /^ticket:/);
  assert.ok(a.token);
});

test('the desk\'s step is read inside the lock: an expected key that moved is refused', (t) => {
  const s = setup(t);
  assert.equal(C.claim(s.ws, s.pid, { expect: 'ticket:r_fictional' }).status, 'changed');
  importAllFixtures(s.ws);
  T.setPilot(s.ws, s.pid, true);
  const tk = T.createTicket(s.ws, { project_id: s.pid, assistant: true }).ticket;
  const q = T.pilotQueue(s.ws, { project: s.pid })[0];
  assert.equal(q.step, 'ticket');
  assert.equal(C.transitionKey(q), `ticket:${q.ticket_id || q.report_id}`);
  assert.ok(tk.ticket_id);
});

test('a refused Prosecutor save gets one correction, then waits for Eric', (t) => {
  const s = setup(t);
  importAllFixtures(s.ws);
  const tk = T.createTicket(s.ws, { project_id: s.pid, assistant: true }).ticket;
  const failed = { step: 'ticket_failed', ticket_id: tk.ticket_id, why: 'FICTIONAL refusal' };
  t.mock.method(T, 'pilotQueue', () => [failed]);
  const now = Date.now();
  const first = C.claim(s.ws, s.pid, { now });
  assert.equal(first.status, 'claimed_now');
  assert.equal(first.claim.corrections[tk.ticket_id], 1, 'counted before it runs');
  C.release(s.ws, s.pid, { token: first.token, now });
  const second = C.claim(s.ws, s.pid, { now: now + 1000 });
  assert.equal(second.status, 'correction_limit');
  assert.match(second.words, /waits for you/);
});

test('automation.paused stops every dispatch at once; the trader\'s candles and settlement are not paused', async (t) => {
  const s = setup(t, { automation: { paused: true }, research: { providers: { claude: { mock: 'ok' } } } });
  assert.equal(s.ws.settings.automation.paused, true);
  assert.equal(C.claim(s.ws, s.pid).status, 'paused');
  research.createRun(s.ws, { project_id: s.pid, providers: ['claude'], channel: 'dashboard', utterance: 'FICTIONAL' });
  assert.equal(research.hasDueWork(s.ws), true, 'a queued API job is waiting');
  const r = await jobs.runJob(s.ws, 'research', { trigger: 'test' });
  assert.equal(r.status, 'skipped');
  assert.match(r.summary, /Automation is paused/);
  assert.equal(jobs.isDue(s.ws, 'research', { jobs: {} }), false);
  // The trader's own job keeps its own due rule: pause never enters it.
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'core', 'trader-candles.js'), 'utf8');
  assert.ok(!/automation/.test(src), 'the candle job never reads the pause');
  assert.ok(!/automationPaused/.test(require('fs').readFileSync(path.join(__dirname, '..', 'core', 'trader-desk.js'), 'utf8')), 'settlement never reads the pause');
});

test('automation.paused: the connector\'s pilot queue answers "paused" for every step and offers nothing to do', async (t) => {
  const call = async (ws, args) => {
    const handle = require('../mcp').makeMcp(ws);
    let body = '';
    const req = require('stream').Readable.from([Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'autonomous_pilot_queue', arguments: args } }))]);
    req.method = 'POST';
    await handle(req, { writeHead() {}, end(b) { body = b || ''; } }, { assistant: 'claude' });
    return JSON.parse(body).result.structuredContent;
  };
  const live = setup(t);
  const open = await call(live.ws, { project: live.pid });
  assert.equal(open.status, 'ok');
  assert.equal(open.steps[0].step, 'research');
  assert.ok(open.next);
  const s = setup(t, { automation: { paused: true } });
  const fs = require('fs');
  const before = fs.readdirSync(s.root, { recursive: true }).sort();
  for (const args of [{ project: s.pid }, {}]) {
    const q = await call(s.ws, args);
    assert.equal(q.status, 'paused');
    assert.equal(q.next, null, 'nothing is offered to do');
    assert.equal(q.steps.length, 1);
    assert.equal(q.steps[0].step, 'paused');
    assert.equal(q.steps[0].step_when_resumed, 'research', 'the step it would be is kept beside it');
    assert.match(q.message, /NEXT_STEP: paused/);
  }
  assert.deepEqual(fs.readdirSync(s.root, { recursive: true }).sort(), before, 'the queue writes nothing');
  assert.equal(T.pilotQueue(s.ws, { project: s.pid })[0].step, 'research', 'the desk\'s own queue is unchanged; the local claim holds the pause');
});

test('defaults: automation not paused, the standing exit-quote policy off, research Claude only', (t) => {
  const s = setup(t);
  // The paper mandate (automation.autonomous_paper_loop) is off by default and has no expiry;
  // the pilot runner's agent sessions are capped at 6 a day (corrective PR, 2026-10-31).
  assert.deepEqual(s.ws.settings.automation, { paused: false, exit_quotes_auto: false, autonomous_paper_loop: false, mandate: { expires_at: null, max_grants_per_day: 1, max_open_grants: 2, allowed_chains: ['ethereum', 'base', 'arbitrum', 'optimism', 'solana'] }, pilot_daily_sessions: 6 });
  assert.deepEqual(s.ws.settings.research.default_providers, ['claude']);
  assert.deepEqual(require('../core/forensics').autoExitQuotePlan(s.ws), { add: [], over_budget: [] });
  assert.ok(HOUR);
});

test('the standing exit-quote policy approves pilot projects only, within the monitor\'s monthly budget; off or paused, nothing', (t) => {
  const forensics = require('../core/forensics');
  const projects = require('../core/projects');
  const w = tempWorkspace('pilot-xq', { automation: { exit_quotes_auto: true } });
  t.after(w.cleanup);
  const hex = (s) => `0x${require('crypto').createHash('sha1').update(s).digest('hex')}`;
  const add = (name, symbol) => projects.addProject(w.ws, { name, symbol, official_website: `https://${symbol.toLowerCase()}.example.org/`, evidence: [{ url: `https://${symbol.toLowerCase()}.example.org/`, note: 'fictional' }], coingecko_id: `${symbol.toLowerCase()}-fictional`, assets: [{ chain: 'base', contract_address: hex(symbol) }] }).project_id;
  const a = add('Pilot One (FICTIONAL)', 'XPA');
  const b = add('Pilot Two (FICTIONAL)', 'XPB');
  const c = add('Not In Pilot (FICTIONAL)', 'XPC');
  // Enrollment approves its own target (setPilot); enrolled while paused it
  // approves none, so the standing policy is left both to place.
  w.ws.settings = { ...w.ws.settings, automation: { exit_quotes_auto: true, paused: true } };
  assert.equal(T.setPilot(w.ws, a, true).exit_quote.status, 'paused');
  T.setPilot(w.ws, b, true);
  w.ws.settings = { ...w.ws.settings, automation: { exit_quotes_auto: true, paused: false } };
  assert.deepEqual(forensics.autoExitQuotePlan(w.ws).add.map((x) => x.project_id).sort(), [a, b].sort(), 'never a project outside the pilot');
  // A budget that fits one project's quotes only.
  const per = (forensics.prefsOf(w.ws).exit_sizes_usd || []).length * Math.round((24 / forensics.monitorCfg(w.ws).quote_interval_hours) * 30);
  w.ws.settings = { ...w.ws.settings, forensics: { ...w.ws.settings.forensics, monitor: { ...w.ws.settings.forensics.monitor, monthly_request_budget: per } } };
  const plan = forensics.autoExitQuotePlan(w.ws);
  assert.equal(plan.add.length, 1);
  assert.equal(plan.over_budget.length, 1);
  const out = forensics.autoExitQuotes(w.ws);
  assert.equal(out.added.length, 1);
  assert.deepEqual(forensics.autoExitQuotePlan(w.ws).add, [], 'the budget is used: nothing more');
  assert.ok(c);
  // Paused, nothing is approved.
  w.ws.settings = { ...w.ws.settings, automation: { exit_quotes_auto: true, paused: true } };
  assert.deepEqual(forensics.autoExitQuotePlan(w.ws), { add: [], over_budget: [] });
});

test('the local runner stops before any agent when another runner holds the project', () => {
  const { runLocal } = require('../scripts/pilot');
  const calls = [];
  const call = (args) => {
    calls.push(args.slice(0, 2).join(' '));
    if (args[1] === 'queue') return { steps: [{ name: 'FICTIONAL', step: 'research', why: 'no report' }] };
    if (args[1] === 'claim') return { status: 'claimed', words: 'Another runner holds this project.' };
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  runLocal({ project: 'example-fictional', dryRun: false }, { call });
  assert.deepEqual(calls, ['tickets queue', 'tickets claim'], 'no research add, no prompt, no agent');
});
