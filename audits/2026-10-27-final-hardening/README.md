# Final hardening: release gate, owner receipts, GH013 (2026-10-27)

This is the owner packet for the hardening directive's P1 (F2), P2 (owner review) and P4 ("Cannot update this protected ref").

- **P2:** pull request #65, owner receipts.
- **P1:** pull request #66, the release gate. It is inert until Eric creates its App and environment and changes one ruleset.
- **P4:** nothing in this packet changes a ruleset, secret, variable, environment or App. Each such step below is Eric's to apply.

## Verified state (read-only, 2026-10-27)

- **main:** `b10a7e6`.
- **Rulesets:** four are active (`gh api repos/kuaya1/CryptoResearch/rulesets`):

  | ID | Ruleset |
  |---|---|
  | 25967714 | `agent-ledger` |
  | 25967715 | `automation-branches` |
  | 25967716 | `main-merge-requirements` |
  | 25967717 | `main-merge-authority` |

- **Secrets:** all are repository secrets: `AGENT_LEDGER_KEY`, `ANTHROPIC_API_KEY`, `BUILDER_APP_KEY`, `CR_ENG_REVIEWER_TOKEN`, `OPENAI_API_KEY`.
- **Environments:** none.
- **Boundary check:** `node dashboard/scripts/merge-boundary-check.js` answers "Merge boundary does NOT hold": the live `automation-branches` excludes differ from the file (see P4).

## F2: the required checks can come from the pull request itself

`main-merge-requirements` requires `test`, `agent-guard`, `agent-verify` and `agent-review` with `integration_id` 15368. That ID is GitHub Actions, which means any workflow file. A pull request that adds or edits a workflow can therefore post all four as successes.

**Evidence:**
- **The run.** Check run 122526964351 (`agent-review`, "Not Eric's own change: review this head", on `3a6a6bb`) was posted by #60's own `agent-checks.yml`. Main's file at the time had no such title.
- **The suite.** GitHub filed it into the check suite of a different workflow run (`test`, run 40600429285). A check's suite does not tell which workflow made it.

**Who can exploit it today:** only a credential that can push workflow changes, because the builder App has no Workflows permission. That means Eric's `kuaya1` login, including any local agent session using his `gh` login (R-F5 below). The exploit was established from configuration and this evidence; it was not probed live.

## P1: the release gate (#66)

**What changes:**
- **The gate:** `release-gate.yml` runs main's `dashboard/scripts/agent-gate.js` and posts one check, `release-gate`, with its own GitHub App.
- **The ruleset:** it then requires `release-gate` from that App's ID.
- **What the gate reads:**
  - the required jobs, by main's workflow files, from the Actions API;
  - Eric's receipts (#65);
  - the ledger's signed verdicts.
  
  It never trusts a check by its name.

| Attempt | Why it fails |
|---|---|
| A pull request's workflow posts `release-gate` as a success | It posts as GitHub Actions (15368); the ruleset requires the gate App's ID. |
| A pull request's workflow reads the gate App's key | The key is a secret of the `release-gate` environment, whose deployment branches are `main` only; a `pull_request` run is on `refs/pull/<n>/merge`. |
| A pull request adds `evil.yml` with a job named `test` | The gate reads the job only from a run of `.github/workflows/test.yml` (or `agent-checks.yml`) for this head, this pull request, this repository, event `pull_request`. |
| A pull request edits `test.yml` or `agent-checks.yml` to pass | Any change under `.github/workflows/` or `.github/actions/` makes the jobs its own: only Eric's receipt of that exact head clears it, and a model pass does not stand in. |
| A pull request edits `release-gate.yml` or `agent-gate.js` | `workflow_run`, `issue_comment` and `schedule` run main's file and check out main. The edit is a definition change too. |
| A forged ledger line says "pass" | Its MAC is checked with `AGENT_LEDGER_KEY`. |
| Someone else's `/reviewed` comment, or an edited one | Only the owner's (`User`, `OWNER`), unedited, naming the full head, counts (#65). |
| A moved action tag in `test.yml` | `test.yml` now pins every action to a commit, as `agent-checks.yml` already did. |

**Tests:** `dashboard/tests/agent-gate.test.js`, 8 tests (fake GitHub, local Git, FICTIONAL records). A mutation check confirms the tests catch the gate being broken: removing any of these makes at least one test fail:
- the path filter;
- the pull-request filter;
- the definition rule;
- the MAC check;
- the token check.

### Owner steps, in order

**1. Merge #65.** Until it is on main, its own `agent-review` comes from today's dispatch:

```bash
gh workflow run agent-review.yml --repo kuaya1/CryptoResearch --ref main -f mode=eric-reviewed -f pr=65 -f head=<#65's head>
```

**2. Create the gate App.** In GitHub, go to Settings, Developer settings, GitHub Apps, New GitHub App:
- **Name:** for example `kuaya1-cr-gate`. **Homepage:** the repository.
- **Webhook:** off.
- **Repository permissions:** **Checks: Read and write**, and nothing else (Metadata read is automatic).
- **Where it can be installed:** "Only on this account".
- **After creating it:** note its **App ID**, generate a private key, and install it on `kuaya1/CryptoResearch` only.

**3. Create the environment, its secrets and the variables:**

```bash
gh api -X PUT repos/kuaya1/CryptoResearch/environments/release-gate -F "deployment_branch_policy[protected_branches]=false" -F "deployment_branch_policy[custom_branch_policies]=true"
```

```bash
gh api -X POST repos/kuaya1/CryptoResearch/environments/release-gate/deployment-branch-policies -f name=main -f type=branch
```

```bash
gh secret set GATE_APP_KEY --repo kuaya1/CryptoResearch --env release-gate < path/to/the-private-key.pem
```

```bash
gh secret set AGENT_LEDGER_KEY --repo kuaya1/CryptoResearch --env release-gate
```

For the last one, paste the same value as the repository secret when asked; it never goes into chat or a file.

```bash
gh variable set GATE_APP_ID --repo kuaya1/CryptoResearch --body <App ID>
```

**4. Merge #66.** Its own `agent-review` is Eric's receipt, the same as #65's.

**5. Turn it on and watch it post:**

```bash
gh variable set RELEASE_GATE_ENABLED --repo kuaya1/CryptoResearch --body true
```

```bash
gh workflow run release-gate.yml --repo kuaya1/CryptoResearch --ref main
```

Then, on any open pull request's head, the `release-gate` check's `app.id` must equal `GATE_APP_ID`:

```bash
gh api repos/kuaya1/CryptoResearch/commits/<head>/check-runs --jq ".check_runs[] | select(.name==\"release-gate\") | [.app.id, .conclusion, .output.title]"
```

**6. Require it.** This is the effective security change.
- **Before:** `.github/rulesets/main-merge-requirements.json`. It equals the live ruleset 25967716 (four contexts, all 15368).
- **After:** the same, plus `{ "context": "release-gate", "integration_id": <App ID> }`:

```bash
node dashboard/scripts/agent-gate.js ruleset --app-id <App ID> > release-gate-ruleset.json
```

```bash
gh api -X PUT repos/kuaya1/CryptoResearch/rulesets/25967716 --input release-gate-ruleset.json
```

- **Rollback**, in one command:

```bash
gh api -X PUT repos/kuaya1/CryptoResearch/rulesets/25967716 --input .github/rulesets/main-merge-requirements.json
```

- **Afterwards:** a pull request updates the repository's file to match, along with `merge-boundary.test.js` and the boundary checker's expected contexts.

**7. The adversarial after-test.** It needs Eric's account (only it can push a workflow change), and he must not merge it:
1. **Set it up:** branch `probe/gate-spoof` from main and add to `.github/workflows/agent-checks.yml` a job with `checks: write` that posts `test`, `agent-guard`, `agent-verify`, `agent-review` and `release-gate` as `success` through `POST /repos/kuaya1/CryptoResearch/check-runs` with `github.token`.
2. **Open it** as a pull request titled "PROBE: do not merge".
3. **Expected:**
   - the five spoofed successes appear as GitHub Actions;
   - the gate App's `release-gate` reads "Missing: this change edits workflow definitions, so only kuaya1's review of <head> clears it";
   - GitHub says merging is blocked;
   - `gh pr merge <n> --merge` is refused.
4. **Do not** comment `/reviewed` on it. Close it and delete the branch.

### What the gate cannot see (R-F5, Eric's decision)

**GitHub knows a person only by account.** Any process holding the `kuaya1` credential is "Eric" to GitHub, including this PC's `gh` login, which local agent sessions use. Such a process can:
- comment `/reviewed`;
- approve;
- push workflow changes;
- use the admin bypass of `automation-branches`.

Neither the gate nor #65 can tell those apart from Eric. The remedy is an identity for agent sessions that is not his: a machine account or an App with Contents and Pull requests on this repository only, and Eric's own credential kept out of their reach.

**Repository secrets reach any workflow.** A repository secret is available to any workflow a pushed branch defines. Moving `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `BUILDER_APP_KEY` and `AGENT_LEDGER_KEY` into environments limited to `main` closes that path. This is a follow-up: each job that uses them gains `environment:`.

## P4: "Cannot update this protected ref" (GH013)

GH013 is GitHub's refusal of a push to a ref a ruleset protects. An admin push shows it as "Bypassed rule violations … Cannot update this protected ref", as this session's own push of `claude/owner-receipts` did today (`kuaya1`, admin bypass "always").

| Push | Refused by | Who still gets through |
|---|---|---|
| Anything directly to `main` | `main-merge-authority` (`update`; the admin bypass is "pull request" only) and `main-merge-requirements` | Nobody: `main` changes only by Eric's pull-request merge. `backlog-promote.js` `admit` without `--propose` pushes `main` and always fails now. `engineering-admission.yml` uses `--propose`. |
| Any branch outside the `automation-branches` excludes: creation, update, deletion | `automation-branches` | Only the admin role. `GITHUB_TOKEN`, the builder App and any non-admin credential are refused. |
| `claude/backlog-*`, `claude/claims/**`: the backlog builders' branches and claims (`backlog-schedule.js`, `backlog-promote.js`, `merge-train.js`) | `automation-branches`: live does not exclude them (drift) | Only the routines, which push as `kuaya1` and so work only through Eric's admin bypass. Both routines are disabled (`enabled: false`). |
| `agent-ledger` rewrite or deletion | `agent-ledger` | Nobody (no bypass). |

**The drift.** The live `automation-branches`, updated 2026-10-27 10:58 -04:00, still excludes `claude/intake-issue-*`, which nothing creates since the issue queue (#56). It does not exclude `claude/backlog-*` or `claude/claims/**`. The repository's file says the reverse; #56 changed the file, but the owner step to re-apply it was not done.

**Recommendation: option B, narrower than either.** Retire the backlog builders with the one-lane migration (P3) and do not widen the ruleset for them.

| | `include` | `exclude` |
|---|---|---|
| Before (live) | `~ALL` | `agent/**`, `agent-ledger`, `visual-proof`, `claude/intake-issue-*`, `claude/admission-*` |
| Option A (the file as #56 wrote it) | `~ALL` | `agent/**`, `agent-ledger`, `visual-proof`, `claude/admission-*`, `claude/backlog-*`, `claude/claims/**` |
| Option B (recommended) | `~ALL` | `agent/**`, `agent-ledger`, `visual-proof`, `claude/admission-*` |

- **Option A** lets a non-admin identity push the builders' branches. It is needed only if the routines move off Eric's account.
- **Option B** only removes an exclude nothing uses; every push the agent lane makes stays allowed.

Option B needs:
1. A pull request that makes `.github/rulesets/automation-branches.json` match it, and updates `merge-boundary.test.js`, which currently requires the `claude/backlog-*` and `claude/claims/**` excludes.
2. Then Eric applies it:

```bash
gh api -X PUT repos/kuaya1/CryptoResearch/rulesets/25967715 --input .github/rulesets/automation-branches.json
```

**Rollback:** re-apply the live state as read on 2026-10-27, which is kept beside this file. Read the live ruleset again just before applying, in case it changed since:

```bash
gh api -X PUT repos/kuaya1/CryptoResearch/rulesets/25967715 --input audits/2026-10-27-final-hardening/automation-branches.live-2026-10-27.json
```

**Checker:** `merge-boundary-check.js` then holds again.
