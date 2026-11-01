# Bounded autonomous paper readiness: Phase A record and operator runbook

Branch `claude/bounded-paper-readiness`, one commit on base `origin/main`
`a00b4ce8d338e7108f9a927635ddbe589b3dbd32` (2026-11-01). Phase A changes code
and tests only. Nothing here was deployed, no Render setting or GitHub variable
was changed, the scout workflow stays as it is, no scheduled task was registered
or replaced, and no paid or live model session was started.

Raw evidence (test output, OS probes, clock matrix, pre-fix probes) is kept
outside the repository in
`%USERPROFILE%\Documents\CryptoResearch-evidence\bounded-paper-readiness-2026-11-01\`.
It holds no token, key, header, secrets file or production task arguments
(the two production tasks are recorded by state and XML SHA-256 only).

## Protected core

These four files are byte-identical to the base (SHA-256, checked before the
commit; `git diff --stat origin/main --` on them is empty):

| File | SHA-256 |
| --- | --- |
| `dashboard/core/paper.js` | `f43628eb8d1e7c3479ae9bcdc2d035f975732bca7a399a5b7a1dca862dffabf9` |
| `dashboard/core/paper-trader.js` | `31c94b6301caaf37f6c2218ca61fe077648ac087747882f209741b0044e2ad73` |
| `dashboard/core/trade-risk.js` | `3b61efe90065b993f7ac213296877d9d5601808fb7a0717e68a770b832893b16` |
| `dashboard/core/decimal.js` | `2978aa9026c5b5ff871f9f0df70d3da7862257c872d44a29ffd8e13a0d5c5c53` |

## A1. Admission uses the sessions left today

**Change** (`dashboard/core/lead-admission.js` `budgetHolds`):

- Admission needs `MIN_SESSIONS` (2: a Researcher and a Prosecutor) of today's
  pilot sessions **left**. Before, it only needed a daily ceiling of at least 2,
  however many sessions were already used.
- The session view must add up (`left = max(0, ceiling - used)`, whole numbers).
  If it does not, or the ledger cannot be read, admission holds.
- Admission still reserves no session. The worker's bind in `pilot-claims.js` is
  the one place that charges a session, so nothing is counted twice.
- `reserve()` already ran the plan again inside its lock at `max(now, Date.now())`.
  With the corrected check, that locked recheck now catches sessions spent
  between the plan and the lock.

**Evidence** (`dashboard/tests/lead-admission.test.js`, 31 tests):

| Test | On base code | Kind |
| --- | --- | --- |
| needs two of today's sessions left, not a ceiling of two (0 and 1 left hold, 2 left admits, nothing enrolled or charged) | fails: `['ready', undefined]` where `['held', 'budget']` is expected | regression (reproduces the defect) |
| the locked recheck: sessions spent between the plan and the lock hold the admission | fails: `['reserved', undefined]` where `['held', 'budget']` is expected | regression |
| capacity spent after an admission: the worker waits at its own ceiling, nothing is overspent or admitted twice | passes | new acceptance coverage |
| a pending admission recovered after New York's midnight keeps its day and ID | passes | new acceptance coverage |
| the witness's durable session ledger (attempt IDs, day, project, step) and `sessionsView(ws, explicitNow)` | n/a (strengthened assertion) | new acceptance coverage |

The base runs used the head test file copied into a `git archive` of the base.
Two other head tests fail on base without reproducing anything:

- one calls an API base does not have (`screening.callCounts`);
- one checks the new, more specific hold wording, where base already held with
  "could not be read".

## A2. Shared, fail-closed meter validation

**Change:**

- New pure module `dashboard/core/call-accounting.js` (`cr-call-accounting@1`).
  It has no files, network or clock of its own, and keeps no ledger, queue or
  service.
- Each provider keeps its own status file, writers and reserve-before-send
  boundary:
  - CoinGecko: `market.reserveCall`;
  - GoPlus: `screening.reserveRequest`;
  - exit quotes: `forensic-monitor.reserveRequest`;
  - GeckoTerminal candles: `trader-candles.reserve`.
- Each provider's reader and reserve now validate the stored counts before any
  rollover or write. When a reserve holds, nothing is sent and the file is left
  byte-identical.
- Admission (`lead-admission.js`), `doctor`, the hosted status and the trader
  book's words read the same validated counts.

The rules:

- A file confirmed absent (ENOENT) is a meter never run, so it counts zero.
- Any of these is **unknown, never zero**, and nothing is reset, repaired or
  rewritten:
  - any other read failure;
  - invalid JSON, or another schema;
  - an unexpected structure;
  - a counter that is not a whole number of 0 or more: a string, boolean, null,
    array, negative, fractional, non-finite or unsafe integer;
  - an impossible or mismatched day or month;
  - a day count above its month count.
- A valid older day or month rolls over in the view only. The durable record
  changes when its writer next writes.
- A stored day or month after today's (New York) is unknown: the clock went
  back, or the record is not this desk's.
- A reservation that finds the file corrupted while its own request is out
  refuses to write over it.

**Compatibility whitelist.** These states are accepted. They were taken from
this repository's writers and from every historical status file in the offsite
backups (2026-10-06 to 2026-10-31) and the local workspace:

| Meter | Schema | Accepted |
| --- | --- | --- |
| CoinGecko | `cr.market-status.v2` | `calls {month, month_count, day, day_count}`; `month_answered` and `day_answered` both or neither (older files and `demo.js` carry neither); the derived `budget_monthly` and `remaining`. `calls` is required |
| GoPlus | `cr.screening-status.v1` | all six counters, answered included; `calls` required |
| Exit quotes | `cr.forensic-monitor-status.v1` | the four counters; no `calls` only as the monitor's state before its first reserved request, while nothing in it says a request was made |
| Candles | `cr.trader-candles-status.v1` | the same, with the same no-`calls` initial state |

`calls: null` is accepted for none of them. Answered counts are not compared
with sent counts: an answer is added in the period it arrives, and its request
in the period it was reserved.

**Operator steps for an unknown meter.** The desk holds and says why, for
example:

> GoPlus's request count (market-data/screening/status.json) cannot be used: …

It never repairs the count itself. To proceed:

1. Read the named file and the reason in `node dashboard/cli.js doctor --json`
   or the hold's words. Note the provider's own usage page if it has one.
2. Decide the true count yourself. A count you cannot establish stays unknown,
   and its provider stays held.
3. To correct the file, restore that file from a verified backup, or write a
   corrected file with that provider's schema through a reviewed change. Never
   delete it to "start from zero": a missing file reads as never run.
4. Read the hold again. Nothing about that provider is sent until the reader
   accepts the file.

**Evidence:**

- `dashboard/tests/call-accounting.test.js` has 10 tests. For all four meters
  it covers the matrix of 40+ invalid shapes per meter plus 6 valid ones. It
  checks that:
  - readers, reserve and admission hold with `code: 'unreadable'`;
  - zero requests are sent (CoinGecko through `searchCoins`, `refresh`,
    `cycle.refreshContext` and `intake`; GoPlus through `refresh` and
    `screenAddress`; the exit-quote monitor; candles);
  - the files stay byte-identical;
  - a valid control sends;
  - in-flight corruption is refused;
  - four processes racing on a cap of 7 are granted exactly 7.
- `trader-candles.test.js` adds the candle matrix and the candle in-flight case.
- Pre-fix probe (base vs head): the same 7 malformed or future-dated states on
  each of the 4 meters, through each meter's own reserve function (base modules
  compiled unchanged, with one line exposing that function).

  | Tree | States granted a request | Meter files rewritten |
  | --- | --- | --- |
  | Base | 23 of 28 | 23 |
  | Head | 0 of 28 | 0 |

  Examples on base:
  - a month count of `"5"` became `"51"`;
  - −40 became −39;
  - invalid JSON reset to 1;
  - a count dated tomorrow was reset to today.
- One existing fixture changed. `ui-backend.test.js` (the review queue's
  stale-price note) wrote a CoinGecko status with no schema and no counts, a
  shape no writer produces, so it now reads unknown and the note says so. The
  fixture now has the price job's shape; the assertions are unchanged.
  `server.test.js` (the Refresh button within a minute) writes the same shape
  and was left as it is: its one-minute check comes before the meter, and
  either way nothing is sent.

## A3. Fixed epochs: no wall-clock or DST dependence

**Change:** fixtures only. The assertions are unchanged or stronger.

- `lead-admission.test.js` `desk()` starts at `2027-01-15T15:20:00Z`, and its
  backlog test steps to the next real New York midnight (`nextNyMidnight`)
  instead of adding 24 hours.
- Spring-forward (2027-03-14) and fall-back (2027-11-07) tests cover each 23- and
  25-hour day, with one allowance across both of its midnights.
- `witness-autonomous-paper.test.js` `witnessDesk()` starts at
  `2026-10-07T14:20:00Z` (10:20 New York). That is 13 days after the fixture
  reports' analysis date, inside the 90-day research freshness limit.
- The task-status tests use a fixed clock.

**Outer-clock matrix.** A preload shifts the process clock the suite starts
from. The mocked clock inside each test is unchanged.

| Outer clock (UTC) | Base lead-admission (24) | Base witness (6) | Head: lead-admission (31), witness (6), call-accounting (10), trader-candles (10) |
| --- | --- | --- | --- |
| 2026-11-04 16:00 (daytime) | pass | pass | all pass |
| 2026-11-05 04:50 (23:50 New York) | pass | pass | all pass |
| 2026-11-01 05:30 (fall-back day, 01:30 EDT) | pass | pass | all pass |
| 2027-11-07 03:30 (eve of fall-back) | **1 fails** (the backlog test's "+24 h is tomorrow") | **6 fail** | all pass |
| 2027-03-14 06:40 (spring-forward, 01:40 EST) | pass | **6 fail** | all pass |
| 2027-06-01 16:00 | pass | **6 fail** | all pass |

The base witness, started from a real clock, also passed on 2026-11-20 and
failed from 2026-12-24 on. Research was due again by then, so no Prosecutor was
claimed.

## A4. The pilot-all launcher under Task Scheduler, and an honest `-Status`

**Probes.** Disposable, owner-marked tasks under `\CryptoResearchProbe\`, with
the production principal (interactive, limited), settings (IgnoreNew,
disabled-by-default registration) and working directory, plus fictional child
scripts. They never ran the pilot, a model, the desk or any secret.

| Launcher | Exit 7 / 3 / 1 / 0 reaches LastTaskResult | Paths with spaces | IgnoreNew | 15 s limit, 60 s child + grandchild | Stop while active |
| --- | --- | --- | --- | --- | --- |
| `conhost --headless node` (base) | **no**: 0 for every exit | runs, but 0 | holds | child and grandchild **survive** (seen at +2 to +43 s) | both **survive** |
| plain PowerShell wrapper | yes | yes | holds | **survive** | **survive** |
| PowerShell wrapper with a kill-on-close Job Object | yes | yes | holds | none survive | none survive |

The production file `dashboard/scripts/pilot-task-run.ps1` (SHA-256
`9b2d986f841184c8bd6f98da62bc698087f321b32232c863c1534b96d028a73c`) was then
probed itself, byte for byte, in 12 scheduled runs:

| Case | Result |
| --- | --- |
| Exit codes | 7, 3, 1 and 0 each became LastTaskResult (exit 7 run twice) |
| stderr, then exit 7 | 0x7 |
| Overlap | one instance; LastTaskResult 0x800710E0 (refused) while the run went on |
| `PT15S` limit with a 60 s child and grandchild | 0x41306; none survived in 13 checks up to +50 s, past the child's natural end |
| Stop | 0x41306; none survived in 16 checks up to +65 s |
| Missing node | 90 |
| Time trigger, exit 3 | 0x3 |

Startup latency to the child was at most 0.945 s, and the task showed Running
within 0.37 s. Cleanup:

- all 12 probe tasks and the probe folder were removed;
- 37 recorded processes were checked by PID and creation time, and none was
  alive;
- `\CryptoResearch\Hourly` and `CryptoResearch pilot-all` were unchanged (state,
  last run, last result, XML SHA-256).

**Window behaviour (measured, not windowless).** The default terminal on this
machine is "Let Windows decide", with Windows Terminal 1.24 installed. Each
scheduled start:

- opened a Windows Terminal window about 0.06 to 0.1 s after the start;
- that window took focus for about 0.5 s, then stayed minimized in the taskbar
  until the run ended.

PowerShell's own console was hidden within about 40 ms. Not measured:

- whether keys typed during that half second reach the console;
- closing the Terminal window during a run (it may end the run);
- runs while signed out or locked;
- conhost as the default terminal.

`conhost --headless` showed no window but failed supervision, so it is not kept.

**Change:**

- `pilot-task.ps1 -Register` now starts the job wrapper (`powershell.exe
  -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File
  pilot-task-run.ps1 <node> --pilot-all --desk=online --max-agents=N`).
  Everything else is unchanged: the principal, the 3-hour limit, IgnoreNew,
  disabled at registration, and the refusal to touch a task it did not make.
- The wrapper:
  - puts itself in a kill-on-close job before it starts node;
  - runs `pilot.js` from the repository folder;
  - returns node's exit code;
  - uses its own codes 90 to 94 for start failures.
  It ends nothing by name and touches no claim.

**`-Status`** (`dashboard/scripts/pilot-task-status.js`, read only) reads Task
Scheduler's facts about its own task: never the action's arguments, and never
log text. It also reads the runner's log and lock where `pilot.js` keeps them,
and says one of:

| State | When |
| --- | --- |
| `not_registered` | no task of that name |
| `never_run` | Task Scheduler has not started it (another start's log line never counts) |
| `running` | running, the runner's lock held by the instance's live child and taken within the grace of the instance's own start, with time left before the limit |
| `completed` / `failed` | this start's own runner line (exit 0 or 3 / exit 1), agreeing with Task Scheduler's result; or a launcher start failure (90 to 94) |
| `interrupted` | terminated (0x41306) or its lock owner gone without a line; still Running past its limit (stale) |
| `unknown` | anything else, with the reason. This covers missing, malformed, ambiguous, inaccessible or future-dated evidence, a lock not this task's, a result that disagrees with the runner, and a supervision gap (no runner line after the grace, `gap: true`) |

- **Grace:** 120 s. The measured worst startup was under 1 s; 120 s covers a
  loaded PC and stays far inside the 30-minute interval.
- **Refused trigger:** a trigger refused while a long run goes on (IgnoreNew)
  moves Task Scheduler's last start to the refused time. While running, the run
  is matched by the instance's own process start, and the time limit runs from
  there. After it ends, the line that spans the refused start counts, but only
  with Task Scheduler's result equal to its exit code. Otherwise the state is
  `unknown`.
- **No side effects:** `-Status` writes nothing, starts nothing, takes over no
  lock and releases no claim.

**Re-registration** (Eric, when he decides; registration never runs anything).
The task registered before 2026-11-01 still runs conhost (`-Status` reports
`launcher: conhost`):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File dashboard\scripts\pilot-task.ps1 -Status    # confirm not running
powershell -NoProfile -ExecutionPolicy Bypass -File dashboard\scripts\pilot-task.ps1 -Disable
powershell -NoProfile -ExecutionPolicy Bypass -File dashboard\scripts\pilot-task.ps1 -Remove
powershell -NoProfile -ExecutionPolicy Bypass -File dashboard\scripts\pilot-task.ps1 -Register -MaxAgents 1   # registered DISABLED
powershell -NoProfile -ExecutionPolicy Bypass -File dashboard\scripts\pilot-task.ps1 -Status    # launcher: job_wrapper
```

`-Enable` stays a separate decision (Phase C).

## A5. Off-only controls

`arm-desk --mandate-off` and `--admission-off`, alone or together, write
exactly:

```json
{"automation":{"autonomous_paper_loop":false}}
{"automation":{"lead_admission":{"enabled":false}}}
```

combined into one patch when both are given. The settings write
(`server.js applySettings`) adds what it always records:

- the revocation of the authority in force (generation kept, `revoked_at`,
  `revoked_because` `loop_off` or `off`);
- its operation-log line and generation;
- the earlier settings' version copy.

Nothing else is written. The lead policy, automatic exit quotes, the Paper
Book, sizing, the trader's rules and allowlist, the intent life, contract
settings and defaults, and exit-quote targets are all left as they are, and no
helper runs.

- **Local:** the CLI writes the patch, reads it back (`mandate_on`,
  `admission_on`, both authorities) and reports `verified` only when both read
  off. `--dry-run` writes nothing and plans no contract defaults.
- **Online:** the printed console script does `GET /api/session`, the one `POST
  /api/settings`, and one read-only `GET /api/index`. It prints only the
  switches and authorities. It calls no exit-quote, contract-defaults or
  enrollment endpoint, and reads nothing back when the write is refused.
- **Refused mixes:** with an off flag, `--allow`, `--intent-life`, `--daily-cu`,
  `--monthly-cu`, `--contracts-on`, `--mandate-days`, `--admission-days`,
  `--admission-daily` and `--print-schedule` are refused (USAGE, nothing
  written), never given a precedence. Arming is its own command, unchanged.
- **No silent rearm:** resuming automation (`paused: false`) or a baseline
  `arm-desk` never rearms a revoked generation. Only an explicit arming does,
  as a new generation.

**Evidence** (`dashboard/tests/arm-desk.test.js`, 17 tests): 5 new off-only
tests cover:

- dry run, local, each alone and both;
- the exact settings diff;
- the workspace's changed-file set;
- unrelated-setting identity, with Eric's own book, exit-quote and lead
  settings and no pool factories;
- authority revocation and repeat idempotence;
- resume and baseline never rearming;
- 90 refused mixes;
- the online script run against a fictional transport to a local desk on a
  temporary workspace: exactly 3 calls, the readback, and a refused write
  reading nothing back;
- the real CLI's `--json` form.

The witness's pause, mandate-off, project-stop and expiry-before-fill tests and
its post-fill risk-reduction test pass (6 of 6).

**What each control reaches:**

| Control | Effect and limit |
| --- | --- |
| Admission off (`arm-desk --admission-off`) | Stops new delegated admissions and revokes admission authority. Already completed admissions (research requests, enrollment, records) are not undone |
| Disable pilot task (`pilot-task.ps1 -Disable`) | Prevents later scheduled starts. Does not end a run already going and does not stop the online desk's hosted jobs (Render) or the GitHub scout workflow |
| Paper mandate off (`arm-desk --mandate-off`) | Revokes authority for new autonomous paper risk. The trader's next turn cancels a mandate buy not yet filled before an eligible hour fills it (needs the hosted timer and data). Open positions keep their stops and closes |
| Pause automation (`automation.paused`) | Holds autonomous progression and opening risk as the existing code does, and revokes both authorities. Settlement and risk reduction continue, subject to data availability. Resuming does not rearm |
| Explicit task or process stop (`Stop`, the time limit) | Interrupts local work. The job ends the runner and its children. An uncertain dispatch stays `RECONCILE_REQUIRED` for Eric; no claim is released |

## `tickets.js reopenReason()`: is there a successor after a cancelled grant?

Phase B2 needs a legitimate new proposal after B1 cancels a mandate grant.
Read from the code at the base:

- **The cancelled grant stays in force.** A mandate grant (`approve` or `halve`)
  stays the decision in force on its receipt (`decisionFor`, tickets.js:1637).
  When the mandate is revoked, the trader cancels the unfilled buy
  (trader-desk.js:611-620) but records no new decision.
- **`reopenReason`** (tickets.js:1773-1790) offers a re-open only when:
  - the ticket is invalidated (1776);
  - an exit reading arrived after the ticket froze none: `exitArrivedOf`
    (1737-1766) returns null when a grant is in force (1741), and when the
    frozen packet already counted exits (1750);
  - the sizing rules version changed (1781);
  - the exit evidence expired, and only with no decision or a re-open in force
    (1786-1787).

  So **fresh exit quotes do not re-open an approved ticket**, and a cancelled
  grant is not reusable.
- **The mandate refuses that receipt again:**
  - it grants only a receipt nobody has decided (`MANDATE_PRIOR_DECISION`,
    tickets.js:1891);
  - it never re-opens a ticket with a decision of Eric's (1904);
  - it re-opens at most once per Claude report (`MANDATE_REOPEN_DONE`, 1907).
- **A new arming revives nothing:** "a new arming never revives an earlier
  grant" (`grantAuthority`, mandate-authority.js:264-276). Eric's rearm of a
  project's autonomy clears his interventions, but "grants made before them stay
  revoked" (mandate-authority.js:173).
- **Supported successors, in order of preference:**
  1. **A new Claude report on the project.** A new research run gives a new
     `report_id`. The worker's ticket step then opens a new ticket and a new
     receipt with no decision history, and the mandate can grant it under the
     generation in force. Cost: one Researcher and one Prosecutor session,
     inside the approved daily allowance.
  2. **A separately authorized eligible pilot project** with its own fresh
     lineage.
  3. **Only if Eric chooses:**
     - his own Undo of the cancelled grant (an intervention that suspends the
       mandate on the project);
     - then a re-open where `reopenReason` allows it (for example once the
       exit evidence has expired);
     - then a new Prosecutor receipt, and his explicit autonomy rearm.

     That is his decision path, not a canary shortcut.
- **Not permitted:**
  - clearing or editing decisions;
  - duplicating an asset or receipt;
  - rearming around his stop;
  - relaxing a gate to manufacture a fill.

  If none of the successors is available in the window, B2 stops with this
  evidence.
- **Not verified here:** whether a cancelled-but-in-force mandate grant still
  counts toward `max_open_grants` (`mandateCapacity`). Read the capacity
  (`MA.statusRows`, `pilot-all --dry-run`) before B2 and treat a held capacity
  as a blocker to report, not to work around.

## Phase A verification (2026-11-01, on the committed tree)

Node v24.21.0, the real binary (`...\Volta\tools\image\node\24.21.0\node.exe`),
first on PATH for npm; never the Volta shim.

| Command | Result |
| --- | --- |
| `node dashboard/scripts/pilot.js --check-isolation` | `ok: true` |
| `node dashboard/cli.js test` | 1493 tests: 1491 pass, 0 fail, 2 skipped (the two opt-in real-machine tests below), 172 s |
| `npm run ui:build` | exit 0; `build.json` 40 assets. The bundle changed because its source `public/trader-book-model.js` did |
| `npm --prefix dashboard/web run check` | exit 0: all browser checks passed (115), 86 of 86 regression checks on the production build, 416 s |
| `CR_TEST_REAL_CLAUDE=1 node --test dashboard/tests/pilot-launch-real.test.js` | the installed CLI passes (WebSearch and WebFetch only; no hook or MCP server ran); the registry test skipped by design. The probe's model endpoint is a local 127.0.0.1 stand-in answering 400 with a placeholder key, so nothing was generated or billed |
| Protected files: SHA-256 and `git diff --stat origin/main --` | 4 of 4 match the base; the diff is empty |
| `pilot-task.ps1 -Status` against this PC's real task (read only) | `never_run`: disabled, `launcher: conhost`, LastTaskResult 0x41303, no lock held |

The first full run on this tree had one failure, the `ui-backend.test.js`
fixture described under A2 Evidence. The run above is after that correction.
`CR_TEST_REAL_REGISTRY` was left off: it changes a registry key's ACL.

## Phase B runbook: supervised real-data canary (after merge and Eric's authorization)

State before starting:

- the observation window;
- the provider request and compute-unit caps;
- the agent-session cap;
- the one allowed project identity (chain, contract, CoinGecko ID);
- the paper-risk limits;
- the stop conditions.

No unlimited retries and no silent cap increases.

**B0. Prerequisites**

1. The deployed SHA: `GET /healthz` on the online desk, plus Render's deploy
   record, must equal the merged SHA. The local runner checkout must be at that
   SHA. A green build is not a deployment.
2. Admission off, read back. The pilot task disabled. The scout workflow left
   unenabled. Account for any hosted work in progress.
3. Re-register the pilot task with the job wrapper as in A4, registered
   disabled, and check `-Status` (`launcher: job_wrapper`). Never replace a task
   this script did not make.
4. Credentials through existing safe paths only, values never printed:
   - the poll token: `pilot.js --pilot-all --desk=online --dry-run`
     pre-polls;
   - the worker token: there is no read-only worker probe, so the first
     authorized claim or prepare is the authentication proof. Never release a
     real claim as a connectivity check.
5. `node dashboard/scripts/pilot.js --check-isolation` passes.
   Every meter reads valid (A2) on the desk that will run: doctor
   (`GET /api/doctor` or Preferences > System online,
   `node dashboard/cli.js doctor --json` for the local workspace) shows
   CoinGecko (Market data), GoPlus (Contract screening) and the exit-quote
   monitor (Forensics), and no line says "unknown". The candle meter is not in
   doctor: read it on Research > Outcomes > Trader's Paper Book
   (`GET /api/paper/trader`), where an unusable count reads "Request count
   unknown". An unknown meter or a `RECONCILE_REQUIRED` attempt is resolved by
   Eric's explicit action, never reset.
6. `node dashboard/cli.js arm-desk --desk=online --dry-run` with the approved
   flags only, reviewed. Printing arms nothing. Do not replay baseline book or
   risk values that would reset established settings.
7. Eric applies the reviewed settings. Read back:
   - the mandate generation, expiry, caps and allowed chains;
   - the pause state;
   - admission off;
   - the project's pilot enrolment;
   - contract-gate `enforce`, a live contract observation, the approved
     exit-quote target, and the exact chain, contract and CoinGecko identity.
     Numeraire only under Eric's existing authorization and its stored
     identity, never from `NMR` alone.

One supervised worker invocation at a time, with `--max-agents=1`. That is a
per-invocation cap: a Researcher and a Prosecutor are normally two sessions.
Inspect the real queue first and touch no other pilot project.

**B1. Cancellation proof**

- Record the lineage: `project → run_id/report_id → ticket/receipt_id →
  generation/decision_id → intent_id → client_order_id → cancel or fill`.
- After an acknowledged paper buy, apply one authorized control (pause or
  `--mandate-off`) before the first causally eligible hour.
- Verify in the authoritative order state:
  - the cancellation;
  - no fill and no opening position from that order;
  - the hosted timer and candles still advancing.
- A command's success is not proof. The full offline matrix stays the proof
  for every revocation mode.

**B2. Legitimate fill and risk reduction.** Use only a supported successor
(the `reopenReason` analysis above), with:

- authentic research and prosecution;
- block-pinned contract evidence;
- complete fresh exits;
- sizing and candles passing.

Then verify:

- one causally valid fill, with its fees and position lineage;
- the protective stop's configuration;
- continued risk management on valid data during an authorized pause.

Observe a natural stop or close only. If none happens in the window, report
live closure as pending, beside the offline closure tests.

**B3. Restart and idempotency**

- With nothing newly eligible, repeat the completed invocation and restart the
  local runner. Restart the hosted desk only if authorized.
- Compare IDs, decisions, orders, fills, sessions and claims. No duplicate side
  effect or session charge is allowed.
- A genuinely new stage may legitimately use a session.
- Local-only restart: report hosted recovery as unverified.
- An uncertain attempt stays claimed for reconciliation.

Report cancellation, live fill, active risk reduction, stop closure and
restart separately (proven, held, pending or failed). A risk hold that
prevents a fill is a correct no-trade, and the live-fill milestone stays
unproven.

## Phase C runbook: bounded discovery and admission (after Phase B evidence and Eric's authorization)

A seven-day window, unless Eric chooses a shorter one. Keep these limits:

- one admission per New York day;
- one active automatic pipeline;
- the existing session ceilings;
- 15% admission headroom;
- every forensic and consent gate.

No limit is raised for throughput.

1. Scout dry run: `dashboard/scripts/grok-cron.js --dry-run` sends nothing and
   prints the requests and estimated cost. Check that the needed secrets are
   present, without printing them.
2. Check GitHub's actual workflow state and the `SCOUT_ENABLED` and
   `SCOUT_LEADS` variables (a true variable does not enable a disabled
   workflow). Enable only the authorized scout workflow, for the approved paid
   budget and window.
3. Apply admission only (`arm-desk --admission-days=N --admission-daily=1`, an
   explicit expiry), never with baseline values. Read back:
   - the admission generation, policy hash, expiry and daily quota;
   - the separate paper mandate.
4. Make every authority expire inside the window. A recurring task must not
   produce provider use after expiry. Check what enrolled projects can still
   dispatch after expiry, and bound it with the supported controls (admission
   off, task disable, mandate off, project autonomy stop). Write a dated
   shutdown: the task `-Disable` and the scout workflow disable are Eric's
   actions. Mandate expiry alone does not stop research.
5. Validate the task:
   - owner, local checkout at the deployed SHA, the Node 24 binary, the working
     directory, IgnoreNew, `--max-agents`;
   - `-Enable` only after A4's re-registration and the authorized checks;
   - an actual run with `-Status` `completed` or `running` matched to its
     runner line. A next-run time proves nothing.
6. Observe without repeated manual restarts. Record each day's status, IDs,
   spend and reservations, the next action, blockers and any operator action.
   No new monitoring service.

Report independently:

- an ingested payload reaching `ELIGIBLE` or a precise hold;
- an admission with delegated provenance, one durable reservation, enrolment
  and no collision;
- real Researcher and Prosecutor records reaching a ticket or a hold;
- the same lineage reaching a mandate decision, one fill and risk management.

**Containment** (any unknown meter, duplicate side effect, unexplained task
failure, unexpected authority or unbounded cost):

- use the smallest control from the A5 table;
- read the revocation back, and check the pending-buy cancellation before an
  eligible fill;
- disable the scout workflow too when paid scout traffic is involved;
- keep claims for reconciliation, never retry inside 24 hours;
- never delete records, reset meters or cancel protective exits;
- record what is still running (processes, claims, orders, settings).

## Known limitations

- **`\CryptoResearch\Hourly` still uses conhost.** It is started by
  `schedule.js` and `scheduled-run.cmd`, and was out of scope and unchanged.
  Its exit codes and process tree have the A4 conhost behaviour.
- **The job wrapper shows a minimized Windows Terminal window while it runs**
  (focus for about 0.5 s at start). Closing it mid-run was not measured.
- **The real 3-hour limit and a real `pilot.js` run were not exercised by the
  probes:** the probes used `PT15S` and fictional children. The production
  task was not run.
- **CoinGecko's context refresh** (`cycle.refreshContext`) checks the meter
  before its requests and counts after, as before: one refresh can end above
  the cap by its own small number of requests. Its pre-check now fails closed
  on an unknown meter.
- **Whether a cancelled mandate grant holds `max_open_grants` capacity** is to
  be read before B2 (see above).
