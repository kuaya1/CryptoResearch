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

**Each cloud routine or scheduled run must take up to 2 unchecked backlog items at a time, implement and test them together, and bundle them into a single combined feature branch and PR.**

For a `/loop` or scheduled Claude Code session (e.g. the hourly cloud routine): take the next two buildable items in order (unchecked, not marked *(Eric)*, not already on an open `claude/backlog-*` branch), following `CLAUDE.md` (edit, run `node dashboard/cli.js test`, rebuild the bundle after UI edits). Build item A and run the tests; build item B and run the tests again across both changes; check both off here and report. Both go on one branch and one pull request for Eric (`claude/backlog-batch-items-<a>-and-<b>`). If A's tests fail, fix A or stop and report; never start B on a red suite. If only one buildable item is left, take the one. A scheduled routine never pushes to `main` and never force-pushes. Items marked *(Eric)* need his decision first: ask, don't build.

Merged into `main` (2026-10-24): items 1–6, through one train branch (`claude/train-2026-10-24`, PR #2) built from the five backlog branches, with the bundle rebuilt once and the full suite run. The source branches were then deleted. Items 10 and 11 were built locally the same day. CI (`.github/workflows/test.yml`) now runs on every `claude/**` push, and `backlog-pr.yml` opens the PR once it is green.

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
- [ ] *(Eric)* Put more projects in the pilot; a scheduled `/pilot-run` cadence

30-day blueprint items (2026-10-24, `audits/2026-10-24-30-day-blueprint/README.md`; the W-number is its section):

- [ ] **7. Pilot candidates, read-only (W1.2).** `core/tickets.js` `pilotCandidates(ws)`, CLI `tickets candidates [--json]`, and `autonomous_pilot_queue` with `candidates: true`. Order: held projects first, then verified, active projects by the desk's calculated grade of Claude's current eligible report (a range by its low end; withheld and no report last). Each row gives the gate's result today with no proposal (`gate(basis, sizing)`: allowed types, suggested risk, reasons), whether an exit reading exists at the sizing's exit size, the report's age and prompt version, and whether it is already in the pilot. It writes nothing and opts nothing in. Tests: ordering, held first, unknown grade last, nothing written.
- [ ] **8. Invalidation coverage, `cr-ticket-invalidation@2` (W1.4).** In `invalidationOf`, the price check states its coverage: hours since the ticket with at least one hourly reading, out of hours elapsed. Any gap over 6 h is named with its start and end. Coverage under settings `tickets.invalidation.min_coverage_pct` (default 90, labeled as Eric's choice, bounded in `validateSettingsPatch`) reads `unknown`, never `holding`; a reading at or below the threshold still reads `triggered`. A receipt whose Researcher report is superseded or past `freshness.research_stale_days` gets `basis_stale: { why }`, and its status is unchanged. New receipts record `desk.invalidation_version`; one without it is read under @1, unchanged. Tests: a 12 h gap with the low inside reads unknown, full coverage reads holding, a reading in the window still triggers, an @1 receipt reads as before.
- [ ] **9. Pre-gate, `cr-ticket-pregate@1` (W1.3; Eric approved 2026-10-24).** When the grade alone rules out new risk (Claude's current report has no grade, or one under `min_grade_new_entry` of the sizing in force) and the project is not held, no Prosecutor runs. A missing or costly exit alone still gets a Prosecutor.
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
- [x] **10. CI (W2.1)** (built locally 2026-10-24: `.github/workflows/test.yml`; pushes to `claude/**` and PRs to `main`, `ubuntu-latest`, Node 24.21.0, `node dashboard/cli.js test`, the counts in the job summary and a `test-summary` artifact)
- [x] **11. Backlog PRs from Actions (W2.2)** (built locally 2026-10-24: `.github/workflows/backlog-pr.yml`; after `test` succeeds on a push to `claude/backlog-*`, opens or updates one PR to `main` with the commits and counts through `GITHUB_TOKEN` and the REST API, only for the commit that was tested; a red run opens nothing. Needs Eric's repo setting: Actions > General > "Allow GitHub Actions to create and approve pull requests")
- [ ] **12. Merge train (W2.3).** `dashboard/scripts/merge-train.js`, `npm run train [-- --push]`. From `origin/main`, merge each waiting `origin/claude/backlog-*` branch in item order (stacked branches after their base) onto `claude/train-<YYYY-MM-DD>`. A conflict only in `dashboard/public/app/**` or `DESK_STATE.md` takes `main`'s side, then the bundle is rebuilt once (`npm ci && npm run build` in `dashboard/web`) and the merged items are ticked. Any other conflict stops and names the branch and files. Then the full suite runs and the script prints what was merged and skipped and the counts. It pushes only with `--push` and never touches `main`. Tests use a temporary git repo fixture: a clean train, a bundle-only conflict resolved, a code conflict stopped.
- [ ] **13. Rollback-safe records (W2.5).** `tickets.view`, `tickets.summary` and the indexer read a receipt or ticket from an unknown sizing or invalidation version (for example `@9`) as "made under a newer rule (`<version>`): shown as saved, not re-read", never throwing, with its saved figures as they are. Tests: a fictional workspace holding `@9` receipts renders, and the index builds.
- [ ] **14. Guardrail invariants (W2.6).** `dashboard/tests/guardrails.test.js` runs over the API answers of a rich fictional workspace (projects with reports from two models, tickets, forensics):
  - no desk-generated text puts a % beside probability, chance or likely;
  - no unknown value is serialized as 0 where the record has none;
  - there are no averaged or midpoint grade fields;
  - every two-agent or two-model view carries both figures;
  - nothing is labeled safe.

  Tests only; if one finds a real breach, fix it in the same item and name it.
- [ ] **15. Daily brief, `cr-daily-brief@1` (W3.1).** `dashboard/core/brief-daily.js`, `GET /api/brief/daily?since=<iso>`, CLI `brief daily [--json] [--since]`, and a read-only connector tool `daily_brief` for every model. Each line has its `#/…` deep link:
  - PM cards waiting, with their age;
  - tickets invalidated since `since`;
  - tickets on a stale or superseded basis;
  - pilot projects missing an exit reading;
  - held positions' value and 24h change (unknown said);
  - research waiting per model;
  - Review's Models differ group;
  - backup age and price freshness.

  It is deterministic and gives the SHA-256 of its text. It writes nothing. A section it could not read says so, never "nothing". Tests on a fictional workspace, including that a read writes nothing.
- [ ] *(Eric)* **16. Read-only connector grant (W3.2).** The OAuth consent offers "Read only". Such a connection lists and accepts only the read tools (`desk_status`, `find_projects`, `get_report`, `compare_reports`, `portfolio_overview`, `list_accounts`, `pending_research`, `pending_forensics`, `pending_tickets`, `autonomous_pilot_queue`, `get_forensic_audit`, `daily_brief`). A write is refused with the reason, and `desk_status.assistants` shows the kind. It is for Duet. It touches `oauth.js` and `mcp.js`.
- [ ] *(Eric)* **17. Voice intake, in a local session (W3.4).** `.github/workflows/backlog-intake.yml`: on `issues: labeled`, only when the label is `ready` and the sender is `kuaya1`, open a PR that adds the issue, quoted and linked, as the next numbered item. It builds nothing; Eric merges it like any PR.
- [ ] **18. Paper book, `cr-paper@1` (W4.1).** `dashboard/core/paper.js`, append-only `paper/positions.jsonl` (backed up and exported, never in `portfolio/`, Portfolio counts or wallets). A `risk_granted` decision opens a position of `pm_approved_risk_usd`:
  - entry at the hourly reading nearest the decision within 6 h, else "no entry price", never a later one;
  - entry cost "unknown", never 0.

  It closes at the first hourly reading at or below the invalidation price (that reading), on `trim_acknowledged`, or at the horizon's end. Its return against BTC uses the same records. A $0 ticket gets a shadow line ("Shadow: not taken"). Undo of the decision voids the position with a reason, never deleting it. No total, median or hit rate before 20 have closed. It shows under Research > Outcomes as "Paper". Tests.
- [ ] **19. Scenario harness (W4.2).** `dashboard/tests/sim/*.test.js` with price paths in `dashboard/tests/fixtures/sim/`, zero network. Each case asserts statuses and words:
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
- Never in scope: an exchange or wallet connection, placing orders, moving money.
