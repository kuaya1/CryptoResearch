# Engineering simplification: merge authority, paid attempts, real tests

Eric, 2026-10-26. This implements the "Engineering Desk Simplification:
Assessment & Blueprint" (the PDF), with the three mandatory corrections from
GPT's audit of `main` at `5fa19efec7dc23d2819f4c0fc8ce59f5272f729d`.

`main` and the online desk were both still at `5fa19ef` when this was
written (`/healthz`: `revision 5fa19efec7dc23d2819f4c0fc8ce59f5272f729d (main)`).

Nothing here is merged, configured or deployed. Every merge, secret, ruleset,
paid workflow and cutover step is Eric's.

## Where each piece stands

| Piece | Implemented | Tested | Configured | Deployed | Observed working |
|---|---|---|---|---|---|
| Rulesets: only Eric updates `main` (PR A) | yes | on a probe repository, with these exact files | **no**: production has 0 rulesets | n/a | on the probe only |
| No workflow writes `main` (PR A) | yes | suite | n/a | no | no |
| Paid-attempt ledger and reviewer (PR B) | yes | fake OpenAI and GitHub APIs | **no** (no `AGENT_REVIEW_ENABLED`) | no | no |
| Behavioral verification, `agent-verify` (PR B) | yes | local fixtures | n/a | no | never run on a GitHub runner |
| Ephemeral build and App publish (PR B) | yes | workflow text tests only | **no** (no App, no Anthropic key) | no | no |
| Item 66 settled; old reviewer sends once (PR C) | yes | suite | n/a | no | no |

A green suite does not show that the unattended pipeline works. It has never
run end to end. The pilot in step 12 below is the first time it would.

## The three pull requests

| PR | Branch | Commits | What it does |
|---|---|---|---|
| A | `claude/eng-merge-boundary` | `2bc140cf4082cbdb5015b8c28a772b2e4d334720`, `e74deda2feba1b1c23a14767a1f2e71a4976ccd8` | The four rulesets as files, with apply and rollback steps (`.github/rulesets/`). `backlog-pr.yml` keeps testing but never merges. `engineering-admission.yml` opens a PR instead of pushing to `main`. Adds `merge-boundary-check.js`. |
| B | `claude/eng-agent-lane` (stacked on A) | `190b0f0…` and this document | The agent lane: issue form, `agent-build.yml`, `agent-checks.yml`, `agent-review.yml`, `agent-ledger.js`, `agent-guard.js`, `agent-review.js`, `agent-verify.js`, `.github/agent-policy.json`, Claude Code pinned by lockfile. |
| C | `claude/eng-transition` (from `main`) | `8d1d9191c73f543d41a9f863383a5dfbccec22a8` | Settles a task merged while its review was pending (item 66, PR #29). Stops the old reviewer from retrying a paid call. Independent of A and B. |

## Agreement with the PDF

The PDF's main structure is right. I followed it:

- an untrusted build job;
- a trusted publish job that treats the build's output as data;
- a reviewer that runs only `main`'s code;
- GitHub as the source of the facts.

Its readings of the repository were also right:

- `engineering-daemon.js` does not exist; the worker is `dashboard/scripts/engineering-worker.js`;
- `dashboard/core/leases.js` must stay;
- Claude Code's deny rules are not a boundary.

Where this implementation differs, and why:

1. **The ruleset.** The PDF's single ruleset requires one code-owner approval
   and gives the admin a bypass. Approval cannot be the boundary:
   - Eric cannot approve his own PRs.
   - Once Eric approves an App PR, any token with contents write can merge it.

   GPT's correction 2 is right. The boundary is now the ruleset's `update`
   rule: only the admin role may update `main`, and only through a PR. A
   second ruleset, with no bypass, holds everyone to the required checks,
   Eric included. The probe showed:
   - automation cannot merge a green, Eric-approved PR;
   - Eric cannot merge before the checks report.
2. **Private repository.** The PDF lists going private as one of Eric's
   options. On GitHub Free, rulesets are enforced on public repositories only:
   the probe got HTTP 403 "Upgrade to GitHub Pro or make this repository
   public" on a private one. Going private removes the boundary unless the
   account moves to Pro.
3. **Checks and how they are posted.**
   - The PDF's `agent-guard` runs on `pull_request_target` and posts a commit
     status. Here `agent-guard` and the new `agent-verify` run on
     `pull_request`, with read-only tokens and `main`'s scripts.
     `agent-verify` has to run the candidate's tests, which must never happen
     under `pull_request_target`.
   - The workflow file a `pull_request` run uses is always `main`'s, for two
     reasons. The builder App has no Workflows permission, so GitHub refuses
     its pushes to `.github/workflows/` (probe). The guard also refuses any
     change under `.github/`.
   - All four checks are check runs bound to GitHub Actions (app 15368).
4. **Branch names.** The agent pushes `agent/issue-<n>`, not
   `claude/agent-<n>`. The `automation-branches` ruleset can then limit
   automation to `agent/**`. `claude/**` stays for Eric's own sessions.
5. **Paid attempts and test quality.** The PDF keeps `reviewer.js`'s daily
   cap and its import scan. Both are replaced, under corrections 3 and 4.
6. **Order of retirement.** The PDF deletes the inbox, worker, admission and
   OAuth resource in its second PR. The brief keeps the existing intake
   during the pilot, so nothing is deleted yet. `engineering-admission`
   now proposes its entry as a PR instead of pushing, so it can stay running.
7. **`backlog-pr`'s zero-click merge.** The PDF leaves this to Eric (retire
   it, or give it an App on the bypass list). Correction 2 settles it: no
   process gets a bypass. `backlog-pr` now opens and tests a PR and stops.

Eric's other PDF decision is the build credential. I agree with the PDF:
use a Console API key in its own workspace with a spending limit, not a
subscription token. Code the model writes in the build job can read it.

## Agreement with the corrections

All three are right. Each one found a real hole.

- **Merge authority.** The probe confirmed GPT's point that approval alone
  is not enough. See "Evidence".
- **Paid attempts.** The defect reproduced in the old code:
  - `reviewer.js` retried after an ambiguous failure;
  - its cap counted only saved reviews.

  PR C stops the retry now. PR B replaces the route with the ledger.
- **Real tests.** `testCoverage()` accepted a commented-out import. GPT's
  reproduction is the first case in `agent-verify.test.js`, and it now fails.

## Architecture

```
Eric opens an issue (Agent task form) and adds the label agent:build himself
  │  issues: labeled, Eric's identity; runs main's agent-build.yml
  ▼
reserve   main's guard: the label is Eric's own on this version of the issue,
          the task fits its template (.github/agent-policy.json); one paid
          build reserved in the ledger before anything is sent
build     fresh checkout of main, persist-credentials false, contents: read;
          Claude Code 2.1.304 (lockfile, sha512); holds only ANTHROPIC_API_KEY;
          its output is a diff and a result file, uploaded as an artifact
publish   main's guard applies the diff to main as data (scratch index),
          checks the tree against the task; the builder App's token pushes
          agent/issue-<n> and opens the PR
record    the build's outcome in the ledger
  │  pull_request (opened by the App, so its checks run)
  ▼
test          the full suite (test.yml)
agent-guard   main's guard reads the head as data: builder commits with the
              task's trailers, the task unchanged and still labeled, the change
              inside it. An owner change gets a neutral agent-review here.
agent-verify  main's verifier on the proposed merge tree, no write permission,
              no secret (see "Real tests")
  │  workflow_run (test, agent-checks completed)
  ▼
post-review   main's agent-review.js with OPENAI_API_KEY: required checks read
              from GitHub, one reserved request, the verdict saved in the
              ledger, then posted as the agent-review check on the head
  │
  ▼
Eric merges (the only identity the update rule lets through)
```

GitHub holds the queue (issues), the state (branches, PRs, checks) and the
record (merges). The ledger (`ledger.jsonl` on branch `agent-ledger`) holds
only what GitHub cannot: paid attempts and their outcomes.

Credentials per job:

| Job | Repository token | Secrets |
|---|---|---|
| reserve, record | contents write (ledger branch only, by ruleset) | none |
| build | contents read, not persisted | `ANTHROPIC_API_KEY` |
| publish | contents read; then the App token (contents and pull requests write) | `BUILDER_APP_KEY` |
| agent-guard | read, plus checks write for the owner-change neutral check | none |
| agent-verify | read | none; `runTests` also strips any TOKEN, KEY, SECRET or PASSWORD variable |
| post-review | contents write (ledger), checks write | `OPENAI_API_KEY` |

The actions are pinned by commit:

- `checkout` v7.0.1 `3d3c42e5…`
- `setup-node` v7.1.0 `949feb24…`
- `upload-artifact` v7.0.2 `cf430e03…`
- `download-artifact` v8.0.2 `90008278…`
- `create-github-app-token` v3.3.0 `64ab729a…`

Node is 24.21.0. Claude Code is 2.1.304, installed by `npm ci` from
`.github/agent/package-lock.json`. `agent-workflows.test.js` fails if any
of these lose their pin or a secret moves into the wrong job.

## Paid attempts (correction 3)

Each paid request goes through `agent-ledger.js` first.

**The ledger.** The file is append-only, and each line chains to the one
before it (`seq`, `prev`). A writer reads the ledger, decides, and pushes
without force. If someone else appended in between, the push is rejected,
and the writer reads again and decides again. A ruleset blocks any rewrite
or deletion of the branch.

**What a reservation is bound to:**

- the task version: the issue number and the SHA-256 of its body;
- the candidate head and the merge base;
- the SHA-256 of the diff;
- the review configuration: prompt version, model and limits.

A new head, a changed task or a new configuration is a new binding.

**Ceilings** (in `.github/agent-policy.json`):

| What | Limit |
|---|---|
| Review attempts per binding | 2 |
| Review attempts per UTC day | 12 |
| Review tokens per UTC day | 1,500,000 |
| Builds per task version | 2 |
| Builds per UTC day | 6 |
| Build spend per UTC day | $40 |
| One build (Claude's own `--max-budget-usd`) | $8 |

Failed and uncertain attempts count toward every ceiling.

**One send per reservation, no retry.** Each request carries
`store: true, metadata.cr_attempt=<reservation>`. Its outcome is recorded
as one of:

- `response`: a readable answer arrived;
- `failed`: a 4xx answer, 429 included (an answer, so nothing was billed);
- `unknown`: a throw, a timeout, a 408, 409 or 5xx, or a 200 with an
  unreadable body.

**Reconciling before anything is resent.** An `unknown` attempt, or a
reservation with no outcome because the runner was lost, is looked up
among OpenAI's stored completions (`metadata[cr_attempt]=<id>`, then the
completion by its ID):

- If it is found, that response is the attempt's response, and nothing is
  sent again.
- If it is not found and the attempt is younger than
  `unknown_grace_minutes` (20), nothing happens yet.
- If it is not found and the attempt is older, it is recorded `lost`, and
  one new attempt may follow, within the ceilings.

**A held verdict is reused.**

- The verdict is saved in the ledger with an HMAC keyed from the OpenAI key,
  and posted only after that save.
- If posting fails, a rerun or the 30-minute sweep posts the held verdict
  without asking the model again.
- If saving fails, the stored completion is found on the next pass.
- A forged verdict line fails the HMAC and is ignored.

**Concurrency and cancellation.** Two triggers for one head race on the
compare-and-swap, and one reserves. The other then sees an open attempt and
waits. A cancelled job leaves a reservation with no outcome, which is
handled like a lost runner.

**The off switch.** `AGENT_REVIEW_ENABLED` is read before reserving. When
off, nothing is reserved or sent. Reconciling and posting held verdicts
keep working.

**Provider limits stay as a second layer.** Set a budget on the OpenAI
project and a spending limit on the Anthropic workspace.

## Real tests (correction 4)

`agent-verify.js` runs on GitHub's proposed merge commit for the PR, in a
fresh checkout. The verifier and its rules come from the base commit. It
checks four things:

1. **Named tests.** These are the changed or added test files plus those
   the task names. Deleting a test file is refused.
2. **Lint.** Each named test file needs at least one assertion whose
   arguments are not all literals. Comments and strings are stripped
   first, so a commented-out `require` or `assert.ok(true)` counts for
   nothing.
3. **Run.** The named tests pass under `node --test`, with secrets,
   `NODE_OPTIONS` and `NODE_TEST_CONTEXT` removed from the environment.
4. **Coverage and revert.**
   - Every changed line of code in an implementation file must run under
     those tests (`NODE_V8_COVERAGE`).
   - Each implementation file is then put back as the base had it, and at
     least one named test must fail.

   A test may reach the code through the server or another module. It does
   not need to import the file directly, so real integration tests count.

Documentation-only changes (`eng-docs@1`) need no tests.

Protected tests stay out of the agent's reach:

- `agent-*.test.js` and the verifier itself are protected paths in
  `backlog-promote.js` and `policy.js`;
- the guard refuses an agent change to any protected path.

**Limit.** The verifier runs candidate code. That is evidence, not proof:
code written to detect the revert could still pass. The model review and
Eric's merge remain the judgment.

## Transition fixes (PR C) and the open tasks

- **Item 66.** PR #29 (`claude/candidate-eng-66`) merged at
  2026-10-26T18:59:14Z while its task was `review_pending`. The desk's sweep
  now settles a `review_pending` task from GitHub's proof as well. The merge
  record keeps:
  - `status_at_merge: "review_pending"`;
  - `review_at_merge`: required, state, satisfied.

  The status reason says the review was still pending. No review is added,
  and the review state is unchanged. This takes effect once PR C is merged
  and deployed, at the next 30-minute sweep.
- **The old reviewer.** It now sends one paid request per run. Its 503 and
  timeout cases are tested, and the test fails with the old retry.
  `CANDIDATE_REVIEW_ENABLED` is still `true` on the repository: switch it
  off now (step 1).
- **Task c35c5e (older scout ingestion).** PR #30 already did this work, and
  the task names protected files. Recommendation: Eric cancels it. Nothing
  here runs it.
- **Task ac36fa (reviewer status).** Its route matches the protected
  engineering-line rule. A constant `reviewer_configured: true` proves
  nothing. It is replaced by `agent-review.js preflight`, a dispatch with
  no charge that checks three things:
  - the key reads the model;
  - the key can list stored completions, which reconciliation needs;
  - the ledger reads.

  Recommendation: Eric cancels it.
- **Task 61f9bf.** Recommendation: file it again as an Agent task issue.
- **PR #32 (worker daemon).** Closed 2026-10-26T22:51:56Z. Nothing to do.

## Evidence

**Merge authority.** These are the probe results on
`kuaya1/cr-merge-boundary-probe`, which is public and has FICTIONAL content.
The same four ruleset files are applied there; IDs 25918051–25918056 are
active. The full list is in `.github/rulesets/README.md`. In short:

- Pushes to `main` were refused for both Eric and automation.
- Automation's pushes that touch a workflow, or go to a non-`agent/` branch,
  were refused.
- Automation could not approve its own PR.
- Automation could not merge a PR whose checks were green and which Eric had
  approved.
- Eric could not merge before the checks reported.
- Eric could merge with the checks passing, including a neutral
  `agent-review`.
- The ledger branch fast-forwards and cannot be force-pushed or deleted.

`node dashboard/scripts/merge-boundary-check.js --repo kuaya1/cr-merge-boundary-probe`:

```
Merge boundary holds on kuaya1/cr-merge-boundary-probe: only kuaya1 can update main, through a pull request with the required checks.
```

On production today (`node dashboard/scripts/merge-boundary-check.js`, exit 1):

```
Merge boundary does NOT hold on kuaya1/CryptoResearch:
- ruleset agent-ledger is not on the repository
  … (all four rulesets, the five rules on main)
- workflow tokens default to write; set Read repository contents
```

**Paid attempts.** `dashboard/tests/agent-review.test.js` and
`agent-ledger.test.js` use a fake OpenAI and a fake GitHub. A bare
repository stands in for GitHub's Git, with a fresh runner clone on each
run. The tests cover:

- a timeout after acceptance: one request, and the stored completion is
  found and used;
- a failed ledger save: the stored completion is recovered;
- a failed check post: the held verdict is posted without a new request;
- a lost runner, young and old;
- two triggers at once: one reservation;
- GPT's reproduction: two runs for one head now make one request, not four,
  and a third is refused at the ceiling;
- 429s counting;
- the daily ceiling across bindings;
- an unreadable 200;
- a forged verdict line;
- nothing paid while review is off, after the task was edited, or while a
  required check failed or is pending;
- an owner change;
- the sweep;
- the preflight, including a key that cannot list stored completions.

**Real tests.** `dashboard/tests/agent-verify.test.js` works on merge-commit
fixtures. It covers:

- GPT's reproduction (two modules, one commented-out import, a trivial
  assertion): fails;
- an added module that a test only imports: fails, as not covered;
- a test that runs the changed line but does not depend on it: fails on
  revert;
- failing tests, a deleted test, and a change with no test: refused;
- the lint reads code, not comments or strings;
- coverage through another module (integration): passes;
- an outcome test with a negative case: passes, with revert evidence;
- a documentation task: nothing to verify.

**Event chain.** What the probe showed:

- A push with the workflow token starts no workflow.
- A PR opened with the workflow token has its runs held as `action_required`
  until Eric approves them.
- After that approval, `workflow_run` did not fire.
- A `workflow_run` job's own check lands on the default branch's commit,
  which is why `post-review` posts `agent-review` on the head through the
  Checks API.
- A neutral required check counts as passing, which is why no required job
  is ever skipped.

Not yet observed:

- whether a PR the builder App opens runs its checks without approval;
- whether those runs then trigger `workflow_run`.

Both wait for the App (step 5).

## Verification commands and results

On Windows, in each branch's worktree:

| Branch at | Command | Result |
|---|---|---|
| A, `2bc140c` | `node dashboard/cli.js test` | 1091/1091 (`e74deda` changes only `.github/rulesets/README.md`) |
| B, with this document | `node dashboard/cli.js test` | 1131/1131 |
| B | `node --test dashboard/tests/agent-ledger.test.js dashboard/tests/agent-review.test.js dashboard/tests/agent-verify.test.js dashboard/tests/agent-guard.test.js dashboard/tests/agent-workflows.test.js dashboard/tests/merge-boundary.test.js` | 44/44 |
| C, `8d1d919` | `node dashboard/cli.js test` | 1088/1088 |

GitHub's own runs on the PRs are the authoritative result. A local run is
not.

## What remains unverified

- **The builder App and its event chain.** Nothing has run with an App
  token yet: the publish job, App-opened PRs running checks without
  approval, and `workflow_run` after them.
- **The workflows on GitHub.** `agent-build`, `agent-checks` and
  `agent-review` have never run there. `agent-verify` has never run on a
  GitHub runner.
- **OpenAI behaviour.** `store: true` and listing by metadata are tested
  against a fake only. If the organization has Zero Data Retention, stored
  completions are unavailable, and an uncertain attempt can only become
  `lost` after 20 minutes. The preflight says so.
- **Claude Code 2.1.304 flags.** They were read from its `--help`. The CLI
  has never run in the build job.
- **Residual risks:**
  - **Eric's own login.** Local sessions using Eric's `gh` login, and the
    hourly routine builder, act as Eric. They inherit his admin bypass:
    GitHub cannot tell them from him. Retire the routine builder or accept
    that.
  - **The Anthropic key.** Code the model runs in the build job can read
    the key. A dedicated workspace with a spending limit bounds the damage.
  - **Ledger appends.** Any holder of contents write on the ledger branch
    (the App, workflow tokens) can append lines. Forged verdicts fail the
    HMAC. A fake reservation or `lost` line can still waste a slot or allow
    one extra attempt, within the ceilings.
  - **What is public.** The ledger, the issue text and the check summaries
    are all public, because the repository must stay public.
  - **Fork PRs.** A fork PR's `pull_request` run uses the fork's workflow
    file. Eric merges only his own and agent PRs.

## Owner configuration and cutover (Eric)

Each step can be undone. The rollback is on the same line or just under it.

1. **Now:** stop the old reviewer's paid calls.
   `gh variable set CANDIDATE_REVIEW_ENABLED --repo kuaya1/CryptoResearch --body false`
   (undo: `--body true`).
2. **Merge PR C.** Render deploys `main`, and item 66 settles at the next
   sweep. Undo: revert the merge commit.
3. **Create the builder App.** Go to GitHub, Settings, Developer settings,
   GitHub Apps, New.
   - Webhook: off.
   - Repository permissions: Contents read and write, Pull requests read and
     write, Metadata read. Everything else no access, in particular
     Administration, Workflows, Actions, Checks, Commit statuses and Issues.
   - Only on this account.
   - Generate a private key.
   - Install it on `kuaya1/CryptoResearch` and
     `kuaya1/cr-merge-boundary-probe` only.

   Undo: uninstall or delete the App.
4. **Probe the App first.** On the probe repository:
   - `gh variable set BUILDER_APP_ID --repo kuaya1/cr-merge-boundary-probe --body <id>`
   - `gh secret set BUILDER_APP_KEY --repo kuaya1/cr-merge-boundary-probe < <key.pem>`
   - Then run each of these:
     `gh workflow run automation-app.yml --repo kuaya1/cr-merge-boundary-probe -f action=<open-pr|approve|merge|push-main|push-workflow|push-other|ledger-force>`
     (`approve` and `merge` also take `-f pr=<n>`).

   Each run passes; the result is the `RESULT app <action>: … exit=<n>`
   line in its log.
   - Expected: only `open-pr` exits 0, and its PR's `test` run starts
     without approval. Run `open-pr` first.
   - `approve` on that PR is refused as approving its own pull request.
   - Approve the PR yourself and let its checks pass, then run `merge`:
     both merge attempts must be refused.
   - If anything else succeeds, stop.
5. **Set the repository's variables and secrets.** Start with paid review
   off.
   - `gh variable set BUILDER_APP_ID --body <id>`
   - `gh variable set BUILDER_APP_SLUG --body <slug>`
   - `gh secret set BUILDER_APP_KEY < <key.pem>`
   - `gh secret set ANTHROPIC_API_KEY`: a Console key from its own
     workspace, with a spending limit.
   - `gh variable set AGENT_REVIEW_ENABLED --body false`

   `OPENAI_API_KEY` and `OPENAI_REVIEW_MODEL` (`gpt-6-luna`) are already set.
   Give that OpenAI project a budget.

   Undo: `gh variable delete …` and `gh secret delete …`.
6. **Merge PR A, then PR B.** B is stacked on A: after A merges, GitHub
   retargets B to `main`.
   - From A on, `backlog-pr` and `engineering-admission` open PRs and never
     write `main`, so each admission becomes a PR for Eric to merge.
   - Undo: revert the merge commits. That brings back the old promotion,
     which pushes to `main`.
7. **Create the label.**
   `gh label create agent:build --repo kuaya1/CryptoResearch --color 0E8A16 --description "Eric: build this issue with the agent lane"`
   (undo: `gh label delete agent:build`).
8. **Apply the rulesets and the workflow token default.** Use the commands
   in `.github/rulesets/README.md`, in this order:
   1. the read default;
   2. `agent-ledger`;
   3. `automation-branches`;
   4. `main-merge-requirements`, now that `agent-checks` and `agent-review`
      are on `main`;
   5. `main-merge-authority`.

   Keep `can_approve_pull_request_reviews` `true` until the old lane is
   retired. It is also the switch that lets workflows open PRs. Undo: that
   README's rollback section.
9. **Check.** `node dashboard/scripts/merge-boundary-check.js` must say the
   boundary holds.
10. **Preflight.** `gh workflow run agent-review.yml -f mode=preflight`.
    No charge. It must report the model readable, stored completions
    listable and the ledger readable. (The ledger branch is created by the
    first reservation; until then it reads as 0 lines.)
11. **Turn paid review on** for the pilot:
    `gh variable set AGENT_REVIEW_ENABLED --body true` (undo: `false`).
12. **Pilot.**
    - Open one `eng-docs@1` issue with the Agent task form and label it.
    - Then open one `eng-backend@1` issue with a real test.
    - Watch the chain: build, the App's PR, `test`, `agent-guard`,
      `agent-verify`, `agent-review`. Merge only if you agree.
    - Your own PRs get a neutral `agent-review` from `agent-guard`. If one
      ever lacks it: `gh workflow run agent-review.yml -f mode=eric-reviewed -f pr=<n>`.
13. **Only after the pilot passes end to end,** retire the old lane in one
    PR:
    - the inbox, worker and reviewer routes;
    - `candidate-review.yml`;
    - the `/mcp/engineering` resource and the owner panel;
    - the `CR_ENG_REVIEWER_TOKEN` secret and `CANDIDATE_REVIEW_ENABLED`;
    - then set `can_approve_pull_request_reviews` to `false`.

    Keep `dashboard/core/leases.js`, the research connectors, reports,
    portfolio, backups and the engineering history under `audits/`.
14. **Delete the probe repository** when done (Eric only).

## Removed, and what is duplicated for now

Removed in these PRs:

- `backlog-pr`'s promote and deploy jobs (its push to `main`);
- `engineering-admission`'s direct push to `main`;
- `reviewer.js`'s retry of the paid call.

Nothing else is deleted yet. Until step 13, two lanes exist side by side:

- the desk's inbox, worker, admission and `candidate-review`, which now
  never writes `main`;
- the agent lane.

Both review routes use `OPENAI_API_KEY`. Keep `CANDIDATE_REVIEW_ENABLED`
off so only the ledgered route can spend.
