# Results: F1 and F2

"Round 1" is the code produced by `../2026-10-02-claude-integrity-repair/integrity-repair.patch` (fingerprint `4ce11b80…`). "Round 2" is this folder's patch (`59fef28a…`). Runtime for everything: Node v24.21.0 with bundled Undici 7.29.1.

## F1 — a paid answer could be lost when the commit could not take the lock

### Reproduction on round 1

`tools/f1-repro.cjs` builds a TEST workspace with one paid Claude job, a local stub provider and a real runner process. When the request arrives, the stub starts a second real process that takes the workspace lock the normal way (`withLock`), as a long backup, export or package does. Only then does the stub answer. After the first runner finishes, the lock is released and two more runners run. (`evidence/f1-repro-on-r1-patch.json`)

| Step | Round 1 |
|---|---|
| First runner | waited 20.3 s, then `WORKSPACE_BUSY` ("Nothing was saved"). Attempt left `dispatched`. No capture. |
| Second runner | recovery: no saved answer → **uncertain**, with the reason "The runner stopped…" (it had not stopped; the lock was busy). |
| Final | 1 provider request, 0 reports, no response file, 0 actual-cost lines, run counted at its reservation ($0.2507). **The answer the provider returned is gone.** |

The same path is reached without any contention when writes are blocked by an earlier unverified commit (`.cr/blocked.json`), and by any other commit failure (disk full, generation marker not writable).

### Design

The answer is made durable before anything else, in a place that needs no lock, and the lock-protected commit stays the only way into the records.

- **Where:** `.cr/captures/<attempt_id>.json`. `.cr` already holds the write path's internals (lock, staging, quarantine). The records stay single-writer: a capture is a handoff, not a record. It is not in backups or packages, and doctor warns while one waits.
- **Atomic appearance:** bytes go to `.<attempt_id>.tmp-<pid>-<rand>`, fsynced, then hard-linked to the final name. A link fails if the name exists, so two writers cannot both place a file. Where links are not allowed, the final file is created with `wx` (exclusive). A crash during that fallback can leave a partial final file; the body hash refuses it. Temporary files are never read and are cleared after an hour.
- **Concurrent writers:** in practice only the holder of the job's research lease writes an attempt's capture. Even so, a second write of the same body (only the capture time or process differs) is a no-op returning `already`; a different body is `CAPTURE_CONFLICT`, and the second copy is kept as `conflict-<id>-<rand>.json`. Nothing is replaced.
- **Binding:** recovery accepts a capture only if run, project, provider, attempt number, attempt ID, prompt hash and evidence-packet hash all match the waiting attempt, and the body hash and text hash verify.
- **Exactly once:** `recordOutcome` applies only while the attempt is still waiting (`dispatched`, or an older attempt with no phase and no finish time). Otherwise it changes nothing and returns `already`. The ledger line and the response file are written only inside that guarded build. So a capture recovered twice, a second runner, or a commit another process rolls forward cannot double the report, the file or the cost.
- **Retention:** the capture is deleted only when the commit is verified and `run.json` records the same `capture_sha256` (`releaseCapture`), or later by `sweepCaptures` on the same evidence.
- **Capture failure:** logged to `logs/operations.jsonl` (best effort), recorded on the attempt as `capture_error` if the commit succeeds. If both fail, the runner returns `unsaved` with both reasons and the run status is `attention`. The job is not requeued; recovery holds it as *uncertain*.
- **The uncertain window is kept:** dispatch marker written → request → answer → **capture**. A crash or failure before the capture still cannot tell "never left" from "billed", and is held as uncertain, never resent.
- **Spending while pending:** `allCharges` counts a pending capture at max(reported cost, reservation).

### Tests (`dashboard/tests/research-capture.test.js`, real processes)

| Test | Round 2 | Round 1 |
|---|---|---|
| Lock contention: a second process holds the lock when the answer arrives | first runner: `captured` after the 20 s wait; next runner saves it; 1 request, 1 report, 1 actual line, spend = actual $0.101, capture removed; two more runners change nothing | `error` (busy), then *uncertain*: answer lost |
| Writes blocked when the answer arrives | `captured`; a runner while still blocked sends nothing; after unblocking, saved once | answer lost |
| Restart after capture, before commit (killed) | saved once on restart; two further restarts are no-ops | fails (no capture exists) |
| Killed after the commit, before the capture was removed | leftover capture cleared; imported once | fails |
| Capture write fails, commit works | saved normally; `capture_error` recorded | fails (no capture step) |
| Capture write fails and commit cannot run | `unsaved`, honest message, status `attention`, not requeued; after unblocking: *uncertain*, 1 request, counted at reservation | fails |
| Damaged (truncated) or mismatched (other prompt hash) capture | never imported; *uncertain*; `unmatched_capture_path` set; file kept; doctor warns | fails |
| Capture files: hidden temps ignored, 4 concurrent writer processes of one answer → one file, one placer; different answer → conflict kept; binding checks; bad attempt ID refused; stale temp cleared | pass | fails (no module) |

Revised existing test, `research-attempts.test.js`:
- **Window 4** used to be "killed after the answer arrived, before it was saved → uncertain". With the capture in between, that point is now "after the capture": the answer is saved on restart, 1 request. This is the intended change.
- **Window 4b (new)** keeps the old property at the new boundary: killed after the answer arrived, before the capture → uncertain, 1 request after two restarts. (On round 1 the capture hook does not exist, so that runner simply completes; its failure there is not meaningful.)

Note on the red run: some round-1 failures only show that the new functions are missing. The behavioural evidence is `f1-repro-on-r1-patch.json` and the lock-contention test's message: `got {"status":"error","error":"The workspace is busy…"}`.

### Across versions (`tools/rollback-capture.cjs`)

A capture left by round 2 (runner killed after the capture):

| Then | Result |
|---|---|
| Original code `research run` | "No research jobs waiting". Nothing sent, nothing changed. Round 2 afterwards: saved once, 1 request. (`evidence/rollback-capture-original-only.json`) |
| Round-1 code `research run` | marks the attempt *uncertain* (no request). Round 2 then leaves it: the capture is reported by doctor as unmatched and kept, never imported. (`evidence/rollback-capture-crossversion.json`) |

Round 1 was never deployed, so the second row matters only if someone deploys round 1's patch on top of round 2's records.

## F2 — the transport ended long calls before the research timeout

### Facts

- Node v24.21.0 bundles Undici 7.29.1 (`process.versions.undici`).
- Undici documents `headersTimeout` and `bodyTimeout` defaults of `300e3` ms: time to receive the complete headers, and time between body chunks. Node's global fetch uses a default `Agent` created with no options (`Symbol(options)` = `{"maxOrigins":null}`), so those defaults apply.
- The provider adapters made non-streaming calls with only `AbortSignal.timeout(timeout_seconds × 1000)`, default 600 s. A non-streaming answer sends its headers only when the whole report is written.

### Long check (`tools/long-check.cjs`, `evidence/f2-long-check-node24.json`)

Four concurrent calls to a local stub, caller signal 600 s, delay 320 s:

| Case | Result |
|---|---|
| A default fetch, headers delayed | `UND_ERR_HEADERS_TIMEOUT` at **301.0 s** |
| B repaired dispatcher, headers delayed | answered at 320.0 s |
| C default fetch, body stalled after the first chunk | `UND_ERR_BODY_TIMEOUT` at **301.0 s** |
| D repaired dispatcher, body stalled | answered at 320.1 s |

`transportFor` in that script is byte-identical to round 2's `providers.js` (function source SHA-256 `6078d265…`, checked against the patched file).

Why a 300 s+ check is still needed: the suite cannot shorten Node's *default* without replacing it, which would no longer test the default. The short tests below prove the mechanism and the repair; only the long check proves the 300 s figure on this runtime. It is not in the suite (it takes 5.5 minutes) and was run once, outside it.

### Consequence before the repair

`UND_ERR_HEADERS_TIMEOUT` is neither a "not sent" code nor an HTTP answer, so `outcomePhase` gives *uncertain*: probably billed, no answer, not resent. Every paid call slower than 5 minutes would have ended that way.

### Repair (smallest that fits the no-dependency rule)

- `providers.transportFor(timeoutMs)` takes the constructor of Node's own global dispatcher (`globalThis[Symbol.for('undici.globalDispatcher.1')]`, initialised without network by building a `Request`), checks it is `Agent`, and creates one with `headersTimeout = bodyTimeout = timeout + 30 s`. One Agent per timeout value, reused.
- `callProvider` requires a research timeout and passes that dispatcher to fetch. If none can be made, it throws `config` ("not sent") before anything is sent. `providerStatus` then reports the provider as not configured, so nothing is dispatched.
- Uncertain-outcome handling is unchanged: a timeout, abort or transport error after dispatch is still *uncertain*.

Alternatives not taken: the `undici` npm package (adds a dependency); streaming responses (larger change to all three adapters); `node:https` (bypasses the test network guard and the injected stubs).

### Tests (`dashboard/tests/provider-transport.test.js`, real fetch, local stub)

| Test | Result |
|---|---|
| A shorter `headersTimeout` (0.3 s) ends a call before the caller's 10 s limit, as `network` / `UND_ERR_HEADERS_TIMEOUT`, not "not sent" | pass (~1.0 s) |
| Every paid call passes a dispatcher whose limits are research timeout + 30 s | pass |
| With the repair, the research timeout (0.8 s) is what ends a slow call: kind `timeout` | pass |
| No research timeout → `config`, nothing sent | pass |
