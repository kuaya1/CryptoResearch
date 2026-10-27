# Architecture recovery: Gate 0 baseline (2026-10-27)

Eric's mission "CryptoResearch Architecture Recovery & Trader v2 Implementation" asked for a read-only baseline before any change, with every claim of the recovery audit (`CryptoResearch_Architecture_Recovery_Audit_2026-10-27.pdf`, not committed) checked against the code. This is that baseline and its corrections. The full evidence is [gate0-evidence.md](gate0-evidence.md).

## How it was read

Eight readers covered the areas below, all read-only. Each fact was then checked by a second, independent verifier against the cited lines:

- the three lanes (Agent, Backlog, Engineering);
- security and rulesets;
- the trader;
- items 67–74;
- PRs #54 and #55;
- branch debris and instructions.

**Results:**

| Verdict | Count |
|---|---|
| Facts read | 216 |
| Hold as stated | 175 |
| Hold, but the claim overreaches (the note says how) | 38 |
| Hold, cited line off by one or two | 3 |
| Refuted | 0 |

**Sources:**

- GitHub's read-only APIs: rulesets, rule suites, activity, Actions settings, variables, and secret names only.
- `gh pr` and `gh run`.

Nothing was written to GitHub during the read.

**Baseline:** `main` at `abb7740`.

**Main moved during the read.** At 18:52:53Z kuaya1 merged #54 (the PM builder, `b22b42f`). That changes the agent lane's lease rule and adds a lane. Where a finding below depends on it, it says so. Citations of `agent-ledger.js` and `agent-guard.js` are at `abb7740` unless marked.

## The audit's claims, corrected

| # | Audit claim | Verdict | What the code says |
|---|---|---|---|
| 1 | Three lanes (Agent, Backlog, Engineering) | Holds | The three lanes are as the audit drew them. Since `b22b42f` there is a fourth, the PM lane (`.github/workflows/agent-builder-lane.yml`, `dashboard/scripts/agent-pm.js`). It is inert while the variable `AGENT_PM_ENABLED` is unset, which it is (live variables, 18:58Z). |
| 2 | Items 67–72 wait for merge; the cap of 6 blocks the queue | **Partly wrong** | 67–71 are on `main` (squash merge `e573d0d`, #45), and so is 72 (`f2569b3`, #46). `backlog-status.js` still counted them as waiting: it decides "merged" by ancestry (`gather()`, `origin/main` lines 114–119), which a squash merge never satisfies. A branch built on top (73–74, #55) inherits them too. The cap today is 20 (`backlog-status.js:34`), and 15 until 2026-10-29T03Z (`:35`). From then it is 6 (`:36`), when the 8 phantoms would have stopped every build. Fixed in PR A. |
| 3 | `automation-branches` lacks the backlog and claim excludes, so the routines use admin credentials | Holds; by design | After the rulesets went live at 14:58Z, every claim and backlog ref update was recorded as actor kuaya1 (User), result `bypass`. Rule suite 4753973448 is one example. The routines push as Eric. `BUILDERS.md:143-149` and `DESK_STATE.md:643` (at `abb7740`) ask Eric to add the excludes. Whether the credential is a Claude App user-to-server token or a login is **unknown**. |
| 4 | Four admitted engineering tasks with no lease | Holds | The four are named under Engineering tasks below. No worker claims them (`dashboard/engineering/inbox.js` `claimTask` refuses only while a lease is live). |
| 5 | `paper.js` is not protected | Holds | `PROTECTED` (`backlog-promote.js:41-76`) names `core/(portfolio\|wallets\|walletsync\|alchemy).js` (`:68`) and the `paper/` records (`:71`), not `dashboard/core/paper.js` or `tickets.js`. `eng-backend@1` may change `dashboard/core/**` (`dashboard/engineering/policy.js:128-129`). |
| 6 | `cr-paper@1` uses risk as notional | Holds, and it is wider | Risk is used as notional at `paper.js:148` (`risk_usd = pm_approved_risk_usd`) and `:272` (`pnl_usd = risk_usd × return`). The desk's sizing gate quotes the exit for $500 of tokens (`tickets.js:86-95`, `:343`, `:378-382`), which is notional too. A `LIMIT_TRAP` paper position opens at the hourly price at the decision, not at its entry zone (`paper.js:127-131`). |
| 7 | Orders time out to `lost` after 65 minutes | Partly | The rule is real for paid **builds** (`agent-ledger.js:36-38`, `:212-226`). Invariant 4 (`DESK_STATE.md:165`) borrowed it for orders that no code places. Since `b22b42f` builds use a 60-minute lease instead (`agent-ledger.js:44-46`, `:182-190`, `:248` on `b22b42f`). An attempt past it is `orphaned`: its task is freed, and its version's ceilings no longer count it. |
| 8 | `TASK-###`, `agent-pm.js` and `cr-agent-diagnose@1` exist | Partly, then true | At `abb7740` only the labels `TASK-004` and `TASK-005` existed (`DESK_STATE.md:202-203`). Since `b22b42f` all three are on `main` (#54). |

## What the audit missed

Each item is labelled **fact** (read in code or a live API) or **hypothesis** (follows from how GitHub works, not shown live).

1. **Branch workflows hold every secret.** Hypothesis, highest impact.
   - GitHub runs a push's or pull request's workflow files from the branch itself, not from `main`. `test.yml:12` runs on every push to `claude/**`.
   - The repository has no environments (`gh api …/environments` returns 0), so all five secrets reach any same-repository branch workflow: `AGENT_LEDGER_KEY`, `BUILDER_APP_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CR_ENG_REVIEWER_TOKEN`.
   - Any job with `checks: write` can post a check named `test`, `agent-guard`, `agent-verify` or `agent-review`. The required contexts name only the GitHub Actions integration (15368), not a workflow.
   - So any credential that can push a `claude/**` branch with a `.github/workflows` change could read every secret and paint the required checks green.
   - The cloud routines push `claude/**` as Eric. Their prompts forbid touching `.github/`, but that is a prompt, not a control.
   - Whether their token may push workflow files (the `workflows` permission) is **unknown**.
2. **Backlog and engineering pull requests get no model review.** Fact. Any PR whose branch is not `agent/*` and has no builder-App author or commit counts as an owner change (`agent-guard.js:290-297`, `:319`). `agent-checks` then posts a neutral `agent-review` (`agent-checks.yml:63-73`), and `agent-verify` returns 0 at once. This covers `claude/backlog-*`, `claude/candidate-eng-*` and `claude/admission-*` PRs, #55 included. Eric's merge is their only review.
3. **Publish has a race.** Fact for the window; the outcome is a hypothesis.
   - `publish` reads the ledger and refuses a lost attempt (`agent-guard.js:499-506`), then pushes later (`:266-278`).
   - An attempt marked lost or orphaned in between still pushes.
   - Jobs can outlive the hold: 45 minutes, plus 10, plus queueing.
4. **The publish job has no run-attempt guard.** Hypothesis. Build and record check `needs.reserve.outputs.attempt == github.run_attempt`; publish checks only `needs.build.result` (`agent-build.yml:254-256`). "Re-run failed jobs" after a failed publish could publish attempt 1's artifact again.
5. **The effective daily build cap is 5, not 6.** Fact. Each build reserves the full $8 (`agent-guard.js:475`). `decidePaid` refuses past $40 (`agent-ledger.js:235`; policy `:29-30`), so the sixth reservation is always refused.
6. **`agent-verify` mostly does nothing for a docs-only or tests-only candidate.** Fact. Its lint, test, coverage and revert checks run only when an implementation file changed (`agent-verify.js:188-232`).
7. **The sandbox's file denies are tool rules, not sandbox rules.** Fact.
   - `Read(//proc/**)` and the `.git`/`.claude` write denies (`.github/agent/claude-settings.json:3-31`) bind Claude's tools. They do not bind `Bash(node:*)`.
   - Probe run 40530698111 (12 of 12 rows held) shows `/proc/self/environ` readable inside the sandbox, though without the canary.
   - The probe does not test the Actions runtime token.
8. **Stale "public repository" wording.** Fact. `agent-task.yml:7` and the comment in `scout-cron.yml:6-7` still say the repository is public; it is private.
9. **The live rules differ from the checked-in file.** Fact. The live `main-merge-requirements` carries `require_extra_approval_for_unattributed_changes: true`, which `.github/rulesets/main-merge-requirements.json` lacks. `merge-boundary-check.js` does not see this.
10. **A push to `main` is still in the code.** Fact. `backlog-promote.js` `defaultPush` (`:260`) is reachable from the CLI's `admission` without `--propose` (`:486`, `:546`). The live rulesets refuse it.
11. **#55's fill harness trusts any passing object.** Fact. `simulateFill` (`paper-fills.js:28-31` on #55) accepts any validation object with `ok === true`. It never re-runs the check and never ties it to the intent by hash.

## Items 67–74: disposition

| Item | Where it is | Claim ref | Branch | Recommendation |
|---|---|---|---|---|
| 67–71 | On `main`, `e573d0d` (#45) | `claude/claims/item-67…71`, state `built` | `claude/backlog-batch-items-67-68-69-70-71` (not an ancestor of `main`: squash) | Tick in `DESK_STATE.md`. Delete the branch and the five claim refs **after Eric says so**. |
| 72 | On `main`, `f2569b3` (#46) | `claude/claims/item-72`, `built` | `claude/backlog-item-72` | Same. |
| 73–74 | #55 (open): `trade-risk.js` and `paper-fills.js` on the v1 contract, base behind `main` | `claude/claims/item-73`, `-74`, `built` | `claude/backlog-batch-items-73-and-74` | Close #55 unmerged (reasons in the next section). 73 and 74 are rebuilt to `cr.trade-intent.v2` and `cr-paper@2` on their own branches. Those branches are drafts for Eric, separate from this PR. |

`delete_branch_on_merge` is off, so every merged branch above stays until someone deletes it. Nothing has been deleted.

## Pull requests in flight

- **#54, the PM builder.** Merged by kuaya1 at 18:52:53Z (`b22b42f`). It is Eric's call and stays. It adds a fourth orchestrator, which the mission's operating principle rules out.
  - It does nothing until `AGENT_PM_ENABLED` is `true`.
  - Its ledger change is live now. A paid attempt with no outcome is `orphaned` after 60 minutes. The task is then free and its per-version ceilings no longer count it.
  - That is still the clock deciding, which the mission asks to replace with the run's own state. This is a decision for Eric, below.
- **#55, items 73–74 on v1.** Recommend closing it.
  - It uses float arithmetic with an epsilon.
  - Nothing caps notional.
  - The fill harness trusts any `ok` (missed item 11).
  - Its files are unprotected.
  - Its base is behind `main` and carries the pre-squash 67–72 commits.
  - It contradicts #56, which re-specifies 73 and 74.
- **#56, the pipeline review alignment.** Another session, 18:46Z, `820d56a`. It carries out a different review's plan, and much of it is this mission's Phases 1–4:
  - ruleset excludes;
  - run-state settlement;
  - an atomic two-ref publish;
  - issue authorization;
  - Invariant 4 and `cr.trade-intent.v2`;
  - `cr-paper@2` as a blueprint;
  - `paper.js` protected.

  It now conflicts with `main` after #54. An independent review of it against this mission's criteria is in progress; its results go in the handback. This mission does not rebuild what #56 already does.

## Engineering tasks (four admitted, none leased)

| Task | Title | Disposition (recommendation; the state is Eric's to change) |
|---|---|---|
| `eng-20261027-cc579e` | Architect next phase, backlog and temporary 10-item hourly builder burst | Delivered outside the lane by #43 and #44 (46 minutes after its authorization; no recorded link). Mark it superseded. |
| `eng-20261026-c35c5e` | Grok Daily Scout ingestion endpoint and file-backed storage | Delivered by #30 (Grok Scout, merged by hand). Its paths became protected after it was authorized. Mark it superseded. |
| `eng-20261025-61f9bf` | Refine dashboard card backgrounds to crisp premium white (v3) | Its `eng-app@2` delegation is retired (`claimTask` would refuse `NOT_AUTHORIZED`). The OpenAI Platform restyle replaced it. Mark it superseded. |
| `eng-20261026-ac36fa` | Diagnostic endpoint for candidate reviewer route status | Still unbuilt and valid. No worker exists. Keep it admitted, or re-file it as a task in the lane Eric keeps. |

## Actions taken in this session

- **Builder B (burst) paused** at 18:48:45Z, routine `trig_01Adw24sNdYAtXTTyu13PqrW`. This is Eric's "hold the 10-item-per-hour expansion" instruction.
- **Builder A paused** at 18:55:56Z, routine `trig_01Hw89ZHE8kWp2rQe3Kw3D26`. `main` at `b22b42f` says the routines "are paused there by Eric", and A pushes as Eric with the admin bypass. Its 18:55:35Z run had already started.
- Both are one toggle to re-enable in claude.ai routines. The backlog had no buildable item at the time; every unticked item was taken, Eric's, or engineering.
- **`backlog-status.js` fixed (PR A).** An item whose `Backlog-Item` trailer is on `main` is no longer waiting, on its own branch or on a branch built on it. A branch left with no item is no longer a base. With this, the live status reads "Waiting for merge: 2 (73, 74)" instead of 8.

## Decisions for Eric

1. **Which lane is the one execution state machine:**
   - the agent lane under #54's PM;
   - #56's issue queue feeding it;
   - or both, with the backlog routines retired.

   The mission asks for one. Today `main` has the PM lane (off), the agent lane (issue label), the deprecated backlog routines (now paused) and the engineering inbox.
2. **Builds still expire by the clock.** A build with no outcome is orphaned after 60 minutes (#54); #56 settles by the run's status and falls back to 65 minutes when the run cannot be read. The mission asks that an unreadable run be held and said, never assumed done or lost.
3. **The repository's secrets.** Move them into an environment that only `main` may use, so a branch's workflow cannot read them (missed item 1). Until then, any credential that can push `claude/**` with a workflow change is as strong as the secrets.
4. **The routines' credential:** keep the admin bypass (now unused while they are paused), add the excludes (#56), or move them to the builder App.
5. **Close #55** and delete the merged backlog branches and claim refs (67–72).
6. **The three superseded engineering tasks** above.
