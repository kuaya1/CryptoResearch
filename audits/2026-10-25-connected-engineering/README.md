# Connected engineering, M0 to M4 (2026-10-25)

Eric's direction (2026-10-25, quoted by the session that started this one): implement the Connected Engineering Blueprint v1. ChatGPT is his conversational intake and independent review partner, Claude Code is the implementation worker, and Gemini takes part only when he asks. Approved tasks reach the existing Claude builder without him copying briefs or results. The direction authorizes implementation, isolated testing and reviewable PRs. It keeps his approval for protected controls, production activation and release. It does not authorize new paid services or model APIs, investment decisions, financial actions, or blanket approval of historical recommendations.

This file holds the M0 capability matrix, the contradictions found, the design as built, the file-level plan, the acceptance results and the activation steps. The hand-back at the end holds the milestone status.

## 1. M0: what exists (read on 2026-10-25)

| Area | Observed | Evidence |
|---|---|---|
| Working copy | Worktree `.claude/worktrees/connected-engineering`, branch `claude/connected-engineering`, base `2e673e8` (`origin/main`), clean | `git status`, `git rev-parse origin/main` |
| Other work in the main checkout | Uncommitted edits by another session: `.claude/commands/pilot-run.md`, `CLAUDE.md`, `DESK_STATE.md`, `dashboard/scripts/pilot.js`, `dashboard/server.js`, `dashboard/tests/guardrails.test.js`, `dashboard/tests/pilot-runner.test.js`. Left untouched; this work is on its own branch. | parent session brief, `git status` there |
| Live revision | The online desk serves `2e673e8` (started 2026-10-25 18:07 UTC) | `GET https://cryptoresearch.onrender.com/healthz` |
| Repository | `kuaya1/CryptoResearch` is **public** (`private: false`) | `gh api repos/kuaya1/CryptoResearch` |
| Repository variables | None set (`DESK_HEALTH_URL` is not set, so `backlog-pr`'s deploy check reports "not checked") | `gh api repos/.../actions/variables` → `total_count: 0` |
| Backlog | `DESK_STATE.md` "## Autonomous Build Backlog" to the end of the file, items through 62 | file |
| Scheduler | One claude.ai routine `trig_01Hw89ZHE8kWp2rQe3Kw3D26` "CryptoResearch backlog builder": cron `55 * * * *`, Sonnet 5.5, tools Bash/Read/Write/Edit/Glob/Grep, **no connectors**, no environment variables, the repository as its only source. Its prompt computes the cap and batch itself (5 items and a cap of 15 until 2026-10-29T03:00Z, then 3 and 6). | `RemoteTrigger get` |
| Prior routine prompt | Saved outside Git, SHA-256 `96452680ad156938e050b924983d20e6d7ee6ff2b001f9d3bb14109e1fd1b818` (4,631 characters), with its configuration minus the token hint | the session notes folder, `connected-engineering/routine-prior-prompt.txt` and `routine-prior-config.json` |
| Routine network | The default Trusted network does not reach onrender.com; a claude.ai connector is proxied by claude.ai and needs no allowlist | routine docs, earlier probes |
| WIP and batch calculation | `dashboard/scripts/backlog-status.js` (item 42): `status()`, `parseBacklog`, `limitsAt`; not protected | file |
| Intake | `backlog-intake.js` + `backlog-intake.yml`: an issue labelled `ready` by `kuaya1` becomes an intake PR that **Eric merges**; numbers from main and open intake branches | files |
| Promotion | `backlog-promote.js` scope → compose → promote with a compare-and-swap push and remote readback; `backlog-pr.yml` runs on a green `test` run of `claude/backlog-*`; `PROTECTED` decides what waits for Eric | files |
| CI | `test.yml` runs the full suite on every push to `claude/**` and `main` | file |
| Connector | `/mcp` (desk tools) behind OAuth 2.1 (DCR, PKCE S256) approved with Eric's passphrase; grants carry `assistant` (claude, chatgpt, gemini by redirect) and `read_only`; one resource, one scope `desk` | `dashboard/oauth.js`, `dashboard/mcp.js` |
| Durable storage | The workspace on the Render disk (`CR_DATA_DIR`), one writer, `runOp` (lock, staged files, manifest, read-back verify, recovery, idempotency records) | `dashboard/core/ops.js` |
| Backups | `exporter.js` `PACKAGE_INCLUDE` (offsite package, backups, restore) | file |
| Supervisor work | None installed. The 2026-10-25 visual proof (PR #13) and the backlog workflows are the only automation besides the routine. | repository, routine list |
| Engineering tools exposed to ChatGPT | None. The desk connector exposes research, ticket and portfolio tools only. | `mcp.js` `TOOLS` |
| Baseline suite | 930 of 931 pass; `rollback-drill.test.js` fails on this PC only (expects `release 1\n`, reads `release 1\r\n`; Git's autocrlf) | `node dashboard/cli.js test` at `2e673e8` |

## 2. Contradictions, named before changing a contract

1. **`backlog-status.js` limits are stale.** It says 9 and 3 until 2026-10-28T03:00Z, then 4 and 2 (item 42 as written). Eric's later rule, in `DESK_STATE.md` and the live routine, is 5 items and a cap of 15 until 2026-10-29T03:00Z, then 3 and 6. The live routine does not use the script, so nothing built so far was affected; the engineering worker does use it, so this branch updates the constants to Eric's current rule and its tests with them.
2. **Intake needs Eric's merge; the blueprint wants zero-click admission.** The ready-label flow is unchanged. Engineering admission is a separate, narrow path (section 4.3): it can add exactly one sanitized backlog entry whose hash the desk bound to an authorized task, and nothing else. It is only enabled when Eric merges this bootstrap PR.
3. **The routine cannot reach the desk.** It has no connector and its network does not allow onrender.com. The worker therefore reaches the inbox through a second claude.ai custom connector (`/mcp/engineering`, worker role) that Eric connects once and attaches to the routine.
4. **The repository is public.** Only sanitized scope, acceptance and the task binding (ID, version, a hash prefix) reach Git. Original instructions, approvals, evidence text and reviews stay on the desk's disk under `engineering/`, which `.gitignore` never re-includes.
5. **Ticking.** Nothing ticks backlog items automatically yet (item 46 is not built); an engineering item is done when its task reads `merged`, which the worker records from Git readback.
6. **The old routine would take an engineering item as ordinary work.** `DESK_STATE.md`'s batch rule (which the routine follows) now says engineering items are built only through the engineering lane, and `backlog-status.js` keeps them out of `next`. Even if one were built in a batch, promotion refuses it without the desk's attestation, so nothing unauthorized can land; the cost would be a batch waiting for Eric.
7. **"Authorize work conversationally" cannot mean a chat message counts as Eric's approval.** The desk cannot verify that words relayed by ChatGPT are Eric's (blueprint §4 B: no invented signed-message access). Conversational authorization is therefore a delegation: Eric activates one once in Preferences > Developer > Engineering, and from then on a task ChatGPT submits inside it is admitted with no further prompt. Anything outside it waits for one click with his passphrase. An `approved` or `authorization` field in a tool call is refused (`FORGED_AUTHORITY`).
8. **The North Star (main `19a259a`, Eric 2026-10-25): every backlog item must serve Track 2.** This lane carries whatever Eric directs, so it does not judge that rule. The submitter applies it when it prepares a task, and Eric applies it when he activates a delegation or authorizes a task. The trial task below is a one-off documentation proof of the lane itself, which Eric's direction asks for (blueprint §4, "first proof").

## 3. What is reused

- The workspace and `runOp` (one cross-process lock, staged writes, read-back verification, crash recovery, idempotency records) for every engineering write. No new store, queue, database or service.
- `oauth.js` sign-in, consent with Eric's passphrase, DCR, PKCE, refresh and revocation, extended with a second resource.
- The backlog contract on `main`, `backlog-status.js` for WIP and batch, `backlog-promote.js` compose and compare-and-swap promote, `test.yml` and `backlog-pr.yml`.
- The hourly routine as the only scheduler. No wake-up trigger (M5) is built.
- `dashboard/core/revision.js` for the running revision.
- The Preferences drawer for Eric's controls (Developer section), on the same sign-in.

## 4. Design as built

### 4.1 Connection and roles

- A second OAuth resource, `<origin>/mcp/engineering`, with its own protected-resource metadata (`/.well-known/oauth-protected-resource/mcp/engineering`). A grant is bound to one resource: a desk token is refused at `/mcp/engineering` and an engineering token at `/mcp` (401, nothing done).
- Its consent page (same passphrase) asks for one role: **Submit and review** (ChatGPT, or Claude in a chat), **Review only**, **Worker** (the builder routine) or **Read only**. The role is stored on the grant and survives refresh.

| Tool | reader | reviewer | submitter | worker |
|---|---|---|---|---|
| `engineering_capabilities` | ✓ | ✓ | ✓ | ✓ |
| `engineering_get_task`, `engineering_list_tasks`, `engineering_get_evidence` | ✓ | ✓ | ✓ | ✓ |
| `engineering_save_review` | | ✓ | ✓ | |
| `engineering_prepare_task`, `engineering_submit_task`, `engineering_request_correction`, `engineering_pause_task` | | | ✓ | |
| `engineering_claim_task`, `engineering_record_event` | | | | ✓ |

The list a connection sees is its role's; every call is checked on the server. A worker never saves a review (no self-review). No engineering tool reaches research, tickets, paper or the ledger, and no desk tool reaches the inbox.

### 4.2 Records (desk disk, `engineering/`, never in Git)

```
engineering/state.json                       global pause, counters (cr.eng-state.v1)
engineering/policies/<policy_id>.json        Eric's activated delegations (cr.eng-policy.v1)
engineering/tasks/<task_id>/task.json        the snapshot (cr.eng-task.v1)
engineering/tasks/<task_id>/versions/<n>.json immutable task versions (cr.eng-task-version.v1)
engineering/tasks/<task_id>/private/instruction-<n>.json  the relayed instruction, private
engineering/tasks/<task_id>/events/<seq>.json append-only events (cr.eng-event.v1)
engineering/tasks/<task_id>/artifacts/<sha256>.txt  diffs and test output, content-addressed
engineering/tasks/<task_id>/reviews/<review_id>.json immutable reviews (cr.eng-review.v1)
```

Every change is one `runOp`: the event file is created (never rewritten) and the snapshot replaced in the same verified commit. Server time decides leases. Records are in the offsite package and backups (`PACKAGE_INCLUDE` gains `engineering`), apart from the ledger. A record with a schema this code does not know reads as "unsupported" and is never rewritten.

### 4.3 Authorization and admission

- **Intent.** `explore` is a note and can never be submitted. `design` is limited to documentation paths. `implement` may change code.
- **Two paths.** (A) A delegation Eric activates in Preferences > Developer > Engineering, from a template in code: repository, intents, allowed paths, required review, release mode, limits, expiry. A submitted task inside it is admitted with no further prompt. (B) Anything else waits as `awaiting_authorization` until Eric authorizes that exact version and hash in the same panel, with his passphrase.
- **What never authorizes.** A tool argument (`approved`, `authorization`, `owner_request`, `policy_id` claims), a quoted instruction, or the connection's identity. Those fields are refused as `FORGED_AUTHORITY` and nothing changes.
- **Versions.** A task's content is immutable per version with its SHA-256. An edit is a new version; an authorization binds one version and hash, so an edited task needs authorizing again. After admission reaches main the task can no longer be edited (a correction or a new task instead).
- **Protected paths** (`backlog-promote.js` `PROTECTED`) can never be in a delegation, and any task touching one needs Eric (and its PR still waits for him).
- **Admission.** The worker allocates the next number from Git (main, open intake and admission branches) and records it; the desk binds it and returns the exact entry text and its hash. The worker pushes `claude/admission-<task_id>`, whose only change is that entry added at the end of the backlog. `engineering-admission.yml` runs main's own `backlog-promote.js admission`: it reads the desk's public `/engineering/admissions/<task_id>`, checks the diff is exactly the bound entry, the number appears once and the task is still admissible, and pushes it to `main` by compare-and-swap. The worker confirms it from Git readback and the task becomes `claimed` by the worker that confirmed it, which builds it next. A correction or an expired lease returns it to `queued`. A collision is refused and re-bound to a new number; an unknown push is read back before anything is retried.
- **Entry text** is generated by the desk from the sanitized title, outcome, acceptance and scope after a privacy screen (no addresses, keys, e-mail, phone numbers, URLs, amounts or control characters). The private instruction never leaves the disk.

### 4.4 Building, fencing and evidence

- Engineering items are built one per branch from `origin/main`, never in a batch and never stacked on; WIP and batch still come from `backlog-status.js`.
- `engineering_claim_task` grants a lease (server time, 20 minutes, renewed by events) with a fencing generation. Every worker event carries the claim token; a stale one is refused (`STALE_CLAIM`). A second session's claim while the lease lives is refused.
- The candidate is pushed first to `claude/candidate-eng-<n>` (tested by `test.yml`, never promoted). Only when the desk's attestation reads promotable does the worker push the same commit to `claude/backlog-eng-<n>`, which `backlog-pr.yml` promotes.
- **Promotion fencing.** For every commit naming an engineering item, `backlog-promote.js` asks the desk's public `/engineering/attestations/<head>` before scope and again before the push. It requires: the head the desk recorded for the current claim generation, the same merge base, verification passed on that head with every acceptance item met, the required review passed on that exact head and base, the task not paused, cancelled or blocked, and every changed path inside the task's scope and outside `PROTECTED`. An unreadable desk is a refusal. A stale worker can push a branch but cannot get it promoted.
- **Corrections.** A failed verification or a `changes_required` review returns the task for correction; each new candidate needs fresh full verification and fresh review. Three attempts per task, counted on disk across runs; then `blocked` with the reason.
- **Pause and revoke.** Pausing a task, revoking a delegation, or the global pause stops claims, admissions and worker events (except the acknowledgment that it stopped), and makes the attestation unpromotable. What already happened remotely stays recorded.

### 4.5 Review (M4)

- `required_review` is `none`, `claude` (a Claude connection other than the worker), `chatgpt`, or `owner`. A delegation sets the minimum.
- A review is bound to the exact head and merge base it read, with the reviewer's authenticated assistant and role. `engineering_get_evidence` gives the reviewer the approved goal, scope and acceptance, the exact diff and the test evidence first, and the builder's own notes only after them.
- ChatGPT reviews only when Eric opens or continues a conversation and asks. Nothing claims an unattended GPT review. A Gemini review counts only when the task asked for one.
- Results: `pass`, `changes_required`, `insufficient_evidence`. Only `pass` on the exact candidate satisfies a requirement; a new candidate needs a new review. A changed head after review is refused at promotion.

### 4.6 Readback

`engineering_get_task` reads the snapshot and, separately, what it could read back from GitHub at that moment (PR state, checks on the head, whether main has the merge) and the desk's own running revision for deployment. Each is `confirmed`, `pending` or `unknown` in words; an unreadable remote is `unknown`, never empty or complete. Merge, deployment and review are separate states. Reads write nothing.

## 5. File plan

| File | Change | Protected |
|---|---|---|
| `dashboard/engineering/policy.js` | new: templates, path globs, protected list, privacy screen, entry text | new path, added to `PROTECTED` |
| `dashboard/engineering/inbox.js` | new: records, transitions, claims, attestation, admissions | added to `PROTECTED` |
| `dashboard/engineering/github.js` | new: read-only GitHub readback (optional `CR_GITHUB_TOKEN`), unknown on failure | added to `PROTECTED` |
| `dashboard/engineering/tools.js` | new: the `/mcp/engineering` tools by role | added to `PROTECTED` |
| `dashboard/oauth.js` | second resource, role on the grant, consent choices; a refresh stays on its grant's own resource (`invalid_target` otherwise) | yes |
| `dashboard/server.js` | routes: `/mcp/engineering`, public admission and attestation reads, `/api/engineering/*` for Eric behind sign-in and his passphrase. Not in any delegation's paths (`eng-app@1` leaves it out), so a change to it always waits for Eric. | no |
| `dashboard/core/exporter.js` | `engineering` in the package | no |
| `dashboard/scripts/engineering-worker.js` | new: the worker's Git helpers (numbers, admission branch, evidence, verification, compare-and-swap push with readback) | added to `PROTECTED` |
| `dashboard/scripts/backlog-promote.js` | `admission` subcommand; engineering attestation in scope and promote; `PROTECTED` additions | yes |
| `dashboard/scripts/backlog-intake.js` | numbers also avoid open admission branches | yes |
| `dashboard/scripts/backlog-status.js` | current limits; engineering items kept apart | no |
| `.github/workflows/engineering-admission.yml` | new | yes |
| `.github/workflows/backlog-pr.yml` | desk address to scope and promote | yes |
| `DESK_STATE.md` | batch rule: engineering items only through the engineering lane | yes |
| `dashboard/web/src/shell/Engineering.jsx`, `Preferences.jsx`, `styles/overlays.css`, the bundle in `dashboard/public/app` | Preferences > Developer > Engineering: pause all, delegations (activate, revoke), tasks waiting for authorization (Authorize this version), pause, cancel and reopen a task, the connector address and connections. Opening it writes nothing; every write is its own button, with the passphrase where it authorizes. | no |
| `.gitignore` | this README and `docs/engineering/` (the lane's documentation path) | no |
| `dashboard/tests/engineering-inbox.test.js`, `engineering-connector.test.js`, `engineering-flow.test.js` | the section 12 matrix (section 6) | no |
| `dashboard/tests/backlog-status.test.js`, `web-app.test.js` | Eric's current limits and the engineering list; the panel's writes are clicks under `/api/engineering/` only | no |

## 6. Acceptance results (2026-10-25, this PC, fictional data only)

All runs use temporary workspaces, temporary bare Git remotes, stubbed desk and GitHub hosts and an injected clock. Nothing reached the online desk, GitHub or a model.

| Command | Result |
|---|---|
| `node --test dashboard/tests/engineering-inbox.test.js` | 18 of 18 pass |
| `node --test dashboard/tests/engineering-connector.test.js` (the real hosted server on a loopback port: OAuth, consent, `/mcp/engineering`, `/api/engineering`) | 2 of 2 pass |
| `node --test dashboard/tests/engineering-flow.test.js` (temporary repos and remotes; the worker script and main's `backlog-promote.js admission` and `engineeringCheck`) | 6 of 6 pass |
| The three above with `backlog-intake`, `backlog-promote`, `backlog-status`, `connector`, `connector-handoff`, `connector-latest`, `connector-readonly` and `web-app`, in one `node --test` run on the merged tree | 94 of 94 pass |
| `node dashboard/cli.js test` at `0f05d45` (this work on base `2e673e8`) | 957 of 958; the one failure is the baseline `rollback-drill.test.js` (CRLF on this PC), not this work |
| `node dashboard/cli.js test` at the merge with `origin/main` `9381263` (which fixed that test) | **970 of 970 pass**, exit 0 |
| `npm run build` in `dashboard/web` | bundle rebuilt from the merged source (`build.json` source `5ae0130835e0…`, 39 assets) |
| `npm run check` in `dashboard/web` (headless Chrome on the built app) | all browser checks passed; 78 of 78 regression checks |
| Preferences > Developer > Engineering on the FICTIONAL dev desk, seeded with a delegation, an admitted task, a 119-character task waiting for authorization and a paused task (a one-off headless-Chrome script, not committed) | At 1440 and 390, light and dark: no horizontal overflow, nothing under 12.5px, every control named, no console error, no write on opening. Tab reaches every control in order. Activating `eng-app@1` without a goal is refused, the reason shown in a toast, nothing saved |

The matrix of blueprint section 12, row by row:

| Scenario | Observation | Test |
|---|---|---|
| Brainstorming | An `explore` task is a note: submit refuses it, nothing is admitted, no remote call | inbox "explore never executable" |
| Bounded delegation | A task inside `eng-docs@1` is `admitted` on submit with no owner step | inbox "delegation fits", connector test 2 |
| New goal | Outside a delegation: `awaiting_authorization`; only Eric's authorization of that exact version and hash admits it (403 without or with a wrong passphrase, 409 on a wrong hash) | inbox, connector test 2 |
| Forged approval field | `approved`, `authorization`, `owner_request`, `policy_id` in a tool call: `FORGED_AUTHORITY`, records unchanged | inbox, connector test 1 |
| Edited approved task | A new version has a new hash and needs authorizing again; after admission an edit is `EDIT_AFTER_ADMISSION` | inbox "versions" |
| Duplicate submission | The same request ID returns the first answer; a different body with it is `IDEMPOTENCY_CONFLICT`; the same number bound again is `unchanged` | inbox, flow |
| Concurrent intakes | Numbers skip open intake and admission branches; two admissions pushed at once both land once each (`pushes === 2`, the compare-and-swap retry); a number Eric merged meanwhile is `number_taken` and re-bound | flow tests 1 to 3 |
| Crash between push and readback | An unconfirmed push intent is `DISPATCH_UNKNOWN` until the ref is read back; a stale-lease push never lands | flow "crash reconcile" |
| ChatGPT tool permission failure | A role without the tool: `ROLE_REFUSED` with the reason, nothing saved | connector test 1 |
| Private content | The original instruction is kept on the disk only, readable by Eric and the submitter; the public admission and attestation reads carry no private text (`no-store`); entry text passes the privacy screen; refusals never echo screened text; logs carry tool names, codes and task IDs only (redacted) | inbox "privacy", connector test 2 |
| Wrong repo or client | Another repository is refused; a desk token at `/mcp/engineering` and an engineering token at `/mcp` are 401; a refresh cannot switch resource | inbox, connector test 1 |
| Read-only grant write | Every write is refused for `reader`; records unchanged | inbox "roles", connector test 1 |
| Two worker sessions | One claim; the second is `CLAIMED`; an old token after a new generation is `STALE_CLAIM` | inbox "two workers" |
| Pause or revoke during a run | Global pause, a paused task or a revoked delegation stop claims, events (bar the stop acknowledgment), admissions and promotion | inbox "pause", flow, connector test 2 |
| Test failure and correction | A failed verification returns the task; the corrected candidate needs a fresh full verification and a fresh review | inbox "same failure twice", "reviews" |
| Retry ceiling across runs | Three attempts counted on disk; the same failing output twice blocks; still blocked after reopening the workspace; Reopen is Eric's | inbox "ceiling" |
| Missing or wrong-SHA review | Promotion refused (`engineeringCheck` unverified); a review of another head does not count; a Gemini review does not satisfy a ChatGPT requirement | inbox "reviews", flow "promotion" |
| Main or head moves | A new head needs a new review; main moving keeps the reviewed diff valid and `backlog-pr` re-composes and re-tests on main as it is | flow "promotion" |
| Lost trigger response | No trigger is built (M5). The lost push answer is the same case: unknown until read back, never re-dispatched blind | flow "crash reconcile" |
| Worker restart | The lease expires on server time; the next claim gets a new generation and resumes from the recorded candidate and evidence | inbox "two workers" |
| Unreadable remote | GitHub readback reads `unknown` (network error, rate limit), never a pass; an unreadable desk refuses admission and promotion | flow "GitHub readback", "refusals" |
| Partial batch | An engineering item is never in a batch; verification needs every acceptance check met, else it returns for correction | inbox "acceptance not met", backlog-status |
| Merge success, deploy unknown | `merged` from Git readback; deployment is its own `confirmed`, `pending` or `unknown` | flow "GitHub readback" |
| Restore older service | A record with an unknown schema reads "unsupported" and is never rewritten; a restored copy holds the lane (`HELD`) | inbox |
| Existing workflows | Research, tickets, paper and the ledger untouched: the full suite passes; `desk_status` counts no engineering connection as an assistant | full suite, connector test 1 |

Not covered here: the real connection. A test against `/mcp/engineering` is not ChatGPT's or claude.ai's own client, and blueprint §12 says M3 is not complete from a simulated call. That trial is section 7.

## 7. Activation: Eric's steps, in order

Nothing below has been done. Each step is Eric's, in his own UI, and none needs a credential pasted into chat.

1. **Review and merge the bootstrap PR.** It changes protected paths (`.github/`, `DESK_STATE.md`, `dashboard/oauth.js`, `backlog-promote.js`, `backlog-intake.js`, the new `dashboard/engineering/` and `engineering-worker.js`), so `backlog-pr` never merges it. Render then deploys `main`. Check `GET /healthz` shows the merge commit.
2. **Connect ChatGPT.** In ChatGPT, add a connector (custom MCP) at `https://cryptoresearch.onrender.com/mcp/engineering`, approve with the desk passphrase and choose **Submit and review**. Then refresh the app in ChatGPT's settings so it lists the engineering tools. Ask it to call `engineering_capabilities`; it should name role `submitter` and engineering not paused.
3. **Connect the worker.** In claude.ai, add a custom connector at the same address, approve with the passphrase and choose **Worker**.
4. **Activate the first delegation.** On the desk, Preferences > Developer > Engineering, activate **Engineering documents** (`eng-docs@1`, `docs/engineering/**` only, 30 days) with the passphrase.
5. **Create the trial routine,** apart from the live one. In claude.ai Routines, create a new routine:
   - **Name:** "CryptoResearch engineering lane trial".
   - **Setup:** the same repository, environment, model (Sonnet 5.5) and tools as the live builder (Bash, Read, Write, Edit, Glob, Grep).
   - **Connector:** the Worker connector from step 3 attached.
   - **Schedule:** none (run by hand).
   - **Prompt:** the trial prompt (engineering lane only, no ordinary batch). It is saved outside Git as `connected-engineering/routine-prompt-trial.txt` (6,355 characters, SHA-256 `a73c6ec2…`).
6. **Run the trial.** Tell ChatGPT, in your own words, to prepare and submit the trial task: "a short note at `docs/engineering/lane.md` on how an engineering task moves, reviewed by you before it merges". The exact arguments are in `connected-engineering/trial-task.json`; this branch's code admitted them under `eng-docs@1` in a fictional workspace with a clean privacy screen. Then:
   1. Run the trial routine by hand three or four times, about 10 minutes apart: admission, confirmation and build, then release.
   2. When `engineering_get_task` says `review_pending`, ask ChatGPT to review it, with `engineering_get_evidence` then `engineering_save_review`.
   3. Once it is `merged`, ask ChatGPT "how is it going?". That read is the evidence for M3 and M4.
7. **Only after the trial passes,** update the live routine's prompt to `routine-prompt-v2.txt` (10,770 characters, SHA-256 `f3b22409…`; the prior steps with step E added) and attach the Worker connector to it. Until then the live routine stays exactly as it is.

`vars.DESK_URL` is optional: the workflows default to `https://cryptoresearch.onrender.com`. `CR_GITHUB_TOKEN` (a read-only token in Render's environment) is optional too: without it, GitHub readback still works unauthenticated within GitHub's rate limit, and reads "unknown" past it.

## 8. Pause and recovery

- **Stop everything at once:** Preferences > Developer > Engineering > Pause all. Claims, admissions, worker events and promotion of engineering items stop; ordinary backlog work is untouched.
- **Stop one task:** Pause or Cancel on its row (ChatGPT can pause one too, with `engineering_pause_task`). Cancel frees its number.
- **Withdraw a delegation:** Revoke on its row. Tasks under it stop being admissible.
- **Cut a connection:** Preferences > System, Disconnect on its row (the grant is revoked at once), or remove the connector in ChatGPT or claude.ai.
- **Restore the prior routine:**
  - Set the live builder's prompt back to `connected-engineering/routine-prior-prompt.txt` (4,631 characters, SHA-256 `96452680ad156938e050b924983d20e6d7ee6ff2b001f9d3bb14109e1fd1b818`).
  - Detach its Worker connector; `routine-prior-config.json` beside it holds the rest of its configuration.
  - Delete or disable the trial routine.
- **Undo the bootstrap:** revert the merge commit on `main` through a PR. Records already on the desk's disk under `engineering/` stay as history; nothing is deleted or marked undone.

## 9. Milestone status

| Milestone | Status |
|---|---|
| M0 Reconcile and prove interfaces | implemented; capability matrix and plan above; ChatGPT account connection not established (step 2) |
| M1 Private inbox and readback | implemented, tested in isolation |
| M2 Owner delegation and narrow admission | implemented, tested in isolation (temporary repos) |
| M3 Builder and evidence return | implemented, tested in isolation; the real ChatGPT → inbox → backlog → Claude → PR → ChatGPT trial has not run |
| M4 Independent review and correction | implemented, tested in isolation; no real ChatGPT review yet |
| M5 Wake-up and broader pilot | not built (not authorized before M0–M3 pass) |

None is merged, live or verified through ChatGPT. Merged and live follow step 1; verified through ChatGPT follows steps 2 to 6.
