#!/usr/bin/env node
'use strict';
// The autonomous pilot, from PowerShell in one command:
//
//   npm run pilot -- --project=olas                 this folder's desk (local)
//   npm run pilot -- --project=olas --desk=online   the online desk, through the
//                                                   CryptoResearch connector
//   npm run pilot -- --project=olas --dry-run       say what would run, run nothing
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
// verified by it. Online: one `claude -p` session that may call only the
// CryptoResearch connector's tools and web search, told to follow
// autonomous_pilot_queue. Either way the chain stops at Eric's PM review: it
// never decides a ticket, places an order or moves money.

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
  const out = { desk: 'local', dryRun: false, model: null, connector: 'mcp__claude_ai_CryptoResearch', timeoutMin: 60, forceProsecution: false, ownerWords: null };
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

function runLocal(o) {
  for (let i = 0; i < MAX_STEPS; i++) {
    const q = cli(['tickets', 'queue', o.project]);
    let s = q.steps[0];
    if (!s) throw new Error(`No project ${o.project} on this desk.`);
    say(`[${i + 1}] ${s.name}: ${s.step} — ${s.why}`);
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
      const prompt = cli(['research', 'prompt', o.project, runId], { text: true });
      say(`    Agent 1: claude -p on the frozen research prompt (${prompt.length} characters)…`);
      const report = claude(prompt, { tools: WEB_TOOLS, model: o.model, timeoutMin: o.timeoutMin });
      const f = scratch('researcher', 'agent1-report.md', report);
      const saved = cli(['import-text', '--provider', 'claude', '--project', o.project, '--text-file', f, '--run', runId]);
      say(`    saved: ${saved.status}${saved.report_id ? ` ${saved.report_id}` : ''}${saved.message ? ` — ${saved.message}` : ''}`);
      if (saved.verified === false) throw new Error('The report did not read back as written; run the pilot again (an identical save is recognized).');
      continue;
    }
    if (s.step === 'gate_closed') {
      if (o.dryRun) return say('    would save the desk\'s gate receipt (no Prosecutor runs).');
      const g = cli(['tickets', 'start', o.project, '--utterance', 'autonomous pilot (npm run pilot)']);
      say(`    desk gate: ${g.status} ${g.receipt_id || ''} — ${g.message}`);
      if (g.verified === false) throw new Error('The desk\'s gate receipt did not read back as written; run the pilot again.');
      continue;
    }
    if (s.step === 'ticket') {
      if (o.dryRun) return say('    would run Agent 2 (the Prosecutor) with claude -p, then save the ticket.');
      const t = cli(['tickets', 'start', o.project, ...(s.refresh ? ['--reopen'] : []), ...(s.force ? ['--force-prosecution'] : []), '--assistant', '--mode', 'cli', '--utterance', s.force ? (o.ownerWords || FORCE_WORDS) : 'autonomous pilot (npm run pilot)']);
      if (!t.ticket_id) throw new Error(t.message);
      const prompt = cli(['tickets', 'prompt', o.project, t.ticket_id], { text: true });
      say(`    Agent 2: claude -p on the frozen Prosecutor prompt ${t.ticket_id} (${prompt.length} characters)…`);
      const ticket = claude(prompt, { tools: WEB_TOOLS, model: o.model, timeoutMin: o.timeoutMin });
      const f = scratch('prosecutor', 'agent2-ticket.md', ticket);
      const saved = cli(['tickets', 'import', o.project, t.ticket_id, '--text-file', f]);
      say(`    saved: ${saved.status} ${saved.receipt_id || ''} — ${saved.message}`);
      if (saved.verified === false) throw new Error('The ticket did not read back as written; run the pilot again.');
      continue;
    }
    say(s.step === 'pm_review' ? '    Done: the ticket waits for your PM review (inspector > PM decision).' : '    Nothing for the agents to do.');
    return;
  }
  say(`Stopped after ${MAX_STEPS} steps.`);
}

function onlineInstruction(o) {
  const words = JSON.stringify(o.ownerWords || FORCE_WORDS);
  return [
    `Run the CryptoResearch autonomous pilot for the project "${o.project}" on Eric's online desk, using only the CryptoResearch connector's tools and web search.`,
    `1. Call autonomous_pilot_queue with project "${o.project}". Do its next step, then call it again, until the step is pm_review or done (at most ${MAX_STEPS} steps).`,
    '2. A "research" step is Agent 1: Claude\'s investment research. Use start_research for Claude only (owner_request "autonomous pilot") or resume the open run, follow its frozen prompt exactly with your own web research, and save_report with the whole report.',
    o.forceProsecution
      ? `2b. Eric asked for a Prosecutor although the desk's gate closed on the grade (his words: ${words}). On a "gate_closed" step, and on a "pm_review" step whose ticket in force (get_ticket) is the desk's gate receipt (desk_gate: true) still waiting for his review, call start_ticket with force_prosecution: true and owner_request exactly those words, then do step 3 with the ticket it opens. Once per project. Never on a desk gate Eric already decided. If start_ticket opens no ticket, give its message and stop.`
      : '2b. A "gate_closed" step needs no Prosecutor: call start_ticket (owner_request "autonomous pilot") once, which saves the desk\'s gate receipt, then call autonomous_pilot_queue again.',
    '3. A "ticket" step is Agent 2: start_ticket (owner_request "autonomous pilot"), take the Prosecutor\'s role the prompt gives you, apart from the report\'s author, and save_ticket with the whole text and its JSON block.',
    '4. Never decide a ticket, never choose a dollar amount, never place or simulate an order. Stop at pm_review.',
    '5. End with one line per step: the step, the record saved (report or receipt ID) and the desk\'s message.',
  ].join('\n');
}

function runOnline(o) {
  const instruction = onlineInstruction(o);
  if (o.dryRun) return say(`Would run one claude -p session with tools ${o.connector}, ${WEB_TOOLS.join(', ')}:\n\n${instruction}`);
  say(`claude -p on the online desk through ${o.connector}…`);
  say(claude(instruction, { tools: [o.connector, ...WEB_TOOLS], model: o.model, timeoutMin: o.timeoutMin * MAX_STEPS }));
}

function main() {
  const o = parse(process.argv.slice(2));
  if (o.help || !o.project) {
    say('npm run pilot -- --project=<id> [--desk=local|online] [--dry-run] [--force-prosecution [--owner-words="…"]] [--model=<id>] [--timeout-min=60] [--connector=mcp__claude_ai_CryptoResearch]');
    process.exitCode = o.help ? 0 : 2;
    return;
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(o.project)) throw new Error(`"${o.project}" is not a project ID.`);
  if (o.desk === 'online') runOnline(o);
  else if (o.desk === 'local') runLocal(o);
  else throw new Error('--desk is local or online.');
}

module.exports = { resolveClaude, parse, forcedTicket, onlineInstruction, FORCE_WORDS };

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`pilot: ${err.message}\n`);
    process.exitCode = 1;
  }
}
