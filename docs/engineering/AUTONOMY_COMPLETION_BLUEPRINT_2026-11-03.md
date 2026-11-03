# Autonomy completion blueprint (2026-11-03)

**Status: design of record once Eric merges this pull request.** Merging it records his answers to Q1–Q5 (§3) and the build and proof sequence below. It supersedes the combined blueprint (PR #134, closed unmerged at `b462db6`) and the proposal disclaimer in `docs/engineering/OWNER_DECISIONS_2026-11-02.md` ("Nothing here is an approval", `:3`). Where this file and that one differ, this file holds. Merging it changes no code, setting, schedule or credential, and arms nothing. Each later step takes effect only through its own merged pull request, or through Eric's own act on the desk.

- **Basis:** `origin/main` at `e3e017d12bfae6c877457afc2c963458f486d8d2`, the merge of #161, deployed on Render. Every `file:line` below is read at that commit unless it is marked otherwise.
- **Audits reconciled:**
  - the Codex read-only autonomy readiness audit, `AUDIT.md`, pinned `af03923`, drift to `e3e017d`, findings A1–A8;
  - the Claude zero-trust autonomy readiness audit, `AUDIT-claude.md`, same SHAs, findings E1–E6 and harness S1–S5.
  - Both reports are outside the repository: Codex's under `%USERPROFILE%\.codex\visualizations\2026\11\03\…\cryptoresearch-readiness-audit\`, Claude's under `Documents\CryptoResearch-evidence\autonomy-readiness-audit-2026-11-03\`.
  - **Both verdicts: NOT READY.**
- **Law 3 holds throughout:**
  - one task, one branch, one pull request, `node dashboard/cli.js test`, Eric's diff review and his merge;
  - no pull request here touches the nine protected files (`dashboard/tests/trader-boundary.test.js:29-38`);
  - no agent merges.

## 1. Where both audits agree

| Fact | Evidence |
|---|---|
| Deployed revision is `e3e017d` | `/healthz` read by both audits at 04:42–04:43Z on 2026-11-03 |
| The nine protected files are byte-identical to `b87a0b4` | Both audits: blob SHA-256 |
| The core's safety tests bite | Claude: mutations M1–M4 all caught. Codex: the independent N4 ABA probe fails on `af03923` and passes on `e3e017d` |
| **First unsupported transition: an admitted lead becoming a Researcher session** | Codex A1 / T2. Claude §0, §8.1 / transition 1 |
| The PC runner has never run | Task `CryptoResearch pilot-all`: Disabled, `LastTaskResult` 267011, WakeToRun False, Interactive logon. Its checkout is `Documents\CryptoResearch` at `aa5ad1d`, 96 commits behind `main` |
| `\CryptoResearch\Hourly` runs stale code | It runs `scheduled-run.cmd` from that same checkout |
| No hosted runner is defined in the repository | No `render.yaml`, Dockerfile or Procfile at either SHA |

**Where the audits differ.** Codex scores 25/42 at the pin and 26/42 at `e3e017d`. Claude scores 19/42 at both. The gap is a different 1/2 line: Codex counts controlled-integration evidence, Claude requires a real-desk completion. Both agree no category earns a 3. This blueprint does not rescore. The score that matters next is the operating evidence §6 collects.

## 2. Audit reconciliation table

"Line" is the defect's location at `e3e017d`. "Closes" is the pull request in §4 that fixes it, or the reason none does.

| ID | Finding | Line at `e3e017d` (verified) | Closes |
|---|---|---|---|
| **A1** | The Researcher/Prosecutor runner is not established off the PC. The admitted job is `cowork` and the paid-API timer never takes it | `dashboard/core/research.js:1463-1466` (`isDueJob` excludes assistant jobs); `dashboard/tests/lead-admission.test.js:892-898`; `dashboard/scripts/pilot-task.ps1:165` (`-Disable`), `:166` (Interactive); task state on the PC | **PR 4** (Ops-1 definition and drill), then §6 cutover. PR 1 is a prerequisite |
| **A2** | The scheduled launch omits `--unattended` and `--model`, so polling uses GET and never writes the production sighting | `dashboard/scripts/pilot-task.ps1:163`; `dashboard/scripts/pilot.js:1063` (`production` needs `o.unattended`), `:1092` (model refusal), `:1115-1116` (GET poll) | **PR 1** |
| **A3** | The trader job refreshes `last_success_at` after a mandate-sweep throw or a book-step failure | `dashboard/core/jobs.js:222` (sweep caught), `:231-238` (step caught), `:241` (status ignores both), `:42` (`OK_STATUSES`), `:139`, `:146` | **PR 2** |
| **A4** | An HTTP heartbeat refusal (for example 503) is logged as `sent` | `dashboard/scripts/pilot.js:955-962` (`sendPing`: any resolved fetch is `sent: true`), `:1061`, `:1077` | **PR 1** |
| **A5** | Malformed PM Cohort history reads as an empty list | `dashboard/core/paper.js:42-49`, **protected** | **Not in this sequence.** It is the PM benchmark, not the Trader Sim ledger. Any fix is its own [P] pull request under Eric's manual review. It does not block B0–B3 (§3, open items) |
| **A6** | Unchecked execution values under an A→B→A swap | Fixed at `e3e017d`: `dashboard/core/trader-desk.js:932+`, `dashboard/core/fsx.js:159+` | **Closed by #161** (`e3e017d`). No action |
| **A7** | Canon lags code | `docs/ONE-SHEET.md:57` (N4/N7 still on the Proposed line after #161 merged), `:58` ("Deployed: not verified"); `docs/engineering/OWNER_DECISIONS_2026-11-02.md:3`, `:5`, `:13`; `dashboard/cli.js:114` ("no order is ever placed"); `dashboard/core/tickets.js:2568` ("waits for Eric's PM review", although a live mandate can grant it) | **PR 3** |
| **A8** | Safe uncertainty can need manual continuation: a lost answer becomes `reconcile`/exit 3 | `dashboard/tests/pilot-host-recovery.test.js:146-175` | **Accepted by Q1** (§3). It is not a defect. PR 4's runbook names the reconciliation step, and the one-sheet (PR 3) names the exception |
| **E1** | No runner revision guard: a runner executes whatever checkout it sits in | `dashboard/scripts/pilot.js:1089-1094`: nothing between the `--desk` and `--model` checks and `takeLock` compares revisions; `dashboard/scripts/pilot-task.ps1:62` (`$Root` is wherever the script sits) | **PR 1** |
| **E2** | Trader job status is not honest (same defect as A3, plus S4) | as A3; `dashboard/core/trader-candles.js:554-563` (`held` + `accounting_unknown`) → `jobs.js:241` (`held` → `skipped`) | **PR 2** |
| **E3** | Housekeeping errors are swallowed, and a stale pilot job is demoted silently | `dashboard/core/research.js:2382`, `:2385` (`catch (_) { /* housekeeping only */ }`); `:2516` (24 h), `:2525-2543` (`releaseStaleAssistantJobs`, `cowork` → `unconfigured`/`manual` at `:2534-2535`) | **PR 2** |
| **E4** | STALE threshold is self-declared by the runner | `dashboard/core/pilot-sighting.js:38` (`staleAfterMin`), `:45` (accepts `max_agents` 0–10), `:93`; the runner sends it at `dashboard/scripts/pilot.js:1037` | **PR 1** |
| **E5** | Ops-1 not built | Repository absence (see A1) | **PR 4** |
| **E6** | Canon: no host legend, self-listed "Proposed", stale `DESK_STATE.md` header | `docs/ONE-SHEET.md:5-27` (the diagram names no host), `:57`; `DESK_STATE.md:3` ("Last updated 2026-10-28"); `dashboard/tests/one-sheet-status.test.js:52-71` (the Proposed check only catches PR numbers, and N4/N7 is listed without one) | **PR 3** |
| **S1** | A runner declaring `max_agents` 4 reads `fresh` at 6 h (395 min), and 10 stretches it to 965 min | as E4; harness `S1_matrix` | **PR 1** |
| **S2** | Not defined: no S2 appears in `AUDIT-claude.md` or its `raw/audit-sim-output.json` (it holds S1, S3, S4, S4b, S4c, S5) | — | **UNVERIFIED, no source of record.** Nothing invented |
| **S3** | A mandate sweep that throws leaves the job `ok`, `error: null` and `last_success_at` advanced | `dashboard/core/jobs.js:222`, `:241` | **PR 2** |
| **S4** | Accounting unknown is recorded `skipped` (a success) | `dashboard/core/trader-candles.js:558-562` → `dashboard/core/jobs.js:241` | **PR 2** |
| **S4b** | A restored copy is also `skipped`. That is correct, but it shares a label with S4 | `dashboard/core/trader-candles.js:525` → `jobs.js:241` | **PR 2** keeps it `skipped` and gives S4 its own status |
| **S4c** | A candle failure records as `failed` | `trader-candles` `failed` → `jobs.js:242` `error` | Correct today. **PR 2** adds a regression control |
| **S5** | A `cowork` research job with no runner is demoted to `manual` at 24 h and nothing says so | `dashboard/core/research.js:2516`, `:2534-2535`. It runs every 2 min from the server's `researchTick` (`dashboard/server.js:776-785`, `:875`), not from `HOSTED_TIMER_JOBS` (`jobs.js:41`) | **PR 2** |
| **C12** | Canon matches code (score 1) | as A7 and E6 | **PR 3** |
| **C14** | One sheet with every host | as E6 | **PR 3** |

### Corrections to the task brief (Law 4: verified at `e3e017d`)

1. **`--unattended` already requires `--model`.** `dashboard/scripts/pilot.js:1092` refuses an unattended run without one (exit 1, nothing claimed), and `dashboard/tests/pilot-credentials.test.js:95` covers it. PR 1 does not re-add that check. The gap is that the scheduler never passes either flag (A2).
2. **`attention` counts as success.** `attention` is in `OK_STATUSES` (`jobs.js:42`) and in `OK_JOB` (`dashboard/core/brief-daily.js:27`). Marking the trader job `attention` would still advance `last_success_at`, so PR 2 uses a status outside both sets (§4, PR 2).
3. **The desk's revision reader cannot read a Git worktree.** `dashboard/core/revision.js:15-34` (`readGitHead`) reads `.git/HEAD` as a folder. In a worktree `.git` is a file (`gitdir: …`), so it returns `null`; this checkout shows it. So PR 1 cannot use it for the dedicated runner worktree Q1 requires, and reads Git through `git` itself.
4. **Demotion runs on the 2-minute research tick,** not the 30-minute timer (row S5). Whether a demoted job is still prepared and completed by the pilot worker is **UNKNOWN**:
   - `pilot-worker.js:178-190` prepares from the open run, not the job's mode;
   - harness S5 shows an empty queue after release on an unenrolled fixture.

   PR 2 pins this with a test before deciding anything about it.
5. **The Desk Controls panel is in the committed web bundle.** `dashboard/web/src/shell/DeskControls.jsx:16` imports `dashboard/public/desk-controls-model.js`. `dashboard/tests/web-app.test.js:33-43` fails when the bundle is stale. A PR that changes that model runs `npm run build` in `dashboard/web` and commits `public/app`.

## 3. Eric's ratified owner decisions (Q1–Q5)

Recorded 2026-11-03. They replace the proposals in `OWNER_DECISIONS_2026-11-02.md` §Q1–§Q5. Each code consequence lands only through the pull request named for it.

**Q1. Runner host and exception policy.**

- **Approved.** The production runner moves to **one independent Render Cron Job (Ops-1)** after PRs 1–4 are merged and deployed. Its command is:

  ```
  node dashboard/scripts/pilot.js --unattended --pilot-all --desk=online --max-agents=1 --model=<pinned>
  ```

- **The PC's role.** A clean, dedicated `main` worktree on the PC is kept **only** for the supervised B0–B3 proof before cutover.
- **One scheduler at a time.** Both schedulers never run at once. The PC `pilot-all` task is disabled before the Render cron is resumed, and the Render cron is suspended before the PC task is enabled.
- **Accepted exception.** An ephemeral cron container can lose connectivity before `complete`. The claim then stays `dispatched` and becomes `reconcile` (exit 3). Eric reconciles it by hand on Desk Controls (`POST /api/projects/<id>/pilot-claim/release {"reconciled":true,"attempt_id":…}`).
  - There is no automatic re-dispatch, no time-based LOST and no blind resubmission (Constitution Invariant 1; `pilot-claims.js`).

**Q2. Liveness, STALE and heartbeat.**

- **Adopted.** Healthchecks.io. `CR_HEALTHCHECK_URL` is a secret set on the runner host only, and it alerts Eric only.
- **Runner cap.** `--max-agents=1`.
- **STALE is enforced by the desk at 120 minutes.** A runner's declared `max_agents` never stretches it beyond the desk's cap. The cap is 1, so the threshold is `max(120, 1 × 95 + 15)` = 120.
  - Raising the cap is a code change Eric merges, never a value a runner sends.
- **Unchanged.** A normal local lock overlap still reads `attention-overlap` (`pilot.js:925`).
- **Delivery is recorded honestly.** A delivered ping is recorded only on HTTP 2xx. A refusal is recorded with its status, and it never changes the exit code, retries, releases a claim or touches authority.

**Q3. Statistical grouping and sample floor.**

- **Grouping.** Group by `decider_kind × researcher_model_version × execution_policy`, as the code already does (`grade-outcome-view.js:289`, `group_key`).
- **What is shown.** Raw counts and per-decision rows only.
- **No rates for now.** `rates: null` until **at least 50 closed positions** in a group.
- **Under Q4 = B,** `execution_policy` reads `not_recorded` (`grade-outcome-view.js:152`), so groups cannot be told apart by policy, and rates stay `null` this phase at any count.
- **No code change is needed now.** PR 3 only updates the no-rate sentence (`grade-outcome-view.js:48`), which still says Eric has not set a minimum. Building a rate is a later, separate pull request.

**Q4. Protected execution stamp.**

- **Option B (`not_recorded`) for this phase.**
- The nine protected files stay 100% untouched.
- The engine revision, `FILL_SHARE_MAX` and the `trader.rules` digest stay `not_recorded` in the basis (`decision-basis.js:465-471`). They are never filled from current settings.
- A deploy between a reservation and its fill is evidenced from Render's deploy record.

**Q5. Canary gating and candidate.**

- **Gate.** B0 → B1 → B2 → B3 runs only after PRs 1–4 are merged **and** `/healthz` reports the merge SHA of the last of them.
- **Candidate.** Re-check NMR's contract hold at B0.
  - If NMR is still held on CG-21/CG-23, use a clean-contract candidate for the pipeline proof, for example Raydium or Uniswap.
  - The candidate goes by its stored identity (chain, contract, CoinGecko ID), never by ticker.
- **No forced fills.** A fill is never forced on a vetoed or held asset. A held or no-trade result is a correct safety outcome, and it is reported as "fill pending", not passed.

**Still open, and not decided by this record:**

- **Law 1 credential.** Agent shells hold the `kuaya1` admin token, so Law 1 is procedural only (Claude §3, §10). Agent sessions here never merge.
- **A5.** The PM Cohort false-empty read is a protected [P] change; Eric schedules it separately.
- **Constitution Invariant 3 wording.** It names two of the nine protected files (`CONSTITUTION.md:50`). Eric edits it himself.
- **Baseline and fee drag** (`OWNER_DECISIONS_2026-11-02.md`, "Baseline and fee drag").
- **The F04 flake** (`arm-desk.test.js`, admission-only patch).

## 4. Build sequence: four pull requests, zero protected-core edits

**Merge order: PR 1 → PR 2 → PR 3 → PR 4.**

- Each branch is cut from `main` after the previous merge.
- PR 3 lists PRs 1–2 as merged.
- PR 4 needs PR 1's guard, because a cron container must refuse to run code the desk is not running.
- Every PR runs `node dashboard/cli.js test` green before review, adds its own negative control (a test that fails on `e3e017d`), and touches none of the nine protected files.
- `dashboard/tests/trader-boundary.test.js` must pass unchanged.

### PR 1: `fix/runner-unattended-and-revision-guard`

**Closes A2, A4, E1, E4/S1.**

| File | Change |
|---|---|
| `dashboard/scripts/pilot.js` | **Revision guard (E1).** When `o.unattended && o.desk === 'online'`, after the `--model` check (`:1092`) and **before** `takeLock` (`:1094`), `runAll` calls `revisionGuard()`. It runs on `--dry-run` as well, so B0 can rehearse it with nothing claimed. It refuses with `log.error`, health `failure`, exit 1 and the heartbeat's `/1` unless all of these hold: (a) the runner's revision is known; (b) the checkout is clean; (c) the desk's revision is known; (d) the two are equal, all 40 hex characters with no prefix match. Nothing is polled, claimed, locked or dispatched on a refusal |
| | **Runner revision.** `RENDER_GIT_COMMIT` when it is set and 40 hex characters: `source: 'render'`, clean by construction because a Render build is immutable. Otherwise `git -C <repo root> rev-parse HEAD`, with clean meaning `git -C <repo root> status --porcelain` printed nothing. This works in a worktree (§2, correction 3). If `git` is missing or fails, the run refuses |
| | **Desk revision.** `GET <deskUrlOf(o, env)>/healthz` with a 10 s timeout. It must be 200 with a line `revision <40-hex>`; anything else refuses ("the desk's revision is unknown") |
| | **Log.** `log.revision = { runner, desk, source, clean }`, commit IDs only |
| | **Unchanged.** `--desk=local` with `--unattended` (`pilot-credentials.test.js:126`). The local desk has no `/healthz` and is not the production path |
| | **Heartbeat delivery (A4).** `sendPing` returns `{ sent, ok, status }` with `ok = res.ok === true`. `log.heartbeat.start` and `.final_sent` are `'sent'` only when `sent && ok`, `` `http_${status}` `` on a non-2xx answer, and `'timeout'` or `'unreachable'` as today. A refused ping prints one line ("The heartbeat's … ping was refused (HTTP 503); the run's result is unchanged."). It is never retried, and it never changes the exit code, a claim or authority |
| `dashboard/scripts/pilot-task.ps1` | **Registration (A2).** `-Register` gains `[string]$Model`, which is required and checked against `^[A-Za-z0-9._:\[\]-]{1,80}$`. It registers `--unattended --pilot-all --desk=online --max-agents={2} --model={3}` |
| | **Cap.** `-Register` refuses `-MaxAgents` above 1 (Q2) |
| | **Clean checkout.** `-Register` refuses when `git -C $Root status --porcelain` prints anything, or when `git` is missing, and prints `$Root` and `HEAD`. Eric runs it from the dedicated runner worktree (§6, R0), never the interactive checkout. The task's working directory is that worktree (`$Root`, `:62`) |
| | **`-Status`** adds `unattended`, `model_named` (a boolean, never the value), `checkout_head` and `checkout_clean` |
| | Its header comment (`:1-50`) is updated to match |
| `dashboard/core/pilot-sighting.js` | **Desk cap (E4/S1).** `DESK_MAX_AGENTS = 1` (Q2). `staleAfterMin(declared)` uses `Math.min(declared ?? 1, DESK_MAX_AGENTS)`, so it is 120 min whatever the runner declares |
| | **`view`** keeps `max_agents` as declared and adds `desk_max_agents`. A declaration above the cap appends: "The runner declared N agents, above the desk's cap of 1; STALE stays at 120 min." The stored record format (`cr-pilot-sighting@1`) is unchanged |
| Tests (new `dashboard/tests/pilot-revision-guard.test.js`; updates to `pilot-healthchecks.test.js`, `pilot-liveness.test.js`, `pilot-host-recovery.test.js`) | **Revision guard.** (1) A fictional `/healthz` with a different SHA: exit 1, health `failure`, zero poll, claim and session calls, no lock file. (2) A dirty fictional checkout: refused the same way. (3) `/healthz` 503 or no revision line: refused. (4) Matching and clean: the run proceeds to the poll. (5) `RENDER_GIT_COMMIT` set and matching: it proceeds without calling `git` |
| | **Heartbeat.** (6) A fetch returning 503 for both pings: `start === 'http_503'`, `final_sent === 'http_503'`, and the exit code is unchanged |
| | **Sighting.** (7) A sighting with `max_agents: 10`, 121 min old: `stale`. On `e3e017d` it reads `fresh` until 965 min, so this is the negative control |
| | **Existing tests.** Tests that run `unattended` online (`pilot-host-recovery.test.js:95`, `pilot-liveness.test.js:239-263`) get a fake `/healthz` and a fake runner revision through `runAll`'s existing dependency argument, never the real `git`. Assertions on 205 and 395 min are updated to 120 |

**Acceptance:**

- every test above passes and the suite is green;
- `pilot.js --pilot-all --desk=online --unattended --model=x --dry-run` from a dirty tree prints the refusal and exits 1.

**Out of scope:** Ops-1 files, canon text, and any change to the claim, lock or health-class logic beyond the guard.

### PR 2: `fix/honest-job-and-housekeeping-status`

**Closes A3/S3, S4/S4b, S5/E3.**

| File | Change |
|---|---|
| `dashboard/core/jobs.js` | **New status.** One new job status, `impaired`. It is deliberately **not** in `OK_STATUSES` (`:42`), so `record()` (`:139-146`) writes `last_failure_at` and `last_error` and never advances `last_success_at` |
| | **Trader case (`:217-243`).** It collects `impaired_reasons`: `mandate_sweep_failed` (`m.status === 'failed'`); `book_step_problems` (`st.problems > 0`, or `r.counts.step.problems > 0` from the candle refresh's own step at `trader-candles.js:546-548`); `accounting_unknown` (`r.accounting_unknown === true`). If any reason holds, it returns `status: 'impaired'`, `error` set to the summary's first 500 characters, and `impaired: [...]`. The work itself is unchanged: risk-reducing steps still run after a sweep failure (Codex A3 counterevidence) |
| | **Statuses that stay.** A restored copy's `held` stays `skipped` (S4b, correct). A candle `failed` stays `failed` (S4c). `held` → `skipped` now applies **only** when `!r.accounting_unknown` |
| `dashboard/core/research.js` | **Housekeeping (`:2382`, `:2385`).** The two `catch (_) {}` become captured failures: `housekeeping: [{ step: 'sweep_captures' \| 'release_stale', error }]`. Any entry makes `runDueJobs`'s status `impaired` with `error` set. A housekeeping failure still never blocks the research work after it |
| | **Release records.** `released` entries keep their record on the job (`j.released[]`, `:2533`, already written), with `from_mode`. No new file |
| `dashboard/core/desk-controls.js` | **Release row.** Per pilot project, a `research_release` fact read from the latest Claude job's `released[]` entries with `from_mode === 'cowork'`, as `{ at, idle_hours, run_id }`. Desk-wide, `released_pilot_jobs` (a count). Words: "Claude's research job on `<project>` was released from the pilot worker to manual at `<at>` after `<h>` h with no runner activity." Read only, like the other parts (`:27`) |
| `dashboard/public/desk-controls-model.js` | **Panel.** `deskRows` and `projectRows` add the release row, state word `Released to manual`, tone `warn`. Rebuild `dashboard/web` (`npm run build`) and commit `public/app` (§2, correction 5) |
| `dashboard/public/views/settings.js` | `JOB_STATE` (`:532`) gains `impaired: ['Impaired', 'bad']` |
| Tests (new `dashboard/tests/honest-job-status.test.js`; `pilot-controls.test.js`) | **Trader status.** S3: the sweep throws and candles are `ok`: `status: 'impaired'`, `error` set, `last_success_at` unchanged, `last_failure_at` set. A3: sweep throws, refresh `noop`, step throws: the same. S4: accounting unknown: `impaired`, reason `accounting_unknown`. S4b: restored copy: still `skipped` (a control). S4c: candle failure: still `failed` (a control). Each is a regression test that fails on `e3e017d` and passes after. Use the harness shape in `raw/audit-sim.js`, with fictional data only |
| | **Housekeeping.** An injected throw in `sweepCaptures` and in `releaseStaleAssistantJobs` appears in job state as `impaired` with the step named |
| | **Release.** A `cowork` pilot job idle 24 h appears on `GET /api/desk/controls` as `research_release`. Also **pin correction 4**: after release, does `tickets.pilotQueue` still return `research` for the enrolled project, and do the worker's `prepare` and `complete` accept the `manual` job? Record the answer in the test name |
| | **If the pinned answer is "stranded":** stop and report to Eric before changing release behavior. Exempting pilot jobs from release is a design change, not part of this PR |
| | `brief-daily` flags an `impaired` trader job as failing (`brief-daily.js:36`) |

**Acceptance:** the suite is green, including `web-app.test.js` with the rebuilt bundle. Each new failing-before test is named in the PR body.

**Out of scope:** changing what the trader does, changing the 24 h release window, and any other job's status words.

### PR 3: `docs/canon-and-one-sheet-hosts`

**Closes A7, E6, C12, C14.**

| File | Change |
|---|---|
| `docs/ONE-SHEET.md` | **Host legend,** one subgraph or one table under the diagram, one line per host: **GitHub Actions** (scout-cron, 11:30 UTC, and the `test` check); **Render desk** (the web service and its 30-min timer: snapshot, reviews, backup, fundamentals, screening, forensics, trader, leads; the 2-min research tick); **Runner host** (PC task during B0–B3, then Ops-1 Render cron; one at a time, Q1); **PC offsite backup** (`\CryptoResearch\Hourly`, the only off-Render copy, non-critical to the lifecycle) |
| | **Status.** It names the Q1 exception (`reconcile` for Eric). It moves N4/N7 to Merged as `#161 e3e017d`. It replaces "Deployed: not verified" with the `/healthz` readback rule: deployed = `/healthz` revision, read at a stated time |
| | **Owner questions.** Q1–Q5 are answered by this blueprint |
| `dashboard/tests/one-sheet-status.test.js` | **Self-entry rule.** A Merged entry without a SHA is allowed only as `#N (this pull request)`, and only when either (a) no merge commit for `#N` is in `HEAD`'s history (its own branch, before merge), or (b) `#N` is the latest merge that touched `docs/ONE-SHEET.md` (`git log -1 --merges --format=%s -- docs/ONE-SHEET.md`, on `main` after merge). An older merged entry left without its SHA fails, so the next sheet edit backfills it |
| | **Proposed line.** Every item names a PR number or says `no pull request`. A bare label like "N4" is refused, so the history check (`:52-71`) can see every item. Both tests skip on a shallow clone, as today |
| `DESK_STATE.md` | **Header (`:3`).** "Last updated 2026-11-03". The runbook's step 3 (`:442-447`) gets the new `-Register -MaxAgents 1 -Model <id>` from the runner worktree. Step 4 names the Q5 candidate rule |
| `docs/engineering/OWNER_DECISIONS_2026-11-02.md` | **Banner (one line, at the top):** "Superseded on 2026-11-03 by `AUTONOMY_COMPLETION_BLUEPRINT_2026-11-03.md` §3, Eric's ratified answers." The body is kept as history |
| `dashboard/cli.js:114` | **Help text.** "…the desk sizes; you decide, or the paper mandate grants inside a generation you armed; paper orders only, never a real one" |
| `dashboard/core/tickets.js:2568` | **`why` text.** "The ticket waits for a PM decision: Eric's, or the paper mandate's if it is armed. Nothing for an agent to do." Check every test that matches the old words (`grep -rn "waits for Eric's PM review" dashboard/tests`) and update them in the same PR |
| `dashboard/core/grade-outcome-view.js:48` | **`NO_RATE`.** "No rate is shown before 50 closed positions in a group (Q3, 2026-11-03), and none while the execution policy is not recorded. Counts and rows only." Update the tests that match the old words |

**Acceptance:** the suite is green. In a full clone the sheet tests pass both on the branch and on the merged `main` (rule (b)).

**Out of scope:** `CONSTITUTION.md`, which is Eric's own edit (§3, still open).

### PR 4: `feat/ops1-render-cron-runbook`

**Closes A1 (definition) and E5.**

| File | Change |
|---|---|
| `docs/engineering/OPS1_RENDER_CRON.md` (new) | **The Render Cron Job specification, created SUSPENDED.** Name `cryptoresearch-runner`; same repository and `main` branch; region same as the desk; schedule `5 * * * *` (hourly at :05 UTC). Build command: `npm install -g @anthropic-ai/claude-code@<pinned version>`, plus `claude --version` echoed. Start command: `node dashboard/scripts/ops1-preflight.js && node dashboard/scripts/pilot.js --unattended --pilot-all --desk=online --max-agents=1 --model=$CR_PILOT_MODEL` |
| | **Environment, names only:** `CR_PILOT_POLL_TOKEN`, `CR_PILOT_WORKER_TOKEN`, `CR_PILOT_RUNNER_ID=render-ops1`, `CR_PILOT_MODEL`, `CR_HEALTHCHECK_URL`, `CLAUDE_CODE_OAUTH_TOKEN`. Never `ANTHROPIC_API_KEY`: `-p` would bill it (`DESK_STATE.md:172`). Never any desk secret |
| | **Not a Blueprint file.** The YAML shape is shown **inside this document only**. It is never a root `render.yaml`, so no Render Blueprint sync can create or resume the service |
| | **Healthchecks.** Period 60 min, grace 30 min |
| | **Cutover and rollback** (§6, Cutover). The reconcile exception (Q1) |
| | **UNVERIFIED items the drill must settle:** whether Render runs two instances of one cron job at once; whether a "Cancel run" kills the child `claude` process; the container's max run time; whether `.git` exists in the cron build (the guard uses `RENDER_GIT_COMMIT` either way); whether `RENDER_GIT_COMMIT` on the cron equals the web service's after the same push; the cron plan's price |
| `dashboard/scripts/ops1-preflight.js` (new) | **Read-only, and prints no values.** It checks: Node 24.x; `claude --version` runs; each required env name is present (it prints `present` or `missing` only); `CR_PILOT_MODEL` is a full model ID, not an alias (`^claude-[a-z0-9-]+$`); `pilot.js --check-isolation` passes; `/healthz` revision equals `RENDER_GIT_COMMIT`. It exits 1 on any failure, so the start command never reaches the runner |
| | **`--drill`** prints the kill and desk-down drill steps (§6, Ops-1 drill) and does nothing else |
| Tests (new `dashboard/tests/ops1-preflight.test.js`) | With fictional env and stubbed `claude` and `fetch`: a missing name exits 1 and prints the name, never a value. A model alias (`opus`) is refused. A `/healthz` mismatch is refused. A test scans the output for every fictional secret value and finds none |
| `docs/ONE-SHEET.md` | Runner-host line: "Ops-1 defined, suspended (#N, this pull request)", under PR 3's self-entry rule |

**Acceptance:** the suite is green. `node dashboard/scripts/ops1-preflight.js` on the PC, with the env names unset, exits 1 listing them as `missing`.

**Out of scope:**

- creating the Render service (Eric's act, §6);
- any change to `pilot.js` beyond PR 1;
- any scheduler for engineering. Ops-1 runs the desk's research sessions; it never builds, reviews or merges code (CLAUDE.md, Engineering).

## 5. Gates between the build and the proof

| Gate | Check | Who |
|---|---|---|
| G1 | PRs 1–4 merged in order, each with `test` green on its head | Eric |
| G2 | `/healthz` revision = the merge SHA of PR 4 (or of the last merged PR) | Eric (R0.1) |
| G3 | The PC `pilot-all` task is Disabled, the Render cron is not created or is Suspended, and admission is off, all read back | Eric (R0.2) |
| G4 | No `RECONCILE_REQUIRED` attempt and no unknown meter is open | Eric (B0) |

## 6. Operating proof runbook: R0 → B0 → B1 → B2 → B3 → cutover

**Eric runs every step. No agent does.**

- **The shell.** All commands are PowerShell on the PC unless they are marked browser (the signed-in online desk's console) or Render (the dashboard).
- **Placeholders.** `<PINNED_MODEL>` is Eric's choice of a full model ID, and it is recorded in the B0 record. `<pid>`, `<decision_id>` and the like are read from the desk, never guessed.
- **The evidence folder.** Each step's readback goes into a new folder `Documents\CryptoResearch-evidence\operating-proof-<date>\` as text. Values of secrets never go there.

### R0. Align the PC (after G1)

1. **Deployed SHA:**
   ```powershell
   $h = (Invoke-WebRequest https://cryptoresearch.onrender.com/healthz -UseBasicParsing).Content; $h
   git -C "$HOME\Documents\CryptoResearch" fetch origin
   git -C "$HOME\Documents\CryptoResearch" rev-parse origin/main
   ```
   The `revision` line must equal `origin/main`. If it does not, stop: Render has not deployed yet.

2. **Both PC tasks quiet during the swap:**
   ```powershell
   Get-ScheduledTask -TaskName 'CryptoResearch pilot-all' | Select-Object State
   Disable-ScheduledTask -TaskPath '\CryptoResearch\' -TaskName Hourly
   ```
   `pilot-all` must read `Disabled`.

3. **The dedicated runner worktree** (clean, detached at `main`). The interactive checkout stays as it is, with its edits and its stash:
   ```powershell
   git -C "$HOME\Documents\CryptoResearch" worktree add --detach "$HOME\Documents\CryptoResearch-runner" origin/main
   git -C "$HOME\Documents\CryptoResearch-runner" status --porcelain   # must print nothing
   ```
   After every later merge and deploy, refresh it. Until then PR 1's guard refuses every run (exit 1, `/1` alert), by design:
   ```powershell
   git -C "$HOME\Documents\CryptoResearch-runner" fetch origin; git -C "$HOME\Documents\CryptoResearch-runner" checkout --detach origin/main
   ```

4. **Re-register `pilot-all` from the runner worktree.** It is registered disabled. The old task was made by this script, so `-Remove` is allowed:
   ```powershell
   $r = "$HOME\Documents\CryptoResearch-runner\dashboard\scripts\pilot-task.ps1"
   powershell -NoProfile -ExecutionPolicy Bypass -File $r -Remove
   powershell -NoProfile -ExecutionPolicy Bypass -File $r -Register -MaxAgents 1 -Model <PINNED_MODEL>
   powershell -NoProfile -ExecutionPolicy Bypass -File $r -Status
   ```
   `-Status` must show `state: Disabled`, `unattended: true`, `model_named: true`, `checkout_clean: true`, `checkout_head` = `origin/main`, `launcher: job_wrapper` and `working_directory_is_repository: true`.

5. **Point `\CryptoResearch\Hourly` at `main` code, keeping the records where they are.** The workspace stays `Documents\CryptoResearch` through `CR_WORKSPACE` (`dashboard/core/workspace.js:243`). Create a wrapper **outside** the repository, at `%USERPROFILE%\.cryptoresearch\hourly-main.cmd`:
   ```bat
   @echo off
   set "CR_WORKSPACE=C:\Users\Kuaya\Documents\CryptoResearch"
   call "C:\Users\Kuaya\Documents\CryptoResearch-runner\dashboard\scripts\scheduled-run.cmd"
   exit /b %errorlevel%
   ```
   Then:
   ```powershell
   $a = New-ScheduledTaskAction -Execute 'C:\Windows\System32\conhost.exe' -Argument "--headless cmd.exe /d /c `"$HOME\.cryptoresearch\hourly-main.cmd`""
   Set-ScheduledTask -TaskPath '\CryptoResearch\' -TaskName Hourly -Action $a
   $env:CR_WORKSPACE = "$HOME\Documents\CryptoResearch"; node "$HOME\Documents\CryptoResearch-runner\dashboard\cli.js" doctor --json; Remove-Item Env:CR_WORKSPACE
   Enable-ScheduledTask -TaskPath '\CryptoResearch\' -TaskName Hourly
   ```
   - Doctor must name `Documents\CryptoResearch` as the workspace and the runner's `main` revision.
   - After the next hourly run, `Documents\CryptoResearch\logs\jobs-state.json` must show an `offsite` run at the new time. `logs\scheduler-last-run.log` is written in the runner worktree, which is git-ignored and keeps it clean.
   - **Never set `CR_WORKSPACE` at user level.** Every node process would inherit it, the test suite included.

### B0. Prerequisites and readbacks (after G2–G4)

Do `BOUNDED_PAPER_READINESS.md` B0 (`:607-653`), steps 1–7, with these changes:

1. **SHA:** R0.1 already done. Also record `git -C …\CryptoResearch-runner rev-parse HEAD`, which must be the same SHA.
2. **Admission off, read back** (browser, signed in):
   ```js
   await (await fetch('/api/desk/controls')).json()
   ```
   It must show `authority.admission.on: false`, the pause state, the mandate generation and its expiry. Account for every pilot project's claim. Any `reconcile` is Eric's to settle first.
3. **Runner dry run from the runner worktree.** Nothing is claimed. This proves the poll token, PR 1's guard, the `POST` sighting and the heartbeat:
   ```powershell
   cd "$HOME\Documents\CryptoResearch-runner"
   node dashboard/scripts/pilot.js --check-isolation
   node dashboard/scripts/pilot.js --pilot-all --desk=online --unattended --model=<PINNED_MODEL> --max-agents=1 --dry-run
   ```
   The output must show the matching `revision`, the pre-poll list and exit 0. Then make a negative check: edit one tracked file, rerun, see the refusal and exit 1, and run `git checkout -- .`.
4. **Heartbeat.** Create the Healthchecks check (period 60 min, grace 30 min, alerting Eric only). Set `CR_HEALTHCHECK_URL` for this shell only. Never print it. A dry run sends no ping, so the first real ping comes from B1's run.
5. **Meters and doctor** as in readiness B0 step 5, online through Preferences > System. Read the candle meter on Research > Outcomes > Trader's Paper Book.
6. **The canary candidate (Q5).**
   - Read NMR's contract verdict on its Forensics tab.
   - If it is held on CG-21/CG-23, choose a clean-contract candidate already on the desk, for example Uniswap, or Raydium if it is on the desk. Record its stored chain, contract and CoinGecko ID.
   - Never a vetoed or held asset.
7. **`arm-desk` review:**
   ```powershell
   node dashboard/cli.js arm-desk --desk=online --dry-run --mandate-days=7 --intent-life=4320
   ```
   Compare every printed value with the desk's current settings. Eric applies only what he approves. Read back the mandate generation and caps (`max_grants_per_day` 1), contract gate `enforce`, the exit-quote target and the candidate's pilot enrolment.
8. **Record.** Write `B0.txt` in the evidence folder: SHAs, `/healthz` time, controls readback, model ID, candidate identity, meter readings and dry-run output.

### B1. Pre-eligible-hour cancellation proof

1. **Enable `pilot-all`** for the supervised window only: `pilot-task.ps1 -Enable` from the runner worktree. Watch `-Status` and `%USERPROFILE%\.cryptoresearch\pilot-all.jsonl` until the candidate reaches `pm_review` and the mandate grants on a trader tick, or Eric decides himself. Then `-Disable`.
2. **Record the lineage** from `GET /api/paper/trader` (browser) as soon as the buy is acknowledged: `project → run_id/report_id → receipt_id → generation/decision_id → intent_id → client_order_id`, and the send time.
3. **The cancellation window.** The first causally eligible hour is the first hour starting at or after the send. It is read only once it has closed and 10 minutes have passed (`trader-candles`).
   - Example: a send at 14:20 UTC gives the 15:00–16:00 hour, usable at 16:10.
   - Before that time, apply one control: `node dashboard/cli.js arm-desk --desk=online --mandate-off`, which prints the console script for Eric to run, or Pause on Desk Controls.
4. **Verify after 16:10:**
   - the order reads cancelled in `GET /api/paper/trader`;
   - there is no fill and no position from it;
   - candles and the timer still advance;
   - `GET /api/desk/controls` shows the control's `done: true`.
   - The cancelled grant stays the decision in force and is never reused. It counts toward that New York day's `grants_today`.
5. **Write `B1.txt`.**

### B2. One natural mandate grant to fill, with basis verification

1. **Pick a legitimate successor** per `BOUNDED_PAPER_READINESS.md:402-425`, normally a new Claude report on the candidate. Wait for the next New York day if `MANDATE_CAP_DAY` holds. Never raise a cap.
2. **Re-arm the mandate** if B1 turned it off, through Eric's reviewed `arm-desk` patch. Re-arming revives no earlier grant.
3. **Run.** Enable `pilot-all` for the window, then disable it. The chain goes research → grade → prosecution → ticket → mandate grant → intent → order → **causal fill** on a real closed hour.
4. **Verify the basis** (browser):
   ```js
   await (await fetch('/api/research/attribution')).json()
   ```
   - The row for `<decision_id>` must show the basis state `frozen`, each named record checked by its SHA-256 (none refused), and execution read through the book, not `integrity`.
   - The execution-time facts must read `not_recorded` (Q4 = B).
   - Record the fill's price, fees, the stop's configuration and the position lineage. A field the response does not carry is recorded as UNKNOWN, never inferred.
5. **Watch risk management** on real data. Report a natural stop, target or expiry if one comes in the window; otherwise "closure pending". A held or no-trade outcome is reported as such, and the fill milestone stays unproven.
6. **Write `B2.txt`.**

### B3. Restart and idempotency

1. **With nothing newly eligible,** run the same invocation again from the runner worktree, without `--dry-run`. Then simulate a restart: run it once more.
2. **Compare before and after:** run, report, receipt, decision, intent and order IDs, fills, `sessions_today`, and the claims in `/api/desk/controls`. **No duplicate side effect and no extra session charge.**
3. **Optional, only if Eric authorizes it:** restart the Render desk (Render > Manual Deploy > "Restart service"). Repeat the comparison. If it is not done, record hosted restart as unverified.
4. **An uncertain attempt stays claimed** for reconciliation. Never release it to make the comparison pass.
5. **Write `B3.txt`.** It reports cancellation, live fill, risk reduction, closure and restart separately, each as proven, held, pending or failed.

### Ops-1 drill and cutover (after B3)

1. **Render.** Create the cron job exactly per `OPS1_RENDER_CRON.md`, then **Suspend it at once**. Enter the env values in Render only.
2. **Drill while still suspended:** click "Trigger Run" once with the PC task Disabled.
   - The preflight passes.
   - The run shows the revision match, a `POST` sighting (Desk Controls poll `Fresh`, runner ID `render-ops1`) and the heartbeat `/start` and final ping in Healthchecks with `start: sent`.
3. **Kill drill.**
   - Trigger a run that has work and cancel it mid-session.
   - The claim must stay `dispatched`, then `reconcile` on the next run (exit 3, Healthchecks `/3`). Eric reconciles it on Desk Controls.
   - Record whether the `claude` child process died; that is an UNVERIFIED item in PR 4.
4. **Desk-down drill.** Run the recovery tests on Linux (`pilot-host-recovery.test.js`). CI's ubuntu run already does, so record that run's ID. **Never point a production runner at a fake desk.**
5. **Cutover** (one scheduler, Q1):
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\Documents\CryptoResearch-runner\dashboard\scripts\pilot-task.ps1" -Disable
   ```
   Read back `Disabled`, then Resume the Render cron. Over the first 24 h, record the Desk Controls poll at about 2 h, 6 h and 24 h (it must stay `Fresh`) and the Healthchecks history.
6. **Rollback:**
   - Suspend the Render cron.
   - Only then, if needed, `-Enable` the PC task.
   - Admission off and mandate off as in `DESK_STATE.md` runbook step 6.
7. **Write `cutover.txt`.** After that, the next canon pull request moves the sheet's runner host to "Ops-1, operating since `<date>`".

## 7. What this blueprint does not do

- It adds no agent manager, queue, workflow engine, event bus, second ledger or engineering scheduler (Constitution Law 2; Codex §10).
- It never weakens a gate, raises a cap, recycles an admission slot, resubmits on a timer or fabricates an hour, a successor or a fill.
- It never changes the nine protected files.
