# Engineering worker daemon: unattended builds of delegated tasks (2026-10-26)

Eric's direction (2026-10-26): admitted tasks should not wait for someone to open Claude Code and paste the worker prompt. A daemon on his PC polls the desk, claims tasks admitted under his delegations, has headless Claude write the change, runs the sealed verify, pushes `claude/candidate-eng-<n>` and records every step on the desk. It stops cleanly on a timeout, a failed verify or a protected boundary.

## 1. What it is

- **A worker connection like any other.** The desk has no worker REST inbox; a worker reaches it only through `/mcp/engineering` with an OAuth grant. `npm run worker:login` registers the daemon as a program on this computer (a loopback return address), opens the consent page, and Eric approves it once as Claude, role Worker, with his passphrase. The grant can claim tasks and record build events, nothing more: it cannot authorize, review, merge, deploy or activate a delegation.
- **The daemon is the worker.** It runs every lane step itself, deterministically, through `engineering-worker.js` (already sealed, with deadlines and retries), in its own clone in the daemon home, never in Eric's checkout. Claude is used for one thing: editing files.
- **Its home** (`CR_DAEMON_HOME`, default `~/.cryptoresearch/engineering-daemon`) holds `token.json` (the grant; written with owner-only permissions, never printed or logged), `state.json` (budget, waits, backoff, last poll), `daemon.lock`, `receipts/`, `daemon.log` and `repo/` (its clone). Nothing of it is in the repository.

## 2. One pass

1. **Lock.** One daemon per home (`daemon.lock`, created exclusively; a lock whose process is gone is taken over).
2. **Select.** `engineering_capabilities` must say `worker`. From `engineering_list_tasks`, the oldest task with no live claim and no wait, whose authorization is a delegation in force from a template the daemon builds for (`CR_DAEMON_TEMPLATES`, default `eng-backend@1,eng-app@4`) and whose status needs a worker step. A task Eric authorized himself is never the daemon's.
3. **Claim.** `engineering_claim_task`. The desk's lease is the lock between runners: it is taken under the task's lock, refuses a live lease (`CLAIMED`, the daemon moves on) and bumps the generation. The phase is read again from the task the claim returns.
4. **One phase**, every step recorded with the claim token:

| Phase | When | What |
|---|---|---|
| admission | `admitted`, number unbound or bound | `numbers` from Git, `admission_number`, `admission-commit`, `remote_action` intent, compare-and-swap `push`, observed (the desk releases the claim) |
| confirm | `admitted`, pushed | `admission-status`: main holds it, `admission_confirmed` with the commit Git printed, then the build; not yet, `stopped` and a later pass; the branch gone and main without it after 15 minutes, `admission_refused`; still there after an hour, `blocked` |
| build | `claimed`, `queued`, `implementing` | below |
| finish | `verifying` (a candidate recorded, its verification lost) | the kept acceptance answer, the recorded head verified as it is, `verification`; no Claude |
| release | `ready_for_promotion` under a `promote` template after an attended review | `claude/backlog-eng-<n>` pushed with intent and observed |

**The build.**
1. A fresh checkout of main (or of the candidate head when a review asked for corrections), `started`, a heartbeat every 5 minutes against the 20-minute lease.
2. Claude edits the files (below).
3. **Rule N4.** Every changed path is checked before anything is committed: protected (`backlog-promote.js` `PROTECTED`), restricted for the template, forbidden by it, or outside the task's scope. Any one discards the whole change and records a note naming each path and why, then `blocked` (Eric decides). So does Claude's own `blocker` answer, and the desk refusing the candidate with `SCOPE`.
4. A commit (Eric's Git identity, `Engineering-Task` and `Co-Authored-By: Claude` trailers), the bundle rebuilt and committed when the app's source changed, then the sealed `verify`.
5. A failed suite, or a candidate that changes no test the template requires, gets one correction round inside the same watchdog, with the failure's output. Still failing: a note with the output, `stopped`, nothing pushed.
6. Every acceptance check must be reported met. Then `evidence`, `candidate`, the push of `claude/candidate-eng-<n>` (intent, push, observed) and `verification` with Claude's per-check answer, which stays the worker's word. The desk moves the task to `review_pending` and releases the claim; `candidate-review.yml` takes it from there.

5. **Receipt.** `receipts/<time>-<task>-<phase>.json` (`cr.worker-daemon-receipt.v1`): the task, number, generation, each step and its answer, the verify summary (head, tree, totals, exit code, output SHA-256), Claude's runs (duration, exit, timed out) and the outcome. Never a token; the diff only as its SHA on the desk.

A push whose answer was lost (`dispatch_unknown`) is read back from Git and recorded before anything else on that task.

## 3. Claude, sealed

```
claude -p --restricted --tools Read,Edit,Write,Glob,Grep --permission-mode acceptEdits
       --strict-mcp-config --mcp-config <home>/mcp-none.json --no-session-persistence --output-format json [--model $CR_DAEMON_MODEL]
```

- The prompt goes on stdin, never in the command line. `npm run worker:status` shows the daemon's state; `node dashboard/scripts/engineering-daemon.js print-command` prints this command without running it.
- `--restricted` keeps only the file tools, confined to the working directory (the daemon's clone); `--strict-mcp-config` with an empty config leaves no connector, so Claude never reaches the desk, Git, GitHub or the network.
- Its environment drops the desk's, GitHub's and every other provider's keys and tokens (`CR_*`, `GH_*`, `GITHUB_*`, `OPENAI_*`, `XAI_*`, `*_API_KEY`, `*_TOKEN`, `*_SECRET`…); Claude's own sign-in stays. The daemon's own children (Git, the suite) lose them too when it runs.
- The task (title, outcome, scope, acceptance, non-goals), review findings and test output are data between `BEGIN-…-<nonce>` and `END-…-<nonce>` lines. The answer is the JSON after `WORKER-ANSWER-<nonce>`, a marker only this run's prompt names: `summary`, `acceptance[{index, met, evidence}]`, `blocker`.

## 4. Limits and failures

- **Watchdog.** 15 minutes (`CR_DAEMON_CLAUDE_TIMEOUT_MS`) cover both of a build's Claude runs. At the deadline the whole process tree is killed (`taskkill /T /F` on Windows, the process group elsewhere), the checkout is reset, a note gives the diagnostics, then `stopped` (claim released). Nothing is pushed.
- **Budget.** At most three builds start in any rolling hour, across all tasks; admission, confirm, finish and release use no Claude and are free. `CR_DAEMON_BUDGET` can lower it, never raise it. `node dashboard/scripts/engineering-daemon.js reset` clears it and the waits. The desk's own attempt and rebuild ceilings still apply.
- **Stops.** A stale claim (another runner, or Eric paused that task) records nothing more and pushes nothing. Engineering paused for all records `stopped`, as the desk asks, and nothing more is claimed until Eric resumes it.
- **Backoff.** A pass every 30 s (`CR_DAEMON_POLL_MS`); when the desk or Git fails, the wait doubles to 15 minutes and returns to 30 s after a success. A refused access token is renewed once; a refused renewal stops the daemon with exit status 3 ("run `npm run worker:login`"), which the service templates do not restart.
- **Not in v1.** Rebuilding a passing candidate after main moves stays on the existing route.

## 5. Running it

1. Merge this pull request (every file in it is protected).
2. `npm run worker:login` and approve it on the desk as Claude, role Worker.
3. Activate a current delegation (`eng-backend@1` or `eng-app@4`) on the desk.
4. `npm run worker:daemon`, or `.\dashboard\scripts\start-daemon.ps1` (`-Background` hidden, `-AtLogon` registers a Task Scheduler entry you choose to add). `dashboard/scripts/service/` has a systemd user unit and a launchd agent as templates.

`npm run worker:status`: running or not and its process, the sign-in (expiry, never the token), the budget, the last poll, the backoff and last error, the current task and phase, the waits and the last ten receipts.

**What it costs and where it runs.** Each build spends Eric's Claude plan. The tests a candidate adds run on his PC under his account when verify runs them, as with any local builder session; the daemon's grant is worker-only. Sealing that off fully would need a VM or container.

## 6. Files

| File | What |
|---|---|
| `dashboard/scripts/engineering-daemon.js` | the command line (`login`, `run`, `once`, `status`, `reset`, `print-command`), the loop, selection, phases, budget, lock and receipts |
| `dashboard/scripts/engineering-daemon-desk.js` | the loopback OAuth sign-in with PKCE, the rotating refresh, `tools/call` to `/mcp/engineering`, refusal codes, retries after 1, 2 and 4 s where safe |
| `dashboard/scripts/engineering-daemon-claude.js` | the command, the prompt, the answer, the watchdog's process-tree kill |
| `dashboard/scripts/start-daemon.ps1`, `dashboard/scripts/service/` | Windows start and logon task; systemd and launchd templates |
| `package.json` | `worker:login`, `worker:daemon`, `worker:status` |
| `dashboard/scripts/backlog-promote.js`, `dashboard/engineering/policy.js` | the daemon's files and its test are `PROTECTED`, with samples, so no delegated task edits the builder that builds it |
| `dashboard/tests/worker-daemon.test.js` | below |

## 7. Tests

`dashboard/tests/worker-daemon.test.js`, against the real hosted desk (its OAuth sign-in, the engineering connector and the inbox) on 127.0.0.1, a FICTIONAL bare Git remote and a stand-in for Claude; no model is asked.

- **Login:** the consent approval as Eric gives it; the tokens in the daemon home; a refused access token renewed and the refresh token rotated; a refused refresh asks for a new login; the status never shows a token.
- **Selection:** the oldest task inside the daemon's delegations with no live claim; an `eng-docs@1` task, a task another worker holds, an owner-authorized task and a delegation no longer in force are left alone; the admission number from Git, the branch pushed with its entry, the receipt written.
- **Build:** committed, verified sealed, `claude/candidate-eng-<n>` pushed and recorded, the task waiting for review, the commit trailers, the receipt.
- **Watchdog:** a run that never answers is stopped with its child process; the claim released, the half-done change discarded, nothing pushed.
- **Verify:** a suite that fails after one correction is stopped with its output and nothing pushed; a correction that passes is built.
- **Rule N4:** a change reaching `dashboard/frontdoor.js` is discarded and recorded blocked with nothing committed; Claude's own blocker too; out of scope, forbidden and protected paths, the daemon's own files among them.
- **Budget:** three builds an hour, admission still runs, `reset` frees it, the limit never above three.
- **Claims and locks:** one daemon per home, a dead process's lock taken over; while one daemon builds, a second one on the same desk leaves the task alone.
- **Backoff and stops:** desk failures double the wait to the cap and a success resets it; a task paused on its own stops with nothing recorded under the lost claim; engineering paused for all records `stopped`, pushes nothing and claims nothing more.
- **The sealed harness:** the command's tools, no MCP, no shell; the keys dropped from Claude's environment; an answer under another marker is not the answer.
