---
description: Run the Junior Trader pilot (Agent 1 research, then Agent 2 ticket) with isolated sub-agents. Usage: /pilot-run [project_id] [online|local]
---

Run the CryptoResearch autonomous pilot for: $ARGUMENTS

Read `DESK_STATE.md` first.

1. **Which desk and which projects.**
   - If the arguments name `local`, use this folder's desk: `node dashboard/cli.js tickets queue [<project_id>]`.
   - Otherwise use the online desk through the CryptoResearch connector: `autonomous_pilot_queue` (with `project` when one was named).
   - With no project named, take every project in the pilot.
2. **Dispatch each project's next step to a sub-agent, one project at a time.** Pass only the project ID, the desk (online or local) and the step's run or ticket ID.
   - `research`: launch the `forensic-researcher` sub-agent.
   - `ticket`: launch the `junior-trader-prosecutor` sub-agent, never in the same context as the researcher.
   - `ticket` with `refresh: true`: Eric re-opened an invalidated or out-of-date ticket; call `start_ticket` with `refresh: true` (CLI `tickets start <project_id> --reopen`) and run Agent 2 as usual. The old receipt is kept.
   - `gate_closed`: the grade alone rules out new risk for an asset Eric does not hold. Call `start_ticket` (or `node dashboard/cli.js tickets start <project_id>`) yourself, once: the desk saves its own gate receipt. Never launch the Prosecutor sub-agent for it, except under Eric's override below.
   - **Eric's override (2026-10-25).** When the desk's grade of Claude's `@6` report is 50 or more, or its range reaches 55 (read it from `autonomous_pilot_queue` with `candidates: true`, or `tickets candidates`), a `gate_closed` step, or a desk-gate receipt still waiting for his review, gets a Prosecutor anyway. Call `start_ticket` with `force_prosecution: true` (CLI `tickets start <id> --force-prosecution --assistant --mode cli`) and Eric's words as `owner_request`: "when a project's @6 grade is >= 50.0 (or its range straddles 55.0), start_ticket runs with force_prosecution: true". Then launch the `junior-trader-prosecutor` sub-agent on the ticket it opens. The desk's gate still sizes it ($0 under 55). Never do this on a desk gate Eric already decided.
   - `pm_review` or `done`: nothing to do; move on.

   After a sub-agent returns, read the queue again for that project (research is followed by a ticket). Stop at `pm_review`. Take at most 4 steps per project.
3. **Never decide a ticket, choose a dollar amount or place an order.** Eric decides on the PM Decision Card.
4. **End with one line per project:** the steps run, the report and receipt IDs saved, and the desk's last message.
   - Report a save only when the desk confirmed it (`verified: true`, or a receipt saying saved or unchanged).
   - If a step failed, say which step and why, and stop that project.
