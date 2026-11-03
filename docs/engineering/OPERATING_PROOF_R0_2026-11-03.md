# R0: PC baseline and dedicated runner (2026-11-03)

Scope: Stage A of Eric's operating-proof request. This records an operational
change on his PC; this PR contains the receipt only. B0 and later gates remain
unstarted. Eric reviews and merges; the agent never merges.

- **Box / milestone:** Box 3's supervised PC runner is isolated at
  `C:\Users\Kuaya\Documents\CryptoResearch-runner`, detached and clean at
  `5a8e75bd4ef09ab87c170f6fa0816b60c1a38737` (PR #166's merge).
- **Failure seam sealed:** the two Windows tasks now select merged runner code
  rather than the dirty development checkout. Hourly keeps the existing records
  through a wrapper-scoped `CR_WORKSPACE`.
- **Negative control / positive readback:** the old registration fails the R0
  assertions; its replacement passes. The merged revision guard refuses the
  actual dirty checkout at `aa5ad1d`; the dedicated runner passes against the
  real desk's `/healthz`. Neither guard check polls, claims or dispatches work.
- **Status check:** run the `pilot-task.ps1 -Status` command below. Both scheduled
  tasks remain **Disabled**, with zero running instances, for Eric's gate review.

## Observed configuration

The deployed `/healthz` revision equals the full 40-character runner SHA above
(HTTP 200; observed 2026-11-03 at 17:20Z and checked again at completion).
The interactive `Documents\CryptoResearch` checkout and its existing edits stay
in place. The dedicated runner is locked against accidental worktree pruning.

`CryptoResearch pilot-all` uses the repository's Job Object launcher, the resolved
Node **24.21.0** binary, `--unattended --pilot-all --desk=online --max-agents=1
--model=claude-opus-5-5`, and the dedicated runner as its working directory.
`-Status` reports `job_wrapper`, `unattended: true`, `model_named: true`,
`checkout_clean: true`, the full matching `checkout_head`, and
`working_directory_is_repository: true`. Its execution state is honestly
`never_run`, task state `Disabled`, and last result `267011` (has not run).
The full Opus ID is the pin selected for this registration; R0 makes no provider
call to validate model access. The half-hour schedule, single-instance policy,
three-hour limit, interactive logon and no-wake behavior are retained.

`\CryptoResearch\Hourly` points at
`C:\Users\Kuaya\.cryptoresearch\hourly-main.cmd`, with the dedicated runner
as its working directory. The wrapper sets `CR_WORKSPACE` to
`C:\Users\Kuaya\Documents\CryptoResearch` within `setlocal`, calls the runner's
real `scheduled-run.cmd`, and propagates its exit code. Existing Hourly triggers
and principal are unchanged. No user- or machine-level `CR_WORKSPACE` is set.

The real wrapper and scheduled script were exercised with a harmless compiled
`node.exe` stand-in first on a process-scoped PATH. It observed the exact
`dashboard\cli.js job run --all-due --trigger scheduler --actor scheduler`
arguments, runner working directory and original records root. Its deliberate
exit **73** propagated through both batch files. No scheduled job or offsite
upload ran. The stand-in and its source live only in the external evidence
folder; the scheduled task's environment was never changed.

Doctor, run from runner code with process-scoped `CR_WORKSPACE`, reports the
original real workspace and a verified write/readback. Its overall status is
`warn`: the existing scheduler ownership heuristic compares code and records
directories and does not follow wrappers (`core/schedule.js`, `status`). The
actual wrapper routing above passes. This diagnostic limitation is recorded;
the doctor result is not represented as fully green.

## Validation and evidence

Full-suite result: **exit 0; 1,745 tests, 1,743 passed, 0 failed, 0 cancelled,
2 skipped** (`node dashboard/cli.js test`, Node 24.21.0, dedicated runner at the
baseline SHA; 17:22:08Z–17:25:03Z, 175.1 seconds). The two skips are the existing
opt-in installed-Claude-CLI and Windows-registry integration probes
(`CR_TEST_REAL_CLAUDE` and `CR_TEST_REAL_REGISTRY`); R0 does not claim these ran.
The nine protected files, read from
`dashboard/tests/trader-boundary.test.js`'s canonical list, each have identical
SHA-256 hashes to that SHA's Git blobs. The evidence branch changes this receipt
only; no protected file or application code changes.

Raw, secret-free evidence is in
`C:\Users\Kuaya\Documents\CryptoResearch-evidence\operating-proof-2026-11-03\R0`:
before/after task XML and status JSON; `tasks-final.json`; `healthz.txt`;
`doctor-main-workspace.json`; `hourly-route-probe.txt`; `verification.json`
(including all nine SHA-256 comparisons); `full-suite.log` and its timed result.
The bounded probe source is retained beside its readbacks. `manifest.json` binds
21 evidence files; its SHA-256 is
`4785a59225eb2307af4d579117b3025b8a2c4f888d99837174ce6c1dbb68dfd7`.

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File 'C:\Users\Kuaya\Documents\CryptoResearch-runner\dashboard\scripts\pilot-task.ps1' -Status
Get-ScheduledTask -TaskName 'CryptoResearch pilot-all' | Select-Object TaskName, State
Get-ScheduledTask -TaskPath '\CryptoResearch\' -TaskName Hourly | Select-Object TaskName, State
git -C 'C:\Users\Kuaya\Documents\CryptoResearch-runner' status --porcelain
```

Stop at R0 for Eric's review. Hourly is intentionally left temporarily disabled
under this request's quiet-PC instruction; no new offsite run is claimed. Its
next real run and offsite readback remain to be observed when it is enabled.
Pilot-all stays disabled until the later supervised window. No admission,
mandate, pause state, paper order or hosted service was changed. After any merge
and deploy, refresh the detached runner to the then-current `origin/main` and
repeat the revision/status checks before B0; the guard refuses a stale runner.
