# The engineering worker daemon on this PC (Eric, 2026-10-26,
# audits/2026-10-26-worker-daemon).
#
#   .\dashboard\scripts\start-daemon.ps1              runs it here; Ctrl+C stops it
#   .\dashboard\scripts\start-daemon.ps1 -Background  starts it hidden; its log is daemon.log in its home
#   .\dashboard\scripts\start-daemon.ps1 -AtLogon     registers a Task Scheduler entry that starts it
#                                                     hidden when you sign in to Windows (your choice;
#                                                     Unregister-ScheduledTask CryptoResearch-WorkerDaemon removes it)
#
# It needs node and claude on PATH, and a sign-in from npm run worker:login
# (approved on the desk as Claude, role Worker). It never asks for a key.

param(
  [switch]$Background,
  [switch]$AtLogon,
  [string]$DaemonHome = $(if ($env:CR_DAEMON_HOME) { $env:CR_DAEMON_HOME } else { Join-Path $HOME '.cryptoresearch\engineering-daemon' })
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script = Join-Path $root 'dashboard\scripts\engineering-daemon.js'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Error 'node is not on PATH. Install Node 24 (see package.json), then run this again.'; exit 1 }
$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) { Write-Error 'claude is not on PATH. Install Claude Code and sign in to it once, then run this again.'; exit 1 }
if (-not (Test-Path (Join-Path $DaemonHome 'token.json'))) { Write-Error "The daemon is not signed in to the desk. Run npm run worker:login first (approve it as Claude, role Worker)."; exit 1 }

if ($AtLogon) {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Background -DaemonHome `"$DaemonHome`"" -WorkingDirectory $root
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName 'CryptoResearch-WorkerDaemon' -Action $action -Trigger $trigger -Settings $settings -Description 'CryptoResearch engineering worker daemon (dashboard/scripts/start-daemon.ps1)' -Force | Out-Null
  Write-Output "Registered CryptoResearch-WorkerDaemon: it starts hidden when $env:USERNAME signs in. Its log is $DaemonHome\daemon.log."
  exit 0
}

if ($Background) {
  New-Item -ItemType Directory -Force $DaemonHome | Out-Null
  $p = Start-Process -FilePath $node.Source -ArgumentList @("`"$script`"", 'run', '--home', "`"$DaemonHome`"") -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $DaemonHome 'console.log') -RedirectStandardError (Join-Path $DaemonHome 'console-error.log') -PassThru
  Write-Output "Worker daemon started hidden (pid $($p.Id)). npm run worker:status shows what it does; Stop-Process -Id $($p.Id) stops it."
  exit 0
}

& $node.Source $script run --home $DaemonHome
exit $LASTEXITCODE
