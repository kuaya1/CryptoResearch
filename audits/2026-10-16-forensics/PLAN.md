# Forensics & Resilience, first release: plan

Date: 2026-10-16. Baseline: `main` at 9883c18, with the review check-in session's
uncommitted work in the tree (left untouched; edits to shared files are additive).

## What the repository already gives us (reused, not rebuilt)

| Need | Existing piece |
|---|---|
| One verified write path, idempotency keys, recovery | `core/ops.js` `runOp` (create-only files for immutable records) |
| Frozen prompt + frozen dated evidence, run binding | `core/research.js` run pattern, `core/binding.js` field-by-field refusal |
| Assistant handoff, drafts, receipts, holds | `mcp.js` handlers, `research.heldProviders`, `restoredHold` |
| Bounded background collection: lease, gate, backoff, budget | `core/screening.js` / `core/fundamentals.js` pattern, `core/jobs.js` |
| Contract controls (mint, freeze, proxy, owner, tax-setting) | GoPlus cache `market-data/screening/<id>.json` (read, never refetched by forensics) |
| Observed trading volume history | CoinGecko `market-data/observations/YYYY-MM.jsonl` (read only) |
| Backups, package, isolated restore | `core/exporter.js` (`projects/` is already in PACKAGE_INCLUDE) |
| React project page, tokens, light/dark | `web/src/views/project/ProjectPage.jsx`, `public/tokens.css` |

Constraints found: DexScreener is browser-only and never stored (standing rule), so
the server collects no DexScreener data; Supabase Explorer exports fictional
fixtures only, so no forensic projection is added; Gemini's hold stays.

## Design

1. **Records** under `projects/<id>/forensics/` (authoritative, backed up with the project):
   `audits/<audit_id>/` (audit.json, frozen prompts, frozen evidence packet, drafts),
   `receipts/<receipt_id>.json` (immutable assessment and challenge receipts, create-only),
   `observations/YYYY-MM.jsonl` (append-only monitor observations, each hashed),
   `resolutions/<receipt_id>.jsonl` (append-only checkpoint outcomes; corrections append),
   `profile.json` (monitoring opt-in and approved targets).
2. **Versioned definitions** (`core/forensic-defs.js`, frozen into every receipt):
   `cr-forensic-events@1` (liquidity impairment, operational degradation, delivery
   inactivity, confirmed discontinuation: cadence, persistence, freshness, resolution,
   recovery), `cr-forensic-liquidity@1` (mechanism-aware exit estimates),
   `cr-forensic-scenarios@1` (conditional threshold estimates), `cr-probability-gate@1`
   (no method registered, so no percentage is ever shown), `cr-forensic-rubric@1`.
3. **Pure model** (`core/forensic-model.js`): event states and episodes from
   observations (Unknown on gaps, recovery tracked), exit estimates by pool mechanism,
   scenarios (deterioration, stabilization, recovery) with "Insufficient history"
   fallback, checkpoint timeline from a frozen origin (72 h, 7, 14, 30, 90, 120 days),
   desk checks on findings (sources, common-control wording, ungated probabilities).
4. **Workflow** (`core/forensics.js`): audit = frozen prompt + packet; Claude
   investigator job, optional ChatGPT challenge job (frozen when Claude's assessment
   exists); save with binding check, idempotent same-text receipt, revision with reason
   and disclosed new evidence; no paid API path at all.
5. **Monitor** (`core/forensic-monitor.js`, job `forensics`, opt-in per project):
   product checks through an SSRF-guarded fetch (`core/netguard.js`), GitHub
   commits/releases (keyless, optional `GITHUB_TOKEN`), checkpoint resolutions; shared
   lease, gate, backoff, monthly budget; held in a restored copy.
6. **Surfaces**: `GET /api/projects/:id/forensics` (read-only), explicit POSTs for
   start audit, import, monitoring opt-in; CLI `forensics …`; connector tools
   `start_forensic_audit`, `pending_forensics`, `get_forensic_audit`,
   `save_forensic_draft`, `save_forensic_report`.
7. **UI**: Forensics tab (React) in the order the brief sets; stacked cards on phones.
8. **Prompts and schemas**: `templates/forensics/forensic-prompt.v1.md`,
   `forensic-challenge.v1.md`, `templates/schemas/forensic.v1.schema.json`,
   `forensic-challenge.v1.schema.json`. Investment prompts, profiles and reports unchanged.
9. **Tests**: `tests/forensics*.test.js` for every adversarial case in the brief;
   backup/restore coverage; the full suite; `npm run build` + `npm run check` and
   screenshots at 360, 390 and desktop on a FICTIONAL desk.

Nothing is committed or pushed (Eric's standing rule).
