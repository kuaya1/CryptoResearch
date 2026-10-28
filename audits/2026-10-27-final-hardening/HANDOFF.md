# Final hardening: executive handoff (2026-10-27)

**Verdict: CHANGES REQUIRED.**

The corrections are built and tested as #65, #66 and #68. The weakness that matters most (F2) stays open on GitHub until Eric configures the gate. The end-to-end demonstration stops at its second step, for reasons outside the code.

## A. Verified baseline

- **`main`:** `b10a7e6` (read with `git ls-remote` at hand-off).
- **Rulesets:** four are active.
  - **25967714 `agent-ledger`:** no bypass.
  - **25967715 `automation-branches`:** applies to `~ALL` except its excludes; admin bypass always.
  - **25967716 `main-merge-requirements`:** strict; requires `test`, `agent-guard`, `agent-verify` and `agent-review`, all from `integration_id` 15368; no bypass.
  - **25967717 `main-merge-authority`:** an update rule; admin bypass in pull-request mode only.
- **Secrets:** repository secrets only, with no environments.
- **Labels:** only `agent:build` exists.
- **Variables:**
  - `AGENT_REVIEW_ENABLED=false`;
  - `CANDIDATE_REVIEW_ENABLED=false`;
  - `AGENT_PM_ENABLED` unset.
- **Boundary checker:** `merge-boundary-check.js` reports that the boundary does not hold, because of the `automation-branches` drift (README, P4).
- **Reviewed:**
  - #60 through #64 (merged);
  - the agent lane (`agent-build`, `agent-checks`, `agent-review`, `agent-guard.js`, `agent-ledger.js`, `agent-revise.js`);
  - the issue queue;
  - the routines' scheduler;
  - the trader modules.
- **Authorized scope:** branches, tests and pull requests. Merges, rulesets, Apps, environments, secrets, variables, labels, spending and live trading are Eric's.

## B. Red-team findings

**Confirmed defects:**

| Severity | Finding | Source | Evidence |
|---|---|---|---|
| P0 | F2: any workflow, including one a pull request adds, can post the four required checks | ruleset 25967716 (`integration_id` 15368 = GitHub Actions) | Check run 122526964351 (`agent-review` on `3a6a6bb`) was posted by #60's own `agent-checks.yml` and filed under another workflow's suite. |
| P1 | R-F5: any process holding the `kuaya1` credential is Eric to GitHub | the account model | Demo issue #67, opened by this agent session, reads author `kuaya1`, association `OWNER`. The same credential can label `agent:ready`, comment `/reviewed`, approve, push workflows and use the admin bypass. |
| P1 | Two lanes read the same labels (`backlog-queue.yml` and the Agent task form) | `.github/workflows/backlog-queue.yml` on `b10a7e6` | Fixed by #68. |
| P2 | Ruleset drift: live `automation-branches` excludes `claude/intake-issue-*` but not `claude/backlog-*` or `claude/claims/**`; the file says the reverse | `.github/rulesets/automation-branches.json` against the live ruleset | `merge-boundary-check.js`. GH013 on non-admin pushes to the backlog branches follows from it. |
| P2 | `backlog-promote.js admit` without `--propose` pushes `main` and always fails now | `main-merge-authority` | Configuration (README, P4). |
| P2 | Repository secrets reach any workflow a pushed branch defines | repository secret scope | Configuration. Today only the `kuaya1` credential can push such a branch (the builder App has no Workflows permission), so it folds into R-F5. |

**Hypothetical:** not probed live, by design. The spoof of F2 by a new pull request is established from the configuration and run 122526964351, not from a fresh probe. The probe is owner step 7 in the README.

**Closed and demonstrated by tests on `main`:**
- **Trader:** the red-team's P0-1, P0-2, P1-3 to P1-7, P2-8 to P2-14 and P3, in `paper-trader`, `trade-risk` and `trader-boundary` (section E).
- **Lane:** the clock-based "lost" transition is gone. "one build per issue at a time: GitHub's run status alone decides; a run it cannot be asked about holds as reconcile required, however old".

## C. Corrections

| PR | Head | Scope | Tests | Rollback |
|---|---|---|---|---|
| #65 owner receipts | `14067c9` | `agent-review` has five states (independent pass, owner override, missing, failed, invalidated by a new commit). Eric's receipt is an unedited `/reviewed <40-hex>` comment or an APPROVED review at that commit, from `User`/`OWNER`. It carries over across Update branch only when tree and patch-id are equal. The `eric-reviewed` dispatch and commit-metadata authority are removed. | Full suite 1327: 1326 pass, 0 fail, 1 todo. | Revert the merge commit; the dispatch path returns. |
| #66 release gate (draft, stacked on #65) | `ac81f5e`, then the commit adding this file | `release-gate.yml` and `agent-gate.js`: one check posted by a separate App whose key lives in a `main`-only environment. It reads jobs only from runs of main's workflow files, needs Eric's receipt for workflow edits, and reads model passes only from MAC-signed ledger lines. `test.yml` actions are pinned. | Full suite 1335: 1334 pass, 0 fail, 1 todo. Gate 8/8. Mutation check: 8 of 8 guards caught. | Inert until `RELEASE_GATE_ENABLED`. Ruleset rollback is one command (README). |
| #68 one lane | `f6f1a90` | `cr-agent-policy@4`: the form arrives `agent:draft`, and Eric's `agent:ready` is the only start. `backlog-queue.yml` and the Backlog form are removed; ledger history stays readable. | Full suite 1320: 1319 pass, 0 fail, 1 todo. On main's code its tests fail (agent-guard 7, agent-workflows 1, agent-issue 2, agent-revise 6). | Revert the merge commit; `@3` and `agent:build` return. |

**Changes that need Eric's approval:**
- the gate App, the `release-gate` environment, `GATE_APP_KEY`, the environment's copy of `AGENT_LEDGER_KEY`, `GATE_APP_ID` and `RELEASE_GATE_ENABLED`;
- adding `release-gate` to ruleset 25967716;
- `automation-branches` option A or B;
- the labels `agent:draft` and `agent:ready`;
- `AGENT_REVIEW_ENABLED` (OpenAI spending);
- the three merges.

## D. End-to-end proof

**Done:**
- **Proposal.** An assistant proposed the task as issue #67, "E2E demo (do not merge): lane-demo trim helper" (eng-backend@1; `dashboard/core/lane-demo.js` and its test).
- **Read-back.** Read back from GitHub with main's `taskOf` under `@4`: no problems, body SHA-256 `544f733eec6ba7ac813fc36f323ad3d07ee39808a25223df08cccd340d1a33ea`.
- **No label.** It carries no label, so no workflow reacts to it.

**Blocked at step 2, "The Issue is marked `agent:draft`":** the label does not exist on the repository, and main's form and policy do not use it until #68 is merged. Creating labels is Eric's.

**The steps after it, each also blocked:**
- **Eric's `agent:ready`:** his act. It reserves up to $8 of Anthropic spend.
- **The independent model review:** `AGENT_REVIEW_ENABLED=false`, which is OpenAI spend, Eric's.
- **The trusted required check:** #66 plus its App, environment and ruleset.

**What the lane has already shown, once, under `agent:build`:** issue #49 to PR #50, merged by Eric as `7785adc`.
- **Ledger:** `reserve` `bd-1413a7cc9af7ae8e`, run `40532179689/1`, $8 reserved; then the outcome: job `success`, publish `published`, $0.41 reported.
- **PR #50's checks:** `agent-guard`, `agent-verify` and `test` succeeded. `agent-review` was neutral: "Reviewed by Eric, not by a model".

So the claim, sandboxed build, verification and publish are evidenced; the independent model review and the trusted gate are not.

## E. Trader verification

Run on `main`'s trader code, which is identical in #68's worktree, with fictional data: `paper-book`, `paper-trader`, `trade-risk` and `trader-boundary`, 67 tests: 66 pass, 0 fail, 1 todo.

| Directive item | Status and test |
|---|---|
| `cr.trade-intent.v2` | Holds. "an intent id, decimal strings, an explicit long-only side and a minimum stop distance"; "the frozen … schema and the engine read the same fields and the same decimals". |
| `cr-paper@2`, NAV and cash | Holds. "NAV is unknown without a fresh price, never 0 or the entry"; "cash never goes negative". |
| Stop risk against notional | Holds. "sized from the risk with the stop slippage and both fees in, never rounded up"; "risk at exactly 2% of NAV passes and a cent over is refused". |
| Fee-aware P&L | Holds. The taker fee on fills and stops; POST_ONLY at the maker fee; an unknown fee refuses. |
| Partial fills | Holds. "one hour fills at most FILL_SHARE_MAX of its volume; the rest stays open". |
| Journal idempotency | Holds. "the same intent twice is unchanged; a different body under its ID is refused; the venue sees one order"; the hash chain; P1-6. |
| Unknown state and reconcile | Holds, under the name `UNKNOWN` (there is no state called `RECONCILE_REQUIRED` in the trader). "crash and restart: … UNKNOWN, halts every intent and is reconciled, never cancelled blind or sent late"; NOT_FOUND only after the venue's duplicate window; "an order is never recorded lost on a clock". |
| v1 compatibility | Holds. "cr-paper@1 reads the same before and after". |
| Protected modules | Holds. "protected, by name and by any glob that reaches them". |

**Limits before any live-trading consideration:**
1. A journal that lost its last lines is not detected (the todo test). It needs an anchored head under a key the agent never holds; that is Eric's decision.
2. T-P2-15: the grant comes from the caller, not the stored PM decision. It needs `cr.trade-intent.v3`.
3. There is no venue adapter, credential or order path beyond the paper venue. Nothing here authorizes one.

## F. Simplification

- **Consolidated:** the issue queue's labels now belong to the one lane (#68); owner review is one receipt rule instead of a dispatch (#65); the four spoofable contexts gain one trusted gate check (#66).
- **Can retire (Eric's call):**
  - routines A and B, with `backlog-schedule` claims refs and `merge-train.js`;
  - `backlog-pr.yml` and `engineering-admission.yml`;
  - `candidate-review.yml` (off);
  - `agent-builder-lane.yml` (off; a second dispatcher of builds, so it must stay off or go);
  - issue #49 (close it).
- **Stays for compatibility:** `backlog-queue.js`, `backlog-status.js`, `backlog-promote.js` and the numbered list, as read-only history.
- **Remaining overhead:** one more App and environment, and the ruleset file kept in step with the live rulesets (the checker says when it drifts).
- **Why no orchestration service is needed:** Actions runs the work; the ledger branch, a compare-and-swap hash chain, is the claim and receipt store; rulesets and the gate App are the enforcement. A service would add another credential and another failure domain without closing anything these do not.

## G. Grades (evidence-based only)

| Area | Grade | Basis |
|---|---|---|
| Architecture | 78 | One lane after #68; the gate is one script and one workflow; legacy builders still present but off. |
| Security | 55 | F2 is open on GitHub until owner configuration. R-F5 is open. Secrets are repository-wide. |
| Reliability | 80 | Ledger compare-and-swap, atomic publish with leases, run-status settlement; full suites green. |
| Recoverability | 80 | Reconcile-required instead of clock expiry, stored-answer recovery for reviews, UNKNOWN orders halt; all tested. |
| Automation | 50 | One real build (#49 to #50). Model review off, gate off, labels missing; the demo stops at step 2. |
| Verification | 75 | Suites green; gate mutation-tested; fail-before tests for #68. No live adversarial probe. |
| Owner experience | Unverified | `/reviewed` receipts are not yet exercised on GitHub. |
| Trading-accounting safety | 80, paper scope only | 66 of 67 tests pass, plus the two open limits in E. Live trading is not graded. |

**Verdict: CHANGES REQUIRED.** F2 and R-F5 are open in effect, and the acceptance demonstration is incomplete.
