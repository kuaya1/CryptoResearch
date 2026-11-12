# R0: repeated proof at `df74e56` (2026-11-12)

**Status when written: sealed and awaiting post-merge verification.** R0 at this revision is certified only if the post-merge command below reads PASS after this receipt deploys. A merged receipt cannot report its own result. The earlier receipts, `OPERATING_PROOF_R0_2026-11-03.md` and `OPERATING_PROOF_R0_2026-11-07.md`, stay as history.

- **Revision:** `df74e5675015359989350360cbc80e844d025fcf` (PR #194's merge). Its tree is `ae8764186c7a7b74731ef36a28c36738e9871094`.
- **Bundle:** `$HOME\Documents\CryptoResearch-evidence\operating-proof-2026-11-11-r0-df74e56\R0`, on Eric's PC.
- **Seal:** `R0/manifest.json` binds 11 files, closed 2026-11-12T05:38:19.451Z. Its SHA-256 is `6d2a3c49fa68c14ee40a00b93e63583d4381171ebc16112c59abf61c454c85a7`.
- **`pilot-all`:** Disabled throughout. Task Scheduler has never started it.

Raw evidence stays on Eric's PC. Times are UTC, with New York time (EST, UTC-5) where it helps.

## Who ran what

Eric approved the checklist for this revision in chat on 2026-11-11, including Hourly off and on, the runner move and the doctor's write test. He said he would run steps 1 to 9 and 11. Afterward he reported completing steps 8 and 9, the seal result, and the first Hourly result after the runner move. The records do not show whose hands ran them. Claude wrote the checklist, read the records, made the read-only checks named here and prepared this receipt. Claude ran no step, changed no task, did not move the runner and did not seal.

| Step | Action | When |
|---|---|---|
| Gate | GitHub, `/healthz`, runner, tasks, protected files and live anchor, read by Claude as Eric asked | 2026-11-11 21:42Z to 21:50Z, with re-reads at 22:05Z and 22:09Z |
| 1 | Identity read and fetch | Fetch at 22:35:18Z (17:35:18 ET), from the runner's fetch record. The other reads have no recorded time |
| 2 | Hourly disabled | **No time recorded.** By the order of the commands, between 22:35:18Z and 22:36:24Z |
| 3 | Runner moved from `8664635` to `df74e56` | 22:36:24Z (17:36:24 ET), from the runner's reflog |
| 4 | Evidence root made by the template | 22:36:51Z (17:36:51 ET) |
| 5 | Registration read | 22:37:24Z |
| 6 | Revisions, tasks, route probe, doctor | 22:37:46Z to 22:37:51Z |
| 7 | Hourly restored | **No time recorded.** After 22:37:51Z and before Hourly ran at 23:25:44Z |
| 7a | First Hourly on the moved runner | Ran 23:25:44Z (18:25:44 ET), result 0, as Eric reported. **The time he read it was not recorded, and no file holds that read** |
| 8 | Offsite read | Offsite ran 2026-11-12T05:26:14.256Z (00:26:14 ET). `book-continuity.txt` saved 05:37:15Z. Readback copied 05:38:16Z. **The `offsite verify` run has no recorded time and its output was not saved** |
| 9 | Seal | 2026-11-12T05:38:19.451Z (00:38:19 ET). The seal's printed result was not saved; the manifest is its record |

Times come from the records' own `observed_at` fields, file times, the runner's reflog and its fetch record. The shell history shows the commands and their order but no times. Task Scheduler keeps no history on this PC, so it holds no record of the disable or the enable.

## What the records show

- **Revisions (22:37:46Z):** `origin/main`, runner HEAD and `/healthz` all `df74e56`, HTTP 200. The runner was detached and clean.
- **Deploy:** Render deploy `dep-dbqdv6brjlhs73fo69r0`, trigger `new_commit`, finished 2026-11-11T21:36:17.513458Z, live on `df74e56`. **Eric supplied these details. Claude did not read the Render record**: the Render connector did not connect when Claude tried. `/healthz` read started 2026-11-11T21:36:12.710Z at capture, in the offsite package, and again at 2026-11-12T05:45:49Z, so the desk did not restart in between.
- **Tasks (22:37:46Z):** `pilot-all` and Hourly both Disabled, enabled false, 0 instances.
- **Registration (22:37:24Z):** Disabled, `job_wrapper`, max 1 agent, unattended, model named, checkout clean at `df74e56`, working directory is the repository. Execution state `never_run`, last result 267011 ("has not run"). The status also says the runner's log holds a line that began 2026-11-07T06:31:49.577Z and belongs to another start, not to this task.
- **Route probe (22:37:47Z to 22:37:48Z):** the real wrapper and scheduled script ran with a harmless compiled `node.exe` stand-in. It saw the runner as working directory, the desk records as workspace and the exact `job run --all-due` arguments. `shell=pwsh 7.6.10`, `outer_exit=73`, nothing thrown, `pass=True`, `exit=73`. 73 is the stand-in's own exit code. No job ran.
- **Doctor (22:37:51Z):** status `warn`, write test run, `verified_write: true`, real workspace `ws_rzn5w5pudi`, Node v24.21.0. Its approved write test wrote `.cr\doctor.probe` at 17:37:48 ET.
- **Offsite (05:26:14Z):** status `ok`, trigger scheduler, 1,995 files, 52 projects, 161 reports, 305 transactions, every file verified, one older copy pruned. The run is later than `tasks-final.observed_at`. The bound readback was byte for byte the same as the job state file when Claude compared them at about 05:43Z.
- **The copy:** `cryptoresearch-desk-2026-11-12T05-26-13-399Z.json`, 180,928,535 bytes, SHA-256 `eb8f31c1e7635630e6be1f007a9629b25e79badc446914d1e750f2d270c04287`. Its package was created 2026-11-12T05:25:59.259Z and names revision `df74e56` and the same desk start time.
- **Book in that copy:** `paper/trader/journal.jsonl` 96 bytes, one line, `fund:begin` 1, `fund:commit` 1. That line's SHA-256 is `ea9b81703ef3349f10aa7a48285f850758201ba78008301612162afc4137e3c4`, the anchor's hash.

### Checks Claude made on the sealed records (2026-11-12, 05:40Z to 05:46Z)

- **Manifest:** the file's SHA-256 is the one above. It lists 11 files, and each one's bytes and hash match the file on disk. `R0\` holds those 11, the manifest and the `route-probe-bin` subfolder, nothing else.
- **Offsite copy:** Eric's `offsite verify` output was not saved, so Claude called `verifyFile` from `dashboard/core/offsite.js` at `df74e56` on the copy: `ok: true`, 0 problems, 1,995 files. That was a direct call on Node v20.20.2, not the CLI.
- **Verifier before this merge:** from a clean clone at `df74e56`, offline, the bundle reads FAIL on `r0:manifest`, because no merged receipt names it yet. That is the expected reading until this receipt merges.
- **Runner afterward:** still `df74e56`, detached and clean. Hourly was Ready, with its last run at 00:25:44 ET, result 0. `pilot-all` was Disabled.

### Warnings, as read

Doctor recorded two warnings, the same two as on 2026-11-07. Neither is hidden or fixed by this receipt.

- **Scheduled task:** "Installed, but it runs C:\Users\Kuaya\Documents\CryptoResearch-runner, not this folder. It does not update this workspace." The check compares code and records folders and does not follow the wrapper. The route probe above read the actual route.
- **GitHub credentials:** the shell has GitHub auth with admin on the repository through the stored `gh` login, and no token variables. Removing variables cannot stop a process using that login, so Law 1 is procedural on this machine.

### Book anchor

`CR_TRADER_BOOK_ANCHOR` was already installed and was not reinstalled. Claude read it from the Chrome session Eric had already signed in. Claude did not sign in, every request was a GET, and the token was not printed or stored.

| Read | Anchor | First-line hash | Book |
|---|---|---|---|
| 2026-11-11T21:46:42Z, before the capture | `established` | `ea9b81703ef3349f10aa7a48285f850758201ba78008301612162afc4137e3c4` | Funded 25000 at 2026-11-02T12:47:57.399Z, cash and NAV 25000, 0 orders, 0 positions, settled |
| 2026-11-12T05:46:17Z, after the seal | `established` | Same | Funded 25000 at the same time, cash and NAV 25000, 0 orders, 0 requests, settled |

At both reads the desk was not paused, admission was off, and the mandate was off (generation 1, expired 2026-11-08T14:06:13.584Z). No production poll has reached the desk. R0 depends on none of these, and the mandate was not renewed for it.

## What the seal leaves out

Eric reported the seal's result as `ok`, 11 members, with `not_bound: ["route-probe-bin"]`. **This is expected.** The seal binds only regular files directly in `R0\`, and it names any subfolder it leaves out (`membersOf` in `dashboard/core/proof-capture.js`). `dashboard/tests/proof-capture.test.js` asserts this exact case.

The route probe creates that subfolder. It holds:

| File | Bytes | SHA-256 |
|---|---|---|
| `node.exe`, the compiled stand-in | 5,120 | `ca3ffaddfb6b6f54007822a7540097bc8cc633794514e87039f5532183cbbb4e` |
| `NodeRouteProbe.cs`, its source | 1,176 | `cea3955fbbc462efb926e74bb412481e174f2852137759d367d4740814efd31a` |

What the exclusion means:

- **Not protected by the manifest:** a later change to these two files would not be noticed by the manifest or the verifier. The hashes above are a record only, and no command checks them.
- **No gate reads them:** the R0 gates read the bound records, including `verification.json` and the bound route-probe readbacks.
- **Source is still bound:** the bound `hourly-route-probe.ps1` (SHA-256 `e4337cd2459fed1f1a6c5e3b16125ae4be29cafec1b0bea679046c269d3eb0a2`) and `NodeRouteProbe.cs` both have the hashes recorded on 2026-11-07, when Claude compared the two sources. They were not compared again. The compiled `node.exe` is built fresh by each probe, so its hash differs from last time, and it was not inspected.
- **Not screened:** the seal's secret and fiction screens read bound files only, so they did not read this subfolder.

Two records sit outside `R0\` and are also unbound. `book-continuity.txt` (SHA-256 `0c10285f96caf7e5e43e5cf2e12dc4e7264a7284c56e9ca43066a9f3637d8237`) stays outside by the checklist's design. `CAPTURE-R0.txt` (SHA-256 `e77341a4dfe295b3284ba77ccfeadccf0b79254a329cd301a37f54f009c66bd9`) is the template's own command sheet.

## Test runs for this revision

| Run | Event | Commit | Result | Tests | Pass | Fail | Skipped |
|---|---|---|---|---|---|---|---|
| 43103686664 | pull request | `260038f`, tree `ae876418` | success, finished 2026-11-11T21:34:20Z | 2,269 | 2,262 | 0 | 7 |
| 43104377806, attempt 1 | push to `main` | `df74e56` | **failure**, finished 21:38:48Z | 2,269 | 2,261 | 1 | 7 |
| 43104377806, attempt 2 | push to `main` | `df74e56` | success, finished 22:04:31Z | 2,269 | 2,262 | 0 | 7 |

- **The failure:** `dashboard/tests/b1-receipt-proof.test.js:204`, B1P4, `Error: socket hang up` on the test's own request to a server it started itself. The same tree passed that test in the pull request run four minutes earlier and again in attempt 2.
- **Cause: not known.** One of three Linux runs on this tree failed. A passing re-run shows the failure is not constant. It does not show why it happened.
- **The 7 skipped** in every run are 5 tests that need a full clone and 2 opt-in tests.
- **Not fixed here.** A fix to that test is a test merge. Merged before the post-merge check reads PASS, it would restart R0.

## Owner rulings

Given by Eric in chat on 2026-11-11, word for word.

**The failed test run on `main`:**

> I accept the passing CI retry for R0 on df74e56. Record both attempts and defer the B1P4 investigation until after R0

**Op-log limit:**

> My November 6 op-log ruling carries forward to this R0 on its original terms, including its stated limits.

The ruling it carries forward, from the 2026-11-07 receipt:

> Accepted for R0 with the book anchor installed. Routine execution never funds a book, and any lost book refuses loudly. Book continuity across restarts remains unverified by R0.

**Protected baseline:**

> My November 6 protected baseline adoption covers this R0 at `df74e5675015359989350360cbc80e844d025fcf`. The preflight verified all nine files against that baseline.

**The checklist and who runs it:**

> Yes, I approve `R0-CHECKLIST-df74e56.md` for this revision. I will run steps 1–9 and 11 in the checklist’s order. This approval covers turning Hourly off and back on, moving the runner from `8664635` to `df74e56`, and running the doctor write test on the real workspace at its designated step. For step 10, Fable prepares the receipt and I review and merge it. Keep `pilot-all` disabled.

### Facts beside the rulings

These are facts for the record, not changes to the rulings.

- All nine protected files matched the adopted manifest (SHA-256 `fcf987f3797aeff882b009dd7cb1c88e093a1bededbc9e1bbccfe02113fd3b26`), 0 different. Claude read them from Git objects at `df74e56` on 2026-11-11 at 21:45Z, and from the runner's own files after the move on 2026-11-12 at 05:45Z.
- The anchor refusal is code at this revision, covered by `dashboard/tests/trader-book-anchor.test.js`. It was not re-run on the live desk.
- An older snapshot is not a lost book. The anchor names the book, not its progress, so a rollback passes it (`docs/engineering/PAPER_BOOK_RESTORE.md:40`). The offsite job still does not compare a copy with the one before it.
- The questions the 2026-11-06 adoption left open are still open. They are listed in the 2026-11-07 receipt.

## Differences from the checklist

- **Step 7a:** Eric read the first Hourly with `Get-ScheduledTaskInfo` piped to `Select-Object LastRunTime, LastTaskResult, NextRunTime`, not the checklist's line. It reads the same values. Its output was not saved.
- **After step 7:** the doctor's summary line was read once more from the saved file. The doctor was not run again.
- **Nothing else differed.** The shell was PowerShell 7.6.10, as the checklist asked. Steps 1 to 7 ran in one pass, in about two and a half minutes, and no attempt was abandoned.

## What R0 does not prove

- **Book continuity across restarts.** See the op-log ruling. The records show one book funded once, and an older snapshot would still pass the anchor.
- **Any pilot run.** Task Scheduler has never started `pilot-all`. Arming the pilot and B0 to B3 stay closed.
- **Live origin of the records.** The seal shows the bytes stayed put, not that they are true. Eric's merge of this receipt is what vouches for them, and that is not a cryptographic attestation.
- **The route under real work.** The probe used a stand-in. Hourly's real runs on this revision show only that the jobs due then finished: 18:25:44 ET on 2026-11-11, as Eric reported, and 00:25:44 ET on 2026-11-12, both result 0.
- **A full restore.** The copy was checked file by file. `offsite drill` was not run for this proof.
- **Render's own records.** The deploy details are Eric's. Render's Node version was not read for this proof; the 2026-11-07 receipt recorded v24.22.2 against the v24.21.0 pin.
- **A reliable test suite.** R0's gates do not run the suite. One test failed once on `main` at this revision for a reason that is not known. See "Test runs for this revision".

## Certifying

This merge restarts the desk, because any merge to `main` deploys. After the deploy, in a new clean clone so the runner does not move:

```powershell
$v = "$HOME\Documents\CryptoResearch-verify-r0-df74e56"
$root = "$HOME\Documents\CryptoResearch-evidence\operating-proof-2026-11-11-r0-df74e56"
git clone https://github.com/kuaya1/CryptoResearch $v
git -C $v checkout --detach <receipt merge SHA>
(Invoke-WebRequest https://cryptoresearch.onrender.com/healthz -UseBasicParsing).Content   # must name the receipt merge
Push-Location $v; node -v                                                                  # must read v24.21.0
node dashboard/cli.js prove-autonomy r0 --mode=post-merge --expected-revision=<receipt merge SHA> --evidence=$root --out="$root-verify" --json; Pop-Location
```

The manifest's baseline stays `df74e56`. The gap to the receipt's merge is allowed only because this PR changes `docs/engineering` alone. Afterward the runner is behind `origin/main` by docs only, and refreshing it before B0 is a later owner step.
