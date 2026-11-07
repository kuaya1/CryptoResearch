# R0: repeated proof at `da456b7` (2026-11-07)

**Status when written: sealed, not certified.** R0 at this revision is certified only if the post-merge command below reads PASS after this receipt deploys. A merged receipt cannot report its own result. The earlier receipt, `OPERATING_PROOF_R0_2026-11-03.md`, stays as history.

- **Revision:** `da456b722f5ec55edf5689a87ce95c162456dfed` (PR #189's merge).
- **Bundle:** `C:\Users\Kuaya\Documents\CryptoResearch-evidence\operating-proof-2026-11-06-r0-da456b7\R0`.
- **Seal:** `R0/manifest.json` binds 11 files, closed 2026-11-07T05:48:10.317Z. Its SHA-256 is `6bbca5599ce1ec8ab34b266febc78ae249cf696691feb9c85eb577293e3e5982`.
- **`pilot-all`:** Disabled throughout. It has never run.

Raw evidence stays on Eric's PC. Times are UTC, with New York time (EST, UTC-5) where it helps.

## Who ran what

Eric approved R0 at this revision in chat on 2026-11-06, including the doctor's write test. He reported running steps 1 to 9 himself. The records do not show whose hands ran them. Claude wrote the commands, read the records, made the read-only checks named here and prepared this receipt. Claude ran no step, changed no task and did not seal.

| Step | Action | When |
|---|---|---|
| Gate | `/healthz`, live anchor and a trial of the receipt verifier, read by Claude as Eric asked | 2026-11-06 about 11:44 to 11:50Z |
| 1, 2 | Identity read, Hourly disabled | Before the capture. No separate time recorded |
| 3 | Runner moved from `3ce579c` to `da456b7` | 12:02:06Z (07:02:06 ET), from the runner's reflog |
| 4 | Evidence root made by the template | 12:12:48Z (07:12:48 ET) |
| 5 | Registration read | 12:12:49Z |
| 6 | Revisions, tasks, route probe, doctor | 12:13:12Z to 12:13:16Z |
| 7 | Hourly restored | After 12:13:16Z and before Eric reported it at 12:14:35Z. No separate time recorded |
| 8 | Offsite read | Offsite ran 2026-11-07T05:26:15.565Z (00:26:15 ET). Readback saved 05:45:25Z |
| 9 | Seal | 2026-11-07T05:48:10.317Z (00:48:10 ET) |

Hourly first ran on the moved runner at 07:25:44 ET on 2026-11-06, result 0.

## What the records show

- **Revisions (12:13:12Z):** `origin/main`, runner HEAD and `/healthz` all `da456b7`, HTTP 200. The runner was detached and clean.
- **Deploy:** Render deploy `dep-dbmrq1mgekts73eaeko0`, commit `da456b7`, trigger manual, from the anchor save. `/healthz` read started 2026-11-06T11:42:39.132Z at capture and still at 2026-11-07T05:49Z, so the desk did not restart in between.
- **Tasks (12:13:12Z):** `pilot-all` and Hourly both Disabled, enabled false, 0 instances.
- **Registration:** Disabled, `job_wrapper`, max 1 agent, unattended, model named, checkout clean at `da456b7`, working directory is the repository. Execution state `never_run`.
- **Route probe (12:13:13Z):** the real wrapper and scheduled script ran with a harmless compiled `node.exe` stand-in. It saw the runner as working directory, the desk records as workspace and the exact `job run --all-due` arguments. `outer_exit=73`, nothing thrown, `pass=True`, `exit=73`. 73 is the stand-in's own exit code. No job ran.
- **Doctor (12:13:16Z):** status `warn`, write test run, `verified_write: true`, real workspace `ws_rzn5w5pudi`. Its approved write test wrote `.cr\doctor.probe` at 07:13:14 ET.
- **Offsite:** status `ok`, trigger scheduler, 1,934 files, 52 projects, 161 reports, 305 transactions, every file verified, one older copy pruned. The copy is `cryptoresearch-desk-2026-11-07T05-26-14-702Z.json`, 175,726,954 bytes, SHA-256 `d074972f4c33b6a2785a48dd007c76b340333a95450bc83c9ae3c331ff9c94fc`. Its package names revision `da456b7`.
- **Book in that copy:** `paper/trader/journal.jsonl` 96 bytes, `fund:begin` 1, `fund:commit` 1.

### Warnings, as read

Doctor recorded two warnings. Neither is hidden or fixed by this receipt.

- **Scheduled task:** "Installed, but it runs C:\Users\Kuaya\Documents\CryptoResearch-runner, not this folder. It does not update this workspace." The check compares code and records folders and does not follow the wrapper. The route probe above read the actual route.
- **GitHub credentials:** the shell has GitHub auth with admin on the repository through the stored `gh` login, and no token variables. Removing variables cannot stop a process using that login, so Law 1 is procedural on this machine.

### Book anchor

`CR_TRADER_BOOK_ANCHOR` was installed by Eric before capture. Claude read it from the Chrome session Eric had already signed in. Claude did not sign in, and the token was not printed or stored.

| Read | Anchor | First-line hash | Book |
|---|---|---|---|
| 2026-11-06T11:45:16Z | `established` | `ea9b81703ef3349f10aa7a48285f850758201ba78008301612162afc4137e3c4` | Funded 25000 at 2026-11-02T12:47:57.399Z, cash and NAV 25000, 0 orders, 0 positions |
| 2026-11-07T05:50:39Z | `established` | Same | Same |

At 2026-11-07T05:51:27Z the desk was not paused, the mandate was on (generation 1, expires 2026-11-08T14:06:13.584Z) and admission was off.

## What the seal leaves out

`prove-autonomy r0 --seal` reported `not_bound: ["route-probe-bin"]`. **This is expected.** The seal binds only regular files directly in `R0\`, and it names any subfolder it leaves out (`membersOf` in `dashboard/core/proof-capture.js`). `dashboard/tests/proof-capture.test.js` asserts this exact case.

The route probe creates that subfolder. It holds:

| File | Bytes | SHA-256 |
|---|---|---|
| `node.exe`, the compiled stand-in | 5,120 | `79080fc8312ab7c5637cd74a3c5411f00291af1c2c0e303abc7db91509d88288` |
| `NodeRouteProbe.cs`, its source | 1,176 | `cea3955fbbc462efb926e74bb412481e174f2852137759d367d4740814efd31a` |

What the exclusion means:

- **Not protected by the manifest:** a later change to these two files would not be noticed by the manifest or the verifier. The hashes above are a record only, and no command checks them.
- **No gate reads them:** the R0 gates read the bound records, including `verification.json` and the bound route-probe readbacks.
- **Source is still bound:** the bound `hourly-route-probe.ps1` holds the same source, which Claude compared, apart from line endings. The compiled `node.exe` itself was not inspected.
- **Not screened:** the seal's secret and fiction screens read bound files only, so they did not read this subfolder.

Two records sit outside `R0\` and are also unbound. `book-continuity.txt` (SHA-256 `8c8a1a7ac966f8e859002e9b263efe0602cb462cd0ad07d5bf2177beb652531f`) stays outside by the checklist's design. `CAPTURE-R0.txt` (SHA-256 `ef15b7c21cda591cbed29afb31f4fe0aa22b32632c57de79ef0173e168e3d853`) is the template's own command sheet.

## Owner rulings

Given by Eric in chat on 2026-11-06, word for word.

**Op-log limit:**

> Accepted for R0 with the book anchor installed. Routine execution never funds a book, and any lost book refuses loudly. Book continuity across restarts remains unverified by R0.

**Protected baseline:**

> I adopt the nine protected-file hashes in PROTECTED-BASELINE-MANIFEST.txt, SHA-256 fcf987f3797aeff882b009dd7cb1c88e093a1bededbc9e1bbccfe02113fd3b26, at commit da456b722f5ec55edf5689a87ce95c162456dfed, as the protected baseline from today. This is a decision today. It does not state what was or was not authorized when #175 merged.

### Facts beside the rulings

These are facts for the record, not changes to the rulings.

- The anchor refusal was read from the code at `da456b7` and is covered by `dashboard/tests/trader-book-anchor.test.js`. It was not re-run on the live desk.
- An older snapshot is not a lost book. The anchor names the book, not its progress, so a rollback passes it (`docs/engineering/PAPER_BOOK_RESTORE.md:40`). The offsite job still does not compare a copy with the one before it.
- All nine protected files matched the manifest at this revision, 0 different, read from Git objects on 2026-11-07. The manifest file still has the hash in the ruling.
- The adoption leaves these questions open: "merged continue" was read as the [P] go-ahead; "merged full authorazation" is ambiguous; whether the `paper.js` diff was read in the 107 seconds before merge is unknown; the `kuaya1` login does not show whose hands merged.

## Differences from the checklist

- **Shell:** the capture ran under Windows PowerShell 5.1.26100.9711, not PowerShell 7 as the checklist asked. The outer file reads `shell=pwsh 5.1.26100.9711`, so its `pwsh` label is wrong. No gate reads the shell, the records parse, and they were not re-captured.
- **Abandoned attempt:** a first try at step 6 stopped on two commands that are not in the checklist. `node dashboard/cli.js doctor` without `CR_WORKSPACE` returned NOT_A_WORKSPACE, and `node scripts/pilot.js --route-probe` returned MODULE_NOT_FOUND. The failed doctor wrote nothing. Its folder, `operating-proof-2026-11-06\R0`, was left untouched and unsealed, and the proof used a new root. Hourly was re-enabled after that attempt and disabled again before the capture.
- **Step 8:** Eric ran his own script, not the checklist's block. It saved the same two records and stops if `offsite verify` fails. Claude saw only its last lines, so Claude also called `verifyFile` from `dashboard/core/offsite.js` on the copy, on Node 24.21.0 from a clean clone at `da456b7`: `ok: true`, 0 problems, 1,934 files. That was a direct call, not the CLI.

## What R0 does not prove

- **Book continuity across restarts.** See the first ruling. The records show one book funded once, and an older snapshot would still pass the anchor.
- **Any pilot run.** `pilot-all` has never run. Arming the pilot and B0 to B3 stay closed.
- **Live origin of the records.** The seal shows the bytes stayed put, not that they are true. Eric's merge of this receipt is what vouches for them, and that is not a cryptographic attestation.
- **The route under real work.** The probe used a stand-in. Hourly's real runs on this revision show only that the jobs due then finished: 07:25:44 ET on 2026-11-06 and 00:25:44 ET on 2026-11-07, both result 0.
- **A full restore.** `offsite verify` checks the copy. `offsite drill` was not run for this proof.
- **Render's Node version.** Render runs v24.22.2 and the pin is v24.21.0. Whether the difference matters is unknown.
- **The test suite on the desk.** R0's gates do not run it. The last read for `main` is CI run 42156215914 at `da456b7`: 2,116 tests, 2,109 pass, 0 fail, 0 cancelled, 7 skipped.

## Certifying

This merge restarts the desk, because any merge to `main` deploys. After the deploy, in a new clean clone so the runner does not move:

```powershell
$v = "$HOME\Documents\CryptoResearch-verify-r0"
$root = "$HOME\Documents\CryptoResearch-evidence\operating-proof-2026-11-06-r0-da456b7"
git clone https://github.com/kuaya1/CryptoResearch $v
git -C $v checkout --detach <receipt merge SHA>
(Invoke-WebRequest https://cryptoresearch.onrender.com/healthz -UseBasicParsing).Content   # must name the receipt merge
Push-Location $v; node dashboard/cli.js prove-autonomy r0 --mode=post-merge --expected-revision=<receipt merge SHA> --evidence=$root --json; Pop-Location
```

The manifest's baseline stays `da456b7`. The gap to the receipt's merge is allowed only because this PR changes `docs/engineering` alone. Afterward the runner is behind `origin/main` by docs only, and refreshing it before B0 is a later owner step.
