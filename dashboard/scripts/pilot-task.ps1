<#
  The pilot-all task in Windows Task Scheduler (readiness PR, 2026-10-31;
  launcher and -Status, bounded paper readiness A4, 2026-11-01).

  Registers "CryptoResearch pilot-all" for the signed-in Windows user (the one
  whose Claude subscription `claude` uses), DISABLED, so nothing runs until
  -Enable. Every 30 minutes while that user is signed in it starts
      <node> dashboard\scripts\pilot.js --pilot-all --desk=online --max-agents=<N>
  in the repository folder, with:
    - the Node binary resolved and checked now (the repo's pinned major), not
      a shim or npm/cmd;
    - the launcher dashboard\scripts\pilot-task-run.ps1 in Windows PowerShell
      (-WindowStyle Hidden; the task itself Hidden in Task Scheduler's list).
      It waits for the runner, returns the runner's own exit code as the
      task's last result (0 done, 3 needs Eric, 1 error; 90-94 its own start
      failures), and holds the runner and every process it starts in a job
      that ends with it. Measured under Task Scheduler on 2026-11-01: the
      earlier `conhost --headless` reported 0 for every exit and left the
      runner and its children alive after the time limit or a Stop. It is not
      windowless: with Windows Terminal as the default terminal ("Let Windows
      decide"), each start opened a Terminal window that took focus for about
      half a second and then stayed minimized in the taskbar until the run
      ended. Closing that window during a run was not measured
      (docs/engineering/BOUNDED_PAPER_READINESS.md);
    - MultipleInstances IgnoreNew: a run still going means the next is skipped;
    - a 3-hour time limit (ExecutionTimeLimit): two 60-minute agent sessions
      and the desk's prepare/complete waits fit, and it is the runner's own
      stale-lock age. Ending a run (the limit or a Stop) ends its processes but
      never releases an uncertain claim: the desk keeps it dispatched until
      Eric reconciles it;
    - a missed start (asleep, signed out) runs once when the PC is available
      (StartWhenAvailable); the PC is never woken; on battery it still runs.
  The runner's own record is its log line in
  %USERPROFILE%\.cryptoresearch\pilot-all.jsonl.

  -Status reads the task, that log and the runner's lock (as pilot.js finds
  them) and says what the last scheduled start did: never_run, running,
  completed, failed, interrupted or unknown, with the reason
  (dashboard\scripts\pilot-task-status.js). It changes nothing and prints no
  action arguments or log text.

  It never replaces a task it did not make: a task of that name whose
  description is not this script's is refused, and -Register refuses while
  one exists (-Remove first, which removes only this script's). A task
  registered before 2026-11-01 still runs conhost: -Remove, then -Register.

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
$Wrapper = Join-Path $Root 'dashboard\scripts\pilot-task-run.ps1'
$StatusScript = Join-Path $Root 'dashboard\scripts\pilot-task-status.js'
$PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$Conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'

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
function Iso($d) { if ($d -and $d.Year -ge 2000) { $d.ToUniversalTime().ToString('o') } else { $null } }

# Task Scheduler's facts about this task only (cr-pilot-task-facts@1). The
# action is named by its launcher, never by its arguments.
function Get-Facts($t) {
  if (-not $t) { return [ordered]@{ format = 'cr-pilot-task-facts@1'; registered = $false } }
  $info = Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath '\'
  $a = $t.Actions[0]
  $launcher = 'other'
  if ($a.Execute -ieq $Conhost) { $launcher = 'conhost' }
  elseif ($a.Execute -ieq $PowerShellExe -and $a.Arguments -like ('* -File "' + $Wrapper + '" *')) { $launcher = 'job_wrapper' }
  $max = $null
  if ($a.Arguments -match '--max-agents=(\d+)') { $max = [int]$Matches[1] }
  $running = @()
  $runningError = $null
  try {
    $svc = New-Object -ComObject Schedule.Service
    $svc.Connect()
    foreach ($i in @($svc.GetFolder('\').GetTask($TaskName).GetInstances(0))) {
      $engine = [int]$i.EnginePID
      $p = Get-CimInstance Win32_Process -Filter "ProcessId=$engine" -ErrorAction SilentlyContinue
      $kids = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$engine" -ErrorAction SilentlyContinue | ForEach-Object {
        [ordered]@{ pid = [int]$_.ProcessId; name = [string]$_.Name; started_at = (Iso $_.CreationDate) }
      })
      $running += [ordered]@{ engine_pid = $engine; engine_started_at = $(if ($p) { Iso $p.CreationDate } else { $null }); children = $kids }
    }
  } catch { $runningError = ('0x{0:X8}' -f $_.Exception.HResult) }
  [ordered]@{
    format = 'cr-pilot-task-facts@1'
    registered = $true
    ours = ($t.Description -eq $Mark)
    state = [string]$t.State
    enabled = [bool]$t.Settings.Enabled
    last_run_time = (Iso $info.LastRunTime)
    last_task_result = [int64]$info.LastTaskResult
    next_run_time = (Iso $info.NextRunTime)
    time_limit = [string]$t.Settings.ExecutionTimeLimit
    launcher = $launcher
    max_agents = $max
    running = $running
    running_error = $runningError
  }
}

function Show($t) {
  $facts = Get-Facts $t
  $status = $null
  try {
    $node = Resolve-Node
    $OutputEncoding = New-Object System.Text.UTF8Encoding $false
    $text = ($facts | ConvertTo-Json -Depth 6 -Compress) | & $node.Path $StatusScript | Out-String
    $status = $text | ConvertFrom-Json
  } catch {
    $status = [ordered]@{ format = 'cr-pilot-task-status@1'; state = 'unknown'; reason = "The status could not be read: $($_.Exception.Message)" }
  }
  $config = $null
  if ($t) {
    $tr = $t.Triggers[0]
    $config = [ordered]@{
      user = $t.Principal.UserId
      logon = [string]$t.Principal.LogonType
      run_level = [string]$t.Principal.RunLevel
      launcher = $facts.launcher
      max_agents = $facts.max_agents
      working_directory_is_repository = ($t.Actions[0].WorkingDirectory -ieq $Root)
      every = $tr.Repetition.Interval
      multiple_instances = [string]$t.Settings.MultipleInstances
      time_limit = $t.Settings.ExecutionTimeLimit
      hidden = $t.Settings.Hidden
      start_when_available = $t.Settings.StartWhenAvailable
      wake_to_run = $t.Settings.WakeToRun
    }
  }
  [ordered]@{ task = $TaskName; registered = [bool]$t; ours = $(if ($t) { $t.Description -eq $Mark } else { $null }); config = $config; status = $status } | ConvertTo-Json -Depth 8
}

$t = Get-Task
if ($Register) {
  if ($t) { Assert-Ours $t; throw "'$TaskName' is already registered by this script (state $($t.State)). Use -Status, -Enable or -Disable; -Remove first to register it again." }
  $node = Resolve-Node
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $action = New-ScheduledTaskAction -Execute $PowerShellExe -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" "{1}" --pilot-all --desk=online --max-agents={2}' -f $Wrapper, $node.Path, $MaxAgents) -WorkingDirectory $Root
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
