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
const { parse, forcedTicket, runOnline, WEB_TOOLS } = require('../scripts/pilot');

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


// Online (cr-pilot-worker@1, corrective PR 2026-10-31): the runner talks to
// the desk's worker routes; each session gets the desk's frozen prompt and web
// tools only. A stand-in desk answers each route; nothing is run.
const DESK = 'https://desk.fictional.example';
const WTOKEN = 'FICTIONAL-worker-token-0000000000';
const O = (over = {}) => ({ project: 'olas', desk: 'online', deskUrl: DESK, model: null, timeoutMin: 1, forceProsecution: false, ownerWords: null, ...over });
const shaOf = (t) => require('crypto').createHash('sha256').update(t, 'utf8').digest('hex');

// steps: what each claim finds, in order. answers[op] overrides per call.
// completeSeq: what each complete call does in turn ('lose', 'changed',
// 'busy' for a 503, 'refuse' for a 400, 'ok'); past its end, 'ok'.
function workerDesk(steps, { prepare = {}, complete = {}, lose = new Set(), completeSeq = null, expires = '2099-01-01T00:00:00.000Z' } = {}) {
  const calls = [];
  let n = 0;
  let k = 0;
  const prompts = { research: 'FROZEN RESEARCH PROMPT (FICTIONAL) cr-research-prompt@6', ticket: 'FROZEN PROSECUTOR PROMPT (FICTIONAL) cr-ticket-prompt@1' };
  const fetchImpl = async (url, init) => {
    const op = url.slice(`${DESK}/api/pilot/worker/`.length);
    const body = JSON.parse(init.body);
    calls.push({ op, body, auth: init.headers.authorization });
    if (lose.has(op)) throw Object.assign(new Error('socket hang up'), { name: 'Error' });
    const json = (o) => ({ status: 200, ok: true, json: async () => ({ format: 'cr-pilot-worker@1', ...o }) });
    if (op === 'claim') {
      const step = steps[n] || 'pm_review';
      n += 1;
      if (['pm_review', 'done'].includes(step)) return json({ status: 'nothing', step });
      if (['paused', 'claimed', 'session_ceiling', 'reconcile'].includes(step)) return json({ status: step, step: 'research', words: `FICTIONAL ${step}` });
      return json({ status: 'claimed_now', step, key: `${step}:-`, token: 'a'.repeat(20), attempt_id: `pa_${n}`, expires_at: expires });
    }
    if (op === 'prepare') {
      const step = steps[n - 1];
      if (prepare[step]) return json(prepare[step]);
      const text = step === 'research' ? prompts.research : prompts.ticket;
      return json({ status: 'prepared', role: step === 'research' ? 'researcher' : 'prosecutor', attempt_id: `pa_${n}`, run_id: step === 'research' ? 'run_FICTIONAL' : null, ticket_id: step === 'research' ? null : 'tk_FICTIONAL', prompt: text, prompt_sha256: shaOf(text), sessions: { used: n, ceiling: 6 } });
    }
    if (op === 'complete') {
      const what = completeSeq ? completeSeq[k++] || 'ok' : 'ok';
      if (what === 'lose') throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
      if (what === 'busy') return { status: 503, ok: false, json: async () => ({ format: 'cr-pilot-worker@1', error: 'FICTIONAL busy', code: 'WORKSPACE_BUSY' }) };
      if (what === 'changed') return { status: 409, ok: false, json: async () => ({ format: 'cr-pilot-worker@1', error: 'This runner no longer holds the claim; nothing was dispatched.', code: 'CHANGED' }) };
      if (what === 'refuse') return { status: 400, ok: false, json: async () => ({ format: 'cr-pilot-worker@1', error: 'FICTIONAL refusal', code: 'INVALID' }) };
      return json(complete[steps[n - 1]] || { status: 'saved', report_id: 'rp_FICTIONAL', receipt_id: 'tr_FICTIONAL' });
    }
    if (op === 'release') return json({ status: 'released', outcome: body.outcome });
    return { status: 404, ok: false, json: async () => ({ error: 'Unknown API route' }) };
  };
  return { calls, fetchImpl, prompts };
}

test('online: research then a ticket are two sessions on the desk\'s frozen prompts, web tools only, no desk token', async () => {
  const d = workerDesk(['research', 'ticket', 'pm_review']);
  const runs = [];
  const r = await runOnline(O(), { run: (prompt, opts) => { runs.push({ prompt, opts }); return runs.length === 1 ? 'Report text about tokenomics (FICTIONAL).' : 'Ticket text (FICTIONAL).'; }, out: () => {}, fetchImpl: d.fetchImpl, token: WTOKEN });
  assert.deepEqual(r.sessions.map((s) => s.role), ['researcher', 'prosecutor']);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].prompt, d.prompts.research, 'the Researcher gets the run\'s frozen prompt byte for byte');
  assert.equal(runs[1].prompt, d.prompts.ticket, 'the Prosecutor gets the ticket\'s frozen prompt, nothing the Researcher said');
  for (const x of runs) {
    assert.deepEqual(x.opts.tools, WEB_TOOLS, 'web tools only: no connector, no desk tool');
    assert.ok(!x.prompt.includes(WTOKEN), 'the worker token never reaches a session');
  }
  assert.deepEqual(d.calls.map((c) => c.op), ['claim', 'prepare', 'complete', 'claim', 'prepare', 'complete', 'claim']);
  assert.ok(d.calls.every((c) => c.auth === `Bearer ${WTOKEN}`));
  const done = d.calls.filter((c) => c.op === 'complete');
  assert.deepEqual(done.map((c) => c.body.prompt_sha256), [shaOf(d.prompts.research), shaOf(d.prompts.ticket)], 'each answer names the prompt it answered');
});

// OP-2 (2026-11-02): JUP's report was lost to "fetch failed" at complete.
const os = require('os');
const pendingTmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pending-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('online: a lost answer to complete is asked again 5 times (1, 2, 4, 8, 16 s); the claim stays dispatched, the answer and claim are kept, no session runs again', async (t) => {
  const d = workerDesk(['research'], { lose: new Set(['complete']) });
  const dir = pendingTmp(t);
  let sessions = 0;
  const waits = [];
  const r = await runOnline(O(), { run: () => { sessions += 1; return 'Report (FICTIONAL).'; }, out: () => {}, fetchImpl: d.fetchImpl, token: WTOKEN, sleep: async (ms) => { waits.push(ms); }, pendingDir: dir });
  assert.equal(r.stop, 'reconcile');
  assert.equal(sessions, 1, 'no second session');
  assert.ok(!d.calls.some((c) => c.op === 'release'), 'an unknown outcome is never released by the runner');
  assert.equal(d.calls.filter((c) => c.op === 'complete').length, 6, 'one try and 5 retries');
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000]);
  assert.ok(d.calls.filter((c) => c.op === 'complete').every((c) => c.body.text === 'Report (FICTIONAL).' && c.body.token === 'a'.repeat(20)), 'the same answer under the same claim each time');
  assert.match(r.words, /online desk.*pilot-claim\/release.*reconciled/);
  assert.match(r.words, /kept at .*agent1-report\.md/);
  const files = fs.readdirSync(dir);
  assert.deepEqual(files, ['olas__pa_1.json']);
  assert.ok(r.words.includes(path.join(dir, 'olas__pa_1.json')));
  const raw = fs.readFileSync(path.join(dir, files[0]), 'utf8');
  assert.ok(!raw.includes(WTOKEN), 'the worker token is never written');
  const rec = JSON.parse(raw);
  assert.equal(rec.format, 'cr-pilot-pending@1');
  assert.deepEqual([rec.project_id, rec.attempt_id, rec.role, rec.run_id, rec.claim_token, rec.text], ['olas', 'pa_1', 'researcher', 'run_FICTIONAL', 'a'.repeat(20), 'Report (FICTIONAL).']);
  assert.equal(rec.prompt_sha256, shaOf(d.prompts.research));
  assert.equal(rec.text_sha256, shaOf('Report (FICTIONAL).'));
  assert.equal(rec.attempts.length, 6);
});

test('online: complete that lands on a retry is saved and the runner goes on', async (t) => {
  const d = workerDesk(['research', 'pm_review'], { completeSeq: ['lose', 'busy', 'ok'] });
  const dir = pendingTmp(t);
  const waits = [];
  const lines = [];
  const r = await runOnline(O(), { run: () => 'Report (FICTIONAL).', out: (s) => lines.push(s), fetchImpl: d.fetchImpl, token: WTOKEN, sleep: async (ms) => { waits.push(ms); }, pendingDir: dir });
  assert.equal(r.stop, null);
  assert.deepEqual(waits, [1000, 2000]);
  assert.deepEqual(d.calls.map((c) => c.op), ['claim', 'prepare', 'complete', 'complete', 'complete', 'claim']);
  assert.ok(lines.some((s) => /fetch failed: ECONNRESET/.test(s)), 'the lost answer\'s cause is kept in the words');
  assert.ok(lines.some((s) => /saved: saved rp_FICTIONAL/.test(s)));
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing pending');
});

test('online: a claim no longer held after a lost answer stops for Eric (the lost try may have saved it); a refusal is never asked again', async (t) => {
  const a = workerDesk(['research'], { completeSeq: ['lose', 'changed'] });
  const r1 = await runOnline(O(), { run: () => 'Report (FICTIONAL).', out: () => {}, fetchImpl: a.fetchImpl, token: WTOKEN, sleep: async () => {}, pendingDir: pendingTmp(t) });
  assert.equal(r1.stop, 'reconcile');
  assert.match(r1.words, /may have saved it/);
  assert.equal(a.calls.filter((c) => c.op === 'complete').length, 2);
  const b = workerDesk(['research'], { completeSeq: ['refuse'] });
  const waits = [];
  const r2 = await runOnline(O(), { run: () => 'Report (FICTIONAL).', out: () => {}, fetchImpl: b.fetchImpl, token: WTOKEN, sleep: async (ms) => { waits.push(ms); }, pendingDir: pendingTmp(t) });
  assert.equal(r2.stop, 'reconcile');
  assert.equal(b.calls.filter((c) => c.op === 'complete').length, 1, 'a 4xx is the desk\'s answer, not asked again');
  assert.deepEqual(waits, []);
});

test('online: complete is not asked again past the claim\'s expiry', async (t) => {
  let clock = Date.parse('2026-11-02T00:00:00.000Z');
  const d = workerDesk(['research'], { lose: new Set(['complete']), expires: '2026-11-02T00:00:05.000Z' });
  const waits = [];
  const r = await runOnline(O(), { run: () => 'Report (FICTIONAL).', out: () => {}, fetchImpl: d.fetchImpl, token: WTOKEN, now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; }, pendingDir: pendingTmp(t) });
  assert.equal(r.stop, 'reconcile');
  assert.deepEqual(waits, [1000, 2000], 'the 4 s wait would reach the expiry at 5 s');
  assert.equal(d.calls.filter((c) => c.op === 'complete').length, 3);
});

test('online: a lost answer to prepare is uncertain too; nothing runs, nothing is released', async () => {
  const d = workerDesk(['research'], { lose: new Set(['prepare']) });
  const r = await runOnline(O(), { run: () => assert.fail('no session'), out: () => {}, fetchImpl: d.fetchImpl, token: WTOKEN });
  assert.equal(r.stop, 'reconcile');
  assert.ok(!d.calls.some((c) => c.op === 'release'));
});

test('online: a session that timed out is uncertain; one that failed is released as agent_failed', async () => {
  const a = workerDesk(['research']);
  const t1 = await runOnline(O(), { run: () => { throw Object.assign(new Error('claude -p did not finish (ETIMEDOUT) within 1 minutes.'), { uncertain: true }); }, out: () => {}, fetchImpl: a.fetchImpl, token: WTOKEN });
  assert.equal(t1.stop, 'reconcile');
  assert.ok(!a.calls.some((c) => c.op === 'release' || c.op === 'complete'));
  const b = workerDesk(['research']);
  const t2 = await runOnline(O(), { run: () => { throw new Error('claude -p stopped (exit 1): FICTIONAL'); }, out: () => {}, fetchImpl: b.fetchImpl, token: WTOKEN });
  assert.equal(t2.stop, 'agent_failed');
  assert.deepEqual(b.calls.filter((c) => c.op === 'release').map((c) => c.body.outcome), ['agent_failed']);
  assert.ok(!b.calls.some((c) => c.op === 'complete'));
});

test('online: a prompt that did not arrive whole runs no session', async () => {
  const d = workerDesk(['research'], { prepare: { research: { status: 'prepared', role: 'researcher', attempt_id: 'pa_1', run_id: 'run_FICTIONAL', prompt: 'TRUNCATED', prompt_sha256: 'f'.repeat(64) } } });
  const r = await runOnline(O(), { run: () => assert.fail('no session'), out: () => {}, fetchImpl: d.fetchImpl, token: WTOKEN });
  assert.equal(r.stop, 'integrity');
  assert.deepEqual(d.calls.map((c) => c.op), ['claim', 'prepare', 'release']);
});

test('online: a paused desk, another runner\'s claim or the day\'s ceiling dispatch nothing', async () => {
  for (const s of ['paused', 'claimed', 'session_ceiling', 'reconcile']) {
    const d = workerDesk([s]);
    const r = await runOnline(O(), { run: () => assert.fail('no session'), out: () => {}, fetchImpl: d.fetchImpl, token: WTOKEN });
    assert.equal(r.stop, s, s);
    assert.deepEqual(d.calls.map((c) => c.op), ['claim'], s);
  }
});

test('online: the override is local only, and --dry-run runs and asks nothing', async () => {
  await assert.rejects(runOnline(O({ forceProsecution: true }), { run: () => assert.fail('no session'), out: () => {}, fetchImpl: () => assert.fail('no request'), token: WTOKEN }), /local only/);
  const lines = [];
  const r = await runOnline(O({ dryRun: true }), { run: () => assert.fail('nothing runs'), out: (s) => lines.push(s), fetchImpl: () => assert.fail('no request') });
  assert.deepEqual(r.sessions, []);
  assert.match(lines[0], /web|WebSearch/);
});
