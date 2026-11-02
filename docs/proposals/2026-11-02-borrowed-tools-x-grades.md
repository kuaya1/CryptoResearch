# PROPOSAL — Borrowed tools × Grades

**Status:** PROPOSAL. Design only. No code, setting, schedule or record changed. Nothing here is a decision until Eric merges it and answers §8.
**Date:** 2026-11-02 (revision 2, after review) · **Base:** `main` at `84cb28a` (PR #130) · **Author:** Claude (Claude Code session), for Eric's review.
**Revision 2 changes:**
- STALE threshold redone; worker-route sightings are now a hard prerequisite.
- The runner host label is marked NEW.
- §6 lists every new variable, rule and state.
- CONSTITUTION Q1 is answered (§6.1).
- The two Anthropic quotes are re-cited to the pages they are on.
- T1 is now open PR #131.
- Invented bands and the R-multiple are dropped or turned into Eric questions (§8.1).
- An order-life guard is added (F18).
**Question:** How do the five borrowed tools and patterns fit the desk's grades: per-model research grades, spread, how grades feed admission and mandate grants, and how outcomes should flow back to judge grades?

Citation rules: `path:line` is at `84cb28a`. A URL is a vendor fact read on 2026-11-02. **UNVERIFIED** marks anything not read in code or a primary source. The auditor's build-vs-borrow research and its Tasks 1–4 are **not in the repository**. They are cited here only as the brief that commissioned this proposal.

---

## 0. Verdicts in one table

| # | Candidate | Verdict | One reason |
|---|---|---|---|
| 1 | Render Cron Job running `pilot.js --pilot-all --desk=online` | **Adopt**, with 3 code prerequisites | The online runner already talks to the desk only over HTTPS (`scripts/pilot.js:850`, `:653`), so it needs no disk. Render guarantees one active run per cron job ([render.com/docs/cronjobs](https://render.com/docs/cronjobs)). Two things are PC-bound today: the secrets file and the pending-submission folder (`pilot.js:802`, `:833`, `:675`). |
| 2 | `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` on the cron job only, never `--bare` | **Adopt** | The launcher already passes exactly this variable and never `--bare` (`pilot.js:157`, DESK_STATE.md:171). The token "can only make model requests, so it can't … fetch claude.ai connectors" ([code.claude.com/docs/en/authentication](https://code.claude.com/docs/en/authentication), "Generate a long-lived token"), which tightens the isolation DESK_STATE.md:180 could only document. |
| 3 | Healthchecks.io dead-man's switch plus a desk "runner last polled" / STALE line | **Adopt, amended** | Exit codes alone are not enough. A session that fails (expired token, CLI error) is released `agent_failed` and the run **exits 0** (`pilot.js:761`, `:948`, `:962`), so an exit-code-only heartbeat stays green while no grade is produced. Ping `/fail` on any `agent_failed`, not only on a non-zero exit. |
| 4 | Freqtrade/Hummingbot paper-fill patterns | **REJECT as new work** (pattern already present) | Every listed pattern is already in protected `paper-trader.js`: fees (`:806`, `:990`, `:1025`), stop slippage (`:148`, `:987`), partial fills at 10% of hourly volume (`:147`, `:1013-1018`), and fills only from hours that start at or after send (`:986`). Re-adopting it would add a second fill model. |
| 5 | QuantStats-style metrics + NautilusTrader "one code path" rule, for the outcome ledger | **Pattern only, narrowed** | The book already computes realized P&L, NAV by hour, max drawdown and vs-BTC (`paper-trader.js:1077-1118`). What is missing is **per-grant attribution to each model's judgment**. Build that as a read-only module over the existing journal, with a small metric set. No Sharpe or Sortino below the sample floor. |

---

## 1. The grade pipeline as it exists (ground truth)

| Stage | What happens | Where |
|---|---|---|
| Research | Each model researches separately. The evidence packet **excludes other models' reports and scores**. | `core/research.js:870` `evidencePacket`, `:908` `excluded` |
| Per-model grade | The desk's calculated grade from each report's assessment, never the model's own total. A range stays two ends. A withheld grade is not a grade. | `core/rubrics.js:103` `gradeAssessment`; `core/report-delta.js:31` `gradeOf`; `core/compare.js:24` `latestByProvider` |
| Model spread | Claude against ChatGPT and Gemini: firm grades only, same rubric only, never averaged. | `core/spread.js:53-92` `spreadOf` |
| Ticket basis | **Only Claude's** latest eligible report is frozen into the ticket packet. ChatGPT's and Gemini's grades are not. | `core/tickets.js:250-273` `researcherOf`, `:688` packet `researcher` |
| Gate grade | A range is read at its low end. Withheld or none means no grade. | `core/tickets.js:276-283` `gateGrade` |
| Sizing gate / admission | Grade floors (`min_grade_any`, `min_grade_new_entry`), contract tier and exit proof. The result is recorded as `grade_used`. | `core/tickets.js:416-475` `gate` |
| Prosecutor spread | The receipt's `agent_disagreement` holds researcher grade, prosecutor conviction and `spread_points` (researcher minus prosecutor). | `core/tickets.js:1493-1498`; `core/spread.js:93-115` |
| Mandate grant | Tier from the receipt grade: 50–54 halve, 55+ approve, under 50 never. Candidates go highest grade first. The decision line records `grade_used`, `generation` and `policy_sha256`. | `core/tickets.js:1553-1556` `mandateTierOf`, `:2607` `mandateSweep`, `:2676` sort, `:2685` `decide`, `:1917` mandate line |
| Authority at opening | The grant's generation and policy are re-read at every opening and every hour. | `core/mandate-authority.js:264-276` `grantAuthority` |
| Paper Book fill (Trader Sim) | A v3 intent carries `thesis_id = receipt_id`, `decision_id` and `project_id`. The reservation freezes the grant, the exit cap and the venue fees. | `core/trader-desk.js:555`, `:649`; `core/paper-trader.js:796-807`, `:965-1031` `applyBar` |
| Outcome, report level | Each eligible report's return vs BTC at 30/60/90/120 days from the **run's packet time**, per model. Medians appear only from 20 matured reports. Never ranked. | `core/report-outcomes.js:21-23`, `:31`, `:95-105` `startOf`, `:108` `measure`, `:194` `byModel` |
| Outcome, PM Cohort | `cr-paper@1`: entry at the hourly price at or before the decision. **Fees and slippage unknown.** Shadow lines for $0 tickets. | `core/paper.js:16-26`, `:36` `MIN_CLOSED`, `:279` `shadows` |
| Outcome, Trader Sim | `cr-paper@3`: realized net of fees and slippage, NAV by hour, max drawdown, vs BTC. | `core/paper-trader.js:1077-1118` `results` |

**Three facts that shape everything below:**

1. **Only one model's grade acts.** Admission, sizing and mandate tier read Claude's grade alone (`tickets.js:255`, `:424-434`, `:1553`). ChatGPT's and Gemini's grades reach the trade path only as spread alerts (`spread.js:60-92`). The Prosecutor's conviction acts only through a fatal-flaw hold (DESK_STATE.md:80). So "which model's judgment is earning" has two parts: the grade that acted, and grades that were on record but not acted on.
2. **Today's outcomes are measured at signal price.** `report-outcomes` starts at the packet capture time (`:95-105`). `cr-paper@1` starts at the decision-time hourly price with unknown costs (`paper.js:16-18`). Only Trader Sim measures a realistic fill. No code joins Trader Sim results back to a grade per model.
3. **The canon does not say how a grade is scored against an outcome.** It says the opposite of a score: "not a forecast, an accuracy figure or a ranking of the models, and it changes no grade" (`report-outcomes.js:218`; also `:21-23`, `paper.js:398`). §4 therefore proposes a *descriptive* attribution and leaves the scoring rule to Eric (§8 Q1).

---

## 2. Per-candidate analysis

### Candidate 1: Render Cron Job runs `pilot.js --pilot-all --desk=online`

**a. Where it touches the grade pipeline.** At the research and Prosecutor steps only. The runner polls (`pilot.js:850` `pollOnline` → `GET /api/pilot/queue`, `frontdoor.js:182`), claims and prepares through the worker routes (`pilot.js:653` `workerCall`; `core/pilot-worker.js`), runs one `claude -p` (`pilot.js:458-475`) and posts the answer with its prompt SHA-256. The desk saves it, and the grade then exists. It never touches the gate, the mandate, the trader or outcomes; those run on the server's `trader` job timer (`core/jobs.js:233`).

**b. Does it change what a grade means, when it's produced, or who acts on it?**
- **When:** yes. Grades get produced on the cron cadence instead of only while the PC is awake.
- **Who acts on it:** no. The same desk gates act on the grade.
- **What it means:** yes, through **model drift**. The launcher passes `--model` and `--effort` from Eric's `%USERPROFILE%\.claude\settings.json` (`pilot.js:180-195`, DESK_STATE.md:171). A Render container has no such file, so an unpinned cron would grade with the CLI's default model. A grade from another model version is another judgment. Guard: set `ANTHROPIC_MODEL` on the cron job. The report already records `model_version` (`tickets.js:266`).
- **Grades while the desk shows the runner STALE:** pilot grades cannot be produced while the runner is truly not running. Grades can still arrive from other channels: Cowork or the connector, ChatGPT through its connector, or the paid-API runner (`research.js`; CLAUDE.md "Agentic desk pass"). Mandate grants on receipts already saved keep running on the server timer. The desk should show both facts: "Runner: STALE since …" and "Paper mandate: on, generation N".
- **A false STALE:** `--pilot-all` re-polls only after a whole project is done (`pilot.js:952`). For one project, `runOnline` runs up to `MAX_STEPS` = 4 steps (`pilot.js:48`, `:724`). Each step can be a synchronous session of up to `timeoutMin` = 60 minutes (`pilot.js:56`, `:466`), limited by the run's `--max-agents` budget: default 2, allowed 0–10 (`pilot.js:56`, `:69`).
  - At the default, polls can be **about 120 minutes apart** (2 × 60) while the runner is working and producing grades, plus prepare and complete overhead.
  - At `--max-agents=10` the gap can reach about 600 minutes.
  - A threshold based on polls alone is therefore wrong. Worker-route sightings are a **hard prerequisite** of the STALE line (§2 C3, F10, T3b).

**c. Grade-to-outcome loop.** No change, except that every report or receipt should carry the channel that produced it, so attribution can tell a pilot grade from a Cowork grade (`reports.js:1399` already records `channel`).

**d. Fill realism.** None.

**e. Failure modes:** F1–F7 and F10 in §5.

**f. Cost:** §6.

**Prerequisites (code in `pilot.js`, not protected):**
1. The tokens come from `secrets.json` under `os.homedir()` today (`pilot.js:802`, `:833-838`, `:642`). On cron they must come from the environment. `launchEnv` already drops every non-allowlisted variable from the session (DESK_STATE.md:172), so the session never sees them. That needs a test.
2. Pending submissions are written to `~/.cryptoresearch/pending-submissions` (`pilot.js:675`, `:770`). A cron job has no persistent disk ([render.com/docs/disks](https://render.com/docs/disks)), so on a lost `complete` the answer is gone with the container. The claim stays `dispatched` and goes to Eric's reconcile, so it is safe (nothing double-saves) but costs a session. Print the IDs and `text_sha256` only (never the claim token or text) to stdout so Render's log shows what was lost.
3. The run log `pilot-all.jsonl` (`pilot.js:804`) is also ephemeral. Render's log stream replaces it, so print the same JSON line to stdout.

### Candidate 2: `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`, cron job only, never `--bare`

**a. Touch points.** Authentication of each `claude -p` session only. It is already allowlisted in `launchEnv` (`pilot.js:157`). The probe deliberately strips it so the probe can never bill (`pilot.js:405`).

**b. Meaning, timing, actor.** No change, as long as the token belongs to Eric's subscription. The docs say "an OAuth token is tied to the subscription of the person who ran `claude setup-token`" ([code.claude.com/docs/en/github-actions](https://code.claude.com/docs/en/github-actions), "Set up for an organization"). A token whose sign-in carries no connectors also makes the connector exclusion in DESK_STATE.md:180 a property of the credential, not just of the four launch flags.

**c, d.** No effect on the outcome loop or fill realism.

**e. Failure modes.**
- **Token expires after 1 year, or is revoked.**
  - The token is "a one-year OAuth token" ([authentication](https://code.claude.com/docs/en/authentication), "Generate a long-lived token").
  - "If you authenticate with the `CLAUDE_CODE_OAUTH_TOKEN` environment variable, Claude Code keeps sending the value you set after a request fails with a 401" ([errors](https://code.claude.com/docs/en/errors), "OAuth token revoked or expired").
  - Each failed session is released `agent_failed`, still counts against the day's session ceiling (`pilot.js:634`, `:749-761`) and **exits 0**. This is F3 and F8 in §5.
- **`ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` set on the cron.** Both outrank `CLAUDE_CODE_OAUTH_TOKEN` (positions 2 and 3 against 5, [authentication](https://code.claude.com/docs/en/authentication), "Authentication precedence"), which would switch billing away from the subscription. `launchEnv` passes only allowlisted variables and neither is on the list (DESK_STATE.md:172, `pilot.js:157`). Prerequisite: a test that asserts this under a cron-shaped environment.
- **Third-party reports of 401s on freshly issued tokens.** **UNVERIFIED**, from claudeissues.com, not Anthropic. The canary run (Task 4) is what proves the token on the real CLI.

**f. Cost:** one secret with a known expiry. No vendor, no state.

### Candidate 3: Healthchecks.io dead-man's switch plus desk "runner last polled" / STALE

**a. Touch points.** The runner's start and finish (`pilot.js:863` `runAll`, `:962` exit code) and the poll route (`core/pilot-poll.js`), which is read-only and keeps its rate counts in memory (`pilot-poll.js:6-15`). It touches no grade.

**b. Meaning, timing, actor.** It changes none of them. It only states whether the grade producer is alive.

- **What the desk should show** (proposed words, rendered from an in-memory timestamp; nothing written, like `desk_status.assistants`, CLAUDE.md connector handoff):
  - "Runner: last polled 14:32 (12 min ago)"
  - "Runner: STALE, last polled 11:02 (3 h ago)"
  - "Runner: not seen since the desk restarted at 09:10." This is unknown, never fresh and never STALE.
- **Worker-route calls are sightings, a hard prerequisite.** Polls alone can be about 120 minutes apart at the default and about 600 at `--max-agents=10` (§2 C1).
  - Every accepted call is a sighting: the poll, and the worker routes `claim`, `prepare`, `complete` and `release` (`pilot-worker.js`).
  - Within a run, sessions are bracketed by `prepare` before and `complete` or `release` after. With worker sightings, the longest normal silence is one session (`timeoutMin`) or the gap between runs (the cron interval), whichever is longer.
  - T3b ships both kinds of sighting in one PR, or not at all.
- **NEW: the runner's host label.** Today the runner sends no host or User-Agent: the poll sends `authorization` and `accept` only (`pilot.js:851`), and worker calls add `content-type` only (`pilot.js:656`). Nothing records a host. T3b adds `User-Agent: cr-pilot/<CR_RUNNER_HOST>` and keeps the last value in memory beside the time.

**Amendment: why exit codes alone are not enough.** In `runAll`, a dispatch whose session failed has `row.stop = 'agent_failed'`, so its outcome is `not_dispatched` (`pilot.js:948`). The exit code is 1 only for a thrown error and 3 only for needs-Eric (`:962`). An expired token, a CLI that will not start a session, or a model error all produce exit 0 with no grade. Proposed mapping:

| Run result | Ping | Healthchecks reads |
|---|---|---|
| Start | `GET …/<uuid>/start` | Run began; grace time bounds it |
| 0, nothing failed | `…/<uuid>/0` | Up |
| 0 with a dispatch `stopped` by Eric's stop (row outcome added by open PR #131) | `…/<uuid>/0` | Up: a stop is Eric's choice, not a fault |
| 0 with any `agent_failed`, or `isolation` refused | `…/<uuid>/fail` | Down |
| 3, needs Eric (reconcile) | `…/<uuid>/3` | Down: Eric must reconcile |
| 1, error | `…/<uuid>/1` | Down |

The endpoints and the 0 = success / non-zero = failure meaning come from [healthchecks.io/docs/http_api](https://healthchecks.io/docs/http_api/). The rate limit is 5 pings a minute per check, and a run makes two. **Payload rule:** a bare GET with no body, so no project name, ID or count leaves the runner. The ping URL lives in Render's environment only. A ping failure is ignored after a timeout (5 s proposed, an invented value, §8.1) and never changes the exit code or a dispatch.

**c, d.** No effect on the outcome loop or fill realism.

**e. Failure modes:** F8, F9 and F10 in §5.

**f. Cost:** one vendor, one secret URL, one desk state (fresh / STALE / unknown). It earns its place only once the runner is off the PC. While the PC task is the runner, Eric is at the PC anyway.

### Candidate 4: Freqtrade/Hummingbot paper-fill patterns — REJECT as new work

**a. Touch points, verified line by line.** Every pattern is already in the protected Paper Book. Freqtrade is GPL, and nothing below was copied from it. These are the desk's own red-team results (DESK_STATE.md:562-570).

| Pattern | Already implemented |
|---|---|
| Fees, maker/taker, unknown refuses | `paper-trader.js:806` frozen per order; `:990` exit fee; `:1025` fill fee; DESK_STATE.md:558 |
| Slippage on stops | `STOP_SLIPPAGE_BPS` 25 (`:148`), `stopFill` (`:987`); a gap through the stop fills at the open (`:1002`) |
| Partial fills | `FILL_SHARE_MAX` 0.1 of hourly volume (`:147`, `:1013-1018`) |
| Fill on the next candle, never the signal candle | `live = b.t >= o.live_from` (`:986`); intent prices from a *closed* hour (DESK_STATE.md:604, :615) |
| Worst case within the hour | Stop taken over target (`:1001-1004`); a buy hour checks its stop, never its target (`:1029`) |

**b.** It changes nothing about grades. **c.** Nothing new. **d.** See below. **e.** None. **f.** Zero.

**d. Fill realism vs grades (the part that matters).** The realistic fill already exists. What the grade loop lacks is *using it*. Today a grade's outcome is read at signal price in two places:
- `report-outcomes` starts at the packet capture time (`report-outcomes.js:95-105`).
- PM Cohort entry is the hourly price at or before the decision, costs "unknown" (`paper.js:16-18`).

Proposal (§4): **a grade's *trading* outcome is read only from Trader Sim fills.** The other two stay, labeled "price after the report" and "PM Cohort (signal price, costs unknown)". They are never presented as what a grade earned. One gap is recorded, not fixed: `FILL_SHARE_MAX` is not frozen on the order (`paper-trader.js:806` freezes fees and stop slippage only), so the attribution snapshot records the book version (`cr-paper@3`). Any change to the constant needs a version bump through a [P] PR.

### Candidate 5: QuantStats-style metrics + "backtest and live run the same code", for the outcome ledger

**a. Touch points.** Read-only over `paper-trader.js` exports (`results` `:1077`, `intents` `:1056`, `hours` `:1068`) and `trader-desk.js` `view` (`:683`). The new module must not be inside the protected list (`tests/trader-boundary.test.js:34`).

**b.** It changes no grade, gate or decision. It changes what Eric can *see* about grades.

**c.** This is the design in §4.

**d.** Every metric is computed from fills, never from signal prices.

**The NautilusTrader rule, made local:** there is exactly one fill model, `paper-trader.js` `applyBar`. Any future replay or stress test (the Codex roadmap's AT-2, an uncommitted file in the main checkout, **UNVERIFIED** as canon) must drive `applyBar` on a scratch fictional workspace, never a second simulator. Metrics read the journal only.

**Metric set, kept small** (decimal.js `add`/`sub`/`mul`/`div`/`cmp`, `core/decimal.js:146`):
- realized net P&L in USD;
- realized P&L beside the reservation's planned loss at stop (`loss_at_stop_usd`, `paper-trader.js:799`), as two figures, not a ratio;
- hit rate;
- maximum adverse excursion from the position's hours;
- fill ratio: filled ÷ ordered;
- fill vs signal: average fill price against the packet's market price;
- holding hours;
- vs BTC over the same hours.

**R-multiple dropped from the default.** The desk has no R unit in its ticket data: "There is no '/ 1.0R', because no R unit exists in the ticket data" (DESK_STATE.md:666). The 1.0R and 0.5R in the sizing table are dollar tiers ($500, $250, DESK_STATE.md:47-48), not a per-trade risk unit. Whether to add realized ÷ planned loss at stop as a ratio is an Eric question (§8.1).

**Not adopted:** Sharpe, Sortino and Calmar. They need a return series per strategy; with mandate caps of 1 grant a day and 2 open (DESK_STATE.md:69), 20 closed trades is weeks away, and the desk's floor is 20 (`report-outcomes.js:31`, `paper.js:36`).

**e.** F11–F18 in §5. **f.** One module, one record type, one view. No vendor.

---

## 3. Grade lifecycle after these changes (one page)

```mermaid
flowchart TD
  subgraph RUNNER["Render Cron (was: Windows task)"]
    HC1["Healthchecks /start"] --> POLL["GET /api/pilot/queue<br/>(poll token from env)"]
    POLL --> CLAIM["worker claim → prepare<br/>(desk freezes prompt + SHA-256)"]
    CLAIM --> SESS["claude -p · WebSearch/WebFetch only<br/>CLAUDE_CODE_OAUTH_TOKEN · ANTHROPIC_MODEL pinned"]
    SESS --> DONE["worker complete (prompt SHA-256)"]
    DONE --> HC2["Healthchecks /0 · /fail on agent_failed · /3 · /1"]
  end
  POLL & CLAIM & DONE -. "sighting: poll + worker routes (in memory, host via User-Agent)" .-> LIVE["Desk: Runner last seen / STALE / not seen since restart"]

  subgraph GRADES["Per-model grades (never averaged)"]
    RC["Claude report → desk grade"]
    RG["ChatGPT report → desk grade"]
    RM["Gemini report → desk grade (on hold: no new jobs)"]
  end
  DONE --> RC
  COWORK["Cowork / connector / paid API"] --> RC & RG & RM

  RC & RG & RM --> SPREAD["spreadOf: gaps only, same rubric, firm grades"]
  RC --> TICKET["Ticket packet freezes Claude grade + report hash"]
  TICKET --> PROS["Prosecutor conviction (Claude, own context)"]
  PROS --> RECEIPT["Receipt: gate(grade_used) · agent_disagreement.spread_points"]
  RECEIPT --> DEC{"Decision"}
  DEC -->|Eric| D1["approve / halve"]
  DEC -->|mandate gen N, policy_sha256| D2["mandate grant (tier by grade)"]
  D1 & D2 --> SNAP["NEW: attribution snapshot<br/>(create-only, as of decided_at:<br/>each model's report+grade, spread,<br/>generation, policy hash, book version)"]
  SPREAD -.-> SNAP
  D1 & D2 --> INTENT["trader-desk v3 intent (thesis_id = receipt_id)"]
  INTENT --> BOOK["paper-trader applyBar: next-hour fill,<br/>fees, partial ≤10% vol, stop slippage"]
  BOOK --> RES["results(): realized, NAV, drawdown"]
  RES & SNAP --> ATTR["NEW: grade-outcomes (read only)<br/>per model, side by side, ≥20 closed, never ranked"]
  ATTR --> ERIC["Eric reads (Outcomes)"]
  ATTR -. "NEVER" .-x SESS
  ATTR -. "NEVER" .-x TICKET
```

---

## 4. The grade-to-outcome loop (answers c and d)

### 4.1 What "attach outcomes to each model's grade" can honestly mean here

| Judgment on record at the grant | Did it act? | What its outcome can show |
|---|---|---|
| Claude's research grade (`grade_used`) | **Yes.** It set admission and tier. | Trader Sim result of the grants it caused, split **only at bands the desk already has**: the mandate tiers 50–54 and 55+ (`tickets.js:1553-1556`, DESK_STATE.md:54-56), and by decider (Eric or mandate). Finer bands are an Eric question (§8.1). |
| Prosecutor conviction and verdict | Only through a fatal hold | Results split by verdict, and by whether the receipt's spread reached Eric's own spread-alert threshold `alerts.spread.conviction_points` (default 20, `spread.js:21`, `:28-31`; bounded in `server.js:457`). Using an alert threshold as an analysis split is this proposal's choice, so Eric confirms it (§8.1). |
| ChatGPT challenge verdict (if saved before the decision) | No, it is advisory (DESK_STATE.md:131) | Results split by the verdict the challenge saved, its own words |
| ChatGPT's and Gemini's latest eligible grades at `decided_at` | **No** | "On record, not acted on": the same grants split by whether that model's grade reached the floor the receipt froze (`sizing.min_grade_new_entry`, `tickets.js:1472`). Compared only under the same rubric, as `spread.js:70` does; otherwise "not compared" with the reason. Plus its existing price-after-report row (`report-outcomes`). |

**No threshold above is new.** Each split uses a value the desk already records or Eric already set. Every value this proposal *would* add is listed in §8.1 as Eric's.

Each row is computed separately for that model. **No figure combines two models.** Columns keep the fixed model order (`report-outcomes.js:194` `PROVIDERS.map`). No "best model" line and no sort by result.

### 4.2 The minimum record per grant: the attribution snapshot

- **Where:** a create-only file `projects/<id>/tickets/attribution/<decision_id>.json`, backed up with the project.
- **When:** written as a decision *effect* in `tickets.js` (not protected), beside the existing `effects` (`tickets.js:1985` `effectsOf`, `:2111` `reconcileEffects`).
- **What it may read:** frozen records only, never the current settings.

| Field | Source |
|---|---|
| `decision_id`, `receipt_id`, `project_id`, `decided_at`, `decided_by` (Eric or `mandate:cr-paper-mandate@1`) | decision line |
| `mandate.generation`, `mandate.policy_sha256`, `tier`, `grade_used` | **the decision line's own mandate block** (`tickets.js:1917`), never `mandateOf()` now |
| `gate.version`, `sizing` hash, `suggested_risk_usd`, `pm_approved_risk_usd` | receipt `desk` (`tickets.js:1471-1491`) |
| `models.claude`: `report_id`, `run_id`, `model_version`, `prompt_version`, `rubric_version`, `sector_profile`, `channel`, grade `{kind, value, low, high, display}`, `verdict`, `analysis_at`, `original_sha256` | receipt `researcher` plus the report (`tickets.js:1467`, `:250-273`) |
| `models.chatgpt` and `models.gemini`: same fields for each model's latest eligible report **saved at or before `decided_at`**, else `{ none: reason }` | `compare.latestByProvider` over reports filtered by `imported_at ≤ decided_at` |
| `prosecutor`: `conviction_score`, `verdict`, fatal count; `spread_points` | receipt `agent_disagreement` (`tickets.js:1493-1498`) |
| `model_spreads`: each Claude-vs-other gap or its "not compared" reason, never averaged | `spreadOf` at `decided_at` (`spread.js:53`) |
| `challenge`: ChatGPT challenge receipt ID and verdict if saved before `decided_at` | `ticket-challenges.js` |
| `signal`: packet `market` price and `captured_at`; the exit reading that capped size | packet (`tickets.js:689`); reservation `exit` (`paper-trader.js:805`) |
| `fill_model`: `cr-paper@3`, `FILL_SHARE_MAX`, `STOP_SLIPPAGE_BPS`, venue fees, lot, minimum notional; the candle pool frozen for the pair; `trader.rules.max_validity_minutes` in force (F18) | `paper-trader.js:147-148`, `:806`; `paper/candles/sources.jsonl`; `trader-desk.js:550` |
| `intent_id` (derived) | `trader-desk.js:119` `intentIdOf(decision, 'open')`, so the fill joins by ID, never by project or time |
| `snapshot_sha256`, `late: bool` | the snapshot's own canonical JSON; `late` when `reconcileEffects` completed it after a failure |

The outcome is **never stored**, which is the desk's convention (`report-outcomes.js:11-12`). A new read-only `core/grade-outcomes.js` joins snapshot → `pos-<intent_id>` in `paper-trader.results()` and the fill events.

### 4.3 How fills judge a grade (d)

- **Entry** is the average of actual fills (`paper-trader.js:1089`), never the packet or decision price. "Fill vs signal" is shown as its own column, so slippage is visible, not hidden in P&L.
- **Partial fill:** the outcome is on the filled quantity, with the fill ratio beside it. A grant that never filled is **"Not filled"**, a separate count, never a $0 result.
- **Unsettled book** (`settlementAt`, `paper-trader.js:516`): the grant's figures read "recorded balance, not settled" and are excluded from every count until settled.
- **No fill data** (no candle source, GAP, unfunded book): "—" with the book's own reason (`results().unknown`), never 0.
- **Stop exits** carry their slippage and taker fee already (`:987-992`). A realized loss larger than the planned loss at stop is real and shown as such, beside the planned figure.
- **Waiting because the order's life is too short** (F18): "Waiting: order life too short", never "Not filled".

### 4.4 No leakage: no model sees its own score while grading

Today this holds:
- The research packet excludes "other models' reports and scores" (`research.js:908`).
- The Prosecutor reads only its frozen packet (DESK_STATE.md:146).
- Local roles cannot Read `paper/` or `projects/` (DESK_STATE.md:146, `scripts/pilot-role-guard.js`).
- Online sessions have WebSearch and WebFetch only (`pilot.js` launch, DESK_STATE.md:163).
- The poll route returns codes and IDs only (`pilot-poll.js:13-15`).

Proposed invariant and its test:
- No prompt, packet, ticket prompt, challenge target or poll body may contain any attribution or outcome field.
- Add `'paper and grade outcomes'` to `excluded` (`research.js:908`).
- The outcome routes stay behind sign-in.
- Test: build every prompt for a fictional project that has snapshots and closed positions, and assert no snapshot key, `realized_pnl` or hit rate appears.

The Codex roadmap's FB-1 "bounded outcome context" is the one item that would break this. It needs Eric's explicit word (§8 Q5).

---

## 5. Failure modes and guards (e)

| # | New false, stuck or stalled state | Guard |
|---|---|---|
| F1 | Cron double run | Render keeps one active run per cron job and delays the next ([cronjobs](https://render.com/docs/cronjobs)). The desk claim gives one dispatch per project under the workspace lock (DESK_STATE.md:294). The tmp lock (`pilot.js:803`) is per-container and only covers within one run. |
| F2 | A **manual** cron trigger cancels the active run mid-session ([cronjobs](https://render.com/docs/cronjobs)) | The claim stays `dispatched` with an unknown outcome, so it goes to reconcile (exit 3 next run) and never runs twice. There is no success ping, so Healthchecks alerts after grace. Runbook: never trigger manually while a run is live. |
| F3 | OAuth token expired or revoked after 1 year: every session 401s, the run exits 0, and no grade appears | Ping `/fail` on any `agent_failed` (§2 C3). Desk STALE does *not* catch it, because the runner still polls. Calendar the expiry. A session ceiling of 6 a day bounds wasted reservations (DESK_STATE.md:278). |
| F4 | PC task and Render cron both enabled | The desk claim prevents a double dispatch, but both spend the session ceiling. Acceptance for Task 3d: `pilot-task.ps1 -Status` shows disabled before the cron is enabled. **NEW in T3b, not current behavior:** the runner sends `User-Agent: cr-pilot/<CR_RUNNER_HOST>` and the desk shows the last host seen. No host is sent or recorded today (`pilot.js:851`, `:656`). Until T3b lands, the desk cannot tell the two runners apart. |
| F5 | Unpinned model on cron (no `settings.json`) changes what a grade means | `ANTHROPIC_MODEL` is required on cron; the runner refuses to start without it when `CR_RUNNER_HOST=render`. `model_version` is in the report and the snapshot. |
| F6 | Claude Code CLI update changes flags | The preflight already fails closed with exit 1 (DESK_STATE.md:173-174). Pin the CLI version in the cron build command. |
| F7 | Lost `complete` on an ephemeral disk: answer gone | Claim → reconcile (exit 3, already the behavior). stdout carries IDs and `text_sha256` only. Nothing is saved twice. |
| F8 | Heartbeat vendor down: false "down" alert, or no alert | Pings never affect exit or dispatch (5 s timeout, ignored). Desk STALE is the independent second signal. |
| F9 | Ping URL leaked: forged "up" pings | The URL is in Render env only. Desk STALE is independent of it. |
| F10 | False STALE while the runner is working | **Polls alone fail.** Polls can be about 120 min apart at the default `--max-agents` 2 and about 600 min at 10 (`pilot.js:48`, `:56`, `:69`, `:952`), so a poll-only threshold either flags a working runner or misses a dead one for hours.<br>**Hard prerequisite:** worker-route sightings (claim, prepare, complete, release) ship in the same PR as the STALE line. With them, the longest normal silence is the longer of one session (`timeoutMin`) and the cron interval.<br>**Threshold = `timeoutMin` + cron interval + margin.** That is 60 + 30 + 30 = 120 min with the cron command passing `--timeout-min=60` explicitly. The 30-min margin is invented (§8.1). Raising `--timeout-min` on the cron requires raising the threshold in the same change.<br>After a desk restart the line reads "not seen since restart", never STALE. |
| F11 | Outcome attributed to the wrong mandate generation | The snapshot copies `generation` and `policy_sha256` from the decision line (`tickets.js:1917`), never from settings. The join is by `decision_id` → `intent_id`. Test with two generations. |
| F12 | Outcome attributed to a newer report (a new Claude report saved between ticket and fill) | The snapshot freezes the *receipt's* `report_id` and `original_sha256`, not `latestByProvider` now. Test. |
| F13 | A report quarantined or excluded after the fill | The snapshot keeps the as-of grade. The read says "since quarantined" next to it (as `checkin` does, CLAUDE.md review check-in). It is never silently dropped or regraded. |
| F14 | Unfilled, partial or unsettled grants read as $0 or as losses | Separate states: Not filled, Partial (ratio), Unsettled. Unknown is never 0 (§4.3). |
| F15 | Signal-price outcomes read as what a grade earned | Labels: "price after the report" and "PM Cohort (signal price, costs unknown)". The "earned" wording only on Trader Sim rows. |
| F16 | The snapshot write fails after the decision is recorded | It is an idempotent effect. `reconcileEffects` completes it from frozen records with as-of = `decided_at` and `late: true`. **It never blocks the trader**, and its absence reads "attribution missing". |
| F17 | Sample too small to mean anything | No median or hit rate before 20 closed per model per cell, the desk's existing floor (`report-outcomes.js:31`, `paper.js:36`). Counts only until then. |
| F18 | **An order life under about 60 min can never fill.** An order fills only from an hour that starts at or after it was sent, and an order whose life ends inside an hour expires before that hour can fill it (DESK_STATE.md:566). The adapter therefore holds the grant `waiting` rather than send an order that cannot fill (`trader-desk.js:548-552`: "A life under 60 minutes never holds a whole hour"). A waiting grant holds one of the mandate's open slots (`mandate-authority.js:61` `OPEN_PHASES` includes `waiting`; `:312-317`), so a short life stalls new grants too. | Tied to `--intent-life`: `arm-desk --intent-life` and `trader.rules.max_validity_minutes` accept 1 to 10,080 (`trader-rules.js:46`, DESK_STATE.md:235). The default is 1,440 (`arm-desk.js:13`) and the canary uses 4,320 (DESK_STATE.md:414).<br>**Guard (proposed, Eric's choice, §8.1):** refuse a life under 60 at both entry points with the book's own reason, rather than accept a value that waits forever.<br>Attribution reads such a grant "Waiting: order life too short", never "Not filled", and the snapshot records the life in force. A life from 60 to 119 fills only when sent close enough to the next hour; the adapter already waits for that moment (`trader-desk.js:552`). |

---

## 6. One-sheet cost (f), against CONSTITUTION Part 4 Q2 (`docs/CONSTITUTION.md:75`)

Each table lists everything new. "Existing" marks what the code already has. A blank is never used to hide something new.

**1. Render Cron**

| Kind | Item |
|---|---|
| Vendors | 0 new (Render already hosts the desk). +1 Render cron service and +1 bill line (per-minute pricing **UNVERIFIED**). |
| Env vars / secrets | **NEW names:** `CR_PILOT_POLL_TOKEN`, `CR_PILOT_WORKER_TOKEN` (the tokens already exist; today they are read from `secrets.json`, `pilot.js:833`, `:642`).<br>**NEW:** `CR_RUNNER_HOST=render`.<br>**Existing, now required:** `ANTHROPIC_MODEL` (allowlisted today, `pilot.js:157`).<br>**Existing:** `CR_DESK_URL` (`pilot.js:842`). |
| New rules | **NEW** refusal: with `CR_RUNNER_HOST=render` and no `ANTHROPIC_MODEL`, the runner claims nothing and exits 1.<br>**NEW** build rule: Claude Code CLI version pinned in the cron build command.<br>**NEW** command rule: `--timeout-min=60` passed explicitly (coupled to the STALE threshold, F10).<br>**NEW:** run-log line and lost-submission IDs and hashes go to stdout instead of `~/.cryptoresearch` (`pilot.js:804`, `:675`).<br>**NEW** runbook rules: PC task disabled before the cron is enabled (F4); never trigger manually while a run is live (F2). |
| Desk states | None new. The **existing** `reconcile` state is reached more often, because a lost submission no longer survives on disk (F7). |
| Removes | Dependence on the PC being awake. The `conhost` task-wrapper issue in the uncommitted Codex DESK_STATE draft. Windows Task Scheduler in operations (the code stays for local use). |
| One sheet? | Yes |

**2. setup-token**

| Kind | Item |
|---|---|
| Vendors | 0 |
| Env vars / secrets | **NEW secret:** `CLAUDE_CODE_OAUTH_TOKEN` on Render (1-year expiry). |
| New rules | **NEW:** expiry date in Eric's calendar.<br>**NEW test:** `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` never reach a session (stripping them is existing behavior, DESK_STATE.md:172). |
| Desk states | None |
| Removes | — |
| One sheet? | Yes |

**3. Healthchecks + STALE**

| Kind | Item |
|---|---|
| Vendors | +1 (Healthchecks.io) |
| Env vars / secrets | **NEW secret:** `CR_HEALTHCHECK_URL`. |
| New rules | **NEW** ping mapping: `/start`; `/0` (including `stopped`); `/fail` on any `agent_failed` or isolation refusal; `/3`; `/1`.<br>**NEW:** ping timeout, ignored on failure.<br>**NEW:** `User-Agent: cr-pilot/<host>` on every runner request.<br>**NEW:** the STALE threshold (Eric's value, §8.1). |
| Desk states | **NEW:** Runner fresh / STALE / not seen since restart, with the last host seen.<br>**NEW (vendor side):** Healthchecks up / down / late. |
| Removes | Silent runner death once off the PC. |
| One sheet? | Yes |

**4. Fill patterns**

| Kind | Item |
|---|---|
| Everything | 0. Nothing is added. |
| Verdict | **REJECT**: already built; re-adopting it adds a second fill model. |

**5. Metrics + one code path**

| Kind | Item |
|---|---|
| Vendors | 0 |
| Env vars / secrets | 0 |
| New rules | **NEW record type:** `projects/<id>/tickets/attribution/<decision_id>.json`.<br>**NEW module:** `core/grade-outcomes.js`.<br>**NEW read route:** `GET /api/research/grade-outcomes`, signed in.<br>**NEW** `excluded` entry in `research.js:908`.<br>**NEW** leakage test.<br>**NEW** "one fill model" rule for any replay.<br>**Proposed:** `max_validity_minutes` floor of 60 (F18, Eric's choice). |
| Desk states | **NEW:** attribution present / late / missing.<br>**NEW:** grant outcome filled / partial / not filled / unsettled / waiting (order life too short). |
| Removes | The unanswered "which judgment is earning", without a second simulator. |
| One sheet? | Yes |

Q3, "failure state when the network drops" (`CONSTITUTION.md:76`): every row in §5 ends in a named state (reconcile, STALE, unsettled, missing). None ends in a timeout-to-done. Q4: nothing here lets a model choose size; all of it is reads or a create-only snapshot.

### 6.1 CONSTITUTION Part 4 Q1: is the Render runner + Healthchecks "DevOps meta-tooling to manage AI agents"?

Q1 asks: "Does this directly serve the research or trading desk? (If it's DevOps meta-tooling to manage AI agents, kill it)" (`CONSTITUTION.md:74`).

**Render runner: it passes, because it moves an existing product component to another host and adds no orchestration.**
- **What the runner runs.** `pilot.js --pilot-all` runs the desk's own two agents: Agent 1 research and Agent 2 prosecution. These are North Star items 1 and 3 (DESK_STATE.md:14, :16). Their output is the grades and tickets the desk trades on paper.
- **What Law 2 and Entry 1 condemned.** They condemned agents that build the *codebase*: GitHub Actions swarms, git commits and merge loops (`CONSTITUTION.md:16`, `:56-62`). The runner builds, reviews and merges no code.
- **The scheduler is already canon.** CLAUDE.md's "never propose … scheduler or CI-orchestration work" sits in its Engineering bullet, about the retired engineering lane. The desk's own product runner already has an approved scheduler: the Windows task registered by `pilot-task.ps1`, every 30 minutes (DESK_STATE.md:406-411). Render Cron replaces that scheduler one for one.
- **It adds no agent management.** No new lease, queue or negotiation; the desk's existing claim (`cr-pilot-claim@1`, DESK_STATE.md:294) is still the only coordination. No retry logic: an uncertain outcome still goes to Eric's reconcile (DESK_STATE.md:279).
- **Where it would fail Q1.** If it ever grows auto-restart, auto-retry, auto-reconcile or a second runner for throughput, that is meta-tooling. This proposal adds none, and §5 keeps every uncertain state for Eric.

**Healthchecks: it passes narrowly.**
- **Why it qualifies.** It manages nothing. Two GETs report whether the grade producer ran. It serves the desk only indirectly: it tells Eric when grades stopped coming, which keeps the PM cards and the Paper Book outcomes he reads current (North Star item 4, DESK_STATE.md:17).
- **The condition.** It stays a dumb alarm, never wired to restart, re-dispatch or re-arm anything. An alert reaches Eric, and Eric acts.
- **The zero-vendor alternative.** The desk's own STALE line alone (T3b) also passes Q1. It covers everything Healthchecks does except push notification and the `agent_failed` case. If Eric prefers no new vendor, drop T3c and keep T3b; the `agent_failed` case then needs its own desk line ("last session failed: …") from the worker `release` outcome.

---

## 7. Ranked build order, mapped to the auditor's Tasks 1–4

Each item is one PR, `node dashboard/cli.js test` green, and Eric merges. None touches a protected file.

**T1 is open PR #131** (branch `fix/stop-halts-pilot`). It adds one shared `automationGate(ws, pid)` in `mandate-authority.js` (`cr-automation-gate@1`) that every pilot, mandate and admission path calls, including `pilot-claims.js` `claim`, `beginPreparation` and `bind`. Revision 1 of this proposal had a separate `claim()` check, which would duplicate that predicate. **It is dropped; this proposal adopts #131 as T1 unchanged.**

**Sequencing.** #131 also edits `scripts/pilot.js` (new `stopped` outcome), `pilot-worker.js`, `tickets.js` (`decide`, `mandateSweep`, `nextStep`) and `mandate-authority.js`. T3a, T3b, T3c and T4a touch the same files, so they branch from `main` *after* #131 merges. Their line citations above are at `84cb28a` and will move.

| Rank | Task | PR | Acceptance criteria | Test that proves it |
|---|---|---|---|---|
| 1 | **T1 Stop halts pilot = PR #131** (open) | No change from this proposal. | As stated in #131: a stop at claimed, preparing or dispatched means no dispatch and nothing saved; rearm is the only un-stop. | #131's `tests/stop-halts-pilot.test.js` (16 tests, including the bypass test across 13 paths). |
| 2 | **T3a Runner reads env** | `pilot.js`, after #131:<br>- `CR_PILOT_POLL_TOKEN` and `CR_PILOT_WORKER_TOKEN` read from env before `secrets.json`.<br>- Run-log line and lost-submission IDs and hashes go to stdout.<br>- **NEW:** `User-Agent: cr-pilot/<CR_RUNNER_HOST or "pc">` on every desk request.<br>- **NEW** refusal: `CR_RUNNER_HOST=render` without `ANTHROPIC_MODEL` claims nothing and exits 1. | Tokens are never printed or passed to a session. The PC path is unchanged when env is unset. | `tests/pilot-runner.test.js`:<br>- env token used;<br>- `launchEnv` output has no `CR_*`, no `ANTHROPIC_API_KEY`, no `ANTHROPIC_AUTH_TOKEN`;<br>- stdout has no token or answer text;<br>- the User-Agent is on every fake-fetch call;<br>- a missing model on render refuses before any claim. |
| 3 | **T3b Desk liveness** (needs T3a's User-Agent) | `pilot-poll.js` **and** `pilot-worker.js` (claim, prepare, complete, release) record the last accepted call's time and User-Agent host **in memory**. **Both are required; a poll-only version is not acceptable** (F10). The Daily Brief and Outcomes show fresh / STALE / not seen since restart, with the host. | Reading writes nothing. Threshold = `timeoutMin` + cron interval + margin, 120 min as proposed (Eric's value, §8.1). A restart reads "not seen". A host label appears only once a runner sent one; before that, the line says the host is unknown. | Unit:<br>- poll → fresh;<br>- a worker `prepare`, then +119 min with no poll → still fresh;<br>- +121 min after the last call of either kind → STALE;<br>- new process → not seen;<br>- two User-Agents → the last one shown;<br>- the workspace is byte-identical after reads. |
| 4 | **T3c Heartbeat** (optional; drop it if Eric prefers no vendor, §6.1) | `pilot.js`: optional `CR_HEALTHCHECK_URL`. Pings `/start`, then `/0` (also with #131's `stopped`), `/fail` (any `agent_failed` or isolation refusal), `/3` or `/1`. | Exactly two GETs per run, with no body. A failed ping changes nothing. | Fake fetch:<br>- two calls with the expected paths;<br>- `agent_failed` → `/fail`;<br>- `stopped` → `/0`;<br>- fetch throws → same exit code and dispatches. |
| 5 | **T2 Canon docs** | Record Eric's answers to §8 in DESK_STATE.md and CLAUDE.md: the attribution invariant (descriptive, per model, never ranked, never fed to a model) and the runner-host runbook. | The doc says only what code does or Eric decided. | The existing doc-assert pattern (`trader-boundary.test.js:61`) gains an assertion for the no-leakage line. |
| 6 | **T4a Attribution snapshot** | `tickets.js` decision effect writes `attribution/<decision_id>.json` (§4.2). It must land **before** the canary's first grant. | Create-only and idempotent. Built from frozen records only. Never blocks the trader. `late` when reconciled. | Fictional desk: a mandate grant under generation 1 → snapshot has gen 1 and its policy hash. Re-arm to gen 2 → unchanged. A newer Claude report saved after the decision → snapshot keeps the receipt's report. Failure injected → `reconcileEffects` writes `late: true`. The prompt-leakage test from §4.4. |
| 7 | **T3d Runner off PC** (operations, no code) | Disable the PC task (`pilot-task.ps1 -Disable`, then `-Status`). Create the Render Cron:<br>- pinned Claude Code version;<br>- `ANTHROPIC_MODEL`, `CR_RUNNER_HOST=render`, the tokens, `CLAUDE_CODE_OAUTH_TOKEN`, `CR_HEALTHCHECK_URL`;<br>- command `--pilot-all --desk=online --max-agents=1 --timeout-min=60`;<br>- schedule every 30 min. | One `--dry-run`, then one run with `--max-agents=1`. The desk shows "last polled … host render". Healthchecks shows up. | The run's stdout JSON line, the desk liveness line, and the Healthchecks event list, attached to the PR or ops note. |
| 8 | **T4 Live paper canary** (operations, per DESK_STATE.md:412-418) | Numeraire canary under Eric's arming. | Lineage run → report → ticket → receipt → grant → **snapshot** → intent → order, by IDs. A fill only if the market gives one. | The IDs, plus the snapshot's `snapshot_sha256` re-verified on read. |
| 9 | **T4b Grade outcomes view** | `core/grade-outcomes.js` (read only) plus a section on Research > Outcomes. Can follow the first fills, since it is computed on read. | Per model side by side in fixed order. Counts before 20; the §4.3 states. No cross-model figure. | Fictional journal with fills, partial, unfilled and unsettled grants: every figure asserted to the cent with decimal.js. No row sorted by result. Unknowns read "—" with a reason. |

---

## 8. Open questions only Eric can answer (judgment calls)

1. **How should an outcome judge a grade?** The canon only says what it is *not*: not an accuracy figure, not a ranking (`report-outcomes.js:218`). **Recommended default:** descriptive tables only, per model, with no score, rank or "best model" line. Each table shows, at the desk's existing tier bands (50–54 / 55+), the realized USD beside the planned loss at stop, the hit rate and the fill ratio.
2. **Should grades that did not act get an outcome?** That means ChatGPT's and Gemini's grades and the Prosecutor's conviction, on grants that only Claude's grade caused. **Recommended default:** yes, labeled "on record, not acted on", split by whether that grade would have cleared the same floor.
3. **Which outcome is "what a grade earned"?** **Recommended default:** Trader Sim fills only. Keep "price after the report" and PM Cohort as labeled signal-price views.
4. **Pool mandate grants with Eric's own grants?** **Recommended default:** no. Separate cohorts by `decided_by`, and mandate cohorts by generation.
5. **May outcomes ever be shown to a model** (the Codex roadmap's FB-1 "bounded outcome context")? **Recommended default:** never in this phase. Make "no model sees grade outcomes" an invariant with the §4.4 test.

### 8.1 Values this proposal invents: each is Eric's to set

These are numbers, not judgment calls, so they sit outside the five questions. None takes effect without Eric's word, and each proposed default is labeled as invented.

| # | Value | Proposed default | Basis | If Eric declines |
|---|---|---|---|---|
| V1 | STALE margin (F10) | 30 min, so 120 min total with `timeoutMin` 60 and a 30-min cron | **Invented.** The 60 (`pilot.js:56`) and the 30 (DESK_STATE.md:408) are existing values. | Eric names the margin. The line still requires worker sightings. |
| V2 | Finer grade bands for Claude's grade (e.g. 55–64 / 65+) | **None.** Only the existing 50–54 / 55+ tiers. | Revision 1 invented 55–64 / 65+. No canon backs them, so they are dropped. | — |
| V3 | Ratio of realized P&L to planned loss at stop ("R-multiple") | **Not shown.** Two USD figures side by side. | Revision 1 invented it. DESK_STATE.md:666 says no R unit exists in ticket data. | — |
| V4 | Split the Prosecutor outcomes at `alerts.spread.conviction_points` | Use Eric's existing alert threshold (default 20, `spread.js:21`) | The threshold is Eric's; using it as an analysis split is new. | Show verdicts only, with no spread split. |
| V5 | Heartbeat ping timeout | 5 s | **Invented.** It only bounds how long the runner waits for the vendor. | Any value; it never affects a dispatch. |
| V6 | Minimum order life (F18) | Refuse under 60 min in `arm-desk --intent-life` and `trader.rules` | **Derived** from the book's rule (DESK_STATE.md:566, `trader-desk.js:552`). Refusing instead of waiting is new. | Keep accepting 1–10,080; attribution says "Waiting: order life too short". |
| V7 | Claude Code CLI version and `ANTHROPIC_MODEL` on the cron | The version and model Eric runs on his PC today | Eric's settings (`pilot.js:180-195`). The proposal names no model. | — |

The sample floor of 20 (`report-outcomes.js:31`, `paper.js:36`), the mandate tiers (`tickets.js:1553`) and the receipt's frozen grade floor (`tickets.js:1472`) are existing values, not inventions.

---

## Sources

- Render cron jobs, single active run, manual trigger cancels: https://render.com/docs/cronjobs
- Render disks, not available to cron jobs: https://render.com/docs/disks
- Claude Code authentication (one-year token, "can only make model requests", `--bare`, "Authentication precedence"): https://code.claude.com/docs/en/authentication
- Claude Code GitHub Actions ("an OAuth token is tied to the subscription of the person who ran `claude setup-token`", "Set up for an organization"): https://code.claude.com/docs/en/github-actions
- Claude Code error reference ("keeps sending the value you set after a request fails with a 401", "OAuth token revoked or expired"): https://code.claude.com/docs/en/errors
- Open PR #131, Task 1 (`automationGate`): https://github.com/kuaya1/CryptoResearch/pull/131
- Healthchecks.io Pinging API (`/start`, `/fail`, `/<exit-status>`, rate limit): https://healthchecks.io/docs/http_api/
- Third-party 401 reports on setup tokens (**UNVERIFIED**, not Anthropic): https://claudeissues.com/issue/84903-claude-code-oauth-token-from-claude-setup-token-returns-401-invalid-bearer-token
