# Desk state: the Junior Trader pipeline (Phase 1)

Last updated 2026-10-27. This page covers the PM trade ticket pipeline and the contract for the trader to come. The rest of the desk is described in `CLAUDE.md` and `COWORK-INSTRUCTIONS.md`.

## North Star: Track 1 serves Track 2 (Eric, 2026-10-25)

Two tracks run on this desk:

- **Track 1, the self-building codebase.** The backlog below, built by the scheduled builder and merged by `backlog-pr.yml`.
- **Track 2, the autonomous Junior Trader desk.** Agent 1 researches, the desk measures exits, Agent 2 prosecutes and structures a trade plan (`entry_zone`, `upside_target`, `invalidation_trigger`), and the desk sizes it by Eric's rules. Eric sits in the PM seat for a few minutes a day: Approve Risk ($500), Halve ($250), Veto or Pass.

Track 1 exists to serve Track 2. Every backlog item must directly improve one of four things:

1. Agent 1's research.
2. The desk's exit measurements (Forensics > Exits).
3. Agent 2's prosecution and trade plan.
4. The PM Decision Cards and Paper Book outcomes Eric reads, kept clear and uncorrupted.

An item that serves none of these is not added, or waits behind the ones that do. The invariants still hold:

- the desk's gate sizes every ticket, and a model never chooses an amount;
- the two agents are never averaged;
- paper stays apart from the portfolio;
- unknown is never 0;
- nothing places an order, connects a wallet or exchange, or moves money.

## System Architecture & Conventions

Eric, 2026-10-27 (`audits/2026-10-27-pm-builder/README.md`).

**Topology:**

- **The desk** runs on Render from `main` (`server.js` → `dashboard/hosted.js`). Its records live on Render's disk and never in Git.
- **The agent lane** builds the Active Backlog below, one task at a time:
  1. The PM, `agent-builder-lane.yml` running `dashboard/scripts/agent-pm.js`, picks the first `[TODO]`.
  2. `agent-build.yml` reserves the build in the ledger, then Claude Code builds it in the sandbox with read-only contents and only the Anthropic key.
  3. The guard re-checks the diff, and the builder App publishes `agent/task-<n>` and opens the pull request.
  4. `test`, `agent-guard`, `agent-verify` and `agent-review` (ChatGPT) run on it.
  5. On a pass, the PM posts "PM Site Inspection: PASSED". On a failure, the PM's diagnosis (ChatGPT) and Claude's fix, at most 3 per task version, then `[BLOCKED: Needs Human Architect]`.
  6. Eric merges.
- **The cloud routines** build the numbered Autonomous Build Backlog further down; that list is theirs. Deprecated (Eric, 2026-10-27): once the lane is on, `agent-builder-lane.yml` is the only builder on a schedule. The routines (builder A hourly at :55, builder B for the burst) live in claude.ai, outside this repository, and are paused there by Eric; their list stays as history. No workflow here runs `backlog-schedule.js` on a schedule (`dashboard/tests/agent-workflows.test.js`).

**Authority:**

- Only Eric updates `main`, by merging a pull request. A task block on `main` is his authorization for its build and its automatic fixes, as his `agent:build` label is for an issue.
- The lane writes a task's status only on its candidate branch:
  - `[IN_PROGRESS: PR #n]` when its pull request opens;
  - `[BLOCKED: Needs Human Architect]` at a block;
  - `[DONE]` for a task whose `[IN_PROGRESS]` line reached `main` by its merge.
- A candidate never adds, edits or reorders a task.
- Nothing in the lane merges, approves or writes `main`.

**Component contracts:**

- `eng-backend@1` is core logic and server routes: `dashboard/core/**`, `dashboard/server.js`, tests.
- `eng-app@4` is the browser app and its pure models: `dashboard/web/src/**`, `dashboard/public/**`, tests. It never adds a server route. The lane rebuilds the committed bundle from the source with `main`'s build files, and `agent-verify` checks it.

**Testing:**

- `node dashboard/cli.js test` runs the whole suite on temporary fictional workspaces.
- Every candidate adds or changes a test of its outcome.
- The server needs no npm packages.
- Unknown is said in words, never 0 or "none".

## Active Backlog

The agent lane's queue, built strictly in order. Each block's Status is one of `[TODO]`, `[IN_PROGRESS: PR #<n>]`, `[DONE]` or `[BLOCKED: <reason>]`. Template is `eng-backend@1` or `eng-app@4`. Outcome, Acceptance checks and Negative cases are the task; Files to change and Regression tests are hints. Editing a task's fields makes a new version: the lane builds it fresh, with its own budget.

### TASK-001 · Paper Book cell on the stored book
- **Status:** [TODO]
- **Template:** eng-backend@1
- **Outcome:** The Desk reads the Paper Book's numbers from the stored paper book through one read-only route. `dashboard/core/paper-book.js` gains `paperBookCell(book)`, a pure function over what `require('./paper').book(ws)` returns (`cr.paper-book.v1`), and `dashboard/server.js` serves it at `GET /api/paper/cell` from `paper.book(ws)` inside `coherent`. `computePaperBookSummary` stays as it is.
- **Acceptance checks:**
  - `paperBookCell` returns `format` "cr-paper-cell@1", `as_of` from the book, `open_positions`, `open_risk_usd` (the sum of `risk_usd` over positions whose `state` is "open"), `closed`, `measured_closed` and `min_closed` (paper.js `MIN_CLOSED`).
  - Below `MIN_CLOSED` measured closes it returns `result: { status: "too_few", words }`, the words being the book's own `summary.note`, and no median, hit count or total anywhere in its answer.
  - At or above it, `result: { status: "measured", median_vs_btc_pct, beat_btc, of }`, copied from the book's `summary` and never recomputed.
  - `GET /api/paper/cell` answers 200 with that shape on a temporary fictional workspace with no paper records (`open_positions` 0, `result.status` "too_few") and writes nothing.
  - `dashboard/tests/paper-book.test.js` covers a fictional book with two open positions (risk 100 and 50.25), one closed and one voided; a book with 20 measured closes; an empty book; and a book without `summary`.
- **Negative cases:**
  - Never a median, hit rate or total below `MIN_CLOSED`, and never 0 in place of one: the words say too few.
  - An unknown is never $0. A missing book, or one without `summary`, gives `result: { status: "unknown", words }`. An open position without a numeric `risk_usd` makes `open_risk_usd` null, and `unpriced_open` counts it.
  - It never reads or changes the portfolio, the ledger, wallets or any record, and requires no outside package. The existing `computePaperBookSummary` tests pass unchanged.
- **Files to change:**
  - dashboard/core/paper-book.js
  - dashboard/server.js
  - dashboard/tests/paper-book.test.js
- **Regression tests:**
  - dashboard/tests/paper-book.test.js

### TASK-002 · Paper Book cell in the Desk status strip
- **Status:** [TODO]
- **Template:** eng-app@4
- **Outcome:** The Desk's KPI strip gains a Paper Book cell, drawn from `GET /api/paper/cell` (TASK-001):
  - the open paper positions and their open paper risk;
  - the 30-day result against BTC only once the book has enough closed positions, otherwise its words for too few.

  The words come from a pure `paperCellWords(cell)` in `dashboard/public/watchlist-model.js`. `dashboard/web/src/views/watchlist/StatusStrip.jsx` draws them and opens `#/research?tab=outcomes` on click. The committed bundle is rebuilt by the lane.
- **Acceptance checks:**
  - `paperCellWords` turns a `cr-paper-cell@1` answer into a label "Paper book", a figure, and an accessible name that says the cell in full.
    - The figure for open positions is "2 open · $150.25 at risk".
    - For a measured result it is "+3.10% vs BTC (12 of 20 beat)", with the sign and two decimals.
    - For too few, it is the answer's own words.
  - The cell is one more cell in the strip's panel, with the same hairline. On a phone it steps aside as Total does, and its accessible name keeps it.
  - It is read once when the Desk opens; a failed read reads "Paper book unknown" with the reason in its tooltip.
  - `dashboard/tests/paper-cell-words.test.js` covers each case, plus an answer with `open_risk_usd` null and one with `result.status` "unknown".
- **Negative cases:**
  - Never "$0" or "0%" for an unknown or a too-few result: the words say it.
  - No text under 12.5px. Meaning is never colour alone: a rise or fall also has its sign.
  - Opening the Desk writes nothing and asks no paid provider. Paper figures never enter Portfolio.
- **Files to change:**
  - dashboard/public/watchlist-model.js
  - dashboard/web/src/views/watchlist/StatusStrip.jsx
  - dashboard/tests/paper-cell-words.test.js
- **Regression tests:**
  - dashboard/tests/paper-cell-words.test.js

## What it does

It closes the loop on one asset at a time:

1. **Agent 1, the Researcher.** Claude's normal investment research (`cr-research-prompt@6`). Its saved report is the basis for the ticket.
2. **Agent 2, the Prosecutor.** A separate Claude session under `cr-ticket-prompt@1`. It plays a short-seller on a risk committee and attacks Agent 1's report with four tests (mercenary emissions, revenue from trade taxes, AMM exit slippage, unverified claims). It ends in a structured ticket (`cr.ticket.v1`).
3. **The desk.** It adds what no model may decide:
   - the exit cost at $500 and $2,000, from its own exit-quote readings;
   - the suggested risk, from Eric's sizing rules;
   - the status, from Eric's decisions and an invalidation check run each time the ticket is read.
4. **Eric, the PM.** On a ticket that suggests risk: Approve Risk, Halve Size or Veto / Archive. On a $0 ticket: Confirm Pass & Archive (archives the project unless held; Undo restores it), Override → Watch, or Acknowledge Trim. Statuses: `risk_granted`, `vetoed`, `passed`, `watching`, `trim_acknowledged`. A decision records his choice. **Nothing places an order or moves money.**

The two agents are never averaged. Each keeps its own figure and verdict, shown side by side, with the spread (Researcher minus Prosecutor).

No paid API key is needed. Both agents run on Eric's Claude subscription, through the connector or through `claude -p`. The paid-API runner in `research.js` still works for Agent 1 if keys are added in Render later.

## Sizing rules (`cr-ticket-sizing@2`, Eric's choices; `@1` tickets keep theirs)

| Rule | Value |
|---|---|
| Standard risk (1.0R) | $500, only when the measured exit cost at $500 is at most 5% (known in full, not a lower bound) and Agent 1's grade is at least 55 |
| Starter tranche (0.5R, "Halve Size") | $250 |
| Grade under 40 | no new risk (HARD_PASS or WATCH_ONLY), $0 |
| Grade under 55, not held | no new entry, $0 |
| Held, any grade | TRIM_EXIT is always allowed (it takes no new risk) |
| Native L1, $10B+ market cap (`@2`) | passes the exit check without a DEX quote (`exit_basis: native_l1_liquid`); the grade floors still apply |

- The grade is the desk's calculated grade of Claude's current report. A range is read by its low end; a withheld grade means no grade.
- A proposal the rules don't allow is capped to WATCH_ONLY at $0. The model's own type is kept beside the capped one, with the reason.
- Eric edits them in Preferences > Screening ("Your ticket sizing"), saved as settings `tickets.sizing`. Each ticket freezes the values it was made under.

## Records (files, create-only, backed up with the project)

```
projects/<id>/tickets/
  profile.json                      pilot opt-in { pilot, pilot_set_at, pilot_set_by }
  <tk_...>/ticket.json              the job: frozen basis (Agent 1 report ID and text SHA-256,
                                    grade, exits, held, price), sizing in force, prompt pin, job state
  <tk_...>/packet.json              frozen evidence packet (cr.ticket-packet.v1), SHA-256 pinned
  <tk_...>/prompt.md                frozen Prosecutor prompt, SHA-256 pinned
  <tk_...>/drafts/prosecutor.md     working draft, never a receipt
  receipts/<tr_...>.json            the saved ticket (cr.ticket-receipt.v1): prosecution, proposal,
                                    desk { gate, proposal_type, suggested_risk_usd, exit_cost_500_usd_pct, ... },
                                    agent_disagreement { researcher, prosecutor, spread_points, note }
  receipts/<tr_...>.md              the full text as saved
  decisions.jsonl                   Eric's decisions, append-only (approve, halve, veto, pass, watch, trim, undo),
                                    each with pm_approved_risk_usd
```

- **Status:** `pending_pm_review`, `risk_granted`, `vetoed`, `passed`, `watching`, `trim_acknowledged` or `invalidated`. It is computed every time the ticket is read and never stored.
- **Invalidation (`cr-ticket-invalidation@1`):** the ticket is invalidated when either of these fires:
  - any hourly price since the ticket was saved is at or below the invalidation price;
  - the bound DefiLlama 30-day total, fetched after the ticket, is under its floor.
- An unbound metric reads "not checked", never "holding".
- Supabase is not used. Tickets are files, like every other record.
- **Schema:** `templates/schemas/ticket.v1.schema.json`.
- **Prompt:** `templates/tickets/ticket-prompt.v1.md`, pinned in `templates/tickets/LOCK.json`. A change means publishing v2; never edit v1.

## Connector tools (`dashboard/mcp.js`, Claude only)

| Tool | What it does |
|---|---|
| `autonomous_pilot_queue` | Read-only. Gives each pilot project's next step: `research` (Agent 1), `ticket` (Agent 2), `pm_review` or `done`, with the call to make |
| `start_ticket` | Opens or resumes the ticket on Claude's current report and returns the frozen prompt byte for byte |
| `pending_tickets` | Read-only. Lists open tickets; with `include_prompt`, also returns the next one's prompt |
| `save_ticket` | Saves the finished text with its JSON block. Fields that don't match the ticket are refused one by one. The same text again returns the same receipt; a different text needs `revision.note` |

ChatGPT and Gemini have no ticket role in Phase 1.

## HTTP routes (`dashboard/server.js`)

- Reads (write nothing): `GET /api/projects/<id>/tickets`, `.../tickets/<tk>/prompt`, `.../tickets/receipts/<tr>/text` (pins checked).
- Writes: `POST .../tickets` (open), `.../tickets/<tk>/import` (save), `.../tickets/decisions` `{ receipt_id, action, request_id }` (a newer ticket is 409 `NEWER_REPORT`), `.../tickets/pilot` `{ on }`.

## Sub-agents and commands (Claude Code, Eric's subscription)

| File | Role |
|---|---|
| `.claude/agents/forensic-researcher.md` | Agent 1. Runs one research step (`cr-research-prompt@6`, five working phases: load, identity and on-chain, AMM exit from the desk's readings, fundamentals, save). Never touches tickets |
| `.claude/agents/junior-trader-prosecutor.md` | Agent 2. In its own context, `start_ticket` → frozen `cr-ticket-prompt@1` → `save_ticket` (or the CLI). Never sizes, decides or orders |
| `.claude/commands/pilot-run.md` | `/pilot-run [project] [online\|local]`. Reads the pilot queue and hands each step to the right sub-agent until `pm_review`. Works under `/loop` or `/schedule` |

## CLI and the one-command runner

```
node dashboard/cli.js tickets queue [<id>]        next step per pilot project
node dashboard/cli.js tickets pilot <id> --on     opt a project in
node dashboard/cli.js tickets start|prompt|import|view|decide|cancel ...
npm run pilot -- --project=olas                   whole chain on this folder's desk
npm run pilot -- --project=olas --desk=online     whole chain on the online desk, via the connector
npm run pilot -- --project=olas --dry-run         say what would run
npm run pilot -- --project=olas --desk=online --force-prosecution [--owner-words="…"]
                                                  a Prosecutor although the gate closed on the grade (Eric's override; the gate still sizes it)
```

- `dashboard/scripts/pilot.js` runs each agent as its own `claude -p` session, with the prompt on stdin.
- Only web search and fetch are allowed. In online mode the CryptoResearch connector tools (`mcp__claude_ai_CryptoResearch`) are allowed too.
- Local mode saves through the CLI, so every save is verified. The chain stops at `pm_review`.

## How the OLAS pilot chain runs

OLAS is `olas-autonolas` and lives only on the online desk.

1. The queue says `research` when Claude's report is missing, older than 90 days or has a Claude run open; Agent 1 researches and saves.
2. It then says `ticket`. `start_ticket` freezes the packet (Agent 1's report ID and hash, grade, exits at $500 and $2,000, price, sell tax, DefiLlama, held, sizing) and the prompt with the report fenced as evidence. Agent 2 prosecutes and saves.
3. The desk sizes it, the queue says `pm_review` and the inspector shows the PM Decision Card. A new Claude report sends the queue back to `ticket`; the old ticket is kept and marked superseded.
4. The $500 tier needs a current exit reading: approve exit quotes (Forensics > Exits). Without one the ticket is capped at $0, saying why.

Live tickets (2026-10-24), both $0 and waiting for Eric: OLAS `tr_2026-10-24T175256Z_g3cug`, HARD_PASS (Researcher 26.3, Prosecutor 15). ZAMA (held) `tr_2026-10-24T182937Z_vzsbf`, TRIM_EXIT (Researcher 35.5, Prosecutor 18; invalidation $0.045). Neither has an exit reading or a DefiLlama binding.

## UI files

| Part | File |
|---|---|
| PM Decision Card (inspector drawer) | `dashboard/web/src/views/inspector/PMDecisionCard.jsx`, styles in `dashboard/web/src/styles/inspector.css` (`.pm-*`) |
| Where it sits in the drawer | `dashboard/web/src/views/inspector/ModelPanel.jsx` (between Thesis and Needs you). In the pilot, Claude's "Open the prompt" line is dropped |
| Review queue rules | `dashboard/public/review-model.js` and `dashboard/public/watchlist-model.js` (`reviewReasons`, `lowGradeHidden`, `LOW_GRADE_FLOOR` 40) |
| Review page | `dashboard/web/src/views/review/Review.jsx`: "n graded under 40 hidden (not held) · Show"; `?low=1` shows them |
| Index row field | `dashboard/core/indexer.js` adds `ticket` (from `tickets.summary`) beside `forensic` |

- **Hidden from Review:** projects graded under 40 that Eric does not hold. They are left out of both the Review queue and the Desk's Needs review count, which stay equal (D3). The count of hidden projects is shown.
- **In Review:** a pending ticket is a "Waiting on you" reason.

## Tests

- `dashboard/tests/tickets.test.js` covers the sizing gate, the prompt pin, freezing and integrity, field-by-field refusal, $0 caps, side-by-side agents, decisions and undo, invalidation on read (writes nothing), the pilot queue and connector roles.
- `dashboard/tests/review-queue.test.js` covers the under-40 filter and the pending-ticket reason.
- Run everything with `node dashboard/cli.js test`. After any UI edit, rebuild the bundle with `npm run ui:build`.

## System Architecture & Conventions

### Junior Trader Desk Invariants (Future-Proofing Contract)

Eric, 2026-10-27. The contract for the autonomous trader still to be built, so the sandbox, the ledger (`dashboard/scripts/agent-ledger.js`) and the desk's deterministic gates carry unattended trading without rework. The pre-trade risk engine (`dashboard/core/trade-risk.js`, `cr-trade-risk@1`, PR #58) and the trader's Paper Book (`dashboard/core/paper-trader.js`, `cr-paper@2`, PR #59) are built as library code; no route, CLI, connector tool, UI or agent calls them, and nothing routes anywhere. The North Star invariants above stay in force: today nothing places an order, connects a wallet or exchange, or moves money.

1. **Separation of proposal and execution.** The LLM agent is an analyst only. It never holds execution API keys and never signs a transaction. It emits a typed `TradeIntent` (below). An out-of-band deterministic engine intercepts, validates and routes it; while invariant 5 holds, it routes only to the Paper Book.
2. **Stateless shift work.** The trader runs in discrete, stateless evaluation cycles during the target market's liquidity windows. Each tick re-derives its state from disk only (`DESK_STATE.md`, open position records, fill journals) and exits. No long-lived chat memory.
3. **Immutable risk boundary.** The risk limits are hard-coded in the engine, outside the model's context window: at most 2% of the Paper Book's NAV (`cr-paper@2`, below) at risk per trade; a stop-loss on every trade, no nearer the entry than the minimum stop distance; an asset allowlist; and a hard ceiling on drawdown of 4% of NAV in any rolling 24 hours (Eric, 2026-10-27). The agent cannot alter, soften or bypass them. The engine (`dashboard/core/trade-risk.js`), both Paper Books (`dashboard/core/paper.js`, `paper-trader.js`) and the exact arithmetic they compute with (`dashboard/core/decimal.js`) are protected files.
4. **Reconciliation and nonce guard.** The engine inherits the ledger's pattern: a hash-chained, append-only record written by compare-and-swap; every action reserved before it is sent; each recorded verdict signed with an HMAC-SHA256 MAC under a key the agent never holds (`AGENT_LEDGER_KEY` in the build lane). An order never times out to `lost` (pipeline review, 2026-10-27), and since the red-team review the same day no clock settles a build either (`agent-ledger.js` `settleOpen`).
   - **States.** `INTENT` → `RESERVED` (the `intent_id` and the `client_order_id` derived from it, recorded before anything is sent) → `SENT` → `ACKED`, `REJECTED` or `UNKNOWN`; then `ACKED` → `PARTIAL` → `FILLED`, `CANCELLED` or `EXPIRED`.
   - **Unknown stays unknown.** A timeout, a dropped broker WebSocket or an answer that does not read makes the order `UNKNOWN`. It stays `UNKNOWN` until the engine has asked the venue for that `client_order_id` and recorded the venue's answer. It becomes `NOT_FOUND` only when the venue says so after the venue's own duplicate-order window has passed, never on the engine's clock alone.
   - **No new action while unresolved.** While any order is `RESERVED`, `SENT` or `UNKNOWN` (one that may be live with no answer on record), the engine opens no new intent. It never resends an order under a new `client_order_id`: a resend carries the same one, so the venue refuses a duplicate.
5. **Sovereign capital governance.** The agent trades only on the simulated Paper Book (`cr-paper@2`, below; nothing routes to it yet). The PM Paper Book (`cr-paper@1`, `paper/positions.jsonl`; item 18) keeps measuring Eric's ticket decisions apart from it. Promoting any strategy to live execution needs Eric's own explicit, authenticated commit or signature on `main`.

### `TradeIntent` schema (`cr.trade-intent.v2`)

Every trade proposal from the agent is one JSON object of this shape (pipeline review, 2026-10-27). The first draft, `cr.trade-intent.v1` (2026-10-27), was never published or built, and no engine accepts it.

```json
{
  "version": "cr.trade-intent.v2",
  "intent_id": "string, a ULID, one per intent",
  "thesis_id": "string (e.g. THESIS-BTC-001)",
  "pair": "string (e.g. BTC/USDC), exactly as the allowlist names it",
  "side": "OPEN_LONG | CLOSE_LONG",
  "position_id": "string, only for CLOSE_LONG: the open position it closes",
  "order_type": "LIMIT | POST_ONLY",
  "created_at": "ISO-8601 UTC timestamp",
  "reference_price": "decimal string: the price the intent was written against",
  "reference_at": "ISO-8601 UTC timestamp of that price",
  "entry_price": "decimal string: the limit price",
  "stop_loss_price": "decimal string",
  "take_profit_price": "decimal string",
  "risk_ceiling_usd": "decimal string: the most the trade may lose at its stop",
  "max_slippage_bps": "integer, at most 20",
  "valid_until": "ISO-8601 UTC timestamp",
  "evidence": {
    "catalyst": "string",
    "metrics_evaluated": ["string"],
    "negative_invalidation": "string"
  }
}
```

What the engine holds it to:

- **One intent, one order.** `intent_id` is the engine's idempotency key: the same `intent_id` again is the same intent, never a second order. The engine derives the `client_order_id` from it (invariant 4). The agent never sets one.
- **Decimal strings.** Every price and amount is a plain decimal string (`^\d+(\.\d+)?$`: no sign, exponent, NaN or Infinity), read exactly and never through a binary float. Sizes are computed in exact decimals at the venue's tick and lot.
- **Explicit side, long only.** `OPEN_LONG` needs `stop_loss_price` < `entry_price` < `take_profit_price`. `CLOSE_LONG` names an open `position_id` of the Paper Book and closes no more than it holds. Nothing opens a short; there is no BUY or SELL to misread.
- **Minimum stop distance.** `entry_price − stop_loss_price` is at least the larger of `STOP_MIN_PCT` × entry and `STOP_MIN_ATR` × the pair's 14-hour ATR. A stop one tick from the entry would turn a small risk ceiling into a huge position. Eric sets both figures. Until he does, or while the ATR is unknown, every intent is refused (unknown is never 0).
- **Size and notional cap.** The quantity is `floor_to_lot(risk_ceiling_usd / (entry − stop))`, never rounded up; zero is a refusal. Its notional (quantity × entry) is at most the smaller of `NOTIONAL_MAX_PCT` × NAV and the largest size the desk's exit measurement (Forensics > Exits) shows can be sold within the slippage limit. Eric sets `NOTIONAL_MAX_PCT`; unset refuses.
- **Risk is checked, never adopted.** The desk's gate sizes every ticket and a model never chooses an amount (North Star). The engine refuses `risk_ceiling_usd` above 2% of NAV, above the gate's suggested risk, or above Eric's PM decision (`pm_approved_risk_usd`).
- **Fresh price.** Refused when `reference_at` is older than `freshness.price_stale_minutes` at evaluation, or when the engine's own current price is further from `reference_price` than `max_slippage_bps`.
- **Bounded life.** `valid_until` is read as the earlier of itself and `created_at` plus the engine's maximum validity; an intent already past it is refused.
- **Evidence is for the record.** The engine stores `evidence` with the intent for the audit trail and reads none of it for a decision.
- The schema is published as `templates/schemas/trade-intent.v2.schema.json` (PR #58) and never edited after; a change is `cr.trade-intent.v3`.

### Paper Book `cr-paper@2`

Pipeline review, 2026-10-27. What the trader's Paper Book must be before any engine routes an intent to it. Built in `dashboard/core/paper-trader.js` (PR #59) beside `cr-paper@1` (`dashboard/core/paper.js`, unchanged), which keeps measuring the PM's ticket decisions exactly as it does. `cr-paper@2` has its own hash-chained, append-only records under `paper/trader/` and never touches `paper/positions.jsonl`.

- **Cash NAV.** The book starts from a cash balance Eric sets; unset, it holds nothing and the engine refuses every intent. NAV is cash plus each open quantity × its latest hourly price. A position without a fresh price makes NAV unknown, never valued at 0 or at its entry.
- **Discrete sizing.** The quantity is `floor_to_lot(risk_ceiling / (entry − stop))` at the venue's lot size and minimum notional; below the minimum there is no order. Cash is debited at each fill and credited at each exit, and never goes negative.
- **Fills through the price.** A limit buy fills only when an hour's low trades below its price, never at a touch. One hour fills at most `FILL_SHARE_MAX` of that hour's volume; the rest is a partial fill that stays open until it fills, is cancelled or expires.
- **Fees and slippage.** POST_ONLY pays the maker fee and everything else the taker fee, at the venue's published schedule; an unknown fee refuses the fill, never 0. A stop exit pays `STOP_SLIPPAGE_BPS` below the stop, or fills at the hour's open when the price gapped through it.
- **High/low wick stops.** Stops and targets are checked against each hour's high and low, not its close. When one hour reaches both the stop and the take profit, the stop is taken: the worse outcome.
- **Long only.** `OPEN_LONG` and `CLOSE_LONG`; no short, leverage or margin.
- **Results.** Realized P&L net of fees and slippage, NAV by the hour, and drawdown from NAV's high-water mark (the measure invariant 3's ceilings use), set against BTC over the same times as the outcomes are.
- **Red-team corrections (2026-10-27, PR #63, `audits/2026-10-27-red-team`).** Made before any record exists, under the same version names:
  - Risk is summed. The 24-hour ceiling counts the planned loss already at the stops (`book.open_risk_usd`) beside the drawdown, and the grant counts what the thesis already holds at its stops (`book.thesis_risk_usd`); either unknown refuses.
  - A limit more than `max_slippage_bps` through the book's price is refused (`through_market`).
  - Fills stay inside the hour: a buy fills at the lower of its limit and the hour's open, a close or target at the higher.
  - An order fills only from hours that start at or after it was sent, and an order whose life ends inside an hour expires before that hour can fill it.
  - For a pair with an open position or a live order, only the next hour applies (`GAP`).
  - Only an order recorded `SENT` goes to the venue. After a restart, a `RESERVED` or `SENT` order with no outcome is `UNKNOWN` and is reconciled from the venue's record, never cancelled blind. A venue record that does not read, or that holds the ID as another order, is `INTEGRITY`, and the order stays `UNKNOWN`.
  - Any order state outside `RESOLVED` halts every intent.
  - The book's price carries its time, held to the freshness limit.
- **Protected.** `dashboard/core/paper.js`, `paper-trader.js`, `trade-risk.js`, `decimal.js` and their tests (`trade-risk`, `paper-trader` and `trader-boundary` under `dashboard/tests/`) are in `PROTECTED` (`dashboard/scripts/backlog-promote.js`). No builder or agent-lane candidate changes them. Eric changes them, or a task he marks for it in words.

### Junior Trader roadmap

Eric, 2026-10-27; corrected by the pipeline review the same day. Both steps change protected files, so both backlog items were *(Eric)*: no builder took them. Both are built and merged by Eric (PRs #58 and #59).

1. **Pre-trade risk engine** (item 73, built, PR #58). `validateTradeIntent` in `dashboard/core/trade-risk.js`: a pure check of every `cr.trade-intent.v2` against invariant 3's limits and the rules above.
2. **Paper Book `cr-paper@2`** (item 74, built, PR #59). The blueprint above, in `dashboard/core/paper-trader.js`. It replaces the earlier `paper-fills.js` harness (`cr-paper-fill@1`), which was never built.

| Limit | Value |
|---|---|
| Risk per trade | at most 2% of NAV (`cr-paper@2`) |
| Drawdown | at most 4% of NAV in any rolling 24 hours, a hard ceiling |
| Minimum stop distance | the larger of `STOP_MIN_PCT` × entry and `STOP_MIN_ATR` × the 14-hour ATR: not set (Eric) |
| Notional cap | the smaller of `NOTIONAL_MAX_PCT` × NAV and the exit measurement's size: not set (Eric) |

Open (Eric):

- The Paper Book's starting cash. Until he sets it, NAV is unknown and the engine refuses every intent (unknown is never 0).
- The asset allowlist has no pairs yet; an empty allowlist refuses every intent.
- `STOP_MIN_PCT`, `STOP_MIN_ATR`, `NOTIONAL_MAX_PCT`, `FILL_SHARE_MAX`, `STOP_SLIPPAGE_BPS`, the maximum validity and the venue whose fee schedule and lot sizes the book uses.
- An intent names no ticket, so the engine cannot yet hold `risk_ceiling_usd` to the gate's suggested risk or a PM decision (above) until an intent carries its ticket.

## Autonomous Build Backlog

> Deprecated (Eric, 2026-10-27): the Active Backlog above, under the PM, is the autonomous queue. This list and `backlog-schedule.js` stay for the record and for a hand-run audit; the cloud routines that read it are being paused.

**Each builder run takes the items `dashboard/scripts/backlog-schedule.js` claims for it (up to five, three after the surge), implements and tests them one after another on one branch, and pushes that branch; `backlog-pr` opens its PR and Eric merges it.**

From 2026-10-27 (Eric's burst; `audits/2026-10-27-next-phase/BUILDERS.md`) the scheduler decides, not this text. Its limits by time (`CAPACITY` in `dashboard/scripts/backlog-status.js`, `cr-backlog-capacity@1`):

| Window (New York) | Builders | A run | All builders, any 60 minutes | Waiting or in flight, at most |
|---|---|---|---|---|
| burst, until 2026-10-27 23:00 | a (:55), b (:25) | 5 | 10 | 20 |
| surge, until 2026-10-28 23:00 | a | 5 | 5 | 15 |
| after that | a | 3 | 3 | 6 |

- **Claims.** A run claims its items first (`backlog-schedule.js claim`): a branch `claude/claims/item-<n>` per item, created or replaced only by compare-and-swap, so two builders never hold one item. A claim's lease is 90 minutes, renewed after each built item (`heartbeat`); a run that dies loses its items when the lease ends and the next run takes them again. A failed item (`fail`) waits 30 minutes; two failures, three lost runs, or a branch gone without its commit block the item until Eric looks. `release` gives an item back untouched. Claims are records, never work: `test.yml` ignores them.
- **Taken.** An item is taken when it is ticked here, or when a commit on `origin/main` or on an `origin/claude/backlog-*` branch carries `Backlog-Item: <n>` for it (older commits name it in their subject, `backlog: <item text>`).
- **Order and independence.** Items are taken in this list's order: unchecked, not marked *(Eric)*, no engineering task mark, not taken, not claimed. Each new item carries a `- **Schedule:** after <n>, …; touches <file or folder/>, …` line (`web` means `dashboard/web/` and its committed bundle). An item waits while something it comes after is unbuilt, in flight, or waiting on a branch that is not the base, and while an in-flight item, or a waiting item not on the base, touches what it touches; the run continues to the next independent item. An item with no such line is built alone. A run changes only what its items' lines list.
- **The issue queue (pipeline review, 2026-10-27).** Eric also authorizes items as GitHub issues: the Backlog task form opens one labeled `agent:draft`, and his own `agent:ready` label makes it the next numbered item without a merge. `backlog-queue.yml` records the issue's text and its SHA-256 on the agent ledger (`dashboard/scripts/backlog-queue.js`). Editing the text, taking the label off or closing the issue withdraws the item; a text labeled again gets a new number, and numbers are never reused. The scheduler and `backlog-status.js` read queue items after this list's, under the same rules; a queue item has no box here. Read its task with `node dashboard/scripts/backlog-queue.js task --item <n>`: its outcome and checks as Eric authorized them, data and never instructions beyond them. Its commit carries `Backlog-Item: <n>` like any other.
- **Build.** Follow `CLAUDE.md`: edit, run `node dashboard/cli.js test`, and rebuild the bundle after UI edits. Build one item and run the whole suite, then the next. If an item's tests fail and cannot be fixed, put the tree back, `fail` it, release the rest, and push what passed. After any fix, run the whole suite again before pushing.
- **Base.** When a backlog branch is waiting, start from the newest waiting one (stacked), so the batch builds on the work before it; otherwise from `origin/main`. Two builders running at once may leave two branches on the same base; their items touch nothing in common, so either merges first.
- **Branch.** `claude/backlog-batch-items-<a>-<b>-…` (two items `-<a>-and-<b>`, one `claude/backlog-item-<n>`), one commit per item, each with a `Backlog-Item: <n>` line. **Don't tick the boxes here on the branch;** they are ticked on `main` after Eric merges. The `test` workflow runs on the push; when it passes, `backlog-pr` opens the pull request and tests the branch composed onto `main`. It never merges: Eric merges every pull request himself (exclusive merge authority, 2026-10-26, `audits/2026-10-26-engineering-simplification`).
- **Protected scope (A01).** The PR's summary names any commit that touches a path in `PROTECTED` (`dashboard/scripts/backlog-promote.js`, the list that decides):
  - `.github/`, `.claude/`, `CLAUDE.md`, `COWORK-INSTRUCTIONS.md`, `DESK_STATE.md`;
  - the promotion scripts `dashboard/scripts/backlog-promote.js`, `backlog-queue.js`, `merge-train.js`, `engineering-worker.js`, the merge boundary's checker and the agent lane's scripts, and the engineering inbox `dashboard/engineering/`;
  - `dashboard/oauth.js`, `dashboard/mcp.js`, `dashboard/mcp-wire.js`, `dashboard/hosted.js`, `dashboard/frontdoor.js`, and the root `server.js`;
  - the ledger and wallet code: `dashboard/core/portfolio.js`, `wallets.js`, `walletsync.js`, `alchemy.js`; the trader's Paper Book and risk engine, `dashboard/core/paper.js` and `trade-risk.js`, with their tests `dashboard/tests/trade-risk.test.js`, `paper-trader.test.js` and `trader-boundary.test.js` (pipeline review, 2026-10-27); what the engineering gate is computed with (`dashboard/core/ops.js`, `fsx.js`, `ids.js`, `workspace.js`, `forensic-defs.js`, `rubrics.js`, `scoring.js`, `netguard.js`, `revision.js`); the scout's ingest and sweep;
  - `package.json` and `package-lock.json`, at the root and in `dashboard/web`; `render.yaml`;
  - the record folders (`portfolio/`, `paper/`, `projects/`, `config/`, `secrets/`, `scout/`);
  - an edit to, or removal of, an existing file under `templates/` (adding a new version is allowed).

  `dashboard/server.js` and `dashboard/cli.js` are not protected. Backlog items stay out of protected paths unless their line says Eric asked for it.
- **Engineering items (Connected Engineering v1, Eric 2026-10-25; `audits/2026-10-25-connected-engineering`).** An item whose line carries `*(engineering task eng-… v…, sha256 …)*` was admitted from the desk's engineering inbox. It is never in a batch: skip it (`backlog-status.js` leaves it out of `next` and lists it under `engineering`). It is built alone, only through the engineering lane: claimed on the desk's engineering connector, built on `claude/candidate-eng-<n>`, released to `claude/backlog-eng-<n>`. Its candidates pushed in the last hour count toward the hour's budget.
- **Never** push to `main` or force-push. Items marked *(Eric)* need his decision first: ask, don't build.
- **Order.** Track 2 first (the North Star at the top of this page). Each phase below says its own order; the list's order is the build order.

Merged into `main` (2026-10-24): items 1–6, through one train branch (`claude/train-2026-10-24`, PR #2) built from the five backlog branches, with the bundle rebuilt once and the full suite run. The source branches were then deleted. Items 10 and 11 were built locally the same day. CI (`.github/workflows/test.yml`) now runs on every `claude/**` push, and `backlog-pr.yml` opens the PR once it is green. Items 7, 8, 9 and 21 were merged the same evening (PRs #3 and #4, through `claude/train-items-7-8-9-21`; `tickets.js` overlaps kept from both sides, the bundle rebuilt once, the full suite run), and both branches were deleted.

Merged into `main` (2026-10-25) by `backlog-pr.yml`, three items per PR: 30–32 (PR #9), 33–35 (PR #10, then merged with the autonomy review fixes as `5001595`), 36–38 (PR #11) and 39–41 (PR #12); then five per PR, 42–44 (PR #14) and 45 with 48–51 (PR #15). The workflow deleted each branch, and the boxes were ticked here on `main`.

Merged into `main` (2026-10-25) by Eric: 52–56 (PR #17), 57–61 (PR #19) and 62 (PR #21); ticked here on 2026-10-27. The engineering items 63–66 are on `main` too and are left to the engineering lane.

- [x] Phase 1 tickets, connector tools, PM Decision Card, under-40 filter (f715a3e, live 2026-10-24)
- [x] Sub-agents `forensic-researcher`, `junior-trader-prosecutor` and `/pilot-run`
- [x] PM Decision Card polish, drawer nag, pilot on/off wording (954f87d)
- [x] **1. Native L1 exemption** (`cr-ticket-sizing@2`): `gate()` `nativeL1Liquid`, packet and basis `native`, receipt `desk.exit_basis`, card shows "Native L1"; `@1` tickets unchanged. Tests in `tickets.test.js`.
- [x] **2. Preferences > Screening: ticket sizing**: "Your ticket sizing" panel (`shell/Preferences.jsx` `TicketSizing`, the seven values incl. the native L1 floor), read from the index's `ticket_sizing` (the values in force), saved as `tickets.sizing` through `validateSettingsPatch` (same bounds; starter ≤ standard, any-risk floor ≤ new-entry floor). Tests in `tickets.test.js`.
- [x] **3. PM decisions in the journal.** (built: `journalDecision` in `core/tickets.js`; action, receipt and approved risk in `reasons`, no schema change) Each `decide()` action (`approve`, `halve`, `veto`, `pass`, `watch`, `trim`, and `undo`) also writes a structured journal entry (`notes.js`, `journal.v1.schema.json`; type decision, linked receipt ID, approved risk) so it shows in Notes. `decisions.jsonl` stays the source of truth; a journal failure never loses the decision. Tests.
- [x] **4. Missing exit quotes, in words.** *(done: packet `exits_missing`, receipt desk field, Decision Card line linking `?fx=exits`; tests)* The packet records which sizes ($500, $2,000) have no current reading and why; the PM Decision Card lists them with a link to `#/project/<id>/forensics?tab=exits` (or the tab's real address) to approve quotes. Tests for the packet field.
- [x] **5. Fixed-size quote before sizing.** (built: `tickets.prepareExitQuote` + `forensic-monitor.quoteSizeUsd`, wired in route, CLI and connector; packet `exit_quote_attempt`; tests in `tickets-exit-quote.test.js`) When `createTicket` finds no $500 reading on a verified, quotable token, ask for one fixed-size quote first (`forensic-monitor.js` `quoteFixedToken`: the existing adapter, gates, budget, hold and one request ID; never a wallet or swap). Async, so it belongs to the route and CLI, not the pure create; a failed or refused quote falls back to $0 with the reason. Tests with a stubbed network.
- [x] **6. Pilot runner:** (built: `resolveClaude`, no shell, claude.exe from PATH or install folders; `pilot-runner.test.js`) drop `shell: true` in `dashboard/scripts/pilot.js` (Node DEP0190 warning); resolve `claude.exe` on Windows instead
- [ ] *(Eric)* Bind OLAS's DefiLlama entity so the fundamental invalidation trigger is checked
- [ ] *(Eric)* ChatGPT as a second Prosecutor (`cr-ticket-challenge@1`, its own receipt, never averaged)
- [x] *(Eric)* Put more projects in the pilot; a scheduled `/pilot-run` cadence. *(Closed by Eric, 2026-10-25.)*
  - **The cadence.** The 2-hour runner `cr-at6-surge` (`~/.claude/cr-surge/surge.js`, a local scheduled task) runs Agent 1 under `@6`, then `dashboard/scripts/pilot.js --desk=online`. From 2026-10-25 it passes `--force-prosecution` when the desk's `@6` grade is 50 or more, or its range reaches 55, and it first catches up one such project whose desk gate still waits. Since item 48 (`cr-ticket-pregate@2`) the desk opens those Prosecutors itself; the override still reaches desk gates made under `@1` that wait for Eric.
  - **The opt-in.** `tickets auto-pilot-sync` (item 30) opts qualifying `@6` reports in; `tickets run-cycle` (item 51) runs it with the quotes and the queue.
  - **What was true on 2026-10-25.** The online pilot list was empty: both commands are CLI-only and reach only this folder's desk, and the connector has no tool for them yet (`mcp.js` is protected). The runner names its projects itself, so it does not need the list. It stops at 2026-10-27 23:00 ET unless Eric extends it.

30-day blueprint items (2026-10-24, `audits/2026-10-24-30-day-blueprint/README.md`; the W-number is its section):

- [x] **7. Pilot candidates, read-only (W1.2).** *(merged 2026-10-24, PR #3)* `core/tickets.js` `pilotCandidates(ws)`, CLI `tickets candidates [--json]`, and `autonomous_pilot_queue` with `candidates: true`. Order: held projects first, then verified, active projects by the desk's calculated grade of Claude's current eligible report (a range by its low end; withheld and no report last). Each row gives the gate's result today with no proposal (`gate(basis, sizing)`: allowed types, suggested risk, reasons), whether an exit reading exists at the sizing's exit size, the report's age and prompt version, and whether it is already in the pilot. It writes nothing and opts nothing in. Tests: ordering, held first, unknown grade last, nothing written.
- [x] **8. Invalidation coverage, `cr-ticket-invalidation@2` (W1.4).** *(merged 2026-10-24, PR #3)* In `invalidationOf`, the price check states its coverage: hours since the ticket with at least one hourly reading, out of hours elapsed. Any gap over 6 h is named with its start and end. Coverage under settings `tickets.invalidation.min_coverage_pct` (default 90, labeled as Eric's choice, bounded in `validateSettingsPatch`) reads `unknown`, never `holding`; a reading at or below the threshold still reads `triggered`. A receipt whose Researcher report is superseded or past `freshness.research_stale_days` gets `basis_stale: { why }`, and its status is unchanged. New receipts record `desk.invalidation_version`; one without it is read under @1, unchanged. Tests: a 12 h gap with the low inside reads unknown, full coverage reads holding, a reading in the window still triggers, an @1 receipt reads as before.
- [x] **9. Pre-gate, `cr-ticket-pregate@1` (W1.3; Eric approved 2026-10-24).** *(merged 2026-10-24, PR #4)* When the grade alone rules out new risk (Claude's current report has no grade, or one under `min_grade_new_entry` of the sizing in force) and the project is not held, no Prosecutor runs. A missing or costly exit alone still gets a Prosecutor.
  - **The receipt.** `createTicket` (the route, CLI `tickets start`, connector `start_ticket`) builds the same frozen basis and packet as today. Then, instead of opening a job, it saves a desk receipt in `receipts/`: the same `tr_…` ID, `kind: 'desk_gate'`, `pregate_version`, the packet's SHA-256, and the gate's own result with no proposal (`gate(basis, sizing)`: type HARD_PASS under `min_grade_any`, else WATCH_ONLY; $0; its reasons), with `prosecution`, `proposal` and `agent_disagreement` null. No prompt is rendered and nothing goes to a model. It returns `{ gate_closed: true, receipt }`. `force_prosecution: true` opens the normal ticket instead. The same report again is `unchanged` with the same receipt.
  - **The queue.** Where `nextStep` would say `ticket` for such a project, it says `gate_closed` with the gate's reasons, then `pm_review` once that desk receipt is the current one. The connector's next action, `.claude/commands/pilot-run.md` and `dashboard/scripts/pilot.js` handle `gate_closed` by calling `start_ticket` (or `tickets start`), never the Prosecutor sub-agent.
  - **Every reader takes it.**
    - `view`, `summary` and the index.
    - `invalidationOf`: no trigger, "No invalidation trigger: the desk's gate, not a Prosecutor".
    - The PM Decision Card: "Desk gate · no Prosecutor run", the reasons, Confirm Pass & Archive and Override → Watch; no conviction, spread or flaw rows.
    - `decide`: `pass`, `watch` and `undo` are accepted; `approve`, `halve` and `trim` are refused with the reason.
  - **Unchanged:** held projects, gates that allow risk, and every existing ticket and receipt.
  - **Tests (`tickets.test.js`):**
    - an under-40, not-held project gets a desk receipt, with no prompt file and no model text;
    - a held project and a project with a grade over the floor open a normal ticket;
    - `force_prosecution` opens one;
    - `pass` archives and `undo` restores;
    - `nextStep` goes `gate_closed`, then `pm_review`;
    - the view and the index build;
    - an existing Prosecutor receipt reads as before.

Items 21–23 (Eric, 2026-10-24, after ETH's ticket `tr_2026-10-24T184348Z_hrwks` read "invalidated" with no tool able to say why) are placed here on purpose, ahead of 12–20:

- [x] **21. `get_ticket`, read-only.** *(merged 2026-10-24, PR #4; `get_ticket` is now in item 16's list)* A connector tool in `dashboard/mcp.js` for every model, writing nothing, that returns `tickets.view(ws, pid)`:
  - the current ticket: status, proposal and capped type, gate reasons, exits, `exits_missing`, invalidation with every check, its `words` and the reading that fired;
  - the history (receipt ID, saved at, type, decision) and the open ticket;
  - with `receipt_id`, that receipt's view;
  - with `include_text: true`, the saved text, pins checked as on `GET …/tickets/receipts/<tr>/text` (a mismatch is an INTEGRITY refusal).

  `node dashboard/cli.js tickets view <id> --json` prints the same object. Add `get_ticket` to item 16's read-only list. Tests: an invalidated ticket names the trigger and reading; a missing project is NOT_FOUND; nothing is written.
- [x] **22. No born-invalidated tickets.** In `saveTicket`, after the block is normalized and before anything is written:
  - **Price:** if the proposal's `invalidation_trigger.price_usd` is at or above the price at save time (the latest stored hourly price, else the frozen packet's `market.price_usd`), refuse with INVALID: "Not saved: the invalidation price $X is at or above the price now ($Y at <time>): the ticket would be invalidated the moment it is saved. Set a threshold below the current price." The draft is kept.
  - **Metric:** if `invalidation_trigger.metric.below_30d_usd` is above the packet's complete 30-day total for that metric, refuse the same way, naming the total and its date.
  - **Exempt:** `HARD_PASS` and `TRIM_EXIT` are saved as before. Their receipt carries `desk.trigger_breached_at_save: { kind, words }`, and the PM card says "Trigger already breached when saved" instead of a bare Invalidated.
  - **No reading:** the check says it was skipped, never "passed".
  - **Tests:** a price trigger above the price is refused and writes nothing; one below is saved; a metric floor above the packet's total is refused; the HARD_PASS and TRIM_EXIT exemptions are saved and labeled; no price on file skips the check.
- [x] **23. Re-open a ticket after invalidation or a rule upgrade.** A new PM action `reopen` in `decide` (`ACTIONS`, journaled like the others through item 3). It is allowed only when the current ticket is `invalidated`, or was sized under an older rules version than `sizingOf(ws).version` (for example `@1` while `@2` is in force); otherwise it is refused with the reason.
  - After a `reopen`, `nextStep` returns `ticket` with `refresh: true` and why. The connector's next action calls `start_ticket` with `refresh: true`, which already exists. The new receipt supersedes the old one, which is kept.
  - With Claude's report still fresh, no new research is asked for.
  - CLI: `tickets start <id> --reopen`, with the same check. `start_ticket` takes `reopen: true` as the checked form of `refresh`.
  - PM Decision Card: "Re-open ticket" under these two conditions only. Rebuild the bundle.
  - `nextStep`'s `done` words for an invalidated ticket name the way out: "Invalidated: Re-open ticket on the card (or tickets start --reopen)".
  - Nothing re-opens automatically.
  - Tests: reopen is refused on a pending ticket; it is allowed on an invalidated one and on a `@1` ticket under `@2`; `nextStep` gives `ticket` with refresh; the old receipt is kept; undo of the reopen restores `done`.
- [x] **10. CI (W2.1)** (built locally 2026-10-24: `.github/workflows/test.yml`; pushes to `claude/**` and PRs to `main`, `ubuntu-latest`, Node 24.21.0, `node dashboard/cli.js test`, the counts in the job summary and a `test-summary` artifact)
- [x] **11. Backlog PRs from Actions (W2.2)** (built locally 2026-10-24: `.github/workflows/backlog-pr.yml`; after `test` succeeds on a push to `claude/backlog-*`, opens or updates one PR to `main` with the commits and counts through `GITHUB_TOKEN` and the REST API, only for the commit that was tested; a red run opens nothing. Needs Eric's repo setting: Actions > General > "Allow GitHub Actions to create and approve pull requests")
- [x] **12. Merge train (W2.3).** `dashboard/scripts/merge-train.js`, `npm run train [-- --push]`. From `origin/main`, merge each waiting `origin/claude/backlog-*` branch in item order (stacked branches after their base) onto `claude/train-<YYYY-MM-DD>`. A conflict only in `dashboard/public/app/**` or `DESK_STATE.md` takes `main`'s side, then the bundle is rebuilt once (`npm ci && npm run build` in `dashboard/web`) and the merged items are ticked. Any other conflict stops and names the branch and files. Then the full suite runs and the script prints what was merged and skipped and the counts. It pushes only with `--push` and never touches `main`. Tests use a temporary git repo fixture: a clean train, a bundle-only conflict resolved, a code conflict stopped.
- [x] **13. Rollback-safe records (W2.5).** `tickets.view`, `tickets.summary` and the indexer read a receipt or ticket from an unknown sizing or invalidation version (for example `@9`) as "made under a newer rule (`<version>`): shown as saved, not re-read", never throwing, with its saved figures as they are. Tests: a fictional workspace holding `@9` receipts renders, and the index builds.
- [x] **14. Guardrail invariants (W2.6).** `dashboard/tests/guardrails.test.js` runs over the API answers of a rich fictional workspace (projects with reports from two models, tickets, forensics):
  - no desk-generated text puts a % beside probability, chance or likely;
  - no unknown value is serialized as 0 where the record has none;
  - there are no averaged or midpoint grade fields;
  - every two-agent or two-model view carries both figures;
  - nothing is labeled safe.

  Tests only; if one finds a real breach, fix it in the same item and name it.
- [x] **15. Daily brief, `cr-daily-brief@1` (W3.1).** `dashboard/core/brief-daily.js`, `GET /api/brief/daily?since=<iso>`, CLI `brief daily [--json] [--since]`, and a read-only connector tool `daily_brief` for every model. Each line has its `#/…` deep link:
  - PM cards waiting, with their age;
  - tickets invalidated since `since`;
  - tickets on a stale or superseded basis;
  - pilot projects missing an exit reading;
  - held positions' value and 24h change (unknown said);
  - research waiting per model;
  - Review's Models differ group;
  - backup age and price freshness.

  It is deterministic and gives the SHA-256 of its text. It writes nothing. A section it could not read says so, never "nothing". Tests on a fictional workspace, including that a read writes nothing.
- [x] **16. Read-only connector grant (W3.2; Eric unlocked it for the builder 2026-10-24).** The OAuth consent offers "Read only". Such a connection lists and accepts only the read tools (`desk_status`, `find_projects`, `get_report`, `compare_reports`, `portfolio_overview`, `list_accounts`, `pending_research`, `pending_forensics`, `pending_tickets`, `get_ticket`, `autonomous_pilot_queue`, `get_forensic_audit`, `daily_brief`; a tool from a later item that is not merged yet is left out, never stubbed). A write is refused with the reason, and `desk_status.assistants` shows the kind. It is for Duet. It touches `oauth.js` and `mcp.js`.
- [x] *(Eric)* **17. Voice intake, in a local session (W3.4).** `.github/workflows/backlog-intake.yml`: on `issues: labeled`, only when the label is `ready` and the sender is `kuaya1`, open a PR that adds the issue, quoted and linked, as the next numbered item. It builds nothing; Eric merges it like any PR. *(built 2026-10-25: `.github/workflows/backlog-intake.yml`; needs the repo label `ready` and the same "Allow GitHub Actions to create and approve pull requests" setting)*
- [x] **18. Paper book, `cr-paper@1` (W4.1).** `dashboard/core/paper.js`, append-only `paper/positions.jsonl` (backed up and exported, never in `portfolio/`, Portfolio counts or wallets). A `risk_granted` decision opens a position of `pm_approved_risk_usd`:
  - entry at the hourly reading nearest the decision within 6 h, else "no entry price", never a later one;
  - entry cost "unknown", never 0.

  It closes at the first hourly reading at or below the invalidation price (that reading), on `trim_acknowledged`, or at the horizon's end. Its return against BTC uses the same records. A $0 ticket gets a shadow line ("Shadow: not taken"). Undo of the decision voids the position with a reason, never deleting it. No total, median or hit rate before 20 have closed. It shows under Research > Outcomes as "Paper". Tests.
- [x] **19. Scenario harness (W4.2).** `dashboard/tests/sim/*.test.js` with price paths in `dashboard/tests/fixtures/sim/`, zero network. Each case asserts statuses and words:
  1. a wick through the invalidation price;
  2. a 12 h price gap with the low inside;
  3. CoinGecko 429 and a stale price;
  4. the aggregator's no-route answer;
  5. an unknown sell tax;
  6. a report superseded mid-ticket;
  7. a decision on a superseded receipt (409);
  8. agents 40 points apart;
  9. ETH under the native exemption;
  10. a paper position across an invalidation.
- [ ] *(Eric)* **20. Final blitz audit, in a local session (W4.5).** A fresh Opus session reviews `git diff a4d0c2e..main` against the blueprint's §1 invariants and writes `audits/2026-11-23-blitz-audit/README.md`.

Phase 2 (Eric, 2026-10-24 evening), after item 19:

- [x] **24. Batch gate, `tickets batch-gate`.** Applies the pre-gate (`cr-ticket-pregate@1`, item 9) in one pass to every active, verified project Eric does not hold whose Claude current eligible report grades under 40. That is Eric's filter; `--below <n>` may lower it, never above the sizing's `min_grade_new_entry`.
  - Each project goes through the same `createTicket` path as `tickets start`, so each gets its `desk_gate` receipt. No exit quote is asked for (the grade alone decides), no prompt is rendered and no model is called.
  - A project with an open Prosecutor job, or whose current receipt already answers the same report, is skipped and named. The same report again is `unchanged`.
  - CLI `tickets batch-gate [--below 40] [--dry-run] [--json]`. Route `POST /api/tickets/batch-gate` with the count shown as `expect` (409 when more, as `POST /api/research/send-waiting` does).
  - It prints what was made, unchanged and skipped, each with its reason.
  - Tests: an under-40 project not held gets a receipt; held projects, 40 and over, withheld or no report, archived and unverified are skipped; a second run is all unchanged; `--dry-run` writes nothing.
- [x] **25. Exit quotes for pilot candidates.** For each row of `tickets candidates` graded 40 or over with no current reading at the sizing's exit sizes ($500 and $2,000), ask for both in one pass.
  - Use item 5's path (`forensic-monitor.js` `quoteSizeUsd`: the approved chain, the adapter, budget, gates, hold and one request ID per quote; never a wallet, signature or swap), so the gate reads them as it does before a ticket. Not `quoteFixedToken`, whose quotes never feed readings.
  - A native coin is skipped (native L1: no DEX quote is needed).
  - A project with no approved exit-quote chain is listed as "needs a chain approved (Forensics > Exits)", never approved by this command.
  - A 429 or a refusal stops that source for the pass and says so.
  - CLI `forensics quote-candidates [--limit 15] [--dry-run] [--json]`, and the connector tool `quote_pilot_candidates` (Claude only; it saves quote observations and nothing else). Per project it prints quoted, already current or skipped, and why.
  - Tests with a stubbed network: a candidate without a reading is quoted at both sizes; a current one is left; native and no-chain projects are skipped with words; a 429 stops the source; `--dry-run` sends nothing.
- [x] **26. Change since the last report.** When Claude has an earlier eligible report on the project, the PM Decision Card, the inspector's verdict and `daily_brief` (item 15) show the change in one line, "+4.2 vs Oct 6" or "−8.1 vs Oct 6", with any verdict change in words.
  - It is computed on read from the two stored reports (reuse `core/digest.js`'s same-rubric comparison) and never stored, so a later quarantine or exclusion of either report changes it.
  - Shape: `report_delta { previous_report_id, previous_at, previous_grade, new_grade, grade_delta, verdict_changed, category_deltas }`, with both prompt versions named.
  - The grade delta is given only between two firm grades under the same rubric; a range, a withheld grade or another rubric says why, with no figure. Category deltas only under the same profile and category definition (the `@1` and `@2` profiles are not compared).
  - Tests: firm grades give the signed delta; a range, a withheld grade or a profile change gives words and no figure; a quarantined earlier report falls back to the one before it, or says there is none.
- [x] **27. Cost basis and distance to invalidation.** ETH and ZAMA read "cost unknown" because a first wallet balance is never a purchase.
  - Eric gives a held position its cost through the ledger, which stays the one record of cost. On a position with units of unknown cost, "Set cost" (Portfolio > Needs attention, and CLI `portfolio set-cost <asset> --account <id> --avg-cost-usd X --acquired-at DATE`) corrects the arrival or deposit the standard way: the original is voided with the reason, and the copy `corrects` it with Eric's average cost and date, source `correction`. It is never a field on the position and never an estimate.
  - `portfolio_overview` and `daily_brief` then give unrealized P&L and the % distance from the price to the invalidation price of the ticket in force.
  - With no cost they keep "cost unknown" and no P&L; with no ticket or trigger they say so.
  - Tests: setting a cost corrects the entry and gives P&L; unset stays unknown, never 0; the distance uses the ticket in force and the stored price with its time; the original entry is kept, voided with the reason.
- [x] **28. Spread alerts.** The alert fires when Claude's current eligible report and ChatGPT's or Gemini's differ by 15 points or more in grade, or Claude's grade and the Prosecutor's conviction on the current ticket differ by 20 or more. Both thresholds are settings, labeled as Eric's choices and bounded in `validateSettingsPatch`.
  - `daily_brief` (item 15) and the inspector's review items name the project, both figures and the category with the widest comparable difference, linked to Compare with that category open (`compare-desk.js`'s ordering).
  - Only firm grades under the same rubric are compared, and categories only under the same profile and definition. A range, a withheld grade or another rubric reads "not compared" with the reason. Never an average, midpoint or winner.
  - Gemini's saved reports count; its hold is untouched.
  - Tests: a 15-point pair alerts with its widest category; 14 points does not; a profile mismatch names no category; a 20-point Prosecutor spread alerts.
- [x] **29. Scorecard runner.** `dashboard/scripts/blitz-scorecard.js`, `npm run scorecard [-- --json]`, computes every row of the blueprint's §7 Day-30 scorecard from the repo and the workspace only: git history and `Backlog-Item` trailers, Actions runs through `gh` when it is signed in, ticket receipts and decisions, and `paper/`.
  - Each row gives its value, its target, met / not met / not measurable, and the records it read.
  - A row the records cannot answer reads "not measurable from records", never a guess.
  - It calls no model and writes nothing.
  - Tests on a fictional workspace and a temporary git repo: each row computes; a missing source reads "not measurable"; nothing is written.

Phase 3 (Eric, 2026-10-25), to keep the builder fed while the `@6` Watchlist Surge runs:

- [x] **30. `tickets auto-pilot-sync`.** Opt in (`pilot: true`) every verified, active project whose Claude current eligible report is a `cr-research-prompt@6` run with a firm calculated grade of 45 or more, so qualifying candidates enter the pilot queue as the surge finishes reports. A range is judged by its low end; a withheld grade, no report, an older prompt, an archived or unverified project is skipped and named. Projects already in the pilot are unchanged; it never opts anything out. CLI `tickets auto-pilot-sync [--min 45] [--dry-run] [--json]` and the same count shown as `expect` on its route (409 when more). Tests: a qualifying `@6` project is opted in; 44, a range with a low end under 45, withheld, `@5`, unverified and archived are skipped with words; a second run is unchanged; `--dry-run` writes nothing.
- [x] **31. UI: Paper Book and Shadow Gate view in Research > Outcomes.** In `dashboard/web`, the Paper card shows open and closed positions apart, each return against BTC (unknown said, never 0), and a toggle "Shadow ($0 gate passes)" listing the pre-gate's `desk_gate` and $0 tickets with what the price did since, so Eric can see whether the gate turned away winners. No total, median or hit rate before 20 closed; reading writes nothing. Rebuild the bundle. Tests for the model behind it.
- [x] **32. UI: Daily Brief quick-view.** A "Daily Brief" button in the top bar opens a drawer rendering `GET /api/brief/daily` (`cr-daily-brief@1`) with its text hash, each line a `#/…` deep link to every waiting PM Decision Card and invalidated ticket; a section it could not read says so. Reading writes nothing; keyboard and phone layouts follow the UI guidelines. Rebuild the bundle. Tests for the model behind it.
- [x] **33. UI: rule note and report delta on `PMDecisionCard.jsx`.** Show item 13's `rule_note` ("made under a newer/older rule") and item 26's `report_delta` badge ("+4.2 vs previous @5", or its words when no figure is given) on the card, with the prompt versions named. Both are read from the stored records, never stored. Rebuild the bundle. Tests.
- [x] **34. `tickets digest`: weekly performance and quota telemetry.** `dashboard/core/tickets.js` plus CLI `tickets digest [--days 7] [--json]`: `@6` reports completed, Prosecutor tickets against `desk_gate` passes, the distribution of grade spreads between models, invalidated triggers fired, and provider budget used, all over the last 7 days, deterministic, with an unreadable section said and never counted as zero. It writes nothing. Tests on a fictional workspace.
- [x] **35. Tick step for merged backlog branches.** When a `claude/backlog-*` branch merges, the `Backlog-Item: <n>` items it carries are ticked in `DESK_STATE.md` cleanly: a `tick` mode in `dashboard/scripts/merge-train.js` (`npm run train -- --tick-main`) that reads the trailers on `main` and ticks the unticked ones, with a post-merge step in `backlog-pr.yml` that opens no extra PR if nothing needs ticking. Never edits anything but the checkbox. Tests with a temporary git repo.

Phase 4 (Eric, 2026-10-25): the open recommendations of `audits/2026-10-25-codex-autonomy-review` and the blueprint's W4.4. Every item obeys the blueprint's §1 invariants. An item whose text says it touches a protected path is built like any other; its PR then waits for Eric's merge.

- [x] **36. Complete missing decision consequences: `tickets reconcile`.** `dashboard/core/tickets.js` `reconcileEffects(ws, { project = null, dryRun = false })`, CLI `tickets reconcile [<project>] [--dry-run] [--json]`. A failed paper or journal step after a decision is today completed only when the same decision is sent again (review A06).
  - For each decision in force that grants risk and has no paper position, open it through `paper.openForDecision`, with the entry at or before `decided_at` as always.
  - For each decision line with no journal entry naming its `decision_id`, add that entry through `journalDecision`, its text naming the decision's own time.
  - It never archives or restores a project (Eric may have restored it since a pass), never voids a position, and never changes `decisions.jsonl`. A pass whose archive step failed is named, not archived.
  - It prints what it completed and what was already complete.
  - Tests: a grant whose paper step failed is completed once and a second run is all unchanged; an undone grant gets nothing; a failed archive is named and left; `--dry-run` writes nothing.
  - Done when one command repairs every recorded-but-incomplete decision without inventing one.
- [x] **37. Older receipts sized from a job record: integrity-limited.** A receipt saved before `frozenBasis` (review A08) may have been sized from a job record that differs from its frozen packet.
  - `tickets.view` recomputes `gate()` for a Prosecutor receipt from its verified frozen packet (`receipt.packet`), under the receipt's own `desk.sizing` and `proposal.proposal_type`. It compares the result with the receipt's `desk` exit costs and its risk before any admission hold (`desk.admission.held_risk.risk_usd` when held, else `desk.suggested_risk_usd`).
  - A difference reads `integrity: { status: 'limited', fields, words }`. A packet that cannot be verified reads `integrity: { status: 'unverified', words }`. A match reads `ok`. Receipts written since frozenBasis are also checked, and should read `ok`.
  - `decide` refuses `approve` and `halve` on a limited or unverified receipt (409 `INTEGRITY`, naming the fields); `veto`, `pass` and `watch` stay allowed. The PM Decision Card shows the words. The receipt's bytes never change. Rebuild the bundle.
  - Tests: a receipt made from a mutated job (fixture) reads limited and cannot be approved but can be vetoed; a normal receipt reads ok; a missing packet reads unverified; reading writes nothing.
- [x] **38. A sampled breach, said.** The rule `cr-ticket-invalidation@2` is unchanged; this adds words and fields only.
  - A `triggered` price check whose coverage is under `tickets.invalidation.min_coverage_pct` carries `sampled: true`. Its words add "a sampled reading: n of m hours had one", the reading's time and its source (an hourly observation, or `latest.json`).
  - With full coverage it is `sampled: false`, and every fired check names its source.
  - The PM Decision Card's invalidated line and the daily brief's invalidated section show it. The status stays `triggered`: the published rule decides, and the label only says how much was seen. Rebuild the bundle.
  - Tests: two readings in 24 h with one under the trigger read triggered and sampled with the words; full coverage reads not sampled; a reading from `latest.json` names it.
- [x] **39. Daily brief: tickets waiting on a repair or a fresh price.** A new section, `ticket_repairs`, in `dashboard/core/brief-daily.js`, after `stale_basis`, with the same partial and unreadable rules as items 15 and the review's A07.
  - A grant in force whose paper position is missing (`decision.paper === 'missing'`): "complete it on the card (Complete paper position) or `tickets reconcile`".
  - A ticket held to $0 by the admission check (`admission.held_risk`), with its reason: "refresh prices, then ask for a new ticket (refresh)".
  - Each line is a deep link to the project. Update `public/daily-brief-model.js` if its section order or words need it, and rebuild the bundle.
  - Tests: both cases are listed with their words and links; a healthy desk reads "None right now."; an unreadable ticket makes the section partial; a read writes nothing.
- [x] **40. Pre-gate: say why the grade closed it, with an override on the card.** A withheld grade from a retrieval gap reads today like a weak project (review, stress test 2).
  - `closeGate` records `desk.gate.reason_kind`: `grade_low` (a firm grade, or a range's low end, under the floor) or `grade_withheld`. A withheld grade also gets `desk.gate.withheld`, with the report's scored share and the investment components it left unscored, from the report's own `investment_components`.
  - `pregate_version` stays `cr-ticket-pregate@1`: the rule is unchanged and only what it records grows. Older receipts read as `reason_kind: null`, said "not recorded".
  - `nextStep`'s `gate_closed` words name the kind.
  - The PM Decision Card's desk-gate view says it. It gets "Ask the Prosecutor anyway", which, after a confirm, posts `POST /api/projects/<id>/tickets` with `force_prosecution: true` (the route already takes it) and is labeled as Eric's override. Rebuild the bundle.
  - Tests: an under-floor grade reads `grade_low`; a withheld grade reads `grade_withheld` with its components; an older receipt reads not recorded; the override opens a normal ticket.
- [x] **41. Shadow gate: fixed 30-day results beside "since saved".** Today `paper.js` `shadowGate`'s `since` follows the latest price, so a day-30 +100% reads +200% at day 35 (the review's added probe).
  - Each row also gets `day30`, from the hourly reading at or before the receipt (within 6 h) to the one at or before receipt + 30 days (within 24 h): the change and the change against BTC. Its status is `matured`, `immature` (before day 30) or `unevaluable` (a price missing), never 0. Once matured it never changes.
  - Archived projects' receipts are included.
  - A cohort line per receipt month gives the matured, immature and unevaluable counts. There is no median, hit rate or "the gate was right" before 20 have matured, and never a probability.
  - Research > Outcomes' Shadow toggle (`public/paper-model.js`, `public/views/research.js`) shows the day-30 column beside "since saved". Rebuild the bundle.
  - Tests: the review's probe (+100% at day 30, +200% at day 35) keeps day30 at +100%; immature and unevaluable read so; an archived project's receipt is listed; nothing is written.
- [x] **42. Backlog status, computed: `dashboard/scripts/backlog-status.js`.** The WIP cap is today an instruction, not a check, and "stop at 9" allows 8 + 3 (review, stress test 1).
  - `node dashboard/scripts/backlog-status.js [--json]` reads git and `DESK_STATE.md` on `origin/main` only (fetch first) and writes nothing.
  - It gives:
    - the waiting items (the `Backlog-Item` trailers on `origin/claude/backlog-*` branches not merged into `origin/main`, each counted once, with their branches);
    - the cap and batch size in force by New York time (9 and 3 until 2026-10-27 23:00 ET, then 4 and 2);
    - the headroom: how many items may start now, counting what this run would add, so 8 waiting with a cap of 9 starts 1;
    - the next buildable items in order (unchecked, not *(Eric)*, not taken on `origin/main` or a waiting branch);
    - the base to build on (the newest waiting branch, else `origin/main`).
  - No npm script: `package.json` is a protected path.
  - Tests with a temporary git repo (the merge-train fixture style): the waiting count, the cap switch at the date, headroom with 8 waiting, taken and *(Eric)* items skipped, and the base choice.
  - Done when one command gives the routine everything its first step decides (Eric then points the routine prompt at it).
- [x] **43. Scorecard: exact heads, and a structured drill result.** In `dashboard/scripts/blitz-scorecard.js`:
  - `ci_coverage` becomes "Backlog heads tested on that exact commit". Each merged backlog head (the second parent of each backlog merge on `origin/main`) and each waiting branch's head counts as covered only with a `test.yml` run on that exact SHA (`gh run list --json headSha,headBranch,event`). A branch deleted with no run is said not visible, never counted as covered.
  - `rollback_drill` reads only a structured record: `audits/*/rollback-drill.json` with `schema_version: 'cr.rollback-drill.v1'`, `result: 'passed' | 'failed'`, `from`, `to`, `checked`. It is met only on `result: 'passed'`. Prose never counts ("not passed" contains "passed").
  - Tests: a run on an earlier commit of the branch does not cover its head; a markdown file saying "not passed" is not met; a passed JSON record is met; an unreadable record says so.
- [x] **44. Rollback drill (W4.4): `dashboard/scripts/rollback-drill.js`.** `node dashboard/scripts/rollback-drill.js --from <ref> [--json] [--record <audit-dir>]`.
  - It builds a FICTIONAL workspace with this checkout's code, reusing the test fixtures: a Prosecutor receipt, a desk gate, an admission-held receipt, decisions and a paper position.
  - In a temporary `git worktree` at `<ref>` (the previous release), it runs that code's `tickets.view`, `tickets.summary`, `paper.book`, `indexer.buildIndex` and `brief-daily` over the workspace in a child process.
  - It passes when nothing throws and records made under newer rules read as "made under a newer rule" (item 13).
  - With `--record`, it writes `rollback-drill.json` in item 43's shape into the named audit folder; otherwise it writes nothing outside its temporary folder. It refuses a non-test workspace, never touches the real workspace or a branch, and removes the worktree.
  - Tests with a temporary git repo and an injected reader: a passing and a failing drill, the record's shape, and the worktree removed.
- [x] **45. Set cost says what its date does.** `portfolio set-cost` (CLI, `dashboard/cli.js`) and its route `POST /api/portfolio/set-cost` (`dashboard/server.js`, which adds the words to `portfolio.setCost`'s answer) name the original entry's date and the corrected date. There is no UI form for it today, and this item adds none.
  - When the dates differ, the answer says the units count as held from the new date instead of the old one, so holdings and results between the two dates change (review, stress test 5). With no `--acquired-at`, it says the original date is kept.
  - Words only: no change to `core/portfolio.js`, a protected path.
  - Tests: the CLI's output and the route's answer name both dates; the same date says nothing changes.
- [ ] *(Eric)* **46. Promotion follow-ups. This touches protected paths (`dashboard/scripts/backlog-promote.js`, `.github/workflows/backlog-pr.yml`), so its PR waits for Eric.**
  - After a confirmed merge, the promote job ticks the merged items' boxes on `main` (merge-train.js `untickedOnMain` and `tick`, with `tickMain`'s checkbox-only check) in a second compare-and-swap push. This is item 35's post-merge step, which the 2026-10-25 rewrite left out. Nothing to tick pushes nothing.
  - When `main` moved during a promotion (`base_moved`), the job asks for one re-run of the workflow for the same head (`actions: write`), at most once per head, and says so in the summary.
  - Tests in `backlog-promote.test.js`: ticks after a merge with nothing else changed; nothing to tick pushes nothing; a moved main asks for one re-run, and a second refusal asks for none.
  - *(2026-10-27, held for Eric)* Since PR #33 `backlog-pr` never merges, so neither step has a merge to follow: Eric closes or rewrites this item. Ticks after his merges are by hand (52–62 were ticked that way); the builders read `Backlog-Item` trailers on `main`, so an unticked box no longer holds them up.
- [ ] *(Eric)* **47. Native L1 exemption needs a fresh market cap, `cr-ticket-sizing@3`.** `nativeL1Liquid` reads the stored market cap without its age (review, stress test 3).
  - Under @3, the exemption holds only when the packet's market cap is no older than `freshness.price_stale_minutes`. Otherwise the exit check reads "native L1 exemption unavailable: market cap from <time>".
  - Tickets frozen under @2 and @1 keep their rules.
  - This is a sizing change, so it needs Eric's go first (blueprint W2.7).

Phase 5, heavy Track 2 (Eric, 2026-10-25). Eric's message numbered these 42–56, but 42–47 were already Phase 4's, so they are 48–62 here: his 42 is 48 and his 56 is 62. Every item stays in files `PROTECTED` does not list (see "Zero-click scope" above). Research > Outcomes is the hosted view `dashboard/public/views/research.js` (with `dashboard/public/paper-model.js`); there is no `Research.jsx`.

- [x] **48. Near-miss prosecution floor (`pregate_max_grade: 48`).** In `dashboard/core/tickets.js` (`SIZING_DEFAULTS`, `sizingOf`, `pregateReason`) and `Preferences.jsx`, add `pregate_max_grade`: default `48`, bounded `0 <= pregate_max_grade <= min_grade_new_entry` (in `validateSettingsPatch`, `dashboard/server.js`, as item 2).
  - `pregateReason` closes the pre-gate without a Prosecutor only when an unheld project's grade is withheld, none, or under `pregate_max_grade` (48).
  - Unheld candidates graded `48` to `< min_grade_new_entry` (55), or whose grade range has a high end `>= 55`, open a normal Prosecutor ticket. Agent 2 then writes the adversarial prosecution and the trade plan.
  - `gate()` still caps suggested risk at `$0` (`WATCH_ONLY`).
  - The pre-gate rule changes, so new desk receipts record `cr-ticket-pregate@2`, following CLAUDE.md's standing rule that a changed rule is a new version. Receipts made under `@1` keep theirs, and item 13's version table knows `@2`.
  - Rebuild the bundle. Tests in `tickets.test.js`.
- [x] **49. UI: Trade Plan Geometry & R-Multiple strip on `PMDecisionCard.jsx`.** In `dashboard/core/tickets.js` (`view`) and `PMDecisionCard.jsx`, compute `trade_plan_geometry`.
  - Inputs: the receipt's `proposal` (`entry_zone`, `upside_target`, `invalidation_trigger.price_usd`) and the latest stored market price, when it is fresh and known.
  - Outputs:
    - the price's position against the entry zone (`in_zone`, `above_zone`, `below_zone`, with a `%`);
    - `% to upside_target`;
    - `% to invalidation_trigger`;
    - a deterministic `reward_risk_ratio`: `(upside - ref_price) / (ref_price - stop_price)` when `upside > ref_price > stop_price`.
  - Render a crisp Trade Plan strip on `PMDecisionCard.jsx`. Never invent missing numbers; say unknown.
  - Rebuild the bundle. Tests in `tickets.test.js` and `web-app.test.js`.
- [x] **50. Track 2 trade plan lines in `brief-daily.js` and `DailyBrief.jsx`.** In `dashboard/core/brief-daily.js`, give each waiting Prosecutor ticket's line in `pm_cards` its compact trade plan whenever the receipt has those fields: `Entry $low–$high, target $up, invalidation $stop, R:R X.Xx; Researcher <grade> vs Prosecutor <conviction>`. Say `"unknown"` for each one that is absent. Rebuild the bundle if the UI changes. Tests in `brief-daily.test.js`.
- [x] **51. `tickets run-cycle`: unified Track 2 pipeline orchestrator.** In `dashboard/core/tickets.js` (`runCycle`) and `dashboard/cli.js` (`tickets run-cycle [--limit 10] [--dry-run] [--json]`):
  - Run, in order and deterministically: (1) `autoPilotSync`, (2) `batchGate`, (3) `quoteCandidates` (up to `limit`), (4) `pilotQueue`.
  - Return one combined JSON receipt with the counts and the next steps for Agent 1 and Agent 2.
  - Do not touch `mcp.js` or any protected file. Tests in `tickets.test.js`.
- [x] **52. UI: Interactive 4-Test Prosecution Matrix on `PMDecisionCard.jsx`.** In `PMDecisionCard.jsx` (and `inspector.css`), render the Prosecutor's four tests (`mercenary_emissions`, `tax_revenue`, `exit_slippage`, `unverified_claims`) as interactive status pills (`pass`, `fail`, `unknown`). Each expands to show the test's `finding` and its linked `source_ids`, plus `strongest_bull_rebuttal`. Rebuild the bundle. Tests in `web-app.test.js`.
- [x] **53. Invalidation proximity radar (`within 10%` warning).** In `dashboard/core/tickets.js` (`invalidationOf` / `view`) and `dashboard/core/brief-daily.js`:
  - It applies to a non-invalidated ticket with an active price trigger whose fresh stored price is within `10%` above `invalidation_trigger.price_usd` (`(price - stop) / stop <= 0.10`).
  - Attach `near_invalidation: { distance_pct, price_usd, threshold_usd, words }`.
  - Surface a `"Near invalidation"` section in `brief-daily.js` and a warning badge on `PMDecisionCard.jsx`.
  - Rebuild the bundle. Tests in `tickets.test.js` and `brief-daily.test.js`.
- [x] **54. UI: Track 2 Pilot Queue & Candidate Board in Research.** In `dashboard/public/views/research.js` (and its model in `dashboard/public/`), add a `"Track 2 Pilot Queue"` section of `pilotCandidates` rows. There is no read route for the rows yet, so add `GET /api/tickets/candidates` in `dashboard/server.js`; it writes nothing. Each row shows:
  - the grade;
  - the `@5 -> @6` report delta;
  - `$500` / `$2,000` exit-quote readiness;
  - the current pipeline step (`research`, `ticket`, `gate_closed`, `pm_review`, `done`);
  - a Pilot opt-in/out toggle button that calls `POST /api/projects/<id>/tickets/pilot`.

  Rebuild the bundle. Tests in `web-app.test.js`.
- [x] **55. Paper Book MFE / MAE excursion analytics in `paper.js` and Research.** In `dashboard/core/paper.js` (`readPosition`) and the Outcomes Paper UI (`dashboard/public/views/research.js` / `paper-model.js`):
  - From the stored hourly price series between `entry.at` and `close.at` (or now), compute `max_favorable_pct` (the highest hourly price against entry) and `max_adverse_pct` (the lowest hourly price against entry).
  - Compute them only when the entry is priced and the series covers the period; `unknown` when no readings exist.
  - Render MFE / MAE columns in the Paper Book table.
  - Rebuild the bundle. Tests in `tickets.test.js`.
- [x] **56. UI: Side-by-Side Researcher vs. Prosecutor Disagreement Card on `PMDecisionCard.jsx`.** In `PMDecisionCard.jsx`, when `agent_disagreement` is present, render a structured comparison block:
  - Agent 1's grade and verdict beside Agent 2's conviction and verdict;
  - `spread_points` and `agent_disagreement_note`;
  - when the project has `spread` alerts, a deep link to the widest diverging rubric category in Compare.

  Rebuild the bundle. Tests in `web-app.test.js`.
- [x] **57. Fundamental metric floor headroom in `invalidationOf` and `PMDecisionCard.jsx`.** In `dashboard/core/tickets.js` (`invalidationOf`), when `inv.metric` is bound and has a complete 30-day total after the ticket (`status: 'holding'`), include `headroom_pct` = `round(((total_30d_usd - below_30d_usd) / below_30d_usd) * 100, 1)`. Show it on `PMDecisionCard.jsx` and in `invalidation.checks`. Rebuild the bundle. Tests in `tickets.test.js`.
- [x] **58. UI: 7-Day Track 2 Telemetry Digest Card in `Research > Outcomes`.** Expose `tickets.digest(ws, { days: 7 })` (from item 34) on `GET /api/tickets/digest` in `dashboard/server.js`. In `Research > Outcomes` (`dashboard/public/views/research.js`), render a `"7-Day Desk Telemetry"` summary bar showing:
  - `@6` reports completed;
  - Prosecutor tickets against `desk_gate` passes;
  - invalidations fired;
  - the `ticket_repairs` count.

  Rebuild the bundle. Tests in `tickets.test.js` and `web-app.test.js`.
- [x] **59. 20-case adversarial simulation suite (`tests/sim/`).** Expand `dashboard/tests/sim/*.test.js` from 10 to 20 deterministic simulation cases. The new cases cover:
  - a stale price (over 90 minutes) capped at $0 on save (A03);
  - a price drop that lands before the save's lock (A03);
  - a 409 on Approve after invalidation (A04);
  - a 409 on Approve after a superseding report (A04);
  - Approve, then Undo, then Halve, leaving a single paper position (A06);
  - a paper position closing on the bound run's `horizon_end` (A05);
  - a near-miss prosecution (`grade 52` gets a Prosecutor and `$0 WATCH_ONLY`; item 48);
  - the `shadow_gate` fixed day-30 cohort against a moving price;
  - MFE/MAE across a price wick (item 55);
  - a corrupt receipt surfaced in `daily_brief` `ticket_repairs` (A07).
- [x] **60. One-click `tickets reconcile` repair command and API route.** In `dashboard/core/tickets.js` (`reconcileDesk(ws)`), `dashboard/server.js` (`POST /api/tickets/reconcile`) and `dashboard/cli.js` (`tickets reconcile [--json]`):
  - Scan every project for decisions whose post-commit side effects (`paper`, `journal` or `archive`) are missing or incomplete.
  - Repair them idempotently from the existing decision records, and return a deterministic repair report.
  - Add a `"Reconcile desk"` button in `DailyBrief.jsx` when `ticket_repairs` is non-empty.
  - Item 36 already built `reconcileEffects` and the CLI `tickets reconcile`. Build on them, and keep item 36's rule for a failed archive: name it, never archive, because Eric may have restored the project since. The archive repair waits for Eric's word.
  - Rebuild the bundle. Tests in `tickets.test.js`.
- [x] **61. Watchlist Exit-Liquidity Matrix (`tickets exit-matrix` & Forensics UI).** In `dashboard/core/tickets.js` (`exitMatrix(ws)`), `dashboard/server.js` (`GET /api/tickets/exit-matrix`) and `dashboard/cli.js` (`tickets exit-matrix [--json]`), return a deterministic table of every verified active project, sorted by grade, with:
  - its `$500` and `$2,000` exit cost %;
  - completeness and the missing cost components;
  - the chain and the quote's age;
  - its `native_l1_liquid` status.

  Render a compact Exit Matrix view in Research (`dashboard/public/views/research.js`) or Forensics. Rebuild the bundle. Tests in `tickets.test.js`.
- [x] **62. Core ticket formatting & geometry extraction (`dashboard/core/ticket-format.js`).** Extract the pure formatting, number rounding, currency and percent helpers, and the trade-plan geometry math (item 49), from `dashboard/core/tickets.js` into `dashboard/core/ticket-format.js`. Re-export any needed helpers from `tickets.js`, so every caller stays 100% compatible and `tickets.js` stays clean, fast and maintainable. Full test suite green.
- [ ] **63. Verify engineering worker execution with a web app test comment** *(engineering task eng-20261026-6ed83d v1, sha256 7ec4baefaba2ff25, authorized by Eric; built only through the engineering lane)*
  - Outcome: Claude Code: add one behavior-neutral comment tag ENGINEERING\_LANE\_SMOKE\_20261026 to an existing web app test, run the relevant existing test suite, and return exact-commit verification evidence through the engineering inbox. Exercise the normal claim, numbered admission, candidate and evidence flow.
  - Acceptance: Add exactly one lightweight comment tag ENGINEERING\_LANE\_SMOKE\_20261026 in the existing web app test without changing assertions, fixtures or runtime behavior.
  - Acceptance: Run the existing web app test suite and record the command, exit status and output against the exact candidate head and merge base.
  - Acceptance: Record worker claim and admission confirmation, candidate commit, remote action intent and readback, and verification evidence in the engineering inbox; report any blocker without bypassing the lane.
  - Acceptance: Submit the candidate for ChatGPT review under the matched delegation and report claim and dispatch status; do not claim execution from submission alone.
  - Scope: `dashboard/tests/web-app.test.js`
  - Not in scope: Application behavior, financial or research logic, dependencies, scheduler configuration and engineering controls changes.
- [ ] **64. Fix screening contract-change test clock fixture drift** *(engineering task eng-20261026-3e5961 v1, sha256 859383b17edd7f54, delegation pol-20261026-382d4a; built only through the engineering lane)*
  - Outcome: Fix test clock fixture drift in screening.test.js near line 396: in the contract-change alert test, pass { now: later } to buildIndex(ws) and projectDetail so the fixture does not expire against the fourteen-day window relative to real time.
  - Acceptance: Run the full test suite with node dashboard/cli.js test and record exit status zero with 1,017 of 1,017 tests passing, including command output and the exact candidate commit.
  - Acceptance: Limit the change to the contract-change alert test in dashboard/tests/screening.test.js, using the existing later fixture clock consistently for buildIndex and projectDetail without weakening assertions.
  - Scope: `dashboard/tests/screening.test.js`
  - Not in scope: Production behavior, expiration policy, dependencies and other files.
- [ ] **65. Add owner-activated UI delegation and explicit task re-binding** *(engineering task eng-20261026-9c21de v1, sha256 d4591a912d52e87c, authorized by Eric; built only through the engineering lane)*
  - Outcome: Implement Eric's requested versioned delegation eng-app@4 for browser source, public assets, tests and engineering documents, plus an owner-authenticated way to re-bind existing exact task versions. Reconcile tasks 63 and 64 with GitHub before changing their bindings, and support white-card task version 3. Submit an owner-reviewed PR; activation remains an owner action on the desk.
  - Acceptance: Add eng-app@4 rather than editing published eng-app@3, with allowed paths dashboard/web/src/\*\*, dashboard/public/\*\*, dashboard/tests/\*\* and docs/engineering/\*\* for goal engineering-lane-verification. Explicitly resolve current template-independent exclusions; a wider allowlist alone is insufficient.
  - Acceptance: Keep engineering authorization, promotion controls and their guard tests protected from delegated modification. Document exclusions precisely and ensure ordinary UI source, generated assets and ordinary tests can be scoped without accidentally matching protected controls.
  - Acceptance: Provide explicit owner-authenticated activation and re-binding of exact task versions and hashes, with audit events and no activation or approval by a submitter or worker. Do not rewrite historical admissions or existing task content to fake a new binding.
  - Acceptance: Read actual GitHub merge state for tasks 63 and 64 first: reconcile already merged work instead of re-promoting it. Preserve task 63's valid direct owner authorization unless Eric explicitly selects re-binding; permit a valid new binding for task 64 and white-card version 3 when needed.
  - Acceptance: Keep independent-review requirements: a review by the same connection that submitted a non-document task cannot decide it. Rebuild moved candidates on current main, retest and obtain the required independent or owner review on the exact new head and base.
  - Acceptance: Run node dashboard/cli.js test and the engineering and backlog test suites with exit zero. Evidence must cover allowed UI and bundle changes, blocked control changes, retired bindings, explicit owner re-binding, merge reconciliation and review independence.
  - Acceptance: Submit an exact-commit PR with changed policy behavior, tests and evidence. Do not activate or broaden any live delegation from this task or bypass existing authorization checks; await owner review and release.
  - Scope: `dashboard/engineering/policy.js`, `dashboard/engineering/inbox.js`, `dashboard/engineering/routes.js`, `dashboard/scripts/backlog-promote.js`, `dashboard/tests/engineering-inbox.test.js`, `dashboard/tests/engineering-flow.test.js`, `dashboard/tests/engineering-connector.test.js`, `dashboard/tests/backlog-promote.test.js`, `docs/engineering/**`
  - Not in scope: Reactivating retired templates, editing published policy records, changing financial rules, removing independent review, automatic authorization or live activation.
- [ ] **66. Add Authenticated Health Ping Endpoint for Scout Ingestion Service** *(engineering task eng-20261026-1b9979 v2, sha256 c4174b42ac3aa176, authorized by Eric; built only through the engineering lane)*
  - Outcome: Implement GET /api/ingest/ping inside server.js subject to normal frontdoor sign-in and session authentication. Valid authentication returns HTTP 200 with JSON status ok, service scout-ingest and an ISO timestamp; unauthenticated requests retain the frontdoor HTTP 401 response. Requested template is eng-app@4; use actual active delegation matching.
  - Acceptance: Implement GET /api/ingest/ping as an authenticated route in dashboard/server.js using normal frontdoor sign-in and session authentication without bypassing or modifying dashboard/frontdoor.js.
  - Acceptance: With valid authentication, return HTTP 200 and application/json with exactly status, service and timestamp keys, status equal to ok, service equal to scout-ingest, and timestamp a valid ISO date string.
  - Acceptance: Without authentication, verify the real frontdoor rejects GET /api/ingest/ping with HTTP 401 Unauthorized.
  - Acceptance: Add dashboard/tests/scout-ping.test.js exercising both unauthenticated HTTP 401 and authenticated HTTP 200 with the exact JSON schema and timestamp validity, using the existing hosted-server authentication test harness.
  - Acceptance: Run node --test dashboard/tests/scout-ping.test.js and node dashboard/cli.js test; both exit zero. Record actual counts, commands, output, candidate head and merge base.
  - Acceptance: Change only the two scoped files, keep the ping independent of database access, preserve other routes and authentication behavior, and submit the candidate with verification evidence for the required independent review.
  - Scope: `dashboard/server.js`, `dashboard/tests/scout-ping.test.js`
  - Not in scope: Unauthenticated ping access, frontdoor changes, new authentication mechanisms, Scout ingestion or persistence, dependency changes and files outside scope.


Phase 6, the next phase (Eric's architect request, 2026-10-27; blueprint `audits/2026-10-27-next-phase/README.md`). Repairs first (67–69: the desk says one true thing), then Track 2 improvements (70–72). Each item's `- **Schedule:**` line names what it waits for (`after`) and the only files and folders it may change (`touches`; `web` is `dashboard/web/` with its committed bundle); the scheduler builds items that share nothing side by side and the rest one after another. Every item stays out of `PROTECTED`, runs the whole suite, rebuilds the bundle after a web edit, and is released only by Eric's merge; recovery is reverting that merge. No item stores a new kind of record, starts research, calls a model, or writes except through an existing guarded route on Eric's click. Research, paper positions and real holdings stay apart in every line they produce.

- [ ] **67. The Daily Brief says what is true, urgent first.** In `dashboard/core/brief-daily.js`:
  - `pilot_exits`: when no active project is in the pilot, the section is one line, "No project is in the pilot, so no exit reading is expected.", with no link and a count of 0. "None right now." stays for pilot projects that all have their reading.
  - `pm_cards`: risk-reducing tickets first (`proposal_type` `TRIM_EXIT`, which the gate allows only on a held position), then tickets carrying `near_invalidation`, then the rest by waiting time, oldest first. The desk-gate cards (`desk_gate`) follow as one line, "n desk gates waiting: <names>.", linking to `#/research?tab=runs` (the Track 2 Pilot Queue). The section's count stays the number of cards waiting, the desk-gate line counting n.
  - Unchanged: an unreadable ticket still makes a section partial (A07); the brief's format, section IDs and line shape; `DailyBrief.jsx`.
  - Tests in `dashboard/tests/brief-daily.test.js`: no pilot project; pilot projects all with readings; one without; a fixture with a trim, a near-invalidation ticket, two ordinary tickets and three desk gates, in the stated order, with the desk-gate line's names and the count 6; an unreadable ticket keeps the section partial.
  - **Schedule:** touches dashboard/core/brief-daily.js, dashboard/tests/brief-daily.test.js
- [ ] **68. One trade-plan geometry, `cr-ticket-geometry@2`.** Today the near-invalidation radar measures `(price − stop) / stop` while the card's `to_stop_pct` and the held-position line (`position-brief.js`) measure from the price, so one ticket reads 2.60% and 2.54% on the same screen.
  - In `dashboard/core/ticket-format.js`: `nearInvalidation` reads the fall from the fresh price to the stop, `(price − stop) / price`, within `NEAR_INVALIDATION_PCT` (10), and carries `version: 'cr-near-invalidation@2'` (item 53's stop-based reading is `@1`, named in the comment). Its words: "a 7.31% fall reaches the invalidation price $x".
  - `tradePlanGeometry` becomes `cr-ticket-geometry@2`: it adds `plan_reward_risk_ratio = (up − mid) / (mid − stop)` from the entry zone's midpoint when `up > mid > stop`, known without a fresh price; `reward_risk_ratio` stays the one from the fresh price; `words` give both ("reward:risk 2.1:1 at plan, 1.4:1 now", or why "now" is unknown).
  - In `dashboard/core/brief-daily.js` `planOf`: "R:R 2.1x at plan, 1.4x now" (each "unknown" when absent). On `PMDecisionCard.jsx`'s Trade Plan strip: both, plan first.
  - Nothing stored changes: both are computed on read. `position-brief.js` already measures from the price and is not edited.
  - Tests: in `ticket-format.test.js`, the radar, `to_stop_pct` and `position-brief`'s distance agree to the cent on shared fixtures; a price 10.5% above the stop by the old reading (a 9.50% fall) is now near; plan R:R null unless `up > mid > stop`, and known with a stale price. Item 53's expectations in `tickets.test.js` and `brief-daily.test.js` move to the new reading; `web-app.test.js` for the strip. Rebuild the bundle.
  - **Schedule:** touches dashboard/core/ticket-format.js, dashboard/core/brief-daily.js, web, dashboard/tests/ticket-format.test.js, dashboard/tests/tickets.test.js, dashboard/tests/brief-daily.test.js, dashboard/tests/web-app.test.js
- [ ] **69. Set the cost where the desk asks for it.** A held position of unknown cost has no result, and `position-brief.js` sends Eric to "Portfolio > Needs attention (portfolio set-cost)", where no form exists; the route `POST /api/portfolio/set-cost` and the CLI do (item 45).
  - In `dashboard/public/views/portfolio.js` (`attentionRows` and its actions): a row for a position of unknown cost offers "Set cost", a small form with the average cost in USD (empty, never prefilled from a price), an optional acquired date and a reason. It posts exactly what was typed to the existing route, shows the route's own words about the date (`setcost-words.js`), and shows a refusal in the route's words. No other row gets the action.
  - `position-brief.js` `pnlOf`'s sentence names the control as it is drawn.
  - Not touched: `dashboard/core/portfolio.js` (protected), the route, the ledger's rules.
  - Tests: `portfolio-attention.test.js` (the action on unknown-cost rows only), `position.test.js` (the sentence), `web-app.test.js` (the form posts the typed body; a refusal is shown). Rebuild the bundle.
  - **Schedule:** touches dashboard/public/views/portfolio.js, dashboard/core/position-brief.js, web, dashboard/tests/portfolio-attention.test.js, dashboard/tests/position.test.js, dashboard/tests/web-app.test.js
- [ ] **70. Decide desk gates together.** Twelve $0 desk-gate cards each take their own Pass or Watch today.
  - In `dashboard/core/tickets.js`: `decideDeskGates(ws, { action, receipt_ids, request_id, note, dryRun })`, `action` `pass` or `watch` only. It takes desk-gate receipts still waiting for Eric on the latest report and calls the existing `decide` once per receipt, with that card's own `seen`, journal line and Undo: no new decision kind. A dry run lists each project, and for Pass which unheld projects it would archive (a held one never archives). A failure part-way leaves the decisions before it standing and names the rest; the same `request_id` completes them.
  - Route `POST /api/tickets/desk-gates/decide` in `dashboard/server.js` with `dry_run` and `expect` (the receipt IDs shown): a different set is 409 with nothing written, as the batch gate does. CLI `tickets decide-gates --action pass|watch [--dry-run] [--json]` in `dashboard/cli.js`.
  - In the Track 2 Pilot Queue (`dashboard/public/views/research.js`): "Watch all n" and "Pass all n" when desk gates wait; each shows the dry run's names first, then posts with `expect`, then each project's result.
  - Tests: `tickets.test.js` (dry run writes nothing; a changed set is 409; held projects never archive; each decision in its project's journal; replay completes a partial run; approve and halve are refused); `web-app.test.js` for the buttons. Rebuild the bundle.
  - **Schedule:** touches dashboard/core/tickets.js, dashboard/server.js, dashboard/cli.js, dashboard/public/views/research.js, web, dashboard/tests/tickets.test.js, dashboard/tests/web-app.test.js
- [ ] **71. Run the pilot cycle from the desk.** `tickets run-cycle` (item 51) runs only from the CLI on this PC; the online desk on Eric's phone cannot run it.
  - Route `POST /api/tickets/run-cycle` in `dashboard/server.js`: `tickets.runCycle` with `dry_run`, `limit` (1–200, default 10) and `expect` (`{ opted_in, gates_made, quoted }`, the counts shown). A run that would do more than `expect` is 409 with nothing done, as batch-gate and auto-pilot-sync answer. The answer is `runCycle`'s receipt, unchanged.
  - Exit quotes go through the existing adapter, budget, gates and the restored copy's hold, unchanged. The route starts no research, writes no ticket text and calls no model.
  - In the Track 2 Pilot Queue (`dashboard/public/views/research.js`): "Run pilot cycle", which shows the dry run's counts and names, then runs with `expect` and shows the receipt's counts and next steps for Agent 1, Agent 2 and Eric.
  - Tests: `server.test.js` or `tickets.test.js` (a dry run writes nothing and asks no provider, through a stub `fetchImpl` that fails the test if called; `expect` exceeded is 409; a restored copy asks no quote); `web-app.test.js` for the button. Rebuild the bundle.
  - **Schedule:** touches dashboard/server.js, dashboard/public/views/research.js, web, dashboard/tests/server.test.js, dashboard/tests/tickets.test.js, dashboard/tests/web-app.test.js
- [ ] **72. Horizon checkpoints in the Daily Brief.** Positions are held three to four months; nothing says where each stands in that time or when its research is due.
  - In `dashboard/core/brief-daily.js`, a section `horizons` ("Horizons") after `held`, with two kinds of line that never mix, each labeled:
    - "Held": each open ledger position with a ticket in force (`position-brief.js`): day n of the ticket's horizon from the decision date, the next 30/60/90/120-day mark, the horizon's end, and the age of Claude's current report against `freshness.report_stale_days` ("research due, n days old").
    - "Paper": each open paper position (`paper.js` `book`): the same timing from its own horizon.
  - An unknown horizon is said in words (`horizon_missing`), never given a default length; past the end it says so. Read-only; nothing stored.
  - Add to `dashboard/core/position-brief.js` only what the held line needs (the ticket's horizon and decision date).
  - Tests in `brief-daily.test.js` and `position.test.js`: held and paper lines labeled and separate; day 61 names day 90 next; past the end; research due with its age; no horizon in words; an unreadable record makes the section partial.
  - **Schedule:** after 67; touches dashboard/core/brief-daily.js, dashboard/core/position-brief.js, dashboard/tests/brief-daily.test.js, dashboard/tests/position.test.js

Not executable: Eric's decisions and protected work (`audits/2026-10-27-next-phase/README.md` §2C and §4). No builder takes these; each needs Eric's word first.

- *(Eric)* Merge the blueprint PR, then the scheduler PR (`claude/builder-burst`); the burst's capacity starts with the second merge and ends at 2026-10-27 23:00 ET either way.
- *(Eric)* The research cadence after `cr-at6-surge` ends (2026-10-27 23:00 ET). This phase starts no research.
- *(Eric)* Item 47 (`cr-ticket-sizing@3`) and binding OLAS's DefiLlama entity.
- *(Eric)* Solana exits read "at least" because the transfer tax is unknown; a new liquidity rule version is his.
- *(Eric)* Gemini's hold: `CLAUDE.md` says on hold, the online desk's settings say not.
- *(Eric)* Connector tools for the cycle and `desk_status` counts (`mcp.js` is protected).
- *(Eric)* Sending the brief or thesis-break alerts to him (a messaging channel he chooses).
- *(Eric)* Wallet sync's Alchemy 403 (the key in Render's environment).
- *(Eric)* Apply `.github/rulesets/automation-branches.json` again once the pipeline review's PR is merged: its `exclude` now lists `refs/heads/claude/backlog-*` and `refs/heads/claude/claims/**`, so the builders keep pushing.
- *(Eric)* A rollback drill record (`node dashboard/scripts/rollback-drill.js --from <ref> --record <audit-dir>`) for the scorecard.
- *(Eric)* Delete builder B after the burst (it stops itself; its cron next matches on 2027-10-27).

- Never in scope: an exchange or wallet connection, placing orders, moving money.

Phase 7, the Junior Trader engine (Eric, 2026-10-27; the roadmap, schema, Paper Book blueprint and limits under System Architecture & Conventions). Library code and its tests only: no route, CLI, connector tool or UI calls it yet, no model is called, and nothing places an order, connects a wallet or exchange, or moves money. Both items change protected files (pipeline review, 2026-10-27), so both are *(Eric)*: no builder takes them, and each is built only when Eric says so and released only by his merge. Each runs the whole suite.

- [x] *(Eric)* **73. Deterministic pre-trade risk engine (`eng-backend@1`; protected).** A pure function `validateTradeIntent(intent, book, rules)` in a new `dashboard/core/trade-risk.js` (`cr-trade-risk@1`). It reads no file, clock or network; the time comes in `book.now`.
  - It returns `{ ok, version, refusals: [{ field, rule, words }] }` with every failed check listed, never only the first; `ok` only with none. Nothing is trimmed or adjusted: an intent passes as written or is refused.
  - Shape: `version` is `cr.trade-intent.v2`; `intent_id` present; `side` `OPEN_LONG` or `CLOSE_LONG`, with `position_id` exactly when it is `CLOSE_LONG` and naming an open position of `book`; `order_type` LIMIT or POST_ONLY; every price and amount a plain decimal string, compared exactly and never through a float; `created_at`, `reference_at` and `valid_until` ISO-8601 UTC; `max_slippage_bps` an integer at most 20; `thesis_id`, `pair` and the three `evidence` fields present (evidence is never read for the decision).
  - Order of prices: stop below entry below take profit for `OPEN_LONG`.
  - Minimum stop distance: `entry − stop` at least the larger of `rules.stop_min_pct` × entry and `rules.stop_min_atr` × `book.atr_14h`. An unset figure or an unknown ATR refuses.
  - Size: quantity `floor_to_lot(risk_ceiling_usd / (entry − stop))` at `book.lot`; zero refuses. Notional at most the smaller of `rules.notional_max_pct` × NAV and `book.exit_max_usd`.
  - Risk cap: `risk_ceiling_usd` at most 2% of `book.nav_usd`.
  - Drawdown: refused when `book.drawdown_24h_usd` plus `risk_ceiling_usd` is above 4% of `book.nav_usd`, the hard ceiling for the rolling 24 hours.
  - Freshness: `reference_at` no older than `rules.price_stale_minutes` before `now`; `book.price` within `max_slippage_bps` of `reference_price`; `valid_until`, clipped to `created_at` plus `rules.max_validity_minutes`, after `now`.
  - Allowlist: `pair` must be in `rules.allowlist`, compared exactly. An empty or missing allowlist refuses every pair.
  - Halt: any order of `book` in state `UNKNOWN` refuses every new intent (invariant 4).
  - Unknown is never 0: a missing or unreadable NAV, drawdown, price, ATR or lot refuses the intent, with words saying which.
  - The limits are constants in the module (`RISK_PER_TRADE_MAX` 0.02, `DAILY_DRAWDOWN_MAX` 0.04, `SLIPPAGE_BPS_MAX` 20). `rules` may tighten them; a looser value is refused as a rule error, never applied.
  - Computing `book` from the Paper Book is item 74, not this one.
  - Tests in `dashboard/tests/trade-risk.test.js`: a passing `OPEN_LONG` and `CLOSE_LONG`; each rule refused on its own with its field named; several failures listed together; risk at exactly 2% passes and a cent over is refused; drawdown at exactly 4% passes and over it is refused; a stop one tick inside the floor is refused; a float or exponent where a decimal string belongs is refused; an unknown NAV, drawdown, price or ATR refuses; an `UNKNOWN` order refuses every intent; a looser `rules` is refused; the inputs are unchanged after the call.
  - Built by PR #58 (`529f08b`, merged by Eric 2026-10-27); what it adds beyond this text is in the module's header (risk held to the desk's grant, costs in the size, future stamps refused, `RESERVED` and `SENT` halt too).
  - **Schedule:** touches dashboard/core/trade-risk.js, dashboard/tests/trade-risk.test.js
- [x] *(Eric)* **74. Paper Book `cr-paper@2` (`eng-backend@1`; protected).** In `dashboard/core/paper.js`, beside `cr-paper@1`, as the blueprint under System Architecture & Conventions says: cash NAV, discrete sizing, fills through the price with partial fills, maker and taker fees, stop slippage, hourly high/low stops (the stop first when one hour reaches both) and long only. It replaces the earlier `paper-fills.js` harness (`cr-paper-fill@1`), which was never built.
  - Its own append-only records under `paper/`, written through `runOp` as `paper.js` writes; the same `intent_id` again is `unchanged`. They never enter `paper/positions.jsonl`, the PM Paper Book's counts or Portfolio, and `cr-paper@1` reads the same before and after.
  - The book it hands item 73 (`book`: NAV, 24-hour drawdown, price, ATR, lot, exit size, open positions and orders by state), each unknown said in words, never 0.
  - Tests in `dashboard/tests/paper-trader.test.js` (temporary workspaces): a fill only when the low trades through; a partial fill over the volume share; maker and taker fees; an unknown fee refuses; a stop with slippage and a gap through it; one hour reaching both stop and target takes the stop; NAV unknown without a fresh price; cash never negative; the same intent twice is `unchanged`; `paper.book` (`cr-paper@1`) unchanged.
  - Built by PR #59 (`e7d580a`, merged by Eric 2026-10-27) in a new `dashboard/core/paper-trader.js`, so `paper.js` (`cr-paper@1`) is not edited.
  - **Schedule:** after 73; touches dashboard/core/paper.js, dashboard/tests/paper-trader.test.js
