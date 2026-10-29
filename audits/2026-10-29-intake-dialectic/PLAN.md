# Scout leads and the cross-model challenge: blueprint and execution plan (2026-10-29)

**Status: plan only, revision 2.** Nothing is built. No code, settings, schedules or records were changed, and no model work was sent. Six decisions are Eric's (section 7). The first PR waits for his word.

**Revision 2 (2026-10-29, afternoon)** answers Codex's final pre-implementation audit, which returned NO-GO on revision 1 with eight blockers (B1–B8). Section 10 maps each blocker to the section that now resolves it. The plan's architecture is unchanged: no new service, scheduler, queue or policy platform.

**Revision 2.1 (2026-10-29, evening)** corrects two statements after Codex's post-implementation audit ([POST_IMPLEMENTATION_AUDIT.md](POST_IMPLEMENTATION_AUDIT.md); fixes in [FIXES.md](FIXES.md)): an admission record is written once and then records only its effects' progress (section 5), and admission recovery runs outside the 20-second network phase (B4, section 4). No design changed.

**Inputs read**

- The first proposal, [README.md](README.md), SHA-256 `09123b5883f7619ec768a2553ded04cbadb2e4e9f9fd8dd0f84aa1343c1a7166`. This plan supersedes it where the two differ; it stays as history, not as a competing instruction set.
- Codex's red-team of that proposal, `C:\Users\Kuaya\.codex\visualizations\2026\10\29\01a185bf-7e81-71a0-8b17-295a96e9a59f\intake-dialectic-blueprint\README.md`, SHA-256 `715a9882375e044220ba6f639da3be6c665dfede3d503b895a3ee9613e4dcf30`.
- Codex's cohesion audit beside it, `cryptoresearch-cohesion-audit.md`, SHA-256 `ae5029620137937608197190edeb85bc294942e2f767e08734dc2c13d27fee6b`.
- Codex's final pre-implementation audit of revision 1, `…\intake-final-preimplementation-audit\README.md`, SHA-256 `05e87b625d4e4263c3e39d49146c514ca41b44e6c9706078385ec4ec264a403b`. It audited revision 1 of this plan at SHA-256 `c802a5394096c54645885450c03665d8d8f5a85c8a66cbdc52679252453b2860` (its frozen copy `PLAN.snapshot.md`).
- [The red-team review of 2026-10-27](../2026-10-27-red-team/README.md).
- [The response to the Codex audit of 2026-10-28](../2026-10-28-codex-audit-response/README.md).

**Baseline.** `origin/main` at `ac5fc890918c2b1b94b0abc1874ee1d47602f694` (PR #97 merged). The local `claude/p-engine-settlement` at `d69f56c638ce2f12e290b4d1e8863227addde2bd` has the same source tree. Every line reference below was read on that tree on 2026-10-29.

## 1. What changed since the first proposal

### Codex was right; checked in the code

| Claim | Where | Consequence for this plan |
|---|---|---|
| `cr-paper@3` is on `main` | `ac5fc89`, PR #97 | The first proposal's "branch only" line is stale |
| A `cr.ticket-receipt.v2` would be refused by the trader | [paper-trader.js:168](../../dashboard/core/paper-trader.js), refused at `:349` | No ticket v2 in this plan. Claude's v1 ticket stays the one the book reads. ChatGPT writes a separate, advisory challenge |
| `trade-risk.js` refuses unsuitable geometry; it does not clamp | [trade-risk.js:278–340](../../dashboard/core/trade-risk.js) | The first proposal's "clamps the stop and target" is withdrawn |
| A ticket's packet carries `captured_at` | [tickets.js:622](../../dashboard/core/tickets.js) | Two jobs never share bytes. The challenge reads the challenged ticket's own frozen packet, so its hash is the same by construction |
| `research.importSaved` imports a `cr.report` bound to a research run | [research.js:2113](../../dashboard/core/research.js) | The runner is not a ticket runner. An unattended challenge would need its own completion adapter (deferred) |
| `confirmIntake` records the candidate as "chosen and confirmed by Eric" | [intake.js:578](../../dashboard/core/intake.js) | No worker calls it. Admission needs its own truthful record |
| Projects also enter through the CLI, the server and the connector, not only intake | `cli.js:402`, `server.js:1311`, `mcp.js:1006` | "The only way in" is withdrawn. Those paths stay as they are |
| Refusing a whole batch for one bad row loses good rows | first proposal | Row-level outcomes (section 3) |
| The scout route checks the lock before the key | [scout.js:409–431](../../dashboard/core/scout.js) | Ten wrong keys from anyone lock out the right key for 15 minutes. Fixed in PR 1 |
| `runJobs` awaits each job in turn | [jobs.js:261–266](../../dashboard/core/jobs.js) | A slow lead pass would delay later jobs. Each turn is bounded (section 4) |
| GoPlus answers are read with `res.text()`, unbounded | [screening.js:306, 358](../../dashboard/core/screening.js) | The lead screen reads through `netguard.readBodyBounded` |
| An unset floor is a hold, not a refusal | first proposal | State `POLICY_HOLD` |

### Codex's final audit was right too; checked in the code (revision 2)

| Claim | Where | Consequence for this plan |
|---|---|---|
| Equal key sets do not prove Eric saw the same evidence | revision 1 §5 | `expect` carries each row's receipt ID and SHA-256, identity revision and the policy version and hash, plus the frozen model envelope (section 5, B1) |
| `createRun` deduplicates only a non-terminal run of the last ten minutes; `runOp` keys an operation only inside the request queue, as `requestId#type` | [research.js:905–924](../../dashboard/core/research.js), [ops.js:665–685](../../dashboard/core/ops.js) | Each admission gets its own effect keys through `runOp`'s `idempotencyKey`, passed into `addProject` and `createRun` (section 5, B2) |
| This Windows disk compares filenames without case; two base58 strings differing in one letter's case landed on one file (`filesystem-probe.json`) | the audit's probe | Asset files are named by a digest of the canonical identity tuple; the identity is kept in full inside and checked on every read (section 3, B3) |
| `JOB_NAMES` is not the hosted timer: `server.js` passes its own `DAILY_JOBS`; `runJob` leases only daily jobs and research; GoPlus's 20 s is per attempt | [server.js:738](../../dashboard/server.js), [jobs.js:231–266](../../dashboard/core/jobs.js), [screening.js:83, 335](../../dashboard/core/screening.js) | Explicit timer registration, one due predicate with a transition table, the job's own lease, and one shared turn deadline and request counter (section 4, B4) |
| `intakeModels` always includes Claude and filters holds only for the other two; a `queued` API job is due for the existing research timer | [intake.js:558–564](../../dashboard/core/intake.js), [research.js:881–902, 1291](../../dashboard/core/research.js), [server.js:627](../../dashboard/server.js) | The admission contract is "Confirm and request research": the models and routes are frozen at the click, every held model is left out, Claude included, and the words say the existing runner may send an API job by itself (section 5, B5) |
| `guardIndependence` protects only report reads and comparisons | [mcp.js:714–719](../../dashboard/mcp.js) | Every challenge handoff that carries content runs the same guard, with ChatGPT's hold and the read-only connection rule (section 6, B6) |
| Four `cannot_assess` tests had no honest overall verdict | revision 1 §6 | `challenge_verdict` gains `insufficient_evidence` with a reason; three chip states on the card (section 6, B7) |
| "All records create-only" cannot hold a second draft or job progress | revision 1 §6 | The ticket pattern: frozen bindings and receipts create-only, the job record and the working draft mutable (section 6, B8) |
| The root `package.json` has no `check` script | [package.json](../../package.json) | Every UI PR runs `npm --prefix dashboard/web run check` |
| The brief contract admits only `cr-scout-prompt@1` and four lanes | [scout.js:30–32, 165](../../dashboard/core/scout.js) | The brief stays on v1 untouched; leads come from their own prompt, `cr-scout-leads-prompt@1`, as a fifth xAI call (section 3) |

### Where this plan differs from Codex, and why

1. **One batch confirm, not a standing research policy.** Codex replaces routine confirmations with a versioned research-preparation policy. This plan keeps Eric's click, but makes it one click per morning: "Confirm all *n* eligible and request research", guarded by `expect`, the batch gate the desk already uses ([server.js:1081](../../dashboard/server.js), `tickets.js` `batchGate`).
   - The click is real, so the record tells the truth with no new kind of authority.
   - A policy also could not make research run by itself. The Researcher still needs an API key or Eric's Claude session.
   - A standing policy stays possible later, as its own decision.
2. **The eligibility worker stays small.** No `eth_getCode`, Solana account decoding or new chain readers.
   - A lead reaches Eric only after two checks: CoinGecko lists that exact contract on that chain, and GoPlus answers for it.
   - Agent 1's identity phase follows, as today.
   - Chain reads matter only for admission without a human, which is deferred.
   - The UI says so: "Listing matched; on-chain deployment not independently checked." Eric's confirmation does not prove authenticity or safety.
3. **ChatGPT's challenge goes through the connector first.** ChatGPT already connects, bound to its model. That costs nothing and needs no new dispatch code. An unattended API route waits for Eric's decision and his key.
4. **No wake-up kick.** The server's existing 30-minute timer runs the new job. A lead waiting up to 30 minutes costs nothing.
5. **"Lead", not "candidate".** `candidates` already names intake's CoinGecko matches (`identity.candidates`) and the ticket candidate board (`tickets.js:1832`). Here the words are `lead`, `cr.scout-leads.v1`, `scout/leads/` and job `leads`.

## 2. The pipeline

| Stage | Who decides | Writes | Calls |
|---|---|---|---|
| A. Delivery | Grok (data only) | One create-only delivery and one record per lead | nothing outside the desk |
| B. Eligibility | deterministic code, with Eric's values | One eligibility receipt per read | CoinGecko and GoPlus, budgeted, outside the lock |
| C. Admission | **Eric**: one click per row or per batch, "Confirm and request research" | One batch record, one admission record per lead, then an intake request, the project and one research run | nothing |
| D. Research and ticket | Agent 1 and Agent 2 as today; the desk sizes | A report, a ticket receipt (v1) | the existing routes only; an API job the existing runner sends by itself |
| E. Challenge (optional) | ChatGPT, advisory | One challenge receipt, beside the ticket | none from the desk; ChatGPT calls the connector |
| F. PM decision | **Eric** | His decision, as today | the paper adapter, as today |

Nothing in A, B or E starts research, opens a ticket, sizes, decides or touches the paper book. C requests research by Eric's click and nothing else. D and F are unchanged.

## 3. Stage A: delivery, acknowledged once it is on disk

**Route:** `POST /api/ingest/scout-leads`, in the front door beside `scout-brief` ([frontdoor.js:193](../../dashboard/frontdoor.js)), on the online desk only.

- **Kept from the brief route:** the same key (`DESK_INGEST_KEY`), no browser Origin, JSON only, 64 KB at most.
- **Who sent it, and who wrote it:** `source` is the key's principal, never from the body; today that is `grok-scout`. `model` is the sender's declaration (`^grok-[a-z0-9][a-z0-9.-]{0,40}$`, as the brief checks it) and is stored as "declared by the sender". The two are separate fields.
- **Status:** `GET /api/ingest/scout-leads/<delivery_id>` with the key returns the stored outcome and writes nothing.
- **Quota:** at most 6 lead deliveries a day (UTC), counted apart from the 6 briefs (`MAX_LEADS_PER_DAY`). A replay is answered before the count.

**Two fault layers.** The envelope is checked as a whole; each row is checked on its own.

- **Envelope** (`cr.scout-leads.v1`). Any fault here refuses the whole delivery (400) and saves nothing: not a JSON object; an unknown top-level field; `schema` or `prompt_version` not the expected strings; `delivery_id` not `^[a-z0-9-]{8,64}$`; `generated_at` not an ISO-8601 UTC time, or more than 24 hours from the time received, either way; `model` not a Grok model name; `leads` not a list of 1 to 10 elements.
- **Rows.** Each element is checked on its own, and a fault here records that row as `refused_at_intake` with its reasons while the other rows go on: the element is not an object, or has a field other than the five; the chain is not known to `chains.chainInfo`; the address does not fit the chain's family (`chains.addressFits`); the identity tuple (below) repeats an earlier row's; `signal` is not one plain line of at most 280 characters; `urls` is not a list of at most 5 `https://` URLs of at most 300 characters each; `coingecko_id` is neither null nor a plain slug. A row refused this way never throws the operation.

```json
{
  "schema": "cr.scout-leads.v1",
  "prompt_version": "cr-scout-leads-prompt@1",
  "delivery_id": "gh-<GITHUB_RUN_ID>-<GITHUB_RUN_ATTEMPT>",
  "generated_at": "ISO-8601 UTC",
  "model": "grok-4.3",
  "leads": [
    { "chain": "base", "contract": "0x…", "coingecko_id": null, "signal": "one plain line, ≤ 280 chars", "urls": ["https://…"] }
  ]
}
```

- **`delivery_id`:** made by the sender before it sends. `grok-cron.js` reuses it on its network or 5xx retry. A re-run of the workflow is a new attempt, with new paid Grok calls, so it is a new delivery.
- **The brief is untouched.** The four-lane brief keeps `cr-scout-prompt@1`, its four lanes and `scout.js`'s `PROMPTS` and `LANES` exactly as they are. Leads come from their own frozen prompt, `templates/scout/leads-prompt.v1.md`, pinned as `cr-scout-leads-prompt@1`, sent as a fifth xAI Responses call whose answer the sender posts to this route. No `cr-scout-prompt@2` is published.

Native coins are out of scope for leads, as D9 keeps them out of the trader this milestone. There is no name or ticker field.

**The identity tuple (B3).** Every lead is identified by `(chain_id, address_key)`:

- `chain_id` is `chains.chainInfo(chain).chain_id`, so `bsc`, `bnb`, `bnb-chain` and `binance` are all `56`, and `sol` and `solana` are both `solana`;
- `address_key` is `chains.addressKey(family, address)`: EVM lowercased, Tron and Solana exactly as written (base58 is case-sensitive).

`asset_id` is the first 32 hex characters of the SHA-256 of `stableStringify([chain_id, address_key])` (`requests.js` `stableStringify`). It is the `lead_key` everywhere: delivery-row deduplication, the asset file's name, the eligibility receipt, the admission and the UI. Hex is safe on a filesystem that ignores case; the base58 address inside the record is never lowercased.

**Answers**

| Case | Answer |
|---|---|
| New delivery, saved and read back | **202** `{ status: "accepted", delivery_id, receipt_id, payload_sha256, rows: [{ index, lead_key, outcome, reasons }] }`. "Accepted" means stored, not eligible |
| Same `delivery_id`, same normalized body | **200** `unchanged`, the first receipt. Looked up before the daily count, so a replay still resolves after the sixth delivery |
| Same `delivery_id`, different body | **409** `CONFLICT`. The original is kept |
| Wrong key, locked, too large, not JSON, bad envelope | 401, 429, 413, 415, 400 as today. Nothing saved |
| Seventh delivery of the day | **429** `DAILY_LIMIT`. Nothing saved |
| The save did not verify (disk full, interrupted) | **503**, never "accepted". The sender's retry with the same ID recovers |

**Records.** All are in one `runOp`, verified, and backed up with `scout/` (already in `exporter.js` `PACKAGE_INCLUDE`):

- `scout/leads/deliveries/<source>-<delivery_id>.json`: create-only. It holds the raw body's SHA-256, the normalized SHA-256, the received time, the declared model, the rows and their outcomes.
- `scout/leads/assets/<asset_id>.json`: one per asset. It holds:
  - `identity`: `{ chain_id, chain_label, family, address, address_key }` in full, as written in the first sighting;
  - `identity_revision` (1 at creation; reserved for a later identity correction, none in this plan);
  - the sightings (delivery, time, signal, URLs, declared model), appended, never rewritten;
  - `state`, `revision` and `next_attempt_at`;
  - the current claim, if a turn holds one;
  - the latest eligibility receipt's ID and SHA-256;
  - the admission or dismissal, if any.

  On every read the record's identity is hashed again and compared with the filename: a mismatch is `INTEGRITY` (409), the record is not returned, and no other asset is returned in its place. A second sighting of the same asset joins its record, never starts another read early, and never changes `revision` or the eligibility.

**PR 1, the lock fix, which the brief route also gets.** Check the key first. A correct key is never locked out; the lock only throttles refusals: a wrong key while locked is answered 429 and not counted again, so the lock still ends 15 minutes after the tenth failure. The counter stays in memory, which is acceptable: a key of 32 or more characters cannot be guessed in the window. This resists guessing; it is not a general denial-of-service guarantee, and PR 1 adds no infrastructure for one.

## 4. Stage B: eligibility, done by a bounded worker

**Registration (B4).** `leads` is added to `JOB_NAMES` right after `trader` ([jobs.js:33](../../dashboard/core/jobs.js)) and, explicitly, to the hosted timer: the server's `DAILY_JOBS` list ([server.js:738](../../dashboard/server.js)) moves into `jobs.js` as the exported `HOSTED_TIMER_JOBS` (`snapshot`, `reviews`, `backup`, `fundamentals`, `screening`, `forensics`, `trader`, `leads`), which `server.js` uses for the 30-minute timer and the start pass, so a test can read the list the timer runs. `jobs.isDue('leads')` calls `leads.isDue(ws, now)`: false when `leads.enabled` is off, in a restored copy (`research.restoredHold`), while CoinGecko's gate (`market.nextAllowed`) or GoPlus's gate (`screening` `blockedBy`) is closed, and when no asset is due. `runJob` gives no outer lease to this job; like the forensic monitor and the Paper Book's read, the worker takes its own cross-process lease (`leads`, 5 minutes) inside `run`, so the CLI (`cli scout leads run`) and the server never overlap. No new scheduler is added.

**One turn**

1. **Under the workspace lock:** pick the due assets, oldest first, at most **5**, and stamp each with a claim `{ op_id, claimed_at, revision }`. A claim older than 10 minutes with no receipt since is abandoned and may be taken again.
2. **Outside the lock, one network phase** with one shared budget (B4): at most **10** external requests and **20 seconds**, measured on a monotonic clock from the phase's start. One `turn` object carries `deadline`, `requests_left` and an `AbortController`:
   - every request, GoPlus's access-token request and each retry included, calls `turn.take()` before it is sent; false ends the phase;
   - every request's signal is `AbortSignal.any([turn.signal, AbortSignal.timeout(min(per_call, remaining))])`, so no attempt outlives the turn; GoPlus's `timeout_seconds` stays a ceiling per attempt, not a budget;
   - every body is read through `netguard.readBodyBounded(res, max, turn.controller)`, so a stalled body ends at the deadline;
   - a retry delay is skipped when it would pass the deadline;
   - the CoinGecko and GoPlus monthly budgets and 429 gates are checked and reserved as today (`market.reserveCall`, `screening` `reserveRequest`), before `turn.take()`.
   - **CoinGecko:** the contract endpoint for that chain's platform, through `intake.cgGet` with `maxWaitMs` set to the time remaining and no retry. It gives the coin ID, homepage, market cap, 24-hour volume and `detail_platforms`.
   - **GoPlus:** one call to a new `screening.screenAddress(chain, address, { turn })`. It shares `screening.js`'s lease, 429 gate, backoff, monthly budget and access token, and reads through `netguard.readBodyBounded`.
3. **Under the lock:** commit only if the asset's `claim.op_id` and `revision` still match the stamp. Write one eligibility receipt and set the state. An asset still claimed when the phase ended (budget or deadline exhausted) is released with `next_attempt_at = now` and the reason "turn budget used", so nothing is stranded; the next turn takes it first.

The lock wait and the file commit are outside the 20 seconds and have their own limits: `withLock`'s 20-second wait ([ops.js:264](../../dashboard/core/ops.js)) and the synchronous verified write. The plan promises a bound on network time, not an absolute wall clock through a stalled disk. Admission recovery (an admission's pending effects) and the claim writes also run outside the 20-second network phase, before the turn starts; they make no eligibility request and are bounded by the same lock wait and file writes, not by the turn.

On a 429 or a backoff, the asset gets `RETRY_AT` at the gate's time and the phase ends. Nothing sleeps. Read-only requests may be retried within the budget; that never applies to a model call.

**States** (`cr-lead-eligibility@1`)

| State | When |
|---|---|
| `NEW` | First sighting recorded; not read yet |
| `ELIGIBLE` | CoinGecko lists exactly this contract on this chain, GoPlus answered every critical fact, and every floor of Eric's is met |
| `REFUSED` | A fact fails a floor: honeypot, cannot sell, sell tax above his limit, market cap or volume under his floor, or the chain is not among those he allows. The reasons are kept |
| `KNOWN` | An active or archived project already holds this contract. Its ID is named. Nothing is re-added and nothing archived is restored |
| `POLICY_HOLD` | One of Eric's values is unset. It is named |
| `RETRY_AT` | A source failed, timed out or rate-limited, or the turn's budget ran out. The source and the time are kept |
| `NEEDS_REVIEW` | A supplied `coingecko_id` disagrees with the listing, the contract maps to more than one listing, or CoinGecko lists no homepage |
| `INCOMPLETE` | A source answered but a critical fact is missing (named): GoPlus's `sell_tax`, `is_honeypot` or `cannot_sell_all` on EVM and Tron, the current `transfer_fee` on Solana; CoinGecko's market cap, 24-hour volume or the `detail_platforms` entry for this chain. Read again at `next_attempt_at` = now + the eligibility duration |
| `DISMISSED` | Eric dismissed it. Terminal; a new sighting is only appended |
| `ADMITTED` | Eric confirmed it (section 5). Terminal |

A missing GoPlus field is unknown, never a pass; a zero tax is a known value, not a missing one. `ELIGIBLE` means only "may be shown to Eric for confirmation". It never means safe, attractive or approved.

**Due, and every transition (B4).** One predicate, `dueAssets(ws, now)`, read-only. With `leads.enabled` on and the copy not restored, an asset is due when:

| State | Due when | Then |
|---|---|---|
| `NEW` | always | read |
| `RETRY_AT` | `next_attempt_at` ≤ now | read |
| `ELIGIBLE` | `expires_at` ≤ now, or the policy hash differs from the receipt's | read again (a receipt is never edited; the next receipt supersedes it) |
| `REFUSED`, `NEEDS_REVIEW`, `INCOMPLETE` | `next_attempt_at` (= the receipt's `expires_at`) ≤ now, or the policy hash differs | read again |
| `POLICY_HOLD` | the policy hash differs (a value was set or changed) | read, or re-evaluate from the receipt's observations when they are within the eligibility duration (no request) |
| `KNOWN`, `DISMISSED`, `ADMITTED` | never | — |
| any, with a claim older than 10 minutes and no receipt since | as its state says | the stale claim is taken over |

`revision` increments on every write to the asset record except a sighting append. A commit whose stamp no longer matches (a dismissal or an admission landed meanwhile) writes no receipt; its observations are dropped. Sightings never change the eligibility revision and never make work due early. A chain Eric removes from `leads.chains` makes its `ELIGIBLE` assets `REFUSED` at the next policy-change read, never silently.

**Receipts.** `scout/leads/eligibility/<le_…>.json`, create-only, each with its canonical SHA-256 (`eligibility_sha256`). Each holds:

- the asset ID, its `identity` and `identity_revision`, and the asset `revision` it was committed under;
- every observation, with its source, method, the time the desk sent the request (`observed_at`) and the SHA-256 of each answer as read; dates inside an answer are data, never a clock;
- each criterion and its known/unknown basis;
- the policy values, `policy_version` (`cr-lead-policy@1`) and `policy_sha256`;
- `expires_at` = the earliest `observed_at` among the sources + `leads.eligibility_hours`. Only the desk's own send time is used; a missing, unparseable or future timestamp in an answer never extends it, and a receipt whose `expires_at` cannot be computed is `INCOMPLETE`, never `ELIGIBLE`.

When it expires, an asset that is neither admitted nor dismissed becomes due again.

**Eric's values (B4).** Preferences > Screening > "Scout leads", saved as settings `leads.*` through `validateSettingsPatch` with these bounds; none has a default, and unset means `POLICY_HOLD`:

| Setting | Type and bounds |
|---|---|
| `leads.enabled` | boolean; off until he turns it on |
| `leads.chains` | 1 to 40 chain names known to `chains.chainInfo`, stored as chain IDs |
| `leads.min_market_cap_usd` | integer, 0 to 1,000,000,000,000 |
| `leads.min_volume_24h_usd` | integer, 0 to 1,000,000,000,000 |
| `leads.max_sell_tax_pct` | number with at most two decimals, 0 to 100; 0 means no tax is accepted |
| `leads.eligibility_hours` | integer, 1 to 720 |

The policy hash is the SHA-256 of the canonical JSON of these six values. Reading Preferences writes nothing.

## 5. Stage C: admission by Eric's click, "Confirm and request research"

**The contract (B5).** Confirming a lead adds the project and requests research, exactly as confirming an intake candidate does today, with one difference: the models and routes are shown and frozen at the click, every held model is left out, Claude included, and the words say what the existing runner will do. A model whose paid API is set up gets a `queued` job that the server's existing research timer ([server.js:627](../../dashboard/server.js), `research.runDueJobs`) sends by itself within the research budget; a model without one gets a job that waits for Cowork, the connector's `pending_research` or a pasted prompt, as today. This plan adds no dispatcher and changes no runner. Manual intake (`confirmIntake`) keeps its own behavior, `intakeModels` included.

**The envelope.** `leads.envelope(ws)` is computed when the page draws and again inside the confirm's lock:

- `models`: `claude`, `chatgpt`, `gemini`, each present only when not on hold (`research.heldProviders`) and, for ChatGPT and Gemini, only when its API route is set up (`providerStatus` mode `api` or `mock`);
- `routes`: per model, `api` or `connector_or_manual`;
- `budget_scope`: the research spending limits in force (per run, daily, monthly) as the settings read them.

Empty `models` (everything on hold) disables Confirm with "Every model is on hold: nothing to request", and the server refuses `NO_MODEL` with nothing written; the lead stays `ELIGIBLE`. The button names the models: "Confirm and request research (Claude)" or "(Claude, ChatGPT)". A key set or a hold placed between the drawing and the click is a change (409, below), never a silent addition or removal.

**Where:** Review > Imports > "Scout leads". The rows are grouped:

1. **Eligible.** Each row shows:
   - logo, name, symbol and chain;
   - the short contract with a copy button;
   - MC, Vol 24h and sell tax;
   - the GoPlus checks in words;
   - the eligibility age and "Listing matched; on-chain deployment not independently checked";
   - the scout's `signal`, quoted and labeled "Scout's words".
2. **Needs review** and **Incomplete**, each with its one reason.
3. **Held**: the policy value missing.
4. **Folded:** Refused, Known and Dismissed, each with why.

**Actions**

| Action | What it does |
|---|---|
| Confirm | `POST /api/scout/leads/confirm` with one reviewed row |
| Confirm all *n* eligible | The same call with every eligible row drawn on screen |
| Dismiss | `POST /api/scout/leads/dismiss { lead_key, request_id, reason? }`. Appends a dismissal; a dismissed lead stays dismissed and a new sighting is only appended |

**What a confirm sends (B1).** `expect` is the evidence Eric reviewed, not a set of keys:

```json
{
  "request_id": "req_…",
  "expect": {
    "policy": { "version": "cr-lead-policy@1", "sha256": "…" },
    "envelope": { "models": ["claude"], "routes": { "claude": "connector_or_manual" }, "budget_scope": { … } },
    "rows": [
      { "lead_key": "<asset_id>", "eligibility_receipt_id": "le_…", "eligibility_sha256": "…", "identity_revision": 1 }
    ]
  }
}
```

`request_id` is made by the browser per click in the desk's request-ID form (`^req_[A-Za-z0-9_-]{4,80}$`). The selection is exactly `rows`: a single-row confirm names one row and is compared with that row only, never with the whole eligible list; "Confirm all" names the rows drawn. The server never adds a row.

**What a confirm does, inside one lock (B1, B2)**

1. **Replay check.** If `scout/leads/batches/<request_id>.json` exists: the same `expect` returns that batch with each admission's current state (`unchanged`), then completes any pending effects below; a different `expect` is **409 `CONFLICT`**, nothing written.
2. **Compare every row with the current state**, and collect every difference: the asset is missing or its identity check fails; its state is not `ELIGIBLE`; its current receipt's ID or SHA-256 differs from the one reviewed; its `identity_revision` differs; the receipt has expired; it is already admitted or dismissed; the current policy version or hash differs; the recomputed envelope differs from the reviewed one (a model, a route or the budget scope). Any difference is **409 `CHANGED`**, naming each row and each field that differs, with nothing written. Eligible leads that arrived since the page was drawn are not a difference: they are not in `rows`, they are not admitted, and the answer names them as `since_shown: { eligible_new: n }` so the page can say "n new eligible leads arrived; look again".
3. **Write the batch and the admissions**, in the same verified operation: `scout/leads/batches/<request_id>.json` (create-only: the reviewed `expect`, the time, "confirmed by Eric, a batch of *n*", the admission IDs) and `scout/leads/admissions/<admission_id>.json` per row (written once under its ID; after that only its effects' progress, errors and words are recorded, through `updateAdmission`, and its frozen fields, the lead key, the receipt, the envelope, the effect keys and the deadline, never change), where `admission_id` = `la_` + the first 14 hex characters of the SHA-256 of `stableStringify([request_id, lead_key])`, so a replay derives the same IDs. Each admission holds the lead key, the reviewed receipt ID and SHA-256, the frozen envelope copied in full, `start_deadline` = now + 24 hours, and `effects: { intake: "pending", project: "pending", research: "pending" }`. The asset becomes `ADMITTED` (its `revision` increments, which drops any claim in flight).

**The effects, after the lock, per admission, in order and independently (B2).** Each is one `runOp` with its own stable key, so a crash after any commit and before the admission is linked replays the original result:

| Effect | Key (`runOp` `idempotencyKey`) | Payload hash | Result linked |
|---|---|---|---|
| intake request | `admission:<admission_id>#intake` | SHA-256 of the canonical request | `inbox/intake/` ID |
| project | `admission:<admission_id>#project` | SHA-256 of `{ admission_id, input }` | `project_id` |
| research run | `admission:<admission_id>#research` | SHA-256 of `{ admission_id, project_id, providers, horizon }` | `run_id` |

`projects.addProject(ws, input, { idempotency })` and `research.createRun(ws, { …, idempotency })` gain that optional third argument and pass it to `runOp`; without it their behavior is byte-for-byte today's. An explicit key always wins over `ws._idem`'s `requestId#type`, so two leads of one batch never share a key. A different payload under the same key is `IDEMPOTENCY_CONFLICT`, never a second effect. Where `addProject` answers `exists` (the same contract already in the records) the admission links that project and says so; where `createRun` answers `exists` (a run with the same providers and horizon started in the last ten minutes, by Eric's hand) the admission links that run and says `run_basis: "existing_recent"`. In every case there is one project and one run per admission, and `providers` is the frozen envelope's `models`, never re-read from the settings at recovery.

The answer is `{ status: "admitted", batch, admissions: [{ admission_id, lead_key, project_id, run_id, effects }], since_shown }`, also when an effect failed: the failure is written on the admission in words, the other admissions are untouched and visible, and nothing claims the whole operation wrote nothing.

**Recovery.** Three ways finish what a crash left, each idempotent: a replay of the same request; "Complete" on the admission's row in Review > Imports; and the `leads` job, which at the start of every turn, under the workspace lock, completes every admission with a pending effect. Before starting an effect that has not committed, the worker rechecks the frozen envelope (the providers are the envelope's; a hold placed since does not add or remove one, since the run's `providers` are explicit and the runner's own hold keeps a held model's job unsent) and `start_deadline`. Past the deadline an uncommitted effect is not started: the admission reads `lapsed`, naming what was done ("Project added; research not requested: the confirmation lapsed at …"), and the row offers "Request research" as a new admission on the existing project, with its own request ID and a fresh envelope. A committed effect is never undone by recovery.

**Shared code.** The body of `confirmIntake` is split into one internal `admitListing(ws, listing, { models, evidence_note, utterance, idempotency })`. `confirmIntake` keeps its words and behavior, `intakeModels` included. The scout admission writes its own words:

> Listed by Grok Scout (delivery …); contract matched on CoinGecko at …; eligible under cr-lead-eligibility@1 (receipt …, policy …); confirmed by Eric in a batch of n (request …); research requested from Claude.

The scout's `signal` and URLs never enter `input.instructions`, a research prompt or a ticket prompt. They stay as provenance on the lead.

**After admission.** A `queued` API job is sent by the existing research timer within the budget; a connector or manual job waits for `/pilot-run`, the connector's `pending_research`, a pasted prompt, or "Send waiting jobs to their APIs" once a key is set. Then the queue moves to `ticket` as today. Nothing new dispatches; what dispatches is named in the admission and on the row.

## 6. Stage E: ChatGPT's challenge, and what happens on each failure

**Contract**

- **Prompt:** `cr-ticket-challenge-prompt@1` (`templates/tickets/challenge-prompt.v1.md`, pinned in `templates/tickets/LOCK.json`).
- **Output:** `cr.ticket-challenge.v1` (`templates/schemas/ticket-challenge.v1.schema.json`).

**What it freezes when opened.** The challenged ticket receipt's ID and SHA-256, its text SHA-256, its packet's path and SHA-256 (the same file), and Agent 1's report SHA-256, in `target.json`. All are checked on every handoff, save and read (`INTEGRITY`, 409).

**What ChatGPT returns (B7)**

- for each of the four tests (`mercenary_emissions`, `tax_revenue`, `exit_slippage`, `unverified_claims`): `agree`, `disagree` or `cannot_assess`, with its reason and sources;
- a critique of the trade plan in words;
- `challenge_verdict`: `concur`, `material_objection`, `fatal_objection` or `insufficient_evidence`, with a required `verdict_reason`;
- its sources.

The verdict must fit the tests, or the save is refused field by field: `concur` needs at least one `agree` and no `disagree`; `material_objection` and `fatal_objection` need at least one `disagree`; `insufficient_evidence` is allowed with any mix and is the only verdict allowed when all four tests are `cannot_assess`. The desk shows "n of 4 tests assessed" in words and computes no coverage score, average or majority. A missing or unknown test is never read as agreement, as a refusal of the ticket or as a zero.

The schema has **no** proposal type, size, risk, grade or price field.

**Records (B8).** The ticket pattern ([tickets.js:1–14](../../dashboard/core/tickets.js)): frozen inputs and receipts are create-only; the job and the working draft are operational records.

| File | Kind |
|---|---|
| `projects/<id>/tickets/challenges/<tc_…>/target.json` | create-only: the frozen bindings above and the prompt's pin |
| `projects/<id>/tickets/challenges/<tc_…>/prompt.md` | create-only |
| `projects/<id>/tickets/challenges/<tc_…>/challenge.json` | the job: `state` (`waiting`, `running`, `saved`), model, draft stamp, note; written through `runOp`, survives a restart |
| `projects/<id>/tickets/challenges/<tc_…>/drafts/challenger.md` | the working draft, overwritten by each save that is refused; never a receipt |
| `projects/<id>/tickets/challenge-receipts/<tcr_…>.{json,md}` | create-only. The same text again is `unchanged` with the same receipt; a different text is a revision with `{ kind, note }` (`revisions.REVISION_KINDS`), kept beside the first, which is never rewritten |

That folder is apart from `receipts/`, so neither `paper-trader.js` nor any other reader of `receipts/` ever meets one. On every read (the card's row, the GET route) the receipt's `.md` is hashed against its `.json` and its `target` against the ticket receipt as it stands on disk; a mismatch shows "Challenge not shown: its record does not match the ticket receipt" and no verdict.

**Connector tools (B6).** `pending_challenges` (read-only, in `READ_ONLY_TOOLS`), `start_challenge` and `save_challenge` work for ChatGPT only (`ctx.me === 'chatgpt'`), and each one carries the existing protections:

- **The same model is refused.** Claude is refused, because a challenge by the same model is what this exists to avoid.
- **No role.** Gemini is refused as `no_role`, held or not; it is never a challenger.
- **The hold.** ChatGPT on hold (`research.heldProviders`): `pending_challenges` answers `on_hold` with no item, as `pending_research` does ([mcp.js:1308](../../dashboard/mcp.js)); `start_challenge` and `save_challenge` refuse.
- **First-pass independence.** `research.guardIndependence(ws, project_id, ctx, 'challenge the ticket')` runs at the start of `start_challenge` and `save_challenge`, and `pending_challenges` lists a project where ChatGPT's own research is open with `blocked: "your own research on this project is open (run …)"`, never as `next`, and without prompt, target or draft. The challenge waits until ChatGPT's own report is saved; the PM card never waits for it.
- **Read-only connections** refuse the two write tools as they refuse every write tool.
- No model-facing view carries a challenge's conclusions in this plan: `get_ticket`'s answer is unchanged, and a challenge is read on the card and the GET route only.
- `save_challenge` refuses an invalid block field by field and keeps the text as the draft.

**On the PM Decision Card.** One row, "ChatGPT challenge": the verdict in words with "n of 4 tests assessed", and a chip per test with three states, agree, disagree or cannot assess.

- Without one, the row says why: not started, ChatGPT's own research open, draft only, save refused with the field named, insufficient evidence with its reason, integrity check failed, or model on hold.
- One that arrives after Eric decided reads "arrived after your decision" with its time.
- It never changes the ticket, its status, the gate, the size, the decision or the book.
- Approve is not gated on it. It is **optional** in this plan; a required mode is a later decision of Eric's.

### Failures

There is one rule. A failure leaves a named absence. Nothing stands in for a missing step: no model replaces another, and no missing step becomes a pass, a $0 or an agreement.

| Failure | State shown | What still proceeds | Recovery |
|---|---|---|---|
| Grok sends nothing | Research > Scout: "No leads delivered today" | Everything; nothing waits on leads | Grok's next run |
| Ack lost after the save | none (the sender retries) | n/a | Same `delivery_id` → same receipt |
| One bad row | Row: "Refused at intake: address does not fit base" | The other rows | none needed |
| Disk full or unverified save | 503 to the sender, Doctor's disk line | Reads of saved records | Free space; the sender retries with the same ID |
| CoinGecko or GoPlus down, 429 | Lead: "Retry at 14:30 (GoPlus rate limit)" | The other leads, every other job | The next due turn |
| The turn's budget used | Lead: "Next turn (this turn's request budget was used)" | The other jobs | The next turn, which takes it first |
| A source answered without a critical fact | Lead: "Incomplete: GoPlus gave no sell tax" | The other leads | Read again after the eligibility duration |
| A value of Eric's unset | Lead: "Held: minimum volume not set" | Nothing promotes | Eric sets it |
| Listing conflict | Lead: "Needs review: contract maps to two listings" | The other leads | Eric dismisses it, or adds the project by the existing intake |
| The page is stale at the click | 409 `CHANGED`: "Receipt for X changed (le_… → le_…); policy changed (max sell tax)" | Nothing written | Look again, confirm again |
| Every model on hold | Confirm disabled: "Every model is on hold" | Reads | Lift a hold |
| Crash mid-admission | Admission: "Completing: research run not yet made" | The other admissions | A replay, "Complete", or the next `leads` turn finishes it once |
| An effect not started within 24 hours | Admission: "Project added; research not requested: the confirmation lapsed at …" | The project, as added | "Request research" (a new admission) |
| No route for Agent 1 | Run: "Waiting for Claude" (existing words) | Leads and tickets elsewhere | `/pilot-run`, the connector, or a key |
| Prosecutor fails (timeout, bad block) | Queue step `ticket_failed`: "Prosecutor: save refused, proposal.entry_zone missing" | Every other project | Run the Prosecutor again; a new attempt, with the draft kept |
| ChatGPT never challenges | Card: "No ChatGPT challenge: not started" | Eric decides as today | Optional |
| ChatGPT's own research is open | Card: "No ChatGPT challenge yet: its own research on this project is open" | Eric decides as today | ChatGPT saves its report, then challenges |
| ChatGPT's block is invalid | Card: "ChatGPT challenge refused: tests.exit_slippage missing" | Eric decides as today | ChatGPT saves again; the draft is kept |
| ChatGPT cannot assess | Card: "ChatGPT: insufficient evidence (0 of 4 tests assessed): …" | Eric decides as today | none; it is a complete, advisory answer |
| A challenge's record does not match the ticket | Card: "Challenge not shown: its record does not match the ticket receipt" | Eric decides as today | none; the records are kept for inspection |
| ChatGPT is late | Card: "Arrived after your decision, 09:12" | The decision stands | Eric may Reopen as today |
| A model held, or a restored copy | Existing words | Reads | Lift the hold; `restored-copy release` |

`ticket_failed` is the one new state in the existing queue (`tickets.js` queue and `mcp.js` `autonomous_pilot_queue`). Today a failed Prosecutor leaves the queue repeating `ticket` with no reason.

## 7. Eric's decisions, before PR 2

| | Decision | Recommended |
|---|---|---|
| L1 | Let scout leads become research, only through his confirm in Stage C. This changes the rule "a scout item never becomes research"; scout briefs stay reading only | Yes, bounded so |
| L2 | The values in section 4 (chains, floors, sell tax, eligibility age) | His values; nothing promotes while unset |
| L3 | Batch confirm or a standing admission policy | Batch confirm now; a policy later, if wanted, as its own decision |
| L4 | ChatGPT's role | Advisory challenge through the connector. Ticket v2 (ChatGPT as author) and an API route wait |
| L5 | Where this goes in line | PR 1 now, since it is small and fixes the existing route. PRs 2–6 after the trader's remaining `[P]` items in `OVERNIGHT_LOG.md` and audit PR 8's checks, since funding the paper book is nearer Track 2's outcome |
| L6 | What a confirm authorizes: "Confirm and request research" (the models and routes frozen at the click, an API job sent by the existing runner), or "Confirm identity only" (no job until a later explicit request) | "Confirm and request research": it is what confirming an intake candidate does today, and the click's words say exactly what will run |

The added xAI cost of L1 is one more Responses call per scout run, for the leads prompt, at `cr-scout-prices@1`. xAI's Usage page stays the bill.

## 8. Execution plan

Each PR is one supervised task on its own branch. Each passes `node dashboard/cli.js test`, plus `npm run ui:build` and `npm --prefix dashboard/web run check` where the UI changes (the root `package.json` has no `check` script; a failed command invocation is not test coverage), and goes to a pull request Eric merges. **No PR touches a protected file** (`paper.js`, `paper-trader.js`, `trade-risk.js`, `decimal.js`), `cr.ticket.v1`, `cr-ticket-prompt@1` or the paper adapter. Every PR's tests use temporary fictional workspaces and a fake fetch; none asks a provider or a model for anything.

**PR 1. The front-door lock, key first.**

- **Files:** `core/scout.js` (`makeScoutRoute` `refused`: `accepted` before `locked`) and `tests/scout-ingest.test.js`, whose lock test at line 190 today asserts the opposite ("the right key included" → 429) and is rewritten.
- **Accept when:** eleven wrong keys and then the right one still delivers (200 on the key check, the brief's usual answer on POST); eleven wrong keys and another wrong one gives 429 `LOCKED`; a wrong key while locked is not counted again, so the window still ends 15 minutes after the tenth failure; a missing key configuration still answers 404 first; `/api/ingest/ping` and every other brief test are unchanged.
- **Not in it:** per-source quotas, a durable counter, or any new infrastructure.

**PR 2. Lead delivery and status.**

- **Files:**
  - new `core/leads.js` (`assetId`, identity checks, envelope and row checks, records, `ingest`, status);
  - the front-door route beside `makeScoutRoute`;
  - `templates/schemas/scout-leads.v1.schema.json`;
  - `cli scout leads list|status`;
  - new `tests/scout-leads.test.js`.
- **Accept when:**
  - the 202 → lost ack → same-ID replay gives the same receipt and one asset record;
  - an altered body gives 409 with the original kept;
  - one bad row in ten leaves nine accepted, with the tenth's reasons recorded; a row that is not an object is refused as a row, and the operation does not throw;
  - two rows with the same identity tuple in one delivery: the second is `refused_at_intake: duplicate of row i`;
  - `generated_at` more than 24 hours from receipt refuses the envelope;
  - a replay resolves after the sixth delivery of the day; the seventh new delivery is 429; the brief's count is untouched;
  - an injected save failure answers 503 and saves nothing;
  - the same address text on two networks makes two assets;
  - the audit's two base58 fixtures, differing only in one letter's case, make two asset files on this Windows disk;
  - `0xAbC…` and `0xabc…` on one chain make one asset; `bsc` and `bnb-chain` make one asset;
  - a record whose stored identity does not hash to its filename is refused as `INTEGRITY` and no other record is returned;
  - a status GET writes nothing;
  - a fake-provider call count is zero for the route and every GET;
  - the existing scout brief tests are unchanged; `scout/leads` is in the backup and offsite package.
- **Not in it:** eligibility, the UI, the sender.

**PR 3. The sender.**

- **Files:**
  - `templates/scout/leads-prompt.v1.md`, pinned in `LOCK.json` as `cr-scout-leads-prompt@1`; `scout-prompt.v1.md`, `scout.js` `PROMPTS` and `LANES` untouched;
  - `scripts/grok-cron.js`, which makes a fifth xAI call for leads when the desk accepts the key and posts the result with `gh-<run>-<attempt>`, reusing the ID on its own retry;
  - its tests.
- **Accept when:** the brief request and its POST are byte-identical to today's with leads on and with leads off; `--dry-run` prints both requests and the added estimated cost, and sends nothing; the retry reuses the ID; a 409 is reported, never resent under a new ID; a refused leads delivery never blocks the brief.
- **Not in it:** `SCOUT_ENABLED` and the xAI credits, which stay Eric's.

**PR 4. Eligibility.**

- **Files:**
  - `core/leads.js` (the worker: `isDue`, `dueAssets`, the turn, claims, receipts);
  - job `leads` in `core/jobs.js`, and `HOSTED_TIMER_JOBS` exported from `jobs.js` and used by `server.js`;
  - `screening.screenAddress(chain, address, { turn })` (bounded read, shared gate, token and budget);
  - the CoinGecko contract read through `intake.cgGet` with the turn's remaining time;
  - settings `leads.*` in `server.js` `validateSettingsPatch`, with section 4's bounds;
  - Preferences > Screening > Scout leads;
  - `tests/scout-leads-eligibility.test.js`.
- **Accept when:**
  - each state in section 4 is reached from a fixture, `INCOMPLETE` included (a GoPlus answer without `sell_tax`; a CoinGecko answer without the chain's platform entry);
  - `jobs.runJobs(ws, HOSTED_TIMER_JOBS, { onlyDue: true })` with a fake clock runs `leads`, not only the CLI; `leads` is in `HOSTED_TIMER_JOBS`;
  - an expired receipt and a changed policy each make the asset due; a sighting alone does not;
  - a GoPlus 429 gives `RETRY_AT` at the gate's time, the phase ends, and the next job still runs;
  - five due leads per turn and ten requests at most, the token request and retries counted; no request is sent after the counter or the deadline is exhausted (a fake fetch that stalls proves the deadline cuts the attempt, the retry delay and the body read);
  - a claimed asset left by an exhausted budget is released with `next_attempt_at = now` and read first next turn;
  - a claim older than 10 minutes is taken over; a commit after a dismissal writes no receipt;
  - a missing GoPlus tax field is unknown, never 0; `"0"` is 0 and passes a limit of 0;
  - an answer with a future or unparseable timestamp gets `expires_at` from the desk's send time only;
  - an unset floor is `POLICY_HOLD`; a chain outside `leads.chains` is `REFUSED`; each setting refuses a value outside its bounds;
  - two runners (two workspaces on one folder) do one turn, not two (the lease);
  - the job is held in a restored copy;
  - reading Preferences writes nothing.
- **Not in it:** RPC or bytecode reads, or Solana account decoding.

**PR 5. Admission.**

- **Files:**
  - `core/intake.js` (`admitListing`, with `confirmIntake` keeping its behavior);
  - `core/projects.js` `addProject` and `core/research.js` `createRun`: an optional `idempotency` argument passed to `runOp`, default none;
  - `core/leads.js` (`envelope`, `confirmLeads`, `dismissLead`, `completeAdmission`, the worker's recovery step);
  - `POST /api/scout/leads/confirm` and `/dismiss`;
  - Review > Imports > Scout leads (`web/src/views/review/Review.jsx`, `review-model.js`), with the bundle rebuilt;
  - `tests/scout-leads-admission.test.js`, `tests/intake.test.js`, `tests/projects.test.js` and `tests/research.test.js` (the new argument's default changes nothing).
- **Accept when:**
  - a changed receipt under an unchanged key (R1 → R2) gives 409 `CHANGED` naming the row and the receipt, nothing written;
  - a changed policy value under the same policy version gives 409; an expired receipt gives 409; a hold placed or a key set between the drawing and the click gives 409 naming the envelope;
  - a single-row confirm among several eligible leads admits that row only and is not compared with the others; an unrelated eligible arrival is not a 409 and is reported as `since_shown`, never admitted;
  - two leads in one batch give two projects and two runs with distinct effect keys; the same request with altered content gives 409 `CONFLICT`;
  - a crash injected after the intake request, after the project and after the run, then a replay, gives one project and one run with the original IDs; so does the next `leads` turn without a replay; a replay after the run completed, and one eleven minutes later, create no new run;
  - one failed admission leaves the others admitted and visible, and the answer carries their receipts;
  - an effect not started within 24 hours reads `lapsed` and is not started; "Request research" makes a new admission on the existing project;
  - Claude held: Claude is absent from the envelope and the run; ChatGPT held: likewise; every model held: `NO_MODEL`, nothing written; a model with an API route gets a `queued` job that `research.hasDueWork` reports due, a model without one gets an `unconfigured` job that waits;
  - the evidence note names the delivery, the receipt, the policy and the batch, never "chosen and confirmed by Eric" on its own;
  - `KNOWN` and archived leads are never re-added;
  - the scout's `signal` is absent from the frozen research prompt;
  - the existing intake, project and research tests are unchanged;
  - `npm --prefix dashboard/web run check` passes at 1440 and 390.
- **Not in it:** automatic admission.

**PR 6. ChatGPT's challenge.**

- **Files:**
  - `templates/tickets/challenge-prompt.v1.md` and `LOCK.json`;
  - `templates/schemas/ticket-challenge.v1.schema.json`;
  - new `core/ticket-challenges.js`;
  - the three connector tools in `mcp.js`, `pending_challenges` in `READ_ONLY_TOOLS`;
  - `GET /api/projects/<id>/tickets/challenges`;
  - the card row in `PMDecisionCard.jsx`, with the bundle rebuilt;
  - `ticket_failed` in the queue;
  - `tests/ticket-challenges.test.js`.
- **Accept when:**
  - the frozen hashes match the challenged receipt and its packet byte for byte;
  - an altered packet or receipt is `INTEGRITY` with nothing written; an altered saved challenge shows no verdict on the card or the route;
  - Claude is refused; Gemini is `no_role`, held or not; held ChatGPT gets `on_hold` from `pending_challenges` and refusals from the other two;
  - with ChatGPT's own research open on the project, `start_challenge` and `save_challenge` are refused with no job or receipt written, and `pending_challenges` lists it as `blocked` without prompt, target or draft; after its report is saved, the challenge opens;
  - a read-only connection cannot call the two write tools;
  - an invalid block is refused field by field with the text kept as the draft; a corrected second save resumes from it; the same final text again is `unchanged` with one receipt; a different final text needs a revision reason and keeps the first receipt;
  - all four tests `cannot_assess` with `concur` is refused; with `insufficient_evidence` it is saved and the card reads "0 of 4 tests assessed"; `concur` with one `disagree` is refused; nothing converts a missing or unknown test into agreement, a refusal or a zero;
  - a restart keeps the job's state and draft;
  - a challenge saved after a decision shows "arrived after your decision" and changes neither the decision nor any `trader-desk` output;
  - `paper-trader.js` reads exactly what it read before (`trader-boundary.test.js` unchanged and passing);
  - `get_ticket`'s answer is unchanged;
  - the card's row reads in words in both themes;
  - `ticket_failed` names the refused field.
- **Not in it:** an API route, a required mode, ticket v2.

**Integration test, once PR 6 is in.** One fictional end-to-end run in `tests/scout-leads-pipeline.test.js`: delivery → eligibility (fake fetch) → reviewed batch → durable admission → the run's jobs as the frozen envelope says → a v1 ticket read by the unchanged trader boundary → an optional challenge, with a restart injected between each step and an old reader (`paper-trader.js`'s receipt read) run over the result. Passing it establishes the code, not the deployed configuration, the production records or provider access.

**When built, the documents change with the code.**

- The CLAUDE.md scout line.
- DESK_STATE's "ChatGPT and Gemini have no ticket role", which becomes: "ChatGPT challenges; Claude prosecutes".
- The comments at the top of `intake.js`, `scout.js` and `jobs.js`.

## 9. Not in this plan

- ChatGPT as the ticket's author (`cr.ticket.v2`, receipt v2). It would need the paper boundary's readers changed first, under protected review.
- Automatic failover between models, or a required mode for the challenge.
- A standing admission policy, or admission without Eric's click.
- RPC, bytecode or chain-history reads for leads, or any anti-spoofing guarantee beyond "listing matched".
- A new scheduler, worker service, queue, database or wake-up mechanism.
- An unattended ChatGPT route through the research runner.
- Any change to sizing, the gate, the trader or the hard limits.
- Overwriting an existing verified project identity from a new sighting.

## 10. Revision 2: how each blocker of the final audit is resolved

| Blocker | Resolved in | The rule, in one line | Acceptance lives in |
|---|---|---|---|
| B1 confirmation binds keys, not evidence | §5 "What a confirm sends", "inside one lock" | `expect` carries each row's receipt ID and SHA-256, identity revision, the policy version and hash and the frozen envelope; any difference is 409 naming each field; a single row is compared with itself only; unrelated arrivals are reported, never admitted; after admissions commit, a later failure returns their receipts | PR 5 |
| B2 exactly-once needs stable effect keys | §5 "The effects", "Recovery" | one create-only batch and one admission per lead before any effect; `admission:<id>#intake|project|research` as `runOp` keys with payload hashes, passed into `addProject` and `createRun`; replay, "Complete" and the `leads` turn finish pending effects; the envelope and a 24-hour start deadline are rechecked before an uncommitted effect | PR 5 |
| B3 asset filenames unsafe on Windows | §3 "The identity tuple", "Records" | `asset_id` = digest of `[chain_id, address_key]`; the identity kept in full inside and checked against the filename on every read; the same tuple for row deduplication, lookup and admission | PR 2 |
| B4 worker trigger, recovery and bounds | §4 "Registration", "One turn", "Due, and every transition", "Receipts", "Eric's values" | `leads` in the exported `HOSTED_TIMER_JOBS`, its own lease; one due predicate and transition table with claim reclamation; one monotonic 20-second deadline and 10-request counter shared by token, attempts, retries and body reads; `INCOMPLETE` for a missing critical fact; finite bounds per setting; expiry from the desk's send time only | PR 4 |
| B5 hold and dispatch promises | §5 "The contract", "The envelope", "After admission"; §7 L6 | "Confirm and request research": every held model left out, Claude included; models and routes frozen at the click and never re-derived; `NO_MODEL` when none remains; the words say an API job is sent by the existing runner | PR 5 |
| B6 challenge handoffs bypass the first-pass guard | §6 "Connector tools" | `guardIndependence` on `start_challenge` and `save_challenge`; `pending_challenges` lists a blocked project without content; ChatGPT's hold and the read-only rule applied; Gemini `no_role`; no model-facing view carries a challenge's conclusions | PR 6 |
| B7 no honest all-unknown verdict | §6 "What ChatGPT returns", the card | `insufficient_evidence` with a reason; the verdict must fit the tests; three chip states; "n of 4 assessed" in words, no score | PR 6 |
| B8 create-only conflicts with resume | §6 "Records" | the ticket pattern: `target.json`, `prompt.md` and receipts create-only; `challenge.json` and `drafts/challenger.md` operational; revisions keep the first receipt; every read verifies against the pinned target | PR 6 |

**The audit's smaller clarifications.**

1. The check command is `npm --prefix dashboard/web run check` (§8).
2. The brief stays on `cr-scout-prompt@1`; leads have their own prompt, `cr-scout-leads-prompt@1`, and PR 3 proves the brief request unchanged (§3, PR 3).
3. Envelope timestamps (±24 hours), per-row limits, the separate daily quota, and `source` (the key's principal) apart from `model` (the sender's declaration) are defined in §3.
4. Every input is named with its full SHA-256 above; the superseded README stays as history.

**What this revision does not claim.** It is a plan. A follow-up design review can clear it once these rules read unambiguously; implementation acceptance is the integration test in §8 and each PR's list. Neither an approved plan nor a passing suite establishes the deployed configuration, production records or provider access, and no investment or accounting guarantee follows from any of it.

**PR 1 readiness, checked on 2026-10-29.** The fix is specified to the line (§3 and PR 1): in `makeScoutRoute`'s `refused`, test `accepted` before `locked`, count only refusals, and answer 429 without counting while locked. No branch or pull request for it exists yet (the last scout branch, `claude/grok-scout`, merged as PR #30). The existing test at `tests/scout-ingest.test.js:190` asserts today's behavior and must be rewritten with it. It touches no protected file, needs no decision from section 7, and waits only for Eric's word.
