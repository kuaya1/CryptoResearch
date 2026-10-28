# De-escalation, stabilization and domain re-anchoring (2026-10-27)

Read-only audit against `docs/CONSTITUTION.md`. Nothing on GitHub, Render or any scheduler was changed, and no desk record was changed. The only writes were `doctor`'s own write probe and the test suite's temporary fictional workspaces. Every step below that changes something is Eric's.

**Baseline read:** `origin/main` at `a6efc26` (PR #70), not `f29e103`. #70 (`6a528a5`, portfolio read once per candidates call) landed after it. The audit ran from `docs/add-architecture-constitution` (`bb9d953`), which is `main` plus `docs/CONSTITUTION.md` and two `.gitignore` lines. Reads: `gh api` (rulesets, Actions runs and timing, variables, secret names, workflow states, branches, PRs, issues), the claude.ai routines list, the local scheduled-task list, and the code at the cited lines. Times are UTC, 2026-10-28 03:00–04:00.

---

## 1. Repository reality check

### 1.1 Workflows on `main` (all 12 `active` on GitHub)

| Workflow | Triggers | Gate | Paid model | Runs, last 24 h | Billable estimate |
|---|---|---|---|---|---|
| `test.yml` | push `claude/**` and `main`; PR to `main` | none | no | 108 | ~4 min each |
| `agent-builder-lane.yml` | cron `0 */6 * * *`; push `main`; `workflow_run` of test, agent-checks, agent-review; dispatch | `AGENT_PM_ENABLED` (unset: dry run, but the job **runs**) | OpenAI when on | **223** | 1 min each |
| `agent-review.yml` | `workflow_run` of test, agent-checks; `issue_comment`; cron `17,47 * * * *`; dispatch | `AGENT_REVIEW_ENABLED=false` blocks paid calls only; the job **runs** | OpenAI when on | **207** (133 ran) | 1 min each |
| `agent-checks.yml` | PR to `main` | none | no | 40 | 2 jobs × 1 min |
| `agent-build.yml` | `issues: labeled`; `issue_comment`; dispatch | label `agent:ready`/`agent:build`, `/revise` | **Anthropic, up to $8 a build** (`ANTHROPIC_API_KEY` is set) | 2 | ~3 min |
| `agent-sandbox-probe.yml` | dispatch | none | Anthropic | 2 | ~4 min |
| `release-gate.yml` | `workflow_run` of test, agent-checks, agent-review; `issue_comment`; cron `23,53 * * * *`; dispatch | `RELEASE_GATE_ENABLED` (unset; job-level `if`, so skipped) | no | 34, all skipped | 0 |
| `candidate-review.yml` | `workflow_run` of test; **`pull_request_target`** | `CANDIDATE_REVIEW_ENABLED=false` | OpenAI when on | 154 (2 ran) | ~3 min when it runs |
| `backlog-pr.yml` | `workflow_run` of test | branch filter | no | 114 (5 ran) | ~2 min when it runs |
| `visual-proof.yml` | `workflow_run` of test | branch filter | no | 114 (5 ran) | **~10 min** when it runs |
| `engineering-admission.yml` | push `claude/admission-eng-*` | none | no | 0 | — |
| `scout-cron.yml` | cron `30 11 * * *`; dispatch | `SCOUT_ENABLED` (unset); no `XAI_API_KEY` secret | xAI when on | 1, skipped | 0 |

Sources: `.github/workflows/*.yml` `on:` blocks; `gh workflow list --all`; `gh run list --limit 1000` (1,000 runs between 2026-10-27T03:23Z and 2026-10-28T02:56Z); `/actions/runs/<id>/timing` sampled 3 per workflow.

**What it costs.**
- **Paid model tokens today: zero, conditionally.**
  - No OpenAI request can be sent while `AGENT_REVIEW_ENABLED=false`, `AGENT_PM_ENABLED` is unset and `CANDIDATE_REVIEW_ENABLED=false`.
  - No xAI request can be sent: there is no key.
  - Anthropic spend is still one action away. `agent-build.yml` holds `ANTHROPIC_API_KEY` and starts on an issue label or a `/revise` comment.
- **Actions minutes: the meta-tooling now uses more than the product's CI.** Using GitHub's rounding of each job up to a whole minute:
  - The agent and backlog workflows used about 500 billable minutes in 24 hours.
  - `test` used about 430.
  - With nothing happening at all, the floor is about 50–100 minutes a day: `agent-review`'s 48 scheduled runs, each of which starts an `agent-builder-lane` run, plus four PM crons. That is roughly the whole 3,000-minute monthly allowance of a Pro account on a private repository.
  - The actual bill is **UNKNOWN**: the billing API needs the `user` scope, which this `gh` login does not have. See github.com/settings/billing.
- **Fan-out per push.** One push to a PR head starts `test` twice (once for the push to `claude/**`, once for the pull request). Each `test` completion then fans out to `agent-review`, `agent-builder-lane`, `backlog-pr`, `visual-proof`, `candidate-review` and `release-gate`. Each `agent-review` completion starts `agent-builder-lane` and `release-gate` again.

### 1.2 Live rulesets (`gh api repos/kuaya1/CryptoResearch/rulesets`)

| ID | Name | Rules | Bypass |
|---|---|---|---|
| 25967716 | `main-merge-requirements` | deletion, non_fast_forward, pull_request (0 approvals, merge commits only, `require_extra_approval_for_unattributed_changes: true`), required_status_checks **`test`, `agent-guard`, `agent-verify`, `agent-review`** (all app 15368), strict | none |
| 25967717 | `main-merge-authority` | `update` on `main` | admin, **pull_request only** |
| 25967715 | `automation-branches` | creation, update, deletion on every branch except `agent/**`, `agent-ledger`, `visual-proof`, `claude/intake-issue-*`, `claude/admission-*` | admin, **always** |
| 25967714 | `agent-ledger` | deletion, non_fast_forward on `agent-ledger` | none |

**What blocks the merge button today.** PR #70 is a typical example: authored and merged by `kuaya1`, head `6a528a5`.
- `agent-guard` and `agent-verify` pass at once, because an owner change is not a candidate.
- `agent-review` stays missing until Eric comments `/reviewed <full 40-hex head>`. That comment starts another `agent-review` run, which posts a neutral "Owner override".
- GitHub never lets Eric approve his own pull request, so that comment is the only way through.
- Any new commit, including "Update branch" under the strict policy, invalidates it unless the tree and patch-id are unchanged.

This is the "locked out of the merge button" symptom. The lock is the required `agent-review` context, nothing else.

**Drift:**
- The live `main-merge-requirements` carries `require_extra_approval_for_unattributed_changes: true`, which `.github/rulesets/main-merge-requirements.json` does not. Its exact effect is **UNKNOWN**. It did not stop #70.
- The live `automation-branches` excludes `claude/intake-issue-*`, which the file does not.

### 1.3 Repository settings, variables, secrets

- **Visibility:** private.
- **Settings:**
  - `delete_branch_on_merge: false`
  - Actions `default_workflow_permissions: read`, `can_approve_pull_request_reviews: true`
  - environments: 0
- **Variables:** `AGENT_REVIEW_ENABLED=false`, `CANDIDATE_REVIEW_ENABLED=false`, `BUILDER_APP_ID`, `BUILDER_APP_SLUG`, `DESK_URL`, `OPENAI_REVIEW_MODEL`. `AGENT_PM_ENABLED`, `RELEASE_GATE_ENABLED` and `SCOUT_ENABLED` are **unset**.
- **Secrets (names only):** `AGENT_LEDGER_KEY`, `ANTHROPIC_API_KEY`, `BUILDER_APP_KEY`, `CR_ENG_REVIEWER_TOKEN`, `OPENAI_API_KEY`.
  - With no environments, every one of them reaches any workflow file a pushed branch defines (`audits/2026-10-27-architecture-recovery` §"What the audit missed" 1).
  - `GATE_APP_KEY` and `XAI_API_KEY` do not exist.
- **Labels:** only `agent:build` exists. `agent:draft` and `agent:ready` do not.
- **Open issues:**
  - #49, still labeled `agent:build`, though its PR #50 is merged;
  - #67, "E2E demo (do not merge)", unlabeled.
- **Open PRs:** none.

### 1.4 Schedulers outside GitHub

| Where | Name | State | Note |
|---|---|---|---|
| claude.ai routine `trig_01Hw89ZHE8kWp2rQe3Kw3D26` | CryptoResearch backlog builder (A) | disabled | repo kuaya1/CryptoResearch |
| claude.ai routine `trig_01Adw24sNdYAtXTTyu13PqrW` | backlog builder B (burst) | disabled | repo kuaya1/CryptoResearch |
| claude.ai routines `trig_01DyNyXATyWCisELfHw8e6Um`, `trig_01KPf8fyNdiwTkYwgchnSCTn` | Monthly Strategic Review; Monday Pipeline & Demand Check | enabled | no repository attached; outside this repo, untouched |
| Local scheduled task `cr-at6-surge` | @6 watchlist refresh | **enabled**, every 2 h, next 2026-10-28T04:05Z | Its window closed 2026-10-28T03:00Z. Its own step 1 now runs nothing, but each fire still opens a session (`C:\Users\Kuaya\.claude\scheduled-tasks\cr-at6-surge\SKILL.md:10`). |

### 1.5 Branches and local debris

- **65 remote branches:**
  - 49 with a merged PR;
  - 2 already in `main` with no PR (`claude/epic-mccarthy-h6uaqs`, `claude/hopeful-dijkstra-rxphgp`);
  - 2 with a closed PR (`claude/backlog-batch-items-73-and-74` #55, `claude/eng-worker-daemon` #32);
  - 8 claim refs `claude/claims/item-67…74`;
  - `claude/ui-craft-l1-l7-shots`, `visual-proof` (screenshot orphan) and `agent-ledger` (paid-attempt history; the `agent-ledger` ruleset forbids deleting it).
- **39 git worktrees** under `.claude/worktrees/` (755 MB).
  - `.claude/worktrees/gate-replay` (branch `claude/gate-replay`) holds **uncommitted** changes to `agent-gate.js`, `agent-ledger.js`, `agent-pm.js`, `agent-review.js`, `agent-revise.js` and two tests (+170 lines).
  - That is another session's fix for flaw 2 below. Leave it to its owner; do not delete it with `--force`.
- `automation-branches.before.json` sits at the repo root (ignored, untracked): the rollback copy the rulesets README told Eric to keep out of Git.

### 1.6 Meta-tooling code on `main`

| Area | Files | Lines |
|---|---|---|
| Agent lane, PM, gate, ledger | `dashboard/scripts/agent-*.js` (13 files) | 3,811 |
| Backlog builders and merge train | `backlog-promote.js`, `backlog-queue.js`, `backlog-schedule.js`, `backlog-status.js`, `merge-train.js`, `merge-boundary-check.js` | 1,888 |
| Engineering inbox, connector tools, reviewer | `dashboard/engineering/*.js` (7 files), `engineering-worker.js` | 3,440 |
| Policy and templates | `.github/agent-policy*.json` (4), `.github/agent/` (6), `.github/ISSUE_TEMPLATE/agent-task.yml` | — |
| Tests that read `.github/` | 17 files in `dashboard/tests/` | — |

**Coupling into the desk.** These are the only places the product imports that code:
- `dashboard/server.js:1223` serves `GET /api/pipeline`, which reads `core/pipeline.js`. `core/pipeline.js:64-117` requires `backlog-status`, `backlog-schedule`, `agent-ledger` and `engineering/inbox`.
- `dashboard/server.js:1229` serves `GET /api/system/briefing`, which reads `scripts/agent-status.js`.
- `dashboard/frontdoor.js:143` mounts the engineering routes and `/mcp` engineering tools.
- `dashboard/cli.js:334-340` runs `system briefing`.
- `dashboard/web/src/views/system/PipelineCockpit.jsx:68` is the UI for `/api/pipeline`.
- `dashboard/engineering/policy.js:12`, `github.js:17` and `reviewer.js:33` import `scripts/backlog-promote.js`.

**Test baseline** (this branch, 2026-10-28T03:2xZ): `node dashboard/cli.js test` gives 1,345 tests: 1,344 pass, 0 fail, 1 todo (the journal gap, §3.3), in 146 s.

---

## 2. De-escalation punch list (Phase 1)

**Order matters.** `agent-guard`, `agent-verify` and `agent-review` are required contexts.
- Disable `agent-checks` or `agent-review` before the ruleset changes, and every PR waits forever for checks that never report.
- So the ruleset goes first.

Every step is Eric's: GitHub configuration, credentials, and his scheduled work. Every step except the deletions can be reversed.

**Status, 2026-10-27 (Eric approved this audit; Claude ran what needs no credential or security setting):**

| Step | State |
|---|---|
| 0 | Done. Copies in `Documents\cr-github-config-2026-10-27\`, with `deleted-branches.bundle` (the 62 heads, verified). |
| 1 | Done. Eric deleted `automation-branches` (25967715). Claude applied the PUT at his word: `main-merge-requirements` (25967716) requires `test` alone, from app 15368, with no bypass (2026-10-28T03:49Z). |
| 2 | Done. Eleven workflows disabled; only `test` is active. |
| 3 | **Eric's, open.** |
| 4 | The local task `cr-at6-surge` is deleted. Routines A and B in claude.ai are Eric's. |
| 5 | Done. #49 and #67 closed, `agent:build` deleted, `delete_branch_on_merge` on, 62 remote branches deleted (left: `main`, `agent-ledger`, `visual-proof`). The worktrees stay: most belong to Claude app sessions; the app removes them after 30 idle days. |
| 6 | PR-A built locally on `claude/retire-agent-lane-ci`, with a correction (below). Not committed or pushed. |

### Step 0: keep rollback copies (outside the repo)

```powershell
$bk = "$env:USERPROFILE\Documents\cr-github-config-2026-10-27"; New-Item -ItemType Directory -Force $bk | Out-Null
gh api repos/kuaya1/CryptoResearch/rulesets/25967716 --jq '{name,target,enforcement,conditions,rules,bypass_actors}' > "$bk\main-merge-requirements.before.json"
gh api repos/kuaya1/CryptoResearch/rulesets/25967715 --jq '{name,target,enforcement,conditions,rules,bypass_actors}' > "$bk\automation-branches.before.json"
gh variable list --repo kuaya1/CryptoResearch > "$bk\variables.txt"; gh workflow list --all --repo kuaya1/CryptoResearch > "$bk\workflows.txt"
```

### Step 1: make `test` the only required check (unblocks the merge button)

`main-merge-requirements`, ruleset 25967716. This is the live body with the four contexts cut to one. Nothing else changes:
- `require_extra_approval_for_unattributed_changes` stays at its live value;
- the strict policy stays (one supervised branch at a time rarely needs "Update branch");
- merge commits only, no deletion, no force-push, no bypass actor.

```powershell
$f = "$env:TEMP\main-merge-requirements.test-only.json"
@'
{
  "name": "main-merge-requirements",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false,
        "require_extra_approval_for_unattributed_changes": true,
        "allowed_merge_methods": ["merge"] } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": false,
        "required_status_checks": [ { "context": "test", "integration_id": 15368 } ] } }
  ],
  "bypass_actors": []
}
'@ | Set-Content -Encoding utf8 $f
gh api -X PUT repos/kuaya1/CryptoResearch/rulesets/25967716 --input $f
gh api repos/kuaya1/CryptoResearch/rulesets/25967716 --jq '[.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context]'
```

- **Expected:** `["test"]`.
- **Rollback:** `gh api -X PUT repos/kuaya1/CryptoResearch/rulesets/25967716 --input "$bk\main-merge-requirements.before.json"`.

**`main-merge-authority` (25967717) stays as it is.**
- It is not an "always allow" bypass. Its admin bypass is `pull_request` mode, so nobody, Eric included, can push `main` except by merging a PR.
- `main-merge-requirements` has no bypass at all, so `test` binds Eric too.

**The bypass that matters is in `automation-branches` (25967715).**
- It is the only ruleset whose admin bypass is `always`.
- It exists to fence the builder App and the Actions token off every branch.
- Once those identities are gone (step 3), it fences nothing. Delete it:

```powershell
gh api -X DELETE repos/kuaya1/CryptoResearch/rulesets/25967715
```

- **Keep `agent-ledger` (25967714).** It keeps the paid-attempt history from being rewritten or deleted, and costs nothing.

**The honest limit.** On a one-account repository, no GitHub setting separates "Eric" from "a local Claude session holding Eric's `gh` login". That login can merge any PR whose `test` passed. The circuit breaker is therefore three things:
1. `test` is required;
2. Claude Code deny rules (§4);
3. the instruction never to merge.

A second, non-admin GitHub account for Claude would be the only real boundary. That is more infrastructure, so it is not recommended.

### Step 2: silence every dispatcher (reversible)

```powershell
'agent-builder-lane','agent-review','agent-checks','agent-build','agent-sandbox-probe','release-gate','candidate-review','backlog-pr','visual-proof','engineering-admission','scout-cron' |
  ForEach-Object { gh workflow disable $_ --repo kuaya1/CryptoResearch }
gh workflow list --all --repo kuaya1/CryptoResearch   # only test is active
```

- A disabled workflow starts on no trigger: not schedule, not `workflow_run`, not `issues`, not `issue_comment`.
- Undo one with `gh workflow enable <name>`.
- `scout-cron` is product, not meta-tooling: it feeds Research › Scout. It is disabled here only because it is dormant (no `XAI_API_KEY`) and costs nothing off. Turning it on is a separate decision.

### Step 3: take paid credentials and bot identities out of the repository

```powershell
'ANTHROPIC_API_KEY','OPENAI_API_KEY','CR_ENG_REVIEWER_TOKEN','BUILDER_APP_KEY','AGENT_LEDGER_KEY' | ForEach-Object { gh secret delete $_ --repo kuaya1/CryptoResearch }
'AGENT_REVIEW_ENABLED','CANDIDATE_REVIEW_ENABLED','BUILDER_APP_ID','BUILDER_APP_SLUG','OPENAI_REVIEW_MODEL','DESK_URL' | ForEach-Object { gh variable delete $_ --repo kuaya1/CryptoResearch }
gh api -X PUT repos/kuaya1/CryptoResearch/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
```

- **Deleting a GitHub secret does not revoke the key.**
  - If the Anthropic and OpenAI keys were made only for GitHub, revoke them at each console.
  - Whether they are shared with Render is **UNKNOWN**. If they are, revoking them would break Render's research.
  - `CR_ENG_REVIEWER_TOKEN` is a token; revoke it where it was issued (**UNKNOWN** which).
- **`AGENT_LEDGER_KEY`:** GitHub cannot read a secret back. Without a copy kept elsewhere, the ledger's signed lines can no longer be verified, though they stay readable. That is acceptable for retired history.
- **Builder App:** uninstall and delete `kuaya1-cr-builder` (App ID 5487887) in GitHub › Settings › Developer settings, and delete its `.pem`.
- **Result:** after this step, no workflow a branch defines can reach a paid key. That closes `architecture-recovery` "missed" item 1, the highest-impact open hypothesis.

### Step 4: schedulers outside GitHub

- **Delete the local scheduled task `cr-at6-surge`** (Claude desktop › Scheduled tasks). Its window ended at 2026-10-28T03:00Z, but it still opens a session every 2 hours.
- **Delete routines `trig_01Hw89ZHE8kWp2rQe3Kw3D26` and `trig_01Adw24sNdYAtXTTyu13PqrW`** at claude.ai/code/routines. Both are disabled already; deleting them removes the one-toggle way back.
- **Leave the two enabled routines with no repository attached.** They are not this project's.

### Step 5: issues, labels, branches, local debris

```powershell
gh issue edit 49 --remove-label agent:build --repo kuaya1/CryptoResearch
gh issue close 49 --repo kuaya1/CryptoResearch -c "Delivered by #50. Agent lane retired (audits/2026-10-27-de-escalation)."
gh issue close 67 --repo kuaya1/CryptoResearch -c "Demo of the retired agent lane."
gh label delete agent:build --repo kuaya1/CryptoResearch --yes
gh api -X PATCH repos/kuaya1/CryptoResearch -F delete_branch_on_merge=true
```

**Delete 62 remote branches.** The list is explicit and audited in §1.5:
- 49 with a merged PR;
- 2 already in `main`;
- 2 with a closed PR;
- 8 claim refs;
- 1 screenshot branch.

Kept: `main`, `agent-ledger` (its ruleset forbids deleting it) and `visual-proof`. Old PR descriptions embed images from `visual-proof`. Deleting `claude/ui-craft-l1-l7-shots` breaks the screenshots in #42's description.

<details><summary>The 62 names and the command</summary>

```powershell
$del = @(
 'agent/issue-49','claude/agent-lane-redteam','claude/agent-v3-issue-link','claude/agent-v3-ledger-key','claude/agent-v3-live-issue',
 'claude/agent-v3-predecessor','claude/agent-v3-revise','claude/agent-v3-sandbox','claude/arch-recovery-a','claude/automation-branches-b',
 'claude/autonomous-pm-builder','claude/backlog-batch-items-67-68-69-70-71','claude/backlog-item-72','claude/builder-burst',
 'claude/candidate-eng-63','claude/candidate-eng-64','claude/candidate-eng-65','claude/candidate-eng-66','claude/connected-engineering',
 'claude/eng-agent-lane','claude/eng-backend-autonomy','claude/eng-convergence','claude/eng-lane-resilience','claude/eng-merge-boundary',
 'claude/eng-protected-case','claude/eng-review2-fixes','claude/eng-transition','claude/engineering-hardening','claude/grok-scout',
 'claude/next-phase-blueprint','claude/one-lane','claude/owner-receipts','claude/perf-brief-pilot','claude/pipeline-cockpit',
 'claude/pipeline-review-alignment','claude/red-team-claims','claude/red-team-lane','claude/red-team-recovery','claude/red-team-report',
 'claude/red-team-trader','claude/release-gate','claude/sandbox-probe-hardening','claude/trader-invariants','claude/trader-roadmap',
 'claude/trader-v2-paper','claude/trader-v2-risk','claude/ui-craft-l1-l7','claude/visual-proof','rc/integrity-r2',
 'claude/epic-mccarthy-h6uaqs','claude/hopeful-dijkstra-rxphgp',
 'claude/backlog-batch-items-73-and-74','claude/eng-worker-daemon',
 'claude/claims/item-67','claude/claims/item-68','claude/claims/item-69','claude/claims/item-70',
 'claude/claims/item-71','claude/claims/item-72','claude/claims/item-73','claude/claims/item-74',
 'claude/ui-craft-l1-l7-shots')
$del.Count   # 62
$del | ForEach-Object { git push origin --delete $_ }
git fetch origin --prune
```
</details>

**Local worktrees** (39, 755 MB under `.claude/worktrees/`):
- Remove only the clean ones:

```powershell
git worktree list --porcelain | Select-String '^worktree ' | ForEach-Object { $_.Line.Substring(9) } |
  Where-Object { $_ -match '\\.claude\\worktrees\\' -or $_ -match '/\.claude/worktrees/' } |
  ForEach-Object { if (-not (git -C $_ status --porcelain)) { git worktree remove $_ } else { "kept (has changes): $_" } }
git worktree prune
```

- `gate-replay` stays: it has another session's uncommitted work (§3.3, flaw 2).

### Step 6: the code, in two supervised PRs (each through §4)

**PR-A `claude/retire-agent-lane-ci`.** Only `.github/`, tests and docs; no desk code.
- **Delete these workflows:** `agent-build`, `agent-builder-lane`, `agent-checks`, `agent-review`, `agent-sandbox-probe`, `backlog-pr`, `candidate-review`, `engineering-admission`, `release-gate` and `visual-proof`.
- **Also delete:** `.github/agent/`.
  - **Correction (2026-10-27, found building PR-A):** `.github/agent-policy*.json` and `.github/ISSUE_TEMPLATE/agent-task.yml` move to PR-B, with their readers.
  - `core/pipeline.js:92` does read a missing policy as `limit = null`, but `agent-guard.js:62-63` `loadPolicy` does not catch, and two live desk paths call it:
    - `engineering/agent-issue.js:30`, behind the connector's `engineering_prepare_task`;
    - `scripts/agent-status.js:131`, behind `GET /api/system/briefing`, `cli system briefing` and `engineering_system_briefing`.
  - Six test files also call it at load: agent-guard, agent-issue, agent-pm, agent-review, agent-revise and agent-verify.
  - `agent-issue.test.js:119` reads the form's field IDs.
  - Deleting either file in PR-A would break working interfaces on the online desk.
- **`test.yml`:**
  - Triggers become `push: [main]` and `pull_request: [main]`. Dropping `claude/**` push ends the double run on every PR head.
  - Drop the comment about `backlog-pr`.
- **`.github/rulesets/`:**
  - `main-merge-requirements.json` = the step 1 body;
  - delete `automation-branches.json`;
  - cut the README to the three remaining rulesets (`main-merge-authority`, `main-merge-requirements`, `agent-ledger`).
- **Tests:**
  - Delete `agent-sandbox-probe.test.js` and `merge-boundary.test.js`.
  - `agent-workflows.test.js` becomes `workflows.test.js`: the contract for what is left. Two workflows; `test` on `main` and pull requests to `main`, read-only, no secret, pinned actions; the ruleset requires `test` alone; nothing writes, caches or holds a model or builder key.
  - Drop the two release-gate tests from `agent-gate.test.js` (they read `release-gate.yml` and the four-check ruleset).
  - The other files named in the first draft (`agent-issue`, `agent-revise`, `backlog-promote`, `engineering-*`, `pipeline-progress`) only name workflow paths as strings and need no change.
  - Keep `scout-cron.yml` and `scout-ingest.test.js` until Eric decides the Scout.
- **Docs:**
  - In `CLAUDE.md`, the Agent lane and PM builder bullets become one Engineering bullet pointing at `docs/CONSTITUTION.md` and §4 here.
  - Pipeline review keeps only the Junior Trader contract. Track 1 is dropped from "Track 1 serves Track 2". The lane tail of Autonomy review fixes goes.
  - The Agent task issue bullet stays until PR-B removes its code, and now says such an issue starts nothing.
  - `dashboard/web/README.md` no longer names `visual-proof.yml`.
- **Effect:** the scripts left behind are dead code that their own unit tests still exercise. Nothing runs them.

**PR-B `claude/retire-engineering-inbox`.** This touches more than three files and the online desk, so it is planned first, per Eric's defaults.
- **Delete:**
  - `dashboard/scripts/agent-*.js`, `backlog-*.js`, `merge-train.js`, `merge-boundary-check.js` and `engineering-worker.js`;
  - `.github/agent-policy*.json` and `.github/ISSUE_TEMPLATE/agent-task.yml` (moved here from PR-A; see its correction);
  - `dashboard/engineering/` and `core/pipeline.js`;
  - the routes `GET /api/pipeline` (`server.js:1223`) and `GET /api/system/briefing` (`server.js:1229`);
  - the engineering mount and its 30-minute GitHub merge sweep on the online desk (`frontdoor.js:143-146`, `engineering/routes.js:237-244`), which is a timer calling GitHub from inside the product;
  - CLI `system briefing` (`cli.js:334-341`);
  - `web/src/views/system/PipelineCockpit.jsx` and Preferences › Developer › Engineering (`shell/Preferences.jsx:250`, `Engineering.jsx`), with a bundle rebuild;
  - their tests.
- **Interface change:** the engineering connector's `engineering_*` tools go away. That is a working interface, so it is Eric's call whether any assistant still uses it.
- **Keep** `pilot.js`, `sanity-report.js`, `rollback-drill.js`, `blitz-scorecard.js` and `grok-cron.js`.
- **Docs:** retire `DESK_STATE.md` "Active Backlog" (lines 65–116) and "Autonomous Build Backlog" (347 onward) to a frozen history note.

---

## 3. Core desk and data recovery (Phase 2)

### 3.1 The journey reads nothing GitHub produces

| Hop | UI | Reads | Writes |
|---|---|---|---|
| Watchlist | `web/src/views/watchlist/Watchlist.jsx` | `GET /api/session`, `/api/ui-state`, `/api/index`, `/api/version` poll (`web/src/lib/desk.js:24,214,411,489,574`) | `POST /api/ui-state` (`desk.js:346`), `/api/market/refresh` (`StatusStrip.jsx:48`) |
| Inspector `?p=<id>` | `web/src/views/inspector/Inspector.jsx:101-102`, `lib/router.js:44-51` | index row + `GET /api/projects/<id>`, `/api/agenda` | reviewed/undo (`lib/review.js:61,75`), archive, restore, watch |
| PM decision card | `PMDecisionCard.jsx:232` (`p.ticket` from `/api/index` ← `core/indexer.js:370-377` ← `tickets.summary`, `tickets.js:1629-1637`) | — | `POST …/tickets/decisions` (`PMDecisionCard.jsx:258` → `server.js:1049` → `tickets.decide`), `…/tickets/pilot` (`:170`), `…/tickets` (`:278`) |
| Project page `#/project/<id>/<tab>` | `ProjectPage.jsx:189-198`, `public/project-routes.js:11-64` | `GET /api/projects/<id>`, `…/changes`, `…/forensics`, `…/outcomes`, `…/reports/<rid>/original` | notes, claims, corrections, identity, research jobs |

- `core/indexer.js`, `brief-daily.js` and `forensic-agenda.js` reference no GitHub, engineering or pipeline code.
- **The only surfaces that read GitHub-made state, all retired in PR-B:**
  - `#/pipeline` (`PipelineCockpit.jsx:68` → `core/pipeline.js`, which reads the local `origin/agent-ledger` ref and says `known:false` without it, `pipeline.js:79-80,93-94`);
  - Preferences › Developer › Engineering;
  - `/api/system/briefing`, which no UI calls; only `cli.js:336` and `engineering/tools.js:76` do.

### 3.2 Data protection does not depend on any workflow

- **Prices:**
  - `core/market.js:451-473` through `jobs.runJob('market')` (`core/jobs.js:155-167`).
  - Checked every 60 s (`server.js:715`).
  - Due every 15 min on Render while viewed (`hosted.js:71,123-124`), else 60 min (`core/workspace.js:37`).
- **Backups:**
  - **Daily snapshot:** `exporter.createBackup` (`core/exporter.js:811-889`, SHA-256 manifest; keeps 14 plus 12 monthly, `:954-974`). It runs from the server's 30-minute daily-jobs timer (`server.js:725-726`, `jobs.js:97-100,201-204`) on the PC and on Render, and from the PC's Windows task `\CryptoResearch\Hourly` (`scripts/scheduled-run.cmd`).
  - **Offsite:** the PC pulls the online desk daily (`jobs.js:101-103`, `core/offsite.js`).
- **Checked now (read-only):**
  - `offsite status`: last pull 2026-10-27T04:25:56Z by the scheduler; 49 projects, 158 reports, 221 transactions, desk revision `e573d0d`.
  - `offsite verify` on that file: `ok: true`, 1,579 files, no problems.
- **Reports:**
  - Stored under `projects/<id>/reports/<date>_<provider>_<hash8>/`, holding `original`, `report.json` and `meta.json` with `original_sha256` (`core/inbox.js:392-449`).
  - Verified on backup verify (`exporter.js:898-949`), restore (`:677-692`) and drill (`offsite.js:342-354`).
- **Gap, P3, unrelated to CI:** `GET …/reports/<rid>/original` serves the bytes without re-hashing them (`server.js:915-925`). The hash is checked on verify, restore and drill, not on each read.
- **Recommended once, after step 2:** `node dashboard/cli.js offsite drill`. It restores the latest pulled copy in isolation and checks records, originals and research state, with zero provider calls.

### 3.3 The two open flaws

**Flaw 1: paper-journal tail (head) truncation.** Protected module: `dashboard/core/paper-trader.js`.

- **What is true:**
  - The journal (`paper/trader/journal.jsonl`, `paper-trader.js:80`) is a back-linked hash chain. Each line carries `seq` and `prev_sha256` (`:362-365`), and `parseJournal` refuses any line that does not follow (`:114-125`).
  - Nothing stores the last `seq` or head hash anywhere else. A chain with its last lines cut off is still a valid chain, so the book silently goes back in time. That is the `todo` test at `dashboard/tests/paper-trader.test.js:543-551`.
  - It is worse than a tail cut. `readText` (`:127-129`) maps **any** read error to `''`, so an unreadable or deleted journal reads as a fresh, unfunded book.
  - `venue.jsonl` (`:81`) is not chained at all.
- **Fix, with no key and no new service.** One version step (`cr-paper@2` journal anchor), done in a supervised PR with deliberate review of a protected file:
  1. **Anchor file.** In the same `runOp` as each journal write (`:355-371`), write `paper/trader/journal.head.json` = `{ seq, head_sha256, at }`, journal first, then anchor.
  2. **Read check.** The journal must have at least `anchor.seq` lines, and line `anchor.seq` must hash to `anchor.head_sha256`.
     - Fewer lines, or a different hash, is `INTEGRITY`: nothing is read or written, and every order stays as it is.
     - More lines, with the chain intact, means the process crashed between the two writes. The anchor moves forward.
  3. **Missing files.** `readText` keeps `''` only for `ENOENT`, and a missing journal with an anchor present is `INTEGRITY`.
  4. **Venue cross-check.** Every `client_order_id` in `venue.jsonl` must have its `reserved` and `sent` events in the journal. A venue order the journal does not know is `INTEGRITY`.
  5. **Turn the `todo` into a real test,** plus three more: anchor ahead of the journal, journal deleted, a venue order unknown to the journal.
- **What it does not do.** It does not stop someone who rewrites both files consistently. That was the MAC's job. In a supervised setup the only writers are Eric and his local session, and a key on the same disk would not stop them either.
- **What it does catch.** The real risks:
  - a crash mid-write;
  - a full disk (the online desk ran out of space on 2026-10-16);
  - a one-file restore;
  - a hand edit.

**Flaw 2: release-gate replay.**
- **Where it is.** `dashboard/scripts/agent-gate.js:109-121` `modelPass`.
  - It checks the MAC over `{...a.response, binding: a.reserve.binding}`.
  - It then matches the head with `a.reserve.bind.head`, a plain field the MAC does not cover.
  - So a copy of a signed pass for head A, with only `bind.head` changed to B, clears B.
- **Where it came from.** The uncommitted tests in `.claude/worktrees/gate-replay` (another session, branch `claude/gate-replay`, citing "GPT's independent audit of f29e103") reproduce it and add `L.signedVerdict`.
- **Why it is inactive:**
  - `release-gate.yml:47-48` runs only when `RELEASE_GATE_ENABLED == 'true'`, which is unset.
  - There is no gate App, no `release-gate` environment, and no `GATE_APP_KEY`.
  - All 34 runs in 24 h were skipped.
  - Forging the line needs push access to `agent-ledger`, which only the Actions token and Eric have.
- **Resolution: isolate by deletion, not repair.**
  - Step 2 disables the workflow. Step 1 drops `agent-review`, the one live consumer of ledger verdicts, from the required checks. PR-A deletes `release-gate.yml`. PR-B deletes `agent-gate.js`.
  - Do not merge the `gate-replay` fix: it is 170 lines of hardening for code being retired.
  - The worktree belongs to its session. It should be dropped by that session or by Eric, not swept up with `--force`.

---

## 4. The supervised workflow standard

One task, one branch, one PR, one merge. Claude works only in Eric's terminal session; no session builds in the background.

**1. Scope.**
- Eric names one task. Claude reads the code first (Law 4).
- Claude answers in five lines or fewer: the files it will touch, the test it will add, and what it will not touch. Protected modules are named explicitly.
- Then:

```powershell
git fetch origin --prune
git switch -c claude/<short-name> origin/main
```

**2. Build and prove locally.**

```powershell
node dashboard/cli.js test
```

- For UI changes, also run `npm --prefix dashboard/web run build` then `npm --prefix dashboard/web run check`, and commit the rebuilt bundle.
- Claude quotes the counts line as printed (baseline: 1,345 / 1,344 pass / 0 fail / 1 todo). A failure is shown with its output, never summarized as a pass.

**3. Commit, push, open the PR. Only when Eric says so.**

```powershell
git add <the named files>
git commit -m "<what and why>"
git push -u origin claude/<short-name>
gh pr create --base main --fill
```

- GitHub runs `test` once on the PR.

**4. Eric reviews and merges.**

```powershell
gh pr diff <n>
gh pr checks <n> --watch
```

- Eric merges with the button (merge commit). No `/reviewed` comment, no second check.
- The branch deletes itself (`delete_branch_on_merge`).
- Render deploys `main`. Confirm `https://cryptoresearch.onrender.com/healthz` shows the merge SHA.
- Then `git switch main; git pull`.

**Guard rails in `.claude/settings.json` (deny rules).** They are guard rails, not a boundary: Eric's login can still merge.

```json
{ "permissions": { "deny": [
  "Bash(gh pr merge:*)", "Bash(git push origin main:*)", "Bash(git push origin HEAD:main:*)",
  "Bash(gh workflow enable:*)", "Bash(gh secret set:*)", "Bash(gh variable set:*)", "Bash(gh api -X PUT repos/kuaya1/CryptoResearch/rulesets:*)"
] } }
```

- Add the same patterns for the PowerShell tool, and confirm the exact rule syntax for it when the file is written (**UNKNOWN** here).

---

## 5. Domain implementation matrix (Phase 3)

Ordered by what unblocks the Junior Trader desk first. Each row is one supervised PR. Protected files are marked **P** (`trader-boundary.test.js`). A changed rule is published as a new version and never edited in place (`templates/README.md`).

### 5.1 Exit physics: what the code does today

- **Sizes.**
  - The monitor quotes $100, $500 and $2,000 on the chains Eric approves (`forensic-defs.js:42-43` `exit_sizes_usd`, `exitquotes.js:523-526`).
  - The ticket gate uses $500 only (`tickets.js:90`, `:373-376`).
  - The ticket packet adds a **hard-coded** $2,000 (`tickets.js:607`).
- **One-way exit cost.**
  - **Quote:** `cost = (sell − (received − gas)) / sell × 100` (`forensic-model.js:299-300`).
  - **Constant product from both reserves:** `mid = Rq·q$/Rb`, `in = (size/mid)(1−f)`, `out = in·Rq/(Rb+in)`, `cost = 1 − out·q$/size` (`:317-324`). This is always a lower bound, because gas is unknown (`:323`).
  - **Round trip:** NOT FOUND.
- **Two 5% settings for one idea:** `tickets.sizing.max_exit_cost_pct` (`tickets.js:91`, gate) and `forensics.preferences.exit_cost_limit_pct` (`forensic-defs.js:44`, impairment).
- **Concentrated liquidity and Uniswap v4 hooks: NOT FOUND.**
  - Reserves from any mechanism other than constant product are refused (`forensic-model.js:309`).
  - v3 and v4 depth reach the desk only through the route an aggregator picks (`forensic-defs.js:126`).
- **Transfer tax.** A positive tax is never subtracted. It makes the cost a lower bound (`forensic-model.js:259-274`), which the gate refuses (`tickets.js:375`).

**On v3/v4 and hooks: do not build tick or hook math.** An executable quote at the exact size is the router simulating the ticks and the hook fee for the path it would take. That is more exact than a local model of a pool whose hook can change its fee per swap. What the quote cannot promise is that the fee holds until an order is sent. The desk already says so (`forensic-model.js:301`), and that is the right boundary. A "hooked pool on the route" flag would need the aggregator's route detail; whether the stored raw quote carries pool types is **UNKNOWN**. Read the stored observations before designing it.

### 5.2 The matrix

| # | Area | Files | Change | Why (evidence) | Proof |
|---|---|---|---|---|---|
| D1 | Exit gate picks the wrong reading | `core/forensic-model.js:359,367`; `core/tickets.js:262-272` | The gate takes the cheapest **complete** reading in freshness; a lower bound only when no complete reading exists. `cr-forensic-liquidity@4` + `cr-ticket-sizing@3` | `best` is the cheapest of all estimates, incomplete included. A 3% "at least" hides a complete 4%, and `tickets.js:375` then refuses a ticket that should pass | Test: complete 4.0% plus incomplete 3.0% at $500 → `exitOk`; incomplete only → refused as today |
| D2 | Solana exits can never pass | `core/forensics.js:1181`; `core/screening.js:190-194` | `taxIndex` takes GoPlus Solana `transfer_fee_pct` as the sell tax when the transfer-hook check is clean | `taxIndex` keeps only rows whose `sell_pct` is a number, and the Solana screen always sets `sell_pct: null` while it does store `transfer_fee_pct`. **Eric decides** whether a Token-2022 transfer fee is the whole Solana sell tax | Test: Solana screen with `transfer_fee_pct: 0` → tax 0 known |
| D3 | Solana network fee unknown | `core/exitquotes.js:266` | A per-chain network-fee **ceiling** setting, labeled as Eric's assumption, which makes the cost a complete upper bound | Jupiter answers carry `gas_usd: null`. With D2 alone, every Solana reading is still "at least". **Eric decides** the ceiling, or accepts that Solana never passes | Test: ceiling set → complete; unset → "at least" as today |
| D4 | One exit ladder, $100 / $500 / $2,000 against 5% | `core/tickets.js:90-91,607`; `web/src/views/inspector/PMDecisionCard.jsx`; `web/src/views/project/forensics/` | The ladder becomes a sizing setting (`exit_ladder_usd`) instead of the hard-coded 2000. The PM card shows three read-only rows (cost, complete or at least, age). One source for the 5% limit, or both shown side by side | Today the $2,000 row disappears if Eric removes 2000 from the Forensics preferences (`forensics.js:1473`) | Test: ladder from the setting; rows say "no reading", never 0 |
| D5 | Prompts pinned when they run | `core/tickets.js:453-462`; `core/forensics.js:476-485`; `core/prompts.js:522`; new research lock file | Check the template's SHA-256 against its `LOCK.json` before use (the pattern of `scripts/grok-cron.js:50-56`); a mismatch is `INTEGRITY` and nothing starts. Add `research-prompt.v6.md` and `grading-appendix.v6.md` to a lock file | Ticket and forensic LOCKs are checked only in tests (`tickets.test.js:100-104`, `forensics.test.js:59-66`). Research @6 is pinned only by a test fingerprint (`prompt-v5.test.js:214,230`) | Test: one changed byte → refused, nothing written |
| D6 | Researcher and Prosecutor kept apart by tools, not words | `.claude/agents/forensic-researcher.md`, `.claude/agents/junior-trader-prosecutor.md` | Add `tools:` allow-lists: the researcher gets research tools and the web, no ticket tools; the Prosecutor gets `get_report`, `start_ticket`, `save_ticket` and the web, no `save_report`. Fix "`cr-ticket-sizing@1`" (prosecutor `:22`) to `@2` (`tickets.js:41`) | Neither file has a `tools:` line, and the connector checks only which model is calling (`mcp.js:1872,1914`). `npm run pilot` already enforces it (`scripts/pilot.js:37,140,160`) | Read the agent definitions back; one pilot run through `/pilot-run` |
| D7 | Journal anchor (flaw 1) | **P** `core/paper-trader.js:80,114-129,355-371` | §3.3 | `todo` at `paper-trader.test.js:543` | The todo becomes a pass, plus 3 tests |
| D8 | Grant bound to the stored decision (T-P2-15) | **P** `core/paper-trader.js:304,322`; **P** `core/trade-risk.js:287-299`; `core/tickets.js:1256`; new `templates/schemas/trade-intent.v3.schema.json` | `cr.trade-intent.v3`: the engine reads `pm_approved_risk_usd` and `suggested_risk_usd` from `projects/<id>/tickets/decisions.jsonl` by `receipt_id` and `decision_id`, with `thesis_id = receipt_id`. A caller-supplied grant is refused | `ctx.grant` is caller-supplied today, and `tickets.js` has no `thesis_id` | Test: a grant differing from the stored decision → refused; a vetoed decision → refused |
| D9 | `NOT_FOUND` before any real venue | **P** `core/paper-trader.js:84,533-535`; `DESK_STATE.md:257` | Today: no entry in `venue.jsonl`, 60 minutes after send by the caller's clock → `NOT_FOUND`. That is sound for the simulated venue, whose file is complete by construction. Before a real venue, `NOT_FOUND` needs that venue's explicit "unknown order" answer for the `client_order_id`, and the window becomes the venue's documented one. Fix `DESK_STATE.md:257` ("only when the venue says so") to say what the code does | There is no `LOST` state; `UNKNOWN` halts every intent (`trade-risk.js:205-209`) and is never cancelled (`paper-trader.js:582`). The clock gates only `NOT_FOUND` | Doc change now; a code change only with a venue adapter, which nothing authorizes |
| D10 | Sizing rules unset → everything refused | `DESK_STATE.md:297,309,337`; settings | Eric sets `stop_min_pct`, `stop_min_atr` and `notional_max_pct`. Fix the docs to the code's formula | `trade-risk.js:152-155,270` refuse every intent while they are unset. The docs give `risk/(entry−stop)`; the code is stricter: `risk / (entry − stopFill + fee(entry) + fee(stopFill))` with `stopFill = stop·(1−25 bps)` and the quantity floored to the lot (`trade-risk.js:310-313`) | Doc change; the values are Eric's |
| D11 | Exit cap from the desk's own measurement | **P** `core/paper-trader.js:321`; `core/trade-risk.js:321` | `exit_max_usd` = the largest ladder size whose **complete** cost is ≤ the limit (D1, D4), read from the Forensics view, never caller-supplied | It is caller-supplied today | Test: ladder 1.2% / 3.8% / 7.5% → cap $500 |
| D12 | End-to-end paper demonstration | new `dashboard/tests/paper-trader-e2e.test.js` (fictional only) | One scenario, asserted to the cent (details below) | Nothing calls the engine (`trader-boundary.test.js:124-132`). The UI and the decisions still use `cr-paper@1`, which takes the risk as the notional (`paper.js:148,272`; `/api/paper` at `server.js:1214`; `tickets.js:1303`) | The test. Wiring Approve → v2 intent → book comes after D8 and is Eric's decision |

**D12 scenario:**
1. Fund $10,000.
2. A v3 intent from a stored $500 approval, with a stop that respects the stop floor.
3. Quantity from loss at the stop with fees and 25 bps of slippage.
4. Reserve, then send.
5. The acknowledgement is lost, so the order is `UNKNOWN` and a second intent is refused with `halt_unresolved`.
6. Reconcile by `client_order_id`.
7. A partial fill (`FILL_SHARE_MAX` 0.1).
8. The stop hits with slippage and the taker fee.
9. Check NAV, realized P&L and `open_risk_usd`.

**NAV as built** (`paper-trader.js:257-267`):
- `NAV = cash + Σ quantity × fresh close`, with no liabilities term. That is correct here: no margin and no borrowing, so liabilities are zero by construction.
- NAV is `null`, never 0 or the entry, when any open position has no close within 120 minutes (`:85,263`).
- The risk cap and the 24-hour ceiling use it as the denominator (`trade-risk.js:261,280,282`).
- Committed cash is taken off only in `available_cash_usd` (`paper-trader.js:310`), not off NAV. That is correct.
- **Option for illiquid tokens (Eric's):** a liquidation NAV, close minus the exit cost at that size from D11, would be the conservative denominator.

**Order of work:**
1. Phase 1 steps 1–5 (configuration, about 15 minutes).
2. PR-A.
3. D1–D3, which unblock real tickets.
4. D5–D6.
5. D7.
6. D10 (Eric's values).
7. D8.
8. D11.
9. D12.
10. PR-B, whenever Eric confirms no assistant uses the engineering connector.

D4 can go in with D1.
