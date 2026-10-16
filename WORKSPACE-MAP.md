# Workspace map

Everything here is plain files. The dashboard, the CLI, the request queue and the scheduled task change them only through `dashboard/core` (lock → validate → stage → atomic move → verify by reading back → operation log). Anything marked **derived** can be deleted and rebuilt with `node dashboard/cli.js index rebuild`.

```
CryptoResearch/
├── workspace.json              Marks this folder as the REAL workspace (id, timezone, home PC). Do not delete.
├── package.json                Pins Node 24.21.0 for this folder only (Volta); no npm dependencies
├── README.md                   How to use it
├── COWORK-INSTRUCTIONS.md      Durable instructions for Claude / Cowork sessions (commands, request schemas)
├── CLAUDE.md                   Short pointer Claude Code loads automatically; points to COWORK-INSTRUCTIONS.md
├── WORKSPACE-MAP.md            This file
├── Open Dashboard.cmd          One-click launcher (127.0.0.1:4729)
├── Open Demo Dashboard.cmd     Fictional demo workspace (127.0.0.1:4739)
├── archive/                    Unique files kept from retired copies (2026-10-02-consolidation: zip, manifest, README)
├── audits/                     Audit reports and their status (findings, migration, validation, screenshots)
├── supabase/migrations/        SQL of the optional Research Explorer database (schema only: no data, no keys);
│                               applied versions are named <timestamp>_<name>.sql; never edit an applied one
├── config/
│   ├── settings.json           Only your overrides (thresholds, refresh, labels, research models and budget)
│   └── ui-state.json           Dashboard view preferences (columns, sort, filters); not a record
├── templates/                  Versioned. Never edit a published version in place; publish a new @N
│   ├── research-prompt.v5.md       Canonical research prompt (cr-research-prompt@5: one decision question, summary first,
│   │                               six research sections, sector focus from the scoring profile); v1-v4 kept for old runs
│   ├── grading-appendix.v5.md      Appendix with the JSON contract (cr.report.v2): thirteen category grades with confidence,
│   │                               code_review, chart_cycle, independent_judgment, scenarios with unknowns allowed (v1-v4 kept)
│   ├── execution/                  Execution notes for one model (chatgpt.v1.md = cr-execution-chatgpt@1): how it works
│   │                               through the unchanged prompt; frozen per job next to prompt.md (execution.<model>.md)
│   ├── appendix/                   Standalone appendix per scoring profile, for your own prompts
│   ├── rubrics/                    cr-grading@1 (weights, labels, risk panel) + scoring profiles: @2 (thirteen category
│   │                               grades, used by new research) and @1 (kept for the reports that declare it)
│   │   └── RUBRIC-LOCK.json        SHA-256 pin per rubric/profile version; unpinned or altered = no app grade
│   ├── schemas/                    JSON Schemas: report (v2 for cr-research-prompt@5, v1 for earlier reports), project,
│   │                               transaction, request, journal, events
│   └── source-prompts/             Your original prompts (Huma Finance Run 2 is saved here)
├── inbox/
│   ├── claude/  chatgpt/  gemini/   Drop reports here; the folder = which assistant wrote it
│   │   └── processed/               Originals moved here after import (date-prefixed)
│   ├── requests/                    Cowork request queue (COWORK-INSTRUCTIONS §8): <id>.json.tmp → <id>.json
│   │   ├── processed/  failed/
│   └── intake/                      New research requests: in_<time>_<id>.json (link, screenshot, instructions,
│                                    candidates, your confirmation, events) and the screenshot beside it
├── projects/
│   └── <project-id>/               Stable ID, e.g. huma-finance, allora-network
│       ├── project.json            Identity (website, CoinGecko ID, contracts, evidence), sector, scoring profile,
│       │                           watchlist, headline, review cursor, research defaults
│       ├── events.json             Your reviews, catalysts, alerts (America/New_York dates)
│       ├── claim-reviews.json      Your dashboard checks and corroboration per claim
│       ├── disputes.json           Your "question that would settle it" list
│       ├── notes/conviction.md     Your current conviction note
│       ├── journal/<entry>.json    Immutable: decisions, note history, thesis updates, completed reviews
│       ├── prompts/<provider>.md   Standing research prompts (rebuilt when the profile changes)
│       ├── research/<run_id>/      One research run (immutable inputs)
│       │   ├── run.json                Models, rubric + profile versions, horizon (exact dates; long-term reason if any),
│       │   │                           prompt hash, market snapshot ID, job states and attempts
│       │   ├── prompt.md               The canonical prompt, identical for every model
│       │   ├── evidence-packet.json    Dated public context incl. the market snapshot (no holdings, notes or other models' conclusions)
│       │   ├── cowork-draft.md         Claude-in-Cowork's working draft while it researches (connector), kept if interrupted
│       │   ├── <provider>-draft.md     ChatGPT's or Gemini's working draft through its own connection (chatgpt-, gemini-)
│       │   └── responses/<provider>-attempt<N>.json   Raw API response, saved before normalization
│       ├── forensics/              Forensics & Resilience (core/forensics.js); no paid model call
│       │   ├── audits/<audit_id>/      audit.json (roles, frozen definitions and preferences), prompt.investigator.md,
│       │   │                           prompt.challenge.<receipt_id>.md, evidence-packet.json, drafts/<role>.md
│       │   ├── receipts/<receipt_id>.json|.md   Immutable assessment and challenge receipts and the text as saved
│       │   ├── observations/YYYY-MM.jsonl       Monitor observations (product checks, repository reads), each hashed
│       │   ├── resolutions/<receipt_id>.jsonl   Checkpoint outcomes, append-only; a correction is a new line
│       │   └── profile.json            Your monitoring opt-in and the targets you approved
│       └── reports/<YYYY-MM-DD>_<provider>_<hash>/
│           ├── original.md|txt|json|pdf   The report exactly as received (never changed)
│           ├── meta.json                  Provider, channel, declared provider, attested vs self-reported, hashes
│           ├── report.json                Structured extraction + validation notes (never changed)
│           └── corrections/<id>.json      Your corrections, layered on top (audit trail)
├── portfolio/
│   ├── accounts.json           Labels for where assets sit (public addresses only)
│   ├── assets.json             Reference assets (BTC, USDC, USDT, USD cash) and their decimals
│   ├── transactions.json       Every transaction (exact decimal strings); mistakes are voided, never edited
│   ├── limits.json             Capital cap, max position %, max sector %
│   ├── events.json             Portfolio-level reviews
│   ├── imports/                CSV files exactly as imported
│   ├── snapshots/<date>.json   Daily valuation snapshot with the prices used
│   └── wallets/                Tracked wallets, read-only (core/wallets.js, core/walletsync.js)
│       ├── registry.json           Label, public address, networks, status, linked ledger account
│       ├── token-metadata.json     Token names, symbols and decimals as Alchemy reported them, per network
│       ├── sync-state.json         Sync progress per network: blocks reached, last success, errors, estimated compute units (no addresses, keys or URLs)
│       └── <wallet_id>/<network>/
│           ├── events.json         One event per transfer leg or fee, with each transaction's receipt facts (`txs`)
│           ├── balances.json       Last complete balance snapshot and the ten before it (exact raw amounts)
│           ├── raw/alchemy-<YYYY-MM>.json  Alchemy's original transfers, receipts and block checks, every version kept
│           └── raw/<YYYY-MM>.json  An earlier provider's original items (kept as saved)
├── market-data/
│   ├── latest.json             Last VALID observation per asset (invalid or older data never overwrites)
│   ├── status.json             Last attempt / success / error, backoff, monthly call count
│   ├── logos/                  Small logo images cached from CoinGecko's image CDN
│   ├── observations/YYYY-MM.jsonl   Append-only market history (about hourly)
│   ├── forensics/status.json   The forensic monitor's GitHub gate, backoff and request counts (no address or key)
│   └── context/                Market-cycle snapshots: BTC trend, dominance, breadth (about hourly)
│       ├── latest.json             The last valid snapshot (kept when a fetch fails)
│       └── YYYY-MM.jsonl           Every snapshot, append-only; research runs cite them by snapshot ID
├── logs/
│   ├── operations.jsonl        Every write: begin / commit / recovery, with files touched
│   ├── applied/<key>.json      Idempotency records: one per applied request or form submission
│   ├── jobs.jsonl              Job runs (scheduler, dashboard, CLI)
│   ├── jobs-state.json         Last run / last success per job
│   ├── research-spend.jsonl    Reservation, actual, release and reconciliation lines for every paid model call
│   │                           (kept for history and for older code; the run files are authoritative).
│   │                           Screenshot reads for New research are here too (run_id intake_<request>)
│   ├── ingestion-state.json    Inbox file status (ingested, duplicate, failed + reason)
│   ├── review-findings.json    Daily review findings
│   ├── requests/<id>.result.json   Receipts for queued requests (done/unchanged/rejected/conflict/failed)
│   └── scheduler-last-run.log  Output of the last hourly task run, with the Node version used
├── backups/
│   ├── snapshots/<time>_<reason>/  Sealed copies of your records with MANIFEST.json (SHA-256 per file)
│   ├── versions/…@<time>           Previous version of every file that was replaced
│   ├── quarantine/<time>/          Files set aside by a point-in-time restore (never deleted)
│   ├── exports/                    Exports written by `node dashboard/cli.js export`
│   └── offsite/                    Verified copies of the online desk pulled by this PC (offsite pull),
│                                   with OFFSITE-INDEX.json; or the folder set with offsite setup --to
├── server.js                   Render's start command for the online desk (runs dashboard/hosted.js)
├── dashboard/                  App code (Node 24 LTS pinned; Node 20+ works; no dependencies, no build step)
│   ├── cli.js  server.js  hosted.js  oauth.js  mcp.js  core/  public/  scripts/  tests/  fixtures/
│   ├── index/index.json        DERIVED cache of the dashboard view
│   └── demo-workspace/         DERIVED fictional demo (rebuild: node dashboard/cli.js demo build)
└── .cr/                        Internals: write lock, leases/, staging, generation.json, blocked.json,
                                quarantine/ for unverifiable writes, captures/ for paid answers and
                                background request IDs waiting to be saved (removed once saved; copied
                                into backups and packages), repairs.json (one-time record repairs,
                                also copied), server.json;
                                on the online desk only, sessions.json (hashes of signed-in sessions) and
                                oauth.json (the connector: registered clients, each connection's model
                                (Claude, ChatGPT or Gemini) and hashes of its tokens)
```

The online desk on Render uses the same layout in its own data folder (`CR_DATA_DIR`, on a Render disk). Its `templates/` are copied from the deployed code on every start; everything else there is its own record.

## Conventions

- **IDs.**
  - **Project IDs** are lowercase slugs, permanent, and the same as the folder name. Renaming a project changes its `name`, never its ID.
  - **Report IDs** are `<analysis date>_<provider>_<first 8 characters of the original's SHA-256>`. When the analysis date is unknown, the import date is used and `meta.json` says so.
  - **Run IDs** are `run_<UTC timestamp>_<random>`; **request IDs** start with `req_`.
- **Immutable records.** Original reports, `report.json`, `meta.json`, corrections, journal entries and research-run inputs are written once (`mode: create`). A new analysis is a new report; a correction is a new file.
- **Replaced files.** Files that change, such as `project.json`, `events.json`, `transactions.json`, `run.json` and settings, are replaced atomically. The previous version goes to `backups/versions/`.
- **Sector vs scoring profile.** `sector` (DeFi, Payments/PayFi, Infrastructure, AI/Data, Gaming, Other, plus tags) is your label for filters and concentration. `sector_profile` decides which diagnostic categories and research sections apply. They are separate; changing one never rewrites reports.
- **Evidence tags.** Claims keep the analyst's tag exactly as written:

  | Tag | Meaning |
  |---|---|
  | `[V]` | Checked in that analyst's session |
  | `[C]` | Claimed by the project |
  | `[I]` | The analyst's inference |
  | `[S]` | Speculative |

  Your own checks (`dashboard_check`) and independent corroboration are stored separately in `claim-reviews.json`. Citation integrity (do references resolve) is a separate, structural check.
- **Scores.** Every score is `{status: scored|range|unknown|not_applicable, value|low/high, rationale, evidence_refs, missing_data}` on a 1–100 scale. Unknown or not-applicable scores are never zero; they withhold the grade and show coverage.
- **Providers and provenance.** The inbox folder (or the run's job) decides which provider a report is filed under. `meta.json` keeps that separate from how it arrived (channel), what the report says about its author (declared provider) and whether the model was attested by an API response or only self-reported. A report that names a different assistant is held back for you to resolve.
- **Time.**
  - Timestamps are ISO 8601 in UTC.
  - Review dates are calendar days in America/New_York.
  - Market observations keep the provider's own timestamp (`source_last_updated_at`) plus the time it was fetched.
- **Demo and test data** never live here. The demo workspace has `"kind": "demo"` and shows a banner. Tests create temporary `"kind": "test"` workspaces in the system temp folder.
