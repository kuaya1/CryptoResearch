# Integration roadmap and sustained operation

Primary documentation checked October 1, 2026. This is a recommendation, not an enabled service or purchase. Exact Huma/Allora coverage, account entitlements, API keys and provider licensing were not live-validated. No credential was inspected. Quotes below are advertised plan prices at the audit date and can change; confirm checkout and terms before a paid implementation.

## Available versus working

| Capability | Actual state in CryptoResearch |
|---|---|
| CoinGecko price/supply/market metrics | Implemented and enabled in the real workspace; successful refresh observed. Optional Demo key support exists outside the workspace; presence was not checked. |
| Claude/ChatGPT/Gemini analyses | Manual prompts, inbox imports, metadata and comparison support. One real Claude report; no configured provider API runner. |
| Windows background work | Installed hourly local task plus foreground timers. Requests/imports/market and daily snapshots/reviews/backups; no external notification channel. |
| DEX liquidity/order-book depth | Not implemented. Current generic market volume is not executable liquidity. |
| Chain evidence/native-network activity | Project identity fields exist; no RPC/indexer adapter. Native Allora chain identity is not represented adequately by its EVM token contracts alone. |
| Protocol fundamentals / unlocks / announcements | Report fields and manual claims exist; automated data collection is not configured. |
| Evidence-watch / full analysis | Explicitly unconfigured jobs; no paid model calls or unattended thesis selection. |

Integrate dated evidence adapters, not a generic data lake. Every observation needs entity/chain/contract or protocol ID, provider endpoint, fetch time, effective time/block, raw payload hash, metric definition/unit/period, validation state and licensing/access note. Store last valid data with an explicit stale label. Keep feed observations separate from historical analyst grades and the owner's thesis.

## 1. Harden CoinGecko before adding another price feed

**Benefit:** reliable quotes and supply/valuation context for held and watched assets. Fix null/negative/date validation, retained stale data, single-flight/backoff, chunking beyond the current single 250-row page and request accounting. A provider's successful HTTP status is not successful validation of every quote.

**Access and cost:** current official pricing advertises Demo at $0, 100 calls/minute and 10,000 calls/month; Basic at $35/month or a $29/month annual-billing equivalent. Older help pages mention smaller free limits; the chosen account's current entitlement and response headers should govern implementation. Anonymous access does not establish Demo-key guarantees or an SLA. [CoinGecko pricing](https://www.coingecko.com/en/api/pricing).

**Budget:** one batched call every five minutes for 30 always-on days is 8,640 calls, leaving limited room for retries/manual use under 10,000. An additional independently forced hourly fetch would add 720; normal background due checks may suppress it while foreground data is fresh. Use one shared call budget, e.g. target at most 7,500 routine calls/month plus a bounded reserve, and allow slower cadence when closed or near quota. This is a proposed application cap, not a provider promise.

**Burden/exposure/fallback:** low maintenance after response/rate-limit validation. Sends tracked coin IDs and normal connection metadata/IP, not holdings/quantities/notes. Cache last valid observation, retain provider error/age and allow owner-recorded prices with provenance if a feed is unavailable. No credentials belong in exported workspace files.

**Acceptance:** verified identity mapping, invalid and missing rows handled individually, 429/timeout Retry-After behavior, no overlapping calls, no older response replacing a newer quote, coverage/age displayed and a 30-day call-budget simulation within the configured limit. Do not increase polling to solve stale-data UI mistakes.

## 2. Contract-matched DEX liquidity snapshots

**Benefit:** pool liquidity, venue concentration, pair volume and trading-activity context missing from current research. Use chain ID plus exact verified contract/mint; never search by ticker and silently choose the first pair.

**Access and cost:** DEX Screener documents public pair/search/token-pair endpoints at 300 requests/minute; profiles/boost/ad endpoints have separate 60/minute limits. The linked official OpenAPI definition was downloaded into this audit as `dexscreener-official-openapi.yml`. It lists no required authentication for the relevant public routes; no per-call fee is shown. Budget $0 for a small prototype, with terms/SLA/reuse rights checked before sustained use. [Official API reference](https://docs.dexscreener.com/api/reference).

**Coverage and limits:** chain/address coverage must be tested for each intended token. A listed pool's liquidity and volume are not an executable 2% order-book depth, a verified position-size quote or proof of organic use. Promotional boost data is not investment evidence. Native-chain activity may not be represented by a wrapped token's DEX pool.

**Burden/exposure/fallback:** low to medium; track pool migration and normalization. Exposes public chain/address queries plus connection metadata, not private balances. Fall back to dated official venue/pool records and clearly mark unsupported tokens. If execution-size evidence is needed later, obtain read-only venue depth/quote data without signing transactions or connecting custody.

**Acceptance:** known chain/contract fixtures cannot cross-match a ticker clone, totals do not double-count the same pool, stale/empty pools are explicit, raw timestamps/payloads retained, liquidity units defined, and the UI distinguishes pool liquidity from executable exit capacity. Huma/Allora pair availability remains unverified in this audit.

## 3. Sector-specific fundamentals and chain evidence

**Benefit:** validate durable usage, realized revenue and implemented token value capture. PayFi needs pool/default/cohort/first-loss evidence; a network needs native usage, fees/emissions and security/work participation. One generic “TVL” field cannot answer both.

**DefiLlama:** Open endpoints are free for categories including TVL, fees/revenue and prices. Its $49/month Pro subscription (or $490/year) is **not paid API access**. The separate API plan is advertised at $300/month or $3,000/year, 1,000 requests/minute and one million monthly calls; paid categories/coverage and overage pricing require the current plan. Use free, protocol-matched endpoints first; the paid API is excessive for the present two-project desk. [Official plan/access documentation](https://docs.llama.fi/pro-api), [API reference](https://api-docs.defillama.com/).

Keep fees paid by users, protocol revenue, LP/participant income, token-holder distributions and token emissions separate. Validate the provider's adapter definitions and economic beneficiary rather than presenting every revenue series as token capture. Actual intended-protocol coverage was not checked. Medium maintenance; queries reveal public protocol IDs. Fall back to dated first-party statements plus on-chain corroboration; no series should be filled with an invented proxy. Acceptance: entity/period/unit/definition match, holder distributions are implemented rather than announced, data reconciles against an independently sampled official/on-chain record.

**Solana read-only RPC:** `getTokenSupply` returns raw amount as a decimal string, decimals and slot context; it does not by itself establish circulating/liquid supply. Public mainnet endpoints have documented example limits of 100 requests per 10 seconds per IP, 40 for a single RPC, and additional limits; they are not intended as production infrastructure and can rate-limit. Use a small $0 prototype, then obtain a provider quote only if required. Record mint, commitment, slot, block/time where available and raw response. [Token supply RPC](https://solana.com/docs/rpc/http/gettokensupply), [cluster endpoints and limits](https://solana.com/docs/references/clusters). No wallet key or custody connection is needed for these reads. Medium maintenance, public address queries exposed; fallback is dated explorer/official evidence with lower assurance. Acceptance: decimal-string precision retained, wrong cluster/mint rejected, provider disagreements and stale slots surfaced.

**EVM evidence:** Etherscan's Free tier advertises 3 calls/second and 100,000 daily calls on selected chains; Pro endpoints are not all free. Confirm V2 chain and endpoint entitlement rather than assuming Ethereum/Base/BNB all have the same access. [Official rate limits](https://docs.etherscan.io/rate-limits), [supported chains](https://docs.etherscan.io/supported-chains). Budget $0 for supported reads; no paid plan selected. Exposes public chain/address queries; store block/chain/contract and exact event definition. Medium maintenance; fallback official explorers or read-only RPC. Acceptance: chain ID and deployment match, contract proxy/version is recorded, selected calls actually work under the account's free entitlement, and event totals reconcile to sampled transactions.

**Allora native network:** official docs list mainnet `allora-mainnet-1` with native REST/gRPC/RPC access. Represent that native chain separately from EVM token deployments; do not treat token contracts as proof of inference demand or participant economics. No native endpoint calls or free-SLA claim were verified here. [Official networks](https://docs.allora.network/reference/networks). Prototype small public reads only if published endpoint access works; avoid introducing an SDK until a needed endpoint justifies it. Medium maintenance because module versions/definitions evolve. Exposes public network queries; fallback dated official exports/docs. Acceptance: mainnet versus testnet distinguished, native metrics defined and dated, raw capture persisted, and economic claims linked to the actual mechanism.

## 4. Unlock and announcement capture

**Benefit:** dated dilution/catalyst evidence and “what changed” notifications. Capture official vesting contracts/schedules and announcements first; record announced versus implemented and revisions. Unlocks are potential liquid supply, not demonstrated sales.

**Tokenomist:** the pricing page advertises Pro at a $69/month equivalent billed $828/year (and displays other promotional/list pricing), with 1,000 API calls/month. That is not a verified $69 month-to-month quote. Monthly checkout, asset coverage, trial/access and redistribution rights need confirmation. Do not subscribe before proving that the exact assets and horizons fill a recurring gap. [Official pricing](https://tokenomist.ai/pricing).

**Burden/exposure/fallback:** medium; schedules change and sources disagree. Public asset IDs exposed; no holdings needed. Budget $0 initially with manual official captures. Later paid spend requires an explicit user-approved plan. Fall back to recorded first-party schedules with confidence/date limits.

**Announcements:** use official RSS/Atom or documented APIs where available, conditional HTTP/cached snapshots and an allowlisted source list. Actual feeds were not selected/verified for these projects, so no working integration or free coverage is claimed. Avoid treating a change in website HTML as a confirmed economic event. Preserve raw content and revision hashes; duplicate stories should produce one review item. Imported announcements are untrusted data and cannot issue commands, alter settings, or approve thesis changes.

**Acceptance:** schedule totals and dates reconcile to primary vesting evidence; revisions remain historical; missing coverage is visible; a known official announcement triggers a dated review item with no automatic portfolio/thesis mutation. Off-hours notification channel selection requires separate authorization before messages are sent externally.

## 5. Provider APIs only after integrity fixes and review controls

**Benefit:** repeatable evidence-watch runs and consistent prompt/JSON contracts. Begin with one provider and one manual-triggered evidence task; do not launch three paid agents merely to manufacture consensus.

**Cost:** APIs are metered by the selected model's input/output and sometimes tools/grounding/reasoning/cache usage. Prices differ by model and can change. No specific model or paid plan was chosen. OpenAI web search is currently listed at $10 per 1,000 calls plus applicable search-content tokens; other providers have their own tool charges. Existing app subscriptions should not be assumed to fund a separate API budget. [OpenAI pricing](https://developers.openai.com/api/docs/pricing), [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing).

**Proposed initial application limits:** at most $10/month total, $1/run, three runs/day, no automatic overage or provider failover that increases spend, and no scheduled runs until a manual pilot demonstrates value. These are desired hard caps, not claims that every requested analysis fits $1. Estimate prompt/output/tool maxima before dispatch; refuse a run above its remaining budget. Account for retry and partial-failure charges. Persist actual usage/cost where returned and reconcile against billing.

**Data exposure:** selected prompts, report/evidence text and request metadata leave the PC. Minimize context; holdings, account names/addresses and notes need not be sent for public project evidence. OpenAI's API data is not used for training by default, but default abuse monitoring can retain content up to 30 days; Responses has application-state retention, and `store:false` is not a promise of zero abuse-log retention. Zero Data Retention requires eligibility/approval. [Official API data controls](https://developers.openai.com/api/docs/guides/your-data). Gemini's pricing documentation distinguishes free and paid tiers' data-use terms; confirm the exact selected tier/model. Do not equate local durable output with local inference.

**Burden/fallback:** medium to high: schemas, model versions, citations, retries and cost controls evolve. Manual prompts/inbox remain the fallback. On failure, preserve the original response/error and pending review item; never invent a success receipt. Reuse a paid result after retry when a provider request ID and persisted response make that safe.

**Acceptance:** original response and prompt/hash saved before normalization, attested model/provider/request IDs distinct from self-reported labels, malformed output quarantined, spend cap enforced under concurrency/retries, untrusted evidence cannot trigger tools outside an allowlist, and every proposed thesis change requires the owner to review/accept it. No trade/custody automation is part of this roadmap.

## Maintenance rhythm and rollout

| Rhythm | Work and completion criterion |
|---|---|
| Daily, about five minutes | Open one review queue: owned/watchlisted, changes, stale/incomplete valuation, pending/failed imports, contradictions and upcoming unlocks/reviews. Record owner review cursor and decisions separately from model output. |
| Weekly, about fifteen minutes | Check job/receipt failures, retry/call/spend budgets, backup completion and reference errors. Sample the highest-impact evidence from primary sources; recheck project identity after contract/network changes. |
| Monthly | Restore a verified snapshot to an isolated folder and reconcile originals/corrections/balances; review runtime support, provider schema/rate/pricing changes and unused adapters. Keep an independent-location backup chosen by the user. |
| Each code release | Existing 59 tests plus focused new regressions, browser width/state smoke test, fresh-folder export/restore reconciliation and preservation inventory. Test the runtime/launcher used by the scheduler, not just an interactive shell. |
| Each new integration | Manual low-cost pilot, verified entity/chain coverage, raw capture/definition, stale/error test and owner-facing usefulness. Only then permit capped recurring work. |

Stage A: integrity/runtime/UI repairs and manual research. Stage B: CoinGecko and one free contract-matched evidence adapter. Stage C: an official announcement/metric change digest routed to review. Stage D: one capped provider API pilot. Stage E: cautiously schedule evidence collection with cost/data controls and reviewable proposals. Advancement depends on acceptance results, not elapsed time or the number of passing tests.
