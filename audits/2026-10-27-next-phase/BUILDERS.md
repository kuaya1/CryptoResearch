# Builder burst and the backlog scheduler (2026-10-27)

Eric asked for up to ten backlog items an hour across all builders until
2026-10-27 23:00 New York time, then the limits before it, on the existing
Claude routine arrangement, with claims, dependencies, retries, recovery,
tests, reviews and release controls kept. This file is what was built, every
limit that applies, how it was verified, what is live, and how to undo it.
The blueprint and the backlog it schedules are in [README.md](README.md).

## What changed

| Part | Before | Now |
|---|---|---|
| Who decides what a run builds | The routine's prompt (an instruction) and `backlog-status.js` (advice) | `dashboard/scripts/backlog-schedule.js` (`cr-backlog-schedule@1`), which claims atomically; the prompt only follows it |
| Builders | A, hourly at :55 | A at :55, and B at :25 during the burst only |
| Duplicate prevention | One routine, so none was needed | A claim branch per item, `claude/claims/item-<n>`, replaced only by compare-and-swap |
| Independence | Strict list order, one stacked chain | List order, but an item waits only for what it comes after or shares files with; the run moves on to the next independent item |
| Limits by time | Hard-coded twice (prompt and `backlog-status.js`) | One table, `CAPACITY` in `backlog-status.js` (`cr-backlog-capacity@1`); the windows end on their own |
| Recovery | A dead run left nothing to recover; a red suite stopped the run | Leases (90 min), heartbeats, a 30-minute retry wait, blocking after 2 failures or 3 lost runs |

Files: `dashboard/scripts/backlog-schedule.js` (new), `dashboard/scripts/backlog-status.js`
(capacity windows, `Schedule:` lines, `gather`), `dashboard/tests/backlog-schedule.test.js`
(new, 14 tests), `.github/workflows/test.yml` (claim branches start no run),
`DESK_STATE.md` (the batch rule now points at the scheduler), and the routine
prompts here: `routine-a-before.txt` (the live prompt this replaces, SHA-256
`96452680ad156938e050b924983d20e6d7ee6ff2b001f9d3bb14109e1fd1b818`),
`routine-a.txt`, `routine-b.txt`.

## Every limit, before and after

| Limit | Where it lives | Before | Burst (until 2026-10-27 23:00 ET, 2026-10-28T03:00Z) | Surge (until 2026-10-28 23:00 ET) | After |
|---|---|---|---|---|---|
| Builders | `CAPACITY.builders`, routines | A | A, B | A | A |
| Items a run claims | `CAPACITY.per_run` | 5 (3 after the surge) | 5 | 5 | 3 |
| Items started by all builders in any 60 minutes | `CAPACITY.per_hour` | none (one run an hour) | **10** | 5 | 3 |
| Waiting for merge plus in flight | `CAPACITY.cap` | 15 waiting (6 after) | 20 | 15 | 6 |
| Claim lease | `LEASE_MS` | none | 90 min, renewed after each item | same | same |
| A run's own deadline | routine prompt | none | stop starting items after 70 min (4200 s), release the rest | same | same |
| Retry after a failure | `RETRY_MS`, `MAX_FAILURES` | none | after 30 min; the second failure blocks | same | same |
| Lost runs before blocking | `MAX_LOST` | none | 3 | same | same |
| Engineering lane admissions | engineering template (`max_admissions_per_day`, `max_open_tasks`) | 3–5 a day, 2–3 open | unchanged | unchanged | unchanged |
| Engineering candidate pushes | counted by `otherLaneLastHour` | separate | count toward the hour's budget | same | same |
| Agent lane (`agent-build.yml`, paid API key) | label `agent:build` | inactive | not used | not used | not used |
| `candidate-review` (OpenAI) | workflow setting | off | unchanged | unchanged | unchanged |
| Merges | exclusive merge authority (PR #33) | Eric merges every PR | unchanged | unchanged | unchanged |
| CI per branch | `test.yml` concurrency per ref | one run per branch | unchanged; claim branches run nothing | same | same |

**Why not ten workers.** A cloud routine has no sub-agents, so parallel work
means overlapping routine runs. Two builders a half hour apart, five items a
run, give at most ten items started in any hour without either one waiting on
the other. "Ten" is a ceiling the scheduler checks against claims (`claimed_at`
in the last 60 minutes, every builder's, plus engineering candidate pushes);
a run that finds the hour spent claims nothing and says so.

**What the Claude usage is.** Both routines run on Eric's existing claude.ai
plan, in the same environment (`env_01ACv9yP8oQCiw19ocLwFGdf`) and model
(`claude-sonnet-5-5`) as before. No API key, no new subscription, no extra-usage
setting was touched. A routine run draws on the plan's usage limits; when they
are reached, runs stop or fail. Nothing here buys credit, and the plan's
allowance is not API credit.

**What did not change.** No authority was widened. Builders still never push
to `main`, never merge, never force-push, never open pull requests, never edit
`.github/`, `DESK_STATE.md` or `CLAUDE.md`, and never touch records, keys,
settings, research runs, tickets or paper positions. `backlog-pr` still opens
one pull request per branch and never merges. Eric still merges each one.

## How the scheduler decides

1. **Read.** `git fetch`, then main's backlog, the trailers on main and on
   unmerged `claude/backlog-*` and `claude/candidate-eng-*` branches, the base
   (the newest waiting backlog branch, else main), and every claim.
2. **Window.** `limitsAt(now)` picks the capacity row. A builder not in the
   row's `builders` gets nothing (builder B outside the burst).
3. **Room.** `in flight` = claims building under a live lease. Room is the cap
   less (waiting + in flight), the hour's budget less what started in the last
   60 minutes, and the run's own size; the smallest wins.
4. **Pick.** In list order, skip: ticked, *(Eric)*, engineering, taken,
   claimed and live, blocked, or failed within 30 minutes. An item waits when
   an item it comes `after` is unbuilt, in flight, or only on a branch that is
   not the base; or when an in-flight item, or a waiting item not on the base,
   `touches` the same file or folder. An item with no `Schedule:` line touches
   everything. Items a run takes together may share files (it builds them one
   after another).
5. **Claim.** One commit per item (empty tree; the message is the JSON record
   `cr.backlog-claim.v1`: item, builder, run, state, window, claimed_at,
   lease_until, base, branch, failures, lost, previous), pushed together with
   `--atomic` and `--force-with-lease=<ref>:<the tip read>` (or `''` for a new
   one). If another builder moved a claim first, the push is refused, nothing
   lands, and the run plans again (three tries).
6. **Build, heartbeat, done.** The run renews its leases after each committed
   item, checks before pushing that it still holds every item (a run that
   outlived its lease pushes nothing), pushes its branch, then marks each item
   `built` with the branch. From then on the trailer on the branch makes the
   item taken; if the branch disappears unmerged, the item blocks for Eric.
7. **Fail, release, lose.** `fail` records the reason (blocked at the second);
   `release` frees an item at once and does not count in the hour; a lease
   that ends without a word makes the item `lost` and free again (blocked at
   the third loss). A late `done`, `fail` or `heartbeat` from a run that lost
   its claim is refused.

## Activation

| Step | Who | State |
|---|---|---|
| Routine A's prompt replaced with `routine-a.txt` (same cron `55 * * * *`, model, tools, environment, repository) | this session | see the hand-back for the result |
| Routine B created from `routine-b.txt`, cron `CRON_TZ=America/New_York 25 0-22 27 10 *` (00:25–22:25 New York on Oct 27) | this session | see the hand-back |
| Merge the blueprint PR (`claude/next-phase-blueprint`: Phase 6 items with `Schedule:` lines, 46 retired, 52–66 ticked) | **Eric** | waiting |
| Merge the scheduler PR (`claude/builder-burst`) | **Eric** | waiting |
| Delete routine B after 2026-10-27 23:00 ET | **Eric** (optional) | B stops itself: its prompt reports "burst over" from 2026-10-28T03:00Z, and the scheduler gives builder b nothing outside the burst. Its cron would next match on 2027-10-27. |

Until the scheduler PR is merged, routine A follows its `LEGACY` section (the
rule before this change: five a run, cap 15) and routine B reports "scheduler
not on main yet" and stops. So the burst's capacity starts the moment Eric
merges, not before, and ends at 2026-10-27 23:00 ET whether or not he merged.
Merge the blueprint first: without it the scheduler sees only item 46, which
touches protected paths.

## Verification

`node dashboard/tests/backlog-schedule.test.js` (also in `node dashboard/cli.js test`),
on a bare origin with two clones and a fictional backlog of seven items:

| Case | Test |
|---|---|
| Windows at their edges; B refused outside the burst; A back to 5 an hour, then 3 | capacity windows; at the window's end |
| Overlapping runs: B skips what A is building and what it touches, and continues to independent work | overlapping runs |
| Duplicate claims: two processes racing over real git never hold the same item; the loser's stale push is refused | duplicate claims |
| An atomic claim of several items lands whole or not at all | atomic claim |
| Blocked dependencies: `after` waits for an unbuilt or off-base item; shared files wait | dependency waiting on another branch |
| Hour budget: eight claims leave two; two engineering pushes leave none; claims older than an hour do not count; the cap of 20 | the hour budget |
| Failures: retry after 30 minutes; the second failure blocks; the next independent item is still taken | failures |
| Restart recovery: a dead run's items are free after 90 minutes; its late `done` is refused; the third loss blocks | restart recovery |
| Long runs: heartbeats keep items; a release frees one at once | heartbeat |
| Built and gone: the pushed branch makes an item taken; a branch deleted unmerged blocks it | built |
| `plan` writes nothing; an unreadable claim blocks its item | plan writes nothing |

The existing `backlog-status` tests pass unchanged. Results of the full suite
on this branch are in the pull request.

## Risks and what to watch

- **Rulesets.** `.github/rulesets/automation-branches.json`, when Eric applies
  it, lets no identity but the admin create branches outside `agent/**`,
  `agent-ledger`, `visual-proof`, `claude/intake-issue-*` and
  `claude/admission-*`. The builders push `claude/backlog-*` and
  `claude/claims/*` through the Claude GitHub App, so applying that file as it
  is stops both builders. Before applying it, Eric adds those two patterns to
  its `exclude` list (a `.github/` change, his).
- **Two branches on one base.** When A and B run at once they may each start
  from the same base. Their items share no files by construction, so either
  merges first; the second may need `git merge main` if both touched the same
  line of a file neither declared. The claim's `touches` is the builder's
  promise; the prompt tells it to stay inside.
- **Claim branches accumulate.** One per item, kept as the record. Deleting
  `claude/claims/item-<n>` frees the item again (a blocked one included), so
  delete only after its work is merged or abandoned.
- **Clock.** Leases and windows read the builder's clock (UTC in the cloud).

## Rollback

1. Routine A: update its prompt back to `routine-a-before.txt` (RemoteTrigger
   `update`, or the routine's page on claude.ai). The legacy section of the new
   prompt already behaves the same while the scheduler is not on main.
2. Routine B: delete it (or disable it).
3. Code: revert the scheduler PR's merge commit; `backlog-status.js` keeps
   working without it.
4. Claims: `git push origin --delete claude/claims/item-<n>` for each, after
   the work they point to is merged or given up.
