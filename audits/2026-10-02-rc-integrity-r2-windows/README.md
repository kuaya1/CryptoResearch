# Release candidate: integrity repair round 2 on Windows

**Date:** 2026-10-02. **Author:** Claude (Claude Code, Opus 5.5).

**Status:** implemented, tested on Windows, and prepared for independent review. It is **not** independently reviewed, **not** merged and **not** deployed. The live folder still runs `a840ba7` (fingerprint `9ff79de7…`).

## Candidate under review

| Item | Value |
|---|---|
| Branch | `rc/integrity-r2` in the CryptoResearch repository, offered for review as a draft pull request against `main` |
| Code commit | `665439b494a7486f6037688e7a727dcbb00fbaf0`, the last commit that changes application code |
| Source fingerprint | **`92af2c94fd8e424fb134084c9c31033541ceeba3ae359a8629b6d40c26af41c3`** (81 files) |
| Base | `a840ba77152a2064a1ec0047d376c39c1d1b9292` (`main`, the live code): fingerprint `9ff79de7f31aaf92c92822c1e092782c7a49493b84292ad38840516a86087fd0` (70 files) |
| Later commits on the branch | Documentation in this folder and `.gitignore` only, starting with `63b60f17449db86a7a25aa994a263c4ca68f87b5`. `git diff --stat 665439b494a7486f6037688e7a727dcbb00fbaf0 <branch head> -- dashboard package.json` prints nothing, and the branch head has the same fingerprint. |
| Expected suite | 160/160 with Node 24.21.0 |

**Fingerprint method:** SHA-256 of the sorted `path NUL sha256` lines for `dashboard/**` (except `demo-workspace`, `index`, `node_modules`) plus `package.json`. Round 2's `tools/fingerprint.cjs` computes it (local; a copy is in this folder's `tools/`).

## Verdict

**Round 2 is a sound base on Windows.** Applied unchanged, it passed the suite, the F1 and restore checks, the seven-window browser check, the red checks, the rollback drill and the 320-second F2 check.

**Three capture failures, now fixed.** The capture adverse checks (criterion 2b) found three Windows failures in round 2's capture code. Each is fixed on the branch as its own commit with a test that failed first:

- **R1:** a link failing with `EISDIR` (FAT32 or exFAT) lost the answer.
- **W1:** an exclusive hold at read-back left a stale capture and a permanent false warning.
- **W2:** an exclusive hold during recovery left the answer unimported, with the attempt held as uncertain.

With the fixes, all 10 capture cases save the answer exactly once, with real NTFS locks or with no hard links, and the suite is **160/160**.

**Two procedure findings, corrected in the deployment instructions below (no code change):**

- **W3:** applying a patch with plain `git apply` outside a repository produces CRLF files on this PC, so the fingerprint check fails although the code works.
- **W4:** round 2's checklist says antivirus locks fall back to exclusive create through a failed link. On NTFS the link never fails under a lock.

**How capture and recovery work for the reviewer:** [REVIEW.md](REVIEW.md) covers four things, with file:line at `665439b`:

- what makes a capture durable when read-back is blocked
- how a locked capture stays pending and is saved later
- how recovery avoids duplicate requests, reports and cost lines
- which Windows tests use real OS locks, simulated failures or untested assumptions

| # | Acceptance criterion | Historical: round 2 as applied (`1cc9fee`) | Current candidate (`665439b`) |
|---|---|---|---|
| 1 | Full suite, Node 24.21.0 (Volta) | **157/157**, twice | **160/160**, twice (30.0 s, 30.0 s) |
| 2a | F1 reproduction | Preserved. The first runner waited 20.2 s and reported *captured*; the next committed it. 1 request, 1 report, 1 actual-cost line ($0.101). | Same (20.2 s; 1, 1, 1; $0.101) |
| 2b | Capture with no hard links or a locked file (10 cases, real PowerShell `FileShare` holders) | L1, L2, S1, S2, S5, S6: saved once, clean. S4: saved once, but reported "could not be captured". **Failures:** S3 saved once but left an orphan capture and a permanent doctor warning (W1); S7 not imported, held uncertain (W2); L3 (`EISDIR`) lost the answer (R1). No second request anywhere. | **All 10 saved exactly once.** No leftovers, no doctor warnings, one request each. |
| 2c | Restore with junctions and Windows path forms on NTFS | **7/7.** The test creates a real junction; it also covers drive, UNC, rooted, reserved-name, alternate-data-stream, trailing-dot and trailing-space paths. | Unchanged code; 7/7 in both suite runs |
| 2d | Seven or more visible windows | **RC: 8 windows**, all Live; navigation and API calls 200 in 2–7 ms; 0 event streams, at most 6 sockets. **Baseline:** 6 windows held all 6 connections; the 7th window could not load; an API call timed out at 8 s. | Not repeated: `server.js` and `public/` are unchanged |
| 3 | New tests red on `a840ba7` | Round 2's 48 new tests: **44 fail, 4 pass** (round 1's documented 3, plus the F2 test that passes on any version). Round 2's tests on round 1: **13 fail, 8 pass**, the same set round 2 documented. | With the 3 fix tests, 51 tests: **47 fail, 4 pass** (the same 4). Each fix test also **failed on the commit before its fix**. |
| 4 | Rollback drill r2 → `a840ba7` → r2 (scratch copy) | **Passed.** The pending capture and 2 uncertain attempts survived; nothing re-sent; the capture was committed once after rolling forward. Fingerprints: `59fef28a` → `9ff79de7` → `59fef28a`. | **Passed**, same checks. Fingerprints: `92af2c94` → `9ff79de7` → `92af2c94`. |
| 5 | F2 long check (320 s delay, 600 s timeout) | **Ran.** Default fetch failed at 300.7 s (headers and body). The RC dispatcher and `callProvider` end to end answered at 320.0 s. | Not repeated: `providers.js` is unchanged |
| 6 | Privacy scan | **0 hits** in 4,116 added lines | **0 hits** in 4,249 added lines and in the 5 files in this folder ([PRIVACY-SCAN.md](PRIVACY-SCAN.md)) |

## Deployment instructions (current)

These replace round 2's `DEPLOY-CHECKLIST.md`, which stays unchanged in its folder as historical evidence (see [Superseded instructions](#superseded-instructions-historical)).

Nothing here has been done. Each step needs Eric's go-ahead, and deployment waits for the independent review.

1. **Deploy only what the review approved.** Use the reviewed code merged into `main`. If the review changes application code, the commit and fingerprint below change: record the new ones first.
2. **Stop everything that runs the live code, and confirm it stopped.** That means the dashboard window, its process and port, the hourly task (`Ready`, or disabled during the swap), any other Node process using the folder, and the workspace lock. Follow round 1's `ROLLBACK.md`, section "Stop the dashboard first, and confirm it stopped".
3. **Check the starting point:**
   - `git status` in the live folder shows no changes to tracked files, and `HEAD` is `a840ba7…`.
   - The live code still matches the recovery copy:

     ```
     node "<recovery copy>\verify-fingerprint.cjs" "<live folder>"
     ```

     It must print `"matches": true` (`9ff79de7…`).
4. **Bring in the reviewed code byte for byte, inside the repository.** After the pull request is merged on GitHub, run in the live folder:

   ```
   git fetch origin
   git merge --ff-only origin/main
   ```

   - **Line endings are safe.** The repository's `.gitattributes` (`* -text`) stops Git from converting them, so every file arrives byte for byte.
   - **What the merge changes.** It also brings this folder's five reports and the new `.gitignore` lines. It replaces the untracked local copies of those five files and leaves `evidence/` and `tools/` alone; this was tested with this PC's Git. Records are not tracked by Git and are not touched.
   - **Squash merges.** If the pull request is squash-merged, the commit on `main` has a different SHA from the branch; the fingerprint in step 5 is the check that matters.
   - **Never use plain `git apply` outside a repository on this PC (W3).** The system Git config sets `core.autocrlf=true`, and `git apply` outside a repository then writes CRLF into every patched file. To patch a scratch copy for testing, use `git -c core.autocrlf=false apply -p1 <patch>` and check the fingerprint afterwards.
5. **Verify the fingerprint.** The live code must give `92af2c94fd8e424fb134084c9c31033541ceeba3ae359a8629b6d40c26af41c3` (81 files), the fingerprint of commit `665439b494a7486f6037688e7a727dcbb00fbaf0`. Any other value: stop and roll back.
6. **Run the suite:** `node dashboard\cli.js test`. Expect 160/160; it uses temporary fictional workspaces only.
7. **Run doctor:** `node dashboard\cli.js doctor` (it writes a probe file). Expect no **Research captures** warning. The new checks report:
   - captures waiting to be saved
   - captures open in another program
   - captures that do not match an attempt
8. **Update the workspace docs.** Apply round 2's `DOC-CHANGES-PROPOSED.md` (local, unchanged) to `README.md`, `WORKSPACE-MAP.md` and `COWORK-INSTRUCTIONS.md`. Add one sentence for the case the Windows fixes introduced: if doctor says a capture file is open in another program, nothing is lost, the next research run tries again, and the file must not be touched.
9. **Reload every open dashboard tab** (old tabs keep the old page code). Re-enable the hourly task if it was disabled.

**What the Windows checks showed about captures under locks.** This corrects round 2's checklist (W4).

- On NTFS a file can be hard-linked while another program holds it open under any share mode. A lock therefore never makes the link fail and never triggers the exclusive-create fallback.
- A lock shows up later: reading the capture back, or deleting the name that is held open, fails with `EBUSY`. The fixed code handles both (W1, W2), tested with real locks in cases S1–S7.
- The exclusive-create fallback runs only where the volume refuses hard links (`EPERM`, `ENOTSUP`, `EISDIR` and similar). That was simulated (REVIEW, Windows test basis).

## Rollback (current)

1. **Before rolling back,** run `node dashboard\cli.js research run`, then doctor. Doctor must show no **Research captures** (waiting or open in another program). The original code leaves a waiting capture alone, and rolling forward saves it, but while rolled back that answer is not in the records. The original doctor reports `ok` and cannot see captures or uncertain attempts.
2. **Stop everything** (deployment step 2).
3. **Replace the code.** Follow round 1's `ROLLBACK.md`, section "Replace the code and verify it". Remove 11 files: its 7, plus 4 more:
   - `dashboard\core\captures.js`
   - `dashboard\tests\research-capture.test.js`
   - `dashboard\tests\provider-transport.test.js`
   - `dashboard\tests\children\child-lock-holder.js`

   The fixes add no files. `verify-fingerprint.cjs` must print `"matches": true`.
4. **This was drilled** on a scratch copy for both `1cc9fee` and `665439b`. The pending capture and uncertain attempts survived, nothing was re-sent, and rolling forward committed the capture once.
5. **After a Git-based deployment,** this file-copy rollback leaves `git status` showing the code files as modified against `HEAD`. That is expected, and `git checkout -- dashboard package.json` returns to the deployed code. A Git-based rollback (checking out or reverting to `a840ba7`) was not drilled.

## Superseded instructions (historical)

| Document | Status |
|---|---|
| Round 2's `DEPLOY-CHECKLIST.md` (local, not in Git) | **Superseded** by the two sections above; kept unchanged. It names `integrity-repair-r2.patch` and fingerprint `59fef28a…`. Those describe commit `1cc9fee` (round 2 as applied) and remain correct for it as historical evidence. Its blocker 1 tells you to `git apply` the patch in a non-repository copy, which produces CRLF on this PC (W3). Its note "antivirus locks (`EBUSY` falls back to exclusive create)" does not hold on NTFS (W4). |
| Round 2's `README.md`, `RESULTS.md`, `LIMITS.md` (local) | Historical. They describe round 2 tested on Linux; their results stand for `1cc9fee`. |
| Round 1's `README.md` and its patch (tracked) | Historical. Round 1 alone was never deployed; round 2 contains it. |
| Round 1's `ROLLBACK.md` (tracked) | Current for its stop procedure and file-copy rollback, with the 4 extra files above. |

## Branch and hashes

| Item | Value |
|---|---|
| Working clone (historical) | `%TEMP%\cr-rc`, a `git clone --no-hardlinks` of the live folder with pushing disabled. The four commits below were made there. |
| Branch | `rc/integrity-r2`. Fetched from the clone into the CryptoResearch repository without a checkout (verified: same SHA in the clone, the bundle and the repository), then prepared for review in a separate worktree. |
| `a840ba7` | `a840ba77152a2064a1ec0047d376c39c1d1b9292`: `main`, the live code. Fingerprint `9ff79de7…` (70 files). |
| `1cc9fee` | `1cc9fee4203e9dc1ea25345582f4dbfe09f8f95b`: round 2 applied without changes. Patch sha256 `59e27f2e…90e0`. 27 files (16 modified, 11 new). Fingerprint `59fef28aaf35be04bba288fe0825b1c7f7218a47a903d313b830e89424b07a73` (81 files), as round 2 expected. |
| `242a098` | `242a0984a7735ac9f929044adb3b817c840c6882`: fix R1, `EISDIR` falls back to exclusive create. Fingerprint `eb05172a…cea6`. |
| `c9b75b8` | `c9b75b80b53e7b416cb30e64ee713b79e8126e2c`: fix W1, a capture another program keeps from being read back still counts. Fingerprint `dd9146a5…b4cb`. |
| `665439b` | `665439b494a7486f6037688e7a727dcbb00fbaf0`: fix W2, a capture held during recovery is retried, not held uncertain. Fingerprint **`92af2c94…`** (81 files). |
| Fix size | `1cc9fee..665439b`: 5 files, 140 insertions and 7 deletions. The code part (`core/captures.js`, `core/research.js`, `core/doctor.js`) is 27 insertions and 5 deletions, comments included; the rest are tests. |
| Local copies (not in Git) | `evidence/rc-integrity-r2.bundle` holds the four commits, needs `a840ba7`, and is verified. `evidence/rc-integrity-r2-windows-full.patch` covers `a840ba7..665439b` (LF, no mode changes). `evidence/rc-windows-fixes-on-r2.patch` covers `1cc9fee..665439b`. |

## Environment

Windows 11 Home 10.0.26300.9550 on NTFS (C:). Node v24.21.0 through Volta 2.0.2, with Undici 7.29.1 and V8 13.6.233.17-node.53. Git 2.55.0.windows.4, whose system config sets `core.autocrlf=true`. The browser was the Claude desktop built-in Chromium 152.0.7977.130. The only antivirus is Windows Defender.

All checks used fictional test or demo workspaces under `%TEMP%`. Every test and check process loaded a network guard that refuses any non-loopback `fetch`; nothing was refused. Keys were fake and providers were local stubs. Not touched:

- the live dashboard and port 4729
- the scheduled task
- the Node pin
- the live settings and records

Exact commands are in [COMMANDS.md](COMMANDS.md).

## Closure table

States are kept apart: **implemented** means on `rc/integrity-r2` at `665439b`, **tested-Windows** means in this run. *Reviewed* (independently), *merged* and *deployed* are **no** for every row.

| ID | Problem | Implemented | Tested on Windows | Open |
|---|---|---|---|---|
| V2-001 | Coherent reads during writes | yes (round 1, carried in r2) | 8/8 tests in 4 suite runs; red on `a840ba7` as documented | — |
| V2-002 | Restore path validation | yes | 7/7 restore tests on NTFS, with a real junction and Windows path forms | — |
| V2-003 | Interrupted paid attempts | yes | 9/9 tests; drill (twice): uncertain attempts survive r2 → original → r2 and are never re-sent | — |
| V2-004 | Aggregate spend | yes | 5/5 tests; drill ledger: 3 reservations, then 1 actual after commit | REVIEW R8 (untested edge case; totals unaffected) |
| V2-005 | Honest tool bounds | yes | 6/6 tests | — |
| V2-006 | Bounded multi-window updates | yes | 1/1 test; browser check: 8 RC windows vs. 6+1 baseline windows | — |
| F1 | Paid answer lost under lock contention | yes (r2, plus the R1/W1/W2 fixes) | 12/12 F1 tests; F1 reproduction; 10 capture cases with real locks or no links; drill | — (what was simulated: REVIEW, Windows test basis) |
| F2 | Undici 300 s transport timeouts | yes (r2) | 4/4 F2 tests (one non-discriminating, REVIEW R4); 320 s long check | Depends on an Undici internal; fails safe (LIMITS 6) |

## For the reviewer

- **Where to start.** Review the code diff `a840ba7..665439b`, then the three fix commits (`1cc9fee..665439b`).
- **Design and test basis.** REVIEW.md, sections "How capture and recovery work after the fixes" and "Windows test basis".
- **Open questions.** REVIEW.md, "Questions for the independent reviewer".

## Files

| File | Contents |
|---|---|
| `README.md` | This report and the current deployment and rollback instructions |
| `REVIEW.md` | Review notes on `r2-delta-from-r1` with file:line; the findings and fix commits; how capture and recovery work; the Windows test basis; questions for the reviewer (author-side, not an independent review) |
| `LIMITS.md` | What this validation did not cover |
| `COMMANDS.md` | Exact commands and versions |
| `PRIVACY-SCAN.md` | Privacy scan of the branch diff and of these files |
| `evidence/` | Raw outputs. **Local only, not in Git** (index below). |
| `tools/` | Harness scripts used here. **Local only, not in Git.** Round 2's tools are copied unchanged; `serve-instrumented.cjs` and `measure-window.cjs` come from round 1. |

### Evidence index (local only)

| Topic | Files |
|---|---|
| Suites | `suite-a840ba7-windows.txt`, `suite-rc-windows-run1.txt`, `suite-rc-windows-run2.txt` (`1cc9fee`), `suite-rc-665439b-windows-run1.txt`, `suite-rc-665439b-windows-run2.txt`, `suite-plain-git-apply-crlf-copy-windows.txt` |
| Apply and fingerprints | `apply-check.txt`, `apply-output.txt` (both empty: no output), `fingerprint-rc-working-tree.json`, `fingerprints-by-commit.txt`, `git-state-rc.txt` |
| Red checks | `red-new-tests-on-a840ba7-windows*.txt`, `red-r2-tests-on-r1-windows*.txt`, `red-new-tests-665439b-on-a840ba7-windows*.txt`, `red-fix-tests-final-code-windows.txt`, `fix-{A,B,C}-red-before-fix.txt`, `fix-{A,B,C}-green-after-fix.txt` |
| F1 reproduction | `f1-repro-rc-windows.json`, `f1-repro-rc-665439b-windows.json` |
| NTFS probes | `windows-lock-probe.json` (share modes against link, read and delete), `windows-errno-probe.json` (`ERROR_INVALID_FUNCTION` → `EISDIR`) |
| Capture cases | `capture-adverse-rc-windows.json` (`1cc9fee`), `capture-adverse-rc-665439b-windows.json`, plus their `-summary.txt` |
| Restore tests | `integrity-restore-ntfs-windows.txt` |
| Browser check | `browser-checks-windows.json`, `browser-rc-8-visible-window.json`, `browser-rc-live-change-window.json`, `browser-base-starvation-stats-60s.json`, `browser-base-after-closing-one-tab-stats.json`, `cleanup-windows.txt` |
| Rollback drill | `rollback-drill-windows.json` (`1cc9fee`), `rollback-drill-windows-run1-plain-git-apply-crlf.json` (W3), `rollback-drill-rc-665439b-windows.json` plus its `-verdict.txt` |
| F2 | `f2-long-check-rc-windows.json`, `f2-long-check-started.txt` |
| Privacy | `privacy-scan-branch-diff.json`, `privacy-scan-branch-diff-665439b.json`, `privacy-scan-proposed-files.json` |
| RC copies | `rc-integrity-r2.bundle`, `rc-integrity-r2-windows-full.patch`, `rc-windows-fixes-on-r2.patch` |
