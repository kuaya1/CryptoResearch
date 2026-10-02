# Limits after round 2

Round 1's `LIMITS.md` updated. New or changed items are marked **(r2)**. Items from the Cowork review are marked **(review Fn)**.

## Paid research

1. **(r2) The ambiguous window is now "dispatch marker → capture", not "dispatch marker → saved".** A crash or failure in it still cannot tell "never left this PC" from "billed". Such attempts stay *uncertain*, are never resent, count at their reservation, and wait for you. If the capture itself fails *and* the commit fails, the answer is lost and the attempt is *uncertain*; the runner says so (`unsaved`).
2. **(r2) Captures live in `.cr/captures`, which is not in backups or packages.** A capture waiting to be saved exists only on this disk. Doctor warns while one waits. It is saved by the next research run: the dashboard's job cycle (minutes), the hourly task, or `node dashboard/cli.js research run`. The runner does not retry the commit in-process.
3. **(r2) Mixed versions.** The original code leaves a pending capture alone. Round 1's code would turn that attempt *uncertain*, after which round 2 keeps the capture but never imports it (doctor lists it as unmatched). Round 1 was never deployed.
4. **(r2, F2) The transport fix uses Node's bundled Undici through `Symbol.for('undici.globalDispatcher.1')`.** Undici's v8 migration guide says v8 keeps a v1-compatible wrapper under that symbol and recommends the public API. If a future Node ships something that is not an `Agent` there, no dispatcher is made, providers show "not configured", and nothing is sent. Re-check whenever the Node pin changes. Verified on 24.21.0 / Undici 7.29.1 only.
5. **(r2) Calls longer than the research timeout** (600 s by default) still end as *uncertain*. Responses are not streamed.
6. **No idempotency key is sent.** Exactly-once delivery is not claimed.
7. **A reservation is an estimate, not a cap.** Output tokens and search counts or fees are enforced by the request; prompt tokens (3.5 characters per token) and search-result tokens (4000 per search) are estimated. Actual usage is recorded and later admissions count it.
8. **Gemini (review F3).** No search cap exists in the API. Search is used only when you declare per-request billing, and then one search fee per request is counted. If your model bills per query (Gemini 3), that undercounts. Leave Gemini searches at 0 unless you are sure.
9. **Claude's `pause_turn` stop reason is not handled.** A partial answer is saved and probably refused as incomplete; its cost is recorded.
10. **Provider errors without usage keep their reservation** until reconciled; this can block a retry under a tight per-run limit.
11. **Connection-refused attempts use up attempts** (released at $0).
12. **The original code has no Reconcile.** Reconcile uncertain attempts before a code rollback, or after rolling forward.
13. **Research lease vs lock waits (review F4).** The lease lasts the research timeout + 60 s; three 20 s lock waits plus the call can exceed it. Same-host leases follow the process ID, so this matters only for a runner on another host. If a second runner takes over while the first is still waiting for the provider, it holds the attempt as *uncertain*; when the first runner's answer then arrives, it is captured but not committed (the once-only guard refuses an attempt that is no longer waiting), and doctor lists the capture as unmatched for you to reconcile. If the first runner had already captured, the second commits the capture. No double commit or double charge in either case.

## Reads and the server

14. **Different wait bounds.** Server reads wait 250 ms then answer 503 (the page retries up to 4 times); CLI and Cowork reads wait 1.5 s then `READ_BUSY`. A continuous stream of commits can starve a reader. Doctor reports a busy index read as a failed check.
15. **Event-loop blocking (review F6).** Server reads wait with a synchronous sleep (up to 250 ms); startup and read recovery call `recover()`, which can wait up to 20 s for the lock. The dashboard also waits up to 20 s for the lock to record job results. Pages show "Reconnecting…" and recover.
16. **Byte copies of an unverified workspace** (packages, backups) are still made and marked unverified; portable JSON and CSV are refused.

## Restores

17. **Windows name rules apply on every OS.**
18. **(review F5)** The reserved-name check blocks `CON.txt` but not variants such as `con .txt`. Restores go into an empty folder, so this is not a path escape.

## Live updates

19. The back/forward-cache restore was exercised with synthetic events only.
20. "Visible" windows were emulated in round 1's browser check.
21. Each visible window polls about 24 times a minute; hidden windows do not poll.
22. A hover card at 768 px can overhang the right edge until the pointer moves (pre-existing).

## Testing

23. **(r2) Round 2 was tested on Linux only** (Node 24.21.0, the pinned version, in the Linux VM on Eric's PC). Hard links, NTFS, antivirus file locks and the restore junction tests were not exercised on Windows for round 2. See `DEPLOY-CHECKLIST.md`.
24. **(r2, new, low) One existing test fails on Linux** (`ingest.test.js`, wrong provider folder): Linux copies get a new modification time and `inbox.js:325` turns `settle_seconds: 0` into 2 s (`|| 2`). It passes when copies keep their source time, as on Windows. The `|| 2` is the same zero-becomes-default pattern V2-005 fixed for searches; it was not changed here.
25. No real provider was contacted. The adapters follow each provider's documented API and were tested against local stubs.

## Not done here, by design

26. **Not deployed.** README and COWORK-INSTRUCTIONS still describe the original behaviour; wording is in `DOC-CHANGES-PROPOSED.md`.
27. **V2-007** (market call undercount) not started.
28. `search_result_tokens_estimate` and `max_output_tokens` are editable only in `config/settings.json`.
