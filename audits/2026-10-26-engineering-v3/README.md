# Engineering desk: Version 3 migration (2026-10-26)

**Source.** "Version 3" is Eric's artifact *Engineering Desk: Corrected Plan v3*
(rev 12). The PDF attached to the request is the superseded *Assessment &
Blueprint* that the corrected plan calls v2; where they differ, the corrected
plan is followed. "Version 1" is the agent lane as it stands on `main` at
`b187d30` (PRs #33, #34, #35; `audits/2026-10-26-engineering-simplification`).

**Bottom line of v3.** Keep main's lane and add five things: the builder
sandbox, the live-issue recheck, the predecessor lease, `/revise` through the
ledger, and ChatGPT's prefilled issue link. Six small pull requests, each
Eric's own change, merged by him: 1 before any paid build, 2 and 3 before the
pilot, 4 before 5, 6 whenever convenient.

## Live state read on 2026-10-26 (read-only)

- `kuaya1/CryptoResearch` is **public**; `allow_auto_merge` false.
- **0 rulesets** applied (the four files in `.github/rulesets/` are only
  files); `merge-boundary-check.js` therefore exits 1.
- Workflow token: `default_workflow_permissions: write`,
  `can_approve_pull_request_reviews: true`.
- Variables: `AGENT_REVIEW_ENABLED=false`, `CANDIDATE_REVIEW_ENABLED=false`,
  `BUILDER_APP_ID`, `BUILDER_APP_SLUG`, `OPENAI_REVIEW_MODEL`, `DESK_URL`.
- Secrets (names only): `ANTHROPIC_API_KEY`, `BUILDER_APP_KEY`,
  `OPENAI_API_KEY`, `CR_ENG_REVIEWER_TOKEN`. **`AGENT_LEDGER_KEY` is not set.**
- No `agent:build` label exists, so `agent-build.yml` (active) cannot start.
  No `agent-ledger` branch exists, so the ledger is empty: nothing to migrate
  when the MAC key changes.
- No open pull requests. No `cache:` in any workflow.

## Migration map

Classes: **done** (already implemented on main), **config** (owner
configuration only), **code** (a code change in the PR named), **retire**,
**open** (unresolved).

| Version 3 requirement | Current implementation | Required change | Verification |
|---|---|---|---|
| C1. Only Eric merges; approval and merge authority stay distinct | Ruleset files `main-merge-authority` (admin bypass, pull request only) and `main-merge-requirements` (no bypass); not applied | **config**: Eric applies the rulesets (owner step 7), later sets `can_approve_pull_request_reviews` false (step 13). No App exemption. | `merge-boundary-check.js` exits 0 (exits 1 today) |
| C1. Repository stays public (rulesets on GitHub Free) | Public | **done** | `gh api repos/kuaya1/CryptoResearch --jq .visibility` |
| C2. The ledger is the mechanism, not round counting | `agent-ledger.js`: hash chain, compare-and-swap, reservations before every paid call | **done**; extended by PRs 3, 4, 5 | `agent-ledger.test.js` |
| C3. Revert check instead of the import check | `agent-verify.js` revert check (step 5) on the merge tree | **done** for the agent lane. `reviewer.js` `testCoverage` still serves the old lane | `agent-verify.test.js` |
| C3. Import check retired | Used only by the old lane (`candidate-review`, off) | **retire** with the old lane after both pilots (owner step 13) | old lane's workflows disabled |
| Builder runs sandboxed: no network but npm, no `ANTHROPIC_API_KEY` for commands, no reads outside the checkout, no hooks | Claude Code 2.1.304 with `--allowedTools`, no sandbox; `Bash(node:*)` can read the key and reach any host | **code, PR 1**: `.github/agent/claude-settings.json` (v3's settings, plus `autoAllowBashIfSandboxed: false` so the v1 command list still decides, and `.git/**` edits denied); copied to `RUNNER_TEMP`; `--settings … --setting-sources user`; file tools allowed only inside the checkout (`Edit(./**)`, `Write(./**)`) | `agent-workflows.test.js`; `agent-sandbox-probe.yml`, Eric's own run (owner step 6, at most $0.50) |
| Build job checks user namespaces (runner-images#10443) | None | **code, PR 1**: install bubblewrap and socat, lift `kernel.apparmor_restrict_unprivileged_userns` when it is 1, `bwrap` smoke test before any paid call | workflow test; first live run |
| The post-build steps never run what the builder wrote | `git add -A` in the builder's own `.git` (an `fsmonitor` or hook there would run outside the sandbox) | **code, PR 1** (addition, same intent): a copy of `.git` made before Claude starts computes the patch; hooks and fsmonitor off | workflow test |
| Patch and `result.json` scanned for key-shaped strings before upload and before publish | None | **code, PR 1**: `agent-secrets.js` (standalone, copied to `RUNNER_TEMP` before Claude starts) scans `out/` before upload and removes a file that holds one; `apply` refuses a patch or report that holds one, naming file and line, never the value | `agent-secrets.test.js`, `agent-guard.test.js` |
| No `cache:` in any workflow | None present | **done**; PR 1 adds a test that keeps it so | `agent-workflows.test.js` |
| Dedicated Console workspace and spend limit for the build key | `ANTHROPIC_API_KEY` exists; workspace unknown | **config** (owner step 3) | Console |
| Reserve rechecks the live issue (open, labeled, body unchanged) | Payload only (`agent-guard.js` reserve) | **code, PR 2**: reserve fetches the issue (`issues: read`) | `agent-guard.test.js` |
| "2 builds per version" counts per task version | Counted per (version, main's commit): a new main reset it | **code, PR 2**: counted per issue and task hash | `agent-ledger.test.js` |
| Publish leases on the head recorded at reserve | `ls-remote` read and used in the same breath | **code, PR 3**: reserve records the branch head or `absent`; publish reads it from the ledger and leases on it | bare-remote tests |
| One open build per issue; a lost runner holds it 65 minutes, then `lost` | Concurrency group only | **code, PR 3**: `decideBuild` refuses while the issue has an attempt with no outcome younger than timeout + 20 min; an older one is recorded `lost` | `agent-ledger.test.js` |
| A rejected lease is recorded `stale` and commented, never retried | Fails the job | **code, PR 3** | bare-remote tests |
| Separate `AGENT_LEDGER_KEY` for verdict MACs, never in the build job; fail closed | MAC key derived from `OPENAI_API_KEY` | **code, PR 4**; **config**: Eric creates the secret (step 4) | `agent-review.test.js`, workflow test |
| `/revise` with authenticated feedback, `revisions_per_task_version: 2` in `cr-agent-policy@2` | None | **code, PR 5** | `agent-revise.test.js` |
| ChatGPT's `engineering_prepare_task` returns an Agent-task issue body, its problems and a prefilled link | Saves a desk draft only | **code, PR 6** | `agent-issue.test.js` |
| Builder App: Contents and Pull requests read/write, Metadata read; never Administration or Workflows | App exists (`BUILDER_APP_ID`, `BUILDER_APP_KEY` set) | **config**: permissions not readable without the App's key; Eric confirms (step 4) and runs the App probe (step 5) | probe repository |
| Outside contributors need approval to run workflows | Unknown | **config** (step 8) | repository settings |
| `agent:build` label | Absent | **config** (step 9), only after PRs 1 to 4 are merged | label list |
| Paid review switch | `AGENT_REVIEW_ENABLED=false` | **config** (step 10, after preflight) | variable |
| Retired with no counterpart: `scope-hook.js`, `agent:pr-open`, comment-counted rounds | Not on main | **done** (nothing to remove) | `git ls-files` |
| Retire the old lane (backlog-intake, backlog-pr, candidate-review, engineering-admission) | Active workflows, paid switches off | **retire** after both pilots (step 13), by Eric | workflows disabled |

## Conflicts with owner-approved boundaries

None found. Every v3 change narrows what a builder or a token can do. Three
details go beyond v3's text in the same direction, named here so they are
not mistaken for v3:

1. `autoAllowBashIfSandboxed: false`. With the sandbox on, Claude Code would
   otherwise run any sandboxed Bash command without asking, which is wider
   than v1's `Bash(node:*)`, `git diff`, `git status`.
2. Edits under `.git/` denied, and the patch made from a copy of `.git` taken
   before Claude starts: the builder can write its working tree, and the next
   step ran `git` in it.
3. Builds counted per task version, not per task version and main's commit.
4. The builder's file tools are allowed only inside the checkout
   (`Edit(./**)`, `Write(./**)` instead of bare `Edit`, `Write`), so it cannot
   change the guard's copies in the runner's temp directory.
5. `agent-sandbox-probe.yml`: v3 names the live probe (owner step 6) but no
   mechanism. It is dispatch-only, Eric's own run from `main`, under the
   build's exact settings plus a canary only that run knows, at most $0.50,
   and writes and uploads nothing.

## Order and stacking

PRs 1 to 5 touch the same files (`agent-build.yml`, `agent-guard.js`,
`agent-ledger.js` and their tests), so each is stacked on the one before and
opened against `main`; merging them in order leaves each diff as its own.
PR 6 is independent. Every one touches protected paths, so Eric merges each
himself.
