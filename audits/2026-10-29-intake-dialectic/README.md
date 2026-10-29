# Scout intake and a cross-model Prosecutor (2026-10-29)

Claude's answer to Eric's directive "Multi-model dialectic & intake topology" (pasted 2026-10-29). It covers three things: the Grok Scout feeding candidate tokens into the desk, ChatGPT as Agent 2 (the Prosecutor), and how either one fails closed.

**Superseded where they differ by [PLAN.md](PLAN.md)** (2026-10-29, after Codex's red-team). Withdrawn here: ticket v2 and receipt v2, whole-delivery refusal, "the only way in", "clamps", and "on the branch only".

**Status: proposal.** Nothing is built. Three decisions are Eric's (last section). Every claim below was checked against `main` plus `claude/p-engine-settlement` on 2026-10-29.

## Where the directive and the repository differ

- **The law labels.** `docs/CONSTITUTION.md` Law 1 is the Sovereign Architect Principle and Law 2 is No Meta-Machines. Deterministic core versus cognitive shell is Law 5.
- **The scout carries no token candidates.**
  - Its lanes are `agents`, `onchain`, `desk` and `security`, and they cover tools, repositories and write-ups.
  - A scout item has no chain or contract field ([scout.js](../../dashboard/core/scout.js) `ITEM_FIELDS`).
  - Eric's rule says a scout item "never becomes backlog, research, a ticket or a prompt". Feeding the scout into intake reverses that rule.
- **`screening.js` is not an intake.**
  - It reads GoPlus for the contracts of a verified, active project identity.
  - The only way a project enters the desk is [intake.js](../../dashboard/core/intake.js) `confirmIntake`: Eric confirms one CoinGecko candidate, and that creates the project and its research run.
- **`cr.ticket.v1` is Claude only.**
  - [ticket.v1.schema.json](../../templates/schemas/ticket.v1.schema.json) has `"model": { "const": "claude" }`.
  - Prompt @1 tells the model the report "was written by another Claude session" ([ticket-prompt.v1.md](../../templates/tickets/ticket-prompt.v1.md)).
  - The receipt writes `provider: 'claude'` ([tickets.js](../../dashboard/core/tickets.js) `saveTicket`).
  - `start_ticket` and `save_ticket` refuse any connection that is not Claude's ([mcp.js](../../dashboard/mcp.js)).
  - So a ChatGPT Prosecutor needs new versions. v1 is never edited.
- **$2,000 is not a ceiling.** It is one size on the exit-measurement ladder (`forensics.preferences` `exit_sizes_usd`, read by `tickets.js` `exitSizesOf`). Risk is $500 or $250 under `cr-ticket-sizing@4`. Since D11, the trader's cap is the largest size whose cost is known in full, within the ticket's frozen exit-cost limit.
- **Independent authorship, not independent evidence.**
  - The Prosecutor reads Agent 1's report, fenced into its frozen prompt, by design.
  - What a different vendor adds is independence of authorship and of context.
  - That is stronger than today's isolation (`cr-pilot-isolation@1`). On the online route, the only boundary between the two agents is the tool list in each agent file.
- **Nothing produces tickets each morning.** The pilot runs one project when Eric runs `/pilot-run` or `npm run pilot`. Putting it on a schedule is scheduler work, which the repository's rules say is not to be proposed.
- **`cr-paper@3`** (the settlement gate, `cdf4664`) is on `claude/p-engine-settlement` only, not on `main`.

**Cost.** Today both agents run on Eric's Claude subscription. An unattended ChatGPT Prosecutor means:

- a paid OpenAI API call for every ticket;
- Eric's OpenAI key in Render.

The free alternative is the ChatGPT app with the connector, which Eric opens himself.

## 1. Intake: scout candidates into the desk

**Transport**

- Reuse the scout's front door, which already has:
  - `DESK_INGEST_KEY` (at least 32 characters, compared in constant time);
  - the lock after ten refused keys;
  - JSON only, no browser Origin, 64 KB at most, six deliveries a day.
- Add one route, `POST /api/ingest/scout-candidates`, under a new frozen prompt version, `cr-scout-prompt@2`.
- The existing brief route (`cr.scout-brief.v1`) stays as it is.
- Eric's existing scout workflow sends it. No new scheduler is added.

**Payload**, `cr.scout-candidates.v1`, at most 10 candidates:

```json
{
  "schema": "cr.scout-candidates.v1",
  "prompt_version": "cr-scout-prompt@2",
  "generated_at": "ISO-8601 UTC",
  "candidates": [
    {
      "chain": "a chain the desk knows (core/chains.js)",
      "contract": "the token contract, validated for its chain",
      "coingecko_id": "string or null",
      "signal": "one plain line, at most 280 characters",
      "urls": ["https://…, at most 5"]
    }
  ]
}
```

- A candidate is identified by its contract only. There is no name or ticker field, because tickers are not unique.
- Every field is checked as `scout.js` checks a brief. One bad field refuses the whole delivery and nothing is saved.
- A delivery is kept create-only under `scout/candidates/<sc_…>.json` and backed up with `scout/`. The route writes nothing else.

**Eligibility** (new `core/candidates.js`, `cr-candidate-eligibility@1`). It is deterministic and calls no model. Each candidate ends as `eligible`, `refused` (with reasons) or `unknown` (with a reason):

1. **Identity.** CoinGecko's `detail_platforms` lists that exact contract on that chain. If a supplied `coingecko_id` disagrees, the candidate is refused.
2. **Not known already.** It is not an active or archived project. Otherwise it is refused as `known`, with the project named.
3. **Contract screen.** GoPlus screens it through `screening.js`'s existing lease, rate-limit gate, backoff and monthly budget.
   - This needs one new export from `screening.js`, to screen one address that is not yet a project.
   - A honeypot, cannot-sell, or a sell tax above Eric's limit refuses it.
4. **Floors.** Market cap and 24-hour volume must clear floors Eric sets. While a floor is unset, every candidate is refused, because unknown is never 0.

Any read that fails or does not parse makes the candidate `unknown`, which is never `eligible`.

**Handoff**

- An eligible candidate becomes an intake request in `inbox/intake/` with `source: 'scout'` and status `needs_confirmation`, its CoinGecko candidate prefilled.
- It shows under Review > Imports.
- Eric's confirm is the existing `confirmIntake`, which creates the project and Claude's research run.
- The scout's `signal` and URLs never enter `input.instructions` or any frozen prompt. They are web content that a token's team could plant; the Researcher does its own research.

**Never.** The intake adds nothing to the watchlist, starts no research, opens no ticket and calls no model.

## 2. Cross-model dispatch: ChatGPT as the Prosecutor

**New versions** (all published new; v1 is unchanged and v1 tickets keep their versions):

- `cr-ticket-prompt@2`: one text for every model, as the research prompt is. It is pinned in `templates/tickets/LOCK.json`.
- A frozen ChatGPT execution note for tickets, after `cr-execution-chatgpt@2`. It adds no scope or rule.
- `cr.ticket.v2`: `model` is one of `claude` and `chatgpt`.
- `cr.ticket-receipt.v2`: `model.provider` comes from the ticket job.

**Who prosecutes**

- The choice is Eric's setting `tickets.prosecutor` (`claude` or `chatgpt`).
- It is frozen into `ticket.json` when `start_ticket` opens the job (`versions.prosecutor`).
- The connector's fixed Claude check becomes: the calling connection's model must equal the job's frozen Prosecutor.

**Hashing**

- The packet (`cr.ticket-packet.v1`) is unchanged and byte-identical whichever model prosecutes. The packet SHA-256 and `researcher_report_sha256` are the same for either Prosecutor.
- The prompt SHA-256, the text SHA-256 and the receipt ID belong to each job and are never shared.

**Routes for ChatGPT**

- **Attended, free.** The ChatGPT app with the connector: `pending_tickets`, `start_ticket`, `save_ticket`, as Claude uses them today.
- **Unattended, paid.** The existing runner in `research.js`, which already has:
  - budget reservation and `budget_wait`;
  - the `research.timeout_seconds` deadline;
  - no automatic retry of a billed attempt, and no resend of an uncertain one.

  No second model caller is built.

**Unchanged**

- The desk's gate sizes every ticket.
- `trade-risk.js` clamps the trade plan's stop and target.
- `agent_disagreement` keeps the Researcher's figure and the Prosecutor's side by side, never averaged.

**Cheaper alternative.** ChatGPT challenges Claude's saved ticket as its own receipt, after `cr-forensic-challenge@1`. That is a second opinion without paying per ticket, but ChatGPT would not set the trade plan.

## 3. Failure isolation

**The scout fails** (no delivery, a timeout, or a bad schema):

- The whole delivery is refused and nothing is saved. `scout.js` already works this way for briefs.
- Earlier candidates are left as they are, and nothing retries by itself.
- A candidate whose reads fail stays `unknown` and is never promoted.

**ChatGPT fails**

- **Timeout or no answer.** On the API route the job reads Check, and a billed attempt is never resent. On the connector route the job stays waiting, with its draft.
- **Invalid block.** `save_ticket` refuses it field by field, writes nothing, and keeps the text as `drafts/prosecutor.md`.
- **Model on hold.** It is never retried, as with research.
- **In every case** there is no receipt, so:
  - no PM Decision Card;
  - no granted risk;
  - no paper intent.

  A missing ticket never counts as a pass or a $0 ticket.

**No automatic fallback to Claude.** The Prosecutor is frozen into the job. Eric restarts with the other model himself, as a new job with a reason; the old one is kept.

**What Eric sees**

- The pilot queue gets a `ticket_failed` step with the reason in words.
- Review lists the project under Waiting on a model.
- The Daily Brief counts saved tickets only and names the failed jobs.

**Why one failure doesn't stall the morning review**

- Tickets are separate file sets per project.
- Review and the Daily Brief read saved records only.
- The one shared resource is the server runner's two slots. A hung call holds one until `research.timeout_seconds` runs out (600 s by default, `research.js`).

## Eric's decisions

1. **The scout rule.** Reverse "a scout item never becomes research" so that eligible scout candidates may become intake requests, with Eric's confirm still required.
2. **ChatGPT's route as Prosecutor.** Either the paid API, unattended, with his OpenAI key in Render; or the ChatGPT app, which he opens himself; or the challenge-only alternative.
3. **The floors.** The values for the eligibility floors: market cap, 24-hour volume, and the sell-tax limit if it differs from the screening preference.

## Build order, once decided

One task per branch, tested with `node dashboard/cli.js test`, as a pull request Eric merges. Plan first: each touches more than three files.

1. **The candidates route:** schema and checks, `core/candidates.js` eligibility, the one `screening.js` export, and the intake handoff into Review > Imports.
2. **Ticket v2:** `cr-ticket-prompt@2`, `cr.ticket.v2`, receipt v2, the frozen `tickets.prosecutor` choice, the connector's role check, and the `ticket_failed` queue state.
3. **ChatGPT's route:** whichever Eric picks in decision 2.
