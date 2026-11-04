'use strict';
// Ops-1 preflight (blueprint 2026-11-03 §4 PR 4; docs/engineering/OPS1_RENDER_CRON.md).
//
// The Render Cron Job's start command runs this first:
//   node dashboard/scripts/ops1-preflight.js && node dashboard/scripts/pilot.js --unattended --pilot-all --desk=online --max-agents=1 --model=$CR_PILOT_MODEL
// so a host that is not ready never reaches the runner. It is read-only: it
// claims, dispatches, writes and pings nothing, and it prints no value of any
// variable (each name reads present or missing only). It exits 1 on any
// failure and 0 only when every check passes:
//   - Node 24.x (package.json engines);
//   - `claude --version` runs;
//   - each required name is set, and ANTHROPIC_API_KEY is not (claude -p
//     would bill it instead of the subscription, DESK_STATE.md);
//   - CR_PILOT_RUNNER_ID is render-ops1, the ID the drill reads on Desk Controls;
//   - CR_PILOT_MODEL is a full model ID (^claude-[a-z0-9-]+$), never an alias;
//   - `pilot.js --check-isolation --model=<it>` passes (no claim, no
//     generation, nothing billed);
//   - the desk's /healthz revision equals RENDER_GIT_COMMIT, all 40 characters.
// `--drill` prints the kill and desk-down drill steps and does nothing else.

const path = require('path');
const { spawnSync } = require('child_process');
const { withoutGithubCredentials } = require('../core/child-env');
const P = require('./pilot');
const PC = require('../core/pilot-claims');

const FORMAT = 'cr-ops1-preflight@1';
const ROOT = path.join(__dirname, '..', '..');
const RUNNER_ID = 'render-ops1';
const MODEL_ID_RE = /^claude-[a-z0-9-]+$/;
const REVISION_RE = /^[0-9a-f]{40}$/;
// Names only; their values never leave this process.
const REQUIRED_ENV = Object.freeze([P.POLL_TOKEN_ENV, P.WORKER_TOKEN_ENV, P.RUNNER_ID_ENV, 'CR_PILOT_MODEL', P.HEARTBEAT_ENV, 'CLAUDE_CODE_OAUTH_TOKEN', 'RENDER_GIT_COMMIT']);
const FORBIDDEN_ENV = Object.freeze(['ANTHROPIC_API_KEY']);
// The secrets among them: redacted from every line as well as never printed.
const SECRET_ENV = Object.freeze([P.POLL_TOKEN_ENV, P.WORKER_TOKEN_ENV, P.HEARTBEAT_ENV, 'CLAUDE_CODE_OAUTH_TOKEN', ...FORBIDDEN_ENV]);
const TTL_MIN = Math.round(PC.TTL_MS / 60000);

const valueOf = (env, name) => (env && typeof env[name] === 'string' ? env[name].trim() : '');

// Every secret's value, so no line can carry one by accident.
function redactor(env) {
  const secrets = SECRET_ENV.map((n) => valueOf(env, n)).filter((v) => v.length >= 6).sort((a, b) => b.length - a.length);
  return (s) => {
    let t = String(s);
    for (const v of secrets) t = t.split(v).join('[redacted]');
    return t;
  };
}

function runChild(cmd, args, { run = spawnSync, env, timeoutMs = 120000 } = {}) {
  try {
    const r = run(cmd, args, { cwd: ROOT, env: withoutGithubCredentials(env || process.env), encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
    return { status: typeof r.status === 'number' ? r.status : null, stdout: String(r.stdout || ''), error: r.error ? (r.error.code || r.error.message) : null };
  } catch (err) {
    return { status: null, stdout: '', error: err && (err.code || err.message) };
  }
}

async function preflight({ env = process.env, run = spawnSync, fetchImpl = globalThis.fetch, nodeVersion = process.versions.node, resolveClaude = () => P.resolveClaude({ env }) } = {}) {
  const checks = [];
  const add = (name, ok, words) => checks.push({ name, ok: Boolean(ok), words });

  const major = Number(String(nodeVersion).split('.')[0]);
  add('node', major === 24, major === 24 ? 'Node 24.x' : `Node ${major}.x, not 24.x (package.json engines)`);

  let claude = null;
  try { claude = resolveClaude(); } catch (err) { add('claude', false, String(err && err.message || err)); }
  if (claude) {
    const v = runChild(claude, ['--version'], { run, env, timeoutMs: 30000 });
    add('claude', v.status === 0, v.status === 0 ? '`claude --version` runs' : `\`claude --version\` did not run (${v.error || `exit ${v.status}`})`);
  }

  const missing = [];
  for (const n of REQUIRED_ENV) {
    const present = valueOf(env, n) !== '';
    if (!present) missing.push(n);
    add(`env ${n}`, present, present ? 'present' : 'missing');
  }
  for (const n of FORBIDDEN_ENV) {
    const present = valueOf(env, n) !== '';
    add(`env ${n}`, !present, present ? 'present, and refused: claude -p would bill it instead of the subscription' : 'absent');
  }

  const runnerId = valueOf(env, P.RUNNER_ID_ENV);
  if (runnerId) add('runner id', runnerId === RUNNER_ID, runnerId === RUNNER_ID ? `${P.RUNNER_ID_ENV} is ${RUNNER_ID}` : `${P.RUNNER_ID_ENV} is not ${RUNNER_ID}`);

  const model = valueOf(env, 'CR_PILOT_MODEL');
  const modelOk = MODEL_ID_RE.test(model);
  if (model) add('model', modelOk, modelOk ? 'CR_PILOT_MODEL is a full model ID' : 'CR_PILOT_MODEL is not a full model ID (^claude-[a-z0-9-]+$); an alias such as opus is refused');

  if (modelOk) {
    const iso = runChild(process.execPath, [path.join(__dirname, 'pilot.js'), '--check-isolation', `--model=${model}`], { run, env });
    let words = null;
    try { words = JSON.parse(iso.stdout).words || null; } catch (_) { /* not JSON: its exit code decides */ }
    add('isolation', iso.status === 0, iso.status === 0 ? '`pilot.js --check-isolation` passed' : `\`pilot.js --check-isolation\` refused (${words || iso.error || `exit ${iso.status}`})`);
  } else {
    add('isolation', false, 'not run: the model is missing or not a full model ID');
  }

  const rc = valueOf(env, 'RENDER_GIT_COMMIT').toLowerCase();
  if (!rc) add('revision', false, 'not checked: RENDER_GIT_COMMIT is missing');
  else if (!REVISION_RE.test(rc)) add('revision', false, 'RENDER_GIT_COMMIT is not a 40-character commit ID');
  else {
    let origin = null;
    try { origin = P.deskUrlOf({}, env); } catch (err) { add('revision', false, String(err && err.message || err)); }
    if (origin) {
      const d = await P.deskRevision(fetchImpl, origin);
      if (!d.commit) add('revision', false, d.words);
      else add('revision', d.commit === rc, d.commit === rc ? `the desk's /healthz runs ${rc.slice(0, 7)}, this build's commit` : `the desk's /healthz runs ${d.commit.slice(0, 7)}, this build is ${rc.slice(0, 7)}`);
    }
  }

  const ok = checks.every((c) => c.ok);
  return { format: FORMAT, ok, exit: ok ? 0 : 1, missing, checks };
}

function drillText() {
  return [
    'Ops-1 drills (docs/engineering/OPS1_RENDER_CRON.md, "Drills"). Nothing here runs; read and do them by hand.',
    '',
    'Kill drill (the cron job SUSPENDED, the PC pilot-all task Disabled):',
    '  1. Make sure exactly one pilot project has work (a research or ticket step), then Trigger Run once.',
    '  2. When the run log shows the session started (a claim taken and dispatched), stop that run: Trigger Run again,',
    '     which Render documents cancels the active run first (render.com/docs/cronjobs, "Manually triggering a run").',
    `  3. The claim's dispatched life is ${TTL_MIN} minutes (dashboard/core/pilot-claims.js TTL_MS).`,
    `     - A run that polls before ${TTL_MIN} minutes from the claim sees the project held: outcome not_dispatched,`,
    '       stop claimed, health attention, exit 0, Healthchecks /fail. The run triggered in step 2 is this run.',
    `     - The first run after ${TTL_MIN} minutes sees reconcile: exit 3, Healthchecks /3, "Needs Eric" for that project.`,
    '  4. Pass condition for the cancelled child (the claude session):',
    '     - from the cancel until the reconcile, the attempt never completes: no ticket or report receipt is saved for its',
    '       attempt ID, Desk Controls keeps the claim dispatched with the same attempt ID, and sessions_today does not grow',
    '       for it;',
    '     - any save or complete for that attempt after the cancel time is a FAIL: the child outlived its run.',
    '     Render does not document the signal a cancelled cron run receives, so this is judged by what reaches the desk.',
    '  5. Eric reconciles the attempt on Desk Controls. Nothing re-dispatches it, times it out or resubmits it (Q1).',
    '',
    'Desk-down drill:',
    '  - Never point a production runner at a fake desk. The desk-down cases are dashboard/tests/pilot-host-recovery.test.js,',
    '    which CI runs on ubuntu on every pull request; record that run\'s ID.',
  ].join('\n');
}

async function main(argv = process.argv.slice(2), { env = process.env, write = (s) => process.stdout.write(s), ...deps } = {}) {
  if (argv.includes('--drill')) { write(`${drillText()}\n`); return 0; }
  const clean = redactor(env);
  let r;
  try {
    r = await preflight({ env, ...deps });
  } catch (err) {
    write(`${clean(`ops1-preflight: refused (${String(err && err.message || err).slice(0, 200)}). Exit 1.`)}\n`);
    return 1;
  }
  const lines = r.checks.map((c) => `${c.ok ? 'ok     ' : 'REFUSED'}  ${c.name}: ${c.words}`);
  const refused = r.checks.filter((c) => !c.ok).length;
  lines.push(r.ok ? 'ops1-preflight: every check passed. Exit 0.' : `ops1-preflight: ${refused} ${refused === 1 ? 'check' : 'checks'} refused${r.missing.length ? `; missing: ${r.missing.join(', ')}` : ''}. Exit 1; the runner does not start.`);
  write(`${clean(lines.join('\n'))}\n`);
  return r.exit;
}

module.exports = { FORMAT, RUNNER_ID, MODEL_ID_RE, REQUIRED_ENV, FORBIDDEN_ENV, SECRET_ENV, TTL_MIN, redactor, preflight, drillText, main };

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    process.stderr.write('ops1-preflight: refused (an unexpected error). Exit 1.\n');
    process.exitCode = 1;
    void err;
  });
}
