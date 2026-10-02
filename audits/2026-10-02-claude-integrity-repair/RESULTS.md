# Results by action

All results come from the isolated copy (`%TEMP%\crfix\dev`, test workspaces only), Node v24.21.0, with every non-loopback request refused by `fixtures/no-network-guard.cjs`.

"Original" means the audited code (`9ff79de7…`), run from a writable copy with the new tests added (`fixtures/make-red-copy.cjs`).

## V2-001 — Coherent reads

**Change**
- `ops.js`:
  - `generationStatus` classifies the generation as stable / applying / interrupted / blocked.
  - `readConsistentDetailed` never runs an unchecked read: it returns one generation, waits up to `READ_WAIT_MS` (1500 ms) then throws `READ_BUSY`, or throws `READ_INTERRUPTED` / `READ_UNSAFE`. A failure is never turned into an empty result.
  - The "applying" marker is mandatory. If it cannot be written, the save aborts before moving anything, in `runOp` and in recovery.
  - An unreadable marker no longer counts as "stable": sealed staging folders decide.
- `indexer.js`: the index records its `read_generation`, and index and project reads accept the server's wait bound.
- `portfolio.js`: the daily snapshot is computed inside its own write operation.
- `exporter.js`:
  - Portable JSON, `exportAll` and CSV read one locked generation and are refused while a save is unverified.
  - Packages and backups record `consistency` (and `records_verified`).
- `server.js`:
  - The server keeps the last verified index with `read_status` (current / stale / unverified) and retries with backoff.
  - It runs `recover()` on an interrupted save.
  - With no snapshot yet it answers 503 + `Retry-After`.
  - The changes, ledger and providers routes read coherently.
  - Read errors map to 503.
- `app.js`: a 503 busy read is retried (up to 4 times, as long as the server asks), with "Saving in progress" in the status line.

**Tests:** `tests/integrity-reads.test.js`, 8 tests. Each uses a real second process that is held, timed or killed after the first of two project records moved.

| Test | Repaired | Original |
|---|---|---|
| Held writer: reads at the production default wait (≥ 1450 ms, < 3000 ms), then say busy | pass | **returned `["A new","Second Example (FICTIONAL)"]`** |
| Short commit: a read during it returns the new generation whole | pass | pass |
| Killed writer: reads refuse at once (< 1 s) until recovery rolls it forward | pass | **returned the mixed pair** |
| Unreadable marker plus unfinished commit: still detected; a clean folder still reads | pass | **returned the mixed pair** |
| Quarantined commit: portable export and CSV refused; package and backup marked unverified | pass | **produced a portable export of possibly mixed records** |
| Exports, CSV and backup taken during a save capture one whole generation | pass | **`["A new","B old"]`** |
| Server: the last verified index is served as stale (never mixed) during a save; a detail read gets 503 + Retry-After; then current, with the change listed | pass | fails (no read status) |
| Server: 503 with nothing verified; an interrupted save is recovered at startup and served whole | pass | **served the mixed pair with HTTP 200** |

## V2-002 — Restore path validation

**Change**
- `workspace.js`:
  - `safeRestoreRel` adds to `safeRel`: rejects names ending in a dot or space (Windows folds `".. "` into `..`), `:` (alternate data streams), control characters, and reserved device names including `COM¹`.
  - `checkRestoreInventory` checks every entry against each root, and finds case- and NFC-insensitive duplicates and file/folder conflicts.
- `exporter.js`:
  - Every package entry's path and hash is checked before the destination exists.
  - `writeAllOrNothing` re-hashes each file as it is written and removes everything on any failure.
  - Backups: path inventory, realpath containment, and links or junctions listed and never followed (`lstat`). The clean, overlay and point-in-time restores all preflight before writing, and overlay checks before its pre-restore backup.
  - The error says plainly that a matching SHA-256 does not make a path safe.

**Tests:** `tests/integrity-restore.test.js`, 7 tests. Every destination is nested three folders inside its own sandbox, so even the original code could only write inside the sandbox.

| Test | Repaired | Original |
|---|---|---|
| 18 hostile paths with valid hashes (traversal with `\` and `/`, `.. `, `...`, absolute, drive, drive-relative, UNC both ways, rooted, NUL, control character, `CON`, `COM¹`, ADS, empty segment) | all refused; no folder created; nothing written in the sandbox | **did not refuse `..\escaped.txt`** (the v2 review's probe showed that entry landing outside the destination) |
| Case, Unicode-form and file/folder duplicates | refused as a whole | **restored** |
| Damaged last entry, and a disk failure after 3 files | no destination left behind | **partial destination** |
| Legitimate package and backup round trips | verified | verified |
| Restores report whether records were verified when packaged or taken | yes | field absent |
| Resealed backup manifest with `..\escaped.txt` | verify fails (`unsafe_paths`); clean, overlay (before its pre-restore backup) and point-in-time restores all refuse | **verify said ok** |
| Junction inside `files/` pointing to identical copies outside | verify fails (links / escaped); restore refused | **verify said ok** |

On a copy of your real records, a package round trip gave `restored_and_verified` (60 files): `evidence/realcopy-check.json`.

## V2-003 — Interrupted paid attempts

**Change (`research.js`)**

Each paid attempt has an `attempt_id` and moves through phases. Each phase is written durably before the step it announces:
- **reserved** — admission under the workspace lock.
- **dispatched** — written immediately before the request.
- **responded** or **errored** — the response file and its pointer are written in one operation.
- **imported**.
- **not_sent** — provably unsent. A crash before the marker is released.
- **uncertain** — held for the owner.
- **reconciled**.

How each outcome is classified:
- Connection never made (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `UND_ERR_CONNECT_TIMEOUT`, `ENETUNREACH`, `EHOSTUNREACH`) → not_sent.
- Timeout, abort, reset, or a crash after the marker → uncertain, never requeued.
- HTTP error → errored. 429/5xx are retried within `max_attempts` if the budget admits; the reservation still counts.

Other parts of the change:
- On recovery, a saved response at the deterministic path is validated on run, provider, attempt number, attempt ID, prompt hash, evidence-packet hash and text hash, then imported without sending.
- A mismatched file is never imported.
- Older records (no phases) are read the same way. An old `running` job with no answer becomes uncertain instead of being requeued.

Owner actions:
- `reconcileAttempt` (charged amount or not charged, plus a reason; repeat-safe; conflicting amounts refused).
- An explicit retry, whose message says the uncertain attempt stays counted.
- Cancel.
- Available in the CLI (`research reconcile`), the server (`POST …/reconcile`) and the UI (Reconcile form, Retry anyway).

`doctor` warns while any attempt is uncertain.

**Tests:** `tests/research-attempts.test.js`, 8 tests. Real runner processes are killed at each point; a fresh process continues. The "provider" is a local stub server that counts the requests it receives.

| Window | Repaired | Original |
|---|---|---|
| 1. After the reservation, before the marker | released, sent once on restart; the ledger shows $0 for the released attempt | no such step |
| 2. After the marker, before the request | uncertain; 0 requests after two restarts; reconcile "not charged" → $0, failed; a different later amount is refused | **sent on restart** |
| 3. Killed while the provider held the request | uncertain; 1 request after two restarts; an explicit retry sends attempt 2 and both attempts count | **2 requests (automatic resend)** |
| 4. After the answer arrived, before it was saved | uncertain, 1 request, no report | **2 requests** |
| 5. After answer and pointer were saved | imported on restart, 1 request, the saved original unchanged byte for byte | **2 requests** |
| 6. An older runner's saved answer without a pointer | validated and imported, 0 requests, priced from its saved usage; a file with a different prompt hash is not imported (uncertain) | **resent** |
| An old "running" job with no saved answer | uncertain, 0 requests | **requeued and sent** |
| Connection refused vs. timeout | not_sent and requeued at $0, vs. uncertain and not due | failed |

Cross-version results (`evidence/rollback-crossversion.json`) are summarized in `ROLLBACK.md`.

## V2-004 / V2-005 — Aggregate spend and honest tool bounds

**Change**

`research.js`:
- `callBounds` validates every bound and price as finite and nonnegative, and never substitutes a default for a present value: 0 searches turns search off.
  - Search needs a price.
  - Gemini search needs declared `search_billing: "per_request"`. No cap is invented.
- `callPlan` labels each part of a reservation:
  - **Enforced:** the output-token limit sent; searches × price via `max_uses` / `max_tool_calls`, or one per-request fee.
  - **Estimated:** prompt tokens at 3.5 characters per token; 4000 result tokens per search.
- `allCharges` / `spendSoFar` count every attempt in the workspace: reconciled amount, else actual, else reservation; not_sent counts 0.
  - Ledger lines fill in older or unreadable records.
  - A ledger actual replaces a stale reservation.
- `budgetCheck` checks the per-run total (all models and attempts), then daily, then monthly, in integer ten-thousandths of a dollar.
- `admitAttempt` runs it under the workspace lock and appends the ledger reservation inside the operation, so a failure can only overcount.
- Actual cost uses the prices the attempt was admitted with and records `overrun_usd`.
- `providerStatus` is `api` only when the plan is feasible, and its reasons say what is missing. Unattended schedules use the same rule.

`providers.js`:
- Claude: no tool at 0, otherwise `max_uses: n`.
- ChatGPT: no tool at 0, otherwise `tools: [web_search]` and `max_tool_calls: n`.
- Gemini: no tool at 0, otherwise `google_search` with no cap field.
- Invalid bounds are refused before sending.
- OpenAI search fees count search actions; `tool_calls` is recorded separately.

`server.js`: `max_searches` must be a whole number from 0 to 200 (empty means not set); `search_billing` is Gemini only.

UI: run-total wording, a Gemini billing choice, "what each limit enforces", and counted-so-far with open reservations and uncertain attempts.

**Tests:** `tests/research-spend.test.js`, 11 tests.

| Test | Repaired | Original |
|---|---|---|
| $1.10 per-run limit, three $1.00 calls | 1 sent ($1.00), 2 refused before sending: "…plus $1.00 already counted for this run (every model and attempt) would pass the per-run limit of $1.10" | **3 sent ($3.00)** |
| 4 runner processes released together, $1.50 daily limit, $1.00 calls | exactly 1 request; 3 refused (daily limit) | **4 requests** |
| Retry, HTTP 500 and uncertain counting (per-run limit $2.50) | the timeout is held; HTTP 500 counts its reservation; the third attempt is refused ("plus $2.00 already counted"); reconcile releases it; the ledger alone gives the same total | **the timeout is requeued automatically** |
| Captured request bodies at 0 / 1 / 200 searches | Claude: no tools / `max_uses` 1 / 200. ChatGPT: no tools or `max_tool_calls` / 1 / 200. Output limits as set. | **0 became `max_uses: 20`**; ChatGPT had no cap |
| Gemini | 5 searches with no billing declared: not dispatched, with the reason; 0 searches: no tool; per-request billing: tool sent with no cap field, a single enforced search fee, 7 searches billed once | **reported ready (`api`) with uncapped search on** |
| Settings | 0 kept; empty means not set; 2.5, −1, 201 and "abc" refused; NaN / Infinity / negative budgets refused; a hand-edited string `"5"` is not coerced | **"" saved as 0** |
| Zero per-run limit | nothing sent | nothing sent |
| Labels and overrun | parts and enforced/estimated split exact ($0.17 + $0.09 = $0.26); 2,000,000 input tokens priced at $6.095 with an overrun recorded; the next call is admitted against the actual figure; no "maximum" anywhere | no labels |
| Unattended schedule with missing bounds | declined until search is off | **created a run** |
| Older ledger-only records; older runner priced but unrecorded | counted ($0.55, $0.30 open); counted at the ledger's actual ($0.42) | daily total counted from the ledger alone; no open-reservation or per-run figure |

## V2-006 — Bounded multi-window updates

**Choice:** bounded polling, not a shared stream or leader election.
- This is a private, loopback, single-user app, so push latency buys little.
- Polling holds no connection open, so any number of windows stays within the browser's six connections per server.
- Leader election across tabs (BroadcastChannel or locks) would add failure modes, such as a hidden leader or a frozen leader, for no user benefit.

**Change**

`app.js`:
- Visible pages poll `GET /api/version` every 2.5 s. Each poll is bounded to 8 s and only one is in flight at a time.
- Hidden pages stop polling, and a page that starts hidden never polls.
- `pagehide` aborts the in-flight poll; `pageshow` (from the back/forward cache), becoming visible, or coming back online polls immediately.
- Failures back off: 5, 10, 20, then 30 s.
- Only the project caches that changed are dropped.
- Every request is bounded: reads 20 s; writes 120 s, after which the page says the outcome is unknown.
- The 401 session renewal is kept.

`server.js`:
- A change sequence and log.
- The index carries `live: {seq, instance}`.
- `/api/version`.
- `/api/server-stats` (counts only).
- The SSE endpoint is kept for older pages and existing tests.

The status line shows Live / Paused while hidden / Reconnecting… next try in N s / Saving in progress / Showing the last verified view.

**Tests:** `tests/live-updates.test.js` covers small answers, the sequence and the changed projects, an empty list when nothing changed, a refetch after a gap or restart, the token required, and 12 concurrent pollers with 0 streams.

**Browser measurements:** `evidence/v2006-browser-checks.json`, with screenshots in `evidence/screenshots`.
- Eight visible windows: 50 polls in 20 s, 0 streams, at most 6 sockets; the eighth window's project page in 6 ms.
- Background, hide/show, close and reopen, a 25 s outage (4–5 attempts per tab), and a restart all recovered.
- Frozen sort and Re-sort, drafts, reader position, Esc and Back, and bookmarked panels are all preserved during live updates.
- Layouts at 1600, 1280, 768, 390 and 320 px: nonmodal desktop panel, inert sheet below desktop width, no horizontal overflow.

The original code, measured the same way: six background tabs held all six connections, the seventh page never finished loading, and a visible tab's request did not complete in 8 s.

## Existing test file changed

`tests/children/child-generation.js` (the F04 reader child) now counts `READ_BUSY` refusals instead of crashing on them, and reports `busy` in its output. The test still asserts `consistentMixed === 0`.

Why: under full-suite load, back-to-back commits kept its reader from finding a quiet moment within the 1.5 s bound. That is the bounded "busy" answer the brief asks for, not a mixed read.
