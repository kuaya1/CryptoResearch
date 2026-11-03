'use strict';
// Ops-1 preflight (blueprint 2026-11-03 §4 PR 4; docs/engineering/OPS1_RENDER_CRON.md):
// a Render cron host that is not ready never reaches the runner, and nothing
// it prints carries a value. FICTIONAL environment values, a stubbed `claude`,
// a stubbed isolation check and a stubbed /healthz; no network, no session.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const O = require('../scripts/ops1-preflight');
const PC = require('../core/pilot-claims');

const SHA = 'f1c7f1c7f1c7f1c7f1c7f1c7f1c7f1c7f1c7f1c7';
const OTHER = '0123456789abcdef0123456789abcdef01234567';
// FICTIONAL secrets: none of them may ever appear in the output.
const SECRETS = Object.freeze({
  CR_PILOT_POLL_TOKEN: 'FICTIONAL-poll-token-7a1b2c3d4e5f6a7b',
  CR_PILOT_WORKER_TOKEN: 'FICTIONAL-worker-token-9e8d7c6b5a4f3e2d',
  CR_HEALTHCHECK_URL: 'https://hc-ping.example.invalid/FICTIONAL-uuid-0b9a8c7d',
  CLAUDE_CODE_OAUTH_TOKEN: 'FICTIONAL-oauth-sk-ant-oat01-3c4d5e6f7a8b',
});
const goodEnv = (over = {}) => ({ PATH: process.env.PATH || '', ...SECRETS, CR_PILOT_RUNNER_ID: 'render-ops1', CR_PILOT_MODEL: 'claude-opus-5-5', RENDER_GIT_COMMIT: SHA, CR_DESK_URL: 'https://fictional-desk.example.invalid', ...over });

function deps({ healthz = SHA, healthStatus = 200, isolation = { status: 0, words: 'A session would be offered WebSearch and WebFetch only.' }, version = 0 } = {}) {
  const calls = { run: [], fetch: [] };
  return {
    calls,
    nodeVersion: '24.21.0',
    resolveClaude: () => 'claude',
    run: (cmd, args) => {
      calls.run.push([cmd, ...args]);
      if (args[0] === '--version') return { status: version, stdout: '2.1.317 (Claude Code)' };
      if (args.includes('--check-isolation')) return { status: isolation.status, stdout: JSON.stringify({ format: 'cr-pilot-launch@1', ok: isolation.status === 0, words: isolation.words }) };
      return { status: 1, stdout: '' };
    },
    fetchImpl: async (url) => {
      calls.fetch.push(String(url));
      return { status: healthStatus, text: async () => (healthz ? `ok\nrevision ${healthz} (main)\nstarted 2026-11-03T00:00:00.000Z\n` : 'ok\n') };
    },
  };
}
async function runMain(env, d, argv = []) {
  let printed = '';
  const code = await O.main(argv, { env, write: (s) => { printed += s; }, ...d });
  return { code, printed };
}
function noSecretIn(printed, env = SECRETS) {
  for (const [name, value] of Object.entries(env)) {
    if (value) assert.ok(!printed.includes(value), `the value of ${name} is never printed`);
  }
}

test('a ready host passes every check, exit 0, and nothing it prints carries a secret', async () => {
  const d = deps();
  const { code, printed } = await runMain(goodEnv(), d);
  assert.equal(code, 0, printed);
  assert.match(printed, /every check passed\. Exit 0\./);
  for (const n of O.REQUIRED_ENV) assert.match(printed, new RegExp(`ok {7}env ${n}: present`));
  assert.match(printed, /env ANTHROPIC_API_KEY: absent/);
  assert.deepEqual(d.calls.fetch, ['https://fictional-desk.example.invalid/healthz']);
  assert.deepEqual(d.calls.run.find((c) => c.includes('--check-isolation')).slice(-2), ['--check-isolation', '--model=claude-opus-5-5']);
  noSecretIn(printed);
});

test('a missing name exits 1 and prints the name, never a value', async () => {
  for (const name of O.REQUIRED_ENV) {
    const d = deps();
    const { code, printed } = await runMain(goodEnv({ [name]: '' }), d);
    assert.equal(code, 1, name);
    assert.match(printed, new RegExp(`REFUSED  env ${name}: missing`), name);
    assert.match(printed, new RegExp(`missing: ${name}\\. Exit 1; the runner does not start\\.`), name);
    noSecretIn(printed);
  }
});

test('a model alias is refused and the isolation check is not run for it', async () => {
  for (const alias of ['opus', 'sonnet', 'claude-opus-latest[1m]', 'Claude-Opus-5-5']) {
    const d = deps();
    const { code, printed } = await runMain(goodEnv({ CR_PILOT_MODEL: alias }), d);
    assert.equal(code, 1, alias);
    assert.match(printed, /REFUSED {2}model: CR_PILOT_MODEL is not a full model ID/);
    assert.match(printed, /REFUSED {2}isolation: not run/);
    assert.ok(!d.calls.run.some((c) => c.includes('--check-isolation')), `${alias}: no isolation run`);
  }
  assert.ok(O.MODEL_ID_RE.test('claude-sonnet-5-5'));
});

test('a /healthz revision that differs from RENDER_GIT_COMMIT is refused; so is a /healthz that does not answer one', async () => {
  let r = await runMain(goodEnv(), deps({ healthz: OTHER }));
  assert.equal(r.code, 1);
  assert.match(r.printed, /REFUSED {2}revision: the desk's \/healthz runs 0123456, this build is f1c7f1c/);
  r = await runMain(goodEnv(), deps({ healthStatus: 503 }));
  assert.equal(r.code, 1);
  assert.match(r.printed, /REFUSED {2}revision: The desk's \/healthz answered 503\./);
  r = await runMain(goodEnv(), deps({ healthz: null }));
  assert.equal(r.code, 1);
  assert.match(r.printed, /names no 40-character revision/);
  r = await runMain(goodEnv({ RENDER_GIT_COMMIT: SHA.slice(0, 7) }), deps());
  assert.equal(r.code, 1);
  assert.match(r.printed, /RENDER_GIT_COMMIT is not a 40-character commit ID/);
});

test('ANTHROPIC_API_KEY on the host is refused, and its value is never printed', async () => {
  const key = 'sk-ant-api03-FICTIONAL-billing-key-5d6e7f';
  const { code, printed } = await runMain(goodEnv({ ANTHROPIC_API_KEY: key }), deps());
  assert.equal(code, 1);
  assert.match(printed, /REFUSED {2}env ANTHROPIC_API_KEY: present, and refused/);
  noSecretIn(printed, { ...SECRETS, ANTHROPIC_API_KEY: key });
});

test('a refused isolation check, a missing claude, Node other than 24 and a wrong runner ID each exit 1', async () => {
  let r = await runMain(goodEnv(), deps({ isolation: { status: 1, words: `managed policy found; FICTIONAL echo ${SECRETS.CR_PILOT_WORKER_TOKEN}` } }));
  assert.equal(r.code, 1);
  assert.match(r.printed, /REFUSED {2}isolation: `pilot\.js --check-isolation` refused \(managed policy found; FICTIONAL echo \[redacted\]\)/);
  noSecretIn(r.printed);
  r = await runMain(goodEnv(), deps({ version: 127 }));
  assert.equal(r.code, 1);
  assert.match(r.printed, /REFUSED {2}claude: `claude --version` did not run \(exit 127\)/);
  r = await runMain(goodEnv(), { ...deps(), nodeVersion: '22.11.0' });
  assert.equal(r.code, 1);
  assert.match(r.printed, /REFUSED {2}node: Node 22\.x, not 24\.x/);
  r = await runMain(goodEnv({ CR_PILOT_RUNNER_ID: 'my-laptop' }), deps());
  assert.equal(r.code, 1);
  assert.match(r.printed, /REFUSED {2}runner id: CR_PILOT_RUNNER_ID is not render-ops1/);
});

test('--drill prints the kill and desk-down drills with the claim TTL from the code, and does nothing else', async () => {
  const d = deps();
  const { code, printed } = await runMain(goodEnv(), d, ['--drill']);
  assert.equal(code, 0);
  assert.deepEqual(d.calls, { run: [], fetch: [] }, 'nothing is run or asked');
  assert.equal(O.TTL_MIN, PC.TTL_MS / 60000);
  assert.equal(O.TTL_MIN, 90);
  assert.match(printed, /dispatched life is 90 minutes/);
  assert.match(printed, /before 90 minutes from the claim sees the project held: outcome not_dispatched,\n\s+stop claimed, health attention, exit 0, Healthchecks \/fail/);
  assert.match(printed, /first run after 90 minutes sees reconcile: exit 3, Healthchecks \/3/);
  assert.match(printed, /any save or complete for that attempt after the cancel time is a FAIL/);
  assert.match(printed, /Never point a production runner at a fake desk/);
  noSecretIn(printed);
});

test('on a host with the names unset, the script itself exits 1 listing them as missing (no network: the revision is not asked without RENDER_GIT_COMMIT)', () => {
  const env = {};
  for (const k of ['PATH', 'Path', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) if (process.env[k] !== undefined) env[k] = process.env[k];
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'ops1-preflight.js')], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  for (const n of O.REQUIRED_ENV) assert.match(r.stdout, new RegExp(`REFUSED  env ${n}: missing`));
  assert.match(r.stdout, /Exit 1; the runner does not start\./);
});

// The specification (docs/engineering/OPS1_RENDER_CRON.md) and the code agree,
// and nothing in the repository can create or resume the service.
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
const DOC = fs.readFileSync(path.join(ROOT, 'docs', 'engineering', 'OPS1_RENDER_CRON.md'), 'utf8');
const COMMAND = 'node dashboard/scripts/ops1-preflight.js && node dashboard/scripts/pilot.js --unattended --pilot-all --desk=online --max-agents=1 --model=$CR_PILOT_MODEL';

test('no Render Blueprint file exists at the root, and the YAML shape lives in the document only', () => {
  for (const f of ['render.yaml', 'render.yml']) assert.equal(fs.existsSync(path.join(ROOT, f)), false, `${f} must not exist`);
  assert.match(DOC, /# Shape only\. Never commit this as render\.yaml/);
  assert.match(DOC, /\*\*Status: defined, not created\.\*\*[^\n]*\*\*suspended at once\*\*/);
});

test('the document\'s service, command and names are the code\'s own', () => {
  assert.match(DOC, /\| Name \| `cryptoresearch-runner` \|/);
  assert.match(DOC, /\| Schedule \| `5 \* \* \* \*`: hourly at :05 UTC \|/);
  assert.ok(DOC.includes(`| Command | \`${COMMAND}\` |`), 'the table names the start command');
  assert.ok(DOC.includes(`startCommand: ${COMMAND}`), 'the YAML shape names the same command');
  assert.ok(fs.readFileSync(path.join(ROOT, 'dashboard', 'scripts', 'ops1-preflight.js'), 'utf8').includes(COMMAND), 'the preflight names the same command');
  assert.match(DOC, /npm install -g @anthropic-ai\/claude-code@<pinned> && claude --version/);
  for (const n of O.REQUIRED_ENV.filter((x) => x !== 'RENDER_GIT_COMMIT')) assert.match(DOC, new RegExp(`\| \`${n}\` \|`), `the names table lists ${n}`);
  assert.match(DOC, /\*\*Set by Render, not by Eric:\*\* `RENDER_GIT_COMMIT`/);
  assert.match(DOC, /\*\*Never set:\*\* `ANTHROPIC_API_KEY`/);
  assert.match(DOC, /`CR_PILOT_RUNNER_ID` \| `render-ops1`/);
});

test('Healthchecks is 60 minutes with a 120-minute grace, and the kill drill names the code\'s claim TTL', () => {
  assert.match(DOC, /period \*\*60 minutes\*\*, grace \*\*120 minutes\*\*/);
  assert.doesNotMatch(DOC, /grace 30 min/);
  assert.ok(DOC.includes(`dispatched life is **${PC.TTL_MS / 60000} minutes**`), "the doc names the code's claim TTL");
  assert.match(DOC, /\*\*any save or `complete` for that attempt after the cancel time is a FAIL\*\*/);
  const b = fs.readFileSync(path.join(ROOT, 'docs', 'engineering', 'AUTONOMY_COMPLETION_BLUEPRINT_2026-11-03.md'), 'utf8');
  assert.doesNotMatch(b, /grace 30 min/, 'the blueprint carries the same grace');
  assert.match(b, /period 60 min, grace 120 min/);
});

test('the Render platform facts are quoted from Render\'s documentation, and the rest stays UNVERIFIED', () => {
  for (const quote of [
    'Render guarantees that at most one run of a given cron job is active at a given time.',
    'Render _delays_ the next scheduled run until the active run finishes.',
    'Render stops an active run after 12 hours.',
    'All day and time ranges use UTC.',
    "Cron jobs can't provision or access a persistent disk.",
  ]) assert.ok(DOC.includes(`"${quote}"`), quote);
  assert.match(DOC, /`https:\/\/render\.com\/docs\/cronjobs`/);
  assert.match(DOC, /### 5\.4 Still UNVERIFIED/);
  for (const item of ['The cancelled child', '`.git` in the cron checkout', '`RENDER_GIT_COMMIT`\'s form', 'The price']) assert.ok(DOC.includes(`**${item}`), item);
});

test('the hosted mission proof keeps its five results apart', () => {
  for (const r of ['host_installed', 'runner_alive', 'lifecycle_proven', 'fill_proven', 'closed_outcome_proven']) assert.match(DOC, new RegExp(`\| \`${r}\` \|`), r);
  assert.match(DOC, /\*\*at least one real unattended lifecycle\*\*/);
  assert.match(DOC, /A later result never stands in for an earlier one\./);
});
