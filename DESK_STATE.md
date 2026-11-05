# Desk state: the Junior Trader pipeline (Phase 1)

Last updated 2026-11-03. This page covers the PM trade ticket pipeline and the contract for the trader to come. The rest of the desk is described in `CLAUDE.md` and `COWORK-INSTRUCTIONS.md`.

## North Star: Track 1 serves Track 2 (Eric, 2026-10-25)

Two tracks run on this desk:

- **Track 1, the self-building codebase.** Retired 2026-10-27 (`docs/CONSTITUTION.md`): work is one supervised task, one branch, one pull request and Eric's merge. Its backlog is frozen in `docs/history/autonomous-build-backlog.md` (PR-B 5b, 2026-10-28).
- **Track 2, the autonomous Junior Trader desk.** Agent 1 researches, the desk measures exits, Agent 2 prosecutes and structures a trade plan (`entry_zone`, `upside_target`, `invalidation_trigger`), and the desk sizes it by Eric's rules. Eric sits in the PM seat for a few minutes a day: Approve Risk ($500), Halve ($250), Veto or Pass. Under an active paper mandate (`automation.autonomous_paper_loop`, which always expires), the desk may grant Prosecutor tickets on the Trader Sim book alone, within the mandate's caps. A mandate grant is recorded as the mandate's, never as Eric's, never opens a PM Cohort position, and Eric's Undo or Veto latches the ticket off.

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

## Sizing rules (`cr-ticket-sizing@4`, Eric's choices; earlier tickets keep theirs)

| Rule | Value |
|---|---|
| Standard risk (1.0R) | $500, only when the measured exit cost at the exit position is within the exit-cost limit (known in full, not a lower bound; `@3` reads the cheapest complete reading first) and Agent 1's grade is at least 55 |
| Starter tranche (0.5R, "Halve Size") | $250 |
| Grade under 40 | no new risk (HARD_PASS or WATCH_ONLY), $0 |
| Grade under 55, not held | no new entry, $0 |
| Held, any grade | TRIM_EXIT is always allowed (it takes no new risk) |
| Native L1, $10B+ market cap (`@2`) | passes the exit check without a DEX quote (`exit_basis: native_l1_liquid`); the grade floors still apply |
| Floor for a new entry | 55 by default; `arm-desk` sets it to 50 (settings `tickets.sizing.min_grade_new_entry`), so a grade from 50 sizes $500 when its exit is proven |
| Paper mandate, grade 50 to under 55 | Halve, 0.5R ($250), tier `exploratory_50_54` |
| Paper mandate, grade 55 and above | Approve, 1.0R ($500), tier `standard_55_plus` |
| Paper mandate, grade under 50 | never granted, whatever the floor in settings |

- **The paper mandate** (`cr-paper-mandate@1`, `tickets.js` `mandateSweep`, run first in every `trader` job tick):
  - **When it grants.** Only while `automation.autonomous_paper_loop` is on, automation is not paused, `automation.mandate.expires_at` is in the future and at most 30 days ahead, and this is not a restored copy.
  - **What it grants.** Only on pilot projects, and only the latest Prosecutor's ticket.
  - **Every condition.**
    - The ticket has no decision of any kind on record. Any decision of Eric's latches it off for good.
    - The exit evidence is current, complete and within the limit.
    - The exit chain is in `automation.mandate.allowed_chains`.
    - The packet carried a contract attestation, and the contract verdict now neither blocks nor holds. A live observation is needed.
    - The identity is unchanged since the save, and no sell-tax spike has appeared.
    - The pair prices this token: no ticker twin, and no candle binding to another token.
    - A native L1 coin is never granted; it stays Eric's.
  - **Caps.** `max_grants_per_day` (1, New York day) and `max_open_grants` (2), each 1 to 5. The highest grade goes first. A grant holds its open slot while its trade is waiting, ready, an order, a position or closing, while it has not opened for a reason that may still pass, and while the trader does not list it at all; only a finished grant, or one that can never open, frees it (corrective PR 2026-10-31).
  - **Re-open.** It also re-opens a ticket that froze no exit once a fresh, complete exit reading within the limit arrives, at most once per Claude report, never on a project Eric suspended.
  - **The record.** A grant is a `decide()` line with `decided_by: mandate:cr-paper-mandate@1` and its `mandate` block (tier, grade used, expiry, settings hash, and its `authority`), with `effects.paper: null`. Only the Trader Sim book acts on it.
  - **At opening.** The trader reads the contract again: a block, a gone observation or a changed identity opens nothing, and a hold waits.
  - **Authority** (`cr-mandate-authority@1`, `core/mandate-authority.js`, corrective PR 2026-10-31):
    - Arming is a settings write that turns the loop on or changes the mandate block. Inside that write the desk records `automation.mandate.authority` with a new `generation`; a client can never send it.
    - Turning the loop off or pausing revokes the generation in force. Resuming does not arm again, and a new arming never revives an earlier generation's grants.
    - Each grant records its generation and `policy_sha256` (the SHA-256 of the mandate block). At every opening, and before every hour the book applies, the grant's authority is read again: the same generation, unrevoked, unexpired, the same policy, Eric not intervening since, and a consistent ticket.
    - A buy the mandate no longer covers is cancelled through the book's own cancel before the next hour is applied, so that hour cannot fill it. Expiry covers an hour that ends at or before `expires_at`; any other revocation covers no hour still to apply. What already filled stays and is managed as before: stops, targets and closes go on while paused.
    - A grant recorded before this binding keeps its record and opens nothing new.
  - **Eric's latch** (`cr.autonomy.v1`, `projects/<id>/tickets/autonomy.jsonl`): any veto or undo of his, an archive, or an explicit stop suspends automatic grants and openings on the whole project, across new reports, replacement tickets, re-armings and restarts. Only his explicit rearm clears it: `node dashboard/cli.js tickets autonomy <project> --stop|--rearm [--note TEXT]`, or `POST /api/projects/:id/autonomy` signed in.
  - **A fatal finding holds.** A ticket whose verdict is `fatal_flaw`, with any finding of severity `fatal`, or whose prosecution fields are missing or malformed is never granted or opened automatically. Eric may still review it. A serious or minor entry in `fatal_flaws` holds nothing.
  - **Scheduled path.** The `trader` job is due on the mandate's own work (a ticket to grant) and on a step the book can take, not only on hours a pair needs. GeckoTerminal's backoff holds the candle read, never the sweep or the book's step.
  - **On the card.** The PM card says "Granted by paper mandate (0.5R, $250)" or "(1.0R, $500)", the tier and the expiry. After an Undo it says the mandate will not grant the ticket again.
- The grade is the desk's calculated grade of Claude's current report. A range is read by its low end; a withheld grade means no grade.
- A proposal the rules don't allow is capped to WATCH_ONLY at $0. The model's own type is kept beside the capped one, with the reason.
- Eric edits them in Preferences > Screening ("Your ticket sizing"), saved as settings `tickets.sizing`. Since `@4` the exit position, exit sizes and exit-cost limit are Screening's own (`forensics.preferences`: $500, $100/$500/$2,000 and 5% by default), the same values the Forensics tab reads; `tickets.sizing` no longer holds them. Each ticket freezes the values it was made under.

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

## Connector tools (`dashboard/mcp.js`, Claude)

| Tool | What it does |
|---|---|
| `autonomous_pilot_queue` | Read-only. Gives each pilot project's next step: `research` (Agent 1), `ticket` (Agent 2), `ticket_failed` (the Prosecutor's last save was refused; the step names the field, and `start_ticket` resumes the ticket with the refused text as its draft), `gate_closed`, `pm_review` or `done`, with the call to make |
| `start_ticket` | Opens or resumes the ticket on Claude's current report and returns the frozen prompt byte for byte |
| `pending_tickets` | Read-only. Lists open tickets; with `include_prompt`, also returns the next one's prompt |
| `save_ticket` | Saves the finished text with its JSON block. Fields that don't match the ticket are refused one by one. The same text again returns the same receipt; a different text needs `revision.note` |

ChatGPT challenges; Claude prosecutes (intake dialectic PR 6, 2026-10-29; `dashboard/core/ticket-challenges.js`). ChatGPT may check a saved Prosecutor ticket, advisory and optional, through three tools of its own; Gemini has no ticket role, held or not.

| Tool (ChatGPT only) | What it does |
|---|---|
| `pending_challenges` | Read-only. Saved Prosecutor tickets with no saved challenge. A project where ChatGPT's own research is open is listed as blocked, with no prompt, target or draft |
| `start_challenge` | Opens or resumes the challenge of the latest Prosecutor ticket (or the receipt named) and returns the frozen prompt (`cr-ticket-challenge-prompt@1`). Refused while ChatGPT's own research on the project is open |
| `save_challenge` | Saves `cr.ticket-challenge.v1`: each test agree, disagree or cannot_assess, a trade-plan critique, a verdict that fits the tests. A block that does not fit is refused field by field and kept as the draft; the same text is `unchanged`; a different one needs `revision { kind, note }` and keeps the first |

The challenge freezes the ticket receipt's bytes, its text, the packet and the report (`challenges/<tc>/target.json`) and checks them on every handoff, save and read. Its receipts live in `tickets/challenge-receipts/`, apart from `receipts/`, so the trader never reads one. The PM card shows one "ChatGPT challenge" row in words; it changes no ticket, gate, size, decision or book, and `get_ticket` is unchanged.

## HTTP routes (`dashboard/server.js`)

- Reads (write nothing): `GET /api/projects/<id>/tickets`, `.../tickets/<tk>/prompt`, `.../tickets/receipts/<tr>/text` (pins checked), `.../tickets/challenges[?receipt=<tr>]` (ChatGPT's challenge: the card's row and every saved challenge, each checked against the ticket receipt on disk).
- Writes: `POST .../tickets` (open), `.../tickets/<tk>/import` (save), `.../tickets/decisions` `{ receipt_id, action, request_id }` (a newer ticket is 409 `NEWER_REPORT`), `.../tickets/pilot` `{ on }`.

## Sub-agents and commands (Claude Code, Eric's subscription)

| File | Role |
|---|---|
| `.claude/agents/forensic-researcher.md` | Agent 1. Runs one research step (`cr-research-prompt@6`, five working phases: load, identity and on-chain, AMM exit from the desk's readings, fundamentals, save). Never touches tickets |
| `.claude/agents/junior-trader-prosecutor.md` | Agent 2. In its own context, `start_ticket` → frozen `cr-ticket-prompt@1` → `save_ticket` (or the CLI). Never sizes, decides or orders |
| `.claude/commands/pilot-run.md` | `/pilot-run [project] [online\|local]`. Reads the pilot queue and hands each step to the right sub-agent until `pm_review`. Works under `/loop` or `/schedule` |

Isolation (`cr-pilot-isolation@1`, the cohesion audit's M5, 2026-10-29): both agent files run `dashboard/scripts/pilot-role-guard.js` on Bash, Write, Read, Grep and Glob. Each role's scratch is its own folder, `<temp>/cr-pilot/<role>/` (Write saves only there, an import takes its `--text-file` only from there, and `npm run pilot` writes each agent's text there); Read, Grep and Glob never reach the desk's record folders (`projects/`, `inbox/`, `portfolio/`, `paper/`, `backups/`, `logs/`, `archive/`, `engineering/`, `scout/`, `project-context/`, `.cr/`), any other temporary folder (the other role's scratch, other sessions') or `~/.claude` (transcripts), and a search may not start above one; links are resolved first. The Prosecutor reads the completed report only as frozen into its prompt. The online route has no server-side role split: there the agent files' tool lists, a client configuration, are the boundary (a server-enforced capability would be its own decision).

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
npm run pilot -- --check-isolation                the session launch check alone: no claim, nothing generated or billed
```

- `dashboard/scripts/pilot.js` runs each agent as its own `claude -p` session, with the prompt on stdin.
- A session has `WebSearch` and `WebFetch` and nothing else: no shell, files, edits, code, delegation, skills, MCP tools or connector (the desk's own included), in local and online mode alike (the launch below).
- Local mode saves through the CLI, so every save is verified. The chain stops at `pm_review`.

**The session launch** (`cr-pilot-launch@1`, worker boundary PR 2026-10-31; `makeLauncher` in `scripts/pilot.js`). `--allowedTools` alone only pre-approved the web tools; it never limited what a session had (shell, files, edits, delegation, Chrome and the claude.ai connectors, with Eric's `CLAUDE.md`). Each session is now started with Claude Code's documented controls:

- **Tools:** `--tools WebSearch,WebFetch` (the built-in set), `--disallowedTools mcp__*,Bash,PowerShell,Read,Write,Edit,NotebookEdit,Glob,Grep,Agent,Task,Skill,ToolSearch,Workflow,ListAgents,SendMessage`, `--allowedTools WebSearch,WebFetch`, `--permission-mode dontAsk`.
- **MCP:** `--strict-mcp-config --mcp-config {"mcpServers":{}}`, and `ENABLE_CLAUDEAI_MCP_SERVERS=false` with `disableClaudeAiConnectors` for the claude.ai connectors.
- **Customizations:** `--restricted` (no user, project or local settings file: their permissions, hooks, MCP and model), `--safe-mode` (no `CLAUDE.md`, skills, plugins, hooks, MCP, custom agents or commands), `--settings {"disableAllHooks":true,"disableClaudeAiConnectors":true}`, `--disable-slash-commands`, `--no-chrome`, `--no-session-persistence`.
- **Sign-in and model:** Eric's Claude subscription, unchanged (never `--bare`, never an API key). The model and effort his Claude Code settings choose (`model`, `effortLevel` in `%USERPROFILE%\.claude\settings.json`) are passed as `--model` and `--effort`; `--model=` on the runner and `ANTHROPIC_MODEL` still come first.
- **Environment:** the system, proxy and certificate variables and Claude Code's own sign-in and model variables only (`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL`). No `CR_*`, no keys, no `ANTHROPIC_API_KEY` (`-p` would bill it instead of the subscription), no parent-session variables. Each session runs in a new empty folder under `<temp>/cr-pilot/session/`.
- **Checked before any claim, fail closed:** otherwise the runner exits 1 with the reason and claims nothing; a session is never started on a command line that was not checked in that run. After a Claude Code update, `npm run pilot -- --check-isolation` shows the result.
  - The installed CLI must list every flag above (`--help`).
  - **No managed Claude Code policy, confirmed absent** (a policy can add hooks, allow rules or MCP servers no flag removes; readiness PR 2026-10-31):
    - Files: `managed-settings.json`, `managed-mcp.json` and a `managed-settings.d` folder under `C:\Program Files\ClaudeCode` and `C:\ProgramData\ClaudeCode` (`/etc/claude-code`, `/Library/Application Support/ClaudeCode` elsewhere). Only "does not exist" is an absence; a file present or one that cannot be read (`EACCES`, …) refuses.
    - Registry: `HKLM` and `HKCU\SOFTWARE\Policies\ClaudeCode`, in the 64- and 32-bit views, read through the .NET registry API by a PowerShell child (`cr-policy-registry@1`), never `reg.exe`: `reg.exe` exits 1 both for a missing key and for one the user may not read ("ERROR: Access is denied.", shown on this machine), and its words are localized. Each key answers absent, present, denied or error; only four "absent" answers in exactly that shape pass. A key present (whatever it holds), access denied, a timeout, PowerShell missing, another exit code, other output, or a key not answered exactly once refuses.
  - **The probe** runs the same command against a local stand-in for the model endpoint (127.0.0.1, a placeholder key, every request answered 400, nothing generated or billed). Every request may offer the model only search and fetch, in Claude Code's client form (`WebSearch`, `WebFetch`) or the API's server form (`web_search_<date>`, `web_fetch_<date>`), and Claude Code's inert `DeferredToolPlaceholder` (no input), with no MCP tool or server named anywhere. **The session's request must offer both search and fetch** (readiness PR): an empty, missing, placeholder-only or partial tool list refuses, since it is not the session this runner checks.
  - Opt-in checks on this machine, both non-billable: `CR_TEST_REAL_CLAUDE=1 node --test dashboard/tests/pilot-launch-real.test.js` (the installed CLI under a hostile configuration, against the local stand-in endpoint) and, with `CR_TEST_REAL_REGISTRY=1` as well, the registry read against a FICTIONAL `HKCU\Software\CR-FICTIONAL-policy-probe` key that denies reading (created and removed by the test).
- **What it is not:** this bounds what the model can call. It is not an operating-system sandbox: the `claude` process runs as Eric, and his files are reachable to that process, not to the model. The claude.ai connectors are excluded by four documented controls; the probe, signed in with a placeholder key, cannot fetch them, so their exclusion under the subscription sign-in is documented, not observed.

## How the OLAS pilot chain runs

OLAS is `olas-autonolas` and lives only on the online desk.

1. The queue says `research` when Claude's report is missing, older than 90 days or has a Claude run open; Agent 1 researches and saves.
2. It then says `ticket`. `start_ticket` freezes the packet (Agent 1's report ID and hash, grade, exits at $500 and $2,000, price, sell tax, DefiLlama, held, sizing) and the prompt with the report fenced as evidence. Agent 2 prosecutes and saves.
3. The desk sizes it, the queue says `pm_review` and the inspector shows the PM Decision Card. A new Claude report sends the queue back to `ticket`; the old ticket is kept and marked superseded.
4. The $500 tier needs a current exit reading: approve exit quotes (Forensics > Exits). Without one the ticket is capped at $0, saying why.

Live tickets (2026-10-24), both $0 and waiting for Eric: OLAS `tr_2026-10-24T175256Z_g3cug`, HARD_PASS (Researcher 26.3, Prosecutor 15). ZAMA (held) `tr_2026-10-24T182937Z_vzsbf`, TRIM_EXIT (Researcher 35.5, Prosecutor 18; invalidation $0.045). Neither has an exit reading or a DefiLlama binding.

## Arming the paper desk (2026-10-30)

The mandatory order for a ticket that should size above $0:

1. **Quote exits.** Use Forensics > Exits, or Desk options "Quote exits for every project…". With `automation.exit_quotes_auto` on, the desk approves them itself for pilot projects. `start_ticket` freezes the packet with the exit readings it finds then, so a ticket opened before them is capped at $0.
2. **Run the Prosecutor** (`/pilot-run`, `npm run pilot`).
3. **Approve within 72 hours** of the newest complete exit reading. After that, Approve and Halve are refused with 409 `EXIT_EXPIRED`. "Renew exit evidence" (Re-open) makes a new ticket on fresh readings.

Three facts the 2026-10-30 audit found misread:

- **The network-fee ceiling key.** The desk's own on-chain exit readings use `contracts.network_fee_ceiling_usd`, a map of chain ID to USD (0 to 100).
  - There is no `evm_network_fee_ceiling_usd`.
  - Solana aggregator quotes use `forensics.preferences.solana_network_fee_ceiling_usd`.
  - KyberSwap's EVM quotes carry their own gas.
- **On-chain exit rows never size the Paper Book.** The desk's on-chain rows (`desk_onchain`, `cr-forensic-exit-legacy@1`) live in the packet's `contract.exits.legacy`, never in `packet.exits`.
  - `paper-trader.js` sizes its exit cap from `packet.exits` only.
  - An on-chain reading reaches an order only through the contract gate's open guard, in enforce mode (`tickets.js` `contractOpenGuard`).
- **Confirming a scout lead requests Claude only** (`leads.js` `envelope`). The click never adds another model or a configured API.

The commands:

```
node dashboard/cli.js arm-desk --dry-run [--daily-cu=5000 --monthly-cu=100000] [--allow=SYM/USDC,...]
         [--intent-life=1440] [--contracts-on] [--mandate-days=N | --mandate-off]
         [--admission-days=N [--admission-daily=N] | --admission-off]
node dashboard/cli.js arm-desk [...]                this folder's desk: the settings and the contract defaults
node dashboard/cli.js arm-desk --desk=online [...]  prints a script for the signed-in online desk's browser console
node dashboard/cli.js arm-desk --print-schedule     prints the pilot-task.ps1 commands for the pilot's task (never runs them)
node dashboard/cli.js scout leads auto              automatic admission: authority, today's capacity, what holds it, its admissions
npm run pilot -- --pilot-all --desk=online [--max-agents=2] [--dry-run]
node dashboard/cli.js contracts init-defaults [--dry-run]
node dashboard/cli.js contracts probe [<chain_id>]  none named: every chain the active projects need that is not probed
```

**`arm-desk`** (`core/arm-desk.js`) writes one patch, checked by `validateSettingsPatch`:

| Setting | Value |
|---|---|
| Scout leads | On, for ethereum, base, arbitrum, optimism, polygon, avalanche, linea, unichain, sonic and solana |
| Lead thresholds | Market cap at least $5M, 24h volume at least $250K, sell tax at most 5%, eligibility 48 h |
| `automation.exit_quotes_auto` | true |
| `trader.book` | $25,000 at a fee of 0.001 |
| `trader.rules` | Stop at least 0.03 of entry and 0.5 ATR, notional at most 0.20 of NAV, intents valid 1,440 minutes (`--intent-life`, 1 to 10,080), so a LIMIT_TRAP below the market does not spend its one attempt in 4 hours |
| `tickets.sizing.min_grade_new_entry` | 50 |
| Contract caps | Written only when named |
| `contracts.enabled` | true with `--contracts-on`, which is refused without both caps |
| The paper mandate | On until N days ahead with `--mandate-days=N` (1 to 30), the other limits at their defaults; off with `--mandate-off`; untouched otherwise |
| Automatic admission of scout leads | On until N days ahead with `--admission-days=N` (1 to 30), `--admission-daily=N` a New York day (0 to 3, default 1); off with `--admission-off`; untouched otherwise. The mandate's flags never touch it |

- The contract gate's mode is left as it is.
- The saved allowlist holds only the pairs Eric names. The trader also trades the pairs of grants in force and of positions it holds (Invariant 3).
- Online, the script reads the session token, then posts in this order:
  1. `/api/settings`
  2. `/api/forensics/exit-quotes/auto`, for the pilot projects' exit-quote targets
  3. `/api/contracts/init-defaults`

  What is still Eric's comes first, as comment lines.
- **Left for Eric.**
  - `ALCHEMY_API_KEY` on Render, with each chain probed, before contract observations count.
  - The mandate's expiry.
  - `CR_PILOT_POLL_TOKEN_SHA256` on Render for the pilot's pre-poll.
  - `CR_PILOT_WORKER_TOKEN_SHA256` on Render for the online worker routes, the SHA-256 of `pilot_worker_token` in `%USERPROFILE%\.cryptoresearch\secrets.json`. A separate token from the poll's. Without it the worker routes answer 404 and the online runner dispatches nothing.

**Pilot enrollment approves the exit target** (`forensics.js` `approvePrimaryExitQuote`):

- **What is approved.** Turning the pilot on for a project also approves exit quotes on its primary chain, within the standing policy's quote budget.
- **What is said.** The answer's `exit_quote` is one of `approved`, `kept`, `none` (with why), `paused` or `over_budget`.
- **Failure.** A failure there never undoes the enrollment.

**The multi-project runner** (`npm run pilot -- --pilot-all`, `scripts/pilot.js`):

- **One run at a time.** It holds `<temp>/cr-pilot/pilot-all.lock`. A lock older than 3 hours is taken over.
- **Zero-token pre-poll.** It polls first, before any agent:
  - Locally, `tickets queue`, which now also gives `paused` and each project's claim state.
  - Online, `GET /api/pilot/queue` with `Authorization: Bearer <pilot_poll_token>`. The token is read from `%USERPROFILE%\.cryptoresearch\secrets.json` and never printed.
- **Dispatch.**
  - Paused: nothing is dispatched.
  - Order: `ticket`, `ticket_failed`, `gate_closed`, then `research`, each through the per-project path and its claim.
  - At most `--max-agents` `claude -p` sessions per run, and never past the desk's daily session ceiling.
  - Online (corrective PR 2026-10-31), through the worker routes below: the desk claims the step, prepares it (opens the run or ticket and freezes its prompt), and the runner gives that exact prompt to one `claude -p` session with `WebSearch` and `WebFetch` only. The session holds no desk credential. The runner posts the answer back with the prompt's SHA-256, and the desk saves and verifies it.
  - Before the first claim, the session launch is checked (above); when it fails the run claims nothing and exits 1.
  - A prepare answered `already_prepared` (another request prepared that attempt) starts no session and is listed for Eric like a lost answer.
  - A timeout, a lost answer or an unreadable one leaves the outcome unknown: the claim stays dispatched and nothing is run again.
  - A project held by another runner, or whose one correction is used, is skipped.
  - `exit_evidence` (the desk's own exit reading at the exit size is not complete yet) and `contract_evidence` steps start no session.
- **Daily session ceiling** (`cr-pilot-session@1`, `.cr/pilot-sessions.jsonl`, `automation.pilot_daily_sessions`, default 6, 0 to 50): each session is reserved on the desk before it starts, failed ones included, per New York day. Repeated runs never reset it; an unreadable ledger starts none.
- **Needs Eric.** An expired dispatch with no known outcome (`reconcile`) is listed for Eric and the run exits 3. It is never released by the runner. Online, Eric checks the project on the desk, then releases it signed in: `POST /api/projects/<id>/pilot-claim/release` with `{"reconciled":true,"attempt_id":"pa_…"}`, naming the attempt he checked. The release compares it with the current claim inside its own lock: another attempt is 409 `CHANGED`, naming both, with nothing written, so a stale click about an attempt already settled never releases a newer one; without an attempt it is 400. Desk controls posts the attempt it shows and reads back that same attempt as released (audit F4, 2026-11-02).
- **The log.** One JSON line per run in `%USERPROFILE%\.cryptoresearch\pilot-all.jsonl`.
- **Exit codes.** 0 done or nothing to do; 3 needs Eric; 1 an error.
- **Health** (`cr-pilot-health@1`, blueprint §6.1; `health` and `health_label` on each row and on the run, `Health: <label> (exit n)`). The class says what an exit 0 was, and the optional heartbeat (`CR_HEALTHCHECK_URL`) pings by it: ok and idle `/0`, attention `/fail`, failure `/1`, reconcile `/3`. The class never changes the exit code.
  - **ok:** an agent's answer was saved. That includes a save after which the one-agent cap ended the loop, the usual end at `--max-agents=1`.
  - **idle:** no work; the ticket waits at PM review; a closed desk gate with no session; the session ceiling or cap before any session; a dry run.
    - Paused is labeled `idle-paused`, and a project Eric stopped `idle-stopped`.
  - **attention:** another runner holds the claim, the one correction is used, the step changed under the claim, or a re-poll did not answer.
    - A failed re-poll makes any row at least attention, so an idle stop or a save never hides it.
    - The local lock held by another run, normal overlap included, is attention, labeled `attention-overlap`. It sends its own `/start` and `/fail`. Whether a normal overlap should alarm is Eric's open decision.
  - **reconcile:** an outcome is unknown.
  - **failure:** a session, prompt, prepare or save failed, an unknown answer came back, or the run erred.
  - Audit F10, 2026-11-02; `tests/pilot-health-flow.test.js`.

**The poll route** (`core/pilot-poll.js`, answered in `frontdoor.js` before the sign-in and the session token):

- **Off by default.** It answers 404 unless `CR_PILOT_POLL_TOKEN_SHA256` (hex) is set in the desk's environment.
- **The bearer.** Its SHA-256 is compared with `timingSafeEqual`.
- **Rate.** 60 requests an hour for the runner. Refused bearers fill their own allowance of 60 an hour, never the runner's (corrective PR 2026-10-31).
- **Read only.** It returns `{ format: 'cr-pilot-poll@1', paused, sessions, steps: [{ project_id, step, ticket_id, run_id, receipt_id, claim }], status }`: no prompt, report text, settings or reasons. `status` gives each project's next action, who takes it, whether it is blocked, the mandate's authority (generation, the project's latch, the latest grant's authority code, phase and order state), the claim and the IDs (report, run, ticket, receipt, decision, intent, order, attempt), as codes and IDs. `tickets queue` gives the same rows with the words (`blocker`, authority words).

**The worker routes** (`core/pilot-worker.js`, `cr-pilot-worker@1`, answered in `frontdoor.js` before the sign-in):

- **Off by default.** 404 unless `CR_PILOT_WORKER_TOKEN_SHA256` is set. The poll token is refused here, and the worker token is refused everywhere else.
- **What it may do.** `POST /api/pilot/worker/claim`, `prepare`, `complete` and `release` (`stopped` or `agent_failed` only). Nothing else: no PM decision, no mandate arming, no settings, no reconciling, no trade.
- **One dispatch.** The claim is the desk's own (`cr-pilot-claim@1`, under the workspace lock): of two runners, only one gets a token. Only the claim's holder can prepare or complete, and a completion for another prompt's SHA-256 saves nothing.
- **One launch per attempt** (worker boundary PR 2026-10-31). A claim goes `claimed` → `preparing` → `dispatched` once:
  - `prepare` first moves the claim to `preparing` in one locked step (`pilot-claims.js` `beginPreparation`). A second prepare on the same claim, overlapping or later, is answered `already_prepared` with no prompt and writes nothing.
  - After the exit quote's network wait, the claim is read again; the bind then checks the token, the state, the expiry, the pause and the day's ceiling at the time of the bind (the route's clock), reserves the one session and only then is the prompt handed out. `bind` refuses a claim already dispatched (`ALREADY_BOUND`).
  - A `preparing` claim never handed out a prompt. While live it holds the project; once expired (a desk restart, a runner that went away) it is not a dispatch to reconcile, and the next claim takes the step as a new attempt. The old preparation can never bind.
  - A lost `prepared` answer is unchanged: the claim stays `dispatched`, another prepare gets `already_prepared`, and after expiry it waits for Eric's reconcile.
- **The production poll's sighting** (`POST /api/pilot/worker/poll`, `core/pilot-sighting.js`, `cr-pilot-sighting@1`). After the desk has computed the same snapshot the GET answers, it records `last_polled_at` on its own clock with the runner's ID, the invocation and `max_agents`; a time in the request is never read, a snapshot that failed writes nothing, and the GET never writes it. Desk controls reads it as fresh, STALE (after 120 min, or `max_agents` × 95 + 15 above one agent), never, or unknown. A record ahead of the desk's clock by any amount, a second or a year, is unknown, never fresh, and a poll at a clock behind it keeps it as it is, so `last_polled_at` never moves backward; once the clock has passed it the next poll writes again (audit F9, 2026-11-02; `tests/ahead-of-clock-sighting.test.js`).
- **Rate.** 240 requests an hour; refused bearers 60 an hour of their own.

**`contracts init-defaults`** (`core/contract-presets.js`; `POST /api/contracts/init-defaults` on the desk, `{ "dry_run": true }` for the plan) adds:

- **Uniswap V3:** fee tiers 100, 500, 3000 and 10000, with its QuoterV2.
- **Uniswap V2:** 30 bps.
- **Where:** both Uniswap rows on Ethereum, Base, Arbitrum One and OP Mainnet, quoted in native USDC.
- **Safe:** the Safe and SafeL2 singleton code hashes of v1.3.0 and v1.4.1.
- **Network-fee ceilings:** Ethereum $5; Base, Arbitrum and Optimism $0.25.

Every value was read back from the chain on 2026-10-30. Rows and ceilings already set are kept.

**The network probe:**

- **When it runs:** with both caps set, the first observation on a chain never probed probes that chain first. With `contracts.enabled` on, the `forensics` job does it for every chain the active projects need.
- **What is recorded:** the answer goes to `market-data/contracts/networks.json`, supported or not. A recorded chain is never probed again on its own.
- **No answer to record** (no reply, the wrong chain, a reorg): the next try waits 30 minutes, doubling to 12 hours (`probe_waits` in `market-data/contracts/status.json`).
- **On the online desk,** `POST /api/contracts/probe` (`{ "chain_id": "8453" }`, or nothing for every chain) probes from the signed-in page. It is refused while the caps are unset.
- **Key check first:** a key refused (HTTP 401 or 403) closes the gate for every chain for 6 hours. Check `ALCHEMY_API_KEY` on Render before setting the caps.

**Pause:** `automation.paused` now stops the online pilot too. The connector's `autonomous_pilot_queue` answers `paused` for every step, and `npm run pilot -- --desk=online` dispatches no further agent.

**One stop per project stops everything on it** (`cr-automation-gate@1`, 2026-11-02; `mandate-authority.js` `automationGate`, `tests/stop-halts-pilot.test.js`):

- **What stops a project.** A veto or Undo of Eric's, an archive (current or in its history), or his explicit stop (`POST /api/projects/<id>/autonomy {"action":"stop"}`, `tickets autonomy <project> --stop`). History that does not read stops it too.
- **What it halts.** Every automated effect on that project: the pilot's next step (`blocked`, with the words), its claim, prepare and bind; paper-mandate grants, re-opens and openings; automatic admission's remaining effects. One function answers for all of them; no path keeps its own check.
- **In flight.** A claim still `claimed` or `preparing` is let go as `autonomy_stopped` and no session starts. A session already `dispatched` runs to its end, but its answer is not saved: the claim is let go as `autonomy_stopped`, never `saved`, and the session still counts against the day. The worker asks the gate again inside the save's own locked operation, before anything is written (audit F2; `pilot-claims.js` `stopGuard`, `tests/stop-save-atomic.test.js`). A stop that lands at any point before the commit leaves no report or receipt, no completed job and no grant. A copy the import already put in the inbox is set aside: kept, never imported. The local runner (`scripts/pilot.js`) saves through the CLI under its claim (`tickets import` and `import-text` with `--token`; `cli.js` `claimedSave`), so the same check runs inside its save: a stop after its `tickets check` saves nothing and its claim reads `autonomy_stopped`, never `done` (N2, `tests/local-import-stop-atomic.test.js`). The desk-wide pause does not refuse the save. A dispatch whose outcome is unknown stays `reconcile` for Eric.
- **The pause is unchanged.** It stops new claims, prepares and binds; work already dispatched may still settle.
- **A missing basis never holds a stop back** (audit F1, 2026-11-02; `tickets.decide`, `decision-basis.js` `unavailableBasis`, `tests/decision-basis-stop.test.js`). If the decision basis cannot be built (a report that does not load, a rubric that does not read, anything else it calls), Eric's veto or Undo is still recorded and stops the project, and so is his pass on a project he does not hold, which archives it (a pass on a held project stays watched, stops nothing and still needs its basis). In the basis's place goes `cr.decision-basis-unavailable.v1`: the decision, the failure and nothing else, written in the same operation and create-only. `tickets basis` reads it as `unavailable`, never `decision_time` or `reconstructed`, and it is never rebuilt. The decision's answer and any replay say `basis.state` (`frozen`, `unavailable`, `integrity` or `none`): how the basis was recorded, never whether the decision is still in force (the replay's `live` says that). Every reader, the view, the replay and the decision's answer, holds the record to one identity check (`identityProblems`: schema, decision, project, receipt, time, action, and for the unavailable record its state and failure): one that does not match is `INTEGRITY`, never `unavailable` or a basis. Approve, halve, a held pass, watch, trim, re-open and every mandate line still commit only with their basis.
- **A basis is verified when it is read, not only created once** (audit F3, 2026-11-02; `decision-basis.js` `stageRecord`, `verifiedRecord`, `tests/basis-digest.test.js`). Every record written at a basis path, a basis or an unavailable record, declares `digest_ledger` and has its exact bytes' SHA-256 appended in the same operation to `projects/<id>/tickets/basis-digests.jsonl` (`cr.decision-basis-digest.v1`, one line per record, each naming the SHA-256 of the line before). `tickets basis`, the attribution view and the replay verify it: a one-byte or valid-JSON change, a swapped or missing record, a removed declaration or ledger line, a ledger line that does not read or a removed ledger is `INTEGRITY`, named and never rebuilt. A basis written before the ledger (no declaration, decided before the project's first digest) reads `unverified`, never `decision_time`, and no digest is invented for it; the replay's `basis.state` says `unverified` too. Appending never parses the ledger, so a damaged ledger never holds back a stop. Nor does a ledger whose bytes cannot be read at all (N1, post-remediation audit 2026-11-02; `tests/basis-digest-stop-io.test.js`): Eric's veto, Undo or archiving pass still commits, stops the project and, for an Undo, cancels the resting buy; its record carries `digest_unrecorded` (the failure's code and words) in place of `digest_ledger`, the ledger is left exactly as it was (it cannot be appended to without its prior bytes), and every reader says `unverified` with the failure, never `decision_time`; no digest is added later. Only a stop may carry `digest_unrecorded` (`identityProblems`); a grant, a mandate line, a watch, a trim and a re-open are refused as before. The v1 decision line keeps its bytes. A coordinated change to two files, a record and its ledger together, is not detected, as with any record kept on the same disk.
- **A digest that is not there is never a check passed** (audit F7, 2026-11-02; `decision-basis.js` `viewOf`, `digestOnRecord`, `tests/original-hash.test.js`). Reading a decision basis checks every record it names against the SHA-256 the basis recorded: the receipt, the frozen packet (whose digest must also be the one its receipt records), the Prosecutor's saved text and each report original. A digest the basis must hold that is missing, null or not a lowercase SHA-256 is `INTEGRITY`, named, with nothing rebuilt. The one exception is a report that genuinely carried no digest when the decision was made (its metadata had none, so the basis recorded `null`): the decision input is then checked against the digest the ticket's frozen packet holds for it, and a context report with no digest anywhere reads `unverified`, by report and model, never `decision_time`; no digest is invented or taken from the report as it stands now. The view lists each original with `digest` `verified` (`against` the basis or the packet) or `not_recorded`, and the attribution view counts `basis.unverified` apart from `decision_time`.
- **Input blindness is proved on the real paths** (audit F8, 2026-11-02; `tests/input-blindness-real.test.js`, `tests/lead-admission.test.js`). With outcomes and opinions planted (Eric's decision note, both paper books filled, a forensic outcome note, ChatGPT's report in its own words and grade), and no function under proof replaced, the tests show:
  - **The rubric** (`rubrics.gradeAssessment`) gives the same grade and reads only its own rubric files.
  - **The paper mandate's real sweep** grants the same tier and size with or without that history, and moves with Claude's own grade.
  - **What reaches a model carries no canary:** the Claude API request body the research runner sends, the connector's `pending_research`, `get_research` and `pending_tickets`, and the Prosecutor's prompt as the pilot worker takes it.
  - **Automatic admission** reads no other project's decisions, reports, research or outcome notes, and no paper book but the candle-source bindings. It does read that project's identity, its monitoring opt-in and Eric's holdings ledger. Its run's prompt and packet carry no canary and none of the scout's words.

  Each proof has a control that shows it can fail (a read spy that catches an outcome read, a desk whose own grade moves the answer, a canary check that catches a canary). `tickets.mandateContractEvidence`, the live contract read, is the one seam stood in.

  Not proved by these tests:
  - the ChatGPT and Gemini API requests;
  - the ChatGPT ticket challenge, which freezes the ticket by design;
  - the forensic prompts;
  - the scout's and the leads' Grok prompts;
  - copying a prompt from the dashboard or CLI, and the Cowork request queue;
  - anything a model meets on the open web.
- **Un-stopping** is only Eric's rearm (`{"action":"rearm"}`, `--rearm`), one logged line with who, when and what it clears. Resuming, re-enrolling in the pilot or re-arming the mandate never clears a stop.

## Automatic admission of scout leads (`cr-lead-admission@1`, 2026-10-31)

`core/lead-admission.js`, run by the existing `leads` job (no new scheduler or queue). Off by default. When armed, it admits at most `daily_limit` ELIGIBLE leads a New York day, one pipeline at a time. **ELIGIBLE means eligible for research, never approved to trade.** An admission does what Eric's "Confirm and request research" does (the intake record, the project, a Claude run), then enrolls the project in the pilot and approves its exit-quote target. Every gate after that stands unchanged: the Prosecutor, the contract gate, the exit cost, the paper mandate (the only thing that grants paper execution), the trader's rules and the book.

**Settings** (`automation.lead_admission`, checked by `validateSettingsPatch`):

| Key | Values |
|---|---|
| `enabled` | `false` by default |
| `daily_limit` | Whole number 0 to 3, default 1. 0 is off |
| `expires_at` | Required to turn it on; at most 30 days ahead |
| `authority` | Recorded by the desk on each arming write; a patch that sends it is refused |

- **Its own block, outside `automation.mandate`.** Writing it never changes the mandate's hash, generation or grants, and arming the mandate never turns it on. Pausing automation revokes both, as pausing always did.
- **Arming** (`authorityNext` in `server.applySettings`): a write of this block that leaves it live records a new generation, unless the same settings are already live. A write that leaves it off, at 0 or paused revokes the generation in force. Resuming automation never re-arms it.
- **Arm it** with `arm-desk --admission-days=N [--admission-daily=N]`, or the patch `{"automation":{"lead_admission":{"enabled":true,"daily_limit":1,"expires_at":"<ISO>"}}}`. **Turn it off** with `--admission-off` or `{"automation":{"lead_admission":{"enabled":false}}}`.

**What it admits.** Each check runs again inside the lock:

- The receipt is checked as Eric's confirm checks it (`leads.rowCheck`): intact, unexpired, decided under the policy in force, and still ELIGIBLE by its rules.
- No project holds the contract, active or archived (`knownProject`). Nothing matches it strongly (`findDuplicates`: name, CoinGecko ID, website, contract). No project trades its ticker.
- `SYM/USDC` has no permanent candle binding to another contract, and the bindings file reads.
- The chain is covered by every downstream evidence path: an exit-quote route, a contract read route that is not known unsupported (an unprobed chain is probed by the desk once the caps are set), and a candle source. In practice that is Ethereum, Base, Arbitrum, Optimism, Polygon and Solana.
- CoinGecko names a coin, a ticker the book can use, and an official website, so the identity verifies.
- Anything else is held, with the reason, and the lead stays ELIGIBLE for Eric's own confirm. Dismissed, archived and already-admitted leads are never candidates.

**Capacity and recovery.**

- **The slot is reserved first.** Under the workspace lock and at the lock's clock, before any effect, the admission is written create-only with its reservation (`reservation_id`, the New York day) and the lead becomes ADMITTED.
- **What counts toward the day.** Every automatic reservation naming the day counts, whatever became of it: pending, failed, stopped, lapsed or complete. A slot is never recycled.
- **No double reservation.** The admission ID derives from the eligibility receipt, so the same reading is never admitted twice. Concurrent sweeps in separate processes reserve one slot.
- **Eric's confirms use no automatic slot.**
- **Backlog.** A new automatic admission waits while an earlier one's pipeline is active:
  - Active: its effects unfinished, or its project at `research`, `ticket`, `ticket_failed`, `exit_evidence` or `contract_evidence`.
  - At rest: `gate_closed`, `pm_review`, `done` or `blocked`, archived, off the pilot, or suspended.
  - Unreadable counts as active.
- **The effects run after the lock,** in order, each under its own key: intake, project, research, pilot (`setPilot` by `auto-admission g<generation>`, then the exit target). A failed effect is tried again by the next `leads` turn until the 24-hour start deadline, then the admission lapses. What was done stays done.
- **Authority before each further effect** (`leads.delegatedGate`). The same generation and settings must be in force: not paused, not expired, not revoked, not re-armed with other settings. The project must not be archived, suspended by an intervention, or taken off the pilot. Otherwise the remaining effects become `stopped` and never start. **Re-arming never revives a stopped admission.**
- **An existing project is refused.** Before creating its project, an admission checks for one again. A project that turns out to exist already is never enrolled automatically. A ticker collision found at that point stops it.

**Budgets.** Admission holds, with the reason, unless every downstream meter can be read, has its cap set, and is under 85% of it:

- the pilot's daily session ceiling (at least 2: a Researcher and a Prosecutor);
- the exit-quote monitor's monthly requests, both sent and planned (`quoteBudgetOf`; an approved exit target is not a reservation);
- CoinGecko's monthly calls;
- GoPlus's monthly requests;
- the contract RPC's daily and monthly compute units (contract observations on, both caps set);
- GeckoTerminal's candle calls.

A meter that has never run reads as 0 used. One that cannot be read holds admission. The 15% headroom only adds to each meter's own reserve-before-send check at its dispatch boundary, which is still the enforcement. Research USD budgets do not apply: the route is the pilot worker on Eric's subscription.

**The route.** The run's Claude job is opened in assistant mode (`intake.admitListing` → `research.createRun` with `assistant: 'claude'`): state `running`, mode `cowork`, for the pilot worker's research step. A configured API never changes it, and the research job never sends it.

**Provenance.**

- **The admission record** has `kind: 'delegated'`, `actor: 'auto-admission'`, `request_id: null`, `admission_policy` (version, values, hash), the frozen `authority`, the `reservation`, the eligibility receipt, and the source delivery IDs.
- **The project's evidence** has `kind: 'delegated_admission'`. Its note says it was "admitted automatically … no person reviewed this lead".
- **The intake record** has `confirmed.by: 'auto-admission'` and `scout_admission.kind: 'delegated'`.
- **Never Eric's.** Nothing automatic says "confirmed by Eric" or writes `owner_confirmed`.
- **Eric's confirm and its records are unchanged.** A "Request research again" on an automatic admission is Eric's, and is recorded as a confirmed admission.
- **The scout's words stay on the lead.** They are never in a project, prompt, run or ticket.

**Where to look.**

- `node dashboard/cli.js scout leads auto` shows the authority, today's count, what holds admission, and the last ten automatic admissions with each pipeline's stage.
- The `leads` job summary says what it admitted or why it held.
- `reviewView` (Review > Imports > Scout leads) carries `auto_admission`.

**Residual limits.**

- **No Settings-page control yet.** Arm it from the CLI or the console patch.
- **Held leads are not marked.** They are reported, not written on the lead.

### Activation and rollback runbook (readiness PR, 2026-10-31)

Each step is checked before the next. No step prints a credential: tokens are read from `%USERPROFILE%\.cryptoresearch\secrets.json` and only their SHA-256 leaves the PC.

1. **Deploy.** Merge after CI passes on the final commit. Check Render's live deploy is the merge SHA and `/healthz` answers. The recurring scout and the pilot task stay off while this is checked.
2. **Tokens.** `pilot_poll_token` and `pilot_worker_token` are separate tokens. Their SHA-256 (hex) go on Render as `CR_PILOT_POLL_TOKEN_SHA256` and `CR_PILOT_WORKER_TOKEN_SHA256`. Check:
   - `GET /api/pilot/queue` with the poll bearer answers 200;
   - the worker digest matches: the worker bearer on `POST /api/pilot/worker/release` with a malformed `project_id` gets 400 `BAD_ID`. Nothing is read or claimed. A 401 means the digest differs, and a 404 means it is unset.

   The ingest key (`DESK_INGEST_KEY`) is checked without writing: `GET /api/ingest/scout-leads` with it answers 200 with today's count. It is never rotated blindly and never printed. The scout workflow (`scout-cron.yml`) runs on schedule only while the repository variable `SCOUT_ENABLED` is `true`, and asks for leads only while `SCOUT_LEADS` is `true`.
3. **Windows task**, from the clean runner worktree (`Documents\CryptoResearch-runner`, detached at `main`; blueprint 2026-11-03 §6 R0.3). Run `powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\Documents\CryptoResearch-runner\dashboard\scripts\pilot-task.ps1" -Register -MaxAgents 1 -Model <id>`, where `<id>` is a full pinned model ID, never an alias.
   - **What it registers.** The task is registered disabled, for the signed-in user whose `claude` login is the subscription. It runs the verified Node binary, `pilot.js --unattended --pilot-all --desk=online --max-agents=1 --model=<id>`, in that worktree. Every unattended run refuses unless the worktree is clean and its `HEAD` equals the desk's `/healthz` revision.
   - **Its settings.** Every 30 minutes, IgnoreNew, a 3-hour limit, no window. A missed start runs once when the PC is available. The PC is never woken.
   - **What it refuses.** It never replaces a task it did not register.
   - **Check it.** `-Status` shows the principal, the action, the settings, the next run and the runner's last log line.
   - **Stopping a run.** Stopping a run keeps an uncertain claim dispatched until Eric reconciles it. Nothing is run twice.
4. **Canary** (auto-admission OFF).
   - **The candidate (Q5, 2026-11-03).** Re-check Numeraire's contract hold first. If it is still held on CG-21/CG-23, the canary uses a clean-contract candidate already on the desk (for example Uniswap, or Raydium if it is on the desk), named by its stored chain, contract and CoinGecko ID, never by ticker. A vetoed or held asset is never used, and a fill is never forced: a held or no-trade result is reported as "fill pending".
   - **Arm the desk** with `arm-desk --desk=online` and only validated flags: the contract caps (5,000 CU a day, 100,000 a month), `--contracts-on`, `--mandate-days=7`, `--intent-life=4320`. A static `NMR/USDC` allowlist entry is not an identity and not an authorization.
   - **Run once.** Enable the task for one run of at most one agent session.
   - **Check the lineage:** run, report, ticket, receipt and grant.
   - **Fills.** A paper fill is reported only if the real gates and market give one.
   - **Exercise recovery.** Revoke or cancel, then restart. Re-arming never revives a cancelled grant.
5. **Scout.**
   - Check the scout's dry run.
   - Enable the scout workflow only after its paid-call budget and ingest path are verified.
   - Then arm automatic admission on its own: `arm-desk --desk=online --admission-days=N`, or the console patch above.
   - Report the first genuine ELIGIBLE lead, or the exact hold. Never a fabricated one.
6. **Rollback**, in order of reach:
   1. `--admission-off`: automatic admission only.
   2. `pilot-task.ps1 -Disable`: no agent sessions.
   3. `--mandate-off`: no new grants.
   4. Settings: Pause: every automated dispatch stops, and the mandate and admission authorities are revoked.
   5. Revert the merge commit: the code.

   **Records are kept.** Admissions, projects and their history stay. A stopped or lapsed admission is never resumed.

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

Eric, 2026-10-27. The contract for the autonomous trader still to be built, so the sandbox, the ledger (`dashboard/scripts/agent-ledger.js`) and the desk's deterministic gates carry unattended trading without rework. The pre-trade risk engine (`dashboard/core/trade-risk.js`, `cr-trade-risk@1`, PR #58; `cr-trade-risk@2` since D8, 2026-10-28) and the trader's Paper Book (`dashboard/core/paper-trader.js`, `cr-paper@2`, PR #59; `cr-paper@3` since PR #97, its settlement gate) are built as library code. Since slot 12a (2026-10-28) their one caller is the desk's adapter (`dashboard/core/trader-desk.js`, `cr-trader-desk@1`, below), which turns Eric's Approve, Halve and Undo into intents for the Paper Book; no route, CLI, connector tool, UI or agent calls them directly, and nothing routes anywhere but the simulated venue. The North Star invariants above stay in force: today nothing places an order, connects a wallet or exchange, or moves money.

1. **Separation of proposal and execution.** The LLM agent is an analyst only. It never holds execution API keys and never signs a transaction. It emits a typed `TradeIntent` (below). An out-of-band deterministic engine intercepts, validates and routes it; while invariant 5 holds, it routes only to the Paper Book.
2. **Stateless shift work.** The trader runs in discrete, stateless evaluation cycles during the target market's liquidity windows. Each tick re-derives its state from disk only (`DESK_STATE.md`, open position records, fill journals) and exits. No long-lived chat memory.
3. **Immutable risk boundary.** The risk limits are hard-coded in the engine, outside the model's context window: at most 2% of the Paper Book's NAV (`cr-paper@2`, below) at risk per trade; a stop-loss on every trade, no nearer the entry than the minimum stop distance; an asset allowlist (the pairs Eric names, plus the pairs of grants in force and of open exposure, derived on every step and never written to settings by the desk: `trader-desk.js` `allowlistOf`); and a hard ceiling on drawdown of 4% of NAV in any rolling 24 hours (Eric, 2026-10-27). The agent cannot alter, soften or bypass them. The engine (`dashboard/core/trade-risk.js`), both Paper Books (`dashboard/core/paper.js`, `paper-trader.js`) and the exact arithmetic they compute with (`dashboard/core/decimal.js`) are protected files.
4. **Reconciliation and nonce guard.** The Paper Book's journal is a hash-chained, append-only record written under the workspace lock, and every action is reserved before it is sent. Its records carry no MAC: the trader holds no key (Eric, 2026-10-28; D9). An order never times out to `lost` (pipeline review, 2026-10-27), and since the red-team review the same day no clock settles a build either (`agent-ledger.js` `settleOpen`).
   - **States.** `INTENT` → `RESERVED` (the `intent_id` and the `client_order_id` derived from it, recorded before anything is sent) → `SENT` → `ACKED`, `REJECTED` or `UNKNOWN`; then `ACKED` → `PARTIAL` → `FILLED`, `CANCELLED` or `EXPIRED`.
   - **Unknown stays unknown.** A timeout, a dropped broker WebSocket or an answer that does not read makes the order `UNKNOWN`. It stays `UNKNOWN` until the engine has asked the venue for that `client_order_id` and recorded the venue's answer. It becomes `NOT_FOUND` only when the venue, asked for that `client_order_id`, has no record of it and the venue's duplicate-order window has passed. For the simulated venue, whose record is complete by construction, that window is 60 minutes from the send, on the engine's clock (`paper-trader.js` `VENUE_DUPLICATE_WINDOW_MINUTES`). A real venue would need its own explicit "unknown order" answer, and its own documented window, before `NOT_FOUND`; nothing connects to one. The clock alone never settles an order: it only gates `NOT_FOUND` once the venue has been asked.
   - **No new action while unresolved.** While any order is `RESERVED`, `SENT` or `UNKNOWN` (one that may be live with no answer on record), the engine opens no new intent. It never resends an order under a new `client_order_id`: a resend carries the same one, so the venue refuses a duplicate.
5. **Sovereign capital governance.** The agent trades only on the simulated Paper Book (`cr-paper@3` since PR #97; the `cr-paper@2` section below; since slot 12a the desk's adapter routes to it Eric's grants, and grants made under an unexpired paper-mandate generation he armed (`cr-paper-mandate@1`), and nothing else). The PM Paper Book (`cr-paper@1`, `paper/positions.jsonl`; item 18) keeps measuring Eric's ticket decisions apart from it. Promoting any strategy to live execution needs Eric's own explicit, authenticated commit or signature on `main`.

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
- **Portfolio time (F1 of the Codex audit, 2026-10-28; `audits/2026-10-28-codex-audit-response`).** Made before any record exists, under the same version name:
  - NAV at each hour's end, from the first at or after the funding, is derived from the journal on every read and never written (`paper-trader.js` `navSeries`). It is the cash after the fills and exits of every hour ended by then, plus each quantity then held at the close of its pair's hour that ends there, else unknown.
  - A past hour end is never valued at an earlier close (PR 1b, the audit's second review). Only an hour end after the pair's newest hour, whose own hour may not have arrived yet, takes that newest close, and only while it is within the 120-minute freshness of now, as NAV now does. When a late hour arrives, the hour end it closes reads its value; nothing is written.
  - The 24-hour drawdown and the largest drawdown read that series. The order in which the pairs' hours arrive never changes them. An hour read before the funding (the first backfill, a new pair's history) is never in them, and an hour that arrives late corrects the hours after it.
  - A `mark` line an earlier build wrote is read and not used.
- **Settlement gate (`cr-paper@3`, the cohesion audit's M1, Eric 2026-10-29).** The book's record is settled only while every pair it is exposed in (an open position, or an order `RESERVED`, `SENT`, `ACKED`, `PARTIAL` or `UNKNOWN`, buy or sell) has an hour on record that ended within `NAV_PRICE_FRESH_MINUTES` (120) of now. It is derived from the journal and the clock on every read (`paper-trader.js` `settlementAt`) and reads no record of the adapter's.
  - While anything is unsettled, no opening is answered anywhere in the book: `reserveIntent`, and so `submitIntent`, throws `UNSETTLED`, nothing is written and the intent ID is unspent, so the same intent can be asked again once the hours arrive. An intent already on record still answers `unchanged`.
  - Closes, cancels, hours, recovery and reconciliation are not gated: they only reduce risk or settle the record.
  - `book` and `results` carry `settlement`: each exposed pair with what the book holds there, its last hour and the time it is settled through, and the words when it is not. An unsettled book's `book.unknown` says its figures are recorded balances.
  - It closes the case the cohesion audit found: an ACKED buy with nothing filled left NAV known ($25,000, a $0 drawdown) while a fill, stop or target could sit in an hour not yet on record.
  - Every missing hour the hourly read can see is already stale: it is seen once the hour after it has closed and settled, two hours and `SETTLE_MINUTES` (10) after the last hour on record ended, more than 120 minutes. So the gate holds wherever the adapter's gaps record does (`trader-boundary.test.js` pins it).
  - No journal event or record format changed: a journal written under `@2` reads the same, and its recorded refusals stay final.
- **End-to-end demonstration (D12, 2026-10-28).** `dashboard/tests/paper-trader-e2e.test.js` runs one fictional trade through the book, every figure asserted to the cent. The steps are:
  - fund $10,000;
  - a v3 intent on a stored $500 approval, held to 2% of NAV ($200);
  - sizing from the loss at a stop of 90 with fees and 25 bps of slippage (18.859 units);
  - reserve and send;
  - the acknowledgement lost (`UNKNOWN`, a second intent refused `halt_unresolved`);
  - reconcile by `client_order_id`;
  - a partial fill at `FILL_SHARE_MAX`;
  - the stop with its slippage and taker fee (realized −$106.0455, NAV $9,893.9545, open risk 0).

  The test drives the book directly; in the desk only the adapter below calls it.
- **Approve wired (slot 12a, Eric 2026-10-28; `audits/2026-10-28-approve-wiring/PLAN.md`, approved).** The desk's adapter, `dashboard/core/trader-desk.js` (`cr-trader-desk@2` since PR #95, 2026-10-29; `cr-trader-desk@1` before it), is the trader's one caller (`trader-boundary.test.js`):
  - **What asks.** A decision line records `effects.trader`: `open` for an approve or a halve, `close` for the undo of one. Only those decisions ask the book; a grant recorded before slot 12a opens nothing. The decision's own step runs at once, and a failure there is said in the decision's answer, never allowed to lose or block it.
  - **What opens.** Only an ACCUMULATE or LIMIT_TRAP ticket whose receipt checks out. Entry: the lower of the book's price and the entry zone's high (ACCUMULATE) or low (LIMIT_TRAP). Stop: the invalidation price. Target: the upside target. Risk: Eric's approved amount. Life: his longest life of an intent. Pair: the project's ticker against USDC, refused while another unarchived project shares the ticker. A missing field opens nothing, said in words; a stop is never invented.
  - **One attempt.** The intent ID is a ULID derived from the decision, so the book's answer, an order or a refusal with its reasons, is final. The book is asked only once it can answer: funded, Eric's rules and venue fee set, a closed hour within his price freshness and a 14-hour ATR for the pair, no unresolved order. Until then the request waits, in words. Once the ticket's exit readings give no size (D11), it never opens.
  - **Bounded opening (`cr-trader-desk@2`, the cohesion audit's M2, M4 and M7, 2026-10-29).** Before the decision's one intent ID is spent, the adapter checks the opening as the book will (`trade-risk.js` `validateTradeIntent` over the same `book`, and the book's free cash) and asks only an intent the book would take: anything else waits, in words, with the attempt kept, so a temporary refusal no longer makes the decision dead. Eric's approved risk is a ceiling: when the full amount breaks an upper limit (risk per trade, 24-hour drawdown, the gate's or his own risk, the notional cap, the exit measurement's size or the free cash), the order is the largest size every limit allows at the book's 18 places, floored to the lot, so one lot more breaks the binding limit, which the request names; never above his amount. A re-grant on a ticket whose earlier position is still closing waits until the ticket is flat, then opens once at its full grant. A grant past its research horizon, or on a ticket invalidated since, opens nothing. An order whose life (his longest life of an intent) holds no whole hour after it is sent waits for one rather than expiring unfilled. Intent IDs keep the `@1` derivation. The engine re-checks everything under its lock; a change between the adapter's check and the reservation (another process) can still be refused there, which stays final (a [P] follow-up).
  - **Exit-evidence renewal (`cr-ticket-exit-evidence@1`, the cohesion audit's M3, 2026-10-29).** A risk-taking ticket's view carries `exit_evidence` (`tickets.js` `exitEvidenceOf`, the Paper Book's own rule: complete, within the receipt's frozen limit, the newest such reading plus 72 hours): the PM card shows Until or Expired under Exit and, once expired, says why an approval could not open. Approve and Halve are refused inside the decision's lock (409 `EXIT_EXPIRED`, nothing written) and drawn disabled. The renewal is Re-open, labeled "Renew exit evidence" (reason `exit_expired`, only while no grant is in force): one decision, idempotent by request and by the decision in force; the old receipt and decisions stay as they were; the queue's next step is a new ticket (`refresh`), on fresh readings, which waits for Eric's own new decision. Nothing renews by itself and no model is asked from a read. A grant's toast now carries the trader's answer (`not_opened` and `failed` in the warning tone).
  - **One snapshot per read phase (the cohesion audit's brief 5, 2026-10-29).** The adapter's `snapshotOf` keeps the engine's results, intents and hours it read, and the view, the requests, `wanted` and a step's assessments use it instead of reading the journal again; a step reads the book again only after it records something (funding, recovery, a reconcile, each order or cancel), and the requests it returns are read after the last of them. Nothing is kept between calls and no stored record changed. The Paper Book view went from 6 journal reads to 3 and an idle step from 10 to 3 (`tests/trader-desk-reads.test.js`); one read for all three, and the per-grant `book` read of a request not yet asked, need an engine API (a [P] follow-up).
  - **A lost book is not a new one (2026-11-05).** With its journal and head both gone, `paper-trader.js` reads what a book reads before its first funding. So when the book reads as unfunded, `snapshotOf` and `applyHours` ask the record outside the book: `logs/operations.jsonl`. A committed `paper_trader.fund.*` there with no funding in the book is refused as INTEGRITY, so the brief says `trader_unreadable` with an unknown count, nothing is funded again and no decision's order is sent again. A funding that only began is no evidence. An op log that does not read is unknown, never new. The limit: with the log gone too, the book still reads as new, and the backups are the answer to that. `dashboard/tests/trader-lost-book.test.js`.
  - **The book-identity anchor (2026-11-05).** The operation log shares the Render disk with the book, so it cannot say a book existed when the disk is lost. `CR_TRADER_BOOK_ANCHOR`, in the host's environment, can: the SHA-256 of the journal's first line, which a restore keeps. `bookAnchorOf` (`trader-rules.js`) reads it. In `trader-desk.js`, every engine write goes through `underAnchor`: under the workspace lock, after recovery, on the book the engine then reads in that lock. Public reads are bracketed by `readAnchored` (same journal file before and after, a commit reads again, a replaced book refuses); `executionFor` checks its exact bytes. Anything but a hash is INTEGRITY. Nothing routine starts a book: `fundOnce` funds only for a fictional workspace (`kind: test`, not hosted, no `CR_DATA_DIR`). A real first funding is `trader bootstrap`, on the command line only. Known limits: it names the book, not its progress, so an older copy of the same book passes and a newer surviving decision would be sent again, so a restore is one matched set; and a hand edit outside the lock during a write is not excluded.
  - **The restore hold (2026-11-05).** A restored copy's marker (`config/restored-copy.json`) now holds the Paper Book too: `underAnchor` refuses every engine write with `RESTORE_HELD`, checked before and after recovery, and against the marker as the read found it, so a write made from a read before a hold or a release refuses. Reads stay open and carry `restore_hold`. `restored-copy release` refuses, under the lock, until every grant with no order in the book is Undone, every piece of work the book holds is accepted by decision ID, and any armed mandate is off. Accepting gives no authority and writes only the marker; an opening can never be accepted. Overlay and point-in-time restores now write the marker. **Stops pause while held.** Not covered: a Render disk restore writes no marker and is not detected, so the external refusal comes first; the PM Cohort book (`paper.js`, protected) is not held. Procedure: `docs/engineering/PAPER_BOOK_RESTORE.md`.
  - **What closes.** The undo of the decision, the end of the ticket's research horizon, or its metric invalidation as the desk reads it. The unfilled part of the buy is cancelled, then the position gets a sell limit 20 bps under the book's price, asked again as a new intent if one ends unfilled (at most 24). The stop and target stay the book's own.
  - **Eric's settings.** `trader.book.cash_usd` (the funding, applied once, before any hour) and `trader.book.fee_rate` (the venue fee as a share of the notional, the maker and taker fee alike), beside `trader.rules`; neither has a default, and unset the adapter waits (`trader-rules.js` `bookOf`, the server's `validateSettingsPatch`). The lot (0.000001) and minimum order ($10) are fixed in the adapter.
  - **Hours.** `applyHours` takes closed hours (funding the book first) and `wanted` names the pairs the book needs them for, each with the last hour the book holds (`paper-trader.js` `hours`); the hourly read below fetches them.
  - **Missing hours (`cr-trader-gap@1`, the cohesion audit's M1, 2026-10-29; merged in PR #95).** When the book refuses an hour because the one before it is missing (GAP), the adapter records that missing hour once in `paper/candles/gaps.jsonl` (create-only: pair, missing hour, last hour on record, the later hour that showed it, first seen). A pair the book holds or has a live order in is unsettled while its missing hour is not on record, or while it has no hour on record for over 120 minutes (the book's NAV freshness). While anything is unsettled: no new order is asked anywhere in the book (the opening waits, in words: a recorded $0 drawdown is not evidence of room to risk); the unfilled part of a buy in that pair is not cancelled over its missing hour; and the view (`settlement`, and a line in `results.unknown`) and Outcomes say the book's figures are recorded balances, not settled ones. When the hour arrives it and the hours after it apply once, in order. A missing hour may never arrive (GeckoTerminal leaves out an hour with no trade); it then stays unsettled, said in words. Nothing is filled in, nothing is written off, and a gaps line that does not read leaves the book unsettled. Since `cr-paper@3` the engine holds the same gate itself (Settlement gate, above); the adapter takes each pair's reading from it and adds the missing hour it recorded.
  - **Demonstration.** `dashboard/tests/trader-desk.test.js` takes one fictional ticket through `tickets.decide`: an approve that waits, then opens sized down to the $2,000 exit cap (2,352.941176 units, since `@2`); an undo that cancels it and a halve ($250, 1,598.519131 units at $0.85); a partial fill of 1,000; an undo that cancels the rest and sells (realized −$5.10).
- **Hourly candles (slot 12b, Eric 2026-10-28; the same PLAN.md, option A).** `dashboard/core/trader-candles.js` (`cr-trader-candles@1`), job `trader`, on the server's 30-minute timer (`DAILY_JOBS`) and in `jobs run`. No new scheduler, nothing in CI. It reaches the trader only through the adapter: `wanted`, then `applyHours`, then `step`.
  - **One pool per pair, frozen.** The first time a pair is wanted, one pool is chosen and written to `paper/candles/sources.jsonl` (create-only, the first line for a pair is its source for good), so its hours never switch pools. The contract is the first of the project's verified identity on a network the read lists (Ethereum, BNB Smart Chain, Arbitrum One, Optimism, Polygon, Avalanche, Linea, Base, Unichain, Sonic, Solana). The pool is GeckoTerminal's first, in its own order, that holds the contract, has a reserve and a 24-hour volume above 0, and prices the token within 2× of the CoinGecko price stored in the last 24 hours. It is not chosen by the largest reserve: a reserve is valued at the other token's price, which a thin token can inflate (a live read on 2026-10-28 showed a pool claiming $414M of reserve on $1M of daily volume, ahead of one with $158M on $57M). A native coin has no contract, so it gets no pool. A contract the read cannot place is said in words and tried again after 6 hours.
  - **Closed hours only.** `GET /networks/{network}/pools/{pool}/ohlcv/hour`, in USD, priced as the token itself. Only the hours after the last one the book holds are asked for (24 the first time). An hour counts only once it has been closed for 10 minutes; the hour in progress is never used. Volume comes in USD and is converted to tokens at the hour's high (the fewest units), cut at the book's 18 places. USDC is read at $1.00. A row that does not read stops that pair there.
  - **A missing hour stops that pair.** GeckoTerminal leaves out an hour in which the pool had no trade, and it is never filled in (Eric, 2026-10-28: GeckoTerminal's `include_empty_intervals` stays off, so no hour is recorded that nothing traded in). A pair that is asked once its latest hour has settled waits for the next hour. Then, for a pair with an open position or a live order, the book refuses the gap (GAP) and the run says so; its stop and target wait until that is resolved.
  - **Budget, gate, hold.** At most one request every 2.1 s (GeckoTerminal allows 30 a minute), counted on disk before it is sent: 400 a day and 5,000 a month. A 429 closes the gate until its Retry-After (else 10 minutes). An error or a timeout backs off from 15 minutes, doubling up to 6 hours. There is one fixed origin, no redirects, answers read bounded, and only the network, token and pool are sent. A restored copy sends nothing, and nothing is asked until Eric funds the book. The state is in `market-data/trader/candles-status.json`, which holds no address or key.
  - **Demonstration.** `dashboard/tests/trader-candles.test.js` runs against a fake GeckoTerminal. It shows the pool choice passing over another token's pool, one priced 3× off, one with no trade and a deeper reserve further down the list. It then follows a run that freezes the pool, applies 25 hours and orders the Halve (1,598.519131 at $0.85); the next hour asks the same pool for one hour; a no-trade hour then stops the pair with its live order (GAP).
- **What Eric reads (slot 12c, Eric 2026-10-28; the same PLAN.md).** Research > Outcomes > Trader's Paper Book, below the PM Paper Book and never added to it or to Portfolio. It is read only: `GET /api/paper/trader` returns the adapter's `view` (`trader-desk.js`) with the hourly read's `statusView` beside it, and reading it writes nothing and asks nothing.
  - **The card.** The book's figures: funded, NAV, cash, realized, unrealized, fees and the largest drawdown, each "Not funded" before funding and "Unknown" with its reason, never $0. Next to them is the NAV line over the closed hours with its change in words. Then each approve or halve with its state in words (Waiting, Order placed, Open, Closing, Closed, Refused, Not opened, Ended unfilled) and what happened. Then the open and closed positions (each exit in words, such as "Sold at $0.85"), every order with its state in words (UNKNOWN reads "Unknown: asking the venue", never lost) and each refusal with the book's reason. Folded at the foot: NAV by the hour, where the hours come from (the frozen pool per pair, the request budget) and what is not known. Every figure is rounded for reading, with the exact decimal in its tooltip and `data-exact`; the model is `dashboard/public/trader-book-model.js`.
  - **Eric's one-time steps.** Preferences > Screening holds "Trader rules" (12a) and "Your Paper Book": the funding and the venue fee, saved through `POST /api/settings` `trader.book` with the same bounds as the server. An empty field leaves the setting unset, and the card's waits link there. The trader job's row is in Preferences > Activity, under Jobs, beside the other jobs.
- **Protected.** `dashboard/core/paper.js`, `paper-trader.js`, `trade-risk.js`, `decimal.js` and their tests (`trade-risk`, `paper-trader` and `trader-boundary` under `dashboard/tests/`), with the frozen intent schemas, are on the protected list in `dashboard/tests/trader-boundary.test.js` (PR-B 5a, 2026-10-28). A change to any of them is its own supervised pull request, marked [P] in its title, that Eric reviews deliberately (`audits/2026-10-27-de-escalation` §4).

### Junior Trader roadmap

Eric, 2026-10-27; corrected by the pipeline review the same day. Both steps change protected files, so both backlog items were *(Eric)*: no builder took them. Both are built and merged by Eric (PRs #58 and #59).

1. **Pre-trade risk engine** (item 73, built, PR #58). `validateTradeIntent` in `dashboard/core/trade-risk.js`: a pure check of every `cr.trade-intent.v2` against invariant 3's limits and the rules above.
2. **Paper Book `cr-paper@2`** (item 74, built, PR #59). The blueprint above, in `dashboard/core/paper-trader.js`. It replaces the earlier `paper-fills.js` harness (`cr-paper-fill@1`), which was never built.
3. **Approve wired** (blueprint slot 12, Eric 2026-10-28, `audits/2026-10-28-approve-wiring/PLAN.md`). 12a: the adapter (`dashboard/core/trader-desk.js`, above). 12b: the hourly pool candles it waits for (`dashboard/core/trader-candles.js`, above). 12c: Outcomes > Trader's Paper Book, read-only, with the funding and fee form (`GET /api/paper/trader`, above).

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

## UI v3 parity (2026-10-30)

The Desk was rebuilt to `UI_MASTER_PLAYBOOK.md` (branch `claude/desk-v3-exact-ui`). The rebuild touched only `dashboard/web/src/`, `dashboard/web/public/`, `dashboard/public/tokens.css`, the committed bundle and the checks. The trading core (`core/paper.js`, `paper-trader.js`, `trade-risk.js`, `decimal.js`), the schemas and the API routes are unchanged.

| Stage | What landed |
|---|---|
| Shell and Focal | A 150px text rail, the page capped at 1560px. The Focal block is always obsidian and leads with the tickets that wait. The market line is plain text on the canvas |
| Ledger | One white card. Head and rows share one grid. Clean headers. A Gate column |
| Inspector | One warm card, docked from 1280px. Blocks A to F: head, price, PM Cohort, Signals (worst first, one shown, the rest folded), What changed, then Thesis, the ticket card, Needs you |
| Ticket card | `PMDecisionCard.jsx` sits between Thesis and Needs you, obsidian with 26px corners. Entry, stop and target, an exit bar, actions per state. Labels and handlers are unchanged |
| Contract gate | `GatePanel.jsx` shows the gate's own words verbatim, plus tier and mode. Folded by default; Preferences > Desk "Contract gate details" (`ui.gate_details`) or `?open=gate` opens it |
| Copy (D15) | User-facing names are "PM Cohort" (the model grades) and "Trader Sim" (the paper book). API names, models and comments are unchanged |
| Responsive | From 768px to the docked breakpoint the inspector is a 440px drawer with card corners. The phone keeps a 24px sheet |

Deviations from the playbook, on purpose:

- **Type floor:** labels stay at 12.5px. The concept's greys were raised until they pass contrast in light and dark.
- **Pixel diff (§8.4):** not run. There is no `concept.html` in the repo, and the design source refused access. The computed-style parity checks below stand in for it.
- **Gate column:** the tier word only ("No finding", "For review", "Hold", "Block"), with the gate's words on hover. There is no rule id, because the index carries none. The backend is unchanged.
- **Gate panel:** shows what the index already carries (mode, tier, words, economics) and links to Contract and checks. Packet facts, the authority graph, findings and provenance need an API change, so they are not shown.
- **Approve:** stays a click, not a hold pill, labelled "Approve Risk ($N)". There is no "/ 1.0R", because no R unit exists in the ticket data.
- **Gated tickets:** a gated ticket (enforce, block or hold) keeps Veto and Pass. The server refuses only grants (`contractGrantBlock`).
- **Docked inspector:** scrolls as one card (max height of the viewport) rather than an unbounded sticky.
- **Other:**
  - The ledger footer drops the held value.
  - The ⋯ menu uses submenus.
  - Preferences sits off the v3 rail.

Checks changed:

- **Phone check (`check.mjs`):** reads the first row's cells, not the hidden `<th>`.
- **`regress.mjs`:**
  - F3 finds the verdict block at `.iv-cohort`.
  - F7 measures against the visible viewport.
  - L7 reads "PM Cohort".
- **`type-floor.test.js`:** asserts the Signals grid (`.v3-sig`).
- **`ui-logic.test.js`:** covers the contract gate panel.
- **v3-parity block (`check.mjs`):** computed styles at 1440×900, light:
  - page 1560/28/72/36
  - rail 150
  - Focal obsidian 32/28-30-22
  - headline 44/300
  - ledger white 32/22-24-14
  - rows gap 14, radius 14
  - name 15/500
  - inspector 360–440 wide, warm 32/26-26-22
  - price 44/200
  - ticket obsidian 26/20
  - Mark reviewed pill
  - Geist
  - no sideways scroll

Trader Sim on the Desk reads the existing read-only `GET /api/paper/trader` (`lib/trader.js`). No core file was touched.

Legacy CSS: rules whose classes no longer appear in any source, test or check were removed from `inspector.css` and `watchlist.css` (the main CSS bundle went from 223.3 kB to 214.9 kB). Rules still referenced stay, mostly the `.wl-table` base that the v3 ledger restyles and that `type-floor.test.js` asserts, and the `iv-rgrid` and `VerdictCard` rules that Review mode still draws. `proof-shots.mjs` still names `.iv-rc`; it is not part of the checks.

## Retired backlog

The Active Backlog and the Autonomous Build Backlog were retired with the agent lane (PR-B 5b, 2026-10-28) and frozen in `docs/history/autonomous-build-backlog.md`. Nothing builds from them.
