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

**Each cloud routine or scheduled run takes up to 3 unchecked backlog items at a time (Eric's surge, until 2026-10-27 23:00 ET; 2 after it), implements and tests them together, and bundles them into one combined feature branch and PR.**

For a `/loop` or scheduled Claude Code session (e.g. the hourly cloud routine), from 2026-10-24 (blueprint Appendix A; surge sizes from 2026-10-24 evening, Eric):

- **Taken.** An item is taken when it is ticked here, or when a commit on `origin/main` or on an `origin/claude/backlog-*` branch carries `Backlog-Item: <n>` for it (older commits name it in their subject, `backlog: <item text>`).
- **WIP cap.** Items whose commits are on branches not yet merged into `origin/main` are waiting (count each item once). Until 2026-10-27 23:00 ET (New York), build nothing when 9 or more are waiting; after that, when 4 or more are. Report the cap. Check this first, before reading the long docs.
- **Build.** Take the next buildable items in order, three during the surge and two after it: unchecked, not marked *(Eric)*, not taken. Follow `CLAUDE.md`: edit, run `node dashboard/cli.js test`, and rebuild the bundle after UI edits. Build one item and run the tests, then the next, running the tests again across everything on the branch. If an item's tests fail, fix it or stop and report; never start the next on a red suite. After any fix, run the whole suite again before pushing. If fewer buildable items are left, take those.
- **Base.** When a backlog branch is waiting, start from the newest waiting one (stacked), so the batch builds on the work before it and the branches never conflict; otherwise from `origin/main`. The PR then lists the earlier batch's commits too: merging the newest merges them all.
- **Branch.** The batch goes on one branch, `claude/backlog-batch-items-<a>-<b>-<c>` (or `-<a>-and-<b>` for two). Use one commit per item, each with a `Backlog-Item: <n>` line. **Don't tick the boxes here on the branch:** the merge train ticks them on `main`. The `test` workflow runs on the push, and when it passes `backlog-pr` opens the pull request and merges it into `main`, deleting the branch (Eric, 2026-10-25: a green `claude/backlog-*` branch is auto-merged by `backlog-pr.yml`; a failing run never opens or merges a PR; a refused merge leaves the PR open for `npm run train`). Since the review of 2026-10-25 (A01/A02, `dashboard/scripts/backlog-promote.js`) it merges only the tree that passed the full suite on top of `main` as it is, and only while `main` is still that commit; the result is read back from GitHub and the branch is deleted only at the tested commit. **Every commit carries its `Backlog-Item: <n>` line.** A commit without one, an item not unchecked on `main`'s backlog or marked *(Eric)*, or a change to a protected path (`.github/`, `.claude/`, `CLAUDE.md`, `COWORK-INSTRUCTIONS.md`, `DESK_STATE.md`, `oauth.js`, `mcp.js`, `hosted.js`, `server.js`, the ledger and wallet code, the promotion scripts, `package*.json`, an existing template) leaves the PR open for Eric.
- **Never** push to `main` or force-push. Items marked *(Eric)* need his decision first: ask, don't build.

Merged into `main` (2026-10-24): items 1–6, through one train branch (`claude/train-2026-10-24`, PR #2) built from the five backlog branches, with the bundle rebuilt once and the full suite run. The source branches were then deleted. Items 10 and 11 were built locally the same day. CI (`.github/workflows/test.yml`) now runs on every `claude/**` push, and `backlog-pr.yml` opens the PR once it is green. Items 7, 8, 9 and 21 were merged the same evening (PRs #3 and #4, through `claude/train-items-7-8-9-21`; `tickets.js` overlaps kept from both sides, the bundle rebuilt once, the full suite run), and both branches were deleted.

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

- Never in scope: an exchange or wallet connection, placing orders, moving money.
