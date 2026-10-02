# Review notes: round 2 on Windows

These are author-side notes by Claude, written while validating the release candidate. They are **not an independent review**, and the state "reviewed" is not claimed for anything.

**Scope.** `r2-delta-from-r1.patch`, focused on four areas:

- `core/captures.js`
- the once-only guard in `recordOutcome`
- recovery of dispatched attempts
- the Undici dispatcher

Also read: `runOneJob`, `runDueJobs`, `sweepCaptures`, `allCharges`, the `providerStatus` transport check, `doctor.js`, and round 2's tests and children.

**Line numbers.** Unless marked otherwise, line numbers are at `1cc9fee` (round 2 as applied). The fixes are at `665439b`.

## Findings and what happened to each

| ID | Where (`1cc9fee`) | Finding | Windows evidence | Status |
|---|---|---|---|---|
| R1 | `captures.js:118` | `NO_LINK` lacks `EISDIR`, which is how Node on Windows reports Win32 `ERROR_INVALID_FUNCTION` (verified here). That is the error commonly reported for hard links on FAT32 and exFAT. On such a volume `writeCapture` threw instead of falling back to exclusive create: no capture, and an answer that arrived while the lock was busy was lost, as before round 2. | `evidence/windows-errno-probe.json`; case L3 in `capture-adverse-rc-windows.json` (not saved, held uncertain, no second request) | **Fixed** in `242a098`: `captures.js:120` at `665439b`. Test: `research-capture.test.js:320`. |
| W1 | `captures.js:178–179`; consequences at `research.js:870`, `882–885`, `932` and `doctor.js:179` | On NTFS a file held with `FileShare.None` can still be hard-linked, but the read-back fails with `EBUSY`. `writeCapture` threw although the capture was in place. If the commit worked, no capture hash was recorded, the capture was never released, and doctor warned forever ("do not match … never imported automatically"). If the commit failed, the runner said "could not be captured" although the next run saved the answer from that capture. | S3: saved once, orphan capture, permanent warning. S4: "unsaved" message, then saved once. Both used a real PowerShell holder. | **Fixed** in `c9b75b8`: `captures.js:181–190` at `665439b`. When the read-back fails with `EBUSY` after this process placed the file, the capture counts with the hash of the bytes it wrote and fsynced (`unverified: true`). Every later use re-reads and checks it (`readCapture`/`bindCapture`, `removeCapture`). Test: `research-capture.test.js:345`. |
| W2 | `captures.js:192–197`; `research.js:894–895`, `1009–1010`, `1040–1050` | `readCapture` turned every read error into "cannot be read", and recovery treated the capture as unusable. If the capture file was still held exclusively during the next run, the attempt became *uncertain*. The answer stayed in `.cr/captures` but was never imported automatically (`reconcileAttempt`, `research.js:605`, does not import captures). | S7: not imported, held uncertain, capture kept, no second request | **Fixed** in `665439b`. `readCapture` returns the error code (`captures.js:209`). `commitCaptured` reports `EBUSY` as busy (`research.js:896`). `recoverJob` leaves the attempt dispatched and reports *captured* (`:1018`). `sweepCaptures` lists busy files separately (`:911–917`), and doctor reports them as in use, not unmatched (`doctor.js:179`). Test: `research-capture.test.js:374`. |
| W3 | Round 2's `DEPLOY-CHECKLIST.md`, blocker 1 | `git apply -p1 integrity-repair-r2.patch` in a non-repository copy under `%TEMP%`. This PC's system Git config (`C:/Program Files/Git/etc/gitconfig`) sets `core.autocrlf=true`. `git apply` outside a repository then writes CRLF into all 27 patched files, and the fingerprint reads `b17ce373…` instead of `59fef28a…`. The code still works (157/157), so only the fingerprint check catches it. | `evidence/rollback-drill-windows-run1-plain-git-apply-crlf.json`; `evidence/suite-plain-git-apply-crlf-copy-windows.txt` | Procedure note; no code change. Use `git -c core.autocrlf=false apply`, or apply inside the repository, where `.gitattributes` `* -text` prevents conversion. |
| W4 | Round 2's `DEPLOY-CHECKLIST.md` blocker 1, `RESULTS.md` ("Atomic appearance") and `README.md` (captures.js) | These say antivirus locks make the link fail with `EBUSY` and fall back to exclusive create. On NTFS the hard link succeeds under every share mode, so locks never trigger the fallback. Lock effects appear in three places instead. The temporary file's delete fails (harmless; swept after an hour). The read-back fails (W1). And releasing fails only when the final name itself is held (swept by the next run). Deleting a different link name succeeds under any share mode. | `evidence/windows-lock-probe.json`; cases S1, S2, S5, S6 | Documentation correction for Eric (live docs not changed) |

## Other observations (no change made)

| ID | Where (`1cc9fee`) | Observation |
|---|---|---|
| R2 | `captures.js:83`, with `research.js:1124`, `762` and `780` | Captures always record `dispatched_at: null`. `runOneJob` passes `adm.attempt`, which is returned before `markDispatched` sets `dispatched_at` on the stored attempt. `bindCapture` does not use the field, and the commit takes it from `run.json`. Cosmetic. |
| R3 | `captures.js:163–172` | A damaged file at the final name, plus a second capture for the same attempt, produces a kept conflict, and neither is imported. Reaching it needs a crash during the exclusive-create fallback (no hard links) *and* a second capture of the same attempt, which the once-only flow does not produce. Edge case. |
| R4 | `provider-transport.test.js` | The test "F2 with the repair, the research timeout is what ends a slow call" passes on `a840ba7` and on round 1 too, so it does not discriminate. The F2 regression is covered by the other three F2 tests and the 320 s long check. |
| R5 | `providers.js:101–125` | `transportFor` relies on Undici's internal `Symbol.for('undici.globalDispatcher.1')` and the global dispatcher's constructor name. It fails safe: `null` means the provider shows "not configured" (`research.js:212`) and nothing is sent (`providers.js:230–231`). Two side effects, neither relevant today because no proxy is configured: if a proxy ever becomes the global dispatcher (`NODE_USE_ENV_PROXY`, or `setGlobalDispatcher` with a proxy agent), paid research stops with "not configured"; and the Agent built here would bypass an environment proxy. The Node pin (24.21.0, Undici 7.29.1) keeps it stable: `transportFor`'s source hash on Windows equals round 2's documented copy (`6078d265…`). |
| R6 | `providers.js:103` | One Agent is cached per timeout value and never closed. The number is bounded by distinct timeouts, which is one in practice. |
| R7 | `research.js:285–330` | `allCharges` reads every capture on each spend calculation. A capture that cannot be read falls back to the reservation, which is conservative. |

## Checked and sound

1. **The once-only guard** (`research.js:829`, `838`). An attempt that is no longer *dispatched* (or an older in-progress record) is left unchanged, and the call returns `already` with the capture hash that was recorded. A capture recovered twice is therefore committed and charged once. The case where a lease is taken over (review F4) is documented in round 2's LIMITS item 13; no double commit is possible.
2. **Release ordering** (`research.js:882–885`). A capture is removed only after a verified commit that recorded the same hash, and only those exact bytes (`captures.js:224–239`). A crash at any point leaves either a pending capture, which the next run commits, or a committed one, which the sweep removes. Confirmed on Windows by L1, S2 and S5, by the F1 reproduction, and by the rollback drill.
3. **Recovery of dispatched attempts** (`recoverJob`, `research.js:972–1052`). The order is: an imported or answered attempt first; then a capture (`:1009`); then a saved response; then mock requeue; otherwise *uncertain*. Nothing is ever re-sent. A capture is bound to its run, project, provider, attempt number, attempt ID, prompt hash and evidence-packet hash before any commit (`captures.js:205–221`).
4. **`runOneJob`** (`research.js:1117–1146`). The order is capture (no lock), then commit, then release, then import. *captured* and *unsaved* are reported separately (`:1139–1140`). `runDueJobs` sweeps first (`:1233`) and counts *captured* as needing attention (`:1258`).
5. **The dispatcher** (`providers.js:107–125`, `230–231`). On this PC a fresh process gets the bundled Undici Agent. Calls through it answered at 320 s. Default fetch failed at 300.7 s, with both a headers timeout and a body timeout. `callProvider` end to end answered at 320 s (`evidence/f2-long-check-rc-windows.json`).
6. **Pending captures in spend** (`research.js:321–326`). They count at the larger of the captured usage cost and the reservation.

## Fix commits on `rc/integrity-r2`

| Commit | Change | Test (failed first) | Red evidence |
|---|---|---|---|
| `242a098` | R1: `EISDIR` joins `NO_LINK` | `F1 Windows: a volume without hard links that refuses the link with EISDIR …` | on `1cc9fee`: status "unsaved" |
| `c9b75b8` | W1: an `EBUSY` read-back after placement still counts | `F1 Windows: a capture held open without read sharing when it is read back …` | on `242a098`: no capture hash recorded |
| `665439b` | W2: a busy capture during recovery is retried; doctor reports it as in use | `F1 Windows: a pending capture that another program still holds during recovery …` | on `c9b75b8`: attempt held uncertain |

The red evidence uses the final test code on each previous commit (`evidence/red-fix-tests-final-code-windows.txt`). Per-step outputs are in `evidence/fix-*-red-before-fix.txt` and `evidence/fix-*-green-after-fix.txt`.

The tests simulate the Windows conditions inside the runner child (`tests/children/child-research-runner.js`, `fs.link_error` and `fs.capture_read_busy_while`), so they also run on Linux. The real-lock behavior on NTFS is shown by `tools/capture-adverse.cjs`, run against both `1cc9fee` and `665439b` with a PowerShell `FileShare` holder.

The fixes touch only `core/captures.js`, `core/research.js`, `core/doctor.js` and two test files. `providers.js`, `server.js` and `public/` are unchanged, so the F2 long check and the browser check were not repeated for `665439b`.
