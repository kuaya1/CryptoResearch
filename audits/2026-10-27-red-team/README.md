# Red-team review: engineering pipeline and trader (2026-10-27)

Eric's "Executive Red Team Directive" asked Claude to attack its own Architecture Recovery work, prove which safeguards hold, correct confirmed defects inside the approved scope, and hand back evidence another reviewer can check. This is that handback.

No independent review of this work has happened. Everything below is Claude's own reading, tests and reproductions. Each claim says whether it was confirmed (run or read in code or a live API) or inferred.

## Verdict: CHANGES REQUIRED

- The agent lane's core holds under the attacks tried: owner-only authorization, re-reading the issue, the ledger's compare-and-swap, run-status settlement, the publish lease and the sandbox.
- Unattended cutover is still blocked by findings that only Eric can close:
  - **R-F2:** a pull request's own workflows produce the required checks, and every secret is repository-wide.
  - **R-F5:** "only Eric merges" means only the kuaya1 credential merges.
  - **C-1:** three claim systems and four orchestrators still exist.
- Two P1 code defects have corrections:
  - **R-F3** (owner pass), in #60, which is still open;
  - **B-1** (clock reclaim), in #62, which Eric merged as `d74242b`.
- The trader engine on `main` has two P0 accounting defects. Nothing calls it. They are corrected in #63, which is not yet independently reviewed.

## A. Baseline

### Main and this review's PRs

| When (UTC) | `main` | What |
|---|---|---|
| Start | `6b1e876` | The investigation and #60 were cut from here. |
| 21:34:25 | `8e8eae0` | Eric merged #56 (pipeline review alignment: issue queue, run-status settlement, atomic publish, `cr-paper@2` contract). |
| 22:24:29 | `93e3ddd` | Eric merged #61 (this review). |
| 22:32:08 | `d74242b` | Eric merged #62 (this review), after updating its branch with `main` (`0fc4620`). This report is based on it. |

| PR | Scope | Base → head | State |
|---|---|---|---|
| [#60](https://github.com/kuaya1/CryptoResearch/pull/60) | Agent lane release gate: L1 Windows name clashes, L2 owner pass, L3 head-pinned `eric-reviewed` | `6b1e876` → `77915e8` | Open; merges cleanly with `d74242b` |
| [#61](https://github.com/kuaya1/CryptoResearch/pull/61) | Recovery: B7 a landed publish never remediated, R1 re-runs publish nothing | `8e8eae0` → `8c33bf1` | Merged by Eric (`93e3ddd`) |
| [#62](https://github.com/kuaya1/CryptoResearch/pull/62) | Backlog claims: a lease that ends frees nothing (reconcile required) | `8e8eae0` → `1c11257` | Merged by Eric (`d74242b`) |
| [#63](https://github.com/kuaya1/CryptoResearch/pull/63) | Trader: `cr-trade-risk@1` and `cr-paper@2` corrected before any record | `6b1e876` → `9439053` (the fix); merge of `93e3ddd` `e296836`; contract note, head `e3a6b03` | Open; merges cleanly with `d74242b` |
| This PR | This report | `d74242b` | Open |

### GitHub, read live on 2026-10-27

- **Rulesets:** four, all active.
  - `25967714` agent-ledger.
  - `25967715` automation-branches.
  - `25967716` main-merge-requirements: pull request, strict up-to-date, and the required contexts `test`, `agent-guard`, `agent-verify` and `agent-review`, each bound to integration 15368 (GitHub Actions); no bypass.
  - `25967717` main-merge-authority: only the admin role, through a pull request.
  - All four were created 2026-10-27T14:58Z. Their raw JSON is in the release audit's working files (not committed).
- **Environments:** 0.
- **Secrets** (names only): `AGENT_LEDGER_KEY`, `ANTHROPIC_API_KEY`, `BUILDER_APP_KEY`, `CR_ENG_REVIEWER_TOKEN`, `OPENAI_API_KEY`.
- **Variables:**
  - `AGENT_REVIEW_ENABLED=false`;
  - `CANDIDATE_REVIEW_ENABLED=false`;
  - `BUILDER_APP_ID=5487887`;
  - `BUILDER_APP_SLUG=kuaya1-cr-builder`;
  - `OPENAI_REVIEW_MODEL=gpt-6-luna`;
  - `DESK_URL`;
  - `AGENT_PM_ENABLED` unset.
- **The `agent:build` lane:** live, and exercised once end to end. Issue #49 → `agent/issue-49` → PR #50, merged at 16:41:09Z. Its `agent-review` was Eric's `eric-reviewed` dispatch (run 40543264687), not a model review. Issue #49 is still open and still labeled `agent:build`.
- **The PM lane** (`agent-builder-lane.yml`): it runs on every `workflow_run`, and is off. Run 40594037199 ends "Done: off — The PM is off (AGENT_PM_ENABLED is not "true"…)".
- **The backlog routines:**
  - A, `trig_01Hw89ZHE8kWp2rQe3Kw3D26`: `enabled: false`, last fired 18:55:35Z.
  - B, `trig_01Adw24sNdYAtXTTyu13PqrW`: `enabled: false`, last fired 18:25:33Z.
  - Both read through the routines API.
- **The `agent:ready` issue queue** (`backlog-queue.yml`, from #56): no live run has authorized an item yet.
- **The engineering inbox:** four admitted tasks with no worker, per the Gate 0 baseline. Not re-read in this pass.
- **Claim refs:** `claude/claims/item-67` through `item-74` exist.
  - Items 67–72 are on `main` by squash merge (#45, #46), so their branches are not ancestors of `main`.
  - Items 73–74 were rebuilt by hand (#58, #59). Their earlier branch is `claude/backlog-batch-items-73-and-74` (`73c1504`, #55 closed).
- **Other branches still present:**
  - `claude/backlog-batch-items-67-68-69-70-71` (`b9d4b79`) and `claude/backlog-item-72` (`15beeec`);
  - `claude/candidate-eng-63` through `-66`;
  - `agent/issue-49`.
- **Runs in progress at the time of reading:** one PM run, which ends "off".

### Where things are

- The lane and backlog scripts live in `dashboard/scripts/`: `agent-ledger.js`, `agent-guard.js`, `agent-verify.js`, `backlog-schedule.js`, `backlog-promote.js` and `backlog-queue.js`.
- The trader and desk modules live in `dashboard/core/`: `trade-risk.js`, `paper-trader.js`, `paper.js` and `tickets.js`.
- There is no `AGENTS.md`.
- The repository's instructions are `CLAUDE.md`, `COWORK-INSTRUCTIONS.md`, `DESK_STATE.md` and `.github/agent-policy.json` (`cr-agent-policy@3`).

## Evidence matrix (Rule Zero)

Citations are at `d74242b` unless marked. #62 changed only `backlog-schedule.js`, its test and one `DESK_STATE.md` line, so every other citation reads the same at `93e3ddd`.

| Requirement | Source | Behavior on `main` | Test evidence | Gap | Correction |
|---|---|---|---|---|---|
| Only Eric authorizes a build | `agent-guard.js:158` `authorize`, `:171` `liveCheck`; `agent-build.yml` reserve | Only the owner, as a User, labeling `agent:build` counts. The issue is read again before anything is spent. | `agent-guard.test.js:79`, `:296`; live #49 → #50 | An agent holding the kuaya1 credential is Eric to GitHub (R-F5) | Owner decision |
| One execution owner per task | `agent-ledger.js:171` `transact` (compare-and-swap), `:218` `settleOpen` | Ledger appends are CAS on `agent-ledger`. An open attempt settles only from GitHub's run status; an unreadable run holds as reconcile required. | `agent-ledger.test.js:55`, `:142`; `agent-guard.test.js:338`, `:373` | Three claim systems: the ledger, `claude/claims/*` refs and the Render leases (C-1) | Owner decision |
| A stale worker cannot publish | `agent-guard.js:329-397` `publish` (`:368`: `--atomic` with `--force-with-lease` on both refs, explicit expected values) | A branch moved, made or handed on since the reservation is stale, and nothing goes up by halves | `agent-guard.test.js:403`, `:458`; GitHub's receive-pack advertises `atomic` (dry run, nothing written) | Backlog lane: until #62, an ended lease reclaimed the item by the clock (`backlog-schedule.js:109-112` at `93e3ddd`; B-1). A late push after Eric releases a claim is still unfenced. | #62, merged (the reclaim); the push fence is a residual |
| No silent retry after an uncertain action | `agent-pm.js` `publishOf` (from #61) | The ledger's `publishing` line decides, never the job's word | `agent-pm.test.js:252` | Was B-7 | #61, merged |
| GitHub enforces the release conditions | `main-merge-requirements`; `agent-checks.yml:67-76`; `agent-guard.js:489` | A neutral `agent-review` for any pull request that is not an agent candidate | `agent-guard.test.js:215` | Owner pass for anything (R-F3); head-defined workflows produce the required contexts (R-F2) | #60 (R-F3); R-F2 is the owner's |
| Eric's review binds to the head he read | `agent-review.yml:94-105` | `eric-reviewed` posts on the head as it is at run time | none on `main` | R-F4 | #60 L3 |
| The builder cannot widen its scope | `agent-guard.js:210` `checkChange`; `backlog-promote.js` `PROTECTED` | Symlinks, the executable bit, submodules, binaries, traversal, 8.3 names and protected paths are refused | `agent-guard.test.js:89`, `:141`; sandbox audit `repro.js`, `repro2.js` | A new name that is one file on Windows with an existing one passed (S-1) | #60 L1 |
| Build sandbox | `agent-build.yml` build job; `.github/agent/claude-settings.json` | bwrap, npm-only proxy, key unset for commands, PID namespace | Probe run 40530698111: 12/12; `agent-workflows.test.js:74` | `test` and `agent-verify` run candidate code outside any OS sandbox (S-2) | Owner decision |
| Disabled stays disabled | `agent-builder-lane.yml:20`, `:69`; variables; routines | The PM is off, review is off, both routines are disabled | Run 40594037199; #50's `agent-review` "model review is off" | none found | — |
| Trader: unknown stays unknown | `paper-trader.js:423-431` `recover`, `:441` | A `RESERVED` order is cancelled blind at restart; an unreadable venue record reads as empty, so `NOT_FOUND` | `trader-boundary.test.js:42` checks the contract text only | T-P1-3, T-P1-4 | #63 |
| Trader: risk ceilings | `trade-risk.js:199`, `:224-228` | The drawdown and the grant are checked one intent at a time | `trade-risk.test.js` | Risk not summed (T-P0-1) | #63 |
| Trader: fills inside the hour | `paper-trader.js:532` | A buy fills at its limit even when the hour opened below it | `paper-trader.test.js` | T-P0-2 | #63 |
| Trader modules protected | `backlog-promote.js:75-76`; `engineering/policy.js:229-230` | Protected by name and by glob | `trader-boundary.test.js:32`, `:115` | none | — |
| Nothing calls the trader | (absence) | No route, CLI, connector or UI reaches `trade-risk.js` or `paper-trader.js` | `trader-boundary.test.js:124`, `:134` | none | — |

## B. Findings

**Labels:**
- R: release;
- B: execution authority;
- C: consolidation;
- S: sandbox;
- T: trader.

**Confirmed** means reproduced in a fixture, or read in code or a live API. **Inferred** means it follows from how GitHub works but was not shown.

### P0: safety-critical

**T-P0-1. Risk was not summed.** Confirmed.
- **Where:** `trade-risk.js:199`, `:224-228` (`6b1e876`, unchanged at `d74242b`).
- **Reproduction:** five intents of 50 under a grant of 250, each checked alone.
- **Observed:** all five pass, holding 500 at their stops (adversarial script a01, then its regression test).
- **Expected:** the grant and the 24-hour ceiling hold across everything open.
- **Root cause:** `validateTradeIntent` saw one intent and the book's past drawdown, never the risk already open.
- **Correction:** #63 adds `book.open_risk_usd` and `book.thesis_risk_usd`. Either one unknown refuses.
- **Capability:** none live; nothing calls the engine.

**T-P0-2. Fills outside the hour's range.** Confirmed.
- **Where:** `paper-trader.js:532`.
- **Reproduction:** a buy limit of 100 in an hour that opens at 95.
- **Observed:** filled at 100.
- **Expected:** filled at 95 or better.
- **Also:** a target filled at its limit when the hour opened above it, and a limit through the market was accepted.
- **Correction:** #63. A buy fills at min(limit, open), a close or target at max(limit, open), and `through_market` is refused.

### P1: release blockers

**R-F1. #23, #24 and #29 were released without the review the desk required.** Confirmed. Historical, not rewritten.

What happened:
- kuaya1 merged them on 2026-10-26 at 15:26:39Z, 15:42:08Z and 18:59:14Z.
- At the time, `main` had no ruleset (all four were created 2026-10-27T14:58Z) and no branch protection.
- Only `test` ran on their heads.
- The desk recorded `eng-20261026-1b9979` (#29) as `review_pending` at merge.
- For #23 and #24, ChatGPT "pass" reviews were saved from the task's own submitter connection. Rule N4 makes those non-deciding, so `pending` is correct.

Answering the directive's question, this was a genuine owner merge with no qualifying review. It was allowed because GitHub enforced nothing then. It was not a stale display.

Today's equivalent path was the owner pass (R-F3). #60 closes it.

**R-F2. A pull request's own workflows produce the required checks.** Confirmed live, on #48. Open; owner decision.
- **Where:**
  - `test.yml:10-14` and `agent-checks.yml:22-25` run from the head;
  - `agent-checks.yml:42` grants `checks: write`;
  - every required context names only integration 15368.
- **Observed on #48:**
  - head `ce35c43` failed `agent-guard` and `agent-verify` under `main`'s `agent-checks.yml`;
  - head `e8bd465` edited that workflow, passed all four, and merged at 15:23:43Z (rule suite 4750626137: `required_status_checks: pass`).
- **The same mechanism shows on #60 today:** its own `agent-checks.yml` runs, and fails closed, because `main`'s guard lacks the output it reads.
- **Secrets:** with 0 environments, every secret is readable by a branch-defined workflow. With `AGENT_LEDGER_KEY`, verdict lines could be forged (inferred).
- **Who can do it:**
  - the builder App cannot: `.github/` is protected, and its token is contents and pull-requests only;
  - any kuaya1 credential with the `workflow` scope can.
- **Expected:** at least one required context produced only by `main`'s code, with keys a branch cannot read.
- **Correction (Eric's; it changes effective GitHub configuration):**
  1. an environment limited to `main` for the review, gate and App keys;
  2. one required context posted by a separate gate App from a `workflow_run` or `pull_request_target` job;
  3. agent sessions given a credential without `workflow` or admin.

**R-F3. Any pull request that was not an agent candidate got a neutral "Owner change" `agent-review`.** Confirmed.
- **Where:** `agent-guard.js:442-447` `isAgentPr` and `:489`; `agent-checks.yml:67-76`.
- **Reproduction:** #55, opened by `github-actions[bot]` on `claude/backlog-*` with nine Claude commits.
- **Observed:** all four checks green; mergeable. It was closed unmerged.
- **Root cause:** the classification was "agent or owner", with nothing in between.
- **Correction:** #60 L2.
  - The neutral pass goes only to a pull request that:
    - is opened by the owner;
    - is not on an automation branch;
    - has no commit authored or committed by an assistant or a bot.
  - Everything else is `action_required` until Eric's `eric-reviewed` dispatch for that exact head.
- **Live:** #60's own `agent-review` reads `action_required`, "Not Eric's own change: review this head" (app 15368, 21:47:07Z).

**R-F5. "Only Eric merges" means "only the kuaya1 credential merges".** Confirmed by configuration; not tested by action.
- kuaya1 is the only collaborator, as admin.
- The local `gh` token has `repo`, `workflow` and admin.
- Any process holding it can open a PR, produce its checks (R-F2) and merge it. GitHub cannot tell that from Eric's click.
- **Correction:** Eric's. Separate credentials, so agent sessions never hold the merging one.

**B-1. The backlog lane reclaimed a claim when its lease ended.** Confirmed.
- **Where:** `backlog-schedule.js:109-112` at `93e3ddd`.
- **Evidence:** at `93e3ddd`, `main`'s own test asserted the behavior (`backlog-schedule.test.js:216`).
- **Expected:** a run whose state cannot be read holds as reconcile required.
- **Impact:** latent while both routines are disabled. A live run past its 90-minute lease would have been rebuilt by the next run, giving two branches and two PRs, and nothing fences the first run's late push.
- **Correction:** #62, merged by Eric as `d74242b`. The claim stays in flight and reads reconcile required until its run reports or Eric releases it (`backlog-schedule.js:111-114`; `backlog-schedule.test.js:219`).
- **Residual:** if Eric releases a run that was in fact alive, its push still opens a second PR. Fencing that needs the claim generation in the branch and a check `backlog-pr` enforces, which only matters if the lane is kept.

**C-1. Consolidation is incomplete.** Confirmed by code.

Claim and dispatch authorities:
- the agent ledger (`agent:build` and `/revise`; the PM dispatches into it);
- the claim refs (backlog routines, fed by the numbered backlog and the `agent:ready` queue);
- the engineering inbox's leases on Render.

Two phone authorization paths: `agent:build` and `agent:ready`. Four orchestrators: the agent lane, the PM, the backlog routines and the engineering worker (absent).

Nothing keys a task across them. The same work entered as an issue and as a backlog item, or as an issue and a `TASK-###` row, is two tasks.

Today nothing else dispatches, because the routines are disabled and the PM is off. That is configuration, not design.

Correction: the owner decision in section E.

**T-P1-3 to T-P1-7.** Confirmed (adversarial scripts a03–a07; regression tests in #63).
- **P1-3:** the simulated venue took an order that was not `SENT`, and `recover()` cancelled `RESERVED` orders blind (`paper-trader.js:376`, `:411-416`, `:423-431`).
- **P1-4:** an unreadable venue record read as empty, so the order became `NOT_FOUND` (`:441`).
- **P1-5:** the same client order ID with another body was accepted. Fixed in #63. The journal head anchor is open; see section F.
- **P1-6:** one idempotency key covered every journal write of a queued request.
- **P1-7:** fills came from hours before the order was sent.
- **Correction:** #63.

### P2: material reliability

- **R-F4. `eric-reviewed` marked whatever head was live** (`agent-review.yml:94-105`). Confirmed in code; not exercised. Corrected in #60 L3: the dispatch takes the 40-hex head and refuses a malformed or moved one. It is tested under Git bash with a fake `gh`.
- **S-1. A new name that is one file on Windows with an existing name passed `checkChange`.** Confirmed (sandbox audit `repro2.js`; `backlog-promote` `scopeCheck` refused the same case). Corrected in #60 L1.
- **S-2. `test` and `agent-verify` run candidate code outside any OS sandbox.** The exposure is confirmed; the impact is inferred.
  - The run-scoped `ACTIONS_RUNTIME_TOKEN` is reachable through the parent's `/proc/<pid>/environ`, and egress is open.
  - These jobs hold no high-value secret and a read-only token (`agent-workflows.test.js:307`).
  - Owner decision: run them under the build's bwrap, or on an isolated runner.
- **S-3. The model review is prompt-injectable.** Inferred. It is off. Eric's merge is the boundary (R-F5 applies).
- **B-7. A push that landed while its job saw an error was treated as "published nothing".** Confirmed by test. Corrected in #61 (merged).
- **C-2. `agent:ready` revocation is not enforced by a required check.**
  - `backlog-promote.js:236-250` refuses a withdrawn item, but only inside `backlog-pr`'s merge path, which is not a required check.
  - Corrected in part by #60: such a PR is `action_required` until Eric reviews its head.
- **T-P2-8 to T-P2-14.** Confirmed (a08–a15).
  - P2-8: a GAP in hours was applied.
  - P2-9: the book's price had no time.
  - P2-10: an unlisted order state did not halt.
  - P2-11: inherited intent properties passed.
  - P2-12: a close was sized while its opener was live.
  - P2-13: the engine could be swapped at run time.
  - P2-14: an order filled in the hour its life ended.
  - Corrected in #63.
- **T-P2-15. The grant comes from the caller, not the stored ticket decision.** Open: it needs a `cr.trade-intent.v3` that names the decision.
- **T-P2-16. The `cr-paper@2` contract text did not describe these rules.** Corrected in #63's `DESK_STATE.md` note.

### P3: improvements

- **R1.** A re-run of failed jobs could publish without its record. Corrected in #61.
- **R-F6.** The live `main-merge-requirements` has `require_extra_approval_for_unattributed_changes: true`, and the file does not. `merge-boundary-check.js` ignores extra live parameters.
- **The desk's view of #23 and #24.** It does not flag "released without required review": `review_at_merge` was not yet recorded when they were reconciled.
- **Sandbox file denies.** The `Read(//proc/**)`, `.git` and `.claude` denies bind Claude's tools, not commands. The OS layer is what holds (probe row `proc_self_environ`).
- **Probe gaps.** The probe does not test:
  - reads outside the checkout;
  - the eng-app@4 bundle sandbox;
  - the `test` and `agent-verify` jobs.
  
  `test.yml` and `candidate-review.yml` use `@v4` tags, and SHA pinning is not required.
- **A model request whose outcome is unknown.** It is closed as `lost` after 20 minutes (`agent-policy.json` `unknown_grace_minutes`), and only when OpenAI's stored completions answer that they do not hold it. One new request may then follow (`agent-review.test.js:188`). The lost attempt still counts toward the ceilings, so this costs at most a bounded duplicate. It never touches a branch or a trade.
- **The `backlog-schedule.js` non-atomic fallback** (`:249-256`) has a best-effort rollback. It runs only when the remote does not support `--atomic`, and GitHub does advertise it.
- **#63's journal operation types** include the journal's last line read before the lock. A replay is made safe by each write's own state check, not by the operation layer. A reused request ID with different content is therefore not caught as `IDEMPOTENCY_CONFLICT` for those writes.

## C. Corrections

| PR | Corrects | Tests (each failed before its fix) | Full suite | Limits |
|---|---|---|---|---|
| #60 `77915e8` | R-F3, R-F4, S-1 | `agent-guard.test.js` (Windows names; owner pass: Eric, `github-actions[bot]`, four automation branches, owner unknown, `KUAYA1` case, Claude commit, bot commit); `agent-workflows.test.js` (both `agent-checks` steps; the `eric-reviewed` shell under bash with a fake `gh`: matching, moved, malformed, non-owner) | 1282/1282 (outside `%TEMP%`); with #56 113/113 and with #61 114/114 agent and trader-boundary tests | Its own `agent-review` reads `action_required` (fails closed) until Eric clears it with `main`'s dispatch. AI co-authored owner commits (a `Co-Authored-By` trailer only) still get the owner pass; that policy is Eric's. |
| #61 `8c33bf1` (merged) | B-7, R1 | `agent-pm.test.js:252` (13/14 before); `agent-workflows.test.js` attempt guard (17/18 before) | 1294/1294 | `PM.reserve`'s `task` path and its other remediate branches have no tests yet. |
| #62 `1c11257` (merged) | B-1 | `backlog-schedule.test.js` restart recovery, rewritten to the required behavior (13/14 before) | 1293/1293 | The late push after Eric's release is not fenced. This PR narrows autonomy: a dead routine waits for Eric. |
| #63 `e3a6b03` | T-P0-1, T-P0-2, T-P1-3, -4, -5 (partial), -6, -7, T-P2-8 to -14, T-P2-16 | `trade-risk.test.js`, `paper-trader.test.js`: 57 tests, 34 pass and 22 fail on the `6b1e876` core, 56 pass after (1 todo); accounting fuzz, 40 seeds | Head (with `93e3ddd`): 1315, 1314 pass, 1 todo | Version names kept. The grant bounds open risk, not lifetime loss. The journal head is not anchored (todo test). T-P2-15 is open. |

`rollback-drill.test.js:85` fails in any checkout under `%TEMP%` (unchanged `main` fails the same way there), so every full-suite figure above comes from a checkout outside it.

## D. Attack-test matrix

### A. Release authorization

| Case | Result | Evidence |
|---|---|---|
| #29, #23, #24: what happened | FAIL (historical) | R-F1: owner merges with nothing enforced |
| An incomplete PR mergeable today | FAIL | #48 (R-F2); #55 (R-F3, closed by #60 once merged); R-F5 |
| Builder App edits its required checks | BLOCKED | `.github/` protected; App token contents and pull-requests only. The App's installation grant is NOT TESTED (its API page returns 404). |
| A kuaya1-credential branch edits the checks | FAIL | #48 |
| Model review bound to the head SHA | PASS (code) | Per-SHA check runs; `agent-review.js` skips a moved head |
| `eric-reviewed` bound to the head SHA | FAIL on `main`, PASS with #60 (fixture) | R-F4 |
| A new push keeps a stale green review | PASS (code) | New SHA, new check |
| Builder posts `agent-review` | BLOCKED | The App posts as 5487887, not 15368 |
| Model reviewer independent in practice | NOT TESTED | Review has never run (`AGENT_REVIEW_ENABLED=false`) |

### B. Single execution authority

Agent lane = `agent:build`, `/revise` and the PM; backlog lane = the routines and claim refs.

| # | Scenario | Agent lane | Backlog lane |
|---|---|---|---|
| 1 | Two schedulers pick one task | PASS: `agent-ledger.test.js:55`, `agent-guard.test.js:338` | PASS: `backlog-schedule.test.js:177` (real git, two processes) |
| 2 | Builder loses its lease while running | PASS: there is no lease; the run's status decides (`agent-guard.test.js:338`) | FAIL at `93e3ddd` (B-1); PASS since #62 (`backlog-schedule.test.js:219`) |
| 3 | A replacement claims a new generation | PASS: only after the old run ended | FAIL at `93e3ddd`; PASS since #62 (nothing reclaims) |
| 4 | The original publishes late | PASS: `agent-guard.test.js:403`, `:458` | FAIL: the push is unfenced. #62 removed the reclaim; the gap remains after Eric's release. |
| 5 | Run cancelled or re-run | Cancelled: PASS (`agent-guard.test.js:373`). Re-run: FAIL on `8e8eae0`, PASS with #61 | NOT TESTED (no run status for routines) |
| 6 | GitHub unreachable | PASS (fixture): an unread run holds as reconcile required; a ledger unread after a push is `uncertain`. NOT TESTED live. | PASS (fixture): an unreadable claim blocks its item (`backlog-schedule.test.js:293`) |
| 7 | Push lands, client sees an error | PASS for publish (the ledger's word). PM: FAIL on `8e8eae0`, PASS with #61 | NOT TESTED |
| 8 | Expired claim, execution unknown | PASS (no expiry) | FAIL at `93e3ddd`; PASS since #62 |
| 9 | Two lanes dispatch one migrated task | FAIL by design (C-1): no shared key across the ledger, claim refs and leases. Not exercised; prevented today only by the routines and PM being off. | |

`--atomic` is used in two places: `agent-guard.js:368` and `backlog-schedule.js:246`.
- Each ref carries an explicit expected value.
- GitHub's receive-pack advertises `atomic` (a protocol-v0 dry run; nothing written).
- The two-ref publish has not yet run against GitHub: #50 was published before #56.

### C. Phone-first authorization

| Case | `agent:build` | `agent:ready` |
|---|---|---|
| A non-owner applies the label | PASS (`agent-guard.test.js:79`) | PASS (`backlog-queue.test.js:106`) |
| An AI approves its own task | Builder App: BLOCKED. An agent holding kuaya1's credential: FAIL by configuration (R-F5). | Same |
| The issue text changes the scope | PASS: hints only narrow; the template and protected paths bound it (`agent-guard.test.js:89`, `:115`) | PASS (fixture): `touches` names what it changes (`backlog-queue.test.js:76`) |
| An edit after approval | PASS: re-read at reserve and in `prCheck` (task SHA-256) | PASS (fixture): the edit withdraws it (`backlog-queue.test.js:152`) |
| Replay after cancellation | PASS: a closed issue is refused; reruns are bounded at 2 per version | PASS: a new number, never an old one |
| A modified body keeps its old hash | PASS (`prCheck` compares) | PASS (`backlog-queue.test.js:92`) |
| A delayed webhook | PASS: reserve reads the issue again (`agent-guard.test.js:296`) | PASS (code): reads it again |
| Revocation stops unpublished work | PASS at the required `agent-guard` check (closed, unlabeled or edited fails). A build already running may still open a PR that cannot pass. | FAIL on `main` (C-2): advisory only. With #60: `action_required` until Eric reviews the head. |
| A PR passes with another revision | PASS (trailer SHA-256 vs the live issue) | FAIL on `main` (advisory, by number not by text); with #60, Eric's review |
| End to end | PASS once, live (#49 → #50), with Eric's review in place of the model | NOT TESTED: no live item; the worker routines are disabled |

**Required outcome.** Eric can approve from his phone without touching `DESK_STATE.md` through `agent:build`, and that build runs only the approved revision. The independent model review in that path has never run.

### D. Sandbox and credentials

| Case | Result | Evidence |
|---|---|---|
| bwrap enforcement | PASS | Probe run 40530698111: 12/12; PID namespace, npm-only proxy, home overlay, runner temp unmounted |
| Environment and credentials in the build | PASS | Only `ANTHROPIC_API_KEY`, unset for commands; read-only contents; `persist-credentials: false` |
| GitHub App vs admin credential | Builder App: PASS (scoped to `agent/**`, contents and pull-requests). Backlog routines: FAIL (they push as kuaya1 with admin bypass; Gate 0 claim 3). | Rule suite 4753973448 |
| Token exposure in logs, outputs, artifacts | PASS | Secret scan on the patch and report; outputs sanitized; titles through `env` |
| Symlink, traversal, 8.3 names, binaries | PASS | `repro.js`, `repro2.js` |
| Case-only clash with an existing file | FAIL on `main`; PASS with #60 | S-1 |
| Workflow YAML or verifier changes | Builder App: BLOCKED. kuaya1 credential: FAIL | R-F2 |
| Untrusted code in privileged workflows | BLOCKED for secret-holding jobs (they run `main`'s code on data); `test` and `agent-verify`: P2 | S-2 |
| Protected paths through imports or generated files | Imports: residual by design (eng-backend@1 may add a core module and wire it into `server.js`). Bundle: PASS (rebuilt in a sandbox and compared, `agent-workflows.test.js:384`); its sandbox is NOT TESTED by the probe. | |
| `SANDBOX_ENABLED`-style claims | Not relied on: the probe tests OS effects | |

The routines' admin credential cannot be corrected inside approved permissions: it needs ruleset excludes, an App credential, or the routines retired, and every one of those is an effective GitHub change. Owner decision.

### E. Trader safety

All of this uses the simulated venue. No exchange, REST or WebSocket code exists.

| Case | On `main` | With #63 |
|---|---|---|
| Accepted and partly filled, then the acknowledgement is lost and the process restarts | FAIL: a `RESERVED` order is cancelled blind | PASS: `UNKNOWN`, reconciled from the venue's record |
| Venue lookup incomplete or unreadable | FAIL: `NOT_FOUND` | PASS: `INTEGRITY`, stays `UNKNOWN` |
| Elapsed time alone makes it lost | PASS: no clock transition exists | PASS. `NOT_FOUND` comes only from a readable venue record after its duplicate window. |
| A replacement order after uncertainty | PASS: `UNKNOWN` halts every intent | PASS: any state outside `RESOLVED` halts |
| WebSocket disconnected | NOT TESTED: no WebSocket exists | NOT TESTED |
| Accounting separation | FAIL (T-P0-1, T-P0-2) | PASS (section F) |
| `cr-paper@1` preserved | PASS (`paper-trader.test.js` "cr-paper@1 reads the same") | PASS |
| Protected against unattended promotion | PASS | PASS |
| Journal tail truncated | FAIL | FAIL: todo test; needs a key the agent never holds |

### F. Operational recovery

| Case | Result | Durable evidence used to resume |
|---|---|---|
| Crash at each agent-lane transition | PASS (fixtures) | Ledger lines (reserve, publishing, outcome) and GitHub's run status |
| Lost GitHub access | PASS (fixture) | Holds as reconcile required; nothing new starts |
| Uncertain remote publish | PASS (fixtures; #61) | The ledger's `publishing` line, pushed in the same atomic push as the branch |
| Backlog migration without losing admitted tasks | NOT TESTED | Four admitted engineering tasks have no worker; claims 67–74 need Eric's release |
| Deterministic WIP reconciliation | PASS (fixture) | `backlog-status.js` reads trailers on `main` (Gate 0 PR A) |
| A disabled automation stays disabled | PASS (live) | Run 40594037199; routines `enabled: false`; review off |
| Review backpressure | PASS (fixtures) | The PM's lock on an open `agent/` PR; the WIP cap |
| No automatic expansion of authority | PASS (code) | A candidate may change only status lines in `DESK_STATE.md` (`agent-pm.test.js:333`); #60 |
| No hidden manual cleanup | FAIL | Claim refs 67–74, merged branches and issue #49's label. Since #62 they read reconcile required, which is explicit but manual. |
| Rollback without duplicating work | NOT TESTED | The ledger is append-only; a revert of `main` has not been exercised |

## E. Migration readiness

**Not ready.** There is not yet one canonical execution authority (C-1).

**Recommendation for Eric's decision:** keep the `agent:build` issue lane as the one authority.
- It is the only path that is phone-first and builds in the sandbox with the builder App.
- It settles by run status and publishes under a lease.
- It has run end to end.

If the PM stays, it should dispatch only into that ledger, from one input. Issues and `TASK-###` rows are separate keys today.

**Retiring the others is safe once these are done** (each is Eric's):
1. Delete the two disabled routines, or keep them disabled for good.
2. Release claims 67–74 (`node dashboard/scripts/backlog-schedule.js release --run <run> --item <n>`, or delete the refs), and delete the merged backlog branches.
3. Retire `backlog-pr.yml` and the `agent:ready` queue, or re-point the queue at the agent lane.
4. Close or re-file the four admitted engineering tasks, and freeze the inbox's claim tool.
5. Remove the `agent:build` label from #49 and close it.

None of these loses work: 67–74 are on `main`, and the four engineering tasks are listed in the Gate 0 baseline.

## F. Trader readiness

### `cr.trade-intent.v2` specification

**Partly ready.**
- **Ready:**
  - immutable identity: `intent_id` is the idempotency key, and the body is hashed, so the same ID with another body is refused;
  - exact decimals;
  - long only;
  - a minimum stop distance;
  - bounded life;
  - the client order ID derived by the engine.
- **Not ready:** authorization binding. The grant (`pm_approved_risk_usd`, `thesis_id`) is handed in by the caller, not read from the stored PM decision (T-P2-15). That needs `cr.trade-intent.v3`.

### `cr-paper@2` accounting

**Not ready on `main`** (T-P0-1, T-P0-2; 22 failing adversarial tests).

With #63, every separation the directive names is tested with fictional records:
- NAV as cash plus marked positions (equity is the same: no margin);
- planned loss at the stop per position, plus `open_risk_usd`;
- quantity and notional;
- realized and unrealized P&L;
- maker and taker fees and stop slippage;
- committed cash (`available_cash_usd`);
- partial fills;
- duplicates;
- cancellations;
- expiry;
- restarts.

What is left:
- the journal head is not anchored (todo);
- the version names were kept;
- the grant bounds open risk, not lifetime loss;
- #63 has had no independent review.

### Real-trading safety

**Not ready, and not authorized.** Nothing in this review enables trading.
- No exchange adapter exists.
- The simulated venue's own file is treated as authoritative. A real venue's REST answer can be partial, so it cannot be treated that way.
- There is no WebSocket handling.
- The journal head is not anchored.
- The grant is not bound to the decision.
- `trader-boundary.test.js:124` and `:134` hold that nothing calls the trader and that no trader module reaches the network, a process, the environment or a secret.

## G. Independent review package

**Diffs:**
```bash
git diff 6b1e876 77915e8
```
```bash
git diff 8e8eae0 8c33bf1
```
```bash
git diff 8e8eae0 1c11257
```
```bash
git diff 6b1e876 9439053
```
```bash
git diff e296836 e3a6b03
```

**Regression proof:** check out each PR's base, take only its test files from the head, and run them. They fail as listed in section C; with the head's code they pass.
```bash
node --test dashboard/tests/agent-guard.test.js dashboard/tests/agent-workflows.test.js
```
```bash
node --test dashboard/tests/agent-pm.test.js
```
```bash
node --test dashboard/tests/backlog-schedule.test.js
```
```bash
node --test dashboard/tests/trade-risk.test.js dashboard/tests/paper-trader.test.js dashboard/tests/trader-boundary.test.js
```

**Full suite:** from a checkout outside `%TEMP%`:
```bash
node dashboard/cli.js test
```

**Live evidence:**
- **PR #48:** the ruleset suite 4750626137 and its check runs.
- **PR #50:** `agent-review` action_required, then neutral from run 40543264687.
- **PR #60:** `agent-review` check run 122490197154, action_required.
- **PM run 40594037199:** "Done: off".
- **Probe run 40530698111:** 12/12.
- **Routines:** read through the routines API, both `enabled: false`.

**Not in the repository** (kept local, not committed): the working reproductions (sandbox audit `repro*.js`, trader scripts a01–a16) and raw API pulls. They hold no secret values, and can be shared on request.

**Residual risk:**
- R-F2, R-F5, C-1 and S-2 stay open until Eric acts.
- #60 and #63 are unmerged.
- No model review has ever run.

## H. Grades (`main` at `d74242b`, open PRs not counted)

Only concurrency changed from the `93e3ddd` reading (65 → 70), because #62 landed. #62 touched nothing the other grades rest on.

| Area | Grade | Basis |
|---|---|---|
| Architecture correctness | 55 | The agent lane's design holds; four orchestrators and three claim systems remain (C-1) |
| Security and authorization | 40 | The sandbox and builder App hold; head-defined required checks, repository-wide secrets and a single merging credential (R-F2, R-F5); the owner pass is open on `main` (R-F3) |
| Concurrency and fault tolerance | 70 | CAS ledger, run-status settlement and a leased atomic publish, all tested; the backlog clock reclaim is gone (#62). Gaps: no fence on a late backlog push after Eric's release; three claim systems with no shared key (C-1) |
| Recovery and idempotency | 60 | Fixture-tested at each agent-lane transition; trader recovery wrong on `main` (T-P1-3, T-P1-4); live recovery not exercised |
| Automated verification | 45 | Required checks exist but a head can produce them; the model review has never run; candidate code runs unsandboxed in `test` and `agent-verify` |
| Operational simplicity | 30 | Two phone paths, stale claims and branches, manual cleanup pending |
| Paper trading integrity | 20 | Two P0s and 22 failing adversarial tests on `main`. #63 is ungraded until independently reviewed. |

## Decisions for Eric

1. Merge or reject #60 and #63. To clear #60's own `agent-review`:
   ```bash
   gh workflow run agent-review.yml --ref main -f mode=eric-reviewed -f pr=60
   ```
   After #60 merges, the dispatch also takes `-f head=<full sha>`.
2. R-F2: put the review, gate and App keys in an environment limited to `main`, and require one context from a separate gate App. These are effective GitHub changes.
3. R-F5: give agent sessions a credential without `workflow` or admin.
4. C-1: name the one execution authority, and retire the rest (section E).
5. The `ACTIONS_RUNTIME_TOKEN` exposure in `test` and `agent-verify` (S-2): sandbox those jobs or isolate their runner.
6. The trader:
   - the journal head key;
   - `cr.trade-intent.v3` with the grant bound to the decision;
   - whether the grant is a lifetime budget;
   - new version names or the kept ones.
7. Whether an owner PR whose commits carry an AI `Co-Authored-By` trailer keeps the owner pass.
8. Ruleset drift (R-F6), pinning the `@v4` actions, and requiring SHA pinning.
9. Close issue #49 and remove its label.
