# Rollback

## The rollback copy

`C:\Users\Kuaya\Documents\CryptoResearch-recovery\20261002T164934Z-pre-integrity-repair-code\`

- **Contents.** The 70 code files exactly as they run now. The aggregate is `9ff79de7f31aaf92c92822c1e092782c7a49493b84292ad38840516a86087fd0`, the audited target.
- **Verified.** It was copied from the real folder after confirming that fingerprint, then re-read file by file (`manifest.json → verification.verified: true`).
- **Also in the folder:**
  - `RESTORE.md`: the exact steps.
  - `verify-fingerprint.cjs`: confirms a folder's code matches.
  - `manifest.json`: per-file hashes, plus the files the repair adds and changes.
- **No records.** A code rollback never restores records. **Never copy a backup over the real data to roll back code.**

## Stop the dashboard first, and confirm it stopped

The same procedure applies before deploying the repair.

1. **Close the dashboard window.** It is the console window titled `CryptoResearch dashboard - close this window to stop it`, started by `Open Dashboard.cmd`. You can also press Ctrl+C in it.
   - **Closing the browser tab does not stop the server.**
2. **Confirm.** No output means it stopped:
   ```powershell
   $ws = "$env:USERPROFILE\Documents\CryptoResearch"
   $s = Get-Content "$ws\.cr\server.json" -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
   if ($s) { Get-Process -Id $s.pid -ErrorAction SilentlyContinue; Get-NetTCPConnection -LocalPort $s.port -State Listen -ErrorAction SilentlyContinue }
   Get-NetTCPConnection -LocalPort 4729 -State Listen -ErrorAction SilentlyContinue
   ```
   - `.cr\server.json` alone proves nothing. On 2026-10-02 it named pid 19996, which was no longer running, and nothing listened on 4729.
3. **Check the hourly task.**
   ```powershell
   Get-ScheduledTask -TaskPath '\CryptoResearch\' -TaskName Hourly | Select-Object TaskName, State
   ```
   - Its state must be `Ready`, not `Running`.
   - To keep it from starting during the swap, run `Disable-ScheduledTask -TaskPath '\CryptoResearch\' -TaskName Hourly`, and `Enable-ScheduledTask` afterwards. Otherwise, swap right after a run.
4. **Make sure no other Node process is using this folder**, and that the workspace lock is free:
   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'CryptoResearch' } | Select-Object ProcessId, CommandLine
   Test-Path "$env:USERPROFILE\Documents\CryptoResearch\.cr\lock.json"
   ```

## Replace the code and verify it

```powershell
$rec = "$env:USERPROFILE\Documents\CryptoResearch-recovery\20261002T164934Z-pre-integrity-repair-code"
$ws  = "$env:USERPROFILE\Documents\CryptoResearch"
robocopy "$rec\dashboard" "$ws\dashboard" /E /NJH /NJS /NDL /NFL
Copy-Item "$rec\package.json" "$ws\package.json" -Force
'dashboard\tests\children\child-held-commit.js','dashboard\tests\children\child-research-runner.js','dashboard\tests\integrity-reads.test.js','dashboard\tests\integrity-restore.test.js','dashboard\tests\live-updates.test.js','dashboard\tests\research-attempts.test.js','dashboard\tests\research-spend.test.js' | ForEach-Object { Remove-Item (Join-Path $ws $_) -ErrorAction SilentlyContinue }
node "$rec\verify-fingerprint.cjs" "$ws"
```

- Use `/E`, not `/MIR`. `/MIR` would delete `dashboard\demo-workspace` and `dashboard\index`.
- The last command must print `"matches": true`.
- Then run `node dashboard\cli.js doctor` and start `Open Dashboard.cmd`.

**Drill (done 2026-10-02 on a scratch copy of the repaired code, never the real folder):** these exact commands produced `"matches": true` (aggregate `9ff79de7…`), and `dashboard\demo-workspace` and `dashboard\index` were kept. The original code's own suite passes: 109/109 (`evidence/baseline-full-suite.txt`).

## Is rolling back safe for records the repaired code wrote?

Tested in two new, empty test workspaces with a counting stub provider (`fixtures/rollback-crossversion.cjs`, `evidence/rollback-crossversion.json`).

### A. Records from the repaired code, then the original code, then the repaired code again

- **Starting states:**
  - 3 completed, imported
  - 1 uncertain
  - 1 reconciled
  - 1 errored twice
  - 1 reserved and left in flight by a killed runner
- **Original code:**
  - **0 requests** sent.
  - Builds its index.
  - Every state unchanged.
  - Saved answers byte-identical.
  - Spend read from the ledger: **0.7801**, the same as the repaired code's 0.7801.
- **Repaired code again:**
  - 1 request, only for the reserved attempt that was provably never sent (released as not_sent, then completed).
  - Everything else unchanged.

### B. Records from the original code (including its crash states), then the repaired code

- **Starting states:**
  - 2 completed
  - 1 failed after HTTP 500s
  - 1 original runner killed after sending, before saving
  - 1 original runner killed after saving its answer, before recording it
  - 1 queued
- **Repaired code:**
  - **1 request**, for the queued job only.
  - The killed-after-sending job is held as **uncertain**. The original code would have resent it.
  - The saved-but-unrecorded answer is **imported without a request**.
  - Spend agrees: 0.3426 = 0.3426.
  - Saved answers are byte-identical.
  - The index builds.

### On copies of your real records

In separate folders with new workspace IDs (`fixtures/realcopy-check.cjs`, `evidence/realcopy-check.json`):

- Repaired and original code give identical project index entries, reports, runs, spend and export counts.
- The original code reading after the repaired code gives the same answers.
- No record file changed in any run.
- A package round trip gave `restored_and_verified`.
- The real folder's file hashes were identical before and after.
- The copies were deleted afterwards.

### After a rollback, the original code

- Shows the new job states as plain words ("dispatching", "uncertain").
- Has no Reconcile.
- Treats Retry on an uncertain job as an explicit new paid attempt.

Reconcile uncertain attempts before rolling back, or after rolling forward.
