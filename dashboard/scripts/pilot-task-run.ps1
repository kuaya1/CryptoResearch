<#
  The pilot-all task's launcher (bounded paper readiness A4, 2026-11-01).

  Task Scheduler runs this, hidden, instead of `conhost --headless`: measured
  under Task Scheduler on 2026-11-01, conhost reported 0 for every runner exit
  (7, 3, 1, 0) and left the runner and its children alive after the time
  limit or a Stop. This launcher:
    - puts itself in a new Job Object with KILL_ON_JOB_CLOSE before anything
      starts, so the runner and every process it starts end with it (its
      normal exit, the 3-hour time limit, or a Stop); if the job cannot be
      made it starts nothing (exit 93 or 94);
    - runs <node> dashboard\scripts\pilot.js <arguments> from the repository
      folder (this file's ..\..) and waits for it;
    - exits with the runner's own exit code (0 done, 3 needs Eric, 1 error),
      so the task's last result is the runner's.
  Its own codes: 90 node could not be started, 91 no exit code, 92 usage,
  93 the job helper did not load, 94 the job could not be made.

  It never releases a claim, repairs a record or retries: a run cut short
  leaves the desk's uncertain claims for Eric to reconcile.

    powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File pilot-task-run.ps1 "<node.exe>" --pilot-all --desk=online --max-agents=1
#>
# No param() block: arguments such as --desk=online are passed on as they are.
$ErrorActionPreference = 'Stop'
if ($args.Count -lt 1) { exit 92 }
$node = [string]$args[0]
$rest = @()
if ($args.Count -gt 1) { $rest = @($args[1..($args.Count - 1)]) }
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$pilot = Join-Path $root 'dashboard\scripts\pilot.js'
try {
  Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class CrPilotJob {
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC Basic; public IO Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref EXT i, uint l);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  // Held for the life of this process: when it closes, the job's processes end.
  public static IntPtr Handle;
  public static int Setup() {
    Handle = CreateJobObject(IntPtr.Zero, null);
    if (Handle == IntPtr.Zero) return Marshal.GetLastWin32Error();
    var e = new EXT(); e.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(Handle, 9, ref e, (uint)Marshal.SizeOf(typeof(EXT)))) return Marshal.GetLastWin32Error();
    if (!AssignProcessToJobObject(Handle, GetCurrentProcess())) return Marshal.GetLastWin32Error();
    return 0;
  }
}
'@
  $jobError = [CrPilotJob]::Setup()
} catch {
  exit 93
}
if ($jobError -ne 0) { exit 94 }
if (-not (Test-Path -LiteralPath $node -PathType Leaf) -or -not (Test-Path -LiteralPath $pilot -PathType Leaf)) { exit 90 }
Set-Location -LiteralPath $root
try {
  & $node $pilot @rest
} catch {
  exit 90
}
if ($null -eq $LASTEXITCODE) { exit 91 }
exit $LASTEXITCODE
