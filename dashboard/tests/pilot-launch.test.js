'use strict';
// The agent session's tool boundary (scripts/pilot.js makeLauncher,
// cr-pilot-launch@1; worker boundary PR, 2026-10-31). The launcher under test
// is the runner's own: its arguments, its environment, its preflight (the
// --help check, the managed-policy check, the probe against a local stand-in
// model endpoint) and its session start. Only the `claude` executable is a
// stand-in (claude-stand-in.js, run as `node claude-stand-in.js …`): it
// records what it was given and generates nothing. No model is called.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const P = require('../scripts/pilot');

const PROMPT = 'FROZEN PROSECUTOR PROMPT (FICTIONAL) cr-ticket-prompt@1 tk_FICTIONAL';
const WTOKEN = 'FICTIONAL-worker-token-launch-0123456789';
const POLL = 'FICTIONAL-poll-token-launch-0123456789';
// Desk and other credentials in the runner's own environment.
const SECRETS = {
  CR_PILOT_WORKER_TOKEN: 'FICTIONAL-env-worker-token-aaaaaaaaaaaa',
  DESK_INGEST_KEY: 'FICTIONAL-ingest-key-bbbbbbbbbbbbbbbbbbbbbbbb',
  CR_GITHUB_TOKEN: 'FICTIONAL-github-cccccccccccc',
  GITHUB_TOKEN: 'FICTIONAL-gh-dddddddddddd',
  ALCHEMY_API_KEY: 'FICTIONAL-alchemy-eeeeeeeeeeee',
  ANTHROPIC_API_KEY: 'FICTIONAL-anthropic-key-ffffffffffff',
  ANTHROPIC_AUTH_TOKEN: 'FICTIONAL-anthropic-token-gggggggggg',
  ANTHROPIC_BASE_URL: 'https://gateway.fictional.example',
  CLAUDE_CODE_MESSAGING_TOKEN: 'FICTIONAL-parent-session-hhhhhhhhhh',
  CLAUDECODE: '1',
  NODE_OPTIONS: '--require ./FICTIONAL-not-a-module.js',
};

// A folder with its own copy of the stand-in, its config and its record.
function standIn(t, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-claude-stand-in-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(path.join(__dirname, 'claude-stand-in.js'), path.join(dir, 'claude-stand-in.js'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const records = () => (fs.existsSync(path.join(dir, 'record.jsonl')) ? fs.readFileSync(path.join(dir, 'record.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, bin: { file: process.execPath, args: [path.join(dir, 'claude-stand-in.js')] }, records };
}

// The runner's environment: what a Windows or Linux shell has, plus secrets.
function runnerEnv(extra = {}) {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];
  const base = {};
  for (const k of keep) if (process.env[k] !== undefined) base[k] = process.env[k];
  return { ...base, ...SECRETS, ...extra };
}

// The Windows registry read's answer (cr-policy-registry@1), as the launcher's
// PowerShell child prints it: every policy key absent unless `states` says
// otherwise ('LocalMachine/Registry64': 'denied', …); `json` replaces it.
const REG_ROWS = ['LocalMachine', 'CurrentUser'].flatMap((hive) => ['Registry64', 'Registry32'].map((view) => ({ hive, view })));
const regAnswer = (states = {}, { json = null, status = 0, rows = null } = {}) => () => ({
  status,
  stdout: json !== null ? json : JSON.stringify({ format: P.REG_FORMAT, keys: (rows || REG_ROWS).map((r) => ({ ...r, state: states[`${r.hive}/${r.view}`] || 'absent', detail: states[`${r.hive}/${r.view}`] === 'present' ? 'values 3, subkeys 1' : '' })) }),
  stderr: '#< CLIXML <Objs>progress (FICTIONAL)</Objs>',
});
const launcherOf = (s, over = {}) => P.makeLauncher({ bin: s.bin, env: runnerEnv(over.env), settings: over.settings || { model: null, effort: null }, platform: over.platform || 'linux', statFile: over.statFile || (() => 'absent'), reg: over.reg || regAnswer(), probeTimeoutMs: over.probeTimeoutMs || 20000 });
const valueAfter = (argv, flag) => argv[argv.indexOf(flag) + 1];

test('a session gets WebSearch and WebFetch only: the documented restriction flags, an empty MCP config, no settings files, a new empty folder', async (t) => {
  const s = standIn(t);
  const launch = launcherOf(s);
  const v = await launch.preflight({});
  assert.equal(v.ok, true);
  assert.deepEqual(v.tools, ['WebFetch', 'WebSearch'], 'the probe saw the model offered the two web tools and nothing else');
  const answer = launch(PROMPT, { tools: P.AGENT_TOOLS, model: null, timeoutMin: 1 });
  assert.match(answer, /FICTIONAL answer/);
  const [probe, session] = s.records();
  assert.ok(probe && session, 'one probe run, then one session');
  const a = session.argv;
  assert.deepEqual(a, P.launchArgs({}), 'the session is launched with exactly the arguments the probe checked');
  assert.deepEqual(probe.argv, a, 'the probe ran the same command line');
  assert.equal(valueAfter(a, '--tools'), 'WebSearch,WebFetch', 'built-in tools restricted by the tool-selection flag, not only approved');
  assert.equal(valueAfter(a, '--allowedTools'), 'WebSearch,WebFetch');
  const denied = valueAfter(a, '--disallowedTools').split(',');
  for (const d of ['mcp__*', 'Bash', 'PowerShell', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'Skill', 'ToolSearch']) assert.ok(denied.includes(d), `${d} removed from the session's context`);
  assert.ok(a.includes('--strict-mcp-config'));
  assert.equal(valueAfter(a, '--mcp-config'), '{"mcpServers":{}}', 'the only MCP configuration is empty');
  assert.equal(valueAfter(a, '--permission-mode'), 'dontAsk');
  for (const f of ['--restricted', '--safe-mode', '--disable-slash-commands', '--no-chrome', '--no-session-persistence', '--print']) assert.ok(a.includes(f), f);
  assert.deepEqual(JSON.parse(valueAfter(a, '--settings')), { disableAllHooks: true, disableClaudeAiConnectors: true });
  for (const f of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--bare', '--add-dir', '--plugin-dir', '--agents', '--resume', '--continue']) assert.ok(!a.includes(f), `${f} is never passed`);
  assert.equal(a.filter((x) => x === '--mcp-config').length, 1);
  assert.equal(session.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false', 'the claude.ai connectors (the desk\'s own included) are not fetched');
  assert.equal(session.stdin, PROMPT, 'the frozen prompt arrives whole on stdin');
  assert.notEqual(path.resolve(session.cwd), path.resolve(os.tmpdir()), 'not the shared temp folder, where the roles\' scratch files are');
  assert.deepEqual(session.cwd_entries, [], 'a new, empty folder');
  assert.equal(fs.existsSync(session.cwd), false, 'removed after the session');
  // The probe ran against the local stand-in with a placeholder key only.
  assert.match(probe.env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(probe.env.ANTHROPIC_API_KEY, /isolation-probe-not-a-key/);
  assert.equal(session.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(session.env.ANTHROPIC_API_KEY, undefined, 'a session is never billed to an API key: the subscription signs it in');
});

test('inherited MCP tools cannot enter a session: a probe that sees one refuses, the session will not start, and the runners claim nothing', async (t) => {
  const leak = { name: 'mcp__claude_ai_CryptoResearch__save_report', description: 'the desk connector (FICTIONAL)', input_schema: { type: 'object', properties: { text: { type: 'string' } } } };
  const s = standIn(t, { leak: [leak] });
  const launch = launcherOf(s);
  await assert.rejects(launch.preflight({}), (e) => e.code === 'ISOLATION' && /mcp__claude_ai_CryptoResearch__save_report/.test(e.message) && /No claim was taken/.test(e.message));
  assert.throws(() => launch(PROMPT, { tools: P.AGENT_TOOLS, timeoutMin: 1 }), (e) => e.code === 'ISOLATION', 'the session function refuses a command line that did not pass');
  assert.equal(s.records().length, 1, 'only the probe ran; no session started');
  // Online: refused before the worker token is used or a claim is asked.
  const calls = [];
  const fetchImpl = async (url) => { calls.push(String(url)); throw new Error('no request expected'); };
  await assert.rejects(P.runOnline({ project: 'olas', desk: 'online', deskUrl: 'https://desk.fictional.example', timeoutMin: 1 }, { run: launch, out: () => {}, fetchImpl, token: WTOKEN }), (e) => e.code === 'ISOLATION');
  assert.deepEqual(calls, [], 'no claim, no prepare');
  // pilot-all, local: the pre-poll runs, then nothing is claimed; exit 1.
  const said = [];
  const cliCalls = [];
  const call = (args) => { cliCalls.push(args.slice(0, 2).join(' ')); if (args[1] === 'queue') return { paused: false, steps: [{ project_id: 'olas', step: 'ticket' }], claims: {} }; throw new Error(`no ${args.join(' ')} expected`); };
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pilot-launch-all-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const code = await P.runAll({ desk: 'local', maxAgents: 2 }, { call, agent: launch, out: (x) => said.push(x), lockFile: path.join(d, 'lock'), logFile: path.join(d, 'log.jsonl') });
  assert.equal(code, 1);
  assert.deepEqual(cliCalls, ['tickets queue'], 'the zero-token pre-poll only');
  assert.match(JSON.parse(fs.readFileSync(path.join(d, 'log.jsonl'), 'utf8')).error, /tool boundary could not be established/);
  // The verdict itself: any MCP tool name, an MCP server list or another tool is refused.
  const body = (o) => JSON.stringify({ model: 'x', tools: [{ name: 'WebSearch' }, { name: 'WebFetch' }], ...o });
  assert.equal(P.judgeProbe([body({})]).ok, true);
  assert.equal(P.judgeProbe([body({ system: 'Deferred tools: mcp__claude-in-chrome__navigate' })]).ok, false, 'a deferred MCP tool named in the prompt counts');
  assert.equal(P.judgeProbe([body({ mcp_servers: [{ type: 'url', url: 'https://desk.fictional.example/mcp' }] })]).ok, false);
  assert.equal(P.judgeProbe([body({ tools: [{ name: 'WebSearch' }, { name: 'ToolSearch' }] })]).ok, false);
  assert.equal(P.judgeProbe([body({ tools: [{ name: 'DeferredToolPlaceholder', defer_loading: true, input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } }] })]).ok, false, 'a placeholder that takes input is not inert');
  assert.equal(P.judgeProbe([body({}), 'not json']).ok, false);
  assert.equal(P.judgeProbe([]).ok, false, 'no request seen is unknown, never a pass');
});

test('configuration cannot broaden a session: other tools, a flag as a model, settings that allow the shell, a CLI that offers more', async (t) => {
  const s = standIn(t);
  const launch = launcherOf(s);
  await launch.preflight({});
  for (const tools of [[...P.AGENT_TOOLS, 'Bash'], ['WebSearch'], ['WebSearch', 'mcp__claude_ai_CryptoResearch__get_report'], 'WebSearch,WebFetch,Bash']) {
    assert.throws(() => launch(PROMPT, { tools, timeoutMin: 1 }), (e) => e.code === 'ISOLATION', `refused: ${JSON.stringify(tools)}`);
  }
  assert.equal(s.records().length, 1, 'only the probe ran');
  await assert.rejects(launch.preflight({ model: '--dangerously-skip-permissions' }), (e) => e.code === 'ISOLATION' && /not a model name/.test(e.message));
  assert.throws(() => launch(PROMPT, { tools: P.AGENT_TOOLS, model: '--bare', timeoutMin: 1 }), (e) => e.code === 'ISOLATION');
  assert.equal(P.parse(['--project=olas', '--tools=Bash', '--allowedTools=Bash']).tools, undefined, 'the runner takes no tool option');
  // Eric's Claude Code settings: only the model and effort carry over; their
  // permissions, hooks, MCP servers and environment never reach the command.
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-claude-config-'));
  t.after(() => fs.rmSync(cfg, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ model: 'opus', effortLevel: 'xhigh', permissions: { allow: ['Bash', 'mcp__claude_ai_CryptoResearch'], defaultMode: 'bypassPermissions' }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo FICTIONAL' }] }] }, mcpServers: { desk: { command: 'node' } }, env: { CR_SETTINGS_SECRET: 'FICTIONAL' } }));
  const env = { CLAUDE_CONFIG_DIR: cfg };
  assert.deepEqual(P.userModelSettings(env), { model: 'opus', effort: 'xhigh' });
  const args = P.launchArgs(P.sessionChoice(null, env, P.userModelSettings(env)));
  assert.deepEqual(args, [...P.launchArgs({}), '--model', 'opus', '--effort', 'xhigh'], 'the same restrictions; the model and effort Eric chose');
  assert.ok(!JSON.stringify(args).includes('bypassPermissions') && !JSON.stringify(args).includes('CR_SETTINGS_SECRET'));
  assert.deepEqual(P.launchArgs(P.sessionChoice('sonnet', env, P.userModelSettings(env))).slice(-4), ['--model', 'sonnet', '--effort', 'xhigh'], '--model comes first');
  assert.ok(!P.launchArgs(P.sessionChoice(null, { ...env, ANTHROPIC_MODEL: 'claude-opus-5-5' }, P.userModelSettings(env))).includes('--model'), 'ANTHROPIC_MODEL, kept in the environment, comes before the settings');
  assert.equal(P.launchEnv({ ANTHROPIC_MODEL: 'claude-opus-5-5' }).ANTHROPIC_MODEL, 'claude-opus-5-5');
  // A CLI that offers the shell despite --tools is refused.
  const loose = standIn(t, { leak: [{ name: 'Bash', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }] });
  await assert.rejects(launcherOf(loose).preflight({}), (e) => e.code === 'ISOLATION' && /Bash/.test(e.message));
});

test('desk credentials never reach a session or the runner\'s output: not the prompt, the arguments, the environment or the log', async (t) => {
  const s = standIn(t);
  const launch = launcherOf(s, { env: { CLAUDE_CODE_OAUTH_TOKEN: 'FICTIONAL-subscription-token-iiiiiiii' } });
  const DESK = 'https://desk.fictional.example';
  const sha = (x) => crypto.createHash('sha256').update(x, 'utf8').digest('hex');
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    const op = String(url).slice(`${DESK}/api/pilot/worker/`.length);
    calls.push({ op, auth: init.headers.authorization });
    const json = (o) => ({ status: 200, ok: true, json: async () => ({ format: 'cr-pilot-worker@1', ...o }) });
    if (op === 'claim') { n += 1; return n === 1 ? json({ status: 'claimed_now', step: 'ticket', key: 'ticket:-', token: 'a'.repeat(20), attempt_id: 'pa_FICTIONAL', expires_at: '2099-01-01T00:00:00.000Z' }) : json({ status: 'nothing', step: 'pm_review' }); }
    if (op === 'prepare') return json({ status: 'prepared', role: 'prosecutor', attempt_id: 'pa_FICTIONAL', ticket_id: 'tk_FICTIONAL', prompt: PROMPT, prompt_sha256: sha(PROMPT), sessions: { used: 1, ceiling: 6 } });
    if (op === 'complete') return json({ status: 'saved', receipt_id: 'tr_FICTIONAL' });
    return json({ status: 'released' });
  };
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pilot-launch-creds-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const said = [];
  const pollFetch = async (url, init) => {
    if (String(url).endsWith('/api/pilot/queue')) return { status: 200, json: async () => ({ format: 'cr-pilot-poll@1', paused: false, steps: [{ project_id: 'olas', step: 'ticket', claim: null }] }) };
    return fetchImpl(url, init);
  };
  const code = await P.runAll({ desk: 'online', maxAgents: 1, deskUrl: DESK, timeoutMin: 1 }, { agent: launch, fetchImpl: pollFetch, token: POLL, workerToken: WTOKEN, out: (x) => said.push(x), lockFile: path.join(d, 'lock'), logFile: path.join(d, 'log.jsonl') });
  assert.equal(code, 0);
  assert.deepEqual(calls.map((c) => c.op), ['claim', 'prepare', 'complete'], 'one session, then the run\'s cap of one');
  assert.ok(calls.every((c) => c.auth === `Bearer ${WTOKEN}`), 'the worker token goes to the desk only');
  const recs = s.records();
  assert.equal(recs.length, 2, 'the probe, then one session');
  const session = recs[1];
  assert.equal(session.stdin, PROMPT);
  const secrets = [WTOKEN, POLL, ...Object.values(SECRETS)].filter((x) => x.length >= 16);
  for (const r of recs) {
    const seen = JSON.stringify({ argv: r.argv, env: r.env, stdin: r.stdin });
    for (const x of secrets) assert.ok(!seen.includes(x), `${x.slice(0, 22)}… never reaches a session (${r.env.ANTHROPIC_BASE_URL ? 'probe' : 'session'})`);
    // The probe's own placeholder key and stand-in endpoint are the only two set there.
    const probe = Boolean(r.env.ANTHROPIC_BASE_URL);
    for (const k of Object.keys(SECRETS)) if (!(probe && ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'].includes(k))) assert.equal(r.env[k], undefined, `${k} is not in a session's environment`);
    assert.equal(r.env.CLAUDE_CODE_MESSAGING_TOKEN, undefined);
  }
  assert.equal(session.env.CLAUDE_CODE_OAUTH_TOKEN, 'FICTIONAL-subscription-token-iiiiiiii', 'the subscription sign-in a session needs is kept');
  assert.equal(recs[0].env.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'the probe never carries it to the stand-in endpoint');
  const outText = said.join('\n') + fs.readFileSync(path.join(d, 'log.jsonl'), 'utf8');
  for (const x of [WTOKEN, POLL]) assert.ok(!outText.includes(x), 'no token in the runner\'s output or its log');
  const log = JSON.parse(fs.readFileSync(path.join(d, 'log.jsonl'), 'utf8'));
  assert.deepEqual(log.isolation.tools, ['WebFetch', 'WebSearch'], 'the run\'s log records the checked boundary');
});

test('an installed CLI or machine that cannot establish the boundary fails closed before any claim', async (t) => {
  const cases = [
    ['a CLI without --strict-mcp-config', { help_drop: ['--strict-mcp-config'] }, {}, /does not list --strict-mcp-config/],
    ['a CLI without --tools or --restricted', { help_drop: ['--tools', '--restricted'] }, {}, /does not list --tools, --restricted/],
    ['a CLI without the dontAsk mode', { help_drop: ['dontAsk'] }, {}, /dontAsk/],
    ['a CLI whose --help fails', { help_fail: true }, {}, /--help did not run/],
    ['a CLI that never reaches the model endpoint', { no_request: true }, {}, /saw no model request/],
    ['a CLI that does not finish', { hang: true }, { probeTimeoutMs: 1500 }, /did not finish within/],
    ['managed settings on Linux', {}, { statFile: (f) => (f === '/etc/claude-code/managed-settings.json' ? 'present' : 'absent') }, /managed Claude Code settings/],
    ['a managed MCP file on Windows', {}, { platform: 'win32', statFile: (f) => (/ClaudeCode[\\/]managed-mcp\.json$/.test(f) ? 'present' : 'absent') }, /managed-mcp\.json/],
    ['a policy in the Windows registry', {}, { platform: 'win32', reg: regAnswer({ 'LocalMachine/Registry64': 'present' }) }, /HKLM\\SOFTWARE\\Policies\\ClaudeCode \(64-bit view: present/],
    ['a registry that cannot be read', {}, { platform: 'win32', reg: () => ({ error: Object.assign(new Error('FICTIONAL'), { code: 'EPERM' }) }) }, /could not be read/],
    ['a registry key the runner may not read', {}, { platform: 'win32', reg: regAnswer({ 'CurrentUser/Registry64': 'denied' }) }, /HKCU\\SOFTWARE\\Policies\\ClaudeCode \(could not be read: 64-bit view, access denied\)/],
    ['a CLI that offers no tools', { offer: [] }, {}, /did not offer both web capabilities/],
  ];
  for (const [name, config, over, words] of cases) {
    const s = standIn(t, config);
    const launch = launcherOf(s, over);
    await assert.rejects(launch.preflight({}), (e) => e.code === 'ISOLATION' && words.test(e.message), name);
    assert.equal(launch.ready({}), false, `${name}: not ready`);
    assert.equal(s.records().filter((r) => !r.env.ANTHROPIC_BASE_URL).length, 0, `${name}: no session started`);
    // The local runner refuses before its first claim.
    const cliCalls = [];
    assert.throws(() => P.runLocal({ project: 'olas', desk: 'local' }, { call: (a) => { cliCalls.push(a); return {}; }, agent: launch }), (e) => e.code === 'ISOLATION', name);
    assert.deepEqual(cliCalls, [], `${name}: nothing asked of the desk`);
  }
  // A Windows machine with no policy passes the policy check: every key
  // confirmed absent (PowerShell's progress noise on stderr is not an answer).
  assert.deepEqual(P.managedPolicy({ platform: 'win32', env: {}, statFile: () => 'absent', reg: regAnswer() }), []);
});

test('the Windows managed-policy check passes only a confirmed absence: access denied, a timeout, a spawn failure, an ambiguous or unfamiliar answer and a present key refuse', async (t) => {
  const win = (reg, statFile = () => 'absent') => P.managedPolicy({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, statFile, reg });
  // reg.exe's own exit 1 is what the old check read as "absent"; on this
  // machine reg.exe exits 1 with "ERROR: Access is denied." for a key the
  // user may not read (PR evidence). No exit code alone is an absence now.
  const regExeDenied = () => ({ status: 1, stdout: '', stderr: 'ERROR: Access is denied.\r\n' });
  const regExeMissing = () => ({ status: 1, stdout: '', stderr: 'ERROR: The system was unable to find the specified registry key or value.\r\n' });
  const cases = [
    ['reg.exe-style exit 1, access denied', regExeDenied, /could not be read: PowerShell exit 1/],
    ['reg.exe-style exit 1, not found (words are never parsed)', regExeMissing, /could not be read: PowerShell exit 1/],
    ['access denied in the 64-bit view', regAnswer({ 'LocalMachine/Registry64': 'denied' }), /HKLM\\SOFTWARE\\Policies\\ClaudeCode \(could not be read: 64-bit view, access denied\)/],
    ['access denied in the 32-bit view only', regAnswer({ 'CurrentUser/Registry32': 'denied' }), /HKCU\\SOFTWARE\\Policies\\ClaudeCode \(could not be read: 32-bit view, access denied\)/],
    ['a key present, whatever it holds', regAnswer({ 'CurrentUser/Registry64': 'present' }), /HKCU\\SOFTWARE\\Policies\\ClaudeCode \(64-bit view: present, values 3, subkeys 1\)/],
    ['a key whose read failed otherwise', regAnswer({ 'LocalMachine/Registry32': 'error' }), /could not be read: 32-bit view/],
    ['an unfamiliar state', regAnswer({ 'LocalMachine/Registry64': 'redirected' }), /unknown state "redirected"/],
    ['a timeout', () => ({ error: Object.assign(new Error('spawnSync powershell.exe ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null }), /could not be read: timed out/],
    ['PowerShell missing', () => ({ error: Object.assign(new Error('spawnSync powershell.exe ENOENT'), { code: 'ENOENT' }), status: null }), /could not be read: PowerShell did not run, ENOENT/],
    ['stopped by a signal', () => ({ status: null, signal: 'SIGTERM', stdout: '' }), /stopped by SIGTERM/],
    ['no answer', () => null, /could not be read: no answer/],
    ['words instead of JSON', regAnswer({}, { json: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\ClaudeCode' }), /not the expected JSON/],
    ['an empty answer', regAnswer({}, { json: '' }), /not the expected JSON/],
    ['another format', regAnswer({}, { json: JSON.stringify({ format: 'cr-policy-registry@0', keys: REG_ROWS.map((r) => ({ ...r, state: 'absent' })) }) }), /another shape/],
    ['a key not answered', regAnswer({}, { rows: REG_ROWS.slice(0, 3) }), /another shape/],
    ['a key answered twice', regAnswer({}, { rows: [...REG_ROWS.slice(0, 3), REG_ROWS[0]] }), /not answered once/],
  ];
  for (const [name, reg, words] of cases) {
    const found = win(reg);
    assert.ok(found.length > 0, `${name}: refused`);
    assert.match(found.join('; '), words, name);
  }
  // Policy files: only "does not exist" is an absence.
  const eacces = (f) => { if (/ProgramData/.test(f) && /managed-settings\.json$/.test(f)) { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; } const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
  const fileState = (f) => { try { eacces(f); return 'present'; } catch (err) { return err.code === 'ENOENT' ? 'absent' : `could not be read (${err.code})`; } };
  assert.match(win(regAnswer(), fileState).join('; '), /ProgramData.*managed-settings\.json \(could not be read \(EACCES\)\)/);
  assert.match(win(regAnswer(), (f) => (/managed-settings\.d$/.test(f) ? 'present' : 'absent')).join('; '), /managed-settings\.d/);
  assert.equal(P.policyFileState(path.join(os.tmpdir(), 'cr-FICTIONAL-no-such-policy-file.json')), 'absent');
  assert.equal(P.policyFileState(__filename), 'present');
  // The real read is PowerShell by absolute path, through .NET, both views.
  const seen = [];
  win((file, args) => { seen.push({ file, args }); return regAnswer()(); });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  const script = Buffer.from(seen[0].args[seen[0].args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  for (const s of ['OpenBaseKey', 'Registry64', 'Registry32', 'LocalMachine', 'CurrentUser', 'SOFTWARE\\Policies\\ClaudeCode', 'SecurityException', 'UnauthorizedAccessException']) assert.ok(script.includes(s), s);
  assert.ok(!/reg(\.exe)?\s+query/i.test(script), 'not reg.exe');
  // Through the launcher: refused before any claim.
  const s = standIn(t);
  const launch = launcherOf(s, { platform: 'win32', reg: regExeDenied });
  await assert.rejects(launch.preflight({}), (e) => e.code === 'ISOLATION' && /managed Claude Code settings/.test(e.message) && /could not be read/.test(e.message));
  assert.equal(s.records().length, 0, 'not even the probe ran');
});

test('the probe requires both web capabilities: an empty, missing, placeholder-only or incomplete inventory refuses; the client and server forms of search and fetch pass', async (t) => {
  const req = (tools, extra = {}) => JSON.stringify({ model: 'x', ...(tools === undefined ? {} : { tools }), ...extra });
  const ph = { name: 'DeferredToolPlaceholder', defer_loading: true, input_schema: { type: 'object', properties: {} } };
  const refused = [
    ['an empty tool list', [req([])]],
    ['no tools key', [req(undefined)]],
    ['the placeholder only', [req([ph])]],
    ['WebSearch only', [req([{ name: 'WebSearch' }, ph])]],
    ['WebFetch only', [req([{ name: 'WebFetch' }])]],
    ['the server search tool only', [req([{ name: 'web_search', type: 'web_search_20250305' }])]],
    ['search and fetch in different requests, never together', [req([{ name: 'WebSearch' }]), req([{ name: 'WebFetch' }])]],
    ['a tool list that is not a list', [req({ WebSearch: {}, WebFetch: {} })]],
    ['a request that is not an object', ['null']],
    ['a server tool with the wrong name', [req([{ name: 'WebSearch', type: 'web_search_20250305' }, { name: 'WebFetch' }])]],
  ];
  for (const [name, bodies] of refused) {
    const v = P.judgeProbe(bodies);
    assert.equal(v.ok, false, name);
  }
  assert.match(P.judgeProbe([req([ph])]).words, /did not offer both web capabilities \(search and fetch\); it offered no web tool/);
  const passed = [
    ['the client tools', [req([{ name: 'WebFetch' }, ph, { name: 'WebSearch' }])], ['WebFetch', 'WebSearch']],
    ['the server tools', [req([{ name: 'web_search', type: 'web_search_20250305' }, { name: 'web_fetch', type: 'web_fetch_20250910' }])], ['web_fetch', 'web_search']],
    ['client search and server fetch', [req([{ name: 'WebSearch', type: 'custom' }, { name: 'web_fetch', type: 'web_fetch_20250910' }])], ['WebSearch', 'web_fetch']],
    ['a side request without tools beside the session request', [req(undefined), req([{ name: 'WebSearch' }, { name: 'WebFetch' }])], ['WebFetch', 'WebSearch']],
  ];
  for (const [name, bodies, tools] of passed) {
    const v = P.judgeProbe(bodies);
    assert.equal(v.ok, true, `${name}: ${v.words || ''}`);
    assert.deepEqual(v.tools, tools, name);
  }
  // Still refused: anything beyond, even with both web capabilities present.
  assert.equal(P.judgeProbe([req([{ name: 'WebSearch' }, { name: 'WebFetch' }, { name: 'Bash' }])]).ok, false);
  assert.equal(P.judgeProbe([req([{ name: 'WebSearch' }, { name: 'WebFetch' }], { system: 'mcp__desk__save' })]).ok, false);
  // End to end through the launcher's probe and a stand-in CLI.
  for (const [name, config] of [
    ['an empty inventory', { offer: [] }],
    ['no tools key', { no_tools: true }],
    ['placeholder only', { offer: [ph] }],
    ['WebSearch only', { offer: [{ name: 'WebSearch', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }, ph] }],
  ]) {
    const s = standIn(t, config);
    const launch = launcherOf(s);
    await assert.rejects(launch.preflight({}), (e) => e.code === 'ISOLATION' && /did not offer both web capabilities/.test(e.message), name);
    assert.equal(launch.ready({}), false, name);
    assert.throws(() => launch(PROMPT, { tools: P.AGENT_TOOLS, timeoutMin: 1 }), (e) => e.code === 'ISOLATION', `${name}: no session`);
  }
  const s = standIn(t, { offer: [{ name: 'web_search', type: 'web_search_20250305' }, { name: 'web_fetch', type: 'web_fetch_20250910' }, ph] });
  assert.deepEqual((await launcherOf(s).preflight({})).tools, ['web_fetch', 'web_search'], 'the server forms pass');
});
