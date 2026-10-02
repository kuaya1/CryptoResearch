# Stop, deploy and roll back

Nothing here was run against the real workspace. These are the steps for the owner. In this document, "the root" means the folder `C:\Users\Kuaya\Documents\CryptoResearch`.

## 1. Stop everything that can write

**Closing the browser does not stop the server.**

1. **The dashboard server.** `Open Dashboard.cmd` starts it in a console window titled "CryptoResearch dashboard - close this window to stop it", running `node dashboard\cli.js serve --open`. Close that window, or press Ctrl+C in it.
2. **Confirm it stopped** (PowerShell, in the root):
   ```powershell
   Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match 'cli\.js"?\s+serve' } | Select-Object ProcessId, CommandLine
   # expect: no rows
   Test-NetConnection 127.0.0.1 -Port 4729 -InformationLevel Quiet
   # expect: False; repeat with the port in .cr\server.json if it differs
   node dashboard\cli.js doctor
   # expect: the Dashboard server check says it is not reachable
   ```
3. **The hourly task.** It runs `dashboard\scripts\scheduled-run.cmd`, which runs `node dashboard\cli.js job run --all-due`.
   ```powershell
   schtasks /Change /TN "\CryptoResearch\Hourly" /DISABLE
   schtasks /Query /TN "\CryptoResearch\Hourly" /V /FO LIST
   # expect: Scheduled Task State: Disabled, and Status not Running
   Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match 'cli\.js' } | Select-Object ProcessId, CommandLine
   # expect: no rows; no job run is in progress
   ```
4. **Cowork or CLI writes.** Make sure none are running: `node dashboard\cli.js recover --status` should show no live lock and no pending staging.
5. **Optional safety copy of the records:** `node dashboard\cli.js backup create`. Never copy a backup over the records to roll back code.

## 2. Deploy the repaired revision (owner's decision)

1. **Check the current code is the audited revision:** `node <this folder>\rollback-code\verify-manifest.js .` should report `"ok": true` and `9ff79de7…`.
2. **Apply the patch**, either way:
   - copy everything under `patched-files\` over the root (20 files: 14 replaced, 6 new tests); or
   - run `git apply <this folder>\PATCH.diff`.
3. **Check the result:** `node <this folder>\rollback-code\verify-manifest.js . <this folder>\REPAIRED-MANIFEST.json` should report `"ok": true` and `0f5e0074…`.
4. **Run the suite on Windows:** `node dashboard\cli.js test`. Expect 139/139. If anything fails, do not continue: roll back (section 3).
5. **Run** `node dashboard\cli.js doctor`, re-enable the task with `schtasks /Change /TN "\CryptoResearch\Hourly" /ENABLE`, then open the dashboard.

No records are migrated or rewritten on upgrade. New fields appear only on new writes:

- **Research attempts:** `attempt_id`, `dispatch_token`, `dispatch_state`, `reservation_*`, `limits`, `reconciliation`.
- **Job state:** `needs_reconciliation`.
- **Spend ledger:** entry kinds `reservation`, `release`, `actual` and `reconciled`. These still carry `estimate_usd` and `actual_usd` for older readers.
- **Generation marker:** an optional `note`.
- **Exports, packages and backups:** an `integrity` block.

## 3. Roll back to the audited revision

1. **Stop everything** as in section 1.
2. **With the repaired code still in place**, run `node dashboard\cli.js research recover`. It never sends anything. It:
   - imports answers already saved;
   - releases reservations that were never sent;
   - holds interrupted paid attempts as `needs_reconciliation`.

   This step is required. In the compatibility check, the old runner re-sent an attempt that was interrupted after dispatch when this step was skipped, and sent nothing when it was run (`evidence/rollback-compat-results.json`, checks 2 and 3).
3. **Copy `rollback-code\dashboard\…` and `rollback-code\package.json` over the root.** These are the 70 audited files.
4. **Move the six new test files out of `dashboard\tests`.** These are `v2-reads.test.js`, `v2-restore.test.js`, `v2-research.test.js` and `children\child-v2-writer.js`, `child-v2-research.js` and `v2-stub.js`. The old code's `cli test` would otherwise run them and fail.
5. **Check the result:** `node <this folder>\rollback-code\verify-manifest.js .` should report `"ok": true` and `9ff79de7…`.
6. **Run** `node dashboard\cli.js test`, then `node dashboard\cli.js doctor`, re-enable the task, and open the dashboard.

### What the old code does with records written by the repaired code (tested)

- **Reads them.** Runs, jobs and the ledger are read; the index builds.
- **Never re-sends held attempts.** It only picks up `queued` and `running` jobs.
- **Erases nothing.** It rewrites no attempt, reservation or saved response. In the check, no project file changed and the ledger was only appended.
- **Spending is over-counted, never under-counted.** It does not know `release` or `not_charged`, so it keeps counting those reservations.
- **Shows `needs_reconciliation` as plain text** and cannot reconcile it. Re-deploy the repaired code to reconcile.

The pre-design recovery tree under `audits/2026-10-01-claude-implementation` predates these repairs. Use `rollback-code/` here instead.
