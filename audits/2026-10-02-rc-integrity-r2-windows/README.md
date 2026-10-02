# Release candidate: integrity repair round 2 on Windows

**Date:** 2026-10-02. **Author:** Claude (Claude Code, Opus 5.5), working in an isolated clone.

**Status:** implemented and tested on Windows. It is **not** independently reviewed, **not** merged and **not** deployed. The live folder still runs `a840ba7` (fingerprint `9ff79de7…`). The only change in the live folder is this new audit folder.

## Verdict

**Round 2 is a sound base on Windows.** Applied unchanged, it passed the suite, the F1 and restore checks, the seven-window browser check, the red checks, the rollback drill and the 320-second F2 check.

**Three capture failures, now fixed.** The capture adverse checks (criterion 2b) found three Windows failures in round 2's capture code. Each is fixed on the branch as its own commit with a test that failed first:

- **R1:** a link failing with `EISDIR` (FAT32 or exFAT) lost the answer.
- **W1:** an exclusive hold at read-back left a stale capture and a permanent false warning.
- **W2:** an exclusive hold during recovery left the answer unimported, with the attempt held as uncertain.

With the fixes, all 10 capture cases save the answer exactly once, with real NTFS locks or with no hard links, and the suite is **160/160**.

**Two further items need you; neither changes code:**

- **W3:** the deploy checklist's isolated-copy step (`git apply` outside a repository) produces CRLF files on this PC, so the fingerprint check fails although the code works. Use `git -c core.autocrlf=false apply`, or apply inside the repository.
- **W4:** round 2's documents say antivirus locks fall back to exclusive create through a failed link. On NTFS the link never fails under a lock.

| # | Acceptance criterion | Round 2 as applied (`1cc9fee`) | Release-candidate head (`665439b`) |
|---|---|---|---|
| 1 | Full suite, Node 24.21.0 (Volta) | **157/157**, twice | **160/160**, twice (30.0 s, 30.0 s) |
| 2a | F1 reproduction | Preserved. The first runner waited 20.2 s and reported *captured*; the next committed it. 1 request, 1 report, 1 actual-cost line ($0.101). | Same (20.2 s; 1, 1, 1; $0.101) |
| 2b | Capture with no hard links or a locked file (10 cases, real PowerShell `FileShare` holders) | L1, L2, S1, S2, S5, S6: saved once, clean. S4: saved once, but reported "could not be captured". **Failures:** S3 saved once but left an orphan capture and a permanent doctor warning (W1); S7 not imported, held uncertain (W2); L3 (`EISDIR`) lost the answer (R1). No second request anywhere. | **All 10 saved exactly once.** No leftovers, no doctor warnings, one request each. |
| 2c | Restore with junctions and Windows path forms on NTFS | **7/7.** The test creates a real junction; it also covers drive, UNC, rooted, reserved-name, alternate-data-stream, trailing-dot and trailing-space paths. | Unchanged code; 7/7 in both suite runs |
| 2d | Seven or more visible windows | **RC: 8 windows**, all Live; navigation and API calls 200 in 2–7 ms; 0 event streams, at most 6 sockets. **Baseline:** 6 windows held all 6 connections; the 7th window could not load; an API call timed out at 8 s. | Not repeated: `server.js` and `public/` are unchanged |
| 3 | New tests red on `a840ba7` | Round 2's 48 new tests: **44 fail, 4 pass** (round 1's documented 3, plus the F2 test that passes on any version). Round 2's tests on round 1: **13 fail, 8 pass**, the same set round 2 documented. | With the 3 fix tests, 51 tests: **47 fail, 4 pass** (the same 4). Each fix test also **failed on the commit before its fix**. |
| 4 | Rollback drill r2 → `a840ba7` → r2 (scratch copy) | **Passed.** The pending capture and 2 uncertain attempts survived; nothing re-sent; the capture was committed once after rolling forward. Fingerprints: `59fef28a` → `9ff79de7` → `59fef28a`. | **Passed**, same checks. Fingerprints: `92af2c94` → `9ff79de7` → `92af2c94`. |
| 5 | F2 long check (320 s delay, 600 s timeout) | **Ran.** Default fetch failed at 300.7 s (headers and body). The RC dispatcher and `callProvider` end to end answered at 320.0 s. | Not repeated: `providers.js` is unchanged |
| 6 | Privacy scan | **0 hits** in 4,116 added lines | **0 hits** in 4,249 added lines. The 5 files proposed for Git are also clean ([PRIVACY-SCAN.md](PRIVACY-SCAN.md)). |

## Branch and hashes

| Item | Value |
|---|---|
| Clone | `%TEMP%\cr-rc`, a `git clone --no-hardlinks` of the live folder. Push URL set to `PUSH-DISABLED-rc-clone`. Working tree clean. |
| Branch | `rc/integrity-r2` (local only, not pushed) |
| `a840ba7` | `a840ba77152a2064a1ec0047d376c39c1d1b9292`: live `main` = `origin/main`; fingerprint `9ff79de7f31aaf92c92822c1e092782c7a49493b84292ad38840516a86087fd0` (70 files) |
| `1cc9fee` | `1cc9fee4203e9dc1ea25345582f4dbfe09f8f95b`: round 2 applied without changes. Patch sha256 `59e27f2e…90e0`. 27 files (16 modified, 11 new). Fingerprint `59fef28aaf35be04bba288fe0825b1c7f7218a47a903d313b830e89424b07a73` (81 files), as round 2 expected. |
| `242a098` | Fix R1: `EISDIR` falls back to exclusive create. Fingerprint `eb05172a…cea6` |
| `c9b75b8` | Fix W1: a capture another program keeps from being read back still counts. Fingerprint `dd9146a5…b4cb` |
| `665439b` | `665439b494a7486f6037688e7a727dcbb00fbaf0`, the **head**. Fix W2: a capture held during recovery is retried, not held uncertain. Fingerprint **`92af2c94fd8e424fb134084c9c31033541ceeba3ae359a8629b6d40c26af41c3`** (81 files). |
| Fix size | `1cc9fee..665439b`: 5 files, 140 insertions and 7 deletions. Code: `core/captures.js`, `core/research.js` and `core/doctor.js`, 27 insertions and 5 deletions, comments included. The rest are tests. |
| Copies outside `%TEMP%` | `evidence/rc-integrity-r2.bundle` (the four RC commits; needs `a840ba7`; verified). `evidence/rc-integrity-r2-windows-full.patch` (`a840ba7..665439b`, LF, no mode changes). `evidence/rc-windows-fixes-on-r2.patch` (`1cc9fee..665439b`). |

The fingerprint method is SHA-256 of the sorted `path NUL sha256` lines for `dashboard/**` (except `demo-workspace`, `index`, `node_modules`) plus `package.json`.

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
| V2-004 | Aggregate spend | yes | 5/5 tests; drill ledger: 3 reservations, then 1 actual after commit | — |
| V2-005 | Honest tool bounds | yes | 6/6 tests | — |
| V2-006 | Bounded multi-window updates | yes | 1/1 test; browser check: 8 RC windows vs. 6+1 baseline windows | — |
| F1 | Paid answer lost under lock contention | yes (r2, plus the R1/W1/W2 fixes) | 12/12 F1 tests; F1 reproduction; 10 capture cases with real locks or no links; drill | — (see LIMITS 1–3 for what was simulated) |
| F2 | Undici 300 s transport timeouts | yes (r2) | 4/4 F2 tests (one non-discriminating, REVIEW R4); 320 s long check | Depends on an Undici internal; fails safe (LIMITS 6) |

## What you decide next

1. **Review the three fix commits** (`evidence/rc-windows-fixes-on-r2.patch`: 27 lines of code inserted and 5 deleted, comments included). Two of them deliberately change round 2's F1 rules:
   - **W1:** a capture whose read-back is blocked by another program counts, with the hash of the bytes this process wrote and fsynced. Its later uses re-check that hash.
   - **W2:** a capture that cannot be read because it is in use is retried by the next run, instead of making the attempt uncertain.

   If you prefer round 2 exactly as written, the branch at `1cc9fee` is that, with W1, W2 and R1 as known limits.
2. **Deploy route and fingerprint.** The expected fingerprint is now `92af2c94…` (81 files), not round 2's `59fef28a…`. Round 2's DEPLOY-CHECKLIST, ROLLBACK and RESULTS still name `59fef28a` and the round 2 patch. Use this RC's full patch or the bundle, and correct those documents when you deploy (W3, W4). Any of these works:
   - Apply `evidence/rc-integrity-r2-windows-full.patch` inside the repository.
   - Fetch the bundle into the live repository and check out or merge the branch.
   - On a non-repository copy, use `git -c core.autocrlf=false apply -p1 …`.
3. **Rollback.** Round 1's `ROLLBACK.md` plus round 2's four extra files worked as written (11 files to delete). The fixes add no files. While rolled back, the original doctor reports **ok** and cannot see waiting captures or uncertain attempts, so run `research run` and check doctor *before* rolling back.
4. **Keep the branch.** It lives only in `%TEMP%\cr-rc`, which Windows may clean. To keep it in the live repository without touching the working tree, fetch it from the bundle. This writes only a branch ref (no checkout, no commit), so I did not run it:
   ```
   git -C "%USERPROFILE%\Documents\CryptoResearch" fetch "%USERPROFILE%\Documents\CryptoResearch\audits\2026-10-02-rc-integrity-r2-windows\evidence\rc-integrity-r2.bundle" rc/integrity-r2:rc/integrity-r2
   ```
5. **Git tracking.** Add these lines to the `.gitignore` allowlist, after the existing audit re-includes:
   ```
   !/audits/2026-10-02-rc-integrity-r2-windows/README.md
   !/audits/2026-10-02-rc-integrity-r2-windows/REVIEW.md
   !/audits/2026-10-02-rc-integrity-r2-windows/LIMITS.md
   !/audits/2026-10-02-rc-integrity-r2-windows/COMMANDS.md
   !/audits/2026-10-02-rc-integrity-r2-windows/PRIVACY-SCAN.md
   ```
   Keep `evidence/` and `tools/` local: they hold this PC's paths, process IDs and raw outputs. Round 2's own reports are not in the allowlist yet either.

## Files

| File | Contents |
|---|---|
| `README.md` | This report |
| `REVIEW.md` | Review notes on `r2-delta-from-r1` with file:line; the findings and the fix commits (author-side, not an independent review) |
| `LIMITS.md` | What this validation did not cover |
| `COMMANDS.md` | Exact commands and versions |
| `PRIVACY-SCAN.md` | Privacy scan of the branch diff and of the files proposed for Git |
| `evidence/` | Raw outputs, local only (index below) |
| `tools/` | Harness scripts used here, local only. Round 2's tools are copied unchanged; `serve-instrumented.cjs` and `measure-window.cjs` come from round 1. |

### Evidence index

| Topic | Files |
|---|---|
| Suites | `suite-a840ba7-windows.txt`, `suite-rc-windows-run1.txt`, `suite-rc-windows-run2.txt` (`1cc9fee`), `suite-rc-665439b-windows-run1.txt`, `suite-rc-665439b-windows-run2.txt`, `suite-plain-git-apply-crlf-copy-windows.txt` |
| Apply and fingerprints | `apply-check.txt`, `apply-output.txt` (both empty: no output), `fingerprint-rc-working-tree.json`, `fingerprints-by-commit.txt`, `git-state-rc.txt` |
| Red checks | `red-new-tests-on-a840ba7-windows*.txt`, `red-r2-tests-on-r1-windows*.txt`, `red-new-tests-665439b-on-a840ba7-windows*.txt`, `red-fix-tests-final-code-windows.txt`, `fix-{A,B,C}-red-before-fix.txt`, `fix-{A,B,C}-green-after-fix.txt` |
| F1 reproduction | `f1-repro-rc-windows.json`, `f1-repro-rc-665439b-windows.json` |
| NTFS probes | `windows-lock-probe.json` (share modes vs link, read and delete), `windows-errno-probe.json` (`ERROR_INVALID_FUNCTION` → `EISDIR`) |
| Capture cases | `capture-adverse-rc-windows.json` (`1cc9fee`), `capture-adverse-rc-665439b-windows.json`, plus their `-summary.txt` |
| Restore tests | `integrity-restore-ntfs-windows.txt` |
| Browser check | `browser-checks-windows.json`, `browser-rc-8-visible-window.json`, `browser-rc-live-change-window.json`, `browser-base-starvation-stats-60s.json`, `browser-base-after-closing-one-tab-stats.json`, `cleanup-windows.txt` |
| Rollback drill | `rollback-drill-windows.json` (`1cc9fee`), `rollback-drill-windows-run1-plain-git-apply-crlf.json` (W3), `rollback-drill-rc-665439b-windows.json` plus its `-verdict.txt` |
| F2 | `f2-long-check-rc-windows.json`, `f2-long-check-started.txt` |
| Privacy | `privacy-scan-branch-diff.json`, `privacy-scan-branch-diff-665439b.json`, `privacy-scan-proposed-files.json` |
| RC copies | `rc-integrity-r2.bundle`, `rc-integrity-r2-windows-full.patch`, `rc-windows-fixes-on-r2.patch` |
