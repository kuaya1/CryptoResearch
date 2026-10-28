# Codex audit of 2026-10-28: fact-check and remediation blueprint

Baseline: `main` at `5022c2c` (PR #86). Written by Claude in Eric's Claude Code
session, 2026-10-28; revised the same day after a second adversarial review
(Part 1b). The reproductions in [repro.js](repro.js) run against the real
modules in temporary FICTIONAL workspaces built with the repository's own test
helpers. The path argument is the tree to test, so the same script shows each
build's behaviour:

```
node audits/2026-10-28-codex-audit-response/repro.js .
```

### What is built and what is only proposed

| Item | State |
|---|---|
| PR 1, portfolio time (F1) | **Merged**: #87 (`6254b47`), merged into `main` as `b56116a` on 2026-10-28 at 22:11 UTC, before the second review's acceptance tests existed. They and the past-hour fix they need are PR 1b, below. |
| PR 1b, PR 1's acceptance tests | **Proposed only.** Must merge before funding. |
| PR 2, missing hours (A) | **Built, not committed, withdrawn.** It read a missing hour as "no trade", which the second review's C1 disproves. Kept uncommitted in `.claude/worktrees/paper-missing-hours` for reference. To be rebuilt as an unknown hour after Eric's decision D2. |
| PRs 3–11 | **Proposed only.** Nothing is built. |
| Counterexamples C1–C6 | **Reproduced** in repro.js on `main`, PR 1 and the withdrawn PR 2 build. |
| Production (the online desk's trader book) | **UNKNOWN.** Not inspected from here. |

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
- **Do not fund the online trader book until PR 1b and the rebuilt PR 2 are
  merged.** Funding happens once and can't be changed afterwards, and the
  journal keeps everything it writes. PR 1 (#87) is merged. PR 1b adds its
  acceptance tests and corrects how it values a past hour.
- **The second review (Part 1b) was right on all six points.** Five of my
  proposed remedies were wrong or incomplete:
  - missing hours read as "no trade";
  - a role boundary claimed for the connector;
  - a shared scratch folder called "the agent's own";
  - a sizing formula that overshoots by a lot;
  - a preflight that ignores the horizon.

  The sixth point was a readiness test that never reached the screen. Each
  now has a reproduction (C1–C6), and the PRs below are revised around them.

---

## Part 1. Fact-check

### The audit's findings

| # | Verdict | Root cause | What I reproduced | Severity |
|---|---|---|---|---|
| P0 | Confirmed | Local settings have no `trader` block; the rules default to null (`dashboard/core/workspace.js:134`); the adapter waits (`trader-desk.js:119-128`). Production is not readable from here. | — | Agree |
| F1 | **Confirmed, worse** | `applyBar` writes a mark at every bar's own hour end (`paper-trader.js:915`), valued with today's cash and positions (`navAt`, `:481-491`). The book's only clock check is wall time (`:586`), so a new pair's history goes in at past hours. | After a filled position on pair A, I applied 22 hours of pair B starting before A's first hour. That wrote 7 null marks; `drawdown_24h_usd` and `max_drawdown_usd` both went to null; `nav_by_hour` fell out of time order; and marks of **$25,155.78** appeared at hours before the book was funded (A valued at its old $0.95). | P1, agree |
| F2 | Confirmed | The adapter's waits ignore the thesis's existing exposure (`trader-desk.js:269-279`). ACKED counts as resolved (`trade-risk.js:73`), and the grant counts what the thesis already holds (`:303-315`). The refusal is stored under the decision's one intent ID and replayed (`paper-trader.js:642-646`, `trader-desk.js:291`). | Halve, fill, Undo (the sell is ACKED), then Halve again: REFUSED `pm_cap`, "250 with the 249.99999986… the thesis already holds…". After the sell filled and the book was flat, still REFUSED. | P1, agree |
| F3 | Confirmed | The 72-hour freshness is checked at the intent's time (`paper-trader.js:346`), and an expired cap becomes "never made from this decision" (`trader-desk.js:265-266`). Re-open covers only invalidation or older rules (`tickets.js:1153-1161`), and `createTicket` returns `exists` without `refresh` (`:616`). Recording a grant doesn't check exits (`grantBlock`, `:1167`). The toast ignores `r.trader` (`PMDecisionCard.jsx:263-266`). | At the readings' `as_of` + 73 h the cap reads "older than 72 hours", and `createTicket` answers `exists`. | P1, agree |
| F4 | Confirmed | The hook matches only `Bash\|Write` (both `.claude/agents/*.md`), and `decide()` allows any other tool (`pilot-role-guard.js:162`). | As the Prosecutor: Read of a research draft → allowed; Grep over `projects/` → allowed; `cat` through Bash → refused. Read also reaches the parent session's transcripts under `~/.claude/projects`. | P1 for the local desk. **Corrected (C2):** the online connector has no role boundary either. A full Claude connection lists and answers every research and ticket tool. Only the agent files' tool lists, which are client configuration, keep the two roles apart. |
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
  about 24% or more under the entry, and $250 needs about 12%.
- If the $2,000 reading is over the limit, the cap is $500. **Corrected (C4):**
  that does not mean nothing opens at any risk. $25 at entry $100 and stop $90
  is accepted at $231.6031. But neither amount the card offers fits:
  - $500 fits only with a stop about 99.7% under the entry;
  - $250 fits only with a stop about 49% under the entry.
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

## Part 1b. The second review's counterexamples (C1–C6)

A second adversarial review of this blueprint (2026-10-28) said that
reproducing yesterday's failures does not show that the proposed fixes keep
the invariants. Each point was checked in the code and reproduced in
repro.js. The figures below are its output.

### C1. A missing interval that held a stop breach, then recovered

**The review.** A later candle does not prove that the omitted hour had no
trade. PR 2's detector cannot tell an empty hour from missing provider
history. Its test put the adverse move in an hour that was available.

**Reproduced.** A Halve holds 1,598.519131 XMPL bought at $0.85 with a $0.70
stop. In the hour after the fill, the market trades down to $0.60 and
recovers. The hours after it are quiet at $0.84–0.86.

| Build | The complete history | GeckoTerminal's answer without that hour |
|---|---|---|
| `main` | Stopped out at $0.69825 | `GAP`, the pair stops, position open, NAV unknown |
| PR 1 | Stopped out at $0.69825 | The same, and NAV at the end of the missing hour reads $24,995.92 (see below) |
| PR 2 build | Stopped out at $0.69825 | Hour recorded as missing, both later hours saved, **no exit, position open, NAV $24,995.92** |

The PR 2 build turns an unknown into "no stop occurred". That claim in its
design was false: "a stop crossed during the hole is caught by the next
hour's open, never a skipped stop". **PR 2 is withdrawn.** So is its NAV
carry-through.

**Found on the way.** PR 1 fills an hour end that has no bar of a held pair
with the latest close up to 120 minutes old. It uses the tolerance `main`
used for its live mark, but applies it to past hour ends. So PR 1 states a
NAV for the hour whose path is unknown, where `main` stated none. The
tolerance belongs to NAV now (the newest hours, which may not have arrived
yet), never to an hour end in the past. PR 1 merged with it, as #87, so its
correction is in PR 1b.

### C2. A cross-role call on the server

**The review.** The connector has no Researcher/Prosecutor role, so the F4
row's "role-bound" claim is unfounded.

**Reproduced.** I called the real `/mcp` handler with a full Claude
connection labelled `role: prosecutor`.

- It lists `get_research`, `save_research_draft`, `save_report`,
  `start_ticket` and `save_ticket`.
- `get_research` answers. No call is refused for its role.
- The same call on a Read-only connection is refused `READ_ONLY`.

The code agrees:

- `contextFor` (`dashboard/mcp.js:473-484`) carries the model and read-only,
  no role;
- `:2091` refuses only on read-only, and `:2142` lists every tool for a full
  connection;
- `oauth.js:613-614` keeps a role only for the separate engineering
  audience.

**Corrected.** Server-side role isolation does not exist. The server enforces
which model a connection belongs to, and Read only. Nothing else.

- **What keeps the roles apart:** each agent file's tool list, which is
  configuration in the client.
- **Two agent-file sentences say more than is true:**
  - "The connector gives you only the ticket tools, so you cannot open
    Agent 1's run or drafts" (Prosecutor);
  - "The connector gives you only the research tools" (Researcher).

  Both are corrected in PR 6.

### C3. A cross-agent read of a temporary file

**The review.** "The system temporary folder (the agent's own scratch)" is
shared by both roles. Removing Grep and Glob does not create ownership: a
predictable file name is enough.

**Reproduced.** Every one of these is allowed by today's guard:

- the Researcher writes `<tmp>/cr-pilot-research-draft-FICTIONAL.md`;
- the Prosecutor writes the same path;
- the Prosecutor reads it, and the Researcher reads the Prosecutor's draft;
- the Prosecutor's `tickets import … --text-file <the Researcher's draft>`.

PR 6 as first proposed would have left all of these allowed.

### C4. Sizing down to a cap with exact lot rounding

**The review.** Scaling the risk by cap ÷ position, floored to the cent,
inverts a notional that was already rounded to a lot. It is not exact.

**Reproduced** with the risk engine itself. The fictional instrument is entry
$127,690 and stop $117,474. The lot is 0.000001, fees are 0.3% and the stop
slippage is 25 bps.

| Risk asked | Position | Engine |
|---|---:|---|
| $500 | $5,677.86354 | refused `exit_cap` ($2,000) |
| $176.12 (proportional) | **$2,000.00847** | **refused `exit_cap`** |
| $176.11 (exact search) | $1,999.88078 | accepted; one cent more is refused |

The exact search binds on whichever rule tightens first. With NAV $20,000:

| Binding rule | Largest risk | Position | One cent more |
|---|---:|---:|---|
| 2% risk cap | $400 | $4,542.31637 | refused `risk_cap` |
| 25% notional cap (5% stop) | $291.08 | $4,999.8389 | refused `notional_cap` |
| Exits to $4,000 (5% stop) | $232.87 | $3,999.9742 | refused `exit_cap` |
| Exits to $9 | $0.79 | $8.9383 | the result is refused `min_notional`: nothing fits |

The `README.md:93` claim is corrected above: a $500 cap does not mean
nothing opens at any risk.

### C5. A waiting approval whose horizon ends before the book is ready

**The review.** The pure risk check does not know the research horizon, and
the unsubmitted opening never consults `closeReasonOf` before it returns
ready.

**Reproduced** (`trader-desk.js:256-287`; `closeReasonOf` is first reached at
`:305`):

- The Halve is recorded while the book waits for its settings.
- The research horizon ends at 00:00 UTC the next day.
- At 20:00 UTC that day the book is ready, and the adapter answers `ready`:
  "buy … risk $250".
- One step then **reserves the order (ACKED) and cancels it (CANCELLED)**,
  the second because of the horizon. A decision that had already ended put
  an order in the journal.

The metric invalidation takes the same branch.

### C6. An expired ticket through the real application path

**Reproduced** through the HTTP routes the card uses. The desk's clock is set
73 hours after the exit readings.

1. The card reads `pending_pm_review`, `can_reopen` null, and no field says
   the readings expired.
2. Halve → 200. The response's trader result is `not_opened`, "No exit
   reading … shows a size within 5%". The card's toast reads only the
   decision: "Risk granted: $250" (`PMDecisionCard.jsx:266`).
3. Re-open → 400 `REFUSED`: "applies only to an invalidated ticket…".
4. `POST /api/projects/<id>/tickets` with `refresh: true` → 200 `created`.
   **The API can renew; the card has no control for it.**
5. Answering the new ticket, then Halve → 200, trader `order` (ACKED).
6. Outcomes reads the expired decision `not_opened` and the renewed one
   `order`.

### What the review asked of F1, and of "ready"

- **F1.** The derivation at `6254b47` stands; the review found no defect in
  its arithmetic. But the tests show selected scenarios, not the
  remediation. #87 merged before they existed, so they are PR 1b below, and
  PR 1 is accepted only when PR 1b passes.
- **PR 8.** Its dependencies omitted PR 4, and its scenario ended at
  `TD.view`. It is now a backend integration test. "Ready" needs the
  user-visible check as well.

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

Each PR also opens with its counterexample: the failing test, then the narrow
correction, then the resulting behaviour, stated in the PR.

| PR | Fixes | Counterexample | Protected file | Blocks funding | Needs Eric |
|---|---|---|---|---|---|
| 1 | F1 portfolio time (merged, #87) | — | `paper-trader.js` | done | — |
| 1b | PR 1's acceptance tests, and a past hour end valued only by its own bar | C1 (past hour ends) | `paper-trader.js` | **yes** | D1 |
| 2 | A unknown hours | C1 | `paper-trader.js` | **yes** | D2 (reopened) |
| 3 | F2 and C5: end what has ended, then ask only what the book will take | C5 | `paper-trader.js` (the reservation's checks exported as a pure preflight) | | D3 |
| 4 | F3 exit-evidence lifecycle | C6 | — | | D4, D5 |
| 5 | B size to the evidence, exactly | C4 | — | | D6 |
| 6 | F4 role isolation, described as it is | C2, C3 | — | | D10 |
| 7 | F5 lifetimes, F8 feed rate | — | — | | D7 (his life value) |
| 8 | Backend integration test, plus the user-visible check | C1, C5, C6 | — | | — |
| 9 | F6 exact head | — | `paper-trader.js` | | — |
| 10 | F7 exit column | — | — | | — |
| 11 | D replay once per phase (optional) | — | `paper-trader.js` (read-only addition) | | — |

How they fit together:

- PRs 1b, 2, 3, 9 and 11 touch `paper-trader.js`, so they go one at a time,
  1b first.
- PR 5 uses PR 3's preflight, and PR 5 touches the card after PR 4 does.
- PRs 6, 7 and 10 share no file with the others and can go at any time.
- PR 8 needs PRs 1b, 2, 3, 4, 5 and 7.

### PR 1: portfolio time (F1), merged as #87

- **Scope (as merged, `6254b47`).** NAV by the hour is
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

### PR 1b: PR 1's acceptance tests (second review)

#87 merged before these tests existed. PR 1 is accepted only when they pass.
This is a [P] PR on `paper-trader.js` and its tests, and it must merge before
funding. #87 writes no NAV, so nothing it values wrongly is in a journal, but
the drawdown checks read that NAV.

- **The tests**, each failing first where it fails today:
  - **Independent ledger.** Partial fills, exits and fees, with every cash,
    fee, realized and NAV figure compared against a ledger the test computes
    itself, in plain integer arithmetic from the journal's lines, never
    through the engine's functions.
  - **Every permissible order.** Two held pairs' hours, applied in every
    interleaving that keeps each pair's own order, give the same NAV by the
    hour and both drawdowns.
  - **Stale past prices, recovered late.** An hour end in the past uses only
    the bar of the hour that ends there, never the 120-minute allowance (C1).
    - Without that bar, while the pair is held, NAV there is unknown.
    - When the late bar arrives, the same hour end reads its value. Nothing
      is written.
    - The allowance stays for NAV now, the newest hours that may not have
      arrived yet.

    This is the one code change: `navSeries` in `paper-trader.js`. It fails
    on `b56116a`, where the C1 hour end reads $24,995.92.
  - **Old journals.** A journal holding `mark` lines from the earlier build
    reads: the marks are ignored, and NAV is derived from the fills, exits
    and hours.
  - **Interrupted writes.** A staged write that was sealed but not applied is
    refused as interrupted. After `recover`, the journal and its head agree,
    and the derived NAV is the same as before the interruption.
- **Eric (D1).** Production is **UNKNOWN**. Nothing in this blueprint assumes
  the online trader book is empty. The old-journal test above checks that PR 1
  is correct either way. #87 is on `main`, which the online desk deploys. Eric
  reads Outcomes > Trader's Paper Book there: is there a funding, an hour or
  an order? Only the "made before any record exists" line in DESK_STATE
  depends on the answer.

### PR 2: unknown hours (A), rebuilt around C1

The first build is withdrawn (C1). This is the redesign. Nothing of it is
built.

- **What the desk can know.**
  - GeckoTerminal's answer has no row for an hour and has a row for a later
    one. That shows only that the provider gave no row. Either the pool did
    not trade, or the provider's history is missing that hour, and the answer
    cannot say which.
  - Nothing the desk reads today establishes that no trade happened. That
    would need the pool's own chain record for the hour: no swap event from
    the frozen pool between the hour's first and last blocks.
- **Design.**
  - **The read reports an unknown hour, never "no trade".** An hour the answer
    leaves out is handed on as `unknown`, with the words "GeckoTerminal has no
    row for H and has one for H+1; whether the pool traded in H is not
    known". It is reported only between the answer's oldest row and a later
    settled hour, as in the withdrawn build.
  - **The book records it** as an `unknown_hour` line (pair, hour, words). It
    holds no price and is never replaced. A row for H that arrives later is
    refused (`CONFLICT`), and the refusal is said.
  - **A held pair, or one with a live order, enters an explicit state:** "path
    unknown since H". From H on:
    - nothing fills, and no stop, target or exit is evaluated, because whether
      the stop fired in H is unknown;
    - NAV at H's end and after is unknown while the position is held, and so
      are both drawdowns;
    - new openings wait, with words naming the pair and the hour.
  - **A pair the book neither holds nor has an order on** records the unknown
    hour and goes on. Its ATR window breaks, so an opening there waits 15
    priced hours.
  - **What resolves the state is a policy Eric authorizes.** His word
    authorizes what the book does next. It never establishes what happened in
    H, and the record keeps the hour unknown either way. See D2.
- **Proof, each failing first.**
  - **C1, failing on the withdrawn build** (no exit, NAV $24,995.92):
    - the position reads "path unknown since H";
    - no figure is stated for NAV at H's end;
    - nothing fills or stops in the hours after it until the policy applies;
    - then the policy's exit is at the first priced hour's open ($0.85),
      reason `unknown_path`. It is never at the stop price, and never
      "stopped out".
  - **The complete history** still stops at $0.69825.
  - A late row for H is refused and said; the journal is unchanged.
  - An unheld pair records the hour and goes on, with ATR null for 15 hours.
  - An hour with no later hour in the answer still waits.
  - Undo during an unknown path waits in words; after the policy close
    there is nothing left to sell.
- **Files.**
  - `paper-trader.js`: the event, the state, the policy exit and NAV
  - `trader-candles.js` and `trader-desk.js`: pass the hour on
  - tests
- **Eric (D2, reopened).** His choice of 2026-10-28 ("record it as missing
  automatically, never a price") rested on reading the hole as no trade. C1
  shows it cannot be read that way. The choices now:
  - **(a) Close at the next priced open, automatically** (recommended). The
    exit is labelled `unknown_path`, and the position's outcome is marked
    "path unknown, not comparable" on Outcomes. A live buy across the hour is
    cancelled, labelled "whether it filled in H is unknown". It is bounded,
    and claims neither a stop nor no stop. Its cost is that it may close a
    position the real market kept.
  - **(b) Eric resolves each one on Outcomes**, with (a)'s close or "keep
    holding under its stop". Keeping it is recorded as his decision, with
    the hour still unknown, and the outcome marked not comparable. Until he
    answers, the state holds and openings wait.
  - **(c) Keep halting**, as today, but say so. The pair reads "path unknown
    since H", with no way forward except (b).
  - **Later, optional:** read the frozen pool's swap events for H on chain.
    Zero swaps would establish "no trade", and only then may the book go on
    as the withdrawn build did. It needs an RPC route per network and is its
    own task.

  Any of these replaces "a missing hour stops that pair" in DESK_STATE.

### PR 3: end what has ended, then ask only what the book will take (F2, C5)

- **Scope.**
  - **`trader-desk.js` `assess`, unsubmitted opening, in this order:**
    1. **Terminal checks first**, before anything else, including the waits:
       `closeReasonOf` (undo, horizon, metric invalidation), the price
       invalidation, and what the frozen ticket alone settles (no grant, no
       stop or target, expired exit evidence). Any of them gives `not_opened`
       with its words. There is no reservation and no journal line.
    2. **The temporary waits**, in words, as today.
    3. **The book's own preflight.** If it refuses for a temporary reason,
       the answer is `waiting` with the engine's words; a terminal reason
       gives `not_opened`.
    4. Only then `ready`.
  - **`paper-trader.js` ([P]).** The reservation's own checks are exported as
    one pure function, `preflight(ws, intent, { now, venue, rules, ticket })`:
    `validateTradeIntent`, the ticket and grant, the exit evidence, and the
    cash rule (`commitOf` against available cash). `reserve` calls the same
    function under its lock. One rule set, not a copy in the adapter.
- **Which conditions are which** (D3 confirms the split):

  | Temporary: wait, re-checked every step | Terminal: `not_opened`, no reservation |
  |---|---|
  | Book unfunded; rules or fee unset | Undone or replaced |
  | An order not yet resolved | The research horizon ended |
  | No recent hour, a stale price, ATR unknown | The metric invalidation fired |
  | NAV, drawdown or open risk unknown, an unknown hour (PR 2) | The price invalidation fired |
  | `drawdown` (the 4% ceiling) and `cash`: free up as positions close | No grant, no stop or no target in the ticket |
  | `gate_cap` and `pm_cap` from what the thesis still holds (F2) | Exit evidence expired (PR 4) |
  | `notional_cap` and `risk_cap` (NAV can move); `stop_distance` (ATR moves hourly) | `exit_cap` and `min_notional` after PR 5's sizing: frozen evidence does not change |
  | `allowlist` and the rules: Eric can change them | `price_order`: the ticket's own levels |

- **Concurrency.**
  - A step is synchronous: the preflight and the reservation run with
    nothing awaited between them. The book's lock (`runOp`) orders writers
    across processes.
  - If they still disagree, the reservation's answer stands. Its refusal is
    recorded with the engine's words, under the attempt's own ID.
  - A temporary refusal allows one more attempt under a new ID (`open-2`,
    `open-3`; at most three, as the close attempts are bounded). A terminal
    one ends the request.
  - There are never two live buys for one decision: the existing unresolved
    wait comes first.
- **Proof, each failing first.**
  - **C5, failing on `5022c2c`** (one step ACKED then CANCELLED). The waiting
    Halve whose horizon ended reads `not_opened`, "The research horizon ended
    on …". The step writes nothing, and the journal is byte-identical.
  - The same with the metric invalidation firing while it waits.
  - F2: the second Halve waits while the sell is ACKED. Once the book is
    flat, it is reserved (ACKED, not REFUSED). Nothing is written while it
    waits.
  - A reservation that refuses after a passing preflight (cash taken in
    between, staged in the test) is recorded once, and `open-2` is asked only
    for a temporary rule.
- **Eric (D3).**
  - Recommended: the split above. Waiting is in words, the terminal reasons
    end it with no reservation, and a temporary refusal at the reservation
    gets at most two more attempts.
  - The alternative keeps "one attempt is final" and adds only the terminal
    checks and the prior-exposure wait.

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
- **Proof: C6, through the HTTP routes the card uses**, the clock 73 hours
  after the readings. It fails on `5022c2c`, where Halve gives 200 with the
  trader `not_opened`, Re-open gives 400 and the card has no renewal.
  - The ticket view says the readings expired, with the time.
  - Halve and Approve → 409 `EXITS_EXPIRED`, and `decisions.jsonl` is
    byte-identical.
  - `can_reopen` is `exits_expired`, and Re-open makes a new ticket on the
    same report. The old receipt is unchanged.
  - The new ticket is answered, then Halve → 200 with the trader `order`.
    Outcomes reads one request, the renewed one.
  - **The user-visible check:** an `npm run check` fixture with an expired
    ticket. The card shows the expiry and Renew; after Approve on the renewed
    ticket, the toast shows the trader's result ("Trader: order" or its
    words), not only "Risk granted".
- **Eric.**
  - **D4:** refuse the grant on expired exits (recommended, like INVALIDATED),
    or record it and let the trader say "not opened".
  - **D5:** renewal is a new Prosecutor ticket on the same report
    (recommended: the levels were set against old prices), or a desk-only
    re-freeze of the packet that keeps the old proposal.

### PR 5: size to the evidence (B)

- **Scope.** `trader-desk.js`, plus one line on the card.
  - **Withdrawn:** approved risk × (cap ÷ position), floored to the cent.
    C4 shows it overshooting by a lot ($176.12 → $2,000.00847, refused).
  - **The exact procedure.**
    - The rules that only tighten as the risk grows are `risk_cap`,
      `drawdown`, `gate_cap`, `pm_cap`, `notional_cap`, `exit_cap` and
      `cash`.
    - When PR 3's preflight refuses at the approved risk only for one or
      more of those, the adapter bisects over whole cents between 1 and the
      approved cents. The test is PR 3's preflight itself: no arithmetic of
      the adapter's own.
    - Why that is exact: the engine sizes the quantity as the risk over the
      loss per unit, floored to a lot. That never shrinks as the risk grows,
      and every rule above compares a quantity that never shrinks against a
      fixed limit. So once one refuses, it refuses for every larger risk.
    - It is bounded: at most ⌈log₂(approved cents)⌉ + 1 checks, 17 for $500.
  - **The result is checked again in full.** The largest passing risk must
    pass the whole preflight.
    - If a lower bound refuses it (`size_zero`, `min_notional`), nothing
      opens, in words: "The largest risk that fits, $0.79, buys $8.94, under
      the venue's $10 minimum."
    - A refusal for any other rule is reported as it is, with no search.
  - It says so, for example: "Asked $176.11 of your $500: the exit readings
    show $2,000 sells within 5%."
  - The card shows the implied position before Eric decides, for example
    "$500 at this stop is a $2,717 position; exits are proven to $2,000."
- **Simpler, not more.** The engine, its limits and the gate don't change.
  The intent field is already named `risk_ceiling_usd`. The model still
  chooses no amount.
- **Proof, each failing first.**
  - **C4:** $176.12 (the withdrawn formula) is refused; the search gives
    $176.11 at $1,999.88078, and one cent more is refused.
  - Each bound binding first: risk cap $400, notional cap $291.08, exits
    $232.87, and cash, with each "one cent more" refused by that rule.
  - **Lot boundaries.** One case where one cent adds less than a lot (C4's
    instrument), and one cheap token where one cent adds several lots.
    - In both, the answer never exceeds the cap, and one cent more does.
    - With the cheap token, the position may stop short of the cap by less
      than one cent of risk. That is stated in the PR, never exceeded.
  - **Minimum order:** exits to $9 refuse `min_notional` and open nothing.
  - **Fees:** the same case at a second fee rate gives a different, still
    exact, answer.
  - Step 3 of the 12a test becomes: Approve $500 at the $0.70 stop gives an
    order with exact figures, position ≤ $2,000 and risk ≤ $500, not a
    refusal.
- **Eric (D6).**
  - Approve is a ceiling sized down to the evidence (recommended).
  - Or exact or nothing (today's behaviour: most approvals open nothing).
  - Or the gate checks exits at the position the grant implies: a new sizing
    version, more exit quotes per ticket and more quote budget.

### PR 6: role isolation, described as it is (F4, C2, C3)

- **Scope.**
  - **Say what exists (C2).**
    - The connector enforces the model and Read only, not a role.
    - Two sentences in the agent files change:
      - the Prosecutor's "The connector gives you only the ticket tools, so
        you cannot open Agent 1's run or drafts";
      - the Researcher's "The connector gives you only the research tools".

      Each becomes: "Your tool list names only the ticket (research) tools.
      The connector itself does not refuse the other role's tools to this
      connection." DESK_STATE claims nothing more and needs no correction
      there.
  - **One scratch folder per role (C3).**
    - Write and Read are allowed only under
      `<tmp>/cr-pilot/researcher/` or `<tmp>/cr-pilot/prosecutor/`, the
      agent's own. Read is also allowed for the instruction files its agent
      file names (`CLAUDE.md`, `DESK_STATE.md`, `COWORK-INSTRUCTIONS.md`).
    - The same applies to the `--text-file` of `import-text` and
      `tickets import`.
    - Every path is resolved through links before it is compared, as Write
      is today.
  - Drop Grep and Glob from both agents' tools. Set the hook matcher to
    `Bash|Write|Read`. `decide()` refuses a tool it doesn't know.
- **Files.**
  - `dashboard/scripts/pilot-role-guard.js` and its test
  - both agent files
  - DESK_STATE
- **Proof: C3, failing on `5022c2c`**, where all five are allowed.
  - **Each direction is refused:**
    - the Prosecutor reading or writing in the Researcher's folder;
    - the Researcher reading or writing in the Prosecutor's;
    - the Prosecutor's `--text-file` pointing at a Researcher draft.
  - **Through a link:** a junction or symlink inside one role's folder that
    points into the other's is refused, both directions.
  - **The shared root:** `<tmp>/x.md`, outside both role folders, is refused,
    and so are `projects/**` and `~/.claude/projects/**`.
  - **Allowed:** each role's own folder, and `CLAUDE.md`.
- **The limits, said in the agent files and DESK_STATE.**
  - **Per role, not per invocation.** A Researcher can still read an earlier
    Researcher's draft. Scoping to one invocation needs an ID that the hook
    can see for each sub-agent run. I have not verified that Claude Code's
    hook input carries one, so it is not claimed.
  - **A guard on Eric's own machine, not a sandbox.**
  - **No server-side role boundary**, unless D10 builds one.
- **Eric (D10).**
  - (a) Describe the limitation, as above (recommended for now).
  - (b) Build role-bound grants. A Claude connection would be approved as
    Researcher or Prosecutor on the consent page, as the engineering roles
    are. The server would list only that role's tools and refuse the others
    with `ROLE`, writing nothing.
    - Its test: a Prosecutor grant calling `get_research` is refused.
    - It needs two connector entries, one per sub-agent. Whether a Claude
      Code sub-agent can be bound to its own connector entry must be
      verified before it is built.

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

### PR 8: the backend integration test, and the user-visible check

It needs PRs 1, 2, 3, 4, 5 and 7.

- **(a) The backend integration test.** It was called "the readiness proof",
  and it ends at `TD.view`, so it proves the backend only. One FICTIONAL
  test drives the real path with no manual step:
  - `trader-candles.refresh` with a fake GeckoTerminal for two pairs, one of
    them with an unknown hour that held a stop breach (C1). The outcome is
    PR 2's policy, never "held under its stop".
  - Approve $500 through `T.decide`, sized down exactly (C4).
  - A fill.
  - Undo, and re-approve before the sell fills (F2).
  - A waiting approval whose horizon ends before the book is ready: no
    reservation (C5).
  - An expired ticket renewed, then approved (C6).
  - `TD.view` read as Outcomes draws it.
- **(b) The user-visible check.** The same story through the server:
  - the HTTP responses of each decision, as in C6;
  - an `npm run check` fixture that renders the card and Outcomes >
    Trader's Paper Book;
  - asserted on screen: the expiry and Renew, the toast's trader result, the
    exact-size line, "path unknown since H", and the not-opened reasons.
- **"Ready" needs both.** Only after (a) and (b) pass on `main` does Eric set
  the trader settings and fund the online book (production state UNKNOWN
  until he reads it). Then one pilot pair runs on paper.

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
| D1 | Does the online trader book hold any journal record? | **UNKNOWN until Eric reads it** (Outcomes > Trader's Paper Book on the online desk). PR 1 (#87, merged) is built to be correct either way. Fund only after PR 1b and the rebuilt PR 2. |
| D2 (reopened) | An hour GeckoTerminal leaves out, on a pair the book holds | The hour is unknown, never "no trade". (a) Close at the next priced open, labelled `unknown_path` and "not comparable"; (b) Eric resolves each; (c) keep halting, in words. Recommended: (a). An on-chain swap check is a later, separate task. |
| D3 | What the book refuses before and at the reservation | The temporary/terminal split in PR 3. Terminal reasons end the request with no reservation; temporary ones wait in words; a temporary refusal at the reservation gets at most two more attempts. |
| D4 | Approve on expired exit readings | Refuse it, like INVALIDATED, and offer Renew. |
| D5 | What a renewal is | A new Prosecutor ticket on the same report. |
| D6 | What "Approve $500" means | A ceiling, sized down to the exit evidence by the exact search in PR 5 (the engine is the test), with the implied position shown on the card. The proportional formula is withdrawn. |
| D7 | The trader settings | Eric's values; a first-run suggestion is in Part 1. Life at least 120 minutes. |
| D8 | The retired engineering OAuth resource | Eric's standing decision; removing it is one small PR whenever he chooses. |
| D9 | Native BTC, ETH, SOL | Keep them excluded for this milestone; a native feed is its own task. |
| D10 | Role isolation on the server | (a) Say that none exists, and keep the roles apart by tool lists and per-role scratch (recommended for now); (b) build role-bound grants, after verifying a sub-agent can have its own connector entry. |

## Not recommended

- No new adapter state file, queue or scheduler (Constitution).
- No `include_empty_intervals`. It does not establish absence either: it
  returns a row the provider filled in itself, for an hour that may have
  traded. An unknown hour stays unknown.
- No change to the 2% and 4% hard limits to make $500 fit. The sizing fix
  belongs in the adapter.
- No funding of the online book before PR 1b and the rebuilt PR 2 are merged.
- No "ready" from the backend test alone (PR 8 needs the user-visible check).
