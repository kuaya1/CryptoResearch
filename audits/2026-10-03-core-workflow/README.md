# Core workflow: one Cowork request, one verified project, three independent reports (2026-10-03)

The milestone, kept narrow: **one Cowork request, one verified project, three independent reports, automatically saved to the dashboard.** This note answers the independent review of `bab9fef` (61/100) against the code, records what changed, and lists what still needs Eric.

## Review findings checked against the code

| Finding | Still applied at `bab9fef`? | Now |
|---|---|---|
| Cost certainty: an incomplete usage report ($0.294) was booked as "actual" and released a $1.05 reservation | Yes | Fixed (`1f64c91`): actual only when every billable quantity is reported; otherwise an estimate held at least at its reservation until Eric reconciles it once |
| "Hard limit" claims for provider spend caps | Yes (code comments, README, Cowork instructions) | Corrected: the desk's limits stop a request before it is sent; provider caps are a second guard with billing delay |
| No readiness view; missing keys looked like an unexplained wait | Yes | `research.readiness`, Settings > Readiness, connector `desk_status`, readiness in `start_research`, "setup required: no OpenAI API key: OPENAI_API_KEY" on waiting jobs |
| Hosted UI showed Windows scheduler items, PC key guidance, a false Gemini option | Yes | Fixed in `4dde44f` and `0b6c294`; hosted doctor shows "Background work", not a scheduled task |
| Deployed revision not verifiable | Yes | `/healthz` (no sign-in), `/api/session`, the MCP server version, the start log and Settings name the commit Render deployed |
| Arrow C2: an audit tagged [V] from a CoinMarketCap AI summary | Yes (Gemini's Arrow report) | Flagged at read time (high); prompt @4 forbids it |
| Heima fee inferences without a reproducible period or query | Yes (Gemini's Heima C6) | Flagged at read time (fees_not_reproducible); prompt @4 asks for the period and the query |
| Source-type enum warnings in every sample | Yes (no list in the prompt) | Prompt @4 lists the types; the parser reads synonyms as the nearest type, one line instead of one warning per source |
| Scenario probabilities: "must total 100" vs "only where evidence supports them" | Yes (also in the sector profiles' section guidance) | @4: all three totaling 100, or none with the reason; parser accepts none-with-a-reason, partial or wrong totals are warnings |
| Backups exclude `.cr` (captures, submission IDs) | Yes | Backups and packages carry `.cr/captures` and the repairs ledger; a restore refuses any other `.cr` path |
| "Coinmarketcap" entry | Still pending | Left for Eric (archive it as a duplicate of Veranta, or keep); the one-time repair was correctly skipped |

New live finding: two verified projects were bound to CoinGecko IDs that do not exist (`veranta`, `io-net`), so they never got a price. CoinGecko's IDs are `avantis` and `io`, each naming exactly the contract on file (checked 2026-10-03). Two guarded one-time repairs rebind them (`0228e89`); any other verified ID the refresh does not get back is flagged, never rebound automatically.

## Commits

`1f64c91` cost certainty · `4dde44f` dashboard vocabulary and hosted wording · `0b6c294` readiness and revision · `0228e89` identity repairs and flag · `ba485d6` report contract @4 and evidence checks · `36da0b9` offsite backup and restore, docs.

## Tests

303 automated tests on temporary fictional workspaces, all passing, including: incomplete usage, concurrency and reconciliation; readiness with and without keys; the connector's readiness and `desk_status`; both identity repairs and their guards; prompt @4 content and @3 reproduction; scenario and source-type parsing with unchanged grades; the evidence checks on the review's two cases; the offsite route (no key, wrong key, lockout, never the sign-in), the PC pull (verified, tampered, planted sign-in file), pruning; and the **restore drill**: a copy made while a background request was submitted, its ID only in the capture, restores verified and the restored desk collects the answer by that ID without sending it again.

Grades of the six sampled reports before the deploy (Arrow: Claude 16.2, ChatGPT withheld at 40%, Gemini 39.2; Heima: Claude 29.4, ChatGPT withheld at 40%, Gemini 47.2) are re-read after it: the evidence checks and parser changes do not touch stored reports or weights.

## Needs Eric

- **Keys, in Render > Environment, entered by Eric:** `OPENAI_API_KEY` and `GEMINI_API_KEY` (automatic ChatGPT and Gemini), `COINGECKO_API_KEY` (free Demo key: prices are rate-limited without it), `CR_BACKUP_KEY` (offsite copies). Optional: `ANTHROPIC_API_KEY` (Claude by API when Cowork is not doing it).
- **Pilot budget** for the first live run: see the session report; provider budgets are a second guard, not a hard limit.
- **Offsite destination:** default `backups/offsite` on this PC; optionally a cloud-synced folder for a second copy.
- **Coinmarketcap:** archive or keep.
- **Live verification** once keys and spending are authorized: one three-model run, the same request repeated (no second run or paid request), and collection after an interruption.
