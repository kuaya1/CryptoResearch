# Integrity, budget and lifecycle repair: implementation plan

Source: real folder `C:\Users\Kuaya\Documents\CryptoResearch`, read only. Fingerprint `9ff79de7…` matches the audited 70-file target, so the v2 findings apply as written.
Work happens in `%TEMP%\crfix\dev`. `%TEMP%\crfix\baseline` is the immutable, read-only reference. Demo workspace IDs are `ws_crfixdev01` and `ws_crfixbase01`. Ports are 49xx and 47xx test ports, never 4729.

## 1. Coherent reads (V2-001)

`ops.readConsistent` will never call the reader without a check.

- **Commit status.** A generation is judged by its commit status:
  - `stable`: it can be read.
  - `applying`: a live writer holds the lock. The reader waits a bounded time (production default), then raises `READ_BUSY`.
  - `interrupted`: the commit was sealed, but no live writer holds the lock. Raise `READ_INTERRUPTED`; recovery rolls it forward.
  - `blocked`: the commit is quarantined or unverified. Raise `READ_UNSAFE`.
- **Retry on change.** A read reruns if `generation.json` changed while it read, and it rereads after ENOENT caused by a commit.
- **Applying marker.** It is mandatory before any file moves. If it cannot be written, the operation aborts before applying anything.
- **Server.** It keeps the last verified index and attaches an honest `read_status`. When busy it retries with backoff. When interrupted it runs `recover()`. A cold start with no snapshot returns HTTP 503 with `Retry-After`.
- **Browser.** It retries 503 busy responses with a bounded backoff and shows a "saving in progress" state. Drafts and focus are untouched.
- **Read paths fixed.** These now read coherently or under the lock:
  - project detail
  - changes
  - the ledger route
  - CSV
  - the second read in `exportAll`
  - the daily portfolio snapshot, whose computation moves inside its write operation
- **Blocked state.** Package and backup still capture bytes, but are marked unverified. Portable JSON and CSV are refused.

## 2. Restore paths (V2-002)

A shared `safeRestoreRel` builds on `safeRel` and adds four checks:
- trailing dot or space in a segment (Win32 normalization)
- `:` in a segment
- reserved device names
- duplicate targets after case-folding and NFC normalization, and file-versus-directory prefix conflicts

Containment is checked lexically against the restore root and with realpath for backup sources.

Everything is preflighted before the destination is created:
- every path
- every package hash
- the backup seal, existence and containment

Each file is then copied in a single read: read, hash, write. Any late failure removes everything written, so no partial destination is left. Verify, clean, point-in-time and overlay restores all use the same validator.

## 3. Interrupted paid attempts (V2-003)

An API attempt moves through these phases:

| Phase | Meaning | On restart |
|---|---|---|
| `reserved` | Durable admission; reservation counted | Provably not sent: release and requeue |
| `dispatched` | Durable marker written immediately before the provider call | No saved response: `uncertain`, held |
| `responded` | Response saved, pointer and usage recorded | Import |
| `imported` | Report saved | Nothing to do |
| `not_sent` | Released before sending | — |
| `reconciled` | Owner settled an uncertain attempt | — |

- While a call is in flight, the job state is `dispatching`. The old code ignores that state, so a rollback cannot blindly replay the call.
- On recovery, a saved response at its deterministic path is validated against run, provider, attempt, attempt_id, prompt hash, evidence hash and text hash, then imported. Nothing is dispatched again. A file that doesn't match is not imported.
- Owner actions:
  - **Reconcile:** charged amount or not charged, plus a reason.
  - **Retry:** an explicit new attempt. The uncertain reservation stays counted until reconciled.
- Timeouts and connection resets after dispatch become `uncertain`. Connection-refused, DNS and connect-timeout errors become `not_sent`.

## 4. Aggregate spend and honest tool bounds (V2-004/005)

- **Atomic admission.** Admission runs under the workspace lock and checks per-run (all providers and attempts), daily and monthly limits. It counts actual cost when known, otherwise the reservation. Reservations made before dispatch, uncertain attempts and retries all stay counted.
- **Ledger.** `logs/research-spend.jsonl` is kept and appended for history and rollback compatibility. The run's attempts are authoritative.
- **Search controls.**
  - Claude: `max_uses`.
  - OpenAI: `max_tool_calls`, which per the official reference caps all built-in tool calls.
  - Gemini: no documented cap. Gemini 3 bills each search query; 2.5 and older bill per prompt.
  - Zero removes the search tool. The `|| 20` that turned zero into 20 is gone.
- **When Gemini is not dispatched.** Gemini with search on is not dispatched unless `search_billing: "per_request"` is declared. Nothing invents a cap.
- **Price checks.** A missing search price, or a negative or non-finite value, is a configuration reason, not a silent zero.
- **Labels.** Estimate parts are labeled enforced (output tokens, search count or billing) or estimated (prompt tokens, search content). The word "maximum" is removed. Actual usage reconciles the figure and shows any overrun.

## 5. Bounded multi-window updates (V2-006)

- **Polling replaces the browser EventSource.** Visible documents poll a small `/api/version` endpoint every 2.5 s with a short timeout. Hidden documents don't poll, and an initially hidden document never opens a connection. Showing a page polls immediately.
  - Why: a private, loopback, single-user app needs neither push latency nor leader election. No connection stays open, so any number of windows stays within HTTP/1 limits.
- **Server change log.** The server keeps a sequence number and a short change log, so a client can drop only the project caches that changed.
- **Requests.** Every request is bounded by a timeout (AbortController). The status shows Live / Paused (hidden) / Reconnecting (with backoff) / Saving in progress. Session renewal stays.
- **SSE endpoint.** It stays on the server for compatibility with existing tests.

## Validation and rollback

- **Tests.** All 109 existing tests stay. New tests cover:
  - the slow writer at production defaults (held and interrupted)
  - generation, quarantine and block conditions, and the server snapshot and export paths
  - restore traversal variants, duplicates and late failures
  - six paid crash windows, using child processes and local stubs
  - aggregate, concurrent, retry and uncertain admission
  - zero/one/max search request capture for each provider
  - over-estimate reconciliation
  - the version endpoint
- **Browser.** Seven or more visible clients, plus reload, background, BFCache, close/reopen, restart and network-failure cycles, with server socket and stream counts and client timer counts. Live updates are checked while reading, editing drafts and filtering or sorting. Layouts at 320, 390, 768, 1280 and 1600.
- **Rollback.** Records written by the new code are run with the baseline code in a separate empty workspace: no replay, spend counted, originals intact. Legacy records are run with the new code. A new current-code rollback manifest records the exact launcher and process stop and confirmation steps.
- **Deliverables.** Patch (`git diff --no-index`), fingerprints, commands, per-action results, screenshots and limits, saved to `audits/2026-10-02-claude-integrity-repair/`. No deployment.

## As built (differences from this plan)

- **Response and pointer write.** The response file and its pointer, phase, usage and cost are written in **one** operation. A "saved file without a pointer" can therefore only come from older code, and recovery still discovers, validates and imports it (window 6).
- **Unreadable generation marker.** It is no longer treated as stable. Sealed, uncommitted staging folders decide between applying and interrupted. This gap was found while writing the tests.
- **Server reads.** The server waits 250 ms for a save in progress, then answers 503 with Retry-After. The page retries. The CLI and the indexer keep the 1500 ms default.
- **Ledger actuals.** A ledger actual cost replaces a reservation for an attempt whose run file was never updated, which is how older runners crashed after pricing an answer. This was found during the cross-version rollback test.
- **Settings.** An empty `max_searches` in a settings save means "not set", never 0.
- **CLI and server errors.** Both report `UNSAFE_PATH` and `GENERATION_UNWRITABLE` as "nothing was saved".
- **One existing test child adapted.** The F04 reader (`tests/children/child-generation.js`) now counts READ_BUSY refusals instead of crashing on them. The assertion is unchanged.
- **Live-update status.** It also shows "Showing the last verified view" when the server's index is stale for a reason other than a save in progress.
