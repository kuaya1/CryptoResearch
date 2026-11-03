<#
  The pilot-all task in Windows Task Scheduler (readiness PR, 2026-10-31;
  launcher and -Status, bounded paper readiness A4, 2026-11-01; unattended,
  pinned model, cap and clean checkout, autonomy blueprint 2026-11-03 section 4 PR 1).

  Registers "CryptoResearch pilot-all" for the signed-in Windows user (the one
  whose Claude subscription `claude` uses), DISABLED, so nothing runs until
  -Enable. Every 30 minutes while that user is signed in it starts
      <node> dashboard\scripts\pilot.js --unattended --pilot-all --desk=online --max-agents=1 --model=<id>
  in the repository folder, with:
    - --unattended, so the poll is the production POST that the desk records
      as its sighting, and the runner's revision guard compares this
      checkout's HEAD with the desk's /healthz revision before anything is
      claimed (pilot.js: a dirty checkout or a different commit refuses);
    - -Model <id> required and named in the arguments (pilot.js refuses an
      unattended run without one); -Status says only whether one is named;
    - -MaxAgents at most 1 (Q2, ratified 2026-11-03: the desk caps STALE at
      one agent, so a larger count would only run sessions the desk does not
      wait for);
    - -Register refuses unless `git -C <repository> status --porcelain` prints
      nothing. Register it from the dedicated runner worktree, never the
      interactive checkout: the task runs whatever that folder holds;
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
  (dashboard\scripts\pilot-task-status.js). Its config adds unattended,
  model_named (true or false, never the value), checkout_head and
  checkout_clean. It changes nothing and prints no action arguments or log
  text.

  It never replaces a task it did not make: a task of that name whose
  description is not this script's is refused, and -Register refuses while
  one exists (-Remove first, which removes only this script's). A task
  registered before 2026-11-01 still runs conhost: -Remove, then -Register.

    powershell -NoProfile -ExecutionPolicy Bypass -File dashboard\scripts\pilot-task.ps1 -Register -Model <id> [-MaxAgents 1]
    ... -Status | -Enable | -Disable | -Remove
#>
[CmdletBinding()]
param(
  [switch]$Register,
  [switch]$Enable,
  [switch]$Disable,
  [switch]$Status,
  [switch]$Remove,
  [ValidateRange(0, 10)][int]$MaxAgents = 1,
  [string]$Model
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
# This checkout's HEAD and whether it is clean, from git; $null when git is
# missing or fails.
function Get-Checkout {
  try {
    $head = (& git -C $Root rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -ne 0 -or $head -notmatch '^[0-9a-f]{40}$') { return $null }
    $porcelain = (& git -C $Root status --porcelain 2>$null | Out-String)
    if ($LASTEXITCODE -ne 0) { return $null }
    [pscustomobject]@{ Head = [string]$head; Clean = ($porcelain.Trim() -eq '') }
  } catch { $null }
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
  $unattended = ($a.Arguments -match '(^|\s)--unattended(\s|$)')
  $modelNamed = ($a.Arguments -match '(^|\s)--model=\S')
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
    unattended = [bool]$unattended
    model_named = [bool]$modelNamed
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
    $co = Get-Checkout
    $config = [ordered]@{
      user = $t.Principal.UserId
      logon = [string]$t.Principal.LogonType
      run_level = [string]$t.Principal.RunLevel
      launcher = $facts.launcher
      max_agents = $facts.max_agents
      unattended = $facts.unattended
      model_named = $facts.model_named
      checkout_head = $(if ($co) { $co.Head } else { $null })
      checkout_clean = $(if ($co) { $co.Clean } else { $null })
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
  if (-not $Model -or $Model -cnotmatch '^[A-Za-z0-9._:\[\]-]{1,80}$') { throw '-Register needs -Model <id> (letters, digits and . _ : [ ] -, at most 80): the unattended runner refuses to start without a pinned model. Nothing was registered.' }
  if ($MaxAgents -gt 1) { throw "-MaxAgents $MaxAgents is above the desk's cap of 1 (Q2, ratified 2026-11-03). Nothing was registered." }
  $co = Get-Checkout
  if (-not $co) { throw "git could not read the checkout at $Root (git missing, or not a repository). Nothing was registered." }
  if (-not $co.Clean) { throw "The checkout at $Root (HEAD $($co.Head)) has uncommitted or untracked changes, and the task would run them. Register from the clean runner worktree. Nothing was registered." }
  $node = Resolve-Node
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $action = New-ScheduledTaskAction -Execute $PowerShellExe -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" "{1}" --unattended --pilot-all --desk=online --max-agents={2} --model={3}' -f $Wrapper, $node.Path, $MaxAgents, $Model) -WorkingDirectory $Root
  $trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(5)) -RepetitionInterval (New-TimeSpan -Minutes 30)
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 3) -Hidden -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Disable
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -Description $Mark -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
  Write-Output "Registered '$TaskName' DISABLED for $user with node $($node.Version) ($($node.Path)), from $Root at $($co.Head). Nothing runs until -Enable."
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
