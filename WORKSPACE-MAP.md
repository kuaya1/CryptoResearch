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
├── audits/                     Audit reports and their status (findings, migration, validation, screenshots)
├── config/
│   ├── settings.json           Only your overrides (thresholds, refresh, labels, research models and budget)
│   └── ui-state.json           Dashboard view preferences (columns, sort, filters); not a record
├── templates/                  Versioned. Never edit a published version in place; publish a new @N
│   ├── research-prompt.v2.md       Canonical research prompt (cr-research-prompt@2); v1 kept for old reports
│   ├── grading-appendix.v2.md      Appendix with the JSON contract (v1 kept)
│   ├── appendix/                   Standalone appendix per scoring profile, for your own prompts
│   ├── rubrics/                    cr-grading@1 (weights, labels, risk panel) + scoring profiles
│   │   └── RUBRIC-LOCK.json        SHA-256 pin per rubric/profile version; unpinned or altered = no app grade
│   ├── schemas/                    JSON Schemas: report, project, transaction, request, journal, events
│   └── source-prompts/             Your original prompts (Huma Finance Run 2 is saved here)
├── inbox/
│   ├── claude/  chatgpt/  gemini/   Drop reports here; the folder = which assistant wrote it
│   │   └── processed/               Originals moved here after import (date-prefixed)
│   └── requests/                    Cowork request queue (COWORK-INSTRUCTIONS §8): <id>.json.tmp → <id>.json
│       ├── processed/  failed/
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
│       │   ├── run.json                Models, rubric + profile versions, horizon, prompt hash, job states and attempts
│       │   ├── prompt.md               The canonical prompt, identical for every model
│       │   ├── evidence-packet.json    Dated public context (no holdings, notes or other models' conclusions)
│       │   └── responses/<provider>-attempt<N>.json   Raw API response, saved before normalization
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
│   └── snapshots/<date>.json   Daily valuation snapshot with the prices used
├── market-data/
│   ├── latest.json             Last VALID observation per asset (invalid or older data never overwrites)
│   ├── status.json             Last attempt / success / error, backoff, monthly call count
│   ├── logos/                  Small logo images cached from CoinGecko's image CDN
│   └── observations/YYYY-MM.jsonl   Append-only market history (about hourly)
├── logs/
│   ├── operations.jsonl        Every write: begin / commit / recovery, with files touched
│   ├── applied/<key>.json      Idempotency records: one per applied request or form submission
│   ├── jobs.jsonl              Job runs (scheduler, dashboard, CLI)
│   ├── jobs-state.json         Last run / last success per job
│   ├── research-spend.jsonl    Estimated and actual cost of every paid model call
│   ├── ingestion-state.json    Inbox file status (ingested, duplicate, failed + reason)
│   ├── review-findings.json    Daily review findings
│   ├── requests/<id>.result.json   Receipts for queued requests (done/unchanged/rejected/conflict/failed)
│   └── scheduler-last-run.log  Output of the last hourly task run, with the Node version used
├── backups/
│   ├── snapshots/<time>_<reason>/  Sealed copies of your records with MANIFEST.json (SHA-256 per file)
│   ├── versions/…@<time>           Previous version of every file that was replaced
│   ├── quarantine/<time>/          Files set aside by a point-in-time restore (never deleted)
│   └── exports/                    Exports written by `node dashboard/cli.js export`
├── dashboard/                  App code (Node 24 LTS pinned; Node 20+ works; no dependencies, no build step)
│   ├── cli.js  server.js  core/  public/  scripts/  tests/  fixtures/
│   ├── index/index.json        DERIVED cache of the dashboard view
│   └── demo-workspace/         DERIVED fictional demo (rebuild: node dashboard/cli.js demo build)
└── .cr/                        Internals: write lock, leases/, staging, generation.json, blocked.json,
                                quarantine/ for unverifiable writes, server.json
```

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
