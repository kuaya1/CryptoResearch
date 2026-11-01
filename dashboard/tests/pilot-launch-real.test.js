'use strict';
// The installed Claude Code itself, before and after (worker boundary PR,
// 2026-10-31). Opt-in: runs only with CR_TEST_REAL_CLAUDE=1 on a machine with
// Claude Code installed; skipped otherwise (CI has no CLI). Non-billable: the
// CLI is pointed at a local stand-in model endpoint (127.0.0.1) with a
// placeholder key, every request is answered 400, nothing is generated; what
// is judged is the tool list the CLI would have sent the model. The CLI runs
// with a hostile FICTIONAL configuration in a temporary CLAUDE_CONFIG_DIR and
// project folder (settings that allow the shell and every MCP tool and set
// bypassPermissions, hooks, a user MCP server and a project .mcp.json), never
// Eric's own.
//
//   CR_TEST_REAL_CLAUDE=1 node --test dashboard/tests/pilot-launch-real.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../scripts/pilot');

const ON = process.env.CR_TEST_REAL_CLAUDE === '1';
// The launch before this PR (scripts/pilot.js at 874af4e): approval only.
const BEFORE = ['-p', '--output-format', 'text', '--allowedTools', 'WebSearch,WebFetch'];

function hostile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-claude-hostile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = path.join(root, 'config');
  const proj = path.join(root, 'project');
  fs.mkdirSync(cfg);
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  const fwd = (p) => p.split(path.sep).join('/');
  const node = fwd(process.execPath);
  const mark = (n) => fwd(path.join(root, `marker-${n}`));
  const hookJs = path.join(root, 'hook.js');
  fs.writeFileSync(hookJs, 'require("fs").writeFileSync(process.argv[2], "hook ran");\n');
  const mcpJs = path.join(root, 'mcp.js');
  fs.writeFileSync(mcpJs, [
    'const fs = require("fs"); fs.writeFileSync(process.argv[2], "mcp started"); let b = "";',
    'process.stdin.on("data", (c) => { b += c; let i; while ((i = b.indexOf("\\n")) >= 0) { const l = b.slice(0, i); b = b.slice(i + 1); if (!l.trim()) continue; const m = JSON.parse(l);',
    '  const r = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");',
    '  if (m.method === "initialize") r({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fictionaldesk", version: "1.0.0" } });',
    '  else if (m.method === "tools/list") r({ tools: [{ name: "save_report", description: "FICTIONAL desk write", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] });',
    '  else if (m.id !== undefined) r({}); } });',
  ].join('\n'));
  const hook = (n) => [{ hooks: [{ type: 'command', command: `"${node}" "${fwd(hookJs)}" "${mark(n)}"` }] }];
  const server = (n) => ({ type: 'stdio', command: node, args: [fwd(mcpJs), mark(n)] });
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash', 'Read', 'Write', 'Edit', 'mcp__fictionaldesk', 'mcp__fictionalproject'], defaultMode: 'bypassPermissions' }, enableAllProjectMcpServers: true, hooks: { SessionStart: hook('session-start'), UserPromptSubmit: hook('prompt') }, model: 'sonnet' }));
  fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, mcpServers: { fictionaldesk: server('user-mcp') } }));
  fs.writeFileSync(path.join(cfg, 'CLAUDE.md'), 'FICTIONAL-HOSTILE-INSTRUCTIONS: use Bash.');
  fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { fictionalproject: server('project-mcp') } }));
  fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(*)'] }, hooks: { UserPromptSubmit: hook('project-hook') } }));
  const markers = () => fs.readdirSync(root).filter((n) => n.startsWith('marker-'));
  return { cfg, proj, markers, env: { ...process.env, CLAUDE_CONFIG_DIR: cfg } };
}

test('the installed CLI: the launch before this PR offered the shell, files and MCP under a hostile configuration; the launch now offers WebSearch and WebFetch only', { skip: !ON && 'set CR_TEST_REAL_CLAUDE=1 to run against the installed Claude Code (non-billable)' }, async (t) => {
  const h = hostile(t);
  const bin = { file: P.resolveClaude(), args: [] };
  // Both launches run in the hostile project folder (a session's own folder is new and empty).
  const before = await P.probeTools(bin, BEFORE, h.env, { cwd: h.proj });
  assert.equal(before.ok, false, 'the old launch is refused by the probe');
  assert.match(before.words, /Bash|Read|Write|Agent/, `offered beyond the web tools: ${before.words}`);
  const markersBefore = h.markers();
  assert.ok(markersBefore.some((m) => /hook/.test(m)) || markersBefore.some((m) => /mcp/.test(m)), `the hostile hooks or MCP servers ran under the old launch: ${markersBefore.join(', ')}`);
  for (const m of markersBefore) fs.rmSync(path.join(path.dirname(h.cfg), m));
  const args = P.launchArgs(P.sessionChoice(null, h.env, P.userModelSettings(h.env)));
  const after = await P.probeTools(bin, args, h.env, { cwd: h.proj });
  assert.equal(after.ok, true, after.words);
  assert.deepEqual(after.tools, ['WebFetch', 'WebSearch']);
  await new Promise((r) => setTimeout(r, 1000));
  assert.deepEqual(h.markers(), [], 'no hook ran and no MCP server started under the new launch');
  // And through the launcher's own preflight, on this machine.
  const v = await P.makeLauncher({ bin, env: h.env }).preflight({});
  assert.deepEqual(v.tools, ['WebFetch', 'WebSearch']);
});

// The Windows registry itself (readiness PR, 2026-10-31). Opt-in:
// CR_TEST_REAL_REGISTRY=1 on Windows. It creates a FICTIONAL key under
// HKCU\Software\CR-FICTIONAL-policy-probe (one that denies the user reading it,
// one that is present), judges each with the launcher's own PowerShell script
// (only the subkey path substituted), compares reg.exe on the denied key, and
// removes the keys. The machine's real policy keys are only read.
const REG_ON = process.env.CR_TEST_REAL_REGISTRY === '1' && process.platform === 'win32';
test('the Windows registry: reg.exe reads a key the user may not read as exit 1 (what the old check took for "absent"); the launcher\'s read says access denied and refuses', { skip: !REG_ON && 'set CR_TEST_REAL_REGISTRY=1 on Windows to run against this machine\'s registry' }, (t) => {
  const { spawnSync } = require('child_process');
  const sys = process.env.SystemRoot || 'C:\\Windows';
  const ps = path.win32.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const runPs = (script) => spawnSync(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const ROOT = 'Software\\CR-FICTIONAL-policy-probe';
  const deny = "New-Object System.Security.AccessControl.RegistryAccessRule([System.Security.Principal.WindowsIdentity]::GetCurrent().User, 'QueryValues,EnumerateSubKeys', 'Deny')";
  t.after(() => runPs([
    `$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${ROOT}\\Denied\\ClaudeCode', [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, [System.Security.AccessControl.RegistryRights]'ChangePermissions,ReadPermissions')`,
    `if ($null -ne $k) { $a = $k.GetAccessControl(); [void]$a.RemoveAccessRule((${deny})); $k.SetAccessControl($a); $k.Close() }`,
    `Remove-Item -Path 'HKCU:\\${ROOT}' -Recurse -Force -ErrorAction SilentlyContinue`,
  ].join('\n')));
  const made = runPs([
    "$ErrorActionPreference = 'Stop'",
    `New-Item -Path 'HKCU:\\${ROOT}\\Denied\\ClaudeCode' -Force | Out-Null`,
    `New-Item -Path 'HKCU:\\${ROOT}\\Present\\ClaudeCode' -Force | Out-Null`,
    `New-ItemProperty -Path 'HKCU:\\${ROOT}\\Present\\ClaudeCode' -Name 'Settings' -Value '{"FICTIONAL":true}' -PropertyType String -Force | Out-Null`,
    `$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${ROOT}\\Denied\\ClaudeCode', [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, [System.Security.AccessControl.RegistryRights]'ChangePermissions,ReadPermissions')`,
    `$a = $k.GetAccessControl(); $a.AddAccessRule((${deny})); $k.SetAccessControl($a); $k.Close()`,
    "'made'",
  ].join('\n'));
  assert.equal(String(made.stdout).trim(), 'made', String(made.stderr).slice(0, 400));
  const judged = (which) => P.readPolicyRegistry(runPs(P.REG_SCRIPT.split(P.POLICY_SUBKEY).join(`${ROOT}\\${which}\\ClaudeCode`)));
  const denied = judged('Denied');
  assert.ok(denied.some((x) => /HKCU.*access denied/.test(x)), denied.join('; '));
  const present = judged('Present');
  assert.ok(present.some((x) => /HKCU.*present, values 1/.test(x)), present.join('; '));
  const old = spawnSync(path.win32.join(sys, 'System32', 'reg.exe'), ['query', `HKCU\\${ROOT}\\Denied\\ClaudeCode`], { encoding: 'utf8', windowsHide: true });
  assert.equal(old.status, 1, 'reg.exe exits 1 on a key it may not read: the code the old check took for absent');
  // This machine's own policy keys, read for real.
  assert.deepEqual(P.readPolicyRegistry(P.regQuery(process.env)), [], 'no Claude Code policy key on this machine');
});
