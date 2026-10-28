# Desk state: the Junior Trader pipeline (Phase 1)

Last updated 2026-10-28. This page covers the PM trade ticket pipeline and the contract for the trader to come. The rest of the desk is described in `CLAUDE.md` and `COWORK-INSTRUCTIONS.md`.

## North Star: Track 1 serves Track 2 (Eric, 2026-10-25)

Two tracks run on this desk:

- **Track 1, the self-building codebase.** Retired 2026-10-27 (`docs/CONSTITUTION.md`): work is one supervised task, one branch, one pull request and Eric's merge. Its backlog is frozen in `docs/history/autonomous-build-backlog.md` (PR-B 5b, 2026-10-28).
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

Eric, 2026-10-27. The contract for the autonomous trader still to be built, so the sandbox, the ledger (`dashboard/scripts/agent-ledger.js`) and the desk's deterministic gates carry unattended trading without rework. The pre-trade risk engine (`dashboard/core/trade-risk.js`, `cr-trade-risk@1`, PR #58; `cr-trade-risk@2` since D8, 2026-10-28) and the trader's Paper Book (`dashboard/core/paper-trader.js`, `cr-paper@2`, PR #59) are built as library code; no route, CLI, connector tool, UI or agent calls them, and nothing routes anywhere. The North Star invariants above stay in force: today nothing places an order, connects a wallet or exchange, or moves money.

1. **Separation of proposal and execution.** The LLM agent is an analyst only. It never holds execution API keys and never signs a transaction. It emits a typed `TradeIntent` (below). An out-of-band deterministic engine intercepts, validates and routes it; while invariant 5 holds, it routes only to the Paper Book.
2. **Stateless shift work.** The trader runs in discrete, stateless evaluation cycles during the target market's liquidity windows. Each tick re-derives its state from disk only (`DESK_STATE.md`, open position records, fill journals) and exits. No long-lived chat memory.
3. **Immutable risk boundary.** The risk limits are hard-coded in the engine, outside the model's context window: at most 2% of the Paper Book's NAV (`cr-paper@2`, below) at risk per trade; a stop-loss on every trade, no nearer the entry than the minimum stop distance; an asset allowlist; and a hard ceiling on drawdown of 4% of NAV in any rolling 24 hours (Eric, 2026-10-27). The agent cannot alter, soften or bypass them. The engine (`dashboard/core/trade-risk.js`), both Paper Books (`dashboard/core/paper.js`, `paper-trader.js`) and the exact arithmetic they compute with (`dashboard/core/decimal.js`) are protected files.
4. **Reconciliation and nonce guard.** The Paper Book's journal is a hash-chained, append-only record written under the workspace lock, and every action is reserved before it is sent. Its records carry no MAC: the trader holds no key (Eric, 2026-10-28; D9). An order never times out to `lost` (pipeline review, 2026-10-27), and since the red-team review the same day no clock settles a build either (`agent-ledger.js` `settleOpen`).
   - **States.** `INTENT` → `RESERVED` (the `intent_id` and the `client_order_id` derived from it, recorded before anything is sent) → `SENT` → `ACKED`, `REJECTED` or `UNKNOWN`; then `ACKED` → `PARTIAL` → `FILLED`, `CANCELLED` or `EXPIRED`.
   - **Unknown stays unknown.** A timeout, a dropped broker WebSocket or an answer that does not read makes the order `UNKNOWN`. It stays `UNKNOWN` until the engine has asked the venue for that `client_order_id` and recorded the venue's answer. It becomes `NOT_FOUND` only when the venue, asked for that `client_order_id`, has no record of it and the venue's duplicate-order window has passed. For the simulated venue, whose record is complete by construction, that window is 60 minutes from the send, on the engine's clock (`paper-trader.js` `VENUE_DUPLICATE_WINDOW_MINUTES`). A real venue would need its own explicit "unknown order" answer, and its own documented window, before `NOT_FOUND`; nothing connects to one. The clock alone never settles an order: it only gates `NOT_FOUND` once the venue has been asked.
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
- **Minimum stop distance.** `entry_price − stop_loss_price` is at least the larger of `STOP_MIN_PCT` × entry and `STOP_MIN_ATR` × the pair's 14-hour ATR. A stop one tick from the entry would turn a small risk ceiling into a huge position. Eric sets both figures in Preferences > Screening (settings `trader.rules`, D10). Until he does, or while the ATR is unknown, every intent is refused (unknown is never 0).
- **Size and notional cap.** The quantity is `floor_to_lot(risk_ceiling_usd / per_unit_loss)`, never rounded up; zero is a refusal. `per_unit_loss = entry − stop_fill + fee(entry) + fee(stop_fill)`, where `stop_fill = stop × (1 − STOP_SLIPPAGE_BPS / 10,000)`, the entry pays the maker rate for `POST_ONLY` and the taker rate otherwise, and the exit pays the taker rate, each fee rounded up (`trade-risk.js`). So the loss at the stop, every cost in, is within the risk ceiling. Its notional (quantity × entry) is at most the smaller of `NOTIONAL_MAX_PCT` × NAV and the largest size the desk's exit measurement (Forensics > Exits) shows can be sold within the slippage limit (since D11, the ticket's frozen exit readings, under `cr.trade-intent.v3` below). Eric sets `NOTIONAL_MAX_PCT` in Preferences > Screening; unset refuses.
- **Risk is checked, never adopted.** The desk's gate sizes every ticket and a model never chooses an amount (North Star). The engine refuses `risk_ceiling_usd` above 2% of NAV, above the gate's suggested risk, or above Eric's PM decision (`pm_approved_risk_usd`).
- **Fresh price.** Refused when `reference_at` is older than `freshness.price_stale_minutes` at evaluation, or when the engine's own current price is further from `reference_price` than `max_slippage_bps`.
- **Bounded life.** `valid_until` is read as the earlier of itself and `created_at` plus the engine's maximum validity; an intent already past it is refused.
- **Evidence is for the record.** The engine stores `evidence` with the intent for the audit trail and reads none of it for a decision.
- The schema is published as `templates/schemas/trade-intent.v2.schema.json` (PR #58) and never edited after; a change is `cr.trade-intent.v3`.

### `TradeIntent` schema (`cr.trade-intent.v3`)

Eric, 2026-10-28 (D8, T-P2-15 in `audits/2026-10-27-de-escalation`). The engine (`cr-trade-risk@2`) accepts only this version. It is v2 with the ticket the intent acts on:

```json
{
  "version": "cr.trade-intent.v3",
  "thesis_id": "string, equal to receipt_id",
  "project_id": "string, the desk project",
  "receipt_id": "string, the ticket receipt (tr_…)",
  "decision_id": "string, Eric's PM decision on it (td_…)"
}
```

Every other field is v2's, as above.

- **The grant is Eric's stored decision.** The Paper Book reads the decision from the desk's own record of them, `projects/<project_id>/tickets/decisions.jsonl`, under the same lock as the reservation.
- **It is a grant only while it is the decision in force.** `decision_id` must be the decision in force for `receipt_id`, by the desk's rule (`core/tickets.js` `decisionFor`, the last line no undo takes back; `trader-boundary` checks the two agree). It must be an approve or a halve above $0. The grant is then exactly its `pm_approved_risk_usd` and `suggested_risk_usd`, and the engine holds the thesis to both.
- **Refused:**
  - a grant from the caller (`ctx.grant`: nothing is read or written);
  - a veto, pass or watch;
  - an undone or replaced decision;
  - a decision of another project or another decision schema;
  - a missing or unreadable record, or a line in it that does not read (the desk skips such a line; the trader refuses, since an undo it held could leave a grant standing);
  - a `project_id` that is not one;
  - a v2 intent.
- **A close reads no grant.** A `CLOSE_LONG` only reduces risk, so a position still closes after Eric takes the grant back.
- **The exit cap is the ticket's frozen exit readings (D11, Eric 2026-10-28).** The Paper Book reads `book.exit_max_usd` under the same lock, from the same ticket, and loads no desk module:
  - the receipt `projects/<project_id>/tickets/receipts/<receipt_id>.json` (a `cr.ticket-receipt.v1` of that project);
  - the packet it names inside the project's tickets, checked against the SHA-256 the receipt froze;
  - the exit-cost limit the receipt's sizing froze (`desk.sizing.max_exit_cost_pct`).
- **The cap is the largest size that passes.** A reading passes when its cost is known in full, is at or under the limit, and is no older than the desk's exit freshness window (72 hours, `forensic-defs.js` `liquidity_impairment`; `trader-boundary` checks the two agree) at the intent's time. The reading that set the cap is recorded on the reservation (`exit`).
- **Refused, with the reason in words** (nothing reserved):
  - an exit cap from the caller (`ctx.exit_max_usd`: nothing is read or written);
  - a missing, foreign or unreadable receipt;
  - a packet outside the ticket, missing, altered or unreadable;
  - no frozen limit;
  - no size whose reading passes. Each size says why: no reading, a lower bound, over the limit, undated, dated after now, or older than 72 hours.
- **A close reads no exit cap.** A position still closes after its readings go stale.
- The schema is published as `templates/schemas/trade-intent.v3.schema.json` and never edited after; v2's file stays as published; a change is `cr.trade-intent.v4`.

### Paper Book `cr-paper@2`

Pipeline review, 2026-10-27. What the trader's Paper Book must be before any engine routes an intent to it. Built in `dashboard/core/paper-trader.js` (PR #59) beside `cr-paper@1` (`dashboard/core/paper.js`, unchanged), which keeps measuring the PM's ticket decisions exactly as it does. `cr-paper@2` has its own hash-chained, append-only records under `paper/trader/` and never touches `paper/positions.jsonl`.

- **Cash NAV.** The book starts from a cash balance Eric sets; unset, it holds nothing and the engine refuses every intent. NAV is cash plus each open quantity × its latest hourly price. A position without a fresh price makes NAV unknown, never valued at 0 or at its entry.
- **Discrete sizing.** The quantity is `floor_to_lot(risk_ceiling / per_unit_loss)`, the loss per unit at the stop with its slippage and both fees in (above), at the venue's lot size and minimum notional; below the minimum there is no order. Cash is debited at each fill and credited at each exit, and never goes negative.
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
- **Journal head (D7, Eric 2026-10-28; `audits/2026-10-27-de-escalation` §3.3).** Made before any record exists, under the same version name:
  - `paper/trader/journal.head.json` holds the number and SHA-256 of the journal's last line. It is written after the journal, in the same commit.
  - The journal is refused (`INTEGRITY`, nothing read or written) when it is shorter than its head, when the line the head names does not hash to it, or when it has lines and no head.
  - A journal longer than its head, the chain intact, is read, and the head moves forward with the next write.
  - Only a missing file reads as empty. Any other read error stops, so an unreadable journal is never a fresh book.
  - Every `client_order_id` the venue holds must be one the journal reserved and sent. A venue order the journal does not know is `INTEGRITY`.
  - No key is held (Eric's choice). The head catches a crash, a full disk, a one-file restore or a hand edit. It does not stop someone who rewrites the files consistently.
- **Protected.** `dashboard/core/paper.js`, `paper-trader.js`, `trade-risk.js`, `decimal.js` and their tests (`trade-risk`, `paper-trader` and `trader-boundary` under `dashboard/tests/`), with the frozen intent schemas, are on the protected list in `dashboard/tests/trader-boundary.test.js` (PR-B 5a, 2026-10-28). A change to any of them is its own supervised pull request, marked [P] in its title, that Eric reviews deliberately (`audits/2026-10-27-de-escalation` §4).

### Junior Trader roadmap

Eric, 2026-10-27; corrected by the pipeline review the same day. Both steps change protected files, so both backlog items were *(Eric)*: no builder took them. Both are built and merged by Eric (PRs #58 and #59).

1. **Pre-trade risk engine** (item 73, built, PR #58). `validateTradeIntent` in `dashboard/core/trade-risk.js`: a pure check of every `cr.trade-intent.v2` against invariant 3's limits and the rules above.
2. **Paper Book `cr-paper@2`** (item 74, built, PR #59). The blueprint above, in `dashboard/core/paper-trader.js`. It replaces the earlier `paper-fills.js` harness (`cr-paper-fill@1`), which was never built.

| Limit | Value |
|---|---|
| Risk per trade | at most 2% of NAV (`cr-paper@2`) |
| Drawdown | at most 4% of NAV in any rolling 24 hours, a hard ceiling |
| Minimum stop distance | the larger of `STOP_MIN_PCT` × entry and `STOP_MIN_ATR` × the 14-hour ATR: Eric's, in Preferences > Screening (`trader.rules.stop_min_pct`, `stop_min_atr`), unset |
| Notional cap | the smaller of `NOTIONAL_MAX_PCT` × NAV and the exit measurement's size: Eric's, in Preferences > Screening (`trader.rules.notional_max_pct`), unset |

Open (Eric):

- The Paper Book's starting cash. Until he sets it, NAV is unknown and the engine refuses every intent (unknown is never 0).
- The asset allowlist has no pairs yet; an empty allowlist refuses every intent.
- The values of `STOP_MIN_PCT`, `STOP_MIN_ATR`, `NOTIONAL_MAX_PCT`, the maximum validity and the allowlist. Their home is settings `trader.rules`, entered in Preferences > Screening and checked by the server (`dashboard/core/trader-rules.js`, `cr-trader-rules@1`, D10). All are unset. The price freshness is `freshness.price_stale_minutes`.
- The venue whose fee schedule and lot sizes the book uses. `FILL_SHARE_MAX` (0.1) and `STOP_SLIPPAGE_BPS` (25) are the Paper Book's constants.

## Retired backlog

The Active Backlog and the Autonomous Build Backlog were retired with the agent lane (PR-B 5b, 2026-10-28) and frozen in `docs/history/autonomous-build-backlog.md`. Nothing builds from them.
