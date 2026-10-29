# Overnight log: claude/overnight-hardening (2026-10-29)

Mission: `OVERNIGHT_MISSION.md.md` (Tasks 1–5 from `cryptoresearch-cohesion-audit.md`, M1–M5 and briefs 1–5). Branch based on `origin/main` `e7cadd9` (after #94's revert of the desk redesign; the branch's original tip `afa7185` was an ancestor of it, so it was fast-forwarded and carries no redesign). Baseline: `node dashboard/cli.js test` 1140/1140.

## Standing constraint: the protected files were not edited

`docs/CONSTITUTION.md` Invariant 3: protected accounting modules "require deliberate manual review and cannot be modified unattended", and `dashboard/tests/trader-boundary.test.js` makes each change to its list "its own supervised pull request, marked [P]". This run is unattended, so per the mission's safety-stop rule **no file on that list was touched** (`paper-trader.js`, `paper.js`, `trade-risk.js`, `decimal.js`, their tests, the intent schemas). Every task below is implemented in the unprotected layers (the adapter `trader-desk.js`, `tickets.js`, the agents' guard, the views). Where the audit's acceptance needs the engine itself, the item is listed under "[P] follow-ups" for Eric's own supervised PR.

## Task 1 — missing-hour uncertainty (M1, brief 1): done in the adapter

- `cr-trader-gap@1`: `applyHours` records each missing hour the book refuses (GAP) once in `paper/candles/gaps.jsonl` (create-only; first sighting kept across later reads and restarts).
- `settlementOf`: a pair the book holds or has a live order in (ACKED/zero-fill, PARTIAL, open position, live sell) is unsettled while its missing hour is not on record, or while it has no hour for over 120 minutes. Any unsettled pair, or an unreadable gaps line, makes the book unsettled.
- While unsettled: every new opening waits in words (covers the audit's ACKED/zero-fill case: the recorded $25,000 / $0 drawdown is no longer offered as room to risk); a buy's unfilled part is not cancelled over its missing hour; `view` and `requests` carry `settlement`, and `results.unknown` says the figures are recorded balances; Outcomes labels NAV, cash, results and drawdown "(recorded)" with a warning line.
- Late hour: applies once, in order (quiet and breach cases tested; the stop fires once).
- Tests: `dashboard/tests/trader-desk-gaps.test.js` (5), `trader-book-model.test.js` (+1). Shared fixture moved to `dashboard/tests/trader-fixture.js`.
- Not done (needs [P]): the gate inside `reserveIntent` itself (today the adapter is the only opening path, enforced by `trader-boundary.test.js`, so the adapter gate covers every supported path, but not a future direct caller); a cancel recorded while the pair's hours lag behind real time can still drop a fill in an hour not yet applied (engine semantics, observed, not changed).

## Task 2 — one atomic, bounded opening (M2, M4, M7, brief 2): done in the adapter (`cr-trader-desk@2`)

- `fit(intent, book, rules, venue)`: the opening is checked with the engine's own `validateTradeIntent` over the same `PT.book`, plus the book's free-cash rule, before the decision's one intent ID is spent. Anything the book would refuse now waits in words; no refusal is recorded, so a temporary refusal no longer kills the decision (M2). No `open-2` IDs: the one ID per decision is kept (IDs keep the `@1` derivation).
- M4: approved risk is a ceiling. When the full amount breaks an upper limit (risk cap, drawdown, gate/PM cap, notional cap, exit size, free cash), the risk is bisected at 18 places to the largest every limit allows; the engine floors to the lot, so one lot more breaks the binding limit, which the request names (`sizing.binding`). Never above Eric's amount.
- M2 sequencing: a re-grant while the ticket's earlier position is still closing waits until flat, then opens once at its full grant (not sized around the closing position).
- Horizon / invalidation: checked before every opening; past the horizon or invalidated, nothing is reserved.
- M7: an order whose life holds no whole hour after it is sent waits for one (a life under 60 minutes says so and points to Preferences).
- Behavior change Eric should know: the 12a demonstration's Approve $500 now opens 2,352.941176 units at the $2,000 exit size instead of being refused (test and DESK_STATE updated).
- Tests: `dashboard/tests/trader-desk-opening.test.js` (5: lot/cent/cash/notional/equality boundaries against the engine, close-in-flight → wait → flat → one opening, horizon, M7).
- Not done (needs [P]): true atomicity. The adapter's check and the engine's reservation are two reads; within one process `step` is synchronous, but another process changing the book between them can still produce a recorded (final) refusal. The engine-side fix is a "would refuse → do not record" mode, or the solver inside `reserveIntent`, under its lock.

## Task 3 — exit-evidence renewal (M3, brief 3): done (`cr-ticket-exit-evidence@1`)

- `tickets.js` `exitEvidenceOf`: the same rule as the engine's `exitCapOf` (complete, within the frozen limit, newest reading + 72 h), read from the verified packet; `view` exposes `exit_evidence {state, expires_at, expired, words}`.
- Approve/Halve on expired readings: 409 `EXIT_EXPIRED` inside the decision's lock (`grantBlock`), nothing written; `frontdoor.js` maps it with `changed`.
- Renewal: `reopenReason` kind `exit_expired` while no grant is in force; the card's Re-open reads "Renew exit evidence". Idempotent (same request, or a second click, is `unchanged`); old receipt byte-for-byte unchanged; the successor ticket needs a new Prosecutor save and Eric's new decision (no consent carried over, no model asked from a read).
- Card: Until/Expired under Exit, the expiry sentence as an alert, grant buttons disabled when expired; the decision toast appends the trader's answer and turns to the warning tone for `not_opened`/`failed`.
- Tests: `dashboard/tests/ticket-exit-renewal.test.js` (3).
- Not done: autonomous renewal dispatch (the audit defers it to a budgeted policy); a grant already in force whose readings expire before the book is asked still ends `not_opened` in words (renewal then is Undo, then Renew).

## Task 4 — practical role isolation (M5, brief 4): done locally (`cr-pilot-isolation@1`)

- `dashboard/scripts/pilot-role-guard.js`: per-role scratch `<temp>/cr-pilot/<role>/` (Write and import `--text-file` only there); the hook now also guards Read, Grep and Glob: no desk record folder, no other temporary folder (the other role's scratch, other sessions'), no `~/.claude` (transcripts), no search starting above one, no Glob pattern escaping its start; links resolved before the check.
- Agent files: matcher `Bash|Write|Read|Grep|Glob`, bodies name the role's scratch folder; `dashboard/scripts/pilot.js` writes each agent's text in its role's scratch.
- Tests: `dashboard/tests/pilot-isolation.test.js` (6: allowed/denied reads per role, searches, writes and imports, a junction inside a role's scratch, Git Bash spellings, the hook as a process); `pilot-role-guard.test.js` updated.
- Not done (Eric's decision): a server-side Researcher/Prosecutor capability split on the connector. Today one Claude connection lists both research and ticket tools; on the online route the agent files' tool lists (client configuration) are the boundary. A server-enforced split needs its own scope/policy, not a role name in an argument.
