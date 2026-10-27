# PM builder: the General Contractor and the Master Builder (2026-10-27)

**Eric's direction (2026-10-27):** "Choose Option 1: eng-app@4 as published. Core logic stays strictly in eng-backend@1, and UI work stays in eng-app@4." He then asked for a construction engine on the agent lane:

- a ChatGPT project manager, the General Contractor;
- picking tasks from `DESK_STATE.md`;
- having Claude Code, the Master Builder, build them in the existing sandbox;
- diagnosing failures and having Claude fix them, up to 3 times;
- signing off passing candidates for his merge.

## What changes in authority

Until now, a build started only from Eric's own `agent:build` label on an issue, and a fix only from his own `/revise` comment.

Now a task block in `DESK_STATE.md`'s **Active Backlog on `main`** also authorizes its build and up to **3 automatic remediations** of that task version.

This holds because only Eric updates `main`, by merging a pull request (ruleset `main-merge-authority`): a `[TODO]` block on main is his own act. The issue-and-label path and his `/revise` keep working unchanged.

## What did not change

- **Merging:** nothing in the lane merges, approves or writes `main`; Eric merges every pull request.
- **Rulesets:** the four rulesets, the sandbox (`.github/agent/claude-settings.json`), the secret separation, the guard, `agent-verify` and the review are unchanged.
- **The build** still runs Claude Code with read-only contents and only the Anthropic key. The builder App alone pushes `agent/**`, by lease.
- **Paid requests** (builds, remediations, reviews and diagnoses) are each reserved in the ledger before they are sent, sent once, and reconciled when uncertain.

## Corrections to the request (forced by existing boundaries)

| Asked | Built | Why |
|---|---|---|
| Branch `claude/<task-id>` | `agent/task-001` | The `automation-branches` ruleset lets the App push only `agent/**`. |
| Lock on open `claude/*` PRs | Lock on an open `agent/` PR, an unfinished agent-build run, or a paid attempt with no outcome | `claude/` matches the routines' and Eric's own branches, so it would hold the lane indefinitely. |
| The PM writes `[DONE]`/`[BLOCKED]` on `DESK_STATE.md` | Statuses are written on the candidate branch by the App | Nothing but Eric writes `main`. |
| A separate ChatGPT inspection for sign-off | Sign-off quotes `agent-review`'s verdict, now `cr-agent-review@2` with a per-check list | A second paid inspection of the same head adds cost and nothing else. |
| The PM runs Claude itself | The PM dispatches `agent-build.yml`, whose reserve re-checks everything | The sandbox, the secrets and the leases stay in one place. |
| `dashboard/web/src/components/StatusStrip.jsx` | `dashboard/web/src/views/watchlist/StatusStrip.jsx` | That is the real path. |
| Replace the numbered backlog | It is kept as the routines' list | `backlog-status.js`, `backlog-schedule.js`, the train and the scorecard parse it. |

## The status carve-out

`DESK_STATE.md` stays out of every candidate's reach, with one exception (`agent-backlog.js` `statusOnly`). A task candidate's copy may differ from its merge base **only** by status lines:

- **its own row**, `[TODO]` → `[IN_PROGRESS: PR #<its own pull request>]` or `[BLOCKED: Needs Human Architect]`;
- **other rows**, only `[IN_PROGRESS: PR #m]` → `[DONE]`. On main, that line can only have arrived by merging PR m.

Every other line must be byte-identical. A new `[TODO]`, an edited check or a reordered task is refused, so a candidate can never authorize later work.

## Ceilings and cost (`cr-agent-policy@3`; `@2` and `@1` frozen)

- **Per task version:**
  - 1 build;
  - at most 3 remediations;
  - at most 3 diagnoses.
- **Per day:**
  - diagnoses at most 9;
  - builds and remediations together at most 6, and $40.
- **Worst case per task version:** 4 Claude runs at the $8 cap ($32). Add 3 diagnoses (at most 6,000 output tokens each, with evidence cut at 40,000 characters) and the reviews of each head (at most 2 per head).

## Reliability hardening (Eric, 2026-10-27, four rules)

1. **60-minute lease and orphan release.** A paid attempt (build, revision or remediation) with no outcome holds its task for 60 minutes (`agent-ledger.js` `LEASE_TTL_MINUTES`; it was the build's 45-minute timeout and 20 minutes' grace). More than 60 minutes after it was reserved it is orphaned (a cancelled runner, an OOM, a dropped record).
   - The PM records it before it decides (`agent-pm.js` `recordOrphans`). The ledger line is an `outcome` with state `orphaned` and the note "Orphaned attempt expired after 60m; unlocking queue". It is written only when no agent-build run is running, since a live run may still record its own outcome. Each line is decided again on the ledger as written, by compare-and-swap. A reserve records it the same way in its own append.
   - An orphan consumes none of the version's builds or remediations: only an attempt that ran to an outcome does. Lines recorded `lost` before today read the same way.
   - It still counts toward the day's 6 builds and $40, so a runner that keeps dying stays bounded. A real outcome that arrives later makes it count again.
   - Publish refuses a build recorded orphaned, so a slow run that comes back after its lease never overwrites a later build.
2. **App token downstream.** Every push and pull request the lane makes was already the builder App's:
   - `agent-build.yml` publish, the pull request and the `[IN_PROGRESS]` status;
   - `agent-builder-lane.yml`'s `[BLOCKED]` status.

   Both jobs check out with `persist-credentials: false`, so git cannot push with the job's token, and they set the remote to the App's token before anything is pushed. A test now pins this.

   `GITHUB_TOKEN` writes only the ledger branch (no workflow listens to it), comments, and the PM's `workflow_dispatch` of `agent-build.yml`. GitHub documents `workflow_dispatch` and `repository_dispatch` as the events that start a run even from `GITHUB_TOKEN`, so the dispatch starts the build. Its publish, made by the App, starts test, agent-checks and agent-review.

   Moving the dispatch itself to the App would need the builder App granted Actions: write, which widens the App beyond publishing. That is Eric's setting, and it is not done here.
3. **One scheduled builder.** No workflow in the repository ran `backlog-schedule.js`. The hourly legacy builders are Claude Code cloud routines in claude.ai: builder A at :55 every hour, and builder B for the 2026-10-27 burst. `backlog-schedule.js` and the numbered backlog carry deprecation notes. A test pins that only `agent-builder-lane.yml` builds on a schedule: `agent-review.yml`'s sweep reviews and `scout-cron.yml` reads the web, and neither builds. Pausing the routines is Eric's (step 5 below).
4. **Velocity by merge time.** The briefing's `completed_today` counts agent pull requests with `merged_at` at or after 24 hours ago. `[DONE]` rows are history and never count.

Tests: `dashboard/tests/agent-pm.test.js` (the lease at 59, 60 and 61 minutes, the orphan release in `run()` against a temporary remote, the remediation ceiling with an orphan, the daily cap, a late outcome; the velocity filter), plus `agent-ledger.test.js`, `agent-guard.test.js` and `agent-workflows.test.js`.

## Eric's steps (none taken by this change)

1. Merge the pull request.
2. Set the repository variable `AGENT_PM_ENABLED` to `true` when the lane should act. Until then, each run only says what it would do.
3. Optional: `OPENAI_PM_MODEL` (else `OPENAI_REVIEW_MODEL` is used).
4. On Render: `CR_GITHUB_TOKEN`, a fine-grained read-only token for this repository (Contents, Pull requests, Actions). Without it, the briefing reads "unknown".
5. Pause the cloud routines "CryptoResearch backlog builder" (builder A) and builder B in claude.ai, so that only `agent-builder-lane.yml` builds on a schedule. This is his decision, and best done when the lane is on.

## Not verified yet

- The eng-app@4 bundle build on GitHub's runner with `npm ci --ignore-scripts`. Vite's native dependencies may need their install scripts.
- The `workflow_run` chain (agent-checks → agent-review → agent-builder-lane) and a `workflow_dispatch` sent with `GITHUB_TOKEN`, on this repository.
- A live diagnosis or remediation: none has run.
