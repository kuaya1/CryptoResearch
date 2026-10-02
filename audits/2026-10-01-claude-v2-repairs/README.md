# V2 repairs: integrity, budget and lifecycle

Prepared October 1, 2026 (America/New_York), in an isolated development copy. **Not deployed.** The real workspace's code, records, settings, task, queue and dashboard were not changed. The only addition is this folder.

This record answers the bounded brief in `audits/2026-10-01-codex-system-review-v2/NEXT-IMPLEMENTATION-PROMPT.md`: actions 1–5 (V2-001 to V2-006). V2-007, which undercounts market calls in later chunks, was not addressed.

## Starting point

- **Start state matched the audit.** The live real root's 70 audited files hashed to `9ff79de7f31aaf92c92822c1e092782c7a49493b84292ad38840516a86087fd0`, the audited fingerprint, so the findings applied unchanged and no reconciliation was needed.
- **Instructions followed.** I read the workspace instructions (COWORK-INSTRUCTIONS.md, CLAUDE.md) and the four audit documents first.
- **Isolated copy.** The work was done in an isolated copy on this PC's Cowork Linux VM, outside the workspace. Nothing was uploaded.
  - Test workspaces were `kind: test` temp folders.
  - The browser workspace was the fictional `kind: demo` workspace (`ws_n7587g3f4x`).
  - Servers used loopback ports 4931–4953 and a write-protected baseline copy.
  - No real provider configuration was used. There were no paid calls and no network calls to model providers: every provider was a local stub.

## Readiness by use case

| Use case | v2 audit verdict | After this patch (local evidence) | Still needed |
|---|---|---|---|
| Daily watchlist and manual research | Conditionally usable | Reads never mix generations at production defaults (V2-001). Nine visible windows load and work; the unmodified code stalls the 7th (V2-006). Drafts, focus, reading position and frozen sort survive live updates. | Run the suite on the Windows PC. Do a short live session on the real dashboard after deploying. |
| Authoritative portfolio | Not ready | Both integrity blockers are repaired in tested cases: coherent reads (V2-001) and restore paths checked before any write (V2-002). Portfolio arithmetic was not changed. | The owner decides once the Windows run passes. The Windows-native restore escape was not re-run on Windows (see limits). |
| Cowork intake | File and CLI contract verified; live acceptance outstanding | Unchanged (not in scope). New CLI commands: `research recover`, `research reconcile`, `retry --accept-uncertain`. | Live Cowork acceptance |
| Unattended multi-model research | Not ready | Replay, aggregate budget, zero-search and search-cap defects are fixed against local stubs. | **Still not ready for unattended paid use.** Under the default policy only Claude or ChatGPT with search off qualify (see action 4). Real keys, models, prices and budgets are unset. A live paid acceptance session is separate from these stubs. |

## What changed

### 1. Coherent reads at production defaults (V2-001)

`ops.readConsistent` no longer falls back to an unchecked read.

- **Retry budget.** It keeps the production budget: 8 attempts, about 1.1 s. It then returns data from one verified generation, or throws `READ_BUSY`. The error carries a reason: `commit_in_progress`, `records_changing`, `recovery_needed` or `marker_invalid`.
- **Stuck markers.** An "applying" marker is never read through, however old. An unreadable marker is never treated as stable.
- **Dead writers.** When no live writer holds the lock, the reader reports `recovery_needed` at once instead of waiting.
- **Recovery.** `recover()` now also repairs a stuck or unreadable marker when nothing sealed is pending. A recovery that fails is quarantined and blocks writes, as before, but it also leaves a terminal marker so readers are not stuck forever. Every read then reports `integrity.status: "unverified"`.
- **Index and project detail.** Both carry `integrity` (generation, verified or unverified, writes-blocked details).
- **Server.** On `READ_BUSY` the server keeps serving its previous verified index, with `snapshot.status: "previous_snapshot"` and the reason. It retries with backoff (0.5–8 s) and completes an interrupted commit itself.
  - Uncached reads answer `503 READ_BUSY` with `Retry-After`. This covers project detail, ledger and change digest; the ledger and digest are now coherent reads too.
  - Lock waits by the server are capped at 3 s (`ws.lockWaitCapMs`), so another process's long write cannot freeze every page. **Behavior change:** a dashboard save attempted while another process holds the lock for more than 3 s now says "busy, nothing saved" sooner than before (20–60 s).
- **CLI and scheduled task.** These wait up to 10 s (`ws.readPolicy`), completing interrupted commits, before reporting busy.
- **Exports.** `export.json`, every CSV table, `csvTable`, the package and backups each come from one locked, recovered snapshot and carry `integrity`. Before, `exportAll` built its CSVs from a second, unlocked read.

Tests are in `v2-reads.test.js` (7). They cover:

- a writer held between its two renames beyond the default window: `READ_BUSY` after about 1.1 s, never `[new, old]`; then a complete new generation;
- a writer that died between renames;
- an invalid marker, including with a live lock holder;
- a failed recovery with quarantine evidence and unverified labels;
- the server snapshot, 503 and catch-up path;
- a server started after an interrupted commit;
- exports during a held writer and after an interrupted one.

On the baseline code, the first test returns `["new","old"]`.

### 2. Restore paths checked before any copy (V2-002)

- **Path rule.** New `workspace.portableRel` applies the same rule on every OS. It rejects:
  - `..` and `.` segments, with `\` treated as a separator;
  - rooted, UNC, drive and drive-relative paths;
  - NUL and control characters;
  - `<>:"|?*` (which also covers stream syntax);
  - segments ending in a dot or space;
  - Windows device names;
  - non-NFC text.
- **Containment.** `containedPath` resolves every path inside its root and proves containment with both POSIX and Win32 semantics.
- **Preflight.** `preflightEntries` runs before anything is created or written. It checks every package and backup entry against the areas that kind of file may contain, case-insensitive duplicates, file-versus-folder conflicts, hashes and byte counts (packages) and destination containment.
- **Backup sources.** Backup source files must be regular files that resolve inside `<backup>/files`. Links are refused.
- **Failure behavior.** A bad entry anywhere, including the last one, throws `UNSAFE_RESTORE` with every problem listed and `written: 0`. The destination is not even created.
  - `verifyBackup` reports `unsafe` items and `ok: false`. The documented seal is still checked, but it is described as what it is: proof the item list was not edited after sealing. It is not authentication.
  - Overlay and point-in-time restores run the same preflight before taking their pre-restore backup.
  - A write failure after preflight leaves `RESTORE-REPORT.json` marked `restore_failed`.

Tests are in `v2-restore.test.js` (5). They cover:

- the portable path rule;
- legitimate package and sealed-backup round trips, with hashes and record totals still verified;
- 19 correctly hashed package payloads (15 path forms, a case duplicate, a backslash duplicate, a file-as-folder and an out-of-area path);
- a late tampered entry;
- six resealed backup variants: forward and backslash traversal, drive, UNC, case duplicate, and a link outside the backup;
- clean, overlay and point-in-time restores refused with no pre-restore backup started.

The copied real records (60 files) pass the new rule unchanged.

### 3. Interrupted paid attempts reconciled, never blindly re-sent (V2-003)

Each attempt has a durable identity: `attempt_id`, a random `dispatch_token` and a `dispatch_state` that is committed before each step.

| `dispatch_state` | Meaning |
|---|---|
| `intent` | Reservation recorded. The request has not been sent. |
| `dispatched` | Committed immediately before fetch. |
| `response_saved` | The answer is saved and the attempt points to it. |
| `imported` | The report was imported and linked to the job. |
| `answered_error` | The provider answered with an error. |
| `uncertain` | The request may have been sent and its outcome is unknown. |
| `reconciled` | The owner recorded what happened to an uncertain attempt. |
| `not_sent` | The runner stopped after the intent but before dispatch. |

On restart:

- **`intent` (never sent).** The reservation is released and the job stays queued.
- **`dispatched` with a valid answer file.** The answer was saved at its deterministic path. Validation checks the run, provider, attempt, prompt and evidence hashes, the dispatch token and (when recorded) the content hash. The answer is imported with no second request, and its actual cost is reconciled from the saved usage.
- **`dispatched` with no usable file.** The attempt becomes `uncertain` and the job waits in `needs_reconciliation`. Its reservation stays counted, and no runner re-sends it.
- **Timeouts and possibly-sent network failures (paid mode only).** These also become `uncertain`, for example a connection reset after sending. A refused connection or a name-lookup failure provably sent nothing: it is released and retried normally.
- **Fictional mock adapters** keep their old retry, because nothing can be billed.

Owner decisions (CLI, API and a "Reconcile…" / "Retry anyway" pair on the job row):

- `research reconcile … --charged-usd X | --not-charged | --unknown` records the provider's own usage page. Nothing is sent. "Unknown" keeps the reservation counted.
- `research retry … --accept-uncertain` is the only way to send again. The uncertain attempt stays counted.
- `research recover` settles interrupted jobs without sending anything (used before a rollback).

**The unavoidable window.** Once a request is handed to fetch and before its answer is saved, a crash or timeout cannot show whether the provider received, processed or billed it. No provider idempotency mechanism is used, because none was verified for these endpoints. Such attempts are held, never marked complete without evidence.

Tests are in `v2-research.test.js`. Each crash test runs in a real child process that exits at the window. The windows covered are:

- after reservation, before intent;
- after intent;
- after the dispatch marker, before send;
- stub received, no answer;
- answer file saved, before pointer;
- pointer saved, before import;
- import done, before attempt finalization.

Each test then runs two restarts and a second, independent runner process. It asserts the total dispatches, the final state, the report count (once) and the spend and reservations. Further tests cover reconcile and explicit retry, tampered and conflicting answers, and network outcomes.

### 4. Aggregate spending and honest tool bounds (V2-004 and V2-005)

- **Aggregate run budget.** `per_run_usd` is the total for one run: every provider, attempt and retry. Day and month use the same accounting.
- **Locked admission.** Admission is one decision under the workspace lock: re-check the job, check run, day and month together, append the reservation to `logs/research-spend.jsonl`, then commit the intent. Concurrent runners cannot oversubscribe.
- **Spend accounting.** Spend per attempt is:
  - the provider-reported actual cost when known;
  - 0 when released or reconciled as not charged;
  - otherwise the reservation (or the legacy estimate).
- **Orphan reservations.** A reservation without a committed attempt (the runner stopped between the two writes) is released at the next run.
- **Validation.** Budgets, limits and prices must be finite and at least 0. Zero stays zero: a zero budget allows nothing, and a zero search limit sends no search tool (the old `|| 20` is gone). Invalid values (negative, `1e309` → Infinity, 2.5 searches) make the provider "manual", with the reason.
- **Native search caps.** Claude: `max_uses=N`. ChatGPT: `tools:[web_search]` plus `max_tool_calls=N` (documented as the total built-in tool calls per response). Gemini: grounding on or off only. At 0, no tool is sent to any provider.
- **Reservation labels.** The reservation is labeled `enforced` only when:
  - no search tool is sent;
  - output is capped by a documented parameter (Claude `max_tokens`; ChatGPT `max_output_tokens`, documented to include reasoning tokens);
  - input is the known prompt, bounded by its UTF-8 bytes plus a 2,000-token allowance. This assumes at least one byte per token; it is not a provider promise.

  Otherwise it is labeled an `estimate` that actual use can exceed. Search results are billed as input tokens with no documented size limit. Gemini has no query cap. Whether Gemini's `maxOutputTokens` caps thinking tokens in `generateContent` was not verified, so Gemini is always `estimate`.
- **Missing prices.** A missing search price with searches above 0 is a configuration reason, never a $0 search.
- **Unattended runs.** Scheduled runs require an `enforced` bound unless the owner sets `research.budget.unattended_requires_enforced_bound: false`.
- **"Maximum" wording removed.** The old "up to $X" and "Estimated maximum" wording is gone. Attempts show "reserved (upper bound)" or "reserved (estimate, not a maximum)", plus the actual cost and whether it exceeded the reservation.

Tests:

| Case | Result |
|---|---|
| $1.10 run allowance, three $1 stub jobs | 1 dispatch; two refusals that name the per-run limit; the first report kept. The baseline makes 3 dispatches. |
| Four runner processes against a $2.50 daily allowance | Exactly 2 reservations and dispatches |
| Uncertain and retry reservations | Stay counted: retry-anyway is refused by the budget until reconciled |
| Captured requests at 0, 1 and 200 searches, per provider | Native controls as described above |
| Runner with a configured 0 | Sends no tool |
| Unattended policy | Withholds Claude with search on and Gemini (output cap unverified); admits ChatGPT with search off |
| High token and tool use | Reconciles to the actual cost, keeps the reservation history, labels it an estimate |

### 5. Bounded multi-window updates and requests (V2-006)

- **Polling replaces the event stream.** New pages do not open server-sent events. A visible page polls `GET /api/changes?since=<seq>&server=<id>`, a cheap, token-checked change log, every 3 s. A hidden or cached page does not poll at all, and that includes a page that starts hidden. Returning to it polls at once and catches up.
  - **Why polling.** For a private local app on loopback it is simpler and more robust than shared-stream leader election (no frozen leader tab, no lock-API fallbacks). Each poll uses a connection only for a moment. A few seconds of latency suits research data whose server side already debounces rebuilds and polls the folder every 5 s.
  - `/api/events` remains only for pages loaded before the update.
- **Bounded requests.** Every request has a limit: 20 s GET, 120 s POST, 300 s download. Moving to another page cancels the previous page's reads; cancellation is not shown as an error. A `503 READ_BUSY` read is retried up to three times, then shown honestly with a "Try again" button.
- **Status line.** The header shows one of:
  - Live
  - Saving elsewhere: last complete data
  - Live: records unverified
  - Reconnecting in N s, with "Retry now"
  - Offline
  - Paused

  Backoff runs from 3 s, doubling to 30 s.
- **Session and security.** Session renewal after a restart works (one 401, then a renewed token). Loopback, Host, Origin, token and CSP checks are unchanged.
- **Preserved behavior.** Frozen sort with explicit Re-sort, drafts, focus and selection, reading position, Enter/Esc/Back and the panels use the existing render path, unchanged.

Browser acceptance: 26 of 26 checks. The browser was headless Chromium 153 on this PC's VM, with web security left on, run against the fictional demo workspace and the final revision; each result records its source fingerprint. See `evidence/browser-repaired/*.json` and the screenshots.

- **Nine visible documents** in one browser profile all load (78–159 ms), navigate and complete API requests. The unmodified code with the same harness loads 6 and times out on the 7th and 8th (`evidence/browser-baseline`).
- **Reloads and closing.** 15 reloads complete. Sockets settle at 3 with no streams; after every window is closed, only the measuring request remains.
- **Visibility.** A document that starts hidden makes 0 change requests in 8 s; once shown it polls about every 3 s; hidden again, it makes 0.
- **Restart and network failure.** Stopping the server shows the retry state with backoff (2 polls in 15 s). Restarting recovers, with a renewed token, and the API works. A blocked poll endpoint backs off (2 attempts in about 14 s) and recovers.
- **Live updates while working:**
  - a report reader at scroll 400 keeps its position and URL through a real live re-render;
  - a draft keeps its text, its 9–14 selection and focus, and "Show updates" is offered instead of forcing a redraw;
  - a price change keeps the frozen order with a notice; Re-sort applies it and keeps the selected project and panel;
  - unknown values sort last.
- **Layouts.** At 320, 390, 768, 1280 and 1600 px with a selected panel there is no page overflow, and all three provider badges are visible in the selected row. The panel is a modal sheet up to 768 px and beside the list from 1280 px.
- **Reconcile actions.** The "Needs your check" state, its labels and the Reconcile / Retry anyway buttons work at 390 px (inside the research table's own horizontal scroll) and at 1280 px. Reconciling "not charged" from the page sends nothing and offers an explicit Retry.

## Validation summary

| What | Result |
|---|---|
| Existing suite on the unmodified baseline (Linux VM, Node 24.21.0) | 108/109 (`evidence/suite-baseline.txt`) |
| Full suite on the repaired code | 138/139: the existing 109 plus 30 new tests (`evidence/suite-repaired.txt`) |
| The one failure, in both runs | A Linux-only test assumption (below) |
| New tests run against the baseline code | v2-reads 0/7, v2-restore 2/5 (the two legitimate round trips pass, as they should), v2-research 0/18 (`evidence/new-tests-on-baseline-code-*.txt`) |
| Browser acceptance, repaired | 26/26, five scenarios |
| Browser, baseline | 6 of 8 windows load |
| Rollback compatibility (new records under baseline code and back; legacy records under repaired code) | 8/8 (`evidence/rollback-compat-results.json`) |
| Copied real records, read by repaired and rollback code in separate empty Test workspaces | 6/6: identical project, report, event and portfolio views, and both package round trips verified (`evidence/real-copy-results.json`) |
| Patch applies cleanly to a pristine baseline copy | Reproduces fingerprint `0f5e0074…` |

**The Linux-only failure.** `ingest.test.js` "a report in the wrong provider folder…" expects a second scan to skip a file copied a moment earlier. On Windows, `CopyFile` keeps the source's modified time, so the file looks settled. On Linux the copy is new, so the scan correctly answers "waiting". It fails identically on the unmodified baseline. The test itself was not changed.

## Remaining limits

- **Not the Windows runtime.** Validation ran on Node 24.21.0 Linux x64 in the Cowork VM. The binary came from the npm package `node-linux-x64@24.21.0`; nodejs.org was blocked, so it was not checked against the official SHASUMS. **Before deploying, run `node dashboard\cli.js test` on the PC (Node 24.21.0, Windows) and expect 139/139.** Windows-specific restore paths are proven by the platform-independent rule and Win32 path assertions, but a backslash payload was not written to a real NTFS folder in this session.
- **Browser coverage.** One headless Chromium build, emulated visibility (not a native background tab), and no back-forward cache restore in this build (a fresh load was verified instead). In this build `navigator.onLine` reported false, so the status read "Offline" rather than "Reconnecting". There was no physical phone, touch, screen reader or native 200% zoom.
  - I did not visually inspect the screenshots in this session: they stay on the PC, and the checks are DOM and geometry measurements. Please look at `evidence/browser-repaired/*.jpg`, especially `reconcile-research-390.jpg`.
- **Paid research.** No live provider call, key, model or price was used, and provider docs were read but not exercised. Prices and bounds rely on the prices you configure.
- **Live update latency** is up to about 3 s plus the server's 300 ms debounce. A visible window makes about 20 small requests a minute.
- **Not done.** V2-007 (market call counting) and V2-U01/U02. This folder covers no deployment or real-environment change.

## Files

- `PATCH.diff`, `PATCH-STAT.txt`, `COMMITS.txt`: the reviewable patch. It covers 20 files: 14 changed and 6 new tests.
- `patched-files/`: the full changed files.
- `SOURCE-FINGERPRINT.json` and `REPAIRED-MANIFEST.json`: starting and repaired fingerprints with per-file hashes.
- `RUNTIME-AND-COMMANDS.md`: the exact runtime and commands.
- `ROLLBACK.md` and `rollback-code/`: how to stop the running dashboard, deploy and roll back. The rollback copy of the current code (70 files, `9ff79de7…`) has a verifier.
- `evidence/`: suite outputs, new tests on baseline code, browser results and screenshots, rollback and real-copy checks, preservation inventories.
- `fixtures/`: the harnesses used. Run them only in an isolated copy.
