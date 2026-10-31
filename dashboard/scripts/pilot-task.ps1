<#
  The pilot-all task in Windows Task Scheduler (readiness PR, 2026-10-31).

  Registers "CryptoResearch pilot-all" for the signed-in Windows user (the one
  whose Claude subscription `claude` uses), DISABLED, so nothing runs until
  -Enable. Every 30 minutes while that user is signed in it starts
      <node> dashboard\scripts\pilot.js --pilot-all --desk=online --max-agents=<N>
  in the repository folder, with:
    - the Node binary resolved and checked now (the repo's pinned major), not
      a shim or npm/cmd;
    - no console window (conhost --headless), the task itself Hidden;
    - MultipleInstances IgnoreNew: a run still going means the next is skipped;
    - a 3-hour time limit (ExecutionTimeLimit): two 60-minute agent sessions
      and the desk's prepare/complete waits fit, and it is the runner's own
      stale-lock age. Stopping a run never releases an uncertain claim: the
      desk keeps it dispatched until Eric reconciles it;
    - a missed start (asleep, signed out) runs once when the PC is available
      (StartWhenAvailable); the PC is never woken; on battery it still runs.
  The runner's own result is its log line in
  %USERPROFILE%\.cryptoresearch\pilot-all.jsonl (exit 0 done, 3 needs Eric,
  1 error); Task Scheduler's last result is conhost's, not the runner's.

  It never replaces a task it did not make: a task of that name whose
  description is not this script's is refused, and -Register refuses while
  one exists (-Remove first, which removes only this script's).

    powershell -NoProfile -ExecutionPolicy Bypass -File dashboard\scripts\pilot-task.ps1 -Register [-MaxAgents 1]
    ... -Status | -Enable | -Disable | -Remove
#>
[CmdletBinding()]
param(
  [switch]$Register,
  [switch]$Enable,
  [switch]$Disable,
  [switch]$Status,
  [switch]$Remove,
  [ValidateRange(0, 10)][int]$MaxAgents = 1
)
$ErrorActionPreference = 'Stop'
$TaskName = 'CryptoResearch pilot-all'
$Mark = 'CryptoResearch pilot-all, registered by dashboard\scripts\pilot-task.ps1'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Script = Join-Path $Root 'dashboard\scripts\pilot.js'
$Conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
$Log = Join-Path $env:USERPROFILE '.cryptoresearch\pilot-all.jsonl'

function Get-Task { Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue }
function Assert-Ours($t) {
  if ($t -and $t.Description -ne $Mark) { throw "A task named '$TaskName' exists that this script did not register (its description differs). It is left as it is; nothing was changed." }
}
function Resolve-Node {
  Push-Location $Root
  try { $exe = (& node -p 'process.execPath' 2>$null); $ver = (& node --version 2>$null) } finally { Pop-Location }
  if (-not $exe -or -not (Test-Path -LiteralPath $exe)) { throw 'node was not found from the repository folder.' }
  $pin = (Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json).engines.node
  $major = ($pin -replace '[^0-9].*$', '')
  if ($ver -notmatch "^v$major\.") { throw "node $ver does not match the repository's engines.node ($pin)." }
  if ($exe -match '\\Volta\\node\.exe$') { throw "node resolved to the Volta shim ($exe), not a binary." }
  [pscustomobject]@{ Path = $exe; Version = $ver }
}
function Show($t) {
  if (-not $t) { return [pscustomobject]@{ task = $TaskName; registered = $false } }
  $info = Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath '\'
  $a = $t.Actions[0]
  $tr = $t.Triggers[0]
  $last = $null
  if (Test-Path -LiteralPath $Log) {
    $line = Get-Content -LiteralPath $Log -Tail 1
    try { $j = $line | ConvertFrom-Json; $last = [pscustomobject]@{ started_at = $j.started_at; exit = $j.exit; dispatches = @($j.dispatches).Count; needs_eric = @($j.needs_eric).Count; error = $j.error } } catch { $last = 'unreadable' }
  }
  [pscustomobject]@{
    task = $TaskName
    registered = $true
    ours = ($t.Description -eq $Mark)
    state = [string]$t.State
    user = $t.Principal.UserId
    logon = [string]$t.Principal.LogonType
    run_level = [string]$t.Principal.RunLevel
    execute = $a.Execute
    arguments = $a.Arguments
    working_directory = $a.WorkingDirectory
    every = $tr.Repetition.Interval
    for = $(if ($tr.Repetition.Duration) { $tr.Repetition.Duration } else { 'indefinitely' })
    multiple_instances = [string]$t.Settings.MultipleInstances
    time_limit = $t.Settings.ExecutionTimeLimit
    hidden = $t.Settings.Hidden
    start_when_available = $t.Settings.StartWhenAvailable
    wake_to_run = $t.Settings.WakeToRun
    next_run = $info.NextRunTime
    last_run = $info.LastRunTime
    last_task_result = $info.LastTaskResult
    last_runner_log = $last
  }
}

$t = Get-Task
if ($Register) {
  if ($t) { Assert-Ours $t; throw "'$TaskName' is already registered by this script (state $($t.State)). Use -Status, -Enable or -Disable; -Remove first to register it again." }
  $node = Resolve-Node
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $action = New-ScheduledTaskAction -Execute $Conhost -Argument ('--headless "{0}" "{1}" --pilot-all --desk=online --max-agents={2}' -f $node.Path, $Script, $MaxAgents) -WorkingDirectory $Root
  $trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(5)) -RepetitionInterval (New-TimeSpan -Minutes 30)
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 3) -Hidden -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Disable
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -Description $Mark -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
  Write-Output "Registered '$TaskName' DISABLED for $user with node $($node.Version) ($($node.Path)). Nothing runs until -Enable."
  Show (Get-Task)
} elseif ($Enable -or $Disable) {
  if (-not $t) { throw "'$TaskName' is not registered (-Register first)." }
  Assert-Ours $t
  if ($Enable) { Enable-ScheduledTask -TaskName $TaskName -TaskPath '\' | Out-Null } else { Disable-ScheduledTask -TaskName $TaskName -TaskPath '\' | Out-Null }
  Show (Get-Task)
} elseif ($Remove) {
  if (-not $t) { Write-Output "'$TaskName' is not registered; nothing to remove."; return }
  Assert-Ours $t
  Unregister-ScheduledTask -TaskName $TaskName -TaskPath '\' -Confirm:$false
  Write-Output "Removed '$TaskName'."
} else {
  Show $t
}
