# Follow-up coding task: replay-safe append requests and truthful receipts

Use this as the next task prompt. This audit did not authorize implementation in the current review.

## Objective and bounded scope

Fix audit **F01 and F11**: queued `add_journal`, `add_event` and `add_transaction` must produce at most one committed effect per request identity across crash/restart/concurrent processing, with a durable receipt that accurately describes the effect. All allowed queue actions must report semantic rejection/failure honestly rather than calling a non-throwing failed return “done.” Preserve CLI/dashboard behavior and the existing readable-file architecture.

Read `audits/2026-10-01-codex-system-review/REVIEW.md`, `FINDINGS.md`, `VALIDATION.md`, `reproduce.cjs`, and `queue-crash-child.cjs`, then applicable instructions and `requests.js`, `ops.js`, `notes.js`, `portfolio.js`, `inbox.js` and relevant schemas/tests. Confirm the actual workspace/runtime before acting. Do not treat 59 passing tests as proof the crash gap is covered.

The expected real root is `C:\Users\Kuaya\Documents\CryptoResearch`. Work on application code and new synthetic tests only. Do not process the real inbox/queue or run real jobs, alter original reports/corrections, holdings/transactions, configuration, installed schedules, credentials, runtime installations or OS settings. No trades, paid API calls or deployment. Create a new dated follow-up evidence folder; do not overwrite this audit. Capture code and protected-data hashes before starting.

## Required behavior

1. Request identity and normalized action payload are durable. An identical retry returns the same effect/result. Reusing an ID with different action/payload is a visible conflict, not a new effect or silent success. Preserve the original utterance, actor, requested action and timestamps.
2. Commit a durable idempotency record **in the same staged operation as each append effect**. A crash between the effect and receipt must leave enough committed evidence to rebuild the receipt without appending again. A combined effect/receipt transaction is also acceptable. Avoid wrapping functions that already acquire the workspace lock in a second non-reentrant lock.
3. Use request-scoped stable journal/event/transaction IDs or an equivalent durable mapping; ordinary manual actions keep their existing semantics. Check conflicts explicitly. Do not attempt to solve the broader transaction fingerprint, FIFO, decimal, transfer or benchmark findings in this task.
4. Receipt statuses distinguish verified committed/unchanged, failed/rejected and pending/deferred. A rejected short report or mismatched import cannot yield `done`. Define semantic outcome handling for each allowlisted action; do not infer success solely from absence of an exception. Failed/unverified operations cannot produce a success receipt.
5. Request publication must be safe: recommend `.tmp` plus atomic rename to `.json`, and avoid treating still-changing/incomplete files as permanent failures. Do not lose the original input on failure. Malformed completed files and unknown actions remain rejected by the allowlist/schema, with no effect.
6. Serialize competing processing of the same request using the existing workspace transaction boundary. If locking ownership changes are necessary for this guarantee, make only the minimal owner-token/live-process-safe fix and test it. An aged live PID must not have its lock stolen. Do not redesign backups/read snapshots as part of this task.
7. Existing queue actions outside the three append actions retain their behavior. Inspect their replay properties and document any remaining limitation honestly. Do not advertise universal exactly-once processing until every action is covered. If an action cannot be made safe within this scope, expose its unresolved state rather than silently retry an ambiguous effect.

Implementation choice is yours. Prefer a small shared operation context/builder or request idempotency mechanism over a parallel second queue store. Preserve backward compatibility: older records without request metadata remain readable; no automatic migration of the real ledger. New metadata must pass/update the actual schemas as needed without loosening unrelated validation.

## Meaningful acceptance checks

Run entirely in fresh synthetic folders:

- For each of journal, event and transaction: inject genuine child-process termination before commit, immediately after effect commit and before receipt/move, and during receipt processing. Restart, recover and replay multiple times. There must be exactly one committed effect, stable object identity and a truthful recoverable receipt.
- Run two separate queue processors against the same request concurrently. Assert one effect, no lost request, one authoritative result and no incompatible duplicate record.
- Repeat an identical ID/payload and a changed ID/payload. The first is unchanged; the second reports conflict. Verify the original remains intact.
- Submit a short report, a structured provider mismatch, an unknown action and malformed completed request. Assert no false `done`, no unauthorized effect and retained failure evidence. Slowly publish/atomically rename a valid request and assert pending→committed once.
- Preserve ordinary direct CLI/dashboard append behavior and existing receipt replay. A queued `add_transaction` must not rely on a payload fingerprint alone to establish its request identity.
- Test a >120-second-old live lock and dead-process lock, if ownership code changes. Owner release cannot delete another owner's lock. Verification failure retains evidence and cannot claim a done request.
- Run `node dashboard/cli.js test` and the new focused regressions. Reproduce the original forced-exit counterexample on fresh fixtures and show the corrected count remains one. Inspect the browser's Inbox/Requests success/failure/pending display against saved receipts.
- Compare protected hashes and installed task definition before/after. Report actual results, not only that tests ran. Keep the original report bytes and real portfolio empty/unchanged as found.

## Completion and rollback

Deliver a reviewable code diff, a concise description of the new transaction/idempotency contract, commands/results, any remaining action-specific replay limitations and links to synthetic evidence. Do not claim to have fixed the rest of the audit.

Before edits, preserve a code-only patch/snapshot of the relevant files and record current Git state if available; do not assume a clean repo. Roll back only this task's code changes if acceptance fails, preserving pre-existing user edits. Do not restore the whole live workspace or delete records as a code rollback. Leave synthetic evidence in the follow-up audit folder. If new optional request metadata is introduced, old code must continue to read existing records or a code-only rollback compatibility strategy must be provided. No real data migration occurs in this task.

After all checks pass, leave implementation ready for the user's review. Runtime upgrades, scheduler installation, external integrations and other audit priorities require separate bounded work.
