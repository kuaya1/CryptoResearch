# Agent lane red-team pass and cockpit gap check (2026-10-27)

Eric, 2026-10-27. A request (pasted brief, "Principal Sovereign Systems
Architect") asked for an audit of the agent lane against six adversarial
vectors, fixes for every gap, a reconciliation of a supposed
`BUILDER_APP_*` / `CR_BUILDER_*` naming mismatch, and a plan for the
"Orbit → Desk" cockpit. Everything below was verified against `main` at
`e573d0d` and the live repository on 2026-10-27, read-only, before any file
was changed. Nothing here is committed, pushed, configured or deployed:
every merge, secret, ruleset, label and paid run is Eric's.

## 1. Live state, and where the brief was wrong

| The brief said | What is true (2026-10-27) |
|---|---|
| PR #33 and PR #34 are open / in flight | Both **merged** (`ebeff03`, `b187d30`). So are #35 and the whole v3 series #36–#41 (`c1e2462`), #42 (UI craft), #43–#45 (scheduler and Phase 6). #46 (`claude/backlog-item-72`) is the one open PR. |
| Reconcile `BUILDER_APP_*` / `ANTHROPIC_API_KEY` vs `CR_BUILDER_*` in the YAML | **No mismatch.** No `CR_BUILDER_*` name exists anywhere in the repository. The workflows read `vars.BUILDER_APP_ID`, `vars.BUILDER_APP_SLUG`, `secrets.BUILDER_APP_KEY`, `secrets.ANTHROPIC_API_KEY`, `secrets.OPENAI_API_KEY`, `vars.OPENAI_REVIEW_MODEL`, `vars.AGENT_REVIEW_ENABLED`: exactly what is set. The model is `.github/agent-policy.json` `build.model` (`claude-opus-5-5`), not a variable. |
| Variable `CR_BUILDER_MODEL = claude-sonnet-5-5` exists | It does not. Live variables: `AGENT_REVIEW_ENABLED=false`, `BUILDER_APP_ID`, `BUILDER_APP_SLUG`, `CANDIDATE_REVIEW_ENABLED=false`, `DESK_URL`, `OPENAI_REVIEW_MODEL=gpt-6-luna`. |
| `agent-guard.js route`, `report`, `scope-hook.js`, `cr.agent-task.v2`, `<!-- agent-build: failure -->` markers | None of these exist; v3 retired the marker and hook designs. `/revise` (`agent-revise.js`) reads feedback from three API-authenticated sources and never from comment text or logs (see vector 1). |
| Sizing is `cr-ticket-sizing@1` | `dashboard/core/tickets.js` is at `cr-ticket-sizing@2`. |

What is actually missing on GitHub (all Eric's, none in code):

- **0 rulesets applied**; `main` has no protection at all (`gh api repos/kuaya1/CryptoResearch/rulesets` → `[]`, branch protection 404). `merge-boundary-check.js` exits 1.
- **`AGENT_LEDGER_KEY` secret not set**: agent-review posts nothing for an agent candidate (fail closed), and `/revise` reads no verdict.
- **No `agent:build` label**: `agent-build.yml` can never start.
- **No `agent-ledger` branch**: the ledger is empty (correct: the first reservation creates it).
- Workflow token default is still `write`; `can_approve_pull_request_reviews` true.
- Repository **public**, Eric the only admin, `allow_auto_merge` false.
- `OPENAI_REVIEW_MODEL=gpt-6-luna` is unverified until `agent-review.js preflight` reads it.

## 2. Adversarial matrix

| Vector | Brief's proposal | Finding on `main` | Resolution |
|---|---|---|---|
| 1. Non-amnesiac retries, spoofed markers | Collect Eric's comments and `<!-- agent-build: failure -->` / `<!-- agent-review -->` markers only from verified bot logins | **Already stronger.** `/revise` feedback comes only from (a) Eric's own `/revise` comments read again through the API (owner, `User`, `OWNER`, unedited, not acted on), (b) the failure annotations of `agent-guard` / `agent-verify` check runs from GitHub Actions (app 15368) whose workflow run is this repository's `agent-checks.yml` at that head, (c) the ledger's review verdict for that head with a valid MAC. A marker in a comment proves nothing and is never read. Issue comments are not feedback by design: the issue body is the task version. | No change needed. **Gap fixed:** `agent-verify`'s reasons said only "n of m failed"; a revision did not know which test. It now names the failing tests (`failingReason`, at most five). **Gap fixed:** a build that did not start was said only in the Actions log; the `refused` job now comments on the issue (`issues: write`), as it did for `/revise` on the PR. |
| 1b. Actions log race (`jobs/$J/logs` 404) | Tee output to an artifact, API fallback | **Not applicable.** The lane never reads a log. Reasons travel as check-run annotations written by `agent-log.js` (`::error`, with `::stop-commands` around everything else), and `/revise` refuses while a check is still running. Residual: annotations are capped at 10 × 500 chars; the test tail stays in the job summary. | Accepted residual. |
| 2a. Zero-friction intake | Paths and tests as optional hints; a PreToolUse scope hook | **Real gap.** The form required `Files to change` and `Regression tests`, and `taskOf` refused a task without them: Eric was the path compiler. | **Fixed (`cr.agent-task.v2`).** Both fields are optional. Named, they narrow the build; empty, the template's `allowed_paths` are the scope (less `forbidden_paths`, protected and restricted paths, `max_files`), the builder's prompt says so in words, and a test file under `dashboard/tests/` is inside the scope named or not. Every candidate still must add or change a test (`requires_tests`, unchanged), and the verifier's named tests are the changed test files plus any the task names (unchanged). No hook: `disableAllHooks: true` is a security property (a candidate's hooks must never run); the guard refuses after the fact and the prompt states the boundary. |
| 2b. Behavioral test rigor, mutation proof | Parse imports; revert the implementation and require a failure | **Already done** in `agent-verify.js`: comment- and string-stripped assertion lint, V8 coverage of every changed line, and the revert check (each implementation file as main has it must make a named test fail); docs-only tasks have nothing to verify. | No change. |
| 3a. bwrap `--setenv TMPDIR /tmp`, loopback | Pass TMPDIR into bwrap for the post-build suite | **Not applicable as described**: the build job runs no suite in bwrap; the `bwrap … true` line only proves user namespaces work before anything is paid. The builder's own `node --test` runs inside Claude Code's sandbox, where writes are allowed only inside the checkout. **Real risk:** the desk's tests make temporary workspaces with `os.tmpdir()`; if `/tmp` is not writable there, the builder cannot run the tests it writes. | **Fixed without widening the sandbox:** the build and probe steps set `TMPDIR=$GITHUB_WORKSPACE/.cr/tmp` (`.cr/` is git-ignored, so nothing reaches the patch; the runner's temp stays unwritable). The sandbox probe now records `write_tmpdir` and `tmpdir_in_checkout` and fails unless `os.tmpdir()` is writable. Loopback is not needed: the desk's tests use fictional workspaces, not a server, and `agent-verify` runs them outside the sandbox anyway. |
| 3b. Patch trust boundary | Inspect raw patch text first; `git apply --index`; fixed bot identity; no hooks | **Already done.** `applyPatch`: size cap, binary refused, key-shaped strings refused (file and line, never the value), then `git read-tree` + `git apply --cached` into a scratch index (no working tree, no hooks, no `git am`, so no `From:` parsing), `write-tree`, then `checkChange` on the tree; `commit-tree` with the App's fixed name and e-mail and a fixed message with the task trailers. The patch is read with a copy of `.git` taken before Claude started (`core.hooksPath=/dev/null`, `fsmonitor=false`). | No change. |
| 4. Race-free, spend-bounded review | Concurrency group on head SHA; a `pending` commit status before the paid call; a 24-hour breaker counting statuses | **Already stronger.** The brief's status design has the race it names: two runners can both read "no status" and both pay. Here every paid request is a ledger reservation written by compare-and-swap on `agent-ledger` (a plain push, refused when the tip moved; the ruleset additionally forbids force and deletion), bound to task version, head, merge base, diff SHA-256 and review config, before anything is sent. Ceilings per UTC day (`reviews_per_day` 12, `review_tokens_per_day` 1.5M, `builds_per_day` 6, `build_usd_per_day` $40) and per binding (2) are read from the ledger, not from check runs posted after the fact. An ambiguous answer (timeout, 408/409/5xx, cut body) is `unknown` and reconciled against OpenAI's stored completions (`metadata.cr_attempt`) before anything is resent; 20 minutes unfound is `lost`. The concurrency group on `workflow_run.head_sha` exists too. | No change. Residual: GitHub's "Update branch" makes a new head with the same diff, so a second paid review of an identical diff is possible; bounded by the ceilings. Reusing a verdict for the same `diff_sha256` is a possible later refinement, deliberately not made here. |
| 5. Admin bypass paradox | Split into a zero-bypass checks ruleset and an authority ruleset | **Already split**, exactly so: `main-merge-requirements.json` (pull request, 4 required checks from app 15368, strict, no force, no deletion, **no bypass**) and `main-merge-authority.json` (the `update` rule, admin role bypass **pull request only**). Bypass actors are per ruleset, so the admin bypass never reaches the required checks. The probe repository showed: Eric cannot merge before the checks pass; automation with contents and pull-requests write cannot merge a green, approved PR; approval is not the boundary. The builder App has no Administration or Workflows permission and is not an admin, so it cannot update `main` and cannot push `.github/workflows/`. | No change to the files. **The gap is that none of it is applied** (section 1). Still to observe with the App's own installation token: that its PRs run their checks without approval and that it cannot call the merge endpoint (the README's open probe). |
| 6. Forensic alpha and findings on a public repo | Keep defect feedback actionable without broadcasting | See section 4. | Recommendation, no code. |

## 3. What changed in this pass

Files: `.github/ISSUE_TEMPLATE/agent-task.yml`, `.github/agent/builder-rules.md`,
`.github/agent/sandbox-probe.js`, `.github/workflows/agent-build.yml`,
`.github/workflows/agent-sandbox-probe.yml`, `dashboard/scripts/agent-guard.js`,
`dashboard/scripts/agent-verify.js`, `dashboard/engineering/agent-issue.js`,
their tests, `CLAUDE.md`, this file.

1. **Hints at intake (`cr.agent-task.v2`).** `taskOf` requires Outcome,
   Acceptance checks and Negative cases only. `checkChange` applies the
   "not among the task's files" rule only when the task names paths, and a
   file matching the template's `requires_tests` glob is inside the scope
   either way (guarded tests stay refused by `protectedHit` / `restrictedFor`
   first). `builderPrompt` says the scope in words (`scopeWords`): the named
   paths, or the template's `allowed_paths`, its `forbidden_paths`, "never a
   protected path", `max_files`. `agent-issue.js` no longer flags a test file
   outside the named paths. The form marks both fields optional.
2. **Refusals where Eric looks.** `agent-guard.js reserve` outputs
   `kind=build` and a `note` on every refusal; the `refused` job gains
   `issues: write` and comments "Build not started: …" on the issue (a
   `/revise` refusal still goes to the pull request). The note is data
   (`printf '%s'`, a body file), never script text.
3. **Failing tests by name.** `agent-verify.js runTests` collects TAP
   `not ok n - name` lines (file lines left out); `verify` adds one reason
   `failing: a; b; …` (at most five names of 80 characters) after the count.
4. **Temp directory inside the checkout.** `TMPDIR=$GITHUB_WORKSPACE/.cr/tmp`
   on the Build and Probe steps (`mkdir -p` first). The probe records
   `write_tmpdir` and `tmpdir_in_checkout`; its verdict fails when
   `os.tmpdir()` is not writable. A workflow test pins `.cr/` in
   `.gitignore`.
5. **A private repository on GitHub Pro (added 2026-10-27, after Eric moved
   `kuaya1` to GitHub Pro).** `merge-boundary-check.js` reads the rulesets
   list with `gh api --include`, so it has GitHub's own HTTP status and
   message (`readWithStatus`). A private repository holds only when that
   read answers HTTP 200. GitHub Free answers 403 "Upgrade to GitHub Pro or
   make this repository public". The other conditions are unchanged, GitHub's
   report of the rules applied to `main` included, so the 200 alone never
   passes. A refused read is one reason in GitHub's words, not four "not on
   the repository" lines. A repository read that failed has no visibility
   and never holds; it used to default to public. The plan itself is not
   read: Eric's `gh` token has no `user` scope, so `GET /user` returns no
   plan. The unused `plan_supports_private_rulesets` flag is gone.
   `merge-boundary.test.js` covers Pro, Free, an unread visibility and
   `readLive` against a fake `gh` that prints what `gh api --include`
   prints. Its four new or changed tests fail on `main`'s checker.

Tests: the eight `agent-*.test.js` files pass (72 tests), and
`merge-boundary.test.js` passes (7 tests). Full suite on 2026-10-27:
1201 pass, 0 fail.

## 4. Finding 6: a public repository

**What is exposed today.** The code, the audits, the prompts and the lane's
own records are public by Eric's choice (the records of the desk never are:
the allowlist `.gitignore`). The lane adds three public surfaces: the
`agent-review` check run (the model's full findings), `ledger.jsonl` on the
`agent-ledger` branch (every verdict verbatim), and the `agent-build` /
`agent-revise` artifacts (the patch, the builder's report, the quoted
feedback; downloadable by anyone signed in, for 7 days). A finding about a
candidate describes code that is not deployed; a finding that names a
pre-existing weakness in `main` ("this change does not fix X in server.js")
describes the live desk.

**Why it is public.** GitHub Free enforces rulesets on public repositories
only (the probe got HTTP 403 on a private one). The merge boundary of
section 2 vector 5 depends on it.

**Decided (Eric, 2026-10-27).** `kuaya1` is on GitHub Pro and the repository
goes private (section 6, step C). The checker's Pro case is section 3,
item 5.

**Recommendation.** Move to **GitHub Pro ($4/month) and make the repository
private** before the lane reviews anything that touches sign-in, the front
door or the server's routes, and in any case before forensic method documents
become edge Eric wants to keep. Economics: a public repository has unlimited
free Actions minutes; Pro includes 3,000 minutes a month on private
repositories, then $0.008 a minute on Linux. One build cycle is roughly
25–60 runner minutes (build up to 45, checks, the suite, the review). One
build a day fits inside the 3,000; the ceiling of six a day would cost about
$20–$60 a month on top of the $4. Do **not** use a self-hosted runner for the
lane: `agent-verify` runs the candidate's code, and the lane's whole model
assumes an ephemeral machine with no credential of Eric's on it. Until the
move: keep retention at 7 days (as it is), and accept that a review finding
is public for the life of the check run. Once private, the check-run text
could be reduced to severities and paths with the full finding kept in the
ledger, which would then be private too. The checker's Pro case is done
(section 3, item 5).

## 5. The cockpit (Phase 2): gap check against `dashboard/web/src`

The Platform look was built on 2026-10-26 (`CLAUDE.md` "Platform look") and
polished in PR #42 (L1–L7). Read against the brief:

| Brief's item | On `main` | Gap |
|---|---|---|
| 25-step gray ramp with dark inversion (#131313 / #212121 / #303030) | `dashboard/public/tokens.css` `--gray-0…1000`, inverted under `[data-theme="dark"]` and `system`; canvas `--gray-50`, panel `--gray-200`, elevated `--gray-300` | None |
| OKLab alpha ladder | `--alpha-01…70` as `color-mix(in oklab, var(--alpha-base) N%, transparent)` | None |
| Inter Var + Geist / JetBrains Mono | System fonts; `tokens.css` says "No web font and no Inter"; `web-app.test.js` guards no downloaded fonts | **Conflict with Eric's standing rule** (2026-10-08, 2026-10-10, 2026-10-26). Not adopted. His call. |
| `tabular-nums` on every figure | `body` uses `--figures: tabular-nums lining-nums`; the report's own text keeps proportional figures by design | None |
| 260px transparent sidebar, 36px pills, `::before` active, count badges | `Shell.jsx`, `--sidebar-w: 260px`, `--nav-h: 36px`, Review caution and Portfolio info counts | None |
| Workspace switcher | A 32px workspace row **without** a switcher chevron (one workspace; Eric, 2026-10-26) | **Conflict with Eric's decision.** His call. |
| Daily Brief hero with the CSS mesh and readiness circles | `DeskHero.jsx`: three 40px circles from `GET /api/brief/daily` (Research waiting, Forensics exits, Tickets for you), Open Daily Brief, Review queue | None |
| 6-cell KPI strip (NAV, 24h PnL, Unrealized, Realized, Stablecoin %, Drawdown) | A five-cell desk-state strip (`StatusStrip.jsx`: Market, Total cap, Beat BTC 30d, Needs review, Research waiting) with the 44px Bitcoin sparkline | **Content decision.** The six cells are Portfolio figures; Portfolio already has its KPI grid. Putting them on the Desk duplicates it. Recommendation under Track 2: a Paper Book cell (open paper exposure, 30-day outcome vs BTC) rather than NAV cells. Eric's call. |
| Risk-budget meter (green fill, caution 80%, danger 100%, cap mark) | `watchlist-model.js` `riskBudget` and the row under the strip, exactly so, "Cap not set" without a bar | None |
| Ledger table with the 3-dot consensus glyph, grades never averaged | `ProjectTable.jsx`, `canonicalGrade` (headline else Claude, never an average) | None |
| 520px inspector on the elevated surface | `--inspector-w: 520px`, docked from 1280px, drawer below, sheet on a phone | None |
| PM Decision Card: Approve 1.0R, Halve 0.5R, Veto / Archive, Confirm Pass, Acknowledge Trim; `cr-ticket-sizing@1` | `PMDecisionCard.jsx`: Approve Risk ($500), Halve Size ($250), Veto, Pass, Watch, Trim acknowledged, buttons in the sticky foot through a portal; sizing is `cr-ticket-sizing@2` | **Vocabulary conflict.** The desk sizes in dollars by Eric's rules; R-multiples would be a new sizing vocabulary and a new frozen version. His call. |
| System A (viability) vs System B (forensic concerns) scorecards | The research Overview (13 category grades, six components) and the Forensics tab (Assessment, Exits, Timeline, Receipts) | **Naming only.** The two systems exist as Research and Forensics; "System A / B" would be explanatory vocabulary the UI rules forbid. Recommendation: keep the words Research and Forensics. |
| AMM exit capacity at $100 / $500 / $2,000 | `forensic-defs.js` `exit_sizes_usd: [100, 500, 2000]`, the Exits segment, the fixed-token comparison | None |
| 4-month conditional resilience timeline | The 72 h, 7, 14, 30, 90 and 120-day deadlines frozen in each receipt; the Timeline segment | None |
| SHA-256 pinned receipts | `verifiedFrozen`, receipts frozen with their origin and definitions | None |

**Conclusion.** The foundation token and shell pass the brief describes is
already on `main`; redoing it in a worktree would be churn, so none was
started, and no web source changed in this pass (the committed bundle stays
current; the suite's bundle-hash test confirms it). What remains for an
`eng-app@4` sequence is four decisions of Eric's and one small build:

1. Fonts: keep the system stack (recommended) or reverse the no-Inter rule.
2. Workspace switcher: none (recommended, one workspace) or build it.
3. Desk KPI cells: keep the desk-state five, or add Paper Book figures;
   never the six portfolio cells twice.
4. PM card words: dollars (recommended) or R-multiples as `cr-ticket-sizing@3`.
5. Build: the one item with no decision attached is a Paper Book cell in
   the KPI strip reading `GET /api/research/outcomes` (Research > Outcomes
   already computes it; `watchlist-model.js` would gain one pure function,
   `StatusStrip.jsx` one cell, with a `web-app.test.js` case). It is a
   Track 2 item and fits `eng-app@4`'s allowed paths.

## 6. Cutover (Eric, in this order)

Everything below is Eric's own command, from this folder, signed in as
`kuaya1`. Nothing here is run by any workflow.

**A. Land this pass as a pull request (Eric merges it).**

```powershell
git checkout -b claude/agent-lane-redteam
git add .gitignore .github CLAUDE.md dashboard/scripts/agent-guard.js dashboard/scripts/agent-verify.js dashboard/scripts/merge-boundary-check.js dashboard/engineering/agent-issue.js dashboard/tests/agent-guard.test.js dashboard/tests/agent-issue.test.js dashboard/tests/agent-verify.test.js dashboard/tests/agent-workflows.test.js dashboard/tests/merge-boundary.test.js audits/2026-10-27-agent-lane-redteam
git commit -m "agent lane: task hints (cr.agent-task.v2), refusals on the issue, failing tests named, TMPDIR inside the checkout; merge boundary holds private on GitHub Pro"
git push -u origin claude/agent-lane-redteam
gh pr create --base main --head claude/agent-lane-redteam --title "agent lane: task hints, refusals on the issue, failing tests named, TMPDIR in the checkout, private on Pro" --body-file audits/2026-10-27-agent-lane-redteam/README.md
gh pr merge --merge
```

Land this before the repository goes private: until it is on `main`, the
checker there refuses any private repository.

**B. The ledger key (never typed into chat or a log).**

```powershell
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" | gh secret set AGENT_LEDGER_KEY
```

**C. Make the repository private; workflow tokens default to read; apply the rulesets; check the boundary.**

```powershell
gh repo edit kuaya1/CryptoResearch --visibility private --accept-visibility-change-consequences
gh api --include repos/kuaya1/CryptoResearch/rulesets
gh api -X PUT repos/kuaya1/CryptoResearch/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true
gh api -X POST repos/kuaya1/CryptoResearch/rulesets --input .github/rulesets/agent-ledger.json
gh api -X POST repos/kuaya1/CryptoResearch/rulesets --input .github/rulesets/automation-branches.json
gh api -X POST repos/kuaya1/CryptoResearch/rulesets --input .github/rulesets/main-merge-requirements.json
gh api -X POST repos/kuaya1/CryptoResearch/rulesets --input .github/rulesets/main-merge-authority.json
node dashboard/scripts/merge-boundary-check.js
```

The rulesets read (the second command) must print `HTTP/2.0 200 OK` as its
first line. A 403 "Upgrade to GitHub Pro
or make this repository public" means the Pro plan does not apply to this
repository yet: stop there and apply no ruleset.

Expected: `Merge boundary holds on kuaya1/CryptoResearch: only kuaya1 can
update main, through a pull request with the required checks.`, then the
note `the repository is private: GitHub answered the rulesets read with
HTTP 200, so the account's plan (GitHub Pro or above) enforces them…`. If
the account ever lapses to Free, GitHub answers 403 and the check fails
again. Render's service was created on 2026-10-02, while the repository was
private, so its GitHub access already covers a private repository. The next
deploy's revision on `/healthz` confirms it. From this
point every change to `main`, Eric's included, is a pull request with
`test`, `agent-guard`, `agent-verify` and `agent-review` green or neutral
(an owner PR gets a neutral `agent-review` from `agent-checks.yml`).
`automation-branches` lets only the admin role create branches outside
`agent/**`, `agent-ledger`, `visual-proof`, `claude/intake-issue-*` and
`claude/admission-*`: Eric's own sessions (his `gh` login) are the admin
role; a workflow pushing any other `claude/**` branch with the workflow
token will be refused from here on.

**D. The label, the free probes.**

```powershell
gh label create agent:build --color 0E8A16 --description "Eric's own label: builds this version of the issue once (agent-build.yml)"
gh workflow run agent-sandbox-probe.yml --ref main
gh workflow run agent-review.yml --ref main -f mode=preflight
gh run list --workflow agent-sandbox-probe.yml --limit 1
gh run list --workflow agent-review.yml --limit 1
```

Read each run's job summary: the probe must say "the sandbox holds"
(twelve rows, the new one "writes to os.tmpdir() work … inside the
checkout"); the preflight must say the key reads `gpt-6-luna` and lists
stored completions. The probe costs at most $0.50; the preflight nothing.

**E. The first pilot issue.** Open the form, fill Template `eng-backend@1`,
Outcome, Acceptance checks and Negative cases; leave Files to change and
Regression tests empty unless there is a reason to narrow the build. Then
add the label yourself:

```powershell
Start-Process "https://github.com/kuaya1/CryptoResearch/issues/new?template=agent-task.yml"
gh issue edit <n> --add-label agent:build
gh run list --workflow agent-build.yml --limit 1
```

A refused build is said on the issue within a minute. A published build
opens `agent: <title> (#<n>)` from `agent/issue-<n>`; its checks run.
`agent-review` posts `action_required` ("the model review is off") until:

```powershell
gh variable set AGENT_REVIEW_ENABLED --body true
gh workflow run agent-review.yml --ref main -f mode=run -f pr=<pr>
```

or, to review the head yourself instead of paying:

```powershell
gh workflow run agent-review.yml --ref main -f mode=eric-reviewed -f pr=<pr>
```

Then `gh pr merge <pr> --merge` (strict checks: the head must be up to date
with `main`; "Update branch" is a pure merge the guard accepts). `/revise
<what to change>` as a comment on the pull request revises it once per
comment, at most twice per task version.

**F. Open probe (Eric, in the probe repository `kuaya1/cr-merge-boundary-probe`):**
with the App's installation token, confirm that an App-opened PR runs its
checks without approval and that `gh pr merge` with that token is refused.
