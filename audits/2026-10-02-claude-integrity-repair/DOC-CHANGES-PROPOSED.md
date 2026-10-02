# Proposed wording for the workspace docs

Apply this when the repair is deployed. It was not applied here, because these files live in the real folder and deployment is out of scope.

## README.md

**Line 96.** The current text says:

> Each call's maximum cost is estimated first; a call that could exceed a limit, or whose cost cannot be bounded, is not made.

Replace it with:

> The per-run limit is the total for one run: every model and every attempt. Before each call the PC reserves its cost: the parts the request itself caps (the output-token limit, and the search count sent as `max_uses` for Claude or `max_tool_calls` for ChatGPT) plus an estimate for prompt and search-result tokens, which no request parameter caps. A call whose reservation would pass any limit is not made. A reservation is not a maximum: actual usage is recorded when the provider reports it and counts from then on. A web search limit of 0 turns search off; with search on, set a price per search. Gemini's API cannot cap searches, so Gemini searches only if you choose "per request" search billing (Gemini 2.5 and older); for Gemini 3 set its searches to 0.

**Line 77.** Add after "Canceling stops retries; a request already sent may still be billed.":

> If the PC stops while a paid request may already have been sent, the job shows **Outcome uncertain** and is never resent by itself. Check the provider's usage page, then **Reconcile** it (charged amount, or not charged) or choose **Retry anyway**. Until you reconcile, it counts against your limits at its reservation.

## COWORK-INSTRUCTIONS.md

**Section 3, step 6.** Replace the `queued / running` bullet with:

> - `queued` / `dispatching`: an API key, model, bounded prices and budget are configured; the PC runs the job (dashboard or hourly task) within the limits. `dispatching` means a paid call is reserved or in flight. Pending is not saved.
> - `uncertain`: a paid request may have been sent and billed, and no answer was saved. It is never resent automatically. Tell Eric; only he reconciles it (`research reconcile <id> <run_id> --provider P --not-charged | --charged-usd X --reason "..."`) or retries it, after checking the provider's usage page. Never reconcile on your own judgment.

**Section 5, job states table.** Add two rows:

| State | Meaning | Tell Eric |
|---|---|---|
| `dispatching` | A paid call is reserved or in flight. | "Sending to the provider, not saved yet." |
| `uncertain` | The request may have reached the provider and been billed; no answer was saved. Held, never resent automatically. | "Outcome uncertain: check the provider's usage page, then reconcile or retry." |

**Section 5, the `failed` row.** Change it to:

> Bounded retries used up, or a provider error; the raw response (if any) is kept. A provider error without usage keeps counting at its reservation until reconciled.

**Section 7 command table.** Add a row:

| Command | What it does |
|---|---|
| `research reconcile <id> <run_id> --provider P (--charged-usd X \| --not-charged) --reason "..."` | Records what the provider charged for an uncertain attempt (Eric's decision only). |

## WORKSPACE-MAP.md

**Line 70.** Change it to:

> `research-spend.jsonl`: reservation, actual, release and reconciliation lines for every paid model call. Kept for history and for older code; the run files are authoritative.
