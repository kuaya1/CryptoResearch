# Ops-1: the runner as a Render Cron Job

**Status: defined, not created.** This file is the specification of the one production runner Eric ratified on 2026-11-03 (`AUTONOMY_COMPLETION_BLUEPRINT_2026-11-03.md` §3 Q1, §4 PR 4). Eric creates the service himself, **suspended at once**, and resumes it only at the cutover (§6 below). Nothing in this repository creates, resumes or triggers it.

**Not a Blueprint file.** The YAML shape below lives in this document only. It is never committed as a root `render.yaml`, so no Render Blueprint sync can create or resume the service (`dashboard/tests/ops1-preflight.test.js` checks both).

Ops-1 runs the desk's research and Prosecutor sessions, one at a time. It never builds, reviews or merges code (`CLAUDE.md`, Engineering).

## 1. The service

| Field | Value |
|---|---|
| Type | Cron Job |
| Name | `cryptoresearch-runner` |
| Repository and branch | `kuaya1/CryptoResearch`, `main` (the desk's own) |
| Region | the desk's region (read it on the desk's service page) |
| Runtime | Node, 24.x (`package.json` `engines`) |
| Schedule | `5 * * * *`: hourly at :05 UTC |
| Build command | `npm install -g @anthropic-ai/claude-code@<pinned> && claude --version` |
| Command | `node dashboard/scripts/ops1-preflight.js && node dashboard/scripts/pilot.js --unattended --pilot-all --desk=online --max-agents=1 --model=$CR_PILOT_MODEL` |
| Disk | none (a cron job cannot have one, §3) |

- **`<pinned>`** is an exact Claude Code version, never `latest`. Use the version the PC runner passed B0–B3 with (`claude --version`; on 2026-11-03 the PC read `2.1.317`). A new version is changed only together with one drill run (§5.1).
- **The command fails closed.** `ops1-preflight.js` exits 1 on any failed check, so `&&` never reaches the runner. `pilot.js` then applies its own revision guard (PR 1, #163) before any poll.

## 2. Environment (names only)

| Name | Value, entered by Eric in Render only |
|---|---|
| `CR_PILOT_POLL_TOKEN` | the poll bearer whose SHA-256 is the desk's `CR_PILOT_POLL_TOKEN_SHA256` |
| `CR_PILOT_WORKER_TOKEN` | the worker bearer whose SHA-256 is the desk's `CR_PILOT_WORKER_TOKEN_SHA256` |
| `CR_PILOT_RUNNER_ID` | `render-ops1` (the preflight refuses any other) |
| `CR_PILOT_MODEL` | a full pinned model ID, `^claude-[a-z0-9-]+$`, never an alias |
| `CR_HEALTHCHECK_URL` | the Ops-1 check's ping URL (§4) |
| `CLAUDE_CODE_OAUTH_TOKEN` | Eric's subscription sign-in token for Claude Code |

- **Set by Render, not by Eric:** `RENDER_GIT_COMMIT`, "The commit SHA for a service or deploy" (§3). The preflight requires it and refuses one that is not 40 characters.
- **Never set:** `ANTHROPIC_API_KEY` (`claude -p` would bill it instead of the subscription, `DESK_STATE.md`; the preflight refuses a host that has it), any desk secret (passphrase, ingest key, provider keys, Supabase), and `CR_WORKSPACE`.
- **Never printed.** The preflight prints `present` or `missing` for each name and redacts every secret's value from every line; `pilot.js` never prints the heartbeat URL or a token.

### The YAML shape (this document only)

```yaml
# Shape only. Never commit this as render.yaml: a Blueprint sync could create or resume the service.
services:
  - type: cron
    name: cryptoresearch-runner
    runtime: node
    repo: https://github.com/kuaya1/CryptoResearch
    branch: main
    region: <the desk's region>
    schedule: "5 * * * *"
    buildCommand: npm install -g @anthropic-ai/claude-code@<pinned> && claude --version
    startCommand: node dashboard/scripts/ops1-preflight.js && node dashboard/scripts/pilot.js --unattended --pilot-all --desk=online --max-agents=1 --model=$CR_PILOT_MODEL
    envVars:
      - key: CR_PILOT_POLL_TOKEN
        sync: false
      - key: CR_PILOT_WORKER_TOKEN
        sync: false
      - key: CR_PILOT_RUNNER_ID
        value: render-ops1
      - key: CR_PILOT_MODEL
        sync: false
      - key: CR_HEALTHCHECK_URL
        sync: false
      - key: CLAUDE_CODE_OAUTH_TOKEN
        sync: false
```

## 3. Render's cron platform (cited, read 2026-11-03)

Each line quotes `https://render.com/docs/cronjobs` unless it names another page. The pages show no "last updated" date.

- **One run at a time.** "Render guarantees that at most one run of a given cron job is active at a given time." ("Single-run guarantee")
- **A long run delays the next.** "Render _delays_ the next scheduled run until the active run finishes." ("What if a run is currently active at the time of the next scheduled run?")
- **A 12-hour ceiling.** "Render stops an active run after 12 hours." ("What if my run never finishes or takes a very long time?")
- **UTC.** "All day and time ranges use UTC." ("Setup", Schedule)
- **A manual run cancels the active one.** "If you manually trigger a cron job run while _another_ run is active, Render first _cancels_ the active run." ("Manually triggering a run")
- **No disk.** "Cron jobs can't provision or access a persistent disk."
- **The commit.** `RENDER_GIT_COMMIT`: "The commit SHA for a service or deploy." (`https://render.com/docs/environment-variables`, "Default Environment Variables", "All runtimes")

What these mean for Ops-1:

- Render itself never overlaps two Ops-1 runs. `pilot.js`'s lock file is per container and guards nothing across runs; the desk's claims (`pilot-claims.js`) are the cross-host guard, as on the PC.
- A run that outlasts the hour delays the next one; it is never skipped into a second run beside it. The 12-hour ceiling is far above one session's 60-minute timeout at `--max-agents=1`.
- The container keeps nothing between runs. A session answer the runner could not deliver is lost with the container: that is the Q1 accepted exception (§6).

## 4. Healthchecks

- **One check for Ops-1:** period **60 minutes**, grace **120 minutes**, alerting Eric only.
- **Why 120.** A run may take 95–110 minutes (the desk's STALE rule budgets 95 minutes per agent plus 15), and Render delays the next scheduled run until it finishes (§3). A 30-minute grace would alert on a healthy long run.
- **Pings,** sent by `pilot.js` on a run without `--dry-run`: `/start`, then one final ping by the run's health class: ok and idle `/0`, attention `/fail`, failure `/1`, reconcile `/3`. A ping that fails changes nothing.
- **The preflight sends none.** A host refused by the preflight never starts the runner, so Healthchecks sees no ping for that hour and alerts after the grace.

## 5. Drills (the cron job SUSPENDED, the PC `pilot-all` task Disabled)

`node dashboard/scripts/ops1-preflight.js --drill` prints the same steps and does nothing else.

### 5.1 First run

Click **Trigger Run** once ("Manually triggering a run"). It must show:

- every preflight line `ok`;
- the revision match line from `pilot.js`;
- a `POST` sighting: Desk Controls reads the poll `Fresh` with runner ID `render-ops1`;
- Healthchecks shows the `/start` and the final ping, and the run log says `start: sent`.

### 5.2 Kill drill

1. Make sure exactly one pilot project has work (a research or ticket step), then **Trigger Run** once.
2. When the run log shows the session started (a claim taken and dispatched), stop that run with **Trigger Run** again, which cancels the active run first (§3).
3. The claim's dispatched life is **90 minutes** (`dashboard/core/pilot-claims.js` `TTL_MS`):
   - a run that polls **before** 90 minutes from the claim sees the project held: outcome `not_dispatched`, stop `claimed`, health attention, exit 0, Healthchecks `/fail`. The run started in step 2 is this run;
   - the **first run after** 90 minutes sees `reconcile`: exit 3, Healthchecks `/3`, and "Needs Eric" for that project.
4. **Pass condition for the cancelled child** (the `claude` session). Render documents `SIGTERM` and `SIGKILL` for deploys only (`https://render.com/docs/deploys`, "Graceful shutdown"), not for a cancelled cron run, so the drill judges by what reaches the desk:
   - from the cancel until the reconcile, the attempt never completes: no report or ticket receipt is saved for its attempt ID, Desk Controls keeps the claim `dispatched` with the same attempt ID, and `sessions_today` does not grow for it;
   - **any save or `complete` for that attempt after the cancel time is a FAIL**: the child outlived its run.
5. Eric reconciles the attempt on Desk Controls. Nothing re-dispatches it, times it out or resubmits it (Q1).

### 5.3 Desk-down drill

Never point a production runner at a fake desk. The desk-down cases are `dashboard/tests/pilot-host-recovery.test.js`, which CI's ubuntu run executes on every pull request; record that run's ID.

### 5.4 Still UNVERIFIED (the drills settle them; record each)

- **The cancelled child.** Whether the `claude` process dies when its run is cancelled (§5.2, step 4).
- **`.git` in the cron checkout.** Whether it exists. The guard accepts either: `render|git` with a clean tree, or `render_env_no_git` with a valid `RENDER_GIT_COMMIT`.
- **`RENDER_GIT_COMMIT`'s form.** Render does not state whether it is the full SHA, or whether the cron's equals the web service's after the same push. The preflight refuses anything but a 40-character match with the desk's `/healthz`.
- **The build's `claude` on the run's `PATH`.** Whether a global `npm install` in the build is on `PATH` at run time. The preflight's `claude --version` line fails closed if it is not.
- **Suspend, Resume and Trigger Run while suspended.** The cron page does not describe Suspend or Resume. Read the service's state back on its page after each.
- **A cancel control.** Whether there is one besides Trigger Run.
- **The price** of the cron job's instance type.

## 6. The Q1 exception, cutover and rollback

- **The accepted exception (Q1).** An ephemeral container can lose its connection before `complete`. The claim then stays `dispatched` and becomes `reconcile` (exit 3). Eric reconciles it by hand on Desk Controls (`POST /api/projects/<id>/pilot-claim/release {"reconciled":true,"attempt_id":…}`). There is no automatic re-dispatch, no time-based LOST and no blind resubmission.
- **Cutover** (one scheduler, Q1):
  1. `pilot-task.ps1 -Disable` from the runner worktree, and read back `Disabled`;
  2. only then Resume the Render cron;
  3. record the Desk Controls poll at about 2 h, 6 h and 24 h (it must stay `Fresh`, runner `render-ops1`) and the Healthchecks history.
- **Rollback:** Suspend the Render cron; only then, if needed, `-Enable` the PC task; admission off and mandate off as in `DESK_STATE.md` runbook step 6.

## 7. Hosted mission proof (after the cutover)

With the PC task Disabled and read back, Ops-1 on Render must complete **at least one real unattended lifecycle**:

1. **Researcher:** an Agent 1 report saved by an Ops-1 run (its log line names runner `render-ops1`);
2. **Prosecutor:** the Prosecutor's ticket saved on that report by an Ops-1 run;
3. **ticket receipt:** the receipt on the desk, its frozen packet intact;
4. **mandate evaluation:** on a later trader tick, the paper mandate's sweep evaluated it. That is either the mandate's grant on the ticket, or the ticket still pending after a sweep that ran. The desk's job summary gives the sweep's counts, not the rule it skipped under, so a skip is recorded as "evaluated, not granted".

**Acceptance results, each proven, pending or failed, never merged into one:**

| Result | Proven when |
|---|---|
| `host_installed` | the service exists, stayed Suspended until the cutover, and its first run (§5.1) passed the preflight and the revision match |
| `runner_alive` | over the first 24 h after the cutover, Desk Controls reads the poll `Fresh` from `render-ops1` at about 2 h, 6 h and 24 h, and Healthchecks shows no missed period |
| `lifecycle_proven` | the four steps above, all by Ops-1, with the PC task Disabled |
| `fill_proven` | a causal paper fill from that lifecycle's intent, on a real closed hour. A held or no-trade result is a correct outcome and reads "fill pending", never passed |
| `closed_outcome_proven` | that position closed by its stop, target, expiry or invalidation, fee-bearing, on the Trader's Paper Book |

A later result never stands in for an earlier one. After `lifecycle_proven`, the next canon pull request moves the sheet's runner host to "Ops-1, operating since `<date>`".
