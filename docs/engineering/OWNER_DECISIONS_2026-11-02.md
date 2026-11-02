# Eric's open decisions (2026-11-02)

A proposal for Eric to answer, edit or close. Nothing here is an approval, and no code reads it. Each answer takes effect only when Eric records it, by merging the change that carries it or by setting the value himself.

Basis: `main` at `fb529e5`; the implementation audit of 2026-11-02 (§8, §9); the combined blueprint's §11, which is a proposal (PR #134, closed unmerged at `b462db6`).

## Status now

| | State |
|---|---|
| Rows T0, 1–8, 10–12 | Merged. Deployment not verified: no deployed SHA has been read back. |
| Audit fixes F1, F2, F4, F5, F6 | Merged (#146, #147, #148, #149, #150). |
| Audit fixes F3, F7–F11 | Open pull requests, one each. |
| Row 9 (protected stamp), Ops-1, B0–B3 | Proposed. No operating record exists. |

Canary readiness: **not ready.** Nothing merged is verified as deployed, no unattended run has an operating record, and B0 has not started.

## Q1. Runner host

- **Now.** The production runner is the PC's scheduled task. The code supports environment credentials (#138) and recovery on an ephemeral disk (#141). No Render cron exists, and no cutover was recorded.
- **Options.** (a) Keep the PC. (b) Move to a Render cron job after a drill. (c) Run both. Rejected: two hosts would contend for one lock and one claim.
- **Recommendation: (b), after Ops-1, and keep the PC through B0–B3.**
  - The drill is a Linux dry run, the desk down mid-run, and the runner killed mid-session. Each one is recorded.
  - An answer can be lost when the desk is unreachable until the run ends. The claim then reads `reconcile`, never auto-LOST.
- **Cost.** One Render service and its secrets, which Eric creates. The PC task is disabled at cutover.

## Q2. Heartbeat and STALE

- **Now.**
  - Optional pings go to `CR_HEALTHCHECK_URL` (#139): `/start`, then one final ping by health class.
  - The sighting reads STALE after 120 min at `--max-agents=1`. The threshold is raised to `maxAgents × 95 + 15` (205 at 2, 395 at 4).
  - Vendor adoption and the value are unapproved.
- **Recommendation.**
  - Adopt Healthchecks, alerting Eric only.
  - Set STALE to 120 at hourly cron with `--max-agents=1`.
- **Overlap alarm (from F10, Eric's call).**
  - The blueprint (§6.1 rev-3) says a run that finds the lock held pings `/fail`. The F10 pull request keeps that behavior. On the PC, an hourly run that outlasts the hour then alarms on every overlap.
  - Recommendation: treat a held lock that is not stale (under 3 h) as `idle` and ping `/0`. The holder's own `/start` and final ping already cover liveness. A lock older than 3 h is taken over by the next run, which says so in its output (`pilot.js` `takeLock`).
  - The run is still labelled `attention-overlap` in its log either way.

## Q3. Grouping and minimum sample

- **Now.** The attribution view groups by decider kind × Claude researcher model version × execution policy. It shows counts and rows only, with no rate at any count.
- **Recommendation.**
  - Keep that grouping key.
  - Show no rate before 50 closed positions per group. A hit rate's 95% interval is about ±0.98/√n: ±22 points at 20, ±14 at 50.
  - Provider, model version and role stay separate dimensions. Grades are never banded or ranked.

## Q4. Protected-core execution stamp (row 9)

- **Now (option B in effect, pending Eric).** The book's events do not record the engine revision, `FILL_SHARE_MAX` or the `trader.rules` digest. The basis reads them as `not_recorded`, never the current values.
- **Recommendation: option A.** It is a protected-core pull request, reviewed by hand under `docs/CONSTITUTION.md:50`.
  - It adds `engine`, `fill_share_max` and `rules_sha256` to `reserved`, and `engine` to `fill` and `exit`.
  - Old journals replay unchanged.
  - The same pull request is where an exported journal check would close F5's remaining limitation: an ABA rewrite that passes the book's own checks.
- **If declined.** B stands. The three facts stay `not_recorded`, and a deploy between a reservation and its fill is evidenced from Render's deploy record.

## Q5. B2 gating

- **Recommendation.** Hold B2 until all three hold:
  - row 8 (the decision basis) is merged and deployed;
  - F1, F3 and F6 are merged and deployed (F1 and F6 are merged; F3 is open);
  - the deployed SHA is read back by Eric.
- B0 and B1 can proceed without it.

## Design of record

- **Now.** #134 is closed unmerged, so the blueprint the merged rows cite is not on `main`.
- **Recommendation.** Leave #134 closed as history. Record Eric's answers to Q1–Q5 here, or in `DESK_STATE.md`, by his merge. That record, not the blueprint, becomes the design of record.

## Baseline and fee drag

- **Now.**
  - Fee totals already sit beside closed net P&L (`grade-outcome-view.js`), so fees are not absent.
  - There is no buy-and-hold or inverse shadow comparison.
- **Options.**
  - (a) A buy-and-hold shadow per position: same pair, entry hour to exit hour, no fees, shown beside net P&L as its own row.
  - (b) (a) plus fee drag stated as gross minus net, in dollars, with its denominator.
  - (c) Neither.
- **Recommendation: (b).** It is descriptive only: no rate before the Q3 minimum, and never fed back into a grade.

## Also for Eric

- **Flaky test.** `arm-desk.test.js` "admission-only patch" can fail when the server's own job timer writes `logs/jobs-state.json` during the test's file-hash comparison. It failed in F4's first CI run (41518648358) and once in a local F3 suite run. It passed on rerun each time, and no fix touched it. Fixing it is a test-only change, if Eric wants one.
- **CONSTITUTION.md.** Its one-line change in #144 (a link to `ONE-SHEET.md` at line 75) came in through Eric's merge. No later change touches the file.
