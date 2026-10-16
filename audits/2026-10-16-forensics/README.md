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
job "forensics" (opt-in) ──▶ guarded product checks, GitHub reads, aggregator exit quotes
                             on the chains Eric approved ──▶ observations (hashed, append-only)
                         └─▶ checkpoint outcomes that came due ──▶ resolutions (append-only)
GET /api/projects/<id>/forensics ──▶ core/forensics.js view (pure read; core/forensic-model.js)
```

| Piece | File |
|---|---|
| Versioned definitions | `dashboard/core/forensic-defs.js` (`cr-forensic-events@1`, `cr-forensic-liquidity@1`, `cr-forensic-scenarios@1`, `cr-probability-gate@1`, `cr-forensic-rubric@1`) |
| Pure rules | `dashboard/core/forensic-model.js` (event states and episodes, resolutions, exit estimates, scenarios, normalization, desk checks, coverage, timeline) |
| Records and workflow | `dashboard/core/forensics.js` |
| Monitor | `dashboard/core/forensic-monitor.js`, job `forensics` in `core/jobs.js` |
| Exit quotes (added 2026-10-16) | `dashboard/core/exitquotes.js`: Jupiter (Solana) and KyberSwap (EVM) quote adapters, per-chain approval options, strict answer reading |
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
| Observed by the desk | product checks (status, expected text, body SHA-256, time), GitHub reads (archived, latest default-branch commit and release, committer dates), aggregator exit quotes on the chains Eric approved (below), CoinGecko 24-hour volume (already stored hourly), GoPlus contract controls (already stored weekly) |
| Observed by the investigator, frozen in its receipt | sources with retrieval times, excerpts, blocks or commits, transaction signatures; executable quotes and pool reserves with their time; product and delivery observations |
| Inferred | findings of kind inference or hypothesis, grades, explanations compared |
| Conditional | scenario crossings (deterioration, stabilization, recovery) against a level, the delivery window's date if nothing new is observed |
| Unavailable in this release | quotes on other chains or in other currencies, single venues and order books (audits only); server-side DexScreener (browser-only by rule); automatic wallet tracing; non-GitHub or private repositories; browser workflows; probabilities (no registered method) |

### Aggregator exit quotes (added 2026-10-16)

The liquidity-impairment outcome no longer reads Unknown between audits on a chain Eric approves.

- **Approval.** On the Forensics tab, "Approve exit quotes on <chain>" is one explicit click per chain, offered only for a contract in the project's verified identity (with a CoinGecko ID) on a covered chain. It is stored in `profile.json` `targets.exit_quotes` (chain, contract, quote source, who and when). Remove takes it out; monitoring must be on. CLI: `forensics monitor <id> --quote <chain_id:contract>`.
- **Sources.** These are fixed origins, keyless, queried with GET only:
  - Solana: Jupiter `https://api.jup.ag/swap/v1/quote`.
  - Ethereum, Base, Arbitrum One, Optimism, Polygon, Avalanche C-Chain, Linea, Unichain and Sonic: KyberSwap `https://aggregator-api.kyberswap.com/<chain>/api/v1/routes`, with `x-client-id`.
  - Every quote sells for the chain's native USDC at Circle's published address, valued at $1.00.
  - The request carries a token, a currency and an amount. It never carries a wallet, a taker, a signature or an approval, and no swap or transaction is built.
- **Sizes.** The sizes are your exit sizes ($100, $500, $2,000) and the position size in use. Each is turned into a token amount with CoinGecko's price as this desk stored it, no older than 6 hours (`quote_price_max_age_hours`). The token's decimals come from CoinGecko's `/coins/{id}` `detail_platforms` entry for that exact contract: one lookup through the shared CoinGecko gate and budget, reused for 30 days. A contract CoinGecko does not list, or a stale price, means nothing is asked.
- **Each answer is one observation.** It has kind `executable_quote`, route scope `aggregator` and source `monitor`, and records:
  - the time, the size, the amount in base units, the price and its time, and the decimals and their source;
  - what the sale would receive, the route (venues and splits), and the network fee where stated (KyberSwap's gas plus L1 fee; Jupiter states none);
  - the price impact, as the provider states it: Jupiter's `priceImpactPct` is a fraction, shown here as a percent; for KyberSwap it is its own USD values of input and output;
  - the provider's request IDs.
  
  Pool fees are inside the quoted amount. `forensic-model.js` `liquidityReadings` reads these unchanged, beside the quotes captured in audits.
- **What counts.** A quote within your limit at the position size is a reading within it. "No route" counts as beyond the limit, and only when the aggregator says it searched and found none at that size: Jupiter `NO_ROUTES_FOUND`, `COULD_NOT_FIND_ANY_ROUTE` or `ROUTE_PLAN_DOES_NOT_CONSUME_ALL_THE_AMOUNT`; KyberSwap 4008 or 4010. None of these is a reading (unknown): a token the source does not list (Jupiter `TOKEN_NOT_TRADABLE`, KyberSwap 4011), a refused size (KyberSwap 4009), an answer that does not match the request, an error, a timeout or a 429.
- **Cadence and limits.**
  - Quotes run every 12 hours (`quote_interval_hours`), so six readings fall in the 72-hour persistence and freshness windows.
  - Requests to one source are spaced: 2.1 s for Jupiter (0.5 a second keyless), 0.4 s for KyberSwap (3 a second).
  - A 429 closes that source's gate until its `Retry-After`, KyberSwap's reset-after or Jupiter's reset time (10 minutes when none is given).
  - An error or a timeout starts that source's backoff, kept in `market-data/forensics/status.json` `quote_gates`; an answer ends it.
  - Every request, CoinGecko's included, is counted against the monitor's monthly budget before it is sent.
  - The runs share the monitor's lease, a restored copy sends nothing, and opening the tab asks nothing.
- **On the tab.**
  - Hypothetical exits show the latest reading per size: a dated aggregator estimate marked "monitor", or "No route". An older, cheaper reading is history, never the current best.
  - The monitor's observations list each quote in words.
  - The methodology gives the desk's current cadence. `cr-forensic-events@1` is kept byte for byte; its cadence sentence ("no automatic quote source") predates this.
- **Verified against the real services (2026-10-16, one request each, by hand, not through the desk):**
  - Jupiter answered a keyless SOL→USDC quote with the documented shape and `x-ratelimit-*` headers. A 200,000 SOL quote showed `priceImpactPct` 0.177 against a 17.7% loss, so it is a fraction. An unknown mint answered `TOKEN_NOT_TRADABLE`.
  - KyberSwap answered a keyless WETH→USDC route on Base with the documented `routeSummary` (`amountInUsd`, `amountOutUsd`, `gasUsd`, `l1FeeUsd`, `route`) and `x-ratelimit-limit: 30, 10`. An unknown token answered 4008 "route not found".
  - CoinGecko's `/coins/{id}` returned `detail_platforms` with `decimal_place` and `contract_address`.
  - The adapter's own requests, the gates, backoff, budget and outcome resolution are exercised only with stubbed sources in `tests/forensics.test.js`. The first real monitor quote happens when Eric approves a chain and monitoring is on.
- **Terms.** KyberSwap's answers link its Terms of Use. Jupiter's keyless access is documented at 0.5 requests a second, and its developer platform says lite and keyless access may change. If either source starts requiring a key, quotes on its chains read as errors (unknown) until a keyed route is added.

## Verification

- Unit: `node dashboard/cli.js test`, the full suite, with `tests/forensics.test.js` covering every case in the brief (missing data, recovery, controls and prototypes, shared funders, pool mechanisms and quote failures, scenarios and insufficient history, revisions, binding and retries, restores, outages and rate limits, unsupported chains, hostile text and private targets, a read-only HTTP open, the connector).
- Browser: `npm run build`, `npm run check` (headless Chrome on the FICTIONAL dev desk): opening Forensics writes nothing; Watchlist → inspector → project → Forensics by clicks; the section order; past checkpoints, the conditional label and no percentage; an evidence chip opens its captured source with focus; the import dialog closes on Escape with focus back; no sideways scroll at 720/640/390/360/320; light and dark contrast at 1440 and 390 with every fold open; no motion with reduced motion.
- Real services: none were called for this release. GitHub's API shape and the guard against a real local server are exercised with stubs and a refused loopback connection; the first real GitHub read happens when Eric approves a repository and turns monitoring on.

## Credentials

None required; the exit quotes are keyless too. Optional: `CR_GITHUB_TOKEN` (environment only, never stored or logged) raises GitHub's keyless limit of 60 requests an hour; the monitor uses at most 3 requests per repository per day.

## The smallest next step for a real pilot

On the online desk, Eric asks Claude in Cowork: "Do a forensic audit of Huma Finance" (optionally "and have ChatGPT challenge it"). Claude saves one assessment; Eric opens the Forensics tab, reads it, and approves the proposed product check and repository if they look right, then turns monitoring on. The 72-hour and 7-day checkpoints then resolve from real observations.
