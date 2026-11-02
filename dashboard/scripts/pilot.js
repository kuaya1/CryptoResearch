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
// a ticket, places an order or moves money. What a session can use is set by
// its launch (cr-pilot-launch@1, below), checked before any claim is taken.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const CLI = path.join(ROOT, 'dashboard', 'cli.js');
const AGENT_TOOLS = Object.freeze(['WebSearch', 'WebFetch']);
const WEB_TOOLS = AGENT_TOOLS;
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
    else if (k === 'check-isolation') out.checkIsolation = true;
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

// ---------------------------------------------------------------------------
// The agent session's boundary (cr-pilot-launch@1, worker boundary PR
// 2026-10-31). `--allowedTools` only pre-approves tools; it never limited what
// a session had (the audit: shell, files, edits, delegation, Chrome and the
// claude.ai connectors were all there, with Eric's CLAUDE.md). Each session is
// now launched with Claude Code's documented controls:
//
//   --tools WebSearch,WebFetch        the built-in tools the model has: these two
//   --strict-mcp-config               no MCP server but the --mcp-config one,
//   --mcp-config {"mcpServers":{}}    which is empty
//   --disallowedTools mcp__*,…        every MCP tool and the shell, file,
//                                     delegation and skill tools taken out again
//   --permission-mode dontAsk         anything not pre-approved is refused
//   --restricted                      no user, project or local settings file
//                                     (their permissions, hooks, MCP and model)
//   --safe-mode                       no CLAUDE.md, skills, plugins, hooks, MCP,
//                                     custom agents or commands, auto memory
//   --settings {"disableAllHooks":…,"disableClaudeAiConnectors":true}
//   --disable-slash-commands, --no-chrome, --no-session-persistence
//   env ENABLE_CLAUDEAI_MCP_SERVERS=false (the desk's own connector included)
//
// Subscription sign-in stays (no --bare, no API key): the session's
// environment keeps the system variables, the proxy and certificate ones and
// Claude Code's own sign-in and model variables, and nothing else (no CR_*,
// no ANTHROPIC_API_KEY, which -p would bill instead of the subscription, no
// parent-session variables). The model and effort Eric's Claude Code
// settings choose (model, effortLevel) are passed as --model and --effort,
// since --restricted no longer reads that file; --model and ANTHROPIC_MODEL
// still come first. Each session runs in a new empty folder.
//
// Fail closed: before any claim, the installed CLI must list every flag above
// (--help), no managed policy may be installed (it could add hooks or allow
// rules no flag removes), and a probe must pass: the same command, against a
// local stand-in for the model endpoint with a placeholder key (nothing is
// generated or billed), may offer the model WebSearch and WebFetch only, with
// no MCP tool anywhere in the request. A session is never started on a
// command line that did not pass in this run. This bounds what the model can
// call; it is not an operating-system sandbox: the claude process itself
// runs as Eric, with his files reachable to that process.
const LAUNCH_FORMAT = 'cr-pilot-launch@1';
const DENIED_TOOLS = Object.freeze(['mcp__*', 'Bash', 'PowerShell', 'Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep', 'Agent', 'Task', 'Skill', 'ToolSearch', 'Workflow', 'ListAgents', 'SendMessage']);
const SESSION_SETTINGS = Object.freeze({ disableAllHooks: true, disableClaudeAiConnectors: true });
const REQUIRED_FLAGS = Object.freeze(['--print', '--output-format', '--tools', '--allowedTools', '--disallowedTools', '--permission-mode', '--strict-mcp-config', '--mcp-config', '--restricted', '--safe-mode', '--settings', '--disable-slash-commands', '--no-chrome', '--no-session-persistence', '--model', '--effort']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;
// The environment a session keeps (names, any case); everything else is dropped.
const ENV_KEEP = new Set([
  'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT', 'PATH', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432',
  'ALLUSERSPROFILE', 'PUBLIC', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_GIT_BASH_PATH', 'ANTHROPIC_MODEL',
]);
const ENV_KEEP_RE = /^ANTHROPIC_DEFAULT_[A-Z0-9]+_MODEL$/;
const PROBE_KEY = 'sk-ant-api03-cr-pilot-isolation-probe-not-a-key';
const PROBE_PROMPT = 'cr-pilot-launch@1 isolation probe: nothing is generated.';
const PLACEHOLDER = 'DeferredToolPlaceholder';

const isolationError = (words) => Object.assign(new Error(`The agent session's tool boundary could not be established: ${words} No claim was taken and no session was started.`), { code: 'ISOLATION' });

function launchEnv(parent = process.env) {
  const out = {};
  for (const k of Object.keys(parent)) {
    const u = k.toUpperCase();
    if (ENV_KEEP.has(u) || ENV_KEEP_RE.test(u)) out[k] = parent[k];
  }
  out.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  return out;
}

// The model and effort Eric's Claude Code settings choose (model,
// effortLevel), from %USERPROFILE%\.claude\settings.json or CLAUDE_CONFIG_DIR.
// Only those two keys are read; a file that does not read chooses nothing,
// as Claude Code itself ignores it in -p.
function userModelSettings(env = process.env, { read = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  let s = null;
  try { s = JSON.parse(read(path.join(dir, 'settings.json'))); } catch (_) { return { model: null, effort: null }; }
  return { model: s && typeof s.model === 'string' ? s.model : null, effort: s && typeof s.effortLevel === 'string' ? s.effortLevel : null };
}

// --model, else ANTHROPIC_MODEL (kept in the session's environment), else
// the settings' model; the settings' effort.
function sessionChoice(model, env, settings) {
  const m = model || (env.ANTHROPIC_MODEL ? null : settings.model || null);
  if (m && !MODEL_RE.test(m)) throw isolationError(`"${String(m).slice(0, 60)}" is not a model name.`);
  const effort = settings.effort && EFFORTS.has(settings.effort) ? settings.effort : null;
  return { model: m, effort };
}

function launchArgs({ model = null, effort = null } = {}) {
  return [
    '--print', '--output-format', 'text',
    '--tools', AGENT_TOOLS.join(','),
    '--allowedTools', AGENT_TOOLS.join(','),
    '--disallowedTools', DENIED_TOOLS.join(','),
    '--permission-mode', 'dontAsk',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--restricted', '--safe-mode',
    '--settings', JSON.stringify(SESSION_SETTINGS),
    '--disable-slash-commands', '--no-chrome', '--no-session-persistence',
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
  ];
}

// Each session's own new, empty folder (not a boundary: the model has no file tool).
function sessionDir() {
  const base = path.join(os.tmpdir(), 'cr-pilot', 'session');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, 's-'));
}

// Managed (policy) settings can add hooks, allow rules or MCP servers that no
// launch flag removes, so a machine that has them is refused. Only a confirmed
// absence passes: a policy file or key that is present (whatever it holds),
// that cannot be read, or whose state is not known refuses the launch.
//
// A policy file: absent only when the file system says it does not exist
// (ENOENT, ENOTDIR); a permission or other error is "could not be read".
function policyFileState(f) {
  try {
    fs.statSync(f);
    return 'present';
  } catch (err) {
    return err && (err.code === 'ENOENT' || err.code === 'ENOTDIR') ? 'absent' : `could not be read (${(err && err.code) || 'error'})`;
  }
}

// The Windows policy keys are read through the registry API, not reg.exe:
// reg.exe exits 1 both for a missing key and for one it may not read, and its
// words are localized. A PowerShell child opens each key with .NET
// (Microsoft.Win32.RegistryKey, in the 64- and 32-bit registry views) and
// reports one structured state per key: absent (OpenSubKey returned null),
// present, denied (SecurityException, UnauthorizedAccessException) or error.
// Only an answer in exactly that shape with every key absent is an absence; a
// spawn failure, a timeout, another exit, other output or a missing row
// refuses (cr-policy-registry@1).
const POLICY_SUBKEY = 'SOFTWARE\\Policies\\ClaudeCode';
const REG_FORMAT = 'cr-policy-registry@1';
const REG_HIVES = Object.freeze({ LocalMachine: 'HKLM', CurrentUser: 'HKCU' });
const REG_VIEWS = Object.freeze({ Registry64: '64-bit view', Registry32: '32-bit view' });
const REG_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$rows = New-Object System.Collections.ArrayList',
  `foreach ($h in @(${Object.keys(REG_HIVES).map((h) => `'${h}'`).join(',')})) {`,
  `  foreach ($v in @(${Object.keys(REG_VIEWS).map((v) => `'${v}'`).join(',')})) {`,
  "    $state = 'error'; $detail = ''",
  '    try {',
  '      $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]$h, [Microsoft.Win32.RegistryView]$v)',
  '      try {',
  `        $k = $base.OpenSubKey('${POLICY_SUBKEY}', $false)`,
  "        if ($null -eq $k) { $state = 'absent' }",
  "        else { try { $state = 'present'; $detail = 'values ' + $k.ValueCount + ', subkeys ' + $k.SubKeyCount } finally { $k.Close() } }",
  '      } finally { $base.Close() }',
  "    } catch [System.Security.SecurityException] { $state = 'denied'; $detail = $_.Exception.GetType().FullName }",
  "    catch [System.UnauthorizedAccessException] { $state = 'denied'; $detail = $_.Exception.GetType().FullName }",
  "    catch { $state = 'error'; $detail = $_.Exception.GetType().FullName }",
  '    [void]$rows.Add([ordered]@{ hive = $h; view = $v; state = $state; detail = $detail })',
  '  }',
  '}',
  `[Console]::Out.Write((ConvertTo-Json -Compress -Depth 4 ([ordered]@{ format = '${REG_FORMAT}'; keys = @($rows) })))`,
].join('\n');

function regQuery(env, run = spawnSync) {
  const ps = path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(REG_SCRIPT, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
}

// The registry answer, judged: [] only when every policy key is confirmed absent.
function readPolicyRegistry(r) {
  const unread = (why) => [`${Object.values(REG_HIVES).map((h) => `${h}\\${POLICY_SUBKEY}`).join(', ')} (could not be read: ${why})`];
  if (!r) return unread('no answer');
  if (r.error) return unread(r.error.code === 'ETIMEDOUT' ? 'timed out' : `PowerShell did not run, ${r.error.code || r.error.message}`);
  if (r.signal) return unread(`stopped by ${r.signal}`);
  if (r.status !== 0) return unread(`PowerShell exit ${r.status}`);
  let j = null;
  try { j = JSON.parse(String(r.stdout || '').trim()); } catch (_) { return unread('an answer that is not the expected JSON'); }
  if (!j || j.format !== REG_FORMAT || !Array.isArray(j.keys) || j.keys.length !== Object.keys(REG_HIVES).length * Object.keys(REG_VIEWS).length) return unread('an answer in another shape');
  const found = [];
  for (const [hive, short] of Object.entries(REG_HIVES)) {
    for (const [view, words] of Object.entries(REG_VIEWS)) {
      const rows = j.keys.filter((x) => x && x.hive === hive && x.view === view);
      const key = `${short}\\${POLICY_SUBKEY}`;
      if (rows.length !== 1) { found.push(`${key} (could not be read: ${words} not answered once)`); continue; }
      const { state, detail } = rows[0];
      if (state === 'absent') continue;
      if (state === 'present') found.push(`${key} (${words}: present, ${String(detail || '').slice(0, 60)})`);
      else if (state === 'denied') found.push(`${key} (could not be read: ${words}, access denied)`);
      else found.push(`${key} (could not be read: ${words}, ${state === 'error' ? String(detail || 'error').slice(0, 80) : `unknown state ${JSON.stringify(String(state)).slice(0, 40)}`})`);
    }
  }
  return found;
}

// `statFile` and `reg` (a spawnSync-like runner for the registry read) are
// the tests' seams.
function managedPolicy({ platform = process.platform, env = process.env, statFile = policyFileState, reg = null } = {}) {
  const files = platform === 'win32'
    ? [...new Set([env.ProgramW6432, env.ProgramFiles, 'C:\\Program Files'].filter(Boolean))].map((d) => path.win32.join(d, 'ClaudeCode'))
      .concat([path.win32.join(env.ProgramData || env.ALLUSERSPROFILE || 'C:\\ProgramData', 'ClaudeCode')])
      .flatMap((d) => ['managed-settings.json', 'managed-mcp.json', 'managed-settings.d'].map((n) => path.win32.join(d, n)))
    : platform === 'darwin' ? ['/Library/Application Support/ClaudeCode/managed-settings.json', '/Library/Application Support/ClaudeCode/managed-mcp.json', '/Library/Application Support/ClaudeCode/managed-settings.d', '/Library/Managed Preferences/com.anthropic.claudecode.plist']
      : ['/etc/claude-code/managed-settings.json', '/etc/claude-code/managed-mcp.json', '/etc/claude-code/managed-settings.d'];
  const found = [];
  for (const f of files) {
    const s = statFile(f);
    if (s === 'absent') continue;
    found.push(s === 'present' ? f : `${f} (${String(s).slice(0, 60)})`);
  }
  if (platform === 'win32') found.push(...readPolicyRegistry(regQuery(env, reg || spawnSync)));
  return found;
}

// What the installed CLI says it supports, without generating anything.
function checkHelp(bin, env, { run = spawnSync } = {}) {
  const r = run(bin.file, [...bin.args, '--help'], { encoding: 'utf8', env: launchEnv(env), timeout: 60000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (!r || r.error || r.status !== 0) throw isolationError(`claude --help did not run (${r && r.error ? r.error.code || r.error.message : `exit ${r && r.status}`}).`);
  const text = String(r.stdout || '');
  const missing = REQUIRED_FLAGS.filter((f) => !new RegExp(`(^|[\\s,])${f.replace(/[-]/g, '\\-')}(?=[\\s,<=]|$)`, 'm').test(text));
  if (!/"dontAsk"/.test(text)) missing.push('--permission-mode "dontAsk"');
  if (missing.length) throw isolationError(`the installed Claude Code does not list ${missing.join(', ')} (claude --help).`);
  const v = run(bin.file, [...bin.args, '--version'], { encoding: 'utf8', env: launchEnv(env), timeout: 30000, windowsHide: true });
  return v && v.status === 0 ? String(v.stdout || '').trim().slice(0, 80) : null;
}

// The capability one offered tool gives, in either form a request may carry
// it: Claude Code's own client tools (WebSearch, WebFetch) or the API's
// server tools (web_search_<date>, web_fetch_<date>). null for anything else.
function capabilityOf(t) {
  if (!t || typeof t !== 'object') return null;
  const client = !t.type || t.type === 'custom';
  if (client && t.name === 'WebSearch') return 'search';
  if (client && t.name === 'WebFetch') return 'fetch';
  if (t.name === 'web_search' && /^web_search_\d+$/.test(String(t.type))) return 'search';
  if (t.name === 'web_fetch' && /^web_fetch_\d+$/.test(String(t.type))) return 'fetch';
  return null;
}
const CAPABILITIES = Object.freeze(['search', 'fetch']);

// One tool the model is offered, judged: a web capability; Claude Code's
// inert deferred-loading placeholder (no input, never callable); nothing else.
function toolAllowed(t) {
  if (capabilityOf(t)) return true;
  if (!t || typeof t !== 'object') return false;
  const props = t.input_schema && t.input_schema.properties ? Object.keys(t.input_schema.properties) : [];
  return t.name === PLACEHOLDER && t.defer_loading === true && props.length === 0;
}

// The probe's verdict on the model requests the CLI sent to the stand-in.
// Every request may offer the web capabilities and the inert placeholder only,
// with no MCP tool or server named anywhere; and the session's own request
// must offer both, search and fetch. An empty, missing, placeholder-only or
// incomplete tool list is not the checked boundary: the session would not be
// the one this runner was built for, so it refuses too.
function judgeProbe(bodies) {
  if (!bodies.length) return { ok: false, words: 'the probe saw no model request, so what the session would be offered is unknown.' };
  const seen = new Set();
  let complete = false;
  for (const raw of bodies) {
    let j = null;
    try { j = JSON.parse(raw); } catch (_) { return { ok: false, words: 'the probe could not read a model request.' }; }
    if (!j || typeof j !== 'object') return { ok: false, words: 'the probe could not read a model request.' };
    if (j.tools !== undefined && !Array.isArray(j.tools)) return { ok: false, words: 'the session\'s model request carries a tool list the probe cannot read.' };
    const tools = Array.isArray(j.tools) ? j.tools : [];
    const extra = tools.filter((t) => !toolAllowed(t)).map((t) => String((t && t.name) || (t && t.type) || '?'));
    if (extra.length) return { ok: false, words: `the session would be offered ${[...new Set(extra)].slice(0, 12).join(', ')}, beyond ${AGENT_TOOLS.join(' and ')}.` };
    if (Array.isArray(j.mcp_servers) && j.mcp_servers.length) return { ok: false, words: 'the session\'s model request names MCP servers.' };
    if (raw.includes('mcp__')) return { ok: false, words: 'the session\'s model request names an MCP tool.' };
    const caps = new Set(tools.map(capabilityOf).filter(Boolean));
    if (CAPABILITIES.every((c) => caps.has(c))) complete = true;
    for (const t of tools) if (capabilityOf(t)) seen.add(t.name);
  }
  if (!complete) {
    const offered = seen.size ? [...seen].sort().join(', ') : 'no web tool';
    return { ok: false, words: `the session's model request did not offer both web capabilities (search and fetch); it offered ${offered}. An empty, placeholder-only or incomplete tool list is not the checked boundary.` };
  }
  return { ok: true, tools: [...seen].sort() };
}

// The CLI, launched exactly as a session would be, against a local stand-in
// for the model endpoint (127.0.0.1, a placeholder key, every request answered
// 400): what it would offer the model, with nothing generated or billed.
// `cwd` (a test's project folder) replaces the new empty folder.
function probeTools(bin, args, env, { timeoutMs = 60000, spawnImpl = spawn, cwd: inFolder = null } = {}) {
  return new Promise((resolve) => {
    const bodies = [];
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (req.method === 'POST' && /\/v1\/messages/.test(req.url)) bodies.push(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'cr-pilot-launch@1 isolation probe: nothing is generated.' } }));
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const cwd = inFolder || sessionDir();
      const childEnv = { ...launchEnv(env), ANTHROPIC_API_KEY: PROBE_KEY, ANTHROPIC_BASE_URL: `http://127.0.0.1:${srv.address().port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
      for (const k of Object.keys(childEnv)) if (k.toUpperCase() === 'CLAUDE_CODE_OAUTH_TOKEN') delete childEnv[k];
      let done = false;
      const finish = (extra) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        srv.close();
        if (!inFolder) { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) { /* an empty folder */ } }
        resolve(extra || judgeProbe(bodies));
      };
      let child;
      try {
        child = spawnImpl(bin.file, [...bin.args, ...args], { cwd, env: childEnv, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      } catch (err) {
        finish({ ok: false, words: `the probe could not start claude (${err.code || err.message}).` });
        return;
      }
      const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* gone */ } finish({ ok: false, words: `the probe did not finish within ${Math.round(timeoutMs / 1000)} s.` }); }, timeoutMs);
      child.on('error', (err) => finish({ ok: false, words: `the probe could not start claude (${err.code || err.message}).` }));
      child.on('close', () => finish());
      child.stdin.on('error', () => {});
      child.stdin.end(PROBE_PROMPT);
    });
  });
}

// A launcher: the session function the runners call, with its preflight.
// Tests give it a stand-in executable (bin) and environment; the runner's own
// is makeLauncher() on the real claude.
function makeLauncher({ bin = null, env = process.env, settings = null, platform = process.platform, exists = fs.existsSync, statFile = policyFileState, reg = null, run = spawnSync, spawnImpl = spawn, probeTimeoutMs = 60000 } = {}) {
  const passed = new Map();
  const binOf = () => bin || { file: resolveClaude({ platform, env, exists }), args: [] };
  const argsFor = (model) => launchArgs(sessionChoice(model, env, settings || userModelSettings(env)));
  const key = (b, args) => JSON.stringify([b.file, ...b.args, ...args]);

  async function preflight(o = {}) {
    const b = binOf();
    const args = argsFor(o.model || null);
    const k = key(b, args);
    if (passed.has(k)) return passed.get(k);
    const policy = managedPolicy({ platform, env, statFile, reg });
    if (policy.length) throw isolationError(`managed Claude Code settings are installed on this machine (${policy.join('; ')}); they can add hooks, allow rules or MCP servers that no launch flag removes.`);
    const version = checkHelp(b, env, { run });
    const p = await probeTools(b, args, env, { timeoutMs: probeTimeoutMs, spawnImpl });
    if (!p.ok) throw isolationError(p.words);
    const verdict = { format: LAUNCH_FORMAT, ok: true, cli_version: version, tools: p.tools, args };
    passed.set(k, verdict);
    return verdict;
  }
  const ready = (o = {}) => { try { return passed.has(key(binOf(), argsFor(o.model || null))); } catch (_) { return false; } };

  // One `claude -p` session: the prompt on stdin (a frozen prompt is far
  // longer than a Windows command line), the answer as text.
  function session(prompt, { tools, model, timeoutMin }) {
    if (!Array.isArray(tools) || tools.length !== AGENT_TOOLS.length || !AGENT_TOOLS.every((t) => tools.includes(t))) throw isolationError(`a session is given ${AGENT_TOOLS.join(' and ')} only, not ${JSON.stringify(tools)}.`);
    const b = binOf();
    const args = argsFor(model || null);
    if (!passed.has(key(b, args))) throw isolationError('this command line was not checked in this run.');
    const cwd = sessionDir();
    let r;
    try {
      r = run(b.file, [...b.args, ...args], { cwd, input: prompt, env: launchEnv(env), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMin * 60000, windowsHide: true });
    } finally {
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) { /* an empty folder */ }
    }
    // A session that timed out or was stopped by a signal may still have been
    // working: its outcome is uncertain, never retried.
    if ((r.error && r.error.code === 'ETIMEDOUT') || r.signal) throw Object.assign(new Error(`claude -p did not finish (${r.error ? r.error.code : r.signal}) within ${timeoutMin} minutes.`), { uncertain: true });
    if (r.error) throw new Error(`claude -p could not run: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`claude -p stopped (exit ${r.status}): ${(r.stderr || '').trim().slice(0, 600)}`);
    return r.stdout;
  }
  session.preflight = preflight;
  session.ready = ready;
  return session;
}

const claude = makeLauncher();

// The runners check the launch before any claim: a launcher with a preflight
// must pass it (a stand-in agent in a test has none).
async function preflightOf(agent, o) {
  if (o.dryRun || !agent || typeof agent.preflight !== 'function') return null;
  return agent.preflight(o);
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
const CLAIM_STOPS = new Set(['claimed', 'reconcile', 'correction_limit', 'paused', 'stopped', 'session_ceiling', 'sessions_unknown']);

// Before a session's answer is saved: Eric's stop since the dispatch lets the
// claim go as autonomy_stopped (tickets check); the answer stays in its
// scratch file and nothing is saved. Null when the save may go on.
function stoppedSince(cli, project, token, file) {
  if (!token) return null;
  const c = cli(['tickets', 'check', project, '--token', token]);
  if (c.status !== 'stopped') return null;
  say(`    Not saved: ${c.words} The session's answer is kept at ${file}.`);
  return { stop: 'stopped', words: c.words || null, session_stopped: true };
}

// A claim not yet bound is let go when the runner stops; a bound one (an
// agent was dispatched and its outcome is unknown) is left to expire, so the
// next runner reconciles instead of dispatching it again.
function runLocal(o, { call = cli, agent = claude } = {}) {
  const h = { token: null, bound: false };
  // The launch was checked before this (main, runAll); nothing is claimed otherwise.
  if (!o.dryRun && agent && typeof agent.ready === 'function' && !agent.ready(o)) throw isolationError('it was not checked before this run.');
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
      const halted = stoppedSince(cli, o.project, token, f);
      if (halted) { Object.assign(h, { token: null, bound: false }); return halted; }
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
      const halted = stoppedSince(cli, o.project, token, f);
      if (halted) { Object.assign(h, { token: null, bound: false }); return halted; }
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
// Uncertainty is kept, never re-run: a lost or timed-out answer from the
// desk, or a session that timed out, leaves the claim dispatched for Eric to
// reconcile on the online desk; no session is run again by itself. The one
// request asked again is complete (OP-2, 2026-11-02: JUP's answer was lost to
// "fetch failed" at the last step): the desk's save is idempotent under the
// claim (the same report imports as a duplicate; a claim already released
// answers CHANGED), so a lost answer is asked again 5 times, at 1, 2, 4, 8 and
// 16 s, while the claim is live. A refusal is not asked again. If every try
// fails, the answer, its run and the claim's token are kept together under
// %USERPROFILE%\.cryptoresearch\pending-submissions (never the worker token)
// and the claim waits for Eric to reconcile, as before. A session
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
    // undici's "fetch failed" hides the reason in err.cause (ECONNRESET,
    // ENOTFOUND, UND_ERR_CONNECT_TIMEOUT, ...): it is kept in the words.
    const cause = err && err.cause ? String(err.cause.code || err.cause.message || '').slice(0, 80) : '';
    throw Object.assign(new Error(`The online desk did not answer ${op} (${err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : String(err && err.message || err).slice(0, 120)}${cause ? `: ${cause}` : ''}).`), { uncertain: true });
  }
  let json = null;
  try { json = await res.json(); } catch (_) { json = null; }
  if (res.status >= 500 || (res.ok && (!json || json.format !== WORKER_FORMAT))) throw Object.assign(new Error(`The online desk's answer to ${op} is not settled (${res.status}${json && json.error ? `: ${String(json.error).slice(0, 200)}` : ''}).`), { uncertain: true, status: res.status });
  if (!res.ok) throw Object.assign(new Error(`The online desk refused ${op} (${res.status}${json && json.code ? ` ${json.code}` : ''}${res.status === 404 ? ', CR_PILOT_WORKER_TOKEN_SHA256 is not set on the desk' : ''}): ${json && json.error ? String(json.error).slice(0, 300) : 'no reason given'}`), { status: res.status, code: (json && json.code) || null });
  return json;
}

// complete, asked again only while its answer is uncertain and the claim is
// live (see above). A refusal after a lost answer is CHANGED when the lost
// try already saved it; either way the claim is Eric's to check.
const COMPLETE_BACKOFF_MS = Object.freeze([1000, 2000, 4000, 8000, 16000]);
const PENDING_FORMAT = 'cr-pilot-pending@1';
const pendingDirOf = () => path.join(homeDir(), 'pending-submissions');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function completeOnline(post, body, { expiresAt = null, delays = COMPLETE_BACKOFF_MS, sleep = pause, now = Date.now, out = () => {} } = {}) {
  const attempts = [];
  for (let i = 0; ; i++) {
    try {
      return { done: await post('complete', body, { timeoutMs: 300000 }), attempts };
    } catch (err) {
      attempts.push({ at: new Date(now()).toISOString(), uncertain: Boolean(err && err.uncertain), status: (err && err.status) || null, error: String(err && err.message || err).slice(0, 300) });
      if (!(err && err.uncertain)) {
        if (i > 0 && err && err.code === 'CHANGED') err.message = `${err.message} An earlier try whose answer was lost may have saved it.`;
        throw Object.assign(err, { attempts });
      }
      const wait = delays[i];
      const exp = expiresAt ? Date.parse(expiresAt) : NaN;
      if (wait === undefined || (Number.isFinite(exp) && now() + wait >= exp)) {
        if (attempts.length > 1) err.message = `${err.message} (${attempts.length} tries.)`;
        throw Object.assign(err, { attempts });
      }
      out(`    complete: ${err.message} Asking again in ${wait / 1000} s (retry ${i + 1} of ${delays.length}).`);
      await sleep(wait);
    }
  }
}

// The answer complete could not deliver, with what can still deliver it: the
// run or ticket, the prompt's SHA-256 and the claim (its token works only on
// this attempt, only until it expires). Never the worker token.
function savePendingSubmission(dir, rec) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${rec.project_id}__${rec.attempt_id}.json`);
  fs.writeFileSync(f, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
  return f;
}

async function runOnline(o, { run = claude, out = say, fetchImpl = globalThis.fetch, token = null, env = process.env, sleep = pause, now = Date.now, pendingDir = null, completeDelays = COMPLETE_BACKOFF_MS } = {}) {
  if (o.forceProsecution) throw new Error('Eric\'s override (--force-prosecution) is local only: the online worker never forces a Prosecutor.');
  const desk = deskUrlOf(o, env);
  const result = { sessions: [], stop: null, words: null, claims: [] };
  if (o.dryRun) {
    out(`Would claim ${o.project}'s next step on ${desk}, have the desk prepare its frozen prompt, run it in a fresh claude -p session with ${WEB_TOOLS.join(', ')} only, and give the answer back to the desk to save and verify.`);
    return result;
  }
  // The session's tool boundary, before the token is read or a claim taken.
  await preflightOf(run, o);
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
    // Another request prepared this attempt (only this runner holds its
    // token): no session here, and the claim is left exactly as it is.
    if (p.status === 'already_prepared') return stop('reconcile', `${p.words || `Attempt ${c.attempt_id} was already prepared.`} ${ONLINE_RECONCILE(o.project)}`);
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
      done = (await completeOnline(post, { token: c.token, prompt_sha256: p.prompt_sha256, text: answer }, { expiresAt: c.expires_at, delays: completeDelays, sleep, now, out })).done;
    } catch (err) {
      let kept = '';
      try {
        const pf = savePendingSubmission(pendingDir || pendingDirOf(), { format: PENDING_FORMAT, saved_at: new Date(now()).toISOString(), desk, project_id: o.project, attempt_id: c.attempt_id, key: c.key, claim_token: c.token, claim_expires_at: c.expires_at, role: p.role, run_id: p.run_id || null, ticket_id: p.ticket_id || null, prompt_sha256: p.prompt_sha256, text_sha256: sha256(answer), text_file: f, attempts: err.attempts || [], text: answer });
        kept = ` The unsent answer, its record and the claim are kept together at ${pf}.`;
      } catch (e2) {
        kept = ` (The pending-submission copy could not be written: ${String(e2 && (e2.code || e2.message) || e2).slice(0, 120)}.)`;
      }
      return stop('reconcile', `${err.message} The session's answer is kept at ${f}.${kept} ${ONLINE_RECONCILE(o.project)}`);
    }
    out(`    ${done.status === 'stopped' ? 'not saved' : 'saved'}: ${done.status} ${done.report_id || done.receipt_id || ''}${done.words ? ` — ${done.words}` : ''}`);
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
    // The session's tool boundary, checked once before the first claim; when
    // it cannot be established nothing is claimed or dispatched.
    if (todo.length) {
      const v = await preflightOf(agent, o);
      if (v) log.isolation = { format: v.format, cli_version: v.cli_version, tools: v.tools };
    }
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
        if (r && r.session_stopped) row.session_stopped = true;
      } catch (err) {
        row.outcome = 'error';
        row.error = String(err && err.message || err).slice(0, 300);
        out(`    ${s.project_id}: ${row.error}`);
      }
      row.agents = before - budget.left;
      // A session Eric's stop overtook ran but saved nothing: stopped, never done.
      if (row.stop) row.outcome = row.stop === 'cap' ? 'cap' : row.stop === 'stopped' && (row.sessions || row.session_stopped) ? 'stopped' : 'not_dispatched';
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

async function main() {
  const o = parse(process.argv.slice(2));
  if (o.checkIsolation) {
    // The launch check alone: nothing is claimed, generated or billed.
    try {
      const v = await claude.preflight(o);
      say(JSON.stringify({ ...v, words: `A session would be offered ${v.tools.join(' and ') || 'no tool'} only.` }, null, 2));
    } catch (err) {
      say(JSON.stringify({ format: LAUNCH_FORMAT, ok: false, words: err.message }, null, 2));
      process.exitCode = 1;
    }
    return;
  }
  if (o.pilotAll) { process.exitCode = await runAll(o); return; }
  if (o.help || !o.project) {
    say('npm run pilot -- --project=<id> [--desk=local|online] [--dry-run] [--force-prosecution [--owner-words="…"]] [--model=<id>] [--timeout-min=60] [--connector=mcp__claude_ai_CryptoResearch]');
    say('npm run pilot -- --pilot-all [--desk=local|online] [--max-agents=2] [--dry-run] [--timeout-min=60] [--desk-url=https://…]');
    say('npm run pilot -- --check-isolation [--model=<id>]   the session launch check only (no claim, no generation)');
    process.exitCode = o.help ? 0 : 2;
    return;
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(o.project)) throw new Error(`"${o.project}" is not a project ID.`);
  if (o.desk === 'online') { const r = await runOnline(o); if (r && r.stop === 'reconcile') process.exitCode = 3; return; }
  if (o.desk !== 'local') throw new Error('--desk is local or online.');
  await preflightOf(claude, o);
  runLocal(o);
}

module.exports = { resolveClaude, parse, forcedTicket, runOnline, completeOnline, savePendingSubmission, COMPLETE_BACKOFF_MS, PENDING_FORMAT, runLocal, runAll, takeLock, lockPath, pilotLogPath, LOCK_STALE_MS,readPollToken, readWorkerToken, workerCall, deskUrlOf, pollOnline, pollLocal, FORCE_WORDS, ALL_ORDER, RECONCILE_WORDS, ONLINE_RECONCILE, WEB_TOOLS, AGENT_TOOLS, CLAIM_STOPS, LAUNCH_FORMAT, DENIED_TOOLS, REQUIRED_FLAGS, launchArgs, launchEnv, sessionChoice, userModelSettings, managedPolicy, policyFileState, readPolicyRegistry, regQuery, REG_FORMAT, REG_SCRIPT, POLICY_SUBKEY, judgeProbe, capabilityOf, probeTools, makeLauncher };

if (require.main === module) {
  Promise.resolve().then(main).catch((err) => {
    process.stderr.write(`pilot: ${err.message}\n`);
    process.exitCode = 1;
  });
}
