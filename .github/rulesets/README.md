# Merge boundary rulesets

These four files are the GitHub repository rulesets for exclusive merge
authority (Eric, 2026-10-26; `audits/2026-10-26-engineering-simplification`).
They are applied by Eric, not by any workflow. Until he applies them they are
only files.

| File | What it enforces | Bypass |
|---|---|---|
| `main-merge-authority.json` | Nobody may update `main` (the `update` rule). | Repository admin role, **pull request only**. That is Eric, merging a pull request. |
| `main-merge-requirements.json` | Every change to `main` comes through a pull request. Only merge commits are allowed. The head must be up to date with `main` (strict). `test`, `agent-guard`, `agent-verify` and `agent-review` must pass, each from GitHub Actions (app 15368). No force push and no deletion. Zero approvals required. | None, not even Eric. |
| `agent-ledger.json` | The paid-attempt ledger branch can be appended to, but never rewritten or deleted. | None |
| `automation-branches.json` | No identity other than the admin role may create, update or delete any branch outside `agent/**`, `agent-ledger`, `visual-proof`, `claude/admission-*`, `claude/backlog-*` and `claude/claims/**`. | Repository admin role, always |

Why approval is not the boundary: an automation token can approve a pull
request whenever Actions is allowed to approve, and Eric can merge an
automation-opened pull request without approving it. The probe showed both.
Only the `update` rule's bypass separates merge authority, and only Eric holds
it.

Conditions:

- **Public, or private on GitHub Pro.** On GitHub Free a private repository
  gets HTTP 403 "Upgrade to GitHub Pro or make this repository public" from
  the rulesets API, and the rulesets are not enforced. Eric moved `kuaya1` to
  GitHub Pro on 2026-10-27, and the repository goes private
  (`audits/2026-10-27-agent-lane-redteam` §6). `merge-boundary-check.js`
  passes a private repository only when GitHub answers its rulesets read
  with HTTP 200 and reports the rules applied to `main`. A lapse to Free
  makes the check fail again.
- **Eric stays the only admin.** Any other admin, or any token holding Eric's
  admin access, can merge. That includes local agent sessions using his `gh`
  login.
- **The builder App never gets the Administration or Workflows permission.**
  Workflows matters because, without it, the App cannot push changes to
  `.github/workflows/`.

## Who pushes what (GitHub's activity log, 2026-10-27)

`gh api repos/kuaya1/CryptoResearch/activity` names the actor of every ref
update:

| Refs | Actor | Credential |
|---|---|---|
| `agent/issue-<n>` (the agent lane's candidates) | `kuaya1-cr-builder[bot]` | the builder App's installation token, minted from `BUILDER_APP_KEY` in `agent-build.yml` publish |
| `agent-ledger` | `github-actions[bot]` | the workflow token of `agent-build.yml` reserve and record, and `agent-review.yml` |
| `claude/claims/item-<n>`, `claude/backlog-*` (the backlog builders, cloud routines A and B) | `kuaya1` (User) | Eric's own account, through the routines' GitHub connection |

The agent lane pushes candidates only with the App token (pinned by
`dashboard/tests/agent-workflows.test.js`). The backlog builders do not: every
claim and branch push since the first claim (2026-10-27 03:59 UTC) is Eric's
account, which holds the admin bypass of every ruleset here, `main` included.
In that lane "only Eric merges" rests on the routines' instructions, not on
access. The `claude/backlog-*` and `claude/claims/**` excludes let a non-admin
identity do the same pushes; moving the routines onto one (or retiring them
for the issue queue) is Eric's change, outside this repository.

## Evidence (probe repository, 2026-10-26)

`kuaya1/cr-merge-boundary-probe` (public, FICTIONAL content) had these same
files applied, unchanged. Results:

- **Eric pushes directly to `main`:** refused. GH013: "Cannot update this protected ref", "Changes must be made through a pull request", "4 of 4 required status checks are expected".
- **Automation (GITHUB_TOKEN, contents and pull requests write) pushes to `main`:** refused (same GH013). The contents API on `main` was also refused (409).
- **Automation pushes a branch that changes `.github/workflows/`:** refused: "refusing to allow a GitHub App to create or update workflow … without `workflows` permission".
- **Automation pushes a non-`agent/` branch:** refused: "Cannot create ref due to creations being restricted".
- **Automation pushes `agent/change-…` and opens PR #1:** allowed. GitHub held the pull request's `test` and `agent-checks` runs as `action_required` until Eric approved them. The push started no run.
- **Automation approves its own PR:** refused: "Can not approve your own pull request".
- **Automation merges PR #1 with all four checks green and Eric's approval:** refused through `gh pr merge` ("the base branch policy prohibits the merge") and through the REST merge ("Cannot update this protected ref"). Squash and rebase were refused too ("not allowed").
- **Eric merges PR #1 through the REST merge:** merged (`ebd3f07`).
- **Eric merges PR #2 before its checks report:** refused: "4 of 4 required status checks have not succeeded: 1 expected". The requirements bind Eric.
- **Eric merges PR #2 once `agent-review` is `neutral` and the rest pass:** merged. Neutral satisfies a required check.
- **Eric merges automation PR #4 without approving it:** merged.
- **Automation fast-forwards `agent-ledger`:** allowed, twice.
- **Automation force-pushes or deletes `agent-ledger`:** refused: "Cannot force-push to this branch", "Cannot delete this branch".

**Still to probe:** the same attempts with the builder App's installation
token (`automation-app.yml` there) and whether an App-opened pull request runs
its checks without approval. This waits for the App; see cutover step 3.

## Apply (Eric)

```powershell
gh api -X PUT repos/kuaya1/CryptoResearch/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true
gh api -X POST repos/kuaya1/CryptoResearch/rulesets --input .github/rulesets/agent-ledger.json
gh api -X POST repos/kuaya1/CryptoResearch/rulesets --input .github/rulesets/automation-branches.json
gh api -X POST repos/kuaya1/CryptoResearch/rulesets --input .github/rulesets/main-merge-requirements.json
gh api -X POST repos/kuaya1/CryptoResearch/rulesets --input .github/rulesets/main-merge-authority.json
node dashboard/scripts/merge-boundary-check.js
```

Apply `main-merge-requirements.json` only once `agent-checks.yml` and
`agent-review.yml` are on `main`. Before that, no pull request could satisfy
its four checks. Every workflow already declares its own token permissions,
so the read default changes none of them.

`can_approve_pull_request_reviews` stays `true` for now. It is GitHub's one
setting for "Allow GitHub Actions to create and approve pull requests", and
`backlog-pr` and `engineering-admission` still open their pull requests
with the workflow token (the issue queue, `backlog-queue`, opens none). Approval is not the boundary here
(zero approvals are required, and the `update` rule stops every merge but
Eric's). Set it to `false` once the old lane is retired and no workflow
opens a pull request with the workflow token.

## Roll back (Eric)

```powershell
gh api repos/kuaya1/CryptoResearch/rulesets --jq '.[] | [.id, .name] | @tsv'
gh api -X PUT repos/kuaya1/CryptoResearch/rulesets/<id> -f enforcement=disabled
```

Disabling keeps the ruleset for re-enabling (`-f enforcement=active`).
Deleting it is `gh api -X DELETE repos/kuaya1/CryptoResearch/rulesets/<id>`.
The workflow token's default goes back with
`gh api -X PUT repos/kuaya1/CryptoResearch/actions/permissions/workflow -f default_workflow_permissions=write -F can_approve_pull_request_reviews=true`
(the setting as it was on 2026-10-26).
