# Next phase: blueprint (2026-10-27)

Eric's architect request of 2026-10-26 evening: establish where the desk
stands, design the next phase for its mission, put the work in the backlog in
executable form, and raise builder capacity to ten items an hour until
2026-10-27 23:00 New York time. This file is the blueprint and the backlog's
reasoning. The scheduler and the burst are in
[BUILDERS.md](BUILDERS.md) on the `claude/builder-burst` branch.

**The mission, as this plan reads it.** A private, trustworthy research desk
for Eric's positions of three to four months. Trustworthy means: what the desk
says is true and computed one way everywhere; what it does not know it says in
words; research, paper positions and real holdings stay apart; models keep
their own opinions; and nothing moves money or starts research without Eric.

## 1. Baseline (main at `b5f58dd`, 2026-10-27 03:40 UTC)

Read for this: `CLAUDE.md`, `COWORK-INSTRUCTIONS.md`, the mission and
architecture document, `DESK_STATE.md` (North Star and backlog), the 30-day
blueprint (`audits/2026-10-24-30-day-blueprint`), the engineering audits of
2026-10-25 and 2026-10-26, the workflows and rulesets, the live builder
routine, and the code named below. The full suite on main passed (1168 tests;
1182 with the scheduler's 14).

### Completed

| Area | State |
|---|---|
| Track 2 pipeline | Agent 1 research under `@6`, the desk's pre-gate (`cr-ticket-pregate@2`, Prosecutor from 48), Agent 2 tickets, sizing gate, PM Decision Card with geometry, prosecution matrix, disagreement card and headroom (items 1–62, all on main) |
| Paper Book | Paper positions from granted tickets, returns against BTC, MFE/MAE, the shadow gate with fixed 30-day cohorts, Outcomes as its own place (PR #42) |
| Daily Brief | Sections for PM cards with trade plans, invalidations, near invalidation, stale basis, repairs, pilot exits, held positions, research waiting, differences, spreads, freshness |
| Operations | `tickets run-cycle`, `reconcile`, `exit-matrix`, `digest`, the candidate board, read routes for each |
| Builder | Hourly routine (A), CI on every `claude/**` push, `backlog-pr` opens PRs, exclusive merge authority (PR #33: Eric merges every PR) |
| UI craft | PR #42: liveness, unknown values said, the 12.5px floor, Review without raw IDs, decision grid, inspector foot |

### Partial

- **Items 52–62 are merged but unticked.** Nothing ticks a box after Eric's
  merge since PR #33. The builder now reads trailers on main, so this is
  cosmetic. This PR ticks them.
- **Pilot operations run only from the CLI.** `runCycle` has no route and
  `auto-pilot-sync` no button. The online desk (phone) cannot run a cycle, and
  the connector cannot either (`mcp.js` is protected).
- **Desk-gate cards are decided one at a time.** Twelve $0 desk gates each need
  their own Pass or Watch.

### Broken (says something untrue or inconsistent)

- **Brief, "Pilot projects missing an exit reading".** With no project in the
  pilot it says "None right now", which reads as "every pilot project has its
  reading". `brief-daily.js` filters `in_pilot` and then finds nothing.
- **Two formulas for the same distance.** The near-invalidation radar measures
  `(price − stop) / stop` (`ticket-format.js` `nearInvalidation`). The card's
  geometry (`to_stop_pct`) and the held-position line (`position-brief.js`)
  measure `(price − stop) / price`. At a price of $2,600 and a stop of $2,534,
  one says 2.60% and the other 2.54%, for the same ticket on the same screen.
- **The brief points to a control that does not exist.** A held position of
  unknown cost reads "Set the cost in Portfolio > Needs attention (portfolio
  set-cost)". There is a route (`POST /api/portfolio/set-cost`, item 45) and a
  CLI command, but no form anywhere in the app.

### Blocked (waiting on Eric or on a protected path)

- **All sixteen PM cards are at $0.** That is the gate working as designed. The
  best firm `@6` grade is under 55, and no exit readings exist on the online
  desk. Nothing in this plan loosens a gate.
- **The research cadence ends.** The `cr-at6-surge` runner stops at 2026-10-27
  23:00 ET unless Eric extends it. This plan starts no research.
- **Item 47** (sizing `@3`) and the OLAS DefiLlama binding are Eric's.
- **Solana exits.** They always read "at least", because the transfer tax is
  unknown; changing that is a rule version for Eric.
- **Connector tools** for the cycle and for `desk_status` counts need `mcp.js`,
  which is protected.
- **Wallet sync** gets Alchemy 403 (the key is in Render's environment).
- **Gemini's hold.** `CLAUDE.md` says on hold; the online desk's settings say
  not.

### Missing

- **A horizon view.** Nothing tells Eric where each position is within its
  three-to-four-month horizon, or when research on it is due.
- **A plan R:R.** The card's reward:risk exists only while the price is under
  90 minutes old, and the online desk's prices are often older. The plan's own
  R:R (from its entry zone) needs no price and is never shown.

### Reconciled before writing anything

- **Builder routines.** One builder routine exists (A). It was updated, not
  duplicated, and no other burst or architect task exists.
- **Overlapping proposals were dropped or merged:**
  - "ticket outcomes" is already the Paper Book (items 31, 41, 55);
  - the telemetry card is item 58;
  - the exit matrix is item 61;
  - one-click reconcile is item 60;
  - Review IDs are PR #42 (L6), which supersedes the unpushed local commit
    `681a425` on `claude/quizzical-wiles-b264dd`.
- **Pending engineering work.** Engineering items 63–66 are merged and belong
  to the engineering lane. They are left as they are, and their candidate
  branches are already on main.
- **Numbering.** The next free number is 67: no intake branch or open PR holds
  one.

## 2. Design

Three groups, kept apart. Only the first two are executable, and only the
backlog's numbered items are.

### A. Essential repairs: the desk says one true thing

#### A1. The Daily Brief says what is true and leads with what is urgent (item 67)

- **Problem.** The brief is Eric's few minutes a day.
  - A vacuous "None right now" hides that nothing is in the pilot.
  - A risk-reducing ticket on a held position waits in a list ordered only by
    age, behind a dozen $0 desk gates.
- **Result.**
  - "No project is in the pilot" when that is the truth.
  - PM cards in order of consequence: risk-reducing tickets first (`TRIM_EXIT`, which the gate allows only on a held position), then
    tickets near invalidation, then the rest by waiting time.
  - The desk gates gathered into one line that names them.
- **Evidence.**
  - `brief-daily.js` `pilot_exits` (filters `in_pilot`, then nothing);
  - `pm_cards` (sorted by `saved_at` only);
  - the live desk: 12 desk gates waiting.
- **Choices.** Ordering is computed from fields the ticket view already
  carries (`proposal_type`, `near_invalidation`, `desk_gate`). No new record, and no
  change to the brief's format version: the sections and lines keep their
  shape.
- **Acceptance.**
  - With no pilot project, the section is one line with count 0.
  - With pilot projects all read, it is "None right now".
  - The order holds for a fixture with all three kinds.
  - The desk-gate line names each project and counts them.
  - Unreadable tickets still make the section partial.
- **Risk and recovery.** Display only. Revert the merge.

#### A2. One trade-plan geometry, `cr-ticket-geometry@2` (item 68)

- **Problem.** Two distances to the same stop. R:R vanishes when the price is
  stale.
- **Result.**
  - One base for every distance to the invalidation price: the fall from the
    current price, `(price − stop) / price`. It is used by the radar, the card
    and the held-position line.
  - The radar's threshold reads that fall (within 10%).
  - The geometry adds the plan's own R:R from the entry zone's midpoint, known
    without a fresh price, beside the R:R from now.
- **Evidence.** `ticket-format.js` `nearInvalidation` versus
  `tradePlanGeometry` and `position-brief.js` `distanceOf`.
- **Choices.**
  - **Why the fall from now.** It is what a holder loses before the stop, so
    the base is the price now.
  - **Versions.** The radar's rule changes, so it carries a version:
    `cr-near-invalidation@2`. Item 53's stop-based reading is `@1`, named in
    the code. The geometry becomes `@2` because it gains a field.
  - **Nothing stored changes.** Both are computed on read.
- **Acceptance.**
  - The three readings agree to the cent on shared fixtures.
  - A price 10.5% above the stop by the old reading is a 9.50% fall by the new one, so it now reads "near".
  - Plan R:R is null unless `upside > mid > stop`.
  - The brief's plan line gives "R:R 2.1x at plan, 1.4x now" or says why "now"
    is unknown.
  - The card shows both.
- **Risk and recovery.**
  - Which tickets read "near" changes slightly, and the version says so.
  - Revert the merge.

#### A3. Set the cost where the desk asks for it (item 69)

- **Problem.** A held position of unknown cost has no result. The desk sends
  Eric to a form that does not exist.
- **Result.** In Portfolio > Needs attention, a row for a position of unknown
  cost offers "Set cost". The form takes the average cost in USD, an optional
  acquired date and a reason. It posts to the existing
  `POST /api/portfolio/set-cost` and shows the server's words about the date
  (item 45).
- **Evidence.**
  - `position-brief.js` `pnlOf`'s words;
  - no `set-cost` in `dashboard/web/src` or `dashboard/public/views`.
- **Choices.**
  - It uses the existing route and its checks. No new write path, and no
    change to `core/portfolio.js` (protected).
  - The field starts empty, never prefilled from a price: a cost is Eric's
    fact.
- **Acceptance.**
  - The action appears only on unknown-cost rows.
  - The posted body is exactly what was typed.
  - A refusal from the route is shown in its words.
  - `position-brief`'s sentence names the control as it is.
- **Risk and recovery.**
  - It writes a ledger record, but only on Eric's click, through the guarded
    route.
  - A wrong cost is corrected the standard way (void with a reason).
  - Revert the merge for the UI.

### B. Product improvements: Eric's few minutes, and the 3–4 month horizon

#### B1. Decide desk gates together (item 70)

- **Problem.** Twelve $0 desk-gate cards, each with its own Pass or Watch.
- **Result.**
  - "Watch all n" and "Pass all n" in Research's Track 2 Pilot Queue.
  - Each button first shows the dry run: names, and for Pass which unheld
    projects it archives.
- **Choices.**
  - **Shared core.** `tickets.decideDeskGates` calls the existing `decide` once
    per receipt. Each card keeps its own seen check, journal line and Undo.
    There is no new decision kind.
  - **Expect, as elsewhere.** The route takes `expect` (the receipt IDs shown),
    as the batch gate does. A different set is 409, with nothing written.
  - **Not all-or-nothing.** A failure part-way leaves the earlier decisions
    standing and names the rest. A replay with the same `request_id` completes
    them, because `decide` is idempotent per request.
  - **Scope.** Approve and halve are not offered; desk gates take only pass,
    watch and undo.
- **Tradeoff (consequential).** One click makes n decisions, and Pass archives
  unheld projects. Mitigations:
  - the dry run names every project;
  - `expect` binds the click to that list;
  - archive is reversible (Restore);
  - each card keeps its Undo.
- **Acceptance.**
  - A dry run writes nothing.
  - A changed set is 409.
  - Held projects never archive.
  - Each decision appears in its project's journal.
  - CLI `tickets decide-gates` matches the route.
- **Risk and recovery.**
  - Undo per card, Restore per project.
  - Revert the merge for the code.

#### B2. Run the pilot cycle from the desk (item 71)

- **Problem.** The cycle (opt-ins, desk gates, exit quotes, queue) runs only
  from the CLI on this PC. The online desk, which is Eric's phone, cannot run
  it.
- **Result.**
  - `POST /api/tickets/run-cycle` with `dry_run`, `limit` and `expect` (the
    counts shown).
  - A "Run pilot cycle" button in the Pilot Queue: dry run first, then the run,
    then the receipt's counts and next steps.
- **Choices.**
  - **Same rules as the routes it composes.** The 409 rule matches
    batch-gate's and auto-pilot-sync's.
  - **Quotes.** They use the existing adapter, budget, gates and the restored
    copy's hold, unchanged.
  - **Never research or a model.** The route starts no research, writes no
    ticket text and calls no model.
- **Acceptance.**
  - A dry run writes nothing and asks no provider.
  - A run that would do more than `expect` is 409.
  - A restored copy makes no quote request.
  - The receipt's format is `runCycle`'s.
- **Risk and recovery.**
  - Quotes spend the monitor's own budget, which caps itself.
  - Opt-ins and gates are reversible (pilot toggle; Undo, Restore).

#### B3. Horizon checkpoints in the Daily Brief (item 72)

- **Problem.** Positions are held for three to four months, but nothing says
  where each stands in that time, or when its research is due.
- **Result.** A brief section, "Horizons", with two kinds of line that never
  mix:
  - **Held.** Each ledger position with a ticket in force: day n of its
    horizon, the next 30/60/90/120-day mark from the decision, the horizon's
    end, and research age against `freshness.report_stale_days` ("research
    due").
  - **Paper.** Each open paper position, with the same timing from `paper.js`'s
    horizon.
  - An unknown horizon is said (`horizon_missing`), never given a default
    length.
- **Choices.**
  - It reads `position-brief` and `paper.book`, and stores nothing.
  - The checkpoint marks match the report outcomes' 30/60/90/120 so the two
    views line up.
- **Acceptance.**
  - Held and paper lines are labeled and separate.
  - A position at day 61 names day 90 next.
  - Past the horizon's end, it says so.
  - Stale research is "research due" with its age.
  - An unreadable record makes the section partial.
- **Risk and recovery.** Display only. Revert the merge.

### C. Longer-term ideas: not approved, not executable

These need Eric's decision, a protected path, or a method the desk does not
have yet. They are not in the backlog as items:

- **Thesis-break alerts sent to Eric.** The brief already computes them. Sending
  them (email or push) is a messaging channel Eric chooses.
- **Connector tools for the cycle and the counts.** `mcp.js` is protected.
- **Read-only exit readings on the online desk.** These would come from reserve
  reads. The forensics and netguard paths are protected, and so is the
  liquidity rule.
- **A calibrated outcome method once 20 reports mature.** No percentage is
  shown until a method is registered, so this is Eric's rule to approve.
- **A post-mortem per closed position.** It would set the thesis against what
  happened, and needs Eric's choice of what to record.
- **ChatGPT as a second Prosecutor** (`cr-ticket-challenge@1`). This is
  already Eric's open item.

## 3. Backlog (Phase 6, in `DESK_STATE.md`)

| ID | Priority | Item | After | Touches | Kind |
|---|---|---|---|---|---|
| 67 | P1 | The Daily Brief says what is true, urgent first | none | `core/brief-daily.js` | repair |
| 68 | P1 | One trade-plan geometry, `@2` | none | `core/ticket-format.js`, `core/brief-daily.js`, web | repair |
| 69 | P1 | Set cost in Needs attention | none | `public/views/portfolio.js`, `core/position-brief.js`, web | repair |
| 70 | P2 | Decide desk gates together | none | `core/tickets.js`, `server.js`, `cli.js`, `public/views/research.js`, web | improvement |
| 71 | P2 | Run the pilot cycle from the desk | none | `server.js`, `public/views/research.js`, web | improvement |
| 72 | P2 | Horizon checkpoints | 67 | `core/brief-daily.js`, `core/position-brief.js` | improvement |

**Order.** Repairs first, then Track 2 improvements, then the horizon. Every
item serves Track 2 or the positions Eric reads (North Star).

**Conflicts.** Items that touch the same file serialize on their own (the
scheduler's `touches`). `web` is one unit because the bundle is rebuilt as a
whole. So:

- 68, 69, 70 and 71 run one after another;
- 67 and 72 share the brief.

**First execution batch.** The first run after both PRs merge claims 67–71 as
one branch. They are built one after another, the whole suite runs after each,
and one push follows. The next run, half an hour later, finds 72 waiting
behind 67 until that branch is the base. Then it builds 72 on top.

With six items, the hour's ceiling of ten is not the limit; the files they
share are. The capacity is there for the items that follow.

**Every item:**

- stays out of protected paths;
- adds its tests to the files named;
- rebuilds the bundle after web edits;
- runs the whole suite;
- carries `Backlog-Item: <n>`.

`backlog-pr` opens the PR. Eric reviews and merges it, and Render deploys main.
Recovery is reverting the merge. Nothing here stores a new kind of record, and
the writes (item 69's cost, item 70's decisions) go only through existing,
guarded routes on Eric's click.

## 4. Decisions made here, and the ones left to Eric

**Made (routine).**

- Item numbers 67–72.
- Merging overlapping proposals: the brief order with the pilot-exit fix;
  geometry with the radar.
- The fall-from-now base for distances.
- Plan R:R from the zone's midpoint.
- The horizon marks matching report outcomes.
- Item 46 is held for Eric rather than closed. Since PR #33 there is no merge
  for it to follow, so closing or rewriting it is his call.

**Consequential tradeoffs, stated.**

- **Item 68.** It changes which tickets read "near invalidation", by a little.
  Mitigation: a version.
- **Item 70.** One click makes n decisions. Mitigations: dry run, expect,
  Undo, Restore.

**Eric's (not executable).** These are listed under the backlog in
`DESK_STATE.md`, apart from the numbered items:

- merging the two PRs;
- the research cadence;
- item 47 and the OLAS binding;
- the Solana tax rule;
- the Gemini hold;
- connector tools;
- brief delivery;
- the wallet key;
- the rulesets' branch list;
- item 46;
- the rollback drill record;
- deleting builder B.
