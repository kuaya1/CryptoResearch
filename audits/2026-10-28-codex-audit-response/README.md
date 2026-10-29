# Codex audit of 2026-10-28: fact-check and remediation blueprint

Baseline: `main` at `5022c2c` (PR #86). Written by Claude in Eric's Claude Code
session, 2026-10-28; revised the same day after a second, a third and a
fourth adversarial review (Parts 1b, 1c and 1d). The reproductions in [repro.js](repro.js) run against the real
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
| PR 1b, PR 1's acceptance tests | **Merged**: #90 (`600199b`), into `main` as `d85386b` on 2026-10-28 at 23:57 UTC. The five tests and the `navSeries` fix; only the past-hour test failed before the fix; the suite passed 1140/1140. |
| PR 2, missing hours (A) | **Built, not committed, withdrawn.** It read a missing hour as "no trade", which the second review's C1 disproves. Kept uncommitted in `.claude/worktrees/paper-missing-hours` for reference. The second design's late-hour refusal and policy close are withdrawn too (C7–C9). The third design's write-off is deferred (C13). Now narrowed to saying a missing hour truthfully, with `main`'s recovery kept (Part 2). |
| PR 2b, the write-off | **Deferred** (Part 1d). Not part of the initial repair. |
| PRs 3–11 | **Proposed only.** Nothing is built. |
| Counterexamples C1–C14 | **Reproduced** in repro.js. C1–C6 on `main`, PR 1 and the withdrawn PR 2 build; C7–C12 on `main` and the PR 1b build, with the same figures on both; C13 and C14 on `main` with PR 1b. |
| The blueprint's earlier revisions | #88 (C1–C6) and #89 (C7–C12), both merged. |
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
- **Do not fund the online trader book until PR 8's two checks pass on
  `main`.** Funding happens once and can't be changed afterwards, and the
  journal keeps everything it writes. PR 1 (#87) and its acceptance tests
  (PR 1b, #90) are merged.
- **The second review (Part 1b) was right on all six points.** Five of my
  proposed remedies were wrong or incomplete:
  - missing hours read as "no trade";
  - a role boundary claimed for the connector;
  - a shared scratch folder called "the agent's own";
  - a sizing formula that overshoots by a lot;
  - a preflight that ignores the horizon.

  The sixth point was a readiness test that never reached the screen. Each
  now has a reproduction (C1–C6), and the PRs below are revised around them.
- **The third review (Part 1c) was right on all six points.** Four of the
  revised remedies were still wrong:
  - a late hour refused as a conflict, although it is the evidence that
    settles the hour (C7);
  - a policy close that puts $241.85 into the book that no history the
    evidence allows contains (C8), priced 70 minutes before the gap could be
    seen (C9);
  - "below the venue minimum" called final while a drawdown that clears is
    what binds (C10);
  - retries under new intent IDs, which the book would accept as a second
    live buy (C11), and which a stale read would spend (C12).

  Those remedies are withdrawn. Part 2 now holds an unknown hour until
  evidence settles it, and states every figure it touches, including an
  acknowledged buy with nothing filled and a partial one. Openings are
  reserved atomically, under one ID per decision.
- **The fourth review (Part 1d) kept those conclusions closed and narrowed
  the rest.** Its four points, all taken:
  - The write-off keeps capital safe, but not the 4% drawdown breaker: a $100
    risk it accepts, the recovered history refuses (C13). It is deferred, with
    PR 2b. PR 2 is now only the truthful report, beside `main`'s existing
    recovery.
  - "Terminal under the frozen bounds" still depends on the fee, which is
    Eric's setting: the same $1.07 grant fails the minimum at 0.3% and passes
    at 0.1% (C14). So every sizing failure now waits, in words.
  - The opening guards apply on every reservation entry point, through one
    shared check.
  - The reservation reads every input it relies on (decision, exit readings,
    fee, rules) under the lock. The sizing search runs there too: it adds
    about 0.5 ms to a hold of about 20 ms, measured on this PC. The
    snapshot protocol and its `stale` state are dropped.
- **The desk is not ready for funding.** Funding waits for PR 8's two checks
  on the real approval-to-position path, which need PRs 2, 3, 4, 5 and 7.
  Suite totals show only that nothing regressed. They prove nothing about
  behaviour not yet built.

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

## Part 1c. The third review's counterexamples (C7–C12)

A third adversarial review (2026-10-28) read the revised blueprint. Its
finding: the diagnosis is corrected, but the remediation still fails in four
places: the unknown hour, the policy close, the minimum order and the
reservation's retries. Each point was checked in the code and reproduced in
repro.js, on `main` and on the PR 1b build. Both give the same figures.

### C7. The late hour arrives

**The review.** PR 1b says a late bar supplies its hour's value. PR 2 said a
late row for H is refused (`CONFLICT`). The two contradict each other, and the
refusal rejects the very evidence that settles the hour.

**Reproduced.** In C1's holding, GeckoTerminal first answers without H, then
again with it.

| The late H holds | H+1 alone | Then H and H+1 | Outcome |
|---|---|---|---|
| The breach (low $0.60) | refused `GAP` | both saved | stopped at $0.69825, once; NAV $24,750.00 |
| Nothing (quiet) | refused `GAP` | both saved | still held; NAV $24,995.92 |

`main` already reconciles a late hour correctly: the pair waits at H, and H,
whenever it comes, is simply the next hour. **The `CONFLICT` rule is
withdrawn.** PR 2 keeps this order and adds only what is missing.

### C8. A label is not an accounting control

**The review.** Marking the policy close "not comparable" leaves its cash in
the book.

**Reproduced** with the engine's own decimal helpers, for C1's 1,598.519131
XMPL at a 0.3% exit fee:

| Exit | Net proceeds |
|---|---:|
| The stop, as the complete history has it ($0.69825) | $1,112.82 |
| The withdrawn policy's next open ($0.85) | $1,354.67 |
| Difference | **$241.85** |

The policy would have added $241.85 to cash, and to every check that reads
cash or NAV. In the history the evidence later showed, the stop fired, so
that money does not exist. "Not comparable" marks the outcome but leaves the
cash in place. **D2(a) is withdrawn.** PR 2 now states every figure the
unknown hour touches.

### C9. The policy close predates its detection

**The review.** A hole at 10:00 can be seen only when the 11:00 row settles,
at 12:10. The policy then sells at 11:00's open.

**Reproduced** with `trader-candles` `barsOf`. 10:00 is missing.

- At 12:09 the read holds 09:00 only.
- At 12:10 it holds 09:00 and 11:00. The gap is first visible then.

No step could have sent an order at 11:00, so a fill at 11:00's open, 70
minutes before the gap was seen, is a counterfactual. **Withdrawn with C8.**
Nothing in Part 2 fills, exits or cancels because of an unknown hour. The
book records when it detected each one (`detected_at`). Anything Eric
authorizes takes effect only at or after both that time and his
authorization (`authorized_at`).

### C10. "Below the venue minimum" is not always final

**The review.** My PR 3 table called `min_notional` after sizing terminal. It
is terminal only when bounds that cannot change make it so.

**Reproduced** with the risk engine. The setup:

- NAV $25,000; entry $100, stop $90, target $140;
- exits proven to $5,000; Eric's $500;
- a $10 minimum, lot 0.000001, 0.3% fees, 25 bps stop slippage.

| 24h drawdown | Largest risk | Position | Engine |
|---|---:|---:|---|
| $999.21 | $0.79 | $7.3186 | refused `min_notional` |
| $0 | $500 | $4,632.0636 | accepted |

The drawdown frees up as hours pass, so the first row is a wait, not an end.
PR 5 now classifies what binds. The request then opens once, later, with no
new approval.

### C11. Two live buys for one decision

**The review.** PR 3's "there are never two live buys for one decision: the
existing unresolved wait comes first" rests on a guard that does not give
that guarantee.

**Reproduced.**

- `trade-risk.js:70`, `:73`, and the adapter's own wait
  (`trader-desk.js:243`): ACKED and PARTIAL are *resolved*. So neither
  `halt_unresolved` nor that wait sees a buy the venue acknowledged.
- The book takes a second ACKED buy for the same decision under another
  intent ID. Only a third is refused, by `gate_cap` and `pm_cap`, because the
  two already hold $199.996 of the $250 grant.
- So the thesis cap bounds the total, and nothing in the book stops a second
  opening.
- `main` never asks twice:
  - one opening ID per decision (`trader-desk.js:252`);
  - its position `pos-<ID>` (`:292`);
  - its orders' owner keyed to that ID (`:365`).

  My `open-2`/`open-3` retries would have broken exactly that.

**Withdrawn:** retries under new IDs. PR 3 keeps one ID per decision, and a
temporary refusal writes nothing, so it never spends that ID. The book itself
refuses a second opening for a decision.

### C12. A size solved on a read the book no longer matches

**The review.** Bisecting outside the reservation's lock solves for a book
that may have changed since the read. My design then recorded the refusal and
asked again under a new ID.

**Reproduced** on the trader's book alone: $10,000 funded, Eric's $250, a
stop at $85.

- **On one read** the largest risk that passes is $200.00. One cent more is
  refused `risk_cap`, the 2% limit.
- **Then another writer** takes $100 of the same thesis. That is the
  fixture's simplest change; on the desk it would be another decision's
  reservation, or an hour that moves NAV.
- **The reservation at $200.00** is refused `gate_cap` and `pm_cap`, and
  **recorded under its ID**.
- **The other order is cancelled**, and the thesis holds $0 again. The same
  intent now reads `unchanged`, REFUSED: its ID is spent for good.

**Corrected in PRs 3 and 5:**

1. Read one snapshot that carries the journal's head.
2. Run the pure solver on it.
3. Under the lock, check that the head has not moved, and reserve.
4. A moved head is `stale` and a temporary refusal is `waiting`. Neither
   writes anything.

Simplified in Part 1d: the search runs inside the reservation's own lock, so
there is no snapshot to go stale.

---

## Part 1d. The fourth review: narrow the repair (C13, C14)

A fourth review (2026-10-28) kept the third review's withdrawals and
corrections closed. It supported PR 1b as a narrow change for manual review
(merged as #90), then asked for four more changes before the rest is built.
Points 1 and 2 are reproduced in repro.js on `main` with PR 1b. Points 3 and
4 are contract requirements on code not yet built.

### C13. The write-off keeps capital, not the drawdown breaker

**The review.** Valuing missing exposure at zero does not bound the drawdown
from a peak nobody saw (the third design's own stated limit, in #89). So the
write-off permits openings the 4% breaker would refuse, and that design let
those reservations stand after recovery: an intentional exception to the risk
policy.

**Reproduced** with `validateTradeIntent`. Cash is $9,900, and one held token
was last worth $100. Its two missing closes turn out to be $1,000, then $100,
crossing neither its stop nor its target, so the complete history peaks at
$10,900. The held token's own risk at its stop is counted as $0 on both sides,
which only favours the recovered history.

| Basis | NAV now | 24h drawdown | A new $100 risk |
|---|---:|---:|---|
| The write-off | $9,900 | $100 | accepted |
| The recovered history | $10,000 | $900 | refused `drawdown` |

Capital conservation and the drawdown breaker are different guarantees, and
the write-off gives only the first.

**Deferred**, with PR 2b, out of the initial repair. PR 2 keeps `main`'s
halt-and-recover behaviour and says it truthfully, and the pilot is validated
on that. A write-off can come back later only as a separate risk-policy
decision, with its own acceptance criteria. At the least, it must either
hold the drawdown breaker on the recovered history, or be stated as an
exception Eric accepts.

### C14. "Frozen bounds" still depend on execution inputs

**The review.** My PR 5 re-ran the sizing with only the grant and the exit
cap, to decide that "below the minimum" is terminal. But the quantity also
depends on the fee and the lot, and a frozen grant and ticket freeze neither.

**Reproduced** with the risk engine. The setup:

- Eric's grant is $1.07;
- entry $100, stop $90, target $140;
- exits proven to $5,000;
- a $10 minimum, lot 0.000001, 25 bps stop slippage.

| Fee | Position | Engine |
|---|---:|---|
| 0.3% | $9.9126 | refused `min_notional` |
| 0.1% | $10.2738 | accepted |

Only the fee changes, and it is Eric's setting (`trader.book.fee_rate`,
`trader-rules.js:79`). So my terminal verdict would have ended a request that
a permitted settings change makes executable.

**Corrected:** every sizing failure waits, naming the rule that limits it.

- What ends a request: Undo or replacement, the research horizon, the metric
  or price invalidation, and expired exit readings.
- The second, counterfactual search is gone, and so is most of the
  classification.
- The wait is bounded, because exit readings expire 72 hours after they were
  taken, and that ends the request (PR 4).

### Point 3. The opening guards hold on every entry point

Part 2 kept `reserveIntent` with today's behaviour for existing callers, and
added `duplicate_opening` and `prior_exposure` to the book. Unless the guards
sit in the one check every reservation runs, the direct call C11 used bypasses
them.

**Contract.** One shared reservation check holds the guards. It runs on
every path that can reserve an `OPEN_LONG`: `reserveIntent`, `submitIntent`
and the new sized opening.

**Acceptance tests**, through each entry point, against:

- an ACKED opening;
- a PARTIAL opening;
- another decision on the same thesis;
- a completed opening (filled, and closed), so a decision opens once, ever.

### Point 4. The journal's head does not cover every input

`expect_head` sees only the paper journal. It misses three other changes: a
decision (`decisions.jsonl`), a setting (the fee, the sizing rules) and time
(exit readings expire).

**Contract.** The reservation reads, under the lock, every input it relies
on, at its own `now`:

- the decision in force;
- the frozen exit reading and its age;
- the trader rules and the fee.

Ticket decisions and settings saves take the same workspace lock as the
journal (`runOp`; `tickets.js:1215`, `server.js:1452`), so nothing can change
them during the reservation. The lot and minimum are constants of the code.

**Acceptance tests.** In each, the paper journal's head does not move:

- Eric undoes the approval: refused, terminal, no order;
- the fee changes: sized with the new fee;
- a sizing rule changes: sized under the new rule;
- the exit readings pass 72 hours: refused, terminal, no order.

**Measured before choosing the protocol.** On this PC, against a FICTIONAL
book:

| Journal | Reservation (whole operation, lock held) | Book read | The sizing search |
|---|---:|---:|---:|
| 15 hours on record | 19.0 ms | 3.4 ms | 0.50 ms, 16 checks |
| 720 hours (30 days) | 25.1 ms | 4.8 ms | 0.41 ms, 16 checks |

These are medians of 7 runs. The lock's timeout is 20 s, and the server's
slower disk lengthens the writes, not the search.

So the search runs inside the reservation's lock: read the inputs once, size,
check, reserve. The exported snapshot, `expect_head` and the `stale` state
are dropped.

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

| PR | Fixes | Counterexample | Protected file | Before funding | Needs Eric |
|---|---|---|---|---|---|
| 1 | F1 portfolio time (merged, #87) | — | `paper-trader.js` | done | — |
| 1b | PR 1's acceptance tests, and a past hour end valued only by its own bar (merged, #90) | C1 (past hour ends) | `paper-trader.js` | done | D1 |
| 2 | A: say a missing hour truthfully; `main`'s halt and late-hour recovery kept | C1, C7, C8, C9 | — | **yes** | D2 (revised) |
| 2b | A quiet hour settled from the chain: **deferred** (C13) | — | — | | D2 |
| 3 | F2, B: atomic openings, sized exactly under the lock, one per decision on every entry point | C4, C5, C10, C11, C12, C14 | `paper-trader.js` (`cr-paper@3`) | **yes** | D3, D6 |
| 4 | F3 exit-evidence lifecycle | C6 | — | **yes** | D4, D5 |
| 5 | B on the card: the implied position, and the size and the wait in words | C4 | — | **yes** | D6 |
| 6 | F4 role isolation, described as it is | C2, C3 | — | | D10 |
| 7 | F5 lifetimes, F8 feed rate | — | — | **yes** | D7 (his life value) |
| 8 | Backend integration test, plus the user-visible check | C1, C5, C6, C7, C10, C11, C14 | — | **yes** | — |
| 9 | F6 exact head | — | `paper-trader.js` | | — |
| 10 | F7 exit column | — | — | | — |
| 11 | D replay once per phase (optional) | — | `paper-trader.js` (read-only addition) | | — |

How they fit together:

- PRs 3, 9 and 11 touch `paper-trader.js`, so they go one at a time, 3 first.
  PR 2 no longer touches it.
- A PR that adds an event or a rule to the book publishes a new book version
  (`cr-paper@3` for PR 3) that reads every earlier line. A published version
  is never edited.
- Next, in the fourth review's order: PR 2 (the report) and PR 3 (atomic,
  exactly sized openings). PR 2 and PR 3 share no file.
- PR 5 reads PR 3's result, and it touches the card after PR 4 does.
- PRs 6, 7 and 10 share no file with the others and can go at any time.
- PR 8 needs PRs 2, 3, 4, 5 and 7. **Funding waits for PR 8's two checks**,
  not for suite totals.

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

**Merged** as #90 (`600199b`) on 2026-10-28. On `b56116a` only the
past-hour test failed. With the fix, the suite passed 1140/1140 and C1's hole
end reads null. The third review takes its late-hour rule as the correct one
(C7), and the fourth supported it as a narrow change for manual review.

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

### PR 2: unknown hours (A), said truthfully (C1, C7–C9, C13)

The first build is withdrawn (C1). So are the second design's refusal of a
late hour and its policy close (C7–C9), and the third design's write-off is
deferred (C13). This is the narrow repair. Nothing of it is built, and it
changes no protected file.

- **What the desk can know.**
  - GeckoTerminal's answer has no row for an hour and has a row for a later
    one. That shows only that the provider gave no row. Either the pool did
    not trade, or the provider's history is missing that hour, and the answer
    cannot say which.
  - Nothing the desk reads today establishes that no trade happened.
- **What `main` already does, and keeps.**
  - A pair the book holds, or has a live order on, waits at its last hour. A
    later hour is refused `GAP` (`paper-trader.js:925`), so nothing on it
    fills, stops, takes profit or expires.
  - A late row for H is the pair's next hour whenever it arrives. H and every
    held-back hour then apply in order (C7): with the breach, the stop fires
    once, at $0.69825; after a quiet hour, the position is still held.
  - A pair with no position and no live order goes on, because the rule
    applies only to exposed pairs. Its ATR waits 15 priced hours.
  - Nothing is done because of an unknown hour (C8, C9).
- **What is missing: the words.** Today the view says "XMPL/USDC has no
  recent closed hour in the book" (F9). That names no hour and does not say
  why every opening waits.
  - `trader-candles.js` records each held-back pair in its own status:
    `held_back: { hour, first_seen }`, where `first_seen` is the first read
    that held a later settled hour. The status becomes
    `cr.trader-candles-status.v2`; the paper journal is unchanged. The record
    clears when the hour arrives.
  - The adapter's view and Outcomes > Trader's Paper Book say, for example:
    "GeckoTerminal has no row for 01:00 and has one for 02:00, seen at 02:10.
    Whether the pool traded at 01:00 is not known. XMPL/USDC waits at 01:00
    until that row arrives. Until then the 24-hour drawdown is unknown, so
    every opening waits."
  - Once settled: "Settled by GeckoTerminal's row for 01:00, read at …".
- **While it waits**, stated on screen and in DESK_STATE:

  | Figure | While a held pair waits at H |
  |---|---|
  | Cash | Known: every fill before H |
  | Reserved for live buys | Known, the pair's included |
  | Available cash (cash − reserved) | Known; the pair's buy commit is not available |
  | A position on the pair | Value unknown from H's end |
  | A buy on the pair, ACKED, nothing filled | Whether it filled in H is unknown; its commit stays reserved |
  | A buy on the pair, PARTIAL | The filled part's value unknown; the remainder reserved |
  | A sell on the pair, live | Whether it filled in H is unknown |
  | NAV | Unknown at every hour end from H's end (PR 1b). Now: the latest close while under 120 minutes old, then unknown |
  | 24h drawdown, risk at the stops | Unknown while the window holds an hour end from H's end |
  | Room for an opening | None: every opening waits |

- **Its cost, stated.** A thin pool's quiet hour has no row, and it never
  will. So a held thin pair waits for good, and the whole book with it.
  - The pilot runs on that basis. The pair Eric pilots should trade every
    hour.
  - If the book stalls, the remedies are later, separate decisions: the
    write-off (C13) or the chain check (PR 2b).
- **Proof, each failing first.**
  - **C1.** The words above. No NAV at H's end or after (PR 1b already reads
    null). Nothing fills or stops.
  - **C7, both orders**, through `trader-candles.refresh` and the adapter:
    - with the breach, the stop fires once at $0.69825 (NAV $24,750.00);
    - after a quiet hour, the position is still held (NAV $24,995.92);
    - in both, the status clears and the words say how it settled.
  - **C9.** `first_seen` is the first read at or after 12:10, never earlier,
    and it survives a restart.
  - The table's rows for a held position, an ACKED buy with nothing filled
    and a PARTIAL buy, read from the view.
  - An unheld pair goes on, with ATR null for 15 hours, as on `main`.
- **Files.**
  - `trader-candles.js`;
  - `trader-desk.js`, for the view's words;
  - the Outcomes view and the bundle;
  - DESK_STATE, where "a missing hour stops that pair" becomes the words
    above;
  - tests.
- **Eric (D2).** Nothing to decide for this PR. Which pair to pilot, and
  whether to revisit the write-off later, are his calls.

### PR 2b and the write-off: deferred (C13)

Neither is in the initial repair. Their designs stay in #89's README for a
later decision.

- **The chain check** would settle a quiet hour as `no_trade` when the frozen
  pool had zero swaps. It covers constant-product and concentrated-liquidity
  pools, on networks with a read route.
- **The write-off** would value one pair's unknown exposure at its worst case
  for capital. It keeps capital safe, but not the drawdown breaker (C13). So
  it returns only as a risk-policy decision, with its own acceptance
  criteria.

### PR 3: atomic openings, sized exactly under the lock (F2, B, C4, C5, C10–C12, C14)

The second design's terminal sizing verdict (C14) and the third design's
snapshot protocol (Part 1d) are withdrawn. As the fourth review recommends,
the old PR 5's search now runs inside the reservation. Nothing of it is
built.

- **Scope.**
  - **`trader-desk.js` `assess`, unsubmitted opening, in this order:**
    1. **Terminal checks first**, before anything else, including the waits:
       `closeReasonOf` (undo, horizon, metric invalidation), the price
       invalidation, and what the frozen ticket alone settles (no grant, no
       stop or target, expired exit evidence). Any of them gives `not_opened`
       with its words. There is no reservation and no journal line.
    2. **The temporary waits**, in words, as today.
    3. **`PT.submitOpening`**, below. It answers `reserved` (then sent, as
       today), `waiting` with the limiting rule in words, or `not_opened`
       with a terminal reason.
  - **`paper-trader.js` ([P], `cr-paper@3`): one operation under the
    workspace lock.**
    - **It reads every input it relies on, once, at its own `now`:** the
      book's state; the decision in force (`decisions.jsonl`); the ticket's
      frozen exit reading and its age; the trader rules and the fee from
      settings. The lot and minimum are constants of the code. Decisions and
      settings take the same lock (Part 1d), so none of them can change
      during the operation.
    - **It sizes:** the largest whole-cent risk, at or under the intent's
      `risk_ceiling_usd` (Eric's grant), that the size-bound rules accept.
      Those rules are `risk_cap`, `drawdown`, `gate_cap`, `pm_cap`,
      `notional_cap`, `exit_cap` and `cash`.
      - The search is a bisection whose only arithmetic is the engine's: 16
        checks for $500, about 0.5 ms (Part 1d).
      - It is exact. The engine sizes the quantity as the risk over the loss
        per unit, floored to a lot. That never shrinks as the risk grows, and
        every rule above compares such a quantity against a fixed limit. So
        once one refuses, it refuses every larger risk.
      - The result is checked again in full, with the shared check below.
    - **It answers:**
      - temporary refusals only: `waiting`, with nothing written, so the
        opening ID is not spent;
      - a terminal refusal: recorded (`refused`), and the ID is spent;
      - otherwise: reserved, recording the risk it sized to beside the
        intent's ceiling.
    - **Existing paths:** `reserveIntent` and `submitIntent` keep their exact
      sizing, for closes and existing callers, and run the same shared check.
  - **The shared check.** One function every reservation of an `OPEN_LONG`
    runs, on every entry point: `reserveIntent`, `submitIntent` and
    `submitOpening`.
    - **`duplicate_opening` (terminal).** This decision already has a
      reserved opening under any intent ID, whatever its state now:
      RESERVED, SENT, ACKED, PARTIAL or FILLED, its position open or closed.
      A decision opens once, ever.
    - **`prior_exposure` (temporary).** Another decision on the same thesis
      still holds a position or a live order. That is F2's "one live paper
      exposure", now the book's rule.
  - **Ownership.**
    - One deterministic opening ID per decision (`intentIdOf(d, 'open')`, as
      on `main`), and its position is `pos-<ID>`.
    - Undo cancels that opening and closes that position, both found by the
      ID, never by a search.
    - No retries under new IDs.
- **What ends a request and what waits** (D3):

  | Waits, in words, checked again every step | Ends: `not_opened`, no reservation |
  |---|---|
  | Book unfunded; rules or fee unset | Undone or replaced |
  | An order not yet resolved; another decision's exposure on the thesis (`prior_exposure`) | The research horizon ended |
  | No recent hour, a stale price, ATR unknown; NAV, drawdown or open risk unknown, including a pair waiting at an unknown hour | The metric or the price invalidation fired |
  | Every sizing failure: `drawdown`, `cash`, `risk_cap`, `notional_cap`, `gate_cap`, `pm_cap`, `exit_cap`, `min_notional`, `size_zero` (C10, C14) | No grant, stop or target in the ticket; `price_order` |
  | `stop_distance` (ATR moves hourly); `allowlist` and the rules (Eric can change them) | Exit readings expired (PR 4); `duplicate_opening` |

  The wait is bounded: the exit readings expire 72 hours after they were
  taken, and the research horizon ends too.
- **Concurrency.**
  - The step is synchronous, and the whole reservation (inputs, search,
    write) runs inside one lock (`runOp`), so there is no snapshot to go
    stale.
  - Two steps for one decision cannot both reserve. The second finds the
    first under the same ID (`unchanged`), and a different ID is
    `duplicate_opening`.
- **Proof, each failing first.**
  - **C4.**
    - $176.12, the withdrawn formula, is refused. The search gives $176.11
      at $1,999.88078, and one cent more is refused.
    - Each bound binding first: the risk cap at $400, the notional cap at
      $291.08, the exits at $232.87, and cash. In each, one cent more is
      refused by that rule.
    - Lot boundaries: one cent adding less than a lot, and one cent adding
      several lots. Neither ever goes over a cap.
    - Fees: a second rate gives a different answer, still exact.
  - **C5.** The waiting Halve whose horizon ended reads `not_opened`, and
    the journal is byte-identical. The same for the metric invalidation.
  - **F2.** The second Halve waits (`prior_exposure`) while the sell is
    ACKED. Once the book is flat, it is reserved. Nothing is written while
    it waits.
  - **C10.**
    - At a drawdown of $999.21 it waits, naming the drawdown, and nothing is
      written.
    - At $0 it is reserved at $500 ($4,632.0636), once, under the same ID,
      with no new decision line.
  - **C11 and Part 1d's point 3, through each entry point** (`reserveIntent`,
    `submitIntent`, `submitOpening`):
    - a second opening for the decision is refused `duplicate_opening`,
      while the first is ACKED, while it is PARTIAL, once it has filled, and
      after its position closed;
    - another decision on the same thesis waits (`prior_exposure`).
  - **C12.** Another decision's reservation lands between two steps. The
    next step sizes against what the lock holds and never records a
    temporary refusal, so the ID is reserved once.
  - **C14.**
    - The $1.07 grant at a 0.3% fee waits, naming the minimum, and nothing
      is written.
    - After Eric sets 0.1%, it is reserved ($10.2738), once.
  - **Part 1d's point 4, with the journal's head unmoved:**
    - an Undo: refused, terminal, no order;
    - a fee change: sized with the new fee;
    - a sizing-rule change: sized under the new rule;
    - exit readings past 72 hours: refused, terminal, no order.
  - **Step 3 of the 12a test** becomes: Approve $500 at the $0.70 stop gives
    an order with exact figures, a position of at most $2,000 and a risk of
    at most $500, not a refusal.
  - **Undo** in each state: RESERVED, ACKED, PARTIAL, and the position open.
- **Eric (D3, D6).** The split above, and Approve as a ceiling, sized down
  under the lock.

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

### PR 5: show the size (B)

The search itself moved into PR 3, at the fourth review's suggestion. This
PR is what Eric sees. Nothing of it is built.

- **Scope.** `trader-desk.js` (the words), `PMDecisionCard.jsx` and the
  bundle, after PR 4.
  - **On the card, before Eric decides:** the implied position. For
    example: "$500 at this stop is a $2,717 position; exits are proven to
    $2,000."
  - **In the result:** the size. For example: "Asked $176.11 of your $500:
    the exit readings show $2,000 sells within 5%."
  - **In a wait:** the limiting rule. For example: "The 24-hour drawdown
    leaves room for $0.79 of risk, under the venue's $10 minimum; waiting."
- **Simpler, not more.** The engine, its limits and the gate don't change.
  The model still chooses no amount.
- **Proof.**
  - The adapter's words for C4, C10 and C14, taken from PR 3's results.
  - An `npm run check` fixture that shows the implied-position line and a
    waiting reason on the card.
- **Eric (D6).**
  - Approve is a ceiling, sized down to the evidence (recommended).
  - Or exact or nothing. That is today's behaviour, and most approvals open
    nothing.
  - Or the gate checks exits at the position the grant implies. That needs
    a new sizing version, more exit quotes per ticket and more quote budget.

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

It needs PRs 2, 3, 4, 5 and 7 (PRs 1 and 1b are merged).

- **(a) The backend integration test.** It was called "the readiness proof",
  and it ends at `TD.view`, so it proves the backend only. One FICTIONAL
  test drives the real path with no manual step:
  - `trader-candles.refresh` with a fake GeckoTerminal for two pairs. One of
    them leaves out an hour that held a stop breach (C1): the pair waits at
    H, and when the late row arrives it is stopped at $0.69825, once (C7).
  - Approve $500 through `T.decide`, sized down exactly (C4). It first waits
    on the drawdown, then opens once it clears, with no new approval (C10).
  - A second opening for that decision is refused (C11).
  - A grant under the venue minimum waits, then opens once Eric's fee
    setting allows it (C14).
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
    exact-size line, the missing-hour words (PR 2), the waiting words, and
    the not-opened reasons.
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
| D1 | Does the online trader book hold any journal record? | **UNKNOWN until Eric reads it** (Outcomes > Trader's Paper Book on the online desk). PR 1 (#87) and PR 1b (#90), both merged, are correct either way. Fund only after PR 8's two checks pass. |
| D2 (revised again) | An hour GeckoTerminal leaves out, on a pair the book holds | `main`'s behaviour, said truthfully (PR 2): the pair waits at H, a late row settles it (C7), and nothing is done because of it (C8, C9). The write-off and the chain check are deferred (C13). Eric's part: pilot a pair that trades every hour. If the book stalls, the write-off comes back only as a separate risk-policy decision. |
| D3 | What the book refuses before and at the reservation | The split in PR 3. Every sizing failure waits in words and writes nothing, so it never spends the opening ID (C14). Undo, the horizon, the invalidations, expired exit readings and a duplicate opening end the request. One opening per decision, enforced by the book on every entry point. Retries under new IDs are withdrawn (C11, C12). |
| D4 | Approve on expired exit readings | Refuse it, like INVALIDATED, and offer Renew. |
| D5 | What a renewal is | A new Prosecutor ticket on the same report. |
| D6 | What "Approve $500" means | A ceiling, sized down to the evidence by the exact search inside PR 3's reservation (the engine is the test), with the implied position shown on the card (PR 5). Under the venue minimum it waits, bounded by the exit readings' 72 hours (C10, C14). The proportional formula is withdrawn. |
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
  belongs in the reservation (PR 3), not the limits.
- No funding of the online book before PR 8's two checks pass on `main`.
  Suite totals show only that nothing regressed.
- No write-off in the initial repair (C13). It gives up the drawdown
  breaker in exchange for availability.
- No terminal verdict from sizing (C14): a fee or a rule Eric may change can
  make it executable.
- No snapshot protocol. The search fits inside the reservation's lock (Part
  1d).
- No "ready" from the backend test alone (PR 8 needs the user-visible check).
- No close, fill or cancellation because of an unknown hour, automatic or on
  Eric's word. It would either predate the hour's detection (C9) or turn
  unknown exposure into cash (C8).
- No retry under a new intent ID (C11), and no recorded refusal from a stale
  read (C12).
