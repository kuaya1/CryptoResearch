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
