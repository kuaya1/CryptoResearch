# Codex audit of 2026-10-28: fact-check and remediation blueprint

Baseline: `main` at `5022c2c` (PR #86). Written by Claude in Eric's Claude Code
session, 2026-10-28. A proposal: no code was changed. The reproductions in
[repro.js](repro.js) run against the real modules in temporary FICTIONAL
workspaces built with the repository's own test helpers:

```
node audits/2026-10-28-codex-audit-response/repro.js .
```

## The answer

- **The audit is accurate.** Every finding I could test (F1–F6) reproduced
  against the real code. Its verdict, D for end-to-end readiness, stands.
- **F1 is worse than reported.** Besides null marks, a second pair's backfill
  writes phantom NAV highs: today's position valued at old prices, at hours
  before the book was even funded.
- **Two problems the audit missed or underrated, both P1:**
  - **(A)** one no-trade hour on a pair the book holds freezes the whole book
    for good;
  - **(B)** "Approve $500" opens nothing unless the stop sits about 24% or more
    under the entry. The gate checks exits at a $500 *position* but grants
    $500 of *risk*. Our own end-to-end test asserts this refusal
    (`dashboard/tests/trader-desk.test.js:155-162`).
- **Fix order.** Portfolio time (F1) and missing hours (A) come first: once
  the book is funded, their damage is written into an append-only journal.
  Then re-approval (F2), exit-evidence renewal (F3) and sizing (B). Isolation
  (F4) and the small items can run beside them.
- **Do not fund the online trader book until PR 1 and PR 2 are merged.**
  Funding happens once and can't be changed afterwards, and the journal keeps
  every mark it writes.

---

## Part 1. Fact-check

### The audit's findings

| # | Verdict | Root cause | What I reproduced | Severity |
|---|---|---|---|---|
| P0 | Confirmed | Local settings have no `trader` block; the rules default to null (`dashboard/core/workspace.js:134`); the adapter waits (`trader-desk.js:119-128`). Production is not readable from here. | — | Agree |
| F1 | **Confirmed, worse** | `applyBar` writes a mark at every bar's own hour end (`paper-trader.js:915`), valued with today's cash and positions (`navAt`, `:481-491`). The book's only clock check is wall time (`:586`), so a new pair's history goes in at past hours. | After a filled position on pair A, I applied 22 hours of pair B starting before A's first hour. That wrote 7 null marks; `drawdown_24h_usd` and `max_drawdown_usd` both went to null; `nav_by_hour` fell out of time order; and marks of **$25,155.78** appeared at hours before the book was funded (A valued at its old $0.95). | P1, agree |
| F2 | Confirmed | The adapter's waits ignore the thesis's existing exposure (`trader-desk.js:269-279`). ACKED counts as resolved (`trade-risk.js:73`), and the grant counts what the thesis already holds (`:303-315`). The refusal is stored under the decision's one intent ID and replayed (`paper-trader.js:642-646`, `trader-desk.js:291`). | Halve, fill, Undo (the sell is ACKED), then Halve again: REFUSED `pm_cap`, "250 with the 249.99999986… the thesis already holds…". After the sell filled and the book was flat, still REFUSED. | P1, agree |
| F3 | Confirmed | The 72-hour freshness is checked at the intent's time (`paper-trader.js:346`), and an expired cap becomes "never made from this decision" (`trader-desk.js:265-266`). Re-open covers only invalidation or older rules (`tickets.js:1153-1161`), and `createTicket` returns `exists` without `refresh` (`:616`). Recording a grant doesn't check exits (`grantBlock`, `:1167`). The toast ignores `r.trader` (`PMDecisionCard.jsx:263-266`). | At the readings' `as_of` + 73 h the cap reads "older than 72 hours", and `createTicket` answers `exists`. | P1, agree |
| F4 | Confirmed | The hook matches only `Bash\|Write` (both `.claude/agents/*.md`), and `decide()` allows any other tool (`pilot-role-guard.js:162`). | As the Prosecutor: Read of a research draft → allowed; Grep over `projects/` → allowed; `cat` through Bash → refused. Read also reaches the parent session's transcripts under `~/.claude/projects`. | P1 for the local desk. The online desk's connector route is role-bound and not affected. |
| F5 | Confirmed | Lifetimes from 1 to 10,080 minutes are accepted (`trader-rules.js:44-47`). An order fills only from an hour that starts at or after it was sent (`paper-trader.js:870`), and it expires before any hour that ends past its life (`:882-884`). | Sent at :30 with a 60-minute life: EXPIRED with 0 filled, although both hours traded below the limit. Any life under 120 minutes can give zero chances, depending on the minute the order is sent. | P2, agree |
| F6 | Confirmed, narrow | `checkHead` accepts a journal longer than its head (`paper-trader.js:200-201`). The tolerance isn't needed: `runOp` marks the generation `applying` before moving files and rolls sealed operations forward before the next write (`ops.js:672-675`, `:716`), and readers refuse an interrupted commit. So no write through `runOp` ever leaves the journal ahead of its head. | An extra chained line was read (3 marks); after removing it, the journal was read again without complaint (2 marks). | P2, agree |
| F7 | Confirmed | The header comes from the first row that has a forensic size (`ProjectTable.jsx:183`); the default label is "Exit @ $500" (`watchlist-model.js:30`). | Read only, not run. | P3 (cosmetic) |
| F8 | Confirmed | The code assumes 30 requests a minute at 2.1 s spacing (`trader-candles.js:39`, `:76`). GeckoTerminal's own API page today says paid plans go "from 10 calls/min to 250 calls/min". | Read the page. | P2, agree |

Not a defect: the retired engineering OAuth resource in `dashboard/oauth.js`
stays until Eric decides otherwise (his standing decision of 2026-10-28;
decision D8 below). I did not re-run the audit's "checks that held" (prompt
pins, Solana fees, fresh workspace). I read the UNKNOWN-order and same-ticket
replay paths and agree with them.

### What the audit missed or underrated

**A. One no-trade hour freezes the book (P1).** The audit lists this as a
deliberate restriction. Its consequence is larger than "that pair halts":

- GeckoTerminal leaves out an hour in which the pool had no trade. Eric kept
  `include_empty_intervals` off on 2026-10-28.
- The hourly read asks only for hours after the last one the book holds, so
  the hole never arrives.
- `applyBar` then refuses every later hour for a held pair
  (`paper-trader.js:861-862`), and `applyHours` stops the pair
  (`trader-desk.js:482`).

What I reproduced:

- The stop never fires, though a later hour traded at $0.60 through the $0.70
  stop.
- After 120 minutes NAV reads unknown, so every new opening on every pair
  waits.
- Undo's sell waits for good: "has no recent closed hour in the book".
- The next run asks for the same hour again.

DESK_STATE says the stop and target "wait until that is resolved", but
nothing can resolve it short of editing the journal, which the integrity
checks refuse.

**B. "Approve $500" opens nothing for normal stops (P1 for readiness).**

- The gate checks exits at the screening exit position: $500 of *position*
  by default (`forensic-defs.js:42-43`, `tickets.js:371`). It then suggests
  `standard_risk_usd`, $500 of *risk* (`tickets.js:414`).
- The trader sizes the position from the risk and the stop: position ≈ risk ÷
  (stop distance + about 0.8% of costs).
- The default exit ladder tops out at $2,000. So $500 of risk needs a stop
  about 24% or more under the entry, and $250 needs about 12%. If the $2,000
  reading is over the limit, the cap is $500 and nothing opens at any risk.
- The engine refuses (`trade-risk.js:337`), and through F2's mechanism that
  refusal is final for the decision.
- `trader-desk.test.js:155-162` asserts exactly this: Approve $500 at a 17.6%
  stop is refused with `exit_cap`.

The audit noted that "a narrow stop may still fail the notional or exit
cap". In practice it is the default outcome.

**C. The 72-hour window starts earlier than it seems.** It runs from the exit
reading's `as_of`, which can already be up to 12 hours old when the ticket is
saved (the monitor's cadence), not from the ticket or the decision. The card
doesn't say when it ends. Folded into PR 4.

**D. Cost grows with the journal.** Every step replays the journal over and
over: two replays per snapshot, one `PT.book` per grant, and up to 64 passes.
It also re-hashes each frozen packet per grant (`receiptOf` → `integrityOf`).
That's harmless today, but the work grows quadratically as the journal gains
24 bars and 24 marks per pair per day. Deferred to PR 11.

### The simplification hit-list

**1. Collapse the adapter into one planner.** I agree with the diagnosis
(waiting conditions and final refusals are mixed together), but not with
doing it first.

- The two defects need about ten lines (PR 3).
- Rewriting 488 lines beside protected code before behavioural tests pin F1–F3
  would open new seams.
- After PRs 1–8 land with their tests, `step()`'s up-to-64 passes can become
  three fixed phases (resolve; cancels and closes; openings), each over one
  replay. That's PR 11, optional.
- Keep: deterministic IDs, stored-grant checks, frozen packet verification,
  close before open.
- No new adapter state file (agreed).

The cleaner fix for the waiting/final split is not a new planner. The adapter
should ask the book only with an intent the engine's own pure check passes
now: `validateTradeIntent` against `PT.book` with the ticket, plus the cash
check. That's one call, and it removes the need to mirror engine rules into
wait text by hand. A refusal is then recorded only when something changed
between that check and the reservation under the lock. This is PR 3 and needs
decision D3.

**2. Separate the candle reader from portfolio time.** I agree on the cause.
The fix needs no merged-hour pipeline. Stop writing NAV and derive it.

- My first proposal was one rule: write a mark only when its hour end is
  later than the latest mark and not before the funding. Building PR 1 showed
  it still fails. The hourly read applies each pair's hours one pair after
  another. After an outage of three hours or more with two held pairs, pair
  A's later hours would be marked while pair B's price was still hours old,
  so a mark reads unknown, and the largest drawdown stays unknown for good.
  Any mark written once and never revised has this problem.
- What PR 1 does instead: NAV at each hour's end is computed on every read
  from what the journal already holds. That is the cash after the fills and
  exits of the hours ended by then, plus each quantity then held at its
  pair's close for that hour. The `mark` event is no longer written.
- So the order in which the pairs' hours arrive never changes the result,
  nothing is valued before the funding, and an hour that arrives late
  corrects the hours after it. A `mark` line written by an earlier build is
  read and ignored, so an existing journal still reads.

**3. Use the existing transaction recovery instead of the permissive anchor.**
Agreed: require an exact match, which is one condition. The D7 test that
blesses a longer journal changes with it. Also add the test the audit asked
for: a real interrupted staged write (sealed, not applied). Reads should
refuse it as interrupted; after `recover`, an exact match reads.

**Smaller deletions:**

- **One normalized exit array: partly disagree.** The packet already holds
  `exits` as an array. The named 500/2,000 fields belong to create-only
  receipts, and `integrityOf` compares them (`tickets.js:1122-1129`). Renaming
  them is a receipt schema change that buys no behaviour. Fix the label and
  show each row's own size now (PR 10). Stop writing the named fields only when
  the receipt format next changes for another reason.
- **One displayed decision result:** agree (PR 4).
- **The retired OAuth audience:** Eric's call (D8).
- **Repeated journal replay:** agree (PR 11).

### P0: what must be in place for one paper order to fill

**Settings** (Preferences > Screening):

- `trader.rules`:
  - `stop_min_pct`
  - `stop_min_atr`
  - `notional_max_pct`
  - `max_validity_minutes` (at least 120; see F5)
  - `allowlist`: each pair written exactly as `SYMBOL/USDC`, the project's
    ticker upper-cased
- `trader.book`: `cash_usd`, `fee_rate`
- `freshness.price_stale_minutes`: 90 by default, already set

**The arithmetic the values must satisfy** (`trade-risk.js:296-338`):

- Risk per trade ≤ 2% of NAV: $500 needs at least $25,000 of funding.
- 24-hour drawdown + risk already at the stops + this risk ≤ 4% of NAV:
  $25,000 holds two $500 positions at once, $50,000 holds four.
- Position ≤ `notional_max_pct` × NAV.
- Position ≤ the largest exit size whose reading is fresh, complete and
  within the limit (problem B).
- Stop distance ≥ the larger of `stop_min_pct` × entry and `stop_min_atr` ×
  the 14-hour ATR.

**Not settings:**

- The server's 30-minute timer running job `trader`. The online desk has it.
  Locally it runs only while the local server is up, and there is no CLI
  command for it.
- A verified identity with a CoinGecko ID and a contract on a network
  GeckoTerminal serves (`trader-candles.js:91`; native coins are excluded).
  A CoinGecko price stored within 24 hours. A ticker no other desk project
  shares.
- An ACCUMULATE or LIMIT_TRAP ticket with an entry zone, a numeric
  invalidation price, an upside target and a thesis.
- Frozen exit readings that are complete, within the limit and under 72 hours
  old at the intent's time.
- 15 consecutive closed hours for the pair. The first read backfills 24.
- Then an hour that starts after the order is sent, ends within its life and
  trades below the limit. Approve never fills at once: this is a limit-order
  simulation.

Production status is unknown from here. Eric can read it on Outcomes >
Trader's Paper Book, where the waits name each missing setting.

**A suggestion for a first run** (Eric's choice, decision D7):

| Setting | Value |
|---|---|
| Funding | $50,000 |
| Fee | 0.003 |
| `stop_min_pct` | 0.05 |
| `stop_min_atr` | 2 |
| `notional_max_pct` | 0.10 |
| Life | 2,880 minutes |
| Allowlist | the first pilot pair only |

---

## Part 2. The blueprint

Every PR follows the same pattern:

- One task on one branch in Eric's Claude Code session.
- `node dashboard/cli.js test` passes.
- A UI change rebuilds the committed bundle (`npm run build`) and passes
  `npm run check`.
- A PR that touches a protected file says so in its title and gets Eric's
  deliberate review (Constitution; `trader-boundary.test.js`).
- Eric merges.

### Sequence

| PR | Fixes | Protected file | Blocks funding | Needs Eric |
|---|---|---|---|---|
| 1 | F1 portfolio time | `paper-trader.js` | **yes** | D1 |
| 2 | A missing hours | `paper-trader.js` | **yes** | D2 |
| 3 | F2 ask only what the book will take | — | | D3 |
| 4 | F3 exit-evidence lifecycle | — | | D4, D5 |
| 5 | B size to the evidence | — | | D6 |
| 6 | F4 role isolation | — | | — |
| 7 | F5 lifetimes, F8 feed rate | — | | D7 (his life value) |
| 8 | Readiness proof through the real hourly read | — | | — |
| 9 | F6 exact head | `paper-trader.js` | | — |
| 10 | F7 exit column | — | | — |
| 11 | D replay once per phase (optional) | `paper-trader.js` (read-only addition) | | — |

How they fit together:

- PRs 1, 2, 9 and 11 touch `paper-trader.js`, so they go one at a time.
- PR 5 builds on PR 3's check, and PR 5 touches the card after PR 4 does.
- PRs 6, 7 and 10 share no file with the others and can go at any time.
- PR 8 needs PRs 1, 2, 3, 5 and 7.

### PR 1: portfolio time (F1)

- **Scope (as built on `claude/paper-portfolio-time`).** NAV by the hour is
  derived on read; see the simplification note above for why the one-rule
  version was dropped.
  - `dashboard/core/paper-trader.js`:
    - `replay` keeps each fill's and exit's cash and quantity by hour;
    - `navSeries` derives NAV at each hour's end since the funding;
    - `drawdown24` and `results` read it;
    - `applyBar` writes no `mark`;
    - an old `mark` line is read and ignored.
  - Tests: three new F1 tests in `paper-trader.test.js`, and the event lists
    in the existing tests lose their `mark`. In `trader-desk.test.js`, NAV by
    the hour now starts at the funding.
  - `DESK_STATE.md`: a "Portfolio time" entry under `cr-paper@2`.
- **Simpler, not more.** One event type is no longer written, and nothing
  depends on the order the hours were applied in. No merged-hour pipeline, no
  new module, no change to the hourly read.
- **Proof.** Each of the three tests failed on `5022c2c`:
  - **A second pair's earlier hours.** Repro.js's F1 sequence: 22 hours of a
    new pair from before the funding. `nav_by_hour`, NAV and both drawdowns
    are identical before and after, every hour end is one hour apart from the
    funding on, and no `mark` is written.
  - **Two held pairs caught up after an outage.** Four hours each, applied
    one pair after the other, then in time order: identical NAV by the hour
    and drawdowns, every value known, and 19:00 is exactly $10,010.6626.
  - **The funding's own backfill.** Fifteen hours read before the funding
    hold no NAV: the series is the funding's hour alone, and a new opening
    right after it is accepted.

  Every figure the existing tests check is unchanged.
- **Eric (D1).** Does the online desk's trader book hold any record? The
  build assumes none (PR #86, the funding form, merged today) and corrects
  `cr-paper@2` in place, as the red-team corrections were made. If a journal
  does exist, it still reads: its old marks are ignored and NAV is derived
  from its fills, exits and hours. Only the "made before any record exists"
  line in DESK_STATE would then be wrong.

### PR 2: missing hours (A)

- **Design (recommended for D2).**
  - When GeckoTerminal's answer for a held pair skips an hour but holds a
    later one, the hourly read hands the adapter that hour as missing.
  - The engine records a `missing_hour` event (pair, hour, words) that
    satisfies the next-hour check with no bar.
  - No price is invented and nothing fills in that hour.
  - The 14-hour ATR window breaks, so a new opening on that pair waits 15
    hours.
  - A stop crossed during the hole is caught by the next hour's open
    (`stop_gap`, the cautious fill), so the worst case is a worse fill, never
    a skipped stop.
  - An hour GeckoTerminal has not indexed yet (no later hour in its answer)
    is still waited for.
- **Files.**
  - `paper-trader.js`: the event and the GAP check
  - `trader-candles.js`: `barsOf`/`onePair` report the hole
  - `trader-desk.js`: `applyHours` passes it through
  - tests
- **Proof.** repro.js's F9 turned into a test:
  - the hole is recorded;
  - the stop fires on the $0.60 hour at $0.69825;
  - NAV stays known;
  - Undo's sell can be asked;
  - an hour with no later hour in the answer still waits;
  - `atr_14h` is null for the 15 hours after.
- **Eric (D2).**
  - Automatic, as above (recommended).
  - Or Eric confirms each hole on Outcomes: the same event, with his word
    recorded.
  - Or keep halting, in which case the book needs a manual close path anyway.

  The first two replace "a missing hour stops that pair" in DESK_STATE.

### PR 3: ask only what the book will take (F2)

- **Scope.** `dashboard/core/trader-desk.js` only.
  - In `assess`, before returning `ready`, run `validateTradeIntent(intent,
    PT.book(…ticket), rules)` and the cash check: the position and its fee
    against available cash, with the engine's own rounding (`exact.mulCeil`).
  - If it refuses, return `waiting` with the engine's words.
  - Add one plain line for the common case: "The earlier decision on this
    ticket still holds a position; this order waits until it is sold."
  - `not_opened` stays for what the frozen ticket alone settles (no grant,
    exit evidence).
- **Simpler, not more.** One call to code that already exists. The book's
  limits stop being restated in the adapter.
- **Proof.** repro.js's F2 turned into a test:
  - the second Halve waits while the sell is ACKED;
  - once the book is flat, the next step reserves it (ACKED, not REFUSED);
  - nothing is written to the journal while it waits.

  The 12a test's `refused` assertions change to match D3 and D6.
- **Eric (D3).** Recommended: a decision is asked of the book only when the
  engine's check passes now; until then it waits, in words, until Undo, the
  horizon or the invalidation ends it. The alternative keeps "one attempt is
  final" and adds only the prior-exposure wait.

### PR 4: the exit-evidence lifecycle (F3)

- **Scope.**
  - **(a)** The PM card shows "Exit readings valid until <time>": the largest
    complete, in-limit reading's `as_of` + 72 h, read through `PT.book` with
    the ticket, so the rule is not copied.
  - **(b)** `grantBlock` refuses Approve and Halve once that time has passed
    (409 `EXITS_EXPIRED`, nothing recorded).
  - **(c)** `reopenReason` gains `exits_expired`, so the existing Re-open
    (`refresh: true`) offers Renew. The old receipt stays as saved.
  - **(d)** The decision toast shows both books, for example "Risk granted:
    $250 · Trader: waiting — <words>".
- **Files.**
  - `dashboard/core/tickets.js`
  - `dashboard/web/src/views/inspector/PMDecisionCard.jsx` and the bundle
  - tests
- **Proof.**
  - At `as_of` + 73 h, Approve answers 409 and `decisions.jsonl` is
    byte-identical.
  - Re-open is allowed with `exits_expired` and makes a new ticket.
  - The old receipt is unchanged.
  - The card shows the time and the trader result.
  - `npm run check` passes.
- **Eric.**
  - **D4:** refuse the grant on expired exits (recommended, like INVALIDATED),
    or record it and let the trader say "not opened".
  - **D5:** renewal is a new Prosecutor ticket on the same report
    (recommended: the levels were set against old prices), or a desk-only
    re-freeze of the packet that keeps the old proposal.

### PR 5: size to the evidence (B)

- **Scope.** `trader-desk.js`, plus one line on the card.
  - When PR 3's check refuses only for `exit_cap` or `notional_cap`, the
    adapter asks for the largest risk that fits: the approved risk × (cap ÷
    position), floored to the cent. The same check confirms it.
  - It says so, for example: "Asked $148 of your $500: the exit readings show
    $2,000 sells within 5%."
  - The card shows the implied position before Eric decides, for example
    "$500 at this stop is a $2,717 position; exits are proven to $2,000."
- **Simpler, not more.** The engine, its limits and the gate don't change.
  The intent field is already named `risk_ceiling_usd`. The model still
  chooses no amount.
- **Proof.** Step 3 of the 12a test becomes: Approve $500 at the $0.70 stop
  gives an order with exact figures, position ≤ $2,000 and risk ≤ $500, not a
  refusal.
- **Eric (D6).**
  - Approve is a ceiling sized down to the evidence (recommended).
  - Or exact or nothing (today's behaviour: most approvals open nothing).
  - Or the gate checks exits at the position the grant implies: a new sizing
    version, more exit quotes per ticket and more quote budget.

### PR 6: role isolation (F4)

- **Scope.**
  - Drop Grep and Glob from both agents' tools. The frozen prompt is printed
    by the CLI, and neither job searches the repository.
  - Set the hook matcher to `Bash|Write|Read`.
  - Read is allowed only in the system temporary folder (the agent's own
    scratch) and for the instruction files each agent file names
    (`CLAUDE.md`, `DESK_STATE.md`, `COWORK-INSTRUCTIONS.md`). Paths are
    resolved through links, as Write already is.
  - `decide()` refuses a tool it doesn't know instead of allowing it.
- **Files.**
  - `dashboard/scripts/pilot-role-guard.js`
  - `.claude/agents/forensic-researcher.md`
  - `.claude/agents/junior-trader-prosecutor.md`
  - `dashboard/tests/pilot-role-guard.test.js`
- **Proof.** Guard tests:
  - refused: Read of `projects/**`, Read of `~/.claude/projects/**`, a link
    into `projects/`, Grep;
  - allowed: Read of a temp file, Read of `CLAUDE.md`;
  - the frontmatter test is updated.
- **A limit, said in the agent files.** This is a guard on Eric's own
  machine, not a sandbox. The online desk's connector route stays the
  isolated one.

### PR 7: lifetimes and the feed's rate (F5, F8)

- **Scope.**
  - `trader-rules.js`: life at least 120 minutes, with the reason in words.
  - The Preferences hint.
  - `trader-candles.js`: `MIN_INTERVAL_MS` 6500 (about 9 a minute), with
    GeckoTerminal's stated 10 a minute in the comment. Retry-After and the
    backoff stay.
- **Proof.**
  - 119 minutes refused, 120 accepted.
  - With a fake clock, a run's requests are at least 6.5 s apart.

### PR 8: the readiness proof (the audit's missing lifecycle test)

- **Scope.** One FICTIONAL test that drives the real path, with no manual
  step:
  - `trader-candles.refresh` with a fake GeckoTerminal for two pairs, one of
    them with a no-trade hour;
  - Approve $500 through `T.decide`;
  - fill;
  - Undo and re-approve before the sell fills;
  - a stop through a hole;
  - `TD.view` read as Outcomes draws it.
- **This is the gate for "ready".** It passes on `main`, Eric sets the
  trader settings, the online book is funded, and one pilot pair runs on
  paper.

### PR 9: exact head (F6)

- **Scope.** `checkHead` requires the journal's line count to equal the
  head's. The D7 test changes, and the interrupted-write test is added.
- **Also check** that backups and the offsite copy read the journal and its
  head under one generation (`readConsistent`). If they don't, a backup can
  catch the two apart, and a restore would then be refused: correctly, but
  noisily.

### PR 10: the exit column (F7)

- **Scope.**
  - The column is labelled "Exit cost".
  - Each cell shows its own size; the header no longer guesses one from the
    first row.
  - `watchlist-model.js`, `ProjectTable.jsx`, the bundle, `npm run check`.

### PR 11 (optional): replay once per phase (D)

- **Scope.**
  - `step()` becomes three fixed phases.
  - A read-only `PT.state(ws, { now })` returns intents and results from one
    replay.
- **Proof.** Every trader test is unchanged, plus a timing test on a 30-day
  fictional journal.

---

## Eric's decisions

| | Decision | Recommended |
|---|---|---|
| D1 | Does the online trader book hold any journal record? | If none: correct `cr-paper@2` in place. Fund only after PRs 1 and 2. |
| D2 | A no-trade hour on a held pair | Record it as missing automatically once a later hour exists; never a price. |
| D3 | Refusals the book would give now | Wait in words. The book is asked only when its own check passes. |
| D4 | Approve on expired exit readings | Refuse it, like INVALIDATED, and offer Renew. |
| D5 | What a renewal is | A new Prosecutor ticket on the same report. |
| D6 | What "Approve $500" means | A ceiling, sized down to the exit evidence, with the position shown on the card. |
| D7 | The trader settings | Eric's values; a first-run suggestion is in Part 1. Life at least 120 minutes. |
| D8 | The retired engineering OAuth resource | Eric's standing decision; removing it is one small PR whenever he chooses. |
| D9 | Native BTC, ETH, SOL | Keep them excluded for this milestone; a native feed is its own task. |

## Not recommended

- No new adapter state file, queue or scheduler (Constitution).
- No `include_empty_intervals`: recording the hole without a price is the
  more honest reading.
- No change to the 2% and 4% hard limits to make $500 fit. The sizing fix
  belongs in the adapter.
- No funding of the online book before PRs 1 and 2.
