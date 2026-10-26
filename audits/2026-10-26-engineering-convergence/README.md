# Engineering lane: convergence with GitHub, a sealed verify, git deadlines (2026-10-26)

Eric's direction (2026-10-26), after the Cortex audit of the engineering loop (81/100; its weakest link was convergence between the inbox and GitHub):

1. Find an item's pull request on both `claude/backlog-eng-<n>` and `claude/candidate-eng-<n>`, so merged items move from `ready_for_promotion` to `merged` automatically.
2. Make the worker's `verify` refuse a dirty worktree (`dirty_worktree_detected`) and bind its receipt to the clean head.
3. Put a hard deadline on every remote git call, so a hung socket fails fast into the retry backoff.
4. Leave retired delegation templates out of the active capabilities.

## 1. What the audit found

- **Items 63 and 64 never left `ready_for_promotion`.**
  - Eric merged them from `claude/candidate-eng-63` and `claude/candidate-eng-64`, as PRs #24 and #23.
  - The desk's readback looked only for `claude/backlog-eng-<n>`, so it saw no pull request.
  - The worker's `merged` event needs a recorded release, so nothing ever settled them.
- **A dirty worktree could be verified.** `verify` ran the tests on whatever was on disk and then read `HEAD`. Uncommitted edits were attributed to the committed head.
- **A git call could hang forever.** Nothing put a deadline on the worker's `fetch`, `ls-remote` or `push`.
- **Retired templates were offered as active.** The live capabilities listed only an `eng-app@2` delegation. That template was retired the same morning and matches nothing.

## 2. What changed

| Area | Change | Files |
|---|---|---|
| Both branches | `pullRequests(n)` asks GitHub about both branches. Merged pull requests come first, then the newest. If one branch could not be read, the answer is partial. `pullRequest` and `engineering_github_status` name the branch and any other pull requests. | `engineering/github.js`, `engineering/tools.js` |
| Proof of a merge | `mergeProof({ number, heads })` holds only when all three are true: a merged pull request from one of the item's branches; its head is a head the desk recorded (the candidate, or the release pushed from it); and main holds that head (GitHub's compare). Neither a branch name alone nor a squash merge is proof. The merge commit is kept only when main holds it too. | `engineering/github.js` |
| Automatic settle | `reconcileMerged` records the merge under the task's lock. It refuses: a proof for another number (`WRONG_CANDIDATE`); another head (`WRONG_CANDIDATE`); a task not ready for promotion (`WRONG_STATE`); anything short of proof (`NOT_ON_MAIN`). When it records, it writes `merge` (PR, branch, head, main commit, `by: 'desk GitHub readback'`, `released_through_promotion`), clears the lease and appends a `reconciled_merged` event by `{ kind: 'desk' }`. It records a fact, not an approval: reviews and attestations stay as they were. A second identical proof answers `unchanged`. | `engineering/inbox.js` |
| The sweep | `reconcileMerges` asks GitHub only about tasks ready for promotion with a backlog number and a recorded head, one sweep at a time. On the online desk it runs 20 s after the start and every 30 minutes (`scheduleSweeps`, started by the front door, stopped when the server closes). On this PC there is no GitHub reader and nothing runs. `server.js` is unchanged. | `engineering/routes.js`, `frontdoor.js` |
| Sealed verify | `verify` checks `git status --porcelain` before anything runs. Any changed or untracked file outside `dashboard/public/app/` stops it with `dirty_worktree_detected` and the list of files, before anything is built or tested. The bundle's own files belong to the bundle step: stale or uncommitted, they stop it with `commit_bundle_first`. The receipt names the head and its tree (`tree_sha`, `worktree: 'clean'`), both read before the tests. If `HEAD` moved during the run, the result is `head_moved`. If the tests left changed or untracked files, it is `worktree_changed`. Either way `ok` is false. | `scripts/engineering-worker.js` |
| Git deadlines | Every remote call (`fetch`, `ls-remote`, `push`) has a 30 s deadline (`CR_ENG_GIT_TIMEOUT_MS` for tests), in two layers. First, git itself stops a transfer that has moved under one byte a second for half the deadline (`http.lowSpeedLimit`, `http.lowSpeedTime`); git exits cleanly with its helpers. Second, the process is stopped at the deadline whatever it waits on. On Windows that stop reaches only git's launcher (`Git\cmd\git.exe`) and leaves `git remote-http` running, so the first layer is the one that leaves nothing behind. Both messages count as passing failures and go through the existing 1 s, 2 s and 4 s backoff. A push is still read back before it is tried again. | `scripts/engineering-worker.js` |
| Retired templates | `P.actionable(policy)` is false for a delegation activated from a retired template. Capabilities list only actionable delegations under `delegations`. A retired one in force appears under `retired_delegations` with why it admits nothing. Eric's page marks it `active: false` with `retired`. Matching still explains why a retired delegation fits nothing. No `eng-app@4` delegation is active until Eric activates one. | `engineering/policy.js`, `engineering/inbox.js` |

## 3. After merge and deploy

- **Items 63 and 64.** About 20 s after the deploy starts, the sweep should record both as merged:
  - item 63: PR #24, head `5ac6c637eb0c`, which main holds;
  - item 64: PR #23, head `dc9cfffa607d`, which main holds.
  - Check with `engineering_get_task`: `status: merged`, `merge.by: desk GitHub readback`, `merge.branch: claude/candidate-eng-<n>`.
- **Item 65.** It was cancelled on the desk, so the sweep leaves it alone.
- **Capabilities.** They list no delegation until Eric activates a current template (`eng-docs@1`, `eng-app@3` or `eng-app@4`). The `eng-app@2` delegation appears only under `retired_delegations`.

## 4. Tests

- **`engineering-flow.test.js`.**
  - `mergeProof` covers:
    - both branches are asked;
    - a merged candidate-branch PR beside an open backlog-branch one;
    - another head, a squash merge, and a merge commit main does not hold;
    - one branch unreadable (unknown, unless the other proves it);
    - none at all, and no recorded head (GitHub not asked).
  - The sealed verify covers:
    - an untracked or changed file stops it before any build;
    - a stale bundle beside other dirt is not rebuilt;
    - uncommitted bundle files are asked for again;
    - tests that leave a file give `worktree_changed`, and tests that commit give `head_moved`;
    - a clean run names its head and tree.
  - A silent HTTP remote: three tries, each stopped by git itself, then the push with its read-back. No git process is left running.
- **`engineering-inbox.test.js`.**
  - The sweep records item 63 from a candidate-branch proof and leaves an unknown one as it was, writing nothing for it. It does not ask again about a merged task.
  - Refusals: another number, another head, no proof, a task not ready. A replay answers `unchanged`. Without GitHub, nothing is asked.
  - The schedule runs and stops when the server closes.
  - Retired delegations are left out of capabilities and of Eric's active list.
