'use strict';
// OS scheduler integration for unattended updates while the dashboard is closed.
// Windows: one Task Scheduler task, \CryptoResearch\Hourly, registered for the
// current user (no admin rights). It runs dashboard/scripts/scheduled-run.cmd
// through conhost --headless so no console window appears. It only runs while
// the PC is on and you are logged in; missed runs start when the PC wakes.
// macOS / Linux: instructions are printed instead (cron or launchd).

const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TASK_PATH = '\\CryptoResearch\\';
const TASK_NAME = 'Hourly';

function ps(script, timeout = 60000) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8', timeout, windowsHide: true });
  return { ok: r.status === 0, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), error: r.error ? r.error.message : null };
}

function psq(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function runnerPath(ws) {
  return path.join(ws.root, 'dashboard', 'scripts', 'scheduled-run.cmd');
}

function install(ws, { minutes = 60 } = {}) {
  if (process.platform !== 'win32') return { status: 'manual', instructions: manualInstructions(ws) };
  const runner = runnerPath(ws);
  const script = `
$ErrorActionPreference = 'Stop'
$conhost = Join-Path $env:WINDIR 'System32\\conhost.exe'
$arg = '--headless cmd.exe /d /c "' + ${psq(runner)} + '"'
$action = New-ScheduledTaskAction -Execute $conhost -Argument $arg -WorkingDirectory ${psq(ws.root)}
$trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(2)) -RepetitionInterval (New-TimeSpan -Minutes ${Number(minutes)})
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$desc = 'CryptoResearch: hourly market data, inbox import, queued requests and research jobs, daily snapshot, review check and backup. Workspace: ' + ${psq(ws.root)} + ' (workspace id ' + ${psq(ws.meta.workspace_id)} + ')'
Register-ScheduledTask -TaskPath ${psq(TASK_PATH)} -TaskName ${psq(TASK_NAME)} -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $desc -Force | Out-Null
$t = Get-ScheduledTask -TaskPath ${psq(TASK_PATH)} -TaskName ${psq(TASK_NAME)}
[pscustomobject]@{ State = [string]$t.State; Interval = [string]$t.Triggers[0].Repetition.Interval; Duration = [string]$t.Triggers[0].Repetition.Duration; Execute = $t.Actions[0].Execute; Arguments = $t.Actions[0].Arguments } | ConvertTo-Json -Compress
`;
  const r = ps(script);
  if (!r.ok) return { status: 'failed', error: r.stderr || r.error || r.stdout };
  let details = null;
  try {
    details = JSON.parse(r.stdout);
  } catch (_) {
    details = r.stdout;
  }
  return { status: 'installed', task: `${TASK_PATH}${TASK_NAME}`, every_minutes: minutes, details, note: 'Runs only while the PC is on and you are logged in. Missed runs start when the PC becomes available.' };
}

function normPath(p) {
  return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

// Status of the installed task, and whether it actually runs THIS workspace
// (audit F19): a copied, moved or demo workspace must not inherit a green
// status from a task that targets another folder.
function status(ws = null) {
  if (process.platform !== 'win32') return { status: 'unsupported_os', platform: process.platform, ownership: 'not_managed_here' };
  const r = ps(`
$t = Get-ScheduledTask -TaskPath ${psq(TASK_PATH)} -TaskName ${psq(TASK_NAME)} -ErrorAction SilentlyContinue
if (-not $t) { '{"installed":false}'; exit 0 }
$i = $t | Get-ScheduledTaskInfo
[pscustomobject]@{
  installed = $true
  state = [string]$t.State
  last_run_time = if ($i.LastRunTime -and $i.LastRunTime.Year -gt 2000) { $i.LastRunTime.ToUniversalTime().ToString('o') } else { $null }
  last_task_result = $i.LastTaskResult
  next_run_time = if ($i.NextRunTime) { $i.NextRunTime.ToUniversalTime().ToString('o') } else { $null }
  interval = [string]$t.Triggers[0].Repetition.Interval
  execute = $t.Actions[0].Execute
  arguments = $t.Actions[0].Arguments
  working_directory = $t.Actions[0].WorkingDirectory
  description = $t.Description
} | ConvertTo-Json -Compress
`, 30000);
  if (!r.ok) return { status: 'error', error: r.stderr || r.error, ownership: 'unknown' };
  let s;
  try {
    s = JSON.parse(r.stdout);
  } catch (_) {
    return { status: 'error', error: r.stdout, ownership: 'unknown' };
  }
  if (s.installed && s.last_task_result !== undefined) s.last_task_result_meaning = s.last_task_result === 0 ? 'success' : s.last_task_result === 267011 ? 'has not run yet' : s.last_task_result === 267009 ? 'running now' : `exit code ${s.last_task_result}`;
  if (s.installed && ws) {
    const root = normPath(ws.root);
    const runner = normPath(runnerPath(ws));
    const args = normPath(s.arguments);
    const wd = normPath(s.working_directory);
    const targetsThis = args.includes(runner) || (wd === root && args.includes('scheduled-run.cmd'));
    const descId = /workspace id ([a-z0-9_]+)/i.exec(String(s.description || ''));
    s.ownership = targetsThis ? (descId && descId[1] !== ws.meta.workspace_id ? 'this_folder_other_workspace_id' : 'this_workspace') : 'other_workspace';
    s.targets = s.working_directory || s.arguments;
    if (s.ownership !== 'this_workspace') s.note = `The installed task runs ${s.targets}, not this folder. It does not update this workspace.`;
  } else if (s.installed) {
    s.ownership = 'unknown';
  } else {
    s.ownership = 'none';
  }
  return s;
}

function runNow() {
  if (process.platform !== 'win32') return { status: 'unsupported_os' };
  const r = ps(`Start-ScheduledTask -TaskPath ${psq(TASK_PATH)} -TaskName ${psq(TASK_NAME)}; 'started'`);
  return r.ok ? { status: 'started' } : { status: 'failed', error: r.stderr || r.error };
}

function remove() {
  if (process.platform !== 'win32') return { status: 'manual', instructions: 'Remove the cron or launchd entry you created.' };
  const r = ps(`
$t = Get-ScheduledTask -TaskPath ${psq(TASK_PATH)} -TaskName ${psq(TASK_NAME)} -ErrorAction SilentlyContinue
if ($t) { Unregister-ScheduledTask -TaskPath ${psq(TASK_PATH)} -TaskName ${psq(TASK_NAME)} -Confirm:$false; 'removed' } else { 'absent' }
`);
  return r.ok ? { status: r.stdout } : { status: 'failed', error: r.stderr || r.error };
}

function manualInstructions(ws) {
  const node = process.execPath;
  const cli = path.join(ws.root, 'dashboard', 'cli.js');
  if (process.platform === 'darwin') {
    return `macOS: create ~/Library/LaunchAgents/com.cryptoresearch.hourly.plist running "${node}" "${cli}" job run --all-due --trigger scheduler every 3600 seconds (StartInterval), then: launchctl load ~/Library/LaunchAgents/com.cryptoresearch.hourly.plist`;
  }
  return `Linux: add to crontab -e:\n5 * * * * "${node}" "${cli}" job run --all-due --trigger scheduler >> "${path.join(ws.root, 'logs', 'scheduler-last-run.log')}" 2>&1`;
}

module.exports = { install, status, runNow, remove, manualInstructions, TASK_PATH, TASK_NAME, platform: os.platform() };
