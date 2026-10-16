# Forensics & Resilience, first release (2026-10-16)

A Forensics tab on each project page: an evidence-backed forensic assessment and a resilience timeline (72 hours, 7, 14, 30, 90 and 120 days from a frozen assessment date). Separate from investment research: no investment grade, report, prompt, profile or rubric changed.

## Architecture

```
Cowork (Claude) ──start_forensic_audit──▶ audit: frozen prompt + frozen evidence packet
       │                                   (core/forensics.js createAudit; no model call)
       └──save_forensic_report──▶ receipt (create-only): origin, 6 deadlines, definitions,
                                  preferences, packet + prompt + text hashes, normalized block,
                                  desk checks, withheld probabilities
ChatGPT ──pending_forensics / get_forensic_audit / save_forensic_report──▶ challenge receipt
       (only when Eric asked; frozen with the receipt it challenges; never edits it)
Eric ──Forensics tab──▶ approve proposed targets, monitoring on/off, start an audit, import
job "forensics" (opt-in) ──▶ guarded product checks, GitHub reads ──▶ observations (hashed, append-only)
                         └─▶ checkpoint outcomes that came due ──▶ resolutions (append-only)
GET /api/projects/<id>/forensics ──▶ core/forensics.js view (pure read; core/forensic-model.js)
```

| Piece | File |
|---|---|
| Versioned definitions | `dashboard/core/forensic-defs.js` (`cr-forensic-events@1`, `cr-forensic-liquidity@1`, `cr-forensic-scenarios@1`, `cr-probability-gate@1`, `cr-forensic-rubric@1`) |
| Pure rules | `dashboard/core/forensic-model.js` (event states and episodes, resolutions, exit estimates, scenarios, normalization, desk checks, coverage, timeline) |
| Records and workflow | `dashboard/core/forensics.js` |
| Monitor | `dashboard/core/forensic-monitor.js`, job `forensics` in `core/jobs.js` |
| Guarded fetch | `dashboard/core/netguard.js` |
| Prompts | `templates/forensics/forensic-prompt.v1.md`, `forensic-challenge.v1.md`, pinned in `LOCK.json` |
| Schemas | `templates/schemas/forensic.v1.schema.json`, `forensic-challenge.v1.schema.json` |
| Surfaces | `server.js` routes, `mcp.js` five tools, `cli.js forensics …`, `web/src/views/project/Forensics.jsx` + `styles/forensics.css` |
| Tests | `dashboard/tests/forensics.test.js` (25), `web-app.test.js` write guard, `web/scripts/check.mjs` Forensics section |

Records live under `projects/<id>/forensics/` (see WORKSPACE-MAP.md), so backups, the complete package, the offsite pull and isolated restore carry them with the project (tested). The Supabase Explorer exports fictional fixtures only, so no forensic projection was added: there is one writable truth.

## Decisions taken

- **No paid path.** The investigator and the challenger work through their own connections (or a pasted prompt and an import). The desk sends no model request, so restarts and restores cannot resend one.
- **Outcomes are computed on read** from dated readings; only the monitor writes (observations, and checkpoint outcomes once due plus a grace period). A recorded outcome is never rewritten: a correction appends a line naming the one it corrects.
- **Revisions get their own origin.** A revision's evidence is later than the original's, so it cannot share the original's deadlines without hindsight. The original receipt and its deadlines stay byte for byte.
- **One pool over the limit is not counted** toward liquidity impairment: the best route can only be cheaper. A reading within the limit through any one route counts. "No route" counts only from an aggregator.
- **Delivery windows** that pass between the last reading and a checkpoint resolve as unresolved, not as either outcome.
- **The guard** refuses before connecting: https on 443, by domain name only, every resolved address public (checked in the socket's own lookup, so a rebinding name is caught), redirects re-checked (at most 3), 256 KB and 10 s caps, no cookies or credentials. The adversarial tests found that a `::ffff:0:0/96` rule in Node's BlockList matches every IPv4 address; the IPv4 rules already cover mapped addresses, so it was removed.

## What is observed, inferred, conditional or unavailable

| Kind | Fields |
|---|---|
| Observed by the desk | product checks (status, expected text, body SHA-256, time), GitHub reads (archived, latest default-branch commit and release, committer dates), CoinGecko 24-hour volume (already stored hourly), GoPlus contract controls (already stored weekly) |
| Observed by the investigator, frozen in its receipt | sources with retrieval times, excerpts, blocks or commits, transaction signatures; executable quotes and pool reserves with their time; product and delivery observations |
| Inferred | findings of kind inference or hypothesis, grades, explanations compared |
| Conditional | scenario crossings (deterioration, stabilization, recovery) against a level, the delivery window's date if nothing new is observed |
| Unavailable in this release | automatic executable quotes; server-side DexScreener (browser-only by rule); automatic wallet tracing; non-GitHub or private repositories; browser workflows; probabilities (no registered method) |

## Verification

- Unit: `node dashboard/cli.js test`, the full suite, with `tests/forensics.test.js` covering every case in the brief (missing data, recovery, controls and prototypes, shared funders, pool mechanisms and quote failures, scenarios and insufficient history, revisions, binding and retries, restores, outages and rate limits, unsupported chains, hostile text and private targets, a read-only HTTP open, the connector).
- Browser: `npm run build`, `npm run check` (headless Chrome on the FICTIONAL dev desk): opening Forensics writes nothing; Watchlist → inspector → project → Forensics by clicks; the section order; past checkpoints, the conditional label and no percentage; an evidence chip opens its captured source with focus; the import dialog closes on Escape with focus back; no sideways scroll at 720/640/390/360/320; light and dark contrast at 1440 and 390 with every fold open; no motion with reduced motion.
- Real services: none were called for this release. GitHub's API shape and the guard against a real local server are exercised with stubs and a refused loopback connection; the first real GitHub read happens when Eric approves a repository and turns monitoring on.

## Credentials

None required. Optional: `CR_GITHUB_TOKEN` (environment only, never stored or logged) raises GitHub's keyless limit of 60 requests an hour; the monitor uses at most 3 requests per repository per day.

## The smallest next step for a real pilot

On the online desk, Eric asks Claude in Cowork: "Do a forensic audit of Huma Finance" (optionally "and have ChatGPT challenge it"). Claude saves one assessment; Eric opens the Forensics tab, reads it, and approves the proposed product check and repository if they look right, then turns monitoring on. The 72-hour and 7-day checkpoints then resolve from real observations.
