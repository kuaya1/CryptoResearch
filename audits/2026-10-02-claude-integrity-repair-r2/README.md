# Integrity repair, round 2: F1 and F2 from the Cowork review

> **Status (2026-10-02).** Historical: this report describes round 2 as tested on Linux; its results stand for commit `1cc9fee`. Round 2 was then validated and fixed on Windows; the current state, deployment instructions and fingerprint are in [the Windows release-candidate report](../2026-10-02-rc-integrity-r2-windows/README.md). The PC's name is replaced by "Eric's PC" in this tracked copy.

**Date:** 2026-10-02. **Author:** Claude (Cowork), working from Eric's repair brief after the independent review of `../2026-10-02-claude-integrity-repair/`.

**Status: implemented and validated in an isolated copy. NOT deployed.**
- The live `dashboard/` code is unchanged: fingerprint `9ff79de7f31aaf92c92822c1e092782c7a49493b84292ad38840516a86087fd0` before and after this work (the audited target).
- No records, settings, keys, scheduled task or runtime pin were touched. No paid call was made. No provider was contacted: every test run loaded a network guard that refuses non-loopback requests, and it logged no refusals.
- The first repair folder (`../2026-10-02-claude-integrity-repair/`) is left exactly as it was. This folder supersedes its patch.

## Starting state, verified

| Question | Answer | Evidence |
|---|---|---|
| Is any repair live? | No. Live code = audited target `9ff79de7…` (70 files). Nothing live contains `dispatching`, `uncertain` or captures. | `evidence/fingerprints.json` |
| What did round 1 change? | 23 files: 16 modified + 7 new tests/children. Not 31. Its fingerprint scope counts 77 files (70 + 7). Applying `integrity-repair.patch` to the live code reproduces its repaired fingerprint `4ce11b80…` exactly. | `evidence/fingerprints.json` |
| Git? | When this work started (18:32 UTC) the folder was not a repository. At 18:53–18:55 UTC, during this work and not by it, a repository was created here: one commit `a840ba7` "Baseline: live workspace application source (2026-10-02)" by kuaya1, remote `https://github.com/kuaya1/CryptoResearch.git`, `main` = `origin/main`. Its `.gitignore` is an allowlist (code, templates, docs, selected audit reports; records, logs, backups and `.cr/` excluded). `git status` is clean, which independently confirms the live code is unchanged. This folder is ignored by that allowlist (`/audits/*/*`), so nothing here is tracked unless you add it. Also during this work, someone ran doctor in the real folder (`.cr/doctor.probe`, 18:47 UTC); this work did not. | `git log`, `git status` (read only, `--no-optional-locks`) |
| "109 tests passed"? | That is the **original** code's suite. Round 1's own evidence shows 144/144 for the repaired code. Re-run here on Linux: original 108/109, round 1 143/144; the single failure is the same pre-existing, Linux-only test (below). | `evidence/baseline-suite-linux.txt`, `evidence/r1-suite-linux.txt` |

## Findings

| Finding | Verdict | Fixed here? |
|---|---|---|
| **F1** A paid answer existed only in memory until `recordOutcome` got the workspace lock | **Reproduced** on the round-1 code: lock held by a second process → `WORKSPACE_BUSY` after 20 s → the next run marked the attempt *uncertain*. One provider request, no report, no response file, the run counted at its reservation. | **Yes.** Same scenario on round 2: answer captured, saved by the next run, one request, one report, one actual-cost line. |
| **F2** Node's fetch ends long calls at 300 s while the research timeout is 600 s | **Confirmed** on the project's runtime (Node 24.21.0, bundled Undici 7.29.1): default fetch failed with `UND_ERR_HEADERS_TIMEOUT` at 301.0 s (headers delayed 320 s) and `UND_ERR_BODY_TIMEOUT` at 301.0 s (body stalled 320 s), with the caller's own signal at 600 s. That error is classified *uncertain* (probably billed, no answer). | **Yes.** Through the repaired dispatcher both calls answered at 320 s. |
| F3–F6 (review) | Not in this brief; unchanged. See `LIMITS.md`. | No |
| New, low: one existing test fails on Linux only | `ingest.test.js` "wrong provider folder … held back": Linux `copyFileSync` sets a new modification time and `inbox.js:325` turns `settle_seconds: 0` into 2 s (`|| 2`), so the second scan says *waiting*. Passes on all three code trees when copies keep their source time, as Windows does. Pre-existing; not changed. | No |

## What changed (round 2 over round 1)

9 files: 5 modified, 4 new. Full patch from the live code: 27 files (16 modified, 11 new); fingerprint scope 81 files.

- **`core/captures.js` (new).** The moment an answer (or provider error) arrives, it is written to `.cr/captures/<attempt_id>.json` **without the workspace lock**: temporary file, fsync, then a hard link into place (exclusive create where links are not allowed), then read back and checked. The file carries its run, project, provider, attempt number, attempt ID, prompt hash, evidence-packet hash, the answer text and its hash, usage, attested IDs and the raw response, sealed by a hash of the whole body.
- **`core/research.js`.**
  - `runOneJob` captures first, then commits. If the commit cannot run, the result is `captured` (saved by the next run) or, if the capture also failed, `unsaved` (held, never resent). Neither requeues the job.
  - `recordOutcome` applies only to an attempt still waiting for its outcome, so a capture recovered twice, or a commit rolled forward by another process, is applied and charged once. It records `capture_sha256`.
  - The capture is deleted only after a verified commit records that same hash. `sweepCaptures` clears captures whose commit already happened, plus stale temporary files, and reports pending and unmatched ones.
  - Recovery of a *dispatched* attempt looks for its capture first, binds it to the attempt, and commits it without a request. A damaged or mismatched capture is never imported: the attempt is held as *uncertain* and the file is kept.
  - Spending counts a pending capture at the larger of its reported cost and its reservation.
  - A provider is `api` only when the transport limits can be raised (F2).
- **`core/providers.js`.** Every paid call goes through Node's own bundled Undici `Agent`, created with `headersTimeout` and `bodyTimeout` equal to the research timeout + 30 s, so the research timeout ends a slow call. No dependency added. If this Node does not expose that Agent, the call is refused before sending (`config`, not sent).
- **`core/doctor.js`.** Warns about captured answers waiting to be saved, and about capture files that match no waiting attempt.
- **Tests.** `research-capture.test.js` (8 tests), `provider-transport.test.js` (4), `research-attempts.test.js` window 4 revised and window 4b added, `children/child-lock-holder.js` (new), `children/child-research-runner.js` (capture hooks).

Details, decisions and evidence per test: `RESULTS.md`.

## Tests

All runs: Node v24.21.0 (Undici 7.29.1, the version `package.json` pins), Linux VM on Eric's PC, temporary TEST workspaces, local stubs, network guard on.

| Run | Result | File |
|---|---|---|
| Round 2, full suite | **156/157**; the one failure is the Linux-only ingest test above | `evidence/r2-suite-run1-linux.txt` |
| Round 2, full suite, copies keep their source time (as on Windows) | **157/157** | `evidence/r2-suite-run2-linux-mtime-preserved.txt` |
| The ingest file alone on original, round 1, round 2 with source times kept | 9/9 on each | `evidence/ingest-linux-mtime-check.txt` |
| New and revised tests on the round-1 code | 13 fail, 8 pass | `evidence/red-new-tests-on-r1.txt`, `…-summary.txt` |
| F1 end-to-end reproduction | round 1: **answer lost**; round 2: preserved, saved once, no second request | `evidence/f1-repro-on-r1-patch.json`, `evidence/f1-repro-on-r2.json` |
| F2 long check (320 s delays, 600 s caller timeout) | default fetch fails at 301 s (headers and body); repaired dispatcher answers at 320 s | `evidence/f2-long-check-node24.json` |
| Captures across versions | original code leaves a pending capture alone and sends nothing; round 2 then saves it once. Round-1 code turns it *uncertain* (no request). | `evidence/rollback-capture-*.json` |

**Not run on Windows.** This session reaches only a Linux VM on your PC. Hard links, junctions, the Windows path rules and antivirus file locks are Windows behaviours; round 1's Windows run covered its own tests, not these. Running the suite on Windows is the first deployment step (`DEPLOY-CHECKLIST.md`).

## Readiness

| Use case | Ready? |
|---|---|
| Paid answer arrives while the lock is busy, writes are blocked, or the runner dies after it arrived | **Yes** (Linux-verified). Saved by the next run without a new request. |
| Runner dies between dispatch and capture, or capture and commit both fail | Held as **uncertain**, never resent: the documented window, now narrower. |
| Calls longer than 300 s | **Yes** up to the research timeout (verified at 320 s). |
| Everything else round 1 claimed | Unchanged; the Cowork review's coverage map still applies. |
| Deploying to the real folder | **Not done.** Blockers and steps: `DEPLOY-CHECKLIST.md`. |

## V2-007

It can follow deployment. It undercounts the free, keyless CoinGecko call counter only when a refresh needs more than one chunk (251+ tracked IDs or a smaller chunk size) and a later chunk fails. Your folder tracks 2 projects. It does not touch records, research spend or paid calls. Source: `../2026-10-01-codex-system-review-v2/FINDINGS.md`, V2-007.

## Files here

| File | What |
|---|---|
| `integrity-repair-r2.patch` | Live code → round 2. `git apply -p1` from the workspace root. Verified on a fresh copy of the live code: result fingerprint `59fef28a…` (81 files) = the tested tree. |
| `r2-delta-from-r1.patch` | Round 1 → round 2 only, for review. Verified the same way. |
| `RESULTS.md` | F1 and F2: reproduction, design, tests, evidence. |
| `LIMITS.md` | Everything still open, round 1's list updated. |
| `DOC-CHANGES-PROPOSED.md` | README / COWORK-INSTRUCTIONS / WORKSPACE-MAP wording, superseding round 1's file. |
| `DEPLOY-CHECKLIST.md` | Blockers, the Windows run, the stop procedure, rollback changes. |
| `RUNTIME-AND-COMMANDS.md` | Runtime and every command used. |
| `evidence/`, `tools/` | Outputs and the scripts that produced them. |
