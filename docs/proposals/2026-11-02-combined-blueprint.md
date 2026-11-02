# Combined implementation blueprint: borrowed tools × grade outcomes

**Date:** 2026-11-02 (EST). **Status:** design only; no code. **Supersedes:** PR #132 (Codex, base) and PR #133 (Claude, grafts).
**Repo state read:** `main` at `84cb28a`; PR #131 head `71c4c1a` (open). Citations are `path:line` at `84cb28a` unless marked `#131`. Lines in `pilot-claims.js`, `pilot-worker.js`, `mandate-authority.js` and `tickets.js` move when #131 merges, so re-verify at current main before acting. Anything marked **UNVERIFIED** was not confirmed against source or vendor docs.

## 1. Decision summary

Keep the desk and borrow only a runner and a watcher. Task 1 (stop halts everything) is **done by PR #131**, which is open, not merged. It covers the claimed, preparing and dispatched states (§8, row T1). Task 2 is one docs-only canon PR. Task 3 moves the existing `pilot.js --pilot-all --desk=online` to **one Render cron service at `--max-agents=1`**. It authenticates with `claude setup-token` (`CLAUDE_CODE_OAUTH_TOKEN`) and a pinned `--model`, and pings Healthchecks with `/fail` whenever a session fails while the exit code still reads 0. The desk records a runner sighting only through a **narrow worker POST**; GET polling stays read-only. Task 4 freezes a **decision-time snapshot** (exact report IDs and sha256, mandate generation, book and fill-assumption version). It attributes **whole-position** outcomes in decimal USD, and its leakage tests make sure no model ever sees outcomes. There is no new npm dependency, engine, queue, MCP server or claim state. Eight numbered Eric questions (§9) gate every new threshold, schema or band.

## 2. Canon conflicts to resolve first (Task 2, docs-only, before any arming)

| # | Conflict | Lines | Resolution proposed for Eric |
|---|---|---|---|
| C1 | Scout leads are admitted "only by Eric's click", but bounded auto-admission exists | `CLAUDE.md:36` vs `DESK_STATE.md:322`, `dashboard/core/lead-admission.js:2-13` | CLAUDE.md states auto-admission within caps under Eric's arming |
| C2 | Invariant: "Eric's grants route to it, and nothing else does", but mandate grants route too | `DESK_STATE.md:465` vs `DESK_STATE.md:54-58`, `dashboard/core/tickets.js:1882-1918` | Reword: Eric's grants, or grants under an active, expiring mandate he armed |
| C3 | "The pilot ignores an autonomy stop" | `DESK_STATE.md:392` | Removed by #131. If #131 does not merge, this line stays true and Task 3 must not start |
| C4 | #131 makes a PM veto or Undo also stop research sessions, which no canon says yet | #131 body "Residuals" | CLAUDE.md latch text covers pilot, mandate and admission alike; rearm is the only un-stop |
| C5 | No one-sheet state diagram exists (CONSTITUTION Part 4 Q2) | `docs/CONSTITUTION.md:75` | The same docs PR commits §7 of this doc as the sheet |

`package.json:4` (server has no npm dependencies) is consistent with every choice here and needs no change.

## 3. Candidates: adopted, pattern-only, rejected (CONSTITUTION Part 4, `docs/CONSTITUTION.md:74-77`)

Q1 asks whether a candidate directly serves the research or trading desk, and says to kill anything that is DevOps meta-tooling to manage AI agents. Q2 asks whether it fits on one sheet, Q3 asks what fails when the network drops, and Q4 asks whether the math is deterministic.

| Candidate | Verdict | Q1 (serve the desk?) | Q2 one sheet | Q3 network drop | Q4 deterministic |
|---|---|---|---|---|---|
| Render Cron running existing `pilot.js` | **ADOPT, gated** (cutover drill first) | **Yes.** The research agents are the desk's producers (Agent 1/2, `DESK_STATE.md:14-17`). Today grades stop whenever Eric's PC sleeps, and cron is only the clock for the existing command. It adds no orchestration, queue or agent manager. **Cut if** it ever needs a new lease, queue or auto-retry agent. | +1 Render service (existing vendor) | Run dies → claim expires or reads reconcile → exit 3 next run. No timer writes LOST (`docs/CONSTITUTION.md:37-38`) | n/a (no math) |
| `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` | **ADOPT** | **Yes.** It is the documented headless credential for the research sessions themselves. | +1 secret | 401s every session → F3 | n/a |
| Healthchecks.io (`/start`, `/0`, `/fail`, `/1`, `/3`) | **ADOPT, narrow** | **Yes, narrowly.** It is the only alert when grades silently stop: agent_failed exits 0 (`dashboard/scripts/pilot.js:749-761`, `:948`, `:962`) and the desk's STALE line cannot see it (F3). **Cut if** it grows beyond 2 pings per run or any desk data. | +1 vendor, +1 secret URL | Ping fails → ignored, 5 s timeout; missed pings → Healthchecks itself alerts | n/a |
| Narrow worker POST "poll" sighting | **ADOPT, narrow** | **Yes.** Eric needs to read "research is flowing / STALE" on the desk in his few minutes a day (`DESK_STATE.md:14-17`). It is a desk view, not agent management. **Cut if** it needs a new token or state. | +1 worker op, +1 bounded record | No POST → sighting ages → STALE (honest) | Server clock only |
| Freqtrade / Hummingbot fill models | **PATTERN ONLY** (checklist; no code, Freqtrade GPLv3 not re-fetched, UNVERIFIED) | Only as a checklist against our own fills (§4.4) | 0 | n/a | n/a |
| QuantStats / Nautilus metrics, parity | **PATTERN ONLY** (definitions only; Nautilus page not fetched, UNVERIFIED) | Yes, as definitions for §4.3 | 0 | n/a | decimal.js only |
| CCXT, Alpaca/Hyperliquid/CCXT MCP, claude-code-action, Temporal/Trigger.dev, runtime data MCPs | **REJECT** | Custody surface, live-money switch, merge authority (Law 1), or a second state machine | — | — | — |

Freqtrade's documented backtest **assumes no slippage** for in-range fills. Importing it would make fills less realistic than ours (`DESK_STATE.md:558`; `dashboard/core/paper-trader.js:148`, `:987`).

## 4. Grade-to-outcome design (Task 4)

### 4.1 Decision-time snapshot (closes the `reportsOf` temporal leak)
`report-outcomes.reportsOf` picks the **latest** save or revision per run and provider (`dashboard/core/report-outcomes.js:78-94`). `startOf` keeps the original packet's T0 (`:95-105`). Joined to a fill, that pairing would credit a decision to a report revision written after it. **Rule:** attribution never calls `reportsOf`. Each decision writes one create-only snapshot as a decision effect (the same effect path as `tickets.js:1985`; a late write is repaired by `reconcileEffects`, `tickets.js:2111`):
`projects/<id>/tickets/attribution/<decision_id>.json`, with these proposed fields (Eric Q4):
`decision_id, decided_at, decided_by (eric | mandate:cr-paper-mandate@1), mandate_generation, agent1_report_id + sha256, agent2_receipt_id + sha256, rubric version, grade as recorded (range, never a midpoint: dashboard/core/scoring.js:2-8), ticket_id, intent_id, book version (paper-trader engine commit + rules hash), fill assumptions {fee rates, STOP_SLIPPAGE_BPS, FILL_SHARE_MAX, intent life}`.
A newer report, generation change or quarantine never rewrites a snapshot; it starts a new cohort (F11-F13).

### 4.2 Attribution
- Unit = one **whole position**: exits fill the whole position (`dashboard/core/paper-trader.js:92-94`). Only entries can fill partially (`:1013-1018`).
- Outcome = executed exit proceeds − executed entry notional − entry fee − exit fee. Slippage is never charged twice, because it is already in the fill price.
- **Example (fixture, not an observed trade).** An order signals $10 × 100 units, and only 40 fill at $10.20 (fee $0.408). The 40 close at $10.80 (fee $0.432). Net = $432 − $408 − $0.408 − $0.432 = **$23.16**. The signal-price, full-size figure of **$80** is not the outcome, and it must never be shown as one (F16).
- Unfilled, partial and unsettled positions are their own labelled rows, never zero (F14).
- Agent 1 and Agent 2 are joined separately and never averaged (`DESK_STATE.md:39`).

### 4.3 Metrics (read-only aggregator outside the protected core, `decimal.js`)
Defaults (Eric Q5-Q7):
- net realized USD, closed-position count, hit rate (closed trades, not periods);
- R-multiple versus `loss_at_stop_usd` (`paper-trader.js:796-807`), MAE, fill ratio, fill price versus signal price, holding hours, versus BTC.

**Max drawdown is absolute USD** from the book's hourly NAV, the existing `max_drawdown_usd` (`paper-trader.js:1077-1127`). Never relabel it as a percent, and never split book drawdown per model. Missing marks show as unknown. **Sample floor:** no rate is shown below 20 closed positions per cohort, mirroring `MIN_COMPARABLE = 20` (`report-outcomes.js:31`). No Sharpe or annualization exists at any n by default. **No grade bands** (Claude's "65+" band has no code backing and is dropped). Grades stay the ranges the rubric recorded, and outcomes are descriptive, never a ranking (`report-outcomes.js:218`).

### 4.4 Fill-pattern rejection (why nothing is imported)
| Borrowed idea | Already in protected core | Where |
|---|---|---|
| Fees on every fill | frozen at reservation; entry and exit fees charged; unknown fee refuses | `paper-trader.js:771-775`, `:806`, `:990`, `:1025` |
| Stop slippage and gaps | 25 bps frozen per order; gap fills adverse | `:148`, `:987`, `:1001-1004` |
| Partial fills | ≤ 10% of hour volume | `:147`, `:1013-1018` |
| Next-candle fill | only hours that start at or after send | `:986` |
| Worst case inside the hour | stop before target; no fill-hour target | `:1001-1004`; in the entry's fill hour only the stop is checked, `:1029` |

**Gap:** `FILL_SHARE_MAX` is a module constant and is **not** frozen on the reserved record (`paper-trader.js:796-807` freezes fees and `stop_slippage_bps` only). The snapshot therefore records the book version (§4.1), and any change to the constant is a `[P]` protected-core PR.

### 4.5 Order-lifetime trap (a prerequisite to any outcome)
Hours fill only if they start at or after the send (`paper-trader.js:986`). An order whose life ends before an hour's end expires before that hour is applied (`:996-999`; `DESK_STATE.md:566`). **A life under 60 min can never fill.** A life of 60-119 min fills only when it is sent close to an hour boundary. Arming accepts 1-10,080 min (`DESK_STATE.md:235`). Guard: arming refuses an intent life below a floor, enforced in the arming and rules validation, **not** in the protected core. Default floor 120 min (Eric Q3). The canary's 4,320 (`DESK_STATE.md:412-418`) passes.

### 4.6 Leakage tests (canary strings)
Insert unique canary strings into an own-model outcome record and into the other model's grade. Assert that neither appears in:
- any Agent 1 packet or prompt (the packet already excludes other models' reports: `dashboard/core/research.js:874-909`);
- the Prosecutor prompt, beyond the current frozen Agent 1 report;
- mandate, admission or rubric inputs.

Also assert that outcomes are readable only on authenticated desk routes. No model sees outcomes, ever (Eric Q8).

## 5. Liveness and Healthchecks design (Task 3)

### 5.1 Ping table (under `--pilot-all`, exit codes are only 0/1/3)
`pilot.js --pilot-all` sets the exit code from `runAll` (`:986`). It exits 1 at `:880`, `:967` and when any dispatch errored (`:962`), 3 when anything needs Eric (`:962`), and 0 otherwise (`:885`, `:901`, `:962`). The cron command never exits 2: that code exists only on the usage path, when neither `--pilot-all` nor `--project` is given (`:991`). An uncaught error exits 1 (`:1006`).
| Run result | Ping | Healthchecks reads |
|---|---|---|
| Run starts | `<url>/start?rid=<invocation>` | grace timer |
| 0 and no `agent_failed`, no isolation refusal | `<url>/0` | Up |
| 0 with any `agent_failed` (released at `pilot.js:749-761`, outcome `not_dispatched` at `:948`) **or** isolation refusal (`ISOLATION`, `pilot.js:164`) | `<url>/fail` | Down |
| 3 (reconcile or needs Eric) | `<url>/3` | Down: reconcile on the desk |
| 1 | `<url>/1` | Down |
Bare GET, no body, no desk data, 5 s timeout, failure ignored. Hourly pings stay far under the vendor's limit of more than 5 pings a minute. A #131 `stopped` outcome is Eric's own stop and exits 0, so it pings `/0`, which is correct.

### 5.2 Sighting and STALE math
- **GET stays read-only.** The poll route keeps in-memory rate buckets only (`dashboard/core/pilot-poll.js:2-15`, `:80-109`) and records nothing.
- **POST sighting.** One new worker op `poll`, under the existing worker bearer (`pilot-worker.js:43-46`, four routes today), computes the same bounded queue snapshot. Only when that succeeds does it overwrite one bounded record `{last_polled_at (server clock), runner_id, invocation_id}`. Client timestamps are ignored.
- **Display.** The desk shows disabled, recent, STALE, or unknown (absent or corrupt record).
- **Poll gap (`pilot.js`).** A run polls at start and re-polls after each project (`:952`). Sessions in one invocation share `budget = { left: maxAgents }`, with default `maxAgents 2` and `timeoutMin 60` (`:56`). Each session is killed at `timeoutMin` (`:466`). The `complete` call may retry: up to 6 attempts with a 300 s timeout each (`:682`) and 31 s of backoff between them (`:673`, `:678-700`). It never retries past the claim's expiry (`:689-691`), and a claim lasts 90 min (`pilot-claims.js:57`). So one claim, from session start to the last `complete` attempt, takes at most about 90 min. Render runs at most one active run per cron service. (That it delays the next tick behind a running run is UNVERIFIED.) So the gap between two sightings is at most max(cron interval, the claims one project holds + prepare). For hourly cron at `--max-agents=1`, that is about 65 min normally. It reaches about 95 min (one 90-min claim plus polls) only when the `complete` attempts time out: a degraded desk, where STALE is honest. At the default `maxAgents 2`, one project can hold two claims back to back. That is about 125 min normally, and up to about 185 min when both `complete` calls are slow (a first call that fails outright stops the project at reconcile).
- **Decision.** Run `--max-agents=1`, and set **STALE at 120 min** (Eric Q2). Raising `max-agents` requires STALE ≥ maxAgents × 90 + 5, one claim lifetime per agent plus polls, set by the same PR. Claude's "60-70 min gap" and its 30-min-cron 2 h formula are withdrawn.
- **Sessions per day.** The daily session ceiling of 6 (`DESK_STATE.md:278`) still caps sessions, so most hourly runs dispatch nothing and only poll.

### 5.3 Cron environment guards (grafted from #133)
- `--model=<pinned>` is required on the cron command. The launcher validates model names (`pilot.js:191`). Pin the Claude Code CLI version in the build (F5, F6).
- A test asserts that `launchEnv` passes the allowlist only (`pilot.js:152-159`, `:166-174`; `DESK_STATE.md:172`). It already does this today; the test pins it. That means `CLAUDE_CODE_OAUTH_TOKEN` and the model pass, and `ANTHROPIC_API_KEY` and every `CR_*` are stripped. The env must not contain `ANTHROPIC_API_KEY` at all, because it outranks the OAuth token (Anthropic auth docs). Never pass `--bare` (`DESK_STATE.md:171`), which does not read the token. The isolation probe already strips the token (`pilot.js:405`).
- The runner reads its poll and worker bearers from env before `secrets.json` (today home-folder only: worker `pilot.js:640-647`, poll `:831-839`). No secret is ever placed in argv or logs.
- Ephemeral disk: pending files (`pilot.js:704-775`) do not survive. stdout prints only claim IDs and `text_sha256` for a lost complete, never answer text (F7).

## 6. Failure states (merged and deduped; Codex F-numbers kept where they exist)

| ID | Failure | Guard |
|---|---|---|
| F01 | Two schedulers (cron plus PC task, or a manual run) | One production scheduler. Disable the PC task at cutover. Claim, prepare and bind are authoritative (`pilot-claims.js:131-176`). Render manual trigger cancels the active run: runbook says never trigger mid-session |
| F03 | Ephemeral answer lost after a paid session | Cutover drill (Q1). Claim stays unknown and reads reconcile, exit 3. No new paid session until Eric reconciles |
| F3 (#133) | Expired or revoked token → every session 401s, exit 0, no grade | `/fail` on agent_failed. Calendar reminder 30 days before the 1-year expiry. Session ceiling 6 bounds the waste. Desk STALE does **not** catch it |
| F5/F6 | Unpinned model or CLI drifts behaviour | `--model` required on cron; CLI version pinned in build |
| F7 | Lost complete on an ephemeral host | stdout IDs and sha256 only; reconcile |
| F09-F12 | Token leaks to desk, browser, prompts or child env | Cron-service-only secret, not an env group shared with the desk. `launchEnv` test. Probe strips the token |
| F13-F17 | False freshness (page visit, forged clock, wrong runner, failed poll) | POST-only sighting after a real queue read, server clock, unknown when corrupt |
| — | #131 `stopped` after dispatch on cron | Answer kept only in scratch (#131 `pilot.js:519` stoppedSince). On cron it is lost by design; Eric's stop wins |
| F11 | Mandate generation changes after a grant | Snapshot carries generation; new cohort |
| F12 | Newer report revision appears | Snapshot pins report ID and sha256; `reportsOf` never used for attribution |
| F13 | Quarantined or held report | Cohort excluded and labelled, never zeroed |
| F14 | Unfilled, partial or unsettled position | Own labelled rows; never zero |
| F16 | Signal-price result shown as outcome | Only executed fills ($23.16, not $80) |
| F17 (#133) | Late snapshot write | Decision effect, repaired by `reconcileEffects` |
| F19 | Fill assumption change silently reprices history | Book version and assumptions frozen in snapshot; `FILL_SHARE_MAX` change = `[P]` PR |
| F26 | Period win rate shown as trade hit rate; cash flow masks drawdown | Versioned formulas; drawdown USD book-wide only |
| F27 | Outcomes leak into a later grade | Canary tests (§4.6) |
| F28 | Rates on tiny samples | Floor 20 closed positions |
| LT | Intent life < 60 min never fills | Arming floor (Q3) |

## 7. One-sheet cost total

| Item | Added | Detail |
|---|---|---|
| Vendors | **+1** | Healthchecks (Render and Anthropic already used) |
| Services | **+1** | Render cron service; −1 PC scheduled task |
| Secrets | **+2 new** (+2 moved) | `CLAUDE_CODE_OAUTH_TOKEN`, Healthchecks ping URL. The existing poll and worker bearers move from `secrets.json` to cron env. No new bearer type |
| Env vars | **+1 name** | `CR_HEALTHCHECK_URL` (name proposed; does not exist today). Model is a `--model` flag |
| Records | **+2** | 1 create-only attribution snapshot per decision; 1 bounded runner-sighting record |
| Statuses | **+4 display labels** | runner: disabled / recent / STALE / unknown. **0** new claim, order or ticket states |
| Worker ops | **+1** | `poll` (POST) |
| npm deps, engines, MCPs, queues | **0** | |
| PRs | **#131 + 8 build + 1 design** | §8 |

## 8. Ordered build plan (one PR each; Law 3)

| # | Task | Branch | Scope | Acceptance | Proving test | Depends |
|---|---|---|---|---|---|---|
| T1 | 1 | `fix/stop-halts-pilot` (**PR #131, open**) | Done by #131: `automationGate` (`mandate-authority.js:165` #131) read at claim, beginPreparation, assertPreparing, bind, complete and `stopIfHalted`, plus nextStep, mandate and admission | Residuals only: (a) a sub-second window between the claim-lock check and the save lock; (b) stopped run or ticket stays open until rearm; (c) `--force-prosecution` blocked on a stopped project; (d) exit-quote monitor and Eric-started API research not covered; (e) veto or Undo now stops research, so Eric acknowledges this behaviour change on merge. The PR reports 1545 tests run, 1543 pass and 0 fail, run on Windows | `dashboard/tests/stop-halts-pilot.test.js` (16 tests incl. the 13-path bypass) | Eric merge |
| 2 | 2 | `docs/canon-sync-2026-11` | C1-C5; DESK_STATE header date; commit §7 as the one sheet | Every line in §2 resolved; no code | docs review; full `test` unchanged | T1 |
| 3 | 4 (prereq) | `fix/intent-life-floor` | Arming and rules refuse intent life < floor (Q3), outside the protected core | `--intent-life=59` refused with words; 4,320 accepted | new case in the arm-desk/rules tests | Q3 |
| 4 | 3 | `fix/pilot-runner-env` | bearers from env first; `--model` required when unattended online; a test pinning that launchEnv already strips `ANTHROPIC_API_KEY`/`CR_*`; stdout IDs/sha256 for a lost complete | no secret in argv, logs or child env; protected core byte-identical | extend `dashboard/tests/pilot-all.test.js` isolation tests | T1 |
| 5 | 3 | `feat/pilot-healthchecks` | §5.1 table, `CR_HEALTHCHECK_URL` optional | each row of §5.1 pings exactly once; ping failure never changes exit code | new `pilot-healthchecks.test.js` with a stub fetch: agent_failed → `/fail`, exit 3 → `/3` | 4 |
| 6 | 3 | `feat/pilot-runner-sighting` | worker op `poll`, bounded record, desk label | GET unchanged; forged clock and failed snapshot don't freshen; STALE at Q2 value | new `pilot-liveness.test.js` | 4, Q2 |
| 7 | 3 | `ops/render-cron-cutover` | runbook + disabled cron definition (UTC schedule, `--max-agents=1`, pinned CLI/model); Eric creates the service and secrets himself | dry-run on Linux passes isolation; outage/kill drill recorded; PC task disabled | drill log in the PR body (Q1) | 4-6, Q1 |
| 8 | 4 | `feat/grade-snapshot` | §4.1 snapshot as a decision effect + §4.6 canary tests | snapshot create-only, never rewritten; no canary in any packet or prompt | new `grade-snapshot.test.js`, `grade-leakage.test.js` | 2, Q4, Q8 |
| 9 | 4 | `feat/grade-outcome-metrics` | §4.2-4.3 read-only aggregator + view | $23.16 fixture exact; partial, unfilled and unknown rows labelled; < 20 shows no rate; USD drawdown | new `grade-outcome-metrics.test.js` | 8, Q5-Q7 |

Do not hold the live paper canary (B2, `docs/engineering/BOUNDED_PAPER_READINESS.md:683`) for rows 8-9. Rows 3 and 8 are enough to make its fill attributable.

## 9. Eric questions (recommended defaults)

1. **Cron answer durability.** Accept that a paid answer can be lost if the desk is unreachable until the cron run ends? *Default: yes, only after the row-7 outage/kill drill; claim reads reconcile, never auto-LOST.*
2. **STALE threshold.** *Default: 120 min at hourly cron and `--max-agents=1`; sighting record durable (one overwrite record).*
3. **Intent-life floor.** *Default: refuse < 120 min.*
4. **Snapshot fields.** *Default: the §4.1 list, create-only, one file per decision.*
5. **How an outcome judges a grade.** *Default: descriptive only; per agent, never averaged, never a rank or band; grades stay recorded ranges.*
6. **Cohort and drawdown.** *Default: cohort = mandate generation × decision-time report vector; drawdown absolute USD, book-wide only.*
7. **Sample floor.** *Default: 20 closed positions per cohort before any rate; no Sharpe.*
8. **Alerts and model blindness.** *Default: Healthchecks email to Eric only; no model, mandate, admission or rubric ever reads outcomes (canary-tested).*

## 10. What to close

Open one design-only PR with this file as `docs/proposals/2026-11-02-combined-blueprint.md`. After Eric approves it, **close both #132 and #133** as superseded, without merging. #132's content is the base here, and #133's grafts are carried. #131 stays open as Task 1, for Eric to review and merge.

## Verification log (2026-11-02)

**Main:** `84cb28a` (origin/main after `git fetch`; unchanged since the draft). **#131:** OPEN, head `71c4c1a`. §1, §2 C3 and §8 T1 already said open, so they are unchanged. Every `path:line` citation was re-read at `84cb28a`, and the lines marked #131 at `71c4c1a`.

Citations changed (old → new):
- `tickets.js:1882-1916` → `:1882-1918` (the mandate block assigns `mandateLine` at `:1917` and closes at `:1918`).
- `pilot-claims.js:131-174` → `:131-176` (`claim()` closes at `:176`).
- `pilot.js:157` → `:152-159`, `:166-174` (`:157` is one row of `ENV_KEEP`; `launchEnv` is `:166-174`). The sentence now says the allowlist already strips `ANTHROPIC_API_KEY` and `CR_*`, and that the test only pins it (§5.3, T4).
- `pilot.js:640-647` → worker `:640-647`, poll `:831-839` (`:640-647` reads only the worker token).
- §4.4 "(UNVERIFIED: `:1029`)" → verified: `:1029` checks only the stop in the entry's fill hour.

Citations added:
- §5.1: `pilot.js:986`, `:991`, `:1006`. "There is no exit 2" was imprecise. Under `--pilot-all` the codes are only 0/1/3, as the step asked to confirm. Exit 2 exists only on the usage path without `--pilot-all` or `--project` (`:991`). `--check-isolation` and uncaught errors exit 1 (`:982`, `:1006`).
- §5.2: `pilot.js:682` (300 s per `complete` attempt), `:689-691` (no retry past claim expiry), `pilot-claims.js:57` (claim TTL 90 min).
- §6: #131 `pilot.js:519` (`stoppedSince`).

§5.2 poll-gap math, recomputed from `pilot.js` at main:
- `MAX_STEPS` 4 (`:48`); `maxAgents` 2 and `timeoutMin` 60 (`:56`).
- A re-poll after each project (`:952`).
- `COMPLETE_BACKOFF_MS` sums to 31 s, so there are 6 attempts at 300 s each, cut at the 90-min claim expiry.
- At `--max-agents=1`: about 65 min normally and about 95 min degraded. These are unchanged, so STALE 120 still holds.
- At the default 2: "125-155 min" → "about 125, up to about 185 min". Two back-to-back claims can each run to 90 min.
- So the raise rule "STALE ≥ maxAgents × 60 + 60" → "≥ maxAgents × 90 + 5". No new threshold, schema or band was added.

Still UNVERIFIED:
- Freqtrade's licence and no-slippage backtest claim (§3; not re-fetched).
- The Nautilus page (§3).
- That Render delays the next cron tick behind an active run (§5.2). Its at-most-one-active-run limit and manual-trigger cancel were verified earlier.
