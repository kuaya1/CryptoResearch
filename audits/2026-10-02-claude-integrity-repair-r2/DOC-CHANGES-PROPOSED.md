# Proposed wording for the workspace docs (round 2)

Supersedes `../2026-10-02-claude-integrity-repair/DOC-CHANGES-PROPOSED.md`. Apply only when the round-2 patch is deployed; these files describe the live code, which is unchanged. Line numbers refer to the files as they are on 2026-10-02.

## README.md

**Line 75.** Replace "the PC runs the job, saves the raw response before anything else, validates it and commits an immutable report." with:

> the PC runs the job. The moment the answer arrives it is captured on disk (`.cr/captures`), then saved with the run, validated and committed as an immutable report. If saving has to wait (another save, a backup, or blocked writes), the captured answer is saved by the next research run without asking the provider again.

**Line 77.** After "Canceling stops retries; a request already sent may still be billed." add:

> If the PC stops after a paid request may have been sent and before its answer was captured, the job shows **Outcome uncertain** and is never resent by itself. Check the provider's usage page, then **Reconcile** it (charged amount, or not charged) or choose **Retry anyway**. Until you reconcile, it counts against your limits at its reservation.

**Line 96.** Replace "Each call's maximum cost is estimated first; a call that could exceed a limit, or whose cost cannot be bounded, is not made." with:

> The per-run limit is the total for one run: every model and every attempt. Before each call the PC reserves its cost: the parts the request itself caps (the output-token limit, and the search count sent as `max_uses` for Claude or `max_tool_calls` for ChatGPT) plus an estimate for prompt and search-result tokens, which no request parameter caps. A call whose reservation would pass any limit is not made. A reservation is not a maximum: actual usage is recorded when the provider reports it and counts from then on. A web search limit of 0 turns search off; with search on, set a price per search. Gemini's API cannot cap searches, so Gemini searches only if you choose "per request" search billing (Gemini 2.5 and older); for Gemini 3 set its searches to 0. A call may run up to the research timeout (10 minutes by default); a call still unanswered then is treated as possibly billed.

## WORKSPACE-MAP.md

**Lines 84–85.** Change the `.cr/` entry to:

> `.cr/` Internals: write lock, leases/, staging, generation.json, blocked.json, quarantine/ for unverifiable writes, captures/ for paid answers waiting to be saved (removed once saved; not in backups), server.json

**Line 70.** Change it to:

> `research-spend.jsonl`: reservation, actual, release and reconciliation lines for every paid model call. Kept for history and for older code; the run files are authoritative.

## COWORK-INSTRUCTIONS.md

**Section 3, step 6.** Replace the `queued / running` bullet with:

> - `queued` / `dispatching`: an API key, model, bounded prices and budget are configured; the PC runs the job (dashboard or hourly task) within the limits. `dispatching` means a paid call is reserved, in flight, or answered and waiting to be saved. Pending is not saved.
> - `uncertain`: a paid request may have been sent and billed, and no answer was captured or saved. It is never resent automatically. Tell Eric; only he reconciles it (`research reconcile <id> <run_id> --provider P --not-charged | --charged-usd X --reason "..."`) or retries it, after checking the provider's usage page. Never reconcile on your own judgment.

**Section 1, step 2.** Add after the `Write test` sentence:

> If doctor shows **Research captures**, a paid answer arrived but is not saved into the records yet. Say so; it is saved by the next research run. If it says a capture does not match an attempt, tell Eric and do not touch the file.

**Section 5, job states table.** Add:

| State | Meaning | Tell Eric |
|---|---|---|
| `dispatching` | A paid call is reserved, in flight, or answered and waiting to be saved. | "Sending to the provider (or saving its answer), not saved yet." |
| `uncertain` | The request may have reached the provider and been billed; no answer was captured. Held, never resent automatically. | "Outcome uncertain: check the provider's usage page, then reconcile or retry." |

**Section 5, the `failed` row.** Change it to:

> Bounded retries used up, or a provider error; the raw response (if any) is kept. A provider error without usage keeps counting at its reservation until reconciled.

**Section 7 command table.** Add:

| Command | What it does |
|---|---|
| `research reconcile <id> <run_id> --provider P (--charged-usd X \| --not-charged) --reason "..."` | Records what the provider charged for an uncertain attempt (Eric's decision only). |
