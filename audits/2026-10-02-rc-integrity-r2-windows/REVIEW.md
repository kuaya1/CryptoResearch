# Review notes: round 2 on Windows

These are author-side notes by Claude, written while validating and preparing the release candidate. They are **not an independent review**, and the state "reviewed" is not claimed for anything.

**Scope.** `r2-delta-from-r1.patch`, focused on four areas:

- `core/captures.js`
- the once-only guard in `recordOutcome`
- recovery of dispatched attempts
- the Undici dispatcher

Also read: `runOneJob`, `runDueJobs`, `sweepCaptures`, `allCharges`, the `providerStatus` transport check, `doctor.js`, `ops.js` (`runOp`), `leases.js`, the import path in `inbox.js`, and round 2's tests and children.

**Line numbers.** The findings tables and "Checked and sound" cite `1cc9fee` (round 2 as applied) unless marked. The section "How capture and recovery work after the fixes", including its Windows test basis, cites `665439b`. The R8 fix (`10143c8`) adds 19 lines to `research.js` at the spend log (`ledger`, now `research.js:533–568`), so `research.js` lines after 549 move down by 19 at `10143c8`; no other file's lines move.

## Findings and what happened to each

| ID | Where (`1cc9fee`) | Finding | Windows evidence | Status |
|---|---|---|---|---|
| R1 | `captures.js:118` | `NO_LINK` lacks `EISDIR`, which is how Node on Windows reports Win32 `ERROR_INVALID_FUNCTION` (verified here). That is the error commonly reported for hard links on FAT32 and exFAT. On such a volume `writeCapture` threw instead of falling back to exclusive create: no capture, and an answer that arrived while the lock was busy was lost, as before round 2. | `evidence/windows-errno-probe.json`; case L3 in `capture-adverse-rc-windows.json` (not saved, held uncertain, no second request) | **Fixed** in `242a098`: `captures.js:120` at `665439b`. Test: `research-capture.test.js:320`. |
| W1 | `captures.js:178–179`; consequences at `research.js:870`, `882–885`, `932` and `doctor.js:179` | On NTFS a file held with `FileShare.None` can still be hard-linked, but the read-back fails with `EBUSY`. `writeCapture` threw although the capture was in place. If the commit worked, no capture hash was recorded, the capture was never released, and doctor warned forever ("do not match … never imported automatically"). If the commit failed, the runner said "could not be captured" although the next run saved the answer from that capture. | S3: saved once, orphan capture, permanent warning. S4: "unsaved" message, then saved once. Both used a real PowerShell holder. | **Fixed** in `c9b75b8`: `captures.js:181–190` at `665439b`. See "How capture and recovery work", item 1. Test: `research-capture.test.js:345`. |
| W2 | `captures.js:192–197`; `research.js:894–895`, `1009–1010`, `1040–1050` | `readCapture` turned every read error into "cannot be read", and recovery treated the capture as unusable. If the capture file was still held exclusively during the next run, the attempt became *uncertain*. The answer stayed in `.cr/captures` but was never imported automatically (`reconcileAttempt`, `research.js:605`, does not import captures). | S7: not imported, held uncertain, capture kept, no second request | **Fixed** in `665439b`. `readCapture` returns the error code (`captures.js:209`). `commitCaptured` reports `EBUSY` as busy (`research.js:896`). `recoverJob` leaves the attempt dispatched and reports *captured* (`:1018`). `sweepCaptures` lists busy files separately (`:914–917`), and doctor reports them as in use, not unmatched (`doctor.js:179`). See item 2. Test: `research-capture.test.js:374`. |
| W3 | Round 2's `DEPLOY-CHECKLIST.md` (local), blocker 1 | The step `git apply -p1 integrity-repair-r2.patch` runs in a non-repository copy under `%TEMP%`. This PC's system Git config (`C:/Program Files/Git/etc/gitconfig`) sets `core.autocrlf=true`, and `git apply` outside a repository then writes CRLF into all 27 patched files. The fingerprint reads `b17ce373…` instead of `59fef28a…`. The code still works (157/157), so only the fingerprint check catches it. | `evidence/rollback-drill-windows-run1-plain-git-apply-crlf.json`; `evidence/suite-plain-git-apply-crlf-copy-windows.txt` | **Corrected** in README, "Deployment instructions (current)", step 4: deploy inside the repository, or `git -c core.autocrlf=false apply`. Round 2's checklist is superseded and kept unchanged. |
| W4 | Round 2's `DEPLOY-CHECKLIST.md` (local), line 7 (blocker 1) | The checklist says running the suite on Windows covers "antivirus locks (`EBUSY` falls back to exclusive create)". On NTFS the hard link succeeds under every share mode, so a lock never triggers the fallback. Lock effects appear in three places instead: the delete of the temporary file (harmless; swept after an hour), the read-back (W1), and the release, but only when the final name itself is held (swept by the next run). Deleting a different link name of the file succeeds under any share mode. Round 2's README and RESULTS say only that the fallback is used "where links are not allowed", which is accurate. `EBUSY` in `NO_LINK` (`captures.js:118`) reflects the same assumption; it is harmless, because on NTFS the link does not fail with `EBUSY`. | `evidence/windows-lock-probe.json`; cases S1, S2, S5, S6 | **Corrected** in README, "What the Windows checks showed about captures under locks". Round 2's checklist is kept unchanged. |

## Other observations (no change made, except R8)

| ID | Where | Observation |
|---|---|---|
| R2 | `captures.js:83`, with `research.js:1124`, `762` and `780` (`1cc9fee`) | Captures always record `dispatched_at: null`. `runOneJob` passes `adm.attempt`, which is returned before `markDispatched` sets `dispatched_at` on the stored attempt. `bindCapture` does not use the field, and the commit takes it from `run.json`. Cosmetic. |
| R3 | `captures.js:163–172` (`1cc9fee`) | A damaged file at the final name, plus a second capture for the same attempt, produces a kept conflict, and neither is imported. Reaching it needs a crash during the exclusive-create fallback (no hard links) *and* a second capture of the same attempt, which the once-only flow does not produce. Edge case. |
| R4 | `provider-transport.test.js` | The test "F2 with the repair, the research timeout is what ends a slow call" passes on `a840ba7` and on round 1 too, so it does not discriminate. The F2 regression is covered by the other three F2 tests and the 320 s long check. |
| R5 | `providers.js:101–125` | `transportFor` relies on Undici's internal `Symbol.for('undici.globalDispatcher.1')` and the global dispatcher's constructor name. It fails safe: `null` means the provider shows "not configured" (`research.js:212`) and nothing is sent (`providers.js:230–231`). Two side effects, neither relevant today because no proxy is configured: if a proxy ever becomes the global dispatcher (`NODE_USE_ENV_PROXY`, or `setGlobalDispatcher` with a proxy agent), paid research stops with "not configured"; and the Agent built here would bypass an environment proxy. The Node pin (24.21.0, Undici 7.29.1) keeps it stable: `transportFor`'s source hash on Windows equals round 2's documented copy (`6078d265…`). |
| R6 | `providers.js:103` | One Agent is cached per timeout value and never closed. The number is bounded by distinct timeouts, which is one in practice. |
| R7 | `research.js:285–337` | `allCharges` reads every capture on each spend calculation. A capture that cannot be read falls back to the reservation, which is conservative. |
| R8 | `research.js:533–549` (`ledger`), with `ops.js:672–675` and `714–719` (`665439b`) | **Fixed in `10143c8`** (see "Fix commits"); a failure-injection test reproduced it first. As found: cost lines are appended to `logs/research-spend.jsonl` during an operation's build step, outside its atomic commit. The code comment says: "a failed commit can only overcount". A busy lock or blocked writes fail before the build step (`ops.js:672–675`), so the F1 paths tested here add exactly one actual line. A commit that fails *after* its build step can leave an actual line for an outcome that a later run commits again from the capture: two actual lines for one attempt. Examples are a generation marker that cannot be replaced (`ops.js:714–719`), an interrupted apply, or an unverified commit. Spend totals count per attempt, so the total is not doubled: `allCharges` reads `run.json` first, then ledger lines keyed by run, provider and attempt, with a later line replacing an earlier one (`research.js:295–298`, `317`, `333`). The raw ledger file would still show both lines. The ledger design is round 1's; round 2's capture adds the second-commit path. Not tested. |

## Checked and sound

1. **The once-only guard** (`research.js:829`, `838`). An attempt that is no longer *dispatched* (or an older in-progress record) is left unchanged, and the call returns `already` with the capture hash that was recorded. A capture recovered twice is therefore committed and charged once. The case where a lease is taken over (review F4) is documented in round 2's LIMITS item 13; no double commit is possible.
2. **Release ordering** (`research.js:882–885`). A capture is removed only after a verified commit that recorded the same hash, and only those exact bytes (`captures.js:224–239`). A crash at any point leaves either a pending capture, which the next run commits, or a committed one, which the sweep removes. Confirmed on Windows by L1, S2 and S5, by the F1 reproduction, and by the rollback drill.
3. **Recovery of dispatched attempts** (`recoverJob`, `research.js:972–1052`). The order is: an imported or answered attempt first; then a capture (`:1009`); then a saved response; then mock requeue; otherwise *uncertain*. Nothing is ever re-sent. A capture is bound to its run, project, provider, attempt number, attempt ID, prompt hash and evidence-packet hash before any commit (`captures.js:205–221`).
4. **`runOneJob`** (`research.js:1117–1146`). The order is capture (no lock), then commit, then release, then import. *captured* and *unsaved* are reported separately (`:1139–1140`). `runDueJobs` sweeps first (`:1233`) and counts *captured* as needing attention (`:1258`).
5. **The dispatcher** (`providers.js:107–125`, `230–231`). On this PC a fresh process gets the bundled Undici Agent. Calls through it answered at 320 s. Default fetch failed at 300.7 s, with both a headers timeout and a body timeout. `callProvider` end to end answered at 320 s (`evidence/f2-long-check-rc-windows.json`).
6. **Pending captures in spend** (`research.js:321–326`). They count at the larger of the captured usage cost and the reservation.

## How capture and recovery work after the fixes

Line numbers in this section are at `665439b`.

### 1. What makes a capture durable when its read-back is blocked

1. **The bytes are flushed before any name points at them.** `writeCapture` encodes the capture as `{ schema_version, body_sha256, body }` (`captures.js:92–95`). The body includes a hash of the answer text. `writeDurable` writes it to a temporary file named `.<attempt_id>.tmp-<pid>-<random>`, then calls `fsyncSync` (`FlushFileBuffers` on Windows) and closes it (`captures.js:135`; `fsx.js:37–46`).
2. **The file is placed under its final name, `<attempt_id>.json`, in one of two ways:**
   - `fs.linkSync(tmp, final)` adds a second name for the same, already flushed file (`captures.js:140–141`). A link fails if the name exists, so another writer's capture is never replaced.
   - Where the volume refuses hard links (`NO_LINK`, `captures.js:120`), the final name is created exclusively (`'wx'`), and the same bytes are written and fsynced there (`captures.js:146–165`).

   Either way `placed` becomes true only after that step succeeded.
3. **The bytes are checked by reading them back** (`captures.js:181–192`). If the read-back fails with `EBUSY` *after* placement, another program has the file open without sharing reads. The capture then still counts: `writeCapture` returns the hash of the bytes this process wrote and flushed (`want`), with `unverified: true` (`captures.js:189`). Any other read error, or a mismatch, still means "not captured".
4. **What is deferred, not skipped:** the comparison of the bytes on disk with the bytes written, which would catch storage-level corruption. Every later use reads the file again and checks it before acting:
   - **Commit from the capture:** `readCapture` → `decode` checks the body hash and the text hash (`captures.js:98–109`); `bindCapture` checks the run, project, provider, attempt number, attempt ID, prompt hash and evidence-packet hash (`captures.js:218–234`). A damaged or mismatched capture is never imported: the attempt is held uncertain and the file is kept for inspection.
   - **Removal:** `removeCapture` deletes only when the file's hash equals the expected one (`captures.js:237–252`). The sweep removes a capture only when `run.json` recorded that same hash (`research.js:934–935`).
5. **If the same run's commit succeeds,** the answer is already safe in the records (`run.json` and `responses/`, written by a verified commit). The capture is then only a handoff waiting to be removed. The unverified capture matters only when the commit fails.
6. **Not established, on either path:** that the new *name* survives a power loss right after placement. `fsyncDir` cannot flush a directory on Windows and is a no-op there (`captures.js:111–116`). NTFS journals the name creation as metadata. A successful read-back would not change that. Power loss was not tested.

### 2. A capture that is temporarily locked stays pending and is saved later

1. **When the commit fails but a capture exists** (verified or not), `runOneJob` reports *captured* (`research.js:1147`). The attempt stays *dispatched* and the job stays *dispatching*, because nothing was committed. `runDueJobs` counts it as needing attention (`:1266`).
2. **The next research run picks it up.** That run comes from the open dashboard, the hourly task or `node dashboard/cli.js research run`. In-flight jobs are due (`isDueJob`, `:686–688`). `runOneJob` takes the job's lease (`:1066`) and sends the in-flight job to `recoverJob` (`:1072`), which tries the capture first (`:1016`):
   - **Still held open:** `readCapture` fails with `EBUSY`, and `commitCaptured` returns `busy` (`:896`). `recoverJob` reports *captured* again and leaves the attempt unchanged (`:1018`), so the following run tries again.
   - **Readable:** the capture is decoded and bound, then committed by `recordOutcome` (`:900`), which is a verified commit applied only while the attempt awaits its outcome. It is released only if that commit recorded the same hash (`:901`, `882–885`), and imported as a report (`importSaved`).
   - **Damaged or mismatched:** the attempt is held uncertain, `unmatched_capture_path` is set, and the file is kept (`:1055`).
3. **What doctor shows meanwhile** (`doctor.js:178–180`):
   - a readable pending capture: "captured … not saved into the records yet"
   - a capture open in another program: "open in another program … the next research run tries again"
   - a damaged or mismatched capture: "do not match … kept for inspection"
4. **Spend meanwhile.** A pending capture counts at the larger of its reported usage cost and the reservation while it can be read (`research.js:292`, `321–326`). It counts at the reservation while it cannot.
5. **Nothing is sent to the provider at any point** in this path.

### 3. How recovery prevents duplicate provider requests, reports and cost lines

**Provider requests**

- **Admission.** An attempt is admitted only for a *queued* job, inside a locked operation that also records its reservation (`research.js:725`, `761`).
- **One runner per job.** The job's lease (`leases.js:47–80`; `research-<run>-<provider>`, valid for the research timeout plus 60 s) is created exclusively. On the same PC a lease is free only when its process is dead; on another PC, only after it expires (`leases.js:65–66`). A takeover across PCs is round 2's LIMITS item 13.
- **The dispatch marker comes first.** `markDispatched` commits *dispatched* before `callProvider` runs (`research.js:768–784`, `1104`, `1111`). A runner that stops before the marker leaves *reserved*, which recovery releases as not sent and requeues (`:1004–1013`); that attempt provably never left the PC. After the marker, an attempt is never sent again automatically.
- **Recovery never calls a provider.** `recoverJob` (`:979–1060`) resolves a dispatched attempt from its capture, then from a saved response, otherwise as *uncertain*. Uncertain jobs are not due (`:686–688`), so only an explicit Retry or Reconcile by Eric changes them.

**Reports**

- **One outcome per attempt.** `recordOutcome` commits an outcome only while the attempt awaits it (`research.js:829`, `838`). It never writes over an existing response file (`:867`).
- **No duplicate import.** `importSaved` checks the saved response against its attempt (`:1170`), then imports through `inbox.importContent` (`:1187`). An answer that is already in the records is recognized by its byte hash or its normalized text hash, and is not stored again (`inbox.js:43–55`, `177–187`). The job then links the existing report and completes once (`research.js:1198–1209`).
- **Captures cannot add a second report.** A second capture of the same attempt with the same body is a no-op; a different body is a kept conflict, never imported automatically (`captures.js:166–177`).

**Cost lines**

- **One reservation line**, written at admission (`research.js:761`).
- **One actual line,** written by `applyOutcome` (`:821`) inside `recordOutcome`, which runs only while the attempt awaits its outcome. A recovered capture for an attempt that was already committed adds nothing. The F1 tests assert exactly one actual line in every tested path.
- **Once per attempt even when a save fails after its build step** (R8 fix, `10143c8`, `research.js:533–568`): `ledger` reads the attempt's earlier lines and skips a second reservation, release or actual line for the same run, provider, attempt number and attempt ID. A later actual cost that differs from the recorded one is written as an explicit `adjustment` line with `replaces_actual_usd`; reconciliation lines are unaffected. Prices are frozen on the attempt at reservation (`actualCostUsd`, `research.js:252–265`), so re-saving the same outcome gives the same cost; an adjustment arises only for older records priced at current settings.
- **Totals count each attempt once,** from `run.json` first and then the ledger keyed per attempt (`:285–337`).
- **Residual after the fix:** a save that fails after its build step still leaves its line written (the log stays outside the atomic commit); the retried save then adds nothing for the same amount. Before the fix this left two actual lines (reproduced: `2 !== 1`).

### 4. Windows test basis

| Check | Real on this PC | Simulated | Evidence (local) |
|---|---|---|---|
| NTFS lock probe | A PowerShell process holds a file under each `FileShare` mode, and Node links, reads and deletes it | — | `windows-lock-probe.json` |
| errno probe | Win32 error 1 from reading a directory handle surfaces as `EISDIR` | — (FAT itself not observed) | `windows-errno-probe.json` |
| Capture cases S1–S7 | Runner processes, a process holding the workspace lock, a PowerShell holder on the temporary or the final capture name (`Read`, `ReadWrite`, `None`), the stub provider over loopback | A hook pauses the runner at the link until the holder has opened the file, which forces the timing; it does not change file-system behavior | `capture-adverse-rc-windows.json`, `capture-adverse-rc-665439b-windows.json` |
| Capture cases L1–L3 | Runner processes, the exclusive-create fallback, the workspace-lock holder | The link failure itself: `fs.linkSync` throws `EPERM`, `ENOTSUP` or `EISDIR` in the runner | same files |
| Repository tests (`research-capture.test.js`) | Runner processes, the lock-holder process, the blocked-writes file, the stub provider | The 3 Windows tests: link errors (`fs.link_error`) and `EBUSY` reads (`fs.capture_read_busy_while`) in the runner child, plus an in-process `EBUSY` read for the doctor check. They run on any OS. | `suite-rc-665439b-windows-run*.txt`, `fix-*-red-before-fix.txt` |
| F1 reproduction | The workspace lock held by another process while the answer arrives | — | `f1-repro-rc-*.json` |
| Restore tests | A real NTFS junction (`fs.symlinkSync(…, 'junction')`) | Hostile path forms are validation inputs; they are not created on disk | `integrity-restore-ntfs-windows.txt` |
| Rollback drill | `robocopy`, the real recovery copy and its `verify-fingerprint.cjs`, `git apply`, the CLI of each code version | Providers are a local stub; the hourly task's command was run directly | `rollback-drill-*.json` |
| F2 long check | Undici's real timers, waiting 320 s | The provider is a local stub | `f2-long-check-rc-windows.json` |
| Browser check | Chromium 152 in the Claude desktop pane, 8 + 7 tabs | Visibility forced by overriding `document.hidden` | `browser-*.json` |

**File-system assumptions that were not tested:**

- That `CreateHardLinkW` on FAT32 or exFAT fails with `ERROR_INVALID_FUNCTION` (`EISDIR` in Node). This is commonly reported, but no such volume was available without administrator rights.
- Network shares (SMB), ReFS or Dev Drive volumes, and OneDrive placeholders.
- Power loss right after placement (see item 1.6).
- Windows Defender's real scanning. It was never seen holding a capture; the holds were synthetic.
- `EPERM` from a file with a pending delete, and other non-`EBUSY` read errors. Recovery treats these as unusable: the attempt is held uncertain and the file kept.
- A capture held open for longer than two runs. It stays pending and is retried every run, with no limit.
- Other Windows builds, and Node versions other than the pinned 24.21.0.

## Fix commits on `rc/integrity-r2`

| Commit | Change | Test (failed first) | Red evidence |
|---|---|---|---|
| `242a0984a7735ac9f929044adb3b817c840c6882` | R1: `EISDIR` joins `NO_LINK` | `F1 Windows: a volume without hard links that refuses the link with EISDIR …` | on `1cc9fee`: status "unsaved" |
| `c9b75b80b53e7b416cb30e64ee713b79e8126e2c` | W1: an `EBUSY` read-back after placement still counts | `F1 Windows: a capture held open without read sharing when it is read back …` | on `242a098`: no capture hash recorded |
| `665439b494a7486f6037688e7a727dcbb00fbaf0` | W2: a busy capture during recovery is retried; doctor reports it as in use | `F1 Windows: a pending capture that another program still holds during recovery …` | on `c9b75b8`: attempt held uncertain |
| `10143c8a200257008adc06832119a38a76579524` | R8: spend-log lines once per attempt; a differing later cost is an explicit adjustment | `F1 spend log: an outcome whose save fails after the cost line is written …` and `F1 spend log: a later save of the same outcome keeps the cost frozen …` (`research-capture.test.js:406`, `424`; injection `crash.when: 'fail_after_build'` in the runner child) | on `33e7230`: 2 actual lines for one attempt (`2 !== 1`) |

The red evidence uses the final test code on each previous commit (`evidence/red-fix-tests-final-code-windows.txt`; for R8, `evidence/fix-D-red-final-tests-on-33e7230.txt`). Per-step outputs are in `evidence/fix-*-red-before-fix.txt` and `evidence/fix-*-green-after-fix.txt`.

The fixes touch only `core/captures.js`, `core/research.js`, `core/doctor.js` and two test files. `providers.js`, `server.js` and `public/` are unchanged, so the F2 long check and the browser check were not repeated for `665439b`.

## Questions for the independent reviewer

1. **W1.** Is it acceptable to count a capture that was placed but could not be read back (`EBUSY`), given that every later use re-checks its hash? The alternative is a short bounded retry of the read-back before returning `unverified`.
2. **W2.** Should a capture that stays unreadable (`EBUSY`) for many runs eventually turn the attempt *uncertain*, for example after a number of runs or hours? Today it is retried every run with no limit; it counts at its reservation, and doctor says it is open in another program.
3. **W2 scope.** Only `EBUSY` is treated as temporary. Should `EPERM` or `EACCES` (for example a file with a pending delete) also be retried rather than held uncertain?
4. **R8 (fixed by deduplication).** Is recording once per attempt, with an explicit `adjustment` line for a differing later cost, the right form? The alternative is moving spend-log lines into the atomic commit. Note that `ledger` now reads the whole spend log before each append; the file is small today, but it grows with every paid attempt.
5. **R1.** Should `NO_LINK` become "any link error except `EEXIST` falls back to exclusive create", rather than a list that can miss a code? The exclusive create fails loudly by itself where the folder is not writable.
6. **R5.** Is relying on Undici's internal global-dispatcher symbol acceptable with Node pinned to 24.21.0, given that it fails safe?
7. **Durability (item 1.6).** Is NTFS metadata journaling enough for the capture's name, or should the capture also be flushed through a handle to the final name after placement?
