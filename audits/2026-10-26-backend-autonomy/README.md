# Engineering lane: backend delegation and the unattended review (2026-10-26)

Eric's direction (2026-10-26) was to move the engineering lane from supervised manual authorization to unattended autonomy. Two things had to stay intact: Rule N4 (independent gatekeeping) and the sovereign merge boundary.

## 1. What stopped the lane

- **Backend changes waited for Eric's passphrase.**
  - The only delegations were `eng-app@4` (UI) and `eng-docs@1` (documents).
  - Any change to `dashboard/server.js` or `dashboard/core/**` stopped at `awaiting_authorization`.
- **Every candidate waited for a hand-carried ChatGPT review.**
  - A candidate stopped at `review_pending`, "waiting for a chatgpt review".
  - ChatGPT reviewed only in a conversation Eric opened.

The target was this: the desk submits, admits, builds, tests, reviews and opens pull requests, for both frontend and backend work. Only the final merge on GitHub and the production deploy stay with Eric.

## 2. What changed

| Area | Change | Files |
|---|---|---|
| Template `eng-backend@1` | Its title is "Backend endpoints, core logic, data stores and integration tests for one goal". **Rules:** implement only, one goal, ChatGPT review, release by Eric (`owner`), at most 20 files, 3 open tasks and 5 admissions a day. **Allowed:** `dashboard/server.js`, `dashboard/core/**` and `dashboard/tests/**`. **`forbidden_paths`:** `dashboard/engineering/**`, `dashboard/frontdoor.js`, `.github/workflows/**`, the root `server.js`, `dashboard/hosted.js`, `oauth.js`, `mcp.js`, `mcp-wire.js`, and the ledger and wallets (`core/portfolio.js`, `wallets.js`, `walletsync.js`, `alchemy.js`). The forbidden paths are refused at match, at the candidate and in the delegation record. **`requires_tests`:** every task names a `dashboard/tests/**/*.test.js` file, and every candidate adds or changes one (a deleted test does not count). Published templates are unchanged. | `engineering/policy.js` |
| Core lifted for it alone | `DELEGATION_RESTRICTED`'s `dashboard/core/` rule gains `lifted: { 'eng-backend@1': … }`. Its `PROTECTED` files stay out of every delegation's reach: the ledger, the wallets and the core files the gate is computed with. The guard tests stay restricted for every template. | `scripts/backlog-promote.js` |
| Server lines at the candidate | A `dashboard/server.js` line that mounts the engineering routes or the front door (`PROTECTED_LINES`) is now refused when the candidate is recorded. Before, it was refused only at promotion. | `engineering/inbox.js`, `engineering/policy.js` |
| Delegation record | `activatePolicy` copies the template's `forbidden_paths` and `requires_tests` into the delegation. `fits` and the candidate check read the union of the record's rules and the template's, so no record can lower them. | `engineering/inbox.js`, `engineering/policy.js` |
| Rule N4 for builders | Each candidate records `recorded_by`, the connection that built it. Each review records `same_builder`. **Never decides:** a review by a builder of the task, and an unattended review where a builder is the reviewer's own kind of assistant. | `engineering/inbox.js` |
| The reviewer's identity | `candidate-review@1` (`REVIEWER_SERVICE`, connection key `svc-…`) is its own identity, never an OAuth grant. It may do two things only: read a candidate's packet and save one review of it. | `engineering/inbox.js` |
| Packet and save | `reviewerPacket(head)` returns the goal, the candidate the desk recorded, the builders, the worker's test evidence, the delegation's rules, and `reviewable` with reason codes. `saveAutomatedReview` saves a review only when all of these hold: the exact head, merge base and diff SHA-256 the desk recorded; the desk's own read of GitHub's check runs on that head, with every run done, none failed and `test` passed; `review_pending`; an authorization that holds; no pause; not a restored copy; no builder of the reviewer's kind; no earlier unattended review of that head; and fewer than 10 unattended reviews that UTC day. A refusal is `REVIEW_REFUSED` with the codes, `DIFF_MISMATCH`, `MERGE_BASE_MISMATCH` or `WRONG_CANDIDATE`, and nothing is written. The desk records its check-run read as the verification's `ci`. | `engineering/inbox.js` |
| Sovereign merge boundary | A pass only moves the task to `ready_for_promotion`. When the deciding review is unattended, the attestation adds `owner_merges_unattended_review`, so backlog-pr never promotes it. The next action says Eric merges the candidate's pull request himself. The existing 20 s and 30-minute sweep records the merge from GitHub's proof. | `engineering/inbox.js`, `scripts/backlog-promote.js` |
| Token route | `POST /engineering/reviewer/packet` and `/engineering/reviewer/reviews`. It is off (404) until `CR_ENG_REVIEWER_TOKEN` of 32 characters or more is set. The bearer is compared in constant time. Bodies are capped at 64 KB. The desk reads GitHub's check runs itself for both calls. Nothing about CI comes from the workflow. The token is never logged, stored or shown. The front door dispatches it after the public reads and before sign-in, from its protected file. | `engineering/routes.js`, `frontdoor.js` |
| The reviewer | `reviewer.js` runs from main's checkout and reads the candidate as data only. In order: (1) the branch tip is the head; (2) the packet; (3) Git's merge base, diff SHA-256 and file list equal the desk's; (4) no author, committer or trailer names OpenAI, ChatGPT, Codex or GPT; (5) under `requires_tests`, a changed test `require`s a changed server or core module; (6) the diff is at most 200,000 characters; (7) the OpenAI call, with JSON output, at most 16,000 completion tokens and the model from `OPENAI_REVIEW_MODEL` (no default); (8) the save; (9) the pull request is opened for a pass when none is open, then commented. A pass carrying a high or medium finding is read as changes required. The comment carries the result, counts and paths. The findings' words stay on the desk. No packet, prompt or answer is logged. | `engineering/reviewer.js` |
| Workflow | `candidate-review.yml` triggers on `workflow_run` of `test` (a passing run for a push or pull request on `claude/candidate-eng-*` in this repository; the desk waits until every check run on the head is done, so the last one reviews), and on `pull_request_target` (opened, reopened, synchronize, ready for review) from such a branch. It is off until `vars.CANDIDATE_REVIEW_ENABLED == 'true'`. It sets `permissions: {}`, and the job has only `contents: read` and `pull-requests: write`. It checks out main with no stored credentials and never runs branch code. Concurrency is one run per branch, never cancelled. | `.github/workflows/candidate-review.yml` |

## 3. The conflicts, said once

- **Ledger and wallet code.**
  - `portfolio.js`, `wallets.js`, `walletsync.js` and `alchemy.js` are `PROTECTED` and also forbidden by name. So are root `server.js`, `oauth.js`, `mcp.js` and `hosted.js`.
  - A backend task that needs one of them waits for Eric's own authorization, and its pull request waits for his merge.
- **`data/**`.**
  - Left out: the folder does not exist, and the allowlist `.gitignore` never commits records.
  - "Data stores" means the core modules that write them (`dashboard/core/**`). Records change only through the desk's own operations.
- **Secrets and outside services.**
  - Eric enters every key himself, on GitHub and on Render; none was asked for in chat, and none is in this branch.
  - Sending a candidate's diff, the task goal and the test evidence to OpenAI is outward-facing and costs money, so it stays off until Eric turns it on.
  - The repository is public, so the diff itself is already public. The goal's title, outcome, acceptance and scope are in `DESK_STATE.md`. The original instruction is never sent.
- **The workflow file is a protected path**, and so are `dashboard/engineering/` and `frontdoor.js`. This pull request waits for Eric's merge; nothing in it merges itself.

## 4. What Eric does, in order

1. **Read and merge** this pull request on GitHub. Render deploys main.
2. **On Render**, set `CR_ENG_REVIEWER_TOKEN` to a long random value, 32 characters or more.
   - Optional: set `CR_GITHUB_TOKEN`, a read-only token. Without it, the desk's GitHub reads share the anonymous limit of 60 an hour.
3. **On GitHub**, under the repository's Settings > Secrets and variables > Actions:
   - Secrets:
     - `CR_ENG_REVIEWER_TOKEN`, with the same value as on Render;
     - `OPENAI_API_KEY`, a project key with a spending limit set at OpenAI.
   - Variables:
     - `OPENAI_REVIEW_MODEL`, the model he chooses;
     - `CANDIDATE_REVIEW_ENABLED` set to `true`;
     - optionally `DESK_URL`.
   - Settings > Actions > General: "Allow GitHub Actions to create and approve pull requests" must stay on, as backlog-pr already needs it. The reviewer only opens pull requests; it never approves one.
4. **On the desk**, in Preferences > Developer > Engineering, activate `eng-backend@1` with a goal and his passphrase. This is the one passphrase entry; tasks under it are then admitted without one.
5. **Each pass**: he merges the candidate's pull request on GitHub. The desk settles the task as merged by itself.

## 5. What it does not do, and the limits

- **Merging.** It never merges, approves on GitHub, pushes or deploys. `main` still has no branch protection or ruleset, so the boundary is the lane's own code and Eric's habit; GitHub does not enforce it. Turning on branch protection is his call.
- **Rule N4 is checked against the builder, not the submitter.** A task ChatGPT submitted through the connector can be reviewed by ChatGPT through the API. These are different identities, and the submitter's connection still never decides (`same_author`), as before.
- **When nothing is saved.** If the changed test does not require a changed module, the diff is too large, or the branch does not match the desk, no model is asked and nothing is saved. The task stays `review_pending`. The job fails with the reason and a person decides: a correction request, or a review in a conversation.
- **One unattended review per head.** A rebuild is a new head and gets a new review. `insufficient_evidence` decides nothing and leaves the task for a conversation review.
- **The desk must answer.** Render must be up when the workflow runs. Desk reads retry after 2, 4 and 8 s; a failure fails the job, and a re-run asks again.
- **Cost bounds.** At most one call per head, ten a day, 200,000 diff characters and 16,000 completion tokens a call. The price depends on the model Eric picks.

## 6. Tests

- **New:** `dashboard/tests/engineering-backend.test.js`, with 14 tests. They cover:
  - the template's shape;
  - what it permits;
  - what it rejects, including Windows spellings, reaching globs, the gate's core files, the guard tests and the browser app;
  - admission under an active `eng-backend@1` delegation with no passphrase;
  - the candidate invariants (a test required, a deleted test refused, mount lines refused);
  - the packet and its CI reasons;
  - a pass, which becomes ready, is never promotable, and is reviewed once per head;
  - the exact-candidate refusals;
  - self-review refused under Rule N4;
  - `changes_required` sending the task back to the builder;
  - the token route (off, 401, 405, 400, 409, 413, never public);
  - `reviewer.js` end to end: a temporary Git repository with a bare origin, the real desk route on this PC and a stand-in for the OpenAI API, ending in one paid call;
  - the refusals that ask no model (diff mismatch, a ChatGPT co-author, a ChatGPT-built task, a test that misses the change, missing secrets).
- **Updated** to the new template set and lift:
  - `engineering-inbox.test.js`;
  - `engineering-connector.test.js`;
  - `engineering-guard.test.js`, which also checks every forbidden path and that the reviewer route is off without its token;
  - `backlog-promote.test.js`.
