#!/usr/bin/env node
'use strict';
// The autonomous pilot, from PowerShell in one command:
//
//   npm run pilot -- --project=olas                 this folder's desk (local)
//   npm run pilot -- --project=olas --desk=online   the online desk, through its
//                                                   worker routes (cr-pilot-worker@1)
//   npm run pilot -- --project=olas --dry-run       say what would run, run nothing
//   npm run pilot -- --pilot-all --desk=online      every pilot project: a zero-token
//                                                   pre-poll first, then at most
//                                                   --max-agents (2) claude -p sessions
//   npm run pilot -- --project=olas --force-prosecution --owner-words="…"
//                                                   a Prosecutor although the desk's
//                                                   gate closed on the grade (Eric's
//                                                   override; the gate still sizes)
//
// It runs the two-agent chain with Claude Code (`claude -p`) on Eric's own
// Claude subscription: no API key, nothing billed by the desk.
//
//   Agent 1 (Researcher)  Claude's investment research under the run's frozen
//                         prompt (cr-research-prompt@6), when Claude's report is
//                         missing, stale or a Claude run is open.
//   Agent 2 (Prosecutor)  Claude under the ticket's frozen prompt
//                         (cr-ticket-prompt@1), in a separate `claude -p`
//                         session that never sees Agent 1's session.
//
// Local: every record change goes through `node dashboard/cli.js` and is
// verified by it. Online: the runner takes the online desk's claim and the
// frozen prompt through the worker routes (core/pilot-worker.js) and runs
// each step in a fresh `claude -p` session with web tools only; the desk
// saves and verifies the answer. Either way each session is reserved against
// the day's ceiling before it starts (automation.pilot_daily_sessions), the
// Researcher's and the Prosecutor's sessions share no transcript and hold no
// desk credential, and the chain stops at Eric's PM review: it never decides
// a ticket, places an order or moves money.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const CLI = path.join(ROOT, 'dashboard', 'cli.js');
const WEB_TOOLS = ['WebSearch', 'WebFetch'];
const MAX_STEPS = 4;

// Eric's override (2026-10-25): a Prosecutor writes the trade plan although the
// pre-gate closed on the grade. The desk's gate still sizes it ($0 under the
// floor); nothing here chooses an amount.
const FORCE_WORDS = 'Eric (2026-10-25): when Claude\'s @6 grade is 50 or more, or its range reaches 55, the Prosecutor writes the trade plan although the desk\'s gate closed on the grade; the gate still sizes it.';

function parse(argv) {
  const out = { desk: 'local', dryRun: false, model: null, connector: 'mcp__claude_ai_CryptoResearch', timeoutMin: 60, forceProsecution: false, ownerWords: null, pilotAll: false, maxAgents: 2, deskUrl: null };
  for (const a of argv) {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    const v = rest.join('=');
    if (k === 'project') out.project = v;
    else if (k === 'desk') out.desk = v;
    else if (k === 'dry-run') out.dryRun = true;
    else if (k === 'force-prosecution') out.forceProsecution = true;
    else if (k === 'owner-words') out.ownerWords = v || null;
    else if (k === 'model') out.model = v;
    else if (k === 'connector') out.connector = v;
    else if (k === 'timeout-min') out.timeoutMin = Number(v) || out.timeoutMin;
    else if (k === 'pilot-all') out.pilotAll = true;
    else if (k === 'max-agents') out.maxAgents = Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 10 ? Number(v) : out.maxAgents;
    else if (k === 'desk-url') out.deskUrl = v || null;
    else if (k === 'help') out.help = true;
  }
  return out;
}

const say = (s) => process.stdout.write(`${s}\n`);

function cli(args, { text = false } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`cli ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.stdout || '').trim().slice(0, 600)}`);
  if (text) return r.stdout;
  try {
    return JSON.parse(r.stdout);
  } catch (_) {
    throw new Error(`cli ${args.slice(0, 2).join(' ')} did not answer JSON: ${r.stdout.slice(0, 300)}`);
  }
}

// The Claude Code executable, found without a shell (a shell option is Node's
// DEP0190 warning). Elsewhere `claude` on PATH; on Windows the real claude.exe,
// from PATH or its usual install folders (a .cmd shim needs a shell).
function resolveClaude({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (platform !== 'win32') return 'claude';
  const win = path.win32;
  const dirs = String(env.PATH || env.Path || '').split(';').filter(Boolean);
  const home = env.USERPROFILE || '';
  const known = [home && win.join(home, '.local', 'bin'), env.LOCALAPPDATA && win.join(env.LOCALAPPDATA, 'Programs', 'claude'), env.LOCALAPPDATA && win.join(env.LOCALAPPDATA, 'AnthropicClaude')].filter(Boolean);
  for (const d of [...dirs, ...known]) {
    const f = win.join(d, 'claude.exe');
    if (exists(f)) return f;
  }
  throw new Error('claude.exe was not found on PATH or in its usual install folders. Install Claude Code, or add its folder to PATH.');
}

// One `claude -p` session: the prompt on stdin (a frozen prompt is far longer
// than a Windows command line), only the tools named, the answer as text.
function claude(prompt, { tools, model, timeoutMin }) {
  const args = ['-p', '--output-format', 'text', '--allowedTools', tools.join(',')];
  if (model) args.push('--model', model);
  const r = spawnSync(resolveClaude(), args, { cwd: os.tmpdir(), input: prompt, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMin * 60000 });
  // A session that timed out or was stopped by a signal may still have been
  // working: its outcome is uncertain, never retried.
  if ((r.error && r.error.code === 'ETIMEDOUT') || r.signal) throw Object.assign(new Error(`claude -p did not finish (${r.error ? r.error.code : r.signal}) within ${timeoutMin} minutes.`), { uncertain: true });
  if (r.error) throw new Error(`claude -p could not run: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`claude -p stopped (exit ${r.status}): ${(r.stderr || '').trim().slice(0, 600)}`);
  return r.stdout;
}

// Each role's own scratch (cr-pilot-isolation@1): <temp>/cr-pilot/<role>/, one
// folder per run or ticket, the same folders the role guard keeps apart.
function scratch(role, name, text) {
  const base = path.join(os.tmpdir(), 'cr-pilot', role);
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'run-'));
  const f = path.join(dir, name);
  fs.writeFileSync(f, text);
  return f;
}

// With Eric's override, the gate's own step and an undecided desk-gate receipt
// on Claude's current report both become a Prosecutor ticket. A desk gate he
// already decided (pass, watch) is his answer and is left alone.
function forcedTicket(step, ticket, o) {
  if (!o.forceProsecution) return false;
  if (step.step === 'gate_closed') return true;
  return step.step === 'pm_review' && Boolean(ticket && ticket.desk_gate === true && ticket.status === 'pending_pm_review');
}

// The claim's answers that stop the runner (cr-pilot-claim@1): another runner
// holds the project, an expired dispatch waits to be reconciled, the one
// correction was used, or Eric paused automation.
const CLAIM_STOPS = new Set(['claimed', 'reconcile', 'correction_limit', 'paused', 'session_ceiling', 'sessions_unknown']);

// A claim not yet bound is let go when the runner stops; a bound one (an
// agent was dispatched and its outcome is unknown) is left to expire, so the
// next runner reconciles instead of dispatching it again.
function runLocal(o, { call = cli, agent = claude } = {}) {
  const h = { token: null, bound: false };
  try {
    return localSteps(o, call, h, agent);
  } finally {
    if (h.token && !h.bound) call(['tickets', 'release', o.project, '--token', h.token, '--outcome', 'stopped']);
  }
}

// o.budget ({ left }), from --pilot-all: the claude -p sessions this run may
// still start. A step that would start one when none is left is not claimed.
// Returns { stop, words } when a claim or the budget stopped it.
function localSteps(o, cli, h, agent = claude) {
  const run = (prompt, opts) => {
    if (o.budget) o.budget.left -= 1;
    return agent(prompt, opts);
  };
  for (let i = 0; i < MAX_STEPS; i++) {
    const q = cli(['tickets', 'queue', o.project]);
    let s = q.steps[0];
    if (!s) throw new Error(`No project ${o.project} on this desk.`);
    say(`[${i + 1}] ${s.name}: ${s.step} — ${s.why}`);
    let token = null;
    if (!o.dryRun && o.budget && o.budget.left <= 0 && ['research', 'ticket', 'ticket_failed'].includes(s.step)) {
      say('    Not dispatched: this run\'s agent cap is reached; the next run takes it.');
      return { stop: 'cap', words: 'agent cap reached' };
    }
    if (!o.dryRun && ['research', 'ticket', 'ticket_failed', 'gate_closed'].includes(s.step)) {
      const c = cli(['tickets', 'claim', o.project, '--owner', `pilot ${process.pid}`, ...(s.force ? ['--force-prosecution'] : [])]);
      if (CLAIM_STOPS.has(c.status)) { say(`    Not dispatched: ${c.words}`); return { stop: c.status, words: c.words || null }; }
      if (c.status !== 'claimed_now') { say(`    Not dispatched: ${c.words || c.status}`); return { stop: c.status || 'unknown', words: c.words || null }; }
      token = c.token;
      Object.assign(h, { token, bound: false });
    }
    const bind = (args) => { if (token) { cli(['tickets', 'bind', o.project, '--token', token, ...args]); h.bound = true; } };
    const done = () => { if (token) { cli(['tickets', 'release', o.project, '--token', token]); Object.assign(h, { token: null, bound: false }); } };
    const inForce = o.forceProsecution && s.step === 'pm_review' ? cli(['tickets', 'view', o.project]).ticket : null;
    if (forcedTicket(s, inForce, o)) {
      say('    Eric\'s override: a Prosecutor writes the trade plan; the desk\'s gate still sizes it.');
      s = { ...s, step: 'ticket', force: true };
    }
    if (s.step === 'research') {
      let runId = s.run_id;
      if (o.dryRun) return say('    would run Agent 1 (Claude research) with claude -p, then import it.');
      if (!runId) {
        const r = cli(['research', 'add', o.project, '--providers', 'claude', '--channel', 'cowork', '--utterance', 'autonomous pilot (npm run pilot)']);
        runId = r.run_id;
        say(`    research run ${runId} (${r.status})`);
      }
      bind(['--run', runId]);
      const prompt = cli(['research', 'prompt', o.project, runId], { text: true });
      say(`    Agent 1: claude -p on the frozen research prompt (${prompt.length} characters)…`);
      const report = run(prompt, { tools: WEB_TOOLS, model: o.model, timeoutMin: o.timeoutMin });
      const f = scratch('researcher', 'agent1-report.md', report);
      const saved = cli(['import-text', '--provider', 'claude', '--project', o.project, '--text-file', f, '--run', runId]);
      say(`    saved: ${saved.status}${saved.report_id ? ` ${saved.report_id}` : ''}${saved.message ? ` — ${saved.message}` : ''}`);
      if (saved.verified === false) throw new Error('The report did not read back as written; run the pilot again (an identical save is recognized).');
      done();
      continue;
    }
    if (s.step === 'gate_closed') {
      if (o.dryRun) return say('    would save the desk\'s gate receipt (no Prosecutor runs).');
      const g = cli(['tickets', 'start', o.project, '--utterance', 'autonomous pilot (npm run pilot)']);
      say(`    desk gate: ${g.status} ${g.receipt_id || ''} — ${g.message}`);
      if (g.verified === false) throw new Error('The desk\'s gate receipt did not read back as written; run the pilot again.');
      done();
      continue;
    }
    if (s.step === 'ticket_failed') say(`    the last save was refused${s.refused_field ? ` (${s.refused_field})` : ''}: running the Prosecutor again on ${s.ticket_id}.`);
    if (s.step === 'ticket' || s.step === 'ticket_failed') {
      if (o.dryRun) return say('    would run Agent 2 (the Prosecutor) with claude -p, then save the ticket.');
      const t = cli(['tickets', 'start', o.project, ...(s.refresh ? ['--reopen'] : []), ...(s.force ? ['--force-prosecution'] : []), '--assistant', '--mode', 'cli', '--utterance', s.force ? (o.ownerWords || FORCE_WORDS) : 'autonomous pilot (npm run pilot)']);
      if (!t.ticket_id) throw new Error(t.message);
      bind(['--ticket', t.ticket_id]);
      const prompt = cli(['tickets', 'prompt', o.project, t.ticket_id], { text: true });
      say(`    Agent 2: claude -p on the frozen Prosecutor prompt ${t.ticket_id} (${prompt.length} characters)…`);
      const ticket = run(prompt, { tools: WEB_TOOLS, model: o.model, timeoutMin: o.timeoutMin });
      const f = scratch('prosecutor', 'agent2-ticket.md', ticket);
      const saved = cli(['tickets', 'import', o.project, t.ticket_id, '--text-file', f]);
      say(`    saved: ${saved.status} ${saved.receipt_id || ''} — ${saved.message}`);
      if (saved.verified === false) throw new Error('The ticket did not read back as written; run the pilot again.');
      done();
      continue;
    }
    say(s.step === 'pm_review' ? '    Done: the ticket waits for your PM review (inspector > PM decision).' : '    Nothing for the agents to do.');
    return;
  }
  say(`Stopped after ${MAX_STEPS} steps.`);
}

// Online (cr-pilot-worker@1, corrective PR 2026-10-31): the runner, not an
// agent, talks to the online desk, with the worker token (pilot_worker_token
// in %USERPROFILE%\.cryptoresearch\secrets.json, never printed). For each
// step it takes the desk's own claim (claim), has the desk open the run or
// ticket and hand back the exact frozen prompt (prepare: the desk reserves
// the day's session before it answers), runs that prompt in a fresh
// `claude -p` session with web tools only (no connector, no desk token,
// nothing of another session), and gives the answer back for the desk to
// save and verify (complete). The Researcher's and the Prosecutor's sessions
// are separate processes that share nothing but the desk's frozen records.
//
// Uncertainty is kept, never retried: a lost or timed-out answer from the
// desk, or a session that timed out, leaves the claim dispatched for Eric to
// reconcile on the online desk; nothing is run again by itself. A session
// that failed outright (it could save nothing: it has no desk tools) is
// released as agent_failed; its session still counts against the day.
// Eric's override (--force-prosecution) is local only.
const WORKER_FORMAT = 'cr-pilot-worker@1';
const ONLINE_RECONCILE = (pid) => `Check ${pid} on the online desk, then release it there as reconciled (signed in: POST /api/projects/${pid}/pilot-claim/release with {"reconciled":true}); nothing is run again until then.`;
const sha256 = (t) => require('crypto').createHash('sha256').update(t, 'utf8').digest('hex');

// The worker token, from %USERPROFILE%\.cryptoresearch\secrets.json
// (pilot_worker_token). Never printed or logged, never given to a session.
function readWorkerToken(file = path.join(homeDir(), 'secrets.json')) {
  let s = null;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { throw new Error(`The worker token could not be read from ${file} (${err.code || 'unreadable'}).`); }
  const t = s && typeof s.pilot_worker_token === 'string' ? s.pilot_worker_token.trim() : '';
  if (t.length < 16) throw new Error(`${file} holds no pilot_worker_token.`);
  return t;
}

// One worker request. A desk that did not answer, answered 5xx or answered
// something unreadable is `uncertain` (the request may have been carried
// out); a 4xx is the desk's refusal, with its code.
async function workerCall(fetchImpl, desk, token, op, body, { timeoutMs = 120000 } = {}) {
  let res;
  try {
    res = await fetchImpl(`${desk}/api/pilot/worker/${op}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw Object.assign(new Error(`The online desk did not answer ${op} (${err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : String(err && err.message || err).slice(0, 120)}).`), { uncertain: true });
  }
  let json = null;
  try { json = await res.json(); } catch (_) { json = null; }
  if (res.status >= 500 || (res.ok && (!json || json.format !== WORKER_FORMAT))) throw Object.assign(new Error(`The online desk's answer to ${op} is not settled (${res.status}${json && json.error ? `: ${String(json.error).slice(0, 200)}` : ''}).`), { uncertain: true, status: res.status });
  if (!res.ok) throw Object.assign(new Error(`The online desk refused ${op} (${res.status}${json && json.code ? ` ${json.code}` : ''}${res.status === 404 ? ', CR_PILOT_WORKER_TOKEN_SHA256 is not set on the desk' : ''}): ${json && json.error ? String(json.error).slice(0, 300) : 'no reason given'}`), { status: res.status, code: (json && json.code) || null });
  return json;
}

async function runOnline(o, { run = claude, out = say, fetchImpl = globalThis.fetch, token = null, env = process.env } = {}) {
  if (o.forceProsecution) throw new Error('Eric\'s override (--force-prosecution) is local only: the online worker never forces a Prosecutor.');
  const desk = deskUrlOf(o, env);
  const result = { sessions: [], stop: null, words: null, claims: [] };
  if (o.dryRun) {
    out(`Would claim ${o.project}'s next step on ${desk}, have the desk prepare its frozen prompt, run it in a fresh claude -p session with ${WEB_TOOLS.join(', ')} only, and give the answer back to the desk to save and verify.`);
    return result;
  }
  const tok = token || readWorkerToken();
  const post = (op, body, opts) => workerCall(fetchImpl, desk, tok, op, { project_id: o.project, ...body }, opts);
  const stop = (kind, words) => { Object.assign(result, { stop: kind, words }); out(`    Not dispatched: ${words}`); return result; };
  for (let i = 0; i < MAX_STEPS; i++) {
    if (o.budget && o.budget.left <= 0) return stop('cap', 'this run\'s agent cap is reached; the next run takes it.');
    const c = await post('claim', { owner: `pilot ${process.pid}` });
    if (c.status === 'nothing') {
      out(c.step === 'pm_review' ? 'Done: the ticket waits for your PM review (inspector > PM decision).' : `Nothing for the agents to do (${c.step || 'no step'}).`);
      return result;
    }
    if (c.status !== 'claimed_now') return stop(c.status, c.words || c.status);
    result.claims.push({ attempt_id: c.attempt_id, key: c.key });
    out(`[${i + 1}] ${o.project}: ${c.step}, claim ${c.attempt_id} (${c.key}) until ${c.expires_at}`);
    let p;
    try {
      p = await post('prepare', { token: c.token });
    } catch (err) {
      if (err.uncertain) return stop('reconcile', `${err.message} Whether the desk reserved a session and opened the record is unknown. ${ONLINE_RECONCILE(o.project)}`);
      try { await post('release', { token: c.token, outcome: 'stopped' }); } catch (_) { /* it expires */ }
      return stop(err.code || 'refused', err.message);
    }
    if (p.status === 'gate_closed') { out(`    desk gate: ${p.receipt_id || ''} — ${p.words || ''}`); continue; }
    if (p.status !== 'prepared') return stop(p.status, p.words || p.status);
    const rec = p.run_id || p.ticket_id;
    if (typeof p.prompt !== 'string' || sha256(p.prompt) !== p.prompt_sha256) {
      try { await post('release', { token: c.token, outcome: 'agent_failed' }); } catch (_) { /* it expires */ }
      return stop('integrity', `The frozen prompt for ${rec} did not arrive whole (its SHA-256 does not match); no session was run.`);
    }
    if (o.budget) o.budget.left -= 1;
    out(`    ${p.role === 'researcher' ? 'Agent 1 (Researcher)' : 'Agent 2 (Prosecutor)'}: a fresh claude -p session on the frozen prompt of ${rec} (${p.prompt.length} characters, SHA-256 ${p.prompt_sha256.slice(0, 12)}…), tools ${WEB_TOOLS.join(', ')} only; day's sessions ${p.sessions ? `${p.sessions.used}/${p.sessions.ceiling}` : '?'}`);
    result.sessions.push({ role: p.role, attempt_id: p.attempt_id, run_id: p.run_id || null, ticket_id: p.ticket_id || null, prompt_sha256: p.prompt_sha256 });
    let answer;
    try {
      answer = run(p.prompt, { tools: WEB_TOOLS, model: o.model, timeoutMin: o.timeoutMin });
    } catch (err) {
      if (err && err.uncertain) return stop('reconcile', `${err.message} ${ONLINE_RECONCILE(o.project)}`);
      try { await post('release', { token: c.token, outcome: 'agent_failed' }); } catch (_) { /* it expires and waits to be reconciled */ }
      return stop('agent_failed', `${String(err && err.message || err).slice(0, 300)} The session saved nothing (it has no desk tools); its claim was let go and its session still counts today.`);
    }
    const f = scratch(p.role, p.role === 'researcher' ? 'agent1-report.md' : 'agent2-ticket.md', answer);
    let done;
    try {
      done = await post('complete', { token: c.token, prompt_sha256: p.prompt_sha256, text: answer }, { timeoutMs: 300000 });
    } catch (err) {
      return stop('reconcile', `${err.message} The session's answer is kept at ${f}. ${ONLINE_RECONCILE(o.project)}`);
    }
    out(`    saved: ${done.status} ${done.report_id || done.receipt_id || ''}${done.words ? ` — ${done.words}` : ''}`);
    if (done.status === 'unverified') return stop('reconcile', `${done.words || 'The save did not verify.'} The session's answer is kept at ${f}.`);
    if (done.status !== 'saved') return stop(done.status || 'refused', `${done.words || 'The desk did not save it.'} The session's answer is also kept at ${f}.`);
  }
  out(`Stopped after ${MAX_STEPS} steps.`);
  return result;
}

// ---------------------------------------------------------------------------
// --pilot-all (autonomous paper playbook, Stage 11): every pilot project, one
// instance at a time. A zero-token pre-poll first (locally tickets queue;
// online GET /api/pilot/queue with the poll token), then, unless paused, the
// steps closest to a trade first (ticket, ticket_failed, gate_closed, then
// research), each through the per-project path above and its claim, at most
// --max-agents claude -p sessions in the run. A project another runner holds,
// whose correction is used, or whose earlier dispatch expired with no known
// outcome spawns nothing; the last is listed for Eric and exits 3, and is
// never released here. One JSON line per run goes to
// %USERPROFILE%\.cryptoresearch\pilot-all.jsonl, never into the desk's records.
// Exit codes: 0 done or nothing to do; 3 needs Eric; 1 an error.
const ALL_ORDER = Object.freeze(['ticket', 'ticket_failed', 'gate_closed', 'research']);
const CLAIM_SKIP = new Set(['claimed', 'reconcile', 'correction_limit']);
const LOCK_STALE_MS = 3 * 3600000;
const DEFAULT_DESK_URL = 'https://cryptoresearch.onrender.com';
const RECONCILE_WORDS = 'An earlier dispatch expired with no known outcome (often after the PC slept). Check the desk, then release it: node dashboard/cli.js tickets release <project> --reconciled.';
const homeDir = () => path.join(os.homedir(), '.cryptoresearch');
const lockPath = () => path.join(os.tmpdir(), 'cr-pilot', 'pilot-all.lock');
const pilotLogPath = () => path.join(homeDir(), 'pilot-all.jsonl');

// The run's lock: created exclusively. One older than 3 hours (or unreadable)
// is reported and taken over; any other is another run in progress.
function takeLock(file, { now = Date.now(), pid = process.pid } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rec = JSON.stringify({ pid, started_at: new Date(now).toISOString() });
  try {
    fs.writeFileSync(file, rec, { flag: 'wx' });
    return { ok: true };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  let cur = null;
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { cur = null; }
  const at = cur ? Date.parse(cur.started_at) : NaN;
  if (Number.isFinite(at) && now - at < LOCK_STALE_MS) return { ok: false, held: cur };
  fs.writeFileSync(file, rec);
  return { ok: true, took_over: cur || { unreadable: true } };
}
function dropLock(file, pid = process.pid) {
  try {
    const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cur && cur.pid === pid) fs.unlinkSync(file);
  } catch (_) { /* gone already */ }
}

// The poll token from %USERPROFILE%\.cryptoresearch\secrets.json
// (pilot_poll_token). Never printed or logged.
function readPollToken(file = path.join(homeDir(), 'secrets.json')) {
  let s = null;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { throw new Error(`The poll token could not be read from ${file} (${err.code || 'unreadable'}).`); }
  const t = s && typeof s.pilot_poll_token === 'string' ? s.pilot_poll_token.trim() : '';
  if (t.length < 16) throw new Error(`${file} holds no pilot_poll_token.`);
  return t;
}

function deskUrlOf(o, env = process.env) {
  const raw = o.deskUrl || env.CR_DESK_URL || DEFAULT_DESK_URL;
  let u;
  try { u = new URL(raw); } catch (_) { throw new Error(`"${raw}" is not the desk's address.`); }
  if (u.protocol !== 'https:' || (u.pathname !== '/' && u.pathname !== '') || u.search) throw new Error('The desk address is its https origin only, for example https://your-desk.onrender.com');
  return u.origin;
}

// The pre-poll, zero tokens: { paused, steps: [{ project_id, step, claim }] }.
async function pollOnline(o, { fetchImpl = globalThis.fetch, token, env = process.env } = {}) {
  const res = await fetchImpl(`${deskUrlOf(o, env)}/api/pilot/queue`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  if (res.status !== 200) throw new Error(`The online desk's pilot poll answered ${res.status}${res.status === 404 ? ' (CR_PILOT_POLL_TOKEN_SHA256 is not set on the desk)' : res.status === 401 ? ' (the poll token was refused)' : ''}.`);
  const body = await res.json();
  if (!body || body.format !== 'cr-pilot-poll@1' || !Array.isArray(body.steps)) throw new Error('The online desk\'s pilot poll did not answer cr-pilot-poll@1.');
  return { paused: body.paused === true, sessions: body.sessions || null, steps: body.steps.map((s) => ({ project_id: s.project_id, step: s.step, claim: s.claim || null })) };
}
function pollLocal(call) {
  const q = call(['tickets', 'queue']);
  const claims = (q && q.claims) || {};
  return { paused: q.paused === true, sessions: q.sessions || null, steps: (q.steps || []).map((s) => ({ project_id: s.project_id, step: s.step, claim: claims[s.project_id] || null })) };
}

async function runAll(o, {
  call = cli, agent = claude, fetchImpl = globalThis.fetch, token = null, workerToken = null, env = process.env,
  lockFile = lockPath(), logFile = pilotLogPath(), out = say, now = () => Date.now(), pid = process.pid,
  runLocalImpl = runLocal, runOnlineImpl = runOnline,
} = {}) {
  const log = { format: 'cr-pilot-all@1', started_at: new Date(now()).toISOString(), desk: o.desk, max_agents: o.maxAgents, dry_run: Boolean(o.dryRun), paused: null, polled: [], dispatches: [], needs_eric: [], error: null, exit: null };
  const finish = (code) => {
    log.exit = code;
    log.finished_at = new Date(now()).toISOString();
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, `${JSON.stringify(log)}\n`);
    } catch (err) {
      out(`The run's log could not be written (${err.code || err.message}).`);
    }
    return code;
  };
  if (!['local', 'online'].includes(o.desk)) { log.error = '--desk is local or online.'; out(`pilot-all: ${log.error}`); return finish(1); }
  const lock = takeLock(lockFile, { now: now(), pid });
  if (!lock.ok) {
    out(`Another run is in progress (pid ${lock.held.pid}, since ${lock.held.started_at}); nothing is dispatched.`);
    log.skipped = 'locked';
    return finish(0);
  }
  if (lock.took_over) out(`A lock ${lock.took_over.unreadable ? 'that did not read' : `from pid ${lock.took_over.pid} since ${lock.took_over.started_at}`} was older than 3 hours; taken over.`);
  try {
    let tok = null;
    const poll = async () => {
      if (o.desk === 'local') return pollLocal(call);
      if (!tok) tok = token || readPollToken();
      return pollOnline(o, { fetchImpl, token: tok, env });
    };
    const q = await poll();
    log.paused = q.paused;
    log.polled = q.steps.map((s) => ({ project_id: s.project_id, step: s.step, claim: s.claim }));
    out(`Pre-poll (${o.desk}): ${q.steps.length} pilot project${q.steps.length === 1 ? '' : 's'}${q.steps.length ? `: ${q.steps.map((s) => `${s.project_id} ${s.step}${s.claim ? ` (${s.claim})` : ''}`).join(', ')}` : ''}.`);
    if (q.paused) {
      out('Automation is paused on the desk: no agent is dispatched until you resume it.');
      return finish(0);
    }
    const reconcileWords = (pid) => (o.desk === 'online' ? `An earlier dispatch on the online desk has no known outcome (often after the PC slept, or a lost answer). ${ONLINE_RECONCILE(pid)}` : RECONCILE_WORDS);
    for (const s of q.steps) if (s.claim === 'reconcile') log.needs_eric.push({ project_id: s.project_id, step: s.step, words: reconcileWords(s.project_id) });
    // The day's session ceiling, as the desk counts it (the claim decides).
    log.sessions = q.sessions || null;
    const noSessions = Boolean(q.sessions && (q.sessions.unreadable || q.sessions.left <= 0));
    if (noSessions) out(q.sessions.unreadable ? 'The desk\'s session ledger does not read: no agent session is started until it is repaired.' : `Today's ${q.sessions.ceiling} agent sessions are used (${q.sessions.day}): no session is started until tomorrow.`);
    const todo = q.steps.filter((s) => ALL_ORDER.includes(s.step) && !CLAIM_SKIP.has(s.claim)).sort((a, b) => ALL_ORDER.indexOf(a.step) - ALL_ORDER.indexOf(b.step));
    if (!todo.length) out('Nothing for the agents to do.');
    const budget = { left: o.maxAgents };
    for (const s of todo) {
      if (o.dryRun) {
        out(`Would dispatch ${s.project_id}: ${s.step}.`);
        log.dispatches.push({ project_id: s.project_id, step: s.step, outcome: 'dry_run' });
        continue;
      }
      if (noSessions && s.step !== 'gate_closed') {
        log.dispatches.push({ project_id: s.project_id, step: s.step, outcome: 'session_ceiling' });
        continue;
      }
      if (budget.left <= 0 && s.step !== 'gate_closed') {
        out(`${s.project_id} (${s.step}) waits for the next run: the ${o.maxAgents}-agent cap is reached.`);
        log.dispatches.push({ project_id: s.project_id, step: s.step, outcome: 'cap' });
        continue;
      }
      out(`== ${s.project_id}: ${s.step}`);
      const before = budget.left;
      const row = { project_id: s.project_id, step: s.step, outcome: 'done', agents: 0, stop: null, error: null, next_step: null };
      try {
        const po = { ...o, project: s.project_id, budget, startStep: s.step };
        const r = o.desk === 'online' ? await runOnlineImpl(po, { run: agent, out, fetchImpl, token: workerToken, env }) : runLocalImpl(po, { call, agent });
        if (r && r.stop) row.stop = r.stop;
        if (r && r.claims) row.claims = r.claims;
        if (r && r.sessions && r.sessions.length) row.sessions = r.sessions;
      } catch (err) {
        row.outcome = 'error';
        row.error = String(err && err.message || err).slice(0, 300);
        out(`    ${s.project_id}: ${row.error}`);
      }
      row.agents = before - budget.left;
      if (row.stop) row.outcome = row.stop === 'cap' ? 'cap' : 'not_dispatched';
      if (row.stop === 'reconcile' && !log.needs_eric.some((x) => x.project_id === s.project_id)) log.needs_eric.push({ project_id: s.project_id, step: s.step, words: reconcileWords(s.project_id) });
      // That project again, at zero tokens.
      try {
        const again = await poll();
        const mine = again.steps.find((x) => x.project_id === s.project_id);
        row.next_step = mine ? mine.step : null;
      } catch (err) {
        row.next_step = null;
        row.repoll_error = String(err && err.message || err).slice(0, 200);
      }
      log.dispatches.push(row);
    }
    for (const n of log.needs_eric) out(`Needs Eric: ${n.project_id} (${n.step}). ${n.words}`);
    const code = log.dispatches.some((d) => d.outcome === 'error') ? 1 : log.needs_eric.length ? 3 : 0;
    return finish(code);
  } catch (err) {
    log.error = String(err && err.message || err).slice(0, 300);
    out(`pilot-all: ${log.error}`);
    return finish(1);
  } finally {
    dropLock(lockFile, pid);
  }
}

function main() {
  const o = parse(process.argv.slice(2));
  if (o.pilotAll) return runAll(o).then((code) => { process.exitCode = code; });
  if (o.help || !o.project) {
    say('npm run pilot -- --project=<id> [--desk=local|online] [--dry-run] [--force-prosecution [--owner-words="…"]] [--model=<id>] [--timeout-min=60] [--connector=mcp__claude_ai_CryptoResearch]');
    say('npm run pilot -- --pilot-all [--desk=local|online] [--max-agents=2] [--dry-run] [--timeout-min=60] [--desk-url=https://…]');
    process.exitCode = o.help ? 0 : 2;
    return;
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(o.project)) throw new Error(`"${o.project}" is not a project ID.`);
  if (o.desk === 'online') return runOnline(o).then((r) => { if (r && r.stop === 'reconcile') process.exitCode = 3; });
  if (o.desk === 'local') runLocal(o);
  else throw new Error('--desk is local or online.');
}

module.exports = { resolveClaude, parse, forcedTicket, runOnline, runLocal, runAll, takeLock, readPollToken, readWorkerToken, workerCall, deskUrlOf, pollOnline, pollLocal, FORCE_WORDS, ALL_ORDER, RECONCILE_WORDS, ONLINE_RECONCILE, WEB_TOOLS, CLAIM_STOPS };

if (require.main === module) {
  Promise.resolve().then(main).catch((err) => {
    process.stderr.write(`pilot: ${err.message}\n`);
    process.exitCode = 1;
  });
}
