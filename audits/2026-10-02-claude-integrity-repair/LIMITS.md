# Limits

These are the things this repair does not do, and the things that could not be shown here.

## Paid research

1. **The ambiguous window cannot be closed from this side.**
   - The window runs from the moment the "dispatched" marker is written until the answer is saved.
   - A crash in that window cannot tell "never left this PC" from "reached the provider and was billed".
   - Such attempts become **uncertain**. They are never resent automatically, they keep counting at their reservation, and they wait for you to reconcile or retry them.
   - Window 2 in the tests shows the cost of this honesty: an attempt that in fact never left is still held as uncertain.
2. **No idempotency key is sent.** This work did not establish documented idempotency support for these three request types, so exactly-once delivery is not claimed and none was invented.
3. **A reservation is an estimate, not a cap.**
   - Output tokens and search counts or fees are enforced by the request.
   - Prompt tokens are estimated at 3.5 characters per token.
   - Search-result tokens are allowed 4000 per search. Providers bill these as input, and no request parameter caps them.
   - Actual usage can be far higher. It is recorded and shown as "above its reservation", and later admissions count it.
   - OpenAI's billing of search content tokens depends on the model. The same allowance is used for every model.
4. **Gemini:**
   - No search cap exists in the API, and none was invented.
   - Search is used only when you declare per-request billing (Gemini 2.5 and older bill grounding per prompt). The dashboard does not check which family your model ID belongs to. Your declaration is trusted.
   - Gemini 3 bills each query, so leave its searches at 0.
   - `max_output_tokens` includes thinking tokens, as Google documents.
5. **Claude's `pause_turn` stop reason is not handled.** If a long server-side search loop pauses, the partial answer is saved and validated like any other. It is likely refused as incomplete ("saved but not imported"), and its cost is recorded.
6. **Provider errors keep their reservation.** An HTTP error without usage (for example 429 or 500) keeps counting at its reservation until you reconcile it as not charged. Under a tight per-run limit this can block a retry. The refusal message says how much is counted.
7. **Connection-refused attempts use up attempts.** They are released at $0 but count toward `max_attempts`, so a long outage cannot grow the attempt list without limit.
8. **The original code has no way to reconcile.** After a code rollback, uncertain attempts can only be reconciled by rolling forward again.

## Reads and the server

9. **Different wait bounds.**
   - Server reads wait up to 250 ms, then answer 503. The page retries up to 4 times.
   - CLI and Cowork reads wait 1.5 s, then return `READ_BUSY`.
   - A continuous stream of commits can starve a reader. This was seen once under full-suite load, in the existing F04 test, whose reader child now counts "busy" instead of crashing.
   - Doctor reports a busy index read as a failed check: honest, but alarming if it happens mid-save.
10. **Pre-existing, found while testing, not changed:**
    - The dashboard records each background job's result under the workspace lock and waits for that lock synchronously, for up to 20 s.
    - If another process holds the lock (a long backup, export or package), the dashboard stops answering until it gets the lock. Pages then show "Reconnecting…" and recover.
    - This is outside the brief. It would be a small, separate change to `jobs.js` (a short lock timeout for bookkeeping).
11. **Byte copies of an unverified workspace.** When a save could not be verified, packages and backups are still made, so there is evidence to investigate, but they are marked unverified. Portable JSON and CSV are refused.

## Restores

12. **Windows rules apply on every OS.** Restores apply Windows name rules everywhere: no names ending in a dot or space, no reserved device names, no `:`. A package made on another OS with such names would be refused as a whole.

## Live updates and the browser check

13. **Back/forward cache was not testable for real.** This embedded browser never restored pages from the back/forward cache (`notRestoredReasons: masked`). The page's `pagehide` and `pageshow(persisted)` handlers were exercised with synthetic events. A real restore was not shown.
14. **"Visible" windows were emulated.** Eight visible windows were simulated by overriding `document.hidden` in background tabs, as the v2 review did. Chromium still throttles timers in really hidden tabs, so poll counts were lower than the nominal 24 per minute per window.
15. **Polling cost.** Each visible window makes about 24 small requests a minute (about 1 KB each). Hidden windows make none.
16. **Pre-existing hover card, not changed.** At 768 px a hover preview card could extend past the right edge until the pointer moved (screenshot 03b). It comes from the earlier design pass and was not changed here.

## Not done here, by design

17. **Not deployed.** The real `dashboard/` code is untouched, so the README and COWORK-INSTRUCTIONS wording still describes "maximum cost" and the old job states. The proposed wording is in `DOC-CHANGES-PROPOSED.md`.
18. **Next finding not started.** V2-007 (market call undercount) is not included.
19. **Settings not exposed in the page.** `search_result_tokens_estimate` and `max_output_tokens` can be changed only in `config/settings.json`.
