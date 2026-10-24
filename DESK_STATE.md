# Desk state: the Junior Trader pipeline (Phase 1)

Last updated 2026-10-24. This page covers the PM trade ticket pipeline. The rest of the desk is described in `CLAUDE.md` and `COWORK-INSTRUCTIONS.md`.

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

## Sizing rules (`cr-ticket-sizing@1`, Eric's choices)

| Rule | Value |
|---|---|
| Standard risk (1.0R) | $500, only when the measured exit cost at $500 is at most 5% (known in full, not a lower bound) and Agent 1's grade is at least 55 |
| Starter tranche (0.5R, "Halve Size") | $250 |
| Grade under 40 | no new risk (HARD_PASS or WATCH_ONLY), $0 |
| Grade under 55, not held | no new entry, $0 |
| Held, any grade | TRIM_EXIT is always allowed (it takes no new risk) |

- The grade is the desk's calculated grade of Claude's current report. A range is read by its low end; a withheld grade means no grade.
- A proposal the rules don't allow is capped to WATCH_ONLY at $0. The model's own type is kept beside the capped one, with the reason.
- The rules can be overridden in settings `tickets.sizing`. Each ticket freezes the values it was made under.

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

## Autonomous Build Backlog

For a `/loop` or scheduled Claude Code session (e.g. the hourly cloud routine): take up to **two** unchecked items per session, in order, following `CLAUDE.md` (edit, run `node dashboard/cli.js test`, rebuild the bundle after UI edits). Build item A and run the tests; build item B and run the tests again across both changes; check both off here and report. Both go on one branch and one pull request for Eric (e.g. `claude/backlog-batch-items-1-and-2`). If A's tests fail, fix A or stop and report; never start B on a red suite. If only one buildable item is left, or the next is marked *(Eric)*, take the one. A scheduled routine never pushes to `main` and never force-pushes. Items marked *(Eric)* need his decision first: ask, don't build.

- [x] Phase 1 tickets, connector tools, PM Decision Card, under-40 filter (f715a3e, live 2026-10-24)
- [x] Sub-agents `forensic-researcher`, `junior-trader-prosecutor` and `/pilot-run`
- [x] PM Decision Card polish, drawer nag, pilot on/off wording (954f87d)
- [ ] **1. Native L1 exemption** (Eric, 2026-10-24): in `core/tickets.js` `gate()`, a native coin (`identity.native_chain`) with market cap of at least $10B from the stored CoinGecko row passes the exit check without a DEX quote; the packet and receipt say `exit_basis: 'native_l1_liquid'` (otherwise `'measured'`). This is a new rules version: `cr-ticket-sizing@2`, frozen into new tickets; `@1` tickets keep theirs. Tests: ETH at $10B+ passes, a native coin under $10B and any token do not.
- [ ] **2. Preferences > Screening: ticket sizing.** A panel editing `tickets.sizing` (standard and starter risk, exit size, max exit cost %, the two grade floors), saved through `POST /api/settings` with `server.js` `validateSettingsPatch` using the same bounds as `tickets.sizingOf`; labeled as Eric's choices. Unit tests in `tests/tickets.test.js` for the bounds and that saved tickets keep their frozen values.
- [ ] **3. PM decisions in the journal.** Each `decide()` action (`approve`, `halve`, `veto`, `pass`, `watch`, `trim`, and `undo`) also writes a structured journal entry (`notes.js`, `journal.v1.schema.json`; type decision, linked receipt ID, approved risk) so it shows in Notes. `decisions.jsonl` stays the source of truth; a journal failure never loses the decision. Tests.
- [ ] **4. Missing exit quotes, in words.** The packet records which sizes ($500, $2,000) have no current reading and why; the PM Decision Card lists them with a link to `#/project/<id>/forensics?tab=exits` (or the tab's real address) to approve quotes. Tests for the packet field.
- [ ] **5. Fixed-size quote before sizing.** When `createTicket` finds no $500 reading on a verified, quotable token, ask for one fixed-size quote first (`forensic-monitor.js` `quoteFixedToken`: the existing adapter, gates, budget, hold and one request ID; never a wallet or swap). Async, so it belongs to the route and CLI, not the pure create; a failed or refused quote falls back to $0 with the reason. Tests with a stubbed network.
- [ ] Pilot runner: drop `shell: true` in `dashboard/scripts/pilot.js` (Node DEP0190 warning); resolve `claude.exe` on Windows instead
- [ ] *(Eric)* Bind OLAS's DefiLlama entity so the fundamental invalidation trigger is checked
- [ ] *(Eric)* ChatGPT as a second Prosecutor (`cr-ticket-challenge@1`, its own receipt, never averaged)
- [ ] *(Eric)* Put more projects in the pilot; a scheduled `/pilot-run` cadence
- Never in scope: an exchange or wallet connection, placing orders, moving money.
